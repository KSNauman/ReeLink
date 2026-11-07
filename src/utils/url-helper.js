/**
 * URL Utilities for ReelLink
 * Handles normalization, regex extraction, and shortcode parsing for Instagram Reels.
 */

// Regular expression matching Instagram Reel, Post, or TV shortcodes
const REEL_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i;
const ALL_REELS_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/gi;

// Generic URL regex for finding external candidate links in text
const URL_REGEX = /https?:\/\/[^\s<>"'{}|\\^`[\]]+/gi;

/**
 * Extracts the first Instagram Reel shortcode from a given text or URL.
 * Returns null if no valid Instagram media URL is found.
 * @param {string} text
 * @returns {string|null} shortcode (e.g. 'C_xYz123')
 */
function extractReelShortcode(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(REEL_REGEX);
  return match ? match[1] : null;
}

/**
 * Normalizes an Instagram shortcode or raw URL into a canonical Reel URL.
 * @param {string} shortcodeOrUrl
 * @returns {string|null} Canonical URL: https://www.instagram.com/reel/[shortcode]/
 */
function normalizeReelUrl(shortcodeOrUrl) {
  if (!shortcodeOrUrl) return null;
  const shortcode = extractReelShortcode(shortcodeOrUrl) || shortcodeOrUrl.trim();
  // Valid Instagram shortcodes are alphanumeric plus _ and -
  if (/^[A-Za-z0-9_-]+$/.test(shortcode)) {
    return `https://www.instagram.com/reel/${shortcode}/`;
  }
  return null;
}

/**
 * Extracts all unique external HTTP/HTTPS URLs from any text string.
 * Strips common trailing punctuation (dots, commas, closing parens).
 * @param {string} text
 * @returns {string[]} array of normalized URLs
 */
function extractExternalUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(URL_REGEX) || [];
  const cleanUrls = matches.map(url => {
    // Strip trailing punctuation often caught by regex in prose
    return url.replace(/[.,;:!?''")\]]+$/, '');
  });
  return [...new Set(cleanUrls)];
}

/**
 * Strips standard tracking parameters (utm_*, ig_*, igsh, fbclid, etc.) from a URL.
 * @param {string} rawUrl
 * @returns {string} cleaned URL
 */
function cleanTrackingParams(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const keysToDelete = [];
    for (const key of parsed.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith('utm_') ||
        lower.startsWith('ig_') ||
        lower === 'igsh' ||
        lower === 'igshid' ||
        lower === 'fbclid' ||
        lower === 'gclid' ||
        lower === 'ref'
      ) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Resolves destination URL from redirect wrappers (QuickDM, ManyChat, Instagram link shim, etc.)
 * e.g. https://quickdm.app/r?to=https%3A%2F%2Faibuildercup.com%2F -> https://aibuildercup.com/
 * @param {string} rawUrl
 * @returns {string} resolved destination URL
 */
function resolveDestinationUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    // Check for common redirect parameters: to, u, url, target, dest, redirect, link
    for (const param of ['to', 'u', 'url', 'target', 'dest', 'redirect', 'link']) {
      const val = parsed.searchParams.get(param);
      if (val && val.startsWith('http')) {
        return cleanTrackingParams(decodeURIComponent(val));
      }
    }
    return cleanTrackingParams(rawUrl);
  } catch {
    return rawUrl;
  }
}

/**
 * Checks if a URL points only to an automation provider watermark domain (e.g. quickdm.app root),
 * rather than a genuine creator resource.
 * @param {string} url
 * @returns {boolean}
 */
function isWatermarkUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (['quickdm.app', 'manychat.com', 'linkdm.co', 'chatfuel.com'].includes(host) && (!pathname || pathname === '')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  extractReelShortcode,
  normalizeReelUrl,
  extractExternalUrls,
  cleanTrackingParams,
  resolveDestinationUrl,
  isWatermarkUrl,
  REEL_REGEX,
};
