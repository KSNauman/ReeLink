/**
 * Offline Tests for Creator Reply Detection Retirement & Comment-Only Workflow
 * Verifies that creator DM monitoring, reply polling, 5-minute timeout windows,
 * and message forwarding are completely removed from the active execution path.
 * 
 * Safety: 100% Offline. Zero Instagram network or browser calls.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { getDatabase } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const { CreatorInteractionManager } = require('../../src/pipeline/creator-interaction');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_reply_detection.db');

function cleanupDb() {
  try {
    const db = getDatabase(TEST_DB_PATH);
    db.exec('DELETE FROM jobs; DELETE FROM creator_interactions; DELETE FROM audit_log;');
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
      sentMessages.push({ threadId, text, opts });
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

test('Comment-Only Workflow: 1. Verified comment completes job immediately without DM monitoring or delivery', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_101',
    senderUsername: 'student_dev',
    reelUrl: 'https://www.instagram.com/reel/Primary123/',
    shortcode: 'Primary123',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'python_educator',
    caption: 'Comment PYTHON to get the link!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true, 'Workflow should succeed');
  assert.strictEqual(result.stage, 'COMMENT', 'Stage must terminate at COMMENT');
  assert.strictEqual(result.status, 'COMPLETED', 'Job status must be COMPLETED');
  assert.strictEqual(result.keyword, 'PYTHON');

  // Verify ZERO messages delivered to user thread (resource delivery is retired)
  assert.strictEqual(sender.sentMessages.length, 0, 'No delivery messages sent to requester');

  // Verify database record
  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');
});

test('Comment-Only Workflow: 2. Captions without keywords fallback to 🙌 and complete at comment step', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_202',
    senderUsername: 'cloud_builder',
    reelUrl: 'https://www.instagram.com/reel/Requests456/',
    shortcode: 'Requests456',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'cloud_architect',
    caption: 'Check out this awesome cloud architecture setup!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.keyword, '🙌', 'Fallback to 🙌 when no keyword detected');

  assert.strictEqual(sender.sentMessages.length, 0);
  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.comment_text, '🙌');
});

test('Comment-Only Workflow: 3. No plain text DM forwarding occurs on verified comment', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_303',
    senderUsername: 'curious_user',
    reelUrl: 'https://www.instagram.com/reel/NoUrl789/',
    shortcode: 'NoUrl789',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'vague_influencer',
    caption: 'Comment PYTHON to get the link!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.status, 'COMPLETED');

  // Exactly 0 messages delivered to user thread (forwarding retired)
  assert.strictEqual(sender.sentMessages.length, 0);

  const updatedJob = queue.getJob(job.id);
  assert.strictEqual(updatedJob.status, 'COMPLETED');
});

test('Comment-Only Workflow: 4. Duplicate processing triggers idempotency guards and skips repeat comment', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_404',
    senderUsername: 'test_dev',
    reelUrl: 'https://www.instagram.com/reel/Idempotent888/',
    shortcode: 'Idempotent888',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    },
  });

  // Run 1: Completes successfully
  const result1 = await manager.executeCreatorWorkflow(job, {
    creator: 'senior_dev',
    caption: 'Comment CODE to get the repository!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result1.success, true);
  assert.strictEqual(result1.status, 'COMPLETED');

  // Track if comment method is called again
  let commentReattempted = false;
  manager.executeComment = async () => {
    commentReattempted = true;
    return { success: true };
  };

  // Run 2: Re-executing workflow on the same job
  const result2 = await manager.executeCreatorWorkflow(job, {
    creator: 'senior_dev',
    caption: 'Comment CODE to get the repository!',
    isSimulation: true,
    approved: true,
  });

  assert.strictEqual(result2.success, true);
  assert.strictEqual(commentReattempted, false, 'Comment must not be re-attempted on completed job');

  // Verify only 1 creator interaction record exists for this job in the DB
  const count = db.prepare('SELECT COUNT(*) as c FROM creator_interactions WHERE job_id = ?').get(job.id).c;
  assert.strictEqual(count, 1, 'Duplicate records must not be created');
});

test('Comment-Only Workflow: 5. 5-minute waiting windows and timeouts are retired from active path', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_505',
    senderUsername: 'patient_dev',
    reelUrl: 'https://www.instagram.com/reel/Timeout999/',
    shortcode: 'Timeout999',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'unresponsive_creator',
    caption: 'Comment SECRET to get the link!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  // Job finishes immediately without timing out or waiting
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(sender.sentMessages.length, 0);

  const updatedJob = queue.getJob(job.id);
  assert.strictEqual(updatedJob.status, 'COMPLETED');
});

test('Comment-Only Workflow: 6. resumeWaitingJobs is a safe no-op that does not process or resume dormant jobs', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_707',
    senderUsername: 'restart_test_user',
    reelUrl: 'https://www.instagram.com/reel/Restart707/',
    shortcode: 'Restart707',
  });

  // Pre-seed an interaction where follow was COMPLETED and comment was POSTED
  queue.updateStatus(job.id, 'WAITING_FOR_REPLY');
  queue.createOrGetCreatorInteraction(job.id, {
    creatorUsername: 'awesome_creator',
    shortcode: 'Restart707',
    requiresFollow: 1,
    requiresComment: 1,
    keyword: 'AWESOME',
    isSimulated: 1,
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    },
  });

  // Call resumeWaitingJobs
  const resumeResult = await manager.resumeWaitingJobs({
    isSimulation: true,
  });

  assert.strictEqual(resumeResult.checked, 0);
  assert.strictEqual(resumeResult.resolved, 0);
  assert.strictEqual(resumeResult.waiting, 0);
  assert.strictEqual(resumeResult.reviewNeeded, 0);
  assert.strictEqual(sender.sentMessages.length, 0, 'No messages dispatched');
});

test('Comment-Only Workflow: 7. Follow and comment actions respect approval controls', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'requester_thread_approval',
    senderUsername: 'student_dev',
    reelUrl: 'https://www.instagram.com/reel/Approval123/',
    shortcode: 'Approval123',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: {
      enabled: true,
      simulationMode: false,
      requireApproval: true,
    },
  });

  // Unapproved call must be blocked
  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'safety_creator',
    caption: 'Comment SAFETY for guide!',
    isSimulation: false,
    approved: false, // NOT approved
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.status, 'PENDING_APPROVAL');
});
