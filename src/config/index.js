const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '../../');

// ─────────────────────────────────────────────────────────────
// Personal tool: the ONLY Instagram account allowed to send Reels
// to the bot. Change this one line if your handle changes.
// ─────────────────────────────────────────────────────────────
const OWNER_USERNAME = 'ksydn_';
// How that account appears in the inbox list (used only to pick which chat to open).
const OWNER_DISPLAY_NAME = 'Naumannn';

// Where the database, browser profile and logs live.
// The desktop app sets REELLINK_DATA_DIR to %APPDATA%\ReelLink;
// running from source falls back to ./data.
const DATA_DIR = path.resolve(process.env.REELLINK_DATA_DIR || path.join(ROOT_DIR, 'data'));

const config = {
  env: process.env.NODE_ENV || 'development',
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  owner: OWNER_USERNAME,
  ownerDisplayName: OWNER_DISPLAY_NAME,

  // Security & Access Control Allowlist (hardcoded to the owner)
  security: {
    allowedSenders: [OWNER_USERNAME],
  },

  // Instagram Configuration
  instagram: {
    profileDir: path.join(DATA_DIR, 'browser_profile'),
    // Real installed browser Playwright drives: 'msedge' ships with Windows.
    browserChannel: process.env.IG_BROWSER_CHANNEL || 'msedge',
    headless: process.env.IG_HEADLESS === 'true',
    dryRun: process.env.DRY_RUN === 'true',
    allowedUsers: [OWNER_USERNAME],
  },

  // Database Configuration
  database: {
    path: process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(DATA_DIR, 'reellink.db'),
  },

  logFile: path.join(DATA_DIR, 'reellink.log'),

  // The desktop app points this at Documents\\ReelLink so it's easy to find.
  resourcesCsvPath: path.join(process.env.REELLINK_CSV_DIR || DATA_DIR, 'ReelLink_Resources.csv'),

  // Creator Workflow & Retries
  creatorWorkflow: {
    enabled: process.env.CREATOR_WORKFLOW_ENABLED === 'true', // Live mode disabled by default
    simulationMode: process.env.CREATOR_WORKFLOW_SIMULATION !== 'false', // Safe simulation mode by default
    requireApproval: process.env.CREATOR_WORKFLOW_REQUIRE_APPROVAL !== 'false', // Explicit user approval required
    allowFollow: process.env.CREATOR_WORKFLOW_ALLOW_FOLLOW !== 'false', // Follow-first capability enabled
    minLiveWaitingWindowSec: 300, // 5 minutes strict minimum for live monitoring
    timeoutSec: Math.max(300, parseInt(process.env.CREATOR_WORKFLOW_TIMEOUT_SEC || '300', 10)),
    initialWaitingWindowSec: Math.max(300, parseInt(process.env.CREATOR_WORKFLOW_TIMEOUT_SEC || process.env.CREATOR_INITIAL_WAITING_WINDOW_SEC || '300', 10)),
    followVerificationTimeoutMs: parseInt(process.env.CREATOR_FOLLOW_TIMEOUT_MS || '5000', 10),
    inboxPollIntervalMs: Math.max(3000, Math.min(5000, parseInt(process.env.CREATOR_INBOX_POLL_INTERVAL_MS || '4000', 10))), // 3-5 seconds continuous polling
    backgroundPollIntervalSec: parseInt(process.env.CREATOR_BACKGROUND_POLL_INTERVAL_SEC || '30', 10),
    maxRetries: parseInt(process.env.JOB_MAX_RETRIES || '3', 10),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
