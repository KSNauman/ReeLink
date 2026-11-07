/**
 * Controlled Live-Test & Supervised Audit Runner
 * Safely tests the end-to-end pipeline with real or test Reels.
 * 
 * Usage:
 *   node tests/live-test-supervised.js <reelUrl> [--send] [--mock]
 * 
 * Safety Guarantees:
 *   - By default runs in DRY-RUN mode (zero messages sent).
 *   - Only dispatches a DM if explicitly called with --send AND confirmed by terminal prompt.
 *   - Never comments on creator posts or follows creators.
 */
const readline = require('readline');
const config = require('../src/config');
const logger = require('../src/utils/logger');
const { parseReelMetadata, fetchReelPublicData } = require('../src/pipeline/extract-reel');
const { extractReelShortcode } = require('../src/utils/url-helper');
const { buildSearchQueries } = require('../src/pipeline/build-search-query');
const SearchAdapter = require('../src/pipeline/search-web');
const { rankCandidates } = require('../src/pipeline/validate-candidates');
const { processResource } = require('../src/pipeline/process-resource');
const BrowserSession = require('../src/instagram/session');
const InstagramSender = require('../src/instagram/sender');

async function runControlledTest() {
  const args = process.argv.slice(2);
  const isSendMode = args.includes('--send');
  const isMockMode = args.includes('--mock');
  const targetUrl = args.find(a => a.startsWith('http')) || 'https://www.instagram.com/reel/C8AbCdEfGhI/';
  const shortcode = extractReelShortcode(targetUrl) || 'test_shortcode';

  console.log('\n======================================================');
  console.log('       ReelLink: Controlled Live-Test Audit            ');
  console.log('======================================================\n');
  console.log(`Target Reel URL: ${targetUrl}`);
  console.log(`Shortcode:       ${shortcode}`);
  console.log(`Mode:            ${isSendMode ? '⚠️ SUPERVISED LIVE-SEND' : '⚡ SAFE DRY-RUN (Default)'}\n`);

  const searchAdapter = new SearchAdapter();
  const startTime = Date.now();
  let session = null;

  try {
    // 1. Stage A: Metadata & Caption Extraction
    console.log('--- [STAGE A: METADATA & CLUE EXTRACTION] ---');
    let metadata;

    if (isMockMode || shortcode === 'C8AbCdEfGhI') {
      console.log('• Mode: Using local mock fixture for C8AbCdEfGhI');
      metadata = parseReelMetadata({
        shortcode: 'C8AbCdEfGhI',
        creator: 'dev_educator',
        caption: 'Full code & Docker guide available: https://github.com/langchain-ai/langchain. Star the repo!',
      });
    } else {
      console.log('• Mode: Inspecting LIVE Instagram Reel via Playwright...');
      session = new BrowserSession({ headless: true });
      metadata = await fetchReelPublicData(targetUrl, session);
    }

    console.log(`• Creator:           @${metadata.creator || '(unknown)'}`);
    console.log(`• Caption Preview:   ${metadata.caption ? metadata.caption.slice(0, 100).replace(/\n/g, ' ') + '...' : '(none)'}`);
    console.log(`• CTA Keyword:       ${metadata.ctaKeyword || '(none)'}`);
    console.log(`• Technical Tags:    ${metadata.hashtags?.length > 0 ? metadata.hashtags.join(', ') : '(none)'}`);
    console.log(`• Has Direct Link:   ${metadata.hasDirectResource}`);
    console.log(`• Direct URLs Found: ${JSON.stringify(metadata.directResourceUrls)}`);
    console.log(`• Early Stopping:    ${metadata.hasDirectResource ? 'TRIGGERED (Saved 30s video processing)' : 'NOT TRIGGERED'}\n`);

    let candidateUrl = null;

    if (metadata.hasDirectResource && metadata.directResourceUrls.length > 0) {
      candidateUrl = metadata.directResourceUrls[0];
    } else {
      // 2. Stage B: Search & Candidate Ranking
      console.log('--- [STAGE B: WEB SEARCH & CANDIDATE RANKING] ---');
      const queries = buildSearchQueries({ metadata });
      console.log(`• Formulated ${queries.length} Search Queries:`);
      queries.forEach((q, idx) => console.log(`   [${idx + 1}] "${q.query}" (${q.reason})`));

      const allCandidates = [];
      for (const q of queries.slice(0, 3)) {
        console.log(`\n• Searching query: "${q.query}"...`);
        const results = await searchAdapter.search(q.query);
        console.log(`  Found ${results.length} candidate URLs`);
        allCandidates.push(...results);
      }

      console.log(`\n• Total Candidates Gathered: ${allCandidates.length}`);
      const { selected, ranked } = rankCandidates(allCandidates, { metadata });

      if (selected) {
        candidateUrl = selected.url;
        console.log(`• Top Ranked Candidate:    ${selected.url} (Score: ${selected.score.toFixed(2)})`);
        console.log(`• Scoring Reasoning:       ${selected.reasoning}\n`);
      }
    }

    if (!candidateUrl) {
      console.log('\n❌ Result: No suitable resource candidate discovered for this Reel.\n');
      return;
    }

    // 3. Stage 5: Resource Processing & SSRF Verification
    console.log('--- [STAGE 5: RESOURCE PROCESSING & SSRF DEFENSE] ---');
    const processed = await processResource(candidateUrl);

    if (!processed.success) {
      console.log(`❌ Security Blocked: ${processed.error}\n`);
      return;
    }

    console.log(`• Destination URL:   ${processed.finalUrl}`);
    console.log(`• Resource Type:     ${processed.resourceType}`);
    console.log(`• Summary:           ${processed.summary}`);
    console.log(`• Elapsed Time:      ${((Date.now() - startTime) / 1000).toFixed(2)}s\n`);

    // 4. Format Proposed Outgoing Instagram DM
    const proposedMessage = `🎯 Resource Found!\n\n📌 Title: ${processed.summary}\n🔗 Link: ${processed.finalUrl}\n\nConfidence: 90%`;

    console.log('======================================================');
    console.log('          PROPOSED OUTGOING INSTAGRAM DM              ');
    console.log('======================================================');
    console.log(proposedMessage);
    console.log('======================================================\n');

    if (!isSendMode) {
      console.log('✅ DRY-RUN COMPLETE: Message was NOT sent to Instagram.');
      console.log('To execute with supervised confirmation, re-run with:');
      console.log(`  node tests/live-test-supervised.js "${targetUrl}" --send\n`);
      return;
    }

    // 5. Supervised Send Confirmation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const confirmed = await new Promise(resolve => {
      rl.question('👉 Dispatch this message to Instagram? (type "yes" to confirm): ', answer => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'yes');
      });
    });

    if (!confirmed) {
      console.log('\n🚫 Send aborted by operator. Zero messages dispatched.\n');
      return;
    }

    console.log('\n🚀 Dispatching message via Playwright...');
    if (!session) {
      session = new BrowserSession({ headless: config.instagram.headless });
    }
    const sender = new InstagramSender(session);
    const sent = await sender.sendSuccess('test_thread', {
      url: processed.finalUrl,
      title: processed.summary,
      score: 0.90,
    });

    if (sent) {
      console.log('✅ Message successfully dispatched to Instagram!\n');
    } else {
      console.log('⚠️ Message could not be dispatched (Check thread ID or session).\n');
    }
  } catch (err) {
    logger.error('Supervised test encountered error', { error: err.message, stack: err.stack });
    console.error('\n❌ Test Error:', err.message);
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {}
    }
  }
}

runControlledTest().catch(console.error);
