# Chapter 15: Build and packaging

## 15.1 Building

```powershell
npm install
npm run dist
```

Output in `dist/`:

| Item | Size | Purpose |
|---|---|---|
| `ReelLink Setup 0.1.0.exe` | 124 MB | **The installer you distribute** |
| `win-unpacked/` | | The app before packaging; run it to test without installing |
| `*.blockmap`, `latest.yml` | | Update metadata; nothing uses it yet |
| `builder-debug.yml` | | Build diagnostics |

## 15.2 The build configuration

From [`package.json`](../../package.json):

```json
"build": {
  "appId": "com.ksnauman.reellink",
  "productName": "ReelLink",
  "directories": { "output": "dist" },
  "files": ["desktop/**", "src/**", "package.json"],
  "asarUnpack": ["node_modules/playwright-core/**"],
  "win": { "target": "nsis" },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true
  }
}
```

| Setting | Meaning |
|---|---|
| `appId` | Windows' identity for the app |
| `files` | What goes in. Tests, docs and data stay out. Production dependencies are added automatically |
| `asarUnpack` | Files kept as real files outside the archive |
| `nsis.oneClick: false` | A normal wizard that lets you choose the folder |

Dependency placement matters: `electron` and `electron-builder` are `devDependencies` and not shipped as modules. `playwright` and `dotenv` are `dependencies` and are.

## 15.3 What's inside

```
win-unpacked/
├─ ReelLink.exe                     Electron runtime, renamed
└─ resources/
   ├─ app.asar                      about 5 MB: your code + dependencies
   └─ app.asar.unpacked/
      └─ node_modules/playwright-core/
```

**asar** is a simple archive format. Electron reads it like a folder.

**Why unpack Playwright?** Its code needs to work with real files on disk and start other processes, which can't happen from inside an archive.

## 15.4 Three packaging problems and how they were avoided

### No native modules

`better-sqlite3` is compiled C++ and must be rebuilt for Electron's ABI. `node:sqlite` ships within Electron 45's Node 24.22.2, so that whole class of build failure doesn't exist here.

### No bundled browser

Playwright normally downloads Chromium, which adds hundreds of megabytes. `channel: 'msedge'` uses the Edge that comes with Windows. **Requirement:** Edge must be installed on the PC.

### Paths inside an archive

Code in `app.asar` can't write beside itself. So:

- Writable data goes to `app.getPath('userData')`.
- That path is passed via `REELLINK_DATA_DIR`, keeping `src/` free of Electron imports.
- `preload.js` and `index.html` are located with `__dirname`, which works inside asar.

## 15.5 Installing

1. Run `ReelLink Setup 0.1.0.exe`.
2. SmartScreen warns because it is unsigned: **More info → Run anyway**.
3. Choose the folder and finish.
4. Open it, click **Log in**, then **Start batch**.

## 15.6 Node versions

| Context | Node |
|---|---|
| Installed app | 24.22.2, inside Electron. No Node install needed |
| Running tests | Your installed Node; needs 24+ for `node:sqlite` |

## 15.7 Current gaps

- **No code signing**, so SmartScreen warns.
- **No custom icon**; it uses Electron's default.
- **No auto-update**. `app-update.yml` is generated, but no update code exists. You reinstall to upgrade.
- **Built for one person**: the owner is compiled in.
- **Windows only**: NSIS target and Edge.

## 15.8 Releasing a new version

1. Update `version` in `package.json`.
2. `npm test`
3. `npm run dist`
4. Test `dist\win-unpacked\ReelLink.exe`.
5. Install over the old version. Your data is in `%APPDATA%`, so it stays.
