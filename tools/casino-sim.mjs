// Banc d'essai du casino : des dizaines de milliers de manches de chaque jeu, jouées contre le vrai code serveur
// (api/_gamble.js) sur un faux Redis en mémoire. Pour chaque manche : le solde bouge exactement de −mise +gain, le
// gain est recalculé ici indépendamment, rien ne traîne dans la base une fois la manche finie, et le compte de la
// maison suit. À la fin : le taux de retour mesuré de chaque jeu, comparé à sa valeur théorique.
//   node tools/casino-sim.mjs [manches par jeu = 20000]
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeRedis } from './fake-redis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.KV_REST_API_URL = 'https://fake-redis.test';
process.env.KV_REST_API_TOKEN = 'test-token';
const { run } = fakeRedis();
globalThis.fetch = async (url, opts) => ({ ok: true, json: async () => run(JSON.parse(opts.body)) });
const G = require(path.join(ROOT, 'api/_gamble.js'));
const Shop = require(path.join(ROOT, 'js/shop.js'));
const N = Number(process.argv[2]) || 20000;
const id = 'c'.repeat(16), key = `stats:${id}`;
const obj = flat => { const o = {}; for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const coins = () => Shop.balance(obj(run([['HGETALL', key]])[0].result));
const house = () => { const h = obj(run([['HGETALL', 'casino']])[0].result || []); return [Number(h.bet) || 0, Number(h.won) || 0, Number(h.rounds) || 0]; };
const keys = () => ['bj', 'mn', 'cr'].map(k => run([['GET', `${k}:${id}`]])[0].result).filter(Boolean).length;
run([['HSET', key, 'v', '1', 'tv', '2', 'rolls', '100', 'bonus', '2000000000'], ['HSET', 'names', id, 'Sim'], ['HSET', 'casino', 'seeded', '1']]);
const rnd = n => Math.floor(Math.random() * n), pick = a => a[rnd(a.length)];
const BETS = [10, 50, 100, 250, 500, 1000];
const report = [];

// Une manche vérifiée : solde, compte de la maison, clés de partie.
async function round(game, play) {
  const c0 = coins(), h0 = house();
  const { bet, win } = await play();
  const h1 = house();
  assert.equal(coins() - c0, win - bet, `${game} : le solde bouge de −mise +gain`);
  assert.deepEqual([h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]], [bet, win, 1], `${game} : compte de la maison`);
  assert.equal(keys(), 0, `${game} : aucune partie laissée dans la base`);
  return { bet, win };
}
async function series(game, theory, play, n = N) {
  let bet = 0, win = 0, top = 0;
  for (let i = 0; i < n; i++) { const r = await round(game, play); bet += r.bet; win += r.win; top = Math.max(top, r.win / r.bet); }
  report.push({ jeu: game, manches: n, 'retour mesuré': (100 * win / bet).toFixed(2) + ' %', 'retour théorique': theory, 'plus gros gain': top.toFixed(1) + '×' });
  return win / bet;
}

// ---- Roulette : mises au hasard, gain recalculé depuis le numéro sorti
const RED = new Set(G.RED);
const pays = (t, v, n) => ({ red: RED.has(n), black: n > 0 && !RED.has(n), even: n > 0 && n % 2 === 0, odd: n % 2 === 1, low: n >= 1 && n <= 18, high: n >= 19, d1: n >= 1 && n <= 12, d2: n >= 13 && n <= 24, d3: n >= 25, n: n === v }[t] ? ({ d1: 3, d2: 3, d3: 3, n: 36 }[t] || 2) : 0);
const seenN = new Set();
let rtp = await series('roulette', '97,30 %', async () => {
  const types = ['red', 'black', 'even', 'odd', 'low', 'high', 'd1', 'd2', 'd3', 'n'];
  const bets = []; let total = 0;
  for (let k = 0, m = 1 + rnd(5); k < m; k++) { const a = pick([10, 50, 100]); if (total + a > 1000) break; total += a; const t = pick(types); bets.push(t === 'n' ? { t, v: rnd(37), a } : { t, a }); }
  const r = await G.roulette(id, { bets });
  assert.ok(Number.isInteger(r.n) && r.n >= 0 && r.n <= 36); seenN.add(r.n);
  assert.equal(r.color, r.n === 0 ? 'green' : RED.has(r.n) ? 'red' : 'black');
  assert.equal(r.win, bets.reduce((x, b) => x + b.a * pays(b.t, b.v, r.n), 0), 'gain de roulette');
  assert.equal(r.total, total);
  return { bet: total, win: r.win };
});
assert.equal(seenN.size, 37, 'les 37 numéros sortent');
assert.ok(rtp > .93 && rtp < 1.01, `roulette ${rtp}`);

// ---- Blackjack : stratégie simple (tirer sous 17, doubler à 10 ou 11), résultat recalculé depuis les cartes
const val = h => { let v = h.reduce((x, c) => x + Math.min(10, c.r), 0); if (h.some(c => c.r === 1) && v + 10 <= 21) v += 10; return v; };
const nat = h => h.length === 2 && val(h) === 21;
const results = {};
rtp = await series('blackjack', '≈ 97 à 99 % (selon le jeu du joueur)', async () => {
  let h = await G.blackjack(id, { move: 'deal', bet: pick(BETS) });
  while (!h.done) {
    assert.equal(h.dealer.length, 1, 'une seule carte du croupier visible pendant la main');
    assert.equal(h.value, val(h.player));
    h = await G.blackjack(id, { move: h.canDouble && (h.value === 10 || h.value === 11) && Math.random() < .7 ? 'double' : h.value < 17 ? 'hit' : 'stand' });
  }
  const p = val(h.player), d = val(h.dealer);
  const expect = p > 21 ? 'bust' : nat(h.player) && !nat(h.dealer) ? 'blackjack' : nat(h.dealer) && !nat(h.player) ? 'lose' : d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose';
  assert.equal(h.result, expect, JSON.stringify(h));
  assert.equal(h.win, { blackjack: Math.floor(h.bet * 2.5), win: h.bet * 2, push: h.bet }[expect] || 0);
  if (p <= 21 && !nat(h.player)) assert.ok(d >= 17, 'le croupier tire jusqu\'à 17');
  for (const c of [...h.player, ...h.dealer]) assert.ok(c.r >= 1 && c.r <= 13 && c.s >= 0 && c.s <= 3);
  results[expect] = (results[expect] || 0) + 1;
  return { bet: h.bet, win: h.win };
});
assert.ok(rtp > .93 && rtp < 1.03, `blackjack ${rtp}`);
assert.ok(['blackjack', 'win', 'push', 'lose', 'bust'].every(k => results[k] > 0), 'toutes les issues se produisent');

// ---- Plinko : la case est la somme du chemin, le gain suit la table
const slots = new Array(13).fill(0);
rtp = await series('plinko', '98,99 %', async () => {
  const bet = pick(BETS), r = await G.plinko(id, { bet });
  assert.equal(r.path.length, 12); assert.ok(r.path.every(x => x === 0 || x === 1));
  assert.equal(r.slot, r.path.reduce((x, d) => x + d, 0)); assert.equal(r.mult, G.PLINKO[r.slot]); assert.equal(r.win, Math.floor(bet * r.mult));
  slots[r.slot]++;
  return { bet, win: r.win };
}, N * 3);
assert.ok(rtp > .95 && rtp < 1.03, `plinko ${rtp}`);
assert.ok(slots[6] > slots[4] && slots[4] > slots[2], 'le centre sort plus que les bords');
// Petites mises (1 et 5 pièces) et billes par paquets : le gain de chaque bille est l'arrondi inférieur ou supérieur
// de mise × case, le total suit, et le retour reste autour de 99 % (la fraction est jouée au hasard, pas perdue).
for (const small of [1, 5, 7]) {
  let bet = 0, win = 0;
  for (let i = 0; i < N / 10; i++) {
    const count = 1 + rnd(G.PLINKO_BALLS), c0 = coins(), h0 = house();
    const r = await G.plinko(id, { bet: small, count });
    assert.equal(r.balls.length, count); assert.equal(r.total, small * count);
    for (const b of r.balls) { const exact = small * b.mult; assert.ok(b.win === Math.floor(exact + 1e-9) || b.win === Math.ceil(exact - 1e-9), `bille ${small} × ${b.mult} → ${b.win}`); assert.equal(b.slot, b.path.reduce((x, d) => x + d, 0)); }
    assert.equal(r.win, r.balls.reduce((x, b) => x + b.win, 0));
    assert.equal(coins() - c0, r.win - r.total, 'solde du paquet');
    const h1 = house(); assert.deepEqual([h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]], [r.total, r.win, count], 'compte de la maison du paquet');
    bet += r.total; win += r.win;
  }
  report.push({ jeu: `plinko à ${small}`, manches: Math.round(N / 10), 'retour mesuré': (100 * win / bet).toFixed(2) + ' %', 'retour théorique': '98,99 %', 'plus gros gain': '' });
  assert.ok(win / bet > .9 && win / bet < 1.08, `plinko à ${small} : ${win / bet}`);
}
for (const bad of [0, 21, 1.5, -1, 'x']) await assert.rejects(G.plinko(id, { bet: 10, count: bad }));
assert.equal((await G.plinko(id, { bet: 1 })).balls.length, 1);
// Mises sous 10 : refusées partout ailleurs.
for (const b of [1, 5, 9]) { await assert.rejects(G.slots(id, { bet: b })); await assert.rejects(G.crash(id, { move: 'start', bet: b })); await assert.rejects(G.roulette(id, { bets: [{ t: 'red', a: b }] })); }


// ---- Machine à sous : trois symboles du rouleau, gain recalculé depuis la table
const combos = {};
rtp = await series('machine à sous', '96,41 %', async () => {
  const bet = pick(BETS), r = await G.slots(id, { bet });
  assert.ok(r.reels.length === 3 && r.reels.every(s => G.SLOT_REEL.includes(s)));
  const three = r.reels[0] === r.reels[1] && r.reels[1] === r.reels[2];
  const two = Object.keys(G.SLOT_PAYS.two).find(k => r.reels.filter(x => x === k).length === 2);
  const mult = three ? G.SLOT_PAYS.three[r.reels[0]] : two ? G.SLOT_PAYS.two[two] : 0;
  assert.equal(r.mult, mult); assert.equal(r.win, Math.floor(bet * mult));
  const k = three ? '3 ' + r.reels[0] : two ? '2 ' + two : 'rien'; combos[k] = (combos[k] || 0) + 1;
  return { bet, win: r.win };
}, N * 5);
assert.ok(rtp > .9 && rtp < 1.03, `machine à sous ${rtp}`);
assert.ok(combos['3 seven'] > 0 && combos['3 diamond'] > 0 && combos['2 cherry'] > 0 && combos.rien > 0, 'toutes les combinaisons sortent, jackpot compris');
// Retour exact de la table, par énumération des 8 000 combinaisons.
{ let ev = 0, hit = 0; for (const a of G.SLOT_REEL) for (const b of G.SLOT_REEL) for (const c of G.SLOT_REEL) { const m = G.slotMult([a, b, c]); ev += m; if (m) hit++; } assert.equal((ev / 8000).toFixed(4), '0.9641'); assert.equal((hit / 8000).toFixed(3), '0.332'); }

// ---- Mines : nombre de mines et de cases au hasard, multiplicateur recalculé
const mult = (m, k) => { let x = 0.99; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return Math.floor(x * 100) / 100; };
let booms = 0, cashes = 0, full = 0;
rtp = await series('mines', '≈ 99 % (moins l\'arrondi)', async () => {
  const m = 1 + rnd(24), bet = pick(BETS), want = 1 + rnd(Math.min(6, 25 - m));
  let g = await G.mines(id, { move: 'start', bet, mines: m });
  assert.deepEqual([g.open.length, g.done, g.bombs], [0, false, undefined], 'les mines ne sortent pas avant la fin');
  await assert.rejects(G.mines(id, { move: 'cash' }), /Open a tile first/);
  const order = Array.from({ length: 25 }, (_, i) => i).sort(() => Math.random() - .5);
  for (let k = 0; k < want && !g.done; k++) {
    g = await G.mines(id, { move: 'pick', cell: order[k] });
    if (!g.done) { assert.equal(g.mult, mult(m, g.open.length)); assert.equal(g.bombs, undefined); }
  }
  if (!g.done) g = await G.mines(id, { move: 'cash' });
  assert.equal(g.bombs.length, m); assert.ok(g.open.every(c => !g.bombs.includes(c)), 'une case ouverte n\'est jamais une mine');
  if (g.result === 'boom') { booms++; assert.equal(g.win, 0); assert.ok(g.bombs.includes(g.hit)); }
  else { cashes++; assert.equal(g.win, Math.floor(bet * mult(m, g.open.length))); if (g.open.length === 25 - m) full++; }
  return { bet, win: g.win };
}, Math.round(N / 2));
assert.ok(booms > 0 && cashes > 0 && full > 0, 'explosions, encaissements et grilles vidées');
// Le retour mesuré dépend beaucoup de la chance (des gains à ×297 sortent) : la bande est large. Le contrôle serré
// est exact : pour chaque nombre de mines et de cases ouvertes, chance de survie × multiplicateur ≤ 99 %.
void rtp;
for (let m = 1; m <= 24; m++) for (let k = 1; k <= 25 - m; k++) { let pr = 1; for (let i = 0; i < k; i++) pr *= (25 - m - i) / (25 - i); const ev = pr * G.minesMult(m, k); assert.ok(ev <= .99000001 && ev > .93, `mines ${m}/${k} : ${ev}`); }

// ---- Crash : encaissement visé à un multiplicateur au hasard ; l'heure d'arrivée est fournie au serveur
let instant = 0, cashed = 0;
rtp = await series('crash', '≈ 99 % (moins l\'arrondi)', async () => {
  const bet = pick(BETS), target = pick([1.1, 1.5, 2, 3, 5, 10, 50]);
  const s = await G.crash(id, { move: 'start', bet });
  if (s.done) { instant++; assert.deepEqual([s.result, s.win, s.point], ['crash', 0, 1]); return { bet, win: 0 }; }
  assert.equal(s.point, undefined, 'le point de crash ne sort pas');
  const ms = Math.ceil(Math.log(target) / 0.00007) + 1;
  // Un sondage en route ne change rien tant que la fusée vole.
  const mid = await G.crash(id, { move: 'state' }, s.t0 + Math.floor(ms / 2));
  if (mid.done) { assert.equal(mid.result, 'crash'); assert.ok(mid.point <= Math.floor(Math.exp(0.00007 * Math.floor(ms / 2)) * 100) / 100); return { bet, win: 0 }; }
  const r = await G.crash(id, { move: 'cash' }, s.t0 + ms);
  const at = Math.floor(Math.exp(0.00007 * ms) * 100) / 100;
  if (r.result === 'crash') { assert.ok(r.point <= at, 'explosée avant l\'encaissement'); assert.equal(r.win, 0); return { bet, win: 0 }; }
  cashed++; assert.equal(r.mult, at); assert.ok(r.point > at); assert.equal(r.win, Math.floor(bet * at));
  return { bet, win: r.win };
});
assert.ok(instant > 0 && cashed > 0, 'crashs immédiats et encaissements');
assert.ok(rtp > .9 && rtp < 1.08, `crash ${rtp}`);

// ---- Refus : mises hors bornes, solde insuffisant, coups impossibles — sans jamais toucher au solde
const c0 = coins();
for (const bad of [0, 5, 9, 1001, 10.5, -50, '100', null, NaN]) {
  if (![5, 9].includes(bad)) await assert.rejects(G.plinko(id, { bet: bad })); await assert.rejects(G.slots(id, { bet: bad })); await assert.rejects(G.crash(id, { move: 'start', bet: bad }));
  await assert.rejects(G.mines(id, { move: 'start', bet: bad, mines: 3 })); await assert.rejects(G.blackjack(id, { move: 'deal', bet: bad }));
  await assert.rejects(G.roulette(id, { bets: [{ t: 'red', a: bad }] }));
}
for (const m of [0, 25, 2.5, -1, 'x']) await assert.rejects(G.mines(id, { move: 'start', bet: 100, mines: m }));
await assert.rejects(G.roulette(id, { bets: [] })); await assert.rejects(G.roulette(id, { bets: [{ t: 'n', v: 37, a: 10 }] })); await assert.rejects(G.roulette(id, { bets: [{ t: 'zzz', a: 10 }] }));
await assert.rejects(G.roulette(id, { bets: [{ t: 'red', a: 600 }, { t: 'black', a: 600 }] }), /Maximum/);
await assert.rejects(G.roulette(id, { bets: Array.from({ length: 13 }, (_, v) => ({ t: 'n', v, a: 10 })) }), /At most 12/);
await assert.rejects(G.blackjack(id, { move: 'hit' }), /No hand/); await assert.rejects(G.mines(id, { move: 'pick', cell: 3 }), /No game/); await assert.rejects(G.crash(id, { move: 'cash' }), /No game/);
assert.equal(coins(), c0, 'aucun refus ne coûte de pièces');
// Solde insuffisant et casino verrouillé avant 30 tirages.
const poor = 'd'.repeat(16);
run([['HSET', `stats:${poor}`, 'v', '1', 'tv', '2', 'rolls', '100', 'bonus', '40']]);
await assert.rejects(G.plinko(poor, { bet: 50 }), /Not enough coins: 10 more needed/);
assert.equal((await G.plinko(poor, { bet: 10 })).bet, 10);
run([['HSET', `stats:${poor}`, 'rolls', '29', 'bonus', '5000']]);
await assert.rejects(G.plinko(poor, { bet: 10 }), /unlocks after 30 rolls/);
// Doubler sans les pièces : refusé, la main continue.
run([['HSET', `stats:${poor}`, 'rolls', '100', 'bonus', '0', 'spent', '0', 't:common', '0']]);
const cPoor = () => Shop.balance(obj(run([['HGETALL', `stats:${poor}`]])[0].result));
run([['HINCRBY', `stats:${poor}`, 'bonus', 100 - cPoor()]]);
let hand; do { if (hand && hand.done) run([['HINCRBY', `stats:${poor}`, 'bonus', 100 - cPoor()]]); hand = await G.blackjack(poor, { move: 'deal', bet: 100 }); } while (hand.done);
await assert.rejects(G.blackjack(poor, { move: 'double' }), /Not enough coins/);
assert.equal((await G.blackjack(poor, { move: 'state' })).done, false, 'la main est toujours là');
await assert.rejects(G.blackjack(poor, { move: 'deal', bet: 10 }), /Finish your hand first/);

console.table(report);
console.log('OK : tous les contrôles passent sur', report.reduce((x, r) => x + r.manches, 0), 'manches');
