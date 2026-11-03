// Tables de poker du casino (demandé par Sacha, 2026-11-03 : « in casino, add a poker table so you can play against
// bot or against your friend to bet your money »). Texas Hold'em à deux, sans limite, avec les pièces du jeu.
// Le jeu lui-même (cartes, mains, enchères, bot) est dans api/_holdem.js ; ici : les tables dans Redis, les pièces, les
// invitations, les minuteries. Pas une fonction publique (nom en « _ ») : api/shop.js y renvoie l'action « poker ».
//   POST /api/shop { action: 'poker', op, … }
//     op 'state'                       → ma table (sondée par le site tant que l'onglet Poker est ouvert), ou le salon
//     op 'bot' { buyin }               → s'asseoir contre le bot (cave débitée tout de suite)
//     op 'create' { buyin, name? }     → ouvrir une table pour un ami (invité par son pseudo, ou par le code de la table)
//     op 'invite' { name }             → inviter un (autre) ami à la table qui attend
//     op 'join' { code }               → rejoindre une table qui attend (même cave, débitée)
//     op 'decline' { code }            → refuser une invitation
//     op 'act' { move, to? }           → fold | check | call | raise (to = total misé sur ce tour) | allin
//     op 'next'                        → contre le bot : distribuer la main suivante sans attendre
//     op 'leave'                       → quitter : la main en cours est couchée, chacun encaisse son tapis
//     op 'ack'                         → match fini, vu : retour au salon (sinon le match fini reste affiché 2 min)
// Règles d'argent : la cave est débitée à l'entrée (stats.spent, sous le verrou du porte-monnaie), le tapis est rendu à
// la sortie (stats.bonus). Entre les deux, les pièces sont sur la table (pk:<code>). Une table que plus personne ne
// regarde depuis 2 minutes est réglée toute seule (vérifiée chaque minute par la file `pending`, api/_lib.js flushDue) :
// la main en cours se finit comme si le joueur ne répondait plus, puis chacun encaisse. Aucune pièce ne se perd.
// Commission (api/_holdem.js) : 5 % de chaque pot, qui disparaissent. Le bot joue avec l'argent de la maison.
// Comptes de la maison : à l'encaissement, ledger() du casino avec la cave comme mise et le tapis comme gain (jeu
// « poker ») ; la commission et les gains du bot y apparaissent donc tout seuls.
'use strict';
const crypto = require('node:crypto');
const { redis, wallet, readStats, statsKey, queueReveal, findPlayer, cleanName, toObject, dayKey } = require('./_lib');
const Shop = require('../js/shop.js');
const Gamble = require('./_gamble');
const H = require('./_holdem');

const BUYINS = [100, 250, 500, 1000, 2500, 5000]; // blinds = 1 % et 2 % de la cave
const BOT_MAX = 5000; // cave maximale contre le bot (la maison joue l'autre moitié)
const TURN_MS = 30000; // contre un ami : 30 s pour jouer, sinon check (ou fold) automatique ; deux de suite = départ
const STALE_MS = 120000; // personne sur la table depuis 2 min : réglée et encaissée
const CHECK_MS = 60000; // vérification de secours, chaque minute, tant que la table vit
const SEEN_MS = 4000; // la présence d'un joueur n'est réécrite qu'une fois toutes les 4 s (sondage toutes les ~1,5 s)
const AWAY_MS = 12000; // l'adversaire ne sonde plus depuis 12 s : affiché « away »
const NEXT_MS = { bot: 3500, friend: 5000 }; // résultat affiché avant la main suivante
const BOT_THINK = [700, 1700]; // le bot « réfléchit » un peu : on voit son coup arriver
const INVITE_S = 600, TABLE_S = 86400, LAST_S = 3600, OVER_S = 120, LOG_KEPT = 14;
// Tables entre amis : perdre exprès ferait passer des pièces d'un compte à l'autre sans les limites des cadeaux
// (api/friends.js : 300 tirages, 1 000 pièces par jour). Mêmes 300 tirages, et au plus 2 500 pièces de caves par jour
// et par joueur aux tables entre amis (comptées quand la partie commence, pour les deux joueurs). Le bot n'est pas limité.
const FRIEND_ROLLS = 300, FRIEND_DAY = 2500;
const friendDayKey = now => `pkday:${dayKey(now)}`;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Robo', 'Ace Bot', 'Bluffy', 'Chipper', 'Deuce', 'Nano', 'Byte'];

const tableKey = code => `pk:${code}`, lockKey = code => `pkl:${code}`, seenKey = code => `pks:${code}`;
const seatKey = id => `pkp:${id}`, inviteKey = id => `pkinv:${id}`, lastKey = id => `pklast:${id}`;
const STATS_KEY = 'pkstats'; // mains jouées, commission prise, pots : pour la page Owner (aucun joueur dedans)
const isCode = c => /^[A-Z2-9]{6}$/.test(c);
const refuse = (status, error) => Object.assign(new Error(error), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = n => crypto.randomInt(0, n);
// Hasard du bot (Monte-Carlo, bluffs) : un générateur rapide (sfc32) semé par crypto à chaque décision.
function botRng() {
  const b = crypto.randomBytes(16);
  let a = b.readUInt32LE(0), c = b.readUInt32LE(4), d = b.readUInt32LE(8), e = b.readUInt32LE(12);
  return () => {
    a |= 0; c |= 0; d |= 0; e |= 0;
    const t = (((a + c) | 0) + e) | 0; e = (e + 1) | 0; a = c ^ (c >>> 9); c = (d + (d << 3)) | 0; d = (d << 21) | (d >>> 11); d = (d + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
const buyinOf = v => (BUYINS.includes(Number(v)) ? Number(v) : 0);
const blindsOf = buyin => { const sb = Math.max(1, Math.round(buyin / 100)); return { sb, bb: 2 * sb }; };

// ---------------------------------------------------------------- verrou et lecture d'une table
// Un coup à la fois par table : chaque changement (coup, minuterie, départ) se fait sous pkl:<code>, jeton propre.
async function withTable(code, fn) {
  const key = lockKey(code), token = crypto.randomBytes(8).toString('hex');
  let lock = null;
  for (let tries = 0; tries < 30 && lock !== 'OK'; tries++) {
    if (tries) await sleep(50);
    [lock] = await redis([['SET', key, token, 'PX', 8000, 'NX']]);
  }
  if (lock !== 'OK') throw refuse(429, 'Busy, try again');
  try { return await fn(); } finally { const [cur] = await redis([['GET', key]]); if (cur === token) await redis([['DEL', key]]); }
}
async function load(code) {
  const [raw, seen] = await redis([['GET', tableKey(code)], ['HGETALL', seenKey(code)]]);
  if (!raw) return null;
  const t = JSON.parse(raw);
  t.seen = toObject(seen); // présence de chaque siège (heure du dernier sondage), gardée à part : pas de verrou pour l'écrire
  return t;
}
async function save(t, writes = []) {
  const { seen, ...rest } = t;
  t.v = rest.v = (t.v || 0) + 1;
  await redis([['SET', tableKey(t.code), JSON.stringify(rest), 'EX', TABLE_S], ['EXPIRE', seenKey(t.code), TABLE_S], ...writes]);
}
const seatOf = (t, id) => t.seats.findIndex(s => s && s.id === id);
const lastSeen = (t, i) => Math.max(Number(t.seen && t.seen[i]) || 0, t.seats[i] && t.seats[i].at || 0);

// ---------------------------------------------------------------- journal de la table
// Entrées courtes { s: siège, m: coup, a: montant } ; le site écrit la phrase avec le pseudo (jamais d'identifiant).
const log = (t, e) => { t.log.push(e); if (t.log.length > LOG_KEPT) t.log.splice(0, t.log.length - LOG_KEPT); };

// ---------------------------------------------------------------- déroulé
function deal(t, now) {
  t.hands = (t.hands || 0) + 1;
  H.newHand(t, rnd);
  t.hand.n = t.hands;
  log(t, { m: 'hand', a: t.hands });
  schedule(t, now);
}
// Après chaque coup : à qui le tour, et sa minuterie (le bot réfléchit ~1 s ; un ami a 30 s ; contre le bot, le
// joueur a tout son temps tant qu'il reste sur la page).
function schedule(t, now) {
  const h = t.hand;
  t.deadline = 0; t.botAt = 0;
  if (!h) return;
  if (h.done) { t.nextAt = now + (t.bot ? NEXT_MS.bot : NEXT_MS.friend); return; }
  if (t.seats[h.turn].bot) t.botAt = now + BOT_THINK[0] + rnd(BOT_THINK[1] - BOT_THINK[0]);
  else if (!t.bot) t.deadline = now + TURN_MS;
}
// Un coup vient d'être joué : journal, fin de main éventuelle (commission comptée, match fini si un tapis est vide).
function afterMove(t, now) {
  const h = t.hand, w = [];
  if (h.last) log(t, { ...h.last });
  h.last = null;
  if (h.done) {
    const r = h.res;
    log(t, r.w >= 0 ? { s: r.w, m: 'win', a: r.win[r.w], d: r.shown ? r.desc[r.w] + (r.kick ? ` · ${r.kick}` : '') : undefined } : { m: 'split', a: r.win[0] });
    w.push(['HINCRBY', STATS_KEY, 'hands', 1], ['HINCRBY', STATS_KEY, 'rake', r.rake], ['HINCRBY', STATS_KEY, 'pots', r.pot], ['HINCRBY', STATS_KEY, t.bot ? 'botHands' : 'friendHands', 1]);
    if (t.status === 'play' && t.seats.some(s => s.stack === 0)) { schedule(t, now); w.push(...endMatch(t, now, 'bust')); return w; }
  }
  schedule(t, now);
  return w;
}
function botAct(t, now) {
  const i = t.hand.turn, d = H.botMove(t, i, t.om, botRng());
  try { H.act(t, i, d.move, d.to); } catch (err) { H.act(t, i, H.options(t, i).canCheck ? 'check' : 'fold'); } // jamais bloqué
  return afterMove(t, now);
}
// Pas de réponse à temps : check si possible, sinon fold. Deux fois de suite : il quitte la table.
function timeout(t, i, now) {
  const seat = t.seats[i];
  H.act(t, i, H.options(t, i).canCheck ? 'check' : 'fold');
  seat.to = (seat.to || 0) + 1;
  log(t, { s: i, m: 'timeout' });
  const w = afterMove(t, now);
  if (t.status !== 'over' && seat.to >= 2) w.push(...endMatch(t, now, 'timeout', i));
  return w;
}
// Encaissement d'un siège humain (une seule fois : seat.cashed). Rien joué (table jamais commencée) : simple
// remboursement, hors des comptes du casino. Sinon : tapis rendu, comptes du casino (cave misée, tapis gagné).
function cashOut(t, i, now, reason) {
  const seat = t.seats[i];
  if (!seat || seat.bot || seat.cashed != null) return [];
  const cash = seat.stack, hands = t.hands || 0;
  seat.cashed = cash; seat.stack = 0;
  const opp = t.seats[1 - i];
  const summary = JSON.stringify({ cash, buyin: t.buyin, net: cash - t.buyin, hands, reason, mine: !!t.over && t.over.who === i, vs: opp ? opp.name : null, bot: !!t.bot, t: now });
  // Le siège garde la table finie 2 min : les deux joueurs voient la fin du match (dernière main, raison, encaissement)
  // jusqu'à ce qu'ils reviennent au salon (op 'ack'). Une table finie n'empêche pas d'en ouvrir une autre.
  const w = [['SET', seatKey(seat.id), t.code, 'EX', OVER_S], ['SET', lastKey(seat.id), summary, 'EX', LAST_S]];
  if (!hands) return [...w, ['HINCRBY', statsKey(seat.id), 'spent', -cash]];
  return [...w, ['HINCRBY', statsKey(seat.id), 'bonus', cash], ['HINCRBY', statsKey(seat.id), 'gPoker', hands], ['HINCRBY', statsKey(seat.id), 'gBet', t.buyin], ['HINCRBY', statsKey(seat.id), 'gWon', cash], ...Gamble.ledger(seat.id, 'poker', t.buyin, cash, hands)];
}
// Fin du match : la main en cours est couchée par celui qui part (who), puis tout le monde encaisse.
function endMatch(t, now, reason, who = -1) {
  if (t.status === 'over') return [];
  t.status = 'over'; t.over = { reason, who, t: now };
  const w = [];
  if (t.hand && !t.hand.done && who >= 0) { H.forfeit(t, who); w.push(...afterMove(t, now)); }
  t.deadline = 0; t.botAt = 0; t.nextAt = 0;
  if (who >= 0) log(t, { s: who, m: reason === 'timeout' ? 'gone' : 'leave' });
  return [...w, ...t.seats.flatMap((s, i) => cashOut(t, i, now, reason))];
}
// Table abandonnée (plus personne depuis 2 min) : la main en cours se joue jusqu'au bout comme si les absents ne
// répondaient plus (check, sinon fold ; le bot joue normalement), puis chacun encaisse. Une table qui attendait son
// ami est simplement annulée et remboursée.
function abandon(t, now) {
  const w = [];
  if (t.status === 'wait') { t.status = 'over'; t.over = { reason: 'idle', who: -1, t: now }; return [...w, ...t.seats.flatMap((s, i) => cashOut(t, i, now, 'idle'))]; }
  for (let k = 0; k < 40 && t.hand && !t.hand.done; k++) {
    const i = t.hand.turn;
    if (t.seats[i].bot) w.push(...botAct(t, now));
    else { H.act(t, i, H.options(t, i).canCheck ? 'check' : 'fold'); w.push(...afterMove(t, now)); }
  }
  return [...w, ...endMatch(t, now, 'idle')];
}
// Tout ce qui devait arriver avant `now` : table abandonnée, main suivante, coup du bot, minuterie dépassée.
function advance(t, now) {
  const w = [];
  for (let k = 0; k < 60 && t.status !== 'over'; k++) {
    const humans = t.seats.map((s, i) => (s && !s.bot ? i : -1)).filter(i => i >= 0);
    if (now - Math.max(...humans.map(i => lastSeen(t, i))) > STALE_MS) { w.push(...abandon(t, now)); break; }
    if (t.status === 'wait') break;
    const h = t.hand;
    if (h.done) { if (now >= t.nextAt) { deal(t, now); continue; } break; }
    if (t.seats[h.turn].bot) { if (now >= t.botAt) { w.push(...botAct(t, now)); continue; } break; }
    if (t.deadline && now >= t.deadline) { w.push(...timeout(t, h.turn, now)); continue; }
    break;
  }
  return w;
}
function due(t, now) {
  if (t.status === 'over') return false;
  const humans = t.seats.map((s, i) => (s && !s.bot ? i : -1)).filter(i => i >= 0);
  if (now - Math.max(...humans.map(i => lastSeen(t, i))) > STALE_MS) return true;
  if (t.status !== 'play' || !t.hand) return false;
  if (t.hand.done) return now >= t.nextAt;
  return t.seats[t.hand.turn].bot ? now >= t.botAt : !!t.deadline && now >= t.deadline;
}
// Vérification de secours (file `pending`, chaque minute) : règle une table abandonnée même si personne ne la rouvre.
async function check(code, now = Date.now()) {
  let again = true;
  try {
    again = await withTable(code, async () => {
      const t = await load(code);
      if (!t || t.status === 'over') return false;
      if (due(t, now)) await save(t, advance(t, now));
      return t.status !== 'over';
    });
  } catch (err) { console.error('poker check', code, err.message); }
  if (again) await redis([queueReveal(now + CHECK_MS, { poker: code })]);
}

// ---------------------------------------------------------------- ce que voit un joueur
// Jamais d'identifiant, jamais le paquet, jamais les cartes de l'autre avant l'abattage.
const card = H.toClient;
function view(t, i, now) {
  const h = t.hand, o = 1 - i, me = t.seats[i], opp = t.seats[o];
  const rel = s => (s === i ? 'me' : s === o ? 'opp' : undefined);
  const seat = (s, k) => (s ? { name: s.name, bot: !!s.bot, stack: s.cashed != null ? s.cashed : s.stack, btn: !!h && h.btn === k, bet: h && !h.done ? h.bet[k] : 0, ...(s.bot || k === i || t.status !== 'play' ? {} : { away: now - lastSeen(t, k) > AWAY_MS }) } : null);
  const out = {
    code: t.code, v: t.v, bot: !!t.bot, status: t.status, buyin: t.buyin, sb: t.sb, bb: t.bb, hands: t.hands || 0,
    me: seat(me, i), opp: seat(opp, o), timeouts: me.to || 0,
    log: t.log.slice(-8).map(e => ({ m: e.m, a: e.a, d: e.d, s: rel(e.s) })),
  };
  if (t.status === 'wait') out.invited = (t.invited || []).map(x => x.name);
  if (t.status === 'over') out.over = { reason: t.over.reason, mine: t.over.who === i, cash: me.cashed || 0, net: (me.cashed || 0) - t.buyin };
  if (h) {
    const mineTurn = !h.done && h.turn === i;
    out.hand = {
      n: h.n, street: h.street, board: h.board.map(card), pot: h.put[0] + h.put[1], mine: h.hole[i].map(card), done: h.done,
      turn: h.done ? null : rel(h.turn), left: !h.done && t.deadline ? Math.max(0, t.deadline - now) : null,
      ...(mineTurn ? { op: H.options(t, i) } : {}),
    };
    if (h.done) {
      const r = h.res;
      out.hand.next = t.status === 'play' ? Math.max(0, t.nextAt - now) : null;
      out.hand.res = { pot: r.pot, rake: r.rake, won: r.win[i], w: r.w < 0 ? 'split' : rel(r.w), shown: r.shown, fold: h.folded != null ? rel(h.folded) : null };
      if (r.shown) {
        out.hand.theirs = h.hole[o].map(card);
        out.hand.res.desc = { me: r.desc[i], opp: r.desc[o] };
        if (r.kick) out.hand.res.kick = r.kick;
        out.hand.res.best = r.best.map(card);
      }
    }
  }
  return out;
}
// Salon (pas de table) : invitations reçues encore valables, résultat du dernier match, caves possibles.
async function lobby(id, now) {
  const [inv, last] = await redis([['HGETALL', inviteKey(id)], ['GET', lastKey(id)]]);
  const all = Object.entries(toObject(inv)).map(([code, raw]) => { try { return { code, ...JSON.parse(raw) }; } catch (e) { return null; } }).filter(x => x && now - x.t < INVITE_S * 1000);
  const tables = all.length ? await redis(all.map(x => ['GET', tableKey(x.code)])) : [];
  const invites = all.filter((x, k) => { try { return JSON.parse(tables[k]).status === 'wait'; } catch (e) { return false; } }).slice(-5).map(x => ({ code: x.code, name: x.name, buyin: x.buyin }));
  let lastMatch = null; try { lastMatch = last ? JSON.parse(last) : null; } catch (e) { /* illisible */ }
  const [used] = await redis([['HGET', friendDayKey(now), id]]);
  return { idle: true, invites, last: lastMatch, buyins: BUYINS, botMax: BOT_MAX, minRolls: Gamble.MIN_ROLLS, rake: H.RAKE, coins: Shop.balance(await readStats(id)), friend: { rolls: FRIEND_ROLLS, day: FRIEND_DAY, left: Math.max(0, FRIEND_DAY - (Number(used) || 0)) } };
}

// ---------------------------------------------------------------- entrer à une table
async function newCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), b => ALPHABET[b % 32]).join('');
    const [taken] = await redis([['EXISTS', tableKey(code)]]);
    if (!Number(taken)) return code;
  }
}
// Sous le verrou du porte-monnaie du joueur : une seule table à la fois, 30 tirages, assez de pièces.
async function mayBuyIn(id, buyin, friend = false, now = Date.now()) {
  const [cur] = await redis([['GET', seatKey(id)]]);
  if (cur) {
    const [raw] = await redis([['GET', tableKey(cur)]]);
    let over = true; try { over = !raw || JSON.parse(raw).status === 'over'; } catch (e) { /* illisible : comme finie */ }
    if (!over) throw refuse(422, 'You are already at a poker table');
  }
  const st = await readStats(id), rolls = Number(st.rolls) || 0;
  if (rolls < Gamble.MIN_ROLLS) throw refuse(422, `Gamble unlocks after ${Gamble.MIN_ROLLS} rolls (you have ${rolls})`);
  const coins = Shop.balance(st);
  if (coins < buyin) throw refuse(422, `Not enough coins: ${buyin - coins} more needed`);
  if (friend) {
    if (rolls < FRIEND_ROLLS) throw refuse(422, `Poker with friends unlocks after ${FRIEND_ROLLS} rolls (you have ${rolls})`);
    await friendRoom(id, buyin, now, 'You');
  }
}
// Reste du jour pour les caves entre amis ; who = « You » ou le pseudo de l'hôte, pour le message.
async function friendRoom(id, buyin, now, who) {
  const [used] = await redis([['HGET', friendDayKey(now), id]]);
  const left = Math.max(0, FRIEND_DAY - (Number(used) || 0));
  if (buyin > left) throw refuse(422, `${who === 'You' ? 'You' : who} can only put ${left} more coins on friend tables today (${FRIEND_DAY} a day)`);
}
const friendDayWrites = (t, now) => [...t.seats.map(x => ['HINCRBY', friendDayKey(now), x.id, t.buyin]), ['EXPIRE', friendDayKey(now), 2 * 86400]];
const nameOf = async id => (await redis([['HGET', 'names', id]]))[0] || 'Player';
const buyInWrites = (t, id, now, i) => [['HINCRBY', statsKey(id), 'spent', t.buyin], ['SET', seatKey(id), t.code, 'EX', TABLE_S], ['DEL', lastKey(id)], ['HSET', seenKey(t.code), i, now]];
function newTable(code, buyin, now, host, bot) {
  const { sb, bb } = blindsOf(buyin);
  return { code, v: 0, bot, buyin, sb, bb, created: now, status: bot ? 'play' : 'wait', hands: 0, btn: rnd(2), hand: null, log: [], seats: [host, null], ...(bot ? { om: H.newModel() } : { invited: [] }), seen: {} };
}
async function sitBot(id, body, now) {
  const buyin = buyinOf(body.buyin);
  if (!buyin || buyin > BOT_MAX) throw refuse(400, `Buy-in: ${BUYINS.join(', ')} coins`);
  return wallet(id, async () => {
    await mayBuyIn(id, buyin);
    const code = await newCode();
    const t = newTable(code, buyin, now, { id, name: await nameOf(id), stack: buyin, to: 0, at: now }, true);
    t.seats[1] = { bot: true, name: BOT_NAMES[rnd(BOT_NAMES.length)], stack: buyin };
    deal(t, now);
    await save(t, [...buyInWrites(t, id, now, 0), queueReveal(now + CHECK_MS, { poker: code })]);
    return view(t, 0, now);
  });
}
// Inviter un ami : seulement quelqu'un de sa liste d'amis (amitié réciproque, api/friends.js).
async function inviteWrites(t, me, rawName, now) {
  const other = await findPlayer(cleanName(rawName));
  if (!other) throw refuse(404, 'No player with this name');
  if (other === me) throw refuse(422, 'That is you');
  const [friend] = await redis([['SISMEMBER', `fr:${me}`, other]]);
  if (Number(friend) !== 1) throw refuse(403, 'You can only invite your friends');
  if ((t.invited || []).length >= 5) throw refuse(422, 'At most 5 invitations per table');
  const name = await nameOf(other);
  if (!(t.invited || []).some(x => x.id === other)) t.invited.push({ id: other, name });
  return [['HSET', inviteKey(other), t.code, JSON.stringify({ name: t.seats[0].name, buyin: t.buyin, t: now })], ['EXPIRE', inviteKey(other), INVITE_S]];
}
async function create(id, body, now) {
  const buyin = buyinOf(body.buyin);
  if (!buyin) throw refuse(400, `Buy-in: ${BUYINS.join(', ')} coins`);
  return wallet(id, async () => {
    await mayBuyIn(id, buyin, true, now);
    const code = await newCode();
    const t = newTable(code, buyin, now, { id, name: await nameOf(id), stack: buyin, to: 0, at: now }, false);
    const inv = body.name ? await inviteWrites(t, id, body.name, now) : [];
    await save(t, [...buyInWrites(t, id, now, 0), ...inv, queueReveal(now + CHECK_MS, { poker: code })]);
    return view(t, 0, now);
  });
}
async function myTable(id) {
  const [code] = await redis([['GET', seatKey(id)]]);
  return code && isCode(code) ? code : null;
}
async function invite(id, body, now) {
  const code = await myTable(id);
  if (!code) throw refuse(404, 'You are not at a poker table');
  return withTable(code, async () => {
    const t = await load(code);
    if (!t || t.status !== 'wait' || seatOf(t, id) !== 0) throw refuse(422, 'The game already started');
    await save(t, await inviteWrites(t, id, body.name, now));
    return view(t, 0, now);
  });
}
// Rejoindre : porte-monnaie du joueur d'abord, puis la table (toujours dans cet ordre : jamais d'attente croisée).
async function join(id, body, now) {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!isCode(code)) throw refuse(400, 'Enter a table code');
  return wallet(id, () => withTable(code, async () => {
    const t = await load(code);
    if (!t || t.status === 'over') { await redis([['HDEL', inviteKey(id), code]]); throw refuse(404, 'This table is gone'); }
    if (seatOf(t, id) >= 0) return view(t, seatOf(t, id), now);
    if (t.bot || t.status !== 'wait' || t.seats[1]) throw refuse(422, 'This table is full');
    await mayBuyIn(id, t.buyin, true, now);
    await friendRoom(t.seats[0].id, t.buyin, now, t.seats[0].name); // l'hôte a pu jouer ailleurs depuis l'ouverture
    t.seats[1] = { id, name: await nameOf(id), stack: t.buyin, to: 0, at: now };
    t.status = 'play';
    log(t, { s: 1, m: 'join' });
    deal(t, now);
    await save(t, [...buyInWrites(t, id, now, 1), ...friendDayWrites(t, now), ['HDEL', inviteKey(id), code], ...(t.invited || []).filter(x => x.id !== id).map(x => ['HDEL', inviteKey(x.id), code])]);
    return view(t, 1, now);
  }));
}
// ---------------------------------------------------------------- jouer, quitter, regarder
async function play(id, body, now) {
  const code = await myTable(id);
  if (!code) throw refuse(404, 'You are not at a poker table');
  return withTable(code, async () => {
    const t = await load(code);
    const i = t ? seatOf(t, id) : -1;
    if (i < 0) throw refuse(404, 'You are not at a poker table');
    t.seen[i] = now;
    const w = advance(t, now);
    if (t.status !== 'play') { await save(t, w); return view(t, i, now); }
    const op = String(body.op);
    if (op === 'next') {
      // Contre le bot seulement (entre amis, la main suivante part toute seule après 5 s) ; déjà distribuée : rien.
      if (!t.bot) throw refuse(422, 'The next hand starts by itself');
      if (t.hand && t.hand.done) deal(t, now);
    } else {
      if (!t.hand || t.hand.done) throw refuse(422, 'Wait for the next hand');
      if (t.hand.turn !== i) throw refuse(422, 'Not your turn');
      const move = String(body.move || ''), before = t.om ? { ...t.om } : null;
      if (t.om) H.observe(t.om, t, i, move); // ce que le bot retient de son adversaire (ses coups, jamais ses cartes)
      try { H.act(t, i, move, body.to); } catch (err) { if (before) t.om = before; throw err; }
      t.seats[i].to = 0;
      w.push(...afterMove(t, now));
    }
    await save(t, [...w, ['HSET', seenKey(code), i, now]]);
    return view(t, i, now);
  });
}
async function leave(id, now) {
  const code = await myTable(id);
  if (!code) return lobby(id, now);
  const out = await withTable(code, async () => {
    const t = await load(code);
    const i = t ? seatOf(t, id) : -1;
    if (i < 0 || t.status === 'over') { await redis([['DEL', seatKey(id)]]); return null; } // match fini : retour au salon
    const w = t.status === 'play' ? advance(t, now) : [];
    if (t.status === 'wait') {
      t.status = 'over'; t.over = { reason: 'cancel', who: i, t: now };
      w.push(...cashOut(t, i, now, 'cancel'), ...(t.invited || []).map(x => ['HDEL', inviteKey(x.id), code]));
    } else w.push(...endMatch(t, now, 'leave', i));
    await save(t, w);
    return view(t, i, now);
  });
  return out || lobby(id, now);
}
async function state(id, now) {
  const code = await myTable(id);
  if (!code) return lobby(id, now);
  let t = await load(code);
  const i = t ? seatOf(t, id) : -1;
  if (i < 0) { await redis([['DEL', seatKey(id)]]); return lobby(id, now); }
  if (now - (Number(t.seen[i]) || 0) > SEEN_MS) { await redis([['HSET', seenKey(code), i, now]]); t.seen[i] = now; }
  if (due(t, now)) {
    t = await withTable(code, async () => {
      const fresh = await load(code);
      fresh.seen[i] = now;
      if (due(fresh, now)) await save(fresh, advance(fresh, now));
      return fresh;
    });
  }
  return view(t, i, now);
}
async function decline(id, body) {
  await redis([['HDEL', inviteKey(id), String(body.code || '').toUpperCase().slice(0, 6)]]);
  return lobby(id, Date.now());
}
// Invitations en attente, pour l'alerte du site (relève des cadeaux, api/friends.js) : pseudo et code seulement.
async function invitesFor(id, now = Date.now()) {
  const [inv] = await redis([['HGETALL', inviteKey(id)]]);
  return Object.entries(toObject(inv)).map(([code, raw]) => { try { const x = JSON.parse(raw); return now - x.t < INVITE_S * 1000 ? { code, name: x.name, buyin: x.buyin } : null; } catch (e) { return null; } }).filter(Boolean).slice(-3);
}

async function handle(id, body, now = Date.now()) {
  const op = String(body.op || 'state');
  if (op === 'state') return state(id, now);
  if (op === 'bot') return sitBot(id, body, now);
  if (op === 'create') return create(id, body, now);
  if (op === 'invite') return invite(id, body, now);
  if (op === 'join') return join(id, body, now);
  if (op === 'decline') return decline(id, body);
  if (op === 'act' || op === 'next') return play(id, body, now);
  if (op === 'leave' || op === 'ack') return leave(id, now);
  throw refuse(400, 'Unknown poker action');
}

module.exports = { handle, check, invitesFor, view, advance, BUYINS, BOT_MAX, TURN_MS, STALE_MS, CHECK_MS, tableKey, seatKey, inviteKey, STATS_KEY };
