const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const ReelLinkApp = require('../../src/app');
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

function seedJob(queue, shortcode) {
  const { job } = queue.createJob({
    threadId: 'thread_1',
    senderUsername: 'ksydn_',
    reelUrl: `https://instagram.com/reel/${shortcode}/`,
    shortcode,
    messageId: `msg_${shortcode}_${Math.random()}`,
  });
  return job;
}

describe('2-Day Retention Unfollow Manager Tests', () => {
  let dbObj;
  let queue;
  let testPort = 4280; // unique DB suffix per test

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

  function addFollow(id, job, creator, at) {
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (id, job_id, creator_username, shortcode, follow_status, live_follow_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, job.id, creator, job.shortcode, 'COMPLETED', at, at, at);
  }
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  function makeApp(unfollowCreatorDirect, extra = {}) {
    return new ReelLinkApp({
      db: dbObj.db,
      queue,
      live: true,
      replyWaitSec: 0,
      unfollowPauseMs: 0,
      browserSession: { close: async () => {} },
      inbox: { collectUnprocessedReels: async () => [], unfollowCreatorDirect },
      resources: { hasOutstanding: () => false, deliver: async () => ({ csv: null, dmCount: 0, dmFailed: false }) },
      ...extra,
    });
  }

  test('Sharing a new Reel from a creator restarts their 48-hour protection', () => {
    addFollow('a', seedJob(queue, 'OLD1'), 'repeat_creator', hoursAgo(100));
    addFollow('b', seedJob(queue, 'NEW1'), 'repeat_creator', hoursAgo(1));
    const data = queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 });
    assert.strictEqual(data.eligible.length, 0);
    assert.strictEqual(data.protected[0].creator, 'repeat_creator');
  });

  test('Every batch unfollows creators past 48 hours and keeps recent ones', async () => {
    addFollow('a', seedJob(queue, 'A1'), 'old_one', hoursAgo(60));
    addFollow('b', seedJob(queue, 'B1'), 'fresh_one', hoursAgo(2));
    const called = [];
    const app = makeApp(async (c) => { called.push(c); return { success: true }; });

    const result = await app.startBatch();

    assert.deepStrictEqual(called, ['old_one']);
    assert.strictEqual(result.unfollowedCount, 1);
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 }).all.map(c => c.creator), ['fresh_one']);
  });

  test('Auto-unfollow stops after 3 failures in a row and keeps those creators tracked', async () => {
    ['c1', 'c2', 'c3', 'c4', 'c5'].forEach((c, i) => addFollow(`x${i}`, seedJob(queue, `S${i}`), c, hoursAgo(60)));
    let calls = 0;
    const app = makeApp(async () => { calls += 1; return { success: false }; });

    const result = await app.startBatch();

    assert.strictEqual(calls, 3);
    assert.strictEqual(result.unfollowedCount, 0);
    assert.strictEqual(result.success, true, 'unfollow trouble must not fail the batch');
    assert.strictEqual(queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 }).eligible.length, 5);
  });

  test('Auto-unfollow handles at most 25 per run; the rest wait', async () => {
    for (let i = 0; i < 27; i++) addFollow(`y${i}`, seedJob(queue, `C${i}`), `creator_${i}`, hoursAgo(60));
    let calls = 0;
    const app = makeApp(async () => { calls += 1; return { success: true }; });

    await app.startBatch();

    assert.strictEqual(calls, 25);
    assert.strictEqual(queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 }).eligible.length, 2);
  });

  test('Pressing Stop skips the auto-unfollow', async () => {
    addFollow('a', seedJob(queue, 'A1'), 'old_one', hoursAgo(60));
    let calls = 0;
    const app = makeApp(async () => { calls += 1; return { success: true }; });
    app.resources = { hasOutstanding: () => { app.stopBatch(); return false; }, deliver: async () => ({ csv: null, dmCount: 0, dmFailed: false }) };

    await app.startBatch();

    assert.strictEqual(calls, 0);
  });

  test('In live mode, simulated follows are never unfollowed', async () => {
    const job = seedJob(queue, 'SIM1');
    const at = hoursAgo(60);
    dbObj.db.prepare(`
      INSERT INTO creator_interactions (id, job_id, creator_username, shortcode, is_simulated, simulated_follow_status, simulated_follow_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 'COMPLETED', ?, ?, ?)
    `).run('s', job.id, 'sim_only', 'SIM1', at, at, at);
    let calls = 0;
    const app = makeApp(async () => { calls += 1; return { success: true }; });

    await app.startBatch();

    assert.strictEqual(calls, 0);
  });

  test('App: unfollow() respects 2-day protection unless forceAll is specified', async () => {
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
    const app = new ReelLinkApp({
      db: dbObj.db,
      queue,
      live: false,
      unfollowPauseMs: 0,
      browserSession: { close: async () => {} },
      inbox: {
        unfollowCreatorDirect: async (creator) => {
          unfollowedList.push(creator);
          return { success: true, creator };
        },
      },
    });

    // 1. Standard unfollow: only the creator followed 48h+ ago
    const res1 = await app.unfollow({ forceAll: false });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.count, 1);
    assert.deepStrictEqual(res1.unfollowed, ['senior_creator']);
    assert.strictEqual(res1.protectedCount, 1);

    const updatedOverview = queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 });
    assert.strictEqual(updatedOverview.all.length, 1);
    assert.strictEqual(updatedOverview.all[0].creator, 'fresh_creator');

    // 2. Regression: with only protected creators left, a standard unfollow must do nothing
    //    (the old /api/unfollow fell back to unfollowing everyone here).
    const res2 = await app.unfollow({ forceAll: false });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.count, 0);
    assert.strictEqual(res2.protectedCount, 1);
    assert.deepStrictEqual(unfollowedList, ['senior_creator']);

    // 3. Force unfollow: now the protected creator is removed too
    const res3 = await app.unfollow({ forceAll: true });
    assert.strictEqual(res3.count, 1);
    assert.deepStrictEqual(res3.unfollowed, ['fresh_creator']);
    assert.strictEqual(queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 }).all.length, 0);
    assert.strictEqual(app.activeTask, null, 'busy lock must be released');
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
    await inbox.handleBotCommand('unfollow', 'thread_auth', 'ksydn_', 'msg_unf_1');
    assert.strictEqual(deliveredDMs.length, 1);
    const previewMsg = deliveredDMs[0].text;
    assert.match(previewMsg, /Eligible for Unfollow/i);
    assert.match(previewMsg, /eligible_user/);
    assert.match(previewMsg, /Protected \(<2 days retention/i);
    assert.match(previewMsg, /protected_user/);

    // Step 2: Confirmed unfollow (default targets only eligible)
    deliveredDMs.length = 0;
    await inbox.handleBotCommand('unfollow', 'thread_auth', 'ksydn_', 'msg_unf_2', 'confirm');
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
