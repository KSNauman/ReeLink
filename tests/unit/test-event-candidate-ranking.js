const test = require('node:test');
const assert = require('node:assert');
const { scoreCandidate, rankCandidates } = require('../../src/pipeline/validate-candidates');

test('scoreCandidate: awards high confidence to official event RSVP registration endpoints', () => {
  const rsvpCandidate = {
    url: 'https://rsvp.withgoogle.com/events/alloydb-agents',
    title: 'AlloyDB AI Day India 2026 - Registration',
    domain: 'rsvp.withgoogle.com',
  };

  const evidence = {
    metadata: {
      creator: 'meghna_1500',
      caption: `Google’s AlloyDB Agents event in Bangalore! Comment GOOGLE for event link.`,
    },
  };

  const scored = scoreCandidate(rsvpCandidate, evidence);
  assert.ok(scored.score >= 0.85, `Expected score >= 0.85, got: ${scored.score}`);
  assert.ok(scored.reasoning.includes('High-value resource domain'));
  assert.ok(scored.reasoning.includes('Official event registration endpoint'));
  assert.ok(scored.reasoning.includes('Strong match for event name "alloydb agents"'));
  assert.ok(scored.reasoning.includes('Matches event organizer "google"'));
});

test('rankCandidates: official event registration outranks generic organization repository', () => {
  const candidates = [
    {
      url: 'https://github.com/google',
      title: 'Google Organization GitHub',
      domain: 'github.com',
    },
    {
      url: 'https://rsvp.withgoogle.com/events/alloydb-agents',
      title: 'AlloyDB Agents Bangalore Event RSVP',
      domain: 'rsvp.withgoogle.com',
    },
    {
      url: 'https://www.instagram.com/p/DejqsFyJhes/',
      title: 'Instagram Post',
      domain: 'instagram.com',
    },
  ];

  const evidence = {
    metadata: {
      creator: 'meghna_1500',
      caption: `Google’s AlloyDB Agents event is worth checking out! Visit the Google office in Bangalore. Comment GOOGLE for direct link.`,
    },
  };

  const { selected, ranked, highConfidence } = rankCandidates(candidates, evidence);

  assert.strictEqual(ranked.length, 3);
  // Top ranked must be the official RSVP URL
  assert.strictEqual(ranked[0].url, 'https://rsvp.withgoogle.com/events/alloydb-agents');
  assert.ok(ranked[0].score >= 0.85);

  // Generic github.com/google should rank below the event URL
  assert.strictEqual(ranked[1].url, 'https://github.com/google');
  assert.ok(ranked[1].score < 0.60, `Expected generic github score < 0.60, got: ${ranked[1].score}`);

  // Social link should be penalized to 0.0
  assert.strictEqual(ranked[2].score, 0.0);

  // The official RSVP should be selected with high confidence
  assert.strictEqual(selected.url, 'https://rsvp.withgoogle.com/events/alloydb-agents');
  assert.strictEqual(highConfidence, true);
});
