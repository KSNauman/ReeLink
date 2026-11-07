const test = require('node:test');
const assert = require('node:assert');
const { buildSearchQueries, filterNoise } = require('../../src/pipeline/build-search-query');

test('filterNoise: strips generic promotional tags and stop words', () => {
  const input = ['python', 'reels', 'viral', 'docker', 'fyp', 'agent', 'explore'];
  const filtered = filterNoise(input);
  assert.deepStrictEqual(filtered, ['python', 'docker', 'agent']);
});

test('buildSearchQueries: prioritizes exact repos, packages, and CTA keywords', () => {
  const evidence = {
    metadata: {
      creator: 'code_wizard',
      ctaKeyword: 'AGENT',
      hashtags: ['python', 'langchain', 'viral', 'reels'],
    },
    ocr: {
      detectedRepos: ['langchain-ai/langchain'],
      detectedPackages: ['langgraph'],
    },
    transcription: {
      text: 'Today I built an autonomous workflow for developers.',
    },
  };

  const queries = buildSearchQueries(evidence);

  assert.ok(queries.length >= 3, 'Should generate multiple prioritized queries');

  // Priority 1: Exact GitHub repo
  assert.strictEqual(queries[0].type, 'exact_repo');
  assert.strictEqual(queries[0].priority, 1);
  assert.strictEqual(queries[0].query, 'site:github.com langchain-ai/langchain');

  // Priority 2: CLI package
  assert.strictEqual(queries[1].type, 'package_doc');
  assert.strictEqual(queries[1].priority, 2);
  assert.ok(queries[1].query.includes('langgraph'));

  // Priority 3: Creator + CTA Keyword
  assert.strictEqual(queries[2].type, 'cta_keyword');
  assert.strictEqual(queries[2].priority, 3);
  assert.ok(queries[2].query.includes('code_wizard'));
  assert.ok(queries[2].query.includes('agent'));
});
