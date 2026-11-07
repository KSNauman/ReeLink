/**
 * Instagram Inbox Watcher
 * Responsible for polling the direct messages inbox, detecting shared Reel messages,
 * and extracting shortcodes and thread metadata.
 */
const { extractReelShortcode, normalizeReelUrl } = require('../utils/url-helper');
const logger = require('../utils/logger');
const config = require('../config');

class InstagramInbox {
  constructor(browserSession, options = {}) {
    this.session = browserSession;
    this.page = null;
    this.queue = options.queue || null;
    this.sender = options.sender || null;
    this.isLiveMode = options.isLiveMode !== undefined ? options.isLiveMode : false;
    this.app = options.app || null;
    this.startTime = Date.now();
    this.processedMessageIds = new Set();
    this.isBaselined = false;
    this.capturedCtaLinks = [];
    this._networkListenerAttached = false;
  }

  async init() {
    this.page = await this.session.getPage();
    this._attachNetworkListener();
  }

  /**
   * Listens for GraphQL and Direct API network responses to capture interactive
   * XMA button CTAs (e.g. QuickDM, ManyChat, LinkDM) that are not rendered in the web DOM.
   */
  _attachNetworkListener() {
    if (!this.page || this._networkListenerAttached) return;
    this._networkListenerAttached = true;

    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/graphql') || url.includes('/direct_v2/')) {
        try {
          const text = await response.text();
          if (text.includes('cta_buttons') || text.includes('xma')) {
            const json = JSON.parse(text);
            const { resolveDestinationUrl } = require('../utils/url-helper');
            const findCtas = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              if (Array.isArray(obj)) {
                for (const item of obj) findCtas(item);
                return;
              }
              if (obj.action_url) {
                const resolved = resolveDestinationUrl(obj.action_url);
                if (resolved && !this.capturedCtaLinks.some(c => c.actionUrl === obj.action_url || c.resolvedUrl === resolved)) {
                  this.capturedCtaLinks.push({
                    title: obj.title || '',
                    actionUrl: obj.action_url,
                    resolvedUrl: resolved,
                  });
                }
              }
              for (const key of Object.keys(obj)) {
                findCtas(obj[key]);
              }
            };
            findCtas(json);
          }
        } catch {}
      }
    });
  }

  /**
   * Establishes a safe initial inbox baseline on listener startup.
   * Scans visible messages in authorized threads and marks them as processed
   * in SQLite so old historical messages sitting in the inbox are never newly ingested.
   * @param {Object} [queue] - JobQueue instance
   * @returns {Promise<number>} Number of baselined messages
   */
  async establishBaseline(queue = null) {
    const q = queue || this.queue;
    if (!q) {
      logger.debug('No queue provided for inbox baseline; skipping baseline scan');
      return 0;
    }

    try {
      logger.info('Establishing initial inbox baseline for existing messages...');
      await this.navigateToInbox();
      if (this.page) {
        try {
          await this.page.waitForSelector('div[role="button"], a[href*="/direct/t/"]', { timeout: 8000 });
        } catch {}
        await this.page.waitForTimeout(2000);
      }
      const threads = await this.getInboxThreads();
      const { isSenderAllowed } = require('../security/sender-allowlist');

      let baselinedCount = 0;
      for (const thread of threads.slice(0, 5)) {
        const isCandidate = isSenderAllowed(thread.username) || thread.username.toLowerCase().startsWith('nauman');
        if (!isCandidate) continue;

        const reels = await this.checkThreadForReels(thread.threadId, thread.username, {
          queue: q,
          isBaselineScan: true,
        });

        for (const reel of reels) {
          if (!q.isMessageProcessed(reel.messageId)) {
            q.recordProcessedMessage({
              messageId: reel.messageId,
              threadId: reel.threadId,
              senderUsername: reel.senderUsername,
              shortcode: reel.shortcode,
              reelUrl: reel.reelUrl,
              ackSent: 1, // Treat existing messages as already acknowledged
              isBaseline: 1,
            });
            this.processedMessageIds.add(reel.messageId);
            baselinedCount++;
          }
        }
      }

      this.isBaselined = true;
      logger.info(`Inbox baseline established: ${baselinedCount} existing message(s) baselined (old Reels will not be re-ingested)`);
      return baselinedCount;
    } catch (err) {
      logger.warn('Failed to establish inbox baseline', { error: err.message });
      return 0;
    }
  }

  /**
   * Navigates to Instagram Direct Inbox and verifies readiness.
   */
  async navigateToInbox() {
    if (!this.page) await this.init();

    const currentUrl = this.page.url();
    if (!currentUrl.includes('/direct/inbox') && !currentUrl.includes('/direct/t/')) {
      logger.info('Navigating to Instagram Direct Inbox...');
      await this.page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      // Handle optional "Not Now" notification prompt if present
      await this._dismissPrompts();
    }
  }

  /**
   * Dismisses common Instagram Web modal dialogs ("Turn on Notifications", etc.)
   */
  async _dismissPrompts() {
    try {
      const notNowBtn = await this.page.$(
        'button:has-text("Not Now"), button:has-text("Cancel"), button:has-text("Dismiss")'
      );
      if (notNowBtn) {
        logger.debug('Dismissing modal dialog...');
        await notNowBtn.click();
        await this.page.waitForTimeout(1000);
      }
    } catch {
      // Ignored if no modal exists
    }
  }

  /**
   * Navigates to Instagram Direct Message Requests and verifies readiness.
   */
  async navigateToRequests() {
    if (!this.page) await this.init();

    const currentUrl = this.page.url();
    if (!currentUrl.includes('/direct/requests')) {
      logger.info('Navigating to Instagram Message Requests...');
      await this.page.goto('https://www.instagram.com/direct/requests/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await this._dismissPrompts();
    }
  }

  /**
   * Helper: extracts visible conversation threads from current page.
   * @param {string} [folder='primary']
   * @returns {Promise<Array<{ threadId: string, username: string, href: string, folder: string }>>}
   */
  async _extractThreadsFromPage(folder = 'primary') {
    const threadElements = await this.page.$$('a[href*="/direct/t/"]');
    const threads = [];
    for (const el of threadElements) {
      try {
        const href = await el.getAttribute('href');
        const match = href ? href.match(/\/direct\/t\/([A-Za-z0-9_-]+)/) : null;
        if (match) {
          const threadId = match[1];
          const text = (await el.innerText()) || '';
          const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
          const username = lines[0] || 'unknown';

          threads.push({
            threadId,
            username,
            title: lines[0] || '',
            snippet: lines.slice(1).join(' '),
            href,
            folder,
          });
        }
      } catch (err) {
        logger.debug('Error reading thread element', { error: err.message });
      }
    }

    // Modern Instagram Direct web: div[role="button"] conversation rows
    try {
      const modernRows = await this.page.evaluate((f) => {
        const rows = Array.from(document.querySelectorAll('div[role="button"]')).filter(el => {
          const text = (el.innerText || '').trim();
          return (
            text.includes('sent an attachment') ||
            text.includes('Active') ||
            text.includes('sent a message') ||
            text.includes('liked a message') ||
            text.includes('·')
          ) && text.length < 300;
        });

        return rows.map((r, i) => {
          const text = (r.innerText || '').trim();
          const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
          return {
            threadId: `row_${i}`,
            username: lines[0] || 'unknown',
            title: lines[0] || '',
            snippet: lines.slice(1).join(' '),
            href: null,
            folder: f,
          };
        });
      }, folder);

      for (const row of modernRows) {
        if (!threads.some(t => t.username === row.username || t.title === row.title)) {
          threads.push(row);
        }
      }

      // If already inside an active thread URL, ensure it is included
      const currentUrl = this.page.url();
      const activeMatch = currentUrl.match(/\/direct\/t\/([0-9A-Za-z_-]+)/);
      if (activeMatch) {
        const activeThreadId = activeMatch[1];
        if (!threads.some(t => t.threadId === activeThreadId)) {
          threads.unshift({
            threadId: activeThreadId,
            username: 'Naumannn',
            title: 'Naumannn',
            href: currentUrl,
            folder,
          });
        }
      }
    } catch {}

    return threads;
  }

  /**
   * Scans all visible conversation threads in the primary inbox.
   * @param {Object} [options]
   * @param {boolean} [options.includeRequests=false]
   * @returns {Promise<Array<{ threadId: string, username: string, href: string, folder: string }>>}
   */
  async getInboxThreads(options = {}) {
    await this.navigateToInbox();
    const primaryThreads = await this._extractThreadsFromPage('primary');

    if (options.includeRequests) {
      try {
        const requestThreads = await this.getRequestsThreads();
        return [...primaryThreads, ...requestThreads];
      } catch (err) {
        logger.debug('Could not fetch requests threads', { error: err.message });
        return primaryThreads;
      }
    }

    return primaryThreads;
  }

  /**
   * Scans all visible conversation threads in the Message Requests folder.
   * @returns {Promise<Array<{ threadId: string, username: string, href: string, folder: string }>>}
   */
  async getRequestsThreads() {
    await this.navigateToRequests();
    return this._extractThreadsFromPage('requests');
  }

  /**
   * Retrieves all message bubbles and extracted links from a thread.
   * @param {string} threadId
   * @returns {Promise<Array<{ text: string, links: string[] }>>}
   */
  async getThreadMessages(threadId) {
    if (!this.page) await this.init();

    if (threadId && !String(threadId).startsWith('row_') && threadId !== 'active') {
      const threadUrl = `https://www.instagram.com/direct/t/${threadId}/`;
      if (!this.page.url().includes(String(threadId))) {
        await this.page.goto(threadUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await this.page.waitForTimeout(1500);
      }
    }

    await this._dismissPrompts();

    const messages = [];

    try {
      // 1. Extract messages using modern Instagram Direct action buttons and message articles
      const extracted = await this.page.evaluate(() => {
        const msgs = [];
        const actions = Array.from(document.querySelectorAll('div[aria-label^="React to message from "], div[aria-label*="See more options for message from "]'));
        
        for (const action of actions) {
          const label = action.getAttribute('aria-label') || '';
          const senderMatch = label.match(/message from ([A-Za-z0-9_.]+)/i);
          const sender = senderMatch ? senderMatch[1] : null;

          let p = action;
          let container = null;
          for (let i = 0; i < 8 && p; i++) {
            if (p.getAttribute('role') === 'article' || (p.className && String(p.className).includes('x9f619'))) {
              container = p;
            }
            p = p.parentElement;
          }
          const scope = container || action.parentElement;
          const spans = Array.from(scope.querySelectorAll('span[dir="auto"], div[dir="auto"]'));
          const texts = spans
            .map(s => (s.innerText || '').trim())
            .filter(t => t.length > 0 && !t.includes('React to') && !t.includes('See more') && !t.includes('Reply to') && !t.includes('Send message'));

          const links = Array.from(scope.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(h => h && !h.includes('instagram.com') && !h.includes('facebook.com') && !h.includes('threads.net') && !h.includes('#'));

          if (texts.length > 0 || links.length > 0) {
            msgs.push({
              sender,
              text: texts.join('\n'),
              links,
            });
          }
        }

        // Fallback: if no action buttons, check div[role="article"] or generic message rows
        if (msgs.length === 0) {
          const articles = Array.from(document.querySelectorAll('div[role="article"], div[role="row"], div[role="listitem"]'));
          for (const art of articles) {
            const spans = Array.from(art.querySelectorAll('span[dir="auto"], div[dir="auto"]'));
            const texts = spans
              .map(s => (s.innerText || '').trim())
              .filter(t => t.length > 0 && !t.includes('React to') && !t.includes('See more') && !t.includes('Reply to') && !t.includes('Send message'));
            const links = Array.from(art.querySelectorAll('a[href]'))
              .map(a => a.href)
              .filter(h => h && !h.includes('instagram.com') && !h.includes('facebook.com') && !h.includes('threads.net') && !h.includes('#'));
            if (texts.length > 0 || links.length > 0) {
              msgs.push({
                text: texts.join('\n'),
                links,
              });
            }
          }
        }

        return msgs;
      });

      if (extracted && extracted.length > 0) {
        messages.push(...extracted);
      }

      // 2. Also scan all chat external links and text blocks
      const chatDetails = await this.page.evaluate(() => {
        const mainChat = document.querySelector('main section, main, div[role="main"]') || document.body;
        const anchors = Array.from(mainChat.querySelectorAll('a[href]'));
        const extLinks = [];
        for (const a of anchors) {
          const href = a.href;
          if (
            href &&
            !href.includes('instagram.com') &&
            !href.includes('facebook.com') &&
            !href.includes('threads.net') &&
            !href.includes('#')
          ) {
            extLinks.push(href);
          }
        }

        const textEls = Array.from(mainChat.querySelectorAll('div[dir="auto"], span[dir="auto"], div[role="none"]'));
        const texts = textEls.map(el => (el.innerText || '').trim()).filter(t => t.length > 0 && t.length < 500);

        return {
          links: extLinks,
          text: texts.join('\n'),
        };
      });

      // Merge any captured CTA button links (e.g. QuickDM / ManyChat interactive buttons)
      if (this.capturedCtaLinks && this.capturedCtaLinks.length > 0) {
        for (const cta of this.capturedCtaLinks) {
          const u = cta.resolvedUrl || cta.actionUrl;
          if (u && !chatDetails.links.includes(u)) {
            chatDetails.links.push(u);
          }
          if (u && !messages.some(m => m.links && m.links.includes(u))) {
            messages.push({
              text: `[Button: ${cta.title || 'Click here for link'}]`,
              links: [u],
            });
          }
        }
      }

      if (messages.length === 0 && (chatDetails.links.length > 0 || chatDetails.text)) {
        messages.push({
          text: chatDetails.text,
          links: chatDetails.links,
        });
      }
    } catch (err) {
      logger.debug('Error reading thread messages', { error: err.message });
    }

    return messages;
  }

  /**
   * Directly opens or checks a conversation with a specific creator.
   * Checks Primary, Requests, or navigates to creator profile to click Message.
   * @param {string} creatorUsername
   * @returns {Promise<{ threadId: string|null, folder: string, messages: Array<{ text: string, links: string[] }> }>}
   */
  async openCreatorThread(creatorUsername) {
    if (!this.page) await this.init();
    this._attachNetworkListener();

    const cleanCreator = (creatorUsername || '').toLowerCase().replace(/^@/, '').trim();

    // If page is already on a direct thread for this creator, read messages without re-navigating
    const currentUrl = this.page.url();
    if (currentUrl.includes('/direct/t/')) {
      const match = currentUrl.match(/\/direct\/t\/([A-Za-z0-9_-]+)/);
      const isAlreadyOnCreator = await this.page.evaluate((targetUser) => {
        const cleanTarget = targetUser.toLowerCase().replace(/[^a-z0-9]/g, '');
        const links = Array.from(document.querySelectorAll('header a[href^="/"], div[role="heading"] a[href^="/"], a[aria-label*="profile page"]'));
        for (const a of links) {
          const href = (a.getAttribute('href') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const label = (a.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const text = (a.innerText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (href.includes(cleanTarget) || label.includes(cleanTarget) || text.includes(cleanTarget)) {
            return true;
          }
        }
        return false;
      }, cleanCreator).catch(() => false);

      if (isAlreadyOnCreator) {
        const threadId = match ? match[1] : 'active';
        logger.debug('Already on creator thread, preserving open chat view', { creatorUsername: cleanCreator, threadId });
        const messages = await this.getThreadMessages(threadId);
        return {
          threadId,
          folder: 'primary',
          messages,
        };
      }
    }

    await this.navigateToInbox();
    await this.page.waitForTimeout(2000);

    let creatorThread = null;
    let folder = 'primary';

    // 1. Check top sidebar rows (clicking each row and checking header for creator profile link)
    try {
      for (let i = 0; i < 6; i++) {
        const clicked = await this.page.evaluate((idx) => {
          const rows = Array.from(document.querySelectorAll('div[role="button"], a[href*="/direct/t/"]')).filter(el => {
            const t = (el.innerText || '').trim();
            return (t.includes('·') || t.includes('attachment') || t.includes('message') || t.includes('Active')) && t.length < 300;
          });
          if (rows[idx]) {
            rows[idx].click();
            return true;
          }
          return false;
        }, i);

        if (!clicked) break;
        await this.page.waitForTimeout(1200);

        const isMatch = await this.page.evaluate((target) => {
          const cleanTarget = target.toLowerCase().replace(/[^a-z0-9]/g, '');
          const links = Array.from(document.querySelectorAll('header a[href^="/"], div[role="heading"] a[href^="/"], a[aria-label*="profile page"]'));
          for (const a of links) {
            const href = (a.getAttribute('href') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const label = (a.getAttribute('aria-label') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const text = (a.innerText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (href.includes(cleanTarget) || label.includes(cleanTarget) || text.includes(cleanTarget)) {
              return true;
            }
          }
          return false;
        }, cleanCreator);

        if (isMatch) {
          const urlMatch = this.page.url().match(/\/direct\/t\/([0-9A-Za-z_-]+)/);
          const threadId = urlMatch ? urlMatch[1] : `row_${i}`;
          creatorThread = { threadId, username: cleanCreator, folder: 'primary' };
          logger.info('Matched creator conversation thread from inbox sidebar', { creatorUsername: cleanCreator, threadId });
          break;
        }
      }
    } catch (err) {
      logger.debug('Error checking creator conversation rows', { error: err.message });
    }

    // 2. Search Requests
    if (!creatorThread) {
      try {
        const reqThreads = await this.getRequestsThreads();
        creatorThread = reqThreads.find(
          t => t.username && t.username.toLowerCase().includes(creatorUsername.toLowerCase().replace(/[_.]/g, ''))
        );
        if (creatorThread) folder = 'requests';
      } catch (err) {
        logger.debug('Requests scan error', { error: err.message });
      }
    }

    // 3. Fallback: navigate to creator profile to locate Message button
    if (!creatorThread) {
      try {
        const profileUrl = `https://www.instagram.com/${creatorUsername}/`;
        logger.info(`Opening creator profile to access direct conversation: ${profileUrl}`);
        await this.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.page.waitForTimeout(1500);
        await this._dismissPrompts();

        const msgBtn = await this.page.$(
          'header div[role="button"]:has-text("Message"), header button:has-text("Message"), header a:has-text("Message"), header a[href*="/direct/t/"]'
        );
        if (msgBtn) {
          logger.info(`Clicking Message button on @${creatorUsername}'s profile`);
          await msgBtn.click();
          await this.page.waitForURL(url => url.pathname.includes('/direct/'), { timeout: 8000 }).catch(() => {});
          await this.page.waitForTimeout(1500);

          for (let i = 0; i < 5; i++) {
            const currentUrl = this.page.url();
            const match = currentUrl.match(/\/direct\/t\/([A-Za-z0-9_-]+)/);
            if (match) {
              creatorThread = { threadId: match[1], username: creatorUsername, folder: 'direct' };
              folder = 'direct';
              break;
            }
            if (currentUrl.includes('/direct/')) {
              creatorThread = { threadId: 'active', username: creatorUsername, folder: 'direct' };
              folder = 'direct';
            }
            await this.page.waitForTimeout(1000);
          }
        }
      } catch (err) {
        logger.debug('Profile Message button navigation fallback failed', { error: err.message });
      }
    }

    let messages = [];
    if (creatorThread && creatorThread.threadId) {
      messages = await this.getThreadMessages(creatorThread.threadId);
    }

    return {
      threadId: creatorThread ? creatorThread.threadId : null,
      folder,
      messages,
    };
  }

  /**
   * Checks an individual thread for shared Reels.
   * Extracts actual sender identity, validates against allowlist,
   * resolves shared clip media cards and direct links using stable message IDs.
   * Skips already-processed messages without clicking cards.
   * @param {string} threadId
   * @param {string} [hintUsername]
   * @param {Object} [options]
   * @param {Object} [options.queue]
   * @param {boolean} [options.isBaselineScan=false]
   * @returns {Promise<Array<{ reelUrl: string, shortcode: string, threadId: string, senderUsername: string, source: string, messageId: string }>>}
   */
  async checkThreadForReels(threadId, hintUsername = null, options = {}) {
    if (!this.page) await this.init();
    const { isSenderAllowed, assertSenderAllowed, normalizeSenderUsername } = require('../security/sender-allowlist');
    const queue = options.queue || this.queue;
    const isBaselineScan = options.isBaselineScan === true;

    let resolvedThreadId = threadId;

    // If threadId is a sidebar row index (e.g. row_0), click the row to navigate and resolve real thread ID
    if (String(threadId).startsWith('row_')) {
      const rowIndex = parseInt(threadId.replace('row_', ''), 10);
      try {
        const clicked = await this.page.evaluate((idx) => {
          const rows = Array.from(document.querySelectorAll('div[role="button"]')).filter(el => {
            const text = (el.innerText || '').trim();
            return (
              text.includes('sent an attachment') ||
              text.includes('Active') ||
              text.includes('sent a message') ||
              text.includes('liked a message') ||
              text.includes('·')
            ) && text.length < 300;
          });
          if (rows[idx]) {
            rows[idx].click();
            return true;
          }
          return false;
        }, rowIndex);

        if (clicked) {
          await this.page.waitForTimeout(2500);
          const currentUrl = this.page.url();
          const match = currentUrl.match(/\/direct\/t\/([0-9A-Za-z_-]+)/);
          if (match) {
            resolvedThreadId = match[1];
          }
        }
      } catch (err) {
        logger.debug('Error clicking row for thread inspection', { error: err.message });
      }
    } else {
      const threadUrl = `https://www.instagram.com/direct/t/${resolvedThreadId}/`;
      if (!this.page.url().includes(String(resolvedThreadId))) {
        await this.page.goto(threadUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await this.page.waitForTimeout(2000);
      }
    }

    await this._dismissPrompts();

    // 1. Identify actual sender username from header profile link or message action aria-labels
    const senderIdentity = await this.page.evaluate(() => {
      let handle = null;

      // Check header profile link aria-label: "Open the profile page of ksydn_"
      const profileAria = Array.from(document.querySelectorAll('a[aria-label*="profile page of"]'));
      for (const a of profileAria) {
        const label = a.getAttribute('aria-label') || '';
        const m = label.match(/profile page of ([A-Za-z0-9_.]+)/i);
        if (m) {
          handle = m[1];
          break;
        }
      }

      // Check action buttons: "React to message from ksydn_", "Reply to message from ksydn_"
      if (!handle) {
        const actionBtns = Array.from(document.querySelectorAll('div[aria-label*="message from "]'));
        for (const btn of actionBtns) {
          const label = btn.getAttribute('aria-label') || '';
          const m = label.match(/message from ([A-Za-z0-9_.]+)/i);
          if (m && !m[1].toLowerCase().startsWith('dolphin.')) {
            handle = m[1];
            break;
          }
        }
      }

      // Check direct header profile link
      if (!handle) {
        const headerLink = document.querySelector('header a[href^="/"], div[role="heading"] a[href^="/"]');
        if (headerLink) {
          const href = headerLink.getAttribute('href') || '';
          const m = href.match(/^\/([A-Za-z0-9_.]+)\/?$/);
          if (m && !['direct', 'explore', 'reels', 'p'].includes(m[1].toLowerCase())) {
            handle = m[1];
          }
        }
      }

      // Check header text elements for username handle
      if (!handle) {
        const headerTexts = Array.from(document.querySelectorAll('header span, header h2, div[role="heading"] span'))
          .map(el => (el.innerText || '').trim().replace(/^@/, ''))
          .filter(t => /^[A-Za-z0-9_.]+$/.test(t) && t.length >= 3 && t.length <= 30 && !['direct', 'explore', 'reels', 'active', 'attachment'].includes(t.toLowerCase()));
        if (headerTexts.length > 0) {
          handle = headerTexts[0];
        }
      }

      return handle;
    });

    const actualSender = senderIdentity || normalizeSenderUsername(hintUsername);

    // Security Gate: Verify sender against allowlist (Fail closed!)
    if (!assertSenderAllowed(actualSender, { threadId: resolvedThreadId, stage: 'THREAD_CHECK' })) {
      return [];
    }

    const detected = [];

    // 2. Inspect raw text message bubbles FIRST for bot commands and pasted Reel URLs
    // This prioritizes bot commands (e.g. /status, /reset, /history) so they never wait behind card modal interactions or Reel jobs.
    const rawMessageBubbles = await this.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div[role="row"], div[role="listitem"]'));
      const targetRows = rows.length > 0 ? rows : Array.from(document.querySelectorAll('main div[dir="auto"]'));
      return targetRows.map((r, i) => {
        const text = (r.innerText || '').trim();
        const actionBtn = r.querySelector('div[aria-label*="message from"]');
        const label = actionBtn ? (actionBtn.getAttribute('aria-label') || '').toLowerCase() : '';
        const isFromBot = label.includes('dolphin.');
        return {
          text,
          isFromBot,
          index: i,
        };
      }).filter(b => b.text && b.text.length < 500);
    });

    for (const bubble of rawMessageBubbles) {
      if (bubble.isFromBot) continue;

      const cleanText = (bubble.text || '').trim();
      if (!cleanText) continue;

      // 2a. Check for bot commands starting with / or !, or bare "start"
      let cmdName = null;
      let cmdArgs = '';

      const slashMatch = cleanText.match(/^[/!]([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      if (slashMatch) {
        cmdName = slashMatch[1].toLowerCase();
        cmdArgs = slashMatch[2] ? slashMatch[2].trim() : '';
      } else if (cleanText.toLowerCase() === 'start') {
        cmdName = 'start';
        cmdArgs = '';
      }

      if (cmdName) {
        const supportedCommands = new Set(['help', 'menu', 'status', 'history', 'reset', 'unfollow', 'start']);

        if (supportedCommands.has(cmdName)) {
          const canonicalCmd = cmdName === 'menu' ? 'help' : cmdName;
          const crypto = require('crypto');
          const hash = crypto.createHash('md5').update(`${resolvedThreadId}_${actualSender}_${canonicalCmd}_${cmdArgs}`).digest('hex').slice(0, 8);
          const cmdMessageId = `msg_${resolvedThreadId}_${actualSender}_cmd_${canonicalCmd}_${hash}`;

          if (!isBaselineScan) {
            const alreadyProcessed = queue ? queue.isMessageProcessed(cmdMessageId) : this.processedMessageIds.has(cmdMessageId);
            if (!alreadyProcessed) {
              logger.info(`[BOT COMMAND] Intercepted /${cmdName} command from @${actualSender} in thread ${resolvedThreadId}`, { args: cmdArgs });
              await this.handleBotCommand(cmdName, String(resolvedThreadId), actualSender, cmdMessageId, cmdArgs);
            }
          } else {
            if (queue) {
              queue.recordProcessedMessage({
                messageId: cmdMessageId,
                threadId: String(resolvedThreadId),
                senderUsername: actualSender,
                shortcode: `CMD_${cmdName.toUpperCase()}`,
                reelUrl: `https://instagram.com/direct/t/${resolvedThreadId}`,
              });
            }
            this.processedMessageIds.add(cmdMessageId);
          }
          continue; // Always continue — commands never become Reel jobs!
        } else {
          // Unrecognized command starting with / or !
          const crypto = require('crypto');
          const hash = crypto.createHash('md5').update(`${resolvedThreadId}_${actualSender}_unknown_${cleanText}`).digest('hex').slice(0, 8);
          const cmdMessageId = `msg_${resolvedThreadId}_${actualSender}_cmd_unknown_${hash}`;

          if (!isBaselineScan) {
            const alreadyProcessed = queue ? queue.isMessageProcessed(cmdMessageId) : this.processedMessageIds.has(cmdMessageId);
            if (!alreadyProcessed) {
              if (queue) {
                queue.recordProcessedMessage({
                  messageId: cmdMessageId,
                  threadId: String(resolvedThreadId),
                  senderUsername: actualSender,
                  shortcode: `CMD_UNKNOWN`,
                  reelUrl: `https://instagram.com/direct/t/${resolvedThreadId}`,
                });
              }
              this.processedMessageIds.add(cmdMessageId);

              if (this.sender) {
                const unknownMsg = `❓ Unrecognized command: "${cleanText}"\n\nSend /help or /menu to view all supported ReelLink commands.`;
                await this.sender.sendMessage(String(resolvedThreadId), unknownMsg);
              }
            }
          }
          continue; // Malformed / unknown slash commands never become Reel jobs!
        }
      }

      // 2b. Check for pasted Reel URLs
      const shortcode = extractReelShortcode(bubble.text);
      if (shortcode) {
        const messageId = `msg_${resolvedThreadId}_${actualSender}_text_${shortcode}`;
        if (queue && queue.isMessageProcessed(messageId)) continue;
        if (this.processedMessageIds.has(messageId)) continue;

        if (!detected.some(d => d.messageId === messageId)) {
          detected.push({
            reelUrl: normalizeReelUrl(shortcode),
            shortcode,
            threadId: String(resolvedThreadId),
            senderUsername: actualSender,
            source: 'text',
            messageId,
          });
        }
      }
    }

    // 3. Look for direct links containing /reel/, /reels/, or /p/
    const directLinks = await this.page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"]'));
      return anchors.map(a => a.href).filter(h => !h.includes('/direct/'));
    });

    for (const href of directLinks) {
      const shortcode = extractReelShortcode(href);
      if (shortcode) {
        const messageId = `msg_${resolvedThreadId}_${actualSender}_link_${shortcode}`;
        if (queue && queue.isMessageProcessed(messageId)) continue;
        if (this.processedMessageIds.has(messageId)) continue;

        if (!detected.some(d => d.messageId === messageId)) {
          detected.push({
            reelUrl: normalizeReelUrl(shortcode),
            shortcode,
            threadId: String(resolvedThreadId),
            senderUsername: actualSender,
            source: 'link',
            messageId,
          });
        }
      }
    }

    // 4. Inspect shared media clip cards (Instagram DM Reel shares)
    const clipCards = await this.page.evaluate((targetSender) => {
      const cards = Array.from(document.querySelectorAll('div[role="button"]')).filter(b => {
        const svg = b.querySelector('svg[aria-label="Clip"]');
        const title = b.querySelector('title');
        return svg || (title && title.textContent === 'Clip');
      });

      const mediaOccurrences = new Map();

      return cards.map((card, idx) => {
        // Find nearest action button to determine sender
        let p = card;
        let sender = null;
        for (let i = 0; i < 12 && p; i++) {
          const actionBtn = p.querySelector('div[aria-label^="React to message from "]');
          if (actionBtn) {
            const m = (actionBtn.getAttribute('aria-label') || '').match(/message from ([A-Za-z0-9_.]+)/i);
            if (m) sender = m[1];
            break;
          }
          p = p.parentElement;
        }

        // Extract media identifier from image src, strictly ignoring creator avatar profile pictures
        let mediaId = null;
        const allImgs = Array.from(card.querySelectorAll('img'));
        const contentImgs = allImgs.filter(img => {
          const src = img.src || '';
          if (src.includes('profile_pic') || src.includes('s50x50') || src.includes('s150x150')) return false;
          if (img.width && img.width <= 60 && img.height && img.height <= 60) return false;
          return true;
        });
        const targetImgs = contentImgs.length > 0 ? contentImgs : allImgs;

        // Prioritize ig_cache_key on media content images
        for (const img of targetImgs) {
          const src = img.src || '';
          const cacheMatch = src.match(/ig_cache_key=([A-Za-z0-9%_-]+)/);
          if (cacheMatch) {
            mediaId = cacheMatch[1];
            break;
          }
        }

        // Fallback to numeric media ID in content image
        if (!mediaId) {
          for (const img of targetImgs) {
            const src = img.src || '';
            const numMatch = src.match(/_(\d{15,25})_/);
            if (numMatch) {
              mediaId = numMatch[1];
              break;
            }
          }
        }

        const baseMediaId = mediaId || `card_${idx}`;
        const occ = mediaOccurrences.get(baseMediaId) || 0;
        mediaOccurrences.set(baseMediaId, occ + 1);

        const text = (card.innerText || '').trim();

        return {
          cardIndex: idx,
          sender: sender || targetSender,
          mediaId: baseMediaId,
          occurrence: occ,
          text,
        };
      });
    }, actualSender);

    // Process clip cards in chronological order (oldest to newest)
    for (let i = 0; i < clipCards.length; i++) {
      const card = clipCards[i];
      // Ignore outgoing messages from bot itself
      if (card.sender && card.sender.toLowerCase().startsWith('dolphin.')) {
        continue;
      }

      const primaryMessageId = `msg_${resolvedThreadId}_${actualSender}_clip_${card.mediaId}_${card.occurrence}`;
      const legacyMessageId = `msg_${resolvedThreadId}_${actualSender}_clip_${card.mediaId}`;

      // If occurrence 0 and legacy message ID was previously recorded, maintain continuity
      const messageId = (card.occurrence === 0 && queue && queue.isMessageProcessed(legacyMessageId))
        ? legacyMessageId
        : primaryMessageId;

      // Deduplication: If already processed in SQLite or in memory, SKIP IT without clicking!
      if (queue && (queue.isMessageProcessed(messageId) || (card.occurrence === 0 && queue.isMessageProcessed(legacyMessageId)))) {
        continue;
      }
      if (this.processedMessageIds.has(messageId) || (card.occurrence === 0 && this.processedMessageIds.has(legacyMessageId))) {
        continue;
      }

      // Genuinely new message: click card to resolve shortcode
      let shortcode = null;
      try {
        await this.page.evaluate((idx) => {
          const cards = Array.from(document.querySelectorAll('div[role="button"]')).filter(b => {
            const svg = b.querySelector('svg[aria-label="Clip"]');
            const title = b.querySelector('title');
            return svg || (title && title.textContent === 'Clip');
          });
          if (cards[idx]) cards[idx].click();
        }, card.cardIndex);

        // Wait for URL to transition to /p/ or /reel/ modal
        await this.page.waitForURL(url => {
          const p = url.pathname;
          return p.includes('/reel/') || p.includes('/reels/') || p.includes('/p/');
        }, { timeout: 4000 }).catch(() => {});

        await this.page.waitForTimeout(1000);
        const modalUrl = this.page.url();
        shortcode = extractReelShortcode(modalUrl);

        // Fallback: inspect dialog anchors if URL hasn't transitioned
        if (!shortcode) {
          const dialogHref = await this.page.evaluate(() => {
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
              const anchor = dialog.querySelector('a[href*="/p/"], a[href*="/reel/"]');
              return anchor ? anchor.getAttribute('href') : null;
            }
            return null;
          });
          if (dialogHref) {
            shortcode = extractReelShortcode(dialogHref);
          }
        }

        // Close modal cleanly via Escape and fallback close button
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(500);
        const closeBtn = await this.page.$('svg[aria-label="Close"], svg[aria-label="Back"]');
        if (closeBtn) {
          await closeBtn.click().catch(() => {});
          await this.page.waitForTimeout(500);
        }
        await this.page.waitForTimeout(1000);
      } catch (err) {
        logger.debug('Error resolving clip card modal', { error: err.message });
      }

      if (shortcode && !detected.some(d => d.messageId === messageId)) {
        detected.push({
          reelUrl: normalizeReelUrl(shortcode),
          shortcode,
          threadId: String(resolvedThreadId),
          senderUsername: actualSender,
          source: 'shared_clip_card',
          messageId,
        });
      }
    }

    return detected;
  }

  /**
   * Polls all accessible threads and returns newly discovered Reel shares.
   * Strictly enforces sender allowlist and deduplicates message IDs.
   * @param {Object} [queue]
   */
  async pollForIncomingReels(queue = null) {
    const q = queue || this.queue;
    const { isSenderAllowed, assertSenderAllowed } = require('../security/sender-allowlist');

    try {
      await this.navigateToInbox();
      const threads = await this.getInboxThreads();
      logger.debug(`Found ${threads.length} direct threads`);

      const incomingReels = [];

      // Check the top 5 most recent threads
      for (const thread of threads.slice(0, 5)) {
        const isCandidate = isSenderAllowed(thread.username) || thread.username.toLowerCase().startsWith('nauman');

        // Security Gate: Reject unauthorized threads immediately
        if (!isCandidate) {
          assertSenderAllowed(thread.username, { threadId: thread.threadId, stage: 'INBOX_POLL' });
          continue;
        }

        logger.info(`Checking authorized thread for new Reel shares`, { username: thread.username, threadId: thread.threadId });
        const reels = await this.checkThreadForReels(thread.threadId, thread.username, { queue: q });
        if (reels.length > 0) {
          logger.info(`Found ${reels.length} new Reel share(s) in thread`, { username: thread.username, count: reels.length });
        }
        for (const reel of reels) {
          if (!this.processedMessageIds.has(reel.messageId)) {
            incomingReels.push(reel);
            this.processedMessageIds.add(reel.messageId);
          }
        }
      }

      return incomingReels;
    } catch (err) {
      logger.error('Error polling inbox for reels', { error: err.message });
      return [];
    }
  }

  /**
   * Scans authorized threads for all unread/unprocessed shared Reels without discarding them.
   * Enqueues each newly discovered Reel into SQLite with is_approved=1 for batch execution.
   * @param {Object} [options]
   * @param {Object} [options.queue]
   * @param {string} [options.threadId]
   * @param {string} [options.senderUsername]
   * @returns {Promise<Array<Object>>} Newly enqueued jobs
   */
  async collectUnprocessedReels(options = {}) {
    const q = options.queue || this.queue;
    const { isSenderAllowed, assertSenderAllowed } = require('../security/sender-allowlist');
    const newEnqueuedJobs = [];

    try {
      await this.navigateToInbox();

      let targetThreads = [];
      if (options.threadId) {
        targetThreads = [{ threadId: options.threadId, username: options.senderUsername || 'authorized_user' }];
      } else {
        const inboxThreads = await this.getInboxThreads();
        targetThreads = inboxThreads.filter(t => isSenderAllowed(t.username)).slice(0, 5);
      }

      for (const thread of targetThreads) {
        if (!isSenderAllowed(thread.username)) continue;

        // checkThreadForReels parses direct links, pasted URLs, and clip cards
        const reels = await this.checkThreadForReels(thread.threadId, thread.username, {
          queue: q,
          isBaselineScan: false, // Ensure they are ingested, NOT discarded!
        });

        for (const reel of reels) {
          if (!assertSenderAllowed(reel.senderUsername, { threadId: reel.threadId, stage: 'COLLECT_UNPROCESSED' })) {
            continue;
          }

          if (reel.messageId && q.isMessageProcessed(reel.messageId)) {
            continue;
          }

          const { job, isDuplicate } = q.createJob({
            threadId: reel.threadId,
            senderUsername: reel.senderUsername || thread.username,
            reelUrl: reel.reelUrl,
            shortcode: reel.shortcode,
            messageId: reel.messageId,
            enforceAllowlist: true,
          });

          if (!isDuplicate && job) {
            // Auto-approve since this is an explicit user batch trigger
            q.approveJob(job.id);
            newEnqueuedJobs.push(job);
            logger.info('Batch scan enqueued new Reel for commenting', {
              shortcode: reel.shortcode,
              creator: reel.senderUsername,
              jobId: job.id,
            });
          }
        }
      }

      return newEnqueuedJobs;
    } catch (err) {
      logger.error('Error collecting unprocessed Reels', { error: err.message });
      return newEnqueuedJobs;
    }
  }

  /**
   * Processes a bot command (/history, !history, /menu, !menu, /help, !help, /status, !status).
   * Formats structured reports and dispatches responses immediately to the thread.
   * @param {string} cmd
   * @param {string} threadId
   * @param {string} senderUsername
   * @param {string} messageId
   */
  /**
   * Processes a bot command (/help, /menu, /status, /history, /reset, /unfollow and ! aliases).
   * Strictly enforces sender authorization, deduplication, simulation/live separation,
   * safe preview requirements, and structured status reports.
   * @param {string} cmd
   * @param {string} threadId
   * @param {string} senderUsername
   * @param {string} messageId
   * @param {string} [args='']
   */
  async handleBotCommand(cmd, threadId, senderUsername, messageId, args = '') {
    const { isSenderAllowed, normalizeSenderUsername } = require('../security/sender-allowlist');
    const normalizedSender = normalizeSenderUsername(senderUsername);

    // Security Gate: Reject commands from unauthorized senders immediately
    if (!isSenderAllowed(senderUsername)) {
      logger.warn('IGNORED_UNAUTHORIZED_SENDER: Bot command rejected', {
        senderUsername: normalizedSender || 'UNKNOWN',
        cmd,
        threadId,
      });
      return;
    }

    const queue = this.queue;
    if (queue && messageId) {
      queue.recordProcessedMessage({
        messageId,
        threadId: String(threadId),
        senderUsername: normalizedSender || senderUsername,
        shortcode: `CMD_${cmd.toUpperCase()}`,
        reelUrl: `https://instagram.com/direct/t/${threadId}`,
      });
    }
    if (messageId) {
      this.processedMessageIds.add(messageId);
    }

    if (!this.sender) {
      logger.warn('Bot command intercepted but sender is not configured on inbox', { cmd, threadId });
      return;
    }

    let command = cmd.toLowerCase().trim();
    let normalizedArgs = (args || '').trim().toLowerCase();
    if (!normalizedArgs && command.includes(' ')) {
      const parts = command.split(/\s+/);
      command = parts[0];
      normalizedArgs = parts.slice(1).join(' ');
    }

    // Helper: Format uptime into human-readable string
    const formatUptime = (seconds) => {
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const parts = [];
      if (d > 0) parts.push(`${d}d`);
      if (h > 0 || d > 0) parts.push(`${h}h`);
      if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
      parts.push(`${s}s`);
      return parts.join(' ');
    };

    // 0. START BATCH TRIGGER COMMAND
    if (command === 'start') {
      logger.info(`[BOT COMMAND] Executing /start batch trigger for @${senderUsername} in thread ${threadId}`);
      if (this.app) {
        if (this.app.isBatchRunning) {
          await this.sender.sendMessage(threadId, '⚠️ A ReelLink batch run is already in progress! Please wait for it to complete.');
          return;
        }
        await this.sender.sendMessage(threadId, '🚀 ReelLink batch started! Scanning for unread Reels in this chat and beginning follow + comment workflow...');
        this.app.startBatch({ triggeredBy: 'DM', threadId: String(threadId), senderUsername })
          .then(async (result) => {
            const summary = (result && result.processedCount > 0)
              ? `✅ ReelLink batch completed! Successfully processed ${result.processedCount} Reel(s) (followed creators & posted comments).`
              : `ℹ️ ReelLink batch finished: No new unread Reels found in this chat.`;
            await this.sender.sendMessage(threadId, summary).catch(() => {});
          })
          .catch(async (err) => {
            logger.error('Error executing batch triggered via DM', { error: err.message });
            await this.sender.sendMessage(threadId, `❌ ReelLink batch encountered an error: ${err.message}`).catch(() => {});
          });
      } else {
        await this.sender.sendMessage(threadId, '🚀 Batch trigger received (app controller not attached).');
      }
      return;
    }

    // 1. HELP / MENU COMMAND
    if (command === 'help' || command === 'menu') {
      const msg = `🤖 ReelLink Bot Commands Menu:

• /start (or start, !start)
  Trigger batch mode: read all shared unread Reels in this chat, follow creators, and post comments.

• /status (or !status)
  View bot status, simulation/live mode, queue counts, actively processing jobs, awaiting approvals, and uptime.

• /history (or !history)
  View today's followed creators and recent Reel jobs with follow/comment outcomes (distinguishing live vs simulation).

• /reset (or !reset)
  Preview cancellable pending/awaiting jobs.
  To execute: /reset confirm (or !reset confirm)

• /unfollow (or !unfollow)
  Preview creators followed today.
  To execute: /unfollow confirm (or !unfollow confirm)

• /help (or /menu, !help, !menu)
  Display this command reference.

💡 Share any Instagram Reel to this chat, then send "start" or use the web dashboard to begin the batch workflow.`;

      logger.info(`[BOT COMMAND] Executing /${command} for @${senderUsername} in thread ${threadId}`);
      await this.sender.sendMessage(threadId, msg.trim());
      return;
    }

    // 2. STATUS COMMAND
    if (command === 'status') {
      const isLive = Boolean(
        this.isLiveMode ||
        (this.app && this.app.isLiveMode)
      );
      const autoApprove = Boolean(
        this.app && this.app.autoApprove
      );
      const modeStr = isLive
        ? (autoApprove ? 'LIVE (Auto-Approve)' : 'LIVE (Supervised Approval)')
        : 'SIMULATION';

      let uptimeStr = 'N/A';
      if (typeof process.uptime === 'function') {
        uptimeStr = formatUptime(process.uptime());
      } else if (this.startTime) {
        uptimeStr = formatUptime(Math.floor((Date.now() - this.startTime) / 1000));
      }

      const stats = queue ? queue.getSystemStats() : {
        pending: 0, awaiting_approval: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, waiting: 0, total: 0
      };

      // Determine actively processing jobs
      let processingList = [];
      if (this.app && this.app.currentJob) {
        processingList.push(this.app.currentJob);
      } else if (queue && typeof queue.getActiveProcessingJobs === 'function') {
        processingList = queue.getActiveProcessingJobs();
      }

      // Jobs awaiting operator approval
      const awaiting = queue ? queue.getJobsAwaitingApproval() : [];

      // Failed jobs with error summaries
      const failedJobs = queue && typeof queue.getFailedJobs === 'function' ? queue.getFailedJobs(3) : [];

      let msg = `⚙️ ReelLink System Status:\n\n`;
      msg += `• Mode: ${modeStr}\n`;
      msg += `• Uptime: ${uptimeStr}\n\n`;

      msg += `📊 Queue Breakdown (${stats.total} total jobs):\n`;
      msg += `• Pending: ${stats.pending}\n`;
      msg += `• Awaiting Approval: ${stats.awaiting_approval}\n`;
      msg += `• Actively Processing: ${processingList.length}\n`;
      msg += `• Completed: ${stats.completed}\n`;
      msg += `• Failed: ${stats.failed}\n`;
      if (stats.cancelled > 0) {
        msg += `• Cancelled: ${stats.cancelled}\n`;
      }

      msg += `\n🔄 Current Processing:\n`;
      if (processingList.length === 0) {
        msg += `• None (idle)\n`;
      } else {
        for (const p of processingList.slice(0, 3)) {
          msg += `• Job ${p.id ? p.id.slice(0, 8) : 'active'} (Reel ${p.shortcode || 'unknown'}) — ${p.stage || p.status || 'PROCESSING'}\n`;
        }
      }

      msg += `\n⏳ Awaiting Operator Approval (${awaiting.length}):\n`;
      if (awaiting.length === 0) {
        msg += `• None awaiting approval\n`;
      } else {
        for (const a of awaiting.slice(0, 3)) {
          msg += `• Job ${a.id.slice(0, 8)} (Reel ${a.shortcode}) from @${a.sender_username}\n`;
          msg += `  Approve: node src/approve.js ${a.id}\n`;
        }
        if (awaiting.length > 3) {
          msg += `  ... and ${awaiting.length - 3} more (run: node src/approve.js --list)\n`;
        }
      }

      if (failedJobs.length > 0) {
        msg += `\n⚠️ Recent Errors (${stats.failed} total failed):\n`;
        for (const f of failedJobs) {
          const err = (f.error_message || f.result_summary || 'Unknown error').split('\n')[0].slice(0, 70);
          msg += `• Reel ${f.shortcode || f.id.slice(0, 8)}: ${err}\n`;
        }
      }

      logger.info(`[BOT COMMAND] Executing /status for @${senderUsername} in thread ${threadId}`);
      await this.sender.sendMessage(threadId, msg.trim());
      return;
    }

    // 3. HISTORY COMMAND
    if (command === 'history') {
      if (!queue) return;
      const detailedFollowed = typeof queue.getDetailedFollowedCreatorsToday === 'function'
        ? queue.getDetailedFollowedCreatorsToday()
        : [];
      const recentJobs = typeof queue.getRecentJobs === 'function'
        ? queue.getRecentJobs(6)
        : [];

      let msg = `📋 ReelLink Bot Activity (Today) & History:\n\n`;

      // 3a. Creators followed today
      msg += `👥 Creators Followed Today (${detailedFollowed.length}):\n`;
      if (detailedFollowed.length === 0) {
        msg += '• None yet today\n';
      } else {
        for (const f of detailedFollowed.slice(0, 10)) {
          const tag = f.isLive ? 'LIVE' : (f.isSimulated ? 'SIMULATED' : 'RECORDED');
          const timeStr = f.followedAt ? ` (${f.followedAt.slice(11, 16)} UTC)` : '';
          msg += `• @${f.creator} [${tag}]${timeStr}\n`;
        }
        if (detailedFollowed.length > 10) {
          msg += `  ... and ${detailedFollowed.length - 10} more\n`;
        }
      }

      // 3b. Recent Reel Jobs
      msg += `\n🎬 Recent Reel Jobs (${recentJobs.length}):\n`;
      if (recentJobs.length === 0) {
        msg += '• No Reel jobs found in history\n';
      } else {
        for (const j of recentJobs) {
          const creator = j.creator_username ? `@${j.creator_username}` : 'unknown creator';
          const followTag = j.live_follow_verified_at
            ? 'Verified [LIVE]'
            : ((j.simulated_follow_status === 'COMPLETED' || j.is_simulated)
              ? 'Simulated [SIM]'
              : (j.follow_status || 'NOT_ATTEMPTED'));
          const commentTag = j.live_comment_posted_at
            ? `Posted "${j.keyword || '🙌'}" [LIVE]`
            : ((j.simulated_comment_status === 'POSTED' || j.is_simulated)
              ? `Simulated "${j.keyword || '🙌'}" [SIM]`
              : (j.comment_status || 'NOT_ATTEMPTED'));
          const timeStr = j.created_at ? ` [${j.created_at.slice(0, 16)}]` : '';

          msg += `• Reel ${j.shortcode} (${creator}) — ${j.status}${timeStr}\n`;
          msg += `  Follow: ${followTag} | Comment: ${commentTag}\n`;
        }
      }

      logger.info(`[BOT COMMAND] Executing /history for @${senderUsername} in thread ${threadId}`);
      await this.sender.sendMessage(threadId, msg.trim());
      return;
    }

    // 4. RESET COMMAND
    if (command === 'reset') {
      if (!queue) return;
      const activeJobId = (this.app && this.app.currentJobId) ? this.app.currentJobId : null;
      const eligible = typeof queue.getResetEligibleJobs === 'function'
        ? queue.getResetEligibleJobs(activeJobId)
        : [];

      const isConfirmed = normalizedArgs === 'confirm' || normalizedArgs === '--force';

      if (eligible.length === 0) {
        const msg = `🔄 ReelLink Reset Complete:\n\n• No pending or awaiting jobs to reset (0 eligible jobs).\n• Actively processing jobs, completed history, and duplicate safeguards are preserved.\n• The queue is clean and ready for new Reel requests.`;
        logger.info(`[BOT COMMAND] Executing /reset for @${senderUsername} in thread ${threadId}: queue is already clear (0 eligible)`);
        await this.sender.sendMessage(threadId, msg.trim());
        return;
      }

      if (!isConfirmed) {
        let msg = `🔄 ReelLink Reset Preview:\n\nFound ${eligible.length} job(s) eligible for reset:\n`;
        for (const j of eligible.slice(0, 5)) {
          const creator = j.creator_username ? `@${j.creator_username}` : 'unknown';
          msg += `• Job ${j.id.slice(0, 8)}: Reel ${j.shortcode} (${creator}) [Status: ${j.status}]\n`;
        }
        if (eligible.length > 5) {
          msg += `  ... and ${eligible.length - 5} more\n`;
        }
        msg += `\n🛡️ Safety Guarantees:\n`;
        msg += `• Actively processing jobs will NOT be cancelled.\n`;
        msg += `• Completed jobs and duplicate-prevention history are preserved.\n\n`;
        msg += `⚠️ To confirm and cancel these ${eligible.length} job(s), send:\n`;
        msg += `/reset confirm (or !reset confirm)`;

        logger.info(`[BOT COMMAND] Executing /reset preview for @${senderUsername} in thread ${threadId}: ${eligible.length} eligible jobs`);
        await this.sender.sendMessage(threadId, msg.trim());
        return;
      }

      // Confirmed reset execution
      const resetResult = typeof queue.resetEligibleJobs === 'function'
        ? queue.resetEligibleJobs(activeJobId)
        : { count: queue.resetPendingJobs(activeJobId), resetJobs: [] };

      let msg = `🔄 ReelLink Reset Complete:\n\n`;
      msg += `• Cancelled ${resetResult.count} eligible pending/waiting job(s).\n`;
      if (resetResult.resetJobs && resetResult.resetJobs.length > 0) {
        for (const j of resetResult.resetJobs.slice(0, 5)) {
          msg += `  - Reel ${j.shortcode} (was ${j.status}) -> CANCELLED\n`;
        }
        if (resetResult.resetJobs.length > 5) {
          msg += `  - ... and ${resetResult.resetJobs.length - 5} more\n`;
        }
      }
      msg += `• Status set to CANCELLED.\n`;
      msg += `• Active jobs, completed history, and duplicate safeguards were preserved.\n`;
      msg += `• The queue is now clear and ready for new Reel requests.`;

      logger.info(`[BOT COMMAND] Executed /reset confirm for @${senderUsername} in thread ${threadId}: cancelled ${resetResult.count} jobs`);
      await this.sender.sendMessage(threadId, msg.trim());
      return;
    }

    // 5. UNFOLLOW COMMAND (Smart 2-Day Retention Manager)
    if (command === 'unfollow') {
      if (!queue) return;
      const unfollowData = typeof queue.getFollowedCreatorsForUnfollow === 'function'
        ? queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 })
        : { eligible: [], protected: [], all: queue.getDetailedFollowedCreatorsToday() || [] };

      const allCreators = unfollowData.all || [];
      const eligibleCreators = unfollowData.eligible || [];
      const protectedCreators = unfollowData.protected || [];

      const isForceAll = normalizedArgs === 'all confirm' || normalizedArgs === 'all' || normalizedArgs === '--all';
      const isConfirmed = normalizedArgs === 'confirm' || normalizedArgs === '--force' || normalizedArgs.includes('confirm');

      // 5a. Preview mode (when not confirmed)
      if (!isConfirmed) {
        let msg = `👥 ReelLink Unfollow Preview (2-Day Retention Manager):\n\n`;

        if (allCreators.length === 0) {
          msg += `• No creators were followed today or currently recorded.\n`;
          msg += `• Nothing to unfollow.`;
        } else {
          if (eligibleCreators.length > 0) {
            msg += `✅ Eligible for Unfollow (>2 days old — ${eligibleCreators.length}):\n`;
            for (const c of eligibleCreators.slice(0, 8)) {
              const tag = c.isLive ? 'LIVE' : (c.isSimulated ? 'SIM' : 'REC');
              const daysStr = c.ageDays !== undefined ? `${c.ageDays}d ago` : '2d+';
              msg += `  • @${c.creator} (${daysStr}) [${tag}]\n`;
            }
            if (eligibleCreators.length > 8) {
              msg += `    ... and ${eligibleCreators.length - 8} more\n`;
            }
            msg += `\n`;
          }

          if (protectedCreators.length > 0) {
            msg += `🛡️ Protected (<2 days retention — ${protectedCreators.length}):\n`;
            for (const c of protectedCreators.slice(0, 5)) {
              const remStr = c.remainingHours !== undefined ? `${c.remainingHours}h remaining` : '<48h';
              msg += `  • @${c.creator} (${remStr})\n`;
            }
            if (protectedCreators.length > 5) {
              msg += `    ... and ${protectedCreators.length - 5} more\n`;
            }
            msg += `\n`;
          }

          msg += `Mode: ${this.isLiveMode ? 'LIVE (profile navigation & dialog click)' : 'SIMULATION'}\n\n`;

          if (eligibleCreators.length > 0) {
            msg += `👉 To unfollow eligible creators (>2 days old), send:\n`;
            msg += `   /unfollow confirm\n\n`;
            msg += `👉 To force unfollow ALL accounts immediately (including protected), send:\n`;
            msg += `   /unfollow all confirm`;
          } else {
            msg += `ℹ️ All followed creators are currently within the 2-day retention window to protect your account health.\n\n`;
            msg += `👉 To force unfollow now anyway, send:\n`;
            msg += `   /unfollow confirm`;
          }
        }

        logger.info(`[BOT COMMAND] Executing /unfollow preview for @${senderUsername} in thread ${threadId}: ${eligibleCreators.length} eligible, ${protectedCreators.length} protected`);
        await this.sender.sendMessage(threadId, msg.trim());
        return;
      }

      // Check if an active browser Reel job is running
      if (this.app && this.app.currentJob && this.isLiveMode) {
        const activeMsg = `⚠️ Cannot unfollow right now: a Reel job is actively being processed in the browser. Please wait for the current job to complete and try again.`;
        await this.sender.sendMessage(threadId, activeMsg);
        return;
      }

      // Determine target creators:
      // If forceAll is requested OR if no eligible creators exist (e.g. freshly followed test), target all.
      // Otherwise, prioritize eligible (>2 day) creators to preserve 2-day retention protection.
      const targetCreators = (isForceAll || eligibleCreators.length === 0)
        ? allCreators
        : eligibleCreators;

      if (targetCreators.length === 0) {
        await this.sender.sendMessage(threadId, '👥 ReelLink Unfollow:\n\n• No creators were followed today.');
        return;
      }

      const scopeDesc = isForceAll ? 'all' : (eligibleCreators.length > 0 ? 'eligible (>2d)' : '');
      await this.sender.sendMessage(threadId, `⏳ Unfollowing ${targetCreators.length} ${scopeDesc ? scopeDesc + ' ' : ''}creator(s)...`);

      const unfollowed = [];
      const failed = [];

      for (const c of targetCreators) {
        const creatorName = c.creator;
        try {
          const res = (this.creatorManager && typeof this.creatorManager.unfollowCreator === 'function')
            ? await this.creatorManager.unfollowCreator(creatorName, { isSimulation: !this.isLiveMode })
            : await this.unfollowCreatorDirect(creatorName, { isSimulation: !this.isLiveMode });

          if (res && res.success) {
            unfollowed.push(creatorName);
            if (queue && typeof queue.markCreatorUnfollowed === 'function') {
              queue.markCreatorUnfollowed(creatorName);
            }
          } else {
            failed.push({ creator: creatorName, reason: (res && (res.error || res.note)) || 'Failed' });
          }
        } catch (err) {
          failed.push({ creator: creatorName, reason: err.message });
        }
        await new Promise(r => setTimeout(r, 1500));
      }

      let replyMsg = `👥 ReelLink Unfollow Complete:\n\n• Successfully unfollowed (${unfollowed.length}):\n`;
      if (unfollowed.length > 0) {
        unfollowed.forEach(c => { replyMsg += `  - @${c}\n`; });
      } else {
        replyMsg += '  - None\n';
      }

      const remainingProtected = protectedCreators.filter(p => !unfollowed.includes(p.creator));
      if (remainingProtected.length > 0 && !isForceAll) {
        replyMsg += `\n🛡️ Retained under 2-day protection (${remainingProtected.length}):\n`;
        remainingProtected.slice(0, 5).forEach(p => {
          replyMsg += `  - @${p.creator} (${p.remainingHours || 48}h remaining)\n`;
        });
        if (remainingProtected.length > 5) {
          replyMsg += `    ... and ${remainingProtected.length - 5} more\n`;
        }
      }

      if (failed.length > 0) {
        replyMsg += `\n• Skipped / Not currently following (${failed.length}):\n`;
        failed.forEach(f => { replyMsg += `  - @${f.creator} (${f.reason})\n`; });
      }

      logger.info(`[BOT COMMAND] Executed /unfollow confirm for @${senderUsername} in thread ${threadId}: ${unfollowed.length} unfollowed, ${failed.length} failed`);
      await this.sender.sendMessage(threadId, replyMsg.trim());
      return;
    }
  }

  /**
   * Directly unfollows a creator by visiting their Instagram profile and confirming in the dialog.
   * If in simulation mode, safely simulates without opening Playwright or navigating.
   * @param {string} creatorUsername
   * @param {Object} [options]
   * @param {boolean} [options.isSimulation]
   * @returns {Promise<{ success: boolean, creator: string, isSimulated?: boolean, error?: string, note?: string }>}
   */
  async unfollowCreatorDirect(creatorUsername, options = {}) {
    const cleanCreator = (creatorUsername || '').replace(/^@/, '').trim();
    const isSim = options.isSimulation !== undefined ? options.isSimulation : !this.isLiveMode;

    if (isSim) {
      logger.info(`⚡ [SIMULATION] Unfollowing creator @${cleanCreator}`);
      if (this.queue) this.queue.markCreatorUnfollowed(cleanCreator);
      return { success: true, creator: cleanCreator, isSimulated: true };
    }

    try {
      if (!this.page) await this.init();
      const profileUrl = `https://www.instagram.com/${cleanCreator}/`;
      logger.info('Navigating to creator profile to unfollow', { profileUrl, creator: cleanCreator });
      await this.page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2500);

      const followingBtn = await this.page.$('header button:has-text("Following"), header div[role="button"]:has-text("Following")');
      if (!followingBtn) {
        logger.info('Not currently following or Following button not found', { creator: cleanCreator });
        if (this.queue) this.queue.markCreatorUnfollowed(cleanCreator);
        return { success: true, creator: cleanCreator, note: 'Not currently following' };
      }

      await followingBtn.click();
      await this.page.waitForTimeout(1500);

      // Confirm unfollow in modal
      const unfollowConfirmed = await this.page.evaluate(() => {
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

      await this.page.waitForTimeout(2000);
      if (this.queue) this.queue.markCreatorUnfollowed(cleanCreator);
      logger.info('Successfully unfollowed creator', { creator: cleanCreator, unfollowConfirmed });
      return { success: true, creator: cleanCreator };
    } catch (err) {
      logger.error('Error unfollowing creator', { creator: cleanCreator, error: err.message });
      return { success: false, creator: cleanCreator, error: err.message };
    }
  }
}

module.exports = InstagramInbox;
