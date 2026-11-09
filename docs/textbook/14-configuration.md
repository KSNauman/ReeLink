# Chapter 14: Configuration reference

File: [`src/config/index.js`](../../src/config/index.js)

**Normal use needs no configuration.** Install, log in, click Start.

## 14.1 Settings in the code

| Setting | Location | Value |
|---|---|---|
| Owner handle | `OWNER_USERNAME`, `config/index.js` | `ksydn_` |
| Owner display name | `OWNER_DISPLAY_NAME`, `config/index.js` | `Naumannn` |
| Unfollow window | `UNFOLLOW_MIN_AGE_HOURS`, `app.js` | 48 hours |
| Delay between Reels | `startBatch`, `app.js` | 5 to 7 s |
| Delay between unfollows | `unfollow`, `app.js` | 1.2 s |
| Bot's handle prefix | `inbox.js`, `extract-reel.js` | `dolphin.` |
| Login timeout | `interactiveLogin` | 10 minutes |
| Inbox ready timeout | `_waitForInboxReady` | 20 s |
| Chats scanned | `collectUnprocessedReels` | up to 5 |
| Activity log | `_addLog`, `getStatus` | 200 kept, 60 shown |
| Recent Reels table | `getStatus` | 8 |

### To change the owner

Edit **both** `OWNER_USERNAME` and `OWNER_DISPLAY_NAME`. The handle authorises; the display name finds the chat in the inbox list. Then update tests that assert the old name and rebuild.

### If the bot account changes

Search for `dolphin.`. It appears in `inbox.js` and `extract-reel.js`, and it filters out the bot's own messages.

## 14.2 Environment variables

`dotenv` loads a `.env` file from the **current working directory**. Copy `.env.example` to `.env` when developing.

| Variable | Default | Effect | Works from `.env`? |
|---|---|---|---|
| `IG_BROWSER_CHANNEL` | `msedge` | Browser to use, e.g. `chrome` | ✅ |
| `IG_HEADLESS` | `false` | Hide the browser | ✅ |
| `JOB_MAX_RETRIES` | `3` | Retries per job | ✅ |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` | ✅ |
| `DATABASE_PATH` | `<data>\reellink.db` | Override the DB location | ✅ |
| `CREATOR_FOLLOW_TIMEOUT_MS` | `5000` | Time to verify a follow | ✅ |
| `REELLINK_SIMULATION` | `false` | Simulation mode | ❌ Real environment only |
| `REELLINK_DATA_DIR` | `%APPDATA%\ReelLink` | Data folder | ❌ Real environment only |
| `REELLINK_NO_LOG_FILE` | unset | Disables the log file | ✅ |
| `NODE_ENV` | `development` | Stored only | ✅ |
| `DRY_RUN` | `false` | Fakes DMs; the desktop flow sends none | ✅, no visible effect |

**Why the two ❌?** `desktop/main.js` reads them before any module loads `dotenv`. `.env.example` lists `REELLINK_SIMULATION`, which is misleading. Use `npm run start:sim` or set it in the shell.

**In the installed app**, the working directory depends on how it was launched, so don't rely on `.env` there.

**Overridden or unused:** `CREATOR_WORKFLOW_ENABLED`, `CREATOR_WORKFLOW_SIMULATION` and `CREATOR_WORKFLOW_REQUIRE_APPROVAL` are overridden by the app's constructor. `CREATOR_WORKFLOW_TIMEOUT_SEC`, `CREATOR_INITIAL_WAITING_WINDOW_SEC`, `CREATOR_INBOX_POLL_INTERVAL_MS` and `CREATOR_BACKGROUND_POLL_INTERVAL_SEC` only affect retired code.

## 14.3 Launch modes

| Command | Mode | Data |
|---|---|---|
| Installed app | LIVE | `%APPDATA%\ReelLink` |
| `npm start` | LIVE | Same folder |
| `npm run start:sim` | SIMULATION | Same folder (see the warning below) |

### Using a separate data folder for experiments

Simulated runs write to the same database as live runs. To keep them apart:

```powershell
$env:REELLINK_DATA_DIR = "C:\ReelLink\scratch\sim-data"; npm run start:sim
```

## 14.4 Package scripts

| Script | Command | Purpose |
|---|---|---|
| `npm start` | `electron .` | Run from source (LIVE) |
| `npm run start:sim` | `electron . --simulate` | Run without posting |
| `npm run dist` | `electron-builder --win nsis` | Build the installer |
| `npm test` | `node --test tests/unit/*.js tests/integration/*.js` | All tests |
| `npm run test:unit` | | Unit only |
| `npm run test:integration` | | Integration only |
