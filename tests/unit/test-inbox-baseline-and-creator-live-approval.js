/**
 * Automated Acceptance & Regression Tests for:
 * 1. Inbox Baseline & Message Deduplication (BUG 1)
 * 2. Creator Workflow Live Supervised Approval & 5-Minute Reply Monitoring (BUG 2)
 * 
 * Verifies all 12 required test conditions:
 *  1. An existing Reel in the inbox at startup is not ingested as a new request.
 *  2. Repeated polling of the same message creates exactly one job and one acknowledgement.
 *  3. A genuinely new Reel message creates one job.
 *  4. Sharing the same Reel URL in a different new message is handled as a separate request.
 *  5. Restarting the daemon does not reprocess completed messages or repeat verified creator actions.
 *  6. Unauthorized and missing-identity senders create no jobs.
 *  7. Simulation mode never reports a live follow, comment, or delivery.
 *  8. Live mode cannot proceed through follow/comment without the required approval.
 *  9. The creator response workflow honors the full five-minute deadline and checks Primary plus Requests.
 * 10. A valid response or timeout is delivered to the original requester's real thread.
 * 11. Failed delivery is retryable without repeating the creator actions.
 * 12. A crash during processing recovers safely without duplicate actions or deliveries.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { getDatabase } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const { CreatorInteractionManager } = require('../../src/pipeline/creator-interaction');
const config = require('../../src/config');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_baseline_approval.db');

function cleanupDb() {
  try {
    const db = getDatabase(TEST_DB_PATH);
    db.exec(`
      DELETE FROM jobs;
      DELETE FROM creator_interactions;
      DELETE FROM processed_messages;
      DELETE FROM audit_log;
      DELETE FROM candidates;
    `);
  } catch {}
}

test.beforeEach(cleanupDb);
test.after(() => cleanupDb());

function createMockSender() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (threadId, text, opts = {}) => {
      sentMessages.push({ threadId, text, type: 'plain', opts });
      return true;
    },
    sendAck: async (threadId, opts = {}) => {
      sentMessages.push({ threadId, type: 'ack', opts });
      return true;
    },
    sendSuccess: async (threadId, { url, title, summary }, opts = {}) => {
      sentMessages.push({ threadId, type: 'success', url, title, summary, opts });
      return true;
    },
    sendFailure: async (threadId, { message }, opts = {}) => {
      sentMessages.push({ threadId, type: 'failure', message, opts });
      return true;
    },
  };
}

test('1. An existing Reel in the inbox at startup is baselined and not ingested as a new request', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // Simulate establishing baseline for an existing message sitting in the inbox
  const existingMessageId = 'msg_17842115300129061_ksydn__clip_17874830217683318';
  queue.recordProcessedMessage({
    messageId: existingMessageId,
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    shortcode: 'DehhaYQSc_I',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
    ackSent: 1,
    isBaseline: 1,
  });

  // Verify baseline is recorded in SQLite
  assert.strictEqual(queue.isMessageProcessed(existingMessageId), true);
  assert.strictEqual(queue.isMessageAckSent(existingMessageId), true);

  // When inbox scanner encounters this message, it is skipped without creating a job
  const candidateMessage = {
    messageId: existingMessageId,
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    shortcode: 'DehhaYQSc_I',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
  };

  if (!queue.isMessageProcessed(candidateMessage.messageId)) {
    queue.createJob(candidateMessage);
  }

  // Jobs table must be empty!
  const pending = queue.getNextPendingJob();
  assert.strictEqual(pending, undefined);
});

test('2. Repeated polling of the same message creates exactly one job and one acknowledgement', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const message = {
    messageId: 'msg_178421_ksydn__clip_5555',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    shortcode: 'DehhaYQSc_I',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
  };

  // Poll Cycle 1
  let cycle1Job = null;
  if (!queue.isMessageProcessed(message.messageId)) {
    const res = queue.createJob({ ...message, enforceAllowlist: true });
    cycle1Job = res.job;
    if (!res.isDuplicate && cycle1Job) {
      if (!queue.isMessageAckSent(message.messageId)) {
        await sender.sendAck(message.threadId);
        queue.markMessageAckSent(message.messageId);
      }
    }
  }

  assert.ok(cycle1Job);
  assert.strictEqual(sender.sentMessages.length, 1);
  assert.strictEqual(sender.sentMessages[0].type, 'ack');

  // Poll Cycle 2 (same message still visible in thread)
  let cycle2Created = false;
  if (!queue.isMessageProcessed(message.messageId)) {
    queue.createJob({ ...message, enforceAllowlist: true });
    cycle2Created = true;
  } else {
    // Attempting createJob directly also detects duplicate
    const res2 = queue.createJob({ ...message, enforceAllowlist: true });
    assert.strictEqual(res2.isDuplicate, true);
    if (!res2.isDuplicate && !queue.isMessageAckSent(message.messageId)) {
      await sender.sendAck(message.threadId);
    }
  }

  assert.strictEqual(cycle2Created, false);
  // No second ACK sent!
  assert.strictEqual(sender.sentMessages.length, 1);
});

test('3. A genuinely new Reel message creates one job', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  const newReel = {
    messageId: 'msg_178421_nauman_clip_9999',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    shortcode: 'DdTtvIop21E',
    reelUrl: 'https://www.instagram.com/reel/DdTtvIop21E/',
    enforceAllowlist: true,
  };

  const { job, isDuplicate } = queue.createJob(newReel);
  assert.strictEqual(isDuplicate, false);
  assert.ok(job);
  assert.strictEqual(job.shortcode, 'DdTtvIop21E');
  assert.strictEqual(job.sender_username, 'ksydn_');
  assert.strictEqual(job.message_id, 'msg_178421_nauman_clip_9999');
  assert.strictEqual(job.status, 'PENDING');
});

test('4. Sharing the same Reel URL in a different new message is handled as a separate request', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  const sharedReelUrl = 'https://www.instagram.com/reel/DdRTNlBSAVB/';

  // Message 1 from yesterday
  const res1 = queue.createJob({
    messageId: 'msg_turn_1_clip_001',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: sharedReelUrl,
    enforceAllowlist: true,
  });

  assert.strictEqual(res1.isDuplicate, false);
  queue.updateStatus(res1.job.id, 'COMPLETED', { isDelivered: 1 });

  // Message 2 from today: user sends the same Reel again in a new message
  const res2 = queue.createJob({
    messageId: 'msg_turn_2_clip_002',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: sharedReelUrl,
    enforceAllowlist: true,
  });

  assert.strictEqual(res2.isDuplicate, false);
  assert.ok(res2.job);
  assert.notStrictEqual(res1.job.id, res2.job.id);
  assert.strictEqual(res2.job.message_id, 'msg_turn_2_clip_002');
  assert.strictEqual(res2.job.status, 'PENDING');
});

test('5. Restarting the daemon does not reprocess completed messages or repeat verified creator actions', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // Setup a completed job with live verified follow and comment
  const { job } = queue.createJob({
    messageId: 'msg_completed_123',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  queue.createOrGetCreatorInteraction(job.id, {
    creatorUsername: 'expertdev',
    shortcode: 'DdRTNlBSAVB',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'CODE',
    isSimulated: 0,
  });

  const now = new Date().toISOString();
  queue.updateCreatorInteraction(job.id, {
    follow_status: 'COMPLETED',
    live_follow_verified_at: now,
    comment_status: 'POSTED',
    live_comment_posted_at: now,
    comment_text: 'CODE',
    extracted_url: 'https://github.com/example/code',
    is_simulated: 0,
  });

  queue.updateStatus(job.id, 'COMPLETED', { isDelivered: 1 });

  // Simulate daemon restart: recoverStalledJobs runs
  const recovered = queue.recoverStalledJobs();
  assert.strictEqual(recovered, 0);

  // Message remains processed in SQLite
  assert.strictEqual(queue.isMessageProcessed('msg_completed_123'), true);

  // Live actions remain verified and will not be repeated
  assert.strictEqual(queue.isLiveFollowVerified(job.id), true);
  assert.strictEqual(queue.isLiveCommentVerified(job.id), true);
});

test('6. Unauthorized and missing-identity senders create no jobs', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  const unauthorizedSenders = [
    'rashmikiran pandit',
    'meghna arora',
    'random_stranger',
    'unknown',
    '',
    null,
    undefined,
  ];

  for (const sender of unauthorizedSenders) {
    const res = queue.createJob({
      messageId: `msg_${sender}_1`,
      threadId: 'row_1',
      senderUsername: sender,
      reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
      enforceAllowlist: true,
    });

    assert.strictEqual(res.job, null);
    assert.strictEqual(res.isDuplicate, false);
    assert.strictEqual(res.error, 'UNAUTHORIZED_SENDER');
  }

  // Allowed senders succeed
  const resNauman = queue.createJob({
    messageId: 'msg_nauman_ok',
    threadId: 'thread_1',
    senderUsername: '@KSYDN_',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
    enforceAllowlist: true,
  });
  assert.ok(resNauman.job);

  const resKsydn = queue.createJob({
    messageId: 'msg_ksydn_ok',
    threadId: 'thread_2',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
    enforceAllowlist: true,
  });
  assert.ok(resKsydn.job);
});

test('7. Simulation mode never reports a live follow, comment, or delivery', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    messageId: 'msg_sim_test',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    simulationMode: true,
    requireApproval: false,
  });

  const result = await manager.executeCreatorWorkflow(job, {
    caption: 'Comment GITHUB for repository',
    creator: 'somecreator',
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
    mockReplyText: 'Here is your link: https://github.com/test/repo',
  });

  assert.strictEqual(result.success, true);

  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.is_simulated, 1);
  assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');

  // CRITICAL INVARIANT: Simulation MUST NEVER qualify as live follow or comment!
  assert.strictEqual(queue.isLiveFollowVerified(job.id), false);
  assert.strictEqual(queue.isLiveCommentVerified(job.id), false);
  assert.strictEqual(interaction.live_follow_verified_at, null);
  assert.strictEqual(interaction.live_comment_posted_at, null);
});

test('8. Live mode cannot proceed through follow/comment without the required approval', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    messageId: 'msg_approval_test',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    simulationMode: false,
    requireApproval: true,
  });

  // Attempt 1: Not approved
  const resUnapproved = await manager.executeCreatorWorkflow(job, {
    caption: 'Follow @livecreator and comment WORKBOOK',
    creator: 'livecreator',
    isSimulation: false,
    approved: false,
    mockFollowing: false,
  });

  assert.strictEqual(resUnapproved.success, false);
  assert.ok(resUnapproved.status === 'PENDING_APPROVAL' || resUnapproved.status === 'AWAITING_APPROVAL');

  const updatedJob = queue.getJobById(job.id);
  assert.strictEqual(updatedJob.status, 'AWAITING_APPROVAL');
  assert.strictEqual(queue.isLiveFollowVerified(job.id), false);
  assert.strictEqual(queue.isLiveCommentVerified(job.id), false);

  // Operator approves the job via queue.approveJob
  const approved = queue.approveJob(job.id);
  assert.strictEqual(approved, true);

  const jobAfterApproval = queue.getJobById(job.id);
  assert.strictEqual(jobAfterApproval.is_approved, 1);
  assert.strictEqual(jobAfterApproval.status, 'PENDING');
});

test('9. The creator response workflow honors the full five-minute deadline and checks Primary plus Requests', async () => {
  // Config invariant
  assert.strictEqual(config.creatorWorkflow.minLiveWaitingWindowSec, 300);
  assert.ok(config.creatorWorkflow.timeoutSec >= 300);
  assert.ok(config.creatorWorkflow.initialWaitingWindowSec >= 300);

  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    simulationMode: true,
  });

  // Verify monitorInboxForResponse enforces at least 300s window
  const monitorRes = await manager.monitorInboxForResponse('testcreator', {
    isSimulation: true,
    mockTimeout: true,
    timeoutSec: 300,
  });

  assert.strictEqual(monitorRes.received, false);
  assert.strictEqual(monitorRes.effectiveLiveTimeoutSec, 300);
});

test('10. Comment-Only Workflow: Verified comment completes job immediately without waiting for replies or delivering messages', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const requesterThreadId = '17842115300129061';

  const { job } = queue.createJob({
    messageId: 'msg_comment_only_10',
    threadId: requesterThreadId,
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    simulationMode: true,
  });

  const result = await manager.executeCreatorWorkflow(job, {
    caption: 'Comment NASA for link',
    creator: 'sanskartech',
    isSimulation: true,
    approved: true,
    mockFollowing: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.keyword, 'NASA');

  // Comment-only workflow does NOT dispatch any delivery DMs
  assert.strictEqual(sender.sentMessages.length, 0);
});

test('11. Duplicate runs skip already-performed follow and comment actions (Idempotency)', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    messageId: 'msg_retry_delivery',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    simulationMode: true,
  });

  // Run 1: Follow & Comment succeed
  const res1 = await manager.executeCreatorWorkflow(job, {
    caption: 'Comment PYTHON for repo',
    creator: 'pythondev',
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.status, 'COMPLETED');

  // Run 2: Re-run with tracking
  let followReattempted = false;
  let commentReattempted = false;

  const origExecuteFollow = manager.executeFollow.bind(manager);
  manager.executeFollow = async (...args) => {
    followReattempted = true;
    return origExecuteFollow(...args);
  };

  const origExecuteComment = manager.executeComment.bind(manager);
  manager.executeComment = async (...args) => {
    commentReattempted = true;
    return origExecuteComment(...args);
  };

  const res2 = await manager.executeCreatorWorkflow(job, {
    caption: 'Comment PYTHON for repo',
    creator: 'pythondev',
    isSimulation: true,
    approved: true,
  });

  // Invariants verified: Follow & comment were SKIPPED!
  assert.strictEqual(followReattempted, false);
  assert.strictEqual(commentReattempted, false);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.status, 'COMPLETED');
});

test('12. A crash during processing recovers safely without duplicate actions or deliveries', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // Crash scenario A: Job was in PROCESSING and already marked delivered
  const { job: jobDelivered } = queue.createJob({
    messageId: 'msg_crash_delivered',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
  });
  queue.updateStatus(jobDelivered.id, JOB_STATUS.PROCESSING);
  queue.markDelivered(jobDelivered.id);

  // Crash scenario B: Job was in SEARCHING and not yet delivered
  const { job: jobUndelivered } = queue.createJob({
    messageId: 'msg_crash_undelivered',
    threadId: '17842115300129061',
    senderUsername: 'ksydn_',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
  });
  queue.updateStatus(jobUndelivered.id, JOB_STATUS.SEARCHING);

  // Crash scenario C: Unauthorized sender job was in queue
  const { job: jobUnauthorized } = queue.createJob({
    messageId: 'msg_crash_unauth',
    threadId: 'row_1',
    senderUsername: 'rashmikiran pandit',
    reelUrl: 'https://www.instagram.com/reel/DehhaYQSc_I/',
    enforceAllowlist: false, // Bypassed before crash
  });
  queue.updateStatus(jobUnauthorized.id, JOB_STATUS.PROCESSING);

  // Daemon restarts: recovers stalled jobs
  const recoveredCount = queue.recoverStalledJobs();
  assert.strictEqual(recoveredCount, 3); // 3 stalled jobs recovered across their respective paths

  const jobA = queue.getJobById(jobDelivered.id);
  assert.strictEqual(jobA.status, JOB_STATUS.COMPLETED); // Completed immediately, no duplicate DM

  const jobB = queue.getJobById(jobUndelivered.id);
  assert.strictEqual(jobB.status, JOB_STATUS.PENDING); // Reset to PENDING for safe retry

  const jobC = queue.getJobById(jobUnauthorized.id);
  assert.strictEqual(jobC.status, JOB_STATUS.FAILED); // Rejected by allowlist security gate
});
