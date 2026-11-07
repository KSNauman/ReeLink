const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const { ReelLinkWebServer } = require('../../src/web/server');
const InstagramInbox = require('../../src/instagram/inbox');

function createTestDb(testName) {
  const dbDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test_unfollow_${testName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.db`);
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

function seedJob(queue, shortcode) {
  const { job } = queue.createJob({
    threadId: 'thread_1',
    senderUsername: 'nauman',
    reelUrl: `https://instagram.com/reel/${shortcode}/`,
    shortcode,
    messageId: `msg_${shortcode}_${Math.random()}`,
  });
  return job;
}

describe('2-Day Retention Unfollow Manager Tests', () => {
  let dbObj;
  let queue;
  let testPort = 4280;

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

  test('JobQueue: getFollowedCreatorsForUnfollow correctly segments eligible (>48h) and protected (<48h) creators', () => {
    // Seed parent jobs
    const job1 = seedJob(queue, 'CODE1');
    const job2 = seedJob(queue, 'CODE2');

    // 1. Insert Creator A: followed 3 days ago (72 hours ago)
    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('int_1', job1.id, 'old_creator', 'CODE1', 'COMPLETED', threeDaysAgo, threeDaysAgo, threeDaysAgo);

    // 2. Insert Creator B: followed 4 hours ago
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('int_2', job2.id, 'recent_creator', 'CODE2', 'COMPLETED', fourHoursAgo, fourHoursAgo, fourHoursAgo);

    const result = queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 });

    assert.strictEqual(result.all.length, 2, 'Should detect 2 followed creators');
    assert.strictEqual(result.eligible.length, 1, 'Only 1 creator should be eligible (>48h)');
    assert.strictEqual(result.protected.length, 1, '1 creator should be protected (<48h)');

    assert.strictEqual(result.eligible[0].creator, 'old_creator');
    assert.strictEqual(result.eligible[0].isEligible, true);
    assert.ok(result.eligible[0].ageHours >= 71);

    assert.strictEqual(result.protected[0].creator, 'recent_creator');
    assert.strictEqual(result.protected[0].isEligible, false);
    assert.ok(result.protected[0].remainingHours > 40);
  });

  test('Web Server: POST /api/unfollow respects 2-day protection unless forceAll is specified', async () => {
    const job1 = seedJob(queue, 'CODE1');
    const job2 = seedJob(queue, 'CODE2');

    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('int_1', job1.id, 'senior_creator', 'CODE1', 'COMPLETED', threeDaysAgo, threeDaysAgo, threeDaysAgo);

    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('int_2', job2.id, 'fresh_creator', 'CODE2', 'COMPLETED', oneHourAgo, oneHourAgo, oneHourAgo);

    const unfollowedList = [];
    const mockApp = {
      queue,
      isBatchRunning: false,
      isLiveMode: false,
      _addLog: () => {},
      inbox: {
        unfollowCreatorDirect: async (creator) => {
          unfollowedList.push(creator);
          return { success: true, creator };
        }
      }
    };

    const server = new ReelLinkWebServer({ app: mockApp, queue, port: testPort });
    await server.start();

    try {
      // 1. Standard unfollow: should only target eligible creator (>48h)
      const res1 = await httpRequest({
        hostname: 'localhost',
        port: testPort,
        path: '/api/unfollow',
        method: 'POST',
      }, JSON.stringify({ forceAll: false }));

      assert.strictEqual(res1.statusCode, 200);
      const json1 = JSON.parse(res1.body);
      assert.strictEqual(json1.success, true);
      assert.strictEqual(json1.count, 1);
      assert.deepStrictEqual(json1.unfollowed, ['senior_creator']);
      assert.strictEqual(json1.protectedCount, 1);

      // Verify DB marked senior_creator as UNFOLLOWED
      const updatedOverview = queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 });
      assert.strictEqual(updatedOverview.all.length, 1);
      assert.strictEqual(updatedOverview.all[0].creator, 'fresh_creator');

      // 2. Force unfollow: should target remaining protected creator
      const res2 = await httpRequest({
        hostname: 'localhost',
        port: testPort,
        path: '/api/unfollow',
        method: 'POST',
      }, JSON.stringify({ forceAll: true }));

      assert.strictEqual(res2.statusCode, 200);
      const json2 = JSON.parse(res2.body);
      assert.strictEqual(json2.success, true);
      assert.strictEqual(json2.count, 1);
      assert.deepStrictEqual(json2.unfollowed, ['fresh_creator']);

      // Now all creators are unfollowed
      const finalOverview = queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 });
      assert.strictEqual(finalOverview.all.length, 0);
    } finally {
      await server.close();
    }
  });

  test('Inbox: /unfollow command displays 2-day protection breakdown and confirmation executes safely', async () => {
    const job1 = seedJob(queue, 'CODE1');
    const job2 = seedJob(queue, 'CODE2');

    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('int_1', job1.id, 'eligible_user', 'CODE1', 'COMPLETED', threeDaysAgo, threeDaysAgo, threeDaysAgo);

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('int_2', job2.id, 'protected_user', 'CODE2', 'COMPLETED', twoHoursAgo, twoHoursAgo, twoHoursAgo);

    const deliveredDMs = [];
    const mockSender = {
      sendMessage: async (threadId, text) => {
        deliveredDMs.push({ threadId, text });
        return true;
      }
    };

    const inbox = new InstagramInbox(null, { queue, sender: mockSender, isLiveMode: false });

    // Step 1: Preview command
    await inbox.handleBotCommand('unfollow', 'thread_auth', 'nauman', 'msg_unf_1');
    assert.strictEqual(deliveredDMs.length, 1);
    const previewMsg = deliveredDMs[0].text;
    assert.match(previewMsg, /Eligible for Unfollow/i);
    assert.match(previewMsg, /eligible_user/);
    assert.match(previewMsg, /Protected \(<2 days retention/i);
    assert.match(previewMsg, /protected_user/);

    // Step 2: Confirmed unfollow (default targets only eligible)
    deliveredDMs.length = 0;
    await inbox.handleBotCommand('unfollow', 'thread_auth', 'nauman', 'msg_unf_2', 'confirm');
    assert.ok(deliveredDMs.length >= 1);
    const executeMsg = deliveredDMs[deliveredDMs.length - 1].text;
    assert.match(executeMsg, /Unfollow Complete/i);
    assert.match(executeMsg, /Successfully unfollowed \(1\):\s+- @eligible_user/);
    assert.match(executeMsg, /Retained under 2-day protection \(1\):\s+- @protected_user/);

    // Verify DB state
    const overview = queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 });
    assert.strictEqual(overview.all.length, 1);
    assert.strictEqual(overview.all[0].creator, 'protected_user');
  });
});
