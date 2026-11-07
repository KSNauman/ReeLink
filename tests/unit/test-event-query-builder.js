const test = require('node:test');
const assert = require('node:assert');
const { extractEventClues, buildSearchQueries } = require('../../src/pipeline/build-search-query');

test('extractEventClues: extracts compound event name, organizer, location, and registration intent', () => {
  const caption = `🚨 BANGALORE TECHIES, YOU COULD VISIT THE GOOGLE OFFICE! 🤯💙
Want to explore AI agents and learn how to build smarter AI-powered applications?
Google’s AlloyDB Agents event is worth checking out! 🚀
💻 Explore AI agents & AlloyDB
🧠 Learn about building intelligent AI applications
🏢 Get a chance to visit the Google office in Bangalore
📌 Interested? Comment GOOGLE and I’ll send you the direct event link in your DMs!
#Google #GoogleCloud #AI #AIAgents #BangaloreTech`;

  const clues = extractEventClues(caption);
  assert.ok(clues, 'Expected event clues to be extracted');
  assert.strictEqual(clues.eventName, 'AlloyDB Agents');
  assert.strictEqual(clues.eventType, 'event');
  assert.strictEqual(clues.organizer, 'google');
  assert.strictEqual(clues.location, 'Bangalore');
  assert.strictEqual(clues.hasRegistrationIntent, true);
});

test('extractEventClues: handles hackathons, workshops, and alternative tech organizers', () => {
  const caption = 'Join the Microsoft AI Hackathon in Hyderabad! Register now for free tickets.';
  const clues = extractEventClues(caption);
  assert.ok(clues);
  assert.strictEqual(clues.eventName, 'AI');
  assert.strictEqual(clues.eventType, 'hackathon');
  assert.strictEqual(clues.organizer, 'microsoft');
  assert.strictEqual(clues.location, 'Hyderabad');
  assert.strictEqual(clues.hasRegistrationIntent, true);
});

test('extractEventClues: returns null for standard code tutorial captions without events', () => {
  const caption = 'Here is how to set up Docker with PostgreSQL in 3 simple steps. Save this reel for later!';
  const clues = extractEventClues(caption);
  assert.strictEqual(clues, null);
});

test('buildSearchQueries: generates evidence-based queries for public events', () => {
  const evidence = {
    metadata: {
      creator: 'meghna_1500',
      ctaKeyword: 'GOOGLE',
      caption: `Google’s AlloyDB Agents event is worth checking out! Visit the Google office in Bangalore. Comment GOOGLE for event link.`,
      hashtags: ['google', 'aiagents', 'bangaloretech'],
    },
  };

  const queries = buildSearchQueries(evidence);
  assert.ok(queries.length >= 3);

  // Check for RSVP + location query
  const rsvpLocationQuery = queries.find(q => q.type === 'event_rsvp_location');
  assert.ok(rsvpLocationQuery, 'Should generate event_rsvp_location query');
  assert.strictEqual(rsvpLocationQuery.query, '"AlloyDB Agents" RSVP Bangalore');

  // Check for official domain query
  const officialDomainQuery = queries.find(q => q.type === 'event_official_domain');
  assert.ok(officialDomainQuery, 'Should generate event_official_domain query');
  assert.ok(officialDomainQuery.query.includes('site:withgoogle.com'));
  assert.ok(officialDomainQuery.query.includes('"AlloyDB Agents"'));

  // Check for compound event query
  const compoundQuery = queries.find(q => q.type === 'event_compound');
  assert.ok(compoundQuery, 'Should generate event_compound query');
  assert.strictEqual(compoundQuery.query, '"AlloyDB Agents" google event registration');
});
