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
const amount = v => (Number.isInteger(v) && v >= MIN_BET && v <= MAX_BET ? v : 0);
const refuse = (status, error) => Object.assign(new Error(error), { status });
async function wallet(id) { const st = await readStats(id); return { coins: Shop.balance(st), rolls: Number(st.rolls) || 0 }; }
async function mustAfford(id, bet) {
  const w = await wallet(id);
  if (w.rolls < MIN_ROLLS) throw refuse(422, `Gamble unlocks after ${MIN_ROLLS} rolls (you have ${w.rolls})`);
  if (w.coins < bet) throw refuse(422, `Not enough coins: ${bet - w.coins} more needed`);
}

async function roulette(id, body) {
  const bets = (Array.isArray(body.bets) ? body.bets : []).slice(0, 12).map(b => ({ t: String(b && b.t), v: Number(b && b.v), a: amount(b && b.a) }));
  if (!bets.length || bets.some(b => !ROULETTE[b.t] || !b.a || (b.t === 'n' && !(Number.isInteger(b.v) && b.v >= 0 && b.v <= 36)))) throw refuse(400, 'Invalid bet');
  const total = bets.reduce((x, b) => x + b.a, 0);
  if (total > MAX_BET) throw refuse(422, `Maximum ${MAX_BET} coins per spin`);
  await mustAfford(id, total);
  const n = crypto.randomInt(0, 37);
  const win = bets.reduce((x, b) => x + (ROULETTE[b.t].wins(n, b.v) ? b.a * ROULETTE[b.t].pays : 0), 0);
  await redis([['HINCRBY', statsKey(id), 'spent', total], ['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), 'gSpins', 1], ['HINCRBY', statsKey(id), 'gBet', total], ['HINCRBY', statsKey(id), 'gWon', win]]);
  return { n, color: n === 0 ? 'green' : RED.has(n) ? 'red' : 'black', total, win, coins: (await wallet(id)).coins };
}

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
  await redis([['HINCRBY', statsKey(id), 'bonus', g.win], ['HINCRBY', statsKey(id), 'gHands', 1], ['HINCRBY', statsKey(id), 'gBet', g.bet], ['HINCRBY', statsKey(id), 'gWon', g.win], ['DEL', bjKey(id)]]);
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
  if (!g.done) await redis([['SET', bjKey(id), JSON.stringify(g), 'EX', 1800]]);
  return show(g, (await wallet(id)).coins);
}

// ---------------------------------------------------------------- Plinko, Mines, Crash
// Trois jeux de casino en ligne classiques, tous à 99 % de retour théorique. Rien de ce qui décide du résultat ne
// quitte le serveur avant la fin : le chemin de la bille est tiré d'un coup, les mines et le point de crash restent
// dans Redis tant que la manche dure.
const u01 = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const credit = (id, bet, win, counter) => redis([['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), counter, 1], ['HINCRBY', statsKey(id), 'gBet', bet], ['HINCRBY', statsKey(id), 'gWon', win]]);
async function debit(id, raw) {
  const bet = amount(raw);
  if (!bet) throw refuse(400, `Bet between ${MIN_BET} and ${MAX_BET} coins`);
  await mustAfford(id, bet);
  await redis([['HINCRBY', statsKey(id), 'spent', bet]]);
  return bet;
}

// Plinko : 12 rangées, la bille tombe à gauche ou à droite à chaque clou ; 13 cases, les bords paient le plus.
const PLINKO = [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33];
async function plinko(id, body) {
  const bet = await debit(id, body.bet);
  const path = Array.from({ length: 12 }, () => crypto.randomInt(0, 2));
  const slot = path.reduce((x, d) => x + d, 0), mult = PLINKO[slot], win = Math.floor(bet * mult);
  await credit(id, bet, win, 'gPlinko');
  return { path, slot, mult, bet, win, coins: (await wallet(id)).coins };
}

// Mines : 25 cases, m mines. Chaque case sûre fait monter le multiplicateur ; on encaisse quand on veut.
const mnKey = id => `mn:${id}`;
const minesMult = (m, k) => { let x = 0.99; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return Math.floor(x * 100) / 100; };
const showMines = (g, coins, end) => ({ bet: g.bet, mines: g.m, open: g.open, mult: minesMult(g.m, g.open.length), next: g.open.length < 25 - g.m ? minesMult(g.m, g.open.length + 1) : null, done: !!end, ...(end ? { result: end, win: g.win || 0, bombs: g.bombs } : {}), coins });
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
      if (g.open.length < 25 - g.m) { await redis([['SET', mnKey(id), JSON.stringify(g), 'EX', 1800]]); return showMines(g, (await wallet(id)).coins); }
    } else if (move !== 'cash') throw refuse(400, 'Unknown move');
    if (!g.open.length) throw refuse(422, 'Open a tile first');
    g.win = Math.floor(g.bet * minesMult(g.m, g.open.length));
    await redis([['DEL', mnKey(id)]]); await credit(id, g.bet, g.win, 'gMines');
    return showMines(g, (await wallet(id)).coins, 'cash');
  }
  await redis([['SET', mnKey(id), JSON.stringify(g), 'EX', 1800]]);
  return showMines(g, (await wallet(id)).coins);
}

// Crash : le multiplicateur monte (× e^(0,00007 · ms)) jusqu'à un point tiré au départ et gardé ici ; encaisser avant
// qu'il n'explose. L'heure qui compte est celle du serveur à la réception de la demande.
const crKey = id => `cr:${id}`, CRASH_RATE = 0.00007, CRASH_CAP = 500;
const crashAt = ms => Math.floor(Math.exp(CRASH_RATE * ms) * 100) / 100;
async function crash(id, body) {
  const [raw] = await redis([['GET', crKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  const move = String(body.move || 'state'), now = Date.now();
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

module.exports = { roulette, blackjack, plinko, mines, crash, PLINKO, minesMult, MIN_BET, MAX_BET, MIN_ROLLS, RED: [...RED] };
