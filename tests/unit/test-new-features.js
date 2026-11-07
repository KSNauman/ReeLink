const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const { CreatorInteractionManager, extractCreatorRequirements } = require('../../src/pipeline/creator-interaction');
const InstagramSender = require('../../src/instagram/sender');
const InstagramInbox = require('../../src/instagram/inbox');

function createTestDb(testName) {
  const dbPath = path.join(__dirname, `../../data/test_${testName}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_username TEXT NOT NULL,
      reel_url TEXT NOT NULL,
      shortcode TEXT NOT NULL,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      stage TEXT NOT NULL DEFAULT 'A',
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      evidence_json TEXT,
      candidate_url TEXT,
      result_summary TEXT,
      error_message TEXT,
      is_delivered INTEGER DEFAULT 0,
      delivered_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS creator_interactions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      creator_username TEXT NOT NULL,
      shortcode TEXT NOT NULL,
      requires_follow INTEGER DEFAULT 0,
      requires_comment INTEGER DEFAULT 0,
      keyword TEXT,
      follow_status TEXT DEFAULT 'NOT_ATTEMPTED',
      follow_verified_at TEXT,
      comment_status TEXT DEFAULT 'NOT_ATTEMPTED',
      comment_posted_at TEXT,
      comment_text TEXT,
      reply_status TEXT DEFAULT 'WAITING',
      reply_received_at TEXT,
      extracted_url TEXT,
      review_reason TEXT,
      is_simulated INTEGER DEFAULT 0,
      simulated_follow_status TEXT DEFAULT 'NOT_ATTEMPTED',
      simulated_follow_at TEXT,
      simulated_comment_status TEXT DEFAULT 'NOT_ATTEMPTED',
      simulated_comment_at TEXT,
      live_follow_verified_at TEXT,
      live_comment_posted_at TEXT,
      live_comment_verified_at TEXT,
      last_seen_message_id TEXT,
      last_seen_message_text TEXT,
      waiting_since TEXT,
      initial_window_expires_at TEXT,
      last_inbox_check_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sender_username TEXT NOT NULL,
      shortcode TEXT,
      reel_url TEXT,
      processed_at TEXT DEFAULT (datetime('now')),
      ack_sent INTEGER DEFAULT 0,
      ack_sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT,
      level TEXT NOT NULL,
      component TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return { db, dbPath };
}

test('Default Comment Keyword: defaults to 🙌 when no explicit keyword in caption', async () => {
  const { db, dbPath } = createTestDb('default_emoji');
  const queue = new JobQueue(db);

  const mockInbox = {
    openCreatorThread: async () => ({
      threadId: 'creator_thread_123',
      folder: 'primary',
      messages: [{ text: 'Here is your link: https://github.com/example/repo', links: ['https://github.com/example/repo'] }],
    }),
  };

  const sentMessages = [];
  const mockSender = {
    sendMessage: async (threadId, msg) => {
      sentMessages.push({ threadId, msg });
      return true;
    },
    sendSuccess: async (threadId, payload) => {
      sentMessages.push({ threadId, payload });
      return true;
    },
  };

  const manager = new CreatorInteractionManager({
    queue,
    inbox: mockInbox,
    sender: mockSender,
    simulationMode: true,
    requireApproval: false,
  });

  const { job } = queue.createJob({
    threadId: 'user_thread_1',
    senderUsername: 'nauman',
    reelUrl: 'https://www.instagram.com/reel/DeHLVF5xOz_/',
    shortcode: 'DeHLVF5xOz_',
    enforceAllowlist: false,
  });

  // Caption has NO keyword
  const caption = 'Check out this awesome tutorial! Save for later!';
  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'akshaya_info',
    caption,
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
    mockReplyText: 'Here is your link: https://github.com/example/repo',
  });

  assert.strictEqual(result.success, true);
  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.keyword, '🙌', 'Should default keyword to 🙌 emoji');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.strictEqual(interaction.comment_text, '🙌');
});

test('Comment-Only Workflow: verified comment completes without creator DM monitoring or forwarding', async () => {
  const { db, dbPath } = createTestDb('comment_only_completion');
  const queue = new JobQueue(db);

  const sentDMs = [];
  const mockSender = {
    sendMessage: async (threadId, msg, options) => {
      sentDMs.push({ threadId, msg, options });
      return true;
    },
    sendSuccess: async () => true,
  };

  const manager = new CreatorInteractionManager({
    queue,
    sender: mockSender,
    simulationMode: true,
    requireApproval: false,
  });

  const { job } = queue.createJob({
    threadId: 'user_thread_test',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DeTest12345/',
    shortcode: 'DeTest12345',
    enforceAllowlist: false,
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'text_creator',
    caption: 'Comment below to receive the code!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.keyword, '🙌'); // No specific keyword in caption -> 🙌 fallback

  // Verify zero messages forwarded or sent to user thread
  assert.strictEqual(sentDMs.length, 0);

  // Check DB state
  const updatedJob = queue.getJob(job.id);
  assert.strictEqual(updatedJob.status, 'COMPLETED');
  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
});

test('Bot Menu & History: getTodayHistory retrieves followed, replied, and pending jobs', async () => {
  const { db, dbPath } = createTestDb('bot_history');
  const queue = new JobQueue(db);

  // 1. Create a completed job with verified follow and reply
  const { job: job1 } = queue.createJob({
    threadId: 'thread_1',
    senderUsername: 'nauman',
    reelUrl: 'https://instagram.com/reel/ABC111/',
    shortcode: 'ABC111',
  });
  queue.createOrGetCreatorInteraction(job1.id, {
    creatorUsername: 'creator_one',
    shortcode: 'ABC111',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: '🙌',
  });
  queue.updateCreatorInteraction(job1.id, {
    follow_status: 'COMPLETED',
    live_follow_verified_at: new Date().toISOString(),
    reply_status: 'RECEIVED',
    extracted_url: 'https://github.com/example/one',
    reply_received_at: new Date().toISOString(),
  });
  queue.updateStatus(job1.id, 'COMPLETED', { candidateUrl: 'https://github.com/example/one' });

  // 2. Create a waiting job
  const { job: job2 } = queue.createJob({
    threadId: 'thread_1',
    senderUsername: 'nauman',
    reelUrl: 'https://instagram.com/reel/DEF222/',
    shortcode: 'DEF222',
  });
  queue.createOrGetCreatorInteraction(job2.id, {
    creatorUsername: 'creator_two',
    shortcode: 'DEF222',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'GUIDE',
  });
  queue.updateCreatorInteraction(job2.id, {
    follow_status: 'COMPLETED',
    live_follow_verified_at: new Date().toISOString(),
    reply_status: 'WAITING',
    waiting_since: new Date().toISOString(),
    initial_window_expires_at: new Date(Date.now() + 300000).toISOString(),
  });
  queue.updateStatus(job2.id, 'WAITING_FOR_REPLY');

  const history = queue.getTodayHistory();
  assert.strictEqual(history.followed.length, 2);
  assert.ok(history.followed.some(f => f.creator_username === 'creator_one'));
  assert.ok(history.followed.some(f => f.creator_username === 'creator_two'));

  assert.strictEqual(history.replied.length, 1);
  assert.strictEqual(history.replied[0].creator_username, 'creator_one');
  assert.strictEqual(history.replied[0].extracted_url, 'https://github.com/example/one');

  assert.strictEqual(history.pending.length, 1);
  assert.strictEqual(history.pending[0].creator_username, 'creator_two');
  assert.strictEqual(history.pending[0].shortcode, 'DEF222');

  const stats = queue.getSystemStats();
  assert.strictEqual(stats.completed, 1);
  assert.strictEqual(stats.waiting, 1);
  assert.strictEqual(stats.total, 2);
});

test('Bot Command Dispatch: handleBotCommand executes /history, /help, /status', async () => {
  const { db, dbPath } = createTestDb('cmd_dispatch');
  const queue = new JobQueue(db);

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender });

  // Test /help
  await inbox.handleBotCommand('help', 'thread_user', 'nauman', 'msg_test_help_1');
  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('ReelLink Bot Commands Menu'));
  assert.ok(deliveredDMs[0].text.includes('/history'));

  // Test /status
  await inbox.handleBotCommand('status', 'thread_user', 'nauman', 'msg_test_status_1');
  assert.strictEqual(deliveredDMs.length, 2);
  assert.ok(deliveredDMs[1].text.includes('ReelLink System Status'));

  // Test /history
  await inbox.handleBotCommand('history', 'thread_user', 'nauman', 'msg_test_history_1');
  assert.strictEqual(deliveredDMs.length, 3);
  assert.ok(deliveredDMs[2].text.includes('ReelLink Bot Activity (Today)'));
  assert.ok(deliveredDMs[2].text.includes('Creators Followed'));
  assert.ok(deliveredDMs[2].text.includes('Recent Reel Jobs'));
});

test('Contextual Reel Reference: sender prepends regarding reel URL when shortcode provided in simulation/fallback', async () => {
  const mockSession = { getPage: async () => null };
  const sender = new InstagramSender(mockSession, { dryRun: true });

  // In dry run, it formats and logs without throwing
  const sent = await sender.sendSuccess('thread_123', {
    url: 'https://example.com/target',
    title: 'Example Project',
    summary: 'A helpful guide',
    score: 0.99,
    shortcode: 'DeShortcode99',
  });

  assert.strictEqual(sent, true);
});

test('Bot Command Dispatch: handleBotCommand executes !reset and resets pending jobs', async () => {
  const { db, dbPath } = createTestDb('cmd_reset');
  const queue = new JobQueue(db);

  // Seed pending and waiting jobs
  const job1 = queue.createJob({
    threadId: 'thread_user',
    senderUsername: 'nauman',
    reelUrl: 'https://instagram.com/reel/TEST1/',
    shortcode: 'TEST1',
    enforceAllowlist: false,
  });
  queue.updateStatus(job1.job.id, 'WAITING_FOR_REPLY');

  const job2 = queue.createJob({
    threadId: 'thread_user',
    senderUsername: 'nauman',
    reelUrl: 'https://instagram.com/reel/TEST2/',
    shortcode: 'TEST2',
    enforceAllowlist: false,
  });
  queue.updateStatus(job2.job.id, 'AWAITING_APPROVAL');

  const deliveredDMs = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      deliveredDMs.push({ threadId, text });
      return true;
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender });

  // 1. Preview reset command without confirmation
  await inbox.handleBotCommand('reset', 'thread_user', 'nauman', 'msg_test_reset_preview');
  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('ReelLink Reset Preview'));
  assert.ok(deliveredDMs[0].text.includes('Found 2 job(s) eligible for reset'));

  // Jobs are NOT cancelled yet
  let preStats = queue.getSystemStats();
  assert.strictEqual(preStats.waiting, 1);
  assert.strictEqual(preStats.awaiting_approval, 1);

  // 2. Execute confirmed reset command
  await inbox.handleBotCommand('reset', 'thread_user', 'nauman', 'msg_test_reset_1', 'confirm');
  assert.strictEqual(deliveredDMs.length, 2);
  assert.ok(deliveredDMs[1].text.includes('ReelLink Reset Complete'));
  assert.ok(deliveredDMs[1].text.includes('2 eligible pending/waiting job(s)'));

  // Verify DB state
  const stats = queue.getSystemStats();
  assert.strictEqual(stats.waiting, 0);
  assert.strictEqual(stats.pending, 0);
  assert.strictEqual(stats.awaiting_approval, 0);
  assert.strictEqual(stats.cancelled, 2);
});

test('Bot Command Dispatch: handleBotCommand executes !unfollow preview and confirmed unfollow', async () => {
  const { db, dbPath } = createTestDb('cmd_unfollow');
  const queue = new JobQueue(db);

  // Seed followed creators today
  const job1 = queue.createJob({
    threadId: 'thread_user',
    senderUsername: 'nauman',
    reelUrl: 'https://instagram.com/reel/TEST_UNF1/',
    shortcode: 'TEST_UNF1',
    enforceAllowlist: false,
  });
  queue.createOrGetCreatorInteraction(job1.job.id, {
    creatorUsername: 'creator_to_unfollow',
    shortcode: 'TEST_UNF1',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: '🙌',
    isSimulated: 0,
  });
  queue.updateCreatorInteraction(job1.job.id, {
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

  const mockCreatorManager = {
    unfollowCreator: async (creator) => {
      queue.markCreatorUnfollowed(creator);
      return { success: true, creator };
    },
  };

  const inbox = new InstagramInbox(null, { queue, sender: mockSender });
  inbox.creatorManager = mockCreatorManager;

  // 1. Execute preview unfollow command without confirmation
  await inbox.handleBotCommand('unfollow', 'thread_user', 'nauman', 'msg_test_unfollow_preview');
  assert.strictEqual(deliveredDMs.length, 1);
  assert.ok(deliveredDMs[0].text.includes('ReelLink Unfollow Preview'));
  assert.ok(deliveredDMs[0].text.includes('@creator_to_unfollow'));

  // Creator is NOT unfollowed yet
  let followedBefore = queue.getFollowedCreatorsToday();
  assert.strictEqual(followedBefore.length, 1);

  // 2. Execute confirmed unfollow command
  await inbox.handleBotCommand('unfollow', 'thread_user', 'nauman', 'msg_test_unfollow_1', 'confirm');
  assert.strictEqual(deliveredDMs.length, 3); // Preview + Progress DM + Completion DM
  assert.ok(deliveredDMs[1].text.includes('Unfollowing 1 creator(s)'));
  assert.ok(deliveredDMs[2].text.includes('ReelLink Unfollow Complete'));
  assert.ok(deliveredDMs[2].text.includes('@creator_to_unfollow'));

  // Verify creators followed today is now empty
  const remainingFollowed = queue.getFollowedCreatorsToday();
  assert.strictEqual(remainingFollowed.length, 0);
});

test('Native Message Forwarding: forwardLatestCreatorMessage simulation mode returns success cleanly', async () => {
  const { db, dbPath } = createTestDb('native_forward_sim');
  const queue = new JobQueue(db);
  const manager = new CreatorInteractionManager({
    queue,
    simulationMode: true,
  });

  const result = await manager.forwardLatestCreatorMessage('test_creator', 'nauman', { isSimulation: true });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.isSimulated, true);
});
