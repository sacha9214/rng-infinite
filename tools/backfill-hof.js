// Rattrapage unique (2026-11-05) du Hall of Fame (idée d'Avaneesh_17 ; api/_hof.js). Depuis le déploiement, chaque
// tirage pose lui-même les paliers qu'il atteint ; ce script retrouve les premiers d'avant, d'après ce que le serveur a
// gardé. Ce qu'il ne peut PAS retrouver :
//   - les tirages hors ligne (jamais envoyés) et, pour les joueurs à plus de 100 000 tirages, leurs plus vieux tirages
//     (hist:<id> ne garde que les 100 000 derniers) : un Infinite tiré là est perdu, sauf s'il est resté le meilleur tirage
//     du joueur (best:all, lu aussi) ;
//   - l'heure exacte d'un palier d'XP ou de tirages franchi avant le plus vieux tirage gardé : le palier est alors daté
//     de ce plus vieux tirage, marqué « approx » (la page affiche « before <date> ») ;
//   - l'XP d'autrefois : elle est recalculée au barème actuel des badges (l'XP à vie a été recalculée après chaque
//     changement de badges, api/leaderboard.js migrateXp), donc un palier d'XP peut être daté un peu autrement qu'il
//     ne l'a été sur le moment.
// Rien n'est effacé : un palier déjà posé n'est remplacé que si le rattrapage trouve une date plus ancienne.
//   node tools/backfill-hof.js            → affiche ce qu'il a trouvé, n'écrit rien
//   node tools/backfill-hof.js --apply    → écrit les paliers trouvés dans « hof »
const L = require('../api/_lib');
const H = require('../api/_hof');

async function scan(match, re) {
  const keys = [];
  let cursor = '0';
  do {
    const [[next, batch]] = await L.redis([['SCAN', cursor, 'MATCH', match, 'COUNT', 1000]]);
    cursor = String(next);
    for (const k of batch || []) if (re.test(k)) keys.push(k);
  } while (cursor !== '0');
  return keys;
}

async function backfill({ apply = false, log = console.log } = {}) {
  const found = {}; // champ → { id, t, n?, approx? } : le plus ancien
  // Comptes suspendus (fermes de bots, 2026-11-04) : jamais dans le Hall of Fame.
  const [bannedList] = await L.redis([['SMEMBERS', L.BANNED]]), banned = new Set(bannedList || []);
  const offer = (field, x) => { if (banned.has(x.id)) return; if (!found[field] || x.t < found[field].t) found[field] = x; };
  const INF = new Set(H.INFINITE), hard = L.hardEngine();

  // 1. Nombres Infinite du mode normal : historiques (tirages gardés), puis meilleur tirage de chacun (best:all).
  const hist = await scan('hist:*', /^hist:[0-9a-f]{16}$/);
  for (let i = 0; i < hist.length; i += 50) {
    const batch = hist.slice(i, i + 50), lists = await L.redis(batch.map(k => ['ZRANGE', k, 0, -1]));
    lists.forEach((list, j) => {
      for (const m of list || []) {
        const [t, n] = String(m).split(':').map(Number);
        if (INF.has(n) && t > 0) offer(`inf:${n}`, { id: batch[j].slice(5), t, n });
      }
    });
  }
  const [best] = await L.redis([['HGETALL', 'best:all']]);
  for (let i = 0; i < (best || []).length; i += 2) {
    try { const b = JSON.parse(best[i + 1]); if (INF.has(Number(b.n)) && Number(b.t) > 0) offer(`inf:${b.n}`, { id: best[i], t: Number(b.t), n: Number(b.n) }); } catch (e) { /* ignoré */ }
  }
  // 2. Premières grandes raretés du mode difficile : l'historique difficile garde « heure:nombre:XP » (tout depuis le
  // 2026-11-02, sauf au-delà de 100 000 tirages).
  const hhist = await scan('hhist:*', /^hhist:[0-9a-f]{16}$/);
  for (let i = 0; i < hhist.length; i += 50) {
    const batch = hhist.slice(i, i + 50), lists = await L.redis(batch.map(k => ['ZRANGE', k, 0, -1]));
    lists.forEach((list, j) => {
      for (const m of list || []) {
        const [t, n, s] = String(m).split(':').map(Number), tier = hard.cardTier(s);
        if (H.HARD_TIERS.includes(tier) && t > 0) offer(`h:${tier}`, { id: batch[j].slice(6), t, n });
      }
    });
  }
  // 3. Paliers d'XP à vie (stats.xpLife, normal + difficile) : en remontant le temps depuis l'XP d'aujourd'hui, l'XP
  // juste après un tirage = XP d'aujourd'hui − XP des tirages plus récents.
  const xpMin = Math.min(...H.XP_MARKS), rollMin = Math.min(...H.ROLL_MARKS);
  const [xpIds, rollIds] = await L.redis([['ZRANGEBYSCORE', L.XP_LB, xpMin, '+inf'], ['ZRANGEBYSCORE', L.ROLLS_LB, rollMin, '+inf']]);
  for (const id of xpIds || []) {
    const [normal, hardList, xpLife] = await L.redis([['ZRANGE', L.historyKey(id), 0, -1], ['ZRANGE', L.hardHistoryKey(id), 0, -1], ['HGET', `stats:${id}`, 'xpLife']]);
    const seen = L.rollSet(), rolls = [];
    for (const m of normal || []) { const [t, n] = String(m).split(':').map(Number); if (seen.add(n, t)) rolls.push([t, L.engine.scoreOf(n)]); }
    for (const m of hardList || []) { const [t, , s] = String(m).split(':').map(Number); rolls.push([t, s]); }
    rolls.sort((a, b) => b[0] - a[0]); // du plus récent au plus ancien
    let after = Number(xpLife) || 0;
    const marks = H.XP_MARKS.filter(m => after >= m);
    for (const [t, s] of rolls) {
      const before = after - s;
      for (const m of marks) if (after >= m && before < m) offer(`xp:${m}`, { id, t });
      after = before;
    }
    const oldest = rolls.length ? rolls[rolls.length - 1][0] : 0;
    for (const m of marks) if (after >= m && oldest) offer(`xp:${m}`, { id, t: oldest, approx: 1 }); // franchi avant le plus vieux tirage gardé
  }
  // 4. Paliers de tirages (mode normal, stats.rolls) : l'historique garde les derniers tirages, le k-ième de la liste
  // est donc le tirage n° (total − taille + k + 1).
  for (const id of rollIds || []) {
    const [list, total] = await L.redis([['ZRANGE', L.historyKey(id), 0, -1, 'WITHSCORES'], ['HGET', `stats:${id}`, 'rolls']]);
    const times = []; for (let j = 1; j < (list || []).length; j += 2) times.push(Number(list[j]));
    const R = Number(total) || 0;
    for (const m of H.ROLL_MARKS) {
      if (R < m || !times.length) continue;
      const k = m - (R - times.length) - 1;
      offer(`rolls:${m}`, k >= 0 ? { id, t: times[k] } : { id, t: times[0], approx: 1 });
    }
  }

  const fields = Object.keys(found).sort();
  const [cur] = await L.redis([['HGETALL', H.HOF]]), now = {};
  for (let i = 0; i < (cur || []).length; i += 2) { try { now[cur[i]] = JSON.parse(cur[i + 1]); } catch (e) { /* ignoré */ } }
  const ids = [...new Set(fields.map(f => found[f].id))];
  const [names] = ids.length ? await L.redis([['HMGET', 'names', ...ids]]) : [[]];
  const nameOf = new Map(ids.map((id, i) => [id, names[i]]));
  const writes = [];
  log(`${hist.length} historiques normaux, ${hhist.length} historiques difficiles lus.`);
  for (const f of fields) {
    const x = found[f], keep = now[f] && Number(now[f].t) <= x.t;
    log(`  ${f.padEnd(16)} ${String(nameOf.get(x.id) || '?').padEnd(24)} ${new Date(x.t).toISOString()}${x.approx ? ' (au plus tard)' : ''}${keep ? '   déjà posé plus tôt : gardé' : ''}`);
    if (!keep) writes.push(['HSET', H.HOF, f, JSON.stringify(x)]);
  }
  const missing = [...H.INFINITE.map(n => `inf:${n}`), ...H.HARD_TIERS.map(t => `h:${t}`), ...H.XP_MARKS.map(m => `xp:${m}`), ...H.ROLL_MARKS.map(m => `rolls:${m}`)].filter(f => !found[f] && !now[f]);
  if (missing.length) log(`Pas encore atteints (ou introuvables) : ${missing.join(', ')}`);
  if (!apply) { log(`Essai à blanc : rien écrit. Relancer avec --apply pour écrire ${writes.length} paliers.`); return { found, writes: writes.length }; }
  await L.redis([...writes, ['SET', H.HOF_READY, Date.now()]]);
  log(`Hall of Fame : ${writes.length} paliers écrits ; la page est ouverte.`);
  return { found, writes: writes.length };
}
module.exports = { backfill }; // tools/test-api.mjs le lance sur le faux Redis
if (require.main === module) backfill({ apply: process.argv.includes('--apply') }).then(() => process.exit(0), err => { console.error(err); process.exit(1); });
