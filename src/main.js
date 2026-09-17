const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const extractZip = require('extract-zip');
const { autoUpdater } = require('electron-updater');
const config = require('./config');

// Surcharges de test (uniquement hors build empaquete) : dossier d'installation et tag de release cible.
const devInstallDir = !app.isPackaged && process.env.ASTERIA_INSTALL_DIR;
const devReleaseTag = !app.isPackaged && process.env.ASTERIA_RELEASE_TAG;
const devAutoQuit = !app.isPackaged && process.env.ASTERIA_AUTOQUIT === '1';

const installDir = devInstallDir || path.join(app.getPath('appData'), config.installDirName, 'client');
const versionFile = path.join(installDir, 'version.txt');
const tempZipPath = path.join(app.getPath('temp'), 'asteria-client-update.zip');
const tempPatchPath = path.join(app.getPath('temp'), 'asteria-client-patch.zip');
const manifestFile = path.join(app.getPath('userData'), 'client-manifest.json');

// Fichiers ecrits par le launcher lui-meme, pas par la distribution du client :
// on ne les inclut pas dans le controle d'integrite.
const INTEGRITY_EXCLUDE = new Set(['version.txt']);
// Fichier de metadonnees livre a la racine d'un patch differentiel (liste des suppressions).
const PATCH_META_NAME = '_patch.json';

let mainWindow;
let clientReady = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 640,
    resizable: false,
    frame: false,
    backgroundColor: '#05060f',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    initialize().catch((err) => {
      sendStatus('error', 'Erreur : ' + err.message);
      console.error('[init-error]', err.message);
      if (devAutoQuit) setTimeout(() => app.quit(), 500);
    });
    pollServerInfo();
    setInterval(pollServerInfo, 30000);
  });
}

function sendStatus(phase, message, percent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', { phase, message, percent });
  }
}

function sendServerInfo(info) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-info', info);
  }
}

function sendVersions() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('versions', { launcher: app.getVersion(), client: getLocalVersion() });
  }
}

function getLocalVersion() {
  try {
    return fs.readFileSync(versionFile, 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' Go';
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' Mo';
  return Math.max(1, Math.round(bytes / 1024)) + ' Ko';
}

function fetchJson(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'User-Agent': 'AsteriaLauncher' }, extraHeaders || {});
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location, extraHeaders).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error('La requete a repondu ' + res.statusCode));
        return;
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, { headers: { 'User-Agent': 'AsteriaLauncher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('Telechargement echoue (' + res.statusCode + ')'));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && onProgress) onProgress(downloaded / total);
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve()));
        fileStream.on('error', reject);
      }).on('error', reject);
    };
    request(url);
  });
}

function checkGameServerOnline(timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs || 3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(config.gameServerPort, config.gameServerHost);
  });
}

async function fetchPlayersOnline() {
  try {
    const url =
      config.supabaseUrl + '/rest/v1/server_status?id=eq.1&select=is_online,players_online';
    const rows = await fetchJson(url, {
      apikey: config.supabaseAnonKey,
      Authorization: 'Bearer ' + config.supabaseAnonKey,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? row.players_online : null;
  } catch (e) {
    return null;
  }
}

async function pollServerInfo() {
  const [tcpOnline, playersOnline] = await Promise.all([
    checkGameServerOnline(),
    fetchPlayersOnline(),
  ]);
  sendServerInfo({ online: tcpOnline, playersOnline });
}

// ---------------------------------------------------------------------------------------------
// Integrite du client : empreinte SHA-256 de chaque fichier, comparee a la reference publiee
// avec la release (manifest.json) ou, a defaut, a une reference calculee apres installation.
// ---------------------------------------------------------------------------------------------

function listFilesRecursive(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildManifest(dir) {
  const manifest = {};
  for (const file of listFilesRecursive(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (INTEGRITY_EXCLUDE.has(rel)) continue;
    manifest[rel] = hashFile(file);
  }
  return manifest;
}

// Le manifest publie ({files: {rel: {sha256, size}}}) est ramene a la forme {rel: sha256}.
function baselineFromPublished(published) {
  const baseline = {};
  const files = (published && published.files) || {};
  for (const rel of Object.keys(files)) {
    const entry = files[rel];
    baseline[rel] = typeof entry === 'string' ? entry : entry.sha256;
  }
  return baseline;
}

function writeBaseline(baseline) {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(baseline), 'utf8');
}

function saveManifestBaseline(published) {
  writeBaseline(published ? baselineFromPublished(published) : buildManifest(installDir));
}

function loadManifestBaseline() {
  try {
    return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (e) {
    return null;
  }
}

function compareWithBaseline(baseline) {
  const current = buildManifest(installDir);
  const modified = [];
  const added = [];
  const missing = [];
  for (const rel of Object.keys(baseline)) {
    if (!(rel in current)) missing.push(rel);
    else if (current[rel] !== baseline[rel]) modified.push(rel);
  }
  for (const rel of Object.keys(current)) {
    if (!(rel in baseline)) added.push(rel);
  }
  return {
    ok: modified.length === 0 && added.length === 0 && missing.length === 0,
    noBaseline: false,
    modified,
    added,
    missing,
  };
}

function verifyIntegrity() {
  const baseline = loadManifestBaseline();
  if (!baseline) {
    return { ok: false, noBaseline: true, modified: [], added: [], missing: [] };
  }
  return compareWithBaseline(baseline);
}

// Supprime les fichiers absents du manifest publie (restes d'anciennes versions, fichiers ajoutes),
// puis les dossiers devenus vides. Le dossier d'installation reflete ainsi exactement la release.
function pruneToManifest(published) {
  const baseline = baselineFromPublished(published);
  for (const file of listFilesRecursive(installDir)) {
    const rel = path.relative(installDir, file).split(path.sep).join('/');
    if (INTEGRITY_EXCLUDE.has(rel) || rel in baseline) continue;
    try {
      fs.unlinkSync(file);
    } catch (e) {
      // ignore
    }
  }
  removeEmptyDirs(installDir);
}

function removeEmptyDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const full = path.join(dir, entry.name);
      removeEmptyDirs(full);
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch (e) {
        // ignore
      }
    }
  }
}

// Applique le fichier _patch.json extrait avec un patch differentiel : suppressions de fichiers
// retires de la version cible.
function applyPatchMeta() {
  const metaPath = path.join(installDir, PATCH_META_NAME);
  if (!fs.existsSync(metaPath)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    for (const rel of meta.deleted || []) {
      const target = path.join(installDir, rel);
      // securite : jamais en dehors du dossier d'installation
      if (!target.startsWith(installDir)) continue;
      try {
        fs.unlinkSync(target);
      } catch (e) {
        // deja absent
      }
    }
  } finally {
    try {
      fs.unlinkSync(metaPath);
    } catch (e) {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Mise a jour du launcher lui-meme (electron-updater, releases GitHub du depot asteria-launcher).
// Resout true si une mise a jour a ete telechargee et que le launcher va redemarrer.
// ---------------------------------------------------------------------------------------------

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowDowngrade = false;
autoUpdater.logger = null;

function checkLauncherUpdate() {
  if (!app.isPackaged) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let checkTimer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (checkTimer) clearTimeout(checkTimer);
      resolve(value);
    };

    autoUpdater.removeAllListeners();
    autoUpdater.on('error', (err) => {
      console.error('[launcher-update]', err && err.message ? err.message : err);
      done(false);
    });
    autoUpdater.on('update-not-available', () => done(false));
    autoUpdater.on('update-available', (info) => {
      // La verification est faite : on laisse le telechargement aller a son terme.
      if (checkTimer) clearTimeout(checkTimer);
      sendStatus('launcher-update', 'Mise a jour du launcher (' + info.version + ')...', 0);
    });
    autoUpdater.on('download-progress', (progress) => {
      sendStatus(
        'launcher-update',
        'Mise a jour du launcher (' + Math.round(progress.percent) + '%)...',
        Math.round(progress.percent)
      );
    });
    autoUpdater.on('update-downloaded', () => {
      sendStatus('launcher-update', 'Redemarrage du launcher...', 100);
      done(true);
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
    });

    // Si la simple verification ne repond pas (hors ligne, GitHub indisponible), on continue.
    checkTimer = setTimeout(() => done(false), 20000);
    autoUpdater.checkForUpdates().catch(() => done(false));
  });
}

// ---------------------------------------------------------------------------------------------
// Mise a jour du client (releases GitHub du depot asteria-client).
// Une release publie : asteria-client.zip (complet), manifest.json (empreintes) et, en general,
// patch-from-<version precedente>.asteriapatch (zip des fichiers modifies + _patch.json). Le launcher
// applique le patch quand il correspond a la version locale, sinon il retelecharge le zip complet.
// ---------------------------------------------------------------------------------------------

function fetchRelease() {
  const base = 'https://api.github.com/repos/' + config.githubOwner + '/' + config.githubRepo + '/releases/';
  return fetchJson(base + (devReleaseTag ? 'tags/' + devReleaseTag : 'latest'));
}

async function fetchManifest(asset) {
  if (!asset) return null;
  try {
    const manifest = await fetchJson(asset.browser_download_url);
    return manifest && manifest.files ? manifest : null;
  } catch (e) {
    console.error('[client-update] manifest illisible :', e.message);
    return null;
  }
}

async function ensureBaseline(manifestAsset) {
  if (loadManifestBaseline()) return;
  const manifest = await fetchManifest(manifestAsset);
  saveManifestBaseline(manifest);
}

async function initialize(options) {
  const forceFull = !!(options && options.forceFull);
  sendVersions();
  sendStatus('checking', 'Verification des mises a jour...');

  if (await checkLauncherUpdate()) return; // le launcher redemarre avec la nouvelle version

  sendStatus('checking', 'Verification des mises a jour du client...');

  let release = null;
  try {
    release = await fetchRelease();
  } catch (err) {
    const localVersion = getLocalVersion();
    if (localVersion && !forceFull) {
      return finishReady('Hors ligne, version locale disponible.');
    }
    throw new Error('Impossible de verifier les mises a jour et aucune installation locale trouvee.');
  }

  const remoteVersion = release.tag_name;
  const localVersion = getLocalVersion();
  const assets = release.assets || [];
  const manifestAsset = assets.find((a) => a.name.toLowerCase() === 'manifest.json');
  const fullAsset = assets.find(
    (a) => a.name.toLowerCase().endsWith('.zip') && !a.name.toLowerCase().startsWith('patch-from-')
  );
  const exeExists = fs.existsSync(path.join(installDir, config.clientExeName));

  if (!forceFull && localVersion === remoteVersion && exeExists) {
    await ensureBaseline(manifestAsset);
    return finishReady('A jour !');
  }

  const manifest = await fetchManifest(manifestAsset);

  // 1) Mise a jour differentielle depuis la version locale
  const patchAsset =
    !forceFull && localVersion && exeExists
      ? assets.find((a) => a.name.toLowerCase() === ('patch-from-' + localVersion + '.asteriapatch').toLowerCase())
      : null;

  if (patchAsset) {
    try {
      await applyPatch(patchAsset, manifest, remoteVersion);
      return finishReady('Mise a jour ' + remoteVersion + ' installee !');
    } catch (err) {
      console.error('[client-update] patch impossible, retour au telechargement complet :', err.message);
      sendStatus('checking', 'Mise a jour rapide impossible, telechargement complet...');
    }
  }

  // 2) Installation complete (premiere installation, saut de plusieurs versions, reparation)
  if (!fullAsset) {
    if (localVersion && !forceFull) {
      return finishReady('Pas de fichier de mise a jour, version locale disponible.');
    }
    throw new Error('Aucun fichier client disponible sur la derniere version publiee.');
  }

  await installFull(fullAsset, manifest, remoteVersion, forceFull);
  return finishReady(forceFull ? 'Client repare !' : 'Installation terminee !');
}

async function applyPatch(patchAsset, manifest, remoteVersion) {
  const label = 'Telechargement de la mise a jour ' + remoteVersion + ' (' + formatSize(patchAsset.size) + ')...';
  sendStatus('downloading', label, 0);
  await downloadFile(patchAsset.browser_download_url, tempPatchPath, (fraction) => {
    sendStatus('downloading', label, Math.round(fraction * 100));
  });

  sendStatus('extracting', 'Application de la mise a jour...');
  await extractZip(tempPatchPath, { dir: installDir });
  applyPatchMeta();
  try {
    fs.unlinkSync(tempPatchPath);
  } catch (e) {
    // pas grave
  }

  if (manifest) {
    sendStatus('verifying', 'Verification des fichiers...');
    pruneToManifest(manifest);
    const check = compareWithBaseline(baselineFromPublished(manifest));
    if (!check.ok) {
      throw new Error(
        'verification apres patch : ' +
          check.modified.length + ' modifie(s), ' + check.missing.length + ' manquant(s), ' + check.added.length + ' en trop'
      );
    }
  }

  fs.writeFileSync(versionFile, remoteVersion, 'utf8');
  saveManifestBaseline(manifest);
  sendVersions();
}

async function installFull(fullAsset, manifest, remoteVersion, isRepair) {
  const label =
    (isRepair ? 'Reparation du client ' : 'Telechargement du client ') +
    remoteVersion + ' (' + formatSize(fullAsset.size) + ')...';
  sendStatus('downloading', label, 0);
  await downloadFile(fullAsset.browser_download_url, tempZipPath, (fraction) => {
    sendStatus('downloading', label, Math.round(fraction * 100));
  });

  sendStatus('extracting', 'Installation en cours...');
  fs.mkdirSync(installDir, { recursive: true });
  await extractZip(tempZipPath, { dir: installDir });
  try {
    fs.unlinkSync(tempZipPath);
  } catch (e) {
    // pas grave
  }

  sendStatus('verifying', 'Verification des fichiers...');
  if (manifest) {
    pruneToManifest(manifest);
    const check = compareWithBaseline(baselineFromPublished(manifest));
    if (!check.ok) {
      throw new Error(
        'Le client telecharge ne correspond pas a la release (' +
          check.modified.length + ' modifie(s), ' + check.missing.length + ' manquant(s)). Reessaie.'
      );
    }
  }
  fs.writeFileSync(versionFile, remoteVersion, 'utf8');
  saveManifestBaseline(manifest);
  sendVersions();
}

function finishReady(message) {
  clientReady = true;
  sendStatus('ready', message);
  console.log('[ready]', message, '| client', getLocalVersion());
  if (devAutoQuit) {
    const check = verifyIntegrity();
    console.log('[integrity]', check.ok ? 'ok' : JSON.stringify(check));
    setTimeout(() => app.quit(), 500);
  }
}

function launchClient() {
  const exePath = path.join(installDir, config.clientExeName);
  if (!fs.existsSync(exePath)) {
    throw new Error("Le fichier du jeu (" + config.clientExeName + ') est introuvable apres installation.');
  }
  const child = spawn(exePath, [], {
    cwd: installDir,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  setTimeout(() => app.quit(), 800);
}

ipcMain.on('request-play', () => {
  if (!clientReady) return;

  sendStatus('verifying', "Verification de l'integrite des fichiers...");

  setTimeout(() => {
    try {
      const result = verifyIntegrity();
      if (!result.ok) {
        const details = [];
        if (result.modified.length) details.push(result.modified.length + ' modifie(s)');
        if (result.added.length) details.push(result.added.length + ' ajoute(s)');
        if (result.missing.length) details.push(result.missing.length + ' manquant(s)');
        const reason = result.noBaseline
          ? 'aucune reference locale'
          : details.join(', ');
        sendStatus('integrity-error', 'Fichiers du client modifies (' + reason + ').');
        return;
      }
      sendStatus('launching', 'Lancement...');
      launchClient();
    } catch (err) {
      sendStatus('error', 'Erreur : ' + err.message);
    }
  }, 50);
});

ipcMain.on('retry-init', () => {
  clientReady = false;
  initialize().catch((err) => {
    sendStatus('error', 'Erreur : ' + err.message);
  });
});

ipcMain.on('request-repair', () => {
  clientReady = false;
  initialize({ forceFull: true }).catch((err) => {
    sendStatus('error', 'Erreur : ' + err.message);
  });
});

ipcMain.handle('get-versions', () => ({ launcher: app.getVersion(), client: getLocalVersion() }));

ipcMain.on('open-discord', () => {
  if (config.discordUrl) shell.openExternal(config.discordUrl);
});

ipcMain.on('open-site-page', (_event, pagePath) => {
  if (config.siteUrl) shell.openExternal(config.siteUrl.replace(/\/$/, '') + pagePath);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.on('close-launcher', () => {
  app.quit();
});

ipcMain.on('minimize-launcher', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
