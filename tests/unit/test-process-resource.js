const test = require('node:test');
const assert = require('node:assert');
const { processResource } = require('../../src/pipeline/process-resource');

test('processResource: classifies GitHub repositories and direct PDFs', async () => {
  const ghResult = await processResource('https://github.com/torvalds/linux?utm_source=instagram');
  assert.strictEqual(ghResult.success, true);
  assert.strictEqual(ghResult.resourceType, 'github_repository');
  assert.strictEqual(ghResult.finalUrl, 'https://github.com/torvalds/linux');
  assert.ok(ghResult.summary.includes('Official GitHub Repository: torvalds/linux'));

  const pdfResult = await processResource('https://raw.githubusercontent.com/owner/repo/main/cheatsheet.pdf');
  assert.strictEqual(pdfResult.success, true);
  assert.strictEqual(pdfResult.resourceType, 'pdf_document');
  assert.ok(pdfResult.summary.includes('Direct PDF Document'));
});

test('processResource: blocks private IP and localhost SSRF destinations', async () => {
  const ssrfResult = await processResource('http://127.0.0.1:8080/private');
  assert.strictEqual(ssrfResult.success, false);
  assert.strictEqual(ssrfResult.resourceType, 'blocked');
  assert.ok(ssrfResult.error.includes('Security policy blocked URL'));
});
