const test = require('node:test');
const assert = require('node:assert');
const { scoreCandidate, rankCandidates } = require('../../src/pipeline/validate-candidates');

test('scoreCandidate: awards domain affinity and exact repo matches', () => {
  const candidate = {
    url: 'https://github.com/torvalds/linux',
    title: 'Linux kernel source tree',
    domain: 'github.com',
  };

  const evidence = {
    metadata: { creator: 'linus' },
    ocr: { detectedRepos: ['torvalds/linux'] },
  };

  const result = scoreCandidate(candidate, evidence);
  assert.ok(result.score >= 0.70, `Expected score >= 0.70, got: ${result.score}`);
  assert.ok(result.reasoning.includes('High-value resource domain'));
  assert.ok(result.reasoning.includes('Exact match for on-screen repo'));
});

test('scoreCandidate: penalizes generic social media URLs', () => {
  const candidate = {
    url: 'https://www.instagram.com/explore/',
    title: 'Instagram Explore',
    domain: 'instagram.com',
  };

  const evidence = {
    metadata: { creator: 'alice' },
  };

  const result = scoreCandidate(candidate, evidence);
  assert.strictEqual(result.score, 0.0);
  assert.ok(result.reasoning.includes('Penalized generic social media domain'));
});

test('rankCandidates: ranks candidates descending and triggers high confidence', () => {
  const candidates = [
    { url: 'https://random-blog.com/post', title: 'Random Post', domain: 'random-blog.com' },
    { url: 'https://github.com/alice/docker-guide', title: 'Alice Docker Guide', domain: 'github.com' },
    { url: 'https://twitter.com/alice', title: 'Twitter Profile', domain: 'twitter.com' },
  ];

  const evidence = {
    metadata: { creator: 'alice', ctaKeyword: 'DOCKER' },
    ocr: { detectedRepos: ['alice/docker-guide'] },
  };

  const { selected, ranked, highConfidence } = rankCandidates(candidates, evidence);

  assert.ok(ranked.length === 3);
  assert.strictEqual(ranked[0].url, 'https://github.com/alice/docker-guide');
  assert.ok(ranked[0].score >= 0.80);
  assert.strictEqual(selected.url, 'https://github.com/alice/docker-guide');
  assert.strictEqual(highConfidence, true);
});
