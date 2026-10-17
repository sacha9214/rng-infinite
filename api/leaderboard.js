// GET /api/leaderboard?period=day|week|month|all|xp|coins&me=<playerId>
// Top 100 des meilleurs tirages de la période, la place du joueur s'il est plus loin, et le nombre de tirages du jour.
// period=xp : classement à l'XP à vie (somme de tous les tirages) ; chaque ligne montre aussi le meilleur tirage.
const { redis, engine, scopes, dayKey, historyKey, XP_LB, WORST_LB, WORST_BEST, lifetimeTotals, statsKey, cors, send, flushDue } = require('./_lib');

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
const MIGRATION = '6:' + require('node:crypto').createHash('sha256')
  .update(require('node:fs').readFileSync(require('node:path').join(__dirname, '../data/badge-meta.json')))
  .update(require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/engine.js'))).digest('hex').slice(0, 12);

// Remplissage unique pour les joueurs d'avant ces compteurs (2026-09-23), par lots, en quelques secondes au plus :
// lb:xp (XP à vie) et count:all (tirages à vie). Les tirages suivants les incrémentent dans recordRoll ;
// recalculer depuis l'historique donne les mêmes totaux. count:all ne descend jamais.
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
  for (let i = 0; i < todo.length && Date.now() - start < 6000; i += 20) {
    const batch = todo.slice(i, i + 20);
    const [counts, oldBest, ...lists] = await redis([['HMGET', 'count:all', ...batch], ['HMGET', 'best:all', ...batch], ...batch.map(id => ['ZRANGE', historyKey(id), 0, -1])]);
    const writes = [];
    batch.forEach((id, j) => {
      const { xp, rolls } = lifetimeTotals(lists[j]);
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
      for (const { p, n, s, t } of tops.values()) {
        writes.push(['ZADD', p.lb, s, id], ['HSET', p.best, id, JSON.stringify({ n, s, t })]);
        if (p.ttl) writes.push(['EXPIRE', p.lb, p.ttl], ['EXPIRE', p.best, p.ttl]);
        if (p.period === 'all') writes.push(['HSET', statsKey(id), 'best', s]);
      }
    });
    writes.push(['SADD', `${MIGRATED}:ids`, ...batch]);
    await redis(writes);
    if (i + 20 >= todo.length) await redis([['SET', MIGRATED, MIGRATION], ['DEL', `${MIGRATED}:ids`]]);
  }
  if (!todo.length) await redis([['SET', MIGRATED, MIGRATION], ['DEL', `${MIGRATED}:ids`]]);
  await redis([['DEL', `${MIGRATED}:lock`]]);
}

// Classement des pièces : le solde n'est stocké nulle part (il se calcule depuis les stats), donc on le recalcule pour
// tous les joueurs nommés et on garde le résultat une minute.
const Shop = require('../js/shop.js');
const { bestAwards } = require('./_rank');
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
  const entry = (x, i, rank) => ({ rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(x[0]) || null, coins: x[1], rolls: x[2], me: x[0] === me });
  return { period: 'coins', entries: top.map((x, i) => entry(x, i, i + 1)), mine: myIndex >= LIMIT ? entry(all[myIndex], top.length, myIndex + 1) : null, players: all.length, rolls: 0, rollsToday: 0 };
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
    const period = ['day', 'week', 'month', 'all', 'xp', 'coins', 'worst'].includes(params.get('period')) ? params.get('period') : 'day';
    const me = /^[0-9a-f]{16}$/.test(params.get('me') || '') ? params.get('me') : '';
    if (period === 'coins') return send(res, 200, await coinsBoard(me));
    const t = Date.now();
    // Recalcul après un changement de badges : en arrière-plan, la page attend 250 ms au plus (le classement Poubelle restait
    // bloqué plusieurs secondes sur « not loading » pendant le recalcul, signalé le 2026-10-17). Il avance par lots à
    // chaque demande et montre l'ancien classement en attendant.
    if (period === 'xp' || period === 'all' || period === 'worst') await Promise.race([migrateXp().catch(() => {}), new Promise(done => setTimeout(done, 250))]);
    // Poubelle : le plus petit score en tête (classement croissant).
    const low = period === 'worst';
    const scope = period === 'worst' ? WORST_SCOPE : period === 'xp' ? XP_SCOPE : scopes(t).find(p => p.period === period);
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
    if (period === 'xp' && me && myRank !== null) [myXp] = await redis([['ZSCORE', XP_LB, me]]);
    const toEntry = (id, i, rank) => {
      if (!details[i]) return null;
      const d = JSON.parse(details[i]);
      const s = period === 'xp' ? (id in xpOf ? xpOf[id] : Number(myXp)) : d.s;
      return { rank, name: names[i] || 'Player', title: titles[i] || null, top: marks.get(id) || null, n: d.n, s, t: d.t, rolls: Number(counts[i] || 0), me: id === me };
    };
    const entries = ids.map((id, i) => toEntry(id, i, i + 1)).filter(Boolean);
    const mine = meOutsideTop ? toEntry(me, ids.length, Number(myRank) + 1) : null;

    return send(res, 200, {
      period, entries, mine,
      rolls: Number(rolls || 0),
      players: Number(players || 0),
      rollsToday: Number(rollsToday || 0),
    });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
