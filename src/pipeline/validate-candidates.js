/**
 * Stage B: Candidate Ranking & Evidence Scorer
 * Evaluates candidate URLs against Reel evidence, computes confidence scores (0.0 - 1.0),
 * and implements early stopping when high-confidence matches are found.
 */
const config = require('../config');
const logger = require('../utils/logger');
const { extractEventClues } = require('./build-search-query');

const HIGH_VALUE_DOMAINS = [
  'github.com',
  'huggingface.co',
  'arxiv.org',
  'drive.google.com',
  'notion.site',
  'notion.so',
  'docs.google.com',
  'kaggle.com',
  'colab.research.google.com',
  'rsvp.withgoogle.com',
  'withgoogle.com',
  'cloudonair.withgoogle.com',
  'events.google.com',
  'devpost.com',
  'hackerearth.com',
  'unstop.com',
  'lu.ma',
  'eventbrite.com',
  'meetup.com',
  'microsoft.com',
  'cloud.google.com',
];

const PENALIZED_DOMAINS = [
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'threads.net',
  'pinterest.com',
];

/**
 * Scores a candidate URL against extracted evidence.
 * Evaluates code repositories, technical packages, and event registration intent.
 * @param {Object} candidate - { url, title, domain, snippet }
 * @param {Object} evidence - { metadata, ocr, transcription }
 * @returns {{ candidate: Object, score: number, reasoning: string }}
 */
function scoreCandidate(candidate, evidence = {}) {
  const url = candidate.url || '';
  const domain = (candidate.domain || '').toLowerCase();
  const title = (candidate.title || '').toLowerCase();
  const urlLower = url.toLowerCase();

  const creator = (evidence.metadata?.creator || '').toLowerCase();
  const ctaKeyword = (evidence.metadata?.ctaKeyword || '').toLowerCase();
  const detectedRepos = (evidence.ocr?.detectedRepos || []).map(r => r.toLowerCase());
  const detectedPackages = (evidence.ocr?.detectedPackages || []).map(p => p.toLowerCase());

  // Event evidence
  const caption = (evidence.metadata?.caption || '').toLowerCase();
  const eventClues = evidence.metadata?.eventClues || (evidence.metadata?.caption ? extractEventClues(evidence.metadata.caption) : null);
  const eventName = (eventClues?.eventName || evidence.metadata?.eventName || '').toLowerCase();
  const organizer = (eventClues?.organizer || '').toLowerCase();
  const location = (eventClues?.location || '').toLowerCase();
  const hasEventIntent = Boolean(eventName || caption.includes('event') || caption.includes('hackathon') || caption.includes('workshop'));

  let score = 0.0;
  const reasons = [];

  // 1. Domain Affinity (+0.30)
  if (HIGH_VALUE_DOMAINS.some(d => domain.includes(d)) || urlLower.endsWith('.pdf')) {
    score += 0.30;
    reasons.push('High-value resource domain or direct PDF (+0.30)');
  }

  // Penalty for generic social media links
  if (PENALIZED_DOMAINS.some(d => domain.includes(d))) {
    score -= 0.40;
    reasons.push('Penalized generic social media domain (-0.40)');
  }

  // 2. Event Relevance & Official Registration Evidence
  if (hasEventIntent) {
    // Official registration endpoint structure: /events/, /rsvp/, /register/, /e/
    if (urlLower.includes('/events/') || urlLower.includes('/rsvp') || urlLower.includes('/register') || urlLower.includes('/e/')) {
      score += 0.25;
      reasons.push('Official event registration endpoint (+0.25)');
    }

    // Event name & slug match in URL or title
    if (eventName) {
      const slug = eventName.replace(/\s+/g, '-').toLowerCase();
      const words = eventName.split(/\s+/).filter(w => w.length > 2);
      if (urlLower.includes(slug) || (words.length > 0 && words.every(w => urlLower.includes(w) || title.includes(w)))) {
        score += 0.35;
        reasons.push(`Strong match for event name "${eventName}" (+0.35)`);
      } else if (words.some(w => urlLower.includes(w) || title.includes(w))) {
        score += 0.15;
        reasons.push(`Partial match for event name "${eventName}" (+0.15)`);
      }
    }

    // Organizer match
    if (organizer && (domain.includes(organizer) || title.includes(organizer))) {
      score += 0.15;
      reasons.push(`Matches event organizer "${organizer}" (+0.15)`);
    }

    // Location match
    if (location && (urlLower.includes(location) || title.includes(location))) {
      score += 0.10;
      reasons.push(`Matches event location "${location}" (+0.10)`);
    }
  }

  // 2. Exact Repo Match (+0.40)
  for (const repo of detectedRepos) {
    if (urlLower.includes(repo)) {
      score += 0.40;
      reasons.push(`Exact match for on-screen repo "${repo}" (+0.40)`);
      break;
    }
  }

  // 3. Keyword / Package Match (+0.25)
  for (const pkg of detectedPackages) {
    if (urlLower.includes(pkg) || title.includes(pkg)) {
      score += 0.25;
      reasons.push(`Matches on-screen CLI package "${pkg}" (+0.25)`);
      break;
    }
  }

  if (ctaKeyword && (urlLower.includes(ctaKeyword) || title.includes(ctaKeyword))) {
    score += 0.20;
    reasons.push(`Matches creator CTA keyword "${ctaKeyword}" (+0.20)`);
  }

  // 4. Creator Identity Match (+0.20)
  if (creator && creator.length > 2) {
    if (urlLower.includes(`/${creator}/`) || urlLower.includes(`github.com/${creator}`)) {
      score += 0.25;
      reasons.push(`URL path contains creator handle "${creator}" (+0.25)`);
    } else if (title.includes(creator)) {
      score += 0.15;
      reasons.push(`Title mentions creator "${creator}" (+0.15)`);
    }
  }

  // Clamp score between 0.0 and 1.0
  const finalScore = Math.max(0.0, Math.min(1.0, score));

  return {
    ...candidate,
    score: parseFloat(finalScore.toFixed(2)),
    reasoning: reasons.join('; '),
  };
}

/**
 * Ranks and validates a list of candidates against evidence.
 * @param {Array<Object>} candidates
 * @param {Object} evidence
 * @param {number} [threshold=0.65]
 * @returns {{ selected: Object|null, ranked: Array<Object>, highConfidence: boolean }}
 */
function rankCandidates(candidates = [], evidence = {}, threshold = config.search.confidenceThreshold) {
  if (!candidates || candidates.length === 0) {
    return { selected: null, ranked: [], highConfidence: false };
  }

  const scored = candidates.map(c => scoreCandidate(c, evidence));

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const isHighConfidence = top && top.score >= 0.75;
  const isAboveThreshold = top && top.score >= threshold;

  const selected = isAboveThreshold ? top : null;

  logger.info('Candidate ranking completed', {
    totalEvaluated: scored.length,
    topScore: top?.score || 0,
    topUrl: top?.url || '(none)',
    isHighConfidence,
    selected: Boolean(selected),
  });

  return {
    selected,
    ranked: scored,
    highConfidence: isHighConfidence,
  };
}

module.exports = {
  scoreCandidate,
  rankCandidates,
};
