/**
 * Regression Test Suite: Simulation vs Live State Separation
 * 
 * Proves:
 * 1. Simulation NEVER marks a real follow or comment as completed in SQLite.
 * 2. Simulated outcomes are stored in dedicated columns (simulated_follow_status, simulated_comment_status).
 * 3. A simulated follow/comment cannot cause a later live run to skip those actions.
 * 4. Live execution resumes from the first action that has NOT been verified live on Instagram.
 * 5. Safe recovery resets only demonstrably simulated records without deleting the database.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { getDatabase } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const {
  CreatorInteractionManager,
  isLiveFollowVerified,
  isLiveCommentVerified,
  isSimulatedFollowCompleted,
  isSimulatedCommentCompleted,
} = require('../../src/pipeline/creator-interaction');

const TEST_DB = path.resolve(__dirname, '../../data/test_state_separation.db');

function cleanupDb() {
  try {
    const db = getDatabase(TEST_DB);
    db.exec('DELETE FROM jobs; DELETE FROM creator_interactions; DELETE FROM audit_logs;');
  } catch {}
}

test.beforeEach(cleanupDb);
test.after(() => {
  cleanupDb();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

function createMockSender() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (threadId, text, opts = {}) => {
      sentMessages.push({ threadId, text, opts, type: 'message' });
      return true;
    },
    sendSuccess: async (threadId, data, opts = {}) => {
      sentMessages.push({ threadId, data, opts, type: 'success' });
      return true;
    },
  };
}

test('Regression: Simulation NEVER marks live follow or comment as completed', async () => {
  const db = getDatabase(TEST_DB);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'sim_test_thread_01',
    senderUsername: 'test_student',
    reelUrl: 'https://www.instagram.com/reel/SimTest01/',
    shortcode: 'SimTest01',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
      allowFollow: true,
      timeoutSec: 300,
    },
  });

  // Run in simulation
  const simResult = await manager.executeCreatorWorkflow(job, {
    creator: 'target_creator',
    caption: 'Comment "ROADMAP" to get the full guide!',
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
    mockReplyText: 'https://github.com/test/repo',
  });

  assert.strictEqual(simResult.success, true);

  const interaction = queue.getCreatorInteraction(job.id);
  assert.ok(interaction, 'Interaction record must exist');

  // 1. Simulation outcomes must be stored in dedicated simulated fields
  assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED');
  assert.ok(interaction.simulated_follow_at, 'Simulated follow timestamp must be set');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.ok(interaction.simulated_comment_at, 'Simulated comment timestamp must be set');
  assert.strictEqual(interaction.is_simulated, 1);

  // 2. Real/live follow and comment MUST NOT be marked completed
  assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED', 'Live follow_status must remain NOT_ATTEMPTED');
  assert.strictEqual(interaction.follow_verified_at, null, 'Live follow_verified_at must remain NULL');
  assert.strictEqual(interaction.live_follow_verified_at, null, 'Live live_follow_verified_at must remain NULL');
  assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED', 'Live comment_status must remain NOT_ATTEMPTED');
  assert.strictEqual(interaction.comment_posted_at, null, 'Live comment_posted_at must remain NULL');
  assert.strictEqual(interaction.live_comment_posted_at, null, 'Live live_comment_posted_at must remain NULL');

  // 3. Helper verification checks
  assert.strictEqual(isLiveFollowVerified(interaction), false, 'isLiveFollowVerified must return false for simulated follow');
  assert.strictEqual(isLiveCommentVerified(interaction), false, 'isLiveCommentVerified must return false for simulated comment');
  assert.strictEqual(isSimulatedFollowCompleted(interaction), true, 'isSimulatedFollowCompleted must return true');
  assert.strictEqual(isSimulatedCommentCompleted(interaction), true, 'isSimulatedCommentCompleted must return true');
});

test('Regression: Subsequent live run DOES NOT skip follow or comment executed in simulation', async () => {
  const db = getDatabase(TEST_DB);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'sim_test_thread_02',
    senderUsername: 'test_student',
    reelUrl: 'https://www.instagram.com/reel/SimTest02/',
    shortcode: 'SimTest02',
  });

  let liveFollowCallCount = 0;
  let liveCommentCallCount = 0;

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: true,
      simulationMode: false,
      requireApproval: false,
      allowFollow: true,
      timeoutSec: 300,
    },
  });

  // Mock live check and live browser interactions for testing offline
  manager.checkFollowStatus = async (creator, opts) => {
    return { isFollowing: false, status: 'NOT_FOLLOWING' };
  };

  manager.executeFollow = async (creator, opts) => {
    liveFollowCallCount++;
    return { success: true, status: 'COMPLETED' };
  };

  manager.executeComment = async (shortcode, text, opts) => {
    liveCommentCallCount++;
    return { success: true, status: 'POSTED' };
  };

  manager.monitorInboxForResponse = async (creator, opts) => {
    return {
      received: true,
      messageText: 'Here is your link: https://roadmap.sh/ai',
      extractedUrl: 'https://roadmap.sh/ai',
      isSimulated: false,
      folder: 'primary',
      elapsedMs: 50,
    };
  };

  // Pre-condition: Job previously ran in simulation and logged mockSuccess: true
  queue.createOrGetCreatorInteraction(job.id, {
    creatorUsername: 'rashmiracle_',
    shortcode: 'SimTest02',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'roadmap',
    isSimulated: 1,
  });
  queue.updateCreatorInteraction(job.id, {
    simulated_follow_status: 'COMPLETED',
    simulated_follow_at: new Date().toISOString(),
    simulated_comment_status: 'POSTED',
    simulated_comment_at: new Date().toISOString(),
    comment_text: 'roadmap',
    is_simulated: 1,
  });

  // Verify that live verification helpers see it as NOT completed live
  const preCheck = queue.getCreatorInteraction(job.id);
  assert.strictEqual(queue.isLiveFollowVerified(preCheck), false);
  assert.strictEqual(queue.isLiveCommentVerified(preCheck), false);

  // Execute LIVE workflow (isSimulation: false)
  const liveResult = await manager.executeCreatorWorkflow(job, {
    creator: 'rashmiracle_',
    caption: 'Follow me and comment "roadmap" to get link!',
    isSimulation: false,
    approved: true,
    mockFollowing: false,
  });

  assert.strictEqual(liveResult.success, true);

  // Proves live follow and comment were NOT skipped!
  assert.strictEqual(liveFollowCallCount, 1, 'Live follow must be executed (not skipped due to simulation)');
  assert.strictEqual(liveCommentCallCount, 1, 'Live comment must be executed (not skipped due to simulation)');

  // Proves live execution verified and marked real outcomes
  const postInteraction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(postInteraction.follow_status, 'COMPLETED');
  assert.ok(postInteraction.live_follow_verified_at, 'Live follow must have verified timestamp');
  assert.strictEqual(postInteraction.comment_status, 'POSTED');
  assert.ok(postInteraction.live_comment_posted_at, 'Live comment must have posted timestamp');
  assert.strictEqual(postInteraction.is_simulated, 0, 'Interaction must now be marked live (is_simulated=0)');

  // Now a subsequent LIVE run CAN safely skip because actions are genuinely verified live
  const idempotentRun = await manager.executeCreatorWorkflow(job, {
    creator: 'rashmiracle_',
    caption: 'Follow me and comment "roadmap" to get link!',
    isSimulation: false,
    approved: true,
    mockFollowing: false,
  });

  assert.strictEqual(idempotentRun.success, true);
  assert.strictEqual(liveFollowCallCount, 1, 'Idempotent live run must skip already verified live follow');
  assert.strictEqual(liveCommentCallCount, 1, 'Idempotent live run must skip already verified live comment');
});

test('Safe Recovery: Reset only demonstrably simulated follow/comment records preserving jobs and history', () => {
  const db = getDatabase(TEST_DB);
  const queue = new JobQueue(db);

  // Create two jobs:
  // Job 1: A contaminated simulation job
  const { job: job1 } = queue.createJob({
    threadId: 'supervised_operator_thread',
    senderUsername: 'operator',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  queue.createOrGetCreatorInteraction(job1.id, {
    creatorUsername: 'rashmiracle_',
    shortcode: 'DdRTNlBSAVB',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'roadmap',
    isSimulated: 1,
  });

  // Simulate what contaminated the DB previously
  queue.updateCreatorInteraction(job1.id, {
    follow_status: 'COMPLETED',
    follow_verified_at: '2026-10-19T18:19:49.730Z',
    comment_status: 'POSTED',
    comment_posted_at: '2026-10-19T18:19:49.734Z',
    comment_text: 'roadmap',
    reply_status: 'WAITING_INITIAL_WINDOW_EXPIRED',
    waiting_since: '2026-10-19T18:19:49.734Z',
    initial_window_expires_at: '2026-10-19T18:24:49.734Z',
    is_simulated: 1,
  });
  queue.updateStatus(job1.id, 'WAITING_FOR_REPLY', {
    resultSummary: "Couldn't fetch message",
  });
  db.prepare("UPDATE jobs SET is_delivered = 1, delivered_at = datetime('now') WHERE id = ?").run(job1.id);

  // Job 2: An unaffected user's job that must be completely preserved
  const { job: job2 } = queue.createJob({
    threadId: 'other_user_thread_888',
    senderUsername: 'alice',
    reelUrl: 'https://www.instagram.com/reel/OtherJob888/',
    shortcode: 'OtherJob888',
  });
  queue.createOrGetCreatorInteraction(job2.id, {
    creatorUsername: 'other_creator',
    shortcode: 'OtherJob888',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'TEST',
    isSimulated: 0,
  });
  queue.updateCreatorInteraction(job2.id, {
    follow_status: 'COMPLETED',
    follow_verified_at: '2026-10-19T15:00:00.000Z',
    live_follow_verified_at: '2026-10-19T15:00:00.000Z',
    comment_status: 'POSTED',
    comment_posted_at: '2026-10-19T15:01:00.000Z',
    live_comment_posted_at: '2026-10-19T15:01:00.000Z',
    reply_status: 'RECEIVED',
    extracted_url: 'https://github.com/alice/repo',
    is_simulated: 0,
  });

  // Execute safe recovery ONLY on contaminated Job 1
  const recovery = queue.recoverSimulatedJob(job1.id);
  assert.strictEqual(recovery.recovered, true);

  // Verify Job 1 repaired state:
  const repJob1 = queue.getJobById(job1.id);
  assert.strictEqual(repJob1.status, 'PENDING');
  assert.strictEqual(repJob1.is_delivered, 0);
  assert.strictEqual(repJob1.result_summary, null);

  const repInt1 = queue.getCreatorInteraction(job1.id);
  assert.strictEqual(repInt1.follow_status, 'NOT_ATTEMPTED');
  assert.strictEqual(repInt1.follow_verified_at, null);
  assert.strictEqual(repInt1.live_follow_verified_at, null);
  assert.strictEqual(repInt1.comment_status, 'NOT_ATTEMPTED');
  assert.strictEqual(repInt1.comment_posted_at, null);
  assert.strictEqual(repInt1.live_comment_posted_at, null);
  assert.strictEqual(repInt1.reply_status, 'WAITING');
  assert.strictEqual(repInt1.creator_username, 'rashmiracle_');
  assert.strictEqual(repInt1.keyword, 'roadmap');
  // Simulated outcomes safely preserved in dedicated columns
  assert.strictEqual(repInt1.simulated_follow_status, 'COMPLETED');
  assert.strictEqual(repInt1.simulated_comment_status, 'POSTED');

  // Verify Job 2 was NOT touched:
  const repJob2 = queue.getJobById(job2.id);
  assert.strictEqual(repJob2.sender_username, 'alice');
  const repInt2 = queue.getCreatorInteraction(job2.id);
  assert.strictEqual(repInt2.follow_status, 'COMPLETED');
  assert.strictEqual(repInt2.comment_status, 'POSTED');
  assert.strictEqual(repInt2.reply_status, 'RECEIVED');
  assert.strictEqual(repInt2.extracted_url, 'https://github.com/alice/repo');
});
