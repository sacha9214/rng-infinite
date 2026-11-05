// Rattrapage unique (2026-11-05) du nombre de propriétaires de chaque badge (idée de Tumored, 2026-10-31 : « give every
// badge an owner counter »). api/_lib.js compte déjà, à chaque tirage, les badges qu'un joueur obtient pour la première
// fois (hash « bown », et « hbown » en mode difficile) ; ce script compte ceux que les joueurs avaient déjà, d'après
// leurs collections (badges:<id>, hbadges:<id>) : SCAN par paquets, puis SMEMBERS par paquets de 200.
//   node tools/backfill-badge-owners.js            → affiche les nombres et l'écart avec le hash actuel, n'écrit rien
//   node tools/backfill-badge-owners.js --apply    → remplace « bown » et « hbown » par ces nombres
// À lancer juste après le déploiement : un badge obtenu pendant le comptage peut être compté deux fois ou pas du tout
// (une unité au plus par badge obtenu pendant ces quelques secondes). Relançable sans danger : il recompte tout.
// --apply pose aussi bown:ready : avant, le site n'affiche pas le compteur (il ne compterait que les nouveaux badges).
const L = require('../api/_lib');

const MODES = [
  { prefix: 'badges', hash: L.BADGE_OWNERS, known: L.engine.byId, label: 'normal' },
  { prefix: 'hbadges', hash: L.hardKey(L.BADGE_OWNERS), known: L.hardEngine().byId, label: 'difficile' },
];

async function backfill({ apply = false, log = console.log } = {}) {
  const result = {};
  for (const mode of MODES) {
    const keys = [], re = new RegExp(`^${mode.prefix}:[0-9a-f]{16}$`);
    let cursor = '0';
    do {
      const [[next, batch]] = await L.redis([['SCAN', cursor, 'MATCH', `${mode.prefix}:*`, 'COUNT', 1000]]);
      cursor = String(next);
      for (const k of batch || []) if (re.test(k)) keys.push(k);
    } while (cursor !== '0');
    const counts = {};
    for (let i = 0; i < keys.length; i += 200) {
      const sets = await L.redis(keys.slice(i, i + 200).map(k => ['SMEMBERS', k]));
      for (const list of sets) for (const id of new Set(list || [])) if (mode.known.has(id)) counts[id] = (counts[id] || 0) + 1; // badge retiré : pas compté
    }
    const [flat] = await L.redis([['HGETALL', mode.hash]]), now = {};
    for (let i = 0; i < (flat || []).length; i += 2) now[flat[i]] = Number(flat[i + 1]) || 0;
    const ids = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    log(`Mode ${mode.label} : ${keys.length} collections, ${ids.length} badges possédés par au moins un joueur.`);
    for (const id of ids) log(`  ${id.padEnd(28)} ${String(counts[id]).padStart(7)}   (hash actuel : ${now[id] || 0})`);
    result[mode.label] = counts;
    if (!apply) continue;
    const writes = [['DEL', mode.hash]];
    for (let i = 0; i < ids.length; i += 100) writes.push(['HSET', mode.hash, ...ids.slice(i, i + 100).flatMap(id => [id, counts[id]])]);
    await L.redis(writes);
    log(`Hash « ${mode.hash} » écrit : ${ids.length} champs.`);
  }
  if (!apply) log('Essai à blanc : rien écrit. Relancer avec --apply pour remplacer « bown » et « hbown ».');
  else { await L.redis([['SET', require('../api/_hof').OWNERS_READY, Date.now()]]); log('Le compteur s\'affiche maintenant sur le site.'); }
  return result;
}
module.exports = { backfill }; // tools/test-api.mjs le lance sur le faux Redis
if (require.main === module) backfill({ apply: process.argv.includes('--apply') }).then(() => process.exit(0), err => { console.error(err); process.exit(1); });
