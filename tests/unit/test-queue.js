const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_reellink.db');

function cleanupTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

test('JobQueue lifecycle: creation, deduplication, retry, and crash recovery', async () => {
  cleanupTestDb();
  const db = new Database(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // 1. Create Job
  const { job: job1, isDuplicate: dup1 } = queue.createJob({
    threadId: 'thread_123',
    senderUsername: 'alice',
    reelUrl: 'https://www.instagram.com/reel/TEST_REEL_01/',
    shortcode: 'TEST_REEL_01',
  });

  assert.strictEqual(dup1, false, 'First job should not be duplicate');
  assert.strictEqual(job1.status, JOB_STATUS.PENDING);
  assert.strictEqual(job1.shortcode, 'TEST_REEL_01');
  assert.strictEqual(job1.retry_count, 0);

  // 2. Duplicate Detection
  const { job: jobDup, isDuplicate: dup2 } = queue.createJob({
    threadId: 'thread_123',
    senderUsername: 'alice',
    reelUrl: 'https://www.instagram.com/reel/TEST_REEL_01/',
    shortcode: 'TEST_REEL_01',
  });

  assert.strictEqual(dup2, true, 'Subsequent identical Reel should be detected as duplicate');
  assert.strictEqual(jobDup.id, job1.id);

  // 3. FIFO Fetch
  const pending = queue.getNextPendingJob();
  assert.strictEqual(pending.id, job1.id);

  // 4. State Transitions
  queue.updateStatus(job1.id, JOB_STATUS.EXTRACTING, { stage: 'A' });
  let current = queue.getJobById(job1.id);
  assert.strictEqual(current.status, JOB_STATUS.EXTRACTING);
  assert.strictEqual(current.stage, 'A');

  queue.updateStatus(job1.id, JOB_STATUS.SEARCHING, {
    stage: 'B',
    evidence: { repoName: 'torvalds/linux' },
  });
  current = queue.getJobById(job1.id);
  assert.strictEqual(current.status, JOB_STATUS.SEARCHING);
  assert.ok(current.evidence_json.includes('torvalds/linux'));

  // 5. Retry Handling
  queue.handleJobError(job1.id, 'Search timeout');
  current = queue.getJobById(job1.id);
  assert.strictEqual(current.retry_count, 1);
  assert.strictEqual(current.status, JOB_STATUS.PENDING); // Retried back to PENDING

  // Exhaust retries (job1 has max_retries = 3)
  queue.handleJobError(job1.id, 'Search timeout 2');
  queue.handleJobError(job1.id, 'Search timeout 3');
  queue.handleJobError(job1.id, 'Final fatal error');
  current = queue.getJobById(job1.id);
  assert.strictEqual(current.status, JOB_STATUS.FAILED);
  assert.strictEqual(current.error_message, 'Final fatal error');

  // 6. Crash Recovery Test
  const { job: stalledJob } = queue.createJob({
    threadId: 'thread_456',
    senderUsername: 'nauman',
    reelUrl: 'https://www.instagram.com/reel/STALLED_01/',
    shortcode: 'STALLED_01',
  });
  queue.updateStatus(stalledJob.id, JOB_STATUS.EXTRACTING);

  // Simulate recovery on startup
  const recoveredCount = queue.recoverStalledJobs();
  assert.strictEqual(recoveredCount, 1, 'Should recover 1 stalled job');

  const recovered = queue.getJobById(stalledJob.id);
  assert.strictEqual(recovered.status, JOB_STATUS.PENDING, 'Stalled job should be reset to PENDING');

  // 7. Save Candidates Test
  queue.saveCandidates(stalledJob.id, [
    { url: 'https://github.com/foo/bar', title: 'Foo Bar', score: 0.85, isSelected: true },
    { url: 'https://example.com/other', title: 'Other', score: 0.40, isSelected: false },
  ]);

  const candidates = db.prepare('SELECT * FROM candidates WHERE job_id = ?').all(stalledJob.id);
  assert.strictEqual(candidates.length, 2);
  assert.strictEqual(candidates[0].score, 0.85);

  db.close();
  cleanupTestDb();
});
