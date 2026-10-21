// Rattrapage unique (2026-10-21) : les raretés Garbage et Land waste sont arrivées après coup ; les anciens tirages de ces
// raretés étaient comptés en Trash. Pour chaque joueur, on déplace l'écart (historique − compteur) de Trash vers la bonne
// rareté (titres Garbage Collector / Land Waster, pièces au tarif de la rareté).   node tools/migrate-low.js [--apply]
const L = require('../api/_lib');
const APPLY = process.argv.includes('--apply');
(async () => {
  const [flat] = await L.redis([['HGETALL', 'names']]);
  let n = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const id = flat[i], name = flat[i + 1];
    const [done] = await L.redis([['SISMEMBER', 'migrate:low', id]]);
    if (Number(done) === 1) continue;
    const [hist, st] = await L.redis([['ZRANGE', L.historyKey(id), 0, -1], ['HMGET', `stats:${id}`, 't:landwaste', 't:garbage', 't:trash']]);
    const seen = new Set(), cnt = { landwaste: 0, garbage: 0 };
    for (const m of hist || []) { if (seen.has(m)) continue; seen.add(m); const t = L.engine.analyze(Number(String(m).split(':')[1])).tier; if (t in cnt) cnt[t]++; }
    let trash = Number(st[2]) || 0;
    const w = [];
    for (const [tier, have] of [['landwaste', Number(st[0]) || 0], ['garbage', Number(st[1]) || 0]]) {
      const miss = Math.min(cnt[tier] - have, trash);
      if (miss > 0) { w.push(['HINCRBY', `stats:${id}`, `t:${tier}`, miss], ['HINCRBY', `stats:${id}`, 't:trash', -miss]); trash -= miss; console.log(`  ${name}: +${miss} ${tier}`); }
    }
    if (w.length) n++;
    if (APPLY) await L.redis([...w, ['SADD', 'migrate:low', id]]);
  }
  console.log(`${n} joueur(s) ${APPLY ? 'mis à jour' : 'à mettre à jour (simulation)'}`);
})();
