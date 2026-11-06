// Mode difficile (demandé par Sacha, 2026-11-02 : « 10 chiffres au lieu de 6, et adapte tout pour que ce soit juste ») :
// les données du moteur pour les tirages de 0 à 9 999 999 999. Lancer après tools/build.mjs (mêmes badges) :
//   node tools/build-hard.mjs          (≈ 20 à 30 min sur un Mac M3, tous les cœurs)
// Impossible de passer les 10 milliards de nombres un par un (tools/build.mjs le fait pour le million du mode normal).
// Ici, par nombre de chiffres L :
//   - L ≤ 7 (0 à 9 999 999) : tous les nombres, compte exact ;
//   - L = 8, 9, 10 : un échantillon tiré au hasard, mais toujours le même (graine fixe) : relancer donne les mêmes données.
// Deux passes :
//   1. Fréquence de chaque badge → son XP, avec la même règle que le mode normal (100 × nombre de tirages possibles / nombre
//      de tirages qui l'obtiennent). Conséquence voulue : l'XP moyenne d'un tirage est la même dans les deux modes
//      (chaque badge rapporte en moyenne 100 XP par tirage), seuls les gros coups vont beaucoup plus haut.
//      Un badge trop rare pour l'échantillon d'une longueur (moins de MIN_HITS fois) est estimé à partir des longueurs
//      comptées exactement (6 → 7, prolongé).
//   2. Totaux d'XP avec ces valeurs → table des percentiles (par paliers de 0,25 % d'XP), raretés et cotes.
// Écrit data/hard-meta.json, data/hard-percentiles.json, data/hard-odds.json (serveur) et js/hard-data.js (site,
// chargé seulement quand un joueur passe en mode difficile).
// Pack du mode difficile (2026-11-05) : les badges de tools/source/hard.json s'ajoutent à ceux du mode normal, ici
// seulement (tools/build.mjs ne les lit pas : aucune rareté du mode normal ne bouge). Ceux qui sont trop rares pour
// l'échantillon de 8 à 10 chiffres sont comptés exactement (voir PARTS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createEngine, TIER_ORDER, HARD_CARD_TIERS, HARD_MAX } = require(path.join(ROOT, 'js/engine.js'));

const SPAN = HARD_MAX + 1; // 10 000 000 000 tirages possibles
// HARD_QUICK=1 : essai rapide (petits échantillons, rien d'écrit), pour vérifier l'outil.
const QUICK = !!process.env.HARD_QUICK;
const EXACT_MAX_L = 7;
const SAMPLES = QUICK ? { 8: 2e5, 9: 2e5, 10: 1e6 } : { 8: 3e6, 9: 6e6, 10: 3e7 };
const MIN_HITS = 30;
const K = 400; // paliers de la table : 400 par unité de logarithme, soit 0,25 % d'XP
const sizeOf = L => (L === 1 ? 10 : 9 * 10 ** (L - 1));
const lowOf = L => (L === 1 ? 0 : 10 ** (L - 1));
const bucketOf = t => Math.floor(Math.log1p(t) * K);
const keyOf = b => Math.ceil(Math.expm1(b / K));

// Badges du pack difficile trop rares pour l'échantillon (de 1 nombre à quelques dizaines de milliers sur des milliards) :
// on énumère tous les nombres de 8 à 10 chiffres qui contiennent un de leurs motifs, et on garde ceux que le moteur
// valide. Le compte est exact, au lieu d'un prolongement depuis 6 et 7 chiffres (impossible : ces badges n'y existent pas).
const runOf = k => [...'0123456789'].map(d => d.repeat(k));
const seqOf = k => {
  const out = [];
  for (let a = 0; a + k <= 10; a++) { let up = '', down = ''; for (let i = 0; i < k; i++) { up += a + i; down += 9 - a - i; } out.push(up, down); }
  return out;
};
const PARTS = {
  CONTIGUOUS_SEVENS: runOf(7), CONTIGUOUS_EIGHTS: runOf(8), CONTIGUOUS_NINES: runOf(9), CONTIGUOUS_TENS: runOf(10),
  SEQUENCE_7: seqOf(7), SEQUENCE_8: seqOf(8), SEQUENCE_9: seqOf(9), SEQUENCE_10: seqOf(10),
  BRAINROT_EIGHT: ['67676767'], BRAINROT_TEN: ['6767676767'], INT32_MAX: ['2147483647'],
  MERSENNE_PRIME: ['2147483647'], // le seul premier de Mersenne de 8 à 10 chiffres (2³¹ − 1) ; les autres sont sous 10⁷
  FIB_CONTAINS_7: ['1123581'], FIB_CONTAINS_8: ['11235813'], FIB_CONTAINS_9: ['112358132'], FIB_EXACT_10: ['1123581321'],
};
// { L: nombres de L chiffres qui obtiennent le badge } pour L = 8 à 10.
function exactCounts(engine, id, parts) {
  const out = {};
  for (let L = EXACT_MAX_L + 1; L <= 10; L++) {
    const found = new Set();
    for (const part of parts) {
      if (part.length > L) continue;
      const free = L - part.length;
      for (let at = 0; at <= free; at++) {
        for (let f = 0; f < 10 ** free; f++) {
          const fill = free ? String(f).padStart(free, '0') : '', s = fill.slice(0, at) + part + fill.slice(at); // sans place libre : String(0) ferait un chiffre de trop
          if (s[0] !== '0') found.add(Number(s));
        }
      }
    }
    let k = 0;
    for (const n of found) { let hit = false; engine.scoreOf(n, b => { if (b.id === id) hit = true; }); if (hit) k++; }
    out[L] = k;
  }
  return out;
}

// Générateur pseudo-aléatoire à graine (sfc32) : le même échantillon à chaque construction.
function sfc32(a, b, c, d) {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
const uniform = rnd => rnd() + rnd() / 4294967296; // [0, 1) sur 52 bits environ

// Morceaux de travail : intervalles exacts, puis échantillons (par paquets, chacun sa graine).
function tasks() {
  const out = [];
  const CHUNK = 250000;
  for (let from = 0; from < 10 ** EXACT_MAX_L; from += CHUNK) out.push({ kind: 'range', from, to: Math.min(10 ** EXACT_MAX_L, from + CHUNK) });
  for (const [L, count] of Object.entries(SAMPLES)) {
    const PACK = 250000;
    for (let k = 0; k * PACK < count; k++) out.push({ kind: 'sample', L: Number(L), count: Math.min(PACK, count - k * PACK), seed: [Number(L) * 7919, k + 1, 0x9e3779b9, 12345] });
  }
  return out;
}
function* numbersOf(task) {
  if (task.kind === 'range') { for (let n = task.from; n < task.to; n++) yield n; return; }
  const rnd = sfc32(...task.seed), lo = lowOf(task.L), size = sizeOf(task.L);
  for (let i = 0; i < 12; i++) rnd(); // mélange de départ
  for (let i = 0; i < task.count; i++) yield lo + Math.floor(uniform(rnd) * size);
}

// ---------------------------------------------------------------- travail d'un cœur
if (!isMainThread) {
  const { pass, meta } = workerData;
  const engine = createEngine(meta, null);
  const index = new Map(engine.badges.map((b, i) => [b.id, i]));
  parentPort.on('message', task => {
    if (!task) { process.exit(0); }
    if (pass === 1) {
      // counts[L][badge] pour les nombres de ce morceau.
      const counts = {}, seen = {};
      let current = null, L0 = -1;
      for (const n of numbersOf(task)) {
        const L = String(n).length;
        if (L !== L0) { L0 = L; current = counts[L] || (counts[L] = new Array(engine.badges.length).fill(0)); seen[L] = seen[L] || 0; }
        seen[L]++;
        engine.scoreOf(n, b => { current[index.get(b.id)]++; });
      }
      parentPort.postMessage({ counts, seen });
    } else {
      // Histogramme pondéré des totaux (poids = taille de la longueur / nombres évalués de cette longueur).
      // earnedW / countedW : poids des tirages où chaque badge est obtenu, et où il compte (seul le meilleur d'une famille
      // compte) ; servent à l'XP moyenne attendue (voir main).
      const hist = new Map(), earnedW = new Float64Array(engine.badges.length), countedW = new Float64Array(engine.badges.length);
      let sumT = 0, weight = 0;
      for (const n of numbersOf(task)) {
        const L = String(n).length, w = task.kind === 'range' ? 1 : sizeOf(L) / SAMPLES[L];
        const got = [];
        const t = engine.scoreOf(n, b => got.push(b)), b = bucketOf(t);
        const best = new Map();
        for (const x of got) { earnedW[index.get(x.id)] += w; if (!x.family) countedW[index.get(x.id)] += w; else if (!best.has(x.family) || x.score > best.get(x.family).score) best.set(x.family, x); }
        for (const x of best.values()) countedW[index.get(x.id)] += w;
        hist.set(b, (hist.get(b) || 0) + w);
        sumT += t * w; weight += w;
      }
      parentPort.postMessage({ hist: [...hist], sumT, weight, earnedW: [...earnedW], countedW: [...countedW] });
    }
  });
} else {
  await main();
}

// Lance une passe sur tous les cœurs ; onResult reçoit chaque morceau terminé.
function runPass(pass, meta, onResult) {
  const list = tasks(), threads = Math.max(1, os.cpus().length);
  let next = 0, done = 0;
  const started = Date.now(), workers = [];
  return new Promise((resolve, reject) => {
    for (let w = 0; w < threads; w++) {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { pass, meta } });
      workers.push(worker);
      const feed = () => { if (next < list.length) worker.postMessage(list[next++]); else worker.postMessage(null); };
      worker.on('message', r => {
        onResult(r); done++;
        if (done % 10 === 0 || done === list.length) {
          const s = (Date.now() - started) / 1000;
          process.stdout.write(`\r  passe ${pass} : ${done}/${list.length} morceaux · ${Math.round(s)} s · reste ≈ ${Math.round((s / done) * (list.length - done))} s   `);
        }
        if (done === list.length) { process.stdout.write('\n'); for (const x of workers) x.terminate(); resolve(); } // sinon le dernier cœur garde le programme ouvert
        else feed();
      });
      worker.on('error', reject);
      feed();
    }
  });
}

async function main() {
  const NORMAL_META = require(path.join(ROOT, 'data/badge-meta.json'));
  const HARD_ONLY = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/source/hard.json'), 'utf8'));
  for (const b of HARD_ONLY) if (NORMAL_META.some(x => x.id === b.id)) throw new Error(`Badge du mode difficile déjà en mode normal : ${b.id}`);
  const META = [...NORMAL_META, ...HARD_ONLY.map(b => ({ id: b.id, label: b.label, desc: b.desc, emoji: b.emoji, score: 1, family: b.family || null, hard: true }))];
  console.log(`Mode difficile : ${META.length} badges (${HARD_ONLY.length} du mode difficile seulement), ${os.cpus().length} cœurs`);
  const exact = {};
  { const engine = createEngine(META, null);
    for (const [id, parts] of Object.entries(PARTS)) {
      if (!engine.byId.has(id)) throw new Error(`PARTS : badge inconnu ${id}`);
      exact[id] = exactCounts(engine, id, parts);
    }
    console.log('  comptes exacts (8, 9, 10 chiffres) :', Object.entries(exact).map(([id, c]) => `${id} ${c[8]}/${c[9]}/${c[10]}`).join(' · ')); }

  // ---- passe 1 : fréquences
  const nB = META.length, byL = {}, seenL = {};
  await runPass(1, META, ({ counts, seen }) => {
    for (const [L, arr] of Object.entries(counts)) { const acc = byL[L] || (byL[L] = new Array(nB).fill(0)); arr.forEach((x, i) => { acc[i] += x; }); }
    for (const [L, x] of Object.entries(seen)) seenL[L] = (seenL[L] || 0) + x;
  });
  const estimated = [];
  const totals = META.map((b, i) => {
    let total = 0;
    for (let L = 1; L <= 10; L++) {
      const hits = (byL[L] || [])[i] || 0;
      if (L <= EXACT_MAX_L) { total += hits; continue; }
      if (exact[b.id]) { total += exact[b.id][L]; continue; }
      const sampled = hits * sizeOf(L) / seenL[L];
      if (hits >= MIN_HITS) { total += sampled; continue; }
      // Trop rare pour l'échantillon : prolongé depuis les longueurs exactes (croissance de 6 à 7 chiffres, au plus × 10).
      const c6 = byL[6][i], c7 = byL[7][i];
      // Jamais moins que ce que l'échantillon a vu : une fréquence sous-estimée gonflerait l'XP.
      const extra = Math.max(sampled, c6 > 0 && c7 > 0 ? c7 * Math.min(10, c7 / c6) ** (L - 7) : 0);
      estimated.push(`${b.id}@${L}:${hits}→${Math.round(extra)}`);
      total += Math.min(extra, sizeOf(L));
    }
    return total;
  });
  const HARD_META = META.map((b, i) => ({ ...b, score: Math.max(1, Math.round((100 * SPAN) / Math.max(1, totals[i]))) }));
  console.log(`  ${estimated.length} fréquences prolongées (badge@longueur:vus→estimés), par exemple ${estimated.slice(0, 6).join(' ')}`);

  // ---- passe 2 : totaux avec les XP du mode difficile
  const hist = new Map(), earnedW = new Array(nB).fill(0), countedW = new Array(nB).fill(0);
  let sumT = 0, weight = 0;
  await runPass(2, HARD_META, r => { for (const [b, w] of r.hist) hist.set(b, (hist.get(b) || 0) + w); sumT += r.sumT; weight += r.weight; r.earnedW.forEach((x, i) => { earnedW[i] += x; }); r.countedW.forEach((x, i) => { countedW[i] += x; }); });
  const buckets = [...hist.keys()].sort((a, b) => a - b);
  const table = [];
  let below = 0, lastPct = -1, lastKey = -1, median = 0, pctSum = 0;
  for (const b of buckets) {
    const w = hist.get(b), key = keyOf(b), pct = (100 * below) / weight;
    if (!median && below + w >= weight / 2) median = key;
    if (key !== lastKey && (table.length === 0 || pct >= 99 || pct < 0.1 || pct - lastPct >= 0.01)) { table.push([key, Math.round(pct * 1e6) / 1e6]); lastPct = pct; lastKey = key; }
    pctSum += w * pct;
    below += w;
  }
  // Même XP moyenne que le mode normal (l'XP et le niveau sont communs aux deux modes) : la règle de fréquence la donne
  // presque (40 401 contre 36 104 à l'essai : les familles de badges et les fréquences prolongées l'écartent un peu) ;
  // toutes les valeurs et les seuils de la table sont multipliés par le même facteur, les raretés ne bougent pas.
  // La moyenne de l'échantillon ne suffit pas : un badge très rare (des milliards d'XP) n'y apparaît presque jamais, et la
  // moyenne en dépend beaucoup. Chaque badge rapporte en moyenne score × fréquence ≈ 100 XP, multipliés par la part des
  // tirages où il compte vraiment (q, mesurée sur l'échantillon ; 1 pour un badge jamais vu, toujours le meilleur de sa
  // famille). XP attendue = Σ score × fréquence × q.
  const normalMean = Number((fs.readFileSync(path.join(ROOT, 'js/percentiles.js'), 'utf8').match(/SCORE_STATS = \{"mean":([\d.]+)/) || [])[1]);
  const expected = HARD_META.reduce((x, b, i) => x + b.score * (totals[i] / SPAN) * (earnedW[i] > 0 ? countedW[i] / earnedW[i] : 1), 0);
  console.log(`  XP moyenne : échantillon ${Math.round(sumT / weight)}, attendue ${Math.round(expected)}`);
  const f = normalMean > 0 ? normalMean / expected : 1;
  for (const b of HARD_META) b.score = Math.max(1, Math.round(b.score * f));
  for (const row of table) row[0] = Math.round(row[0] * f);
  for (let i = 1; i < table.length; i++) if (table[i][0] <= table[i - 1][0]) table[i][0] = table[i - 1][0] + 1;
  sumT *= f; median = Math.round(median * f);
  console.log(`  XP moyenne ramenée à celle du mode normal (${Math.round(normalMean)}) : facteur ${f.toFixed(4)}`);
  const engine = createEngine(HARD_META, table, { hard: true });
  const tierOdds = Object.fromEntries(TIER_ORDER.map(t => [t, 0]));
  for (const b of buckets) tierOdds[engine.cardTier(Math.round(keyOf(b) * f))] += hist.get(b) / weight;
  const avg = sumT / weight;
  console.log('  Probabilité par rareté :', Object.fromEntries(Object.entries(tierOdds).map(([k, v]) => [k, `${(v * 100).toPrecision(3)}%`])));
  console.log(`  XP moyen ${Math.round(avg)} · médian ${median} · table ${table.length} entrées · ${Math.round(weight).toLocaleString('en-US')} tirages pesés`);

  const badgeOdds = Object.fromEntries(HARD_META.map((b, i) => [b.id, totals[i] / SPAN]));
  // Chiffres d'un tirage uniforme entre 0 et 9 999 999 999 (sans zéros de tête), par longueur.
  const digitCounts = new Array(10).fill(0);
  let digitTotal = 0;
  for (let L = 1; L <= 10; L++) {
    const size = sizeOf(L);
    if (L === 1) { for (let d = 0; d < 10; d++) digitCounts[d]++; digitTotal += 10; continue; }
    // premier chiffre : 1-9 à parts égales ; les autres : 0-9 à parts égales
    for (let d = 1; d < 10; d++) digitCounts[d] += size / 9;
    for (let d = 0; d < 10; d++) digitCounts[d] += (size * (L - 1)) / 10;
    digitTotal += size * L;
  }
  const digitOdds = digitCounts.map(x => x / digitTotal);
  const stats = { mean: avg, median, meanPct: pctSum / weight };

  if (QUICK) { console.log('Essai rapide : rien écrit.'); return; }
  fs.writeFileSync(path.join(ROOT, 'data/hard-meta.json'), JSON.stringify(HARD_META));
  fs.writeFileSync(path.join(ROOT, 'data/hard-percentiles.json'), JSON.stringify(table));
  fs.writeFileSync(path.join(ROOT, 'data/hard-odds.json'), JSON.stringify({ badges: Object.fromEntries(HARD_META.map((b, i) => [b.id, Math.round(totals[i])])), tiers: tierOdds, stats }));
  fs.writeFileSync(path.join(ROOT, 'js/hard-data.js'),
    '// Généré par tools/build-hard.mjs — ne pas éditer. Chargé quand le joueur passe en mode difficile.\n' +
    'window.HARD_DATA = ' + JSON.stringify({ meta: HARD_META, odds: badgeOdds, percentiles: table, tiers: tierOdds, stats, digits: digitOdds }) + ';\n');
  console.log('Écrit : data/hard-meta.json, data/hard-percentiles.json, data/hard-odds.json, js/hard-data.js');
}
