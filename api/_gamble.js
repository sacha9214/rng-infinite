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

module.exports = { roulette, blackjack, MIN_BET, MAX_BET, MIN_ROLLS, RED: [...RED] };
