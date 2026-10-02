/* RNG∞ — séquences des skins : quand on tire avec un skin, la rotation, chaque chiffre qui se pose et la révélation
 * jouent une petite scène propre au skin (flammes et braises, saut dans l'hyperespace, arcs électriques…), en plus de
 * ses animations CSS. Deux canvas par tirage : un dans la carte, derrière les chiffres (la matière vivante du skin), un
 * autour d'elle, par-dessus (ce qui en jaillit).
 *   const fx = SkinFX.mount(scène, carte, 'fire')   → null si ce skin n'a pas de séquence
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
  const POWER = { trash: 0, common: .12, uncommon: .25, rare: .42, epic: .62, anomaly: .8, mythic: 1 };
  // Nombre de particules d'une révélation : quelques-unes pour un Common (un tirage sur deux), `most` pour un Mythic.
  const burst = (p, most, few = 4) => Math.round(few + most * Math.pow(p, 1.25));

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
    vaporwave: pieces({ live: { grid: '#ff71ce', chase: ['#ff71ce', '#01cdfe'], sweep: '#fffb96' }, cols: ['#ff71ce', '#01cdfe', '#b967ff', '#fffb96'], shapes: ['seg', 'star', 'square'], size: [2, 4.5], g: 0, drag: 1.6, glowc: '#ff71ce', ring: '#01cdfe', drift: { rate: 6, from: 'around' } }),
    rainbow: pieces({ live: { rays: RAINBOW, chase: ['#ef4444', '#facc15', '#3b82f6', '#a855f7'], twinkle: '#ffffff' }, cols: RAINBOW, shapes: ['star', 'drop', 'sprinkle'], size: [2.6, 5.2], g: 380, drag: 1, up: true, life: 1.4, glowc: '#f0abfc', ring: '#a855f7', drift: { rate: 9, from: 'top' } }),
  });

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
    const ORE = { common: ['#d8d8d8', '#9a9a9a'], uncommon: ['#4ade80', '#15803d'], rare: ['#38bdf8', '#0369a1'], epic: ['#c084fc', '#7e22ce'], anomaly: ['#fbbf24', '#b45309'], mythic: ['#5eead4', '#0f766e'] };
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

  // ---------------------------------------------------------------- montage sur une carte
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function mount(stage, card, skin) {
    try {
      const make = SCENES[skin];
      if (!make || !stage || !card || reduced()) return null;
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
        dark: document.documentElement.classList.contains('dark'), q: root.innerWidth < 720 ? .65 : 1,
      };
      const scene = make(env);
      let t = 0, last = 0, raf = 0, stopped = false, restSince = Infinity, skip = false, owed = 0;
      const frame = now => {
        if (stopped || !outer.isConnected) return;
        raf = requestAnimationFrame(frame);
        const dt = Math.min(.05, last ? (now - last) / 1000 : 0);
        last = now;
        // Une fois la révélation retombée : une image sur deux, puis plus rien après 40 s (la dernière image reste).
        if (t > restSince + 40) { stopped = true; return; }
        owed += dt;
        if (t > restSince && (skip = !skip)) return;
        t += owed;
        ci.clearRect(0, 0, w, h);
        co.clearRect(0, 0, W, H);
        ci.globalAlpha = co.globalAlpha = 1;
        scene.frame(t, owed);
        owed = 0;
      };
      raf = requestAnimationFrame(frame);
      const guard = fn => (...a) => { try { if (!stopped) fn(...a); } catch (e) { /* une scène ne doit jamais casser le tirage */ } };
      return {
        lock: guard((slot, o = {}) => {
          const s = slot.getBoundingClientRect(), b = outer.getBoundingClientRect(), k = W / (b.width || W);
          scene.lock({ x: (s.left + s.width / 2 - b.left) * k, y: (s.top + s.height / 2 - b.top) * k }, o);
        }),
        build: guard(ms => scene.build(ms)),
        reveal: guard(tier => { scene.reveal(tier); restSince = t + 4 + 4 * (POWER[tier] || 0); }),
        stop() { stopped = true; cancelAnimationFrame(raf); },
      };
    } catch (e) {
      return null;
    }
  }

  root.SkinFX = { mount, has: skin => !!SCENES[skin] };
})(window);
