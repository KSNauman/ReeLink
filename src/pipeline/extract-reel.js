/**
 * Stage A1: Reel Metadata & Caption Extraction
 * Extracts creator handle, caption, hashtags, and embedded direct URLs.
 * Implements Early Stopping if the caption already contains a reliable target resource link.
 */
const { extractExternalUrls, extractReelShortcode, cleanTrackingParams } = require('../utils/url-helper');
const logger = require('../utils/logger');
const { extractCreatorRequirements } = require('./creator-interaction');

const HASHTAG_REGEX = /#([a-zA-Z0-9_]+)/g;

/**
 * Parses raw Reel caption and metadata into structured clues.
 * @param {Object} params
 * @param {string} params.shortcode
 * @param {string} [params.caption]
 * @param {string} [params.creator]
 * @param {string} [params.rawText]
 * @returns {Object} Structured metadata & early stopping decision
 */
function parseReelMetadata({ shortcode, caption = '', creator = '', rawText = '' }) {
  const fullText = [caption, rawText].filter(Boolean).join('\n');

  // 1. Extract external links
  const extractedUrls = extractExternalUrls(fullText)
    .filter(url => !url.includes('instagram.com/'))
    .map(cleanTrackingParams);

  // 2. Extract hashtags
  const hashtags = [];
  let match;
  while ((match = HASHTAG_REGEX.exec(fullText)) !== null) {
    hashtags.push(match[1].toLowerCase());
  }

  // 3. Extract call to action keyword using unified requirements parser
  const reqs = extractCreatorRequirements(fullText);
  const ctaKeyword = reqs.keyword || null;

  // 4. Identify high-priority direct links (GitHub repos, PDFs, Notion, Drive)
  const directResourceUrls = extractedUrls.filter(url => {
    return (
      url.includes('github.com/') ||
      url.endsWith('.pdf') ||
      url.includes('notion.site/') ||
      url.includes('drive.google.com/') ||
      url.includes('huggingface.co/')
    );
  });

  // Early stopping decision:
  // If we already have a direct resource URL in the caption, we do NOT need expensive video download/OCR
  const hasDirectResource = directResourceUrls.length > 0;
  const needsMediaInspection = !hasDirectResource;

  const result = {
    shortcode,
    creator: creator.replace(/^@/, '').trim(),
    caption: fullText.trim(),
    hashtags: [...new Set(hashtags)],
    externalUrls: extractedUrls,
    directResourceUrls,
    ctaKeyword,
    hasDirectResource,
    needsMediaInspection,
  };

  logger.info('Reel metadata parsed', {
    shortcode,
    creator: result.creator,
    urlsFound: extractedUrls.length,
    directResources: directResourceUrls.length,
    ctaKeyword,
    needsMediaInspection,
  });

  return result;
}

/**
 * Pulls creator + caption out of a post's og:description. Instagram uses two formats:
 *   Caption text... - @handle on November 7, 2026
 *   348 likes, 12 comments - handle on March 3, 2025: "Caption text..."
 * @param {string} og
 * @returns {{ creator: string, caption: string }}
 */
function parseOgDescription(og) {
  const text = String(og || '').trim();
  if (!text) return { creator: '', caption: '' };

  const quoted = text.match(/(?:-\s+|^)@?([a-zA-Z0-9_.]+)\s+on\s+[^:]+:\s*["“]([\s\S]*)["”]\s*\.?$/);
  if (quoted) return { creator: quoted[1], caption: quoted[2].trim() };

  const trailing = text.match(/^([\s\S]*?)\s*-\s+@([a-zA-Z0-9_.]+)\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*$/);
  if (trailing) return { creator: trailing[2], caption: trailing[1].trim() };

  return { creator: '', caption: text };
}

/**
 * Fetches public Reel web page metadata using Playwright or HTTP fetch.
 * Uses authenticated Playwright browser session when available.
 * @param {string} reelUrl
 * @param {Object} [browserSession]
 * @returns {Promise<Object>}
 */
async function fetchReelPublicData(reelUrl, browserSession) {
  const shortcode = extractReelShortcode(reelUrl);
  if (!shortcode) {
    throw new Error(`Invalid Reel URL: ${reelUrl}`);
  }

  let caption = '';
  let creator = '';

  if (browserSession) {
    try {
      const page = await browserSession.getPage();
      logger.info('Inspecting public Reel page via browser session...', { reelUrl });
      // /reel/ links now redirect to the scrolling Reels feed (many Reels on one page).
      // /p/ is a single post, so everything read here belongs to this Reel.
      await page.goto(`https://www.instagram.com/p/${shortcode}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Dismiss any cookie or notification prompts
      try {
        const promptBtn = await page.$(
          'button:has-text("Decline optional cookies"), button:has-text("Allow all cookies"), button:has-text("Not Now"), button:has-text("Cancel")'
        );
        if (promptBtn && (await promptBtn.isVisible())) {
          await promptBtn.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      } catch {}

      // 1. Try script[type="application/ld+json"] which reliably contains caption & author
      try {
        const jsonLdContent = await page.$$eval('script[type="application/ld+json"]', scripts => {
          for (const s of scripts) {
            try {
              const data = JSON.parse(s.innerText || s.textContent);
              if (data) return data;
            } catch {}
          }
          return null;
        });

        if (jsonLdContent) {
          const item = Array.isArray(jsonLdContent) ? jsonLdContent[0] : jsonLdContent;
          if (item) {
            if (item.caption) caption = item.caption.trim();
            else if (item.articleBody) caption = item.articleBody.trim();
            else if (item.description) caption = item.description.trim();

            if (item.author) {
              const authorObj = Array.isArray(item.author) ? item.author[0] : item.author;
              if (authorObj.alternateName) {
                creator = authorObj.alternateName.replace(/^@/, '').trim();
              } else if (authorObj.name) {
                creator = authorObj.name.replace(/^@/, '').trim();
              }
            }
          }
        }
      } catch {}

      // 2. Try OpenGraph description
      if (!caption || !creator) {
        try {
          const ogDesc = await page.$eval(
            'meta[property="og:description"], meta[name="description"]',
            el => el.getAttribute('content')
          );
          const parsed = parseOgDescription(ogDesc);
          if (!creator) creator = parsed.creator;
          if (!caption) caption = parsed.caption;
        } catch {
          // Fall back to DOM elements
        }
      }

      // 3. Try OpenGraph title / page title for creator
      if (!creator) {
        try {
          const ogTitle = await page.$eval(
            'meta[property="og:title"], title',
            el => el.getAttribute('content') || el.innerText
          );
          if (ogTitle) {
            const match = ogTitle.match(/@([a-zA-Z0-9_.-]+)/) || ogTitle.match(/^([a-zA-Z0-9_.-]+)\s+on\s+Instagram/i);
            if (match) {
              creator = match[1].trim();
            }
          }
        } catch {}
      }

      // 4. Fallback: first profile link inside the post itself (never the site navigation)
      if (!creator) {
        const hrefs = await page.$$eval('main a[href^="/"]', links => links.map(a => a.getAttribute('href')));
        const reserved = ['reel', 'reels', 'p', 'explore', 'direct', 'accounts', 'popular', 'stories'];
        for (const href of hrefs) {
          const match = (href || '').match(/^\/([a-zA-Z0-9_.]+)\/(?:reels\/)?$/);
          if (match && !reserved.includes(match[1]) && !match[1].toLowerCase().startsWith('dolphin.')) {
            creator = match[1];
            break;
          }
        }
      }

      if (!caption) {
        const captionEl = await page.$('h1, span[dir="auto"], div[role="button"] + span');
        if (captionEl) {
          caption = (await captionEl.innerText()) || '';
        }
      }
    } catch (err) {
      logger.warn('Browser Reel metadata fetch failed, using fallback', { error: err.message });
    }
  }

  return parseReelMetadata({ shortcode, caption, creator });
}

module.exports = {
  parseOgDescription,
  parseReelMetadata,
  fetchReelPublicData,
};
