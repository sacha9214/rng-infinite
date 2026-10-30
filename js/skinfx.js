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
    // Sans traîne (fall = 0 : le filigrane, le ∞ tracé), alpha et largeur ne changent pas d'un morceau à l'autre : les
    // morceaux voisins de même couleur sont réunis en un seul tracé. Le filigrane entier passait par ~28 morceaux tracés
    // deux fois à chaque image ; il en reste ~13 (signalé par MAYO, 2026-10-28 : « le bouton infinity lag »).
    function stroke(u0, len, a, width, fall, shift) {
      const n = Math.max(6, Math.round(len * 18 * q)), step = len / n, per = 4;
      co.lineCap = 'butt'; co.lineJoin = 'round';
      let open = false, col = '', al0 = 0, wd0 = 0;
      const flush = () => {
        if (!open) return;
        co.strokeStyle = col;
        co.globalAlpha = Math.min(1, al0 * (dark ? .16 : .1)); co.lineWidth = wd0 * 4.2; co.stroke();
        co.globalAlpha = Math.min(1, al0); co.lineWidth = wd0; co.stroke();
        open = false;
      };
      for (let i0 = 0; i0 < n; i0 += per) {
        const k = (i0 + per / 2) / n, al = a * Math.pow(Math.max(0, 1 - k), fall), wd = width * (fall ? 1 - .6 * k : 1);
        if (al <= .01) { flush(); continue; }
        const c = hue(k * HUES.length * (len / TAU) * 2 + shift);
        let i = i0 + 1;
        if (fall || !open || c !== col) { flush(); co.beginPath(); const pt = at(u0 - i0 * step); co.moveTo(pt.x, pt.y); open = true; col = c; al0 = al; wd0 = wd; }
        for (; i <= Math.min(n, i0 + per); i++) { const pt = at(u0 - i * step); co.lineTo(pt.x, pt.y); }
      }
      flush();
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

  // 💥 Supernova (2026-10-25, idée de jjcoolcid1) — une étoile qui meurt au centre de la carte. Pendant le tirage, de
  // la matière tombe vers le cœur, qui grossit et palpite (bleu → violet). Chaque chiffre posé envoie une petite onde de
  // choc et quelques éclats. La révélation : le cœur s'effondre (élan), flash blanc, puis des ondes de choc bleue et
  // violette partent de la carte avec des filaments d'éjecta ; dès Mythic, une deuxième onde et une nébuleuse qui reste
  // un moment derrière la carte. Tirage raté : le cœur s'éteint en naine blanche, une bouffée violette. Matière : lumière.
  SCENES.supernova = env => {
    const { co, ci, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const rings = timed(), bits = particles(), infall = particles(), clouds = timed(), flashes = timed(), emit = emitter();
    const BL = dark ? '#60a5fa' : '#2563eb', VI = dark ? '#a855f7' : '#7c3aed', IN = dark ? '#818cf8' : '#4f46e5', WH = dark ? '#eef2ff' : '#6366f1';
    const add = dark ? 'lighter' : 'source-over';
    let heat = .2, aim = .2, now = 0;
    const ring = (x, y, r, c, life, delay = 0, width = 2) => rings.add({ x, y, r, c, life, delay, width });
    const eject = (x, y, n, sp, life) => { for (let i = Math.round(n * q); i > 0; i--) { const a = rnd(TAU), v = sp * rnd(.5, 1); bits.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .75, drag: 2.2, g: 0, max: rnd(life * .6, life), c: pick([BL, VI, IN, WH]), w: rnd(1, 2.2) }); } };
    return {
      frame(t, dt) {
        now = t;
        heat += (aim - heat) * Math.min(1, dt * 5);
        // dans la carte, sous les chiffres : le cœur de l'étoile et la matière qui y tombe
        ci.globalCompositeOperation = add;
        const pulse = 1 + .12 * Math.sin(t * 14) * Math.min(1, heat);
        dot(ci, VI, w / 2, h / 2, h * (.55 + .5 * heat) * pulse, .35 + .3 * heat, h * (.45 + .3 * heat));
        dot(ci, BL, w / 2, h / 2, h * (.3 + .3 * heat) * pulse, .4 + .3 * heat);
        if (heat > .4) for (let i = emit(40 * q * heat, dt); i > 0; i--) { const a = rnd(TAU), d = w * rnd(.35, .6); infall.add({ x: w / 2 + Math.cos(a) * d, y: h / 2 + Math.sin(a) * d * .5, vx: -Math.cos(a) * d * 2.2, vy: -Math.sin(a) * d * 1.1, drag: 0, g: 0, max: .42, c: Math.random() < .5 ? BL : VI }); }
        infall.step(dt);
        infall.each((p, k) => line(ci, p.c, p.x, p.y, p.x - p.vx * .04, p.y - p.vy * .04, 1.4, Math.sin(Math.PI * k) * .7));
        flashes.run(dt, (f, k) => dot(ci, '#ffffff', w / 2, h / 2, w * .7, (1 - k) * f.a, h * 1.2));
        ci.globalCompositeOperation = 'source-over';
        // derrière la carte : la nébuleuse qui reste après une grosse explosion
        if (clouds.n) behind(env, () => {
          co.globalCompositeOperation = add;
          clouds.run(dt, (c, k) => {
            const a = Math.sin(Math.PI * Math.min(1, k * 2.5)) * (k > .6 ? (1 - k) / .4 : 1) * (dark ? .55 : .4), R = card.w * (.6 + .5 * outCubic(k)) * c.s;
            dot(co, BL, cx - R * .35, cy, R * .8, a, R * .45);
            dot(co, VI, cx + R * .35, cy, R * .8, a, R * .45);
            dot(co, IN, cx, cy, R * .5, a * .7, R * .55);
          });
        });
        // autour : les ondes de choc (fines, elles ne cachent pas les chiffres) et l'éjecta
        co.globalCompositeOperation = add;
        rings.run(dt, (r, k) => {
          const e = outCubic(k), R = r.r * (.2 + e);
          co.globalAlpha = (1 - k) * .9; co.strokeStyle = r.c; co.lineWidth = r.width * (1 - k) + .6; co.shadowColor = r.c; co.shadowBlur = 10;
          co.beginPath(); co.ellipse(r.x, r.y, R, R * .7, 0, 0, TAU); co.stroke();
        });
        co.shadowBlur = 0;
        bits.step(dt);
        bits.each((p, k) => line(co, p.c, p.x, p.y, p.x - p.vx * .05, p.y - p.vy * .05, p.w, 1 - k));
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(p, o) {
        if (o.ghost) return;
        const big = !!o.last;
        ring(p.x, p.y, card.h * (big ? 1.1 : .7), big ? WH : BL, big ? .55 : .42, 0, big ? 2.6 : 1.8);
        ring(p.x, p.y, card.h * (big ? .9 : .55), VI, big ? .55 : .42, .05, 1.4);
        eject(p.x, p.y, big ? 14 : 7, card.h * (big ? 5 : 3.5), .5);
        aim = Math.min(1.4, aim + .12);
      },
      build() { aim = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { aim = 0; ring(cx, cy, card.h * .6, VI, .8, 0, 1.2); return; } // naine blanche : ça s'éteint
        aim = 1.6; // l'effondrement (élan)…
        setTimeout(() => {
          aim = .25; heat = .25;
          flashes.add({ a: .45 + .45 * p, life: .35 });
          const n = 2 + Math.round(2 * p) + (p >= 1 ? 2 : 0);
          for (let i = 0; i < n; i++) ring(cx, cy, card.w * (.75 + .55 * p) * (1 + i * .16), [WH, BL, VI][i % 3], .75 + .5 * p, i * .08, 2.5 + 2.5 * p);
          eject(cx, cy, 16 + 30 * p, card.w * (1.2 + 1.6 * p), .9);
          if (p >= .6) clouds.add({ life: 1.8 + 1.4 * p + (ASCEND[tier] || 0) * .4, s: 1 + .2 * (ASCEND[tier] || 0) });
        }, 120);
      },
    };
  };

  // 💍 Shiny Diamond (2026-10-25, idée de finnnnn) — chaque pierre qui se pose fait « tink » : une étoile à 4 branches
  // s'allume dessus et quelques éclats d'arc-en-ciel (le feu du diamant) jaillissent. À la révélation, un éventail de
  // rayons spectraux derrière la carte et une pluie d'étincelles qui grandit avec la rareté ; matière dure, rien ne
  // s'écrase. Tirage raté : une seule étincelle terne.
  SCENES.shinydiamond = env => {
    const { co, ci, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const FIRE = ['#fda4af', '#fde68a', '#86efac', '#7dd3fc', '#c4b5fd'];
    const stars = timed(), rays = timed(), sparks = particles(), glows = timed();
    // une étoile à 4 branches : deux traits fins croisés + un cœur blanc
    const star = (c, x, y, r, a, rot) => {
      for (let i = 0; i < 2; i++) { const ang = rot + i * Math.PI / 2, dx = Math.cos(ang) * r, dy = Math.sin(ang) * r; tail(c, '#ffffff', x - dx, y - dy, x, y, Math.max(1, r * .08), a); tail(c, '#ffffff', x + dx, y + dy, x, y, Math.max(1, r * .08), a); }
      dot(c, '#ffffff', x, y, r * .35, a);
    };
    const shower = (x, y, n, v) => { for (let i = Math.round(n * q); i > 0; i--) { const a = rnd(TAU), s = card.h * rnd(.6, v); sparks.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g: card.h * 1.5, drag: 1.6, max: rnd(.4, .8), size: card.h * rnd(.025, .05), c: pick(FIRE) }); } };
    return {
      frame(t, dt) {
        behind(env, () => {
          co.globalCompositeOperation = add;
          rays.run(dt, (r, k) => godrays(co, dark ? '#e0f2fe' : '#7dd3fc', cx, cy, r.n, card.h * .4, card.h * r.s * outCubic(k * 2), r.rot + k * .6, card.h * .12, (1 - k) * (dark ? .55 : .5)));
        });
        co.globalCompositeOperation = add;
        sparks.step(dt);
        sparks.each((p, k) => { const tw = .5 + .5 * Math.sin(k * 30 + p.size); dot(co, p.c, p.x, p.y, p.size * 2.2, (1 - k) * tw); });
        co.lineCap = 'round';
        stars.run(dt, (s, k) => { const e = k < .25 ? k / .25 : 1 - (k - .25) / .75; star(co, s.x, s.y, s.r * (.6 + .4 * e), e * .95, s.rot + k * .5); });
        ci.globalCompositeOperation = add;
        glows.run(dt, (g, k) => dot(ci, '#e0f2fe', g.x, g.y, g.r, (1 - k) * .7));
        ci.globalCompositeOperation = 'source-over';
        co.globalCompositeOperation = 'source-over';
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        stars.add({ x: p.x + card.h * .12, y: p.y - card.h * .14, r: card.h * (o.last ? .55 : .38), rot: rnd(-.3, .3), life: .55 });
        glows.add({ x: p.x - card.x, y: p.y - card.y, r: card.h * .35, life: .3 });
        shower(p.x, p.y, o.last ? 8 : 4, 2.2);
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { sparks.add({ x: cx, y: card.y, vx: 0, vy: -card.h * .3, g: 0, drag: 1, max: .7, size: card.h * .03, c: '#94a3b8' }); return; }
        rays.add({ n: 8 + Math.round(8 * p), s: 1 + 1.6 * p + .3 * (ASCEND[tier] || 0), rot: rnd(TAU), life: .9 + .8 * p });
        stars.add({ x: card.x + card.w * .92, y: card.y + card.h * .12, r: card.h * (.5 + .5 * p), rot: 0, life: .8 });
        if (p >= .6) stars.add({ x: card.x + card.w * .08, y: card.y + card.h * .88, r: card.h * (.4 + .4 * p), rot: .4, life: .9, delay: .12 });
        shower(cx, cy, burst(p, 40, 6), 2.5 + 3 * p);
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

  // 🪵 Wood carving (2026-10-25, idées de jjcoolcid1 et JBearr12) — à chaque chiffre, un trait de lame clair traverse
  // le chiffre en biais (la coupe) et des copeaux en spirale s'envolent puis retombent, avec un peu de sciure. À la
  // révélation, une bouffée de sciure ; dès Mythic, un reflet de vernis doré balaie la planche et des copeaux dorés
  // pleuvent. Tirage raté : rien.
  SCENES.woodcarving = env => {
    const { co, card, q, dark } = env;
    const WOOD = ['#f3d3a1', '#e9bf85', '#d9a463', '#fbe3bb'];
    const chips = particles(), dust = particles(), cuts = timed(), glints = timed();
    let gold = false;
    const shave = (x, y, n, up, golden) => {
      for (let i = Math.round(n * q); i > 0; i--) chips.add({ x: x + rnd(-.1, .1) * card.h, y, vx: rnd(-1, 1) * card.h * 1.3, vy: -rnd(.5, 1) * up, g: card.h * 7, drag: .8, max: rnd(.6, 1), len: card.h * rnd(.09, .15), rot: rnd(TAU), spin: rnd(-10, 10), c: golden ? pick(['#fde68a', '#fbbf24', '#f59e0b']) : pick(WOOD) });
      for (let i = Math.round(n * .8 * q); i > 0; i--) dust.add({ x: x + rnd(-.15, .15) * card.h, y, vx: rnd(-1, 1) * card.h * .6, vy: -rnd(.2, .6) * card.h, g: card.h * 1.2, drag: 1.5, max: rnd(.5, .9), size: card.h * rnd(.012, .022) });
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // la coupe : un trait clair en biais qui file sur le chiffre et s'efface
        cuts.run(dt, (c, k) => {
          const e = clamp(k / .35), a = (1 - k) * .9;
          co.strokeStyle = `rgba(255,248,230,${a})`; co.lineWidth = Math.max(1.5, card.h * .03); co.lineCap = 'round';
          co.beginPath(); co.moveTo(c.x - c.r, c.y - c.r * .8); co.lineTo(c.x - c.r + 2 * c.r * e, c.y - c.r * .8 + 1.6 * c.r * e); co.stroke();
        });
        if (gold) glints.run(dt, (g, k) => {
          const x = card.x - card.w * .2 + card.w * 1.4 * k;
          const gr = co.createLinearGradient(x - card.h, 0, x + card.h, 0);
          gr.addColorStop(0, 'rgba(253,230,138,0)'); gr.addColorStop(.5, `rgba(253,230,138,${dark ? .45 : .35})`); gr.addColorStop(1, 'rgba(253,230,138,0)');
          co.fillStyle = gr; co.fillRect(card.x, card.y, card.w, card.h);
        });
        dust.step(dt);
        dust.each((d, k) => dot(co, dark ? '#e9bf85' : '#a8692f', d.x, d.y, d.size, (1 - k) * .6));
        chips.step(dt);
        chips.each((b, k) => {
          b.rot += b.spin * dt;
          co.globalAlpha = Math.min(1, (1 - k) * 1.8);
          co.save(); co.translate(b.x, b.y); co.rotate(b.rot);
          // un copeau : une boucle de bois clair (spirale ouverte), bord sombre pour se détacher sur fond clair
          co.lineCap = 'round';
          co.strokeStyle = 'rgba(92,51,18,.55)'; co.lineWidth = b.len * .42;
          co.beginPath(); co.arc(0, 0, b.len * .45, 0, Math.PI * 1.4); co.stroke();
          co.strokeStyle = b.c; co.lineWidth = b.len * .28;
          co.beginPath(); co.arc(0, 0, b.len * .45, 0, Math.PI * 1.4); co.stroke();
          co.restore();
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        cuts.add({ x: p.x, y: p.y, r: card.h * .28, life: .35 });
        // la lame entre dans le bois au creux de l'animation CSS (30 % de 0,62 s)
        setTimeout(() => shave(p.x, p.y - card.h * .1, o.last ? 6 : 4, card.h * 2.2, false), 180);
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) return;
        shave(card.x + card.w / 2, card.y + card.h * .3, 4 + 10 * p, card.h * 2.6, false);
        gold = p >= 1;
        if (gold) {
          glints.add({ life: .9 }); glints.add({ life: .9, delay: .9 });
          for (let i = 0; i < 4; i++) setTimeout(() => shave(card.x + card.w * rnd(.2, .8), card.y, 6, card.h * 3.2, true), i * 160);
        }
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

  // 🧬 DNA Helix (2026-10-25, idée de R77) — chaque chiffre qui s'emboîte lâche deux gerbes d'étincelles de liaison
  // (cyan à gauche, magenta à droite, comme les deux brins) ; à la révélation, des anneaux de lueur et, selon la
  // rareté, une pluie de nucléotides colorés (A, T, G, C). Tout est dessiné derrière la carte.
  SCENES.dna = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const sparks = particles(), rings = timed();
    const BASES = ['#22d3ee', '#e879f9', '#a3e635', '#facc15'];
    const bond = (x, s) => {
      for (const [dir, c] of [[-1, '#22d3ee'], [1, '#e879f9']]) for (let i = Math.round((3 + 5 * s) * q); i > 0; i--) {
        const a = (dir < 0 ? Math.PI : 0) + rnd(-.6, .6), v = card.h * rnd(1.5, 3 + 3 * s);
        sparks.add({ x, y: cy + rnd(-.3, .3) * card.h, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0, drag: 2.5, max: rnd(.35, .6), size: card.h * rnd(.02, .04), c });
      }
    };
    return {
      frame(t, dt) {
        sparks.step(dt);
        behind(env, () => {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          rings.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .7; co.strokeStyle = r.c; co.lineWidth = 2.5 * (1 - k) + .5; co.beginPath(); co.ellipse(cx, cy, card.w * (.5 + r.s * k), card.h * (.5 + r.s * 1.4 * k), 0, 0, TAU); co.stroke(); });
          sparks.each((d, k) => dot(co, d.c, d.x, d.y, d.size * (1 - k * .5), 1 - k));
          co.globalCompositeOperation = 'source-over';
        });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; bond(p.x, o.last ? .9 : .4); },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) return;
        for (let i = 0; i < 1 + Math.round(2 * p); i++) rings.add({ delay: i * .14, life: .9, s: .3 + .4 * p, c: i % 2 ? '#e879f9' : '#22d3ee' });
        for (let i = Math.round(30 * p * q); i > 0; i--) { const a = rnd(TAU), v = card.h * rnd(2, 4 + 5 * p); sparks.add({ x: cx + rnd(-.4, .4) * card.w, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 3, drag: 1.2, max: rnd(.7, 1.4), size: card.h * rnd(.03, .06), c: pick(BASES) }); }
      },
    };
  };

  // 🧚 Fairy Dust (2026-10-25, idée de R77) — une petite fée (une lueur dorée et sa traînée de paillettes) tourne autour
  // de la carte pendant le tirage ; à chaque chiffre, elle donne un coup de baguette : une étoile à quatre branches
  // s'allume derrière le chiffre et des paillettes en jaillissent (derrière la carte, jamais sur un chiffre). À la
  // révélation, une gerbe qui grandit avec la rareté ; dès Mythic, une pluie d'or tombe autour de la carte.
  SCENES.fairydust = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const GOLD = dark ? ['#fde68a', '#fff7d6', '#f9a8d4', '#e9d5ff'] : ['#d97706', '#c026d3', '#7c3aed', '#f59e0b'];
    const add = dark ? 'lighter' : 'source-over';
    const dust = particles(), stars = timed(), emit = emitter();
    let speed = .8, ang = 0, rain = 0;
    const star = (c, x, y, r, a) => { // étoile à quatre branches, fine
      if (a <= .01) return; co.globalAlpha = Math.min(1, a); co.fillStyle = c; co.beginPath();
      co.moveTo(x, y - r); co.quadraticCurveTo(x, y, x + r * .3, y); co.quadraticCurveTo(x, y, x, y + r); co.quadraticCurveTo(x, y, x - r * .3, y); co.quadraticCurveTo(x, y, x, y - r);
      co.moveTo(x - r * .7, y); co.quadraticCurveTo(x, y, x, y - r * .22); co.quadraticCurveTo(x, y, x + r * .7, y); co.quadraticCurveTo(x, y, x, y + r * .22); co.quadraticCurveTo(x, y, x - r * .7, y); co.fill();
    };
    const burst = (x, y, s) => {
      stars.add({ x, y, r: card.h * (.35 + .5 * s), life: .55 });
      for (let i = Math.round((8 + 22 * s) * q); i > 0; i--) { const a = rnd(TAU), v = card.h * rnd(1, 2.5 + 3 * s); dust.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - card.h * .6, g: card.h * 1.6, drag: 1.6, max: rnd(.6, 1.2), size: card.h * rnd(.025, .05), c: pick(GOLD), tw: rnd(TAU) }); }
    };
    return {
      frame(t, dt) {
        // la fée : une lueur qui tourne autour de la carte sur une ellipse, et sa traînée
        ang += dt * speed * 1.4; speed += (.8 - speed) * Math.min(1, dt * .7);
        const fx = cx + Math.cos(ang) * (card.w / 2 + card.h * .25), fy = cy + Math.sin(ang) * (card.h / 2 + card.h * .2) + Math.sin(t * 7) * card.h * .04;
        for (let n = emit((6 + 10 * speed) * q, dt); n > 0; n--) dust.add({ x: fx + rnd(-2, 2), y: fy + rnd(-2, 2), vx: rnd(-1, 1) * 6, vy: rnd(2, 10), g: card.h * .4, drag: 1, max: rnd(.6, 1.1), size: card.h * rnd(.02, .04), c: pick(GOLD), tw: rnd(TAU) });
        if (rain > 0) { rain -= dt; for (let n = Math.round(rnd(0, 3) * q); n > 0; n--) dust.add({ x: cx + rnd(-.65, .65) * card.w, y: card.y - card.h * rnd(.2, .8), vx: rnd(-1, 1) * 4, vy: card.h * rnd(.6, 1.2), g: card.h * .5, drag: .2, max: rnd(1, 1.8), size: card.h * rnd(.025, .045), c: pick(GOLD), tw: rnd(TAU) }); }
        dust.step(dt);
        behind(env, () => {
          co.globalCompositeOperation = add;
          stars.run(dt, (s, k) => { const e = k < .15 ? k / .15 : 1 - (k - .15) / .85; star(dark ? '#fff7d6' : '#a21caf', s.x, s.y, s.r * (.6 + .6 * k), e); dot(co, dark ? '#fde68a' : '#f0abfc', s.x, s.y, s.r * .8, e * .6); });
          dust.each((p, k) => { const tw = .5 + .5 * Math.sin(t * 18 + p.tw); star(p.c, p.x, p.y, p.size * (1.6 + 1.4 * tw), (1 - k) * (.45 + .55 * tw)); });
          dot(co, dark ? '#fff7d6' : '#e879f9', fx, fy, card.h * .14, dark ? .9 : .7);
          star(dark ? '#ffffff' : '#7e22ce', fx, fy, card.h * .09, 1);
        });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; burst(p.x, p.y, o.last ? .8 : .35); speed = 2.4; },
      build() { speed = 3; },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { dust.add({ x: cx, y: card.y, vx: 0, vy: card.h * .3, g: card.h * .6, drag: 0, max: 1, size: card.h * .04, c: GOLD[0], tw: 0 }); return; } // une seule paillette, qui tombe
        for (let i = 0; i < 1 + Math.round(3 * p); i++) setTimeout(() => burst(cx + rnd(-.45, .45) * card.w, cy + rnd(-.3, .3) * card.h, .4 + .6 * p), i * 110);
        if (p >= 1) rain = 2.2 + .6 * (ASCEND[tier] || 0);
      },
    };
  };

  // 🌀 Elemental (2026-10-25, idée de kaz) — légendaire. Quatre esprits (roche, glace, feu, vent) tournent autour de la
  // carte ; celui de l'élément en cours brille. Chaque chiffre se pose dans un élément, dans l'ordre des cases (le CSS
  // suit le même ordre) : la roche lâche des éclats et de la poussière, la glace des aiguilles de givre, le feu des
  // braises qui montent, le vent des rafales en spirale. Tout ce qui jaillit passe derrière la carte : un chiffre n'est
  // jamais couvert. Avant le dernier chiffre les esprits s'emballent ; à la révélation, un anneau des quatre couleurs
  // s'ouvre et les quatre matières éclatent ensemble, dosées par la rareté (un anneau de plus par cran au-delà du Mythic).
  SCENES.elemental = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    // roche, glace, feu, vent : couleur principale, claire, sombre (plus soutenues sur page claire)
    const EL = [
      { c: dark ? '#a8a29e' : '#57534e', hi: '#d6c7b0', lo: '#44403c' },
      { c: dark ? '#7dd3fc' : '#0284c7', hi: '#e0f7ff', lo: '#0c4a6e' },
      { c: dark ? '#fb923c' : '#ea580c', hi: '#fde047', lo: '#b91c1c' },
      { c: dark ? '#5eead4' : '#0d9488', hi: '#ccfbf1', lo: '#115e59' },
    ];
    const bits = particles(), gusts = timed(), rings = timed(), flashes = timed();
    const lv = [0, 0, 0, 0];
    let idx = 0, cur = -1, heat = .25, target = .25, spin = 0, flare = 0;
    const rx = card.w / 2 + 26, ry = card.h / 2 + 22;
    const burstOf = (e, x, y, s) => {
      const n = Math.round((e === 1 ? 14 : 11) * s * q) + 3;
      for (let i = 0; i < n; i++) {
        if (e === 0) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = rnd(60, 170) * s; bits.add({ e, x: x + rnd(-8, 8), y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 520, drag: .4, max: rnd(.6, 1), size: rnd(2.5, 5.5), rot: rnd(TAU), vr: rnd(-8, 8) }); if (i % 2) bits.add({ e: 4, x: x + rnd(-14, 14), y: y + rnd(0, 10), vx: rnd(-25, 25), vy: rnd(-25, -5), drag: 1.2, max: rnd(.7, 1.2), size: rnd(8, 15) }); }
        else if (e === 1) { const a = rnd(TAU), v = rnd(90, 230) * s; bits.add({ e, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 4, max: rnd(.45, .8), size: rnd(5, 10) }); }
        else if (e === 2) bits.add({ e, x: x + rnd(-12, 12), y: y + rnd(-6, 8), vx: rnd(-30, 30), vy: rnd(-160, -60) * s, g: -40, drag: 1, max: rnd(.6, 1.2), size: rnd(1.6, 3.4), ph: rnd(TAU) });
        else bits.add({ e, x: x - rnd(10, 30), y: y + rnd(-14, 14), vx: rnd(160, 320) * s, vy: rnd(-20, 20), drag: 2, max: rnd(.4, .7), size: rnd(10, 22) });
      }
      if (e === 3) for (let i = 0; i < 2; i++) gusts.add({ x, y, life: .55, delay: i * .08, r: card.h * (.45 + .25 * i) * s, dir: i ? -1 : 1 });
      flashes.add({ x, y, e, life: e === 1 ? .3 : .45, size: card.h * (.5 + .4 * s) });
    };
    const drawBit = (b, k) => {
      const E = EL[b.e === 4 ? 0 : b.e];
      if (b.e === 0) { co.save(); co.translate(b.x, b.y); co.rotate(b.rot + b.vr * b.life); co.globalAlpha = 1 - k * k; co.fillStyle = k < .3 ? E.hi : E.c; co.beginPath(); co.moveTo(-b.size, -b.size * .4); co.lineTo(b.size * .3, -b.size); co.lineTo(b.size, b.size * .2); co.lineTo(-b.size * .2, b.size * .8); co.closePath(); co.fill(); co.restore(); }
      else if (b.e === 4) dot(co, dark ? '#a8a29e' : '#78716c', b.x, b.y, b.size * (1 + k), (1 - k) * .35);
      else if (b.e === 1) { const a = Math.atan2(b.vy, b.vx), l = b.size * (1 - k * .5); co.lineCap = 'round'; line(co, E.c, b.x - Math.cos(a) * l, b.y - Math.sin(a) * l, b.x, b.y, 2, 1 - k); line(co, E.hi, b.x - Math.cos(a) * l * .5, b.y - Math.sin(a) * l * .5, b.x, b.y, 1, 1 - k); }
      else if (b.e === 2) { co.globalCompositeOperation = add; dot(co, k < .4 ? E.hi : E.c, b.x + Math.sin(b.life * 9 + b.ph) * 3, b.y, b.size * 2.4, (1 - k) * .9); co.globalCompositeOperation = 'source-over'; }
      else tail(co, E.c, b.x - b.size * 2, b.y, b.x, b.y, 1.6, (1 - k) * .8);
    };
    // Un esprit : un petit éclat de chaque matière.
    const spirit = (e, x, y, r, a) => {
      const E = EL[e];
      co.globalCompositeOperation = add; dot(co, E.c, x, y, r * 3, a * .45); co.globalCompositeOperation = 'source-over';
      co.globalAlpha = a; co.fillStyle = E.c; co.strokeStyle = E.hi; co.lineWidth = 1.2; co.beginPath();
      if (e === 0) { co.moveTo(x - r, y + r * .5); co.lineTo(x - r * .5, y - r * .8); co.lineTo(x + r * .7, y - r * .6); co.lineTo(x + r, y + r * .6); co.closePath(); co.fill(); }
      else if (e === 1) { co.moveTo(x, y - r * 1.3); co.lineTo(x + r * .7, y); co.lineTo(x, y + r * 1.3); co.lineTo(x - r * .7, y); co.closePath(); co.fill(); co.stroke(); }
      else if (e === 2) { co.moveTo(x, y - r * 1.5); co.quadraticCurveTo(x + r, y - r * .2, x + r * .6, y + r * .7); co.quadraticCurveTo(x, y + r * 1.2, x - r * .6, y + r * .7); co.quadraticCurveTo(x - r, y - r * .2, x, y - r * 1.5); co.fill(); dot(co, E.hi, x, y + r * .3, r * .9, a); }
      else { co.arc(x, y, r, 0, TAU * .8); co.moveTo(x + r * .5, y); co.arc(x, y, r * .5, 0, TAU * .7); co.stroke(); }
    };
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3); spin += dt * (.5 + 1.8 * heat); flare = Math.max(0, flare - dt * 1.2);
        lv.forEach((v, i) => { lv[i] += ((i === cur ? 1 : 0) - v) * Math.min(1, dt * 5); });
        // Dans la carte : la lueur de l'élément en cours (le CSS pose sa matière, la lueur la fait vivre).
        ci.globalCompositeOperation = 'lighter';
        lv.forEach((v, i) => { if (v > .02) dot(ci, EL[i].c, i === 2 ? w * .5 : w * (.5 + .3 * Math.sin(t * 1.3 + i)), i === 2 ? h * 1.05 : h * .5, w * .45, v * (i === 2 ? .35 + .1 * Math.sin(t * 17) : .2)); });
        ci.globalCompositeOperation = 'source-over';
        bits.step(dt);
        behind(env, () => {
          // l'anneau des quatre couleurs, à la révélation
          rings.run(dt, (r, k) => { const R = 1 + r.grow * outCubic(k); for (let i = 0; i < 4; i++) { co.globalAlpha = (1 - k) * r.a; co.strokeStyle = EL[i].c; co.lineWidth = r.width * (1 - k * .6); co.beginPath(); co.ellipse(cx, cy, (card.w / 2 + 6) * R / 1 + r.grow * k * .3, (card.h / 2 + 6) + r.grow * k * .5, 0, spin * .3 + i * TAU / 4, spin * .3 + (i + 1) * TAU / 4 - .05); co.stroke(); } });
          flashes.run(dt, (f, k) => { co.globalCompositeOperation = add; dot(co, EL[f.e].hi, f.x, f.y, f.size * (.5 + k), (1 - outCubic(k)) * .7); co.globalCompositeOperation = 'source-over'; });
          gusts.run(dt, (g, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = EL[3].c; co.lineWidth = 2; co.lineCap = 'round'; co.beginPath(); co.arc(g.x, g.y, g.r * (.6 + k), g.dir * k * 3, g.dir * k * 3 + 2.4); co.stroke(); });
          bits.each(drawBit);
          // les quatre esprits sur leur orbite
          for (let i = 0; i < 4; i++) { const a = spin + i * TAU / 4, s = 1 + .4 * flare; spirit(i, cx + Math.cos(a) * rx * s, cy + Math.sin(a) * ry * s, 5.5 + 4 * lv[i] + 3 * flare, .65 + .35 * Math.max(lv[i], flare)); }
        });
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(p, o) {
        const e = idx++ % 4; cur = e;
        if (o.ghost) return;
        burstOf(e, p.x, p.y, o.last ? 1.4 : 1);
      },
      build() { target = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        target = .3 + .4 * p;
        if (!p) { bits.add({ e: 4, x: cx, y: card.y + card.h, vx: 0, vy: -20, drag: 1, max: 1, size: 14 }); return; } // tirage raté : un peu de poussière
        flare = .5 + .5 * p;
        for (let i = 0; i < 1 + Math.round(2 * p) + asc; i++) rings.add({ delay: i * .15, life: .9 + .5 * p, grow: 40 + 90 * p + 25 * i, width: 2 + 2.5 * p, a: .9 - .12 * i });
        for (let e = 0; e < 4; e++) for (let i = 0; i < 1 + Math.round(2 * p); i++) { const pt = along(card, (e + rnd()) / 4); setTimeout(() => burstOf(e, pt.x, pt.y, .6 + .8 * p), 60 * i + e * 40); }
      },
    };
  };

  // 🌌 Milky Way (2026-10-26, idée de shadow2 Jr) — une galaxie spirale, vue un peu de biais, tourne autour du nombre
  // (deux bras d'étoiles, de la poussière dorée près du centre, bleue au bout des bras), derrière la carte ; elle tourne
  // plus vite à mesure que la tension monte. Chaque chiffre qui se pose reçoit une étoile filante venue d'un bras. À la
  // révélation, les bras s'illuminent selon la rareté ; dès Mythic, le cœur de la galaxie s'embrase derrière la carte
  // (un bulbe doré qui déborde, plus grand pour Divine, Godlike et Infinite). Tirage raté : la galaxie ralentit et pâlit.
  SCENES.milkyway = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const R = Math.max(card.w * .78, card.h * 2.2), TILT = .42;
    // les étoiles des bras : rayon r (0 à 1), angle de base sur une spirale logarithmique, plus un peu de dispersion
    const stars = Array.from({ length: Math.round(620 * q) }, (_, i) => {
      const arm = i % 2, r = Math.pow(Math.random(), .8) * .95 + .05, a = arm * Math.PI + Math.log(r) * 2.6 + rnd(-.35, .35) * (1.2 - r);
      return { r, a, s: rnd(.6, 1.8), c: r < .3 ? pick(['#fff7d6', '#fde68a', '#ffffff']) : pick(['#c7d2fe', '#a5b4fc', '#e9d5ff', '#ffffff', '#bfdbfe']), tw: rnd(TAU) };
    });
    const dust = Array.from({ length: Math.round(40 * q) }, (_, i) => { const r = rnd(.15, .9), arm = i % 2; return { r, a: arm * Math.PI + Math.log(r) * 2.6 + rnd(-.2, .2), c: r < .4 ? '#fde68a' : pick(['#818cf8', '#c084fc']) }; });
    const shooters = timed(), flashes = timed(), rings = timed(), sparks = particles();
    let spin = 0, heat = .3, target = .3, glow = 0, core = 0, coreTo = 0, dim = 1, asc = 0;
    const pos = (r, a) => ({ x: cx + Math.cos(a) * r * R, y: cy + Math.sin(a) * r * R * TILT });
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3);
        spin += dt * (.12 + .5 * heat);
        glow = Math.max(0, glow - dt * .5);
        core += (coreTo - core) * Math.min(1, dt * 2.5); coreTo = Math.max(0, coreTo - dt * .08);
        // dans la carte : la lueur du bulbe derrière les chiffres
        ci.globalCompositeOperation = 'lighter';
        dot(ci, '#fde68a', w / 2, h / 2, w * .35, (.06 + .08 * heat + .35 * core) * dim, h * .9);
        behind(env, () => {
          co.globalCompositeOperation = add;
          // poussière : de grands nuages doux le long des bras
          for (const d of dust) { const p = pos(d.r, d.a + spin); dot(co, d.c, p.x, p.y, R * .18 * (1.2 - d.r * .5), (dark ? .17 : .12) * (1 + glow) * dim, R * .18 * TILT * 1.3); }
          // le bulbe central, très doux (plus fort quand le cœur s'embrase)
          dot(co, dark ? '#fff1d0' : '#f59e0b', cx, cy, R * (.32 + .25 * core), ((dark ? .25 : .16) + .5 * core) * dim, R * (.32 + .25 * core) * .6);
          // les étoiles des bras
          for (const s of stars) {
            const p = pos(s.r, s.a + spin), a = (.45 + .45 * Math.sin(t * 3 + s.tw)) * (dark ? 1 : .8) * (.7 + .6 * glow) * dim;
            if (s.s > 1.5) dot(co, s.c, p.x, p.y, s.s * 2.6, a);
            else { co.globalAlpha = Math.min(1, a); co.fillStyle = dark ? s.c : '#4338ca'; co.fillRect(p.x - s.s / 2, p.y - s.s / 2, s.s, s.s); }
          }
        });
        // le cœur qui s'embrase : un bulbe doré et des rayons courts, jamais sous la carte (la rareté s'y affiche)
        if (core > .02) behind(env, () => {
          co.globalCompositeOperation = add;
          dot(co, '#fff7e6', cx, cy, card.w * (.45 + .3 * core), core * .7 * dim, card.h * (1 + .8 * core));
          godrays(co, dark ? '#fde68a' : '#d97706', cx, cy, 14 + 4 * asc, card.h * .5, card.w * (.5 + .2 * asc) * core, -spin * 2, 4, core * (dark ? .25 : .2));
        }, true);
        co.globalCompositeOperation = add;
        flashes.run(dt, (f, k) => { dot(co, '#e0e7ff', f.x, f.y, f.s * (.4 + k), (1 - k) * .9); dot(co, '#ffffff', f.x, f.y, f.s * 1.6 * (1 - k), (1 - k) * .7, 1.5); dot(co, '#ffffff', f.x, f.y, 1.5, (1 - k) * .7, f.s * 1.6 * (1 - k)); });
        // étoiles filantes : d'un point d'un bras jusqu'au haut du chiffre
        shooters.run(dt, (s, k) => { const e = outCubic(k), x = lerp(s.x0, s.x1, e), y = lerp(s.y0, s.y1, e); tail(co, '#e0e7ff', x - (s.x1 - s.x0) * .18, y - (s.y1 - s.y0) * .18, x, y, 2, 1 - k * .5); dot(co, '#ffffff', x, y, 5, 1 - k * .3); });
        rings.run(dt, (r, k) => { const e = outCubic(k); co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? '#c7d2fe' : '#6366f1'; co.lineWidth = 1 + 2.5 * (1 - k); co.beginPath(); co.ellipse(cx, cy, card.w * .55 + R * .6 * e, (card.w * .55 + R * .6 * e) * TILT, 0, 0, TAU); co.stroke(); });
        sparks.step(dt);
        sparks.each((s, k) => dot(co, s.c, s.x, s.y, s.size, 1 - k));
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(pt, o) {
        if (o.ghost) return;
        heat = Math.min(1.5, heat + .15);
        const s = pick(stars), p = pos(s.r, s.a + spin), top = card.y + 4;
        shooters.add({ x0: p.x, y0: Math.min(p.y, card.y - 20), x1: pt.x, y1: top, life: .3 });
        flashes.add({ delay: .26, x: pt.x, y: top, s: card.h * (o.last ? .5 : .3), life: .4 });
      },
      build() { target = 1.4; },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { target = .1; dim = .5; return; }
        target = .35 + .4 * p; glow = .6 + 1.2 * p;
        for (let i = 0; i < 1 + Math.round(2 * p); i++) rings.add({ delay: i * .15, life: 1 });
        for (let i = burst(p, 50 * q, 6); i > 0; i--) { const s = pick(stars), q2 = pos(s.r, s.a + spin); sparks.add({ x: q2.x, y: q2.y, vx: (q2.x - cx) * .6, vy: (q2.y - cy) * .6, drag: 1.5, max: rnd(.5, 1.2), size: rnd(2, 4), c: s.c }); }
        if (p >= 1) { asc = ASCEND[tier] || 0; coreTo = 1 + .35 * asc; }
      },
    };
  };

  // ⚖️ Divine Judgment (2026-10-25, idée de Gray alt) — un tribunal céleste. Une gloire dorée rayonne derrière la carte,
  // une grande balance la surplombe (son fléau passe derrière la carte, les plateaux pendent de chaque côté) et pèse le
  // nombre : elle oscille pendant le tirage, de plus en plus fort avant le dernier chiffre. Chaque chiffre reçoit un pilier
  // de lumière venu d'en haut. Au verdict : la balance s'équilibre d'un coup, un grand pilier frappe la carte, les rayons
  // s'embrasent, des ondes partent ; dès Mythic, une auréole et des plumes ; tirage raté : la balance penche, rien ne tombe.
  SCENES.divine = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const GOLD = dark ? '#fde047' : '#b45309', PALE = dark ? '#fff7d6' : '#a16207', BRASS = dark ? '#f5d27a' : '#92400e', WHITE = dark ? '#ffffff' : '#78350f';
    const pillars = timed(), rings = timed(), flashes = timed(), sparks = particles(), feathers = particles(), motes = particles(), emit = emitter();
    let heat = 0, target = .25, tilt = 0, tiltTo = 0, swing = 0, p = 0, since = 0, revealed = false, verdict = 0, missed = false, spin = 0, asc = 0;
    const strike = (x, y, s, life) => pillars.add({ x, y, s, life });
    return {
      frame(t, dt) {
        heat += (target - heat) * Math.min(1, dt * 3); since += dt; spin += dt * (.05 + .25 * heat);
        verdict = Math.max(0, verdict - dt * .35);
        // la balance : elle oscille en pesant, puis s'immobilise (verdict) ou penche (tirage raté)
        if (revealed) tiltTo = missed ? .32 : 0; else tiltTo = Math.sin(t * (2 + 6 * heat)) * (.05 + .16 * heat);
        tilt += (tiltTo - tilt) * Math.min(1, dt * (revealed ? 5 : 8));
        // Dans la carte : la lumière d'en haut respire, plus forte avec la tension.
        ci.globalCompositeOperation = 'lighter';
        dot(ci, '#fde68a', w * .5, -h * .15, w * .42, .1 + .14 * heat + .25 * verdict, h * .7);
        // Des grains de lumière descendent lentement autour de la carte.
        for (let n = emit((3 + 10 * heat) * q, dt); n > 0; n--) motes.add({ x: cx + rnd(-.75, .75) * card.w, y: card.y - rnd(10, 60), vx: rnd(-4, 4), vy: rnd(8, 22), max: rnd(2, 3.5), size: rnd(1.5, 3.2) });
        motes.step(dt); sparks.step(dt); feathers.step(dt);
        const RAY = Math.max(card.w * .62, card.h * 1.9), rayA = (dark ? .22 : .16) * (.5 + heat) + .45 * verdict;
        behind(env, () => {
          co.globalCompositeOperation = add;
          // La gloire : des rayons en éventail autour du nombre, qui tournent doucement.
          const N = 18;
          for (let i = 0; i < N; i++) {
            const a = spin + i * TAU / N, L = RAY * (i % 2 ? .78 : 1) * (1 + .35 * verdict), sw = .05;
            const g = co.createRadialGradient(cx, cy, card.h * .3, cx, cy, L);
            g.addColorStop(0, (dark ? '#fff4c2' : '#d97706') + 'ff'); g.addColorStop(1, (dark ? '#fde047' : '#d97706') + '00');
            co.globalAlpha = Math.min(1, rayA); co.fillStyle = g; co.beginPath(); co.moveTo(cx, cy);
            co.lineTo(cx + Math.cos(a - sw) * L, cy + Math.sin(a - sw) * L * .62); co.lineTo(cx + Math.cos(a + sw) * L, cy + Math.sin(a + sw) * L * .62); co.closePath(); co.fill();
          }
          flashes.run(dt, (f, k) => { const a = 1 - outCubic(k); dot(co, '#fff7d6', cx, cy, f.size * (.5 + .9 * k), a * (dark ? .9 : .55), f.size * .45 * (.5 + .9 * k)); });
          // La balance : un fléau qui passe derrière la carte, deux chaînes, deux plateaux.
          co.globalCompositeOperation = 'source-over';
          const px = cx, py = card.y - 12, arm = card.w / 2 + 34, ca = Math.cos(tilt), sa = Math.sin(tilt);
          const ends = [-1, 1].map(d => ({ x: px + d * arm * ca, y: py + d * arm * sa }));
          co.globalAlpha = dark ? .9 : .85; co.strokeStyle = BRASS; co.lineCap = 'round';
          co.lineWidth = 3; co.beginPath(); co.moveTo(ends[0].x, ends[0].y); co.lineTo(ends[1].x, ends[1].y); co.stroke();
          co.fillStyle = BRASS; co.beginPath(); co.arc(px, py, 4.5, 0, TAU); co.fill();
          co.beginPath(); co.moveTo(px, py - 4); co.lineTo(px - 4, py - 12); co.lineTo(px, py - 18); co.lineTo(px + 4, py - 12); co.closePath(); co.fill();
          ends.forEach(e => {
            const drop = card.h * .62, pw = 20;
            co.lineWidth = 1; co.globalAlpha = dark ? .75 : .7;
            co.beginPath(); co.moveTo(e.x, e.y); co.lineTo(e.x - pw, e.y + drop); co.moveTo(e.x, e.y); co.lineTo(e.x + pw, e.y + drop); co.stroke();
            co.globalAlpha = dark ? .95 : .9; co.beginPath(); co.ellipse(e.x, e.y + drop, pw + 2, 5, 0, 0, Math.PI); co.closePath(); co.fill();
            dot(co, dark ? '#fde68a' : '#f59e0b', e.x, e.y + drop, pw * 1.3, (dark ? .25 : .2) + .5 * verdict, 8);
          });
        });
        co.globalCompositeOperation = add;
        motes.each((m, k) => dot(co, dark ? '#fde68a' : '#d97706', m.x, m.y, m.size * (dark ? 2 : 1.4), Math.sin(Math.PI * k) * (dark ? .6 : .45)));
        // Les piliers de lumière : d'en haut de l'écran jusqu'au haut de la carte (jamais sur les chiffres), le reste
        // est dessiné dans la carte, derrière eux.
        pillars.run(dt, (u, k) => {
          const a = k < .12 ? k / .12 : 1 - outCubic((k - .12) / .88), wd = (6 + 20 * u.s) * (k < .12 ? .4 + 5 * k : 1 - .6 * k);
          const x = u.x;
          behind(env, () => {
            co.globalCompositeOperation = add;
            const g = co.createLinearGradient(x - wd, 0, x + wd, 0);
            g.addColorStop(0, GOLD + '00'); g.addColorStop(.35, GOLD + 'aa'); g.addColorStop(.5, WHITE); g.addColorStop(.65, GOLD + 'aa'); g.addColorStop(1, GOLD + '00');
            co.globalAlpha = a * (dark ? .9 : .7); co.fillStyle = g; co.fillRect(x - wd, 0, wd * 2, card.y + 2);
          }, true);
          ci.globalCompositeOperation = 'lighter';
          dot(ci, '#fff7d6', u.x - card.x, (u.y - card.y) * .5, wd * 1.3, a * .45, (u.y - card.y) * .6 + 6);
        });
        rings.run(dt, (r, k) => { const e = outCubic(k), rx = r.r0 + r.r * e; co.globalCompositeOperation = add; co.globalAlpha = (1 - k) * .85; co.strokeStyle = PALE; co.lineWidth = 1.2 + 2 * (1 - k) * r.wd; co.beginPath(); co.ellipse(r.x, r.y, rx, rx * r.k, 0, 0, TAU); co.stroke(); });
        sparks.each((s, k) => tail(co, s.c, s.x - s.vx * .04, s.y - s.vy * .04, s.x, s.y, s.size, 1 - k));
        // Les plumes : de petits ovales blancs qui se balancent en tombant.
        co.globalCompositeOperation = 'source-over';
        feathers.each((f, k) => { co.globalAlpha = Math.min(1, (1 - k) * 2) * (dark ? .85 : .9); co.fillStyle = dark ? '#fffbeb' : '#fde68a'; co.strokeStyle = dark ? '#fde68a' : '#b45309'; co.lineWidth = .8; co.beginPath(); co.ellipse(f.x + Math.sin(f.life * 3 + f.ph) * 10, f.y, f.size * .35, f.size, Math.sin(f.life * 3 + f.ph) * .7, 0, TAU); co.fill(); co.stroke(); });
        // Dès Mythic, une auréole dorée au-dessus de la carte, qui reste un moment.
        if (revealed && !missed && p >= 1) {
          const life = clamp((since - .2) * 3) * clamp((4 + 1.5 * asc - since) / 1.5);
          if (life > .01) behind(env, () => { co.globalCompositeOperation = add; co.strokeStyle = GOLD; co.globalAlpha = life * .9; co.lineWidth = 3; co.beginPath(); co.ellipse(cx, card.y - 30, card.h * .55, card.h * .12, 0, 0, TAU); co.stroke(); dot(co, PALE, cx, card.y - 30, card.h * .8, life * .3, card.h * .22); }, true);
        }
        co.globalAlpha = 1; co.globalCompositeOperation = 'source-over';
      },
      lock(pt, o) {
        if (o.ghost) return;
        heat = Math.min(1.4, heat + .12);
        strike(pt.x, pt.y, o.last ? 1 : .45, o.last ? .75 : .55);
        rings.add({ x: pt.x, y: card.y + card.h - 4, r0: 6, r: card.h * (o.last ? .9 : .5), k: .22, wd: o.last ? 1.4 : .8, life: .6 });
        for (let i = Math.round((o.last ? 14 : 6) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = rnd(60, 160); sparks.add({ x: pt.x, y: card.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 140, drag: 1.5, max: rnd(.3, .6), size: rnd(1, 2), c: pick([GOLD, PALE]) }); }
      },
      build() { target = 1.2; },
      reveal(tier) {
        p = POWER[tier] || 0; revealed = true; since = 0; missed = !p; target = missed ? .1 : .3 + .4 * p;
        if (missed) return; // la balance penche : aucun verdict
        verdict = .4 + .6 * p;
        strike(cx, cy, 1.2 + 2 * p, .9 + .5 * p);
        flashes.add({ life: .8, size: card.w * (.5 + .5 * p) });
        for (let i = 0; i < 1 + Math.round(2 * p); i++) rings.add({ x: cx, y: cy, delay: i * .12, r0: card.w * .5, r: card.w * (.25 + .35 * p), k: card.h / card.w + .1, wd: 1 + p, life: .9 });
        for (let i = burst(p, 60 * q, 8); i > 0; i--) { const a = rnd(TAU), v = rnd(90, 200 + 260 * p); sparks.add({ x: cx + Math.cos(a) * card.w * .45, y: cy + Math.sin(a) * card.h * .5, vx: Math.cos(a) * v, vy: Math.sin(a) * v * .7, g: 60, drag: 1.4, max: rnd(.5, 1 + .5 * p), size: rnd(1, 2.4), c: pick([GOLD, PALE, WHITE]) }); }
        if (p >= 1) { asc = ASCEND[tier] || 0; for (let i = Math.round((8 + 6 * asc) * q); i > 0; i--) feathers.add({ x: cx + rnd(-.8, .8) * card.w, y: card.y - rnd(20, 90), vx: rnd(-6, 6), vy: rnd(14, 30), max: rnd(2.5, 4), size: rnd(5, 8), ph: rnd(TAU) }); }
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

  // 🎳 Bowling (2026-10-25, idée de JBearr12) — à chaque chiffre posé, une boule violette traverse la piste sous la
  // carte de gauche à droite (elle tourne, ses trois trous défilent) et percute la quille : éclats blancs et rouges,
  // petites quilles qui volent. La dernière boule est plus grosse. À la révélation, les quilles s'envolent autour de la
  // carte (plus nombreuses avec la rareté) et dès Epic « STRIKE! » s'affiche au-dessus ; tirage raté : « GUTTER ».
  SCENES.bowling = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const balls = timed(), pins = particles(), chips = particles(), words = timed();
    const pin = (x, y, s, rot, a) => { // une petite quille blanche à bandes rouges
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      co.fillStyle = '#f8fafc'; co.strokeStyle = 'rgba(71,85,105,.8)'; co.lineWidth = 1;
      co.beginPath(); co.ellipse(0, s * .55, s * .55, s * .9, 0, 0, TAU); co.fill(); co.stroke();
      co.beginPath(); co.ellipse(0, -s * .75, s * .3, s * .45, 0, 0, TAU); co.fill(); co.stroke();
      co.fillRect(-s * .22, -s * .5, s * .44, s * .5);
      co.fillStyle = '#dc2626'; co.fillRect(-s * .26, -s * .38, s * .52, s * .1); co.fillRect(-s * .28, -s * .2, s * .56, s * .1);
      co.restore();
    };
    const ball = (x, y, r, spin, a) => {
      co.save(); co.globalAlpha = a;
      const g = co.createRadialGradient(x - r * .35, y - r * .4, r * .1, x, y, r);
      g.addColorStop(0, '#c4b5fd'); g.addColorStop(.35, '#7c3aed'); g.addColorStop(1, '#2e1065');
      co.fillStyle = g; co.beginPath(); co.arc(x, y, r, 0, TAU); co.fill();
      co.fillStyle = '#1e1b4b';
      for (const [dx, dy] of [[-.22, -.3], [.12, -.36], [-.02, .02]]) { const ca = Math.cos(spin), sa = Math.sin(spin), hx = dx * ca - dy * sa, hy = dx * sa + dy * ca; co.beginPath(); co.arc(x + hx * r, y + hy * r, r * .11, 0, TAU); co.fill(); }
      co.restore();
    };
    const knock = (x, y, s) => {
      for (let i = Math.round((8 + 12 * s) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = card.h * rnd(2.5, 5 + 4 * s); chips.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 12, drag: .3, max: rnd(.4, .8), size: card.h * rnd(.02, .04), rot: rnd(TAU), spin: rnd(-14, 14), c: pick(['#ffffff', '#f1f5f9', '#dc2626', '#cbd5e1']) }); }
    };
    const fly = (x, y, n, power) => { for (let i = 0; i < n; i++) { const a = rnd(-Math.PI * .9, -Math.PI * .1), v = card.h * rnd(3, 4 + 4 * power); pins.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 9, drag: .2, max: rnd(.9, 1.4), size: card.h * rnd(.09, .14), rot: rnd(TAU), spin: rnd(-12, 12) }); } };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // la boule : elle roule le long du bas de la carte, du bord gauche jusqu'à la quille (k = .55), puis continue
        balls.run(dt, (b, k) => {
          const x0 = card.x - b.r * 2, x = x0 + (b.x - x0) * (k / .55), y = card.y + card.h - b.r * .6;
          for (let i = 1; i <= 4; i++) ball(x - i * b.r * .5, y, b.r, 0, .1 * (5 - i) * (k < .9 ? 1 : (1 - k) * 10)); // traînée
          ball(x, y, b.r, x / b.r, k < .9 ? 1 : (1 - k) * 10);
          if (!b.hit && k >= .55) { b.hit = true; knock(b.x, y - b.r, b.s); fly(b.x, y - b.r, b.s > .7 ? 3 : 1, b.s); }
        });
        pins.step(dt); chips.step(dt);
        pins.each((p, k) => pin(p.x, p.y, p.size, p.rot + p.spin * p.life, k < .8 ? 1 : (1 - k) * 5));
        chips.each((c, k) => { co.save(); co.globalAlpha = 1 - k; co.translate(c.x, c.y); co.rotate(c.rot + c.spin * c.life); co.fillStyle = c.c; co.fillRect(-c.size, -c.size * .5, c.size * 2, c.size); co.restore(); });
        words.run(dt, (w, k) => {
          const pop = k < .15 ? outCubic(k / .15) * 1.15 : k < .25 ? 1.15 - .15 * (k - .15) / .1 : 1, a = k > .8 ? (1 - k) * 5 : 1;
          text(co, w.s, cx, card.y - card.h * .38, card.h * w.size * pop, w.c, a);
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        const s = o.last ? .9 : .5;
        // la boule part maintenant et touche la quille vite : sa course entière dure moins qu'un chiffre
        balls.add({ x: p.x, r: card.h * (o.last ? .28 : .21), s, life: .32 });
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { words.add({ s: 'GUTTER', size: .2, c: dark ? '#94a3b8' : '#64748b', life: 1.4 }); return; }
        fly(cx, card.y + card.h * .2, Math.round((3 + 14 * p) * q), p);
        for (let i = 0; i < 1 + Math.round(3 * p); i++) knock(cx + rnd(-.45, .45) * card.w, card.y + card.h * .3, .6 + p);
        if (p >= .6) words.add({ delay: .1, s: 'STRIKE!', size: .24 + .1 * p + .04 * (ASCEND[tier] || 0), c: p >= 1 ? '#facc15' : '#f97316', life: 1.8 + p });
      },
    };
  };
  // 🪨 Rock Smash (2026-10-25, idée de HSI) — à chaque chiffre posé, un poing de dessin animé tombe d'en haut sur le
  // rocher (traits de vitesse), le frappe, reste un instant puis remonte ; éclats de pierre et poussière jaillissent. Le
  // dernier coup est plus gros. À la révélation, un grand poing frappe le milieu de la carte : onde de choc, pluie de
  // cailloux, poussière, qui grandissent avec la rareté (deux poings dès Mythic) ; tirage raté : un petit caillou roule.
  SCENES.rocksmash = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const fists = timed(), shards = particles(), dust = particles(), waves = timed();
    const STONE = ['#a8a29e', '#78716c', '#57534e', '#d6d3d1'], DUST = dark ? '#a8a29e' : '#78716c';
    // le poing, vu de face, phalanges vers le bas, au bout d'une manche qui vient du haut
    const fist = (x, y, s, a) => {
      co.save(); co.globalAlpha = a; co.translate(x, y);
      co.fillStyle = '#dc2626'; co.strokeStyle = '#450a0a'; co.lineWidth = Math.max(1, s * .06);
      co.fillRect(-s * .5, -s * 3, s, s * 2.15); co.strokeRect(-s * .5, -s * 3, s, s * 2.15); // la manche
      co.fillStyle = '#fbbf24'; co.fillRect(-s * .46, -s * 1.02, s * .92, s * .2); // le poignet de la manche
      co.fillStyle = '#f2c29b'; co.strokeStyle = '#7c2d12';
      roundRect(co, -s * .55, -s * .85, s * 1.1, s * .95, s * .22); co.fill(); co.stroke();
      for (let i = 0; i < 4; i++) { co.beginPath(); co.ellipse(-s * .41 + i * s * .275, s * .08, s * .15, s * .13, 0, 0, TAU); co.fill(); co.stroke(); } // phalanges
      co.beginPath(); co.moveTo(-s * .5, -s * .35); co.quadraticCurveTo(-s * .05, -s * .25, s * .25, -s * .42); co.stroke(); // le pouce
      co.restore();
    };
    const smash = (x, y, s) => {
      waves.add({ x, y, r: card.h * (.3 + .5 * s), life: .45 });
      for (let i = Math.round((7 + 14 * s) * q); i > 0; i--) { const a = rnd(-Math.PI, 0), v = card.h * rnd(2, 4.5 + 4 * s); shards.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 13, drag: .3, max: rnd(.5, .9), size: card.h * rnd(.03, .06) * (1 + s * .4), rot: rnd(TAU), spin: rnd(-10, 10), c: pick(STONE) }); }
      for (let i = Math.round((3 + 5 * s) * q); i > 0; i--) dust.add({ x: x + rnd(-1, 1) * card.h * .2, y, vx: rnd(-1, 1) * card.h * .6, vy: -card.h * rnd(.2, .6), drag: 1.5, g: 0, max: rnd(.8, 1.4), size: card.h * rnd(.12, .2) * (1 + s * .5) });
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        dust.step(dt); shards.step(dt);
        behind(env, () => dust.each((d, k) => dot(co, DUST, d.x, d.y, d.size * (1 + k), Math.sin(Math.PI * k) * (dark ? .35 : .45))));
        // le poing : il tombe (k < .2), frappe, reste, remonte et s'efface
        fists.run(dt, (f, k) => {
          const fall = k < .2 ? 1 - Math.pow(k / .2, 2) : k < .5 ? 0 : outCubic((k - .5) / .5) * .8, y = f.y - fall * card.h * 1.6, a = k < .1 ? k * 10 : k > .7 ? (1 - k) / .3 : 1;
          if (k < .22) for (let i = -1; i <= 1; i++) line(co, dark ? '#e7e5e4' : '#57534e', f.x + i * f.s * .35, y - f.s * 1.2, f.x + i * f.s * .35, y - f.s * 2.2, 1.5, .5 * a); // traits de vitesse
          fist(f.x, y - f.s * .1, f.s, a);
          if (!f.hit && k >= .2) { f.hit = true; smash(f.x, f.y, f.p); }
        });
        waves.run(dt, (w, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? '#fbbf24' : '#b45309'; co.lineWidth = 2.5 * (1 - k) + .5; co.beginPath(); co.ellipse(w.x, w.y, w.r * (.3 + k), w.r * (.3 + k) * .35, 0, 0, TAU); co.stroke(); });
        shards.each((p, k) => { co.save(); co.globalAlpha = 1 - k * k; co.translate(p.x, p.y); co.rotate(p.rot + p.spin * p.life); co.fillStyle = p.c; SHAPES.shard(co, p, p.size); co.restore(); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        // le poing touche le haut du rocher quand le chiffre se pose (la CSS frappe à 24 % de ses 0,5 s)
        fists.add({ x: p.x, y: p.y - card.h * .22, s: card.h * (o.last ? .55 : .42), p: o.last ? .9 : .45, life: .55 });
      },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { shards.add({ x: cx, y: card.y + card.h, vx: card.h * .8, vy: -card.h * .5, g: card.h * 6, drag: .5, max: 1.2, size: card.h * .05, rot: 0, spin: 6, c: STONE[1] }); return; } // un caillou roule
        fists.add({ x: cx, y: card.y + card.h * .05, s: card.h * (.5 + .35 * p), p: .6 + p, life: .7 });
        if (p >= 1) for (let i = 0; i < 2; i++) fists.add({ delay: .25 + i * .15, x: cx + (i ? 1 : -1) * card.w * .36, y: card.y + card.h * .1, s: card.h * .45, p: 1, life: .6 });
        for (let i = Math.round((4 + 26 * p) * q); i > 0; i--) shards.add({ x: rnd(card.x - 80, card.x + card.w + 80), y: card.y - card.h * rnd(.8, 1.6), vx: rnd(-10, 10), vy: rnd(0, 60), g: card.h * 8, drag: 0, max: rnd(.8, 1.4), size: card.h * rnd(.03, .07), rot: rnd(TAU), spin: rnd(-8, 8), c: pick(STONE) });
      },
    };
  };
  // 📱 Cracked Screen (2026-10-25, idée de KMC) — chaque chiffre qui se pose frappe la vitre : flash blanc au point
  // d'impact, éclats de verre qui sautent hors de l'écran, et des fissures en éclair qui partent du chiffre dans la vitre
  // (dans la carte, sous les chiffres) et restent : l'écran est de plus en plus cassé. À la révélation, un gros impact
  // au centre ; dès Epic des bandes de pixels qui bugent ; dès Mythic l'écran vole en éclats (fissures partout, pluie
  // de verre). Tirage raté : l'écran clignote et s'éteint un instant.
  SCENES.cracked = env => {
    const { co, ci, card, w, h, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const cracks = [], glass = particles(), flashes = timed(), bars = timed(), blinks = timed();
    // une fissure : un trait brisé de (x, y) dans une direction, avec une branche ; coordonnées de la carte (ci)
    const crack = (x, y, len, delay) => {
      const a = rnd(TAU), pts = [[x, y]]; let px = x, py = y, ang = a;
      for (let i = 0; i < 5; i++) { ang += rnd(-.5, .5); px += Math.cos(ang) * len / 5; py += Math.sin(ang) * len / 5; pts.push([px, py]); }
      cracks.push({ pts, t: -delay, br: 1 + ((Math.random() * 3) | 0) });
    };
    const impact = (gx, gy, s, n) => {
      flashes.add({ x: gx, y: gy, r: card.h * (.35 + .6 * s), life: .25 });
      for (let i = 0; i < n; i++) crack(gx - card.x, gy - card.y, card.h * rnd(.4, .8) * (1 + s), i * .02);
      for (let i = Math.round((6 + 14 * s) * q); i > 0; i--) { const a = rnd(TAU), v = card.h * rnd(1.5, 4 + 4 * s); glass.add({ x: gx, y: gy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - card.h, g: card.h * 10, drag: .4, max: rnd(.5, 1), size: card.h * rnd(.025, .055), rot: rnd(TAU), spin: rnd(-12, 12) }); }
    };
    return {
      frame(t, dt) {
        // les fissures, dans la vitre : elles se tracent en .12 s puis restent
        ci.globalCompositeOperation = 'source-over'; ci.lineJoin = 'round';
        for (const c of cracks) {
          c.t += dt; if (c.t <= 0) continue;
          const k = clamp(c.t / .12), n = Math.max(1, Math.round(k * (c.pts.length - 1)));
          ci.globalAlpha = .4; ci.strokeStyle = '#e0f2fe'; ci.lineWidth = 1.1;
          ci.beginPath(); ci.moveTo(c.pts[0][0], c.pts[0][1]); for (let i = 1; i <= n; i++) ci.lineTo(c.pts[i][0], c.pts[i][1]); ci.stroke();
          if (n >= c.br + 1) { const [bx, by] = c.pts[c.br], [nx, ny] = c.pts[c.br + 1]; ci.globalAlpha = .35; ci.beginPath(); ci.moveTo(bx, by); ci.lineTo(bx + (ny - by) * .8, by - (nx - bx) * .8); ci.stroke(); }
        }
        bars.run(dt, (b, k) => { if (Math.sin(t * 60 + b.y) > 0) { ci.globalAlpha = .35 * (1 - k); ci.fillStyle = b.c; ci.fillRect(0, b.y, w, b.hh); } });
        blinks.run(dt, (b, k) => { ci.globalAlpha = (k < .5 ? k * 2 : (1 - k) * 2) * .85; ci.fillStyle = '#000'; ci.fillRect(0, 0, w, h); });
        // dehors : flash d'impact et éclats de verre
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        flashes.run(dt, (f, k) => dot(co, dark ? '#e0f2fe' : '#38bdf8', f.x, f.y, f.r * (.6 + k), (1 - k) * .8));
        co.globalCompositeOperation = 'source-over';
        glass.step(dt);
        glass.each((p, k) => { co.save(); co.globalAlpha = (1 - k) * .9; co.translate(p.x, p.y); co.rotate(p.rot + p.spin * p.life); co.fillStyle = dark ? 'rgba(224,242,254,.8)' : 'rgba(14,116,144,.7)'; co.strokeStyle = dark ? '#fff' : '#0e7490'; co.lineWidth = .7; co.beginPath(); co.moveTo(0, -p.size * 1.4); co.lineTo(p.size, p.size * .6); co.lineTo(-p.size * .8, p.size); co.closePath(); co.fill(); co.stroke(); co.restore(); });
        ci.globalAlpha = co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; impact(p.x, p.y, o.last ? .8 : .35, o.last ? 3 : 1); },
      build() {},
      reveal(tier) {
        const P = POWER[tier] || 0;
        if (!P) { blinks.add({ life: .35 }); return; }
        impact(cx, cy, .5 + .8 * P, 3 + Math.round(4 * P));
        if (P >= .6) for (let i = Math.round(4 + 6 * P); i > 0; i--) bars.add({ delay: rnd(0, .5), y: rnd(0, h), hh: rnd(2, 7), c: pick(['#ef4444', '#22d3ee', '#a3e635', '#f0abfc']), life: rnd(.3, .7) });
        if (P >= 1) { // l'écran vole en éclats
          for (let i = 0; i < 6; i++) setTimeout(() => impact(card.x + card.w * (.1 + .16 * i), card.y + card.h * rnd(.2, .8), .5, 2), 120 + i * 60);
          for (let i = Math.round(40 * q); i > 0; i--) glass.add({ x: rnd(card.x - 60, card.x + card.w + 60), y: card.y - rnd(20, 120), vx: rnd(-20, 20), vy: rnd(0, 80), g: card.h * 6, drag: 0, max: rnd(1, 1.6), size: card.h * rnd(.03, .06), rot: rnd(TAU), spin: rnd(-8, 8) });
        }
      },
    };
  };
  // 🏰 Medieval Castle (2026-10-25, idée de BIGBOIJONER69) — deux torches de part et d'autre du rempart : un bâton,
  // une coupelle de fer, une flamme qui vacille et des braises qui montent ; elles flambent plus haut avant le dernier
  // chiffre. Chaque bannière qui se déroule lâche une gerbe d'étincelles d'or. À la révélation, des fusées partent de
  // derrière les créneaux et éclatent en feu d'artifice (plus nombreuses avec la rareté, couronne d'or dès Mythic) ;
  // tirage raté : les torches baissent un instant.
  SCENES.castle = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const embers = particles(), sparks = particles(), rockets = timed(), emit = emitter();
    let blaze = 1, target = 1;
    const COLS = ['#f87171', '#60a5fa', '#fde047', '#a3e635', '#f0abfc'];
    const torches = () => [card.x - card.h * .32, card.x + card.w + card.h * .32];
    const burst = (x, y, c, n, sp) => { for (let i = 0; i < n; i++) { const a = (i / n) * TAU + rnd(-.1, .1), v = sp * rnd(.8, 1.1); sparks.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 2.2, drag: 1.4, max: rnd(.9, 1.4), size: rnd(1.6, 2.6), c }); } };
    return {
      frame(t, dt) {
        blaze += (target - blaze) * Math.min(1, dt * 3);
        const add = dark ? 'lighter' : 'source-over';
        for (const x of torches()) {
          const top = card.y + card.h * .25, base = card.y + card.h * 1.05;
          co.globalCompositeOperation = 'source-over';
          line(co, '#78350f', x, top + card.h * .1, x, base, card.h * .07, 1); // le bâton
          co.globalAlpha = 1; co.fillStyle = '#44403c'; co.beginPath(); co.moveTo(x - card.h * .12, top); co.lineTo(x + card.h * .12, top); co.lineTo(x + card.h * .06, top + card.h * .12); co.lineTo(x - card.h * .06, top + card.h * .12); co.closePath(); co.fill();
          co.globalCompositeOperation = add;
          const f = blaze * (1 + .12 * Math.sin(t * 17 + x) + .08 * Math.sin(t * 29));
          dot(co, '#f97316', x, top - card.h * .12 * f, card.h * .3 * f, .5, card.h * .42 * f);
          dot(co, '#fde047', x, top - card.h * .06 * f, card.h * .14 * f, .9, card.h * .24 * f);
          if (dark) dot(co, '#fb923c', x, top, card.h * .9, .12 * blaze);
          for (let n = emit(3 * blaze * q, dt / 2); n > 0; n--) embers.add({ x: x + rnd(-3, 3), y: top - card.h * .2, vx: rnd(-8, 8), vy: -card.h * rnd(.6, 1.2), drag: .5, g: 0, max: rnd(.6, 1.1), size: rnd(1, 2), c: '#fdba74' });
        }
        embers.step(dt); sparks.step(dt);
        co.globalCompositeOperation = add;
        embers.each((e, k) => dot(co, e.c, e.x + Math.sin(e.life * 9) * 2, e.y, e.size * 2, (1 - k) * .9));
        rockets.run(dt, (r, k) => {
          if (k < .5) { const kk = k / .5, y = r.y0 + (r.y1 - r.y0) * outCubic(kk); tail(co, dark ? '#fde68a' : '#ca8a04', r.x, y + card.h * .5, r.x, y, 2, .9); dot(co, '#fff7ed', r.x, y, 3, 1); }
          else if (!r.done) { r.done = true; burst(r.x, r.y1, r.c, Math.round((18 + 14 * r.p) * q), card.h * (1.6 + 1.2 * r.p)); }
        });
        sparks.each((s, k) => { dot(co, s.c, s.x, s.y, s.size * 2.2, (1 - k) * (dark ? 1 : .9)); if (!dark) { co.globalAlpha = 1 - k; co.fillStyle = s.c; co.fillRect(s.x - 1, s.y - 1, 2, 2); } });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        for (let i = Math.round((o.last ? 16 : 8) * q); i > 0; i--) { const a = rnd(-Math.PI, 0), v = card.h * rnd(1, o.last ? 3 : 2); sparks.add({ x: p.x, y: card.y + card.h * .2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 4, drag: 1, max: rnd(.4, .8), size: rnd(1.2, 2), c: '#fde047' }); }
      },
      build() { target = 1.5; },
      reveal(tier) {
        const P = POWER[tier] || 0;
        if (!P) { blaze = .4; target = 1; return; }
        target = 1 + .4 * P;
        const n = 1 + Math.round(5 * P);
        for (let i = 0; i < n; i++) rockets.add({ delay: i * .18, life: .9, x: cx + rnd(-.6, .6) * card.w, y0: card.y + card.h * .1, y1: card.y - card.h * rnd(.8, 1.5), c: pick(COLS), p: P });
        if (P >= 1) rockets.add({ delay: n * .18 + .1, life: 1, x: cx, y0: card.y, y1: card.y - card.h * 1.6, c: '#fde047', p: 1.8 + .3 * (ASCEND[tier] || 0) });
      },
    };
  };
  // 🍫 Chocolate (2026-10-25, idée de finnnnn) — chaque carré qui se fige lâche des miettes de chocolat et un éclat
  // brillant ; le dernier, plus. À la révélation, des morceaux de chocolat et des confettis de papier doré sautent
  // autour de la tablette (plus avec la rareté) ; dès Mythic, du chocolat fondu coule du haut de la carte en grosses
  // gouttes rondes qui s'allongent (seulement sur le bord, les chiffres restent lisibles). Tirage raté : une miette.
  SCENES.chocolate = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const crumbs = particles(), foil = particles(), glints = timed(), drips = timed();
    const CHOC = ['#7b3f1c', '#5e2e12', '#a0592c', '#3b1d0c'], GOLD = ['#fde68a', '#ca8a04', '#fef3c7', '#b45309'];
    const crumb = (x, y, n, s) => { for (let i = Math.round(n * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = card.h * rnd(1.5, 3 + 3 * s); crumbs.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 12, drag: .3, max: rnd(.5, .9), size: card.h * rnd(.02, .045) * (1 + s * .5), rot: rnd(TAU), spin: rnd(-10, 10), c: pick(CHOC) }); } };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // les coulures, sur le bord du haut : une bande, puis des gouttes qui s'allongent et pendent
        drips.run(dt, (d, k) => {
          const grow = outCubic(Math.min(1, k / .5)), a = k > .8 ? (1 - k) * 5 : 1, top = card.y - 2;
          co.globalAlpha = a; co.fillStyle = '#9a552a';
          roundRect(co, card.x, top, card.w, card.h * .1 * grow, 4); co.fill();
          for (const g of d.g) { const len = card.h * g.l * grow, x = card.x + card.w * g.x; co.fillRect(x - g.w / 2, top, g.w, len); co.beginPath(); co.arc(x, top + len, g.w * .75, 0, TAU); co.fill(); co.fillStyle = 'rgba(247,210,168,.55)'; co.fillRect(x - g.w * .3, top + 2, g.w * .18, len * .8); co.fillStyle = '#9a552a'; }
          co.fillStyle = 'rgba(222,160,110,.5)'; co.fillRect(card.x + 4, top + 1, card.w - 8, 2);
        });
        crumbs.step(dt); foil.step(dt);
        crumbs.each((p, k) => { co.save(); co.globalAlpha = 1 - k * k; co.translate(p.x, p.y); co.rotate(p.rot + p.spin * p.life); co.fillStyle = p.c; co.fillRect(-p.size, -p.size * .8, p.size * 2, p.size * 1.6); co.restore(); });
        foil.each((p, k) => { co.save(); co.globalAlpha = 1 - k * k; co.translate(p.x, p.y); co.rotate(p.rot + p.spin * p.life); co.scale(Math.cos(p.life * 10 + p.rot), 1); co.fillStyle = p.c; co.fillRect(-p.size, -p.size * .6, p.size * 2, p.size * 1.2); co.restore(); });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        glints.run(dt, (g, k) => { const a = Math.sin(Math.PI * k); dot(co, '#ffffff', g.x, g.y, g.r * .3, a); dot(co, '#fde68a', g.x, g.y, g.r, a * .5, g.r * .15); dot(co, '#fde68a', g.x, g.y, g.r * .15, a * .5, g.r); });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        crumb(p.x, p.y, o.last ? 14 : 7, o.last ? .9 : .4);
        glints.add({ x: p.x - card.h * .15, y: p.y - card.h * .2, r: card.h * (o.last ? .35 : .22), life: .35 });
      },
      build() {},
      reveal(tier) {
        const P = POWER[tier] || 0;
        if (!P) { crumb(cx, card.y + card.h * .5, 1, .2); return; }
        for (let i = 0; i < 1 + Math.round(3 * P); i++) crumb(cx + rnd(-.45, .45) * card.w, card.y + card.h * .3, 8, .5 + P);
        if (P >= .4) for (let i = Math.round((10 + 40 * P) * q); i > 0; i--) { const a = rnd(-Math.PI * .9, -Math.PI * .1), v = card.h * rnd(2, 4 + 3 * P); foil.add({ x: cx + rnd(-.4, .4) * card.w, y: card.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 4, drag: 1.2, max: rnd(1.2, 2), size: card.h * rnd(.04, .07), rot: rnd(TAU), spin: rnd(-6, 6), c: pick(GOLD) }); }
        if (P >= 1) drips.add({ delay: .2, life: 3.2 + .5 * (ASCEND[tier] || 0), g: Array.from({ length: 7 }, (_, i) => ({ x: .08 + i * .14 + rnd(-.03, .03), l: rnd(.25, .45), w: card.h * rnd(.07, .11) })) });
        for (let i = 0; i < 2 + Math.round(4 * P); i++) glints.add({ delay: rnd(0, .6), x: cx + rnd(-.5, .5) * card.w, y: card.y + card.h * rnd(.1, .9), r: card.h * .3, life: .4 });
      },
    };
  };
  // 🐟 Floppy Fish (2026-10-25, idée d'AnnJoe) — à chaque chiffre posé, un poisson rigolo (orange, gros œil qui louche,
  // bouche ronde) jaillit de la mare à côté du chiffre, fait un saut en arc en gigotant et replonge de l'autre côté :
  // éclaboussure à la sortie et à l'entrée. Le dernier saute plus haut. À la révélation, plusieurs poissons sautent
  // (plus avec la rareté) ; dès Mythic, un poisson GÉANT bondit derrière la carte d'un bord à l'autre et retombe dans
  // une énorme gerbe. Tirage raté : un poisson sort la tête et fait une bulle.
  SCENES.fish = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, water = card.y + card.h * .36;
    const fishes = timed(), drops = particles(), bubbles = timed();
    const COLS = [['#fb923c', '#ea580c'], ['#facc15', '#ca8a04'], ['#f472b6', '#db2777'], ['#4ade80', '#16a34a']];
    // un poisson de profil, nez vers +x : corps ovale, queue en V, nageoire, œil énorme, bouche ronde
    const fishShape = (x, y, s, ang, wig, col, a) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(ang);
      co.lineWidth = Math.max(1.2, s * .08); co.strokeStyle = '#7c2d12'; co.fillStyle = col[0];
      co.beginPath(); co.moveTo(-s * .8, 0); co.lineTo(-s * 1.35, -s * .5 + wig * s * .2); co.lineTo(-s * 1.25, s * .5 + wig * s * .2); co.closePath(); co.fill(); co.stroke(); // la queue
      co.beginPath(); co.ellipse(0, 0, s, s * .58, 0, 0, TAU); co.fill(); co.stroke();
      co.fillStyle = col[1]; co.beginPath(); co.moveTo(-s * .2, -s * .5); co.quadraticCurveTo(s * .1, -s * 1.05, s * .35, -s * .5); co.fill(); // nageoire
      co.fillStyle = '#fff'; co.beginPath(); co.arc(s * .45, -s * .15, s * .3, 0, TAU); co.fill(); co.stroke();
      co.fillStyle = '#111'; co.beginPath(); co.arc(s * .52 + wig * s * .06, -s * .1, s * .13, 0, TAU); co.fill(); // la pupille qui louche
      co.fillStyle = '#7c2d12'; co.beginPath(); co.arc(s * .95, s * .12, s * .12, 0, TAU); co.fill(); // la bouche en O
      co.restore();
    };
    const splash = (x, s) => {
      for (let i = Math.round((6 + 12 * s) * q); i > 0; i--) { const a = rnd(-Math.PI * .85, -Math.PI * .15), v = card.h * rnd(2, 3.5 + 4 * s); drops.add({ x: x + rnd(-1, 1) * card.h * .08, y: water, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 12, drag: .2, max: rnd(.4, .75), size: card.h * rnd(.025, .045) * (1 + s) }); }
    };
    const jump = (x, s, h, delay, giant) => fishes.add({ delay, x0: x - card.h * .45 * s * (giant ? 4 : 1), x1: x + card.h * .45 * s * (giant ? 4 : 1), s: card.h * .2 * s * (giant ? 3.2 : 1), h: card.h * h, life: giant ? 1.4 : .6, col: pick(COLS), giant });
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        const drawFish = (f, k) => {
          const x = lerp(f.x0, f.x1, k), y = water - Math.sin(Math.PI * k) * f.h, ang = Math.atan2(-Math.cos(Math.PI * k) * f.h * Math.PI, f.x1 - f.x0) * (f.x1 > f.x0 ? 1 : -1);
          if (!f.out && k > .02) { f.out = true; splash(f.x0, f.giant ? 1.4 : .4); }
          if (!f.in && k > .96) { f.in = true; splash(f.x1, f.giant ? 2 : .5); }
          fishShape(x, y, f.s, ang + Math.sin(t * 30) * .25, Math.sin(t * 40), f.col, k < .04 || k > .96 ? .5 : 1);
        };
        // le poisson géant passe derrière la carte (les chiffres restent devant)
        behind(env, () => fishes.run(0, (f, k) => { if (f.giant) drawFish(f, k); }));
        fishes.run(dt, (f, k) => { if (!f.giant) drawFish(f, k); });
        drops.step(dt);
        drops.each((d, k) => { co.globalAlpha = 1 - k * k; co.fillStyle = dark ? '#e0f2fe' : '#0ea5e9'; co.beginPath(); co.ellipse(d.x, d.y, d.size, d.size * 1.3, 0, 0, TAU); co.fill(); });
        bubbles.run(dt, (b, k) => { co.globalAlpha = 1 - k; co.strokeStyle = dark ? '#e0f2fe' : '#0369a1'; co.lineWidth = 1.5; co.beginPath(); co.arc(b.x, water - card.h * .3 - k * card.h * .5, card.h * (.06 + .06 * k), 0, TAU); co.stroke(); fishShape(b.x, water - card.h * .05, card.h * .16, -Math.PI / 2, 0, COLS[0], k < .6 ? 1 : (1 - k) * 2.5); });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; jump(p.x, o.last ? 1.3 : 1, o.last ? 1.2 : .8, 0, false); },
      build() {},
      reveal(tier) {
        const P = POWER[tier] || 0;
        if (!P) { bubbles.add({ x: cx, life: 1.1 }); return; }
        for (let i = 0; i < 1 + Math.round(4 * P); i++) jump(cx + rnd(-.45, .45) * card.w, rnd(.9, 1.3), rnd(.8, 1.3), i * .15, false);
        if (P >= 1) jump(cx, 1.2 + .15 * (ASCEND[tier] || 0), 1.05, .3, true);
      },
    };
  };
  // 🪓 Axe Thrower (2026-10-25, idée de jjcoolcid1) — un bonhomme bâton se tient à gauche de la carte. Il se balance
  // en attendant ; à chaque chiffre posé, il arme le bras et lance une hache qui tournoie jusqu'à la cible et s'y plante
  // (copeaux de bois) : les haches restent plantées en haut des cibles. Avant le dernier chiffre il trépigne. À la
  // révélation il fait la fête (bras en l'air, sauts ; plus haut avec la rareté) ; dès Mythic, une volée de haches
  // tourne autour de la carte. Tirage raté : il hausse les épaules.
  SCENES.axeman = env => {
    const { co, card, q, dark } = env;
    const ink = dark ? '#e5e7eb' : '#1f2937';
    const manX = card.x - card.h * .85, feet = card.y + card.h * 1.02, H = card.h * 1.25;
    const flying = timed(), stuck = [], chips = particles(), volley = timed();
    let throwT = 9, mood = 'idle', moodT = 0, power = 0, jitter = 0;
    const axe = (x, y, ang, s, a = 1) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(ang);
      co.strokeStyle = '#92400e'; co.lineWidth = Math.max(1.5, s * .12); co.lineCap = 'round';
      co.beginPath(); co.moveTo(0, 0); co.lineTo(-s, 0); co.stroke(); // le manche ; la tête au bout (0, 0)
      co.fillStyle = '#cbd5e1'; co.strokeStyle = '#334155'; co.lineWidth = 1;
      co.beginPath(); co.moveTo(-s * .12, -s * .12); co.lineTo(s * .18, -s * .38); co.quadraticCurveTo(s * .3, 0, s * .18, s * .38); co.lineTo(-s * .12, s * .12); co.closePath(); co.fill(); co.stroke();
      co.restore();
    };
    const hand = () => ({ x: manX + H * .22, y: feet - H * .82 });
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        throwT += dt; moodT += dt;
        // le bonhomme : tête, corps, jambes, deux bras ; la pose dépend du moment
        const bob = mood === 'party' ? Math.abs(Math.sin(moodT * 9)) * H * (.08 + .14 * power) : mood === 'wait' ? Math.abs(Math.sin(t * 16)) * H * .03 : Math.sin(t * 2.5) * H * .01;
        const hipY = feet - H * .45 - bob, neckY = feet - H * .78 - bob, headY = neckY - H * .1, x = manX;
        co.globalAlpha = 1; co.strokeStyle = ink; co.lineWidth = Math.max(2, H * .045); co.lineCap = 'round'; co.lineJoin = 'round';
        co.beginPath(); co.arc(x, headY, H * .09, 0, TAU); co.stroke();
        co.beginPath(); co.moveTo(x, neckY); co.lineTo(x, hipY); co.moveTo(x - H * .14, feet - bob * .3); co.lineTo(x, hipY); co.lineTo(x + H * .14, feet - bob * .3); co.stroke();
        const sh = neckY + H * .06;
        let la, ra; // angles des bras (0 = vers la droite)
        if (mood === 'party') { la = -Math.PI * .7 + Math.sin(moodT * 12) * .3; ra = -Math.PI * .3 - Math.sin(moodT * 12) * .3; }
        else if (mood === 'shrug') { la = -Math.PI * .85; ra = -Math.PI * .15; }
        else { const k = throwT / .18; la = Math.PI * .65; ra = k < .5 ? -Math.PI * .9 : k < 1 ? lerp(-Math.PI * .9, .1, (k - .5) * 2) : .35; } // il arme, puis lance
        const arm = a => { co.beginPath(); co.moveTo(x, sh); co.lineTo(x + Math.cos(a) * H * .3, sh + Math.sin(a) * H * .3); co.stroke(); };
        arm(la); arm(ra);
        if (mood === 'idle' && throwT > .25 && throwT < 9) axe(x + Math.cos(ra) * H * .3, sh + Math.sin(ra) * H * .3, -Math.PI / 2, card.h * .4, Math.min(1, (throwT - .25) * 4)); // une hache neuve en main
        // les haches en vol : un arc, elles tournent vite, puis se plantent
        flying.run(dt, (f, k) => {
          const hx = lerp(f.x0, f.x1, k), hy = lerp(f.y0, f.y1, k) - Math.sin(Math.PI * k) * card.h * .6;
          axe(hx, hy, f.spin + k * TAU * 2.5, card.h * .42);
          if (!f.done && k > .95) { f.done = true; stuck.push({ x: f.x1, y: f.y1, ang: -Math.PI * .72 + rnd(-.15, .15), t: 0 });
            for (let i = Math.round(8 * q); i > 0; i--) { const a = rnd(-Math.PI, 0), v = card.h * rnd(1.5, 3.5); chips.add({ x: f.x1, y: f.y1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 12, drag: .3, max: rnd(.4, .7), size: card.h * rnd(.02, .04), rot: rnd(TAU), spin: rnd(-12, 12), c: pick(['#f5deb3', '#d9b77f', '#7c4a22']) }); } }
        });
        // les haches plantées : la tête dans le bois, le manche qui vibre un instant
        for (const s of stuck) { s.t += dt; const wob = Math.exp(-s.t * 8) * Math.sin(s.t * 60) * .25; axe(s.x, s.y, s.ang + Math.PI + wob, card.h * .42); }
        volley.run(dt, (v, k) => { const a = v.a0 + k * TAU * 1.2, r = card.w * .62, cx = card.x + card.w / 2, cy = card.y + card.h / 2; axe(cx + Math.cos(a) * r, cy + Math.sin(a) * r * .9, a * 3, card.h * .42, k > .85 ? (1 - k) / .15 : 1); });
        chips.step(dt);
        chips.each((p, k) => { co.save(); co.globalAlpha = 1 - k; co.translate(p.x, p.y); co.rotate(p.rot + p.spin * p.life); co.fillStyle = p.c; co.fillRect(-p.size, -p.size * .4, p.size * 2, p.size * .8); co.restore(); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        const h = hand();
        throwT = 0; mood = 'idle';
        flying.add({ x0: h.x, y0: h.y - card.h * .3, x1: p.x - card.h * .1, y1: p.y - card.h * .3, spin: rnd(TAU), life: .22 + (p.x - card.x) / card.w * .12 });
      },
      build() { mood = 'wait'; },
      reveal(tier) {
        const P = POWER[tier] || 0;
        moodT = 0; power = P;
        if (!P) { mood = 'shrug'; return; }
        mood = 'party';
        if (P >= 1) for (let i = 0; i < 4 + (ASCEND[tier] || 0); i++) volley.add({ delay: i * .12, life: 1.6, a0: (i / 4) * TAU });
      },
    };
  };
  // ➗ Math (2026-10-25, idée de sennybex1) — des symboles mathématiques (+ − × ÷ = π √ ∑ ∞ %) flottent lentement
  // autour du tableau, plus vite pendant le tirage. Chaque chiffre écrit lâche un petit nuage de poussière de craie et
  // fait sauter un symbole. À la révélation, les symboles jaillissent (plus nombreux avec la rareté) ;
  // dès Mythic, « Q.E.D. » s'écrit au-dessus. Tirage raté : un « ≠ » tombe, tout penaud.
  SCENES.math = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const SYM = ['+', '−', '×', '÷', '=', 'π', '√', '∑', '∞', '%', '∫', 'x²'];
    const ink = dark ? '#f8fafc' : '#166534', dustC = dark ? '#e2e8f0' : '#94a3b8';
    const syms = particles(), dust = particles(), words = timed(), emit = emitter();
    let speed = .4;
    const sym = (x, y, vx, vy, o = {}) => syms.add(Object.assign({ x, y, vx, vy, g: 0, drag: .6, max: rnd(2.2, 3.4), size: card.h * rnd(.18, .3), ch: pick(SYM), rot: rnd(-.4, .4), spin: rnd(-1, 1) }, o));
    const chalk = (s, x, y, size, a, k) => { // un mot à la craie qui s'écrit de gauche à droite (k de 0 à 1)
      co.save(); co.globalAlpha = a; co.font = `italic 700 ${size}px Georgia, "Times New Roman", serif`; co.textAlign = 'left'; co.textBaseline = 'middle';
      const w = co.measureText(s).width; co.beginPath(); co.rect(x - w / 2, y - size, w * clamp(k), size * 2); co.clip();
      co.fillStyle = dark ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.6)'; co.fillText(s, x - w / 2 + 1.5, y + 1.5);
      co.fillStyle = ink; co.fillText(s, x - w / 2, y); co.restore();
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // les symboles qui flottent tout autour (derrière la carte : jamais sur un chiffre)
        for (let n = emit(2.2 * speed * q, dt); n > 0; n--) { const side = Math.random() < .5 ? -1 : 1; sym(cx + side * (card.w * .5 + rnd(10, 80)), card.y + card.h * rnd(-.6, 1.4), side * rnd(4, 14), -rnd(6, 20) * (1 + speed)); }
        speed += (.4 - speed) * Math.min(1, dt * .6);
        syms.step(dt); dust.step(dt);
        behind(env, () => {
          syms.each((s, k) => { co.save(); co.globalAlpha = Math.sin(Math.PI * k) * (dark ? .75 : .85); co.translate(s.x, s.y); co.rotate(s.rot + s.spin * s.life); co.font = `italic 700 ${s.size}px Georgia, "Times New Roman", serif`; co.textAlign = 'center'; co.textBaseline = 'middle'; co.fillStyle = ink; co.fillText(s.ch, 0, 0); co.restore(); });
          dust.each((d, k) => dot(co, dustC, d.x, d.y, d.size * (1 + k * 1.5), (1 - k) * .5));
        });
        words.run(dt, (w, k) => { const a = k > .8 ? (1 - k) * 5 : 1; chalk(w.s, w.x, w.y, w.size, a, k / .3); if (w.line) { co.globalAlpha = a; co.strokeStyle = ink; co.lineWidth = 2.5; co.lineCap = 'round'; const L = card.w * .4 * clamp(k / .25); for (const dy of [-4, 4]) { co.beginPath(); co.moveTo(cx - card.w * .2, w.y + dy); co.lineTo(cx - card.w * .2 + L, w.y + dy); co.stroke(); } } });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        for (let i = Math.round((o.last ? 8 : 4) * q); i > 0; i--) dust.add({ x: p.x + rnd(-1, 1) * card.h * .2, y: p.y + card.h * .25, vx: rnd(-1, 1) * card.h * .4, vy: -card.h * rnd(.1, .4), drag: 1.5, g: 0, max: rnd(.6, 1), size: card.h * rnd(.06, .12) });
        sym(p.x, card.y - 4, rnd(-30, 30), -card.h * rnd(1.2, 2), { max: 1.2, size: card.h * (o.last ? .34 : .26), drag: 1.4 });
        speed = Math.min(2.5, speed + .3);
      },
      build() { speed = 2.5; },
      reveal(tier) {
        const P = POWER[tier] || 0;
        if (!P) { syms.add({ x: cx, y: card.y - card.h * .5, vx: 0, vy: 0, g: card.h * 2.5, drag: 0, max: 1.2, size: card.h * .4, ch: '≠', rot: 0, spin: 1.2 }); return; }
        for (let i = Math.round((6 + 30 * P) * q); i > 0; i--) { const a = rnd(TAU), v = card.h * rnd(1.5, 3 + 3 * P); sym(cx + Math.cos(a) * card.w * .3, card.y + card.h / 2 + Math.sin(a) * card.h * .3, Math.cos(a) * v, Math.sin(a) * v, { max: rnd(1, 1.8), drag: 1.2 }); }
        if (P >= 1) words.add({ delay: .45, s: 'Q.E.D.', x: cx, y: card.y - card.h * .45, size: card.h * (.42 + .06 * (ASCEND[tier] || 0)), life: 2.8 + .5 * (ASCEND[tier] || 0) });
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
    // Anomaly et Godlike ajoutés (Deadshot, 2026-10-30) : Godlike, plus récente que le skin, laissait le ciel bleu.
    const TINT = { anomaly: [251, 146, 60], mythic: [244, 114, 182], celestial: [103, 232, 249], divine: [253, 224, 71], godlike: [225, 29, 72] };
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

  // 🎄 Christmas Morning (2026-10-25, idées de JBearr12 et Angelicide9) — chaque cadeau qui s'ouvre lâche des
  // confettis rouges, verts et dorés ; la neige tombe doucement autour de la carte, plus fort après un beau tirage ;
  // dès Epic une étoile dorée s'allume au-dessus de la carte, dès Mythic elle rayonne et une averse d'étoiles tombe.
  SCENES.christmas = custom(pieces({ cols: ['#ef4444', '#22c55e', '#fbbf24', '#f8fafc'], shapes: ['sprinkle', 'star', 'square'], size: [1.6, 3.4], g: 520, spin: 8, up: true, glowc: '#fbbf24', ring: '#ef4444', drift: { rate: 1.2, from: 'around' } }), (env, { cx, st }) => {
    const { co, card, q, dark } = env, snow = particles(), emit = emitter(), stars = timed(), SNOW = dark ? '#f8fafc' : '#94a3b8';
    const flake = y => snow.add({ x: rnd(card.x - card.w * .3, card.x + card.w * 1.3), y, vx: rnd(-8, 8), vy: rnd(18, 42), max: rnd(2.5, 4), size: rnd(1, 2.4), ph: rnd(TAU) });
    return {
      frame(t, dt) {
        const rate = (3 + (st.revealed ? 40 * st.p * Math.max(0, 1 - st.since / 5) : 0)) * q;
        for (let n = emit(rate, dt); n > 0; n--) flake(card.y - card.h * rnd(.2, .9));
        snow.step(dt);
        co.globalCompositeOperation = 'source-over';
        snow.each((s, k) => { co.globalAlpha = Math.min(1, k * 6, (1 - k) * 3) * .85; co.fillStyle = SNOW; co.beginPath(); co.arc(s.x + Math.sin(t * 2 + s.ph) * 4, s.y, s.size, 0, TAU); co.fill(); });
        stars.run(dt, (s, k) => {
          const a = Math.min(1, k * 5, (1 - k) * 2.5), y = card.y - card.h * .45;
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          if (s.rays) godrays(co, '#fde68a', cx, y, 10, card.h * .2, card.h * (.9 + .4 * s.p), t * .4, 6, a * .5);
          dot(co, '#fbbf24', cx, y, card.h * (.5 + .3 * Math.sin(t * 5)), a * .7);
          co.globalCompositeOperation = 'source-over';
          co.save(); co.translate(cx, y); co.rotate(Math.sin(t * 2) * .1); co.globalAlpha = a; co.fillStyle = '#fde047';
          co.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? card.h * .1 : card.h * .24, ang = -Math.PI / 2 + (i * Math.PI) / 5; co.lineTo(Math.cos(ang) * r, Math.sin(ang) * r); } co.closePath(); co.fill();
          co.strokeStyle = '#b45309'; co.lineWidth = 1.2; co.stroke(); co.restore();
          if (s.rays && Math.random() < dt * 30 * q) snow.add({ x: cx + rnd(-1, 1) * card.w * .7, y: y, vx: rnd(-30, 30), vy: rnd(40, 110), max: 1.6, size: rnd(1.5, 2.6), ph: 0 });
        });
      },
      lock() {},
      reveal(tier, p) {
        if (p >= .6) stars.add({ delay: .15, life: 2.6 + 1.2 * p + (ASCEND[tier] || 0) * .4, p, rays: p >= 1 });
        for (let i = Math.round(30 * p * q); i > 0; i--) flake(card.y - rnd(0, card.h * 1.2));
      },
    };
  });

  // 🌭 Hot Dog (2026-10-26, idée de finnnnn) — chaque chiffre qui se pose trace derrière lui un zigzag de sauce sur la
  // saucisse (ketchup, puis moutarde, un sur deux, comme les chiffres), et des gouttes giclent. À la révélation, de la
  // vapeur monte du pain, plus haute avec la rareté ; dès Mythic, deux longs filets (ketchup et moutarde) habillent le
  // hot-dog d'un bout à l'autre. Tirage raté : une goutte de moutarde tombe à côté.
  SCENES.hotdog = custom(pieces({ cols: ['#ff3a2f', '#ffd21f', '#e11d1d', '#f5b800'], shapes: ['drop'], size: [2.2, 4.2], g: 820, spin: 0, up: true, glowc: '#fbbf24', ring: '#ef4444', drift: { rate: .6, from: 'around' } }), (env, { st }) => {
    const { ci, co, w, h, card, q, dark, el } = env, lines = [], steam = particles(), plops = particles(), emit = emitter();
    // [sauce, bord sombre, reflet] : ketchup pour les chiffres impairs, moutarde pour les pairs (comme le CSS)
    const SAUCE = [['#ff3a2f', '#6b0707', '#ffb4a8'], ['#ffd21f', '#6b4700', '#fff6c4']];
    const slotIndex = x => { // rang du chiffre le plus proche (fantômes compris, comme :nth-of-type)
      const slots = el ? [...el.querySelectorAll('.slot')] : [];
      if (!slots.length) return 0;
      const b = el.getBoundingClientRect(), k = card.w / (b.width || 1);
      let best = 0, d = Infinity;
      slots.forEach((s, i) => { const r = s.getBoundingClientRect(), dx = Math.abs(card.x + (r.left + r.width / 2 - b.left) * k - x); if (dx < d) { d = dx; best = i; } });
      return best;
    };
    // un filet en zigzag, tracé au fur et à mesure (k de 0 à 1) : bord sombre, sauce, reflet
    const drizzle = (L, k) => {
      const upto = L.zig * clamp(k), pts = [];
      const at = i => [L.x0 + (L.x1 - L.x0) * i / L.zig, L.y + (i % 2 ? L.amp : -L.amp) * (1 + .15 * Math.sin(i * 2.1 + L.seed))];
      for (let i = 0; i <= Math.floor(upto); i++) pts.push(at(i));
      const f = upto - Math.floor(upto);
      if (f > 0) { const a = at(Math.floor(upto)), b = at(Math.floor(upto) + 1); pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
      if (pts.length < 2) return;
      const [col, edge, hi] = SAUCE[L.c];
      ci.lineCap = ci.lineJoin = 'round';
      for (const [wk, c, dy] of [[1.4, edge, .12], [1, col, 0], [.32, hi, -.22]]) {
        ci.globalAlpha = L.a; ci.strokeStyle = c; ci.lineWidth = L.wd * wk; ci.beginPath();
        pts.forEach(([x, y], i) => (i ? ci.lineTo(x, y + L.wd * dy) : ci.moveTo(x, y + L.wd * dy))); ci.stroke();
      }
    };
    return {
      frame(t, dt) {
        ci.globalCompositeOperation = 'source-over';
        for (const L of lines) { L.t += dt; if (L.t > 0) drizzle(L, L.t / L.dur); }
        // la vapeur : des bouffées qui montent du pain et s'élargissent
        steam.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        steam.each((s, k) => dot(co, dark ? '#e5e7eb' : '#94a3b8', s.x + Math.sin(s.life * 2 + s.ph) * 8, s.y, s.size * (1 + 2.2 * k), Math.sin(Math.PI * k) * (dark ? .22 : .3)));
        plops.step(dt);
        co.globalCompositeOperation = 'source-over';
        plops.each((p, k) => { co.globalAlpha = 1 - k * k; co.fillStyle = '#f5b800'; co.strokeStyle = '#6b4700'; co.lineWidth = 1; co.beginPath(); co.ellipse(p.x, p.y, 3.5, 5, 0, 0, TAU); co.fill(); co.stroke(); });
        co.globalAlpha = 1;
      },
      lock(pt, o) {
        if (o.ghost) return;
        const x = pt.x - card.x, sw = h * .5;
        lines.push({ x0: x - sw * .55, x1: x + sw * .55, y: h * .5, amp: h * .2, zig: 3, wd: Math.max(2, h * .05), c: slotIndex(pt.x) % 2, t: 0, dur: .28, a: .7, seed: rnd(TAU) });
      },
      reveal(tier, p) {
        if (!p) { plops.add({ x: card.x + card.w * rnd(.2, .8), y: card.y - 10, vx: rnd(-20, 20), vy: 20, g: 600, max: 1.1 }); return; }
        for (let i = Math.round((4 + 26 * p) * q); i > 0; i--) steam.add({ x: card.x + rnd(.08, .92) * card.w, y: card.y + rnd(-4, 8), vx: rnd(-6, 6), vy: -rnd(25, 45 + 60 * p), drag: .4, max: rnd(1.2, 1.8 + 1.4 * p), size: rnd(5, 10), ph: rnd(TAU) });
        if (p >= 1) {
          const extra = ASCEND[tier] || 0;
          [0, 1].forEach(c => lines.push({ x0: w * .05, x1: w * .95, y: h * (c ? .74 : .26), amp: h * .04, zig: 16 + 4 * extra, wd: Math.max(2, h * .04), c, t: -.15 - c * .25, dur: .9, a: .85, seed: rnd(TAU) }));
        }
      },
    };
  });

  // ☢️ Radioactive (2026-10-26, idée de shadow2) — des bulles montent sans cesse dans la gelée verte au fond du fût ;
  // chaque chiffre qui se pose fait crépiter le compteur Geiger (de petits éclats verts tout autour) et part en onde.
  // À la révélation, des ondes de radiation qui grandissent avec la rareté ; dès Mythic, un grand trèfle de danger
  // s'allume derrière la carte et la gelée coule sous le fût. Tirage raté : une seule bulle qui éclate, sans bruit.
  SCENES.radioactive = custom(pieces({ cols: ['#a3ff3c', '#84cc16', '#d4ff6a'], shapes: ['drop', 'drop', 'bubble'], size: [2.4, 4.6], g: 640, spin: 0, up: true, glowc: '#84ff3c', ring: '#a3ff3c', drift: { rate: 2, from: 'bottom' } }), (env, { st }) => {
    const { ci, co, w, h, card, q, dark } = env, bubbles = particles(), ticks = timed(), waves = timed(), drips = timed(), emit = emitter();
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, add = dark ? 'lighter' : 'source-over';
    const GOO = dark ? '#a3ff3c' : '#4d7c0f', EDGE = '#14532d';
    let trefoil = 0, tref = 0;
    return {
      frame(t, dt) {
        // les bulles dans la gelée (dans la carte, derrière les chiffres)
        for (let n = emit((4 + 10 * st.heat) * q, dt); n > 0; n--) bubbles.add({ x: rnd(w * .06, w * .94), y: h * rnd(.85, 1), vx: 0, vy: -rnd(12, 30), max: rnd(.6, 1.4), size: rnd(1.2, 3.2) });
        bubbles.step(dt);
        ci.globalCompositeOperation = 'source-over'; ci.lineWidth = 1;
        bubbles.each((b, k) => { ci.globalAlpha = Math.sin(Math.PI * k) * .8; ci.strokeStyle = '#d4ff6a'; ci.beginPath(); ci.arc(b.x + Math.sin(b.life * 9) * 1.5, b.y, b.size, 0, TAU); ci.stroke(); });
        // le trèfle de danger : trois secteurs et un disque, derrière la carte
        tref += (trefoil - tref) * Math.min(1, dt * 4); trefoil = Math.max(0, trefoil - dt * .12);
        if (tref > .01) behind(env, () => {
          const R = card.h * 1.25, a = tref * (dark ? .32 : .25) * (.85 + .15 * Math.sin(t * 9));
          co.globalCompositeOperation = add; co.globalAlpha = a; co.fillStyle = GOO;
          for (let i = 0; i < 3; i++) { const a0 = -Math.PI / 2 + i * TAU / 3 - Math.PI / 6 + t * .2; co.beginPath(); co.arc(cx, cy, R, a0, a0 + Math.PI / 3); co.arc(cx, cy, R * .3, a0 + Math.PI / 3, a0, true); co.closePath(); co.fill(); }
          co.beginPath(); co.arc(cx, cy, R * .2, 0, TAU); co.fill();
        });
        // le crépitement du compteur : de petits traits verts qui s'allument et s'éteignent d'un coup
        co.globalCompositeOperation = add;
        ticks.run(dt, (k, u) => line(co, GOO, k.x, k.y, k.x + k.dx, k.y + k.dy, 1.6, (1 - u) * (u < .5 ? 1 : .4)));
        waves.run(dt, (r, u) => { co.globalAlpha = (1 - u) * .8; co.strokeStyle = GOO; co.lineWidth = 1 + 3 * (1 - u) * r.wd; co.beginPath(); co.ellipse(r.x, r.y, r.r * outCubic(u) + 4, (r.r * outCubic(u) + 4) * r.k, 0, 0, TAU); co.stroke(); });
        // la gelée qui coule sous le fût
        co.globalCompositeOperation = 'source-over';
        drips.run(dt, (d, u) => {
          const y0 = card.y + card.h - 2, len = d.len * outCubic(Math.min(1, u / .6)), fade = u < .8 ? 1 : (1 - u) / .2;
          co.globalAlpha = fade; co.lineCap = 'round';
          co.strokeStyle = EDGE; co.lineWidth = d.w + 2; co.beginPath(); co.moveTo(d.x, y0); co.lineTo(d.x, y0 + len); co.stroke();
          co.strokeStyle = '#a3ff3c'; co.lineWidth = d.w; co.beginPath(); co.moveTo(d.x, y0); co.lineTo(d.x, y0 + len); co.stroke();
          co.fillStyle = '#a3ff3c'; co.beginPath(); co.arc(d.x, y0 + len, d.w * .9, 0, TAU); co.fill();
          co.fillStyle = 'rgba(255,255,255,.7)'; co.beginPath(); co.arc(d.x - d.w * .3, y0 + len - d.w * .3, d.w * .25, 0, TAU); co.fill();
        });
        co.globalAlpha = 1;
      },
      lock(pt, o) {
        if (o.ghost) return;
        for (let i = Math.round((o.last ? 12 : 6) * q); i > 0; i--) { const a = rnd(TAU), r = card.h * rnd(.45, .8), l = rnd(3, 7); ticks.add({ delay: rnd(0, .18), life: rnd(.05, .1), x: pt.x + Math.cos(a) * r, y: pt.y + Math.sin(a) * r * .8, dx: Math.cos(a) * l, dy: Math.sin(a) * l }); }
        waves.add({ x: pt.x, y: pt.y, r: card.h * (o.last ? .9 : .5), k: .8, wd: o.last ? 1.2 : .7, life: .45 });
      },
      reveal(tier, p) {
        if (!p) { bubbles.add({ x: w / 2, y: h * .9, vx: 0, vy: -20, max: .8, size: 5 }); return; }
        for (let i = 0; i < 1 + Math.round(3 * p); i++) waves.add({ delay: i * .16, x: cx, y: cy, r: card.w * (.4 + .5 * p), k: card.h / card.w + .25, wd: .6 + p, life: .9 });
        for (let i = Math.round(30 * p * q); i > 0; i--) { const a = rnd(TAU), r = card.w * rnd(.5, .9); ticks.add({ delay: rnd(0, .6), life: .08, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * .5, dx: Math.cos(a) * 6, dy: Math.sin(a) * 6 }); }
        if (p >= 1) {
          const extra = ASCEND[tier] || 0;
          trefoil = 1 + .3 * extra;
          for (let i = 0; i < 4 + 2 * extra; i++) drips.add({ delay: .15 + i * .12 + rnd(0, .1), life: 2.6 + .4 * extra, x: card.x + card.w * rnd(.08, .92), w: card.h * rnd(.05, .08), len: card.h * rnd(.08, .18) }); // courtes : la rareté s'affiche juste sous la carte
        }
      },
    };
  });

  // 💵 Money (2026-10-25, idées de JBearr12 et finnnnn) — chaque chiffre tamponné fait sauter des pièces ; à la
  // révélation, une pluie de pièces qui grossit avec la rareté ; dès Mythic, l'or des chiffres fond : des coulures
  // dorées descendent sous chaque chiffre et gouttent sous le billet. Tirage raté : une seule pièce qui roule.
  SCENES.money = custom(pieces({ cols: ['#fbbf24', '#f59e0b', '#fde68a'], shapes: ['coin', 'coin', 'spark'], size: [3, 5.5], g: 760, spin: 0, up: true, glowc: '#fbbf24', ring: '#ca8a04', drift: { rate: .8, from: 'around' } }), (env, { st }) => {
    const { co, card, q, dark, el } = env, rain = particles(), emit = emitter(), drips = timed(), drops = particles();
    const EDGE = dark ? 'rgba(92,61,7,.7)' : 'rgba(92,61,7,.9)';
    // centres des chiffres non fantômes, pour les coulures (dans le repère du calque extérieur)
    const digitXs = () => {
      const slots = el ? [...el.querySelectorAll('.slot:not(.ghost):not(.collapsed)')] : [];
      if (!slots.length) return Array.from({ length: 6 }, (_, i) => card.x + card.w * (.28 + i * .088));
      const b = el.getBoundingClientRect(), k = card.w / (b.width || 1);
      return slots.map(s => { const r = s.getBoundingClientRect(); return card.x + (r.left + r.width / 2 - b.left) * k; });
    };
    return {
      frame(t, dt) {
        if (st.revealed && st.since < .6 + 2.2 * st.p) for (let n = emit(70 * st.p * q, dt); n > 0; n--) rain.add({ x: rnd(card.x - card.w * .4, card.x + card.w * 1.4), y: card.y - card.h * rnd(.8, 1.6), vx: rnd(-15, 15), vy: rnd(60, 160), g: 520, max: 1.8, rot: rnd(TAU), s: rnd(4, 7), c: pick(['#fbbf24', '#f59e0b']) });
        rain.step(dt);
        co.globalCompositeOperation = 'source-over';
        rain.each((p, k) => { co.save(); co.translate(p.x, p.y); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = p.c; SHAPES.coin(co, p, p.s); co.restore(); });
        // l'or qui fond : une coulure par chiffre, du bas du chiffre vers le bas du billet puis au-delà, avec une goutte au bout
        drips.run(dt, (d, k) => {
          const grow = outCubic(Math.min(1, k / .55)), fade = k < .8 ? 1 : (1 - k) / .2, y0 = card.y + card.h * .8, len = d.len * grow;
          co.globalAlpha = fade; co.lineCap = 'round';
          const g = co.createLinearGradient(0, y0, 0, y0 + len);
          g.addColorStop(0, '#fde68a'); g.addColorStop(.5, '#f59e0b'); g.addColorStop(1, '#b45309');
          co.strokeStyle = EDGE; co.lineWidth = d.w + 2; co.beginPath(); co.moveTo(d.x, y0); co.lineTo(d.x, y0 + len); co.stroke();
          co.strokeStyle = g; co.lineWidth = d.w; co.beginPath(); co.moveTo(d.x, y0); co.lineTo(d.x, y0 + len); co.stroke();
          co.fillStyle = '#d97706'; co.beginPath(); co.arc(d.x, y0 + len, d.w * .85, 0, TAU); co.fill();
          co.fillStyle = 'rgba(255,247,194,.85)'; co.beginPath(); co.arc(d.x - d.w * .25, y0 + len - d.w * .25, d.w * .25, 0, TAU); co.fill();
          if (!d.fell && k > .55) { d.fell = true; drops.add({ x: d.x, y: y0 + len, vx: 0, vy: 30, g: 600, max: .3, w: d.w * .8 }); }
        });
        drops.step(dt);
        drops.each((p, k) => { co.globalAlpha = 1 - k; co.fillStyle = '#f59e0b'; co.beginPath(); co.ellipse(p.x, p.y, p.w * .7, p.w * 1.1, 0, 0, TAU); co.fill(); });
        co.globalAlpha = 1;
      },
      lock() {},
      reveal(tier, p) {
        if (!p) { rain.add({ x: card.x + card.w * .5, y: card.y - card.h * .4, vx: rnd(-20, 20), vy: 40, g: 520, max: 1.2, rot: 0, s: 5, c: '#fbbf24' }); return; }
        if (p >= 1) {
          const extra = ASCEND[tier] || 0;
          digitXs().forEach((x, i) => drips.add({ delay: .2 + i * .09 + rnd(0, .12), life: 3 + extra * .5, x: x + rnd(-2, 2), w: card.h * rnd(.06, .09), len: card.h * rnd(.22, .4) * (1 + .1 * extra) }));
        }
      },
    };
  });

  // 🃏 Blackjack (2026-10-26, idée de kaz) — le croupier tient le paquet à gauche de la carte et le mélange en continu
  // pendant le tirage (les deux moitiés s'écartent et s'entrelacent, plus vite avant le dernier chiffre). À chaque chiffre
  // posé, la carte du dessus part en arc par-dessus la table et tombe face cachée sur sa place ; la carte CSS prend le
  // relais (elle se retourne). À la révélation : des jetons jaillissent (plus nombreux avec la rareté), dès Epic les cartes
  // s'éventaillent autour du nombre, dès Mythic « BLACKJACK! » ; tirage raté : « BUST » et le paquet s'éparpille.
  SCENES.blackjack = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const CH = Math.min(card.h * .62, 54), CW = CH * .7;
    const deck = { x: card.x - CW * .5 - 26, y: card.y + card.h / 2 };
    const deals = timed(), chips = particles(), flung = particles(), words = timed(), fans = timed();
    let pace = 1, revealed = false, busted = false, phase = 0, left = 22;
    const back = (x, y, rot, s, a) => { // une carte face cachée : dos rouge à croisillons, liseré blanc
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      const w = CW * s, h = CH * s;
      co.fillStyle = '#fef2f2'; roundRect(co, -w / 2, -h / 2, w, h, w * .1); co.fill();
      co.fillStyle = '#b91c1c'; roundRect(co, -w / 2 + w * .09, -h / 2 + w * .09, w * .82, h - w * .18, w * .06); co.fill();
      co.strokeStyle = 'rgba(254,202,202,.55)'; co.lineWidth = Math.max(.6, w * .03); co.beginPath();
      for (let i = -4; i <= 4; i++) { const o = i * w * .16; co.moveTo(-w * .41 + o, -h * .41); co.lineTo(w * .41 + o, h * .41); co.moveTo(w * .41 + o, -h * .41); co.lineTo(-w * .41 + o, h * .41); }
      co.save(); co.beginPath(); co.rect(-w * .41, -h / 2 + w * .09, w * .82, h - w * .18); co.clip();
      co.beginPath(); for (let i = -4; i <= 4; i++) { const o = i * w * .16; co.moveTo(-w * .41 + o, -h * .45); co.lineTo(w * .41 + o, h * .45); co.moveTo(w * .41 + o, -h * .45); co.lineTo(-w * .41 + o, h * .45); } co.stroke();
      co.restore();
      co.strokeStyle = 'rgba(15,23,42,.5)'; co.lineWidth = 1; roundRect(co, -w / 2, -h / 2, w, h, w * .1); co.stroke();
      co.restore();
    };
    const chip = (x, y, r, rot, c, a) => { // un jeton de casino : disque, six encoches blanches, centre clair
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot); co.scale(1, .55 + .45 * Math.abs(Math.cos(rot * 1.7)));
      co.fillStyle = c; co.beginPath(); co.arc(0, 0, r, 0, TAU); co.fill();
      co.fillStyle = '#ffffff'; for (let i = 0; i < 6; i++) { co.save(); co.rotate(i * TAU / 6); co.fillRect(-r * .14, -r, r * .28, r * .3); co.restore(); }
      co.strokeStyle = 'rgba(255,255,255,.8)'; co.lineWidth = r * .1; co.beginPath(); co.arc(0, 0, r * .55, 0, TAU); co.stroke();
      co.restore();
    };
    const CHIPS = ['#dc2626', '#2563eb', '#16a34a', '#111827', '#7c3aed', '#f59e0b'];
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        phase += dt * 2.6 * pace;
        // le paquet : deux moitiés qui s'écartent, se soulèvent et retombent en s'entrelaçant (un mélange à l'américaine)
        if (!busted) {
          const k = revealed ? 0 : Math.sin(phase * Math.PI) ** 2, n = Math.max(2, Math.round(left / 3));
          for (let i = 0; i < n; i++) back(deck.x - CW * .02 * i, deck.y + 3 - i * 1.2, 0, 1, 1); // la pile
          if (k > .02) for (let i = 0; i < 4; i++) {
            const side = i % 2 ? 1 : -1, lift = k * (CH * .32 - i * 3);
            back(deck.x + side * k * CW * .48, deck.y - lift - n * 1.2, side * k * .38, 1, 1);
          }
          else back(deck.x, deck.y - n * 1.2, 0, 1, 1);
        }
        // les cartes distribuées : un arc du paquet jusqu'à leur place, en tournant, de plus en plus petites
        deals.run(dt, (d, k) => {
          const e = outCubic(k), x = lerp(deck.x, d.x, e), top = Math.min(deck.y, d.y) - card.h * .9;
          const y = (1 - e) * (1 - e) * deck.y + 2 * (1 - e) * e * top + e * e * d.y;
          back(x, y, (1 - e) * -1.1 + e * -.42, lerp(1, d.s, e), 1);
        });
        // l'éventail : quelques cartes qui s'ouvrent derrière la carte, de part et d'autre
        behind(env, () => fans.run(dt, (f, k) => {
          const open = outCubic(Math.min(1, k * 3)), a = k > .7 ? (1 - k) / .3 : 1;
          for (let i = 0; i < f.n; i++) {
            const u = (i / (f.n - 1)) - .5, ang = u * 2.2 * open;
            back(cx + Math.sin(ang) * card.w * .5, card.y + card.h * .5 - Math.cos(ang) * card.h * .42, ang, .95, a * .95);
          }
        }));
        chips.step(dt); flung.step(dt);
        flung.each((c, k) => back(c.x, c.y, c.rot + c.spin * c.life, .8, k < .7 ? 1 : (1 - k) / .3));
        // les jetons passent derrière la carte : ils ne cachent jamais un chiffre
        behind(env, () => chips.each((c, k) => chip(c.x, c.y, c.r, c.rot + c.spin * c.life, c.c, k < .75 ? 1 : (1 - k) * 4)));
        words.run(dt, (w, k) => {
          const pop = k < .15 ? outCubic(k / .15) * 1.15 : k < .25 ? 1.15 - .15 * (k - .15) / .1 : 1, a = k > .8 ? (1 - k) * 5 : 1;
          text(co, w.s, cx, card.y - card.h * .42, card.h * w.size * pop, w.c, a);
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        left = Math.max(2, left - 2);
        // la carte se pose quand la carte CSS apparaît face cachée (22 % de ses 0,62 s)
        deals.add({ x: p.x, y: p.y, s: Math.min(1, (card.h * .62) / CH), life: .14 });
      },
      build() { pace = 2.4; },
      reveal(tier) {
        const p = POWER[tier] || 0;
        revealed = true; pace = .4;
        if (!p) { // tirage raté : le paquet s'éparpille sur la table
          busted = true;
          for (let i = 0; i < 7; i++) flung.add({ x: deck.x, y: deck.y, vx: rnd(-40, 140), vy: rnd(-160, -60), g: 520, drag: .4, max: rnd(.9, 1.3), rot: rnd(-.4, .4), spin: rnd(-8, 8) });
          words.add({ s: 'BUST', size: .22, c: dark ? '#94a3b8' : '#64748b', life: 1.4 });
          return;
        }
        for (let i = burst(p, 40 * q, 3); i > 0; i--) {
          const a = rnd(-Math.PI * .92, -Math.PI * .08), v = card.h * rnd(2.6, 4.5 + 4 * p);
          chips.add({ x: cx + rnd(-.4, .4) * card.w, y: card.y + card.h * .2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 10, drag: .25, max: rnd(.9, 1.5), r: card.h * rnd(.09, .13), rot: rnd(TAU), spin: rnd(-9, 9), c: pick(CHIPS) });
        }
        if (p >= .6) fans.add({ delay: .05, life: 1.6 + p, n: p >= 1 ? 7 + 2 * (ASCEND[tier] || 0) : 5 });
        if (p >= 1) words.add({ delay: .12, s: 'BLACKJACK!', size: .2 + .03 * (ASCEND[tier] || 0), c: '#facc15', life: 2.2 + .4 * (ASCEND[tier] || 0) });
        else if (p >= .6) words.add({ delay: .12, s: '21!', size: .26, c: '#4ade80', life: 1.8 });
      },
    };
  };

  // 🚀 Rocket (2026-10-26, idée de HSI) — à chaque chiffre posé, une petite fusée s'allume derrière la carte (flash et
  // fumée au pied), monte derrière le chiffre et ressort par le haut dans une traînée de flammes ; la dernière est plus
  // grosse. À la révélation : des fusées de feu d'artifice partent au-dessus de la carte et éclatent (plus nombreuses et
  // plus grandes avec la rareté) ; tirage raté : une fusée crachote, retombe et ne laisse qu'un nuage « FIZZLE ».
  SCENES.rocket = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, ground = card.y + card.h + 8;
    const rockets = timed(), smoke = particles(), sparks = particles(), shells = timed(), words = timed();
    const FIRE = ['#fde68a', '#fb923c', '#f97316'], BURST = ['#f472b6', '#38bdf8', '#facc15', '#4ade80', '#c084fc', '#fb7185'];
    const ship = (x, y, s, ang, a) => { // une fusée de dessin animé : corps blanc, nez et ailerons rouges, hublot bleu
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(ang);
      const fl = s * (1.1 + .5 * Math.random()); // la flamme
      const g = co.createLinearGradient(0, s * .9, 0, s * .9 + fl);
      g.addColorStop(0, '#fff7cc'); g.addColorStop(.35, '#fb923c'); g.addColorStop(1, 'rgba(249,115,22,0)');
      co.fillStyle = g; co.beginPath(); co.moveTo(-s * .26, s * .9); co.quadraticCurveTo(0, s * .9 + fl * 1.2, s * .26, s * .9); co.fill();
      co.fillStyle = '#dc2626'; // ailerons
      co.beginPath(); co.moveTo(-s * .3, s * .3); co.lineTo(-s * .62, s * .95); co.lineTo(-s * .3, s * .8); co.fill();
      co.beginPath(); co.moveTo(s * .3, s * .3); co.lineTo(s * .62, s * .95); co.lineTo(s * .3, s * .8); co.fill();
      const b = co.createLinearGradient(-s * .32, 0, s * .32, 0); b.addColorStop(0, '#cbd5e1'); b.addColorStop(.45, '#ffffff'); b.addColorStop(1, '#94a3b8');
      co.fillStyle = b; co.beginPath(); co.moveTo(0, -s); co.quadraticCurveTo(s * .42, -s * .4, s * .3, s * .9); co.lineTo(-s * .3, s * .9); co.quadraticCurveTo(-s * .42, -s * .4, 0, -s); co.fill();
      co.fillStyle = '#dc2626'; co.beginPath(); co.moveTo(0, -s); co.quadraticCurveTo(s * .3, -s * .62, s * .36, -s * .45); co.lineTo(-s * .36, -s * .45); co.quadraticCurveTo(-s * .3, -s * .62, 0, -s); co.fill();
      co.fillStyle = '#38bdf8'; co.strokeStyle = '#334155'; co.lineWidth = Math.max(1, s * .06); co.beginPath(); co.arc(0, -s * .1, s * .14, 0, TAU); co.fill(); co.stroke();
      co.restore();
    };
    const puff = (x, y, n, up) => { for (let i = Math.round(n * q); i > 0; i--) smoke.add({ x: x + rnd(-6, 6), y, vx: rnd(-50, 50), vy: up ? rnd(-30, -5) : rnd(-15, 20), drag: 1.6, g: -8, max: rnd(.7, 1.3), size: rnd(5, 11) }); };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        smoke.step(dt); sparks.step(dt);
        // la fumée reste derrière la carte : elle ne voile jamais un chiffre
        behind(env, () => smoke.each((m, k) => dot(co, dark ? '#cbd5e1' : '#94a3b8', m.x, m.y, m.size * (1 + 1.5 * k), (1 - k) * (dark ? .35 : .5))));
        // les fusées : sous la carte, puis derrière elle, puis au-dessus et hors champ (accélération)
        rockets.run(dt, (r, k) => {
          const e = k * (.6 + .4 * k), y = lerp(card.y + card.h * .8, card.y - card.h * 2.4, e), x = r.x + Math.sin(k * 9) * 1.5;
          if (r.fizzle) { // tirage raté : elle monte à peine, bascule et retombe
            const yy = ground + r.s - Math.sin(Math.min(1, k * 1.4) * Math.PI) * card.h * .5;
            ship(x + k * 30, yy, r.s, k * 2.2, k > .85 ? (1 - k) / .15 : 1);
            if (Math.random() < .3) puff(x + k * 30, yy, 1, true);
            return;
          }
          behind(env, () => {
            for (let i = 1; i < 6; i++) dot(co, pick(FIRE), x, y + r.s * (1 + i * .5), r.s * (.5 - i * .06), .6 - i * .1);
            ship(x, y, r.s, 0, 1);
          });
          if (!r.lit) { r.lit = true; puff(x, ground, 6 + 6 * r.big, false); }
          if (Math.random() < .5) smoke.add({ x, y: y + r.s * 1.6, vx: rnd(-15, 15), vy: rnd(10, 30), drag: 2, g: -6, max: rnd(.5, .9), size: rnd(3, 6) });
        });
        // feu d'artifice : une fusée-traceur monte, puis éclate en une sphère d'étincelles qui retombent
        shells.run(dt, (s, k) => {
          if (k < .4) { const y = lerp(card.y + card.h * 1.6, s.y, outCubic(k / .4)); tail(co, s.c, s.x, y + 16, s.x, y, 2, 1); dot(co, '#fff7cc', s.x, y, 3, 1); return; }
          if (!s.done) {
            s.done = true;
            for (let i = Math.round(s.n * q); i > 0; i--) { const a = rnd(TAU), v = rnd(.6, 1) * s.r; sparks.add({ x: s.x, y: s.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 1.8, g: 60, max: rnd(.9, 1.5), size: rnd(1.6, 2.8), c: s.c }); }
          }
        });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.each((s, k) => { tail(co, s.c, s.x - s.vx * .05, s.y - s.vy * .05, s.x, s.y, s.size, 1 - k); dot(co, s.c, s.x, s.y, s.size * 2.2, (1 - k) * .8); });
        co.globalCompositeOperation = 'source-over';
        words.run(dt, (w, k) => text(co, w.s, cx, card.y - card.h * .4, card.h * w.size, w.c, k > .7 ? (1 - k) / .3 : Math.min(1, k * 6)));
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        const big = o.last ? 1 : 0;
        rockets.add({ x: p.x, s: card.h * (big ? .3 : .22), big, life: big ? .6 : .48 }); // elle sort par le haut quand le chiffre décolle
      },
      build() { puff(cx, ground, 10, false); },
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { rockets.add({ x: cx, s: card.h * .24, fizzle: true, life: 1.2 }); words.add({ delay: .5, s: 'FIZZLE', size: .2, c: dark ? '#94a3b8' : '#64748b', life: 1.5 }); return; }
        const n = 1 + Math.round(5 * p) + 2 * (ASCEND[tier] || 0);
        for (let i = 0; i < n; i++) shells.add({ delay: i * .16, life: .9, x: cx + (i % 2 ? 1 : -1) * card.w * rnd(.55, 1), y: card.y + card.h * rnd(-.5, .6), r: card.h * (2.4 + 2.6 * p), n: 18 + 30 * p, c: pick(BURST) });
        puff(cx, ground, 6 + 14 * p, false);
      },
    };
  };

  // 🍣 Sushi (2026-10-26, idée de Gray alt) — à chaque chiffre posé, une petite gerbe de sauce soja jaillit autour du
  // maki (gouttes brunes, derrière la carte) ; la dernière est plus grosse. À la révélation : une flaque de soja qui
  // éclabousse, plus forte avec la rareté ; dès Mythic, un maki géant tombe au-dessus de la carte, s'écrase et éclate en
  // riz (grains blancs, morceaux de saumon et d'algue) ; tirage raté : un seul grain de riz tombe.
  SCENES.sushi = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const drops = particles(), grains = particles(), giants = timed();
    const SOY = dark ? ['#7c2d12', '#9a3412', '#451a03'] : ['#7c2d12', '#451a03', '#9a3412'];
    const splash = (x, y, s) => {
      for (let i = Math.round((6 + 16 * s) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = card.h * rnd(1.8, 3 + 4 * s); drops.add({ x: x + rnd(-1, 1) * card.h * .15, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 11, drag: .3, max: rnd(.45, .85), size: card.h * rnd(.025, .05 + .02 * s), c: pick(SOY) }); }
    };
    const rice = (x, y, n, power) => {
      for (let i = Math.round(n * q); i > 0; i--) {
        const a = rnd(TAU), v = card.h * rnd(1.5, 3 + 4 * power), kind = Math.random();
        grains.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - card.h * 1.5, g: card.h * 9, drag: .5, max: rnd(1, 1.6), size: card.h * rnd(.03, .045), rot: rnd(TAU), spin: rnd(-10, 10), c: kind < .8 ? '#fffdf8' : kind < .92 ? '#fb923c' : '#1f2d1f' });
      }
    };
    const maki = (x, y, r, sx, sy, a) => { // une tranche de maki vue de dessus
      co.save(); co.globalAlpha = a; co.translate(x, y); co.scale(sx, sy);
      co.fillStyle = '#0b130b'; co.beginPath(); co.arc(0, 0, r, 0, TAU); co.fill();
      co.fillStyle = '#1f2d1f'; co.beginPath(); co.arc(0, 0, r * .92, 0, TAU); co.fill();
      co.fillStyle = '#fffdf8'; co.beginPath(); co.arc(0, 0, r * .72, 0, TAU); co.fill();
      co.fillStyle = '#e7e5e4'; for (let i = 0; i < 14; i++) { const an = i * 2.4, d = r * (.3 + (i % 3) * .12); co.beginPath(); co.ellipse(Math.cos(an) * d, Math.sin(an) * d, r * .05, r * .09, an, 0, TAU); co.fill(); }
      co.fillStyle = '#fb923c'; co.beginPath(); co.arc(0, 0, r * .24, 0, TAU); co.fill();
      co.fillStyle = 'rgba(255,255,255,.35)'; co.beginPath(); co.ellipse(-r * .4, -r * .5, r * .25, r * .1, -.6, 0, TAU); co.fill();
      co.restore();
    };
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        drops.step(dt); grains.step(dt);
        // le maki géant : il tombe au-dessus de la carte, s'écrase, se gonfle et éclate en riz
        giants.run(dt, (g, k) => {
          const R = card.h * g.s, y0 = card.y - card.h * 2.2, yHit = card.y - R * .55;
          if (k < .35) { const e = (k / .35) ** 2; maki(cx, lerp(y0, yHit, e), R, .9, 1.1, 1); return; }
          if (k < .6) { const u = (k - .35) / .25, sq = Math.sin(u * Math.PI); maki(cx, yHit, R, 1 + .35 * sq, 1 - .3 * sq, 1); return; }
          if (!g.burst) { g.burst = true; rice(cx, yHit, g.n, 1); splash(cx, card.y, 1.2); }
        });
        // le soja et le riz passent derrière la carte : ils ne cachent jamais un chiffre
        behind(env, () => {
          drops.each((d, k) => { co.globalAlpha = 1 - k * k; co.fillStyle = d.c; co.beginPath(); co.ellipse(d.x, d.y, d.size, d.size * 1.3, Math.atan2(d.vy, d.vx) + Math.PI / 2, 0, TAU); co.fill(); });
          grains.each((g, k) => { co.save(); co.globalAlpha = k < .8 ? 1 : (1 - k) * 5; co.translate(g.x, g.y); co.rotate(g.rot + g.spin * g.life); co.fillStyle = g.c; co.strokeStyle = 'rgba(120,113,108,.6)'; co.lineWidth = .6; co.beginPath(); co.ellipse(0, 0, g.size * .55, g.size, 0, 0, TAU); co.fill(); co.stroke(); co.restore(); });
        });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.ghost) return; splash(p.x, p.y + card.h * .1, o.last ? .9 : .4); },
      build() {},
      reveal(tier) {
        const p = POWER[tier] || 0;
        if (!p) { grains.add({ x: cx, y: card.y - card.h * .3, vx: 0, vy: 0, g: card.h * 6, drag: 0, max: .9, size: card.h * .06, rot: .3, spin: 3, c: '#fffdf8' }); return; }
        for (let i = 0; i < 1 + Math.round(3 * p); i++) splash(cx + rnd(-.45, .45) * card.w, card.y + card.h * .5, .5 + .8 * p);
        if (p >= .6) rice(cx, card.y, 10 + 20 * p, p);
        if (p >= 1) giants.add({ delay: .1, life: 1, s: .5 + .08 * (ASCEND[tier] || 0), n: 60 + 30 * (ASCEND[tier] || 0) });
      },
    };
  };

  // 💥 Comic Book (2026-10-26, idée de JBearr12) — une planche de BD vivante. Pendant le tirage, des lignes de vitesse
  // noires partent des bords de la carte (plus serrées avant le dernier chiffre). À chaque chiffre posé, une bulle
  // d'onomatopée à pointes (POW!, BAM!, ZAP!…) éclate au-dessus de lui, en alternant les couleurs ; la dernière est plus
  // grosse. À la révélation : un grand éclat KA-BOOM! derrière la carte, des rayons de trame, des éclats d'encre, et dès
  // Mythic des cases de BD qui claquent autour du nombre avec « WHAM! » et « KRAK! » ; tirage raté : une bulle « meh… ».
  SCENES.comicbook = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const pops = timed(), booms = timed(), panels = timed(), inks = particles();
    const WORDS = ['POW!', 'BAM!', 'ZAP!', 'BIFF!', 'ZOK!', 'WHAM!'];
    const FILLS = [['#fde047', '#ef4444'], ['#22d3ee', '#fde047'], ['#f472b6', '#fde047'], ['#ef4444', '#fde047']];
    const INK = '#0a0a0a';
    let speed = .4, revealed = false, n = 0;
    // une étoile à pointes irrégulières, cernée d'encre noire, avec une ombre décalée
    const star = (x, y, r, spikes, rot, fill, a, seed) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      const path = () => { co.beginPath(); for (let i = 0; i < spikes * 2; i++) { const rr = i % 2 ? r * (.55 + .08 * Math.sin(i * 3.1 + seed)) : r * (1 + .12 * Math.sin(i * 1.7 + seed)), an = i * Math.PI / spikes; co.lineTo(Math.cos(an) * rr, Math.sin(an) * rr * .8); } co.closePath(); };
      co.translate(r * .08, r * .08); path(); co.fillStyle = INK; co.fill(); co.translate(-r * .08, -r * .08);
      path(); co.fillStyle = fill; co.fill(); co.lineWidth = Math.max(1.5, r * .07); co.strokeStyle = INK; co.lineJoin = 'round'; co.stroke();
      co.restore();
    };
    const word = (s, x, y, size, fill, a, rot) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      co.font = `900 ${size}px Impact, 'Arial Black', sans-serif`; co.textAlign = 'center'; co.textBaseline = 'middle';
      co.lineJoin = 'round'; co.lineWidth = Math.max(2, size * .16); co.strokeStyle = INK; co.strokeText(s, 0, 0);
      co.fillStyle = fill; co.fillText(s, 0, 0); co.restore();
    };
    const pop = k => (k < .18 ? outBack(k / .18) : 1) * (k > .8 ? 1 - (k - .8) / .2 * .3 : 1);
    return {
      frame(t, dt) {
        co.globalCompositeOperation = 'source-over';
        // les lignes de vitesse : des traits d'encre qui rayonnent depuis la carte, redessinés à chaque image (effet BD)
        if (!revealed) {
          const lines = Math.round((10 + 26 * speed) * q), a = dark ? .55 : .45;
          behind(env, () => {
            co.strokeStyle = dark ? '#f8fafc' : INK; co.lineCap = 'round';
            for (let i = 0; i < lines; i++) {
              const an = rnd(TAU), r0 = Math.hypot(card.w * .5 * Math.cos(an), card.h * .5 * Math.sin(an)) + rnd(4, 14), len = rnd(10, 26 + 40 * speed);
              co.globalAlpha = a * rnd(.4, 1); co.lineWidth = rnd(.8, 2.2);
              co.beginPath(); co.moveTo(cx + Math.cos(an) * r0, cy + Math.sin(an) * r0); co.lineTo(cx + Math.cos(an) * (r0 + len), cy + Math.sin(an) * (r0 + len)); co.stroke();
            }
          }, true);
        }
        // le grand KA-BOOM : un éclat géant derrière la carte, des rayons de trame autour
        booms.run(dt, (b, k) => {
          const s = k < .15 ? outBack(k / .15) : 1, a = k > .75 ? (1 - k) / .25 : 1;
          behind(env, () => {
            co.globalAlpha = a * .5; co.fillStyle = '#ec4899';
            for (let i = 0; i < 16; i++) { const an = i * TAU / 16 + k * .3, L = card.w * (.7 + .5 * b.p) * s; co.beginPath(); co.moveTo(cx, cy); co.lineTo(cx + Math.cos(an - .06) * L, cy + Math.sin(an - .06) * L * .7); co.lineTo(cx + Math.cos(an + .06) * L, cy + Math.sin(an + .06) * L * .7); co.closePath(); co.fill(); }
            star(cx, cy, card.w * (.42 + .3 * b.p) * s, 14, k * .2, '#fde047', a, 3);
            star(cx, cy, card.w * (.3 + .2 * b.p) * s, 12, -k * .3, '#ef4444', a, 7);
          }, true);
          word(b.s, cx, card.y - card.h * .2, card.h * (.32 + .08 * b.p) * s, '#fde047', a, -.08);
        });
        // les cases qui claquent autour du nombre (Mythic et plus)
        panels.run(dt, (p, k) => {
          const e = k < .2 ? outBack(k / .2) : 1, a = k > .75 ? (1 - k) / .25 : 1, w = card.h * 1.2, h = card.h * .9;
          const x = cx + p.side * (card.w * .5 + w * .62), y = cy + p.dy * card.h;
          behind(env, () => {
            co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(p.rot); co.scale(e, e);
            co.fillStyle = INK; co.fillRect(-w / 2 + 4, -h / 2 + 4, w, h);
            co.fillStyle = p.c; co.fillRect(-w / 2, -h / 2, w, h);
            co.fillStyle = 'rgba(10,10,10,.18)'; for (let i = -w / 2 + 3; i < w / 2; i += 6) for (let j = -h / 2 + 3; j < h / 2; j += 6) { co.beginPath(); co.arc(i, j, 1.2, 0, TAU); co.fill(); }
            co.lineWidth = 3; co.strokeStyle = INK; co.strokeRect(-w / 2, -h / 2, w, h);
            co.restore();
            word(p.s, x, y, card.h * .3 * e, '#ffffff', a, p.rot);
          });
        });
        // les bulles de chaque chiffre, au-dessus de lui (jamais sur un chiffre)
        pops.run(dt, (b, k) => {
          // posée sur le bord haut de la carte, décalée vers la droite du chiffre : elle ne couvre que le cadre
          const s = pop(k), a = k > .7 ? (1 - k) / .3 : 1, y = card.y - card.h * (.1 + .04 * b.big) - k * 6, x = b.x + card.h * .32;
          star(x, y, card.h * (.4 + .12 * b.big) * s, 9, b.rot, b.f[0], a, b.seed);
          word(b.s, x, y, card.h * (.24 + .06 * b.big) * s, b.f[1], a, b.rot * .5);
        });
        inks.step(dt);
        inks.each((d, k) => { co.globalAlpha = 1 - k; co.fillStyle = d.c; co.beginPath(); co.arc(d.x, d.y, d.size * (1 - k * .5), 0, TAU); co.fill(); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        const big = o.last ? 1 : 0;
        pops.add({ x: p.x, s: big ? 'BOOM!' : WORDS[n % WORDS.length], f: FILLS[n % FILLS.length], rot: rnd(-.25, .25), seed: rnd(10), big, life: big ? .9 : .6 });
        n++; speed = Math.min(1.2, speed + .08);
      },
      build() { speed = 1.3; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        revealed = true;
        if (!p) { pops.add({ x: cx, s: 'meh…', f: ['#e5e7eb', '#475569'], rot: -.1, seed: 2, big: 0, life: 1.6 }); return; }
        booms.add({ life: 1.6 + p + .4 * asc, p, s: p >= 1 ? 'KA-BOOM!' : p >= .6 ? 'KAPOW!' : 'POW!' });
        for (let i = burst(p, 40 * q, 6); i > 0; i--) { const an = rnd(TAU), v = rnd(120, 260 + 260 * p); inks.add({ x: cx + Math.cos(an) * card.w * .4, y: cy + Math.sin(an) * card.h * .4, vx: Math.cos(an) * v, vy: Math.sin(an) * v * .7, g: 220, drag: 1.6, max: rnd(.5, 1), size: rnd(2, 5), c: pick(['#0a0a0a', '#ef4444', '#fde047', '#22d3ee', '#ec4899']) }); }
        if (p >= 1) {
          const list = [['WHAM!', -1, -.15, '#22d3ee'], ['KRAK!', 1, .15, '#f472b6'], ['ZOK!', -1, .9, '#fde047'], ['BLAM!', 1, -.9, '#4ade80']].slice(0, 2 + Math.min(2, asc));
          list.forEach(([s, side, dy, c], i) => panels.add({ delay: .15 + i * .14, life: 2 + .4 * asc, s, side, dy, c, rot: side * rnd(.04, .1) }));
        }
      },
    };
  };

  // ==== Skins du 2026-10-27, lot A ====
  // Fairy Lights, Elves' Workshop, Snow Reveal, Graveyard, Ship Wake, Torn Paper et Stickman (idées de joueurs). Ces
  // scènes suivent les cases elles-mêmes (un lutin, une ampoule, un bateau par chiffre) : slotsA lit leur position sur
  // la carte (env.el) à chaque image, car la carte se resserre quand les zéros de tête s'effacent.
  function slotsA(env) {
    const el = env.el, out = [];
    if (!el || !el.getBoundingClientRect) return out;
    const r = el.getBoundingClientRect(), k = env.card.w / (r.width || env.card.w);
    el.querySelectorAll('.slot').forEach((s, i) => {
      const b = s.getBoundingClientRect(), cl = s.classList;
      out.push({ i, x: env.card.x + (b.left - r.left + b.width / 2) * k, y: env.card.y + (b.top - r.top + b.height / 2) * k, w: b.width * k, top: env.card.y + (b.top - r.top) * k, bottom: env.card.y + (b.bottom - r.top) * k, on: cl.contains('revealed'), ghost: cl.contains('ghost'), gone: cl.contains('collapsed') || b.width < 2 });
    });
    return out;
  }
  // Mélange de deux couleurs (#rrggbb ou rgb(…) ; k = part de b).
  const rgbA = c => (c[0] === '#' ? [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) : c.match(/[\d.]+/g).slice(0, 3).map(Number));
  const mixA = (a, b, k) => { const x = rgbA(a), y = rgbA(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * clamp(k))).join(',')})`; };

  // 💡 Fairy Lights (2026-10-27, idée de 17black) — une guirlande d'ampoules à l'ancienne pend au-dessus de la carte,
  // une ampoule par chiffre et deux de chaque côté. Pendant le tirage, les ampoules éteintes grésillent ; à chaque
  // chiffre posé, la sienne hésite (deux clignotements), s'allume d'un coup et éclaire le chiffre par en haut, au même
  // rythme que l'animation CSS fl-catch. Avant le dernier chiffre, sa lampe grésille de plus en plus vite et les autres
  // baissent. Révélation : une chenille lumineuse parcourt la guirlande (plus de passages avec la rareté) ; dès Epic,
  // des paillettes dorées tombent ; dès Mythic, les couleurs tournent et deux guirlandes de plus descendent sur les
  // côtés ; tirage raté : une ampoule claque et s'éteint.
  SCENES.fairylights = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const HUES = ['#f87171', '#4ade80', '#fbbf24', '#60a5fa', '#f472b6', '#fb923c'];
    const litAt = new Map(), sparked = new Set(), glitter = particles(), shards = particles(), chases = timed(), garlands = timed();
    let t = 0, build = 0, dead = -1, deadAt = 0, rainbow = 0, dimAt = -9, revealed = false;
    // Allumage : mêmes instants que fl-catch (0,55 s) — éteint, allumé, éteint, allumé, à moitié, l'éclat, la lueur.
    const catchK = s => { const p = s / .55; return p < .08 ? .12 : p < .14 ? 1 : p < .26 ? .1 : p < .32 ? 1 : p < .44 ? .45 : p < .7 ? 1.35 - (p - .44) / .26 * .35 : 1; };
    const WIRE = dark ? '#1f5132' : '#14532d';
    // La guirlande : un feston entre deux points au-dessus de la carte, plus bas au milieu.
    const wire = x => { const xl = card.x - card.h * 1.1, xr = card.x + card.w + card.h * 1.1, u = (x - xl) / (xr - xl); return card.y - card.h * .9 + card.h * .62 * 4 * u * (1 - u); };
    const bulb = (x, col, k, s, ang, alive) => {
      const y = wire(x);
      const gx = x - Math.sin(ang) * s * .78, gy = y + Math.cos(ang) * s * .78;
      if (k > .05 && alive) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, col, gx, gy, s * (1.5 + .9 * Math.min(1.3, k)), (dark ? .6 : .42) * Math.min(1.3, k)); co.globalCompositeOperation = 'source-over'; }
      co.save(); co.translate(x, y); co.rotate(ang); co.globalAlpha = 1;
      co.fillStyle = dark ? '#2f5e3e' : '#166534'; roundRect(co, -s * .17, -s * .04, s * .34, s * .38, s * .06); co.fill();
      co.beginPath(); co.moveTo(-s * .22, s * .32); co.bezierCurveTo(-s * .44, s * .62, -s * .26, s * 1.08, 0, s * 1.18); co.bezierCurveTo(s * .26, s * 1.08, s * .44, s * .62, s * .22, s * .32); co.closePath();
      co.fillStyle = alive ? mixA(mixA(col, '#0b1020', .62), col, Math.min(1, k)) : '#3f3f46'; co.fill();
      co.lineWidth = Math.max(.8, s * .05); co.strokeStyle = 'rgba(15,23,42,.45)'; co.stroke();
      if (alive && k > .2) { co.globalAlpha = Math.min(1, k) * .85; co.fillStyle = '#fffbea'; co.beginPath(); co.ellipse(0, s * .72, s * .1, s * .2, 0, 0, TAU); co.fill(); }
      co.globalAlpha = .5; co.fillStyle = '#fff'; co.beginPath(); co.ellipse(-s * .13, s * .58, s * .05, s * .15, .3, 0, TAU); co.fill();
      co.restore();
      return { gx, gy };
    };
    return {
      frame(tt, dt) {
        t = tt;
        const S = slotsA(env).filter(s => !s.gone), s0 = Math.max(7, card.h * .25);
        const next = S.find(s => !s.on);
        // Le fil (deux brins torsadés), d'un bout à l'autre.
        const xl = card.x - card.h * 1.1, xr = card.x + card.w + card.h * 1.1;
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1; co.lineCap = 'round';
        for (const ph of [0, Math.PI]) {
          co.strokeStyle = WIRE; co.lineWidth = Math.max(1.3, card.h * .022); co.beginPath();
          for (let x = xl; x <= xr + 1; x += 4) { const y = wire(x) + Math.sin(x * .45 + ph) * 1.1; x === xl ? co.moveTo(x, y) : co.lineTo(x, y); }
          co.stroke();
        }
        // La liste des ampoules, de gauche à droite : deux avant la carte, une par case, deux après.
        const L = [];
        const first = S.length ? S[0].x : card.x, last = S.length ? S[S.length - 1].x : card.x + card.w, gap = S.length > 1 ? (last - first) / (S.length - 1) : card.h * .5;
        L.push({ x: first - gap * 2.6, col: HUES[4], side: 1 }, { x: first - gap * 1.4, col: HUES[5], side: 1 });
        S.forEach(s => L.push({ x: s.x, col: HUES[s.i % 6], s }));
        L.push({ x: last + gap * 1.4, col: HUES[0], side: 1 }, { x: last + gap * 2.6, col: HUES[1], side: 1 });
        // La chenille de la révélation : une bosse de lumière qui court le long de la guirlande.
        const boost = new Array(L.length).fill(0);
        chases.run(dt, (c, k) => { const pos = (k * c.passes) % 1 * (L.length + 3) - 1.5; for (let j = 0; j < L.length; j++) boost[j] = Math.max(boost[j], Math.exp(-((j - pos) ** 2) / 1.2) * c.p); });
        rainbow = Math.max(0, rainbow - dt * .12);
        const dim = clamp(1 - (t - dimAt) / .5) * .45;
        L.forEach((b, j) => {
          let k;
          if (b.side) k = revealed ? .55 + .3 * Math.sin(t * 3 + j) : .18 + .06 * Math.sin(t * 9 + j * 2);
          else if (b.s.on) { const at = litAt.has(b.s.i) ? litAt.get(b.s.i) : (litAt.set(b.s.i, t), t); k = catchK(t - at) * (b.s.ghost ? .35 : 1) * (1 - build * .3 - dim) + .04 * Math.sin(t * 6 + j); }
          else { const buzz = next && b.s.i === next.i ? build : 0; k = .1 + .06 * Math.sin(t * 23 + j * 5) * Math.sin(t * 7.3 + j) + (Math.random() < .03 + .3 * buzz ? .3 + .6 * buzz : 0); }
          k += boost[j];
          let col = b.col;
          if (rainbow > 0) col = HUES[(j + Math.floor(t * 5)) % 6];
          const alive = !(b.s && b.s.i === dead);
          if (!alive && t - deadAt < .12) k = 2; // l'ampoule claque : un éclair blanc avant le noir
          const ang = .09 * Math.sin(t * 1.3 + j * .8) + (build ? .03 * Math.sin(t * 17 + j) : 0);
          const g = bulb(b.x, alive || t - deadAt < .12 ? col : '#3f3f46', k, s0, ang, alive || t - deadAt < .12);
          // La lumière tombe sur la vitre, derrière le chiffre.
          if (b.s && alive && k > .2) { ci.globalCompositeOperation = 'lighter'; dot(ci, col, b.x - card.x, 0, card.h * .75, .32 * Math.min(1.3, k)); ci.globalCompositeOperation = 'source-over'; }
          if (b.s && b.s.on && litAt.get(b.s.i) !== undefined) { const since = t - litAt.get(b.s.i); if (since > .24 && !sparked.has(b.s.i) && sparked.add(b.s.i)) for (let n = Math.round((b.s.i === S[S.length - 1].i ? 10 : 4) * q); n > 0; n--) glitter.add({ x: g.gx, y: g.gy, vx: rnd(-60, 60), vy: rnd(-90, -20), g: 160, drag: 1.5, max: rnd(.5, 1), size: rnd(1, 2), c: col }); }
        });
        // Les guirlandes de côté (Mythic et plus) : elles tombent du haut et se balancent à côté de la carte.
        garlands.run(dt, (gq, k) => {
          const drop = outBack(clamp(k * 4)), fade = clamp((1 - k) * 4);
          for (const side of [-1, 1]) {
            const x0 = side < 0 ? card.x - card.h * .55 : card.x + card.w + card.h * .55, y0 = card.y - card.h * 1.1, y1 = lerp(y0, card.y + card.h * 1.05, drop);
            co.globalAlpha = fade; co.strokeStyle = WIRE; co.lineWidth = Math.max(1.3, card.h * .022);
            co.beginPath(); co.moveTo(x0, y0); co.quadraticCurveTo(x0 + side * card.h * .35, (y0 + y1) / 2, x0, y1); co.stroke();
            for (let n = 0; n < 4; n++) {
              const u = (n + .5) / 4, y = lerp(y0, y1, u), x = x0 + side * card.h * .35 * 2 * u * (1 - u) * 2 * .5, col = HUES[(n + (side > 0 ? 3 : 0) + Math.floor(t * 6)) % 6];
              co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, col, x, y + s0 * .6, s0 * 1.8, (dark ? .55 : .4) * fade); co.globalCompositeOperation = 'source-over';
              co.globalAlpha = fade; co.fillStyle = col; co.beginPath(); co.ellipse(x, y + s0 * .6, s0 * .3, s0 * .45, 0, 0, TAU); co.fill();
            }
          }
          co.globalAlpha = 1;
        });
        // Paillettes et éclats de verre
        glitter.step(dt); shards.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        glitter.each((p, k) => { const a = (1 - k) * (.6 + .4 * Math.sin(t * 20 + p.x)); dot(co, p.c, p.x, p.y, p.size * 3, a); if (p.size > 1.6) { line(co, p.c, p.x - p.size * 2.5, p.y, p.x + p.size * 2.5, p.y, .8, a); line(co, p.c, p.x, p.y - p.size * 2.5, p.x, p.y + p.size * 2.5, .8, a); } });
        co.globalCompositeOperation = 'source-over';
        shards.each((p, k) => { co.globalAlpha = 1 - k; co.fillStyle = p.c; co.save(); co.translate(p.x, p.y); co.rotate(p.life * 9); co.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .6); co.restore(); });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) build = 0; },
      build() { build = 1; dimAt = t; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        revealed = true; build = 0;
        if (!p) { // une ampoule claque : éclair blanc, éclats de verre, puis plus rien
          const S = slotsA(env).filter(s => !s.gone && !s.ghost);
          const b = S.length ? pick(S) : null;
          if (b) { dead = b.i; deadAt = t; const y = wire(b.x) + card.h * .2; for (let n = 6; n > 0; n--) shards.add({ x: b.x, y, vx: rnd(-40, 40), vy: rnd(-60, 10), g: 500, drag: .5, max: rnd(.5, .9), size: rnd(1.5, 3), c: pick(['#e2e8f0', '#94a3b8', HUES[b.i % 6]]) }); }
          return;
        }
        chases.add({ life: 1.1 + 1.2 * p + .5 * asc, passes: 1 + Math.round(2 * p) + asc, p: .9 + .5 * p });
        if (p >= .6) for (let n = burst(p, 60 * q, 6); n > 0; n--) glitter.add({ x: rnd(card.x - card.h, card.x + card.w + card.h), y: card.y - card.h * rnd(.5, 1.1), vx: rnd(-20, 20), vy: rnd(0, 40), g: 60, drag: .8, max: rnd(1.4, 2.6), size: rnd(1, 2.4), c: pick(['#fde68a', '#fbbf24', '#fff7ed']) });
        if (p >= 1) { rainbow = 1 + .5 * asc; garlands.add({ delay: .2, life: 4 + asc }); }
      },
    };
  };

  // 🔨 Elves' Workshop (2026-10-27, idée de costoroll) — six lutins en ombres chinoises, à contre-jour d'une lampe, se
  // tiennent derrière le tapis roulant, un par chiffre (leur corps passe derrière la carte). Le lutin du prochain chiffre
  // lève son marteau et attend en tremblant (l'élan) ; quand le chiffre se pose, le marteau s'abat d'un coup sur la
  // planchette (traînée du coup, copeaux, sciure), au même instant que le chiffre apparaît. Avant le dernier chiffre, son
  // lutin tremble plus fort et les autres se penchent pour voir. Révélation : tirage raté, les lutins baissent les bras ;
  // sinon une ola de petits sauts ; dès Mythic, un roulement de marteaux, les bonnets volent et des confettis rouges,
  // verts et or ; dès Divine, un paquet cadeau surgit derrière la carte et s'ouvre dans une gerbe d'étoiles.
  SCENES.workshop = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const chips = particles(), dust = particles(), confetti = particles(), hats = particles(), gifts = timed();
    const st = new Map(); // par case : { a (angle du bras), hitAt, hop, gone }
    const INK = '#1c130d', RIM = dark ? 'rgba(251,191,36,.7)' : 'rgba(146,64,14,.45)';
    let t = 0, build = 0, mood = '', moodAt = 0, rollUntil = -1;
    const G = card.h * 20, hopV = hmax => Math.sqrt(2 * G * hmax); // petits sauts à l'échelle de la carte
    const later = [], after = (d, fn) => later.push({ at: t + d, fn }); // en temps de scène (pas setTimeout : le trailer avance la scène lui-même)
    const REST = -1.15, READY = -2.05, HIT = 1.72; // angles du bras (0 = vers la droite, positif = vers le bas)
    // Un lutin : pieds cachés derrière la carte, la tête et le bonnet au-dessus ; v : variante (taille, bonnet à gauche
    // ou à droite) pour qu'une rangée de six ne fasse pas une seule tache. Le bras et le marteau sont dessinés devant :
    // au coup, la tête du marteau touche le haut de la planchette (tx, ty).
    const elf = (x, base, u, a, hop, lean, alpha, hatless, smear, tx, ty, v) => {
      const y = base - hop, z = v % 2 ? .93 : 1, side = v % 2 ? -1 : 1;
      co.save(); co.globalAlpha = alpha;
      behind(env, () => {
        co.save(); co.translate(x, y); co.rotate(lean); co.scale(z, z); co.fillStyle = INK;
        co.beginPath(); co.moveTo(-u * .3, u * 1.6); co.lineTo(-u * .24, -u * .58); co.quadraticCurveTo(0, -u * .74, u * .24, -u * .58); co.lineTo(u * .3, u * 1.6); co.closePath(); co.fill();
        co.beginPath(); co.arc(0, -u * .95, u * .23, 0, TAU); co.fill();
        co.beginPath(); co.moveTo(-u * .2, -u * 1); co.lineTo(-u * .42, -u * 1.16); co.lineTo(-u * .18, -u * .86); co.closePath(); co.fill();
        co.beginPath(); co.moveTo(u * .2, -u * 1); co.lineTo(u * .42, -u * 1.16); co.lineTo(u * .18, -u * .86); co.closePath(); co.fill();
        if (!hatless) {
          const sw = Math.sin(t * 3 + x * .1) * .1, tipx = side * u * (.4 + sw), tipy = -u * 1.68;
          co.beginPath(); co.moveTo(-u * .27, -u * 1.04); co.quadraticCurveTo(side * u * .02, -u * 2.05, tipx, tipy); co.quadraticCurveTo(side * u * .1, -u * 1.5, u * .27, -u * 1.04); co.closePath(); co.fill();
          co.beginPath(); co.arc(tipx, tipy + u * .02, u * .09, 0, TAU); co.fill();
          co.fillRect(-u * .3, -u * 1.09, u * .6, u * .09); // le revers du bonnet
        }
        // liseré de lumière (la lampe est derrière eux)
        co.strokeStyle = RIM; co.lineWidth = Math.max(1, u * .05); co.beginPath(); co.arc(0, -u * .95, u * .23, Math.PI * 1.05, Math.PI * 1.55); co.stroke();
        co.restore();
      }, true);
      const sx = x + u * .12, sy = y - u * .56, L = Math.hypot(tx - sx, ty - sy), hitA = Math.atan2(ty - sy, tx - sx);
      const arm = (ang, al) => {
        const k = ang >= 1.2 ? hitA / HIT : 1; // au coup, l'angle exact qui pose le marteau sur la planchette
        ang *= k;
        const hx = sx + Math.cos(ang) * L * .36, hy = sy + Math.sin(ang) * L * .36, ex = sx + Math.cos(ang) * L, ey = sy + Math.sin(ang) * L;
        co.globalAlpha = alpha * al; co.strokeStyle = INK; co.lineCap = 'round';
        co.lineWidth = Math.max(2.2, u * .13); co.beginPath(); co.moveTo(sx, sy); co.lineTo(hx, hy); co.stroke();
        co.lineWidth = Math.max(1.4, u * .07); co.beginPath(); co.moveTo(hx, hy); co.lineTo(ex, ey); co.stroke();
        co.save(); co.translate(ex, ey); co.rotate(ang + Math.PI / 2); co.fillStyle = INK; roundRect(co, -u * .22, -u * .12, u * .44, u * .24, u * .05); co.fill();
        co.globalAlpha = alpha * al * .8; co.fillStyle = RIM; co.fillRect(-u * .2, -u * .12, u * .4, Math.max(1, u * .04)); co.restore();
      };
      if (smear) for (let k = 1; k <= 3; k++) arm(lerp(smear, a, k / 4), .16 * k);
      arm(a, 1);
      co.restore();
    };
    // un coup de marteau sur la case s (force f : 1 pour un chiffre, moins pour le roulement)
    const hit = (s, f) => {
      const e = st.get(s.i); if (e) e.hitAt = t;
      const y = card.y + 2;
      for (let n = Math.round((6 + 10 * f) * q); n > 0; n--) { const an = rnd(-Math.PI * .95, -Math.PI * .05); chips.add({ x: s.x + rnd(-4, 4), y, vx: Math.cos(an) * rnd(60, 180) * f, vy: Math.sin(an) * rnd(80, 240) * f, g: 700, drag: .6, max: rnd(.5, .9), size: rnd(1.5, 3), spin: rnd(-14, 14), r: rnd(TAU), c: pick(['#f3d39b', '#e6b874', '#d4a05a', '#fde7c0']) }); }
      for (let n = Math.round(3 * f * q) + 1; n > 0; n--) dust.add({ x: s.x + rnd(-8, 8), y: y + rnd(-2, 2), vx: rnd(-30, 30), vy: rnd(-25, -5), drag: 2, max: rnd(.4, .7), size: rnd(3, 6) });
    };
    return {
      frame(tt, dt) {
        const was = t; t = tt;
        for (let i = later.length - 1; i >= 0; i--) if (later[i].at <= t) later.splice(i, 1)[0].fn();
        const S = slotsA(env), live = S.filter(s => !s.gone), next = live.find(s => !s.on);
        const u = live.length > 1 ? Math.min(card.h * .56, (live[live.length - 1].x - live[0].x) / (live.length - 1) * 1.05) : card.h * .5;
        // la lampe de l'atelier, derrière les lutins
        behind(env, () => {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          dot(co, '#f59e0b', cx, card.y - u * .9, card.w * .62, dark ? .5 : .38, card.h * .9);
          dot(co, '#fde68a', cx, card.y - u * 1.1, card.w * .35, dark ? .35 : .25, card.h * .5);
          co.globalCompositeOperation = 'source-over';
        }, true);
        S.forEach(s => {
          let e = st.get(s.i);
          if (!e) st.set(s.i, e = { a: REST, hitAt: -9, hop: 0, vh: 0, fade: 1, hat: false });
          e.fade = s.gone ? Math.max(0, e.fade - dt * 4) : 1;
          if (e.fade <= 0) return;
          // le bras : levé pour le prochain chiffre, abattu au moment du coup, puis il revient
          let target = REST, smear = 0;
          const since = t - e.hitAt;
          if (since < .05) { e.a = lerp(READY, HIT, (since / .05) ** 2); smear = READY; }
          else if (since < .14) e.a = HIT;
          else if (since < .5) target = REST;
          else if (next && next.i === s.i) target = READY + Math.sin(t * (18 + 30 * build)) * (.05 + .1 * build);
          if (mood === 'sad') target = .3; // bras ballants, le marteau pend sur le côté (jamais devant les chiffres)
          if (mood === 'cheer' && t - moodAt > .1) target = READY + .2;
          if (since >= .14) e.a += (target - e.a) * Math.min(1, dt * (since < .5 ? 9 : 12));
          // le roulement de marteaux (Mythic) : chacun frappe à son tour
          if (t < rollUntil && s.on && !s.ghost && Math.floor(t * 9 + s.i * 1.7) !== Math.floor(was * 9 + s.i * 1.7)) hit(s, .35);
          // petits sauts (ola)
          e.vh -= G * dt; e.hop = Math.max(0, e.hop + e.vh * dt); if (e.hop === 0) e.vh = Math.max(0, e.vh);
          const lean = mood === 'sad' ? .12 * Math.sin(s.i) : build && next && next.i !== s.i ? clamp((next.x - s.x) / card.w, -1, 1) * .25 : 0;
          elf(s.x, card.y + card.h * .05, u, e.a, e.hop, lean, e.fade * (s.ghost ? .55 : 1), e.hat, smear, s.x, s.top + 1, s.i);
        });
        // copeaux et sciure
        chips.step(dt); dust.step(dt); confetti.step(dt); hats.step(dt);
        dust.each((d, k) => dot(co, dark ? '#d6b98c' : '#a8825a', d.x, d.y, d.size * (1 + k), (1 - k) * .45));
        chips.each((c, k) => { co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = c.c; co.save(); co.translate(c.x, c.y); co.rotate(c.r + c.life * c.spin); co.fillRect(-c.size, -c.size * .35, c.size * 2, c.size * .7); co.restore(); });
        confetti.each((c, k) => { co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = c.c; co.save(); co.translate(c.x, c.y); co.rotate(c.life * c.spin); co.scale(1, Math.cos(c.life * 9 + c.r)); co.fillRect(-c.size, -c.size * .6, c.size * 2, c.size * 1.2); co.restore(); });
        hats.each((c, k) => { co.globalAlpha = Math.min(1, (1 - k) * 4); co.save(); co.translate(c.x, c.y); co.rotate(c.life * c.spin); co.fillStyle = c.c; co.beginPath(); co.moveTo(-c.size * .5, c.size * .4); co.quadraticCurveTo(0, -c.size * 1.2, c.size * .6, -c.size * .7); co.quadraticCurveTo(c.size * .1, -c.size * .3, c.size * .5, c.size * .4); co.closePath(); co.fill(); co.fillStyle = '#f8fafc'; co.fillRect(-c.size * .55, c.size * .3, c.size * 1.1, c.size * .22); co.beginPath(); co.arc(c.size * .62, -c.size * .7, c.size * .16, 0, TAU); co.fill(); co.restore(); });
        // le cadeau (Divine et plus) : il monte derrière la carte, le couvercle saute, gerbe d'étoiles
        gifts.run(dt, (g, k) => {
          const rise = outBack(clamp(k * 3)), s = card.h * .7, x = cx, y = card.y - s * .5 * rise + s * .2, open = clamp((k - .3) * 5);
          behind(env, () => {
            co.globalAlpha = clamp((1 - k) * 4);
            if (open > 0) godrays(co, '#fde68a', x, y - s * .4, 12, s * .2, s * (1.2 + .8 * g.asc), t * .6, 7, open * .6);
            co.globalAlpha = clamp((1 - k) * 4); co.fillStyle = '#dc2626'; co.fillRect(x - s * .45, y - s * .4, s * .9, s * .8);
            co.fillStyle = '#fbbf24'; co.fillRect(x - s * .08, y - s * .4, s * .16, s * .8);
            co.save(); co.translate(x + open * s * .6, y - s * .45 - open * s * .7); co.rotate(open * .8); co.fillStyle = '#b91c1c'; co.fillRect(-s * .5, -s * .1, s, s * .2); co.fillStyle = '#fbbf24'; co.fillRect(-s * .08, -s * .1, s * .16, s * .2); co.restore();
          }, true);
          if (open > 0 && !g.pop) { g.pop = true; for (let n = Math.round(40 * q); n > 0; n--) { const an = rnd(-Math.PI, 0); confetti.add({ x, y: y - s * .4, vx: Math.cos(an) * rnd(80, 260), vy: Math.sin(an) * rnd(120, 320), g: 420, drag: 1, max: rnd(1.2, 2), size: rnd(2, 3.5), spin: rnd(-10, 10), r: rnd(TAU), c: pick(['#fde68a', '#fbbf24', '#fff7ed']) }); } }
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const S = slotsA(env), s = S.reduce((b, x) => (Math.abs(x.x - p.x) < Math.abs(b.x - p.x) ? x : b), S[0] || { x: p.x, i: -1 });
        if (s.i < 0) return;
        if (o.last) build = 0;
        hit(s, o.ghost ? .3 : o.last ? 1.4 : 1);
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; moodAt = t;
        const S = slotsA(env).filter(s => !s.gone);
        if (!p) { mood = 'sad'; const s = S[S.length - 1]; if (s) chips.add({ x: s.x, y: card.y, vx: 20, vy: -60, g: 500, drag: .3, max: 1, size: 2.5, spin: 6, r: 0, c: '#d4a05a' }); return; }
        mood = 'cheer';
        S.forEach((s, j) => after(j * .06, () => { const e = st.get(s.i); if (e && !e.hop) e.vh = hopV(card.h * (.1 + .12 * p)); }));
        if (p >= .6) S.forEach((s, j) => after(.5 + j * .06, () => { const e = st.get(s.i); if (e && !e.hop) e.vh = hopV(card.h * (.12 + .12 * p)); }));
        if (p >= 1) {
          rollUntil = t + 1.1;
          after(1.15, () => {
            S.forEach((s, j) => { const e = st.get(s.i); if (!e || s.ghost) return; e.hat = true; e.vh = hopV(card.h * .3); hats.add({ x: s.x + card.h * .1, y: card.y - card.h * .75, vx: rnd(-50, 50), vy: -rnd(260, 380), g: 520, drag: .2, max: 1.6, size: card.h * .2, spin: rnd(-8, 8), c: INK }); });
            for (let n = burst(1, 80 * q, 10) + 30 * asc; n > 0; n--) { const an = rnd(-Math.PI * .9, -Math.PI * .1); confetti.add({ x: cx + rnd(-.5, .5) * card.w, y: card.y - card.h * .3, vx: Math.cos(an) * rnd(60, 280), vy: Math.sin(an) * rnd(160, 380), g: 380, drag: 1, max: rnd(1.4, 2.4), size: rnd(2, 4), spin: rnd(-10, 10), r: rnd(TAU), c: pick(['#dc2626', '#16a34a', '#fbbf24', '#f8fafc']) }); }
          });
          if (asc >= 2) gifts.add({ delay: 1.3, life: 2.6, asc });
        }
      },
    };
  };

  // ❄️ Snow Reveal (2026-10-27, idée de G8_floppa) — la neige tombe autour de la carte (derrière elle : un flocon ne
  // passe jamais sur un chiffre) et sur la carte elle-même. À chaque chiffre posé, la poudreuse qui le couvrait s'envole
  // en bouffées et en paillettes (plus fort pour le dernier) ; avant le dernier, le vent se lève et les flocons filent
  // de côté. Révélation : tirage raté, un paquet de neige glisse du haut de la carte et tombe ; sinon un tourbillon de
  // flocons ; dès Epic, des paillettes de givre ; dès Mythic, une aurore boréale ondule au-dessus de la carte, la neige
  // redouble et de grands cristaux à six branches tombent en tournant.
  SCENES.snowreveal = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const flakes = particles(), inner = particles(), powder = particles(), glints = particles(), crystals = particles(), swirl = particles(), clumps = timed(), auroras = timed();
    const emit = emitter(), emitIn = emitter();
    const FLAKE = dark ? '#f8fafc' : '#94a3b8', GLINT = dark ? '#e0f2fe' : '#38bdf8';
    let t = 0, wind = 0, build = 0, heavy = 0;
    const flake = (x, y, big) => flakes.add({ x, y, vx: 0, vy: rnd(18, 40) * (big ? 1.4 : 1), max: rnd(3, 5), size: rnd(1, 2.3) * (big ? 1.3 : 1), ph: rnd(TAU) });
    const crystal = (c, x, y, r, rot, a) => { // un cristal à six branches, tracé au trait
      c.save(); c.globalAlpha = a; c.translate(x, y); c.rotate(rot); c.lineCap = 'round';
      for (const [col, wd] of [[dark ? 'rgba(14,165,233,.35)' : 'rgba(30,64,175,.35)', 3.2], [dark ? '#f0f9ff' : '#3b82f6', 1.4]]) {
        c.strokeStyle = col; c.lineWidth = wd;
        for (let i = 0; i < 6; i++) { c.rotate(TAU / 6); c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -r); c.moveTo(0, -r * .55); c.lineTo(-r * .22, -r * .75); c.moveTo(0, -r * .55); c.lineTo(r * .22, -r * .75); c.stroke(); }
      }
      c.restore();
    };
    const glint = (c, x, y, s, a, col) => { line(c, col, x - s, y, x + s, y, 1, a); line(c, col, x, y - s, x, y + s, 1, a); dot(c, col, x, y, s * .8, a); };
    return {
      frame(tt, dt) {
        t = tt;
        wind += ((build ? 1 : .12) - wind) * Math.min(1, dt * 2);
        heavy = Math.max(0, heavy - dt * .12);
        // la neige autour de la carte, derrière elle
        for (let n = emit((5 + 34 * heavy + 6 * build) * q, dt); n > 0; n--) flake(rnd(card.x - card.h * 1.2, card.x + card.w + card.h * .8), card.y - card.h * rnd(.4, 1.3), heavy > .3);
        flakes.step(dt);
        behind(env, () => {
          co.fillStyle = FLAKE;
          flakes.each((f, k) => { co.globalAlpha = Math.min(1, k * 8, (1 - k) * 3) * .9; f.x += wind * 90 * dt; co.beginPath(); co.arc(f.x + Math.sin(t * 1.7 + f.ph) * 5, f.y, f.size, 0, TAU); co.fill(); });
          crystals.step(dt);
          crystals.each((c, k) => crystal(co, c.x + Math.sin(t + c.ph) * 8, c.y, c.r, c.rot + t * c.spin, Math.min(1, k * 6, (1 - k) * 3)));
        });
        // sur la carte : quelques flocons bleu pâle, derrière les chiffres
        for (let n = emitIn((6 + 10 * heavy) * q, dt); n > 0; n--) inner.add({ x: rnd(0, w), y: -3, vx: 0, vy: rnd(10, 22), max: rnd(2.5, 4), size: rnd(.8, 1.6), ph: rnd(TAU) });
        inner.step(dt);
        ci.fillStyle = '#bfdbfe';
        inner.each((f, k) => { ci.globalAlpha = Math.min(1, (1 - k) * 3) * .9; f.x += wind * 60 * dt; ci.beginPath(); ci.arc(f.x + Math.sin(t * 2 + f.ph) * 3, f.y, f.size, 0, TAU); ci.fill(); });
        ci.globalAlpha = 1;
        // l'aurore boréale (Mythic et plus) : des rideaux de lumière qui ondulent au-dessus de la carte
        auroras.run(dt, (a, k) => {
          const A = Math.min(1, k * 4, (1 - k) * 2.5) * (dark ? .55 : .4), top = card.y - card.h * (1.5 + .3 * a.asc), bot = card.y + card.h * .2;
          behind(env, () => {
            co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
            const cols = dark ? ['#4ade80', '#2dd4bf', '#a78bfa'] : ['#16a34a', '#0d9488', '#7c3aed'], span = card.w + card.h * 2, n = Math.round(22 * Math.max(.7, q));
            for (let i = 0; i < n; i++) {
              const u = i / (n - 1), x = card.x - card.h + u * span, wav = Math.sin(u * 6 + t * 1.4) * card.h * .22 + Math.sin(u * 11 - t * 2.1) * card.h * .1;
              const col = cols[(i + Math.floor(t * .5)) % 3], hh = (bot - top) * (.75 + .25 * Math.sin(u * 5 + t)), y = top + wav + hh * .5;
              dot(co, col, x, y, span / n * 1.6, A * (.55 + .45 * Math.sin(u * 9 + t * 2.4)), hh * .55);
              dot(co, '#ecfeff', x, y - hh * .18, span / n * .5, A * .25, hh * .3);
            }
            co.globalCompositeOperation = 'source-over';
          }, true);
        });
        // le tourbillon (révélation) : des flocons qui tournent autour de la carte
        swirl.step(dt);
        behind(env, () => { co.fillStyle = FLAKE; swirl.each((f, k) => { const an = f.a + f.life * f.w, x = cx + Math.cos(an) * f.r * (1 + k * .3), y = card.y + card.h / 2 + Math.sin(an) * f.r * .45; co.globalAlpha = Math.min(1, k * 5, (1 - k) * 2); co.beginPath(); co.arc(x, y, f.size, 0, TAU); co.fill(); }); });
        // la poudreuse qui s'envole d'un chiffre : des bouffées blanches au bord bleuté, puis des paillettes
        powder.step(dt); glints.step(dt);
        powder.each((p, k) => { const r = p.size * (1 + 1.6 * k), a = (1 - k) * .85; co.globalAlpha = a * .55; co.fillStyle = 'rgba(148,163,184,.6)'; co.beginPath(); co.arc(p.x + r * .12, p.y + r * .15, r, 0, TAU); co.fill(); co.globalAlpha = a; co.fillStyle = '#ffffff'; co.beginPath(); co.arc(p.x, p.y, r, 0, TAU); co.fill(); });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        glints.each((g, k) => glint(co, g.x, g.y, g.size * (1 - k * .5), (1 - k) * (.6 + .4 * Math.sin(t * 25 + g.x)), GLINT));
        co.globalCompositeOperation = 'source-over';
        // le paquet de neige (tirage raté) : il glisse sur le haut de la carte, bascule et tombe
        clumps.run(dt, (c, k) => {
          const r = card.h * .14, x0 = card.x + card.w * .55, x1 = card.x + card.w + r * .3;
          let x, y, rot = 0;
          if (k < .45) { const e = (k / .45) ** 2; x = lerp(x0, x1, e); y = card.y - r * .7; rot = e * 1.2; }
          else { const e = (k - .45) / .55; x = x1 + e * card.h * .25; y = card.y - r * .7 + e * e * card.h * 1.6; rot = 1.2 + e * 3; if (e > .97 && !c.done) { c.done = true; } }
          co.save(); co.globalAlpha = Math.min(1, (1 - k) * 8); co.translate(x, y); co.rotate(rot);
          co.fillStyle = '#fff'; co.strokeStyle = dark ? 'rgba(148,163,184,.8)' : '#94a3b8'; co.lineWidth = 1.2;
          co.beginPath(); co.arc(-r * .3, 0, r * .6, 0, TAU); co.arc(r * .3, -r * .1, r * .7, 0, TAU); co.arc(0, r * .25, r * .55, 0, TAU); co.fill(); co.stroke();
          co.restore();
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const n = Math.round((o.ghost ? 4 : o.last ? 26 : 14) * q), f = o.last ? 1.4 : 1;
        for (let i = n; i > 0; i--) powder.add({ x: p.x + rnd(-1, 1) * card.h * .2, y: p.y - card.h * rnd(.15, .35), vx: rnd(-80, 80) * f, vy: -rnd(150, 280) * f, drag: 3, g: 60, max: rnd(.45, .9), size: card.h * rnd(.035, .07) });
        for (let i = Math.round((o.ghost ? 2 : o.last ? 14 : 6) * q); i > 0; i--) glints.add({ x: p.x + rnd(-1, 1) * card.h * .3, y: p.y + rnd(-.5, .2) * card.h, vx: rnd(-40, 40), vy: -rnd(20, 90), drag: 1.5, g: 30, max: rnd(.5, 1.1), size: rnd(2, 4) });
        if (o.last) build = 0;
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { clumps.add({ delay: .15, life: 1.3 }); return; }
        for (let i = Math.round((14 + 30 * p) * q); i > 0; i--) swirl.add({ a: rnd(TAU), w: rnd(2, 3.5) * (Math.random() < .5 ? 1 : -1), r: card.w * rnd(.55, .8), max: rnd(1.2, 2.2), size: rnd(1.2, 2.4), x: 0, y: 0, vx: 0, vy: 0 });
        if (p >= .6) for (let i = burst(p, 40 * q, 6); i > 0; i--) glints.add({ x: cx + rnd(-.6, .6) * card.w, y: card.y + rnd(-.6, 1) * card.h, vx: rnd(-30, 30), vy: -rnd(10, 60), drag: 1, g: 20, max: rnd(.8, 1.6), size: rnd(2, 4.5) });
        if (p >= 1) {
          heavy = 1;
          auroras.add({ life: 5 + 1.5 * asc, asc });
          for (let i = 0; i < Math.round((5 + 3 * asc) * q) + 2; i++) crystals.add({ x: rnd(card.x - card.h * .9, card.x + card.w + card.h * .9), y: card.y - card.h * rnd(.6, 1.6), vx: 0, vy: rnd(22, 40), max: rnd(3.5, 5), r: card.h * rnd(.14, .24), rot: rnd(TAU), spin: rnd(-1, 1), ph: rnd(TAU) });
        }
      },
    };
  };

  // 🪦 Graveyard (2026-10-27, idée d'IXOLAF2) — une brume violette traîne au ras du sol, derrière les tombes et autour de
  // la carte. À chaque chiffre posé, des mottes de terre sautent au pied de sa tombe (la dernière avec une lueur verte) ;
  // avant le dernier, le sol tremble et une lueur verte pulse sous sa tombe. Révélation, gentille et pas gore : tirage
  // raté, un petit nuage de poussière ; sinon une chauve-souris file devant la lune (plus avec la rareté) ; dès Epic, une
  // ou deux mains vertes de dessin animé sortent de tombes au hasard et font coucou ; dès Mythic, une main sort de chaque
  // tombe, et deux grandes mains de chaque côté de la carte ; dès Celestial, un petit fantôme monte derrière la carte.
  SCENES.graves = env => {
    const { ci, co, w, h, W, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const fog = [], clods = particles(), bats = particles(), hands = timed(), ghosts = timed(), glows = timed();
    for (let i = 0; i < 7; i++) fog.push({ x: rnd(-.2, 1.2), y: rnd(.62, .95), r: rnd(.35, .6), v: rnd(.02, .05) * (i % 2 ? 1 : -1), ph: rnd(TAU) });
    let t = 0, build = 0, shake = 0;
    const ground = () => card.y + card.h - 2;
    // Une main de dessin animé : paume verte, quatre doigts, pouce, manche violet déchiré ; (x, y) = poignet au sol.
    const hand = (x, y, s, rot, wave, flip) => {
      co.save(); co.translate(x, y); co.rotate(rot + wave); co.scale(flip ? -1 : 1, 1);
      const OUT = '#14532d', SKIN = '#86efac', SH = '#4ade80';
      co.lineJoin = 'round'; co.lineWidth = Math.max(1.2, s * .07); co.strokeStyle = OUT;
      // manche
      co.fillStyle = '#6d28d9'; co.beginPath(); co.moveTo(-s * .3, s * .1); co.lineTo(-s * .32, s * .9); co.lineTo(s * .32, s * .9); co.lineTo(s * .3, s * .1); co.lineTo(s * .18, s * .2); co.lineTo(s * .06, s * .06); co.lineTo(-s * .08, s * .2); co.lineTo(-s * .2, s * .05); co.closePath(); co.fill(); co.stroke();
      // doigts (le majeur plus long), pouce, paume
      co.fillStyle = SKIN;
      [[-.2, .42], [-.07, .52], [.07, .5], [.2, .4]].forEach(([fx, fl]) => { roundRect(co, s * fx - s * .06, -s * (.3 + fl), s * .12, s * (fl + .1), s * .06); co.fill(); co.stroke(); });
      co.beginPath(); co.ellipse(-s * .3, -s * .22, s * .07, s * .17, -.7, 0, TAU); co.fill(); co.stroke();
      roundRect(co, -s * .27, -s * .34, s * .54, s * .46, s * .14); co.fill(); co.stroke();
      co.fillStyle = SH; co.globalAlpha *= .6; co.beginPath(); co.ellipse(s * .08, -s * .08, s * .12, s * .08, 0, 0, TAU); co.fill();
      co.restore();
    };
    const bat = (x, y, s, flap, a) => {
      co.save(); co.globalAlpha = a; co.translate(x, y);
      const up = Math.sin(flap) * s * .5;
      co.fillStyle = dark ? '#4c1d95' : '#2e1065'; co.strokeStyle = dark ? 'rgba(221,214,254,.85)' : 'rgba(46,16,101,.6)'; co.lineWidth = 1.2;
      co.beginPath(); co.moveTo(0, 0); co.quadraticCurveTo(-s * .5, -up - s * .2, -s, -up); co.quadraticCurveTo(-s * .75, -up * .3 + s * .1, -s * .55, s * .12); co.quadraticCurveTo(-s * .3, 0, 0, s * .2);
      co.quadraticCurveTo(s * .3, 0, s * .55, s * .12); co.quadraticCurveTo(s * .75, -up * .3 + s * .1, s, -up); co.quadraticCurveTo(s * .5, -up - s * .2, 0, 0); co.fill(); co.stroke();
      co.beginPath(); co.arc(0, s * .05, s * .18, 0, TAU); co.fill();
      co.fillStyle = '#fde047'; co.beginPath(); co.arc(-s * .07, s * .02, s * .04, 0, TAU); co.arc(s * .07, s * .02, s * .04, 0, TAU); co.fill();
      co.restore();
    };
    return {
      frame(tt, dt) {
        t = tt;
        shake = Math.max(0, shake - dt * 3);
        // la brume dans la carte, derrière les tombes
        ci.globalCompositeOperation = 'lighter';
        for (const f of fog) { f.x += f.v * dt; if (f.x > 1.4) f.x = -.4; if (f.x < -.4) f.x = 1.4; dot(ci, '#a78bfa', f.x * w, f.y * h + Math.sin(t * .8 + f.ph) * 2, h * f.r, .16 + .1 * build, h * f.r * .45); }
        // la lueur verte sous la tombe du dernier chiffre, pendant la tension
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on);
        if (build && next) dot(ci, '#22c55e', next.x - card.x, h * .92, h * .5, .25 + .2 * Math.sin(t * 14), h * .25);
        glows.run(dt, (g, k) => dot(ci, '#4ade80', g.x - card.x, h * .9, h * .55, (1 - k) * .55, h * .3));
        ci.globalCompositeOperation = 'source-over';
        // la brume autour de la carte, derrière elle
        behind(env, () => {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          for (let i = 0; i < 4; i++) dot(co, dark ? '#a78bfa' : '#c4b5fd', card.x + card.w * (i / 3) + Math.sin(t * .5 + i) * 12, ground() + 2, card.h * .55, (dark ? .16 : .3) + .1 * build, card.h * .2);
          co.globalCompositeOperation = 'source-over';
        });
        // le petit fantôme (Celestial et plus) : il monte derrière la carte, ondule et fait coucou
        ghosts.run(dt, (g, k) => {
          const s = card.h * .55, y = card.y - card.h * .1 - outCubic(clamp(k * 2)) * card.h * .9 - Math.sin(t * 2.4) * 4, x = cx + Math.sin(t * 1.3) * card.h * .3, a = Math.min(1, k * 5, (1 - k) * 3) * .92;
          behind(env, () => {
            co.save(); co.globalAlpha = a; co.translate(x, y);
            co.fillStyle = '#f8fafc'; co.strokeStyle = 'rgba(76,29,149,.5)'; co.lineWidth = 1.4;
            co.beginPath(); co.arc(0, 0, s * .45, Math.PI, 0); co.lineTo(s * .45, s * .5);
            for (let i = 0; i < 4; i++) { const x0 = s * .45 - (i + .5) * s * .225; co.quadraticCurveTo(x0, s * (.62 + .08 * Math.sin(t * 8 + i)), x0 - s * .1125, s * .5); }
            co.lineTo(-s * .45, 0); co.closePath(); co.fill(); co.stroke();
            co.fillStyle = '#1e1b4b'; co.beginPath(); co.ellipse(-s * .14, -s * .05, s * .06, s * .09, 0, 0, TAU); co.ellipse(s * .14, -s * .05, s * .06, s * .09, 0, 0, TAU); co.fill();
            co.beginPath(); co.ellipse(0, s * .14, s * .07, s * .05, 0, 0, TAU); co.fill();
            co.restore();
          }, true);
        });
        // les mains : elles jaillissent du sol devant la tombe (coupées à la ligne du sol), font coucou, redescendent
        hands.run(dt, (m, k) => {
          const life = m.life, tt2 = k * life, up = tt2 < .3 ? outBack(tt2 / .3) : tt2 > life - .45 ? clamp((life - tt2) / .45) : 1;
          if (!m.dug && tt2 > 0) { m.dug = true; for (let i = Math.round(6 * q); i > 0; i--) clods.add({ x: m.x + rnd(-m.s * .3, m.s * .3), y: m.ground, vx: rnd(-60, 60), vy: -rnd(60, 160), g: 700, drag: .3, max: rnd(.4, .8), size: rnd(1.5, 3) }); }
          co.save(); co.beginPath(); co.rect(0, 0, W, m.ground); co.clip();
          hand(m.x, m.ground + m.s * .95 - up * m.s * m.rise, m.s, m.rot, Math.sin(tt2 * 9 + m.ph) * .28 * clamp(tt2 * 3 - .6), m.flip);
          co.restore();
          if (m.mound) { co.globalAlpha = clamp(up * 3); co.fillStyle = '#3b2a1e'; co.beginPath(); co.ellipse(m.x, m.ground, m.s * .6, m.s * .16, 0, Math.PI, 0); co.fill(); co.fillStyle = '#5b3a24'; co.beginPath(); co.ellipse(m.x - m.s * .15, m.ground - m.s * .05, m.s * .2, m.s * .06, 0, Math.PI, 0); co.fill(); co.globalAlpha = 1; } // le monticule de terre d'où sort la grande main
        });
        // mottes de terre
        clods.step(dt);
        co.fillStyle = '#5b3a24';
        clods.each((c, k) => { co.globalAlpha = Math.min(1, (1 - k) * 4); co.beginPath(); co.arc(c.x, c.y, c.size, 0, TAU); co.fill(); });
        // chauves-souris
        bats.step(dt);
        bats.each((b, k) => bat(b.x, b.y + Math.sin(t * 6 + b.ph) * 4, b.s, t * 22 + b.ph, Math.min(1, k * 8, (1 - k) * 4)));
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const n = Math.round((o.ghost ? 2 : o.last ? 12 : 6) * q);
        for (let i = n; i > 0; i--) clods.add({ x: p.x + rnd(-1, 1) * card.h * .2, y: ground(), vx: rnd(-70, 70), vy: -rnd(70, 170) * (o.last ? 1.3 : 1), g: 700, drag: .3, max: rnd(.4, .8), size: rnd(1.4, 2.8) });
        if (!o.ghost) glows.add({ x: p.x, life: o.last ? 1 : .5 });
        if (o.last) build = 0;
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { for (let i = Math.round(6 * q); i > 0; i--) clods.add({ x: cx + rnd(-1, 1) * card.w * .3, y: ground(), vx: rnd(-20, 20), vy: -rnd(20, 60), g: 300, drag: 1, max: .7, size: rnd(1, 2) }); return; }
        const nb = 1 + Math.round(3 * p) + 2 * asc;
        for (let i = 0; i < nb; i++) { const dir = i % 2 ? -1 : 1; bats.add({ x: cx + rnd(-.3, .3) * card.w, y: card.y + card.h * .1, vx: dir * rnd(90, 170), vy: -rnd(70, 140), drag: .2, g: -10, max: rnd(1.6, 2.4), s: card.h * rnd(.18, .26), ph: rnd(TAU) }); }
        if (p < .6) return;
        const S = slotsA(env).filter(s => !s.gone && !s.ghost);
        const pickHands = p >= 1 ? S : S.slice().sort(() => Math.random() - .5).slice(0, p >= .8 ? 2 : 1);
        pickHands.forEach((s, i) => {
          const room = Math.max(card.h * .14, ground() - (s.top + (s.bottom - s.top) * .72)); // de la place sous le chiffre gravé
          hands.add({ delay: .1 + i * .12, life: 2.6 + asc * .4, x: s.x + rnd(-2, 2), ground: ground(), s: Math.min(s.w * 1.05, room * 1.3), rise: .78, rot: rnd(-.2, .2), ph: rnd(TAU), flip: i % 2 });
        });
        if (p >= 1) [-1, 1].forEach((side, i) => hands.add({ delay: .5 + i * .15, life: 2.8 + asc * .4, x: side < 0 ? card.x - card.h * .45 : card.x + card.w + card.h * .45, ground: ground() + 2, s: card.h * .8, rise: 1.15, rot: side * -.25, ph: i * 2, flip: side > 0, mound: true }));
        if (asc >= 1) ghosts.add({ delay: .7, life: 4 + asc });
      },
    };
  };

  // ⛵ Ship Wake (2026-10-27, idée de 17black) — un petit remorqueur rouge, vu d'en haut, attend en dansant sur l'eau
  // juste au-dessus du prochain chiffre (il le cache encore) ; quand le chiffre se pose, il met les gaz et file jusqu'au
  // suivant : son sillage en V d'écume s'ouvre derrière lui (dans la carte, derrière les chiffres) et le chiffre remonte
  // en surface dans l'écume (animation CSS wake-surface). Avant le dernier, son moteur tourne plus vite (remous). À la fin
  // il sort à droite et attend. Révélation : tirage raté, le moteur cale (fumée noire) ; sinon deux coups de sirène
  // (anneaux de vapeur) et il repart ; dès Epic, des dauphins sautent de chaque côté ; dès Mythic, il fait demi-tour en
  // grand arc au-dessus de la carte en laissant un arc d'écume, et une baleine souffle son jet d'eau derrière la carte.
  SCENES.shipwake = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const foam = particles(), foamOut = particles(), smoke = particles(), rings = timed(), dolphins = timed(), spouts = timed(), drops = particles();
    let t = 0, build = 0, mode = 'sail', modeAt = 0, L = card.h * .5;
    const boat = { x: card.x - card.h * 1.2, y: cy, tx: 0, v: 0, ang: 0, alpha: 1, path: null };
    const draw = (x, y, ang, a) => { // le remorqueur vu d'en haut, l'avant vers +x
      const B = L * .48;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(ang);
      co.fillStyle = 'rgba(8,47,73,.35)'; co.beginPath(); co.ellipse(2, 3, L * .55, B * .62, 0, 0, TAU); co.fill(); // ombre sur l'eau
      const hull = () => { co.beginPath(); co.moveTo(-L * .48, -B * .42); co.lineTo(L * .12, -B * .5); co.quadraticCurveTo(L * .45, -B * .42, L * .52, 0); co.quadraticCurveTo(L * .45, B * .42, L * .12, B * .5); co.lineTo(-L * .48, B * .42); co.quadraticCurveTo(-L * .56, 0, -L * .48, -B * .42); co.closePath(); };
      hull(); co.fillStyle = '#dc2626'; co.fill(); co.lineWidth = Math.max(1.2, L * .05); co.strokeStyle = '#450a0a'; co.stroke();
      co.save(); co.scale(.8, .72); hull(); co.restore(); co.fillStyle = '#e7c49a'; co.fill(); // le pont en bois
      co.fillStyle = '#f8fafc'; roundRect(co, -L * .22, -B * .26, L * .34, B * .52, L * .05); co.fill(); co.strokeStyle = '#334155'; co.lineWidth = 1; co.stroke(); // la cabine
      co.fillStyle = '#1e293b'; co.beginPath(); co.arc(-L * .3, 0, B * .17, 0, TAU); co.fill(); co.fillStyle = '#dc2626'; co.beginPath(); co.arc(-L * .3, 0, B * .09, 0, TAU); co.fill(); // la cheminée
      co.fillStyle = '#facc15'; co.beginPath(); co.arc(L * .36, 0, B * .08, 0, TAU); co.fill(); // le feu de proue
      co.restore();
    };
    // l'écume derrière le bateau : deux bords du V qui s'écartent, plus le bouillon au milieu
    const churn = (x, y, ang, speed, inside) => {
      const bx = x - Math.cos(ang) * L * .5, by = y - Math.sin(ang) * L * .5, nx = -Math.sin(ang), ny = Math.cos(ang), spread = Math.min(1, speed / (card.h * 4));
      const list = inside ? foam : foamOut;
      for (const side of [-1, 1]) list.add({ x: bx + nx * side * L * .2, y: by + ny * side * L * .2, vx: nx * side * card.h * (.35 + .5 * spread) - Math.cos(ang) * 10, vy: ny * side * card.h * (.35 + .5 * spread) - Math.sin(ang) * 10, drag: 2.2, max: rnd(1, 1.6), size: rnd(1.6, 2.8) });
      list.add({ x: bx + rnd(-2, 2), y: by + rnd(-2, 2), vx: -Math.cos(ang) * 20, vy: -Math.sin(ang) * 20, drag: 2, max: rnd(.6, 1), size: rnd(2.4, 4) });
    };
    return {
      frame(tt, dt) {
        t = tt;
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on);
        if (S.length > 1) L = Math.min(card.h * .66, (S[1].x - S[0].x) * 1.3);
        let speed = 0;
        if (boat.path) { // un trajet fixe (demi-tour du Mythic) : p(k) donne la position
          const P = boat.path; P.k = Math.min(1, P.k + dt / P.d);
          const [x, y] = P.at(P.k), [x2, y2] = P.at(Math.min(1, P.k + .01));
          speed = Math.hypot(x - boat.x, y - boat.y) / Math.max(dt, 1e-3); boat.ang = Math.atan2(y2 - y, x2 - x); boat.x = x; boat.y = y;
          if (P.k >= 1) { boat.path = null; mode = 'gone'; modeAt = t; }
        } else {
          if (mode === 'sail') boat.tx = next ? next.x + L * .12 : card.x + card.w + L * 1.1;
          const d = boat.tx - boat.x;
          boat.v = Math.abs(d) < .3 ? 0 : Math.sign(d) * Math.min(Math.abs(d) * 9, Math.max(card.h * .8, Math.abs(d) * 6));
          boat.x += boat.v * dt; speed = Math.abs(boat.v);
          boat.y += (cy + Math.sin(t * 2.2) * card.h * .03 - boat.y) * Math.min(1, dt * 4);
          boat.ang += ((Math.sin(t * 1.7) * .06 - (boat.v > card.h * 2 ? .04 : 0)) - boat.ang) * Math.min(1, dt * 6);
        }
        if (mode === 'leave') boat.alpha = clamp((card.x + card.w + card.h * 2.4 - boat.x) / (card.h * .8));
        if (mode === 'gone') { boat.alpha = clamp(1 - (t - modeAt) * 2); boat.tx = boat.x; }
        // sillage : dans la carte quand le bateau est dessus, autour sinon
        const inside = boat.x > card.x && boat.x < card.x + card.w && boat.y > card.y && boat.y < card.y + card.h;
        if (speed > card.h * .6 && Math.random() < .9) churn(boat.x, boat.y, boat.ang, speed, inside);
        else if (Math.random() < .12 + .5 * build) churn(boat.x, boat.y, boat.ang, card.h * (.2 + 1.5 * build), inside);
        foam.step(dt); foamOut.step(dt);
        foam.each((f, k) => dot(ci, '#f0fdff', f.x - card.x, f.y - card.y, f.size * (2.4 + k * 3), (1 - k) * .4));
        ci.globalAlpha = 1;
        behind(env, () => foamOut.each((f, k) => dot(co, dark ? '#bae6fd' : '#0ea5e9', f.x, f.y, f.size * (2.4 + k * 3), (1 - k) * (dark ? .4 : .45))), true);
        // le jet de la baleine (Mythic), derrière la carte
        spouts.run(dt, (s, k) => {
          const up = k < .3 ? outCubic(k / .3) : 1, a = clamp((1 - k) * 3);
          behind(env, () => {
            co.globalAlpha = a * .9; co.fillStyle = '#1e3a5f';
            co.beginPath(); co.ellipse(s.x, card.y + 3, card.h * .55, card.h * .16, 0, Math.PI, 0); co.fill();
            co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
            for (let i = 0; i < 14; i++) { const u = i / 13, hh = card.h * 1.5 * up; dot(co, dark ? '#e0f2fe' : '#7dd3fc', s.x + Math.sin(u * 9 + t * 6) * 3 * u + (u > .7 ? (i % 2 ? 1 : -1) * (u - .7) * card.h * 1.2 : 0), card.y - u * hh, card.h * (.08 + .1 * u), a * .55); }
            co.globalCompositeOperation = 'source-over';
          }, true);
          if (k > .25 && Math.random() < .5) drops.add({ x: s.x + rnd(-.4, .4) * card.h, y: card.y - card.h * 1.4, vx: rnd(-40, 40), vy: rnd(-30, 10), g: 300, drag: .3, max: rnd(.6, 1), size: rnd(1.2, 2.2) });
        });
        // les dauphins : un arc de chaque côté de la carte
        dolphins.run(dt, (d, k) => {
          const x = d.x + d.dir * (k - .5) * card.h * 1.1, y = card.y + card.h * .75 - Math.sin(k * Math.PI) * card.h * 1.1, ang = Math.atan2(-Math.cos(k * Math.PI) * Math.PI * card.h * 1.1, d.dir * card.h * 1.1);
          if (!d.splash && k > .05) { d.splash = true; for (let i = 6; i > 0; i--) drops.add({ x, y: card.y + card.h * .75, vx: rnd(-50, 50), vy: -rnd(50, 140), g: 500, drag: .3, max: .6, size: rnd(1.2, 2) }); }
          co.save(); co.globalAlpha = clamp((1 - k) * 6); co.translate(x, y); co.rotate(ang); if (d.dir < 0) co.scale(1, -1);
          const s = card.h * .62;
          co.fillStyle = '#6b9ac4'; co.strokeStyle = '#1e3a5f'; co.lineWidth = 1.2;
          co.beginPath(); co.moveTo(s * .55, 0); co.quadraticCurveTo(s * .2, -s * .22, -s * .4, -s * .05); co.lineTo(-s * .58, -s * .16); co.lineTo(-s * .52, 0); co.lineTo(-s * .58, s * .16); co.lineTo(-s * .4, s * .05); co.quadraticCurveTo(s * .2, s * .18, s * .55, 0); co.closePath(); co.fill(); co.stroke();
          co.beginPath(); co.moveTo(0, -s * .14); co.lineTo(-s * .12, -s * .3); co.lineTo(-s * .16, -s * .1); co.fill(); co.stroke();
          co.fillStyle = '#e0f2fe'; co.beginPath(); co.ellipse(s * .12, s * .07, s * .3, s * .06, 0, 0, TAU); co.fill(); co.strokeStyle = '#1e3a5f'; co.beginPath(); co.arc(s * .44, s * .02, s * .07, .2, 1.4); co.stroke(); // ventre clair et sourire : un dauphin, pas un requin
          co.fillStyle = '#0f172a'; co.beginPath(); co.arc(s * .32, -s * .04, s * .03, 0, TAU); co.fill();
          co.restore();
        });
        drops.step(dt);
        co.fillStyle = dark ? '#e0f2fe' : '#0284c7';
        drops.each((d, k) => { co.globalAlpha = 1 - k; co.beginPath(); co.arc(d.x, d.y, d.size, 0, TAU); co.fill(); });
        // fumée (moteur qui cale) et anneaux de sirène
        smoke.step(dt);
        smoke.each((s, k) => dot(co, dark ? '#475569' : '#1f2937', s.x, s.y, s.size * (1 + 2 * k), (1 - k) * .7));
        rings.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? '#f8fafc' : '#64748b'; co.lineWidth = 1.5; co.beginPath(); co.arc(r.x, r.y - k * card.h * .3, card.h * (.06 + .2 * k), 0, TAU); co.stroke(); });
        // le bateau, par-dessus : un rond d'eau sous lui quand il est hors de la carte
        if (boat.alpha > 0) {
          if (!inside) { co.globalAlpha = boat.alpha * (dark ? .5 : .35); co.fillStyle = '#0e7490'; co.beginPath(); co.ellipse(boat.x, boat.y, L * .75, L * .4, boat.ang, 0, TAU); co.fill(); }
          draw(boat.x, boat.y, boat.ang, boat.alpha);
        }
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) build = 0; },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; modeAt = t;
        const fx = () => boat.x - Math.cos(boat.ang) * L * .3;
        if (!p) { mode = 'stall'; for (let i = 0; i < 6; i++) smoke.add({ x: fx(), y: boat.y, vx: rnd(-15, 15), vy: -rnd(20, 50), drag: 1, g: -10, max: rnd(1, 1.6), size: card.h * rnd(.06, .1), delay: 0 }); return; }
        for (let i = 0; i < 2; i++) rings.add({ delay: i * .3, life: .7, x: fx(), y: boat.y });
        if (p >= .6) [-1, 1].forEach((dir, i) => dolphins.add({ delay: .3 + i * .35, life: .9, x: dir < 0 ? card.x - card.h * .55 : card.x + card.w + card.h * .55, dir: -dir }));
        if (p >= 1) {
          // demi-tour : il passe au-dessus de la carte de droite à gauche en grand arc, puis ressort à gauche
          const P = [[boat.x, boat.y], [boat.x + card.h * 1.3, boat.y - card.h * 1.5], [cx + card.w * .2, card.y - card.h * .8], [card.x - card.h * 1.8, card.y - card.h * .55]];
          const bez = k => [0, 1].map(j => { const u = 1 - k; return u * u * u * P[0][j] + 3 * u * u * k * P[1][j] + 3 * u * k * k * P[2][j] + k * k * k * P[3][j]; });
          boat.path = { k: 0, d: 2.4, at: k => bez(outCubic(k * .85 + .15 * k * k) * .98 + .02 * k) };
          mode = 'path';
          spouts.add({ delay: .8, life: 2.2 + .5 * asc, x: cx + card.w * .25 });
        } else { mode = 'leave'; boat.tx = card.x + card.w + card.h * 3; }
      },
    };
  };

  // 📜 Torn Paper (2026-10-27, idée de 17black) — à chaque chiffre posé, le kraft arraché de sa fenêtre s'envole en
  // lambeaux (bords blancs fibreux, ils tournent et retombent), avec quelques fibres ; le dernier part en gros morceaux.
  // Avant le dernier chiffre, le papier frémit : de petits copeaux de kraft voltigent. Révélation : tirage raté, un seul
  // lambeau descend en se balançant comme une feuille ; sinon des confettis de papier ; dès Epic, des lambeaux jaillissent
  // tout autour ; dès Mythic, l'emballage entier de la carte éclate en grands morceaux de kraft et une pluie de confettis
  // de papier de couleur tombe en tournoyant.
  SCENES.tornpaper = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const scraps = particles(), bits = particles(), confetti = particles(), leaves = particles();
    const KRAFT = ['#d4ad74', '#c49a5f', '#b5874d', '#caa067'];
    let t = 0, build = 0;
    // un lambeau : un polygone irrégulier, bord blanc fibreux dessiné au trait
    const shape = r => { const n = 6 + ((Math.random() * 4) | 0), pts = []; for (let i = 0; i < n; i++) { const a = (i / n) * TAU + rnd(-.25, .25), rr = r * rnd(.55, 1); pts.push([Math.cos(a) * rr, Math.sin(a) * rr * rnd(.6, 1)]); } return pts; };
    const scrap = (list, x, y, vx, vy, r, extra = {}) => list.add({ x, y, vx, vy, g: 520, drag: 1.1, max: rnd(.9, 1.6), pts: shape(r), r, rot: rnd(TAU), spin: rnd(-9, 9), flip: rnd(6, 12), c: pick(KRAFT), ...extra });
    const drawScrap = (s, k) => {
      co.save(); co.globalAlpha = Math.min(1, (1 - k) * 4); co.translate(s.x, s.y); co.rotate(s.rot + s.life * s.spin); co.scale(1, Math.max(.15, Math.abs(Math.cos(s.life * s.flip))));
      co.beginPath(); s.pts.forEach(([x, y], i) => (i ? co.lineTo(x, y) : co.moveTo(x, y))); co.closePath();
      co.fillStyle = s.c; co.fill(); co.lineJoin = 'round'; co.lineWidth = Math.max(1.2, s.r * .16); co.strokeStyle = '#fbf7ec'; co.stroke();
      co.lineWidth = .8; co.strokeStyle = 'rgba(110,66,26,.5)'; co.stroke();
      co.restore();
    };
    return {
      frame(tt, dt) {
        t = tt;
        if (build && Math.random() < dt * 14 * q) bits.add({ x: cx + rnd(-.5, .5) * card.w, y: card.y + rnd(0, 1) * card.h, vx: rnd(-20, 20), vy: -rnd(20, 60), g: 120, drag: 1, max: rnd(.4, .8), size: rnd(1, 2), c: pick(KRAFT) });
        scraps.step(dt); bits.step(dt); confetti.step(dt); leaves.step(dt);
        scraps.each(drawScrap);
        leaves.each((s, k) => { s.vx = Math.sin(s.life * 3) * card.h * .9; s.vy = card.h * .35; drawScrap(s, k); });
        bits.each((b, k) => { co.globalAlpha = 1 - k; co.fillStyle = b.c; co.fillRect(b.x, b.y, b.size * 2, b.size * .6); });
        confetti.each((c, k) => { co.save(); co.globalAlpha = Math.min(1, (1 - k) * 4); co.translate(c.x + Math.sin(t * 3 + c.ph) * 6, c.y); co.rotate(c.rot + c.life * c.spin); co.scale(Math.cos(c.life * c.flip), 1); co.fillStyle = c.c; co.fillRect(-c.size, -c.size * .35, c.size * 2, c.size * .7); co.restore(); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const f = o.last ? 1.5 : 1, n = o.ghost ? 1 : o.last ? 6 : 4;
        // le papier part vers le haut et la droite, depuis le coin haut droit de la fenêtre
        for (let i = 0; i < n; i++) scrap(scraps, p.x + card.h * .15, p.y - card.h * .2, rnd(30, 140) * f, -rnd(160, 300) * f, card.h * rnd(.09, .16) * (o.last ? 1.25 : 1));
        for (let i = Math.round((o.ghost ? 2 : 6) * q); i > 0; i--) bits.add({ x: p.x + rnd(-6, 6), y: p.y - card.h * .2, vx: rnd(-60, 100), vy: -rnd(60, 200), g: 400, drag: 1, max: rnd(.4, .8), size: rnd(1, 2), c: Math.random() < .5 ? '#fbf7ec' : pick(KRAFT) });
        if (o.last) build = 0;
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { scrap(leaves, cx + card.w * .3, card.y - card.h * .1, 0, 0, card.h * .1, { g: 0, drag: 0, max: 2.4, spin: 1.5, flip: 3 }); return; }
        const COLS = ['#facc15', '#f472b6', '#22d3ee', '#fbf7ec', '#a3e635', '#fb923c'];
        for (let i = burst(p, 70 * q, 8) + 30 * asc; i > 0; i--) confetti.add({ x: cx + rnd(-.7, .7) * card.w, y: card.y - card.h * rnd(.2, 1.4), vx: rnd(-20, 20), vy: rnd(20, 70), g: 30, drag: 1.2, max: rnd(1.6, 2.8), size: rnd(2.5, 4.5), rot: rnd(TAU), spin: rnd(-4, 4), flip: rnd(6, 12), ph: rnd(TAU), c: pick(COLS) });
        if (p >= .6) for (let i = Math.round((6 + 10 * p) * q); i > 0; i--) { const a = rnd(TAU); scrap(scraps, cx + Math.cos(a) * card.w * .45, cy + Math.sin(a) * card.h * .45, Math.cos(a) * rnd(120, 260), Math.sin(a) * rnd(120, 260) - 120, card.h * rnd(.08, .14)); }
        if (p >= 1) {
          // l'emballage de la carte : de grands morceaux de kraft partent des quatre côtés
          for (let i = Math.round((10 + 4 * asc) * q); i > 0; i--) {
            const side = i % 4, u = Math.random();
            const x = side === 0 ? card.x + u * card.w : side === 1 ? card.x + card.w : side === 2 ? card.x + u * card.w : card.x, y = side === 0 ? card.y : side === 1 ? card.y + u * card.h : side === 2 ? card.y + card.h : card.y + u * card.h;
            const a = Math.atan2(y - cy, (x - cx) * .6);
            scrap(scraps, x, y, Math.cos(a) * rnd(160, 320), Math.sin(a) * rnd(160, 320) - 100, card.h * rnd(.18, .3), { max: rnd(1.4, 2), drag: 1.6 });
          }
        }
      },
    };
  };

  // 🏃 Stickman (2026-10-27, idée de Jguz01 ; sur Discord, un bonhomme qui écrit les chiffres) — un bonhomme en bâtons,
  // dessiné au feutre comme dans un coin de cahier (pose changée 12 fois par seconde, trait qui « bout »), attend devant
  // le prochain chiffre en trottinant sur place, accroupi (l'élan) ; quand le chiffre se pose, il fonce jusqu'au suivant
  // avec des traits de vitesse, et le chiffre s'écrit derrière lui (animation CSS stk-write), puis il dérape. Avant le
  // dernier chiffre il s'accroupit plus bas. Révélation : tirage raté, il trébuche et s'étale (étoiles qui tournent) ;
  // sinon il lève le poing ; dès Epic, il saute bras en l'air et des étoiles au feutre surgissent ; dès Mythic, un salto,
  // une couronne gribouillée sur le nombre ; dès Celestial, deux copains accourent pour danser avec lui.
  SCENES.stickman = env => {
    const { co, card, q, dark } = env;
    const INK = '#111827', HALO = dark ? 'rgba(248,250,252,.92)' : 'rgba(255,255,255,.75)', HL = '#fde047';
    const s = card.h * .68, feet = () => card.y + card.h - card.h * .07;
    const dust = particles(), stars = timed(), crowns = timed(), lines = [];
    const man = { x: card.x - s * 1.4, tx: card.x - s * 1.4, v: 0, ph: 0, crouch: .25, lean: 0, air: 0, vy: 0, flip: 0, fall: 0, arms: 0, run: true, amp: 1 };
    const G = card.h * 22, jump = hmax => Math.sqrt(2 * G * hmax); // sauts à l'échelle de la carte
    const pals = []; // les copains (Celestial et plus)
    let t = 0, build = 0, mode = 'run', modeAt = 0, seed = 1, armsFor = 2;
    const jit = k => (Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453 % 1) * s * .018; // le trait qui bout (même tremblé pour une pose)
    // Un bonhomme : pieds en (x, y), échelle sc. m.run : il court (m.amp : ampleur de la foulée), m.ph : phase de course,
    // m.arms : 1 un poing levé, 2 les deux bras en V ; m.air : hauteur du saut ; m.flip : salto ; m.fall : à plat ventre.
    const draw = (m, x, y, sc) => {
      const S2 = s * sc, lw = Math.max(2, S2 * .075);
      co.save(); co.translate(x, y - m.air);
      if (m.flip) { co.translate(0, -S2 * .5); co.rotate(m.flip); co.translate(0, S2 * .5); }
      if (m.fall) co.rotate(m.fall * Math.PI / 2);
      const cr = m.crouch, ph = Math.floor(m.ph / (TAU / 8)) * (TAU / 8); // 8 poses par foulée : le folioscope
      const hip = [jit(1), -S2 * (.46 - .12 * cr)], neck = [hip[0] + Math.sin(m.lean) * S2 * .36 + jit(2), hip[1] - Math.cos(m.lean) * S2 * .36];
      const head = [neck[0] + Math.sin(m.lean) * S2 * .13, neck[1] - S2 * .13];
      const seg = (from, th, len) => [from[0] + Math.sin(th) * S2 * len, from[1] + Math.cos(th) * S2 * len];
      const leg = a => {
        let th, kb;
        if (m.air > 2) { th = a ? .95 : .35; kb = 1.7; } // jambes repliées en l'air
        else if (m.run) { th = Math.sin(ph + a) * .9 * m.amp; kb = (.4 + Math.max(0, Math.sin(ph + a + 1.4)) * 1.2) * m.amp; }
        else { th = a ? .32 : -.32; kb = cr * .8; } // debout, jambes en A
        const knee = seg(hip, th, .24); return [hip, knee, seg(knee, th - kb, .22 + jit(a * 3) / S2)];
      };
      const sho = [neck[0] + (hip[0] - neck[0]) * .18, neck[1] + (hip[1] - neck[1]) * .18];
      const arm = a => {
        const up = m.arms === 2 || (m.arms === 1 && !a);
        if (up) { const th = Math.PI + (a ? -.5 : .5) + jit(a + 7) / S2; const el = seg(sho, th, .17); return [sho, el, seg(el, th, .16)]; }
        if (m.run) { const th = -Math.sin(ph + (a ? Math.PI : 0)) * 1.1 * m.amp; const el = seg(sho, th, .17); return [sho, el, seg(el, th - 1.3, .15)]; }
        const th = a ? .42 : -.42; const el = seg(sho, th, .17); return [sho, el, seg(el, th * .7, .16)];
      };
      const parts = [leg(0), leg(Math.PI), [neck, hip], arm(0), arm(1)];
      co.lineCap = 'round'; co.lineJoin = 'round';
      for (const [col, wd] of [[HALO, lw + 3.2], [INK, lw]]) {
        co.strokeStyle = col; co.lineWidth = wd;
        for (const pts of parts) { co.beginPath(); pts.forEach(([px, py], i) => (i ? co.lineTo(px, py) : co.moveTo(px, py))); co.stroke(); }
        co.beginPath(); co.arc(head[0], head[1], S2 * .12, 0, TAU); co.stroke();
      }
      co.fillStyle = '#fffef9'; co.beginPath(); co.arc(head[0], head[1], S2 * .12 - lw / 2, 0, TAU); co.fill();
      co.restore();
    };
    const doodleStar = (x, y, r, rot, a) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      co.beginPath(); for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * .45 : r, an = -Math.PI / 2 + i * Math.PI / 5; co.lineTo(Math.cos(an) * rr + jit(i), Math.sin(an) * rr); } co.closePath();
      co.fillStyle = HL; co.fill(); co.lineJoin = 'round'; co.strokeStyle = HALO; co.lineWidth = Math.max(2, r * .16) + 3; co.stroke(); co.strokeStyle = INK; co.lineWidth = Math.max(2, r * .16); co.stroke(); co.restore();
    };
    const puff = (x, y, n, dir) => { for (let i = Math.round(n * q); i > 0; i--) dust.add({ x: x + rnd(-4, 4), y: y - rnd(0, 3), vx: dir * rnd(10, 70), vy: -rnd(5, 40), drag: 3, max: rnd(.3, .6), size: rnd(2, 4) }); };
    return {
      frame(tt, dt) {
        t = tt;
        if (Math.floor(t * 12) !== Math.floor((t - dt) * 12)) seed = (seed * 9301 + 49297) % 233280; // 12 dessins par seconde
        const S = slotsA(env).filter(x => !x.gone), next = S.find(x => !x.on);
        // où il va : devant le prochain chiffre (légèrement à droite pour ne pas cacher celui d'avant), sinon hors de la carte
        if (mode === 'run') man.tx = next ? next.x + s * .12 : card.x + card.w + s * .75;
        const d = man.tx - man.x, wasV = man.v;
        man.v = Math.abs(d) < .5 ? 0 : Math.sign(d) * Math.min(Math.abs(d) * 16, Math.max(s * 1.2, Math.abs(d) * 9));
        man.x += man.v * dt;
        if (Math.abs(wasV) > s * 3 && Math.abs(man.v) < s * 1.5) { puff(man.x + s * .1, feet(), 5, -1); man.lean = -.35; } // dérapage
        const fast = Math.abs(man.v) > s * 2;
        if (fast) { man.ph += Math.abs(man.v) * dt / (s * .22); man.amp = 1; man.lean += (.45 - man.lean) * Math.min(1, dt * 14); if (Math.random() < .4) lines.push({ x: man.x - s * .3, y: feet() - s * rnd(.25, .75), len: s * rnd(.5, 1.1), t }); }
        else if (mode === 'run') { man.ph += dt * (9 + 14 * build); man.amp = .45 + .2 * build; man.lean += ((.12 + .1 * build) - man.lean) * Math.min(1, dt * 8); }
        else man.lean += (0 - man.lean) * Math.min(1, dt * 8);
        man.run = fast || (mode === 'run' && !!next) || mode === 'trip';
        if (mode === 'party' && t - modeAt > armsFor) man.arms = 0; // il baisse les bras après la fête
        man.crouch += ((mode === 'run' ? (Math.abs(man.v) > s * 2 ? .15 : .35 + .45 * build) : 0) - man.crouch) * Math.min(1, dt * 10);
        // célébrations
        man.vy -= G * dt; man.air = Math.max(0, man.air + man.vy * dt); if (man.air === 0 && man.vy < 0) { if (man.flip) { man.flip = 0; puff(man.x, feet(), 8, 1); puff(man.x, feet(), 8, -1); } man.vy = 0; }
        if (man.flipping && man.air > 0) man.flip = Math.min(TAU, man.flip + dt * TAU / man.flipT); else if (man.flipping) man.flipping = false;
        if (mode === 'trip') { const k = t - modeAt; if (k < .25) man.ph += dt * 10; else man.run = false; if (k > .25) { man.fall = Math.min(1, man.fall + dt * 6); if (man.fall === 1 && !man.landed) { man.landed = true; puff(man.x + s * .4, feet(), 10, 1); } } }
        // traits de vitesse
        co.lineCap = 'round';
        for (let i = lines.length - 1; i >= 0; i--) { const L = lines[i], k = (t - L.t) / .25; if (k >= 1) { lines.splice(i, 1); continue; } co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? '#e5e7eb' : INK; co.lineWidth = Math.max(1.2, s * .03); co.beginPath(); co.moveTo(L.x - L.len * k * .3, L.y); co.lineTo(L.x - L.len, L.y); co.stroke(); }
        co.globalAlpha = 1;
        dust.step(dt);
        dust.each((p, k) => { co.globalAlpha = (1 - k) * .7; co.strokeStyle = dark ? '#cbd5e1' : '#57534e'; co.lineWidth = 1.2; co.beginPath(); co.arc(p.x, p.y, p.size * (1 + k), 0, TAU); co.stroke(); });
        crowns.run(dt, (c, k) => {
          const e = outBack(clamp(k * 5)), a = clamp((1 - k) * 5), x = card.x + card.w / 2, y = card.y - 2, wdt = card.h * .62 * e, ht = card.h * .42 * e;
          co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(Math.sin(t * 6) * .05);
          co.beginPath(); co.moveTo(-wdt / 2, 0); co.lineTo(-wdt / 2 + jit(1), -ht); co.lineTo(-wdt / 4, -ht * .45); co.lineTo(jit(2), -ht * 1.1); co.lineTo(wdt / 4, -ht * .45); co.lineTo(wdt / 2, -ht + jit(3)); co.lineTo(wdt / 2, 0); co.closePath();
          co.fillStyle = HL; co.fill(); co.lineJoin = 'round'; co.strokeStyle = HALO; co.lineWidth = Math.max(2, card.h * .04) + 3; co.stroke(); co.strokeStyle = INK; co.lineWidth = Math.max(2, card.h * .04); co.stroke();
          co.restore();
        });
        stars.run(dt, (c, k) => doodleStar(c.x, c.y + Math.sin(t * 4 + c.x) * 2, card.h * c.r * outBack(clamp(k * 6)), c.rot + Math.sin(t * 5 + c.x) * .15, clamp((1 - k) * 5)));
        // étoiles qui tournent au-dessus de sa tête (tirage raté)
        if (mode === 'trip' && man.landed && t - modeAt < 2.6) for (let i = 0; i < 3; i++) { const an = t * 5 + i * TAU / 3; doodleStar(man.x + s * .62 + Math.cos(an) * s * .22, feet() - s * .2 + Math.sin(an) * s * .08, s * .09, an, clamp((2.6 - (t - modeAt)) * 2)); }
        pals.forEach((pl, i) => { pl.x += (pl.tx - pl.x) * Math.min(1, dt * 5); pl.ph += dt * 14; if (Math.abs(pl.tx - pl.x) < 3) { pl.run = false; pl.arms = 2; pl.air = Math.abs(Math.sin(t * 7 + i * 1.3)) * s * .22; } draw(pl, pl.x, feet(), .85); });
        draw(man, man.x, feet(), 1);
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) build = 0; },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; modeAt = t;
        // il est déjà sorti à droite de la carte : il réagit là
        if (!p) { mode = 'trip'; man.tx = man.x; return; }
        mode = 'party'; man.arms = p >= .6 ? 2 : 1; man.v = 0; armsFor = 1.6 + 1.6 * p + asc;
        man.vy = jump(card.h * (p >= .6 ? .35 : .18));
        if (p >= 1) { man.flipping = true; man.vy = jump(card.h * .75); man.flipT = 2 * man.vy / G * .9; crowns.add({ delay: .3, life: 3.4 + asc * .6 }); }
        if (p >= .6) {
          const n = 3 + Math.round(4 * p) + 2 * asc, spots = [];
          for (let i = 0; i < n; i++) { const side = i % 2 ? 1 : -1; spots.push(side < 0 ? { x: card.x - card.h * rnd(.25, .9), y: card.y + card.h * rnd(-.6, .9) } : { x: card.x + card.w * rnd(.55, 1) + card.h * rnd(0, .8), y: card.y - card.h * rnd(.25, .8) }); } // à droite : au-dessus de lui
          spots.forEach((c, i) => stars.add({ delay: .15 + i * .09, life: 2.4 + p, x: c.x, y: c.y, r: rnd(.13, .22), rot: rnd(-.4, .4) }));
        }
        if (asc >= 1) for (let i = 0; i < 2; i++) pals.push({ x: card.x - s * (2 + i), tx: card.x - s * (.55 + i * .6), ph: i, crouch: 0, lean: .2, air: 0, flip: 0, fall: 0, arms: 0, run: true, amp: 1 });
      },
    };
  };
  // ==== fin du lot A ====

  // ==== Skins du 2026-10-27, lot B ====
  // Baseball, Race Car, Domino, Lily Pads, Ripple, Bullet Train, Orbital Cannon : idées de joueurs acceptées par Sacha.
  // Texte épais cerné (annonces des scènes du lot : HOME RUN!, DNF, DOMINO!…). font : police canvas, SIZE remplacé.
  const bWord = (c, s, x, y, size, fill, stroke, a, rot = 0, font = "900 SIZEpx 'Arial Black', Impact, system-ui, sans-serif") => {
    if (a <= .01 || size < 2) return;
    c.save(); c.globalAlpha = Math.min(1, a); c.translate(x, y); c.rotate(rot);
    c.font = font.replace('SIZE', Math.round(size)); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.lineWidth = Math.max(2, size * .2); c.strokeStyle = stroke; c.strokeText(s, 0, 0);
    c.fillStyle = fill; c.fillText(s, 0, 0); c.restore();
  };
  // La case (span.slot) qui se trouve au point p du calque extérieur : la plus proche en x (lock ne donne qu'un point).
  const bSlotAt = (env, p) => {
    const cr = env.el.getBoundingClientRect(), k = env.card.w / (cr.width || env.card.w);
    let best = null, d = Infinity;
    for (const s of env.el.querySelectorAll('.slot')) { const r = s.getBoundingClientRect(), dd = Math.abs(env.card.x + (r.left + r.width / 2 - cr.left) * k - p.x); if (dd < d) { d = dd; best = s; } }
    return best;
  };
  // Point du calque intérieur (dans la carte, derrière les chiffres) qui correspond au point p du calque extérieur.
  const bInner = (env, p) => { const b = (env.card.w - env.w) / 2; return { x: p.x - env.card.x - b, y: p.y - env.card.y - b }; };

  // ⚾ Baseball (2026-10-27, idée de Kj13 ; finnnnn l'avait proposé aussi) — à chaque chiffre, une balle est lancée depuis
  // la gauche et vient claquer sur lui (« each ball is thrown to the number », finnnnn) ; un 0 devient une balle de
  // baseball et un 1 une batte debout (Kj13). Avant le dernier chiffre une batte se met en garde à droite de la carte ;
  // à la révélation elle frappe : BASE HIT, DOUBLE!, TRIPLE!, et dès Mythic un HOME RUN! (la balle file au loin, feu
  // d'artifice et flashs du stade) ; tirage raté : elle rate la balle, STRIKE!.
  SCENES.baseball = env => {
    const { co, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2;
    const pitches = timed(), pops = timed(), swings = timed(), words = timed(), shells = timed(), bulbs = timed(), dust = particles(), sparks = particles();
    const RED = '#dc2626', NAVY = '#1e3a8a', BURST = ['#f8fafc', '#ef4444', '#3b82f6', '#facc15'];
    const P = { x: card.x + card.w + H * .55, y: card.y + H * .25 }, LEN = H * 1.15; // les mains du batteur (hors champ), la batte
    let bat = 0, batTo = 0, batAng = -.85, swing = null, now = 0;
    const ball = (x, y, r, rot, a) => { // cuir blanc ombré, deux coutures rouges
      if (a <= .01) return;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      const g = co.createRadialGradient(-r * .35, -r * .35, r * .1, 0, 0, r); g.addColorStop(0, '#ffffff'); g.addColorStop(.7, '#f1ede4'); g.addColorStop(1, '#bdb5a3');
      co.fillStyle = g; co.beginPath(); co.arc(0, 0, r, 0, TAU); co.fill();
      co.strokeStyle = RED; co.lineWidth = Math.max(1, r * .14); co.lineCap = 'round';
      co.beginPath(); co.arc(-r * 1.3, 0, r * .9, -.72, .72); co.stroke(); co.beginPath(); co.arc(r * 1.3, 0, r * .9, Math.PI - .72, Math.PI + .72); co.stroke();
      co.strokeStyle = 'rgba(30,41,59,.55)'; co.lineWidth = Math.max(.7, r * .08); co.beginPath(); co.arc(0, 0, r, 0, TAU); co.stroke();
      co.restore();
    };
    const drawBat = (ang, a) => { // une batte en frêne : poignée gainée, pommeau, tonneau large (axe +x depuis les mains)
      if (a <= .01) return;
      co.save(); co.globalAlpha = a; co.translate(P.x, P.y); co.rotate(ang);
      const L = LEN, wd = L * .075, g = co.createLinearGradient(0, -wd, 0, wd);
      g.addColorStop(0, '#f6e0b0'); g.addColorStop(.45, '#d6a461'); g.addColorStop(1, '#8a5a2b');
      co.fillStyle = g; co.strokeStyle = '#4a2c12'; co.lineWidth = Math.max(1, L * .018); co.lineJoin = 'round';
      co.beginPath(); co.moveTo(-L * .04, -wd * .5); co.lineTo(L * .4, -wd * .45); co.quadraticCurveTo(L * .6, -wd * .55, L * .72, -wd); co.lineTo(L * .95, -wd); co.quadraticCurveTo(L * 1.01, 0, L * .95, wd); co.lineTo(L * .72, wd); co.quadraticCurveTo(L * .6, wd * .55, L * .4, wd * .45); co.lineTo(-L * .04, wd * .5); co.closePath(); co.fill(); co.stroke();
      co.fillStyle = '#1f2937'; co.fillRect(0, -wd * .5, L * .22, wd);
      co.fillStyle = '#4a2c12'; co.beginPath(); co.ellipse(-L * .05, 0, L * .03, wd * .85, 0, 0, TAU); co.fill();
      co.globalAlpha = a * .5; co.fillStyle = '#ffffff'; co.fillRect(L * .5, -wd * .7, L * .4, wd * .22); // reflet du vernis
      co.restore();
    };
    const puff = (x, y, n, big) => { for (let i = Math.round(n * q); i > 0; i--) { const an = -Math.PI / 2 + rnd(-1.3, 1.3); dust.add({ x: x + rnd(-6, 6), y, vx: Math.cos(an) * rnd(30, 90 + 80 * big), vy: Math.sin(an) * rnd(20, 70), drag: 2.2, g: 40, max: rnd(.5, .9), size: H * rnd(.05, .09 + .05 * big) }); } };
    const tip = ang => ({ x: P.x + Math.cos(ang) * LEN * .82, y: P.y + Math.sin(ang) * LEN * .82 });
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
        dust.step(dt); sparks.step(dt);
        behind(env, () => dust.each((d, k) => dot(co, dark ? '#d6c4a0' : '#a8875a', d.x, d.y, d.size * (1 + k), (1 - k) * .55)));
        // la batte : elle se met en garde (petit balancement), puis le swing de la révélation
        bat += (batTo - bat) * Math.min(1, dt * 6);
        if (!swing) batAng = -.85 + Math.sin(t * 5) * .08 * bat;
        swings.run(dt, (s, k) => {
          const T = k * s.life;
          // la balle lancée vers la batte (0 à 0,34 s), puis frappée (ou ratée)
          const C = tip(-1.75), from = { x: card.x - H * 1.1, y: card.y - H * .55 };
          const sw = clamp((T - .26) / .12); batAng = lerp(-.85, -2.5, outCubic(sw)) + (T > .38 ? Math.sin((T - .38) * 9) * .1 * Math.exp(-(T - .38) * 4) : 0);
          if (T < .34) { const u = T / .34; ball(lerp(from.x, C.x, u), lerp(from.y, C.y, u) - Math.sin(u * Math.PI) * H * .25, H * .1, T * 30, 1); tail(co, '#ffffff', lerp(from.x, C.x, u - .25), lerp(from.y, C.y, u - .25), lerp(from.x, C.x, u), lerp(from.y, C.y, u) - Math.sin(u * Math.PI) * H * .25, H * .08, .35); return; }
          if (s.miss) { const u = (T - .34) / .5; if (u < 1) ball(C.x + u * H * 2, C.y + u * H * .4, H * .1, T * 30, 1 - u); return; }
          if (!s.hit) { s.hit = true; for (let i = Math.round((10 + 30 * s.p) * q); i > 0; i--) { const an = rnd(TAU), v = rnd(80, 200 + 260 * s.p); sparks.add({ x: C.x, y: C.y, vx: Math.cos(an) * v, vy: Math.sin(an) * v, drag: 2.4, g: 120, max: rnd(.3, .7), size: rnd(1.4, 2.6), c: pick(['#fde68a', '#ffffff', '#fbbf24']) }); } pops.add({ x: C.x, y: C.y, size: H * (.5 + .5 * s.p), life: .3 }); }
          // la balle frappée : plus loin et plus haut avec la rareté ; un HOME RUN file au loin et rapetisse
          const u = clamp((T - .34) / (.7 + .6 * s.p)), far = .5 + 1.6 * s.p;
          const bx = C.x - u * H * 2.2 * far * (s.p >= 1 ? -.35 : 1), by = C.y - Math.sin(u * Math.PI * (s.p >= 1 ? .5 : 1)) * H * (.6 + 1.6 * s.p) - (s.p >= 1 ? u * H * .6 : 0);
          if (u < 1) { ball(bx, by, H * .1 * (s.p >= 1 ? 1 - .8 * u : 1), T * 30, Math.min(1, (1 - u) * 4)); dot(co, '#ffffff', bx, by, H * .2, .25 * (1 - u)); }
        });
        drawBat(batAng, Math.min(bat, swing ? clamp((swing.until - t) / .3) : 1));
        if (swing && t > swing.until) { swing = null; batTo = 0; bat = 0; }
        // les lancers : de la gauche jusqu'au chiffre, qui claque en arrivant
        pitches.run(dt, (b, k) => {
          const x = lerp(b.x0, b.x, k), y = lerp(b.y0, b.y, k) - Math.sin(k * Math.PI) * H * .3, r = H * (b.big ? .13 : .1);
          tail(co, dark ? '#e2e8f0' : '#64748b', lerp(b.x0, b.x, k - .35), lerp(b.y0, b.y, k - .35) - Math.sin((k - .35) * Math.PI) * H * .3, x, y, r * 1.1, .4);
          ball(x, y, r, k * 14, 1);
          if (k > .92 && !b.done) { b.done = true; pops.add({ x: b.x, y: b.y, size: H * (b.big ? .55 : .35), life: .28 }); puff(b.x, card.y + H, b.big ? 9 : 4, b.big); }
        });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        pops.run(dt, (o, k) => { co.globalAlpha = (1 - k) * .9; co.strokeStyle = dark ? '#ffffff' : NAVY; co.lineWidth = 2.5 * (1 - k) + .5; co.beginPath(); co.arc(o.x, o.y, o.size * (.4 + outCubic(k)), 0, TAU); co.stroke(); });
        sparks.each((s, k) => dot(co, s.c, s.x, s.y, s.size * 2, 1 - k));
        // feu d'artifice du HOME RUN, flashs d'appareils photo dans les tribunes
        shells.run(dt, (s, k) => {
          if (k < .35) { const y = lerp(card.y + H, s.y, outCubic(k / .35)); tail(co, s.c, s.x, y + 14, s.x, y, 2, 1); return; }
          if (!s.done) { s.done = true; for (let i = Math.round(s.n * q); i > 0; i--) { const an = rnd(TAU), v = rnd(.6, 1) * s.r; sparks.add({ x: s.x, y: s.y, vx: Math.cos(an) * v, vy: Math.sin(an) * v, drag: 1.8, g: 60, max: rnd(.8, 1.4), size: rnd(1.4, 2.4), c: s.c }); } }
        });
        bulbs.run(dt, (b, k) => { const a = 1 - k; dot(co, '#ffffff', b.x, b.y, b.r * a, a); dot(co, '#ffffff', b.x, b.y, b.r * 2.4, a * .7, 1.2); dot(co, '#ffffff', b.x, b.y, 1.2, a * .7, b.r * 2.4); });
        co.globalCompositeOperation = 'source-over';
        words.run(dt, (w, k) => { const s = k < .15 ? outBack(k / .15) : 1; bWord(co, w.s, cx, card.y - H * .55 - k * 8, H * w.size * s, w.c, NAVY, k > .75 ? (1 - k) / .25 : 1, -.06); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        // un 0 devient une balle, un 1 une batte debout (pas les zéros de tête, qui restent discrets)
        const el = !o.ghost && bSlotAt(env, p), d = el && el.textContent;
        if (d === '0') el.classList.add('bsb-ball'); else if (d === '1') el.classList.add('bsb-bat');
        if (o.ghost) return;
        pitches.add({ x0: card.x - H * 1.2, y0: card.y - H * .45 + rnd(-.1, .1) * H, x: p.x, y: p.y, big: o.last ? 1 : 0, life: .13 });
      },
      build() { batTo = 1; puff(P.x, card.y + H, 5, 0); },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        batTo = 1; bat = Math.max(bat, .6);
        const life = 1.4 + p;
        swings.add({ life, p, miss: !p });
        swing = { until: now + life }; // la batte s'efface à la fin du swing
        if (!p) { words.add({ delay: .45, life: 1.5, s: 'STRIKE!', c: dark ? '#cbd5e1' : '#e2e8f0', size: .3 }); }
        else words.add({ delay: .4, life: 1.6 + p, s: p >= 1 ? 'HOME RUN!' : p >= .6 ? 'TRIPLE!' : p >= .3 ? 'DOUBLE!' : 'BASE HIT', c: p >= 1 ? '#fde047' : '#ffffff', size: .28 + .1 * p });
        if (p >= 1) {
          for (let i = 0; i < 4 + 3 * asc; i++) shells.add({ delay: .7 + i * .18, life: .9, x: cx + (i % 2 ? 1 : -1) * card.w * rnd(.4, .95), y: card.y - H * rnd(.4, 1.3), r: H * (2.6 + .4 * asc), n: 26 + 6 * asc, c: pick(BURST) });
          for (let i = 0; i < 14 + 6 * asc; i++) bulbs.add({ delay: .4 + rnd(0, 1.6), life: .16, x: cx + rnd(-1, 1) * (card.w * .5 + H * 1.6), y: card.y + rnd(-1.2, -.1) * H, r: rnd(2, 4) });
        }
      },
    };
  };

  // 🏎️ Race Car (2026-10-27, idée de whywhywaylon, demandée deux fois ; la dérive vient de logannn) — une monoplace rouge
  // (livrée inventée, aucune écurie) fait des donuts au-dessus de la carte, en dérive, pneus fumants et traces de gomme ;
  // à chaque chiffre elle plonge et tape de l'arrière le bord de la carte juste au-dessus de lui (étincelles) puis repart
  // (« it drifts around the numbers and hits them to reveal them », logannn). À la révélation : un tour d'honneur autour
  // de la carte, le drapeau à damier dès Epic, et dès Mythic des confettis à damier et VICTORY LAP! ; tirage raté : le
  // moteur casse, fumée noire et DNF.
  SCENES.racecar = env => {
    const { co, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, L = H * .74, R = H * .42, CY = card.y - R - H * .24;
    const smoke = particles(), sparks = particles(), checks = particles(), words = timed(), flags = timed(), marks = [];
    let px = card.x + card.w * .08, pxTo = px, theta = Math.PI * .9, heat = .4, heatTo = .4, dive = null, lap = null, dnf = null, now = 0, enter = 0;
    let car = { x: card.x - H * 2, y: CY, ang: 0 };
    const drawCar = (x, y, ang) => { // vue de dessus, nez vers +x
      co.save(); co.globalAlpha = 1; co.translate(x, y); co.rotate(ang);
      const W = L * .52;
      co.fillStyle = 'rgba(0,0,0,.28)'; co.beginPath(); co.ellipse(L * .02, W * .12, L * .55, W * .62, 0, 0, TAU); co.fill(); // ombre
      // quatre gros pneus, cerclés de gris pour rester visibles sur une page sombre
      co.strokeStyle = '#9ca3af'; co.lineWidth = Math.max(1, L * .025); co.fillStyle = '#18181b';
      for (const [u, v] of [[-.3, -.52], [-.3, .52], [.28, -.48], [.28, .48]]) { roundRect(co, L * u - L * .12, W * v - W * .17, L * .24, W * .34, L * .04); co.fill(); co.stroke(); }
      co.fillStyle = '#f8fafc'; co.fillRect(-L * .54, -W * .6, L * .1, W * 1.2); co.fillStyle = '#facc15'; co.fillRect(L * .42, -W * .56, L * .08, W * 1.12); // ailerons blanc et jaune
      const g = co.createLinearGradient(0, -W * .32, 0, W * .32); g.addColorStop(0, '#fca5a5'); g.addColorStop(.45, '#dc2626'); g.addColorStop(1, '#7f1d1d');
      co.fillStyle = g; co.beginPath(); co.moveTo(-L * .46, -W * .3); co.lineTo(L * .08, -W * .32); co.quadraticCurveTo(L * .44, -W * .14, L * .5, 0); co.quadraticCurveTo(L * .44, W * .14, L * .08, W * .32); co.lineTo(-L * .46, W * .3); co.closePath(); co.fill();
      co.fillStyle = '#facc15'; co.fillRect(L * .1, -W * .05, L * .34, W * .1); // la bande jaune du capot
      co.fillStyle = '#0f172a'; co.beginPath(); co.ellipse(-L * .08, 0, L * .12, W * .17, 0, 0, TAU); co.fill();
      co.fillStyle = '#f8fafc'; co.beginPath(); co.arc(-L * .08, 0, W * .1, 0, TAU); co.fill(); // le casque
      co.restore();
    };
    const puff = (x, y, n, black) => { for (let i = Math.round(n * q); i > 0; i--) smoke.add({ x: x + rnd(-3, 3), y: y + rnd(-3, 3), vx: rnd(-25, 25), vy: rnd(-30, 0), drag: 1.5, g: -10, max: rnd(.6, 1.2), size: H * rnd(.06, .12), black }); };
    const hitSparks = (x, y, n) => { for (let i = Math.round(n * q); i > 0; i--) { const an = -Math.PI / 2 + rnd(-1.4, 1.4); sparks.add({ x, y, vx: Math.cos(an) * rnd(80, 260), vy: Math.sin(an) * rnd(80, 220), drag: 2, g: 500, max: rnd(.25, .5), size: rnd(1.2, 2.2) }); } };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over'; co.lineCap = 'round';
        heat += (heatTo - heat) * Math.min(1, dt * 3);
        enter = Math.min(1, enter + dt * 2.2);
        px += (pxTo - px) * Math.min(1, dt * 9);
        let x, y, ang;
        if (dnf) { // moteur cassé : elle ralentit, tousse et s'arrête
          dnf.v *= Math.exp(-dt * 2.5); theta += dnf.v * dt;
          x = px + Math.cos(theta) * R * 1.3; y = CY + Math.sin(theta) * R; ang = theta + Math.PI / 2 + .3;
          if (Math.random() < .3) puff(x, y, 1, true);
        } else if (lap) { // tour d'honneur autour de la carte, en dérive dans les virages
          lap.t += dt; const k = clamp(lap.t / lap.life), s = lap.s0 + (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
          const b = grown(card, H * .4), a1 = along(b, s), a2 = along(b, s + .004);
          x = a1.x; y = a1.y; ang = Math.atan2(a2.y - a1.y, a2.x - a1.x) + .45;
          if (lap.t < .2) { const e = outCubic(lap.t / .2); x = lerp(lap.x, x, e); y = lerp(lap.y, y, e); }
          if (k >= 1) { lap = null; pxTo = px = cx; theta = Math.PI / 2 + .3; }
        } else { // donuts au-dessus de la case visée
          theta += (6 + 6 * heat) * dt;
          x = px + Math.cos(theta) * R * 1.3; y = CY + Math.sin(theta) * R; ang = theta + Math.PI / 2 + .55;
          if (dive) { // plongée : l'arrière vient taper le bord de la carte au-dessus du chiffre
            dive.t += dt; const k = dive.t / .42, d = k < .3 ? outCubic(k / .3) : 1 - outCubic((k - .3) / .7);
            const hx = dive.x, hy = card.y - L * .24, flat = Math.round(ang / Math.PI) * Math.PI;
            x = lerp(x, hx, d); y = lerp(y, hy, d); ang = lerp(ang, flat, d * .85);
            if (k >= .3 && !dive.hit) { dive.hit = true; hitSparks(hx, card.y, dive.big ? 22 : 12); puff(hx, card.y - 4, dive.big ? 8 : 4); }
            if (k >= 1) dive = null;
          }
          if (enter < 1) { const e = outCubic(enter); x = lerp(card.x - H * 2.2, x, e); y = lerp(CY, y, e); }
        }
        car = { x, y, ang };
        // gomme : deux traces des roues arrière, qui s'effacent
        const back = { x: x - Math.cos(ang) * L * .3, y: y - Math.sin(ang) * L * .3 }, side = { x: -Math.sin(ang) * L * .2, y: Math.cos(ang) * L * .2 };
        if (!dnf || dnf.v > .8) { marks.push({ ax: back.x + side.x, ay: back.y + side.y, bx: back.x - side.x, by: back.y - side.y, t }); if (Math.random() < .45 + heat * .4) puff(back.x, back.y, 1); }
        while (marks.length && t - marks[0].t > 1.4) marks.shift();
        smoke.step(dt); sparks.step(dt); checks.step(dt);
        behind(env, () => {
          co.lineWidth = Math.max(1.5, L * .08);
          co.strokeStyle = dark ? '#64748b' : '#1f2937';
          for (let i = 1; i < marks.length; i++) { const m = marks[i], n = marks[i - 1]; if (Math.hypot(m.ax - n.ax, m.ay - n.ay) > L * .6) continue; co.globalAlpha = (1 - (t - m.t) / 1.4) * (dark ? .45 : .3); co.beginPath(); co.moveTo(n.ax, n.ay); co.lineTo(m.ax, m.ay); co.moveTo(n.bx, n.by); co.lineTo(m.bx, m.by); co.stroke(); }
          smoke.each((m, k) => dot(co, m.black ? '#1f2937' : dark ? '#cbd5e1' : '#94a3b8', m.x, m.y, m.size * (1 + 2 * k), (1 - k) * (m.black ? .7 : dark ? .3 : .45)));
        });
        // le drapeau à damier, au bout de son mât, en haut à gauche de la carte (Epic et plus)
        flags.run(dt, (f, k) => {
          const a = k < .1 ? k / .1 : k > .85 ? (1 - k) / .15 : 1, fx = card.x - H * .2, fy = card.y - H * 1.25, fw = H * .8, fh = H * .5, n = 6, m = 4;
          co.globalAlpha = a; co.strokeStyle = dark ? '#e2e8f0' : '#334155'; co.lineWidth = 2.5; co.beginPath(); co.moveTo(fx, fy - 3); co.lineTo(fx - H * .3, card.y - H * .1); co.stroke();
          for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
            const u = i / n, wv = Math.sin(now * 10 - u * 5) * H * .07 * u;
            co.fillStyle = (i + j) % 2 ? '#0b0b0f' : '#f8fafc'; co.fillRect(fx + u * fw, fy + j * fh / m + wv, fw / n + .6, fh / m + .6);
          }
        });
        drawCar(x, y, ang);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.each((s, k) => { tail(co, '#f59e0b', s.x - s.vx * .03, s.y - s.vy * .03, s.x, s.y, s.size, 1 - k); dot(co, '#fde68a', s.x, s.y, s.size * 2, (1 - k) * .8); });
        co.globalCompositeOperation = 'source-over';
        checks.each((c, k) => { co.save(); co.translate(c.x, c.y); co.rotate(c.rot + k * c.spin); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = c.c; co.strokeStyle = '#64748b'; co.lineWidth = .6; co.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * .7); co.strokeRect(-c.size / 2, -c.size / 2, c.size, c.size * .7); co.restore(); });
        words.run(dt, (w, k) => { const s = k < .15 ? outBack(k / .15) : 1; bWord(co, w.s, cx + card.w * .2, card.y - H * .62, H * w.size * s, w.c, '#0b0b0f', k > .75 ? (1 - k) / .25 : 1, -.05, "italic 900 SIZEpx 'Arial Black', Impact, system-ui, sans-serif"); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        pxTo = p.x;
        if (o.ghost) return;
        dive = { t: 0, x: p.x, big: o.last ? 1 : 0 };
        heat = Math.min(1.3, heat + .12);
      },
      build() { heatTo = 1.3; puff(car.x, car.y, 8); },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        heatTo = .4; dive = null;
        if (!p) { dnf = { v: 6 }; puff(car.x, car.y, 14, true); words.add({ delay: .5, life: 1.6, s: 'DNF', c: '#e2e8f0', size: .36 }); return; }
        lap = { t: 0, life: 1.5 - .3 * p, s0: .06, x: car.x, y: car.y };
        if (p >= .6) flags.add({ delay: .2, life: 2.4 + p + asc });
        if (p >= 1) {
          words.add({ delay: 1, life: 2 + .5 * asc, s: 'VICTORY LAP!', c: '#facc15', size: .28 });
          for (let i = Math.round((50 + 30 * asc) * q); i > 0; i--) checks.add({ x: cx + rnd(-1, 1) * card.w * .7, y: card.y - H * rnd(1, 1.8), vx: rnd(-60, 60), vy: rnd(0, 60), g: 160, drag: 1.2, max: rnd(1.6, 2.6), size: H * rnd(.06, .1), rot: rnd(TAU), spin: rnd(-12, 12), c: Math.random() < .5 ? '#0b0b0f' : '#f8fafc' });
        } else if (p >= .6) words.add({ delay: 1, life: 1.8, s: 'FASTEST LAP', c: '#ffffff', size: .24 });
      },
    };
  };

  // 🁫 Domino (2026-10-27, idée de kaz) — un sac de velours tombe à gauche de la carte et s'écrase (matière molle), des
  // dominos en dégringolent ; à chaque chiffre, un domino saute du sac jusqu'à sa place, et ses points se retournent pour
  // dessiner le chiffre (le points-en-chiffre est en CSS, .skin-domino). À la révélation : une rangée de dominos debout
  // sur le haut de la carte tombe en cascade, plus longue avec la rareté ; DOMINO! dès Epic, et dès Mythic le sac éclate
  // en pluie de dominos ; tirage raté : un seul domino bascule, clac.
  SCENES.domino = env => {
    const { co, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2;
    const flying = timed(), tumble = particles(), dust = particles(), words = timed(), rows = timed();
    const PIPS = [[], [[0, 0]], [[-1, -1], [1, 1]], [[-1, -1], [0, 0], [1, 1]], [[-1, -1], [1, -1], [-1, 1], [1, 1]], [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]];
    const BX = card.x - H * .72, BASE = card.y + H * .98, BS = H * 1.05; // le sac : centre en x, sol, taille
    const bag = { y: card.y - H * 2.6, vy: 0, landed: 0, sq: 0, shake: 0, gone: 0 };
    let now = 0;
    const face = (s, top, bot) => { // un domino vu de face, centré, hauteur s
      const w = s * .5;
      roundRect(co, -w / 2, -s / 2, w, s, s * .09); co.fillStyle = '#111111'; co.fill(); co.strokeStyle = '#d6d3d1'; co.lineWidth = Math.max(1, s * .05); co.stroke();
      co.strokeStyle = '#57534e'; co.lineWidth = Math.max(.8, s * .03); co.beginPath(); co.moveTo(-w * .36, 0); co.lineTo(w * .36, 0); co.stroke();
      co.fillStyle = '#fafaf9';
      for (const [half, n] of [[-1, top], [1, bot]]) for (const [u, v] of PIPS[n]) { co.beginPath(); co.arc(u * w * .24, half * s * .25 + v * s * .12, Math.max(.8, s * .045), 0, TAU); co.fill(); }
    };
    const tile = (x, y, s, rot, a, top, bot) => { if (a <= .01) return; co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot); face(s, top, bot); co.restore(); };
    const drawBag = (x, yb, s, sx, sy, rot) => { // sac de velours bordeaux, cordon doré, ouverture froncée
      co.save(); co.translate(x, yb); co.rotate(rot); co.scale(sx, sy);
      const w = s * .5, h = s * .82;
      const g = co.createRadialGradient(-w * .35, -h * .55, s * .04, 0, -h * .35, s * .75); g.addColorStop(0, '#fb7185'); g.addColorStop(.45, '#be123c'); g.addColorStop(1, '#4c0519');
      co.fillStyle = g; co.beginPath(); co.moveTo(-w * .3, -h * .78); co.bezierCurveTo(-w * 1.2, -h * .62, -w * 1.15, 0, -w * .55, 0); co.lineTo(w * .55, 0); co.bezierCurveTo(w * 1.15, 0, w * 1.2, -h * .62, w * .3, -h * .78); co.closePath(); co.fill();
      co.strokeStyle = 'rgba(76,5,25,.55)'; co.lineWidth = Math.max(1, s * .02); // plis du velours
      for (const u of [-.45, .1, .5]) { co.beginPath(); co.moveTo(w * u * .5, -h * .74); co.quadraticCurveTo(w * u * 1.2, -h * .4, w * u, -h * .08); co.stroke(); }
      co.fillStyle = '#9f1239'; co.beginPath(); co.moveTo(-w * .3, -h * .78); co.quadraticCurveTo(-w * .7, -h * 1.02, -w * .45, -h * 1.06); co.quadraticCurveTo(0, -h * .92, w * .45, -h * 1.06); co.quadraticCurveTo(w * .7, -h * 1.02, w * .3, -h * .78); co.closePath(); co.fill();
      co.fillStyle = '#111111'; co.beginPath(); co.ellipse(0, -h * .86, w * .3, h * .06, 0, 0, TAU); co.fill(); // l'ouverture
      co.strokeStyle = '#facc15'; co.lineWidth = Math.max(1.4, s * .05); co.beginPath(); co.moveTo(-w * .34, -h * .78); co.quadraticCurveTo(0, -h * .7, w * .34, -h * .78); co.stroke();
      co.beginPath(); co.moveTo(w * .15, -h * .74); co.quadraticCurveTo(w * .4, -h * .52, w * .26, -h * .34); co.stroke();
      co.fillStyle = '#eab308'; co.beginPath(); co.arc(w * .26, -h * .32, s * .045, 0, TAU); co.fill();
      co.globalAlpha = .35; co.fillStyle = '#ffffff'; co.beginPath(); co.ellipse(-w * .5, -h * .5, w * .12, h * .2, -.4, 0, TAU); co.fill(); co.globalAlpha = 1;
      co.restore();
    };
    const mouth = () => ({ x: BX + Math.sin(now * 30) * bag.shake * 2, y: bag.y - BS * .82 * .9 });
    const spill = n => { const m = mouth(); for (let i = Math.round(n * q); i > 0; i--) tumble.add({ x: m.x + rnd(-6, 6), y: m.y, vx: rnd(-90, 120), vy: -rnd(80, 220), g: H * 9, drag: .4, max: rnd(.7, 1.1), rot: rnd(TAU), spin: rnd(-10, 10), s: H * rnd(.3, .42), top: (Math.random() * 7) | 0, bot: (Math.random() * 7) | 0 }); };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        // le sac tombe, s'écrase sur le sol, rebondit à peine et laisse échapper quelques dominos
        if (!bag.landed) { bag.vy += H * 22 * dt; bag.y += bag.vy * dt; if (bag.y >= BASE) { bag.y = BASE; bag.landed = 1; bag.sq = 1; spill(5); for (let i = Math.round(8 * q); i > 0; i--) dust.add({ x: BX + rnd(-1, 1) * BS * .4, y: BASE, vx: rnd(-60, 60), vy: -rnd(5, 30), drag: 2, g: 0, max: rnd(.5, .9), size: H * rnd(.06, .1) }); } }
        bag.sq *= Math.exp(-dt * 7); bag.shake *= Math.exp(-dt * 5);
        if (bag.burst) bag.gone = Math.min(1, bag.gone + dt * 2.5); // Mythic : le sac éclate (il gonfle et s'efface)
        tumble.step(dt); dust.step(dt);
        const wob = Math.sin(t * 38) * bag.sq, sx = 1 + .28 * wob, sy = 1 - .26 * wob;
        if (bag.gone < 1) { co.globalAlpha = 1 - bag.gone; drawBag(BX + Math.sin(t * 30) * bag.shake * 2, bag.y, BS * (1 + bag.gone * .4), sx, sy, Math.sin(t * 24) * bag.shake * .06); co.globalAlpha = 1; }
        behind(env, () => {
          dust.each((d, k) => dot(co, dark ? '#a8a29e' : '#78716c', d.x, d.y, d.size * (1 + k), (1 - k) * .4));
          tumble.each((d, k) => tile(d.x, d.y, d.s, d.rot + d.spin * d.life, Math.min(1, (1 - k) * 3), d.top, d.bot));
        });
        // les dominos qui sautent du sac jusqu'à leur case
        flying.run(dt, (f, k) => {
          const e = k, x = lerp(f.x0, f.x, e), y = lerp(f.y0, f.y, e) - Math.sin(e * Math.PI) * H * .9;
          tile(x, y, H * (f.big ? .62 : .5) * (1 - .25 * e), (1 - outCubic(e)) * f.turns, 1, f.top, f.bot);
        });
        // la rangée qui tombe en cascade, debout sur le haut de la carte
        rows.run(dt, (r, k) => {
          const T = k * r.life, dh = H * .5, dw = dh * .5, a = T > r.life - .4 ? (r.life - T) / .4 : 1;
          for (let i = 0; i < r.n; i++) {
            const appear = clamp((T - i * .018) / .12); if (appear <= 0) continue;
            const x = r.x0 + i * r.gap, start = .32 + i * r.step, f = clamp((T - start) / .16), last = i === r.n - 1;
            const lean = last ? Math.PI / 2 : Math.asin(Math.min(1, (r.gap - dw * .1) / dh));
            const ang = (f * f) * lean; // il bascule de plus en plus vite (pesanteur)
            if (f >= 1 && !r.clack[i]) { r.clack[i] = 1; if (i % 3 === 0 || last) dust.add({ x: x + dh * Math.sin(ang), y: card.y - 2, vx: rnd(-20, 20), vy: -rnd(10, 30), drag: 2, g: 0, max: .5, size: H * .05 }); }
            co.save(); co.globalAlpha = a; co.translate(x + dw / 2, card.y - 1); co.rotate(ang); co.translate(-dw / 2, -dh / 2); co.scale(1, appear);
            face(dh, r.pips[i][0], r.pips[i][1]); co.restore();
          }
        });
        words.run(dt, (w, k) => { const s = k < .15 ? outBack(k / .15) : 1; bWord(co, w.s, cx, card.y - H * 1.05, H * w.size * s, w.c, '#111111', k > .75 ? (1 - k) / .25 : 1, -.04); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        bag.shake = Math.min(1.2, bag.shake + .7);
        if (o.ghost) return;
        const m = mouth();
        flying.add({ x0: m.x, y0: m.y, x: p.x, y: p.y, life: .17, turns: rnd(5, 8) * (Math.random() < .5 ? -1 : 1), top: (Math.random() * 7) | 0, bot: (Math.random() * 7) | 0, big: o.last ? 1 : 0 });
      },
      build() { bag.shake = 1.4; spill(3); },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        const rnd7 = () => (Math.random() * 7) | 0;
        if (!p) { rows.add({ life: 1.6, n: 1, x0: cx - H * .1, gap: H * .3, step: 0, pips: [[1, 0]], clack: [] }); words.add({ delay: .6, life: 1.4, s: 'clack', c: dark ? '#a8a29e' : '#e7e5e4', size: .24 }); return; }
        const n = Math.max(4, Math.round(5 + 13 * p) + 4 * asc), x0 = card.x + H * .05, gap = Math.max(H * .26, (card.w - H * .3) / (n - 1));
        const m = Math.min(n, Math.floor((card.w - H * .1) / gap) + 1);
        rows.add({ life: 1.6 + m * .06 + .8 * p, n: m, x0, gap, step: .06, pips: Array.from({ length: m }, () => [rnd7(), rnd7()]), clack: [] });
        if (p >= .6) words.add({ delay: .5 + m * .06, life: 1.6 + p, s: 'DOMINO!', c: '#fafaf9', size: .3 });
        if (p >= 1) { bag.shake = 2; spill(26 + 14 * asc); bag.burst = 1; for (let i = Math.round((30 + 20 * asc) * q); i > 0; i--) tumble.add({ x: cx + rnd(-1, 1) * (card.w * .5 + H), y: card.y - H * rnd(1.4, 2.4), vx: rnd(-30, 30), vy: rnd(0, 60), g: H * 6, drag: .3, max: rnd(1.2, 1.8), rot: rnd(TAU), spin: rnd(-8, 8), s: H * rnd(.3, .45), top: rnd7(), bot: rnd7() }); }
      },
    };
  };

  // 🐸 Lily Pads (2026-10-27, idée de casmicgraything) — six nénuphars sur une mare (les cases, en CSS) et une grenouille
  // qui attend sur une feuille à gauche de la carte ; à chaque chiffre elle saute par-dessus (« a frog jumps across each
  // number as it reveals »), se pose sur le bord de la carte au-dessus de lui, le nénuphar plonge sous son poids et l'eau
  // fait des ronds. Une mouche tourne au-dessus de la mare ; à la révélation la grenouille la gobe d'un coup de langue,
  // des lotus s'ouvrent autour de la carte, des lucioles dès Epic, et dès Mythic un saut périlleux géant et RIBBIT! ;
  // tirage raté : elle glisse et tombe dans l'eau, plouf.
  SCENES.lilypad = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, S = H * .4;
    const LEFT = { x: card.x - H * .62, y: card.y + H * .72 }, RIGHT = { x: card.x + card.w + H * .62, y: card.y + H * .72 };
    const frog = { x: LEFT.x, y: LEFT.y, jump: null, crouch: 0, flip: 0, sink: 0 };
    const rings = timed(), drops = particles(), lotus = timed(), bugs = particles(), words = timed(), tongue = timed(), emit = emitter();
    const fly = { on: 1, x: 0, y: 0 };
    let now = 0, glowBugs = 0;
    const pad = (x, y, r, a) => { // une feuille de nénuphar vue de biais, encoche vers l'avant
      co.save(); co.globalAlpha = a; co.translate(x, y); co.scale(1, .42);
      co.fillStyle = '#166534'; co.beginPath(); co.moveTo(0, 0); co.arc(0, 0, r, .35 + Math.PI / 2, Math.PI / 2 - .35 + TAU); co.closePath(); co.fill();
      co.fillStyle = '#22c55e'; co.beginPath(); co.moveTo(0, 0); co.arc(0, -r * .08, r * .92, .4 + Math.PI / 2, Math.PI / 2 - .4 + TAU); co.closePath(); co.fill();
      co.strokeStyle = 'rgba(20,83,45,.5)'; co.lineWidth = 1.4; for (let i = 0; i < 7; i++) { const an = Math.PI / 2 + .6 + i * .8; co.beginPath(); co.moveTo(0, -r * .08); co.lineTo(Math.cos(an) * r * .85, Math.sin(an) * r * .85); co.stroke(); }
      co.restore();
    };
    const drawFrog = (x, y, s, sx, sy, rot, a) => { // y = sous les pattes
      if (a <= .01) return;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot); co.scale(sx, sy);
      co.fillStyle = '#15803d'; for (const e of [-1, 1]) { co.beginPath(); co.ellipse(e * s * .4, -s * .14, s * .22, s * .14, e * .35, 0, TAU); co.fill(); }
      const g = co.createRadialGradient(-s * .12, -s * .52, s * .04, 0, -s * .34, s * .6); g.addColorStop(0, '#bbf7d0'); g.addColorStop(.45, '#4ade80'); g.addColorStop(1, '#15803d');
      co.fillStyle = g; co.beginPath(); co.ellipse(0, -s * .33, s * .42, s * .32, 0, 0, TAU); co.fill();
      co.fillStyle = '#ecfccb'; co.beginPath(); co.ellipse(0, -s * .2, s * .25, s * .15, 0, 0, TAU); co.fill();
      for (const e of [-1, 1]) {
        co.fillStyle = '#22c55e'; co.beginPath(); co.arc(e * s * .21, -s * .6, s * .15, 0, TAU); co.fill();
        co.fillStyle = '#ffffff'; co.beginPath(); co.arc(e * s * .21, -s * .62, s * .105, 0, TAU); co.fill();
        co.fillStyle = '#111827'; co.beginPath(); co.arc(e * s * .21 + s * .02, -s * .61, s * .055, 0, TAU); co.fill();
      }
      co.strokeStyle = '#14532d'; co.lineWidth = Math.max(1, s * .04); co.lineCap = 'round'; co.beginPath(); co.arc(0, -s * .44, s * .2, .3, Math.PI - .3); co.stroke();
      co.fillStyle = '#f472b6'; co.globalAlpha = a * .5; for (const e of [-1, 1]) { co.beginPath(); co.arc(e * s * .3, -s * .36, s * .05, 0, TAU); co.fill(); } co.globalAlpha = a;
      co.fillStyle = '#16a34a'; for (const e of [-1, 1]) { co.beginPath(); co.ellipse(e * s * .17, -s * .04, s * .09, s * .05, 0, 0, TAU); co.fill(); }
      co.restore();
    };
    const lotusAt = (x, y, s, open, a) => { // fleur de lotus rose : pétales pointus qui s'ouvrent
      if (a <= .01 || open <= .01) return;
      const o = outBack(open);
      co.save(); co.globalAlpha = a; co.translate(x, y);
      for (let i = 0; i < 7; i++) { const an = -Math.PI / 2 + (i - 3) * .42 * o; co.save(); co.rotate(an + Math.PI / 2); co.fillStyle = i % 2 ? '#f9a8d4' : '#ec4899'; co.beginPath(); co.moveTo(0, 0); co.quadraticCurveTo(-s * .22, -s * .5, 0, -s * o); co.quadraticCurveTo(s * .22, -s * .5, 0, 0); co.fill(); co.restore(); }
      co.fillStyle = '#fde047'; co.beginPath(); co.arc(0, -s * .12, s * .12, 0, TAU); co.fill();
      co.restore();
    };
    const splash = (x, y, n, big) => { for (let i = Math.round(n * q); i > 0; i--) { const an = -Math.PI / 2 + rnd(-1, 1); drops.add({ x, y, vx: Math.cos(an) * rnd(30, 90 + 90 * big), vy: Math.sin(an) * rnd(80, 160 + 120 * big), g: H * 10, max: rnd(.35, .6), size: rnd(1.2, 2.4) }); } };
    const ring = (p, big, delay = 0) => { const ip = bInner(env, p); rings.add({ x: ip.x, y: ip.y, r: H * (big ? 1 : .6), life: big ? 1.1 : .8, delay }); rings.add({ x: ip.x, y: ip.y, r: H * (big ? .7 : .4), life: .7, delay: delay + .12 }); };
    const hop = (tx, ty, dur, height, flips = 0) => { frog.jump = { fx: frog.x, fy: frog.y, tx, ty, t: 0, dur, height, flips }; };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        // les deux feuilles hors de la carte : le départ et l'arrivée
        behind(env, () => { pad(LEFT.x, LEFT.y + S * .05, H * .5, 1); pad(RIGHT.x, RIGHT.y + S * .05, H * .5, 1); });
        // les ronds dans l'eau, dans la carte, derrière les chiffres
        rings.run(dt, (r, k) => { ci.globalAlpha = (1 - k) * .75; ci.strokeStyle = '#d1fae5'; ci.lineWidth = 2 * (1 - k) + .6; ci.beginPath(); ci.ellipse(r.x, r.y, r.r * outCubic(k), r.r * .42 * outCubic(k), 0, 0, TAU); ci.stroke(); });
        ci.globalAlpha = 1;
        // lotus autour de la carte (révélation)
        lotus.run(dt, (l, k) => behind(env, () => lotusAt(l.x, l.y, l.s, clamp(k * l.life / .5), k > .8 ? (1 - k) / .2 : 1)));
        // la grenouille : accroupie (élan), en l'air (étirée), à l'atterrissage (écrasée), puis elle se pose
        let sx = 1, sy = 1, rot = 0, a = 1;
        frog.crouch *= Math.exp(-dt * 6);
        if (frog.queued && !frog.jump && (frog.queued.at -= dt) <= 0) { const g = frog.queued; frog.queued = null; g.go(); }
        if (frog.jump) {
          const j = frog.jump; j.t += dt; const k = j.t / j.dur;
          if (k < .18) { sy = 1 - .3 * (k / .18); sx = 1 + .15 * (k / .18); frog.x = j.fx; frog.y = j.fy; }
          else if (k < 1) { const u = (k - .18) / .82; frog.x = lerp(j.fx, j.tx, u); frog.y = lerp(j.fy, j.ty, u) - Math.sin(u * Math.PI) * j.height; sy = 1.22; sx = .85; rot = j.flips * TAU * outCubic(u) + (j.tx > j.fx ? .25 : -.25) * Math.sin(u * Math.PI); }
          else if (k < 1.5) { frog.x = j.tx; frog.y = j.ty; const u = (k - 1) / .5; sy = 1 - .3 * Math.sin(u * Math.PI) * (1 - u); sx = 1 + .2 * Math.sin(u * Math.PI) * (1 - u); if (!j.landed) { j.landed = 1; if (j.onLand) j.onLand(); } }
          else { frog.jump = null; }
        } else { sy = 1 - .12 * frog.crouch + Math.sin(t * 3) * .015; sx = 1 + .08 * frog.crouch; }
        if (frog.sink) { frog.sink += dt; a = clamp(1 - frog.sink / .5); }
        // la mouche : elle tourne au-dessus de la carte, puis se fait gober
        if (fly.on) { fly.x = card.x + card.w * .75 + Math.cos(t * 2.3) * H * .5; fly.y = card.y - H * .95 + Math.sin(t * 4.6) * H * .18; co.globalAlpha = .6; co.fillStyle = '#e2e8f0'; const fl = Math.abs(Math.sin(t * 60)); co.beginPath(); co.ellipse(fly.x - 2.5, fly.y - 2, 2.5, 1.2 + 1.5 * fl, -.5, 0, TAU); co.ellipse(fly.x + 2.5, fly.y - 2, 2.5, 1.2 + 1.5 * fl, .5, 0, TAU); co.fill(); co.globalAlpha = 1; co.fillStyle = dark ? '#0f172a' : '#111827'; co.beginPath(); co.arc(fly.x, fly.y, 2.2, 0, TAU); co.fill(); }
        tongue.run(dt, (g, k) => { const e = k < .5 ? outCubic(k * 2) : 1 - (k - .5) * 2, mx = frog.x, my = frog.y - S * .42, tx = lerp(mx, g.x, e), ty = lerp(my, g.y, e); co.globalAlpha = 1; co.strokeStyle = '#ec4899'; co.lineWidth = Math.max(2, S * .08); co.lineCap = 'round'; co.beginPath(); co.moveTo(mx, my); co.lineTo(tx, ty); co.stroke(); co.fillStyle = '#f472b6'; co.beginPath(); co.arc(tx, ty, S * .07, 0, TAU); co.fill(); if (k > .5) { fly.on = 0; co.fillStyle = '#111827'; co.beginPath(); co.arc(tx, ty, 2, 0, TAU); co.fill(); } });
        const draw = () => drawFrog(frog.x, frog.y, S, sx, sy, rot, a);
        if (frog.sink) behind(env, draw); else draw();
        drops.step(dt);
        co.fillStyle = dark ? '#a5f3fc' : '#0891b2';
        drops.each((d, k) => { co.globalAlpha = 1 - k; co.beginPath(); co.arc(d.x, d.y, d.size, 0, TAU); co.fill(); });
        // lucioles (Epic et plus)
        if (glowBugs) for (let n = emit(glowBugs * 10 * q, dt); n > 0; n--) bugs.add({ x: cx + rnd(-1, 1) * (card.w * .5 + H), y: card.y + rnd(-.9, 1.2) * H, vx: rnd(-12, 12), vy: rnd(-22, -6), max: rnd(1.4, 2.4), seed: rnd(TAU) });
        bugs.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        bugs.each((b, k) => { const tw = .5 + .5 * Math.sin(t * 8 + b.seed); dot(co, '#fde047', b.x + Math.sin(t * 2 + b.seed) * 6, b.y, 5 + 3 * tw, Math.sin(k * Math.PI) * (dark ? .9 : .7) * tw); });
        co.globalCompositeOperation = 'source-over';
        words.run(dt, (wd, k) => { const s = k < .15 ? outBack(k / .15) : 1; bWord(co, wd.s, cx, card.y - H * .85, H * wd.size * s, wd.c, '#14532d', k > .75 ? (1 - k) / .25 : 1, -.05); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) { ring(p, 0); return; }
        const ty = card.y + 3;
        hop(p.x, ty, .3, H * (o.last ? .75 : .5));
        frog.jump.onLand = () => { ring(p, o.last); splash(p.x, card.y + 2, o.last ? 10 : 5, o.last ? 1 : 0); };
      },
      build() { frog.crouch = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        if (!p) { // elle glisse et tombe à l'eau, derrière la carte
          hop(frog.x + H * .3, card.y + H * .9, .55, H * .2); frog.jump.onLand = () => { frog.sink = .01; ring({ x: frog.x, y: card.y + H * .8 }, 1); splash(frog.x, card.y + H * .2, 12, 1); };
          words.add({ delay: .6, life: 1.4, s: 'plop', c: '#ccfbf1', size: .26 }); return;
        }
        tongue.add({ life: .3, x: fly.x, y: fly.y });
        for (let i = 0; i < Math.round(3 + 9 * p) + 3 * asc; i++) { const a = along(card, (i + .5) / (Math.round(3 + 9 * p) + 3 * asc) + .05); lotus.add({ delay: .25 + i * .07, life: 2.4 + p + asc * .5, x: a.x, y: a.y + (a.y > card.y + card.h / 2 ? H * .15 : 0), s: H * rnd(.24, .34) }); }
        if (p >= .6) glowBugs = .6 + .4 * p + .5 * asc;
        if (p >= 1) {
          const end = RIGHT;
          frog.queued = { at: .45, go: () => { hop(end.x, end.y, 1.1, H * (1.5 + .3 * asc), 1); frog.jump.onLand = () => { for (let i = 0; i < 4; i++) ring({ x: card.x + card.w * (.15 + .23 * i), y: card.y + H * .6 }, 1, i * .1); splash(end.x, end.y, 16, 1); }; } };
          words.add({ delay: 1.2, life: 2 + .4 * asc, s: 'RIBBIT!', c: '#bbf7d0', size: .3 });
        }
      },
    };
  };

  // 💧 Ripple (2026-10-27, idée de casmicgraything) — de l'eau calme vue de dessus : pour chaque chiffre, une goutte tombe
  // et touche l'eau juste sur lui, une couronne d'éclaboussures saute et des ronds s'élargissent dans la carte, derrière
  // les chiffres ; avant le dernier, une grosse goutte gonfle au-dessus de lui. À la révélation : une grosse goutte au
  // centre, des ronds plus nombreux avec la rareté, et dès Mythic une vague (« on mythics it causes a wave ») déferle
  // derrière la carte, crête d'écume et embruns ; tirage raté : un petit plic.
  SCENES.ripple = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2;
    const drops = timed(), rings = timed(), crown = particles(), spray = particles(), waves = timed(), sheen = timed(), emit = emitter();
    let hang = 0, hangTo = 0, now = 0;
    const lastX = () => card.x + card.w - card.w / 12; // la case du dernier chiffre
    const DROP = dark ? '#e0f2fe' : '#0ea5e9';
    const drop = (x, y, r, stretch, a) => { // goutte en larme, reflet blanc
      co.save(); co.globalAlpha = a; co.translate(x, y);
      co.fillStyle = DROP; co.beginPath(); co.moveTo(0, -r * stretch * 1.8); co.bezierCurveTo(r * .9, -r * .6, r, r * .2, 0, r); co.bezierCurveTo(-r, r * .2, -r * .9, -r * .6, 0, -r * stretch * 1.8); co.fill();
      co.fillStyle = 'rgba(255,255,255,.85)'; co.beginPath(); co.ellipse(-r * .32, -r * .1, r * .18, r * .3, -.3, 0, TAU); co.fill();
      co.restore();
    };
    const ripple = (p, n, size, life = 1.1) => { const ip = p.inner ? p : bInner(env, p); for (let i = 0; i < n; i++) rings.add({ x: ip.x, y: ip.y, r: size * (1 - i * .12), life: life + i * .05, delay: i * .14 }); };
    const splash = (x, y, n, big) => { for (let i = Math.round(n * q); i > 0; i--) { const an = -Math.PI / 2 + rnd(-.9, .9); crown.add({ x: x + rnd(-3, 3), y, vx: Math.cos(an) * rnd(30, 80 + 120 * big), vy: Math.sin(an) * rnd(90, 170 + 200 * big), g: H * 11, max: rnd(.3, .55 + .3 * big), size: rnd(1.2, 2.2 + big) }); } };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        // l'eau vit : deux taches de lumière qui dérivent lentement dans la carte (caustiques)
        ci.globalCompositeOperation = 'lighter';
        dot(ci, '#7dd3fc', w * (.3 + .2 * Math.sin(t * .4)), h * (.4 + .2 * Math.sin(t * .53)), h * .9, .1);
        dot(ci, '#99f6e4', w * (.7 + .15 * Math.sin(t * .37 + 2)), h * (.6 + .2 * Math.sin(t * .61 + 1)), h * .8, .08);
        // les ronds : trois cercles par impact, aplatis (on voit l'eau de biais), clairs sur l'eau sombre
        rings.run(dt, (r, k) => { const e = outCubic(k), a = (1 - k) * (1 - k); ci.globalAlpha = a; ci.strokeStyle = '#e0f2fe'; ci.lineWidth = 2.8 * (1 - k) + .7; ci.beginPath(); ci.ellipse(r.x, r.y, r.r * e, r.r * e * .55, 0, 0, TAU); ci.stroke(); ci.globalAlpha = a * .35; ci.strokeStyle = '#0c4a6e'; ci.beginPath(); ci.ellipse(r.x, r.y + 2, r.r * e * .96, r.r * e * .53, 0, 0, TAU); ci.stroke(); });
        sheen.run(dt, (s, k) => { const x = lerp(-w * .3, w * 1.3, k); ci.globalAlpha = Math.sin(k * Math.PI) * .45; const g = ci.createLinearGradient(x - w * .2, 0, x + w * .2, 0); g.addColorStop(0, 'rgba(186,230,253,0)'); g.addColorStop(.5, s.c); g.addColorStop(1, 'rgba(186,230,253,0)'); ci.fillStyle = g; ci.fillRect(0, 0, w, h); });
        ci.globalCompositeOperation = 'source-over'; ci.globalAlpha = 1;
        // la vague des Mythic : une crête qui déferle de gauche à droite derrière la carte, l'écume par-dessus
        waves.run(dt, (wv, k) => {
          const dir = wv.dir, span = card.w + H * 4, X = dir > 0 ? card.x - H * 2 + span * k : card.x + card.w + H * 2 - span * k, base = card.y + H * 1.05, top = card.y - H * wv.h * Math.sin(Math.min(1, k * 1.6) * Math.PI * .5) * (k > .8 ? (1 - k) / .2 : 1), half = H * 1.6;
          behind(env, () => {
            const g = co.createLinearGradient(0, top, 0, base); g.addColorStop(0, '#22d3ee'); g.addColorStop(.5, '#0284c7'); g.addColorStop(1, '#0c4a6e');
            co.globalAlpha = .92; co.fillStyle = g; co.beginPath(); co.moveTo(X - dir * half * 2.2, base);
            co.bezierCurveTo(X - dir * half * 1.2, base, X - dir * half * .6, top + H * .2, X, top); // dos de la vague
            co.quadraticCurveTo(X + dir * half * .45, top - H * .05, X + dir * half * .4, top + H * .45); // la lèvre qui s'enroule
            co.quadraticCurveTo(X + dir * half * .15, top + H * .3, X + dir * half * .3, base); co.closePath(); co.fill();
            co.globalAlpha = .9; co.strokeStyle = '#f0f9ff'; co.lineWidth = Math.max(2, H * .07); co.lineCap = 'round'; co.beginPath(); co.moveTo(X - dir * half * .7, top + H * .25); co.quadraticCurveTo(X - dir * half * .2, top - H * .02, X + dir * half * .38, top + H * .1); co.stroke();
          });
          for (let n = emit(60 * q, dt); n > 0; n--) spray.add({ x: X + dir * rnd(0, H * .5), y: top + rnd(-4, 8), vx: dir * rnd(40, 160), vy: -rnd(60, 220), g: H * 7, drag: .6, max: rnd(.5, 1), size: rnd(1.2, 3) });
          if (!wv.lit && k > .3) { wv.lit = 1; sheen.add({ life: .9, c: 'rgba(224,242,254,.9)' }); }
        });
        // la grosse goutte qui gonfle avant le dernier chiffre
        hang += (hangTo - hang) * Math.min(1, dt * 4);
        if (hang > .02) drop(lastX(), card.y - H * .62 + Math.sin(t * 9) * 1.5 * hang, H * .07 * (1 + hang * .7), 1 + .3 * Math.sin(t * 7), hang);
        // les gouttes qui tombent, et leur impact
        drops.run(dt, (d, k) => {
          const y = lerp(card.y - H * 1.1, d.y, k * k);
          tail(co, DROP, d.x, y - H * .5, d.x, y, H * .05, .25);
          drop(d.x, y, H * (d.big ? .08 : .06), 1.6, 1);
          if (k > .9 && !d.hit) { d.hit = 1; ripple(d, d.n, d.size); splash(d.x, d.y, d.big ? 16 : 8, d.big ? 1 : 0); }
        });
        crown.step(dt); spray.step(dt);
        co.fillStyle = DROP;
        crown.each((c, k) => { co.globalAlpha = 1 - k; co.beginPath(); co.arc(c.x, c.y, c.size, 0, TAU); co.fill(); });
        co.fillStyle = dark ? '#f0f9ff' : '#38bdf8';
        spray.each((c, k) => { co.globalAlpha = (1 - k) * .9; co.beginPath(); co.arc(c.x, c.y, c.size, 0, TAU); co.fill(); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.last) hangTo = hang = 0; // la grosse goutte se détache : c'est elle qui tombe
        if (o.ghost) { ripple(p, 1, H * .35, .7); return; }
        drops.add({ x: p.x, y: p.y, life: .12, n: o.last ? 3 : 2, size: H * (o.last ? 1 : .7), big: o.last ? 1 : 0 });
      },
      build() { hangTo = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        hangTo = 0;
        if (!p) { drops.add({ x: cx, y: card.y + H * .5, life: .3, n: 1, size: H * .4, big: 0 }); return; }
        drops.add({ x: cx, y: card.y + H * .5, life: .16, n: 2 + Math.round(4 * p), size: card.w * (.4 + .5 * p), big: 1 });
        if (p >= .3) sheen.add({ delay: .2, life: .9, c: 'rgba(186,230,253,.8)' });
        if (p >= 1) { waves.add({ delay: .25, life: 1.5, dir: 1, h: 1.1 + .25 * asc }); if (asc) waves.add({ delay: 1.2, life: 1.5, dir: -1, h: .9 + .25 * asc }); }
      },
    };
  };

  // 🚄 Bullet Train (2026-10-27, idée de yukitsunodaiscool) — un ciel du soir sur un viaduc : un train à grande vitesse
  // blanc et bleu file dans le bas de la carte (calque intérieur : il passe derrière les chiffres) et chaque chiffre
  // surgit dans son sillage ; des pétales roses tombent autour de la carte et le passage du train les emporte. Avant le
  // dernier chiffre, un phare approche ; à la révélation, un long train passe et soulève une tempête de pétales, et dès
  // Mythic des mots japonais surgissent autour du nombre (すごい！, やった！, 神引き！…, « Japanese words pop up saying
  // good roll and other compliments »).
  SCENES.bullettrain = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, TY = h * .5, TH = h * .42;
    const trains = [], petals = particles(), inner = particles(), streaks = particles(), words = timed(), emit = emitter(), emitIn = emitter(), emitS = emitter();
    let wind = 0, lamp = 0, lampTo = 0, now = 0, storm = 0;
    const JP = ['すごい！', 'やった！', '神引き！', '最高！', 'おめでとう！', 'いい引き！'];
    const JPFONT = "900 SIZEpx 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'Noto Sans CJK JP', system-ui, sans-serif";
    const drawTrain = (c, nose, y, th, cars) => { // nose = x de la pointe ; le train s'étend vers la gauche
      const carL = th * 3, noseL = th * 2.2, back = nose - noseL - cars * carL;
      if (nose < -10 || back > w + 10) return;
      const g = c.createLinearGradient(0, y, 0, y + th); g.addColorStop(0, '#ffffff'); g.addColorStop(.6, '#e2e8f0'); g.addColorStop(1, '#94a3b8');
      c.globalAlpha = 1; c.fillStyle = g; c.beginPath(); c.moveTo(back, y + th * .12); c.lineTo(nose - noseL, y + th * .12); c.bezierCurveTo(nose - noseL * .35, y + th * .12, nose - th * .2, y + th * .5, nose, y + th * .88); c.lineTo(nose - th * .15, y + th); c.lineTo(back, y + th); c.closePath(); c.fill();
      c.fillStyle = '#1d4ed8'; c.beginPath(); c.moveTo(back, y + th * .66); c.lineTo(nose - noseL * .5, y + th * .66); c.quadraticCurveTo(nose - th * .6, y + th * .7, nose - th * .25, y + th * .8); c.lineTo(nose - noseL * .5, y + th * .78); c.lineTo(back, y + th * .78); c.closePath(); c.fill();
      c.fillStyle = '#1e293b'; c.fillRect(back, y + th * .3, nose - noseL - back, th * .2);
      c.fillStyle = '#fde68a'; for (let x = back + th * .25; x < nose - noseL - th * .3; x += th * .62) c.fillRect(x, y + th * .33, th * .34, th * .14);
      c.fillStyle = '#334155'; for (let i = 1; i <= cars; i++) c.fillRect(nose - noseL - i * carL, y + th * .12, 1.5, th * .88); // joints entre voitures
      c.fillStyle = '#0f172a'; c.beginPath(); c.moveTo(nose - noseL * .95, y + th * .26); c.quadraticCurveTo(nose - noseL * .45, y + th * .27, nose - noseL * .32, y + th * .5); c.lineTo(nose - noseL * .95, y + th * .5); c.closePath(); c.fill();
      dot(c, '#fef9c3', nose - th * .2, y + th * .8, th * .45, .9);
    };
    const petal = (c, x, y, s, rot, a) => { // un pétale de cerisier, encoché au bout
      c.save(); c.globalAlpha = a; c.translate(x, y); c.rotate(rot); c.fillStyle = dark || c === ci ? '#f9a8d4' : '#f472b6'; // plus soutenu sur page claire
      c.beginPath(); c.moveTo(0, -s); c.quadraticCurveTo(s * .9, -s * .2, 0, s); c.quadraticCurveTo(-s * .9, -s * .2, 0, -s); c.fill();
      c.fillStyle = '#fbcfe8'; c.beginPath(); c.ellipse(0, -s * .1, s * .22, s * .5, 0, 0, TAU); c.fill();
      c.restore();
    };
    const run = (noseAt, cars, speed) => { trains.push({ nose: noseAt, cars, v: speed }); wind = Math.max(wind, cars > 2 ? 1.6 : 1); };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        wind *= Math.exp(-dt * 2.2); storm *= Math.exp(-dt * .6);
        lamp += (lampTo - lamp) * Math.min(1, dt * 4);
        // pétales autour de la carte (derrière elle) et quelques-uns dans le ciel de la carte
        for (let n = emit((5 + 30 * storm) * q, dt); n > 0; n--) petals.add({ x: rnd(card.x - H * 2, card.x + card.w + H * 1.5), y: card.y - H * rnd(1.2, 1.9), vx: rnd(-8, 12), vy: rnd(18, 40), max: rnd(3, 5), s: H * rnd(.05, .085), rot: rnd(TAU), spin: rnd(-3, 3), seed: rnd(TAU) });
        for (let n = emitIn(1.5 * q, dt); n > 0; n--) inner.add({ x: rnd(0, w), y: -6, vx: rnd(-4, 8), vy: rnd(10, 20), max: rnd(3, 5), s: h * rnd(.04, .06), rot: rnd(TAU), spin: rnd(-2, 2), seed: rnd(TAU) });
        const gust = p => { p.x += (wind * H * 3 + Math.sin(t * 1.7 + p.seed) * 10) * dt; p.rot += (p.spin + wind * 6) * dt; };
        petals.step(dt); inner.step(dt); streaks.step(dt);
        petals.each(gust); inner.each(gust);
        behind(env, () => petals.each((p, k) => petal(co, p.x, p.y, p.s, p.rot, Math.min(1, (1 - k) * 4, k * 8) * (dark ? .85 : 1))), true);
        inner.each((p, k) => petal(ci, p.x, p.y, p.s, p.rot, Math.min(1, (1 - k) * 4) * .7));
        // le phare qui approche avant le dernier chiffre, au bout de la voie
        if (lamp > .02) { ci.globalCompositeOperation = 'lighter'; dot(ci, '#fef9c3', w * .04, TY + TH * .8, TH * (1 + 2 * lamp), lamp * .8); dot(ci, '#fde68a', w * .04, TY + TH * .8, TH * .4, lamp); ci.globalCompositeOperation = 'source-over'; }
        // les trains : dans la carte, sous les chiffres
        for (let i = trains.length - 1; i >= 0; i--) { const tr = trains[i]; tr.nose += tr.v * dt; drawTrain(ci, tr.nose, TY, TH, tr.cars); if (tr.nose - TH * (2.2 + 3 * tr.cars) > w + 20) trains.splice(i, 1); }
        ci.globalAlpha = 1;
        // traits de vitesse de part et d'autre de la carte quand un train passe
        for (let n = emitS(wind * 40 * q, dt); n > 0; n--) streaks.add({ x: card.x + rnd(-H * 1.4, card.w + H * .4), y: card.y + rnd(.15, 1) * H, vx: H * 9, vy: 0, max: .2, len: H * rnd(.4, 1) });
        behind(env, () => { co.strokeStyle = dark ? '#e2e8f0' : '#64748b'; co.lineWidth = 1.2; streaks.each((s, k) => { co.globalAlpha = Math.sin(k * Math.PI) * .5; co.beginPath(); co.moveTo(s.x - s.len, s.y); co.lineTo(s.x, s.y); co.stroke(); }); }, true);
        // les compliments japonais (Mythic et plus) : ils surgissent (élan, dépassement), flottent et s'effacent
        words.run(dt, (wd, k) => { const s = k < .12 ? outBack(k / .12) : 1; bWord(co, wd.s, wd.x, wd.y - k * H * .25, H * wd.size * s, wd.c, '#831843', k > .78 ? (1 - k) / .22 : 1, wd.rot, JPFONT); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.ghost) return;
        if (o.last) lampTo = 0;
        const ip = bInner(env, p), v = w * (o.last ? 3.6 : 3);
        run(ip.x + v * .05, o.last ? 2 : 1, v); // la pointe vient de passer le chiffre : il surgit derrière elle
      },
      build() { lampTo = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        lampTo = 0;
        if (!p) return;
        run(-10, 3 + Math.round(2 * p), w * 2.4);
        storm = .3 + 1.2 * p + .5 * asc;
        for (let i = burst(p, 50 * q, 6); i > 0; i--) { const a = along(card, rnd()); petals.add({ x: a.x, y: a.y, vx: rnd(-40, 160), vy: rnd(-120, -20), drag: 1.5, max: rnd(1.5, 3), s: H * rnd(.05, .09), rot: rnd(TAU), spin: rnd(-6, 6), seed: rnd(TAU) }); }
        if (p >= 1) {
          const spots = [[-.62, -.55], [.62, -.6], [0, -.95], [-.85, .1], [.85, .15], [-.3, -1.25]];
          const n = Math.min(JP.length, 3 + asc), order = JP.slice().sort(() => Math.random() - .5);
          for (let i = 0; i < n; i++) { const [u, v] = spots[i]; words.add({ delay: .3 + i * .28, life: 2.2 + .3 * asc, s: order[i], x: cx + u * (card.w * .5 + H * .4), y: card.y + H * .5 + v * H, size: .34, rot: rnd(-.12, .12), c: ['#fdf2f8', '#fbcfe8', '#fde68a'][i % 3] }); }
        }
      },
    };
  };

  // 🛰️ Orbital Cannon (2026-10-27, idée de LEVIATHAN) — un écran de visée sombre, un satellite en orbite au-dessus de
  // la carte. À chaque chiffre, un réticule se referme sur lui et un rayon tombe du ciel dessus (impact blanc, gerbe
  // d'étincelles, brûlure qui rougeoit dans la carte) ; avant le dernier, le satellite se charge et des crochets de visée
  // se referment sur toute la carte. À la révélation, un rayon géant s'abat sur le nombre, de la couleur de la rareté
  // (gris Common, vert, bleu, violet, orange, rouge Mythic, cyan, or, blanc, arc-en-ciel Infinite), plus large et plus
  // long avec elle, avec des ondes de choc ; tirage raté : le canon s'enraye (MISFIRE).
  SCENES.orbital = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const beams = timed(), reticles = timed(), finale = timed(), shock = timed(), burns = timed(), words = timed(), sparks = particles(), motes = particles(), emit = emitter();
    const COL = { trash: '#a16207', common: '#cbd5e1', uncommon: '#4ade80', rare: '#60a5fa', epic: '#c084fc', anomaly: '#fb923c', mythic: '#f43f5e', celestial: '#67e8f9', divine: '#fde047', godlike: '#ffffff', infinite: null };
    const sat = { x: cx, tx: cx, y: Math.max(26, card.y - H * 1.3) };
    let charge = 0, chargeTo = 0, lockOn = 0, lockTo = 0, now = 0;
    const add = dark ? 'lighter' : 'source-over';
    const hue = t => RAINBOW[Math.floor(t * 6) % RAINBOW.length]; // Infinite : le rayon passe par toutes les couleurs
    const colorOf = (b, t) => b.col || hue(t);
    const drawSat = (x, y, s) => { // corps doré, deux panneaux solaires, antenne vers le bas
      co.save(); co.translate(x, y); co.rotate(Math.sin(now * .8) * .05);
      co.fillStyle = '#1e3a8a'; co.strokeStyle = '#93c5fd'; co.lineWidth = 1;
      for (const e of [-1, 1]) { co.fillRect(e > 0 ? s * .42 : -s * 1.42, -s * .22, s, s * .44); co.strokeRect(e > 0 ? s * .42 : -s * 1.42, -s * .22, s, s * .44); co.beginPath(); for (let i = 1; i < 4; i++) { const xx = (e > 0 ? s * .42 : -s * 1.42) + i * s / 4; co.moveTo(xx, -s * .22); co.lineTo(xx, s * .22); } co.stroke(); }
      co.fillStyle = '#94a3b8'; co.fillRect(-s * .42, -s * .04, s * .84, s * .08);
      const g = co.createLinearGradient(-s * .35, 0, s * .35, 0); g.addColorStop(0, '#a16207'); g.addColorStop(.5, '#fde68a'); g.addColorStop(1, '#a16207');
      co.fillStyle = g; roundRect(co, -s * .34, -s * .36, s * .68, s * .62, s * .08); co.fill();
      co.fillStyle = '#475569'; co.beginPath(); co.moveTo(-s * .2, s * .26); co.lineTo(s * .2, s * .26); co.lineTo(s * .08, s * .48); co.lineTo(-s * .08, s * .48); co.closePath(); co.fill();
      co.restore();
    };
    const column = (x, y0, y1, wd, col, core, a) => { // un rayon vertical : halo coloré, puis cœur blanc
      if (a <= .01) return;
      const g = co.createLinearGradient(x - wd, 0, x + wd, 0); g.addColorStop(0, col + '00'); g.addColorStop(.5, col); g.addColorStop(1, col + '00'); // transparent de la même couleur : pas de halo gris sur page claire
      co.globalAlpha = a * .75; co.fillStyle = g; co.fillRect(x - wd, y0, wd * 2, y1 - y0);
      co.globalAlpha = a; co.fillStyle = col; co.fillRect(x - core / 2, y0, core, y1 - y0); // le cœur à la couleur du rayon…
      co.fillStyle = dark ? '#ffffff' : col; co.fillRect(x - core * .2, y0, core * .4, y1 - y0); // …et son fil blanc brûlant
    };
    const bracket = (x, y, bw, bh, col, a, lw = 2) => { // quatre coins de visée
      if (a <= .01) return;
      const c = Math.min(bw, bh) * .3; co.globalAlpha = a; co.strokeStyle = col; co.lineWidth = lw; co.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const px = x + sx * bw / 2, py = y + sy * bh / 2; co.moveTo(px, py - sy * c); co.lineTo(px, py); co.lineTo(px - sx * c, py); }
      co.stroke();
    };
    const HUD = dark ? '#67e8f9' : '#0891b2';
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        charge += (chargeTo - charge) * Math.min(1, dt * 3); lockOn += (lockTo - lockOn) * Math.min(1, dt * 5);
        sat.x += (sat.tx - sat.x) * Math.min(1, dt * 6);
        const sx = sat.x + Math.sin(t * .9) * H * .15, sy = sat.y + Math.sin(t * 1.3) * 3;
        // le satellite et sa lentille, plus brillante quand il se charge
        drawSat(sx, sy, H * .28);
        co.globalCompositeOperation = add;
        dot(co, HUD, sx, sy + H * .1, H * (.08 + .3 * charge), .5 + .5 * charge);
        if (charge > .05) for (let n = emit(40 * charge * q, dt); n > 0; n--) { const an = rnd(TAU), r = H * rnd(.6, 1.2); motes.add({ x: sx + Math.cos(an) * r, y: sy + Math.sin(an) * r, tx: sx, ty: sy + H * .1, max: rnd(.3, .5) }); }
        motes.step(dt);
        motes.each((m, k) => dot(co, HUD, lerp(m.x, m.tx, k * k), lerp(m.y, m.ty, k * k), 3, k));
        co.globalCompositeOperation = 'source-over';
        // les crochets de visée qui se referment sur toute la carte avant le dernier chiffre
        if (lockOn > .02) { const g = (1 - lockOn) * H * .8 + H * .12; bracket(cx, cy, card.w + g * 2, card.h + g * 2, HUD, lockOn * (.6 + .4 * Math.sin(t * 20) ** 2), 2.5); }
        // brûlures dans la carte, derrière les chiffres
        burns.run(dt, (b, k) => { ci.globalCompositeOperation = 'lighter'; dot(ci, b.col, b.x, b.y, h * .45 * (1 - .4 * k), (1 - k) * .55); ci.globalCompositeOperation = 'source-over'; ci.globalAlpha = (1 - k) * .5; ci.strokeStyle = '#fb923c'; ci.lineWidth = 1.5; ci.beginPath(); ci.ellipse(b.x, h - 4, h * .3 * (.5 + k), h * .06, 0, 0, TAU); ci.stroke(); ci.globalAlpha = 1; });
        // réticules qui se referment, puis les rayons de chaque chiffre
        reticles.run(dt, (r, k) => bracket(r.x, r.y, lerp(H * 1.3, H * .62, outCubic(k)), lerp(H * 1.5, H * .85, outCubic(k)), HUD, k < .8 ? 1 : (1 - k) / .2, 2));
        co.globalCompositeOperation = add;
        beams.run(dt, (b, k) => {
          const a = k < .12 ? k / .12 : Math.pow(1 - (k - .12) / .88, 1.5), wd = H * (b.big ? .22 : .14) * (k < .12 ? .4 + .6 * k / .12 : 1 - .6 * k);
          column(b.x, 0, b.y, wd, b.col, b.big ? 4 : 2.5, a);
          dot(co, '#ffffff', b.x, b.y, H * (b.big ? .24 : .16) * (1 - k * .5), a * .7);
          dot(co, b.col, b.x, b.y, H * 1.1, a * .6, H * .08); // reflet horizontal de l'impact
          if (!b.hit) { b.hit = 1; for (let i = Math.round((b.big ? 26 : 12) * q); i > 0; i--) { const an = -Math.PI / 2 + rnd(-1.5, 1.5); sparks.add({ x: b.x, y: b.y + rnd(-4, 4), vx: Math.cos(an) * rnd(60, 240), vy: Math.sin(an) * rnd(60, 240), drag: 2, g: 380, max: rnd(.3, .6), size: rnd(1.2, 2.2), c: b.col }); } }
        });
        // le rayon géant de la révélation : derrière la carte (le nombre reste lisible), la carte s'illumine de l'intérieur
        finale.run(dt, (f, k) => {
          const col = colorOf(f, t), T = k * f.life, open = T < .1 ? T / .1 : 1, a = T < .1 ? .6 : k > .7 ? (1 - k) / .3 : 1;
          const wd = (T < .1 ? H * .05 : lerp(f.wd, f.wd * .8, k)) * (1 + .06 * Math.sin(t * 50));
          behind(env, () => { column(cx, 0, card.y + card.h + H * .4, wd * open + H * .05, col, Math.max(4, wd * .55 * open), a); });
          if (T < .1) column(cx, 0, card.y, H * .06, '#ffffff', 2, 1); // le trait pilote, avant l'ouverture
          ci.globalCompositeOperation = 'lighter'; dot(ci, col, w / 2, h / 2, Math.max(w, h) * .8, a * .5 * open, h * 1.2); ci.globalCompositeOperation = 'source-over';
          if (!f.boom && T >= .1) { f.boom = 1; for (let i = 0; i < f.rings; i++) shock.add({ delay: i * .16, life: .9 + .2 * i, col, r: card.w * (.7 + .3 * i) }); for (let i = Math.round(f.sparks * q); i > 0; i--) { const an = rnd(TAU); sparks.add({ x: cx + Math.cos(an) * card.w * .4, y: card.y + card.h * (Math.random() < .5 ? 0 : 1), vx: Math.cos(an) * rnd(100, 380), vy: -rnd(40, 300), drag: 1.6, g: 260, max: rnd(.5, 1.1), size: rnd(1.4, 3), c: Math.random() < .5 ? '#ffffff' : col }); } }
          if (f.asc && T > .1) godrays(co, col, cx, card.y + card.h * .5, 10 + 4 * f.asc, card.w * .55, card.w * (1 + .3 * f.asc), t * .4, H * .25, a * .25);
        });
        shock.run(dt, (s, k) => behind(env, () => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = s.col; co.lineWidth = 3 * (1 - k) + 1; co.beginPath(); co.ellipse(cx, card.y + card.h, s.r * outCubic(k) + H * .2, (s.r * outCubic(k) + H * .2) * .22, 0, 0, TAU); co.stroke(); }));
        sparks.step(dt);
        sparks.each((s, k) => { tail(co, s.c, s.x - s.vx * .03, s.y - s.vy * .03, s.x, s.y, s.size, 1 - k); dot(co, s.c, s.x, s.y, s.size * 2, (1 - k) * .7); });
        co.globalCompositeOperation = 'source-over';
        // le message du viseur, sur sa plaque sombre (lisible même devant le rayon), à gauche du rayon
        words.run(dt, (wd, k) => {
          const a = (k < .1 ? k / .1 : k > .7 ? (1 - k) / .3 : 1) * (Math.sin(t * 30) > -.6 ? 1 : .4), fs = H * .2, x = card.x - H * .1, y = card.y - H * .5;
          co.font = `700 ${Math.round(fs)}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`; const tw = co.measureText(wd.s).width + fs;
          co.globalAlpha = a * .85; co.fillStyle = '#05090f'; co.fillRect(x - tw, y - fs * .8, tw, fs * 1.6); co.globalAlpha = a; co.strokeStyle = HUD; co.lineWidth = 1.5; co.strokeRect(x - tw, y - fs * .8, tw, fs * 1.6);
          co.fillStyle = wd.c; co.textAlign = 'center'; co.textBaseline = 'middle'; co.fillText(wd.s, x - tw / 2, y);
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        sat.tx = p.x;
        if (o.last) { lockTo = 0; chargeTo = .2; }
        const col = o.ghost ? '#475569' : dark ? '#67e8f9' : '#0891b2';
        if (!o.ghost) reticles.add({ x: p.x, y: p.y, life: .3 });
        beams.add({ x: p.x, y: p.y, col, big: o.last ? 1 : 0, life: o.ghost ? .25 : o.last ? .55 : .4 });
        const ip = bInner(env, p); burns.add({ x: ip.x, y: ip.y, col: o.ghost ? '#334155' : '#fb923c', life: o.ghost ? .4 : .9 });
      },
      build() { chargeTo = 1; lockTo = 1; sat.tx = cx; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        chargeTo = 0; lockTo = 0; sat.tx = cx;
        if (!p) { beams.add({ x: cx + rnd(-10, 10), y: card.y - H * .3, col: '#64748b', life: .2 }); words.add({ delay: .2, life: 1.6, s: 'MISFIRE', c: '#94a3b8' }); return; }
        finale.add({ life: .9 + 1.1 * p + .6 * asc, wd: card.w * (.32 + .4 * p) + H * .25 * asc, col: COL[tier] === undefined ? '#cbd5e1' : COL[tier], rings: 1 + Math.round(2 * p) + asc, sparks: 20 + 60 * p + 30 * asc, asc });
        if (p >= 1) words.add({ delay: .3, life: 1.8 + .4 * asc, s: 'DIRECT HIT', c: COL[tier] || '#ffffff' });
      },
    };
  };

  // ==== Skins du 2026-10-28 (Lightbulb, Stonks, Chess, Weather : idées de costoroll et casmicgraything) ====
  // 💡 Lightbulb (2026-10-28, idée de costoroll) — six ampoules sur un bureau, contre un mur tan (les cases, en CSS).
  // Chaque ampoule allumée jette un halo chaud sur le mur et une flaque de lumière sur le bureau (dans la carte, derrière
  // les chiffres) ; pendant le tirage elles bourdonnent (le halo vacille). Un chiffre qui se pose : « tink », le verre
  // se fêle au sommet (un trou dentelé et trois fêlures qui partent du trou, jamais sur le chiffre), quelques éclats
  // sautent et retombent sur le bureau, une bouffée de lumière s'échappe par le trou et le halo baisse (« loses some
  // light »). Avant le dernier chiffre, sa lampe grésille. Révélation : tirage raté, une ampoule grille (fumée, verre
  // gris) ; sinon une vague de lumière parcourt la rangée, des reflets dès Rare ; dès Mythic, les ampoules forcent
  // (.lbl-surge), puis éclatent toutes ensemble : éclair blanc, pluie d'éclats, le mur s'assombrit, verre gris (.lbl-dead),
  // fumée ; au-delà de Mythic, une gerbe d'étincelles sort des culots.
  SCENES.lightbulb = env => {
    const { ci, co, card, q, dark } = env;
    const el = env.el;
    if (el) { el.classList.remove('lbl-dead', 'lbl-surge'); el.querySelectorAll('.lbl-off').forEach(s => s.classList.remove('lbl-off')); }
    const st = new Map(), shards = particles(), puffs = particles(), smoke = particles(), sparks = particles(), waves = timed(), glints = timed(), flash = timed();
    let t = 0, build = 0, dead = 0, deadAt = -9, off = -1, offAt = -9;
    const later = [], after = (d, fn) => later.push({ at: t + d, fn }); // en temps de scène (le trailer avance la scène lui-même)
    // Une fêlure, en fractions de la case (u : -0,5 à 0,5 de la largeur, v : 0 à 1 de la hauteur, depuis le sommet).
    const mkCrack = () => {
      const hole = [[-.2, .05], [-.13, .1 + rnd(.03)], [-.06, .07], [0, .13 + rnd(.03)], [.07, .08], [.13, .12 + rnd(.03)], [.2, .05], [.1, .015], [-.1, .015]];
      const lines = [[[-.13, .11], [-.21, .15], [-.27, .2]], [[0, .14], [.03, .18], [.01, .21]], [[.13, .12], [.22, .15], [.28, .19]]].map(l => l.map(([u, v]) => [u + rnd(-.02, .02), v + rnd(-.015, .015)]));
      const big = [[[-.2, .06], [-.33, .16], [-.4, .3], [-.44, .42]], [[.2, .06], [.34, .18], [.41, .3], [.45, .44]], [[-.22, .23], [-.34, .36]], [[.25, .21], [.37, .33]], [[-.38, .62], [-.3, .78], [-.33, .88]], [[.4, .64], [.31, .8]]];
      return { hole, lines, big };
    };
    const at = (s, u, v) => [s.x + u * s.w, s.top + v * (s.bottom - s.top)];
    const path = (s, pts, k = 1) => { // tracé partiel (k de 0 à 1 : la fêlure qui court)
      const n = Math.max(1, (pts.length - 1) * clamp(k));
      co.beginPath();
      for (let i = 0; i <= Math.ceil(n); i++) { const j = Math.min(i, n), a = pts[Math.floor(j)], b = pts[Math.min(pts.length - 1, Math.floor(j) + 1)], f = j - Math.floor(j); const [x, y] = at(s, lerp(a[0], b[0], f), lerp(a[1], b[1], f)); i ? co.lineTo(x, y) : co.moveTo(x, y); }
      co.stroke();
    };
    const drawCrack = (s, c, k, kBig, grey) => {
      const lw = Math.max(1, s.w * .035);
      co.save(); co.globalAlpha = s.ghost ? .3 : 1; co.lineJoin = co.lineCap = 'round';
      // le trou au sommet : on voit l'intérieur, plus sombre
      const hk = outCubic(clamp(k * 2.5)) * (kBig > 0 ? 1 + .35 * outCubic(kBig) : 1);
      co.beginPath(); c.hole.forEach(([u, v], i) => { const [x, y] = at(s, u * hk, v * hk); i ? co.lineTo(x, y) : co.moveTo(x, y); }); co.closePath();
      co.fillStyle = grey ? 'rgba(55,65,81,.85)' : 'rgba(120,53,15,.62)'; co.fill();
      co.strokeStyle = 'rgba(255,251,235,.85)'; co.lineWidth = lw * .8; co.stroke();
      co.strokeStyle = grey ? 'rgba(31,41,55,.8)' : 'rgba(91,58,18,.8)'; co.lineWidth = lw;
      c.lines.forEach(l => path(s, l, k * 1.4 - .2));
      if (kBig > 0) c.big.forEach(l => path(s, l, kBig));
      co.translate(.8, .8); co.strokeStyle = 'rgba(255,255,255,.55)'; co.lineWidth = lw * .5;
      c.lines.forEach(l => path(s, l, k * 1.4 - .2));
      if (kBig > 0) c.big.forEach(l => path(s, l, kBig));
      co.restore();
    };
    const pop = (s, n, big) => { // éclats de verre qui sautent du sommet
      const [x, y] = at(s, 0, .06);
      for (let i = Math.round(n * q); i > 0; i--) { const an = -Math.PI / 2 + rnd(-1.1, 1.1) * (big ? 1.6 : 1); shards.add({ x: x + rnd(-.2, .2) * s.w, y: y + (big ? rnd(0, .6) * (s.bottom - s.top) : 0), vx: Math.cos(an) * rnd(40, big ? 230 : 110), vy: Math.sin(an) * rnd(80, big ? 300 : 190), g: card.h * 14, drag: .3, max: rnd(1.2, 2), size: rnd(1.5, big ? 4 : 3) * Math.max(.8, card.h / 80), r: rnd(TAU), spin: rnd(-16, 16), floor: s.bottom + (s.bottom - s.top) * .2 + rnd(-2, 2), x0: s.x - s.w * 4, x1: s.x + s.w * 4 }); }
    };
    return {
      frame(tt, dt) {
        t = tt;
        for (let i = later.length - 1; i >= 0; i--) if (later[i].at <= t) later.splice(i, 1)[0].fn();
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on);
        const floor = S.length ? S[0].bottom + (S[0].bottom - S[0].top) * .2 : card.y + card.h * .9;
        // nouvelles fêlures (un chiffre vient de se poser)
        for (const s of S) if (s.on && !st.has(s.i)) {
          st.set(s.i, { at: t, c: mkCrack() });
          if (!s.ghost) { pop(s, 5, false); const [x, y] = at(s, 0, .02); puffs.add({ x, y, vx: 0, vy: -card.h * .5, drag: 1.5, max: .55, size: s.w * .8 }); }
        }
        // les vagues de lumière de la révélation
        const boost = new Map();
        waves.run(dt, (wv, k) => S.forEach((s, j) => { const d = k * (S.length + 2) - 1 - j; boost.set(s.i, (boost.get(s.i) || 0) + Math.max(0, 1 - Math.abs(d)) * wv.p); }));
        // le mur s'assombrit quand tout est éteint
        const black = dead ? clamp((t - deadAt) / .5) : 0;
        if (black > 0) { ci.globalAlpha = .38 * black; ci.fillStyle = '#120b04'; ci.fillRect(0, 0, env.w, env.h); }
        // halos sur le mur et flaques de lumière sur le bureau (derrière les chiffres)
        ci.globalCompositeOperation = 'lighter';
        for (const s of S) {
          const e = st.get(s.i);
          let L;
          if (!s.on) L = (next && s.i === next.i && build ? .55 + (Math.random() < .5 ? .6 : 0) : .9) + .12 * Math.sin(t * 31 + s.i * 7) * Math.sin(t * 13 + s.i);
          else { const k = (t - e.at) / .4; L = k < .15 ? 1.5 : lerp(1.1, .52, clamp(k)) + .03 * Math.sin(t * 5 + s.i); }
          L += boost.get(s.i) || 0;
          if (dead) L = t - deadAt < .08 ? 2.5 : 0;
          if (s.i === off) L = t - offAt < .1 ? 2.2 : 0;
          if (s.ghost) L *= .3;
          const ip = bInner(env, { x: s.x, y: s.y }), fy = floor - card.y - (card.w - env.w) / 2;
          dot(ci, '#fde68a', ip.x, ip.y, card.h * .7, .3 * L);
          dot(ci, '#fbbf24', ip.x, fy + 2, s.w * 1.1, .4 * L, s.w * .22);
        }
        // l'éclair de l'éclatement : derrière les chiffres (dans la carte) et autour de la carte, jamais par-dessus
        flash.run(dt, (f, k) => { const ip = bInner(env, f); dot(ci, '#ffffff', ip.x, ip.y, f.r, (1 - k) * .9); behind(env, () => { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, dark ? '#fef9c3' : '#facc15', f.x, f.y, f.r * 1.4, (1 - k) * (dark ? .5 : .35)); co.globalCompositeOperation = 'source-over'; }); });
        ci.globalCompositeOperation = 'source-over'; ci.globalAlpha = 1;
        // bouffées de lumière qui s'échappent par le trou
        puffs.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        puffs.each((p, k) => dot(co, dark ? '#fef08a' : '#facc15', p.x, p.y, p.size * (1 + k), (1 - k) * (dark ? .8 : .55)));
        co.globalCompositeOperation = 'source-over';
        // les fêlures
        for (const s of S) { const e = st.get(s.i); if (e) drawCrack(s, e.c, (t - e.at) / .12, dead ? (t - deadAt) / .1 : 0, dead || s.i === off); }
        // reflets (dès Rare) : petites étoiles sur le verre
        glints.run(dt, (g, k) => { const s = S.find(x => x.i === g.i); if (!s) return; const [x, y] = at(s, -.22, .3), r = s.w * .35 * Math.sin(k * Math.PI); co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; line(co, dark ? '#fff' : '#fef9c3', x - r, y, x + r, y, 1.2, .9); line(co, dark ? '#fff' : '#fef9c3', x, y - r, x, y + r, 1.2, .9); dot(co, '#fff7d6', x, y, r * .6, .7); co.globalCompositeOperation = 'source-over'; });
        // éclats : ils tombent, rebondissent sur le bureau et y restent un moment en scintillant
        shards.step(dt);
        shards.each((p, k) => {
          if (p.x > p.x0 && p.x < p.x1 && p.y > p.floor && p.vy > 0) { p.y = p.floor; p.vy *= -.25; p.vx *= .5; p.spin *= .4; if (Math.abs(p.vy) < 20) { p.vy = 0; p.g = 0; p.vx *= .2; } }
          p.r += p.spin * dt;
          co.save(); co.globalAlpha = clamp((1 - k) * 4) * (dead ? .95 : .85); co.translate(p.x, p.y); co.rotate(p.r);
          co.beginPath(); co.moveTo(0, -p.size); co.lineTo(p.size * .8, p.size * .5); co.lineTo(-p.size * .6, p.size * .7); co.closePath();
          co.fillStyle = dead ? '#e5e7eb' : '#fef3c7'; co.fill(); co.strokeStyle = dead ? '#4b5563' : '#92400e'; co.lineWidth = .8; co.stroke();
          co.restore();
        });
        // fumée (ampoule grillée, ou toutes après l'éclatement) et étincelles des culots
        smoke.step(dt);
        smoke.each((p, k) => dot(co, dark ? '#9ca3af' : '#6b7280', p.x + Math.sin(t * 2 + p.seed) * 5 * k, p.y, p.size * (1.4 + 3 * k), Math.sin(k * Math.PI) * (dark ? .3 : .38)));
        sparks.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.each((p, k) => { dot(co, '#fb923c', p.x, p.y, 3.5, (1 - k)); dot(co, '#fff7ed', p.x, p.y, 1.3, 1 - k); });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) build = 0; },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        const S = slotsA(env).filter(s => !s.gone && !s.ghost);
        if (!p) { // une ampoule grille : éclair, puis verre gris et un filet de fumée
          const s = S.length ? pick(S) : null;
          if (!s) return;
          off = s.i; offAt = t;
          const node = el && el.querySelectorAll('.slot')[s.i]; if (node) node.classList.add('lbl-off');
          const [x, y] = at(s, 0, .05);
          for (let i = 0; i < 5; i++) smoke.add({ x: x + rnd(-3, 3), y, vx: rnd(-6, 6), vy: -rnd(18, 32), drag: .4, max: rnd(1.6, 2.4), size: s.w * .22, seed: rnd(TAU), delay: 0 });
          return;
        }
        if (p < 1) {
          waves.add({ life: .9 + .3 * p, p: .5 + .9 * p });
          if (p >= .6) waves.add({ delay: .5, life: .9, p: .5 + .6 * p });
          if (p >= .42) S.forEach((s, j) => glints.add({ delay: .15 + j * .09, life: .45, i: s.i }));
          return;
        }
        // Mythic et plus : les ampoules forcent… puis éclatent toutes ensemble
        if (el) el.classList.add('lbl-surge');
        waves.add({ life: .45, p: 1.2 });
        after(.42, () => {
          if (el) { el.classList.remove('lbl-surge'); el.classList.add('lbl-dead'); }
          dead = 1; deadAt = t;
          const L = slotsA(env).filter(s => !s.gone);
          L.forEach(s => {
            const [x, y] = at(s, 0, .4);
            flash.add({ life: .35, x, y, r: s.w * 1.6 });
            if (s.ghost) return;
            pop(s, 9 + 4 * asc, true);
            for (let i = 0; i < 3; i++) smoke.add({ x: x + rnd(-4, 4), y: s.top, vx: rnd(-6, 6), vy: -rnd(14, 28), drag: .4, max: rnd(1.8, 2.8), size: s.w * .2, seed: rnd(TAU) });
            if (asc) for (let i = Math.round((6 + 5 * asc) * q); i > 0; i--) sparks.add({ x: s.x + rnd(-.2, .2) * s.w, y: s.bottom + 2, vx: rnd(-90, 90), vy: -rnd(120, 260), g: card.h * 9, drag: .4, max: rnd(.6, 1.1) });
          });
        });
      },
    };
  };

  // 📈 Stonks (2026-10-28, idée de casmicgraything, avec costoroll et casmictechthing) — l'écran d'un terminal de
  // bourse : une courbe de cours en direct court derrière les chiffres (dans la carte), sa tête avance vers le prochain
  // chiffre en hésitant (le marché ne sait pas encore), une bougie verte ou rouge se pose sous chaque chiffre qui se
  // fige, et avant le dernier la courbe s'affole. Révélation : le verdict, selon la rareté. Tirage raté : krach, la
  // courbe plonge sous l'écran en rouge ; Common : petite baisse rouge ; Uncommon et mieux : hausse verte, plus raide
  // avec la rareté, et l'étiquette du gain au bout ; dès Mythic, la courbe crève le haut de l'écran, file au-dessus de la
  // carte avec une flèche, et une pluie de pièces et de billets tombe (plus dense au-delà de Mythic). Les étiquettes
  // ne sont que des nombres (« +64.0% ») : rien à traduire. Aucune marque, aucun vrai symbole boursier.
  SCENES.stonks = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const el = env.el;
    if (el) el.classList.remove('stonk-up', 'stonk-down');
    const pts = [{ x: .03, y: .55 }], candles = [], coins = particles(), flashes = timed(), labels = timed(), seen = new Set();
    let t = 0, build = 0, hx = .03, hy = .55, vy = 0, verdict = null, col = '#38bdf8', lastAdd = 0, redAt = -9;
    const GREEN = '#22c55e', RED = '#ef4444';
    const X = u => lerp(w * .03, w * .95, u), Y = v => lerp(h * .1, h * .9, v);
    const money = (x, y, kind) => coins.add({ x, y, vx: rnd(-30, 30), vy: rnd(20, 70), g: kind ? card.h * 1.2 : card.h * 3.2, drag: kind ? 1.6 : .4, max: rnd(1.8, 2.6), kind, r: rnd(TAU), spin: rnd(-4, 4), flip: rnd(TAU), fs: rnd(5, 9), size: card.h * (kind ? rnd(.13, .17) : rnd(.08, .11)), seed: rnd(TAU) });
    const drawMoney = (m, a) => {
      co.save(); co.globalAlpha = a; co.translate(m.x + (m.kind ? Math.sin(t * 3 + m.seed) * card.h * .15 : 0), m.y); co.rotate(m.r);
      const f = Math.cos(m.flip), s = m.size;
      if (m.kind) { // un billet (vert, sans aucun vrai motif) qui flotte en se retournant
        co.scale(1, Math.max(.15, Math.abs(f)));
        co.fillStyle = f > 0 ? '#86efac' : '#4ade80'; co.strokeStyle = '#166534'; co.lineWidth = 1.2;
        roundRect(co, -s * 1.1, -s * .5, s * 2.2, s, s * .08); co.fill(); co.stroke();
        co.strokeStyle = 'rgba(22,101,52,.6)'; co.strokeRect(-s * .95, -s * .36, s * 1.9, s * .72);
        co.fillStyle = '#15803d'; co.beginPath(); co.ellipse(0, 0, s * .28, s * .26, 0, 0, TAU); co.fill();
        co.fillStyle = '#bbf7d0'; co.font = `900 ${Math.round(s * .42)}px system-ui, sans-serif`; co.textAlign = 'center'; co.textBaseline = 'middle'; co.fillText('$', 0, s * .02);
      } else { // une pièce d'or qui tourne sur elle-même
        co.scale(Math.max(.12, Math.abs(f)), 1);
        co.fillStyle = '#a16207'; co.beginPath(); co.arc(0, s * .12, s, 0, TAU); co.fill();
        co.fillStyle = '#facc15'; co.beginPath(); co.arc(0, 0, s, 0, TAU); co.fill();
        co.strokeStyle = '#ca8a04'; co.lineWidth = Math.max(1, s * .14); co.beginPath(); co.arc(0, 0, s * .66, 0, TAU); co.stroke();
        co.fillStyle = '#fef9c3'; co.beginPath(); co.ellipse(-s * .35, -s * .35, s * .2, s * .12, -.7, 0, TAU); co.fill();
      }
      co.restore();
    };
    return {
      frame(tt, dt) {
        t = tt;
        const S = slotsA(env).filter(s => !s.gone), on = S.filter(s => s.on).length, n = Math.max(1, S.length);
        // nouvelles bougies : une par chiffre posé, sous lui (verte si le chiffre monte, rouge s'il baisse)
        for (const s of S) if (s.on && !seen.has(s.i)) {
          seen.add(s.i);
          const ip = bInner(env, s), d = Number(s.ghost ? 0 : (el && el.querySelectorAll('.slot')[s.i] || {}).textContent) || 0;
          candles.push({ x: ip.x / w, up: d >= 5, body: rnd(.12, .26), wick: rnd(.08, .14), mid: clamp(hy + rnd(-.08, .08), .3, .7), at: t, ghost: s.ghost });
          flashes.add({ life: .4, x: X(hx), y: Y(hy) });
          vy += (d >= 5 ? -1 : 1) * rnd(.9, 1.6);
        }
        // la tête de la courbe : elle avance vers le prochain chiffre en hésitant ; le verdict la mène au bout
        if (!verdict) {
          const target = .03 + .7 * Math.min(1, (on + .85) / n);
          hx += (target - hx) * Math.min(1, dt * 1.6);
          const jit = build ? 3.2 : 1;
          vy += (rnd(-1, 1) * 16 * jit - (hy - .5) * 10 - vy * 2.2) * dt;
          hy = clamp(hy + vy * dt * .5, .1, .9);
        } else {
          const v = verdict, k = clamp((t - v.at) / v.dur), e = v.p >= 1 ? k * k : outCubic(k);
          hx = lerp(v.x0, v.x1, k); hy = lerp(v.y0, v.y1, e) + (v.p < 1 ? Math.sin(k * 23) * .025 * (1 - k) : 0);
          if (k >= 1 && !v.done) { v.done = true; if (v.onEnd) v.onEnd(); }
        }
        if (t - lastAdd > .045) { lastAdd = t; pts.push({ x: hx, y: hy }); if (pts.length > 260) pts.splice(1, 1); }
        const line = pts.concat({ x: hx, y: hy });
        // krach : l'écran rougit un instant
        if (t - redAt < .9) { ci.globalAlpha = .35 * (1 - (t - redAt) / .9) * (t - redAt < .15 || (t - redAt > .3 && t - redAt < .45) ? 1 : .5); ci.fillStyle = '#dc2626'; ci.fillRect(0, 0, w, h); ci.globalAlpha = 1; }
        // bougies, derrière tout
        for (const c of candles) {
          const k = outCubic((t - c.at) / .25), x = X(c.x), cw = Math.max(4, w * .03), top = Y(c.mid - c.body / 2 * k), bot = Y(c.mid + c.body / 2 * k);
          ci.globalAlpha = c.ghost ? .15 : .5; ci.fillStyle = ci.strokeStyle = c.up ? GREEN : RED; ci.lineWidth = 1.2;
          ci.beginPath(); ci.moveTo(x, Y(c.mid - (c.body / 2 + c.wick) * k)); ci.lineTo(x, Y(c.mid + (c.body / 2 + c.wick) * k)); ci.stroke();
          ci.fillRect(x - cw / 2, top, cw, Math.max(1, bot - top));
        }
        // l'aire sous la courbe, puis la courbe (halo, trait)
        const pathLine = c => { c.beginPath(); line.forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y)))); };
        const g = ci.createLinearGradient(0, 0, 0, h); g.addColorStop(0, col + '55'); g.addColorStop(1, col + '00');
        pathLine(ci); ci.lineTo(X(hx), h); ci.lineTo(X(line[0].x), h); ci.closePath(); ci.globalAlpha = .7; ci.fillStyle = g; ci.fill();
        ci.lineJoin = ci.lineCap = 'round';
        pathLine(ci); ci.globalAlpha = .35; ci.strokeStyle = col; ci.lineWidth = Math.max(4, h * .07); ci.stroke();
        pathLine(ci); ci.globalAlpha = .95; ci.lineWidth = Math.max(1.6, h * .028); ci.stroke();
        // la tête : un point qui pulse
        ci.globalCompositeOperation = 'lighter'; dot(ci, col, X(hx), Y(hy), h * .13 * (1 + .25 * Math.sin(t * 12)), .9); ci.globalCompositeOperation = 'source-over';
        flashes.run(dt, (f, k) => { ci.globalAlpha = (1 - k) * .8; ci.strokeStyle = '#e0f2fe'; ci.lineWidth = 1.5; ci.beginPath(); ci.arc(f.x, f.y, h * (.05 + .25 * k), 0, TAU); ci.stroke(); });
        ci.globalAlpha = 1;
        // Mythic : la courbe sort de l'écran par le haut et file au-dessus de la carte, avec une flèche
        if (verdict && verdict.p >= 1 && verdict.done) {
          const k = clamp((t - verdict.end) / .5), ex = card.x + (card.w - w) / 2 + X(verdict.x1), ey = card.y, tx = ex + card.h * .5 * outCubic(k), ty = ey - card.h * (.2 + 1.1 * outCubic(k));
          co.lineCap = 'round'; co.strokeStyle = dark ? '#4ade80' : '#16a34a';
          co.globalAlpha = .35; co.lineWidth = Math.max(5, card.h * .1); co.beginPath(); co.moveTo(ex, ey + 2); co.lineTo(tx, ty); co.stroke();
          co.globalAlpha = 1; co.lineWidth = Math.max(2.4, card.h * .045); co.beginPath(); co.moveTo(ex, ey + 2); co.lineTo(tx, ty); co.stroke();
          const an = Math.atan2(ty - ey, tx - ex), A = card.h * .2;
          co.fillStyle = co.strokeStyle; co.beginPath(); co.moveTo(tx + Math.cos(an) * A * .6, ty + Math.sin(an) * A * .6); co.lineTo(tx + Math.cos(an + 2.4) * A, ty + Math.sin(an + 2.4) * A); co.lineTo(tx + Math.cos(an - 2.4) * A, ty + Math.sin(an - 2.4) * A); co.closePath(); co.fill();
          if (dark) { co.globalCompositeOperation = 'lighter'; dot(co, '#4ade80', tx, ty, card.h * .35, .5 + .2 * Math.sin(t * 9)); co.globalCompositeOperation = 'source-over'; }
          // la pluie d'argent
          if (verdict.rain > 0) { verdict.rain -= dt; const r = verdict.rate * dt; for (let i = Math.floor(r) + (Math.random() < r % 1 ? 1 : 0); i > 0; i--) money(rnd(card.x - card.h * .8, card.x + card.w + card.h * .8), card.y - card.h * rnd(1.2, 1.7), Math.random() < .4 ? 1 : 0); }
        }
        coins.step(dt);
        coins.each((m, k) => { m.r += m.spin * dt * .3; m.flip += m.fs * dt; drawMoney(m, clamp((1 - k) * 5)); });
        // l'étiquette du gain (ou de la perte) au bout de la courbe, au-dessus du coin de la carte
        labels.run(dt, (l, k) => {
          const s = k < .12 ? outBack(k / .12) : 1, a = k > .8 ? (1 - k) / .2 : 1, x = card.x + card.w - card.h * .3, y = card.y - card.h * .32;
          co.save(); co.globalAlpha = a; co.translate(x, y); co.scale(s, s);
          co.font = `800 ${Math.round(card.h * .26)}px ui-monospace, Menlo, monospace`; co.textAlign = 'center'; co.textBaseline = 'middle';
          const tw = co.measureText(l.s).width + card.h * .2;
          co.fillStyle = l.up ? '#14532d' : '#7f1d1d'; roundRect(co, -tw / 2, -card.h * .18, tw, card.h * .36, card.h * .08); co.fill();
          co.strokeStyle = l.up ? '#4ade80' : '#f87171'; co.lineWidth = 1.5; co.stroke();
          co.fillStyle = l.up ? '#bbf7d0' : '#fecaca'; co.fillText(l.s, 0, card.h * .01);
          co.restore();
        });
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) build = 0; },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        const up = p >= .25, crash = !p;
        col = up ? GREEN : RED;
        if (el) el.classList.add(up ? 'stonk-up' : 'stonk-down');
        const y1 = crash ? 1.25 : p < .25 ? hy + .12 : p >= 1 ? -.08 : clamp(hy - (.12 + .5 * p), .1, .9);
        verdict = { at: t, dur: crash ? .7 : p >= 1 ? .45 : .8, x0: hx, x1: p >= 1 ? .86 : .97, y0: hy, y1, p, rate: (14 + 10 * asc) * q, rain: 1.6 + .6 * asc };
        verdict.end = t + verdict.dur;
        const pct = crash ? -(70 + rnd(25)) : p < .25 ? -rnd(1, 4) : p >= 1 ? 420 * Math.pow(2.4, asc) : 4 + 160 * p * p + rnd(-1, 1) * 2;
        const s = `${pct > 0 ? '▲ +' : '▼ '}${Math.abs(pct) >= 1000 ? Math.round(pct).toLocaleString('en-US') : pct.toFixed(1)}%`;
        labels.add({ delay: verdict.dur * .7, life: 2.6 + p + asc * .5, s, up });
        if (crash) { flashes.add({ life: .6, x: X(.97), y: h * .95 }); redAt = t + .45; }
      },
    };
  };

  // ♞ Chess (2026-10-28, idée de casmicgraything) — des pièces d'échecs (silhouettes Staunton dessinées ici) attendent
  // de chaque côté de la carte, les blancs à gauche, les noirs à droite. À chaque chiffre qui se pose, une pièce joue
  // (blancs et noirs à tour de rôle) et vient se poser sur le bord de la carte au-dessus de lui, chacune à sa façon :
  // le pion fait un pas, le cavalier saute haut en tournant, la tour glisse au ras, le fou file en diagonale, le roi
  // avance posément ; « toc » à l'arrivée (petit nuage de poussière). Avant le dernier chiffre, la pièce suivante se
  // soulève et tremble. Révélation : tirage raté, la dernière pièce noire posée se couche (elle abandonne) ; sinon une
  // ola de petits sauts, des reflets dès Epic ; dès Mythic, les deux dames foncent l'une vers l'autre au-dessus de la
  // carte, s'entrechoquent (éclair, étincelles), repartent en tournoyant, toutes les pièces sautent et « Checkmate! »
  // s'affiche en haut (traduit) ; au-delà de Mythic, une pluie de petites cases noires et blanches.
  SCENES.chess = env => {
    const { co, card, q, dark } = env;
    const later = [], dust = particles(), sparks = particles(), squares = particles(), words = timed(), bursts = timed();
    let t = 0, build = 0, turn = 0, wave = -9, wavePow = 0, glintOn = 0;
    const after = (d, fn) => later.push({ at: t + d, fn });
    const H = () => card.h, PS = () => card.h * .56; // hauteur d'une pièce
    const mk = (kind, side, j) => ({ kind, side, j, slot: -1, x: 0, y: 0, rot: 0, move: null, fall: 0, hop: 0, hopAt: -9 });
    const W = ['pawn', 'knight', 'rook', 'bishop'].map((k, j) => mk(k, 'w', j)), B = ['pawn', 'bishop', 'king', 'knight'].map((k, j) => mk(k, 'b', j));
    const queens = [];
    // Silhouette d'une pièce, base en (0, 0), hauteur s vers le haut ; dir : sens du cavalier.
    const shape = (kind, s, dir) => {
      const c = co, m = (x, y) => c.moveTo(x * s * dir, -y * s), l = (x, y) => c.lineTo(x * s * dir, -y * s), qd = (cx, cy, x, y) => c.quadraticCurveTo(cx * s * dir, -cy * s, x * s * dir, -y * s);
      c.beginPath();
      // le pied, commun à toutes
      m(-.34, 0); l(.34, 0); l(.34, .07); qd(.3, .13, .22, .14); l(-.22, .14); qd(-.3, .13, -.34, .07); c.closePath();
      if (kind === 'pawn') { m(-.2, .14); qd(-.1, .3, -.09, .5); l(.09, .5); qd(.1, .3, .2, .14); c.closePath(); m(-.17, .5); l(.17, .5); l(.17, .55); l(-.17, .55); c.closePath(); c.moveTo(.15 * s, -.68 * s); c.arc(0, -.68 * s, .15 * s, 0, TAU); }
      else if (kind === 'rook') { m(-.2, .14); l(-.17, .72); l(-.25, .74); l(-.25, .95); l(-.15, .95); l(-.15, .87); l(-.05, .87); l(-.05, .95); l(.05, .95); l(.05, .87); l(.15, .87); l(.15, .95); l(.25, .95); l(.25, .74); l(.17, .72); l(.2, .14); c.closePath(); }
      else if (kind === 'bishop') { m(-.2, .14); qd(-.1, .3, -.09, .52); l(.09, .52); qd(.1, .3, .2, .14); c.closePath(); m(-.16, .52); l(.16, .52); l(.16, .57); l(-.16, .57); c.closePath(); m(0, .97); qd(.22, .82, .13, .6); l(-.13, .6); qd(-.22, .82, 0, .97); c.closePath(); c.moveTo(.06 * s, -1.03 * s); c.arc(0, -1.03 * s, .06 * s, 0, TAU); }
      else if (kind === 'knight') { m(-.24, .14); l(-.2, .5); qd(-.24, .8, -.02, .93); l(.02, 1.04); l(.08, .92); qd(.24, .82, .33, .6); l(.33, .5); qd(.24, .44, .12, .5); qd(.06, .42, .22, .14); c.closePath(); }
      else if (kind === 'king' || kind === 'queen') {
        m(-.21, .14); qd(-.1, .32, -.1, .58); l(.1, .58); qd(.1, .32, .21, .14); c.closePath(); m(-.19, .58); l(.19, .58); l(.19, .63); l(-.19, .63); c.closePath();
        if (kind === 'king') { m(-.13, .63); l(-.2, .86); l(.2, .86); l(.13, .63); c.closePath(); m(-.03, .86); l(-.03, .93); l(-.1, .93); l(-.1, .99); l(-.03, .99); l(-.03, 1.08); l(.03, 1.08); l(.03, .99); l(.1, .99); l(.1, .93); l(.03, .93); l(.03, .86); c.closePath(); }
        else { m(-.13, .63); l(-.24, .9); l(-.12, .8); l(-.06, .95); l(0, .82); l(.06, .95); l(.12, .8); l(.24, .9); l(.13, .63); c.closePath(); for (const x of [-.24, -.06, .06, .24]) { c.moveTo((x * dir + .04) * s, -(x === -.24 || x === .24 ? .93 : .98) * s); c.arc(x * s * dir, -(x === -.24 || x === .24 ? .93 : .98) * s, .04 * s, 0, TAU); } c.moveTo(.05 * s, -1.02 * s); c.arc(0, -1.02 * s, .05 * s, 0, TAU); }
      }
    };
    const draw = (p, x, y, s, rot, a, glint) => {
      if (a <= .01) return;
      const white = p.side === 'w', dir = white ? 1 : -1;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      shape(p.kind, s, dir);
      const g = co.createLinearGradient(-s * .3, 0, s * .3, 0);
      if (white) { g.addColorStop(0, '#fffdf7'); g.addColorStop(.6, '#efe6d2'); g.addColorStop(1, '#c9b892'); } else { g.addColorStop(0, '#57534e'); g.addColorStop(.4, '#292524'); g.addColorStop(1, '#0c0a09'); }
      co.fillStyle = g; co.fill('nonzero'); co.lineJoin = 'round'; co.lineWidth = Math.max(1, s * .045); co.strokeStyle = white ? '#3f2a14' : (dark ? '#a8a29e' : '#1c1917'); co.stroke();
      if (glint > 0) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#fff7d6', -s * .08, -s * .7, s * .22 * glint, .8 * glint); co.globalCompositeOperation = 'source-over'; }
      co.restore();
    };
    // où se tient une pièce au repos : en file de chaque côté de la carte (posée au niveau du bas de la carte), ou sur
    // le bord du haut de la carte, au-dessus de son chiffre
    const home = (p, S) => {
      if (p.slot >= 0) { const s = S.find(x => x.i === p.slot); if (s) return { x: s.x, y: card.y }; }
      const list = p.side === 'w' ? W : B, k = list.filter(x => x.slot < 0 && !x.move).indexOf(p);
      const off = card.h * (.34 + .4 * Math.max(0, k));
      // sur un téléphone, la place manque à côté de la carte : seules les premières pièces de la file se montrent
      return { x: p.side === 'w' ? card.x - off : card.x + card.w + off, y: card.y + card.h, hidden: k >= room(p.side) };
    };
    const room = side => { // combien de pièces tiennent entre la carte et le bord de l'écran
      const r = env.el.getBoundingClientRect(), vw = root.innerWidth || 1e4, free = side === 'w' ? r.left : vw - r.right;
      return Math.max(1, Math.min(4, Math.floor((free - card.h * .16) / (card.h * .4))));
    };
    const thud = (x, y, n) => { for (let i = Math.round(n * q) + 2; i > 0; i--) dust.add({ x: x + rnd(-.25, .25) * PS(), y, vx: rnd(-40, 40), vy: -rnd(5, 30), drag: 3, max: rnd(.35, .6), size: PS() * rnd(.08, .14) }); };
    // le style de déplacement de chaque pièce : durée, hauteur du saut, rotation
    const STYLE = { pawn: [.32, .35, 0], knight: [.5, 1.3, 1], rook: [.34, .12, 0], bishop: [.4, .7, 0], king: [.55, .4, 0] };
    const play = (s, last) => {
      const list = turn % 2 ? B : W;
      let p = list.find(x => x.slot < 0 && !x.move) || (turn % 2 ? W : B).find(x => x.slot < 0 && !x.move);
      turn++;
      if (!p) return;
      const S = slotsA(env), from = p.qx == null ? home(p, S) : { x: p.qx, y: home(p, S).y }, [dur, hh, spin] = STYLE[p.kind];
      p.slot = s.i;
      p.move = { from, at: t, dur: dur * (last ? 1.1 : 1), hh: card.h * hh * (last ? 1.3 : 1), spin: spin * (p.side === 'w' ? 1 : -1) };
    };
    return {
      frame(tt, dt) {
        t = tt;
        for (let i = later.length - 1; i >= 0; i--) if (later[i].at <= t) later.splice(i, 1)[0].fn();
        const S = slotsA(env), next = S.find(s => !s.on && !s.gone);
        const s = PS();
        // poussière derrière les pièces
        dust.step(dt);
        dust.each((d, k) => dot(co, dark ? '#d6d3d1' : '#78716c', d.x, d.y, d.size * (1 + k), (1 - k) * .45));
        const all = W.concat(B);
        // ombres sous les pièces posées sur la carte
        for (const p of all) { if (p.slot < 0 || p.move) continue; const hm = home(p, S); co.globalAlpha = .3; co.fillStyle = '#000'; co.beginPath(); co.ellipse(hm.x, hm.y, s * .36, s * .06, 0, 0, TAU); co.fill(); }
        co.globalAlpha = 1;
        all.forEach((p, n) => {
          let hm = home(p, S), x = hm.x, y = hm.y, rot = 0;
          if (p.slot < 0 && !p.move) { p.qx = p.qx == null ? x : lerp(p.qx, x, Math.min(1, dt * 8)); x = p.qx; } // la file se resserre en glissant
          p.qa = clamp((p.qa == null ? (hm.hidden ? 0 : 1) : p.qa) + (hm.hidden ? -dt : dt) * 4);
          if (p.move) {
            const mv = p.move, k = clamp((t - mv.at) / mv.dur), e = p.kind === 'rook' ? outCubic(k) : k;
            x = lerp(mv.from.x, hm.x, e); y = lerp(mv.from.y, hm.y, e) - Math.sin(k * Math.PI) * mv.hh;
            rot = mv.spin * TAU * outCubic(k) + (p.kind === 'pawn' || p.kind === 'king' ? Math.sin(k * Math.PI) * .12 * (p.side === 'w' ? 1 : -1) : 0);
            if (k >= 1) { p.move = null; thud(hm.x, hm.y, 4); p.hop = .5; p.hopAt = t; }
          }
          // petit rebond raide à l'arrivée, sauts de la révélation
          const hk = (t - p.hopAt) / .28;
          if (hk >= 0 && hk < 1) y -= Math.sin(hk * Math.PI) * card.h * .06 * p.hop;
          const wk = (t - wave - n * .07) / .36;
          if (p.slot >= 0 && wk > 0 && wk < 1) y -= Math.sin(wk * Math.PI) * card.h * .22 * wavePow;
          // la pièce suivante se soulève et tremble avant le dernier chiffre
          if (build && !p.move && p.slot < 0 && p === ((turn % 2 ? B : W).find(x => x.slot < 0 && !x.move))) { y -= card.h * .12; rot += Math.sin(t * 40) * .06; }
          if (p.fall) { const fk = outCubic(clamp((t - p.fall) / .5)); rot += (p.side === 'w' ? -1 : 1) * Math.PI / 2 * fk; if (fk > .9 && !p.fell) { p.fell = 1; thud(x + (p.side === 'w' ? -1 : 1) * s * .5, y, 6); } }
          draw(p, x, y, s, rot, p.qa, glintOn ? clamp(Math.sin((t - glintOn) * 3 + n)) : 0);
        });
        // les dames (Mythic) : elles foncent l'une vers l'autre, se heurtent, repartent en tournoyant
        for (const qn of queens) {
          const k = (t - qn.at) / .5, cx = card.x + card.w / 2, y0 = card.y - card.h * .95;
          let x, y, rot;
          if (k < 0) continue;
          if (k < 1) { x = lerp(qn.x0, cx - qn.dir * s * .32, k * k); y = y0 - Math.sin(k * Math.PI) * card.h * .15; rot = qn.dir * .25 * k; }
          else { const u = (t - qn.at - .5); x = cx - qn.dir * s * .32 - qn.dir * u * card.h * 3.2; y = y0 - u * card.h * 2.6 + u * u * card.h * 3.5; rot = qn.dir * (.25 - u * 9); }
          draw(qn, x, y, s * 1.15, rot, clamp(1.6 - (t - qn.at - .5)), 0);
        }
        bursts.run(dt, (b, k) => {
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          dot(co, '#fff7d6', b.x, b.y, card.h * (.4 + 1.1 * outCubic(k)), (1 - k) * (dark ? 1 : .8));
          for (let i = 0; i < 10; i++) { const an = i * TAU / 10 + .3, r0 = card.h * (.15 + .9 * outCubic(k)), r1 = r0 + card.h * .35 * (1 - k); line(co, dark ? '#fde68a' : '#d97706', b.x + Math.cos(an) * r0, b.y + Math.sin(an) * r0, b.x + Math.cos(an) * r1, b.y + Math.sin(an) * r1, 2, 1 - k); }
          co.globalCompositeOperation = 'source-over';
        });
        sparks.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.each((p, k) => dot(co, dark ? '#fde68a' : '#f59e0b', p.x, p.y, 3, 1 - k));
        co.globalCompositeOperation = 'source-over';
        squares.step(dt);
        squares.each((p, k) => { co.save(); co.globalAlpha = clamp((1 - k) * 4); co.translate(p.x, p.y); co.rotate(p.r + p.life * p.spin); co.fillStyle = p.c; co.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); co.strokeStyle = '#78716c'; co.lineWidth = .8; co.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size); co.restore(); });
        words.run(dt, (wd, k) => { const sc = k < .14 ? outBack(k / .14) : 1; bWord(co, wd.s, card.x + card.w / 2, card.y - card.h * 1.4, card.h * .4 * sc, '#fde68a', '#3f2a14', k > .82 ? (1 - k) / .18 : 1, -.04, "900 SIZEpx Georgia, 'Times New Roman', serif"); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.last) build = 0;
        if (o.ghost) return;
        const s = bSlotAt(env, p); if (!s) return;
        const i = [...env.el.querySelectorAll('.slot')].indexOf(s);
        play({ i }, o.last);
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { // abandon : la dernière pièce noire posée se couche
          const list = B.filter(x => x.slot >= 0), k = list[list.length - 1] || W.filter(x => x.slot >= 0).pop();
          if (k) k.fall = t + .2;
          return;
        }
        wave = t + .05; wavePow = .5 + .6 * p;
        if (p >= .62) glintOn = t;
        if (p < 1) return;
        wave = t + .55; wavePow = 1.2;
        const s = PS(), y = card.y - card.h * .95;
        queens.push(Object.assign(mk('queen', 'w', 0), { at: t, x0: card.x - card.h * 2, dir: 1 }), Object.assign(mk('queen', 'b', 0), { at: t, x0: card.x + card.w + card.h * 2, dir: -1 }));
        after(.5, () => {
          const x = card.x + card.w / 2;
          bursts.add({ life: .55, x, y: y - s * .5 });
          for (let i = Math.round((26 + 14 * asc) * q); i > 0; i--) { const an = rnd(TAU), v = rnd(80, 260); sparks.add({ x, y: y - s * .5, vx: Math.cos(an) * v, vy: Math.sin(an) * v, g: card.h * 6, drag: 1, max: rnd(.5, 1) }); }
        });
        words.add({ delay: .62, life: 2.6 + .5 * asc, s: root.RNGI18n ? root.RNGI18n.t('Checkmate!') : 'Checkmate!' });
        if (asc) for (let i = Math.round((20 + 16 * asc) * q); i > 0; i--) squares.add({ x: rnd(card.x - card.h, card.x + card.w + card.h), y: card.y - card.h * rnd(1.3, 2), vx: rnd(-20, 20), vy: rnd(10, 60), g: card.h * 2, drag: .8, max: rnd(1.6, 2.6), size: card.h * rnd(.08, .13), r: rnd(TAU), spin: rnd(-5, 5), c: i % 2 ? '#fafaf9' : '#1c1917' });
      },
    };
  };

  // 🌦️ Weather (2026-10-28, idée de casmicgraything) — une fenêtre de ciel par chiffre (les cases), du pire au meilleur
  // temps : orage, pluie, vent, nuages, soleil, arc-en-ciel. La scène peint les ciels dans la carte, derrière les
  // chiffres : brouillard qui tourne tant que le chiffre n'est pas posé, puis son temps arrive d'un coup (un éclair
  // frappe, l'averse tombe, une rafale passe, les nuages entrent, le soleil se lève) ; au sixième, un arc-en-ciel se
  // trace d'un bout à l'autre de la carte et déborde autour d'elle. Révélation : tirage raté, un ciel gris roule sur
  // toutes les fenêtres et il pleut partout un moment ; sinon l'arc-en-ciel s'avive (un second arc dès Epic) ; dès
  // Mythic, tous les temps éclatent en même temps (éclairs partout, averse, rafales, soleil qui clignote, .wth-chaos
  // fait trembler les fenêtres), puis tout se calme sous un double arc-en-ciel et des étincelles.
  SCENES.weather = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const el = env.el;
    if (el) el.classList.remove('wth-chaos');
    const B0 = (card.w - w) / 2, cw0 = card.w;
    const SKY = [['#2e2a4f', '#16142b'], ['#3d4a5f', '#2c3748'], ['#4e7487', '#36586b'], ['#8094aa', '#a9b8c8'], ['#0ea5e9', '#7dd3fc'], ['#38bdf8', '#bae6fd']];
    const BOW = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7'];
    const st = new Map(), rain = particles(), gusts = particles(), sparks = particles(), bolts = timed(), flashes = timed(), emitRain = emitter(), emitGust = emitter();
    let t = 0, build = 0, bow = 0, bowAt = -9, bow2 = 0, boost = 0, chaos = 0, gloom = 0, gloomAt = -9;
    const later = [], after = (d, fn) => later.push({ at: t + d, fn }), outBolts = [];
    const sx = () => w / (card.w - 2 * B0); // la toile intérieure est étirée quand la carte rétrécit
    const inX = x => (x - card.x - B0) * sx(), inY = y => y - card.y - B0;
    const cloud = (c, x, y, r, col, a) => { c.globalAlpha = a; c.fillStyle = col; c.beginPath(); c.arc(x - r * .9, y + r * .2, r * .55, 0, TAU); c.arc(x, y - r * .1, r * .8, 0, TAU); c.arc(x + r * .9, y + r * .25, r * .5, 0, TAU); c.rect(x - r * .9, y + r * .2, r * 1.8, r * .55); c.fill(); };
    const strike = (pn, big) => { bolts.add({ life: big ? .3 : .22, pn, seed: rnd(1e3), big }); flashes.add({ life: .25, pn }); };
    // l'arc-en-ciel : une demi-ellipse posée sous le bas de la carte, juste plus large qu'elle (ses pieds sortent de
    // chaque côté), son sommet en haut de la carte
    const rainbow = (c, cx, cy, rx, ry, band, sweep, a) => {
      c.lineWidth = band; c.lineCap = 'butt';
      BOW.forEach((col, i) => { c.globalAlpha = a; c.strokeStyle = col; c.beginPath(); c.ellipse(cx, cy, Math.max(1, rx - i * band), Math.max(1, ry - i * band), 0, Math.PI, Math.PI + Math.PI * clamp(sweep)); c.stroke(); });
    };
    return {
      frame(tt, dt) {
        t = tt;
        for (let i = later.length - 1; i >= 0; i--) if (later[i].at <= t) later.splice(i, 1)[0].fn();
        const S = slotsA(env).filter(s => !s.gone), k6 = sx();
        // les fenêtres
        const panes = S.map(s => ({ s, kind: Math.min(5, s.i), x: inX(s.x - s.w / 2), y: inY(s.top), pw: s.w * k6, ph: s.bottom - s.top }));
        for (const P of panes) {
          const { s, kind, x, y, pw, ph } = P;
          let e = st.get(s.i);
          if (s.on && !e) {
            e = { at: t, clouds: [0, 1].map(j => ({ u: rnd(), v: .2 + .3 * j, r: rnd(.2, .28), sp: rnd(.04, .08) * (j ? -1 : 1) })) };
            st.set(s.i, e);
            if (kind === 0) strike(s.i, 1);
            if (kind === 1) for (let n = 0; n < 14; n++) rain.add({ pn: s.i, x: rnd(pw), y: rnd(-ph * .3, ph), vx: -ph * .5, vy: ph * 3.2, max: rnd(.5, .9) });
            if (kind === 2) for (let n = 0; n < 4; n++) gusts.add({ pn: s.i, x: -rnd(pw), y: rnd(.15, .85) * ph, vx: pw * rnd(2.5, 4), vy: 0, max: .7, len: rnd(.4, .7) });
            if (kind >= 5 && !bow) { bow = 1; bowAt = t; }
          }
          const arrive = e ? clamp((t - e.at) / .35) : 0, a0 = s.ghost ? .35 : 1;
          ci.save(); roundRect(ci, x, y, pw, ph, Math.min(pw, ph) * .18); ci.clip();
          // brouillard (pas encore de temps)
          if (arrive < 1) {
            const g = ci.createLinearGradient(0, y, 0, y + ph); g.addColorStop(0, '#64748b'); g.addColorStop(1, '#94a3b8');
            ci.globalAlpha = a0; ci.fillStyle = g; ci.fillRect(x, y, pw, ph);
            const spin = 1 + 2.5 * (build && !s.on ? 1 : 0);
            for (let j = 0; j < 3; j++) dot(ci, '#e2e8f0', x + pw * (.5 + .45 * Math.sin(t * .9 * spin + j * 2.1 + s.i)), y + ph * (.3 + .25 * j + .1 * Math.cos(t * 1.3 * spin + j)), pw * .55, .35 * a0);
          }
          if (arrive > 0) {
            ci.globalAlpha = a0 * arrive;
            const sk = SKY[kind], g = ci.createLinearGradient(0, y, 0, y + ph); g.addColorStop(0, sk[0]); g.addColorStop(1, sk[1]);
            ci.fillStyle = g; ci.fillRect(x, y, pw, ph);
            const A = a0 * arrive;
            if (kind === 0 && !chaos && Math.random() < dt * .7) strike(s.i, 0);
            if (kind === 1 || chaos) for (let n = emitRain((chaos ? 90 : 40) * q * (kind === 1 || chaos ? 1 : 0) / Math.max(1, chaos ? panes.length : 1), dt); n > 0; n--) rain.add({ pn: s.i, x: rnd(pw * 1.3), y: -4, vx: -ph * .5, vy: ph * rnd(2.8, 3.6), max: rnd(.4, .6) });
            if ((kind === 2 || chaos) && emitGust(chaos ? 6 : 2.2, dt)) gusts.add({ pn: s.i, x: -pw * .6, y: rnd(.15, .85) * ph, vx: pw * rnd(2.5, 4), vy: 0, max: .7, len: rnd(.4, .7) });
            if (kind === 3 || chaos) for (const c of e.clouds) { const u = (((c.u + t * c.sp) % 1.6) + 1.6) % 1.6 - .3; cloud(ci, x + u * pw, y + c.v * ph, c.r * pw * 1.4, kind === 3 ? '#f1f5f9' : '#cbd5e1', A * (kind === 3 ? .9 : .7)); }
            if (kind === 4 || kind === 5 || chaos) { // le soleil (et ses rayons qui tournent)
              const sx0 = x + pw * .74, sy0 = y + ph * .2, rise = kind === 4 ? outBack(clamp((t - e.at) / .5)) : 1, r = pw * .2 * rise, blink = chaos ? (Math.sin(t * 30 + s.i) > 0 ? 1 : .4) : 1;
              if (kind === 4 || chaos) {
                ci.globalCompositeOperation = 'lighter'; dot(ci, '#fde047', sx0, sy0, r * 3.2 * (1 + boost * .6), .55 * A * blink); ci.globalCompositeOperation = 'source-over';
                for (let j = 0; j < 8; j++) { const an = t * .8 + j * TAU / 8; line(ci, '#fde047', sx0 + Math.cos(an) * r * 1.3, sy0 + Math.sin(an) * r * 1.3, sx0 + Math.cos(an) * r * (1.9 + boost), sy0 + Math.sin(an) * r * (1.9 + boost), Math.max(1, pw * .04), A * .9 * blink); }
                ci.globalAlpha = A; ci.fillStyle = '#fde047'; ci.beginPath(); ci.arc(sx0, sy0, Math.max(.1, r), 0, TAU); ci.fill();
              }
            }
          }
          ci.restore();
          P.e = e;
        }
        const byI = new Map(panes.map(P => [P.s.i, P]));
        // pluie, rafales, éclairs et flashs, chacun dans sa fenêtre
        rain.step(dt); gusts.step(dt);
        const inPane = (pn, fn) => { const P = byI.get(pn); if (!P) return; ci.save(); roundRect(ci, P.x, P.y, P.pw, P.ph, 3); ci.clip(); fn(P); ci.restore(); };
        rain.each(r => inPane(r.pn, P => line(ci, '#bfdbfe', P.x + r.x, P.y + r.y, P.x + r.x + P.ph * .05, P.y + r.y - P.ph * .2, 1.2, P.s.ghost ? .25 : .7)));
        gusts.each((g, k) => inPane(g.pn, P => { ci.globalAlpha = Math.sin(k * Math.PI) * (P.s.ghost ? .3 : .85); ci.strokeStyle = '#f8fafc'; ci.lineWidth = 1.3; ci.lineCap = 'round'; ci.beginPath(); const x0 = P.x + g.x, y0 = P.y + g.y, L = P.pw * g.len; ci.moveTo(x0 - L, y0); ci.quadraticCurveTo(x0 - L * .3, y0 - P.ph * .03, x0, y0); ci.arc(x0, y0 - P.ph * .05, P.ph * .05, Math.PI / 2, -Math.PI / 2 + .4, true); ci.stroke(); }));
        flashes.run(dt, (f, k) => inPane(f.pn, P => { ci.globalAlpha = (1 - k) * .55; ci.fillStyle = '#ede9fe'; ci.fillRect(P.x, P.y, P.pw, P.ph); }));
        bolts.run(dt, (b, k) => inPane(b.pn, P => { const a = k < .3 ? 1 : (1 - k) / .7, xs = P.x + P.pw * (.35 + .3 * Math.sin(b.seed)); bolt(ci, xs, P.y, xs + P.pw * .15 * Math.cos(b.seed), P.y + P.ph * (b.big ? .95 : .7), P.pw * .25, ['#a78bfa', '#e9d5ff', '#ffffff'], a * (P.s.ghost ? .3 : 1), Math.max(.6, P.pw / 40)); }));
        ci.globalAlpha = 1;
        // ciel gris du tirage raté : il roule par-dessus toutes les fenêtres, derrière les chiffres
        if (gloom > 0) {
          const k = clamp((t - gloomAt) / .6), out = clamp((t - gloomAt - 3) / 1.2), a = k * (1 - out);
          if (out >= 1) gloom = 0;
          ci.globalAlpha = .5 * a; ci.fillStyle = '#475569'; ci.fillRect(0, 0, w, h);
          for (let j = 0; j < 5; j++) cloud(ci, lerp(-w * .3, w * (.1 + .2 * j), k) + Math.sin(t + j) * 4, h * (.12 + .08 * (j % 2)), h * .35, '#94a3b8', .85 * a);
          if (a > .2) for (let n = emitRain(60 * q, dt); n > 0; n--) rain.add({ pn: -1, x: rnd(w), y: -4, vx: -h * .5, vy: h * 3, max: .5 });
          rain.each(r => { if (r.pn === -1) line(ci, '#cbd5e1', r.x, r.y, r.x + h * .05, r.y - h * .2, 1.2, .6 * a); });
          ci.globalAlpha = 1;
        }
        // l'arc-en-ciel, d'un bout à l'autre de la carte : dans la carte derrière les chiffres, et autour d'elle
        if (bow > 0) {
          const sweep = outCubic((t - bowAt) / .8), ccx = card.x + card.w / 2, band = card.h * .06, rx = card.w * .56, ry = card.h * .94, ccy = card.y + card.h * 1.04, fade = gloom ? .35 : 1;
          const a = Math.min(1, .5 + .35 * boost) * fade, o2 = band * 8;
          ci.save(); ci.translate(-(card.x + B0) * k6, -(card.y + B0)); ci.scale(k6, 1); rainbow(ci, ccx, ccy, rx, ry, band, sweep, a * .5); if (bow2) rainbow(ci, ccx, ccy, rx + o2, ry + o2, band * .8, sweep, a * .35 * bow2); ci.restore();
          behind(env, () => { rainbow(co, ccx, ccy, rx, ry, band, sweep, a * (dark ? .6 : .75)); if (bow2) rainbow(co, ccx, ccy, rx + o2, ry + o2, band * .8, sweep, a * (dark ? .35 : .45) * bow2); });
          co.globalAlpha = 1;
        }
        boost = Math.max(0, boost - dt * .5);
        // étincelles (Mythic, après le calme)
        sparks.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.each((p, k) => { const tw = .5 + .5 * Math.sin(t * 14 + p.seed); dot(co, p.c, p.x, p.y, 4 + 3 * tw, (1 - k) * tw); });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
        // pendant le chaos, des éclairs autour de la carte aussi
        if (chaos && Math.random() < dt * 6) { const x0 = rnd(card.x - card.h * .8, card.x + card.w + card.h * .8); outBolts.push({ x0, at: t, seed: rnd(1e3) }); }
        for (let i = outBolts.length - 1; i >= 0; i--) { const b = outBolts[i], k = (t - b.at) / .25; if (k > 1) { outBolts.splice(i, 1); continue; } behind(env, () => bolt(co, b.x0, card.y - card.h * 1.2, b.x0 + card.h * .3 * Math.sin(b.seed), card.y - card.h * .05, card.h * .3, dark ? ['#a78bfa', '#e9d5ff', '#ffffff'] : ['#c4b5fd', '#7c3aed', '#4c1d95'], 1 - k, 1.1)); }
        co.globalAlpha = 1;
      },
      lock(p, o) { if (o.last) build = 0; },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { gloom = 1; gloomAt = t; return; }
        boost = .6 + .8 * p;
        if (!bow) { bow = 1; bowAt = t; } // nombre court sans sixième fenêtre : l'arc-en-ciel vient quand même
        if (p >= .62) bow2 = 1;
        if (p < 1) return;
        // Mythic et plus : tous les temps d'un coup, les fenêtres tremblent, puis le calme
        chaos = 1; if (el) el.classList.add('wth-chaos');
        const S = slotsA(env).filter(s => !s.gone);
        S.forEach((s, j) => { strike(s.i, 1); later.push({ at: t + .35 + j * .07, fn: () => strike(s.i, 1) }); if (!st.has(s.i)) st.set(s.i, { at: t, clouds: [{ u: .2, v: .25, r: .24, sp: .07 }, { u: .9, v: .5, r: .22, sp: -.06 }] }); });
        after(1.25 + .3 * asc, () => {
          chaos = 0; if (el) el.classList.remove('wth-chaos');
          boost = 1.6; bow2 = 1; bowAt = t - .2;
          for (let n = Math.round((24 + 14 * asc) * q); n > 0; n--) sparks.add({ x: rnd(card.x - card.h * .6, card.x + card.w + card.h * .6), y: card.y + rnd(-1.1, .2) * card.h, vx: rnd(-10, 10), vy: rnd(-25, -5), max: rnd(1.2, 2.2), seed: rnd(TAU), c: pick(BOW) });
        });
      },
    };
  };

  // ==== fin des skins du 2026-10-28 (costoroll, casmicgraything) ====

  // ==== Skins du 2026-10-28, lot C ====
  // Ninja, Scroll of Alchemy, Window Cleaner et Firework : idées de joueurs acceptées par Sacha. Ces scènes suivent les
  // cases (slotsA) ; le calque intérieur (ci) garde sa taille de départ alors que la carte rétrécit quand les zéros de
  // tête s'effacent (il est donc étiré en largeur) : inC dessine dedans avec les coordonnées du calque extérieur en
  // compensant cet étirement, pour qu'un rond reste rond et qu'un dessin reste sous son chiffre. cw0 : largeur de départ.
  function inC(env, cw0, fn) {
    const { ci, card, w } = env, b = (cw0 - w) / 2;
    ci.save(); ci.scale(w / Math.max(1, card.w - 2 * b), 1); ci.translate(-(card.x + b), -(card.y + b)); fn(ci); ci.restore();
  }
  // Étincelle à quatre branches (reflet de lame, éclat de vitre propre, paillette).
  function twinkle(c, color, x, y, r, a, rot = 0) {
    if (a <= .01 || r <= .3) return;
    c.save(); c.globalAlpha = Math.min(1, a); c.translate(x, y); c.rotate(rot); c.fillStyle = color;
    c.beginPath();
    for (let i = 0; i < 8; i++) { const an = (i * Math.PI) / 4, rr = i % 2 ? r * .16 : r; c.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); }
    c.closePath(); c.fill(); c.restore();
  }

  // 🥷 Ninja (2026-10-28, idée de casmictechthing ; le bambou tranché au sabre vient de Nero) — à chaque chiffre posé, un
  // trait de lame blanc traverse la tige de bambou en biais (la coupe CSS nj-top / nj-stump est calée dessus, à 16 % de
  // 0,62 s), des feuilles et des copeaux verts volent ; juste après, un shuriken (chiffres de rang pair, coin haut gauche)
  // ou un kunaï (rang impair, coin bas droit) arrive de l'extérieur en tournoyant et se plante dans la bûche avec un
  // tremblement qui s'amortit ; il y reste. Avant le dernier chiffre, un petit ninja passe la tête derrière la carte et
  // un éclat brille sur la dernière tige. Révélation : le ninja surgit derrière le coin haut droit, une bulle donne son
  // kaomoji, un par rareté (NJ_FACE, idée de casmictechthing : Common -_-, Mythic :), Celestial :D, Infinite 8D, Trash
  // :c, Garbage :(, Landwaste >:( ; Garbage et Land waste arrivent par miss()) ; tirage raté, il s'affaisse et un
  // shuriken tombe de la bûche ; dès Epic, il lance trois shuriken sur le bord de la carte ; dès Mythic, il fait un salto,
  // un grand X de lame traverse la carte, une ronde de shuriken se plante tout autour et des feuilles pleuvent.
  const NJ_FACE = { landwaste: '>:(', garbage: ':(', trash: ':c', common: '-_-', uncommon: '._.', rare: 'o_o', epic: ':o', anomaly: 'O_O', mythic: ':)', celestial: ':D', divine: '^o^', godlike: 'B)', infinite: '8D' };
  SCENES.ninja = env => {
    const { co, card, q, dark } = env;
    const H = card.h;
    const stuck = [], flying = [], slashes = timed(), leaves = particles(), chips = particles(), drops = particles(), steam = particles();
    const ninja = { up: 0, to: 0, flip: 0, flipT: -1, mood: 'calm', face: '', bubble: 0, bubbleTo: 0, until: Infinity };
    let now = 0, glint = 0;
    const STEEL = ['#f8fafc', '#94a3b8', '#334155'], GOLD = ['#fef3c7', '#eab308', '#713f12'];
    // centre de la case i (les cases bougent quand la carte se resserre)
    const slotOf = i => slotsA(env).find(s => s.i === i);
    const nearest = x => { let best = null; for (const s of slotsA(env)) if (!best || Math.abs(s.x - x) < Math.abs(best.x - x)) best = s; return best; };
    // où se plante l'arme d'une case : haut gauche (shuriken) ou bas droit (kunaï), dans l'écorce, hors du chiffre
    const spot = (s, kind) => kind === 'star' ? { x: s.x - s.w * .46, y: card.y + H * .13 } : { x: s.x + s.w * .5, y: card.y + H - H * .14 };
    const star = (x, y, r, rot, cols, a = 1) => {
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      const path = () => { co.beginPath(); for (let i = 0; i < 8; i++) { const an = (i * Math.PI) / 4, rr = i % 2 ? r * .3 : r; co.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); } co.closePath(); };
      path(); const g = co.createLinearGradient(-r, -r, r, r); g.addColorStop(0, cols[0]); g.addColorStop(.5, cols[1]); g.addColorStop(1, cols[2]);
      co.fillStyle = g; co.fill(); co.lineJoin = 'round'; co.lineWidth = Math.max(1, r * .1); co.strokeStyle = '#0f172a'; co.stroke();
      co.strokeStyle = 'rgba(255,255,255,.6)'; co.lineWidth = Math.max(.6, r * .06); co.beginPath();
      for (let i = 0; i < 8; i += 2) { const an = (i * Math.PI) / 4; co.moveTo(Math.cos(an) * r * .2, Math.sin(an) * r * .2); co.lineTo(Math.cos(an) * r * .85, Math.sin(an) * r * .85); }
      co.stroke();
      co.fillStyle = '#0f172a'; co.beginPath(); co.arc(0, 0, r * .17, 0, TAU); co.fill();
      co.restore();
    };
    // kunaï : la pointe en (0, 0), tourné vers +x ; L = longueur totale
    const kunai = (L, cols) => {
      const g = co.createLinearGradient(0, -L * .12, 0, L * .12); g.addColorStop(0, cols[0]); g.addColorStop(.5, cols[1]); g.addColorStop(1, cols[2]);
      co.lineJoin = 'round'; co.lineWidth = Math.max(1, L * .025); co.strokeStyle = '#0f172a';
      co.beginPath(); co.moveTo(0, 0); co.quadraticCurveTo(-L * .2, -L * .14, -L * .44, -L * .035); co.lineTo(-L * .44, L * .035); co.quadraticCurveTo(-L * .2, L * .14, 0, 0); co.closePath();
      co.fillStyle = g; co.fill(); co.stroke();
      co.strokeStyle = 'rgba(255,255,255,.65)'; co.lineWidth = Math.max(.6, L * .012); co.beginPath(); co.moveTo(-L * .04, 0); co.lineTo(-L * .4, 0); co.stroke();
      co.fillStyle = '#1f2937'; co.fillRect(-L * .82, -L * .04, L * .38, L * .08); co.strokeStyle = '#0f172a'; co.lineWidth = Math.max(1, L * .02); co.strokeRect(-L * .82, -L * .04, L * .38, L * .08);
      co.strokeStyle = '#dc2626'; co.lineWidth = Math.max(1, L * .025); co.beginPath();
      for (let u = .48; u < .8; u += .07) { co.moveTo(-L * u, -L * .04); co.lineTo(-L * (u + .045), L * .04); }
      co.stroke();
      co.strokeStyle = cols[1]; co.lineWidth = Math.max(1.2, L * .03); co.beginPath(); co.arc(-L * .9, 0, L * .075, 0, TAU); co.stroke();
    };
    // une arme : en vol (k < 1) ou plantée ; e.wob : tremblement qui s'amortit après l'impact
    const weapon = (e, x, y) => {
      const cols = e.gold ? GOLD : e.cols || STEEL, since = now - e.hit, wob = e.hit ? Math.sin(since * 48) * .22 * Math.exp(-since * 7) : 0;
      if (e.kind === 'star') {
        const r = H * e.r;
        if (e.hit) { co.globalAlpha = .35; co.fillStyle = '#1c1208'; co.beginPath(); co.ellipse(x + r * .18, y + r * .22, r * .8, r * .55, 0, 0, TAU); co.fill(); co.globalAlpha = 1; }
        star(x, y, r, e.rot + wob, cols, e.a == null ? 1 : e.a);
      } else {
        const L = H * e.r * 4.6;
        co.save(); co.globalAlpha = e.a == null ? 1 : e.a; co.translate(x, y); co.rotate(e.dir + wob);
        if (e.hit) { co.beginPath(); co.rect(-L * 1.2, -L, L * 1.2 - L * .02, L * 2); co.clip(); co.translate(L * .2, 0); } // la pointe est dans le bois
        kunai(L, cols); co.restore();
      }
    };
    const crack = (x, y, a, sz) => { co.globalAlpha = a * .7; co.strokeStyle = '#2b1a0e'; co.lineWidth = 1.2; co.beginPath(); for (let i = 0; i < 4; i++) { const an = i * 1.7 + .4; co.moveTo(x, y); co.lineTo(x + Math.cos(an) * sz, y + Math.sin(an) * sz * .6); } co.stroke(); co.globalAlpha = 1; };
    const leaf = (l, k) => {
      co.save(); co.globalAlpha = Math.min(1, (1 - k) * 4); co.translate(l.x, l.y); co.rotate(l.rot + l.life * l.spin); co.scale(1, Math.max(.2, Math.abs(Math.cos(l.life * l.flip))));
      co.fillStyle = l.c; co.beginPath(); co.ellipse(0, 0, l.size, l.size * .24, 0, 0, TAU); co.fill();
      co.strokeStyle = 'rgba(20,40,5,.6)'; co.lineWidth = .8; co.beginPath(); co.moveTo(-l.size * .9, 0); co.lineTo(l.size * .9, 0); co.stroke();
      co.restore();
    };
    const LEAF = ['#65a30d', '#84cc16', '#4d7c0f', '#a3e635'];
    const addLeaf = (x, y, vx, vy, extra = {}) => leaves.add({ x, y, vx, vy, g: 140, drag: 2.2, max: rnd(1.1, 1.8), size: H * rnd(.1, .16), rot: rnd(TAU), spin: rnd(-4, 4), flip: rnd(4, 9), c: pick(LEAF), ...extra });
    const throwAt = (kind, tx, ty, from, o = {}) => flying.push({ kind, tx, ty, fx: from.x, fy: from.y, t: -(o.delay || 0), life: o.life || .13, rot: rnd(TAU), dir: Math.atan2(ty - from.y, tx - from.x), r: o.r || (kind === 'star' ? .11 : .12), hit: 0, i: o.i, ex: o.ex, ey: o.ey, gold: o.gold, cols: o.cols });
    // le petit ninja, la tête vue de face ; (x, y) : centre de la tête ; s : rayon
    const drawNinja = (x, y, s, mood, rot) => {
      co.save(); co.globalAlpha = 1; co.translate(x, y); co.rotate(rot);
      co.fillStyle = '#1f2140'; co.beginPath(); co.ellipse(0, s * 1.35, s * .95, s * .7, 0, 0, TAU); co.fill(); // les épaules
      co.beginPath(); co.arc(0, 0, s, 0, TAU); co.fill(); co.strokeStyle = '#0b0c1c'; co.lineWidth = Math.max(1, s * .06); co.stroke();
      co.globalAlpha = .25; co.fillStyle = '#c7d2fe'; co.beginPath(); co.ellipse(-s * .4, -s * .5, s * .28, s * .16, -.6, 0, TAU); co.fill(); co.globalAlpha = 1;
      // le bandeau rouge et ses deux pans qui flottent
      const wave = Math.sin(now * 9) * s * .18;
      co.fillStyle = '#dc2626'; co.fillRect(-s * .98, -s * .52, s * 1.96, s * .26);
      co.strokeStyle = '#dc2626'; co.lineWidth = s * .16; co.lineCap = 'round';
      co.beginPath(); co.moveTo(s * .85, -s * .4); co.quadraticCurveTo(s * 1.4, -s * .6 + wave, s * 1.85, -s * .35 - wave); co.moveTo(s * .85, -s * .38); co.quadraticCurveTo(s * 1.3, -s * .1 - wave, s * 1.75, s * .05 + wave); co.stroke(); co.lineCap = 'butt';
      // la fente du visage et les yeux
      co.fillStyle = '#f5d0a9'; roundRect(co, -s * .72, -s * .2, s * 1.44, s * .5, s * .22); co.fill();
      co.strokeStyle = '#111827'; co.fillStyle = '#111827'; co.lineWidth = Math.max(1.2, s * .1); co.lineCap = 'round';
      const ex = s * .32, ey = s * .05;
      if (mood === 'happy') { for (const sx of [-1, 1]) { co.beginPath(); co.arc(sx * ex, ey + s * .06, s * .14, Math.PI * 1.1, Math.PI * 1.9); co.stroke(); } }
      else if (mood === 'sad') { for (const sx of [-1, 1]) { co.beginPath(); co.moveTo(sx * ex - s * .14, ey + s * .02); co.lineTo(sx * ex + s * .14, ey + s * .02); co.stroke(); } co.beginPath(); co.moveTo(-ex - s * .16, ey - s * .14); co.lineTo(-ex + s * .1, ey - s * .2); co.moveTo(ex + s * .16, ey - s * .14); co.lineTo(ex - s * .1, ey - s * .2); co.stroke(); }
      else if (mood === 'angry') { for (const sx of [-1, 1]) { co.beginPath(); co.arc(sx * ex, ey + s * .04, s * .07, 0, TAU); co.fill(); co.beginPath(); co.moveTo(sx * (ex + s * .17), ey - s * .16); co.lineTo(sx * (ex - s * .12), ey - s * .05); co.stroke(); } }
      else if (mood === 'wow') { for (const sx of [-1, 1]) { co.beginPath(); co.arc(sx * ex, ey, s * .11, 0, TAU); co.stroke(); } }
      else for (const sx of [-1, 1]) { co.beginPath(); co.ellipse(sx * ex, ey, s * .07, s * .1, 0, 0, TAU); co.fill(); }
      co.lineCap = 'butt'; co.restore();
    };
    // les mains qui s'agrippent au bord de la carte : en haut (il sort par le dessus) ou à droite (il sort de côté)
    const hands = (x, y, s, a, side) => { co.globalAlpha = a; co.fillStyle = '#1f2140'; co.strokeStyle = '#0b0c1c'; co.lineWidth = 1; for (const sx of [-1, 1]) { co.beginPath(); if (side) co.ellipse(card.x + card.w - 1, y + sx * s * .8, s * .2, s * .26, 0, 0, TAU); else co.ellipse(x + sx * s * .8, card.y + 1, s * .26, s * .2, 0, 0, TAU); co.fill(); co.stroke(); } co.globalAlpha = 1; };
    // la bulle à côté de la tête, à sa hauteur, la pointe vers elle ; dir : -1 à gauche, 1 à droite
    const bubble = (hx, hy, s, text, k, dir) => {
      const fs = Math.max(11, H * .3), sc = outBack(clamp(k)); if (sc <= .02) return;
      co.save(); co.globalAlpha = 1; co.font = `800 ${Math.round(fs)}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
      const tw = co.measureText(text).width, bw = tw + fs * .9, bh = fs * 1.5, gap = s * .45, e = -dir; // e : le côté de la bulle tourné vers la tête
      co.translate(hx + dir * (s + gap), hy - bh * .1); co.scale(sc, sc); co.translate(dir * bw / 2, 0);
      co.fillStyle = '#ffffff'; co.strokeStyle = '#111827'; co.lineWidth = 2; co.lineJoin = 'round';
      co.beginPath(); co.moveTo(e * (bw / 2 - 2), -bh * .2); co.lineTo(e * (bw / 2 + gap * .9), bh * .12); co.lineTo(e * (bw / 2 - 2), bh * .22); co.closePath(); co.fill(); co.stroke();
      roundRect(co, -bw / 2, -bh / 2, bw, bh, bh * .45); co.fill(); co.stroke();
      co.fillRect(e > 0 ? bw / 2 - 4 : -bw / 2, -bh * .18, 4, bh * .38); // efface le trait à la base de la pointe
      co.fillStyle = '#111827'; co.textAlign = 'center'; co.textBaseline = 'middle'; co.fillText(text, 0, fs * .04);
      co.restore();
    };
    // Où sort le ninja : par le dessus de la carte s'il y a la place sous le menu (téléphone), sinon par la droite
    // (sur ordinateur, la carte est collée au menu et le haut de la scène est hors de l'écran).
    const placeSide = () => { try { const r = env.el.getBoundingClientRect(); return r.top - 56 < H * 1.05 && root.innerWidth - r.right > H * 2.4; } catch (e) { return false; } };
    // la réaction du ninja, commune à reveal et miss
    const react = (tier, p, asc) => {
      ninja.face = NJ_FACE[tier] || '-_-'; ninja.side = placeSide();
      ninja.mood = tier === 'landwaste' ? 'angry' : !p ? 'sad' : p >= 1 ? 'happy' : p >= .6 ? 'wow' : 'calm';
      ninja.to = p ? 1 : .8; ninja.bubbleTo = 1; ninja.bubbleAt = now + (p >= 1 ? .55 : .2); ninja.until = now + 3.6 + 1.2 * p + .6 * asc;
      if (p >= 1) ninja.flipT = now;
    };
    const head = () => { // centre de la tête du ninja et taille, selon sa sortie et son élan
      const s = H * .3;
      if (ninja.side) return { s, x: card.x + card.w - s * 1.2 + ninja.up * s * 2.35, y: card.y + card.h * .45 };
      return { s, x: card.x + card.w - H * .55, y: card.y + s * 1.1 - ninja.up * s * 2.3 };
    };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        const S = slotsA(env);
        // le ninja : monte, redescend après sa réaction ; salto au Mythic
        if (now > ninja.until) { ninja.to = 0; ninja.bubbleTo = 0; }
        ninja.up += (ninja.to - ninja.up) * Math.min(1, dt * (ninja.mood === 'sad' && ninja.to ? 3 : 9));
        if (now >= (ninja.bubbleAt || 0)) ninja.bubble = ninja.bubbleTo ? Math.min(1, ninja.bubble + dt * 4) : Math.max(0, ninja.bubble - dt * 5);
        const hd = head(), s = hd.s, nx = hd.x;
        let ny = hd.y, rot = 0;
        if (ninja.mood === 'angry' && ninja.up > .6 && Math.random() < dt * 9) steam.add({ x: nx + rnd(-.6, .6) * s, y: ny - s * .9, vx: rnd(-15, 15), vy: -rnd(30, 60), drag: .8, g: 0, max: rnd(.7, 1.1), size: H * .06 }); // colère (Land waste)
        if (ninja.flipT >= 0) { const k = (now - ninja.flipT) / .6; if (k < 1) { ny -= Math.sin(k * Math.PI) * H * .9; rot = outCubic(k) * TAU; } }
        if (ninja.up > .02) {
          behind(env, () => drawNinja(nx, ny, s, ninja.mood, rot + (ninja.side ? .18 : 0)));
          if (rot === 0 && ninja.up > .3) hands(nx, ny, s, clamp((ninja.up - .3) * 3), ninja.side);
        }
        // les vapeurs de colère (Land waste)
        steam.step(dt); steam.each((p, k) => dot(co, dark ? '#e2e8f0' : '#64748b', p.x, p.y, p.size * (1 + k * 2), (1 - k) * .6));
        if (ninja.bubble > 0 && ninja.face) bubble(nx, ny, s, ninja.face, ninja.bubble, ninja.side ? 1 : -1);
        // les armes plantées : elles suivent leur case (ou le bord de la carte)
        for (const e of stuck) {
          let x, y;
          if (e.i != null) { const sl = S.find(z => z.i === e.i); if (!sl || sl.gone) continue; const sp = spot(sl, e.kind); x = sp.x; y = sp.y; }
          else { x = card.x + e.ex * card.w; y = card.y + e.ey * card.h; }
          if (e.fall) { e.vy += 900 * dt; e.oy = (e.oy || 0) + e.vy * dt; e.rot += dt * 6; y += e.oy; e.a = clamp(1 - e.oy / (H * 1.5)); if (e.a <= 0) continue; }
          else crack(x, y, 1, H * e.r * 1.5);
          weapon(e, x, y);
        }
        // les armes en vol
        for (let i = flying.length - 1; i >= 0; i--) {
          const f = flying[i]; f.t += dt; if (f.t < 0) continue;
          const k = clamp(f.t / f.life);
          if (k >= 1) {
            flying.splice(i, 1); f.hit = now; f.rot += rnd(-.4, .4); stuck.push(f);
            for (let n = Math.round(5 * q); n > 0; n--) chips.add({ x: f.tx, y: f.ty, vx: -Math.cos(f.dir) * rnd(40, 140) + rnd(-50, 50), vy: -Math.sin(f.dir) * rnd(40, 140) - rnd(20, 80), g: 600, drag: .5, max: rnd(.35, .6), size: rnd(1, 2.2), c: pick(['#ddb07a', '#b27e45', '#6b4423']) });
            continue;
          }
          const x = lerp(f.fx, f.tx, k), y = lerp(f.fy, f.ty, k);
          line(co, dark ? 'rgba(226,232,240,.5)' : 'rgba(51,65,85,.35)', x - Math.cos(f.dir) * H * .5, y - Math.sin(f.dir) * H * .5, x, y, 1.2, 1);
          weapon({ ...f, rot: f.rot + f.t * 30, hit: 0 }, x, y);
        }
        // traits de lame : un croissant blanc qui file d'un bout à l'autre, puis s'efface
        slashes.run(dt, (sl, k) => {
          const grow = clamp(k / .25), fade = k < .25 ? 1 : 1 - (k - .25) / .75, x2 = lerp(sl.x1, sl.x2, grow), y2 = lerp(sl.y1, sl.y2, grow);
          const nx2 = -(sl.y2 - sl.y1), ny2 = sl.x2 - sl.x1, len = Math.hypot(nx2, ny2) || 1, ux = nx2 / len, uy = ny2 / len, mx = (sl.x1 + x2) / 2, my = (sl.y1 + y2) / 2, wd = sl.w * fade;
          co.globalAlpha = fade * .45; co.fillStyle = sl.glow;
          co.beginPath(); co.moveTo(sl.x1, sl.y1); co.quadraticCurveTo(mx + ux * wd * 2.4, my + uy * wd * 2.4, x2, y2); co.quadraticCurveTo(mx - ux * wd * .6, my - uy * wd * .6, sl.x1, sl.y1); co.fill();
          co.globalAlpha = fade; co.fillStyle = '#ffffff';
          co.beginPath(); co.moveTo(sl.x1, sl.y1); co.quadraticCurveTo(mx + ux * wd, my + uy * wd, x2, y2); co.quadraticCurveTo(mx, my, sl.x1, sl.y1); co.fill();
          co.globalAlpha = 1;
        });
        // l'éclat sur la dernière tige, pendant la tension
        if (glint) { const nxt = S.find(z => !z.on && !z.gone); if (nxt) twinkle(co, '#ffffff', nxt.x + nxt.w * .15, nxt.top + H * .12, H * (.12 + .08 * Math.sin(now * 16)), .9, now * 2); }
        leaves.step(dt); chips.step(dt); drops.step(dt);
        leaves.each(leaf);
        chips.each((c, k) => { co.globalAlpha = 1 - k; co.fillStyle = c.c; co.fillRect(c.x, c.y, c.size * 1.8, c.size); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const sl = nearest(p.x); if (!sl) return;
        const bh = (sl.bottom - sl.top) * 1.15, bw = sl.w * .76;
        const y1 = sl.y + bh * .1, y2 = sl.y - bh * .1, ext = sl.w * .55; // la coupe : de 60 % à gauche à 40 % à droite de la tige
        const slope = (y2 - y1) / bw;
        slashes.add({ delay: .085, life: o.ghost ? .25 : .32, x1: sl.x - bw / 2 - ext, y1: y1 - slope * ext, x2: sl.x + bw / 2 + ext, y2: y2 + slope * ext, w: H * (o.last ? .1 : .07), glow: o.ghost ? '#94a3b8' : '#bae6fd' });
        const n = o.ghost ? 1 : o.last ? 5 : 3;
        for (let i = 0; i < n; i++) addLeaf(sl.x + rnd(-.3, .3) * sl.w, sl.y, rnd(-120, 120), -rnd(60, 180), { delay: 0 });
        for (let i = Math.round((o.ghost ? 2 : 6) * q); i > 0; i--) chips.add({ x: sl.x + rnd(-.3, .3) * sl.w, y: sl.y, vx: rnd(-90, 90), vy: -rnd(40, 160), g: 500, drag: .6, max: rnd(.3, .6), size: rnd(1, 2), c: pick(['#84cc16', '#d9f99d', '#4d7c0f']) });
        if (o.last) glint = 0;
        if (o.ghost) return;
        // l'arme : shuriken en haut à gauche ou kunaï en bas à droite, chacun son tour
        const kind = sl.i % 2 ? 'kunai' : 'star', sp = spot(sl, kind);
        const from = kind === 'star' ? { x: sp.x - H * 1.9, y: sp.y - H * 1.5 } : { x: sp.x + H * 2.1, y: sp.y + H * 1.1 };
        throwAt(kind, sp.x, sp.y, from, { delay: .13, i: sl.i, r: o.last ? (kind === 'star' ? .13 : .14) : undefined });
      },
      build() { glint = 1; ninja.to = .42; ninja.mood = 'calm'; ninja.side = placeSide(); },
      miss(tier) { glint = 0; react(tier, 0, 0); this.drop(); },
      // tirage raté : un shuriken se décroche de la bûche et tombe
      drop() { const e = stuck.filter(z => !z.fall).pop(); if (e) { e.fall = 1; e.vy = -60; } },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        glint = 0; react(tier, p, asc);
        if (!p) { this.drop(); return; }
        const hd = head(), from = { x: hd.x, y: hd.y };
        for (let i = Math.round((3 + 8 * p) * q); i > 0; i--) addLeaf(card.x + rnd(0, 1) * card.w, card.y - H * rnd(.2, .8), rnd(-30, 30), rnd(-20, 30));
        if (p >= .6) [[.18, 0], [0, .5], [.62, 1]].forEach(([ex, ey], i) => throwAt('star', card.x + ex * card.w, card.y + ey * card.h, from, { delay: .5 + i * .12, life: .16, ex, ey, r: .1 }));
        if (p < 1) return;
        // Mythic et plus : un grand X de lame, une ronde de shuriken tout autour, une pluie de feuilles
        const glowC = asc >= 3 ? '#f0abfc' : asc ? '#fde68a' : '#bae6fd';
        slashes.add({ delay: .2, life: .5, x1: card.x - H * .5, y1: card.y - H * .3, x2: card.x + card.w + H * .5, y2: card.y + card.h + H * .3, w: H * .16, glow: glowC });
        slashes.add({ delay: .36, life: .5, x1: card.x + card.w + H * .5, y1: card.y - H * .3, x2: card.x - H * .5, y2: card.y + card.h + H * .3, w: H * .16, glow: glowC });
        const n = 8 + 4 * asc, cx = card.x + card.w / 2, cy = card.y + card.h / 2;
        for (let i = 0; i < n; i++) {
          const pt = along({ x: card.x, y: card.y, w: card.w, h: card.h, r: card.r }, (i + .5) / n), ex = (pt.x - card.x) / card.w, ey = (pt.y - card.y) / card.h, an = Math.atan2(pt.y - cy, (pt.x - cx) * .5);
          throwAt('star', pt.x, pt.y, { x: pt.x + Math.cos(an) * H * 1.6, y: pt.y + Math.sin(an) * H * 1.6 }, { delay: .7 + i * .05, life: .14, ex, ey, r: .1, gold: asc >= 1 && asc < 3, cols: asc >= 3 ? [pick(['#fbcfe8', '#bae6fd', '#bbf7d0', '#fef08a']), pick(RAINBOW), '#312e81'] : undefined });
        }
        for (let i = Math.round((26 + 14 * asc) * q); i > 0; i--) addLeaf(card.x + rnd(-.2, 1.2) * card.w, card.y - H * rnd(.6, 2), rnd(-20, 20), rnd(20, 60), { max: rnd(2, 3), delay: 0 });
      },
    };
  };

  // 📜 Scroll of Alchemy (2026-10-28, idée de R77) — au début du tirage, les deux rouleaux du parchemin s'écartent depuis
  // le milieu (avec l'animation CSS alc-unroll) et leurs poignées de bois dépassent en haut et en bas. Chaque case
  // encore cachée porte une rune d'or qui change sans cesse ; une loupe de laiton plane au-dessus de la prochaine case et
  // la grossit. Un chiffre qui se pose : sa rune se défait en poussière d'or qui tourbillonne vers le centre (le chiffre
  // CSS y naît, alc-transmute), un anneau d'or s'ouvre, et la loupe glisse vers la case suivante. Avant le dernier
  // chiffre, la loupe tremble et aspire de la poussière d'or. À la fin, elle s'éloigne vers le haut. Révélation : tirage
  // raté, la transmutation échoue (fumée grise) ; sinon de la poussière d'or monte des chiffres ; dès Epic, un cercle de
  // transmutation se trace autour de la carte ; dès Mythic, une ronde de grandes runes flamboie autour du parchemin et un
  // sceau de lumière descend et frappe le parchemin : il reste imprimé en or derrière les chiffres (arc-en-ciel à Infinite).
  const ALC_RUNES = [ // runes d'or tracées au trait, dans un carré de côté 2 centré sur 0
    c => { c.arc(0, 0, .8, 0, TAU); c.moveTo(.16, 0); c.arc(0, 0, .16, 0, TAU); }, // soleil
    c => { c.arc(0, 0, .8, Math.PI * .35, Math.PI * 1.65); c.moveTo(.33, -.73); c.quadraticCurveTo(-.4, 0, .33, .73); }, // lune
    c => { c.moveTo(0, -.85); c.lineTo(.8, .65); c.lineTo(-.8, .65); c.closePath(); }, // feu
    c => { c.moveTo(0, .85); c.lineTo(.8, -.65); c.lineTo(-.8, -.65); c.closePath(); }, // eau
    c => { c.moveTo(0, -.85); c.lineTo(.8, .65); c.lineTo(-.8, .65); c.closePath(); c.moveTo(-.65, .05); c.lineTo(.65, .05); }, // air
    c => { c.moveTo(0, .85); c.lineTo(.8, -.65); c.lineTo(-.8, -.65); c.closePath(); c.moveTo(-.65, -.05); c.lineTo(.65, -.05); }, // terre
    c => { c.moveTo(.42, -.25); c.arc(0, -.25, .42, 0, TAU); c.moveTo(0, .17); c.lineTo(0, .9); c.moveTo(-.3, .55); c.lineTo(.3, .55); c.moveTo(-.4, -.9); c.quadraticCurveTo(0, -.5, .4, -.9); }, // mercure
    c => { c.arc(0, 0, .75, 0, TAU); c.moveTo(-.75, 0); c.lineTo(.75, 0); }, // sel
    c => { c.moveTo(0, -.9); c.lineTo(.55, 0); c.lineTo(-.55, 0); c.closePath(); c.moveTo(0, 0); c.lineTo(0, .9); c.moveTo(-.4, .45); c.lineTo(.4, .45); }, // soufre
    c => { c.moveTo(.45, -.35); c.arc(0, -.35, .45, 0, TAU); c.moveTo(0, .1); c.lineTo(0, .9); c.moveTo(-.35, .5); c.lineTo(.35, .5); }, // cuivre
    c => { c.moveTo(.4, .2); c.arc(-.1, .2, .5, 0, TAU); c.moveTo(.25, -.15); c.lineTo(.8, -.75); c.moveTo(.35, -.75); c.lineTo(.8, -.75); c.lineTo(.8, -.3); }, // fer
    c => { c.moveTo(-.3, -.9); c.lineTo(-.3, .9); c.moveTo(-.3, -.5); c.lineTo(.5, -.85); c.moveTo(-.3, -.05); c.lineTo(.5, -.4); }, // rune ancienne
  ];
  // le sceau : deux cercles, un triangle, un carré, des runes entre les cercles
  function alcSigil(c, x, y, r, col, a, rot, width) {
    if (a <= .01) return;
    c.save(); c.globalAlpha = Math.min(1, a); c.translate(x, y); c.rotate(rot); c.strokeStyle = col; c.lineWidth = width; c.lineJoin = 'round';
    c.beginPath(); c.arc(0, 0, r, 0, TAU); c.moveTo(r * .78, 0); c.arc(0, 0, r * .78, 0, TAU); c.moveTo(r * .2, 0); c.arc(0, 0, r * .2, 0, TAU); c.stroke();
    c.beginPath(); for (let i = 0; i < 3; i++) { const an = -Math.PI / 2 + (i * TAU) / 3; c.lineTo(Math.cos(an) * r * .78, Math.sin(an) * r * .78); } c.closePath(); c.stroke();
    c.beginPath(); for (let i = 0; i < 4; i++) { const an = Math.PI / 4 + (i * TAU) / 4; c.lineTo(Math.cos(an) * r * .55, Math.sin(an) * r * .55); } c.closePath(); c.stroke();
    c.lineWidth = width * .8;
    for (let i = 0; i < 8; i++) { const an = (i * TAU) / 8 + .2; c.save(); c.translate(Math.cos(an) * r * .89, Math.sin(an) * r * .89); c.rotate(an + Math.PI / 2); c.scale(r * .07, r * .07); c.beginPath(); ALC_RUNES[i % ALC_RUNES.length](c); c.restore(); c.stroke(); }
    c.restore();
  }
  SCENES.alchemy = env => {
    const { co, card, q, dark } = env;
    const H = card.h, cw0 = card.w, add = dark ? 'lighter' : 'source-over', GOLD = dark ? '#fbbf24' : '#d97706', INK = '#b7791f';
    const motes = particles(), dust = particles(), smoke = particles(), rings = timed(), circle = timed(), flare = timed(), seal = timed();
    const runes = new Map(); // rune affichée par case : { k, next }
    const lens = { x: card.x + card.w * .2, y: card.y + card.h / 2, a: 0, lift: 0, shake: 0, gone: false };
    let now = 0, stamp = null, pull = 0;
    const runeOf = i => { let r = runes.get(i); if (!r || now > r.next) { r = { k: (Math.random() * ALC_RUNES.length) | 0, next: now + rnd(.09, .16) }; runes.set(i, r); } return r.k; };
    const drawRune = (c, k, x, y, r, col, lw, a) => { if (a <= .01) return; c.save(); c.globalAlpha = Math.min(1, a); c.translate(x, y); c.scale(r, r); c.beginPath(); ALC_RUNES[k](c); c.restore(); c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(); };
    const rollW = () => Math.min(H * .34, card.w * .06); // largeur d'un rouleau (≈ .34em)
    const unroll = () => outCubic(clamp(now / .7)) * .92 + .08;
    const knob = (x, y, up) => { // la poignée de bois du rouleau, qui dépasse du parchemin
      const w = rollW() * .62, h = H * .16;
      co.fillStyle = '#5b3716'; roundRect(co, x - w / 2, up ? y - h : y, w, h, w * .4); co.fill();
      co.fillStyle = '#d4a017'; co.fillRect(x - w * .62, up ? y - h * .3 : y, w * 1.24, h * .3);
      co.globalAlpha = .4; co.fillStyle = '#fef3c7'; co.fillRect(x - w * .25, up ? y - h * .9 : y + h * .35, w * .16, h * .5); co.globalAlpha = 1;
    };
    const drawLens = (x, y, R, a, k) => {
      if (a <= .01) return;
      co.save(); co.globalAlpha = a;
      // le manche, vers le bas à droite
      const hx = Math.cos(.8) * R, hy = Math.sin(.8) * R;
      co.lineCap = 'round'; co.strokeStyle = '#3f2410'; co.lineWidth = R * .32; co.beginPath(); co.moveTo(x + hx * 1.15, y + hy * 1.15); co.lineTo(x + hx * 2.2, y + hy * 2.2); co.stroke();
      co.strokeStyle = '#d4a017'; co.lineWidth = R * .36; co.beginPath(); co.moveTo(x + hx * 1.05, y + hy * 1.05); co.lineTo(x + hx * 1.25, y + hy * 1.25); co.stroke(); co.lineCap = 'butt';
      // le verre : légèrement teinté, la rune de la case grossie dedans
      co.save(); co.beginPath(); co.arc(x, y, R, 0, TAU); co.clip();
      if (k != null) { co.fillStyle = 'rgba(255,248,225,.55)'; co.fillRect(x - R, y - R, R * 2, R * 2); } // en s'éloignant, plus de verre teinté (il assombrissait le fond de la page)
      if (k != null) { co.globalCompositeOperation = add; dot(co, '#fbbf24', x, y, R * .9, .5); co.globalCompositeOperation = 'source-over'; drawRune(co, k, x, y, R * .55, '#b45309', Math.max(2, R * .1), a); }
      co.globalAlpha = a * .5; co.strokeStyle = '#ffffff'; co.lineWidth = R * .1; co.beginPath(); co.arc(x, y, R * .72, Math.PI * 1.1, Math.PI * 1.45); co.stroke();
      co.restore();
      // la monture en laiton
      const g = co.createLinearGradient(x - R, y - R, x + R, y + R); g.addColorStop(0, '#fde68a'); g.addColorStop(.45, '#b7791f'); g.addColorStop(1, '#5b3716');
      co.globalAlpha = a; co.strokeStyle = g; co.lineWidth = R * .17; co.beginPath(); co.arc(x, y, R, 0, TAU); co.stroke();
      co.strokeStyle = 'rgba(40,20,5,.7)'; co.lineWidth = 1; co.beginPath(); co.arc(x, y, R * 1.085, 0, TAU); co.stroke();
      co.restore();
    };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on);
        // les runes des cases encore cachées, dans le parchemin (derrière les chiffres)
        inC(env, cw0, c => {
          for (const s of S) {
            if (s.on) continue;
            const k = runeOf(s.i), r = (s.bottom - s.top) * .3, pulse = s === next ? pull : 0;
            c.globalCompositeOperation = 'source-over'; dot(c, '#fbbf24', s.x, s.y, r * (1.9 + pulse), .3 + .3 * pulse);
            drawRune(c, k, s.x + rnd(-.4, .4) * pulse, s.y, r, s.ghost ? 'rgba(183,121,31,.35)' : INK, Math.max(1.4, r * .16), 1);
          }
          // le sceau imprimé (Mythic) : en or, derrière les chiffres
          if (stamp) { const k = clamp((now - stamp.t) / 4), col = stamp.rainbow ? RAINBOW[Math.floor(now * 3) % RAINBOW.length] : '#d97706'; alcSigil(c, stamp.x, stamp.y, stamp.r, col, lerp(.55, .3, k), stamp.rot + now * .05, Math.max(1.5, H * .025)); }
        });
        // les deux rouleaux qui s'écartent, et leurs poignées
        const u = unroll(), cx = card.x + card.w / 2, half = (card.w / 2 - rollW() / 2) * u;
        for (const x of [cx - half, cx + half]) { knob(x, card.y, true); knob(x, card.y + card.h, false); }
        // la loupe : au-dessus de la prochaine case, elle grossit sa rune
        lens.shake = Math.max(0, lens.shake - dt * 2);
        if (next && !lens.gone) { lens.x += (next.x - lens.x) * Math.min(1, dt * 9); lens.y += (next.y - H * .04 + Math.sin(now * 2.2) * H * .03 - lens.y) * Math.min(1, dt * 6); lens.a = Math.min(1, lens.a + dt * 3); }
        else { lens.gone = true; lens.lift = Math.min(1, lens.lift + dt * 1.8); }
        const R = H * .4 * (1 + lens.lift * .6), lx = lens.x + rnd(-1, 1) * lens.shake * 2 + lens.lift * H * .6, ly = lens.y + rnd(-1, 1) * lens.shake * 2 - lens.lift * H * 1.2;
        if (pull && next && Math.random() < dt * 30 * q) { const an = rnd(TAU), d = H * rnd(.8, 1.3); motes.add({ x: lx + Math.cos(an) * d, y: ly + Math.sin(an) * d, tx: lx, ty: ly, max: rnd(.3, .5), spin: 0, size: rnd(1.2, 2.2) }); }
        // la poussière d'or qui s'effondre dans un chiffre ou aspirée par la loupe
        motes.step(dt); co.globalCompositeOperation = add;
        motes.each((m, k) => { const e = k * k, an = m.spin * (1 - k); const x = m.tx + (m.x - m.tx) * (1 - e), y = m.ty + (m.y - m.ty) * (1 - e); dot(co, GOLD, m.tx + (x - m.tx) * Math.cos(an) - (y - m.ty) * Math.sin(an), m.ty + (x - m.tx) * Math.sin(an) + (y - m.ty) * Math.cos(an), m.size * 2.2, .9); });
        rings.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = GOLD; co.lineWidth = 2 * (1 - k) + .6; co.beginPath(); co.arc(r.x, r.y, H * (.2 + .5 * outCubic(k)), 0, TAU); co.stroke(); dot(co, '#fde68a', r.x, r.y, H * .5 * (1 - k), (1 - k) * .55); });
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
        drawLens(lx, ly, R, lens.a * (1 - lens.lift) * (1 - lens.lift), next && !lens.gone ? runeOf(next.i) : null);
        // la révélation : cercle de transmutation, ronde de runes, sceau qui descend
        circle.run(dt, (e, k) => behind(env, () => {
          const draw = clamp(k / .35), a = k > .7 ? (1 - k) / .3 : 1, rx = card.w / 2 + H * .45, ry = card.h / 2 + H * .5;
          co.globalCompositeOperation = add; co.globalAlpha = a * .85; co.strokeStyle = GOLD; co.lineWidth = 2;
          co.beginPath(); co.ellipse(cx, card.y + card.h / 2, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + TAU * draw); co.stroke();
          co.beginPath(); co.ellipse(cx, card.y + card.h / 2, rx + H * .14, ry + H * .14, 0, Math.PI / 2, Math.PI / 2 + TAU * draw); co.stroke();
          for (let i = 0; i < 8 && i / 8 < draw; i++) { const an = -Math.PI / 2 + (i * TAU) / 8; drawRune(co, (i * 5) % ALC_RUNES.length, cx + Math.cos(an) * (rx + H * .07), card.y + card.h / 2 + Math.sin(an) * (ry + H * .07), H * .06, GOLD, 1.4, a); }
          co.globalCompositeOperation = 'source-over';
        }, true)); // rien sous la carte : la rareté et l'XP s'y affichent
        flare.run(dt, (f, k) => behind(env, () => {
          const a = k < .15 ? k / .15 : k > .7 ? (1 - k) / .3 : 1, rx = card.w / 2 + H * .95, ry = card.h / 2 + H * .75;
          co.globalCompositeOperation = add;
          if (f.asc) godrays(co, f.col(now), cx, card.y + card.h / 2, 10 + 4 * f.asc, card.w * .5, card.w * (.9 + .25 * f.asc), now * .3, H * .3, a * .25);
          for (let i = 0; i < f.n; i++) {
            const an = (i * TAU) / f.n + now * .5, x = cx + Math.cos(an) * rx, y = card.y + card.h / 2 + Math.sin(an) * ry, fl = .6 + .4 * Math.sin(now * 9 + i * 1.7);
            dot(co, f.col(now + i * .1), x, y, H * .4 * fl, a * .45);
            drawRune(co, (i * 7) % ALC_RUNES.length, x, y, H * .17, dark ? '#fff7d6' : '#b45309', 2.2, a);
          }
          co.globalCompositeOperation = 'source-over';
        }, true)); // rien sous la carte : la rareté et l'XP s'y affichent
        seal.run(dt, (s, k) => {
          const T = k * s.life, fall = clamp(T / .4), sc = lerp(2.6, 1, fall * fall), a = fall < 1 ? fall * .8 : clamp(1 - (T - .4) / .25) * .9;
          co.globalCompositeOperation = add; alcSigil(co, cx, card.y + card.h / 2, H * .46 * sc, s.col(now), a, s.rot - (1 - fall) * 1.5, Math.max(2, H * .05) * sc * .6); co.globalCompositeOperation = 'source-over';
          if (fall >= 1 && !s.hit) {
            s.hit = 1; stamp = { x: cx, y: card.y + card.h / 2, r: H * .46, rot: s.rot, t: now, rainbow: s.rainbow };
            rings.add({ life: .7, x: cx, y: card.y + card.h / 2 }); rings.add({ delay: .12, life: .9, x: cx, y: card.y + card.h / 2 });
            for (let i = Math.round((30 + 20 * s.asc) * q); i > 0; i--) { const an = rnd(TAU), v = rnd(80, 260); dust.add({ x: cx + Math.cos(an) * card.w * .3, y: card.y + card.h / 2 + Math.sin(an) * H * .4, vx: Math.cos(an) * v, vy: Math.sin(an) * v * .6 - 40, drag: 2, g: -20, max: rnd(.8, 1.5), size: rnd(1.2, 2.6) }); }
          }
        });
        dust.step(dt); smoke.step(dt);
        co.globalCompositeOperation = add;
        dust.each((d, k) => dot(co, k < .3 ? '#fef3c7' : GOLD, d.x, d.y, d.size * 2.4, (1 - k) * .9));
        co.globalCompositeOperation = 'source-over';
        smoke.each((s, k) => dot(co, dark ? '#9ca3af' : '#4b5563', s.x, s.y, s.size * (1 + 2.5 * k), (1 - k) * .55));
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const s = slotsA(env).reduce((b, z) => (!b || Math.abs(z.x - p.x) < Math.abs(b.x - p.x) ? z : b), null); if (!s) return;
        const k = runes.get(s.i) ? runes.get(s.i).k : 0, r = (s.bottom - s.top) * .3;
        if (o.last) { pull = 0; lens.shake = 0; }
        if (o.ghost) { rings.add({ life: .35, x: s.x, y: s.y }); return; }
        // la rune se défait : des grains d'or pris sur son tracé tourbillonnent jusqu'au centre
        for (let i = Math.round((o.last ? 26 : 16) * q); i > 0; i--) { const an = rnd(TAU), d = r * rnd(.4, 1.1); motes.add({ x: s.x + Math.cos(an) * d * 1.6, y: s.y + Math.sin(an) * d * 1.6, tx: s.x, ty: s.y, max: rnd(.18, .3), spin: rnd(1.5, 3) * (Math.random() < .5 ? -1 : 1), size: rnd(1.2, 2.4) }); }
        rings.add({ delay: .08, life: o.last ? .7 : .5, x: s.x, y: s.y });
        void k;
      },
      build() { pull = 1; lens.shake = 1.5; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0, cx = card.x + card.w / 2, cy = card.y + card.h / 2;
        pull = 0;
        if (!p) { for (let i = 0; i < 9; i++) smoke.add({ x: cx + rnd(-.3, .3) * card.w, y: cy, vx: rnd(-20, 20), vy: -rnd(30, 70), drag: 1, g: -10, max: rnd(1.2, 1.8), size: H * rnd(.1, .16) }); return; }
        for (const s of slotsA(env)) if (!s.gone && !s.ghost) for (let i = Math.round((2 + 8 * p) * q); i > 0; i--) dust.add({ x: s.x + rnd(-.3, .3) * s.w, y: s.y + rnd(-.2, .3) * H, vx: rnd(-20, 20), vy: -rnd(40, 120), drag: 1.2, g: -30, max: rnd(.9, 1.6), size: rnd(1, 2.2) });
        if (p >= .6) circle.add({ life: 2.4 + p });
        if (p < 1) return;
        const col = asc >= 3 ? tt => RAINBOW[Math.floor(tt * 4) % RAINBOW.length] : () => (dark ? '#fde68a' : '#d97706');
        flare.add({ delay: .1, life: 2.4 + asc * .6, n: 10 + 4 * asc, asc, col });
        seal.add({ delay: .6, life: .9, rot: rnd(TAU), asc, col, rainbow: asc >= 3 });
      },
    };
  };

  // 🧽 Window Cleaner (2026-10-28, idée de Deadshot) — de l'autre côté de la vitre, le laveur de carreaux : une silhouette
  // bleu nuit (casquette, harnais, deux cordes qui montent hors du cadre) dessinée dans la carte, derrière les carreaux ;
  // on la devine à travers la crasse et on la voit nette derrière les carreaux propres. Il frotte le haut du prochain
  // carreau ; quand le chiffre se pose, sa raclette descend du haut en bas au rythme de l'animation CSS wc-wipe (de 18 %
  // à 58 % de 0,62 s), deux gouttes glissent sous le carreau, puis il se laisse glisser jusqu'au carreau suivant en se
  // balançant au bout de ses cordes. Avant le dernier chiffre, il frotte plus vite et des bulles de savon s'envolent.
  // Révélation : tirage raté, il hausse les épaules et la pluie se met à tomber sur la vitre ; sinon il fait coucou et des
  // éclats brillent aux coins des carreaux ; dès Epic, des bulles de savon s'envolent autour ; dès Mythic, toute la
  // fenêtre étincelle : une grande bande de lumière balaie la vitre (deux, arc-en-ciel, au-delà) et des étoiles s'allument.
  SCENES.windowcleaner = env => {
    const { co, card, q, dark } = env;
    const H = card.h, cw0 = card.w, INK = 'rgba(15,23,42,.8)';
    const OFF = H * .38; // il se tient un peu à gauche du carreau qu'il lave : sa tête ne cache pas le chiffre
    const man = { x: card.x + card.w * .1, tx: null, sway: 0, scrub: 1, wipe: null, wave: 0, shrug: 0, up: 0, leaveAt: Infinity };
    const drips = particles(), bubbles = particles(), rain = particles(), glints = timed(), sweeps = timed();
    let now = 0, scrubFast = 0, raining = 0;
    // la silhouette, dans la carte : (x, sy) = position de la raclette (sy : hauteur de la tête de raclette)
    const drawMan = (c, x, sy, sw) => {
      // grand, à bout de bras derrière la vitre : la tête occupe le haut d'un carreau, les épaules en couvrent presque deux
      const rise = man.up * man.up * H * 3, top = card.y - rise, s = H, hy = top + s * .4, shy = hy + s * .3; // man.up : il remonte au bout de ses cordes, son travail fini
      sy -= rise; // la raclette monte avec lui (elle restait au carreau, le bras s'étirait : signalé par Deadshot, 2026-10-29)
      c.fillStyle = INK; c.strokeStyle = INK; c.lineCap = 'round'; c.lineJoin = 'round';
      // les deux cordes, du haut de la fenêtre jusqu'au harnais
      c.lineWidth = Math.max(1.2, s * .03); c.beginPath(); c.moveTo(x - s * .3 - sw * s * .3, card.y - 2); c.lineTo(x - s * .22, shy + s * .1); c.moveTo(x + s * .3 - sw * s * .3, card.y - 2); c.lineTo(x + s * .22, shy + s * .1); c.stroke();
      // le corps (épaules arrondies), le cou, la tête, la casquette
      // sous le bas de la vitre, le reste du corps (bassin et jambes) : quand il remonte, on ne voit plus un buste coupé
      // net ; il monte assez haut pour sortir du cadre en entier
      // (un seul tracé : l'encre est translucide, deux formes qui se chevauchent feraient une tache plus sombre)
      c.beginPath(); c.moveTo(x - s * .28, top + s * 2.4); c.lineTo(x - s * .36, top + s * 1.75); c.lineTo(x - s * .48, top + s * 1.2); c.quadraticCurveTo(x - s * .5, shy, x - s * .2, shy - s * .04); c.lineTo(x + s * .2, shy - s * .04); c.quadraticCurveTo(x + s * .5, shy, x + s * .48, top + s * 1.2); c.lineTo(x + s * .36, top + s * 1.75); c.lineTo(x + s * .28, top + s * 2.4);
      c.arc(x + s * .18, top + s * 2.4, s * .1, 0, Math.PI); c.lineTo(x + s * .08, top + s * 1.9); c.lineTo(x - s * .08, top + s * 1.9); c.lineTo(x - s * .08, top + s * 2.4); c.arc(x - s * .18, top + s * 2.4, s * .1, 0, Math.PI); c.closePath(); c.fill();
      c.fillRect(x - s * .07, hy + s * .1, s * .14, s * .18);
      c.beginPath(); c.arc(x, hy, s * .19, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(x, hy - s * .1, s * .2, s * .11, 0, Math.PI, 0); c.fill(); c.beginPath(); c.ellipse(x + s * .2, hy - s * .1, s * .14, s * .035, 0, 0, TAU); c.fill(); // casquette et visière
      c.globalAlpha = .5; c.fillStyle = '#334155'; c.fillRect(x - s * .46, shy + s * .2, s * .92, s * .06); c.globalAlpha = 1; c.fillStyle = INK; // la sangle du harnais
      // le bras qui tient la raclette (coude plié), ou le coucou, ou le haussement d'épaules
      c.lineWidth = s * .11;
      const sx = x + s * .34, sy0 = shy + s * .06;
      if (man.shrug > 0) { c.beginPath(); for (const e of [-1, 1]) { c.moveTo(x + e * s * .34, sy0); c.lineTo(x + e * s * .55, sy0 - s * .05 - man.shrug * s * .1); c.lineTo(x + e * s * .62, sy0 - s * .25 * man.shrug); } c.stroke(); return; }
      if (man.wave > 0) { const a = Math.sin(now * 14) * .5; c.beginPath(); c.moveTo(sx, sy0); c.lineTo(sx + s * .2, sy0 - s * .25); c.lineTo(sx + s * .2 + Math.sin(a) * s * .3, sy0 - s * .25 - Math.cos(a) * s * .3); c.stroke(); c.beginPath(); c.arc(sx + s * .2 + Math.sin(a) * s * .33, sy0 - s * .25 - Math.cos(a) * s * .33, s * .08, 0, TAU); c.fill(); return; }
      const hx = man.x + OFF, hyH = sy + s * .2; // la main tient le manche sous la tête de raclette
      c.beginPath(); c.moveTo(sx, sy0); c.quadraticCurveTo(sx + s * .3, (sy0 + hyH) / 2 + s * .12, hx, hyH); c.stroke();
      c.beginPath(); c.arc(hx, hyH, s * .07, 0, TAU); c.fill();
      c.lineWidth = s * .05; c.beginPath(); c.moveTo(hx, hyH); c.lineTo(hx, sy); c.stroke(); // le manche
      c.lineWidth = s * .07; c.beginPath(); c.moveTo(hx - s * .25, sy); c.lineTo(hx + s * .25, sy); c.stroke(); // la tête de raclette
    };
    const bubble = (b, k) => {
      const r = b.size * (1 + .15 * Math.sin(now * 5 + b.ph)), a = Math.min(1, (1 - k) * 3) * .85;
      co.globalAlpha = a; co.strokeStyle = dark ? 'rgba(224,242,254,.9)' : 'rgba(37,99,235,.65)'; co.lineWidth = 1.2; co.beginPath(); co.arc(b.x, b.y, r, 0, TAU); co.stroke();
      co.globalAlpha = a * .5; co.strokeStyle = pick(['#f0abfc', '#a5f3fc', '#fde68a']); co.beginPath(); co.arc(b.x, b.y, r * .8, Math.PI * 1.1, Math.PI * 1.6); co.stroke();
      co.globalAlpha = a; co.fillStyle = '#ffffff'; co.beginPath(); co.arc(b.x - r * .35, b.y - r * .35, r * .18, 0, TAU); co.fill();
    };
    const blow = (x, y, n, spread = 1) => { for (let i = Math.round(n * q); i > 0; i--) bubbles.add({ x: x + rnd(-.3, .3) * H * spread, y: y + rnd(-.2, .2) * H, vx: rnd(-30, 30) * spread, vy: -rnd(20, 60), g: -15, drag: .6, max: rnd(1.4, 2.4), size: H * rnd(.05, .11), ph: rnd(TAU) }); };
    const clipCard = fn => { co.save(); roundRect(co, card.x, card.y, card.w, card.h, card.r); co.clip(); fn(); co.restore(); };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = 'source-over';
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on);
        // il va vers le prochain carreau (ou sort par la droite à la fin) ; ses cordes le font se balancer
        const goal = man.tx != null ? man.tx : next ? next.x - OFF : card.x + card.w + H * .6;
        if (!man.wipe || now > man.wipe.t + .42) { const d = goal - man.x; man.x += d * Math.min(1, dt * 5); man.sway += (clamp(d / H, -1, 1) * .5 - man.sway) * Math.min(1, dt * 6); }
        // coucou (ou haussement d'épaules) jusqu'à ce qu'il soit sorti du cadre : avant, le bras retombait d'un coup sur
        // la raclette juste avant qu'il remonte
        man.wave = Math.max(0, man.wave - dt * .3); man.shrug = Math.max(0, man.shrug - dt * .3);
        if (now > (man.leaveAt || Infinity)) man.up = Math.min(1, (man.up || 0) + dt * .7);
        const pane = S.reduce((b, z) => (!b || Math.abs(z.x - man.x - OFF) < Math.abs(b.x - man.x - OFF) ? z : b), null);
        const ptop = pane ? pane.top + H * .1 : card.y + H * .25, pbot = pane ? pane.bottom - H * .08 : card.y + H * .8;
        let sy = ptop + Math.abs(Math.sin(now * (scrubFast ? 22 : 7))) * H * .06;
        if (man.wipe) { const k = (now - man.wipe.t) / .62; if (k < 1) sy = k < .18 ? ptop - H * .03 * Math.sin(k / .18 * Math.PI) : k < .58 ? lerp(ptop, pbot, (k - .18) / .4) : pbot - (k - .58) / .42 * (pbot - ptop) * .8; }
        inC(env, cw0, c => drawMan(c, man.x + Math.sin(now * 1.6) * H * .02, sy, man.sway));
        // gouttes qui glissent sous les carreaux, bulles, pluie
        drips.step(dt); bubbles.step(dt); rain.step(dt);
        co.fillStyle = dark ? '#e0f2fe' : '#3b82f6';
        drips.each((d, k) => { co.globalAlpha = (1 - k) * .9; co.beginPath(); co.ellipse(d.x, d.y, d.size * .7, d.size * 1.2, 0, 0, TAU); co.fill(); });
        bubbles.each(bubble);
        if (raining) {
          for (let n = Math.random() < dt * 70 * q ? 1 : 0; n > 0; n--) rain.add({ x: card.x + rnd(0, 1) * card.w, y: card.y - 4, vx: 0, vy: rnd(70, 140), g: 60, max: rnd(.5, .9), size: rnd(1.2, 2) });
          raining = Math.max(0, raining - dt);
        }
        if (rain.n) clipCard(() => { co.strokeStyle = 'rgba(30,41,59,.55)'; co.fillStyle = 'rgba(30,41,59,.7)'; co.lineWidth = 1.8; rain.each((r, k) => { co.globalAlpha = 1 - k * .5; co.beginPath(); co.moveTo(r.x, r.y - r.size * 7); co.lineTo(r.x, r.y); co.stroke(); co.beginPath(); co.arc(r.x, r.y, r.size, 0, TAU); co.fill(); }); });
        // les éclats et la grande bande de lumière
        glints.run(dt, (g, k) => twinkle(co, g.c || '#ffffff', g.x, g.y, g.r * Math.sin(k * Math.PI), 1, k * 1.5));
        sweeps.run(dt, (s, k) => clipCard(() => {
          // la vitre propre étincelle : un éclair blanc, puis une large bande de lumière (et une fine plus vive) qui balaie
          // la fenêtre de gauche à droite en semant des étoiles derrière elle
          const e = k * k * (3 - 2 * k), x = lerp(card.x - H * 1.2, card.x + card.w + H * 1.2, e), wd = H * 1.1;
          const c0 = s.rainbow ? RAINBOW[Math.floor(now * 8) % RAINBOW.length] : '#ffffff';
          co.globalCompositeOperation = 'lighter';
          if (k < .25) { co.globalAlpha = (1 - k / .25) * .35; co.fillStyle = '#ffffff'; co.fillRect(card.x, card.y, card.w, card.h); }
          for (const [w2, a2] of [[wd, .55], [wd * .3, .95]]) {
            const g = co.createLinearGradient(x - w2, card.y, x + w2, card.y + card.h * .5);
            g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, c0); g.addColorStop(1, 'rgba(255,255,255,0)');
            co.globalAlpha = a2 * Math.sin(Math.min(1, k * 1.15) * Math.PI); co.fillStyle = g; co.fillRect(card.x, card.y, card.w, card.h);
          }
          co.globalCompositeOperation = 'source-over';
          if (x > card.x && x < card.x + card.w && Math.random() < dt * 22 * q) glints.add({ life: .5, x: x - rnd(0, H * .6), y: card.y + rnd(.1, .9) * card.h, r: H * rnd(.1, .2), c: s.rainbow ? pick(RAINBOW) : '#ffffff' });
        }));
        co.globalAlpha = 1;
        if (scrubFast && next && Math.random() < dt * 5) blow(next.x, next.top + H * .1, 1, .5);
      },
      lock(p, o) {
        const s = slotsA(env).reduce((b, z) => (!b || Math.abs(z.x - p.x) < Math.abs(b.x - p.x) ? z : b), null); if (!s) return;
        man.x = s.x - OFF; man.wipe = { t: now };
        if (o.last) scrubFast = 0;
        if (o.ghost) return;
        for (let i = 0; i < 2; i++) drips.add({ delay: 0, x: s.x + rnd(-.3, .3) * s.w, y: s.bottom - 3, vx: 0, vy: rnd(10, 25), g: 30, max: rnd(.6, 1), size: rnd(1.4, 2.2) });
        glints.add({ delay: .42, life: .4, x: s.x + s.w * .3, y: s.top + H * .14, r: H * .14 });
      },
      build() { scrubFast = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        scrubFast = 0; man.tx = card.x + card.w * .5 - OFF; man.leaveAt = now + 2.2;
        if (!p) { man.shrug = 1; raining = 3.5; return; }
        man.wave = 1;
        const S = slotsA(env).filter(s => !s.gone && !s.ghost);
        for (let i = Math.round((2 + 8 * p) * q) + 4 * asc; i > 0; i--) { const s = pick(S), cx = Math.random() < .5 ? -1 : 1; glints.add({ delay: rnd(0, 1 + p), life: .5, x: s.x + cx * s.w * .4, y: Math.random() < .5 ? s.top + 3 : s.bottom - 3, r: H * rnd(.1, .18) }); }
        if (p >= .6) for (const e of [0, 1]) blow(card.x + e * card.w, card.y + card.h * .5, 5 + 5 * p, 1.2); // des bulles de chaque côté de la carte
        if (p < 1) return;
        sweeps.add({ delay: .15, life: 1.1 });
        if (asc) sweeps.add({ delay: .9, life: 1.1, rainbow: asc >= 3 });
        for (let i = Math.round((14 + 10 * asc) * q); i > 0; i--) { const out = Math.random() < .45; glints.add({ delay: rnd(.3, 2), life: .55, x: card.x + rnd(out ? -.1 : 0, out ? 1.1 : 1) * card.w, y: out ? card.y + (Math.random() < .5 ? -rnd(.1, .5) : 1 + rnd(.1, .3)) * card.h : card.y + rnd(.1, .9) * card.h, r: H * rnd(.1, .22), c: asc >= 3 ? pick(RAINBOW) : asc ? '#fef3c7' : '#ffffff' }); }
      },
    };
  };

  // 🎆 Firework (2026-10-28, idée de HSI) — un vrai feu d'artifice, sans fusée-vaisseau (c'est Rocket) : à chaque chiffre,
  // une bombe part d'en bas avec sa traînée et monte jusqu'à la case (0,14 s, pendant que le chiffre CSS est encore caché),
  // puis éclate : un éclair, une couronne d'étincelles, et une gerbe dont les étincelles filent se ranger sur la forme du
  // chiffre (points pris sur le chiffre dessiné dans un petit canvas, FW_GLYPH) avant de retomber en paillettes ; la case
  // s'illumine. Couleur par case, la même que le chiffre CSS. Avant le dernier chiffre, une fontaine crépite sous la case.
  // Révélation : tirage raté, une bombe ratée monte mollement et fait pff (fumée) ; sinon quelques bombes (plus avec la
  // rareté) ; dès Epic, des paillettes qui scintillent ; dès Mythic, le bouquet final : deux fontaines, un barrage de
  // bombes, un anneau à la couleur de la rareté (arc-en-ciel à Infinite) et un grand saule doré qui retombe en rideau.
  const FW_COL = ['#f472b6', '#facc15', '#22d3ee', '#4ade80', '#c084fc', '#fb923c'];
  const FW_TIER = { common: '#e2e8f0', uncommon: '#4ade80', rare: '#60a5fa', epic: '#c084fc', anomaly: '#fb923c', mythic: '#f43f5e', celestial: '#67e8f9', divine: '#fde047', godlike: '#ffffff' };
  const FW_GLYPH = new Map(); // chiffre → points de sa forme, entre -0,5 et 0,5
  function fwGlyph(ch) {
    let pts = FW_GLYPH.get(ch);
    if (pts) return pts;
    pts = [];
    try {
      const W = 40, Hh = 56, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
      const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.font = "900 54px 'Arial Rounded MT Bold', 'Trebuchet MS', system-ui, sans-serif"; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(ch, W / 2, Hh / 2 + 3);
      const d = c.getImageData(0, 0, W, Hh).data;
      for (let y = 2; y < Hh; y += 4) for (let x = 2; x < W; x += 4) if (d[(y * W + x) * 4 + 3] > 140) pts.push([x / W - .5, y / Hh - .5]);
    } catch (e) { /* pas de canvas : une gerbe ronde seulement */ }
    FW_GLYPH.set(ch, pts);
    return pts;
  }
  SCENES.firework = env => {
    const { co, card, q, dark } = env;
    const H = card.h, cw0 = card.w, add = dark ? 'lighter' : 'source-over';
    const shells = [], shape = particles(), sparks = particles(), glitter = particles(), smoke = particles(), flashes = timed(), fountains = timed();
    let now = 0, fizz = 0;
    const slotAt = x => slotsA(env).reduce((b, z) => (!b || Math.abs(z.x - x) < Math.abs(b.x - x) ? z : b), null);
    // une bombe : elle monte de (x0, y0) à (x, y) en ralentissant, puis appelle burst
    const launch = (x0, y0, x, y, life, burst, o = {}) => shells.push({ x0, y0, x, y, t: -(o.delay || 0), life, burst, col: o.col || '#fde68a', weak: o.weak });
    const peony = (x, y, col, n, speed, o = {}) => {
      for (let i = Math.round(n * q); i > 0; i--) { const an = (i / Math.round(n * q)) * TAU + rnd(-.08, .08), v = speed * rnd(.85, 1.1); sparks.add({ x, y, vx: Math.cos(an) * v, vy: Math.sin(an) * v, drag: o.drag || 2.6, g: o.g || 160, max: rnd(.7, 1.1) * (o.life || 1), size: o.size || rnd(1.4, 2.2), c: o.multi ? pick(FW_COL) : col, tail: o.tail || .035 }); }
      flashes.add({ life: .3, x, y, r: speed * .25, c: col });
    };
    const digitBurst = (s, ch, col, big) => {
      const pts = fwGlyph(ch), gw = s.w * 1.15, gh = (s.bottom - s.top) * .95;
      for (const [u, v] of pts) shape.add({ x: s.x, y: s.y, vx: 0, vy: 0, fx: s.x + u * gw, fy: s.y + v * gh, max: rnd(1.05, 1.4) * (big ? 1.2 : 1), size: rnd(1.5, 2.2), c: Math.random() < .3 ? '#ffffff' : col, ph: rnd(TAU), i: s.i });
      peony(s.x, s.y, col, big ? 22 : 14, H * (big ? 3.4 : 2.6));
    };
    return {
      frame(t, dt) {
        now = t; co.globalCompositeOperation = add;
        // les bombes qui montent, avec leur traînée
        for (let i = shells.length - 1; i >= 0; i--) {
          const s = shells[i]; s.t += dt; if (s.t < 0) continue;
          const k = clamp(s.t / s.life), e = s.weak ? Math.sin(k * Math.PI / 2) * .8 : outCubic(k), x = lerp(s.x0, s.x, e), y = lerp(s.y0, s.y, e), pe = Math.max(0, e - .12), px = lerp(s.x0, s.x, pe), py = lerp(s.y0, s.y, pe);
          line(co, s.weak ? '#94a3b8' : '#fde68a', px, py, x, y, 1.6, .5); dot(co, s.weak ? '#cbd5e1' : '#fff7d6', x, y, 4, 1);
          if (Math.random() < .6) glitter.add({ x, y, vx: rnd(-15, 15), vy: rnd(10, 40), g: 80, max: rnd(.2, .45), size: rnd(.8, 1.4), c: '#fdba74', tw: 0 });
          if (k >= 1) { shells.splice(i, 1); s.burst(x, y); }
        }
        // la fontaine avant le dernier chiffre
        if (fizz) { const nxt = slotsA(env).find(z => !z.on && !z.gone); if (nxt) for (let n = Math.random() < dt * 60 * q ? 2 : 0; n > 0; n--) glitter.add({ x: nxt.x + rnd(-3, 3), y: card.y + card.h - 2, vx: rnd(-40, 40), vy: -rnd(80, 200), g: 300, drag: .5, max: rnd(.3, .6), size: rnd(.8, 1.5), c: pick(['#fde68a', '#ffffff', '#fdba74']), tw: 0 }); }
        fountains.run(dt, (f, k) => { for (let n = Math.random() < dt * 90 * q ? 2 : 0; n > 0; n--) glitter.add({ x: f.x + rnd(-3, 3), y: f.y, vx: rnd(-50, 50) + f.lean * 40, vy: -rnd(160, 340) * (1 - k * .4), g: 420, drag: .4, max: rnd(.5, .9), size: rnd(1, 1.8), c: pick(['#fde68a', '#fef3c7', '#fb923c']), tw: 0 }); });
        // éclairs : sur le ciel de la carte (le calque intérieur) et autour
        flashes.run(dt, (f, k) => {
          dot(co, '#ffffff', f.x, f.y, f.r * .5 * (1 - k), (1 - k) * .9);
          dot(co, f.c, f.x, f.y, f.r * (1 + k), (1 - k) * .35);
          inC(env, cw0, c => { c.globalCompositeOperation = 'lighter'; dot(c, f.c, f.x, f.y, H * 1.3, (1 - k) * .3); c.globalCompositeOperation = 'source-over'; });
        });
        co.globalCompositeOperation = add;
        // les étincelles qui dessinent le chiffre : elles filent à leur place, scintillent, puis retombent
        shape.step(dt);
        shape.each((p, k) => {
          // elles jaillissent plus loin que le chiffre (×1,7), puis se resserrent sur lui (×1,1) : on lit la forme
          const T = p.life, go = outExpo(clamp(T / .2)) * lerp(1.7, 1.1, outCubic(clamp((T - .18) / .4))), fall = Math.max(0, T - .55);
          const x = lerp(p.x, p.fx, go), y = lerp(p.y, p.fy, go) + fall * fall * H * 1.2, tw = T > .2 ? .6 + .4 * Math.sin(T * 30 + p.ph) : 1;
          if (T < .2) line(co, p.c, lerp(p.x, p.fx, go * .7), lerp(p.y, p.fy, go * .7), x, y, 1.1, .6);
          dot(co, p.c, x, y, p.size * 2.4, (k > .6 ? (1 - k) / .4 : 1) * tw);
        });
        // couronnes : étincelles avec une courte traînée
        sparks.step(dt);
        sparks.each((s, k) => { const a = k > .5 ? (1 - k) * 2 : 1; line(co, s.c, s.x - s.vx * s.tail, s.y - s.vy * s.tail, s.x, s.y, s.size * (dark ? .8 : 1.3), a * .8); dot(co, s.c, s.x, s.y, s.size * 2, a); if (!dark) { co.globalAlpha = a; co.fillStyle = s.c; co.fillRect(s.x - s.size * .7, s.y - s.size * .7, s.size * 1.4, s.size * 1.4); } }); // page claire : un cœur plein, le halo seul ne se voit pas sur du blanc
        glitter.step(dt);
        glitter.each((g, k) => dot(co, g.c, g.x, g.y, g.size * 2, (1 - k) * (g.tw ? (Math.sin(now * 40 + g.x) > 0 ? 1 : .15) : 1)));
        co.globalCompositeOperation = 'source-over';
        smoke.step(dt);
        smoke.each((s, k) => dot(co, dark ? '#64748b' : '#94a3b8', s.x, s.y, s.size * (1 + k * 1.5), (1 - k) * s.a));
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const s = slotAt(p.x); if (!s) return;
        if (o.last) fizz = 0;
        const el = env.el.querySelectorAll('.slot')[s.i], ch = el ? el.textContent : '8', col = FW_COL[s.i % FW_COL.length];
        const x0 = s.x + rnd(-.2, .2) * H, y0 = card.y + card.h + H * .7;
        if (o.ghost) { launch(x0, y0, s.x, s.y, .14, (x, y) => { peony(x, y, '#64748b', 6, H * 1.2, { life: .6 }); smoke.add({ x, y, vx: 0, vy: -8, max: 1, size: H * .2, a: .25 }); }, { weak: 1 }); return; }
        launch(x0, y0, s.x, s.y, .14, (x, y) => { digitBurst(s, ch, col, o.last); smoke.add({ x, y, vx: rnd(-6, 6), vy: -10, max: 2.2, size: H * .3, a: dark ? .12 : .2 }); });
      },
      build() { fizz = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0, cx = card.x + card.w / 2;
        fizz = 0;
        // une bombe au-dessus de la carte, à une hauteur et une place au hasard
        // Où éclater : la place visible autour de la carte (sur ordinateur, elle est collée au menu, le ciel est sur les
        // côtés ; sur téléphone, elle prend toute la largeur, le ciel est au-dessus, souvent étroit).
        let top = H, side = 0;
        try { const r = env.el.getBoundingClientRect(); top = clamp((r.top - 52) / H, .15, 1.4); side = clamp(Math.min(r.left, root.innerWidth - r.right) / H, 0, 2.6); } catch (e) { /* valeurs par défaut */ }
        const spot = () => side > 1.2 && (top < .6 || Math.random() < .6)
          ? [Math.random() < .5 ? card.x - H * rnd(.4, side - .3) : card.x + card.w + H * rnd(.4, side - .3), card.y + H * rnd(-top * .8, .9)]
          : [cx + rnd(-.55, .55) * card.w, card.y - H * rnd(top * .25, top * .95)];
        const sky = (delay, col, n, speed, o = {}) => { const [x, y] = spot(); launch(x + rnd(-.2, .2) * H, card.y + card.h + H * .6, x, y, rnd(.35, .5), (bx, by) => { peony(bx, by, col, n, speed, o); smoke.add({ x: bx, y: by, vx: rnd(-8, 8), vy: -6, max: 2.5, size: H * .45, a: dark ? .1 : .16 }); }, { delay }); };
        if (!p) { launch(cx, card.y + card.h + H * .6, cx + H * .2, card.y - H * .35, .7, (x, y) => { for (let i = 0; i < 3; i++) glitter.add({ x, y, vx: rnd(-25, 25), vy: rnd(-20, 10), g: 200, max: rnd(.6, 1), size: 1.4, c: '#fb923c', tw: 0 }); smoke.add({ x, y, vx: 0, vy: -10, max: 1.6, size: H * .3, a: .35 }); }, { weak: 1 }); return; }
        const n = 1 + Math.round(4 * p);
        for (let i = 0; i < n; i++) sky(.1 + i * .28, pick(FW_COL), 18 + 14 * p, H * (2.4 + 1.6 * p), { multi: i % 3 === 2 });
        if (p >= .6) for (let i = Math.round((20 + 30 * p) * q); i > 0; i--) glitter.add({ x: cx + rnd(-.6, .6) * card.w, y: card.y - H * rnd(.2, 1.4), vx: rnd(-10, 10), vy: rnd(10, 40), g: 30, max: rnd(1.2, 2.2), size: rnd(1, 1.6), c: '#ffffff', tw: 1 });
        if (p < 1) return;
        // le bouquet final
        const tc = FW_TIER[tier] || '#ffffff';
        [-1, 1].forEach(e => fountains.add({ delay: .2, life: 2 + .4 * asc, x: e < 0 ? card.x - H * .3 : card.x + card.w + H * .3, y: card.y + card.h, lean: -e * .3 }));
        for (let i = 0; i < 10 + 4 * asc; i++) sky(.5 + i * .12, Math.random() < .4 ? tc : pick(FW_COL), 26, H * rnd(3.2, 4.4), { multi: Math.random() < .3 });
        // l'anneau à la couleur de la rareté
        launch(cx, card.y + card.h + H * .6, cx, card.y - H * top * .7, .5, (x, y) => peony(x, y, tc, 36, H * 3.6, { drag: 1.8, g: 60, multi: asc >= 3, size: 2.2 }), { delay: 1.1 });
        // le grand saule doré : des traînées qui retombent en rideau autour de la carte
        launch(cx, card.y + card.h + H * .6, cx, card.y - H * top * .9, .6, (x, y) => {
          for (let i = Math.round((50 + 20 * asc) * q); i > 0; i--) { const an = rnd(TAU), v = H * rnd(2, 3.4); sparks.add({ x, y, vx: Math.cos(an) * v, vy: Math.sin(an) * v * .7 - H * .4, drag: 1.4, g: 140, max: rnd(2, 2.8), size: rnd(1.2, 1.8), c: pick(['#fde68a', '#fbbf24', '#fef3c7']), tail: .18 }); }
          flashes.add({ life: .5, x, y, r: H * 1.4, c: '#fbbf24' });
        }, { delay: 2 });
      },
    };
  };

  // ==== fin du lot C ====

  // ==== Skins du 2026-10-28, lot C ====
  // Graffiti, Origami, Taco et Beach (idées de joueurs). Comme le lot A, ces scènes suivent les cases sur la carte
  // (slotsA), qui se resserre quand les zéros de tête s'effacent.

  // 🎨 Graffiti (2026-10-28, idée de JBearr12) — une bombe de peinture attend en haut à droite du prochain chiffre ;
  // pendant la tension, on la secoue (l'élan) ; quand le chiffre se pose, psssht : un nuage de peinture part de la buse
  // vers la lettre (la couleur de la case), éclabousse le mur de fines gouttelettes qui y restent, et la lettre jaillit
  // (animation CSS graf-spray, au moment où la brume arrive). Puis elle passe au chiffre suivant et sort à droite.
  // Révélation : tirage raté, la bombe est vide (pfft, trois gouttes grises) ; sinon des étincelles blanches taguées
  // aux coins ; dès Epic, des éclaboussures de couleur autour de la carte ; dès Mythic, une explosion de peinture de
  // toutes les couleurs et la bombe tague une couronne dorée posée sur le nombre ; dès Celestial, la couronne brille.
  SCENES.graffiti = env => {
    const { ci, co, card, q, dark } = env;
    const PAINT = ['#a3e635', '#22d3ee', '#f472b6', '#facc15', '#fb923c', '#c084fc']; // les couleurs des cases (.skin-graffiti .slot:nth-of-type)
    const cx = card.x + card.w / 2, S = card.h * .66; // S : hauteur de la bombe
    const mist = particles(), drops = particles(), splats = timed(), stars = timed(), crowns = timed(), streaks = timed(), specks = [];
    const can = { x: card.x - S * 1.5, y: card.y - S * .2, ang: -.6, col: PAINT[0], spray: 0, alpha: 1, tx: 0, ty: 0, path: null, shake: 0 };
    let t = 0, build = 0, done = false;
    const nozzle = () => ({ x: can.x + Math.sin(can.ang) * S * .58, y: can.y - Math.cos(can.ang) * S * .58 });
    // la bombe : corps de la couleur en cours (reflet métallique), étiquette, épaule grise, buse noire ; la buse vers le haut
    const drawCan = () => {
      co.save(); co.globalAlpha = can.alpha; co.translate(can.x, can.y); co.rotate(can.ang);
      co.lineJoin = 'round'; co.lineWidth = Math.max(1, S * .04); co.strokeStyle = '#111';
      const g = co.createLinearGradient(-S * .2, 0, S * .2, 0);
      g.addColorStop(0, '#1f2937'); g.addColorStop(.25, can.col); g.addColorStop(.42, '#ffffff'); g.addColorStop(.55, can.col); g.addColorStop(1, '#111827');
      co.fillStyle = '#cbd5e1'; co.beginPath(); co.ellipse(0, -S * .38, S * .2, S * .1, 0, Math.PI, 0); co.fill(); co.stroke(); // l'épaule
      co.fillStyle = '#e5e7eb'; co.fillRect(-S * .07, -S * .54, S * .14, S * .1); co.strokeRect(-S * .07, -S * .54, S * .14, S * .1); // le col
      co.fillStyle = '#111'; co.fillRect(-S * .055, -S * .62, S * .11, S * .08); // la buse
      roundRect(co, -S * .2, -S * .4, S * .4, S * .8, S * .05); co.fillStyle = g; co.fill(); co.stroke(); // le corps
      co.fillStyle = 'rgba(255,255,255,.92)'; co.fillRect(-S * .2, -S * .08, S * .4, S * .22); // l'étiquette
      co.fillStyle = can.col; co.beginPath(); co.moveTo(-S * .2, S * .1); co.lineTo(S * .2, -S * .04); co.lineTo(S * .2, S * .04); co.lineTo(-S * .2, S * .14); co.fill();
      co.strokeRect(-S * .2, -S * .08, S * .4, S * .22);
      co.restore();
    };
    // une éclaboussure : une tache ronde, des bosses autour et quelques gouttes projetées (formes tirées à sa création)
    const makeSplat = (x, y, r, col, delay, life) => {
      const bumps = [], n = 7 + ((Math.random() * 4) | 0);
      for (let i = 0; i < n; i++) { const a = (i / n) * TAU + rnd(-.3, .3), far = Math.random() < .35; bumps.push({ a, d: r * (far ? rnd(1.3, 1.9) : rnd(.7, .95)), r: r * (far ? rnd(.1, .18) : rnd(.3, .45)) }); }
      splats.add({ x, y, r, col, bumps, delay, life });
    };
    const drawSplat = (s, k) => {
      const grow = outBack(clamp((k * s.life) / .18)), a = Math.min(1, (1 - k) * 4);
      co.globalAlpha = a * .95; co.fillStyle = s.col;
      co.beginPath(); co.arc(s.x, s.y, s.r * grow, 0, TAU); co.fill();
      for (const b of s.bumps) { co.beginPath(); co.arc(s.x + Math.cos(b.a) * b.d * grow, s.y + Math.sin(b.a) * b.d * grow, b.r * grow, 0, TAU); co.fill(); }
    };
    // étoile de tag à quatre branches (blanche, contour noir)
    const star = (x, y, r, a) => {
      if (r <= .5 || a <= .01) return;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.beginPath();
      for (let i = 0; i < 8; i++) { const rr = i % 2 ? r * .28 : r, an = (i / 8) * TAU - Math.PI / 2; co.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); }
      co.closePath(); co.fillStyle = '#fff'; co.fill(); co.lineWidth = Math.max(1, r * .15); co.strokeStyle = '#111'; co.stroke(); co.restore();
    };
    // la couronne taguée, penchée contre le flanc gauche de la carte : contour noir épais, or, trois bijoux ; k (0 à 1) :
    // la part déjà peinte, de gauche à droite. Jamais au-dessus de la carte : sur la page, la barre du haut n'est qu'à une
    // trentaine de pixels et l'aurait coupée.
    const CW = card.h, CH = card.h * .55, CR = -.22;
    const crownPt = (lx, ly) => { const x0 = card.x - CW * 1.02, y0 = card.y + card.h * .8; return { x: x0 + lx * Math.cos(CR) - ly * Math.sin(CR), y: y0 + lx * Math.sin(CR) + ly * Math.cos(CR) }; };
    const drawCrown = (k, a, glowing) => {
      if (k <= 0 || a <= .01) return;
      const o = crownPt(0, 0), mid = crownPt(CW / 2, -CH * .5);
      if (glowing) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#facc15', mid.x, mid.y, CH * (1.6 + .15 * Math.sin(t * 5)), a * (dark ? .45 : .3)); co.globalCompositeOperation = 'source-over'; }
      co.save(); co.globalAlpha = a; co.translate(o.x, o.y); co.rotate(CR);
      co.beginPath(); co.rect(-CH * .4, -CH * 1.6, CH * .4 + (CW + CH * .3) * k, CH * 2.2); co.clip();
      const P = [[0, 0], [0, -CH * .62], [CW * .25, -CH * .28], [CW * .5, -CH], [CW * .75, -CH * .28], [CW, -CH * .62], [CW, 0]];
      co.lineJoin = 'round'; co.beginPath(); P.forEach(([x, y], i) => (i ? co.lineTo(x, y) : co.moveTo(x, y))); co.closePath();
      co.fillStyle = '#111'; co.save(); co.translate(CH * .08, CH * .1); co.fill(); co.restore(); // ombre portée
      co.fillStyle = '#facc15'; co.fill(); co.lineWidth = Math.max(2, CH * .12); co.strokeStyle = '#111'; co.stroke();
      co.fillStyle = 'rgba(255,255,255,.6)'; co.fillRect(CW * .08, -CH * .5, CW * .05, CH * .38); // reflet
      [[0, -CH * .62], [CW * .5, -CH], [CW, -CH * .62]].forEach(([x, y]) => { co.beginPath(); co.arc(x, y, CH * .12, 0, TAU); co.fillStyle = '#fff'; co.fill(); co.lineWidth = Math.max(1, CH * .07); co.stroke(); });
      [[CW * .22, '#f472b6'], [CW * .5, '#22d3ee'], [CW * .78, '#a3e635']].forEach(([x, c]) => { co.beginPath(); co.arc(x, -CH * .17, CH * .1, 0, TAU); co.fillStyle = c; co.fill(); co.lineWidth = Math.max(1, CH * .06); co.stroke(); });
      co.restore();
    };
    // un nuage de peinture : de la buse jusqu'au mur en 0,1 à 0,2 s, puis il s'étale sur place et s'efface
    const sprayTo = (x, y, col, n, spread) => {
      const nz = nozzle();
      for (let i = Math.round(n * q); i > 0; i--) {
        const tx = x + rnd(-spread, spread), ty = y + rnd(-spread, spread) * .8, life = rnd(.1, .2);
        mist.add({ x: nz.x, y: nz.y, vx: (tx - nz.x) / life, vy: (ty - nz.y) / life, max: life + rnd(.15, .35), stop: life, size: card.h * rnd(.05, .12), c: col });
      }
    };
    return {
      frame(tt, dt) {
        t = tt;
        const SL = slotsA(env).filter(s => !s.gone), next = SL.find(s => !s.on);
        // où va la bombe : en haut à droite du prochain chiffre, sinon sortie à droite (ou le trajet de la couronne)
        if (can.path) {
          const P = can.path; P.k = Math.min(1, P.k + dt / P.d);
          const at = crownPt(P.k * CW, -CH * .45), above = crownPt(P.k * CW + CH * .4, -CH * 1.45);
          can.tx = above.x; can.ty = above.y + Math.sin(P.k * 14) * CH * .08;
          if (P.k < 1) sprayTo(at.x, at.y, '#facc15', 2, CH * .3);
          if (P.k >= 1 && !P.end) { P.end = true; for (let i = 0; i < 4; i++) { const sp = crownPt(rnd(0, CW), -CH * rnd(.9, 1.5)); stars.add({ delay: i * .12, life: 1.4, x: sp.x, y: sp.y, r: card.h * rnd(.09, .14) }); } }
          if (P.k >= 1 && t > P.leave) can.path = null;
        } else if (!done && next) { can.tx = next.x + next.w * .8; can.ty = next.top - S * .12; }
        else { can.tx = card.x + card.w + S * .9; can.ty = card.y + card.h * .15; }
        const kk = Math.min(1, dt * (can.path ? 16 : 7));
        can.x += (can.tx - can.x) * kk; can.y += (can.ty - can.y) * kk;
        // la buse vise le chiffre (ou le bas de la couronne) ; secouée pendant la tension
        const aimX = can.path ? can.x - S * .5 : next && !done ? next.x : can.x - S, aimY = can.path ? can.y + S : next && !done ? (next.top + next.bottom) / 2 : can.y + S;
        let want = Math.atan2(aimX - can.x, -(aimY - can.y));
        if (done && !can.path) want = -.35 + Math.sin(t * 1.5) * .05;
        can.ang += (want - can.ang) * Math.min(1, dt * 9);
        const shake = build ? Math.sin(t * 46) * S * .1 : Math.sin(t * 2.6) * S * .025;
        can.y += shake - can.shake; can.shake = shake;
        if (can.spray > 0) { can.spray -= dt; if (can.target) sprayTo(can.target.x, can.target.y, can.col, 2, card.h * .2); }
        // les gouttelettes restées sur le mur (dans la carte, derrière les chiffres)
        for (const s of specks) { const sl = SL.find(x => x.i === s.i); if (!sl) continue; ci.globalAlpha = s.a; ci.fillStyle = s.c; ci.beginPath(); ci.arc(sl.x - card.x + s.dx, (sl.top + sl.bottom) / 2 - card.y + s.dy, s.r, 0, TAU); ci.fill(); }
        ci.globalAlpha = 1;
        // l'explosion de couleurs (Mythic) et les éclaboussures, derrière la carte, jamais dessous (rareté, XP)
        if (streaks.n || splats.n) behind(env, () => {
          streaks.run(dt, (s, k2) => {
            const g2 = outCubic(clamp(k2 * 4)), a = Math.min(1, (1 - k2) * 2.5);
            co.globalAlpha = a * .95;
            for (const r of s.rays) {
              // une giclée en pointe : large près de la carte, effilée, et sa goutte un peu plus loin
              const ca = Math.cos(r.a), sa = Math.sin(r.a), x1 = cx + ca * card.w * .42, y1 = card.y + card.h / 2 + sa * card.h * .42, L2 = r.len * g2;
              co.fillStyle = r.c; co.beginPath(); co.moveTo(x1 - sa * r.w, y1 + ca * r.w);
              co.quadraticCurveTo(x1 + ca * L2 * .5 - sa * r.w * .45, y1 + sa * L2 * .5 + ca * r.w * .45, x1 + ca * L2, y1 + sa * L2);
              co.quadraticCurveTo(x1 + ca * L2 * .5 + sa * r.w * .45, y1 + sa * L2 * .5 - ca * r.w * .45, x1 + sa * r.w, y1 - ca * r.w); co.closePath(); co.fill();
              co.beginPath(); co.arc(x1 + ca * L2 * 1.15, y1 + sa * L2 * 1.15, r.w * .45, 0, TAU); co.fill();
            }
          });
          splats.run(dt, drawSplat);
        }, true);
        co.globalAlpha = 1;
        // la brume de peinture qui file de la buse vers le mur, puis s'étale et s'efface
        mist.step(dt);
        mist.each((m, k2) => { if (m.life > m.stop) m.vx = m.vy = 0; dot(co, m.c, m.x, m.y, m.size * (1 + 2 * k2), (1 - k2) * .5); });
        drops.step(dt);
        drops.each((d, k2) => { co.globalAlpha = 1 - k2; co.fillStyle = d.c; co.beginPath(); co.ellipse(d.x, d.y, d.size * .7, d.size, 0, 0, TAU); co.fill(); });
        crowns.run(dt, (c, k2) => drawCrown(Math.min(1, (k2 * c.life) / .95), Math.min(1, (1 - k2) * 5), c.glow));
        stars.run(dt, (s, k2) => star(s.x, s.y, s.r * outBack(clamp(k2 * 5)) * (1 + .15 * Math.sin(t * 12)), Math.min(1, (1 - k2) * 3)));
        drawCan();
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const SL = slotsA(env).filter(s => !s.gone);
        let sl = SL[0];
        for (const s of SL) if (Math.abs(s.x - p.x) < Math.abs(sl.x - p.x)) sl = s;
        const col = sl ? PAINT[sl.i % 6] : PAINT[0];
        can.col = col; can.target = { x: p.x, y: p.y };
        if (o.ghost) { sprayTo(p.x, p.y, '#9ca3af', 4, card.h * .1); return; }
        sprayTo(p.x, p.y, col, o.last ? 22 : 14, card.h * .22); can.spray = o.last ? .3 : .18;
        // gouttelettes qui restent sur le mur autour de la lettre
        if (sl && specks.length < 160) for (let i = Math.round((o.last ? 16 : 10) * q); i > 0; i--) { const a = rnd(TAU), d = card.h * rnd(.25, .5); specks.push({ i: sl.i, dx: Math.cos(a) * d * .7, dy: Math.sin(a) * d, r: rnd(.5, 1.4), c: col, a: rnd(.35, .7) }); }
        if (o.last) { build = 0; done = true; }
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; done = true;
        if (!p) { // la bombe est vide : pfft, un peu de gris, trois gouttes
          const nz = nozzle();
          for (let i = 0; i < 5; i++) mist.add({ x: nz.x, y: nz.y, vx: rnd(-30, 10), vy: rnd(-10, 20), drag: 3, max: .6, stop: 9, size: card.h * .08, c: '#6b7280' });
          for (let i = 0; i < 3; i++) drops.add({ x: nz.x, y: nz.y, vx: 0, vy: -i * 40, g: 500, max: .7 + i * .15, size: card.h * .04, c: '#9ca3af' });
          return;
        }
        const corners = [[card.x + card.h * .1, card.y + card.h * .05], [card.x + card.w - card.h * .1, card.y + card.h * .05], [card.x - card.h * .25, card.y + card.h * .6], [card.x + card.w + card.h * .25, card.y + card.h * .6]];
        for (let i = 0; i < 1 + Math.round(3 * p); i++) { const [x, y] = corners[i % 4]; stars.add({ delay: .1 + i * .12, life: 1.6, x: x + rnd(-6, 6), y: y + rnd(-6, 6), r: card.h * rnd(.12, .18) }); }
        if (p >= .6) for (let i = Math.round((5 + 8 * p) * q) + 4 * asc; i > 0; i--) { const left = i % 2, y = card.y + card.h * rnd(-.3, 1); makeSplat(left ? card.x - card.h * rnd(.15, .9) : card.x + card.w + card.h * rnd(.15, .9), y, card.h * rnd(.1, .22), pick(PAINT), rnd(0, .4), 2.6 + asc); }
        if (p >= 1) {
          const rays = [];
          for (let i = Math.round(18 * q) + 5 * asc; i > 0; i--) rays.push({ a: rnd(TAU), len: card.h * rnd(.7, 1.6), w: card.h * rnd(.08, .16), c: pick(PAINT) });
          streaks.add({ life: 2.6 + asc, rays });
          for (let i = Math.round(10 * q) + 4 * asc; i > 0; i--) { const a = rnd(TAU); makeSplat(cx + Math.cos(a) * (card.w * .55 + card.h * .5), card.y + card.h / 2 + Math.sin(a) * card.h * 1.3, card.h * rnd(.15, .3), pick(PAINT), rnd(.05, .3), 3 + asc); }
          // la couronne : la bombe vient au-dessus de la carte et la tague de gauche à droite
          can.col = '#facc15';
          can.path = { k: 0, d: .95, leave: t + 1.5 };
          crowns.add({ life: 5 + 1.5 * asc, glow: asc >= 1 });
        }
      },
    };
  };


  // 🕊️ Origami (2026-10-28, idée de JBearr12) — chaque chiffre posé claque à plat (animation CSS ori-unfold) : un filet
  // de lumière file le long du pli du carré et deux ou trois petits triangles de papier de sa couleur sautent en
  // tournoyant. Avant le dernier chiffre, des bouts de papier tournent autour de la carte comme pris dans un courant
  // d'air. Révélation : tirage raté, une boule de papier froissé tombe et roule ; sinon des confettis de papier plié ;
  // dès Epic, deux grues de papier s'envolent des coins ; dès Mythic, chaque carré devient une grue de sa couleur qui
  // décolle de son chiffre et s'envole en vol groupé ; dès Celestial, une grande grue dorée tourne au-dessus de la carte.
  SCENES.origami = env => {
    const { co, card, q, dark } = env;
    const KAMI = [['#f87171', '#dc5050'], ['#fcd34d', '#e5b622'], ['#7dd3fc', '#4cb2e0'], ['#6ee7b7', '#3ccb94'], ['#f9a8d4', '#e97cb7'], ['#c4b5fd', '#9f8bf3']]; // couleurs des cases (.skin-origami .slot:nth-of-type)
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
    const bits = particles(), creases = timed(), cranes = timed(), balls = timed(), gusts = particles();
    let t = 0, build = 0;
    const slotOf = p => { const SL = slotsA(env).filter(s => !s.gone); let b = SL[0]; for (const s of SL) if (Math.abs(s.x - p.x) < Math.abs(b.x - p.x)) b = s; return b; };
    // un petit triangle de papier, deux faces (couleur / dos blanc) : il tourne sur lui-même (l'écrasement suit le cosinus)
    const tri = (b, k) => {
      const flip = Math.cos(b.life * b.flip), s = b.size;
      co.save(); co.globalAlpha = Math.min(1, (1 - k) * 3); co.translate(b.x, b.y); co.rotate(b.rot + b.life * b.spin); co.scale(1, Math.max(.12, Math.abs(flip)));
      co.fillStyle = flip > 0 ? b.c : '#fffdf6'; co.beginPath(); co.moveTo(-s, s * .7); co.lineTo(s, s * .7); co.lineTo(0, -s * .8); co.closePath(); co.fill();
      co.strokeStyle = 'rgba(0,0,0,.25)'; co.lineWidth = .8; co.stroke(); co.restore();
    };
    // une grue de papier vue de profil, bec vers +x : corps en losange, cou et queue en pointes, deux ailes dont la pointe
    // monte et descend (fl de -1 à 1) ; facettes claires et ombrées, comme un vrai pli
    const crane = (x, y, s, fl, cols, ang, a, flipX) => {
      if (a <= .01 || s <= 1) return;
      const [c1, c2] = cols;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(ang); co.scale(flipX ? -s : s, s);
      co.lineJoin = 'round'; co.lineWidth = .03; co.strokeStyle = 'rgba(15,23,42,.45)';
      const poly = (pts, c) => { co.fillStyle = c; co.beginPath(); pts.forEach(([px, py], i) => (i ? co.lineTo(px, py) : co.moveTo(px, py))); co.closePath(); co.fill(); co.stroke(); };
      const wy = -.05 - .85 * fl, wx = -.04 + .1 * fl;
      poly([[-.12, -.04], [.14, -.04], [wx + .12, wy]], c2); // l'aile du fond, ombrée
      poly([[-.62, -.52], [-.12, .02], [-.28, .06]], c2); // la queue
      poly([[.6, -.56], [.15, .02], [.3, .06]], c1); // le cou
      poly([[.6, -.56], [.76, -.5], [.58, -.48]], c2); // la tête et le bec
      poly([[-.36, .02], [0, -.12], [.36, .02], [0, .16]], c1); // le corps
      poly([[0, -.12], [.36, .02], [0, .16]], c2);
      poly([[-.2, 0], [.16, 0], [wx, wy + .1]], c1); // l'aile de devant, claire
      co.restore();
    };
    return {
      frame(tt, dt) {
        t = tt;
        // le courant d'air de la tension : de petits bouts de papier tournent autour de la carte
        if (build && Math.random() < dt * 22 * q) { const a = rnd(TAU); gusts.add({ x: cx + Math.cos(a) * card.w * .62, y: cy + Math.sin(a) * card.h * 1.1, vx: -Math.sin(a) * card.h * 3, vy: Math.cos(a) * card.h * 1.2, drag: .4, max: rnd(.5, .9), size: card.h * rnd(.05, .08), rot: rnd(TAU), spin: rnd(-8, 8), flip: rnd(8, 14), c: pick(KAMI)[0] }); }
        gusts.step(dt); gusts.each(tri);
        // le filet de lumière qui court le long du pli d'un carré, du coin bas gauche au coin haut droit
        creases.run(dt, (c, k) => {
          const u = outCubic(clamp(k * 1.6)), x1 = c.x - c.w / 2, y1 = c.bottom, x2 = c.x + c.w / 2, y2 = c.top;
          const hx = lerp(x1, x2, u), hy = lerp(y1, y2, u);
          co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
          tail(co, '#ffffff', lerp(x1, x2, Math.max(0, u - .45)), lerp(y1, y2, Math.max(0, u - .45)), hx, hy, 1.6, (1 - k) * .9);
          dot(co, '#ffffff', hx, hy, c.w * .22, (1 - k) * .7);
          co.globalCompositeOperation = 'source-over';
        });
        bits.step(dt); bits.each(tri);
        // la boule de papier froissé (tirage raté) : elle tombe du haut de la carte, rebondit et roule
        balls.run(dt, (b, k) => {
          const life = k * b.life, fall = Math.min(1, life / .5), x = b.x + Math.max(0, life - .5) * card.h * .9, y = life < .5 ? lerp(card.y - card.h * .6, b.ground, fall * fall) : b.ground - Math.abs(Math.sin((life - .5) * 7)) * card.h * .15 * Math.exp(-(life - .5) * 3);
          const r = card.h * .14;
          co.save(); co.globalAlpha = Math.min(1, (1 - k) * 4); co.translate(x, y); co.rotate(life * 5);
          co.fillStyle = '#f5f0e3'; co.beginPath(); for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU, rr = r * (i % 2 ? .82 : 1); co.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } co.closePath(); co.fill();
          co.strokeStyle = 'rgba(87,83,78,.6)'; co.lineWidth = 1; co.stroke();
          co.beginPath(); co.moveTo(-r * .5, -r * .2); co.lineTo(r * .1, r * .1); co.lineTo(r * .4, -r * .4); co.moveTo(-r * .2, r * .5); co.lineTo(r * .1, r * .1); co.stroke();
          co.restore();
        });
        // les grues : chacune suit sa trajectoire (départ au chiffre, montée en courbe, sortie), grandit au décollage
        cranes.run(dt, (c, k) => {
          const u = k, e = outCubic(clamp(u * 1.4));
          const x = c.x0 + (c.x1 - c.x0) * e + Math.sin(u * 6 + c.ph) * card.h * .15, y = c.y0 + (c.y1 - c.y0) * e - Math.sin(u * Math.PI) * card.h * c.arc;
          const s = c.s * (c.grow ? .35 + .65 * outBack(clamp(u * 4)) : 1), fl = Math.sin(t * c.rate + c.ph);
          const a = Math.min(1, u * 12, (1 - u) * 4);
          const draw = () => {
            if (c.halo) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#fde68a', x, y, s * 1.4, a * (dark ? .5 : .3)); co.globalCompositeOperation = 'source-over'; }
            crane(x, y + fl * s * .06, s, fl, c.cols, (c.x1 > c.x0 ? 1 : -1) * -.15 + Math.cos(u * 6 + c.ph) * .1, a, c.x1 < c.x0);
          };
          if (c.back) behind(env, draw, true); else draw(); // la grande grue dorée passe derrière la carte : les chiffres restent lisibles
        });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        const sl = slotOf(p);
        if (!sl) return;
        if (!o.ghost) creases.add({ x: sl.x, w: sl.w * .9, top: sl.top + (sl.bottom - sl.top) * .05, bottom: sl.bottom - (sl.bottom - sl.top) * .05, life: .45, delay: .4 }); // au moment où le carré claque (ori-snap, 48 % de 0,86 s)
        const col = KAMI[sl.i % 6][0];
        for (let i = o.ghost ? 1 : o.last ? 5 : 3; i > 0; i--) bits.add({ x: sl.x + rnd(-.3, .3) * sl.w, y: sl.top, vx: rnd(-1, 1) * card.h * 1.2, vy: -card.h * rnd(2, 3.4), g: card.h * 9, drag: .5, max: rnd(.6, 1), size: card.h * rnd(.05, .09), rot: rnd(TAU), spin: rnd(-10, 10), flip: rnd(8, 16), c: o.ghost ? '#94a3b8' : col });
        if (o.last) build = 0;
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { balls.add({ life: 2.6, x: card.x + card.w * .55, ground: card.y - card.h * .12 }); return; } // elle roule sur le bord haut : jamais devant les chiffres
        // confettis de papier plié (peu dès Mythic : ce sont les grues qui comptent, et le jeu lance déjà ses confettis)
        for (let i = p >= 1 ? Math.round(8 * q) : burst(p, 34 * q, 6); i > 0; i--) { const c = pick(KAMI); bits.add({ x: cx + rnd(-.45, .45) * card.w, y: card.y + rnd(0, 1) * card.h, vx: rnd(-1, 1) * card.h * 3, vy: -card.h * rnd(2.5, 5), g: card.h * 6, drag: 1.2, max: rnd(1.2, 2), size: card.h * rnd(.06, .1), rot: rnd(TAU), spin: rnd(-6, 6), flip: rnd(6, 12), c: c[i % 2] }); }
        if (p >= .6 && p < 1) [-1, 1].forEach((side, i) => cranes.add({ delay: .15 + i * .2, life: 2.4, x0: side < 0 ? card.x : card.x + card.w, y0: card.y + card.h * .3, x1: side < 0 ? card.x - card.h * 2.8 : card.x + card.w + card.h * 2.8, y1: card.y + card.h * .1, arc: .35, s: card.h * .8, rate: 11, ph: i * 2, cols: KAMI[(i * 3) % 6], grow: true }));
        if (p >= 1) {
          // chaque carré devient une grue de sa couleur qui décolle du haut de son chiffre ; vol groupé sur les côtés, à la
          // hauteur de la carte (au-dessus, la barre du haut de la page les couperait)
          const SL = slotsA(env).filter(s => !s.gone && !s.ghost);
          SL.forEach((s, i) => {
            const right = i >= SL.length / 2, rank = right ? i - Math.floor(SL.length / 2) : Math.floor(SL.length / 2) - 1 - i;
            cranes.add({ delay: .1 + i * .11, life: 2.8 + .4 * asc, x0: s.x, y0: s.top, x1: right ? card.x + card.w + card.h * (1.6 + rank * .5) : card.x - card.h * (1.6 + rank * .5), y1: card.y + card.h * (-.15 + (rank % 3) * .45), arc: .35 + (i % 2) * .15, s: card.h * .95, rate: 12 + i, ph: i * 1.3, cols: KAMI[s.i % 6], grow: true });
          });
          if (asc >= 1) cranes.add({ delay: .9, life: 4 + asc, x0: card.x - card.h * 1.6, y0: card.y + card.h * .2, x1: card.x + card.w + card.h * 1.8, y1: card.y + card.h * .1, arc: .35, s: card.h * (1 + .15 * asc), rate: 7, ph: 0, cols: ['#fde68a', '#d4a017'], halo: true, back: true });
        }
      },
    };
  };


  // 🌮 Taco (2026-10-28, idée de sennybex1) — quand une garniture s'écrase dans sa coque (38 % de l'animation CSS
  // taco-drop, 0,24 s après la pose), des bouts de garniture giclent : lanières de salade, bâtonnets de fromage, dés de
  // tomate et d'oignon, qui tournent et retombent. Avant le dernier chiffre, la vapeur d'un taco tout chaud monte de la
  // carte. Révélation : tirage raté, une seule feuille de salade descend tristement en se balançant ; sinon des
  // confettis de fête et des garnitures ; dès Epic, deux tacos sautent des coins de la carte en faisant un salto ; dès
  // Mythic, une pluie de tacos tombe en tournoyant derrière la carte (plus dense et plus longue au-delà).
  SCENES.taco = env => {
    const { co, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    const bits = particles(), steam = particles(), confetti = particles(), leaves = particles(), tacos = particles(), pending = [], hops = timed();
    const emit = emitter(), rain = emitter();
    const PARTY = ['#f472b6', '#facc15', '#a78bfa', '#fb923c', '#22d3ee'];
    let t = 0, build = 0, rainEnd = 0, rainRate = 0;
    // un bout de garniture : salade (lanière verte ondulée), fromage (bâtonnet jaune), tomate (dé rouge), oignon (dé blanc)
    const KINDS = [['leaf', '#4ade80'], ['leaf', '#22c55e'], ['cheese', '#facc15'], ['cheese', '#fde047'], ['dice', '#ef4444'], ['dice', '#dc2626'], ['dice', '#f8fafc']];
    const fling = (x, y, n, up) => {
      for (let i = Math.round(n * q); i > 0; i--) {
        const [kind, c] = pick(KINDS);
        bits.add({ x: x + rnd(-1, 1) * card.h * .12, y, vx: rnd(-1, 1) * card.h * 2.2, vy: -card.h * rnd(.6, 1) * up, g: card.h * 11, drag: .4, max: rnd(.55, .9), size: card.h * rnd(.06, .09), rot: rnd(TAU), spin: rnd(-12, 12), kind, c });
      }
    };
    const drawBit = (b, k) => {
      const s = b.size;
      co.save(); co.globalAlpha = Math.min(1, (1 - k) * 3); co.translate(b.x, b.y); co.rotate(b.rot + b.life * b.spin);
      co.fillStyle = b.c; co.strokeStyle = 'rgba(59,29,10,.55)'; co.lineWidth = 1;
      if (b.kind === 'leaf') { co.beginPath(); co.moveTo(-s * 1.4, 0); co.quadraticCurveTo(-s * .7, -s, 0, 0); co.quadraticCurveTo(s * .7, s, s * 1.4, 0); co.quadraticCurveTo(s * .7, s * .4, 0, s * .45); co.quadraticCurveTo(-s * .7, -s * .5, -s * 1.4, 0); co.fill(); co.stroke(); }
      else if (b.kind === 'cheese') { co.fillRect(-s * 1.3, -s * .3, s * 2.6, s * .6); co.strokeRect(-s * 1.3, -s * .3, s * 2.6, s * .6); }
      else { roundRect(co, -s * .6, -s * .6, s * 1.2, s * 1.2, s * .25); co.fill(); co.stroke(); }
      co.restore();
    };
    // un taco vu de côté : la garniture qui dépasse en haut (salade, tomate, fromage) puis la coque en demi-lune dorée
    const taco = (x, y, s, rot, a) => {
      if (a <= .01) return;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot);
      co.lineJoin = 'round'; co.lineWidth = Math.max(1, s * .05); co.strokeStyle = '#78350f';
      co.fillStyle = '#22c55e';
      for (let i = 0; i < 6; i++) { co.beginPath(); co.arc(-s * .4 + i * s * .16, -s * .06 - Math.sin((i / 5) * Math.PI) * s * .05, s * .11, 0, TAU); co.fill(); }
      co.fillStyle = '#ef4444'; co.fillRect(-s * .2, -s * .24, s * .12, s * .12); co.fillRect(s * .12, -s * .26, s * .12, s * .12);
      co.strokeStyle = '#fde047'; co.lineWidth = Math.max(1, s * .045); co.lineCap = 'round';
      [[-.3, -.1, -.2, -.25], [0, -.1, .08, -.27], [.28, -.1, .36, -.24]].forEach(([a1, b1, a2, b2]) => { co.beginPath(); co.moveTo(s * a1, s * b1); co.lineTo(s * a2, s * b2); co.stroke(); });
      co.lineCap = 'butt'; co.strokeStyle = '#78350f'; co.lineWidth = Math.max(1, s * .05);
      const g = co.createLinearGradient(0, -s * .05, 0, s * .42); g.addColorStop(0, '#fcd34d'); g.addColorStop(1, '#d97706');
      co.fillStyle = g; co.beginPath(); co.moveTo(-s * .5, -s * .04); co.ellipse(0, -s * .04, s * .5, s * .44, 0, Math.PI, 0, true); co.closePath(); co.fill(); co.stroke();
      co.fillStyle = '#b45309'; [[-.22, .12], [.05, .26], [.24, .08], [-.05, .05]].forEach(([dx, dy]) => { co.beginPath(); co.arc(s * dx, s * dy, s * .03, 0, TAU); co.fill(); });
      co.restore();
    };
    return {
      frame(tt, dt) {
        t = tt;
        // les impacts en attente (le chiffre tombe d'abord : les garnitures giclent au moment où il touche la coque)
        for (let i = pending.length - 1; i >= 0; i--) if (t >= pending[i].at) { const p = pending[i]; fling(p.x, p.y, p.n, p.up); pending.splice(i, 1); }
        // la vapeur de la tension : de fines volutes au-dessus de la carte
        if (build) for (let m = emit(10 * q, dt); m > 0; m--) steam.add({ x: card.x + card.w * rnd(.15, .85), y: card.y + card.h * .2, vx: rnd(-6, 6), vy: -card.h * rnd(.7, 1.1), drag: .3, g: -card.h * .2, max: rnd(.9, 1.4), size: card.h * rnd(.05, .08), ph: rnd(TAU) });
        steam.step(dt);
        steam.each((s, k) => { const r = s.size * (1 + k * 1.2); dot(co, dark ? '#f8fafc' : '#94a3b8', s.x + Math.sin(s.life * 5 + s.ph) * card.h * (.05 + .1 * k), s.y, r, Math.sin(Math.PI * k) * (dark ? .2 : .3), r * 2.6); });
        // la pluie de tacos (Mythic) : ils tombent derrière la carte en tournoyant
        if (t < rainEnd) for (let m = rain(rainRate * q, dt); m > 0; m--) tacos.add({ x: cx + rnd(-1, 1) * (card.w * .5 + card.h * 2.4), y: card.y - card.h * rnd(1.4, 2.2), vx: rnd(-20, 20), vy: card.h * rnd(.5, 1.5), g: card.h * 5, max: rnd(1.6, 2.2), size: card.h * rnd(.45, .75), rot: rnd(TAU), spin: rnd(-4, 4) });
        tacos.step(dt);
        if (tacos.n) behind(env, () => tacos.each((c, k) => taco(c.x, c.y, c.size, c.rot + c.life * c.spin, Math.min(1, (1 - k) * 4))));
        // les deux tacos qui sautent des coins (Epic et plus) : un saut en cloche avec un salto, puis ils retombent
        hops.run(dt, (h, k) => {
          const x = h.x + h.dir * k * card.h * .55, y = card.y + card.h * .8 - Math.sin(k * Math.PI) * card.h * .75; // un petit saut : au-dessus, la barre du haut de la page
          if (!h.splash && k > .9) { h.splash = true; fling(x, card.y + card.h * .75, 6, 1.4); }
          taco(x, y, card.h * .7, h.dir * k * TAU, Math.min(1, (1 - k) * 8, k * 10));
        });
        confetti.step(dt);
        confetti.each((c, k) => { co.save(); co.globalAlpha = Math.min(1, (1 - k) * 4); co.translate(c.x + Math.sin(t * 3 + c.ph) * 5, c.y); co.rotate(c.rot + c.life * c.spin); co.scale(Math.cos(c.life * c.flip), 1); co.fillStyle = c.c; co.fillRect(-c.size, -c.size * .5, c.size * 2, c.size); co.restore(); });
        bits.step(dt); bits.each(drawBit);
        leaves.step(dt);
        leaves.each((l, k) => { l.vx = Math.sin(l.life * 2.6) * card.h * 1.1; l.vy = card.h * .35; drawBit(l, k * .7); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.last) build = 0;
        pending.push({ at: t + .24, x: p.x, y: p.y + card.h * .18, n: o.ghost ? 1 : o.last ? 16 : 10, up: o.last ? 2.6 : 2 });
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0;
        if (!p) { leaves.add({ x: cx + card.w * .2, y: card.y - card.h * .3, vx: 0, vy: 0, max: 2.4, size: card.h * .09, rot: 0, spin: .8, kind: 'leaf', c: '#4ade80' }); return; }
        for (let i = burst(p, 50 * q, 8) + 20 * asc; i > 0; i--) confetti.add({ x: cx + rnd(-.6, .6) * card.w, y: card.y + card.h * rnd(0, .6), vx: rnd(-1, 1) * card.h * 2.5, vy: -card.h * rnd(2, 4.5), g: card.h * 4, drag: 1.4, max: rnd(1.4, 2.4), size: card.h * rnd(.04, .07), rot: rnd(TAU), spin: rnd(-5, 5), flip: rnd(6, 12), ph: rnd(TAU), c: pick(PARTY) });
        fling(cx, card.y + card.h * .4, 6 + 10 * p, 3);
        if (p >= .6) [-1, 1].forEach((dir, i) => hops.add({ delay: .15 + i * .2, life: .9, x: dir < 0 ? card.x + card.h * .2 : card.x + card.w - card.h * .2, dir }));
        if (p >= 1) { rainRate = 16 + 6 * asc; rainEnd = t + 2.4 + 1.2 * asc; }
      },
    };
  };


  // 🏖️ Beach (2026-10-28, idée de furcoat0 ; assortie au fond Windy Beach) — dans la carte, des reflets de soleil
  // scintillent sur la bande de mer. Un petit crabe orange marche de côté sur le bord haut de la carte (au ras de l'eau),
  // au-dessus du prochain chiffre ; quand l'écume se retire d'un chiffre (animation CSS bch-recede), il lève les pinces,
  // des bulles d'écume éclatent sur le sable et quelques gouttes sautent ; puis il file au suivant. Avant le dernier
  // chiffre, il trépigne. Révélation : tirage raté, une vague le renverse sur le dos (il gigote, puis se remet) ; sinon il
  // danse ; dès Epic, des gerbes d'eau et des scintillements ; dès Mythic, une grande vague turquoise scintillante se
  // dresse derrière la carte (sa crête d'écume court de gauche à droite) et le soleil se couche derrière le nombre (lueur
  // orange et rose, la mer de la carte rougeoie) ; dès Celestial, des mouettes passent.
  SCENES.beach = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2, SEA = h * .25; // hauteur de la bande de mer dans la carte (dégradé CSS : 25 %)
    const drops = particles(), bubbles = timed(), waves = timed(), suns = timed(), gulls = timed(), glints = [];
    for (let i = 0; i < 7; i++) glints.push({ x: rnd(.05, .95), y: rnd(.12, .8), ph: rnd(TAU), v: rnd(1.5, 3) });
    const S = card.h * .5; // largeur du crabe
    const crab = { x: card.x - S * 1.5, tx: 0, v: 0, claw: 0, flip: 0, dance: 0, dir: 1 };
    let t = 0, build = 0, done = false;
    const drawCrab = () => {
      const s = S, walk = Math.abs(crab.v) > 4 ? t * 26 : build ? t * 40 : 0, up = crab.dance > 0 ? Math.abs(Math.sin(t * 9)) * s * .18 : 0;
      const y = card.y + 2 - up;
      co.save(); co.translate(crab.x, y + (crab.flip ? -s * .1 : 0)); if (crab.flip) co.scale(1, -1);
      co.lineCap = 'round'; co.lineJoin = 'round'; co.strokeStyle = '#9a3412'; co.lineWidth = Math.max(1.2, s * .06);
      // les pattes : trois de chaque côté, qui battent en décalé
      for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
        const ph = Math.sin(walk + i * 2.1 + (side > 0 ? 1 : 0)) * s * .06, x0 = side * s * (.22 + i * .07), y0 = s * .05;
        co.beginPath(); co.moveTo(x0, y0); co.lineTo(side * s * (.42 + i * .1), s * (.12 + ph / s)); co.lineTo(side * s * (.5 + i * .1), s * (.28 + i * .02)); co.stroke();
      }
      // les pinces : bras qui se lèvent (claw de 0 à 1), pince ronde avec son encoche
      const raise = Math.max(crab.claw, crab.dance > 0 ? .5 + .5 * Math.sin(t * 9) : 0);
      for (const side of [-1, 1]) {
        const ax = side * s * .3, ay = -s * .04, hx = side * s * (.46 + .06 * raise), hy = -s * (.12 + .32 * raise);
        co.beginPath(); co.moveTo(ax, ay); co.quadraticCurveTo(side * s * .5, -s * .02, hx, hy); co.stroke();
        const open = .35 + .3 * Math.abs(Math.sin(t * (raise > .2 ? 16 : 3)));
        co.fillStyle = '#ef4444'; co.beginPath(); co.moveTo(hx, hy); co.arc(hx, hy, s * .15, -Math.PI / 2 + open, -Math.PI / 2 - open + TAU); co.closePath(); co.fill(); co.stroke();
      }
      // le corps, les yeux sur leurs tiges
      co.fillStyle = '#f97316'; co.beginPath(); co.ellipse(0, 0, s * .32, s * .2, 0, 0, TAU); co.fill(); co.stroke();
      co.fillStyle = 'rgba(255,237,213,.55)'; co.beginPath(); co.ellipse(-s * .06, -s * .07, s * .14, s * .05, 0, 0, TAU); co.fill();
      for (const side of [-1, 1]) {
        co.beginPath(); co.moveTo(side * s * .09, -s * .15); co.lineTo(side * s * .12, -s * .3); co.stroke();
        co.fillStyle = '#fff'; co.beginPath(); co.arc(side * s * .12, -s * .32, s * .065, 0, TAU); co.fill(); co.stroke();
        co.fillStyle = '#111'; co.beginPath(); co.arc(side * s * .12 + crab.dir * s * .02, -s * .32, s * .03, 0, TAU); co.fill();
      }
      co.restore();
    };
    return {
      frame(tt, dt) {
        t = tt;
        // les reflets du soleil sur la mer de la carte (derrière les chiffres)
        ci.globalCompositeOperation = 'lighter';
        for (const g of glints) { const a = Math.max(0, Math.sin(t * g.v + g.ph)); dot(ci, '#ffffff', g.x * w, g.y * SEA, 2.2 + 2 * a, a * .8, 1.2 + a); }
        ci.globalCompositeOperation = 'source-over';
        // les bulles d'écume qui éclatent sur le sable, là où l'eau vient de se retirer
        bubbles.run(dt, (b, k) => { ci.globalAlpha = (1 - k) * .9; ci.strokeStyle = '#ffffff'; ci.lineWidth = 1; ci.beginPath(); ci.arc(b.x, b.y - k * 3, b.r * (1 + k), 0, TAU); ci.stroke(); });
        ci.globalAlpha = 1;
        // le coucher de soleil (Mythic) : la mer de la carte rougeoie, une colonne de reflets dorés
        suns.run(dt, (s, k) => {
          const a = Math.min(1, k * 4, (1 - k) * 3);
          const g = ci.createLinearGradient(0, 0, 0, SEA * 1.1); g.addColorStop(0, 'rgba(244,114,182,.55)'); g.addColorStop(.6, 'rgba(251,146,60,.5)'); g.addColorStop(1, 'rgba(251,146,60,0)');
          ci.globalAlpha = a; ci.fillStyle = g; ci.fillRect(0, 0, w, SEA * 1.1);
          ci.fillStyle = '#fde68a';
          for (let i = 0; i < 5; i++) { const yy = SEA * (.2 + i * .15), ww = w * (.05 + .03 * Math.sin(t * 4 + i * 2)) * (1 - i * .1); ci.globalAlpha = a * (.8 - i * .1); ci.fillRect(w / 2 - ww / 2, yy, ww, 1.5); }
          ci.globalAlpha = 1;
          // derrière la carte : la lueur et le soleil qui descend derrière le nombre
          behind(env, () => {
            co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
            dot(co, '#fb923c', cx, card.y + card.h * .3, card.w * .75, a * (dark ? .55 : .4), card.h * 1.6);
            dot(co, '#f472b6', cx - card.w * .3, card.y, card.w * .45, a * (dark ? .35 : .25), card.h);
            co.globalCompositeOperation = 'source-over';
            const r = card.h * .5, sy = card.y + card.h * (-.1 + .45 * clamp(k * 1.2));
            const sg = co.createRadialGradient(cx, sy, 0, cx, sy, r); sg.addColorStop(0, '#fef3c7'); sg.addColorStop(.6, '#fdba74'); sg.addColorStop(1, '#fb923c');
            co.globalAlpha = a; co.fillStyle = sg; co.beginPath(); co.arc(cx, sy, r, 0, TAU); co.fill();
          }, true);
        });
        // la grande vague (Mythic) : elle se dresse derrière la carte, sa crête d'écume court de gauche à droite
        waves.run(dt, (wv, k) => {
          const rise = outCubic(clamp(k * 3)) * (1 - clamp((k - .72) * 3.6)), curlX = card.x - card.h * 2 + (card.w + card.h * 4) * clamp(k * 1.25);
          if (rise <= .01) return;
          // une bosse de houle autour de la carte : haute au milieu, retombée à zéro aux deux bouts (pas un mur d'eau)
          const x0 = card.x - card.h * 1.9, x1 = card.x + card.w + card.h * 1.9, base = card.y + card.h * 1.05, top = (x) => {
            const d = (x - curlX) / (card.h * .9), env2 = Math.pow(Math.sin(Math.PI * clamp((x - x0) / (x1 - x0))), .7);
            return base - env2 * (base - card.y + rise * card.h * (wv.hgt + .08 * Math.sin(x * .06 + t * 3) + .3 * Math.exp(-d * d)) - card.h * .2);
          };
          behind(env, () => {
            const g = co.createLinearGradient(0, card.y - card.h * wv.hgt, 0, base);
            g.addColorStop(0, '#a5f3fc'); g.addColorStop(.3, '#22d3ee'); g.addColorStop(.7, 'rgba(2,132,199,.75)'); g.addColorStop(1, 'rgba(3,105,161,0)');
            co.globalAlpha = .9 * Math.min(1, rise * 2); co.fillStyle = g; co.beginPath(); co.moveTo(x0, base);
            for (let x = x0; x <= x1; x += 6) co.lineTo(x, top(x));
            co.lineTo(x1, base); co.closePath(); co.fill();
            // la crête d'écume et ses paquets de mousse
            co.strokeStyle = '#ffffff'; co.lineWidth = Math.max(2, card.h * .07); co.lineJoin = 'round'; co.beginPath();
            for (let x = x0; x <= x1; x += 6) (x === x0 ? co.moveTo(x, top(x)) : co.lineTo(x, top(x)));
            co.stroke();
            co.fillStyle = '#ffffff';
            for (let x = x0 + 4; x <= x1; x += card.h * .22) { const y = top(x), near = Math.exp(-Math.pow((x - curlX) / (card.h * .9), 2)); co.globalAlpha = Math.min(1, rise * 2) * (.5 + .5 * near); co.beginPath(); co.arc(x, y - near * card.h * .06, card.h * (.04 + .06 * near), 0, TAU); co.fill(); }
            // le scintillement : des éclats qui glissent sur la face de la vague
            co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
            for (let i = 0; i < 18; i++) {
              const x = x0 + ((i * 97.3 + t * card.h * 1.4) % (x1 - x0)), y = top(x) + card.h * (.15 + (i % 4) * .14), a = Math.max(0, Math.sin(t * 7 + i * 1.7)) * rise;
              if (y > base - card.h * .15) continue;
              dot(co, '#ffffff', x, y, card.h * .13, a, card.h * .035); dot(co, '#ffffff', x, y, card.h * .03, a, card.h * .1); // un éclat en croix
            }
            co.globalCompositeOperation = 'source-over';
          }, true);
          if (k > .2 && k < .8 && Math.random() < .6) drops.add({ x: curlX + rnd(-1, 1) * card.h * .3, y: top(curlX), vx: rnd(-40, 80), vy: -rnd(40, 140), g: 420, max: rnd(.5, .9), size: rnd(1.4, 2.6) });
        });
        // les mouettes (Celestial et plus) : deux arcs qui battent
        gulls.run(dt, (gl, k) => {
          const x = lerp(gl.x0, gl.x1, k), y = gl.y + Math.sin(k * 6) * card.h * .1, fl = Math.sin(t * 9 + gl.ph) * .5, s = gl.s;
          co.globalAlpha = Math.min(1, k * 6, (1 - k) * 6); co.strokeStyle = dark ? '#f8fafc' : '#334155'; co.lineWidth = 2; co.lineCap = 'round';
          co.beginPath(); co.moveTo(x - s, y - s * fl * .6); co.quadraticCurveTo(x - s * .5, y - s * (.5 + fl * .4), x, y); co.quadraticCurveTo(x + s * .5, y - s * (.5 + fl * .4), x + s, y - s * fl * .6); co.stroke();
        });
        co.globalAlpha = 1;
        // les gouttes d'eau
        drops.step(dt);
        co.fillStyle = dark ? '#e0f2fe' : '#0284c7';
        drops.each((d, k) => { co.globalAlpha = 1 - k; co.beginPath(); co.arc(d.x, d.y, d.size, 0, TAU); co.fill(); });
        co.globalAlpha = 1;
        // le crabe : il suit le prochain chiffre le long du bord haut, puis va attendre à droite
        const SL = slotsA(env).filter(s => !s.gone), next = SL.find(s => !s.on);
        crab.tx = !done && next ? next.x : card.x + card.w - S * .1;
        const d = crab.tx - crab.x, v = Math.sign(d) * Math.min(Math.abs(d) * 8, card.h * 5);
        crab.v = Math.abs(d) < .5 ? 0 : v; crab.x += crab.v * dt; if (Math.abs(crab.v) > 4) crab.dir = Math.sign(crab.v);
        crab.claw = Math.max(0, crab.claw - dt * 2.2); crab.dance -= dt;
        if (crab.flip) crab.flip = Math.max(0, crab.flip - dt);
        drawCrab();
        co.globalAlpha = 1;
      },
      lock(p, o) {
        if (o.last) { build = 0; done = true; }
        if (o.ghost) return;
        crab.claw = 1;
        // l'eau se retire (environ 0,15 s après la pose) : bulles d'écume sur le sable, autour du haut du chiffre
        const x = p.x - card.x - (card.w - w) / 2, y = p.y - card.y - card.h * .22;
        for (let i = Math.round((o.last ? 12 : 7) * q); i > 0; i--) bubbles.add({ delay: .12 + rnd(0, .25), life: rnd(.35, .6), x: x + rnd(-1, 1) * card.h * .3, y: y + rnd(-1, 1) * card.h * .1, r: rnd(1.2, 2.6) });
        for (let i = Math.round((o.last ? 8 : 4) * q); i > 0; i--) drops.add({ x: p.x + rnd(-1, 1) * card.h * .2, y: card.y + 2, vx: rnd(-50, 50), vy: -rnd(60, 150), g: 500, max: rnd(.4, .7), size: rnd(1.2, 2.2) });
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; done = true;
        if (!p) { crab.flip = 1.6; for (let i = 0; i < 8; i++) drops.add({ x: crab.x + rnd(-1, 1) * S * .5, y: card.y, vx: rnd(-60, 60), vy: -rnd(60, 160), g: 500, max: .7, size: rnd(1.4, 2.4) }); return; }
        crab.dance = 1.2 + 2 * p + asc;
        if (p >= .6) for (let i = Math.round((10 + 20 * p) * q); i > 0; i--) { const side = i % 2 ? -1 : 1; drops.add({ x: side < 0 ? card.x + rnd(0, card.h * .3) : card.x + card.w - rnd(0, card.h * .3), y: card.y + card.h * rnd(0, .3), vx: side * rnd(40, 160), vy: -rnd(120, 260), g: 520, max: rnd(.6, 1), size: rnd(1.4, 2.8) }); }
        if (p >= 1) {
          waves.add({ delay: .1, life: 3.4 + .8 * asc, hgt: .45 + .1 * asc });
          suns.add({ delay: 2, life: 5.5 + 1.5 * asc }); // le calme après la vague : le soleil se couche quand elle retombe
        }
        if (asc >= 1) for (let i = 0; i < 1 + asc; i++) gulls.add({ delay: .8 + i * .5, life: 3, x0: card.x - card.h * 2.5, x1: card.x + card.w + card.h * 2.5, y: card.y - card.h * (.05 - i * .12) + (i % 2) * card.h * .4, s: card.h * .22, ph: i * 2 });
      },
    };
  };

  // ==== Skins du 2026-10-28, lot D ====
  // Arcade Fighter et Battleship (idées de 17black), Cone of Destiny et The Observer (idées de Gray alt).

  // 🥊 Arcade Fighter (2026-10-28, idée de 17black) — un jeu de combat de borne d'arcade des années 80. Un petit
  // combattant en pixel art (original : kimono turquoise, bandeau orange) attend en garde sur le haut de la carte,
  // au-dessus du prochain chiffre. Quand le chiffre se pose, il fond dessus (images rémanentes), coup de pied sauté ou
  // coup de poing, arrêt sur image d'un instant (le « hitstop » des jeux de combat), étincelle pixel, puis il rebondit en
  // arrière jusqu'au chiffre suivant. En haut de l'écran, la barre de vie du nombre baisse à chaque coup, un compteur de
  // combo monte. Avant le dernier chiffre, il se ramasse et charge une aura ; le dernier est un super coup (secousse).
  // Révélation : tirage raté, il rate et a la tête qui tourne (MISS) ; sinon HIT! / GREAT! / SUPER! / ULTRA! et il lève
  // le poing ; dès Mythic, la barre se vide : K.O.! en grand, l'écran tremble, éclair et lignes de vitesse ; dès
  // Celestial, PERFECT! en dessous et une pluie de pixels.
  SCENES.fighter = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const cx = card.x + card.w / 2;
    // Les poses, une grille par pose (tournée vers la droite) ; le contour sombre est ajouté tout seul autour.
    const PAL = { h: '#2b1a12', b: '#ff6a1a', s: '#f6b98c', e: '#1b1030', t: '#14b8a6', d: '#0f766e', y: '#facc15', p: '#4338ca', q: '#2e2a7a', g: '#ef4444', w: '#f8fafc' };
    const POSES = {
      idle: { hit: [12, 8], g: [
        '.....hhhh....', '....hhhhhh...', '..bbhhhhhhh..', 'bb.bbbbbbbb..', '....ssssesh..', '....sssssss..', '.....sssss...',
        '...tttttt.gg.', '..tttttttsgg.', '..ttdtttt....', '..gg.yyyy....', '.....pppp....', '....pp..pp...', '...pp....pp..', '...qq....qq..', '..ww....www..'] },
      kick: { hit: [15, 13], g: [
        '...hhhh.........', '..hhhhhh........', 'bbbbbbbbb.......', 'b.sssesss.......', '..sssssss.......', '...sssss..gg....', '..ttttttttgg....',
        '.tttttttt.......', 'gg.tdttt........', 'gg..yyyy........', '....pppppp......', '....pp..ppppp...', '...pp......pppp.', '...qq........ww.', '..ww..........w.'] },
      punch: { hit: [16, 8], g: [
        '.....hhhh.......', '....hhhhhh......', '..bbhhhhhhh.....', 'bb.bbbbbbbb.....', '....ssssesh.....', '....sssssss.....', '.....sssss......',
        '...tttttttssssgg', '..ttttttttssssgg', '..ttdtttt.......', '..gg.yyyy.......', '.....pppp.......', '....ppp.pp......', '...ppp...pp.....', '..qq......qq....', '.ww.......www...'] },
      win: { hit: [11, 0], g: [
        '..........gg.', '..........gg.', '.....hhhh.ss.', '....hhhhhhss.', '..bbhhhhhhhtt', 'bb.bbbbbbbbtt', '....ssssesht.', '....sssssss..',
        '.....sssss...', '...tttttttt..', '..tttttttt...', '..ttdtttt....', '..gg.yyyy....', '.....pppp....', '....pp..pp...', '....qq..qq...', '...ww...www..'] },
    };
    // Chaque pose devient une petite image (1 pixel = 1 case) : en couleurs, et en silhouette claire (images rémanentes).
    const sprite = (g, tint) => {
      const cols = Math.max(...g.map(r => r.length)), c = document.createElement('canvas'); c.width = cols + 2; c.height = g.length + 2;
      const x = c.getContext('2d'), full = (i, j) => j >= 0 && j < g.length && i >= 0 && i < g[j].length && g[j][i] !== '.';
      for (let j = -1; j <= g.length; j++) for (let i = -1; i <= cols; i++) {
        if (full(i, j)) { x.fillStyle = tint || PAL[g[j][i]]; x.fillRect(i + 1, j + 1, 1, 1); }
        else if (full(i - 1, j) || full(i + 1, j) || full(i, j - 1) || full(i, j + 1)) { x.fillStyle = tint ? tint : '#140a26'; x.fillRect(i + 1, j + 1, 1, 1); }
      }
      return c;
    };
    for (const k in POSES) { const P = POSES[k]; P.img = sprite(P.g); P.ghost = sprite(P.g, '#67e8f9'); P.cols = P.img.width; P.rows = P.img.height; }
    const ps = Math.max(2, Math.round(card.h / 19)), snap = v => Math.round(v / ps) * ps;
    const sparks = timed(), words = timed(), trails = timed(), flashes = timed(), lines = timed(), bits = particles(), aura = particles(), stars = particles(), emit = emitter();
    const F = { x: card.x - card.h * 1.2, y: card.y, pose: 'idle', hop: null, atk: null, dizzy: 0, face: 1 };
    let t = 0, build = 0, hits = 0, n = 0, hp = 1, trail = 1, shake = 0, timer = 99, timerOn = true, done = false;
    // (x, y) = les pieds du combattant ; hx/hy : la pose est placée pour que son point d'impact tombe là.
    const drawPose = (pose, x, y, a = 1, ghost = false, rot = 0) => {
      const P = POSES[pose], img = ghost ? P.ghost : P.img;
      co.save(); co.globalAlpha = a; co.imageSmoothingEnabled = false;
      co.translate(snap(x), snap(y)); if (rot) co.rotate(rot); if (F.face < 0) co.scale(-1, 1);
      co.drawImage(img, -P.cols * ps / 2, -P.rows * ps + ps, P.cols * ps, P.rows * ps);
      co.restore();
    };
    // Position des pieds pour que le point d'impact de la pose soit (hx, hy).
    const feetFor = (pose, hx, hy) => { const P = POSES[pose]; return { x: hx - (P.hit[0] + 1 - P.cols / 2) * ps, y: hy + (P.rows - 1 - (P.hit[1] + 1)) * ps }; };
    // En garde au-dessus du prochain chiffre (ou au coin droit de la carte quand tout est posé).
    const post = () => { const S = slotsA(env).filter(s => !s.gone), nx = S.find(s => !s.on); return nx ? { x: nx.x - ps * 3, y: card.y } : { x: card.x + card.w - ps * 5, y: card.y }; };
    const hopTo = (to, d = .34, high = card.h * .5, pose = 'idle') => { F.hop = { x0: F.x, y0: F.y, x1: to.x, y1: to.y, k: 0, d, high, pose }; };
    const ptext = (s, x, y, size, fill, a, align = 'center') => {
      if (a <= .01) return;
      co.save(); co.globalAlpha = Math.min(1, a); co.font = `${Math.round(size)}px "Press Start 2P", ui-monospace, monospace`; co.textAlign = align; co.textBaseline = 'middle';
      co.lineJoin = 'miter'; co.lineWidth = Math.max(2, size * .22); co.strokeStyle = '#140a26';
      co.fillStyle = '#7f1d1d'; co.fillText(s, x + size * .1, y + size * .1); co.strokeText(s, x, y); co.fillStyle = fill; co.fillText(s, x, y); co.restore();
    };
    const pop = k => (k < .04 ? 2 : k < .08 ? 1.5 : k < .12 ? 1.18 : 1); // apparition en paliers, comme un vieux jeu
    hopTo(post(), .5, card.h * .2);
    return {
      frame(tt, dt) {
        t = tt;
        shake = Math.max(0, shake - dt * 2.2);
        const sx = shake > .01 ? snap(rnd(-1, 1) * card.h * .14 * shake) : 0, sy = shake > .01 ? snap(rnd(-1, 1) * card.h * .1 * shake) : 0;
        co.save(); co.translate(sx, sy);
        // ---- l'écran de la borne (dans la carte, derrière les chiffres) : barres de vie et chrono
        if (timerOn && !done) timer = Math.max(0, timer - dt * 2.5);
        trail += (hp - trail) * Math.min(1, dt * (trail > hp + .3 ? 3 : 1.6));
        const bh = Math.max(3, Math.round(h * .07)), by = Math.max(2, Math.round(h * .045)), bw = w * .36;
        ci.save(); ci.translate(sx * .5, sy * .5);
        const bar = (x0, frac, dmg, right) => {
          ci.globalAlpha = .95; ci.fillStyle = '#140a26'; ci.fillRect(x0 - 1, by - 1, bw + 2, bh + 2);
          ci.fillStyle = '#4c1d24'; ci.fillRect(x0, by, bw, bh);
          ci.fillStyle = '#ef4444'; const dw = bw * clamp(dmg); ci.fillRect(right ? x0 + bw - dw : x0, by, dw, bh);
          ci.fillStyle = frac < .3 && Math.sin(t * 18) > 0 ? '#fde68a' : '#facc15'; const fw = bw * clamp(frac); ci.fillRect(right ? x0 + bw - fw : x0, by, fw, bh);
          ci.fillStyle = 'rgba(255,255,255,.35)'; ci.fillRect(right ? x0 + bw - fw : x0, by, fw, Math.max(1, bh * .3));
        };
        bar(w * .04, 1, 1, false); bar(w * .6, hp, trail, true);
        const fs = Math.max(6, Math.round(h * .11));
        ci.font = `${fs}px "Press Start 2P", ui-monospace, monospace`; ci.textAlign = 'center'; ci.textBaseline = 'top'; ci.globalAlpha = .95;
        ci.fillStyle = '#140a26'; ci.fillText(String(Math.ceil(timer)).padStart(2, '0'), w / 2 + 1, by - 1 + 1); ci.fillStyle = timer < 10 ? '#f87171' : '#fef3c7'; ci.fillText(String(Math.ceil(timer)).padStart(2, '0'), w / 2, by - 1);
        flashes.run(dt, (f, k) => { ci.globalAlpha = (1 - k) * f.a; ci.fillStyle = f.c; ci.fillRect(-20, -20, w + 40, h + 40); });
        ci.restore(); ci.globalAlpha = 1;
        // ---- derrière la carte : lignes de vitesse du super coup (Mythic)
        lines.run(dt, (l, k) => behind(env, () => {
          co.globalAlpha = (1 - k) * (dark ? .55 : .45); co.strokeStyle = l.c; co.lineWidth = ps;
          for (let i = 0; i < l.n; i++) { const a = i * TAU / l.n + l.rot, r0 = card.h * (.9 + .4 * Math.sin(i * 7.3)), r1 = r0 + card.h * (1.2 + k * 2.4); co.beginPath(); co.moveTo(cx + Math.cos(a) * r0 * 1.6, card.y + card.h / 2 + Math.sin(a) * r0); co.lineTo(cx + Math.cos(a) * r1 * 1.6, card.y + card.h / 2 + Math.sin(a) * r1); co.stroke(); }
        }));
        // ---- le combattant
        const goal = post();
        if (F.atk) {
          const A = F.atk; A.t += dt;
          if (A.t < A.stop) { F.pose = A.kind; F.x = A.fx; F.y = A.fy; }
          else if (!F.hop) { F.atk = null; hopTo(goal, A.big ? .4 : .3, card.h * (A.big ? .25 : .16)); } // sauts bas : au-dessus de la carte, il y a vite le haut de l'écran
        }
        if (F.hop) {
          const H = F.hop; H.k = Math.min(1, H.k + dt / H.d);
          const e = H.k; F.x = lerp(H.x0, H.x1, e); F.y = lerp(H.y0, H.y1, e) - Math.sin(Math.PI * e) * H.high; F.pose = H.pose;
          if (H.k >= 1) { F.hop = null; F.x = H.x1; F.y = H.y1; F.pose = H.pose; }
        } else if (!F.atk && !F.dizzy && !done) { F.x += (goal.x - F.x) * Math.min(1, dt * 6); F.y += (goal.y - F.y) * Math.min(1, dt * 6); F.pose = 'idle'; }
        // aura de charge (avant le dernier chiffre) : des carrés clairs qui montent autour de lui
        if (build > 0 && !F.atk) for (let k = emit(40 * q * build, dt); k > 0; k--) aura.add({ x: F.x + rnd(-1, 1) * ps * 7, y: F.y - rnd(0, ps * 14), vx: 0, vy: -rnd(40, 90), max: rnd(.25, .5), size: ps * (Math.random() < .3 ? 2 : 1), c: pick(['#67e8f9', '#e0f2fe', '#a5f3fc']) });
        aura.step(dt);
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        aura.each((a, k) => { co.globalAlpha = (1 - k) * .9; co.fillStyle = a.c; co.fillRect(snap(a.x), snap(a.y), a.size, a.size); });
        co.globalCompositeOperation = 'source-over';
        // images rémanentes du plongeon
        trails.run(dt, (r, k) => { for (let i = 0; i < 3; i++) { const u = (i + 1) / 4; drawPose(r.pose, lerp(r.x0, r.x1, u), lerp(r.y0, r.y1, u), (1 - k) * (.25 + .2 * i)); } });
        const bob = !F.hop && !F.atk && F.pose === 'idle' && !F.dizzy ? (Math.floor(t * 4) % 2) * ps + (build > 0 ? ps : 0) : 0;
        const wob = F.dizzy ? Math.sin(t * 5) * .12 : 0;
        if (F.x > -card.h * 3) drawPose(F.pose, F.x, F.y + bob, 1, false, wob);
        if (F.dizzy) { F.dizzy = Math.max(0, F.dizzy - dt); for (let i = 0; i < 3; i++) { const a = t * 5 + i * TAU / 3; co.globalAlpha = Math.min(1, F.dizzy); co.fillStyle = '#fde047'; const x = snap(F.x + Math.cos(a) * ps * 5), y = snap(F.y - ps * 16 + Math.sin(a) * ps * 1.5); co.fillRect(x - ps, y, ps * 3, ps); co.fillRect(x, y - ps, ps, ps * 3); } }
        // ---- étincelles d'impact en pixels : une étoile blanche et jaune, puis des carrés qui partent
        sparks.run(dt, (s, k) => {
          const L = ps * (s.big ? 7 : 4), x = snap(s.x), y = snap(s.y), c1 = s.gray ? '#e2e8f0' : '#ffffff', c2 = s.gray ? '#94a3b8' : '#fde047', c3 = s.gray ? '#64748b' : '#fb923c';
          if (k < .3) {
            const r = L * (.5 + k / .3 * .5); co.globalAlpha = 1;
            co.fillStyle = c3; co.fillRect(x - r, y - ps, r * 2, ps * 2); co.fillRect(x - ps, y - r, ps * 2, r * 2);
            co.fillStyle = c2; co.fillRect(x - r * .7, y - ps * .5, r * 1.4, ps); co.fillRect(x - ps * .5, y - r * .7, ps, r * 1.4);
            for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) co.fillRect(x + dx * r * .45 - ps / 2, y + dy * r * .45 - ps / 2, ps, ps);
            co.fillStyle = c1; co.fillRect(x - ps * 1.5, y - ps * 1.5, ps * 3, ps * 3);
          } else {
            const r = L * (1 + (k - .3) * 2.2); co.globalAlpha = 1 - (k - .3) / .7; co.fillStyle = c2;
            for (let i = 0; i < 8; i++) { const a = i * TAU / 8; co.fillRect(snap(x + Math.cos(a) * r) - ps / 2, snap(y + Math.sin(a) * r) - ps / 2, ps, ps); }
          }
        });
        bits.step(dt);
        bits.each((b, k) => { co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = b.c; co.fillRect(snap(b.x), snap(b.y), b.size, b.size); });
        stars.step(dt);
        stars.each((b, k) => { co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = b.c; const x = snap(b.x), y = snap(b.y); co.fillRect(x - b.size, y, b.size * 3, b.size); co.fillRect(x, y - b.size, b.size, b.size * 3); });
        // ---- les mots (combo, HIT!, K.O.!)
        words.run(dt, (wd, k) => {
          const T = k * wd.life, a = T < .05 ? 1 : k > .8 ? (1 - k) / .2 : 1, s = wd.pop ? pop(T) : 1;
          const fill = wd.flash && T < wd.flash ? (Math.floor(T * 10) % 2 ? '#ef4444' : '#fde047') : wd.c;
          ptext(wd.s, wd.x, wd.y, wd.size * s, fill, a, wd.align);
        });
        co.restore(); co.globalAlpha = 1;
      },
      lock(p, o) {
        n++;
        const S = slotsA(env), me = S.reduce((b, s) => (Math.abs(s.x - p.x) < Math.abs(b.x - p.x) ? s : b), S[0] || { w: card.h * .5 }), sw = me.w || card.h * .5;
        const kind = o.last ? 'kick' : o.ghost ? 'punch' : hits % 2 ? 'punch' : 'kick';
        const hx = kind === 'kick' ? p.x - sw * .15 : p.x - sw * .45, hy = kind === 'kick' ? p.y - card.h * .18 : p.y - card.h * .05;
        const at = feetFor(kind, hx, hy);
        if (F.hop) { F.x = F.hop.x1; F.y = F.hop.y1; F.hop = null; }
        trails.add({ life: .16, pose: kind, x0: F.x, y0: F.y, x1: at.x, y1: at.y });
        F.atk = { kind, fx: at.x, fy: at.y, t: 0, stop: o.last ? .2 : o.ghost ? .07 : .11, big: o.last };
        F.pose = kind; F.x = at.x; F.y = at.y; F.dizzy = 0;
        sparks.add({ x: hx, y: hy, big: o.last, gray: o.ghost, life: o.last ? .5 : .32 });
        for (let i = Math.round((o.ghost ? 3 : o.last ? 16 : 7) * q); i > 0; i--) { const a = rnd(-Math.PI, 0), v = card.h * rnd(1.5, o.last ? 5 : 3); bits.add({ x: hx, y: hy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 9, max: rnd(.3, .6), size: ps, c: o.ghost ? '#94a3b8' : pick(['#fde047', '#fb923c', '#ffffff']) }); }
        if (o.ghost) { hp = Math.max(0, hp - .03); return; }
        hits++; hp = Math.max(.05, hp - (o.last ? .2 : .12));
        flashes.add({ life: o.last ? .22 : .12, a: o.last ? .45 : .22, c: '#ffffff' });
        shake = Math.max(shake, o.last ? .9 : .35);
        if (hits >= 2) words.add({ life: 1.1, s: `${hits} HITS`, x: card.x + ps, y: card.y - card.h * .14 - ps * 2, size: Math.max(7, card.h * .15), c: '#fde047', align: 'left', pop: true });
        if (o.last) build = 0;
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; timerOn = false; done = true;
        const corner = { x: Math.min(card.x + card.w + ps * 9, env.W - ps * 8), y: card.y + card.h };
        const top = card.y - card.h * .4; // la place au-dessus de la carte est courte (menu du jeu, nom du joueur en duel)
        if (!p) { F.atk = null; F.hop = null; hopTo({ x: card.x + card.w - ps * 5, y: card.y }, .3, card.h * .3); F.dizzy = 3.5; words.add({ delay: .25, life: 1.6, s: 'MISS', x: cx, y: top, size: card.h * .26, c: '#cbd5e1', pop: true }); return; }
        F.atk = null; F.face = -1; hopTo(corner, .45, card.h * .3, p >= .42 ? 'win' : 'idle');
        if (p < 1) {
          const s = p >= .8 ? 'ULTRA!' : p >= .62 ? 'SUPER!' : p >= .42 ? 'GREAT!' : 'HIT!';
          hp = Math.max(.05, hp - .1 * p);
          words.add({ delay: .1, life: 1.6, s, x: cx, y: top, size: card.h * (.24 + .14 * p), c: p >= .62 ? '#fb923c' : '#fde047', pop: true });
          for (let i = Math.round(burst(p, 18) * q); i > 0; i--) { const a = rnd(-Math.PI, 0), v = card.h * rnd(2, 4.5); bits.add({ x: cx + rnd(-.4, .4) * card.w, y: card.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: card.h * 8, max: rnd(.5, .9), size: ps, c: pick(['#fde047', '#fb923c', '#ffffff', '#67e8f9']) }); }
          return;
        }
        // K.O.! : la barre se vide d'un coup, l'écran tremble, éclair blanc, lignes de vitesse
        hp = 0; shake = 1.4 + .3 * asc;
        flashes.add({ life: .35, a: .7, c: '#ffffff' });
        lines.add({ life: 1.1 + .3 * asc, n: Math.round((22 + 8 * asc) * q), rot: rnd(TAU), c: dark ? '#fde047' : '#f97316' });
        // dès Celestial, PERFECT! prend la place du K.O.! (pas de place pour deux lignes au-dessus de la carte)
        words.add({ delay: .05, life: asc ? 1.5 : 2.8, s: 'K.O.!', x: cx, y: top, size: card.h * .5, c: '#fde047', pop: true, flash: 1.2 });
        if (asc >= 1) words.add({ delay: 1.55, life: 1.8 + .5 * asc, s: 'PERFECT!', x: cx, y: top, size: card.h * .34, c: asc >= 3 ? '#f0abfc' : '#67e8f9', pop: true });
        for (let i = Math.round((26 + 20 * asc) * q); i > 0; i--) { const a = rnd(TAU), v = card.h * rnd(2, 6); bits.add({ x: cx, y: card.y + card.h / 2, vx: Math.cos(a) * v * 1.4, vy: Math.sin(a) * v - card.h * 2, g: card.h * 6, max: rnd(.7, 1.3), size: ps * (Math.random() < .3 ? 2 : 1), c: pick(['#fde047', '#fb923c', '#ffffff', '#ef4444', '#67e8f9']) }); }
        if (asc >= 1) for (let i = Math.round((14 + 10 * asc) * q); i > 0; i--) stars.add({ x: cx + rnd(-1, 1) * card.w * .8, y: card.y - rnd(card.h * .5, card.h * 1.5), vx: rnd(-10, 10), vy: card.h * rnd(.6, 1.2), max: rnd(1.4, 2.4), size: ps, c: asc >= 3 ? pick(RAINBOW) : pick(['#fde047', '#ffffff', '#67e8f9']) });
      },
    };
  };

  // ⚓ Battleship (2026-10-28, idée de 17black) — une mer au crépuscule. Au loin, juste derrière la carte, un cuirassé
  // en ombre chinoise (liseré orange du soleil couchant, hublots allumés, feu rouge au mât) croise lentement. Un
  // réticule rond suit le prochain chiffre et se resserre ; quand le chiffre se pose, la tourelle tire (éclair, fumée,
  // recul), l'obus file en cloche, et la gerbe d'eau qu'il soulève révèle le chiffre (l'animation CSS bsh-rise le cache
  // le temps du vol). Avant le dernier chiffre, le réticule clignote en rouge et le projecteur du navire balaie la carte.
  // Révélation : tirage raté, un obus foireux tombe à l'eau (plouf) ; sinon une bordée de trois obus, trois gerbes
  // derrière la carte, plus hautes avec la rareté ; dès Mythic, une énorme explosion derrière la carte, une onde sur
  // l'eau et un anneau de fumée qui monte en s'élargissant ; dès Celestial, plus d'anneaux et des traçantes.
  // Différent d'Orbital Cannon : tirs en cloche venus de côté, de l'eau et de la fumée, pas de rayons verticaux.
  SCENES.battleship = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, add = dark ? 'lighter' : 'source-over';
    const shells = timed(), columns = timed(), flashes = timed(), rings = timed(), smokeRings = timed(), fireballs = timed(), drops = particles(), smoke = particles(), muzzle = timed();
    const L = Math.min(H * 1.7, card.w * .5), wl = () => card.y - H * .16; // longueur du navire, ligne de flottaison (derrière le haut de la carte)
    let t = 0, build = 0, sinceLock = 0, aim = null, done = false, recoil = 0, light = 0;
    const shipX = () => card.x + card.w * .2 + Math.sin(t * .23) * card.w * .05;
    const turretAt = (x0, k) => ({ x: x0 + L * k, y: wl() - L * .085 });
    // l'angle des canons vers la cible (en l'air : jamais sous l'horizon)
    const elev = (from, to) => clamp(Math.atan2(to.y - from.y, to.x - from.x) - .55, -1.3, -.12);
    const drawShip = (x0, target) => {
      const y = wl(), rim = dark ? '#fb923c' : '#ea580c', body = dark ? '#151a2e' : '#1e2a44';
      co.save(); co.translate(0, Math.sin(t * 1.1) * 1.2);
      // coque : poupe à gauche, étrave relevée à droite
      co.fillStyle = body; co.beginPath();
      co.moveTo(x0 - L * .5, y - L * .07); co.lineTo(x0 + L * .4, y - L * .07); co.lineTo(x0 + L * .52, y - L * .12); co.lineTo(x0 + L * .44, y + L * .02); co.lineTo(x0 - L * .46, y + L * .02); co.closePath(); co.fill();
      // superstructures, cheminée, mât
      co.fillRect(x0 - L * .16, y - L * .16, L * .3, L * .1); co.fillRect(x0 - L * .08, y - L * .25, L * .16, L * .1); co.fillRect(x0 - L * .02, y - L * .33, L * .07, L * .09);
      co.fillRect(x0 - L * .24, y - L * .2, L * .07, L * .14); // la cheminée
      co.fillRect(x0 + L * .01, y - L * .42, L * .012, L * .1); co.fillRect(x0 - L * .04, y - L * .38, L * .1, L * .01); // le mât et sa vergue (court : peu de place au-dessus)
      // tourelles et canons (avant, arrière), pointés vers la cible
      for (const k of [.26, -.33]) {
        const tp = turretAt(x0, k), a = target ? elev(tp, target) : -.2, back = recoil * L * .05 * (k > 0 ? 1 : .6);
        co.save(); co.translate(tp.x, tp.y); co.rotate(a); co.fillRect(-back, -L * .012, L * .2, L * .024); co.fillRect(-back, L * .016, L * .19, L * .02); co.restore();
        co.beginPath(); co.ellipse(tp.x, tp.y + L * .01, L * .065, L * .04, 0, Math.PI, 0); co.fill();
      }
      // le liseré du couchant sur les arêtes hautes
      co.globalAlpha = .85; co.strokeStyle = rim; co.lineWidth = 1;
      co.beginPath(); co.moveTo(x0 - L * .5, y - L * .07); co.lineTo(x0 + L * .4, y - L * .07); co.lineTo(x0 + L * .52, y - L * .12);
      co.moveTo(x0 - L * .16, y - L * .16); co.lineTo(x0 + L * .14, y - L * .16); co.moveTo(x0 - L * .08, y - L * .25); co.lineTo(x0 + L * .08, y - L * .25); co.stroke();
      // hublots et feu de mât
      co.fillStyle = '#fde68a'; co.globalAlpha = .9;
      for (let i = 0; i < 7; i++) co.fillRect(x0 - L * .38 + i * L * .12, y - L * .035, Math.max(1, L * .012), Math.max(1, L * .012));
      co.globalCompositeOperation = add; dot(co, '#ef4444', x0 + L * .016, y - L * .43, L * .035, .5 + .5 * Math.sign(Math.sin(t * 3)));
      co.globalCompositeOperation = 'source-over';
      co.restore(); co.globalAlpha = 1;
    };
    // un obus : de la bouche du canon à la cible, en cloche ; il soulève une gerbe à l'arrivée
    const fire = (from, to, o) => {
      muzzle.add({ x: from.x + Math.cos(elev(from, to)) * L * .2, y: from.y + Math.sin(elev(from, to)) * L * .2, life: .25, s: o.big ? 1.4 : o.dud ? .5 : 1 });
      for (let i = Math.round((o.dud ? 5 : 3) * q) + 1; i > 0; i--) smoke.add({ x: from.x + L * .18, y: from.y - L * .05, vx: rnd(-10, 25), vy: -rnd(6, 20), drag: .8, max: rnd(1, 1.8), size: L * rnd(.05, .09), c: dark ? '#64748b' : '#94a3b8' });
      recoil = 1;
      shells.add({ life: o.flight, x0: from.x + L * .2, y0: from.y - L * .05, x1: to.x, y1: to.y, peak: H * (o.peak || .9), o });
    };
    const splash = (x, y, s, o = {}) => {
      columns.add({ x, y, s, life: .9 + .4 * s, inside: o.inside, back: o.back });
      rings.add({ x, y: o.inside ? card.y + H - 3 : y, r: H * (.3 + .4 * s), life: .9, inside: o.inside });
      for (let i = Math.round((6 + 10 * s) * q); i > 0; i--) drops.add({ x: x + rnd(-1, 1) * H * .12 * s, y: o.inside ? card.y : y - H * .2 * s, vx: rnd(-1, 1) * H * 1.2 * s, vy: -H * rnd(1.5, 3.5) * Math.sqrt(s), g: H * 9, max: rnd(.5, .9), size: rnd(1, 2.2) });
      if (o.inside) flashes.add({ x: x - card.x, life: .25 });
    };
    return {
      frame(tt, dt) {
        t = tt; sinceLock += dt; recoil = Math.max(0, recoil - dt * 4); light += ((build ? 1 : 0) - light) * Math.min(1, dt * 3);
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on), x0 = shipX();
        aim = next ? { x: next.x, y: next.y } : aim;
        // ---- au loin, derrière la carte : la lueur du couchant, un bandeau de mer, le navire, sa fumée
        behind(env, () => {
          co.globalCompositeOperation = 'source-over';
          const top = wl() - H * .02, x1 = card.x - card.w * .25, x2 = card.x + card.w * 1.25;
          const g = co.createLinearGradient(x1, 0, x2, 0), sea = dark ? '30,41,74' : '51,65,110';
          g.addColorStop(0, `rgba(${sea},0)`); g.addColorStop(.2, `rgba(${sea},.65)`); g.addColorStop(.8, `rgba(${sea},.65)`); g.addColorStop(1, `rgba(${sea},0)`);
          co.globalCompositeOperation = add; dot(co, dark ? '#fb923c' : '#fdba74', cx + card.w * .1, top, card.w * .7, dark ? .28 : .35, H * .55); co.globalCompositeOperation = 'source-over';
          co.globalAlpha = 1; co.fillStyle = g; co.fillRect(x1, top, x2 - x1, H * .5);
          co.globalAlpha = .5; co.fillStyle = '#fdba74'; for (let i = 0; i < 9; i++) { const gx = cx + card.w * .1 + Math.sin(i * 3.7 + t * .8) * card.w * .3, gy = top + 2 + (i % 3) * 3; co.fillRect(gx, gy, H * .12 * (1 + Math.sin(t * 3 + i)), 1); }
          co.globalAlpha = 1;
          smoke.step(dt);
          smoke.each((s, k) => { co.globalAlpha = (1 - k) * .55; co.fillStyle = s.c; co.beginPath(); co.arc(s.x, s.y, s.size * (1 + 1.6 * k), 0, TAU); co.fill(); });
          // la fumée de la cheminée
          co.globalAlpha = dark ? .35 : .4; co.fillStyle = dark ? '#475569' : '#64748b';
          for (let i = 0; i < 4; i++) { const u = ((t * .35 + i / 4) % 1); co.beginPath(); co.arc(x0 - L * .205 - u * L * .45, wl() - L * .22 - u * L * .25, L * (.03 + .05 * u), 0, TAU); co.fill(); }
          co.globalAlpha = 1;
          drawShip(x0, aim);
        }, true);
        // ---- le projecteur pendant la tension : un cône de lumière du pont vers le prochain chiffre
        if (light > .02 && aim) {
          const from = { x: x0 + L * .03, y: wl() - L * .3 };
          co.save(); co.globalCompositeOperation = add; co.globalAlpha = light * (dark ? .22 : .18);
          const g = co.createLinearGradient(from.x, from.y, aim.x, aim.y); g.addColorStop(0, '#fef9c3'); g.addColorStop(1, 'rgba(254,249,195,0)');
          co.fillStyle = g; co.beginPath(); co.moveTo(from.x, from.y); co.lineTo(aim.x - H * .4, aim.y + H * .4); co.lineTo(aim.x + H * .4, aim.y + H * .2); co.closePath(); co.fill(); co.restore();
        }
        // ---- dans la carte, derrière les chiffres : les gerbes, l'éclair d'impact
        ci.globalCompositeOperation = 'source-over';
        columns.run(dt, (c, k) => {
          const rise = k < .3 ? outCubic(k / .3) : 1, fall = k < .3 ? 0 : (k - .3) / .7, top = (c.inside ? h : c.y) - (c.inside ? h * 1.25 : H * 1.5) * c.s * rise * (1 - fall * .75), wd = H * .16 * c.s * (1 + fall * .8), a = 1 - Math.pow(fall, 1.5);
          const col = (ctx, x, base, alpha) => {
            ctx.globalAlpha = alpha * .9; ctx.fillStyle = dark ? '#e0f2fe' : '#f8fafc';
            ctx.beginPath(); ctx.moveTo(x - wd, base); ctx.quadraticCurveTo(x - wd * .5, (base + top) / 2, x - wd * .25, top); ctx.quadraticCurveTo(x, top - wd * .6, x + wd * .25, top); ctx.quadraticCurveTo(x + wd * .5, (base + top) / 2, x + wd, base); ctx.closePath(); ctx.fill();
            ctx.globalAlpha = alpha * .5; ctx.fillStyle = '#7dd3fc'; ctx.fillRect(x - wd * .18, top + wd, wd * .36, base - top - wd);
          };
          if (c.inside) { col(ci, c.x - card.x, h, a); if (top < 0) behind(env, () => { co.save(); co.beginPath(); co.rect(0, 0, env.W, card.y + 1); co.clip(); col(co, c.x, card.y + h, a); co.restore(); }, true); }
          else behind(env, () => col(co, c.x, c.y, a), true);
        });
        flashes.run(dt, (f, k) => { ci.globalCompositeOperation = 'lighter'; if (f.big) dot(ci, '#fb923c', w / 2, h * .7, w * .7, (1 - k) * .8, h); else dot(ci, '#fde68a', f.x, h * .85, h * .7, (1 - k) * .6, h * .35); ci.globalCompositeOperation = 'source-over'; });
        ci.globalAlpha = 1;
        // ---- l'explosion du Mythic et l'anneau de fumée, derrière la carte
        behind(env, () => {
          fireballs.run(dt, (f, k) => {
            const e = outExpo(k), a = 1 - k;
            co.globalCompositeOperation = add;
            if (k < .15) dot(co, '#ffffff', f.x, f.y, f.r * (.8 + 3 * k), (1 - k / .15) * .9);
            dot(co, '#fb923c', f.x, f.y - f.r * .2 * e, f.r * (.7 + 1.1 * e), a * .9, f.r * (.4 + .5 * e));
            co.globalCompositeOperation = 'source-over';
            // une couronne de boules de feu qui jaillit de tous les bords de la carte, vire au gris et s'élève
            if (!f.blobs) f.blobs = Array.from({ length: Math.round(18 * q) + 6 }, (_, i) => ({ an: i * TAU / (Math.round(18 * q) + 6) + rnd(-.15, .15), d: rnd(.9, 1.25), s: rnd(.22, .36) }));
            for (const bb of f.blobs) {
              const rx = f.r * (.55 + .75 * e) * bb.d, ry = f.r * (.3 + .45 * e) * bb.d, x = f.x + Math.cos(bb.an) * rx, y = f.y + Math.sin(bb.an) * ry - f.r * .35 * k, r = f.r * bb.s * (.6 + .7 * e);
              const fire = clamp(1 - k * 2.2), col = fire > .5 ? (fire > .8 ? '#fde047' : '#fb923c') : fire > .15 ? '#c2410c' : (dark ? '#475569' : '#64748b');
              co.globalAlpha = Math.min(1, a * 1.4) * .9; co.fillStyle = col; co.beginPath(); co.arc(x, y, r, 0, TAU); co.fill();
              if (fire > .3) { co.globalCompositeOperation = add; dot(co, '#fde047', x, y, r * 1.3, fire * .5); co.globalCompositeOperation = 'source-over'; }
            }
          });
          // l'anneau de fumée : un tore vu de biais, fait de bouffées, qui monte et s'élargit
          smokeRings.run(dt, (r, k) => {
            const e = outCubic(k), rx = card.w * (.35 + .5 * e) * r.s, ry = rx * .32, y = r.y - H * .55 * e * r.s, a = (k < .1 ? k / .1 : 1) * (1 - Math.pow(k, 2));
            const n = Math.round(34 * q) + 8;
            for (let i = 0; i < n; i++) {
              const an = i * TAU / n + k * 1.2, x = r.x + Math.cos(an) * rx, yy = y + Math.sin(an) * ry, front = Math.sin(an) > 0;
              co.globalAlpha = a * (front ? .8 : .55); co.fillStyle = k < .25 && front ? (dark ? '#9a3412' : '#c2410c') : (front ? (dark ? '#94a3b8' : '#475569') : (dark ? '#64748b' : '#64748b'));
              co.beginPath(); co.arc(x, yy, H * (.1 + .06 * Math.sin(i * 2.1 + k * 6)) * r.s * (1 + .4 * e), 0, TAU); co.fill();
            }
          });
        }, true);
        // le feu et la fumée s'effacent en fondu vers le bas au lieu d'être coupés net au bas de la carte
        if (fireballs.n || smokeRings.n) behind(env, () => { const y1 = card.y + H + 8, y0 = y1 - H * .6, g = co.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)'); co.globalCompositeOperation = 'destination-out'; co.globalAlpha = 1; co.fillStyle = g; co.fillRect(0, y0, env.W, y1 - y0); co.globalCompositeOperation = 'source-over'; });
        // ---- devant : réticule, éclairs de bouche, obus, gouttes, ondes
        rings.run(dt, (r, k) => { co.globalAlpha = (1 - k) * .7; co.strokeStyle = dark ? '#bae6fd' : '#0369a1'; co.lineWidth = 1.5; co.beginPath(); co.ellipse(r.x, r.y, r.r * outCubic(k), r.r * outCubic(k) * .22, 0, 0, TAU); co.stroke(); });
        if (next && !done) {
          const locked = build > 0 || sinceLock > .9, rr = next.w * (.66 - .2 * clamp(sinceLock / .9)) + H * .04, col = locked && Math.sin(t * (build ? 26 : 12)) > -.3 ? '#ef4444' : '#fbbf24', rot = t * .8;
          co.globalAlpha = .9; co.strokeStyle = col; co.lineWidth = 1.6;
          co.beginPath(); co.arc(next.x, next.y, rr, 0, TAU); co.stroke();
          co.beginPath();
          for (let i = 0; i < 4; i++) { const a = rot + i * Math.PI / 2; co.moveTo(next.x + Math.cos(a) * rr * .55, next.y + Math.sin(a) * rr * .55); co.lineTo(next.x + Math.cos(a) * rr * 1.18, next.y + Math.sin(a) * rr * 1.18); }
          co.stroke();
          co.globalAlpha = .6; co.beginPath(); for (let i = 0; i < 12; i++) { const a = -rot * .5 + i * TAU / 12; co.moveTo(next.x + Math.cos(a) * rr, next.y + Math.sin(a) * rr); co.lineTo(next.x + Math.cos(a) * rr * .88, next.y + Math.sin(a) * rr * .88); } co.stroke();
        }
        co.globalCompositeOperation = add;
        muzzle.run(dt, (m, k) => { dot(co, '#fff7d6', m.x, m.y, L * .1 * m.s * (1 - k), 1 - k); dot(co, '#fb923c', m.x, m.y, L * .2 * m.s * (1 - k * .5), (1 - k) * .8); });
        shells.run(dt, (s, k) => {
          const pos = u => ({ x: lerp(s.x0, s.x1, u), y: lerp(s.y0, s.y1, u) - Math.sin(Math.PI * u) * s.peak });
          const p = pos(k), b = pos(Math.max(0, k - .12));
          tail(co, '#fdba74', b.x, b.y, p.x, p.y, 2, .8); dot(co, '#fff7d6', p.x, p.y, 4, 1);
          if (!s.hit && k > .97) { s.hit = 1; s.o.land(); }
        });
        co.globalCompositeOperation = 'source-over';
        drops.step(dt);
        co.fillStyle = dark ? '#e0f2fe' : '#0284c7';
        drops.each((d, k) => { co.globalAlpha = 1 - k; co.fillRect(d.x, d.y, d.size, d.size * 1.6); });
        co.globalAlpha = 1;
      },
      lock(p, o) {
        sinceLock = 0;
        const x0 = shipX(), from = turretAt(x0, o.ghost ? -.33 : .26), to = { x: p.x, y: card.y + H * .3 };
        // le vol dure le temps que bsh-rise cache le chiffre (~0,28 s)
        fire(from, to, { flight: .27, big: o.last, peak: .8, land: () => splash(p.x, card.y + H, o.ghost ? .45 : o.last ? 1.3 : .9, { inside: true }) });
        if (o.last) { build = 0; setTimeout(() => fire(turretAt(shipX(), -.33), { x: p.x + H * .4, y: card.y }, { flight: .3, peak: .7, land: () => splash(p.x + H * .45, wl() + H * .05, .6, { back: true }) }), 60); }
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0, x0 = shipX();
        build = 0; done = true;
        if (!p) { fire(turretAt(x0, .26), { x: x0 + L * .9, y: wl() + 2 }, { flight: .5, dud: true, peak: .25, land: () => splash(x0 + L * .9, wl() + 2, .25, { back: true }) }); return; }
        // la bordée : trois obus, trois gerbes derrière la carte, plus hautes avec la rareté
        const spots = [card.x - H * .35, cx, card.x + card.w + H * .35]; // sur les côtés : la place au-dessus de la carte est courte
        spots.forEach((sx, i) => setTimeout(() => fire(turretAt(shipX(), i % 2 ? -.33 : .26), { x: sx, y: wl() }, { flight: .4, peak: 1.1, big: p >= 1, land: () => splash(sx, wl() + H * .05, .5 + .7 * p, { back: true }) }), i * 120));
        if (p < 1) return;
        setTimeout(() => {
          fireballs.add({ x: cx, y: card.y + H * .5, r: card.w * .5 * (1 + .2 * asc), life: 1.5 + .3 * asc }); // plus large que la carte : elle déborde de tous les côtés
          flashes.add({ big: 1, life: 1 });
          rings.add({ x: cx, y: card.y + H, r: card.w * (.9 + .2 * asc), life: 1.2 });
          for (let i = 0; i < 1 + asc; i++) smokeRings.add({ delay: .25 + i * .55, life: 3.2 + .4 * asc, x: cx, y: card.y + H * .55, s: 1 + .15 * i });
          for (let i = Math.round((30 + 20 * asc) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = H * rnd(2, 6); drops.add({ x: cx + rnd(-.3, .3) * card.w, y: card.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: H * 7, max: rnd(.7, 1.3), size: rnd(1.2, 2.6) }); }
          if (asc) for (let i = 0; i < 3 + 2 * asc; i++) setTimeout(() => { const tx = card.x + rnd(-.2, 1.2) * card.w; fire(turretAt(shipX(), .26), { x: tx, y: card.y - H * rnd(1, 1.6) }, { flight: .45, peak: .6, land: () => fireballs.add({ x: tx, y: card.y - H * rnd(1, 1.5), r: H * .3, life: .6 }) }); }, 500 + i * 160);
        }, 520);
      },
    };
  };

  // 🚧 Cone of Destiny (2026-10-28, idée de Gray alt) — une blague en trois temps. Pendant le tirage, un cône de chantier
  // tourne sur lui-même en l'air à droite de la carte, un peu plus vite à chaque chiffre (chaque chiffre fait « bonk » et
  // un petit nuage de poussière). Avant le dernier, il monte, tremble et une mèche crépite à sa pointe (attente). À la
  // révélation, il plonge derrière la carte et… une explosion de dessin animé ridiculement énorme (éclair, boules de feu
  // dentelées, ondes, un nuage de fumée qui avale tout autour de la carte). Quand la fumée se dissipe : c'est juste un
  // cône, posé là à côté du nombre, immobile (impassible) ; un instant plus tard, une minuscule bouffée sort de sa pointe.
  // Dès Mythic, l'explosion déborde encore plus (explosions en chaîne) et le cône porte une toute petite couronne ;
  // Divine : deux cônes ; Godlike et Infinite : trois. Tirage raté : il tombe à côté, se couche… « pop ».
  SCENES.cone = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, cy = card.y + H / 2, cs = H * .82; // hauteur du cône
    const booms = timed(), waves = timed(), puffs = particles(), dust = particles(), bits = particles(), sparks = particles(), glows = timed(), emit = emitter();
    const SM = dark ? ['#6b7280', '#4b5563', '#9ca3af'] : ['#9ca3af', '#6b7280', '#d1d5db'];
    const C = { x: card.x + card.w + cs * .55, y: cy - H * .1, rot: 0, spin: 2.5, hits: 0, phase: 'air', a: 1, fall: null };
    let t = 0, build = 0, crown = 0, rest = [], tipPuffAt = 0, since = 0, glint = 0;
    // un cône de chantier (x, y = milieu du socle) : socle carré sombre, corps orange, deux bandes blanches, pointe arrondie
    const cone = (x, y, s, rot, a, k = {}) => {
      if (a <= .01) return;
      co.save(); co.globalAlpha = a; co.translate(x, y); co.rotate(rot); if (k.mid) co.translate(0, s * .45); // mid : il tourne autour de son milieu
      const bw = s * .62, tw = s * .1, top = -s * .92;
      co.fillStyle = '#9a3412'; roundRect(co, -bw * .62, -s * .08, bw * 1.24, s * .1, s * .03); co.fill(); // le socle
      const g = co.createLinearGradient(-bw / 2, 0, bw / 2, 0); g.addColorStop(0, '#c2410c'); g.addColorStop(.35, '#fb923c'); g.addColorStop(.55, '#f97316'); g.addColorStop(1, '#9a3412');
      co.fillStyle = g; co.beginPath(); co.moveTo(-bw / 2, -s * .07); co.lineTo(-tw / 2, top); co.quadraticCurveTo(0, top - s * .05, tw / 2, top); co.lineTo(bw / 2, -s * .07); co.closePath(); co.fill();
      co.save(); co.clip();
      co.fillStyle = '#f8fafc'; for (const [y0, y1] of [[-.62, -.5], [-.36, -.24]]) co.fillRect(-bw, s * y0, bw * 2, s * (y1 - y0));
      co.globalAlpha = a * .5; co.fillStyle = '#fff'; co.fillRect(-bw * .22, top, bw * .1, s); // le reflet du plastique
      co.restore();
      co.globalAlpha = a; co.strokeStyle = '#7c2d12'; co.lineWidth = Math.max(1, s * .025); co.beginPath(); co.moveTo(-bw / 2, -s * .07); co.lineTo(-tw / 2, top); co.quadraticCurveTo(0, top - s * .05, tw / 2, top); co.lineTo(bw / 2, -s * .07); co.stroke();
      if (k.crown) { // la toute petite couronne, posée de travers sur la pointe
        const cw = s * .2, cy0 = top - s * .02;
        co.save(); co.translate(0, cy0); co.rotate(-.18); co.scale(k.crown, k.crown);
        co.fillStyle = '#facc15'; co.strokeStyle = '#a16207'; co.lineWidth = Math.max(.8, s * .015);
        co.beginPath(); co.moveTo(-cw / 2, 0); co.lineTo(-cw / 2, -cw * .55); co.lineTo(-cw / 4, -cw * .25); co.lineTo(0, -cw * .7); co.lineTo(cw / 4, -cw * .25); co.lineTo(cw / 2, -cw * .55); co.lineTo(cw / 2, 0); co.closePath(); co.fill(); co.stroke();
        co.fillStyle = '#ef4444'; co.beginPath(); co.arc(0, -cw * .15, cw * .09, 0, TAU); co.fill();
        co.restore();
      }
      co.restore(); co.globalAlpha = 1;
    };
    // une boule de feu de dessin animé : une étoile dentelée qui gonfle et tremble
    const spiky = (x, y, r, n, jag, color, a, seed) => {
      if (a <= .01 || r <= 1) return;
      co.globalAlpha = Math.min(1, a); co.fillStyle = color; co.beginPath();
      for (let i = 0; i <= n * 2; i++) { const an = i * Math.PI / n + seed, rr = r * (i % 2 ? 1 - jag * (.6 + .4 * Math.sin(seed * 7 + i)) : 1); i ? co.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr * .8) : co.moveTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr * .8); }
      co.closePath(); co.fill();
    };
    const boom = (x, y, r, delay = 0) => {
      booms.add({ x, y, r, delay, life: .55 + r / (H * 8), seed: rnd(TAU) });
      waves.add({ x, y, r: r * 1.8, delay, life: .7 });
      glows.add({ x: x - card.x, y: y - card.y, r: r * 1.2, delay, life: .5 });
      // la fumée arrive après la boule de feu (on doit d'abord la voir), puis se dissipe en s'écartant
      setTimeout(() => { for (let i = Math.round(Math.min(26, 6 + r / H * 4) * q); i > 0; i--) { const a = rnd(TAU), d = r * rnd(.2, .9); puffs.add({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * .6, vx: Math.cos(a) * r * rnd(.5, 1.1), vy: Math.sin(a) * r * .4 - H * .3, drag: 1.1, g: -H * .15, max: rnd(1.3, 2), size: r * rnd(.22, .34), c: pick(SM) }); } }, (delay + .22) * 1000);
      setTimeout(() => {
        for (let i = Math.round(Math.min(20, 6 + r / H * 3) * q); i > 0; i--) { const a = rnd(-Math.PI * .95, -Math.PI * .05), v = H * rnd(3, 7); bits.add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: H * 12, drag: .3, max: rnd(.6, 1.1), size: H * rnd(.03, .06), rot: rnd(TAU), spin: rnd(-14, 14), c: pick(['#fde047', '#fb923c', '#ef4444', '#ffffff']) }); }
      }, delay * 1000);
    };
    return {
      frame(tt, dt) {
        t = tt; since += dt; glint = Math.max(0, glint - dt * 1.5);
        // ---- le cône
        if (C.phase === 'air') {
          C.spin += ((2.5 + 1.2 * C.hits + 14 * build) - C.spin) * Math.min(1, dt * 3);
          C.rot += C.spin * dt;
          const ty = cy - H * .1 - build * H * .45 + Math.sin(t * 2.2) * H * .06;
          C.y += (ty - C.y) * Math.min(1, dt * 4);
          const jx = build ? rnd(-1, 1) * H * .03 : 0;
          cone(C.x + jx, C.y, cs * .8, C.rot, 1, { mid: true });
          if (build) for (let n = emit(60 * q, dt); n > 0; n--) { const a = C.rot - Math.PI / 2, tipX = C.x + jx + Math.cos(a) * cs * .3, tipY = C.y + Math.sin(a) * cs * .3; sparks.add({ x: tipX, y: tipY, vx: rnd(-1, 1) * H * 1.5, vy: rnd(-1, 1) * H * 1.5, drag: 2, g: H * 2, max: rnd(.15, .35), size: rnd(1, 2) }); }
        } else if (C.phase === 'fall') {
          const F = C.fall; F.k = Math.min(1, F.k + dt / F.d); const e = F.k * F.k;
          C.x = lerp(F.x0, F.x1, F.k); C.y = lerp(F.y0, F.y1, e); C.rot += 22 * dt;
          const draw = () => cone(C.x, C.y, cs * .8, C.rot, 1, { mid: true });
          if (F.behind) behind(env, draw); else draw();
          if (F.k >= 1) { C.phase = 'gone'; F.done(); }
        }
        // ---- l'explosion : derrière la carte (le nombre reste lisible), un peu devant sur les bords seulement
        ci.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        glows.run(dt, (g, k) => dot(ci, '#fdba74', g.x, g.y, g.r * (1 + k), (1 - k) * .8));
        ci.globalCompositeOperation = 'source-over';
        puffs.step(dt);
        behind(env, () => {
          booms.run(dt, (b, k) => {
            const e = outExpo(k), a = k < .6 ? 1 : (1 - k) / .4, sh = Math.sin(t * 60) * .03;
            if (k < .14) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#ffffff', b.x, b.y, b.r * (1.2 + 6 * k), (1 - k / .14)); co.globalCompositeOperation = 'source-over'; }
            spiky(b.x, b.y, b.r * (.5 + .7 * e) * (1 + sh), 9, .35, '#dc2626', a, b.seed);
            spiky(b.x, b.y, b.r * (.38 + .55 * e) * (1 - sh), 8, .3, '#f97316', a, b.seed + 1);
            spiky(b.x, b.y, b.r * (.22 + .35 * e), 7, .25, '#fde047', a * (1 - k * .5), b.seed + 2);
            if (k < .3) spiky(b.x, b.y, b.r * .2 * (1 - k / .3), 6, .2, '#ffffff', 1, b.seed + 3);
          });
          puffs.each((p, k) => { co.globalAlpha = Math.min(1, k * 5) * (1 - Math.pow(k, 1.3)) * .92; co.fillStyle = p.c; co.beginPath(); co.arc(p.x, p.y, p.size * (1 + k * 1.2), 0, TAU); co.fill(); });
          waves.run(dt, (wv, k) => { co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? '#fde68a' : '#ea580c'; co.lineWidth = 2 + 4 * (1 - k); co.beginPath(); co.ellipse(wv.x, wv.y, wv.r * outCubic(k), wv.r * outCubic(k) * .45, 0, 0, TAU); co.stroke(); });
        }, true); // rien sous la carte : la rareté et l'XP s'y affichent au même moment
        // … et la fumée s'efface en fondu vers le bas au lieu d'être coupée net à hauteur du bas de la carte
        if (puffs.n || booms.n) behind(env, () => { const y1 = card.y + H + 8, y0 = y1 - H * .7, g = co.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)'); co.globalCompositeOperation = 'destination-out'; co.globalAlpha = 1; co.fillStyle = g; co.fillRect(0, y0, env.W, y1 - y0); co.globalCompositeOperation = 'source-over'; });
        // devant la carte, juste un voile de fumée très léger (les chiffres se lisent à travers)
        if (puffs.n) { let veil = 0; puffs.each((p, k) => { veil = Math.max(veil, Math.min(1, k * 5) * (1 - k)); }); co.globalAlpha = veil * .16; co.fillStyle = SM[2]; roundRect(co, card.x, card.y, card.w, H, card.r); co.fill(); }
        // ---- le cône impassible (et ses éventuels jumeaux), posé à côté du nombre, devant la fumée qui se dissipe
        for (const r of rest) {
          const a = clamp((since - r.at) * 1.5);
          if (a <= 0) continue;
          if (r.flat) { cone(r.x, r.y - cs * .18, cs, Math.PI / 2 * r.side, a); continue; }
          cone(r.x, r.y, cs, 0, 1, { crown: crown ? Math.min(1, crown) : 0 });
          if (crown && glint > 0) { co.globalCompositeOperation = dark ? 'lighter' : 'source-over'; dot(co, '#fef9c3', r.x + cs * .04, r.y - cs * 1.06, cs * .25 * glint, glint); co.globalCompositeOperation = 'source-over'; }
        }
        // la petite bouffée par la pointe, bien après
        if (tipPuffAt && since > tipPuffAt) { tipPuffAt = 0; for (const r of rest) if (!r.flat) for (let i = 0; i < 3; i++) dust.add({ x: r.x + rnd(-2, 2), y: r.y - cs * .95, vx: rnd(-6, 6), vy: -H * rnd(.2, .35), drag: 1, max: rnd(.9, 1.3), size: H * rnd(.04, .07), c: SM[2] }); }
        // ---- poussières, éclats, étincelles de la mèche
        dust.step(dt); bits.step(dt); sparks.step(dt);
        dust.each((d, k) => { co.globalAlpha = (1 - k) * .7; co.fillStyle = d.c; co.beginPath(); co.arc(d.x, d.y, d.size * (1 + k * 1.5), 0, TAU); co.fill(); });
        bits.each((p, k) => { p.rot += p.spin * dt; co.globalAlpha = 1 - k; co.save(); co.translate(p.x, p.y); co.rotate(p.rot); co.fillStyle = p.c; co.beginPath(); co.moveTo(0, -p.size); co.lineTo(p.size * .8, p.size * .7); co.lineTo(-p.size * .8, p.size * .7); co.closePath(); co.fill(); co.restore(); });
        co.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        sparks.each((s, k) => dot(co, k < .4 ? '#fef3c7' : '#fb923c', s.x, s.y, s.size * 2.5, 1 - k));
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
      },
      lock(p, o) {
        C.hits++; C.spin += o.ghost ? 2 : 6;
        for (let i = Math.round((o.ghost ? 2 : 5) * q); i > 0; i--) dust.add({ x: p.x + rnd(-1, 1) * H * .15, y: card.y + H - 3, vx: rnd(-1, 1) * H * .8, vy: -H * rnd(.2, .6), drag: 2, max: rnd(.4, .7), size: H * rnd(.05, .09), c: SM[2] });
        if (o.last) build = 0;
      },
      build() { build = 1; },
      reveal(tier) {
        const p = POWER[tier] || 0, asc = ASCEND[tier] || 0;
        build = 0; since = 0;
        const floor = card.y + H, spot = (side, i = 0) => ({ x: side > 0 ? card.x + card.w + cs * (.5 + .55 * i) : card.x - cs * .5, y: floor });
        if (!p) { // tirage raté : il tombe à côté, se couche, « pop »
          const s = spot(1);
          C.phase = 'fall'; C.fall = { k: 0, d: .45, x0: C.x, y0: C.y, x1: s.x, y1: s.y - cs * .45, done: () => { rest = [{ ...s, at: 0, flat: true, side: 1 }]; since = 0; for (let i = 0; i < 4; i++) dust.add({ x: s.x + rnd(-1, 1) * cs * .3, y: s.y - 2, vx: rnd(-1, 1) * H * .6, vy: -H * rnd(.1, .4), drag: 2, max: .8, size: H * rnd(.05, .08), c: SM[2] }); } };
          return;
        }
        // il plonge derrière la carte… et c'est l'apocalypse (pour un cône)
        C.phase = 'fall'; C.fall = { k: 0, d: .32, behind: true, x0: C.x, y0: C.y, x1: cx, y1: card.y + H * .1, done: () => {
          const R = card.w * (.42 + .4 * p) * (1 + .2 * asc);
          boom(cx, cy, R);
          if (p >= .62) [-1, 1].forEach((d, i) => boom(cx + d * card.w * .45, cy + rnd(-.2, .2) * H, R * .55, .12 + i * .09));
          if (p >= 1) for (let i = 0; i < 3 + 2 * asc; i++) boom(cx + rnd(-.7, .7) * card.w, cy + rnd(-.4, .4) * H, R * rnd(.35, .55), .3 + i * .1);
          since = 0;
          // quand la fumée retombe : juste un cône (deux dès Divine, trois dès Godlike), impassible
          const n = asc >= 3 ? 3 : asc >= 2 ? 2 : 1;
          rest = [spot(1, 0), spot(-1), spot(1, 1)].slice(0, n).map((s, i) => ({ ...s, at: 1.25 + .15 * i + .3 * p }));
          crown = p >= 1 ? 1 : 0; tipPuffAt = 3 + .3 * p;
          if (crown) setTimeout(() => { glint = 1; }, (1.7 + .3 * p) * 1000);
        } };
      },
    };
  };

  // 👁️ The Observer (2026-10-28, idée de Gray alt ; skin premium) — un œil cosmique géant s'ouvre dans le ciel, derrière
  // la carte : la carte est sa pupille (une galaxie y tourne derrière les chiffres), l'iris violet, turquoise et or
  // s'élève au-dessus d'elle, ses paupières sont des traits de lumière dorée, ses cils des rayons. De l'émerveillement,
  // pas de la peur : pas de blanc d'œil ni de veines, une nébuleuse lavande et un reflet de lumière qui le rend doux.
  // Pendant le tirage, il s'entrouvre un peu plus à chaque chiffre et suit des yeux le prochain ; autour, la page se
  // dissout en étoiles (des grains montent des bords de la carte et deviennent des étoiles). Chaque chiffre naît dans son
  // regard : de la poussière d'étoiles converge sur lui, éclat en étoile à quatre branches. Avant le dernier, la pupille
  // se dilate et les étoiles accourent. Révélation : tirage raté, il s'endort doucement (se referme) ; sinon il s'ouvre
  // grand, un éclat de lumière et un anneau ; dès Mythic, il s'ouvre en entier dans un éclat cosmique (trait anamorphique,
  // rayons, anneaux, pluie d'étoiles, la galaxie s'emballe) ; Celestial, Divine, Godlike : un anneau de plus chacun, des
  // rayons dorés, puis un iris arc-en-ciel. Au repos, il cligne de temps en temps.
  SCENES.observer = env => {
    const { ci, co, w, h, card, q, dark } = env;
    const H = card.h, cx = card.x + card.w / 2, add = dark ? 'lighter' : 'source-over';
    const b0 = (card.w - w) / 2; // bord de la carte : le calque intérieur commence après lui
    // largeur de l'œil : deux fois la carte, sans sortir de l'écran (téléphone)
    const room = (() => { try { const r = env.el.getBoundingClientRect(), vw = document.documentElement.clientWidth || innerWidth; return Math.max(card.w * .6, Math.min(r.left + r.width / 2, vw - r.left - r.width / 2) - 6); } catch (e) { return card.w; } })();
    const EW = Math.min(card.w * 1.95, room * 2, card.w + H * 5), Ey = () => card.y + H * .35;
    const Ri = Math.min(H * 1.1, EW * .3); // rayon de l'iris
    const motes = particles(), dust = particles(), sparks = particles(), stars = [], arms = [], flares = timed(), rings = timed(), twinkles = timed(), emit = emitter();
    for (let i = 0; i < Math.round(46 * q) + 10; i++) { const a = rnd(TAU), r = Math.sqrt(Math.random()); stars.push({ x: Math.cos(a) * r * EW * .62, y: -Math.abs(Math.sin(a)) * r * H * 1.9 + H * .3, s: rnd(.6, 1.8), ph: rnd(TAU), on: rnd(.1, 1) }); }
    const inEye = Array.from({ length: Math.round(40 * q) + 12 }, () => ({ x: rnd(-.48, .48) * EW, y: rnd(-1.1, .55) * H, s: rnd(.6, 1.6), ph: rnd(TAU) })); // les étoiles de la nébuleuse de l'œil
    for (let i = 0; i < Math.round(90 * q) + 20; i++) { const arm = i % 2, r = Math.pow(Math.random(), .7); arms.push({ r, a: arm * Math.PI + r * 4.2 + rnd(-.35, .35), s: rnd(.8, 2.2) * (1.2 - r * .5), c: pick(r < .3 ? ['#fef3c7', '#ffffff'] : ['#c4b5fd', '#67e8f9', '#f0abfc', '#ffffff']) }); }
    const flareNow = []; // éclats de l'image en cours, redessinés devant la carte
    let t = 0, open = 0, openTo = .12, look = 0, lookTo = 0, dil = .5, dilTo = .5, spin = 0, spinV = .25, build = 0, dissolve = 0, glow = 0, locks = 0, blinkAt = 6, blink = 0, revealed = false, hue = 0, rainbow = false, asc = 0, sleepy = false, full = 0;
    const almond = (c, ox, oy, k = 1) => { // l'ouverture des paupières (paupière du haut plus bombée que celle du bas)
      const e = Math.max(.002, open * (1 - blink)) * k, y = Ey() - oy, hu = H * .98 * e * (1 + .12 * full), hl = H * .62 * e; // ~0,7 carte au-dessus : la place sous le menu est courte
      c.beginPath(); c.moveTo(cx - EW / 2 - ox, y); c.quadraticCurveTo(cx - ox, y - hu * 2, cx + EW / 2 - ox, y); c.quadraticCurveTo(cx - ox, y + hl * 2, cx - EW / 2 - ox, y); c.closePath();
      return { hu, hl, y };
    };
    // l'iris et la pupille (galaxie), dessinés dans le contexte c avec un décalage (ox, oy) : une fois autour de la
    // carte (calque extérieur), une fois dedans, derrière les chiffres (calque intérieur), pour qu'ils se raccordent
    const iris = (c, ox, oy, inside) => {
      const ix = cx + look - ox, iy = Ey() - oy, Rp = Ri * dil;
      { // dans la carte, l'iris reste discret derrière les chiffres (la carte est une fenêtre sur lui)
        const g = c.createRadialGradient(ix, iy, Rp * .8, ix, iy, Ri);
        const mid = rainbow ? `hsl(${hue % 360},85%,62%)` : '#7c3aed', out = rainbow ? `hsl(${(hue + 90) % 360},85%,60%)` : '#0ea5b7';
        g.addColorStop(0, '#1e1048'); g.addColorStop(.35, mid); g.addColorStop(.78, out); g.addColorStop(.93, '#fbbf24'); g.addColorStop(1, 'rgba(251,191,36,0)');
        c.globalAlpha = inside ? .38 : 1; c.fillStyle = g; c.beginPath(); c.arc(ix, iy, Ri, 0, TAU); c.fill();
      }
      if (!inside) {
        // les fibres de l'iris, qui tournent lentement
        c.globalCompositeOperation = add; c.globalAlpha = .35; c.strokeStyle = '#e0e7ff'; c.lineWidth = 1;
        c.beginPath(); for (let i = 0; i < 40; i++) { const a = i * TAU / 40 + spin * .3, r0 = Rp * 1.05, r1 = Ri * (.8 + .12 * Math.sin(i * 3.7)); c.moveTo(ix + Math.cos(a) * r0, iy + Math.sin(a) * r0); c.lineTo(ix + Math.cos(a + .08) * r1, iy + Math.sin(a + .08) * r1); } c.stroke();
        c.globalCompositeOperation = 'source-over';
      }
      // la pupille : un disque nuit profonde où tourne une galaxie spirale
      c.globalAlpha = 1; c.fillStyle = '#05030f'; c.beginPath(); c.arc(ix, iy, Rp, 0, TAU); c.fill();
      c.save(); c.beginPath(); c.arc(ix, iy, Rp, 0, TAU); c.clip(); c.globalCompositeOperation = 'lighter';
      dot(c, '#a78bfa', ix, iy, Rp * .9, .35);
      for (const s of arms) { const a = s.a + spin, r = s.r * Rp * .95; dot(c, s.c, ix + Math.cos(a) * r, iy + Math.sin(a) * r * .62, s.s * 1.6, .8); }
      dot(c, '#fff7d6', ix, iy, Rp * .22, .9);
      c.restore(); c.globalCompositeOperation = 'source-over';
    };
    const sparkle = (c, x, y, r, a, col = '#ffffff') => { // étoile à quatre branches
      if (a <= .01) return;
      c.globalAlpha = Math.min(1, a); c.fillStyle = col; c.beginPath();
      c.moveTo(x, y - r); c.quadraticCurveTo(x, y, x + r * .9, y); c.quadraticCurveTo(x, y, x, y + r); c.quadraticCurveTo(x, y, x - r * .9, y); c.quadraticCurveTo(x, y, x, y - r); c.fill();
      dot(c, col, x, y, r * .5, a * .8);
    };
    return {
      frame(tt, dt) {
        t = tt;
        const S = slotsA(env).filter(s => !s.gone), next = S.find(s => !s.on);
        lookTo = next && !revealed ? clamp((next.x - cx) * .3, -Ri * .6, Ri * .6) : 0;
        look += (lookTo - look) * Math.min(1, dt * 3); open += (openTo - open) * Math.min(1, dt * (sleepy ? .9 : 2.5)); dil += (dilTo - dil) * Math.min(1, dt * 3);
        spinV += ((.25 + 1.2 * build + (revealed && !sleepy ? .5 + 1.5 * full : 0)) - spinV) * Math.min(1, dt * 1.5); spin += spinV * dt;
        glow = Math.max(0, glow - dt * .8); full = Math.max(0, full - dt * .08);
        dissolve += ((sleepy ? .2 : Math.min(1, .25 + locks * .12 + build * .3)) - dissolve) * Math.min(1, dt * 1.5);
        if (rainbow) hue += dt * 90;
        // un clignement de temps en temps, une fois révélé (doux, 0,3 s)
        if (revealed && !sleepy && t > blinkAt) { const k = (t - blinkAt) / .3; blink = k < .5 ? k * 2 : Math.max(0, 2 - k * 2); if (k >= 1) { blink = 0; blinkAt = t + rnd(4, 7); } }
        const ey = Ey();
        // ---- derrière la carte : la nuit qui remplace la page, les étoiles, l'œil
        behind(env, () => {
          co.globalCompositeOperation = 'source-over';
          dot(co, dark ? '#1e1b4b' : '#312e81', cx, ey - H * .3, EW * .62, (dark ? .75 : .55) * dissolve, H * 1.7);
          co.globalCompositeOperation = add;
          dot(co, '#8b5cf6', cx, ey - H * .2, EW * .5, (.18 + .25 * glow) * dissolve, H * 1.2);
          for (const s of stars) { const a = dissolve > s.on * .9 ? (.45 + .55 * Math.sin(t * 2 + s.ph) ** 2) * clamp((dissolve - s.on * .9) * 4) : 0; if (a > .02) dot(co, '#ffffff', cx + s.x, ey - H * .35 + s.y, s.s * 2.4, a); }
          co.globalCompositeOperation = 'source-over';
          if (open * (1 - blink) > .01) {
            // le « blanc » de l'œil : une nébuleuse lavande, puis l'iris, coupés par les paupières
            co.save(); almond(co, 0, 0); co.clip();
            const g = co.createRadialGradient(cx, ey, H * .3, cx, ey, EW * .5); g.addColorStop(0, '#4c1d95'); g.addColorStop(.6, '#312e81'); g.addColorStop(1, '#1e1b4b');
            co.globalAlpha = 1; co.fillStyle = g; co.fillRect(cx - EW / 2, ey - H * 3, EW, H * 4);
            co.globalCompositeOperation = 'lighter'; dot(co, '#c4b5fd', cx - EW * .3 + Math.sin(t * .4) * H * .2, ey - H * .1, EW * .18, .35, H * .5); dot(co, '#67e8f9', cx + EW * .3 - Math.sin(t * .4) * H * .2, ey - H * .1, EW * .18, .25, H * .5);
            for (const st of inEye) dot(co, '#ffffff', cx + st.x, ey + st.y, st.s * 2.2, .35 + .45 * Math.sin(t * 2.2 + st.ph) ** 2);
            co.globalCompositeOperation = 'source-over';
            iris(co, 0, 0, false);
            // le reflet de lumière (rend l'œil doux)
            co.globalAlpha = .75; co.fillStyle = '#ffffff'; co.beginPath(); co.ellipse(cx + look - Ri * .45, ey - Ri * .55, Ri * .12, Ri * .08, -.5, 0, TAU); co.fill();
            co.restore();
            // paupières : deux traits de lumière dorée, et les cils en rayons
            const L = almond(co, 0, 0);
            co.globalCompositeOperation = add; co.globalAlpha = .95; co.strokeStyle = dark ? '#fde68a' : '#f59e0b'; co.lineWidth = 2.2; co.stroke();
            co.globalAlpha = .4; co.lineWidth = 6; co.stroke();
            for (let i = 1; i < 10; i++) { const u = i / 10, x = lerp(cx - EW / 2, cx + EW / 2, u), y = (1 - u) * (1 - u) * L.y + 2 * u * (1 - u) * (L.y - L.hu * 2) + u * u * L.y, n = Math.atan2(y - (L.y + H * 1.5), x - cx), len = H * (.18 + .1 * Math.sin(u * Math.PI)) * Math.min(1, open * 2); tail(co, dark ? '#fde68a' : '#f59e0b', x + Math.cos(n) * len, y + Math.sin(n) * len, x, y, 1.6, .7 * (1 - blink)); }
            co.globalCompositeOperation = 'source-over';
          } else { // fermé : un fil de lumière
            co.globalCompositeOperation = add; line(co, dark ? '#fde68a' : '#f59e0b', cx - EW / 2, ey, cx + EW / 2, ey, 1.6, .7); co.globalCompositeOperation = 'source-over';
          }
          // les éclats (rayons, trait anamorphique) derrière la carte
          flares.run(dt, (f, k) => {
            const a = k < .1 ? k / .1 : Math.pow(1 - (k - .1) / .9, 1.4);
            flareNow.push({ a, col: f.col });
            co.globalCompositeOperation = add;
            dot(co, '#ffffff', cx + look, ey, f.r * (.6 + .6 * k), a * .8);
            if (f.rays) godrays(co, f.col, cx + look, ey, f.rays, Ri * .6, EW * .55, t * .3, H * .25, a * .35);
            co.globalCompositeOperation = 'source-over';
          });
          rings.run(dt, (r, k) => { co.globalCompositeOperation = add; co.globalAlpha = (1 - k) * .8; co.strokeStyle = r.col; co.lineWidth = 1.5 + 2.5 * (1 - k); co.beginPath(); co.ellipse(cx, ey, r.r * outCubic(k) + Ri * .5, (r.r * outCubic(k) + Ri * .5) * .5, 0, 0, TAU); co.stroke(); co.globalCompositeOperation = 'source-over'; });
        }, true);
        // ---- dans la carte, derrière les chiffres : la suite de la pupille et de sa galaxie
        ci.save(); ci.globalAlpha = 1; iris(ci, card.x + b0, card.y + b0, true); ci.restore();
        ci.globalCompositeOperation = 'lighter';
        twinkles.run(dt, (s, k) => { sparkle(ci, s.x, s.y, h * .3 * (1 - k * .6), (1 - k) * .9, s.col); });
        ci.globalCompositeOperation = 'source-over'; ci.globalAlpha = 1;
        // ---- devant : la page qui se dissout (grains qui montent des bords de la carte), la poussière d'étoiles
        co.globalCompositeOperation = add;
        if (dissolve > .3 && !sleepy) for (let n = emit((4 + 10 * build) * q * dissolve, dt); n > 0; n--) { const side = Math.random(); dust.add({ x: side < .5 ? card.x + rnd(card.w) : (side < .75 ? card.x - 2 : card.x + card.w + 2), y: side < .5 ? card.y - 2 : card.y + rnd(H), vx: rnd(-8, 8), vy: -rnd(15, 40), drag: .4, max: rnd(1.2, 2), size: rnd(1, 2) }); }
        dust.step(dt);
        dust.each((d, k) => { const a = Math.sin(Math.PI * k) * .8; if (k < .5) { co.globalAlpha = a; co.fillStyle = dark ? '#c4b5fd' : '#7c3aed'; co.fillRect(d.x, d.y, d.size * 1.5, d.size * 1.5); } else dot(co, '#ffffff', d.x, d.y, d.size * 2.2, a); });
        motes.step(dt);
        motes.each((m, k) => { const e = k * k; dot(co, m.c, lerp(m.x0, m.x1, e), lerp(m.y0, m.y1, e), m.s * (1.4 - e * .6), .9); });
        sparks.step(dt);
        sparks.each((s, k) => sparkle(co, s.x, s.y, s.size * (1 - k * .5), (1 - k), s.c));
        // l'éclat cosmique, devant : un trait anamorphique sur le bord haut de la carte (au-dessus des chiffres) et une
        // grande étoile au sommet de l'iris
        for (const f of flareNow) { const y = card.y - H * .06; dot(co, f.col, cx, y, EW * .8 * (.6 + .4 * f.a), f.a * .9, H * .05); dot(co, '#ffffff', cx, y, EW * .35, f.a * .9, H * .025); sparkle(co, cx + look, Ey() - Ri * .82, H * (.35 + .5 * f.a), f.a, '#ffffff'); }
        flareNow.length = 0;
        co.globalCompositeOperation = 'source-over'; co.globalAlpha = 1;
      },
      lock(p, o) {
        locks++;
        if (!revealed) openTo = Math.min(.72, .14 + locks * .09);
        const ip = bInner(env, p);
        // la poussière d'étoiles converge sur le chiffre, puis l'éclat (en avance de 0,3 s : le chiffre se forme dedans)
        for (let i = Math.round((o.ghost ? 5 : o.last ? 22 : 12) * q); i > 0; i--) { const a = rnd(TAU), r = H * rnd(.7, 1.4); motes.add({ x0: p.x + Math.cos(a) * r, y0: p.y + Math.sin(a) * r * .7, x1: p.x, y1: p.y, max: rnd(.22, .34), s: rnd(1.5, 3), c: pick(['#ffffff', '#c4b5fd', '#67e8f9', '#fde68a']) }); }
        if (!o.ghost) { twinkles.add({ x: ip.x, y: ip.y, life: o.last ? .9 : .6, col: '#ffffff' }); glow = Math.max(glow, o.last ? 1 : .4); }
        if (o.last) { build = 0; dilTo = .5; for (let i = Math.round(10 * q); i > 0; i--) { const a = rnd(TAU), v = H * rnd(1, 2.5); sparks.add({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 2, max: rnd(.5, .9), size: rnd(3, 6), c: pick(['#ffffff', '#fde68a', '#c4b5fd']) }); } }
      },
      build() { build = 1; dilTo = .72; openTo = Math.max(openTo, .8); },
      reveal(tier) {
        const p = POWER[tier] || 0; asc = ASCEND[tier] || 0;
        revealed = true; build = 0; blinkAt = t + 5;
        if (!p) { sleepy = true; openTo = 0; dilTo = .5; return; } // il s'endort doucement
        openTo = p < 1 ? .7 + .15 * p : 1; dilTo = .45; glow = 1; // grand ouvert : seulement dès Mythic
        const col = asc >= 2 ? '#fde68a' : asc ? '#67e8f9' : '#c4b5fd';
        flares.add({ life: .9 + .8 * p, r: Ri * (1 + p), col, rays: p >= 1 ? 12 + 4 * asc : 0 });
        rings.add({ life: 1.2, r: EW * (.25 + .2 * p), col });
        if (p < 1) return;
        // l'œil s'ouvre en entier : éclat cosmique
        full = 1; rainbow = asc >= 3;
        for (let i = 1; i <= 1 + asc; i++) rings.add({ delay: i * .25, life: 1.4, r: EW * (.4 + .12 * i), col: i % 2 ? '#67e8f9' : '#fde68a' });
        for (let i = Math.round((26 + 14 * asc) * q); i > 0; i--) { const a = rnd(TAU), v = H * rnd(1.5, 4.5); sparks.add({ x: cx + Math.cos(a) * card.w * .3, y: card.y + rnd(H), vx: Math.cos(a) * v * 1.3, vy: Math.sin(a) * v * .7, drag: 1.4, max: rnd(.9, 1.6), size: rnd(3, 7), c: pick(['#ffffff', '#fde68a', '#c4b5fd', '#67e8f9']) }); }
      },
    };
  };
  // ==== fin du lot D ====

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
        // miss(tier) : une scène peut quand même y réagir en petit (Ninja : son kaomoji, idée de casmictechthing 2026-10-28).
        reveal: guard(tier => { if (tier === 'garbage' || tier === 'landwaste') { if (scene.miss) scene.miss(tier); restSince = t + (scene.miss ? 3 : 1); return; } scene.reveal(tier); restSince = t + 4 + 4 * (POWER[tier] || 0) + 2 * (ASCEND[tier] || 0); }),
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
