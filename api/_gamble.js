// Section Gamble : roulette et blackjack avec les pièces du jeu (aucun argent réel, rien ne s'achète ni ne se retire).
// Ce n'est pas une fonction Vercel (nom en « _ ») : api/shop.js y renvoie les actions « roulette » et « bj ».
// Tout est tiré ici, avec crypto : le site n'envoie que des mises et des choix. La mise est débitée (« spent ») avant
// le tirage, le gain crédité (« bonus ») après ; le verrou d'achat de la boutique empêche deux coups en même temps.
const crypto = require('node:crypto');
const { redis, readStats, statsKey } = require('./_lib');
const Shop = require('../js/shop.js');

const MIN_BET = 10, MAX_BET = 1000, MIN_ROLLS = 30; // mêmes 30 tirages que pour les mises en duel
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
// Roulette européenne (un seul zéro). Gain total rendu pour une mise gagnante, mise comprise.
const ROULETTE = {
  red: { pays: 2, wins: n => RED.has(n) }, black: { pays: 2, wins: n => n > 0 && !RED.has(n) },
  even: { pays: 2, wins: n => n > 0 && n % 2 === 0 }, odd: { pays: 2, wins: n => n % 2 === 1 },
  low: { pays: 2, wins: n => n >= 1 && n <= 18 }, high: { pays: 2, wins: n => n >= 19 },
  d1: { pays: 3, wins: n => n >= 1 && n <= 12 }, d2: { pays: 3, wins: n => n >= 13 && n <= 24 }, d3: { pays: 3, wins: n => n >= 25 },
  n: { pays: 36, wins: (n, v) => n === v },
};
const amount = (v, min = MIN_BET) => (Number.isInteger(v) && v >= min && v <= MAX_BET ? v : 0);
const refuse = (status, error) => Object.assign(new Error(error), { status });
// Compte de la maison, visible par tous sur la page du casino : tout l'argent qui y est passé. « took » = toutes les
// mises encaissées, « gave » = tous les gains versés, depuis l'ouverture du casino. À chaque manche finie, la mise et
// le gain s'ajoutent aux totaux et la manche rejoint un fil de 20 entrées ; ces commandes partent avec l'écriture du
// résultat, sans aller-retour de plus.
const HOUSE_KEY = 'casino', FEED_KEY = 'casino:feed', FEED_KEPT = 20;
// Pour la page Owner : les mêmes totaux par jeu (r:, b:, w:), les mêmes par jour (casino:d:<jour>, gardés 100 jours)
// et les joueurs du jour (casino:p:<jour>, un ensemble d'identifiants qui ne sert qu'à les compter).
const dayOf = t => new Date(t).toISOString().slice(0, 10);
function ledger(id, game, bet, win, rounds = 1) {
  const day = dayOf(Date.now()), daily = `casino:d:${day}`, players = `casino:p:${day}`;
  const out = [['HINCRBY', HOUSE_KEY, 'rounds', rounds], ['HINCRBY', HOUSE_KEY, 'bet', bet], ['HINCRBY', HOUSE_KEY, 'won', win],
    ['HINCRBY', HOUSE_KEY, `r:${game}`, rounds], ['HINCRBY', HOUSE_KEY, `b:${game}`, bet], ['HINCRBY', HOUSE_KEY, `w:${game}`, win],
    ['HINCRBY', daily, `r:${game}`, rounds], ['HINCRBY', daily, `b:${game}`, bet], ['HINCRBY', daily, `w:${game}`, win], ['EXPIRE', daily, 100 * 86400],
    ['SADD', players, id], ['EXPIRE', players, 100 * 86400]];
  if (win !== bet) out.push(['RPUSH', FEED_KEY, JSON.stringify({ id, g: game, n: win - bet, t: Date.now() })], ['LTRIM', FEED_KEY, -FEED_KEPT, -1]);
  return out;
}
// Les totaux n'existaient pas avant le 2026-10-10 : au premier affichage, ils sont repris une fois des compteurs que
// chaque joueur a depuis le début (gBet, gWon, et ses manches par jeu). Le marqueur posé en premier sert de verrou.
const PLAYED = ['gSpins', 'gHands', 'gPlinko', 'gMines', 'gCrash'];
async function seedHouse() {
  const [first] = await redis([['HSETNX', HOUSE_KEY, 'seeded', 1]]);
  if (Number(first) !== 1) return;
  const [ids] = await redis([['HKEYS', 'names']]);
  let bet = 0, won = 0, rounds = 0;
  for (let i = 0; i < (ids || []).length; i += 200) {
    const rows = await redis(ids.slice(i, i + 200).map(id => ['HMGET', statsKey(id), 'gBet', 'gWon', ...PLAYED]));
    for (const r of rows) { bet += Number(r && r[0]) || 0; won += Number(r && r[1]) || 0; for (let k = 2; k < 2 + PLAYED.length; k++) rounds += Number(r && r[k]) || 0; }
  }
  await redis([['HSET', HOUSE_KEY, 'bet', bet, 'won', won, 'rounds', rounds]]);
}
// Ce que la page affiche : totaux et dernières manches, avec le pseudo des joueurs (jamais leur identifiant).
async function house() {
  let [flat, raw] = await redis([['HGETALL', HOUSE_KEY], ['LRANGE', FEED_KEY, -8, -1]]);
  if (!(flat || []).includes('seeded')) { await seedHouse(); [flat] = await redis([['HGETALL', HOUSE_KEY]]); }
  const tot = {};
  for (let i = 0; i < (flat || []).length; i += 2) tot[flat[i]] = Number(flat[i + 1]) || 0;
  const rows = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).reverse();
  const names = rows.length ? (await redis([['HMGET', 'names', ...rows.map(r => r.id)]]))[0] || [] : [];
  return { gave: tot.won || 0, took: tot.bet || 0, rounds: tot.rounds || 0, feed: rows.map((r, i) => ({ name: names[i] || 'Someone', game: r.g, net: r.n, t: r.t })) };
}

async function wallet(id) { const st = await readStats(id); return { coins: Shop.balance(st), rolls: Number(st.rolls) || 0 }; }
async function mustAfford(id, bet) {
  const w = await wallet(id);
  if (w.rolls < MIN_ROLLS) throw refuse(422, `Gamble unlocks after ${MIN_ROLLS} rolls (you have ${w.rolls})`);
  if (w.coins < bet) throw refuse(422, `Not enough coins: ${bet - w.coins} more needed`);
}

const MAX_BETS = 12; // mises différentes par tour ; au-delà, refus net (elles étaient ignorées en silence)
async function roulette(id, body) {
  if (Array.isArray(body.bets) && body.bets.length > MAX_BETS) throw refuse(422, `At most ${MAX_BETS} different bets per spin`);
  const bets = (Array.isArray(body.bets) ? body.bets : []).map(b => ({ t: String(b && b.t), v: Number(b && b.v), a: amount(b && b.a) }));
  if (!bets.length || bets.some(b => !ROULETTE[b.t] || !b.a || (b.t === 'n' && !(Number.isInteger(b.v) && b.v >= 0 && b.v <= 36)))) throw refuse(400, 'Invalid bet');
  const total = bets.reduce((x, b) => x + b.a, 0);
  if (total > MAX_BET) throw refuse(422, `Maximum ${MAX_BET} coins per spin`);
  await mustAfford(id, total);
  const n = crypto.randomInt(0, 37);
  const win = bets.reduce((x, b) => x + (ROULETTE[b.t].wins(n, b.v) ? b.a * ROULETTE[b.t].pays : 0), 0);
  await redis([['HINCRBY', statsKey(id), 'spent', total], ['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), 'gSpins', 1], ['HINCRBY', statsKey(id), 'gBet', total], ['HINCRBY', statsKey(id), 'gWon', win], ...ledger(id, 'roulette', total, win)]);
  return { n, color: n === 0 ? 'green' : RED.has(n) ? 'red' : 'black', total, win, coins: (await wallet(id)).coins };
}

// Une main ou une grille laissée en plan attend son joueur une semaine (elle était perdue après 30 minutes).
const KEEP_S = 7 * 86400;
// Blackjack : sabot infini, le croupier reste à 17, blackjack payé 3 pour 2, doubler sur les deux premières cartes,
// pas de séparation des paires. La main en cours vit dans bj:<id> (30 min) ; le site ne voit la carte cachée qu'à la fin.
const bjKey = id => `bj:${id}`;
const card = () => ({ r: crypto.randomInt(1, 14), s: crypto.randomInt(0, 4) }); // r : 1 = as … 11 valet, 12 dame, 13 roi
const value = hand => { let v = hand.reduce((x, c) => x + Math.min(10, c.r), 0); if (hand.some(c => c.r === 1) && v + 10 <= 21) v += 10; return v; };
const natural = hand => hand.length === 2 && value(hand) === 21;
const show = (g, coins) => ({ bet: g.bet, player: g.player, value: value(g.player), dealer: g.done ? g.dealer : [g.dealer[0]], dealerValue: g.done ? value(g.dealer) : undefined, done: !!g.done, result: g.result, win: g.win, canDouble: !g.done && g.player.length === 2, coins });
async function settle(id, g) {
  const p = value(g.player);
  if (p <= 21 && !natural(g.player)) while (value(g.dealer) < 17) g.dealer.push(card());
  const d = value(g.dealer);
  g.result = p > 21 ? 'bust' : natural(g.player) && !natural(g.dealer) ? 'blackjack' : natural(g.dealer) && !natural(g.player) ? 'lose' : d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose';
  g.win = g.result === 'blackjack' ? Math.floor(g.bet * 2.5) : g.result === 'win' ? g.bet * 2 : g.result === 'push' ? g.bet : 0;
  g.done = true;
  await redis([['HINCRBY', statsKey(id), 'bonus', g.win], ['HINCRBY', statsKey(id), 'gHands', 1], ['HINCRBY', statsKey(id), 'gBet', g.bet], ['HINCRBY', statsKey(id), 'gWon', g.win], ['DEL', bjKey(id)], ...ledger(id, 'bj', g.bet, g.win)]);
}
async function blackjack(id, body) {
  const [raw] = await redis([['GET', bjKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  const move = String(body.move || 'state');
  if (move === 'state') return g ? show(g, (await wallet(id)).coins) : { done: true, idle: true, coins: (await wallet(id)).coins };
  if (move === 'deal') {
    if (g) throw refuse(422, 'Finish your hand first');
    const bet = amount(body.bet);
    if (!bet) throw refuse(400, `Bet between ${MIN_BET} and ${MAX_BET} coins`);
    await mustAfford(id, bet);
    g = { bet, player: [card(), card()], dealer: [card(), card()] };
    await redis([['HINCRBY', statsKey(id), 'spent', bet]]);
    if (natural(g.player) || natural(g.dealer)) await settle(id, g);
  } else {
    if (!g) throw refuse(422, 'No hand in progress');
    if (move === 'hit') { g.player.push(card()); if (value(g.player) >= 21) await settle(id, g); }
    else if (move === 'stand') await settle(id, g);
    else if (move === 'double') {
      if (g.player.length !== 2) throw refuse(422, 'You can only double on your first two cards');
      await mustAfford(id, g.bet);
      await redis([['HINCRBY', statsKey(id), 'spent', g.bet]]);
      g.bet *= 2; g.player.push(card());
      await settle(id, g);
    } else throw refuse(400, 'Unknown move');
  }
  if (!g.done) await redis([['SET', bjKey(id), JSON.stringify(g), 'EX', KEEP_S]]);
  return show(g, (await wallet(id)).coins);
}

// ---------------------------------------------------------------- Plinko, Mines, Crash
// Trois jeux de casino en ligne classiques, tous à 99 % de retour théorique. Rien de ce qui décide du résultat ne
// quitte le serveur avant la fin : le chemin de la bille est tiré d'un coup, les mines et le point de crash restent
// dans Redis tant que la manche dure.
const u01 = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const credit = (id, bet, win, counter) => redis([['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), counter, 1], ['HINCRBY', statsKey(id), 'gBet', bet], ['HINCRBY', statsKey(id), 'gWon', win], ...ledger(id, { gPlinko: 'plinko', gMines: 'mines', gCrash: 'crash', gSlots: 'slots' }[counter], bet, win)]);
async function debit(id, raw) {
  const bet = amount(raw);
  if (!bet) throw refuse(400, `Bet between ${MIN_BET} and ${MAX_BET} coins`);
  await mustAfford(id, bet);
  await redis([['HINCRBY', statsKey(id), 'spent', bet]]);
  return bet;
}

// Plinko : 12 rangées, la bille tombe à gauche ou à droite à chaque clou ; 13 cases, les bords paient le plus.
const PLINKO = [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33];
// Seul jeu où l'on peut miser 1 pièce, et lâcher plusieurs billes d'un coup (« count », 20 au plus) : la page regroupe
// ainsi les clics rapprochés en une seule demande. Une pièce ne se coupe pas : quand mise × case ne tombe pas juste
// (1 pièce sur ×0,6), la fraction est jouée au hasard (6 chances sur 10 de recevoir la pièce), pour que les petites
// mises rendent en moyenne exactement autant que les grosses (99 %). Aux mises multiples de 10, rien ne change.
const PLINKO_MIN = 1, PLINKO_BALLS = 20;
async function plinko(id, body) {
  const bet = amount(body.bet, PLINKO_MIN);
  if (!bet) throw refuse(400, `Bet between ${PLINKO_MIN} and ${MAX_BET} coins`);
  const count = body.count === undefined ? 1 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > PLINKO_BALLS) throw refuse(400, `Between 1 and ${PLINKO_BALLS} balls at a time`);
  const total = bet * count;
  await mustAfford(id, total);
  const balls = Array.from({ length: count }, () => {
    const path = Array.from({ length: 12 }, () => crypto.randomInt(0, 2));
    const slot = path.reduce((x, d) => x + d, 0), mult = PLINKO[slot];
    const tenths = bet * Math.round(mult * 10); // gain en dixièmes de pièce, toujours entier
    return { path, slot, mult, win: Math.floor(tenths / 10) + (crypto.randomInt(0, 10) < tenths % 10 ? 1 : 0) };
  });
  const win = balls.reduce((x, b) => x + b.win, 0);
  await redis([['HINCRBY', statsKey(id), 'spent', total], ['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), 'gPlinko', count], ['HINCRBY', statsKey(id), 'gBet', total], ['HINCRBY', statsKey(id), 'gWon', win], ...ledger(id, 'plinko', total, win, count)]);
  // Une seule bille : la réponse garde aussi sa forme d'avant (path, slot, mult), pour une page pas encore rechargée.
  return { ...(count === 1 ? balls[0] : {}), balls, bet, total, win, coins: (await wallet(id)).coins };
}

// Machine à sous : trois rouleaux tirés indépendamment sur 20 crans (5 cerises, 5 citrons, 4 cloches, 3 étoiles,
// 2 diamants, un 7). Trois symboles identiques paient le plus ; deux 7, deux cerises ou deux citrons paient un peu.
// Retour théorique : 96,41 %, une manche sur trois rend quelque chose. La table est partagée avec la page.
const SLOT_REEL = ['cherry', 'cherry', 'cherry', 'cherry', 'cherry', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'bell', 'bell', 'bell', 'bell', 'star', 'star', 'star', 'diamond', 'diamond', 'seven'];
const SLOT_PAYS = { three: { seven: 250, diamond: 75, star: 30, bell: 12, lemon: 8, cherry: 5 }, two: { seven: 5, cherry: 2, lemon: 1 } };
function slotMult(reels) {
  if (reels[0] === reels[1] && reels[1] === reels[2]) return SLOT_PAYS.three[reels[0]];
  for (const k of Object.keys(SLOT_PAYS.two)) if (reels.filter(x => x === k).length === 2) return SLOT_PAYS.two[k];
  return 0;
}
async function slots(id, body) {
  const bet = await debit(id, body.bet);
  const reels = [0, 1, 2].map(() => SLOT_REEL[crypto.randomInt(0, SLOT_REEL.length)]);
  const mult = slotMult(reels), win = Math.floor(bet * mult);
  await credit(id, bet, win, 'gSlots');
  return { reels, mult, bet, win, coins: (await wallet(id)).coins };
}

// Mines : 25 cases, m mines. Chaque case sûre fait monter le multiplicateur ; on encaisse quand on veut.
const mnKey = id => `mn:${id}`;
// Plafond : un gain ne dépasse pas 250 fois la mise (comme le jackpot de la machine à sous). Sans lui, vider une
// grille piégée payait des milliers, voire des millions de fois la mise, et un seul coup de chance vidait de leur
// sens toutes les pièces du jeu. Le multiplicateur s'arrête au plafond, et la partie s'encaisse seule en l'atteignant.
const MINES_CAP = 250;
const minesMult = (m, k) => { let x = 0.99; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return Math.min(MINES_CAP, Math.floor(x * 100) / 100); };
const showMines = (g, coins, end) => ({ bet: g.bet, mines: g.m, open: g.open, cap: MINES_CAP, capped: minesMult(g.m, g.open.length) >= MINES_CAP, mult: minesMult(g.m, g.open.length), next: g.open.length < 25 - g.m ? minesMult(g.m, g.open.length + 1) : null, done: !!end, ...(end ? { result: end, win: g.win || 0, bombs: g.bombs } : {}), coins });
async function mines(id, body) {
  const [raw] = await redis([['GET', mnKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  const move = String(body.move || 'state');
  if (move === 'state') return g ? showMines(g, (await wallet(id)).coins) : { done: true, idle: true, coins: (await wallet(id)).coins };
  if (move === 'start') {
    if (g) throw refuse(422, 'Finish your game first');
    const m = Number(body.mines);
    if (!Number.isInteger(m) || m < 1 || m > 24) throw refuse(400, 'Between 1 and 24 mines');
    const bet = await debit(id, body.bet);
    const cells = Array.from({ length: 25 }, (_, i) => i);
    for (let i = 24; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    g = { bet, m, bombs: cells.slice(0, m).sort((a, b) => a - b), open: [] };
  } else {
    if (!g) throw refuse(422, 'No game in progress');
    if (move === 'pick') {
      const c = Number(body.cell);
      if (!Number.isInteger(c) || c < 0 || c > 24 || g.open.includes(c)) throw refuse(400, 'Pick a closed tile');
      if (g.bombs.includes(c)) { await redis([['DEL', mnKey(id)]]); await credit(id, g.bet, 0, 'gMines'); return { ...showMines(g, (await wallet(id)).coins, 'boom'), hit: c }; }
      g.open.push(c);
      if (g.open.length < 25 - g.m && minesMult(g.m, g.open.length) < MINES_CAP) { await redis([['SET', mnKey(id), JSON.stringify(g), 'EX', KEEP_S]]); return showMines(g, (await wallet(id)).coins); }
    } else if (move !== 'cash') throw refuse(400, 'Unknown move');
    if (!g.open.length) throw refuse(422, 'Open a tile first');
    g.win = Math.floor(g.bet * minesMult(g.m, g.open.length));
    await redis([['DEL', mnKey(id)]]); await credit(id, g.bet, g.win, 'gMines');
    return showMines(g, (await wallet(id)).coins, 'cash');
  }
  await redis([['SET', mnKey(id), JSON.stringify(g), 'EX', KEEP_S]]);
  return showMines(g, (await wallet(id)).coins);
}

// Crash : le multiplicateur monte (× e^(0,00007 · ms)) jusqu'à un point tiré au départ et gardé ici ; encaisser avant
// qu'il n'explose. L'heure qui compte est celle du serveur à la réception de la demande.
const crKey = id => `cr:${id}`, CRASH_RATE = 0.00007, CRASH_CAP = 500;
const crashAt = ms => Math.floor(Math.exp(CRASH_RATE * ms) * 100) / 100;
// Sondage d'une manche en vol, sans verrou ni écriture : la page le fait chaque seconde pour savoir si la fusée a
// explosé. Tant qu'elle vole, il ne doit jamais gêner le « Cash out » du joueur. Rend null dès qu'il y a quelque chose
// à régler (explosée) ou rien en cours : le chemin normal, sous verrou, prend alors le relais.
async function crashPeek(id, at) {
  const [raw] = await redis([['GET', crKey(id)]]);
  const g = raw ? JSON.parse(raw) : null;
  if (!g || crashAt(at - g.t0) >= g.point) return null;
  return { done: false, t0: g.t0, now: at, bet: g.bet, rate: CRASH_RATE }; // sans le solde : une seule lecture, la page ne s'en sert pas ici
}
async function crash(id, body, at) {
  const [raw] = await redis([['GET', crKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  // « at » : l'heure d'arrivée de la demande, avant une éventuelle attente du verrou (api/shop.js).
  const move = String(body.move || 'state'), now = Number.isFinite(at) ? at : Date.now();
  const bust = async () => { await redis([['DEL', crKey(id)]]); await credit(id, g.bet, 0, 'gCrash'); return { done: true, result: 'crash', point: g.point, bet: g.bet, win: 0, coins: (await wallet(id)).coins }; };
  if (g && crashAt(now - g.t0) >= g.point) return bust();
  if (move === 'state') return g ? { done: false, t0: g.t0, now, bet: g.bet, rate: CRASH_RATE, coins: (await wallet(id)).coins } : { done: true, idle: true, coins: (await wallet(id)).coins };
  if (move === 'start') {
    if (g) throw refuse(422, 'Finish your game first');
    const bet = await debit(id, body.bet);
    const point = Math.min(CRASH_CAP, Math.max(1, Math.floor((0.99 / (1 - u01())) * 100) / 100));
    g = { bet, point, t0: Date.now() };
    await redis([['SET', crKey(id), JSON.stringify(g), 'EX', 600]]);
    if (point <= 1) return bust();
    return { done: false, t0: g.t0, now: g.t0, bet, rate: CRASH_RATE, coins: (await wallet(id)).coins };
  }
  if (move !== 'cash') throw refuse(400, 'Unknown move');
  if (!g) throw refuse(422, 'No game in progress');
  const mult = crashAt(now - g.t0), win = Math.floor(g.bet * mult);
  await redis([['DEL', crKey(id)]]); await credit(id, g.bet, win, 'gCrash');
  return { done: true, result: 'cash', mult, point: g.point, bet: g.bet, win, coins: (await wallet(id)).coins };
}

module.exports = { MINES_CAP, PLINKO_MIN, PLINKO_BALLS, slots, SLOT_REEL, SLOT_PAYS, slotMult, crashPeek, MAX_BETS, house, roulette, blackjack, plinko, mines, crash, PLINKO, minesMult, MIN_BET, MAX_BET, MIN_ROLLS, RED: [...RED] };
