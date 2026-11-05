/* RNG∞ — fonds d'écran qui ont besoin d'un peu de JavaScript (2026-10-28).
 * Les autres fonds sont en CSS seul (css/style.css, .wp-<id>). Ceux-ci posent leurs propres calques dans #wallpaper :
 *   lastrolls     Your Last Rolls (idée de G8_floppa) : les 10 derniers nombres du joueur flottent, très pâles
 *   fishing       The Fisher (idée de kingston) : un pêcheur sur un ponton, une prise au hasard de temps en temps
 *   condensation  Condensation (idée d'AnnJoe) : de la buée sur une vitre, des gouttes qui coulent en traces claires
 * Six fonds de joueurs (2026-11-01), sur le même échafaudage (stage) : farm (HSI), keyboard (kingston), thunderstorm
 *   et solarsystem (finnnnn), meteorshower (Ggggssnoop), party (jia jun).
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
    const fog = canvas(layer, 'wcd-fog', 1), beads = canvas(layer, 'wcd-beads', 1), drops = canvas(layer, 'wcd-drops', 1.5);
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
    // la buée aussi part en lot (toutes les 3 images) : c'est le canevas le plus cher à réafficher (agrandi 6 fois)
    let fq = [], refog = 0;
    const eraseFog = (x, y, r) => fq.push(x, y, r);
    const flushFog = () => {
      if (refog) { fg.globalCompositeOperation = 'source-over'; fg.fillStyle = `rgba(255,255,255,${Math.min(1, .022 * refog)})`; fg.fillRect(0, 0, fog.c.width, fog.c.height); refog = 0; }
      fg.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < fq.length; i += 3) { const x = fq[i], y = fq[i + 1], r = fq[i + 2]; fg.drawImage(brush, (x - r) * FS, (y - r) * FS, 2 * r * FS, 2 * r * FS); }
      fq = [];
    };
    // la micro-buée change peu : ses retouches attendent et partent en lot ~8 fois par seconde (un canevas plein écran
    // modifié à chaque image coûtait cher à afficher), et elle se contente d'une densité 1
    let bq = [], bqN = 0, bd = 1;
    const eraseBeads = (x, y, r) => bq.push(0, x, y, r);
    const bead = (x, y, r) => bq.push(1, x, y, r);
    const flushBeads = () => {
      for (let i = 0; i < bq.length; i += 4) {
        const x = bq[i + 1], y = bq[i + 2], r = bq[i + 3];
        bg.globalCompositeOperation = bq[i] ? 'source-over' : 'destination-out';
        bg.drawImage(bq[i] ? drop : brush, (x - r) * bd, (y - r) * bd, 2 * r * bd, 2 * r * bd);
      }
      bq = [];
    };
    const spawn = (x, y, r) => { list.push({ x, y, r, run: false, vy: 0, dx: 0, stop: 0, moved: 0, grow: rnd(.02, .14), at: rnd(4.8, 7) }); };
    function reset() {
      W = innerWidth; H = innerHeight; dpr = Math.min(root.devicePixelRatio || 1, 1.5); bd = Math.min(root.devicePixelRatio || 1, 1);
      fog.fit(FS); beads.fit(); drops.fit(); bq = []; fq = []; refog = 0;
      fg.setTransform(1, 0, 0, 1, 0, 0); bg.setTransform(1, 0, 0, 1, 0, 0);
      fg.globalCompositeOperation = 'source-over'; fg.fillStyle = '#fff'; fg.fillRect(0, 0, fog.c.width, fog.c.height);
      bg.globalCompositeOperation = 'source-over'; bg.clearRect(0, 0, beads.c.width, beads.c.height);
      for (let i = 0, n = Math.min(7000, W * H / 240); i < n; i++) bead(Math.random() * W, Math.random() * H, rnd(.5, 1.7));
      list = []; trail = []; wipes = [];
      for (let i = 0, n = W * H / 14000; i < n; i++) spawn(Math.random() * W, Math.random() * H, Math.random() < .08 ? rnd(4, 5) : rnd(1.2, 3.4));
      // quelques secondes de vitre déjà vécues : des traces, des gouttes de toutes les tailles
      for (let i = 0; i < 360; i++) step(1 / 30, true);
      flushBeads(); flushFog();
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
      if (refogT > .12) { refogT = 0; refog++; }
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
      if (++bqN % 8 === 0 || still()) flushBeads();
      if (bqN % 3 === 0 || still()) flushFog();
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
      stop() { alive = false; lp.stop(); clearTimeout(stillT); clearTimeout(rt); removeEventListener('resize', onResize); [fog, beads, drops].forEach(x => x.c.remove()); },
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

  /* ---------------------------------------------------------------------------------------------------------------
   * 🎣 The Fisher (idée de kingston, 2026-10-28) : un petit pêcheur (barbe blanche, ciré jaune, bob vert) assis au bout
   * d'un ponton, au crépuscule (thème sombre, avec une lanterne) ou par un après-midi doré (thème clair). Le ciel, l'eau
   * et la rive d'en face sont en CSS ; le ponton, le pêcheur, la canne, le fil, le bouchon et les prises sont dessinés
   * ici, sur un canevas qui ne couvre que le bas de l'écran.
   * Un cycle : le bouchon frétille (deux touches), plonge, le pêcheur ferre, la prise jaillit en arc avec des
   * éclaboussures, pend au fil en se balançant, puis va au seau (ou retourne à l'eau : la botte, la baleine, le canard
   * qui s'en va en flottant), et il relance : la canne recule, fouette, le bouchon vole et retombe avec un rond.
   * Prises : poisson argenté, perche, botte, poisson-globe, canard en plastique, poisson doré (rare), petite baleine
   * (très rare). Un tirage Epic+ fait mordre tout de suite avec plus de chances de rare ; Mythic / Celestial donnent un
   * poisson doré, Divine et mieux la petite baleine. Purement visuel, rien n'est compté ni envoyé.
   */
  SCENES.fishing = layer => {
    const cv = canvas(layer, 'wfi-c', 1.25), g = cv.g;
    const CATCH = [['minnow', 33], ['perch', 25], ['boot', 12], ['puffer', 11], ['duck', 8], ['golden', 7], ['whale', 4]];
    const SIZE = { minnow: .68, perch: .78, boot: .66, puffer: .62, duck: .6, golden: .82, whale: 1.3 };
    const KEEP = { minnow: 1, perch: 1, puffer: 1, golden: 1 }; // au seau ; les autres retournent à l'eau
    const BASE = { coat: '#f4c430', coatD: '#b98a12', skin: '#f1c27d', skinD: '#d39a5c', beard: '#eef0f3', hat: '#2f6b46', hatD: '#1f4a30', boot: '#2e4a3a', pants: '#3b5b8c', pantsD: '#2c4670',
      wood: '#8a5a33', woodD: '#5e3b1f', woodL: '#b07d4f', rod: '#5a3a22', bucket: '#8b98a5', bucketD: '#5b6670', lamp: '#3a2a1a', ink: '#1d1b2c' };
    // crépuscule : tout est mêlé de bleu nuit (la lanterne, elle, reste vive)
    const mix = (hex, to, k) => { const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16); const c = s => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k); return `rgb(${c(16)},${c(8)},${c(0)})`; };
    let pal = {}, isDark = null;
    const palette = () => { isDark = dark(); for (const k in BASE) pal[k] = isDark ? mix(BASE[k], '#16233d', k === 'skin' || k === 'coat' || k === 'beard' ? .32 : .45) : BASE[k]; };
    let W, H, S, hz, yd, xe, xm, top, dpr, bob0, alive = true;
    function geo() {
      W = innerWidth; H = innerHeight;
      const portrait = H >= W;
      hz = H * (portrait ? .55 : .5);
      S = clamp(Math.min(W, H) / 8.5, 44, 104);
      yd = H * (portrait ? .87 : .81);
      xe = portrait ? W * .4 : clamp(W * .28, S * 3.4, W * .4);
      xm = xe - .5 * S;
      top = Math.max(0, Math.floor(yd - 3.6 * S));
      cv.c.style.top = top + 'px'; cv.c.style.height = (H - top) + 'px';
      cv.fit();
      dpr = cv.c.width / Math.max(1, cv.c.clientWidth);
      bob0 = { x: xe + (W - xe) * (portrait ? .5 : .4), y: hz + (yd - hz) * .45 };
    }
    // état du cycle
    let T = 0, st = 'idle', t0 = 0, nextBite = rnd(4, 9), kind = 'minnow', boost = 0, hurry = false;
    let bob = { x: 0, y: 0, on: true }, cast = null, toss = null, bucketHop = -9;
    const ripples = [], drops = [], sparks = [], floaters = [];
    let theta = -.8, bend = 0;
    const hands = () => ({ x: xm + .4 * S, y: yd - .52 * S });
    const tipOf = () => { const h = hands(), L = 2.35 * S; return { x: h.x + Math.cos(theta) * L, y: h.y + Math.sin(theta) * L + bend * .6 }; };
    const ring = (x, y, big) => ripples.push({ x, y, t: 0, m: (big ? 1.6 : 1) * S * .55 });
    const splash = (x, y, n, pow) => { for (let i = 0; i < n; i++) drops.push({ x, y, vx: rnd(-1, 1) * S * 1.6 * pow, vy: -rnd(.8, 1.9) * S * 2.2 * pow, t: 0 }); };
    const choose = () => {
      if (boost >= 8) return 'whale';
      if (boost >= 6) return 'golden';
      const w = CATCH.map(([k, p]) => [k, boost >= 4 && (k === 'golden' || k === 'whale') ? p * 3 : p]);
      let u = Math.random() * w.reduce((a, x) => a + x[1], 0);
      for (const [k, p] of w) { if ((u -= p) < 0) return k; }
      return 'minnow';
    };
    const go = s => { st = s; t0 = T; };
    function update(dt) {
      T += dt;
      const p = T - t0;
      const th0 = -.8 + Math.sin(T * .7) * .025;
      if (st === 'idle') {
        theta += (th0 - theta) * Math.min(1, dt * 4); bend *= .9;
        bob.y = bob0.y + Math.sin(T * 2.1) * 1.2;
        if (Math.random() < dt * .25) ring(bob.x, bob.y);
        if (T >= nextBite) { hurry = boost >= 4; kind = choose(); boost = 0; go('nibble'); }
      } else if (st === 'nibble') { // deux touches : le bouchon s'enfonce un peu, deux fois
        const d = Math.max(0, Math.sin(clamp((p - .2) / .35, 0, 1) * Math.PI)) * 3 + Math.max(0, Math.sin(clamp((p - .85) / .35, 0, 1) * Math.PI)) * 5;
        bob.y = bob0.y + d;
        if (Math.abs(p - .3) < dt || Math.abs(p - .97) < dt) ring(bob.x, bob.y);
        if (p > (hurry ? .95 : 1.45)) { go('bite'); ring(bob.x, bob.y, true); }
      } else if (st === 'bite') { // il plonge : la canne plie (l'anticipation du ferrage)
        const q = clamp(p / .3, 0, 1);
        bob.y = bob0.y + easeOut(q) * 10; bob.on = q < .8;
        theta = th0 + .14 * easeOut(q); bend = .22 * S * q;
        if (p > .3) { go('hook'); splash(bob.x, bob.y, kind === 'whale' ? 18 : 10, kind === 'whale' ? 1.3 : 1); ring(bob.x, bob.y, true); }
      } else if (st === 'hook') { // il ferre d'un coup sec
        const q = clamp(p / .28, 0, 1);
        theta = th0 + .14 - .44 * easeOut(q); bend = .22 * S * (1 - q) + .1 * S * q;
        if (p > .28) go('fly');
      } else if (st === 'fly') {
        theta = th0 - .3 + Math.sin(p * 9) * .02; bend = (kind === 'whale' ? .45 : .15) * S;
        if (p > .9) go('show');
      } else if (st === 'show') { // la prise pend et se balance ; la canne plie sous le poids
        const wgt = kind === 'whale' ? .5 : kind === 'boot' ? .26 : .16;
        theta = th0 - .3 + (kind === 'whale' ? .18 : 0); bend = wgt * S * (1 + Math.sin(p * 5) * .15 * Math.exp(-p));
        if (kind === 'golden' && Math.random() < dt * 10) { const c = catchPos(); sparks.push({ x: c.x + rnd(-.4, .4) * S, y: c.y + rnd(-.4, .4) * S, t: 0 }); }
        if (p > 2.3) {
          const c = catchPos();
          toss = KEEP[kind] ? { from: c, to: { x: xm - .85 * S, y: yd - .3 * S }, keep: true } : { from: c, to: { x: xe + rnd(.9, 1.6) * S, y: hz + (yd - hz) * rnd(.62, .8) }, keep: false };
          go('stash');
        }
      } else if (st === 'stash') {
        const q = clamp(p / .7, 0, 1);
        theta = th0 - .3 - (toss.keep ? .35 : -.1) * Math.sin(q * Math.PI); bend *= .92;
        if (q >= 1) {
          if (toss.keep) bucketHop = T;
          else { splash(toss.to.x, toss.to.y, kind === 'whale' ? 16 : 8, kind === 'whale' ? 1.2 : .8); ring(toss.to.x, toss.to.y, true); if (kind === 'duck') floaters.push({ x: toss.to.x, y: toss.to.y, t: 0 }); }
          toss = null; go('cast');
        }
      } else if (st === 'cast') { // relance : la canne recule, fouette, le bouchon vole et retombe
        if (p < .45) { theta = th0 - .3 - .63 * ease(p / .45); bend = -.05 * S; }
        else if (p < .62) { theta = th0 - .93 + 1.18 * easeOut((p - .45) / .17); bend = .2 * S; }
        else { theta += (th0 - theta) * Math.min(1, dt * 5); bend *= .9; }
        if (!cast && p >= .55) { const tp = tipOf(); cast = { from: tp, to: { x: bob0.x + rnd(-.12, .12) * (W - xe), y: bob0.y }, t: 0 }; bob.on = true; }
        if (cast) {
          cast.t += dt / .8;
          const q = Math.min(1, cast.t);
          bob.x = cast.from.x + (cast.to.x - cast.from.x) * q;
          bob.y = cast.from.y + (cast.to.y - cast.from.y) * q - Math.sin(q * Math.PI) * 1.1 * S;
          if (q >= 1) { bob.x = cast.to.x; bob0.x = cast.to.x; bob.y = bob0.y; ring(bob.x, bob.y, true); splash(bob.x, bob.y, 5, .5); cast = null; nextBite = T + (boost ? 1 : rnd(7, 15)); go('idle'); }
        }
      }
      for (const r of ripples) r.t += dt;
      while (ripples.length && ripples[0].t > 2.2) ripples.shift();
      for (const d of drops) { d.t += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.vy += S * 9 * dt; }
      for (let i = drops.length - 1; i >= 0; i--) if (drops[i].t > 1.4 || drops[i].y > yd + S) drops.splice(i, 1);
      for (const s of sparks) s.t += dt;
      while (sparks.length && sparks[0].t > .8) sparks.shift();
      for (const f of floaters) { f.t += dt; f.x += S * .12 * dt; }
      while (floaters.length && floaters[0].t > 24) floaters.shift();
    }
    // où est la prise (le bout du fil), selon l'étape
    function catchPos() {
      const tp = tipOf(), hang = .75 * S;
      if (st === 'fly') {
        const q = easeOut(clamp((T - t0) / .9, 0, 1)), a = { x: bob.x, y: bob0.y }, b = { x: tp.x, y: tp.y + hang }, c = { x: (a.x + b.x) / 2 + .3 * S, y: Math.min(a.y, b.y) - .6 * S };
        return { x: (1 - q) * (1 - q) * a.x + 2 * (1 - q) * q * c.x + q * q * b.x, y: (1 - q) * (1 - q) * a.y + 2 * (1 - q) * q * c.y + q * q * b.y, a: (1 - q) * -1.2 };
      }
      if (st === 'show') { const p = T - t0, sw = .45 * Math.exp(-p * 1.1) * Math.sin(p * 5.5); return { x: tp.x + Math.sin(sw) * hang, y: tp.y + Math.cos(sw) * hang, a: sw }; }
      if (st === 'stash' && toss) {
        const q = ease(clamp((T - t0) / .7, 0, 1)), f = toss.from, to = toss.to;
        return { x: f.x + (to.x - f.x) * q, y: f.y + (to.y - f.y) * q - Math.sin(q * Math.PI) * .9 * S, a: q * (toss.keep ? -2 : 3), s: toss.keep ? 1 - q * .5 : 1 };
      }
      return null;
    }
    // ---- dessin
    const E = (x, y, rx, ry, r) => { g.beginPath(); g.ellipse(x, y, Math.max(.1, rx), Math.max(.1, ry), r || 0, 0, Math.PI * 2); };
    const fill = c => { g.fillStyle = c; g.fill(); };
    const line = (pts, w, c) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.lineWidth = w; g.strokeStyle = c; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(); };
    const shade = (c, k) => isDark ? mix(c, '#16233d', k == null ? .35 : k) : c;
    function drawCatch(k, x, y, a, sc) {
      const s = SIZE[k] * S * (sc || 1);
      g.save(); g.translate(x, y); g.rotate(a);
      g.lineWidth = Math.max(1, s * .035); g.strokeStyle = pal.ink;
      if (k === 'minnow' || k === 'golden' || k === 'perch') {
        const gold = k === 'golden', perch = k === 'perch', body = gold ? '#f6c33b' : perch ? '#b7c94b' : '#9cc3e6', back = gold ? '#d99a12' : perch ? '#6f8a2a' : '#4f7fae';
        g.beginPath(); g.moveTo(-s * .3, 0); g.lineTo(-s * .58, -s * .2); g.quadraticCurveTo(-s * .5, 0, -s * .58, s * .2); g.closePath(); g.fillStyle = shade(gold ? '#fbbf24' : perch ? '#f07c3a' : back); g.fill(); g.stroke();
        if (perch) { g.beginPath(); g.moveTo(-s * .12, -s * .14); g.lineTo(-s * .02, -s * .3); g.lineTo(s * .06, -s * .17); g.lineTo(s * .12, -s * .27); g.lineTo(s * .18, -s * .13); g.closePath(); g.fillStyle = shade('#f07c3a'); g.fill(); g.stroke(); }
        E(0, 0, s * .4, s * (perch ? .19 : .16)); g.fillStyle = shade(body); g.fill(); g.stroke();
        E(-s * .02, -s * .06, s * .3, s * .05); fill(shade(back));
        if (perch) for (const bx of [-.16, -.02, .12]) { g.beginPath(); g.moveTo(s * bx, -s * .15); g.lineTo(s * (bx - .03), s * .14); g.lineWidth = s * .05; g.strokeStyle = shade('#4b5a1e'); g.stroke(); }
        if (gold) { E(s * .02, -s * .02, s * .2, s * .04, -.1); fill('rgba(255,255,255,.7)'); }
        E(s * .25, -s * .03, s * .05, s * .05); fill('#fff'); E(s * .265, -s * .03, s * .025, s * .025); fill(pal.ink);
      } else if (k === 'puffer') {
        g.fillStyle = shade('#e3b23c');
        for (let i = 0; i < 12; i++) { const u = i / 12 * Math.PI * 2; g.beginPath(); g.moveTo(Math.cos(u - .18) * s * .3, Math.sin(u - .18) * s * .3); g.lineTo(Math.cos(u) * s * .44, Math.sin(u) * s * .44); g.lineTo(Math.cos(u + .18) * s * .3, Math.sin(u + .18) * s * .3); g.fill(); }
        E(0, 0, s * .33, s * .32); g.fillStyle = shade('#f4d35e'); g.fill(); g.stroke();
        E(0, s * .12, s * .22, s * .14); fill(shade('#fdf0b5'));
        E(s * .13, -s * .08, s * .08, s * .08); fill('#fff'); E(s * .15, -s * .08, s * .04, s * .04); fill(pal.ink);
        E(s * .3, s * .04, s * .04, s * .05); fill(shade('#b45309'));
      } else if (k === 'whale') {
        g.beginPath(); g.moveTo(-s * .38, 0); g.quadraticCurveTo(-s * .5, -s * .02, -s * .62, -s * .16); g.quadraticCurveTo(-s * .56, -s * .02, -s * .62, s * .1); g.quadraticCurveTo(-s * .5, s * .04, -s * .38, s * .06); g.fillStyle = shade('#3f73b3'); g.fill(); g.stroke();
        E(0, 0, s * .44, s * .21); g.fillStyle = shade('#4f86c6'); g.fill(); g.stroke();
        E(s * .06, s * .09, s * .32, s * .09); fill(shade('#dbe9f6'));
        E(s * .26, -s * .05, s * .035, s * .035); fill(pal.ink);
        g.beginPath(); g.arc(s * .3, s * .02, s * .07, .2, 1.3); g.lineWidth = s * .02; g.stroke();
      } else if (k === 'boot') {
        g.beginPath(); g.moveTo(-s * .18, -s * .4); g.lineTo(s * .08, -s * .4); g.lineTo(s * .1, -s * .02); g.quadraticCurveTo(s * .34, s * .02, s * .36, s * .14); g.lineTo(s * .36, s * .2); g.lineTo(-s * .2, s * .2); g.closePath();
        g.fillStyle = shade('#7b4a26'); g.fill(); g.stroke();
        g.fillStyle = shade('#3b2414'); g.fillRect(-s * .2, s * .14, s * .56, s * .07);
        for (let i = 0; i < 3; i++) line([-s * .02, -s * .3 + i * s * .1, s * .1, -s * .26 + i * s * .1], s * .025, shade('#e7d7b5'));
        E(-s * .05, -s * .4, s * .13, s * .03); fill(shade('#5a3519'));
      } else if (k === 'duck') {
        E(0, s * .08, s * .32, s * .19); g.fillStyle = shade('#ffd23f'); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(-s * .26, 0); g.lineTo(-s * .38, -s * .12); g.lineTo(-s * .22, -s * .06); g.fill();
        E(s * .16, -s * .14, s * .15, s * .15); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(s * .28, -s * .16); g.quadraticCurveTo(s * .44, -s * .14, s * .29, -s * .07); g.closePath(); g.fillStyle = shade('#ff8c1a'); g.fill(); g.stroke();
        E(s * .2, -s * .18, s * .03, s * .03); fill(pal.ink);
      }
      g.restore();
    }
    function draw() {
      if (isDark !== dark()) palette();
      g.setTransform(dpr, 0, 0, dpr, 0, -top * dpr);
      g.clearRect(0, top, W, H - top);
      // lanterne (crépuscule) : un halo qui vacille un peu
      const lx = xm - 1.55 * S, ly = yd - 1.25 * S;
      if (isDark) {
        const fl = .85 + Math.sin(T * 7.3) * .05 + Math.sin(T * 13.1) * .04, gr = g.createRadialGradient(lx, ly + .2 * S, 0, lx, ly + .2 * S, 1.9 * S);
        gr.addColorStop(0, `rgba(253,186,116,${.42 * fl})`); gr.addColorStop(.35, `rgba(251,146,60,${.14 * fl})`); gr.addColorStop(1, 'rgba(251,146,60,0)');
        g.fillStyle = gr; g.fillRect(lx - 2 * S, ly - 1.8 * S, 4 * S, 4 * S);
      }
      // ronds dans l'eau (aplatis : on les voit de biais)
      for (const r of ripples) { const q = r.t / 2.2; E(r.x, r.y + 1, r.m * (.15 + q), r.m * (.15 + q) * .26); g.lineWidth = 1.4; g.strokeStyle = `rgba(255,255,255,${(1 - q) * (isDark ? .45 : .7)})`; g.stroke(); }
      // canards partis à la dérive
      for (const f of floaters) { const a = Math.min(1, (24 - f.t) / 4); g.globalAlpha = a; drawCatch('duck', f.x, f.y - .12 * S + Math.sin(f.t * 2) * 1.5, Math.sin(f.t * 1.7) * .08, .8); g.globalAlpha = 1; }
      // le ponton : pieux, tablier vu de côté, planches
      for (let x = xe - .3 * S; x > -S; x -= 1.35 * S) {
        g.fillStyle = pal.woodD; g.fillRect(x, yd, .17 * S, .62 * S);
        g.fillStyle = isDark ? 'rgba(10,18,34,.5)' : 'rgba(30,64,90,.25)'; g.fillRect(x, yd + .5 * S, .17 * S, .12 * S);
        g.fillStyle = isDark ? 'rgba(10,18,34,.3)' : 'rgba(30,64,90,.16)'; g.fillRect(x + Math.sin(T * 1.5 + x) * 1.5, yd + .66 * S, .17 * S, .35 * S); // reflet
      }
      g.fillStyle = pal.wood; g.fillRect(-10, yd - .02 * S, xe + 10, .22 * S);
      g.fillStyle = pal.woodL; g.fillRect(-10, yd - .07 * S, xe + 10, .07 * S);
      g.fillStyle = pal.woodD; for (let x = xe - .38 * S; x > -10; x -= .38 * S) g.fillRect(x, yd - .02 * S, Math.max(1, .025 * S), .22 * S);
      // la lanterne sur son poteau
      g.fillStyle = pal.woodD; g.fillRect(lx - .05 * S, ly - .25 * S, .1 * S, yd - ly + .25 * S);
      line([lx, ly - .22 * S, lx + .28 * S, ly - .22 * S, lx + .28 * S, ly - .1 * S], .04 * S, pal.lamp);
      g.fillStyle = pal.lamp; g.fillRect(lx + .16 * S, ly - .12 * S, .24 * S, .05 * S); g.fillRect(lx + .18 * S, ly + .2 * S, .2 * S, .05 * S);
      g.fillStyle = isDark ? '#fde68a' : shade('#fef3c7'); g.fillRect(lx + .2 * S, ly - .07 * S, .16 * S, .27 * S);
      // le seau (il sursaute quand une prise tombe dedans)
      const hop = T - bucketHop < .35 ? Math.sin((T - bucketHop) / .35 * Math.PI) * .08 * S : 0, bx = xm - .85 * S, by = yd - .07 * S - hop;
      g.beginPath(); g.moveTo(bx - .22 * S, by - .4 * S); g.lineTo(bx + .22 * S, by - .4 * S); g.lineTo(bx + .17 * S, by); g.lineTo(bx - .17 * S, by); g.closePath(); g.fillStyle = pal.bucket; g.fill();
      g.fillStyle = pal.bucketD; g.fillRect(bx - .21 * S, by - .3 * S, .42 * S, .04 * S);
      E(bx, by - .4 * S, .22 * S, .05 * S); fill(pal.bucketD);
      g.beginPath(); g.arc(bx, by - .4 * S, .2 * S, Math.PI * 1.1, Math.PI * 1.9); g.lineWidth = .025 * S; g.strokeStyle = pal.bucketD; g.stroke();
      // le pêcheur : jambes qui pendent au bout du ponton
      const sw = Math.sin(T * 1.3) * .05 * S, knee = { x: xe + .02 * S, y: yd - .1 * S }, ank = { x: xe + .1 * S + sw, y: yd + .36 * S };
      line([xm, yd - .14 * S, knee.x, knee.y, ank.x, ank.y], .2 * S, pal.pants);
      E(ank.x + .08 * S, ank.y + .04 * S, .14 * S, .08 * S); fill(pal.boot);
      // le buste (il respire), le bras de derrière, la tête, le bob, le bras de devant
      const br = Math.sin(T * 1.6) * .015 * S, exc = st === 'show' && kind === 'whale' ? Math.abs(Math.sin((T - t0) * 9)) * .04 * S : 0;
      const h = hands(), sh = { x: xm + .1 * S, y: yd - .72 * S - br };
      line([sh.x - .05 * S, sh.y + .05 * S, xm + .25 * S, yd - .4 * S, h.x - .05 * S, h.y + .02 * S], .12 * S, pal.coatD);
      g.beginPath(); g.moveTo(xm - .24 * S, yd - .04 * S); g.lineTo(xm + .26 * S, yd - .04 * S); g.lineTo(xm + .22 * S, yd - .78 * S - br); g.quadraticCurveTo(xm + .02 * S, yd - .9 * S - br, xm - .16 * S, yd - .78 * S - br); g.closePath();
      g.fillStyle = pal.coat; g.fill(); g.lineWidth = Math.max(1, .025 * S); g.strokeStyle = pal.coatD; g.stroke();
      line([xm + .02 * S, yd - .66 * S, xm + .04 * S, yd - .2 * S], .02 * S, pal.coatD);
      const hx = xm + .06 * S, hy = yd - 1.03 * S - br - exc;
      E(hx, hy, .24 * S, .24 * S); fill(pal.skin);
      g.beginPath(); g.moveTo(hx - .15 * S, hy + .06 * S); g.quadraticCurveTo(hx + .04 * S, hy + .15 * S, hx + .22 * S, hy + .1 * S); g.quadraticCurveTo(hx + .16 * S, hy + .36 * S, hx - .02 * S, hy + .32 * S); g.quadraticCurveTo(hx - .17 * S, hy + .22 * S, hx - .15 * S, hy + .06 * S); fill(pal.beard);
      E(hx + .25 * S, hy + .04 * S, .075 * S, .065 * S); fill(pal.skinD);
      E(hx + .05 * S, hy + .02 * S, .05 * S, .035 * S); fill(isDark ? 'rgba(244,114,182,.18)' : 'rgba(244,114,182,.35)');
      E(hx + .14 * S, hy - .03 * S, .03 * S, st === 'show' && kind !== 'boot' && kind !== 'duck' ? .048 * S : .03 * S); fill(pal.ink);
      g.beginPath(); g.arc(hx, hy - .15 * S, .24 * S, Math.PI, 0); fill(pal.hat);
      E(hx + .03 * S, hy - .15 * S, .42 * S, .065 * S); fill(pal.hatD);
      // la canne (courbée selon bend) et le bras de devant qui la tient
      const tp = tipOf(), mx = (h.x + tp.x) / 2, my = (h.y + tp.y) / 2, nx = -Math.sin(theta), ny = Math.cos(theta);
      g.beginPath(); g.moveTo(h.x - Math.cos(theta) * .35 * S, h.y - Math.sin(theta) * .35 * S); g.quadraticCurveTo(mx + nx * bend * .5, my + ny * bend * .5, tp.x, tp.y); g.lineWidth = Math.max(1.5, .045 * S); g.strokeStyle = pal.rod; g.stroke();
      line([sh.x + .04 * S, sh.y + .02 * S, xm + .34 * S, yd - .38 * S, h.x, h.y], .13 * S, pal.coat);
      E(h.x, h.y, .07 * S, .07 * S); fill(pal.skin);
      // le fil : vers le bouchon (un peu de mou), vers la prise (tendu), ou rien pendant le lancer
      const c = catchPos(), lc = isDark ? 'rgba(226,232,240,.55)' : 'rgba(30,41,59,.55)';
      g.lineWidth = 1; g.strokeStyle = lc; g.beginPath(); g.moveTo(tp.x, tp.y);
      if (c && st !== 'stash') g.lineTo(c.x, c.y);
      else if (st === 'stash' && c) g.lineTo(c.x, c.y);
      else if (bob.on) { const sag = st === 'idle' ? .35 * S : .1 * S; g.quadraticCurveTo((tp.x + bob.x) / 2, Math.max(tp.y, bob.y) + sag * (cast ? 0 : 1), bob.x, bob.y - .06 * S); }
      g.stroke();
      // le bouchon : rouge dessus, blanc dessous, à moitié dans l'eau
      if (bob.on && !c) {
        const r = .085 * S;
        g.save(); g.beginPath(); g.rect(bob.x - r * 2, bob.y - r * 3, r * 4, cast ? r * 6 : r * 3 + .5); g.clip();
        E(bob.x, bob.y - r * .3, r, r * 1.15); fill('#f8fafc'); g.beginPath(); g.ellipse(bob.x, bob.y - r * .3, r, r * 1.15, 0, Math.PI, 0); fill('#e8423f');
        g.restore();
        E(bob.x, bob.y + 1, r * 1.6, r * .4); g.lineWidth = 1; g.strokeStyle = isDark ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.6)'; g.stroke();
      }
      // la prise
      if (c) {
        const vertical = !(kind === 'boot' || kind === 'duck'), s = SIZE[kind] * S;
        const ang = (vertical ? -Math.PI / 2 : 0) + (c.a || 0) + (st === 'show' && vertical ? Math.sin((T - t0) * 14) * .12 * Math.exp(-(T - t0) * .6) : 0);
        const off = vertical ? s * .42 : s * .3; // le fil tient la prise par la bouche (ou par le lacet)
        drawCatch(kind, c.x - Math.sin(c.a || 0) * off * 0, c.y + off, ang, c.s);
        if (kind === 'whale' && st === 'show') for (let i = 0; i < 3; i++) { const q = ((T - t0) * 1.5 + i / 3) % 1; E(c.x + (i - 1) * .12 * S * q, c.y + off - s * .5 - q * .5 * S, .04 * S, .04 * S); fill(`rgba(219,234,254,${1 - q})`); }
      }
      // éclaboussures et étincelles
      g.fillStyle = isDark ? 'rgba(219,234,254,.8)' : 'rgba(255,255,255,.95)';
      for (const d of drops) { E(d.x, d.y, .03 * S, .045 * S); g.fill(); }
      for (const s of sparks) { const q = s.t / .8, r = .09 * S * Math.sin(q * Math.PI); g.save(); g.translate(s.x, s.y); g.rotate(q); g.fillStyle = `rgba(254,240,138,${1 - q})`; g.beginPath(); g.moveTo(0, -r); g.lineTo(r * .25, -r * .25); g.lineTo(r, 0); g.lineTo(r * .25, r * .25); g.lineTo(0, r); g.lineTo(-r * .25, r * .25); g.lineTo(-r, 0); g.lineTo(-r * .25, -r * .25); g.fill(); g.restore(); }
      // la bulle « ! » (doré, baleine) ou « ? » (botte, canard)
      const say = kind === 'whale' || kind === 'golden' ? '!' : kind === 'boot' || kind === 'duck' ? '?' : '';
      if (say && (st === 'show' || st === 'stash')) {
        const q = st === 'show' ? clamp((T - t0) / .3, 0, 1) : 1 - clamp((T - t0) / .4, 0, 1), k = q < 1 && st === 'show' ? 1 + Math.sin(q * Math.PI) * .25 : 1;
        const x = hx + .5 * S, y = hy - .55 * S, w = .36 * S * k;
        g.globalAlpha = q; g.fillStyle = isDark ? '#e2e8f0' : '#fff';
        g.beginPath(); g.roundRect ? g.roundRect(x - w / 2, y - w / 2, w, w, w * .3) : g.rect(x - w / 2, y - w / 2, w, w); g.fill();
        g.beginPath(); g.moveTo(x - w * .25, y + w * .4); g.lineTo(x - w * .45, y + w * .75); g.lineTo(x, y + w * .45); g.fill();
        g.fillStyle = say === '!' ? '#dc2626' : '#334155'; g.font = `800 ${Math.round(w * .78)}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(say, x, y + w * .04);
        g.globalAlpha = 1;
      }
    }
    const lp = loop({ alive: () => alive && cv.c.isConnected, frame(t, dt) { if (dt) update(dt); draw(); } });
    let rt = 0;
    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { geo(); bob.x = bob0.x; bob.y = bob0.y; lp.draw(); }, 200); };
    addEventListener('resize', onResize);
    palette(); geo(); bob.x = bob0.x; bob.y = bob0.y;
    if (still()) lp.draw(); else lp.start();
    return {
      alive: () => alive && cv.c.isConnected,
      stop() { alive = false; lp.stop(); clearTimeout(rt); removeEventListener('resize', onResize); cv.c.remove(); },
      roll(tier, n, rank) {
        if (!(rank >= 4) || still()) return;
        boost = Math.max(boost, rank);
        if (st === 'idle') nextBite = Math.min(nextBite, T + .5);
      },
      // pour les films de vérification (review) : forcer une prise ; purement visuel
      _debug: (force) => { if (force) { kind = force; boost = 0; go('nibble'); } return { st, kind, T, nextBite }; },
    };
  };

  /* ===============================================================================================================
   * Six fonds d'idées de joueurs (2026-11-01) : Farm, Keyboard ASMR, Thunderstorm, Solar System, Meteor Shower, Party.
   * Même échafaudage pour les six (stage) : le ciel ou le fond uni est en CSS (.wp-<id>, repris par l'aperçu de la
   * boutique) ; un canevas « décor » est peint une seule fois (au redimensionnement et au changement de thème), et un
   * canevas « vie » est redessiné à chaque image, sur tout l'écran ou sur une bande (S.fgTop, S.fgH). Avec lazy, il ne
   * l'est que si quelque chose bouge (le clavier). Mouvement réduit et mode performance : une image fixe, redessinée au
   * redimensionnement, au changement de thème et après un tirage.
   */
  const seeded = s => () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // un clic sur le fond lui-même, jamais sur le jeu : même règle que les bulles ASMR (js/app.js)
  const onBackground = t => { const r = doc.documentElement; return t === doc.body || t === r || t.id === 'app' || (r.classList.contains('wall-trying') && !t.closest('.wall-try-bar')); };
  const rr = (g, x, y, w, h, r) => { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const ell = (g, x, y, rx, ry, a) => { g.beginPath(); g.ellipse(x, y, Math.max(.01, rx), Math.max(.01, ry), a || 0, 0, Math.PI * 2); };
  const mixHex = (hex, to, k) => { const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16); const c = s => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k); return `rgb(${c(16)},${c(8)},${c(0)})`; };
  // Un ciel d'étoiles au hasard (un motif CSS répété se voyait en grille) : peint sur le décor ; rgb sans « rgba( ».
  function starfield(g, W, H, n, seed, rgb, a) {
    const r = seeded(seed);
    for (let i = 0; i < n; i++) {
      const x = r() * W, y = r() * H, k = r(), rad = .5 + k * k * 1.1;
      g.fillStyle = `rgba(${rgb},${(a * (.35 + .65 * r())).toFixed(3)})`; ell(g, x, y, rad, rad); g.fill();
    }
  }
  // Quelques étoiles qui scintillent (redessinées à chaque image : une trentaine de points, rien de cher).
  const twinklers = (n, maxY) => Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random() * maxY, ph: Math.random() * 7, sp: rnd(.6, 1.6), r: rnd(.9, 1.6) }));
  function twinkle(g, list, W, H, rgb, a, T) {
    for (const s of list) { const k = .5 + .5 * Math.sin(T * s.sp + s.ph); g.fillStyle = `rgba(${rgb},${(a * k).toFixed(3)})`; ell(g, s.x * W, s.y * H, s.r * (.7 + .5 * k), s.r * (.7 + .5 * k)); g.fill(); }
  }
  function stage(layer, pre, h) {
    const bg = canvas(layer, pre + '-bg', 1.5), fg = canvas(layer, pre + '-fg', 1.5);
    const S = { W: 1, H: 1, T: 0, dark: dark(), still: still(), fgTop: 0, fgH: 0, dirty: true };
    let alive = true, rt = 0;
    const scaled = cv => { const k = cv.c.width / Math.max(1, cv.c.clientWidth); cv.g.setTransform(k, 0, 0, k, 0, 0); };
    function layout() {
      S.W = innerWidth; S.H = innerHeight; S.dark = dark(); S.still = still(); S.fgTop = 0; S.fgH = 0;
      h.layout(S);
      fg.c.style.top = S.fgTop + 'px'; fg.c.style.height = (S.fgH || S.H - S.fgTop) + 'px';
      bg.fit(); fg.fit(); scaled(bg); scaled(fg);
      bg.g.clearRect(0, 0, S.W, S.H);
      if (h.paint) h.paint(S, bg.g);
      S.dirty = true;
    }
    function draw() {
      const g = fg.g;
      g.clearRect(0, 0, S.W, S.fgH || S.H - S.fgTop);
      g.save(); g.translate(0, -S.fgTop); h.draw(S, g); g.restore();
    }
    const lp = loop({ alive: () => alive && fg.c.isConnected, frame(t, dt) {
      if (dt && S.still) return; // passé en mouvement réduit ou en mode performance : l'image fixe suffit
      S.T += dt;
      if (h.update && dt) h.update(S, dt);
      if (h.lazy && dt && !S.dirty) return;
      S.dirty = false;
      draw();
    } });
    // thème clair / sombre ou mode performance changés : on repeint le décor
    const mo = new MutationObserver(() => {
      if (dark() === S.dark && still() === S.still) return;
      layout(); lp.draw(); if (!S.still) lp.start();
    });
    mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { layout(); lp.draw(); }, 200); };
    addEventListener('resize', onResize);
    layout();
    if (S.still) lp.draw(); else lp.start();
    return {
      S,
      redraw() { S.dirty = true; if (S.still) lp.draw(); },
      alive: () => alive && fg.c.isConnected,
      stop() { alive = false; lp.stop(); mo.disconnect(); clearTimeout(rt); removeEventListener('resize', onResize); if (h.stop) h.stop(); bg.c.remove(); fg.c.remove(); },
      roll(tier, n, rank) { if (h.roll) h.roll(S, tier, n, rank); if (S.still) lp.draw(); },
      // pour les films de vérification : forcer un évènement (purement visuel)
      _debug: (...a) => (h.debug ? h.debug(S, ...a) : S),
    };
  }

  /* ---------------------------------------------------------------------------------------------------------------
   * 🐄 Farm (idée de HSI, 2026-11-01) : « une ferme par une journée ensoleillée, des animaux et une grange rouge au
   * fond ». Un livre d'images : collines en patchwork, grange rouge et silo, chemin de terre, clôture en bois. Les
   * vaches broutent, les moutons trottinent, les poules picorent par petites courses ; un tracteur passe sur le chemin
   * de temps en temps. Le coq, sur un piquet de la clôture, chante sur un tirage Epic+ (élan en arrière, cou tendu,
   * bec ouvert, ondes) ; sur un Mythic+, toutes les poules battent des ailes en sautillant. En thème sombre, la même
   * ferme au soir : couleurs éteintes, la lucarne de la grange et la cabine du tracteur allumées. Le ciel et les nuages
   * sont en CSS (.wp-farm).
   */
  SCENES.farm = layer => {
    const PAL = {
      day: { far: '#a9d3ae', far2: '#90c796', field: '#8ccb72', field2: '#a4d885', patch: ['#c8df88', '#e6d690', '#acd47e'], road: '#e6d3a6', roadD: '#cfb98b',
        barn: '#c9473e', barnD: '#a3352e', trim: '#fff8ee', roof: '#5f4237', silo: '#c9d1d8', siloD: '#9ba7b2', win: '#6a4436', glow: null,
        post: '#b98b5c', postD: '#8f6740', rail: '#c99d6d', tree: '#5ea65e', treeD: '#4b8f4f', trunk: '#7b5836', tuft: '#74b25e', flower: ['#ffffff', '#fde68a', '#f9a8d4'],
        cow: '#fbf8f3', spot: '#2f2b29', pink: '#f2a9a9', horn: '#efe3c8', wool: '#f8f4ea', woolD: '#ddd5c4', face: '#3d3634', hen: '#fffaf1', henB: '#d08c4f', comb: '#e2443a', beak: '#f5b335', leg: '#e9a23b',
        roo: '#c4572d', rooN: '#e8a33d', rooW: '#8f3a1f', rooT: '#2f4f3f', rooT2: '#3f6b55', tractor: '#3f9142', tractorD: '#2e6e31', hub: '#f4c430', tire: '#2a2a2a', glass: 'rgba(207,232,245,.75)', skin: '#f1c27d', hat: '#e9c46a',
        smoke: '255,255,255', shadow: 'rgba(40,70,30,.16)', ring: '#f59e0b' },
      dusk: { far: '#2c4650', far2: '#273f47', field: '#284636', field2: '#2d4f3b', patch: ['#33573a', '#475336', '#34553b'], road: '#57503f', roadD: '#4a4436',
        barn: '#7a2e2b', barnD: '#622422', trim: '#c9bfb2', roof: '#36272a', silo: '#68717c', siloD: '#545b65', win: '#ffcf73', glow: 'rgba(255,190,90,.35)',
        post: '#665140', postD: '#4f3f30', rail: '#725c48', tree: '#2a4a36', treeD: '#223d2e', trunk: '#46372a', tuft: '#2f583d', flower: ['#bdb8cc', '#bfa967', '#ad849c'],
        cow: '#cbc5be', spot: '#262322', pink: '#b08282', horn: '#b7ad99', wool: '#cdc8bc', woolD: '#a9a397', face: '#2e2927', hen: '#d2cdc4', henB: '#a06d44', comb: '#b3423a', beak: '#c79433', leg: '#bb8735',
        roo: '#984a2c', rooN: '#b48439', rooW: '#6e3018', rooT: '#21372d', rooT2: '#2d4b3c', tractor: '#2e6a35', tractorD: '#235129', hub: '#c49f30', tire: '#1d1d1f', glass: 'rgba(255,214,130,.85)', skin: '#b99470', hat: '#b3974f',
        smoke: '200,196,214', shadow: 'rgba(0,0,0,.24)', ring: 'rgba(255,231,176,.8)' },
    };
    const R = Math.random;
    let G = {}, portrait = false;
    const herd = [];
    // les animaux préfèrent les côtés : le milieu de l'écran est derrière le jeu
    const side = () => R() < .72 ? (R() < .5 ? rnd(.03, .3) : rnd(.7, .97)) : rnd(.3, .7);
    const add = (k, n) => { for (let i = 0; i < n; i++) herd.push({ k, nx: side(), ny: R(), tx: 0, ty: 0, dir: R() < .5 ? -1 : 1, st: 'idle', until: rnd(.5, 4), ph: R() * 6, head: 0, flapT: -9,
      spots: [[rnd(-.32, -.05), rnd(-.78, -.55), rnd(.11, .17)], [rnd(.08, .32), rnd(-.68, -.48), rnd(.09, .14)], [rnd(-.2, .2), rnd(-.5, -.42), rnd(.06, .09)]], brown: k === 'hen' && R() < .4 }); };
    const tr = { on: false, next: rnd(8, 14), x: 0, dir: 1, v: 0, rot: 0, puff: 0 };
    const smoke = [];
    let crowT = -9;
    const hillA = x => G.hz - G.u * (.62 + .3 * Math.sin(x / G.W * 4.4 + .8) + .12 * Math.sin(x / G.W * 9.7 + 2.1));
    const hillB = x => G.hz - G.u * (.16 + .14 * Math.sin(x / G.W * 3.1 + 2.4) + .05 * Math.sin(x / G.W * 12 + 1));

    function barn(g, p, x, base, w) {
      const hW = w * .52, pts = [[x, base], [x, base - hW], [x + w * .15, base - hW - w * .3], [x + w * .5, base - hW - w * .47], [x + w * .85, base - hW - w * .3], [x + w, base - hW], [x + w, base]];
      const path = () => { g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath(); };
      path(); g.fillStyle = p.barn; g.fill();
      g.save(); path(); g.clip(); g.strokeStyle = p.barnD; g.globalAlpha = .55; g.lineWidth = Math.max(1, w * .008);
      for (let i = 1; i < 14; i++) { g.beginPath(); g.moveTo(x + i * w / 14, base - hW - w * .5); g.lineTo(x + i * w / 14, base); g.stroke(); }
      g.restore();
      // le toit : un bord sombre, puis la bordure blanche
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath(); pts.slice(1, 6).forEach(([a, b], i) => (i ? g.lineTo(a, b - w * .02) : g.moveTo(a - w * .03, b - w * .02))); g.strokeStyle = p.roof; g.lineWidth = w * .075; g.stroke();
      g.beginPath(); pts.slice(1, 6).forEach(([a, b], i) => (i ? g.lineTo(a, b + w * .012) : g.moveTo(a, b + w * .012))); g.strokeStyle = p.trim; g.lineWidth = w * .032; g.stroke();
      // la grande porte à croix
      const dx = x + w * .29, dw = w * .42, dh = hW * .74, dy = base - dh;
      g.fillStyle = p.barnD; g.fillRect(dx, dy, dw, dh);
      g.strokeStyle = p.trim; g.lineWidth = w * .026;
      g.strokeRect(dx, dy, dw, dh);
      g.beginPath(); g.moveTo(dx + dw / 2, dy); g.lineTo(dx + dw / 2, base);
      g.moveTo(dx, dy); g.lineTo(dx + dw / 2, base); g.moveTo(dx + dw / 2, dy); g.lineTo(dx, base);
      g.moveTo(dx + dw / 2, dy); g.lineTo(dx + dw, base); g.moveTo(dx + dw, dy); g.lineTo(dx + dw / 2, base); g.stroke();
      // la lucarne du grenier (allumée le soir)
      const wx = x + w * .41, wy = base - hW - w * .25, ww = w * .18, wh = w * .15;
      if (p.glow) { const gr = g.createRadialGradient(wx + ww / 2, wy + wh / 2, 0, wx + ww / 2, wy + wh / 2, w * .5); gr.addColorStop(0, p.glow); gr.addColorStop(1, 'rgba(255,190,90,0)'); g.fillStyle = gr; g.fillRect(wx - w * .5, wy - w * .5, w * 1.2, w * 1.2); }
      g.fillStyle = p.win; g.fillRect(wx, wy, ww, wh); g.strokeStyle = p.trim; g.lineWidth = w * .022; g.strokeRect(wx, wy, ww, wh);
      g.beginPath(); g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh); g.stroke();
    }
    function silo(g, p, x, base, w, h) {
      g.fillStyle = p.silo; g.fillRect(x, base - h, w, h);
      g.beginPath(); g.arc(x + w / 2, base - h, w / 2, Math.PI, 0); g.fill();
      g.fillStyle = p.siloD; g.globalAlpha = .6; g.fillRect(x + w * .66, base - h, w * .34, h); g.globalAlpha = 1;
      g.strokeStyle = p.siloD; g.lineWidth = Math.max(1, w * .04);
      for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(x, base - h * i / 6); g.lineTo(x + w, base - h * i / 6); g.stroke(); }
    }
    function tree(g, p, x, y, r) {
      g.fillStyle = p.trunk; g.fillRect(x - r * .12, y - r * .9, r * .24, r * .9);
      g.fillStyle = p.treeD; ell(g, x + r * .15, y - r * 1.25, r * .85, r * .8); g.fill();
      g.fillStyle = p.tree; ell(g, x - r * .1, y - r * 1.35, r * .8, r * .75); g.fill();
    }

    // ---- les animaux, de profil, tournés vers la droite (dir = −1 : retournés) ; s = la taille, origine aux pieds
    function cow(g, p, a, x, y, s, T) {
      const walk = a.st === 'walk';
      g.save(); g.translate(x, y); g.scale(a.dir * s, s);
      ell(g, 0, 0, .6, .07); g.fillStyle = p.shadow; g.fill();
      g.lineCap = 'round'; g.lineWidth = .085;
      for (const [lx, o] of [[-.36, 0], [-.22, Math.PI], [.2, Math.PI], [.34, 0]]) {
        const d = walk ? Math.sin(a.ph + o) * .07 : 0;
        g.strokeStyle = p.cow; g.beginPath(); g.moveTo(lx, -.44); g.lineTo(lx + d, -.03); g.stroke();
        g.fillStyle = p.spot; ell(g, lx + d, -.025, .05, .03); g.fill();
      }
      // la queue qui chasse les mouches
      const sw = Math.sin(T * 1.7 + a.ph) * .05;
      g.strokeStyle = p.cow; g.lineWidth = .035; g.beginPath(); g.moveTo(-.5, -.78); g.quadraticCurveTo(-.62 + sw, -.62, -.58 + sw * 1.4, -.44); g.stroke();
      g.fillStyle = p.spot; ell(g, -.58 + sw * 1.4, -.42, .035, .05); g.fill();
      rr(g, -.52, -.88, 1, .48, .2); g.fillStyle = p.cow; g.fill();
      g.save(); rr(g, -.52, -.88, 1, .48, .2); g.clip(); g.fillStyle = p.spot;
      for (const [sx, sy, sr] of a.spots) { ell(g, sx, sy, sr * 1.35, sr); g.fill(); }
      g.restore();
      g.fillStyle = p.pink; ell(g, -.16, -.41, .1, .06); g.fill();
      // la tête : relevée, ou dans l'herbe (head = 1)
      const hd = a.head, hx = .52 + .05 * hd, hy = -.86 + .58 * hd;
      g.strokeStyle = p.cow; g.lineWidth = .22; g.beginPath(); g.moveTo(.36, -.72); g.lineTo(hx - .02, hy + .04); g.stroke();
      g.fillStyle = p.cow; g.save(); g.translate(hx, hy); g.rotate(hd * .5);
      ell(g, -.1, -.12, .1, .045, -.3); g.fill();
      g.fillStyle = p.horn; ell(g, -.02, -.17, .03, .055, .2); g.fill();
      g.fillStyle = p.cow; rr(g, -.09, -.15, .26, .3, .1); g.fill();
      g.fillStyle = p.pink; ell(g, .09, .1, .1, .075); g.fill();
      g.fillStyle = p.spot; ell(g, .06, -.04, .024, .03); g.fill(); ell(g, .1, .09, .015, .012); g.fill(); ell(g, .15, .09, .015, .012); g.fill();
      g.restore(); g.restore();
    }
    function sheep(g, p, a, x, y, s) {
      const walk = a.st === 'walk', bob = walk ? Math.abs(Math.sin(a.ph)) * .05 : 0;
      g.save(); g.translate(x, y); g.scale(a.dir * s, s);
      ell(g, 0, 0, .45, .06); g.fillStyle = p.shadow; g.fill();
      g.lineCap = 'round'; g.lineWidth = .065; g.strokeStyle = p.face;
      for (const [lx, o] of [[-.26, 0], [-.14, Math.PI], [.14, Math.PI], [.26, 0]]) { const d = walk ? Math.sin(a.ph + o) * .06 : 0; g.beginPath(); g.moveTo(lx, -.36); g.lineTo(lx + d, -.02); g.stroke(); }
      g.translate(0, -bob);
      const puffs = [[-.3, -.55, .2], [-.1, -.68, .22], [.12, -.66, .21], [.28, -.54, .19], [-.18, -.42, .19], [.08, -.42, .2], [0, -.55, .25]];
      g.fillStyle = p.woolD; for (const [px, py, pr] of puffs) { ell(g, px, py + .03, pr, pr); g.fill(); }
      g.fillStyle = p.wool; for (const [px, py, pr] of puffs) { ell(g, px - .01, py, pr * .94, pr * .94); g.fill(); }
      const hd = a.head, hx = .4 + .05 * hd, hy = -.62 + .42 * hd;
      g.save(); g.translate(hx, hy); g.rotate(.25 + hd * .4);
      g.fillStyle = p.face; ell(g, -.1, -.08, .08, .035, -.4); g.fill(); ell(g, 0, 0, .12, .16); g.fill();
      g.fillStyle = '#fff'; ell(g, .04, -.04, .022, .022); g.fill();
      g.fillStyle = p.wool; ell(g, -.03, -.15, .08, .07); g.fill();
      g.restore(); g.restore();
    }
    function hen(g, p, a, x, y, s, T) {
      const c = T - a.flapT, flapping = c >= 0 && c < 1.6;
      const hop = flapping ? Math.max(0, Math.sin(c * Math.PI / .4)) * .35 * (1 - c / 1.6) : 0;
      const pk = a.st === 'eat' && !flapping ? Math.max(0, Math.sin(a.ph * 2.2)) : 0;
      const walk = a.st === 'walk';
      g.save(); g.translate(x, y); g.scale(a.dir * s, s);
      ell(g, 0, 0, .3 * (1 - hop * .6), .05); g.fillStyle = p.shadow; g.fill();
      g.translate(0, -hop);
      g.lineCap = 'round'; g.lineWidth = .05; g.strokeStyle = p.leg;
      const d = walk ? Math.sin(a.ph) * .07 : 0;
      g.beginPath(); g.moveTo(-.05, -.26); g.lineTo(-.06 + d, 0); g.moveTo(.06, -.26); g.lineTo(.06 - d, 0); g.stroke();
      g.translate(0, -.26); g.rotate(pk * .55); g.translate(0, .26);
      const body = a.brown ? p.henB : p.hen;
      g.fillStyle = body; g.beginPath(); g.moveTo(-.22, -.5); g.lineTo(-.46, -.82); g.lineTo(-.36, -.5); g.closePath(); g.fill();
      ell(g, 0, -.45, .32, .24); g.fill();
      g.fillStyle = 'rgba(0,0,0,.08)';
      const fl = flapping ? Math.abs(Math.sin(c * 16)) : 0;
      g.save(); g.translate(-.02, -.5); g.rotate(-fl * 1.1); ell(g, -.08, .03, .17, .09); g.fill(); g.restore();
      g.fillStyle = body; ell(g, .22, -.72, .12, .12); g.fill();
      g.fillStyle = p.comb; ell(g, .18, -.85, .045, .045); g.fill(); ell(g, .24, -.87, .05, .05); g.fill(); ell(g, .3, -.83, .04, .04); g.fill(); ell(g, .31, -.63, .03, .045); g.fill();
      g.fillStyle = p.beak; g.beginPath(); g.moveTo(.33, -.75); g.lineTo(.44, -.7); g.lineTo(.33, -.66); g.closePath(); g.fill();
      g.fillStyle = '#222'; ell(g, .26, -.75, .022, .022); g.fill();
      g.restore();
    }
    // le coq sur son piquet ; c = temps depuis le début du chant (négatif : au repos)
    function rooster(g, p, x, y, s, dir, c, T) {
      const crowing = c >= 0 && c < 2.1;
      const lean = !crowing ? Math.sin(T * .9) * .02 : c < .25 ? .2 * easeOut(c / .25) : c < .45 ? .2 - .36 * ease((c - .25) / .2) : c < 1.6 ? -.16 : -.16 * (1 - ease(Math.min(1, (c - 1.6) / .4)));
      const neck = !crowing ? 0 : c < .25 ? 0 : c < .45 ? (c - .25) / .2 : c < 1.6 ? 1 : Math.max(0, 1 - (c - 1.6) / .4);
      const beak = crowing && c > .4 && c < 1.55 ? .8 + .2 * Math.sin(c * 40) : 0;
      const flap = crowing && c > .2 && c < 1.1 ? Math.abs(Math.sin((c - .2) * 11)) : 0;
      g.save(); g.translate(x, y); g.scale(dir * s, s);
      g.lineCap = 'round'; g.lineWidth = .055; g.strokeStyle = p.leg;
      g.beginPath(); g.moveTo(-.06, -.28); g.lineTo(-.08, 0); g.moveTo(.06, -.28); g.lineTo(.08, 0); g.stroke();
      g.translate(0, -.28); g.rotate(lean); g.translate(0, .28);
      // la queue : de grandes plumes sombres en arc
      g.lineWidth = .085;
      for (let i = 0; i < 5; i++) { g.strokeStyle = i % 2 ? p.rooT2 : p.rooT; g.beginPath(); g.moveTo(-.24, -.55); g.quadraticCurveTo(-.66 - i * .03, -1.02 + i * .1, -.5 + i * .05, -.36 + i * .04); g.stroke(); }
      g.fillStyle = p.roo; ell(g, 0, -.5, .33, .27); g.fill();
      g.save(); g.translate(-.04, -.58); g.rotate(-flap * 1.1); g.fillStyle = p.rooW; ell(g, -.1, .04, .2, .11); g.fill(); g.restore();
      const hx = .27 + neck * .05, hy = -.9 - neck * .17;
      g.fillStyle = p.rooN; g.beginPath(); g.moveTo(.06, -.68); g.quadraticCurveTo(.12, hy + .05, hx - .06, hy + .06); g.lineTo(hx + .1, hy + .1); g.quadraticCurveTo(.3, -.6, .24, -.5); g.closePath(); g.fill();
      g.fillStyle = p.roo; ell(g, hx, hy, .13, .13); g.fill();
      g.fillStyle = p.comb;
      for (const [cx, cy, r] of [[-.09, -.1, .05], [-.03, -.15, .06], [.04, -.15, .06], [.1, -.11, .05]]) { ell(g, hx + cx, hy + cy, r, r); g.fill(); }
      ell(g, hx + .1, hy + .14, .04, .07); g.fill();
      g.fillStyle = p.beak;
      g.save(); g.translate(hx + .11, hy - .01); g.rotate(-beak * .32); g.beginPath(); g.moveTo(0, -.03); g.lineTo(.14, .01); g.lineTo(0, .03); g.closePath(); g.fill(); g.restore();
      g.save(); g.translate(hx + .11, hy + .01); g.rotate(beak * .32); g.beginPath(); g.moveTo(0, -.02); g.lineTo(.11, .01); g.lineTo(0, .03); g.closePath(); g.fill(); g.restore();
      g.fillStyle = '#1d1b2c'; ell(g, hx + .03, hy - .03, .024, .024); g.fill();
      g.restore();
      // le chant : trois ondes qui partent du bec, et deux notes qui montent
      if (crowing || (c >= 0 && c < 2.8)) {
        const bx = x + dir * s * (hx + .2), by = y - s * .28 + s * (hy + .28);
        g.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          const q = (c - .45 - i * .26) / .9;
          if (q <= 0 || q >= 1) continue;
          g.strokeStyle = p.ring; g.globalAlpha = (1 - q) * .9; g.lineWidth = Math.max(1.5, s * .045);
          g.beginPath(); g.arc(bx, by, s * (.12 + .7 * q), dir > 0 ? -.7 : Math.PI - .7, dir > 0 ? .5 : Math.PI + .5); g.stroke();
        }
        for (let i = 0; i < 2; i++) {
          const q = (c - .6 - i * .5) / 1.6;
          if (q <= 0 || q >= 1) continue;
          g.globalAlpha = Math.sin(q * Math.PI) * .9; g.fillStyle = p.ring;
          g.font = `700 ${Math.round(s * .38)}px system-ui, sans-serif`; g.textAlign = 'center';
          g.fillText(i ? '♫' : '♪', bx + dir * s * (.35 + q * .5) + Math.sin(q * 9) * s * .05, by - s * (.2 + q * 1.2));
        }
        g.globalAlpha = 1;
      }
    }
    function tractor(g, p, x, y, s, dir, rot, T) {
      g.save(); g.translate(x, y); g.scale(dir * s, s);
      ell(g, .05, 0, .78, .06); g.fillStyle = p.shadow; g.fill();
      const by = Math.sin(T * 17) * .008;
      const wheel = (wx, wy, r) => {
        g.fillStyle = p.tire; ell(g, wx, wy, r, r); g.fill();
        g.fillStyle = p.hub; ell(g, wx, wy, r * .6, r * .6); g.fill();
        g.strokeStyle = p.tractorD; g.lineWidth = r * .12;
        for (let i = 0; i < 4; i++) { const a = rot * (.36 / r) + i * Math.PI / 2; g.beginPath(); g.moveTo(wx, wy); g.lineTo(wx + Math.cos(a) * r * .55, wy + Math.sin(a) * r * .55); g.stroke(); }
        g.fillStyle = p.tractorD; ell(g, wx, wy, r * .17, r * .17); g.fill();
      };
      g.translate(0, by);
      g.fillStyle = '#4b4b4b'; g.fillRect(.4, -.92, .05, .3);
      rr(g, -.14, -.64, .82, .34, .07); g.fillStyle = p.tractor; g.fill();
      g.fillStyle = p.tractorD; for (let i = 0; i < 3; i++) g.fillRect(.6, -.58 + i * .09, .07, .045);
      g.fillStyle = p.glass; g.fillRect(-.56, -1.15, .42, .42);
      g.fillStyle = p.skin; ell(g, -.34, -.9, .09, .1); g.fill();
      g.fillStyle = p.hat; ell(g, -.34, -.98, .17, .04); g.fill(); ell(g, -.34, -1.03, .09, .06); g.fill();
      g.strokeStyle = p.tractorD; g.lineWidth = .05; g.beginPath(); g.moveTo(-.6, -.7); g.lineTo(-.6, -1.2); g.moveTo(-.1, -.66); g.lineTo(-.1, -1.2); g.stroke();
      rr(g, -.7, -1.27, .68, .08, .03); g.fillStyle = p.tractor; g.fill();
      g.translate(0, -by);
      g.fillStyle = p.tractorD; g.beginPath(); g.arc(-.32, -.38, .44, Math.PI, 0); g.fill();
      wheel(-.32, -.38, .38); wheel(.5, -.2, .2);
      g.restore();
    }

    const st = stage(layer, 'wfm', {
      layout(S) {
        const W = S.W, H = S.H; portrait = H > W * 1.05;
        // en portrait, l'horizon plus bas : la grange arrive à côté des cartes du jeu, pas derrière les réglages
        const u = clamp(Math.min(W, H) / 9, 34, 92), hz = H * (portrait ? .64 : .53);
        G = { W, H, u, hz, roadY: hz - u * .02, fenceY: hz + u * .9, step: u * 1.05 };
        G.pTop = G.fenceY + u * .45; G.pBot = H - u * .25;
        // en portrait, une grange plus petite tout à gauche, sans silo : elle reste à côté des réglages du tirage
        G.barnX = portrait ? W * .025 : W * .08; G.bw = u * (portrait ? 1.75 : 2.3);
        // le coq : sur le piquet le plus proche de 85 % de la largeur (80 % en portrait)
        const n0 = Math.round((W * (portrait ? .8 : .86) - G.step * .3) / G.step);
        G.rx = n0 * G.step + G.step * .3 + u * .06; G.ry = G.fenceY - u * .62;
        S.fgTop = Math.max(0, Math.floor(hz - u * 2.6));
        if (!herd.length) { add('cow', portrait ? 1 : 2); add('sheep', portrait ? 2 : 3); add('hen', portrait ? 3 : 4); }
      },
      paint(S, g) {
        const p = S.dark ? PAL.dusk : PAL.day, { u, hz, W, H, fenceY } = G, r = seeded(11);
        const fillHill = (f, col) => { g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, f(x)); g.lineTo(W, H); g.closePath(); g.fillStyle = col; g.fill(); };
        fillHill(hillA, p.far);
        // le patchwork de champs sur la colline du fond, séparés par des haies
        g.save(); g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, hillA(x)); g.lineTo(W, H); g.closePath(); g.clip();
        for (let i = 0, x = -u * 2; x < W + u; i++) {
          const w = u * (1.6 + r() * 1.6), top = hz - u * 1.3;
          g.fillStyle = p.patch[i % 3]; g.globalAlpha = S.dark ? .55 : .7;
          g.beginPath(); g.moveTo(x + u * .6, top); g.lineTo(x + w + u * .6, top); g.lineTo(x + w - u * .3, hz); g.lineTo(x - u * .3, hz); g.closePath(); g.fill();
          g.globalAlpha = 1; g.strokeStyle = p.treeD; g.lineWidth = Math.max(1, u * .05);
          g.beginPath(); g.moveTo(x + w + u * .6, top); g.lineTo(x + w - u * .3, hz); g.stroke();
          x += w;
        }
        g.restore();
        // des arbres ronds sur la colline du fond
        for (const fx of portrait ? [.62, .9] : [.58, .66, .93]) tree(g, p, W * fx, hillA(W * fx) + u * .25, u * .3);
        fillHill(hillB, p.far2);
        // le pré, jusqu'en bas
        const gr = g.createLinearGradient(0, hz, 0, H); gr.addColorStop(0, p.field); gr.addColorStop(1, p.field2);
        g.fillStyle = gr; g.fillRect(0, hz - 1, W, H - hz + 1);
        // le chemin de terre, au pied des collines
        g.lineCap = 'round';
        g.beginPath(); for (let x = -10; x <= W + 10; x += 10) g.lineTo(x, G.roadY + Math.sin(x / W * 3) * u * .05); g.strokeStyle = p.road; g.lineWidth = u * .22; g.stroke();
        g.beginPath(); for (let x = -10; x <= W + 10; x += 10) g.lineTo(x, G.roadY + Math.sin(x / W * 3) * u * .05); g.strokeStyle = p.roadD; g.lineWidth = Math.max(1, u * .025); g.stroke();
        // la grange et le silo, posés derrière le chemin
        if (!portrait) silo(g, p, G.barnX + G.bw + u * .1, G.roadY - u * .1, u * .6, u * 2.05);
        barn(g, p, G.barnX, G.roadY - u * .1, G.bw);
        // des bandes de fauche dans le pré, très légères
        g.save(); g.globalAlpha = S.dark ? .022 : .08; g.fillStyle = '#ffffff';
        for (let x = -W; x < W * 2; x += u * 2.2) { g.beginPath(); g.moveTo(x, fenceY); g.lineTo(x + u * 1.1, fenceY); g.lineTo(x + u * 1.1 + u * 3, H); g.lineTo(x + u * 3, H); g.closePath(); g.fill(); }
        g.restore();
        // touffes d'herbe et fleurs (toujours les mêmes : hasard fixé)
        const n = Math.round(W * (H - fenceY) / 2600);
        for (let i = 0; i < n; i++) {
          const x = r() * W, y = fenceY + u * .1 + r() * (H - fenceY), k = .5 + (y - fenceY) / (H - fenceY) * .7;
          if (r() < .7) { g.strokeStyle = p.tuft; g.lineWidth = Math.max(1, u * .025 * k); g.beginPath(); for (const a of [-.5, 0, .5]) { g.moveTo(x, y); g.lineTo(x + a * u * .1 * k, y - u * .14 * k); } g.stroke(); }
          else { g.fillStyle = p.flower[Math.floor(r() * 3)]; ell(g, x, y, u * .03 * k, u * .03 * k); g.fill(); }
        }
        // la clôture : deux lisses, puis les piquets
        g.fillStyle = p.rail;
        g.fillRect(0, fenceY - u * .5, W, u * .07); g.fillRect(0, fenceY - u * .26, W, u * .07);
        g.fillStyle = p.postD; g.globalAlpha = .5; g.fillRect(0, fenceY - u * .43, W, u * .015); g.fillRect(0, fenceY - u * .19, W, u * .015); g.globalAlpha = 1;
        for (let x = G.step * .3; x < W + G.step; x += G.step) {
          g.fillStyle = p.post; g.fillRect(x, fenceY - u * .62, u * .12, u * .66);
          g.fillStyle = p.postD; g.fillRect(x + u * .08, fenceY - u * .62, u * .04, u * .66);
        }
      },
      update(S, dt) {
        const T = S.T;
        for (const a of herd) {
          a.until -= dt;
          if (a.until <= 0) {
            const x = R();
            if (x < .45) { a.st = 'walk'; a.tx = R() < .35 ? side() : clamp(a.nx + rnd(-.22, .22), .02, .98); a.ty = clamp(a.ny + rnd(-.35, .35), 0, 1); a.until = 40; }
            else if (x < .82) { a.st = 'eat'; a.until = a.k === 'hen' ? rnd(.8, 2.2) : rnd(3, 8); }
            else { a.st = 'idle'; a.until = rnd(1.5, 4); }
          }
          if (a.st === 'walk') {
            const sp = (a.k === 'cow' ? .2 : a.k === 'sheep' ? .28 : .75) * G.u / S.W, d = a.tx - a.nx;
            if (Math.abs(d) <= sp * dt * 1.5) { a.st = 'idle'; a.until = rnd(.8, 3); } else { a.nx += Math.sign(d) * sp * dt; a.dir = Math.sign(d); }
            a.ny += (a.ty - a.ny) * Math.min(1, dt * .4);
            a.ph += dt * (a.k === 'hen' ? 15 : a.k === 'sheep' ? 8 : 5);
          } else if (a.st === 'eat') a.ph += dt * 6;
          a.head += ((a.st === 'eat' && a.k !== 'hen' ? 1 : 0) - a.head) * Math.min(1, dt * 2.5);
        }
        // le tracteur, sur le chemin, de temps en temps
        if (!tr.on && T > tr.next) { tr.on = true; tr.dir = R() < .5 ? 1 : -1; tr.x = tr.dir > 0 ? -G.u * 1.6 : S.W + G.u * 1.6; tr.v = Math.max(40, S.W / rnd(17, 24)); }
        if (tr.on) {
          tr.x += tr.dir * tr.v * dt; tr.rot += tr.v * dt / (G.u * .8);
          if ((tr.puff -= dt) <= 0) { tr.puff = .32; smoke.push({ x: tr.x + tr.dir * G.u * .8 * .42, y: G.roadY - G.u * .8 * .95, t: 0 }); }
          if (tr.x < -G.u * 2 || tr.x > S.W + G.u * 2) { tr.on = false; tr.next = T + rnd(40, 80); }
        }
        for (let i = smoke.length - 1; i >= 0; i--) { const q = smoke[i]; q.t += dt; q.y -= G.u * .45 * dt; q.x -= tr.dir * G.u * .15 * dt; if (q.t > 1.8) smoke.splice(i, 1); }
      },
      draw(S, g) {
        const p = S.dark ? PAL.dusk : PAL.day, T = S.T, u = G.u;
        for (const q of smoke) { g.fillStyle = `rgba(${p.smoke},${(.45 * (1 - q.t / 1.8)).toFixed(3)})`; ell(g, q.x, q.y, u * (.07 + q.t * .12), u * (.07 + q.t * .12)); g.fill(); }
        if (tr.on) tractor(g, p, tr.x, G.roadY + u * .02, u * .8, tr.dir, tr.rot, T);
        rooster(g, p, G.rx, G.ry, u * .74, portrait || G.rx > S.W / 2 ? -1 : 1, T - crowT, T);
        const span = G.pBot - G.pTop;
        for (const a of herd.slice().sort((a, b) => a.ny - b.ny)) {
          const x = a.nx * S.W, y = G.pTop + a.ny * span, s = u * (.62 + .45 * a.ny);
          if (a.k === 'cow') cow(g, p, a, x, y, s * 1.05, T); else if (a.k === 'sheep') sheep(g, p, a, x, y, s * .78); else hen(g, p, a, x, y, s * .44, T);
        }
      },
      roll(S, tier, n, rank) {
        if (S.still || !(rank >= 4)) return;
        if (S.T - crowT > 2.4) crowT = S.T + .15;
        if (rank >= 6) for (const a of herd) if (a.k === 'hen') a.flapT = S.T + rnd(.2, .9);
      },
      debug(S, what) { if (what === 'crow') crowT = S.T; if (what === 'tractor') tr.next = 0; if (what === 'flap') for (const a of herd) if (a.k === 'hen') a.flapT = S.T; return { T: S.T, tr: tr.on }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * ⌨️ Keyboard ASMR (idée de kingston, 2026-11-01) : « un fond clavier, thème ASMR ». Un clavier mécanique compact aux
   * touches pastel bien bombées, posé sur un tapis de bureau, en bas de l'écran. Les touches s'enfoncent toutes seules
   * par petites rafales, comme quelqu'un qui tape doucement (descente rapide, remontée avec un léger rebond, un halo de
   * lumière sous la touche). Un clic sur le fond (jamais sur le jeu) enfonce la touche visée, ou la plus proche, avec un
   * « thock » feutré (js/sound.js « wallKey », seulement si le son est activé). Après un tirage, la rangée des chiffres
   * tape le nombre, puis Entrée. Le clavier entier est sur le canevas décor ; seules les touches qui bougent sont
   * redessinées par-dessus, et rien n'est redessiné quand rien ne bouge.
   */
  SCENES.keyboard = layer => {
    const ROWS = [
      [['Esc', 1, 'a'], '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', ['⌫', 2, 'm'], ['Del', 1, 'm']],
      [['Tab', 1.5, 'm'], 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', ['\\', 1.5, 'm'], ['PgUp', 1, 'm']],
      [['Caps', 1.75, 'm'], 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', '\'', ['Enter', 2.25, 'a'], ['PgDn', 1, 'm']],
      [['Shift', 2.25, 'm'], 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', ['Shift', 1.75, 'm'], ['↑', 1, 'p'], ['End', 1, 'm']],
      [['Ctrl', 1.25, 'm'], ['Fn', 1.25, 'm'], ['Alt', 1.25, 'm'], ['', 6.25, 'n'], ['Alt', 1, 'm'], ['Fn', 1, 'm'], ['Ctrl', 1, 'm'], ['←', 1, 'p'], ['↓', 1, 'p'], ['→', 1, 'p']],
    ];
    const keys = [];
    ROWS.forEach((row, r) => { let x = 0; for (const it of row) { const [label, w, kind] = Array.isArray(it) ? it : [it, 1, 'n']; keys.push({ r, x, w, label, kind, i: keys.length, t0: -9, hold: .07, p: 0, glow: 0, hue: 0 }); x += w; } });
    const byLabel = l => keys.find(k => k.label === l), rightOf = l => keys.filter(k => k.label === l).pop();
    const letters = keys.filter(k => /^[A-Z]$/.test(k.label)), space = keys.find(k => k.w > 6), back = byLabel('⌫'), enter = byLabel('Enter');
    const PAL = {
      light: { case: '#efe9f5', case2: '#ddd3ea', edge: 'rgba(255,255,255,.8)', plate: '#b3a8c6', shadow: 'rgba(90,70,120,.28)', glowA: .22, ink: 'source-over',
        n: ['#fffbf3', '#f3eadb', '#dcd0bc', '#ada3bd'], m: ['#dcd1f1', '#cbbfe6', '#a998cb', '#7d70a0'], a: ['#bfe9d8', '#a6dcc7', '#7fbca5', '#4f8a76'], p: ['#fad2c1', '#f3bfaa', '#d79c86', '#a86a56'] },
      dark: { case: '#2b2839', case2: '#1f1c2a', edge: 'rgba(255,255,255,.08)', plate: '#100e17', shadow: 'rgba(0,0,0,.55)', glowA: .5, ink: 'lighter',
        n: ['#423d52', '#36323f', '#24212d', '#bfb4e0'], m: ['#4e4666', '#423b57', '#2d2840', '#efc3d7'], a: ['#437868', '#386458', '#264740', '#d2f1e5'], p: ['#71524c', '#634641', '#45302c', '#f7d3c6'] },
    };
    let k = 40, kw = 0, kh = 0, pad = 0, cx = 0, cy = 0, ang = 0;
    const active = new Set(), queue = [];
    let nextBurst = rnd(.6, 1.5), hue0 = rnd(0, 360), was = false;
    const geo = key => { const gap = k * .055; return { x: pad + key.x * k + gap, y: pad + key.r * k + gap, w: key.w * k - gap * 2, h: k - gap * 2 }; };
    // une touche : la jupe (le flanc, vu un peu de face), puis le dessus bombé ; p = enfoncement (0 à 1, un peu moins de 0 au rebond)
    function cap(g, c, key, p) {
      const { x, y, w, h } = geo(key), col = c[key.kind], dy = p * k * .065, sh = Math.max(0, p) * k * .025;
      rr(g, x + sh, y + dy + sh, w - sh * 2, h - sh * 1.6, k * .13); g.fillStyle = col[2]; g.fill();
      const tx = x + k * .1 + sh * .4, ty = y + k * .05 + dy + sh * .5, tw = w - k * .2 - sh * .8, th = h - k * .05 - k * (.19 - Math.max(0, p) * .07) - sh;
      const gr = g.createLinearGradient(0, ty, 0, ty + th); gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]);
      rr(g, tx, ty, tw, th, k * .11); g.fillStyle = gr; g.fill();
      if (p > 0) { g.fillStyle = `rgba(0,0,0,${(.07 * p).toFixed(3)})`; g.fill(); }
      if (key.label) {
        g.fillStyle = col[3]; g.textBaseline = 'middle';
        const big = /^[A-Z0-9]$/.test(key.label) || key.label.length === 1;
        g.font = `600 ${(big ? k * .27 : k * .17).toFixed(1)}px system-ui, -apple-system, Segoe UI, sans-serif`;
        if (big) { g.textAlign = 'center'; g.fillText(key.label, tx + tw / 2, ty + th * .48); } else { g.textAlign = 'left'; g.fillText(key.label, tx + k * .08, ty + th * .36); }
      }
    }
    function press(key, user) {
      key.t0 = st.S.T; key.hold = user ? .06 : rnd(.05, .1); key.hue = (hue0 += 23) % 360; active.add(key); st.S.dirty = true;
      if (user && root.Sound) root.Sound.play('wallKey', { k: key.i % 6, big: key.w >= 2 ? 1 : 0 });
    }
    function burst(S) {
      let t = S.T + rnd(0, .2);
      for (let i = 0, n = Math.floor(rnd(2, 7)); i < n; i++) { queue.push({ key: pick(letters), at: t }); t += rnd(.08, .21); }
      if (Math.random() < .7) { queue.push({ key: space, at: t + rnd(.04, .12) }); t += .2; }
      if (Math.random() < .12) { queue.push({ key: back, at: t + .35 }, { key: back, at: t + .52 }); t += .6; }
      nextBurst = t + rnd(1.2, 3.4);
    }
    // le point de l'écran (x, y) dans le repère du clavier, et la touche visée (ou la plus proche)
    function keyAt(px, py) {
      const dx = px - cx, dy = py - cy, cs = Math.cos(-ang), sn = Math.sin(-ang);
      const lx = dx * cs - dy * sn + kw / 2, ly = dx * sn + dy * cs + kh / 2;
      let best = null, bd = Infinity;
      for (const key of keys) {
        const b = geo(key);
        if (lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) return key;
        const d = Math.hypot(lx - (b.x + b.w / 2), ly - (b.y + b.h / 2)) - b.w / 2;
        if (d < bd) { bd = d; best = key; }
      }
      return best;
    }
    const onDown = e => {
      if (e.button > 0 || !layer.classList.contains('wp-keyboard') || !onBackground(e.target)) return;
      const key = keyAt(e.clientX, e.clientY);
      if (!key) return;
      press(key, true);
      if (st.S.still) { key.p = 1; st.redraw(); setTimeout(() => { key.p = 0; active.delete(key); st.redraw(); }, 150); }
    };
    doc.addEventListener('pointerdown', onDown);
    // Les vraies touches aussi (LEVIATHAN, 2026-11-02 : « pas de son quand on appuie sur les touches ») : la touche
    // correspondante s'enfonce avec son « thock ». Toutes les touches (Infin6, 2026-11-02 : « press any keys you press, not
    // just when you click ») : même en écrivant dans le chat, avec Ctrl/Cmd, Maj et les symboles (lus sur la position de
    // la touche, e.code : Maj+1 enfonce le 1, et un clavier AZERTY aussi), et la touche reste enfoncée tant qu'on la tient.
    // Jamais dans un champ de mot de passe : le fond montrerait les lettres tapées.
    const KEYMAP = { ' ': space, Backspace: back, Enter: enter, Escape: byLabel('Esc'), Tab: byLabel('Tab'), Delete: byLabel('Del'), Insert: byLabel('Del'), CapsLock: byLabel('Caps'), ArrowUp: byLabel('↑'), ArrowDown: byLabel('↓'), ArrowLeft: byLabel('←'), ArrowRight: byLabel('→'), PageUp: byLabel('PgUp'), PageDown: byLabel('PgDn'), Home: byLabel('PgUp'), End: byLabel('End') };
    const CODEMAP = { ShiftLeft: byLabel('Shift'), ShiftRight: rightOf('Shift'), ControlLeft: byLabel('Ctrl'), ControlRight: rightOf('Ctrl'), AltLeft: byLabel('Alt'), AltRight: rightOf('Alt'), MetaLeft: byLabel('Fn'), MetaRight: rightOf('Fn'), Backquote: byLabel('Esc'),
      Minus: byLabel('-'), Equal: byLabel('='), BracketLeft: byLabel('['), BracketRight: byLabel(']'), Backslash: byLabel('\\'), Semicolon: byLabel(';'), Quote: byLabel('\''), Comma: byLabel(','), Period: byLabel('.'), Slash: byLabel('/'), NumpadEnter: enter };
    const keyOf = e => {
      const c = e.code || '', d = /^(?:Digit|Numpad)(\d)$/.exec(c) || /^F(\d{1,2})$/.exec(c); // F1…F12 : la rangée des chiffres (couche Fn d'un clavier compact)
      if (/^[a-z]$/i.test(e.key || '')) return byLabel(e.key.toUpperCase()); // une lettre : celle qu'on a tapée (QWERTY ou AZERTY)
      return KEYMAP[e.key] || CODEMAP[c] || (d ? byLabel(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='][Number(d[1])]) : null) || (/^Key([A-Z])$/.test(c) ? byLabel(c.slice(3)) : null);
    };
    const held = new Map(); // code de la touche physique → touche dessinée, tant qu'elle est tenue
    const release = key => { if (!key || !key.down) return; key.down = false; key.hold = Math.max(.02, st.S.T - key.t0 - .045); if (st.S.still) { key.p = 0; active.delete(key); st.redraw(); } else st.S.dirty = true; };
    const onKey = e => {
      if (e.repeat || !layer.classList.contains('wp-keyboard')) return;
      const t = e.target;
      if (t && t.tagName === 'INPUT' && t.type === 'password') return;
      const key = keyOf(e);
      if (!key) return;
      held.set(e.code || e.key, key);
      press(key, true); key.down = true;
      if (st.S.still) { key.p = 1; st.redraw(); }
    };
    const onKeyUp = e => { const k = e.code || e.key, key = held.get(k); held.delete(k); release(key); };
    const releaseAll = () => { for (const key of held.values()) release(key); held.clear(); };
    // en capture : une touche que le jeu arrête en route (Espace sur le bouton de tirage…) s'enfonce quand même ici
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('keyup', onKeyUp, true);
    root.addEventListener('blur', releaseAll);
    const st = stage(layer, 'wkb', {
      lazy: true,
      layout(S) {
        const W = S.W, H = S.H, portrait = H > W;
        // sur un téléphone, un gros plan (les côtés sortent de l'écran, comme dans les vidéos ASMR) plutôt qu'un clavier minuscule
        k = Math.max(Math.min(W * .95 / 16.7, 54, H * .085), Math.min(34, H * .05));
        kw = 16.7 * k; kh = 5.7 * k; pad = .35 * k;
        cx = W / 2; cy = H - Math.max(14, H * .05) - kh / 2; ang = portrait ? 0 : -.028;
        S.fgTop = Math.max(0, Math.floor(cy - kh / 2 - k * 1.6));
      },
      paint(S, g) {
        const c = S.dark ? PAL.dark : PAL.light;
        // l'ombre douce sous le clavier, puis la lumière d'ambiance (sombre : un liseré pastel)
        const sg = g.createRadialGradient(cx, cy + kh * .25, kw * .1, cx, cy + kh * .25, kw * .62);
        sg.addColorStop(0, c.shadow); sg.addColorStop(1, 'rgba(0,0,0,0)');
        g.save(); g.translate(cx, cy + kh * .28); g.scale(1, .32); g.translate(-cx, -(cy + kh * .28)); g.fillStyle = sg; g.fillRect(cx - kw, cy - kw, kw * 2, kw * 2); g.restore();
        g.save(); g.translate(cx, cy); g.rotate(ang); g.translate(-kw / 2, -kh / 2);
        if (S.dark) { g.shadowColor = 'rgba(167,139,250,.35)'; g.shadowBlur = k * .8; }
        rr(g, 0, 0, kw, kh, k * .36);
        const cg = g.createLinearGradient(0, 0, 0, kh); cg.addColorStop(0, c.case); cg.addColorStop(1, c.case2);
        g.fillStyle = cg; g.fill(); g.shadowBlur = 0; g.shadowColor = 'transparent';
        g.strokeStyle = c.edge; g.lineWidth = Math.max(1, k * .03); rr(g, k * .02, k * .02, kw - k * .04, kh - k * .04, k * .34); g.stroke();
        rr(g, pad * .7, pad * .7, kw - pad * 1.4, kh - pad * 1.4, k * .12); g.fillStyle = c.plate; g.fill();
        for (const key of keys) cap(g, c, key, 0);
        g.restore();
      },
      update(S, dt) {
        if (!queue.length && S.T > nextBurst) burst(S);
        while (queue.length && queue[0].at <= S.T) press(queue.shift().key, false);
        for (const key of active) {
          if (key.down) key.hold = Math.max(key.hold, S.T - key.t0 - .045); // tenue : reste en bas jusqu'au relâchement
          const t = S.T - key.t0, up = (t - .045 - key.hold) / .17;
          key.p = t < .045 ? easeOut(t / .045) : up < 0 ? 1 : up < 1 ? 1 - easeOut(up) - .14 * Math.sin(up * Math.PI) : 0;
          key.glow = Math.exp(-t / .45);
          if (t > 1.8 + key.hold && !key.down) { key.p = 0; key.glow = 0; active.delete(key); }
        }
        S.dirty = active.size > 0 || was;
        was = active.size > 0;
      },
      draw(S, g) {
        if (!active.size) return;
        const c = S.dark ? PAL.dark : PAL.light;
        g.save(); g.translate(cx, cy); g.rotate(ang); g.translate(-kw / 2, -kh / 2);
        for (const key of active) {
          const b = geo(key);
          if (key.glow > .02 && !S.still) {
            const mx = b.x + b.w / 2, my = b.y + b.h / 2, R = Math.max(b.w, b.h) * .5 + k * .6;
            const gr = g.createRadialGradient(mx, my, Math.min(b.w, b.h) * .3, mx, my, R);
            gr.addColorStop(0, `hsla(${key.hue},85%,72%,${(c.glowA * key.glow).toFixed(3)})`); gr.addColorStop(1, `hsla(${key.hue},85%,72%,0)`);
            g.globalCompositeOperation = c.ink; g.fillStyle = gr; g.fillRect(mx - R, my - R, R * 2, R * 2); g.globalCompositeOperation = 'source-over';
          }
          const gap = k * .03;
          rr(g, b.x - gap, b.y - gap, b.w + gap * 2, b.h + gap * 2, k * .14); g.fillStyle = c.plate; g.fill();
          cap(g, c, key, key.p);
        }
        g.restore();
      },
      roll(S, tier, n) {
        if (S.still || !Number.isFinite(n)) return;
        queue.length = 0;
        let t = S.T + .25;
        for (const ch of String(Math.max(0, Math.floor(n))).padStart(6, '0')) { queue.push({ key: byLabel(ch), at: t }); t += .13; }
        queue.push({ key: enter, at: t + .12 });
        nextBurst = t + 2.2;
      },
      stop() { doc.removeEventListener('pointerdown', onDown); doc.removeEventListener('keydown', onKey, true); doc.removeEventListener('keyup', onKeyUp, true); root.removeEventListener('blur', releaseAll); },
      debug(S, what) { if (what === 'type') { burst(S); } if (what && what.at) { const key = keyAt(what.at[0], what.at[1]); if (key) press(key, true); return key && key.label; } return { active: active.size, keys: [...active].map(k => k.label + (k.down ? '↓' : '')) }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * ⛈️ Thunderstorm (idée de finnnnn, 2026-11-01), assorti au skin Storm : « pas fort, plutôt calme, un ou deux éclairs
   * toutes les 10 s environ ». Une plaine sous un plafond de nuages lourds (deux couches qui glissent à des vitesses
   * différentes), une pluie fine en biais, une petite maison à la fenêtre allumée. Toutes les 8,5 à 13 s, un éclair au
   * loin, sur un côté (jamais derrière le nombre), parfois suivi d'un second plus faible ; puis un roulement de tonnerre
   * grave et bas (js/sound.js « thunder », seulement si le son est activé), une à trois secondes plus tard.
   * Photosensibilité : pas de stroboscope. Chaque éclair est UNE lueur douce (montée en 90 ms, extinction en ~0,5 s,
   * jamais de clignotement), qui éclaire surtout les nuages autour de l'éclair ; le voile sur tout le ciel reste très
   * faible ; au plus deux lueurs par épisode, au moins 0,7 s d'écart. En mouvement réduit ou en mode performance : aucun
   * éclair, une image fixe de pluie sous les nuages.
   */
  SCENES.thunderstorm = layer => {
    const R = Math.random;
    let G = {}, far = null, near = null, drops = [], bolts = [], nextStrike = rnd(3, 5), second = 0, thunderAt = 0;
    const PAL = {
      dark: { far: [30, 38, 56], near: [16, 21, 34], under: [52, 64, 92], rain: ['rgba(186,230,253,.16)', 'rgba(186,230,253,.28)'], hill: '#111827', hill2: '#0c121d', ground: '#090d16', house: '#0b0f18', win: '#fcd34d', glow: [190, 215, 255], veil: .05, lit: .32 },
      light: { far: [163, 173, 189], near: [141, 152, 169], under: [198, 206, 218], rain: ['rgba(51,65,85,.16)', 'rgba(51,65,85,.26)'], hill: '#7b8786', hill2: '#6d7978', ground: '#65716f', house: '#4b5563', win: '#fcd34d', glow: [255, 255, 255], veil: .1, lit: .3 },
    };
    // une bande de nuages, peinte une fois dans un canevas hors écran, qui boucle sur sa largeur
    // Des nappes aplaties (stratus d'orage) plutôt que des boules : chaque tache est un dégradé écrasé en hauteur, peu
    // opaque, et c'est leur empilement qui fait la masse ; le bas de la bande est toujours fondu.
    function strip(rgb, under, seed, baseY, blobs, big) {
      const r = seeded(seed), w = Math.ceil(G.W * 1.6), h = Math.ceil(baseY + G.H * big * .9), cv = doc.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      for (let i = 0; i < blobs; i++) {
        const x = r() * w, y = baseY * (.1 + .9 * Math.pow(r(), .5)), rad = G.H * big * (.6 + r() * .8), sq = .32 + r() * .2;
        // le dessous des nuages un peu plus clair : la lumière de la ville au loin
        const k = clamp((y - baseY * .5) / (baseY * .5), 0, 1), col = rgb.map((v, j) => Math.round(v + (under[j] - v) * k * .5));
        for (const ox of [x - w, x, x + w]) {
          if (ox + rad < 0 || ox - rad > w) continue;
          g.save(); g.translate(ox, y); g.scale(1, sq);
          const gr = g.createRadialGradient(0, 0, 0, 0, 0, rad);
          gr.addColorStop(0, `rgba(${col},.5)`); gr.addColorStop(.5, `rgba(${col},.28)`); gr.addColorStop(1, `rgba(${col},0)`);
          g.fillStyle = gr; g.fillRect(-rad, -rad, rad * 2, rad * 2); g.restore();
        }
      }
      // le haut de l'écran reste couvert
      const top = g.createLinearGradient(0, 0, 0, baseY * .7); top.addColorStop(0, `rgba(${rgb},.95)`); top.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = top; g.fillRect(0, 0, w, baseY * .7);
      g.globalCompositeOperation = 'destination-out';
      const fade = g.createLinearGradient(0, h - G.H * .12, 0, h); fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
      g.fillStyle = fade; g.fillRect(0, h - G.H * .12, w, G.H * .12);
      return { cv, w, h };
    }
    // un trait d'éclair : déplacement du point milieu, de plus en plus fin
    function jag(x0, y0, x1, y1, depth, disp) {
      let pts = [[x0, y0], [x1, y1]];
      for (let d = 0; d < depth; d++, disp *= .55) {
        const out = [pts[0]];
        for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; out.push([(ax + bx) / 2 + rnd(-disp, disp), (ay + by) / 2 + rnd(-disp, disp) * .3], [bx, by]); }
        pts = out;
      }
      return pts;
    }
    function strike(S, power) {
      const left = R() < .5, y0 = G.base - S.H * rnd(.02, .06), y1 = G.hz + S.H * rnd(-.01, .012);
      let x0 = S.W * (left ? rnd(.05, .27) : rnd(.73, .95)), x1 = x0 + S.W * rnd(-.05, .05);
      // jamais sur la petite maison : l'éclair tombe au loin, à côté
      const hx = S.W * (S.W > S.H ? .84 : .74) + Math.min(S.W, S.H) * .025;
      if (Math.abs(x1 - hx) < S.W * .08) { const d = x1 < hx ? -S.W * .1 : S.W * .1; x0 += d; x1 += d; }
      const main = jag(x0, y0, x1, y1, 6, S.W * .045), segs = [main];
      for (let b = 0, n = 1 + Math.floor(R() * 3); b < n; b++) {
        const i = Math.floor(rnd(.15, .6) * main.length), [bx, by] = main[i];
        segs.push(jag(bx, by, bx + S.W * rnd(-.08, .08), by + (y1 - by) * rnd(.3, .6), 4, S.W * .02));
      }
      bolts.push({ segs, t0: S.T, x: x0, power });
    }
    const boltA = t => (t < .05 ? t / .05 : Math.exp(-(t - .05) / .16));
    const flashA = t => (t < .09 ? t / .09 : Math.exp(-(t - .09) / .4));
    const st = stage(layer, 'wts', {
      layout(S) {
        const portrait = S.H > S.W;
        G = { W: S.W, H: S.H, hz: S.H * (portrait ? .82 : .8), base: S.H * (portrait ? .3 : .36) };
        const p = S.dark ? PAL.dark : PAL.light;
        far = strip(p.far, p.under, 5, G.base, Math.round(S.W / 22) + 26, .16);
        near = strip(p.near, p.under, 9, G.base * .7, Math.round(S.W / 40) + 14, .11);
        const n = Math.round(Math.min(170, S.W * S.H / 8500));
        if (drops.length !== n) drops = Array.from({ length: n }, () => ({ x: R() * (S.W + 200) - 100, y: R() * S.H, l: rnd(10, 22), v: rnd(520, 860), b: R() < .3 ? 1 : 0 }));
      },
      paint(S, g) {
        const p = S.dark ? PAL.dark : PAL.light, { W, H, hz } = G, u = Math.min(W, H) / 100;
        // des collines basses au loin, le sol, un arbre seul et une petite maison à la fenêtre allumée
        g.fillStyle = p.hill; g.beginPath(); g.moveTo(0, H);
        for (let x = 0; x <= W + 10; x += 10) g.lineTo(x, hz - u * (2.2 + 1.6 * Math.sin(x / W * 5 + 1) + .8 * Math.sin(x / W * 13)));
        g.lineTo(W, H); g.fill();
        g.fillStyle = p.hill2; g.beginPath(); g.moveTo(0, H);
        for (let x = 0; x <= W + 10; x += 10) g.lineTo(x, hz + u * (.4 + 1.1 * Math.sin(x / W * 3.4 + 2.2)));
        g.lineTo(W, H); g.fill();
        g.fillStyle = p.ground; g.fillRect(0, hz + u * 2, W, H);
        const hx = W * (W > H ? .84 : .74), hy = hz + u * (.4 + 1.1 * Math.sin(hx / W * 3.4 + 2.2)) + u * .6;
        g.fillStyle = p.house; g.fillRect(hx, hy - u * 3, u * 5, u * 3);
        g.beginPath(); g.moveTo(hx - u * .6, hy - u * 3); g.lineTo(hx + u * 2.5, hy - u * 5.2); g.lineTo(hx + u * 5.6, hy - u * 3); g.fill();
        g.fillRect(hx + u * 3.6, hy - u * 5.4, u * .7, u * 1.6);
        const wg = g.createRadialGradient(hx + u * 1.5, hy - u * 1.6, 0, hx + u * 1.5, hy - u * 1.6, u * 4);
        wg.addColorStop(0, 'rgba(252,211,77,.28)'); wg.addColorStop(1, 'rgba(252,211,77,0)');
        g.fillStyle = wg; g.fillRect(hx - u * 3, hy - u * 6, u * 9, u * 9);
        g.fillStyle = p.win; g.fillRect(hx + u * 1, hy - u * 2.1, u * 1, u * 1);
        const tx = W * (W > H ? .12 : .16), ty = hz - u * 1.4;
        g.strokeStyle = p.house; g.lineWidth = u * .5; g.lineCap = 'round'; g.beginPath(); g.moveTo(tx, ty + u * 2); g.lineTo(tx, ty - u * 2); g.stroke();
        g.fillStyle = p.house; ell(g, tx, ty - u * 3.4, u * 2.4, u * 2.2); g.fill(); ell(g, tx - u * 1.6, ty - u * 2.3, u * 1.4, u * 1.2); g.fill(); ell(g, tx + u * 1.6, ty - u * 2.2, u * 1.5, u * 1.2); g.fill();
      },
      update(S, dt) {
        if (S.T >= nextStrike) { strike(S, 1); second = R() < .45 ? S.T + rnd(.7, 1.3) : 0; thunderAt = S.T + rnd(1.2, 3); nextStrike = S.T + rnd(8.5, 13); }
        if (second && S.T >= second) { strike(S, .6); second = 0; }
        if (thunderAt && S.T >= thunderAt) { thunderAt = 0; if (root.Sound) root.Sound.play('thunder', { k: Math.floor(R() * 3) }); }
        for (let i = bolts.length - 1; i >= 0; i--) if (S.T - bolts[i].t0 > 2) bolts.splice(i, 1);
        for (const d of drops) { d.y += d.v * dt; d.x += d.v * .2 * dt; if (d.y - d.l > S.H) { d.y = -rnd(0, 60); d.x = R() * (S.W + 200) - 200; } }
      },
      draw(S, g) {
        const p = S.dark ? PAL.dark : PAL.light;
        const tile = (s, speed) => { const o = ((S.T * speed) % s.w + s.w) % s.w; g.drawImage(s.cv, -o, 0); g.drawImage(s.cv, s.w - o, 0); };
        tile(far, 5); tile(near, 11);
        // la lueur : les nuages s'éclairent autour de l'éclair (source-atop : seulement là où il y a du nuage), puis un
        // voile très léger sur tout le ciel
        let f = 0, fx = S.W / 2;
        for (const b of bolts) { const a = flashA(S.T - b.t0) * b.power; if (a > f) { f = a; fx = b.x; } }
        if (f > .005) {
          g.globalCompositeOperation = 'source-atop';
          const gr = g.createRadialGradient(fx, G.base * .8, 0, fx, G.base * .8, S.W * .55);
          gr.addColorStop(0, `rgba(${p.glow},${(p.lit * f).toFixed(3)})`); gr.addColorStop(1, `rgba(${p.glow},0)`);
          g.fillStyle = gr; g.fillRect(0, 0, S.W, G.base * 1.4);
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = `rgba(${p.glow},${(p.veil * f).toFixed(3)})`; g.fillRect(0, 0, S.W, S.H);
        }
        g.lineJoin = 'round'; g.lineCap = 'round';
        for (const b of bolts) {
          const a = boltA(S.T - b.t0) * b.power;
          if (a < .01) continue;
          b.segs.forEach((pts, i) => {
            const line = () => { g.beginPath(); pts.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); };
            // clair : un liseré gris ardoise autour du trait blanc, sinon il disparaît sur le ciel gris
            line(); g.strokeStyle = S.dark ? `rgba(125,211,252,${(.22 * a).toFixed(3)})` : `rgba(51,65,85,${(.3 * a).toFixed(3)})`; g.lineWidth = i ? 3 : S.dark ? 6 : 4; g.stroke();
            line(); g.strokeStyle = `rgba(${S.dark ? '240,251,255' : '255,255,255'},${((i ? .6 : .95) * a).toFixed(3)})`; g.lineWidth = i ? .9 : S.dark ? 1.6 : 1.9; g.stroke();
          });
        }
        // la pluie : deux épaisseurs, chacune en un seul tracé
        for (const b of [0, 1]) {
          g.strokeStyle = p.rain[b]; g.lineWidth = b ? 1.3 : 1; g.beginPath();
          for (const d of drops) if (d.b === b) { g.moveTo(d.x, d.y); g.lineTo(d.x - d.l * .2, d.y - d.l); }
          g.stroke();
        }
      },
      debug(S, what) { if (what === 'strike') nextStrike = S.T; return { T: S.T, next: nextStrike, bolts: bolts.length }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🪐 Solar System (idée de finnnnn, 2026-11-01) : « des étoiles qui tournent les unes autour des autres, comme le
   * système solaire ». Un soleil, huit planètes sur des orbites lumineuses vues un peu de biais (les plus proches du
   * soleil tournent plus vite, comme pour de vrai), la Lune autour de la Terre, l'anneau de Saturne, et de temps en temps
   * une comète qui passe près du soleil, sa queue toujours à l'opposé de lui. Le soleil est sous le milieu de l'écran,
   * derrière les cartes du jeu, jamais derrière le nombre. Thème sombre : l'espace profond. Thème clair : une carte du
   * ciel ancienne sur papier, orbites en pointillés à l'encre (.wp-solarsystem en CSS).
   * Retouches de deadshot44474 (2026-11-05) : la ceinture d'astéroïdes entre Mars et Jupiter, Cérès dedans avec sa tache
   * claire (le cratère Occator, une lueur bleutée qui passe avec sa rotation), Pluton sur son orbite excentrique et
   * inclinée (elle mord sur celle de Neptune, comme la vraie), la queue de la comète qui suit sa trajectoire au lieu de
   * pointer droit à l'opposé du soleil (« it looks weird »), et plus aucune orbite qui passe sur le soleil (« the sun is
   * over the line » : en paysage, l'orbite de Mercure était plus basse que le rayon du soleil).
   */
  SCENES.solarsystem = layer => {
    const PL = [
      { r: .75, c: ['#d8d0c6', '#6f665e'] }, { r: 1.2, c: ['#f4dfb0', '#a37f47'] }, { r: 1.3, c: ['#86bdf3', '#1f4f8f'], moon: 1 },
      { r: .95, c: ['#f0a07a', '#963c25'] }, { r: 2.8, c: ['#eed6b3', '#956743'], bands: 1 }, { r: 2.3, c: ['#f2e2b4', '#a2864f'], ring: 1 },
      { r: 1.7, c: ['#c2f0f3', '#4b97a2'] }, { r: 1.65, c: ['#8aa6f3', '#283d98'] },
    ].map(p => Object.assign(p, { th: rnd(0, Math.PI * 2) }));
    // Pluton : orbite plus grande, décalée (excentrique) et penchée ; Cérès et ~260 cailloux dans la ceinture.
    const PLUTO = { r: .75, c: ['#eadbc6', '#8b7461'], th: rnd(0, Math.PI * 2), tilt: .2 };
    const CERES = { r: .7, th: rnd(0, Math.PI * 2), spin: rnd(0, Math.PI * 2) };
    const BELT = Array.from({ length: 260 }, () => ({ f: Math.random(), th: rnd(0, Math.PI * 2), z: Math.pow(Math.random(), 2.2), tone: Math.random() }));
    let G = {}, comet = null, nextComet = rnd(6, 10);
    const tw = twinklers(26, 1);
    const INK = '#3b4a6b';
    const pos = (p, th) => ({ x: G.cx + p.a * Math.cos(th), y: G.cy + p.a * G.e * Math.sin(th), k: 1 + .1 * Math.sin(th) });
    // Pluton : l'ellipse décalée de off le long de son grand axe, puis penchée de tilt autour du soleil
    const plutoPos = th => {
      const lx = PLUTO.a * Math.cos(th) + PLUTO.off, ly = PLUTO.a * G.e * 1.1 * Math.sin(th), c = Math.cos(PLUTO.tilt), sn = Math.sin(PLUTO.tilt);
      return { x: G.cx + lx * c - ly * sn, y: G.cy + lx * sn + ly * c, k: 1 + .1 * Math.sin(th) };
    };
    // Cérès : une petite sphère grise ; la tache d'Occator tourne avec elle (visible sur la face avant), et luit en sombre.
    function ceres(g, S, P) {
      const r = Math.max(2.2, CERES.r * G.u * P.k), dx = G.cx - P.x, dy = G.cy - P.y, d = Math.hypot(dx, dy) || 1;
      const gr = g.createRadialGradient(P.x + dx / d * r * .45, P.y + dy / d * r * .45, r * .1, P.x, P.y, r * 1.05);
      gr.addColorStop(0, S.dark ? '#c9c4bc' : '#d6d1c9'); gr.addColorStop(1, S.dark ? '#3c3934' : '#7d776f');
      ell(g, P.x, P.y, r, r); g.fillStyle = gr; g.fill();
      if (!S.dark) { g.strokeStyle = INK; g.lineWidth = 1; g.stroke(); }
      const a = CERES.spin + S.T * .7, face = Math.cos(a);
      if (face > -.2) {
        const sx = P.x + Math.sin(a) * r * .55, sy = P.y - r * .18, sr = Math.max(.9, r * .2) * (.6 + .4 * Math.max(0, face)), lit = clamp(face + .2, 0, 1);
        if (S.dark) {
          const hg = g.createRadialGradient(sx, sy, 0, sx, sy, sr * 4.5);
          hg.addColorStop(0, `rgba(170,225,255,${(.75 * lit).toFixed(3)})`); hg.addColorStop(1, 'rgba(170,225,255,0)');
          g.globalCompositeOperation = 'lighter'; g.fillStyle = hg; g.fillRect(sx - sr * 4.5, sy - sr * 4.5, sr * 9, sr * 9); g.globalCompositeOperation = 'source-over';
        }
        ell(g, sx, sy, sr, sr * .8); g.fillStyle = S.dark ? `rgba(235,250,255,${lit.toFixed(3)})` : `rgba(56,152,214,${(.9 * lit).toFixed(3)})`; g.fill();
      }
    }
    // la ceinture : des cailloux qui tournent à la vitesse de leur distance (Kepler, comme les planètes)
    function belt(g, S) {
      const dk = S.dark;
      for (const b of BELT) {
        const a = G.b0 + (G.b1 - G.b0) * b.f, x = G.cx + a * Math.cos(b.th), y = G.cy + a * G.e * Math.sin(b.th), s = Math.max(.8, G.u * (.1 + .22 * b.z)) * (1 + .1 * Math.sin(b.th));
        g.fillStyle = dk ? `rgba(${b.tone < .5 ? '214,204,186' : '170,160,150'},${(.45 + .4 * b.z).toFixed(2)})` : `rgba(59,74,107,${(.35 + .4 * b.z).toFixed(2)})`;
        g.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    function planet(g, S, p, P) {
      const r = Math.max(2, p.r * G.u * P.k), dx = G.cx - P.x, dy = G.cy - P.y, d = Math.hypot(dx, dy) || 1, lx = dx / d, ly = dy / d;
      if (p.ring) { g.strokeStyle = S.dark ? 'rgba(232,214,166,.7)' : 'rgba(162,134,79,.8)'; g.lineWidth = r * .32; ell(g, P.x, P.y, r * 2.1, r * .62, -.18); g.save(); g.beginPath(); g.rect(P.x - r * 3, P.y - r * 2, r * 6, r * 2); g.clip(); ell(g, P.x, P.y, r * 2.1, r * .62, -.18); g.stroke(); g.restore(); }
      const gr = g.createRadialGradient(P.x + lx * r * .45, P.y + ly * r * .45, r * .1, P.x, P.y, r * 1.05);
      gr.addColorStop(0, p.c[0]); gr.addColorStop(.6, mixHex(p.c[0], p.c[1], .5)); gr.addColorStop(1, S.dark ? mixHex(p.c[1], '#05060f', .55) : p.c[1]);
      ell(g, P.x, P.y, r, r); g.fillStyle = gr; g.fill();
      if (p.bands) { g.save(); ell(g, P.x, P.y, r, r); g.clip(); g.fillStyle = 'rgba(150,95,55,.35)'; for (const o of [-.45, -.05, .35]) g.fillRect(P.x - r, P.y + o * r, r * 2, r * .16); g.restore(); }
      if (!S.dark) { ell(g, P.x, P.y, r, r); g.strokeStyle = INK; g.lineWidth = 1; g.stroke(); }
      if (p.ring) { g.save(); g.beginPath(); g.rect(P.x - r * 3, P.y, r * 6, r * 2); g.clip(); ell(g, P.x, P.y, r * 2.1, r * .62, -.18); g.strokeStyle = S.dark ? 'rgba(232,214,166,.75)' : 'rgba(162,134,79,.85)'; g.lineWidth = r * .32; g.stroke(); g.restore(); }
      if (p.moon) {
        const m = S.T * 1.3, mx = P.x + Math.cos(m) * r * 2.4, my = P.y + Math.sin(m) * r * 1.1;
        if (Math.sin(m) < 0) { g.globalCompositeOperation = 'destination-over'; }
        ell(g, mx, my, Math.max(1.2, r * .3), Math.max(1.2, r * .3)); g.fillStyle = S.dark ? '#cfd3da' : '#9aa1ad'; g.fill();
        g.globalCompositeOperation = 'source-over';
      }
    }
    function sun(g, S) {
      const R0 = G.sun;
      if (S.dark) {
        const k = 1 + .04 * Math.sin(S.T * .7);
        const co = g.createRadialGradient(G.cx, G.cy, R0 * .6, G.cx, G.cy, R0 * 3.4 * k);
        co.addColorStop(0, 'rgba(255,224,150,.55)'); co.addColorStop(.35, 'rgba(255,170,70,.16)'); co.addColorStop(1, 'rgba(255,150,60,0)');
        g.fillStyle = co; g.fillRect(G.cx - R0 * 4, G.cy - R0 * 4, R0 * 8, R0 * 8);
        const core = g.createRadialGradient(G.cx - R0 * .2, G.cy - R0 * .2, R0 * .1, G.cx, G.cy, R0);
        core.addColorStop(0, '#fffdf0'); core.addColorStop(.6, '#ffd56b'); core.addColorStop(1, '#f59e0b');
        ell(g, G.cx, G.cy, R0, R0); g.fillStyle = core; g.fill();
      } else {
        g.strokeStyle = INK; g.globalAlpha = .55; g.lineWidth = 1.2;
        for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8 + S.T * .04; g.beginPath(); g.moveTo(G.cx + Math.cos(a) * R0 * 1.3, G.cy + Math.sin(a) * R0 * 1.3); g.lineTo(G.cx + Math.cos(a) * R0 * (i % 2 ? 1.55 : 1.8), G.cy + Math.sin(a) * R0 * (i % 2 ? 1.55 : 1.8)); g.stroke(); }
        g.globalAlpha = 1;
        const core = g.createRadialGradient(G.cx - R0 * .2, G.cy - R0 * .2, R0 * .1, G.cx, G.cy, R0);
        core.addColorStop(0, '#ffe7a3'); core.addColorStop(1, '#f2a93b');
        ell(g, G.cx, G.cy, R0, R0); g.fillStyle = core; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.2; g.stroke();
      }
    }
    // la comète : une courbe qui passe près du soleil ; la queue de poussière (large) et la queue d'ions (fine, bleue)
    function newComet(S) {
      const a = rnd(0, Math.PI * 2), D = Math.max(S.W, S.H) * .75, b = a + Math.PI + rnd(-.7, .7), side = Math.random() < .5 ? 1 : -1;
      const p0 = [G.cx + Math.cos(a) * D, G.cy + Math.sin(a) * D * .7], p2 = [G.cx + Math.cos(b) * D, G.cy + Math.sin(b) * D * .7];
      const mx = (p0[0] + p2[0]) / 2, my = (p0[1] + p2[1]) / 2, nx = -(p2[1] - p0[1]), ny = p2[0] - p0[0], nl = Math.hypot(nx, ny) || 1;
      const off = Math.min(S.W, S.H) * rnd(.18, .32) * side;
      comet = { p0, p1: [G.cx + (G.cx - mx) * .2 + nx / nl * off, G.cy + (G.cy - my) * .2 + ny / nl * off], p2, t: 0, dur: rnd(11, 15) };
    }
    // Queue (deadshot44474, 2026-11-05 : « the trail doesn't follow it ») : elle pointait droit à l'opposé du soleil, donc
    // devant la comète quand elle repartait. Maintenant la queue de poussière reprend le chemin parcouru (les positions
    // d'il y a un instant), à peine poussée à l'opposé du soleil, et la queue d'ions reste toujours derrière.
    const cometAt = (c, q) => { const w = 1 - q; return [w * w * c.p0[0] + 2 * w * q * c.p1[0] + q * q * c.p2[0], w * w * c.p0[1] + 2 * w * q * c.p1[1] + q * q * c.p2[1]]; };
    function drawComet(g, S) {
      const c = comet, q = c.t / c.dur, w = 1 - q;
      const [x, y] = cometAt(c, q);
      const dx = x - G.cx, dy = y - G.cy, d = Math.hypot(dx, dy) || 1, tx = dx / d, ty = dy / d;
      const near = clamp(1 - d / (Math.min(S.W, S.H) * .7), 0, 1), L = G.u * (9 + 22 * near), u = G.u;
      let vx = 2 * w * (c.p1[0] - c.p0[0]) + 2 * q * (c.p2[0] - c.p1[0]), vy = 2 * w * (c.p1[1] - c.p0[1]) + 2 * q * (c.p2[1] - c.p1[1]);
      const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      const back = (.09 + .07 * near) * (11 / c.dur); // longueur de la queue, en part du trajet (~1 à 1,8 s de chemin)
      // la traînée : un trait le long du chemin parcouru, épais et clair près de la tête, qui s'affine et s'efface (en
      // mélange normal : en « lighter », chaque jointure des segments brillait deux fois, on voyait des perles)
      g.lineCap = 'round';
      let px0 = x, py0 = y;
      for (let i = 1; i <= 24; i++) {
        const f = i / 24, [bx, by] = cometAt(c, Math.max(0, q - back * f)), push = L * f * f * .22, nx = bx + tx * push, ny = by + ty * push;
        g.strokeStyle = S.dark ? `rgba(255,240,205,${(.55 * (1 - f)).toFixed(3)})` : `rgba(59,74,107,${(.5 * (1 - f)).toFixed(3)})`;
        g.lineWidth = Math.max(.8, u * (1.1 - .9 * f)); g.beginPath(); g.moveTo(px0, py0); g.lineTo(nx, ny); g.stroke();
        px0 = nx; py0 = ny;
      }
      g.globalCompositeOperation = S.dark ? 'lighter' : 'source-over';
      for (let i = 1; i <= 16; i++) {
        const f = i / 16, [bx, by] = cometAt(c, Math.max(0, q - back * f)), push = L * f * f * .22;
        const ox = bx + tx * push, oy = by + ty * push, rad = u * (.4 + 2.6 * f);
        const gr = g.createRadialGradient(ox, oy, 0, ox, oy, rad), a = .2 * (1 - f) * (1 - f);
        gr.addColorStop(0, S.dark ? `rgba(255,244,214,${a.toFixed(3)})` : `rgba(59,74,107,${(a * .9).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,244,214,0)');
        g.fillStyle = gr; g.fillRect(ox - rad, oy - rad, rad * 2, rad * 2);
      }
      g.globalCompositeOperation = 'source-over';
      // queue d'ions : surtout derrière (−vitesse), un peu à l'opposé du soleil ; jamais devant
      let ix = -vx * .65 + tx * .35, iy = -vy * .65 + ty * .35; const il = Math.hypot(ix, iy) || 1; ix /= il; iy /= il;
      const ion = g.createLinearGradient(x, y, x + ix * L * .8, y + iy * L * .8);
      ion.addColorStop(0, S.dark ? 'rgba(147,197,253,.32)' : 'rgba(59,130,246,.25)'); ion.addColorStop(1, 'rgba(147,197,253,0)');
      g.strokeStyle = ion; g.lineWidth = Math.max(1, u * .18); g.beginPath(); g.moveTo(x, y); g.lineTo(x + ix * L * .8, y + iy * L * .8); g.stroke();
      const hg = g.createRadialGradient(x, y, 0, x, y, u * 1.6);
      hg.addColorStop(0, S.dark ? 'rgba(255,255,255,.95)' : 'rgba(59,74,107,.9)'); hg.addColorStop(.3, S.dark ? 'rgba(191,219,254,.45)' : 'rgba(59,130,246,.3)'); hg.addColorStop(1, 'rgba(191,219,254,0)');
      g.fillStyle = hg; g.fillRect(x - u * 1.6, y - u * 1.6, u * 3.2, u * 3.2);
    }
    const st = stage(layer, 'wss', {
      layout(S) {
        const portrait = S.H > S.W;
        // le soleil plus bas que les réglages du tirage, jamais sous du texte : derrière les cartes en paysage, entre deux
        // cartes en portrait
        G = { cx: S.W / 2, cy: S.H * (portrait ? .79 : .7), u: clamp(Math.min(S.W, S.H) / 100, 4.2, 11), e: clamp(S.H / S.W * .3, .3, .62) };
        G.sun = G.u * 3.4;
        // la première orbite passe toujours au-dessus et au-dessous du soleil et de ses rayons, jamais dessus (vue de biais,
        // son petit rayon est a0 × e)
        const a0 = Math.max(G.sun * 2.3, G.sun * 1.95 / G.e), a1 = Math.max(S.W * (portrait ? .62 : .45), a0 * 3.2);
        PL.forEach((p, i) => { p.a = a0 + (a1 - a0) * Math.pow(i / 7, 1.12); p.P = Math.min(420, 24 * Math.pow(p.a / a0, 1.5)); });
        // ceinture entre Mars (3) et Jupiter (4) ; Cérès au milieu ; Pluton un peu au-delà de Neptune, décalée
        G.b0 = PL[3].a + (PL[4].a - PL[3].a) * .28; G.b1 = PL[3].a + (PL[4].a - PL[3].a) * .66;
        CERES.a = (G.b0 + G.b1) / 2; CERES.P = 24 * Math.pow(CERES.a / a0, 1.5);
        for (const b of BELT) b.P = 24 * Math.pow((G.b0 + (G.b1 - G.b0) * b.f) / a0, 1.5);
        PLUTO.a = PL[7].a * 1.04; PLUTO.off = PLUTO.a * .2; PLUTO.P = 520;
      },
      paint(S, g) {
        starfield(g, S.W, S.H, Math.round(S.W * S.H / 2600), 31, S.dark ? '255,255,255' : '59,74,107', S.dark ? .75 : .3);
        // les orbites : un trait fin et lumineux (sombre), ou un pointillé à l'encre (clair)
        for (const p of PL) {
          if (S.dark) {
            ell(g, G.cx, G.cy, p.a, p.a * G.e); g.strokeStyle = 'rgba(147,197,253,.05)'; g.lineWidth = 5; g.stroke();
            ell(g, G.cx, G.cy, p.a, p.a * G.e); g.strokeStyle = 'rgba(165,205,255,.2)'; g.lineWidth = 1; g.stroke();
          } else {
            g.setLineDash([3, 5]); ell(g, G.cx, G.cy, p.a, p.a * G.e); g.strokeStyle = 'rgba(59,74,107,.38)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
          }
        }
        // l'orbite de Pluton, plus discrète (pointillés fins dans les deux thèmes), et le voile de poussière de la ceinture
        g.save(); g.setLineDash([2, 6]); ell(g, G.cx + PLUTO.off * Math.cos(PLUTO.tilt), G.cy + PLUTO.off * Math.sin(PLUTO.tilt), PLUTO.a, PLUTO.a * G.e * 1.1, PLUTO.tilt);
        g.strokeStyle = S.dark ? 'rgba(200,190,230,.22)' : 'rgba(59,74,107,.3)'; g.lineWidth = 1; g.stroke(); g.restore();
        ell(g, G.cx, G.cy, (G.b0 + G.b1) / 2, (G.b0 + G.b1) / 2 * G.e); g.strokeStyle = S.dark ? 'rgba(214,204,186,.06)' : 'rgba(59,74,107,.07)'; g.lineWidth = Math.max(4, (G.b1 - G.b0) * .8 * G.e); g.stroke();
        if (S.dark) {
          const halo = g.createRadialGradient(G.cx, G.cy, 0, G.cx, G.cy, G.sun * 14);
          halo.addColorStop(0, 'rgba(255,190,100,.16)'); halo.addColorStop(1, 'rgba(255,190,100,0)');
          g.fillStyle = halo; g.fillRect(G.cx - G.sun * 14, G.cy - G.sun * 14, G.sun * 28, G.sun * 28);
        }
      },
      update(S, dt) {
        for (const p of PL) p.th += dt * Math.PI * 2 / p.P;
        for (const b of BELT) b.th += dt * Math.PI * 2 / b.P;
        CERES.th += dt * Math.PI * 2 / CERES.P; PLUTO.th += dt * Math.PI * 2 / PLUTO.P;
        if (!comet && S.T > nextComet) newComet(S);
        if (comet && (comet.t += dt) > comet.dur) { comet = null; nextComet = S.T + rnd(28, 50); }
      },
      draw(S, g) {
        if (S.dark) twinkle(g, tw, S.W, S.H, '255,255,255', .9, S.T);
        belt(g, S);
        const list = PL.map(p => ({ p, P: pos(p, p.th) })).concat([{ p: PLUTO, P: plutoPos(PLUTO.th) }, { p: CERES, P: pos(CERES, CERES.th), ceres: 1 }]).sort((a, b) => a.P.y - b.P.y);
        const body = o => (o.ceres ? ceres(g, S, o.P) : planet(g, S, o.p, o.P));
        for (const o of list) if (o.P.y < G.cy) body(o);
        sun(g, S);
        for (const o of list) if (o.P.y >= G.cy) body(o);
        if (comet) drawComet(g, S);
      },
      debug(S, what) { if (what === 'comet') { newComet(S); comet.t = comet.dur * .45; } return { T: S.T, comet: !!comet }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * ☄️ Meteor Shower (idée de Ggggssnoop, 2026-11-01), assorti au skin Meteor : un ciel de nuit au-dessus des collines et
   * d'une petite ville au loin. Des étoiles filantes passent de temps en temps, toutes venues du même point du ciel
   * (le radiant, hors de l'écran en haut à droite), comme une vraie pluie d'étoiles filantes. Un tirage Rare+ déclenche
   * une averse, plus fournie selon la rareté ; Mythic+ y ajoute un bolide (plus gros, verdâtre, qui laisse des
   * étincelles). Thème clair : l'heure bleue (le ciel d'avant l'aube), les traînées plus sombres pour rester visibles.
   * Les étoiles sont peintes au hasard sur le décor ; une trentaine scintillent.
   */
  SCENES.meteorshower = layer => {
    const R = Math.random;
    let G = {}, list = [], sparks = [], next = rnd(.5, 1.5), queue = [];
    const tw = twinklers(30, .7);
    function spawn(S, big) {
      let x = R() * S.W, y = R() * G.hz * .7;
      // moins souvent derrière le nombre (en haut au milieu)
      if (x > S.W * .3 && x < S.W * .7 && y < S.H * .42 && R() < .7) x = R() < .5 ? R() * S.W * .3 : S.W * (.7 + R() * .3);
      const dx = x - G.rx, dy = y - G.ry, d = Math.hypot(dx, dy) || 1;
      const v = G.diag * rnd(.5, .85) * (big ? .7 : 1), life = rnd(.45, .85) * (big ? 1.7 : 1);
      list.push({ x0: x - dx / d * v * life * .35, y0: y - dy / d * v * life * .35, dx: dx / d, dy: dy / d, v, life, len: G.diag * rnd(.06, .14) * (big ? 1.8 : 1), w: big ? 3.4 : rnd(.9, 1.7), big, t: 0 });
    }
    const st = stage(layer, 'wms', {
      layout(S) {
        const portrait = S.H > S.W;
        G = { hz: S.H * (portrait ? .85 : .84), rx: S.W * .85, ry: -S.H * .3, diag: Math.hypot(S.W, S.H), u: Math.min(S.W, S.H) / 100 };
      },
      paint(S, g) {
        const { hz, u } = G, W = S.W, H = S.H, r = seeded(23), sr = (a, b) => a + r() * (b - a);
        starfield(g, W, hz, Math.round(W * hz / 2200), 41, '255,255,255', S.dark ? .8 : .55);
        const far = S.dark ? '#0d1330' : '#6f7fb3', mid = S.dark ? '#090d22' : '#5a6aa0', near = S.dark ? '#05070f' : '#45538a';
        // la ville au loin : des toits sur la crête, des fenêtres allumées
        const hill = x => hz - u * (3 + 2.2 * Math.sin(x / W * 4 + 1.3) + .9 * Math.sin(x / W * 11));
        g.fillStyle = far; g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 10; x += 10) g.lineTo(x, hill(x)); g.lineTo(W, H); g.fill();
        g.save(); g.translate(W * .66, hz); g.scale(W * .26, u * 13);
        const glow = g.createRadialGradient(0, 0, 0, 0, 0, 1); glow.addColorStop(0, S.dark ? 'rgba(251,146,60,.16)' : 'rgba(253,186,116,.3)'); glow.addColorStop(1, 'rgba(251,146,60,0)');
        g.fillStyle = glow; g.fillRect(-1, -1, 2, 2); g.restore();
        for (let x = W * .5; x < W * .82;) {
          const bw = u * sr(2, 4.5), bh = u * sr(1.8, 6), y = hill(x + bw / 2) + u * .8;
          g.fillStyle = far; g.fillRect(x, y - bh, bw, bh + u);
          for (let wy = y - bh + u * .7; wy < y - u * .3; wy += u * 1.1) for (let wx = x + u * .5; wx < x + bw - u * .5; wx += u * 1.1) if (r() < .45) { g.fillStyle = r() < .5 ? 'rgba(253,224,71,.75)' : 'rgba(254,215,170,.6)'; g.fillRect(wx, wy, u * .45, u * .5); }
          x += bw + u * sr(.2, 1.4);
        }
        // une colline plus proche avec des sapins, puis le premier plan
        const hill2 = x => hz + u * (1.4 + 1.6 * Math.sin(x / W * 3 + 4));
        g.fillStyle = mid; g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 10; x += 10) g.lineTo(x, hill2(x)); g.lineTo(W, H); g.fill();
        for (let x = 0; x < W; x += u * sr(1.4, 3.2)) {
          if (x > W * .3 && x < W * .62 && r() < .8) continue;
          const y = hill2(x) + u * .5, h = u * sr(3, 6.5);
          g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + h * .28, y); g.lineTo(x - h * .28, y); g.closePath(); g.fill();
        }
        g.fillStyle = near; g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 10; x += 10) g.lineTo(x, H - u * (3 + 2 * Math.sin(x / W * 2.2 + .5))); g.lineTo(W, H); g.fill();
      },
      update(S, dt) {
        if (S.T > next) { spawn(S, R() < .06); next = S.T + rnd(1, 3.2); }
        while (queue.length && queue[0].at <= S.T) spawn(S, queue.shift().big);
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i]; m.t += dt;
          if (m.big && R() < .7) { const hx = m.x0 + m.dx * m.v * m.t, hy = m.y0 + m.dy * m.v * m.t; sparks.push({ x: hx, y: hy, vx: rnd(-20, 20) - m.dx * 40, vy: rnd(-20, 20) - m.dy * 40, t: 0 }); }
          if (m.t > m.life) list.splice(i, 1);
        }
        for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.t += dt; s.x += s.vx * dt; s.y += (s.vy += 40 * dt) * dt; if (s.t > .7) sparks.splice(i, 1); }
      },
      draw(S, g) {
        twinkle(g, tw, S.W, G.hz, '255,255,255', S.dark ? .95 : .7, S.T);
        g.lineCap = 'round';
        for (const m of list) {
          const q = m.t / m.life, b = Math.pow(Math.sin(Math.PI * q), .7), hx = m.x0 + m.dx * m.v * m.t, hy = m.y0 + m.dy * m.v * m.t;
          const L = m.len * Math.min(1, q / .35), tx = hx - m.dx * L, ty = hy - m.dy * L;
          const gr = g.createLinearGradient(hx, hy, tx, ty);
          const tail = S.dark ? (m.big ? '190,242,170' : '191,219,254') : (m.big ? '22,101,52' : '55,48,163');
          gr.addColorStop(0, S.dark ? `rgba(255,255,255,${b.toFixed(3)})` : `rgba(255,255,255,${b.toFixed(3)})`); gr.addColorStop(.15, `rgba(${tail},${(b * .7).toFixed(3)})`); gr.addColorStop(1, `rgba(${tail},0)`);
          if (m.big) { g.strokeStyle = `rgba(${tail},${(.22 * b).toFixed(3)})`; g.lineWidth = m.w * 3.2; g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx - m.dx * L * .6, hy - m.dy * L * .6); g.stroke(); }
          g.strokeStyle = gr; g.lineWidth = m.w; g.beginPath(); g.moveTo(hx, hy); g.lineTo(tx, ty); g.stroke();
          const hr = m.w * (m.big ? 4.2 : 2.2), hg = g.createRadialGradient(hx, hy, 0, hx, hy, hr);
          hg.addColorStop(0, `rgba(255,255,255,${(b * .9).toFixed(3)})`); hg.addColorStop(1, `rgba(${tail},0)`);
          g.fillStyle = hg; g.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
        }
        for (const s of sparks) { g.fillStyle = S.dark ? `rgba(217,249,157,${(1 - s.t / .7).toFixed(3)})` : `rgba(22,101,52,${(.8 * (1 - s.t / .7)).toFixed(3)})`; g.fillRect(s.x - .8, s.y - .8, 1.6, 1.6); }
      },
      roll(S, tier, n, rank) {
        if (S.still || !(rank >= 3)) return;
        const count = rank >= 8 ? 26 : rank >= 7 ? 20 : rank >= 6 ? 15 : rank >= 5 ? 10 : rank >= 4 ? 7 : 3, bigs = rank >= 8 ? 2 : rank >= 6 ? 1 : 0, span = rank >= 6 ? 4 : 3;
        const add = Array.from({ length: count }, (_, i) => ({ at: S.T + .15 + span * Math.pow(i / count, .8) + rnd(0, .25), big: i < bigs * 3 && i % 3 === 1 }));
        queue = queue.concat(add).sort((a, b) => a.at - b.at);
      },
      debug(S, what) { if (what === 'still') { for (let i = 0; i < 3; i++) { spawn(S, i === 0); list[list.length - 1].t = list[list.length - 1].life * .45; } } return { T: S.T, n: list.length, q: queue.length }; },
    });
    // image fixe (mouvement réduit) : deux ou trois étoiles filantes figées, pour qu'on voie de quoi il s'agit
    if (st.S.still) { st._debug('still'); st.redraw(); }
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🎈 Party (idée de jia jun, 2026-11-01) : « une fête d'anniversaire, ou une fête ». Des guirlandes de fanions en haut,
   * des serpentins qui pendent et ondulent, des ballons qui montent doucement sur les côtés, des confettis qui tombent
   * lentement. Un bon tirage (Rare+) fait éclater un ballon : il gonfle un instant, puis éclate (un anneau, des
   * morceaux de caoutchouc et une poignée de confettis) ; Epic+ en éclate deux, Mythic+ plusieurs avec une pluie de
   * confettis, Divine+ tous. Le ballon revient d'en bas un peu plus tard.
   */
  SCENES.party = layer => {
    const R = Math.random, COLS = ['#ff6b8b', '#ffb547', '#4fd1a1', '#5aa9ff', '#b48cff', '#ff8fd1', '#ffd84d'];
    let G = {}, balloons = [], confetti = [], bits = [], rings = [], queue = [];
    const col = (c, S) => (S.dark ? mixHex(c, '#1d1233', .22) : c);
    const sideX = () => (R() < .5 ? rnd(.03, .25) : rnd(.75, .97));
    const newBalloon = (S, y) => ({ x: sideX(), y: y == null ? S.H + G.u * rnd(1, 4) : y, v: rnd(16, 30), ph: R() * 7, s: rnd(.82, 1.15), c: pick(COLS), popT: -1, gone: -1 });
    const newConf = (S, y) => ({ x: R() * S.W, y: y == null ? -10 : y, vx: rnd(-6, 6), vy: rnd(18, 38), rot: R() * 6, spin: rnd(-2.5, 2.5), w: rnd(5, 9), h: rnd(3, 4.5), c: pick(COLS), ph: R() * 7 });
    function pop(S, b) {
      b.gone = S.T;
      const s = b.s * G.u, x = b.x * S.W + Math.sin(S.T * .6 + b.ph) * G.u * .25, y = b.y;
      rings.push({ x, y, t: 0, r: s * .7, c: b.c });
      for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2 + rnd(-.3, .3), v = rnd(150, 280); bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, rot: R() * 6, spin: rnd(-9, 9), w: s * .3, h: s * .15, c: b.c, t: 0, life: rnd(.6, .9), g: 700, shard: 1 }); }
      for (let i = 0; i < 24; i++) { const a = R() * Math.PI * 2, v = rnd(60, 200); bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 90, rot: R() * 6, spin: rnd(-6, 6), w: rnd(5, 8), h: rnd(3, 4.5), c: pick(COLS), t: 0, life: rnd(2.2, 3.4), g: 160, drag: 1.6 }); }
    }
    function garland(S, g, ax, bx, y0, sag, phase) {
      const T = S.T, d = sag + Math.sin(T * .9 + phase) * 2, cxm = (ax + bx) / 2, P = t => [(1 - t) * (1 - t) * ax + 2 * t * (1 - t) * cxm + t * t * bx, y0 + 4 * d * t * (1 - t)];
      g.strokeStyle = S.dark ? 'rgba(255,240,250,.5)' : 'rgba(120,80,110,.55)'; g.lineWidth = 1.5;
      g.beginPath(); for (let i = 0; i <= 24; i++) { const [x, y] = P(i / 24); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      const n = Math.max(5, Math.round((bx - ax) / (G.u * .62)));
      for (let i = 1; i < n; i++) {
        const t = i / n, [x, y] = P(t), [x2, y2] = P(t + .01), a = Math.atan2(y2 - y, x2 - x) + Math.sin(T * 1.4 + i * .8 + phase) * .07;
        g.save(); g.translate(x, y); g.rotate(a);
        g.fillStyle = col(COLS[(i + Math.round(phase)) % COLS.length], S);
        g.beginPath(); g.moveTo(-G.u * .22, 0); g.lineTo(G.u * .22, 0); g.lineTo(0, G.u * .5); g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(-G.u * .22, 0); g.lineTo(0, 0); g.lineTo(0, G.u * .5); g.closePath(); g.fill();
        g.restore();
      }
    }
    function streamer(S, g, x, y0, len, i) {
      const T = S.T, n = 36;
      g.lineCap = 'round';
      for (let j = 0; j < n; j++) {
        const t0 = j / n, t1 = (j + 1) / n, f = v => [x + Math.sin(v * 9 + T * 1.3 + i * 2) * G.u * .22 * (.3 + v), y0 + v * len];
        const [x0, ya] = f(t0), [x1, yb] = f(t1), tw = Math.abs(Math.cos(t0 * 9 + T * 1.3 + i * 2));
        g.strokeStyle = col(COLS[(i * 2 + 1) % COLS.length], S); g.globalAlpha = .55 + .45 * tw; g.lineWidth = 1 + 3.5 * tw;
        g.beginPath(); g.moveTo(x0, ya); g.lineTo(x1, yb); g.stroke();
      }
      g.globalAlpha = 1;
    }
    function balloon(S, g, b) {
      const T = S.T;
      let k = 1;
      if (b.popT >= 0 && b.gone < 0) k = 1 + .1 * Math.min(1, (T - b.popT) / .1);
      const s = b.s * G.u * k, x = b.x * S.W + Math.sin(T * .6 + b.ph) * G.u * .25, y = b.y, tilt = Math.sin(T * .6 + b.ph + .8) * .08;
      // en portrait, le texte du jeu prend toute la largeur : là-haut, le ballon s'efface presque
      g.globalAlpha = G.portrait ? clamp((y - S.H * .3) / (S.H * .14), .22, 1) : 1;
      // la ficelle
      g.strokeStyle = S.dark ? 'rgba(255,255,255,.35)' : 'rgba(90,70,90,.4)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y + s * .62); g.bezierCurveTo(x + Math.sin(T * 1.1 + b.ph) * s * .3, y + s * 1.3, x - Math.sin(T * 1.3 + b.ph) * s * .3, y + s * 1.9, x + Math.sin(T * .9 + b.ph) * s * .2, y + s * 2.6); g.stroke();
      const c = col(b.c, S);
      g.save(); g.translate(x, y); g.rotate(tilt);
      g.fillStyle = mixHex(b.c, '#000000', .25); g.beginPath(); g.moveTo(-s * .07, s * .63); g.lineTo(s * .07, s * .63); g.lineTo(0, s * .55); g.closePath(); g.fill();
      const gr = g.createRadialGradient(-s * .18, -s * .22, s * .05, 0, 0, s * .66);
      gr.addColorStop(0, mixHex(b.c, '#ffffff', S.dark ? .25 : .45)); gr.addColorStop(.55, c); gr.addColorStop(1, mixHex(b.c, '#000000', S.dark ? .45 : .25));
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, s * .58); g.bezierCurveTo(s * .62, s * .3, s * .58, -s * .62, 0, -s * .6); g.bezierCurveTo(-s * .58, -s * .62, -s * .62, s * .3, 0, s * .58); g.fill();
      g.fillStyle = `rgba(255,255,255,${S.dark ? .35 : .55})`; ell(g, -s * .2, -s * .28, s * .07, s * .15, .5); g.fill();
      g.restore();
    }
    const rgbOf = h => [16, 8, 0].map(k => (parseInt(h.slice(1), 16) >> k) & 255).join(',');
    const st = stage(layer, 'wpt', {
      // sombre : des lumières floues de fête, au hasard, sur le décor
      paint(S, g) {
        if (!S.dark) return;
        const r = seeded(51);
        for (let i = 0, n = Math.round(S.W * S.H / 26000); i < n; i++) {
          const x = r() * S.W, y = r() * S.H, rad = 8 + r() * 22, c = rgbOf(COLS[Math.floor(r() * COLS.length)]);
          const gr = g.createRadialGradient(x, y, 0, x, y, rad);
          gr.addColorStop(0, `rgba(${c},.16)`); gr.addColorStop(.55, `rgba(${c},.1)`); gr.addColorStop(1, `rgba(${c},0)`);
          g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        }
      },
      layout(S) {
        const portrait = S.H > S.W;
        // la guirlande juste sous la barre du site (sa hauteur change entre ordinateur et téléphone)
        const bar = doc.querySelector('.topbar'), hb = bar ? bar.getBoundingClientRect().bottom : 56;
        G = { u: clamp(Math.min(S.W, S.H) / 13, 32, 66), gy: clamp(hb + 8, 40, S.H * .2), portrait };
        const n = portrait ? 5 : 8;
        if (balloons.length !== n) balloons = Array.from({ length: n }, (_, i) => newBalloon(S, S.H * (i + R() * .6) / n));
        const m = Math.round(Math.min(46, S.W * S.H / 24000));
        if (confetti.length !== m) confetti = Array.from({ length: m }, () => newConf(S, R() * S.H));
      },
      update(S, dt) {
        const T = S.T;
        while (queue.length && queue[0].at <= T) { const b = queue.shift().b; if (b.gone < 0 && b.popT < 0) b.popT = T; }
        for (const b of balloons) {
          if (b.popT >= 0 && b.gone < 0 && T - b.popT > .1) pop(S, b);
          if (b.gone >= 0) { if (T - b.gone > 1.6) Object.assign(b, newBalloon(S)); continue; }
          b.y -= b.v * dt;
          if (b.y < -G.u * 3) Object.assign(b, newBalloon(S));
        }
        for (const c of confetti) { c.y += c.vy * dt; c.x += (c.vx + Math.sin(T * 1.1 + c.ph) * 10) * dt; c.rot += c.spin * dt; if (c.y > S.H + 10) Object.assign(c, newConf(S)); }
        for (let i = bits.length - 1; i >= 0; i--) {
          const b = bits[i]; b.t += dt;
          if (b.drag) { b.vx -= b.vx * b.drag * dt; b.vy -= b.vy * b.drag * dt; }
          b.vy += b.g * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.rot += b.spin * dt;
          if (b.t > b.life) bits.splice(i, 1);
        }
        for (let i = rings.length - 1; i >= 0; i--) if ((rings[i].t += dt) > .35) rings.splice(i, 1);
      },
      draw(S, g) {
        const T = S.T, W = S.W;
        for (const c of confetti) {
          g.save(); g.translate(c.x, c.y); g.rotate(c.rot); g.scale(1, Math.cos(T * 3 + c.ph));
          g.fillStyle = col(c.c, S); g.globalAlpha = S.dark ? .7 : .8; g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); g.restore();
        }
        g.globalAlpha = 1;
        for (const b of balloons) if (b.gone < 0) balloon(S, g, b);
        g.globalAlpha = 1;
        for (const r of rings) {
          const q = r.t / .35;
          // l'anneau du « pop » : blanc la nuit, de la couleur du ballon sur le mur clair
          g.strokeStyle = S.dark ? '#ffffff' : r.c; g.globalAlpha = .9 * (1 - q); g.lineWidth = 2.5 * (1 - q) + .5;
          ell(g, r.x, r.y, r.r * (1 + q * 1.4), r.r * (1 + q * 1.4)); g.stroke();
          g.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + .2; g.moveTo(r.x + Math.cos(a) * r.r * (1.1 + q), r.y + Math.sin(a) * r.r * (1.1 + q)); g.lineTo(r.x + Math.cos(a) * r.r * (1.5 + q * 1.6), r.y + Math.sin(a) * r.r * (1.5 + q * 1.6)); } g.stroke();
        }
        g.globalAlpha = 1;
        for (const b of bits) {
          const a = b.shard ? 1 - b.t / b.life : Math.min(1, (b.life - b.t) / .6);
          g.save(); g.translate(b.x, b.y); g.rotate(b.rot); if (!b.shard) g.scale(1, Math.cos(T * 4 + b.rot)); g.globalAlpha = Math.max(0, a);
          g.fillStyle = col(b.c, S);
          if (b.shard) { g.beginPath(); g.moveTo(-b.w / 2, 0); g.quadraticCurveTo(0, -b.h * 1.4, b.w / 2, 0); g.quadraticCurveTo(0, -b.h * .4, -b.w / 2, 0); g.fill(); } else g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
          g.restore();
        }
        g.globalAlpha = 1;
        // les serpentins sur les côtés, puis les guirlandes de fanions par-dessus
        const len = S.H * (G.portrait ? .2 : .3);
        [.035, .13, .87, .965].forEach((f, i) => streamer(S, g, W * f, G.gy - 4, len * (i % 2 ? .75 : 1), i));
        garland(S, g, -W * .02, W * .5, G.gy - 6, S.H * .03, 0);
        garland(S, g, W * .5, W * 1.02, G.gy - 6, S.H * .03, 3);
      },
      roll(S, tier, n, rank) {
        if (S.still || !(rank >= 3)) return;
        const want = rank >= 8 ? 99 : rank >= 7 ? 4 : rank >= 6 ? 3 : rank >= 4 ? 2 : 1;
        const pool = balloons.filter(b => b.gone < 0 && b.popT < 0 && b.y > S.H * .14 && b.y < S.H * .9).sort(() => R() - .5).slice(0, want);
        pool.forEach((b, i) => queue.push({ b, at: S.T + .1 + i * .22 }));
        queue.sort((a, b) => a.at - b.at);
        if (rank >= 6) for (let i = 0; i < (rank >= 8 ? 80 : 50); i++) { const c = newConf(S, -10 - R() * S.H * .5); c.vy = rnd(70, 140); bits.push(Object.assign(c, { t: 0, life: 6, g: 0, drag: 0, vx: rnd(-20, 20) })); }
      },
      debug(S, what) { if (what === 'pop') { const b = balloons.find(b => b.gone < 0 && b.y > S.H * .2 && b.y < S.H * .85); if (b) b.popT = S.T; return !!b; } return { T: S.T, balloons: balloons.map(b => Math.round(b.y)) }; },
    });
    return st;
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
  root.RNGWallFX = { mount, roll, has: id => !!SCENES[id], _cur: () => cur && cur.s }; // _cur : pour les films de vérification
})(window);
