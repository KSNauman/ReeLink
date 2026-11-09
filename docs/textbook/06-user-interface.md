# Chapter 6: The user interface

Files: [`index.html`](../../desktop/renderer/index.html), [`renderer.js`](../../desktop/renderer/renderer.js), [`shader.js`](../../desktop/renderer/shader.js)

## 6.1 Layout, top to bottom

| Section | Elements | IDs |
|---|---|---|
| Header | App name, LIVE/SIMULATION tag, Log in, status pill | `mode-tag`, `btn-login`, `status-dot`, `status-text` |
| Action card | Start button, Stop button, progress bar | `btn-start`, `btn-text`, `btn-stop`, `progress-box`, `progress-fill`, `progress-text` |
| Metrics | Pending Queue, Total Completed | `metric-pending`, `metric-completed` |
| Recent Reels | Table of creator, keyword, status (last 8) | `reels-tbody` |
| Unfollow | Eligible/protected counts and two buttons | `unfollow-summary`, `btn-unfollow-eligible`, `btn-unfollow-all` |
| Activity Log | Scrolling console (last 60 lines) | `console-box` |

There is no framework. The whole UI is one function, `updateUI(data)`, that sets the page from a snapshot.

## 6.2 The rendering model

The UI holds almost no state of its own. It follows one loop:

1. Something changes in the core, and it emits `'update'`.
2. Main forwards `reellink:update` to the window.
3. `scheduleRefresh()` queues one refresh per animation frame.
4. `refresh()` calls `getStatus()`.
5. `updateUI(data)` redraws everything.

Two details:

- **Coalescing.** A burst of events produces one refresh, because of `refreshQueued` and `requestAnimationFrame`.
- **Safety net.** `setInterval(refresh, 5000)` keeps the page correct if an event is missed.

This replaced polling `/api/status` every 1.5 seconds.

## 6.3 The status snapshot

`getStatus()` returns:

```js
{
  owner, status, activeTask, isBatchRunning, isLiveMode,
  batchProgress: { current, total, currentJob, summary },
  queue: { pending, processing, completed, failed, total },
  recentJobs,       // last 8 with creator and keyword
  unfollowOverview, // { eligible: [...], protected: [...], all: [...] }
  recentLogs,       // last 60 of up to 200
  lastLogin, uptime
}
```

## 6.4 How status becomes pixels

Checked in this order:

| Condition | Pill text | Dot | Progress |
|---|---|---|---|
| `activeTask === 'LOGIN'` | Waiting for login... | amber, pulsing | unchanged |
| `activeTask === 'UNFOLLOW'` | Unfollowing... | amber, pulsing | unchanged |
| `status === 'SCANNING_INBOX'` | Scanning... | amber, pulsing | 20%, "Scanning inbox..." |
| `status === 'PROCESSING'` | Processing (n/total) | blue, pulsing | n/total as a percentage, capped at 100 |
| `status === 'COMPLETED'` | Completed | green | 100% with summary |
| `status === 'ERROR'` | Error | red | error summary |
| otherwise | Ready | green | hidden |

**Button rules:** when `activeTask` is set, Start, Log in and both Unfollow buttons are disabled. Stop appears only for a `BATCH`. The disabling is only for clarity; the real guard is `_beginTask()` in the core.

## 6.5 Handling untrusted text

Usernames, keywords and log text come from Instagram, and the table uses `innerHTML`. Without protection, a creator named with HTML could inject content. So all such values go through:

```js
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
```

The CSP is a second layer ([Chapter 13](13-security-and-safety.md)).

## 6.6 Button handlers

| Function | Confirmation | Then |
|---|---|---|
| `handleStartBatchClick` → `triggerBatch` | None; plays the ripple effect | Awaits the batch; alerts on error |
| `stopBatch` | "Stop after the Reel currently in progress?" | Refreshes |
| `login` | Information alert first | Alerts the result |
| `unfollowEligible` | "Unfollow creators you followed at least 2 days ago?" | Alerts the result |
| `unfollowAll` | A ⚠️ warning that recent follows are included | Alerts the result |

Buttons are wired with `addEventListener` because the CSP forbids inline `onclick`.

## 6.7 Auto-scrolling log

```js
const atBottom = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 40;
// ...redraw...
if (atBottom) consoleBox.scrollTop = consoleBox.scrollHeight;
```

It follows new lines only if you were already at the bottom, so it won't pull you away while you read older lines.

## 6.8 The WebGL effects

`shader.js` holds two independent WebGL programs. Neither affects functionality. If WebGL is unavailable they simply exit.

### Background: "Mesh Drift"

A fullscreen animated colour field on `#shader-canvas`.

- Uses one oversized triangle, `(-1,-1), (3,-1), (-1,3)`, which covers the screen with less overhead than two triangles.
- Up to 8 colour blobs move on sine paths. Each pixel is a weighted average based on distance (`exp(-d² × 6)`).
- Then contrast, saturation, vignette and film grain.
- Colours are blended in **OKLab**, a perceptual colour space, which avoids muddy mixes.
- A soft glow follows the cursor, smoothed with `1 - exp(-12 × dt)` so it stays independent of frame rate.

Efficiency measures: requests a `low-power` GPU, limits canvas size to 2 million pixels and device ratio to 2, and stops rendering when the window is hidden.

### Start button: "Liquid Metal"

A chrome-like surface on `#lm-shader-canvas`.

- Four iterations of sine/cosine domain warping create the flowing shape.
- A surface normal from the warped coordinates gives diffuse and specular lighting.
- A slight emerald tint is added.

`setLmSpeed()` makes it responsive:

| Event | Speed |
|---|---|
| Idle | 0.6 |
| Hover | 1.2 |
| Click | 2.4, back to 1.0 after 380 ms |

The button is four stacked layers using CSS `translateZ`: shader, dark inner pill, label, and a transparent real `<button>` on top that receives clicks.

## 6.9 Styling

CSS variables on `:root` define the palette, radii and shadows. Cards are translucent with `backdrop-filter: blur(16px)`, so the animated background shows through. Fonts are Plus Jakarta Sans and JetBrains Mono from Google Fonts. Offline, they fall back to system fonts, and the app still works.
