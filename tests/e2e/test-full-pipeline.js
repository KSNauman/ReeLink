const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue, JOB_STATUS } = require('../../src/queue/jobs');
const { parseReelMetadata } = require('../../src/pipeline/extract-reel');
const { processResource } = require('../../src/pipeline/process-resource');
const { rankCandidates } = require('../../src/pipeline/validate-candidates');

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test_e2e_reellink.db');

test('End-to-End Pipeline: Ingestion, Early Stopping, Validation, and Delivery', async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);

  const db = new Database(TEST_DB_PATH);
  const queue = new JobQueue(db);

  // 1. Simulate incoming Reel share with direct GitHub link in caption
  const incomingReel = {
    threadId: 'thread_user_999',
    senderUsername: 'test_user',
    reelUrl: 'https://www.instagram.com/reel/C8AbCdEfGhI/',
    shortcode: 'C8AbCdEfGhI',
  };

  const { job, isDuplicate } = queue.createJob(incomingReel);
  assert.strictEqual(isDuplicate, false);
  assert.strictEqual(job.status, JOB_STATUS.PENDING);

  // 2. Stage A: Metadata Extraction & Early Stopping
  queue.updateStatus(job.id, JOB_STATUS.EXTRACTING, { stage: 'A' });

  const metadata = parseReelMetadata({
    shortcode: job.shortcode,
    creator: 'ai_builder',
    caption: 'Here is the source code for the agent: https://github.com/langchain-ai/langchain. Check it out!',
  });

  assert.strictEqual(metadata.hasDirectResource, true);
  assert.strictEqual(metadata.needsMediaInspection, false);

  const candidateUrl = metadata.directResourceUrls[0];
  assert.strictEqual(candidateUrl, 'https://github.com/langchain-ai/langchain');

  // 3. Stage 5: Resource Processing & SSRF Validation
  queue.updateStatus(job.id, JOB_STATUS.PROCESSING, { candidateUrl });
  const processed = await processResource(candidateUrl);

  assert.strictEqual(processed.success, true);
  assert.strictEqual(processed.resourceType, 'github_repository');
  assert.strictEqual(processed.finalUrl, 'https://github.com/langchain-ai/langchain');

  // 4. Final Delivery & Job Completion
  queue.updateStatus(job.id, JOB_STATUS.COMPLETED, {
    candidateUrl: processed.finalUrl,
    resultSummary: processed.summary,
  });

  const completedJob = queue.getJobById(job.id);
  assert.strictEqual(completedJob.status, JOB_STATUS.COMPLETED);
  assert.strictEqual(completedJob.candidate_url, 'https://github.com/langchain-ai/langchain');
  assert.ok(completedJob.result_summary.includes('Official GitHub Repository'));

  // 5. Verify Deduplication prevents double processing
  const dupCheck = queue.createJob(incomingReel);
  assert.strictEqual(dupCheck.isDuplicate, true);
  assert.strictEqual(dupCheck.job.id, job.id);

  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});
