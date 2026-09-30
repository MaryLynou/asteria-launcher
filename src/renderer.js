/* =============================================================================================
   Interface du launcher. Le processus principal n'envoie que des cles de traduction et des
   donnees : tout le rendu, y compris le changement de langue a chaud, se fait ici.
   ============================================================================================= */

// i18n.js est charge en script classique : ses declarations (translate, LANGS, DICTS...) vivent
// dans la portee globale de la page. On passe donc par l'objet expose, sans rien redeclarer ici,
// sinon le second script casse sur « Identifier already declared ».
const I18N = window.ASTERIA_I18N;
const ACCENTS = ['royal', 'gold', 'indigo', 'cyan', 'violet'];

let lang = 'fr';
let reglages = {};
let etat = { launcher: '', client: null, installDir: '', arch: { x64: false, x86: false }, running: false };
let statutCourant = null;
let infoServeur = null;
let actualites = [];

const $ = (id) => document.getElementById(id);
const t = (cle, params) => I18N.translate(lang, cle, params);

// ---------------------------------------------------------------------------------------------
// Sons d'interface : synthetises a la volee, aucun fichier audio a embarquer.
// ---------------------------------------------------------------------------------------------

let audio = null;
function bip(frequence, duree, volume) {
  if (!reglages.sounds) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequence;
    gain.gain.setValueAtTime(0, audio.currentTime);
    gain.gain.linearRampToValueAtTime(volume, audio.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duree);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duree);
  } catch (e) {
    // pas de son disponible : sans importance
  }
}
const sonClic = () => bip(660, 0.09, 0.05);
const sonLancement = () => { bip(523, 0.14, 0.07); setTimeout(() => bip(784, 0.24, 0.06), 110); };

// ---------------------------------------------------------------------------------------------
// Traduction de tout l'arbre
// ---------------------------------------------------------------------------------------------

function traduireTout() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  // les zones construites en JS se redessinent, elles ne portent pas d'attribut
  rendreStatut();
  rendreServeur();
  rendreActualites();
  rendreEtat();
  rendreSegmentsLangue();
}

// ---------------------------------------------------------------------------------------------
// Etat du client (versions, dossier, architectures disponibles)
// ---------------------------------------------------------------------------------------------

function rendreEtat() {
  $('version-line').textContent = 'v' + etat.launcher + (etat.client ? ' · ' + etat.client : '');
  $('about-launcher').textContent = 'v' + etat.launcher;
  $('about-client').textContent = etat.client || t('settings.about.clientNone');
  $('dir-text').textContent = etat.installDir;

  // Le choix 32/64 existe a deux endroits — sous le bouton Jouer et dans les reglages — et les
  // deux sont pilotes par le meme reglage. Une architecture que le client ne livre pas reste
  // visible mais grisee : mieux vaut une option manifestement indisponible qu'une option absente.
  for (const bouton of document.querySelectorAll('[data-setting="arch"]')) {
    const arch = bouton.dataset.value;
    const dispo = !!(etat.arch && etat.arch[arch]);
    const nom = t(arch === 'x64' ? 'settings.game.arch64' : 'settings.game.arch32');
    const detail = dispo
      ? t(arch === 'x64' ? 'settings.game.arch64Help' : 'settings.game.arch32Help')
      : t('settings.game.archUnavailable');
    bouton.disabled = !dispo;
    bouton.classList.toggle('active', reglages.arch === arch);
    bouton.title = nom + ' — ' + detail;
    const aide = $('arch-' + arch + '-help');
    if (aide) aide.textContent = detail;
  }
}

// ---------------------------------------------------------------------------------------------
// Etat du serveur
// ---------------------------------------------------------------------------------------------

function rendreServeur() {
  if (!infoServeur) return;
  const { online, playersOnline } = infoServeur;
  const libelle = online ? t('server.online') : t('server.offline');
  for (const id of ['dot-side', 'dot-hero']) $(id).className = 'dot ' + (online ? 'online' : 'offline');
  $('server-side').textContent = t('server.label') + ' : ' + libelle;
  $('server-hero').textContent = libelle;
  $('players-text').textContent =
    typeof playersOnline === 'number' ? t('server.players', { n: playersOnline }) : t('server.playersUnknown');
}

// ---------------------------------------------------------------------------------------------
// Actualites
// ---------------------------------------------------------------------------------------------

function rendreActualites() {
  const grille = $('news-grid');
  grille.textContent = '';
  if (!actualites.length) {
    const vide = document.createElement('div');
    vide.className = 'news-empty';
    vide.textContent = t('news.empty');
    grille.appendChild(vide);
    return;
  }
  const format = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  for (const post of actualites.slice(0, 3)) {
    const carte = document.createElement('div');
    carte.className = 'news-card';

    const date = document.createElement('div');
    date.className = 'news-date';
    date.textContent = post.published_at ? format.format(new Date(post.published_at)) : '';

    const titre = document.createElement('div');
    titre.className = 'news-title';
    titre.textContent = post.title || '';

    const extrait = document.createElement('div');
    extrait.className = 'news-excerpt';
    extrait.textContent = post.excerpt || '';

    carte.append(date, titre, extrait);
    carte.addEventListener('click', () => {
      sonClic();
      window.asteria.openSitePage('/actualites/' + post.slug);
    });
    grille.appendChild(carte);
  }
}

// ---------------------------------------------------------------------------------------------
// Statut et bouton principal
// ---------------------------------------------------------------------------------------------

// phase -> [cle du libelle, bouton actif, action]
const BOUTONS = {
  ready: ['button.play', true, 'play'],
  running: ['button.replay', true, 'play'],
  'needs-install': ['button.install', true, 'update'],
  'update-available': ['button.update', true, 'update'],
  error: ['button.retry', true, 'retry'],
  'integrity-error': ['button.repair', true, 'repair'],
  launching: ['button.launching', false, null],
  verifying: ['button.verifying', false, null],
  'launcher-update': ['button.updating', false, null],
};
let actionBouton = null;

function rendreStatut() {
  const s = statutCourant;
  const bouton = $('play-btn');
  const piste = $('track');
  const barre = $('fill');

  if (!s) {
    bouton.textContent = t('button.wait');
    bouton.disabled = true;
    return;
  }

  $('status-text').textContent = t(s.key, s.params);
  $('speed-text').textContent = s.phase === 'downloading' && s.params && s.params.speed ? s.params.speed : '';
  $('pct-text').textContent = typeof s.percent === 'number' ? s.percent + ' %' : '';

  const indetermine = ['checking', 'extracting', 'verifying'].includes(s.phase);
  piste.classList.toggle('indeterminate', indetermine);
  piste.classList.toggle('error', s.phase === 'error' || s.phase === 'integrity-error');
  if (typeof s.percent === 'number') barre.style.width = s.percent + '%';
  else if (s.phase === 'ready' || s.phase === 'running' || s.phase === 'launching') barre.style.width = '100%';
  else if (indetermine) barre.style.width = '34%';
  else if (s.phase === 'needs-install' || s.phase === 'update-available') barre.style.width = '0%';

  const [cle, actif, action] = BOUTONS[s.phase] || ['button.wait', false, null];
  bouton.textContent = t(cle);
  bouton.disabled = !actif;
  actionBouton = action;

  const verif = $('check-btn');
  const occupe = ['downloading', 'extracting', 'verifying', 'checking', 'launcher-update'].includes(s.phase);
  verif.classList.toggle('spin', occupe);
  verif.disabled = occupe;
}

// ---------------------------------------------------------------------------------------------
// Reglages
// ---------------------------------------------------------------------------------------------

function appliquerReglages() {
  lang = reglages.lang || 'fr';
  document.documentElement.dataset.accent = reglages.accent || 'royal';
  document.documentElement.dataset.animations = reglages.animations ? 'on' : 'off';

  for (const sw of document.querySelectorAll('.switch[data-setting]')) {
    sw.setAttribute('aria-checked', reglages[sw.dataset.setting] ? 'true' : 'false');
  }
  // Tout controle porteur de data-setting + data-value pilote un reglage, quelle que soit son
  // apparence : les segments des parametres comme le selecteur 32/64 de l'ecran principal.
  for (const seg of document.querySelectorAll('[data-setting][data-value]')) {
    seg.classList.toggle('active', reglages[seg.dataset.setting] === seg.dataset.value);
  }
  for (const pastille of document.querySelectorAll('.swatch')) {
    pastille.classList.toggle('active', reglages.accent === pastille.dataset.value);
  }
  traduireTout();
}

async function changerReglage(cle, valeur) {
  sonClic();
  reglages = await window.asteria.setSetting(cle, valeur);
  appliquerReglages();
}

function construirePastilles() {
  const boite = $('accent-swatches');
  for (const nom of ACCENTS) {
    const bouton = document.createElement('button');
    bouton.className = 'swatch';
    bouton.dataset.value = nom;
    bouton.title = t('settings.appearance.accent.' + nom);
    bouton.addEventListener('click', () => changerReglage('accent', nom));
    boite.appendChild(bouton);
  }
}

function rendreSegmentsLangue() {
  const boite = $('lang-segments');
  boite.textContent = '';
  for (const { code, label, flag } of I18N.LANGS) {
    const bouton = document.createElement('button');
    bouton.className = 'segment compact' + (lang === code ? ' active' : '');
    bouton.textContent = flag + '  ' + label;
    bouton.addEventListener('click', () => changerReglage('lang', code));
    boite.appendChild(bouton);
  }
}

// ---------------------------------------------------------------------------------------------
// Branchements
// ---------------------------------------------------------------------------------------------

function ouvrirParametres(ouvert) {
  sonClic();
  $('overlay').classList.toggle('open', ouvert);
  $('nav-settings').classList.toggle('active', ouvert);
  $('nav-play').classList.toggle('active', !ouvert);
}

function brancher() {
  $('btn-min').addEventListener('click', () => window.asteria.minimizeLauncher());
  $('btn-close').addEventListener('click', () => window.asteria.closeLauncher());
  $('nav-settings').addEventListener('click', () => ouvrirParametres(true));
  $('nav-play').addEventListener('click', () => ouvrirParametres(false));
  $('settings-close').addEventListener('click', () => ouvrirParametres(false));
  $('nav-discord').addEventListener('click', () => { sonClic(); window.asteria.openDiscord(); });
  $('about-discord').addEventListener('click', () => { sonClic(); window.asteria.openDiscord(); });
  $('news-all').addEventListener('click', () => window.asteria.openSitePage('/actualites'));

  for (const el of document.querySelectorAll('[data-page]')) {
    el.addEventListener('click', () => { sonClic(); window.asteria.openSitePage(el.dataset.page); });
  }

  $('play-btn').addEventListener('click', () => {
    if ($('play-btn').disabled) return;
    if (actionBouton === 'retry') window.asteria.retryInit();
    else if (actionBouton === 'repair') window.asteria.requestRepair();
    else if (actionBouton === 'update') window.asteria.checkUpdates();
    else { sonLancement(); window.asteria.requestPlay(); }
  });

  const verifier = () => { sonClic(); window.asteria.checkUpdates(); };
  $('check-btn').addEventListener('click', verifier);
  $('check-btn-2').addEventListener('click', verifier);

  $('repair-btn').addEventListener('click', () => { sonClic(); window.asteria.requestRepair(); ouvrirParametres(false); });
  $('folder-btn').addEventListener('click', () => { sonClic(); window.asteria.openGameFolder(); });
  $('log-btn').addEventListener('click', () => { sonClic(); window.asteria.openLog(); });
  $('about-history').addEventListener('click', () => { sonClic(); window.asteria.openReleases(); });
  $('dir-btn').addEventListener('click', async () => {
    sonClic();
    const res = await window.asteria.chooseInstallDir();
    if (res && res.changed) ouvrirParametres(false);
  });
  $('uninstall-btn').addEventListener('click', async () => {
    sonClic();
    const res = await window.asteria.uninstallClient();
    if (res && res.done) ouvrirParametres(false);
  });

  for (const sw of document.querySelectorAll('.switch[data-setting]')) {
    sw.addEventListener('click', () => changerReglage(sw.dataset.setting, sw.getAttribute('aria-checked') !== 'true'));
  }
  for (const seg of document.querySelectorAll('[data-setting][data-value]')) {
    seg.addEventListener('click', () => {
      if (seg.disabled) return;
      changerReglage(seg.dataset.setting, seg.dataset.value);
    });
  }

  for (const onglet of document.querySelectorAll('.tab')) {
    onglet.addEventListener('click', () => {
      sonClic();
      for (const autre of document.querySelectorAll('.tab')) autre.classList.toggle('active', autre === onglet);
      for (const pane of document.querySelectorAll('.pane')) {
        pane.classList.toggle('active', pane.dataset.pane === onglet.dataset.tab);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('overlay').classList.contains('open')) ouvrirParametres(false);
  });
}

// ---------------------------------------------------------------------------------------------
// Flux du processus principal
// ---------------------------------------------------------------------------------------------

window.asteria.onStatus((s) => {
  const avant = statutCourant && statutCourant.phase;
  statutCourant = s;
  rendreStatut();
  if (s.phase === 'ready' && avant && avant !== 'ready' && avant !== 'running') sonClic();
});
window.asteria.onServerInfo((info) => { infoServeur = info; rendreServeur(); });
window.asteria.onVersions((v) => { etat = v; rendreEtat(); });
window.asteria.onNews((posts) => { actualites = posts || []; rendreActualites(); });

(async function demarrer() {
  reglages = await window.asteria.getSettings();
  etat = await window.asteria.getState();
  construirePastilles();
  brancher();
  appliquerReglages();

  // Un statut peut etre arrive avant que la page soit prete (verification des mises a jour).
  const dernier = await window.asteria.getStatus();
  if (dernier) { statutCourant = dernier; rendreStatut(); }
  const posts = await window.asteria.getNews();
  if (posts && posts.length) { actualites = posts; rendreActualites(); }
})();
