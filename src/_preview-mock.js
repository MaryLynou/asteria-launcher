// Faux pont pour regarder l'interface dans un navigateur, sans Electron. Fichier de travail :
// il est supprime apres verification et n'a jamais vocation a etre livre.
const ETAT = {
  launcher: '1.2.0', client: 'v1.0.32',
  installDir: 'C:\Users\tonds\AppData\Roaming\Asteria\client',
  arch: { x64: true, x86: true }, running: false,
};
const REGLAGES = {
  lang: 'fr', arch: 'x64', installDir: null, autoUpdate: true, closeOnLaunch: false,
  startWithWindows: false, minimizeToTray: false, notifyUpdateAvailable: true,
  notifyUpdateDone: true, notifyNews: true, notifyServerBack: false,
  accent: 'royal', windowSize: 'medium', animations: true, sounds: false, lastSeenNews: null,
};
const ACTUS = [
  { slug: 'a', title: 'Patch 1.0.32', excerpt: "Franchir un rang de prestige vous remet désormais la panoplie qui va avec, et le site a été redessiné.", published_at: '2026-09-30T12:00:00Z' },
  { slug: 'b', title: 'Patch 1.0.31', excerpt: "Le butin des 28 boss Souverains, l'île de Moon rouverte, Grozilla et Grasmera enfin posés.", published_at: '2026-09-30T08:00:00Z' },
  { slug: 'c', title: 'Patch 1.0.30', excerpt: 'Les 20 panoplies du Prestige, treize nouvelles montures et le retour au point de sauvegarde.', published_at: '2026-09-29T17:00:00Z' },
];
const STATUT = { phase: 'ready', key: 'status.ready', params: null, percent: undefined };
const rien = () => {};
const rappels = {};
const ecoute = (nom) => (cb) => { rappels[nom] = cb; };
window.asteria = {
  onStatus: ecoute('status'), onServerInfo: ecoute('server'), onVersions: ecoute('versions'),
  onNews: ecoute('news'),
  getState: async () => ETAT,
  getSettings: async () => REGLAGES,
  getNews: async () => ACTUS,
  getStatus: async () => STATUT,
  setSetting: async (cle, valeur) => { REGLAGES[cle] = valeur; return REGLAGES; },
  chooseInstallDir: async () => ({ changed: false }),
  uninstallClient: async () => ({ done: false }),
  requestPlay: rien, retryInit: rien, requestRepair: rien, checkUpdates: rien,
  openGameFolder: rien, openLog: rien, openDiscord: rien, openReleases: rien, openSitePage: rien,
  closeLauncher: rien, minimizeLauncher: rien,
};
// Les evenements pousses par le processus principal, simules apres le chargement.
setTimeout(() => {
  if (rappels.server) rappels.server({ online: true, playersOnline: 37, at: Date.now() });
  if (rappels.versions) rappels.versions(ETAT);
}, 120);

// Pour essayer les autres etats depuis la console : __phase('downloading', 42)
window.__phase = (phase, percent, key, params) => {
  const s = { phase, percent, key: key || 'status.downloadFull', params: params || { version: 'v1.0.33', size: '0,7 Mo', speed: '2 Mo/s' } };
  if (phase === 'ready') { s.key = 'status.ready'; s.params = null; }
  if (rappels.status) rappels.status(s);
};
