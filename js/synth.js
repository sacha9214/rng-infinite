/* RNG∞ — synthétiseur des effets sonores : aucun échantillon, tout est calculé.
 * Pur JS sans dépendance, chargeable dans le navigateur (window.RNGSynth) et dans Node (module.exports).
 * Il sert deux fois, pour que le jeu sonne comme son trailer : les sons du tirage joués en direct (js/sound.js) et la
 * bande-son du film (tools/trailer-audio.mjs).
 * create(SR) : les briques et les instruments, à SR échantillons par seconde. Chaque appel rend un Float32Array neuf.
 * Tout est en sol majeur pentatonique (sol la si ré mi) : les sons qui se chevauchent restent justes entre eux.
 * Palette volontairement grave et douce : la première version (cloches et cliquetis une octave plus haut, souffles
 * jusqu'à 7 kHz) a été jugée trop aiguë par Sacha. Les notes vivent entre 100 et 1 000 Hz, les partiels sont discrets,
 * et la sortie est adoucie au-dessus de 6 kHz (finish).
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const PENTA = [196, 220, 246.94, 293.66, 329.63]; // sol3 la3 si3 ré4 mi4
  const note = n => PENTA[((n % 5) + 5) % 5] * Math.pow(2, Math.floor(n / 5)); // 0 = sol3, 5 = sol4, 10 = sol5…

  const rngOf = seed => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  function create(SR) {
    // ---------------------------------------------------------------- briques
    const buf = dur => new Float32Array(Math.max(1, Math.ceil(dur * SR)));
    // Attaque courte puis décroissance exponentielle (tau = temps pour tomber à 37 %).
    const expo = (tau, attack = .002) => t => Math.min(1, t / attack) * Math.exp(-t / tau);
    // Oscillateur dont la fréquence et l'amplitude sont des fonctions du temps.
    function osc(dur, freq, amp, shape = Math.sin) {
      const out = buf(dur);
      let ph = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        ph += (TAU * freq(t)) / SR;
        out[i] = shape(ph) * amp(t);
      }
      return out;
    }
    function noise(dur, seed) {
      const r = rngOf(seed), out = buf(dur);
      for (let i = 0; i < out.length; i++) out[i] = r() * 2 - 1;
      return out;
    }
    // Filtre du second ordre (passe-bas 'lp', passe-haut 'hp', passe-bande 'bp') dont la fréquence peut varier dans le temps.
    function filter(x, type, freq, q = .707) {
      const out = new Float32Array(x.length), f = typeof freq === 'function' ? freq : () => freq;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
      for (let i = 0; i < x.length; i++) {
        if (i % 32 === 0) {
          const w = (TAU * Math.min(SR * .45, Math.max(20, f(i / SR)))) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
          if (type === 'lp') { b0 = (1 - cs) / 2 / a0; b1 = (1 - cs) / a0; b2 = b0; }
          else if (type === 'hp') { b0 = (1 + cs) / 2 / a0; b1 = -(1 + cs) / a0; b2 = b0; }
          else { b0 = al / a0; b1 = 0; b2 = -al / a0; }
          a1 = (-2 * cs) / a0;
          a2 = (1 - al) / a0;
        }
        const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
        out[i] = y;
      }
      return out;
    }
    const shape = (x, amp) => { for (let i = 0; i < x.length; i++) x[i] *= amp(i / SR); return x; };
    const gain = (x, g) => { for (let i = 0; i < x.length; i++) x[i] *= g; return x; };
    function sum(...xs) {
      const out = new Float32Array(Math.max(...xs.map(x => x.length)));
      for (const x of xs) for (let i = 0; i < x.length; i++) out[i] += x[i];
      return out;
    }
    const delayed = (x, dt) => { const out = new Float32Array(x.length + Math.round(dt * SR)); out.set(x, Math.round(dt * SR)); return out; };

    // ---------------------------------------------------------------- instruments
    // Cloche douce : fondamentale et quelques partiels qui s'éteignent plus vite qu'elle.
    function bell(f, decay = 1.2, bright = 1) {
      return sum(...[[1, 1, 1], [2, .2, .55], [3.01, .06 * bright, .35]]
        .map(([m, a, d]) => gain(osc(decay * d * 5, () => f * m, expo(decay * d, .003)), a)));
    }
    // Note boisée (genre marimba) avec un petit coup grave : un chiffre qui se pose.
    function lock(f, thump = 1) {
      const tone = sum(osc(.55, () => f, expo(.14)), gain(osc(.3, () => f * 2, expo(.06)), .3));
      const low = osc(.2, t => 52 + 45 * Math.exp(-t / .04), expo(.055, .001));
      const snap = shape(filter(noise(.02, Math.round(f)), 'bp', 900, 1.2), expo(.004, .0005));
      return sum(tone, gain(low, .9 * thump), gain(snap, .5));
    }
    // Cliquetis d'un rouleau qui tourne.
    function tick(seed, low = 0) {
      const r = rngOf(seed), f = (820 - 260 * low) * (.94 + r() * .12);
      return sum(gain(osc(.05, () => f, expo(.009 + .005 * low, .0006)), .7), gain(shape(filter(noise(.02, seed), 'bp', 1500, 1), expo(.0025, .0004)), .5));
    }
    // Souffle : bruit filtré dont la couleur monte puis redescend.
    function whoosh(dur, seed = 31, top = 1300) {
      return shape(filter(noise(dur, seed), 'bp', t => 220 + top * Math.sin(Math.PI * Math.pow(t / dur, .8)), 1.1), t => Math.pow(Math.sin((Math.PI * t) / dur), 2));
    }
    // Montée de tension : le bruit et une note enflent en montant, puis tout se coupe net juste avant l'impact.
    function riser(dur) {
      const up = t => Math.pow(t / dur, 2.2) * Math.min(1, (dur - t) / .012);
      const air = filter(noise(dur, 11), 'bp', t => 200 * Math.pow(12.5, t / dur), 2.2);
      const tone = osc(dur, t => 98 * Math.pow(2, 2 * Math.pow(t / dur, 1.4)), () => 1, ph => Math.sin(ph) + .3 * Math.sin(2 * ph));
      return sum(shape(air, t => up(t) * .9), shape(tone, t => up(t) * .2));
    }
    // Grave qui descend : le corps d'un impact.
    const boom = (dur = 1.8, from = 112, to = 42) => osc(dur, t => to + (from - to) * Math.exp(-t / .09), expo(dur * .3, .003));
    // Impact : grave, claquement, un peu de souffle et accord de cloches ('epic' ne sert qu'au jeu).
    function impact(kind) {
      const chord = { mythic: [0, 2, 3, 5, 6], gold: [0, 2, 3, 5, 7, 8], logo: [-5, -2, 0, 2, 3, 5], epic: [0, 3, 5, 7] }[kind].map(note);
      const punch = shape(filter(noise(.5, 21), 'lp', t => 250 + 1800 * Math.exp(-t / .05)), expo(.11, .001));
      const air = shape(filter(noise(1.4, 22), 'bp', 2200, .7), expo(.35, .004));
      const bells = sum(...chord.map((f, k) => delayed(gain(bell(f, 1.5 + .12 * k), .72 / chord.length), k * .012)));
      return sum(gain(boom(), .6), gain(punch, .8), gain(air, .07), bells);
    }

    // ---------------------------------------------------------------- sortie
    // Réverbération (structure Freeverb : 8 peignes en parallèle puis 4 passe-tout). spread décale la droite de la gauche.
    function reverb(x, spread) {
      const k = SR / 44100, room = .86, damp = .5, out = new Float32Array(x.length);
      for (const len of [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]) {
        const line = new Float32Array(Math.round((len + spread) * k));
        let at = 0, store = 0;
        for (let i = 0; i < x.length; i++) {
          const y = line[at];
          store = y * (1 - damp) + store * damp;
          line[at] = x[i] * .015 + store * room;
          at = (at + 1) % line.length;
          out[i] += y;
        }
      }
      for (const len of [556, 441, 341, 225]) {
        const line = new Float32Array(Math.round((len + spread) * k));
        let at = 0;
        for (let i = 0; i < out.length; i++) {
          const b = line[at], y = b - out[i];
          line[at] = out[i] + b * .5;
          at = (at + 1) % line.length;
          out[i] = y;
        }
      }
      return out;
    }
    // On retire l'infra-grave (inaudible, et il mange la marge) et on adoucit le haut du spectre.
    const finish = x => filter(filter(x, 'hp', 34), 'lp', 6000, .6);

    return { SR, note, expo, osc, noise, filter, shape, gain, sum, bell, lock, tick, whoosh, riser, boom, impact, reverb, finish };
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGSynth = api;
})(typeof window !== 'undefined' ? window : globalThis);
