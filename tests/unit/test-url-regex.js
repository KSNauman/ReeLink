const test = require('node:test');
const assert = require('node:assert');
const {
  extractReelShortcode,
  normalizeReelUrl,
  extractExternalUrls,
  cleanTrackingParams,
} = require('../../src/utils/url-helper');

test('extractReelShortcode: handles standard and query-param URLs', () => {
  const cases = [
    { input: 'https://www.instagram.com/reel/C9xY8z1vB/', expected: 'C9xY8z1vB' },
    { input: 'https://instagram.com/reel/C9xY8z1vB?igsh=MXRk...', expected: 'C9xY8z1vB' },
    { input: 'https://www.instagram.com/p/DB-4abc123_/?utm_source=ig_web', expected: 'DB-4abc123_' },
    { input: 'https://instagram.com/reels/C_xyz123/', expected: 'C_xyz123' },
    { input: 'Check this out: https://www.instagram.com/reel/DEMO1234/ it is awesome', expected: 'DEMO1234' },
    { input: 'https://example.com/not-instagram', expected: null },
    { input: '', expected: null },
    { input: null, expected: null },
  ];

  for (const { input, expected } of cases) {
    const result = extractReelShortcode(input);
    assert.strictEqual(result, expected, `Failed for input: ${input}`);
  }
});

test('normalizeReelUrl: returns canonical Reel URL', () => {
  assert.strictEqual(
    normalizeReelUrl('https://instagram.com/p/C9xY8z1vB/?igsh=123'),
    'https://www.instagram.com/reel/C9xY8z1vB/'
  );
  assert.strictEqual(
    normalizeReelUrl('C9xY8z1vB'),
    'https://www.instagram.com/reel/C9xY8z1vB/'
  );
  assert.strictEqual(normalizeReelUrl('invalid!url!@#'), null);
});

test('extractExternalUrls: extracts and de-duplicates URLs from prose', () => {
  const text = `
    Here is the project link: https://github.com/torvalds/linux.
    Also read the doc at https://kernel.org/doc/index.html, or visit https://github.com/torvalds/linux!
  `;
  const urls = extractExternalUrls(text);
  assert.deepStrictEqual(urls, [
    'https://github.com/torvalds/linux',
    'https://kernel.org/doc/index.html',
  ]);
});

test('cleanTrackingParams: strips utm, igsh, and fbclid params', () => {
  const dirty = 'https://github.com/foo/bar?utm_source=instagram&igsh=abc123xyz&ref=share';
  const clean = cleanTrackingParams(dirty);
  assert.strictEqual(clean, 'https://github.com/foo/bar');
});
