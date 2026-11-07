# ReelLink System Architecture & Design Specification

> **Version:** 1.0.0  
> **Status:** Active Reference Architecture  
> **Target Environment:** Windows 10/11 Local Monolith (Node.js + Python)

---

## 1. Architectural Principles

1. **Local-First & Monolithic Simplicity:** Avoid premature microservices, cloud queues, or distributed complexity. The system runs as a single persistent Windows process backed by SQLite.
2. **Strict Cost Hierarchy:** Cheap operations precede expensive ones:
   $$\text{Caption Parsing (0ms)} \to \text{Sampled OCR (2-3s)} \to \text{Local Audio Transcription (15s)} \to \text{Public Search (1s)} \to \text{Creator Interaction (30s+)}$$
3. **Decoupled Transports and Logic:** The Instagram messaging layer is an interchangeable transport adapter. The core extraction, search, ranking, and validation pipeline does not depend on Instagram-specific primitives.
4. **Resilient Idempotence:** Every external interaction (Reel URL, candidate search, message reply) is recorded with a unique deduplication key in transactional storage.
5. **Zero Hallucination Policy:** Every candidate returned to the user must have an audit trail linking it back to extracted evidence (tokens, timestamps, domains).

---

## 2. Component Boundaries & Responsibilities

```
                                  ┌────────────────────────┐
                                  │   Instagram User DM    │
                                  └───────────┬────────────┘
                                              │ Shared Reel
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ TRANSPORT LAYER: src/instagram/                                                         │
│                                                                                         │
│  ┌───────────────────────────────┐               ┌───────────────────────────────────┐  │
│  │  InboxWatcher (inbox.js)      │               │  MessageSender (sender.js)        │  │
│  │  - Polls DM thread list       │               │  - Sends ACK messages             │  │
│  │  - Detects shared Reel cards  │               │  - Sends verified results         │  │
│  │  - Extracts shortcode & user  │               │  - Formats mobile-friendly markdown│ │
│  └──────────────┬────────────────┘               └───────────────────▲───────────────┘  │
│                 │                                                    │                  │
│                 │          ┌──────────────────────────┐              │                  │
│                 └─────────►│  BrowserSession          │──────────────┘                  │
│                            │  (Playwright Persistent) │                                 │
│                            └──────────────────────────┘                                 │
└─────────────────────────────────────────┬───────────────────────────────────────────────┘
                                          │ Enqueue Job / Emit Event
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ STORAGE & ORCHESTRATION LAYER: src/storage/ & src/queue/                                │
│                                                                                         │
│  ┌────────────────────────────────┐            ┌─────────────────────────────────────┐  │
│  │  Database (database.js)        │            │  JobQueue (jobs.js)                 │  │
│  │  - SQLite (better-sqlite3)     │◄──────────►│  - State machine transition         │  │
│  │  - Tables: jobs, candidates,   │            │  - Crash recovery & retry logic     │  │
│  │    audit_logs, sessions        │            │  - FIFO dispatcher with concurrency │  │
│  └────────────────────────────────┘            └──────────────────┬──────────────────┘  │
└───────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                    │ Dispatch Job
                                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ STAGED PIPELINE LAYER: src/pipeline/                                                    │
│                                                                                         │
│  Stage A: Content Extraction                                                            │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────────┐  │
│  │ extract-reel.js       │──►│ sample-frames.js      │──►│ run-ocr.js & transcribe.js│  │
│  │ - Caption & metadata  │   │ - FFmpeg 0.5 fps      │   │ - Local Tesseract OCR     │  │
│  │ - Bio/link preview    │   │ - Perceptual dedup    │   │ - Local faster-whisper IPC│  │
│  └───────────────────────┘   └───────────────────────┘   └─────────────┬─────────────┘  │
│                                                                        │ Evidence Tokens│
│  Stage B: Public Web Discovery                                         ▼                │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────────┐  │
│  │ build-search-query.js │──►│ search-web.js         │──►│ validate-candidates.js    │  │
│  │ - Strip hashtags      │   │ - DuckDuckGo / SerpAPI│   │ - Domain & token matching │  │
│  │ - Combine entities    │   │ - GitHub search       │   │ - Early stop if score>=0.7│  │
│  └───────────────────────┘   └───────────────────────┘   └─────────────┬─────────────┘  │
│                                                                        │ Candidate URL  │
│  Stage C & Validation: Processing                                      ▼                │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌───────────────────────────┐  │
│  │ creator-workflow.js   │   │ validate-url.js       │   │ process-resource.js       │  │
│  │ - Fallback CTA parser │   │ - SSRF filter         │──►│ - PyMuPDF text extractor  │  │
│  │ - Guarded DM/comment  │   │ - Redirect resolver   │   │ - GitHub README parser    │  │
│  └───────────────────────┘   └───────────────────────┘   └─────────────┬─────────────┘  │
└────────────────────────────────────────────────────────────────────────┼────────────────┘
                                                                         │ Verified Result
                                                                         └─► (To Sender)
```

---

## 3. Detailed Data Flow & Job Lifecycle

### State Machine Transition Diagram
```
   [Incoming Message Detected]
                │
                ▼
           [ PENDING ] ─────────────┐ (Duplicate detected)
                │                   │
                ▼                   ▼
          [ EXTRACTING ] ────► [ COMPLETED (Cached) ]
                │
                ├─► Direct URL in Caption? ───────────────────┐
                │                                             │
                ▼                                             │
          [ SEARCHING ]                                       │
                │                                             │
                ├─► High Confidence Match Found (Score >= 0.7)│
                │                                             │
                ▼                                             │
          [ EVALUATING_CREATOR ] (If public search failed)    │
                │                                             │
                ▼                                             ▼
          [ PROCESSING ] ◄────────────────────────────────────┘
                │
                ▼
          [ DELIVERING ]
                │
                ▼
          [ COMPLETED ]
```

### Failure & Retry Transitions
- If any transient error occurs (network timeout, rate limit) and `retry_count < max_retries`:
  $$\text{State} \to \text{PENDING}, \quad \text{retry\_count} \leftarrow \text{retry\_count} + 1, \quad \text{delay} = 2^{\text{retry\_count}} \times 5\text{s}$$
- If `retry_count >= max_retries`:
  $$\text{State} \to \text{FAILED}, \quad \text{Sends helpful failure message to user}$$

---

## 4. Database Schema Specification (SQLite)

### Table: `jobs`
Tracks individual Reel processing requests.
```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,               -- UUIDv4
  thread_id TEXT NOT NULL,           -- Instagram direct thread ID
  sender_username TEXT NOT NULL,     -- Instagram handle of user who sent the Reel
  reel_url TEXT NOT NULL,            -- Normalized Reel URL
  shortcode TEXT NOT NULL,           -- Unique shortcode (e.g. C_xyz123)
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, EXTRACTING, SEARCHING, PROCESSING, COMPLETED, FAILED
  stage TEXT NOT NULL DEFAULT 'A',   -- A (Extraction), B (Search), C (Creator), D (Delivering)
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  evidence_json TEXT,                -- Serialized tokens, OCR text, transcript, caption
  candidate_url TEXT,                -- Final chosen URL
  result_summary TEXT,               -- Formatted result description
  error_message TEXT,
  is_delivered INTEGER DEFAULT 0,    -- 1 if response DM was successfully dispatched
  delivered_at TEXT,                 -- Timestamp of successful delivery
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_jobs_shortcode ON jobs(shortcode);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_thread ON jobs(thread_id);
```

### Table: `candidates`
Audit log of every search result evaluated for a job.
```sql
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  domain TEXT,
  score REAL NOT NULL,               -- 0.00 to 1.00
  reasoning TEXT,                    -- Heuristic breakdown of score
  is_selected BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_candidates_job ON candidates(job_id);
```

### Table: `audit_logs`
Structured security and execution log.
```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  level TEXT NOT NULL,               -- info, warn, error, security
  component TEXT NOT NULL,           -- inbox, ocr, whisper, search, validator
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. Security & SSRF Prevention Architecture

To prevent Server-Side Request Forgery when validating candidate links:

1. **DNS Pre-Resolution:**
   Before making HTTP requests to candidate URLs, perform DNS resolution via Node's `dns.promises.lookup`.
2. **IP Range Check:**
   Reject any address falling inside:
   - `127.0.0.0/8` (Localhost)
   - `10.0.0.0/8` (Private Class A)
   - `172.16.0.0/12` (Private Class B)
   - `192.168.0.0/16` (Private Class C)
   - `169.254.0.0/16` (Link-local / Cloud metadata endpoints like AWS `169.254.169.254`)
   - `::1` or IPv6 private subnets (`fc00::/7`).
3. **Protocol Enforcement:**
   Only `http:` and `https:` protocols are permitted. `file:`, `ftp:`, `data:`, `gopher:` are strictly blocked.
4. **Redirect Limit:**
   Follow redirects manually with a maximum limit of 5 hops, re-validating the resolved IP address on each hop.

---

## 6. Dependency Map & Environment Matrix

| Dependency | Purpose | Runtime | Fallback / Condition |
| :--- | :--- | :--- | :--- |
| **Node.js ($\ge$ v18)** | Application Host, Orchestration, Playwright | Windows Host | Core runtime |
| **Playwright** | Persistent Chromium Instagram Web session | Node.js | Mandatory for DM inbox |
| **node:sqlite** | Fast synchronous SQLite storage (built-in Node 24) | Node.js | Core persistent state |
| **FFmpeg** | Video frame extraction & audio slicing | System Binary | Required for Stage A2 & A3 |
| **Tesseract OCR** | Local optical character recognition | System Binary | Required for Stage A2 |
| **Python ($\ge$ 3.9)** | Subprocess worker for Whisper & PyMuPDF | System Binary | Worker process |
| **faster-whisper** | Local speech-to-text | Python | Optional; CPU INT8 fallback |
| **PyMuPDF (`fitz`)**| Local PDF text & link extraction | Python | Worker script |
