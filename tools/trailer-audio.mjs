// Bande-son du trailer, fabriquée par le code à partir des repères du film (window.__trailer.cues) : aucun échantillon,
// aucune musique sous licence. Chaque repère (chiffre posé, impact, coupe, message du chat…) devient un son synthétisé,
// calé à la milliseconde sur l'image.
// Les instruments sont ceux du jeu (js/synth.js) : le site joue les mêmes sons en direct pendant un tirage (js/sound.js).
// Trailer v2 (2026-10-26, demandé par Sacha) : musique plus nerveuse (grosse caisse à chaque temps, caisse claire et
// charleston, basse qui roule, roulement de caisse claire avant le drop, mélodie au drop) et un coup sur chaque coupe.
// Palette toujours grave et douce (Sacha trouvait la première version trop aiguë) : charleston filtré, rien au-dessus
// de 6 kHz (finish).
//   import { renderAudio, writeWav } from './trailer-audio.mjs'
//   node tools/trailer-audio.mjs repères.json sortie.wav [--sfx]     (pour l'écouter seule ; --sfx : sans la musique)
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const SR = 48000;
const { note, expo, osc, noise, filter, shape, gain, sum, bell, lock, tick, whoosh, riser, boom, impact, reverb, finish }
  = createRequire(import.meta.url)('../js/synth.js').create(SR);

// ------------------------------------------------------------------ musique
// 120 battements par minute, écrite à partir de la partition du film (repères 'music' : intensité 0 à 5 et accord).
// 0 = silence tendu, 1 = pulsation, 2 = demi-rythme, 3 = rythme complet, 4 = drop (tout + mélodie), 5 = accord final.
const CHORDS = { // [basse, puis trois notes de l'accord]
  G: [98, 196, 246.94, 293.66], Em: [82.41, 164.81, 196, 246.94], C: [130.81, 196, 261.63, 329.63], D: [146.83, 220, 293.66, 369.99],
};
const BEAT = .5;
const kickDrum = (punch = 1) => sum(
  osc(.36, t => 44 + 130 * Math.exp(-t / .028), expo(.12, .0012)),
  gain(shape(filter(noise(.014, 5), 'lp', 3200), expo(.0025, .0002)), .35 * punch));
const clap = seed => shape(filter(noise(.24, 900 + seed), 'bp', 1150, .9), t => {
  let v = t >= .03 ? .8 * Math.exp(-(t - .03) / .07) : 0;
  for (const b of [0, .011, .022]) if (t >= b) v = Math.max(v, Math.exp(-(t - b) / .005));
  return v;
});
// caisse claire : corps grave accordé + timbre de bruit (sert aussi au roulement)
const snare = (seed, amt = 1) => sum(gain(osc(.12, t => 190 - 40 * t, expo(.035, .001)), .5), gain(shape(filter(noise(.2, 300 + seed), 'bp', 2400, .6), expo(.06 * amt, .0008)), .7));
const hat = (seed, open = false) => shape(filter(noise(open ? .2 : .06, 700 + seed), 'bp', 5200, .9), expo(open ? .07 : .018, .0005));
const rich = ph => Math.sin(ph) + .45 * Math.sin(2 * ph) + .18 * Math.sin(3 * ph);
const saw = ph => { let v = 0; for (let k = 1; k <= 6; k++) v += Math.sin(k * ph) / k; return v * .55; }; // dents de scie douce (6 partiels)
const bassNote = (f, dur, shape_ = rich) => osc(dur + .1, () => f, t => Math.min(1, t / .006) * Math.exp(-t / (dur * .9)), shape_);
const pluck = f => sum(osc(.3, () => f, expo(.11, .002)), gain(osc(.15, () => f * 2, expo(.05, .002)), .22));
const lead = (f, dur) => filter(sum(osc(dur + .15, () => f * 1.004, t => Math.min(1, t / .01) * Math.exp(-t / (dur * 1.3)), saw), osc(dur + .15, () => f * .996, t => Math.min(1, t / .01) * Math.exp(-t / (dur * 1.3)), saw)), 'lp', t => 900 + 2200 * Math.exp(-t / .12), .9);
// Mélodie du drop : deux mesures en sol pentatonique, une note par croche (null = silence), rejouée sur chaque accord.
const HOOK = [7, null, 7, 9, null, 7, 5, null, 4, null, 5, 7, null, 9, 10, null];
function music(cues, duration) {
  const n = Math.ceil(duration * SR), mk = () => new Float32Array(n);
  const out = { L: mk(), R: mk(), send: mk() }, bed = { L: mk(), R: mk(), send: mk() };
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
    if (!level || level === 5) continue;
    // grosse caisse : à chaque temps (3, 4), un temps sur deux (2), une fois par mesure (1)
    if (level >= 3 || (level === 2 && k % 2 === 0) || (level === 1 && k % 4 === 0)) { kicks.push(t); put(out, kickDrum(level >= 3 ? 1 : .6), t, level === 1 ? .28 : level === 4 ? .66 : .55); }
    if (level >= 3 && k % 2 === 1) { put(out, clap(k), t, .16, .16, .35); put(out, snare(k), t, .14, .14, .3); }
    if (level >= 3) { // charleston sur les contretemps (et en doubles croches au drop), panoramique léger
      put(out, hat(k), t + BEAT / 2, .05, .07, .05);
      if (level === 4) { put(out, hat(k + 50), t + BEAT / 4, .025, .02, .03); put(out, hat(k + 90), t + BEAT * .75, .025, .03, .03); }
    }
    if (level >= 3) { // basse : contretemps (3), croches qui roulent avec la sous-basse (4)
      if (level === 4) for (let e = 0; e < 2; e++) put(bed, bassNote(e ? tones[0] * 2 : tones[0], .2, saw), t + e * BEAT / 2, .2);
      else { put(bed, bassNote(tones[0], .2), t + BEAT / 2, .3); put(bed, bassNote(tones[0], .12), t, .12); }
      for (let e = 0; e < 2; e++) { // arpège en croches avec un écho
        const f = [tones[1], tones[2], tones[3], tones[1] * 2, tones[3], tones[2], tones[1], tones[2]][(k * 2 + e) % 8] * 2, side = (k * 2 + e) % 2 ? .75 : .25;
        const lv = level === 4 ? .05 : .07;
        put(out, pluck(f), t + e * BEAT / 2, lv * (1 - side) * 2, lv * side * 2, .4);
        put(out, pluck(f), t + e * BEAT / 2 + BEAT * .75, .03 * side * 2, .03 * (1 - side) * 2, .5);
      }
    } else if (level === 2 && k % 4 === 0) put(bed, bassNote(tones[0], 1.5), t, .22);
    if (level === 4) { // la mélodie du drop
      for (let e = 0; e < 2; e++) {
        const step = (k * 2 + e) % HOOK.length, d = HOOK[step];
        if (d !== null) put(out, lead(note(d), .22), t + e * BEAT / 2, .11, .11, .45);
      }
    }
  }
  // Nappe : un accord tenu par segment ; l'accord final sonne et s'éteint tout seul.
  score.forEach((c, i) => {
    const end = i + 1 < score.length ? score[i + 1].t : duration, tones = CHORDS[c.chord];
    if (end - c.t < .05) return;
    const final = c.level === 5, hush = c.level === 0;
    const dur = final ? duration - c.t : end - c.t - (hush ? .12 : 0), level = [.03, .05, .06, .065, .075, .085][c.level];
    const amp = final ? t => Math.min(1, t / .01) * Math.exp(-t / 2.2) : t => Math.min(1, t / .12, (dur - t) / (hush ? .25 : .1));
    const soft = ph => Math.sin(ph) + .1 * Math.sin(3 * ph);
    (hush ? [tones[1], tones[3]] : final ? [tones[0], ...tones.slice(1), tones[1] * 2] : tones.slice(1)).forEach(f => {
      put(bed, osc(dur, () => f * 1.003, amp, soft), c.t, level, level * .55, .25);
      put(bed, osc(dur, () => f * .997, amp, soft), c.t, level * .55, level, .25);
    });
    if (final) { put(out, bassNote(tones[0], 2.6), c.t, .26); put(out, kickDrum(), c.t, .5); }
  });
  // Roulements de caisse claire (repères 'roll') : de la croche à la triple croche, en crescendo.
  for (const c of cues.filter(x => x.type === 'roll')) {
    let u = 0;
    while (u < c.dur - .02) {
      const p = u / c.dur;
      put(out, snare(Math.round(u * 1000), .6 + .4 * p), c.t + u, .05 + .13 * p, .05 + .13 * p, .25);
      u += p < .4 ? BEAT / 2 : p < .75 ? BEAT / 4 : BEAT / 8;
    }
  }
  // La grosse caisse creuse la nappe et la basse (effet de pompe).
  let ki = 0, last = -9;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (ki < kicks.length && kicks[ki] <= t) last = kicks[ki++];
    const duck = 1 - .55 * Math.exp(-(t - last) / .12);
    out.L[i] += bed.L[i] * duck;
    out.R[i] += bed.R[i] * duck;
    out.send[i] += bed.send[i] * duck;
  }
  return out;
}

// ------------------------------------------------------------------ mixage
const IMPACT_LEVEL = { mythic: 1.1, gold: .9, logo: .95, epic: .8 };
export function renderAudio(cues, duration, { withMusic = true } = {}) {
  const n = Math.ceil(duration * SR), L = new Float32Array(n), R = new Float32Array(n), send = new Float32Array(n);
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
  const blip = (f0, f1, dur) => osc(dur, t => f0 + (f1 - f0) * Math.sqrt(t / dur), expo(dur * .35, .003));
  cues.forEach((c, id) => {
    switch (c.type) {
      case 'click': add(tick(3, .6), c.t, .25, 0, .1); add(tick(4, .2), c.t + .05, .18, 0, .1); break;
      case 'tick': add(tick(100 + id, c.last ? .3 + .7 * c.last : 0), c.t, c.soft ? .04 : c.last ? .08 + .09 * c.last : .065, ((id * 37) % 9) / 9 - .5, .08); break;
      case 'lock': add(lock(note(c.grid ? c.i + 3 : c.i), c.soft ? .5 : 1), c.t, c.soft ? .18 : .34, 0, .25); break;
      case 'letter': add(lock(note([0, 2, 3, 5][c.i]), .6), c.t, .32, [-.4, -.13, .13, .4][c.i], .3); break;
      case 'riser': add(riser(c.dur), c.t, .5, 0, .2); break;
      case 'impact': {
        if (c.kind === 'infinite') { // le plus gros coup du film : deux accords superposés, une sous-basse longue, un souffle
          add(impact('mythic'), c.t, 1, 0, .5);
          add(impact('logo'), c.t + .01, .7, 0, .6);
          add(boom(2.6, 120, 32), c.t, .9, 0, .3);
          add(whoosh(1.2, 91, 1800), c.t, .25, -.6, .4, .6);
        } else add(impact(c.kind), c.t, IMPACT_LEVEL[c.kind] * (c.soft ? .45 : 1), 0, .5);
        break;
      }
      case 'badge': {
        const f = note([3, 5, 7, 8][Math.round((c.i * 3) / Math.max(1, c.of - 1))]), lastB = c.i === c.of - 1;
        add(bell(f, .55), c.t, lastB ? .4 : .3, .35, .35);
        add(shape(filter(noise(.06, 60 + c.i), 'lp', 900), expo(.012, .001)), c.t, .5, .35, .1);
        if (lastB) add(sum(boom(.9, 90, 45), gain(bell(f * 1.5, .9), .3)), c.t, .22, .2, .4);
        break;
      }
      case 'whoosh': add(whoosh(c.dur, 31 + id), c.t, .4, -(c.pan || 0), .2, c.pan || 0); break;
      case 'whip': add(sum(whoosh(.24, 140 + id, 2000), gain(filter(whoosh(.24, 141 + id, 700), 'lp', 600), 1.1)), c.t, .5, -.7 * (c.pan || 0), .15, .7 * (c.pan || 0)); break;
      case 'hit': add(sum(boom(c.soft ? .5 : .9, 150, 45), gain(shape(filter(noise(.08, 70 + id), 'lp', 1800), expo(.018, .0005)), .8)), c.t, c.soft ? .32 : .55, 0, .3); break;
      case 'wipe': add(sum(whoosh(c.dur, 47 + id, 1700), gain(filter(whoosh(c.dur, 48 + id, 600), 'lp', 500), 1.2)), c.t, .5, -.8, .2, .8); break;
      case 'reveal': add(sum(gain(boom(.6, 100, 50), .6), gain(bell(note(3), .5), .5), gain(bell(note(5), .5), .4)), c.t, c.small ? .28 : .45, 0, .35); break;
      case 'win': [5, 7, 8].forEach((k, i) => add(bell(note(k), .7, .8), c.t + i * .07, c.small ? .14 : .2, c.small ? 0 : -.3, .45)); break;
      case 'pop': add(osc(.1, t => 420 - 1500 * t, expo(.03, .002)), c.t, .22, 0, .2); break;
      case 'chat': add(blip(330 + 40 * (c.i % 4), 620 + 40 * (c.i % 4), .09), c.t, .14, (c.i % 2 ? .35 : -.35), .2); break;
      case 'ping': add(bell(note(7), .45), c.t, .22, .3, .3); add(bell(note(9), .55), c.t + .09, .2, .3, .35); break;
      case 'toast': [4, 7, 9].forEach((k, i) => add(bell(note(k), .6, .8), c.t + i * .06, .17, .2, .4)); break;
      case 'coin': add(bell(note(9), .25, 1.2), c.t, .15, .25, .25); add(bell(note(11), .3, 1.2), c.t + .045, .12, .3, .25); break;
      case 'peg': add(blip(520 + 25 * c.k, 470 + 25 * c.k, .035), c.t, .045, -.3 + .05 * c.k, .1); break;
      case 'card': add(shape(filter(noise(.05, 200 + id), 'bp', 1900, 1.2), expo(.012, .0005)), c.t, .3, .4, .1); break;
      case 'swell': add(shape(filter(noise(1.6, 77), 'lp', t => 300 + 900 * Math.sin(Math.PI * t / 1.6)), t => Math.sin(Math.PI * t / 1.6) ** 2), c.t - .3, .3, -.3, .4, .3); add(bell(note(2), 1.4), c.t, .18, 0, .6); break;
      case 'boom': add(boom(1.3, 90, 34), c.t, .75, 0, .35); break;
      case 'bubbles': for (let i = 0; i < 12; i++) add(blip(240 + 37 * ((i * 7) % 11), 560 + 37 * ((i * 5) % 11), .07), c.t + i * .05 + .015 * ((i * 3) % 4), .08, ((i * 5) % 7) / 7 - .4, .3); break;
      case 'sparkle': for (let i = 0; i < 6; i++) add(bell(note(8 + ((i * 3) % 5)), .4, .7), c.t + i * .045, .06, ((i * 4) % 7) / 7 - .4, .5); break;
      case 'music': case 'roll': break; // la partition : voir music()
      case 'cut': add(whoosh(.3, 80 + id, 1200), c.t - .1, .3, 0, .2); add(boom(.5, 100, 50), c.t, .3, 0, .2); break;
      default: throw new Error(`Unknown cue: ${c.type}`);
    }
  });
  if (withMusic) {
    const m = music(cues, duration);
    for (let i = 0; i < n; i++) { L[i] += m.L[i] * 1.3; R[i] += m.R[i] * 1.3; send[i] += m.send[i] * 1.3; }
  }
  const wetL = reverb(send, 0), wetR = reverb(send, 23);
  for (let i = 0; i < n; i++) { L[i] += wetL[i] * 2.4; R[i] += wetR[i] * 2.4; }
  // Sortie : infra-grave retiré, haut du spectre adouci (finish), fondu sur la dernière demi-seconde, crête à −3 dB.
  // Pas de limiteur ici (la hiérarchie des sons reste intacte) ; le niveau final est réglé au montage.
  const hpL = finish(L), hpR = finish(R);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, (n - i) / (.5 * SR));
    hpL[i] *= g;
    hpR[i] *= g;
    peak = Math.max(peak, Math.abs(hpL[i]), Math.abs(hpR[i]));
  }
  const norm = .7 / peak;
  for (let i = 0; i < n; i++) { hpL[i] *= norm; hpR[i] *= norm; }
  return { L: hpL, R: hpR };
}

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
