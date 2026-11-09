/**
 * ReelLink desktop app (Electron main process).
 * Lives in the system tray. Left-click the icon to run a batch; nothing
 * happens until you do. Closing the window leaves the tray icon running.
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, Notification, nativeImage, shell, Tray } = require('electron');

// Keep the database, browser profile and log file in %APPDATA%\ReelLink.
// Must be set before any src/ module loads config.
process.env.REELLINK_DATA_DIR = process.env.REELLINK_DATA_DIR || app.getPath('userData');
process.env.REELLINK_CSV_DIR = process.env.REELLINK_CSV_DIR || path.join(app.getPath('documents'), 'ReelLink');

const isSimulation = process.argv.includes('--simulate') || process.env.REELLINK_SIMULATION === 'true';
// Passed by "Start with Windows", so only the tray icon appears at login.
const startHidden = process.argv.includes('--hidden');
const LOGIN_ARGS = ['--hidden'];

const assetPath = (name) => path.join(__dirname, 'assets', name);

let core = null;
let logger = null;
let mainWindow = null;
let tray = null;
let trayIcons = null;
let lastMenuKey = null;
let activeNotification = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows needs this to show notifications under the app's own name.
  app.setAppUserModelId('com.ksnauman.reellink');

  // Launching ReelLink again just opens the existing window.
  app.on('second-instance', () => {
    if (core) showWindow();
  });

  app.whenReady().then(() => {
    const ReelLinkApp = require('../src/app');
    logger = require('../src/utils/logger');
    core = new ReelLinkApp({ live: !isSimulation });
    core.init();

    Menu.setApplicationMenu(null);
    registerIpc();
    createTray();
    if (!startHidden) showWindow();

    core.on('update', () => {
      updateTray();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('reellink:update');
    });
  });
}

function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    title: 'ReelLink',
    icon: assetPath('icon.ico'),
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Any link the page opens goes to the default browser, never a new app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  // The window is really closed (not hidden), so an idle tray icon uses little memory.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const load = (name) => {
    const image = nativeImage.createFromPath(assetPath(name));
    if (image.isEmpty()) logger.warn('Tray icon failed to load', { name });
    return image;
  };
  trayIcons = { idle: load('tray-idle.ico'), busy: load('tray-busy.ico') };

  tray = new Tray(trayIcons.idle);
  tray.on('click', runFromTray);
  updateTray();
}

function isStartWithWindowsOn() {
  return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
}

function updateTray() {
  if (!tray) return;
  const task = core.activeTask;
  const prefix = isSimulation ? 'ReelLink (simulation)' : 'ReelLink';
  let status = 'Click to run';
  if (task === 'BATCH') status = core.batchProgress.summary || 'Working...';
  else if (task === 'UNFOLLOW') status = 'Unfollowing...';
  else if (task === 'LOGIN') status = 'Waiting for login...';

  // Windows limits tray tooltips to 127 characters.
  tray.setToolTip(`${prefix}: ${status}`.slice(0, 120));

  const menuKey = String(task);
  if (menuKey === lastMenuKey) return;
  lastMenuKey = menuKey;
  tray.setImage(task ? trayIcons.busy : trayIcons.idle);
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  const task = core.activeTask;
  const template = [
    { label: task === 'BATCH' ? 'Running...' : 'Run now', enabled: !task, click: runFromTray },
    { label: 'Stop after this Reel', visible: task === 'BATCH', click: () => core.stopBatch() },
    { type: 'separator' },
    { label: 'Open ReelLink', click: showWindow },
    { label: 'Open links CSV', click: openCsvFromTray },
    { label: 'Log in to Instagram', enabled: !task, click: loginFromTray },
    { type: 'separator' },
  ];

  // Registering a login item only makes sense for the installed app.
  if (app.isPackaged) {
    template.push({
      label: 'Start with Windows',
      type: 'checkbox',
      checked: isStartWithWindowsOn(),
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: LOGIN_ARGS }),
    });
    template.push({ type: 'separator' });
  }

  template.push({ label: 'Quit ReelLink', click: () => app.quit() });
  return Menu.buildFromTemplate(template);
}

/** Left-click. Clicking again while something is running does nothing. */
async function runFromTray() {
  if (core.activeTask) return;
  const result = await core.startBatch({ triggeredBy: 'TRAY' });
  notify(summarizeBatch(result));
}

async function loginFromTray() {
  const result = await core.login();
  notify(result.authenticated ? 'Login saved.' : `Login not completed: ${result.reason}`);
}

async function openCsvFromTray() {
  const result = await openCsv();
  if (!result.ok) notify(result.error);
}

async function openCsv() {
  const file = core.getStatus().csvPath;
  if (!fs.existsSync(file)) return { ok: false, error: 'No links collected yet. Run a batch first.' };
  const error = await shell.openPath(file);
  return error ? { ok: false, error } : { ok: true };
}

function summarizeBatch(result) {
  if (!result.success) return result.error || 'The batch could not finish.';

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (result.processedCount > 0) {
    const ok = result.processedCount - (result.failedCount || 0);
    parts.push(`${plural(ok, 'Reel')} done`);
    if (result.failedCount) parts.push(`${result.failedCount} failed`);
  }
  if (result.linksReceived) parts.push(`${plural(result.linksReceived, 'creator')} sent links`);
  if (result.needsYou) parts.push(`${result.needsYou} need you`);
  if (result.unfollowedCount) parts.push(`${result.unfollowedCount} unfollowed`);
  return parts.length > 0 ? parts.join(', ') : 'No new Reels or links.';
}

/** Shows a Windows notification. Clicking it opens the app. */
function notify(body) {
  if (!Notification.isSupported()) return;
  // Held in a variable so it isn't garbage-collected before it can be clicked.
  activeNotification = new Notification({ title: 'ReelLink', body, icon: assetPath('icon.ico') });
  activeNotification.on('click', showWindow);
  activeNotification.show();
}

function registerIpc() {
  ipcMain.handle('reellink:status', () => core.getStatus());
  ipcMain.handle('reellink:start', () => core.startBatch({ triggeredBy: 'DESKTOP' }));
  ipcMain.handle('reellink:stop', () => core.stopBatch());
  ipcMain.handle('reellink:unfollow', (_e, opts) => core.unfollow({ forceAll: Boolean(opts && opts.forceAll === true) }));
  ipcMain.handle('reellink:login', () => core.login());
  ipcMain.handle('reellink:open-csv', openCsv);
}

// Keep running in the tray when the window closes. Quit is in the tray menu.
app.on('window-all-closed', () => {});

// Close the browser and database cleanly before exiting.
app.on('before-quit', (e) => {
  if (quitting || !core) return;
  e.preventDefault();
  quitting = true;
  if (tray) tray.destroy();
  core.shutdown().finally(() => app.quit());
});
