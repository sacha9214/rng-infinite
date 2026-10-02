// Bande-son du trailer, fabriquée par le code à partir des repères du film (window.__trailer.cues) : aucun échantillon,
// aucune musique sous licence. Chaque repère (chiffre posé, impact, changement de skin…) devient un son synthétisé, calé
// à la milliseconde sur l'image.
// Les instruments sont ceux du jeu (js/synth.js) : le site joue les mêmes sons en direct pendant un tirage (js/sound.js).
//   import { renderAudio, writeWav } from './trailer-audio.mjs'
//   node tools/trailer-audio.mjs repères.json sortie.wav [--sfx]     (pour l'écouter seule ; --sfx : sans la musique)
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const SR = 48000;
const { note, expo, osc, noise, filter, shape, gain, sum, bell, lock, tick, whoosh, riser, boom, impact, reverb, finish }
  = createRequire(import.meta.url)('../js/synth.js').create(SR);

// ------------------------------------------------------------------ musique
// Un lit rythmique sobre à 120 battements par minute, écrit à partir de la partition du film (repères 'music' :
// intensité de 0 à 4 et accord). Même palette grave et douce que les effets : grosse caisse feutrée, basse à contretemps,
// nappe d'accords, arpège discret, claquement de mains sur les temps 2 et 4. Pas de cymbales.
const CHORDS = { // [basse, puis trois notes de l'accord]
  G: [98, 196, 246.94, 293.66], Em: [82.41, 164.81, 196, 246.94], C: [130.81, 196, 261.63, 329.63], D: [146.83, 220, 293.66, 369.99],
};
const BEAT = .5;
const kickDrum = () => sum(osc(.32, t => 45 + 110 * Math.exp(-t / .03), expo(.1, .0015)), gain(shape(filter(noise(.012, 5), 'lp', 2500), expo(.002, .0003)), .25));
const clap = seed => shape(filter(noise(.22, 900 + seed), 'bp', 1150, .9), t => {
  let v = t >= .03 ? .8 * Math.exp(-(t - .03) / .06) : 0;
  for (const b of [0, .011, .022]) if (t >= b) v = Math.max(v, Math.exp(-(t - b) / .005));
  return v;
});
const rich = ph => Math.sin(ph) + .45 * Math.sin(2 * ph) + .18 * Math.sin(3 * ph); // un grave qui s'entend aussi sur un téléphone
const bassNote = (f, dur) => osc(dur + .1, () => f, t => Math.min(1, t / .006) * Math.exp(-t / (dur * .9)), rich);
const pluck = f => sum(osc(.3, () => f, expo(.11, .002)), gain(osc(.15, () => f * 2, expo(.05, .002)), .22));
function music(cues, duration) {
  const n = Math.ceil(duration * SR), mk = () => new Float32Array(n);
  const out = { L: mk(), R: mk(), send: mk() }, bed = { L: mk(), R: mk(), send: mk() }; // bed : nappe et basse, creusées par la grosse caisse
  const score = cues.filter(c => c.type === 'music').sort((a, b) => a.t - b.t);
  if (!score.length) return out;
  const at = t => { let cur = score[0]; for (const c of score) { if (c.t <= t + 1e-6) cur = c; else break; } return cur; };
  const put = (bus, x, t, left, right = left, wet = 0) => {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < x.length; i++) {
      const j = i0 + i;
      if (j < 0 || j >= n) continue;
      bus.L[j] += x[i] * left;
      bus.R[j] += x[i] * right;
      bus.send[j] += x[i] * wet * (left + right) / 2;
    }
  };
  const kicks = [];
  for (let k = 0; k * BEAT < duration - .05; k++) {
    const t = k * BEAT, { level, chord } = at(t), tones = CHORDS[chord];
    if (level === 3 || ((level === 1 || level === 2) && k % 2 === 0)) { kicks.push(t); put(out, kickDrum(), t, level === 1 ? .2 : .46); }
    if (level === 3 && k % 2 === 1) put(out, clap(k), t, .15, .15, .35);
    if (level === 3) { // basse à contretemps, arpège en croches avec un écho
      put(bed, bassNote(tones[0], .2), t + BEAT / 2, .3);
      put(bed, bassNote(tones[0], .12), t, .13);
      for (let e = 0; e < 2; e++) {
        const f = [tones[1], tones[2], tones[3], tones[1] * 2, tones[3], tones[2], tones[1], tones[2]][(k * 2 + e) % 8] * 2, side = (k * 2 + e) % 2 ? .75 : .25;
        put(out, pluck(f), t + e * BEAT / 2, .075 * (1 - side) * 2, .075 * side * 2, .4);
        put(out, pluck(f), t + e * BEAT / 2 + BEAT * .75, .03 * side * 2, .03 * (1 - side) * 2, .5);
      }
    } else if (level === 2 && k % 4 === 0) put(bed, bassNote(tones[0], 1.5), t, .2);
  }
  // Nappe : un accord tenu par segment de partition ; l'accord final sonne et s'éteint tout seul.
  score.forEach((c, i) => {
    const end = i + 1 < score.length ? score[i + 1].t : duration, tones = CHORDS[c.chord];
    if (end - c.t < .05) return;
    const final = c.level === 4, hush = c.level === 0; // 0 : la nappe se retire avant l'impact qui suit
    const dur = final ? duration - c.t : end - c.t - (hush ? .12 : 0), level = [.03, .05, .065, .07, .075][c.level];
    const amp = final ? t => Math.min(1, t / .01) * Math.exp(-t / 2.4) : t => Math.min(1, t / .12, (dur - t) / (hush ? .25 : .1));
    const soft = ph => Math.sin(ph) + .1 * Math.sin(3 * ph);
    (hush ? [tones[1], tones[3]] : final ? [tones[0], ...tones.slice(1), tones[1] * 2] : tones.slice(1)).forEach(f => {
      put(bed, osc(dur, () => f * 1.003, amp, soft), c.t, level, level * .55, .25);
      put(bed, osc(dur, () => f * .997, amp, soft), c.t, level * .55, level, .25);
    });
    if (final) put(out, bassNote(tones[0], 2.6), c.t, .2);
  });
  // La grosse caisse creuse la nappe et la basse (effet de pompe).
  let ki = 0, last = -9;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (ki < kicks.length && kicks[ki] <= t) last = kicks[ki++];
    const duck = 1 - .5 * Math.exp(-(t - last) / .11);
    out.L[i] += bed.L[i] * duck;
    out.R[i] += bed.R[i] * duck;
    out.send[i] += bed.send[i] * duck;
  }
  return out;
}

// ------------------------------------------------------------------ mixage
export function renderAudio(cues, duration, { withMusic = true } = {}) {
  const n = Math.ceil(duration * SR), L = new Float32Array(n), R = new Float32Array(n), send = new Float32Array(n);
  // Pose un son à l'instant t : niveau, position gauche/droite (−1 à 1, peut glisser pendant le son), part envoyée en réverbération.
  const add = (x, t, level = 1, pan = 0, wet = .2, panTo = pan) => {
    const i0 = Math.round(t * SR);
    for (let i = 0; i < x.length; i++) {
      const j = i0 + i;
      if (j < 0 || j >= n) continue;
      const p = ((pan + (panTo - pan) * (i / x.length) + 1) * Math.PI) / 4, v = x[i] * level;
      L[j] += v * Math.cos(p) * 1.414;
      R[j] += v * Math.sin(p) * 1.414;
      send[j] += v * wet;
    }
  };
  cues.forEach((c, id) => {
    switch (c.type) {
      case 'click': add(tick(3, .6), c.t, .25, 0, .1); add(tick(4, .2), c.t + .05, .18, 0, .1); break;
      case 'tick': add(tick(100 + id, c.last ? .3 + .7 * c.last : 0), c.t, c.soft ? .045 : c.last ? .08 + .09 * c.last : .07, ((id * 37) % 9) / 9 - .5, .08); break;
      case 'lock': add(lock(note(c.grid ? c.i + 3 : c.i), c.soft ? .5 : 1), c.t, c.soft ? .2 : .36, 0, .25); break;
      case 'letter': add(lock(note([0, 2, 3, 5][c.i]), .6), c.t, .32, [-.4, -.13, .13, .4][c.i], .3); break;
      case 'riser': add(riser(c.dur), c.t, .5, 0, .2); break;
      case 'impact': add(impact(c.kind), c.t, { mythic: 1.1, gold: .9, logo: .95 }[c.kind], 0, .5); break;
      case 'badge': {
        const f = note([3, 5, 7, 8][Math.round((c.i * 3) / Math.max(1, c.of - 1))]), last = c.i === c.of - 1;
        add(bell(f, .55), c.t, last ? .4 : .3, .35, .35);
        add(shape(filter(noise(.06, 60 + c.i), 'lp', 900), expo(.012, .001)), c.t, .5, .35, .1);
        if (last) add(sum(boom(.9, 90, 45), gain(bell(f * 1.5, .9), .3)), c.t, .22, .2, .4);
        break;
      }
      case 'whoosh': add(whoosh(c.dur, 31 + id), c.t, .4, -(c.pan || 0), .2, c.pan || 0); break;
      case 'wipe': add(sum(whoosh(c.dur, 47 + id, 1700), gain(filter(whoosh(c.dur, 48 + id, 600), 'lp', 500), 1.2)), c.t, .5, -.8, .2, .8); break;
      case 'swap': {
        const fast = c.i >= 8, f = note(c.i); // de sol3 à si5, un degré par skin
        add(sum(osc(.25, () => f, expo(.06, .001)), gain(osc(.1, () => f * 2, expo(.02, .001)), .18)), c.t, fast ? .14 : .22, 0, .25);
        add(shape(filter(noise(.09, 40 + c.i), 'bp', t => 900 + (1700 * t) / .09, 1.5), t => Math.pow(Math.sin((Math.PI * t) / .09), 2)), c.t - .03, fast ? .14 : .22, 0, .15);
        break;
      }
      case 'wall': add(boom(1.4, 95, 40), c.t, .7, 0, .3); add(whoosh(.9, 55, 1600), c.t - .05, .4, 0, .3); break;
      case 'slam': {
        const thud = () => sum(boom(.5, 120, 55), gain(shape(filter(noise(.05, 70), 'lp', 1400), expo(.012, .0005)), .7));
        add(thud(), c.t, .4, -.6, .25);
        add(thud(), c.t + .02, .4, .6, .25);
        add(sum(...[262, 622, 935, 1320].map((f, k) => gain(osc(.9, () => f, expo(.16 - .025 * k, .001)), .3 / (k + 1)))), c.t + .04, .22, 0, .5);
        break;
      }
      case 'reveal': add(sum(gain(boom(.6, 100, 50), .6), gain(bell(note(3), .5), .5), gain(bell(note(5), .5), .4)), c.t, c.small ? .3 : .5, 0, .35); break;
      case 'win': [5, 7, 8].forEach((k, i) => add(bell(note(k), .7, .8), c.t + i * .07, c.small ? .14 : .2, c.small ? 0 : -.3, .45)); break;
      case 'bubble': add(osc(.16, t => (220 + 50 * c.i) * (1 + 1.2 * Math.sqrt(t / .16)), expo(.05, .004)), c.t, .15, c.i === 1 ? .5 : -.5, .2); break;
      case 'pop': add(osc(.1, t => 420 - 1500 * t, expo(.03, .002)), c.t, .22, 0, .2); break;
      case 'music': break; // la partition : voir music()
      case 'cut': add(whoosh(.3, 80 + id, 1200), c.t - .1, .3, 0, .2); add(boom(.5, 100, 50), c.t, .3, 0, .2); break;
      case 'pass': add(bell(196 * Math.pow(2, 1.6 * (1 - c.k / c.of)), .07, .5), c.t, .07 + .07 * (1 - c.k / c.of), .2, .2); break;
      default: throw new Error(`Unknown cue: ${c.type}`);
    }
  });
  if (withMusic) {
    const m = music(cues, duration);
    for (let i = 0; i < n; i++) { L[i] += m.L[i] * 1.3; R[i] += m.R[i] * 1.3; send[i] += m.send[i] * 1.3; }
  }
  // Réverbération : la droite est légèrement décalée de la gauche.
  const wetL = reverb(send, 0), wetR = reverb(send, 23);
  for (let i = 0; i < n; i++) { L[i] += wetL[i] * 2.4; R[i] += wetR[i] * 2.4; }
  // Sortie : infra-grave retiré et haut du spectre adouci (finish), fondu sur le dernier quart de seconde, puis la
  // crête la plus forte est ramenée à −3 dB. Aucun limiteur ici : la hiérarchie des sons (un impact bien au-dessus d'un
  // chiffre qui se pose, lui-même au-dessus du cliquetis) doit rester intacte. Le niveau final est réglé au montage
  // (loudnorm dans tools/trailer-render.mjs).
  const hpL = finish(L), hpR = finish(R);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, (n - i) / (.25 * SR));
    hpL[i] *= g;
    hpR[i] *= g;
    peak = Math.max(peak, Math.abs(hpL[i]), Math.abs(hpR[i]));
  }
  const norm = .7 / peak;
  for (let i = 0; i < n; i++) { hpL[i] *= norm; hpR[i] *= norm; }
  return { L: hpL, R: hpR };
}

// Fichier WAV stéréo 24 bits.
export function writeWav(file, L, R) {
  const n = L.length, data = Buffer.alloc(n * 6), head = Buffer.alloc(44);
  for (let i = 0; i < n; i++) {
    data.writeIntLE(Math.round(Math.max(-1, Math.min(1, L[i])) * 8388607), i * 6, 3);
    data.writeIntLE(Math.round(Math.max(-1, Math.min(1, R[i])) * 8388607), i * 6 + 3, 3);
  }
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 6, 28);
  head.writeUInt16LE(6, 32); head.writeUInt16LE(24, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

if (process.argv[1] && process.argv[1].endsWith('trailer-audio.mjs') && process.argv[2]) {
  const { cues, duration } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { L, R } = renderAudio(cues, duration, { withMusic: !process.argv.includes('--sfx') });
  writeWav(process.argv[3] || 'trailer.wav', L, R);
  console.log(`${process.argv[3] || 'trailer.wav'} — ${cues.length} repères, ${duration} s`);
}
