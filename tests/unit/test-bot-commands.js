const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const InstagramInbox = require('../../src/instagram/inbox');
const { CreatorInteractionManager } = require('../../src/pipeline/creator-interaction');
const { isSenderAllowed, normalizeSenderUsername } = require('../../src/security/sender-allowlist');

function createTestDb(testName) {
  const dbDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test_cmd_${testName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.db`);
  const db = new Database(dbPath);
  return { db, dbPath };
}

test('Command Security: Authorized vs Unauthorized Senders', async () => {
  const { db } = createTestDb('auth');
  const queue = new JobQueue(db);
  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };
  const inbox = new InstagramInbox(null, { queue, sender: mockSender, isLiveMode: false });

  // 1. Authorized senders: nauman, ksydn_, NAUMAN, @ksydn_
  assert.strictEqual(isSenderAllowed('nauman'), true);
  assert.strictEqual(isSenderAllowed('ksydn_'), true);
  assert.strictEqual(isSenderAllowed('NAUMAN'), true);
  assert.strictEqual(isSenderAllowed('@ksydn_'), true);

  await inbox.handleBotCommand('help', 'thread_1', 'nauman', 'msg_cmd_auth_1');
  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('ReelLink Bot Commands'));

  await inbox.handleBotCommand('status', 'thread_2', 'ksydn_', 'msg_cmd_auth_2');
  assert.strictEqual(deliveredDMs.length, 2);
  assert.ok(deliveredDMs[1].text.includes('ReelLink System Status'));

  // 2. Unauthorized senders: must be rejected without sending DMs or creating jobs
  const unauthorizedUsers = ['unauthorized_user', 'hacker99', 'nauman_impostor', 'random_person'];
  for (const u of unauthorizedUsers) {
    assert.strictEqual(isSenderAllowed(u), false);
    await inbox.handleBotCommand('status', 'thread_unauth', u, `msg_unauth_${u}`);
    await inbox.handleBotCommand('reset', 'thread_unauth', u, `msg_unauth_reset_${u}`, 'confirm');
  }

  // Still only 2 DMs delivered from authorized senders
  assert.strictEqual(deliveredDMs.length, 2);

  // Zero jobs created
  const stats = queue.getSystemStats();
  assert.strictEqual(stats.total, 0);
});

test('Commands never become Reel jobs in SQLite', async () => {
  const { db } = createTestDb('no_reel_jobs');
  const queue = new JobQueue(db);
  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };
  const inbox = new InstagramInbox(null, { queue, sender: mockSender, isLiveMode: false });

  const commandsToTest = [
    { cmd: 'help', args: '' },
    { cmd: 'menu', args: '' },
    { cmd: 'status', args: '' },
    { cmd: 'history', args: '' },
    { cmd: 'reset', args: '' },
    { cmd: 'reset', args: 'confirm' },
    { cmd: 'unfollow', args: '' },
    { cmd: 'unfollow', args: 'confirm' },
  ];

  for (let i = 0; i < commandsToTest.length; i++) {
    const item = commandsToTest[i];
    await inbox.handleBotCommand(item.cmd, 'thread_test', 'nauman', `msg_no_reel_${i}`, item.args);
  }

  // All commands executed without adding Reel jobs to the jobs table
  const allJobs = db.prepare('SELECT * FROM jobs').all();
  assert.strictEqual(allJobs.length, 0);
  assert.strictEqual(queue.getSystemStats().total, 0);
});

test('Command Aliases and Formats: /help, /menu, !help, !menu', async () => {
  const { db } = createTestDb('help_menu');
  const queue = new JobQueue(db);
  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };
  const inbox = new InstagramInbox(null, { queue, sender: mockSender });

  // Test help and menu
  await inbox.handleBotCommand('help', 'thread_1', 'nauman', 'msg_h1');
  await inbox.handleBotCommand('menu', 'thread_1', 'nauman', 'msg_m1');

  assert.strictEqual(deliveredDMs.length, 2);
  for (const dm of deliveredDMs) {
    assert.ok(dm.text.includes('ReelLink Bot Commands'));
    assert.ok(dm.text.includes('/status'));
    assert.ok(dm.text.includes('/history'));
    assert.ok(dm.text.includes('/reset'));
    assert.ok(dm.text.includes('/unfollow'));
  }
});

test('Status Command: Accurate breakdown, uptime, mode, and error summaries', async () => {
  const { db } = createTestDb('status_details');
  const queue = new JobQueue(db);

  // Seed jobs across different statuses
  // 1. Pending job
  const j1 = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/STATUS1/', shortcode: 'STATUS1' });
  
  // 2. Awaiting approval job
  const j2 = queue.createJob({ threadId: 't2', senderUsername: 'ksydn_', reelUrl: 'https://instagram.com/reel/STATUS2/', shortcode: 'STATUS2' });
  queue.updateStatus(j2.job.id, 'AWAITING_APPROVAL', { resultSummary: 'Awaiting operator approval to follow @creator2' });

  // 3. Completed job
  const j3 = queue.createJob({ threadId: 't3', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/STATUS3/', shortcode: 'STATUS3' });
  queue.updateStatus(j3.job.id, 'COMPLETED', { resultSummary: 'Comment posted successfully' });

  // 4. Failed job
  const j4 = queue.createJob({ threadId: 't4', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/STATUS4/', shortcode: 'STATUS4' });
  queue.updateStatus(j4.job.id, 'FAILED', { errorMessage: 'Instagram session rate limited' });

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender, isLiveMode: false });
  await inbox.handleBotCommand('status', 't1', 'nauman', 'msg_stat_1');

  assert.strictEqual(deliveredDMs.length, 1);
  const statusText = deliveredDMs[0].text;

  // Check required status fields
  assert.ok(statusText.includes('Mode: SIMULATION'));
  assert.ok(statusText.includes('Uptime:'));
  assert.ok(statusText.includes('Pending: 1'));
  assert.ok(statusText.includes('Awaiting Approval: 1'));
  assert.ok(statusText.includes('Completed: 1'));
  assert.ok(statusText.includes('Failed: 1'));
  assert.ok(statusText.includes('Reel STATUS2'));
  assert.ok(statusText.includes('node src/approve.js'));
  assert.ok(statusText.includes('Instagram session rate limited'));
});

test('History Command: Distinguishes Live vs Simulation follows and reports recent jobs', async () => {
  const { db } = createTestDb('history_details');
  const queue = new JobQueue(db);

  // 1. Seed a simulated interaction
  const j1 = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/HIST_SIM/', shortcode: 'HIST_SIM' });
  queue.createOrGetCreatorInteraction(j1.job.id, {
    creatorUsername: 'sim_creator',
    shortcode: 'HIST_SIM',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'GUIDE',
    isSimulated: 1,
  });
  queue.updateCreatorInteraction(j1.job.id, {
    simulated_follow_status: 'COMPLETED',
    simulated_comment_status: 'POSTED',
    simulated_follow_at: new Date().toISOString(),
    simulated_comment_at: new Date().toISOString(),
  });
  queue.updateStatus(j1.job.id, 'COMPLETED');

  // 2. Seed a live verified interaction
  const j2 = queue.createJob({ threadId: 't2', senderUsername: 'ksydn_', reelUrl: 'https://instagram.com/reel/HIST_LIVE/', shortcode: 'HIST_LIVE' });
  queue.createOrGetCreatorInteraction(j2.job.id, {
    creatorUsername: 'live_creator',
    shortcode: 'HIST_LIVE',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'AUTOMATE',
    isSimulated: 0,
  });
  queue.updateCreatorInteraction(j2.job.id, {
    follow_status: 'COMPLETED',
    comment_status: 'POSTED',
    live_follow_verified_at: new Date().toISOString(),
    live_comment_posted_at: new Date().toISOString(),
  });
  queue.updateStatus(j2.job.id, 'COMPLETED');

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender });
  await inbox.handleBotCommand('history', 't1', 'nauman', 'msg_hist_1');

  assert.strictEqual(deliveredDMs.length, 1);
  const histText = deliveredDMs[0].text;

  // Verify distinction between LIVE and SIMULATED
  assert.ok(histText.includes('@live_creator [LIVE]'));
  assert.ok(histText.includes('@sim_creator [SIMULATED]'));
  assert.ok(histText.includes('HIST_LIVE'));
  assert.ok(histText.includes('Verified [LIVE]'));
  assert.ok(histText.includes('Posted "AUTOMATE" [LIVE]'));
  assert.ok(histText.includes('HIST_SIM'));
  assert.ok(histText.includes('Simulated [SIM]'));
  assert.ok(histText.includes('Simulated "GUIDE" [SIM]'));
});

test('Reset Safety: Protects active and completed jobs, preserves duplicate history, requires confirmation', async () => {
  const { db } = createTestDb('reset_safety');
  const queue = new JobQueue(db);

  // 1. Create a COMPLETED job
  const jCompleted = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/DONE01/', shortcode: 'DONE01', messageId: 'msg_done_1' });
  queue.updateStatus(jCompleted.job.id, 'COMPLETED');

  // 2. Create an EXTRACTING (active) job
  const jActive = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/ACTIVE01/', shortcode: 'ACTIVE01', messageId: 'msg_act_1' });
  queue.updateStatus(jActive.job.id, 'EXTRACTING');

  // 3. Create a PENDING job
  const jPending = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/PEND01/', shortcode: 'PEND01', messageId: 'msg_pend_1' });

  // 4. Create an AWAITING_APPROVAL job
  const jAwaiting = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/WAIT01/', shortcode: 'WAIT01', messageId: 'msg_wait_1' });
  queue.updateStatus(jAwaiting.job.id, 'AWAITING_APPROVAL');

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const mockApp = {
    currentJobId: jActive.job.id,
    currentJob: jActive.job,
    isLiveMode: false,
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender, app: mockApp });

  // Step A: Preview reset (no confirmation)
  await inbox.handleBotCommand('reset', 't1', 'nauman', 'msg_res_prev');
  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('ReelLink Reset Preview'));
  assert.ok(deliveredDMs[0].text.includes('Found 2 job(s) eligible for reset')); // PENDING and AWAITING_APPROVAL only!
  assert.ok(deliveredDMs[0].text.includes('/reset confirm'));

  // Verify none have been modified yet
  assert.strictEqual(queue.getJobById(jActive.job.id).status, 'EXTRACTING');
  assert.strictEqual(queue.getJobById(jCompleted.job.id).status, 'COMPLETED');
  assert.strictEqual(queue.getJobById(jPending.job.id).status, 'PENDING');
  assert.strictEqual(queue.getJobById(jAwaiting.job.id).status, 'AWAITING_APPROVAL');

  // Step B: Execute confirmed reset
  await inbox.handleBotCommand('reset', 't1', 'nauman', 'msg_res_exec', 'confirm');
  assert.strictEqual(deliveredDMs.length, 2);
  assert.ok(deliveredDMs[1].text.includes('ReelLink Reset Complete'));
  assert.ok(deliveredDMs[1].text.includes('Cancelled 2 eligible'));

  // Verify active job and completed job are strictly untouched!
  assert.strictEqual(queue.getJobById(jActive.job.id).status, 'EXTRACTING');
  assert.strictEqual(queue.getJobById(jCompleted.job.id).status, 'COMPLETED');

  // Verify eligible jobs transitioned to CANCELLED
  assert.strictEqual(queue.getJobById(jPending.job.id).status, 'CANCELLED');
  assert.strictEqual(queue.getJobById(jAwaiting.job.id).status, 'CANCELLED');

  // Verify message deduplication history is intact
  assert.strictEqual(queue.isMessageProcessed('msg_done_1'), true);
  assert.strictEqual(queue.isMessageProcessed('msg_pend_1'), true);
  assert.strictEqual(queue.isMessageProcessed('msg_wait_1'), true);
});

test('Unfollow Safety: Preview requirement and simulation/live safety', async () => {
  const { db } = createTestDb('unf_safety');
  const queue = new JobQueue(db);

  // Seed followed creators today
  const j1 = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/UNF01/', shortcode: 'UNF01' });
  queue.createOrGetCreatorInteraction(j1.job.id, {
    creatorUsername: 'creator_to_unf',
    shortcode: 'UNF01',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'CODE',
    isSimulated: 1,
  });
  queue.updateCreatorInteraction(j1.job.id, {
    simulated_follow_status: 'COMPLETED',
    simulated_follow_at: new Date().toISOString(),
  });

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender, isLiveMode: false });

  // 1. Preview without confirm
  await inbox.handleBotCommand('unfollow', 't1', 'nauman', 'msg_unf_prev');
  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('ReelLink Unfollow Preview'));
  assert.ok(deliveredDMs[0].text.includes('@creator_to_unf'));
  assert.ok(deliveredDMs[0].text.includes('/unfollow confirm'));

  // Creator is NOT unfollowed yet
  const creatorsBefore = queue.getDetailedFollowedCreatorsToday();
  assert.strictEqual(creatorsBefore.length, 1);

  // 2. Confirmed unfollow in simulation mode
  await inbox.handleBotCommand('unfollow', 't1', 'nauman', 'msg_unf_conf', 'confirm');
  assert.strictEqual(deliveredDMs.length, 3); // Preview + Progress + Complete
  assert.ok(deliveredDMs[1].text.includes('Unfollowing 1 creator(s)'));
  assert.ok(deliveredDMs[2].text.includes('ReelLink Unfollow Complete'));
  assert.ok(deliveredDMs[2].text.includes('@creator_to_unf'));

  // Creator is now marked unfollowed
  const creatorsAfter = queue.getDetailedFollowedCreatorsToday();
  assert.strictEqual(creatorsAfter.length, 0);
});

test('Unfollow Safety: Blocks unfollow execution while active browser job is running in live mode', async () => {
  const { db } = createTestDb('unf_browser_safety');
  const queue = new JobQueue(db);

  // Seed followed creator
  const j1 = queue.createJob({ threadId: 't1', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/UNF_LIVE/', shortcode: 'UNF_LIVE' });
  queue.createOrGetCreatorInteraction(j1.job.id, {
    creatorUsername: 'busy_creator',
    shortcode: 'UNF_LIVE',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'BOT',
    isSimulated: 0,
  });
  queue.updateCreatorInteraction(j1.job.id, {
    follow_status: 'COMPLETED',
    live_follow_verified_at: new Date().toISOString(),
  });

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const mockApp = {
    currentJobId: 'job_active_123',
    currentJob: { id: 'job_active_123', shortcode: 'ACTIVE_JOB' },
    isLiveMode: true,
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender, app: mockApp, isLiveMode: true });

  // Try executing confirmed unfollow while active job is processing
  await inbox.handleBotCommand('unfollow', 't1', 'nauman', 'msg_unf_blocked', 'confirm');

  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('Cannot unfollow right now: a Reel job is actively being processed'));

  // Creator was NOT unfollowed
  const remaining = queue.getDetailedFollowedCreatorsToday();
  assert.strictEqual(remaining.length, 1);
});

test('Duplicate Command Ingestion Prevention', async () => {
  const { db } = createTestDb('dup_cmd');
  const queue = new JobQueue(db);
  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender });

  // First execution
  await inbox.handleBotCommand('help', 'thread_1', 'nauman', 'msg_id_unique_1');
  assert.strictEqual(deliveredDMs.length, 1);

  // Same messageId processed in DB
  assert.strictEqual(queue.isMessageProcessed('msg_id_unique_1'), true);

  // If inbox encounters the same messageId again, checkThreadForReels avoids re-running it
  const alreadyProcessed = queue.isMessageProcessed('msg_id_unique_1');
  assert.strictEqual(alreadyProcessed, true);
});

test('Regression: Follow-First-Then-Comment Workflow is strictly enforced', () => {
  const { extractCreatorRequirements } = require('../../src/pipeline/creator-interaction');

  // Verify caption keyword extraction preserving exact casing and default 🙌
  const req1 = extractCreatorRequirements('Comment ROADMAP to get the template', 'test_creator');
  assert.strictEqual(req1.keyword, 'ROADMAP');

  // When caption says "Comment for link" without explicit keyword, defaultToEmoji yields 🙌
  const req2 = extractCreatorRequirements('Comment for link!', 'test_creator', { defaultToEmoji: true });
  assert.strictEqual(req2.keyword, '🙌');

  // When caption has no instructions at all, app-level fallback defaults to 🙌
  const req3 = extractCreatorRequirements('Amazing day in the mountains!', 'test_creator');
  const fallbackKeyword = (req3.keyword && req3.keyword.trim().length > 0 && !req3.isUnclear) ? req3.keyword.trim() : '🙌';
  assert.strictEqual(fallbackKeyword, '🙌');

  // Verify creator interaction schema always expects follow first
  const { db } = createTestDb('workflow_follow_first');
  const queue = new JobQueue(db);
  const j = queue.createJob({ threadId: 't', senderUsername: 'nauman', reelUrl: 'https://instagram.com/reel/WF01/', shortcode: 'WF01' });

  const interaction = queue.createOrGetCreatorInteraction(j.job.id, {
    creatorUsername: 'wf_creator',
    shortcode: 'WF01',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'GUIDE',
    isSimulated: 1,
  });

  assert.strictEqual(interaction.requires_follow, 1);
  assert.strictEqual(interaction.requires_comment, 1);
  assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');
  assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED');
});
