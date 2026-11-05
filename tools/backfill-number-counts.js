// Rattrapage unique (2026-11-05) du compteur par nombre « nc » (idée d'un ami de Sacha : afficher combien de fois le
// nombre tiré l'a déjà été). api/_lib.js recordRoll compte chaque tirage normal depuis le déploiement (nc:since = heure
// du premier compté) ; ce script ajoute les tirages plus anciens, lus dans les historiques des joueurs (hist:<id>, les
// 100 000 derniers tirages de chacun : les plus vieux des très gros joueurs et les tirages hors ligne ne sont pas là).
// Seuls les tirages d'avant nc:since sont lus : rien n'est compté deux fois. Puis nc:ready : le site affiche le total.
//   node tools/backfill-number-counts.js            → compte et affiche, n'écrit rien
//   node tools/backfill-number-counts.js --apply    → ajoute les totaux à « nc » et pose nc:ready (une seule fois)
const L = require('../api/_lib');
const MAX = 1000000;

async function backfill({ apply = false, log = console.log, now = Date.now() } = {}) {
  const [since, ready] = await L.redis([['GET', L.NUM_COUNT_SINCE], ['GET', L.NUM_COUNT_READY]]);
  if (ready) { log(`Déjà fait (nc:ready = ${new Date(Number(ready)).toISOString()}) : rien à refaire.`); return null; }
  // Aucun tirage compté encore : tout l'historique jusqu'à maintenant (et nc:since posé à maintenant si --apply).
  const until = Number(since) || now;
  const keys = [];
  let cursor = '0';
  do {
    const [[next, batch]] = await L.redis([['SCAN', cursor, 'MATCH', 'hist:*', 'COUNT', 1000]]);
    cursor = String(next);
    for (const k of batch || []) if (/^hist:[0-9a-f]{16}$/.test(k)) keys.push(k);
  } while (cursor !== '0');
  const counts = new Uint32Array(MAX + 1);
  let total = 0;
  for (let i = 0; i < keys.length; i += 50) {
    const lists = await L.redis(keys.slice(i, i + 50).map(k => ['ZRANGEBYSCORE', k, '-inf', `(${until}`]));
    for (const list of lists) for (const m of list || []) {
      const n = Number(String(m).split(':')[1]);
      if (Number.isInteger(n) && n >= 0 && n <= MAX) { counts[n]++; total++; }
    }
  }
  let distinct = 0, top = 0;
  for (let n = 0; n <= MAX; n++) { if (counts[n]) distinct++; if (counts[n] > counts[top]) top = n; }
  log(`${keys.length} historiques, ${total} tirages d'avant ${new Date(until).toISOString()}, ${distinct} nombres différents.`);
  log(`Le plus tiré : ${top} (${counts[top]} fois). Jamais tirés : ${MAX + 1 - distinct}.`);
  if (!apply) { log('Essai à blanc : rien écrit. Relancer avec --apply pour ajouter ces totaux et afficher le compteur.'); return { total, distinct, top, counts }; }
  // Par commandes de 500 nombres, 10 commandes par requête.
  let ops = [], cmd = null;
  for (let n = 0; n <= MAX; n++) {
    if (!counts[n]) continue;
    if (!cmd) cmd = ['BITFIELD', L.NUM_COUNT_KEY];
    cmd.push('INCRBY', 'u32', `#${n}`, counts[n]);
    if (cmd.length >= 2 + 4 * 500) { ops.push(cmd); cmd = null; }
    if (ops.length >= 10) { await L.redis(ops); ops = []; }
  }
  if (cmd) ops.push(cmd);
  if (ops.length) await L.redis(ops);
  await L.redis([['SET', L.NUM_COUNT_SINCE, until, 'NX'], ['SET', L.NUM_COUNT_READY, Date.now()]]);
  log(`Compteur « nc » rattrapé (${total} tirages) ; le site affiche maintenant combien de fois chaque nombre a été tiré.`);
  return { total, distinct, top, counts };
}
module.exports = { backfill }; // tools/test-api.mjs le lance sur le faux Redis
if (require.main === module) backfill({ apply: process.argv.includes('--apply') }).then(() => process.exit(0), err => { console.error(err); process.exit(1); });
