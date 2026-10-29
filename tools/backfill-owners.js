// Rattrapage unique (2026-10-28) du hash « owners » (popularité des objets de la boutique, idée d'ann joe et de
// YU CHUAN 23) : compte, pour chaque objet, combien de joueurs le possèdent déjà, d'après les inventaires par joueur
// (skins:<id>, walls:<id>, btns:<id>, emotes:<id>, snds:<id>). SCAN par paquets, puis SMEMBERS par paquets de 200.
//   node tools/backfill-owners.js            → affiche les nombres et l'écart avec le hash actuel, n'écrit rien
//   node tools/backfill-owners.js --apply    → remplace le hash « owners » par ces nombres
// À lancer juste après le déploiement (api/shop.js incrémente déjà le hash à chaque achat ou caisse) : un achat fait
// pendant le comptage peut être compté deux fois ou pas du tout, l'écart est d'une unité au plus par achat.
const L = require('../api/_lib');
const Shop = require('../js/shop.js');
// préfixe de la clé → genre dans le hash (mêmes noms que les ventes de la page Owner, api/site.js)
const KINDS = { skins: 'skins', walls: 'walls', btns: 'buttons', emotes: 'emotes', snds: 'sounds' };
const CATALOG = { skins: Shop.byId, walls: Shop.wallById, buttons: Shop.buttonById, emotes: Shop.emoteById, sounds: Shop.soundById };

async function backfill({ apply = false, log = console.log } = {}) {
  const counts = {};
  for (const [prefix, kind] of Object.entries(KINDS)) {
    const keys = [];
    let cursor = '0';
    do {
      const [[next, batch]] = await L.redis([['SCAN', cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000]]);
      cursor = String(next);
      for (const k of batch || []) if (new RegExp(`^${prefix}:[0-9a-f]{16}$`).test(k)) keys.push(k);
    } while (cursor !== '0');
    for (let i = 0; i < keys.length; i += 200) {
      const sets = await L.redis(keys.slice(i, i + 200).map(k => ['SMEMBERS', k]));
      for (const list of sets) for (const raw of new Set((list || []).map(x => (kind === 'skins' ? Shop.resolve(x) : x)))) {
        const item = CATALOG[kind].get(raw);
        if (!item || item.hidden) continue; // objet retiré du catalogue, ou réservé (Owner…) : pas compté
        counts[`${kind}:${raw}`] = (counts[`${kind}:${raw}`] || 0) + 1;
      }
    }
    log(`${prefix}:* → ${keys.length} inventaires`);
  }
  const [flat] = await L.redis([['HGETALL', 'owners']]);
  const now = {};
  for (let i = 0; i < (flat || []).length; i += 2) now[flat[i]] = Number(flat[i + 1]) || 0;
  const fields = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  for (const f of fields) log(`${f.padEnd(28)} ${String(counts[f]).padStart(7)}   (hash actuel : ${now[f] || 0})`);
  log(`${fields.length} objets possédés par au moins un joueur.`);
  if (!apply) { log('Essai à blanc : rien écrit. Relancer avec --apply pour remplacer le hash « owners ».'); return counts; }
  const writes = [['DEL', 'owners']];
  for (let i = 0; i < fields.length; i += 100) writes.push(['HSET', 'owners', ...fields.slice(i, i + 100).flatMap(f => [f, counts[f]])]);
  await L.redis(writes);
  log(`Hash « owners » écrit : ${fields.length} champs.`);
  return counts;
}
module.exports = { backfill }; // tools/test-api.mjs le lance sur le faux Redis
if (require.main === module) backfill({ apply: process.argv.includes('--apply') }).catch(err => { console.error(err); process.exit(1); });
