const test = require('node:test');
const assert = require('node:assert');
const { extractCreatorRequirements } = require('../../src/pipeline/creator-interaction');

test('extractCreatorRequirements: detects follow + comment requirement with exact keyword', () => {
  const caption1 = `Want the full source code? 🚀
1. Follow @dev_educator for daily tutorials
2. Comment "AGENTS" below and I'll send the repo directly to your DMs!`;

  const req1 = extractCreatorRequirements(caption1);
  assert.strictEqual(req1.requiresFollow, true);
  assert.strictEqual(req1.requiresComment, true);
  assert.strictEqual(req1.interactionType, 'follow_and_comment');
  assert.strictEqual(req1.keyword, 'AGENTS');
  assert.strictEqual(req1.isUnclear, false);

  const caption2 = 'Must be following! Comment DOCKER for my cheatsheet.';
  const req2 = extractCreatorRequirements(caption2);
  assert.strictEqual(req2.requiresFollow, true);
  assert.strictEqual(req2.requiresComment, true);
  assert.strictEqual(req2.keyword, 'DOCKER');
});

test('extractCreatorRequirements: detects comment-only without triggering unnecessary follow', () => {
  const caption = `🚨 BANGALORE TECHIES, YOU COULD VISIT THE GOOGLE OFFICE! 🤯💙
Interested? Comment GOOGLE and I’ll send you the direct event link in your DMs!
#Google #GoogleCloud #AI`;

  const req = extractCreatorRequirements(caption);
  assert.strictEqual(req.requiresFollow, false, 'Should not require follow');
  assert.strictEqual(req.requiresComment, true);
  assert.strictEqual(req.interactionType, 'comment_only');
  assert.strictEqual(req.keyword, 'GOOGLE');
  assert.strictEqual(req.isUnclear, false);
});

test('extractCreatorRequirements: detects follow-only when comment is not requested', () => {
  const caption = 'Make sure you are following me to receive the starter template in your DMs tonight!';
  const req = extractCreatorRequirements(caption);
  assert.strictEqual(req.requiresFollow, true);
  assert.strictEqual(req.requiresComment, false);
  assert.strictEqual(req.interactionType, 'follow_only');
  assert.strictEqual(req.keyword, null);
  assert.strictEqual(req.isUnclear, false);
});

test('extractCreatorRequirements: flags unclear instructions when comment keyword is missing or ambiguous', () => {
  const caption1 = 'Want the secret guide? Drop a comment below and check your DMs!';
  const req1 = extractCreatorRequirements(caption1);
  assert.strictEqual(req1.isUnclear, true);
  assert.strictEqual(req1.interactionType, 'unclear');
  assert.ok(req1.reason.includes('missing or ambiguous'));

  const caption2 = 'Send me a DM to get the access token.';
  const req2 = extractCreatorRequirements(caption2);
  assert.strictEqual(req2.isUnclear, true);
  assert.strictEqual(req2.interactionType, 'unclear');
});

test('extractCreatorRequirements: returns none for standard captions without interaction CTA', () => {
  const caption = 'Here is how to set up Redis caching in Node.js. Save this video for later!';
  const req = extractCreatorRequirements(caption);
  assert.strictEqual(req.requiresFollow, false);
  assert.strictEqual(req.requiresComment, false);
  assert.strictEqual(req.interactionType, 'none');
  assert.strictEqual(req.keyword, null);
  assert.strictEqual(req.isUnclear, false);
});
