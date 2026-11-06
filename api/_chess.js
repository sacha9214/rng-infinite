// Échecs du casino (demandé par Sacha, 2026-11-06 : « can you add a chess game in the casino where we can bet our money
// with bot or against player? »). Décisions validées par Sacha le 2026-11-06 :
//   - contre le bot : entraînement seulement, sans pièces. N'importe qui gagnerait en recopiant les coups d'un moteur
//     d'échecs en ligne : toute mise payée plus que la mise serait une ferme à pièces. Le bot tourne dans le navigateur
//     (js/chess.js, bestMove) et ne passe jamais par ici.
//   - contre un joueur : mise égale des deux côtés, gardée ici ; le gagnant prend les deux mises moins 5 % pour la
//     maison ; nulle ou partie annulée : chacun récupère sa mise. Mêmes garde-fous que le poker entre amis (300 tirages,
//     compte de 3 jours) et le même plafond du jour, partagé avec le poker (pkday, 2 500 pièces).
//   - pendules tenues par le serveur ; chaque coup vérifié par js/chess.js ; le résultat se décide ici.
// Pas une fonction publique (nom en « _ ») : api/shop.js y renvoie l'action « chess ».
//   POST /api/shop { action: 'chess', op, … }
//     op 'state'                         → ma partie (sondée par le site tant que l'onglet Échecs est ouvert), ou le salon
//     op 'create' { stake, tc, name?, open? } → défi : à un ami (name), ouvert à tous (open), ou par code seulement
//     op 'join' { code }                 → accepter un défi (mise débitée, couleurs tirées au sort)
//     op 'decline' { code }              → refuser une invitation
//     op 'cancel'                        → l'auteur retire son défi pas encore accepté (mise rendue)
//     op 'move' { m }                    → jouer un coup (« e2e4 », « e7e8q »)
//     op 'draw' / 'nodraw'               → proposer ou accepter la nulle / la refuser
//     op 'resign'                        → abandonner (avant le 2e coup : partie annulée, mises rendues)
//     op 'ack'                           → partie finie, vue : retour au salon
'use strict';
const crypto = require('node:crypto');
const { redis, wallet, readStats, statsKey, queueReveal, findPlayer, cleanName, toObject, accountWait, NEW_ACCOUNT_DAYS } = require('./_lib');
const Shop = require('../js/shop.js');
const Chess = require('../js/chess.js');
const Gamble = require('./_gamble');
const Poker = require('./_poker');

const STAKES = [0, 50, 100, 250, 500, 1000]; // 0 = partie amicale, sans pièces
const CLOCKS = { '3+2': [180000, 2000], '5+3': [300000, 3000], '10+0': [600000, 0] }; // temps de base, ajout par coup
const RAKE = 0.05;
const FIRST_MS = 30000; // chaque joueur a 30 s pour son premier coup, sinon partie annulée (mises rendues)
const WAIT_MS = 600000; // un défi pas accepté en 10 min est retiré
const HOST_IDLE_MS = 45000; // l'auteur d'un défi n'est plus sur la page depuis 45 s : défi retiré (pas de défi fantôme)
const SEEN_MS = 4000, AWAY_MS = 15000, CHECK_MS = 60000;
const GAME_S = 86400, OVER_S = 600, INVITE_S = 600, OPEN_SHOWN = 20, OFFERS_MAX = 3, MOVES_MAX = 600;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gameKey = c => `cg:${c}`, lockKey = c => `cgl:${c}`, seenKey = c => `cgs:${c}`;
const myKey = id => `cgp:${id}`, inviteKey = id => `cginv:${id}`;
const OPEN_KEY = 'cgopen', STATS_KEY = 'cgstats';
const isCode = c => /^[A-Z2-9]{6}$/.test(c);
const refuse = (status, error) => Object.assign(new Error(error), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const other = c => (c === 'w' ? 'b' : 'w');
const stakeOf = v => (STAKES.includes(Number(v)) ? Number(v) : -1);
const potPay = stake => { const pot = 2 * stake, rake = Math.round(pot * RAKE); return { pot, rake, win: pot - rake }; };

// ---------------------------------------------------------------- verrou et lecture
async function withGame(code, fn) {
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
  const [raw, seen] = await redis([['GET', gameKey(code)], ['HGETALL', seenKey(code)]]);
  if (!raw) return null;
  const g = JSON.parse(raw);
  g.seen = toObject(seen); // dernière visite de chaque joueur (w, b, ou host pendant l'attente), écrite sans verrou
  return g;
}
async function save(g, writes = []) {
  const { seen, ...rest } = g;
  g.v = rest.v = (g.v || 0) + 1;
  await redis([['SET', gameKey(g.code), JSON.stringify(rest), 'EX', GAME_S], ['EXPIRE', seenKey(g.code), GAME_S], ...writes]);
}
const colorOf = (g, id) => (g.p ? (g.p.w.id === id ? 'w' : g.p.b.id === id ? 'b' : null) : null);
const nameOf = async id => (await redis([['HGET', 'names', id]]))[0] || 'Player';
async function newCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), b => ALPHABET[b % 32]).join('');
    const [taken] = await redis([['EXISTS', gameKey(code)]]);
    if (!Number(taken)) return code;
  }
}

// ---------------------------------------------------------------- garde-fous des mises
// Plafond du jour partagé avec le poker (même clé pkday) : perdre exprès contre son autre compte passerait des pièces
// sans les limites des cadeaux, aux échecs comme au poker.
async function dayLeft(id, now) {
  const [used] = await redis([['HGET', Poker.friendDayKey(now), id]]);
  return Math.max(0, Poker.FRIEND_DAY - (Number(used) || 0));
}
async function room(id, stake, now, who) {
  const left = await dayLeft(id, now);
  if (stake > left) throw refuse(422, `${who} can only bet ${left} more coins against other players today (${Poker.FRIEND_DAY} a day, poker included)`);
}
// Sous le verrou du porte-monnaie : une seule partie à la fois, 30 tirages ; avec une mise, assez de pièces, 300 tirages,
// compte de 3 jours et place dans le plafond du jour.
async function mayPlay(id, stake, now) {
  const [cur] = await redis([['GET', myKey(id)]]);
  if (cur) {
    const [raw] = await redis([['GET', gameKey(cur)]]);
    let live = false; try { const g = raw && JSON.parse(raw); live = !!g && g.status !== 'over'; } catch (e) { /* illisible : comme finie */ }
    if (live) throw refuse(422, 'You are already in a chess game');
  }
  const st = await readStats(id), rolls = Number(st.rolls) || 0;
  if (rolls < Gamble.MIN_ROLLS) throw refuse(422, `Gamble unlocks after ${Gamble.MIN_ROLLS} rolls (you have ${rolls})`);
  if (!stake) return;
  const coins = Shop.balance(st);
  if (coins < stake) throw refuse(422, `Not enough coins: ${stake - coins} more needed`);
  if (rolls < Poker.FRIEND_ROLLS) throw refuse(422, `Chess bets unlock after ${Poker.FRIEND_ROLLS} rolls (you have ${rolls}). Friendly games are free`);
  const wait = accountWait(st, now);
  if (wait) throw refuse(422, `Chess bets unlock ${NEW_ACCOUNT_DAYS} days after your first roll (${wait} left). Friendly games are free`);
  await room(id, stake, now, 'You');
}

// ---------------------------------------------------------------- fin de partie
// Une seule fois (g.status passe à 'over') : pièces, comptes du casino et fiche du joueur.
//   winner : 'w' | 'b' | null (nulle) ; abort : partie annulée avant d'avoir vraiment commencé (mises rendues, rien compté).
function finish(g, now, winner, reason, abort = false) {
  if (g.status === 'over') return [];
  g.status = 'over'; g.end = now;
  g.result = { winner, reason, abort };
  const w = [['SREM', OPEN_KEY, g.code]];
  const ids = g.p ? [g.p.w.id, g.p.b.id] : [g.by.id];
  for (const id of ids) w.push(['SET', myKey(id), g.code, 'EX', OVER_S]);
  if (g.invited) w.push(['HDEL', inviteKey(g.invited.id), g.code]);
  if (abort || !g.p) { // défi retiré ou partie annulée : chaque mise payée revient
    if (g.stake) for (const id of ids) w.push(['HINCRBY', statsKey(id), 'spent', -g.stake]);
    return w;
  }
  const { pot, rake, win } = potPay(g.stake);
  g.pay = { w: 0, b: 0 };
  for (const c of ['w', 'b']) {
    const id = g.p[c].id, got = winner == null ? g.stake : winner === c ? win : 0;
    g.pay[c] = got;
    w.push(['HINCRBY', statsKey(id), winner == null ? 'chD' : winner === c ? 'chW' : 'chL', 1]);
    if (!g.stake) continue; // partie amicale : rien pour le casino (elle ne compte pas dans les quêtes de mises)
    if (got) w.push(['HINCRBY', statsKey(id), 'bonus', got]);
    w.push(['HINCRBY', statsKey(id), 'gChess', 1], ['HINCRBY', statsKey(id), 'gBet', g.stake], ['HINCRBY', statsKey(id), 'gWon', got], ...Gamble.ledger(id, 'chess', g.stake, got));
  }
  w.push(['HINCRBY', STATS_KEY, 'games', 1], ['HINCRBY', STATS_KEY, g.stake ? 'paid' : 'friendly', 1], ['HINCRBY', STATS_KEY, 'pot', g.stake ? pot : 0], ['HINCRBY', STATS_KEY, 'rake', winner == null ? 0 : rake], ['HINCRBY', STATS_KEY, `r:${reason}`, 1]);
  return w;
}
// Temps du camp au trait à l'instant `now` (les deux premiers coups ne prennent rien sur la pendule).
const started = g => g.moves.length >= 2;
const leftOf = (g, c, now) => (g.status === 'play' && g.turn === c && started(g) ? g.clock[c] - (now - g.turnAt) : g.clock[c]);
function due(g, now) {
  if (g.status === 'wait') return now - g.created > WAIT_MS || now - Math.max(Number(g.seen.host) || 0, g.created) > HOST_IDLE_MS;
  if (g.status !== 'play') return false;
  return started(g) ? leftOf(g, g.turn, now) <= 0 : now - g.turnAt >= FIRST_MS;
}
// Ce qui arrive quand le temps est passé : défi retiré, premier coup pas joué (annulée), ou drapeau tombé.
function advance(g, now) {
  if (g.status === 'wait') return finish(g, now, null, now - g.created > WAIT_MS ? 'expired' : 'gone', true);
  if (!started(g)) return finish(g, now, null, 'nostart', true);
  g.clock[g.turn] = 0;
  const s = Chess.parse(g.fen), win = other(g.turn);
  return finish(g, now, Chess.canMate(s.b, win) ? win : null, Chess.canMate(s.b, win) ? 'time' : 'timedraw');
}
// Vérification de secours (file `pending`, chaque minute) : règle une partie que plus personne ne regarde.
async function check(code, now = Date.now()) {
  let again = true;
  try {
    again = await withGame(code, async () => {
      const g = await load(code);
      if (!g || g.status === 'over') return false;
      if (due(g, now)) await save(g, advance(g, now));
      return g.status !== 'over';
    });
  } catch (err) { console.error('chess check', code, err.message); }
  if (again) await redis([queueReveal(now + CHECK_MS, { chess: code })]);
}

// ---------------------------------------------------------------- ce que voit un joueur
// Jamais d'identifiant : pseudos, couleurs, coups, pendules.
function view(g, id, now) {
  const me = colorOf(g, id), host = g.by.id === id;
  const out = { code: g.code, v: g.v, status: g.status, stake: g.stake, tc: g.tc, open: !!g.open, me, host, ...potPay(g.stake) };
  if (g.status === 'wait' || !g.p) {
    out.by = g.by.name;
    if (g.invited) out.invited = g.invited.name;
    out.expires = Math.max(0, g.created + WAIT_MS - now);
  } else {
    out.players = { w: { name: g.p.w.name }, b: { name: g.p.b.name } };
    out.fen = g.fen; out.moves = g.sans; out.last = g.moves.length ? g.moves[g.moves.length - 1] : null; out.turn = g.turn;
    out.clock = { w: Math.max(0, leftOf(g, 'w', now)), b: Math.max(0, leftOf(g, 'b', now)) };
    out.running = g.status === 'play' && started(g);
    if (g.status === 'play' && !started(g)) out.first = Math.max(0, FIRST_MS - (now - g.turnAt));
    out.check = Chess.inCheck(Chess.parse(g.fen));
    if (g.offer) out.offer = g.offer === me ? 'me' : 'opp';
    if (me && g.status === 'play') { const o = other(me), seen = Number(g.seen[o]) || 0; if (seen && now - seen > AWAY_MS) out.away = true; }
  }
  if (g.status === 'over') {
    const r = g.result || {};
    out.result = { reason: r.reason, abort: !!r.abort, winner: r.winner == null ? null : r.winner === me ? 'me' : 'opp', by: r.winner == null ? null : g.p ? g.p[r.winner].name : null };
    if (me && g.pay) out.result.pay = g.pay[me];
  }
  return out;
}
async function lobby(id, now) {
  const [inv, codes, st] = await Promise.all([redis([['HGETALL', inviteKey(id)]]).then(r => r[0]), redis([['SMEMBERS', OPEN_KEY]]).then(r => r[0] || []), readStats(id)]);
  const invites = Object.entries(toObject(inv)).map(([code, raw]) => { try { const x = JSON.parse(raw); return now - x.t < INVITE_S * 1000 ? { code, name: x.name, stake: x.stake, tc: x.tc } : null; } catch (e) { return null; } }).filter(Boolean).slice(-5);
  const open = [];
  if (codes.length) {
    const rows = await redis(codes.slice(0, 60).flatMap(c => [['GET', gameKey(c)], ['HGET', seenKey(c), 'host']]));
    for (let k = 0; k < rows.length; k += 2) {
      let g = null; try { g = JSON.parse(rows[k]); } catch (e) { /* partie expirée */ }
      if (!g) { await redis([['SREM', OPEN_KEY, codes[k / 2]]]); continue; }
      if (g.status !== 'wait' || now - Math.max(Number(rows[k + 1]) || 0, g.created) > HOST_IDLE_MS) continue;
      open.push({ code: g.code, name: g.by.name, stake: g.stake, tc: g.tc, mine: g.by.id === id, t: g.created });
    }
  }
  open.sort((a, b) => b.t - a.t);
  return {
    idle: true, stakes: STAKES, clocks: Object.keys(CLOCKS), rake: RAKE, invites, open: open.slice(0, OPEN_SHOWN).map(({ t, ...x }) => x),
    record: { w: Number(st.chW) || 0, l: Number(st.chL) || 0, d: Number(st.chD) || 0 }, coins: Shop.balance(st),
    bets: { rolls: Poker.FRIEND_ROLLS, day: Poker.FRIEND_DAY, left: await dayLeft(id, now) },
  };
}

// ---------------------------------------------------------------- défis
async function inviteWrites(g, me, rawName, now) {
  const to = await findPlayer(cleanName(rawName));
  if (!to) throw refuse(404, 'No player with this name');
  if (to === me) throw refuse(422, 'That is you');
  const [friend] = await redis([['SISMEMBER', `fr:${me}`, to]]);
  if (Number(friend) !== 1) throw refuse(403, 'You can only invite your friends');
  g.invited = { id: to, name: await nameOf(to) };
  return [['HSET', inviteKey(to), g.code, JSON.stringify({ name: g.by.name, stake: g.stake, tc: g.tc, t: now })], ['EXPIRE', inviteKey(to), INVITE_S]];
}
async function create(id, body, now) {
  const stake = stakeOf(body.stake), tc = CLOCKS[body.tc] ? body.tc : null;
  if (stake < 0) throw refuse(400, `Bet: ${STAKES.join(', ')} coins`);
  if (!tc) throw refuse(400, `Clock: ${Object.keys(CLOCKS).join(', ')}`);
  return wallet(id, async () => {
    await mayPlay(id, stake, now);
    const code = await newCode();
    const g = { code, v: 0, status: 'wait', stake, tc, open: !body.name && !!body.open, created: now, by: { id, name: await nameOf(id) }, invited: null };
    const inv = body.name ? await inviteWrites(g, id, body.name, now) : [];
    await save(g, [
      ...(stake ? [['HINCRBY', statsKey(id), 'spent', stake]] : []), ['SET', myKey(id), code, 'EX', GAME_S], ['HSET', seenKey(code), 'host', now],
      ...(g.open ? [['SADD', OPEN_KEY, code]] : []), ...inv, queueReveal(now + CHECK_MS, { chess: code }),
    ]);
    g.seen = { host: now };
    return view(g, id, now);
  });
}
// Accepter : porte-monnaie du joueur d'abord, puis la partie (toujours dans cet ordre, comme au poker).
async function join(id, body, now) {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!isCode(code)) throw refuse(400, 'Enter a game code');
  return wallet(id, () => withGame(code, async () => {
    const g = await load(code);
    if (!g || g.status !== 'wait') { await redis([['HDEL', inviteKey(id), code]]); throw refuse(404, 'This challenge is gone'); }
    if (g.by.id === id) throw refuse(422, 'That is your own challenge');
    if (due(g, now)) { await save(g, advance(g, now)); throw refuse(404, 'This challenge is gone'); }
    await mayPlay(id, g.stake, now);
    if (g.stake) await room(g.by.id, g.stake, now, g.by.name); // l'auteur a pu miser ailleurs entre-temps
    const name = await nameOf(id), white = crypto.randomInt(0, 2) === 0;
    const host = { id: g.by.id, name: g.by.name }, guest = { id, name };
    const [base] = CLOCKS[g.tc];
    const s = Chess.parse(Chess.START);
    Object.assign(g, { status: 'play', p: white ? { w: host, b: guest } : { w: guest, b: host }, fen: Chess.START, moves: [], sans: [], keys: [Chess.posKey(s)], turn: 'w', clock: { w: base, b: base }, turnAt: now, begun: now, offer: '', offers: { w: 0, b: 0 } });
    const day = g.stake ? [['HINCRBY', Poker.friendDayKey(now), g.by.id, g.stake], ['HINCRBY', Poker.friendDayKey(now), id, g.stake], ['EXPIRE', Poker.friendDayKey(now), 2 * 86400]] : [];
    await save(g, [
      ...(g.stake ? [['HINCRBY', statsKey(id), 'spent', g.stake]] : []), ...day, ['SET', myKey(id), code, 'EX', GAME_S], ['SET', myKey(g.by.id), code, 'EX', GAME_S],
      ['SREM', OPEN_KEY, code], ...(g.invited ? [['HDEL', inviteKey(g.invited.id), code]] : []), ['HDEL', inviteKey(id), code], ['HSET', seenKey(code), white ? 'b' : 'w', now],
    ]);
    g.seen[white ? 'b' : 'w'] = now;
    return view(g, id, now);
  }));
}
async function myGame(id) {
  const [code] = await redis([['GET', myKey(id)]]);
  return code && isCode(code) ? code : null;
}
// Un changement sur ma partie, sous son verrou ; le temps écoulé est réglé avant le coup (un coup joué après la chute
// du drapeau ne compte pas).
async function onMyGame(id, now, fn) {
  const code = await myGame(id);
  if (!code) throw refuse(404, 'You are not in a chess game');
  return withGame(code, async () => {
    const g = await load(code);
    if (!g || (g.by.id !== id && !colorOf(g, id))) throw refuse(404, 'You are not in a chess game');
    if (due(g, now)) { await save(g, advance(g, now)); return view(g, id, now); }
    const w = await fn(g);
    if (w) await save(g, w);
    return view(g, id, now);
  });
}
const cancel = (id, now) => onMyGame(id, now, g => {
  if (g.status !== 'wait' || g.by.id !== id) throw refuse(422, 'The game has started: resign instead');
  return finish(g, now, null, 'cancel', true);
});
function move(id, body, now) {
  return onMyGame(id, now, g => {
    if (g.status !== 'play') throw refuse(422, 'The game is not running');
    const c = colorOf(g, id);
    if (g.turn !== c) throw refuse(422, 'Not your turn');
    const s = Chess.parse(g.fen), m = Chess.find(s, body.m);
    if (!m) throw refuse(422, 'Illegal move');
    if (started(g)) g.clock[c] = g.clock[c] - (now - g.turnAt) + CLOCKS[g.tc][1];
    const sanText = Chess.san(s, m), n = Chess.apply(s, m), key = Chess.posKey(n);
    g.keys = n.half ? [...g.keys, key] : [key]; // une prise ou un pas de pion efface les positions d'avant
    g.fen = Chess.fen(n); g.moves.push(Chess.uci(m)); g.sans.push(sanText); g.turn = n.turn; g.turnAt = now;
    if (g.offer && g.offer !== c) g.offer = ''; // jouer, c'est refuser la nulle proposée
    const end = Chess.status(n, g.keys);
    if (end.over) return finish(g, now, end.winner, end.reason);
    if (g.moves.length >= MOVES_MAX) return finish(g, now, null, 'long');
    return [];
  });
}
function draw(id, now, yes) {
  return onMyGame(id, now, g => {
    if (g.status !== 'play') throw refuse(422, 'The game is not running');
    const c = colorOf(g, id);
    if (!yes) { if (g.offer === other(c)) g.offer = ''; return []; }
    if (g.offer === other(c)) return finish(g, now, null, 'agreed');
    if (g.offer === c) return null;
    if (!started(g)) throw refuse(422, 'Play a move first');
    if (g.offers[c] >= OFFERS_MAX) throw refuse(422, `At most ${OFFERS_MAX} draw offers per game`);
    g.offers[c] += 1; g.offer = c;
    return [];
  });
}
// Abandon ; avant que chacun ait joué son premier coup, la partie est simplement annulée (mises rendues).
const resign = (id, now) => onMyGame(id, now, g => {
  if (g.status !== 'play') throw refuse(422, 'The game is not running');
  const c = colorOf(g, id);
  return started(g) ? finish(g, now, other(c), 'resign') : finish(g, now, null, 'abort', true);
});
async function ack(id, now) {
  const code = await myGame(id);
  if (code) {
    const [raw] = await redis([['GET', gameKey(code)]]);
    let g = null; try { g = JSON.parse(raw); } catch (e) { /* expirée */ }
    if (g && g.status !== 'over') throw refuse(422, 'Your game is still running');
    await redis([['DEL', myKey(id)]]);
  }
  return lobby(id, now);
}
async function state(id, now) {
  const code = await myGame(id);
  if (!code) return lobby(id, now);
  let g = await load(code);
  const c = g ? colorOf(g, id) : null;
  if (!g || (!c && g.by.id !== id)) { await redis([['DEL', myKey(id)]]); return lobby(id, now); }
  const field = g.status === 'wait' ? 'host' : c;
  if (field && g.status !== 'over' && now - (Number(g.seen[field]) || 0) > SEEN_MS) { await redis([['HSET', seenKey(code), field, now]]); g.seen[field] = now; }
  if (due(g, now)) {
    g = await withGame(code, async () => {
      const fresh = await load(code);
      if (fresh && due(fresh, now)) await save(fresh, advance(fresh, now));
      return fresh;
    });
  }
  return view(g, id, now);
}
async function decline(id, body, now) {
  await redis([['HDEL', inviteKey(id), String(body.code || '').toUpperCase().slice(0, 6)]]);
  return lobby(id, now);
}
// Invitations en attente, pour l'alerte du site (relève des cadeaux, api/friends.js) : pseudo et code seulement.
async function invitesFor(id, now = Date.now()) {
  const [inv] = await redis([['HGETALL', inviteKey(id)]]);
  return Object.entries(toObject(inv)).map(([code, raw]) => { try { const x = JSON.parse(raw); return now - x.t < INVITE_S * 1000 ? { code, name: x.name, stake: x.stake } : null; } catch (e) { return null; } }).filter(Boolean).slice(-3);
}
// Partie en cours ou défi en attente (pour la suppression de compte, api/_account.js).
async function live(id) {
  const code = await myGame(id);
  if (!code) return false;
  const [raw] = await redis([['GET', gameKey(code)]]);
  try { const g = JSON.parse(raw); return !!g && g.status !== 'over'; } catch (e) { return false; }
}

async function handle(id, body, now = Date.now()) {
  const op = String(body.op || 'state');
  if (op === 'state') return state(id, now);
  if (op === 'create') return create(id, body, now);
  if (op === 'join') return join(id, body, now);
  if (op === 'decline') return decline(id, body, now);
  if (op === 'cancel') return cancel(id, now);
  if (op === 'move') return move(id, body, now);
  if (op === 'draw' || op === 'nodraw') return draw(id, now, op === 'draw');
  if (op === 'resign') return resign(id, now);
  if (op === 'ack') return ack(id, now);
  throw refuse(400, 'Unknown chess action');
}

module.exports = { handle, check, invitesFor, live, view, STAKES, CLOCKS, RAKE, FIRST_MS, WAIT_MS, HOST_IDLE_MS, potPay, gameKey, myKey, inviteKey, OPEN_KEY, STATS_KEY };
