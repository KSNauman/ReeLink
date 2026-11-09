# Chapter 19: Design decisions and trade-offs

Each decision lists the context, the choice, alternatives and the cost.

> Reasons come from code comments and older docs where available. Those marked *(inferred)* are my reading of the code.

---

## D1. Electron for the desktop shell
**Context.** A working Node core and a web dashboard existed. The goal was a double-click Windows app.
**Decision.** Electron.
**Alternatives.** *Tauri* gives much smaller binaries, but the UI talks to a Rust backend, so the Node core would need a sidecar. *.NET/WPF* would mean rewriting everything. *Packaging Node with pkg* would still need a browser tab for UI.
**Cost.** A large installer (124 MB) for a small app.
**Benefit.** Almost all core logic and the UI were reused, and Electron 45's Node 24 includes SQLite.

## D2. IPC instead of a local HTTP server
**Context.** The old server allowed any origin, had no auth, and listened on all interfaces.
**Decision.** Electron IPC.
**Alternatives.** Keep HTTP and bind to `127.0.0.1` with a token.
**Benefit.** Removes the attack surface instead of guarding it.

## D3. Run the core in the main process
**Decision.** No worker process or utility process.
**Reasoning.** The work is waiting on a browser, and SQLite calls are short. *(inferred)*
**Cost.** A long synchronous call would stall main-process IPC. None exists now.

## D4. On-demand batches instead of a daemon
**Context.** Era 2 polled every 15 seconds.
**Decision.** Run only when you click.
**Benefit.** Fewer actions against Instagram, nothing in the background, and a clear moment of intent.
**Cost.** Reels wait until you run a batch.

## D5. Close the browser after every task
**Decision.** Close in `finally`.
**Benefit.** "Nothing runs in the background" is literally true, and the profile is unlocked.
**Cost.** A few seconds' launch per task, and code had to handle dead pages (`_ensurePage`).

## D6. Use installed Edge
**Alternatives.** Bundling Chromium; requiring Chrome.
**Benefit.** Smaller installer, always present on Windows, a real browser identity. The fake user-agent could be removed.
**Cost.** The app depends on the user's Edge version, and non-Windows is out.

## D7. Manual login in a real browser
**Alternatives.** Store a username and password and automate login.
**Benefit.** The app holds no password, and 2FA works naturally.
**Cost.** A manual step when the session expires.

## D8. `node:sqlite` over `better-sqlite3`
**Benefit.** No native compilation, no ABI rebuild, one less dependency.
**Cost.** A young API with fewer features, and it requires Node 24 for tests.

## D9. One hardcoded owner
**Context.** It's a personal tool. An env-based allowlist had defaults and a special case.
**Benefit.** No misconfiguration can widen access. A packaged app can't be altered by a stray `.env`.
**Cost.** Another user needs a rebuild.

## D10. A single task lock
**Context.** Batch, unfollow and login all need the one browser and profile.
**Decision.** One `activeTask`, enforced in the core rather than the UI.
**Benefit.** Very simple, and impossible to bypass from the UI.

## D11. Read metadata from `/p/`, not `/reel/`
Per the code comment, `/reel/` leads to a multi-Reel feed. `/p/` guarantees one post, which prevents acting on the wrong creator.

## D12. Fail loudly when a scan fails
**Before.** An exception returned an empty list, which looked like "no new Reels".
**Decision.** Rethrow and show an error.
**Principle.** Never let a failure look like a valid empty result.

## D13. Additive schema, keep old columns
**Decision.** Add columns with safe `ALTER`s and don't remove any.
**Benefit.** An existing database opens without a migration risk.
**Cost.** Unused columns and a table.

## D14. Data in `%APPDATA%`
Installed apps can't write to Program Files or into asar. It's also the Windows convention, and it survives upgrades.

## D15. Comment-only: stop waiting for replies
**Context.** The bot once waited 5 minutes for each creator's DM.
**Decision.** Complete at the verified comment. The creator's DM arrives in the bot's inbox anyway.
**Benefit.** Batches take seconds per Reel, not minutes, and there's no fragile reply matching.
**Cost.** You read the replies yourself.

## D16. Delete the OCR, Whisper and search stack
**Context.** Already disconnected, and needing Python, FFmpeg and Tesseract.
**Benefit.** About 1,600 lines of production code and three external tools gone, making packaging realistic.
**Note.** Git keeps it if ever needed.

## D17. Separate columns for simulation
**Context.** A simulated run once made a later live run skip work, per the regression tests.
**Decision.** Simulated results get their own columns and a guard.

## D18. Disable DM commands with a flag instead of deleting
**Decision.** `commandsEnabled = false`. Command text is still recognised and skipped.
**Benefit.** A quick and safe change. `start` typed in the chat can never become a job.
**Cost.** About 450 lines of inactive code.

## D19. The core has no Electron imports
**Benefit.** Fast tests under plain Node, and a clean separation.
**How.** Paths come through environment variables, updates through an EventEmitter.

## D20. Push + periodic refresh for the UI
**Decision.** Events trigger refreshes, with a 5 s safety poll.
**Why not push full state?** A single `getStatus` call means one code path and one consistent snapshot.

## D21. No UI framework
A single page with a single update function doesn't justify React and a build step. *(inferred)*

---

## General themes

1. **Remove rather than guard.** No port beats a protected port. No password beats an encrypted password.
2. **Simple concurrency.** One browser, one task, one lock.
3. **State in the database, not memory.** Restarts are normal events.
4. **Uncertainty means no action.**
5. **Keep the core independent of the shell.**
