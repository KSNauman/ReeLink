# Architecture Decision Records (ADRs)

> This document tracks the chronological log of major architectural, technical, and engineering decisions for the **ReelLink** project.

---

## ADR-001: Execution Environment & Runtime Monolith
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  The project is a personal research prototype running continuously on the user's local Windows 10/11 workstation. The core workflow requires web scraping, browser automation, file processing, and local ML inference.
- **Decision:**
  Adopt a local monolithic architecture. Node.js manages process lifecycle, Playwright browser sessions, and the SQLite job queue. Python is invoked via IPC subprocesses for machine learning tasks (`faster-whisper`, `PyMuPDF`).

---

## ADR-002: Instagram Direct Message Integration Mechanism
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  Instagram is the primary user interface. ReelLink must receive shared Reels sent via DM and send back results.
- **Decision:**
  Use Playwright with Chromium and a persistent user data directory (`data/browser_profile`). The user logs in manually once in headful mode. All subsequent background polling and DM interactions reuse this authenticated profile.

---

## ADR-003: Persistent Job Queue Engine
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  ReelLink needs transactional job state tracking, duplicate prevention, crash recovery, and audit trails without external server dependencies.
- **Decision:**
  Use SQLite in Write-Ahead Logging (WAL) mode via Node 24 native `node:sqlite`. SQLite provides atomic transactions, sub-millisecond queries, zero background daemon overhead, and complete persistence in a single local file (`data/reellink.db`).

---

## ADR-004: Tiered, Cost-Conscious Content Extraction Pipeline
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  Analyzing a video with multimodal cloud vision or continuous Whisper transcription for every incoming Reel is computationally expensive and slow.
- **Decision:**
  Implement a strict 3-tier extraction hierarchy:
  - **Tier 1:** Parse caption and accessible metadata. If a valid URL is found, trigger Early Stopping and jump straight to validation.
  - **Tier 2:** If no URL, sample 1 frame every 2 seconds with FFmpeg, dedup near-identical frames, and run local Tesseract OCR.
  - **Tier 3:** If OCR yields no distinct entity or URL and speech is detected, invoke local `faster-whisper` transcription on CPU/GPU.

---

## ADR-005: Modular Search Provider Abstraction
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  The system must find public resources without being locked into a single paid search provider.
- **Decision:**
  Define a clean `SearchProvider` interface. Implement a zero-cost DuckDuckGo adapter as the default provider, with optional plug-and-play support for SerpAPI, Tavily, and Google Custom Search if the user provides API keys in `.env`.

---

## ADR-006: Server-Side Request Forgery (SSRF) and Redirect Defense
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  When validating candidate links extracted from unknown public sources or Reels, the application must not fetch internal network resources, local router admin portals, or cloud metadata endpoints.
- **Decision:**
  All candidate URLs pass through a security validator that resolves DNS hostnames before issuing HTTP requests, explicitly barring `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`, IPv6 loopback, link-local, unique-local, documentation prefixes, and non-HTTP/HTTPS protocols. Redirects are capped at 5 hops and pin the pre-validated IP address to eliminate DNS rebinding attacks.

---

## ADR-007: Delivery Idempotence & Controlled Live-Test Protocol
- **Date:** 2026-10-19
- **Status:** **ACCEPTED**
- **Context:**
  Prior to live account testing, duplicate DM dispatches across crash restarts and uncontrolled social interactions must be categorically prevented.
- **Decision:**
  1. Add `is_delivered` and `delivered_at` fields to SQLite `jobs`. On crash recovery, any job with `is_delivered == 1` is marked `COMPLETED` immediately without resending.
  2. Implement global `DRY_RUN` support in `config` and `InstagramSender` which logs simulated DM dispatches without sending.
  3. Create `tests/live-test-supervised.js` for operator-confirmed dry-run and live tests.
  4. Bar automated comment posting or creator follows until explicit user authorization is granted.
