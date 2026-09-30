const { contextBridge, ipcRenderer } = require('electron');

// Pont unique entre le processus principal et l'interface. Rien d'autre n'est expose : la page
// n'a acces ni a Node, ni au systeme de fichiers.
contextBridge.exposeInMainWorld('asteria', {
  // --- flux pousses par le processus principal ---
  onStatus: (cb) => ipcRenderer.on('status', (_e, payload) => cb(payload)),
  onServerInfo: (cb) => ipcRenderer.on('server-info', (_e, payload) => cb(payload)),
  onVersions: (cb) => ipcRenderer.on('versions', (_e, payload) => cb(payload)),
  onNews: (cb) => ipcRenderer.on('news', (_e, payload) => cb(payload)),

  // --- lectures ---
  getState: () => ipcRenderer.invoke('get-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getNews: () => ipcRenderer.invoke('get-news'),
  getStatus: () => ipcRenderer.invoke('get-status'),

  // --- actions ---
  setSetting: (cle, valeur) => ipcRenderer.invoke('set-setting', cle, valeur),
  chooseInstallDir: () => ipcRenderer.invoke('choose-install-dir'),
  uninstallClient: () => ipcRenderer.invoke('uninstall-client'),
  requestPlay: () => ipcRenderer.send('request-play'),
  retryInit: () => ipcRenderer.send('retry-init'),
  requestRepair: () => ipcRenderer.send('request-repair'),
  checkUpdates: () => ipcRenderer.send('check-updates'),

  // --- ouvertures externes ---
  openGameFolder: () => ipcRenderer.send('open-game-folder'),
  openLog: () => ipcRenderer.send('open-log'),
  openDiscord: () => ipcRenderer.send('open-discord'),
  openReleases: () => ipcRenderer.send('open-releases'),
  openSitePage: (pagePath) => ipcRenderer.send('open-site-page', pagePath),

  // --- fenetre ---
  closeLauncher: () => ipcRenderer.send('close-launcher'),
  minimizeLauncher: () => ipcRenderer.send('minimize-launcher'),
});
