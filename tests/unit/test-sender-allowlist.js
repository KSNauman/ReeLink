/**
 * Unit Tests for Sender Allowlist Security Rules
 * Verifies:
 * 1. The hardcoded owner ('ksydn_') is accepted.
 * 2. Every other account is rejected.
 * 3. Case differences and a leading '@' are normalized (@Ksydn_).
 * 4. Unauthorized sender creates no processing job and triggers no Instagram actions.
 * 5. Missing or ambiguous sender identity is rejected (fail closed).
 * 6. Resumed or retried jobs cannot bypass allowlist.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { getDatabase } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const {
  isSenderAllowed,
  assertSenderAllowed,
  normalizeSenderUsername,
  getEffectiveAllowedSenders,
} = require('../../src/security/sender-allowlist');
const config = require('../../src/config');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_sender_allowlist.db');

function cleanupDb() {
  try {
    const db = getDatabase(TEST_DB_PATH);
    db.exec('DELETE FROM jobs; DELETE FROM creator_interactions; DELETE FROM audit_logs;');
  } catch {}
}

test.beforeEach(cleanupDb);
test.after(cleanupDb);

test('Sender Allowlist: 1. the hardcoded owner is accepted', () => {
  assert.strictEqual(config.owner, 'ksydn_');
  assert.deepStrictEqual(getEffectiveAllowedSenders(), ['ksydn_']);
  assert.strictEqual(isSenderAllowed('ksydn_'), true);
  assert.strictEqual(assertSenderAllowed('ksydn_', { stage: 'TEST' }), true);
});

test('Sender Allowlist: 2. former allowlist accounts and look-alikes are rejected', () => {
  for (const name of ['nauman', 'naumannn', 'ksydn', 'ksydn__']) {
    assert.strictEqual(isSenderAllowed(name), false, `${name} must be rejected`);
  }
});

test('Sender Allowlist: 3. Case differences and leading @ are normalized', () => {
  assert.strictEqual(isSenderAllowed('@ksydn_'), true);
  assert.strictEqual(isSenderAllowed('Ksydn_'), true);
  assert.strictEqual(isSenderAllowed('@KSYDN_'), true);
  assert.strictEqual(isSenderAllowed('  @Ksydn_  '), true);

  // Normalization helper tests
  assert.strictEqual(normalizeSenderUsername('@nauman'), 'nauman');
  assert.strictEqual(normalizeSenderUsername('  @Ksydn_  '), 'ksydn_');
  assert.strictEqual(normalizeSenderUsername('KSYDN_'), 'ksydn_');
});

test('Sender Allowlist: 4. Unauthorized sender creates no processing job and triggers no actions', () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  const unauthorizedSenders = ['hacker_99', 'random_user', 'spammer_bot', 'alice', 'attacker'];

  for (const sender of unauthorizedSenders) {
    // 1. isSenderAllowed must return false
    assert.strictEqual(isSenderAllowed(sender), false, `Sender ${sender} must be rejected`);

    // 2. assertSenderAllowed must return false
    assert.strictEqual(assertSenderAllowed(sender, { threadId: 'unauth_thread' }), false);

    // 3. createJob with enforceAllowlist=true must refuse to insert row into jobs table
    const result = queue.createJob({
      threadId: 'unauth_thread_123',
      senderUsername: sender,
      reelUrl: 'https://www.instagram.com/reel/Unauth123/',
      shortcode: 'Unauth123',
      enforceAllowlist: true,
    });

    assert.strictEqual(result.job, null, 'No job must be created for unauthorized sender');
    assert.strictEqual(result.error, 'UNAUTHORIZED_SENDER');

    // Verify database row was NOT created
    const inDb = db.prepare('SELECT * FROM jobs WHERE sender_username = ?').all(sender);
    assert.strictEqual(inDb.length, 0, 'Database must contain zero jobs for unauthorized sender');
  }
});

test('Sender Allowlist: 5. Missing or ambiguous sender identity is rejected (fail closed)', () => {
  const ambiguousInputs = [null, undefined, '', '   ', '@', 'unknown', 'undefined', 'null', 12345, {}, []];

  for (const input of ambiguousInputs) {
    assert.strictEqual(isSenderAllowed(input), false, `Ambiguous input ${JSON.stringify(input)} must be rejected`);
    assert.strictEqual(assertSenderAllowed(input), false);
  }

  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // Attempting to create a job with empty or missing sender
  const result = queue.createJob({
    threadId: 'empty_thread',
    senderUsername: null,
    reelUrl: 'https://www.instagram.com/reel/EmptySender/',
    shortcode: 'EmptySender',
    enforceAllowlist: true,
  });

  assert.strictEqual(result.job, null);
  assert.strictEqual(result.error, 'UNAUTHORIZED_SENDER');
});

test('Sender Allowlist: 6. A resumed or retried job cannot bypass the allowlist', () => {
  const db = getDatabase(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // Manually insert an unauthorized job as if injected into SQLite prior to security enforcement
  const unauthorizedJobId = 'injected_unauth_job_1';
  db.prepare(`
    INSERT INTO jobs (id, thread_id, sender_username, reel_url, shortcode, status, stage, retry_count, max_retries)
    VALUES (?, 'injected_thread', 'malicious_user', 'https://www.instagram.com/reel/BypassTest/', 'BypassTest', 'SEARCHING', 'B', 0, 3)
  `).run(unauthorizedJobId);

  // Verify the job exists in SQLite
  const injected = queue.getJob(unauthorizedJobId);
  assert.strictEqual(injected.status, 'SEARCHING');

  // 1. Run recoverStalledJobs: it must detect unauthorized sender and mark it FAILED instead of PENDING
  const recoveredCount = queue.recoverStalledJobs();
  assert.ok(recoveredCount >= 1);

  const afterRecovery = queue.getJob(unauthorizedJobId);
  assert.strictEqual(afterRecovery.status, 'FAILED');
  assert.ok(afterRecovery.error_message.includes('UNAUTHORIZED_SENDER'));

  // 2. Mock processJob check: assertSenderAllowed fails closed on unauthorized sender
  assert.strictEqual(isSenderAllowed(afterRecovery.sender_username), false);
  assert.strictEqual(assertSenderAllowed(afterRecovery.sender_username, { jobId: afterRecovery.id }), false);
});
