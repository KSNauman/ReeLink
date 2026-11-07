/**
 * Live Instagram Inbox Diagnostic & Verification Script
 * Validates browser launch, profile directory, session persistence,
 * and reports authentication status with actionable next steps.
 */
const BrowserSession = require('../src/instagram/session');
const InstagramInbox = require('../src/instagram/inbox');
const config = require('../src/config');
const logger = require('../src/utils/logger');

async function runVerification() {
  console.log('\n======================================================');
  console.log('       ReelLink: Instagram Inbox Feasibility Check    ');
  console.log('======================================================\n');

  console.log('Configuration:');
  console.log(`  Browser Profile Dir: ${config.instagram.profileDir}`);
  console.log(`  Headless Mode:       ${config.instagram.headless}`);
  console.log(`  Poll Interval:       ${config.instagram.pollIntervalSec}s`);
  console.log(`  Configured Bot User: ${config.instagram.username || '(None specified)'}\n`);

  const session = new BrowserSession();

  try {
    console.log('1. Testing persistent Chromium context launch...');
    const context = await session.getContext();
    console.log('   ✅ Chromium launched successfully with persistent profile.\n');

    console.log('2. Checking Instagram session authentication status...');
    const auth = await session.checkAuthStatus();

    if (auth.authenticated) {
      console.log('   ✅ Session is AUTHENTICATED on Instagram Web!');
      console.log(`   Current URL: ${auth.currentUrl}\n`);

      console.log('3. Scanning direct inbox threads...');
      const inbox = new InstagramInbox(session);
      const threads = await inbox.getInboxThreads();
      console.log(`   ✅ Successfully queried inbox: Found ${threads.length} active threads.`);

      if (threads.length > 0) {
        console.log('\n   Active Threads:');
        threads.slice(0, 5).forEach((t, i) => {
          console.log(`     ${i + 1}. User: ${t.username} (Thread ID: ${t.threadId})`);
        });
      }
      console.log('\n======================================================');
      console.log('   RESULT: Milestone 1 Instagram Ingestion PASSED!   ');
      console.log('======================================================\n');
    } else {
      console.log('   ℹ️ Session status: NOT YET LOGGED IN.');
      console.log(`   Current URL: ${auth.currentUrl}\n`);
      console.log('------------------------------------------------------');
      console.log('NEXT ACTION REQUIRED FOR LIVE ACCOUNT TESTING:');
      console.log('To authenticate your dedicated bot account:');
      console.log('  1. Configure IG_USERNAME & IG_PASSWORD in .env (optional)');
      console.log('  2. Run the interactive setup command:');
      console.log('       npm.cmd run setup:session');
      console.log('  3. Complete login in the visible browser window.');
      console.log('  4. Re-run this verification script.');
      console.log('------------------------------------------------------\n');
    }
  } catch (err) {
    logger.error('Verification encountered an unexpected error', { error: err.message });
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  runVerification();
}

module.exports = runVerification;
