# Chapter 20: Interview guide

## 20.1 Pitches

**15 seconds.**
> ReelLink is a Windows desktop app I built with Electron and Playwright. I share Instagram Reels to a bot account, click Start, and it follows each creator and comments the keyword they asked for, with verification and crash recovery.

**One minute.**
> Creators on Instagram gate resources behind "comment this keyword". Doing that by hand is tedious, and it clutters your personal account. So I built a tool where a separate bot account does it. I share Reels during the day, and when I click Start, the app reads my chat with the bot, verifies that I'm the sender, reads each Reel's creator and caption, follows the creator, confirms the follow really happened, and posts the keyword.
>
> It started as a Node daemon with OCR, Whisper and web search to find links automatically. Real use showed the simple path was the valuable one, so I removed about 3,800 lines and rebuilt it as an Electron app with an installer. There are no open ports, state is in SQLite so it survives crashes, and there are 103 automated tests.

**Architecture in two minutes.** Walk the layers in order:
> 1. The window is a sandboxed page, with five IPC calls exposed by a preload script.
> 2. The main process hosts the core, a plain Node EventEmitter with no Electron imports, which makes it testable with plain `node --test`.
> 3. The core has one lock, `activeTask`, because everything shares one browser.
> 4. Playwright drives installed Edge with a persistent profile, so I log in once by hand and the app never sees my password.
> 5. SQLite holds a job state machine with deduplication and crash recovery.
> 6. Each follow or comment is checked against the database first, so retries don't repeat actions.

## 20.2 Numbers you can defend

| Claim | Evidence |
|---|---|
| 103 automated tests, all passing | `npm test` |
| 8,597 lines in 17 source files | Chapter 3 |
| About 3,800 production lines removed | `git diff HEAD --stat` |
| Removed Python, FFmpeg, Tesseract | Chapter 3 |
| 124 MB installer | `dist/` |
| Zero listening ports | No server code |

**Don't claim** success rates, volumes, user counts or uptime. None were measured. The old docs' "23/23 tests" and latency targets are from a design that no longer exists.

**Resume bullets:**

- Built a Windows desktop automation app with Electron and Playwright, featuring a SQLite-backed job state machine with deduplication and crash recovery, covered by 103 automated tests.
- Re-architected a Node.js daemon into a click-to-run desktop app, replacing an unauthenticated localhost API with sandboxed IPC and deleting about 3,800 lines of unused pipeline code.
- Packaged an NSIS installer, using Node's built-in SQLite and the system browser to avoid native-module rebuilds and bundling Chromium.

## 20.3 Architecture questions

**Why Electron?**
I had a working Node core and a web UI, and Electron let me keep both. Tauri would have meant a much smaller binary, but my core would have needed a Node sidecar. The honest cost is 124 MB for a small tool.

**Main process vs renderer?**
Main has full Node access and owns windows. The renderer is a web page. Mine is sandboxed with context isolation, so a preload script exposes only named functions.

**Why not just keep the localhost dashboard?**
It sent `Access-Control-Allow-Origin: *`, had no auth, and listened on all interfaces. Any site I visited could have triggered an unfollow. IPC removes the socket altogether.

**How do UI updates work?**
The core emits an `update` event with no payload. The window then fetches a full snapshot. Events are coalesced with `requestAnimationFrame`, and a 5-second poll is the safety net. One snapshot means I can't draw inconsistent partial state.

**Why not run the core in a worker?**
The work is mostly waiting on the browser, and SQLite calls are small. A worker would add complexity with little benefit.

**How is the core testable?**
Constructor injection, and no Electron imports. Tests pass fake inbox and browser objects with a real SQLite temp file.

## 20.4 Concurrency and reliability

**How do you stop two tasks at once?**
`_beginTask` checks and sets `activeTask` with no `await` between. Node runs JavaScript on one thread, so nothing can interleave. It's enforced in the core, so the UI can't bypass it, and a test proves it.

**What happens if the app crashes mid-Reel?**
The job is saved as `EXTRACTING` or `INTERACTING`. On startup, `recoverStalledJobs` moves it to `PENDING`, re-checking the sender. On rerun, completed steps are skipped.

**Is it exactly-once?**
No, and it can't be. If Instagram accepts a comment and the app dies before the database write, a retry comments again. It's at-least-once with idempotency checks, which shrinks the window. True exactly-once would need Instagram to accept an idempotency key.

**How does deduplication work?**
The key is a generated message ID, because the web page has none. For a shared card, it combines thread, sender, a media ID from the preview image URL, and an occurrence counter. Deduplicating on the message rather than the Reel means re-sharing is a new request.

**Why SQLite? Why WAL?**
One user, one machine. WAL gives better crash behaviour and lets reads proceed during writes. I used `node:sqlite` so there's no native module to rebuild for Electron.

**How do schema changes work?**
`CREATE TABLE IF NOT EXISTS`, then `ALTER TABLE ADD COLUMN` in a try/catch. It's simple and additive, but with no version tracking. For a bigger app, I'd use numbered migrations.

## 20.5 Browser automation

**Why not the API?**
The official API needs a business account and app review, and unofficial clients risk bans. A real browser is the most realistic option for a personal tool, at the cost of being fragile.

**How do you handle changing selectors?**
Semantic selectors such as `aria-label`, `role` and URL patterns rather than class names. Multiple fallbacks. Exact text matches. It's still a maintenance burden, and I'm upfront about that.

**How do you know a follow worked?**
I poll for up to 5 seconds until the button says Following or Requested. If it doesn't change, the job fails and no comment is posted.

**Why `/p/` instead of `/reel/`?**
`/reel/` redirects to a feed of many Reels, so scraping could read a different Reel's data. `/p/` is one post. Getting that wrong would mean following the wrong person.

**How do you avoid getting banned?**
A separate account, on-demand use, 5 to 7 second pauses, human-like typing, restriction detection, and a 48-hour unfollow rule. These reduce risk but don't eliminate it.

## 20.6 Security

**What was your threat model?**
The bot's DMs are open to anyone, so the biggest risk is a stranger triggering actions. Next, untrusted text from Instagram rendering in my UI, then session theft.

**Explain "fail closed".**
If I can't read the sender's handle, the answer is no. The check runs at several stages, including on jobs in the database, so a restart can't get around it.

**How do you prevent XSS?**
Escaping all Instagram text before `innerHTML`, a CSP with `script-src 'self'` and `connect-src 'none'`, and a sandboxed renderer.

**Where's the password stored?**
It isn't. I type it into Edge. The profile folder does hold a live session, so it needs protecting like a credential.

## 20.7 Be ready for: "What's wrong with it?"

Offering this first is impressive.

1. **Keyword false positives.** "Comment your thoughts" posts "your". The fallback regex is too greedy.
2. **A restriction doesn't halt the batch.** It should stop immediately.
3. **No tests on the Electron layer**, and selectors are only tested on synthetic pages.
4. **Dead code** left from earlier eras, including about 450 lines of disabled DM commands.
5. **Fragile generated IDs** that depend on what's loaded in the page.

**What would you do next?**
Stop the batch on restriction, tighten keyword matching, baseline the first run, separate simulation data, remove dead code, add Playwright-driven Electron tests, and sign the installer.

## 20.8 Behavioural questions

> These stories are reconstructed from the code, its comments and its regression tests. Before using one, change the details to match what you actually remember. Interviewers follow up, and your real memory is what will hold up.

**A hard technical decision.**
> *Situation:* I had built an OCR, Whisper and search pipeline. *Task:* decide whether to keep investing in it. *Action:* I looked at what actually produced results and saw that the fallback, following and commenting, was the part that worked, since creators' links aren't usually public. I disconnected the pipeline, then deleted it. *Result:* three external dependencies gone, and packaging as a desktop app became realistic.

**A bug you found.**
> The bot sometimes read the wrong creator, because Instagram's `/reel/` links had begun redirecting to a scrolling feed. I switched to the `/p/` single-post page, and limited my fallback to links within the post. I also added a guard so that with no creator, no action is taken.

Another option: a batch with a failed inbox scan reported "no new Reels". I made the scan rethrow, so a failure looks like a failure.

**Something you'd do differently.**
> I'd have started with the simplest thing that could work, tried it on real Reels, and only then added complexity.

**Handling simulation bugs.**
> A simulated run once caused a later real run to skip work, because both shared the same status columns. I gave simulation separate columns and a hard guard, plus regression tests.

## 20.9 Ethics

**Isn't this against Instagram's terms?**
Yes. Automating follows and comments breaks the terms, and the README says so. It's a personal tool, at low volume, on a separate account, and I wouldn't offer it as a product. What I'd highlight is the engineering: state management, verification and security, which apply to any automation.

## 20.10 Rapid-fire facts

| Question | Answer |
|---|---|
| Language | JavaScript, CommonJS |
| Electron / Node / Chromium | 45.2.3 / 24.22.2 / 156 |
| Playwright | 1.64.1 |
| Database | SQLite via `node:sqlite`, WAL |
| Test runner | `node:test` |
| Installer | electron-builder, NSIS |
| IPC channels | 5 requests + 1 update event |
| Tables | 5 (`jobs`, `creator_interactions`, `processed_messages`, `audit_logs`, `candidates`) |
| Unfollow window | 48 hours |
| Delay between Reels | 5 to 7 s |
| Follow verification | up to 5 s |
| Max attempts | 4 by default |
| Fallback comment | 🙌 |
| Data location | `%APPDATA%\ReelLink` |
| Open ports | None |
