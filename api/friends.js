// POST /api/friends { playerId, secret, action: 'list' }                  → amis, demandes reçues et envoyées
// POST /api/friends { playerId, secret, action, name }                    → add | accept | decline | remove | cancel
// POST /api/friends { playerId, secret, action: 'gift', name, amount }    → donne des pièces à un ami
// POST /api/friends { playerId, secret, action: 'gifts' }                 → cadeaux reçus pas encore vus (puis vus), et messages non lus
// POST /api/friends { …, action: 'messages' | 'message' (text) | 'block' | 'unblock', name } → messages entre amis
// Amitié = réciproque : A demande, B accepte. Clés : fr:<id> (amis), frin:<id> (demandes reçues), frout:<id> (envoyées).
// Les identifiants ne sortent jamais du serveur : tout se fait par pseudo.
const { redis, ownsPlayer, findPlayer, cleanName, XP_LB, SEEN_KEY, cors, send, flushDue, readStats, statsKey, dayKey } = require('./_lib');
const Shop = require('../js/shop.js');
const { MIN_ROLLS } = require('./_gamble');
const { cleanChat, MAX_CHARS } = require('./_chat');

const MAX_FRIENDS = 100, MAX_PENDING = 30;
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const frKey = id => `fr:${id}`, inKey = id => `frin:${id}`, outKey = id => `frout:${id}`;

// Pièces offertes entre amis (idée de joueurs). Seulement entre amis (les deux côtés de l'amitié), après les mêmes
// 30 tirages que le casino, de 10 à 500 pièces par cadeau. Par jour (UTC) : 1 000 pièces données au plus, 2 000 reçues
// au plus ; ces plafonds freinent les comptes créés pour nourrir un compte principal. Compteurs du jour : hash
// gift:<jour> (champs o:<id> donné, i:<id> reçu), gardé 2 jours. Les pièces passent comme partout : « spent » chez
// celui qui donne, « bonus » chez celui qui reçoit, sous le verrou d'achat de la boutique (shop:<id>).
// Pour donner, 300 tirages (audit anti-triche du 2026-10-14) : un compte créé juste pour encaisser le code cadeau et le
// bonus Google puis tout envoyer à son compte principal coûterait plus de temps que de jouer normalement.
const GIFT_ROLLS = 300;
const GIFT = { min: 10, max: 500, sendDay: 1000, receiveDay: 2000, rolls: Math.max(MIN_ROLLS, GIFT_ROLLS) };
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

// ---------------------------------------------------------------- messages entre amis (idée d'un joueur, 2026-10-14)
// Seulement entre amis acceptés des deux côtés ; même filtre que le chat des duels (insultes, liens, numéros) ; gardés
// 7 jours après le dernier message ; chacun peut bloquer l'autre. dm:<idA>:<idB> (ids triés) = les 100 derniers
// messages { s: expéditeur, x: texte, t } ; dmu:<id> = non lus par ami ; dmblock:<id> = ceux que ce joueur a bloqués.
const DM_KEEP = 100, DM_TTL = 7 * 86400, DM_PER_MIN = 20, DM_PER_DAY = 400;
const dmKey = (a, b) => `dm:${[a, b].sort().join(':')}`, unreadKey = id => `dmu:${id}`, blockKey = id => `dmblock:${id}`;
async function dmThread(me, other) {
  const [raw, iBlocked] = await redis([['LRANGE', dmKey(me, other), 0, -1], ['SISMEMBER', blockKey(me), other], ['HDEL', unreadKey(me), other]]);
  const messages = (raw || []).map(x => { try { const m = JSON.parse(x); return { me: m.s === me, text: String(m.x || ''), t: Number(m.t) || 0 }; } catch (e) { return null; } }).filter(Boolean);
  return { messages, blocked: Number(iBlocked) === 1, max: MAX_CHARS };
}
async function sendDm(me, other, raw) {
  const [mine, theirs, blockedByThem, iBlocked] = await redis([['SISMEMBER', frKey(me), other], ['SISMEMBER', frKey(other), me], ['SISMEMBER', blockKey(other), me], ['SISMEMBER', blockKey(me), other]]);
  if (Number(mine) !== 1 || Number(theirs) !== 1) throw refuse(403, 'You can only message your friends');
  if (Number(iBlocked) === 1) throw refuse(422, 'You blocked this player: unblock them to send a message');
  if (Number(blockedByThem) === 1) throw refuse(403, 'This player does not accept your messages');
  const text = cleanChat(raw);
  if (!text) throw refuse(422, 'Write a message first');
  const t = Date.now(), minute = Math.floor(t / 60000);
  const [perMin, perDay] = await redis([['INCR', `dmrate:${me}:${minute}`], ['INCR', `dmrate:${me}:${dayKey(t)}`], ['EXPIRE', `dmrate:${me}:${minute}`, 120], ['EXPIRE', `dmrate:${me}:${dayKey(t)}`, 2 * 86400]]);
  if (Number(perMin) > DM_PER_MIN || Number(perDay) > DM_PER_DAY) throw refuse(429, 'Slow down: too many messages');
  const key = dmKey(me, other);
  await redis([['RPUSH', key, JSON.stringify({ s: me, x: text, t })], ['LTRIM', key, -DM_KEEP, -1], ['EXPIRE', key, DM_TTL], ['HINCRBY', unreadKey(other), me, 1], ['EXPIRE', unreadKey(other), DM_TTL], ['HINCRBY', 'feat:dms', dayKey(t), 1]]); // compteur du jour pour la page Owner
}

async function state(id) {
  const [friends, incoming, outgoing] = await redis([['SMEMBERS', frKey(id)], ['SMEMBERS', inKey(id)], ['SMEMBERS', outKey(id)]]);
  const all = [...new Set([...(friends || []), ...(incoming || []), ...(outgoing || [])])];
  let names = [], titles = [], extra = [], unread = [];
  if (all.length) {
    [names, titles] = await redis([['HMGET', 'names', ...all], ['HMGET', 'titles', ...all]]);
    extra = await redis((friends || []).flatMap(f => [['ZSCORE', XP_LB, f], ['ZSCORE', SEEN_KEY, f], ['GET', `inroom:${f}`]]));
    unread = (friends || []).length ? (await redis([['HMGET', unreadKey(id), ...friends]]))[0] || [] : [];
  }
  const nameOf = pid => names[all.indexOf(pid)] || 'Player';
  const list = (friends || []).map((f, i) => ({
    name: nameOf(f), title: titles[all.indexOf(f)] || null,
    xp: Number(extra[i * 3] || 0), seen: Number(extra[i * 3 + 1] || 0), room: extra[i * 3 + 2] || null, unread: Number(unread[i] || 0),
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
      const [counts] = await redis([['HVALS', unreadKey(playerId)]]);
      return send(res, 200, { gifts, coins: gifts.length ? Shop.balance(await readStats(playerId)) : null, messages: (counts || []).reduce((x, v) => x + (Number(v) || 0), 0) });
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
    if (body.action === 'messages') return send(res, 200, await dmThread(playerId, other));
    if (body.action === 'message') { await sendDm(playerId, other, body.text); return send(res, 200, await dmThread(playerId, other)); }
    if (body.action === 'block' || body.action === 'unblock') {
      await redis([[body.action === 'block' ? 'SADD' : 'SREM', blockKey(playerId), other], ['HDEL', unreadKey(playerId), other]]);
      return send(res, 200, await dmThread(playerId, other));
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
