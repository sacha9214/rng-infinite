// Reclassement unique (2026-10-20) : 235 (nouveau badge Exact Drastix) et 2016 (The Golden Era remis au niveau des
// autres badges exacts) passent de Mythic à Godlike. Pour chaque ancien tirage de ces nombres : compteur de rareté
// (donc les pièces), XP à vie, badges, meilleur tirage et classements de la période du tirage.
// À lancer sur le VPS après le déploiement :  node tools/migrate-exact.js [--apply]
const L = require('../api/_lib');
const { redis, engine, scopes, XP_LB } = L;
const OLD = { 235: { tier: 'mythic', s: 370278 }, 2016: { tier: 'mythic', s: 240597 } };
const APPLY = process.argv.includes('--apply');

(async () => {
  const [flat] = await redis([['HGETALL', 'names']]);
  const ids = []; for (let i = 0; i < flat.length; i += 2) ids.push([flat[i], flat[i + 1]]);
  let touched = 0;
  for (const [id, name] of ids) {
    const [members, done] = await redis([['ZRANGE', L.historyKey ? L.historyKey(id) : `hist:${id}`, 0, -1], ['SISMEMBER', 'migrate:exact2', id]]);
    if (Number(done) === 1) continue;
    const hits = [];
    const seen = new Set();
    for (const m of members || []) {
      const [t, n] = String(m).split(':').map(Number);
      if (!(n in OLD) || seen.has(m)) continue;
      seen.add(m); hits.push({ t, n });
    }
    if (!hits.length) continue;
    touched++;
    const w = [];
    let xp = 0;
    for (const { t, n } of hits) {
      const a = engine.analyze(n), o = OLD[n], s = a.total;
      if (a.tier !== o.tier) w.push(['HINCRBY', `stats:${id}`, `t:${o.tier}`, -1], ['HINCRBY', `stats:${id}`, `t:${a.tier}`, 1]);
      xp += s - o.s;
      w.push(['SADD', `badges:${id}`, ...a.earnedIds]);
      const entry = JSON.stringify({ n, s, t });
      for (const p of scopes(t)) {
        const [cur] = await redis([['ZSCORE', p.lb, id]]);
        if (cur !== null && Number(cur) >= s) continue;
        if (cur === null && p.period !== 'all') continue; // période expirée : rien à recréer
        w.push(['ZADD', p.lb, s, id], ['HSET', p.best, id, entry]);
      }
      console.log(`  ${name}: ${n} (${new Date(t).toISOString().slice(0, 10)}) ${o.tier} ${o.s} → ${a.tier} ${s}`);
    }
    const [best, hasXp, onLb] = await redis([['HGET', `stats:${id}`, 'best'], ['HEXISTS', `stats:${id}`, 'xpLife'], ['ZSCORE', XP_LB, id]]);
    const top = Math.max(...hits.map(h => engine.analyze(h.n).total));
    if (top > Number(best || 0)) w.push(['HSET', `stats:${id}`, 'best', top]);
    // XP à vie : seulement là où il est déjà tenu (sinon il est recalculé depuis l'historique, déjà juste).
    if (Number(hasXp) === 1) w.push(['HINCRBY', `stats:${id}`, 'xpLife', xp]);
    if (onLb !== null) w.push(['ZINCRBY', XP_LB, xp, id]);
    w.push(['SADD', 'migrate:exact2', id]);
    if (APPLY) await redis(w);
  }
  console.log(`${touched} joueur(s) ${APPLY ? 'mis à jour' : 'à mettre à jour (simulation, ajouter --apply)'}`);
})();
