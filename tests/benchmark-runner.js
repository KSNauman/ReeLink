/**
 * ReelLink Ground-Truth Benchmark Evaluation Runner
 * 
 * Accurately audits discovery pipeline performance against real-world ground-truth test cases.
 * 
 * Supported Modes:
 *   --mode search (Default) : Search-only evaluation using pre-extracted ground-truth clues.
 *   --mode full             : Full-pipeline evaluation starting from the live Instagram Reel URL.
 * 
 * Usage:
 *   npm.cmd run test:benchmark
 *   node tests/benchmark-runner.js --mode full
 *   node tests/benchmark-runner.js --mode search --id reel_google_alloydb_agents
 */
const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { fetchReelPublicData, parseReelMetadata } = require('../src/pipeline/extract-reel');
const { buildSearchQueries } = require('../src/pipeline/build-search-query');
const SearchAdapter = require('../src/pipeline/search-web');
const { rankCandidates } = require('../src/pipeline/validate-candidates');
const { processResource } = require('../src/pipeline/process-resource');
const { cleanTrackingParams } = require('../src/utils/url-helper');
const BrowserSession = require('../src/instagram/session');

const BENCHMARK_FILE = path.resolve(__dirname, 'fixtures/benchmark-reels.json');

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const cleaned = cleanTrackingParams(url);
    const u = new URL(cleaned);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.replace(/\/+$/, '').toLowerCase();
  }
}

async function runBenchmarks() {
  if (!fs.existsSync(BENCHMARK_FILE)) {
    console.error(`Benchmark dataset not found at: ${BENCHMARK_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(BENCHMARK_FILE, 'utf8');
  const benchmarks = JSON.parse(raw);

  const args = process.argv.slice(2);
  const targetId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
  const isFullMode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] === 'full' : args.includes('--live');
  const evalMode = isFullMode ? 'FULL-PIPELINE (Live Reel URL)' : 'SEARCH-ONLY (Pre-Extracted Clues)';

  const casesToRun = targetId ? benchmarks.filter(b => b.id === targetId) : benchmarks;

  console.log('\n======================================================');
  console.log('       ReelLink: Benchmark Integrity Evaluation       ');
  console.log('======================================================\n');
  console.log(`Evaluation Mode:   ${evalMode}`);
  console.log(`Total Cases:       ${benchmarks.length}`);
  console.log(`Evaluating Cases:  ${casesToRun.length}\n`);

  const searchAdapter = new SearchAdapter();
  let session = null;
  const results = [];

  for (const b of casesToRun) {
    console.log(`------------------------------------------------------`);
    console.log(`Benchmark ID:        ${b.id}`);
    console.log(`Reel URL:            ${b.reelUrl}`);
    console.log(`Expected Target URL: ${b.expectedTargetUrl}`);
    console.log(`Verification Status: ${b.verificationStatus || 'provisional'}`);
    console.log(`Notes:               ${b.verificationNotes || '(none)'}`);
    console.log(`------------------------------------------------------`);

    let metadata;
    let extractionSource;

    try {
      if (isFullMode) {
        extractionSource = 'Live Playwright Browser Page';
        if (!session) session = new BrowserSession({ headless: true });
        console.log('• [Stage A] Inspecting live Reel via Playwright...');
        metadata = await fetchReelPublicData(b.reelUrl, session);
      } else {
        extractionSource = 'Pre-Extracted Ground-Truth Clues';
        console.log('• [Stage A] Using pre-extracted ground truth clues from fixture...');
        const clues = b.groundTruthClues || {};
        metadata = parseReelMetadata({
          shortcode: b.shortcode,
          creator: clues.creator || b.creator,
          caption: clues.caption || b.topic,
        });
      }

      console.log(`• Extraction Source: ${extractionSource}`);
      console.log(`• Creator:           @${metadata.creator || '(unknown)'}`);
      console.log(`• CTA Keyword:       ${metadata.ctaKeyword || '(none)'}`);
      console.log(`• Technical Tags:    ${metadata.hashtags?.length > 0 ? metadata.hashtags.join(', ') : '(none)'}`);
      console.log(`• Caption Preview:   ${metadata.caption ? metadata.caption.slice(0, 80).replace(/\n/g, ' ') + '...' : '(none)'}`);

      // Step B1: Query Generation
      const queries = buildSearchQueries({ metadata });
      console.log(`\n• [Stage B1] Formulated ${queries.length} search queries:`);
      queries.forEach((q, idx) => console.log(`   [${idx + 1}] "${q.query}" (${q.reason})`));

      // Step B2: Web Search
      const allCandidates = [];
      let anyThrottled = false;
      let throttleReason = null;
      for (const q of queries.slice(0, 3)) {
        console.log(`• [Stage B2] Executing search: "${q.query}"...`);
        const searchResults = await searchAdapter.search(q.query);
        if (searchResults.isThrottled) {
          anyThrottled = true;
          throttleReason = searchResults.error || 'RATE_LIMITED_CHALLENGE';
          console.log(`  ⚠️ Search Provider Throttled / Challenged (${throttleReason})`);
        }
        console.log(`  Returned ${searchResults.length} candidate URLs`);
        allCandidates.push(...searchResults);
        await new Promise(r => setTimeout(r, 600)); // Respect search engine delay
      }

      console.log(`• Total Search Candidates: ${allCandidates.length}`);

      // Step B3: Candidate Ranking
      const { selected, ranked } = rankCandidates(allCandidates, { metadata });

      // Step 5: Resource Processing & SSRF Defense (if top candidate exists)
      let resourceProcessingResult = null;
      if (selected || ranked[0]) {
        const topUrl = selected ? selected.url : ranked[0].url;
        console.log(`• [Stage 5] Validating top candidate resource: ${topUrl}`);
        resourceProcessingResult = await processResource(topUrl);
        console.log(`  Validation Result: ${resourceProcessingResult.success ? 'PASSED' : 'FAILED'}`);
      }

      // Accurate Match Evaluation
      const normExpected = normalizeUrl(b.expectedTargetUrl);
      let matchStatus = allCandidates.length === 0
        ? (anyThrottled ? 'PROVIDER_THROTTLED' : 'NO_CANDIDATES')
        : 'MISSED';
      let matchedRank = -1;
      let matchedCandidateUrl = null;

      ranked.forEach((c, index) => {
        const normCandidate = normalizeUrl(c.url);
        let domain = '';
        try { domain = new URL(c.url).hostname.toLowerCase(); } catch {}

        const isExact = normCandidate === normExpected;
        const isDomainMatch = b.expectedDomains?.some(d => domain.includes(d.toLowerCase()));

        if (isExact && matchStatus !== 'EXACT_MATCH') {
          matchStatus = 'EXACT_MATCH';
          matchedRank = index + 1;
          matchedCandidateUrl = c.url;
        } else if (isDomainMatch && matchStatus === 'MISSED') {
          matchStatus = 'DOMAIN_MATCH';
          matchedRank = index + 1;
          matchedCandidateUrl = c.url;
        }
      });

      const topCandidateUrl = selected ? selected.url : (ranked[0]?.url || (anyThrottled ? '(provider throttled)' : '(none)'));
      const topCandidateScore = selected ? selected.score : (ranked[0]?.score || 0);

      results.push({
        id: b.id,
        mode: isFullMode ? 'full' : 'search',
        status: b.verificationStatus || 'provisional',
        expectedUrl: b.expectedTargetUrl,
        topCandidate: topCandidateUrl,
        topScore: topCandidateScore.toFixed(2),
        matchStatus,
        matchedRank: matchedRank > 0 ? `#${matchedRank}` : 'N/A',
        ssrfChecked: resourceProcessingResult ? (resourceProcessingResult.success ? 'SAFE' : 'BLOCKED') : 'N/A',
      });

      console.log(`\n• Match Evaluation:  [${matchStatus}] (Matched Rank: ${matchedRank > 0 ? `#${matchedRank}` : 'None'})`);
      console.log(`• Top Candidate:     ${topCandidateUrl} (Score: ${topCandidateScore.toFixed(2)})\n`);

    } catch (err) {
      console.error(`❌ Benchmark error on ${b.id}:`, err.message);
      results.push({
        id: b.id,
        mode: isFullMode ? 'full' : 'search',
        status: b.verificationStatus || 'error',
        expectedUrl: b.expectedTargetUrl,
        topCandidate: 'ERROR',
        topScore: '0.00',
        matchStatus: 'ERROR',
        matchedRank: 'N/A',
        ssrfChecked: 'N/A',
      });
    }
  }

  if (session) {
    try { await session.close(); } catch {}
  }

  // Print Summary Table
  console.log('========================================================================================================');
  console.log('                                    BENCHMARK INTEGRITY SCORECARD                                       ');
  console.log('========================================================================================================');
  console.table(results);
  console.log('========================================================================================================\n');

  const passed = results.filter(r => r.matchStatus === 'EXACT_MATCH').length;
  const domainMatches = results.filter(r => r.matchStatus === 'DOMAIN_MATCH').length;
  const throttled = results.filter(r => r.matchStatus === 'PROVIDER_THROTTLED').length;
  const genuineMisses = results.filter(r => r.matchStatus === 'MISSED' || r.matchStatus === 'NO_CANDIDATES').length;
  console.log(`Audit Summary:`);
  console.log(`• Exact Target Matches:  ${passed} / ${results.length}`);
  console.log(`• Domain-Level Matches:  ${domainMatches} / ${results.length}`);
  console.log(`• Provider Throttled:    ${throttled} / ${results.length} (Rate-limited, not counted as pipeline miss)`);
  console.log(`• Genuine Misses:        ${genuineMisses} / ${results.length}\n`);
}

runBenchmarks().catch(console.error);
