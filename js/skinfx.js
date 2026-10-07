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
    let locked = 0, heat = 0, target = .35, p = 0, since = 0, revealed = false, grown2 = 0, growTo = .12, moon = 0, wind = 0;
    function flower(x, y, s, rot, open) { // cinq pétales en cœur, un cœur sombre, des étamines dorées
      if (open <= .02) return;
      const k = outBack(open) * s;
      for (let i = 0; i < 5; i++) { const a = rot + (i * TAU) / 5; oval(co, x + Math.cos(a) * k * .62, y + Math.sin(a) * k * .62, k * .62, k * .4, a, i % 2 ? PALE : PINK, .96); }
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
        const mr = Math.min(25, card.h * .36), mx = card.x + card.w * .86, my = card.y + 12 - 30 * moon;
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
        // Le cercle au pinceau : il se trace en .7 s, plein au départ, effilé à l'arrivée, puis s'efface doucement.
        if (revealed) {
          const drawn = outCubic(Math.min(1, since / .7)), fade = Math.max(0, Math.min(1, (3 + 3.5 * p - since) / 1.5)), rx = card.w * .5 + 34 + 10 * p, ry = card.h * .5 + 24 + 8 * p, a0 = -2.3, N = 70;
          co.strokeStyle = GOLD; co.lineCap = 'round';
          for (let i = 0; i < Math.floor(N * drawn); i++) {
            const u = i / N, a = a0 + u * TAU * .955, b = a0 + ((i + 1.15) / N) * TAU * .955, wob = 1 + .018 * Math.sin(u * 23);
            co.globalAlpha = fade * (.92 - .35 * u); co.lineWidth = (1.2 + 6.2 * Math.pow(1 - u, .7) * (.85 + .15 * Math.sin(u * 41))) * (.8 + .5 * p);
            co.beginPath(); co.moveTo(cx + Math.cos(a) * rx * wob, cy + Math.sin(a) * ry * wob); co.lineTo(cx + Math.cos(b) * rx * wob, cy + Math.sin(b) * ry * wob); co.stroke();
          }
          oval(co, cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry, 5 + 3 * p, 4 + 2 * p, a0, GOLD, fade * Math.min(1, since * 6));
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
        glints.add({ x: cx, y: cy, size: card.h * (.6 + .9 * p), life: .9, delay: .1 });
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
    let heat = 0, target = .35, p = 0, since = 0, revealed = false, formed = 0, innerFlash = 0;
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
        flashes.run(dt, (f, k) => { const a = 1 - outCubic(k); dot(co, '#ffffff', f.x, f.y, f.size * (.45 + .6 * k), a * .85); dot(co, CYAN, f.x, f.y, f.size * (1.4 + 1.6 * k), a * .4); });
        sparks.step(dt);
        sparks.each((d, k) => { tail(co, dark ? WHITE : BLUE, d.x - d.vx * .035, d.y - d.vy * .035, d.x, d.y, d.size, 1 - k); });
        // L'onde de tonnerre : le contour de la carte qui s'élargit.
        rings.run(dt, (r, k) => { const e = outCubic(k), g = grown(card, 6 + r.grow * e); roundRect(co, g.x, g.y, g.w, g.h, g.r); co.globalAlpha = (1 - k) * .16; co.strokeStyle = BLUE; co.lineWidth = 5 * r.width; co.stroke(); co.globalAlpha = (1 - k) * .8; co.strokeStyle = dark ? WHITE : DEEPB; co.lineWidth = 1.1 * r.width; co.stroke(); });
        // Boules de foudre en orbite après la révélation, avec leur traîne et leurs arcs vers le cadre.
        if (revealed) orbs.forEach((o, i) => {
          const life = Math.max(0, Math.min(1, since * 2) * Math.min(1, (3.5 + 3.5 * p - since)));
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
        orbs.length = 0;
        for (let i = 0; i < 1 + Math.round(2 * p); i++) orbs.push({ s: i / 3 + rnd(.1), v: (i % 2 ? -1 : 1) * rnd(.3, .46) });
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
    let s = rnd(), speed = .09, heat = 0, target = .35, p = 0, since = 0, revealed = false, jaw = 0, tt = 0, innerFlash = 0, rest = 0;
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
        // Le corps, de la queue vers la tête : anneaux d'obsidienne, croissant rouge, arête dorsale dorée.
        co.globalCompositeOperation = 'source-over';
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
        // Le corps rougeoie quand la tension monte ; les yeux et la gueule brillent.
        co.globalCompositeOperation = add;
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
        glints.run(dt, (g, k) => { const a = 1 - outCubic(k), r = g.size * (.4 + outExpo(k)); dot(co, '#ffffff', g.x, g.y, r * .32, a); dot(co, PALE, g.x, g.y, r * 2.3, a * .95, 1.5); dot(co, PALE, g.x, g.y, 1.5, a * .95, r * 2.3); dot(co, EMBER, g.x, g.y, r, a * .5); });
        // Le trésor : des pièces d'or qui retombent en tournant.
        co.globalCompositeOperation = 'source-over';
        coins.step(dt);
        coins.each((d, k) => { co.save(); co.translate(d.x, d.y); co.globalAlpha = Math.min(1, (1 - k) * 3); co.fillStyle = d.c; SHAPES.coin(co, d, d.size); co.restore(); });
      },
      lock(pos, o) {
        if (o.ghost) return;
        breaths.push({ x: pos.x, y: pos.y, t: 0, life: o.last ? .42 : .3, big: !!o.last, hit: false });
        if (o.last) { target = .35; rings.add({ life: .8, grow: 30, width: 1, delay: .18 }); }
        heat = Math.min(1.4, heat + .16);
      },
      build() { target = 1.3; },
      reveal(tier) {
        p = POWER[tier] || 0; revealed = true; since = 0; heat = .8 + .7 * p; target = .3 + .3 * p; jaw = 1;
        for (let i = 0; i < 2 + Math.round(2 * p); i++) rings.add({ delay: i * .14, life: 1, grow: 30 + 20 * i + 34 * p, width: 1 + .6 * p });
        glints.add({ x: cx, y: cy, size: card.h * (.7 + 1 * p), life: .9 });
        for (let i = burst(p, 170 * q, 14); i > 0; i--) { const from = along(card, rnd()), a = Math.atan2(from.y - cy, from.x - cx) + rnd(-.5, .5), v = rnd(90, 220 + 380 * p); flame(from.x, from.y, Math.cos(a) * v, Math.sin(a) * v, rnd(5, 10 + 5 * p), rnd(.45, .9 + .5 * p)); }
        for (let i = burst(p, 64 * q, 5); i > 0; i--) coins.add({ x: card.x + rnd(-40, card.w + 40), y: card.y - rnd(30, 120), vx: rnd(-50, 50), vy: rnd(-140, 20), g: 560, drag: .3, max: rnd(1.5, 2.6), size: rnd(3.4, 5.6), c: pick(['#fbbf24', '#f59e0b', '#fde68a']), rot: rnd(TAU) });
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
    const RX = card.w * .5 + 30, RY = card.h * .5 + 28, TILT = -.09, cosT = Math.cos(TILT), sinT = Math.sin(TILT);
    const place = (a, rx, ry) => { const x = Math.cos(a) * rx, y = Math.sin(a) * ry; return { x: cx + x * cosT - y * sinT, y: cy + x * sinT + y * cosT }; };
    const disc = Array.from({ length: Math.round(170 * q) }, () => { const r = rnd(1, 1.36); return { a: rnd(TAU), r, r0: r, s: rnd(.7, 1.8) }; });
    const far = Math.min(W, H * 1.6) / 2, star = d => ({ a: rnd(TAU), d: d || rnd(RX * 1.1, far), tw: rnd(TAU), size: rnd(.6, 1.5) });
    const stars = Array.from({ length: Math.round(48 * q) }, () => star());
    const jets = particles(), flung = particles(), pulses = timed(), flashes = timed(), emit = emitter();
    let heat = 0, target = .35, p = 0, since = 0, revealed = false, squeeze = 1, squeezeTo = 1, jet = 0, banged = false, innerFlash = 0;
    const ellipse = (rx, ry, a0 = 0, a1 = TAU, ox = 0, oy = 0) => { co.beginPath(); co.ellipse(cx + ox, cy + oy, Math.max(.1, rx), Math.max(.1, ry), TILT, a0, a1); };
    return {
      frame(t, dt) {
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
        flashes.run(dt, (f, k) => { const a = 1 - outCubic(k); dot(co, '#ffffff', f.x, f.y, f.size * (.4 + .8 * k), a * (dark ? .95 : .7)); dot(co, dark ? '#fff4d6' : ORANGE, f.x, f.y, 2.5, a, f.size * 2.8); dot(co, dark ? '#fb923c' : ORANGE, f.x, f.y, f.size * (1.4 + 2 * k), a * .45); });
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
      reveal(tier) { p = POWER[tier] || 0; revealed = true; banged = false; since = 0; heat = .8 + .7 * p; target = .3 + .3 * p; },
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

  // Deux scènes jouées ensemble : celle du skin (s'il en a une), puis la signature par-dessus.
  const both = (a, b) => ({ frame(t, dt) { if (a) a.frame(t, dt); b.frame(t, dt); }, lock(p, o) { if (a) a.lock(p, o); b.lock(p, o); }, build(ms) { if (a) a.build(ms); b.build(ms); }, reveal(tier) { if (a) a.reveal(tier); b.reveal(tier); } });

  // ---------------------------------------------------------------- montage sur une carte
  const reduced = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
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
      };
      const scene = o.owner ? both(make ? make(env) : null, OWNER(env)) : make(env);
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
      if (!o.manual) raf = requestAnimationFrame(frame);
      const guard = fn => (...a) => { try { if (!stopped) fn(...a); } catch (e) { /* une scène ne doit jamais casser le tirage */ } };
      return {
        lock: guard((slot, o = {}) => {
          const s = slot.getBoundingClientRect(), b = outer.getBoundingClientRect(), k = W / (b.width || W);
          scene.lock({ x: (s.left + s.width / 2 - b.left) * k, y: (s.top + s.height / 2 - b.top) * k }, o);
        }),
        build: guard(ms => scene.build(ms)),
        reveal: guard(tier => { scene.reveal(tier); restSince = t + 4 + 4 * (POWER[tier] || 0); }),
        stop() { stopped = true; cancelAnimationFrame(raf); },
        // Mode manuel (o.manual, pour le trailer) : pas d'horloge ; l'appelant avance la scène lui-même, de dt secondes,
        // et obtient donc la même image pour le même instant.
        step(dt) { if (stopped) return; t += dt; ci.clearRect(0, 0, w, h); co.clearRect(0, 0, W, H); ci.globalAlpha = co.globalAlpha = 1; try { scene.frame(t, dt); } catch (e) { /* une scène ne casse rien */ } },
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
