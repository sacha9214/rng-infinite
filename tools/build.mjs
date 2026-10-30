// Génère js/badge-meta.js et js/percentiles.js, et valide le moteur.
//   node tools/build.mjs
// Validation 1 : pour chaque badge, score dérivé de sa fréquence réelle (100 × 1 000 001 / nb) == score de référence.
// Validation 2 : totaux XP de vrais tirages relevés sur le leaderboard d'origine.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createEngine, TIER_ORDER } = require(path.join(ROOT, 'js/engine.js'));

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/source/meta.json'), 'utf8'));
const family = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/source/family.json'), 'utf8'));
// Badges ajoutés pour nos parties (absents de l'original) : exclus des validations contre l'original.
const custom = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/source/custom.json'), 'utf8'));
const CUSTOM_IDS = new Set(custom.map(b => b.id));
const BADGE_META = [
  ...meta.map(b => ({ id: b.id, label: b.label, desc: b.desc, emoji: b.emoji, score: b.score, family: family[b.id] || null })),
  ...custom.map(b => ({ id: b.id, label: b.label, desc: b.desc, emoji: b.emoji, score: b.score, family: b.family || null, custom: true })), // family : seul le meilleur badge de la famille compte (comme Pi)
].sort((a, b) => b.score - a.score);

const SPAN = 1000001;
const engine = createEngine(BADGE_META, null);
const index = new Map(engine.badges.map((b, i) => [b.id, i]));
const counts = new Float64Array(engine.badges.length);
const totals = new Float64Array(SPAN);
const originalTotals = new Float64Array(SPAN);

const t0 = Date.now();
// Part perso d'un tirage : dans une famille perso, seul le meilleur badge compte (avant le 2026-10-27, tous étaient
// soustraits : 13, 25111 et 679999, à la fois Happy et Happy Prime, sortaient 699 XP trop bas → 93/96).
for (const b of custom) if (b.family && Object.values(family).includes(b.family)) throw new Error(`Famille perso ${b.family} partagée avec un badge d'origine`);
for (let n = 0; n < SPAN; n++) {
  let customPart = 0;
  const bestFam = new Map();
  totals[n] = engine.scoreOf(n, b => {
    counts[index.get(b.id)]++;
    if (!CUSTOM_IDS.has(b.id)) return;
    if (!b.family) customPart += b.score;
    else if (!bestFam.has(b.family) || b.score > bestFam.get(b.family)) bestFam.set(b.family, b.score);
  });
  for (const s of bestFam.values()) customPart += s;
  originalTotals[n] = totals[n] - customPart;
}
console.log(`Énumération : ${((Date.now() - t0) / 1000).toFixed(1)} s`);

let mismatches = 0;
engine.badges.forEach((b, i) => {
  const derived = counts[i] ? Math.round((100 * SPAN) / counts[i]) : Infinity;
  if (CUSTOM_IDS.has(b.id)) {
    console.log(`  • badge perso ${b.id} : ${b.score} XP (valeur naturelle d'après sa fréquence : ${derived})`);
    return;
  }
  if (derived !== b.score) {
    mismatches++;
    console.log(`  ✗ ${b.id.padEnd(26)} attendu ${b.score}  obtenu ${derived}  (nb=${counts[i]})`);
  }
});
console.log(`Badges d'origine : ${meta.length - mismatches}/${meta.length} scores conformes`);

// Totaux relevés sur le leaderboard d'origine (tirages du jour).
const KNOWN = {
  1337: 100177458, 911: 100155452, 40320: 11127065, 877777: 6162919, 977777: 6129025, 800850: 5020206,
  180085: 5008069, 271821: 5006438, 13: 4947275, 76: 4369559, 160000: 4183956, 678: 3679951, 43210: 3448828,
  87654: 3438766, 54321: 3437853, 2584: 3354009, 278910: 2644428, 210987: 2640090, 789102: 2637543,
  710987: 2637532, 810119: 2302745, 981110: 2292216, 811910: 2279909, 11011: 2279509, 119108: 2277000,
  1010: 2066511, 111100: 1729612, 420169: 1701510, 420696: 1697046, 692420: 1696796, 420698: 1696732,
  420694: 1696284, 101110: 1669869, 11001: 1621923, 72: 1608851, 586420: 1486015, 864206: 1485837,
  864205: 1484329, 997531: 1466972, 697531: 1461410, 397531: 1460146, 413579: 1457976, 60000: 1180635,
  679999: 1116700, 951: 1098771, 879999: 1095492, 179999: 1078940, 280000: 1063017, 580000: 1058424,
  109999: 1057270, 819999: 1056119, 809999: 1055979, 209999: 1055450, 255000: 1046430, 25111: 1044543,
  11215: 1039963, 65000: 1022820, 765000: 1022637, 435000: 1011736, 465000: 1010273, 215000: 1009957,
  815000: 1008748, 421875: 1008088, 685000: 1007285, 925000: 1006081, 835000: 1006081, 274625: 1005981,
  12167: 1000760, 753571: 998203, 287496: 996835, 185193: 996820, 157464: 995428, 97336: 994560,
  493039: 994355, 438976: 994066, 79507: 993907, 405224: 993033, 111112: 961665, 444445: 953598,
  669699: 917877, 966666: 914245, 122222: 911160, 344444: 908493, 222226: 868199, 955555: 866649,
  622222: 860529, 922222: 859432, 6767: 831799, 96969: 802156, 900002: 739264, 81118: 730908,
  818818: 703297, 777757: 696943, 68889: 673731, 906: 645368, 130514: 8932,
};
let knownOk = 0;
for (const [n, expected] of Object.entries(KNOWN)) {
  const got = originalTotals[Number(n)];
  if (got === expected) knownOk++;
  else console.log(`  ✗ tirage ${n} : attendu ${expected} XP, obtenu ${got} XP`);
}
console.log(`Tirages réels : ${knownOk}/${Object.keys(KNOWN).length} totaux conformes`);

// Table des percentiles : pct(S) = % des tirages possibles au score strictement inférieur.
const sorted = Float64Array.from(totals).sort();
const table = [];
let lastPct = -1;
for (let i = 0; i < SPAN; i++) {
  if (i > 0 && sorted[i] === sorted[i - 1]) continue;
  const pct = (100 * i) / SPAN;
  // Les deux bouts : chaque score distinct (raretés Land waste, Garbage, et Celestial à Infinite en haut). Avant le
  // 2026-10-30, l'écart minimal était 0,0001 % ; or un nombre pèse 100 / 1 000 001 = 0,0000999999 %, donc une ligne sur
  // deux sautait en haut : le rang pair ou impair décidait de la rareté (24, 10e nombre, tombé en Godlike ; 9 Infinite
  // au lieu de 10, signalé par kaz).
  const isTail = pct >= 99 || pct < 0.1;
  if (table.length === 0 || isTail || pct - lastPct >= 0.01) {
    table.push([sorted[i], Math.round(pct * 10000) / 10000]);
    lastPct = pct;
  }
}

const withPct = createEngine(BADGE_META, table);
const tierOdds = Object.fromEntries(TIER_ORDER.map(t => [t, 0]));
let pctSum = 0;
for (let n = 0; n < SPAN; n++) {
  tierOdds[withPct.cardTier(totals[n])]++;
  pctSum += withPct.percentileOf(totals[n]);
}
const meanPct = pctSum / SPAN;
for (const t of TIER_ORDER) tierOdds[t] = tierOdds[t] / SPAN;
const avg = totals.reduce((a, b) => a + b, 0) / SPAN;
console.log('Probabilité par rareté de carte :', Object.fromEntries(Object.entries(tierOdds).map(([k, v]) => [k, (v * 100).toFixed(2) + '%'])));
console.log(`XP moyen ${Math.round(avg)} · médian ${sorted[Math.floor(SPAN / 2)]} · table ${table.length} entrées`);

const badgeOdds = Object.fromEntries(engine.badges.map((b, i) => [b.id, counts[i] / SPAN]));

// Fréquence attendue de chaque chiffre dans l'écriture d'un tirage uniforme (les zéros de tête n'existent pas).
const digitCounts = new Array(10).fill(0);
let digitTotal = 0;
for (let n = 0; n < SPAN; n++) {
  const s = String(n);
  for (let i = 0; i < s.length; i++) digitCounts[s.charCodeAt(i) - 48]++;
  digitTotal += s.length;
}
const digitOdds = digitCounts.map(x => x / digitTotal);
fs.writeFileSync(path.join(ROOT, 'js/badge-meta.js'),
  '// Généré par tools/build.mjs — ne pas éditer.\nwindow.BADGE_META = ' + JSON.stringify(BADGE_META) + ';\n' +
  'window.BADGE_ODDS = ' + JSON.stringify(badgeOdds) + ';\n');
fs.writeFileSync(path.join(ROOT, 'js/percentiles.js'),
  '// Généré par tools/build.mjs — ne pas éditer.\nwindow.SCORE_PERCENTILES = ' + JSON.stringify(table) + ';\n' +
  'window.TIER_ODDS = ' + JSON.stringify(tierOdds) + ';\n' +
  'window.SCORE_STATS = ' + JSON.stringify({ mean: avg, median: sorted[Math.floor(SPAN / 2)], meanPct }) + ';\n' +
  'window.DIGIT_ODDS = ' + JSON.stringify(digitOdds) + ';\n');

// Mêmes données pour les fonctions serveur de Vercel (/api), qui recalculent l'XP de chaque tirage.
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/badge-meta.json'), JSON.stringify(BADGE_META));
fs.writeFileSync(path.join(ROOT, 'data/percentiles.json'), JSON.stringify(table));
// Nombre de tirages qui obtiennent chaque badge : titres de collection par rareté (js/achievements.js collectionSets,
// idée de kaz, 2026-10-27), pour ne jamais exiger un badge plus rare que sa couleur.
fs.writeFileSync(path.join(ROOT, 'data/badge-odds.json'), JSON.stringify(Object.fromEntries(engine.badges.map((b, i) => [b.id, counts[i]]))));

if (mismatches || knownOk !== Object.keys(KNOWN).length) process.exitCode = 1;
