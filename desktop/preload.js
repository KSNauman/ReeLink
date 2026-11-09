/**
 * Exposes a small, fixed API to the window. The page gets no Node.js access.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reellink', {
  getStatus: () => ipcRenderer.invoke('reellink:status'),
  startBatch: () => ipcRenderer.invoke('reellink:start'),
  stopBatch: () => ipcRenderer.invoke('reellink:stop'),
  unfollow: (opts) => ipcRenderer.invoke('reellink:unfollow', { forceAll: Boolean(opts && opts.forceAll) }),
  login: () => ipcRenderer.invoke('reellink:login'),
  openCsv: () => ipcRenderer.invoke('reellink:open-csv'),
  onUpdate: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('reellink:update', listener);
    return () => ipcRenderer.removeListener('reellink:update', listener);
  },
});
