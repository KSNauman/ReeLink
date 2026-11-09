/**
 * Instagram Direct Message Sender
 * Formats structured response templates and delivers messages to user threads.
 */
const logger = require('../utils/logger');

class InstagramSender {
  constructor(browserSession, options = {}) {
    this.session = browserSession;
    this.options = options;
    this.page = null;
  }

  async init() {
    this.page = await this.session.getPage();
  }

  /**
   * Navigates to the target thread and locates the message input field.
   * @param {string} threadId
   */
  async _focusMessageInput(threadId) {
    if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) await this.init();

    const threadUrl = `https://www.instagram.com/direct/t/${threadId}/`;
    if (!this.page.url().includes(threadId)) {
      logger.info('Navigating to thread for delivery', { threadId });
      await this.page.goto(threadUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.page.waitForTimeout(1500);
    }

    // Instagram draws the message box a few seconds after the page loads.
    if (typeof this.page.waitForSelector === 'function') {
      await this.page.waitForSelector('div[role="textbox"][contenteditable="true"], textarea[placeholder*="Message"]', { timeout: 15000 }).catch(() => {});
    }

    // Try multiple selector patterns for Instagram message input
    const selectors = [
      'div[contenteditable="true"][role="textbox"]',
      'div[aria-label*="Message"][contenteditable="true"]',
      'div[role="textbox"]',
      'textarea[placeholder*="Message"]',
      'div[aria-placeholder*="Message"]',
    ];

    for (const sel of selectors) {
      try {
        const input = await this.page.$(sel);
        if (input && (await input.isVisible())) {
          await input.click();
          return input;
        }
      } catch {
        // Continue to next selector
      }
    }

    throw new Error(`Unable to locate direct message input in thread ${threadId}`);
  }

  /**
   * Attempts to activate Instagram's native in-reply-to quote reply for a shared Reel card.
   * Hovers over the shared clip card and clicks the reply button.
   * @param {string} [shortcode]
   * @returns {Promise<boolean>}
   */
  async _attemptQuoteReply(shortcode) {
    if (!this.page) return false;
    try {
      // Find clip cards inside thread
      const cardHandles = await this.page.$$('div[role="button"]:has(svg[aria-label="Clip"])');
      if (!cardHandles || cardHandles.length === 0) return false;

      // Newest clip card in conversation
      const targetCard = cardHandles[cardHandles.length - 1];
      await targetCard.hover();
      await this.page.waitForTimeout(400);

      const replyBtn = await this.page.$(
        'div[aria-label^="Reply to message from "], button[aria-label^="Reply to message from "], div[role="button"]:has(svg[aria-label^="Reply"])'
      );

      if (replyBtn && (await replyBtn.isVisible())) {
        await replyBtn.click();
        await this.page.waitForTimeout(500);

        // Verify quote reply state is active above input
        const isQuoting = await this.page.evaluate(() => {
          const cancelBtn = document.querySelector('svg[aria-label="Cancel reply"], [aria-label="Cancel reply"]');
          return Boolean(cancelBtn);
        });

        if (isQuoting) {
          logger.info('Activated native Instagram quote reply for Reel card', { shortcode });
          return true;
        }
      }
    } catch (err) {
      logger.debug('Quote reply activation skipped or failed', { error: err.message, shortcode });
    }
    return false;
  }

  /**
   * Sends a plain-text or multi-line message to a thread.
   * Supports replying to a particular Reel card or prepending contextual reference.
   * @param {string} threadId
   * @param {string} messageText
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @param {string} [options.shortcode]
   * @param {boolean} [options.replyToReel]
   * @returns {Promise<boolean>}
   */
  async sendMessage(threadId, messageText, options = {}) {
    const cfg = require('../config');
    const isSim = options.isSimulation === true;
    const isDryRun = isSim || (options.dryRun !== undefined ? options.dryRun : (this.options?.dryRun !== undefined ? this.options.dryRun : Boolean(cfg.instagram?.dryRun)));
    const targetShortcode = options.shortcode || null;

    if (isDryRun) {
      logger.info('⚡ [DRY-RUN / SIMULATION] Outgoing DM simulated (not dispatched to Instagram Web)', {
        threadId,
        messageLength: messageText.length,
        shortcode: targetShortcode,
        preview: messageText.substring(0, 150).replace(/\n/g, ' '),
        isSimulation: isSim,
      });
      return true;
    }

    try {
      logger.info('Sending Instagram DM...', { threadId, length: messageText.length, shortcode: targetShortcode });

      // Focus input & thread
      const input = await this._focusMessageInput(threadId);

      // Attempt native in-reply-to quote reply if targetShortcode is specified
      let quoteActivated = false;
      if (targetShortcode || options.replyToReel) {
        quoteActivated = await this._attemptQuoteReply(targetShortcode);
      }

      // If native DOM quote reply was not activated, prepend explicit contextual reference
      let finalMessage = messageText;
      if (!quoteActivated && targetShortcode) {
        const reelRef = `🎬 Regarding Reel: https://www.instagram.com/reel/${targetShortcode}/\n\n`;
        if (!finalMessage.includes(targetShortcode)) {
          finalMessage = reelRef + finalMessage;
        }
      }

      // In contenteditable divs, using fill() or typing with Shift+Enter for newlines
      const lines = finalMessage.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          await this.page.keyboard.type(lines[i], { delay: 20 });
        }
        if (i < lines.length - 1) {
          await this.page.keyboard.down('Shift');
          await this.page.keyboard.press('Enter');
          await this.page.keyboard.up('Shift');
        }
      }

      await this.page.waitForTimeout(500);
      // Press Enter to send
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(1500);

      logger.info('Message sent successfully', { threadId, quoteActivated, shortcode: targetShortcode });
      return true;
    } catch (err) {
      logger.error('Failed to send Instagram DM', { threadId, error: err.message });
      return false;
    }
  }

  /**
   * Helper: Send initial Acknowledgment DM.
   */
  async sendAck(threadId, options = {}) {
    const text = 'Reel received. Looking for the resource... 🔍';
    return this.sendMessage(threadId, text, options);
  }

  /**
   * Helper: Send verified resource found DM.
   */
  async sendSuccess(threadId, { url, title, summary, score, shortcode }, options = {}) {
    let msg = '🎯 Resource Found!\n\n';
    if (title) msg += `📌 Title: ${title}\n`;
    msg += `🔗 Link: ${url}\n`;
    if (summary) msg += `\n📝 Summary:\n${summary}\n`;
    if (score) msg += `\nConfidence: ${Math.round(score * 100)}%`;
    const opts = { ...options, shortcode: shortcode || options.shortcode };
    return this.sendMessage(threadId, msg.trim(), opts);
  }

  /**
   * Helper: Send honest failure / candidates DM.
   */
  async sendFailure(threadId, { candidates = [], message = '', shortcode }, options = {}) {
    let msg = '⚠️ Could not find an exact public resource.\n\n';
    if (message) msg += `${message}\n\n`;

    if (candidates.length > 0) {
      msg += 'Here are the closest public candidates found:\n';
      candidates.slice(0, 3).forEach((c, idx) => {
        msg += `${idx + 1}. ${c.title || c.url} (${Math.round((c.score || 0) * 100)}%)\n   ${c.url}\n`;
      });
    }

    const opts = { ...options, shortcode: shortcode || options.shortcode };
    return this.sendMessage(threadId, msg.trim(), opts);
  }
}

module.exports = InstagramSender;
