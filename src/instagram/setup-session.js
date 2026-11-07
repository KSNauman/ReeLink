/**
 * Interactive Instagram Session Setup
 * Launches Chromium in headful mode allowing the operator to log in once.
 * Cookies and authentication tokens are automatically preserved in data/browser_profile/.
 */
const readline = require('readline');
const BrowserSession = require('./session');
const config = require('../config');
const logger = require('../utils/logger');

async function setupSession() {
  console.log('\n======================================================');
  console.log('       ReelLink: Instagram Session Setup Wizard        ');
  console.log('======================================================\n');
  console.log('Launching browser with persistent profile at:');
  console.log(`  ${config.instagram.profileDir}\n`);

  // Force headful mode so the operator can see and interact with the page
  const session = new BrowserSession({ headless: false });

  try {
    const page = await session.getPage();

    logger.info('Navigating to Instagram login / inbox...');
    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Check if credentials are provided in .env to auto-populate fields
    if (config.instagram.username && config.instagram.password) {
      try {
        await page.waitForTimeout(2000);
        const usernameInput = await page.$('input[name="username"]');
        const passwordInput = await page.$('input[name="password"]');

        if (usernameInput && passwordInput) {
          logger.info('Auto-populating credentials from .env...');
          await usernameInput.fill(config.instagram.username);
          await passwordInput.fill(config.instagram.password);
          logger.info('Credentials entered. Please review and click Log In.');
        }
      } catch (err) {
        logger.debug('Auto-fill skipped or fields not found', { error: err.message });
      }
    }

    console.log('\n👉 Instructions:');
    console.log('1. In the opened browser, complete login and any 2FA/SMS checkpoints.');
    console.log('2. When you reach your Instagram Direct Inbox (https://www.instagram.com/direct/inbox/), return here.');
    console.log('3. Press [ENTER] in this terminal to save and verify your session.\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    await new Promise(resolve => {
      rl.question('Press [ENTER] after logging in successfully...', () => {
        rl.close();
        resolve();
      });
    });

    logger.info('Verifying session persistence...');
    const status = await session.checkAuthStatus();

    if (status.authenticated) {
      console.log('\n✅ SUCCESS: Instagram session is authenticated and persistent!');
      console.log(`Current URL: ${status.currentUrl}`);
      console.log('Your session is saved in data/browser_profile/. You can now run ReelLink in headless mode.\n');
    } else {
      console.log('\n⚠️ WARNING: The browser is not currently authenticated at the inbox.');
      console.log(`Current URL: ${status.currentUrl}`);
      console.log('If you were in the middle of a challenge, rerun this script to complete it.\n');
    }
  } catch (err) {
    logger.error('Session setup encountered an error', { error: err.message });
  } finally {
    await session.close();
    process.exit(0);
  }
}

if (require.main === module) {
  setupSession();
}

module.exports = setupSession;
