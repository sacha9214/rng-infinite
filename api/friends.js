// POST /api/friends { playerId, secret, action: 'list' }                  → amis, demandes reçues et envoyées
// POST /api/friends { playerId, secret, action, name }                    → add | accept | decline | remove | cancel
// POST /api/friends { playerId, secret, action: 'gift', name, amount }    → donne des pièces à un ami
// POST /api/friends { playerId, secret, action: 'gifts' }                 → cadeaux reçus pas encore vus (puis vus)
// Amitié = réciproque : A demande, B accepte. Clés : fr:<id> (amis), frin:<id> (demandes reçues), frout:<id> (envoyées).
// Les identifiants ne sortent jamais du serveur : tout se fait par pseudo.
const { redis, ownsPlayer, findPlayer, cleanName, XP_LB, SEEN_KEY, cors, send, flushDue, readStats, statsKey, dayKey } = require('./_lib');
const Shop = require('../js/shop.js');
const { MIN_ROLLS } = require('./_gamble');

const MAX_FRIENDS = 100, MAX_PENDING = 30;
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const frKey = id => `fr:${id}`, inKey = id => `frin:${id}`, outKey = id => `frout:${id}`;

// Pièces offertes entre amis (idée de joueurs). Seulement entre amis (les deux côtés de l'amitié), après les mêmes
// 30 tirages que le casino, de 10 à 500 pièces par cadeau. Par jour (UTC) : 1 000 pièces données au plus, 2 000 reçues
// au plus ; ces plafonds freinent les comptes créés pour nourrir un compte principal. Compteurs du jour : hash
// gift:<jour> (champs o:<id> donné, i:<id> reçu), gardé 2 jours. Les pièces passent comme partout : « spent » chez
// celui qui donne, « bonus » chez celui qui reçoit, sous le verrou d'achat de la boutique (shop:<id>).
const GIFT = { min: 10, max: 500, sendDay: 1000, receiveDay: 2000, rolls: MIN_ROLLS };
const giftDayKey = t => `gift:${dayKey(t)}`, GIFT_DAY_TTL = 2 * 86400;
// Cadeaux reçus : liste gifts:<id> des 20 derniers ({ f: donneur, a: pièces, t: heure }), gardée 30 jours ; le
// joueur les voit une fois (giftseen:<id> = heure du dernier cadeau montré).
const giftsKey = id => `gifts:${id}`, giftSeenKey = id => `giftseen:${id}`, GIFTS_KEPT = 20, GIFTS_TTL = 30 * 86400;
const refuse = (status, error) => Object.assign(new Error(error), { status });
const fmt = v => Number(v).toLocaleString('en-US');

// Ce que la fenêtre « Give coins » affiche : solde, tirages, et ce qu'il reste à donner aujourd'hui.
async function giftInfo(id) {
  const [st, [sent, raw]] = await Promise.all([readStats(id), redis([['HGET', giftDayKey(Date.now()), `o:${id}`], ['LRANGE', giftsKey(id), -5, -1]])]);
  const rows = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).reverse();
  const names = rows.length ? (await redis([['HMGET', 'names', ...rows.map(r => r.f)]]))[0] || [] : [];
  return {
    ...GIFT, coins: Shop.balance(st), myRolls: Number(st.rolls) || 0, left: Math.max(0, GIFT.sendDay - (Number(sent) || 0)),
    received: rows.map((r, i) => ({ name: names[i] || 'Player', amount: r.a, t: r.t })),
  };
}

async function gift(me, other, raw) {
  const amount = raw;
  if (!Number.isInteger(amount) || amount < GIFT.min || amount > GIFT.max) throw refuse(400, `Give between ${GIFT.min} and ${GIFT.max} coins`);
  // Amitié acceptée, vue des deux côtés : une demande en attente ne suffit pas.
  const [mine, theirs] = await redis([['SISMEMBER', frKey(me), other], ['SISMEMBER', frKey(other), me]]);
  if (Number(mine) !== 1 || Number(theirs) !== 1) throw refuse(403, 'You can only give coins to your friends');
  // Même verrou que les achats et le casino : deux cadeaux (ou un cadeau et une mise) ne dépensent pas deux fois.
  let lock = null;
  for (let tries = 0; tries < 25 && lock !== 'OK'; tries++) {
    if (tries) await new Promise(resolve => setTimeout(resolve, 60));
    [lock] = await redis([['SET', `shop:${me}`, '1', 'PX', 5000, 'NX']]);
  }
  if (lock !== 'OK') throw refuse(429, 'One gift at a time');
  try {
    const st = await readStats(me);
    const rolls = Number(st.rolls) || 0, coins = Shop.balance(st);
    if (rolls < GIFT.rolls) throw refuse(422, `Gifts unlock after ${GIFT.rolls} rolls (you have ${rolls})`);
    if (coins < amount) throw refuse(422, `Not enough coins: ${amount - coins} more needed`);
    // Plafonds du jour : compteurs montés d'abord (HINCRBY est atomique), redescendus si l'un déborde. Deux amis qui
    // donnent en même temps au même joueur ne dépassent donc jamais ses 2 000.
    const t = Date.now(), key = giftDayKey(t);
    const [sent, got] = await redis([['HINCRBY', key, `o:${me}`, amount], ['HINCRBY', key, `i:${other}`, amount], ['EXPIRE', key, GIFT_DAY_TTL]]);
    if (Number(sent) > GIFT.sendDay || Number(got) > GIFT.receiveDay) {
      await redis([['HINCRBY', key, `o:${me}`, -amount], ['HINCRBY', key, `i:${other}`, -amount]]);
      if (Number(sent) > GIFT.sendDay) {
        const left = GIFT.sendDay - (Number(sent) - amount);
        throw refuse(422, left > 0 ? `You can give ${fmt(left)} more coins today` : `You already gave ${fmt(GIFT.sendDay)} coins today: come back tomorrow`);
      }
      const left = GIFT.receiveDay - (Number(got) - amount), [name] = await redis([['HGET', 'names', other]]);
      throw refuse(422, left > 0 ? `${name || 'This player'} can receive ${fmt(left)} more coins today` : `${name || 'This player'} already received ${fmt(GIFT.receiveDay)} coins today: try tomorrow`);
    }
    await redis([
      ['HINCRBY', statsKey(me), 'spent', amount], ['HINCRBY', statsKey(me), 'giftOut', amount],
      ['HINCRBY', statsKey(other), 'bonus', amount], ['HINCRBY', statsKey(other), 'giftIn', amount],
      ['RPUSH', giftsKey(other), JSON.stringify({ f: me, a: amount, t })], ['LTRIM', giftsKey(other), -GIFTS_KEPT, -1], ['EXPIRE', giftsKey(other), GIFTS_TTL],
    ]);
    return amount;
  } finally {
    await redis([['DEL', `shop:${me}`]]);
  }
}

// Cadeaux reçus depuis la dernière fois (les plus anciens d'abord), marqués vus : le site les annonce une seule fois.
async function unseenGifts(id) {
  const [raw, seen] = await redis([['LRANGE', giftsKey(id), 0, -1], ['GET', giftSeenKey(id)]]);
  const rows = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(r => r && r.t > (Number(seen) || 0));
  if (!rows.length) return [];
  const [names] = await redis([['HMGET', 'names', ...rows.map(r => r.f)], ['SET', giftSeenKey(id), Math.max(...rows.map(r => r.t)), 'EX', GIFTS_TTL]]);
  return rows.map((r, i) => ({ name: (names || [])[i] || 'Player', amount: r.a, t: r.t }));
}

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
  return { friends: list, incoming: (incoming || []).map(nameOf).sort(), outgoing: (outgoing || []).map(nameOf).sort(), max: MAX_FRIENDS, now: Date.now(), gift: await giftInfo(id) };
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
    if (body.action === 'gifts') {
      const gifts = await unseenGifts(playerId);
      return send(res, 200, { gifts, coins: gifts.length ? Shop.balance(await readStats(playerId)) : null });
    }

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
    if (body.action === 'gift') {
      const amount = await gift(playerId, other, body.amount);
      const [name] = await redis([['HGET', 'names', other]]);
      return send(res, 200, { ...(await state(playerId)), sent: { name: name || 'Player', amount } });
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
