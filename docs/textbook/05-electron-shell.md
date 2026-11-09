# Chapter 5: The Electron shell

Files: [`desktop/main.js`](../../desktop/main.js), [`desktop/preload.js`](../../desktop/preload.js)

## 5.1 Electron in 60 seconds

Electron combines Chromium (to draw a window) and Node.js (to access the computer). An app has at least two kinds of process:

| Process | Count | Can do | In ReelLink |
|---|---|---|---|
| **Main** | One | Everything Node can do; creates windows | `main.js` and the entire core |
| **Renderer** | One per window | Web page things only (when sandboxed) | `index.html`, `renderer.js`, `shader.js` |

They communicate through **IPC** (inter-process communication), which is message passing. A **preload script** runs before the page loads, and it is the only code that can see both worlds.

## 5.2 Startup order, and why it matters

Reading `main.js` from the top:

```js
// Must be set before any src/ module loads config.
process.env.REELLINK_DATA_DIR = process.env.REELLINK_DATA_DIR || app.getPath('userData');
const isSimulation = process.argv.includes('--simulate') || process.env.REELLINK_SIMULATION === 'true';
```

`src/config/index.js` reads `REELLINK_DATA_DIR` the moment it is first loaded. So this line must run first, and the core is loaded later, inside `whenReady`:

1. Set the data directory.
2. Decide the mode (live or simulation).
3. Request the single-instance lock. If another copy is running, quit.
4. When Electron is ready: `require('../src/app')`, construct the core, call `core.init()`.
5. Register the IPC handlers.
6. Create the window.
7. Forward the core's `'update'` events to the window.

> **Side effect to know:** because step 2 runs before `dotenv` loads, `REELLINK_SIMULATION` in a `.env` file has no effect. See [Chapter 18](18-known-issues-and-dead-code.md).

## 5.3 Single instance

```js
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { /* restore and focus the window */ });
```

Two copies would fight over the same browser profile and database. A second launch simply focuses the first window.

## 5.4 The window

```js
new BrowserWindow({
  width: 1100, height: 860, minWidth: 720, minHeight: 600,
  title: 'ReelLink', backgroundColor: '#090d16', autoHideMenuBar: true,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});
```

| Setting | Meaning |
|---|---|
| `contextIsolation: true` | The page's JavaScript and the preload's run in separate worlds |
| `nodeIntegration: false` | No `require` or Node access in the page |
| `sandbox: true` | The renderer runs inside Chromium's OS sandbox |
| `backgroundColor` | Prevents a white flash while loading |
| `Menu.setApplicationMenu(null)` | Removes the File/Edit menu |

Two navigation locks follow:

```js
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
  return { action: 'deny' };
});
mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
```

The window can never navigate away from the local page, and it can never open another Electron window. HTTPS links go to your default browser.

## 5.5 The IPC contract

This table is the full interface between the UI and the core.

| Channel | Direction | Handler | Returns |
|---|---|---|---|
| `reellink:status` | Renderer → Main | `core.getStatus()` | Status snapshot |
| `reellink:start` | Renderer → Main | `core.startBatch({triggeredBy:'DESKTOP'})` | `{success, processedCount, message?, error?}` when the batch ends |
| `reellink:stop` | Renderer → Main | `core.stopBatch()` | `true` or `false` |
| `reellink:unfollow` | Renderer → Main | `core.unfollow({forceAll})` | `{success, count, unfollowed, failed, protectedCount, message}` |
| `reellink:login` | Renderer → Main | `core.login()` | `{authenticated, reason}` |
| `reellink:update` | Main → Renderer | core's `'update'` event | No data |

`invoke`/`handle` is a request-response pair that returns a promise. Note that `reellink:start` stays pending for the whole batch; progress arrives through update events meanwhile.

## 5.6 The preload bridge

```js
contextBridge.exposeInMainWorld('reellink', {
  getStatus: () => ipcRenderer.invoke('reellink:status'),
  startBatch: () => ipcRenderer.invoke('reellink:start'),
  stopBatch: () => ipcRenderer.invoke('reellink:stop'),
  unfollow: (opts) => ipcRenderer.invoke('reellink:unfollow', { forceAll: Boolean(opts && opts.forceAll) }),
  login: () => ipcRenderer.invoke('reellink:login'),
  onUpdate: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('reellink:update', listener);
    return () => ipcRenderer.removeListener('reellink:update', listener);
  },
});
```

Design points:

- The page gets **named functions**, not raw `ipcRenderer`. Compromised page code still cannot send arbitrary messages.
- `forceAll` is sanitised **twice**: `Boolean(...)` here and `opts.forceAll === true` in `main.js`. A destructive option should be hard to enable by accident.
- `onUpdate` wraps your function, so the Electron event object never reaches the page.
- It returns an unsubscribe function.

## 5.7 Shutdown

```js
app.on('window-all-closed', () => { app.quit(); });

app.on('before-quit', (e) => {
  if (quitting || !core) return;
  e.preventDefault();
  quitting = true;
  core.shutdown().finally(() => app.quit());
});
```

`shutdown()` is asynchronous, but Electron won't wait for a promise. So the first quit is cancelled, cleanup runs, and quit is called again. The `quitting` flag lets the second attempt through.

Closing the window ends the app. That is deliberate: there is no tray icon and nothing keeps running. If a batch is active, the in-progress job is left in a non-final status and is recovered at the next launch ([Chapter 12](12-data-layer.md)).

## 5.8 Simulation mode

`npm run start:sim` passes `--simulate`, so the core is built with `live: false`. The UI shows **SIMULATION** instead of **LIVE**. Reading is still real (it opens Edge, reads your chat and opens each Reel's page), but follows, comments and unfollows are only recorded, not performed.

> **Warning:** a simulated run marks those Reels as already seen. See issue B3 in [Chapter 18](18-known-issues-and-dead-code.md).
