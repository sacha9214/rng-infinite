// Rattrapage unique (2026-10-21) : titre Collectible Connoisseur pour ceux qui ont déjà tous les skins hors limités,
// et liste des anciens tirages de 852655 (nouveau badge exact) à reclasser.   node tools/migrate-collect.js [--apply]
const L = require('../api/_lib');
const Shop = require('../js/shop.js');
const APPLY = process.argv.includes('--apply');
(async () => {
  const [flat] = await L.redis([['HGETALL', 'names']]);
  const need = Shop.collectible();
  for (let i = 0; i < flat.length; i += 2) {
    const id = flat[i], name = flat[i + 1];
    const [owned, hist] = await L.redis([['SMEMBERS', `skins:${id}`], ['ZRANGE', L.historyKey(id), 0, -1]]);
    if (need.every(k => (owned || []).includes(k))) { console.log('connoisseur', name); if (APPLY) await L.redis([['HSET', `stats:${id}`, 'connoisseur', 1]]); }
    for (const m of hist || []) if (String(m).endsWith(':852655')) console.log('852655', name, new Date(Number(String(m).split(':')[0])).toISOString());
  }
})();
