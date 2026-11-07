const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const { CreatorInteractionManager } = require('../../src/pipeline/creator-interaction');
const InstagramSender = require('../../src/instagram/sender');

test('Simulation Fidelity: Simulation mode NEVER touches browser page (0 Playwright DOM interactions)', async () => {
  const testDb = path.resolve(__dirname, '../../data/test_sim_fidelity.db');
  if (fs.existsSync(testDb)) {
    try { fs.unlinkSync(testDb); } catch {}
  }
  const db = new Database(testDb);
  const queue = new JobQueue(db);

  let pageInteractions = 0;
  // A browser session mock that fails if any DOM page is requested
  const strictBrowserSession = {
    getPage: async () => {
      pageInteractions++;
      throw new Error('FATAL: Browser page was accessed during simulation mode!');
    },
  };

  const sender = new InstagramSender(strictBrowserSession, { dryRun: true });

  const manager = new CreatorInteractionManager({
    queue,
    browserSession: strictBrowserSession,
    inbox: null,
    sender,
    configOptions: {
      enabled: false, // Live mode disabled
      simulationMode: true, // Simulation active
      requireApproval: false,
      allowFollow: true,
      timeoutSec: 5,
    },
  });

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_audit_1',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/SimSafety123/',
      shortcode: 'SimSafety123',
    });

    const caption = `Want the code? 
1. Follow @test_dev
2. Comment "REACT" below for the repository!`;

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'test_dev',
      isSimulation: true,
      approved: true,
      mockFollowing: false,
      mockFollowSuccess: true,
      mockCommentSuccess: true,
      mockReplyText: 'Here is the link: https://github.com/facebook/react',
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.stage, 'COMMENT');
    assert.strictEqual(result.keyword, 'REACT');

    // Verify that strictly 0 browser page calls were made
    assert.strictEqual(pageInteractions, 0, 'Simulation mode must never access browser DOM page');
  } finally {
    db.close();
    try { fs.unlinkSync(testDb); } catch {}
  }
});

test('Simulation Fidelity: InstagramSender with isSimulation=true suppresses real DM dispatch', async () => {
  let browserPageRequested = false;
  const mockSession = {
    getPage: async () => {
      browserPageRequested = true;
      throw new Error('Should not be called in simulation!');
    },
  };

  // Even if dryRun is false, isSimulation flag must suppress DOM access
  const sender = new InstagramSender(mockSession, { dryRun: false });

  const result = await sender.sendMessage('thread_test', 'Test message', { isSimulation: true });
  assert.strictEqual(result, true);
  assert.strictEqual(browserPageRequested, false, 'sendMessage with isSimulation=true must not touch DOM');
});

test('State Transition Audit: AWAITING_APPROVAL and NEEDS_REVIEW persist in DB without premature completion', async () => {
  const testDb = path.resolve(__dirname, '../../data/test_state_persist.db');
  if (fs.existsSync(testDb)) {
    try { fs.unlinkSync(testDb); } catch {}
  }
  const db = new Database(testDb);
  const queue = new JobQueue(db);

  const manager = new CreatorInteractionManager({
    queue,
    browserSession: null,
    inbox: null,
    sender: null,
    configOptions: {
      enabled: false,
      simulationMode: true,
      requireApproval: true, // Requires approval
    },
  });

  try {
    const { job } = queue.createJob({
      threadId: 'user_thread_audit_2',
      senderUsername: 'test_student',
      reelUrl: 'https://www.instagram.com/reel/ApprovalAudit999/',
      shortcode: 'ApprovalAudit999',
    });

    const caption = 'Follow @expert and comment DATA for the sheet!';

    const result = await manager.executeCreatorWorkflow(job, {
      caption,
      creator: 'expert',
      isSimulation: true,
      approved: false, // Not approved
    });

    assert.strictEqual(result.status, 'PENDING_APPROVAL');

    // Verify status in DB is strictly AWAITING_APPROVAL, NOT completed or failed
    const freshJob = queue.getJobById(job.id);
    assert.strictEqual(freshJob.status, 'AWAITING_APPROVAL');
    assert.strictEqual(freshJob.is_delivered, 0);

    const interaction = queue.getCreatorInteraction(job.id);
    assert.strictEqual(interaction.simulated_follow_status, 'PENDING_APPROVAL');
    assert.strictEqual(interaction.simulated_comment_status, 'NOT_ATTEMPTED');
    assert.strictEqual(interaction.follow_status, 'NOT_ATTEMPTED');
    assert.strictEqual(interaction.comment_status, 'NOT_ATTEMPTED');
  } finally {
    db.close();
    try { fs.unlinkSync(testDb); } catch {}
  }
});
