/**
 * ReelLink Master Application Orchestrator
 * Runs the continuous background polling loop on Instagram DMs,
 * executes the tiered discovery pipeline, and delivers verified resources.
 */
const config = require('./config');
const logger = require('./utils/logger');
const { getDatabase } = require('./storage/database');
const { JobQueue, JOB_STATUS } = require('./queue/jobs');
const BrowserSession = require('./instagram/session');
const InstagramInbox = require('./instagram/inbox');
const InstagramSender = require('./instagram/sender');
const { fetchReelPublicData } = require('./pipeline/extract-reel');
const { CreatorInteractionManager } = require('./pipeline/creator-interaction');
const { ReelLinkWebServer } = require('./web/server');

class ReelLinkApp {
  constructor(options = {}) {
    this.isLiveMode = Boolean(
      options.live ||
      options.isLiveMode ||
      process.argv.includes('--live') ||
      process.env.CREATOR_WORKFLOW_LIVE === 'true' ||
      process.env.CREATOR_WORKFLOW_ENABLED === 'true' ||
      config.creatorWorkflow.enabled === true ||
      config.creatorWorkflow.simulationMode === false
    );
    this.autoApprove = Boolean(
      options.autoApprove ||
      options.auto_approve ||
      process.argv.includes('--auto-approve') ||
      process.argv.includes('--live-auto-approve') ||
      process.env.CREATOR_WORKFLOW_REQUIRE_APPROVAL === 'false' ||
      config.creatorWorkflow.requireApproval === false
    );
    this.isContinuous = Boolean(
      options.continuous ||
      process.argv.includes('--continuous')
    );

    this.startTime = Date.now();
    this.currentJob = null;
    this.currentJobId = null;
    this.db = options.db || getDatabase();
    this.queue = options.queue || new JobQueue(this.db);
    this.browserSession = options.browserSession || new BrowserSession();
    this.sender = options.sender || new InstagramSender(this.browserSession);
    this.inbox = options.inbox || new InstagramInbox(this.browserSession, {
      queue: this.queue,
      sender: this.sender,
      isLiveMode: this.isLiveMode,
      app: this,
    });
    this.creatorManager = options.creatorManager || new CreatorInteractionManager({
      queue: this.queue,
      browserSession: this.browserSession,
      inbox: this.inbox,
      sender: this.sender,
      isLiveMode: this.isLiveMode,
      enabled: this.isLiveMode,
      simulationMode: !this.isLiveMode,
      requireApproval: !this.autoApprove,
      configOptions: {
        enabled: this.isLiveMode,
        isLiveMode: this.isLiveMode,
        simulationMode: !this.isLiveMode,
        requireApproval: !this.autoApprove,
      },
    });
    this.inbox.creatorManager = this.creatorManager;
    this.isRunning = false;
    this.pollTimer = null;

    // Batch & Web State
    this.batchStatus = 'IDLE';
    this.isBatchRunning = false;
    this.batchProgress = { current: 0, total: 0, currentJob: null, summary: 'Idle' };
    this.recentLogs = [];
    this.enableWeb = options.enableWeb !== false && options.web !== false && !process.env.NO_WEB;
    this.webPort = options.port || (config.web ? config.web.port : 3000);
    this.webServer = new ReelLinkWebServer({ app: this, queue: this.queue, port: this.webPort });
  }

  _addLog(message) {
    const time = new Date().toTimeString().split(' ')[0];
    this.recentLogs.push({ time, message });
    if (this.recentLogs.length > 50) this.recentLogs.shift();
  }

  async start() {
    logger.info('=========================================');
    logger.info('       Starting ReelLink Daemon          ');
    logger.info(`Mode: ${this.isLiveMode ? 'LIVE' : 'SIMULATION'} | Auto-Approve: ${this.autoApprove ? 'YES' : 'NO (Supervised)'}`);
    logger.info('=========================================');

    // 1. Recover any stalled jobs from prior abnormal shutdown
    const recovered = this.queue.recoverStalledJobs();
    logger.info(`Startup check complete: ${recovered} stalled jobs recovered`);

    // 2. Check for jobs awaiting approval
    const awaitingApproval = this.queue.getJobsAwaitingApproval();
    if (awaitingApproval.length > 0) {
      logger.warn('========================================================================');
      logger.warn(`⚠️  STARTUP: ${awaitingApproval.length} JOB(S) ARE AWAITING OPERATOR APPROVAL:`);
      for (const j of awaitingApproval) {
        const interaction = this.queue.getCreatorInteraction(j.id);
        logger.warn(`   • Job ID: ${j.id} (Reel ${j.shortcode}) from @${j.sender_username}`);
        if (interaction) {
          logger.warn(`     Action: Follow @${interaction.creator_username} + Comment "${interaction.keyword}"`);
        }
        logger.warn(`     To approve: node src/approve.js ${j.id}`);
      }
      logger.warn('   Or approve all: node src/approve.js --all');
      logger.warn('========================================================================');
    }

    // 3. Initialize browser context
    try {
      logger.info('Checking browser session...');
      const auth = await this.browserSession.checkAuthStatus();
      if (!auth.authenticated) {
        logger.warn('Instagram session is not authenticated. Inbox polling may be limited.');
        logger.warn('Run "npm.cmd run setup:session" to log in with your dedicated bot account.');
      }
    } catch (err) {
      logger.warn('Initial session check encountered warning', { error: err.message });
    }

    // 4. Establish safe inbox baseline only if running in continuous polling mode
    if (this.isContinuous) {
      try {
        await this.inbox.establishBaseline(this.queue);
      } catch (err) {
        logger.warn('Inbox baseline check encountered warning', { error: err.message });
      }
    }

    // 5. Start Web Server Dashboard
    if (this.enableWeb) {
      try {
        await this.webServer.start();
        logger.info(`🌐 ReelLink Web Dashboard ready at http://localhost:${this.webServer.port}`);
        this._addLog(`Web Dashboard ready at http://localhost:${this.webServer.port}`);
      } catch (err) {
        logger.warn('Web dashboard startup warning', { error: err.message });
      }
    }

    if (!this.isContinuous) {
      logger.info('========================================================================');
      logger.info('📌 TRIGGERED BATCH MODE ACTIVE');
      logger.info(`👉 Open dashboard: http://localhost:${this.webServer.port} and click "START BATCH"`);
      logger.info('👉 Or send "start" or "/start" in Instagram DM from @nauman or @ksydn_');
      logger.info('========================================================================');
    }

    this.isRunning = true;
    this._startLoop();

    // Register process termination handlers
    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
  }

  _startLoop() {
    if (!this.isRunning) return;

    this._runCycle()
      .catch(err => {
        logger.error('Error during processing cycle', { error: err.message });
      })
      .finally(() => {
        if (this.isRunning) {
          const delay = config.instagram.pollIntervalSec * 1000;
          this.pollTimer = setTimeout(() => this._startLoop(), delay);
        }
      });
  }

  async _runCycle() {
    // If a batch run is currently active, yield to avoid concurrent page interactions
    if (this.isBatchRunning) {
      return;
    }

    const { isSenderAllowed, assertSenderAllowed } = require('./security/sender-allowlist');

    // 1. Poll Instagram Direct Inbox for newly shared Reels or bot commands
    logger.debug('Polling inbox for new Reel shares or commands...');
    const incomingReels = await this.inbox.pollForIncomingReels(this.queue);

    for (const reel of incomingReels) {
      // Security Gate: Verify sender against allowlist BEFORE creating a job
      if (!assertSenderAllowed(reel.senderUsername, { threadId: reel.threadId, stage: 'APP_RUN_CYCLE' })) {
        continue;
      }

      // Check if message was already processed in SQLite
      if (reel.messageId && this.queue.isMessageProcessed(reel.messageId)) {
        logger.debug('Message already processed in database; skipping duplicate ingestion', {
          messageId: reel.messageId,
          shortcode: reel.shortcode,
        });
        continue;
      }

      const { job, isDuplicate } = this.queue.createJob({
        threadId: reel.threadId,
        senderUsername: reel.senderUsername || 'unknown',
        reelUrl: reel.reelUrl,
        shortcode: reel.shortcode,
        messageId: reel.messageId,
        enforceAllowlist: true,
      });

      if (!isDuplicate && job) {
        logger.info('New Reel received and enqueued for comment workflow', {
          shortcode: reel.shortcode,
          sender: reel.senderUsername,
          threadId: reel.threadId,
          messageId: reel.messageId,
        });
        this._addLog(`Received new shared Reel ${reel.shortcode} from @${reel.senderUsername}`);
      }
    }

    // Only automatically execute queue if continuous mode is enabled
    if (this.isContinuous) {
      if (this.autoApprove) {
        const awaiting = this.queue.getJobsAwaitingApproval();
        for (const j of awaiting) {
          logger.info(`Auto-approving job ${j.id} (Reel ${j.shortcode}) for live execution...`);
          this.queue.approveJob(j.id);
        }
      } else {
        const awaiting = this.queue.getJobsAwaitingApproval();
        if (awaiting.length > 0) {
          logger.warn(`[AWAITING APPROVAL] ${awaiting.length} job(s) paused awaiting operator approval. Run 'node src/approve.js --all' to approve.`);
        }
      }

      let nextJob = this.queue.getNextPendingJob();
      while (nextJob && this.isRunning && !this.isBatchRunning) {
        await this.processJob(nextJob);
        nextJob = this.queue.getNextPendingJob();
      }
    }
  }

  /**
   * Starts on-demand batch execution:
   * 1. Scans inbox for newly shared/unread Reels from authorized senders.
   * 2. Enqueues and approves them.
   * 3. Executes the follow-first and keyword comment workflow sequentially for each job.
   * 4. Reports completion.
   * @param {Object} [options]
   * @param {string} [options.triggeredBy='MANUAL']
   * @param {string} [options.threadId]
   * @param {string} [options.senderUsername]
   * @returns {Promise<{ success: boolean, processedCount: number, message: string }>}
   */
  async startBatch(options = {}) {
    if (this.isBatchRunning) {
      logger.warn('Batch trigger ignored: A batch is already actively running.');
      return { success: false, processedCount: 0, error: 'A batch is already running' };
    }

    this.isBatchRunning = true;
    this.batchStatus = 'SCANNING_INBOX';
    this.batchProgress = { current: 0, total: 0, currentJob: null, summary: 'Scanning inbox for unread Reels...' };
    this._addLog('🚀 Batch started. Scanning inbox for shared Reels...');

    const triggeredBy = options.triggeredBy || 'MANUAL';
    logger.info(`Starting batch run (triggered by ${triggeredBy})...`);

    try {
      // 1. Scan inbox for all unread / shared Reels from authorized senders
      const newJobs = await this.inbox.collectUnprocessedReels({
        queue: this.queue,
        threadId: options.threadId || null,
        senderUsername: options.senderUsername || null,
      });

      this._addLog(`Inbox scan completed: Found ${newJobs.length} new Reel(s).`);

      // 2. Auto-approve all pending jobs since this is an explicit user batch trigger
      const awaiting = this.queue.getJobsAwaitingApproval();
      for (const j of awaiting) {
        this.queue.approveJob(j.id);
      }

      // 3. Count total pending jobs in queue
      let pendingJobsCount = this.queue.getPendingJobsCount();
      if (pendingJobsCount === 0) {
        this.batchStatus = 'IDLE';
        this.isBatchRunning = false;
        this.batchProgress = { current: 0, total: 0, currentJob: null, summary: 'No new unread Reels found.' };
        this._addLog('No pending Reels to process. Returning to IDLE.');
        return { success: true, processedCount: 0, message: 'No new Reels found' };
      }

      this.batchStatus = 'PROCESSING';
      this.batchProgress.total = pendingJobsCount;

      let processedCount = 0;
      let nextJob = this.queue.getNextPendingJob();

      while (nextJob && this.isBatchRunning) {
        processedCount++;
        this.batchProgress.current = processedCount;
        this.batchProgress.currentJob = nextJob;
        this.batchProgress.summary = `Processing Reel ${nextJob.shortcode} (${processedCount} of ${this.batchProgress.total})...`;
        this._addLog(`[${processedCount}/${this.batchProgress.total}] Processing Reel ${nextJob.shortcode} from @${nextJob.sender_username}...`);

        await this.processJob(nextJob);

        nextJob = this.queue.getNextPendingJob();
        if (nextJob && this.isBatchRunning) {
          const delaySec = Math.floor(Math.random() * 3) + 5; // 5-7s safe delay
          this._addLog(`Waiting ${delaySec}s cooldown before next Reel...`);
          await new Promise(r => setTimeout(r, delaySec * 1000));
        }
      }

      this.batchStatus = 'COMPLETED';
      this.batchProgress.summary = `Batch complete! Processed ${processedCount} Reel(s).`;
      this._addLog(`✅ Batch successfully finished: ${processedCount} Reel(s) processed.`);

      return {
        success: true,
        processedCount,
        message: `Successfully processed ${processedCount} Reel(s)`,
      };
    } catch (err) {
      logger.error('Error during batch execution', { error: err.message });
      this.batchStatus = 'ERROR';
      this.batchProgress.summary = `Batch error: ${err.message}`;
      this._addLog(`❌ Batch error: ${err.message}`);
      throw err;
    } finally {
      this.isBatchRunning = false;
      setTimeout(() => {
        if (this.batchStatus === 'COMPLETED' || this.batchStatus === 'ERROR') {
          this.batchStatus = 'IDLE';
          this.batchProgress.summary = 'Idle. Ready for next batch.';
        }
      }, 10000);
    }
  }

  stopBatch() {
    if (this.isBatchRunning) {
      logger.info('Stopping active batch run by user request...');
      this.isBatchRunning = false;
      this.batchStatus = 'IDLE';
      this.batchProgress.summary = 'Batch stopped by user.';
      this._addLog('⏹ Batch execution stopped by user.');
      return true;
    }
    return false;
  }

  async processJob(job) {
    const { assertSenderAllowed } = require('./security/sender-allowlist');

    // Security Gate: Ensure job sender is authorized (Prevents bypassed retries/resumed jobs)
    if (!assertSenderAllowed(job.sender_username, { threadId: job.thread_id, stage: 'PROCESS_JOB' })) {
      logger.warn('IGNORED_UNAUTHORIZED_SENDER: Job discarded', { jobId: job.id, sender: job.sender_username });
      this.queue.updateStatus(job.id, JOB_STATUS.FAILED, { errorMessage: 'IGNORED_UNAUTHORIZED_SENDER' });
      return;
    }

    logger.info(`Processing job ${job.id}`, { shortcode: job.shortcode, sender: job.sender_username });
    this.currentJob = job;
    this.currentJobId = job.id;

    try {
      this.queue.updateStatus(job.id, JOB_STATUS.EXTRACTING, { stage: 'EXTRACTION' });

      // Step 1: Detect and extract Reel and creator information
      const metadata = await fetchReelPublicData(job.reel_url, this.browserSession);
      const creator = (metadata.creator || '').replace(/^@/, '').trim();
      const caption = metadata.caption || '';

      // Step 2: Extract exact keyword from caption (default to 🙌 if none or unclear)
      const { extractCreatorRequirements } = require('./pipeline/creator-interaction');
      const reqs = extractCreatorRequirements(caption, '', { defaultToEmoji: true });
      const keyword = (reqs.keyword && reqs.keyword.trim().length > 0 && !reqs.isUnclear) ? reqs.keyword.trim() : '🙌';

      // Record creator interaction requirements in SQLite (Follow + Comment)
      this.queue.createOrGetCreatorInteraction(job.id, {
        creatorUsername: creator,
        shortcode: job.shortcode,
        requiresFollow: 1,
        requiresComment: 1,
        keyword: keyword,
        isSimulated: this.isLiveMode ? 0 : 1,
      });

      // Step 3: Check operator approval
      const isApproved = job.is_approved === 1 || this.autoApprove;

      if (!isApproved) {
        logger.warn(`[APPROVAL REQUIRED] Job ${job.id} (Reel ${job.shortcode}, creator @${creator || 'unknown'}) requires approval before following and posting comment.`);
        logger.warn(`To approve this job for live execution, run: node src/approve.js ${job.id}`);

        this.queue.updateStatus(job.id, 'AWAITING_APPROVAL', {
          resultSummary: `Awaiting operator approval to follow @${creator} and comment '${keyword}' on Reel ${job.shortcode}`,
        });
        return;
      }

      // Step 4: Execute Creator Workflow (Comment exactly once)
      const creatorResult = await this.creatorManager.executeCreatorWorkflow(job, {
        caption,
        creator,
        keyword,
        isSimulation: !this.isLiveMode,
        approved: true,
      });

      if (creatorResult.success && creatorResult.status === 'COMPLETED') {
        logger.info(`Job ${job.id} successfully completed (comment verified on Reel ${job.shortcode}).`);
        this.queue.updateStatus(job.id, JOB_STATUS.COMPLETED, {
          resultSummary: `Successfully commented '${keyword}' on Reel ${job.shortcode} by @${creator}`,
        });
        return;
      }

      if (creatorResult.status === 'AWAITING_APPROVAL' || creatorResult.status === 'PENDING_APPROVAL') {
        logger.info(`Job ${job.id} is awaiting approval for creator interaction`, {
          stage: creatorResult.stage,
        });
        return;
      }

      // If follow or comment failed, mark FAILED
      this.queue.updateStatus(job.id, JOB_STATUS.FAILED, {
        errorMessage: creatorResult.error || 'Creator interaction failed',
      });
    } catch (err) {
      logger.error(`Error processing job ${job.id}`, { error: err.message });
      this.queue.handleJobError(job.id, err);
    } finally {
      this.currentJob = null;
      this.currentJobId = null;
    }
  }

  async stop(signal = 'SIGINT') {
    logger.info(`Received ${signal}. Shutting down ReelLink gracefully...`);
    this.isRunning = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);

    try {
      if (this.webServer) {
        await this.webServer.close().catch(() => {});
      }
      await this.browserSession.close();
      this.db.close();
      logger.info('ReelLink shutdown complete.');
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
    } finally {
      process.exit(0);
    }
  }
}

if (require.main === module) {
  const app = new ReelLinkApp();
  app.start();
}

module.exports = ReelLinkApp;
