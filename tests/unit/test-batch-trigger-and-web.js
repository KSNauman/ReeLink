const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const { ReelLinkWebServer } = require('../../src/web/server');
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

function httpRequest(options, postData = '') {
  return new Promise((resolve, reject) => {
    const headers = {
      ...(options.headers || {}),
      'Content-Length': Buffer.byteLength(postData),
    };
    const req = http.request({ ...options, headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

describe('ReelLink Batch Trigger and Web Dashboard Tests', () => {
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

  test('Web Dashboard: Serves HTML UI on GET /', async () => {
    const webServer = new ReelLinkWebServer({ queue, port: testPort });
    await webServer.start();

    try {
      const res = await httpRequest({
        hostname: 'localhost',
        port: testPort,
        path: '/',
        method: 'GET',
      });

      assert.strictEqual(res.statusCode, 200);
      assert.match(res.body, /ReelLink/);
      assert.match(res.body, /START BATCH/);
      assert.match(res.body, /Recent Processed Reels/);
    } finally {
      await webServer.close();
    }
  });

  test('Web Dashboard: Returns status JSON on GET /api/status', async () => {
    // Insert test job
    queue.createJob({
      threadId: 'test_thread_1',
      senderUsername: 'nauman',
      reelUrl: 'https://instagram.com/reel/TestCode01/',
      shortcode: 'TestCode01',
      messageId: 'msg_001',
    });

    const webServer = new ReelLinkWebServer({ queue, port: testPort });
    await webServer.start();

    try {
      const res = await httpRequest({
        hostname: 'localhost',
        port: testPort,
        path: '/api/status',
        method: 'GET',
      });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.status, 'IDLE');
      assert.strictEqual(data.queue.pending, 1);
      assert.strictEqual(data.recentJobs.length, 1);
      assert.strictEqual(data.recentJobs[0].shortcode, 'TestCode01');
    } finally {
      await webServer.close();
    }
  });

  test('Web Dashboard: POST /api/start initiates batch and rejects concurrent start', async () => {
    let batchStarted = false;
    const mockApp = {
      queue,
      isBatchRunning: false,
      batchStatus: 'IDLE',
      async startBatch() {
        this.isBatchRunning = true;
        this.batchStatus = 'PROCESSING';
        batchStarted = true;
      },
      stopBatch() {
        this.isBatchRunning = false;
        this.batchStatus = 'IDLE';
      }
    };

    const webServer = new ReelLinkWebServer({ app: mockApp, queue, port: testPort });
    await webServer.start();

    try {
      // 1. Initial start should succeed
      const res1 = await httpRequest({
        hostname: 'localhost',
        port: testPort,
        path: '/api/start',
        method: 'POST',
      });
      assert.strictEqual(res1.statusCode, 200);
      const json1 = JSON.parse(res1.body);
      assert.strictEqual(json1.success, true);
      assert.strictEqual(batchStarted, true);

      // 2. Second concurrent start should be rejected with 409
      const res2 = await httpRequest({
        hostname: 'localhost',
        port: testPort,
        path: '/api/start',
        method: 'POST',
      });
      assert.strictEqual(res2.statusCode, 409);
      const json2 = JSON.parse(res2.body);
      assert.strictEqual(json2.success, false);
      assert.match(json2.error, /already in progress/i);
    } finally {
      await webServer.close();
    }
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

    await inbox.handleBotCommand('start', 't1', 'nauman', 'msg_start_1');

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

  test('App: startBatch collects unprocessed Reels and executes sequentially', async () => {
    let processedReels = [];

    const mockInbox = {
      collectUnprocessedReels: async () => {
        const { job: j1 } = queue.createJob({
          threadId: 't1',
          senderUsername: 'nauman',
          reelUrl: 'https://instagram.com/reel/CodeBatch1/',
          shortcode: 'CodeBatch1',
          messageId: 'm1',
        });
        const { job: j2 } = queue.createJob({
          threadId: 't1',
          senderUsername: 'nauman',
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
      enableWeb: false, // Don't start web server in unit test
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
