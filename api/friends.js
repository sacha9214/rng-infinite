// POST /api/friends { playerId, secret, action: 'list' }                  → amis, demandes reçues et envoyées
// POST /api/friends { playerId, secret, action, name }                    → add | accept | decline | remove | cancel
// POST /api/friends { playerId, secret, action: 'star', name, on }        → épingle un ami en haut de la liste
// POST /api/friends { playerId, secret, action: 'gift', name, amount }    → donne des pièces à un ami
// POST /api/friends { playerId, secret, action: 'gifts' }                 → cadeaux reçus pas encore vus (puis vus), et messages non lus
// POST /api/friends { playerId, secret, action: 'clan', op, … }         → clans (api/_clan.js)
// POST /api/friends { action: 'gcList' | 'gcSend' (replyTo) | 'gcEdit' | 'gcReport' | 'gcDelete' | 'gcMute' | 'gcPin' | 'gcUnpin' | 'gcAdmin' | 'gcUnmute' | 'gcModSet', … } → chat global (api/_global.js)
// POST /api/friends { …, action: 'messages' | 'message' (text) | 'block' | 'unblock', name } → messages entre amis
// Amitié = réciproque : A demande, B accepte. Clés : fr:<id> (amis), frin:<id> (demandes reçues), frout:<id> (envoyées).
// Les identifiants ne sortent jamais du serveur : tout se fait par pseudo.
const { redis, ownsPlayer, findPlayer, cleanName, XP_LB, SEEN_KEY, cors, send, flushDue, readStats, statsKey, dayKey, bigKey, accountWait, NEW_ACCOUNT_DAYS, engine, scopes, xpKey } = require('./_lib');
const Reports = require('./_reports');
const Global = require('./_global');
const React = require('./_react');
const Shop = require('../js/shop.js');
const { MIN_ROLLS } = require('./_gamble');
const { cleanChat, cleanImage, MAX_CHARS } = require('./_chat');

const MAX_FRIENDS = 100, MAX_PENDING = 30;
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const frKey = id => `fr:${id}`, inKey = id => `frin:${id}`, outKey = id => `frout:${id}`;
// Amis en étoile (idée de Big Sexy, 2026-11-05) : frstar:<id> = les amis que j'ai épinglés en haut de ma liste.
const starKey = id => `frstar:${id}`;

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
    const wait = accountWait(st);
    if (wait) throw refuse(422, `Gifts unlock ${NEW_ACCOUNT_DAYS} days after your first roll (${wait} left)`);
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
// Gros tirages des amis plus récents que « since » (et de moins d'une heure : pas d'alerte périmée au retour), 5 au plus.
// Seulement ceux qui sont encore amis (une amitié retirée entre-temps ne prévient plus).
async function bigRolls(id, since) {
  const [raw, friends] = await redis([['LRANGE', bigKey(id), 0, -1], ['SMEMBERS', frKey(id)]]);
  const rows = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(r => r && r.t > since && Date.now() - r.t < 3600000);
  if (!rows.length) return [];
  const [ids] = await redis([['HMGET', 'names', ...(friends || []).concat('_')]]);
  const names = new Set((ids || []).filter(Boolean));
  return rows.filter(r => names.has(r.name)).slice(-5).map(r => ({ name: r.name, n: r.n, tier: r.tier, t: r.t, ...(r.h ? { h: 1 } : {}) }));
}

async function unseenGifts(id) {
  const [raw, seen] = await redis([['LRANGE', giftsKey(id), 0, -1], ['GET', giftSeenKey(id)]]);
  const rows = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(r => r && r.t > (Number(seen) || 0));
  if (!rows.length) return [];
  const [names] = await redis([['HMGET', 'names', ...rows.map(r => r.f)], ['SET', giftSeenKey(id), Math.max(...rows.map(r => r.t)), 'EX', GIFTS_TTL]]);
  return rows.map((r, i) => (r.k === 'top' ? { kind: 'top', place: r.p, month: r.m, amount: r.a, t: r.t } : { name: (names || [])[i] || 'Player', amount: r.a, t: r.t }));
}

// ---------------------------------------------------------------- messages entre amis (idée d'un joueur, 2026-10-14)
// Seulement entre amis acceptés des deux côtés ; même filtre que le chat des duels (insultes, liens, numéros) ; gardés
// 7 jours après le dernier message ; chacun peut bloquer l'autre. dm:<idA>:<idB> (ids triés) = les 100 derniers
// messages { s: expéditeur, x: texte, t } ; dmu:<id> = non lus par ami ; dmblock:<id> = ceux que ce joueur a bloqués.
const DM_KEEP = 100, DM_TTL = 7 * 86400, DM_PER_MIN = 20, DM_PER_DAY = 400;
// Images entre amis (demandé par Sacha, 2026-10-23) : un JPEG réduit par la page (~150 Ko au plus), gardé à part sous
// dm:<a>:<b>:img:<heure>, effacé avec le message ou au bout de 7 jours comme lui. 30 images par jour et par joueur.
const DM_IMG_PER_DAY = 30, dmImgKey = (a, b, t) => `${dmKey(a, b)}:img:${t}`;
const dmKey = (a, b) => `dm:${[a, b].sort().join(':')}`, unreadKey = id => `dmu:${id}`, blockKey = id => `dmblock:${id}`;
// Réactions emoji (api/_react.js, Sacha 2026-11-02) : rx:<clé du fil>, message désigné par son heure.
const dmRxKey = (a, b) => `rx:${dmKey(a, b)}`;
async function dmThread(me, other) {
  const [raw, iBlocked, , rxFlat] = await redis([['LRANGE', dmKey(me, other), 0, -1], ['SISMEMBER', blockKey(me), other], ['HDEL', unreadKey(me), other], ['HGETALL', dmRxKey(me, other)]]);
  const rx = await React.views(rxFlat || [], me);
  const messages = (raw || []).map(x => { try { const m = JSON.parse(x); return { me: m.s === me, text: String(m.x || ''), t: Number(m.t) || 0, ...(m.e ? { edited: true } : {}), ...(m.img ? { img: true } : {}), ...(rx.has(String(m.t)) ? { rx: rx.get(String(m.t)) } : {}) }; } catch (e) { return null; } }).filter(Boolean);
  return { messages, blocked: Number(iBlocked) === 1, max: MAX_CHARS };
}
async function sendDm(me, other, raw, rawImage) {
  const [mine, theirs, blockedByThem, iBlocked] = await redis([['SISMEMBER', frKey(me), other], ['SISMEMBER', frKey(other), me], ['SISMEMBER', blockKey(other), me], ['SISMEMBER', blockKey(me), other]]);
  if (Number(mine) !== 1 || Number(theirs) !== 1) throw refuse(403, 'You can only message your friends');
  if (Number(iBlocked) === 1) throw refuse(422, 'You blocked this player: unblock them to send a message');
  if (Number(blockedByThem) === 1) throw refuse(403, 'This player does not accept your messages');
  const text = cleanChat(raw), image = rawImage ? cleanImage(rawImage) : null;
  if (rawImage && !image) throw refuse(422, 'This image could not be sent: try another one');
  if (!text && !image) throw refuse(422, 'Write a message first');
  const t = Date.now(), minute = Math.floor(t / 60000);
  if (image) {
    const [n] = await redis([['INCR', `dmimg:${me}:${dayKey(t)}`], ['EXPIRE', `dmimg:${me}:${dayKey(t)}`, 2 * 86400]]);
    if (Number(n) > DM_IMG_PER_DAY) throw refuse(429, 'Too many images today');
  }
  const [perMin, perDay] = await redis([['INCR', `dmrate:${me}:${minute}`], ['INCR', `dmrate:${me}:${dayKey(t)}`], ['EXPIRE', `dmrate:${me}:${minute}`, 120], ['EXPIRE', `dmrate:${me}:${dayKey(t)}`, 2 * 86400]]);
  if (Number(perMin) > DM_PER_MIN || Number(perDay) > DM_PER_DAY) throw refuse(429, 'Slow down: too many messages');
  const key = dmKey(me, other);
  if (image) await redis([['SET', dmImgKey(me, other, t), image, 'EX', DM_TTL]]);
  await redis([['RPUSH', key, JSON.stringify({ s: me, x: text, t, ...(image ? { img: 1 } : {}) })], ['LTRIM', key, -DM_KEEP, -1], ['EXPIRE', key, DM_TTL], ['HINCRBY', unreadKey(other), me, 1], ['EXPIRE', unreadKey(other), DM_TTL], ['HINCRBY', 'feat:dms', dayKey(t), 1]]); // compteur du jour pour la page Owner
}

// Présence (demandé par Sacha, 2026-10-21) : chaque page ouverte envoie toutes les minutes « active » ou « afk » (onglet
// caché ou aucune action depuis 5 min) avec la relecture des messages ; presence = { id: "<heure>:<état>" }. Sans
// signal depuis 150 s, l'ami est hors ligne.
const PRESENCE_TTL = 150000, RANK = { online: 2, afk: 1, offline: 0 };
// Un tirage récent (seen, écrit par le serveur à chaque tirage) vaut aussi signe de vie (signalé par kingston,
// 2026-10-30 : « Offline · last roll just now » pendant que l'ami tirait) : le signal de la page part toutes les 60 s
// et peut manquer (onglet en arrière-plan ralenti, requête refusée, tirage depuis un autre appareil).
function statusOf(raw, seen = 0) {
  const [t, s] = String(raw || '').split(':');
  if (!t || Date.now() - Number(t) > PRESENCE_TTL) return Date.now() - Number(seen || 0) <= PRESENCE_TTL ? 'online' : 'offline';
  return s === 'afk' ? 'afk' : 'online';
}

// Classement entre amis (idée d'Edward, 2026-11-05) : moi et mes amis, XP de toujours, XP du jour, meilleur tirage et
// nombre de tirages. Cinq commandes pour tout le monde, quel que soit le nombre d'amis ; par pseudo, jamais d'identifiant.
async function friendsBoard(id, friends, nameOf, myName) {
  const ids = [id, ...friends], day = xpKey(scopes(Date.now())[0]);
  const [xp, today, best, rolls] = await redis([['ZMSCORE', XP_LB, ...ids], ['ZMSCORE', day, ...ids], ['HMGET', 'best:all', ...ids], ['HMGET', 'count:all', ...ids]]);
  const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };
  return ids.map((pid, i) => {
    const b = parse((best || [])[i]);
    return { name: pid === id ? myName || 'Player' : nameOf(pid), ...(pid === id ? { me: true } : {}), xp: Number((xp || [])[i]) || 0, today: Number((today || [])[i]) || 0,
      best: b && Number.isInteger(b.n) ? { n: b.n, tier: engine.cardTier(Number(b.s) || 0), s: Number(b.s) || 0 } : null, rolls: Number((rolls || [])[i]) || 0 };
  });
}

async function state(id) {
  const [friends, incoming, outgoing, starred, [myName]] = await redis([['SMEMBERS', frKey(id)], ['SMEMBERS', inKey(id)], ['SMEMBERS', outKey(id)], ['SMEMBERS', starKey(id)], ['HMGET', 'names', id]]);
  const stars = new Set(starred || []);
  const all = [...new Set([...(friends || []), ...(incoming || []), ...(outgoing || [])])];
  let names = [], titles = [], extra = [], unread = [], presence = [];
  if (all.length) {
    [names, titles] = await redis([['HMGET', 'names', ...all], ['HMGET', 'titles', ...all]]);
    extra = await redis((friends || []).flatMap(f => [['ZSCORE', XP_LB, f], ['ZSCORE', SEEN_KEY, f], ['GET', `inroom:${f}`]]));
    presence = (friends || []).length ? (await redis([['HMGET', 'presence', ...friends]]))[0] || [] : [];
    unread = (friends || []).length ? (await redis([['HMGET', unreadKey(id), ...friends]]))[0] || [] : [];
  }
  const nameOf = pid => names[all.indexOf(pid)] || 'Player';
  const list = (friends || []).map((f, i) => ({
    name: nameOf(f), title: titles[all.indexOf(f)] || null,
    xp: Number(extra[i * 3] || 0), seen: Number(extra[i * 3 + 1] || 0), room: extra[i * 3 + 2] || null, unread: Number(unread[i] || 0),
    status: statusOf(presence[i], extra[i * 3 + 1]), ...(stars.has(f) ? { star: true } : {}),
  })).sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || (b.room ? 1 : 0) - (a.room ? 1 : 0) || RANK[b.status] - RANK[a.status] || b.seen - a.seen);
  const board = (friends || []).length ? await friendsBoard(id, friends, nameOf, myName) : [];
  return { friends: list, board, incoming: (incoming || []).map(nameOf).sort(), outgoing: (outgoing || []).map(nameOf).sort(), max: MAX_FRIENDS, now: Date.now(), gift: await giftInfo(id) };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  try {
    // Toujours en POST : le secret du joueur ne voyage jamais dans une adresse.
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    // Chat global (api/_global.js) : lisible sans joueur, il vérifie lui-même qui écrit ou modère.
    if (/^gc[A-Z]/.test(String(body.action || ''))) return send(res, 200, await Global.handle(body));
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    // La liste d'amis est privée : il faut prouver qui on est, même pour la lire.
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    if (body.action === 'list') return send(res, 200, await state(playerId));
    // Clans (api/_clan.js) : routés d'ici, api/ est déjà à 12 fonctions publiques.
    if (body.action === 'clan') return send(res, 200, await require('./_clan').handle(playerId, body));
    if (body.action === 'gifts') {
      // presz (idée de Thermonuclear Bomb, 2026-11-01) : compteur « N players online », voir api/_online.js.
      if (['active', 'afk'].includes(body.presence)) await redis([['HSET', 'presence', playerId, `${Date.now()}:${body.presence}`], ...require('./_online').presenceWrites(playerId, body.presence)]);
      const gifts = await unseenGifts(playerId);
      const [counts] = await redis([['HVALS', unreadKey(playerId)]]);
      // Gros tirages des amis depuis bigSince (idée de Jguz01, 2026-10-26) ; absent = alertes coupées dans les réglages.
      const big = body.bigSince != null ? await bigRolls(playerId, Number(body.bigSince) || 0) : undefined;
      // Invitations à une table de poker (api/_poker.js, 2026-11-03) : pseudo de l'ami et code de la table, rien d'autre.
      const poker = await require('./_poker').invitesFor(playerId);
      return send(res, 200, { gifts, coins: gifts.length ? Shop.balance(await readStats(playerId)) : null, messages: (counts || []).reduce((x, v) => x + (Number(v) || 0), 0), ...(big ? { big } : {}), ...(poker.length ? { poker } : {}) });
    }

    const other = await findPlayer(cleanName(body.name));
    if (!other) return send(res, 404, { error: 'No player with this name' });
    if (other === playerId) return send(res, 422, { error: 'That is you' });

    if (body.action === 'add') {
      // 30 demandes de comptes jetables bloquaient les vraies (audit de sécurité, 2026-11-02) : 10 tirages pour en envoyer.
      const [r1, r2] = await redis([['HGET', `stats:${playerId}`, 'rolls'], ['HGET', `stats:${playerId}`, 'h:rolls']]);
      if ((Number(r1) || 0) + (Number(r2) || 0) < 10) return send(res, 403, { error: 'Make 10 rolls to send friend requests' });
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
    // Réagir à un message du fil (Sacha, 2026-11-02) : seulement entre amis, et pas si l'un a bloqué l'autre.
    if (body.action === 'react') {
      const [mine, theirs, b1, b2, raw] = await redis([['SISMEMBER', frKey(playerId), other], ['SISMEMBER', frKey(other), playerId], ['SISMEMBER', blockKey(other), playerId], ['SISMEMBER', blockKey(playerId), other], ['LRANGE', dmKey(playerId, other), 0, -1]]);
      if (Number(mine) !== 1 || Number(theirs) !== 1 || Number(b1) === 1 || Number(b2) === 1) return send(res, 403, { error: 'You can only react to your friends' });
      const live = new Set((raw || []).map(x => { try { return String(JSON.parse(x).t); } catch (e) { return ''; } }));
      try { await React.toggle(dmRxKey(playerId, other), String(Number(body.t)), playerId, body.emoji, { live, ttl: DM_TTL }); }
      catch (err) { return send(res, err.status || 500, { error: err.message }); }
      return send(res, 200, await dmThread(playerId, other));
    }
    // Supprimer un de ses propres messages (idée d'Ann Joe NO.1 gambler, 2026-10-22) : retrouvé par son heure.
    if (body.action === 'unsend') {
      const key = dmKey(playerId, other);
      const [raw] = await redis([['LRANGE', key, 0, -1]]);
      const entry = (raw || []).find(x => { try { const m = JSON.parse(x); return m.s === playerId && Number(m.t) === Number(body.t); } catch (e) { return false; } });
      if (!entry) return send(res, 404, { error: 'This message is gone' });
      await redis([['LREM', key, 1, entry], ['DEL', dmImgKey(playerId, other, Number(body.t))]]);
      return send(res, 200, await dmThread(playerId, other));
    }
    // Lire une image du fil : seulement si le message existe encore entre ces deux joueurs.
    if (body.action === 'image') {
      const [raw] = await redis([['LRANGE', dmKey(playerId, other), 0, -1]]);
      const ok = (raw || []).some(x => { try { const m = JSON.parse(x); return m.img && Number(m.t) === Number(body.t); } catch (e) { return false; } });
      const [image] = ok ? await redis([['GET', dmImgKey(playerId, other, Number(body.t))]]) : [null];
      if (!image) return send(res, 404, { error: 'This image is gone' });
      return send(res, 200, { image });
    }
    // Modifier un de ses messages (idée de kingston, 2026-10-22) : même nettoyage qu'à l'envoi, marqué « edited ».
    if (body.action === 'edit') {
      const key = dmKey(playerId, other), text = cleanChat(body.text);
      if (!text) return send(res, 422, { error: 'Write a message first' });
      const [raw] = await redis([['LRANGE', key, 0, -1]]);
      const k = (raw || []).findIndex(x => { try { const m = JSON.parse(x); return m.s === playerId && Number(m.t) === Number(body.t); } catch (e) { return false; } });
      if (k < 0) return send(res, 404, { error: 'This message is gone' });
      await redis([['LSET', key, k, JSON.stringify({ ...JSON.parse(raw[k]), x: text, e: 1 })]]);
      return send(res, 200, await dmThread(playerId, other));
    }
    // Signaler un message reçu (api/_reports.js) : seulement un message de l'autre, retrouvé par son heure.
    if (body.action === 'report') {
      const [raw] = await redis([['LRANGE', dmKey(playerId, other), 0, -1]]);
      const m = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).find(x => x && x.s === other && Number(x.t) === Number(body.t));
      if (!m) return send(res, 404, { error: 'This message is gone' });
      try { return send(res, 200, await Reports.fileReport({ reporter: playerId, author: other, text: m.x, where: 'private message', msgT: m.t })); }
      catch (err) { return send(res, err.status || 500, { error: err.message }); }
    }
    if (body.action === 'message') { await sendDm(playerId, other, body.text, body.image); return send(res, 200, await dmThread(playerId, other)); }
    if (body.action === 'block' || body.action === 'unblock') {
      await redis([[body.action === 'block' ? 'SADD' : 'SREM', blockKey(playerId), other], ['HDEL', unreadKey(playerId), other]]);
      return send(res, 200, await dmThread(playerId, other));
    }
    if (body.action === 'gift') {
      const amount = await gift(playerId, other, body.amount);
      const [name] = await redis([['HGET', 'names', other]]);
      return send(res, 200, { ...(await state(playerId)), sent: { name: name || 'Player', amount } });
    }
    // Étoile (idée de Big Sexy, 2026-11-05) : seulement sur un ami ; l'autre ne le voit pas.
    if (body.action === 'star') {
      const [isFriend] = await redis([['SISMEMBER', frKey(playerId), other]]);
      if (Number(isFriend) !== 1) return send(res, 404, { error: 'This player is not your friend' });
      await redis([[body.on === false ? 'SREM' : 'SADD', starKey(playerId), other]]);
      return send(res, 200, await state(playerId));
    }
    if (body.action === 'remove') {
      await redis([['SREM', frKey(playerId), other], ['SREM', frKey(other), playerId], ['SREM', starKey(playerId), other], ['SREM', starKey(other), playerId]]);
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
