// Section Gamble : roulette et blackjack avec les pièces du jeu (aucun argent réel, rien ne s'achète ni ne se retire).
// Ce n'est pas une fonction Vercel (nom en « _ ») : api/shop.js y renvoie les actions « roulette » et « bj ».
// Tout est tiré ici, avec crypto : le site n'envoie que des mises et des choix. La mise est débitée (« spent ») avant
// le tirage, le gain crédité (« bonus ») après ; le verrou d'achat de la boutique empêche deux coups en même temps.
const crypto = require('node:crypto');
const { redis, readStats, statsKey, questKey, QUEST_TTL } = require('./_lib');
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
function ledger(id, game, bet, win, rounds = 1, feed = true) {
  const day = dayOf(Date.now()), daily = `casino:d:${day}`, players = `casino:p:${day}`;
  const out = [['HINCRBY', HOUSE_KEY, 'rounds', rounds], ['HINCRBY', HOUSE_KEY, 'bet', bet], ['HINCRBY', HOUSE_KEY, 'won', win],
    ['HINCRBY', HOUSE_KEY, `r:${game}`, rounds], ['HINCRBY', HOUSE_KEY, `b:${game}`, bet], ['HINCRBY', HOUSE_KEY, `w:${game}`, win],
    ['HINCRBY', daily, `r:${game}`, rounds], ['HINCRBY', daily, `b:${game}`, bet], ['HINCRBY', daily, `w:${game}`, win], ['EXPIRE', daily, 100 * 86400],
    ['SADD', players, id], ['EXPIRE', players, 100 * 86400],
    // Quêtes du jour de casino (js/quests.js) : manches jouées et pièces misées.
    ['HINCRBY', questKey(day, id), 'casino', rounds], ['HINCRBY', questKey(day, id), 'casinoBet', bet], ['EXPIRE', questKey(day, id), QUEST_TTL]];
  if (feed && win !== bet) out.push(['RPUSH', FEED_KEY, JSON.stringify({ id, g: game, n: win - bet, t: Date.now() })], ['LTRIM', FEED_KEY, -FEED_KEPT, -1]);
  return out;
}
// Les totaux n'existaient pas avant le 2026-10-10 : au premier affichage, ils sont repris une fois des compteurs que
// chaque joueur a depuis le début (gBet, gWon, et ses manches par jeu). Le marqueur posé en premier sert de verrou.
const PLAYED = ['gSpins', 'gHands', 'gPlinko', 'gMines', 'gCrash', 'gFlips', 'gTower'];
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

// Classement du casino, depuis toujours : plus gros gagnants (net = gagné − misé), plus gros perdants, plus gros
// parieurs (total misé). Calculé depuis les compteurs de chaque joueur (gBet, gWon, manches par jeu) et gardé une
// minute : la page peut le demander souvent sans relire toutes les fiches à chaque fois.
const BOARD_KEY = 'casino:board', BOARD_TTL_S = 60, BOARD_TOP = 10, ROUND_FIELDS = [...PLAYED, 'gSlots'];
async function board(me) {
  const [raw] = await redis([['GET', BOARD_KEY]]);
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* cache illisible : recalcul */ }
  if (!data) {
    const [ids] = await redis([['HKEYS', 'names']]);
    const rows = [];
    for (let i = 0; i < (ids || []).length; i += 200) {
      const part = ids.slice(i, i + 200), stats = await redis(part.map(id => ['HMGET', statsKey(id), 'gBet', 'gWon', ...ROUND_FIELDS]));
      stats.forEach((r, k) => { const bet = Number(r && r[0]) || 0; if (bet > 0) rows.push([part[k], bet, (Number(r[1]) || 0) - bet, r.slice(2).reduce((x, v) => x + (Number(v) || 0), 0)]); });
    }
    // Trois ordres, chacun la liste entière des identifiants : le rang de n'importe quel joueur s'y lit directement.
    const order = (list, cmp) => list.slice().sort(cmp).map(r => r[0]);
    const lists = { winners: order(rows.filter(r => r[2] > 0), (a, b) => b[2] - a[2]), losers: order(rows.filter(r => r[2] < 0), (a, b) => a[2] - b[2]), gamblers: order(rows, (a, b) => b[1] - a[1]) };
    const shown = [...new Set(Object.values(lists).flatMap(l => l.slice(0, BOARD_TOP)))];
    const names = shown.length ? (await redis([['HMGET', 'names', ...shown]]))[0] || [] : [];
    data = { rows: Object.fromEntries(rows.map(r => [r[0], r.slice(1)])), lists, names: Object.fromEntries(shown.map((id, i) => [id, names[i] || 'Player'])) };
    await redis([['SET', BOARD_KEY, JSON.stringify(data), 'EX', BOARD_TTL_S]]);
  }
  const entry = (id, rank, name) => ({ rank, name, bet: data.rows[id][0], net: data.rows[id][1], rounds: data.rows[id][2], me: id === me });
  const out = { players: Object.keys(data.rows).length, mine: {} };
  let myName = null;
  for (const [key, list] of Object.entries(data.lists)) {
    out[key] = list.slice(0, BOARD_TOP).map((id, i) => entry(id, i + 1, data.names[id]));
    // Le joueur hors du top voit quand même sa ligne et son rang ; son identifiant ne sort jamais.
    const at = me ? list.indexOf(me) : -1;
    if (at >= BOARD_TOP) { if (myName === null) myName = (await redis([['HGET', 'names', me]]))[0] || 'Player'; out.mine[key] = entry(me, at + 1, myName); }
  }
  return out;
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
// Bonus des mains très chanceuses (idée d'un joueur, 2026-10-14), payés en plus du résultat sur la mise de départ,
// quand la main fait 21 : trois 7 (7-7-7), ou 21 en 5 cartes, en 6, en 7 ou plus. Montants choisis pour que même la
// meilleure stratégie possible (tirer exprès pour chercher 5 cartes) rende au plus 99,6 % : le casino garde toujours
// l'avantage (calcul exact par programmation dynamique, sabot infini).
const BONUS = { triple7: 7, five: 1, six: 3, seven: 10 };
const bonusKind = hand => (value(hand) !== 21 ? null : hand.length === 3 && hand.every(c => c.r === 7) ? 'triple7' : hand.length >= 7 ? 'seven' : hand.length === 6 ? 'six' : hand.length === 5 ? 'five' : null);
// Assurance : quand la carte visible du croupier est un as, on peut s'assurer contre son blackjack (de la mise minimale
// à sa mise) ; payée 2 contre 1 s'il l'a. Comme au vrai casino, c'est un mauvais pari : 7,7 % gardés en moyenne.
const show = (g, coins) => ({ sides: g.sides || null, insurance: g.ins || 0, insWin: g.insWin, canInsure: !!g.offer, bonus: g.bonus || null, bet: g.bet, player: g.player, value: value(g.player), dealer: g.done ? g.dealer : [g.dealer[0]], dealerValue: g.done ? value(g.dealer) : undefined, done: !!g.done, result: g.result, win: g.win, canDouble: !g.done && g.player.length === 2, coins });
async function settle(id, g) {
  const p = value(g.player);
  if (p <= 21 && !natural(g.player)) while (value(g.dealer) < 17) g.dealer.push(card());
  const d = value(g.dealer);
  g.result = p > 21 ? 'bust' : natural(g.player) && !natural(g.dealer) ? 'blackjack' : natural(g.dealer) && !natural(g.player) ? 'lose' : d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose';
  g.win = g.result === 'blackjack' ? Math.floor(g.bet * 2.5) : g.result === 'win' ? g.bet * 2 : g.result === 'push' ? g.bet : 0;
  const kind = bonusKind(g.player);
  if (kind) { g.bonus = { kind, win: (g.base || g.bet) * BONUS[kind] }; g.win += g.bonus.win; }
  g.done = true;
  await redis([['HINCRBY', statsKey(id), 'bonus', g.win], ['HINCRBY', statsKey(id), 'gHands', 1], ['HINCRBY', statsKey(id), 'gBet', g.bet], ['HINCRBY', statsKey(id), 'gWon', g.win], ['DEL', bjKey(id)], ...ledger(id, 'bj', g.bet, g.win)]);
}
// Mises annexes « Match » (idée d'un joueur, 2026-10-14) : une sur ta 1re carte, une sur ta 2e. Chacune gagne si sa
// carte a la même valeur que la carte visible du croupier : 8× la mise, 24× si la couleur est la même aussi ; si tes
// deux cartes correspondent, chaque mise gagnante est payée 1,5 fois plus. Sabot infini, donc par mise :
// (3/52 × 8 + 1/52 × 24) × (1 + 0,5 × 4/52) = 95,9 % rendus en moyenne, 4,1 % gardés par le casino (tools/casino-sim.mjs).
const SIDE = { rank: 8, suited: 24, pair: 1.5 };
function sideWins(g) {
  const up = g.dealer[0], both = g.player[0].r === up.r && g.player[1].r === up.r;
  return g.side.map((bet, i) => {
    const c = g.player[i];
    if (!bet || c.r !== up.r) return { bet, win: 0, kind: null };
    const kind = c.s === up.s ? 'suited' : 'rank';
    return { bet, win: Math.floor(bet * SIDE[kind] * (both ? SIDE.pair : 1)), kind, pair: both };
  });
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
    // Mises annexes facultatives : 0, ou entre la mise minimale et la maximale.
    const asked = (Array.isArray(body.side) ? body.side : []).slice(0, 2);
    if (asked.some(v => v && !amount(v))) throw refuse(400, `Side bets between ${MIN_BET} and ${MAX_BET} coins`);
    const side = [0, 1].map(i => (asked[i] ? amount(asked[i]) : 0));
    const sides = side[0] + side[1];
    await mustAfford(id, bet + sides);
    g = { bet, player: [card(), card()], dealer: [card(), card()], side };
    await redis([['HINCRBY', statsKey(id), 'spent', bet + sides]]);
    if (sides) {
      g.sides = sideWins(g);
      const won = g.sides.reduce((x, r) => x + r.win, 0);
      await redis([['HINCRBY', statsKey(id), 'bonus', won], ['HINCRBY', statsKey(id), 'gBet', sides], ['HINCRBY', statsKey(id), 'gWon', won], ...ledger(id, 'bj', sides, won, 0)]);
    }
    g.base = bet;
    // As visible et pas de blackjack pour le joueur : on propose l'assurance avant de regarder la carte cachée.
    if (g.dealer[0].r === 1 && !natural(g.player)) g.offer = true;
    else if (natural(g.player) || natural(g.dealer)) await settle(id, g);
  } else if (move === 'insure' || move === 'noinsure') {
    if (!g || !g.offer) throw refuse(422, 'No insurance to take');
    if (move === 'insure') {
      const ins = Number(body.amount);
      if (!Number.isInteger(ins) || ins < MIN_BET || ins > g.bet) throw refuse(400, `Insurance between ${MIN_BET} and ${g.bet} coins`);
      await mustAfford(id, ins);
      g.ins = ins; g.insWin = natural(g.dealer) ? ins * 3 : 0;
      await redis([['HINCRBY', statsKey(id), 'spent', ins], ['HINCRBY', statsKey(id), 'bonus', g.insWin], ['HINCRBY', statsKey(id), 'gBet', ins], ['HINCRBY', statsKey(id), 'gWon', g.insWin], ...ledger(id, 'bj', ins, g.insWin, 0)]);
    }
    g.offer = false;
    if (natural(g.dealer)) await settle(id, g);
  } else {
    if (!g) throw refuse(422, 'No hand in progress');
    // Jouer sans répondre à l'assurance, c'est la refuser ; si le croupier a blackjack, la main s'arrête là.
    if (g.offer) { g.offer = false; if (natural(g.dealer)) { await settle(id, g); await redis([['DEL', bjKey(id)]]); return show(g, (await wallet(id)).coins); } }
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
const credit = (id, bet, win, counter) => redis([['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), counter, 1], ['HINCRBY', statsKey(id), 'gBet', bet], ['HINCRBY', statsKey(id), 'gWon', win], ...ledger(id, { gPlinko: 'plinko', gMines: 'mines', gCrash: 'crash', gSlots: 'slots', gFlips: 'flip', gTower: 'tower' }[counter], bet, win)]);
async function debit(id, raw) {
  const bet = amount(raw);
  if (!bet) throw refuse(400, `Bet between ${MIN_BET} and ${MAX_BET} coins`);
  await mustAfford(id, bet);
  await redis([['HINCRBY', statsKey(id), 'spent', bet]]);
  return bet;
}

// Plinko : 12 rangées, la bille tombe à gauche ou à droite à chaque clou ; 13 cases, les bords paient le plus.
const PLINKO = [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33];
// Mode « High risk » (idée d'un joueur, 2026-10-14) : 15 rangées, 16 cases, 1000× sur les bords (1 chance sur 16 384
// de chaque côté) mais le milieu rend presque rien. Retour théorique : 96,90 %. Mise plafonnée à 100 pièces, pour qu'un
// coup de chance ne rapporte pas plus de 100 000 pièces d'un coup.
const PLINKO_HIGH = [1000, 130, 26, 5, 2, 0.8, 0.3, 0.2, 0.2, 0.3, 0.8, 2, 5, 26, 130, 1000];
const PLINKO_HIGH_MAX = 100;
// Seul jeu où l'on peut miser 1 pièce, et lâcher plusieurs billes d'un coup (« count », 20 au plus) : la page regroupe
// ainsi les clics rapprochés en une seule demande. Une pièce ne se coupe pas : quand mise × case ne tombe pas juste
// (1 pièce sur ×0,6), la fraction est jouée au hasard (6 chances sur 10 de recevoir la pièce), pour que les petites
// mises rendent en moyenne exactement autant que les grosses (99 %). Aux mises multiples de 10, rien ne change.
const PLINKO_MIN = 1, PLINKO_BALLS = 20;
async function plinko(id, body) {
  const high = body.risk === 'high', table = high ? PLINKO_HIGH : PLINKO, rows = table.length - 1;
  const bet = amount(body.bet, PLINKO_MIN);
  if (!bet) throw refuse(400, `Bet between ${PLINKO_MIN} and ${MAX_BET} coins`);
  if (high && bet > PLINKO_HIGH_MAX) throw refuse(400, `High risk: bet at most ${PLINKO_HIGH_MAX} coins per ball`);
  const count = body.count === undefined ? 1 : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > PLINKO_BALLS) throw refuse(400, `Between 1 and ${PLINKO_BALLS} balls at a time`);
  const total = bet * count;
  await mustAfford(id, total);
  const balls = Array.from({ length: count }, () => {
    const path = Array.from({ length: rows }, () => crypto.randomInt(0, 2));
    const slot = path.reduce((x, d) => x + d, 0), mult = table[slot];
    const tenths = bet * Math.round(mult * 10); // gain en dixièmes de pièce, toujours entier
    return { path, slot, mult, win: Math.floor(tenths / 10) + (crypto.randomInt(0, 10) < tenths % 10 ? 1 : 0) };
  });
  const win = balls.reduce((x, b) => x + b.win, 0);
  // Fil « LIVE » du casino : en lâchant des billes à la chaîne, une seule ligne par joueur, mise à jour avec le total des
  // 5 dernières secondes, au lieu d'une ligne par demande (signalé par un joueur le 2026-10-16).
  const now = Date.now(), [lastRaw] = await redis([['LINDEX', FEED_KEY, -1]]);
  let last = null; try { last = lastRaw ? JSON.parse(lastRaw) : null; } catch (e) { last = null; }
  const merge = last && last.id === id && last.g === 'plinko' && now - (last.t0 || last.t) < 5000;
  const feed = merge ? [['LSET', FEED_KEY, -1, JSON.stringify({ ...last, n: last.n + win - total, t: now, t0: last.t0 || last.t })]]
    : win !== total ? [['RPUSH', FEED_KEY, JSON.stringify({ id, g: 'plinko', n: win - total, t: now, t0: now })], ['LTRIM', FEED_KEY, -FEED_KEPT, -1]] : [];
  await redis([['HINCRBY', statsKey(id), 'spent', total], ['HINCRBY', statsKey(id), 'bonus', win], ['HINCRBY', statsKey(id), 'gPlinko', count], ['HINCRBY', statsKey(id), 'gBet', total], ['HINCRBY', statsKey(id), 'gWon', win], ...ledger(id, 'plinko', total, win, count, false), ...feed]);
  // Une seule bille : la réponse garde aussi sa forme d'avant (path, slot, mult), pour une page pas encore rechargée.
  return { ...(count === 1 ? balls[0] : {}), balls, bet, total, risk: high ? 'high' : 'normal', win, coins: (await wallet(id)).coins };
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

// Pile ou face « double ou rien » (idée d'un joueur, 2026-10-16). On mise et on choisit un côté : gagné, le gain est
// multiplié par 1,9 (95 % rendus par lancer : l'avantage du casino) ; on encaisse, ou on relance pour doubler encore.
// Perdu : tout est perdu. Au plus 7 lancers gagnés de suite (×1,9⁷ ≈ ×89). La pièce est tirée sur le serveur.
const cfKey = id => `cf:${id}`, FLIP_MULT = 1.9, FLIP_MAX = 7; // 1,96 et 8 jusqu'au 2026-10-16 : jugé trop facile
const flipMult = k => Math.floor(Math.pow(FLIP_MULT, k) * 100) / 100;
const showFlip = (g, coins, end) => ({ bet: g.bet, wins: g.wins, mult: flipMult(g.wins), next: g.wins < FLIP_MAX ? flipMult(g.wins + 1) : null, max: FLIP_MAX, last: g.last || null, pick: g.pick || null, done: !!end, ...(end ? { result: end, win: g.win || 0 } : {}), coins });
async function coinflip(id, body) {
  const [raw] = await redis([['GET', cfKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  const move = String(body.move || 'state');
  if (move === 'state') return g ? showFlip(g, (await wallet(id)).coins) : { done: true, idle: true, coins: (await wallet(id)).coins };
  if (move === 'flip') {
    const side = body.side === 'tails' ? 'tails' : body.side === 'heads' ? 'heads' : null;
    if (!side) throw refuse(400, 'Pick heads or tails');
    if (!g) g = { bet: await debit(id, body.bet), wins: 0 };
    else if (g.wins >= FLIP_MAX) throw refuse(422, 'Maximum reached: cash out');
    g.pick = side; g.last = crypto.randomInt(0, 2) ? 'heads' : 'tails';
    if (g.last !== side) { await redis([['DEL', cfKey(id)]]); await credit(id, g.bet, 0, 'gFlips'); return showFlip(g, (await wallet(id)).coins, 'lose'); }
    g.wins++;
    await redis([['SET', cfKey(id), JSON.stringify(g), 'EX', KEEP_S]]);
    return showFlip(g, (await wallet(id)).coins);
  }
  if (move !== 'cash') throw refuse(400, 'Unknown move');
  if (!g || !g.wins) throw refuse(422, 'No winnings to cash out');
  g.win = Math.floor(g.bet * flipMult(g.wins));
  await redis([['DEL', cfKey(id)]]); await credit(id, g.bet, g.win, 'gFlips');
  return showFlip(g, (await wallet(id)).coins, 'cash');
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

// Tower (idée du joueur Zombara, 2026-10-20) : 8 étages, une bombe cachée à chaque étage parmi 4, 3 ou 2 cases selon la
// difficulté. Chaque case sûre fait monter d'un étage et le multiplicateur ; on encaisse quand on veut. Même calcul que
// les Mines : 99 % des vraies chances à chaque étage, arrondi vers le bas, même plafond (×250, atteint seulement au
// dernier étage en Hard). Les bombes sont tirées au départ et restent dans Redis jusqu'à la fin de la partie.
const twKey = id => `tw:${id}`;
const TOWER_FLOORS = 8, TOWER_LEVELS = { easy: 4, normal: 3, hard: 2 };
const towerMult = (n, k) => { let x = 0.99; for (let i = 0; i < k; i++) x *= n / (n - 1); return Math.min(MINES_CAP, Math.floor(x * 100) / 100); };
const towerLadder = n => Array.from({ length: TOWER_FLOORS }, (_, i) => towerMult(n, i + 1));
const showTower = (g, coins, end) => {
  const n = TOWER_LEVELS[g.level], k = g.picks.length;
  return { bet: g.bet, level: g.level, tiles: n, floors: TOWER_FLOORS, picks: g.picks, ladder: towerLadder(n), cap: MINES_CAP, mult: k ? towerMult(n, k) : 1, next: k < TOWER_FLOORS ? towerMult(n, k + 1) : null, done: !!end, ...(end ? { result: end, win: g.win || 0, bombs: g.bombs } : {}), coins };
};
async function tower(id, body) {
  const [raw] = await redis([['GET', twKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  const move = String(body.move || 'state');
  if (move === 'state') return g ? showTower(g, (await wallet(id)).coins) : { done: true, idle: true, coins: (await wallet(id)).coins };
  if (move === 'start') {
    if (g) throw refuse(422, 'Finish your game first');
    const level = String(body.level || '');
    if (!Object.prototype.hasOwnProperty.call(TOWER_LEVELS, level)) throw refuse(400, 'Pick Easy, Normal or Hard');
    const bet = await debit(id, body.bet);
    // Une bombe par étage, tirée avec crypto, gardée ici jusqu'à la fin.
    g = { bet, level, bombs: Array.from({ length: TOWER_FLOORS }, () => crypto.randomInt(0, TOWER_LEVELS[level])), picks: [] };
  } else {
    if (!g) throw refuse(422, 'No game in progress');
    if (move === 'pick') {
      const t = Number(body.tile), floor = g.picks.length;
      if (!Number.isInteger(t) || t < 0 || t >= TOWER_LEVELS[g.level]) throw refuse(400, 'Pick a tile on the current floor');
      if (g.bombs[floor] === t) { await redis([['DEL', twKey(id)]]); await credit(id, g.bet, 0, 'gTower'); return { ...showTower(g, (await wallet(id)).coins, 'boom'), hit: t, floor }; }
      g.picks.push(t);
      if (g.picks.length < TOWER_FLOORS) { await redis([['SET', twKey(id), JSON.stringify(g), 'EX', KEEP_S]]); return showTower(g, (await wallet(id)).coins); }
      // Sommet atteint : la partie s'encaisse seule.
    } else if (move !== 'cash') throw refuse(400, 'Unknown move');
    if (!g.picks.length) throw refuse(422, 'Climb one floor first');
    g.win = Math.floor(g.bet * towerMult(TOWER_LEVELS[g.level], g.picks.length));
    await redis([['DEL', twKey(id)]]); await credit(id, g.bet, g.win, 'gTower');
    return showTower(g, (await wallet(id)).coins, 'cash');
  }
  await redis([['SET', twKey(id), JSON.stringify(g), 'EX', KEEP_S]]);
  return showTower(g, (await wallet(id)).coins);
}

// Crash : le multiplicateur monte (× e^(0,00007 · ms)) jusqu'à un point tiré au départ et gardé ici ; encaisser avant
// qu'il n'explose. L'heure qui compte est celle du serveur à la réception de la demande.
const crKey = id => `cr:${id}`, CRASH_RATE = 0.00007, CRASH_CAP = 500, CRASH_LATE_MS = 3000;
const crashAt = ms => Math.floor(Math.exp(CRASH_RATE * ms) * 100) / 100;
// Sondage d'une manche en vol, sans verrou ni écriture : la page le fait chaque seconde pour savoir si la fusée a
// explosé. Tant qu'elle vole, il ne doit jamais gêner le « Cash out » du joueur. Rend null dès qu'il y a quelque chose
// à régler (explosée) ou rien en cours : le chemin normal, sous verrou, prend alors le relais.
async function crashPeek(id, at) {
  const [raw] = await redis([['GET', crKey(id)]]);
  const g = raw ? JSON.parse(raw) : null;
  if (!g) return null;
  // Explosée : on le note dans la manche avant de le dire à la page. Une fois que la page le sait, un « Cash out »
  // daté d'avant l'explosion n'est plus accepté (sinon on pourrait attendre l'explosion puis encaisser juste avant).
  if (crashAt(at - g.t0) >= g.point) { if (!g.seen) await redis([['SET', crKey(id), JSON.stringify({ ...g, seen: 1 }), 'EX', 600]]); return null; }
  return { done: false, t0: g.t0, now: at, bet: g.bet, rate: CRASH_RATE }; // sans le solde : une seule lecture, la page ne s'en sert pas ici
}
async function crash(id, body, at) {
  const [raw] = await redis([['GET', crKey(id)]]);
  let g = raw ? JSON.parse(raw) : null;
  // « at » : l'heure d'arrivée de la demande, avant une éventuelle attente du verrou (api/shop.js).
  const move = String(body.move || 'state'), now = Number.isFinite(at) ? at : Date.now();
  const bust = async () => { await redis([['DEL', crKey(id)]]); await credit(id, g.bet, 0, 'gCrash'); return { done: true, result: 'crash', point: g.point, bet: g.bet, win: 0, coins: (await wallet(id)).coins }; };
  // Clic arrivé après l'explosion à cause du réseau (signalé par Colt2 le 2026-10-16 : encaissé à 1.57 sur la page,
  // « explosé à 1.78 ») : on paie le moment du clic s'il était avant l'explosion, que la demande a moins de 3 s de
  // retard, et que personne n'a encore appris l'explosion au serveur (voir crashPeek).
  const late = g && move === 'cash' && !g.seen && Number.isFinite(Number(body.ms)) && Number(body.ms) >= 0 && now - g.t0 - Number(body.ms) <= CRASH_LATE_MS && crashAt(Number(body.ms)) < g.point;
  if (g && crashAt(now - g.t0) >= g.point && !late) return bust();
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
  // « ms » : le temps de vol affiché sur la page au moment du clic (la page affiche un peu en retard, voir js/app.js).
  // On paie ce que le joueur a vu, jamais plus que le temps réel : annoncer un temps plus court ne fait que perdre, et
  // l'explosion se juge toujours sur le temps réel (au-dessus).
  const claimed = Number(body.ms), real = now - g.t0, ms = Number.isFinite(claimed) && claimed >= 0 ? Math.min(claimed, real) : real;
  const mult = crashAt(ms), win = Math.floor(g.bet * mult);
  await redis([['DEL', crKey(id)]]); await credit(id, g.bet, win, 'gCrash');
  return { done: true, result: 'cash', mult, point: g.point, bet: g.bet, win, coins: (await wallet(id)).coins };
}

module.exports = { coinflip, flipMult, FLIP_MULT, FLIP_MAX, BONUS, bonusKind, PLINKO_HIGH, PLINKO_HIGH_MAX, SIDE, sideWins, MINES_CAP, PLINKO_MIN, PLINKO_BALLS, slots, SLOT_REEL, SLOT_PAYS, slotMult, crashPeek, MAX_BETS, house, board, roulette, blackjack, plinko, mines, tower, towerMult, TOWER_LEVELS, TOWER_FLOORS, crash, PLINKO, minesMult, MIN_BET, MAX_BET, MIN_ROLLS, RED: [...RED] };
