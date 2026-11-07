/**
 * Integration Test for Instagram Inbox & Message Detection
 * Uses Playwright with routed mock HTTP responses simulating Instagram Web.
 * Verifies DOM selectors, Reel shortcode extraction, and message sending completely offline.
 */
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const InstagramInbox = require('../../src/instagram/inbox');
const InstagramSender = require('../../src/instagram/sender');

// Synthetic HTML simulating Instagram Web Direct Inbox & Thread DOM
const SYNTHETIC_INSTAGRAM_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Instagram Direct Messages (Mock)</title>
  <style>
    body { font-family: sans-serif; display: flex; }
    #sidebar { width: 300px; border-right: 1px solid #ccc; padding: 10px; }
    #chat { flex: 1; padding: 20px; }
    .thread-item { display: block; padding: 10px; margin-bottom: 5px; background: #f0f0f0; text-decoration: none; color: black; }
    .message-row { margin: 10px 0; padding: 8px; border-radius: 8px; background: #e8f0fe; }
    div[contenteditable="true"] { border: 1px solid #aaa; padding: 10px; min-height: 40px; margin-top: 20px; }
  </style>
</head>
<body>
  <div id="sidebar">
    <a href="/direct/t/17841400000000001/" class="thread-item">
      <div>ksydn_</div>
      <div>Shared a reel · 2m</div>
    </a>
    <a href="/direct/t/17841400000000002/" class="thread-item">
      <div>bob_coder</div>
      <div>Hey there!</div>
    </a>
  </div>

  <div id="chat">
    <header>
      <a href="/ksydn_/" aria-label="Open the profile page of ksydn_">ksydn_</a>
    </header>
    <h2>Conversation with ksydn_</h2>
    <div role="row" class="message-row">
      <div aria-label="React to message from ksydn_">Like</div>
      <span>Hey, check out this awesome python tutorial:</span>
      <a href="https://www.instagram.com/reel/C8AbCdEfGhI/?igsh=YWJjZGVm">Watch Reel</a>
    </div>
    <div role="row" class="message-row">
      <div aria-label="React to message from ksydn_">Like</div>
      <span>Also here is another one: https://instagram.com/p/D123XyZ_abc/</span>
    </div>

    <!-- Message Input -->
    <div contenteditable="true" role="textbox" aria-label="Message..." id="message-input"></div>
  </div>
</body>
</html>
`;

test('InstagramInbox & Sender: extracts threads, parses reels, and sends reply offline', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Intercept all instagram.com requests and serve our synthetic fixture
    await page.route('**/direct/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: SYNTHETIC_INSTAGRAM_HTML,
      });
    });

    const mockSession = {
      getPage: async () => page,
    };

    const inbox = new InstagramInbox(mockSession);
    await inbox.init();

    // 1. Test thread extraction from /direct/inbox/
    const threads = await inbox.getInboxThreads();
    assert.strictEqual(threads.length, 2, 'Should detect 2 direct message threads');
    assert.strictEqual(threads[0].threadId, '17841400000000001');
    assert.strictEqual(threads[0].username, 'ksydn_');

    // 2. Test Reel extraction from approved thread /direct/t/17841400000000001/
    const reels = await inbox.checkThreadForReels('17841400000000001');
    assert.strictEqual(reels.length, 2, 'Should detect 2 shared Reels in thread');
    const shortcodes = reels.map(r => r.shortcode);
    assert.ok(shortcodes.includes('C8AbCdEfGhI'), 'Should include C8AbCdEfGhI');
    assert.ok(shortcodes.includes('D123XyZ_abc'), 'Should include D123XyZ_abc');
    assert.strictEqual(reels[0].senderUsername, 'ksydn_');
    assert.strictEqual(reels[1].senderUsername, 'ksydn_');

    // 3. Test Message Sender targeting the input in the thread
    const sender = new InstagramSender(mockSession, { dryRun: false });
    await sender.init();

    const sent = await sender.sendMessage('17841400000000001', 'Reel received. Looking for resource...');
    assert.strictEqual(sent, true, 'Sender should successfully type and dispatch message');

    // Verify the message was typed into the input element
    const inputValue = await page.innerText('#message-input');
    assert.ok(inputValue.includes('Reel received'), 'Input field should contain sent message text');
  } finally {
    await browser.close();
  }
});
