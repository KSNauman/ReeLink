const test = require('node:test');
const assert = require('node:assert');
const { parseReelMetadata } = require('../../src/pipeline/extract-reel');

test('parseReelMetadata: detects direct GitHub URL and triggers Early Stopping', () => {
  const metadata = parseReelMetadata({
    shortcode: 'C9xY8z1vB',
    creator: '@tech_guru',
    caption: 'Full code is available here: https://github.com/myorg/awesome-agent. Star the repo! #python #ai #reels',
  });

  assert.strictEqual(metadata.creator, 'tech_guru');
  assert.strictEqual(metadata.hasDirectResource, true, 'Should detect direct GitHub resource');
  assert.strictEqual(metadata.needsMediaInspection, false, 'Should trigger Early Stopping (no video OCR needed)');
  assert.strictEqual(metadata.directResourceUrls.length, 1);
  assert.strictEqual(metadata.directResourceUrls[0], 'https://github.com/myorg/awesome-agent');
  assert.deepStrictEqual(metadata.hashtags, ['python', 'ai', 'reels']);
});

test('parseReelMetadata: identifies CTA comment keyword when direct link is missing', () => {
  const metadata = parseReelMetadata({
    shortcode: 'D123XyZ_abc',
    creator: 'dev_sarah',
    caption: 'Want my ultimate Docker cheatsheet? Comment "DOCKER" and my bot will DM you the PDF! #docker #devops',
  });

  assert.strictEqual(metadata.hasDirectResource, false);
  assert.strictEqual(metadata.needsMediaInspection, true, 'Should proceed to video/OCR inspection');
  assert.strictEqual(metadata.ctaKeyword, 'DOCKER');
  assert.strictEqual(metadata.directResourceUrls.length, 0);
});
