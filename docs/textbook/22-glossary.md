# Chapter 22: Glossary

## ReelLink terms

| Term | Meaning |
|---|---|
| **Active task** | What currently holds the browser: `BATCH`, `UNFOLLOW`, `LOGIN` or none |
| **Allowlist** | The list of permitted senders; here, only the owner |
| **Audit log** | The `audit_logs` table of job changes |
| **Baseline** | Marking existing messages as seen, without acting on them. Exists in code but isn't used now |
| **Batch** | One run of scanning and processing, started by Start |
| **Bot account** | The Instagram account ReelLink signs in to |
| **Clip card** | The rich preview shown when a Reel is shared in a DM |
| **Comment-only workflow** | Finish when the comment is verified; don't wait for replies |
| **Core** | `ReelLinkApp` and everything under `src/` |
| **Creator** | The person who posted the Reel |
| **Eligible** | Followed at least 48 hours ago, so can be unfollowed |
| **Follow-first** | Always follow before commenting |
| **Job** | One Reel to process |
| **Keyword** | The word the caption asks you to comment |
| **Live mode** | Real actions on Instagram |
| **Message ID** | The deduplication key ReelLink generates for a message |
| **Occurrence** | The count distinguishing repeat shares of one Reel |
| **Owner** | `@ksydn_`, the only authorised sender |
| **Protected** | Followed less than 48 hours ago |
| **Shortcode** | The Reel's ID in its URL |
| **Simulation mode** | The full flow with follows, comments and unfollows only recorded |
| **Thread** | An Instagram DM conversation |
| **🙌** | The fallback comment |

## Electron

| Term | Meaning |
|---|---|
| **asar** | Electron's archive format for app code |
| **Context isolation** | Keeps page JavaScript separate from preload JavaScript |
| **contextBridge** | Safely exposes functions from preload to the page |
| **IPC** | Inter-process communication: messages between processes |
| **Main process** | The one Node.js process that owns the app and windows |
| **Native module** | A compiled add-on tied to a specific runtime ABI |
| **NSIS** | The Windows installer system used here |
| **Preload script** | Runs before the page, can see both sides |
| **Renderer process** | Runs a web page |
| **Sandbox** | OS-level restriction on a renderer |
| **userData** | The per-app data folder: `%APPDATA%\<app>` |

## Browser automation

| Term | Meaning |
|---|---|
| **Channel** | Which installed browser Playwright uses, e.g. `msedge` |
| **Headless / headful** | Without / with a visible window |
| **Persistent context** | A session that saves cookies and storage to a folder |
| **Playwright** | The library that controls browsers |
| **Selector** | A pattern for finding page elements |
| **Semantic selector** | One based on meaning, e.g. `aria-label`, rather than styling |

## Database

| Term | Meaning |
|---|---|
| **Idempotent** | Safe to repeat; the same result however many times |
| **Migration** | A change that upgrades an existing schema |
| **`node:sqlite`** | The SQLite module built into Node |
| **State machine** | A set of statuses with defined moves between them |
| **WAL** | Write-Ahead Logging: changes go to a log first, for better crash safety and concurrency |

## Security

| Term | Meaning |
|---|---|
| **CORS** | Browser rules for cross-site requests |
| **CSP** | Content-Security-Policy: limits what a page may load or run |
| **Defence in depth** | Multiple independent layers of protection |
| **Fail closed** | When uncertain, deny |
| **SSRF** | Tricking a server into requesting internal addresses |
| **XSS** | Injecting script into a page through untrusted text |

## Reliability

| Term | Meaning |
|---|---|
| **At-least-once** | An action may repeat in rare failures, but won't be lost |
| **Exactly-once** | An action happens exactly one time; needs cooperation from both systems |
| **Mutex** | A lock allowing only one user at a time |
| **Recovery** | Resuming interrupted jobs at startup |

## Graphics

| Term | Meaning |
|---|---|
| **Fragment shader** | GPU code that colours each pixel |
| **OKLab** | A colour space designed to match human perception |
| **WebGL** | Browser API for GPU graphics |

## Instagram automation world

| Term | Meaning |
|---|---|
| **CTA** | Call to action, e.g. "Comment GUIDE" |
| **ManyChat** | A popular tool that DMs people who comment a keyword |
| **Challenge / checkpoint** | Instagram's identity check page |
| **Action blocked** | Instagram's message when an account is rate-limited |
