# Chapter 13: Security and account safety

## 13.1 Threat model

| Threat | Example | Defence |
|---|---|---|
| A stranger DMs the bot | Someone sends a Reel to make the bot follow them | Sender allowlist, fail closed |
| Malicious text from Instagram | A caption or username containing HTML | `esc()`, CSP, sandbox |
| A web page attacks the local app | A site calls your control API | No API or port exists |
| Compromise of the window | Injected script tries to reach Node | Sandbox, context isolation, tiny bridge |
| Credential leak | Password in a config file or log | No password handled; log redaction |
| The bot account gets flagged | Too many actions, too fast | Pacing, on-demand use, restriction checks |
| Accidental mass unfollow | Clicking the wrong button | 48-hour protection, confirmations |

## 13.2 The sender allowlist

File: [`src/security/sender-allowlist.js`](../../src/security/sender-allowlist.js)

**Why it matters:** the bot's DMs are open. Without this, anyone could make the bot follow and comment on demand.

`normalizeSenderUsername` trims, lowercases and strips `@`. It returns `null` for empty values and the strings `unknown`, `undefined`, `null`. `isSenderAllowed` then returns false for a null, an empty allowlist, or no match.

The word for this is **fail closed**: uncertainty means no.

### Layered checks

| # | Where | Stage label |
|---|---|---|
| — | `looksLikeOwnerThread` | Only chooses which chat to open. **Not a security check** |
| 1 | `checkThreadForReels` | `THREAD_CHECK`, on the real handle |
| 2 | `collectUnprocessedReels` | `COLLECT_UNPROCESSED` |
| 3 | `createJob({enforceAllowlist:true})` | `QUEUE_CREATE_JOB` |
| 4 | `processJob` | `PROCESS_JOB`, also covers retries |
| 5 | `recoverStalledJobs` | Covers restarts |
| 6 | `handleBotCommand` | Disabled commands, still guarded |

Rejections log `IGNORED_UNAUTHORIZED_SENDER` with no message content.

Why repeat the check? Defence in depth. If a future change opens a path around one layer, the others still hold. Layers 4 and 5 specifically protect rows that are already in the database.

## 13.3 Electron hardening

| Measure | Protects against |
|---|---|
| `contextIsolation: true` | Page code tampering with the preload |
| `nodeIntegration: false` | Page code using Node |
| `sandbox: true` | Compromised renderer reaching the OS |
| Narrow `contextBridge` API | Arbitrary IPC messages |
| `will-navigate` blocked | The window loading remote content |
| `setWindowOpenHandler` denies | New windows; only HTTPS goes to the default browser |
| Single-instance lock | Two copies corrupting state |

### Content-Security-Policy

```
default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'
```

- `script-src 'self'`: no inline or remote scripts. Even if HTML were injected, a script in it wouldn't run.
- `connect-src 'none'`: the page can't make any network request, so it can't send data out.
- `'unsafe-inline'` for styles is a small allowance for the existing inline styles.

## 13.4 What moving off HTTP fixed

The old server had:

```js
res.setHeader('Access-Control-Allow-Origin', '*');
// no authentication
this.server.listen(this.port);   // no host, so all interfaces
```

Any website you visited could send a request to `localhost:3000/api/unfollow`, and any device on your Wi-Fi could reach it. In the desktop app, there is **no listening socket at all**.

## 13.5 Credentials

- **The app never sees your password.** You type it into Edge.
- `IG_USERNAME` and `IG_PASSWORD` were removed from config.
- **`browser_profile\` is effectively a logged-in session.** Anyone with it can act as the bot. It is ignored by git and stays on your PC.

### Log redaction

`logger.js` hides sensitive data before writing it:

- In text: `password=`, `token=`, `secret=`, `key=`, `cookie=`, and `Bearer ...`.
- In objects: any key matching `password|secret|token|cookie|auth|session`.

## 13.6 Account safety

| Practice | Implementation |
|---|---|
| Separate bot account | Limits the risk to a throwaway account |
| Only runs on request | No constant background activity |
| Pacing | 5 to 7 s between Reels, 1.2 s between unfollows |
| Human-like typing | 60 ms per character in comments |
| Real browser, real login | No fake client |
| Restriction detection | Checks before and after actions |
| 48-hour rule | Avoids rapid follow/unfollow churn |

**Limits.** These reduce risk, they don't remove it. Automating actions is against Instagram's terms and the account can be restricted. Keep volume low.

## 13.7 Trade-offs to be aware of

- `--no-sandbox` is passed to Edge, weakening isolation for pages it visits. It looks like a carry-over from server-style setups.
- The installer isn't code-signed, so SmartScreen warns.
- The log file and database are plain files, protected only by your Windows account.
- Log and audit data grow without a limit.

## 13.8 Removed protections

SSRF protection (`validate-url.js`) was deleted because ReelLink no longer fetches arbitrary URLs. All navigation is to `instagram.com` paths built from validated shortcodes and usernames. If you ever add URL fetching back, the protection must come back too.
