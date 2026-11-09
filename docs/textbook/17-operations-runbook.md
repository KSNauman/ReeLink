# Chapter 17: Operations runbook

## 17.1 First-time setup

**Needed:** Windows 10 or 11, Microsoft Edge, a separate Instagram account for the bot.

1. Run the installer.
2. Open ReelLink and click **Log in**.
3. Sign in to the **bot** account (not your personal one) in the Edge window. Complete any 2FA. It closes by itself on reaching the home feed.
4. From your personal account (`@ksydn_`), send at least one message to the bot so a chat exists.

## 17.2 Before your first batch

The first batch treats **every Reel currently visible in the chat** as new. If the chat already has old shares, ReelLink will follow and comment on all of them. For a clean start, begin with a new or empty conversation, or run the first batch with only Reels you want handled.

## 17.3 Daily use

1. Share Reels to the bot through the day.
2. Open ReelLink, confirm the tag says **LIVE**, click **Start batch**.
3. Leave the Edge window alone while it runs. Clicking in it can disturb the automation.
4. Later, check the bot's inbox for creator replies.
5. Every few days, click **Unfollow eligible (48h+)**.

Suggested limit: keep batches small. No specific safe number is known.

## 17.4 Where to look

| Need | Place |
|---|---|
| What's happening now | Activity Log in the window |
| Details after a problem | `%APPDATA%\ReelLink\reellink.log` |
| A job's history | `audit_logs` table ([Chapter 12](12-data-layer.md)) |

Open the data folder:

```powershell
explorer "$env:APPDATA\ReelLink"
```

Watch the log live:

```powershell
Get-Content "$env:APPDATA\ReelLink\reellink.log" -Wait -Tail 30
```

## 17.5 Troubleshooting

### Messages in the Activity Log

| Message | Meaning | Fix |
|---|---|---|
| `Instagram is not logged in. Click "Log in" first.` | Session missing or expired, or a challenge page appeared | Click **Log in** |
| `Could not find the chat with @ksydn_ in the inbox (N chats visible).` | Your chat isn't in the list, or the display name differs | Send the bot a new message. Check `OWNER_DISPLAY_NAME` |
| `No pending Reels to process.` | Nothing new | Share a new Reel in a new message |
| `Could not read the creator from the Reel page` | Post unavailable, or Instagram changed the page | Check the Reel opens. Share it again later |
| `Follow button not found on creator profile` | Page layout changed or didn't load | Share again. If frequent, selectors need updating |
| `Follow verification failed...` | Clicked, but the button never changed | Possibly throttled. Pause for a while |
| `Instagram restriction challenge detected: ...` | **Instagram is limiting the account** | **Stop using it for at least a day** |
| `Comment input field not found on Reel/Post page` | Comments off, or layout changed | Open the Reel manually |
| `Comment submission verification failed...` | Comment may not have posted | Check on Instagram |
| `Busy: batch is already running` | Another task is active | Wait |
| `IGNORED_UNAUTHORIZED_SENDER` (log file) | A chat failed the owner check | Normal for strangers. If it's you, the handle couldn't be read |

### Other problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser doesn't open, error mentions `msedge` | Edge is missing or was removed | Install Edge, or set `IG_BROWSER_CHANNEL=chrome` when running from source |
| Profile is "in use" | Leftover Edge from a crash | Close ReelLink, end stray `msedge` processes using that profile, try again |
| SmartScreen blocks the installer | Not signed | More info → Run anyway |
| A Reel marked FAILED | Final state | Share that Reel again in a new message |
| Reel never picked up | Too far up the chat, not loaded | Run batches more often |
| Window plain, no animation | WebGL unavailable | Cosmetic only |
| Tag says SIMULATION | Started with `--simulate` | Start normally |

## 17.6 Recovering

**Interrupted batch.** Just reopen. Jobs are recovered and picked up on the next Start.

**Log in again from scratch.** Quit, delete `%APPDATA%\ReelLink\browser_profile`, reopen, Log in.

**Fresh start (caution).** Deleting `reellink.db*` erases the record of seen Reels, so the next batch **will reprocess everything visible and comment again**. It also loses the creator list that unfollowing relies on. Back it up first.

```powershell
Copy-Item "$env:APPDATA\ReelLink\reellink.db*" "$env:USERPROFILE\Desktop\"
```

## 17.7 Backup

With the app closed, copy `reellink.db`, `reellink.db-wal` and `reellink.db-shm` together. The WAL file can hold data not yet in the main file.

## 17.8 Maintenance

- `reellink.log` and `audit_logs` grow without limit. Delete the log file when large; it's recreated.
- Delete old `data\test_*.db` files in the repo.

## 17.9 When Instagram changes

The most likely breakage. Look for repeated errors in one stage:

| Failing stage | File to change |
|---|---|
| Finding chats | `_extractThreadsFromPage`, `inbox.js` |
| Reading the sender | `senderIdentity` in `checkThreadForReels` |
| Detecting cards | `clipCards` in `checkThreadForReels` |
| Creator or caption | `fetchReelPublicData`, `extract-reel.js` |
| Follow | `_findFollowButton`, `creator-interaction.js` |
| Comment | `executeComment` |
| Unfollow | `unfollowCreatorDirect`, `inbox.js` |

Set `LOG_LEVEL=debug` and run from source to see more, with the Edge window visible.
