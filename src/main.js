const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const extractZip = require('extract-zip');
const { autoUpdater } = require('electron-updater');
const config = require('./config');
const i18n = require('./i18n');
const { Settings, WINDOW_SIZES } = require('./settings');

// Surcharges de test (uniquement hors build empaquete) : dossier d'installation et tag de release cible.
const devInstallDir = !app.isPackaged && process.env.ASTERIA_INSTALL_DIR;
const devReleaseTag = !app.isPackaged && process.env.ASTERIA_RELEASE_TAG;
const devAutoQuit = !app.isPackaged && process.env.ASTERIA_AUTOQUIT === '1';
// Garde-fou pour travailler sur l'interface : le launcher verifie et annonce les mises a jour,
// mais ne telecharge ni n'ecrit rien. Sans elle, un simple `electron .` sur un client en retard
// lance une vraie mise a jour de plusieurs Go sur le dossier de jeu. Voir `npm run dev`.
const devNoDownload = !app.isPackaged && process.env.ASTERIA_NO_DOWNLOAD === '1';

const tempZipPath = path.join(app.getPath('temp'), 'asteria-client-update.zip');
const tempPatchPath = path.join(app.getPath('temp'), 'asteria-client-patch.zip');
const manifestFile = path.join(app.getPath('userData'), 'client-manifest.json');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

// Fichiers ecrits par le launcher lui-meme, pas par la distribution du client :
// on ne les inclut pas dans le controle d'integrite.
const INTEGRITY_EXCLUDE = new Set(['version.txt']);
// Fichier de metadonnees livre a la racine d'un patch differentiel (liste des suppressions).
const PATCH_META_NAME = '_patch.json';

let settings;
let mainWindow;
let tray = null;
let clientReady = false;
let quitting = false;
let gameProcess = null;
let pendingUpdateVersion = null; // version distante connue quand les mises a jour auto sont coupees
let serverWasOnline = null;

// ---------------------------------------------------------------------------------------------
// Chemins : le dossier d'installation est un reglage, tout le reste en decoule.
// ---------------------------------------------------------------------------------------------

function defaultInstallDir() {
  return path.join(app.getPath('appData'), config.installDirName, 'client');
}

function getInstallDir() {
  return devInstallDir || (settings && settings.get('installDir')) || defaultInstallDir();
}

function getVersionFile() {
  return path.join(getInstallDir(), 'version.txt');
}

/**
 * Chemin de l'executable pour une architecture, ou null s'il n'est pas livre. Les entrees de
 * config sont des chemins relatifs au dossier d'installation, separes par des barres obliques :
 * le 32 bits est le projecteur Flash range dans resources/app/retroclient.
 */
function exePathForArch(arch) {
  const dir = getInstallDir();
  for (const relatif of config.clientExeByArch[arch] || []) {
    const complet = path.join(dir, ...relatif.split('/'));
    if (fs.existsSync(complet)) return complet;
  }
  return null;
}

/** Ce que le client installe propose reellement : sert a griser l'option indisponible. */
function archAvailability() {
  return { x64: !!exePathForArch('x64'), x86: !!exePathForArch('x86') };
}

function anyExeExists() {
  return !!(exePathForArch('x64') || exePathForArch('x86'));
}

// ---------------------------------------------------------------------------------------------
// Journal de bord (userData/launcher.log, ~1 Mo puis rotation) : a demander aux joueurs.
// Il est toujours ecrit en francais, quelle que soit la langue de l'interface.
// ---------------------------------------------------------------------------------------------

const logFile = path.join(app.getPath('userData'), 'launcher.log');
function logLine(level, ...parts) {
  const text = parts.map((p) => (p instanceof Error ? p.message : String(p))).join(' ');
  const line = '[' + new Date().toISOString() + '] ' + level + ' ' + text + '\n';
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
    fs.appendFileSync(logFile, line);
  } catch (e) {
    // pas de journal, tant pis
  }
  (level === 'ERROR' ? console.error : console.log)(text);
}

const t = (cle, params) => i18n.translate(settings ? settings.get('lang') : 'fr', cle, params);

// ---------------------------------------------------------------------------------------------
// Fenetre
// ---------------------------------------------------------------------------------------------

function createWindow() {
  const taille = WINDOW_SIZES[settings.get('windowSize')] || WINDOW_SIZES.medium;
  mainWindow = new BrowserWindow({
    width: taille.width,
    height: taille.height,
    resizable: false,
    frame: false,
    backgroundColor: '#04061a',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Fermer la fenetre peut vouloir dire « ranger dans la zone de notification ».
  mainWindow.on('close', (event) => {
    if (!quitting && settings.get('minimizeToTray')) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    logLine('INFO', 'launcher', app.getVersion(), '| client dir', getInstallDir(), '| client', getLocalVersion() || 'aucun');
    initialize().catch((err) => {
      sendStatus('error', 'error.generic', { message: err.message });
      logLine('ERROR', 'init', err);
      if (devAutoQuit) setTimeout(() => app.quit(), 500);
    });
    pollServerInfo();
    setInterval(pollServerInfo, 30000);
    refreshNews();
    setInterval(refreshNews, 10 * 60 * 1000);
  });
}

function appliquerTray() {
  const voulu = settings.get('minimizeToTray');
  if (voulu && !tray) {
    try {
      tray = new Tray(path.join(__dirname, '..', 'build', 'icon.ico'));
      tray.setToolTip('Asteria Launcher');
      construireMenuTray();
      tray.on('double-click', montrerFenetre);
    } catch (e) {
      logLine('ERROR', 'tray indisponible :', e);
      tray = null;
    }
  } else if (!voulu && tray) {
    tray.destroy();
    tray = null;
  } else if (tray) {
    construireMenuTray();
  }
}

function construireMenuTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('dialog.tray.open'), click: montrerFenetre },
      { label: t('dialog.tray.play'), enabled: clientReady, click: () => demanderLancement() },
      { type: 'separator' },
      { label: t('dialog.tray.quit'), click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function montrerFenetre() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function notifier(cleReglage, titreCle, corpsCle, params) {
  if (!settings.get(cleReglage)) return;
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: t(titreCle, params),
      body: t(corpsCle, params),
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    }).show();
  } catch (e) {
    // une notification ratee n'est jamais bloquante
  }
}

// ---------------------------------------------------------------------------------------------
// Messages vers l'interface : cle + parametres, jamais du texte tout fait, pour que le
// changement de langue s'applique sans relancer quoi que ce soit.
// ---------------------------------------------------------------------------------------------

let dernierStatut = null;
// Un telechargement emet un evenement par bloc recu, soit des centaines par seconde : le journal
// ne retient qu'un palier tous les 10 %, plus chaque changement de message.
let journalPrecedent = { texte: null, percent: -100 };

function sendStatus(phase, cle, params, percent) {
  dernierStatut = { phase, key: cle, params: params || null, percent };

  const texte = i18n.translate('fr', cle, params);
  const chiffre = typeof percent === 'number';
  if (texte !== journalPrecedent.texte || !chiffre || percent === 100 || percent - journalPrecedent.percent >= 10) {
    logLine('INFO', phase, '-', texte + (chiffre ? ' (' + percent + ' %)' : ''));
    journalPrecedent = { texte, percent: chiffre ? percent : -100 };
  }

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('status', dernierStatut);
  if (tray) construireMenuTray();
}

function sendServerInfo(info) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server-info', info);
}

function etatComplet() {
  return {
    launcher: app.getVersion(),
    client: getLocalVersion(),
    installDir: getInstallDir(),
    arch: archAvailability(),
    running: !!gameProcess,
    pendingUpdate: pendingUpdateVersion,
  };
}

function sendVersions() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('versions', etatComplet());
}

function getLocalVersion() {
  try {
    return fs.readFileSync(getVersionFile(), 'utf8').trim();
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

// ---------------------------------------------------------------------------------------------
// Reseau
// ---------------------------------------------------------------------------------------------

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
        const debut = Date.now();
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && onProgress) {
            const secondes = Math.max(0.001, (Date.now() - debut) / 1000);
            onProgress(downloaded / total, downloaded / secondes);
          }
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

function supabase(chemin) {
  return fetchJson(config.supabaseUrl + chemin, {
    apikey: config.supabaseAnonKey,
    Authorization: 'Bearer ' + config.supabaseAnonKey,
  });
}

async function fetchPlayersOnline() {
  try {
    const rows = await supabase('/rest/v1/server_status?id=eq.1&select=is_online,players_online');
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? row.players_online : null;
  } catch (e) {
    return null;
  }
}

async function pollServerInfo() {
  const [tcpOnline, playersOnline] = await Promise.all([checkGameServerOnline(), fetchPlayersOnline()]);
  if (serverWasOnline === false && tcpOnline) notifier('notifyServerBack', 'notify.serverBack.title', 'notify.serverBack.body');
  serverWasOnline = tcpOnline;
  sendServerInfo({ online: tcpOnline, playersOnline, at: Date.now() });
}

let dernieresActus = [];

async function refreshNews() {
  try {
    const posts = await supabase(
      '/rest/v1/news_posts?select=slug,title,excerpt,published_at&published_at=not.is.null' +
        '&order=published_at.desc&limit=4'
    );
    if (!Array.isArray(posts)) return;
    dernieresActus = posts;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('news', posts);

    // Le corps de la notification est le titre de l'actualite : il vient du site, pas d'une cle.
    // Au tout premier lancement `lastSeenNews` est vide — on enregistre sans notifier, sinon on
    // annoncerait comme nouvelle une actualite deja vieille de plusieurs semaines.
    const dernier = posts[0] && posts[0].slug;
    const connu = settings.get('lastSeenNews');
    if (dernier && connu && dernier !== connu && settings.get('notifyNews') && Notification.isSupported()) {
      try {
        new Notification({
          title: t('notify.news.title'),
          body: posts[0].title,
          icon: path.join(__dirname, '..', 'build', 'icon.ico'),
        }).show();
      } catch (e) {
        // une notification ratee n'est jamais bloquante
      }
    }
    if (dernier && dernier !== connu) settings.set('lastSeenNews', dernier);
  } catch (e) {
    // pas d'actualites : le panneau reste vide, ce n'est pas une erreur bloquante
  }
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
    if (entry.isDirectory()) results.push(...listFilesRecursive(fullPath));
    else if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

// La reference est liee a la version installee : si elle ne correspond plus (autre dossier,
// mise a jour interrompue), elle est ignoree et retelechargee avec la release.
function writeBaseline(baseline) {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify({ version: getLocalVersion(), dir: getInstallDir(), files: baseline }), 'utf8');
}

function saveManifestBaseline(published) {
  writeBaseline(published ? baselineFromPublished(published) : buildManifest(getInstallDir()));
}

function loadManifestBaseline() {
  try {
    const stored = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!stored || !stored.files || stored.version !== getLocalVersion()) return null;
    if (stored.dir && stored.dir !== getInstallDir()) return null;
    return stored.files;
  } catch (e) {
    return null;
  }
}

function compareWithBaseline(baseline) {
  const current = buildManifest(getInstallDir());
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
  return { ok: !modified.length && !added.length && !missing.length, noBaseline: false, modified, added, missing };
}

function verifyIntegrity() {
  const baseline = loadManifestBaseline();
  if (!baseline) return { ok: false, noBaseline: true, modified: [], added: [], missing: [] };
  return compareWithBaseline(baseline);
}

// Supprime les fichiers absents du manifest publie (restes d'anciennes versions, fichiers ajoutes),
// puis les dossiers devenus vides. Le dossier d'installation reflete ainsi exactement la release.
function pruneToManifest(published) {
  const baseline = baselineFromPublished(published);
  const dir = getInstallDir();
  for (const file of listFilesRecursive(dir)) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    if (INTEGRITY_EXCLUDE.has(rel) || rel in baseline) continue;
    try {
      fs.unlinkSync(file);
    } catch (e) {
      // ignore
    }
  }
  removeEmptyDirs(dir);
}

// True si le dossier ne contient aucun fichier (recursivement) : simple lecture, aucune suppression.
function hasNoFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!hasNoFiles(path.join(dir, entry.name))) return false;
    } else {
      return false;
    }
  }
  return true;
}

// Liste les sous-arborescences sans aucun fichier : on ne garde que les racines, chacune est
// ensuite supprimee d'un seul appel recursif.
function findEmptySubtrees(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (hasNoFiles(full)) out.push(full);
    else findEmptySubtrees(full, out);
  }
  return out;
}

// Sur Windows la suppression peut etre differee (antivirus, indexation) : rm reessaie quelques
// fois plutot que de laisser des dossiers vides derriere nous.
function removeEmptyDirs(dir) {
  for (const sub of findEmptySubtrees(dir, [])) {
    try {
      fs.rmSync(sub, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {
      // on reessaiera au prochain demarrage
    }
  }
}

async function removeEmptyDirsAsync(dir) {
  for (const sub of findEmptySubtrees(dir, [])) {
    try {
      await fs.promises.rm(sub, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {
      // on reessaiera au prochain demarrage
    }
  }
}

// Applique le fichier _patch.json livre avec un patch differentiel : suppressions de fichiers
// retires de la version cible.
function applyPatchMeta() {
  const dir = getInstallDir();
  const metaPath = path.join(dir, PATCH_META_NAME);
  if (!fs.existsSync(metaPath)) return;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    for (const rel of meta.deleted || []) {
      const target = path.join(dir, rel);
      if (!target.startsWith(dir)) continue; // securite : jamais en dehors du dossier d'installation
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
      logLine('ERROR', 'launcher-update', err && err.message ? err.message : err);
      done(false);
    });
    autoUpdater.on('update-not-available', () => done(false));
    autoUpdater.on('update-available', (info) => {
      if (checkTimer) clearTimeout(checkTimer);
      notifier('notifyUpdateAvailable', 'notify.updateAvailable.title', 'notify.updateAvailable.body', {
        version: info.version,
      });
      sendStatus('launcher-update', 'status.launcherUpdate', { version: info.version }, 0);
    });
    autoUpdater.on('download-progress', (progress) => {
      sendStatus(
        'launcher-update',
        'status.launcherUpdateProgress',
        { percent: Math.round(progress.percent) },
        Math.round(progress.percent)
      );
    });
    autoUpdater.on('update-downloaded', () => {
      sendStatus('launcher-update', 'status.launcherRestart', null, 100);
      done(true);
      setTimeout(() => {
        quitting = true;
        autoUpdater.quitAndInstall(true, true);
      }, 1200);
    });

    // Si la simple verification ne repond pas (hors ligne, GitHub indisponible), on continue.
    checkTimer = setTimeout(() => done(false), 20000);
    autoUpdater.checkForUpdates().catch(() => done(false));
  });
}

// ---------------------------------------------------------------------------------------------
// Mise a jour du client (releases GitHub du depot asteria-client).
// Une release publie : asteria-client.zip (complet), manifest.json (empreintes) et, en general,
// patch-from-<version precedente>.asteriapatch. Le launcher applique le patch quand il correspond
// a la version locale, sinon il retelecharge le zip complet.
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
    logLine('ERROR', 'manifest illisible :', e);
    return null;
  }
}

async function ensureBaseline(manifestAsset) {
  if (loadManifestBaseline()) return;
  saveManifestBaseline(await fetchManifest(manifestAsset));
}

async function initialize(options) {
  const forceFull = !!(options && options.forceFull);
  // Les mises a jour auto peuvent etre coupees, mais une premiere installation reste obligatoire :
  // sans client il n'y a rien a lancer.
  const autoriseTelechargement =
    !devNoDownload &&
    (forceFull || !!(options && options.force) || settings.get('autoUpdate') || !getLocalVersion());

  pendingUpdateVersion = null;
  sendVersions();
  sendStatus('checking', 'status.checkingLauncher');

  if (await checkLauncherUpdate()) return; // le launcher redemarre avec la nouvelle version

  sendStatus('checking', 'status.checkingClient');

  let release = null;
  try {
    release = await fetchRelease();
  } catch (err) {
    if (getLocalVersion() && !forceFull) return finishReady('status.readyOffline');
    throw new Error(t('error.noRelease'));
  }

  const remoteVersion = release.tag_name;
  const localVersion = getLocalVersion();
  const assets = release.assets || [];
  const manifestAsset = assets.find((a) => a.name.toLowerCase() === 'manifest.json');
  const fullAsset = assets.find(
    (a) => a.name.toLowerCase().endsWith('.zip') && !a.name.toLowerCase().startsWith('patch-from-')
  );
  const exeExists = anyExeExists();

  if (!forceFull && localVersion === remoteVersion && exeExists) {
    await ensureBaseline(manifestAsset);
    removeEmptyDirsAsync(getInstallDir()).catch(() => {});
    return finishReady('status.ready');
  }

  // Une mise a jour existe : on previent, puis on la telecharge — ou on attend le clic si les
  // mises a jour automatiques sont coupees.
  if (localVersion && localVersion !== remoteVersion) {
    notifier('notifyUpdateAvailable', 'notify.updateAvailable.title', 'notify.updateAvailable.body', {
      version: remoteVersion,
    });
  }
  if (!autoriseTelechargement) {
    pendingUpdateVersion = remoteVersion;
    clientReady = false;
    sendVersions();
    sendStatus('update-available', 'status.updateAvailable', { version: remoteVersion });
    return;
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
      return finishReady('status.readyUpdated', { version: remoteVersion }, true);
    } catch (err) {
      logLine('ERROR', 'patch impossible, retour au telechargement complet :', err);
      sendStatus('checking', 'status.fallbackFull');
    }
  }

  // 2) Installation complete (premiere installation, saut de plusieurs versions, reparation)
  if (!fullAsset) {
    if (localVersion && !forceFull) return finishReady('status.readyNoAsset');
    throw new Error(t('error.noAsset'));
  }

  const premiereInstallation = !localVersion;
  await installFull(fullAsset, manifest, remoteVersion, forceFull);
  return finishReady(
    forceFull ? 'status.readyRepaired' : premiereInstallation ? 'status.readyInstalled' : 'status.readyUpdated',
    { version: remoteVersion },
    true
  );
}

function progression(cle, params) {
  return (fraction, octetsParSeconde) => {
    const percent = Math.round(fraction * 100);
    sendStatus(
      'downloading',
      cle,
      Object.assign({ speed: formatSize(octetsParSeconde) + '/s' }, params),
      percent
    );
  };
}

async function applyPatch(patchAsset, manifest, remoteVersion) {
  const params = { version: remoteVersion, size: formatSize(patchAsset.size) };
  sendStatus('downloading', 'status.downloadPatch', params, 0);
  await downloadFile(patchAsset.browser_download_url, tempPatchPath, progression('status.downloadPatch', params));

  sendStatus('extracting', 'status.applyPatch');
  await extractZip(tempPatchPath, { dir: getInstallDir() });
  applyPatchMeta();
  try {
    fs.unlinkSync(tempPatchPath);
  } catch (e) {
    // pas grave
  }

  if (manifest) {
    sendStatus('verifying', 'status.verifyingFiles');
    pruneToManifest(manifest);
    const check = compareWithBaseline(baselineFromPublished(manifest));
    if (!check.ok) {
      throw new Error(
        t('error.patchMismatch', {
          detail:
            check.modified.length + ' modif., ' + check.missing.length + ' manq., ' + check.added.length + ' en trop',
        })
      );
    }
  }

  fs.writeFileSync(getVersionFile(), remoteVersion, 'utf8');
  saveManifestBaseline(manifest);
  sendVersions();
}

async function installFull(fullAsset, manifest, remoteVersion, isRepair) {
  const cle = isRepair ? 'status.repairFull' : 'status.downloadFull';
  const params = { version: remoteVersion, size: formatSize(fullAsset.size) };
  sendStatus('downloading', cle, params, 0);
  await downloadFile(fullAsset.browser_download_url, tempZipPath, progression(cle, params));

  sendStatus('extracting', 'status.installing');
  fs.mkdirSync(getInstallDir(), { recursive: true });
  await extractZip(tempZipPath, { dir: getInstallDir() });
  try {
    fs.unlinkSync(tempZipPath);
  } catch (e) {
    // pas grave
  }

  sendStatus('verifying', 'status.verifyingFiles');
  if (manifest) {
    pruneToManifest(manifest);
    const check = compareWithBaseline(baselineFromPublished(manifest));
    if (!check.ok) {
      throw new Error(
        t('error.downloadMismatch', {
          detail: check.modified.length + ' modif., ' + check.missing.length + ' manq.',
        })
      );
    }
  }
  fs.writeFileSync(getVersionFile(), remoteVersion, 'utf8');
  saveManifestBaseline(manifest);
  sendVersions();
}

function finishReady(cle, params, apresInstallation) {
  clientReady = true;
  pendingUpdateVersion = null;
  sendVersions();
  sendStatus('ready', cle, params);
  logLine('INFO', 'ready :', i18n.translate('fr', cle, params), '| client', getLocalVersion());
  if (apresInstallation) notifier('notifyUpdateDone', 'notify.updateDone.title', 'notify.updateDone.body');
  if (devAutoQuit) {
    const check = verifyIntegrity();
    console.log('[integrity]', check.ok ? 'ok' : JSON.stringify(check));
    setTimeout(() => app.quit(), 500);
  }
}

// ---------------------------------------------------------------------------------------------
// Lancement du jeu — le launcher ne se ferme plus, sauf si le joueur l'a demande.
// ---------------------------------------------------------------------------------------------

function launchClient() {
  const voulu = settings.get('arch');
  const autre = voulu === 'x64' ? 'x86' : 'x64';
  const exePath = exePathForArch(voulu) || exePathForArch(autre);
  if (!exePath) throw new Error(t('error.noExe', { name: config.clientExeName }));
  if (!exePathForArch(voulu)) logLine('INFO', 'version', voulu, 'absente, lancement de', path.basename(exePath));

  // Le dossier courant est celui de l'executable, pas la racine : le projecteur Flash 32 bits
  // charge loader.swf et ses ressources a cote de lui.
  logLine('INFO', 'lancement', voulu, ':', exePath);
  const child = spawn(exePath, [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' });
  gameProcess = child;
  sendVersions();

  child.on('exit', () => {
    gameProcess = null;
    sendVersions();
    if (!quitting) sendStatus('ready', 'status.gameClosed');
  });
  child.on('error', (err) => {
    gameProcess = null;
    sendVersions();
    sendStatus('error', 'error.generic', { message: err.message });
  });
  child.unref();

  if (settings.get('closeOnLaunch')) {
    setTimeout(() => {
      quitting = true;
      app.quit();
    }, 800);
  } else {
    setTimeout(() => sendStatus('running', 'status.running'), 600);
  }
}

function demanderLancement() {
  if (!clientReady) return;

  sendStatus('verifying', 'status.verifyingIntegrity');
  setTimeout(() => {
    try {
      const result = verifyIntegrity();
      if (!result.ok) {
        const details = [];
        if (result.modified.length) details.push(t('status.integrityModified', { n: result.modified.length }));
        if (result.added.length) details.push(t('status.integrityAdded', { n: result.added.length }));
        if (result.missing.length) details.push(t('status.integrityMissing', { n: result.missing.length }));
        const reason = result.noBaseline ? t('status.integrityNoBaseline') : details.join(', ');
        sendStatus('integrity-error', 'status.integrityError', { reason });
        return;
      }
      sendStatus('launching', 'status.launching');
      launchClient();
    } catch (err) {
      sendStatus('error', 'error.generic', { message: err.message });
    }
  }, 50);
}

// ---------------------------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------------------------

function relance(options) {
  clientReady = false;
  initialize(options).catch((err) => {
    sendStatus('error', 'error.generic', { message: err.message });
    logLine('ERROR', 'init', err);
  });
}

ipcMain.on('request-play', demanderLancement);
ipcMain.on('retry-init', () => relance());
ipcMain.on('request-repair', () => relance({ forceFull: true }));
ipcMain.on('check-updates', () => relance({ force: true }));

ipcMain.handle('get-state', () => etatComplet());
ipcMain.handle('get-settings', () => settings.tout());
ipcMain.handle('get-news', () => dernieresActus);
ipcMain.handle('get-status', () => dernierStatut);

ipcMain.handle('set-setting', (_event, cle, valeur) => {
  const retenu = settings.set(cle, valeur);

  if (cle === 'minimizeToTray') appliquerTray();
  if (cle === 'lang' && tray) construireMenuTray();
  if (cle === 'startWithWindows' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!retenu, args: ['--hidden'] });
  }
  if (cle === 'windowSize' && mainWindow && !mainWindow.isDestroyed()) {
    const taille = WINDOW_SIZES[retenu] || WINDOW_SIZES.medium;
    mainWindow.setSize(taille.width, taille.height);
    mainWindow.center();
  }
  return settings.tout();
});

ipcMain.handle('choose-install-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: t('dialog.dir.title'),
    message: t('dialog.dir.message'),
    defaultPath: getInstallDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { changed: false, dir: getInstallDir() };
  settings.set('installDir', res.filePaths[0]);
  logLine('INFO', "dossier d'installation :", res.filePaths[0]);
  sendStatus('checking', 'status.dirChanged', { dir: res.filePaths[0] });
  relance();
  return { changed: true, dir: getInstallDir() };
});

ipcMain.handle('uninstall-client', async () => {
  const dir = getInstallDir();
  // Le dossier est choisi par le joueur : on ne supprime que s'il contient bien un client,
  // jamais un dossier quelconque qui aurait ete designe par erreur.
  if (!fs.existsSync(path.join(dir, 'version.txt')) && !anyExeExists()) {
    return { done: false, reason: 'pas-un-client' };
  }
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [t('dialog.uninstall.confirm'), t('button.cancel')],
    defaultId: 1,
    cancelId: 1,
    title: t('dialog.uninstall.title'),
    message: t('dialog.uninstall.message'),
    detail: t('dialog.uninstall.detail', { dir }),
  });
  if (res.response !== 0) return { done: false, reason: 'annule' };

  clientReady = false;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    fs.rmSync(manifestFile, { force: true });
  } catch (err) {
    sendStatus('error', 'error.generic', { message: err.message });
    return { done: false, reason: err.message };
  }
  logLine('INFO', 'client desinstalle :', dir);
  sendVersions();
  sendStatus('needs-install', 'status.uninstalled');
  return { done: true };
});

ipcMain.on('open-game-folder', () => {
  const dir = getInstallDir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
ipcMain.on('open-log', () => shell.openPath(logFile));
ipcMain.on('open-discord', () => config.discordUrl && shell.openExternal(config.discordUrl));
ipcMain.on('open-releases', () =>
  shell.openExternal('https://github.com/' + config.githubOwner + '/' + config.githubRepo + '/releases')
);
ipcMain.on('open-site-page', (_event, pagePath) => {
  if (config.siteUrl) shell.openExternal(config.siteUrl.replace(/\/$/, '') + pagePath);
});

ipcMain.on('close-launcher', () => {
  if (settings.get('minimizeToTray') && tray) {
    mainWindow.hide();
    return;
  }
  quitting = true;
  app.quit();
});
ipcMain.on('minimize-launcher', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

// ---------------------------------------------------------------------------------------------
// Demarrage
// ---------------------------------------------------------------------------------------------

// Une seule instance : relancer le raccourci ramene la fenetre au lieu d'ouvrir un doublon.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', montrerFenetre);

  app.whenReady().then(() => {
    settings = new Settings(settingsFile, String(app.getLocale() || 'fr').slice(0, 2));
    appliquerTray();
    createWindow();
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
