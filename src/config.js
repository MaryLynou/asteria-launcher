module.exports = {
  githubOwner: 'MaryLynou',
  githubRepo: 'asteria-client',
  launcherRepo: 'asteria-launcher',

  // Le client est livre en deux executables : l'habillage Electron 64 bits a la racine, et le
  // projecteur Flash d'origine en 32 bits, dans le retroclient. Le launcher prend le premier
  // chemin present pour l'architecture choisie (chemins relatifs au dossier d'installation) et
  // l'option reste grisee si rien n'est trouve.
  clientExeName: 'Dofus Retro.exe',
  clientExeByArch: {
    x64: ['Dofus Retro.exe'],
    x86: ['resources/app/retroclient/Dofus.exe', 'Dofus Retro 32.exe'],
  },

  installDirName: 'Asteria',
  gameServerHost: '88.170.206.190',
  gameServerPort: 5555,
  supabaseUrl: 'https://izdupitqzwhmpulvfbvt.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml6ZHVwaXRxendobXB1bHZmYnZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMTA4ODMsImV4cCI6MjA5Mjg4Njg4M30.hC7lLBLzByiDh1zTZuOJudepzgkqNaUVKGddIHytPM0',
  discordUrl: 'https://discord.gg/bxGVnqJpbA',
  siteUrl: 'https://asteria-site-psi.vercel.app',
};
