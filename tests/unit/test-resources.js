const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../../src/storage/database');
const { JobQueue } = require('../../src/queue/jobs');
const { ResourceCollector, parseThreadEdges, deriveTopic, buildCsv, writeCsv, buildSummaryMessages } = require('../../src/pipeline/resources');

const msg = (creator, at, content, text_body = '') => ({
  node: { timestamp_ms: String(at), text_body, content, sender: { user_dict: { username: creator } } },
});
const textMsg = (creator, at, body) => msg(creator, at, { __typename: 'SlideMessageText' }, body);
const button = (creator, at, title, url) => msg(creator, at, {
  __typename: 'SlideMessageXMAContent',
  xma_text_body: '',
  xma: { title_text: 'Here is the link', cta_buttons: [url ? { title, action_url: url, cta_type: 'xma_web_url' } : { title, action_url: null, cta_type: 'postback' }] },
});

describe('parseThreadEdges', () => {
  test('reads links in text, removing tracking and duplicates', () => {
    const [m] = parseThreadEdges([textMsg('Ana', 5, 'try https://a.com/x?utm_source=ig and https://a.com/x?utm_id=2')], 'ana');
    assert.deepStrictEqual(m.links, [{ url: 'https://a.com/x', label: null }]);
  });

  test('reads button links and unwraps redirectors', () => {
    const [m] = parseThreadEdges([button('ana', 5, 'Click me', 'https://t.example/tm?url=https%3A%2F%2Fjobs.example%2F1%3Futm_source%3Dx')], 'ana');
    assert.deepStrictEqual(m.links, [{ url: 'https://jobs.example/1', label: 'Click me' }]);
  });

  test('flags buttons that must be tapped', () => {
    const [m] = parseThreadEdges([button('ana', 5, 'Send me the access')], 'ana');
    assert.deepStrictEqual(m.links, []);
    assert.deepStrictEqual(m.tapButtons, ['Send me the access']);
  });

  test('ignores the bot, system notices, Instagram links and watermarks', () => {
    const out = parseThreadEdges([
      textMsg('dolphin.1', 1, 'https://mine.example/'),
      msg('ana', 2, { __typename: 'SlideMessageAdminText' }, 'https://notice.example/'),
      textMsg('ana', 3, 'https://www.instagram.com/p/abc/ https://quickdm.app/'),
    ], 'ana');
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].links, []);
  });
});

test('deriveTopic keeps the first useful sentence and drops tags', () => {
  assert.strictEqual(deriveTopic('#ad Free AI course! Comment GO'), 'Free AI course!');
  assert.strictEqual(deriveTopic('#only #tags'), '');
  assert.ok(deriveTopic('x'.repeat(200)).length <= 80);
});

describe('CSV', () => {
  const row = { commented_at: '2026-11-08T10:00:00Z', creator_username: 'ana', topic: '=HYPERLINK("http://evil")', url: 'https://a.com', label: 'say "hi"', reply_status: 'RECEIVED', shortcode: 'abc', keyword: '-1', reply_note: '', creator_thread_id: '12' };

  test('neutralises formulas, escapes quotes and starts with a BOM', () => {
    const csv = buildCsv([row]);
    assert.strictEqual(csv.charCodeAt(0), 0xFEFF);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
    assert.ok(csv.includes(`"'-1"`));
    assert.ok(csv.includes('"Link received"'));
  });

  test('falls back to a second file when the CSV is locked', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
    const target = path.join(dir, 'R.csv');
    const real = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (p, ...rest) => {
      if (p === target) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return real(p, ...rest);
    });
    const res = writeCsv([row], target);
    assert.strictEqual(res.usedFallback, true);
    assert.ok(res.path.endsWith('R_latest.csv'));
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('summary messages split long lists and track what each one carries', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, job_id: `j${i}`, url: `https://example.com/${'p'.repeat(40)}/${i}`, creator_username: `c${i}`, topic: 'topic' }));
  const out = buildSummaryMessages(rows, [{ job_id: 'n1', creator_username: 'bob', reply_note: 'Tap "Go"' }], 2);
  assert.ok(out.length > 1);
  assert.ok(out.every(m => m.text.length <= 1000));
  assert.deepStrictEqual(out.flatMap(m => m.resourceIds), rows.map(r => r.id));
  assert.deepStrictEqual(out.flatMap(m => m.needsYouJobIds), ['n1']);
  assert.ok(out[out.length - 1].text.includes('2 still waiting'));
  assert.deepStrictEqual(buildSummaryMessages([], [], 3), []);
});

describe('ResourceCollector', () => {
  let db; let queue; let dir; let sent; let edgesByThread; let sendOk; let collector;
  const T0 = Date.now() - 60 * 60 * 1000;

  function addReel(code, creator, postedAt) {
    const { job } = queue.createJob({ threadId: '999', senderUsername: 'ksydn_', reelUrl: `https://instagram.com/reel/${code}/`, shortcode: code, messageId: `m_${code}` });
    queue.createOrGetCreatorInteraction(job.id, { creatorUsername: creator, shortcode: code, keyword: 'GO', topic: 'A topic' });
    queue.updateCreatorInteraction(job.id, { live_comment_posted_at: new Date(postedAt).toISOString() });
    return job;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
    db = new Database(path.join(dir, 't.db'));
    queue = new JobQueue(db);
    sent = []; edgesByThread = {}; sendOk = true;
    collector = new ResourceCollector({
      queue,
      pauseMs: 0,
      csvPath: path.join(dir, 'out.csv'),
      inbox: {
        findCreatorThreadId: async (c) => (`t_${c}` in edgesByThread ? `t_${c}` : null),
        readThreadEdges: async (id) => edgesByThread[id] || null,
      },
      sender: { sendMessage: async (id, text) => { if (sendOk) sent.push({ id, text }); return sendOk; } },
    });
  });

  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const statusOf = (job) => queue.getCreatorInteraction(job.id).reply_status;

  test('saves links, writes the CSV and sends one DM only once', async () => {
    const job = addReel('A1', 'ana', T0);
    edgesByThread.t_ana = [textMsg('ana', T0 + 5000, 'here https://a.com/1')];

    const totals = await collector.collect();
    assert.strictEqual(totals.received, 1);
    assert.strictEqual(statusOf(job), 'RECEIVED');

    const first = await collector.deliver();
    assert.strictEqual(first.dmCount, 1);
    assert.strictEqual(sent[0].id, '999');
    assert.ok(sent[0].text.includes('@ana: A topic') && sent[0].text.includes('https://a.com/1'));
    assert.ok(fs.readFileSync(path.join(dir, 'out.csv'), 'utf8').includes('https://a.com/1'));

    await collector.collect();
    const again = await collector.deliver();
    assert.strictEqual(again.dmCount, 0);
    assert.strictEqual(sent.length, 1);
  });

  test('a failed DM is retried on the next run', async () => {
    addReel('A1', 'ana', T0);
    edgesByThread.t_ana = [textMsg('ana', T0 + 5000, 'https://a.com/1')];
    await collector.collect();
    sendOk = false;
    assert.strictEqual((await collector.deliver()).dmFailed, true);
    sendOk = true;
    assert.strictEqual((await collector.deliver()).dmCount, 1);
    assert.strictEqual(sent.length, 1);
  });

  test('old messages in the chat do not count as the reply', async () => {
    const job = addReel('A1', 'ana', T0);
    edgesByThread.t_ana = [textMsg('ana', T0 - 86400000, 'https://old.example/')];
    await collector.collect();
    assert.strictEqual(statusOf(job), 'WAITING');
    assert.deepStrictEqual(queue.getUndeliveredResources(), []);
  });

  test('two Reels from one creator each get their own reply', async () => {
    const half = 30 * 60 * 1000;
    const a = addReel('A1', 'ana', T0);
    const b = addReel('B1', 'ana', T0 + half);
    edgesByThread.t_ana = [textMsg('ana', T0 + 5000, 'https://first.example/'), textMsg('ana', T0 + half + 5000, 'https://second.example/')];
    await collector.collect();
    const urls = (j) => queue.getUndeliveredResources().filter(r => r.job_id === j.id).map(r => r.url);
    assert.deepStrictEqual(urls(a), ['https://first.example/']);
    assert.deepStrictEqual(urls(b), ['https://second.example/']);
  });

  test('tap-to-continue buttons become Needs you, then resolve when a link arrives', async () => {
    const job = addReel('A1', 'ana', T0);
    edgesByThread.t_ana = [button('ana', T0 + 5000, 'Send me the access')];
    await collector.collect();
    assert.strictEqual(statusOf(job), 'NEEDS_YOU');
    await collector.deliver();
    assert.ok(sent[0].text.includes('Send me the access'));

    edgesByThread.t_ana.push(textMsg('ana', T0 + 9000, 'https://later.example/'));
    await collector.collect();
    assert.strictEqual(statusOf(job), 'RECEIVED');
  });

  test('after 3 days silence becomes No reply', async () => {
    const old = addReel('A1', 'ana', Date.now() - 4 * 86400000);
    const chatless = addReel('B1', 'bob', Date.now() - 4 * 86400000);
    edgesByThread.t_ana = [];
    await collector.collect();
    assert.strictEqual(statusOf(old), 'NO_REPLY');
    assert.strictEqual(statusOf(chatless), 'NO_REPLY');
    assert.strictEqual(collector.hasOutstanding(), false);
  });

  test('an unreadable chat is not treated as no reply', async () => {
    const job = addReel('A1', 'ana', Date.now() - 4 * 86400000);
    collector.inbox.findCreatorThreadId = async () => 't_x';
    collector.inbox.readThreadEdges = async () => null;
    await collector.collect();
    assert.strictEqual(statusOf(job), 'WAITING');
  });

  test('simulated Reels are never collected', () => {
    const { job } = queue.createJob({ threadId: '999', senderUsername: 'ksydn_', reelUrl: 'https://instagram.com/reel/S1/', shortcode: 'S1', messageId: 'm_S1' });
    queue.createOrGetCreatorInteraction(job.id, { creatorUsername: 'sim', shortcode: 'S1', isSimulated: 1 });
    assert.strictEqual(collector.hasOutstanding(), false);
  });
});
