const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const OCREngine = require('../../src/pipeline/run-ocr');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');
const TEST_FRAME_PATH = path.join(FIXTURE_DIR, 'test_ocr_frame.png');

test('OCREngine: extracts on-screen URLs, GitHub repos, and CLI packages from frame', async () => {
  if (!fs.existsSync(FIXTURE_DIR)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  // 1. Generate a high-contrast synthetic frame containing technical text using Playwright
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          background-color: #000;
          color: #fff;
          font-family: 'Courier New', monospace;
          font-size: 36px;
          font-weight: bold;
          padding: 60px;
        }
        .code { color: #00ff00; }
        .url { color: #00e5ff; }
      </style>
    </head>
    <body>
      <div>CHECK OUT THIS REPOSITORY:</div>
      <div class="code">github.com/torvalds/linux</div>
      <br>
      <div>INSTALL VIA CLI:</div>
      <div class="code">pip install langchain</div>
      <br>
      <div>DOWNLOAD FULL GUIDE:</div>
      <div class="url">https://example.com/guide.pdf</div>
    </body>
    </html>
  `);

  await page.screenshot({ path: TEST_FRAME_PATH });
  await browser.close();

  assert.ok(fs.existsSync(TEST_FRAME_PATH), 'Synthetic frame screenshot should exist');

  // 2. Process frame with OCREngine
  const ocr = new OCREngine();
  try {
    const summary = await ocr.processFrames([{ framePath: TEST_FRAME_PATH, timestampSec: 2.0 }]);

    assert.strictEqual(summary.frameCount, 1);
    assert.strictEqual(summary.framesWithText, 1);

    // Verify GitHub repo detected
    assert.ok(
      summary.detectedRepos.includes('torvalds/linux'),
      `Expected 'torvalds/linux' in repos, got: ${JSON.stringify(summary.detectedRepos)}`
    );

    // Verify CLI package detected
    assert.ok(
      summary.detectedPackages.includes('langchain'),
      `Expected 'langchain' in packages, got: ${JSON.stringify(summary.detectedPackages)}`
    );

    // Verify URL detected
    assert.ok(
      summary.detectedUrls.some(u => u.includes('example.com/guide.pdf')),
      `Expected 'https://example.com/guide.pdf' in URLs, got: ${JSON.stringify(summary.detectedUrls)}`
    );
  } finally {
    await ocr.terminate();
    if (fs.existsSync(TEST_FRAME_PATH)) {
      fs.unlinkSync(TEST_FRAME_PATH);
    }
  }
});
