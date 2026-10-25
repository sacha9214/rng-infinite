/* RNG∞ — sons du tirage, joués en direct par le navigateur (Web Audio). Aucun fichier audio : chaque son est calculé
 * par js/synth.js, avec les instruments et les niveaux de la bande-son du trailer (tools/trailer-audio.mjs).
 *   Sound.play(type, options)    un évènement du jeu (voir RECIPES)
 *   Sound.tick(), Sound.badge()  les deux qui reviennent en rafale
 *   Sound.stop()                 fait taire ce qui sonne (tirage annulé)
 *   Sound.enable(oui)            le réglage du joueur
 *   Sound.unlock()               à appeler pendant un geste du joueur : certains navigateurs n'ouvrent le son qu'à ce moment-là
 *   Sound.warm(liste)            fabrique des sons à l'avance, quand le navigateur n'a rien à faire
 * La chaîne est celle du trailer : chaque son est d'abord adouci (finish), puis part vers la sortie à son niveau, et une
 * part va dans la réverbération. Celle-ci est la réponse impulsionnelle de reverb(), rejouée par un ConvolverNode : le
 * résultat est le même que le mixage hors ligne du film.
 * Le son ne doit jamais casser le jeu : tout ce qui peut échouer ici échoue en silence.
 */
(function (root) {
  'use strict';

  if (!root.RNGSynth) return; // js/synth.js n'est pas arrivé : pas de Sound, le jeu reste muet
  const AC = root.AudioContext || root.webkitAudioContext;
  const RATE = 48000; // débit auquel les sons sont calculés, comme pour le trailer
  const LEVEL = .7;   // niveau général : le son le plus fort (un Mythic) culmine à −1 dB, sans limiteur
  const REVERB = 2.4; // retour de la réverbération, comme dans le trailer
  const TAIL = 2.5;   // secondes de réverbération gardées (ce qui reste après est 100 dB plus bas)
  const RISER = .83;  // durée de la montée avant le dernier chiffre
  const S = root.RNGSynth.create(RATE);

  // ---------------------------------------------------------------- ce que joue chaque évènement
  // Une voix : [son, retard en secondes, niveau, gauche/droite (−1 à 1), part envoyée en réverbération].
  const thud = () => S.gain(S.boom(.6, 100, 50), .6);
  const ring = (n, g) => S.gain(S.bell(S.note(n), .5), g);
  const arpeggio = (level, dt = 0) => [5, 7, 8].map((n, i) => [S.bell(S.note(n), .7, .8), dt + i * .07, level, 0, .45]);
  // ---- Pêche (collab Canne & Dauphins) : des sons 8-bit, comme une vieille console. Ondes carrées (le rapport cyclique
  // donne le grain), bruit « échantillonné-bloqué » pour les éclaboussures, et des glissés de hauteur. Courts et secs.
  const chip = (f0, f1, dur, duty = .5, curve = 3) => {
    const n = Math.round(dur * RATE), o = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n, f = f0 * Math.pow(f1 / f0, u); // glissé exponentiel
      ph += f / RATE; ph -= Math.floor(ph);
      const env = Math.min(1, i / (.004 * RATE)) * Math.pow(1 - u, curve);
      o[i] = (ph < duty ? 1 : -1) * env;
    }
    return o;
  };
  // Bruit à la manière des consoles : une valeur au hasard tenue pendant quelques échantillons (plus elle est tenue, plus
  // le bruit est grave). La tenue s'allonge au fil du son : l'éclaboussure part aiguë et retombe.
  const crunch = (dur, hold0, hold1, curve = 2) => {
    const n = Math.round(dur * RATE), o = new Float32Array(n);
    let v = 0, left = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      if (left-- <= 0) { v = Math.random() * 2 - 1; left = Math.round(hold0 + (hold1 - hold0) * u); }
      o[i] = v * Math.min(1, i / (.003 * RATE)) * Math.pow(1 - u, curve);
    }
    return o;
  };
  const tune = (notes, step, duty = .25) => notes.map((f, i) => [chip(f, f, step * 1.6, duty, 1.5), i * step]);
  // ---- Pack ASMR (idée de JAKECisthebest, 2026-10-20). Craquement de cire : une rafale de petits grains de bruit filtré,
  // serrés au début puis espacés (la croûte cède, puis quelques miettes), sur un « pouf » grave et mou.
  const wax = (seed, n = 14, len = .14, f = 1800) => {
    let r = seed;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const grains = [];
    for (let g = 0; g < n; g++) {
      const at = len * Math.pow(g / n, 1.7), lvl = .5 + .5 * rand();
      grains.push(S.delayed(S.gain(S.shape(S.filter(S.noise(.02, seed + g), 'bp', f * (.7 + .6 * rand()), 1.4), S.expo(.003 + .004 * rand(), .0004)), lvl), at));
    }
    const squish = S.osc(.16, t => 130 - 60 * t / .16, S.expo(.045, .006));
    return S.sum(...grains, S.gain(squish, .5));
  };
  // Craquement plus naturel pour le skin ASMR (JAKECisthebest, 2026-10-22 : « plus naturel, comme dans les vidéos ASMR »).
  // Un vrai craquement n'a pas de note : ce sont des dizaines de micro-cassures de hauteur et de force très variées, à des
  // instants irréguliers (serrées quand la croûte cède, puis des miettes), plus le froissement sourd de la matière pressée.
  const crackle = (seed, n = 30, len = .2) => {
    let r = seed * 7919 + 13;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const grains = [];
    let at = 0;
    for (let g = 0; g < n && at < len; g++) {
      const snap = rand() < .18, d = snap ? .006 + .006 * rand() : .002 + .004 * rand();
      const f = snap ? 1500 + 2500 * rand() : 2500 + 5500 * rand();
      grains.push(S.delayed(S.gain(S.shape(S.filter(S.noise(d + .004, seed * 31 + g), 'bp', f, .8 + .6 * rand()), S.expo(d * .5, .0002)), snap ? .8 + .4 * rand() : .2 + .45 * rand()), at));
      at += (.002 + .02 * rand()) * (1 + 3 * at / len); // de plus en plus espacées
    }
    const press = S.shape(S.filter(S.noise(.12, seed + 500), 'lp', 520), S.expo(.035, .004));
    return S.sum(...grains, S.gain(press, .55));
  };
  // Tintement de verre (skin Lab) : un tube à essai heurte le portoir. Trois partiels aigus inharmoniques qui s'éteignent
  // vite (un tube de verre sonne comme une petite barre libre) et un « tic » de contact très court. k fait varier la hauteur.
  const clink = (k, big = 0) => {
    const f = 1900 * Math.pow(2, ((k * 5) % 7) / 12) * (big ? .9 : 1);
    const parts = [[1, 1, .09 + .05 * big], [2.76, .5, .045 + .02 * big], [5.4, .22, .022]].map(([m, a, d]) => S.gain(S.osc(d * 5, () => f * m, S.expo(d, .0008)), a));
    const tap = S.shape(S.filter(S.noise(.015, 70 + k), 'hp', 3500), S.expo(.0018, .0002));
    return S.sum(...parts, S.gain(tap, .45));
  };
  // Thock : touche lubrifiée, un coup grave et mat (le bas de course) suivi du retour, plus discret.
  const thock = () => {
    const body = S.sum(S.osc(.12, t => 180 - 70 * Math.exp(-t / .02), S.expo(.03, .001)), S.gain(S.shape(S.filter(S.noise(.03, 7), 'bp', 700, 1.6), S.expo(.006, .0005)), .7));
    const back = S.gain(S.shape(S.filter(S.noise(.02, 8), 'bp', 1100, 1.6), S.expo(.004, .0005)), .35);
    return S.sum(body, S.delayed(back, .07));
  };
  // ---- Packs de sons du tirage (idée d'Angelicide9, 2026-10-21 ; achetés dans la boutique, js/shop.js SOUNDS).
  // Chaque pack donne sa note à chaque chiffre (même place dans la gamme : la montée reste) et son propre son de rareté.
  // La rareté garde son escalade : un coup sec pour un raté, puis une, deux, trois notes ; à partir d'Epic, l'impact
  // d'origine reste dessous (le poids du moment) et le pack ajoute sa gerbe par-dessus.
  // Cymbale (pack Drums) : bruit très aigu adouci par finish, long et clair, avec un « ping » métallique inharmonique.
  const cymbal = (len, seed) => S.sum(
    S.shape(S.filter(S.noise(len, seed), 'hp', 5200, .6), S.expo(len * .28, .002)),
    S.gain(S.shape(S.filter(S.noise(len * .6, seed + 1), 'bp', 3300, 3), S.expo(len * .12, .002)), .6),
    ...[[587, .25], [829, .18], [1243, .12]].map(([f, a]) => S.gain(S.osc(len * .5, () => f, S.expo(len * .15, .002)), a)));
  // Tom (pack Drums) : la note qui s'écrase un peu vers le bas, et la peau frappée.
  const tom = f => S.sum(S.osc(.4, t => f * (1 + .5 * Math.exp(-t / .025)), S.expo(.11, .001)),
    S.gain(S.shape(S.filter(S.noise(.04, Math.round(f)), 'bp', 1800, 1), S.expo(.008, .0005)), .5));
  // Pièce (pack Coins) : deux partiels aigus inharmoniques, un tintement court ; deux rebonds sur le comptoir.
  const coin = (k, big = 0) => {
    const f = 2350 * Math.pow(2, ((k * 2) % 5) / 12);
    const ding = d => S.sum(...[[1, 1], [1.47, .55], [2.1, .25]].map(([m, a]) => S.gain(S.osc(d * 5, () => f * m, S.expo(d * (1.3 - m * .25), .0006)), a)));
    return S.sum(ding(.08 + .08 * big), S.delayed(S.gain(ding(.03), .35), .055), S.delayed(S.gain(ding(.02), .15), .095));
  };
  // Zap doux (pack Space) : une note qui glisse depuis l'octave du dessus, triangle filtrée, avec un léger vibrato.
  const zap = (f, len = .32) => S.filter(S.osc(len, t => f * (1 + Math.exp(-t / .035)) * (1 + .012 * Math.sin(t * 38)), S.expo(len * .3, .004), ph => (2 / Math.PI) * Math.asin(Math.sin(ph))), 'lp', 2400);
  // Carillon (pack Glass) : cloche de cristal, la note deux octaves plus haut, partiels clairs et longs.
  const crystal = (f, d = .6) => S.sum(S.bell(f, d, 2.2), S.gain(S.osc(d * 3, () => f * 4.2, S.expo(d * .18, .001)), .12));
  const PACKS = {
    arcade: {
      lock: (i, final) => final ? S.sum(chip(S.note(i + 5), S.note(i + 5), .07, .25, 1.2), S.delayed(chip(S.note(i + 10), S.note(i + 10), .12, .25, 1.5), .07)) : chip(S.note(i + 5), S.note(i + 5), .09, .25, 1.6),
      level: .25,
      note: (n, len) => chip(S.note(n + 5), S.note(n + 5), len, .25, 1.4),
      miss: () => S.sum(chip(330, 82, .35, .5, 1.2), S.gain(crunch(.12, 8, 30, 2), .5)), missLevel: .13,
    },
    glass: {
      lock: (i, final) => crystal(S.note(i + 10), final ? 1 : .5),
      level: .3,
      note: (n, len) => crystal(S.note(n + 10), Math.max(.6, len * 6)),
      miss: () => S.sum(S.gain(thud(), .9), S.gain(crystal(S.note(7), .35), .5)), missLevel: .2,
    },
    drums: {
      lock: (i, final) => final ? S.sum(tom(S.note(i) * .5), S.gain(cymbal(.5, 40 + i), .35)) : tom(S.note(i) * .5),
      level: .42, tierGain: .5, // la cymbale porte loin : la gerbe plus bas
      note: (n, len) => S.sum(tom(S.note(n) * .5), S.gain(cymbal(Math.max(.8, len * 8), 50 + n), .5)),
      miss: () => S.sum(S.gain(S.boom(.5, 90, 45), .8), S.gain(S.shape(S.filter(S.noise(.15, 9), 'bp', 400, .8), S.expo(.04, .001)), .5)), missLevel: .22,
    },
    space: {
      lock: (i, final) => zap(S.note(i + 5), final ? .5 : .3),
      level: .4,
      note: (n, len) => zap(S.note(n + 5), Math.max(.45, len * 4)),
      miss: () => S.osc(.6, t => 220 * Math.exp(-t / .25), S.expo(.18, .004), ph => (2 / Math.PI) * Math.asin(Math.sin(ph))), missLevel: .2,
    },
    coins: {
      lock: (i, final) => coin(i, final ? 1 : 0),
      level: .22,
      note: (n) => coin(n + 2, 1),
      miss: () => S.sum(S.gain(thud(), .8), S.delayed(S.gain(coin(0), .4), .02)), missLevel: .2,
    },
  };
  // Une gerbe de notes du pack, en montant (steps : leurs places dans la gamme).
  const flourish = (P, steps, level, dt = 0, gap = .08) => steps.map((n, k) => [P.note(n, gap), dt + k * gap, level * (P.tierGain || 1), ((k * 37) % 9) / 18 - .25, .4]);
  // Le son de rareté d'un pack, avec la même escalade que le son d'origine.
  function packTier(P, tier, classic) {
    if (tier === 'trash' || tier === 'garbage' || tier === 'landwaste') return [[P.miss(), 0, P.missLevel * (tier === 'trash' ? 1 : 1.3), 0, .2]];
    if (tier === 'common') return flourish(P, [3], P.level * 1.2);
    if (tier === 'uncommon') return flourish(P, [3, 5], P.level * 1.2);
    if (tier === 'rare') return flourish(P, [3, 5, 7, 8], P.level * 1.25);
    // Epic et au-dessus : l'impact d'origine (un peu plus bas), puis la gerbe du pack, plus longue avec la rareté.
    const big = { epic: [5, 7, 8, 10], anomaly: [5, 7, 8, 10, 12], mythic: [5, 7, 8, 10, 12, 13] }[tier] || [5, 7, 8, 10, 12, 13, 15];
    return classic.map(([x, dt, lvl, pan, wet]) => [x, dt, lvl * .85, pan, wet]).concat(flourish(P, big, P.level * .8, .12, .07));
  }
  const FISH = { cast: .14, splash: .2, reel: .05, mark: .07, catch: .13, bite: .26, snap: .16 };
  const RECIPES = {
    // Pêche. Lancer : la canne fouette (glissé qui descend) et le fil siffle.
    fishCast: () => [[chip(1400, 260, .22, .125, 2), 0, FISH.cast, .2, .05], [crunch(.18, 2, 6, 3), .02, FISH.cast * .5, .2, .05]],
    // Plouf : bruit qui retombe et petit « bloup » grave.
    fishSplash: () => [[crunch(.32, 3, 26, 2), 0, FISH.splash, .3, .08], [chip(420, 110, .16, .5, 2), 0, FISH.splash * .6, .3, .05]],
    // Un cran du moulinet (joué en rafale pendant la remontée) ; k varie la hauteur.
    fishReel: ({ k }) => [[chip(900 + (k % 3) * 120, 700, .025, .25, 1), 0, FISH.reel, -.1, 0]],
    // Le leurre passe un multiplicateur rond (2×, 3×, 5×, 10×…) : un « bip » qui monte avec la profondeur (step 0 à 7).
    fishMark: ({ step }) => [[chip(523 * Math.pow(2, step / 6), 523 * Math.pow(2, step / 6), .07, .5, 1.2), 0, FISH.mark, .2, .1]],
    // Prise : la petite fanfare, plus longue et plus aiguë pour un dauphin rose, encore plus pour un rouge.
    fishCatch: ({ kind }) => {
      const notes = kind === 'red' ? [523, 659, 784, 1047, 1319, 1568] : kind === 'pink' ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
      return tune(notes, .075).map(([b, dt]) => [b, dt, FISH.catch, 0, .12]);
    },
    // Le requin croque : un grave qui s'écrase et un craquement.
    fishBite: () => [[chip(190, 45, .38, .5, 1.5), 0, FISH.bite, 0, .1], [crunch(.22, 6, 40, 1.5), 0, FISH.bite * .8, 0, .08]],
    // Le fil casse : un « twang » aigu qui retombe.
    fishSnap: () => [[chip(1800, 220, .2, .125, 2.5), 0, FISH.snap, -.2, .06], [chip(3600, 3600, .012, .5, 1), 0, FISH.snap * .7, -.2, 0]],
    // Une bulle du fond Bulles ASMR éclate (idée de kingston) : un « pop » court qui monte, k : la variante (0 à 5).
    bubblePop: ({ k }) => [[S.osc(.07, t => (520 + k * 70) * (1 + 14 * t), S.expo(.03, .001)), 0, .3, (k % 5) / 5 - .4, .18]],
    // Le bouton Generate.
    // look : le bouton affiché ; les boutons du pack ASMR ont leur propre son, au même niveau que le clic habituel.
    click: ({ look } = {}) => {
      if (look === 'thock') return [[thock(), 0, .18, 0, .08]];
      if (look === 'wax' || look === 'asmr') return [[wax(41), 0, .24, 0, .1]];
      return [[S.tick(3, .6), 0, .25, 0, .1], [S.tick(4, .2), .05, .18, 0, .1]];
    },
    // Cliquetis des rouleaux (k : la variante). soft : en duel. last, de 1 à 8 : le dernier rouleau, de plus en plus grave et fort.
    tick: ({ k, soft, last }) => [[S.tick(100 + k, last ? .3 + .7 * last / 8 : 0), 0, soft ? .045 : last ? .08 + .09 * last / 8 : .07, ((k * 37) % 9) / 9 - .5, .08]],
    // Un chiffre se pose : une note par rouleau, en montant la gamme. soft : zéro de tête, ou duel. final : le dernier chiffre.
    // skin 'asmr' : la note garde sa place dans la gamme, plus douce, et la cire craque dessous (plus fort au dernier).
    // skin 'lab' : la note, plus douce, et le tube tinte contre le portoir (deux tintements au dernier, comme un « tchin »).
    // pack : le pack de sons acheté (PACKS) ; les skins ASMR et Lab gardent leur son, c'est leur identité (js/app.js).
    lock: ({ i, soft, final, skin, pack }) => PACKS[pack] && !skin
      ? [[PACKS[pack].lock(i, final), 0, PACKS[pack].level * (soft ? .5 : final ? 1.15 : 1), ((i * 37) % 9) / 18 - .25, .25]]
      : skin === 'asmr'
      ? [[S.lock(S.note(i), .3), 0, soft ? .08 : final ? .16 : .12, 0, .25], [crackle(90 + i, final ? 46 : 30, final ? .32 : .2), 0, soft ? .32 : final ? .8 : .65, ((i * 37) % 9) / 18 - .25, .12]]
      : skin === 'lab'
        ? [[S.lock(S.note(i), .35), 0, soft ? .16 : final ? .32 : .28, 0, .22], [clink(i, final ? 1 : 0), 0, soft ? .1 : final ? .26 : .2, ((i * 37) % 9) / 18 - .25, .35]].concat(final ? [[clink(i + 3, 1), .07, .16, .2, .4]] : [])
        : [[S.lock(S.note(i), soft ? .5 : final ? 1.2 : 1), 0, soft ? .2 : final ? .4 : .36, 0, .25]],
    // Montée de tension avant le dernier chiffre (plus discrète que dans le film : ici elle revient à chaque tirage).
    riser: () => [[S.riser(RISER), 0, .4, 0, .2]],
    // Un badge arrive : la note monte avec sa place dans la liste (step, de 0 à 3) ; le dernier, le plus rare, reçoit un grave en plus.
    badge: ({ step, last }) => {
      const f = S.note([3, 5, 7, 8][step]);
      const voices = [[S.bell(f, .55), 0, last ? .4 : .3, 0, .35], [S.shape(S.filter(S.noise(.06, 60 + step), 'lp', 900), S.expo(.012, .001)), 0, .5, 0, .1]];
      if (last) voices.push([S.sum(S.boom(.9, 90, 45), S.gain(S.bell(f * 1.5, .9), .3)), 0, .22, 0, .4]);
      return voices;
    },
    // La rareté se révèle : d'un coup sourd pour un tirage raté à l'impact du trailer pour un Mythic.
    tier: ({ tier, pack }) => {
      if (PACKS[pack]) return packTier(PACKS[pack], tier, RECIPES.tier({ tier }));
      // Au-dessus de Mythic : le même impact, suivi d'un, deux ou trois autres et d'une gerbe de cloches de plus en plus longue.
      if (tier === 'celestial') return [[S.impact('mythic'), 0, 1.1, 0, .5], [S.impact('gold'), .42, .7, .3, .6], ...arpeggio(.3, .8)];
      if (tier === 'divine') return [[S.impact('mythic'), 0, 1.1, 0, .5], [S.impact('gold'), .42, .75, -.3, .6], [S.impact('logo'), .9, .8, 0, .65], ...arpeggio(.3, 1.3), ...arpeggio(.22, 1.6)];
      if (tier === 'godlike') return [[S.impact('mythic'), 0, 1.1, 0, .5], [S.impact('gold'), .42, .75, -.3, .6], [S.impact('mythic'), .84, .8, .3, .6], [S.impact('logo'), 1.2, .85, 0, .68], ...arpeggio(.3, 1.5), ...arpeggio(.24, 1.85)];
      if (tier === 'infinite') return [[S.impact('mythic'), 0, 1.1, 0, .5], [S.impact('gold'), .42, .75, -.35, .6], [S.impact('mythic'), .84, .8, .35, .6], [S.impact('logo'), 1.3, .9, 0, .7], ...arpeggio(.3, 1.8), ...arpeggio(.26, 2.1), ...arpeggio(.2, 2.4)];
      if (tier === 'mythic') return [[S.impact('mythic'), 0, 1.1, 0, .5]];
      if (tier === 'anomaly') return [[S.impact('gold'), 0, .9, 0, .5]];
      if (tier === 'epic') return [[S.impact('epic'), 0, .75, 0, .45]];
      if (tier === 'trash' || tier === 'garbage' || tier === 'landwaste') return [[thud(), 0, tier === 'trash' ? .3 : .42, 0, .2]];
      if (tier === 'common') return [[S.sum(thud(), ring(3, .5)), 0, .3, 0, .35]];
      const both = [[S.sum(thud(), ring(3, .5), ring(5, .4)), 0, tier === 'rare' ? .5 : .4, 0, .35]];
      return tier === 'rare' ? both.concat(arpeggio(.2, .1)) : both;
    },
    // Duel : les raretés se révèlent, puis le gagnant. small : à trois joueurs ou plus.
    reveal: ({ small }) => [[S.sum(thud(), ring(3, .5), ring(5, .4)), 0, small ? .3 : .5, 0, .35]],
    win: ({ small }) => arpeggio(small ? .14 : .2),
  };

  // ---------------------------------------------------------------- fabrication
  const made = new Map(); // sons déjà fabriqués : clé → voix
  let impulse48 = null;   // réponse impulsionnelle de la réverbération à RATE, gauche et droite
  const padded = x => { const o = new Float32Array(x.length + Math.round(.04 * RATE)); o.set(x); return o; }; // la place de la traîne des filtres
  function voicesOf(type, o) {
    const key = type + JSON.stringify(o);
    let voices = made.get(key);
    if (!voices) {
      voices = RECIPES[type](o).map(([x, dt, level, pan, wet]) => ({ data: S.finish(padded(x)), buffer: null, dt, level, pan, wet }));
      made.set(key, voices);
    }
    return voices;
  }
  function impulseOf(synth) {
    const click = new Float32Array(Math.round(TAIL * synth.SR));
    click[0] = 1;
    return [synth.reverb(click, 0), synth.reverb(click, 23)]; // la droite est légèrement décalée de la gauche
  }

  // Ce dont un tirage ordinaire a besoin. Les trois raretés les plus hautes, longues à calculer, sont préparées quand elles sortent.
  const USUAL = [['click', {}]];
  for (let k = 0; k < 12; k++) USUAL.push(['tick', { k }]);
  for (let i = 0; i < 6; i++) USUAL.push(['lock', i < 5 ? { i } : { i, final: 1 }], ['lock', { i, soft: 1 }]);
  for (let last = 1; last <= 8; last++) USUAL.push(['tick', { k: 0, last }]);
  USUAL.push(['riser', {}]);
  for (let step = 0; step < 4; step++) USUAL.push(['badge', { step, last: false }]);
  USUAL.push(['badge', { step: 3, last: true }]);
  for (const tier of ['common', 'uncommon', 'rare', 'trash']) USUAL.push(['tier', { tier }]);

  let enabled = true;
  const queue = [];
  let warming = false;
  function warm(list = USUAL) {
    if (!enabled) return;
    queue.push(...list);
    if (warming) return;
    warming = true;
    const idle = root.requestIdleCallback ? root.requestIdleCallback.bind(root) : fn => setTimeout(() => fn({ timeRemaining: () => 0 }), 40);
    const step = deadline => {
      try {
        if (!impulse48) impulse48 = impulseOf(S);
        do {
          const next = queue.shift();
          if (next) voicesOf(next[0], next[1]);
        } while (queue.length && deadline.timeRemaining() > 6);
      } catch (e) { queue.length = 0; }
      if (queue.length) idle(step); else warming = false;
    };
    idle(step);
  }

  // ---------------------------------------------------------------- lecture
  let ctx = null, out = null, send = null, turn = 0;
  const live = new Set(); // ce qui sonne, ou va sonner

  function boot() {
    if (ctx) return true;
    if (!AC) return false;
    try {
      try { ctx = new AC({ sampleRate: RATE, latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      out = ctx.createGain();
      out.gain.value = LEVEL;
      out.connect(ctx.destination);
      // Le ConvolverNode exige une réponse au débit de la sortie : si le navigateur a imposé le sien, on la recalcule à ce débit.
      const same = ctx.sampleRate === RATE, rate = ctx.sampleRate;
      const sides = same ? impulse48 || (impulse48 = impulseOf(S)) : impulseOf(root.RNGSynth.create(rate));
      const response = ctx.createBuffer(2, sides[0].length, rate);
      sides.forEach((x, ch) => response.getChannelData(ch).set(x));
      const room = ctx.createConvolver(), back = ctx.createGain();
      room.normalize = false; // avant de donner la réponse : sinon le navigateur change son niveau
      room.buffer = response;
      back.gain.value = REVERB;
      send = ctx.createGain();
      send.connect(room);
      room.connect(back);
      back.connect(out);
      return true;
    } catch (e) {
      ctx = null;
      enabled = false;
      return false;
    }
  }

  function fire(type, o, delay) {
    const t0 = ctx.currentTime + delay;
    for (const v of voicesOf(type, o)) {
      if (!v.buffer) {
        v.buffer = ctx.createBuffer(1, v.data.length, RATE);
        v.buffer.getChannelData(0).set(v.data);
        v.data = null;
      }
      const src = ctx.createBufferSource(), dry = ctx.createGain(), wet = ctx.createGain(), nodes = [src, dry, wet];
      src.buffer = v.buffer;
      dry.gain.value = v.level;
      wet.gain.value = v.level * v.wet;
      src.connect(dry);
      src.connect(wet);
      wet.connect(send);
      if (v.pan && ctx.createStereoPanner) { // même loi que le trailer : puissance constante, relevée de 3 dB
        const pan = ctx.createStereoPanner();
        pan.pan.value = v.pan;
        dry.gain.value = v.level * 1.414;
        dry.connect(pan);
        pan.connect(out);
        nodes.push(pan);
      } else dry.connect(out);
      const voice = { src, dry, wet };
      src.onended = () => { nodes.forEach(n => n.disconnect()); live.delete(voice); };
      live.add(voice);
      src.start(t0 + v.dt);
    }
  }

  function play(type, o = {}, delay = 0) {
    try {
      if (!enabled || document.hidden || !boot()) return;
      if (ctx.state === 'running') { fire(type, o, delay); return; }
      // Sortie pas encore ouverte (premier geste du joueur, ou onglet revenu au premier plan) : le son part dès qu'elle
      // l'est, mais seulement si c'est tout de suite. Sinon tous les sons en attente partiraient d'un coup plus tard.
      const asked = performance.now(), opening = ctx.resume();
      if (opening && opening.then) opening.then(() => { try { if (enabled && performance.now() - asked < 250) fire(type, o, delay); } catch (e) { /* silence */ } }, () => {});
    } catch (e) { /* silence */ }
  }

  function stop() {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of live) {
      try {
        v.dry.gain.setTargetAtTime(0, now, .03);
        v.wet.gain.setTargetAtTime(0, now, .03);
        v.src.stop(now + .2);
      } catch (e) { /* silence */ }
    }
  }

  function unlock() {
    try {
      if (!enabled || !boot() || ctx.state === 'running') return;
      const opening = ctx.resume();
      if (opening && opening.catch) opening.catch(() => {});
    } catch (e) { /* silence */ }
  }

  function enable(on) {
    enabled = !!on && !!AC;
    if (enabled) warm();
    else stop();
  }

  root.Sound = {
    play, stop, unlock, enable, warm,
    // Douze cliquetis différents tournent, pour ne pas sonner comme une mitraillette.
    tick(o = {}) { play('tick', Object.assign({ k: o.last ? 0 : turn++ % 12 }, o)); },
    badge(i, of) { play('badge', { step: Math.round((i * 3) / Math.max(1, of - 1)), last: i === of - 1 }); },
    PACKS: Object.keys(PACKS), // packs de sons qui ont leur recette (js/shop.js SOUNDS)
    LEAD: Math.round((RISER + .07) * 1000), // la montée se lance ce nombre de ms avant le dernier chiffre, et se coupe juste avant lui
    recipes: RECIPES, // pour le banc d'essai (tools/sound-check.mjs), qui compare ce qui sort du navigateur au mixage du trailer
  };
})(window);
