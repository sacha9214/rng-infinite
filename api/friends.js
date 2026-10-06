// POST /api/friends { playerId, secret, action: 'list' }                  → amis, demandes reçues et envoyées
// POST /api/friends { playerId, secret, action, name }                    → add | accept | decline | remove | cancel
// Amitié = réciproque : A demande, B accepte. Clés : fr:<id> (amis), frin:<id> (demandes reçues), frout:<id> (envoyées).
// Les identifiants ne sortent jamais du serveur : tout se fait par pseudo.
const { redis, ownsPlayer, findPlayer, cleanName, XP_LB, SEEN_KEY, cors, send, flushDue } = require('./_lib');

const MAX_FRIENDS = 100, MAX_PENDING = 30;
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const frKey = id => `fr:${id}`, inKey = id => `frin:${id}`, outKey = id => `frout:${id}`;

async function state(id) {
  const [friends, incoming, outgoing] = await redis([['SMEMBERS', frKey(id)], ['SMEMBERS', inKey(id)], ['SMEMBERS', outKey(id)]]);
  const all = [...new Set([...(friends || []), ...(incoming || []), ...(outgoing || [])])];
  let names = [], titles = [], extra = [];
  if (all.length) {
    [names, titles] = await redis([['HMGET', 'names', ...all], ['HMGET', 'titles', ...all]]);
    extra = await redis((friends || []).flatMap(f => [['ZSCORE', XP_LB, f], ['ZSCORE', SEEN_KEY, f], ['GET', `inroom:${f}`]]));
  }
  const nameOf = pid => names[all.indexOf(pid)] || 'Player';
  const list = (friends || []).map((f, i) => ({
    name: nameOf(f), title: titles[all.indexOf(f)] || null,
    xp: Number(extra[i * 3] || 0), seen: Number(extra[i * 3 + 1] || 0), room: extra[i * 3 + 2] || null,
  })).sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0) || b.seen - a.seen);
  return { friends: list, incoming: (incoming || []).map(nameOf).sort(), outgoing: (outgoing || []).map(nameOf).sort(), max: MAX_FRIENDS, now: Date.now() };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  try {
    // Toujours en POST : le secret du joueur ne voyage jamais dans une adresse.
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    // La liste d'amis est privée : il faut prouver qui on est, même pour la lire.
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    if (body.action === 'list') return send(res, 200, await state(playerId));

    const other = await findPlayer(cleanName(body.name));
    if (!other) return send(res, 404, { error: 'No player with this name' });
    if (other === playerId) return send(res, 422, { error: 'That is you' });

    if (body.action === 'add') {
      const [isFriend, theyAsked, mine, pending] = await redis([
        ['SISMEMBER', frKey(playerId), other], ['SISMEMBER', inKey(playerId), other], ['SCARD', frKey(playerId)], ['SCARD', outKey(playerId)],
      ]);
      if (Number(isFriend) === 1) return send(res, 200, { ...(await state(playerId)), note: 'Already friends' });
      if (Number(mine) >= MAX_FRIENDS) return send(res, 422, { error: `Friends list full (${MAX_FRIENDS})` });
      // L'autre m'avait déjà demandé : on devient amis tout de suite.
      if (Number(theyAsked) === 1) return send(res, 200, { ...(await accept(playerId, other)), note: 'You are now friends' });
      if (Number(pending) >= MAX_PENDING) return send(res, 422, { error: 'Too many pending requests' });
      const [theirs] = await redis([['SCARD', inKey(other)]]);
      if (Number(theirs) >= MAX_PENDING) return send(res, 422, { error: 'This player has too many pending requests' });
      await redis([['SADD', outKey(playerId), other], ['SADD', inKey(other), playerId]]);
      return send(res, 200, { ...(await state(playerId)), note: 'Request sent' });
    }
    if (body.action === 'accept') {
      const [asked] = await redis([['SISMEMBER', inKey(playerId), other]]);
      if (Number(asked) !== 1) return send(res, 404, { error: 'This request is gone' });
      const [mine, theirs] = await redis([['SCARD', frKey(playerId)], ['SCARD', frKey(other)]]);
      if (Number(mine) >= MAX_FRIENDS || Number(theirs) >= MAX_FRIENDS) return send(res, 422, { error: 'Friends list full' });
      return send(res, 200, await accept(playerId, other));
    }
    if (body.action === 'decline') {
      await redis([['SREM', inKey(playerId), other], ['SREM', outKey(other), playerId]]);
      return send(res, 200, await state(playerId));
    }
    if (body.action === 'cancel') {
      await redis([['SREM', outKey(playerId), other], ['SREM', inKey(other), playerId]]);
      return send(res, 200, await state(playerId));
    }
    if (body.action === 'remove') {
      await redis([['SREM', frKey(playerId), other], ['SREM', frKey(other), playerId]]);
      return send(res, 200, await state(playerId));
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};

// Les deux deviennent amis ; les demandes croisées disparaissent.
async function accept(me, other) {
  await redis([
    ['SADD', frKey(me), other], ['SADD', frKey(other), me],
    ['SREM', inKey(me), other], ['SREM', outKey(other), me], ['SREM', inKey(other), me], ['SREM', outKey(me), other],
  ]);
  return state(me);
}
