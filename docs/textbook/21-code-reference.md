# Chapter 21: Code reference

Every module, and what's in it. ✅ = used by the desktop flow. 💤 = retired or unused ([Chapter 18](18-known-issues-and-dead-code.md)).

## `desktop/main.js`

| Function | Purpose |
|---|---|
| `createWindow()` | Creates the secure window, locks navigation |
| `registerIpc()` | Registers the 5 IPC handlers |
| App events | `second-instance`, `window-all-closed`, `before-quit` |

## `desktop/preload.js`

Exposes `window.reellink`: `getStatus`, `startBatch`, `stopBatch`, `unfollow({forceAll})`, `login`, `onUpdate(fn)`.

## `desktop/renderer/renderer.js`

| Function | Purpose |
|---|---|
| `esc(value)` | HTML-escape untrusted text |
| `refresh()` | Fetch status and redraw |
| `scheduleRefresh()` | One refresh per frame |
| `setStatus(text, color, pulse)` | Status pill |
| `updateUI(data)` | Redraw the whole page |
| `handleStartBatchClick(e)` | Effects, then `triggerBatch` |
| `triggerBatch()`, `stopBatch()`, `login()`, `unfollowEligible()`, `unfollowAll()` | Button actions |

## `desktop/renderer/shader.js`

`initMeshDriftShader()` (background), `initLiquidMetalShader()` (Start button), global `setLmSpeed(speed)`.

## `src/app.js`: class `ReelLinkApp extends EventEmitter`

| Method | Returns | Purpose |
|---|---|---|
| `constructor({live, db, queue, browserSession, sender, inbox, creatorManager})` | | Build or inject services |
| `init()` | | Recover stalled jobs |
| `startBatch(options)` | `{success, processedCount, message?, error?}` | Scan and process |
| `stopBatch()` | boolean | Stop after this Reel |
| `processJob(job)` | | One Reel, start to finish |
| `unfollow({forceAll})` | `{success, count, unfollowed, failed, protectedCount, message}` | Unfollow |
| `login()` | `{authenticated, reason}` | Interactive sign-in |
| `getStatus()` | snapshot | UI data |
| `shutdown()` | | Close browser and DB |
| `_addLog`, `_emitUpdate`, `_beginTask`, `_endTask` | | Internals |

Event: `'update'` (no payload).

## `src/config/index.js`

Exports `config`: `env`, `rootDir`, `dataDir`, `owner`, `ownerDisplayName`, `security`, `instagram`, `database`, `logFile`, `creatorWorkflow`, `logLevel`.

## `src/instagram/session.js`: class `BrowserSession`

| Method | Status | Purpose |
|---|---|---|
| `getContext()` | ✅ | Launch once, or reuse |
| `getPage()` | ✅ | First tab |
| `interactiveLogin({timeoutMs})` | ✅ | Visible login |
| `close()` | ✅ | Shut the browser |
| `checkAuthStatus()` | 💤 | Login check |

## `src/instagram/inbox.js`: class `InstagramInbox`

| Method | Status | Purpose |
|---|---|---|
| `collectUnprocessedReels(options)` | ✅ | **Entry point of a scan** |
| `getInboxThreads()` | ✅ | List chats |
| `checkThreadForReels(id, hint, opts)` | ✅ | Verify sender, detect Reels |
| `navigateToInbox()` | ✅ | |
| `unfollowCreatorDirect(name, opts)` | ✅ | **The real unfollow** |
| `init`, `_ensurePage`, `_waitForInboxReady`, `_dismissPrompts`, `_extractThreadsFromPage` | ✅ | Helpers |
| `_attachNetworkListener` | runs, unused output | |
| `establishBaseline`, `pollForIncomingReels` | 💤 | |
| `handleBotCommand` | 💤 | Disabled |
| `navigateToRequests`, `getRequestsThreads`, `getThreadMessages`, `openCreatorThread` | 💤 | |

Module helper: `looksLikeOwnerThread(name)`.

## `src/instagram/sender.js`: class `InstagramSender` 💤

`sendMessage`, `sendAck`, `sendSuccess`, `sendFailure`, `_focusMessageInput`, `_attemptQuoteReply`.

## `src/pipeline/extract-reel.js`

| Function | Purpose |
|---|---|
| `fetchReelPublicData(url, session)` ✅ | Read creator and caption |
| `parseOgDescription(og)` ✅ | Both description formats |
| `parseReelMetadata(params)` ✅ | Structure the result |

## `src/pipeline/creator-interaction.js`

Functions: `extractCreatorRequirements` ✅, `isLiveFollowVerified`, `isLiveCommentVerified`, `isSimulatedFollowCompleted` ✅, `isSimulatedCommentCompleted` ✅.
Constants: `FOLLOW_PATTERNS`, `COMMENT_KEYWORD_PATTERNS`, `KEYWORD_NOISE_WORDS`, `RESTRICTION_INDICATORS`.

Class `CreatorInteractionManager`:

| Method | Status | Purpose |
|---|---|---|
| `executeCreatorWorkflow(job, options)` | ✅ | **Main entry** |
| `checkFollowStatus` | ✅ | Current state |
| `executeFollow` | ✅ | Click and verify |
| `executeComment` | ✅ | Type, post, verify |
| `_findFollowButton`, `_findFollowingButton`, `_checkForRestrictions` | ✅ | Helpers |
| `unfollowCreator`, `monitorInboxForResponse`, `matchCreatorReplyToJob`, `forwardLatestCreatorMessage`, `resumeWaitingJobs`, `checkWaitingJobsOnce`, `extractCommentKeyword`, `getEffectiveWaitingWindowSec`, `_retiredReplyMonitoring` | 💤 | |

## `src/queue/jobs.js`: class `JobQueue`

**Used:**

| Method | Purpose |
|---|---|
| `createJob(params)` / `createOrGetJob` | Add or find, with deduplication |
| `isMessageProcessed(id)` | Already seen? |
| `recordProcessedMessage(params)` | Mark seen |
| `approveJob(id)`, `getJobsAwaitingApproval()` | Approval |
| `getJobById(id)`, `getNextPendingJob()`, `getPendingJobsCount()` | Reads |
| `updateStatus(id, status, updates)` | Change status and audit |
| `handleJobError(id, error)` | Retry or fail |
| `recoverStalledJobs()` | Startup recovery |
| `logAudit(...)` | Audit row |
| `getCreatorInteraction`, `createOrGetCreatorInteraction`, `updateCreatorInteraction` | Follow/comment record |
| `isLiveFollowVerified`, `isLiveCommentVerified` | Real state checks |
| `getSystemStats()`, `getRecentJobs(n)` | UI data |
| `getDetailedFollowedCreatorsToday()`, `getFollowedCreatorsForUnfollow(opts)`, `markCreatorUnfollowed(name)` | Unfollow |

**Retired** 💤: `saveCandidates`, `markDelivered`, `isMessageAckSent`, `markMessageAckSent`, `isJobApproved`, `recoverSimulatedJob`, `getJobsWaitingForReply`, `getJobsWaitingForCreator`, `getTodayHistory`, `getActiveProcessingJobs`, `getFailedJobs`, `getResetEligibleJobs`, `resetEligibleJobs`, `resetPendingJobs`, `getFollowedCreatorsToday`, `getCompletedJobsCount`, `getFailedJobsCount`, `getJob`.

Export `JOB_STATUS`: `PENDING`, `EXTRACTING`, `SEARCHING`, `PROCESSING`, `AWAITING_APPROVAL`, `INTERACTING`, `WAITING_FOR_REPLY`, `NEEDS_REVIEW`, `COMPLETED`, `FAILED`.

## `src/storage/database.js`

Class `Database`: `prepare`, `exec`, `close`. Function `getDatabase(path)` returns the singleton.

## `src/security/sender-allowlist.js`

`normalizeSenderUsername`, `getEffectiveAllowedSenders`, `isSenderAllowed`, `assertSenderAllowed`.

## `src/utils/logger.js`

`logger.debug|info|warn|error|security(message, meta)`, `logger.onLog(fn)` 💤. Internal: `sanitize`, `formatLog`, `emit`, `getFileStream`.

## `src/utils/url-helper.js`

`extractReelShortcode` ✅, `normalizeReelUrl` ✅, `cleanTrackingParams` ✅, `extractExternalUrls` ✅, `resolveDestinationUrl` (used by the network listener), `isWatermarkUrl` 💤, `REEL_REGEX`.

## Find it fast

| I want to change... | Go to |
|---|---|
| Who's allowed | `OWNER_USERNAME`, `config/index.js` |
| Keyword rules | `COMMENT_KEYWORD_PATTERNS`, `creator-interaction.js` |
| Pause between Reels | `startBatch`, `app.js` |
| The 48-hour rule | `UNFOLLOW_MIN_AGE_HOURS`, `app.js` |
| A button | `index.html`, `renderer.js` |
| Add a feature end to end | Core method → `registerIpc` → `preload.js` → `renderer.js` |
| A database column | `database.js`, `jobs.js` |
| Installer options | `build` in `package.json` |
| Which creator gets read | `fetchReelPublicData` |
| Restriction phrases | `RESTRICTION_INDICATORS` |
