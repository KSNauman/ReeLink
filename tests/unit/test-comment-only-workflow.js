/**
 * ReelLink: Simplified Comment-Only Workflow Test Suite
 * 
 * Verifies the 8 core requirements of the simplified architecture:
 * 1. Authorized Reels follow the simplified workflow (extract, follow, comment, complete).
 * 2. The comment uses the exact caption keyword or 🙌 fallback.
 * 3. Duplicate processing cannot cause duplicate comments (idempotency guard).
 * 4. Unauthorized senders cannot trigger creator actions (allowlist gate).
 * 5. Commands do not create Reel jobs and are routed separately.
 * 6. A verified comment completes the job without starting resource searches, reply polling, timers, forwarding, or delivery.
 * 7. No CSV resource log is created or updated by the active workflow.
 * 8. Existing commands still work where they are supported (help, status, history, reset, unfollow).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const { CreatorInteractionManager } = require('../../src/pipeline/creator-interaction');
const { isSenderAllowed, assertSenderAllowed } = require('../../src/security/sender-allowlist');
const InstagramInbox = require('../../src/instagram/inbox');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_comment_only.db');
const CSV_FILE_PATH = path.resolve(__dirname, '../../data/ReelLink_Resources.csv');

function cleanupDb() {
  try {
    const db = getDatabase(TEST_DB_PATH);
    db.exec('DELETE FROM jobs; DELETE FROM creator_interactions; DELETE FROM processed_messages; DELETE FROM audit_log;');
  } catch {}
}

test.beforeEach(cleanupDb);
test.after(() => {
  cleanupDb();
});

function createMockSender() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (threadId, text, opts = {}) => {
      sentMessages.push({ threadId, text, opts, type: 'text' });
      return true;
    },
    sendSuccess: async (threadId, data, opts = {}) => {
      sentMessages.push({ threadId, data, opts, type: 'success' });
      return true;
    },
    sendFailure: async (threadId, data, opts = {}) => {
      sentMessages.push({ threadId, data, opts, type: 'failure' });
      return true;
    },
  };
}

// 1. Authorized Reels follow the simplified workflow
test('1. Authorized Reels follow the simplified workflow', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const authorizedSender = 'ksydn_';
  assert.strictEqual(isSenderAllowed(authorizedSender), true, 'Sender must be authorized');

  const { job } = queue.createJob({
    threadId: 'thread_auth_1',
    senderUsername: authorizedSender,
    reelUrl: 'https://www.instagram.com/reel/AuthReel123/',
    shortcode: 'AuthReel123',
    enforceAllowlist: true,
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: { simulationMode: true, requireApproval: false },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'authorized_creator',
    caption: 'Comment "FASTAPI" for the starter template!',
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.keyword, 'FASTAPI');
  assert.strictEqual(result.creator, 'authorized_creator');
  assert.strictEqual(result.shortcode, 'AuthReel123');

  // Verify DB state
  const updatedJob = queue.getJob(job.id);
  assert.strictEqual(updatedJob.status, 'COMPLETED');
  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED', 'Follow action is completed');
  assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED', 'Live follow must not be marked by simulation');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.strictEqual(interaction.keyword, 'FASTAPI');
});

// 2. The comment uses the exact caption keyword or 🙌 fallback
test('2. The comment uses the exact caption keyword or 🙌 fallback', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const manager = new CreatorInteractionManager({
    queue,
    configOptions: { simulationMode: true, requireApproval: false },
  });

  // 2a. Exact keyword preservation (including case and special chars)
  const kw1 = manager.extractCommentKeyword('Comment "AGENTIC" below to get the full repository!');
  assert.strictEqual(kw1, 'AGENTIC', 'Should extract AGENTIC keyword');

  const kw2 = manager.extractCommentKeyword('Drop "Docker-Compose" in the comments!');
  assert.strictEqual(kw2, 'Docker-Compose', 'Should extract Docker-Compose preserving casing and hyphen');

  const kw3 = manager.extractCommentKeyword('Comment \'PROMO_2026\' to receive your coupon code.');
  assert.strictEqual(kw3, 'PROMO_2026', 'Should extract PROMO_2026');

  // 2b. Fallback to 🙌 when no keyword or ambiguous
  const kw4 = manager.extractCommentKeyword('Here is a wonderful video of sunset in Tokyo. Hope you enjoy!');
  assert.strictEqual(kw4, '🙌', 'Should fallback to 🙌 when no keyword exists');

  const kw5 = manager.extractCommentKeyword('');
  assert.strictEqual(kw5, '🙌', 'Should fallback to 🙌 on empty caption');

  const kw6 = manager.extractCommentKeyword(null);
  assert.strictEqual(kw6, '🙌', 'Should fallback to 🙌 on null caption');
});

// 3. Duplicate processing cannot cause duplicate comments
test('3. Duplicate processing cannot cause duplicate comments', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const manager = new CreatorInteractionManager({
    queue,
    configOptions: { simulationMode: true, requireApproval: false },
  });

  const { job } = queue.createJob({
    threadId: 'thread_idempotency_1',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DuplicateReel1/',
    shortcode: 'DuplicateReel1',
    enforceAllowlist: false,
  });

  // First run: posts comment
  const res1 = await manager.executeCreatorWorkflow(job, {
    creator: 'popular_creator',
    caption: 'Comment "KUBERNETES" below!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.status, 'COMPLETED');

  const interaction1 = queue.getCreatorInteraction(job.id);
  const firstCommentTime = interaction1.simulated_comment_at;
  assert.ok(firstCommentTime, 'Comment timestamp must be recorded');

  // Second run: spy on comment execution to ensure it is SKIPPED
  let commentReattempted = false;
  manager.executeComment = async () => {
    commentReattempted = true;
    return { success: true };
  };

  const res2 = await manager.executeCreatorWorkflow(job, {
    creator: 'popular_creator',
    caption: 'Comment "KUBERNETES" below!',
    isSimulation: true,
    approved: true,
  });

  assert.strictEqual(res2.success, true);
  assert.strictEqual(commentReattempted, false, 'Comment must not be re-attempted');

  const interaction2 = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction2.simulated_comment_at, firstCommentTime, 'Timestamp must remain unchanged');
});

// 4. Unauthorized senders cannot trigger creator actions
test('4. Unauthorized senders cannot trigger creator actions', () => {
  const unauthorizedSender = 'random_intruder_99';
  assert.strictEqual(isSenderAllowed(unauthorizedSender), false, 'Intruder must be rejected by isSenderAllowed');

  const allowed = assertSenderAllowed(unauthorizedSender, { stage: 'TEST' });
  assert.strictEqual(allowed, false, 'assertSenderAllowed must fail closed and return false');
});

// 5. Commands do not create Reel jobs and are routed separately
test('5. Commands do not create Reel jobs and are routed separately', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  // Create mock inbox
  const inbox = new InstagramInbox(null, { queue, sender });
  inbox.processedMessageIds = new Set();

  const commandText = '/status';
  const threadId = '17842115300129061';
  const senderUsername = 'ksydn_';
  const messageId = 'msg_cmd_status_test_1';

  // Execute bot command handling directly
  await inbox.handleBotCommand('status', threadId, senderUsername, messageId);

  // Command was executed and sent response
  assert.strictEqual(sender.sentMessages.length, 1);
  assert.ok(sender.sentMessages[0].text.includes('ReelLink System Status'));

  // Zero jobs created in JobQueue
  const allJobs = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  assert.strictEqual(allJobs, 0, 'Commands must NEVER create jobs in the JobQueue');

  // Command was recorded as processed message to prevent duplicate triggers
  assert.strictEqual(queue.isMessageProcessed(messageId), true);
});

// 6. A verified comment completes the job without starting resource searches, reply polling, timers, forwarding, or delivery
test('6. A verified comment completes the job without starting resource searches, reply polling, timers, forwarding, or delivery', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'thread_user_delivery_check',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/VerifiedComment1/',
    shortcode: 'VerifiedComment1',
    enforceAllowlist: false,
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: { simulationMode: true, requireApproval: false },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'code_builder',
    caption: 'Comment "REACT" for code!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
    // Provide reply mock that would have been used in the old workflow
    mockReplyText: 'Here is your link: https://github.com/facebook/react',
  });

  // 1. Result must terminate at COMMENT stage
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.status, 'COMPLETED');

  // 2. No resource discovery fields returned
  assert.strictEqual(result.resourceUrl, undefined);
  assert.strictEqual(result.forwardedText, undefined);

  // 3. Sender must have sent ZERO messages to requester thread (no delivery or forwarding)
  assert.strictEqual(sender.sentMessages.length, 0);

  // 4. Database job status is COMPLETED immediately without waiting for replies
  const finalJob = queue.getJob(job.id);
  assert.strictEqual(finalJob.status, 'COMPLETED');
});

// 7. No CSV resource log is created or updated by the active workflow
test('7. No CSV resource log is created or updated by the active workflow', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  // Record initial state of CSV file (if it exists)
  const initialCsvExists = fs.existsSync(CSV_FILE_PATH);
  const initialCsvMtime = initialCsvExists ? fs.statSync(CSV_FILE_PATH).mtimeMs : null;
  const initialCsvSize = initialCsvExists ? fs.statSync(CSV_FILE_PATH).size : 0;

  const { job } = queue.createJob({
    threadId: 'thread_csv_check',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/CsvCheck123/',
    shortcode: 'CsvCheck123',
    enforceAllowlist: false,
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: { simulationMode: true, requireApproval: false },
  });

  await manager.executeCreatorWorkflow(job, {
    creator: 'nocsv_creator',
    caption: 'Comment "NOCSV" to test!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  // Verify that the CSV file was neither created (if absent) nor modified (if present)
  if (initialCsvExists) {
    const afterMtime = fs.statSync(CSV_FILE_PATH).mtimeMs;
    const afterSize = fs.statSync(CSV_FILE_PATH).size;
    assert.strictEqual(afterMtime, initialCsvMtime, 'CSV file mtime must not change');
    assert.strictEqual(afterSize, initialCsvSize, 'CSV file size must not change');
  } else {
    assert.strictEqual(fs.existsSync(CSV_FILE_PATH), false, 'CSV file must not be created');
  }
});

// 8. Existing commands still work where they are supported
test('8. Existing commands still work where they are supported', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const inbox = new InstagramInbox(null, { queue, sender });
  inbox.processedMessageIds = new Set();
  const threadId = 'test_cmd_thread';
  const username = 'ksydn_';

  // 8a. /help and /menu
  await inbox.handleBotCommand('help', threadId, username, 'msg_help_1');
  assert.ok(sender.sentMessages.some(m => m.text.includes('ReelLink Bot Commands Menu')));

  sender.sentMessages.length = 0;
  await inbox.handleBotCommand('menu', threadId, username, 'msg_menu_1');
  assert.ok(sender.sentMessages.some(m => m.text.includes('ReelLink Bot Commands Menu')));

  // 8b. /status
  sender.sentMessages.length = 0;
  await inbox.handleBotCommand('status', threadId, username, 'msg_status_1');
  assert.ok(sender.sentMessages.some(m => m.text.includes('ReelLink System Status')));

  // 8c. /history
  sender.sentMessages.length = 0;
  await inbox.handleBotCommand('history', threadId, username, 'msg_history_1');
  assert.ok(sender.sentMessages.some(m => m.text.includes('ReelLink Bot Activity')));

  // 8d. /reset
  sender.sentMessages.length = 0;
  await inbox.handleBotCommand('reset', threadId, username, 'msg_reset_1');
  assert.ok(sender.sentMessages.some(m => m.text.includes('ReelLink Reset Complete')));

  // 8e. /unfollow (when no creators followed)
  sender.sentMessages.length = 0;
  await inbox.handleBotCommand('unfollow', threadId, username, 'msg_unfollow_1');
  assert.ok(sender.sentMessages.some(m => m.text.includes('No creators were followed today')));
});
