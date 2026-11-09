# The ReelLink Textbook

The complete guide to ReelLink: what it is, how it started, what changed, how every part works, how to run it, and how to talk about it in an interview.

**If you read this book, you should not need to open the code to explain the project.** When you do want the code, every chapter links to the exact files.

---

## Before you start

| Fact | Value |
|---|---|
| What it is | A personal Windows desktop app that automates "follow + comment" on Instagram Reels you share to a bot account |
| Started as | A Node.js background bot with a local web dashboard |
| Is now | An Electron desktop app with an installer (`ReelLink Setup 0.1.0.exe`) |
| Language | JavaScript (CommonJS) on Node 24 |
| Key tech | Electron 45, Playwright 1.64, built-in `node:sqlite`, WebGL, electron-builder (NSIS) |
| Size | 8,597 lines in 17 source files |
| Tests | 103 tests, all passing (`npm test`, run 2026-11-09) |
| Written | 2026-11-09, from the code in the working tree on that date |

> **Important: the desktop conversion is not committed yet.** The repo has one commit (`e13d524`, 2026-11-07), which is the web-dashboard version. The whole desktop app exists as uncommitted changes. See [Chapter 3](03-what-changed.md).

> **The older files in `docs/` are out of date.** `docs/PROJECT_TEXTBOOK.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `ROADMAP.md`, `STATUS_REPORT.md`, `TESTING.md` and `TROUBLESHOOTING.md` describe the first design (OCR, Whisper, web search, DM replies), most of which no longer exists. Use them only as history. If they disagree with this book, this book is right.

---

## Table of contents

### Part I: The story
1. [Introduction: what ReelLink is and why it exists](01-introduction.md)
2. [Project history: three eras](02-project-history.md)
3. [What changed, where, and why](03-what-changed.md)

### Part II: Architecture
4. [System architecture](04-architecture.md)
5. [The Electron shell: main process, preload, IPC](05-electron-shell.md)
6. [The user interface](06-user-interface.md)
7. [The core orchestrator (`src/app.js`)](07-core-orchestrator.md)

### Part III: Subsystems
8. [Instagram automation: browser, login, inbox scanning](08-instagram-automation.md)
9. [Reading Reels: metadata and keyword extraction](09-caption-and-keywords.md)
10. [The follow-and-comment workflow](10-follow-comment-workflow.md)
11. [The unfollow manager and the 48-hour rule](11-unfollow-manager.md)
12. [The data layer: SQLite, queue, state machine](12-data-layer.md)
13. [Security and account safety](13-security-and-safety.md)

### Part IV: Running it
14. [Configuration reference](14-configuration.md)
15. [Build and packaging](15-build-and-packaging.md)
16. [Testing](16-testing.md)
17. [Operations runbook and troubleshooting](17-operations-runbook.md)

### Part V: Going deeper
18. [Known issues and dead code (an honest audit)](18-known-issues-and-dead-code.md)
19. [Design decisions and trade-offs](19-design-decisions.md)
20. [Interview guide](20-interview-guide.md)
21. [Code reference: every module and function](21-code-reference.md)
22. [Glossary](22-glossary.md)

---

## How to read this book

**I have one hour before an interview.** Read chapters [1](01-introduction.md), [4](04-architecture.md), [20](20-interview-guide.md), then the top of [18](18-known-issues-and-dead-code.md).

**I want to understand the project properly.** Read chapters 1 to 13 in order. It is about three hours.

**I need to change something.** Start at [21](21-code-reference.md) to find the function, read that subsystem's chapter, then check [16](16-testing.md) for which tests cover it.

**Something is broken.** Go to [17](17-operations-runbook.md).

**I need to explain what changed from the old version.** Go to [3](03-what-changed.md).

---

## How this book was checked

- All current source files were read in full, and the old versions were compared using `git diff HEAD`.
- `npm test` was run: 103 passed, 0 failed.
- The Electron runtime was queried directly (Node 24.22.2, Chromium 156, `node:sqlite` present).
- Behaviour claims in Chapter 18 marked **verified** were run against the real modules on a temporary database.

**What was not tested:** nothing in this book was exercised against the live Instagram website. Statements about how Instagram's pages behave come from the code and its comments. The reasons behind decisions come from code comments and the older docs; where a reason is my inference, the chapter says so.
