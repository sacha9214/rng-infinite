// Audit du casino : retour EXACT de chaque jeu (calculé sur les vraies règles du serveur, api/_gamble.js), pour la
// MEILLEURE stratégie du joueur. Échoue si un jeu, ou une seule stratégie, rend 100 % ou plus.
//   node tools/house-audit.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../api/_gamble.js');
const rows = [], fail = [];
const add = (game, best, how, note = '') => { rows.push({ jeu: game, 'retour au mieux': (best * 100).toFixed(2) + ' %', 'meilleure stratégie': how, note }); if (best >= 1) fail.push(`${game} : ${(best * 100).toFixed(3)} %`); };
const C = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };

// Roulette : un seul zéro. Chaque pari, et donc tout mélange de paris, rend la même chose.
{
  let best = 0, how = '';
  const RED = new Set(G.RED);
  const bets = { red: [2, n => RED.has(n)], black: [2, n => n > 0 && !RED.has(n)], even: [2, n => n > 0 && n % 2 === 0], odd: [2, n => n % 2 === 1], low: [2, n => n >= 1 && n <= 18], high: [2, n => n >= 19], douzaine: [3, n => n >= 1 && n <= 12], numéro: [36, n => n === 7] };
  for (const [k, [pays, wins]] of Object.entries(bets)) { let w = 0; for (let n = 0; n <= 36; n++) if (wins(n)) w += pays; const r = w / 37; if (r > best) { best = r; how = k; } }
  add('Roulette', best, `tous les paris (${how} compris)`, 'un seul zéro');
}
// Slots : 3 rouleaux de 20 crans, toutes les combinaisons.
{
  let tot = 0; const R = G.SLOT_REEL;
  for (const a of R) for (const b of R) for (const c of R) tot += G.slotMult([a, b, c]);
  add('Slots', tot / R.length ** 3, 'aucune (pur hasard)');
}
// Plinko : la case suit une loi binomiale ; les petites mises jouent la fraction au hasard (même moyenne).
for (const [name, T] of [['Plinko', G.PLINKO], ['Plinko High risk', G.PLINKO_HIGH]]) {
  const n = T.length - 1; add(name, T.reduce((x, m, k) => x + C(n, k) * m, 0) / 2 ** n, 'aucune (pur hasard)');
}
// Mines : m mines, on encaisse après k cases sûres. Toutes les combinaisons possibles.
{
  let best = 0, how = '';
  for (let m = 1; m <= 24; m++) for (let k = 1; k <= 25 - m; k++) {
    let p = 1; for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i);
    const r = p * G.minesMult(m, k); if (r > best) { best = r; how = `${m} mine(s), encaisser après ${k} case(s)`; }
  }
  add('Mines', best, how, 'chaque case paie 99 % des vraies chances, arrondi vers le bas, plafond ×250');
}
// Tower : n cases par étage dont une bombe, on encaisse après k étages. Toutes les combinaisons possibles.
{
  let best = 0, how = '';
  for (const [level, n] of Object.entries(G.TOWER_LEVELS)) for (let k = 1; k <= G.TOWER_FLOORS; k++) {
    const r = Math.pow((n - 1) / n, k) * G.towerMult(n, k); if (r > best) { best = r; how = `${level}, encaisser après ${k} étage(s)`; }
  }
  add('Tower', best, how, '94 % des vraies chances en Facile et Normal, 97 % en Difficile (100 max), arrondi vers le bas');
}
// Keno : k numéros cochés parmi 40, 10 tirés ; loi hypergéométrique exacte pour chaque nombre de cochés.
{
  let best = 0, how = '';
  for (let k = 1; k <= 10; k++) {
    let r = 0; for (let h = 0; h <= k; h++) r += C(k, h) * C(40 - k, 10 - h) / C(40, 10) * G.KENO_PAYS[k][h];
    if (r > best) { best = r; how = `${k} numéro(s) coché(s)`; }
  }
  add('Keno', best, how, 'table de gains par nombre de cochés, plafond ×1000');
}
// Crash : point = min(500, plancher(0,99 / (1 − u), 2 décimales)). Encaisser à m gagne si le point dépasse m.
{
  let best = 0, how = '';
  for (let c = 101; c <= 50000; c++) { const m = c / 100, p = Math.min(1, .99 / (m + .01)) * (m + .01 <= 500 ? 1 : 0); const r = p * m; if (r > best) { best = r; how = `encaisser à ×${m}`; } }
  add('Crash', best, how, '≈ 2 % des parties explosent à ×1.00');
}
// Pile ou face : chaque lancer gagné ×1,96 (arrondi vers le bas), 8 au plus.
{
  let best = 0, how = '';
  for (let k = 1; k <= G.FLIP_MAX; k++) { const r = G.flipMult(k) / 2 ** k; if (r > best) { best = r; how = `encaisser après ${k} lancer(s)`; } }
  add('Pile ou face', best, how);
}
// Blackjack : programmation dynamique exacte (sabot infini, croupier reste sur 17, BJ 3:2, doubler sur 2 cartes, pas de
// séparation, coup d'œil du croupier), avec les bonus 7-7-7 / 21 en 5, 6, 7+ cartes, et la meilleure stratégie possible.
{
  const B = G.BONUS, P = {}; for (let r = 1; r <= 10; r++) P[r] = (r === 10 ? 4 : 1) / 13;
  const val = (h, a) => (a && h + 10 <= 21 ? h + 10 : h);
  const memo = new Map();
  const dealer = (h, a) => { const key = h + ',' + a; if (memo.has(key)) return memo.get(key); const v = val(h, a); let out; if (v >= 17) out = { [Math.min(v, 22)]: 1 }; else { out = {}; for (let r = 1; r <= 10; r++) for (const [k, q] of Object.entries(dealer(h + r, a || r === 1))) out[k] = (out[k] || 0) + P[r] * q; } memo.set(key, out); return out; };
  const DU = {}; for (let up = 1; up <= 10; up++) { const out = {}; let tot = 0; for (let r = 1; r <= 10; r++) { if ((up === 1 && r === 10) || (up === 10 && r === 1)) continue; tot += P[r]; for (const [k, q] of Object.entries(dealer(up + r, up === 1 || r === 1))) out[k] = (out[k] || 0) + P[r] * q; } for (const k in out) out[k] /= tot; DU[up] = out; }
  const stand = (v, D) => (v > 21 ? -1 : Object.entries(D).reduce((x, [k, q]) => x + q * (+k === 22 || v > +k ? 1 : v === +k ? 0 : -1), 0));
  const bonus = (v, n, s7) => (v !== 21 ? 0 : n === 3 && s7 ? B.triple7 : n >= 7 ? B.seven : n === 6 ? B.six : n === 5 ? B.five : 0);
  const bm = new Map();
  const best = (h, a, n, s7, up) => { const key = [h, a, n, s7, up].join(); if (bm.has(key)) return bm.get(key); const v = val(h, a); let r; if (v > 21) r = -1; else if (v === 21) r = stand(21, DU[up]) + bonus(21, n, s7); else { let hit = 0; for (let x = 1; x <= 10; x++) hit += P[x] * best(h + x, a || x === 1, n + 1, s7 && x === 7, up); r = Math.max(stand(v, DU[up]), hit); } bm.set(key, r); return r; };
  const dbl = (h, a, s7, up) => { let t = 0; for (let x = 1; x <= 10; x++) { const v = val(h + x, a || x === 1); t += P[x] * (2 * stand(v, DU[up]) + bonus(v, 3, s7 && x === 7)); } return t; };
  let ev = 0;
  for (let up = 1; up <= 10; up++) { const dn = up === 1 ? 4 / 13 : up === 10 ? 1 / 13 : 0; for (let a = 1; a <= 10; a++) for (let b = 1; b <= 10; b++) { const pp = P[up] * P[a] * P[b]; if ((a === 1 && b === 10) || (a === 10 && b === 1)) { ev += pp * (1 - dn) * 1.5; continue; } ev += pp * dn * -1; const h = a + b, ac = a === 1 || b === 1, s7 = a === 7 && b === 7; ev += pp * (1 - dn) * Math.max(best(h, ac, 2, s7, up), dbl(h, ac, s7, up)); } }
  add('Blackjack', 1 + ev, 'stratégie parfaite, en cherchant les bonus', 'sans séparation des paires');
  add('Blackjack · assurance', 3 * 4 / 13, 'aucune', 'payée 2 contre 1');
  const S = G.SIDE; add('Blackjack · Match', (3 / 52 * S.rank + 1 / 52 * S.suited) * (1 + (S.pair - 1) * 4 / 52), 'aucune');
}
console.table(rows);
if (fail.length) { console.error('\n✗ Le casino perd sur :', fail.join(' ; ')); process.exit(1); }
console.log('\nOK : le casino gagne à tous les jeux, même contre la meilleure stratégie.');
