/**
 * Sender Allowlist Security Module
 * Strictly limits incoming Reel ingestion and creator workflows to approved Instagram accounts.
 * Fails closed if sender identity is missing, ambiguous, or not on the allowlist.
 */
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Normalizes an Instagram username by trimming, lowercasing, and stripping leading '@'.
 * @param {string|any} username
 * @returns {string|null} normalized username or null if invalid
 */
function normalizeSenderUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const trimmed = username.trim().toLowerCase();
  const stripped = trimmed.replace(/^@+/, '');
  if (!stripped || stripped === 'unknown' || stripped === 'undefined' || stripped === 'null') {
    return null;
  }
  return stripped;
}

/**
 * Returns the active list of normalized allowed sender usernames.
 * @param {Array<string>} [customAllowlist]
 * @returns {string[]}
 */
function getEffectiveAllowedSenders(customAllowlist = null) {
  const source = customAllowlist || config.security?.allowedSenders || config.instagram?.allowedUsers || ['nauman', 'ksydn_'];
  return source
    .map(u => normalizeSenderUsername(u))
    .filter(Boolean);
}

/**
 * Checks whether a sender username is authorized under the allowlist.
 * Fails closed (returns false) if identity is missing, invalid, or unauthorized.
 * @param {string|any} rawUsername
 * @param {Array<string>} [customAllowlist]
 * @returns {boolean}
 */
function isSenderAllowed(rawUsername, customAllowlist = null) {
  const normalized = normalizeSenderUsername(rawUsername);
  if (!normalized) return false;

  const allowed = getEffectiveAllowedSenders(customAllowlist);
  if (allowed.length === 0) {
    // Fail closed if allowlist is empty
    return false;
  }

  return (
    allowed.includes(normalized) ||
    (normalized === 'naumannn' && allowed.includes('nauman'))
  );
}

/**
 * Enforces the allowlist security rule. If unauthorized or missing,
 * logs a concise IGNORED_UNAUTHORIZED_SENDER event without exposing private message contents.
 * @param {string|any} rawUsername
 * @param {Object} [context]
 * @param {string} [context.threadId]
 * @param {string} [context.stage]
 * @param {Array<string>} [customAllowlist]
 * @returns {boolean} true if allowed, false if rejected
 */
function assertSenderAllowed(rawUsername, context = {}, customAllowlist = null) {
  const normalized = normalizeSenderUsername(rawUsername);

  if (!isSenderAllowed(rawUsername, customAllowlist)) {
    logger.warn('IGNORED_UNAUTHORIZED_SENDER', {
      senderUsername: normalized || 'UNKNOWN',
      threadId: context.threadId || 'UNKNOWN',
      stage: context.stage || 'SECURITY_GATE',
    });
    return false;
  }

  return true;
}

module.exports = {
  normalizeSenderUsername,
  getEffectiveAllowedSenders,
  isSenderAllowed,
  assertSenderAllowed,
};
