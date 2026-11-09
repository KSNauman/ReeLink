# Chapter 16: Testing

## 16.1 Running

```powershell
npm test                     # all 103 tests, about 9 s
npm run test:unit
npm run test:integration
node --test tests/unit/test-queue.js    # one file
```

Result on 2026-11-09: **103 passed, 0 failed, 0 skipped, 8.9 s.**

The runner is `node:test`, built into Node, so there's no test framework dependency.

## 16.2 How the tests work without Instagram

| Technique | Example |
|---|---|
| **Constructor injection** | `new ReelLinkApp({ db, queue, inbox: mockInbox, live: false })` |
| **Simulation mode** | Exercises the real workflow with no browser |
| **Real SQLite, temp files** | Queries run for real, not mocked |
| **Mock page objects** | Fake `goto`, `$`, `waitForTimeout` |
| **Synthetic HTML** | The integration test loads a fake Instagram with Playwright route mocks |

The logger writes no file during tests (it checks `NODE_TEST_CONTEXT`).

## 16.3 Test inventory

| File | Tests | Covers |
|---|---:|---|
| `test-bot-commands.js` | 10 | DM commands, security, reset/unfollow safety |
| `test-comment-only-workflow.js` | 8 | The simplified follow + comment flow |
| `test-creator-interaction-simulation.js` | 8 | Follow-first order, failures, idempotency |
| `test-creator-reply-detection.js` | 7 | Reply monitoring stays retired |
| `test-creator-requirements.js` | 5 | Keyword and requirement parsing |
| `test-desktop-app.js` | 5 | `getStatus`, busy lock, batch order |
| `test-extract-reel.js` | 6 | Metadata and `parseOgDescription` |
| `test-inbox-baseline-and-creator-live-approval.js` | 12 | Deduplication, restarts, crash safety |
| `test-new-features.js` | 8 | Default emoji, history, forwarding |
| `test-queue.js` | 1 | Lifecycle, dedup, retry, recovery |
| `test-sender-allowlist.js` | 6 | The single-owner rule, fail closed |
| `test-simulation-safety-audit.js` | 3 | Simulation never touches the page |
| `test-simulation-state-separation.js` | 3 | Simulated results never count as live |
| `test-two-day-unfollow.js` | 3 | 48-hour segmentation |
| `test-url-regex.js` | 4 | URL parsing, tracking removal |
| `test-workflow-ddrtnlbsavb.js` | 7 | A full worked example Reel |
| `test-xma-button-and-watermark-resolution.js` | 6 | Link resolution helpers |
| `integration/test-inbox-selectors.js` | 1 | Selectors on synthetic pages |
| **Total** | **103** | |

## 16.4 Tests worth knowing

**One task at a time** (`test-desktop-app.js`). A promise gate holds the first batch open while a second `startBatch` and an `unfollow` are attempted. Both are rejected.

**Simulation can't leak** (`test-simulation-state-separation.js`). After a simulated run, a live run must still perform the follow and comment.

**Simulation never touches the browser** (`test-simulation-safety-audit.js`).

**Crash safety** (`test-inbox-baseline...js`, #12). A crash mid-process recovers without repeating actions.

**Regression for a real Reel** (`test-workflow-ddrtnlbsavb.js`). Named after the shortcode of the Reel that revealed bugs.

## 16.5 What the tests don't cover

Be upfront about these:

- **The Electron layer has no automated tests.** `main.js`, `preload.js` and the renderer are untested. `test-desktop-app.js` tests the core under plain Node, despite its name.
- **Real Instagram.** Selectors are tested against a synthetic page only. A real change at Instagram won't fail any test.
- **The installer** has no automated test.
- **Some tests guard retired features** (DM commands, reply monitoring). They pass but protect code the app doesn't use.

## 16.6 Housekeeping problem

Tests leave database files in `data/`: there are **363 `test_*` files** there now. They're ignored by git but keep accumulating, because many test runs don't clean up after themselves. It is safe to delete them.

## 16.7 Manual testing checklist

Before a release:

1. `npm run start:sim` with a separate `REELLINK_DATA_DIR`. Confirm the SIMULATION tag and that a batch completes.
2. `npm start`, click Log in, confirm "Login saved".
3. Share one Reel to the bot. Start a batch. Confirm the follow and comment on Instagram.
4. Start again. Confirm "No new Reels".
5. During a batch, click Stop. Confirm it finishes the current Reel.
6. Unfollow eligible when none are eligible: expect the "inside the 48-hour window" message.
7. Force quit during a batch, reopen, confirm "Recovered 1 interrupted job(s)".
8. Run the built `win-unpacked\ReelLink.exe` once.

## 16.8 Adding a test

1. Create a temp database with `new Database(path)`.
2. Create a `JobQueue` around it.
3. Build `ReelLinkApp` with fakes and `live: false`.
4. Assert on database state, not just return values.
5. Close the database and delete the files in `afterEach`.
