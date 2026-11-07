const crypto = require('crypto');
const { getDatabase } = require('../storage/database');
const logger = require('../utils/logger');
const config = require('../config');
const { extractReelShortcode, normalizeReelUrl, cleanTrackingParams } = require('../utils/url-helper');

const JOB_STATUS = {
  PENDING: 'PENDING',
  EXTRACTING: 'EXTRACTING',
  SEARCHING: 'SEARCHING',
  PROCESSING: 'PROCESSING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  INTERACTING: 'INTERACTING',
  WAITING_FOR_REPLY: 'WAITING_FOR_REPLY',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
};

class JobQueue {
  constructor(db = getDatabase()) {
    this.db = db;
  }

  /**
   * Enqueues an incoming Reel for processing or retrieves existing.
   * Normalizes URLs (/reel/, /p/, /reels/), strips tracking parameters, and prevents duplication.
   * @param {Object} params
   * @param {string} [params.threadId]
   * @param {string} [params.senderUsername]
   * @param {string} params.reelUrl
   * @param {string} [params.shortcode]
   * @returns {{ job: Object, isDuplicate: boolean }}
   */
  createJob({ threadId, senderUsername, reelUrl, shortcode, messageId, enforceAllowlist = false }) {
    if (enforceAllowlist) {
      const { assertSenderAllowed } = require('../security/sender-allowlist');
      if (!assertSenderAllowed(senderUsername, { threadId, stage: 'QUEUE_CREATE_JOB' })) {
        return { job: null, isDuplicate: false, error: 'UNAUTHORIZED_SENDER' };
      }
    }

    const resolvedShortcode = shortcode || extractReelShortcode(reelUrl);
    const normalizedUrl = normalizeReelUrl(resolvedShortcode || reelUrl) || (reelUrl ? cleanTrackingParams(reelUrl) : null);

    // 1. Deduplication check:
    // If messageId is provided, messageId is the primary unique deduplication key.
    // The same Reel legitimately shared in a NEW message generates a NEW job.
    let existing = null;
    if (messageId) {
      existing = this.db
        .prepare('SELECT * FROM jobs WHERE message_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(messageId);
    } else if (threadId && resolvedShortcode) {
      existing = this.db
        .prepare('SELECT * FROM jobs WHERE thread_id = ? AND shortcode = ? ORDER BY created_at DESC LIMIT 1')
        .get(threadId, resolvedShortcode);
    } else if (resolvedShortcode) {
      existing = this.db
        .prepare('SELECT * FROM jobs WHERE shortcode = ? ORDER BY created_at DESC LIMIT 1')
        .get(resolvedShortcode);
    }

    if (existing) {
      logger.info('Duplicate Reel message detected for thread', {
        threadId,
        messageId,
        shortcode: resolvedShortcode,
        existingStatus: existing.status,
      });
      return { job: existing, isDuplicate: true };
    }

    const id = crypto.randomUUID();
    const maxRetries = config.creatorWorkflow.maxRetries;

    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, thread_id, sender_username, reel_url, shortcode, message_id, status, stage, retry_count, max_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);

    stmt.run(
      id,
      threadId || 'default_thread',
      senderUsername || 'unknown',
      normalizedUrl,
      resolvedShortcode,
      messageId || null,
      JOB_STATUS.PENDING,
      'A',
      maxRetries
    );

    if (messageId) {
      this.recordProcessedMessage({
        messageId,
        threadId: threadId || 'default_thread',
        senderUsername: senderUsername || 'unknown',
        shortcode: resolvedShortcode,
        reelUrl: normalizedUrl,
        ackSent: 0,
        isBaseline: 0,
      });
    }

    this.logAudit(id, 'info', 'queue', 'Job created and enqueued', { reelUrl: normalizedUrl, shortcode: resolvedShortcode, messageId });

    const job = this.getJobById(id);
    return { job, isDuplicate: false };
  }

  /**
   * Checks whether a message ID has already been seen or baselined.
   * @param {string} messageId
   * @returns {boolean}
   */
  isMessageProcessed(messageId) {
    if (!messageId) return false;
    try {
      const row = this.db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?').get(messageId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /**
   * Checks whether an acknowledgment DM was already sent for a message.
   * @param {string} messageId
   * @returns {boolean}
   */
  isMessageAckSent(messageId) {
    if (!messageId) return false;
    try {
      const row = this.db.prepare('SELECT ack_sent FROM processed_messages WHERE message_id = ?').get(messageId);
      return Boolean(row && row.ack_sent === 1);
    } catch {
      return false;
    }
  }

  /**
   * Records a processed or baselined message ID in SQLite.
   */
  recordProcessedMessage({ messageId, threadId, senderUsername, shortcode, reelUrl, ackSent = 0, isBaseline = 0 }) {
    if (!messageId) return false;
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO processed_messages (message_id, thread_id, sender_username, shortcode, reel_url, ack_sent, is_baseline)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        String(threadId),
        senderUsername || 'unknown',
        shortcode || null,
        reelUrl || null,
        ackSent ? 1 : 0,
        isBaseline ? 1 : 0
      );
      return true;
    } catch (err) {
      logger.debug('Error recording processed message', { messageId, error: err.message });
      return false;
    }
  }

  /**
   * Marks a message's acknowledgment as sent.
   */
  markMessageAckSent(messageId) {
    if (!messageId) return;
    try {
      this.db.prepare('UPDATE processed_messages SET ack_sent = 1 WHERE message_id = ?').run(messageId);
    } catch (err) {
      logger.debug('Error marking message ack sent', { messageId, error: err.message });
    }
  }

  /**
   * Explicitly marks a job as approved for live creator actions.
   * @param {string} jobId
   */
  approveJob(jobId) {
    if (!jobId) return false;
    try {
      this.db
        .prepare(`
          UPDATE jobs 
          SET is_approved = 1, 
              approved_at = datetime('now'),
              status = CASE WHEN status IN ('AWAITING_APPROVAL', 'FAILED') THEN 'PENDING' ELSE status END,
              error_message = CASE WHEN status = 'FAILED' THEN NULL ELSE error_message END,
              updated_at = datetime('now')
          WHERE id = ?
        `)
        .run(jobId);

      this.db
        .prepare(`
          UPDATE creator_interactions
          SET follow_status = CASE WHEN follow_status = 'DISABLED' THEN 'NOT_ATTEMPTED' ELSE follow_status END,
              comment_status = CASE WHEN comment_status = 'DISABLED' THEN 'NOT_ATTEMPTED' ELSE comment_status END,
              updated_at = datetime('now')
          WHERE job_id = ?
        `)
        .run(jobId);

      logger.info('Job explicitly approved for live creator actions', { jobId });
      return true;
    } catch (err) {
      logger.error('Error approving job', { jobId, error: err.message });
      return false;
    }
  }

  /**
   * Checks if a job has been approved for live creator interaction.
   * @param {string} jobId
   */
  isJobApproved(jobId) {
    if (!jobId) return false;
    try {
      const job = this.db.prepare('SELECT is_approved FROM jobs WHERE id = ?').get(jobId);
      return Boolean(job && job.is_approved === 1);
    } catch {
      return false;
    }
  }

  /**
   * Retrieves all jobs currently paused in AWAITING_APPROVAL.
   */
  getJobsAwaitingApproval() {
    try {
      return this.db.prepare("SELECT * FROM jobs WHERE status = 'AWAITING_APPROVAL' ORDER BY created_at ASC").all();
    } catch {
      return [];
    }
  }

  /**
   * Alias for createJob: creates or retrieves the SQLite job without duplicating it.
   */
  createOrGetJob(params) {
    return this.createJob(params);
  }

  /**
   * Retrieves a job by ID.
   * @param {string} id
   */
  getJobById(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  getJob(id) {
    return this.getJobById(id);
  }

  /**
   * Fetches the next pending job in FIFO order.
   */
  getNextPendingJob() {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1")
      .get();
  }

  /**
   * Retrieves total count of pending jobs in queue.
   */
  getPendingJobsCount() {
    try {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'PENDING'").get();
      return row ? row.count : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Retrieves total count of completed jobs.
   */
  getCompletedJobsCount() {
    try {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'COMPLETED'").get();
      return row ? row.count : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Retrieves total count of failed jobs.
   */
  getFailedJobsCount() {
    try {
      const row = this.db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'FAILED'").get();
      return row ? row.count : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Updates job status and stage metadata.
   * @param {string} id
   * @param {string} status
   * @param {Object} [updates]
   */
  updateStatus(id, status, updates = {}) {
    const fields = ['status = ?', "updated_at = datetime('now')"];
    const values = [status];

    if (updates.stage) {
      fields.push('stage = ?');
      values.push(updates.stage);
    }
    if (updates.evidence) {
      fields.push('evidence_json = ?');
      values.push(typeof updates.evidence === 'string' ? updates.evidence : JSON.stringify(updates.evidence));
    }
    if (updates.candidateUrl) {
      fields.push('candidate_url = ?');
      values.push(updates.candidateUrl);
    }
    if (updates.resultSummary) {
      fields.push('result_summary = ?');
      values.push(updates.resultSummary);
    }
    if (updates.errorMessage) {
      fields.push('error_message = ?');
      values.push(updates.errorMessage);
    }
    if (updates.isDelivered !== undefined) {
      fields.push('is_delivered = ?', "delivered_at = datetime('now')");
      values.push(updates.isDelivered ? 1 : 0);
    }
    if (status === JOB_STATUS.COMPLETED || status === JOB_STATUS.FAILED) {
      fields.push("completed_at = datetime('now')");
    }

    values.push(id);
    const sql = `UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    this.logAudit(id, status === JOB_STATUS.FAILED ? 'error' : 'info', 'queue', `Job status updated to ${status}`, updates);
  }

  /**
   * Records failure and increments retry count with backoff.
   * If retry limit reached, marks job as FAILED.
   * @param {string} id
   * @param {Error|string} error
   */
  handleJobError(id, error) {
    const job = this.getJobById(id);
    if (!job) return;

    const errMsg = error instanceof Error ? error.message : String(error);
    const nextRetry = job.retry_count + 1;

    if (nextRetry <= job.max_retries) {
      logger.warn(`Job ${id} failed. Scheduling retry ${nextRetry}/${job.max_retries}`, { error: errMsg });
      this.db
        .prepare(`
          UPDATE jobs 
          SET status = 'PENDING', retry_count = ?, error_message = ?, updated_at = datetime('now')
          WHERE id = ?
        `)
        .run(nextRetry, errMsg, id);

      this.logAudit(id, 'warn', 'queue', `Job scheduled for retry ${nextRetry}`, { error: errMsg });
    } else {
      logger.error(`Job ${id} exceeded max retries. Marking FAILED.`, { error: errMsg });
      this.updateStatus(id, JOB_STATUS.FAILED, { errorMessage: errMsg });
    }
  }

  /**
   * Marks a job as having successfully delivered its response DM.
   * @param {string} id
   */
  markDelivered(id) {
    this.db
      .prepare("UPDATE jobs SET is_delivered = 1, delivered_at = datetime('now') WHERE id = ?")
      .run(id);
    this.logAudit(id, 'info', 'queue', 'Job reply marked as delivered');
  }

  /**
   * Recovers stuck jobs after a process crash/restart.
   * Jobs stuck in intermediate states (EXTRACTING, SEARCHING, PROCESSING):
   * - If already delivered (is_delivered == 1), completes immediately to prevent duplicate DMs.
   * - If not delivered and retries remain, returns to PENDING.
   */
  recoverStalledJobs() {
    const stuck = this.db
      .prepare(`
        SELECT * FROM jobs 
        WHERE status IN ('EXTRACTING', 'SEARCHING', 'PROCESSING')
      `)
      .all();

    logger.info(`Checking for stalled jobs on startup: found ${stuck.length}`);

    for (const job of stuck) {
      // Security Gate: Unauthorized senders cannot bypass allowlist via restart/recovery
      const { isSenderAllowed } = require('../security/sender-allowlist');
      if (!isSenderAllowed(job.sender_username)) {
        logger.warn('IGNORED_UNAUTHORIZED_SENDER: Stalled job rejected on recovery', {
          jobId: job.id,
          sender: job.sender_username,
        });
        this.updateStatus(job.id, JOB_STATUS.FAILED, {
          errorMessage: 'IGNORED_UNAUTHORIZED_SENDER: Sender not authorized under allowlist',
        });
        continue;
      }

      if (job.is_delivered === 1) {
        logger.info(`Stalled job ${job.id} was already delivered before crash. Marking COMPLETED to prevent duplicate DM.`);
        this.updateStatus(job.id, JOB_STATUS.COMPLETED, {
          resultSummary: job.result_summary || 'Recovered after delivery crash',
        });
        continue;
      }

      if (job.retry_count < job.max_retries) {
        logger.info(`Recovering stalled job ${job.id} -> PENDING`);
        this.db
          .prepare("UPDATE jobs SET status = 'PENDING', updated_at = datetime('now') WHERE id = ?")
          .run(job.id);
        this.logAudit(job.id, 'warn', 'recovery', 'Job recovered after crash to PENDING');
      } else {
        logger.error(`Stalled job ${job.id} exceeded retries -> FAILED`);
        this.updateStatus(job.id, JOB_STATUS.FAILED, { errorMessage: 'Stalled job failed on recovery' });
      }
    }

    return stuck.length;
  }

  /**
   * Records evaluated candidate URLs in the candidates table.
   * @param {string} jobId
   * @param {Array<Object>} candidates
   */
  saveCandidates(jobId, candidates = []) {
    const stmt = this.db.prepare(`
      INSERT INTO candidates (id, job_id, url, title, domain, score, reasoning, is_selected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of candidates) {
      const cid = crypto.randomUUID();
      stmt.run(
        cid,
        jobId,
        c.url,
        c.title || '',
        c.domain || '',
        c.score || 0,
        c.reasoning || '',
        c.isSelected ? 1 : 0
      );
    }
  }

  /**
   * Appends an audit log entry.
   */
  logAudit(jobId, level, component, message, meta = {}) {
    try {
      this.db
        .prepare(`
          INSERT INTO audit_logs (job_id, level, component, message, metadata_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(jobId, level, component, message, JSON.stringify(meta));
    } catch (err) {
      logger.error('Failed to write audit log', { error: err.message });
    }
  }

  /**
   * Retrieves creator interaction details for a job.
   * @param {string} jobId
   */
  getCreatorInteraction(jobId) {
    return this.db.prepare('SELECT * FROM creator_interactions WHERE job_id = ?').get(jobId);
  }

  /**
   * Creates or gets a creator interaction record for a job.
   */
  createOrGetCreatorInteraction(jobId, { creatorUsername, shortcode, requiresFollow = 0, requiresComment = 0, keyword = null, isSimulated = 0 }) {
    const existing = this.getCreatorInteraction(jobId);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO creator_interactions (
        id, job_id, creator_username, shortcode, requires_follow, requires_comment, keyword, is_simulated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      jobId,
      creatorUsername,
      shortcode,
      requiresFollow ? 1 : 0,
      requiresComment ? 1 : 0,
      keyword || null,
      isSimulated ? 1 : 0
    );

    return this.getCreatorInteraction(jobId);
  }

  /**
   * Updates fields on a creator interaction record.
   * @param {string} jobId
   * @param {Object} updates
   */
  updateCreatorInteraction(jobId, updates = {}) {
    const fields = ["updated_at = datetime('now')"];
    const values = [];

    const allowed = [
      'follow_status',
      'follow_verified_at',
      'comment_status',
      'comment_posted_at',
      'comment_text',
      'reply_status',
      'reply_received_at',
      'extracted_url',
      'review_reason',
      'simulated_follow_status',
      'simulated_follow_at',
      'simulated_comment_status',
      'simulated_comment_at',
      'live_follow_verified_at',
      'live_comment_posted_at',
      'live_comment_verified_at',
      'is_simulated',
      'last_seen_message_id',
      'last_seen_message_text',
      'waiting_since',
      'initial_window_expires_at',
      'last_inbox_check_at',
    ];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    }

    values.push(jobId);
    const sql = `UPDATE creator_interactions SET ${fields.join(', ')} WHERE job_id = ?`;
    this.db.prepare(sql).run(...values);

    this.logAudit(jobId, 'info', 'creator_interaction', 'Creator interaction updated', updates);
    return this.getCreatorInteraction(jobId);
  }

  /**
   * Checks whether a job has a verified live follow on Instagram.
   * Simulation records never qualify as verified live follow.
   * @param {string|Object} jobIdOrInteraction
   * @returns {boolean}
   */
  isLiveFollowVerified(jobIdOrInteraction) {
    const interaction = typeof jobIdOrInteraction === 'string'
      ? this.getCreatorInteraction(jobIdOrInteraction)
      : jobIdOrInteraction;
    if (!interaction) return false;
    if (interaction.is_simulated === 1) return false;
    const isCompleted = interaction.follow_status === 'COMPLETED' || interaction.follow_status === 'ALREADY_FOLLOWING';
    const hasLiveTimestamp = Boolean(interaction.live_follow_verified_at || (interaction.follow_verified_at && interaction.is_simulated === 0));
    return Boolean(isCompleted && hasLiveTimestamp);
  }

  /**
   * Checks whether a job has a verified live comment on Instagram.
   * Simulation records never qualify as verified live comment.
   * @param {string|Object} jobIdOrInteraction
   * @returns {boolean}
   */
  isLiveCommentVerified(jobIdOrInteraction) {
    const interaction = typeof jobIdOrInteraction === 'string'
      ? this.getCreatorInteraction(jobIdOrInteraction)
      : jobIdOrInteraction;
    if (!interaction) return false;
    if (interaction.is_simulated === 1) return false;
    const isPosted = interaction.comment_status === 'POSTED';
    const hasLiveTimestamp = Boolean(interaction.live_comment_posted_at || (interaction.comment_posted_at && interaction.is_simulated === 0));
    return Boolean(isPosted && hasLiveTimestamp);
  }

  /**
   * Safe recovery mechanism for a job contaminated by simulation.
   * Preserves genuine live actions, job history, reply state, and other users' jobs.
   * Only resets demonstrably simulated follow/comment completion records.
   * @param {string} jobId
   * @returns {{ recovered: boolean, reason?: string, job?: Object, interaction?: Object }}
   */
  recoverSimulatedJob(jobId) {
    const job = this.getJobById(jobId);
    if (!job) {
      return { recovered: false, reason: `Job ${jobId} not found` };
    }

    const interaction = this.getCreatorInteraction(jobId);
    if (!interaction) {
      return { recovered: false, reason: `No creator interaction record found for job ${jobId}` };
    }

    // Only reset if demonstrably simulated or unverified live actions
    const hasSimulatedFollow = interaction.is_simulated === 1 || !interaction.live_follow_verified_at;
    const hasSimulatedComment = interaction.is_simulated === 1 || !interaction.live_comment_posted_at;

    if (!hasSimulatedFollow && !hasSimulatedComment) {
      logger.info('Job interaction is already genuinely verified live; no simulation recovery needed', { jobId });
      return { recovered: false, reason: 'Interaction is already verified live', job, interaction };
    }

    // Archive simulated state to dedicated simulated columns
    const simFollow = interaction.simulated_follow_status !== 'NOT_ATTEMPTED'
      ? interaction.simulated_follow_status
      : (interaction.follow_status !== 'NOT_ATTEMPTED' ? interaction.follow_status : 'COMPLETED');
    const simComment = interaction.simulated_comment_status !== 'NOT_ATTEMPTED'
      ? interaction.simulated_comment_status
      : (interaction.comment_status !== 'NOT_ATTEMPTED' ? interaction.comment_status : 'POSTED');

    // Reset interaction: unverified live actions become NOT_ATTEMPTED
    this.db.prepare(`
      UPDATE creator_interactions
      SET follow_status = 'NOT_ATTEMPTED',
          follow_verified_at = NULL,
          live_follow_verified_at = NULL,
          simulated_follow_status = ?,
          simulated_follow_at = COALESCE(simulated_follow_at, follow_verified_at, datetime('now')),
          comment_status = 'NOT_ATTEMPTED',
          comment_posted_at = NULL,
          live_comment_posted_at = NULL,
          simulated_comment_status = ?,
          simulated_comment_at = COALESCE(simulated_comment_at, comment_posted_at, datetime('now')),
          reply_status = 'WAITING',
          waiting_since = NULL,
          initial_window_expires_at = NULL,
          last_inbox_check_at = NULL,
          is_simulated = 0,
          updated_at = datetime('now')
      WHERE job_id = ?
    `).run(simFollow, simComment, jobId);

    // Reset job delivery state if delivered was marked based on simulated window expiry
    if (job.status === 'WAITING_FOR_REPLY' || job.status === 'COMPLETED' || job.is_delivered === 1) {
      this.db.prepare(`
        UPDATE jobs
        SET status = 'PENDING',
            is_delivered = 0,
            delivered_at = NULL,
            result_summary = NULL,
            error_message = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(jobId);
    }

    const updatedJob = this.getJobById(jobId);
    const updatedInteraction = this.getCreatorInteraction(jobId);

    logger.info('Safely recovered simulated job state for live execution resume', {
      jobId,
      shortcode: job.shortcode,
      creator: updatedInteraction.creator_username,
      follow_status: updatedInteraction.follow_status,
      comment_status: updatedInteraction.comment_status,
      simulated_follow_status: updatedInteraction.simulated_follow_status,
      simulated_comment_status: updatedInteraction.simulated_comment_status,
    });

    return {
      recovered: true,
      job: updatedJob,
      interaction: updatedInteraction,
    };
  }

  /**
   * Retrieves all jobs currently waiting for a creator DM reply.
   * Joins creator_interactions to get creator details and window expiry.
   * @returns {Array<Object>}
   */
  getJobsWaitingForReply() {
    return this.db
      .prepare(`
        SELECT j.*, ci.creator_username, ci.keyword, ci.follow_status, ci.comment_status, ci.reply_status,
               ci.simulated_follow_status, ci.simulated_comment_status, ci.live_follow_verified_at, ci.live_comment_posted_at,
               ci.last_seen_message_id, ci.last_seen_message_text, ci.waiting_since,
               ci.initial_window_expires_at, ci.last_inbox_check_at, ci.is_simulated
        FROM jobs j
        JOIN creator_interactions ci ON j.id = ci.job_id
        WHERE j.status = 'WAITING_FOR_REPLY'
        ORDER BY j.created_at ASC
      `)
      .all();
  }

  /**
   * Retrieves all jobs waiting for a specific creator.
   * @param {string} creatorUsername
   * @returns {Array<Object>}
   */
  getJobsWaitingForCreator(creatorUsername) {
    if (!creatorUsername) return [];
    const normalized = creatorUsername.replace(/^@/, '').trim().toLowerCase();
    return this.db
      .prepare(`
        SELECT j.*, ci.creator_username, ci.keyword, ci.follow_status, ci.comment_status, ci.reply_status,
               ci.simulated_follow_status, ci.simulated_comment_status, ci.live_follow_verified_at, ci.live_comment_posted_at,
               ci.last_seen_message_id, ci.last_seen_message_text, ci.waiting_since,
               ci.initial_window_expires_at, ci.last_inbox_check_at, ci.is_simulated
        FROM jobs j
        JOIN creator_interactions ci ON j.id = ci.job_id
        WHERE j.status = 'WAITING_FOR_REPLY' AND LOWER(ci.creator_username) = ?
        ORDER BY j.created_at ASC
      `)
      .all(normalized);
  }

  /**
   * Retrieves activity history for today (or last 24h).
   * Used for bot menu /history and !history commands.
   * @returns {{ followed: Array, replied: Array, pending: Array }}
   */
  getTodayHistory() {
    // 1. Creators followed today
    const followed = this.db
      .prepare(`
        SELECT DISTINCT creator_username,
               MAX(COALESCE(live_follow_verified_at, simulated_follow_at, updated_at)) as followed_at
        FROM creator_interactions
        WHERE follow_status NOT IN ('UNFOLLOWED', 'NOT_ATTEMPTED')
          AND simulated_follow_status != 'UNFOLLOWED'
          AND (follow_status IN ('COMPLETED', 'VERIFIED', 'ALREADY_FOLLOWING')
               OR simulated_follow_status = 'VERIFIED'
               OR live_follow_verified_at IS NOT NULL)
          AND (
            date(COALESCE(live_follow_verified_at, simulated_follow_at, created_at)) >= date('now', '-1 day')
            OR date(created_at) >= date('now', '-1 day')
          )
        GROUP BY creator_username
        ORDER BY followed_at DESC
      `)
      .all();

    // 2. Creators who have replied today (with link or forwarded text)
    const replied = this.db
      .prepare(`
        SELECT j.shortcode, ci.creator_username, ci.reply_status, ci.extracted_url, j.candidate_url,
               ci.last_seen_message_text, ci.reply_received_at, j.status
        FROM creator_interactions ci
        JOIN jobs j ON ci.job_id = j.id
        WHERE (ci.reply_status IN ('RECEIVED', 'FORWARDED_TEXT')
               OR ci.extracted_url IS NOT NULL
               OR j.candidate_url IS NOT NULL)
          AND (
            date(ci.created_at) >= date('now', '-1 day')
            OR date(COALESCE(ci.reply_received_at, ci.updated_at)) >= date('now', '-1 day')
          )
        ORDER BY ci.updated_at DESC
      `)
      .all();

    // 3. Pending creator replies (WAITING_FOR_REPLY)
    const pending = this.db
      .prepare(`
        SELECT j.shortcode, ci.creator_username, j.status, ci.waiting_since, ci.initial_window_expires_at, ci.created_at
        FROM jobs j
        LEFT JOIN creator_interactions ci ON j.id = ci.job_id
        WHERE j.status = 'WAITING_FOR_REPLY'
        ORDER BY j.created_at DESC
      `)
      .all();

    return { followed, replied, pending };
  }

  /**
   * Retrieves summary statistics for the bot status menu.
   * @returns {Object}
   */
  getSystemStats() {
    const counts = this.db
      .prepare(`
        SELECT status, COUNT(*) as count
        FROM jobs
        GROUP BY status
      `)
      .all();

    const stats = {
      pending: 0,
      awaiting_approval: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      waiting: 0,
      total: 0,
    };

    for (const row of counts) {
      stats.total += row.count;
      if (row.status === 'PENDING') stats.pending = row.count;
      else if (row.status === 'AWAITING_APPROVAL') stats.awaiting_approval = row.count;
      else if (['EXTRACTING', 'PROCESSING', 'INTERACTING'].includes(row.status)) stats.processing = row.count;
      else if (row.status === 'COMPLETED') stats.completed = row.count;
      else if (row.status === 'FAILED') stats.failed = row.count;
      else if (row.status === 'CANCELLED') stats.cancelled = row.count;
      else if (row.status === 'WAITING_FOR_REPLY') stats.waiting = row.count;
    }

    return stats;
  }

  /**
   * Retrieves actively processing jobs (e.g. EXTRACTING, PROCESSING, INTERACTING).
   * @returns {Array<Object>}
   */
  getActiveProcessingJobs() {
    try {
      return this.db
        .prepare(`
          SELECT id, shortcode, sender_username, status, stage, created_at, updated_at
          FROM jobs
          WHERE status IN ('EXTRACTING', 'PROCESSING', 'INTERACTING')
          ORDER BY updated_at DESC
        `)
        .all();
    } catch {
      return [];
    }
  }

  /**
   * Retrieves recent failed jobs with their error summaries.
   * @param {number} [limit=5]
   * @returns {Array<Object>}
   */
  getFailedJobs(limit = 5) {
    try {
      return this.db
        .prepare(`
          SELECT j.id, j.shortcode, j.sender_username, j.error_message, j.result_summary, j.updated_at,
                 ci.creator_username
          FROM jobs j
          LEFT JOIN creator_interactions ci ON j.id = ci.job_id
          WHERE j.status = 'FAILED'
          ORDER BY j.updated_at DESC
          LIMIT ?
        `)
        .all(limit);
    } catch {
      return [];
    }
  }

  /**
   * Retrieves recent Reel jobs with full outcome context for history reporting.
   * @param {number} [limit=8]
   * @returns {Array<Object>}
   */
  getRecentJobs(limit = 8) {
    try {
      return this.db
        .prepare(`
          SELECT j.id, j.shortcode, j.sender_username, j.status, j.created_at, j.updated_at, j.result_summary,
                 ci.creator_username, ci.keyword, ci.follow_status, ci.comment_status,
                 ci.is_simulated, ci.simulated_follow_status, ci.simulated_comment_status,
                 ci.live_follow_verified_at, ci.live_comment_posted_at, ci.simulated_follow_at, ci.simulated_comment_at
          FROM jobs j
          LEFT JOIN creator_interactions ci ON j.id = ci.job_id
          ORDER BY j.created_at DESC
          LIMIT ?
        `)
        .all(limit);
    } catch {
      return [];
    }
  }

  /**
   * Retrieves non-terminal jobs eligible for reset (AWAITING_APPROVAL, NEEDS_REVIEW, PENDING).
   * Actively processing (EXTRACTING) and completed jobs are strictly excluded.
   * @param {string|null} [activeJobId=null]
   * @returns {Array<Object>}
   */
  getResetEligibleJobs(activeJobId = null) {
    try {
      const rows = this.db
        .prepare(`
          SELECT j.id, j.shortcode, j.status, j.created_at, ci.creator_username
          FROM jobs j
          LEFT JOIN creator_interactions ci ON j.id = ci.job_id
          WHERE j.status IN ('AWAITING_APPROVAL', 'NEEDS_REVIEW', 'PENDING', 'WAITING_FOR_REPLY')
          ORDER BY j.created_at ASC
        `)
        .all();

      if (activeJobId) {
        return rows.filter(r => r.id !== activeJobId);
      }
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Safely cancels eligible pending and waiting jobs without touching actively processing,
   * completed, or duplicate-prevention history.
   * @param {string|null} [activeJobId=null]
   * @returns {{ count: number, resetJobs: Array<Object> }}
   */
  resetEligibleJobs(activeJobId = null) {
    const eligible = this.getResetEligibleJobs(activeJobId);
    if (eligible.length === 0) {
      return { count: 0, resetJobs: [] };
    }

    const ids = eligible.map(j => j.id);
    const placeholders = ids.map(() => '?').join(',');

    this.db
      .prepare(`
        UPDATE jobs
        SET status = 'CANCELLED',
            result_summary = 'Reset via /reset command',
            updated_at = datetime('now')
        WHERE id IN (${placeholders})
      `)
      .run(...ids);

    this.db
      .prepare(`
        UPDATE creator_interactions
        SET reply_status = 'CANCELLED',
            updated_at = datetime('now')
        WHERE job_id IN (${placeholders})
      `)
      .run(...ids);

    logger.info(`Reset ${eligible.length} eligible pending/waiting job(s) in queue`, { count: eligible.length });
    return { count: eligible.length, resetJobs: eligible };
  }

  /**
   * Resets and cancels all pending and waiting jobs.
   * Backward-compatible wrapper returning the count of reset jobs.
   * @param {string|null} [activeJobId=null]
   * @returns {number} Count of reset jobs
   */
  resetPendingJobs(activeJobId = null) {
    const { count } = this.resetEligibleJobs(activeJobId);
    return count;
  }

  /**
   * Retrieves list of creator usernames followed today.
   * @returns {Array<string>}
   */
  getFollowedCreatorsToday() {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT creator_username
        FROM creator_interactions
        WHERE follow_status NOT IN ('UNFOLLOWED', 'NOT_ATTEMPTED')
          AND simulated_follow_status != 'UNFOLLOWED'
          AND (follow_status IN ('COMPLETED', 'VERIFIED', 'ALREADY_FOLLOWING')
               OR simulated_follow_status = 'VERIFIED'
               OR live_follow_verified_at IS NOT NULL)
          AND (
            date(COALESCE(live_follow_verified_at, simulated_follow_at, created_at)) >= date('now', '-1 day')
            OR date(created_at) >= date('now', '-1 day')
          )
      `)
      .all();

    return rows.map(r => r.creator_username);
  }

  /**
   * Retrieves detailed list of creator usernames followed today,
   * distinguishing live follows from simulated follows.
   * @returns {Array<{ creator: string, isLive: boolean, isSimulated: boolean, followedAt: string }>}
   */
  getDetailedFollowedCreatorsToday() {
    try {
      const rows = this.db
        .prepare(`
          SELECT creator_username,
                 follow_status,
                 simulated_follow_status,
                 is_simulated,
                 live_follow_verified_at,
                 simulated_follow_at,
                 created_at
          FROM creator_interactions
          WHERE (follow_status NOT IN ('UNFOLLOWED', 'NOT_ATTEMPTED') AND (follow_status IN ('COMPLETED', 'VERIFIED', 'ALREADY_FOLLOWING') OR live_follow_verified_at IS NOT NULL))
             OR (simulated_follow_status NOT IN ('UNFOLLOWED', 'NOT_ATTEMPTED') AND simulated_follow_status IN ('COMPLETED', 'VERIFIED', 'ALREADY_FOLLOWING'))
          ORDER BY created_at DESC
        `)
        .all();

      const map = new Map();
      for (const r of rows) {
        const creator = r.creator_username.replace(/^@/, '').trim();
        const isLive = Boolean(r.live_follow_verified_at || (r.follow_status === 'COMPLETED' && r.is_simulated === 0));
        const isSim = Boolean(r.simulated_follow_status === 'COMPLETED' || r.simulated_follow_status === 'ALREADY_FOLLOWING');
        const followedAt = r.live_follow_verified_at || r.simulated_follow_at || r.created_at;

        if (!map.has(creator)) {
          map.set(creator, {
            creator,
            isLive,
            isSimulated: isSim && !isLive,
            followedAt,
          });
        } else {
          const entry = map.get(creator);
          if (isLive) {
            entry.isLive = true;
            entry.isSimulated = false;
            entry.followedAt = r.live_follow_verified_at || entry.followedAt;
          }
        }
      }

      return Array.from(map.values());
    } catch {
      return [];
    }
  }

  /**
   * Retrieves followed creators segmented by retention age (default 48 hours / 2 days).
   * Creators followed >= minAgeHours ago are considered 'eligible' for unfollowing.
   * Creators followed < minAgeHours ago are 'protected' to allow the follow to stick and prevent account churn.
   * @param {Object} [options]
   * @param {number} [options.minAgeHours=48] Minimum follow age in hours before unfollow is recommended
   * @returns {{ eligible: Array<Object>, protected: Array<Object>, all: Array<Object> }}
   */
  getFollowedCreatorsForUnfollow(options = {}) {
    const minAgeHours = options.minAgeHours !== undefined ? options.minAgeHours : 48;
    const all = this.getDetailedFollowedCreatorsToday();
    const now = Date.now();
    const eligible = [];
    const protectedList = [];

    for (const c of all) {
      const followedTimestamp = new Date(c.followedAt).getTime();
      const ageMs = Math.max(0, now - (isNaN(followedTimestamp) ? now : followedTimestamp));
      const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
      const ageDays = (ageMs / (1000 * 60 * 60 * 24)).toFixed(1);
      const remainingHours = Math.max(0, minAgeHours - ageHours);

      const enhanced = {
        ...c,
        ageHours,
        ageDays: parseFloat(ageDays),
        remainingHours,
        isEligible: ageHours >= minAgeHours,
      };

      if (enhanced.isEligible) {
        eligible.push(enhanced);
      } else {
        protectedList.push(enhanced);
      }
    }

    return {
      eligible,
      protected: protectedList,
      all: [...eligible, ...protectedList],
    };
  }

  /**
   * Marks a creator as UNFOLLOWED in creator_interactions.
   * @param {string} creatorUsername
   */
  markCreatorUnfollowed(creatorUsername) {
    if (!creatorUsername) return;
    const normalized = creatorUsername.replace(/^@/, '').trim().toLowerCase();
    this.db.prepare(`
      UPDATE creator_interactions
      SET follow_status = 'UNFOLLOWED',
          simulated_follow_status = 'UNFOLLOWED',
          live_follow_verified_at = NULL,
          follow_verified_at = NULL,
          updated_at = datetime('now')
      WHERE LOWER(creator_username) = ?
    `).run(normalized);
  }
}

module.exports = {
  JobQueue,
  JOB_STATUS,
};
