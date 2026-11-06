// Rattrapage unique (2026-11-06) des créateurs d'objets (champ idea de js/shop.js) : chaque pseudo crédité est figé sur
// l'id de son joueur dans le hash « ideaby » (voir ideaAuthor dans api/_lib.js). Signalé par casmictechthing : un
// créateur qui avait changé de pseudo ne touchait plus sa part de 5 % sur ses objets, ni ne les voyait dans « Your
// creations », et celui qui reprenait l'ancien pseudo l'aurait touchée.
// Qui est le créateur d'un pseudo crédité :
//   1. le joueur qui a envoyé une idée sous ce pseudo (sugg:<id>, champ pid, pseudo de l'époque) : il le reste même
//      s'il a changé de pseudo depuis, ou si quelqu'un a repris l'ancien ; plusieurs joueurs différents sous le même
//      pseudo → celui qui porte ce pseudo aujourd'hui s'il en fait partie, sinon rien (à régler à la main) ;
//   2. sinon, le joueur qui porte ce pseudo aujourd'hui (findPlayer), comme avant.
// Rien n'est remplacé : un pseudo déjà figé reste tel quel (HSETNX).
//   node tools/backfill-idea-authors.js            → affiche ce qu'il a trouvé, n'écrit rien
//   node tools/backfill-idea-authors.js --apply    → écrit dans « ideaby » et pose ideaby:ready
const L = require('../api/_lib');
const Shop = require('../js/shop.js');
const READY = 'ideaby:ready';

async function backfill({ apply = false, log = console.log } = {}) {
  const shown = new Map(); // clé du pseudo → pseudo tel qu'écrit dans js/shop.js
  for (const x of [...Shop.SKINS, ...Shop.WALLPAPERS]) if (x.idea) shown.set(L.nameKey(x.idea), x.idea);
  // Idées envoyées : clé du pseudo de l'époque → ids des joueurs qui l'ont utilisé.
  const [ids] = await L.redis([['ZRANGE', 'sugg:all', 0, -1]]), senders = new Map();
  for (let i = 0; i < (ids || []).length; i += 300) {
    const rows = await L.redis(ids.slice(i, i + 300).map(id => ['HMGET', `sugg:${id}`, 'name', 'pid']));
    for (const [name, pid] of rows) {
      const k = L.nameKey(name || '');
      if (!k || !pid || !shown.has(k)) continue;
      if (!senders.has(k)) senders.set(k, new Set());
      senders.get(k).add(pid);
    }
  }
  const keys = [...shown.keys()], [frozen] = await L.redis([['HMGET', L.IDEA_BY, ...keys]]);
  const writes = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], name = shown.get(k);
    if (frozen && frozen[i]) { log(`  ${name.padEnd(24)} déjà figé`); continue; }
    const now = await L.findPlayer(name), from = senders.get(k);
    let id = null, why = '';
    if (from && from.size === 1) { id = [...from][0]; why = id === now ? 'idée envoyée sous ce pseudo' : now ? 'idée envoyée sous ce pseudo (le pseudo est porté par un autre aujourd\'hui)' : 'idée envoyée sous ce pseudo (renommé depuis)'; }
    else if (from && from.size > 1) { id = now && from.has(now) ? now : null; why = id ? 'plusieurs joueurs, celui qui porte le pseudo' : 'plusieurs joueurs sous ce pseudo : à régler à la main'; }
    else { id = now; why = now ? 'porte ce pseudo' : 'introuvable'; }
    log(`  ${name.padEnd(24)} ${id ? id.slice(0, 4) + '…' : '—'.padEnd(5)} ${why}`);
    if (id) writes.push(['HSETNX', L.IDEA_BY, k, id]);
  }
  if (!apply) { log(`Essai à blanc : rien écrit. Relancer avec --apply pour figer ${writes.length} pseudos.`); return { writes: writes.length }; }
  await L.redis([...writes, ['SET', READY, Date.now()]]);
  log(`ideaby : ${writes.length} pseudos figés.`);
  return { writes: writes.length };
}
module.exports = { backfill, READY };
if (require.main === module) backfill({ apply: process.argv.includes('--apply') }).then(() => process.exit(0), err => { console.error(err); process.exit(1); });
