# Chapter 3: What changed, where, and why

This chapter compares the last commit (`e13d524`, web-dashboard version) with the current working tree (desktop app).

```powershell
git diff HEAD --stat     # the numbers below
git status               # desktop/ shows as untracked
```

## 3.1 Summary

| Measure | Value |
|---|---|
| Files deleted | 30 (14 in `src/`, 1 in `worker/`, 15 in `tests/`) |
| Files modified | 22 |
| Files renamed | 1 |
| New folder | `desktop/` with 5 files, 1,907 lines |
| Production code deleted | 3,818 lines |
| Runtime dependencies | removed `ffmpeg-static`, `tesseract.js`; kept `dotenv`, `playwright` |
| Dev dependencies added | `electron`, `electron-builder` |
| External tools no longer needed | Python, FFmpeg, Tesseract |
| Test status | 103 passing (the old README claimed 126; tests for deleted code went with it) |

**Before → after at a glance**

| Topic | Before (Era 2) | After (Era 3) |
|---|---|---|
| How you start it | `npm run dashboard` in a terminal | Double-click an installed app |
| UI | Browser tab at `localhost:3000` | Native Electron window |
| UI ↔ core | HTTP + JSON, polled every 1.5 s | IPC, pushed on change plus a 5 s safety refresh |
| Network port | 3000, on all interfaces | None |
| Triggers | Dashboard, DM commands, optional continuous loop | Window buttons only |
| Background activity | Poll every 15 s | None |
| Browser | Bundled Chromium with fake user-agent | Installed Microsoft Edge |
| Browser lifetime | Open while the daemon runs | Opened per task, closed afterwards |
| Login | Separate `npm run setup:session` script | **Log in** button |
| Allowed senders | `IG_ALLOWED_USERS` env var, default two accounts | One hardcoded owner |
| Approval | `approve.js` CLI or `--auto-approve` flag | Clicking Start is the approval |
| Concurrency guard | `isBatchRunning` boolean | `activeTask` lock across batch, unfollow, login |
| Data location | `./data` in the repo | `%APPDATA%\ReelLink` |
| Log output | Console only | Console, log file and UI activity log |
| Stop behaviour | Immediately flips the running flag | Finishes the current Reel, then stops |
| Failed inbox scan | Looks like "no new Reels" | Reported as a batch error |
| Distribution | Clone the repo | `ReelLink Setup 0.1.0.exe` (124 MB) |

## 3.2 New files

| File | Lines | Purpose |
|---|---:|---|
| [`desktop/main.js`](../../desktop/main.js) | 92 | Electron main process: window, IPC handlers, clean shutdown |
| [`desktop/preload.js`](../../desktop/preload.js) | 17 | The only API the page can call (`window.reellink`) |
| [`desktop/renderer/index.html`](../../desktop/renderer/index.html) | 908 | Layout, styles and the Content-Security-Policy |
| [`desktop/renderer/renderer.js`](../../desktop/renderer/renderer.js) | 253 | Draws status into the page, wires the buttons |
| [`desktop/renderer/shader.js`](../../desktop/renderer/shader.js) | 637 | Two WebGL effects: background and Start button |

The three renderer files replace the single 1,788-line `src/web/dashboard.html`. Inline scripts and `onclick` handlers had to move out because the new Content-Security-Policy forbids them.

## 3.3 Deleted files

**Era 1 discovery pipeline** (already unreachable from `src/app.js` before this change)

| File | Lines | What it did |
|---|---:|---|
| `src/pipeline/sample-frames.js` | 123 | FFmpeg frame sampling with duplicate removal |
| `src/pipeline/run-ocr.js` | 138 | Tesseract OCR on frames |
| `src/pipeline/extract-audio.js` | 65 | Extract WAV audio |
| `src/pipeline/transcribe.js` | 69 | Call the Python Whisper worker |
| `worker/transcribe.py` | 87 | The `faster-whisper` worker |
| `src/pipeline/build-search-query.js` | 278 | Build search queries from evidence |
| `src/pipeline/search-web.js` | 283 | DuckDuckGo, SerpAPI, Tavily, Google adapters |
| `src/pipeline/validate-candidates.js` | 204 | Score search results |
| `src/pipeline/process-resource.js` | 96 | Classify and process found links |
| `src/security/validate-url.js` | 205 | SSRF defence and DNS pinning |
| `src/utils/csv-recorder.js` | 60 | Wrote `ReelLink_Resources.csv` |

**Web server era**

| File | Lines | Replaced by |
|---|---:|---|
| `src/web/server.js` | 232 | Electron IPC in `desktop/main.js` |
| `src/web/dashboard.html` | 1,788 | `desktop/renderer/*` |

**Terminal tools**

| File | Lines | Replaced by |
|---|---:|---|
| `src/instagram/setup-session.js` | 89 | `BrowserSession.interactiveLogin()` and the Log in button |
| `src/approve.js` | 101 | Clicking Start counts as approval |

**Tests removed with their code (15):** `tests/benchmark-runner.js`, `tests/e2e/test-full-pipeline.js`, `tests/fixtures/benchmark-reels.json`, `tests/integration/test-ffmpeg-sampling.js`, `test-ocr.js`, `test-whisper.js`, `tests/live-test-supervised.js`, `tests/test-creator-supervised-live.js`, and unit tests for candidate ranking, event ranking, event query building, process-resource, query building, search diagnostics and SSRF.

## 3.4 Modified files

### `src/app.js`: rewritten from daemon to controllable core

| Change | Why |
|---|---|
| Now `extends EventEmitter`, emits `'update'` | The window is told when to redraw |
| Removed `start()`, `_startLoop()`, `_runCycle()`, poll timer, signal handlers | No daemon any more |
| Removed web server, port, CLI flags | IPC replaced them |
| Added `init()` | One-time startup recovery, separate from the constructor |
| Added `_beginTask()` / `_endTask()` / `activeTask` | One browser task at a time |
| Added `stopRequested` | Stop after the current Reel, cleanly |
| Added `unfollow()` | Logic moved from the HTTP handler into the core |
| Added `login()` | Sign in from the window |
| Added `getStatus()` | Snapshot for the UI, moved from the web server |
| Added `shutdown()` | Closes things without `process.exit` |
| `autoApprove = true`, `requireApproval: false` | Start is the approval |
| Browser closes in `finally` of each task | Nothing stays open |
| New guard: no creator means job `FAILED` | Before, it could carry on with an empty name |
| Batch errors are returned, not thrown | The UI shows them |
| Log buffer 50 → 200 lines | More activity history |
| Removed 10-second auto-reset to IDLE | A finished batch keeps showing its result |

### `src/config/index.js`

Added `OWNER_USERNAME`, `OWNER_DISPLAY_NAME`, `dataDir`, `browserChannel`, `logFile`. Paths now come from `REELLINK_DATA_DIR`. Removed all pipeline, search, storage, web and `IG_USERNAME`/`IG_PASSWORD` settings.

### `src/instagram/session.js`

Launches a chosen browser `channel` (default `msedge`). Removed the fake user-agent. Added `interactiveLogin()`.

### `src/instagram/inbox.js`

| Change | Why |
|---|---|
| Added `looksLikeOwnerThread()` | The inbox list shows display names, not handles, so filtering the list by handle failed. This replaced a hardcoded `startsWith('nauman')` |
| Added `_ensurePage()` | The browser now closes between tasks, so a saved page can be dead |
| Added `_waitForInboxReady()` | Instagram draws the list seconds after load; also detects being logged out |
| Added `commandsEnabled` (default false) | DM commands are off, but command messages are still skipped so they never become jobs |
| Replaced hardcoded `'Naumannn'` with config | One place to change |
| `collectUnprocessedReels` now rethrows | A failed scan must not look like "no new Reels" |
| Logs when your chat can't be found | Otherwise a batch silently does nothing |

### `src/pipeline/extract-reel.js`

| Change | Why |
|---|---|
| Opens `/p/<shortcode>/` instead of `/reel/` | Per the code comment, `/reel/` now redirects to a scrolling feed with many Reels on one page, so the data could belong to a different Reel |
| New exported `parseOgDescription()` | Handles both of Instagram's description formats |
| Creator fallback limited to links inside `<main>` | Prevents picking up site navigation links |
| Removed clicking "... more" | No longer needed with the single-post page |

### `src/pipeline/creator-interaction.js`

- A word in quotes or brackets is now accepted as the keyword even if it is generic (`Comment "link"`).
- Forward target defaults to `config.owner`; hardcoded names removed.

### `src/queue/jobs.js`

One line, but important: recovery now includes `INTERACTING` jobs. Before, a crash during follow/comment left a job stuck forever.

### `src/security/sender-allowlist.js`

Removed the hardcoded fallback list and the `naumannn` special case. An empty list now fails closed.

### `src/utils/logger.js`

Added an append-only log file and `onLog()` subscribers. A packaged app has no terminal, so the file is the troubleshooting trail. It is disabled during tests.

### `src/instagram/sender.js`

Reopens a closed page before sending.

### Project files

| File | Change |
|---|---|
| `package.json` | `main` → `desktop/main.js`; scripts `start`, `start:sim`, `dist`; `build` section for the installer; dependency changes |
| `README.md` | Rewritten for desktop users |
| `.env.example` | Cut from 28 settings to 5 optional ones |
| `.gitignore` | Added `dist/` |

### Tests

`test-batch-trigger-and-web.js` was renamed to [`test-desktop-app.js`](../../tests/unit/test-desktop-app.js), with HTTP tests replaced by core API tests. `test-two-day-unfollow.js` now tests `app.unfollow()`. `test-sender-allowlist.js` now tests the single-owner rule. `test-extract-reel.js` gained `parseOgDescription` and quoted-keyword tests. Other test files got small updates for these API changes.

## 3.5 What was enhanced

**Usability.** Installer, desktop shortcut, one window, login button, live progress, plain-language status. No terminal.

**Security.** No open port, no CORS hole, sandboxed renderer, strict CSP, one allowed sender, no password in configuration.

**Reliability.** Crash recovery covers the follow/comment stage, dead pages are reopened, scan failures are visible, logged-out sessions are detected, tasks can't overlap, Stop is clean.

**Accuracy.** Single-post page for metadata, two description formats, explicit quoted keywords, no action without a creator name.

**Simplicity.** Three external tools and thousands of lines removed. There is one way to start work.

**Observability.** Log file, activity log in the window, audit rows in the database.

## 3.6 What was kept on purpose

- The job queue, deduplication and crash recovery.
- The follow-first workflow and its verification.
- The simulation/live separation.
- The layered sender checks.
- The 48-hour unfollow logic.
- The WebGL look of the old dashboard, including the liquid-metal Start button.

## 3.7 What was left behind

Some retired code is still in the files. [Chapter 18](18-known-issues-and-dead-code.md) lists it.
