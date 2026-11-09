/**
 * Runs the real unfollow code in a real browser against a stand-in profile page.
 * Nothing here reaches Instagram.
 */
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const InstagramInbox = require('../../src/instagram/inbox');

const profile = (button, { confirms = true, dialog = true } = {}) => `<!DOCTYPE html><html><body>
  <header><button id="b">${button}</button></header>
  <script>
    document.getElementById('b').onclick = () => {
      ${dialog ? `const d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.innerHTML = '<button id="u">Unfollow</button>';
      document.body.appendChild(d);
      document.getElementById('u').onclick = () => {
        d.remove();
        ${confirms ? "setTimeout(() => { document.getElementById('b').innerText = 'Follow'; }, 300);" : ''}
      };` : ''}
    };
  </script>
</body></html>`;

async function run(html) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://www.instagram.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const marked = [];
    const inbox = new InstagramInbox({ getPage: async () => page }, {
      isLiveMode: true,
      queue: { markCreatorUnfollowed: (c) => marked.push(c) },
    });
    const result = await inbox.unfollowCreatorDirect('someone', { isSimulation: false, timeoutMs: 1500 });
    return { result, marked };
  } finally {
    await browser.close();
  }
}

test('Unfollow: clicks through the dialog and records it once the profile shows Follow', async () => {
  const { result, marked } = await run(profile('Following'));
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(marked, ['someone']);
});

test('Unfollow: a pending follow request is withdrawn the same way', async () => {
  const { result, marked } = await run(profile('Requested'));
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(marked, ['someone']);
});

test('Unfollow: already not following is recorded without clicking anything', async () => {
  const { result, marked } = await run(profile('Follow'));
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.note, 'NOT_FOLLOWING');
  assert.deepStrictEqual(marked, ['someone']);
});

test('Unfollow: a deleted account stops being tracked', async () => {
  const { result, marked } = await run("<html><body>Sorry, this page isn't available.</body></html>");
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(marked, ['someone']);
});

test('Unfollow: a page with no follow button is a failure and stays tracked', async () => {
  const { result, marked } = await run('<html><body><header></header></body></html>');
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(marked, []);
});

test('Unfollow: a missing confirm dialog is a failure and stays tracked', async () => {
  const { result, marked } = await run(profile('Following', { dialog: false }));
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(marked, []);
});

test('Unfollow: if the profile never changes back to Follow it stays tracked', async () => {
  const { result, marked } = await run(profile('Following', { confirms: false }));
  assert.strictEqual(result.success, false);
  assert.deepStrictEqual(marked, []);
});
