const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asteria', {
  onStatus: (callback) => ipcRenderer.on('status', (_event, payload) => callback(payload)),
  onServerInfo: (callback) => ipcRenderer.on('server-info', (_event, payload) => callback(payload)),
  onVersions: (callback) => ipcRenderer.on('versions', (_event, payload) => callback(payload)),
  getVersions: () => ipcRenderer.invoke('get-versions'),
  requestPlay: () => ipcRenderer.send('request-play'),
  retryInit: () => ipcRenderer.send('retry-init'),
  requestRepair: () => ipcRenderer.send('request-repair'),
  openDiscord: () => ipcRenderer.send('open-discord'),
  openSitePage: (pagePath) => ipcRenderer.send('open-site-page', pagePath),
  closeLauncher: () => ipcRenderer.send('close-launcher'),
  minimizeLauncher: () => ipcRenderer.send('minimize-launcher'),
});
