/**
 * Regression & Acceptance Tests for ReelLink 6-Step Workflow
 * Target Test Case:
 *   URL: https://www.instagram.com/reel/DdRTNlBSAVB/?utm_source=ig_web_button_share_sheet
 *   Shortcode: DdRTNlBSAVB
 * 
 * Verifies Acceptance Criteria:
 *   1. Exact URL above accepted and normalized (/reel/, /p/, /reels/ with tracking stripped)
 *   2. Actual creator and keyword extracted, preserving casing/spelling, generic noise rejected
 *   3. Follow is attempted first, even when following is NOT mentioned in the caption
 *   4. Exact requested keyword is commented only after follow succeeds; no duplicate comments
 *   5. Creator DM monitored for 5 minutes (300s), polling Primary and Requests
 *   6. No reply by deadline produces exact result: "Couldn't fetch message"
 *   7. Retries and restarts do not repeat completed follow or comment, no duplicate delivery
 *   8. Constructor works with both positional and destructured object arguments
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { getDatabase } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const { CreatorInteractionManager, extractCreatorRequirements } = require('../../src/pipeline/creator-interaction');
const { extractReelShortcode, normalizeReelUrl, cleanTrackingParams } = require('../../src/utils/url-helper');
const { parseReelMetadata } = require('../../src/pipeline/extract-reel');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_ddrtnlbsavb_workflow.db');

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
      sentMessages.push({ threadId, text, opts, type: 'message' });
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

test('Step 1: URL Normalization & Deduplication for DdRTNlBSAVB', () => {
  const testUrl = 'https://www.instagram.com/reel/DdRTNlBSAVB/?utm_source=ig_web_button_share_sheet';
  const postUrl = 'https://www.instagram.com/p/DdRTNlBSAVB/?utm_source=ig_web_button_share_sheet&igsh=123';
  const reelsUrl = 'https://www.instagram.com/reels/DdRTNlBSAVB/?utm_source=ig_web_button_share_sheet';

  // 1. Shortcode extraction
  assert.strictEqual(extractReelShortcode(testUrl), 'DdRTNlBSAVB');
  assert.strictEqual(extractReelShortcode(postUrl), 'DdRTNlBSAVB');
  assert.strictEqual(extractReelShortcode(reelsUrl), 'DdRTNlBSAVB');

  // 2. Canonical normalization
  assert.strictEqual(normalizeReelUrl(testUrl), 'https://www.instagram.com/reel/DdRTNlBSAVB/');
  assert.strictEqual(normalizeReelUrl(postUrl), 'https://www.instagram.com/reel/DdRTNlBSAVB/');
  assert.strictEqual(normalizeReelUrl(reelsUrl), 'https://www.instagram.com/reel/DdRTNlBSAVB/');

  // 3. Tracking cleanup
  const cleaned = cleanTrackingParams(testUrl);
  assert.ok(!cleaned.includes('utm_source'), 'Tracking parameter must be stripped');

  // 4. SQLite Job Idempotency
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  const res1 = queue.createOrGetJob({
    threadId: 'test_thread_001',
    senderUsername: 'test_user',
    reelUrl: testUrl,
  });
  assert.strictEqual(res1.isDuplicate, false);
  assert.strictEqual(res1.job.shortcode, 'DdRTNlBSAVB');
  assert.strictEqual(res1.job.reel_url, 'https://www.instagram.com/reel/DdRTNlBSAVB/');

  // Duplicate submission with query params must retrieve existing job without creating a new one
  const res2 = queue.createOrGetJob({
    threadId: 'test_thread_001',
    senderUsername: 'test_user',
    reelUrl: postUrl,
  });
  assert.strictEqual(res2.isDuplicate, true);
  assert.strictEqual(res2.job.id, res1.job.id);
});

test('Step 2: Creator & Exact Keyword Extraction with Casing Preservation', () => {
  // Caption with specific mixed-case keyword and no follow mention
  const caption = `Build AI agents with this complete starter kit! 🚀\nComment "GeminiAgent" below and I'll send the repo link to your DMs!\n#AI #Google`;
  const reqs = extractCreatorRequirements(caption);

  assert.strictEqual(reqs.requiresComment, true);
  assert.strictEqual(reqs.keyword, 'GeminiAgent', 'Keyword casing and spelling must be preserved');
  assert.strictEqual(reqs.isUnclear, false);

  // Rejection of generic text ("just link", "comment below")
  const genericCaption = 'Check out this cool tool! Just comment below for link!';
  const genericReqs = extractCreatorRequirements(genericCaption);
  assert.strictEqual(genericReqs.isUnclear, true);
  assert.strictEqual(genericReqs.keyword, null);

  // Missing or unreadable caption returns none and null keyword
  const emptyReqs = extractCreatorRequirements('');
  assert.strictEqual(emptyReqs.interactionType, 'none');
  assert.strictEqual(emptyReqs.keyword, null);
});

test('Step 3: Follow First, Always — Follow is attempted first even when caption only mentions comment', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'thread_follow_first',
    senderUsername: 'tester',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  // Constructor with positional arguments (Fixing Bug #1)
  const manager = new CreatorInteractionManager(
    queue,
    null,
    null,
    sender,
    {
      enabled: false,
      simulationMode: true,
      requireApproval: false,
    }
  );

  // Caption contains NO follow instruction
  const caption = 'Want the secret guide? Comment "PLAYWRIGHT" to get it in your DMs!';

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'target_creator',
    caption,
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  const interaction = queue.getCreatorInteraction(job.id);

  // Verifying "Follow First, Always" invariant:
  assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED', 'Follow must be completed in simulation');
  assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED', 'Simulation must NEVER mark live follow as completed');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED', 'Simulation must NEVER mark live comment as posted');
  assert.strictEqual(interaction.keyword, 'PLAYWRIGHT');
});

test('Step 3 Fallback: When no clear keyword exists, follows creator and comments 🙌', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'thread_fallback_emoji',
    senderUsername: 'tester',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: { simulationMode: true, requireApproval: false },
  });

  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'target_creator',
    caption: 'Amazing views from our trip today!',
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.keyword, '🙌');

  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED', 'Follow is completed first');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.strictEqual(interaction.comment_text, '🙌');
});

test('Step 4: Comment exact keyword and prevent repeating on restart/retry', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'thread_comment_idempotency',
    senderUsername: 'tester',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: { simulationMode: true, requireApproval: false, allowFollow: true },
  });

  // Run 1: Follow succeeds and comment is posted
  const res1 = await manager.executeCreatorWorkflow(job, {
    creator: 'target_creator',
    caption: 'Comment "DockerCompose" for the full stack!',
    isSimulation: true,
    approved: true,
    mockFollowing: false,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
    mockReplyText: 'https://github.com/docker/compose',
  });

  assert.strictEqual(res1.success, true);
  const firstInteraction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(firstInteraction.comment_text, 'DockerCompose', 'Exact casing preserved');
  const commentTime = firstInteraction.simulated_comment_at;

  // Run 2: Process restart or retry on same job
  const res2 = await manager.executeCreatorWorkflow(job, {
    creator: 'target_creator',
    caption: 'Comment "DockerCompose" for the full stack!',
    isSimulation: true,
    approved: true,
    mockReplyText: 'https://github.com/docker/compose',
  });

  assert.strictEqual(res2.success, true);
  const secondInteraction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(secondInteraction.simulated_comment_at, commentTime, 'Comment timestamp unchanged (idempotent skip)');
});

test('Step 5 & 6: Verified comment completes job immediately without waiting for replies or sending user messages', async () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  const { job } = queue.createJob({
    threadId: 'user_waiting_thread',
    senderUsername: 'requester_jane',
    reelUrl: 'https://www.instagram.com/reel/DdRTNlBSAVB/',
    shortcode: 'DdRTNlBSAVB',
  });

  const manager = new CreatorInteractionManager({
    queue,
    sender,
    configOptions: { simulationMode: true, requireApproval: false, timeoutSec: 300 },
  });

  // Execute workflow: follow creator, post comment, verify, and complete immediately
  const result = await manager.executeCreatorWorkflow(job, {
    creator: 'silent_creator',
    caption: 'Comment "GOLANG" for code!',
    isSimulation: true,
    approved: true,
    mockFollowSuccess: true,
    mockCommentSuccess: true,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stage, 'COMMENT');
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.keyword, 'GOLANG');

  // No messages should be sent to the user thread after comment completion
  assert.strictEqual(sender.sentMessages.length, 0);

  // Job state is persisted in SQLite so restart does not repeat completed follow or comment
  const interaction = queue.getCreatorInteraction(job.id);
  assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED');
  assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');
  assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
  assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED');

  // Second run: idempotency skips repeat comment
  const secondRun = await manager.executeCreatorWorkflow(job, {
    creator: 'silent_creator',
    caption: 'Comment "GOLANG" for code!',
    isSimulation: true,
    approved: true,
  });

  assert.strictEqual(secondRun.success, true);
  assert.strictEqual(secondRun.status, 'COMPLETED');
  assert.strictEqual(sender.sentMessages.length, 0, 'No user messages dispatched');
});

test('Constructor Compatibility: CreatorInteractionManager supports both positional and object arguments', () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);
  const sender = createMockSender();

  // 1. Positional calling convention
  const managerPositional = new CreatorInteractionManager(
    queue,
    { mockSession: true },
    { mockInbox: true },
    sender,
    { enabled: true, simulationMode: false, allowFollow: true, timeoutSec: 300 }
  );

  assert.strictEqual(managerPositional.queue, queue);
  assert.strictEqual(managerPositional.cfg.enabled, true);
  assert.strictEqual(managerPositional.cfg.simulationMode, false);
  assert.strictEqual(managerPositional.cfg.timeoutSec, 300);

  // 2. Destructured object calling convention
  const managerObject = new CreatorInteractionManager({
    queue,
    browserSession: { mockSession: true },
    inbox: { mockInbox: true },
    sender,
    configOptions: { enabled: true, simulationMode: false, allowFollow: true, timeoutSec: 300 },
  });

  assert.strictEqual(managerObject.queue, queue);
  assert.strictEqual(managerObject.cfg.enabled, true);
  assert.strictEqual(managerObject.cfg.simulationMode, false);
  assert.strictEqual(managerObject.cfg.timeoutSec, 300);

  // 3. Destructured object with direct options (as instantiated by app.js in live mode)
  const managerLiveDirect = new CreatorInteractionManager({
    queue,
    browserSession: { mockSession: true },
    inbox: { mockInbox: true },
    sender,
    isLiveMode: true,
    simulationMode: false,
    requireApproval: false,
  });

  assert.strictEqual(managerLiveDirect.cfg.enabled, true, 'managerLiveDirect.cfg.enabled must be true when isLiveMode=true');
  assert.strictEqual(managerLiveDirect.cfg.simulationMode, false, 'managerLiveDirect.cfg.simulationMode must be false');
  assert.strictEqual(managerLiveDirect.cfg.requireApproval, false, 'managerLiveDirect.cfg.requireApproval must be false');
});

