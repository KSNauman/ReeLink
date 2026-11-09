# Chapter 18: Known issues and dead code

An honest audit, as of 2026-11-09. Knowing these is the difference between "I built it" and "I understand it".

**Labels.** *Verified* means run against the real modules on a temporary database. *From code* means found by reading the logic, not run against live Instagram.

**None of these were fixed as part of writing this book.** The code was not changed.

---

## A. Could cause a wrong action on Instagram (fix first)

### A1. Generic phrases become the comment
**Verified.** Keyword pattern 6 accepts any word after "comment" or "drop".

| Caption | Posted |
|---|---|
| `Comment your thoughts below` | `your` |
| `Drop a comment if you agree` | `if` |

**Where:** last entry of `COMMENT_KEYWORD_PATTERNS`, `creator-interaction.js`.
**Fix idea:** require the word to be ALL CAPS for the bare pattern, or expand the noise list with common English words.

### A2. A real keyword is rejected
**Verified.** `Comment GUIDE below` posts 🙌, because `guide` is on the noise list. "Guide", "link" and "free" are common real keywords. Only the quoted form works.
**Fix idea:** an all-caps word is very likely deliberate, so accept it even when it is on the list.

### A3. A restriction doesn't stop the batch
**Verified.** If Instagram shows "Action blocked", that job fails, and the loop moves to the next Reel 5 to 7 seconds later. The file's header says it "stops immediately". Continuing after a block is the worst behaviour for the account.
**Fix idea:** have `processJob` return a flag on `RESTRICTED`, and break out of the loop.

### A4. An unfollow can be falsely recorded
**From code.** In `unfollowCreatorDirect`, `unfollowConfirmed` is only logged. If the confirm dialog isn't found, the creator is still marked unfollowed. And if the `Following` button isn't found, for example because the page didn't load, the same thing happens. ReelLink then forgets a creator it still follows.
**Fix idea:** check the button changed back to "Follow" before marking.

### A5. First batch acts on old shares
**From code.** `establishBaseline()` is never called in the desktop flow, so the first batch treats all visible Reels as new. The same happens after deleting the database.
**Fix idea:** on an empty database, offer a choice to baseline first.

### A6. A pasted link can create two jobs
**From code.** A pasted Reel URL can be detected as `text` and as `link`, with different message IDs, which gives two jobs and two comments. Normal Share-button shares use cards and are unaffected.
**Fix idea:** dedupe `detected` by shortcode within a single scan.

### A7. "Verified" comment is weaker than it sounds
**From code.** An emptied input counts as success even if the comment isn't visible.

---

## B. Correctness and behaviour

### B1. Retries are immediate and rarely apply
**Verified.** `handleJobError` re-queues with no delay. The progress can read "2 of 1". Since most errors are returned rather than thrown, a brief network failure usually gives `FAILED` with no retry.

### B2. Failed Reels can't be re-run from the app
**Verified.** The message stays recorded, so scans skip it. You must share the Reel again.

### B3. Simulation shares state with live
**Verified.** Simulated runs (1) mark messages as seen, so a later live run skips those Reels, and (2) add simulated creators to the unfollow list, even in live mode. `recoverSimulatedJob` exists but nothing calls it.
**Workaround:** use a separate `REELLINK_DATA_DIR` ([Chapter 14](14-configuration.md)).

### B4. `.env` settings silently ignored
**From code.** `REELLINK_SIMULATION` and `REELLINK_DATA_DIR` are read before `dotenv` runs, yet `.env.example` lists the former.

### B5. Only loaded messages are seen
**From code.** The chat isn't scrolled, so older unprocessed shares beyond what's loaded are missed.

### B6. Generated message IDs can shift
**From code.** `occurrence` and the `card_<index>` fallback depend on what's on the page. As messages load or scroll out, the same card could get a different ID and be treated as new. With a `card_<n>` fallback, a different card could even be mistaken for an old one.

### B7. Processing count overwrites
**From code.** In `getSystemStats`, `stats.processing = row.count` overwrites rather than adds. Harmless today, since one job runs at a time.

### B8. Quitting mid-batch
**From code.** `shutdown` closes the database while the batch may still be finishing, which raises errors. The job remains in progress and is recovered at next launch.

### B9. Hardcoded bot prefix
`dolphin.` appears in `inbox.js` and `extract-reel.js` rather than config.

### B10. README simplification
The README says changing the owner is "one line". You also need `OWNER_DISPLAY_NAME`.

### B11. `.env` location in the packaged app
`dotenv` uses the working directory, which isn't predictable for an installed app.

---

## C. Security and operations

| # | Issue |
|---|---|
| C1 | `--no-sandbox` is passed to Edge |
| C2 | Installer is unsigned |
| C3 | `reellink.log` and `audit_logs` grow with no limit |
| C4 | Fonts load from Google, the only network use by the window |
| C5 | 363 leftover `test_*` files in `data/` |
| C6 | Leftovers from older eras in the working folder: `eng.traineddata`, `data/ReelLink_Resources.csv`, `scratch/` (all ignored by git) |
| C7 | The desktop work is not committed |

---

## D. Dead code

Unreachable from the desktop flow. Safe to remove with care, mostly along with their tests.

### `src/pipeline/creator-interaction.js`

| Item | Note |
|---|---|
| `_retiredReplyMonitoring` | **Refers to `recordResource` and `processResource`, which are no longer imported.** It would crash with a `ReferenceError` if called. Never called |
| `monitorInboxForResponse` | Only used by the above and tests |
| `getEffectiveWaitingWindowSec` | Only used by the above |
| `matchCreatorReplyToJob` | Retired |
| `resumeWaitingJobs`, `checkWaitingJobsOnce` | No-ops |
| `forwardLatestCreatorMessage` | Retired |
| `unfollowCreator` (defined **twice**) | The second definition silently overrides the first. Neither is used by `app.unfollow` |
| `extractCommentKeyword` | Unused |

### `src/instagram/inbox.js`

| Item | Note |
|---|---|
| `handleBotCommand` (about 450 lines) | Disabled by `commandsEnabled`. Help text still mentions the web dashboard and `node src/approve.js`, both gone |
| `pollForIncomingReels` | Daemon era |
| `establishBaseline` | Not called (see A5) |
| `openCreatorThread`, `getThreadMessages` | Retired reply reading |
| `_attachNetworkListener` | Still runs, but its output is unused |

### Others

| File | Item |
|---|---|
| `src/instagram/session.js` | `checkAuthStatus` is not called |
| `src/instagram/sender.js` | Nothing in the desktop flow sends DMs |
| `src/queue/jobs.js` | `saveCandidates`, `markDelivered`, `getTodayHistory`, `getFollowedCreatorsToday`, `getJobsWaitingForReply`, `getJobsWaitingForCreator`, `recoverSimulatedJob`, `resetEligibleJobs` and more |
| `src/utils/logger.js` | `onLog` has no subscribers |
| `src/utils/url-helper.js` | Several helpers only serve retired code |
| `src/pipeline/extract-reel.js` | `hasDirectResource`, `needsMediaInspection` |
| `src/storage/database.js` | `candidates` table and many legacy columns (kept so old databases keep working) |
| `src/config/index.js` | `creatorWorkflow` timing fields, `dryRun`, `allowedUsers` |
| `tests/verify-inbox.js` | Manual diagnostic, not part of `npm test` |

### Out-of-date comments

File headers in `inbox.js` ("Inbox Watcher... polling") and `creator-interaction.js` ("Stage C", "Live mode disabled by default") describe earlier eras.

---

## E. Suggested order of work

1. **A3** Stop the batch on a restriction. Small change, big safety gain.
2. **A1 and A2** Fix keyword selection. Most visible errors.
3. **Commit** the desktop work.
4. **A4** Verify unfollow.
5. **A5** Baseline the first run.
6. **B3** Separate simulation data.
7. **D** Remove dead code, roughly 1,500 lines or more.
8. Add a real icon and sign the installer.
