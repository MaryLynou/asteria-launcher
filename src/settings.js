/**
 * Reglages du launcher, dans userData/settings.json.
 *
 * Toute valeur inconnue ou hors domaine est remplacee par le defaut : un fichier corrompu ou
 * ecrit a la main ne doit jamais empecher le launcher de demarrer.
 */
const fs = require('fs');
const path = require('path');

const WINDOW_SIZES = {
  small: { width: 940, height: 600 },
  medium: { width: 1060, height: 690 },
  large: { width: 1220, height: 780 },
};

const SCHEMA = {
  lang: { defaut: 'fr', valeurs: ['fr', 'en', 'es'] },
  arch: { defaut: 'x64', valeurs: ['x64', 'x86'] },
  installDir: { defaut: null, type: 'string-ou-null' },
  autoUpdate: { defaut: true, type: 'bool' },
  closeOnLaunch: { defaut: false, type: 'bool' }, // le launcher reste ouvert : demande explicite
  startWithWindows: { defaut: false, type: 'bool' },
  minimizeToTray: { defaut: false, type: 'bool' },
  notifyUpdateAvailable: { defaut: true, type: 'bool' },
  notifyUpdateDone: { defaut: true, type: 'bool' },
  notifyNews: { defaut: true, type: 'bool' },
  notifyServerBack: { defaut: false, type: 'bool' },
  accent: { defaut: 'royal', valeurs: ['royal', 'gold', 'indigo', 'cyan', 'violet'] },
  windowSize: { defaut: 'medium', valeurs: Object.keys(WINDOW_SIZES) },
  animations: { defaut: true, type: 'bool' },
  sounds: { defaut: false, type: 'bool' },
  lastSeenNews: { defaut: null, type: 'string-ou-null' },
};

function defauts() {
  const out = {};
  for (const cle of Object.keys(SCHEMA)) out[cle] = SCHEMA[cle].defaut;
  return out;
}

function valide(cle, valeur) {
  const regle = SCHEMA[cle];
  if (!regle) return undefined;
  if (regle.valeurs) return regle.valeurs.includes(valeur) ? valeur : regle.defaut;
  if (regle.type === 'bool') return typeof valeur === 'boolean' ? valeur : regle.defaut;
  if (regle.type === 'string-ou-null') {
    if (valeur === null) return null;
    return typeof valeur === 'string' && valeur.trim() ? valeur : regle.defaut;
  }
  return regle.defaut;
}

class Settings {
  constructor(fichier, langueSysteme) {
    this.fichier = fichier;
    this.valeurs = defauts();
    if (langueSysteme && SCHEMA.lang.valeurs.includes(langueSysteme)) this.valeurs.lang = langueSysteme;

    let stocke = null;
    try {
      stocke = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    } catch (e) {
      stocke = null; // premier lancement, ou fichier illisible : on repart des defauts
    }
    if (stocke && typeof stocke === 'object') {
      for (const cle of Object.keys(SCHEMA)) {
        if (cle in stocke) this.valeurs[cle] = valide(cle, stocke[cle]);
      }
    }
  }

  tout() {
    return Object.assign({}, this.valeurs);
  }

  get(cle) {
    return this.valeurs[cle];
  }

  /** Ecrit une valeur validee et retourne ce qui a reellement ete retenu. */
  set(cle, valeur) {
    if (!(cle in SCHEMA)) return undefined;
    this.valeurs[cle] = valide(cle, valeur);
    this.sauve();
    return this.valeurs[cle];
  }

  sauve() {
    try {
      fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
      fs.writeFileSync(this.fichier, JSON.stringify(this.valeurs, null, 1), 'utf8');
    } catch (e) {
      // un reglage non sauvegarde ne doit pas interrompre le launcher
    }
  }
}

module.exports = { Settings, WINDOW_SIZES };
