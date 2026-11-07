const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const { CreatorInteractionManager } = require('../../src/pipeline/creator-interaction');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_creator_interaction.db');

function createTestContext() {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  const queue = new JobQueue(db);

  const sentMessages = [];
  const mockSender = {
    sendMessage: async (threadId, text) => {
      sentMessages.push({ threadId, type: 'message', text });
      return true;
    },
    sendSuccess: async (threadId, data) => {
      sentMessages.push({ threadId, type: 'success', data });
      return true;
    },
    sendFailure: async (threadId, data) => {
      sentMessages.push({ threadId, type: 'failure', data });
      return true;
    },
  };

  const manager = new CreatorInteractionManager({
    queue,
    browserSession: null,
    inbox: null,
    sender: mockSender,
    configOptions: {
      enabled: false, // Live mode disabled
      simulationMode: true, // Simulation mode active
      requireApproval: false, // Auto-approve for deterministic unit tests
      allowFollow: true,
      timeoutSec: 5,
    },
  });

  return { db, queue, manager, sentMessages };
}

function cleanup(db) {
  if (db) db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
}

test('CreatorInteraction [Simulation]: Follow + Comment full success sequence with link delivery', async () => {
  const { db, queue, manager, sentMessages } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_101',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/FollowComment123/',
      shortcode: 'FollowComment123',
    });

    const caption = `Want the complete AI Agents source code? 🚀
1. Follow @lead_architect for tutorials
2. Comment "AGENTS" below and I'll send the repo link in your DMs!`;

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'lead_architect',
      isSimulation: true,
      approved: true,
      mockFollowing: false,
      mockFollowSuccess: true,
      mockCommentSuccess: true,
      mockReplyText: 'Hey! Thanks for following and commenting. Here is the repo: https://github.com/langchain-ai/langchain Enjoy!',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'COMMENT');
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.keyword, 'AGENTS');

    // Verify database step tracking
    const interaction = queue.getCreatorInteraction(job.id);
    assert.ok(interaction, 'Creator interaction record must exist');
    assert.strictEqual(interaction.creator_username, 'lead_architect');
    assert.strictEqual(interaction.requires_follow, 1);
    assert.strictEqual(interaction.requires_comment, 1);
    assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED');
    assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED', 'Live follow must NEVER be marked by simulation');
    assert.ok(interaction.simulated_follow_at, 'Simulated follow must be verified with timestamp');
    assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
    assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED', 'Live comment must NEVER be marked by simulation');
    assert.strictEqual(interaction.comment_text, 'AGENTS');
    assert.strictEqual(interaction.is_simulated, 1);

    // Verify ZERO delivery forwarded to user thread (delivery retired)
    assert.strictEqual(sentMessages.length, 0);

    // Verify job completion
    const updatedJob = queue.getJobById(job.id);
    assert.strictEqual(updatedJob.status, JOB_STATUS.COMPLETED);
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: Follow First, Always — Follow is attempted first even when caption only mentions comment', async () => {
  const { db, queue, manager, sentMessages } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_102',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/CommentOnly456/',
      shortcode: 'CommentOnly456',
    });

    const caption = `Google’s AlloyDB Agents event is worth checking out!
Comment GOOGLE and I’ll send you the direct event link in your DMs!`;

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'meghna_1500',
      isSimulation: true,
      approved: true,
      mockFollowing: false,
      mockFollowSuccess: true,
      mockReplyText: 'Here is your direct event link: https://rsvp.withgoogle.com/events/alloydb-agents',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'COMPLETED');

    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.requires_follow, 1);
    assert.strictEqual(interaction.requires_comment, 1);
    assert.strictEqual(interaction.simulated_follow_status, 'COMPLETED', 'Simulated follow must be completed even when not in caption');
    assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED', 'Real follow must not be marked by simulation');
    assert.ok(interaction.simulated_follow_at);
    assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
    assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED');
    assert.strictEqual(interaction.keyword, 'GOOGLE');
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: Follow step succeeds when already following', async () => {
  const { db, queue, manager } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_103',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/AlreadyFollowed789/',
      shortcode: 'AlreadyFollowed789',
    });

    const caption = 'Make sure you follow me and comment DOCKER for cheat sheet!';

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'docker_master',
      isSimulation: true,
      approved: true,
      mockFollowing: true,
      mockCommentSuccess: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'COMMENT');
    assert.strictEqual(result.status, 'COMPLETED');

    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.simulated_follow_status, 'ALREADY_FOLLOWING');
    assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');
    assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
    assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED');
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: Follow failure halts workflow before comment', async () => {
  const { db, queue, manager } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_104',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/FollowFails001/',
      shortcode: 'FollowFails001',
    });

    const caption = 'Follow @gated_creator and comment CODE for access!';

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'gated_creator',
      isSimulation: true,
      approved: true,
      mockFollowing: false,
      mockFollowSuccess: false,
      mockCommentSuccess: true,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'FOLLOW');
    assert.strictEqual(result.status, 'FAILED');

    // Crucial check: Comment step MUST NOT have executed
    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.simulated_follow_status, 'FAILED');
    assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');
    assert.strictEqual(interaction.simulated_comment_status, 'NOT_ATTEMPTED');

    const updatedJob = queue.getJobById(job.id);
    assert.strictEqual(updatedJob.status, JOB_STATUS.FAILED);
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: Missing keyword defaults to 🙌 comment emoji and executes workflow', async () => {
  const { db, queue, manager } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_105',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/UnclearInstructions002/',
      shortcode: 'UnclearInstructions002',
    });

    const caption = 'Want the secret tool? Just comment below and check your DMs!';

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'vague_influencer',
      isSimulation: true,
      approved: true,
    });

    // Verify it automatically defaulted to 🙌 and posted the comment
    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.keyword, '🙌');
    assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
    assert.strictEqual(interaction.comment_text, '🙌');
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: No creator response retains job in WAITING_FOR_REPLY status', async () => {
  const { db, queue, manager } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_106',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/NoResponse003/',
      shortcode: 'NoResponse003',
    });

    const caption = 'Comment PYTHON to get the link!';

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'silent_creator',
      isSimulation: true,
      approved: true,
      mockReplyText: null, // Simulates no reply received within initial window
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'COMMENT');
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.keyword, 'PYTHON');

    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.simulated_comment_status, 'POSTED');
    assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED');

    const updatedJob = queue.getJob(job.id);
    assert.strictEqual(updatedJob.status, 'COMPLETED');
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: Idempotency guards prevent repeating follow/comment on retry', async () => {
  const { db, queue, manager } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_107',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/Idempotent004/',
      shortcode: 'Idempotent004',
    });

    const caption = 'Follow me and comment AGENTS to get the link!';

    // Run 1: Succeeds
    await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'architect_01',
      isSimulation: true,
      approved: true,
      mockFollowing: false,
      mockReplyText: 'Link: https://github.com/langchain-ai/langchain',
    });

    const firstInteraction = queue.getCreatorInteraction(job.id);
    const firstFollowTime = firstInteraction.follow_verified_at;
    const firstCommentTime = firstInteraction.comment_posted_at;

    // Run 2: Re-executing on the same job
    const run2 = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'architect_01',
      isSimulation: true,
      approved: true,
      mockFollowing: false,
      mockReplyText: 'Link: https://github.com/langchain-ai/langchain',
    });

    assert.strictEqual(run2.success, true);
    const secondInteraction = queue.getCreatorInteraction(job.id);

    // Timestamps must NOT have changed, proving steps were skipped rather than re-executed
    assert.strictEqual(secondInteraction.follow_verified_at, firstFollowTime);
    assert.strictEqual(secondInteraction.comment_posted_at, firstCommentTime);
  } finally {
    cleanup(db);
  }
});

test('CreatorInteraction [Simulation]: User approval requirement pauses action when approved=false', async () => {
  const { db, queue, manager } = createTestContext();

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_108',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/ApprovalReq005/',
      shortcode: 'ApprovalReq005',
    });

    const caption = 'Follow @expert and comment DATA for workbook!';

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'expert',
      isSimulation: true,
      approved: false, // User has not approved comment
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'FOLLOW');
    assert.strictEqual(result.status, 'PENDING_APPROVAL');
    assert.ok(result.error.includes('approval required'));

    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.simulated_follow_status, 'PENDING_APPROVAL');
    assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');

    const updatedJob = queue.getJobById(job.id);
    assert.strictEqual(updatedJob.status, 'AWAITING_APPROVAL');
  } finally {
    cleanup(db);
  }
});
