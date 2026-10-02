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
  const RECIPES = {
    // Le bouton Generate.
    click: () => [[S.tick(3, .6), 0, .25, 0, .1], [S.tick(4, .2), .05, .18, 0, .1]],
    // Cliquetis des rouleaux (k : la variante). soft : en duel. last, de 1 à 8 : le dernier rouleau, de plus en plus grave et fort.
    tick: ({ k, soft, last }) => [[S.tick(100 + k, last ? .3 + .7 * last / 8 : 0), 0, soft ? .045 : last ? .08 + .09 * last / 8 : .07, ((k * 37) % 9) / 9 - .5, .08]],
    // Un chiffre se pose : une note par rouleau, en montant la gamme. soft : zéro de tête, ou duel. final : le dernier chiffre.
    lock: ({ i, soft, final }) => [[S.lock(S.note(i), soft ? .5 : final ? 1.2 : 1), 0, soft ? .2 : final ? .4 : .36, 0, .25]],
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
    tier: ({ tier }) => {
      if (tier === 'mythic') return [[S.impact('mythic'), 0, 1.1, 0, .5]];
      if (tier === 'anomaly') return [[S.impact('gold'), 0, .9, 0, .5]];
      if (tier === 'epic') return [[S.impact('epic'), 0, .75, 0, .45]];
      if (tier === 'trash') return [[thud(), 0, .3, 0, .2]];
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
    LEAD: Math.round((RISER + .07) * 1000), // la montée se lance ce nombre de ms avant le dernier chiffre, et se coupe juste avant lui
    recipes: RECIPES, // pour le banc d'essai (tools/sound-check.mjs), qui compare ce qui sort du navigateur au mixage du trailer
  };
})(window);
