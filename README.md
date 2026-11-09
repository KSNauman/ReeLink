# ReelLink

A personal Windows desktop app. Share Reels to your bot account on Instagram during the day; when you're ready, open ReelLink and click **Start**. For each new Reel it:

1. follows the creator,
2. comments the keyword from the caption (or 🙌 if there isn't one),
3. records it in a local tracker,
4. collects the links creators send back, saves them to a spreadsheet and DMs you a short summary,
5. unfollows creators followed 48 or more hours ago (at most 25 per run; the rest wait for the next run). Sharing a new Reel from a creator restarts their 48 hours.

Nothing runs until you click. The browser opens for a batch and closes when it's done.

## Getting your links

Every **Start batch** ends by checking replies, including late replies to earlier Reels. If it processed new Reels, it first waits 20 seconds, with a countdown, so fast replies are caught in the same run.

- **Spreadsheet:** `Documents\ReelLink\ReelLink_Resources.csv` (the **Links CSV** button opens it). It's rebuilt in full each run. If Excel has it open, that run is saved to `ReelLink_Resources_latest.csv` and the main file catches up next time.
- **Instagram DM:** one summary in your chat with the bot, only when there's something new.

| Status | Meaning |
|---|---|
| Link received | The creator sent a link. |
| Waiting | No link yet; checked again on each run. |
| Needs you | The creator wants a button tapped, or replied without a link. Open their chat on the bot account. |
| No reply | Nothing after 3 days. |

## Who it works for

Only Reels sent by **@ksydn_** are processed. That's hardcoded in [`src/config/index.js`](src/config/index.js) (`OWNER_USERNAME`). Change that one line if your handle changes; every other sender is ignored.

## Install

Build the installer once:

```powershell
npm install
npm run dist
```

Then run `dist\ReelLink Setup 0.1.0.exe`. Windows SmartScreen will warn once because the app isn't code-signed; choose **More info → Run anyway**.

## Tray icon

ReelLink lives in the Windows tray, by the clock. **Left-click** the icon to run a batch: it turns orange while working, hovering shows progress, and a notification gives the result. **Right-click** for Stop, Open ReelLink, Open links CSV, Log in, Start with Windows and Quit.

Closing the window keeps the tray icon running; use **Quit ReelLink** to exit. To keep the icon visible instead of under the `^` arrow, drag it onto the taskbar.

## First run

1. Click **Log in**. An Edge window opens on Instagram; sign in to the **bot** account. It closes by itself once you reach the home feed. The login is saved.
2. Click **Start batch**.

## Buttons

| Button | What it does |
|---|---|
| **Start batch** | Scans your DM thread with the bot for new Reels, then follows + comments each one with a 5–7 s pause between Reels. |
| **Stop** | Stops after the Reel in progress. |
| **Unfollow eligible (48h+)** | Unfollows creators followed at least 48 hours ago. Creators followed more recently are always kept. |
| **Force unfollow all** | Unfollows every tracked creator, including recent ones (asks to confirm). |
| **Log in** | Signs in to (or refreshes) the bot's Instagram session. |

Only one of these runs at a time.

## Where data lives

`%APPDATA%\ReelLink\`:

- `reellink.db`: the tracker (SQLite)
- `browser_profile\`: the saved Instagram login
- `reellink.log`: log file for troubleshooting

## Development

```powershell
npm start            # run the app from source (LIVE)
npm run start:sim    # run without posting anything (simulated follows/comments)
npm test             # unit + integration tests
```

Requires Node 24+ and Microsoft Edge (preinstalled on Windows).

### Layout

```
desktop/main.js        Electron main process: window + IPC handlers
desktop/preload.js     the only API the window can call (window.reellink)
desktop/renderer/      the UI (HTML/CSS, shader background, renderer.js)
src/app.js             core: startBatch, stopBatch, unfollow, login, getStatus
src/instagram/         Playwright session, DM inbox scanning, sender
src/pipeline/          Reel metadata + follow/comment workflow
src/queue/jobs.js      job queue and creator tracker (SQLite)
```

## Documentation

The full guide is [The ReelLink Textbook](docs/textbook/README.md): history, what changed, architecture, every subsystem, operations, known issues and an interview guide.

The other files directly in `docs/` describe the original OCR/search design and are kept only as history.

## Note

Automating follows and comments is against Instagram's terms. Keep volume low; the bot account can still be rate-limited or flagged.
