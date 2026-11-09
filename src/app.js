/**
 * ReelLink core (desktop edition).
 *
 * Nothing runs in the background. The desktop window calls:
 *   - startBatch()  → scan the owner's DM thread, then follow + comment each new Reel
 *   - stopBatch()   → stop after the current Reel
 *   - unfollow()    → unfollow creators past the 48-hour protection window
 *   - login()       → open a visible browser to sign in to Instagram
 *   - getStatus()   → snapshot for the UI
 * and listens to the 'update' event for live progress.
 */
const EventEmitter = require('events');
const config = require('./config');
const logger = require('./utils/logger');
const { getDatabase } = require('./storage/database');
const { JobQueue, JOB_STATUS } = require('./queue/jobs');
const BrowserSession = require('./instagram/session');
const InstagramInbox = require('./instagram/inbox');
const InstagramSender = require('./instagram/sender');
const { fetchReelPublicData } = require('./pipeline/extract-reel');
const { CreatorInteractionManager, extractCreatorRequirements } = require('./pipeline/creator-interaction');
const { assertSenderAllowed } = require('./security/sender-allowlist');
const { ResourceCollector, deriveTopic } = require('./pipeline/resources');

const UNFOLLOW_MIN_AGE_HOURS = 48;
const AUTO_UNFOLLOW_MAX_PER_RUN = 25;
// Several failures in a row usually means Instagram is blocking actions.
const UNFOLLOW_MAX_CONSECUTIVE_FAILURES = 3;
// Creators' auto-replies have arrived within seconds; slower ones are picked up next run.
const REPLY_WAIT_SEC = 20;

class ReelLinkApp extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.live=true] - false = simulate follows/comments (nothing is posted)
   */
  constructor(options = {}) {
    super();
    this.isLiveMode = options.live !== false;
    // Clicking Start is the approval: every Reel in the batch is approved.
    this.autoApprove = true;
    this.replyWaitSec = options.replyWaitSec !== undefined ? options.replyWaitSec : REPLY_WAIT_SEC;
    this.unfollowPauseMs = options.unfollowPauseMs;

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
      requireApproval: false,
      configOptions: {
        enabled: this.isLiveMode,
        isLiveMode: this.isLiveMode,
        simulationMode: !this.isLiveMode,
        requireApproval: false,
      },
    });
    this.inbox.creatorManager = this.creatorManager;
    this.resources = options.resources || new ResourceCollector({ queue: this.queue, inbox: this.inbox, sender: this.sender });

    // Busy state: only one browser task at a time (batch, unfollow or login).
    this.activeTask = null; // 'BATCH' | 'UNFOLLOW' | 'LOGIN' | null
    this.isBatchRunning = false;
    this.stopRequested = false;
    this.batchStatus = 'IDLE';
    this.batchProgress = { current: 0, total: 0, currentJob: null, summary: 'Idle' };
    this.recentLogs = [];
    this.lastLogin = null;
  }

  /** One-time startup: recover jobs interrupted by a crash or forced quit. */
  init() {
    const recovered = this.queue.recoverStalledJobs();
    if (recovered > 0) this._addLog(`Recovered ${recovered} interrupted job(s) from last session.`);
    this._addLog(`Ready. Mode: ${this.isLiveMode ? 'LIVE' : 'SIMULATION'}. Owner: @${config.owner}`);
  }

  _addLog(message) {
    const time = new Date().toTimeString().split(' ')[0];
    this.recentLogs.push({ time, message });
    if (this.recentLogs.length > 200) this.recentLogs.shift();
    this._emitUpdate();
  }

  _emitUpdate() {
    this.emit('update');
  }

  _beginTask(name) {
    if (this.activeTask) {
      return { ok: false, error: `Busy: ${this.activeTask.toLowerCase()} is already running` };
    }
    this.activeTask = name;
    this._emitUpdate();
    return { ok: true };
  }

  _endTask() {
    this.activeTask = null;
    this._emitUpdate();
  }

  /**
   * Scans the owner's DM thread for new Reels, then follows + comments each one.
   * @returns {Promise<{ success: boolean, processedCount: number, message?: string, error?: string }>}
   */
  async startBatch(options = {}) {
    const begin = this._beginTask('BATCH');
    if (!begin.ok) return { success: false, processedCount: 0, error: begin.error };

    this.isBatchRunning = true;
    this.stopRequested = false;
    this.lastCollection = null;
    this.lastAutoUnfollowCount = 0;
    const failedBefore = this.queue.getFailedJobsCount();
    const withSummary = (result) => ({
      ...result,
      failedCount: this.queue.getFailedJobsCount() - failedBefore,
      linksReceived: this.lastCollection ? this.lastCollection.received : 0,
      needsYou: this.lastCollection ? this.lastCollection.needsYou : 0,
      unfollowedCount: this.lastAutoUnfollowCount,
    });
    this.batchStatus = 'SCANNING_INBOX';
    this.batchProgress = { current: 0, total: 0, currentJob: null, summary: 'Scanning inbox for new Reels...' };
    this._addLog('🚀 Batch started. Scanning inbox for shared Reels...');
    logger.info(`Starting batch run (triggered by ${options.triggeredBy || 'DESKTOP'})...`);

    try {
      const newJobs = await this.inbox.collectUnprocessedReels({ queue: this.queue });
      this._addLog(`Inbox scan completed: found ${newJobs.length} new Reel(s).`);

      // Start button = approval for everything queued.
      for (const j of this.queue.getJobsAwaitingApproval()) {
        this.queue.approveJob(j.id);
      }

      const pendingJobsCount = this.queue.getPendingJobsCount();
      let processedCount = 0;

      if (pendingJobsCount === 0) {
        this._addLog('No new Reels to process.');
      } else {
        this.batchStatus = 'PROCESSING';
        this.batchProgress.total = pendingJobsCount;
        let nextJob = this.queue.getNextPendingJob();

        while (nextJob && !this.stopRequested) {
          processedCount++;
          this.batchProgress.current = processedCount;
          this.batchProgress.currentJob = nextJob;
          this.batchProgress.summary = `Processing Reel ${nextJob.shortcode} (${processedCount} of ${this.batchProgress.total})...`;
          this._addLog(`[${processedCount}/${this.batchProgress.total}] Processing Reel ${nextJob.shortcode}...`);

          await this.processJob(nextJob);

          nextJob = this.queue.getNextPendingJob();
          if (nextJob && !this.stopRequested) {
            const delaySec = Math.floor(Math.random() * 3) + 5; // 5-7s pause between Reels
            this._addLog(`Waiting ${delaySec}s before next Reel...`);
            await new Promise(r => setTimeout(r, delaySec * 1000));
          }
        }
      }

      await this._collectResources({ waitForReplies: processedCount > 0 });
      await this._autoUnfollow();

      if (this.stopRequested) {
        this.batchStatus = 'IDLE';
        this.batchProgress.summary = `Stopped after ${processedCount} Reel(s).`;
        this._addLog(`⏹ Batch stopped after ${processedCount} Reel(s).`);
      } else if (processedCount === 0) {
        this.batchStatus = 'IDLE';
        this.batchProgress = { current: 0, total: 0, currentJob: null, summary: 'No new Reels found.' };
        return withSummary({ success: true, processedCount: 0, message: 'No new Reels found' });
      } else {
        this.batchStatus = 'COMPLETED';
        this.batchProgress.summary = `Batch complete! Processed ${processedCount} Reel(s).`;
        this._addLog(`✅ Batch finished: ${processedCount} Reel(s) processed.`);
      }

      return withSummary({ success: true, processedCount, message: `Processed ${processedCount} Reel(s)` });
    } catch (err) {
      logger.error('Error during batch execution', { error: err.message });
      this.batchStatus = 'ERROR';
      this.batchProgress.summary = `Batch error: ${err.message}`;
      this._addLog(`❌ Batch error: ${err.message}`);
      return { success: false, processedCount: this.batchProgress.current, error: err.message };
    } finally {
      this.isBatchRunning = false;
      // Close the browser between batches: nothing stays open in the background.
      await this.browserSession.close().catch(() => {});
      this._endTask();
    }
  }

  /**
   * Gathers creators' replies, rebuilds the CSV and DMs the owner what's new.
   * A problem here never fails the batch: the follows and comments are already done.
   */
  async _collectResources({ waitForReplies }) {
    if (!this.isLiveMode || this.stopRequested) return;

    try {
      if (!this.resources.hasOutstanding()) {
        this._reportDelivery(await this.resources.deliver());
        return;
      }

      this.batchStatus = 'COLLECTING';
      if (waitForReplies) {
        this._addLog(`All Reels done. Giving creators ${this.replyWaitSec}s to reply...`);
        const until = Date.now() + this.replyWaitSec * 1000;
        while (Date.now() < until && !this.stopRequested) {
          const left = Math.ceil((until - Date.now()) / 1000);
          this.batchProgress.summary = `Waiting for creators to reply: ${left}s left`;
          this._emitUpdate();
          await new Promise(r => setTimeout(r, 500));
        }
        if (this.stopRequested) return;
      }

      this.batchProgress.summary = 'Collecting links from creator replies...';
      this._addLog('Checking creator replies for links...');
      const totals = await this.resources.collect({
        shouldStop: () => this.stopRequested,
        onProgress: ({ creator, index, total }) => {
          this.batchProgress.summary = `Checking @${creator}'s reply (${index} of ${total})...`;
          this._emitUpdate();
        },
      });
      this.lastCollection = totals;
      this._addLog(`Replies checked: ${totals.received} with links, ${totals.needsYou} need you, ${this.queue.countWaitingForReply()} still waiting.`);
      this.batchProgress.summary = 'Saving the CSV and sending your summary...';
      this._emitUpdate();
      this._reportDelivery(await this.resources.deliver());
    } catch (err) {
      logger.error('Error collecting resources', { error: err.message });
      this._addLog(`Could not finish collecting links: ${err.message}`);
    }
  }

  _reportDelivery({ csv, dmCount, dmFailed }) {
    if (csv) {
      this.lastCsvPath = csv.path;
      if (csv.usedFallback) {
        this._addLog(`The CSV is open in another program, so this run was saved to ${csv.path}`);
      }
    }
    if (dmCount > 0) this._addLog(`📨 Sent you ${dmCount} summary message(s) on Instagram.`);
    if (dmFailed) this._addLog('Could not send the summary DM. It will be retried on the next run.');
  }

  /**
   * Every run ends by unfollowing creators past the 48-hour window.
   * Runs after the Reels, so a creator re-shared today is protected again.
   * A problem here never fails the batch.
   */
  async _autoUnfollow() {
    if (this.stopRequested) return;
    try {
      const { eligible, protected: kept } = this.queue.getFollowedCreatorsForUnfollow({ minAgeHours: UNFOLLOW_MIN_AGE_HOURS });
      const candidates = this._realTargets(eligible);
      if (candidates.length === 0) return;

      const targets = candidates.slice(0, AUTO_UNFOLLOW_MAX_PER_RUN);
      this.batchStatus = 'UNFOLLOWING';
      this._addLog(`Unfollowing ${targets.length} creator(s) followed 48h+ ago...`);

      const { unfollowed, failed, stoppedEarly } = await this._unfollowTargets(targets, {
        shouldStop: () => this.stopRequested,
        onProgress: ({ creator, index, total }) => {
          this.batchProgress.summary = `Unfollowing @${creator} (${index} of ${total})...`;
          this._emitUpdate();
        },
      });

      this.lastAutoUnfollowCount = unfollowed.length;
      const left = candidates.length - unfollowed.length;
      this._addLog(`Unfollowed ${unfollowed.length}, ${kept.length} still protected` +
        (failed.length ? `, ${failed.length} failed` : '') +
        (left > 0 ? `. ${left} left for the next run.` : '.'));
      if (stoppedEarly) this._addLog('⚠️ Stopped unfollowing after repeated failures. Instagram may be limiting actions.');
    } catch (err) {
      logger.error('Error during auto-unfollow', { error: err.message });
      this._addLog(`Could not finish unfollowing: ${err.message}`);
    }
  }

  /** In live mode only real follows count; simulated rows never touch the real account. */
  _realTargets(list) {
    return this.isLiveMode ? list.filter(t => t.isLive) : list;
  }

  /** Unfollows one at a time with a human-scale pause. Stops after repeated failures. */
  async _unfollowTargets(targets, { shouldStop = () => false, onProgress } = {}) {
    const unfollowed = [];
    const failed = [];
    let consecutiveFailures = 0;
    let stoppedEarly = false;

    for (let i = 0; i < targets.length; i++) {
      if (shouldStop()) break;
      const t = targets[i];
      if (onProgress) onProgress({ creator: t.creator, index: i + 1, total: targets.length });

      let ok = false;
      try {
        const res = await this.inbox.unfollowCreatorDirect(t.creator, { isSimulation: !this.isLiveMode });
        ok = Boolean(res && res.success);
      } catch {}

      if (ok) {
        unfollowed.push(t.creator);
        this.queue.markCreatorUnfollowed(t.creator);
        consecutiveFailures = 0;
      } else {
        failed.push(t.creator);
        consecutiveFailures += 1;
        if (consecutiveFailures >= UNFOLLOW_MAX_CONSECUTIVE_FAILURES) {
          stoppedEarly = true;
          break;
        }
      }

      this._emitUpdate();
      if (i < targets.length - 1) {
        const pause = this.unfollowPauseMs !== undefined ? this.unfollowPauseMs : 3000 + Math.random() * 3000;
        await new Promise(r => setTimeout(r, pause));
      }
    }
    return { unfollowed, failed, stoppedEarly };
  }

  /** Requests the batch to stop after the Reel currently in progress. */
  stopBatch() {
    if (!this.isBatchRunning) return false;
    this.stopRequested = true;
    this.batchProgress.summary = 'Stopping after the current Reel...';
    this._addLog('Stop requested. Finishing the current Reel first...');
    return true;
  }

  async processJob(job) {
    // Security Gate: only the owner's Reels are ever acted on (covers retried/recovered jobs).
    if (!assertSenderAllowed(job.sender_username, { threadId: job.thread_id, stage: 'PROCESS_JOB' })) {
      this.queue.updateStatus(job.id, JOB_STATUS.FAILED, { errorMessage: 'IGNORED_UNAUTHORIZED_SENDER' });
      return;
    }

    logger.info(`Processing job ${job.id}`, { shortcode: job.shortcode });
    this.currentJob = job;
    this.currentJobId = job.id;

    try {
      this.queue.updateStatus(job.id, JOB_STATUS.EXTRACTING, { stage: 'EXTRACTION' });

      // 1. Reel metadata: creator + caption
      const metadata = await fetchReelPublicData(job.reel_url, this.browserSession);
      const creator = (metadata.creator || '').replace(/^@/, '').trim();
      const caption = metadata.caption || '';

      // Never guess who to follow: without a creator this Reel can't be actioned.
      if (!creator) {
        this.queue.updateStatus(job.id, JOB_STATUS.FAILED, { errorMessage: 'Could not read the creator from the Reel page' });
        this._addLog(`✖ Reel ${job.shortcode}: could not read the creator, skipped.`);
        return;
      }

      // 2. Keyword from caption, or 🙌 when there isn't a clear one
      const reqs = extractCreatorRequirements(caption, '', { defaultToEmoji: true });
      const keyword = (reqs.keyword && reqs.keyword.trim().length > 0 && !reqs.isUnclear) ? reqs.keyword.trim() : '🙌';

      this.queue.createOrGetCreatorInteraction(job.id, {
        creatorUsername: creator,
        shortcode: job.shortcode,
        requiresFollow: 1,
        requiresComment: 1,
        keyword,
        isSimulated: this.isLiveMode ? 0 : 1,
        topic: deriveTopic(caption),
      });

      // 3. Follow the creator, then comment
      this.queue.updateStatus(job.id, JOB_STATUS.INTERACTING, { stage: 'INTERACTION' });
      const creatorResult = await this.creatorManager.executeCreatorWorkflow(job, {
        caption,
        creator,
        keyword,
        isSimulation: !this.isLiveMode,
        approved: true,
      });

      if (creatorResult.success && creatorResult.status === 'COMPLETED') {
        this.queue.updateStatus(job.id, JOB_STATUS.COMPLETED, {
          resultSummary: `Commented '${keyword}' on Reel ${job.shortcode} by @${creator}`,
        });
        this._addLog(`✔ @${creator}: followed + commented "${keyword}"`);
        return;
      }

      this.queue.updateStatus(job.id, JOB_STATUS.FAILED, {
        errorMessage: creatorResult.error || 'Creator interaction failed',
      });
      this._addLog(`✖ Reel ${job.shortcode}: ${creatorResult.error || 'follow/comment failed'}`);
    } catch (err) {
      logger.error(`Error processing job ${job.id}`, { error: err.message });
      this._addLog(`✖ Reel ${job.shortcode}: ${err.message}`);
      this.queue.handleJobError(job.id, err);
    } finally {
      this.currentJob = null;
      this.currentJobId = null;
    }
  }

  /**
   * Unfollows tracked creators.
   * Default: only creators followed at least 48 hours ago. Recently followed
   * creators are always protected unless forceAll is explicitly true.
   * @param {{ forceAll?: boolean }} [options]
   */
  async unfollow(options = {}) {
    const forceAll = options.forceAll === true;
    const begin = this._beginTask('UNFOLLOW');
    if (!begin.ok) return { success: false, count: 0, error: begin.error };

    try {
      const data = this.queue.getFollowedCreatorsForUnfollow({ minAgeHours: UNFOLLOW_MIN_AGE_HOURS });
      const targets = this._realTargets(forceAll ? data.all : data.eligible);
      const protectedCount = forceAll ? 0 : data.protected.length;

      if (targets.length === 0) {
        const message = protectedCount > 0
          ? `Nothing to unfollow yet: ${protectedCount} creator(s) are still inside the 48-hour window.`
          : 'No creators to unfollow.';
        this._addLog(message);
        return { success: true, count: 0, unfollowed: [], failed: [], protectedCount, message };
      }

      this._addLog(`Unfollowing ${targets.length} creator(s)${forceAll ? ' (force all)' : ''}...`);
      const { unfollowed, failed } = await this._unfollowTargets(targets);

      const message = `Unfollowed ${unfollowed.length} creator(s)` +
        (failed.length ? `, ${failed.length} failed` : '') +
        (protectedCount ? `, ${protectedCount} protected` : '') + '.';
      this._addLog(message);
      return { success: true, count: unfollowed.length, unfollowed, failed, protectedCount, message };
    } finally {
      await this.browserSession.close().catch(() => {});
      this._endTask();
    }
  }

  /** Opens a visible browser so the user can sign in to the bot's Instagram account. */
  async login() {
    const begin = this._beginTask('LOGIN');
    if (!begin.ok) return { authenticated: false, reason: begin.error };
    this._addLog('Opening browser for Instagram login...');
    try {
      const result = await this.browserSession.interactiveLogin();
      this.lastLogin = { ...result, at: new Date().toISOString() };
      this._addLog(result.authenticated ? '✅ Instagram login saved.' : `Login not completed: ${result.reason}`);
      return result;
    } catch (err) {
      this._addLog(`Login error: ${err.message}`);
      return { authenticated: false, reason: err.message };
    } finally {
      this._endTask();
    }
  }

  getStatus() {
    const q = this.queue;
    const stats = q.getSystemStats() || {};
    return {
      owner: config.owner,
      status: this.batchStatus || 'IDLE',
      activeTask: this.activeTask,
      isBatchRunning: this.isBatchRunning,
      isLiveMode: this.isLiveMode,
      batchProgress: this.batchProgress,
      queue: {
        pending: stats.pending || 0,
        processing: stats.processing || 0,
        completed: stats.completed || 0,
        failed: stats.failed || 0,
        total: stats.total || 0,
      },
      recentJobs: q.getRecentJobs(8),
      unfollowOverview: q.getFollowedCreatorsForUnfollow({ minAgeHours: UNFOLLOW_MIN_AGE_HOURS }),
      recentLogs: this.recentLogs.slice(-60),
      lastLogin: this.lastLogin,
      csvPath: this.lastCsvPath || config.resourcesCsvPath,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /** Closes the browser and database. Does not exit the process. */
  async shutdown() {
    this.stopRequested = true;
    try {
      await this.browserSession.close();
    } catch (err) {
      logger.error('Error closing browser during shutdown', { error: err.message });
    }
    try {
      this.db.close();
    } catch {}
  }
}

module.exports = ReelLinkApp;
