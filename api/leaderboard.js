// GET /api/leaderboard?period=day|week|month|all|xp|coins|worst|event|rolls|median&span=day|week|month|all&me=<playerId>
// Top 100 des meilleurs tirages de la période, la place du joueur s'il est plus loin, et le nombre de tirages du jour.
// period=xp : classement à l'XP à vie (somme de tous les tirages) ; chaque ligne montre aussi le meilleur tirage.
const { worstKeys, breathe, redis, engine, scopes, dayKey, historyKey, XP_LB, ROLLS_LB, WORST_LB, WORST_BEST, lifetimeTotals, statsKey, cors, send, flushDue, rollSet, xpKey, MED_LB, MED_MIN, medKey, medBucket, medHist, medPct, scoreAtPct } = require('./_lib');

const LIMIT = 100;
const XP_SCOPE = { period: 'xp', lb: XP_LB, best: 'best:all', count: 'count:all', total: 'rolls:all' };
const WORST_SCOPE = { period: 'worst', lb: WORST_LB, best: WORST_BEST, count: 'count:all', total: 'rolls:all' };
const MIGRATED = 'lb:xp:migrated';
// 1 : XP à vie ; 2 : + nombre de tirages à vie (count:all ne comptait que depuis le 2026-09-21) ;
// 3 : la version suit d'elle-même les règles des badges (empreinte de data/badge-meta.json et de js/engine.js). Un badge
// ajouté ou changé change l'XP des anciens tirages, comme l'affiche la page du joueur : l'XP à vie du classement est
// alors recalculée depuis l'historique au lieu de garder l'ancien total (signalé par un joueur le 2026-10-15).
// 4 : + les meilleurs tirages (tout le temps, et jour, semaine, mois en cours) recalculés eux aussi : un 117 tiré avant
// le badge Exact Spartan restait à son ancien score dans le classement (signalé par un joueur le 2026-10-16).
// 5 : + l'XP à vie copiée dans les stats (stats.xpLife), pour les titres d'XP à vie.
// 6 : + le pire tirage de tous les temps (classement Poubelle), rempli depuis l'historique.
// 7 : + l'histogramme de la médiane (med:<id>, classement Median roll, idée de Kag, 2026-10-28) : la même lecture de
// l'historique sert aux deux, et un changement de badges (qui déplace les percentiles) le refait lui aussi.
const MIGRATION = '7:' + require('node:crypto').createHash('sha256')
  .update(require('node:fs').readFileSync(require('node:path').join(__dirname, '../data/badge-meta.json')))
  .update(require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/engine.js'))).digest('hex').slice(0, 12);

// Remplissage unique pour les joueurs d'avant ces compteurs (2026-09-23), par lots, en quelques secondes au plus :
// lb:xp (XP à vie) et count:all (tirages à vie). Les tirages suivants les incrémentent dans recordRoll ;
// recalculer depuis l'historique donne les mêmes totaux. count:all ne descend jamais.
const MIGRATE_BATCH = 3, MIGRATE_BUDGET_MS = 1500;
async function migrateXp() {
  const [done] = await redis([['GET', MIGRATED]]);
  if (done === MIGRATION) return;
  const [lock] = await redis([['SET', `${MIGRATED}:lock`, '1', 'NX', 'PX', 20000]]);
  if (lock !== 'OK') return;
  const start = Date.now();
  // Joueurs nommés et tous ceux du classement à vie (d'anciens identifiants n'ont plus de nom à eux).
  const [named, ranked, finished] = await redis([['HKEYS', 'names'], ['ZRANGE', 'lb:all', 0, -1], ['SMEMBERS', `${MIGRATED}:ids`]]);
  const todo = [...new Set([...(named || []), ...(ranked || [])])].filter(id => !(finished || []).includes(id));
  const open = new Set(scopes(Date.now()).map(p => p.lb)); // périodes en cours (les mois finis gardent leurs trophées)
  // Lenteurs (2026-10-25) : par lots de 20 historiques complets (jusqu'à 2 millions de tirages dans une seule demande à
  // Redis) et 6 s de calcul à chaque visite du classement, le recalcul d'après un changement de badges ralentissait tout
  // le serveur. Désormais 3 joueurs par lot et 1,5 s au plus par passage ; le serveur le relance aussi toutes les 5 s en
  // fond (deploy/ovh/api-server.js), si bien qu'il avance doucement sans attendre les visites du classement.
  for (let i = 0; i < todo.length && Date.now() - start < MIGRATE_BUDGET_MS; i += MIGRATE_BATCH) {
    const batch = todo.slice(i, i + MIGRATE_BATCH);
    const [counts, oldBest, oldXp, ...lists] = await redis([['HMGET', 'count:all', ...batch], ['HMGET', 'best:all', ...batch], ['ZMSCORE', XP_LB, ...batch], ...batch.map(id => ['ZRANGE', historyKey(id), 0, -1])]);
    const writes = [];
    for (let j = 0; j < batch.length; j++) {
      const id = batch[j];
      await breathe(); // un joueur à la fois : les tirages des autres passent pendant le recalcul
      const { xp: windowXp, rolls } = lifetimeTotals(lists[j]);
      // Historique plafonné (100 000 tirages) : les plus anciens n'y sont plus. Recalculer seulement sur ce qui reste
      // faisait perdre leur XP (jsand : 126 095 tirages, retombé de ~3,2 à 2,7 milliards après le badge Leap Day,
      // « Stats bug » sur Discord, 2026-10-26). Les tirages disparus comptent à la moyenne de ceux qui restent, et l'XP
      // à vie ne descend jamais (rien de gagné n'est repris).
      const total = Math.max(rolls, Number(counts[j]) || 0);
      const estimate = rolls && total > rolls ? Math.round(windowXp + (total - rolls) * (windowXp / rolls)) : windowXp;
      const xp = Math.max(estimate, Number(oldXp && oldXp[j]) || 0);
      if (xp > 0) writes.push(['ZADD', XP_LB, xp, id], ['HSET', statsKey(id), 'xpLife', xp]);
      if (rolls > Number(counts[j] || 0)) writes.push(['HSET', 'count:all', id, rolls]);
      // Meilleur tirage de chaque période encore ouverte, au barème actuel des badges.
      const tops = new Map(), members = (lists[j] || []).slice();
      // Un record d'avant l'historique du serveur reste candidat (rescoré lui aussi), pour ne jamais être perdu.
      try { const b = oldBest && oldBest[j] ? JSON.parse(oldBest[j]) : null; if (b && Number.isInteger(b.n)) members.push(`${Number(b.t) || 0}:${b.n}`); } catch (e) { /* ignoré */ }
      for (const m of members) {
        const [t, n] = m.split(':').map(Number), s = engine.scoreOf(n);
        for (const p of scopes(t)) { if (!open.has(p.lb)) continue; const cur = tops.get(p.lb); if (!cur || s > cur.s) tops.set(p.lb, { p, n, s, t }); }
      }
      // Pire tirage de tous les temps (classement Poubelle), au barème actuel.
      let low = null;
      for (const m of lists[j] || []) { const [t, n] = m.split(':').map(Number), s = engine.scoreOf(n); if (!low || s < low.s) low = { n, s, t }; }
      if (low) writes.push(['ZADD', WORST_LB, low.s, id], ['HSET', WORST_BEST, id, JSON.stringify(low)]);
      // Histogramme de la médiane, sans doublons (même règle que lifetimeTotals). Un tirage fait entre la lecture et
      // l'écriture peut manquer ou compter deux fois : un tirage sur 200 et plus ne déplace pas la médiane.
      const seen = rollSet(), med = medHist([]).counts;
      for (const m of lists[j] || []) { const [t, n] = m.split(':').map(Number); if (seen.add(n, t)) med[medBucket(engine.percentileOf(engine.scoreOf(n)))]++; }
      const medCount = med.reduce((x, c) => x + c, 0);
      // Historique vide : pas de hash (son premier tirage le créera complet, voir recordRoll).
      writes.push(['DEL', medKey(id)], ...(medCount ? [['HSET', medKey(id), 'v', 1, ...med.flatMap((c, b) => (c ? [b, c] : []))]] : []));
      writes.push(medCount >= MED_MIN ? ['ZADD', MED_LB, medPct(med), id] : ['ZREM', MED_LB, id]);
      for (const { p, n, s, t } of tops.values()) {
        writes.push(['ZADD', p.lb, s, id], ['HSET', p.best, id, JSON.stringify({ n, s, t })]);
        if (p.ttl) writes.push(['EXPIRE', p.lb, p.ttl], ['EXPIRE', p.best, p.ttl]);
        if (p.period === 'all') writes.push(['HSET', statsKey(id), 'best', s]);
      }
    }
    writes.push(['SADD', `${MIGRATED}:ids`, ...batch]);
    await redis(writes);
    if (i + MIGRATE_BATCH >= todo.length) await redis([['SET', MIGRATED, MIGRATION], ['DEL', `${MIGRATED}:ids`]]);
  }
  if (!todo.length) await redis([['SET', MIGRATED, MIGRATION], ['DEL', `${MIGRATED}:ids`]]);
  await redis([['DEL', `${MIGRATED}:lock`]]);
}

// Classement « Most rolls » (idée de CrazyMiner22 et WpBejs, 2026-10-27) : lb:rolls est incrémenté à chaque tirage par
// recordRoll ; les joueurs d'avant y sont versés une fois, en fond (toutes les 5 s, deploy/ovh/api-server.js), depuis le
// compteur stats.rolls : aucun historique n'est relu (lenteurs du 2026-10-25), 300 joueurs par lecture groupée.
// Sans danger à rejouer : on n'ajoute que l'écart entre stats.rolls et la valeur du classement (ZINCRBY), si bien qu'un
// tirage fait pendant le versement n'est ni perdu ni compté deux fois. Les joueurs sont pris dans l'ordre de leur id
// (lb:rolls:cursor = le dernier traité), tous ceux qui ont un compteur count:all (rempli par migrateXp pour chacun).
const ROLLS_DONE = 'lb:rolls:migrated', ROLLS_CURSOR = 'lb:rolls:cursor', ROLLS_BATCH = 300;
async function migrateRolls() {
  const [done] = await redis([['GET', ROLLS_DONE]]);
  if (done) return;
  const [lock] = await redis([['SET', `${ROLLS_DONE}:lock`, '1', 'NX', 'PX', 20000]]);
  if (lock !== 'OK') return;
  try {
    const start = Date.now();
    const [ids, cursor] = await redis([['HKEYS', 'count:all'], ['GET', ROLLS_CURSOR]]);
    const todo = (ids || []).filter(id => !cursor || id > cursor).sort();
    for (let i = 0; i < todo.length && Date.now() - start < MIGRATE_BUDGET_MS; i += ROLLS_BATCH) {
      const batch = todo.slice(i, i + ROLLS_BATCH);
      // Même lecture groupée : compteur des stats, count:all (joueurs d'avant les stats) et valeur actuelle du classement.
      const out = await redis([...batch.map(id => ['HGET', statsKey(id), 'rolls']), ['HMGET', 'count:all', ...batch], ['ZMSCORE', ROLLS_LB, ...batch]]);
      const counts = out[batch.length] || [], ranked = out[batch.length + 1] || [];
      const writes = [];
      batch.forEach((id, j) => {
        const want = Number(out[j]) || Number(counts[j]) || 0, gap = want - (Number(ranked[j]) || 0);
        if (gap > 0) writes.push(['ZINCRBY', ROLLS_LB, gap, id]);
      });
      writes.push(['SET', ROLLS_CURSOR, batch[batch.length - 1]]);
      await redis(writes);
      await breathe();
    }
    const [last] = await redis([['GET', ROLLS_CURSOR]]);
    if (!todo.length || last === todo[todo.length - 1]) await redis([['SET', ROLLS_DONE, String(Date.now())], ['DEL', ROLLS_CURSOR]]);
  } finally {
    await redis([['DEL', `${ROLLS_DONE}:lock`]]);
  }
}
async function rollsBoard(me) {
  await Promise.race([migrateRolls().catch(() => {}), new Promise(done => setTimeout(done, 250))]);
  const [flat, players, myRank, myCount, total] = await redis([['ZREVRANGE', ROLLS_LB, 0, LIMIT - 1, 'WITHSCORES'], ['ZCARD', ROLLS_LB], ['ZREVRANK', ROLLS_LB, me || '-'], ['ZSCORE', ROLLS_LB, me || '-'], ['GET', 'rolls:all']]);
  const rows = []; for (let i = 0; i < (flat || []).length; i += 2) rows.push([flat[i], Number(flat[i + 1])]);
  const outside = me && myRank !== null && Number(myRank) >= LIMIT;
  const wanted = outside ? [...rows, [me, Number(myCount)]] : rows;
  const marks = await bestAwards(wanted.map(x => x[0]));
  const [names, titles, xps] = wanted.length ? await redis([['HMGET', 'names', ...wanted.map(x => x[0])], ['HMGET', 'titles', ...wanted.map(x => x[0])], ['ZMSCORE', XP_LB, ...wanted.map(x => x[0])]]) : [[], [], []];
  const clans = await tagsOf(wanted.map(x => x[0]));
  // count : tirages à vie ; xp : XP à vie (affichée en petit, pour l'XP moyenne par tirage).
  const entry = (x, i, rank) => ({ rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(x[0]) || null, clan: clans[i] || null, count: x[1], xp: Number(xps && xps[i]) || 0, me: x[0] === me });
  return { period: 'rolls', entries: rows.map((x, i) => entry(x, i, i + 1)), mine: outside ? entry(wanted[rows.length], rows.length, Number(myRank) + 1) : null, players: Number(players) || 0, rolls: Number(total) || 0, rollsToday: 0 };
}

// Classement « Median roll » (idée de Kag, 2026-10-28) : lb:med (percentile médian estimé, tenu par recordRoll et
// migrateXp depuis l'histogramme med:<id>, voir api/_lib.js), seulement les joueurs d'au moins 200 tirages.
// med = XP du tirage médian (déduite du percentile par la table), count = tirages à vie (lb:rolls, une seule lecture).
// Pas encore classé : need = 200 et have = ses tirages comptés, pour lui dire combien il en manque.
async function medianBoard(me) {
  await Promise.race([migrateXp().catch(() => {}), new Promise(done => setTimeout(done, 250))]);
  const [flat, players, myRank, myPct, myHist] = await redis([['ZREVRANGE', MED_LB, 0, LIMIT - 1, 'WITHSCORES'], ['ZCARD', MED_LB], ['ZREVRANK', MED_LB, me || '-'], ['ZSCORE', MED_LB, me || '-'], ['HGETALL', medKey(me || '-')]]);
  const rows = []; for (let i = 0; i < (flat || []).length; i += 2) rows.push([flat[i], Number(flat[i + 1])]);
  const outside = me && myRank !== null && Number(myRank) >= LIMIT;
  const wanted = outside ? [...rows, [me, Number(myPct)]] : rows;
  const marks = await bestAwards(wanted.map(x => x[0]));
  const [names, titles, counts] = wanted.length ? await redis([['HMGET', 'names', ...wanted.map(x => x[0])], ['HMGET', 'titles', ...wanted.map(x => x[0])], ['ZMSCORE', ROLLS_LB, ...wanted.map(x => x[0])]]) : [[], [], []];
  const clans = await tagsOf(wanted.map(x => x[0]));
  const entry = (x, i, rank) => ({ rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(x[0]) || null, clan: clans[i] || null, med: scoreAtPct(x[1]), pct: Math.round(x[1] * 10) / 10, count: Number(counts && counts[i]) || 0, me: x[0] === me });
  const mineHist = me && myRank === null ? medHist(myHist) : null;
  return {
    period: 'median', entries: rows.map((x, i) => entry(x, i, i + 1)), mine: outside ? entry(wanted[rows.length], rows.length, Number(myRank) + 1) : null,
    need: MED_MIN, have: mineHist ? mineHist.count : null, players: Number(players) || 0, rolls: 0, rollsToday: 0,
  };
}

// Classement des pièces : le solde n'est stocké nulle part (il se calcule depuis les stats), donc on le recalcule pour
// tous les joueurs nommés et on garde le résultat une minute.
const Shop = require('../js/shop.js');
const { bestAwards } = require('./_rank');
const { tagsOf } = require('./_clan');
const COINS_CACHE = 'lbcache:coins', COINS_TTL_S = 60;
async function coinsBoard(me) {
  let [cached] = await redis([['GET', COINS_CACHE]]);
  if (!cached) {
    const [ids] = await redis([['HKEYS', 'names']]);
    const all = [];
    for (let i = 0; i < (ids || []).length; i += 150) {
      const part = ids.slice(i, i + 150), rows = await redis(part.map(id => ['HGETALL', `stats:${id}`]));
      rows.forEach((flat, j) => { const st = {}; for (let k = 0; k < (flat || []).length; k += 2) st[flat[k]] = flat[k + 1]; const coins = Shop.balance(st); if (coins > 0) all.push([part[j], coins, Number(st.rolls) || 0]); });
    }
    all.sort((a, b) => b[1] - a[1]);
    cached = JSON.stringify(all);
    await redis([['SET', COINS_CACHE, cached, 'EX', COINS_TTL_S]]);
  }
  const all = JSON.parse(cached), top = all.slice(0, LIMIT), myIndex = me ? all.findIndex(x => x[0] === me) : -1;
  const wanted = myIndex >= LIMIT ? [...top, all[myIndex]] : top;
  const marks = await bestAwards(wanted.map(x => x[0]));
  const [names, titles] = wanted.length ? await redis([['HMGET', 'names', ...wanted.map(x => x[0])], ['HMGET', 'titles', ...wanted.map(x => x[0])]]) : [[], []];
  const clans = await tagsOf(wanted.map(x => x[0]));
  const entry = (x, i, rank) => ({ rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(x[0]) || null, clan: clans[i] || null, coins: x[1], rolls: x[2], me: x[0] === me });
  return { period: 'coins', entries: top.map((x, i) => entry(x, i, i + 1)), mine: myIndex >= LIMIT ? entry(all[myIndex], top.length, myIndex + 1) : null, players: all.length, rolls: 0, rollsToday: 0 };
}

// Classement de l'événement de la semaine (js/events.js) : nombre de tirages du thème cette semaine, par joueur.
const Events = require('../js/events.js');
async function eventBoard(me) {
  const ev = Events.current(), key = Events.key(ev);
  const [flat, players, myRank, myScore] = await redis([['ZREVRANGE', key, 0, LIMIT - 1, 'WITHSCORES'], ['ZCARD', key], ['ZREVRANK', key, me || '-'], ['ZSCORE', key, me || '-']]);
  const rows = []; for (let i = 0; i < (flat || []).length; i += 2) rows.push([flat[i], Number(flat[i + 1])]);
  const outside = me && myRank !== null && Number(myRank) >= LIMIT;
  const wanted = outside ? [...rows, [me, Number(myScore)]] : rows;
  const marks = await bestAwards(wanted.map(x => x[0]));
  const [names, titles] = wanted.length ? await redis([['HMGET', 'names', ...wanted.map(x => x[0])], ['HMGET', 'titles', ...wanted.map(x => x[0])]]) : [[], []];
  const clans = await tagsOf(wanted.map(x => x[0]));
  const entry = (x, i, rank) => ({ rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(x[0]) || null, clan: clans[i] || null, count: x[1], done: x[1] >= ev.goal, me: x[0] === me });
  return {
    period: 'event', event: { id: ev.id, emoji: ev.emoji, title: ev.title, desc: ev.desc, goal: ev.goal, reward: ev.reward, end: ev.end },
    entries: rows.map((x, i) => entry(x, i, i + 1)), mine: outside ? entry(wanted[rows.length], rows.length, Number(myRank) + 1) : null,
    players: Number(players) || 0, rolls: 0, rollsToday: 0,
  };
}

// Le classement du mois existe depuis le 2026-10-12 : la première fois, le mois en cours est rempli depuis
// l'historique de chaque joueur (meilleur tirage et nombre de tirages depuis le 1er). Les mois suivants partent de zéro
// et se remplissent tout seuls à chaque tirage.
const MONTH_SEEDED = 'lb:month:seeded';
async function seedMonth(scope, t) {
  const [first] = await redis([['SET', MONTH_SEEDED, String(t), 'NX']]);
  if (first !== 'OK') return;
  const start = Date.parse(`${dayKey(t).slice(0, 7)}-01T00:00:00Z`);
  const [ids] = await redis([['HKEYS', 'names']]);
  let total = 0;
  for (let i = 0; i < (ids || []).length; i += 100) {
    const part = ids.slice(i, i + 100), lists = await redis(part.map(id => ['ZRANGEBYSCORE', historyKey(id), start, '+inf']));
    const writes = [];
    lists.forEach((rolls, k) => {
      if (!rolls || !rolls.length) return;
      // Membre de l'historique : « heure:nombre ». Le meilleur du mois = le plus d'XP (le premier en cas d'égalité).
      let best = null;
      for (const m of rolls) { const [at, n] = m.split(':').map(Number), s = engine.scoreOf(n); if (!best || s > best.s) best = { n, s, t: at }; }
      total += rolls.length;
      writes.push(['ZADD', scope.lb, best.s, part[k]], ['HSET', scope.best, part[k], JSON.stringify(best)], ['HSET', scope.count, part[k], rolls.length]);
    });
    if (writes.length) await redis(writes);
  }
  if (total) await redis([['SET', scope.total, total], ...[scope.lb, scope.best, scope.count, scope.total].map(k => ['EXPIRE', k, scope.ttl])]);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const period = ['day', 'week', 'month', 'all', 'xp', 'coins', 'worst', 'event', 'rolls', 'median'].includes(params.get('period')) ? params.get('period') : 'day';
    const me = /^[0-9a-f]{16}$/.test(params.get('me') || '') ? params.get('me') : '';
    if (period === 'coins') return send(res, 200, await coinsBoard(me));
    if (period === 'event') return send(res, 200, await eventBoard(me));
    if (period === 'rolls') return send(res, 200, await rollsBoard(me));
    if (period === 'median') return send(res, 200, await medianBoard(me));
    const t = Date.now();
    // Recalcul après un changement de badges : en arrière-plan, la page attend 250 ms au plus (le classement Poubelle restait
    // bloqué plusieurs secondes sur « not loading » pendant le recalcul, signalé le 2026-10-17). Il avance par lots à
    // chaque demande et montre l'ancien classement en attendant.
    // span : day | week | month | all, pour la Poubelle et l'XP (XP du jour, de la semaine, du mois : idée de
    // qwertyuiop, 2026-10-28 ; tout le temps par défaut).
    const span = ['day', 'week', 'month'].includes(params.get('span')) ? params.get('span') : 'all';
    if ((period === 'xp' && span === 'all') || period === 'all' || period === 'worst') await Promise.race([migrateXp().catch(() => {}), new Promise(done => setTimeout(done, 250))]);
    // Poubelle : le plus petit score en tête (classement croissant).
    const low = period === 'worst';
    const spanP = span !== 'all' ? scopes(t).find(x => x.period === span) : null;
    const spanScope = spanP && period === 'worst' ? (() => { const k = worstKeys(spanP); return { period: 'worst', lb: k.lb, best: k.best, count: spanP.count, total: spanP.total }; })() : null;
    // XP de la période : le meilleur tirage et le nombre de tirages affichés sont ceux de la même période.
    const xpSpanScope = spanP && period === 'xp' ? { period: 'xp', lb: xpKey(spanP), best: spanP.best, count: spanP.count, total: spanP.total } : null;
    const scope = period === 'worst' ? (spanScope || WORST_SCOPE) : period === 'xp' ? (xpSpanScope || XP_SCOPE) : scopes(t).find(p => p.period === period);
    if (period === 'month') await seedMonth(scope, t);

    const [flat, rolls, rollsToday, players, myRank] = await redis([
      [low ? 'ZRANGE' : 'ZREVRANGE', scope.lb, 0, LIMIT - 1, 'WITHSCORES'],
      ['GET', scope.total],
      ['GET', `rolls:day:${dayKey(t)}`],
      ['ZCARD', scope.lb],
      [low ? 'ZRANK' : 'ZREVRANK', scope.lb, me || '-'],
    ]);
    const ids = [];
    for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);
    const meOutsideTop = me && myRank !== null && Number(myRank) >= LIMIT;
    const wanted = meOutsideTop ? [...ids, me] : ids;
    // Badges Top 1 / 5 / 10 gagnés les mois passés (le meilleur de chacun), sur tous les onglets.
    const marks = await bestAwards(wanted, t);

    let details = [], names = [], counts = [], titles = [];
    const clans = await tagsOf(wanted); // tag de clan à côté du nom (api/_clan.js)
    if (wanted.length) {
      [details, names, counts, titles] = await redis([
        ['HMGET', scope.best, ...wanted],
        ['HMGET', 'names', ...wanted],
        ['HMGET', scope.count, ...wanted],
        ['HMGET', 'titles', ...wanted],
      ]);
    }

    // Les identifiants ne sortent jamais du serveur : seul un drapeau "me" signale la ligne du joueur.
    // rolls = nombre de tirages du joueur sur la période (jour/semaine : comptés depuis le 2026-09-21 ; à vie : tout l'historique).
    // En XP à vie, s = l'XP total du joueur ; n et t restent ceux de son meilleur tirage.
    const xpOf = {};
    for (let i = 0; i < flat.length; i += 2) xpOf[flat[i]] = Number(flat[i + 1]);
    let myXp = null;
    if (period === 'xp' && me && myRank !== null) [myXp] = await redis([['ZSCORE', scope.lb, me]]);
    const toEntry = (id, i, rank) => {
      if (!details[i]) return null;
      const d = JSON.parse(details[i]);
      const s = period === 'xp' ? (id in xpOf ? xpOf[id] : Number(myXp)) : d.s;
      return { rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(id) || null, clan: clans[i] || null, n: d.n, s, t: d.t, rolls: Number(counts[i] || 0), me: id === me };
    };
    // Places partagées (signalé par R77, 2026-10-30) : deux joueurs au même score ont la même place (1, 1, 3), au lieu
    // d'un ordre décidé par Redis sur l'identifiant du joueur. Place = 1 + nombre de joueurs strictement meilleurs.
    const scoreAt = i => Number(flat[2 * i + 1]);
    const places = [];
    ids.forEach((id, i) => { places.push(i && scoreAt(i) === scoreAt(i - 1) ? places[i - 1] : i + 1); });
    const entries = ids.map((id, i) => toEntry(id, i, places[i])).filter(Boolean);
    let mine = null;
    if (meOutsideTop) {
      // Scores entiers (XP) : « strictement meilleur » = au moins s + 1 (ou au plus s - 1 en Poubelle).
      const [mySc] = await redis([['ZSCORE', scope.lb, me]]);
      const s = Number(mySc);
      const [better] = await redis([low ? ['ZCOUNT', scope.lb, '-inf', s - 1] : ['ZCOUNT', scope.lb, s + 1, '+inf']]);
      mine = toEntry(me, ids.length, Number(better) + 1);
    }

    return send(res, 200, {
      period, entries, mine, ...(period === 'worst' || period === 'xp' ? { span } : {}),
      rolls: Number(rolls || 0),
      players: Number(players || 0),
      rollsToday: Number(rollsToday || 0),
    });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
module.exports.migrateXp = migrateXp; // relancé en fond par deploy/ovh/api-server.js
module.exports.migrateRolls = migrateRolls; // idem : versement unique des anciens joueurs dans lb:rolls
