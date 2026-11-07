#!/usr/bin/env node
/**
 * ReelLink CLI: Supervised Approval Utility
 * 
 * Allows operators to inspect and approve jobs awaiting creator interaction (Follow/Comment).
 * 
 * Usage:
 *   node src/approve.js <jobId>      - Approve a specific job for live execution
 *   node src/approve.js --list       - List all jobs currently awaiting approval
 *   node src/approve.js --all        - Approve all jobs currently awaiting approval
 */

const { getDatabase } = require('./storage/database');
const { JobQueue } = require('./queue/jobs');
const logger = require('./utils/logger');

function main() {
  const args = process.argv.slice(2);
  const db = getDatabase();
  const queue = new JobQueue(db);

  if (args.length === 0 || args.includes('--list') || args.includes('-l')) {
    const awaiting = queue.getJobsAwaitingApproval();
    console.log('\n==================================================');
    console.log('       ReelLink: Jobs Awaiting Operator Approval  ');
    console.log('==================================================\n');

    if (awaiting.length === 0) {
      console.log('No jobs are currently awaiting approval.\n');
      process.exit(0);
    }

    console.log(`Found ${awaiting.length} job(s) awaiting approval:\n`);
    for (const job of awaiting) {
      const interaction = queue.getCreatorInteraction(job.id);
      console.log(`• Job ID:     ${job.id}`);
      console.log(`  Shortcode:  ${job.shortcode}`);
      console.log(`  Sender:     @${job.sender_username}`);
      console.log(`  Thread ID:  ${job.thread_id}`);
      if (interaction) {
        console.log(`  Creator:    @${interaction.creator_username}`);
        console.log(`  Follow Req: ${interaction.requires_follow ? 'YES' : 'NO'}`);
        console.log(`  Keyword:    ${interaction.keyword || '(none)'}`);
      }
      console.log(`  Action:     To approve, run: node src/approve.js ${job.id}\n`);
    }
    process.exit(0);
  }

  if (args.includes('--all')) {
    const awaiting = queue.getJobsAwaitingApproval();
    if (awaiting.length === 0) {
      console.log('No jobs awaiting approval.');
      process.exit(0);
    }

    console.log(`Approving ${awaiting.length} job(s)...`);
    for (const job of awaiting) {
      const ok = queue.approveJob(job.id);
      console.log(`Job ${job.id} (${job.shortcode}): ${ok ? 'APPROVED' : 'FAILED'}`);
    }
    console.log('All pending approvals processed.');
    process.exit(0);
  }

  const targetJobId = args[0].trim();
  const job = queue.getJobById(targetJobId);

  if (!job) {
    console.error(`Error: Job ${targetJobId} not found in database.`);
    process.exit(1);
  }

  const interaction = queue.getCreatorInteraction(job.id);
  const success = queue.approveJob(job.id);

  if (success) {
    console.log('\n==================================================');
    console.log('           Job Approved for Live Execution        ');
    console.log('==================================================');
    console.log(`• Job ID:       ${job.id}`);
    console.log(`• Shortcode:    ${job.shortcode}`);
    console.log(`• Sender:       @${job.sender_username}`);
    console.log(`• Thread ID:    ${job.thread_id}`);
    if (interaction) {
      console.log(`• Creator:      @${interaction.creator_username}`);
      console.log(`• Keyword:      ${interaction.keyword}`);
    }
    console.log(`• Status:       Transitioned to PENDING (is_approved: 1)`);
    console.log('• ReelLink daemon will pick up this job on its next cycle.\n');
  } else {
    console.error(`Failed to approve job ${targetJobId}.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
