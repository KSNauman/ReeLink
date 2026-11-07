const config = require('../config');

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  security: 4,
};

const currentLevelNum = LEVELS[config.logLevel] ?? LEVELS.info;

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
  const safeMeta = Object.keys(meta).length > 0 ? ` ${JSON.stringify(sanitize(meta))}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${sanitize(message)}${safeMeta}`;
}

const logger = {
  debug(msg, meta) {
    if (currentLevelNum <= LEVELS.debug) {
      console.log(formatLog('debug', msg, meta));
    }
  },
  info(msg, meta) {
    if (currentLevelNum <= LEVELS.info) {
      console.log(formatLog('info', msg, meta));
    }
  },
  warn(msg, meta) {
    if (currentLevelNum <= LEVELS.warn) {
      console.warn(formatLog('warn', msg, meta));
    }
  },
  error(msg, meta) {
    if (currentLevelNum <= LEVELS.error) {
      console.error(formatLog('error', msg, meta));
    }
  },
  security(msg, meta) {
    // Security logs are always emitted
    console.error(formatLog('security', msg, meta));
  },
};

module.exports = logger;
