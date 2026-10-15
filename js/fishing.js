// Pêche : l'habillage « Canne & Dauphins » du Crash (collab avec Firetail, 2026-10-15).
// Les sprites (pêcheur, canne, leurre, dauphins, requin démon, planche) et leurs palettes viennent tels quels de son jeu
// Canne & Dauphins (https://github.com/FireTalesHy/Pechadophin, par L'taleshy et cocobat), repris avec son accord.
// Le jeu lui-même ne change pas : c'est le Crash du serveur (api/_gamble.js). Ici, on ne fait que le dessiner :
//   cast()      la partie démarre : le pêcheur lance sa ligne
//   depth(m)    à chaque image : le leurre descend avec le multiplicateur
//   catch(m)    encaissé : un dauphin mord et la ligne remonte (bleu sous 2×, rose jusqu'à 10×, rouge au-delà)
//   snap(p)     explosé : le requin démon arrache le leurre et casse le fil
//   idle()      retour au ponton ; resume() reprend une partie en cours sans le lancer
(function (root) {
  'use strict';
  const W = 256, H = 144, WY = 72, PY = WY - 12; // largeur, hauteur, surface de l'eau, dessus du ponton (en pixels)
  const LX = 150, PER_LOG = 240; // x du leurre dans l'eau ; pixels de descente par unité de ln(multiplicateur)
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  // ---- sprites de Firetail (mêmes grilles, mêmes palettes, même contour)
  function spr(rows, pal, outline) {
    const w = Math.max(...rows.map(r => r.length)), h = rows.length, pad = outline ? 1 : 0;
    const c = mk(w + pad * 2, h + pad * 2), g = c.getContext('2d');
    for (let y = 0; y < h; y++) for (let x = 0; x < rows[y].length; x++) { const col = pal[rows[y][x]]; if (col) { g.fillStyle = col; g.fillRect(x + pad, y + pad, 1, 1); } }
    if (outline) {
      const Wd = c.width, Hd = c.height, d = g.getImageData(0, 0, Wd, Hd).data;
      const sol = (x, y) => x >= 0 && y >= 0 && x < Wd && y < Hd && d[(y * Wd + x) * 4 + 3] > 0;
      g.fillStyle = pal.k || '#14182c';
      for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) if (!sol(x, y) && (sol(x - 1, y) || sol(x + 1, y) || sol(x, y - 1) || sol(x, y + 1))) g.fillRect(x, y, 1, 1);
    }
    return c;
  }
  function tint(src, color) { const c = mk(src.width, src.height), g = c.getContext('2d'); g.drawImage(src, 0, 0); g.globalCompositeOperation = 'source-atop'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height); return c; }
  const PAL_P = { k: '#14182c', h: '#ffd23f', H: '#e0a010', s: '#f6c19a', S: '#d98f66', b: '#3a78e0', B: '#27479a', n: '#7a4a21', p: '#3a78e0', w: '#ffffff', r: '#d63a3a', g: '#ffd23f', c: '#d92b3a', y: '#fff2a8' };
  const LEGS = {
    idle: ['....kppk.kppk...', '....kppk.kppk...', '...knnnk.knnnk..', '...kkkkk.kkkkk..'],
    jump: ['....kppk..kppk..', '...kppk....kppk.', '...knnk.....knnk', '...kkkk.....kkkk'],
  };
  const HAT = ['................', '.....kkkkkk.....', '....khhhhhhk....', '...khhhhhhhhk...', '..kHHHHHHHHHHk..'];
  const FACE = ['...kssssssssk...', '...kssssskssk...', '...ksssssssSk...', '....kkssssskk...'];
  const TORSO = ['...kbbbbbbbbk...', '...kbbbbbbbbssk.', '...kBBBBBBBBk...'];
  const ROD = '#8a5a2b';
  const DOL = ['DD.......D......', '.DD.....DDD.....', '..DDdddddddd....', '..ddddddddddddd.', '...ddddddddedddd', '....lllllllllddd', '.....lllllllll..', '.......DD.......'];
  const LURE_ROWS = ['o...oo..', 'oo.oooo.', 'ooooooeo', 'oo.oooo.', 'o...oo..'];
  function sharkRows() {
    const Wd = 44, Hd = 27, yc = 15, g = [];
    for (let y = 0; y < Hd; y++) g.push(new Array(Wd).fill('.'));
    const set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && x < Wd && y >= 0 && y < Hd) g[y][x] = c; };
    const hh = x => { const t = (x - 6) / 37; if (t <= 0 || t >= 1) return 0; return 8 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.8); };
    const line = (x0, y0, x1, y1, th, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n; for (let d = 0; d < th; d++) set(x, y + d, c); } };
    const tri = (ax, ay, bx, by, cx, cy, c) => {
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      for (let y = Math.floor(Math.min(ay, by, cy)); y <= Math.ceil(Math.max(ay, by, cy)); y++)
        for (let x = Math.floor(Math.min(ax, bx, cx)); x <= Math.ceil(Math.max(ax, bx, cx)); x++) {
          const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, l3 = 1 - l1 - l2;
          if (l1 >= 0 && l2 >= 0 && l3 >= 0) set(x, y, c);
        }
    };
    for (let x = 6; x < 43; x++) { const h = hh(x), top = Math.round(yc - h), bot = Math.round(yc + h * 0.85); for (let y = top; y <= bot; y++) set(x, y, y > yc + h * 0.25 ? 'L' : 'R'); }
    line(9, yc - 1, 1, yc - 10, 4, 'D'); line(9, yc + 1, 3, yc + 8, 4, 'D'); tri(5, yc - 3, 10, yc - 2, 9, yc + 3, 'D'); tri(2, yc - 9, 8, yc - 2, 8, yc + 6, 'D');
    tri(16, yc - 6, 27, yc - 7, 24, yc - 17, 'D');
    tri(19, yc + 6, 28, yc + 6, 17, yc + 15, 'D');
    for (const gx of [27, 29, 31]) for (let y = yc - 2; y <= yc + 3; y++) set(gx, y, 'D');
    tri(31, yc - 6, 34, yc - 6, 34, yc - 13, 'h'); set(34, yc - 13, 'H');
    tri(35, yc - 4, 38, yc - 4, 38, yc - 10, 'h'); set(38, yc - 10, 'H');
    for (let x = 35; x <= 37; x++) { set(x, yc - 2, 'y'); set(x, yc - 1, 'y'); }
    set(37, yc - 1, 'e');
    set(34, yc - 4, 'e'); set(35, yc - 4, 'e'); set(36, yc - 3, 'e'); set(37, yc - 3, 'e'); set(38, yc - 2, 'e');
    for (let x = 30; x <= 42; x++) { const my = Math.round(yc + 3 - (x - 30) * (2 / 12)); set(x, my, 'e'); set(x, my + ((x - 30) % 2 === 0 ? -1 : 1), 'w'); }
    return g.map(r => r.join(''));
  }
  const SHARK_PAL = { R: '#c8141f', D: '#7d0b13', L: '#f08a78', w: '#ffffff', y: '#ffe14d', e: '#14182c', h: '#4a0a10', H: '#ff6a3d', k: '#2a0408' };
  const SKY = ['#3f8fe8', '#4a9aec', '#57a6f0', '#66b2f3', '#78bff5', '#8dcbf7', '#a3d7f9', '#bce3fb'];
  // Fond de l'eau, de la surface vers les profondeurs (assombri pour qu'on sente la descente).
  const DEEP = [[43, 120, 207], [33, 98, 182], [24, 76, 150], [17, 56, 118], [12, 38, 86], [8, 24, 58], [5, 14, 36]];

  let S = null; // sprites, construits au premier montage (il faut un document)
  function build() {
    const pal = PAL_P;
    S = {
      man: spr(HAT.concat(FACE, TORSO, LEGS.idle), pal, false),
      jump: spr(HAT.concat(FACE, TORSO, LEGS.jump), pal, false),
      dol: {
        blue: spr(DOL, { D: '#2a6fb0', d: '#4aa8e8', l: '#d6f1ff', e: '#14182c' }, true),
        pink: spr(DOL, { D: '#b84a86', d: '#f58fb8', l: '#ffe3ee', e: '#14182c' }, true),
        red: spr(DOL, { D: '#a8321e', d: '#e8622e', l: '#ffd9a8', e: '#14182c' }, true),
      },
      lure: spr(LURE_ROWS, { o: '#ff9a3c', e: '#14182c' }, true),
      shark: spr(sharkRows(), SHARK_PAL, true),
      plank: (() => {
        const c = mk(16, 16), g = c.getContext('2d');
        g.fillStyle = '#6b3f1c'; g.fillRect(0, 0, 16, 7);
        g.fillStyle = '#c98a4b'; g.fillRect(0, 0, 16, 5);
        g.fillStyle = '#e8b57a'; g.fillRect(0, 0, 16, 1);
        g.fillStyle = '#a56d36'; g.fillRect(5, 1, 1, 4); g.fillRect(11, 1, 1, 4);
        g.fillStyle = '#3a2410'; g.fillRect(2, 2, 1, 1); g.fillRect(8, 2, 1, 1); g.fillRect(14, 2, 1, 1);
        return c;
      })(),
    };
    S.sharkW = tint(S.shark, '#ffffff');
    S.dolFaded = { blue: fade(S.dol.blue), pink: fade(S.dol.pink), red: fade(S.dol.red) };
  }
  // Dauphins du décor : un peu fondus dans l'eau, pour rester derrière le leurre.
  function fade(src) { const c = mk(src.width, src.height), g = c.getContext('2d'); g.globalAlpha = .5; g.drawImage(src, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(20,60,120,.35)'; g.fillRect(0, 0, c.width, c.height); return c; }

  const kindOf = m => (m >= 10 ? 'red' : m >= 2 ? 'pink' : 'blue');
  const depthOf = m => Math.max(0, Math.log(Math.max(1, m)) * PER_LOG);
  const ease = u => (u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function create(canvas) {
    if (!S) build();
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    const st = { phase: 'idle', t0: 0, lureY: PY + 6, lureX: 0, target: 0, camY: 0, kind: 'blue', parts: [], bubbles: [], flash: 0, shake: 0, sharkX: 0, startY: 0, jumpUntil: 0, snapEnd: null, raf: 0 };
    const now = () => performance.now() / 1000;
    const manX = 74, manTop = PY - 16, hand = () => ({ x: manX + 5, y: manTop + 10 });
    // Bout de la canne : au repos, levée ; pendant le lancer, elle part en arrière puis fouette vers l'avant.
    const tip = t => {
      const h = hand();
      if (st.phase === 'cast') {
        const u = (t - st.t0) / .55;
        const a = u < .3 ? -2.3 + (-.3) * (u / .3) : u < .5 ? -2.6 + 2.0 * ((u - .3) / .2) : -.6;
        return { x: h.x + Math.cos(a) * 23, y: h.y + Math.sin(a) * 23 };
      }
      const bend = st.phase === 'reel' ? 3 : st.phase === 'down' ? 1 : 0;
      return { x: h.x + 19, y: h.y - 13 + bend };
    };
    function px(x, y, w, h, col) { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); }
    function line(x0, y0, x1, y1, col) {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy; g.fillStyle = col;
      for (let i = 0, n = dx - dy + 2; i < n; i++) {
        if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) g.fillRect(x0, y0, 1, 1);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    function disc(cx, cy, r) { for (let y = -r; y <= r; y++) { const w = Math.round(Math.sqrt(r * r - y * y)); g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1); } }
    function cloud(x, y, u) {
      const body = () => { disc(x + 8 * u, y, 7 * u); disc(x + 18 * u, y - 4 * u, 9 * u); disc(x + 30 * u, y, 7 * u); g.fillRect(Math.round(x + 8 * u), Math.round(y), 22 * u, Math.round(7 * u)); };
      g.fillStyle = '#cfe3f8'; g.save(); g.translate(0, 2 * u); body(); g.restore();
      g.fillStyle = '#ffffff'; body();
    }
    const splash = (x, y, n, col) => { for (let i = 0; i < n; i++) st.parts.push({ x, y, vx: (Math.random() - .5) * 70, vy: -30 - Math.random() * 60, l: .6 + Math.random() * .4, c: col || '#d8f1ff' }); };

    function draw(t, dt) {
      // Caméra : suit le leurre quand il descend, revient au ponton sinon.
      const wantCam = st.phase === 'down' || st.phase === 'reel' || (st.phase === 'snap' && t - st.t0 < 2) ? Math.max(0, st.lureY - H * .6) : 0;
      st.camY += (wantCam - st.camY) * Math.min(1, dt * (st.phase === 'down' ? 9 : st.phase === 'snap' ? 2.2 : 5));
      if (Math.abs(st.camY - wantCam) < .2) st.camY = wantCam;
      const cy = Math.round(st.camY), shx = st.shake > 0 ? Math.round((Math.random() - .5) * 4 * st.shake) : 0;
      st.shake = Math.max(0, st.shake - dt * 2.5);
      g.save(); g.translate(shx, 0);
      // ciel, soleil, nuages
      const bh = Math.ceil(WY / SKY.length);
      for (let i = 0; i < SKY.length; i++) { const y = i * bh - cy; if (y + bh > 0 && y < H) px(-4, y, W + 8, bh + 1, SKY[i]); }
      if (WY - cy > 0) {
        g.fillStyle = '#fff6c2'; disc(150, 20 - cy, 13); g.fillStyle = '#ffe97a'; disc(150, 20 - cy, 10);
        for (const [x0, y, u, sp] of [[20, 18, 1, 3], [120, 30, 1, 5], [200, 12, 1, 2.5], [300, 40, 1, 4]]) cloud(((x0 + t * sp) % (W + 60)) - 50, y - cy, u);
      }
      // eau : une ligne par rangée de pixels, de plus en plus sombre avec la profondeur
      for (let sy = Math.max(0, WY - cy); sy < H; sy++) {
        const d = (sy + cy - WY) / 260, i = Math.min(DEEP.length - 2, Math.floor(d)), f = Math.min(1, d - i), a = DEEP[i], b = DEEP[i + 1];
        g.fillStyle = `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`; g.fillRect(-4, sy, W + 8, 1);
      }
      // rayons de lumière sous la surface
      if (WY - cy > -60) { g.fillStyle = 'rgba(214,241,255,.06)'; for (let k = 0; k < 4; k++) { const x = 40 + k * 60 + Math.sin(t * .5 + k) * 8; g.beginPath(); g.moveTo(x, WY - cy); g.lineTo(x + 14, WY - cy); g.lineTo(x + 34, WY - cy + 90); g.lineTo(x + 18, WY - cy + 90); g.fill(); } }
      // plancton : des points fixes dans l'eau, qui défilent vers le haut quand la caméra descend (on sent la vitesse)
      g.fillStyle = 'rgba(214,241,255,.35)';
      for (let k = Math.floor(cy / 12); k <= Math.floor((cy + H) / 12); k++) {
        const wy = k * 12; if (wy < WY + 6) continue;
        for (let j = 0; j < 2; j++) { const hsh = Math.sin(k * 91.7 + j * 37.3) * 43758.5453, fx = hsh - Math.floor(hsh); g.fillRect(Math.round(fx * W + Math.sin(t * .7 + k + j) * 3), wy + j * 6 - cy, 1, 1); }
      }
      // dauphins du décor : un par tranche de profondeur, bleus près de la surface, roses puis rouges plus bas
      for (let k = Math.max(0, Math.floor((cy - 40) / 110)); k <= Math.floor((cy + H) / 110); k++) {
        const wy = WY + 40 + k * 110, sy = wy - cy; if (sy < -12 || sy > H + 4 || k > 400) continue;
        const dir = k % 2 ? 1 : -1, sp = 14 + (k * 7) % 11, span = W + 60, x = dir > 0 ? ((t * sp + k * 53) % span) - 30 : span - 30 - ((t * sp + k * 53) % span);
        const kind = k < 3 ? 'blue' : k < 9 ? 'pink' : 'red', img = S.dolFaded[kind];
        g.save(); g.translate(Math.round(x), Math.round(sy + Math.sin(t * 2 + k) * 2)); if (dir < 0) g.scale(-1, 1); g.drawImage(img, -9, -5); g.restore();
      }
      // ponton : pieux puis planches
      const py = PY - cy;
      if (py < H + 8) {
        for (const x of [6, 38, 70]) { px(x, py + 4, 4, Math.max(0, WY - PY - 4), '#5a3418'); px(x, WY - cy, 4, 26, '#20456e'); px(x + 3, py + 4, 1, WY - PY - 4, '#3a2410'); }
        for (let x = -8; x < 88; x += 16) g.drawImage(S.plank, x, py);
      }
      // surface : la bande claire et les vaguelettes de son jeu
      if (WY - cy > -4 && WY - cy < H + 4) {
        px(-4, WY - cy - 1, W + 8, 3, '#4a9be8');
        g.fillStyle = '#d8f1ff'; for (let x = 0; x < W + 4; x += 4) g.fillRect(x, WY - cy - 2 + (Math.sin(t * 3 + x * .15) > 0 ? 0 : 1), 4, 2);
      }
      // pêcheur (sursaute quand le fil casse) et canne
      const tp = tip(t), h = hand(), bob = st.phase === 'idle' || st.phase === 'landed' || st.phase === 'broken' ? Math.floor(t * 1.4) % 2 : 0;
      if (manTop - cy < H) {
        g.drawImage(t < st.jumpUntil ? S.jump : S.man, manX - 8, manTop - cy - bob + (t < st.jumpUntil ? -2 : 0));
        line(h.x, h.y - cy - bob, tp.x, tp.y - cy - bob, ROD);
        px(tp.x, tp.y - cy - bob, 1, 1, '#ffe0a0');
      }
      const ty = tp.y - cy - bob;
      // fil, leurre, prise
      let lx = LX, ly = st.lureY;
      if (st.phase === 'idle') { lx = tp.x + Math.sin(t * 1.8) * 1.5; ly = tp.y + 9; }
      else if (st.phase === 'cast') {
        const u = clamp((t - st.t0 - .3) / .45, 0, 1);
        if (u <= 0) { lx = tp.x; ly = tp.y + 4; } else { lx = tp.x + (LX - tp.x) * u; ly = tp.y + (WY + 2 - tp.y) * u - Math.sin(Math.PI * u) * 34; }
        if (u >= 1 && !st.landedSplash) { st.landedSplash = true; splash(LX, WY, 10); }
        if (t - st.t0 > .75) { st.phase = 'down'; st.lureY = WY + 2; }
        else st.lureY = ly;
      } else if (st.phase === 'down') {
        st.lureY += (WY + 4 + st.target - st.lureY) * Math.min(1, dt * 14);
        lx = LX + Math.sin(t * 2.2) * 2; ly = st.lureY;
        if (Math.random() < dt * 5) st.bubbles.push({ x: lx + (Math.random() - .5) * 4, y: ly - 2, l: 1 });
      } else if (st.phase === 'reel') {
        const dur = st.dur, u = clamp((t - st.t0) / dur, 0, 1);
        if (u < .72) { const v = ease(u / .72); ly = st.startY + (WY + 2 - st.startY) * v; lx = LX + Math.sin(t * 9) * 2 * (1 - v); }
        else { const v = ease((u - .72) / .28); lx = LX + (tp.x + 2 - LX) * v; ly = WY + 2 + (tp.y + 18 - WY - 2) * v - Math.sin(Math.PI * v) * 26; if (!st.breach) { st.breach = true; splash(LX, WY, 14); } }
        st.lureY = ly;
        if (u >= 1) st.phase = 'landed';
      } else if (st.phase === 'landed') { lx = tp.x + 2 + Math.sin(t * 2) * 1; ly = tp.y + 18; }
      if (st.phase !== 'snap' && st.phase !== 'broken') {
        line(tp.x, ty, lx, ly - cy, '#f4f7ff');
        const hooked = st.phase === 'reel' || st.phase === 'landed';
        if (hooked) {
          // le dauphin pend la tête en haut, accroché au leurre, et se débat
          const img = S.dol[st.kind], wig = Math.sin(t * (st.phase === 'landed' ? 6 : 14)) * .25;
          g.save(); g.translate(Math.round(lx), Math.round(ly - cy)); g.rotate(-Math.PI / 2 + wig); g.drawImage(img, -img.width + 3, -img.height / 2); g.restore();
        }
        g.drawImage(S.lure, Math.round(lx) - 5, Math.round(ly - cy) - 3);
      }
      // requin démon
      if (st.phase === 'snap') {
        const u = t - st.t0, biteX = LX + 2, by = st.lureY;
        let sx;
        if (u < .45) sx = W + 50 - (W + 50 - biteX) * ease(u / .45); else sx = biteX - (u - .45) * 120 - Math.max(0, u - 1.2) * 120;
        if (u >= .45 && !st.bitten) { st.bitten = true; st.flash = 1; st.shake = 1; st.jumpUntil = t + .5; splash(biteX, by - cy, 18, '#ffd9d0'); st.snapEnd = { x: LX, y: by, vx: 0, vy: 0 }; }
        // le fil : entier jusqu'à la morsure, puis le bout cassé remonte comme un ressort
        if (!st.bitten) { line(tp.x, ty, LX + Math.sin(t * 2.2) * 2, by - cy, '#f4f7ff'); g.drawImage(S.lure, LX - 5, Math.round(by - cy) - 3); }
        else { const e = st.snapEnd; e.vx += (tp.x - e.x) * 30 * dt - e.vx * 4 * dt; e.vy += (tp.y + 10 - e.y) * 30 * dt - e.vy * 4 * dt; e.x += e.vx * dt; e.y += e.vy * dt; line(tp.x, ty, e.x, e.y - cy, '#f4f7ff'); }
        const img = st.flash > .8 ? S.sharkW : S.shark;
        g.save(); g.translate(Math.round(sx) + 44, Math.round(by - cy - 18)); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); // tourné vers la gauche : la gueule est à sx
        if (st.bitten && sx > -60) g.drawImage(S.lure, Math.round(sx) - 3, Math.round(by - cy) - 3);
        if (u > 3.2) { st.phase = 'broken'; st.brokenEnd = { x: st.snapEnd.x, y: st.snapEnd.y }; }
      } else if (st.phase === 'broken') {
        const e = st.brokenEnd; e.x += (tp.x + 1 - e.x) * Math.min(1, dt * 3); e.y += (tp.y + 8 + Math.sin(t * 1.6) - e.y) * Math.min(1, dt * 3);
        line(tp.x, ty, e.x, e.y - cy, '#f4f7ff');
      }
      // bulles et éclaboussures
      for (const b of st.bubbles) { b.y -= dt * 22; b.x += Math.sin(t * 6 + b.y) * .2; b.l -= dt * .6; if (b.y - cy > 0 && b.y > WY) { g.fillStyle = `rgba(214,241,255,${clamp(b.l, 0, 1)})`; g.fillRect(Math.round(b.x), Math.round(b.y - cy), 1, 1); } }
      st.bubbles = st.bubbles.filter(b => b.l > 0 && b.y > WY);
      for (const p of st.parts) { p.vy += 160 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.l -= dt * 1.4; g.fillStyle = p.c; g.globalAlpha = clamp(p.l, 0, 1); g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); g.globalAlpha = 1; }
      st.parts = st.parts.filter(p => p.l > 0);
      // jauge de profondeur à droite : un cran par multiplicateur rond, le leurre en orange
      if (st.phase === 'down' || st.phase === 'reel' || st.phase === 'snap') {
        px(W - 9, 0, 1, H, 'rgba(255,255,255,.25)');
        for (const m of [1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500]) { const y = WY + 4 + depthOf(m) - cy; if (y > -2 && y < H + 2) px(W - 12, y, m >= 10 ? 7 : 5, 1, m >= 10 ? '#f58fb8' : '#d6f1ff'); }
        px(W - 13, Math.round(st.lureY - cy) - 1, 9, 3, '#ff9a3c');
      }
      g.restore();
      if (st.flash > 0) { g.fillStyle = `rgba(214,58,58,${.4 * st.flash})`; g.fillRect(0, 0, W, H); st.flash = Math.max(0, st.flash - dt * 2.2); }
    }
    let last = 0;
    function loop() {
      st.raf = 0;
      if (!canvas.isConnected) return;
      const t = now(), dt = Math.min(.05, last ? t - last : .016); last = t;
      if (canvas.offsetParent !== null) draw(t, dt);
      st.raf = requestAnimationFrame(loop);
    }
    const wake = () => { if (!st.raf) st.raf = requestAnimationFrame(loop); };
    wake();
    return {
      wake,
      idle() { Object.assign(st, { phase: 'idle', target: 0, bitten: false, breach: false, landedSplash: false }); wake(); },
      cast() { Object.assign(st, { phase: 'cast', t0: now(), target: 0, bitten: false, breach: false, landedSplash: false, flash: 0 }); wake(); },
      resume(m) { Object.assign(st, { phase: 'down', target: depthOf(m || 1), lureY: WY + 4 + depthOf(m || 1), camY: Math.max(0, WY + 4 + depthOf(m || 1) - H * .6) }); wake(); },
      depth(m) { st.target = depthOf(m); if (st.phase === 'idle' || st.phase === 'landed' || st.phase === 'broken') this.resume(m); },
      catch(m) { if (st.phase === 'cast') st.lureY = WY + 2; Object.assign(st, { phase: 'reel', t0: now(), startY: Math.max(WY + 2, st.lureY), kind: kindOf(m), breach: false, dur: Math.min(1.8, .8 + (Math.max(WY + 2, st.lureY) - WY) / 700) }); wake(); },
      snap(p) { st.lureY = WY + 4 + depthOf(p || 1); Object.assign(st, { phase: 'snap', t0: now(), bitten: false }); wake(); },
      kindOf,
    };
  }
  root.RNGFishing = { create, kindOf, depthOf, size: [W, H] };
})(typeof window !== 'undefined' ? window : globalThis);
