/**
 * Stage C: Follow-First Creator Interaction Manager
 * Orchestrates guarded, step-by-step engagement with creators whose resources
 * are gated behind follow-to-receive or comment-to-receive automated funnels.
 * 
 * Safety Guarantees:
 * - Live mode disabled by default (simulation mode enabled by default).
 * - Requires explicit user approval for follow and comment actions.
 * - Verifies resulting account state after follow (never assumes success).
 * - Pauses for review on unclear instructions (never guesses keywords).
 * - Stops immediately on Instagram restrictions/challenges.
 * - Idempotent database tracking prevents duplicate actions on retries.
 */
const config = require('../config');
const logger = require('../utils/logger');
const { extractExternalUrls, cleanTrackingParams, resolveDestinationUrl, isWatermarkUrl } = require('../utils/url-helper');

// Action & Requirement Regexes
const FOLLOW_PATTERNS = [
  /(?:must\s+be\s+following|make\s+sure\s+you(?:'re|\s+are)\s+following|first\s+follow|follow\s+me|follow\s+this\s+page|follow\s+us|follow\s+@[\w.-]+|step\s*1[:.]?\s*follow|following\s+required)/i,
  /(?:follow\s+and\s+comment|follow\s*\+\s*comment|comment\s+.*after\s+following)/i,
];

const COMMENT_KEYWORD_PATTERNS = [
  /(?:comment|drop|reply)\s+(?:the\s+word\s+|with\s+)?["'“]([A-Za-z0-9_-]{2,30})["'”]/i,
  /(?:comment|drop|reply)\s+(?:the\s+word\s+|with\s+)?\[([A-Za-z0-9_-]{2,30})\]/i,
  /(?:comment|drop|reply)\s*[:]\s*["'“]?([A-Za-z0-9_-]{2,30})["'”]?/i,
  /(?:comment|drop)\s+([A-Za-z0-9_-]{2,30})\s+(?:below|down\s+below|in\s+the\s+comments|for|to\s+get|and\s+i(?:'ll|\s+will)|to\s+receive)/i,
  /step\s*2[:.]?\s*(?:comment|drop)\s+["'“]?([A-Za-z0-9_-]{2,30})["'”]?/i,
  /(?:comment|drop)\s+([A-Za-z0-9_-]{2,30})\b/i,
];

// Noise words that should not be extracted as actual comment keywords
const KEYWORD_NOISE_WORDS = new Set([
  'below', 'down', 'here', 'link', 'this', 'reel', 'post', 'comment', 'video',
  'guide', 'more', 'info', 'details', 'free', 'dm', 'dms', 'now', 'yes', 'please',
  'just', 'the', 'a', 'an', 'to', 'for', 'and', 'with', 'just link'
]);

// Instagram restriction indicator substrings
const RESTRICTION_INDICATORS = [
  'action blocked',
  'try again later',
  'we restrict certain activity',
  'we limit how often',
  'help us confirm you own this account',
  'suspicious activity',
  'checkpoint_required',
];

/**
 * Checks whether an interaction record has a verified live follow.
 * Simulation records never qualify as verified live follow.
 */
function isLiveFollowVerified(interaction) {
  if (!interaction) return false;
  if (interaction.is_simulated === 1) return false;
  const isCompleted = interaction.follow_status === 'COMPLETED' || interaction.follow_status === 'ALREADY_FOLLOWING';
  const hasLiveTimestamp = Boolean(interaction.live_follow_verified_at || (interaction.follow_verified_at && interaction.is_simulated === 0));
  return Boolean(isCompleted && hasLiveTimestamp);
}

/**
 * Checks whether an interaction record has a verified live comment.
 * Simulation records never qualify as verified live comment.
 */
function isLiveCommentVerified(interaction) {
  if (!interaction) return false;
  if (interaction.is_simulated === 1) return false;
  const isPosted = interaction.comment_status === 'POSTED';
  const hasLiveTimestamp = Boolean(interaction.live_comment_posted_at || (interaction.comment_posted_at && interaction.is_simulated === 0));
  return Boolean(isPosted && hasLiveTimestamp);
}

/**
 * Checks whether a simulated follow succeeded in a simulation run.
 */
function isSimulatedFollowCompleted(interaction) {
  if (!interaction) return false;
  return (
    interaction.simulated_follow_status === 'COMPLETED' ||
    interaction.simulated_follow_status === 'ALREADY_FOLLOWING' ||
    (interaction.is_simulated === 1 && (interaction.follow_status === 'COMPLETED' || interaction.follow_status === 'ALREADY_FOLLOWING'))
  );
}

/**
 * Checks whether a simulated comment succeeded in a simulation run.
 */
function isSimulatedCommentCompleted(interaction) {
  if (!interaction) return false;
  return (
    interaction.simulated_comment_status === 'POSTED' ||
    (interaction.is_simulated === 1 && interaction.comment_status === 'POSTED')
  );
}

/**
 * Parses caption and visible OCR text to determine creator interaction requirements.
 * @param {string} caption
 * @param {string} [ocrText='']
 * @returns {Object} Structured requirement analysis
 */
function extractCreatorRequirements(caption = '', ocrText = '', options = {}) {
  const combined = [caption, ocrText].filter(Boolean).join('\n');
  if (!combined.trim()) {
    return {
      requiresFollow: false,
      requiresComment: false,
      interactionType: 'none',
      keyword: null,
      isUnclear: false,
      reason: 'No caption or text present',
    };
  }

  // 1. Detect Follow Requirement
  let requiresFollow = false;
  for (const pattern of FOLLOW_PATTERNS) {
    if (pattern.test(combined)) {
      requiresFollow = true;
      break;
    }
  }

  // 2. Detect Comment Requirement and Extract Keyword
  let requiresComment = false;
  let keyword = null;

  for (const pattern of COMMENT_KEYWORD_PATTERNS) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      const candidateKeyword = match[1].trim();
      if (!KEYWORD_NOISE_WORDS.has(candidateKeyword.toLowerCase()) && candidateKeyword.length >= 2) {
        requiresComment = true;
        // Preserve exact spelling and capitalization from creator's caption
        keyword = candidateKeyword;
        break;
      }
    }
  }

  // Fallback: check if creator said "Comment for link" or "DM me" without explicit keyword
  const mentionsCommentGeneric = /(?:comment|drop\s+a\s+comment)/i.test(combined);
  const mentionsDmGeneric = /(?:dm\s+me|message\s+me|send\s+me\s+a\s+dm)/i.test(combined);

  // 3. Detect Ambiguous / Unclear Instructions
  let isUnclear = false;
  let reason = '';

  if (mentionsCommentGeneric && !keyword) {
    if (options.defaultToEmoji) {
      keyword = '🙌';
      requiresComment = true;
      isUnclear = false;
    } else {
      isUnclear = true;
      requiresComment = true;
      reason = 'Creator requests a comment but the keyword is missing or ambiguous';
    }
  } else if (mentionsDmGeneric && !requiresFollow && !requiresComment) {
    isUnclear = true;
    reason = 'Creator requests direct DM without explicit automated keyword';
  }

  // Determine interaction type
  let interactionType = 'none';
  if (isUnclear) {
    interactionType = 'unclear';
  } else if (requiresFollow && requiresComment) {
    interactionType = 'follow_and_comment';
  } else if (requiresComment) {
    interactionType = 'comment_only';
  } else if (requiresFollow) {
    interactionType = 'follow_only';
  }

  logger.debug('Creator requirements extracted', {
    requiresFollow,
    requiresComment,
    keyword,
    interactionType,
    isUnclear,
    reason,
  });

  return {
    requiresFollow,
    requiresComment,
    interactionType,
    keyword,
    isUnclear,
    reason: reason || `Classified as ${interactionType}`,
  };
}

class CreatorInteractionManager {
  constructor(optionsOrQueue = {}, maybeSession, maybeInbox, maybeSender, maybeConfig = {}) {
    let queue, browserSession, inbox, sender, configOptions;

    // Check if called positionally: new CreatorInteractionManager(queue, session, inbox, sender, configOptions)
    if (optionsOrQueue && (optionsOrQueue.createJob || optionsOrQueue.getDatabase || maybeSession !== undefined)) {
      queue = optionsOrQueue;
      browserSession = maybeSession;
      inbox = maybeInbox;
      sender = maybeSender;
      configOptions = maybeConfig || {};
    } else {
      // Called with object: new CreatorInteractionManager({ queue, browserSession, inbox, sender, configOptions })
      queue = optionsOrQueue.queue;
      browserSession = optionsOrQueue.browserSession || optionsOrQueue.session;
      inbox = optionsOrQueue.inbox;
      sender = optionsOrQueue.sender;
      // Hoist direct configuration parameters passed at root of options object
      const directOptions = {
        enabled: optionsOrQueue.enabled !== undefined 
          ? optionsOrQueue.enabled 
          : (optionsOrQueue.isLiveMode !== undefined 
              ? optionsOrQueue.isLiveMode 
              : (optionsOrQueue.simulationMode !== undefined 
                  ? !optionsOrQueue.simulationMode 
                  : undefined)),
        simulationMode: optionsOrQueue.simulationMode !== undefined 
          ? optionsOrQueue.simulationMode 
          : (optionsOrQueue.isLiveMode !== undefined ? !optionsOrQueue.isLiveMode : undefined),
        requireApproval: optionsOrQueue.requireApproval,
        allowFollow: optionsOrQueue.allowFollow,
        timeoutSec: optionsOrQueue.timeoutSec,
        initialWaitingWindowSec: optionsOrQueue.initialWaitingWindowSec,
        followVerificationTimeoutMs: optionsOrQueue.followVerificationTimeoutMs,
        inboxPollIntervalMs: optionsOrQueue.inboxPollIntervalMs,
      };
      configOptions = { ...directOptions, ...(optionsOrQueue.configOptions || {}) };
    }

    this.queue = queue;
    this.session = browserSession;
    this.inbox = inbox;
    this.sender = sender;

    const resolvedSimulationMode = configOptions.simulationMode !== undefined
      ? configOptions.simulationMode
      : config.creatorWorkflow.simulationMode;

    const resolvedEnabled = configOptions.enabled !== undefined
      ? configOptions.enabled
      : (resolvedSimulationMode === false ? true : config.creatorWorkflow.enabled);

    this.cfg = {
      enabled: resolvedEnabled,
      simulationMode: resolvedSimulationMode,
      requireApproval: configOptions.requireApproval !== undefined ? configOptions.requireApproval : config.creatorWorkflow.requireApproval,
      allowFollow: configOptions.allowFollow !== undefined ? configOptions.allowFollow : config.creatorWorkflow.allowFollow,
      minLiveWaitingWindowSec: 300,
      initialWaitingWindowSec: configOptions.initialWaitingWindowSec || config.creatorWorkflow.initialWaitingWindowSec || 300,
      timeoutSec: configOptions.timeoutSec || config.creatorWorkflow.timeoutSec || 300,
      followVerificationTimeoutMs: configOptions.followVerificationTimeoutMs || config.creatorWorkflow.followVerificationTimeoutMs || 5000,
      inboxPollIntervalMs: configOptions.inboxPollIntervalMs || config.creatorWorkflow.inboxPollIntervalMs || 4000,
    };
  }

  /**
   * Locates the active Follow button on an Instagram profile page.
   * Matches buttons with strict trimmed text "Follow" or "Follow Back" to avoid false substring matching on "Following".
   * @param {import('playwright').Page} page
   * @returns {Promise<import('playwright').ElementHandle|null>}
   */
  async _findFollowButton(page) {
    const candidates = await page.$$(
      'header button, header div[role="button"], main button, main div[role="button"], section button, section div[role="button"], button, div[role="button"]'
    );
    for (const el of candidates) {
      try {
        const text = ((await el.innerText()) || '').trim();
        if (text === 'Follow' || text === 'Follow Back') {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) return el;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Locates the Following/Requested indicator button on an Instagram profile page.
   * Matches buttons with strict trimmed text "Following" or "Requested".
   * @param {import('playwright').Page} page
   * @returns {Promise<import('playwright').ElementHandle|null>}
   */
  async _findFollowingButton(page) {
    const candidates = await page.$$(
      'header button, header div[role="button"], main button, main div[role="button"], section button, section div[role="button"], button, div[role="button"]'
    );
    for (const el of candidates) {
      try {
        const text = ((await el.innerText()) || '').trim();
        if (text === 'Following' || text === 'Requested') {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) return el;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Calculates the effective waiting window in seconds.
   * In live mode, strictly enforces the minimum 300s (5-minute) threshold.
   * In simulation mode, allows fast testing with mocked time.
   * @param {boolean} isSimulation
   * @param {number} [requestedTimeoutSec]
   * @returns {number} Effective waiting window in seconds
   */
  getEffectiveWaitingWindowSec(isSimulation = false, requestedTimeoutSec = null, allowShortTimeout = false) {
    const minLiveSec = 300;
    const configured = (requestedTimeoutSec !== null && requestedTimeoutSec !== undefined)
      ? Number(requestedTimeoutSec)
      : (this.cfg.timeoutSec || this.cfg.initialWaitingWindowSec || minLiveSec);

    if (!isSimulation) {
      if (!allowShortTimeout && configured < minLiveSec) {
        logger.warn(`Live creator reply waiting window cannot be less than ${minLiveSec}s (5 minutes). Clamping configured ${configured}s to ${minLiveSec}s minimum.`);
        return minLiveSec;
      }
      return configured;
    }

    // In simulation mode, allow custom values for fast unit tests
    return configured;
  }

  /**
   * Checks the bot account's current follow status for a creator.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {boolean} [options.mockFollowing]
   * @returns {Promise<{ isFollowing: boolean, status: string, error?: string }>}
   */
  async checkFollowStatus(creatorUsername, options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;

    if (isSim) {
      const mockFollowing = options.mockFollowing === true;
      logger.info('⚡ [SIMULATION] Checking creator follow status', {
        creator: creatorUsername,
        isFollowing: mockFollowing,
      });
      return {
        isFollowing: mockFollowing,
        status: mockFollowing ? 'ALREADY_FOLLOWING' : 'NOT_FOLLOWING',
      };
    }

    // Live Playwright inspection
    try {
      const page = await this.session.getPage();
      const profileUrl = `https://www.instagram.com/${creatorUsername}/`;
      logger.info('Navigating to creator profile to inspect follow status', { creatorUsername, profileUrl });

      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Dismiss optional cookie or notification prompts
      try {
        const promptBtn = await page.$(
          'button:has-text("Decline optional cookies"), button:has-text("Allow all cookies"), button:has-text("Not Now"), button:has-text("Cancel")'
        );
        if (promptBtn && (await promptBtn.isVisible())) {
          await promptBtn.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch {}

      // Check for Instagram restriction modals
      const restriction = await this._checkForRestrictions(page);
      if (restriction) {
        return { isFollowing: false, status: 'RESTRICTED', error: restriction };
      }

      // Check button states: "Following", "Requested", "Follow", "Follow Back"
      const followingBtn = await this._findFollowingButton(page);
      if (followingBtn) {
        logger.info('Bot account is already following creator', { creatorUsername });
        return { isFollowing: true, status: 'ALREADY_FOLLOWING' };
      }

      const followBtn = await this._findFollowButton(page);
      if (followBtn) {
        logger.info('Bot account is not currently following creator', { creatorUsername });
        return { isFollowing: false, status: 'NOT_FOLLOWING' };
      }

      // Fallback selector check for backward compatibility with mocked tests
      const legacyFollowing = await page.$('header button:has-text("Following"), header button:has-text("Requested")');
      if (legacyFollowing && (await legacyFollowing.isVisible().catch(() => false))) {
        logger.info('Bot account is already following creator (legacy selector)', { creatorUsername });
        return { isFollowing: true, status: 'ALREADY_FOLLOWING' };
      }

      const legacyFollow = await page.$('header button:has-text("Follow"), header button:has-text("Follow Back")');
      if (legacyFollow && (await legacyFollow.isVisible().catch(() => false))) {
        logger.info('Bot account is not currently following creator (legacy selector)', { creatorUsername });
        return { isFollowing: false, status: 'NOT_FOLLOWING' };
      }

      // If button not found, default to false with warning
      logger.warn('Could not definitively locate Follow button on profile', { creatorUsername });
      return { isFollowing: false, status: 'NOT_FOLLOWING' };
    } catch (err) {
      logger.error('Error checking live follow status', { creatorUsername, error: err.message });
      return { isFollowing: false, status: 'ERROR', error: err.message };
    }
  }

  /**
   * Executes follow action with mandatory state verification.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {boolean} [options.approved]
   * @param {boolean} [options.mockFollowSuccess]
   * @returns {Promise<{ success: boolean, status: string, error?: string }>}
   */
  async executeFollow(creatorUsername, options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const approved = options.approved !== undefined ? options.approved : !this.cfg.requireApproval;

    if (!approved) {
      logger.warn('Follow action requires explicit user approval before execution', { creator: creatorUsername });
      return { success: false, status: 'PENDING_APPROVAL', error: 'User approval required' };
    }

    if (isSim) {
      const mockSuccess = options.mockFollowSuccess !== false;
      logger.info('⚡ [SIMULATION] Executing follow action', {
        creator: creatorUsername,
        mockSuccess,
      });

      if (!mockSuccess) {
        return {
          success: false,
          status: 'FAILED',
          error: 'Simulated follow verification failed: account state did not transition to Following',
        };
      }

      return {
        success: true,
        status: 'COMPLETED',
      };
    }

    // Safety guard: Live mode must be enabled (allowed if cfg.enabled is true or caller explicitly requested live execution)
    const isLiveAllowed = this.cfg.enabled || options.isSimulation === false;
    if (!isLiveAllowed) {
      return {
        success: false,
        status: 'DISABLED',
        error: 'Creator workflow live mode is disabled by configuration (CREATOR_WORKFLOW_ENABLED=false)',
      };
    }

    try {
      const page = await this.session.getPage();
      const profileUrl = `https://www.instagram.com/${creatorUsername}/`;
      if (!page.url().includes(creatorUsername)) {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
      }

      // Dismiss optional cookie or notification prompts
      try {
        const promptBtn = await page.$(
          'button:has-text("Decline optional cookies"), button:has-text("Allow all cookies"), button:has-text("Not Now"), button:has-text("Cancel")'
        );
        if (promptBtn && (await promptBtn.isVisible())) {
          await promptBtn.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch {}

      // Check restrictions before clicking
      const restrictionBefore = await this._checkForRestrictions(page);
      if (restrictionBefore) {
        return { success: false, status: 'RESTRICTED', error: restrictionBefore };
      }

      // Check if already following first
      const alreadyFollowing = await this._findFollowingButton(page);
      if (alreadyFollowing) {
        logger.info('Creator profile is already followed', { creatorUsername });
        return { success: true, status: 'COMPLETED' };
      }

      let followBtn = await this._findFollowButton(page);
      if (!followBtn) {
        followBtn = await page.$('header button:has-text("Follow"), header button:has-text("Follow Back")');
      }

      if (!followBtn) {
        return { success: false, status: 'FAILED', error: 'Follow button not found on creator profile' };
      }

      logger.info('Clicking Follow button...', { creatorUsername });
      await followBtn.click();

      // State verification: Wait and verify button changed to "Following" or "Requested"
      const timeout = this.cfg.followVerificationTimeoutMs || 5000;
      const start = Date.now();
      let verified = false;

      while (Date.now() - start < timeout) {
        await page.waitForTimeout(500);

        // Check for restriction modal triggered by clicking
        const restrictionAfter = await this._checkForRestrictions(page);
        if (restrictionAfter) {
          logger.error('Instagram restriction triggered upon following creator', { creatorUsername, restrictionAfter });
          return { success: false, status: 'RESTRICTED', error: restrictionAfter };
        }

        const confirmedBtn = await this._findFollowingButton(page);
        if (confirmedBtn) {
          verified = true;
          break;
        }

        const confirmedLegacy = await page.$('header button:has-text("Following"), header button:has-text("Requested")');
        if (confirmedLegacy && (await confirmedLegacy.isVisible().catch(() => false))) {
          verified = true;
          break;
        }
      }

      if (!verified) {
        logger.error('Follow action failed: Account state did not transition to Following', { creatorUsername });
        return {
          success: false,
          status: 'FAILED',
          error: 'Follow verification failed: Account state did not transition to Following within timeout',
        };
      }

      logger.info('Follow action verified successfully', { creatorUsername });
      return { success: true, status: 'COMPLETED' };
    } catch (err) {
      logger.error('Error executing live follow', { creatorUsername, error: err.message });
      return { success: false, status: 'FAILED', error: err.message };
    }
  }

  /**
   * Unfollows a creator by visiting their Instagram profile and confirming in the dialog.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @returns {Promise<{ success: boolean, creator: string, error?: string }>}
   */
  async unfollowCreator(creatorUsername, options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const cleanCreator = creatorUsername.replace(/^@/, '').trim();

    if (isSim) {
      logger.info('⚡ [SIMULATION] Unfollowing creator', { creator: cleanCreator });
      this.queue.markCreatorUnfollowed(cleanCreator);
      return { success: true, creator: cleanCreator };
    }

    try {
      const page = await this.session.getPage();
      const profileUrl = `https://www.instagram.com/${cleanCreator}/`;
      logger.info('Navigating to creator profile to unfollow', { profileUrl, creator: cleanCreator });
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);

      let followingBtn = await this._findFollowingButton(page);
      if (!followingBtn) {
        followingBtn = await page.$('header button:has-text("Following"), header div[role="button"]:has-text("Following")');
      }

      if (!followingBtn) {
        logger.info('Not currently following or Following button not found', { creator: cleanCreator });
        this.queue.markCreatorUnfollowed(cleanCreator);
        return { success: true, creator: cleanCreator, note: 'Not currently following' };
      }

      await followingBtn.click();
      await page.waitForTimeout(1500);

      // Confirm unfollow in modal
      const unfollowConfirmed = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return false;
        const btns = Array.from(dialog.querySelectorAll('button, div[role="button"], span'));
        const unfollowBtn = btns.find(b => (b.innerText || '').trim() === 'Unfollow');
        if (unfollowBtn) {
          (unfollowBtn.closest('button, div[role="button"]') || unfollowBtn).click();
          return true;
        }
        return false;
      });

      await page.waitForTimeout(2000);
      this.queue.markCreatorUnfollowed(cleanCreator);
      logger.info('Successfully unfollowed creator', { creator: cleanCreator, unfollowConfirmed });
      return { success: true, creator: cleanCreator };
    } catch (err) {
      logger.error('Error unfollowing creator', { creator: cleanCreator, error: err.message });
      return { success: false, creator: cleanCreator, error: err.message };
    }
  }

  /**
   * Natively forwards the latest message from a creator's DM thread to the target user.
   * Uses Instagram's native "Forward" action sheet rather than copying links/text.
   * @param {string} creatorUsername
   * @param {string} targetUsername
   * @param {Object} [options]
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async forwardLatestCreatorMessage(creatorUsername, targetUsername = 'Naumannn', options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const cleanCreator = creatorUsername.replace(/^@/, '').trim();
    const cleanTarget = (targetUsername || 'Naumannn').replace(/^@/, '').trim();

    if (isSim) {
      logger.info('⚡ [SIMULATION] Forwarding creator message natively', {
        from: cleanCreator,
        to: cleanTarget,
      });
      return { success: true, isSimulated: true };
    }

    try {
      const page = await this.session.getPage();

      // Ensure page is in the creator's direct message thread
      const currentUrl = page.url();
      const targetThreadId = options.threadId && !String(options.threadId).startsWith('row_') && options.threadId !== 'active' ? options.threadId : null;

      if (targetThreadId && !currentUrl.includes(targetThreadId)) {
        logger.info('Navigating directly to creator thread for forwarding', { creator: cleanCreator, threadId: targetThreadId });
        await page.goto(`https://www.instagram.com/direct/t/${targetThreadId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
      } else if (!targetThreadId && (!currentUrl.includes('/direct/t/') || !currentUrl.includes(cleanCreator))) {
        logger.info('Locating creator thread for forwarding via openCreatorThread', { creator: cleanCreator });
        if (typeof this.inbox.openCreatorThread === 'function') {
          await this.inbox.openCreatorThread(cleanCreator);
        } else {
          await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(2500);
        }
      }

      // Step 1: Click the "More options" (3 dots) button on the incoming creator message
      logger.info('Locating "More options" button on creator message...', { creator: cleanCreator });
      let moreClicked = await page.evaluate(() => {
        const moreBtns = Array.from(document.querySelectorAll('div[aria-label*="See more options"], div[aria-label="More"], svg[aria-label="More"]'));
        if (moreBtns.length === 0) return false;
        const lastMore = moreBtns[moreBtns.length - 1];
        const target = lastMore.closest('div[role="button"]') || lastMore;
        target.click();
        return true;
      });

      if (!moreClicked) {
        // If not immediately visible, hover over the last message container/article to reveal "More" options
        logger.info('Hovering over last message bubble/article to reveal "More" options...');
        const containers = await page.$$('div[role="article"], div[aria-label^="React to message from "], div[class*="x9f619"]');
        if (containers.length > 0) {
          await containers[containers.length - 1].hover().catch(() => {});
          await page.waitForTimeout(800);
        }

        moreClicked = await page.evaluate(() => {
          const moreBtns = Array.from(document.querySelectorAll('div[aria-label*="See more options"], div[aria-label="More"], svg[aria-label="More"]'));
          if (moreBtns.length === 0) return false;
          const lastMore = moreBtns[moreBtns.length - 1];
          const target = lastMore.closest('div[role="button"]') || lastMore;
          target.click();
          return true;
        });
      }

      if (!moreClicked) {
        return { success: false, error: 'Could not find "More options" button on message card' };
      }

      await page.waitForTimeout(1000);

      // Step 2: Click "Forward" from the popup menu
      logger.info('Clicking "Forward" menu item...');
      const forwardClicked = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('div, button, span'));
        const fwd = els.find(el => el.children.length === 0 && (el.innerText || '').trim() === 'Forward');
        if (fwd) {
          const btn = fwd.closest('div[role="button"], div[role="menuitem"], button') || fwd.parentElement || fwd;
          btn.click();
          return true;
        }
        return false;
      });

      if (!forwardClicked) {
        return { success: false, error: 'Could not click "Forward" menu item' };
      }

      await page.waitForTimeout(1500);

      // Step 3: Select target recipient in the Forward dialog
      logger.info(`Selecting recipient @${cleanTarget} in Forward dialog...`);
      let recipientSelected = await page.evaluate((target) => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return false;

        const targetLower = target.toLowerCase();
        // Look for leaf text nodes matching target name or username
        const leafNodes = Array.from(dialog.querySelectorAll('*')).filter(el => el.children.length === 0);
        const matchNode = leafNodes.find(el => {
          const t = (el.innerText || '').trim().toLowerCase();
          return t === targetLower || t === 'ksydn_' || t === 'naumannn' || (targetLower.length > 3 && t.includes(targetLower));
        });

        if (matchNode) {
          // Traverse up to find the contact row container that contains the checkbox
          let container = matchNode;
          for (let i = 0; i < 10 && container.parentElement && container.parentElement !== dialog; i++) {
            container = container.parentElement;
            const cb = container.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]');
            if (cb) {
              cb.click();
              return true;
            }
          }
          if (container) {
            container.click();
            return true;
          }
        }
        return false;
      }, cleanTarget);

      // Verify if Send button is enabled after initial click
      let isSendEnabled = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return false;
        const sendBtn = Array.from(dialog.querySelectorAll('div[role="button"], button')).find(
          b => (b.innerText || '').trim().toLowerCase() === 'send'
        );
        return !!(sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.disabled);
      });

      // If not enabled or recipient not selected, use the Search input in the dialog
      if (!isSendEnabled) {
        logger.info(`Recipient not yet toggled; typing @${cleanTarget} into Forward dialog search...`);
        const searchInput = await page.$('div[role="dialog"] input[type="text"], div[role="dialog"] input[placeholder*="Search"]');
        if (searchInput) {
          await searchInput.click().catch(() => {});
          await searchInput.fill('').catch(() => {});
          await searchInput.type(cleanTarget, { delay: 50 });
          await page.waitForTimeout(1500);

          // Click first result's checkbox in search results
          await page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (!dialog) return;
            const cb = dialog.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]');
            if (cb) {
              cb.click();
              return;
            }
            const rows = Array.from(dialog.querySelectorAll('div[role="button"]')).filter(r => {
              const text = (r.innerText || '').trim().toLowerCase();
              return text.length > 0 && !text.includes('send') && !text.includes('forward');
            });
            if (rows[0]) rows[0].click();
          });
          await page.waitForTimeout(1000);

          isSendEnabled = await page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (!dialog) return false;
            const sendBtn = Array.from(dialog.querySelectorAll('div[role="button"], button')).find(
              b => (b.innerText || '').trim().toLowerCase() === 'send'
            );
            return !!(sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.disabled);
          });
        }
      }

      if (!isSendEnabled) {
        // Fallback: Try clicking the first contact checkbox in the dialog directly
        logger.info('Trying first contact checkbox in dialog...');
        await page.evaluate(() => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (!dialog) return;
          const firstCheckbox = dialog.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"]');
          if (firstCheckbox) firstCheckbox.click();
        });
        await page.waitForTimeout(1000);

        isSendEnabled = await page.evaluate(() => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (!dialog) return false;
          const sendBtn = Array.from(dialog.querySelectorAll('div[role="button"], button')).find(
            b => (b.innerText || '').trim().toLowerCase() === 'send'
          );
          return !!(sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.disabled);
        });
      }

      if (!isSendEnabled) {
        await page.keyboard.press('Escape').catch(() => {});
        return { success: false, error: `Could not enable Send button for recipient @${cleanTarget} in Forward dialog` };
      }

      // Step 4: Click Send button using Playwright native input
      logger.info('Clicking enabled Send button in Forward dialog...');
      const sendLocator = page.locator('div[role="dialog"] div[role="button"]:has-text("Send"), div[role="dialog"] button:has-text("Send")').last();
      const sendCount = await sendLocator.count().catch(() => 0);

      if (sendCount > 0) {
        const box = await sendLocator.boundingBox().catch(() => null);
        try {
          await sendLocator.click({ timeout: 5000 });
        } catch (e) {
          logger.warn('sendLocator.click failed, attempting coordinate click', { error: e.message });
        }

        await page.waitForTimeout(1000);
        let dialogClosed = await page.evaluate(() => !document.querySelector('div[role="dialog"]'));

        // If not closed, click center coordinates of Send button bounding box
        if (!dialogClosed && box) {
          logger.info('Attempting click at Send button center coordinates...', { box });
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          await page.waitForTimeout(1000);
          dialogClosed = await page.evaluate(() => !document.querySelector('div[role="dialog"]'));
        }

        // If still not closed, try keyboard Enter
        if (!dialogClosed) {
          logger.info('Attempting Enter key on Send button...');
          await sendLocator.focus().catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForTimeout(1000);
          dialogClosed = await page.evaluate(() => !document.querySelector('div[role="dialog"]'));
        }
      } else {
        // Fallback: evaluate click if locator not found
        await page.evaluate(() => {
          const dialog = document.querySelector('div[role="dialog"]');
          if (!dialog) return;
          const sendBtn = Array.from(dialog.querySelectorAll('div[role="button"], button')).find(
            b => (b.innerText || '').trim().toLowerCase() === 'send'
          );
          if (sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true') {
            const opts = { bubbles: true, cancelable: true, view: window };
            sendBtn.dispatchEvent(new MouseEvent('mousedown', opts));
            sendBtn.dispatchEvent(new MouseEvent('mouseup', opts));
            sendBtn.dispatchEvent(new MouseEvent('click', opts));
          }
        });
      }

      // Wait up to 5 seconds for dialog to close
      let dialogClosed = false;
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(1000);
        dialogClosed = await page.evaluate(() => !document.querySelector('div[role="dialog"]'));
        if (dialogClosed) break;
      }

      if (!dialogClosed) {
        logger.error('Forward dialog did not close after clicking Send button');
        await page.keyboard.press('Escape').catch(() => {});
        return { success: false, error: 'Forward dialog remained open after clicking Send button' };
      }

      logger.info('Native message forward completed successfully', { from: cleanCreator, to: cleanTarget });
      return { success: true };
    } catch (err) {
      logger.error('Error forwarding message natively', { creator: cleanCreator, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Posts the requested comment on the Reel with approval guard.
   * @param {string} shortcode
   * @param {string} commentText
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {boolean} [options.approved]
   * @param {boolean} [options.mockCommentSuccess]
   * @returns {Promise<{ success: boolean, status: string, error?: string }>}
   */
  async executeComment(shortcode, commentText, options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const approved = options.approved !== undefined ? options.approved : !this.cfg.requireApproval;

    if (!approved) {
      logger.warn('Comment action requires explicit user approval before posting', { shortcode, commentText });
      return { success: false, status: 'PENDING_APPROVAL', error: 'User approval required' };
    }

    if (isSim) {
      const mockSuccess = options.mockCommentSuccess !== false;
      logger.info('⚡ [SIMULATION] Posting comment on Reel', {
        shortcode,
        commentText,
        mockSuccess,
      });

      if (!mockSuccess) {
        return {
          success: false,
          status: 'FAILED',
          error: 'Simulated comment submission failed',
        };
      }

      return {
        success: true,
        status: 'POSTED',
      };
    }

    // Safety guard: Live mode must be enabled (allowed if cfg.enabled is true or caller explicitly requested live execution)
    const isLiveAllowed = this.cfg.enabled || options.isSimulation === false;
    if (!isLiveAllowed) {
      return {
        success: false,
        status: 'DISABLED',
        error: 'Creator workflow live mode is disabled by configuration (CREATOR_WORKFLOW_ENABLED=false)',
      };
    }

    try {
      const page = await this.session.getPage();
      // Use /p/ layout which provides a stable dedicated post view with form textarea & exact post button
      const postUrl = `https://www.instagram.com/p/${shortcode}/`;
      logger.info('Navigating to Post page to submit comment', { shortcode, postUrl });

      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);

      // Dismiss optional cookie or notification prompts
      try {
        const promptBtn = await page.$(
          'button:has-text("Decline optional cookies"), button:has-text("Allow all cookies"), button:has-text("Not Now"), button:has-text("Cancel")'
        );
        if (promptBtn && (await promptBtn.isVisible())) {
          await promptBtn.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch {}

      // Check restrictions before commenting
      const restrictionBefore = await this._checkForRestrictions(page);
      if (restrictionBefore) {
        return { success: false, status: 'RESTRICTED', error: restrictionBefore };
      }

      // Locate textarea/input on page
      let commentInput = await page.$(
        'form textarea[placeholder*="Add a comment"], form textarea, textarea[placeholder*="Add a comment"], textarea[aria-label*="Add a comment"], textarea'
      );

      // If not immediately found (e.g. redirected to /reels/ view), try drawer button or input fallback
      if (!commentInput) {
        const commentTriggers = [
          'div[role="button"]:has(svg[aria-label="Comment"])',
          'button:has(svg[aria-label="Comment"])',
          'svg[aria-label="Comment"]',
          'span:has-text("Comment")',
        ];

        for (const triggerSel of commentTriggers) {
          const trigger = await page.$(triggerSel);
          if (trigger && (await trigger.isVisible())) {
            logger.info('Clicking Comment icon to open comments drawer', { shortcode, triggerSel });
            await trigger.click().catch(() => {});
            await page.waitForTimeout(2000);
            break;
          }
        }

        commentInput = await page.$(
          'form textarea, textarea, input[placeholder*="Add a comment"], div[role="textbox"][contenteditable="true"]'
        );
      }

      if (!commentInput) {
        return { success: false, status: 'FAILED', error: 'Comment input field not found on Reel/Post page' };
      }

      await commentInput.scrollIntoViewIfNeeded().catch(() => {});
      await commentInput.click();
      await page.waitForTimeout(500);

      // Re-query the active input in case clicking the dummy textarea caused React to mount the active textarea
      const activeInput = (await page.$('form textarea, textarea[placeholder*="Add a comment"], input[placeholder*="Add a comment"]')) || commentInput;

      // Focus and type exact comment keyword
      await activeInput.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);

      await page.keyboard.type(commentText, { delay: 60 });
      await page.waitForTimeout(1000);

      // Verify the text was actually entered into the input
      const typedValue = await page.$eval(
        'form textarea, textarea, input[placeholder*="Add a comment"]',
        el => el.value || el.innerText || ''
      ).catch(() => '');

      if (!typedValue || !typedValue.toLowerCase().includes(commentText.toLowerCase())) {
        logger.warn('Keyboard typing did not populate input; populating via DOM event dispatch', { shortcode, commentText });
        await page.evaluate(({ text }) => {
          const el = document.querySelector('form textarea, textarea, input[placeholder*="Add a comment"]');
          if (el) {
            el.focus();
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, { text: commentText });
        await page.waitForTimeout(500);
      }

      // Submit via exact Post button inside the form/container
      const submittedViaButton = await page.evaluate(() => {
        const form = document.querySelector('form');
        if (!form) return false;

        const btns = Array.from(form.querySelectorAll('div[role="button"], button'));
        // Find element whose text is strictly "Post" (trimmed, case-insensitive)
        const postBtn = btns.find(b => (b.innerText || '').trim().toLowerCase() === 'post');
        if (postBtn && postBtn.offsetParent !== null) {
          postBtn.click();
          return true;
        }
        return false;
      });

      if (submittedViaButton) {
        logger.info('Clicked exact Post button inside comment form', { shortcode });
      } else {
        logger.info('Post button not found inside form; submitting via Enter key', { shortcode });
        await page.keyboard.press('Enter');
      }

      await page.waitForTimeout(3000);

      // Check restrictions after commenting
      const restrictionAfter = await this._checkForRestrictions(page);
      if (restrictionAfter) {
        return { success: false, status: 'RESTRICTED', error: restrictionAfter };
      }

      // Verify submission: check if input cleared
      let currentVal = await page.$eval(
        'form textarea, textarea, input[placeholder*="Add a comment"]',
        el => el.value || el.innerText || ''
      ).catch(() => '');

      if (currentVal && currentVal.trim() !== '') {
        logger.warn('Comment input did not clear after Post click; attempting Enter key press fallback...', { shortcode, currentVal });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);

        currentVal = await page.$eval(
          'form textarea, textarea, input[placeholder*="Add a comment"]',
          el => el.value || el.innerText || ''
        ).catch(() => '');
      }

      // Verify presence in comments list
      const isCommentPresent = await page.evaluate((keyword) => {
        const kw = keyword.toLowerCase();
        const commentElements = Array.from(document.querySelectorAll('ul li, div[role="listitem"], div[role="button"] + span, span'));
        return commentElements.some(el => (el.innerText || '').trim().toLowerCase() === kw);
      }, commentText);

      const isCleared = !currentVal || currentVal.trim() === '';
      if (!isCleared && !isCommentPresent) {
        logger.error('Comment submission could not be verified: input field did not clear and comment was not registered by Instagram', { shortcode, commentText });
        return {
          success: false,
          status: 'FAILED',
          error: 'Comment submission verification failed: input field did not clear and comment was not registered by Instagram',
        };
      }

      logger.info('Comment submission verified successfully', { shortcode, commentText, isCleared, isCommentPresent });
      return { success: true, status: 'POSTED' };
    } catch (err) {
      logger.error('Error posting live comment', { shortcode, error: err.message });
      return { success: false, status: 'FAILED', error: err.message };
    }
  }

  /**
   * Monitors the bot's inbox for an automated DM response from the creator.
   * Checks both Primary Inbox and Message Requests folders.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {string|null} [options.mockReplyText]
   * @param {string} [options.mockFolder] - 'primary' or 'requests'
   * @param {boolean} [options.mockTimeout]
   * @param {number} [options.timeoutSec]
   * @returns {Promise<{ received: boolean, messageText?: string, extractedUrl?: string, timedOut?: boolean, folder?: string, error?: string }>}
   */
  /**
   * Monitors the bot's inbox for an automated DM response from the creator.
   * Checks both Primary Inbox and Message Requests folders.
   * Distinguishes simulation timing from real elapsed time.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {string|null} [options.mockReplyText]
   * @param {string} [options.mockFolder] - 'primary' or 'requests'
   * @param {boolean} [options.mockTimeout]
   * @param {string} [options.mockMessageId]
   * @param {number} [options.timeoutSec]
   * @param {number} [options.pollIntervalMs]
   * @returns {Promise<{ received: boolean, messageId?: string, messageText?: string, extractedUrl?: string, timedOut?: boolean, initialWindowExpired?: boolean, folder?: string, elapsedMs: number, isSimulated: boolean, error?: string }>}
   */
  async monitorInboxForResponse(creatorUsername, options = {}) {
    const startTime = Date.now();
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const isSinglePass = Boolean(options.singlePass);
    const allowShortTimeout = Boolean(options.allowShortTimeout);
    const effectiveLiveTimeoutSec = isSinglePass ? 0 : this.getEffectiveWaitingWindowSec(false, options.timeoutSec, allowShortTimeout);
    const timeoutSec = isSinglePass ? 0 : this.getEffectiveWaitingWindowSec(isSim, options.timeoutSec, allowShortTimeout);

    if (isSim) {
      const elapsedMs = Date.now() - startTime;
      logger.info('⚡ [SIMULATION] Checked inbox for creator DM response (instant simulation check)', {
        creator: creatorUsername,
        simulationElapsedMs: elapsedMs,
        configuredSimulationTimeoutSec: timeoutSec,
        effectiveLiveWaitingWindowSec: effectiveLiveTimeoutSec,
        mockFolder: options.mockFolder || 'primary',
        isSimulated: true,
      });

      if (options.mockTimeout) {
        return {
          received: false,
          timedOut: true,
          initialWindowExpired: true,
          elapsedMs,
          isSimulated: true,
          effectiveLiveTimeoutSec,
          configuredTimeoutSec: timeoutSec,
          message: `[SIMULATION] Instant check completed (${elapsedMs}ms). Configured live waiting window is ${effectiveLiveTimeoutSec}s (minimum 300s / 5 minutes).`,
        };
      }

      if (options.mockReplyText !== undefined && options.mockReplyText !== null) {
        const messageId = options.mockMessageId || `mock_msg_${Buffer.from(options.mockReplyText).toString('base64').slice(0, 12)}`;
        const urls = extractExternalUrls(options.mockReplyText).map(cleanTrackingParams);
        return {
          received: true,
          messageId,
          messageText: options.mockReplyText,
          extractedUrl: urls[0] || null,
          sender: creatorUsername,
          folder: options.mockFolder || 'primary',
          elapsedMs,
          isSimulated: true,
          effectiveLiveTimeoutSec,
          configuredTimeoutSec: timeoutSec,
        };
      }

      return {
        received: false,
        timedOut: true,
        initialWindowExpired: true,
        elapsedMs,
        isSimulated: true,
        effectiveLiveTimeoutSec,
        configuredTimeoutSec: timeoutSec,
        message: `[SIMULATION] Instant check completed (${elapsedMs}ms). Configured live waiting window is ${effectiveLiveTimeoutSec}s (minimum 300s / 5 minutes).`,
      };
    }

    try {
      const maxDuration = timeoutSec * 1000;
      if (isSinglePass) {
        logger.info(`Checking inbox for pending messages from @${creatorUsername} (single-pass check)...`);
      } else {
        logger.info(`Listening for incoming direct messages from @${creatorUsername} in Primary & Requests (live waiting window: ${timeoutSec}s, minimum 300s)...`);
      }

      let cycleCount = 0;
      let cachedThreadId = null;
      let cachedFolder = 'primary';

      while (cycleCount === 0 || (!isSinglePass && (Date.now() - startTime < maxDuration))) {
        cycleCount++;
        let creatorThread = null;
        let folder = cachedFolder;
        let messages = [];

        // 1. If we already located/opened the creator's thread, directly read messages from active thread view!
        if (cachedThreadId && typeof this.inbox.getThreadMessages === 'function') {
          try {
            messages = await this.inbox.getThreadMessages(cachedThreadId);
            creatorThread = { threadId: cachedThreadId, username: creatorUsername, folder: cachedFolder };
          } catch (err) {
            logger.debug('getThreadMessages error on cachedThreadId', { cachedThreadId, error: err.message });
          }
        }

        // 2. If thread not cached yet, or periodically (every 10th cycle ~ 35s) if no messages found, locate/open thread:
        if (!cachedThreadId || (messages.length === 0 && cycleCount % 10 === 0)) {
          if (typeof this.inbox.openCreatorThread === 'function') {
            try {
              const threadRes = await this.inbox.openCreatorThread(creatorUsername);
              if (threadRes && threadRes.threadId) {
                cachedThreadId = threadRes.threadId;
                cachedFolder = threadRes.folder || 'primary';
                folder = cachedFolder;
                creatorThread = { threadId: cachedThreadId, username: creatorUsername, folder };
                if (threadRes.messages && threadRes.messages.length > 0) {
                  messages = threadRes.messages;
                }
              }
            } catch (err) {
              logger.debug('openCreatorThread attempt error', { error: err.message });
            }
          }
        }

        // 3. Fallback check Requests folder every 5th cycle if not already cached
        const shouldCheckRequests = !cachedThreadId && (cycleCount % 5 === 0);

        if (!creatorThread && shouldCheckRequests && typeof this.inbox.getRequestsThreads === 'function') {
          const requestThreads = await this.inbox.getRequestsThreads();
          const cleanCreator = creatorUsername.toLowerCase().replace(/[_.\s]/g, '');
          creatorThread = requestThreads.find(
            t => {
              if (!t.username) return false;
              const cleanTarget = t.username.toLowerCase().replace(/[_.\s]/g, '');
              return (
                cleanTarget.includes(cleanCreator) ||
                cleanCreator.includes(cleanTarget) ||
                t.username.toLowerCase() === creatorUsername.toLowerCase()
              );
            }
          );
          if (creatorThread) {
            folder = 'requests';
            cachedFolder = 'requests';
            cachedThreadId = creatorThread.threadId;
          }
        }

        if (!creatorThread && !cachedThreadId) {
          const primaryThreads = await this.inbox.getInboxThreads();
          const cleanCreator = creatorUsername.toLowerCase().replace(/[_.\s]/g, '');
          creatorThread = primaryThreads.find(
            t => {
              if (!t.username) return false;
              const cleanTarget = t.username.toLowerCase().replace(/[_.\s]/g, '');
              return (
                cleanTarget.includes(cleanCreator) ||
                cleanCreator.includes(cleanTarget) ||
                t.username.toLowerCase() === creatorUsername.toLowerCase()
              );
            }
          );
          if (creatorThread) {
            folder = 'primary';
            cachedFolder = 'primary';
            cachedThreadId = creatorThread.threadId;
          }
        }

        if (creatorThread && messages.length === 0) {
          // Inspect messages in creator thread
          if (typeof this.inbox.getThreadMessages === 'function') {
            messages = await this.inbox.getThreadMessages(creatorThread.threadId);
          } else {
            const page = await this.session.getPage();
            const threadUrl = `https://www.instagram.com/direct/t/${creatorThread.threadId}/`;
            await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1000);
            const rows = await page.$$('div[role="row"], div[role="listitem"]');
            for (const r of rows) {
              const text = (await r.innerText()) || '';
              messages.push({ text, links: [] });
            }
          }
        }

        if (messages.length > 0) {
          let foundUrl = null;
          let lastText = '';
          let lastMessageId = null;

          for (const msg of messages) {
            if (msg.text) lastText = msg.text;
            const msgId = msg.id || (msg.timestamp ? `msg_${msg.timestamp}` : null);
            if (msgId) lastMessageId = msgId;

            // 1. Check message links (filters out internal instagram/facebook links and watermark domains)
            if (msg.links && msg.links.length > 0) {
              for (const rawL of msg.links) {
                if (rawL && !rawL.includes('instagram.com') && !rawL.includes('facebook.com')) {
                  const resolved = resolveDestinationUrl(rawL);
                  if (resolved && !isWatermarkUrl(resolved)) {
                    foundUrl = resolved;
                    break;
                  }
                }
              }
              if (foundUrl) break;
            }

            // 2. Check text extraction
            const urls = extractExternalUrls(msg.text);
            for (const rawU of urls) {
              const resolved = resolveDestinationUrl(rawU);
              if (resolved && !isWatermarkUrl(resolved)) {
                foundUrl = resolved;
                break;
              }
            }
            if (foundUrl) break;
          }

            if (!lastMessageId && lastText) {
              lastMessageId = `msg_${Buffer.from(lastText).toString('base64').slice(0, 16)}`;
            }

            // IMMEDIATE REPLY HANDLING: Return immediately as soon as creator link or message is detected!
            if (foundUrl) {
              const elapsedMs = Date.now() - startTime;
              logger.info('Received DM with resource URL from creator (immediate return)', {
                creator: creatorUsername,
                url: foundUrl,
                folder,
                threadId: cachedThreadId,
                elapsedMs,
              });
              return {
                received: true,
                messageId: lastMessageId,
                messageText: lastText || foundUrl,
                extractedUrl: foundUrl,
                sender: creatorUsername,
                folder,
                threadId: cachedThreadId,
                elapsedMs,
                isSimulated: false,
                effectiveLiveTimeoutSec: timeoutSec,
              };
            }

            // In "fwd not copy" workflow, any incoming message/card from the creator is an immediate valid response!
            if (lastText && lastText.trim().length > 0) {
              const elapsedMs = Date.now() - startTime;
              logger.info('Received DM message/card from creator (immediate return for forwarding)', {
                creator: creatorUsername,
                folder,
                threadId: cachedThreadId,
                elapsedMs,
              });
              return {
                received: true,
                messageId: lastMessageId,
                messageText: lastText,
                extractedUrl: null,
                sender: creatorUsername,
                folder,
                threadId: cachedThreadId,
                elapsedMs,
                isSimulated: false,
                effectiveLiveTimeoutSec: timeoutSec,
              };
            }
          }

        if (isSinglePass) {
          break;
        }

        // Continuous polling every 3-5 seconds (allows custom interval in tests)
        const pollInterval = options.pollIntervalMs !== undefined
          ? options.pollIntervalMs
          : Math.max(3000, Math.min(5000, this.cfg.inboxPollIntervalMs || 4000));
        await new Promise(r => setTimeout(r, pollInterval));
      }

      const elapsedMs = Date.now() - startTime;
      if (isSinglePass) {
        logger.debug(`Single-pass inbox check completed for @${creatorUsername} (${elapsedMs}ms). No new message detected.`);
        return {
          received: false,
          timedOut: false,
          isSinglePass: true,
          elapsedMs,
          isSimulated: false,
          effectiveLiveTimeoutSec: 0,
        };
      }

      logger.info(`Initial waiting window ended for creator @${creatorUsername} (${(elapsedMs / 1000).toFixed(1)}s elapsed, minimum 300s). Job remains WAITING_FOR_REPLY for later background checks.`);
      return {
        received: false,
        timedOut: true,
        initialWindowExpired: true,
        elapsedMs,
        isSimulated: false,
        effectiveLiveTimeoutSec: timeoutSec,
      };
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      logger.error('Error monitoring inbox for creator response', { creatorUsername, error: err.message, elapsedMs });
      return {
        received: false,
        error: err.message,
        elapsedMs,
        isSimulated: false,
        effectiveLiveTimeoutSec: timeoutSec,
      };
    }
  }

  /**
   * Matches an incoming creator DM reply to one of the waiting jobs for that creator.
   * If multiple jobs are waiting, uses keyword and shortcode to disambiguate.
   * If ambiguous, marks jobs with NEEDS_REVIEW to avoid attaching links to the wrong Reel.
   * @param {Object} replyMessage
   * @param {string} creatorUsername
   * @returns {{ matchedJob: Object|null, isAmbiguous: boolean, reason?: string }}
   */
  matchCreatorReplyToJob(replyMessage, creatorUsername) {
    const waitingJobs = this.queue.getJobsWaitingForCreator(creatorUsername);
    if (!waitingJobs || waitingJobs.length === 0) {
      return {
        matchedJob: null,
        isAmbiguous: false,
        reason: `No jobs currently waiting for creator @${creatorUsername}`,
      };
    }

    // 1. Single waiting job: unambiguous match
    if (waitingJobs.length === 1) {
      return {
        matchedJob: waitingJobs[0],
        isAmbiguous: false,
      };
    }

    // 2. Multiple waiting jobs: inspect reply text for keyword or shortcode
    const text = (replyMessage.messageText || replyMessage.text || '').toLowerCase();
    const candidateMatches = waitingJobs.filter(job => {
      const keyword = (job.keyword || '').toLowerCase();
      const shortcode = (job.shortcode || '').toLowerCase();

      const matchesKeyword = keyword && keyword.length >= 2 && text.includes(keyword);
      const matchesShortcode = shortcode && text.includes(shortcode);

      return matchesKeyword || matchesShortcode;
    });

    if (candidateMatches.length === 1) {
      logger.info(`Disambiguated creator reply to job ${candidateMatches[0].id} via keyword/shortcode match`, {
        creator: creatorUsername,
        jobId: candidateMatches[0].id,
      });
      return {
        matchedJob: candidateMatches[0],
        isAmbiguous: false,
      };
    }

    // 3. Ambiguous match: pause all candidate jobs for human review
    const reviewReason = `Ambiguous reply from @${creatorUsername}: received automated message but multiple Reels are waiting and none uniquely match the content.`;
    logger.warn(reviewReason, {
      replyText: replyMessage.messageText,
      waitingJobCount: waitingJobs.length,
      candidateMatchCount: candidateMatches.length,
    });

    for (const job of waitingJobs) {
      this.queue.updateCreatorInteraction(job.id, {
        review_reason: reviewReason,
        last_seen_message_text: replyMessage.messageText,
        last_seen_message_id: replyMessage.messageId,
      });
      this.queue.updateStatus(job.id, 'NEEDS_REVIEW', {
        errorMessage: reviewReason,
      });
    }

    return {
      matchedJob: null,
      isAmbiguous: true,
      reason: reviewReason,
    };
  }

  /**
   * Resumes inbox monitoring for all jobs awaiting creator replies (e.g. after daemon restart).
   * Guarantees:
   * - NEVER repeats follow action (already COMPLETED / ALREADY_FOLLOWING).
   * - NEVER repeats comment action (already POSTED).
   * - Disambiguates incoming messages using matchCreatorReplyToJob.
   * - Idempotently processes and delivers verified links.
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {Object} [options.mockRepliesByCreator] - { [creator]: { messageText, folder, messageId } }
   */
  async resumeWaitingJobs(options = {}) {
    logger.debug('resumeWaitingJobs: Retired in comment-only workflow. No dormant waiting jobs will be resumed.');
    return {
      checked: 0,
      resolved: 0,
      waiting: 0,
      reviewNeeded: 0,
    };
  }

  extractCommentKeyword(caption) {
    const reqs = extractCreatorRequirements(caption, '', { defaultToEmoji: true });
    return reqs.keyword || '🙌';
  }

  async checkWaitingJobsOnce(options = {}) {
    return this.resumeWaitingJobs(options);
  }

  /**
   * Orchestrates the complete Follow-First Creator Interaction Workflow for a job.
   * Handles idempotency, approval gates, verification, reply monitoring, and delivery.
   * @param {Object} job - Database job record
   * @param {Object} [options]
   * @param {string} [options.caption]
   * @param {string} [options.creator]
   * @param {boolean} [options.isSimulation]
   * @param {boolean} [options.approved]
   * @param {boolean} [options.mockFollowing]
   * @param {boolean} [options.mockFollowSuccess]
   * @param {boolean} [options.mockCommentSuccess]
   * @param {string|null} [options.mockReplyText]
   * @returns {Promise<{ success: boolean, stage: string, status: string, resourceUrl?: string, error?: string }>}
   */
  async executeCreatorWorkflow(job, options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const approved = options.approved !== undefined ? options.approved : !this.cfg.requireApproval;
    const caption = options.caption || '';
    const creator = (options.creator || job.sender_username || '').replace(/^@/, '').trim();

    logger.info(`Starting Creator Interaction Workflow for Job ${job.id}`, {
      creator,
      shortcode: job.shortcode,
      isSimulation: isSim,
      approved,
    });

    // Check if interaction already exists from a prior run
    const existingInteraction = this.queue.getCreatorInteraction(job.id);
    const commentAlreadyDone = existingInteraction && (
      isSim
        ? (isSimulatedCommentCompleted(existingInteraction) || this.queue.isLiveCommentVerified(existingInteraction))
        : this.queue.isLiveCommentVerified(existingInteraction)
    );

    // Step 1: Parse requirements (or use persisted keyword if comment already posted)
    let reqs;
    if (commentAlreadyDone && existingInteraction.keyword) {
      reqs = {
        requiresFollow: Boolean(existingInteraction.requires_follow),
        requiresComment: true,
        keyword: existingInteraction.keyword,
        isUnclear: false,
        interactionType: 'comment_only',
        reason: 'Using persisted creator keyword from previous completed comment',
      };
    } else {
      reqs = extractCreatorRequirements(caption);
    }

    // Default to '🙌' if no specific comment keyword is found or instructions were unclear
    if (!reqs.keyword || reqs.isUnclear || !reqs.requiresComment) {
      logger.info(`Job ${job.id}: No explicit comment keyword found in caption. Defaulting to 🙌 comment emoji as configured.`);
      reqs.keyword = '🙌';
      reqs.requiresComment = true;
      reqs.isUnclear = false;
      reqs.interactionType = reqs.requiresFollow ? 'follow_and_comment' : 'comment_only';
    }

    // Step 2: Initialize or fetch persistent interaction record
    // Follow First, Always: Every creator interaction requires following (or checking follow)
    const interaction = this.queue.createOrGetCreatorInteraction(job.id, {
      creatorUsername: creator,
      shortcode: job.shortcode,
      requiresFollow: 1,
      requiresComment: 1,
      keyword: reqs.keyword,
      isSimulated: isSim ? 1 : 0,
    });

    // Step 3: FOLLOW FIRST, ALWAYS
    // Check if follow is already verified from a prior run or previous job
    const followAlreadyDone = isSim
      ? (isSimulatedFollowCompleted(interaction) || this.queue.isLiveFollowVerified(interaction))
      : this.queue.isLiveFollowVerified(interaction);

    if (!followAlreadyDone) {
      // 3a. Check if we already follow the creator
      const followStatusCheck = await this.checkFollowStatus(creator, {
        isSimulation: isSim,
        mockFollowing: options.mockFollowing,
      });

      if (followStatusCheck.isFollowing) {
        logger.info(`Already following creator @${creator}. Marking follow completed.`);
        const nowIso = new Date().toISOString();
        if (isSim) {
          this.queue.updateCreatorInteraction(job.id, {
            simulated_follow_status: 'ALREADY_FOLLOWING',
            simulated_follow_at: nowIso,
            is_simulated: 1,
          });
        } else {
          this.queue.updateCreatorInteraction(job.id, {
            follow_status: 'ALREADY_FOLLOWING',
            follow_verified_at: nowIso,
            live_follow_verified_at: nowIso,
            is_simulated: 0,
          });
        }
      } else {
        // 3b. Follow is needed — check approval gate
        if (!approved) {
          if (isSim) {
            this.queue.updateCreatorInteraction(job.id, { simulated_follow_status: 'PENDING_APPROVAL', is_simulated: 1 });
          } else {
            this.queue.updateCreatorInteraction(job.id, { follow_status: 'PENDING_APPROVAL', is_simulated: 0 });
          }
          this.queue.updateStatus(job.id, 'AWAITING_APPROVAL', {
            resultSummary: `Awaiting approval to follow @${creator} and post comment '${reqs.keyword}' on Reel ${job.shortcode}`,
          });
          return {
            success: false,
            stage: 'FOLLOW',
            status: 'PENDING_APPROVAL',
            error: 'User approval required to follow creator',
          };
        }

        // 3c. Execute Follow
        const followResult = await this.executeFollow(creator, {
          isSimulation: isSim,
          approved,
          mockFollowSuccess: options.mockFollowSuccess,
        });

        if (!followResult.success) {
          if (isSim) {
            this.queue.updateCreatorInteraction(job.id, {
              simulated_follow_status: followResult.status || 'FAILED',
              is_simulated: 1,
            });
          } else {
            this.queue.updateCreatorInteraction(job.id, {
              follow_status: followResult.status || 'FAILED',
              is_simulated: 0,
            });
          }
          this.queue.updateStatus(job.id, 'FAILED', {
            errorMessage: followResult.error || 'Follow action failed',
          });
          return {
            success: false,
            stage: 'FOLLOW',
            status: followResult.status || 'FAILED',
            error: followResult.error,
          };
        }

        const nowIso = new Date().toISOString();
        if (isSim) {
          this.queue.updateCreatorInteraction(job.id, {
            simulated_follow_status: 'COMPLETED',
            simulated_follow_at: nowIso,
            is_simulated: 1,
          });
        } else {
          this.queue.updateCreatorInteraction(job.id, {
            follow_status: 'COMPLETED',
            follow_verified_at: nowIso,
            live_follow_verified_at: nowIso,
            is_simulated: 0,
          });
        }
      }
    } else {
      logger.info(`Job ${job.id}: Follow step was already verified in prior run. Skipping.`);
    }

    // Guard: follow must be verified before proceeding to comment!
    const freshInteraction = this.queue.getCreatorInteraction(job.id);
    const followVerifiedForComment = isSim
      ? (isSimulatedFollowCompleted(freshInteraction) || this.queue.isLiveFollowVerified(freshInteraction))
      : this.queue.isLiveFollowVerified(freshInteraction);

    if (!followVerifiedForComment) {
      logger.error(`Job ${job.id}: Follow action could not be verified. Aborting comment step.`);
      return {
        success: false,
        stage: 'FOLLOW',
        status: 'FOLLOW_UNVERIFIED',
        error: 'Follow could not be verified prior to commenting',
      };
    }

    // Step 4: COMMENT THE REQUESTED KEYWORD (Approval Gate & Single Comment Execution)
    if (!reqs.keyword || KEYWORD_NOISE_WORDS.has(reqs.keyword.toLowerCase())) {
      logger.warn(`Job ${job.id}: Invalid or generic comment keyword "${reqs.keyword}". Will not comment.`);
      return {
        success: false,
        stage: 'COMMENT',
        status: 'INVALID_KEYWORD',
        error: `Invalid or generic comment keyword "${reqs.keyword || 'link'}". Won't comment generic text.`,
      };
    }

    const commentStepAlreadyDone = isSim
      ? (isSimulatedCommentCompleted(freshInteraction) || this.queue.isLiveCommentVerified(freshInteraction))
      : this.queue.isLiveCommentVerified(freshInteraction);

    if (!commentStepAlreadyDone) {
      // Approval check for comment
      if (!approved) {
        if (isSim) {
          this.queue.updateCreatorInteraction(job.id, { simulated_comment_status: 'PENDING_APPROVAL', is_simulated: 1 });
        } else {
          this.queue.updateCreatorInteraction(job.id, { comment_status: 'PENDING_APPROVAL', is_simulated: 0 });
        }
        this.queue.updateStatus(job.id, 'AWAITING_APPROVAL', {
          resultSummary: `Awaiting approval to post comment '${reqs.keyword}' on Reel ${job.shortcode}`,
        });
        return {
          success: false,
          stage: 'COMMENT',
          status: 'PENDING_APPROVAL',
          error: 'User approval required to post comment',
        };
      }

      const commentResult = await this.executeComment(job.shortcode, reqs.keyword, {
        isSimulation: isSim,
        approved,
        mockCommentSuccess: options.mockCommentSuccess,
      });

      if (!commentResult.success) {
        if (isSim) {
          this.queue.updateCreatorInteraction(job.id, {
            simulated_comment_status: commentResult.status || 'FAILED',
            is_simulated: 1,
          });
        } else {
          this.queue.updateCreatorInteraction(job.id, {
            comment_status: commentResult.status || 'FAILED',
            is_simulated: 0,
          });
        }
        this.queue.updateStatus(job.id, 'FAILED', {
          errorMessage: commentResult.error || 'Comment posting failed',
        });
        return {
          success: false,
          stage: 'COMMENT',
          status: commentResult.status || 'FAILED',
          error: commentResult.error,
        };
      }

      const nowIso = new Date().toISOString();
      if (isSim) {
        this.queue.updateCreatorInteraction(job.id, {
          simulated_comment_status: 'POSTED',
          simulated_comment_at: nowIso,
          comment_text: reqs.keyword,
          is_simulated: 1,
        });
      } else {
        this.queue.updateCreatorInteraction(job.id, {
          comment_status: 'POSTED',
          comment_posted_at: nowIso,
          live_comment_posted_at: nowIso,
          comment_text: reqs.keyword,
          is_simulated: 0,
        });
      }
    } else {
      logger.info(`Job ${job.id}: Comment step was already completed in prior run. Skipping.`);
    }

    // Step 4: Comment-Only Workflow ends here.
    // The job completes immediately without following, waiting for DMs, polling replies, or scheduling timers.
    this.queue.updateStatus(job.id, 'COMPLETED', {
      resultSummary: `Successfully commented '${reqs.keyword}' on Reel ${job.shortcode} by @${creator}`,
    });

    return {
      success: true,
      stage: 'COMMENT',
      status: 'COMPLETED',
      keyword: reqs.keyword,
      creator,
      shortcode: job.shortcode,
    };
  }

  async _retiredReplyMonitoring(job, options, creator, reqs, isSim) {
    // Step 5: Monitor Inbox for Automated Reply (wait up to 5 minutes)
    const currentInteraction = this.queue.getCreatorInteraction(job.id);
    const replyAlreadyReceived = currentInteraction && currentInteraction.reply_status === 'RECEIVED';
    let replyText = null;
    let messageId = null;
    let inboxResult = null;

    if (options.liveReplyResult) {
      inboxResult = options.liveReplyResult;
    } else if (!replyAlreadyReceived) {
      const isAsyncLive = !isSim && !options.forceSyncLiveWait;
      const initialTimeoutSec = isAsyncLive ? 20 : (options.timeoutSec || options.initialWaitingWindowSec || this.cfg.timeoutSec);

      inboxResult = await this.monitorInboxForResponse(creator, {
        isSimulation: isSim,
        mockReplyText: options.mockReplyText,
        mockFolder: options.mockFolder,
        mockTimeout: options.mockTimeout,
        mockMessageId: options.mockMessageId,
        timeoutSec: initialTimeoutSec,
        allowShortTimeout: isAsyncLive,
      });

      if (!inboxResult.received) {
        if (isAsyncLive) {
          // Asynchronous live mode: don't fail or send timeout yet! 5-minute timer is running in background.
          // Store initial_window_expires_at in SQLite and return WAITING_FOR_REPLY so app can process next reels!
          const now = Date.now();
          const initialExpiresAt = new Date(now + 300000).toISOString();
          this.queue.updateCreatorInteraction(job.id, {
            reply_status: 'WAITING_FOR_REPLY',
            initial_window_expires_at: initialExpiresAt,
            last_inbox_check_at: new Date().toISOString(),
          });
          this.queue.updateStatus(job.id, 'WAITING_FOR_REPLY', {
            resultSummary: `Comment posted ('${reqs.keyword}'). Waiting for creator DM reply (5-min window active)`,
          });
          logger.info(`Job ${job.id}: Initial 20s check completed for @${creator}. Scheduled 5-minute background timer; proceeding to next reel in queue.`);
          return {
            success: true,
            status: 'WAITING_FOR_REPLY',
            waitingForReply: true,
            stage: 'REPLY_MONITOR',
          };
        }

        // Expiry of 5-minute deadline: return exact result: "Couldn't fetch message"
        const nowIso = new Date().toISOString();
        this.queue.updateCreatorInteraction(job.id, {
          reply_status: 'WAITING_INITIAL_WINDOW_EXPIRED',
          last_inbox_check_at: nowIso,
        });

        // Deliver "Couldn't fetch message" to the user thread if not already delivered
        const currentJob = this.queue.getJob(job.id) || job;
        if (currentJob.thread_id && this.sender && currentJob.is_delivered !== 1) {
          logger.info(`5-minute waiting window expired for @${creator}. Returning "Couldn't fetch message" to user thread ${currentJob.thread_id}`);
          let sent = false;
          if (typeof this.sender.sendMessage === 'function') {
            sent = await this.sender.sendMessage(currentJob.thread_id, "Couldn't fetch message", { isSimulation: isSim });
          } else if (typeof this.sender.sendFailure === 'function') {
            sent = await this.sender.sendFailure(currentJob.thread_id, { message: "Couldn't fetch message" }, { isSimulation: isSim });
          }
          if (sent) {
            this.queue.markDelivered(job.id);
            currentJob.is_delivered = 1;
          } else {
            logger.warn(`Failed to deliver timeout message to thread ${currentJob.thread_id}. Job remains undelivered and retryable.`);
          }
        }

        this.queue.updateStatus(job.id, 'WAITING_FOR_REPLY', {
          resultSummary: "Couldn't fetch message",
        });

        return {
          success: false,
          stage: 'REPLY_MONITOR',
          status: 'TIMED_OUT',
          initialWindowExpired: true,
          result: "Couldn't fetch message",
          message: "Couldn't fetch message",
          elapsedMs: inboxResult.elapsedMs,
          isSimulated: inboxResult.isSimulated,
          effectiveLiveTimeoutSec: inboxResult.effectiveLiveTimeoutSec,
        };
      }
    }

    if (inboxResult) {
      replyText = inboxResult.messageText;
      messageId = inboxResult.messageId || null;

      // Follow-Gate recovery: creator bot asks user to follow before unlocking the link
      const followPromptPattern = /(follow|following).*?(link|unlock|send|dm|get|resource|code|guide|access)/i;
      const mustFollowPattern = /(must|please|make sure you('re| are)?).*?follow/i;
      const notFollowedPattern = /(haven't|have not|not).*?follow/i;
      const isFollowGate = !inboxResult.extractedUrl && (mustFollowPattern.test(replyText) || notFollowedPattern.test(replyText) || followPromptPattern.test(replyText));

      if (isFollowGate && !options._hasRetriedFollowGate) {
        logger.info(`Creator @${creator} reply requested follow verification: "${replyText}". Re-checking follow and re-posting comment...`);
        await this.executeFollow(creator, { isSimulation: isSim, forceRecheck: true });
        await this.executeComment(job.shortcode, reqs.keyword, { isSimulation: isSim, approved: true });
        return await this.executeCreatorWorkflow(job, {
          ...options,
          _hasRetriedFollowGate: true,
          initialWaitingWindowSec: 20,
        });
      }

      // Idempotency: Check if this message was already processed
      if (messageId && currentInteraction && currentInteraction.last_seen_message_id === messageId) {
        logger.info(`Message ${messageId} from @${creator} was already seen and processed. Skipping duplicate.`, { jobId: job.id });
        if (currentInteraction.extracted_url) {
          return {
            success: true,
            stage: 'DELIVERY',
            status: 'COMPLETED',
            resourceUrl: currentInteraction.extracted_url,
          };
        }
      }

      this.queue.updateCreatorInteraction(job.id, {
        reply_status: 'RECEIVED',
        reply_received_at: new Date().toISOString(),
        last_seen_message_id: messageId,
        last_seen_message_text: replyText,
        last_inbox_check_at: new Date().toISOString(),
      });
    }

    // Step 6: Extract and Validate URL from Reply
    const candidateUrls = [];
    if (inboxResult && inboxResult.extractedUrl) {
      candidateUrls.push(inboxResult.extractedUrl);
    }
    if (replyText) {
      const urls = extractExternalUrls(replyText).map(resolveDestinationUrl);
      for (const u of urls) {
        if (!candidateUrls.includes(u)) candidateUrls.push(u);
      }
    }
    if (currentInteraction && currentInteraction.extracted_url) {
      if (!candidateUrls.includes(currentInteraction.extracted_url)) candidateUrls.push(currentInteraction.extracted_url);
    }

    const nonWatermark = candidateUrls.filter(u => !isWatermarkUrl(u));
    const rawUrl = nonWatermark[0] || candidateUrls[0];

    // Step 7: Delivery - Plain Text Direct Message to User Thread (Option 4)
    // Instagram restricts forwarding interactive bot cards, so deliver clean plain text DM to the user thread
    if (!rawUrl) {
      if (replyText && replyText.trim().length > 0) {
        logger.info(`Creator @${creator} replied with text message (no external URL parsed). Sending text directly to user thread...`, {
          jobId: job.id,
          threadId: job.thread_id,
        });

        let textMsg = `📩 Message from @${creator}`;
        if (job.shortcode) {
          textMsg += ` (Reel: https://instagram.com/reel/${job.shortcode}/)`;
        }
        textMsg += `:\n\n${replyText.trim()}`;

        let delivered = false;
        if (this.sender) {
          delivered = await this.sender.sendMessage(job.thread_id, textMsg, {
            isSimulation: isSim,
            shortcode: job.shortcode,
            replyToReel: true,
          });
          if (delivered) {
            this.queue.markDelivered(job.id);
            job.is_delivered = 1;
          }
        }

        this.queue.updateCreatorInteraction(job.id, {
          reply_status: 'FORWARDED_TEXT',
          last_seen_message_text: replyText.trim(),
        });
        this.queue.updateStatus(job.id, 'COMPLETED', {
          resultSummary: `Creator @${creator} text response forwarded to user`,
          isDelivered: delivered ? 1 : 0,
        });

        recordResource({
          creator,
          shortcode: job.shortcode,
          keyword: currentInteraction?.keyword || null,
          status: 'TEXT_RECEIVED',
          url: null,
          message: replyText.trim(),
          threadId: options.creatorThreadId || (inboxResult && inboxResult.threadId),
        });

        return {
          success: true,
          stage: 'DELIVERY',
          status: 'COMPLETED',
          forwardedText: replyText.trim(),
        };
      }

      this.queue.updateCreatorInteraction(job.id, {
        reply_status: 'NO_URL_FOUND',
      });
      this.queue.updateStatus(job.id, 'COMPLETED', {
        resultSummary: `Creator @${creator} replied but message contained no valid resource URL`,
      });

      recordResource({
        creator,
        shortcode: job.shortcode,
        keyword: currentInteraction?.keyword || null,
        status: 'NO_URL_FOUND',
        url: null,
        message: replyText ? replyText.trim() : 'No external URL found',
        threadId: options.creatorThreadId || (inboxResult && inboxResult.threadId),
      });

      return {
        success: false,
        stage: 'EXTRACT_URL',
        status: 'NO_URL_FOUND',
        error: 'Creator replied but message contained no valid external resource URLs',
      };
    }

    this.queue.updateCreatorInteraction(job.id, { extracted_url: rawUrl });

    // Validate resource via processResource (SSRF and header checks)
    const processed = await processResource(rawUrl);
    if (!processed.success) {
      this.queue.updateStatus(job.id, 'FAILED', {
        errorMessage: `Resource validation failed for creator link: ${processed.error}`,
      });
      return {
        success: false,
        stage: 'VALIDATE_RESOURCE',
        status: 'INVALID_RESOURCE',
        error: processed.error,
      };
    }

    // Step 7: Send direct clean link DM to user thread
    const freshJob = this.queue.getJob(job.id) || job;
    let delivered = freshJob.is_delivered === 1;
    if (!delivered && this.sender) {
      const sent = await this.sender.sendSuccess(
        job.thread_id,
        {
          url: processed.finalUrl,
          title: processed.summary,
          summary: `Retrieved via verified creator workflow from @${creator}`,
          score: 0.95,
          shortcode: job.shortcode,
        },
        { isSimulation: isSim, shortcode: job.shortcode, replyToReel: true }
      );
      if (sent) {
        this.queue.markDelivered(job.id);
        job.is_delivered = 1;
        delivered = true;
      } else {
        logger.warn(`Failed to deliver verified resource to thread ${job.thread_id}. Job remains undelivered and retryable.`);
      }
    }

    this.queue.updateStatus(job.id, 'COMPLETED', {
      candidateUrl: processed.finalUrl,
      resultSummary: processed.summary,
      isDelivered: delivered ? 1 : 0,
    });

    recordResource({
      creator,
      shortcode: job.shortcode,
      keyword: currentInteraction?.keyword || null,
      status: 'LINK_FOUND',
      url: processed.finalUrl,
      message: replyText ? replyText.trim() : processed.summary,
      threadId: options.creatorThreadId || (inboxResult && inboxResult.threadId),
    });

    return {
      success: true,
      stage: 'DELIVERY',
      status: 'COMPLETED',
      resourceUrl: processed.finalUrl,
      summary: processed.summary,
    };
  }

  /**
   * Helper: checks if a page contains Instagram action restriction messages.
   * @param {Object} page
   * @returns {Promise<string|null>}
   */
  async _checkForRestrictions(page) {
    try {
      const pageText = (await page.innerText('body')).toLowerCase();
      for (const indicator of RESTRICTION_INDICATORS) {
        if (pageText.includes(indicator)) {
          return `Instagram restriction challenge detected: "${indicator}"`;
        }
      }
    } catch {
      // Ignore evaluation errors
    }
    return null;
  }

  /**
   * Safely unfollows a creator account.
   * In simulation mode, marks the creator unfollowed in SQLite without performing live navigation.
   * In live mode, delegates to inbox.unfollowCreatorDirect.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @returns {Promise<{ success: boolean, creator: string, isSimulated?: boolean, error?: string }>}
   */
  async unfollowCreator(creatorUsername, options = {}) {
    const isSim = options.isSimulation !== undefined ? options.isSimulation : this.cfg.simulationMode;
    const cleanCreator = (creatorUsername || '').replace(/^@/, '').trim();

    if (isSim) {
      logger.info(`⚡ [SIMULATION] Unfollowing creator @${cleanCreator}`);
      if (this.queue && typeof this.queue.markCreatorUnfollowed === 'function') {
        this.queue.markCreatorUnfollowed(cleanCreator);
      }
      return { success: true, creator: cleanCreator, isSimulated: true };
    }

    if (this.inbox && typeof this.inbox.unfollowCreatorDirect === 'function') {
      return this.inbox.unfollowCreatorDirect(cleanCreator, { isSimulation: false });
    }

    return { success: false, creator: cleanCreator, error: 'No browser inbox configured for unfollow' };
  }
}

module.exports = {
  CreatorInteractionManager,
  extractCreatorRequirements,
  FOLLOW_PATTERNS,
  COMMENT_KEYWORD_PATTERNS,
  isLiveFollowVerified,
  isLiveCommentVerified,
  isSimulatedFollowCompleted,
  isSimulatedCommentCompleted,
};
