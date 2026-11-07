const test = require('node:test');
const assert = require('node:assert');
const SearchAdapter = require('../../src/pipeline/search-web');

test('SearchAdapter._parseDuckDuckGoHtml: parses valid result blocks and decodes uddg redirects', () => {
  const adapter = new SearchAdapter();
  const mockHtml = `
    <div class="results">
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frsvp.withgoogle.com%2Fevents%2Falloydb-agents&rut=abc">
          AlloyDB AI Day India 2026 - Bangalore
        </a>
      </div>
      <div class="result">
        <a class="result__a" href="https://cloud.google.com/alloydb">
          Google Cloud AlloyDB Documentation
        </a>
      </div>
    </div>
  `;

  const results = adapter._parseDuckDuckGoHtml(mockHtml);
  assert.strictEqual(results.length, 2);

  assert.strictEqual(results[0].url, 'https://rsvp.withgoogle.com/events/alloydb-agents');
  assert.strictEqual(results[0].title, 'AlloyDB AI Day India 2026 - Bangalore');
  assert.strictEqual(results[0].domain, 'rsvp.withgoogle.com');

  assert.strictEqual(results[1].url, 'https://cloud.google.com/alloydb');
  assert.strictEqual(results[1].title, 'Google Cloud AlloyDB Documentation');
  assert.strictEqual(results[1].domain, 'cloud.google.com');
});

test('SearchAdapter._parseDuckDuckGoHtml: returns empty array for genuine zero-result pages', () => {
  const adapter = new SearchAdapter();
  const emptyHtml = `<div class="no-results">No results found for your query.</div>`;
  const results = adapter._parseDuckDuckGoHtml(emptyHtml);
  assert.deepStrictEqual(results, []);
});

test('SearchAdapter: flags HTTP 202 bot anomaly challenges with RATE_LIMITED_CHALLENGE', async () => {
  const adapter = new SearchAdapter();

  // Stub _searchDuckDuckGo simulating HTTP 202 response
  adapter._searchDuckDuckGo = async () => {
    const emptyResults = [];
    emptyResults.isThrottled = true;
    emptyResults.error = 'RATE_LIMITED_CHALLENGE';
    emptyResults.statusCode = 202;
    emptyResults.isGenuineZero = false;
    return emptyResults;
  };

  const status = await adapter.searchWithStatus('"AlloyDB Agents" RSVP');
  assert.strictEqual(status.isThrottled, true);
  assert.strictEqual(status.error, 'RATE_LIMITED_CHALLENGE');
  assert.strictEqual(status.status, 202);
  assert.strictEqual(status.isGenuineZero, false);
  assert.strictEqual(status.candidates.length, 0);
});

test('SearchAdapter: flags HTTP 429 rate limits with RATE_LIMITED', async () => {
  const adapter = new SearchAdapter();

  // Stub _searchDuckDuckGo simulating HTTP 429 response
  adapter._searchDuckDuckGo = async () => {
    const emptyResults = [];
    emptyResults.isThrottled = true;
    emptyResults.error = 'RATE_LIMITED';
    emptyResults.statusCode = 429;
    emptyResults.isGenuineZero = false;
    return emptyResults;
  };

  const status = await adapter.searchWithStatus('query');
  assert.strictEqual(status.isThrottled, true);
  assert.strictEqual(status.error, 'RATE_LIMITED');
  assert.strictEqual(status.status, 429);
  assert.strictEqual(status.isGenuineZero, false);
});

test('SearchAdapter: distinguishes genuine zero results from throttling', async () => {
  const adapter = new SearchAdapter();

  // Stub _searchDuckDuckGo simulating HTTP 200 with zero results
  adapter._searchDuckDuckGo = async () => {
    const results = [];
    results.isThrottled = false;
    results.error = null;
    results.statusCode = 200;
    results.isGenuineZero = true;
    return results;
  };

  const status = await adapter.searchWithStatus('nonexistent-gibberish-query-12345');
  assert.strictEqual(status.isThrottled, false);
  assert.strictEqual(status.error, null);
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.isGenuineZero, true);
  assert.strictEqual(status.candidates.length, 0);
});
