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
      let locked = 0;
      return {
        frame(t, dt) {
          co.globalCompositeOperation = 'source-over';
          const bw = card.w * .7, bx = cx - bw / 2, by = card.y + card.h + 30, n = 12, fill = Math.round(n * Math.min(1, locked / 6 + Math.max(0, st.heat - .5) * .25));
          for (let i = 0; i < n; i++) { co.globalAlpha = i < fill ? 1 : .22; co.fillStyle = i < fill ? ['#4ade80', '#4ade80', '#facc15', '#f472b6'][Math.min(3, (i / 3) | 0)] : '#64748b'; co.fillRect(Math.round(bx + i * (bw / n)), by, Math.round(bw / n) - 3, 8); } // barre de puissance
          booms.run(dt, (b, k) => { const r = b.size * outCubic(k); co.globalAlpha = 1 - k; co.fillStyle = b.c; for (let i = 0; i < 8; i++) { const a = i * TAU / 8; for (let j = 1; j <= 3; j++) co.fillRect(Math.round((b.x + Math.cos(a) * r * j / 3) / 4) * 4, Math.round((b.y + Math.sin(a) * r * j / 3) / 4) * 4, 4, 4); } });
          pops.run(dt, (f, k) => text(co, f.str, f.x, f.y - 26 * outCubic(k), f.size, f.c, (1 - k) * 2.5));
        },
        lock(p, o) { if (o.ghost) return; locked++; pops.add({ x: p.x, y: p.y - card.h * .6, str: o.last ? '+500' : '+100', size: 9, c: o.last ? '#facc15' : '#4ade80', life: .8 }); booms.add({ x: p.x, y: p.y, size: card.h * (o.last ? .9 : .5), c: '#22d3ee', life: .4 }); },
        reveal(tier, p) { pops.add({ x: cx, y: card.y - 30, str: p >= 1 ? 'PERFECT!!' : p >= .8 ? 'HIGH SCORE' : p > .4 ? 'COMBO x' + Math.round(2 + 8 * p) : p ? 'OK' : 'GAME OVER', size: 10 + 6 * p, c: p ? '#facc15' : '#f87171', life: 1.6 + p }); for (let i = Math.round(8 * p); i > 0; i--) booms.add({ delay: rnd(0, 1.2 * p), x: rnd(card.x - 110, card.x + card.w + 110), y: rnd(card.y - 90, card.y + card.h + 40), size: rnd(18, 40), c: pick(['#22d3ee', '#f472b6', '#facc15', '#4ade80']), life: .5 }); },
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
    // 🌴 Vaporwave — un soleil rayé se lève derrière la carte, l'image « glitche » à chaque chiffre, des triangles néon s'envolent à la révélation.
    vaporwave: (env, { cx, cy, st }) => {
      const { co, card, dark } = env, glitches = timed(), tris = particles();
      let rise = 0;
      return {
        frame(t, dt) {
          rise += ((st.revealed ? .5 + .5 * st.p : .25 + .3 * st.heat) - rise) * Math.min(1, dt * 2);
          co.globalCompositeOperation = 'source-over';
          const r = card.h * 1.15, sy = card.y + card.h * .2 - rise * card.h * 1.1; // soleil rayé derrière le haut de la carte
          for (let i = 0; i < 11; i++) { const y = sy - r + (i / 11) * r * 2, half = Math.sqrt(Math.max(0, r * r - (y - sy) * (y - sy))); if (y > card.y - 2) continue; co.globalAlpha = dark ? .85 : .7; co.fillStyle = i < 5 ? '#fffb96' : i < 8 ? '#ff9a5c' : '#ff71ce'; co.fillRect(cx - half, y, half * 2, r * 2 / 11 - (i > 5 ? (i - 5) * 1.2 : 0)); }
          glitches.run(dt, (g, k) => { co.globalAlpha = (1 - k) * .75; for (let i = 0; i < 4; i++) { co.fillStyle = i % 2 ? '#01cdfe' : '#ff71ce'; co.fillRect(g.x - g.w / 2 + Math.sin(i * 9 + k * 30) * 14, g.y - g.h / 2 + i * g.h / 4, g.w, g.h / 8); } });
          tris.step(dt);
          tris.each((p, k) => { co.save(); co.translate(p.x, p.y); co.rotate(p.rot + k * 3); co.globalAlpha = 1 - k; co.strokeStyle = p.c; co.lineWidth = 2; co.beginPath(); co.moveTo(0, -p.size); co.lineTo(p.size * .87, p.size * .5); co.lineTo(-p.size * .87, p.size * .5); co.closePath(); co.stroke(); co.restore(); });
        },
        lock(p, o) { if (!o.ghost) glitches.add({ x: p.x, y: p.y, w: card.h * (o.last ? 2.6 : .9), h: card.h * .9, life: .28 }); },
        reveal(tier, p) { glitches.add({ x: cx, y: cy, w: card.w * 1.2, h: card.h * 1.3, life: .3 + .3 * p }); for (let i = burst(p, 50, 3); i > 0; i--) tris.add({ x: rnd(card.x - 60, card.x + card.w + 60), y: rnd(card.y, card.y + card.h), vx: rnd(-50, 50), vy: -rnd(40, 160), max: rnd(1.2, 2.4), size: rnd(6, 16), rot: rnd(TAU), c: pick(['#ff71ce', '#01cdfe', '#b967ff', '#fffb96']) }); },
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
