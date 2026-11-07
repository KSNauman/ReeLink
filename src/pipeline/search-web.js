/**
 * Stage B: Modular Web Search Adapter
 * Queries public search engines (DuckDuckGo HTML default, SerpAPI, Tavily, Google PSE)
 * to discover external candidate links.
 */
const https = require('https');
const http = require('http');
const config = require('../config');
const logger = require('../utils/logger');
const { extractExternalUrls, cleanTrackingParams } = require('../utils/url-helper');

class SearchAdapter {
  constructor(options = {}) {
    this.provider = options.provider || config.search.provider || 'ddg';
    this.maxResults = options.maxResults || config.search.maxResults || 5;
  }

  /**
   * Dispatches search query to the configured search provider.
   * @param {string} query
   * @returns {Promise<Array<{ title: string, url: string, snippet: string, domain: string }>>}
   */
  async search(query) {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return [];
    }

    logger.info('Executing web search', { provider: this.provider, query });

    switch (this.provider.toLowerCase()) {
      case 'ddg':
      default:
        return this._searchDuckDuckGo(query);
      case 'serpapi':
        return this._searchSerpApi(query);
      case 'tavily':
        return this._searchTavily(query);
    }
  }

  /**
   * Free, zero-cost DuckDuckGo HTML search adapter.
   * Handles HTTP 202 bot challenges, 429 rate limits, and distinguishes genuine zero results.
   * @param {string} query
   * @param {number} [retryCount=0]
   */
  async _searchDuckDuckGo(query, retryCount = 0) {
    const postData = new URLSearchParams({ q: query }).toString();
    const options = {
      hostname: 'html.duckduckgo.com',
      port: 443,
      path: '/html/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 10000,
    };

    try {
      const { html, statusCode } = await new Promise((resolve, reject) => {
        const req = https.request(options, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve({ html: data, statusCode: res.statusCode }));
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('DuckDuckGo request timed out'));
        });
        req.write(postData);
        req.end();
      });

      // 1. Detect Anomaly Challenge / Rate Limiting (HTTP 202 or anomaly modal)
      const isChallenge = statusCode === 202 || html.includes('anomaly-modal') || html.includes('js-anomaly-modal');
      const isRateLimited = statusCode === 429;

      if ((isChallenge || isRateLimited) && retryCount < 1) {
        const waitMs = 2000;
        logger.warn(`DuckDuckGo throttling detected (HTTP ${statusCode}). Retrying in ${waitMs}ms...`, { query, retryCount });
        await new Promise(r => setTimeout(r, waitMs));
        return this._searchDuckDuckGo(query, retryCount + 1);
      }

      if (isChallenge) {
        logger.warn('DuckDuckGo search blocked by bot challenge (HTTP 202 anomaly modal)', { query });
        const emptyResults = [];
        emptyResults.isThrottled = true;
        emptyResults.error = 'RATE_LIMITED_CHALLENGE';
        emptyResults.statusCode = 202;
        emptyResults.isGenuineZero = false;
        return emptyResults;
      }

      if (isRateLimited) {
        logger.warn('DuckDuckGo search rate limited (HTTP 429)', { query });
        const emptyResults = [];
        emptyResults.isThrottled = true;
        emptyResults.error = 'RATE_LIMITED';
        emptyResults.statusCode = 429;
        emptyResults.isGenuineZero = false;
        return emptyResults;
      }

      if (statusCode !== 200) {
        logger.warn(`DuckDuckGo returned unexpected status ${statusCode}`, { query });
        const emptyResults = [];
        emptyResults.isThrottled = false;
        emptyResults.error = `HTTP_${statusCode}`;
        emptyResults.statusCode = statusCode;
        emptyResults.isGenuineZero = false;
        return emptyResults;
      }

      const results = this._parseDuckDuckGoHtml(html);
      results.isThrottled = false;
      results.error = null;
      results.statusCode = 200;
      results.isGenuineZero = results.length === 0;

      return results;
    } catch (err) {
      logger.warn('DuckDuckGo search error', { error: err.message, query });
      const emptyResults = [];
      emptyResults.isThrottled = false;
      emptyResults.error = err.message;
      emptyResults.statusCode = null;
      emptyResults.isGenuineZero = false;
      return emptyResults;
    }
  }

  /**
   * Search with explicit diagnostic status metadata.
   * @param {string} query
   * @returns {Promise<{ candidates: Array, status: number|null, isThrottled: boolean, error: string|null, isGenuineZero: boolean }>}
   */
  async searchWithStatus(query) {
    const candidates = await this.search(query);
    return {
      candidates,
      status: candidates.statusCode || (candidates.length > 0 ? 200 : null),
      isThrottled: Boolean(candidates.isThrottled),
      error: candidates.error || null,
      isGenuineZero: Boolean(candidates.isGenuineZero),
    };
  }

  /**
   * Parses DuckDuckGo HTML response into structured candidate objects.
   * @param {string} html
   */
  _parseDuckDuckGoHtml(html) {
    const results = [];
    const seenUrls = new Set();

    // Match results blocks: <a class="result__a" href="..."> or <a class="result__url" href="...">
    const resultRegex = /<a\s+[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = resultRegex.exec(html)) !== null && results.length < this.maxResults) {
      let rawUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();

      // Decode if wrapped in DuckDuckGo redirect uddg parameter
      if (rawUrl.includes('uddg=')) {
        try {
          const parsed = new URL(rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl, 'https://duckduckgo.com');
          const uddg = parsed.searchParams.get('uddg');
          if (uddg) rawUrl = decodeURIComponent(uddg);
        } catch {
          // Keep rawUrl
        }
      }

      if (rawUrl.startsWith('//')) {
        rawUrl = 'https:' + rawUrl;
      }

      const cleanUrl = cleanTrackingParams(rawUrl);

      if (cleanUrl.startsWith('http') && !cleanUrl.includes('duckduckgo.com/') && !seenUrls.has(cleanUrl)) {
        seenUrls.add(cleanUrl);
        let domain = 'unknown';
        try {
          domain = new URL(cleanUrl).hostname;
        } catch {}

        results.push({
          title: title || `Resource on ${domain}`,
          url: cleanUrl,
          snippet: '',
          domain,
        });
      }
    }

    // Fallback: Check uddg regex if result__a was not present
    if (results.length === 0) {
      const uddgRegex = /href="(?:https?:)?\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)[^"]*"/gi;
      while ((match = uddgRegex.exec(html)) !== null && results.length < this.maxResults) {
        try {
          const decodedUrl = decodeURIComponent(match[1]);
          const cleanUrl = cleanTrackingParams(decodedUrl);
          if (!cleanUrl.includes('duckduckgo.com/') && !seenUrls.has(cleanUrl)) {
            seenUrls.add(cleanUrl);
            let domain = 'unknown';
            try { domain = new URL(cleanUrl).hostname; } catch {}
            results.push({
              title: `Resource on ${domain}`,
              url: cleanUrl,
              snippet: '',
              domain,
            });
          }
        } catch {}
      }
    }

    logger.info(`DuckDuckGo returned ${results.length} candidate URLs`);
    return results;
  }

  /**
   * SerpAPI adapter (optional if SERPAPI_API_KEY is provided).
   */
  async _searchSerpApi(query) {
    if (!config.search.serpApiKey) {
      logger.warn('SERPAPI_API_KEY not set. Falling back to DuckDuckGo.');
      return this._searchDuckDuckGo(query);
    }

    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${config.search.serpApiKey}&num=${this.maxResults}`;
    try {
      const jsonStr = await this._httpGet(url);
      const data = JSON.parse(jsonStr);
      const organic = data.organic_results || [];

      return organic.slice(0, this.maxResults).map(r => ({
        title: r.title || '',
        url: cleanTrackingParams(r.link || ''),
        snippet: r.snippet || '',
        domain: new URL(r.link).hostname,
      }));
    } catch (err) {
      logger.error('SerpAPI search failed', { error: err.message });
      return [];
    }
  }

  /**
   * Tavily adapter (optional if TAVILY_API_KEY is provided).
   */
  async _searchTavily(query) {
    if (!config.search.tavilyApiKey) {
      logger.warn('TAVILY_API_KEY not set. Falling back to DuckDuckGo.');
      return this._searchDuckDuckGo(query);
    }
    // Implementation placeholder for Tavily JSON API
    return this._searchDuckDuckGo(query);
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      https
        .get(url, { timeout: 10000 }, res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
  }
}

module.exports = SearchAdapter;
