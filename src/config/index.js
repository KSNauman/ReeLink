const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '../../');

const config = {
  env: process.env.NODE_ENV || 'development',
  rootDir: ROOT_DIR,
  
  // Security & Access Control Allowlist
  security: {
    allowedSenders: (process.env.IG_ALLOWED_USERS || process.env.ALLOWED_SENDERS || 'nauman,ksydn_')
      .split(',')
      .map(u => u.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  },

  // Instagram Configuration
  instagram: {
    username: process.env.IG_USERNAME || '',
    password: process.env.IG_PASSWORD || '',
    profileDir: path.resolve(ROOT_DIR, process.env.IG_PROFILE_DIR || './data/browser_profile'),
    headless: process.env.IG_HEADLESS === 'true',
    pollIntervalSec: parseInt(process.env.IG_POLL_INTERVAL_SEC || '15', 10),
    dryRun: process.env.DRY_RUN === 'true',
    supervisedMode: process.env.SUPERVISED_MODE === 'true',
    allowedUsers: (process.env.IG_ALLOWED_USERS || process.env.ALLOWED_SENDERS || 'nauman,ksydn_')
      .split(',')
      .map(u => u.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  },

  // Database Configuration
  database: {
    path: path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/reellink.db'),
  },

  // Media & Storage
  storage: {
    mediaDir: path.resolve(ROOT_DIR, process.env.MEDIA_STORAGE_DIR || './data/media'),
    tempDir: path.resolve(ROOT_DIR, './data/temp'),
  },

  // Extraction Pipeline
  pipeline: {
    ocrSampleIntervalSec: parseFloat(process.env.OCR_SAMPLE_INTERVAL_SEC || '2'),
    ocrMaxFrames: parseInt(process.env.OCR_MAX_FRAMES || '30', 10),
    tesseractPath: process.env.TESSERACT_PATH || 'tesseract',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    whisperModel: process.env.WHISPER_MODEL || 'base',
    whisperDevice: process.env.WHISPER_DEVICE || 'auto',
    pythonPath: process.env.PYTHON_PATH || 'python',
  },

  // Search Configuration
  search: {
    provider: process.env.SEARCH_PROVIDER || 'ddg',
    maxResults: parseInt(process.env.SEARCH_MAX_RESULTS || '5', 10),
    confidenceThreshold: parseFloat(process.env.SEARCH_CONFIDENCE_THRESHOLD || '0.65'),
    serpApiKey: process.env.SERPAPI_API_KEY || '',
    tavilyApiKey: process.env.TAVILY_API_KEY || '',
    googleApiKey: process.env.GOOGLE_SEARCH_API_KEY || '',
    googleCx: process.env.GOOGLE_SEARCH_CX || '',
  },

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

  // Web Dashboard Configuration
  web: {
    enabled: process.env.WEB_ENABLED !== 'false',
    port: parseInt(process.env.PORT || process.env.WEB_PORT || '3000', 10),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
