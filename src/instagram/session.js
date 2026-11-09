const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');

class BrowserSession {
  constructor(options = {}) {
    this.profileDir = options.profileDir || config.instagram.profileDir;
    this.headless = options.headless !== undefined ? options.headless : config.instagram.headless;
    this.channel = options.channel !== undefined ? options.channel : config.instagram.browserChannel;
    this.context = null;
    this.page = null;
    this._isInitializing = false;
  }

  /**
   * Ensures the browser profile directory exists and cleans stale lockfiles if necessary.
   */
  _prepareProfileDir() {
    if (!fs.existsSync(this.profileDir)) {
      fs.mkdirSync(this.profileDir, { recursive: true });
      logger.info('Created browser profile directory', { path: this.profileDir });
    }
  }

  /**
   * Launches or returns the active persistent Chromium context.
   */
  async getContext() {
    if (this.context) {
      return this.context;
    }

    if (this._isInitializing) {
      // Wait for existing initialization to finish
      while (this._isInitializing) {
        await new Promise(r => setTimeout(r, 200));
      }
      return this.context;
    }

    this._isInitializing = true;
    try {
      this._prepareProfileDir();

      logger.info('Launching browser with persistent context', {
        profileDir: this.profileDir,
        headless: this.headless,
        channel: this.channel || 'bundled-chromium',
      });

      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        // Use the installed Microsoft Edge so the packaged app doesn't ship Chromium.
        ...(this.channel ? { channel: this.channel } : {}),
        viewport: { width: 1280, height: 800 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
        locale: 'en-US',
      });

      // Handle unexpected close
      this.context.on('close', () => {
        logger.warn('Browser context closed');
        this.context = null;
        this.page = null;
      });

      return this.context;
    } catch (err) {
      logger.error('Failed to launch browser context', { error: err.message });
      throw err;
    } finally {
      this._isInitializing = false;
    }
  }

  /**
   * Returns the primary page in the persistent context.
   */
  async getPage() {
    const context = await this.getContext();
    const pages = context.pages();
    if (pages.length > 0) {
      this.page = pages[0];
    } else {
      this.page = await context.newPage();
    }
    return this.page;
  }

  /**
   * Checks whether the current session has an authenticated Instagram login.
   * Navigates to instagram.com and detects whether we are redirected to /accounts/login/
   * or see the authenticated direct/nav bar.
   * @returns {Promise<{ authenticated: boolean, currentUrl: string, username?: string }>}
   */
  async checkAuthStatus() {
    const page = await this.getPage();
    try {
      logger.info('Checking Instagram authentication status...');
      await page.goto('https://www.instagram.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Short wait for client-side routing
      await page.waitForTimeout(3000);

      const currentUrl = page.url();

      if (currentUrl.includes('/accounts/login') || currentUrl.includes('/accounts/emailsignup')) {
        logger.warn('Not authenticated: Redirected to login page', { currentUrl });
        return { authenticated: false, currentUrl };
      }

      // Check for common authenticated DOM indicators: Direct messages link, navigation icons
      const directIcon = await page.$('a[href*="/direct/inbox"], svg[aria-label*="Direct"], svg[aria-label*="Messenger"]');
      const profileLink = await page.$('a[href*="/accounts/edit/"], a[role="link"][href*="/"] img[alt*="profile picture"]');

      const isAuthenticated = Boolean(directIcon || profileLink || (!currentUrl.includes('/accounts/')));

      logger.info('Instagram authentication check completed', {
        authenticated: isAuthenticated,
        currentUrl,
      });

      return {
        authenticated: isAuthenticated,
        currentUrl,
      };
    } catch (err) {
      logger.error('Error checking Instagram auth status', { error: err.message });
      return { authenticated: false, currentUrl: page.url(), error: err.message };
    }
  }

  /**
   * Opens a visible browser window on the Instagram login page and waits until
   * the user has signed in (or closes the window / the timeout passes).
   * The login is kept in the persistent profile for later batches.
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=600000]
   * @returns {Promise<{ authenticated: boolean, reason: string }>}
   */
  async interactiveLogin(options = {}) {
    const timeoutMs = options.timeoutMs || 10 * 60 * 1000;

    // Login must be visible: reopen headful if a headless context is running.
    if (this.context && this.headless) await this.close();
    const previousHeadless = this.headless;
    this.headless = false;

    try {
      const page = await this.getPage();
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!this.context || page.isClosed()) {
          return { authenticated: false, reason: 'Browser window was closed before login finished' };
        }
        const url = page.url();
        const onAuthPage = /\/accounts\/(login|emailsignup|onetap)|\/challenge\//.test(url);
        if (!onAuthPage && url.includes('instagram.com')) {
          const nav = await page.$('a[href*="/direct/inbox"], svg[aria-label*="Direct"], svg[aria-label*="Messenger"], svg[aria-label="Home"]').catch(() => null);
          if (nav) {
            logger.info('Instagram login detected and saved to profile');
            return { authenticated: true, reason: 'Logged in' };
          }
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      return { authenticated: false, reason: 'Timed out waiting for login' };
    } finally {
      await this.close();
      this.headless = previousHeadless;
    }
  }

  /**
   * Gracefully shuts down the browser context.
   */
  async close() {
    if (this.context) {
      logger.info('Closing persistent browser context');
      try {
        await this.context.close();
      } catch (err) {
        logger.warn('Error during browser context close', { error: err.message });
      } finally {
        this.context = null;
        this.page = null;
      }
    }
  }
}

module.exports = BrowserSession;
