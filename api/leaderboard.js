// GET /api/leaderboard?period=day|week|all|xp&me=<playerId>
// Top 100 des meilleurs tirages de la période, la place du joueur s'il est plus loin, et le nombre de tirages du jour.
// period=xp : classement à l'XP à vie (somme de tous les tirages) ; chaque ligne montre aussi le meilleur tirage.
const { redis, scopes, dayKey, historyKey, XP_LB, lifetimeTotals, cors, send, flushDue } = require('./_lib');

const LIMIT = 100;
const XP_SCOPE = { period: 'xp', lb: XP_LB, best: 'best:all', count: 'count:all', total: 'rolls:all' };
const MIGRATED = 'lb:xp:migrated';
const MIGRATION = '2'; // 1 : XP à vie ; 2 : + nombre de tirages à vie (count:all ne comptait que depuis le 2026-09-21)

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
  for (let i = 0; i < todo.length && Date.now() - start < 6000; i += 20) {
    const batch = todo.slice(i, i + 20);
    const [counts, ...lists] = await redis([['HMGET', 'count:all', ...batch], ...batch.map(id => ['ZRANGE', historyKey(id), 0, -1])]);
    const writes = [];
    batch.forEach((id, j) => {
      const { xp, rolls } = lifetimeTotals(lists[j]);
      if (xp > 0) writes.push(['ZADD', XP_LB, xp, id]);
      if (rolls > Number(counts[j] || 0)) writes.push(['HSET', 'count:all', id, rolls]);
    });
    writes.push(['SADD', `${MIGRATED}:ids`, ...batch]);
    await redis(writes);
    if (i + 20 >= todo.length) await redis([['SET', MIGRATED, MIGRATION], ['DEL', `${MIGRATED}:ids`]]);
  }
  if (!todo.length) await redis([['SET', MIGRATED, MIGRATION], ['DEL', `${MIGRATED}:ids`]]);
  await redis([['DEL', `${MIGRATED}:lock`]]);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const period = ['day', 'week', 'all', 'xp'].includes(params.get('period')) ? params.get('period') : 'day';
    const me = /^[0-9a-f]{16}$/.test(params.get('me') || '') ? params.get('me') : '';
    const t = Date.now();
    if (period === 'xp' || period === 'all') await migrateXp();
    const scope = period === 'xp' ? XP_SCOPE : scopes(t).find(p => p.period === period);

    const [flat, rolls, rollsToday, players, myRank] = await redis([
      ['ZREVRANGE', scope.lb, 0, LIMIT - 1, 'WITHSCORES'],
      ['GET', scope.total],
      ['GET', `rolls:day:${dayKey(t)}`],
      ['ZCARD', scope.lb],
      ['ZREVRANK', scope.lb, me || '-'],
    ]);
    const ids = [];
    for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);
    const meOutsideTop = me && myRank !== null && Number(myRank) >= LIMIT;
    const wanted = meOutsideTop ? [...ids, me] : ids;

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
      return { rank, name: names[i] || 'Player', title: titles[i] || null, n: d.n, s, t: d.t, rolls: Number(counts[i] || 0), me: id === me };
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
