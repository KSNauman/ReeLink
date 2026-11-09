const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

class Database {
  constructor(dbPath = config.database.path) {
    this.dbPath = dbPath;
    this.db = null;
    this._init();
  }

  _init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    logger.info('Initializing SQLite database', { path: this.dbPath });
    this.db = new DatabaseSync(this.dbPath);

    // Performance and integrity pragmas
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

    this._createTables();
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender_username TEXT NOT NULL,
        reel_url TEXT NOT NULL,
        shortcode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        stage TEXT NOT NULL DEFAULT 'A',
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        evidence_json TEXT,
        candidate_url TEXT,
        result_summary TEXT,
        error_message TEXT,
        is_delivered INTEGER DEFAULT 0,
        delivered_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_shortcode ON jobs(shortcode);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_thread ON jobs(thread_id);

      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT,
        domain TEXT,
        score REAL NOT NULL,
        reasoning TEXT,
        is_selected INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_candidates_job ON candidates(job_id);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS creator_interactions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        creator_username TEXT NOT NULL,
        shortcode TEXT NOT NULL,
        requires_follow INTEGER DEFAULT 0,
        requires_comment INTEGER DEFAULT 0,
        keyword TEXT,
        follow_status TEXT DEFAULT 'NOT_ATTEMPTED',
        follow_verified_at TEXT,
        comment_status TEXT DEFAULT 'NOT_ATTEMPTED',
        comment_posted_at TEXT,
        comment_text TEXT,
        reply_status TEXT DEFAULT 'WAITING',
        reply_received_at TEXT,
        extracted_url TEXT,
        review_reason TEXT,
        is_simulated INTEGER DEFAULT 0,
        simulated_follow_status TEXT DEFAULT 'NOT_ATTEMPTED',
        simulated_follow_at TEXT,
        simulated_comment_status TEXT DEFAULT 'NOT_ATTEMPTED',
        simulated_comment_at TEXT,
        live_follow_verified_at TEXT,
        live_comment_posted_at TEXT,
        live_comment_verified_at TEXT,
        last_seen_message_id TEXT,
        last_seen_message_text TEXT,
        waiting_since TEXT,
        initial_window_expires_at TEXT,
        last_inbox_check_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ci_job ON creator_interactions(job_id);
      CREATE INDEX IF NOT EXISTS idx_ci_creator ON creator_interactions(creator_username);

      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        sender_username TEXT NOT NULL,
        shortcode TEXT,
        reel_url TEXT,
        ack_sent INTEGER DEFAULT 0,
        is_baseline INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pm_thread ON processed_messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_pm_sender ON processed_messages(sender_username);
    `);

    // Defensive migrations for existing databases
    const jobColumnsToEnsure = [
      'message_id TEXT',
      'is_approved INTEGER DEFAULT 0',
      'approved_at TEXT',
    ];
    for (const col of jobColumnsToEnsure) {
      try {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col};`);
      } catch {
        // Column already exists
      }
    }

    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_message ON jobs(message_id);');
    } catch {}

    const columnsToEnsure = [
      'last_seen_message_id TEXT',
      'last_seen_message_text TEXT',
      'waiting_since TEXT',
      'initial_window_expires_at TEXT',
      'last_inbox_check_at TEXT',
      "simulated_follow_status TEXT DEFAULT 'NOT_ATTEMPTED'",
      'simulated_follow_at TEXT',
      "simulated_comment_status TEXT DEFAULT 'NOT_ATTEMPTED'",
      'simulated_comment_at TEXT',
      'live_follow_verified_at TEXT',
      'live_comment_posted_at TEXT',
      'live_comment_verified_at TEXT',
      'topic TEXT',
      'creator_thread_id TEXT',
      'reply_note TEXT',
      'reply_notified_at TEXT',
    ];
    for (const col of columnsToEnsure) {
      try {
        this.db.exec(`ALTER TABLE creator_interactions ADD COLUMN ${col};`);
      } catch {
        // Column already exists
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        label TEXT,
        message_text TEXT,
        message_at TEXT,
        delivered_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(job_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_resources_job ON resources(job_id);
    `);

    logger.debug('Database tables verified and indexed');
  }

  // Prepared statement helpers
  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
let defaultInstance = null;

function getDatabase(dbPath) {
  if (!defaultInstance || (dbPath && defaultInstance.dbPath !== dbPath)) {
    defaultInstance = new Database(dbPath);
  }
  return defaultInstance;
}

module.exports = {
  Database,
  getDatabase,
};
