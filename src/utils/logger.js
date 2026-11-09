const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  security: 4,
};

const currentLevelNum = LEVELS[config.logLevel] ?? LEVELS.info;

// Subscribers (the desktop window) receive every emitted log line.
const listeners = new Set();

// Append-only log file in the data directory, so a packaged app (no terminal)
// still leaves a trail for troubleshooting. Disabled under `node --test`.
let fileStream = null;
function getFileStream() {
  if (fileStream || process.env.NODE_TEST_CONTEXT || process.env.REELLINK_NO_LOG_FILE) return fileStream;
  try {
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    fileStream = fs.createWriteStream(config.logFile, { flags: 'a' });
    fileStream.on('error', () => { fileStream = null; });
  } catch {
    fileStream = null;
  }
  return fileStream;
}

/**
 * Sanitizes input to prevent accidental credential or token leakage.
 */
function sanitize(data) {
  if (typeof data === 'string') {
    // Redact password or token-like patterns
    return data
      .replace(/(password|token|secret|key|cookie)=([^\s&]+)/gi, '$1=[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
  }
  if (data && typeof data === 'object') {
    const copy = Array.isArray(data) ? [] : {};
    for (const [k, v] of Object.entries(data)) {
      if (/password|secret|token|cookie|auth|session/i.test(k)) {
        copy[k] = '[REDACTED]';
      } else {
        copy[k] = sanitize(v);
      }
    }
    return copy;
  }
  return data;
}

function formatLog(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const safeMeta = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(sanitize(meta))}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${sanitize(message)}${safeMeta}`;
}

function emit(level, consoleFn, msg, meta) {
  const line = formatLog(level, msg, meta);
  consoleFn(line);
  const stream = getFileStream();
  if (stream) stream.write(line + '\n');
  for (const fn of listeners) {
    try {
      fn({ level, message: String(sanitize(msg)), time: new Date() });
    } catch {}
  }
}

const logger = {
  debug(msg, meta) {
    if (currentLevelNum <= LEVELS.debug) emit('debug', console.log, msg, meta);
  },
  info(msg, meta) {
    if (currentLevelNum <= LEVELS.info) emit('info', console.log, msg, meta);
  },
  warn(msg, meta) {
    if (currentLevelNum <= LEVELS.warn) emit('warn', console.warn, msg, meta);
  },
  error(msg, meta) {
    if (currentLevelNum <= LEVELS.error) emit('error', console.error, msg, meta);
  },
  security(msg, meta) {
    // Security logs are always emitted
    emit('security', console.error, msg, meta);
  },
  /**
   * Subscribe to log lines. Returns an unsubscribe function.
   * @param {(entry: {level: string, message: string, time: Date}) => void} fn
   */
  onLog(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

module.exports = logger;
