const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CSV_PATH = path.resolve(__dirname, '../../data/ReelLink_Resources.csv');

function escapeCsv(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * Appends an extracted creator resource or message to the local CSV spreadsheet.
 * Thread-wise record including timestamp, creator, reel URL, status, link, and message.
 * @param {Object} params
 */
function recordResource({ creator, shortcode, keyword, status, url, message, threadId }) {
  try {
    const dir = path.dirname(CSV_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fileExists = fs.existsSync(CSV_PATH);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cleanCreator = creator ? `@${creator.replace(/^@/, '')}` : '';
    const reelUrl = shortcode ? `https://www.instagram.com/reel/${shortcode}/` : '';
    const threadUrl = threadId && !String(threadId).startsWith('row_')
      ? `https://www.instagram.com/direct/t/${threadId}/`
      : '';

    const row = [
      escapeCsv(now),
      escapeCsv(cleanCreator),
      escapeCsv(reelUrl),
      escapeCsv(keyword || ''),
      escapeCsv(status || 'COMPLETED'),
      escapeCsv(url || ''),
      escapeCsv((message || '').slice(0, 300).replace(/\r?\n/g, ' ')),
      escapeCsv(threadUrl),
    ].join(',') + '\n';

    if (!fileExists) {
      const header = 'Timestamp,Creator,Reel_URL,Comment_Posted,Status,Extracted_Link,Creator_Message,Thread_URL\n';
      fs.writeFileSync(CSV_PATH, header + row, 'utf8');
    } else {
      fs.appendFileSync(CSV_PATH, row, 'utf8');
    }

    logger.info('Recorded resource to ReelLink_Resources.csv', { creator: cleanCreator, url: url || 'N/A' });
  } catch (err) {
    logger.warn('Failed to record resource to CSV', { error: err.message });
  }
}

module.exports = {
  recordResource,
  CSV_PATH,
};
