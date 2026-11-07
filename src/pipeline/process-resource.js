/**
 * Stage 5: Resource Processing Engine
 * Validates URLs against SSRF, resolves redirects, classifies destination types
 * (GitHub repo, PDF document, documentation site), and prepares delivery payloads.
 */
const { validateUrlSafety, resolveRedirects } = require('../security/validate-url');
const { cleanTrackingParams } = require('../utils/url-helper');
const logger = require('../utils/logger');

/**
 * Validates and processes a discovered candidate resource URL.
 * @param {string} candidateUrl
 * @param {Object} [options]
 * @returns {Promise<{ success: boolean, finalUrl: string, resourceType: string, summary: string, error?: string }>}
 */
async function processResource(candidateUrl, options = {}) {
  logger.info('Processing target resource URL...', { candidateUrl });

  // 1. SSRF Safety check on candidate URL
  const safety = await validateUrlSafety(candidateUrl);
  if (!safety.safe) {
    logger.security('Target candidate URL blocked by SSRF filter', {
      candidateUrl,
      reason: safety.reason,
    });
    return {
      success: false,
      finalUrl: candidateUrl,
      resourceType: 'blocked',
      summary: '',
      error: `Security policy blocked URL: ${safety.reason}`,
    };
  }

  // 2. Safe Redirect Resolution
  let finalUrl = candidateUrl;
  try {
    const redirectResult = await resolveRedirects(candidateUrl);
    finalUrl = cleanTrackingParams(redirectResult.finalUrl);
  } catch (err) {
    logger.warn('Redirect resolution failed, retaining original candidate URL', {
      candidateUrl,
      error: err.message,
    });
  }

  // 3. Classify resource type
  const parsed = new URL(finalUrl);
  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  let resourceType = 'webpage';
  let summary = '';

  if (hostname === 'github.com') {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      resourceType = 'github_repository';
      const repoSlug = `${segments[0]}/${segments[1]}`;
      finalUrl = `https://github.com/${repoSlug}`;
      summary = `Official GitHub Repository: ${repoSlug}`;
    }
  } else if (pathname.endsWith('.pdf')) {
    resourceType = 'pdf_document';
    summary = `Direct PDF Document (${pathname.split('/').pop()})`;
  } else if (hostname.includes('huggingface.co')) {
    resourceType = 'huggingface_model';
    summary = 'Hugging Face Model / Space Repository';
  } else if (hostname.includes('arxiv.org')) {
    resourceType = 'research_paper';
    summary = 'arXiv Scientific Research Paper';
  } else if (hostname.includes('notion.site') || hostname.includes('notion.so')) {
    resourceType = 'notion_workspace';
    summary = 'Notion Public Resource Page';
  } else {
    summary = `Web Resource on ${hostname}`;
  }

  logger.info('Resource successfully processed', {
    candidateUrl,
    finalUrl,
    resourceType,
    summary,
  });

  return {
    success: true,
    finalUrl,
    resourceType,
    summary,
  };
}

module.exports = {
  processResource,
};
