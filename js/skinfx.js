/* RNG∞ — séquences des skins : quand on tire avec un skin, la rotation, chaque chiffre qui se pose et la révélation
 * jouent une petite scène propre au skin (flammes et braises, saut dans l'hyperespace, arcs électriques…), en plus de
 * ses animations CSS. Deux canvas par tirage : un dans la carte, derrière les chiffres (la matière vivante du skin), un
 * autour d'elle, par-dessus (ce qui en jaillit).
 *   const fx = SkinFX.mount(scène, carte, 'fire', { owner })   → null si ce skin n'a pas de séquence (owner : la
 *                                    signature en béryl rouge du créateur, jouée par-dessus, même sans skin)
 *   fx.lock(case, { ghost, last })   un chiffre se pose
 *   fx.build(ms)                     la tension monte avant le dernier chiffre
 *   fx.reveal(rareté)                la rareté se révèle : tout est dosé par POWER, d'un tirage raté à un Mythic
 *   fx.stop()                        tirage annulé
 * Rien ici n'est nécessaire au jeu : fichier absent, « réduire les animations » demandé au système ou skin sans
 * séquence, la carte garde simplement ses animations CSS.
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const rnd = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
  const pick = list => list[(Math.random() * list.length) | 0];
  const outCubic = p => 1 - Math.pow(1 - clamp(p), 3);
  const outExpo = p => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(p)));
  // Force d'une révélation selon la rareté : le nombre de particules, la lumière et la durée en découlent.
  const POWER = { landwaste: 0, garbage: 0, trash: 0, common: .12, uncommon: .25, rare: .42, epic: .62, anomaly: .8, mythic: 1, celestial: 1, divine: 1, godlike: 1, infinite: 1 };
  // Nombre de particules d'une révélation : quelques-unes pour un Common (un tirage sur deux), `most` pour un Mythic.
  const burst = (p, most, few = 4) => Math.round(few + most * Math.pow(p, 1.25));
  // Au-delà du Mythic, POWER plafonne à 1 : les skins légendaires lisent ce second cran pour monter encore d'un étage
  // (Celestial 1, Divine 2, Godlike et Infinite 3) — un tirage rarissime doit se voir autrement qu'un Mythic.
  const ASCEND = { celestial: 1, divine: 2, godlike: 3, infinite: 3 };
  // Rayons de lumière (god rays) depuis un point : des traits larges qui s'effacent vers l'extérieur, en éventail tournant.
  function godrays(c, color, x, y, n, r0, r1, rot, width, a) {
    if (a <= .004) return;
    for (let i = 0; i < n; i++) {
      const ang = rot + (i * TAU) / n + .18 * Math.sin(i * 2.7), len = r1 * (.7 + .3 * Math.sin(i * 5.1 + rot * 3));
      tail(c, color, x + Math.cos(ang) * len, y + Math.sin(ang) * len, x + Math.cos(ang) * r0, y + Math.sin(ang) * r0, width * (.6 + .4 * Math.sin(i * 3.3)), a);
    }
  }

  // ---------------------------------------------------------------- briques de dessin
  // Disque lumineux doux, mis en cache par couleur : la brique de presque tout (flammes, braises, étoiles, halos).
  // ry différent de r : le disque est étiré (langue de flamme, reflet d'objectif).
  const sprites = new Map();
  function glow(color) {
    let s = sprites.get(color);
    if (!s) {
      s = document.createElement('canvas');
      s.width = s.height = 64;
      const c = s.getContext('2d'), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, color);
      g.addColorStop(.3, color + 'b0');
      g.addColorStop(.62, color + '38');
      g.addColorStop(1, color + '00');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      sprites.set(color, s);
    }
    return s;
  }
  function dot(c, color, x, y, r, a, ry = r) {
    if (a <= .004 || r <= .2) return;
    c.globalAlpha = Math.min(1, a);
    c.drawImage(glow(color), x - r, y - ry, r * 2, ry * 2);
  }
  function line(c, color, x1, y1, x2, y2, width, a) {
    if (a <= .004) return;
    c.globalAlpha = Math.min(1, a);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
  // Trait qui s'efface vers sa queue (étoile qui file, météore).
  function tail(c, color, x1, y1, x2, y2, width, a) {
    if (a <= .004) return;
    const g = c.createLinearGradient(x1, y1, x2, y2);
    g.addColorStop(0, color + '00');
    g.addColorStop(1, color);
    c.globalAlpha = Math.min(1, a);
    c.strokeStyle = g;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  // Point à la distance s (0 à 1) le long du bord d'un rectangle arrondi, en partant du milieu du haut, sens horaire.
  function along(b, s) {
    const r = Math.min(b.r, b.w / 2, b.h / 2), sw = b.w - 2 * r, sh = b.h - 2 * r, arc = (Math.PI * r) / 2, total = 2 * (sw + sh) + 4 * arc;
    let d = ((((s % 1) + 1) % 1) * total + sw / 2) % total;
    const corner = (cx, cy, a0) => { const a = a0 + (d / arc) * (Math.PI / 2); return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
    if (d < sw) return { x: b.x + r + d, y: b.y };
    d -= sw;
    if (d < arc) return corner(b.x + b.w - r, b.y + r, -Math.PI / 2);
    d -= arc;
    if (d < sh) return { x: b.x + b.w, y: b.y + r + d };
    d -= sh;
    if (d < arc) return corner(b.x + b.w - r, b.y + b.h - r, 0);
    d -= arc;
    if (d < sw) return { x: b.x + b.w - r - d, y: b.y + b.h };
    d -= sw;
    if (d < arc) return corner(b.x + r, b.y + b.h - r, Math.PI / 2);
    d -= arc;
    if (d < sh) return { x: b.x, y: b.y + b.h - r - d };
    d -= sh;
    return corner(b.x + r, b.y + r, Math.PI);
  }
  const grown = (b, g) => ({ x: b.x - g, y: b.y - g, w: b.w + 2 * g, h: b.h + 2 * g, r: b.r + g });
  // Éclair : une ligne brisée entre deux points (chaque milieu est décalé), tracée trois fois, du halo au cœur.
  function bolt(c, x1, y1, x2, y2, jag, colors, a = 1, width = 1) {
    let pts = [[x1, y1], [x2, y2]];
    for (let pass = 0; pass < 4; pass++) {
      const next = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i], len = Math.hypot(bx - ax, by - ay) || 1, off = rnd(-jag, jag) / (pass + 1);
        next.push([(ax + bx) / 2 - ((by - ay) / len) * off, (ay + by) / 2 + ((bx - ax) / len) * off], pts[i]);
      }
      pts = next;
    }
    c.lineJoin = 'round';
    [[7 * width, .16, colors[0]], [3 * width, .45, colors[1]], [1.1 * width, 1, colors[2]]].forEach(([w, alpha, color]) => {
      c.globalAlpha = Math.min(1, a * alpha);
      c.strokeStyle = color;
      c.lineWidth = w;
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
    });
    return pts;
  }
  // Liste de particules : chacune avance, ralentit, tombe (ou monte) et meurt ; `each` les donne à dessiner.
  function particles() {
    const list = [];
    return {
      add(p) { p.life = 0; list.push(p); return p; },
      get n() { return list.length; },
      step(dt) {
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i];
          p.life += dt;
          if (p.life >= p.max) { list[i] = list[list.length - 1]; list.pop(); continue; }
          if (p.drag) { const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= k; }
          p.vy += (p.g || 0) * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
      },
      each(fn) { for (const p of list) fn(p, p.life / p.max); },
    };
  }
  // Effets brefs (éclats, anneaux, arcs) : chacun vit `life` secondes après un éventuel retard ; draw(e, k) avec k de 0 à 1.
  function timed() {
    const list = [];
    return {
      add(e) { e.t = -(e.delay || 0); list.push(e); return e; },
      get n() { return list.length; }, // vide : on évite le détourage derrière la carte, qui coûte
      run(dt, draw) {
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i];
          e.t += dt;
          if (e.t < 0) continue;
          if (e.t >= e.life) { list.splice(i, 1); continue; }
          draw(e, e.t / e.life);
        }
      },
    };
  }
  // Débit régulier : combien de particules créer pendant dt, à `rate` par seconde (le reste est gardé pour l'image suivante).
  function emitter() {
    let acc = 0;
    return (rate, dt) => { acc += rate * dt; const n = Math.floor(acc); acc -= n; return n; };
  }

  // ---------------------------------------------------------------- les scènes
  // Chaque scène reçoit `env` : les deux contextes (ci dans la carte, co autour), leurs tailles en pixels CSS, le
  // rectangle de la carte dans le canvas extérieur (env.card), si la page est sombre (env.dark) et la qualité q (0,65
  // sur téléphone, 1 sinon). Sur page claire, ce qui sort de la carte est posé sans addition, dans des tons plus soutenus :
  // une lumière additionnée à du blanc ne se voit pas.
  const SCENES = {};

  // 🔥 Fire — une forge : des flammes montent dans la carte, des braises s'en échappent, chaque chiffre est un coup de
  // marteau (gerbe d'étincelles), la révélation un embrasement.
  SCENES.fire = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const flames = particles(), tongues = particles(), embers = particles(), sparks = particles(), rings = timed(), flashes = timed();
    const emitFlame = emitter(), emitEmber = emitter(), emitOut = emitter();
    const HOT = ['#fff4b8', '#ffc640', '#ff7d1a', '#e8391a']; // du cœur aux pointes
    const OUT = dark ? HOT : ['#ffb02e', '#ff7a14', '#ec4413', '#b8240d'], blend = dark ? 'lighter' : 'source-over';
    let heat = 0, target = .55, flare = 0, pillar = 0; // le foyer prend en une demi-seconde
    const flame = (list, x, y, power, size) => list.add({ x, y, vx: rnd(-9, 9), vy: -rnd(62, 150) * power, max: rnd(.42, .86), size: size * rnd(.7, 1.3), sway: rnd(TAU), drag: .5 });
    const spark = (x, y, angle, speed) => sparks.add({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, g: 640, drag: 1.4, max: rnd(.45, 1), size: rnd(1, 2) });
    const ember = (x, y, boost = 1) => embers.add({ x, y, vx: rnd(-16, 16), vy: -rnd(30, 105) * boost, drag: .22, max: rnd(1.4, 3.2), size: rnd(1, 2.4), sway: rnd(TAU), wob: rnd(1.5, 3.5) });
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3.5);
        flare = Math.max(0, flare - dt * 2.2);
        pillar = Math.max(0, pillar - dt);
        // Dans la carte : le lit de braises, puis des langues de flamme étroites qui montent derrière les chiffres.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, '#ff5a14', w / 2, h * 1.05, w * (.44 + .06 * Math.sin(t * 5.3)), .22 + .22 * heat + flare * .5);
        dot(ci, '#ffc640', w / 2, h + 3, w * .52, (.3 + .25 * Math.sin(t * 9.1) * Math.sin(t * 3.7)) * Math.min(1.2, heat), h * .2);
        for (let n = emitFlame(w * .95 * heat * q, dt); n > 0; n--) flame(flames, rnd(3, w - 3), h + rnd(0, 7), .5 + heat * .5, h * .115);
        flames.step(dt);
        flames.each((p, k) => {
          p.x += Math.sin(t * 8 + p.sway) * 14 * dt;
          const r = p.size * (1 - .62 * k);
          dot(ci, HOT[k < .14 ? 0 : k < .36 ? 1 : k < .66 ? 2 : 3], p.x, p.y, r, .62 * (1 - k) * Math.min(1, heat * 1.5), r * (2.3 - .9 * k));
        });
        // Autour : halo de chaleur, flammes qui dépassent du haut de la carte quand ça chauffe fort.
        co.globalCompositeOperation = blend;
        co.lineCap = 'round';
        dot(co, '#ff5a14', card.x + card.w / 2, card.y + card.h * .5, card.w * (.62 + .25 * flare), (dark ? .16 : .1) * heat + flare * .3);
        const over = Math.max(0, heat - .95) + pillar * 1.4;
        for (let n = emitOut(card.w * .7 * over * q, dt); n > 0; n--) flame(tongues, rnd(card.x + 6, card.x + card.w - 6), card.y + rnd(0, 6), .7 + over * (pillar ? 1.3 : .6), card.h * .13);
        tongues.step(dt);
        tongues.each((p, k) => {
          p.x += Math.sin(t * 6 + p.sway) * 20 * dt;
          const r = p.size * (1.1 - .6 * k);
          dot(co, OUT[k < .2 ? 1 : k < .6 ? 2 : 3], p.x, p.y, r, .55 * (1 - k), r * (2.1 - .8 * k));
        });
        // Braises : elles montent en zigzaguant, scintillent et s'éteignent en rougissant.
        for (let n = emitEmber((6 + 26 * heat) * q, dt); n > 0; n--) {
          const side = Math.random() < .22;
          ember(side ? (Math.random() < .5 ? card.x + rnd(-2, 6) : card.x + card.w - rnd(-2, 6)) : rnd(card.x + 8, card.x + card.w - 8), side ? rnd(card.y, card.y + card.h * .6) : card.y + rnd(-2, 8), .6 + heat * .7);
        }
        embers.step(dt);
        embers.each((p, k) => {
          p.x += Math.sin(t * p.wob + p.sway) * 24 * dt;
          const a = (k < .1 ? k / .1 : 1 - (k - .1) / .9) * (.6 + .4 * Math.sin(t * 22 + p.sway));
          dot(co, OUT[k < .5 ? 1 : 3], p.x, p.y, p.size * 3.2, a * (dark ? .9 : .75));
          dot(co, OUT[0], p.x, p.y, p.size * 1.15, a);
        });
        // Étincelles : des traits qui retombent, du blanc-jaune au rouge.
        sparks.step(dt);
        sparks.each((p, k) => {
          line(co, OUT[k < .3 ? 0 : k < .65 ? 1 : 2], p.px, p.py, p.x, p.y, p.size * (1 - .5 * k), 1 - k * k);
          p.px = lerp(p.px, p.x, .42);
          p.py = lerp(p.py, p.y, .42);
        });
        flashes.run(dt, (f, k) => {
          dot(co, OUT[1], f.x, f.y, f.size * (.7 + 1.1 * outExpo(k)), (1 - k) * .8);
          dot(co, OUT[0], f.x, f.y, f.size * .45, (1 - k) * (1 - k));
        });
        // Anneaux de feu : des flammèches réparties sur un contour qui s'élargit autour de la carte.
        rings.run(dt, (r, k) => {
          const e = outCubic(k), path = grown(card, r.grow * e * Math.min(card.w, 260) * .3), n = Math.round(84 * q), a = 1 - k;
          roundRect(co, path.x, path.y, path.w, path.h, path.r);
          co.shadowColor = OUT[2];
          co.shadowBlur = 16;
          co.globalAlpha = a * a * .55;
          co.strokeStyle = OUT[2];
          co.lineWidth = (5 + 9 * a) * r.width;
          co.stroke();
          co.shadowBlur = 0;
          co.globalAlpha = a * .85;
          co.strokeStyle = OUT[0];
          co.lineWidth = 1.6 * r.width * (1 - .5 * k);
          co.stroke();
          for (let i = 0; i < n; i++) {
            const p = along(path, (i + r.phase) / n), size = (4 + 9 * (1 - k)) * r.width * (.7 + .6 * Math.sin(i * 7.3 + t * 30));
            dot(co, OUT[i % 3 ? 2 : 1], p.x, p.y, size, (1 - k) * (1 - k) * .75, size * 1.5);
            if (!(i % 4)) dot(co, OUT[0], p.x, p.y, size * .4, (1 - k) * .9);
          }
        });
      },
      lock(p, o) { // coup de marteau : une gerbe d'étincelles part du haut du chiffre, qui reste lisible
        const top = p.y - card.h * .26, n = Math.round((o.ghost ? 5 : o.last ? 38 : 16) * q);
        for (let i = 0; i < n; i++) spark(p.x + rnd(-7, 7), top + rnd(-3, 5), -Math.PI / 2 + rnd(-1.15, 1.15), rnd(130, o.last ? 520 : 350));
        for (let i = 0; i < (o.ghost ? 1 : o.last ? 9 : 4); i++) ember(p.x + rnd(-10, 10), top, 1.7);
        flashes.add({ x: p.x, y: top, size: card.h * (o.ghost ? .14 : o.last ? .5 : .3), life: o.last ? .34 : .2 });
        flare = Math.max(flare, o.ghost ? .2 : o.last ? 1 : .55);
        heat = Math.min(1.5, heat + (o.ghost ? .05 : .22));
        if (o.last) { target = .5; rings.add({ life: .7, grow: .6, width: .8, phase: rnd() }); }
      },
      build() { target = 1.35; }, // le foyer s'emballe avant le dernier chiffre
      reveal(tier) {
        const p = POWER[tier], cx = card.x + card.w / 2, cy = card.y + card.h / 2;
        if (!p) { // tirage raté : le feu retombe, quelques braises paresseuses
          heat = .12; target = .32;
          for (let i = 0; i < 9; i++) embers.add({ x: rnd(card.x + 20, card.x + card.w - 20), y: card.y + rnd(0, 10), vx: rnd(-8, 8), vy: -rnd(14, 34), drag: .3, max: rnd(1.4, 2.4), size: rnd(.8, 1.4), sway: rnd(TAU), wob: 2 });
          return;
        }
        for (let i = burst(p, 250 * q, 6); i > 0; i--) { const a = rnd(TAU); spark(cx + Math.cos(a) * card.w * .46, cy + Math.sin(a) * card.h * .46, a - .25 * Math.sin(a), rnd(140, 300 + 600 * p)); }
        for (let i = burst(p, 80 * q, 3); i > 0; i--) ember(rnd(card.x, card.x + card.w), rnd(card.y, card.y + card.h * .5), 1.2 + 1.6 * p);
        flashes.add({ x: cx, y: cy, size: card.h * (.2 + 1.2 * p), life: .25 + .3 * p });
        flare = .25 + 1.15 * p;
        heat = .8 + 1.1 * p;
        target = .42 + .38 * p;
        if (p >= .25) rings.add({ life: .8, grow: .2 + 1.4 * p, width: .5 + 1 * p, phase: rnd() });
        if (p > .55) rings.add({ delay: .14, life: .9, grow: .8 + 1.5 * p, width: .7 + .6 * p, phase: rnd() });
        if (p >= 1) { rings.add({ delay: .3, life: 1, grow: 3.3, width: 1.5, phase: rnd() }); pillar = 1.25; }
      },
    };
  };

  // 🌌 Galaxy — un hublot sur l'espace : on file en vitesse lumière pendant que ça tourne, chaque chiffre est une
  // étoile qui s'allume, et la révélation une supernova.
  SCENES.galaxy = env => {
    const { ci, co, w, h, W, H, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, far = Math.hypot(card.w, card.h) * .5;
    const STAR = dark ? ['#ffffff', '#d8ccff', '#a5d8ff'] : ['#7c3aed', '#6366f1', '#db2777'], WHITE = dark ? '#ffffff' : '#8b5cf6';
    const stars = Array.from({ length: Math.round(70 * q) }, () => ({ a: rnd(TAU), r: rnd(.02, 1), z: rnd(.35, 1), c: pick(['#ffffff', '#ffffff', '#d8ccff', '#a5d8ff', '#f5b8ff']), tw: rnd(TAU) }));
    const rays = Array.from({ length: Math.round(54 * q) }, () => ({ a: rnd(TAU), d: rnd(), z: rnd(.4, 1), c: pick(STAR) }));
    const clouds = [['#7c3aed', .3, .45, 0], ['#db2777', .72, .6, 2.1], ['#2563eb', .5, .3, 4.2], ['#a855f7', .2, .7, 5.3]].map(([c, x, y, ph]) => ({ c, x, y, ph }));
    const motes = particles(), flares = timed(), rings = timed(), meteors = timed(), lens = timed();
    let warp = 0, target = .55, nebula = 1, core = 0, dim = 0, nextMeteor = 6; // on part à l'arrêt, puis le saut
    const meteor = inside => meteors.add({ inside, life: rnd(.5, .8), x: inside ? rnd(-.1, .5) : pick([rnd(.02, .2), rnd(.72, .9)]), y: inside ? rnd(-.2, .2) : rnd(.04, .3), len: inside ? rnd(.3, .5) : rnd(.1, .17), dir: Math.random() < .5 ? 1 : -1 });
    return {
      frame(t, dt) {
        warp += (target - warp) * Math.min(1, dt * (target < warp ? 7 : 2.4));
        nebula += (1 - nebula) * Math.min(1, dt * .9);
        core = Math.max(0, core - dt * 1.4);
        dim = Math.max(0, dim - dt * .8);
        // Dans la carte : nébuleuse qui tourne lentement, puis les étoiles, traits pendant le saut, points à l'arrêt.
        ci.globalCompositeOperation = 'lighter';
        ci.lineCap = co.lineCap = 'round';
        for (const n of clouds) dot(ci, n.c, w * (n.x + .09 * Math.sin(t * .23 + n.ph)), h * (n.y + .16 * Math.cos(t * .19 + n.ph)), h * 1.25, .17 * nebula * (1 - dim * .8));
        const mx = w / 2, my = h / 2, reach = Math.hypot(w, h) * .62;
        for (const s of stars) {
          const speed = (.05 + warp * 1.5) * s.z;
          s.r += s.r * speed * dt * 2.4 + .012 * speed * dt;
          if (s.r > 1.9) { s.r = rnd(.015, .12); s.a = rnd(TAU); }
          const cos = Math.cos(s.a), sin = Math.sin(s.a), d = s.r * reach, len = Math.min(d, d * warp * .55 * s.z + .5);
          const a = clamp(s.r * 3) * (.55 + .45 * Math.sin(t * 3 + s.tw)) * (1 - dim * .85), x = mx + cos * d, y = my + sin * d;
          if (warp > .12) tail(ci, s.c, x - cos * len, y - sin * len, x, y, .8 + s.z * 1.2, a);
          else dot(ci, s.c, x, y, 1.2 + s.z * 2.2, a);
        }
        dot(ci, '#ffffff', mx, my, h * (.5 + .9 * core), core * .9 + clamp(warp - .8) * .3);
        nextMeteor -= dt;
        if (nextMeteor < 0 && warp < .1) { meteor(true); nextMeteor = rnd(3.5, 7); }
        // Autour : tant qu'on file, les étoiles débordent du hublot en rayons qui fuient vers l'extérieur.
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        if (warp > .14) for (const s of rays) {
          s.d += (.2 + warp * 1.5) * s.z * (.35 + s.d) * dt;
          if (s.d > 1) { s.d = 0; s.a = rnd(TAU); }
          const cos = Math.cos(s.a), sin = Math.sin(s.a) * .66, head = far * (.95 + s.d * 2.1), len = far * warp * .42 * s.z * (.25 + s.d);
          tail(co, s.c, cx + cos * (head - len), cy + sin * (head - len), cx + cos * head, cy + sin * head, 1 + s.z * 1.1, clamp((warp - .14) * 1.5) * Math.sin(Math.PI * Math.min(1, s.d * 1.15)) * (dark ? .8 : .6));
        }
        meteors.run(dt, (m, k) => {
          const c = m.inside ? ci : co, mw = m.inside ? w : W, mh = m.inside ? h : H, e = outCubic(k), a = Math.sin(Math.PI * k);
          const x = mw * (m.x + m.dir * e * (m.inside ? .7 : .12)), y = mh * (m.y + e * (m.inside ? .75 : .2)), L = mw * m.len * a;
          tail(c, m.inside ? '#ffffff' : WHITE, x - m.dir * L, y - L * .6, x, y, m.inside ? 1.4 : 1.8, a);
          dot(c, m.inside ? '#ffffff' : WHITE, x, y, m.inside ? 3 : 4.5, a);
        });
        // Poussières d'étoiles, éclats en croix sur les chiffres qui se posent, reflet d'objectif, ondes de la supernova.
        motes.step(dt);
        motes.each((p, k) => dot(co, p.c, p.x, p.y, p.size * (1 + .6 * Math.sin(t * 9 + p.tw)), (1 - k) * (.5 + .5 * Math.sin(t * 13 + p.tw))));
        flares.run(dt, (f, k) => {
          const a = 1 - outCubic(k), s = f.size * (.5 + .7 * outExpo(k));
          dot(co, dark ? '#c4b5fd' : '#a855f7', f.x, f.y, s * .9, a * .8);
          dot(co, '#ffffff', f.x, f.y, s * .34, a);
          dot(co, WHITE, f.x, f.y, s * 2.6, a * .9, Math.max(1.2, s * .07));
          dot(co, WHITE, f.x, f.y, Math.max(1.2, s * .07), a * .8, s * 1.5);
          if (f.big) { const d = s * .8; line(co, WHITE, f.x - d, f.y - d, f.x + d, f.y + d, 1, a * .45); line(co, WHITE, f.x - d, f.y + d, f.x + d, f.y - d, 1, a * .45); }
        });
        lens.run(dt, (l, k) => {
          const a = 1 - outCubic(k), reachX = card.w * (.5 + .7 * outExpo(k));
          dot(co, dark ? '#c4b5fd' : '#a855f7', cx, cy, reachX, a * .55, 5);
          dot(co, WHITE, cx, cy, reachX * .8, a * .9, 1.6);
        });
        rings.run(dt, (r, k) => {
          const e = outCubic(k), rx = card.w * (.3 + r.grow * e), ry = card.h * (.5 + r.grow * e * 1.1), a = 1 - k;
          const stroke = (color, width, alpha, shift = 0) => { co.beginPath(); co.ellipse(cx + shift, cy, rx, ry, 0, 0, TAU); co.globalAlpha = alpha; co.strokeStyle = color; co.lineWidth = width; co.stroke(); };
          stroke(r.color, r.width * (1 - .6 * k) * 7, a * a * .22);
          stroke(r.color, r.width * (1 - .6 * k) * 2.4, a * .8);
          stroke('#67e8f9', Math.max(.6, r.width * .5), a * .5, 2.5 * r.width);
          stroke(WHITE, Math.max(.6, r.width * (1 - .7 * k) * .6), a);
        });
      },
      lock(p, o) { // sortie de vitesse lumière : une étoile s'allume sur le chiffre
        flares.add({ x: p.x, y: p.y, size: card.h * (o.ghost ? .16 : o.last ? .52 : .32), life: o.last ? .75 : .5, big: o.last });
        for (let i = Math.round((o.ghost ? 2 : o.last ? 16 : 7) * q); i > 0; i--) {
          const a = rnd(TAU), v = rnd(18, o.last ? 150 : 80);
          motes.add({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .7, drag: 1.6, max: rnd(.6, 1.3), size: rnd(1.6, 3.4), c: pick(STAR), tw: rnd(TAU) });
        }
        if (o.last) { target = 0; core = .55; rings.add({ life: 1, grow: .55, width: 1.3, color: '#a78bfa' }); lens.add({ life: .7 }); }
      },
      build() { target = 1.75; }, // on accélère encore avant le dernier chiffre
      reveal(tier) {
        const p = POWER[tier];
        target = 0;
        if (!p) { dim = 1; nebula = .25; return; } // tirage raté : les étoiles pâlissent un instant
        core = .15 + .85 * p;
        nebula = 1.2 + 3 * p;
        flares.add({ x: cx, y: cy, size: card.h * (.22 + 1.2 * p), life: .6 + .7 * p, big: p > .4 });
        if (p >= .25) lens.add({ life: .5 + .6 * p });
        rings.add({ life: 1.05, grow: .25 + 1.3 * p, width: .7 + 2.1 * p, color: '#f0abfc' });
        if (p > .4) rings.add({ delay: .12, life: 1.05, grow: .7 + 1.3 * p, width: 1 + 1.3 * p, color: '#a78bfa' });
        if (p > .75) rings.add({ delay: .26, life: 1.15, grow: 1 + 1.5 * p, width: .9 + 1.1 * p, color: '#67e8f9' });
        for (let i = burst(p, 190 * q, 8); i > 0; i--) {
          const a = rnd(TAU), v = rnd(40, 130 + 450 * p);
          motes.add({ x: cx + Math.cos(a) * card.w * .25, y: cy + Math.sin(a) * card.h * .3, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .72, drag: 1.3, max: rnd(.8, 1.5 + 1.6 * p), size: rnd(1.6, 3 + 2.5 * p), c: pick(STAR.concat(dark ? ['#f0abfc', '#67e8f9'] : ['#db2777', '#0891b2'])), tw: rnd(TAU) });
        }
        for (let i = 0; i < Math.round(4 * p); i++) setTimeout(() => meteor(false), 300 + i * 380);
        nextMeteor = 2.5;
      },
    };
  };

  // 💡 Neon — une enseigne la nuit : le courant est instable pendant que ça tourne (arcs entre deux points du cadre,
  // lumière qui court le long), chaque chiffre s'amorce dans un éclair, et la révélation est une surtension.
  SCENES.neon = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const PINK = '#ff4fd8', CYAN = '#33e6ff', BOLT = [PINK, CYAN, dark ? '#ffffff' : '#ff2fd0'], HOTS = dark ? [PINK, CYAN, '#ffd6f6'] : ['#ff2fd0', '#0bbbd6', '#c026d3'];
    const sparks = particles(), blooms = timed(), arcs = timed(), strikes = timed();
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, dk = dark ? 1 : .6;
    let lit = 0, speed = 0, target = .6, pos = 0, unstable = 1, surge = 0, dead = 0, nextArc = .05, chasers = 1; // le courant arrive : un premier arc tout de suite
    const spark = (x, y, angle, v, color) => sparks.add({ x, y, px: x, py: y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, g: 780, drag: .9, max: rnd(.35, .8), size: rnd(.8, 1.7), c: color });
    return {
      frame(t, dt) {
        speed += (target - speed) * Math.min(1, dt * 2.2);
        pos += speed * dt;
        surge = Math.max(0, surge - dt * 1.1);
        dead = Math.max(0, dead - dt);
        const hum = 1 + .08 * Math.sin(t * 61) + (dead > 0 ? -.6 + .4 * Math.sin(t * 43) * Math.sin(t * 17) : 0);
        // Dans la carte : lueur des tubes derrière les chiffres allumés, reflet qui se promène en bas.
        ci.globalCompositeOperation = 'lighter';
        const level = (.12 + .5 * lit) * hum + surge * .5;
        dot(ci, PINK, w * .5, h * .5, w * .55, level * .42);
        dot(ci, CYAN, w * (.5 + .3 * Math.sin(t * .7)), h * 1.1, w * .34, level * .3);
        // Autour : halo de l'enseigne sur le mur et reflet au sol.
        co.globalCompositeOperation = 'lighter';
        co.lineCap = 'round';
        dot(co, PINK, cx, cy, card.w * (.72 + .3 * surge), Math.min(.34, level * .2 + surge * .2) * dk);
        dot(co, PINK, cx, card.y + card.h * 1.42, card.w * .62, (level * .55 + surge * .4) * dk, card.w * .1);
        dot(co, CYAN, cx + card.w * .12 * Math.sin(t * .9), card.y + card.h * 1.42, card.w * .36, (level * .35 + surge * .3) * dk, card.w * .06);
        // Lumières qui courent le long du cadre : une tête blanche et sa traîne.
        for (let c = 0; c < chasers; c++) {
          const dir = c % 2 ? -1 : 1, color = c % 2 ? CYAN : PINK, head = pos * dir + c / chasers, steps = 34;
          for (let i = steps; i >= 0; i--) {
            const p = along(card, head - dir * i * .0042 * (1 + speed * .7)), a = 1 - i / steps;
            dot(co, color, p.x, p.y, 3 + 5 * a, a * a * (.4 + .35 * clamp(speed)) * hum);
          }
          const p = along(card, head);
          dot(co, dark ? '#ffffff' : color, p.x, p.y, 3.5, .95 * hum);
        }
        // Arcs électriques entre deux points du cadre tant que le courant est instable.
        nextArc -= dt * unstable * (1 + speed);
        if (nextArc < 0) {
          nextArc = rnd(.1, .38);
          const s = rnd(), a = along(card, s), b = along(card, s + rnd(.06, .16));
          arcs.add({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, life: rnd(.07, .14), jag: 7, width: 1 });
        }
        arcs.run(dt, (a, k) => bolt(co, a.x1, a.y1, a.x2, a.y2, a.jag, BOLT, 1 - k, a.width));
        strikes.run(dt, (s, k) => {
          const pts = bolt(co, s.x1, s.y1, s.x2, s.y2, s.jag, BOLT, 1 - k, s.width);
          if (s.fork) { const m = pts[(pts.length * .55) | 0]; bolt(co, m[0], m[1], m[0] + s.fx, m[1] + s.fy, s.jag * .6, BOLT, (1 - k) * .7, s.width * .7); }
        });
        blooms.run(dt, (b, k) => {
          dot(co, PINK, b.x, b.y, b.size * (.6 + .9 * outExpo(k)), (1 - k) * b.a * dk);
          dot(co, '#ffffff', b.x, b.y, b.size * .4 * (1 - .4 * k), (1 - k) * (1 - k) * b.a * dk);
        });
        if (!dark) co.globalCompositeOperation = 'source-over';
        sparks.step(dt);
        sparks.each((p, k) => {
          line(co, k < .3 && dark ? '#ffffff' : p.c, p.px, p.py, p.x, p.y, p.size * (1 - .4 * k), 1 - k * k);
          p.px = lerp(p.px, p.x, .5);
          p.py = lerp(p.py, p.y, .5);
        });
      },
      lock(p, o) { // le tube s'amorce : un éclair tombe du cadre sur le chiffre, qui s'illumine
        lit = Math.min(1, lit + (o.ghost ? .04 : 1 / 6));
        if (!o.ghost) strikes.add({ x1: p.x + rnd(-14, 14), y1: card.y, x2: p.x, y2: p.y - card.h * .2, life: o.last ? .26 : .17, jag: 6, width: o.last ? 1.5 : 1 });
        blooms.add({ x: p.x, y: p.y, size: card.h * (o.ghost ? .2 : o.last ? .8 : .5), life: o.last ? .6 : .4, a: .7 });
        for (let i = Math.round((o.ghost ? 2 : o.last ? 22 : 8) * q); i > 0; i--) spark(p.x + rnd(-6, 6), p.y + card.h * .26, Math.PI / 2 + rnd(-1.2, 1.2), rnd(60, o.last ? 300 : 190), pick(HOTS));
        if (o.last) { // tous les tubes sont allumés : le courant se stabilise, des étincelles sautent des quatre coins
          unstable = .12; target = .22; lit = 1; surge = .6;
          for (let i = 0; i < 4; i++) { const c = along(card, .125 + i * .25); for (let n = Math.round(7 * q); n > 0; n--) spark(c.x, c.y, rnd(TAU), rnd(60, 220), pick(HOTS)); }
        }
      },
      build() { target = 2.6; unstable = 4.5; chasers = 2; }, // le courant s'emballe avant le dernier chiffre
      reveal(tier) {
        const p = POWER[tier];
        if (!p) { dead = 1.3; surge = 0; for (let i = 0; i < 3; i++) spark(cx + rnd(-30, 30), card.y + card.h, Math.PI / 2 + rnd(-.5, .5), rnd(40, 90), HOTS[0]); return; } // tirage raté : le tube manque de lâcher
        surge = .2 + .8 * p;
        chasers = 1 + Math.round(3 * p);
        speed = 1.6 + 2.2 * p;
        target = .16;
        blooms.add({ x: cx, y: cy, size: card.w * (.2 + .44 * p), life: .5 + .5 * p, a: .16 + .3 * p });
        for (let i = Math.round(9 * p); i > 0; i--) { // la foudre part des bords de l'enseigne
          const from = along(card, rnd()), a = Math.atan2(from.y - cy, (from.x - cx) * .6), len = rnd(40, 70 + 170 * p);
          strikes.add({ x1: from.x, y1: from.y, x2: from.x + Math.cos(a) * len, y2: from.y + Math.sin(a) * len, delay: rnd(0, .25), life: rnd(.2, .34), jag: 9 + 10 * p, width: 1 + p, fork: p > .55, fx: rnd(-40, 40), fy: rnd(-34, 34) });
        }
        for (let i = burst(p, 165 * q, 6); i > 0; i--) { const from = along(card, rnd()); spark(from.x, from.y, Math.atan2(from.y - cy, from.x - cx) + rnd(-.7, .7), rnd(80, 260 + 380 * p), pick(HOTS)); }
        setTimeout(() => { chasers = 1; }, 1400 + 1400 * p);
      },
    };
  };

  // ---------------------------------------------------------------- scènes à morceaux
  // Les autres skins partagent une même mécanique : des morceaux de leur matière (cubes de terre, bonbons, dés, bulles,
  // pièces, éclats de glace…) flottent autour de la carte, jaillissent du chiffre qui se pose et explosent à la
  // révélation. Chaque skin donne ses formes, ses couleurs et sa physique ; les formes sont dessinées pleines, donc
  // lisibles sur page claire comme sur page sombre.
  const SHAPES = {
    square(c, p, s) { c.fillRect(-s, -s, 2 * s, 2 * s); },
    // Cube de terre : face verte au-dessus, terre dessous, un pixel plus clair.
    cube(c, p, s) { c.fillStyle = '#7a4f2a'; c.fillRect(-s, -s, 2 * s, 2 * s); c.fillStyle = p.c; c.fillRect(-s, -s, 2 * s, s * .75); c.fillStyle = 'rgba(255,255,255,.28)'; c.fillRect(-s, -s, s * .7, s * .4); c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(s * .2, s * .1, s * .5, s * .5); },
    // Vermicelle de sucre : bâtonnet arrondi et brillant.
    sprinkle(c, p, s) { c.beginPath(); c.lineCap = 'round'; c.strokeStyle = p.c; c.lineWidth = s * .9; c.moveTo(-s * 1.3, 0); c.lineTo(s * 1.3, 0); c.stroke(); c.strokeStyle = 'rgba(255,255,255,.6)'; c.lineWidth = s * .25; c.beginPath(); c.moveTo(-s * .9, -s * .22); c.lineTo(s * .2, -s * .22); c.stroke(); },
    // Bonbon rond et glacé.
    drop(c, p, s) { c.beginPath(); c.arc(0, 0, s, 0, TAU); c.fill(); c.fillStyle = 'rgba(255,255,255,.7)'; c.beginPath(); c.arc(-s * .35, -s * .35, s * .32, 0, TAU); c.fill(); },
    // Petit dé blanc avec ses points.
    die(c, p, s) { roundRect(c, -s, -s, 2 * s, 2 * s, s * .35); c.fillStyle = '#fafafa'; c.fill(); c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; c.stroke(); c.fillStyle = p.c; for (const [x, y] of p.pips) { c.beginPath(); c.arc(x * s * .5, y * s * .5, s * .2, 0, TAU); c.fill(); } },
    bubble(c, p, s) { c.beginPath(); c.arc(0, 0, s, 0, TAU); c.strokeStyle = p.c; c.lineWidth = 1.2; c.stroke(); c.fillStyle = 'rgba(255,255,255,.55)'; c.beginPath(); c.arc(-s * .35, -s * .35, s * .22, 0, TAU); c.fill(); },
    coin(c, p, s) { c.scale(Math.cos(p.life * 9 + p.rot), 1); c.beginPath(); c.arc(0, 0, s, 0, TAU); c.fill(); c.strokeStyle = 'rgba(120,70,0,.55)'; c.lineWidth = 1; c.stroke(); c.fillStyle = 'rgba(255,255,255,.6)'; c.fillRect(-s * .5, -s * .5, s * .35, s); },
    shard(c, p, s) { c.beginPath(); c.moveTo(0, -s * 1.5); c.lineTo(s * .7, s * .3); c.lineTo(-s * .2, s * 1.3); c.lineTo(-s * .7, -s * .1); c.closePath(); c.fill(); c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = .8; c.stroke(); },
    gem(c, p, s) { c.beginPath(); c.moveTo(0, -s * 1.3); c.lineTo(s, -s * .2); c.lineTo(0, s * 1.4); c.lineTo(-s, -s * .2); c.closePath(); c.fill(); c.fillStyle = 'rgba(255,255,255,.7)'; c.beginPath(); c.moveTo(0, -s * 1.3); c.lineTo(s * .35, -s * .2); c.lineTo(-s * .35, -s * .2); c.closePath(); c.fill(); },
    star(c, p, s) { c.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? s * .4 : s * 1.3, a = (i * Math.PI) / 4; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); } c.closePath(); c.fill(); },
    glyph(c, p, s) { c.font = `700 ${s * 3}px monospace`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(p.ch, 0, 0); },
    seg(c, p, s) { c.fillRect(-s * 1.5, -s * .35, s * 3, s * .7); },
    ball(c, p, s) { c.beginPath(); c.arc(0, 0, s, 0, TAU); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#111'; c.lineWidth = 1; c.stroke(); c.fillStyle = '#111'; c.beginPath(); c.arc(0, 0, s * .38, 0, TAU); c.fill(); },
    spark(c, p, s) { c.fillRect(-s * 2, -s * .3, s * 4, s * .6); },
    // Mini-guimauve : un petit cylindre arrondi, mat, avec un reflet poudré en haut et un liseré pour la page claire.
    mallow(c, p, s) { roundRect(c, -s, -s * .8, 2 * s, 1.6 * s, s * .65); c.fill(); c.strokeStyle = 'rgba(190,80,140,.45)'; c.lineWidth = .8; c.stroke(); c.fillStyle = 'rgba(255,255,255,.75)'; c.beginPath(); c.ellipse(0, -s * .45, s * .7, s * .22, 0, 0, TAU); c.fill(); },
  };
  const PIPS = [[[0, 0]], [[-1, -1], [1, 1]], [[-1, -1], [0, 0], [1, 1]], [[-1, -1], [1, -1], [-1, 1], [1, 1]], [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]];
  // cfg : cols (couleurs), shapes, size [min, max], g (gravité, négative = ça monte), spin, glowc (lueur), ring,
  // live (ce qui vit en continu : rays, grid, chase, bulbs, flashes, arcs, sweep, waves, twinkle, scan),
  // drift (morceaux qui flottent : { rate, from: 'top' | 'bottom' | 'around', vy }), up (jaillit vers le haut), chars.
  const pieces = cfg => env => {
    const { ci, co, w, h, card, q, dark } = env;
    const bits = particles(), rings = timed(), pops = timed(), emit = emitter();
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    let energy = 0, target = .5, flash = 0;
    const bit = (x, y, angle, speed, o = {}) => bits.add(Object.assign({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, g: cfg.g, drag: cfg.drag || .8, max: rnd(.7, 1.5) * (cfg.life || 1),
      size: rnd(cfg.size[0], cfg.size[1]), c: pick(cfg.cols), shape: pick(cfg.shapes), rot: rnd(TAU), vr: rnd(-1, 1) * (cfg.spin === undefined ? 7 : cfg.spin),
      pips: pick(PIPS), ch: cfg.chars ? pick(cfg.chars) : '',
    }, o));
    return {
      frame(t, dt) {
        energy += (target - energy) * Math.min(1, dt * 3);
        flash = Math.max(0, flash - dt * 2);
        ci.globalCompositeOperation = 'lighter';
        dot(ci, cfg.glowc, w / 2, h * (cfg.g < 0 ? 1.05 : .5), w * .5, (.1 + .22 * energy + flash * .5) * (.85 + .15 * Math.sin(t * 6)));
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        dot(co, cfg.glowc, cx, cy, card.w * (.66 + .3 * flash), ((dark ? .12 : .07) * energy + flash * .28));
        const L = cfg.live || {}, hot = energy + flash, add = dark ? 'lighter' : 'source-over';
        co.lineCap = 'round';
        if (L.rays) { // faisceaux qui tournent derrière la carte
          co.globalCompositeOperation = add;
          L.rays.forEach((c, i) => { const a = t * .5 + (i * TAU) / L.rays.length, r = card.w * (.7 + .25 * hot); tail(co, c, cx + Math.cos(a) * r, cy + Math.sin(a) * r * .6, cx + Math.cos(a) * card.w * .56, cy + Math.sin(a) * card.h * .8, 10 + 8 * hot, (dark ? .2 : .14) * (.5 + Math.min(1, hot))); }); // ils partent du bord de la carte : les chiffres restent nets
        }
        if (L.grid) { // sol en perspective qui défile sous la carte
          co.globalCompositeOperation = add;
          const top = card.y + card.h + 10, depth = card.h * 1.1;
          for (let i = 0; i < 6; i++) { const k = ((i + t * (.6 + hot)) % 6) / 6, y = top + depth * k * k; line(co, L.grid, cx - card.w * (.55 + .5 * k), y, cx + card.w * (.55 + .5 * k), y, 1.2, .5 * (1 - k) + .15); }
          for (let i = -5; i <= 5; i++) line(co, L.grid, cx + i * card.w * .1, top, cx + i * card.w * .21, top + depth, 1, .3);
        }
        if (L.chase) for (let c = 0; c < L.chase.length; c++) { // lumières qui courent le long du cadre
          co.globalCompositeOperation = 'lighter';
          const dir = c % 2 ? -1 : 1, head = dir * t * (.25 + .9 * hot) + c / L.chase.length;
          for (let i = 22; i >= 0; i--) { const q2 = along(card, head - dir * i * .005), a = 1 - i / 22; dot(co, L.chase[c], q2.x, q2.y, 3 + 4 * a, a * a * (.35 + .4 * Math.min(1, hot))); }
        }
        if (L.bulbs) { // ampoules autour du cadre, allumées à tour de rôle
          co.globalCompositeOperation = 'lighter';
          const n = 22, lit = Math.floor(t * (3 + 9 * hot));
          for (let i = 0; i < n; i++) { const q2 = along(grown(card, 5), i / n), on = (i + lit) % 3 === 0 || flash > .5; dot(co, L.bulbs, q2.x, q2.y, on ? 6 : 3, on ? .9 : .25); if (on) dot(co, '#ffffff', q2.x, q2.y, 2, .9); }
        }
        if (L.flashes && Math.random() < dt * (2 + 26 * hot)) pops.add({ x: rnd(card.x - 90, card.x + card.w + 90), y: rnd(card.y - 70, card.y + card.h + 50), size: rnd(8, 18), life: .22 }); // flashs des tribunes
        if (L.arcs && Math.random() < dt * (1.5 + 10 * hot)) { const a0 = rnd(), a = along(card, a0), b = along(card, a0 + rnd(.05, .14)); co.globalCompositeOperation = 'lighter'; bolt(co, a.x, a.y, b.x, b.y, 6, [L.arcs[0], L.arcs[1], dark ? '#ffffff' : L.arcs[0]], .9); }
        ci.globalCompositeOperation = 'lighter';
        if (L.sweep) { const k = (t * (.35 + .5 * hot)) % 1.6; dot(ci, L.sweep, w * (k * 1.4 - .4), h * .5, h * .5, .35 + .3 * flash, h * 1.4); } // reflet qui traverse la carte
        if (L.waves) for (let i = 0; i < 4; i++) dot(ci, L.waves, w * (.5 + .5 * Math.sin(t * (.5 + i * .13) + i * 2)), h * (.25 + .2 * i), w * .3, .12 + .1 * hot, h * .12); // reflets d'eau
        if (L.twinkle) for (let i = 0; i < 7; i++) { const ph = t * 1.7 + i * 1.9, k = ph % 1, sx = Math.sin(Math.floor(ph) * 12.9 + i * 78.2) * .5 + .5, sy = Math.sin(Math.floor(ph) * 3.7 + i * 11.1) * .5 + .5, a = Math.sin(Math.PI * k) * (.5 + .5 * Math.min(1, hot)); dot(ci, '#ffffff', w * sx, h * sy, 2.2, a); dot(ci, L.twinkle, w * sx, h * sy, 9, a * .6, 1.2); dot(ci, L.twinkle, w * sx, h * sy, 1.2, a * .6, 9); } // scintillements en croix
        if (L.scan) { const y = ((t * (.5 + hot)) % 1) * h; dot(ci, L.scan, w / 2, y, w * .7, .25 + .2 * flash, 3); } // ligne de balayage
        co.globalCompositeOperation = 'source-over';
        const d = cfg.drift;
        for (let n = emit(d.rate * (.5 + energy) * q, dt); n > 0; n--) {
          if (d.from === 'bottom') bit(rnd(card.x, card.x + card.w), card.y + card.h + rnd(0, 8), Math.PI / 2 + rnd(-.3, .3), rnd(10, 40), { g: Math.abs(cfg.g) * .4, max: rnd(1, 2) });
          else if (d.from === 'around') { const a = along(grown(card, 10), rnd()); bit(a.x, a.y, rnd(TAU), rnd(6, 26), { g: 0, max: rnd(1, 2.2), size: rnd(cfg.size[0], cfg.size[1]) * .8 }); }
          else bit(rnd(card.x + 6, card.x + card.w - 6), card.y + rnd(-2, 6), -Math.PI / 2 + rnd(-.5, .5), rnd(18, 60) * (.6 + energy), { g: -Math.abs(cfg.g) * .08 - 12, max: rnd(1.2, 2.6), size: rnd(cfg.size[0], cfg.size[1]) * .8 });
        }
        bits.step(dt);
        bits.each((p, k) => {
          co.save();
          co.translate(p.x, p.y);
          co.rotate(p.rot + p.vr * p.life);
          co.globalAlpha = k < .12 ? k / .12 : Math.min(1, (1 - k) * 2.2);
          co.fillStyle = p.c;
          SHAPES[p.shape](co, p, p.size);
          co.restore();
        });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        pops.run(dt, (f, k) => { dot(co, cfg.glowc, f.x, f.y, f.size * (.6 + 1.1 * outExpo(k)), (1 - k) * .75); dot(co, '#ffffff', f.x, f.y, f.size * .4, (1 - k) * (1 - k) * (dark ? 1 : .6)); });
        rings.run(dt, (r, k) => {
          const g = grown(card, r.grow * outCubic(k) * Math.min(card.w, 260) * .3), a = 1 - k;
          roundRect(co, g.x, g.y, g.w, g.h, cfg.square ? 2 : g.r);
          co.globalAlpha = a * a * .35; co.strokeStyle = cfg.ring; co.lineWidth = (4 + 8 * a) * r.width; co.stroke();
          co.globalAlpha = a * .9; co.lineWidth = 1.8 * r.width; co.stroke();
        });
      },
      lock(p, o) {
        const n = Math.round((o.ghost ? 3 : o.last ? 26 : 11) * q), top = p.y - card.h * .2;
        for (let i = 0; i < n; i++) bit(p.x + rnd(-8, 8), cfg.up ? top : p.y + rnd(-6, 6), cfg.up ? -Math.PI / 2 + rnd(-1.1, 1.1) : rnd(TAU), rnd(70, o.last ? 330 : 220));
        pops.add({ x: p.x, y: cfg.up ? top : p.y, size: card.h * (o.ghost ? .14 : o.last ? .5 : .3), life: o.last ? .4 : .25 });
        flash = Math.max(flash, o.ghost ? .15 : o.last ? .9 : .45);
        energy = Math.min(1.4, energy + (o.ghost ? .04 : .18));
        if (o.last) { target = .4; rings.add({ life: .7, grow: .6, width: .8 }); }
      },
      build() { target = 1.3; },
      reveal(tier) {
        const p = POWER[tier];
        if (!p) { energy = .05; target = .25; return; }
        for (let i = burst(p, 210 * q, 6); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.6, .6); bit(from.x, from.y, cfg.up ? a - .5 : a, rnd(90, 240 + 480 * p), { max: rnd(.8, 1.4 + 1.2 * p) * (cfg.life || 1), size: rnd(cfg.size[0], cfg.size[1]) * (1 + .5 * p) }); }
        pops.add({ x: cx, y: cy, size: card.h * (.25 + 1.1 * p), life: .3 + .3 * p });
        flash = .25 + 1.1 * p; energy = .8 + .8 * p; target = .35 + .35 * p;
        if (p >= .25) rings.add({ life: .85, grow: .2 + 1.4 * p, width: .6 + p });
        if (p > .55) rings.add({ delay: .14, life: .95, grow: .8 + 1.6 * p, width: .5 + .7 * p });
        if (p >= 1) rings.add({ delay: .3, life: 1.05, grow: 3.2, width: 1.4 });
      },
    };
  };
  const RAINBOW = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  Object.assign(SCENES, {
    // Ceux qui ont une vraie matière : des morceaux d'elle.
    blocks: pieces({ cols: ['#5fb043', '#4c9a34', '#6cc24a'], shapes: ['cube', 'cube', 'square'], size: [3.5, 7], g: 760, spin: 5, up: true, glowc: '#7ddc4f', ring: '#6cc24a', square: true, drift: { rate: 5, from: 'bottom' } }),
    candy: pieces({ live: { twinkle: '#ffffff', sweep: '#ffffff', rays: ['#ff7ab8', '#ffd23f', '#5ce1e6', '#b388ff', '#7ee081', '#ff8a5c'] }, cols: ['#ff5fa2', '#ffd23f', '#5ce1e6', '#b388ff', '#7ee081', '#ff8a5c'], shapes: ['sprinkle', 'sprinkle', 'drop', 'star'], size: [2.6, 5], g: 420, drag: 1.1, up: true, life: 1.3, glowc: '#ff7ab8', ring: '#ff8ac2', drift: { rate: 7, from: 'top' } }),
    dice: pieces({ live: { bulbs: '#fbbf24', sweep: '#bbf7d0' }, cols: ['#dc2626', '#111827'], shapes: ['die'], size: [5, 8], g: 820, spin: 11, up: true, glowc: '#f87171', ring: '#ef4444', drift: { rate: 2.5, from: 'bottom' } }),
    gold: pieces({ live: { sweep: '#fff7c2', twinkle: '#fde68a', rays: ['#fbbf24', '#fde68a', '#f59e0b', '#fde68a', '#fbbf24', '#fde68a'] }, cols: ['#fbbf24', '#f59e0b', '#fde68a'], shapes: ['coin', 'coin', 'star'], size: [3.5, 6.5], g: 700, spin: 0, up: true, glowc: '#fbbf24', ring: '#fcd34d', drift: { rate: 6, from: 'top' } }),
    ice: pieces({ live: { twinkle: '#e0f7ff', sweep: '#e0f7ff', chase: ['#7dd3fc'] }, cols: ['#bfe9ff', '#7dd3fc', '#e0f7ff'], shapes: ['shard', 'shard', 'star'], size: [2.5, 5.5], g: 360, drag: 1.3, life: 1.3, glowc: '#7dd3fc', ring: '#bae6fd', drift: { rate: 7, from: 'bottom' } }),
    diamond: pieces({ live: { twinkle: '#ffffff', sweep: '#ffffff', rays: ['#a5f3fc', '#f0abfc', '#c7d2fe', '#fde68a', '#a5f3fc', '#f0abfc', '#c7d2fe', '#fde68a'] }, cols: ['#a5f3fc', '#f0abfc', '#c7d2fe', '#ffffff'], shapes: ['gem', 'gem', 'star'], size: [2.6, 5.5], g: 300, drag: 1.2, life: 1.4, glowc: '#a5f3fc', ring: '#e0e7ff', drift: { rate: 6, from: 'around' } }),
    ocean: pieces({ live: { waves: '#7dd3fc', sweep: '#bae6fd' }, cols: ['#7dd3fc', '#38bdf8', '#bae6fd'], shapes: ['bubble'], size: [2.5, 7], g: -150, drag: 1.6, spin: 0, life: 1.6, up: true, glowc: '#38bdf8', ring: '#7dd3fc', drift: { rate: 9, from: 'top' } }),
    slots: pieces({ live: { bulbs: '#fbbf24', sweep: '#fff7c2' }, cols: ['#fbbf24', '#f59e0b'], shapes: ['coin'], size: [4, 7], g: 900, spin: 0, up: true, glowc: '#ef4444', ring: '#fbbf24', drift: { rate: 3, from: 'bottom' } }),
    jersey: pieces({ live: { flashes: true, sweep: '#ffffff' }, cols: ['#22c55e', '#16a34a'], shapes: ['ball', 'square'], size: [3.5, 6], g: 700, up: true, glowc: '#4ade80', ring: '#22c55e', drift: { rate: 3, from: 'bottom' } }),
    pixel: pieces({ live: { scan: '#22d3ee', chase: ['#22d3ee', '#f472b6'] }, cols: ['#22d3ee', '#f472b6', '#facc15', '#4ade80'], shapes: ['square'], size: [2.5, 5], g: 520, spin: 0, up: true, glowc: '#22d3ee', ring: '#f472b6', square: true, drift: { rate: 6, from: 'top' } }),
    // Ceux qui sont surtout une lumière : étincelles et signes à leur couleur.
    lcd: pieces({ live: { scan: '#3f5a2c' }, cols: ['#3f5a2c', '#5b7a3d'], shapes: ['seg'], size: [2.5, 4.5], g: 0, drag: 2, spin: 0, glowc: '#b6d38c', ring: '#7c9a5a', square: true, drift: { rate: 4, from: 'around' } }),
    scoreboard: pieces({ live: { bulbs: '#fbbf24', flashes: true }, cols: ['#fbbf24', '#f97316'], shapes: ['square'], size: [1.6, 3], g: 500, spin: 0, up: true, glowc: '#fbbf24', ring: '#f59e0b', square: true, drift: { rate: 6, from: 'top' } }),
    chrome: pieces({ live: { sweep: '#ffffff', twinkle: '#ffffff' }, cols: ['#e5e7eb', '#9ca3af', '#f9fafb'], shapes: ['star', 'spark'], size: [2, 4.5], g: 0, drag: 2.2, glowc: '#e5e7eb', ring: '#d1d5db', drift: { rate: 5, from: 'around' } }),
    circuit: pieces({ live: { chase: ['#34d399', '#fde047'], arcs: ['#34d399', '#6ee7b7'] }, cols: ['#34d399', '#6ee7b7', '#fde047'], shapes: ['spark', 'square'], size: [1.6, 3.2], g: 0, drag: 2.4, spin: 0, glowc: '#34d399', ring: '#6ee7b7', square: true, drift: { rate: 7, from: 'around' } }),
    matrix: pieces({ live: { scan: '#00ff41', chase: ['#00ff41'] }, cols: ['#00ff41', '#7dffa0'], shapes: ['glyph'], chars: 'ｱｶｻﾀﾅﾊﾏ01'.split(''), size: [2.6, 4.2], g: 260, drag: .4, spin: 0, glowc: '#00ff41', ring: '#00ff41', square: true, drift: { rate: 8, from: 'bottom' } }),
    nixie: pieces({ live: { twinkle: '#ffb347', arcs: ['#ff7a18', '#ffb347'] }, cols: ['#ffb347', '#ff7a18'], shapes: ['star', 'spark'], size: [1.8, 3.6], g: -60, drag: 1.5, up: true, life: 1.3, glowc: '#ff9a3c', ring: '#ffb347', drift: { rate: 6, from: 'top' } }),
    rainbow: pieces({ live: { rays: RAINBOW, chase: ['#ef4444', '#facc15', '#3b82f6', '#a855f7'], twinkle: '#ffffff' }, cols: RAINBOW, shapes: ['star', 'drop', 'sprinkle'], size: [2.6, 5.2], g: 380, drag: 1, up: true, life: 1.4, glowc: '#f0abfc', ring: '#a855f7', drift: { rate: 9, from: 'top' } }),
  });

  // ---------------------------------------------------------------- scènes sur mesure des autres skins
  // Chacune garde ses morceaux (pieces) et y ajoute sa propre histoire : `more(env, kit)` rend { frame, lock, build,
  // reveal } joués en plus. kit : cx, cy, state (heat de 0 à ~1,5 : la tension du tirage ; p : la force de la révélation).
  const custom = (base, more) => env => {
    const a = base(env), { card } = env, st = { heat: .3, target: .3, p: 0, since: 0, revealed: false };
    const b = more(env, { cx: card.x + card.w / 2, cy: card.y + card.h / 2, st });
    return {
      frame(t, dt) { st.heat += (st.target - st.heat) * Math.min(1, dt * 3); st.since += dt; b.frame(t, dt); a.frame(t, dt); if (b.over) b.over(t, dt); },
      lock(p, o) { st.heat = Math.min(1.5, st.heat + (o.ghost ? .03 : .15)); if (o.last) st.target = .3; a.lock(p, o); b.lock(p, o); },
      build() { st.target = 1.3; a.build(); if (b.build) b.build(); },
      reveal(tier) { st.p = POWER[tier]; st.revealed = true; st.since = 0; st.heat = .6 + st.p; st.target = .25 + .3 * st.p; a.reveal(tier); b.reveal(tier, st.p); },
    };
  };
  const text = (c, str, x, y, size, color, a) => { if (a <= .01) return; c.globalAlpha = Math.min(1, a); c.font = `800 ${size}px "Press Start 2P", ui-monospace, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = 'rgba(0,0,0,.55)'; c.fillText(str, x + 1.5, y + 1.5); c.fillStyle = color; c.fillText(str, x, y); };
  const BESPOKE = {
    // 🍬 Candy — une sucette tourne derrière la carte, chaque chiffre fait éclater une bulle de chewing-gum, la révélation est une pluie de sucre.
    candy: (env, { cx, cy, st }) => {
      const { co, card, q } = env, gums = timed(), rain = particles(), emit = emitter(), COL = ['#ff5fa2', '#ffd23f', '#5ce1e6', '#b388ff', '#7ee081'];
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
          for (let i = 0; i < 2; i++) { const r0 = card.h * .95, x = i ? card.x + card.w + r0 * .5 : card.x - r0 * .5; // deux sucettes en spirale de part et d'autre
            for (let k = 0; k < 26; k++) { const a = k * .5 + t * (1 + 2 * st.heat) * (i ? -1 : 1), r = (k / 26) * r0 * .5; dot(co, k % 2 ? '#ff5fa2' : '#ffffff', x + Math.cos(a) * r, cy + Math.sin(a) * r, 4.5, .55); }
            line(co, '#f5e6d0', x, cy + r0 * .5, x, cy + r0 * 1.15, 3, .8); }
          gums.run(dt, (g, k) => { const r = g.size * (k < .7 ? outCubic(k / .7) : 1 + (k - .7)); co.globalAlpha = k < .7 ? .85 : (1 - k) * 2.5; co.fillStyle = g.c; co.beginPath(); co.arc(g.x, g.y, r, 0, TAU); if (k < .7) co.fill(); else { co.lineWidth = 2; co.strokeStyle = g.c; co.stroke(); } co.fillStyle = 'rgba(255,255,255,.7)'; if (k < .7) { co.beginPath(); co.arc(g.x - r * .35, g.y - r * .35, r * .22, 0, TAU); co.fill(); } });
          if (st.revealed && st.since < 1 + 2.5 * st.p) for (let n = emit(90 * st.p * q, dt); n > 0; n--) rain.add({ x: rnd(card.x - 120, card.x + card.w + 120), y: card.y - 110, vx: rnd(-10, 10), vy: rnd(120, 260), max: 1.6, c: pick(COL), rot: rnd(TAU) });
          rain.step(dt);
          rain.each((p, k) => { co.save(); co.translate(p.x, p.y); co.rotate(p.rot + k * 6); co.globalAlpha = 1 - k * k; SHAPES.sprinkle(co, p, 3.2); co.restore(); });
        },
        lock(p, o) { if (!o.ghost) gums.add({ x: p.x, y: p.y - card.h * .75, size: card.h * (o.last ? .34 : .22), life: .55, c: pick(COL) }); },
        reveal(tier, p) { for (let i = Math.round(9 * p); i > 0; i--) gums.add({ delay: rnd(0, .5), x: rnd(card.x - 60, card.x + card.w + 60), y: rnd(card.y - 80, card.y + card.h + 60), size: rnd(10, 26), life: .6, c: pick(COL) }); },
      };
    },
    // 🎲 Dice — des dés sont lancés sur le tapis : un par chiffre, qui rebondit ; à la révélation, deux gros dés roulent depuis les côtés.
    dice: (env, { cx, cy, st }) => {
      const { co, card } = env, thrown = timed(), floor = card.y + card.h + 46;
      const die = (x, y, size, rot, pips, a) => { co.save(); co.translate(x, y); co.rotate(rot); co.globalAlpha = a; co.fillStyle = 'rgba(0,0,0,.3)'; co.fillRect(-size * .9, size * .9, size * 1.8, size * .25); SHAPES.die(co, { c: '#dc2626', pips }, size); co.restore(); };
      const toss = (x0, x1, size, delay = 0, life = 1.1) => thrown.add({ x0, x1, size, delay, life, pips: pick(PIPS) });
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over';
          thrown.run(dt, (d, k) => { const bounce = Math.abs(Math.sin(k * Math.PI * 2.5)) * (1 - k) * 70, x = lerp(d.x0, d.x1, outCubic(k)); die(x, floor - bounce - d.size, d.size, (1 - outCubic(k)) * 9 * Math.sign(d.x1 - d.x0), d.pips, Math.min(1, (1 - k) * 4)); });
        },
        lock(p, o) { if (!o.ghost) toss(p.x + (Math.random() < .5 ? -150 : 150), p.x + rnd(-20, 20), o.last ? 11 : 8); },
        reveal(tier, p) { for (let i = 0; i < 2 + Math.round(6 * p); i++) toss(i % 2 ? card.x - 200 : card.x + card.w + 200, cx + rnd(-card.w * .5, card.w * .5), 9 + 9 * p * Math.random(), i * .09, 1.3 + p); },
      };
    },
    // 🥇 Gold — une colonne de lumière tombe sur la carte, des éclats en croix sur chaque chiffre, et une fontaine de pièces à la révélation.
    gold: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, coins = particles(), glints = timed(), emit = emitter();
      return {
        frame(t, dt) {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          dot(co, '#fde68a', cx, card.y - 40, card.w * (.2 + .12 * st.heat), .12 + .22 * st.heat, card.h * 2.2); // colonne de lumière
          glints.run(dt, (g, k) => { const a = 1 - k, r = g.size * (.4 + outExpo(k)); dot(co, '#ffffff', g.x, g.y, r * .3, a); dot(co, '#fde68a', g.x, g.y, r * 2, a * .9, 1.6); dot(co, '#fde68a', g.x, g.y, 1.6, a * .9, r * 2); });
          co.globalCompositeOperation = 'source-over';
          if (st.revealed && st.since < .6 + 2.4 * st.p) for (let n = emit(120 * st.p * q, dt); n > 0; n--) coins.add({ x: cx + rnd(-14, 14), y: card.y, vx: rnd(-170, 170), vy: -rnd(260, 520), g: 900, max: 1.5, rot: rnd(TAU), c: pick(['#fbbf24', '#f59e0b', '#fde68a']) });
          coins.step(dt);
          coins.each((p, k) => { co.save(); co.translate(p.x, p.y); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = p.c; SHAPES.coin(co, p, 5.5); co.restore(); });
        },
        lock(p, o) { glints.add({ x: p.x + rnd(-6, 6), y: p.y - card.h * .2, size: card.h * (o.ghost ? .12 : o.last ? .5 : .28), life: .5 }); },
        reveal(tier, p) { for (let i = Math.round(3 + 12 * p); i > 0; i--) { const a = along(card, rnd()); glints.add({ delay: rnd(0, .8), x: a.x, y: a.y, size: card.h * rnd(.15, .4), life: .5 }); } },
      };
    },
    // ❄️ Ice — le givre pousse en cristaux sur chaque chiffre, le blizzard se lève avant le dernier, et la carte éclate à la révélation.
    ice: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, crystals = timed(), snow = particles(), emit = emitter(), C = dark ? '#e0f7ff' : '#38bdf8';
      const flake = (x, y, r, rot, a) => { co.save(); co.translate(x, y); co.rotate(rot); co.globalAlpha = a; co.strokeStyle = C; co.lineWidth = 1.2; for (let i = 0; i < 6; i++) { co.rotate(TAU / 6); co.beginPath(); co.moveTo(0, 0); co.lineTo(0, -r); co.moveTo(0, -r * .55); co.lineTo(r * .25, -r * .8); co.moveTo(0, -r * .55); co.lineTo(-r * .25, -r * .8); co.stroke(); } co.restore(); };
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
          for (let n = emit((14 + 90 * st.heat) * q, dt); n > 0; n--) snow.add({ x: card.x - 150, y: rnd(card.y - 90, card.y + card.h + 70), vx: rnd(120, 260) * (.4 + st.heat), vy: rnd(10, 50), max: rnd(1.2, 2.4), size: rnd(1, 2.4) });
          snow.step(dt);
          snow.each((p, k) => dot(co, C, p.x, p.y + Math.sin(t * 3 + p.x * .02) * 4, p.size * 2.2, Math.sin(Math.PI * k) * .8));
          crystals.run(dt, (c, k) => flake(c.x, c.y, c.size * outCubic(Math.min(1, k * 2.2)), c.rot + k * (c.spin || 0), Math.min(1, (1 - k) * 2.5)));
        },
        lock(p, o) { if (!o.ghost) crystals.add({ x: p.x, y: p.y - card.h * .62, size: card.h * (o.last ? .4 : .25), rot: rnd(1), life: 1 }); },
        reveal(tier, p) { for (let i = Math.round(4 + 16 * p); i > 0; i--) crystals.add({ delay: rnd(0, .4), x: rnd(card.x - 110, card.x + card.w + 110), y: rnd(card.y - 90, card.y + card.h + 70), size: rnd(8, 14 + 22 * p), rot: rnd(TAU), spin: rnd(-1.5, 1.5), life: 1.2 + p }); },
      };
    },
    // 💎 Diamond — des rayons se croisent et se réfractent dans la gemme ; chaque chiffre allume une facette, la révélation ouvre un éventail arc-en-ciel.
    diamond: (env, { cx, cy, st }) => {
      const { co, card, dark } = env, facets = timed(), FAN = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#38bdf8', '#6366f1', '#d946ef'];
      return {
        frame(t, dt) {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          for (let i = 0; i < 3; i++) { const a = t * (.4 + .5 * st.heat) + i * 2.1, x = cx + Math.cos(a) * card.w * .9; tail(co, '#ffffff', x, card.y - 90, cx + (x - cx) * .1, cy, 2 + 2 * st.heat, .25 + .3 * st.heat); } // lasers blancs qui entrent
          if (st.revealed) { const k = Math.min(1, st.since / .5), fade = Math.max(0, 1 - st.since / (2.5 + 3 * st.p)); FAN.forEach((c, i) => { const a = Math.PI * (.12 + .76 * (i / 6)) , r = card.w * (.5 + 1.1 * st.p) * outCubic(k); tail(co, c, cx + Math.cos(a) * card.w * .3, cy + card.h * .5, cx + Math.cos(a) * r, cy + card.h * .5 + Math.sin(a) * r * .8, 7 + 9 * st.p, fade * .55); }); } // éventail arc-en-ciel qui sort par le bas
          co.globalCompositeOperation = 'source-over';
          facets.run(dt, (f, k) => { const r = f.size * (.4 + outExpo(k)); co.globalAlpha = 1 - k; co.strokeStyle = dark ? '#ffffff' : '#7dd3fc'; co.lineWidth = 1.6; co.beginPath(); for (let i = 0; i <= 6; i++) { const a = i * TAU / 6 + f.rot; co.lineTo(f.x + Math.cos(a) * r, f.y + Math.sin(a) * r); } co.stroke(); for (let i = 0; i < 3; i++) { const a = i * TAU / 6 + f.rot; co.beginPath(); co.moveTo(f.x + Math.cos(a) * r, f.y + Math.sin(a) * r); co.lineTo(f.x - Math.cos(a) * r, f.y - Math.sin(a) * r); co.globalAlpha = (1 - k) * .4; co.stroke(); } });
        },
        lock(p, o) { facets.add({ x: p.x, y: p.y, size: card.h * (o.ghost ? .18 : o.last ? .7 : .4), rot: rnd(1), life: .6 }); },
        reveal(tier, p) { for (let i = 0; i < 1 + Math.round(4 * p); i++) facets.add({ delay: i * .1, x: cx, y: cy, size: card.w * (.3 + .25 * i), rot: i * .3, life: .9 }); },
      };
    },
    // 🌊 Ocean — la surface ondule sous la carte, chaque chiffre fait une éclaboussure et des ronds dans l'eau, la révélation soulève une vague.
    ocean: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, drops = particles(), ripples = timed(), sea = card.y + card.h + 34, C = dark ? '#7dd3fc' : '#0284c7';
      let surge = 0;
      return {
        frame(t, dt) {
          surge = Math.max(0, surge - dt * .6);
          co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
          for (let layer = 0; layer < 3; layer++) { co.beginPath(); for (let x = card.x - 140; x <= card.x + card.w + 140; x += 8) { const y = sea + layer * 9 - surge * 46 * Math.exp(-Math.pow((x - cx) / (card.w * .6), 2)) + Math.sin(x * .035 + t * (1.6 + layer * .5) + layer) * (3 + 7 * st.heat); x === card.x - 140 ? co.moveTo(x, y) : co.lineTo(x, y); } co.globalAlpha = .7 - layer * .2; co.strokeStyle = C; co.lineWidth = 2.2 - layer * .5; co.stroke(); }
          ripples.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = C; co.lineWidth = 1.5; co.beginPath(); co.ellipse(r.x, sea, r.size * outCubic(k), r.size * outCubic(k) * .22, 0, 0, TAU); co.stroke(); });
          drops.step(dt);
          drops.each((p, k) => { dot(co, C, p.x, p.y, p.size * 2.4, (1 - k) * .9); dot(co, '#ffffff', p.x - 1, p.y - 1, p.size, (1 - k) * .8); });
        },
        lock(p, o) { if (o.ghost) return; ripples.add({ x: p.x, size: o.last ? 90 : 46, life: .9 }); for (let i = Math.round((o.last ? 20 : 9) * q); i > 0; i--) drops.add({ x: p.x + rnd(-6, 6), y: sea, vx: rnd(-90, 90), vy: -rnd(120, o.last ? 330 : 230), g: 700, max: rnd(.5, .9), size: rnd(1.2, 2.6) }); },
        reveal(tier, p) { surge = p; for (let i = 0; i < 1 + Math.round(3 * p); i++) ripples.add({ delay: i * .16, x: cx, size: card.w * (.5 + .5 * p + i * .2), life: 1.2 }); for (let i = burst(p, 130 * q, 5); i > 0; i--) drops.add({ x: cx + rnd(-card.w * .5, card.w * .5), y: sea, vx: rnd(-160, 160), vy: -rnd(160, 300 + 380 * p), g: 760, max: rnd(.7, 1.3), size: rnd(1.4, 3.2) }); },
      };
    },
    // 🎰 Slots — la machine sonne : une pièce tombe à chaque chiffre, les gyrophares tournent, et le jackpot déverse ses pièces par le bas.
    slots: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, coins = particles(), pops = timed(), emit = emitter(), tray = card.y + card.h + 52;
      return {
        frame(t, dt) {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          if (st.heat > .8 || (st.revealed && st.p > .4 && st.since < 3 + 3 * st.p)) for (let i = 0; i < 2; i++) { const a = t * 5 * (i ? -1 : 1), x = i ? card.x + card.w + 26 : card.x - 26, y = card.y - 22; dot(co, '#ef4444', x, y, 9, .9); tail(co, '#ef4444', x, y, x + Math.cos(a) * 130, y + Math.sin(a) * 60, 16, .28); tail(co, '#ef4444', x, y, x - Math.cos(a) * 130, y - Math.sin(a) * 60, 16, .28); } // gyrophares
          co.globalCompositeOperation = 'source-over';
          if (st.revealed && st.since < .5 + 3 * st.p) for (let n = emit(110 * st.p * q, dt); n > 0; n--) coins.add({ x: cx + rnd(-card.w * .3, card.w * .3), y: card.y + card.h, vx: rnd(-60, 60), vy: rnd(40, 160), g: 700, max: 1.1, rot: rnd(TAU), bounce: tray });
          coins.step(dt);
          coins.each((p, k) => { if (p.y > p.bounce && p.vy > 0) { p.vy *= -.45; p.y = p.bounce; } co.save(); co.translate(p.x, p.y); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = '#fbbf24'; SHAPES.coin(co, p, 5); co.restore(); });
          pops.run(dt, (f, k) => text(co, f.str, f.x, f.y - 30 * outCubic(k), f.size, f.c, (1 - k) * 2));
        },
        lock(p, o) { if (!o.ghost) { coins.add({ x: p.x, y: card.y + card.h, vx: rnd(-30, 30), vy: 60, g: 700, max: 1, rot: rnd(TAU), bounce: tray }); if (o.last) pops.add({ x: p.x, y: card.y - 14, str: 'DING!', size: 11, c: '#fde047', life: .9 }); } },
        reveal(tier, p) { if (p > .4) pops.add({ x: cx, y: card.y - 30, str: p >= 1 ? 'JACKPOT!' : p >= .8 ? 'BIG WIN!' : 'WIN!', size: 13 + 7 * p, c: '#fde047', life: 1.6 + p }); },
      };
    },
    // ⚽ Jersey — soir de match : un ballon traverse à chaque chiffre, la tribune fait la ola avant le dernier, et les rubans pleuvent au but.
    jersey: (env, { cx, cy, st }) => {
      const { co, card, q } = env, balls = timed(), ribbons = particles(), pops = timed(), stand = card.y + card.h + 44;
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
          for (let i = 0; i < 26; i++) { const x = card.x - 60 + (i / 25) * (card.w + 120), wave = Math.max(0, Math.sin(t * 5 - i * .45)) * 13 * Math.max(0, st.heat - .25); dot(co, i % 2 ? '#d7263d' : '#ffffff', x, stand - wave, 4.2, .85); dot(co, '#0b1f4d', x, stand + 7 - wave * .5, 5.5, .8, 6); } // la tribune, qui fait la ola
          balls.run(dt, (b, k) => { const x = lerp(b.x0, b.x1, k), y = b.y - Math.sin(Math.PI * k) * b.h; for (let i = 1; i < 6; i++) dot(co, '#ffffff', lerp(b.x0, b.x1, k - i * .02), b.y - Math.sin(Math.PI * (k - i * .02)) * b.h, 4 - i * .5, .25); co.save(); co.translate(x, y); co.rotate(k * 14); co.globalAlpha = 1; SHAPES.ball(co, {}, 7); co.restore(); });
          ribbons.step(dt);
          ribbons.each((p, k) => { co.globalAlpha = 1 - k * k; co.strokeStyle = p.c; co.lineWidth = 2.6; co.beginPath(); for (let i = 0; i < 5; i++) co.lineTo(p.x + Math.sin(t * 9 + p.ph + i) * 6, p.y - i * 6); co.stroke(); });
          pops.run(dt, (f, k) => text(co, f.str, f.x, f.y, f.size * (.6 + .5 * outExpo(k)), '#ffffff', (1 - k) * 2));
        },
        lock(p, o) { if (!o.ghost) { const left = Math.random() < .5; balls.add({ x0: left ? card.x - 150 : card.x + card.w + 150, x1: p.x, y: p.y - card.h * .5, h: o.last ? 80 : 46, life: .5 }); } },
        reveal(tier, p) { for (let i = burst(p, 110 * q, 4); i > 0; i--) ribbons.add({ x: rnd(card.x - 130, card.x + card.w + 130), y: card.y - rnd(60, 130), vx: rnd(-20, 20), vy: rnd(50, 140), max: rnd(1.4, 2.6), c: pick(['#d7263d', '#ffffff', '#f5c518', '#0b1f4d']), ph: rnd(TAU) }); if (p > .4) pops.add({ x: cx, y: card.y - 34, str: p >= 1 ? 'GOOOAL!' : 'GOAL!', size: 15 + 8 * p, life: 1.5 + p }); },
      };
    },
    // 👾 Pixel — borne d'arcade : « +100 » à chaque chiffre, une barre de puissance se remplit, et l'écran affiche le bonus à la révélation.
    pixel: (env, { cx, cy, st }) => {
      const { co, card } = env, pops = timed(), booms = timed();
      let locked = 0, fade = 1, over = false;
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over';
          // La barre colle au bas de la carte et s'efface après la révélation : avant, elle restait 30 px plus bas, pile
          // sur la rareté et le « Top x % » affichés sous la carte (signalé par un joueur le 2026-10-13).
          if (over) fade = Math.max(0, fade - dt / .7);
          const bw = card.w * .7, bx = cx - bw / 2, by = card.y + card.h + 5, n = 12, fill = Math.round(n * Math.min(1, locked / 6 + Math.max(0, st.heat - .5) * .25));
          if (fade > 0) for (let i = 0; i < n; i++) { co.globalAlpha = (i < fill ? 1 : .22) * fade; co.fillStyle = i < fill ? ['#4ade80', '#4ade80', '#facc15', '#f472b6'][Math.min(3, (i / 3) | 0)] : '#64748b'; co.fillRect(Math.round(bx + i * (bw / n)), by, Math.round(bw / n) - 3, 5); } // barre de puissance
          booms.run(dt, (b, k) => { const r = b.size * outCubic(k); co.globalAlpha = 1 - k; co.fillStyle = b.c; for (let i = 0; i < 8; i++) { const a = i * TAU / 8; for (let j = 1; j <= 3; j++) co.fillRect(Math.round((b.x + Math.cos(a) * r * j / 3) / 4) * 4, Math.round((b.y + Math.sin(a) * r * j / 3) / 4) * 4, 4, 4); } });
          pops.run(dt, (f, k) => text(co, f.str, f.x, f.y - 26 * outCubic(k), f.size, f.c, (1 - k) * 2.5));
        },
        lock(p, o) { if (o.ghost) return; locked++; pops.add({ x: p.x, y: p.y - card.h * .6, str: o.last ? '+500' : '+100', size: 9, c: o.last ? '#facc15' : '#4ade80', life: .8 }); booms.add({ x: p.x, y: p.y, size: card.h * (o.last ? .9 : .5), c: '#22d3ee', life: .4 }); },
        reveal(tier, p) { over = true; pops.add({ x: cx, y: card.y - 30, str: p >= 1 ? 'PERFECT!!' : p >= .8 ? 'HIGH SCORE' : p > .4 ? 'COMBO x' + Math.round(2 + 8 * p) : p ? 'OK' : 'GAME OVER', size: 10 + 6 * p, c: p ? '#facc15' : '#f87171', life: 1.6 + p }); for (let i = Math.round(8 * p); i > 0; i--) booms.add({ delay: rnd(0, 1.2 * p), x: rnd(card.x - 110, card.x + card.w + 110), y: rnd(card.y - 90, card.y + card.h + 40), size: rnd(18, 40), c: pick(['#22d3ee', '#f472b6', '#facc15', '#4ade80']), life: .5 }); },
      };
    },
    // 📟 LCD — vieille calculette : des signes de calcul flottent, chaque chiffre fait « bip », et le résultat s'affiche à la révélation.
    lcd: (env, { cx, cy, st }) => {
      const { co, card, dark } = env, pops = timed(), C = dark ? '#b6d38c' : '#3f5a2c', emit = emitter();
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over';
          for (let n = emit(1.2 + 5 * st.heat, dt); n > 0; n--) pops.add({ x: rnd(card.x - 80, card.x + card.w + 80), y: rnd(card.y - 60, card.y + card.h + 50), str: pick(['+', '−', '×', '÷', '=', '%', '√']), size: rnd(9, 15), drift: 14, life: 1.4, soft: .5 });
          pops.run(dt, (f, k) => text(co, f.str, f.x, f.y - (f.drift || 24) * k, f.size, C, Math.sin(Math.PI * k) * (f.soft || 1) * 1.6));
        },
        lock(p, o) { if (!o.ghost) pops.add({ x: p.x, y: p.y - card.h * .62, str: o.last ? '=' : 'bip', size: o.last ? 15 : 8, life: .6 }); },
        reveal(tier, p) { pops.add({ x: cx, y: card.y - 28, str: p >= .8 ? '= 8008135' : p > .4 ? '= OK!' : p ? '= ok' : 'Err', size: 10 + 5 * p, life: 1.8 + p, drift: 8 }); },
      };
    },
    // 🏟️ Scoreboard — le stade : deux projecteurs balaient, le tableau clignote à chaque chiffre, feux d'artifice et sirène au but.
    scoreboard: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, rockets = timed(), sparks = particles(), pops = timed();
      return {
        frame(t, dt) {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          for (let i = 0; i < 2; i++) { const a = Math.sin(t * (.9 + st.heat) + i * 2.4) * .7, x0 = i ? card.x + card.w + 90 : card.x - 90, y0 = card.y - 110; tail(co, '#fff7c2', x0 + Math.sin(a) * 260 * (i ? -1 : 1), y0 + 250, x0, y0, 22, .12 + .14 * st.heat); dot(co, '#fff7c2', x0, y0, 7, .9); } // projecteurs
          rockets.run(dt, (r, k) => { if (!r.done && k > .35) { r.done = true; for (let i = Math.round(40 * q); i > 0; i--) { const a = rnd(TAU), v = rnd(50, 170); sparks.add({ x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 90, drag: 1.5, max: rnd(.7, 1.2), c: r.c }); } } else if (!r.done) dot(co, '#ffffff', r.x, lerp(card.y, r.y, k / .35), 3, 1); });
          sparks.step(dt);
          sparks.each((p, k) => dot(co, p.c, p.x, p.y, 3.2, (1 - k) * (.6 + .4 * Math.sin(t * 40 + p.x))));
          co.globalCompositeOperation = 'source-over';
          pops.run(dt, (f, k) => text(co, f.str, f.x, f.y, f.size, Math.floor(k * 12) % 2 ? '#fbbf24' : '#fff7c2', (1 - k) * 3));
        },
        lock(p, o) { if (o.last) pops.add({ x: cx, y: card.y - 24, str: '• • •', size: 10, life: .5 }); },
        reveal(tier, p) { if (p > .4) pops.add({ x: cx, y: card.y - 30, str: p >= 1 ? 'CHAMPIONS!' : 'GOAL!', size: 12 + 7 * p, life: 1.6 + p }); for (let i = 0; i < Math.round(8 * p); i++) rockets.add({ delay: i * .25, life: .9, x: rnd(card.x - 100, card.x + card.w + 100), y: card.y - rnd(40, 120), c: pick(['#fbbf24', '#f87171', '#60a5fa', '#ffffff']) }); },
      };
    },
    // 🪞 Chrome — métal poli : un reflet d'objectif balaie à chaque chiffre, des gouttes de mercure giclent à la révélation.
    chrome: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, flares = timed(), drops = particles();
      return {
        frame(t, dt) {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          flares.run(dt, (f, k) => { const a = 1 - outCubic(k), r = f.size * (.5 + outExpo(k)); dot(co, dark ? '#ffffff' : '#94a3b8', f.x, f.y, r * 3, a * .9, 2); dot(co, '#ffffff', f.x, f.y, r * .4, a); dot(co, '#93c5fd', f.x + r * 1.2, f.y, r * .25, a * .6); dot(co, '#fda4af', f.x - r * 1.6, f.y, r * .18, a * .6); });
          co.globalCompositeOperation = 'source-over';
          drops.step(dt);
          drops.each((p, k) => { co.globalAlpha = Math.min(1, (1 - k) * 3); const g = co.createRadialGradient(p.x - p.size * .3, p.y - p.size * .3, 0, p.x, p.y, p.size); g.addColorStop(0, '#ffffff'); g.addColorStop(.5, '#cbd5e1'); g.addColorStop(1, '#475569'); co.fillStyle = g; co.beginPath(); co.ellipse(p.x, p.y, p.size, p.size * (1 + Math.min(.6, Math.abs(p.vy) / 600)), 0, 0, TAU); co.fill(); });
        },
        lock(p, o) { flares.add({ x: p.x, y: p.y, size: card.h * (o.ghost ? .2 : o.last ? .9 : .5), life: .6 }); },
        reveal(tier, p) { flares.add({ x: cx, y: cy, size: card.w * (.3 + .5 * p), life: .8 + .5 * p }); for (let i = burst(p, 90 * q, 3); i > 0; i--) { const a = -Math.PI / 2 + rnd(-1.3, 1.3), v = rnd(120, 300 + 380 * p); drops.add({ x: cx + rnd(-card.w * .4, card.w * .4), y: card.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 820, max: rnd(.8, 1.4), size: rnd(2, 5 + 4 * p) }); } },
      };
    },
    // 🔌 Circuit — des pistes de cuivre poussent autour de la carte ; chaque chiffre y envoie une impulsion, tout s'allume à la révélation.
    circuit: (env, { cx, cy, st }) => {
      const { co, card, dark } = env, pulses = timed(), C = dark ? '#34d399' : '#059669';
      const traces = Array.from({ length: 14 }, (_, i) => { const a = along(card, i / 14 + .02), dx = Math.sign(a.x - cx) || 1, dy = Math.sign(a.y - cy) || 1, horizontal = Math.abs(a.x - cx) / card.w > Math.abs(a.y - cy) / card.h, l1 = rnd(18, 50), l2 = rnd(16, 44), l3 = rnd(14, 40); return horizontal ? [[a.x, a.y], [a.x + dx * l1, a.y], [a.x + dx * l1, a.y + dy * l2], [a.x + dx * (l1 + l3), a.y + dy * l2]] : [[a.x, a.y], [a.x, a.y + dy * l1], [a.x + dx * l2, a.y + dy * l1], [a.x + dx * l2, a.y + dy * (l1 + l3)]]; });
      const at = (tr, k) => { const seg = Math.min(2, Math.floor(k * 3)), f = k * 3 - seg; return [lerp(tr[seg][0], tr[seg + 1][0], f), lerp(tr[seg][1], tr[seg + 1][1], f)]; };
      let grown0 = 0, lit = 0;
      return {
        frame(t, dt) {
          grown0 = Math.min(1, grown0 + dt * .6); lit = Math.max(0, lit - dt * .5);
          co.globalCompositeOperation = 'source-over'; co.lineJoin = 'miter'; co.lineCap = 'square';
          traces.forEach((tr, i) => { const k = Math.max(0, Math.min(1, grown0 * 1.6 - i * .04)); if (!k) return; co.globalAlpha = .35 + .6 * lit; co.strokeStyle = C; co.lineWidth = 1.6; co.beginPath(); co.moveTo(tr[0][0], tr[0][1]); for (let s2 = 1; s2 <= 3; s2++) { const f = Math.max(0, Math.min(1, k * 3 - (s2 - 1))); if (f > 0) co.lineTo(lerp(tr[s2 - 1][0], tr[s2][0], f), lerp(tr[s2 - 1][1], tr[s2][1], f)); } co.stroke(); if (k >= 1) { co.globalAlpha = .5 + .5 * lit; co.fillStyle = C; co.fillRect(tr[3][0] - 3, tr[3][1] - 3, 6, 6); } });
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          pulses.run(dt, (p, k) => { const [x, y] = at(traces[p.i], k); dot(co, '#fde047', x, y, 7, 1 - k * .5); dot(co, '#ffffff', x, y, 2.5, 1); });
        },
        lock(p, o) { if (o.ghost) return; for (let n = o.last ? 14 : 3; n > 0; n--) pulses.add({ i: o.last ? n - 1 : (Math.random() * 14) | 0, life: .45 }); },
        build() { for (let i = 0; i < 14; i++) pulses.add({ i, delay: i * .06, life: .4 }); },
        reveal(tier, p) { lit = p * 2; for (let w = 0; w < 1 + Math.round(5 * p); w++) for (let i = 0; i < 14; i++) pulses.add({ i, delay: w * .22 + i * .015, life: .4 }); },
      };
    },
    // 🟩 Matrix — la pluie de code tombe autour de la carte et s'emballe ; chaque chiffre est décodé dans une colonne, la révélation fige le code.
    matrix: (env, { cx, cy, st }) => {
      const { co, card, q, dark } = env, GL = 'ｱｶｻﾀﾅﾊﾏﾔﾗﾜ0123456789', C = dark ? '#00ff41' : '#15803d', beams = timed();
      const cols = Array.from({ length: Math.round(22 * q) }, () => ({ x: rnd(card.x - 150, card.x + card.w + 150), y: rnd(-200, 0), v: rnd(70, 190), n: (rnd(5, 12)) | 0 }));
      let freeze = 0;
      return {
        frame(t, dt) {
          freeze = Math.max(0, freeze - dt);
          co.globalCompositeOperation = 'source-over'; co.font = '700 11px monospace'; co.textAlign = 'center';
          for (const c of cols) { c.y += c.v * (.5 + 1.6 * st.heat) * dt * (freeze > 0 ? .05 : 1); if (c.y - c.n * 12 > env.H) { c.y = rnd(-80, 0); c.x = rnd(card.x - 150, card.x + card.w + 150); } for (let i = 0; i < c.n; i++) { co.globalAlpha = (1 - i / c.n) * (freeze > 0 ? 1 : .75); co.fillStyle = i ? C : '#eaffef'; co.fillText(GL[((c.x * 7 + i * 13 + Math.floor(t * 9)) | 0) % GL.length], c.x, c.y - i * 12); } }
          beams.run(dt, (b, k) => { co.globalAlpha = (1 - k) * .8; co.fillStyle = C; co.fillRect(b.x - 5, card.y - 120, 10, 120 * outCubic(k) + 4); dot(co, '#eaffef', b.x, card.y, 10, 1 - k); });
        },
        lock(p, o) { if (!o.ghost) beams.add({ x: p.x, life: .45 }); },
        reveal(tier, p) { freeze = .4 + 1.2 * p; },
      };
    },
    // 🔆 Nixie — tubes sous haute tension : le filament chauffe, un halo orange enfle à chaque chiffre, des filaments de plasma sortent à la révélation.
    nixie: (env, { cx, cy, st }) => {
      const { co, card, dark } = env, halos = timed(), plasma = timed();
      return {
        frame(t, dt) {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          const hum = .5 + .5 * Math.sin(t * (20 + 30 * st.heat));
          dot(co, '#ff8a2a', cx, cy, card.w * .7, (.08 + .14 * st.heat) * (.8 + .2 * hum));
          for (let i = 0; i < 6; i++) dot(co, '#ffb347', card.x + card.w * (.12 + i * .152), card.y - 6, 3 + 2 * st.heat, .4 + .4 * hum); // les têtes des tubes
          halos.run(dt, (h, k) => { dot(co, '#ff9a3c', h.x, h.y, h.size * (.5 + 1.2 * outExpo(k)), (1 - k) * .8); dot(co, '#fff1d6', h.x, h.y, h.size * .3, (1 - k) * (1 - k)); });
          plasma.run(dt, (b, k) => { const a = b.a + Math.sin(t * 6 + b.ph) * .25; bolt(co, b.x, b.y, b.x + Math.cos(a) * b.len, b.y + Math.sin(a) * b.len, 9, ['#ff7a18', '#ffb347', dark ? '#fff1d6' : '#ff7a18'], Math.sin(Math.PI * k), 1 + b.w); });
        },
        lock(p, o) { halos.add({ x: p.x, y: p.y, size: card.h * (o.ghost ? .2 : o.last ? .9 : .55), life: .6 }); },
        reveal(tier, p) { for (let i = Math.round(10 * p); i > 0; i--) { const from = along(card, rnd()); plasma.add({ x: from.x, y: from.y, a: Math.atan2(from.y - cy, from.x - cx), ph: rnd(TAU), len: rnd(40, 60 + 110 * p), w: p, delay: rnd(0, .3), life: .5 + .9 * p }); } halos.add({ x: cx, y: cy, size: card.w * (.3 + .4 * p), life: .8 }); },
      };
    },
    // 🌈 Rainbow — un arc-en-ciel se dessine au-dessus de la carte, bande après bande avec les chiffres, et se double à la révélation.
    rainbow: (env, { cx, cy, st }) => {
      const { co, card, dark } = env;
      let bands = 0, shown = 0, second = 0;
      return {
        frame(t, dt) {
          shown += (bands - shown) * Math.min(1, dt * 5); second += ((st.revealed ? st.p : 0) - second) * Math.min(1, dt * 2);
          co.globalCompositeOperation = 'source-over'; co.lineCap = 'butt';
          const arc = (r0, alpha, upto) => RAINBOW.forEach((c, i) => { const k = Math.max(0, Math.min(1, upto - i)); if (!k) return; co.globalAlpha = alpha * (dark ? .85 : .7); co.strokeStyle = c; co.lineWidth = 5.2; co.beginPath(); co.ellipse(cx, card.y + card.h * .6, r0 - i * 5, (r0 - i * 5) * .62, 0, Math.PI, Math.PI + Math.PI * k); co.stroke(); });
          arc(card.w * .62, .9, shown * 7 / 6);
          if (second > .02) arc(card.w * .62 + 46, second * .6, 7);
        },
        lock(p, o) { if (!o.ghost) bands = Math.min(6, bands + 1); if (o.last) bands = 6; },
        reveal() {},
      };
    },
  };
  for (const id of Object.keys(BESPOKE)) SCENES[id] = custom(SCENES[id], BESPOKE[id]);

  // ⛏️ Blocks — une mine en pixels, tout est carré et calé sur une grille : chaque chiffre est un bloc qu'on casse
  // (éclats de terre, de pierre et d'herbe, poussière, orbes d'XP qui filent vers le compteur), le dernier fait trembler
  // le sol, et la révélation ouvre un filon : le minerai dépend de la rareté, jusqu'aux feux d'artifice d'un Mythic.
  SCENES.blocks = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const G = 3, snap = v => Math.round(v / G) * G; // la grille de pixels
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, xpY = card.y + card.h + 58; // le compteur d'XP est sous la carte
    const chunks = particles(), dust = particles(), orbs = particles(), sparks = particles(), rings = timed(), fireworks = timed();
    const emitDust = emitter(), emitFall = emitter();
    const GROUND = [['#5fb043', '#3f8a2b'], ['#8a5a32', '#6b4423'], ['#8a5a32', '#6b4423'], ['#8d8d8d', '#6e6e6e']]; // [face, ombre]
    const ORE = { common: ['#d8d8d8', '#9a9a9a'], uncommon: ['#4ade80', '#15803d'], rare: ['#38bdf8', '#0369a1'], epic: ['#c084fc', '#7e22ce'], anomaly: ['#fbbf24', '#b45309'], mythic: ['#5eead4', '#0f766e'], celestial: ['#a5f3fc', '#0891b2'], divine: ['#fde68a', '#b45309'], infinite: ['#f5d0fe', '#7c3aed'] };
    let shake = 0, energy = 0, target = .5, glowc = '#7ddc4f', flash = 0;
    const chunk = (x, y, angle, speed, pal = pick(GROUND), size = pick([G, G, 2 * G, 2 * G, 3 * G])) => chunks.add({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, g: 900, drag: .5, max: rnd(.7, 1.5), size, pal });
    const orb = (x, y, n) => { for (let i = 0; i < n; i++) orbs.add({ x: x + rnd(-10, 10), y: y + rnd(-8, 8), vx: rnd(-120, 120), vy: -rnd(40, 220), max: rnd(.8, 1.3), size: rnd(2.5, 4.5), ph: rnd(TAU) }); };
    const square = (c, x, y, size, color) => { c.fillStyle = color; c.fillRect(snap(x - size / 2), snap(y - size / 2), size, size); };
    return {
      frame(t, dt) {
        energy += (target - energy) * Math.min(1, dt * 3);
        shake = Math.max(0, shake - dt * 3);
        flash = Math.max(0, flash - dt * 2.2);
        ci.globalCompositeOperation = 'lighter';
        dot(ci, glowc, w / 2, h * .5, w * .5, flash * .55);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        dot(co, glowc, cx, cy, card.w * (.66 + .3 * flash), (dark ? .1 : .06) * energy + flash * .3);
        co.globalCompositeOperation = 'source-over';
        // Le sol tremble quand ça chauffe : de petits éclats tombent du dessous de la carte, de la poussière monte.
        for (let n = emitFall((3 + 16 * energy * energy + 60 * shake) * q, dt); n > 0; n--) chunk(rnd(card.x, card.x + card.w), card.y + card.h + 2, Math.PI / 2 + rnd(-.4, .4), rnd(10, 70), pick(GROUND), G);
        for (let n = emitDust((4 + 10 * energy) * q, dt); n > 0; n--) dust.add({ x: rnd(card.x, card.x + card.w), y: card.y + card.h * rnd(.2, 1), vx: rnd(-10, 10), vy: -rnd(8, 30), max: rnd(1, 2.2), size: pick([G, 2 * G]) });
        dust.step(dt);
        dust.each((p, k) => { co.globalAlpha = .3 * Math.sin(Math.PI * k); square(co, p.x, p.y, p.size, dark ? '#cfc7b8' : '#8a7f6c'); });
        chunks.step(dt);
        chunks.each((p, k) => {
          co.globalAlpha = Math.min(1, (1 - k) * 3);
          square(co, p.x, p.y, p.size, p.pal[1]);
          co.fillStyle = p.pal[0];
          co.fillRect(snap(p.x - p.size / 2), snap(p.y - p.size / 2), p.size, Math.max(G, p.size - G)); // dessus clair, dessous dans l'ombre
        });
        // Orbes d'XP : elles jaillissent, puis sont aspirées par le compteur d'XP sous la carte.
        orbs.step(dt);
        orbs.each((p, k) => {
          const pull = clamp((k - .25) / .5) * 14 * dt;
          p.vx += (cx - p.x) * pull * 6; p.vy += (xpY - p.y) * pull * 6;
          p.vx *= 1 - Math.min(.5, pull); p.vy *= 1 - Math.min(.5, pull);
          const a = Math.min(1, (1 - k) * 4), pulse = .5 + .5 * Math.sin(t * 14 + p.ph);
          co.globalAlpha = a; square(co, p.x, p.y, p.size * 2, pulse > .5 ? '#d9f99d' : '#84cc16');
          square(co, p.x, p.y, G, '#fefce8');
        });
        sparks.step(dt);
        sparks.each((p, k) => { co.globalAlpha = (1 - k) * (.6 + .4 * Math.sin(t * 40 + p.ph)); square(co, p.x, p.y, p.size, k < .3 ? '#ffffff' : p.c); });
        // Feux d'artifice en pixels : une fusée monte, puis une boule d'étincelles carrées.
        fireworks.run(dt, (f, k) => {
          if (k < .3) { co.globalAlpha = 1; square(co, f.x, lerp(card.y, f.y, outCubic(k / .3)), 2 * G, '#ffffff'); return; }
          if (!f.done) { f.done = true; for (let i = Math.round(46 * q); i > 0; i--) { const a = rnd(TAU), v = rnd(60, 190); sparks.add({ x: f.x, y: f.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 110, drag: 1.6, max: rnd(.7, 1.3), size: pick([G, 2 * G]), c: f.c, ph: rnd(TAU) }); } }
        });
        // Ondes de choc carrées, en escalier.
        rings.run(dt, (r, k) => {
          const g = snap(r.grow * outCubic(k) * 78), a = 1 - k;
          co.globalAlpha = a; co.strokeStyle = r.c; co.lineWidth = G * (k < .5 ? 2 : 1);
          co.strokeRect(snap(card.x - g), snap(card.y - g), snap(card.w + 2 * g), snap(card.h + 2 * g));
          co.globalAlpha = a * .5; co.strokeStyle = '#ffffff'; co.lineWidth = G;
          co.strokeRect(snap(card.x - g * .82), snap(card.y - g * .82), snap(card.w + 1.64 * g), snap(card.h + 1.64 * g));
        });
      },
      lock(p, o) { // le bloc casse : éclats vers le haut, poussière, et des orbes d'XP
        const top = p.y - card.h * .2;
        for (let i = Math.round((o.ghost ? 4 : o.last ? 34 : 15) * q); i > 0; i--) chunk(p.x + rnd(-9, 9), top, -Math.PI / 2 + rnd(-1.2, 1.2), rnd(120, o.last ? 420 : 300));
        for (let i = 0; i < 6; i++) dust.add({ x: p.x + rnd(-14, 14), y: p.y + rnd(-10, 10), vx: rnd(-40, 40), vy: -rnd(10, 50), max: rnd(.5, 1), size: 2 * G });
        if (!o.ghost) orb(p.x, top, o.last ? 9 : 3);
        flash = Math.max(flash, o.ghost ? .15 : o.last ? .9 : .4);
        energy = Math.min(1.4, energy + (o.ghost ? .04 : .18));
        if (o.last) { target = .35; shake = 1; rings.add({ life: .6, grow: .7, c: '#6cc24a' }); }
      },
      build() { target = 1.35; }, // le sol gronde avant le dernier chiffre
      reveal(tier) {
        const p = POWER[tier], ore = ORE[tier];
        if (!p) { energy = .05; target = .2; for (let i = 0; i < 10; i++) chunk(rnd(card.x, card.x + card.w), card.y + card.h, Math.PI / 2, rnd(10, 50), GROUND[1], G); return; } // rien dans ce filon : un peu de terre retombe
        glowc = ore[0];
        for (let i = burst(p, 230 * q, 8); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.6, .6) - .5; chunk(from.x, from.y, a, rnd(100, 260 + 460 * p), Math.random() < .25 + .55 * p ? ore : pick(GROUND), pick([G, 2 * G, 2 * G, 3 * G, 4 * G])); }
        orb(cx, cy, burst(p, 60 * q, 3));
        flash = .25 + 1.1 * p; energy = .8 + .8 * p; target = .35 + .3 * p; shake = p;
        if (p >= .25) rings.add({ life: .8, grow: .5 + 1.6 * p, c: ore[0] });
        if (p > .55) rings.add({ delay: .15, life: .9, grow: 1 + 2 * p, c: ore[0] });
        const shots = p >= 1 ? 7 : p >= .8 ? 3 : p > .55 ? 1 : 0;
        for (let i = 0; i < shots; i++) fireworks.add({ delay: .25 + i * .32, life: .8, x: rnd(card.x - 60, card.x + card.w + 60), y: card.y - rnd(40, 110), c: pick(['#f472b6', '#facc15', '#5eead4', '#a78bfa', '#fb923c']) });
      },
    };
  };

  // ---------------------------------------------------------------- la signature du créateur
  // ♛ Owner — réservée au créateur du jeu (succès « owner », vérifié par le serveur), jouée par-dessus son skin : du
  // béryl rouge. Six cristaux hexagonaux poussent autour de la carte, un par chiffre ; une poussière de rubis flotte ;
  // deux filets de lumière courent sur le cadre ; avant le dernier chiffre, des veines d'énergie relient les pointes ;
  // à la révélation, la gemme s'ouvre : éventail de rayons, anneaux hexagonaux qui tournent, éclats, et une couronne.
  const OWNER = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const DEEP = '#7f0f2c', RED = '#e11d48', ROSE = '#fb7185', PALE = '#ffe4e9', GOLD = '#f8c8a0';
    const dust = particles(), shards = particles(), glints = timed(), hexes = timed(), emit = emitter();
    // Six cristaux : trois de chaque côté, penchés vers l'extérieur, de tailles différentes.
    const crystals = [-1, -1, -1, 1, 1, 1].map((side, i) => { const k = i % 3; return { x: cx + side * (card.w * .5 + 6 + k * 15), y: card.y + card.h + 8, len: card.h * (1.05 + .5 * ((k * 7 + 3) % 5) / 4), wid: 9 + ((k * 5 + i) % 4) * 2.5, lean: side * (.16 + k * .2), grow: 0, to: 0, glow: 0 }; });
    const order = [2, 3, 1, 4, 0, 5];
    let locked = 0, heat = 0, target = .35, p = 0, since = 0, revealed = false, spin = 0;
    // Un prisme hexagonal vu de face : trois pans (sombre, moyen, clair), une pointe à facettes, un filet de lumière.
    function prism(c, g) {
      const L = c.len * g, W = c.wid * (.55 + .45 * g), tip = W * 1.25;
      co.save();
      co.translate(c.x, c.y);
      co.rotate(c.lean);
      const pane = (x0, x1, color, a) => { co.globalAlpha = a; co.fillStyle = color; co.beginPath(); co.moveTo(x0, 0); co.lineTo(x1, 0); co.lineTo(x1, -L + tip * Math.abs(x1) / W); co.lineTo(x0, -L + tip * Math.abs(x0) / W); co.closePath(); co.fill(); };
      pane(-W, -W * .34, DEEP, .92); pane(-W * .34, W * .38, RED, .92); pane(W * .38, W, ROSE, .9);
      co.globalAlpha = .95; co.fillStyle = PALE; co.beginPath(); co.moveTo(-W * .34, -L + tip * .34); co.lineTo(0, -L - tip * .28); co.lineTo(W * .38, -L + tip * .38); co.closePath(); co.fill(); // facette du sommet
      co.fillStyle = ROSE; co.beginPath(); co.moveTo(-W, -L + tip); co.lineTo(0, -L - tip * .28); co.lineTo(-W * .34, -L + tip * .34); co.closePath(); co.fill();
      co.fillStyle = '#fda4af'; co.beginPath(); co.moveTo(W, -L + tip); co.lineTo(0, -L - tip * .28); co.lineTo(W * .38, -L + tip * .38); co.closePath(); co.fill();
      co.globalAlpha = .55 + .45 * c.glow; co.strokeStyle = '#ffffff'; co.lineWidth = 1; co.beginPath(); co.moveTo(W * .38, -2); co.lineTo(W * .38, -L + tip * .38); co.stroke(); // arête éclairée
      co.restore();
      return { x: c.x + Math.sin(c.lean) * (L + tip * .28), y: c.y - Math.cos(c.lean) * (L + tip * .28) };
    }
    const hexPath = (r, rot) => { co.beginPath(); for (let i = 0; i <= 6; i++) { const a = rot + (i * TAU) / 6; co.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r * .62); } };
    function crown(a, s) { // la couronne, au-dessus de la carte
      co.save(); co.translate(cx, card.y - 26 - 10 * s); co.scale(s, s); co.globalAlpha = a;
      const g = co.createLinearGradient(0, -16, 0, 12); g.addColorStop(0, PALE); g.addColorStop(.5, ROSE); g.addColorStop(1, RED);
      co.fillStyle = g; co.strokeStyle = dark ? '#fff1f2' : DEEP; co.lineWidth = 1.2; co.lineJoin = 'round';
      co.beginPath(); co.moveTo(-22, 10); co.lineTo(-24, -8); co.lineTo(-12, 1); co.lineTo(0, -16); co.lineTo(12, 1); co.lineTo(24, -8); co.lineTo(22, 10); co.closePath(); co.fill(); co.stroke();
      co.fillStyle = GOLD; co.fillRect(-22, 10, 44, 4);
      for (const [x, y] of [[-24, -8], [0, -16], [24, -8]]) { co.fillStyle = '#ffffff'; co.beginPath(); co.arc(x, y, 2.6, 0, TAU); co.fill(); }
      co.restore();
    }
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3); since += dt; spin += dt * (.5 + heat);
        // Dans la carte : une lueur de gemme qui respire, et un reflet lent.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, RED, w * .5, h * 1.1, w * .5, .1 + .12 * heat + (revealed ? .12 * p : 0));
        dot(ci, PALE, w * (((t * .22) % 1.5) * 1.3 - .3), h * .5, h * .35, .16, h * 1.3);
        // Derrière tout : halo, puis l'éventail de rayons à la révélation.
        co.globalCompositeOperation = add; co.lineCap = 'round';
        dot(co, RED, cx, cy, card.w * (.7 + .15 * heat), (dark ? .13 : .07) * (.6 + heat));
        if (revealed) { const open = outCubic(Math.min(1, since / .6)), fade = Math.max(0, 1 - since / (4 + 4 * p)); for (let i = 0; i < 14; i++) { const a = spin * .25 + (i * TAU) / 14, r = card.w * (.6 + .9 * p) * open * (i % 2 ? 1 : .72); tail(co, i % 2 ? ROSE : PALE, cx + Math.cos(a) * r, cy + Math.sin(a) * r * .62, cx + Math.cos(a) * card.w * .54, cy + Math.sin(a) * card.h * .78, i % 2 ? 9 : 5, fade * (dark ? .34 : .22)); } }
        // Les cristaux, et leurs pointes reliées par des veines d'énergie quand la tension monte.
        co.globalCompositeOperation = 'source-over';
        const tips = [];
        for (const c of crystals) { c.grow += (c.to - c.grow) * Math.min(1, dt * 7); c.glow = Math.max(0, c.glow - dt * 1.6); if (c.grow > .02) tips.push(prism(c, c.grow)); }
        co.globalCompositeOperation = add;
        if (heat > .75 && tips.length > 1) for (let i = 0; i < 2; i++) { const a = pick(tips), b = pick(tips); if (a !== b) bolt(co, a.x, a.y, b.x, b.y, 12, [RED, ROSE, dark ? '#ffffff' : RED], (heat - .75) * 1.6, .8); }
        tips.forEach((tp, i) => dot(co, PALE, tp.x, tp.y, 5 + 5 * crystals[i].glow + 2 * Math.sin(t * 5 + i), .5 + .5 * crystals[i].glow));
        // Deux filets de lumière sur le cadre, en sens contraires.
        co.globalCompositeOperation = 'lighter';
        for (let c2 = 0; c2 < 2; c2++) { const dir = c2 ? -1 : 1, head = dir * t * (.12 + .5 * heat) + c2 * .5; for (let i = 26; i >= 0; i--) { const pt = along(card, head - dir * i * .0045), a = 1 - i / 26; dot(co, c2 ? GOLD : ROSE, pt.x, pt.y, 2 + 3.5 * a, a * a * .6); } }
        // Poussière de rubis : elle monte en spirale, plus vite quand ça chauffe.
        co.globalCompositeOperation = add;
        for (let n = emit((7 + 34 * heat) * q, dt); n > 0; n--) { const a = rnd(TAU), r = card.w * rnd(.5, .85); dust.add({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * .6 + 30, vx: -Math.sin(a) * 26 * (1 + heat), vy: -rnd(14, 46) * (1 + heat), max: rnd(1.4, 2.8), size: rnd(.9, 2.2), c: pick([ROSE, RED, PALE]), tw: rnd(TAU) }); }
        dust.step(dt);
        dust.each((d, k) => { const a = Math.sin(Math.PI * k) * (.55 + .45 * Math.sin(t * 11 + d.tw)); dot(co, d.c, d.x, d.y, d.size * 2.6, a * .9); dot(co, '#ffffff', d.x, d.y, d.size * .7, a); });
        co.globalCompositeOperation = 'source-over';
        shards.step(dt);
        shards.each((d, k) => { co.save(); co.translate(d.x, d.y); co.rotate(d.rot + d.vr * d.life); co.globalAlpha = Math.min(1, (1 - k) * 2.4); co.fillStyle = d.c; SHAPES.gem(co, d, d.size); co.restore(); });
        hexes.run(dt, (x, k) => { const e = outCubic(k); hexPath(card.w * (.4 + x.grow * e), spin * x.dir + x.rot); co.globalAlpha = (1 - k) * .28; co.strokeStyle = RED; co.lineWidth = 7 * x.width; co.stroke(); co.globalAlpha = 1 - k; co.strokeStyle = dark ? PALE : RED; co.lineWidth = 1.4 * x.width; co.stroke(); });
        co.globalCompositeOperation = add;
        glints.run(dt, (g, k) => { const a = 1 - outCubic(k), r = g.size * (.4 + outExpo(k)); dot(co, '#ffffff', g.x, g.y, r * .32, a); dot(co, PALE, g.x, g.y, r * 2.4, a * .95, 1.5); dot(co, PALE, g.x, g.y, 1.5, a * .95, r * 2.4); dot(co, ROSE, g.x, g.y, r, a * .5); });
        co.globalCompositeOperation = 'source-over';
        if (revealed) { const k = Math.min(1, since / .5), a = Math.min(1, since * 3) * Math.max(0, Math.min(1, (5 + 4 * p - since))); crown(a, .7 + .5 * outExpo(k) * (.6 + .4 * p)); if (since > .5 && since < 1.3) { co.globalCompositeOperation = add; dot(co, '#ffffff', cx - 30 + 60 * ((since - .5) / .8), card.y - 34, 9, .8 * Math.sin(Math.PI * (since - .5) / .8), 16); } }
      },
      lock(pos, o) {
        if (o.ghost) return;
        const c = crystals[order[Math.min(5, locked++)]];
        c.to = 1; c.glow = 1;
        if (o.last) { crystals.forEach(x => { x.to = 1.12; x.glow = 1; }); target = .35; hexes.add({ life: .8, grow: .5, width: 1, dir: 1, rot: 0 }); }
        glints.add({ x: pos.x, y: pos.y - card.h * .22, size: card.h * (o.last ? .5 : .3), life: .55 });
        for (let i = Math.round((o.last ? 16 : 6) * q); i > 0; i--) { const a = -Math.PI / 2 + rnd(-1.2, 1.2), v = rnd(90, o.last ? 320 : 220); shards.add({ x: pos.x, y: pos.y - card.h * .25, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 640, drag: .7, max: rnd(.6, 1.1), size: rnd(2, 4), c: pick([RED, ROSE, PALE]), rot: rnd(TAU), vr: rnd(-6, 6) }); }
        heat = Math.min(1.4, heat + .16);
      },
      build() { target = 1.3; },
      reveal(tier) {
        p = Math.max(.35, POWER[tier]); revealed = true; since = 0; heat = .7 + .8 * p; target = .3 + .3 * p; // le créateur a toujours droit à sa couronne
        crystals.forEach(x => { x.to = 1.1 + .25 * p; x.glow = 1; });
        for (let i = 0; i < 2 + Math.round(3 * p); i++) hexes.add({ delay: i * .13, life: 1.1, grow: .3 + .5 * i + p, width: 1 + p, dir: i % 2 ? -1 : 1, rot: i * .4 });
        glints.add({ x: cx, y: cy, size: card.h * (.6 + .9 * p), life: .9 });
        for (let i = burst(p, 120 * q, 10); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.5, .5), v = rnd(100, 240 + 420 * p); shards.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, g: 520, drag: .6, max: rnd(.9, 1.6 + p), size: rnd(2.5, 5 + 3 * p), c: pick([RED, ROSE, PALE, DEEP]), rot: rnd(TAU), vr: rnd(-7, 7) }); }
        for (let i = Math.round(4 + 10 * p); i > 0; i--) { const pt = along(grown(card, 14), rnd()); glints.add({ delay: rnd(.1, 1.6), x: pt.x, y: pt.y, size: rnd(8, 20), life: .5 }); }
      },
    };
  };
  // ---------------------------------------------------------------- skins premium : une signature complète chacun
  // Même ambition que celle du créateur : une structure qui se construit chiffre après chiffre, une matière qui vit
  // en continu, une tension avant le dernier chiffre, et une révélation en plusieurs temps, dosée par la rareté.
  const outBack = p => { const k = clamp(p) - 1; return 1 + k * k * (2.7 * k + 1.7); };
  // Ellipse pleine (pétale, flammèche) tournée de `rot`.
  function oval(c, x, y, rx, ry, rot, color, a) {
    if (a <= .004) return;
    c.globalAlpha = Math.min(1, a); c.fillStyle = color;
    c.beginPath(); c.ellipse(x, y, Math.max(.1, rx), Math.max(.1, ry), rot, 0, TAU); c.fill();
  }

  // Le calque extérieur est posé au-dessus de la carte : pour qu'un objet semble passer derrière elle (une lune, un
  // arc de lumière), on le dessine en retirant le rectangle de la carte de la zone autorisée.
  // above : ne rien dessiner non plus sous la carte (là où s'affichent la rareté et le score après la révélation).
  function behind(env, draw, above) {
    const { co, W, H, card } = env;
    co.save(); co.beginPath(); co.rect(0, 0, W, above ? card.y + card.h + 7 : H); roundRect2(co, card.x, card.y, card.w, card.h, card.r); co.clip('evenodd'); draw(); co.restore();
  }
  // Rectangle arrondi ajouté au tracé en cours (roundRect en ouvre un nouveau).
  function roundRect2(c, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h / 2)); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  // 🌸 Sakura — une estampe : une branche pousse le long de la carte et une fleur s'ouvre à chaque chiffre, que tranche
  // une lame ; la lune se lève derrière ; le vent se lève avant le dernier chiffre ; à la révélation, un grand cercle
  // au pinceau (ensō) se trace autour de la carte, toutes les fleurs s'ouvrent, les pétales s'envolent.
  SCENES.sakura = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const PINK = '#f9a8d4', PALE = '#fde0eb', ROSE = '#f472b6', DEEP = '#be185d', GOLD = dark ? '#e7c16a' : '#a16207', WOOD = dark ? '#5a3a2a' : '#3b2418', MOON = '#fff6e5';
    const petals = particles(), inside = particles(), flecks = particles(), slashes = timed(), glints = timed(), emit = emitter(), emitIn = emitter();
    // La branche : une courbe qui part du bas à gauche, longe le dessus de la carte et retombe un peu à droite.
    const P0 = { x: card.x - 52, y: card.y + card.h + 16 }, P1 = { x: card.x - 36, y: card.y - 30 }, P2 = { x: card.x + card.w * .46, y: card.y - 22 }, P3 = { x: card.x + card.w * .9, y: card.y - 6 };
    const bez = u => { const v = 1 - u; return { x: v * v * v * P0.x + 3 * v * v * u * P1.x + 3 * v * u * u * P2.x + u * u * u * P3.x, y: v * v * v * P0.y + 3 * v * v * u * P1.y + 3 * v * u * u * P2.y + u * u * u * P3.y }; };
    // Six fleurs, de la base vers la pointe, de part et d'autre de la branche ; chacune au bout d'une brindille.
    const blossoms = [.2, .36, .5, .64, .8, .96].map((u, i) => ({ u, side: i % 2 ? 1 : -1, len: (i % 2 ? 9 : 6) + ((i * 7) % 5) * 1.4, size: 6.5 + ((i * 3) % 4) * .9, grow: 0, to: 0, rot: i * 1.3 }));
    let asc = 0, gilt = 0, finale = false, vortex = [], locked = 0, heat = 0, target = .35, p = 0, since = 0, revealed = false, grown2 = 0, growTo = .12, moon = 0, wind = 0;
    function flower(x, y, s, rot, open) { // cinq pétales en cœur, un cœur sombre, des étamines dorées
      if (open <= .02) return;
      const k = outBack(open) * s;
      for (let i = 0; i < 5; i++) { const a = rot + (i * TAU) / 5; oval(co, x + Math.cos(a) * k * .62, y + Math.sin(a) * k * .62, k * .62, k * .4, a, i % 2 ? (gilt > .5 ? '#fde68a' : PALE) : (gilt > .5 ? '#fbcfe8' : PINK), .96); }
      oval(co, x, y, k * .26, k * .26, 0, DEEP, .9);
      for (let i = 0; i < 5; i++) { const a = rot + .6 + (i * TAU) / 5; oval(co, x + Math.cos(a) * k * .34, y + Math.sin(a) * k * .34, .9, .9, 0, '#fde68a', open); }
    }
    const petal = (list, x, y, vx, vy, big) => list.add({ x, y, vx, vy, g: 26, drag: .9, max: rnd(2.2, 4.2), size: rnd(2.4, 4.2) * (big ? 1.25 : 1), rot: rnd(TAU), vr: rnd(-4, 4), ph: rnd(TAU), c: pick([PINK, PALE, ROSE, '#ffffff']) });
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3); since += dt;
        grown2 += (growTo - grown2) * Math.min(1, dt * 3.2); moon += ((revealed ? 1 : Math.min(1, .25 + heat * .7)) - moon) * Math.min(1, dt * 1.6);
        wind += ((heat > .9 ? 150 : 22 + 30 * heat) - wind) * Math.min(1, dt * 2);
        // Dans la carte : clair de lune en haut à droite, lueur rose en bas, pétales qui traversent derrière les chiffres.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, MOON, w * .86, h * .12, h * .9, .1 + .1 * moon);
        dot(ci, ROSE, w * .15, h * 1.15, w * .45, .1 + .1 * heat + (revealed ? .1 * p : 0));
        ci.globalCompositeOperation = 'source-over';
        for (let n = emitIn((2.5 + 5 * heat) * q, dt); n > 0; n--) petal(inside, rnd(-10, w), -6, rnd(8, 26) + wind * .25, rnd(14, 30));
        inside.step(dt);
        inside.each((d, k) => oval(ci, d.x + Math.sin(t * 2.2 + d.ph) * 5, d.y, d.size, d.size * .55, d.rot + d.vr * d.life, d.c, Math.sin(Math.PI * k) * .5));
        // La lune, derrière tout, qui monte à mesure que le tirage avance.
        const mr = Math.min(25, card.h * .36) * (1 + (revealed ? .28 * asc * outCubic(since / 1.2) : 0)), mx = card.x + card.w * .86, my = card.y + 12 - 30 * moon;
        behind(env, () => {
          co.globalCompositeOperation = add;
          dot(co, MOON, mx, my, mr * 2.6, (dark ? .2 : .12) * moon);
          co.globalCompositeOperation = 'source-over';
          oval(co, mx, my, mr, mr, 0, dark ? MOON : '#f7e7c5', .92 * moon);
          oval(co, mx - mr * .3, my - mr * .22, mr * .2, mr * .16, .4, dark ? '#ead9bd' : '#e6d2a8', .5 * moon);
          oval(co, mx + mr * .28, my + mr * .3, mr * .13, mr * .1, 0, dark ? '#ead9bd' : '#e6d2a8', .45 * moon);
        });
        // La branche : des tronçons de plus en plus fins, qui ondulent à peine sous le vent.
        const sway = (u, i) => Math.sin(t * (1.4 + wind * .012) + i * .35) * (1.2 + wind * .02) * u;
        co.lineCap = 'round'; co.strokeStyle = WOOD;
        let prev = bez(0);
        for (let i = 1; i <= 40; i++) {
          const u = i / 40; if (u > grown2) break;
          const pt = bez(u); pt.y += sway(u, i);
          co.globalAlpha = .96; co.lineWidth = 5.2 * (1 - u * .78); co.beginPath(); co.moveTo(prev.x, prev.y); co.lineTo(pt.x, pt.y); co.stroke();
          prev = pt;
        }
        // Brindilles et fleurs.
        blossoms.forEach((b, i) => {
          if (b.u > grown2 + .03) return;
          b.grow += (b.to - b.grow) * Math.min(1, dt * 6);
          const a0 = bez(b.u), a1 = bez(Math.min(1, b.u + .02)), ang = Math.atan2(a1.y - a0.y, a1.x - a0.x) - b.side * 1.15;
          a0.y += sway(b.u, b.u * 40);
          const tip = { x: a0.x + Math.cos(ang) * b.len, y: a0.y + Math.sin(ang) * b.len };
          co.globalAlpha = .95; co.strokeStyle = WOOD; co.lineWidth = 1.6; co.beginPath(); co.moveTo(a0.x, a0.y); co.lineTo(tip.x, tip.y); co.stroke();
          if (b.grow <= .02) { oval(co, tip.x, tip.y, 2, 2.6, ang, DEEP, .9); return; } // le bouton, avant d'éclore
          flower(tip.x, tip.y, b.size * (revealed ? 1 + .25 * p : 1), b.rot + Math.sin(t * 1.3 + i) * .12, b.grow);
          if (b.grow > .9 && Math.random() < dt * (.25 + heat * .9) * q) petal(petals, tip.x, tip.y, rnd(-10, 30) + wind * .4, rnd(6, 24));
        });
        // Pétales dans le vent : ils tombent en se balançant, puis filent à l'horizontale quand la tension monte.
        for (let n = emit((4 + 16 * heat) * q, dt); n > 0; n--) petal(petals, card.x + rnd(-90, card.w + 40), card.y - rnd(40, 90), rnd(-6, 20) + wind * .5, rnd(12, 36));
        petals.step(dt);
        petals.each((d, k) => { d.vx += (wind - d.vx) * Math.min(1, dt * .9); oval(co, d.x + Math.sin(t * 2.4 + d.ph) * 7, d.y, d.size, d.size * (.35 + .25 * Math.abs(Math.sin(t * 3 + d.ph))), d.rot + d.vr * d.life, d.c, Math.min(1, k * 8) * Math.min(1, (1 - k) * 2.2) * .95); });
        const this_since = since;
        if (revealed && p >= .6) {
          const life = Math.min(1, since * 2.5) * clamp((3.2 + 2 * p + 1.5 * asc - since) / 1.6);
          // Rayons de lune : derrière la carte, plus nombreux et plus longs à chaque cran de rareté.
          behind(env, () => { co.globalCompositeOperation = add; godrays(co, dark ? MOON : '#f59e0b', mx, my, 9 + 4 * asc, mr * 1.1, card.w * (.45 + .2 * p + .18 * asc), t * .12, 7 + 3 * asc, life * (dark ? .2 : .13) * (.6 + .4 * p)); co.globalCompositeOperation = 'source-over'; }, true);
          // Le tourbillon : les pétales tournent autour de la carte en se resserrant, puis la lame les disperse.
          const ex = card.w * .5 + 22, ey = card.h * .5 + 20, out = Math.max(0, since - .95);
          for (const v of vortex) {
            v.a += dt * v.sp * (out ? 1.6 : 1 + 1.2 * Math.min(1, since));
            const rr = v.r * (out ? 1 + out * out * 3.2 : 1 - .22 * outCubic(since / .95)), a = Math.min(1, since * 4) * clamp(1 - out / 1.1) * .95;
            if (a > .01) oval(co, cx + Math.cos(v.a) * ex * rr, cy + Math.sin(v.a) * ey * rr * (1 + out), v.size, v.size * .5, v.a + Math.PI / 2 + v.ph, v.c, a);
          }
          // Le coup final (Mythic et plus) : deux coups de lame en croix sur toute la carte, une gerbe d'or.
          if (!finale && p >= 1 && since > .95) {
            finale = true; gilt = asc >= 2 ? 1 : 0;
            slashes.add({ x: cx, y: cy, dx: .94, dy: .34, len: card.w * .85, w: 2.4 + .6 * asc, life: .55 });
            slashes.add({ x: cx, y: cy, dx: .94, dy: -.34, len: card.w * .85, w: 2.4 + .6 * asc, life: .55, delay: .09 });
            glints.add({ x: card.x + card.w + 6, y: card.y - 4, size: card.h * (.8 + .3 * asc), life: .7, delay: .1 });
            for (let i = Math.round((50 + 40 * asc) * q); i > 0; i--) { const from = along(grown(card, 6), rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.5, .5), v = rnd(80, 300 + 120 * asc); flecks.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, g: 140, drag: 1.2, max: rnd(1.2, 2.4 + asc * .4), size: rnd(1.2, 2.8), rot: rnd(TAU), vr: rnd(-8, 8), ph: rnd(TAU) }); }
          }
        }
        // Le cercle au pinceau : il se trace en .7 s, plein au départ, effilé à l'arrivée, puis s'efface doucement.
        // Au-delà du Mythic, un second coup de pinceau, à l'encre rose, repasse juste à l'extérieur du premier.
        if (revealed) for (const [d0, sc, ink] of [[0, 1, GOLD], [.3, 1.1, dark ? ROSE : DEEP]].slice(0, asc ? 2 : 1)) {
          const since = Math.max(0, this_since - d0); if (since <= 0) continue;
          const drawn = outCubic(Math.min(1, since / .7)), fade = Math.max(0, Math.min(1, (3 + 3.5 * p + asc - since) / 1.5)), rx = (card.w * .5 + 34 + 10 * p) * sc, ry = (card.h * .5 + 24 + 8 * p) * sc, a0 = -2.3 + d0 * 2.2, N = 70;
          co.strokeStyle = ink; co.lineCap = 'round';
          for (let i = 0; i < Math.floor(N * drawn); i++) {
            const u = i / N, a = a0 + u * TAU * .955, b = a0 + ((i + 1.15) / N) * TAU * .955, wob = 1 + .018 * Math.sin(u * 23);
            co.globalAlpha = fade * (.92 - .35 * u); co.lineWidth = (1.2 + 6.2 * Math.pow(1 - u, .7) * (.85 + .15 * Math.sin(u * 41))) * (.8 + .5 * p);
            co.beginPath(); co.moveTo(cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob); co.lineTo(cx + Math.cos(b) * rx * wob, cy + Math.sin(b) * ry * wob); co.stroke();
          }
          oval(co, cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry, 5 + 3 * p, 4 + 2 * p, a0, ink, fade * Math.min(1, since * 6));
        }
        // Les coups de lame : un trait qui file, cœur blanc et halo rose.
        co.globalCompositeOperation = add; co.lineCap = 'round';
        slashes.run(dt, (s, k) => {
          const head = outExpo(Math.min(1, k * 2.4)), a = 1 - Math.pow(k, 1.6), x1 = s.x - s.dx * s.len, y1 = s.y - s.dy * s.len, x2 = s.x - s.dx * s.len + s.dx * s.len * 2 * head, y2 = s.y - s.dy * s.len + s.dy * s.len * 2 * head;
          tail(co, ROSE, x1, y1, x2, y2, 6 * s.w, a * .5); tail(co, dark ? '#ffffff' : DEEP, x1, y1, x2, y2, 1.6 * s.w, a);
          dot(co, '#ffffff', x2, y2, 7 * s.w, a * .9);
        });
        glints.run(dt, (g, k) => { const a = 1 - outCubic(k), r = g.size * (.4 + outExpo(k)); dot(co, '#ffffff', g.x, g.y, r * .3, a); dot(co, PALE, g.x, g.y, r * 2.2, a * .9, 1.4); dot(co, PALE, g.x, g.y, 1.4, a * .9, r * 2.2); });
        // Paillettes de feuille d'or.
        co.globalCompositeOperation = 'source-over';
        flecks.step(dt);
        flecks.each((d, k) => { co.save(); co.translate(d.x, d.y); co.rotate(d.rot + d.vr * d.life); co.globalAlpha = Math.min(1, (1 - k) * 2.5) * (.55 + .45 * Math.sin(t * 14 + d.ph)); co.fillStyle = GOLD; co.fillRect(-d.size, -d.size * .6, d.size * 2, d.size * 1.2); co.restore(); });
      },
      lock(pos, o) {
        if (o.ghost) return;
        const b = blossoms[Math.min(5, locked++)];
        growTo = Math.max(growTo, Math.min(1, b.u + .1)); b.to = 1;
        if (o.last) { growTo = 1; blossoms.forEach(x => { x.to = 1; }); target = .35; }
        slashes.add({ x: pos.x, y: pos.y, dx: .9, dy: -.42, len: card.h * (o.last ? 1.5 : .95), w: o.last ? 1.5 : 1, life: .34 });
        glints.add({ x: pos.x, y: pos.y, size: card.h * (o.last ? .5 : .3), life: .5, delay: .08 });
        for (let i = Math.round((o.last ? 18 : 9) * q); i > 0; i--) { const a = rnd(TAU), v = rnd(40, o.last ? 200 : 130); petal(petals, pos.x, pos.y, Math.cos(a) * v, Math.sin(a) * v - 40, true); }
        heat = Math.min(1.4, heat + .16);
      },
      build() { target = 1.3; growTo = 1; },
      reveal(tier) {
        p = POWER[tier] || 0; revealed = true; since = 0; heat = .6 + .8 * p; target = .25 + .3 * p; growTo = 1;
        blossoms.forEach(x => { x.to = 1; });
        slashes.add({ x: cx, y: cy, dx: 1, dy: -.08, len: card.w * .75, w: 1.6 + p, life: .42 });
        glints.add({ x: card.x + card.w + 4, y: cy - card.h * .2, size: card.h * (.6 + .9 * p), life: .9, delay: .1 }); // au bout de la lame, pas sur les chiffres
        asc = ASCEND[tier] || 0; finale = false; gilt = 0;
        vortex = p < .6 ? [] : Array.from({ length: Math.round((26 + 26 * p + 22 * asc) * q) }, () => ({ a: rnd(TAU), r: rnd(1.05, 1.5), sp: rnd(2.2, 3.6), size: rnd(2.6, 4.6), ph: rnd(-.6, .6), c: pick([PINK, PALE, ROSE, asc >= 2 ? '#fde68a' : '#ffffff']) }));
        for (let i = burst(p, 150 * q, 14); i > 0; i--) { const from = along(grown(card, 10), rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.6, .6), v = rnd(60, 180 + 320 * p); petal(petals, from.x, from.y, Math.cos(a) * v, Math.sin(a) * v - 50, true); }
        for (let i = burst(p, 70 * q, 6); i > 0; i--) { const from = along(grown(card, 24), rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.4, .4), v = rnd(50, 140 + 260 * p); flecks.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, g: 120, drag: 1.1, max: rnd(1.2, 2.2 + p), size: rnd(1.2, 2.6), rot: rnd(TAU), vr: rnd(-8, 8), ph: rnd(TAU) }); }
      },
    };
  };

  // ⚡ Storm — un orage se forme au-dessus de la carte : le nuage gonfle, la pluie tombe, un feu de Saint-Elme court sur
  // le cadre ; la foudre frappe chaque chiffre ; avant le dernier, le nuage gronde d'éclairs internes ; à la révélation,
  // plusieurs éclairs tombent ensemble, une onde part de la carte et des boules de foudre se mettent en orbite.
  SCENES.storm = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const WHITE = '#f0fbff', CYAN = '#7dd3fc', BLUE = '#38bdf8', DEEPB = '#0369a1', BOLT = [BLUE, CYAN, dark ? '#ffffff' : DEEPB];
    const C1 = dark ? '#334155' : '#1e293b', C2 = dark ? '#64748b' : '#334155', C3 = dark ? '#94a3b8' : '#475569';
    const rain = particles(), sparks = particles(), strikes = timed(), rings = timed(), flashes = timed(), emit = emitter();
    const cloudY = card.y - 17, puffs = Array.from({ length: 15 }, (_, i) => { const u = i / 14; return { x: cx + (u - .5) * card.w * 1.12 + rnd(-8, 8), y: cloudY - Math.sin(u * Math.PI) * 9 + rnd(-4, 4), r: 15 + Math.sin(u * Math.PI) * 9 + rnd(0, 5), ph: rnd(TAU), lit: 0 }; });
    const orbs = [];
    let asc = 0, great = false, ball = 0, sheet = 0, heat = 0, target = .35, p = 0, since = 0, revealed = false, formed = 0, innerFlash = 0;
    // Un éclair du nuage jusqu'à un point : il se redessine à chaque image (il tremble), avec une branche.
    const strike = (x, y, big, delay = 0) => { const from = puffs.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a)); from.lit = 1; strikes.add({ x1: x + rnd(-22, 22), y1: card.y - 46, x2: x, y2: y, life: big ? .42 : .3, w: big ? 1.5 : 1, delay, hit: false, bx: x + rnd(-70, 70), by: y - rnd(10, 46) }); };
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3); since += dt; formed = Math.min(1, formed + dt * 1.1); innerFlash = Math.max(0, innerFlash - dt * 3.2);
        // Dans la carte : la lueur bleue de l'orage, et l'éclair qui l'illumine d'un coup.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, BLUE, w * .5, -h * .2, w * .55, .1 + .14 * heat);
        if (innerFlash > 0) { ci.globalAlpha = innerFlash * innerFlash * .3; ci.fillStyle = '#dff6ff'; ci.fillRect(0, 0, w, h); }
        // La pluie, en biais, plus drue quand la tension monte.
        co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
        for (let n = emit((36 + 150 * heat) * q * formed, dt); n > 0; n--) rain.add({ x: card.x + rnd(-70, card.w + 90), y: cloudY + rnd(0, 18), vx: -62 - 40 * heat, vy: rnd(430, 560), max: rnd(.34, .52), len: rnd(8, 15) });
        rain.step(dt);
        rain.each((d, k) => line(co, dark ? '#bae6fd' : DEEPB, d.x, d.y, d.x - d.len * .14, d.y - d.len, 1, (dark ? .5 : .55) * (1 - k * k)));
        // Le nuage : des volutes sombres, plus claires sur le dessus, éclairées de l'intérieur.
        puffs.forEach((c, i) => {
          c.lit = Math.max(0, c.lit - dt * 4.5);
          if (Math.random() < dt * (.25 + 2.6 * Math.max(0, heat - .5)) ) c.lit = Math.max(c.lit, rnd(.5, 1));
          const bob = Math.sin(t * (.7 + heat) + c.ph) * (1.5 + 2 * heat), x = c.x + Math.cos(t * .5 + c.ph) * 2, y = c.y + bob, r = c.r * (.5 + .5 * outCubic(formed));
          co.globalCompositeOperation = 'source-over';
          dot(co, C1, x, y + r * .18, r * 1.25, .95 * formed); dot(co, C2, x, y - r * .1, r, .8 * formed); dot(co, C3, x - r * .2, y - r * .38, r * .55, .45 * formed);
          if (c.lit > 0) { co.globalCompositeOperation = add; dot(co, dark ? '#e0f7ff' : BLUE, x, y, r * 1.1, c.lit * (dark ? .75 : .5)); }
        });
        // Feu de Saint-Elme : deux filets qui courent sur le cadre, et de petits arcs quand ça chauffe.
        co.globalCompositeOperation = 'lighter';
        for (let c2 = 0; c2 < 2; c2++) { const dir = c2 ? -1 : 1, head = dir * t * (.16 + .6 * heat) + c2 * .5; for (let i = 22; i >= 0; i--) { const pt = along(card, head - dir * i * .0045), a = 1 - i / 22; dot(co, c2 ? WHITE : CYAN, pt.x, pt.y, 1.8 + 3.2 * a, a * a * .6); } }
        co.globalCompositeOperation = add;
        if (heat > .7 && Math.random() < dt * 16 * (heat - .6)) { const s = rnd(), a = along(grown(card, 2), s), b = along(grown(card, 2), s + rnd(.03, .09)); bolt(co, a.x, a.y, b.x, b.y, 7, BOLT, .9, .6); }
        // La foudre.
        strikes.run(dt, (s, k) => {
          if (!s.hit) { s.hit = true; innerFlash = 1; flashes.add({ x: s.x2, y: s.y2, life: .5, size: card.h * s.w }); for (let i = Math.round(12 * s.w * q); i > 0; i--) { const a = -Math.PI / 2 + rnd(-1.5, 1.5), v = rnd(90, 300); sparks.add({ x: s.x2, y: s.y2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 620, drag: .8, max: rnd(.35, .8), size: rnd(.8, 1.9) }); } }
          const a = k < .3 ? 1 : 1 - (k - .3) / .7;
          if (k < .55 || Math.random() < .5) { const pts = bolt(co, s.x1, s.y1, s.x2, s.y2, 16 * s.w, BOLT, a, s.w), m = pts[(pts.length * .45) | 0]; bolt(co, m[0], m[1], s.bx, s.by, 9, BOLT, a * .6, s.w * .55); }
        });
        // Les éclats passent derrière la carte : la foudre éclaire le nombre, elle ne le couvre pas.
        if (flashes.n) behind(env, () => flashes.run(dt, (f, k) => { const a = 1 - outCubic(k); dot(co, '#ffffff', f.x, f.y, f.size * (.45 + .6 * k), a * .85); dot(co, CYAN, f.x, f.y, f.size * (1.4 + 1.6 * k), a * .4); }));
        if (revealed && p >= 1) {
          sheet = Math.max(0, sheet - dt * 2.2);
          // Mythic et plus : le grand coup — un éclair géant tombe du haut du ciel sur la carte, le ciel blanchit derrière.
          if (!great && since > .5) {
            great = true; sheet = 1; innerFlash = 1;
            strikes.add({ x1: cx + rnd(-30, 30), y1: 0, x2: cx, y2: card.y - 2, life: .55, w: 2.4 + .4 * asc, delay: 0, hit: false, bx: cx + rnd(-120, 120), by: card.y - rnd(40, 90) });
            for (let i = 0; i < 2 + asc; i++) strikes.add({ x1: cx + rnd(-80, 80), y1: rnd(0, 30), x2: card.x + rnd(0, card.w), y2: card.y - 2, life: .4, w: 1.2, delay: .05 + i * .06, hit: false, bx: cx + rnd(-140, 140), by: card.y - rnd(30, 80) });
            for (let i = 0; i < 1 + Math.min(1, asc); i++) rings.add({ delay: i * .12, life: 1.1, grow: 60 + 40 * i + 18 * asc, width: 1.6 + .3 * asc });
          }
          if (sheet > 0) behind(env, () => { co.globalCompositeOperation = add; dot(co, dark ? '#cfefff' : '#38bdf8', cx, card.y - card.h * .6, card.w * 1.3, sheet * sheet * (dark ? .55 : .35), card.h * 2.4); }, true);
          // Celestial et plus : une couronne d'arcs crépite autour du cadre pendant quelques secondes.
          const crown = asc ? clamp(since * 2) * clamp((2.6 + 1.2 * asc - since) / .8) : 0;
          if (crown > 0) for (let i = 0; i < 2 + asc; i++) { const s0 = rnd(), a = along(grown(card, 14 + 6 * Math.sin(t * 3)), s0), b = along(grown(card, 3), s0 + rnd(-.02, .02)); bolt(co, a.x, a.y, b.x, b.y, 7, BOLT, crown, .8); }
          // Divine et plus : une boule de plasma se forme au-dessus du nombre, puis se décharge en étoile.
          if (asc >= 2) {
            const bx = cx, by = card.y - card.h * 1.25;
            if (since < 1.25) { ball = outCubic(clamp((since - .7) / .5)); if (ball > 0) { dot(co, CYAN, bx, by, 40 * ball * (1 + .1 * Math.sin(t * 40)), .7 * ball); dot(co, '#ffffff', bx, by, 13 * ball, ball); if (Math.random() < .6) { const a = rnd(TAU); bolt(co, bx, by, bx + Math.cos(a) * 30 * ball, by + Math.sin(a) * 30 * ball, 5, BOLT, ball, .5); } } }
            else if (ball > 0) {
              ball = 0; sheet = 1;
              const n = 7 + 3 * asc;
              for (let i = 0; i < n; i++) { const to = along(grown(card, 2), .8 + (i / (n - 1)) * .4); strikes.add({ x1: bx, y1: by, x2: to.x, y2: to.y, life: .4, w: 1.2, delay: i * .02, hit: false, bx: (bx + to.x) / 2 + rnd(-30, 30), by: (by + to.y) / 2 }); } // la décharge s'abat tout autour du cadre
              flashes.add({ x: bx, y: by, life: .6, size: card.h * 1.6 });
            }
          }
        }
        sparks.step(dt);
        sparks.each((d, k) => { tail(co, dark ? WHITE : BLUE, d.x - d.vx * .035, d.y - d.vy * .035, d.x, d.y, d.size, 1 - k); });
        // L'onde de tonnerre : le contour de la carte qui s'élargit.
        rings.run(dt, (r, k) => { const e = outCubic(k), g = grown(card, 6 + r.grow * e); roundRect(co, g.x, g.y, g.w, g.h, g.r); co.globalAlpha = (1 - k) * .16; co.strokeStyle = BLUE; co.lineWidth = 5 * r.width; co.stroke(); co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? WHITE : DEEPB; co.lineWidth = 1.1 * r.width; co.stroke(); });
        // Boules de foudre en orbite après la révélation, avec leur traîne et leurs arcs vers le cadre.
        if (revealed) orbs.forEach((o, i) => {
          const life = Math.max(0, Math.min(1, since * 2) * Math.min(1, (3.5 + 3.5 * p + 1.5 * asc - since)));
          if (life <= 0) return;
          o.s += dt * o.v;
          for (let j = 10; j >= 0; j--) { const pt = along(grown(card, 20), o.s - j * .006 * Math.sign(o.v)), a = (1 - j / 10) * life; dot(co, j ? CYAN : '#ffffff', pt.x, pt.y, j ? 5 - j * .3 : 6.5, a * (j ? .5 : 1)); }
          const head = along(grown(card, 20), o.s);
          if (Math.random() < dt * 9) { const to = along(card, o.s + rnd(-.03, .03)); bolt(co, head.x, head.y, to.x, to.y, 5, BOLT, life, .5); }
        });
      },
      lock(pos, o) {
        if (o.ghost) return;
        strike(pos.x, pos.y - card.h * .3, o.last);
        if (o.last) { target = .35; rings.add({ life: .7, grow: 30, width: 1 }); }
        heat = Math.min(1.45, heat + .17);
      },
      build() { target = 1.35; },
      reveal(tier) {
        p = POWER[tier] || 0; revealed = true; since = 0; heat = .7 + .8 * p; target = .3 + .3 * p;
        const n = 2 + Math.round(5 * p);
        for (let i = 0; i < n; i++) { const pt = along(grown(card, 2), .92 + (i / Math.max(1, n - 1)) * .16 + rnd(-.01, .01)); strike(pt.x, pt.y, true, i * .07 + rnd(0, .04)); }
        for (let i = 0; i < 2 + Math.round(2 * p); i++) rings.add({ delay: i * .14, life: .9, grow: 22 + 20 * i + 34 * p, width: 1 + .6 * p });
        flashes.add({ x: cx, y: cy, life: .8, size: card.h * (1 + 1.4 * p) });
        orbs.length = 0; asc = ASCEND[tier] || 0; great = false; ball = 0;
        for (let i = 0; i < 1 + Math.round(2 * p) + asc; i++) orbs.push({ s: i / 3 + rnd(.1), v: (i % 2 ? -1 : 1) * rnd(.3, .46) });
        for (let i = burst(p, 120 * q, 10); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.5, .5), v = rnd(120, 280 + 420 * p); sparks.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, g: 560, drag: .7, max: rnd(.5, 1 + .6 * p), size: rnd(.9, 2.2) }); }
      },
    };
  };

  // 🐉 Dragon — un dragon serpentin, vu de dessus, tourne autour de la carte : corps d'obsidienne aux arêtes dorées,
  // cornes, moustaches, yeux de braise. À chaque chiffre il crache un jet de feu qui le forge ; avant le dernier, il
  // accélère et son corps rougeoie ; à la révélation il fait un tour en furie, des anneaux de feu partent de la carte
  // et son trésor retombe en pluie de pièces d'or.
  SCENES.dragon = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const OBS = '#2a0a08', RED = '#8f1d16', EMBER = '#f97316', GOLD = '#f5b83d', PALE = '#fff3c4', FIRE = ['#ffffff', '#fff3c4', '#fbbf24', '#f97316', '#dc2626', '#7f1d1d'];
    const flames = particles(), embers = particles(), coins = particles(), rings = timed(), glints = timed(), emit = emitter(), emitF = emitter();
    const path = grown(card, 26), N = 46, DS = .0078, K = clamp(card.h / 80, .85, 1.3), breaths = [];
    let asc = 0, s = rnd(), speed = .09, heat = 0, target = .35, p = 0, since = 0, revealed = false, jaw = 0, tt = 0, innerFlash = 0, rest = 0;
    // Au repos (après la révélation) : lové en spirale à gauche de la carte, la queue au centre, la tête vers elle —
    // il garde son trésor, et ne passe plus sur la rareté et le score affichés sous la carte.
    const coil = i => { const f = i / (N - 1), a = -.45 - f * TAU * 1.85, r = (38 - 28 * f) * K * (1 + .03 * Math.sin(tt * 2.2)); return { x: card.x - 64 * K + Math.cos(a) * r, y: cy + 2 + Math.sin(a) * r * .84 }; };
    const rad = i => (11.5 * Math.pow(1 - i / N, .8) * (i < 4 ? .74 + .065 * i : 1) + 1.4) * K;
    // Point du corps à la distance u sur le tour de carte, décalé par l'ondulation (nulle à la tête).
    const around = (u, i) => { const a = along(path, u), b = along(path, u + .002), ang = Math.atan2(b.y - a.y, b.x - a.x), wob = Math.sin(tt * 7 - i * .55) * (2.4 + 1.6 * Math.min(1, heat)) * Math.min(1, i / 4) * K; return { x: a.x - Math.sin(ang) * wob, y: a.y + Math.cos(ang) * wob }; };
    // La pose de chaque anneau à cette image : sur le tour de carte, lové, ou entre les deux ; l'angle vient du voisin de devant.
    let pose = [];
    const settle = () => { const e = rest * rest * (3 - 2 * rest); pose = []; for (let i = 0; i < N; i++) { const a = around(s - i * DS, i); if (e > 0) { const c = coil(i); a.x += (c.x - a.x) * e; a.y += (c.y - a.y) * e; } pose.push(a); } for (let i = 0; i < N; i++) { const f = pose[Math.max(0, i - 1)], b = pose[Math.max(1, i)]; pose[i].ang = Math.atan2(f.y - b.y, f.x - b.x); } };
    const spot = (u, i) => pose[i];
    const flame = (x, y, vx, vy, size, max) => flames.add({ x, y, vx, vy, g: -90, drag: 1.6, max, size });
    function head(hd) {
      co.save(); co.translate(hd.x, hd.y); co.rotate(hd.ang); co.scale(K * 1.22, K * 1.22); co.lineCap = 'round'; co.lineJoin = 'round';
      co.strokeStyle = GOLD; co.lineWidth = 1.1; co.globalAlpha = .9; // moustaches, qui flottent vers l'arrière
      for (const sd of [-1, 1]) { co.beginPath(); co.moveTo(15, sd * 3); co.quadraticCurveTo(6, sd * (12 + 2 * Math.sin(tt * 5 + sd)), -9, sd * (13 + 3 * Math.sin(tt * 4 + sd * 2))); co.stroke(); }
      co.strokeStyle = '#f1dba6'; co.lineWidth = 2.3; co.globalAlpha = 1; // cornes
      for (const sd of [-1, 1]) { co.beginPath(); co.moveTo(-5, sd * 6); co.quadraticCurveTo(-12, sd * 12.5, -20, sd * 9); co.stroke(); }
      co.fillStyle = OBS; // crâne et museau
      co.beginPath(); co.moveTo(-10, 0); co.quadraticCurveTo(-9, -10, 1, -8.5); co.quadraticCurveTo(9, -7.5, 13, -4.2); co.lineTo(20, -2.4); co.quadraticCurveTo(22.5, 0, 20, 2.4); co.lineTo(13, 4.2); co.quadraticCurveTo(9, 7.5, 1, 8.5); co.quadraticCurveTo(-9, 10, -10, 0); co.closePath(); co.fill();
      co.strokeStyle = GOLD; co.lineWidth = .9; co.globalAlpha = .8; co.stroke();
      co.globalAlpha = 1; co.fillStyle = RED; co.beginPath(); co.moveTo(-6, 0); co.quadraticCurveTo(3, -4.6, 16, -1); co.lineTo(16, 1); co.quadraticCurveTo(3, 4.6, -6, 0); co.fill(); // arête du museau
      for (const sd of [-1, 1]) { co.fillStyle = '#fde047'; co.beginPath(); co.ellipse(4.5, sd * 5.1, 2.3, 1.35, sd * .5, 0, TAU); co.fill(); co.fillStyle = '#1a0505'; co.beginPath(); co.ellipse(5, sd * 5.1, .7, 1.25, sd * .5, 0, TAU); co.fill(); }
      co.fillStyle = '#0d0403'; for (const sd of [-1, 1]) { co.beginPath(); co.arc(18.3, sd * 1.4, .8, 0, TAU); co.fill(); }
      co.restore();
    }
    return {
      frame(t, dt) {
        tt = t; heat += (target - heat) * Math.min(1, dt * 3); since += dt; innerFlash = Math.max(0, innerFlash - dt * 3);
        const want = revealed ? (since < .7 ? 1.25 : .07 + .05 * p) : .09 + .3 * Math.max(0, heat - .3);
        speed += (want - speed) * Math.min(1, dt * (revealed && since < .7 ? 9 : 2.4)); s += dt * speed; jaw = Math.max(0, jaw - dt * 2.4);
        if (revealed && since > .75) rest = Math.min(1, rest + dt / 1.1);
        settle();
        // Dans la carte : la lave qui couve en bas, un reflet qui passe sur les écailles, l'éclat de la forge.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, EMBER, w * .5, h * 1.28, w * .62, .16 + .2 * heat + (revealed ? .14 * p : 0));
        dot(ci, PALE, w * (((t * .26) % 1.6) * 1.2 - .3), h * .5, h * .3, .1, h * 1.2);
        if (innerFlash > 0) dot(ci, PALE, w * .5, h * .5, w * .7, innerFlash * .5);
        // Braises qui montent de sous la carte.
        co.globalCompositeOperation = add;
        dot(co, EMBER, cx, cy, card.w * (.72 + .14 * heat), (dark ? .12 : .06) * (.6 + heat));
        for (let n = emit((6 + 28 * heat) * q, dt); n > 0; n--) embers.add({ x: card.x + rnd(-10, card.w + 10), y: card.y + card.h + rnd(0, 12), vx: rnd(-14, 14), vy: -rnd(22, 78) * (1 + .5 * heat), max: rnd(1.1, 2.4), size: rnd(.8, 1.9), c: pick([EMBER, GOLD, '#fbbf24']), tw: rnd(TAU) });
        embers.step(dt);
        embers.each((d, k) => { const a = Math.sin(Math.PI * k) * (.6 + .4 * Math.sin(t * 12 + d.tw)); dot(co, d.c, d.x + Math.sin(t * 3 + d.tw) * 4, d.y, d.size * 2.4, a * .9); dot(co, '#ffffff', d.x + Math.sin(t * 3 + d.tw) * 4, d.y, d.size * .6, a); });
        // Les anneaux de feu de la révélation, derrière le dragon.
        rings.run(dt, (r, k) => { const e = outCubic(k), g = grown(card, 8 + r.grow * e); roundRect(co, g.x, g.y, g.w, g.h, g.r); co.globalAlpha = (1 - k) * .18; co.strokeStyle = EMBER; co.lineWidth = 6 * r.width; co.stroke(); co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? PALE : '#b45309'; co.lineWidth = 1.2 * r.width; co.stroke(); });
        // Mythic et plus : des ailes de feu se déploient derrière la carte et battent ; plus larges à chaque cran de rareté.
        if (revealed && p >= 1) {
          const open = outBack(clamp((since - .15) / .6)) * clamp((3.4 + 1.6 * asc - since) / 1.2);
          if (open > .01) behind(env, () => {
            co.globalCompositeOperation = add; co.lineCap = 'round';
            const flap = Math.sin(since * 4.2) * .09, span = card.w * (.52 + .12 * asc);
            for (const sd of [-1, 1]) {
              // Une aile de chauve-souris : cinq doigts qui partent de l'épaule, une membrane creusée entre eux.
              const bx = cx + sd * card.w * .2, by = card.y + card.h * .35, tips = [];
              for (let i = 0; i < 5; i++) { const ang = -Math.PI / 2 + sd * (.3 + i * .3 + flap * (1 + i * .2)) * open, len = span * (1.1 - .1 * i) * open; tips.push([bx + Math.cos(ang) * len, by + Math.sin(ang) * len * .8]); }
              co.beginPath(); co.moveTo(bx, by);
              tips.forEach(([x, y], i) => { if (i) { const [px, py] = tips[i - 1], mxm = (px + x) / 2, mym = (py + y) / 2; co.quadraticCurveTo(lerp(mxm, bx, .35), lerp(mym, by, .35), x, y); } else co.lineTo(x, y); });
              co.closePath();
              co.globalAlpha = open * (dark ? .3 : .22); co.fillStyle = asc >= 1 ? GOLD : EMBER; co.fill();
              co.globalAlpha = open * .9; co.strokeStyle = asc >= 1 ? (dark ? PALE : '#b45309') : GOLD; co.lineWidth = 1.6; co.stroke();
              for (const [x, y] of tips) {
                tail(co, dark ? '#fbbf24' : '#b45309', x, y, bx, by, 2.6, open * .85); // les os de l'aile
                if (Math.random() < dt * 18 * q) flame(x, y, rnd(-20, 20), -rnd(30, 90), rnd(4, 7), rnd(.3, .6));
              }
            }
          }, true);
          // Divine et plus : une colonne de feu monte derrière la carte.
          if (asc >= 2 && since > .4 && since < 2.4) for (let n = emitF(140 * q, dt); n > 0; n--) flame(cx + rnd(-card.w * .3, card.w * .3), card.y + 4, rnd(-15, 15), -rnd(260, 420), rnd(6, 11), rnd(.35, .6));
        }
        // Le corps, de la queue vers la tête : anneaux d'obsidienne, croissant rouge, arête dorsale dorée.
        co.globalCompositeOperation = 'source-over';
        // Pendant qu'il rejoint sa spirale, il passe derrière la carte : il traversait le nombre juste après la révélation.
        const tuck = rest > 0 && rest < 1;
        if (tuck) { co.save(); co.beginPath(); co.rect(0, 0, env.W, env.H); roundRect2(co, card.x, card.y, card.w, card.h, card.r); co.clip('evenodd'); }
        const body = []; for (let i = N - 1; i >= 1; i--) body.push([i, spot(s - i * DS, i), rad(i)]);
        co.globalAlpha = .9; co.fillStyle = '#080202'; // le cerne : il détache le corps du fond
        for (const [, b, r] of body) { co.beginPath(); co.arc(b.x, b.y, r + 1.7, 0, TAU); co.fill(); }
        // Les pattes, sous le corps : une courte patte de chaque côté, trois griffes dorées, qui marchent.
        co.lineCap = 'round';
        for (const li of [11, 28]) {
          const b = spot(s - li * DS, li), r = rad(li);
          for (const sd of [-1, 1]) {
            const a = b.ang + sd * (1.95 + .35 * Math.sin(tt * 9 + li + sd)), kx = b.x + Math.cos(a) * (r + 6 * K), ky = b.y + Math.sin(a) * (r + 6 * K);
            co.globalAlpha = 1; co.strokeStyle = OBS; co.lineWidth = 3.6 * K; co.beginPath(); co.moveTo(b.x, b.y); co.lineTo(kx, ky); co.stroke();
            co.strokeStyle = GOLD; co.lineWidth = 1.2 * K;
            for (const da of [-.55, 0, .55]) { co.beginPath(); co.moveTo(kx, ky); co.lineTo(kx + Math.cos(a + da - sd * .5) * 4.2 * K, ky + Math.sin(a + da - sd * .5) * 4.2 * K); co.stroke(); }
          }
        }
        for (const [i, b, r] of body) {
          const fx = Math.cos(b.ang), fy = Math.sin(b.ang);
          co.globalAlpha = 1; co.fillStyle = OBS; co.beginPath(); co.arc(b.x, b.y, r, 0, TAU); co.fill();
          co.fillStyle = RED; co.beginPath(); co.arc(b.x + fx * r * .26, b.y + fy * r * .26, r * .74, 0, TAU); co.fill(); // le bord de l'écaille
          co.fillStyle = '#3a0f0c'; co.beginPath(); co.arc(b.x + fx * r * .6, b.y + fy * r * .6, r * .7, 0, TAU); co.fill();
          if (i % 2 === 0 && r > 2.6) { co.save(); co.translate(b.x, b.y); co.rotate(b.ang); co.fillStyle = GOLD; co.beginPath(); co.moveTo(r * .8, 0); co.lineTo(0, -r * .34); co.lineTo(-r * .55, 0); co.lineTo(0, r * .34); co.closePath(); co.fill(); co.restore(); } // l'arête dorsale
          if (i === N - 1) { co.save(); co.translate(b.x, b.y); co.rotate(b.ang + Math.PI); co.fillStyle = GOLD; for (const da of [-.5, 0, .5]) { co.rotate(da ? da : 0); co.beginPath(); co.moveTo(0, -1.8 * K); co.lineTo(11 * K, 0); co.lineTo(0, 1.8 * K); co.closePath(); co.fill(); co.rotate(da ? -da : 0); } co.restore(); } // le plumet de la queue
          if (i >= 1 && i <= 4) { co.save(); co.translate(b.x, b.y); co.rotate(b.ang); co.fillStyle = GOLD; for (const sd of [-1, 1]) { co.beginPath(); co.moveTo(2, sd * r * .7); co.lineTo(-9 * K - i, sd * (r + 6 * K + Math.sin(tt * 6 + i) * 1.5)); co.lineTo(-3, sd * r * .95); co.closePath(); co.fill(); } co.restore(); } // la crinière
        }
        const hd = spot(s, 0), mouth = { x: hd.x + Math.cos(hd.ang) * 27 * K, y: hd.y + Math.sin(hd.ang) * 27 * K };
        head(hd);
        if (tuck) co.restore();
        // Le corps rougeoie quand la tension monte ; les yeux et la gueule brillent.
        co.globalCompositeOperation = add;
        if (revealed && asc >= 1) for (let i = 1; i < N; i += 2) { const b = spot(s - i * DS, i); dot(co, GOLD, b.x, b.y, rad(i) * 2.4, (dark ? .35 : .2) * clamp(since * 2) * (.7 + .3 * Math.sin(t * 6 - i * .4))); } // le dragon d'or
        if (heat > .55) for (let i = 2; i < N; i += 3) { const b = spot(s - i * DS, i); dot(co, EMBER, b.x, b.y, rad(i) * 2.1, (heat - .55) * (dark ? .3 : .18)); }
        for (const sd of [-1, 1]) { const ex = hd.x + (Math.cos(hd.ang) * 5.5 - Math.sin(hd.ang) * sd * 6.2) * K, ey = hd.y + (Math.sin(hd.ang) * 5.5 + Math.cos(hd.ang) * sd * 6.2) * K; dot(co, '#fde047', ex, ey, 4.5 * K, .5 + .4 * Math.min(1, heat)); }
        dot(co, PALE, mouth.x, mouth.y, (2.5 + 9 * jaw) * K, .15 + .75 * jaw);
        // Le souffle : un jet de flammes de la gueule vers le chiffre qui vient de se poser.
        for (let i = breaths.length - 1; i >= 0; i--) {
          const b = breaths[i]; b.t += dt; jaw = 1;
          const dx = b.x - mouth.x, dy = b.y - mouth.y, d = Math.hypot(dx, dy) || 1, v = d / .2;
          for (let n = emitF((b.big ? 150 : 100) * q, dt); n > 0; n--) { const a = Math.atan2(dy, dx) + rnd(-.11, .11), k = rnd(.78, 1.12); flame(mouth.x, mouth.y, Math.cos(a) * v * k, Math.sin(a) * v * k, rnd(5, 9) * (b.big ? 1.3 : 1), rnd(.22, .34)); }
          if (!b.hit && b.t > .17) { b.hit = true; innerFlash = 1; glints.add({ x: b.x, y: b.y, size: card.h * (b.big ? .55 : .34), life: .5 }); for (let n = Math.round((b.big ? 20 : 10) * q); n > 0; n--) { const a = rnd(TAU), sp = rnd(60, b.big ? 280 : 190); embers.add({ x: b.x, y: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 50, g: 240, drag: 1.4, max: rnd(.5, 1.1), size: rnd(1, 2.2), c: pick([GOLD, EMBER, PALE]), tw: rnd(TAU) }); } }
          if (b.t > b.life) breaths.splice(i, 1);
        }
        // En furie : la gueule laisse échapper des flammes pendant la montée, puis crache devant elle après la révélation.
        if (heat > .85 || (revealed && since < .9)) for (let n = emitF((revealed ? 120 : 40) * q, dt); n > 0; n--) { jaw = Math.max(jaw, .7); const a = hd.ang + rnd(-.3, .3), sp = rnd(120, revealed ? 420 : 220); flame(mouth.x, mouth.y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(4, 8), rnd(.25, .5)); }
        flames.step(dt);
        flames.each((d, k) => { const c = FIRE[Math.min(FIRE.length - 1, (k * FIRE.length) | 0)], r = d.size * (.7 + 1.5 * k); dot(co, dark ? c : (k < .35 ? '#fbbf24' : k < .7 ? EMBER : '#b91c1c'), d.x, d.y, r, (1 - k) * (dark ? .9 : .8)); });
        if (glints.n) behind(env, () => glints.run(dt, (g, k) => { const a = 1 - outCubic(k), r = g.size * (.4 + outExpo(k)); dot(co, '#ffffff', g.x, g.y, r * .32, a); dot(co, PALE, g.x, g.y, r * 2.3, a * .95, 1.5); dot(co, PALE, g.x, g.y, 1.5, a * .95, r * 2.3); dot(co, EMBER, g.x, g.y, r, a * .5); })); // derrière la carte : l'éclat de la forge ne couvre pas les chiffres
        // Le trésor : des pièces d'or qui retombent en tournant.
        co.globalCompositeOperation = 'source-over';
        coins.step(dt);
        if (coins.n) behind(env, () => coins.each((d, k) => { co.save(); co.translate(d.x, d.y); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = d.c; SHAPES.coin(co, d, d.size); co.restore(); })); // elles passent derrière le nombre
      },
      lock(pos, o) {
        if (o.ghost) return;
        breaths.push({ x: pos.x, y: pos.y, t: 0, life: o.last ? .42 : .3, big: !!o.last, hit: false });
        if (o.last) { target = .35; rings.add({ life: .8, grow: 30, width: 1, delay: .18 }); }
        heat = Math.min(1.4, heat + .16);
      },
      build() { target = 1.3; },
      reveal(tier) {
        p = POWER[tier] || 0; asc = ASCEND[tier] || 0; revealed = true; since = 0; heat = .8 + .7 * p; target = .3 + .3 * p; jaw = 1;
        for (let i = 0; i < 2 + Math.round(2 * p); i++) rings.add({ delay: i * .14, life: 1, grow: 30 + 20 * i + 34 * p, width: 1 + .6 * p });
        glints.add({ x: cx, y: cy, size: card.h * (.7 + 1 * p), life: .9 });
        for (let i = burst(p, 170 * q, 14); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.5, .5), v = rnd(90, 220 + 380 * p); flame(from.x, from.y, Math.cos(a) * v, Math.sin(a) * v, rnd(5, 10 + 5 * p), rnd(.45, .9 + .5 * p)); }
        for (let i = burst(p, 64 * (1 + .6 * asc) * q, 5); i > 0; i--) coins.add({ x: card.x + rnd(-40, card.w + 40), y: card.y - rnd(30, 120), vx: rnd(-50, 50), vy: rnd(-140, 20), g: 560, drag: .3, max: rnd(1.5, 2.6), size: rnd(3.4, 5.6), c: pick(['#fbbf24', '#f59e0b', '#fde68a']), rot: rnd(TAU) });
      },
    };
  };

  // 🕳️ Singularity — la carte devient un trou noir : un disque d'accrétion tourne autour d'elle (bleuté du côté qui
  // approche, orangé de celui qui fuit), l'anneau de photons et son arc déformé l'entourent, les étoiles sont
  // aspirées. Chaque chiffre fait partir une onde ; avant le dernier, tout se resserre ; à la révélation, effondrement
  // puis deux jets de lumière, des ondes en ellipse, la matière projetée — et il reste un anneau d'Einstein.
  SCENES.blackhole = env => {
    const { ci, co, w, h, W, H, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const HOT = dark ? '#fff4d6' : '#b45309', ORANGE = dark ? '#fb923c' : '#c2410c', BLUEW = dark ? '#bfdbfe' : '#1d4ed8', VIOLET = dark ? '#a78bfa' : '#6d28d9', STAR = dark ? '#ffffff' : '#334155';
    // RY : le bas de l'anneau passe au-dessus de la ligne de rareté (« Epic · Top 7 % » le coupait, A Dude 2026-10-18).
    let RX = card.w * .5 + 30; // suit la largeur réelle de la carte (mise à jour à chaque image)
    const RY = card.h * .5 + 6, TILT = -.09, cosT = Math.cos(TILT), sinT = Math.sin(TILT);
    const place = (a, rx, ry) => { const x = Math.cos(a) * rx, y = Math.sin(a) * ry; return { x: cx + x * cosT - y * sinT, y: cy + x * sinT + y * cosT }; };
    const disc = Array.from({ length: Math.round(170 * q) }, () => { const r = rnd(1, 1.36); return { a: rnd(TAU), r, r0: r, s: rnd(.7, 1.8) }; });
    const far = Math.min(W, H * 1.6) / 2, star = d => ({ a: rnd(TAU), d: d || rnd(RX * 1.1, far), tw: rnd(TAU), size: rnd(.6, 1.5) });
    const stars = Array.from({ length: Math.round(48 * q) }, () => star());
    const jets = particles(), flung = particles(), pulses = timed(), flashes = timed(), emit = emitter();
    let asc = 0, heat = 0, target = .35, p = 0, since = 0, revealed = false, squeeze = 1, squeezeTo = 1, jet = 0, banged = false, innerFlash = 0;
    const ellipse = (rx, ry, a0 = 0, a1 = TAU, ox = 0, oy = 0) => { co.beginPath(); co.ellipse(cx + ox, cy + oy, Math.max(.1, rx), Math.max(.1, ry), TILT, a0, a1); };
    return {
      frame(t, dt) {
        RX += (card.w * .5 + 30 - RX) * Math.min(1, dt * 8); // la carte rétrécit : l'anneau aussi, en douceur
        heat += (target - heat) * Math.min(1, dt * 3); since += dt; innerFlash = Math.max(0, innerFlash - dt * 2.6);
        if (revealed && since < .16) squeezeTo = .5; else if (revealed && !banged) {
          banged = true; squeezeTo = 1; jet = 1; innerFlash = 1;
          flashes.add({ x: cx, y: cy, life: .9, size: card.h * (1.1 + 1.6 * p) });
          for (let i = 0; i < 2 + Math.round(2 * p); i++) pulses.add({ x: cx, y: cy, delay: i * .12, life: 1, from: 1, grow: .16 + .14 * i + .24 * p, width: 1 + .6 * p, k: RY / RX });
          disc.forEach(d => { d.r += rnd(.15, .55) * (.5 + p); });
          stars.forEach(sx => { sx.d += rnd(20, 90) * (.4 + p); });
          for (let i = burst(p, 140 * q, 12); i > 0; i--) { const a = rnd(TAU), from = place(a, RX, RY), v = rnd(110, 260 + 440 * p); flung.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .7, drag: 1.1, max: rnd(.6, 1.2 + .7 * p), size: rnd(.9, 2.2), c: pick([HOT, ORANGE, BLUEW]) }); }
        }
        squeeze += (squeezeTo - squeeze) * Math.min(1, dt * (revealed && !banged ? 16 : 5));
        jet = Math.max(0, jet - dt / (1.2 + 2.2 * p));
        // Dans la carte : le disque vu par la tranche, un trait de lumière derrière les chiffres, et l'éclair de l'effondrement.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, '#fb923c', w * .5, h * .5, w * .62, .16 + .2 * heat + (revealed ? .12 * p : 0), h * .13);
        dot(ci, '#fff4d6', w * .5, h * .5, w * .5 * squeeze, .12 + .2 * heat, h * .04);
        dot(ci, '#a78bfa', w * .5, -h * .1, w * .45, .08 * heat, h * .4);
        if (innerFlash > 0) { ci.globalAlpha = innerFlash * innerFlash * .32; ci.fillStyle = '#fff4d6'; ci.fillRect(0, 0, w, h); }
        // Les étoiles, aspirées en spirale ; elles renaissent au loin.
        co.globalCompositeOperation = add; co.lineCap = 'round';
        const pull = (10 + 90 * heat) * (revealed && banged && since < 1.2 ? -1.6 : 1);
        stars.forEach((sx, i) => {
          const before = { x: cx + Math.cos(sx.a) * sx.d, y: cy + Math.sin(sx.a) * sx.d * .62 };
          sx.d -= dt * pull * (far / Math.max(60, sx.d)) * .9; sx.a += dt * (.12 + .5 * heat) * (far / Math.max(60, sx.d)) * .35;
          let fresh = false; // une étoile qui vient de renaître n'a pas de traîne : elle relierait son ancienne place à la nouvelle
          if (sx.d < RX * 1.02 || sx.d > far * 1.25) { stars[i] = sx = star(sx.d < RX * 1.02 ? rnd(far * .8, far) : rnd(RX * 1.2, far * .7)); fresh = true; }
          const x = cx + Math.cos(sx.a) * sx.d, y = cy + Math.sin(sx.a) * sx.d * .62, a = (.45 + .45 * Math.sin(t * 3 + sx.tw)) * Math.min(1, (sx.d - RX) / 40);
          if (!fresh && (heat > .6 || (revealed && since < 1.2))) tail(co, STAR, before.x - (x - before.x) * 5, before.y - (y - before.y) * 5, x, y, sx.size, a * .7);
          dot(co, STAR, x, y, sx.size * (dark ? 2 : 1.3), a);
        });
        // L'arc déformé au-dessus et au-dessous (l'arrière du disque, courbé par la gravité), puis l'anneau de photons.
        const glowA = (dark ? 1 : .8) * (.35 + .45 * Math.min(1, heat) + (revealed ? .25 : 0));
        behind(env, () => {
          co.strokeStyle = ORANGE; co.globalAlpha = glowA * .5; co.lineWidth = 6; ellipse(RX * .7 * squeeze, RY * .6 * squeeze, Math.PI, TAU, 0, -RY * .34 * squeeze); co.stroke();
          co.strokeStyle = HOT; co.globalAlpha = glowA * .85; co.lineWidth = 1.5; ellipse(RX * .7 * squeeze, RY * .6 * squeeze, Math.PI, TAU, 0, -RY * .34 * squeeze); co.stroke();
          co.strokeStyle = ORANGE; co.globalAlpha = glowA * .28; co.lineWidth = 5; ellipse(RX * .62 * squeeze, RY * .5 * squeeze, 0, Math.PI, 0, RY * .36 * squeeze); co.stroke();
          co.strokeStyle = ORANGE; co.globalAlpha = glowA * .4; co.lineWidth = 8; ellipse(RX * .92 * squeeze, RY * .92 * squeeze); co.stroke();
          co.strokeStyle = HOT; co.globalAlpha = glowA; co.lineWidth = 1.5 + (revealed ? p : 0); ellipse(RX * .92 * squeeze, RY * .92 * squeeze); co.stroke();
          if (revealed && banged) { const fade = Math.max(0, Math.min(1, 4 + 4 * p - since)); co.strokeStyle = BLUEW; co.globalAlpha = fade * (.5 + .3 * Math.sin(t * 6)); co.lineWidth = 1; ellipse(RX * 1.02, RY * 1.02); co.stroke(); } // l'anneau d'Einstein
        }, revealed && since > .5);
        // Le disque : chaque grain file sur son orbite, d'autant plus vite qu'il est près.
        const rate = (1 + 2.8 * heat) * (revealed && !banged ? 3 : 1);
        disc.forEach(d => {
          d.r += (d.r0 - d.r) * Math.min(1, dt * 1.4);
          const om = rate / Math.pow(d.r, 1.5), a0 = d.a; d.a += dt * om;
          const pa = place(a0 - om * .045, RX * d.r * squeeze, RY * d.r * squeeze), pb = place(d.a, RX * d.r * squeeze, RY * d.r * squeeze), c = Math.cos(d.a);
          tail(co, c < -.3 ? BLUEW : c < .35 ? HOT : ORANGE, pa.x, pa.y, pb.x, pb.y, d.s, (Math.sin(d.a) > 0 ? .95 : .5) * (dark ? 1 : .85));
        });
        // Les ondes : une ellipse qui s'élargit depuis un chiffre, ou depuis la carte entière à la révélation.
        pulses.run(dt, (u, k) => { const e = outCubic(k), rx = (u.from ? RX * (u.from + u.grow * e) : 4 + u.size * e); co.beginPath(); co.ellipse(u.x, u.y, rx, Math.max(.1, rx * u.k), TILT, 0, TAU); co.globalAlpha = (1 - k) * .16; co.strokeStyle = ORANGE; co.lineWidth = 5 * u.width; co.stroke(); co.globalAlpha = (1 - k) * .8; co.strokeStyle = HOT; co.lineWidth = 1.1 * u.width; co.stroke(); });
        // Les éclats passent derrière la carte : l'effondrement illumine le nombre sans l'effacer.
        if (flashes.n) behind(env, () => flashes.run(dt, (f, k) => { const a = 1 - outCubic(k); dot(co, '#ffffff', f.x, f.y, f.size * (.4 + .8 * k), a * (dark ? .95 : .7)); dot(co, dark ? '#fff4d6' : ORANGE, f.x, f.y, 2.5, a, f.size * 2.8); dot(co, dark ? '#fb923c' : ORANGE, f.x, f.y, f.size * (1.4 + 2 * k), a * .45); }));
        if (revealed && banged && p >= 1) {
          const life = clamp((since - .16) * 2.5) * clamp((3.4 + 1.5 * asc - since) / 1.4);
          // Celestial et plus : l'espace-temps se creuse — une grille qui plonge vers le nombre, derrière la carte.
          if (asc >= 1 && life > .01) behind(env, () => {
            co.globalCompositeOperation = add; co.strokeStyle = dark ? VIOLET : '#6d28d9'; co.lineWidth = 1;
            const GX = card.w * 1.5, GY = card.h * 2.2, depth = .85 * life * (1 + .1 * Math.sin(t * 2));
            const warp = (x, y) => { const dx = x - cx, dy = (y - cy) * 1.6, d = Math.hypot(dx, dy) || 1, k = 1 - depth * Math.exp(-d / (card.w * .45)); return [cx + dx * k, cy + (dy * k) / 1.6]; };
            for (let gi = -6; gi <= 6; gi++) for (const vert of [0, 1]) {
              co.globalAlpha = life * (dark ? .55 : .35) * (1 - Math.abs(gi) / 7.5); co.beginPath();
              for (let j = 0; j <= 24; j++) { const u = j / 24 * 2 - 1, [x, y] = vert ? warp(cx + gi * GX / 6, cy + u * GY / 2) : warp(cx + u * GX, cy + gi * GY / 12); j ? co.lineTo(x, y) : co.moveTo(x, y); }
              co.stroke();
            }
          }, true);
          // Mythic et plus : un éclat de lumière fait le tour de l'anneau de photons (la lumière qui orbite le trou noir).
          behind(env, () => {
            co.globalCompositeOperation = add;
            for (let j = 0; j < 1 + asc; j++) {
              const head = since * (3.2 + .6 * j) + j * Math.PI;
              for (let i = 0; i < 18; i++) { const pt = place(head - i * .06, RX * .92 * squeeze, RY * .92 * squeeze); dot(co, i ? (j % 2 ? BLUEW : HOT) : '#ffffff', pt.x, pt.y, (i ? 9 - i * .4 : 13) * (1 + .2 * asc), life * (1 - i / 18)); }
            }
            // Divine et plus : un halo irisé, trois anneaux décalés (violet, bleu, or) qui respirent.
            if (asc >= 2) [[VIOLET, 1.16], [BLUEW, 1.24], [HOT, 1.32]].forEach(([c, k], i) => { co.strokeStyle = c; co.globalAlpha = life * .45 * (.7 + .3 * Math.sin(t * 3 + i)); co.lineWidth = 2; ellipse(RX * k, RY * k); co.stroke(); });
          }, since > .5);
        }
        flung.step(dt);
        flung.each((d, k) => tail(co, d.c, d.x - d.vx * .05, d.y - d.vy * .05, d.x, d.y, d.size, 1 - k));
        // Les jets : deux faisceaux qui partent des deux bouts de la carte, à l'horizontale — au-dessus et au-dessous,
        // ils passeraient sous l'en-tête du site et sur le score.
        if (jet > 0) {
          const L = (card.x - 10) * outCubic(Math.min(1, (since - .16) / .22)), a = Math.min(1, jet * 1.6);
          for (const dir of [-1, 1]) {
            const x0 = cx + dir * (card.w / 2 + 4), x1 = x0 + dir * L;
            tail(co, VIOLET, x1, cy, x0, cy, 16 * (.5 + p) * jet + 3, a * .4); tail(co, BLUEW, x1, cy, x0, cy, 7 * (.5 + p) * jet + 2, a * .7); tail(co, dark ? '#ffffff' : BLUEW, x1, cy, x0, cy, 2.2, a);
            for (let n = emit(110 * q * jet, dt); n > 0; n--) jets.add({ x: x0, y: cy + rnd(-4, 4), vx: dir * rnd(320, 700) * (.6 + .5 * p), vy: rnd(-26, 26), max: rnd(.3, .6), size: rnd(.9, 2) });
          }
        }
        jets.step(dt);
        jets.each((d, k) => tail(co, dark ? '#ffffff' : BLUEW, d.x - d.vx * .03, d.y - d.vy * .03, d.x, d.y, d.size, (1 - k) * .9));
      },
      lock(pos, o) {
        if (o.ghost) return;
        pulses.add({ x: pos.x, y: pos.y, life: o.last ? .7 : .5, size: card.h * (o.last ? 1.5 : .9), width: o.last ? 1.4 : 1, k: .8 });
        flashes.add({ x: pos.x, y: pos.y, life: .45, size: card.h * (o.last ? .45 : .28) });
        for (let i = Math.round((o.last ? 16 : 8) * q); i > 0; i--) { const a = rnd(TAU), v = rnd(80, o.last ? 300 : 200); flung.add({ x: pos.x, y: pos.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .6, drag: 1.6, max: rnd(.35, .8), size: rnd(.8, 1.8), c: pick([HOT, ORANGE, BLUEW]) }); }
        squeeze = .93; innerFlash = Math.max(innerFlash, .5);
        if (o.last) { target = .35; squeezeTo = 1; }
        heat = Math.min(1.45, heat + .17);
      },
      build() { target = 1.35; squeezeTo = .88; },
      reveal(tier) { p = POWER[tier] || 0; asc = ASCEND[tier] || 0; revealed = true; banged = false; since = 0; heat = .8 + .7 * p; target = .3 + .3 * p; },
    };
  };

  // 🌴 Vaporwave (refonte du 2026-10-07) — un crépuscule synthwave, net et calme : un grand soleil rayé monte derrière
  // la carte, un cran par chiffre ; la ligne d'horizon se prolonge de chaque côté ; deux palmiers en néon se balancent ;
  // un trait de laser passe sous chaque chiffre qui se pose. À la révélation : le soleil rayonne, des arcs de néon
  // s'élèvent, des étoiles filent. Peu d'éléments, tous grands — et rien de durable sous la carte.
  SCENES.vaporwave = env => {
    const { ci, co, w, h, W, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const PINK = dark ? '#f472b6' : '#be185d', HOT = dark ? '#ff71ce' : '#a21caf', CYAN = dark ? '#67e8f9' : '#0e7490', SUN1 = '#fff59d', SUN2 = '#fb923c', SUN3 = '#f43f5e', WHITE = dark ? '#ffffff' : '#701a75';
    const R = Math.min(card.w * .34, card.h * .92), sparks = particles(), bokeh = particles(), lasers = timed(), glints = timed(), arcs = timed(), comets = timed(), emit = emitter();
    let heat = 0, target = .35, p = 0, since = 0, revealed = false, locked = 0, rise = 0, riseTo = .08, formed = 0;
    // Un palmier en néon : un tronc courbe, sept palmes qui retombent ; `dir` = de quel côté il penche.
    function palm(bx, by, dir, t) {
      const top = { x: bx + dir * 14, y: by - (card.h + 24) }, sway = Math.sin(t * 1.3 + dir) * (.04 + .05 * Math.min(1, heat));
      const stroke = (width, a, color) => { co.lineWidth = width; co.globalAlpha = a * formed; co.strokeStyle = color; co.stroke(); };
      co.lineCap = 'round'; co.lineJoin = 'round';
      co.beginPath(); co.moveTo(bx, by); co.quadraticCurveTo(bx - dir * 8, by - (card.h + 24) * .55, top.x, top.y);
      co.globalCompositeOperation = add; stroke(7, .16, HOT); stroke(2.4, .95, PINK);
      for (let i = 0; i < 7; i++) {
        const a = -Math.PI / 2 + (i - 3) * .52 + sway * (1 + Math.abs(i - 3) * .4), len = 27 - Math.abs(i - 3) * 2.2;
        const ex = top.x + Math.cos(a) * len, ey = top.y + Math.sin(a) * len * .72 + 10 + Math.abs(i - 3) * 2.4;
        co.beginPath(); co.moveTo(top.x, top.y); co.quadraticCurveTo(top.x + Math.cos(a) * len * .6, top.y + Math.sin(a) * len * .95 - 3, ex, ey);
        stroke(6, .13, i % 2 ? CYAN : HOT); stroke(1.9, .95, i % 2 ? CYAN : PINK);
      }
    }
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3); since += dt; formed = Math.min(1, formed + dt * 1.6);
        rise += (riseTo - rise) * Math.min(1, dt * 4);
        // Dans la carte : la lueur du couchant sur l'horizon, et un reflet qui la traverse.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, '#fb7185', w * .5, h * .66, w * .5, .1 + .14 * heat + (revealed ? .12 * p : 0), h * .3);
        dot(ci, '#ffffff', w * (((t * .2) % 1.6) * 1.25 - .3), h * .45, h * .3, .1, h * 1.2);
        // Le soleil, derrière la carte : il ne dépasse que par le haut, de plus en plus à mesure que les chiffres tombent.
        const capMax = Math.min(44, R * .7), sy = card.y + R - capMax * rise, flare = revealed ? Math.max(0, 1 - since / (4 + 4 * p)) : 0;
        behind(env, () => {
          co.globalCompositeOperation = add;
          dot(co, dark ? '#f472b6' : '#f9a8d4', cx, card.y, R * (1.5 + .3 * heat), (dark ? .2 : .3) * rise * (.7 + .3 * heat));
          // Les rayons de la révélation, en éventail au-dessus de l'horizon.
          if (flare > 0) { const open = outCubic(Math.min(1, since / .5)); for (let i = 0; i < 13; i++) { const a = -Math.PI + ((i + .5) / 13) * Math.PI + Math.sin(t * .4) * .04, len = R * (1.25 + .9 * p) * open * (i % 2 ? 1 : .74); tail(co, i % 2 ? SUN1 : HOT, cx + Math.cos(a) * (R + len), sy + Math.sin(a) * (R + len), cx + Math.cos(a) * R * .9, sy + Math.sin(a) * R * .9, 5 + 5 * p, flare * (dark ? .5 : .65)); } }
          co.globalCompositeOperation = 'source-over';
          co.save(); co.beginPath(); co.rect(0, 0, W, card.y + 2); co.clip(); // seulement la calotte au-dessus de la carte
          co.beginPath(); co.arc(cx, sy, R, 0, TAU); co.clip();
          const g = co.createLinearGradient(0, sy - R, 0, sy - R + capMax * 1.25); g.addColorStop(0, SUN1); g.addColorStop(.45, SUN2); g.addColorStop(1, SUN3);
          co.globalAlpha = .96; co.fillStyle = g; co.fillRect(cx - R, sy - R, R * 2, R * 2);
          // Les fentes : trois bandes vides, de plus en plus épaisses vers l'horizon.
          co.globalCompositeOperation = 'destination-out'; co.globalAlpha = 1;
          [[5, 3.4], [14, 2.6], [22, 1.8]].forEach(([up, thick]) => co.fillRect(cx - R, card.y - up, R * 2, thick));
          co.restore();
        }, true);
        // L'horizon se prolonge de part et d'autre de la carte : un filet rose, un cœur clair.
        co.globalCompositeOperation = add; co.lineCap = 'round';
        const reach = (card.x - 12) * (.35 + .65 * Math.min(1, heat * .8 + (flare > 0 ? .6 : 0))) * formed, hy = card.y + card.h * .66;
        for (const dir of [-1, 1]) { const x0 = cx + dir * (card.w / 2 + 3); tail(co, HOT, x0 + dir * reach, hy, x0, hy, 6, .22 + .3 * Math.min(1, heat)); tail(co, dark ? '#ffffff' : CYAN, x0 + dir * reach * .8, hy, x0, hy, 1.4, .55 + .4 * Math.min(1, heat)); }
        // Les deux palmiers.
        palm(card.x - 34, card.y + card.h + 8, -1, t);
        palm(card.x + card.w + 34, card.y + card.h + 8, 1, t);
        // Des halos qui montent doucement de chaque côté.
        co.globalCompositeOperation = add;
        for (let n = emit((3 + 9 * heat) * q, dt); n > 0; n--) { const side = Math.random() < .5 ? -1 : 1; bokeh.add({ x: cx + side * (card.w / 2 + rnd(20, Math.min(170, card.x - 20))), y: card.y + card.h + rnd(0, 30), vx: rnd(-6, 6), vy: -rnd(12, 34) * (1 + .6 * heat), max: rnd(2.4, 4.4), size: rnd(3, 9), c: pick([PINK, CYAN, SUN2]), tw: rnd(TAU) }); }
        bokeh.step(dt);
        bokeh.each((d, k) => dot(co, d.c, d.x + Math.sin(t * 1.2 + d.tw) * 5, d.y, d.size, Math.sin(Math.PI * k) * (dark ? .34 : .4)));
        // Arcs de néon de la révélation : des demi-ellipses qui s'élèvent au-dessus de la carte, découpées derrière elle.
        behind(env, () => arcs.run(dt, (a, k) => { const e = outCubic(k), rx = card.w * (.42 + a.grow * e), ry = (card.h * .5 + 16 + 30 * a.grow * e); co.beginPath(); co.ellipse(cx, cy, rx, ry, 0, Math.PI, TAU); co.globalAlpha = (1 - k) * .2; co.strokeStyle = a.c; co.lineWidth = 6; co.stroke(); co.globalAlpha = (1 - k) * .9; co.strokeStyle = dark ? '#ffffff' : a.c; co.lineWidth = 1.2; co.stroke(); }), true);
        // Le laser sous le chiffre qui se pose, puis l'éclat sur son chrome.
        lasers.run(dt, (l, k) => { const e = outExpo(Math.min(1, k * 2)), a = 1 - Math.pow(k, 1.5), half = l.len * e; tail(co, HOT, l.x - half, l.y, l.x, l.y, 5 * l.w, a * .5); tail(co, CYAN, l.x + half, l.y, l.x, l.y, 5 * l.w, a * .5); tail(co, dark ? '#ffffff' : HOT, l.x - half * .8, l.y, l.x, l.y, 1.4 * l.w, a); tail(co, dark ? '#ffffff' : CYAN, l.x + half * .8, l.y, l.x, l.y, 1.4 * l.w, a); });
        glints.run(dt, (g, k) => { const a = 1 - outCubic(k), r = g.size * (.4 + outExpo(k)); dot(co, '#ffffff', g.x, g.y, r * .3, a); dot(co, dark ? '#ffffff' : HOT, g.x, g.y, r * 2.4, a * .9, 1.3); dot(co, dark ? '#ffffff' : HOT, g.x, g.y, 1.3, a * .9, r * 2.4); dot(co, PINK, g.x, g.y, r, a * .45); });
        // Étoiles filantes, dans le ciel de part et d'autre.
        comets.run(dt, (c, k) => { const x = c.x + c.vx * k, y = c.y + c.vy * k, a = Math.sin(Math.PI * k); tail(co, dark ? '#ffffff' : HOT, x - c.vx * .16, y - c.vy * .16, x, y, 1.8, a); dot(co, dark ? '#ffffff' : HOT, x, y, 3.2, a); });
        // Petites étoiles à quatre branches qui s'envolent.
        co.globalCompositeOperation = 'source-over';
        sparks.step(dt);
        sparks.each((d, k) => { co.save(); co.translate(d.x, d.y); co.rotate(d.rot + d.vr * d.life); co.globalAlpha = Math.min(1, (1 - k) * 2.2) * (.6 + .4 * Math.sin(t * 13 + d.tw)); co.fillStyle = d.c; SHAPES.star(co, d, d.size); co.restore(); });
      },
      lock(pos, o) {
        if (o.ghost) return;
        locked++; riseTo = Math.min(1, .08 + locked * .16);
        lasers.add({ x: pos.x, y: pos.y + card.h * .3, len: card.h * (o.last ? 1.9 : 1.1), w: o.last ? 1.4 : 1, life: .42 });
        glints.add({ x: pos.x + card.h * .1, y: pos.y - card.h * .2, size: card.h * (o.last ? .46 : .28), life: .5, delay: .06 });
        for (let i = Math.round((o.last ? 12 : 6) * q); i > 0; i--) { const a = -Math.PI / 2 + rnd(-1.1, 1.1), v = rnd(50, o.last ? 190 : 130); sparks.add({ x: pos.x, y: pos.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 90, drag: 1.5, max: rnd(.6, 1.1), size: rnd(1.6, 3), c: pick([PINK, CYAN, SUN1]), rot: rnd(TAU), vr: rnd(-3, 3), tw: rnd(TAU) }); }
        if (o.last) { riseTo = 1; target = .35; }
        heat = Math.min(1.4, heat + .16);
      },
      build() { target = 1.3; riseTo = Math.max(riseTo, .92); },
      reveal(tier) {
        p = POWER[tier] || 0; revealed = true; since = 0; heat = .7 + .7 * p; target = .3 + .3 * p; riseTo = 1;
        for (let i = 0; i < 2 + Math.round(2 * p); i++) arcs.add({ delay: i * .16, life: 1.2, grow: .16 + .14 * i + .2 * p, c: i % 2 ? CYAN : HOT });
        glints.add({ x: cx, y: cy - card.h * .2, size: card.h * (.6 + .8 * p), life: .9 });
        lasers.add({ x: cx, y: card.y + card.h * .66, len: card.w * (.7 + .5 * p), w: 1.6 + p, life: .6 });
        for (let i = 0; i < 1 + Math.round(4 * p); i++) { const side = i % 2 ? -1 : 1; comets.add({ delay: .15 + i * .22, life: .7, x: cx + side * (card.w / 2 + rnd(30, 140)), y: card.y - rnd(20, 44), vx: -side * rnd(120, 200), vy: rnd(50, 90) }); }
        for (let i = burst(p, 90 * q, 8); i > 0; i--) { const from = along(grown(card, 8), rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.5, .5), v = rnd(60, 160 + 300 * p); sparks.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 50, g: 110, drag: 1.2, max: rnd(.9, 1.6 + p), size: rnd(1.8, 3.6 + 1.5 * p), c: pick([PINK, CYAN, SUN1, '#ffffff']), rot: rnd(TAU), vr: rnd(-4, 4), tw: rnd(TAU) }); }
      },
    };
  };

  // ♾️ Infinity (caisse Premium seulement, 2026-10-13) — une galaxie pliée en boucle. Dans la carte, une nébuleuse
  // dont les couleurs passent lentement de l'une à l'autre et des étoiles qui scintillent. Autour, un ∞ (lemniscate de
  // Bernoulli) dont la carte occupe le croisement, ses boucles passant derrière elle : une étincelle le parcourt
  // pendant le tirage, plus vite à chaque chiffre posé, et s'emballe avant le dernier ; à la révélation, une comète
  // trace le ∞ entier dans une traînée aux couleurs de la nébuleuse, des étoiles s'en détachent, puis il s'éteint
  // doucement et l'étincelle reprend sa ronde.
  SCENES.infinity = env => {
    const { ci, co, w, h, W, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const HUES = dark ? ['#67e8f9', '#a78bfa', '#f0abfc', '#fde68a', '#f472b6', '#818cf8'] : ['#0891b2', '#7c3aed', '#c026d3', '#d97706', '#db2777', '#4f46e5'];
    const WHITE = dark ? '#ffffff' : '#6d28d9';
    // Demi-largeur du ∞ (il déborde de la carte de chaque côté) et aplatissement : ses lobes dépassent à peine la carte.
    const A = Math.min(card.w / 2 + Math.min(150, card.h * 1.6 + 30), W / 2 - 34), KY = Math.min(1.1, (card.h * .5 + Math.max(16, card.h * .42)) / (A * .3536));
    const at = u => { const sn = Math.sin(u), d = 1 + sn * sn; return { x: cx + (A * Math.cos(u)) / d, y: cy + (KY * A * sn * Math.cos(u)) / d }; };
    const hue = k => HUES[(((Math.floor(k) % HUES.length) + HUES.length) % HUES.length)];
    const stars = Array.from({ length: Math.round(34 * q) }, () => ({ x: rnd(), y: rnd(), r: rnd(.6, 1.7), tw: rnd(TAU), sp: rnd(1.2, 3.4), c: pick(['#ffffff', '#ffffff', '#a5f3fc', '#f5d0fe', '#fde68a']) }));
    const clouds = [['#ec4899', '#7c3aed', .25, .4, 0], ['#22d3ee', '#3b82f6', .75, .6, 2.1], ['#7c3aed', '#ec4899', .5, .5, 4.2], ['#fbbf24', '#22d3ee', .4, .2, 5.3]].map(([c0, c1, x, y, ph]) => ({ c0, c1, x, y, ph }));
    const motes = particles(), flares = timed(), rings = timed();
    let u = rnd(TAU), spd = 1.1, spdTo = 1.1, heat = 0, target = .4, core = 0, nebula = 1, fig = 0, figLife = 3, sweeping = false, swept = 0, sweepDur = 1, dim = 0;
    // Un tronçon du ∞, de u0 à u0 - len (vers l'arrière), en morceaux de couleur ; fall : la queue s'efface. Chaque
    // morceau est un seul tracé à bouts plats : pas de perles là où deux segments se recouvriraient.
    function stroke(u0, len, a, width, fall, shift) {
      const n = Math.max(6, Math.round(len * 18 * q)), step = len / n, per = 4;
      co.lineCap = 'butt'; co.lineJoin = 'round';
      for (let i0 = 0; i0 < n; i0 += per) {
        const k = (i0 + per / 2) / n, al = a * Math.pow(Math.max(0, 1 - k), fall), wd = width * (fall ? 1 - .6 * k : 1);
        if (al <= .01) continue;
        co.beginPath();
        for (let i = i0; i <= Math.min(n, i0 + per); i++) { const pt = at(u0 - i * step); i === i0 ? co.moveTo(pt.x, pt.y) : co.lineTo(pt.x, pt.y); }
        co.strokeStyle = hue(k * HUES.length * (len / TAU) * 2 + shift);
        co.globalAlpha = Math.min(1, al * (dark ? .16 : .1)); co.lineWidth = wd * 4.2; co.stroke();
        co.globalAlpha = Math.min(1, al); co.lineWidth = wd; co.stroke();
      }
      co.lineCap = 'round';
    }
    const shed = (pt, v, n) => { for (let i = n; i > 0; i--) { const a = rnd(TAU), sp = rnd(10, v); motes.add({ x: pt.x, y: pt.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 1.5, max: rnd(.6, 1.4), size: rnd(1.4, 3), c: pick(HUES.concat(WHITE)), tw: rnd(TAU) }); } };
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3);
        spd += (spdTo - spd) * Math.min(1, dt * 2.5);
        core = Math.max(0, core - dt * 1.3);
        nebula += (1 - nebula) * Math.min(1, dt * .8);
        dim = Math.max(0, dim - dt * .6);
        fig = Math.max(0, fig - dt / figLife);
        // Dans la carte : nuages qui passent d'une couleur à l'autre, étoiles qui scintillent.
        ci.globalCompositeOperation = 'lighter';
        for (const n of clouds) {
          const f = .5 + .5 * Math.sin(t * .23 + n.ph), x = w * (n.x + .1 * Math.sin(t * .17 + n.ph)), y = h * (n.y + .2 * Math.cos(t * .13 + n.ph)), a = .12 * nebula * (1 - .8 * dim); // .12 : la carte reste du verre noir (refonte du 2026-10-24)
          dot(ci, n.c0, x, y, h * 1.15, a * (1 - f));
          dot(ci, n.c1, x, y, h * 1.15, a * f);
        }
        for (const st of stars) {
          const a = Math.pow(.5 + .5 * Math.sin(t * st.sp + st.tw), 3) * (.4 + .6 * Math.min(1, nebula)) * (1 - .8 * dim), x = st.x * w, y = st.y * h;
          dot(ci, st.c, x, y, st.r * 2.4, a);
          if (st.r > 1.35) { dot(ci, '#ffffff', x, y, st.r * 5, a * .7, .6); dot(ci, '#ffffff', x, y, .6, a * .7, st.r * 5); }
        }
        if (core > 0) dot(ci, '#ffffff', w / 2, h / 2, w * .45, core * .45);
        // Autour : le ∞ en filigrane, l'étincelle et sa traînée (ou la comète de la révélation), derrière la carte.
        if (sweeping) {
          swept += (dt * TAU) / sweepDur;
          u += (dt * TAU) / sweepDur;
          const head = at(u);
          shed(head, 70, Math.round(3 * q));
          if (swept >= TAU) { sweeping = false; fig = 1; }
        } else u += spd * dt;
        co.globalCompositeOperation = add;
        co.lineCap = 'round';
        behind(env, () => {
          // filigrane : assez présent pendant le tirage pour que le ∞ se lise autour de la carte (comme le disque de
          // Singularity), plus fort quand la tension monte (refonte du 2026-10-24, idée de kaz)
          stroke(u, TAU, .2 * (.7 + .3 * Math.min(1, heat)) * (1 - .7 * dim) * (1 - fig), 1.3, 0, t * .3);
          if (fig > 0) stroke(u, TAU, Math.min(1, fig * 1.6) * (dark ? .85 : .75), 2.2, 0, t * 1.2); // le ∞ tracé, qui s'éteint
          if (sweeping) stroke(u, Math.min(TAU, swept), 1, 2.6, .25, t * 1.2);
          else stroke(u, .8 + .7 * Math.min(1, heat), (.55 + .45 * Math.min(1, heat)) * (1 - .8 * dim), 1.6 + 1.2 * Math.min(1, heat), 1.6, t * .8);
        });
        const head = at(u), behindCard = Math.abs(head.x - cx) < card.w / 2 && Math.abs(head.y - cy) < card.h / 2;
        if (!behindCard) { dot(co, WHITE, head.x, head.y, 4 + 5 * Math.min(1, heat) + (sweeping ? 6 : 0), .9 * (1 - .8 * dim)); dot(co, hue(t * 2), head.x, head.y, 12 + 10 * Math.min(1, heat) + (sweeping ? 14 : 0), .5 * (1 - .8 * dim)); }
        motes.step(dt);
        motes.each((m, k) => dot(co, m.c, m.x, m.y, m.size * (1 + .5 * Math.sin(t * 9 + m.tw)), (1 - k) * (.55 + .45 * Math.sin(t * 13 + m.tw))));
        flares.run(dt, (f, k) => {
          const a = 1 - outCubic(k), r = f.size * (.5 + .7 * outExpo(k));
          dot(co, f.c, f.x, f.y, r * .9, a * .7);
          dot(co, '#ffffff', f.x, f.y, r * .3, a * (dark ? 1 : .8));
          dot(co, WHITE, f.x, f.y, r * 2.4, a * .85, Math.max(1.2, r * .07));
          dot(co, WHITE, f.x, f.y, Math.max(1.2, r * .07), a * .85, r * 1.5);
        });
        rings.run(dt, (r, k) => {
          const e = outCubic(k), rx = card.w * (.5 + r.grow * e), ry = card.h * (.5 + r.grow * e * 1.4), a = 1 - k;
          co.beginPath(); co.ellipse(cx, cy, rx, ry, 0, 0, TAU);
          co.globalAlpha = a * a * .2; co.strokeStyle = r.c; co.lineWidth = r.width * 6; co.stroke();
          co.globalAlpha = a * .8; co.lineWidth = r.width * 1.4; co.stroke();
        });
      },
      lock(p, o) { // une étoile naît sur le chiffre ; l'étincelle accélère
        flares.add({ x: p.x, y: p.y, size: card.h * (o.ghost ? .14 : o.last ? .5 : .3), life: o.last ? .7 : .45, c: pick(HUES) });
        shed(p, o.last ? 140 : 80, Math.round((o.ghost ? 2 : o.last ? 14 : 6) * q));
        heat = Math.min(1.5, heat + (o.ghost ? .05 : .2));
        spdTo = Math.min(5, spdTo + (o.ghost ? .1 : .45));
        core = Math.max(core, o.ghost ? .1 : .35);
        if (o.last) { target = .4; spdTo = 1.4; core = .7; }
      },
      build() { target = 1.4; spdTo = 6.5; },
      reveal(tier) {
        const p = POWER[tier];
        if (!p) { dim = 1; spdTo = .5; target = .15; nebula = .3; return; } // tirage raté : la nébuleuse pâlit, l'étincelle traîne
        sweeping = true; swept = 0; sweepDur = 1.25 - .35 * p; figLife = 2 + 3.5 * p;
        spdTo = .9; target = .5 + .3 * p; heat = 1; core = .5 + .5 * p; nebula = 1.4 + 2.6 * p;
        flares.add({ x: cx, y: cy, size: card.h * (.3 + 1.1 * p), life: .6 + .6 * p, c: '#f0abfc' });
        rings.add({ life: 1, grow: .2 + .9 * p, width: .7 + 1.3 * p, c: HUES[2] });
        if (p > .4) rings.add({ delay: .15, life: 1.1, grow: .5 + 1.1 * p, width: .8 + p, c: HUES[0] });
        if (p > .75) rings.add({ delay: .3, life: 1.2, grow: .8 + 1.3 * p, width: .8 + .8 * p, c: HUES[3] });
        for (let i = burst(p, 120 * q, 6); i > 0; i--) { const pt = at(rnd(TAU)), a = Math.atan2(pt.y - cy, pt.x - cx) + rnd(-.5, .5), v = rnd(40, 120 + 300 * p); motes.add({ x: pt.x, y: pt.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 1.4, max: rnd(.8, 1.4 + 1.4 * p), size: rnd(1.5, 3 + 2 * p), c: pick(HUES.concat(WHITE)), tw: rnd(TAU) }); }
      },
    };
  };

  // 🥐 Bakery (2026-10-13) — une fournée : des miettes, des pépites et des graines volent du chiffre qui se pose, un
  // nuage de farine à chaque chiffre ; à la fin de la révélation, des volutes de vapeur montent du nombre tout chaud,
  // une vingtaine de secondes, puis s'éteignent.
  Object.assign(SHAPES, {
    crumb(c, p, s) { c.beginPath(); c.moveTo(-s, -s * .3); c.lineTo(-s * .2, -s); c.lineTo(s * .9, -s * .5); c.lineTo(s, s * .5); c.lineTo(0, s * .9); c.lineTo(-s * .8, s * .6); c.closePath(); c.fill(); c.fillStyle = 'rgba(255,240,200,.55)'; c.fillRect(-s * .5, -s * .6, s * .6, s * .35); },
    chip(c, p, s) { c.fillStyle = '#3b1f0e'; c.beginPath(); c.moveTo(0, -s * 1.1); c.quadraticCurveTo(s * 1.1, s * .7, 0, s * .8); c.quadraticCurveTo(-s * 1.1, s * .7, 0, -s * 1.1); c.fill(); },
    seed(c, p, s) { c.fillStyle = '#fff3d0'; c.beginPath(); c.ellipse(0, 0, s * .9, s * .45, 0, 0, TAU); c.fill(); c.strokeStyle = 'rgba(120,80,30,.45)'; c.lineWidth = .7; c.stroke(); },
  });
  SCENES.bakery = custom(pieces({ cols: ['#e09a45', '#c2702a', '#f6c46e', '#b5651d'], shapes: ['crumb', 'crumb', 'chip', 'seed'], size: [2.2, 4.4], g: 640, spin: 6, up: true, glowc: '#ffb347', ring: '#e0a050', drift: { rate: 3, from: 'around' } }), (env, { st }) => {
    const { co, card, q, dark } = env, wisps = timed(), flour = timed(), emit = emitter();
    const STEAM = dark ? '#ffffff' : '#a8a29e', FLOUR = dark ? '#fff8ec' : '#d6c3a0', vents = [.18, .34, .5, .66, .82], k60 = Math.min(1.25, card.h / 62);
    // Une volute : un ruban qui ondule, monte en se défaisant (plus large et plus pâle en haut), puis s'efface.
    let baked = -1; // secondes depuis le dernier chiffre posé (-1 : pas encore)
    const wisp = delay => wisps.add({ delay, life: rnd(2.6, 3.8), x: card.x + card.w * (pick(vents) + rnd(-.05, .05)), tall: card.h * rnd(.9, 1.5), amp: rnd(4, 9) * k60, ph: rnd(TAU), dir: Math.random() < .5 ? -1 : 1, w: rnd(.8, 1.3) });
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        flour.run(dt, (f, k) => dot(co, FLOUR, f.x, f.y - k * 12, f.size * (.5 + outCubic(k)), (1 - k) * (dark ? .45 : .6)));
        // Elle prend dès que le dernier chiffre est posé (le nombre sort du four ; la rareté peut se faire attendre
        // derrière les badges), se renforce à la révélation ; plus de nouvelles volutes 20 s après.
        if (baked >= 0) baked += dt;
        const since = (st.revealed ? st.since : baked) - .35, rate = baked >= 0 && since > 0 && since < 20 ? (1.2 + 1.8 * st.p) * Math.min(1, since * 2) * Math.min(1, (20 - since) / 5) : 0;
        for (let n = emit(rate * (.6 + .4 * q), dt); n > 0; n--) wisp(0);
        co.lineCap = co.lineJoin = 'round';
        wisps.run(dt, (m, k) => {
          const fade = Math.sin(Math.PI * k), y0 = card.y + card.h * .3 - k * card.h * .7, top = y0 - m.tall, N = 14, g = co.createLinearGradient(0, y0, 0, top);
          g.addColorStop(0, STEAM + '00'); g.addColorStop(.25, STEAM); g.addColorStop(1, STEAM + '00');
          co.beginPath();
          for (let i = 0; i <= N; i++) { const u = i / N, x = m.x + m.dir * Math.sin(u * 4.2 - t * 1.6 + m.ph) * m.amp * (.3 + u) + m.dir * u * u * m.amp, y = lerp(y0, top, u); i ? co.lineTo(x, y) : co.moveTo(x, y); }
          co.strokeStyle = g;
          for (const [wd, al] of [[11, .07], [6, .12], [2.4, .2]]) { co.globalAlpha = fade * al * (dark ? 1 : 1.6); co.lineWidth = wd * m.w * k60 * (1 + k * .8); co.stroke(); }
        });
      },
      lock(p, o) { if (o.last) baked = 0; if (!o.ghost) flour.add({ x: p.x, y: p.y - card.h * .15, size: card.h * (o.last ? .55 : .35), life: .65 }); },
      reveal(tier, p) { if (baked < 0) baked = 0; for (let i = 2 + Math.round(5 * p); i > 0; i--) flour.add({ delay: rnd(0, .3), x: rnd(card.x, card.x + card.w), y: card.y + rnd(0, card.h), size: card.h * rnd(.35, .7), life: .8 }); },
    };
  });

  // 🌋 HellBorn — des braises montent des fissures pendant le tirage, chaque chiffre posé crache une gerbe d'étincelles ;
  // à la révélation, une éruption, puis des gouttes de lave qui coulent du bas de la carte et refroidissent.
  SCENES.hellborn = custom(pieces({ cols: ['#ff5a00', '#ffb000', '#ff2d00', '#ffd166'], shapes: ['spark', 'drop', 'square'], size: [1.4, 3.4], g: -260, spin: 3, up: true, glowc: '#ff4500', ring: '#ff6a00', drift: { rate: 7, from: 'around' } }), env => {
    const { co, card, dark } = env, drips = timed();
    const drip = delay => drips.add({ delay, life: rnd(1.4, 2.2), x: rnd(card.x + card.w * .08, card.x + card.w * .92), len: card.h * rnd(.25, .6), w: rnd(2.5, 5) });
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        drips.run(dt, (d, k) => {
          // la goutte s'étire sous la carte, se détache et tombe en virant au rouge sombre
          const y0 = card.y + card.h - 2, grow = Math.min(1, k * 2.2), fall = Math.max(0, k - .45) * card.h * 2.4, heat = 1 - k;
          const col = `rgb(255,${Math.round(60 + 140 * heat)},${Math.round(20 * heat)})`;
          co.globalAlpha = Math.min(1, (1 - k) * 2.5);
          co.fillStyle = col; co.shadowColor = '#ff4500'; co.shadowBlur = 8 * heat;
          co.beginPath(); co.moveTo(d.x - d.w, y0); co.quadraticCurveTo(d.x, y0 + d.len * grow * 1.2 + fall, d.x + d.w, y0); co.fill();
          if (k > .45) { co.beginPath(); co.arc(d.x, y0 + d.len + fall, d.w * .9, 0, TAU); co.fill(); }
          co.shadowBlur = 0;
        });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) drip(0); },
      reveal(tier, p) { for (let i = 0, n = 3 + Math.round(5 * p); i < n; i++) drip(i * .15); },
    };
  });

  // 🥫 Mayo (2026-10-14, idée d'un joueur) — à chaque chiffre posé, un flacon souple surgit à côté, se penche et
  // envoie un trait de mayonnaise sur le chiffre (petite éclaboussure) ; à la révélation, des flacons tout autour
  // giclent ensemble et des noisettes de mayo retombent. Matière molle : tout s'écrase et rebondit.
  Object.assign(SHAPES, {
    dollop(c, p, s) { c.fillStyle = '#fff6cf'; c.beginPath(); c.arc(0, s * .2, s, Math.PI, 0); c.quadraticCurveTo(s * .4, -s * .2, 0, -s * 1.2); c.quadraticCurveTo(-s * .4, -s * .2, -s, s * .2); c.fill(); c.fillStyle = 'rgba(255,255,255,.8)'; c.beginPath(); c.arc(-s * .35, -s * .1, s * .25, 0, TAU); c.fill(); },
    kdollop(c, p, s) { c.fillStyle = '#dc2626'; c.beginPath(); c.arc(0, s * .2, s, Math.PI, 0); c.quadraticCurveTo(s * .4, -s * .2, 0, -s * 1.2); c.quadraticCurveTo(-s * .4, -s * .2, -s, s * .2); c.fill(); c.fillStyle = 'rgba(254,202,202,.8)'; c.beginPath(); c.arc(-s * .35, -s * .1, s * .25, 0, TAU); c.fill(); },
    mdollop(c, p, s) { c.fillStyle = '#eab308'; c.beginPath(); c.arc(0, s * .2, s, Math.PI, 0); c.quadraticCurveTo(s * .4, -s * .2, 0, -s * 1.2); c.quadraticCurveTo(-s * .4, -s * .2, -s, s * .2); c.fill(); c.fillStyle = 'rgba(254,249,195,.85)'; c.beginPath(); c.arc(-s * .35, -s * .1, s * .25, 0, TAU); c.fill(); },
  });
  // Même scène pour les trois sauces (Mayo, Ketchup, Moutarde) : seules les couleurs, l'étiquette et le mot changent.
  const sauceScene = P => custom(pieces({ cols: P.bits, shapes: [P.shape], size: [2.6, 5], g: 700, spin: 2, up: true, glowc: P.bits[1], ring: P.bits[3], drift: { rate: 2, from: 'around' } }), env => {
    const { co, card, dark } = env, bottles = timed(), splats = timed(), blobs = timed(), zig = timed();
    const CREAM = P.cream, SHADE = P.shade, HI = P.hi, EDGE = dark ? 'rgba(0,0,0,.35)' : 'rgba(120,100,40,.45)';
    // Flacon souple dessiné : corps arrondi en dégradé crème, reflet, étiquette bleue rayée de jaune, embout rouge… non :
    // embout jaune pointu (aucune marque réelle).
    const bottle = (x, y, ang, squeeze, s) => {
      co.save(); co.translate(x, y); co.rotate(ang); co.scale(1 + squeeze * .2, 1 - squeeze * .14);
      const g = co.createLinearGradient(-s * .45, 0, s * .45, 0); g.addColorStop(0, P.body[0]); g.addColorStop(.35, P.body[1]); g.addColorStop(1, P.body[2]);
      co.fillStyle = g; co.strokeStyle = EDGE; co.lineWidth = 1.2;
      co.beginPath(); if (co.roundRect) co.roundRect(-s * .45, -s * .15, s * .9, s * 1.25, s * .32); else co.rect(-s * .45, -s * .15, s * .9, s * 1.25); co.fill(); co.stroke();
      co.fillStyle = P.label; co.fillRect(-s * .45, s * .3, s * .9, s * .42);
      co.fillStyle = P.stripe; co.fillRect(-s * .45, s * .3, s * .9, s * .05); co.fillRect(-s * .45, s * .67, s * .9, s * .05);
      co.fillStyle = P.ink; co.font = `900 ${Math.round(s * P.fs)}px system-ui, sans-serif`; co.textAlign = 'center'; co.textBaseline = 'middle'; co.fillText(P.word, 0, s * .51);
      co.fillStyle = 'rgba(255,255,255,.7)'; co.fillRect(-s * .3, -s * .05, s * .08, s * .9);
      co.fillStyle = P.cap[0]; co.strokeStyle = P.cap[1]; co.beginPath(); co.moveTo(-s * .22, -s * .15); co.lineTo(s * .22, -s * .15); co.lineTo(s * .06, -s * .58); co.lineTo(-s * .06, -s * .58); co.closePath(); co.fill(); co.stroke();
      co.restore();
    };
    // Trait de mayo brillant : une ombre, la crème, un reflet.
    const stream = (pts, w) => { co.lineCap = co.lineJoin = 'round'; for (const [k, col] of [[1.25, EDGE], [1, CREAM], [.35, HI]]) { co.strokeStyle = col; co.lineWidth = w * k; co.beginPath(); pts.forEach((p, i) => (i ? co.lineTo(p[0], p[1]) : co.moveTo(p[0], p[1]))); co.stroke(); } };
    const dollop = (x, y, s, a) => { co.globalAlpha = a; co.fillStyle = SHADE; co.beginPath(); co.ellipse(x, y + s * .25, s * 1.1, s * .55, 0, 0, TAU); co.fill(); co.fillStyle = CREAM; co.beginPath(); co.ellipse(x, y, s, s * .7, 0, 0, TAU); co.fill(); co.beginPath(); co.moveTo(x - s * .35, y - s * .3); co.quadraticCurveTo(x, y - s * 1.3, x + s * .1, y - s * .6); co.fill(); co.fillStyle = HI; co.beginPath(); co.ellipse(x - s * .35, y - s * .15, s * .22, s * .14, -.4, 0, TAU); co.fill(); };
    const shoot = (tx, ty, delay, big) => {
      const left = tx < card.x + card.w / 2, s = card.h * (big ? .75 : .6);
      bottles.add({ delay, life: 1, bx: left ? card.x - s * .95 : card.x + card.w + s * .95, by: card.y - s * .1, tx, ty, s, side: left ? -1 : 1 });
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // noisettes déposées : restent un moment au pied des chiffres puis fondent
        blobs.run(dt, (b, k) => dollop(b.x, b.y, b.s * (k < .1 ? k * 10 : 1), k > .7 ? (1 - k) / .3 : 1));
        bottles.run(dt, (b, k) => {
          const pop = Math.min(1, k / .2), out = k > .85 ? (1 - k) / .15 : 1, squeeze = k > .25 && k < .65 ? Math.sin((k - .25) / .4 * Math.PI) : 0;
          const y = b.by - (1 - outCubic(pop)) * b.s, ang = b.side * -(.95 + .3 * squeeze);
          co.globalAlpha = out;
          if (k > .25 && k < .8) {
            const u = Math.min(1, (k - .25) / .18), nx = b.bx + Math.cos(ang - Math.PI / 2) * b.s * .6, ny = y + Math.sin(ang - Math.PI / 2) * b.s * .6;
            const pts = []; for (let i = 0; i <= 16; i++) { const v = (i / 16) * u; pts.push([lerp(nx, b.tx, v), lerp(ny, b.ty, v) - Math.sin(v * Math.PI) * b.s * .7]); }
            stream(pts, b.s * .16 * (k > .65 ? (.8 - k) / .15 : 1));
            if (u >= 1 && !b.hit) { b.hit = true; splats.add({ x: b.tx, y: b.ty, s: b.s * .42, life: .5 }); blobs.add({ x: b.tx, y: card.y + card.h - 3, s: b.s * .12, life: 2.4 }); }
          }
          bottle(b.bx, y, ang, squeeze, b.s);
        });
        splats.run(dt, (p, k) => { const sq = k < .3 ? 1 + k * 2.2 : 1.66 - (k - .3) * 1; co.globalAlpha = 1 - k * k; co.fillStyle = CREAM; co.beginPath(); co.ellipse(p.x, p.y, p.s * sq, p.s * (1.5 - sq * .55), 0, 0, TAU); co.fill(); for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + p.s, r = p.s * (1.2 + k * 1.4); co.beginPath(); co.arc(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r * .6, p.s * .16 * (1 - k), 0, TAU); co.fill(); } });
        // grand zigzag de la fin, comme sur des frites : il se dessine de gauche à droite puis s'efface
        zig.run(dt, (z, k) => {
          const draw = Math.min(1, k / .4), fade = k > .7 ? (1 - k) / .3 : 1, pts = [], n = 9, y0 = card.y - card.h * .05;
          for (let i = 0; i <= 60 * draw; i++) { const v = i / 60, x = card.x - 6 + v * (card.w + 12), y = y0 + (Math.floor(v * n) % 2 ? 1 - (v * n % 1) : v * n % 1) * card.h * .22; pts.push([x, y]); }
          co.globalAlpha = fade; if (pts.length > 1) stream(pts, card.h * .09);
          const tip = pts[pts.length - 1]; if (tip && draw < 1) bottle(tip[0], tip[1] - card.h * .55, Math.PI, .6, card.h * .55);
        });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (!o.ghost) shoot(p.x, p.y, 0, o.last); },
      reveal(tier, p) { zig.add({ life: 2.2 }); for (let i = 0, n = 1 + Math.round(4 * p); i < n; i++) shoot(rnd(card.x, card.x + card.w), rnd(card.y, card.y + card.h), .4 + i * .14, true); },
    };
  });

  SCENES.mayo = sauceScene({ bits: ['#fff6cf', '#fff1b8', '#ffffff', '#f5e7a6'], shape: 'dollop', cream: '#fff6cf', shade: '#e9d27d', hi: '#ffffff', body: ['#f3e3a0', '#fffdf2', '#e8d38a'], label: '#1e3a8a', stripe: '#facc15', ink: '#fff6cf', word: 'MAYO', fs: .22, cap: ['#facc15', '#ca8a04'] });
  // 🍅 Ketchup et 🌭 Moutarde (2026-10-16, idée de Gunnar) : les cousins du Mayo, mêmes flacons, autres sauces.
  SCENES.ketchup = sauceScene({ bits: ['#dc2626', '#ef4444', '#fca5a5', '#b91c1c'], shape: 'kdollop', cream: '#dc2626', shade: '#7f1d1d', hi: '#fecaca', body: ['#b91c1c', '#ef4444', '#991b1b'], label: '#fef2f2', stripe: '#16a34a', ink: '#b91c1c', word: 'KETCHUP', fs: .12, cap: ['#fef2f2', '#991b1b'] });
  SCENES.mustard = sauceScene({ bits: ['#eab308', '#facc15', '#fef08a', '#ca8a04'], shape: 'mdollop', cream: '#eab308', shade: '#a16207', hi: '#fef9c3', body: ['#ca8a04', '#fde047', '#a16207'], label: '#7f1d1d', stripe: '#fef08a', ink: '#fde047', word: 'MUSTARD', fs: .12, cap: ['#dc2626', '#7f1d1d'] });

  // 😇 Heavenly (2026-10-16, idée de Gunnar « heavenly ») — marbre blanc et feuille d'or. Des plumes tombent doucement
  // autour de la carte ; chaque chiffre posé reçoit une auréole d'or qui descend sur lui et s'illumine ; à la révélation,
  // des rayons de lumière tombent du haut et une nuée de plumes s'envole. Matière dure : éclats, pas d'écrasement.
  Object.assign(SHAPES, {
    feather(c, p, s) { c.fillStyle = '#fffdf5'; c.beginPath(); c.moveTo(0, -s * 1.6); c.quadraticCurveTo(s * .9, -s * .2, 0, s * 1.6); c.quadraticCurveTo(-s * .9, -s * .2, 0, -s * 1.6); c.fill(); c.strokeStyle = 'rgba(202,138,4,.7)'; c.lineWidth = Math.max(.6, s * .12); c.beginPath(); c.moveTo(0, -s * 1.4); c.lineTo(0, s * 1.9); c.stroke(); },
  });
  SCENES.heavenly = custom(pieces({ cols: ['#fffdf5', '#fef3c7', '#ffffff', '#fde68a'], shapes: ['feather', 'star'], size: [2.4, 4.4], g: 60, spin: 1.2, up: true, glowc: '#fde68a', ring: '#facc15', drift: { rate: 1.6, from: 'around' } }), env => {
    const { co, card, dark } = env, halos = timed(), rays = timed(), motes = timed(), emit = emitter();
    let glow = 0; // la lumière d'en haut s'intensifie à la révélation puis retombe doucement
    const halo = (x, y, r, a, glow) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.scale(1, .32);
      co.shadowColor = 'rgba(250,204,21,.95)'; co.shadowBlur = 8 + glow * 18; co.strokeStyle = '#fde047'; co.lineWidth = 3.2;
      co.beginPath(); co.arc(0, 0, r, 0, TAU); co.stroke(); co.shadowBlur = 0; co.strokeStyle = '#fffbeb'; co.lineWidth = 1.1; co.beginPath(); co.arc(0, 0, r, 0, TAU); co.stroke(); co.restore();
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        // Projecteur céleste permanent (idée de casmictechthing, 2026-10-17) : un cône doux qui tombe sur la carte.
        glow = Math.max(0, glow - dt * .35);
        { const a = (dark ? .16 : .22) + glow * .3, top = card.y - card.h * 2.4, cx = card.x + card.w / 2;
          const g = co.createLinearGradient(0, top, 0, card.y + card.h * 1.2); g.addColorStop(0, 'rgba(254,249,195,0)'); g.addColorStop(.55, `rgba(254,243,199,${a})`); g.addColorStop(1, 'rgba(254,243,199,0)');
          co.fillStyle = g; co.beginPath(); co.moveTo(cx - card.w * .12, top); co.lineTo(cx + card.w * .12, top); co.lineTo(cx + card.w * .75, card.y + card.h * 1.2); co.lineTo(cx - card.w * .75, card.y + card.h * 1.2); co.closePath(); co.fill(); }
        // Poussières de lumière qui flottent et s'attardent autour de la carte.
        for (let i = 0, n = emit(3 + glow * 10, dt); i < n; i++) motes.add({ life: rnd(2.5, 4.5), x: rnd(card.x - card.w * .3, card.x + card.w * 1.3), y: rnd(card.y - card.h * .6, card.y + card.h * 1.4), vx: rnd(-6, 6), vy: -rnd(4, 14), r: rnd(.8, 2.2), ph: rnd(TAU) });
        motes.run(dt, (m, k) => {
          const a = Math.sin(k * Math.PI) * (.55 + .45 * Math.sin(t * 3 + m.ph));
          co.globalAlpha = a; co.fillStyle = '#fef9c3'; co.shadowColor = 'rgba(253,224,71,.9)'; co.shadowBlur = 6;
          co.beginPath(); co.arc(m.x + m.vx * k * m.life + Math.sin(t + m.ph) * 3, m.y + m.vy * k * m.life, m.r, 0, TAU); co.fill(); co.shadowBlur = 0;
        });
        co.globalAlpha = 1;
        // rayons divins : des faisceaux qui tombent du haut sur la carte puis s'effacent
        rays.run(dt, (r, k) => {
          const a = (k < .2 ? k / .2 : 1 - (k - .2) / .8) * (dark ? .6 : .7);
          for (let i = 0; i < 5; i++) {
            const x = card.x + card.w * (.1 + i * .2) + Math.sin(t * .8 + i) * 6, w = card.w * (.1 + (i % 2) * .05);
            const g = co.createLinearGradient(0, card.y - card.h * 2.2, 0, card.y + card.h); g.addColorStop(0, 'rgba(254,243,199,0)'); g.addColorStop(.6, `rgba(254,240,138,${a})`); g.addColorStop(1, 'rgba(254,240,138,0)');
            co.fillStyle = g; co.beginPath(); co.moveTo(x - w * .4, card.y - card.h * 2.2); co.lineTo(x + w * .4, card.y - card.h * 2.2); co.lineTo(x + w * 1.4, card.y + card.h); co.lineTo(x - w * 1.4, card.y + card.h); co.closePath(); co.fill();
          }
        });
        co.globalCompositeOperation = 'source-over';
        // auréole : descend du haut, se pose au-dessus du chiffre, s'illumine puis reste un instant
        halos.run(dt, (h, k) => {
          const fall = Math.min(1, k / .3), y = h.y - card.h * .8 * (1 - outCubic(fall)), glow = k > .3 && k < .5 ? Math.sin((k - .3) / .2 * Math.PI) : 0;
          halo(h.x, y, h.r * (1 + glow * .15), (k > .75 ? (1 - k) / .25 : 1) * (fall < 1 ? fall : 1), glow);
        });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (!o.ghost) halos.add({ x: p.x, y: p.y - card.h * .38, r: card.h * (o.last ? .24 : .2), life: .85 }); },
      reveal(tier, p) { rays.add({ life: 1.6 + p * 1.2 }); glow = .6 + p * .6; },
    };
  });

  // 🤠 Western (2026-10-17, idée de JBearr12) — un revolver à côté de la carte tire sur chaque bouteille posée sur la
  // palissade : éclair de bouche, trait de la balle, la bouteille éclate en éclats de verre vert. À la révélation, il
  // vide son barillet (une rafale), un nuage de fumée monte et il tourne sur son doigt. Matière dure : éclats et recul.
  SCENES.western = custom(pieces({ cols: ['#4ade80', '#16a34a', '#bbf7d0', '#a16207'], shapes: ['shard'], size: [1.8, 3.6], g: 900, spin: 6, glowc: '#fbbf24', ring: '#d97706', drift: { rate: .6, from: 'around' } }), env => {
    const { co, card, dark } = env, shots = timed(), bursts = timed(), smoke = timed();
    const S = card.h * .55, gx = card.x + card.w + S * 1.3, gy = card.y + card.h * .5;
    let recoil = 0, twirl = 0;
    // Revolver dessiné de profil, canon vers la carte (vers la gauche), sans marque.
    const gun = () => {
      co.save(); co.translate(gx + recoil * S * .25, gy); co.rotate(twirl - recoil * .35);
      co.fillStyle = '#4b5563'; co.strokeStyle = '#111827'; co.lineWidth = 1.2;
      co.fillRect(-S * 1.1, -S * .14, S * .8, S * .18); co.strokeRect(-S * 1.1, -S * .14, S * .8, S * .18); // canon
      co.fillStyle = '#6b7280'; co.beginPath(); co.ellipse(-S * .15, -S * .03, S * .24, S * .2, 0, 0, TAU); co.fill(); co.stroke(); // barillet
      co.fillStyle = '#374151'; co.fillRect(-S * .38, -S * .2, S * .55, S * .1);
      co.fillStyle = '#7c2d12'; co.beginPath(); co.moveTo(S * .05, -S * .05); co.lineTo(S * .35, -S * .08); co.lineTo(S * .55, S * .55); co.lineTo(S * .25, S * .6); co.closePath(); co.fill(); co.stroke(); // crosse en bois
      co.strokeStyle = '#111827'; co.lineWidth = 2; co.beginPath(); co.arc(-S * .05, S * .2, S * .14, Math.PI * .1, Math.PI * .9); co.stroke(); // pontet
      co.restore();
    };
    const fire = (tx, ty, delay, big) => shots.add({ delay, life: .32, tx, ty, big });
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        recoil = Math.max(0, recoil - dt * 6);
        smoke.run(dt, (p, k) => { co.globalAlpha = (1 - k) * .45; co.fillStyle = dark ? '#d6d3d1' : '#a8a29e'; co.beginPath(); co.arc(p.x + p.vx * k, p.y - k * card.h * .9, p.r * (1 + k * 2.2), 0, TAU); co.fill(); });
        co.globalAlpha = 1; gun();
        shots.run(dt, (b, k) => {
          if (!b.fired) { b.fired = true; recoil = 1; for (let i = 0; i < 3; i++) smoke.add({ life: rnd(1.2, 2), x: gx - S * 1.15, y: gy - S * .05, vx: rnd(-20, 10), r: S * rnd(.08, .14) }); }
          const mx = gx - S * 1.1 + recoil * S * .25, my = gy - S * .05;
          // éclair de bouche
          if (k < .35) { co.globalAlpha = 1 - k / .35; co.fillStyle = '#fde047'; co.beginPath(); co.moveTo(mx, my - S * .12); co.lineTo(mx - S * (b.big ? .55 : .4), my); co.lineTo(mx, my + S * .12); co.closePath(); co.fill(); }
          // trait de la balle
          const u = Math.min(1, k / .45); co.globalAlpha = .8 * (1 - k); co.strokeStyle = '#fef3c7'; co.lineWidth = 1.6;
          co.beginPath(); co.moveTo(mx, my); co.lineTo(mx + (b.tx - mx) * u, my + (b.ty - my) * u); co.stroke();
          if (u >= 1 && !b.hit) { b.hit = true; bursts.add({ x: b.tx, y: b.ty, life: .5, s: card.h * (b.big ? .5 : .38) }); }
        });
        // la bouteille éclate : un anneau de verre vert et des éclats en étoile
        bursts.run(dt, (p, k) => {
          co.globalAlpha = 1 - k; co.strokeStyle = '#86efac'; co.lineWidth = 2;
          for (let i = 0; i < 8; i++) { const a = i * TAU / 8 + p.s, r0 = p.s * (.2 + k * .6), r1 = p.s * (.35 + k * 1.1); co.beginPath(); co.moveTo(p.x + Math.cos(a) * r0, p.y + Math.sin(a) * r0); co.lineTo(p.x + Math.cos(a) * r1, p.y + Math.sin(a) * r1); co.stroke(); }
          co.globalAlpha = (1 - k) * .6; co.fillStyle = '#fef9c3'; co.beginPath(); co.arc(p.x, p.y, p.s * .25 * (1 - k), 0, TAU); co.fill();
        });
        if (twirl) twirl = Math.max(0, twirl - dt * 7);
        co.globalAlpha = 1;
      },
      lock(p, o) { if (!o.ghost) fire(p.x, p.y, 0, o.last); },
      reveal(tier, p) {
        const n = 3 + Math.round(3 * p);
        for (let i = 0; i < n; i++) fire(rnd(card.x + card.w * .1, card.x + card.w * .9), rnd(card.y, card.y + card.h), .15 + i * .14, true);
        setTimeout(() => { twirl = TAU * 2; }, (.3 + n * .14) * 1000);
      },
    };
  });

  // ☄️ Meteor (2026-10-18, idée de costoroll) — une ville la nuit. À chaque chiffre posé, une météorite arrive en biais
  // du haut à gauche avec sa traînée et s'écrase sur l'emplacement du chiffre : éclair d'impact dans la carte, gerbe
  // d'étincelles. La dernière est plus grosse : traînée plus longue, onde de choc, plus de débris. Matière dure : éclats.
  // 🧨 Dynamite (2026-10-24, idée de casmictechthing et ichi) — chaque bâton qui se pose explose : flash blanc, boule
  // de feu, éclats qui retombent, fumée qui monte ; le dernier fait le plus gros BOUM. À la révélation, une explosion
  // derrière la carte qui grandit avec la rareté ; dès Mythic, un champignon de fumée de dessin animé monte au-dessus
  // (pied, collerette, chapeau bouillonnant, du feu à la fumée). Tirage raté : une petite bouffée triste, « pfft ».
  SCENES.dynamite = env => {
    const { co, ci, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const booms = timed(), smoke = particles(), bits = particles(), glows = timed(), clouds = timed();
    const FIRE = ['#fde047', '#fb923c', '#f97316', '#ef4444'], DEBRIS = ['#7f1d1d', '#dc2626', '#fef3c7', '#78350f', '#a8a29e'];
    const SMOKE = dark ? ['#78716c', '#57534e', '#a8a29e'] : ['#a8a29e', '#78716c', '#d6d3d1'];
    // une explosion : flash + boule de feu (timed), fumée et éclats (particules) ; s = sa taille en hauteurs de carte
    const boom = (x, y, s) => {
      booms.add({ x, y, r: card.h * s, life: .45 + .2 * s });
      glows.add({ x: x - card.x, y: y - card.y, r: card.h * s * 1.4, life: .35 });
      for (let i = Math.round((5 + 10 * s) * q); i > 0; i--) smoke.add({ x: x + rnd(-1, 1) * card.h * .25 * s, y: Math.min(y, card.y + card.h * .15), vx: rnd(-1, 1) * card.h * .5 * s, vy: -rnd(1.2, 2.2) * card.h * (.7 + .5 * s), drag: 1.4, g: -card.h * .2, max: rnd(.8, 1.5), size: card.h * rnd(.12, .22) * (.7 + s * .5), c: pick(SMOKE) });
      for (let i = Math.round((6 + 16 * s) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = card.h * rnd(3, 6 + 5 * s); bits.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 14, drag: .3, max: rnd(.5, 1), size: card.h * rnd(.025, .05), rot: rnd(TAU), spin: rnd(-12, 12), c: pick(DEBRIS) }); }
    };
    // le champignon (dès Mythic) : k de 0 à 1 sur sa vie ; il ne dépasse pas le haut du calque (marge env.card.y)
    const mushroom = (m, k) => {
      const rise = outCubic(Math.min(1, k / .55)), fade = k < .7 ? 1 : 1 - (k - .7) / .3, heatK = Math.max(0, 1 - k * 1.6);
      // ~100 px au-dessus de la carte dans une page : pied fin, chapeau large et plat, centré à .75 hauteur de carte au-dessus
      const top = card.y - card.h * .78 * rise * m.h, capR = card.h * (.4 + .55 * rise) * m.s, base = card.y + card.h * .1;
      const fill = (x, y, r, c, a) => { co.globalAlpha = a * fade; co.fillStyle = c; co.beginPath(); co.arc(x, y, r, 0, TAU); co.fill(); };
      // le pied : une colonne de bouffées qui monte de la carte au chapeau
      for (let i = 0; i <= 7; i++) { const y = base + (top - base) * (i / 7), r = card.h * (.11 + .03 * Math.sin(i * 1.7 + k * 9)) * m.s; fill(cx + Math.sin(i * 2.3 + k * 6) * r * .3, y, r, SMOKE[i % 2], .85); }
      // la collerette, à mi-hauteur
      const ry = base + (top - base) * .45;
      for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU + k * 2; fill(cx + Math.cos(a) * capR * .4, ry + Math.sin(a) * card.h * .05, card.h * .08 * m.s, SMOKE[2], .75); }
      // le chapeau : un nuage de bouffées qui roule sur lui-même, orange au cœur au début puis gris
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU + k * 1.5, rr = capR * (.62 + .18 * Math.sin(i * 3.1 + k * 7)), x = cx + Math.cos(a) * rr, y = top + Math.sin(a) * rr * .32;
        fill(x, y, capR * (.27 + .06 * Math.sin(i * 1.3 + k * 11)), k < .35 ? ['#9a3412', '#c2410c', '#78350f'][i % 3] : SMOKE[i % 3], .92);
      }
      const hot = Math.max(heatK, k < .6 ? .35 * (1 - k / .6) : 0); // le feu reste au cœur du chapeau un moment
      if (hot > 0) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#fb923c', cx, top, capR * 1.25, hot * .9); dot(co, '#fde047', cx, top + capR * .1, capR * .65, hot * .85); dot(co, '#fb923c', cx, (top + base) / 2, capR * .5, hot * .6, capR * 1.4); co.globalCompositeOperation = 'source-over'; }
    };
    return {
      frame(t, dt) {
        // Derrière la carte (les chiffres restent toujours lisibles) : champignon, fumée, boules de feu.
        smoke.step(dt);
        const rings = [];
        behind(env, () => {
          co.globalCompositeOperation = 'source-over';
          clouds.run(dt, mushroom);
          smoke.each((s, k) => { co.globalAlpha = Math.sin(Math.PI * Math.min(1, k * 1.4)) * (dark ? .6 : .65); co.fillStyle = s.c; co.beginPath(); co.arc(s.x, s.y, s.size * (1 + k * 1.8), 0, TAU); co.fill(); });
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          booms.run(dt, (b, k) => {
            const e = outExpo(k), a = 1 - k;
            if (k < .18) dot(co, '#ffffff', b.x, b.y, b.r * (.6 + 2 * k), (1 - k / .18) * .95); // le flash
            dot(co, FIRE[1], b.x, b.y, b.r * (.5 + .9 * e), a * .85);
            dot(co, FIRE[0], b.x, b.y, b.r * (.3 + .5 * e), a * .9);
            rings.push([b, e, a]);
          });
        });
        // Devant : l'onde de choc, un trait fin qui ne cache rien.
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        for (const [b, e, a] of rings) { co.globalAlpha = a * .7; co.strokeStyle = FIRE[2]; co.lineWidth = 1.5 + 2.5 * a; co.beginPath(); co.ellipse(b.x, b.y, b.r * (.4 + 1.3 * e), b.r * (.25 + .7 * e), 0, 0, TAU); co.stroke(); }
        co.globalCompositeOperation = 'source-over';
        bits.step(dt);
        bits.each((p, k) => { p.rot += p.spin * dt; co.globalAlpha = 1 - k; co.save(); co.translate(p.x, p.y); co.rotate(p.rot); co.fillStyle = p.c; co.fillRect(-p.size, -p.size * .5, p.size * 2, p.size); co.restore(); });
        // dans la carte : la lueur de l'explosion, sous les chiffres
        ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        glows.run(dt, (g, k) => dot(ci, '#fdba74', g.x, g.y, g.r * (1 + k * .5), (1 - k) * .85));
        ci.globalCompositeOperation = 'source-over';
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) { smoke.add({ x: p.x, y: p.y - card.h * .3, vx: 0, vy: -card.h * .4, drag: 1, g: 0, max: .9, size: card.h * .1, c: SMOKE[0] }); return; }
        boom(p.x, p.y, o.last ? .9 : .5);
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { for (let i = 0; i < 3; i++) smoke.add({ x: cx + rnd(-1, 1) * card.h * .3, y: card.y, vx: rnd(-6, 6), vy: -card.h * .35, drag: 1, g: 0, max: 1.4, size: card.h * .14, c: SMOKE[0] }); return; } // « pfft »
        boom(cx, cy, .7 + 1.3 * p);
        if (p >= .6) for (let i = 0; i < 2; i++) setTimeout(() => boom(cx + (i ? 1 : -1) * card.w * .42, cy, .5 + .6 * p), 140 + i * 110);
        if (p >= 1) clouds.add({ delay: .15, life: 3.4 + (ASCEND[tier] || 0) * .5, s: 1 + .15 * (ASCEND[tier] || 0), h: 1 });
      },
    };
  };

  SCENES.meteor = custom(pieces({ cols: ['#fde68a', '#fb923c', '#f97316', '#fef3c7'], shapes: ['spark', 'shard'], size: [1.4, 3.2], g: 600, spin: 5, glowc: '#fb923c', ring: '#f97316', drift: { rate: .5, from: 'around' } }), env => {
    const { co, ci, card, dark } = env, rocks = timed(), hits = timed(), waves = timed(), debris = particles();
    const FLY = .32; // durée du vol (s) : la météorite touche quand le chiffre se pose
    const rock = (x, y, r, ang, big) => {
      // traînée : un cône qui s'élargit vers l'arrière, du blanc chaud au rouge
      co.save(); co.translate(x, y); co.rotate(ang);
      const len = r * (big ? 26 : 18), g = co.createLinearGradient(-len, 0, 0, 0);
      g.addColorStop(0, 'rgba(249,115,22,0)'); g.addColorStop(.6, 'rgba(251,146,60,.55)'); g.addColorStop(1, 'rgba(254,243,199,.95)');
      co.fillStyle = g; co.beginPath(); co.moveTo(0, -r * .9); co.lineTo(-len, -r * .15); co.lineTo(-len, r * .15); co.lineTo(0, r * .9); co.closePath(); co.fill();
      co.shadowColor = '#fb923c'; co.shadowBlur = r * 2.2; co.fillStyle = '#fff7ed'; co.beginPath(); co.arc(0, 0, r, 0, TAU); co.fill(); co.shadowBlur = 0;
      co.fillStyle = '#7c2d12'; co.beginPath(); co.arc(r * .25, r * .2, r * .45, 0, TAU); co.fill();
      co.restore();
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        rocks.run(dt, (m, k) => {
          const u = Math.min(1, k / (FLY / m.life)), e = u * u; // accélère en tombant
          if (u < 1) { const x = m.x0 + (m.x1 - m.x0) * e, y = m.y0 + (m.y1 - m.y0) * e; co.globalAlpha = 1; rock(x, y, card.h * (m.big ? .22 : .15), Math.atan2(m.y1 - m.y0, m.x1 - m.x0), m.big); }
          else if (!m.hit) {
            m.hit = true;
            hits.add({ x: m.x1 - card.x, y: m.y1 - card.y, r: card.h * (m.big ? .9 : .55), life: m.big ? .7 : .45 });
            if (m.big) waves.add({ x: card.x + card.w / 2, y: card.y + card.h / 2, life: .8, r: card.w * .9 });
            for (let i = 0; i < (m.big ? 26 : 10); i++) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = rnd(120, m.big ? 420 : 260); debris.add({ x: m.x1, y: card.y + card.h * .1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rnd(.4, .9), g: 700, drag: 1.5, size: rnd(1.2, 2.6), col: ['#fde68a', '#fb923c', '#f97316'][i % 3] }); }
          }
        });
        debris.step(dt);
        debris.each((p, k) => { co.globalAlpha = 1 - k; co.fillStyle = p.col; co.fillRect(p.x - p.size, p.y - p.size * .4, p.size * 2, p.size * .8); });
        waves.run(dt, (w, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = '#fdba74'; co.lineWidth = 3 * (1 - k) + .5; co.beginPath(); co.ellipse(w.x, w.y, w.r * (.3 + k), w.r * (.3 + k) * .45, 0, 0, TAU); co.stroke(); });
        // éclair d'impact dans la carte (calque intérieur, sous les chiffres)
        ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        hits.run(dt, (h, k) => dot(ci, '#fdba74', h.x, h.y, h.r * (1 + k * .6), (1 - k) * .9));
        ci.globalCompositeOperation = 'source-over';
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        const big = !!o.last, d = card.h * (big ? 4.6 : 3.6);
        rocks.add({ x0: p.x - d * .9, y0: p.y - d, x1: p.x, y1: p.y, x: p.x, y: p.y, big, life: FLY + .05 });
      },
      reveal(tier, p) { for (let i = 0, n = Math.round(2 + 4 * p); i < n; i++) { const x = rnd(card.x, card.x + card.w), d = card.h * 3; rocks.add({ delay: i * .12, x0: x - d * .9, y0: card.y - d, x1: x, y1: card.y + card.h * .5, big: false, life: FLY + .05 }); } },
    };
  });

  // 🌀 Cursed Energy (2026-10-20, idée d'Edward) — énergie maudite bleu-violet, dessin original. Dans la carte, une
  // aura ondule derrière les chiffres pendant le tirage. À chaque chiffre posé, un sceau (deux cercles, huit traits,
  // un triangle) se dessine autour de lui en tournant puis se resserre, et deux petits arcs violets crépitent ; le
  // dernier sceau est plus grand. À la révélation, des langues d'énergie montent de la carte et des arcs la parcourent.
  SCENES.cursed = custom(pieces({ cols: ['#a78bfa', '#818cf8', '#c084fc', '#e0e7ff'], shapes: ['spark'], size: [1.2, 2.8], g: -220, spin: 2, up: true, glowc: '#8b5cf6', ring: '#7c3aed', drift: { rate: 3, from: 'around' } }), env => {
    const { co, ci, card, dark } = env, seals = timed(), arcs = timed(), tongues = timed();
    const COLS = ['#4c1d95', '#a78bfa', '#f5f3ff'];
    let aura = 0; // l'aura intérieure monte pendant le tirage, retombe ensuite
    const seal = (x, y, r, rot, a) => {
      co.save(); co.translate(x, y); co.rotate(rot); co.globalAlpha = a;
      co.strokeStyle = '#c4b5fd'; co.shadowColor = '#8b5cf6'; co.shadowBlur = r * .4; co.lineWidth = Math.max(1, r * .06);
      co.beginPath(); co.arc(0, 0, r, 0, TAU); co.stroke();
      co.setLineDash([r * .12, r * .2]); co.beginPath(); co.arc(0, 0, r * .8, 0, TAU); co.stroke(); co.setLineDash([]);
      co.beginPath(); for (let i = 0; i < 3; i++) { const q = -Math.PI / 2 + i * TAU / 3; co.lineTo(Math.cos(q) * r * .7, Math.sin(q) * r * .7); } co.closePath(); co.stroke();
      for (let i = 0; i < 8; i++) { const q = i * TAU / 8; co.beginPath(); co.moveTo(Math.cos(q) * r * 1.05, Math.sin(q) * r * 1.05); co.lineTo(Math.cos(q) * r * 1.25, Math.sin(q) * r * 1.25); co.stroke(); }
      co.shadowBlur = 0; co.restore();
    };
    return {
      frame(t, dt) {
        // aura dans la carte : trois nappes violettes qui ondulent sous les chiffres
        aura = Math.max(0, aura - dt * .4);
        if (aura > .01) {
          ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          for (let i = 0; i < 4; i++) { const x = card.w * (.15 + i * .24) + Math.sin(t * 2.2 + i) * card.w * .04; dot(ci, i % 2 ? '#7c3aed' : '#4f46e5', x, card.h * (.95 - .1 * Math.sin(t * 3 + i * 1.7)), card.h * .35, aura * .6, card.h * .7); }
          ci.globalCompositeOperation = 'source-over';
        }
        co.globalCompositeOperation = 'source-over';
        seals.run(dt, (s, k) => {
          // il apparaît grand, tourne et se resserre sur le chiffre, puis s'efface
          const r = s.r * (1.6 - .6 * outExpo(k * 1.6)), a = k < .15 ? k / .15 : 1 - Math.max(0, (k - .5) / .5);
          seal(s.x, s.y, r, s.rot + k * (s.big ? 2.4 : 1.6), a * (s.big ? .55 : .5));
        });
        arcs.run(dt, (b, k) => { if (Math.random() < .7) bolt(co, b.x1, b.y1, b.x2, b.y2, b.jag, COLS, (1 - k), b.w); });
        tongues.run(dt, (f, k) => {
          // langue d'énergie : un fuseau étiré qui monte, se tord et s'efface
          const y = f.y - k * f.h, x = f.x + Math.sin(k * 6 + f.ph) * f.h * .12;
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          dot(co, f.c, x, y, f.w * (1 - k * .5), (1 - k) * .5, f.h * .35);
          co.globalCompositeOperation = 'source-over';
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        aura = Math.min(1, aura + .35);
        if (o.ghost) return;
        // le dernier sceau entoure tout le nombre (centré sur la carte) pour ne pas masquer le chiffre qui se pose
        const big = !!o.last, r = card.h * (big ? 1.15 : .42);
        seals.add({ x: big ? card.x + card.w / 2 : p.x, y: big ? card.y + card.h / 2 : p.y, r, rot: rnd(TAU), big, life: big ? .9 : .6 });
        for (let i = 0, n = big ? 4 : 2; i < n; i++) { const q = rnd(TAU), d = r * rnd(1, 1.5); arcs.add({ delay: i * .04, x1: p.x, y1: p.y, x2: p.x + Math.cos(q) * d, y2: p.y + Math.sin(q) * d, jag: r * .3, w: big ? 1 : .7, life: .18 }); }
      },
      build() { aura = 1; },
      reveal(tier, p) {
        for (let i = 0, n = burst(p, 16, 4); i < n; i++) tongues.add({ delay: rnd(0, .45), x: rnd(card.x, card.x + card.w), y: card.y + card.h * rnd(.4, .9), h: card.h * rnd(1.2, 2.4), w: card.h * rnd(.18, .3), ph: rnd(TAU), c: pick(['#8b5cf6', '#6366f1', '#a855f7']), life: rnd(.8, 1.3) });
        for (let i = 0, n = Math.round(1 + 4 * p); i < n; i++) { const y = card.y + rnd(card.h * .1, card.h * .9); arcs.add({ delay: .1 + i * .09, x1: card.x - 6, y1: y, x2: card.x + card.w + 6, y2: card.y + rnd(card.h), jag: card.h * .35, w: 1, life: .22 }); }
      },
    };
  });

  // 🍡 Marshmallow (2026-10-21, idée de DandoriNinja) — un ciel pastel. Pendant le tirage, des guimauves blanches et
  // roses tombent doucement derrière les chiffres (calque intérieur, en sourdine). Chaque chiffre posé lâche une petite
  // bouffée de sucre. À la révélation, deux canons à confettis surgissent aux coins bas de la carte, sursautent et
  // crachent des mini-guimauves arc-en-ciel pastel qui retombent en tournoyant ; à partir de Mythic, trois salves et de
  // plus grosses guimauves. Rien pour un tirage raté. Matière molle : tout rebondit et s'écrase.
  const PASTEL = ['#fca5a5', '#fdba74', '#fde68a', '#bbf7d0', '#bae6fd', '#c4b5fd', '#f9a8d4', '#ffffff'];
  // la révélation des morceaux génériques est coupée : ce sont les canons qui la font, sans couvrir les chiffres
  const quiet = base => env => { const s = base(env); return Object.assign({}, s, { reveal() {} }); };
  SCENES.marsh = custom(quiet(pieces({ cols: ['#ffffff', '#fbcfe8', '#f9a8d4'], shapes: ['mallow'], size: [2.4, 4], g: 300, drag: 1.2, spin: 3, up: true, life: 1.2, glowc: '#f9a8d4', ring: '#f9a8d4', drift: { rate: .6, from: 'around' } })), env => {
    const { co, ci, w, h, card, q, dark } = env, fall = particles(), mini = particles(), puffs = timed(), emit = emitter();
    let snow = .7; // débit des guimauves qui tombent : monte pendant le tirage, s'arrête après la révélation
    const S = card.h * .5;
    // Canon à confettis : un cône à rayures pastel, la bouche vers la carte ; kick = le sursaut quand il tire.
    const popper = (x, y, ang, a, kick) => {
      co.save(); co.translate(x, y); co.rotate(ang - kick * .25 * Math.sign(Math.cos(ang))); co.scale(1 - kick * .15, 1 + kick * .2); co.globalAlpha = a;
      co.beginPath(); co.moveTo(-S * .9, 0); co.lineTo(S * .15, -S * .32); co.lineTo(S * .15, S * .32); co.closePath();
      co.fillStyle = '#f9a8d4'; co.fill(); co.save(); co.clip();
      co.fillStyle = '#fef3c7'; for (let i = 0; i < 4; i++) { co.beginPath(); co.moveTo(-S * (.75 - i * .26), -S); co.lineTo(-S * (.62 - i * .26), -S); co.lineTo(-S * (.82 - i * .26), S); co.lineTo(-S * (.95 - i * .26), S); co.fill(); }
      co.restore(); co.strokeStyle = '#be185d'; co.lineWidth = 1.4; co.stroke();
      co.fillStyle = '#c4b5fd'; co.beginPath(); co.ellipse(S * .15, 0, S * .08, S * .32, 0, 0, TAU); co.fill(); co.stroke();
      co.restore();
    };
    const guns = [];
    const volley = (g, p, big) => {
      g.kick = 1;
      puffs.add({ x: g.x + Math.cos(g.ang) * S * .25, y: g.y + Math.sin(g.ang) * S * .25, r: S * (.5 + .4 * p), life: .45 });
      for (let i = burst(p, 70 * q, 12); i > 0; i--) {
        const a = g.ang + rnd(-.25, .25), v = rnd(260, 400 + 240 * p);
        mini.add({ x: g.x + Math.cos(g.ang) * S * .2, y: g.y + Math.sin(g.ang) * S * .2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 520, drag: 1.5, max: rnd(1.3, 2.1), size: rnd(2.6, 4.2) * (big ? 1.4 : 1), c: pick(PASTEL), rot: rnd(TAU), vr: rnd(-6, 6) });
      }
    };
    return {
      frame(t, dt) {
        // guimauves qui tombent dans la carte, derrière les chiffres
        for (let n = emit(snow * 5 * q, dt); n > 0; n--) fall.add({ x: rnd(w * .03, w * .97), y: -h * .15, vx: rnd(-4, 4), vy: rnd(h * .35, h * .6), max: rnd(1.8, 2.8), size: rnd(h * .07, h * .11), c: Math.random() < .55 ? '#ffffff' : '#fbcfe8', rot: rnd(TAU), vr: rnd(-1.5, 1.5), ph: rnd(TAU) });
        fall.step(dt);
        ci.globalCompositeOperation = 'source-over';
        fall.each((p, k) => { ci.save(); ci.translate(p.x + Math.sin(t * 2 + p.ph) * h * .05, p.y); ci.rotate(p.rot + p.vr * p.life); ci.globalAlpha = .75 * Math.min(1, k * 6, (1 - k) * 4); ci.fillStyle = p.c; SHAPES.mallow(ci, p, p.size); ci.restore(); });
        ci.globalAlpha = 1;
        co.globalCompositeOperation = 'source-over';
        // bouffées de sucre glace
        puffs.run(dt, (f, k) => { co.globalAlpha = (1 - k) * .7; co.fillStyle = dark ? '#fdf2f8' : '#fbcfe8'; for (let i = 0; i < 5; i++) { const a = i * TAU / 5 + f.r, d = f.r * .5 * outCubic(k); co.beginPath(); co.arc(f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, f.r * (.25 + .25 * k), 0, TAU); co.fill(); } });
        // canons : surgissent (petit rebond), tirent, puis s'effacent
        for (const g of guns) {
          g.t += dt; g.kick = Math.max(0, g.kick - dt * 5);
          const inn = Math.min(1, g.t / .18), a = g.t > g.end ? Math.max(0, 1 - (g.t - g.end) / .4) : inn;
          if (a > 0) popper(g.x, g.y + (1 - outCubic(inn)) * S * .6, g.ang, a, g.kick);
        }
        for (let i = guns.length - 1; i >= 0; i--) if (guns[i].t > guns[i].end + .4) guns.splice(i, 1);
        mini.step(dt);
        mini.each((p, k) => { co.save(); co.translate(p.x, p.y); co.rotate(p.rot + p.vr * p.life); co.scale(1, .75 + .25 * Math.cos(p.life * 8 + p.rot)); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = p.c; SHAPES.mallow(co, p, p.size); co.restore(); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        snow = Math.min(1, snow + .3);
        if (!o.ghost) puffs.add({ x: p.x, y: p.y + card.h * .32, r: card.h * (o.last ? .22 : .14), life: o.last ? .5 : .35 });
      },
      build() { snow = 1; },
      reveal(tier, p) {
        setTimeout(() => { snow = 0; }, 600);
        if (!p) return;
        const big = p >= 1, y = card.y + card.h + S * .15;
        const L = { x: card.x - S * .1, y, ang: -Math.PI / 2 + .1, t: 0, kick: 0, end: 1.6 + p }, R = { x: card.x + card.w + S * .1, y, ang: -Math.PI / 2 - .1, t: 0, kick: 0, end: 1.6 + p };
        guns.push(L, R);
        for (let i = 0, n = big ? 3 : 1; i < n; i++) setTimeout(() => { volley(L, p, big); volley(R, p, big); }, 200 + i * 420);
      },
    };
  });

  // 🩸 Bloodlust (2026-10-16, idée d'un joueur) — un liquide rouge sombre et brillant, stylisé (rien de gore) : au-
  // dessus de chaque chiffre posé, une goutte gonfle, se détache et s'écrase sur le haut de la carte ; à la révélation,
  // une pluie de gouttes s'y écrase. Matière molle : les gouttes s'étirent et s'aplatissent.
  SCENES.bloodlust = custom(pieces({ cols: ['#991b1b', '#b91c1c', '#7f1d1d', '#dc2626'], shapes: ['drop'], size: [1.6, 3.4], g: 900, spin: 0, glowc: '#ef4444', ring: '#7f1d1d', drift: { rate: 1.2, from: 'around' } }), env => {
    const { co, card } = env, drips = timed(), splats = timed();
    const DARK = '#7f1d1d', RED = '#ef4444', HI = 'rgba(254,226,226,.9)';
    const drop = (x, y, r, stretch) => {
      co.shadowColor = 'rgba(239,68,68,.7)'; co.shadowBlur = r * 1.2; co.fillStyle = RED; co.beginPath(); co.moveTo(x, y - r * stretch * 1.6); co.bezierCurveTo(x + r * 1.1, y - r * .2, x + r, y + r, x, y + r); co.bezierCurveTo(x - r, y + r, x - r * 1.1, y - r * .2, x, y - r * stretch * 1.6); co.fill(); co.shadowBlur = 0;
      co.fillStyle = HI; co.beginPath(); co.ellipse(x - r * .35, y, r * .2, r * .35, -.3, 0, TAU); co.fill();
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        drips.run(dt, (d, k) => {
          // 0 → .55 : la goutte gonfle et s'étire sous le bord ; puis elle tombe
          const g0 = d.fall ? .2 : .55, grow = Math.min(1, k / g0), fall = k > g0 ? (k - g0) / (1 - g0) : 0, y = d.y + fall * fall * (card.y - d.y);
          co.globalAlpha = 1; drop(d.x, y - d.r * (1 - fall), d.r * (.4 + .6 * grow), 1 + grow * .6 + fall * .8);
          if (fall >= .98 && !d.hit) { d.hit = true; splats.add({ x: d.x, y: card.y, r: d.r, life: 1.1 }); }
        });
        splats.run(dt, (p, k) => {
          const w = p.r * (1.2 + Math.min(1, k * 6) * 1.6); co.globalAlpha = k > .6 ? (1 - k) / .4 : 1;
          co.fillStyle = DARK; co.beginPath(); co.ellipse(p.x, p.y + 1, w * 1.05, w * .3, 0, 0, TAU); co.fill();
          co.fillStyle = RED; co.beginPath(); co.ellipse(p.x, p.y, w, w * .26, 0, 0, TAU); co.fill();
          for (let i = 0; i < 4; i++) { const a = Math.PI + (i + .5) * Math.PI / 4, rr = w * (1 + k * 1.2); co.beginPath(); co.arc(p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr * .5, p.r * .18 * (1 - k), 0, TAU); co.fill(); }
        });
        co.globalAlpha = 1;
      },
      // Le canevas est derrière la carte et le bas est masqué sur la page de résultat : tout se passe au-dessus.
      lock(p, o) { if (!o.ghost) drips.add({ x: p.x, y: card.y - card.h * 1.1, r: card.h * (o.last ? .13 : .1), drop: card.h * 1.1, life: .9 }); },
      reveal(tier, p) { for (let i = 0, n = 5 + Math.round(8 * p); i < n; i++) drips.add({ delay: rnd(0, .5), x: card.x + card.w * rnd(.03, .97), y: card.y - card.h * rnd(.9, 1.6), r: card.h * rnd(.08, .14), drop: card.h * 1.4, life: rnd(.8, 1.1), fall: true }); },
    };
  });

  // 👻 Haunted (Halloween 2026) — un cimetière autour de la carte : des tombes de part et d'autre (posées au niveau de son
  // bas), une grille rouillée, de la brume au sol ; des fantômes sortent des tombes de temps en temps, un petit fantôme
  // s'échappe de chaque chiffre posé, et une nuée s'envole à la révélation.
  SCENES.haunted = env => {
    const { co, card, dark } = env, ghosts = timed(), emit = emitter();
    const base = card.y + card.h + 6, k = Math.min(1.3, card.h / 60), STONE = dark ? '#3b3650' : '#6b6480', EDGE = dark ? '#1c1928' : '#3f3a52';
    const graves = [-1, 1].flatMap(side => [0, 1, 2].map(i => ({ x: side < 0 ? card.x - (26 + i * 34) * k : card.x + card.w + (26 + i * 34) * k, h: (26 - i * 4) * k, w: (16 - i * 2) * k, tilt: side * (i % 2 ? .08 : -.05), cross: i === 1 })));
    let formed = 0;
    const ghost = (x, y, s, a, wob) => {
      co.save(); co.translate(x, y); co.globalAlpha = a; co.fillStyle = dark ? '#f5f3ff' : '#ede9fe'; co.shadowColor = 'rgba(196,181,253,.9)'; co.shadowBlur = s * .6;
      co.beginPath(); co.arc(0, 0, s, Math.PI, 0); co.lineTo(s, s * 1.2);
      for (let i = 0; i < 4; i++) { const x1 = s - (i + .5) * s / 2, x2 = s - (i + 1) * s / 2; co.quadraticCurveTo(x1, s * (1.2 + (i % 2 ? -.35 : .35) + Math.sin(wob + i) * .1), x2, s * 1.2); }
      co.closePath(); co.fill(); co.shadowBlur = 0; co.fillStyle = '#1e1b2e';
      co.beginPath(); co.ellipse(-s * .35, -s * .1, s * .14, s * .2, 0, 0, TAU); co.ellipse(s * .35, -s * .1, s * .14, s * .2, 0, 0, TAU); co.fill();
      co.beginPath(); co.ellipse(0, s * .35, s * .12, s * .16, 0, 0, TAU); co.fill(); co.restore();
    };
    const tomb = g => {
      co.save(); co.translate(g.x, base); co.rotate(g.tilt); co.globalAlpha = formed;
      co.fillStyle = STONE; co.strokeStyle = EDGE; co.lineWidth = 1.5;
      if (g.cross) { co.fillRect(-g.w * .15, -g.h * 1.15, g.w * .3, g.h * 1.15); co.fillRect(-g.w * .5, -g.h * .85, g.w, g.w * .28); }
      else { co.beginPath(); co.moveTo(-g.w / 2, 0); co.lineTo(-g.w / 2, -g.h + g.w / 2); co.arc(0, -g.h + g.w / 2, g.w / 2, Math.PI, 0); co.lineTo(g.w / 2, 0); co.closePath(); co.fill(); co.stroke(); co.fillStyle = EDGE; co.fillRect(-g.w * .22, -g.h * .62, g.w * .44, 2); co.fillRect(-g.w * .15, -g.h * .48, g.w * .3, 2); }
      co.restore();
    };
    const rise = (g, big, delay = 0) => ghosts.add({ delay, life: rnd(2.2, 3), x: g ? g.x : rnd(card.x, card.x + card.w), y: g ? base - g.h : rnd(card.y, card.y + card.h), s: card.h * (big ? rnd(.22, .32) : rnd(.13, .18)), dx: rnd(-30, 30), ph: rnd(TAU), grave: !!g });
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        formed = Math.min(1, formed + dt * 1.5);
        co.globalAlpha = .35 * formed; const mist = co.createLinearGradient(0, base - 14 * k, 0, base + 8 * k); mist.addColorStop(0, 'rgba(196,181,253,0)'); mist.addColorStop(.6, dark ? 'rgba(196,181,253,.35)' : 'rgba(124,58,237,.18)'); mist.addColorStop(1, 'rgba(196,181,253,0)');
        co.fillStyle = mist; co.fillRect(card.x - 130 * k, base - 14 * k, card.w + 260 * k, 22 * k);
        co.globalAlpha = .55 * formed; co.strokeStyle = dark ? '#4b4560' : '#5b5470'; co.lineWidth = 1.4;
        co.beginPath(); co.moveTo(card.x - 120 * k, base - 9 * k); co.lineTo(card.x + card.w + 120 * k, base - 9 * k); co.stroke();
        for (let x = card.x - 118 * k; x < card.x + card.w + 120 * k; x += 9 * k) { co.beginPath(); co.moveTo(x, base); co.lineTo(x, base - 15 * k); co.lineTo(x - 2 * k, base - 12 * k); co.stroke(); }
        graves.forEach(tomb);
        for (let n = emit(.55 * formed, dt); n > 0; n--) rise(pick(graves), false);
        ghosts.run(dt, (g, kk) => ghost(g.x + g.dx * kk + Math.sin(t * 3 + g.ph) * 6, g.y - kk * card.h * (g.grave ? 1.6 : 2.2), g.s * (.6 + .5 * Math.min(1, kk * 3)), Math.sin(Math.PI * Math.min(1, kk * 1.1)) * .8, t * 4 + g.ph));
        co.globalAlpha = 1;
      },
      lock(p, o) { if (!o.ghost) rise(null, false); },
      reveal(tier, p) { for (let i = 0, n = 6 + Math.round(10 * p); i < n; i++) rise(i % 2 ? pick(graves) : null, true, i * .08); },
    };
  };

  // 🦇 Chauves-souris partagées par les skins d'Halloween : un corps, deux ailes qui battent.
  const bat = (co, x, y, s, flap, a) => {
    co.save(); co.translate(x, y); co.globalAlpha = a; co.fillStyle = '#120a1f';
    const w = Math.sin(flap) * .6 + .4;
    co.beginPath(); co.moveTo(0, 0); co.quadraticCurveTo(-s * .6, -s * w, -s * 1.3, -s * .2 * w); co.quadraticCurveTo(-s * .9, s * .1, -s * .7, s * .35); co.quadraticCurveTo(-s * .4, s * .1, 0, s * .3);
    co.quadraticCurveTo(s * .4, s * .1, s * .7, s * .35); co.quadraticCurveTo(s * .9, s * .1, s * 1.3, -s * .2 * w); co.quadraticCurveTo(s * .6, -s * w, 0, 0); co.fill();
    co.beginPath(); co.arc(0, s * .05, s * .22, 0, TAU); co.fill(); co.restore();
  };
  // 🎃 Jack-o'-Lantern — une lueur de bougie vacille derrière la carte, des étincelles orangées à chaque chiffre creusé,
  // et à la révélation des chauves-souris s'échappent de la citrouille.
  SCENES.pumpkin = custom(pieces({ cols: ['#fb923c', '#fbbf24', '#fde68a', '#ea580c'], shapes: ['spark', 'drop'], size: [1.4, 3.2], g: -220, spin: 2, up: true, glowc: '#f59e0b', ring: '#fb923c', drift: { rate: 3, from: 'around' } }), env => {
    const { co, card } = env, bats = timed();
    const fly = (delay, big) => { const dir = Math.random() < .5 ? -1 : 1; bats.add({ delay, life: rnd(1.4, 2.2), x: rnd(card.x + card.w * .3, card.x + card.w * .7), y: card.y + card.h * .4, vx: dir * rnd(90, 200), vy: -rnd(60, 140), s: card.h * (big ? rnd(.14, .2) : .1), ph: rnd(TAU) }); };
    return {
      frame(t, dt) { co.globalCompositeOperation = 'source-over'; bats.run(dt, (b, k) => bat(co, b.x + b.vx * k * 1.6, b.y + b.vy * k * 1.6 + Math.sin(t * 9 + b.ph) * 5, b.s * (.6 + .6 * Math.min(1, k * 4)), t * 22 + b.ph, Math.min(1, (1 - k) * 2.5))); co.globalAlpha = 1; },
      lock(p, o) { if (o.last) fly(0, false); },
      reveal(tier, p) { for (let i = 0, n = 4 + Math.round(8 * p); i < n; i++) fly(i * .07, true); },
    };
  });
  // 🍬 Trick or Treat (2026-10-16, idée de Deadshot) — des bonbons tombent autour des maisons ; à chaque porte ouverte,
  // une poignée de bonbons en jaillit ; à la révélation, une volée de chauves-souris et une pluie de bonbons.
  SCENES.trickortreat = custom(pieces({ cols: ['#fb7185', '#fbbf24', '#a78bfa', '#34d399', '#fb923c'], shapes: ['ball', 'sprinkle'], size: [1.8, 3.6], g: 520, spin: 3, up: true, glowc: '#fb923c', ring: '#a78bfa', drift: { rate: 2, from: 'around' } }), env => {
    const { co, card } = env, bats = timed();
    const fly = delay => { const dir = Math.random() < .5 ? -1 : 1; bats.add({ delay, life: rnd(1.4, 2.2), x: rnd(card.x + card.w * .3, card.x + card.w * .7), y: card.y + card.h * .3, vx: dir * rnd(90, 200), vy: -rnd(60, 140), s: card.h * rnd(.12, .18), ph: rnd(TAU) }); };
    return {
      frame(t, dt) { co.globalCompositeOperation = 'source-over'; bats.run(dt, (b, k) => bat(co, b.x + b.vx * k * 1.6, b.y + b.vy * k * 1.6 + Math.sin(t * 9 + b.ph) * 5, b.s * (.6 + .6 * Math.min(1, k * 4)), t * 22 + b.ph, Math.min(1, (1 - k) * 2.5))); co.globalAlpha = 1; },
      lock() {},
      reveal(tier, p) { for (let i = 0, n = 2 + Math.round(5 * p); i < n; i++) fly(i * .09); },
    };
  });
  // 🧪 Witch's Brew — des bulles vertes montent sans cesse du chaudron, chaque chiffre fait « plop », et à la révélation
  // une grande fumée verte s'élève avec des étincelles violettes.
  SCENES.brew = custom(pieces({ cols: ['#bef264', '#a3e635', '#84cc16', '#d9f99d'], shapes: ['bubble'], size: [2, 5], g: -160, spin: 0, up: true, glowc: '#84cc16', ring: '#a3e635', drift: { rate: 6, from: 'bottom' } }), env => {
    const { co, card, dark } = env, puffs = timed(), sparks = timed();
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        puffs.run(dt, (f, k) => { co.globalAlpha = (1 - k) * .45; const g = co.createRadialGradient(f.x, f.y - k * 70, 0, f.x, f.y - k * 70, f.r * (1 + k * 1.6)); g.addColorStop(0, dark ? 'rgba(190,242,100,.8)' : 'rgba(101,163,13,.6)'); g.addColorStop(1, 'rgba(132,204,22,0)'); co.fillStyle = g; co.beginPath(); co.arc(f.x, f.y - k * 70, f.r * (1 + k * 1.6), 0, TAU); co.fill(); });
        sparks.run(dt, (s, k) => { co.globalAlpha = 1 - k; co.fillStyle = s.c; co.beginPath(); co.arc(s.x + s.vx * k, s.y + s.vy * k + 60 * k * k, s.r * (1 - k * .5), 0, TAU); co.fill(); });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (!o.ghost) puffs.add({ x: p.x, y: card.y, r: card.h * .3, life: .9 }); },
      reveal(tier, p) {
        for (let i = 0; i < 7; i++) puffs.add({ delay: i * .06, x: rnd(card.x, card.x + card.w), y: card.y + card.h * .2, r: card.h * rnd(.5, .9), life: rnd(1.6, 2.4) });
        for (let i = 0, n = 20 + Math.round(30 * p); i < n; i++) sparks.add({ delay: rnd(0, .3), x: rnd(card.x, card.x + card.w), y: card.y, vx: rnd(-80, 80), vy: -rnd(60, 160), r: rnd(1.5, 3.2), c: pick(['#c084fc', '#a855f7', '#e9d5ff', '#bef264']), life: rnd(.8, 1.4) });
      },
    };
  });

  // 🧪 Lab (idée de costoroll, 2026-10-21) — six tubes à essai. Chaque chiffre posé : un anneau à la surface de son
  // liquide et un chapelet de bulles. À la révélation, tout pétille : des bulles montent du fond de chaque tube et
  // éclatent à la surface ; dès Mythic, ça mousse et déborde (grosses bulles, gouttelettes projetées hors des tubes).
  SCENES.lab = env => {
    const { co, card, q, dark } = env;
    const LIQ = ['#fb923c', '#3b82f6', '#f1f5f9', '#a855f7', '#22c55e', '#ef4444']; // ordre choisi par costoroll
    const tubes = [], bubbles = particles(), drops = particles(), rings = timed(), pops = timed(), emit = [];
    let n = 0, fizz = 0, fizzEnd = 0, strong = false, t0 = 0, now = 0;
    // Géométrie d'un tube (en fraction de la hauteur de carte) : la surface du liquide un peu au-dessus du centre de la
    // case, le fond en bas, la largeur intérieure.
    const surf = y => y - card.h * .1, floor = y => y + card.h * .3, half = () => card.h * .11;
    // La carte rétrécit quand les zéros de tête s'effacent : les tubes gardent leurs écarts, recentrés sur la carte.
    const at = tb => { const live = tubes.filter(u => !u.ghost); const mid = live.length ? (live[0].x + live[live.length - 1].x) / 2 : tb.x; return tb.x - mid + card.x + card.w / 2; };
    const bubble = (tb, big) => bubbles.add({ tb, x0: rnd(-1, 1) * half() * .75, y: floor(tb.y) - rnd(0, card.h * .08), vx: 0, vy: -rnd(30, 70) * (big ? 1.6 : 1), g: -rnd(60, 160) * (big ? 1.8 : 1), max: 3, size: rnd(.9, 2) * (big ? 1.6 : 1), ph: rnd(TAU), big });
    const ring = (x, y, c, big) => rings.add({ x, y, c, size: half() * (big ? 2.4 : 1.6), life: big ? .5 : .38 });
    return {
      frame(t, dt) {
        now = t;
        co.globalCompositeOperation = 'source-over';
        // la révélation : chaque tube émet ses bulles tant que le pétillement dure (il s'éteint en douceur)
        if (fizz > 0 && t < fizzEnd) {
          const k = clamp((fizzEnd - t) / (fizzEnd - t0)), rate = fizz * (.3 + .7 * k);
          tubes.forEach((tb, i) => { if (tb.ghost) return; for (let m = emit[i](rate * q, dt); m > 0; m--) bubble(tb, strong && Math.random() < .35); });
        }
        bubbles.step(dt);
        bubbles.each((b, k) => {
          const x = at(b.tb) + b.x0 + Math.sin(b.life * 9 + b.ph) * half() * .12, top = surf(b.tb.y);
          if (b.y <= top) { // arrivée à la surface : elle éclate (et, si ça mousse, elle déborde du tube)
            b.life = b.max;
            pops.add({ x, y: top, c: b.tb.c, size: b.size * 2.4, life: .22 });
            if (strong && b.big) for (let j = 0; j < 2; j++) drops.add({ x, y: top - card.h * .3, vx: rnd(-70, 70), vy: -rnd(140, 280), g: 520, max: rnd(.6, 1), size: rnd(1.2, 2.4), c: b.tb.c });
            return;
          }
          co.globalAlpha = .85; co.strokeStyle = 'rgba(255,255,255,.9)'; co.lineWidth = b.big ? 1.2 : .9;
          co.beginPath(); co.arc(x, b.y, b.size, 0, TAU); co.stroke();
          co.fillStyle = 'rgba(255,255,255,.75)'; co.beginPath(); co.arc(x - b.size * .35, b.y - b.size * .35, b.size * .28, 0, TAU); co.fill();
        });
        drops.step(dt);
        drops.each((d, k) => dot(co, d.c, d.x, d.y, d.size * 2.2, (1 - k) * (dark ? .95 : .8)));
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        pops.run(dt, (p, k) => { co.globalAlpha = (1 - k) * .9; co.strokeStyle = '#ffffff'; co.lineWidth = 1; co.beginPath(); co.arc(p.x, p.y, p.size * (.5 + k), 0, TAU); co.stroke(); dot(co, p.c, p.x, p.y, p.size * 2, (1 - k) * .5); });
        rings.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = r.c; co.lineWidth = 1.6 * (1 - k) + .4; co.beginPath(); co.ellipse(r.x, r.y, r.size * (.4 + .8 * outCubic(k)), r.size * .22 * (.4 + .8 * outCubic(k)), 0, 0, TAU); co.stroke(); });
        // dès Mythic : la lueur des tubes pulse autour de la carte pendant que ça mousse
        if (strong && t < fizzEnd) { const k = clamp((fizzEnd - t) / (fizzEnd - t0)); tubes.forEach(tb => { if (!tb.ghost) dot(co, tb.c, at(tb), tb.y, card.h * .55, k * (dark ? .22 : .14) * (.8 + .2 * Math.sin(t * 14 + tb.x))); }); }
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(p, o) {
        const tb = { x: p.x, y: p.y, c: LIQ[n % 6], ghost: !!o.ghost };
        n++; tubes.push(tb); emit.push(emitter());
        if (o.ghost) return;
        ring(p.x, surf(p.y), tb.c === '#f1f5f9' ? '#e0f2fe' : tb.c, o.last);
        for (let i = Math.round((o.last ? 7 : 4) * q); i > 0; i--) bubble(tb, false);
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        strong = p >= 1; t0 = now;
        // de deux bulles tristes (tirage raté) à un vrai pétillement, puis une mousse qui déborde dès Mythic
        fizz = strong ? 26 : 2 + 14 * p; fizzEnd = now + (strong ? 3.2 : 1.2 + 1.4 * p);
        if (strong) tubes.forEach(tb => { if (!tb.ghost) for (let i = 0; i < 6; i++) bubble(tb, true); });
      },
    };
  };

  // 🍔 Burger (2026-10-23, idée de jaxoncool43) — chaque ingrédient qui tombe (CSS) fait sauter quelques miettes et
  // graines de sésame ; quand le pain du dessus se pose (transition CSS au retrait de .charging, juste après le dernier
  // chiffre), les graines sautent du pain et des miettes giclent sur les côtés. À la révélation, la vapeur d'un burger
  // tout chaud monte, plus dense si c'est rare ; dès Mythic, une pluie de sésame doré. Tirage raté : rien ne fume.
  SCENES.burger = env => {
    const { co, card, q, dark, el } = env;
    const BUN = ['#f59e0b', '#d97706', '#fbbf24'], SEED = dark ? '#fffbeb' : '#fef3c7';
    const bits = particles(), steam = particles(), glows = timed();
    let now = 0, landAt = 0, steamEnd = 0, steamRate = 0, t0 = 0, gold = false, closing = false;
    const emit = emitter();
    // une graine (ovale clair qui tourne) ou une miette (rond doré), lancée vers le haut depuis (x, y)
    const toss = (x, y, n, spread, up) => {
      for (let i = Math.round(n * q); i > 0; i--) {
        const seed = Math.random() < .55;
        bits.add({ x: x + rnd(-spread, spread), y, vx: rnd(-1, 1) * card.h * 1.4, vy: -rnd(.6, 1) * up, g: card.h * 9, drag: .6, max: rnd(.45, .8), size: card.h * (seed ? rnd(.035, .05) : rnd(.025, .045)), rot: rnd(TAU), spin: rnd(-14, 14), seed, c: seed ? SEED : pick(BUN) });
      }
    };
    const puffOf = strong => steam.add({ x: card.x + card.w * rnd(.15, .85), y: card.y + card.h * .1, vx: rnd(-6, 6), vy: -card.h * rnd(.7, 1.1), drag: .3, g: -card.h * .25, max: rnd(1, 1.6) * (strong ? 1.2 : 1), size: card.h * rnd(.05, .09), ph: rnd(TAU) });
    return {
      frame(t, dt) {
        now = t;
        // .charging vient de partir (tout de suite dans un tirage, 0,6 s plus tard dans l'aperçu de la boutique) : la
        // transition du pain touche la pile vers 0,24 s ; alors les graines sautent et des miettes giclent des deux côtés
        if (closing && el && !el.classList.contains('charging')) { closing = false; landAt = t + .24; }
        if (landAt && t >= landAt) {
          landAt = 0;
          toss(card.x + card.w / 2, card.y + card.h * .1, 10, card.w * .38, card.h * 3.2);
          toss(card.x + card.w * .06, card.y + card.h * .5, 3, card.h * .1, card.h * 2);
          toss(card.x + card.w * .94, card.y + card.h * .5, 3, card.h * .1, card.h * 2);
        }
        if (steamRate && t < steamEnd) { const k = clamp((steamEnd - t) / (steamEnd - t0)); for (let m = emit(steamRate * q * (.35 + .65 * k), dt); m > 0; m--) puffOf(gold); }
        // la vapeur : de fines volutes étirées qui montent en ondulant, s'élargissent et s'effacent (pas un nuage)
        steam.step(dt);
        co.globalCompositeOperation = 'source-over';
        steam.each((s, k) => { const a = Math.sin(Math.PI * k) * (dark ? .2 : .32), r = s.size * (1 + k * 1.2); dot(co, dark ? '#f8fafc' : '#94a3b8', s.x + Math.sin(s.life * 5 + s.ph) * card.h * (.05 + .1 * k), s.y, r, a, r * 2.6); });
        if (gold) glows.run(dt, (g, k) => { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#fbbf24', g.x, g.y, card.h * (1 + k), (1 - k) * (dark ? .35 : .22), card.h * .6 * (1 + k)); });
        co.globalCompositeOperation = 'source-over';
        bits.step(dt);
        bits.each((b, k) => {
          b.rot += b.spin * dt;
          co.globalAlpha = Math.min(1, (1 - k) * 1.6);
          co.save(); co.translate(b.x, b.y); co.rotate(b.rot);
          co.fillStyle = dark ? 'rgba(0,0,0,.45)' : 'rgba(120,53,15,.45)';
          co.beginPath(); co.ellipse(0, 0, b.size * (b.seed ? 1.25 : 1) + .8, b.size * (b.seed ? .6 : 1) + .8, 0, 0, TAU); co.fill();
          co.fillStyle = b.c;
          co.beginPath(); co.ellipse(0, 0, b.size * (b.seed ? 1.25 : 1), b.size * (b.seed ? .6 : 1), 0, 0, TAU); co.fill();
          co.restore();
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        // l'ingrédient s'écrase sur la pile (40 % de son animation CSS de 0,6 s) : quelques miettes sautent
        const x = p.x, y = p.y - card.h * .2;
        setTimeout(() => toss(x, y, o.last ? 5 : 3, card.h * .15, card.h * 1.6), 240);
        if (o.last) closing = true;
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) return;
        gold = p >= 1; t0 = now;
        steamRate = 4 + 12 * p; steamEnd = now + 1.2 + 1.6 * p;
        if (gold) {
          glows.add({ x: card.x + card.w / 2, y: card.y + card.h / 2, life: 1.2 });
          for (let i = 0; i < 4; i++) setTimeout(() => toss(card.x + card.w / 2, card.y, 9, card.w * .5, card.h * 4), i * 140);
        }
      },
    };
  };

  // 🚲 Wheelie (2026-10-21, idée de JBearr12) — un cycliste en wheelie roule sur la bordure de trottoir (le haut de la
  // carte), de gauche à droite. Il arrive de la gauche au début du tirage et, à chaque chiffre posé, file juste devant lui :
  // le chiffre surgit dans son sillage, avec une bouffée de poussière et une trace de pneu. À la révélation il saute et
  // retombe sur sa roue avant (étincelles, et un salto arrière dès Mythic), puis sort à droite. Tirage raté : pas de saut.
  SCENES.wheelie = env => {
    const { co, card, dark, q } = env;
    const R = Math.max(7, card.h * .21); // rayon des roues
    const ground = () => card.y + 1;
    const INK = dark ? '#f4f4f5' : '#18181b', HALO = dark ? 'rgba(9,9,11,.85)' : 'rgba(255,255,255,.9)';
    const FRAME = '#22d3ee', HOODIE = '#f97316', HELMET = '#facc15';
    const dust = particles(), sparks = particles(), skids = timed();
    // x : roue arrière ; tx : où il va ; air : hauteur du saut ; flip : angle du salto
    const bike = { x: card.x - card.h * 2.2, tx: card.x - R * 1.5, pitch: -.45, air: 0, flip: 0, a: 1, jump: null, gone: false };
    let roll = 0;
    // Le vélo, dessiné dans son repère : roue arrière au sol en (0, 0), l'avant vers +x, cabré de `pitch`.
    const draw = (t) => {
      const lw = Math.max(1.4, R * .22);
      co.save();
      co.translate(bike.x, ground() - bike.air);
      // salto : on tourne autour du centre du vélo, pas de la roue arrière
      if (bike.flip) { co.translate(R * 1.3, -R * 1.6); co.rotate(-bike.flip); co.translate(-R * 1.3, R * 1.6); }
      co.rotate(bike.pitch);
      co.globalAlpha = bike.a;
      co.lineCap = 'round'; co.lineJoin = 'round';
      const rear = [0, -R], front = [R * 2.7, -R], bb = [R * 1.15, -R * .85], seat = [R * .85, -R * 2.15], head = [R * 2.35, -R * 2.2], bar = [R * 2.15, -R * 2.85];
      const crank = roll * .6, ped = [bb[0] + Math.cos(crank) * R * .45, bb[1] + Math.sin(crank) * R * .45], ped2 = [bb[0] - Math.cos(crank) * R * .45, bb[1] - Math.sin(crank) * R * .45];
      const hip = [seat[0] - R * .1, seat[1] - R * .2], shoulder = [R * .35, -R * 3.7], hd = [R * .25, -R * 4.45];
      const knee = (p) => { const mx = (hip[0] + p[0]) / 2, my = (hip[1] + p[1]) / 2; return [mx + R * .55, my - R * .35]; };
      const k1 = knee(ped), k2 = knee(ped2);
      const seg = (pts, col, w) => { co.strokeStyle = col; co.lineWidth = w; co.beginPath(); pts.forEach(([x, y], i) => (i ? co.lineTo(x, y) : co.moveTo(x, y))); co.stroke(); };
      const wheel = ([x, y]) => {
        co.strokeStyle = HALO; co.lineWidth = lw + 2.4; co.beginPath(); co.arc(x, y, R, 0, TAU); co.stroke();
        co.strokeStyle = INK; co.lineWidth = lw; co.beginPath(); co.arc(x, y, R, 0, TAU); co.stroke();
        co.lineWidth = Math.max(.8, lw * .35); co.globalAlpha = bike.a * .8;
        for (let i = 0; i < 3; i++) { const a = roll + i * Math.PI / 3; co.beginPath(); co.moveTo(x + Math.cos(a) * R * .85, y + Math.sin(a) * R * .85); co.lineTo(x - Math.cos(a) * R * .85, y - Math.sin(a) * R * .85); co.stroke(); }
        co.globalAlpha = bike.a;
      };
      // jambe du fond, roues, cadre, puis le cycliste
      seg([hip, k2, ped2], HALO, lw * 1.5 + 2.4); seg([hip, k2, ped2], '#1e3a8a', lw * 1.5);
      wheel(rear); wheel(front);
      const frame = [[rear, bb, seat, rear], [bb, head], [seat, head], [head, front], [head, bar]];
      for (const f of frame) seg(f, HALO, lw + 2.4);
      for (const f of frame) seg(f, FRAME, lw);
      seg([ped, ped2], INK, lw * .8);
      seg([hip, shoulder], HALO, lw * 2.6 + 2.4); seg([hip, shoulder], HOODIE, lw * 2.6);
      seg([shoulder, [R * 1.3, -R * 3.1], bar], HALO, lw * 1.2 + 2.4); seg([shoulder, [R * 1.3, -R * 3.1], bar], HOODIE, lw * 1.2);
      seg([hip, k1, ped], HALO, lw * 1.6 + 2.4); seg([hip, k1, ped], '#2563eb', lw * 1.6);
      co.fillStyle = HALO; co.beginPath(); co.arc(hd[0], hd[1], R * .62 + 1.2, 0, TAU); co.fill();
      co.fillStyle = '#fcd9b6'; co.beginPath(); co.arc(hd[0], hd[1], R * .55, 0, TAU); co.fill();
      co.fillStyle = HELMET; co.beginPath(); co.arc(hd[0], hd[1], R * .62, Math.PI * 1.02, Math.PI * 2.05); co.fill();
      co.fillRect(hd[0], hd[1] - R * .12, R * .75, R * .14); // visière
      co.restore();
    };
    const puff = (x, y, n, big) => { for (let i = Math.round(n * q); i > 0; i--) dust.add({ x: x + rnd(-R * .4, R * .4), y: y - rnd(0, R * .4), vx: -rnd(20, 90) * (big ? 1.6 : 1), vy: -rnd(10, 60) * (big ? 1.5 : 1), drag: 2.5, g: -10, max: rnd(.5, .9), size: R * rnd(.35, .7) * (big ? 1.4 : 1) }); };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // traces de pneu sur la bordure, qui s'effacent
        skids.run(dt, (s, k) => { co.globalAlpha = (1 - k) * .55; co.strokeStyle = dark ? '#09090b' : '#3f3f46'; co.lineWidth = Math.max(1.5, R * .28); co.lineCap = 'round'; co.beginPath(); co.moveTo(s.x0, ground() + .5); co.lineTo(s.x1, ground() + .5); co.stroke(); });
        // il avance vers sa cible (vite quand il a du retard, au pas sinon) ; la roue tourne avec la distance
        if (!bike.jump) {
          const d = bike.tx - bike.x, v = Math.sign(d) * Math.min(Math.abs(d), Math.max(card.h * .5, Math.abs(d) * 7) * dt);
          bike.x += v; roll += v / R;
          if (Math.abs(v) > .4 && Math.random() < .3) puff(bike.x - R * .2, ground(), 1, false);
          bike.pitch = -.45 + Math.sin(t * 5.5) * .05 - Math.min(.12, Math.abs(v) / dt / (card.h * 40));
        } else {
          // le saut : une parabole, l'avant redescend en l'air, la roue avant touche la première (et le salto dès Mythic)
          const j = bike.jump; j.t += dt; const k = clamp(j.t / j.d);
          bike.x = lerp(j.x0, j.x1, k); roll += (j.x1 - j.x0) / j.d * dt / R;
          bike.air = Math.sin(Math.PI * k) * j.h;
          bike.pitch = lerp(-.5, .25, outCubic(k));
          bike.flip = j.flip ? TAU * outCubic(clamp((k - .08) / .8)) : 0;
          if (k >= 1) {
            bike.jump = null; bike.air = 0; bike.flip = 0;
            puff(bike.x + R * 2.4, ground(), j.p >= 1 ? 16 : 8, true);
            for (let i = burst(j.p, 50 * q, 4); i > 0; i--) { const a = -Math.PI + rnd(.1, .9); const v = rnd(120, 260 + 200 * j.p); sparks.add({ x: bike.x + R * 2.6, y: ground(), vx: Math.cos(a) * v * (Math.random() < .5 ? 1 : -.6), vy: Math.sin(a) * v, g: 700, drag: 1.2, max: rnd(.3, .7), size: rnd(1, 2) }); }
            bike.tx = card.x + card.w + card.h * 3; bike.gone = true;
          }
        }
        if (bike.gone) bike.a = clamp((card.x + card.w + card.h * 2.4 - bike.x) / (card.h * 1.2));
        if (bike.a > 0) draw(t);
        dust.step(dt);
        dust.each((p, k) => { co.globalAlpha = (1 - k) * (dark ? .55 : .7); co.fillStyle = dark ? '#a8a29e' : '#78716c'; co.beginPath(); co.arc(p.x, p.y, p.size * (.6 + k), 0, TAU); co.fill(); });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.step(dt);
        sparks.each((p, k) => { tail(co, dark ? '#fde047' : '#f59e0b', p.x - p.vx * .03, p.y - p.vy * .03, p.x, p.y, p.size, 1 - k); });
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(p, o) {
        // il file juste devant le chiffre : celui-ci surgit dans son sillage
        bike.tx = Math.max(bike.tx, p.x + card.h * .25);
        if (o.ghost) return;
        const x = p.x;
        setTimeout(() => { puff(x, ground(), o.last ? 9 : 5, o.last); skids.add({ x0: x - card.h * .35, x1: x + card.h * .1, life: 1.4 }); }, 0);
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { bike.tx = card.x + card.w + card.h * 3; bike.gone = true; return; }
        // il prend son élan sur le dernier chiffre et saute vers la droite, plus haut et plus loin si c'est rare
        bike.jump = { t: 0, d: .55 + .3 * p, x0: bike.x, x1: Math.min(bike.x + card.h * (1.4 + 1.6 * p), card.x + card.w + card.h * .5), h: card.h * (.5 + .9 * p), flip: p >= 1, p };
        puff(bike.x, ground(), 6, true);
      },
    };
  };

  // 🏞️ Waterfall (2026-10-24, idée de JBearr12 et jjcoolcid1) — de la brume monte sans cesse du bassin au pied de la
  // carte ; chaque chiffre qui touche le bassin fait une éclaboussure (gouttes en arc) et une onde ; le dernier, plus
  // grosse. À la révélation, une gerbe d'embruns qui grandit avec la rareté et, dès Epic, un arc-en-ciel dans la brume
  // au-dessus de la carte (comme au pied d'une vraie cascade) ; plus grand et plus vif dès Mythic. Tirage raté : une goutte.
  SCENES.waterfall = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, pool = card.y + card.h - card.h * .12;
    const mist = particles(), drops = particles(), ripples = timed(), bows = timed(), emit = emitter();
    const SPRAY = dark ? ['#e0f2fe', '#bae6fd', '#ffffff'] : ['#7dd3fc', '#38bdf8', '#bae6fd'];
    let mistRate = 6;
    const splash = (x, s) => {
      ripples.add({ x, y: pool, r: card.h * (.25 + .35 * s), life: .7 });
      for (let i = Math.round((6 + 12 * s) * q); i > 0; i--) { const a = rnd(-Math.PI * .85, -Math.PI * .15), v = card.h * rnd(2.5, 4 + 4 * s); drops.add({ x: x + rnd(-1, 1) * card.h * .1, y: pool, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 12, drag: .2, max: rnd(.45, .8), size: card.h * rnd(.025, .045), c: pick(SPRAY) }); }
      for (let i = Math.round(3 * s * q) + 1; i > 0; i--) mist.add({ x: x + rnd(-1, 1) * card.h * .3, y: pool, vx: rnd(-1, 1) * 8, vy: -card.h * rnd(.4, .8), drag: .8, g: 0, max: rnd(1, 1.8), size: card.h * rnd(.15, .3) });
    };
    // l'arc-en-ciel : sept bandes concentriques, centrées sous la carte, qui apparaissent puis s'effacent
    const BOW = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#6366f1', '#a855f7'];
    const rainbow = (b, k) => {
      // de la lumière dans la brume : bandes fines et translucides, un voile blanc dessous ; assez petit pour tenir entier
      const a = (k < .25 ? k / .25 : k > .75 ? (1 - k) / .25 : 1) * b.a, bw = card.h * .045 * b.s, cy = card.y + card.h * .95;
      const R = Math.min(card.w * .5 + card.h * .55 * b.s, cy - 26);
      co.lineCap = 'butt';
      co.globalAlpha = a * .25; co.strokeStyle = '#ffffff'; co.lineWidth = bw * 9; co.beginPath(); co.arc(cx, cy, R - bw * 3, Math.PI * 1.1, Math.PI * 1.9); co.stroke();
      co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      BOW.forEach((c, i) => { co.globalAlpha = a * (dark ? .55 : .5); co.strokeStyle = c; co.lineWidth = bw; co.beginPath(); co.arc(cx, cy, R - i * bw, Math.PI * 1.1, Math.PI * 1.9); co.stroke(); });
      co.globalCompositeOperation = 'source-over';
    };
    return {
      frame(t, dt) {
        // la brume du bassin, derrière la carte (elle ne cache jamais les chiffres)
        for (let n = emit(mistRate * q, dt); n > 0; n--) mist.add({ x: cx + rnd(-.5, .5) * card.w, y: pool, vx: rnd(-1, 1) * 6, vy: -card.h * rnd(.2, .5), drag: .6, g: 0, max: rnd(1.4, 2.4), size: card.h * rnd(.18, .32) });
        mistRate += (6 - mistRate) * Math.min(1, dt * .8);
        mist.step(dt); drops.step(dt);
        behind(env, () => {
          co.globalCompositeOperation = 'source-over';
          bows.run(dt, rainbow);
          mist.each((m, k) => dot(co, dark ? '#e0f2fe' : '#bae6fd', m.x, m.y, m.size * (1 + k), Math.sin(Math.PI * k) * (dark ? .22 : .35)));
          // les gouttes aussi passent derrière : une éclaboussure ne brouille jamais un chiffre
          drops.each((d, k) => { co.globalAlpha = 1 - k * k; co.fillStyle = d.c; co.beginPath(); co.ellipse(d.x, d.y, d.size, d.size * 1.4, Math.atan2(d.vy, d.vx) + Math.PI / 2, 0, TAU); co.fill(); });
        });
        co.globalCompositeOperation = 'source-over';
        ripples.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? '#e0f2fe' : '#0284c7'; co.lineWidth = 1.5 * (1 - k) + .5; co.beginPath(); co.ellipse(r.x, r.y + card.h * .2, r.r * (.3 + k), r.r * (.3 + k) * .25, 0, 0, TAU); co.stroke(); });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; splash(p.x, o.last ? .9 : .45); },
      build() { mistRate = 14; },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { drops.add({ x: cx, y: card.y - card.h * .2, vx: 0, vy: 0, g: card.h * 8, drag: 0, max: .5, size: card.h * .05, c: SPRAY[0] }); return; } // une goutte
        for (let i = 0; i < 1 + Math.round(3 * p); i++) setTimeout(() => splash(cx + rnd(-.45, .45) * card.w, .5 + .7 * p), i * 90);
        mistRate = 10 + 30 * p;
        if (p >= .6) bows.add({ delay: .25, life: 2.6 + 1.6 * p, s: p >= 1 ? 1.25 + .15 * (ASCEND[tier] || 0) : .9, a: p >= 1 ? .85 : .6 });
      },
    };
  };

  // 🏛️ Greek (2026-10-25, idée de kaz) — chaque coup de ciseau fait sauter des éclats de marbre et un nuage de poussière
  // (derrière la carte : jamais sur un chiffre). À la révélation, une lueur dorée ; dès Epic, une couronne de laurier
  // d'or s'ouvre autour de la carte ; dès Mythic, des rayons de soleil grec et une pluie de feuilles d'or.
  SCENES.greek = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const chips = particles(), dust = particles(), leaves = particles(), glows = timed(), wreaths = timed();
    const CHIP = dark ? ['#fafaf9', '#e7e5e4', '#d6d3d1'] : ['#a8a29e', '#78716c', '#d6d3d1'];
    const GOLD = dark ? ['#fde68a', '#e9c46a', '#facc15'] : ['#ca8a04', '#b08d2a', '#a16207'];
    const chisel = (x, y, s) => {
      for (let i = Math.round((5 + 8 * s) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = card.h * rnd(1.5, 3 + 3 * s); chips.add({ x: x + rnd(-1, 1) * card.h * .08, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 10, drag: .3, max: rnd(.4, .75), size: card.h * rnd(.018, .035), r: rnd(TAU), c: pick(CHIP) }); }
      for (let i = Math.round(2 + 3 * s * q); i > 0; i--) dust.add({ x: x + rnd(-1, 1) * card.h * .15, y: y + rnd(-1, 1) * card.h * .1, vx: rnd(-1, 1) * 10, vy: -card.h * rnd(.1, .35), drag: .9, g: 0, max: rnd(.8, 1.4), size: card.h * rnd(.12, .22) });
    };
    // la couronne de laurier : deux branches de feuilles en ellipse qui poussent de bas en haut autour de la carte
    const wreath = (w, k) => {
      const grow = Math.min(1, k / .35), a = k > .7 ? (1 - k) / .3 : 1, rx = card.w * .5 + card.h * .45, ry = card.h * .5 + card.h * .45;
      co.globalAlpha = a * .9;
      for (const side of [-1, 1]) for (let i = 0; i < 11 * grow; i++) {
        const t = Math.PI / 2 + side * (i / 11) * Math.PI * .82, x = cx + Math.cos(t) * rx, y = cy + Math.sin(t) * ry;
        co.save(); co.translate(x, y); co.rotate(t + side * .9); co.fillStyle = GOLD[i % 3];
        co.beginPath(); co.ellipse(0, 0, card.h * .11 * w.s, card.h * .045 * w.s, 0, 0, TAU); co.fill(); co.restore();
      }
    };
    const glow = (g, k) => {
      const a = Math.sin(Math.PI * k) * g.a, R = card.w * .5 + card.h * (.4 + .6 * k);
      const gr = co.createRadialGradient(cx, cy, card.h * .3, cx, cy, R);
      gr.addColorStop(0, dark ? 'rgba(253,230,138,.55)' : 'rgba(202,138,4,.35)'); gr.addColorStop(1, 'rgba(253,230,138,0)');
      co.globalAlpha = a; co.fillStyle = gr; co.fillRect(cx - R, cy - R, R * 2, R * 2);
      if (g.rays) {
        co.globalAlpha = a * (dark ? .35 : .25); co.fillStyle = GOLD[0];
        for (let i = 0; i < 12; i++) { const t = i / 12 * TAU + k * .6; co.beginPath(); co.moveTo(cx, cy); co.arc(cx, cy, R * 1.5, t, t + .12); co.closePath(); co.fill(); }
      }
    };
    return {
      frame(t, dt) {
        chips.step(dt); dust.step(dt); leaves.step(dt);
        behind(env, () => {
          co.globalCompositeOperation = 'source-over';
          glows.run(dt, glow);
          dust.each((d, k) => dot(co, dark ? '#e7e5e4' : '#a8a29e', d.x, d.y, d.size * (1 + k), Math.sin(Math.PI * k) * (dark ? .25 : .3)));
          chips.each((c, k) => { co.globalAlpha = 1 - k * k; co.fillStyle = c.c; co.save(); co.translate(c.x, c.y); co.rotate(c.r + k * 8); co.fillRect(-c.size, -c.size * .6, c.size * 2, c.size * 1.2); co.restore(); });
        });
        co.globalCompositeOperation = 'source-over';
        wreaths.run(dt, wreath);
        leaves.each((l, k) => { co.globalAlpha = 1 - k; co.fillStyle = l.c; co.save(); co.translate(l.x + Math.sin(l.life * 4 + l.r) * card.h * .1, l.y); co.rotate(Math.sin(l.life * 3 + l.r)); co.beginPath(); co.ellipse(0, 0, l.size, l.size * .4, 0, 0, TAU); co.fill(); co.restore(); });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; chisel(p.x, p.y + card.h * .1, o.last ? .9 : .4); },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { dust.add({ x: cx, y: cy, vx: 0, vy: -10, drag: .5, g: 0, max: 1, size: card.h * .3 }); return; } // un peu de poussière
        glows.add({ life: 1 + p, a: .5 + .5 * p, rays: p >= 1 });
        if (p >= .6) wreaths.add({ delay: .1, life: 2.4 + p, s: p >= 1 ? 1.25 : 1 });
        if (p >= 1) for (let i = Math.round(24 * q); i > 0; i--) leaves.add({ x: cx + rnd(-.7, .7) * card.w, y: card.y - rnd(0, 1) * card.h, vx: rnd(-1, 1) * 8, vy: card.h * rnd(.4, .9), g: 0, drag: 0, max: rnd(1.8, 3), size: card.h * rnd(.05, .08), r: rnd(TAU), c: pick(GOLD) });
      },
    };
  };

  // 🍩 Polygon Donut (2026-10-21, idée de PongonLOLZFan) — un vrai donut 3D en peu de polygones : un tore de 18 × 8
  // facettes, éclairé à plat (une teinte par triangle), glaçage rose sur le dessus avec ses vermicelles, pâte dorée
  // dessous. Il tourne lentement derrière les chiffres (calque intérieur, en retrait), plus vite pendant le tirage, et
  // donne un petit à-coup à chaque chiffre posé. À la révélation, des vermicelles jaillissent des chiffres et rebondissent
  // sur le haut de la carte ; dès Mythic, une explosion de vermicelles et d'éclats triangulaires.
  SCENES.polydonut = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const U = 18, V = 8, RM = 1, RT = .42, TILT = 1.05; // segments, grand et petit rayon, inclinaison vers le spectateur
    const SPR = ['#f472b6', '#38bdf8', '#facc15', '#4ade80', '#a78bfa', '#ffffff', '#fb923c'];
    // maillage : sommets (u, v) et, pour chaque facette, si elle est glacée et ses vermicelles (fixes)
    const quads = [];
    for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
      const vm = (j + .5) / V * TAU, iced = Math.sin(vm) > -.25; // dessus du tore (côté +z local)
      quads.push({ i, j, iced, spr: iced && Math.random() < .55 ? { c: pick(SPR), a: rnd(TAU), s: rnd(.25, .75) } : null });
    }
    const L = (() => { const x = -.45, y = -.7, z = .55, n = Math.hypot(x, y, z); return [x / n, y / n, z / n]; })();
    let ang = 0, speed = .35, kick = 0;
    const vert = (i, j, rot) => {
      const u = i / U * TAU + rot, v = j / V * TAU;
      const x = (RM + RT * Math.cos(v)) * Math.cos(u), y = (RM + RT * Math.cos(v)) * Math.sin(u), z = RT * Math.sin(v);
      // incliné autour de l'axe horizontal : on voit le dessus glacé
      const c = Math.cos(TILT), s = Math.sin(TILT);
      return [x, y * c - z * s, y * s + z * c];
    };
    const shade = (base, l) => { const [r, g, b] = base; const k = .55 + .6 * l; return `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`; };
    const ICING = [244, 143, 190], DOUGH = [214, 160, 92];
    const donut = (c, cx, cy, sx, sy, rot, alpha) => {
      const tris = [];
      for (const qd of quads) {
        const { i, j } = qd, a = vert(i, j, rot), b = vert(i + 1, j, rot), d = vert(i, j + 1, rot), e = vert(i + 1, j + 1, rot);
        for (const [p0, p1, p2, half] of [[a, b, e, 0], [a, e, d, 1]]) {
          const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
          let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const n = Math.hypot(nx, ny, nz) || 1; nx /= n; ny /= n; nz /= n;
          if (nz < 0) continue; // face cachée (le spectateur regarde vers -z)
          const l = clamp(nx * L[0] + ny * L[1] + nz * L[2]) + (half ? .06 : 0);
          tris.push({ z: p0[2] + p1[2] + p2[2], p: [p0, p1, p2], col: shade(qd.iced ? ICING : DOUGH, l), spr: half ? null : qd.spr, l });
        }
      }
      tris.sort((m, n) => m.z - n.z);
      c.globalAlpha = alpha; c.lineJoin = 'round';
      for (const tr of tris) {
        c.fillStyle = tr.col; c.strokeStyle = tr.col; c.lineWidth = .8;
        c.beginPath(); tr.p.forEach(([x, y], k) => (k ? c.lineTo(cx + x * sx, cy + y * sy) : c.moveTo(cx + x * sx, cy + y * sy))); c.closePath(); c.fill(); c.stroke();
        if (tr.spr) { const [p0, p1, p2] = tr.p, mx = cx + (p0[0] + p1[0] + p2[0]) / 3 * sx, my = cy + (p0[1] + p1[1] + p2[1]) / 3 * sy, r = Math.min(sx, sy) * .07 * tr.spr.s; c.strokeStyle = tr.spr.c; c.lineWidth = Math.max(1, r * .7); c.lineCap = 'round'; c.beginPath(); c.moveTo(mx - Math.cos(tr.spr.a) * r, my - Math.sin(tr.spr.a) * r); c.lineTo(mx + Math.cos(tr.spr.a) * r, my + Math.sin(tr.spr.a) * r); c.stroke(); }
      }
      c.globalAlpha = 1;
    };
    const sprinkles = particles(), shards = particles(), flashes = timed();
    const sprinkle = (x, y, v0, big) => { const a = -Math.PI / 2 + rnd(-1.1, 1.1); const v = rnd(.6, 1) * v0; sprinkles.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 900, max: rnd(.9, 1.5), size: rnd(2.2, 3.6) * (big ? 1.3 : 1), c: pick(SPR), rot: rnd(TAU), vr: rnd(-14, 14), bounced: 0 }); };
    return {
      frame(t, dt) {
        kick = Math.max(0, kick - dt * 3);
        ang += (speed + kick * 3) * dt;
        // le donut, couché, tient dans la carte : large, aplati, derrière les chiffres
        donut(ci, w / 2, h * .55, w * .36, h * .62, ang, dark ? .7 : .62);
        // vermicelles : rebondissent sur le haut de la carte (une ou deux fois), en tournoyant
        sprinkles.step(dt);
        co.globalCompositeOperation = 'source-over';
        sprinkles.each((p, k) => {
          if (p.vy > 0 && p.y > card.y - 1 && p.x > card.x && p.x < card.x + card.w && p.bounced < 2) { p.y = card.y - 1; p.vy *= -.45; p.vx *= .7; p.vr *= .5; p.bounced++; }
          const r = p.rot + p.vr * p.life; co.globalAlpha = Math.min(1, (1 - k) * 4); co.strokeStyle = p.c; co.lineWidth = p.size; co.lineCap = 'round';
          co.beginPath(); co.moveTo(p.x - Math.cos(r) * p.size * 1.3, p.y - Math.sin(r) * p.size * 1.3); co.lineTo(p.x + Math.cos(r) * p.size * 1.3, p.y + Math.sin(r) * p.size * 1.3); co.stroke();
        });
        // éclats triangulaires (Mythic et mieux), à plat comme les facettes
        shards.step(dt);
        shards.each((p, k) => { const r = p.rot + p.vr * p.life, s = p.size; co.globalAlpha = (1 - k); co.fillStyle = p.c; co.beginPath(); for (let i = 0; i < 3; i++) { const a = r + i * TAU / 3; co[i ? 'lineTo' : 'moveTo'](p.x + Math.cos(a) * s, p.y + Math.sin(a) * s * Math.cos(p.life * 6)); } co.closePath(); co.fill(); });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        flashes.run(dt, (f, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = '#fff'; co.lineWidth = 2 * (1 - k) + .5; co.beginPath(); for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + f.r, rr = f.s * (.5 + outCubic(k)); co[i ? 'lineTo' : 'moveTo'](f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr); } co.closePath(); co.stroke(); });
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(p, o) {
        speed = Math.min(2.2, speed + .3); kick = 1;
        if (o.ghost) return;
        flashes.add({ x: p.x, y: p.y, s: card.h * (o.last ? .45 : .32), r: rnd(TAU), life: .35 });
        for (let i = Math.round((o.last ? 9 : 5) * q); i > 0; i--) sprinkle(p.x + rnd(-6, 6), card.y + 2, card.h * rnd(3.5, 5.5), false);
      },
      build() { speed = 2.6; },
      reveal(tier) {
        const p = POWER[tier] || 0;
        speed = .9 + p * .8; setTimeout(() => { speed = .35; }, 1400);
        if (!p) return;
        const big = p >= 1;
        for (let i = burst(p, (big ? 120 : 50) * q, 6); i > 0; i--) sprinkle(rnd(card.x, card.x + card.w), card.y + rnd(0, card.h * .3), card.h * rnd(5, 8 + 5 * p), big);
        if (big) {
          const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
          for (let i = Math.round(40 * q); i > 0; i--) { const a = rnd(TAU), v = rnd(200, 520); shards.add({ x: cx + Math.cos(a) * card.w * .3, y: cy + Math.sin(a) * card.h * .3, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .7, g: 380, drag: 1.4, max: rnd(.8, 1.4), size: rnd(4, 8), c: pick(['#f9a8d4', '#f472b6', '#fde68a', '#d6a05c', '#c4b5fd']), rot: rnd(TAU), vr: rnd(-8, 8) }); }
          for (let i = 0; i < 3; i++) flashes.add({ delay: i * .12, x: cx, y: cy, s: card.w * (.35 + i * .15), r: rnd(TAU), life: .6 });
        }
      },
    };
  };

  // 🔊 Sonic Wave (2026-10-21, idée de Matthew) — un oscilloscope. Dans la carte, sous les chiffres, deux ondes (cyan et
  // rose) courent et un égaliseur bat en bas : pendant le tirage elles s'agitent et grésillent, puis se calment. À chaque
  // chiffre posé, une impulsion part de sa position le long de l'onde et deux anneaux d'onde de choc s'en écartent. À
  // la révélation, un « bang » sonique : des anneaux concentriques autour de la carte et des barres d'égaliseur qui
  // jaillissent de ses bords ; dès Mythic, plus d'anneaux, un flash et des lignes de vitesse qui rayonnent.
  SCENES.sonic = env => {
    const { co, ci, w, h, card, q, dark } = env, rings = timed(), kicks = [], bars = timed(), rays = timed();
    const CY = '#22d3ee', PK = '#e879f9', WH = '#ecfeff';
    let energy = 1, aim = 1, flash = 0, now = 0;
    const eq = Array.from({ length: 18 }, () => ({ v: rnd(.2, .6), ph: rnd(TAU) }));
    const ring = (x, y, r, c, life, delay = 0, width = 2) => rings.add({ x, y, r, c, life, delay, width });
    return {
      frame(t, dt) {
        now = t;
        energy += (aim - energy) * Math.min(1, dt * 4);
        flash = Math.max(0, flash - dt * 3);
        // les impulsions des chiffres posés s'éloignent de leur point de départ le long de l'onde
        for (let i = kicks.length - 1; i >= 0; i--) { kicks[i].age += dt; if (kicks[i].age > 1.2) kicks.splice(i, 1); }
        const bump = x => { let s = 0; for (const k of kicks) { const d = Math.abs(x - k.x) - k.age * w * .9; s += k.a * Math.exp(-d * d / (h * h * .08)) * (1 - k.age / 1.2); } return s; };
        ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        // égaliseur : les barres montent avec l'énergie
        const n = eq.length, bw = w / n;
        for (let i = 0; i < n; i++) {
          const b = eq[i], lvl = clamp(.12 + energy * (.35 + .4 * Math.abs(Math.sin(t * (5 + i * .7) + b.ph))) * b.v * 1.6 + bump(bw * (i + .5)) * .6, 0, 1);
          ci.globalAlpha = .16 + .14 * energy; ci.fillStyle = i % 3 ? CY : PK;
          ci.fillRect(i * bw + bw * .18, h - lvl * h * .42, bw * .64, lvl * h * .42);
        }
        // deux ondes : l'amplitude suit l'énergie, un grésillement s'y ajoute pendant le tirage
        ci.lineJoin = 'round';
        for (let m = 0; m < 2; m++) {
          ci.globalAlpha = (.28 + .3 * Math.min(1, energy)) * (m ? .8 : 1); ci.strokeStyle = m ? PK : CY; ci.lineWidth = m ? 1.4 : 2;
          ci.shadowColor = m ? PK : CY; ci.shadowBlur = 6;
          ci.beginPath();
          for (let x = 0; x <= w; x += 3) {
            const amp = h * (.05 + .16 * energy), noise = energy > .5 ? (Math.random() - .5) * h * .07 * (energy - .5) : 0;
            const y = h * .5 + Math.sin(x / w * TAU * (m ? 3 : 2) - t * (m ? 7 : 5)) * amp * (m ? .7 : 1) + noise - bump(x) * h * .35 * (m ? -1 : 1);
            x ? ci.lineTo(x, y) : ci.moveTo(x, y);
          }
          ci.stroke();
        }
        ci.shadowBlur = 0;
        if (flash > 0) dot(ci, WH, w / 2, h / 2, w * .6, flash * .5, h);
        ci.globalCompositeOperation = 'source-over';
        // autour de la carte : anneaux d'onde de choc (aplatis comme sur un écran), barres et rayons du bang final
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        rings.run(dt, (r, k) => {
          const e = outCubic(k), R = r.r * (.25 + .9 * e);
          co.globalAlpha = (1 - k) * .9; co.strokeStyle = r.c; co.lineWidth = r.width * (1 - k) + .5; co.shadowColor = r.c; co.shadowBlur = 8;
          co.beginPath(); co.ellipse(r.x, r.y, R, R * .62, 0, 0, TAU); co.stroke();
        });
        co.shadowBlur = 0;
        bars.run(dt, (b, k) => {
          const up = k < .35 ? outCubic(k / .35) : 1 - (k - .35) / .65, L = b.len * up;
          co.globalAlpha = .85 * (1 - k * .6); co.fillStyle = b.c;
          if (b.side === 0) co.fillRect(b.x - b.bw / 2, card.y - L - 3, b.bw, L); else co.fillRect(b.x - b.bw / 2, card.y + card.h + 3, b.bw, L);
        });
        rays.run(dt, (r, k) => {
          const d0 = r.d * (.6 + 1.4 * outCubic(k)), d1 = d0 + r.len * (1 - k);
          line(co, r.c, r.x + Math.cos(r.a) * d0, r.y + Math.sin(r.a) * d0 * .7, r.x + Math.cos(r.a) * d1, r.y + Math.sin(r.a) * d1 * .7, 2, (1 - k) * .8);
        });
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(p, o) {
        if (o.ghost) return;
        kicks.push({ x: p.x - card.x, a: o.last ? 1 : .7, age: 0 });
        const big = !!o.last, r = card.h * (big ? 1.25 : .85);
        ring(p.x, p.y, r, CY, big ? .6 : .45, 0, big ? 3 : 2);
        ring(p.x, p.y, r * .8, PK, big ? .6 : .45, .06, big ? 2.4 : 1.6);
        aim = big ? .5 : Math.min(1.3, aim + .05);
      },
      build() { aim = 1.4; },
      reveal(tier) {
        const p = POWER[tier] || 0, cx = card.x + card.w / 2, cy = card.y + card.h / 2, strong = p >= 1;
        aim = .18; flash = .5 + .5 * p;
        energy = 1.2 + p;
        // le bang : des anneaux concentriques qui partent de la carte, de plus en plus larges
        const n = 2 + Math.round(3 * p) + (strong ? 2 : 0);
        for (let i = 0; i < n; i++) ring(cx, cy, card.w * (.7 + .5 * p) * (1 + i * .12), i % 2 ? PK : (i % 3 === 2 ? WH : CY), .7 + .4 * p, i * .09, 3 + 2 * p);
        // l'égaliseur jaillit des bords haut et bas de la carte
        if (p >= .25) {
          const m = Math.round((10 + 12 * p) * q);
          for (let i = 0; i < m; i++) for (const side of [0, 1]) bars.add({ side, x: card.x + card.w * (i + .5) / m, bw: card.w / m * .6, len: card.h * rnd(.25, .5 + .9 * p) * (side ? .7 : 1), c: i % 3 ? CY : PK, life: .6 + .5 * p, delay: .05 + Math.abs(i - m / 2) / m * .25 });
        }
        // dès Mythic : des lignes de vitesse rayonnent autour du bang
        if (strong) for (let i = Math.round(28 * q); i > 0; i--) rays.add({ x: cx, y: cy, a: rnd(TAU), d: card.w * .45, len: card.w * rnd(.15, .35), c: pick([CY, PK, WH]), life: rnd(.5, .8), delay: rnd(0, .2) });
      },
    };
  };

  // 🛸 UFO (2026-10-21, idée de JBearr12) — « une soucoupe qui dépose les chiffres sur l'herbe ». Une petite soucoupe
  // survole la carte (un champ la nuit). Pendant le tirage, elle se balade d'un bout à l'autre et son rayon clignote.
  // À chaque chiffre posé, elle file au-dessus de lui et l'éclaire d'un grand rayon vert (sous les chiffres dans la
  // carte, par-dessus au-dehors) ; une poussière d'herbe se soulève. À la révélation, ses feux clignotent, un dernier
  // rayon couvre toute la carte, puis elle s'envole en flèche ; dès Mythic, un tour de feux arc-en-ciel et des étincelles
  // d'abord. Elle revient se placer au-dessus de la carte quelques secondes plus tard.
  SCENES.ufo = env => {
    const { co, ci, card, q, dark } = env, beams = timed(), dust = particles(), sparks = particles(), trail = timed();
    const S = Math.max(30, card.h * .78); // largeur de la soucoupe
    const home = () => ({ x: card.x + card.w / 2, y: card.y - S * .62 });
    const u = { x: card.x + card.w / 2, y: card.y - S * .62, tx: card.x + card.w / 2, mode: 'roam', t: 0, vx: 0, vy: 0, lights: 0, rainbow: 0, a: 1 };
    let now = 0, flick = 0;
    const LIGHTS = ['#a3e635', '#facc15', '#f472b6', '#22d3ee'];
    const saucer = (x, y, a) => {
      co.save(); co.translate(x, y); co.globalAlpha = a; co.rotate(Math.sin(now * 2.1) * .06 + clamp(u.vx / 900, -.3, .3));
      // coupole de verre
      const g = co.createLinearGradient(0, -S * .45, 0, 0); g.addColorStop(0, 'rgba(165,243,252,.95)'); g.addColorStop(1, 'rgba(34,211,238,.55)');
      co.fillStyle = g; co.beginPath(); co.ellipse(0, -S * .08, S * .22, S * .26, 0, Math.PI, 0); co.fill();
      co.fillStyle = 'rgba(255,255,255,.75)'; co.beginPath(); co.ellipse(-S * .08, -S * .2, S * .04, S * .07, -.4, 0, TAU); co.fill();
      // coque métal
      const m = co.createLinearGradient(0, -S * .12, 0, S * .14); m.addColorStop(0, '#f8fafc'); m.addColorStop(.5, '#94a3b8'); m.addColorStop(1, '#334155');
      co.fillStyle = m; co.beginPath(); co.ellipse(0, 0, S * .5, S * .14, 0, 0, TAU); co.fill();
      co.strokeStyle = 'rgba(15,23,42,.6)'; co.lineWidth = 1; co.stroke();
      co.fillStyle = '#475569'; co.beginPath(); co.ellipse(0, S * .1, S * .2, S * .06, 0, 0, TAU); co.fill();
      // feux du bord : ils tournent, s'allument tous à la fin (et en arc-en-ciel dès Mythic)
      for (let i = 0; i < 7; i++) {
        const px = (i - 3) / 3.4 * S * .44, on = u.lights > 0 || ((Math.floor(now * 8) + i) % 3 === 0);
        const c = u.rainbow > 0 ? `hsl(${(now * 360 + i * 50) % 360} 95% 65%)` : LIGHTS[i % LIGHTS.length];
        co.fillStyle = on ? c : '#1e293b'; co.beginPath(); co.arc(px, S * .035, S * .035, 0, TAU); co.fill();
        if (on) dot(co, c.startsWith('#') ? c : '#ffffff', px, S * .035, S * .1, .5 * a);
      }
      co.globalAlpha = a; dot(co, '#bef264', 0, S * .14, S * .2, .45 * a, S * .08);
      co.restore();
    };
    // un rayon : un cône du dessous de la soucoupe jusqu'à `y1`, large de `half` en bas
    const cone = (c, x0, y0, x1, y1, half, a, col = '190,242,100') => {
      if (a <= .01) return;
      const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, `rgba(${col},${a * .35})`); g.addColorStop(1, `rgba(${col},${a})`);
      c.globalAlpha = 1; c.fillStyle = g; c.beginPath(); c.moveTo(x0 - S * .12, y0); c.lineTo(x0 + S * .12, y0); c.lineTo(x1 + half, y1); c.lineTo(x1 - half, y1); c.closePath(); c.fill();
    };
    return {
      frame(t, dt) {
        now = t; flick = Math.random();
        u.lights = Math.max(0, u.lights - dt); u.rainbow = Math.max(0, u.rainbow - dt);
        const H = home();
        if (u.mode === 'roam') { u.tx = card.x + card.w * (.5 + .38 * Math.sin(t * 1.1)); u.ty = H.y; }
        if (u.mode === 'hold') { u.ty = H.y; if ((u.t -= dt) <= 0) u.mode = 'roam'; }
        if (u.mode === 'rest') { u.tx = H.x + Math.sin(t * .7) * card.w * .08; u.ty = H.y; }
        if (u.mode === 'zip') { u.vx += 2600 * dt; u.vy -= 1500 * dt; u.x += u.vx * dt; u.y += u.vy * dt; if (Math.random() < .9) trail.add({ x: u.x, y: u.y, life: .35 }); if ((u.t -= dt) <= 0) { u.mode = 'back'; u.x = card.x - S * 3; u.y = card.y - S * 3; u.vx = u.vy = 0; } }
        else {
          const k = Math.min(1, dt * (u.mode === 'hold' ? 16 : 3)), ox = u.x;
          u.x += (u.tx - u.x) * k; u.y += ((u.ty ?? H.y) + Math.sin(t * 2.4) * S * .06 - u.y) * Math.min(1, dt * 4);
          u.vx = (u.x - ox) / Math.max(dt, 1e-3);
          if (u.mode === 'back') { u.tx = H.x; u.ty = H.y; if (Math.abs(u.x - H.x) < 4) u.mode = 'rest'; }
        }
        const bx = u.x, by = u.y + S * .12;
        // le rayon qui grésille pendant le tirage, sur la carte entière en dessous
        if (u.mode === 'roam') {
          const a = .1 + .14 * flick;
          cone(co, bx, by, bx, card.y, S * .32, a * (dark ? 1 : .8));
          ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          cone(ci, bx - card.x, by - card.y, bx - card.x, card.h, S * .5, a * .8);
        }
        // les grands rayons des chiffres posés (et celui de la fin)
        beams.run(dt, (b, k) => {
          const a = (k < .15 ? k / .15 : 1 - (k - .15) / .85) * (b.big ? .9 : .7), half = b.half * (1 + .2 * Math.sin(t * 40));
          cone(co, bx, by, b.x, card.y, half * .75, a * (dark ? .8 : .6));
          ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          cone(ci, bx - card.x, by - card.y, b.x - card.x, card.h, half, a * .75, '217,249,157');
          if (b.big) dot(ci, '#ecfccb', b.x - card.x, card.h * .5, card.w * .5, a * .35, card.h);
        });
        ci.globalCompositeOperation = 'source-over'; ci.globalAlpha = 1;
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        trail.run(dt, (s, k) => dot(co, '#bef264', s.x, s.y, S * .3 * (1 - k), (1 - k) * .7));
        sparks.step(dt);
        sparks.each((p, k) => dot(co, p.c, p.x, p.y, p.size * 2.4, (1 - k) * .9));
        co.globalCompositeOperation = 'source-over';
        // poussière d'herbe : de petits brins verts qui retombent au pied de la carte
        dust.step(dt);
        dust.each((p, k) => { co.globalAlpha = (1 - k) * .9; co.fillStyle = p.c; co.fillRect(p.x - p.size * .3, p.y - p.size, p.size * .6, p.size * 2); });
        co.globalAlpha = 1;
        if (u.mode !== 'zip' || u.t > 0) saucer(u.x, u.y, 1);
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        const big = !!o.last;
        u.mode = 'hold'; u.tx = p.x; u.t = big ? .9 : .45;
        beams.add({ x: p.x, half: card.h * (big ? .42 : .32), life: big ? .8 : .6, big });
        for (let i = Math.round((big ? 14 : 7) * q); i > 0; i--) { const a = rnd(-Math.PI * .9, -Math.PI * .1), v = rnd(60, big ? 220 : 150); dust.add({ x: p.x + rnd(-card.h * .2, card.h * .2), y: card.y + card.h - 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 520, drag: 1.2, max: rnd(.4, .8), size: rnd(1.6, 2.8), c: pick(['#22c55e', '#4ade80', '#a3e635', '#bbf7d0']) }); }
      },
      build() { u.lights = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, strong = p >= 1, cx = card.x + card.w / 2;
        u.mode = 'hold'; u.tx = cx; u.t = 9;
        u.lights = 1.4; if (strong) u.rainbow = 1.6;
        // le dernier rayon : toute la carte s'éclaire
        beams.add({ x: cx, half: card.w * .55, life: .7 + .4 * p, big: true, delay: .1 });
        // dès Mythic : un tour de feux, puis des étincelles en couronne autour de la soucoupe
        if (strong) setTimeout(() => { for (let i = Math.round(30 * q); i > 0; i--) { const a = rnd(TAU), v = rnd(80, 260); sparks.add({ x: u.x, y: u.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .6, drag: 1.8, max: rnd(.5, 1), size: rnd(1.2, 2.6), c: pick(['#bef264', '#f472b6', '#22d3ee', '#facc15']) }); } }, 500);
        else if (p > 0) for (let i = Math.round(10 * p * q); i > 0; i--) { const a = rnd(TAU), v = rnd(50, 150); sparks.add({ x: u.x, y: u.y + S * .1, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .5, drag: 2, max: rnd(.4, .7), size: rnd(1, 2), c: '#bef264' }); }
        // puis elle file en haut à droite, et revient plus tard
        setTimeout(() => { u.mode = 'zip'; u.vx = 80; u.vy = 40; u.t = 3 + p * 2; }, (strong ? 1300 : 900 + 300 * p));
      },
    };
  };

  // 🪟 Blinds (2026-10-21, idée de costoroll) — la fenêtre donne sur un jardin au soleil (le fond CSS de la carte). À chaque
  // chiffre posé, la lumière du soleil passe entre les lames : quelques rais jaunes horizontaux filent de part et d'autre
  // de la case, et une lueur néon s'allume dessus. À la révélation, un reflet de soleil. Dès Mythic, le canevas intérieur
  // reprend le paysage et le soleil se couche derrière la palissade (le ciel passe à l'orange puis à la nuit), la lune se
  // lève à gauche avec un halo doux et les étoiles s'allument ; la nuit reste jusqu'au tirage suivant.
  SCENES.blinds = env => {
    const { co, ci, w, h, card, dark, q } = env, rays = timed(), glints = timed();
    const DAY = [[29, 78, 216], [59, 130, 246], [147, 197, 253], [253, 227, 176]];
    const DUSK = [[67, 56, 202], [190, 75, 120], [249, 115, 22], [253, 186, 116]];
    const NIGHT = [[3, 7, 30], [15, 23, 66], [30, 41, 95], [55, 48, 107]];
    const mix = (a, b, k) => a.map((v, i) => Math.round(lerp(v, b[i], k)));
    const stars = Array.from({ length: Math.round(26 * q) + 6 }, () => ({ x: rnd(w), y: rnd(h * .62), r: rnd(.5, 1.3), ph: rnd(TAU) }));
    let set = -1, ascend = 0; // set : instant du début du coucher (secondes de la scène), -1 = jour
    let now = 0;
    const horizon = h * .84;
    const fence = (c, shade) => {
      // palissade et pelouse, redessinées par-dessus le soleil pour qu'il passe derrière
      const pw = Math.max(5, h * .1), top = h * .62;
      c.fillStyle = `rgb(${mix([245, 240, 225], [40, 44, 70], shade).join(',')})`;
      for (let x = -pw * .2; x < w; x += pw) { c.beginPath(); c.moveTo(x + pw * .1, horizon + 2); c.lineTo(x + pw * .1, top + pw * .4); c.lineTo(x + pw * .5, top); c.lineTo(x + pw * .9, top + pw * .4); c.lineTo(x + pw * .9, horizon + 2); c.fill(); }
      c.fillRect(0, top + (horizon - top) * .35, w, Math.max(1.5, h * .025));
      c.fillStyle = `rgb(${mix([63, 98, 18], [10, 30, 18], shade).join(',')})`;
      c.fillRect(0, horizon, w, h - horizon);
    };
    return {
      frame(t, dt) {
        now = t;
        // rais de soleil entre les lames, au dehors de la carte
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        rays.run(dt, (r, k) => {
          const a = (k < .2 ? k / .2 : 1 - (k - .2) / .8) * .8, len = card.h * (.6 + 1.8 * outCubic(k));
          for (let i = 0; i < 4; i++) {
            const y = r.y + (i - 1.5) * card.h * .14;
            tail(co, dark ? '#fde047' : '#ca8a04', r.x + r.dir * (card.w * .02 + len), y, r.x + r.dir * card.w * .02, y, 2, a * (1 - i * .15));
          }
          dot(co, '#facc15', r.x, r.y, card.h * .5 * (1 - k * .5), a * .5);
        });
        glints.run(dt, (g, k) => { const a = Math.sin(Math.PI * k); godrays(co, dark ? '#fde68a' : '#d97706', g.x, g.y, 10, card.h * .1, card.h * (.5 + g.p), t * .4, 3, a * (.35 + .4 * g.p)); dot(co, '#fffbeb', g.x, g.y, card.h * (.3 + .3 * g.p), a * .7); });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
        if (set < 0) return;
        // le coucher : 0 → 1 en 3,6 s (jour → crépuscule → nuit)
        const u = clamp((t - set) / 3.6), fadeIn = clamp((t - set) / .25);
        const dusk = clamp(u / .45), night = clamp((u - .4) / .6);
        const pal = DAY.map((c, i) => mix(mix(c, DUSK[i], dusk), NIGHT[i], night));
        ci.globalAlpha = fadeIn;
        const g = ci.createLinearGradient(0, 0, 0, horizon);
        pal.forEach((c, i) => g.addColorStop([0, .45, .78, 1][i], `rgb(${c.join(',')})`));
        ci.fillStyle = g; ci.fillRect(0, 0, w, h);
        // étoiles qui s'allument (plus nombreuses au-delà de Mythic)
        for (const s of stars) { const a = night * (.5 + .5 * Math.sin(t * 2 + s.ph)) * fadeIn; if (a > .02) { ci.globalAlpha = a; ci.fillStyle = '#fff'; ci.fillRect(s.x, s.y, s.r * (1 + ascend * .3), s.r * (1 + ascend * .3)); } }
        ci.globalAlpha = fadeIn;
        // le soleil descend derrière la palissade en rougissant
        const R = h * .16, sx = w * .8, sy = lerp(h * .3, horizon + R * 1.6, Math.pow(u, 1.3));
        const sun = mix([255, 251, 235], [251, 113, 60], dusk);
        dot(ci, '#fb923c', sx, sy, R * 4, (1 - night) * .55 * fadeIn);
        ci.globalAlpha = fadeIn; ci.fillStyle = `rgb(${sun.join(',')})`; ci.beginPath(); ci.arc(sx, sy, R, 0, TAU); ci.fill();
        // la lune se lève à gauche, avec un halo qui respire
        const m = clamp((u - .35) / .65), mx = w * .065, my = lerp(horizon + R * 1.6, h * .28, outCubic(m));
        if (m > 0) {
          dot(ci, '#e0e7ff', mx, my, R * (3.6 + .4 * Math.sin(t * 1.6)) * (1 + ascend * .25), .8 * m * fadeIn);
          ci.globalAlpha = fadeIn; ci.fillStyle = '#f8fafc'; ci.beginPath(); ci.arc(mx, my, R * .9, 0, TAU); ci.fill();
          ci.fillStyle = 'rgba(148,163,184,.45)'; ci.beginPath(); ci.arc(mx - R * .25, my - R * .2, R * .18, 0, TAU); ci.arc(mx + R * .3, my + R * .25, R * .13, 0, TAU); ci.fill();
        }
        fence(ci, night * .85 + dusk * .15);
        ci.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        rays.add({ x: p.x, y: p.y, dir: -1, life: o.last ? .7 : .5 });
        rays.add({ x: p.x, y: p.y, dir: 1, life: o.last ? .7 : .5 });
      },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (p > 0) glints.add({ x: card.x + card.w * .8, y: card.y + card.h * .3, p, life: .9 + .6 * p, delay: .05 });
        if (p >= 1) { set = now + .4; ascend = ASCEND[tier] || 0; }
      },
    };
  };

  // Deux scènes jouées ensemble : celle du skin (s'il en a une), puis la signature par-dessus.
  const both = (a, b) => ({ frame(t, dt) { if (a) a.frame(t, dt); b.frame(t, dt); }, lock(p, o) { if (a) a.lock(p, o); b.lock(p, o); }, build(ms) { if (a) a.build(ms); b.build(ms); }, reveal(tier) { if (a) a.reveal(tier); b.reveal(tier); } });

  // ---------------------------------------------------------------- montage sur une carte
  // Mouvement réduit du système, ou mode performance du jeu (classe perf sur <html>) : pas de scène.
  const reduced = () => !!((root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) || (root.document && root.document.documentElement.classList.contains('perf')));
  // 💗 Supporter — un cœur qui bat. La ligne de pouls court dans la carte et accélère à chaque chiffre posé ; chaque
  // chiffre est un battement (double onde corail, quelques cœurs qui s'envolent) ; avant le dernier le pouls s'emballe ;
  // la révélation est une grande onde autour de la carte et une envolée de cœurs. Tirage raté : la ligne devient plate.
  // 🎣 Fisherman (collab Canne & Dauphins) : le pêcheur de Firetail, debout sur un bout de ponton à gauche de la carte,
  // pêche les chiffres. Son leurre flotte sur l'eau de la carte ; à chaque chiffre posé, il ferre : le fil part jusqu'au
  // chiffre et revient, avec une éclaboussure de pixels. À la révélation, un dauphin saute par-dessus la carte (bleu,
  // rose, puis rouge pour les tirages rares). Sprites et palettes de son jeu (js/fishing.js), agrandis sans flou.
  SCENES.fisher = env => {
    const { co, card } = env, SP = root.RNGFishing && root.RNGFishing.sprites ? root.RNGFishing.sprites() : null;
    if (!SP) return { frame() {} };
    const k = Math.max(2, Math.round(card.h / 22)), snapk = v => Math.round(v / k) * k;
    const water = card.y + card.h * .57, feet = card.y + card.h; // la ligne d'eau de la carte, le dessus du ponton
    const man = { x: snapk(card.x - 30 * k), y: snapk(feet - 16 * k) };
    const hand = { x: man.x + 13 * k, y: man.y + 8 * k };
    const restTip = { x: Math.min(hand.x + 14 * k, card.x - 3 * k), y: hand.y - 12 * k };
    // Au repos, le leurre pend au bout de la canne, hors de la carte : il ne cache jamais un chiffre.
    const lureRest = () => ({ x: restTip.x - k, y: restTip.y + 9 * k });
    const hooks = [], drops = [], jumps = [];
    let bend = 0, jolt = 0;
    const px = (x, y, w, h, c) => { co.fillStyle = c; co.fillRect(Math.round(x), Math.round(y), w, h); };
    const line = (x0, y0, x1, y1, c) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / k)); co.fillStyle = c; for (let i = 0; i <= n; i++) co.fillRect(snapk(x0 + (x1 - x0) * i / n), snapk(y0 + (y1 - y0) * i / n), k, k); };
    const sprite = (img, x, y, flip, rot) => { co.save(); co.translate(Math.round(x), Math.round(y)); if (rot) co.rotate(rot); if (flip) co.scale(-1, 1); co.drawImage(img, -img.width * k / 2, -img.height * k / 2, img.width * k, img.height * k); co.restore(); };
    const splash = (x, y, n, cols) => { for (let i = 0; i < n; i++) drops.push({ x, y, vx: rnd(-90, 90) * k / 3, vy: -rnd(60, 160) * k / 3, l: rnd(.5, .9), c: pick(cols) }); };
    const WATER_COLS = ['#d8f1ff', '#ffffff', '#4aa8e8'];
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over'; co.imageSmoothingEnabled = false;
        bend = Math.max(0, bend - dt * 3); jolt = Math.max(0, jolt - dt * 4);
        // ponton (planches de son jeu) sous le pêcheur
        for (let x = man.x - 14 * k; x < card.x - 2 * k; x += 16 * k) co.drawImage(SP.plank, snapk(x), snapk(feet), 16 * k, 16 * k);
        for (const x of [man.x - 8 * k, man.x + 8 * k]) px(snapk(x), feet + 5 * k, 3 * k, 10 * k, '#5a3418');
        // pêcheur : respire au repos, sursaute quand il ferre
        const bob = jolt > .3 ? -k : (Math.floor(t * 1.4) % 2) * k;
        co.drawImage(jolt > .3 ? SP.jump : SP.man, man.x - 8 * k + 8 * k, man.y + bob, 16 * k, 16 * k);
        const tip = { x: restTip.x - bend * 4 * k, y: restTip.y + bend * 9 * k };
        line(hand.x, hand.y + bob, tip.x, tip.y + bob, '#8a5a2b');
        px(tip.x, tip.y + bob, k, k, '#ffe0a0');
        // le fil : vers le leurre qui flotte, ou vers le chiffre qu'il vient de ferrer
        const h = hooks[hooks.length - 1];
        let lx, ly;
        if (h) {
          h.t += dt; const u = Math.min(1, h.t / .5), go = u < .3 ? u / .3 : 1 - (u - .3) / .7, rest = lureRest();
          lx = rest.x + (h.x - rest.x) * go; ly = rest.y + (h.y - rest.y) * go - Math.sin(Math.PI * go) * 6 * k;
          if (u >= 1) hooks.pop();
        } else { const rest = lureRest(); lx = rest.x + Math.round(Math.sin(t * 1.6)) * k; ly = rest.y; }
        line(tip.x, tip.y + bob, lx, ly, '#f4f7ff');
        co.drawImage(SP.lure, snapk(lx) - 4 * k, snapk(ly) - 3 * k, SP.lure.width * k, SP.lure.height * k);
        // dauphins qui sautent par-dessus la carte
        for (let i = jumps.length - 1; i >= 0; i--) {
          const j = jumps[i]; j.t += dt; const u = j.t / j.d;
          if (u < 0) continue;
          if (u >= 1) { splash(j.x1, water, 12, WATER_COLS); jumps.splice(i, 1); continue; }
          if (!j.out) { j.out = true; splash(j.x0, water, 12, WATER_COLS); }
          const x = j.x0 + (j.x1 - j.x0) * u, y = water - Math.sin(Math.PI * u) * j.hgt, ang = Math.atan2(-Math.cos(Math.PI * u) * j.hgt * Math.PI, j.x1 - j.x0);
          sprite(SP.dol[j.kind], x, y, false, ang);
        }
        // éclaboussures en blocs de pixels
        for (let i = drops.length - 1; i >= 0; i--) { const d = drops[i]; d.vy += 420 * k / 3 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.l -= dt * 1.5; if (d.l <= 0) { drops.splice(i, 1); continue; } co.globalAlpha = Math.min(1, d.l * 2); px(snapk(d.x), snapk(d.y), k, k, d.c); }
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o && o.ghost) return; // zéro de tête : pas de prise
        hooks.length = 0; hooks.push({ x: p.x, y: p.y, t: 0 }); bend = 1; jolt = .5;
        setTimeout(() => splash(p.x, p.y, 10, WATER_COLS), 150);
      },
      reveal(tier) {
        const pw = POWER[tier] || 0, kind = pw > .55 ? 'red' : pw > .25 ? 'pink' : 'blue';
        for (let i = 0, n = 1 + (pw > .4 ? 1 : 0) + (pw > .75 ? 1 : 0); i < n; i++) {
          const flip = i % 2 === 1;
          jumps.push({ t: -i * .35, d: .9 + rnd(0, .2), x0: flip ? card.x + card.w * .95 : card.x + card.w * .05, x1: flip ? card.x + card.w * .05 : card.x + card.w * .95, hgt: card.h * rnd(.7, 1), kind });
        }
      },
    };
  };
  // ☁️ Sky (idée de Deadshot) : de gros cumulus dérivent au-dessus et au-dessous de la carte. Chaque chiffre posé lâche
  // une petite bouffée de nuage ; à la révélation, les nuages gonflent. Mythique ou mieux : ils prennent la couleur de la
  // rareté (rose, cyan, or, arc-en-ciel pour Infini) et la gardent jusqu'au tirage suivant.
  SCENES.sky = env => {
    const { co, ci, w, h, card, W, dark } = env;
    const TINT = { mythic: [244, 114, 182], celestial: [103, 232, 249], divine: [253, 224, 71] };
    const k = Math.min(1.3, card.h / 60);
    // Nuages au-dessus de la carte (ils dérivent et font le tour) et un de chaque côté (ils flottent sur place) : jamais
    // en dessous, où s'affichent la rareté et l'XP.
    const mk = (x, y, s, v, side) => ({ x, y, s, v, side, x0: x, ph: rnd(TAU), puffs: Array.from({ length: 5 }, (_, j) => ({ dx: (j - 2) * 11, dy: -(j % 2) * 6 - (j === 2 ? 4 : 0), r: 10 + (j === 2 ? 6 : j % 2 ? 3 : 0) })) });
    const clouds = [
      ...Array.from({ length: 4 }, (_, i) => mk(rnd(0, W), card.y - rnd(20, 48) * k, rnd(.8, 1.3) * k, rnd(6, 12) * (i % 2 ? 1 : -1), false)),
      mk(card.x - 46 * k, card.y + card.h * .45, 1.05 * k, 0, true), mk(card.x + card.w + 46 * k, card.y + card.h * .4, .95 * k, 0, true),
    ];
    const puffs = timed();
    let swell = 0, tint = null, tintK = 0, rainbow = false;
    const tintOf = (t, m, a) => {
      if (rainbow) return `hsla(${(t * 60) % 360}, 90%, ${Math.round(74 + 14 * m)}%, ${a})`;
      const [r, g, b] = tint;
      return `rgba(${Math.round(r + (255 - r) * m)}, ${Math.round(g + (255 - g) * m)}, ${Math.round(b + (255 - b) * m)}, ${a})`;
    };
    const cloud = (c, t) => {
      const sc = c.s * (1 + swell * .18);
      for (const [pass, col] of [[0, dark ? 'rgba(150,175,205,.55)' : 'rgba(169,191,214,.7)'], [1, 'rgba(255,255,255,.95)']]) {
        co.fillStyle = col; co.beginPath();
        for (const p of c.puffs) co.arc(c.x + p.dx * sc, c.y + p.dy * sc + (pass ? 0 : 4 * sc), p.r * sc, 0, TAU);
        co.fill();
        if (tintK > 0) { co.fillStyle = tintOf(t, pass ? .55 : .2, tintK * .85); co.fill(); }
      }
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        swell = Math.max(0, swell - dt * 1.2);
        if (tint || rainbow) tintK = Math.min(1, tintK + dt * 1.2);
        // Le ciel de la carte prend la couleur de la rareté (calque intérieur, sous les chiffres).
        if (tintK > 0) {
          const g = ci.createLinearGradient(0, 0, 0, h);
          g.addColorStop(0, tintOf(t, 0, .85 * tintK)); g.addColorStop(.6, tintOf(t, .35, .7 * tintK)); g.addColorStop(1, tintOf(t, .8, .55 * tintK));
          ci.fillStyle = g; ci.fillRect(0, 0, w, h);
        }
        for (const c of clouds) {
          if (c.side) c.y += Math.sin(t * .9 + c.ph) * .15;
          else { c.x += c.v * dt; if (c.x > W + 60) c.x = -60; if (c.x < -60) c.x = W + 60; }
          cloud(c, t);
        }
        puffs.run(dt, (p, kk) => { co.globalAlpha = (1 - kk) * .9; co.fillStyle = tintK > 0 ? tintOf(t, .7, 1) : '#ffffff'; for (let i = 0; i < 3; i++) { co.beginPath(); co.arc(p.x + (i - 1) * 7 * k * (1 + kk), p.y - kk * 14 * k - (i === 1 ? 4 * k : 0), (5 + 7 * kk) * k, 0, TAU); co.fill(); } co.globalAlpha = 1; });
      },
      // Chaque chiffre posé lâche une bouffée qui monte au-dessus de la carte.
      lock(p, o) { if (!o || !o.ghost) puffs.add({ x: p.x, y: card.y + 4 * k, life: .6 }); },
      reveal(tier) {
        swell = 1;
        if (tier === 'infinite') rainbow = true; else if (TINT[tier]) tint = TINT[tier];
        for (let i = 0; i < 4 + Math.round(6 * (POWER[tier] || 0)); i++) puffs.add({ delay: i * .07, x: rnd(card.x, card.x + card.w), y: card.y - rnd(0, 10) * k, life: .8 });
      },
    };
  };

  // 🃏 Deck (idée de GamblrGod) : un paquet posé à gauche de la carte. À chaque chiffre posé, une carte part du paquet et
  // vole jusqu'à sa place en tournant ; à la révélation, une cascade de cartes rebondit (plus le tirage est rare, plus il y
  // en a, comme la fin d'une partie de Solitaire).
  SCENES.cards = env => {
    const { co, card, W, H } = env;
    const k = Math.min(1.3, card.h / 60), cw = 22 * k, ch = 31 * k;
    const deck = { x: card.x - 34 * k, y: card.y + card.h * .5 };
    const flying = timed(), cascade = [];
    const back = (x, y, rot, a) => {
      co.save(); co.translate(x, y); co.rotate(rot); co.globalAlpha = a;
      co.fillStyle = '#ffffff'; co.beginPath(); co.roundRect(-cw / 2, -ch / 2, cw, ch, 3 * k); co.fill();
      co.fillStyle = '#dc2626'; co.beginPath(); co.roundRect(-cw / 2 + 2 * k, -ch / 2 + 2 * k, cw - 4 * k, ch - 4 * k, 2 * k); co.fill();
      co.clip(); // les croisillons restent dans le dos de la carte
      co.strokeStyle = 'rgba(255,255,255,.45)'; co.lineWidth = 1;
      for (let i = -ch; i < ch; i += 4 * k) { co.beginPath(); co.moveTo(-cw / 2 + 2 * k, i); co.lineTo(cw / 2 - 2 * k, i + cw); co.stroke(); }
      co.restore();
    };
    const face = (x, y, rot, suit, red) => {
      co.save(); co.translate(x, y); co.rotate(rot);
      co.fillStyle = '#ffffff'; co.shadowColor = 'rgba(0,0,0,.4)'; co.shadowBlur = 4; co.beginPath(); co.roundRect(-cw / 2, -ch / 2, cw, ch, 3 * k); co.fill(); co.shadowBlur = 0;
      co.fillStyle = red ? '#dc2626' : '#111827'; co.font = `${Math.round(14 * k)}px Georgia, serif`; co.textAlign = 'center'; co.textBaseline = 'middle'; co.fillText(suit, 0, 1);
      co.restore();
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        for (let i = 4; i >= 0; i--) back(deck.x + i * .8 * k, deck.y - i * 1.2 * k, -.06, 1); // le paquet
        flying.run(dt, (f, kk) => { const e = 1 - Math.pow(1 - kk, 3); back(deck.x + (f.x - deck.x) * e, deck.y + (f.y - deck.y) * e - Math.sin(Math.PI * kk) * 30 * k, -.06 + kk * TAU * .75, 1 - Math.max(0, kk - .8) * 5); });
        for (let i = cascade.length - 1; i >= 0; i--) {
          const c = cascade[i];
          if ((c.wait -= dt) > 0) continue;
          c.vy += 900 * k * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.spin * dt;
          if (c.y > card.y + card.h + 40 * k && c.vy > 0 && c.b < 2) { c.vy *= -.55; c.b++; }
          if (c.y > H + 40 || c.x < -40 || c.x > W + 40) { cascade.splice(i, 1); continue; }
          // la traînée des cartes du Solitaire
          face(c.x, c.y, c.rot, c.suit, c.red);
        }
      },
      lock(p, o) { if (!o || !o.ghost) flying.add({ x: p.x, y: p.y, life: .32 }); },
      reveal(tier) {
        const pw = POWER[tier] || 0, n = pw >= .42 ? Math.round(4 + 14 * pw) : 0;
        for (let i = 0; i < n; i++) { const suit = '♠♥♣♦'[i % 4]; cascade.push({ wait: i * .06, x: deck.x, y: deck.y, vx: rnd(120, 420) * k * (i % 3 === 2 ? -.4 : 1), vy: -rnd(200, 420) * k, rot: 0, spin: rnd(-6, 6), b: 0, suit, red: suit === '♥' || suit === '♦' }); }
      },
    };
  };

  SCENES.supporter = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const CORAL = '#fb7185', ROSE = '#fda4af', GOLD = '#fde68a', DEEP = '#e11d48';
    const TONES = dark ? [CORAL, ROSE, GOLD, '#ffffff'] : [DEEP, CORAL, '#f59e0b', ROSE];
    const hearts = particles(), sparks = particles(), rings = timed(), flashes = timed();
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, dk = dark ? 1 : .75;
    // Tracé d'un battement sur un cycle (0 à 1) : onde P, pointe QRS, onde T.
    const ECG = [[0, 0], [.3, 0], [.33, .12], [.36, 0], [.4, 0], [.425, -.15], [.455, 1], [.49, -.32], [.52, 0], [.62, 0], [.68, .22], [.74, 0], [1, 0]];
    const ecg = u => { for (let i = 1; i < ECG.length; i++) if (u <= ECG[i][0]) { const [x0, y0] = ECG[i - 1], [x1, y1] = ECG[i]; return y0 + (y1 - y0) * ((u - x0) / (x1 - x0 || 1)); } return 0; };
    let bpm = 64, target = 64, travel = 0, phase = 0, amp = 1, ampTo = 1, lit = 0, surge = 0;
    const heart = (c, x, y, s, color, a, rot) => {
      if (a <= .01 || s <= .3) return;
      c.save(); c.translate(x, y); c.rotate(rot); c.globalAlpha = Math.min(1, a); c.fillStyle = color;
      c.beginPath(); c.moveTo(0, s * .9); c.bezierCurveTo(-s * 1.5, -s * .2, -s * .75, -s * 1.25, 0, -s * .45); c.bezierCurveTo(s * .75, -s * 1.25, s * 1.5, -s * .2, 0, s * .9); c.fill();
      c.globalAlpha = Math.min(1, a * .55); c.fillStyle = '#ffffff'; c.beginPath(); c.ellipse(-s * .42, -s * .42, s * .2, s * .13, -.6, 0, TAU); c.fill();
      c.restore();
    };
    const fly = (x, y, vx, vy, size) => hearts.add({ x, y, vx, vy, g: -26, drag: 1.3, max: rnd(.9, 1.7), size, c: pick(TONES), rot: rnd(-.45, .45), spin: rnd(-.6, .6), wob: rnd(3, 6), ph: rnd(TAU), sway: rnd(3, 9) });
    return {
      frame(t, dt) {
        bpm += (target - bpm) * Math.min(1, dt * 2.4);
        amp += (ampTo - amp) * Math.min(1, dt * 5);
        travel += dt * bpm / 60;
        phase = travel % 1;
        surge = Math.max(0, surge - dt * .9);
        // Enveloppe du battement : « boum », puis « boum » un peu plus faible.
        const pulse = d => (d >= 0 && d < .5 ? Math.exp(-d * 11) : 0);
        const beat = amp * Math.max(pulse(phase), .7 * pulse(phase - .19));
        // Dans la carte : lueur qui respire au rythme du cœur, et la ligne de pouls qui défile.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, CORAL, w * .5, h * .55, w * .58, (.1 + .3 * lit) * (.55 + .9 * beat) + surge * .35);
        flashes.run(dt, (f, k) => dot(ci, f.c, f.x, h * .5, h * (.5 + .9 * outExpo(k)), (1 - k) * (1 - k) * f.a));
        ci.lineCap = ci.lineJoin = 'round';
        const base = h * .8, tall = h * .3 * amp, cycles = 1.5; // sous les chiffres : seule la pointe monte derrière eux
        for (const [width, alpha, color] of [[5, .14, CORAL], [1.6, .6, dark ? ROSE : CORAL]]) {
          ci.globalAlpha = alpha * (.55 + .45 * Math.min(1, lit + .4)); ci.strokeStyle = color; ci.lineWidth = width;
          ci.beginPath();
          for (let x = -2; x <= w + 2; x += 2.5) { const u = (((x / w) * cycles - travel) % 1 + 1) % 1, y = base - ecg(u) * tall; x < 0 ? ci.moveTo(x, y) : ci.lineTo(x, y); }
          ci.stroke();
        }
        // Autour : un halo qui bat avec la carte et un liseré qui gonfle à chaque battement.
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        dot(co, CORAL, cx, cy, card.w * (.66 + .1 * beat + .25 * surge), (.07 + .13 * beat * (.4 + lit) + surge * .22) * dk);
        if (beat > .03) { const g = grown(card, 2 + 7 * beat); roundRect(co, g.x, g.y, g.w, g.h, g.r); co.globalAlpha = Math.min(1, beat * (.25 + .5 * lit)) * dk; co.strokeStyle = dark ? ROSE : CORAL; co.lineWidth = 1 + 2.5 * beat; co.stroke(); }
        rings.run(dt, (r, k) => {
          const a = (1 - k) * (1 - k) * r.a * dk;
          co.globalAlpha = Math.min(1, a); co.strokeStyle = r.c; co.lineWidth = r.width * (1 - .6 * k) + .5;
          if (r.card) { const g = grown(card, 4 + r.size * outCubic(k)); roundRect(co, g.x, g.y, g.w, g.h, g.r); } else { co.beginPath(); co.arc(r.x, r.y, 4 + r.size * outCubic(k), 0, TAU); }
          co.stroke();
        });
        co.globalCompositeOperation = 'source-over';
        sparks.step(dt);
        sparks.each((s, k) => dot(co, s.c, s.x, s.y, s.size * (1 - .5 * k), (1 - k * k) * dk));
        hearts.step(dt);
        hearts.each((p, k) => heart(co, p.x + Math.sin(p.life * p.wob + p.ph) * p.sway, p.y, p.size * (k < .12 ? .3 + .7 * (k / .12) : 1 - .25 * k), p.c, k < .7 ? 1 : 1 - (k - .7) / .3, p.rot + p.spin * p.life));
      },
      lock(p, o) { // un battement : le pouls repart de ce chiffre, double onde, quelques cœurs
        lit = Math.min(1, lit + (o.ghost ? .03 : 1 / 6));
        target = Math.min(150, target + (o.ghost ? 3 : 11));
        travel = Math.floor(travel) + .43; // la pointe du tracé tombe sur cet instant
        const big = o.last ? 1.5 : 1;
        flashes.add({ x: p.x - card.x, life: o.last ? .55 : .38, a: o.ghost ? .25 : .75, c: CORAL });
        if (!o.ghost) {
          rings.add({ x: p.x, y: p.y, size: card.h * .7 * big, life: .55, a: 1, width: 3.6, c: dark ? ROSE : CORAL });
          rings.add({ x: p.x, y: p.y, size: card.h * .5 * big, life: .5, a: .85, width: 2.6, c: dark ? GOLD : DEEP, delay: .15 });
        }
        for (let i = Math.round((o.ghost ? 1 : o.last ? 13 : 6) * q); i > 0; i--) fly(p.x + rnd(-11, 11), p.y - card.h * .22, rnd(-60, 60), rnd(-210, -90) * (o.last ? 1.25 : 1), rnd(6.5, 10.5) * (o.last ? 1.3 : 1));
        for (let i = Math.round((o.ghost ? 0 : 5) * q); i > 0; i--) { const a = rnd(TAU), v = rnd(50, 150); sparks.add({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 3, max: rnd(.3, .6), size: rnd(2, 4), c: pick([GOLD, ROSE]) }); }
        if (o.last) { surge = .7; lit = 1; }
      },
      build() { target = 172; }, // le cœur s'emballe avant le dernier chiffre
      reveal(tier) {
        const p = POWER[tier];
        if (!p) { ampTo = .04; target = 40; lit = .25; surge = 0; fly(cx, card.y, rnd(-10, 10), -40, 5); return; } // tirage raté : la ligne devient plate
        surge = .3 + .7 * p;
        target = 66 + 26 * p;
        travel = Math.floor(travel) + .43;
        for (let i = 0; i < 1 + Math.round(2 * p); i++) rings.add({ card: true, size: 26 + 120 * p - 14 * i, life: .7 + .6 * p, a: .9 - .15 * i, width: 3 + 2 * p, c: i % 2 ? (dark ? GOLD : DEEP) : (dark ? ROSE : CORAL), delay: i * .17 });
        for (let i = burst(p, 64 * q, 3); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, (from.x - cx) * .7), v = rnd(60, 150 + 250 * p); fly(from.x, from.y, Math.cos(a) * v, Math.sin(a) * v - rnd(30, 120), rnd(4.5, 7 + 6 * p)); }
        for (let i = burst(p, 90 * q, 4); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.6, .6), v = rnd(70, 200 + 320 * p); sparks.add({ x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 120, drag: 1.6, max: rnd(.5, 1.2), size: rnd(2, 4.5), c: pick([GOLD, ROSE, '#ffffff']) }); }
      },
    };
  };

  function mount(stage, card, skin, o = {}) {
    try {
      const make = SCENES[skin];
      if ((!make && !o.owner) || !stage || !card || reduced()) return null;
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const cw = card.offsetWidth, ch = card.offsetHeight, w = card.clientWidth, h = card.clientHeight;
      if (!cw || !ch) return null;
      const mx = Math.round(clamp(cw * .75, 130, 250)), my = Math.round(Math.max(130, ch * 1.7));
      const W = cw + 2 * mx, H = ch + 2 * my;
      const layer = (cls, width, height) => {
        const c = document.createElement('canvas');
        c.className = cls;
        c.setAttribute('aria-hidden', 'true');
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
        const x = c.getContext('2d');
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
        return [c, x];
      };
      const [inner, ci] = layer('skin-fx-in', w, h), [outer, co] = layer('skin-fx-out', W, H);
      card.prepend(inner);
      card.classList.add('has-fx');
      Object.assign(outer.style, { left: `${card.offsetLeft - mx}px`, top: `${card.offsetTop - my}px`, width: `${W}px`, height: `${H}px` });
      stage.appendChild(outer);
      const env = {
        ci, co, w, h, W, H, card: { x: mx, y: my, w: cw, h: ch, r: parseFloat(getComputedStyle(card).borderTopLeftRadius) || 10 },
        dark: document.documentElement.classList.contains('dark'), q: (root.innerWidth < 720 ? .65 : 1) * (o.q || 1), // o.q : scène allégée (duel à plusieurs)
        el: card, // la carte elle-même : une scène peut suivre ses classes (Burger attend le retrait de .charging)
      };
      const scene = o.owner ? both(make ? make(env) : null, OWNER(env)) : make(env);
      // Bords du calque extérieur fondus : un rayon ou une particule qui sort du calque s'efface au lieu d'être coupé net
      // (les rayons de Galaxy laissaient une colonne de traits sur le bord droit, signalé par un joueur le 2026-10-15).
      const FADE = Math.min(40, mx * .3, my * .3);
      const fades = [[0, 0, FADE, 0, 0, 0, FADE, H], [W, 0, W - FADE, 0, W - FADE, 0, FADE, H], [0, 0, 0, FADE, 0, 0, W, FADE], [0, H, 0, H - FADE, 0, H - FADE, W, FADE]].map(([x0, y0, x1, y1, rx, ry, rw, rh]) => {
        const gr = co.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        return [gr, rx, ry, rw, rh];
      });
      const fadeEdges = () => { co.save(); co.globalAlpha = 1; co.globalCompositeOperation = 'destination-out'; for (const [gr, x, y, fw, fh] of fades) { co.fillStyle = gr; co.fillRect(x, y, fw, fh); } co.restore(); };
      let t = 0, last = 0, raf = 0, stopped = false, restSince = Infinity, skip = 0, owed = 0, lastLeft = null;
      const frame = now => {
        if (stopped || !outer.isConnected) return;
        raf = requestAnimationFrame(frame);
        const dt = Math.min(.05, last ? (now - last) / 1000 : 0);
        last = now;
        // La carte rétrécit quand les zéros de tête s'effacent et se recentre : le calque d'effets la suit, sinon l'anneau
        // de Singularity restait centré sur 6 chiffres et débordait d'un seul côté (signalé par A Dude, 2026-10-18).
        const left = card.offsetLeft + card.offsetWidth / 2 - W / 2;
        if (left !== lastLeft) { outer.style.left = `${left}px`; lastLeft = left; }
        // … et les scènes connaissent sa vraie largeur : l'anneau, l'aura et les points suivent le nombre plus court au
        // lieu de garder la place de 6 chiffres (A Dude, 2026-10-18 : « je n'ai pas payé 15 000 pièces pour du vide »).
        const cwNow = card.offsetWidth;
        if (cwNow && cwNow !== env.card.w) { env.card.w = cwNow; env.card.x = mx + (cw - cwNow) / 2; }
        // Une fois la révélation retombée : une image sur deux, puis au ralenti (une sur six) au lieu de s'arrêter après
        // 40 s, pour que les petites lumières continuent de tourner (signalé par A Dude, 2026-10-18).
        owed += dt;
        if (t > restSince && (skip = (skip + 1) % (t > restSince + 40 ? 6 : 2))) return;
        t += owed;
        ci.clearRect(0, 0, w, h);
        co.clearRect(0, 0, W, H);
        ci.globalAlpha = co.globalAlpha = 1;
        scene.frame(t, owed);
        fadeEdges();
        owed = 0;
      };
      if (!o.manual) raf = requestAnimationFrame(frame);
      const guard = fn => (...a) => { try { if (!stopped) fn(...a); } catch (e) { /* une scène ne doit jamais casser le tirage */ } };
      return {
        lock: guard((slot, o = {}) => {
          const s = slot.getBoundingClientRect(), b = outer.getBoundingClientRect(), k = W / (b.width || W);
          scene.lock({ x: (s.left + s.width / 2 - b.left) * k, y: (s.top + s.height / 2 - b.top) * k }, o);
        }),
        build: guard(ms => scene.build(ms)),
        // Garbage et Land waste : pas de grand effet de révélation (« ça remue le couteau dans la plaie », A Dude 2026-10-18).
        reveal: guard(tier => { if (tier === 'garbage' || tier === 'landwaste') { restSince = t + 1; return; } scene.reveal(tier); restSince = t + 4 + 4 * (POWER[tier] || 0) + 2 * (ASCEND[tier] || 0); }),
        stop() { stopped = true; cancelAnimationFrame(raf); },
        // Mode manuel (o.manual, pour le trailer) : pas d'horloge ; l'appelant avance la scène lui-même, de dt secondes,
        // et obtient donc la même image pour le même instant.
        step(dt) { if (stopped) return; t += dt; ci.clearRect(0, 0, w, h); co.clearRect(0, 0, W, H); ci.globalAlpha = co.globalAlpha = 1; try { scene.frame(t, dt); fadeEdges(); } catch (e) { /* une scène ne casse rien */ } },
        // Arrête la scène et retire ses calques : indispensable quand la carte est rejouée au même endroit (manches
        // d'un duel), sinon l'ancienne image reste affichée par-dessus la nouvelle.
        destroy() { stopped = true; cancelAnimationFrame(raf); outer.remove(); inner.remove(); card.classList.remove('has-fx'); },
      };
    } catch (e) {
      return null;
    }
  }

  root.SkinFX = { mount, has: skin => !!SCENES[skin] };
})(window);
