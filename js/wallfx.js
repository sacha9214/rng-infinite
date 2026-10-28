/* RNG∞ — fonds d'écran qui ont besoin d'un peu de JavaScript (2026-10-28).
 * Les autres fonds sont en CSS seul (css/style.css, .wp-<id>). Ceux-ci posent leurs propres calques dans #wallpaper :
 *   lastrolls     Your Last Rolls (idée de G8_floppa) : les 10 derniers nombres du joueur flottent, très pâles
 *   fishing       The Fisher (idée de kingston) : un pêcheur sur un ponton, une prise au hasard de temps en temps
 *   condensation  Condensation (idée d'AnnJoe) : de la buée sur une vitre, des gouttes qui coulent en traces claires
 * app.js appelle mount(layer, id, ctx) à chaque pose du fond (sans effet si c'est déjà le bon) et roll(tier, n, rank)
 * à la révélation d'un tirage. Tout est visuel et local : rien ne change le tirage ni n'est envoyé au serveur.
 * Mouvement réduit et mode performance : une image fixe (redessinée au redimensionnement et après un tirage).
 * Les canevas s'arrêtent d'eux-mêmes dès que le fond change (le calque est vidé par app.js) ou que l'onglet est caché
 * (requestAnimationFrame ne tourne plus).
 */
(function (root) {
  'use strict';
  const doc = root.document;
  const still = () => doc.documentElement.classList.contains('perf') || root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dark = () => doc.documentElement.classList.contains('dark');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // in-out
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  // Boucle d'animation d'une scène sur canevas : au plus ~60 images/s (les écrans 120 Hz ne paient pas double), arrêt
  // dès que la scène n'est plus en place. En image fixe, frame() n'est appelé qu'à la demande (draw()).
  function loop(scene) {
    let raf = 0, last = 0, stopped = false;
    const tick = now => {
      if (stopped) return;
      if (!scene.alive()) { api.stop(); return; }
      raf = requestAnimationFrame(tick);
      if (last && now - last < 15) return;
      const dt = last ? Math.min(now - last, 100) / 1000 : 1 / 60;
      last = now;
      scene.frame(now / 1000, dt);
    };
    const api = {
      start() { if (!stopped && !raf) raf = requestAnimationFrame(tick); },
      stop() { stopped = true; cancelAnimationFrame(raf); raf = 0; },
      draw() { if (!stopped && scene.alive()) scene.frame(performance.now() / 1000, 0); },
    };
    // un onglet revenu au premier plan repart sans saut (dt plafonné) ; en image fixe, rien ne tourne
    const onVis = () => { last = 0; };
    doc.addEventListener('visibilitychange', onVis);
    const stop0 = api.stop;
    api.stop = () => { stop0(); doc.removeEventListener('visibilitychange', onVis); };
    return api;
  }

  // Un canevas plein écran (ou une zone) à une densité de pixels plafonnée : assez net, jamais ruineux sur un téléphone.
  function canvas(layer, cls, maxDpr) {
    const c = doc.createElement('canvas');
    c.className = cls;
    layer.appendChild(c);
    const fit = scale => {
      const dpr = Math.min(root.devicePixelRatio || 1, maxDpr) * (scale || 1);
      const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
      return false;
    };
    return { c, g: c.getContext('2d'), fit };
  }

  const SCENES = {};

  /* ---------------------------------------------------------------------------------------------------------------
   * 🔢 Your Last Rolls (idée de G8_floppa, 2026-10-28) : les 10 derniers nombres tirés flottent doucement sur tout le
   * fond, très pâles (ils ne doivent jamais concurrencer le vrai nombre). Des nombres au hasard complètent tant qu'il n'y
   * en a pas 10 (invité, nouveau joueur). À la révélation, le plus ancien s'efface et le nouveau part de la carte du
   * tirage pour rejoindre l'essaim. Tout en CSS (transform / opacity) : ici, on ne fait que poser le texte et les places.
   * <i> = la place (et le trajet d'arrivée), <b> = la dérive lente, en boucle.
   */
  SCENES.lastrolls = (layer, ctx) => {
    const N = 10;
    const fmt6 = n => String(Math.max(0, Math.floor(n))).padStart(6, '0');
    const randomNum = () => Math.floor(Math.random() * 1000000);
    const mine = (ctx && ctx.rolls ? ctx.rolls() : []).slice(-N);
    const nums = Array.from({ length: N - mine.length }, randomNum).concat(mine);
    const box = doc.createElement('div');
    box.className = 'wlr-box';
    layer.appendChild(box);
    // Places : une grille tramée (2 colonnes en portrait, 4 en paysage) avec un peu de hasard dans chaque case, pour que
    // les nombres couvrent tout l'écran sans se chevaucher.
    const cells = () => {
      const portrait = innerHeight > innerWidth * 1.1, cols = portrait ? 2 : 4, rows = Math.ceil(12 / cols) + (portrait ? -1 : 0);
      const all = [];
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) all.push({ x: (k + .5 + (r % 2 ? .18 : -.18)) / cols * 100, y: (r + .5) / rows * 100 });
      return all.sort(() => Math.random() - .5).slice(0, N);
    };
    const place = (el, cell) => {
      const depth = Math.random(); // 0 = loin (petit, pâle), 1 = près
      const x = cell.x + rnd(-6, 6), y = cell.y + rnd(-4, 4);
      // en haut au milieu (la carte du tirage, les ??????, le titre) : encore plus pâle, pour ne rien disputer au vrai nombre
      const k = x > 22 && x < 78 && y < 40 ? .4 : 1;
      el.style.cssText = `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;--z:${(.62 + depth * .6).toFixed(2)};--a:${((.55 + depth * .45) * k).toFixed(2)}`;
      const b = el.firstChild;
      b.style.cssText = `--dx:${rnd(-5, 5).toFixed(1)}vmin;--dy:${rnd(-4, 4).toFixed(1)}vmin;--r:${rnd(-4, 4).toFixed(1)}deg;--d:${rnd(38, 64).toFixed(1)}s;animation-delay:${rnd(-60, 0).toFixed(1)}s`;
    };
    const free = cells();
    const els = nums.map((n, i) => {
      const el = doc.createElement('i'), b = doc.createElement('b');
      el.className = 'wlr-n' + (i === N - 1 && mine.length ? ' new' : '');
      b.textContent = fmt6(n);
      el.appendChild(b);
      place(el, free[i]);
      el._cell = free[i];
      box.appendChild(el);
      return el;
    });
    return {
      alive: () => box.isConnected,
      stop() { box.remove(); },
      roll(tier, n) {
        if (!Number.isFinite(n)) return;
        const old = els.shift();
        els.forEach(e => e.classList.remove('new'));
        // le plus ancien s'efface, puis revient comme le nouveau nombre (même élément : il y en a toujours 10)
        old.classList.add('out');
        setTimeout(() => {
          if (!box.isConnected) return;
          old.classList.remove('out', 'join', 'new');
          old.firstChild.textContent = fmt6(n);
          place(old, old._cell);
          // départ : là où est la carte du tirage (le centre haut de l'écran si elle n'est pas là)
          const card = doc.getElementById('num-card'), r = card && card.getBoundingClientRect();
          const from = r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight * .25 };
          const at = old.getBoundingClientRect();
          old.style.setProperty('--fx', `${Math.round(from.x - (at.left + at.width / 2))}px`);
          old.style.setProperty('--fy', `${Math.round(from.y - (at.top + at.height / 2))}px`);
          void old.offsetWidth;
          old.classList.add('join', 'new');
          els.push(old);
        }, still() ? 0 : 900);
      },
    };
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 💧 Condensation (idée d'AnnJoe, 2026-10-28) : de la buée sur une vitre froide, devant une ville floue la nuit (ou
   * un jour de pluie en thème clair, décor en CSS). Trois canevas :
   *   la buée     basse définition (1 pixel pour 6 px d'écran : elle est floue de toute façon), blanche ; sa force est
   *               l'opacité du canevas (CSS, selon le thème). Une goutte qui coule l'efface ; elle revient doucement.
   *   les perles  la micro-buée (des milliers de minuscules gouttes), dessinée une fois, gommée là où l'eau passe et
   *               reposée peu à peu sur les traces anciennes.
   *   les gouttes redessinées à chaque image : elles apparaissent, grossissent, et au-delà d'une taille coulent en
   *               zigzag avec de petits arrêts, avalent celles qu'elles touchent et laissent une trace claire.
   * Un bon tirage essuie la vitre : Epic / Anomaly un arc, Mythic / Celestial un aller-retour, Divine et mieux un « ∞ »
   * tracé au doigt en plus. En dessous, quelques gouttes se mettent juste à couler.
   */
  SCENES.condensation = layer => {
    const FS = 1 / 6;
    const fog = canvas(layer, 'wcd-fog', 1), beads = canvas(layer, 'wcd-beads', 1.5), drops = canvas(layer, 'wcd-drops', 1.5);
    const fg = fog.g, bg = beads.g, dg = drops.g;
    const mk = n => { const c = doc.createElement('canvas'); c.width = c.height = n; return c; };
    // une goutte : une petite lentille (bord bas sombre, centre clair), un reflet en haut à gauche, un éclat en bas
    const drop = mk(64);
    { const g = drop.getContext('2d'), gr = g.createRadialGradient(30, 26, 3, 32, 32, 31);
      gr.addColorStop(0, 'rgba(255,255,255,.12)'); gr.addColorStop(.68, 'rgba(10,20,40,.16)'); gr.addColorStop(.9, 'rgba(4,8,22,.55)'); gr.addColorStop(1, 'rgba(4,8,22,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 31, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.ellipse(23, 21, 7.5, 4.5, -.6, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,.38)'; g.beginPath(); g.ellipse(35, 51, 11, 3.2, 0, 0, 7); g.fill(); }
    // la gomme : un disque au bord doux
    const brush = mk(64);
    { const g = brush.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(.6, 'rgba(0,0,0,.9)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    let W = 0, H = 0, dpr = 1, list = [], trail = [], wipes = [], refogT = 0, alive = true;
    const eraseFog = (x, y, r) => { fg.globalCompositeOperation = 'destination-out'; fg.drawImage(brush, (x - r) * FS, (y - r) * FS, 2 * r * FS, 2 * r * FS); };
    const eraseBeads = (x, y, r) => { bg.globalCompositeOperation = 'destination-out'; bg.drawImage(brush, (x - r) * dpr, (y - r) * dpr, 2 * r * dpr, 2 * r * dpr); };
    const bead = (x, y, r) => { bg.globalCompositeOperation = 'source-over'; bg.drawImage(drop, (x - r) * dpr, (y - r) * dpr, 2 * r * dpr, 2 * r * dpr); };
    const spawn = (x, y, r) => { list.push({ x, y, r, run: false, vy: 0, dx: 0, stop: 0, moved: 0, grow: rnd(.02, .14), at: rnd(4.8, 7) }); };
    function reset() {
      W = innerWidth; H = innerHeight; dpr = Math.min(root.devicePixelRatio || 1, 1.5);
      fog.fit(FS); beads.fit(); drops.fit();
      fg.setTransform(1, 0, 0, 1, 0, 0); bg.setTransform(1, 0, 0, 1, 0, 0);
      fg.globalCompositeOperation = 'source-over'; fg.fillStyle = '#fff'; fg.fillRect(0, 0, fog.c.width, fog.c.height);
      bg.globalCompositeOperation = 'source-over'; bg.clearRect(0, 0, beads.c.width, beads.c.height);
      for (let i = 0, n = Math.min(7000, W * H / 240); i < n; i++) bead(Math.random() * W, Math.random() * H, rnd(.5, 1.7));
      list = []; trail = []; wipes = [];
      for (let i = 0, n = W * H / 14000; i < n; i++) spawn(Math.random() * W, Math.random() * H, Math.random() < .08 ? rnd(4, 5) : rnd(1.2, 3.4));
      // quelques secondes de vitre déjà vécues : des traces, des gouttes de toutes les tailles
      for (let i = 0; i < 360; i++) step(1 / 30, true);
    }
    const maxDrops = () => Math.round(W * H / 7000);
    function step(dt, warm) {
      // nouvelles gouttes, qui grossissent avec la buée
      if (list.length < maxDrops() && Math.random() < dt * W * H / 90000) spawn(Math.random() * W, Math.random() * H * .95, Math.random() < .1 ? rnd(3.5, 4.6) : rnd(1, 2.4));
      for (const d of list) {
        if (!d.run) {
          d.r += d.grow * dt;
          if (d.r > d.at) { d.run = true; d.vy = 0; }
          continue;
        }
        if (d.stop > 0) { d.stop -= dt; continue; }
        if (Math.random() < dt * .7) { d.stop = rnd(.15, .7); continue; } // elle accroche la vitre un instant
        const target = 20 + d.r * 13;
        d.vy += (target - d.vy) * Math.min(1, dt * 3);
        // elle zigzague : une dérive qui change lentement, et de petits écarts brusques (la vitre n'est pas lisse)
        d.dx = clamp(d.dx + (Math.random() - .5) * 220 * dt, -32, 32);
        if (Math.random() < dt * 1.5) d.dx = rnd(-40, 40);
        const dy = d.vy * dt;
        d.y += dy; d.x += d.dx * dt;
        d.moved += dy;
        while (d.moved > 3) {
          d.moved -= 3;
          eraseFog(d.x, d.y - d.r * .3, d.r * rnd(1, 1.3));
          eraseBeads(d.x, d.y - d.r * .3, d.r * 1.05);
          d.r -= .02;
          if (Math.random() < .12) { const rr = d.r * rnd(.2, .4); bead(d.x + rnd(-d.r, d.r) * .5, d.y - d.r * 2, rr); }
          trail.push(d.x, d.y, 0);
        }
        if (d.r < 2.3) { d.run = false; d.at = 99; } // trop petite : elle reste collée
      }
      // une goutte qui coule avale celles qu'elle touche
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a.run || a.dead) continue;
        for (let j = 0; j < list.length; j++) {
          const b = list[j];
          if (i === j || b.dead) continue;
          const dx = a.x - b.x, dy = a.y - b.y, rr = a.r + b.r * .8;
          if (dx * dx + dy * dy < rr * rr) { a.r = Math.min(11, Math.sqrt(a.r * a.r + b.r * b.r)); b.dead = true; }
        }
      }
      list = list.filter(d => !d.dead && d.y - d.r < H + 4);
      // la buée revient, et la micro-buée se repose sur les vieilles traces
      refogT += dt;
      if (refogT > .12) { refogT = 0; fg.globalCompositeOperation = 'source-over'; fg.fillStyle = 'rgba(255,255,255,.022)'; fg.fillRect(0, 0, fog.c.width, fog.c.height); }
      for (let k = 2; k < trail.length; k += 3) trail[k] += dt;
      let drop0 = 0;
      for (let k = 0; k < trail.length; k += 3) {
        if (trail[k + 2] > 3 && Math.random() < dt * 1.2) bead(trail[k] + rnd(-6, 6), trail[k + 1] + rnd(-6, 6), rnd(.5, 1.3));
        if (trail[k + 2] > 16) drop0 = k + 3;
      }
      if (drop0) trail.splice(0, drop0);
      if (trail.length > 9000) trail.splice(0, trail.length - 9000);
      // les coups de chiffon / de doigt en cours
      for (const w of wipes) wipeStep(w, warm ? 99 : dt);
      wipes = wipes.filter(w => w.p < 1);
    }
    function draw() {
      dg.setTransform(dpr, 0, 0, dpr, 0, 0);
      dg.clearRect(0, 0, W, H);
      for (const d of list) {
        const s = d.run && d.stop <= 0 ? Math.min(.7, d.vy / 220) : 0;
        dg.drawImage(drop, d.x - d.r, d.y - d.r * (1 + 2 * s), 2 * d.r, 2 * d.r * (1 + s));
      }
    }
    // un essuyage : une suite de points (x, y) parcourue en dur secondes avec une gomme de rayon br
    function wipeStep(w, dt) {
      if (w.delay > 0) { w.delay -= dt; return; }
      const p0 = w.p;
      w.p = Math.min(1, w.p + dt / w.dur);
      const e0 = ease(p0), e1 = ease(w.p), n = Math.max(1, Math.ceil((e1 - e0) * w.len / (w.br * .35)));
      for (let i = 1; i <= n; i++) {
        const q = w.path(e0 + (e1 - e0) * i / n);
        eraseFog(q.x, q.y, w.br); eraseFog(q.x, q.y, w.br);
        eraseBeads(q.x, q.y, w.br * .92);
        for (const d of list) if (Math.hypot(d.x - q.x, d.y - q.y) < w.br * .85) d.dead = true;
      }
      list = list.filter(d => !d.dead);
      // le bord d'un coup de chiffon laisse un bourrelet de gouttes, dont certaines coulent aussitôt
      if (w.p >= 1 && w.edge) for (let t = 0; t <= 1; t += 22 / w.len) {
        const q = w.path(t), o = w.path(Math.min(1, t + .01)), nx = -(o.y - q.y), ny = o.x - q.x, nl = Math.hypot(nx, ny) || 1;
        for (const side of [-1, 1]) if (Math.random() < .7) {
          const k = side * w.br * rnd(.85, 1);
          spawn(q.x + nx / nl * k, q.y + ny / nl * k, Math.random() < .2 ? rnd(4.5, 6.5) : rnd(1.4, 3.2));
        }
      }
    }
    const arc = (cx, cy, R, a0, a1) => t => { const a = a0 + (a1 - a0) * t; return { x: cx + Math.sin(a) * R, y: cy - Math.cos(a) * R }; };
    function wipe(rank) {
      const br = clamp(Math.min(W, H) * .085, 28, 84), R = H * .95, cx = W / 2, cy = H * 1.32;
      const span = Math.min(1.1, Math.asin(Math.min(1, (W / 2 + br) / R)) + .05);
      wipes.push({ p: 0, delay: .15, dur: .75, br, len: R * span * 2, edge: true, path: arc(cx, cy, R, -span, span) });
      if (rank >= 6) wipes.push({ p: 0, delay: .95, dur: .7, br: br * 1.1, len: R * span * 2, edge: true, path: arc(cx, cy + br * 1.7, R, span, -span) });
      if (rank >= 8) {
        // le ∞ au doigt (une lemniscate) : sur grand écran dans la marge de droite (le milieu est caché par la page),
        // sur téléphone au milieu, au-dessus des arcs
        const wide = W > 1000, a = wide ? Math.min((W - 760) / 4.4, H * .16) : Math.min(W * .3, H * .2), ox = wide ? W - a * 1.45 - 24 : W / 2, oy = H * (wide ? .3 : .4);
        const inf = t => { const u = t * Math.PI * 2 + Math.PI / 2, s = Math.sin(u), k = 1 + s * s; return { x: ox + a * Math.cos(u) / k, y: oy + a * .9 * s * Math.cos(u) / k }; };
        wipes.push({ p: 0, delay: 1.9, dur: 1.7, br: br * .3, len: a * 6.2, edge: false, path: inf });
      }
    }
    function nudge(k) { // quelques grosses gouttes se mettent à couler
      list.filter(d => !d.run && d.r > 2.6).sort(() => Math.random() - .5).slice(0, k).forEach(d => { d.r = Math.max(d.r, 4.8); d.run = true; d.stop = 0; });
    }
    const lp = loop({ alive: () => alive && fog.c.isConnected, frame(t, dt) { if (dt) step(dt); draw(); } });
    let rt = 0;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { reset(); lp.draw(); }, 250); };
    addEventListener('resize', onResize);
    reset();
    if (still()) lp.draw(); else lp.start();
    let stillT = 0;
    return {
      alive: () => alive && fog.c.isConnected,
      stop() { alive = false; lp.stop(); removeEventListener('resize', onResize); [fog, beads, drops].forEach(x => x.c.remove()); },
      roll(tier, n, rank) {
        if (doc.hidden) return;
        if (rank >= 4) wipe(rank); else nudge(rank >= 2 ? 3 : 1);
        if (still()) {
          // image fixe : l'essuyage d'un coup, et la buée revient d'un coup 12 s plus tard
          for (const w of wipes) while (w.p < 1) wipeStep(w, 99);
          wipes = [];
          lp.draw();
          clearTimeout(stillT);
          stillT = setTimeout(() => { for (let i = 0; i < 200; i++) step(1 / 10, true); lp.draw(); }, 12000);
        }
      },
    };
  };

  let cur = null;
  // Pose (ou garde) la scène du fond id dans layer. Sans scène pour cet id : arrête l'ancienne.
  function mount(layer, id, ctx) {
    if (cur && cur.layer === layer && cur.id === id && cur.s.alive()) return;
    if (cur) { try { cur.s.stop(); } catch (e) { /* déjà parti */ } cur = null; }
    if (!layer || !SCENES[id]) return;
    try { cur = { layer, id, s: SCENES[id](layer, ctx || {}) }; } catch (e) { cur = null; }
  }
  // Révélation d'un tirage : tier (« mythic »…), n le nombre, rank sa place (TIER_RANK d'app.js, 4 = epic, 6 = mythic).
  function roll(tier, n, rank) {
    if (cur && cur.s.alive() && cur.s.roll) { try { cur.s.roll(tier, n, rank); } catch (e) { /* jamais bloquant */ } }
  }
  root.RNGWallFX = { mount, roll, has: id => !!SCENES[id], _scenes: SCENES, _util: { loop, canvas, still, dark, rnd, pick, clamp, ease, easeOut } };
})(window);
