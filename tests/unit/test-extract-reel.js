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

test('parseOgDescription reads the current "caption - @handle on date" format', () => {
  const { parseOgDescription } = require('../../src/pipeline/extract-reel');
  const r = parseOgDescription('Want it? follow + comment “link” and i’ll send it!\n\n#tag - @some.creator_1 on November 7, 2026');
  assert.strictEqual(r.creator, 'some.creator_1');
  assert.ok(r.caption.endsWith('#tag'));
  assert.ok(!r.caption.includes('@some.creator_1'));
});

test('parseOgDescription reads the older "likes - handle on date: quoted" format', () => {
  const { parseOgDescription } = require('../../src/pipeline/extract-reel');
  const r = parseOgDescription('348 likes, 1,725 comments - creator_handle on March 3, 2025: "Comment ROADMAP below"');
  assert.strictEqual(r.creator, 'creator_handle');
  assert.strictEqual(r.caption, 'Comment ROADMAP below');
});

test('parseOgDescription never invents a creator', () => {
  const { parseOgDescription } = require('../../src/pipeline/extract-reel');
  assert.deepStrictEqual(parseOgDescription('just a caption'), { creator: '', caption: 'just a caption' });
  assert.deepStrictEqual(parseOgDescription(''), { creator: '', caption: '' });
});

test('A quoted keyword is used even when the word is otherwise too generic', () => {
  const { extractCreatorRequirements } = require('../../src/pipeline/creator-interaction');
  const quoted = extractCreatorRequirements('follow + comment “link” and i will send it', '', { defaultToEmoji: true });
  assert.strictEqual(quoted.keyword, 'link');
  assert.strictEqual(extractCreatorRequirements('Comment "guide" below', '', { defaultToEmoji: true }).keyword, 'guide');
  // Unquoted generic words still aren't treated as the keyword
  assert.strictEqual(extractCreatorRequirements('Comment below for more', '', { defaultToEmoji: true }).keyword, '🙌');
});
