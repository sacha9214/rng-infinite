// Poker du casino : le bot (api/_holdem.js) contre des stratégies écrites à l'avance, des milliers de matchs chacune.
// Demandé par Sacha (2026-11-03) avec la table de poker : la maison doit garder l'avantage contre toutes. Chaque
// stratégie ne voit que ce qu'un joueur voit (ses cartes, le tableau, les mises) ; le bot ne voit jamais ses cartes.
// Un match = les deux tapis à la cave choisie, des mains jusqu'à ce que l'un soit ruiné (ou 200 mains, puis on encaisse).
//   node tools/poker-sim.mjs                 → 4 000 matchs par stratégie, cave de 1 000 (blinds 10/20)
//   node tools/poker-sim.mjs 2000 100        → 2 000 matchs, cave de 100 (blinds 1/2 : commission arrondie)
//   node tools/poker-sim.mjs 4000 1000 mirror → seulement les stratégies dont le nom contient « mirror »
// Résultat : gain moyen du joueur par main (pièces et grosses blinds pour 100 mains) et par match, avec l'intervalle à
// 95 %. Tous doivent être négatifs : la dernière ligne dit « la maison gagne contre toutes les stratégies » ou non.
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = require(path.join(ROOT, 'api/_holdem.js'));
// Essai de réglages du bot sans toucher au fichier : POKER_TUNE='{"bluffFlop":0.3}' node tools/poker-sim.mjs …
if (process.env.POKER_TUNE) Object.assign(H.P, JSON.parse(process.env.POKER_TUNE));

// Générateur rapide et reproductible (sfc32) : la simulation n'a pas besoin de crypto, et le même germe redonne les mêmes matchs.
function sfc32(a, b, c, d) {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0; d = (d + 1) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- stratégies du joueur
// v = H.botView(t, siège du joueur) : exactement ce que le site montre au joueur. Renvoie { move, to }.
const potRaise = (v, frac = 1) => Math.max(v.minTo, Math.min(v.maxTo, Math.round(v.cur + frac * (v.pot + v.toCall))));
const eq = (v, rng, n = 300) => H.equity(v.hole, v.board, n, rng);
const STRATEGIES = {
  // Suit tout, ne relance jamais, ne se couche jamais.
  'always call': () => ({ move: 'call' }),
  // Tapis à chaque coup.
  'always all-in': () => ({ move: 'allin' }),
  // Relance la taille du pot à chaque occasion, suit sinon.
  'always raise pot': v => (v.canRaise ? { move: 'raise', to: potRaise(v) } : { move: 'call' }),
  // Relance le minimum à chaque occasion (met la pression pour pas cher).
  'always min-raise': v => (v.canRaise ? { move: 'raise', to: v.minTo } : { move: 'call' }),
  // Serré-agressif : ses chances contre une main au hasard ; relance fort ses bonnes mains, suit au prix juste, jette le reste.
  'tight-aggressive (equity)': (v, rng) => {
    const e = eq(v, rng), odds = v.toCall / (v.pot + v.toCall);
    if (v.street === 0) {
      if (e > 0.62 && v.canRaise) return { move: 'raise', to: potRaise(v, 1) };
      if (v.toCall === 0) return { move: 'check' };
      return e > 0.5 || (v.toCall <= v.bb / 2 && e > 0.45) ? { move: 'call' } : { move: 'fold' };
    }
    if (e > 0.78 && v.canRaise) return { move: 'raise', to: potRaise(v, 0.8) };
    if (v.toCall === 0) return e > 0.6 && v.canRaise ? { move: 'raise', to: potRaise(v, 0.6) } : { move: 'check' };
    return e > odds + 0.05 ? { move: 'call' } : { move: 'fold' };
  },
  // Cote du pot : suit si ses chances dépassent le prix, mise la moitié du pot avec une bonne main, ne relance jamais une mise.
  'pot odds': (v, rng) => {
    const e = eq(v, rng), odds = v.toCall / (v.pot + v.toCall);
    if (v.toCall === 0) return e > 0.6 && v.canRaise ? { move: 'raise', to: potRaise(v, 0.5) } : { move: 'check' };
    return e >= odds ? { move: 'call' } : { move: 'fold' };
  },
  // Exploite les abandons du bot : dès qu'il parle (check), mise le pot ; relance chaque mise du bot quand il a un
  // minimum de chances, sinon se couche ; relance toujours avant le flop.
  'exploit bot folds': (v, rng) => {
    if (v.street === 0) return v.canRaise ? { move: 'raise', to: potRaise(v, 1) } : { move: 'call' };
    if (v.toCall === 0) return v.canRaise ? { move: 'raise', to: potRaise(v, 1) } : { move: 'check' };
    const e = eq(v, rng, 200);
    if (e > 0.35 && v.canRaise) return { move: 'raise', to: potRaise(v, 1) };
    return e > v.toCall / (v.pot + v.toCall) ? { move: 'call' } : { move: 'fold' };
  },
  // Piège : parle (check) toujours, puis relance gros quand le bot mise (bluff ou pas), suit au prix juste ensuite.
  'check-raise trap': (v, rng) => {
    if (v.toCall === 0) return { move: 'check' };
    const e = eq(v, rng, 200);
    if (v.canRaise && (e > 0.55 || rng() < 0.4) && v.voluntary) return { move: 'raise', to: potRaise(v, 1.2) };
    return e > v.toCall / (v.pot + v.toCall) ? { move: 'call' } : { move: 'fold' };
  },
  // Très serré : tapis avec les 12 % meilleures mains de départ, se couche avec tout le reste.
  'nit (top 12% all-in)': v => {
    if (v.street === 0) return H.chen(v.hole[0], v.hole[1]) >= 9 ? { move: 'allin' } : v.toCall === 0 ? { move: 'check' } : { move: 'fold' };
    return { move: 'allin' };
  },
  // Le bot contre lui-même (mêmes règles, même information, il observe le bot comme le bot l'observe) : ne devrait
  // perdre que la commission.
  'mirror (bot strategy)': (v, rng, m) => H.decide(v, m, rng),
  // La stratégie du bot, en plus agressive : quand elle parlerait, elle mise 60 % du pot deux fois sur cinq.
  'mirror + extra bluffs': (v, rng, m) => {
    const d = H.decide(v, m, rng);
    if (d.move === 'check' && v.canRaise && rng() < 0.4) return { move: 'raise', to: potRaise(v, 0.6) };
    return d;
  },
  // Les mêmes bluffs, seulement avant le flop (relance quand il a le droit de parler), ou seulement après.
  'mirror + preflop raises': (v, rng, m) => {
    const d = H.decide(v, m, rng);
    if (v.street === 0 && d.move === 'check' && v.canRaise && rng() < 0.4) return { move: 'raise', to: potRaise(v, 0.6) };
    return d;
  },
  'mirror + postflop stabs': (v, rng, m) => {
    const d = H.decide(v, m, rng);
    if (v.street > 0 && d.move === 'check' && v.canRaise && rng() < 0.4) return { move: 'raise', to: potRaise(v, 0.6) };
    return d;
  },
  // La stratégie du bot, mais ne se couche jamais face à une mise du bot après le flop (contre ses bluffs).
  'mirror + calls bot bluffs': (v, rng, m) => {
    const d = H.decide(v, m, rng);
    return d.move === 'fold' && v.street > 0 ? { move: 'call' } : d;
  },
  // Au hasard parmi les coups permis.
  'random': (v, rng) => { const r = rng(); return r < 0.25 ? { move: 'fold' } : r < 0.6 ? { move: 'call' } : r < 0.9 && v.canRaise ? { move: 'raise', to: v.minTo + Math.floor(rng() * (v.maxTo - v.minTo + 1)) } : r >= 0.9 ? { move: 'allin' } : { move: 'call' }; },
};

// ---------------------------------------------------------------- un match
function match(strategy, buyin, rng, maxHands = 200) {
  const sb = Math.max(1, Math.round(buyin / 100)), bb = 2 * sb;
  const t = { sb, bb, btn: rng() < 0.5 ? 0 : 1, seats: [{ stack: buyin }, { stack: buyin }], hand: null };
  const botModel = H.newModel(), mirrorModel = H.newModel();
  const rnd = n => Math.floor(rng() * n);
  let hands = 0, rake = 0;
  // Joueur = siège 0, bot = siège 1.
  while (hands < maxHands && t.seats[0].stack > 0 && t.seats[1].stack > 0) {
    H.newHand(t, rnd); hands++;
    for (let guard = 0; !t.hand.done && guard < 100; guard++) {
      const i = t.hand.turn;
      if (i === 1) { const d = H.botMove(t, 1, botModel, rng); H.observe(mirrorModel, t, 1, d.move); H.act(t, 1, d.move, d.to); continue; }
      const v = H.botView(t, 0);
      let d = strategy(v, rng, mirrorModel);
      // Un coup impossible devient le plus proche permis (comme le ferait le site : il n'offre que les coups permis).
      if (d.move === 'raise' && !v.canRaise) d = { move: 'call' };
      if (d.move === 'check' && !v.canCheck) d = { move: 'fold' };
      H.observe(botModel, t, 0, d.move);
      H.act(t, 0, d.move, d.to);
    }
    rake += t.hand.res.rake;
  }
  return { net: t.seats[0].stack - buyin, hands, rake, botNet: t.seats[1].stack - buyin };
}

// Un lot de matchs pour une stratégie : renvoie le gain de chaque match (pour l'intervalle de confiance).
function runChunk(name, matches, buyin, seed) {
  const rng = sfc32(seed, seed * 7 + 1, seed * 13 + 5, seed * 31 + 11);
  for (let k = 0; k < 20; k++) rng();
  const nets = [];
  let hands = 0, rake = 0;
  for (let m = 0; m < matches; m++) { const r = match(STRATEGIES[name], buyin, rng); nets.push(r.net); hands += r.hands; rake += r.rake; }
  return { name, nets, hands, rake };
}

if (!isMainThread) {
  const { name, matches, buyin, seed } = workerData;
  parentPort.postMessage(runChunk(name, matches, buyin, seed));
} else {
  const matches = Number(process.argv[2]) || 4000, buyin = Number(process.argv[3]) || 1000, bb = 2 * Math.max(1, Math.round(buyin / 100));
  // 3e argument facultatif : ne jouer que les stratégies dont le nom contient ce texte (pour régler le bot).
  const names = Object.keys(STRATEGIES).filter(n => !process.argv[4] || n.includes(process.argv[4]));
  const t0 = Date.now();
  console.log(`Poker : le bot contre ${names.length} stratégies, ${matches} matchs chacune, cave ${buyin} (blinds ${bb / 2}/${bb}), commission ${H.RAKE * 100} %`);
  // Lots de 100 matchs, chacun avec son germe, répartis sur tous les cœurs sauf un.
  const CHUNK = 100, jobs = [];
  names.forEach((name, k) => { for (let done = 0, c = 0; done < matches; done += CHUNK, c++) jobs.push({ name, matches: Math.min(CHUNK, matches - done), buyin, seed: 1000 + k * 7919 + c * 104729 }); });
  const pool = Math.max(1, Math.min(jobs.length, os.cpus().length - 1));
  const acc = Object.fromEntries(names.map(n => [n, { name: n, nets: [], hands: 0, rake: 0 }]));
  let next = 0;
  await new Promise(done => {
    let running = 0;
    const launch = () => {
      if (next >= jobs.length) { if (!running) done(); return; }
      const job = jobs[next++]; running++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: job });
      w.on('message', r => { const a = acc[r.name]; a.nets.push(...r.nets); a.hands += r.hands; a.rake += r.rake; });
      w.on('error', err => { console.error(job.name, err); process.exitCode = 1; });
      w.on('exit', () => { running--; launch(); });
    };
    for (let k = 0; k < pool; k++) launch();
  });
  const results = names.map(n => {
    const a = acc[n], net = a.nets.reduce((x, v) => x + v, 0), mean = net / a.nets.length;
    const sd = Math.sqrt(a.nets.reduce((x, v) => x + (v - mean) ** 2, 0) / Math.max(1, a.nets.length - 1));
    return { ...a, net, mean, ci: 1.96 * sd / Math.sqrt(a.nets.length) };
  });
  const f = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
  console.log('');
  console.log('stratégie du joueur'.padEnd(28) + 'mains'.padStart(9) + 'par main'.padStart(11) + 'bb/100'.padStart(10) + 'par match'.padStart(12) + '± 95 %'.padStart(10) + '  % cave' + '  commission/main');
  let allLose = true;
  for (const r of results) {
    const perHand = r.net / r.hands, lose = r.mean + r.ci < 0;
    if (!lose) allLose = false;
    console.log(r.name.padEnd(28) + String(r.hands).padStart(9) + f(perHand).padStart(11) + f(perHand / bb * 100, 1).padStart(10) + f(r.mean, 1).padStart(12) + r.ci.toFixed(1).padStart(10) + f(r.mean / buyin * 100, 1).padStart(7) + '%' + (r.rake / r.hands).toFixed(2).padStart(10) + (lose ? '' : '   ← ne perd pas à coup sûr'));
  }
  console.log(`\n${allLose ? 'OK — la maison gagne contre toutes les stratégies' : 'ÉCHEC — au moins une stratégie ne perd pas'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  if (!allLose) process.exitCode = 1;
}
