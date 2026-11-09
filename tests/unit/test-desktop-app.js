const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const InstagramInbox = require('../../src/instagram/inbox');
const ReelLinkApp = require('../../src/app');

function createTestDb(testName) {
  const dbDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test_web_${testName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.db`);
  const db = new Database(dbPath);
  return { db, dbPath };
}

function cleanupDb(dbPath) {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
  } catch {}
}

describe('ReelLink Desktop App Core Tests', () => {
  let dbObj;
  let queue;
  let testPort = 3980;

  beforeEach(() => {
    testPort++;
    dbObj = createTestDb(`run_${testPort}`);
    queue = new JobQueue(dbObj.db);
  });

  afterEach(() => {
    try {
      dbObj.db.close();
    } catch {}
    cleanupDb(dbObj.dbPath);
  });

  test('App: getStatus returns queue snapshot for the window', () => {
    queue.createJob({
      threadId: 'test_thread_1',
      senderUsername: 'ksydn_',
      reelUrl: 'https://instagram.com/reel/TestCode01/',
      shortcode: 'TestCode01',
      messageId: 'msg_001',
    });

    const app = new ReelLinkApp({ db: dbObj.db, queue, live: false, browserSession: { close: async () => {} } });
    const data = app.getStatus();

    assert.strictEqual(data.status, 'IDLE');
    assert.strictEqual(data.activeTask, null);
    assert.strictEqual(data.isLiveMode, false);
    assert.strictEqual(data.owner, 'ksydn_');
    assert.strictEqual(data.queue.pending, 1);
    assert.strictEqual(data.recentJobs.length, 1);
    assert.strictEqual(data.recentJobs[0].shortcode, 'TestCode01');
  });

  test('App: a second Start while a batch runs is rejected (one browser task at a time)', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const mockInbox = {
      collectUnprocessedReels: async () => {
        await gate;
        return [];
      },
      unfollowCreatorDirect: async () => ({ success: true }),
    };
    const app = new ReelLinkApp({ db: dbObj.db, queue, inbox: mockInbox, live: false, browserSession: { close: async () => {} } });

    const first = app.startBatch();
    const second = await app.startBatch();
    assert.strictEqual(second.success, false);
    assert.match(second.error, /busy/i);

    const unfollowDuringBatch = await app.unfollow();
    assert.strictEqual(unfollowDuringBatch.success, false, 'unfollow must not run during a batch');

    release();
    const firstResult = await first;
    assert.strictEqual(firstResult.success, true);
    assert.strictEqual(app.activeTask, null);
  });

  test('Inbox: handleBotCommand handles "start" command from authorized user', async () => {
    const deliveredDMs = [];
    let batchCalled = false;
    const mockSender = {
      sendMessage: async (threadId, text) => {
        deliveredDMs.push({ threadId, text });
        return true;
      },
    };
    const mockApp = {
      isBatchRunning: false,
      async startBatch() {
        batchCalled = true;
        return { success: true, processedCount: 2 };
      }
    };

    const inbox = new InstagramInbox(null, { queue, sender: mockSender, app: mockApp });

    await inbox.handleBotCommand('start', 't1', 'ksydn_', 'msg_start_1');

    assert.strictEqual(batchCalled, true, 'startBatch should be called on app');
    assert.ok(deliveredDMs.length >= 1, 'DM should be sent acknowledging start');
    assert.match(deliveredDMs[0].text, /batch started/i);
  });

  test('Inbox: Rejects "start" command from unauthorized sender', async () => {
    const deliveredDMs = [];
    let batchCalled = false;
    const mockSender = {
      sendMessage: async (threadId, text) => {
        deliveredDMs.push({ threadId, text });
        return true;
      },
    };
    const mockApp = {
      isBatchRunning: false,
      async startBatch() {
        batchCalled = true;
      }
    };

    const inbox = new InstagramInbox(null, { queue, sender: mockSender, app: mockApp });

    await inbox.handleBotCommand('start', 't1', 'attacker123', 'msg_start_bad');

    assert.strictEqual(batchCalled, false, 'unauthorized user must not trigger batch');
    assert.strictEqual(deliveredDMs.length, 0, 'no response to unauthorized user');
  });

  test('App: the wait for replies shows a countdown, then collects and delivers', async () => {
    const calls = [];
    const summaries = [];
    const mockInbox = {
      collectUnprocessedReels: async () => {
        queue.createJob({ threadId: 't1', senderUsername: 'ksydn_', reelUrl: 'https://instagram.com/reel/CodeWait1/', shortcode: 'CodeWait1', messageId: 'w1' });
        return [];
      },
    };
    const app = new ReelLinkApp({
      db: dbObj.db,
      queue,
      inbox: mockInbox,
      live: true,
      replyWaitSec: 1,
      browserSession: { close: async () => {} },
      resources: {
        hasOutstanding: () => true,
        collect: async ({ onProgress }) => { calls.push('collect'); onProgress({ creator: 'ana', index: 1, total: 1 }); return { checked: 1, received: 1, needsYou: 0 }; },
        deliver: async () => { calls.push('deliver'); return { csv: null, dmCount: 1, dmFailed: false }; },
      },
    });
    app.processJob = async (job) => queue.updateStatus(job.id, 'COMPLETED');
    app.on('update', () => summaries.push(app.batchProgress.summary));

    const result = await app.startBatch();

    assert.strictEqual(result.processedCount, 1);
    assert.strictEqual(result.failedCount, 0);
    assert.strictEqual(result.linksReceived, 1);
    assert.strictEqual(result.needsYou, 0);
    assert.deepStrictEqual(calls, ['collect', 'deliver']);
    assert.ok(summaries.some(t => /Waiting for creators to reply: \d+s left/.test(t)), 'countdown shown');
    assert.ok(summaries.some(t => t.includes('@ana')), 'each creator shown');
    assert.strictEqual(app.batchStatus, 'COMPLETED');
  });

  test('App: startBatch collects unprocessed Reels and executes sequentially', async () => {
    let processedReels = [];

    const mockInbox = {
      collectUnprocessedReels: async () => {
        const { job: j1 } = queue.createJob({
          threadId: 't1',
          senderUsername: 'ksydn_',
          reelUrl: 'https://instagram.com/reel/CodeBatch1/',
          shortcode: 'CodeBatch1',
          messageId: 'm1',
        });
        const { job: j2 } = queue.createJob({
          threadId: 't1',
          senderUsername: 'ksydn_',
          reelUrl: 'https://instagram.com/reel/CodeBatch2/',
          shortcode: 'CodeBatch2',
          messageId: 'm2',
        });
        return [j1, j2];
      }
    };

    const app = new ReelLinkApp({
      db: dbObj.db,
      queue,
      inbox: mockInbox,
      live: false,
      browserSession: { close: async () => {} },
    });

    // Mock processJob
    app.processJob = async (job) => {
      processedReels.push(job.shortcode);
      queue.updateStatus(job.id, 'COMPLETED');
    };

    const result = await app.startBatch({ triggeredBy: 'UNIT_TEST' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.processedCount, 2);
    assert.deepStrictEqual(processedReels, ['CodeBatch1', 'CodeBatch2']);
    assert.strictEqual(queue.getCompletedJobsCount(), 2);
    assert.strictEqual(queue.getPendingJobsCount(), 0);
    assert.strictEqual(app.batchStatus, 'COMPLETED');
  });
});
