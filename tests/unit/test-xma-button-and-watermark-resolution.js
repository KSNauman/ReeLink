const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDestinationUrl, isWatermarkUrl, extractExternalUrls } = require('../../src/utils/url-helper');

describe('XMA Button and Watermark Resolution', () => {
  test('resolveDestinationUrl decodes QuickDM redirect parameter', () => {
    const raw = 'https://quickdm.app/r?to=https%3A%2F%2Faibuildercup.com%2F';
    const resolved = resolveDestinationUrl(raw);
    assert.equal(resolved, 'https://aibuildercup.com/');
  });

  test('resolveDestinationUrl decodes Instagram link shim parameter', () => {
    const raw = 'https://l.instagram.com/?u=https%3A%2F%2Faibuildercup.com%2F&e=123';
    const resolved = resolveDestinationUrl(raw);
    assert.equal(resolved, 'https://aibuildercup.com/');
  });

  test('resolveDestinationUrl preserves direct URLs and strips tracking params', () => {
    const raw = 'https://aibuildercup.com/?utm_source=instagram&utm_medium=dm';
    const resolved = resolveDestinationUrl(raw);
    assert.equal(resolved, 'https://aibuildercup.com/');
  });

  test('isWatermarkUrl identifies generic automation watermarks', () => {
    assert.equal(isWatermarkUrl('https://quickdm.app'), true);
    assert.equal(isWatermarkUrl('https://quickdm.app/'), true);
    assert.equal(isWatermarkUrl('https://www.manychat.com'), true);
    assert.equal(isWatermarkUrl('https://aibuildercup.com/'), false);
    assert.equal(isWatermarkUrl('https://linkdm.co/rashmiracle_/CEEPsUKM3Q'), false);
  });

  test('extractExternalUrls does not mistake @quickdm.app without protocol', () => {
    const text = 'Hi 👋\nHere is the application link for AI Builer Cup hackathon 2026👇\n\n---\nSent via @quickdm.app (Free)';
    const urls = extractExternalUrls(text);
    // Since @quickdm.app has no http/https, URL_REGEX will not extract it as a valid URL
    assert.deepEqual(urls, []);
  });

  test('Priority resolution prefers resolved CTA button link over watermark text', () => {
    const replyText = 'Hi! Sent via https://quickdm.app (Free)';
    const inboxResult = {
      extractedUrl: 'https://aibuildercup.com/',
    };

    const candidateUrls = [];
    if (inboxResult && inboxResult.extractedUrl) {
      candidateUrls.push(inboxResult.extractedUrl);
    }
    if (replyText) {
      const urls = extractExternalUrls(replyText).map(resolveDestinationUrl);
      for (const u of urls) {
        if (!candidateUrls.includes(u)) candidateUrls.push(u);
      }
    }

    const nonWatermark = candidateUrls.filter(u => !isWatermarkUrl(u));
    const chosen = nonWatermark[0] || candidateUrls[0];
    assert.equal(chosen, 'https://aibuildercup.com/');
  });
});
