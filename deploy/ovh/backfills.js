// Rattrapages lancés par le serveur lui-même (demandé par Sacha, 2026-11-05 : « can't we do it another way? »). Le
// compteur par nombre, les propriétaires de badges et le Hall of Fame ne s'affichent qu'une fois leur rattrapage fait
// (nc:ready, bown:ready, hof:ready) ; plus besoin de le lancer à la main sur le VPS : au démarrage de l'API, chaque
// rattrapage pas encore fait part tout seul, l'un après l'autre.
// - Dans un processus à part (node tools/backfill-*.js --apply, en priorité basse avec nice) : relire des millions de
//   tirages ne bloque jamais les requêtes des joueurs.
// - Un verrou Redis (bfjob:<nom>, 6 h) : un seul lancement même si l'API redémarre pendant ce temps.
// - Une fois le drapeau posé, plus rien ne se lance : ensuite chaque tirage tient lui-même ces compteurs à jour.
// La sortie de chaque rattrapage va dans le journal du service (journalctl -u rng-api).
'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const JOBS = [
  { name: 'number-counts', ready: 'nc:ready', script: 'tools/backfill-number-counts.js' },
  { name: 'badge-owners', ready: 'bown:ready', script: 'tools/backfill-badge-owners.js' },
  { name: 'hof', ready: 'hof:ready', script: 'tools/backfill-hof.js' },
];
const LOCK_S = 6 * 3600;

function run(job) {
  return new Promise(resolve => {
    // nice : le rattrapage passe après l'API si le processeur est occupé ; même environnement (base, jeton).
    const child = spawn('nice', ['-n', '10', process.execPath, path.join(ROOT, job.script), '--apply'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = d => String(d).split('\n').filter(Boolean).forEach(l => console.log(`backfill ${job.name}: ${l}`));
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', err => { console.error(`backfill ${job.name}: ${err.message}`); resolve(false); });
    child.on('close', code => { console.log(`backfill ${job.name}: fini (code ${code})`); resolve(code === 0); });
  });
}

// redis : la fonction de api/_lib.js. Attend un peu après le démarrage (la page se recharge, les joueurs reviennent).
async function start(redis, delayMs = 120000) {
  await new Promise(r => setTimeout(r, delayMs).unref());
  for (const job of JOBS) {
    try {
      const [ready] = await redis([['GET', job.ready]]);
      if (ready) continue;
      const [lock] = await redis([['SET', `bfjob:${job.name}`, String(Date.now()), 'EX', LOCK_S, 'NX']]);
      if (lock !== 'OK') { console.log(`backfill ${job.name}: déjà en cours ailleurs`); continue; }
      console.log(`backfill ${job.name}: démarrage`);
      const ok = await run(job);
      // Échec : le verrou est levé pour qu'un prochain démarrage réessaie.
      if (!ok) await redis([['DEL', `bfjob:${job.name}`]]);
    } catch (err) { console.error(`backfill ${job.name}: ${err.message}`); }
  }
}

module.exports = { start, JOBS };
