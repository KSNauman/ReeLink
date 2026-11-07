/**
 * Stage A4: Search-Query Construction
 * Synthesizes extracted caption, OCR tokens, and transcript terms into compact,
 * high-precision search queries suitable for web and repository discovery.
 */
const logger = require('../utils/logger');

// Generic promotional stop words and hashtags to strip from queries
const NOISE_WORDS = new Set([
  'reels',
  'reel',
  'viral',
  'trending',
  'fyp',
  'explore',
  'foryou',
  'instagram',
  'link',
  'bio',
  'comment',
  'share',
  'follow',
  'save',
  'drop',
  'below',
  'check',
  'out',
]);

/**
 * Filters out spam/promotional noise words.
 * @param {string[]} tokens
 * @returns {string[]} clean tokens
 */
function filterNoise(tokens) {
  return tokens
    .map(t => t.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    .filter(t => t.length > 2 && !NOISE_WORDS.has(t));
}

// Major tech organizers and their official event/registration domains
const TECH_ORGANIZER_DOMAINS = {
  google: 'withgoogle.com',
  microsoft: 'microsoft.com',
  aws: 'aws.amazon.com',
  amazon: 'aws.amazon.com',
  meta: 'metademoday.com',
  openai: 'openai.com',
  anthropic: 'anthropic.com',
  docker: 'docker.com',
  databricks: 'databricks.com',
};

const TECH_CITIES = [
  'bangalore',
  'bengaluru',
  'hyderabad',
  'mumbai',
  'delhi',
  'pune',
  'san francisco',
  'seattle',
  'austin',
  'new york',
  'london',
  'berlin',
  'remote',
  'online',
];

/**
 * Extracts event clues from caption text (event name, organizer, location).
 * @param {string} caption
 * @returns {Object|null}
 */
function extractEventClues(caption = '') {
  if (!caption || typeof caption !== 'string') return null;

  // 1. Detect event phrase: e.g. "Google's AlloyDB Agents event", "AI Hackathon", "PostgreSQL Workshop"
  const eventRegex = /(?:([A-Za-z0-9_.-]+(?:['’]s)?)\s+)?([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+){0,3})\s+(event|hackathon|workshop|meetup|summit|conference|challenge|webinar|bootcamp)/i;
  const match = caption.match(eventRegex);

  let organizer = '';
  let eventName = '';
  let eventType = '';

  const ACTION_WORDS = new Set(['join', 'attend', 'check', 'visit', 'explore', 'register', 'welcome', 'the', 'a', 'an', 'this', 'our']);

  if (match) {
    const rawOrg = (match[1] || '').replace(/['’]s$/i, '').trim();
    if (rawOrg && !ACTION_WORDS.has(rawOrg.toLowerCase())) {
      organizer = rawOrg;
    }
    let rawName = match[2].trim().replace(/^(?:the|a|an|this|our|join)\s+/i, '');
    eventType = match[3].toLowerCase();

    // If rawName starts with known tech organizer (e.g. "Microsoft AI"), separate them
    for (const org of Object.keys(TECH_ORGANIZER_DOMAINS)) {
      const orgRegex = new RegExp(`^${org}\\s+`, 'i');
      if (orgRegex.test(rawName)) {
        if (!organizer) organizer = org;
        rawName = rawName.replace(orgRegex, '').trim();
        break;
      }
    }
    eventName = rawName;
  }

  // Fallback: look for organizer anywhere in text if not in event phrase
  const lowerCaption = caption.toLowerCase();
  if (!organizer) {
    for (const org of Object.keys(TECH_ORGANIZER_DOMAINS)) {
      if (lowerCaption.includes(org)) {
        organizer = org;
        break;
      }
    }
  }

  // 2. Detect location
  let location = '';
  for (const city of TECH_CITIES) {
    if (lowerCaption.includes(city)) {
      location = city.charAt(0).toUpperCase() + city.slice(1);
      break;
    }
  }

  // 3. Detect registration intent
  const hasRegistrationIntent = /(?:rsvp|registration|register|apply|tickets?|event\s+link|in\s+your\s+dms)/i.test(caption);
  const hasEventKeyword = /(?:event|hackathon|workshop|meetup|summit|conference|challenge|webinar|bootcamp)/i.test(caption);

  // Return event clues only if an actual event phrase was matched or registration intent with event keyword
  if (eventName || (hasRegistrationIntent && hasEventKeyword)) {
    return {
      eventName,
      eventType: eventType || (hasEventKeyword ? 'event' : ''),
      organizer: organizer ? organizer.toLowerCase() : '',
      location,
      hasRegistrationIntent,
    };
  }

  return null;
}

/**
 * Builds a prioritized list of search queries based on Stage A evidence.
 * @param {Object} evidence
 * @param {Object} [evidence.metadata] - Output of parseReelMetadata
 * @param {Object} [evidence.ocr] - Output of OCREngine.processFrames
 * @param {Object} [evidence.transcription] - Output of transcribeAudio
 * @returns {Array<{ query: string, type: string, priority: number, reason: string }>}
 */
function buildSearchQueries({ metadata = {}, ocr = {}, transcription = {} }) {
  const queries = [];
  const creator = metadata.creator || '';
  const ctaKeyword = metadata.ctaKeyword || '';
  const detectedRepos = ocr.detectedRepos || [];
  const detectedPackages = ocr.detectedPackages || [];
  const hashtags = metadata.hashtags || [];
  const caption = metadata.caption || '';
  const eventClues = extractEventClues(caption);

  // Priority 1: Exact GitHub Repositories detected in OCR
  for (const repo of detectedRepos) {
    queries.push({
      query: `site:github.com ${repo}`,
      type: 'exact_repo',
      priority: 1,
      reason: `Exact repository slug "${repo}" detected in on-screen OCR`,
    });
  }

  // Priority 2: Structured Event & Registration Queries
  if (eventClues && eventClues.eventName) {
    const { eventName, organizer, location } = eventClues;
    const cleanEventName = eventName.replace(/^[^\w]+|[^\w]+$/g, '');

    // Query 2a: Event Name + Registration + Location (e.g. "AlloyDB Agents" RSVP Bangalore)
    if (location) {
      queries.push({
        query: `"${cleanEventName}" RSVP ${location}`,
        type: 'event_rsvp_location',
        priority: 2,
        reason: `Targeted event registration query for "${cleanEventName}" in ${location}`,
      });
    }

    // Query 2b: Organizer Official Domain Target (e.g. "AlloyDB Agents" site:withgoogle.com)
    const orgDomain = TECH_ORGANIZER_DOMAINS[organizer];
    if (orgDomain) {
      queries.push({
        query: `"${cleanEventName}" (site:${orgDomain} OR rsvp OR registration)`,
        type: 'event_official_domain',
        priority: 2,
        reason: `Official ${organizer} event platform query for "${cleanEventName}"`,
      });
    }

    // Query 2c: Compound Event Name + Organizer
    queries.push({
      query: `"${cleanEventName}" ${organizer ? organizer : ''} event registration`.trim(),
      type: 'event_compound',
      priority: 3,
      reason: `Compound event registration query for "${cleanEventName}"`,
    });
  }

  // Priority 2: CLI packages detected (e.g. pip install autogen)
  for (const pkg of detectedPackages) {
    queries.push({
      query: `"${pkg}" (site:github.com OR documentation OR guide)`,
      type: 'package_doc',
      priority: 2,
      reason: `Package name "${pkg}" detected in command overlay`,
    });
  }

  // Priority 3: Creator + CTA Keyword (e.g., "alice_dev DOCKER guide OR cheatsheet")
  if (ctaKeyword) {
    const creatorPrefix = creator ? `${creator} ` : '';
    queries.push({
      query: `${creatorPrefix}"${ctaKeyword.toLowerCase()}" (github OR pdf OR guide OR cheatsheet)`,
      type: 'cta_keyword',
      priority: 3,
      reason: `Creator requested comment keyword "${ctaKeyword}"`,
    });
  }

  // Priority 4: Distinctive technical hashtags & topics
  const techHashtags = filterNoise(hashtags);
  if (techHashtags.length > 0) {
    const tagsSlice = techHashtags.slice(0, 3).join(' ');
    // Direct topic query
    queries.push({
      query: `${tagsSlice} ${ctaKeyword ? ctaKeyword.toLowerCase() : ''} (event OR registration OR github OR tutorial OR resource)`.trim(),
      type: 'tech_topic',
      priority: 4,
      reason: `Direct technical topic: ${tagsSlice}`,
    });

    if (creator) {
      queries.push({
        query: `${creator} ${tagsSlice} (github OR tutorial OR resource)`.trim(),
        type: 'hashtags_creator',
        priority: 5,
        reason: `Creator with technical hashtags: ${tagsSlice}`,
      });
    }
  }

  // Priority 5: Fallback from spoken transcription if available
  if (transcription.text && queries.length < 2) {
    const words = filterNoise(transcription.text.split(/\s+/));
    if (words.length > 0) {
      const topWords = words.slice(0, 5).join(' ');
      queries.push({
        query: `${creator} ${topWords}`.trim(),
        type: 'transcript_summary',
        priority: 5,
        reason: 'Spoken transcript keywords',
      });
    }
  }

  logger.info(`Constructed ${queries.length} search queries from Reel evidence`, {
    topQuery: queries[0]?.query || '(none)',
  });

  return queries;
}

module.exports = {
  buildSearchQueries,
  filterNoise,
  extractEventClues,
};
