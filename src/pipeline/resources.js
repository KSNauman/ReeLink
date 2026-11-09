/**
 * Collects the links creators send back after a comment, then delivers them:
 * a CSV that is rebuilt from the database, and one short DM summary to the owner.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const { extractExternalUrls, resolveDestinationUrl, isWatermarkUrl } = require('../utils/url-helper');

const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
// A reply can land slightly before our recorded comment time.
const CLOCK_SLACK_MS = 30 * 1000;
const CLOSE_TOGETHER_MS = 5 * 60 * 1000;
const MAX_DM_CHARS = 900;

function isUsableLink(url) {
  if (!url || isWatermarkUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !(host === 'instagram.com' || host.endsWith('.instagram.com'));
  } catch {
    return false;
  }
}

/**
 * Turns Instagram's message records into simple messages from this creator, oldest first.
 * @param {Array} edges
 * @param {string} creator
 * @returns {Array<{ at: number, text: string, links: Array<{url: string, label: string|null}>, tapButtons: string[] }>}
 */
function parseThreadEdges(edges, creator) {
  const wanted = String(creator || '').toLowerCase();
  const messages = [];

  for (const edge of edges || []) {
    const node = edge && edge.node;
    if (!node || !node.content || node.content.__typename === 'SlideMessageAdminText') continue;

    const sender = node.sender?.user_dict?.username;
    if (!sender || sender.toLowerCase() !== wanted) continue;

    const xma = node.content.xma || null;
    const body = [node.text_body, node.content.xma_text_body].filter(Boolean).join('\n');
    const text = body || xma?.title_text || xma?.caption_body_text || '';
    const links = new Map();
    const tapButtons = [];

    for (const raw of extractExternalUrls(body)) {
      const url = resolveDestinationUrl(raw);
      if (isUsableLink(url) && !links.has(url)) links.set(url, null);
    }

    for (const button of xma?.cta_buttons || []) {
      if (button.action_url) {
        const url = resolveDestinationUrl(button.action_url);
        if (isUsableLink(url)) links.set(url, button.title || null);
      } else if (button.cta_type === 'postback' && button.title) {
        tapButtons.push(button.title);
      }
    }

    if (links.size === 0 && xma?.target_url) {
      const url = resolveDestinationUrl(xma.target_url);
      if (isUsableLink(url)) links.set(url, xma.title_text || null);
    }

    if (!text && links.size === 0 && tapButtons.length === 0) continue;

    messages.push({
      at: Number(node.timestamp_ms) || 0,
      text,
      links: [...links].map(([url, label]) => ({ url, label })),
      tapButtons,
    });
  }

  return messages.sort((a, b) => a.at - b.at);
}

/** A short "what is this about" line from a caption or reply. */
function deriveTopic(text) {
  const cleaned = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\w.]+/g, ' ')
    .split(/\n|(?<=[.!?])\s/)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .find(part => part.length >= 4);
  if (!cleaned) return '';
  return cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned;
}

function csvCell(value) {
  let text = String(value ?? '').replace(/\r?\n/g, ' ');
  // Text comes from strangers: stop Excel from running it as a formula.
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const STATUS_LABELS = {
  RECEIVED: 'Link received',
  WAITING: 'Waiting',
  NEEDS_YOU: 'Needs you',
  NO_REPLY: 'No reply',
};

function formatLocalDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildCsv(rows) {
  const header = ['Date', 'Creator', 'About', 'Link', 'Link text', 'Status', 'Reel', 'Keyword', 'Notes', 'Chat'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      formatLocalDate(r.commented_at),
      r.creator_username,
      r.topic,
      r.url,
      r.label,
      STATUS_LABELS[r.reply_status] || r.reply_status,
      r.shortcode ? `https://www.instagram.com/reel/${r.shortcode}/` : '',
      r.keyword,
      r.reply_note,
      r.creator_thread_id ? `https://www.instagram.com/direct/t/${r.creator_thread_id}/` : '',
    ].map(csvCell).join(','));
  }
  // The BOM makes Excel read emoji and non-English text correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * Rebuilds the CSV. If Excel has it open, writes a second file instead;
 * the main file catches up on the next run because it is always rebuilt in full.
 * @returns {{ path: string, usedFallback: boolean }}
 */
function writeCsv(rows, csvPath) {
  const content = buildCsv(rows);
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  try {
    fs.writeFileSync(csvPath, content, 'utf8');
    return { path: csvPath, usedFallback: false };
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
    const fallback = csvPath.replace(/\.csv$/i, '_latest.csv');
    fs.writeFileSync(fallback, content, 'utf8');
    return { path: fallback, usedFallback: true };
  }
}

/**
 * Builds the summary DM, split so each message stays under Instagram's length limit.
 * @returns {Array<{ text: string, resourceIds: number[], needsYouJobIds: string[] }>}
 */
function buildSummaryMessages(resources, needsYou, waitingCount) {
  const byJob = new Map();
  for (const r of resources) {
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, { row: r, links: [], ids: [] });
    const entry = byJob.get(r.job_id);
    entry.links.push(r.url);
    entry.ids.push(r.id);
  }

  const blocks = [];
  for (const { row, links, ids } of byJob.values()) {
    const about = row.topic ? `: ${row.topic}` : '';
    blocks.push({ text: [`• @${row.creator_username}${about}`, ...links.map(l => `  ${l}`)].join('\n'), resourceIds: ids, needsYouJobIds: [] });
  }
  for (const n of needsYou) {
    blocks.push({ text: `⚠️ @${n.creator_username} needs you: ${n.reply_note || 'open their chat'}`, resourceIds: [], needsYouJobIds: [n.job_id] });
  }
  if (blocks.length === 0) return [];

  const count = byJob.size;
  const title = count > 0 ? `ReelLink: ${count} new resource${count === 1 ? '' : 's'}` : 'ReelLink update';
  const footer = waitingCount > 0 ? `${waitingCount} still waiting for a reply` : '';

  const messages = [];
  let current = { text: title, resourceIds: [], needsYouJobIds: [] };
  for (const block of blocks) {
    if (current.text.length + block.text.length + 1 > MAX_DM_CHARS && (current.resourceIds.length || current.needsYouJobIds.length)) {
      messages.push(current);
      current = { text: 'ReelLink (continued)', resourceIds: [], needsYouJobIds: [] };
    }
    current.text += `\n${block.text}`;
    current.resourceIds.push(...block.resourceIds);
    current.needsYouJobIds.push(...block.needsYouJobIds);
  }
  if (footer) current.text += `\n${footer}`;
  messages.push(current);
  return messages;
}

class ResourceCollector {
  /**
   * @param {Object} deps
   * @param {Object} deps.queue
   * @param {Object} deps.inbox
   * @param {Object} deps.sender
   * @param {string} [deps.csvPath]
   * @param {number} [deps.pauseMs]
   */
  constructor({ queue, inbox, sender, csvPath, pauseMs }) {
    this.queue = queue;
    this.inbox = inbox;
    this.sender = sender;
    this.csvPath = csvPath || config.resourcesCsvPath;
    this.pauseMs = pauseMs !== undefined ? pauseMs : 2500;
  }

  hasOutstanding() {
    return this._outstanding().length > 0;
  }

  /** NEEDS_YOU Reels stop being re-checked once they're past the give-up window. */
  _outstanding() {
    const now = Date.now();
    return this.queue.getInteractionsAwaitingReply().filter(r =>
      r.reply_status === 'WAITING' || now - new Date(r.live_comment_posted_at).getTime() < GIVE_UP_AFTER_MS
    );
  }

  /**
   * Checks each creator we're still waiting on.
   * @param {{ shouldStop?: () => boolean, onProgress?: (p: {creator: string, index: number, total: number}) => void }} [options]
   * @returns {Promise<{ checked: number, received: number, needsYou: number }>}
   */
  async collect(options = {}) {
    const shouldStop = options.shouldStop || (() => false);
    const byCreator = new Map();
    for (const row of this._outstanding()) {
      const key = row.creator_username.toLowerCase();
      if (!byCreator.has(key)) byCreator.set(key, []);
      byCreator.get(key).push(row);
    }

    const totals = { checked: 0, received: 0, needsYou: 0 };
    let index = 0;
    for (const [creator, rows] of byCreator) {
      if (shouldStop()) break;
      index += 1;
      if (options.onProgress) options.onProgress({ creator, index, total: byCreator.size });
      try {
        await this._checkCreator(creator, rows, totals);
      } catch (err) {
        logger.warn('Could not check creator reply', { creator, error: err.message });
      }
      totals.checked += rows.length;
      if (this.pauseMs) await new Promise(r => setTimeout(r, this.pauseMs));
    }
    return totals;
  }

  async _checkCreator(creator, rows, totals) {
    let threadId = (rows.find(r => r.creator_thread_id) || {}).creator_thread_id || null;
    if (!threadId) threadId = await this.inbox.findCreatorThreadId(creator);

    if (!threadId) {
      for (const row of rows) this._expireIfOld(row, '');
      return;
    }

    // null means the chat couldn't be read this time, which says nothing about a reply.
    const edges = await this.inbox.readThreadEdges(threadId);
    if (!edges) {
      logger.warn('Could not read creator chat this run', { creator, threadId });
      return;
    }

    const messages = parseThreadEdges(edges, creator);
    rows.forEach((row, i) => {
      const postedAt = new Date(row.live_comment_posted_at).getTime();
      const next = rows[i + 1] ? new Date(rows[i + 1].live_comment_posted_at).getTime() : Infinity;
      const from = postedAt - CLOCK_SLACK_MS;
      const until = next === Infinity ? Infinity : next - CLOCK_SLACK_MS;
      const replies = messages.filter(m => m.at >= from && m.at < until);
      const closeToOther = (next - postedAt < CLOSE_TOGETHER_MS) ||
        (i > 0 && postedAt - new Date(rows[i - 1].live_comment_posted_at).getTime() < CLOSE_TOGETHER_MS);
      this._applyReplies(row, threadId, replies, closeToOther, totals);
    });
  }

  _applyReplies(row, threadId, replies, closeToOther, totals) {
    const links = replies.flatMap(m => m.links.map(l => ({ ...l, message: m })));
    const buttons = replies.flatMap(m => m.tapButtons);
    const lastText = replies.length ? replies[replies.length - 1].text : '';
    const base = {
      creator_thread_id: threadId,
      last_inbox_check_at: new Date().toISOString(),
    };
    if (!row.topic && lastText) base.topic = deriveTopic(lastText);

    if (links.length > 0) {
      for (const link of links) {
        this.queue.saveResource(row.job_id, {
          url: link.url,
          label: link.label,
          messageText: link.message.text.slice(0, 500),
          messageAt: new Date(link.message.at).toISOString(),
        });
      }
      this.queue.updateCreatorInteraction(row.job_id, {
        ...base,
        reply_status: 'RECEIVED',
        reply_received_at: new Date().toISOString(),
        reply_note: closeToOther ? 'Two Reels from this creator were close together: check which link is which' : '',
      });
      totals.received += 1;
      return;
    }

    if (buttons.length > 0) {
      if (row.reply_status !== 'NEEDS_YOU') totals.needsYou += 1;
      this.queue.updateCreatorInteraction(row.job_id, {
        ...base,
        reply_status: 'NEEDS_YOU',
        reply_note: `Tap "${buttons[buttons.length - 1]}" in their chat on the bot account`,
      });
      return;
    }

    this.queue.updateCreatorInteraction(row.job_id, { ...base, last_seen_message_text: lastText ? lastText.slice(0, 500) : undefined });
    if (this._expireIfOld(row, lastText)) totals.needsYou += lastText ? 1 : 0;
  }

  /** After 3 days, stop waiting. A text-only reply becomes "Needs you"; silence becomes "No reply". */
  _expireIfOld(row, lastText) {
    if (row.reply_status !== 'WAITING') return false;
    if (Date.now() - new Date(row.live_comment_posted_at).getTime() < GIVE_UP_AFTER_MS) return false;
    this.queue.updateCreatorInteraction(row.job_id, lastText
      ? { reply_status: 'NEEDS_YOU', reply_note: `They replied without a link: "${lastText.slice(0, 120)}"` }
      : { reply_status: 'NO_REPLY' });
    return true;
  }

  /**
   * Rebuilds the CSV and DMs the owner anything new.
   * Items are only marked as sent after their message goes out, so a failed DM is retried next run.
   * @returns {Promise<{ csv: {path: string, usedFallback: boolean}|null, dmCount: number, dmFailed: boolean }>}
   */
  async deliver() {
    let csv = null;
    try {
      csv = writeCsv(this.queue.getResourcesReport(), this.csvPath);
    } catch (err) {
      logger.error('Could not write resources CSV', { error: err.message });
    }

    const messages = buildSummaryMessages(
      this.queue.getUndeliveredResources(),
      this.queue.getUnnotifiedNeedsYou(),
      this.queue.countWaitingForReply()
    );
    if (messages.length === 0) return { csv, dmCount: 0, dmFailed: false };

    const threadId = this.queue.getOwnerThreadId();
    if (!threadId) {
      logger.warn('No owner chat known yet; resources summary not sent');
      return { csv, dmCount: 0, dmFailed: true };
    }

    let dmCount = 0;
    for (const message of messages) {
      const sent = await this.sender.sendMessage(threadId, message.text);
      if (!sent) return { csv, dmCount, dmFailed: true };
      this.queue.markResourcesDelivered(message.resourceIds);
      this.queue.markNeedsYouNotified(message.needsYouJobIds);
      dmCount += 1;
    }
    return { csv, dmCount, dmFailed: false };
  }
}

module.exports = {
  ResourceCollector,
  parseThreadEdges,
  deriveTopic,
  buildCsv,
  writeCsv,
  buildSummaryMessages,
};
