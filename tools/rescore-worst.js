// Recalcule les classements Poubelle (pire tirage par joueur : de tous les temps, du jour, de la semaine, du mois) avec
// les badges actuels. Un classement garde le score du tirage au moment où il a été fait : quand de nouveaux badges
// arrivent, un ancien « pire tirage » peut valoir bien plus (signalé par Phong254, 2026-10-23 : 908203 et 608504 encore
// à 1 759 XP). À relancer après chaque `node tools/build.mjs` qui change les badges.
//   node tools/rescore-worst.js [--apply]
const L = require('../api/_lib');
const { redis, engine, scopes, WORST_LB, WORST_BEST, worstKeys } = L;
const APPLY = process.argv.includes('--apply');

(async () => {
  // Tous les joueurs présents sur une Poubelle : celle de toujours, et celles du jour, de la semaine et du mois en cours.
  const boards = [WORST_LB, ...scopes(Date.now()).filter(p => p.period !== 'all').map(p => worstKeys(p).lb)];
  const ids = [...new Set((await redis(boards.map(b => ['ZRANGE', b, 0, -1]))).flat())];
  let changed = 0;
  for (const id of ids) {
    const [hist, oldAll] = await redis([['ZRANGE', L.historyKey(id), 0, -1], ['HGET', WORST_BEST, id]]);
    const mins = new Map(); // clé du classement → { s, entry, best, ttl }
    for (const m of hist || []) {
      const [t, n] = String(m).split(':').map(Number);
      if (!Number.isFinite(n)) continue;
      const s = engine.analyze(n).total, entry = JSON.stringify({ n, s, t });
      const keys = [{ lb: WORST_LB, best: WORST_BEST, ttl: 0 }, ...scopes(t).filter(p => p.period !== 'all').map(p => ({ ...worstKeys(p), ttl: p.ttl }))];
      for (const k of keys) { const cur = mins.get(k.lb); if (!cur || s < cur.s) mins.set(k.lb, { s, entry, best: k.best, ttl: k.ttl }); }
    }
    const w = [];
    for (const [lb, v] of mins) {
      const [score, shown] = await redis([['ZSCORE', lb, id], ['HGET', v.best, id]]);
      if (score === null) continue; // période expirée : rien à recréer
      // Déjà juste : le bon score, et le nombre affiché vaut bien ce score (sinon un autre tirage au même score le remplace).
      let shownN = null; try { shownN = JSON.parse(shown).n; } catch (e) { /* entrée illisible : on la réécrit */ }
      if (Number(score) === v.s && shownN !== null && engine.analyze(shownN).total === v.s) continue;
      w.push(['ZADD', lb, v.s, id], ['HSET', v.best, id, v.entry]);
      if (lb === WORST_LB || process.argv.includes('-v')) console.log(lb + ' ' + `  ${id.slice(0, 6)}: ${score} → ${v.s} (${JSON.parse(v.entry).n})${oldAll ? ` · avant ${JSON.parse(oldAll).n}` : ''}`);
    }
    if (w.length) { changed++; if (APPLY) await redis(w); }
  }
  console.log(`${changed} joueur(s) ${APPLY ? 'corrigé(s)' : 'à corriger (simulation, ajouter --apply)'}`);
})();
