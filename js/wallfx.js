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
      const t0 = performance.now();
      S.T += dt;
      if (h.update && dt) h.update(S, dt);
      if (h.lazy && dt && !S.dirty) return;
      S.dirty = false;
      draw();
      S.ms = (S.ms || 0) * .95 + (performance.now() - t0) * .05; // temps moyen d'une image (tools/wall-preview.mjs)
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

  /* ===============================================================================================================
   * Fonds d'idées de joueurs du 2026-11-05 (tri de Sacha), lot « ciel et espace » : Blue Skies, Milky Way, Sky Gate,
   * et la bille lumineuse d'Aether. Même échafaudage (stage) que la ferme ; chaque fond garde une zone calme derrière le
   * haut du site (calm) pour que le texte posé sur le fond reste lisible.
   */
  // Une zone plus calme derrière le haut du site (le nombre, le slogan, les réglages du tirage) : un voile très doux de la
  // couleur du ciel, sans bord visible. rgb sans « rgba( ».
  // Le texte posé sur le fond descend jusqu'à ~58 % de la hauteur sur ordinateur, ~75 % en portrait : la zone est plus haute et plus large.
  function calm(g, S, rgb, a) {
    const portrait = S.H > S.W, cx = S.W / 2, cy = S.H * (portrait ? .38 : .32), rx = Math.max(S.W * (portrait ? .62 : .4), 280), ry = S.H * (portrait ? .42 : .36);
    g.save(); g.translate(cx, cy); g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(.6, `rgba(${rgb},${(a * .75).toFixed(3)})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(-rx, -rx, rx * 2, rx * 2); g.restore();
  }
  // La même zone calme, en élément CSS posé par-dessus les canevas : pour les fonds dont tout le décor bouge (repeindre ce
  // grand dégradé à chaque image coûtait plus que le reste du dessin). Retirée par stop() de la scène.
  // k agrandit la zone (pour un décor très chargé, comme la carte du monde).
  function calmEl(layer, S, rgb, a, k = 1) {
    const portrait = S.H > S.W, cx = S.W / 2, cy = S.H * (portrait ? .38 : .32), rx = Math.max(S.W * (portrait ? .62 : .4), 280) * k, ry = S.H * (portrait ? .42 : .36) * k;
    let el = layer.querySelector(':scope > .wcalm');
    if (!el) { el = doc.createElement('i'); el.className = 'wcalm'; layer.appendChild(el); }
    el.style.cssText = `left:${(cx - rx).toFixed(0)}px;top:${(cy - ry).toFixed(0)}px;width:${(rx * 2).toFixed(0)}px;height:${(ry * 2).toFixed(0)}px;background:radial-gradient(closest-side,rgba(${rgb},${a}),rgba(${rgb},${(a * .75).toFixed(3)}) 60%,rgba(${rgb},0))`;
    return el;
  }
  // 0 hors de la zone du texte (celle de calm), jusqu'à 1 en son centre : pour y semer moins de détails
  function quiet(S, x, y) {
    const portrait = S.H > S.W, rx = Math.max(S.W * (portrait ? .62 : .4), 280), ry = S.H * (portrait ? .42 : .36);
    return Math.max(0, 1 - Math.hypot((x - S.W / 2) / rx, (y - S.H * (portrait ? .38 : .32)) / ry));
  }
  const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * .87; // à peu près normale, écart 0,5

  /* ---------------------------------------------------------------------------------------------------------------
   * ✈️ Blue Skies (idée d'IXOLAF2, 2026-10-27) : « un fond de ciel avec des avions qui passent de temps en temps ».
   * Un grand ciel bleu, des cumulus sur trois plans qui défilent à des vitesses différentes (la profondeur), le soleil en
   * haut à droite. Toutes les 10 à 18 s un avion passe : un long-courrier très haut qui laisse une traînée de
   * condensation (elle s'élargit et s'efface), ou un petit avion à hélice plus bas qui tire une banderole. Thème sombre :
   * la même chose la nuit, nuages éclairés par la lune, avions en silhouette avec leurs feux (feu de position, flash
   * blanc, gyrophare rouge) et les hublots allumés. Livrées inventées, aucune compagnie.
   */
  SCENES.blueskies = layer => {
    const R = Math.random;
    let G = {}, clouds = [], planes = [], next = rnd(1.2, 2.5);
    const tw = twinklers(34, .75);
    // un cumulus peint une fois hors écran : des boules posées sur une base plate, le haut éclairé, le dessous plus gris
    function puff(seed, w, S) {
      const r = seeded(seed), h = Math.round(w * .55), cv = doc.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d'), base = h * .86, n = 6 + Math.floor(r() * 4);
      const top = S.dark ? '#5a6890' : '#ffffff', mid = S.dark ? '#3a466c' : '#f6f9fd', low = S.dark ? '#26304f' : '#dce6f1';
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1), rad = w * (.1 + .13 * Math.sin(k * Math.PI) + r() * .05), x = w * (.16 + .68 * k) + (r() - .5) * w * .06, y = base - rad * (.35 + r() * .5);
        const gr = g.createRadialGradient(x - rad * .25, y - rad * .45, rad * .1, x, y, rad * 1.05);
        gr.addColorStop(0, top); gr.addColorStop(.6, mid); gr.addColorStop(1, low);
        ell(g, x, y, rad, rad); g.fillStyle = gr; g.fill();
      }
      // la base plate (et l'ombre du dessous)
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.fillRect(0, base, w, h);
      g.globalCompositeOperation = 'source-atop';
      const sh = g.createLinearGradient(0, base - h * .45, 0, base); sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, S.dark ? 'rgba(10,14,30,.45)' : 'rgba(120,145,175,.18)');
      g.fillStyle = sh; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
      return cv;
    }
    // trois plans : loin (petits, pâles, lents), milieu, près (grands, plus rapides)
    // (le haut de l'écran reste un ciel dégagé, derrière le texte du site : c'est là que passent les avions de ligne)
    const PLANES = [{ k: .13, a: .55, v: 3.5, n: 7, y: [.44, .66] }, { k: .21, a: .82, v: 8, n: 5, y: [.56, .84] }, { k: .32, a: .96, v: 15, n: 3, y: [.74, 1.02] }];
    function newCloud(S, p, x) {
      const w = Math.round(clamp(Math.max(S.W, S.H) * p.k * rnd(.75, 1.25), 60, 640));
      return { p, w, img: null, seed: 1 + Math.floor(R() * 9999), x: x == null ? -w : x, y: S.H * rnd(p.y[0], p.y[1]), v: p.v * rnd(.8, 1.2) * G.u / 6 };
    }
    // ----- les avions (dessinés vers la droite ; dir = -1 les retourne)
    function jet(g, S, L, T) {
      const h = L * .1, D = S.dark;
      const body = D ? '#1c2440' : '#f8fafc', belly = D ? '#121830' : '#d5dee9', wing = D ? '#161d36' : '#c7d2e0', fin = D ? '#202a4a' : '#0f8f8c';
      // l'aile et le stabilisateur du fond, derrière le fuselage
      g.fillStyle = D ? '#121830' : '#b9c6d6';
      g.beginPath(); g.moveTo(L * .05, -h * .2); g.lineTo(-L * .1, -h * 1.5); g.lineTo(-L * .17, -h * 1.5); g.lineTo(-L * .07, -h * .2); g.fill();
      g.beginPath(); g.moveTo(-L * .36, -h * .35); g.lineTo(-L * .45, -h * 1.05); g.lineTo(-L * .49, -h * 1.05); g.lineTo(-L * .45, -h * .35); g.fill();
      // la dérive
      g.fillStyle = fin; g.beginPath(); g.moveTo(-L * .3, -h * .45); g.lineTo(-L * .45, -h * 2.4); g.lineTo(-L * .51, -h * 2.4); g.lineTo(-L * .5, -h * .5); g.fill();
      // le fuselage : nez arrondi, queue relevée
      g.beginPath();
      g.moveTo(L * .5, h * .05);
      g.bezierCurveTo(L * .5, -h * .4, L * .45, -h * .5, L * .36, -h * .5);
      g.lineTo(-L * .3, -h * .5); g.lineTo(-L * .5, -h * .62); g.lineTo(-L * .5, -h * .3);
      g.bezierCurveTo(-L * .42, h * .2, -L * .32, h * .5, -L * .22, h * .5);
      g.lineTo(L * .36, h * .5);
      g.bezierCurveTo(L * .46, h * .5, L * .5, h * .35, L * .5, h * .05);
      g.closePath();
      g.fillStyle = body; g.fill();
      g.save(); g.clip(); g.fillStyle = belly; g.fillRect(-L * .6, h * .12, L * 1.2, h); if (!D) { g.fillStyle = fin; g.fillRect(-L * .6, -h * .05, L * 1.2, h * .1); } g.restore();
      // la nuit, le dessus du fuselage éclairé par la lune (sinon l'avion disparaît dans le ciel)
      if (D) { g.strokeStyle = 'rgba(203,213,225,.55)'; g.lineWidth = Math.max(1, h * .14); g.beginPath(); g.moveTo(L * .4, -h * .48); g.lineTo(-L * .3, -h * .48); g.lineTo(-L * .47, -h * 2.35); g.stroke(); }
      // hublots (allumés la nuit) et poste de pilotage
      g.fillStyle = D ? 'rgba(253,224,140,.85)' : '#475569';
      for (let x = -L * .26; x < L * .33; x += L * .034) g.fillRect(x, -h * .3, Math.max(1, L * .012), Math.max(1, h * .2));
      g.fillStyle = D ? 'rgba(253,224,140,.6)' : '#334155'; g.beginPath(); g.moveTo(L * .43, -h * .32); g.lineTo(L * .48, -h * .18); g.lineTo(L * .42, -h * .18); g.fill();
      // l'aile du premier plan et son réacteur
      g.fillStyle = wing; g.beginPath(); g.moveTo(L * .1, h * .25); g.lineTo(-L * .12, h * 2.1); g.lineTo(-L * .2, h * 2.1); g.lineTo(-L * .06, h * .3); g.fill();
      g.fillStyle = D ? '#0d1226' : '#94a3b8'; rr(g, -L * .04, h * .55, L * .13, h * .55, h * .27); g.fill();
      g.fillStyle = D ? '#121830' : '#b9c6d6'; g.beginPath(); g.moveTo(-L * .38, h * .1); g.lineTo(-L * .47, h * .8); g.lineTo(-L * .5, h * .8); g.lineTo(-L * .47, h * .1); g.fill();
      if (D) lights(g, T, -L * .2, h * 2.1, L * .02, -L * .32, -h * .52);
    }
    function prop(g, S, L, T) {
      const h = L * .15, D = S.dark;
      const body = D ? '#1c2440' : '#ef4444', stripe = D ? '#28335a' : '#ffffff', wing = D ? '#161d36' : '#fbfbfb';
      g.fillStyle = D ? '#121830' : '#e5e7eb';
      g.beginPath(); g.moveTo(-L * .34, -h * .2); g.lineTo(-L * .44, -h * .7); g.lineTo(-L * .48, -h * .7); g.lineTo(-L * .45, -h * .2); g.fill();
      g.fillStyle = body; g.beginPath(); g.moveTo(-L * .28, -h * .4); g.lineTo(-L * .44, -h * 1.7); g.lineTo(-L * .5, -h * 1.7); g.lineTo(-L * .48, -h * .3); g.fill();
      g.beginPath(); g.moveTo(L * .42, -h * .3); g.lineTo(L * .2, -h * .55); g.lineTo(-L * .3, -h * .35); g.lineTo(-L * .5, -h * .25); g.lineTo(-L * .5, h * .05); g.lineTo(-L * .2, h * .4); g.lineTo(L * .32, h * .45); g.lineTo(L * .42, h * .25); g.closePath();
      g.fillStyle = body; g.fill();
      g.save(); g.clip(); g.fillStyle = stripe; g.fillRect(-L * .6, -h * .02, L * 1.2, h * .14); g.restore();
      // la verrière, l'aile haute, les roues
      g.fillStyle = D ? 'rgba(253,224,140,.55)' : '#bfe3f7'; g.beginPath(); g.moveTo(L * .2, -h * .5); g.lineTo(L * .05, -h * .95); g.lineTo(-L * .08, -h * .95); g.lineTo(-L * .06, -h * .45); g.fill();
      g.fillStyle = wing; rr(g, -L * .2, -h * 1.12, L * .4, h * .22, h * .1); g.fill();
      g.strokeStyle = D ? '#0d1226' : '#475569'; g.lineWidth = Math.max(1, L * .012);
      g.beginPath(); g.moveTo(L * .12, h * .4); g.lineTo(L * .16, h * .85); g.stroke();
      g.fillStyle = D ? '#0d1226' : '#1f2937'; ell(g, L * .17, h * .9, h * .2, h * .2); g.fill();
      // l'hélice : un disque flou qui papillote
      g.fillStyle = D ? 'rgba(148,163,184,.25)' : 'rgba(30,41,59,.22)'; ell(g, L * .45, 0, L * .02, h * (.9 + .15 * Math.sin(T * 40))); g.fill();
      g.fillStyle = D ? '#28335a' : '#1f2937'; ell(g, L * .44, 0, L * .03, h * .14); g.fill();
      if (D) lights(g, T, -L * .2, -h * 1.05, L * .02, -L * .47, -h * 1.7);
    }
    // feux la nuit : feu de position vert au bout de l'aile, flash blanc double, gyrophare rouge sur la dérive
    function lights(g, T, wx, wy, r, bx, by) {
      const glow = (x, y, c, a, k) => { const gr = g.createRadialGradient(x, y, 0, x, y, r * k); gr.addColorStop(0, `rgba(${c},${a})`); gr.addColorStop(1, `rgba(${c},0)`); g.fillStyle = gr; g.fillRect(x - r * k, y - r * k, r * k * 2, r * k * 2); };
      glow(wx, wy, '74,222,128', .9, 3);
      const f = T % 1.3; if (f < .06 || (f > .16 && f < .22)) glow(wx - r * 2, wy, '255,255,255', 1, 7);
      if ((T + .4) % 1 < .18) glow(bx, by, '248,113,113', .95, 4);
    }
    // une banderole qui ondule derrière le petit avion (texte du jeu, aucune marque)
    function banner(g, S, L, T) {
      const D = S.dark, h = L * .26, w = L * 1.7, x0 = -L * .62, gap = L * .5, n = 14;
      g.strokeStyle = D ? 'rgba(148,163,184,.5)' : 'rgba(51,65,85,.6)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(-L * .48, -h * .1); g.lineTo(x0 - gap, 0); g.stroke();
      const top = [], bot = [];
      for (let i = 0; i <= n; i++) { const k = i / n, x = x0 - gap - k * w, y = Math.sin(T * 5 - k * 6) * h * .16 * k; top.push([x, y - h / 2]); bot.push([x, y + h / 2]); }
      g.beginPath(); top.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); bot.reverse().forEach(([x, y]) => g.lineTo(x, y)); g.closePath();
      g.fillStyle = D ? 'rgba(203,213,225,.8)' : '#fffdf5'; g.fill();
      g.strokeStyle = D ? 'rgba(248,113,113,.7)' : '#ef4444'; g.lineWidth = Math.max(1, h * .07); g.stroke();
      return { x: x0 - gap - w / 2, h };
    }
    function spawn(S) {
      const dir = R() < .5 ? 1 : -1, big = R() < .4;
      const L = G.u * (big ? rnd(12, 14) : rnd(12, 15)), y = big ? S.H * rnd(.6, .78) : S.H * rnd(.14, .34);
      const cross = big ? rnd(22, 28) : rnd(17, 23), span = S.W + L * (big ? 6 : 3);
      planes.push({ kind: big ? 'prop' : 'jet', dir, L, y, x: dir > 0 ? -L * (big ? 4 : 1.5) : S.W + L * (big ? 4 : 1.5), v: span / cross, trail: [], tt: 0, ph: R() * 7 });
    }
    const st = stage(layer, 'wbs', {
      layout(S) {
        G = { u: clamp(Math.min(S.W, S.H) / 100, 3.6, 11) };
        if (!clouds.length) for (const p of PLANES) for (let i = 0; i < p.n; i++) clouds.push(newCloud(S, p, R() * (S.W + 300) - 150));
        for (const c of clouds) { c.img = puff(c.seed, c.w, S); c.y = clamp(c.y, 0, S.H); }
      },
      paint(S, g) {
        if (S.dark) {
          starfield(g, S.W, S.H * .8, Math.round(S.W * S.H / 3200), 17, '226,232,240', .7);
          // la lune, en haut à droite
          const mx = S.W * .84, my = S.H * .14, mr = G.u * 3.2;
          const halo = g.createRadialGradient(mx, my, mr, mx, my, mr * 7); halo.addColorStop(0, 'rgba(203,213,225,.18)'); halo.addColorStop(1, 'rgba(203,213,225,0)');
          g.fillStyle = halo; g.fillRect(mx - mr * 7, my - mr * 7, mr * 14, mr * 14);
          const mg = g.createRadialGradient(mx - mr * .3, my - mr * .3, mr * .2, mx, my, mr); mg.addColorStop(0, '#f8fafc'); mg.addColorStop(1, '#cbd5e1');
          ell(g, mx, my, mr, mr); g.fillStyle = mg; g.fill();
          g.fillStyle = 'rgba(148,163,184,.35)'; ell(g, mx + mr * .3, my - mr * .2, mr * .22, mr * .22); g.fill(); ell(g, mx - mr * .25, my + mr * .35, mr * .15, mr * .15); g.fill();
          calm(g, S, '11,18,40', .35);
        } else {
          const sx = S.W * .86, sy = S.H * .12, sr = G.u * 4;
          const halo = g.createRadialGradient(sx, sy, sr * .5, sx, sy, sr * 9); halo.addColorStop(0, 'rgba(255,251,225,.85)'); halo.addColorStop(.25, 'rgba(255,247,200,.35)'); halo.addColorStop(1, 'rgba(255,247,200,0)');
          g.fillStyle = halo; g.fillRect(sx - sr * 9, sy - sr * 9, sr * 18, sr * 18);
          ell(g, sx, sy, sr, sr); g.fillStyle = '#fffbea'; g.fill();
          calm(g, S, '246,251,255', .8);
        }
      },
      update(S, dt) {
        for (const c of clouds) { c.x += c.v * dt; if (c.x > S.W + 20) { Object.assign(c, newCloud(S, c.p)); c.img = puff(c.seed, c.w, S); } }
        if (S.T > next && planes.length < 2) { spawn(S); next = S.T + rnd(10, 18); }
        for (const p of planes) {
          p.x += p.v * p.dir * dt; p.tt += dt;
          // la traînée : un point toutes les 0,08 s derrière le réacteur, qui dérive un peu avec le vent
          if (p.kind === 'jet' && p.tt > .08) { p.tt = 0; p.trail.push({ x: p.x - p.dir * p.L * .5, y: p.y + p.L * .02, t: S.T }); }
          for (const q of p.trail) q.x += 3 * dt;
          while (p.trail.length && S.T - p.trail[0].t > 9) p.trail.shift();
        }
        planes = planes.filter(p => (p.dir > 0 ? p.x < S.W + p.L * 6 : p.x > -p.L * 6) || p.trail.length);
      },
      draw(S, g) {
        if (S.dark) twinkle(g, tw, S.W, S.H, '255,255,255', .8, S.T);
        const cloudsOf = i => { for (const c of clouds) if (c.p === PLANES[i]) { g.globalAlpha = c.p.a; g.drawImage(c.img, c.x, c.y - c.img.height * .86); } g.globalAlpha = 1; };
        cloudsOf(0);
        // les traînées, puis les avions hauts
        for (const p of planes) {
          // par tronçons de 6 points (largeur et opacité constantes par tronçon) : pas de pointillés aux raccords
          const tr = p.trail;
          g.lineCap = 'butt'; g.lineJoin = 'round';
          for (let i = 0; i < tr.length - 1; i += 6) {
            const age = S.T - tr[i].t, a = (S.dark ? .32 : .8) * Math.max(0, 1 - age / 9);
            if (a <= 0) continue;
            g.strokeStyle = S.dark ? `rgba(203,213,225,${a.toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`;
            g.lineWidth = G.u * (.2 + age * .17);
            g.beginPath(); g.moveTo(tr[i].x, tr[i].y); for (let j = i + 1; j <= Math.min(i + 6, tr.length - 1); j++) g.lineTo(tr[j].x, tr[j].y); g.stroke();
          }
        }
        for (const p of planes) if (p.kind === 'jet') { g.save(); g.translate(p.x, p.y + Math.sin(S.T * .7 + p.ph) * G.u * .1); g.scale(p.dir, 1); jet(g, S, p.L, S.T); g.restore(); }
        cloudsOf(1);
        for (const p of planes) if (p.kind === 'prop') {
          g.save(); g.translate(p.x, p.y + Math.sin(S.T * 1.1 + p.ph) * G.u * .3); g.scale(p.dir, 1); g.rotate(Math.sin(S.T * 1.1 + p.ph + 1.2) * .03);
          const b = banner(g, S, p.L, S.T);
          // le texte de la banderole, toujours à l'endroit (même quand l'avion va vers la gauche)
          g.save(); g.translate(b.x, Math.sin(S.T * 5 - 3) * b.h * .08); g.scale(p.dir, 1);
          g.fillStyle = S.dark ? '#1e293b' : '#1e3a8a'; g.font = `800 ${Math.round(b.h * .62)}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText('ROLL ∞', 0, b.h * .04); g.restore();
          prop(g, S, p.L, S.T); g.restore();
        }
        cloudsOf(2);
      },
      debug(S, what) { if (what === 'jet' || what === 'prop') { const n = planes.length; spawn(S); const p = planes[n]; p.kind = what; p.L = G.u * (what === 'prop' ? 13 : 13); p.y = S.H * (what === 'prop' ? .7 : .2); p.x = S.W * .3; p.dir = 1; } return { planes: planes.length }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🌌 Milky Way (idée de Ggggssnoop, 2026-10-29) : « un fond Voie lactée ». Un ciel de campagne sans lune : la Voie
   * lactée traverse l'écran en diagonale, avec son cœur orangé en bas à gauche, ses bandes de poussière sombres et des
   * milliers d'étoiles (peintes une fois). Au premier plan, des collines et des sapins en silhouette, une petite tente
   * éclairée. Une trentaine d'étoiles scintillent, une étoile filante passe de temps en temps et un satellite traverse
   * lentement le ciel. Thème clair : la même Voie lactée sur une carte du ciel imprimée (papier crème, encre bleue).
   * Identifiant « milkynight » : « milkyway » est déjà un skin.
   */
  SCENES.milkynight = layer => {
    let G = {}, meteor = null, nextMet = rnd(3, 6), sat = null, nextSat = rnd(8, 14);
    const tw = twinklers(40, .82);
    // un point le long de la bande : t de 0 (en bas à gauche) à 1, n l'écart perpendiculaire en largeurs de bande
    const at = (t, n) => ({ x: G.ax + (G.bx - G.ax) * t + G.px * n * G.wid, y: G.ay + (G.by - G.ay) * t + G.py * n * G.wid });
    // les bandes de poussière : deux filaments sombres qui serpentent le long du milieu de la bande
    const lane = t => [Math.sin(t * 9 + 1) * .12 + .05, Math.sin(t * 6 + 3) * .14 - .25];
    const inLane = (t, n) => lane(t).some(c => Math.abs(n - c) < .07 + .05 * Math.sin(t * 17));
    function land(g, S) {
      const { W, H } = S, hz = G.hz, u = G.u, ink = S.dark ? '#02030a' : '#34466e', ground = S.dark ? '#02030a' : '#e6dcc2', line = S.dark ? null : 'rgba(43,58,94,.55)';
      g.fillStyle = S.dark ? '#05070f' : '#efe7d1';
      g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, hz - u * (3 + 2.4 * Math.sin(x / W * 4 + .6) + Math.sin(x / W * 11) * .8)); g.lineTo(W, H); g.fill();
      if (line) { g.strokeStyle = line; g.lineWidth = 1; g.beginPath(); for (let x = 0; x <= W + 8; x += 8) { const y = hz - u * (3 + 2.4 * Math.sin(x / W * 4 + .6) + Math.sin(x / W * 11) * .8); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
      g.fillStyle = ground; g.beginPath(); g.moveTo(0, H); for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, hz + u * (1.4 + 1.3 * Math.sin(x / W * 3 + 2))); g.lineTo(W, H); g.fill();
      if (line) { g.strokeStyle = line; g.beginPath(); for (let x = 0; x <= W + 8; x += 8) { const y = hz + u * (1.4 + 1.3 * Math.sin(x / W * 3 + 2)); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
      // des sapins sur la crête, plus nombreux sur les côtés
      const r = seeded(7);
      for (let i = 0; i < Math.round(W / (u * 2.2)); i++) {
        const x = r() * W, side = Math.abs(x / W - .5) * 2; if (r() > .25 + side * .75) continue;
        const y = hz + u * (1.4 + 1.3 * Math.sin(x / W * 3 + 2)) + u * .4, h = u * (3 + r() * 4.5) * (.6 + side * .6), w = h * .38;
        g.fillStyle = ink; g.beginPath(); g.moveTo(x, y - h);
        for (let k = 1; k <= 4; k++) { const yy = y - h + h * k / 4.4; g.lineTo(x + w * k / 4, yy); g.lineTo(x + w * k / 9, yy - h * .04); }
        g.lineTo(x + w * .08, y); g.lineTo(x - w * .08, y);
        for (let k = 4; k >= 1; k--) { const yy = y - h + h * k / 4.4; g.lineTo(x - w * k / 9, yy - h * .04); g.lineTo(x - w * k / 4, yy); }
        g.closePath(); g.fill();
      }
      // la petite tente éclairée, en bas à droite
      const tx = W * (W > H ? .78 : .7), ty = hz + u * (1.4 + 1.3 * Math.sin(tx / W * 3 + 2)) + u * .5, ts = u * 2.4;
      if (S.dark) { const gl = g.createRadialGradient(tx, ty - ts * .4, 0, tx, ty - ts * .4, ts * 3.4); gl.addColorStop(0, 'rgba(251,191,36,.35)'); gl.addColorStop(1, 'rgba(251,191,36,0)'); g.fillStyle = gl; g.fillRect(tx - ts * 4, ty - ts * 4, ts * 8, ts * 8); }
      g.fillStyle = S.dark ? '#f59e0b' : '#f3d9a4'; g.beginPath(); g.moveTo(tx - ts, ty); g.lineTo(tx, ty - ts * 1.1); g.lineTo(tx + ts, ty); g.closePath(); g.fill();
      if (line) { g.strokeStyle = line; g.stroke(); }
      g.fillStyle = S.dark ? '#7c2d12' : 'rgba(43,58,94,.5)'; g.beginPath(); g.moveTo(tx - ts * .22, ty); g.lineTo(tx, ty - ts * .7); g.lineTo(tx + ts * .22, ty); g.fill();
    }
    const st = stage(layer, 'wmw', {
      layout(S) {
        const portrait = S.H > S.W;
        G = { u: clamp(Math.min(S.W, S.H) / 100, 3.6, 11), hz: S.H * (portrait ? .88 : .86) };
        // la bande : du bas à gauche (le cœur) vers le haut à droite
        Object.assign(G, portrait ? { ax: -S.W * .3, ay: S.H * .95, bx: S.W * 1.25, by: -S.H * .05 } : { ax: S.W * .02, ay: S.H * 1.05, bx: S.W * 1.02, by: -S.H * .25 });
        const dx = G.bx - G.ax, dy = G.by - G.ay, d = Math.hypot(dx, dy);
        G.px = -dy / d; G.py = dx / d; G.ang = Math.atan2(dy, dx); G.len = d; G.wid = Math.max(S.W, S.H) * (portrait ? .16 : .12);
      },
      paint(S, g) {
        const { W, H } = S, D = S.dark, r = seeded(11);
        if (!D) {
          // la carte du ciel : un quadrillage courbe très pâle
          g.strokeStyle = 'rgba(43,58,94,.08)'; g.lineWidth = 1;
          for (let i = 1; i < 7; i++) { ell(g, W / 2, H * 1.6, W * .2 * i, H * .26 * i); g.stroke(); }
          for (let i = -6; i <= 6; i++) { g.beginPath(); g.moveTo(W / 2, H * 1.6); g.lineTo(W / 2 + i * W * .22, -H * .1); g.stroke(); }
        }
        // la lueur de la bande, puis le cœur chaud, en taches allongées le long de l'axe
        // derrière le texte du site, la bande s'efface à moitié
        const blob = (t, n, rx, ry, c) => { const p = at(t, n), q = 1 - .6 * quiet(S, p.x, p.y); if (q < 1) c = c.replace(/[\d.]+\)$/, m => (parseFloat(m) * q).toFixed(3) + ')'); g.save(); g.translate(p.x, p.y); g.rotate(G.ang); g.scale(1, ry / rx); const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx); gr.addColorStop(0, c); gr.addColorStop(1, c.replace(/[\d.]+\)$/, '0)')); g.fillStyle = gr; g.fillRect(-rx, -rx, rx * 2, rx * 2); g.restore(); };
        for (let t = -.05; t <= 1.05; t += .05) {
          const k = t < .15 ? 1.5 : t < .45 ? 1.2 : .85;
          blob(t, r() * .3 - .15, G.wid * 1.7, G.wid * 1, D ? `rgba(160,180,255,${(.085 * k).toFixed(3)})` : `rgba(80,110,190,${(.06 * k).toFixed(3)})`);
        }
        // des nuages d'étoiles : des taches plus claires et inégales le long de la bande (elle n'est jamais lisse)
        for (let i = 0; i < 46; i++) { const t = r() * 1.05, s = G.wid * (.18 + r() * .4); blob(t, gauss() * .45, s * 1.6, s, D ? `rgba(220,228,255,${(.05 + r() * .07).toFixed(3)})` : `rgba(60,90,170,${(.04 + r() * .05).toFixed(3)})`); }
        for (let t = .0; t <= .34; t += .03) blob(t, r() * .3 - .15, G.wid * 1.3, G.wid * .75, D ? 'rgba(255,196,140,.16)' : 'rgba(214,150,90,.1)');
        if (D) for (let t = .04; t <= .3; t += .045) blob(t, .1, G.wid * .8, G.wid * .5, 'rgba(255,150,170,.06)');
        // les bandes de poussière : des taches sombres le long des filaments
        for (let t = 0; t <= 1; t += .015) for (const c of lane(t)) blob(t, c + gauss() * .03, G.wid * .45, G.wid * .13, D ? 'rgba(4,5,14,.5)' : 'rgba(247,241,226,.55)');
        // les étoiles de la bande (des milliers de points, plus serrés au milieu) et celles de tout le ciel
        const N = Math.round(W * H / (D ? 110 : 170));
        for (let i = 0; i < N; i++) {
          const t = r() * 1.1 - .05, n = gauss() * (r() < .7 ? .45 : .9);
          if (inLane(t, n) && r() < .85) continue;
          const p = at(t, n); if (p.y > G.hz || r() < quiet(S, p.x, p.y) * 4.5) continue;
          const k = r(), a = D ? (.25 + .6 * k * k) * (t < .3 ? 1 : .85) : .3 + .5 * k;
          g.fillStyle = D ? (k > .93 ? `rgba(255,214,170,${a})` : `rgba(235,240,255,${a.toFixed(2)})`) : `rgba(43,58,94,${a.toFixed(2)})`;
          const s = k > .97 ? 1.6 : k > .8 ? 1.1 : .8; g.fillRect(p.x, p.y, s, s);
        }
        for (let i = 0, n = Math.round(W * H / (D ? 1400 : 2600)); i < n; i++) {
          const x = r() * W, y = r() * G.hz, k = r(); if (r() < quiet(S, x, y) * 4.5) continue;
          g.fillStyle = D ? `rgba(255,255,255,${(.3 + .5 * k).toFixed(2)})` : `rgba(43,58,94,${(.2 + .3 * k).toFixed(2)})`; ell(g, x, y, .5 + k * k, .5 + k * k); g.fill();
        }
        // quelques étoiles brillantes avec leurs aigrettes
        for (let i = 0; i < 9; i++) {
          const x = r() * W, y = r() * G.hz * .85, s = G.u * (.5 + r() * .5); if (quiet(S, x, y) > .1) continue;
          g.strokeStyle = D ? 'rgba(226,232,255,.55)' : 'rgba(43,58,94,.6)'; g.lineWidth = 1;
          g.beginPath(); g.moveTo(x - s * 2, y); g.lineTo(x + s * 2, y); g.moveTo(x, y - s * 2); g.lineTo(x, y + s * 2); g.stroke();
          g.fillStyle = D ? '#fff' : '#2b3a5e'; ell(g, x, y, s * .35, s * .35); g.fill();
        }
        calm(g, S, D ? '5,6,16' : '252,249,240', D ? .45 : .85);
        land(g, S);
      },
      update(S, dt) {
        if (!meteor && S.T > nextMet) {
          const x = S.W * rnd(.05, .95), y = S.H * rnd(.05, .4), a = rnd(.35, .7) * (x > S.W / 2 ? 1 : -1) + (x > S.W / 2 ? Math.PI : 0);
          meteor = { x, y, dx: Math.cos(a), dy: Math.abs(Math.sin(a)), v: Math.max(S.W, S.H) * rnd(.7, 1), t: 0, life: rnd(.5, .8) };
        }
        if (meteor && (meteor.t += dt) > meteor.life) { meteor = null; nextMet = S.T + rnd(9, 18); }
        if (!sat && S.T > nextSat) { const l = Math.random() < .5; sat = { x: l ? -10 : S.W + 10, y: S.H * rnd(.08, .5), vx: (l ? 1 : -1) * S.W / rnd(40, 55), vy: rnd(-.04, .04) * S.H / 40 }; }
        if (sat) { sat.x += sat.vx * dt; sat.y += sat.vy * dt; if (sat.x < -20 || sat.x > S.W + 20) { sat = null; nextSat = S.T + rnd(25, 45); } }
      },
      draw(S, g) {
        twinkle(g, tw, S.W, G.hz, S.dark ? '255,255,255' : '43,58,94', S.dark ? .9 : .5, S.T);
        if (sat) { g.fillStyle = S.dark ? 'rgba(255,255,255,.75)' : 'rgba(43,58,94,.7)'; ell(g, sat.x, sat.y, 1.3, 1.3); g.fill(); }
        if (meteor) {
          const m = meteor, q = m.t / m.life, x = m.x + m.dx * m.v * m.t, y = m.y + m.dy * m.v * m.t, L = m.v * .14 * Math.sin(q * Math.PI);
          const gr = g.createLinearGradient(x, y, x - m.dx * L, y - m.dy * L);
          gr.addColorStop(0, S.dark ? 'rgba(255,255,255,.9)' : 'rgba(43,58,94,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
          g.strokeStyle = gr; g.lineWidth = 1.6; g.lineCap = 'round'; g.beginPath(); g.moveTo(x, y); g.lineTo(x - m.dx * L, y - m.dy * L); g.stroke();
        }
      },
      debug(S, what) { if (what === 'meteor') nextMet = S.T; if (what === 'sat') nextSat = S.T; return { meteor: !!meteor, sat: !!sat }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🌅 Sky Gate (idée de Ggggssnoop, 2026-10-29, « heaven's gate ») : une grande porte de lumière posée sur
   * une mer de nuages. Volontairement sans aucun symbole religieux (Sacha) : deux piliers, une arche et un soleil
   * géométrique au sommet, des battants en ferronnerie. Les battants s'ouvrent lentement (un cycle de ~40 s) et la
   * lumière passe par l'ouverture : des rayons dorés en éventail, des poussières de lumière qui montent. Deux nappes de
   * nuages glissent devant et derrière la porte. Thème clair : l'aube, porte en pierre blanche et or ; thème sombre :
   * la nuit, la porte rayonne doucement. Les rayons s'effacent avant d'atteindre le haut du site (le texte).
   */
  SCENES.skygate = layer => {
    let G = {}, seaFar = null, seaNear = null, gate = null, motes = [], rays = [];
    const tw = twinklers(28, .55);
    // la mer de nuages : une bande peinte une fois, qui boucle sur sa largeur ; des bosses rondes sur le dessus
    function sea(S, seed, y0, depth) {
      const r = seeded(seed), w = Math.ceil(S.W * 1.5), h = Math.ceil(S.H - y0 + G.u * 8), cv = doc.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d'), D = S.dark;
      const body = D ? (depth ? '#2c2a55' : '#3b3567') : (depth ? '#f6e7ee' : '#fff7f2'), top = D ? (depth ? '#4a4380' : '#6a5a96') : '#ffffff', shade = D ? '#1d1b3d' : (depth ? '#e7cfe0' : '#f1dcd9');
      // un corps plein un peu plus bas, puis deux rangées de bosses qui dépassent : le dessus n'a jamais de bord droit
      g.fillStyle = body; g.fillRect(0, G.u * 10, w, h);
      for (let i = 0; i < Math.round(w / (G.u * 2.6)); i++) {
        const back = i % 2, x = r() * w, rad = G.u * (3 + r() * 5) * (depth ? .8 : 1.2) * (back ? .8 : 1.1), y = G.u * (back ? 6 : 9.5) + rad * (.1 + r() * .35);
        for (const ox of [x - w, x, x + w]) {
          if (ox + rad < 0 || ox - rad > w) continue;
          const gr = g.createRadialGradient(ox - rad * .2, y - rad * .5, rad * .1, ox, y, rad);
          gr.addColorStop(0, top); gr.addColorStop(.7, body); gr.addColorStop(1, shade);
          ell(g, ox, y, rad, rad * .62); g.fillStyle = gr; g.fill();
        }
      }
      return { cv, w, h, y0 };
    }
    // la porte (piliers, arche, soleil) peinte une fois ; l'ouverture reste transparente
    function frame(S) {
      const { gw, gh } = G, pw = gw * .15, cv = doc.createElement('canvas'), pad = gw * .2;
      cv.width = Math.ceil(gw + pad * 2); cv.height = Math.ceil(gh + gw * .35);
      const g = cv.getContext('2d'), D = S.dark, ox = cv.width / 2, oy = cv.height, ri = gw / 2 - pw, cy = oy - G.spring;
      const stone = D ? '#3d3760' : '#fffaf0', stone2 = D ? '#2b2648' : '#efe3cc', gold = D ? '#f5c66a' : '#c99a2e';
      const sg = g.createLinearGradient(ox - gw / 2, 0, ox + gw / 2, 0); sg.addColorStop(0, stone2); sg.addColorStop(.25, stone); sg.addColorStop(.75, stone); sg.addColorStop(1, stone2);
      g.fillStyle = sg;
      // l'arche et les deux piliers, en un seul tracé (le vide intérieur découpé)
      g.beginPath();
      g.moveTo(ox - gw / 2, oy); g.lineTo(ox - gw / 2, cy); g.arc(ox, cy, gw / 2, Math.PI, 0); g.lineTo(ox + gw / 2, oy);
      g.lineTo(ox + ri, oy); g.lineTo(ox + ri, cy); g.arc(ox, cy, ri, 0, Math.PI, true); g.lineTo(ox - ri, oy); g.closePath();
      g.fill();
      g.strokeStyle = gold; g.lineWidth = Math.max(1, gw * .012);
      g.beginPath(); g.arc(ox, cy, gw / 2 - pw * .18, Math.PI, 0); g.stroke();
      g.beginPath(); g.arc(ox, cy, ri + pw * .18, Math.PI, 0); g.stroke();
      // cannelures et chapiteaux des piliers
      for (const s of [-1, 1]) {
        const x0 = ox + s * (gw / 2 - pw / 2);
        g.strokeStyle = D ? 'rgba(245,198,106,.35)' : 'rgba(201,154,46,.4)'; g.lineWidth = Math.max(1, pw * .06);
        for (const k of [-.25, 0, .25]) { g.beginPath(); g.moveTo(x0 + k * pw, oy); g.lineTo(x0 + k * pw, cy + pw * .4); g.stroke(); }
        g.fillStyle = gold; g.fillRect(x0 - pw * .62, cy - pw * .12, pw * 1.24, pw * .24); g.fillRect(x0 - pw * .62, cy + gh * .08, pw * 1.24, pw * .1);
      }
      // le soleil géométrique au sommet de l'arche
      const sx = ox, sy = cy - gw / 2 - gw * .02, sr = gw * .1;
      g.fillStyle = gold;
      for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, L = sr * (i % 2 ? 1.6 : 2.1); g.beginPath(); g.moveTo(sx + Math.cos(a - .1) * sr * .9, sy + Math.sin(a - .1) * sr * .9); g.lineTo(sx + Math.cos(a) * L, sy + Math.sin(a) * L); g.lineTo(sx + Math.cos(a + .1) * sr * .9, sy + Math.sin(a + .1) * sr * .9); g.fill(); }
      ell(g, sx, sy, sr, sr); g.fillStyle = D ? '#ffe2a3' : '#f2c95b'; g.fill(); g.strokeStyle = gold; g.stroke();
      return { cv, ox, oy, pad };
    }
    // un battant : des barreaux, deux cercles et une bordure dorée ; o = ouverture (0 fermé, 1 ouvert à plat)
    function leaf(g, S, side, o) {
      const { gw } = G, pw = gw * .15, ri = gw / 2 - pw, x0 = G.cx + side * ri, top = G.base - G.spring, w = ri * Math.cos(o * 1.35), D = S.dark;
      const gold = D ? `rgba(245,198,106,${(.95 - o * .4).toFixed(2)})` : `rgba(180,135,40,${(.95 - o * .3).toFixed(2)})`;
      g.save();
      g.beginPath(); g.rect(G.cx - ri, top - ri, ri * 2, G.base - top + ri); g.clip();
      g.translate(x0, 0); g.scale(-side * Math.max(.02, w / ri), 1);
      g.strokeStyle = gold; g.lineWidth = Math.max(1, gw * .01);
      // la bordure du battant suit l'arche
      g.beginPath(); g.moveTo(0, G.base); g.lineTo(0, top); g.arc(ri, top, ri, Math.PI, Math.PI * 1.5); g.lineTo(ri, G.base); g.stroke();
      for (let k = 1; k < 6; k++) { const x = ri * k / 6, yt = top - Math.sqrt(Math.max(0, ri * ri - (ri - x) * (ri - x))); g.beginPath(); g.moveTo(x, G.base); g.lineTo(x, yt); g.stroke(); }
      for (const y of [G.base - (G.base - top) * .35, G.base - (G.base - top) * .75]) { ell(g, ri * .5, y, ri * .28, ri * .28); g.stroke(); }
      g.beginPath(); g.moveTo(0, G.base - (G.base - top) * .55); g.lineTo(ri, G.base - (G.base - top) * .55); g.stroke();
      g.restore();
    }
    // l'ouverture des battants : fermé, s'ouvre, reste ouvert, se referme (40 s) ; déjà bien ouvert au départ
    const openAt = T => { const c = (T + 15) % 40; return c < 8 ? 0 : c < 15 ? ease((c - 8) / 7) : c < 32 ? 1 : c < 39 ? 1 - ease((c - 32) / 7) : 0; };
    const st = stage(layer, 'wsg', {
      layout(S) {
        // jamais derrière le texte du site : sur le côté droit en paysage (le site est au milieu), en bas au milieu en
        // portrait (sous le texte, derrière les panneaux)
        const wide = S.W > S.H * 1.2;
        G = { u: clamp(Math.min(S.W, S.H) / 100, 3.6, 11), cx: wide ? S.W * .84 : S.W / 2, base: S.H * (wide ? .88 : 1), wide };
        G.gw = wide ? Math.min(S.W * .2, S.H * .34) : Math.min(S.W * .4, S.H * .17);
        G.gh = G.gw * 1.25; G.spring = G.gh - G.gw / 2; G.seaY = S.H * (wide ? .8 : .9);
        seaFar = sea(S, 3, G.seaY - G.u * 6, 1); seaNear = sea(S, 8, G.base - G.u * 4, 0); gate = frame(S);
        // les rayons : un éventail de 11 pointes, une sur deux dans chaque canevas, posés derrière le canevas animé
        const L = Math.round(G.wide ? Math.min(S.H * .7, G.gw * 3.4) : G.gw * 1.9), oy = G.base - G.spring - (G.gw / 2 - G.gw * .15) * .2;
        rays.forEach(cv => cv.remove());
        G.rays = rays = [0, 1].map(odd => {
          const cv = doc.createElement('canvas'); cv.width = Math.ceil(L / 2) * 2; cv.height = Math.ceil(L / 2);
          cv.className = 'wsg-rays'; cv.style.cssText = `left:${G.cx - L}px;top:${oy - L}px;width:${L * 2}px;height:${L}px;opacity:0`;
          layer.insertBefore(cv, layer.querySelector('.wsg-fg'));
          const g = cv.getContext('2d'); g.scale(.5, .5);
          const gr = g.createRadialGradient(L, L, 0, L, L, L);
          gr.addColorStop(0, 'rgba(255,228,160,1)'); gr.addColorStop(.6, 'rgba(255,228,160,.3)'); gr.addColorStop(1, 'rgba(255,228,160,0)');
          g.fillStyle = gr;
          for (let i = odd; i < 11; i += 2) { const a = -Math.PI / 2 + (i - 5) * .2, w = odd ? .035 : .05; g.beginPath(); g.moveTo(L, L); g.arc(L, L, L, a - w, a + w); g.closePath(); g.fill(); }
          return cv;
        });
        S.fgTop = Math.max(0, G.base - G.gh - G.gw * .3 - S.H * .25);
        // la lueur de la porte sur les nuages du fond, peinte une fois (petite, puis agrandie)
        { const r0 = Math.round(G.gw * 1.7), cv = doc.createElement('canvas'); cv.width = cv.height = r0; const g = cv.getContext('2d'), gl = g.createRadialGradient(r0 / 2, r0 / 2, 0, r0 / 2, r0 / 2, r0 / 2);
          gl.addColorStop(0, S.dark ? 'rgba(253,200,120,.38)' : 'rgba(255,214,140,.5)'); gl.addColorStop(1, 'rgba(253,200,120,0)'); g.fillStyle = gl; g.fillRect(0, 0, r0, r0);
          G.glow = doc.createElement('canvas'); G.glow.width = G.glow.height = r0 * 2; G.glow.getContext('2d').drawImage(cv, 0, 0, r0 * 2, r0 * 2); }
        if (!motes.length) motes = Array.from({ length: 34 }, () => ({ x: rnd(-1, 1), y: Math.random(), v: rnd(.03, .07), r: rnd(.5, 1.4), ph: rnd(0, 7) }));
      },
      paint(S, g) {
        if (S.dark) { starfield(g, S.W, S.H * .7, Math.round(S.W * S.H / 3000), 41, '255,255,255', .7); calm(g, S, '12,10,36', .35); }
        else calm(g, S, '255,248,244', .6);
        // une grande lueur derrière la porte
        const gl = g.createRadialGradient(G.cx, G.base - G.gh * .45, 0, G.cx, G.base - G.gh * .45, G.gw * (G.wide ? 2.4 : 1.6));
        gl.addColorStop(0, S.dark ? 'rgba(253,200,120,.22)' : 'rgba(255,220,150,.45)'); gl.addColorStop(1, 'rgba(253,200,120,0)');
        g.fillStyle = gl; g.fillRect(0, 0, S.W, S.H);
      },
      update(S, dt) { for (const m of motes) { m.y += m.v * dt; if (m.y > 1) { m.y = 0; m.x = rnd(-1, 1); } } },
      draw(S, g) {
        const D = S.dark, T = S.T, o = openAt(T), { gw, cx, base } = G, ri = gw / 2 - gw * .15, top = base - G.spring, scroll = T * G.u * .9;
        if (D) twinkle(g, tw, S.W, S.H, '255,255,255', .8, T);
        // les rayons : deux canevas peints une fois, que le navigateur fait seulement tourner et pâlir (opacity et
        // transform : aucun nouveau dessin) ; ils s'effacent bien avant le haut de l'écran
        G.rays.forEach((cv, i) => { cv.style.opacity = (o * (D ? .2 : .34) * (i ? .75 : 1)).toFixed(3); cv.style.transform = `rotate(${(Math.sin(T * (.25 + i * .07) + i * 2) * .025).toFixed(4)}rad)`; });
        // la nappe de nuages du fond
        const sx = -(scroll * .5 % seaFar.w); g.drawImage(seaFar.cv, sx, seaFar.y0); g.drawImage(seaFar.cv, sx + seaFar.w, seaFar.y0);
        // la lumière de la porte sur le dessus des nuages du fond
        g.drawImage(G.glow, cx - G.glow.width / 2, G.seaY - G.glow.height / 2);
        // la lumière dans l'ouverture : plus vive quand la porte est ouverte
        g.save(); g.beginPath(); g.moveTo(cx - ri, base); g.lineTo(cx - ri, top); g.arc(cx, top, ri, Math.PI, 0); g.lineTo(cx + ri, base); g.closePath(); g.clip();
        const li = g.createLinearGradient(0, top - ri, 0, base);
        li.addColorStop(0, D ? `rgba(255,236,190,${(.35 + .55 * o).toFixed(2)})` : `rgba(255,250,232,${(.55 + .45 * o).toFixed(2)})`); li.addColorStop(1, D ? `rgba(253,186,116,${(.25 + .5 * o).toFixed(2)})` : `rgba(255,214,150,${(.5 + .4 * o).toFixed(2)})`);
        g.fillStyle = li; g.fillRect(cx - ri, top - ri, ri * 2, base - top + ri);
        const mid = g.createRadialGradient(cx, base - (base - top) * .4, 0, cx, base - (base - top) * .4, ri * (.4 + 1.2 * o));
        mid.addColorStop(0, `rgba(255,255,255,${(.9 * o).toFixed(2)})`); mid.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = mid; g.fillRect(cx - ri, top - ri, ri * 2, base - top + ri);
        g.restore();
        leaf(g, S, -1, o); leaf(g, S, 1, o);
        g.drawImage(gate.cv, cx - gate.ox, base - gate.oy);
        // les poussières de lumière qui montent de l'ouverture
        for (const m of motes) {
          const y = base - (base - top + ri) * .3 - m.y * S.H * .45, x = cx + m.x * ri * (1 + m.y * 2.5) + Math.sin(T * .8 + m.ph) * G.u, a = (D ? .8 : .7) * Math.sin(m.y * Math.PI) * (.35 + .65 * o);
          g.fillStyle = D ? `rgba(255,226,160,${a.toFixed(3)})` : `rgba(214,160,50,${a.toFixed(3)})`; ell(g, x, y, m.r * G.u * .25, m.r * G.u * .25); g.fill();
        }
        const nx = -(scroll % seaNear.w); g.drawImage(seaNear.cv, nx, seaNear.y0); g.drawImage(seaNear.cv, nx + seaNear.w, seaNear.y0);
      },
      stop() { rays.forEach(cv => cv.remove()); },
      debug(S, what) { if (what === 'open') S.T = 10; if (what === 'closed') S.T = 26; st.redraw(); return { o: openAt(S.T) }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * ♾️ Aether, la bille lumineuse (idée d'Angelicide9, 2026-10-21) : « une boule lumineuse suit toujours le tracé, et plus
   * le nombre est bon, plus elle va vite ; le signe infini brille de la couleur de la rareté : gris pour Common, vert
   * Uncommon, bleu Rare, violet Epic, orange Anomaly, blanc Mythic, bleu clair Celestial, jaune Divine, rouge Godlike et
   * arc-en-ciel pour Infinite ». Le signe et les réactions restent en CSS (.wp-aether) ; ce canevas suit exactement le
   * même tracé que le SVG du fond (viewBox -6 -6 112 62, centré, largeur min(88vw, 900px), à 42 % de la hauteur).
   * La couleur reste jusqu'au tirage suivant ; avant le premier tirage, la bille est blanc-violet et le signe tel quel.
   */
  SCENES.aether = layer => {
    const COL = { landwaste: '107,114,128', garbage: '107,114,128', trash: '107,114,128', common: '156,163,175', uncommon: '34,197,94', rare: '59,130,246', epic: '168,85,247', anomaly: '249,115,22', mythic: '255,255,255', celestial: '125,211,252', divine: '250,204,21', godlike: '239,68,68' };
    // en clair, des teintes plus soutenues (le blanc de Mythic deviendrait invisible sur le fond pâle)
    const COL_LIGHT = Object.assign({}, COL, { common: '107,114,128', mythic: '100,116,139', celestial: '14,165,233', divine: '202,138,4' });
    // secondes par tour selon la rareté (rang -2 à 10) ; avant le premier tirage : 9 s
    const LOOP = [14, 12, 10, 8, 6.5, 5, 4, 3.2, 2.5, 2, 1.6, 1.2, .8];
    const SEGS = [[50, 25, 62, 8, 96, 2, 96, 25], [96, 25, 96, 48, 62, 42, 50, 25], [50, 25, 38, 8, 4, 2, 4, 25], [4, 25, 4, 48, 38, 42, 50, 25]];
    // le tracé rééchantillonné à pas égaux (en unités du viewBox), une fois pour toutes
    const M = 720, base = [];
    {
      const raw = [];
      for (const [x0, y0, x1, y1, x2, y2, x3, y3] of SEGS) for (let i = 0; i < 240; i++) { const t = i / 240, w = 1 - t; raw.push([w * w * w * x0 + 3 * w * w * t * x1 + 3 * w * t * t * x2 + t * t * t * x3, w * w * w * y0 + 3 * w * w * t * y1 + 3 * w * t * t * y2 + t * t * t * y3]); }
      raw.push(raw[0]);
      const acc = [0]; for (let i = 1; i < raw.length; i++) acc.push(acc[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
      const total = acc[acc.length - 1];
      for (let k = 0, j = 1; k < M; k++) { const s = k / M * total; while (acc[j] < s) j++; const f = (s - acc[j - 1]) / (acc[j] - acc[j - 1] || 1); base.push([raw[j - 1][0] + (raw[j][0] - raw[j - 1][0]) * f, raw[j - 1][1] + (raw[j][1] - raw[j - 1][1]) * f]); }
    }
    let G = {}, pts = [], pos = .02, speed = 1 / 9, target = 1 / 9, tier = null, flare = 0;
    const P = f => pts[((Math.floor(f * M) % M) + M) % M];
    const rgbOf = (S, f, T) => (tier === 'infinite' ? hsl((f * 720 + T * 160) % 360, S) : (S.dark ? COL : COL_LIGHT)[tier] || (S.dark ? '216,200,255' : '124,58,237'));
    const hsl = (h, S) => { const l = S.dark ? .62 : .45, a = .9 * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return `${f(0)},${f(8)},${f(4)}`; };
    const st = stage(layer, 'wae', {
      layout(S) {
        const w = Math.min(S.W * .88, 900), h = w * 62 / 112, left = (S.W - w) / 2, top = (S.H - h) * .42, k = w / 112;
        G = { k, w };
        pts = base.map(([x, y]) => [left + (x + 6) * k, top + (y + 6) * k]);
        S.fgTop = Math.max(0, top - k * 12); S.fgH = h + k * 24;
      },
      update(S, dt) {
        speed += (target - speed) * Math.min(1, dt * 1.6);
        pos = (pos + speed * dt) % 1;
        flare = Math.max(0, flare - dt / 2.6);
      },
      draw(S, g) {
        const D = S.dark, T = S.T, k = G.k;
        g.save(); g.globalCompositeOperation = D ? 'lighter' : 'source-over'; g.lineCap = 'round'; g.lineJoin = 'round';
        // le signe brille de la couleur de la rareté (fort à la révélation, puis une lueur qui reste)
        if (tier) {
          const a = .14 + .66 * flare, CH = tier === 'infinite' ? 48 : 1;
          g.lineCap = 'butt'; // les tronçons de l'arc-en-ciel se touchent sans se chevaucher (pas de points clairs)
          for (const [lw, al] of [[3.6, .22], [1.6, .45], [.55, .9]]) {
            g.lineWidth = Math.max(1, lw * k);
            for (let c = 0; c < CH; c++) {
              g.strokeStyle = `rgba(${rgbOf(S, c / CH, T)},${(a * al).toFixed(3)})`;
              g.beginPath(); const i0 = Math.floor(c / CH * M), i1 = Math.floor((c + 1) / CH * M);
              for (let i = i0; i <= i1; i++) { const p = pts[i % M]; i === i0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]); }
              g.stroke();
            }
          }
        }
        g.lineCap = 'round';
        // la traînée : plus longue quand la bille va vite
        // la traînée : des traits emboîtés qui partent tous de la bille, de plus en plus longs et fins ; leurs opacités
        // s'additionnent près de la bille et s'effacent vers l'arrière, sans aucun joint (des ronds séparés faisaient des
        // perles à grande vitesse, des tronçons bout à bout des coutures)
        const tl = clamp(speed * .45, .04, .3), n = 10, step = 1 / M;
        g.globalCompositeOperation = 'source-over'; g.lineCap = 'round'; g.lineJoin = 'round';
        for (let j = 1; j <= n; j++) {
          const q = j / n, f0 = pos - tl * q;
          g.strokeStyle = `rgba(${rgbOf(S, pos - tl * q * .5, T)},.13)`; g.lineWidth = k * (2.9 - 2 * q);
          g.beginPath(); for (let f = f0; f <= pos; f += step) { const p = P(f); f === f0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1]); } g.stroke();
        }
        g.globalCompositeOperation = D ? 'lighter' : 'source-over';
        // la bille : un halo de la couleur, un cœur blanc
        const p = P(pos), c = rgbOf(S, pos, T), R0 = k * (2 + 1.4 * flare);
        const halo = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], R0 * 2.5);
        halo.addColorStop(0, `rgba(${c},.8)`); halo.addColorStop(.35, `rgba(${c},.3)`); halo.addColorStop(1, `rgba(${c},0)`);
        g.fillStyle = halo; g.fillRect(p[0] - R0 * 2.5, p[1] - R0 * 2.5, R0 * 5, R0 * 5);
        g.globalCompositeOperation = 'source-over';
        ell(g, p[0], p[1], k * 1.25, k * 1.25); g.fillStyle = D ? '#ffffff' : `rgb(${c})`; g.fill();
        if (!D) { g.fillStyle = 'rgba(255,255,255,.85)'; ell(g, p[0] - k * .35, p[1] - k * .35, k * .45, k * .45); g.fill(); }
        g.restore();
      },
      roll(S, t, n, rank) {
        if (!t) return;
        tier = t; flare = 1;
        target = 1 / LOOP[clamp((rank == null ? 1 : rank) + 2, 0, LOOP.length - 1)];
        if (S.still) speed = target;
      },
      debug(S, what) { return { tier, speed: Math.round(1 / speed * 100) / 100, pos: Math.round(pos * 1000) / 1000 }; },
    });
    return st;
  };

  /* ===============================================================================================================
   * Fonds d'idées de joueurs du 2026-11-05, lot « lieux » : World Map, Pyramids, Ice Caps, Circus.
   */

  /* ---------------------------------------------------------------------------------------------------------------
   * 🗺️ World Map (idée de qwertyuiop, 2026-10-29, aussi demandée par Jguz01 « les 7 continents » et ichi « un fond
   * monde ») : le monde en points, comme une carte lumineuse. Les sept continents sont des polygones grossiers
   * (longitude, latitude) passés dans une grille de points une fois pour toutes ; la carte défile lentement vers la gauche
   * et boucle, comme un globe qui tourne. Les lumières des grandes villes scintillent et, de temps en temps, un vol trace un
   * arc d'une ville à l'autre. Thème sombre : la nuit, des points cyan sur un océan bleu nuit ; thème clair : une carte
   * marine pâle, des points vert sauge, et une rose des vents.
   */
  const WORLD = [
    // Amérique du Nord, Groenland, Amérique du Sud
    [[-168, 66], [-162, 70], [-140, 70], [-125, 72], [-95, 72], [-80, 73], [-62, 66], [-55, 52], [-66, 45], [-76, 38], [-81, 31], [-80, 25], [-84, 30], [-90, 29], [-97, 26], [-97, 21], [-90, 21], [-87, 15], [-83, 9], [-78, 8], [-80, 7], [-86, 12], [-92, 15], [-105, 20], [-110, 24], [-115, 31], [-118, 34], [-124, 40], [-124, 48], [-133, 56], [-148, 60], [-158, 57], [-165, 61]],
    [[-55, 60], [-44, 60], [-20, 70], [-20, 80], [-40, 83], [-60, 82], [-70, 77], [-58, 70]],
    [[-80, 8], [-72, 12], [-62, 11], [-50, 1], [-35, -5], [-38, -13], [-48, -25], [-58, -35], [-65, -41], [-68, -52], [-74, -53], [-73, -40], [-71, -30], [-70, -18], [-76, -14], [-81, -5], [-80, 1]],
    // Europe et Asie (un seul bloc), Afrique, Madagascar
    [[-10, 36], [-9, 43], [-2, 44], [-5, 48], [2, 51], [8, 54], [10, 57], [5, 62], [14, 68], [25, 71], [40, 68], [60, 70], [70, 73], [80, 73], [100, 77], [115, 74], [140, 72], [160, 70], [180, 68], [180, 65], [170, 60], [160, 58], [156, 51], [142, 47], [140, 40], [130, 42], [127, 35], [121, 31], [120, 24], [110, 20], [106, 10], [100, 13], [100, 3], [104, 1], [98, 8], [92, 22], [80, 15], [77, 8], [72, 20], [66, 25], [57, 25], [56, 27], [50, 30], [48, 29], [51, 24], [56, 26], [59, 22], [52, 16], [43, 12], [39, 20], [34, 28], [32, 31], [35, 36], [27, 37], [24, 40], [20, 40], [18, 40], [15, 38], [12, 44], [8, 44], [3, 43], [-1, 37], [-6, 36]],
    [[-17, 15], [-17, 21], [-13, 28], [-9, 32], [-5, 36], [10, 37], [11, 33], [20, 31], [32, 31], [34, 28], [43, 12], [51, 12], [42, -1], [40, -10], [35, -24], [32, -29], [27, -34], [19, -35], [16, -29], [12, -17], [13, -6], [9, -1], [9, 4], [4, 6], [-8, 4], [-13, 8]],
    [[44, -25], [47, -25], [50, -15], [49, -12], [44, -17]],
    // Océanie, Antarctique, et quelques îles qu'on reconnaît
    [[114, -22], [122, -18], [130, -12], [137, -12], [142, -11], [146, -19], [153, -26], [150, -37], [140, -38], [132, -32], [115, -35]],
    [[-180, -72], [-120, -73], [-60, -64], [-57, -63], [-60, -70], [0, -70], [60, -67], [120, -66], [180, -70], [180, -90], [-180, -90]],
    [[-6, 50], [2, 51], [-2, 58], [-6, 58]], [[130, 31], [141, 36], [142, 45], [139, 40]], [[95, 5], [106, -6], [115, -8], [119, -5], [117, 6], [109, 2], [100, 0]],
    [[131, -1], [150, -6], [147, -10], [138, -8]], [[172, -41], [178, -38], [174, -46], [167, -46]], [[-24, 64], [-14, 64], [-15, 66], [-23, 66]],
  ];
  // de grandes villes (longitude, latitude) : leurs lumières et les vols
  const CITIES = [[-74, 41], [-118, 34], [-87, 42], [-99, 19], [-46, -23], [-58, -35], [-77, -12], [-0, 51], [2, 49], [13, 52], [37, 56], [28, 41], [31, 30], [3, 6], [36, -1], [18, -34], [55, 25], [72, 19], [77, 29], [88, 22], [100, 14], [104, 1], [116, 40], [121, 31], [114, 22], [127, 37], [139, 36], [151, -34], [145, -38], [174, -37], [-123, 49], [-80, 26], [-3, 40], [12, 42], [30, 50], [44, 33], [67, 25]];
  function inPoly(x, y, P) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
    return c;
  }
  SCENES.worldmap = layer => {
    let G = {}, map = null, flights = [], nextFlight = rnd(1, 2.5), off = 0;
    const lit = CITIES.map(c => ({ c, ph: rnd(0, 7), sp: rnd(.8, 1.8) }));
    // longitude, latitude → point de la carte (avant défilement) ; la carte va de 84° N à 84° S
    const xy = (lon, lat) => [(lon + 180) / 360 * G.mw, (84 - lat) / 168 * G.mh];
    function paintMap(S) {
      const cv = doc.createElement('canvas'); cv.width = Math.ceil(G.mw); cv.height = Math.ceil(G.mh);
      const g = cv.getContext('2d'), D = S.dark, step = 1.5, d = G.mw / 360 * step;
      // le quadrillage (méridiens et parallèles tous les 30°)
      g.strokeStyle = D ? 'rgba(103,232,249,.07)' : 'rgba(30,64,90,.09)'; g.lineWidth = 1;
      for (let lon = -180; lon < 180; lon += 30) { const [x] = xy(lon, 0); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, G.mh); g.stroke(); }
      for (let lat = -60; lat <= 60; lat += 30) { const [, y] = xy(0, lat); g.beginPath(); g.moveTo(0, y); g.lineTo(G.mw, y); g.stroke(); }
      const r = seeded(5);
      for (let lat = 84 - step / 2; lat > -84; lat -= step) for (let lon = -180 + step / 2; lon < 180; lon += step) {
        if (!WORLD.some(P => inPoly(lon, lat, P))) continue;
        const [x, y] = xy(lon, lat), k = r(), rad = d * (.26 + k * .1);
        g.fillStyle = D ? `rgba(94,234,212,${(.38 + .3 * k).toFixed(2)})` : `rgba(74,122,92,${(.38 + .25 * k).toFixed(2)})`;
        ell(g, x, y, rad, rad); g.fill();
      }
      return cv;
    }
    // un vol : un arc (courbe de Bézier relevée vers le pôle) d'une ville à une autre, assez loin
    function newFlight() {
      let a, b; do { a = pick(CITIES); b = pick(CITIES); } while (a === b || Math.abs(a[0] - b[0]) < 25 || Math.abs(a[0] - b[0]) > 150);
      flights.push({ a, b, t: 0, dur: rnd(5, 8) });
    }
    const st = stage(layer, 'wwm', {
      layout(S) {
        const portrait = S.H > S.W;
        G = { mh: S.H * (portrait ? .62 : .94), u: clamp(Math.min(S.W, S.H) / 100, 3.6, 11) };
        G.mw = G.mh * 360 / 168; G.my = (S.H - G.mh) * (portrait ? .62 : .5);
        // la carte doit couvrir l'écran en largeur pour boucler sans trou
        if (G.mw < S.W) { G.mw = S.W; G.mh = G.mw * 168 / 360; G.my = (S.H - G.mh) / 2; }
        map = paintMap(S);
        calmEl(layer, S, S.dark ? '4,13,26' : '249,252,252', S.dark ? .6 : .9, 1.3);
      },
      paint(S, g) {
        if (S.dark) {
          const gl = g.createRadialGradient(S.W / 2, S.H / 2, 0, S.W / 2, S.H / 2, Math.max(S.W, S.H) * .7);
          gl.addColorStop(0, 'rgba(14,116,144,.14)'); gl.addColorStop(1, 'rgba(14,116,144,0)'); g.fillStyle = gl; g.fillRect(0, 0, S.W, S.H);
        } else {
          // une rose des vents, en bas à droite
          const cx = S.W * .9, cy = S.H * .86, R0 = G.u * 6;
          g.save(); g.translate(cx, cy); g.strokeStyle = 'rgba(30,64,90,.35)'; g.fillStyle = 'rgba(30,64,90,.28)'; g.lineWidth = 1;
          ell(g, 0, 0, R0, R0); g.stroke(); ell(g, 0, 0, R0 * .8, R0 * .8); g.stroke();
          for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, L = i % 2 ? R0 * .6 : R0 * 1.1; g.beginPath(); g.moveTo(Math.cos(a) * L, Math.sin(a) * L); g.lineTo(Math.cos(a + .25) * R0 * .18, Math.sin(a + .25) * R0 * .18); g.lineTo(Math.cos(a - .25) * R0 * .18, Math.sin(a - .25) * R0 * .18); g.closePath(); g.fill(); }
          g.font = `700 ${Math.round(R0 * .35)}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.fillText('N', 0, -R0 * 1.2);
          g.restore();
        }
      },
      update(S, dt) {
        off = (off + dt * G.mw / 240) % G.mw; // un tour du monde en 4 minutes
        if (S.T > nextFlight && flights.length < 3) { newFlight(); nextFlight = S.T + rnd(2.5, 5); }
        for (const f of flights) f.t += dt;
        flights = flights.filter(f => f.t < f.dur + 1.5);
      },
      draw(S, g) {
        const D = S.dark, x0 = -off;
        for (let x = x0; x < S.W; x += G.mw) g.drawImage(map, x, G.my);
        // (le voile calme derrière le texte est un élément CSS par-dessus : calmEl)
        const at = (lon, lat) => { const [x, y] = xy(lon, lat); let X = x - off; while (X < -G.mw * .5) X += G.mw; return [X, y + G.my]; };
        for (const c of lit) {
          const [x, y] = at(c.c[0], c.c[1]); if (x < -10 || x > S.W + 10) continue;
          const k = .55 + .45 * Math.sin(S.T * c.sp + c.ph), q = 1 - .7 * quiet(S, x, y), R0 = G.u * .9 * (.7 + .3 * k);
          const gr = g.createRadialGradient(x, y, 0, x, y, R0 * 2.5);
          gr.addColorStop(0, D ? `rgba(253,224,71,${(.85 * k * q).toFixed(3)})` : `rgba(217,119,6,${(.7 * k * q).toFixed(3)})`); gr.addColorStop(1, 'rgba(253,224,71,0)');
          g.fillStyle = gr; g.fillRect(x - R0 * 2.5, y - R0 * 2.5, R0 * 5, R0 * 5);
        }
        g.lineCap = 'round';
        for (const f of flights) {
          let [ax, ay] = at(f.a[0], f.a[1]), [bx, by] = at(f.b[0], f.b[1]);
          if (Math.abs(bx - ax) > G.mw / 2) bx += bx < ax ? G.mw : -G.mw; // le plus court, par-dessus le bord de la carte
          const cx = (ax + bx) / 2, cy = Math.min(ay, by) - Math.abs(bx - ax) * .28, q = clamp(f.t / f.dur, 0, 1), fade = clamp(1 - (f.t - f.dur) / 1.5, 0, 1);
          const B = t => [(1 - t) * (1 - t) * ax + 2 * t * (1 - t) * cx + t * t * bx, (1 - t) * (1 - t) * ay + 2 * t * (1 - t) * cy + t * t * by];
          g.strokeStyle = D ? `rgba(165,243,252,${(.45 * fade).toFixed(3)})` : `rgba(30,64,90,${(.45 * fade).toFixed(3)})`; g.lineWidth = 1.3;
          g.setLineDash([4, 5]); g.beginPath(); for (let i = 0; i <= 30; i++) { const [x, y] = B(q * i / 30); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.setLineDash([]);
          if (q < 1) { const [x, y] = B(q); g.fillStyle = D ? '#ecfeff' : '#1e3a5a'; ell(g, x, y, G.u * .35, G.u * .35); g.fill(); }
        }
      },
      stop() { const c = layer.querySelector(':scope > .wcalm'); if (c) c.remove(); },
      debug(S, what) { if (what === 'flight') { newFlight(); flights[flights.length - 1].t = 2.5; } return { flights: flights.length, off }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🏜️ Pyramids (idée de whywhywaylon, 2026-10-29) : « un fond des pyramides de Gizeh ». Le désert à l'heure dorée :
   * les trois grandes pyramides en perspective (la grande à gauche, la plus petite à droite) et un petit sphinx, des dunes
   * sur plusieurs plans, le soleil bas derrière. Une caravane de chameaux traverse les dunes très lentement, du sable
   * file au ras du sol et un faucon tourne dans le ciel. Thème sombre : la nuit, la lune, les étoiles, les pyramides
   * gris-bleu sous la lune et une lanterne qui se balance au cou du premier chameau.
   * (le skin « tablette de pierre » de la même idée est pour la session des skins)
   */
  SCENES.pyramids = layer => {
    const R = Math.random;
    let G = {}, caravan = null, wisps = [], hawk = { a: 0 };
    // une pyramide vue de trois quarts : la face au soleil claire, l'autre à l'ombre, des assises en lignes fines
    function pyramid(g, S, x, base, w, h, P) {
      const apex = [x + w * .08, base - h], L = [x - w / 2, base], M = [x + w * .2, base + h * .02], Rr = [x + w / 2, base - h * .02];
      g.fillStyle = P.lit; g.beginPath(); g.moveTo(...apex); g.lineTo(...L); g.lineTo(...M); g.closePath(); g.fill();
      g.fillStyle = P.shade; g.beginPath(); g.moveTo(...apex); g.lineTo(...M); g.lineTo(...Rr); g.closePath(); g.fill();
      g.strokeStyle = P.course; g.lineWidth = 1;
      for (let k = 1; k < 14; k++) {
        const t = k / 14, y = apex[1] + (base - apex[1]) * t;
        g.beginPath(); g.moveTo(apex[0] + (L[0] - apex[0]) * t, y); g.lineTo(apex[0] + (M[0] - apex[0]) * t, apex[1] + (M[1] - apex[1]) * t); g.lineTo(apex[0] + (Rr[0] - apex[0]) * t, apex[1] + (Rr[1] - apex[1]) * t); g.stroke();
      }
    }
    function dune(g, S, y0, amp, freq, ph, col) {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, S.H);
      for (let x = 0; x <= S.W + 8; x += 8) g.lineTo(x, y0 - amp * (Math.sin(x / S.W * freq + ph) * .6 + Math.sin(x / S.W * freq * 2.3 + ph * 2) * .4));
      g.lineTo(S.W, S.H); g.fill();
    }
    const duneY = (S, x) => G.d1 - G.u * 2 * (Math.sin(x / S.W * 3 + 1) * .6 + Math.sin(x / S.W * 6.9 + 2) * .4);
    // un chameau de profil (vers la droite) : corps, bosse, long cou, pattes qui marchent
    function camel(g, s, T, ph, col, lantern) {
      const step = Math.sin(T * 3.2 + ph), bob = Math.abs(Math.cos(T * 3.2 + ph)) * s * .04;
      g.save(); g.translate(0, -bob); g.fillStyle = col; g.strokeStyle = col; g.lineCap = 'round';
      g.lineWidth = s * .09;
      for (const [x, k] of [[-.32, 1], [-.22, -1], [.2, -1], [.3, 1]]) { const sw = step * k * .12; g.beginPath(); g.moveTo(s * x, -s * .55); g.lineTo(s * (x + sw), -s * .02 + bob); g.stroke(); }
      ell(g, 0, -s * .68, s * .44, s * .2); g.fill();
      ell(g, -s * .05, -s * .86, s * .2, s * .17); g.fill();
      g.lineWidth = s * .12; g.beginPath(); g.moveTo(s * .38, -s * .72); g.quadraticCurveTo(s * .62, -s * .8, s * .6, -s * 1.12); g.stroke();
      ell(g, s * .67, -s * 1.13, s * .12, s * .07); g.fill();
      g.lineWidth = s * .04; g.beginPath(); g.moveTo(-s * .43, -s * .7); g.quadraticCurveTo(-s * .52, -s * .55, -s * .48, -s * .45); g.stroke();
      if (lantern) {
        const sw = Math.sin(T * 2.4 + ph) * .3, lx = s * .55 + Math.sin(sw) * s * .14, ly = -s * .86 + Math.cos(sw) * s * .14;
        g.lineWidth = 1; g.strokeStyle = col; g.beginPath(); g.moveTo(s * .55, -s * .86); g.lineTo(lx, ly); g.stroke();
        const gr = g.createRadialGradient(lx, ly, 0, lx, ly, s * .5); gr.addColorStop(0, 'rgba(253,186,116,.55)'); gr.addColorStop(1, 'rgba(253,186,116,0)');
        g.fillStyle = gr; g.fillRect(lx - s * .5, ly - s * .5, s, s); g.fillStyle = '#fed7aa'; ell(g, lx, ly, s * .05, s * .06); g.fill();
      }
      g.restore();
    }
    const st = stage(layer, 'wpy', {
      layout(S) {
        const wide = S.W > S.H * 1.1;
        // en portrait, le texte du site descend jusqu'à ~75 % de la hauteur : l'horizon et les pyramides plus bas
        G = { u: clamp(Math.min(S.W, S.H) / 100, 3.6, 11), hz: S.H * (wide ? .74 : .86), wide };
        G.d1 = S.H * (wide ? .86 : .92);
        G.pyr = wide
          ? [[S.W * .14, S.H * .38], [S.W * .3, S.H * .26], [S.W * .86, S.H * .2]]
          : [[S.W * .14, S.H * .13], [S.W * .78, S.H * .1], [S.W * .94, S.H * .07]];
        if (!wisps.length) wisps = Array.from({ length: 14 }, () => ({ x: R(), y: R(), v: rnd(.03, .07), l: rnd(.05, .14), ph: rnd(0, 7) }));
        S.fgTop = Math.round(S.H * .08);
      },
      paint(S, g) {
        const D = S.dark, { W, H, hz } = { W: S.W, H: S.H, hz: G.hz };
        if (D) { starfield(g, W, hz, Math.round(W * H / 2400), 13, '255,255,255', .8); }
        // le soleil (ou la lune) bas, derrière la grande pyramide du milieu
        const sx = G.wide ? W * .42 : W * .4, sy = hz - G.u * 9, sr = G.u * (D ? 3 : 5);
        const halo = g.createRadialGradient(sx, sy, sr * .5, sx, sy, sr * 9);
        halo.addColorStop(0, D ? 'rgba(226,232,240,.2)' : 'rgba(255,214,140,.7)'); halo.addColorStop(1, D ? 'rgba(226,232,240,0)' : 'rgba(255,214,140,0)');
        g.fillStyle = halo; g.fillRect(sx - sr * 9, sy - sr * 9, sr * 18, sr * 18);
        ell(g, sx, sy, sr, sr); g.fillStyle = D ? '#e2e8f0' : '#fff1c7'; g.fill();
        calm(g, S, D ? '12,16,38' : '253,240,218', D ? .4 : .7);
        // dunes du fond, pyramides, dune du milieu, sphinx
        dune(g, S, hz, G.u * 1.2, 4, 0, D ? '#2a2d4a' : '#e9c48e');
        const P = D ? { lit: '#5b6385', shade: '#363b5a', course: 'rgba(20,24,44,.35)' } : { lit: '#e8b56a', shade: '#b77b3f', course: 'rgba(120,70,30,.22)' };
        for (const [x, h] of G.pyr) pyramid(g, S, x, hz + G.u * .6, h * 1.55, h, P);
        dune(g, S, hz + G.u * 4, G.u * 1.6, 3, 2, D ? '#24273f' : '#e1b57a');
        // le sphinx : un corps allongé et une tête, en silhouette, devant la pyramide de droite
        const fx = G.wide ? W * .7 : W * .45, fy = hz + G.u * 4.5, fs = G.u * 2.2;
        g.fillStyle = D ? '#30344f' : '#c99a5c';
        g.beginPath(); g.moveTo(fx - fs * 3, fy); g.lineTo(fx - fs * 2.8, fy - fs * .9); g.lineTo(fx + fs * .6, fy - fs * 1.1); g.lineTo(fx + fs * .9, fy - fs * 2.2); g.lineTo(fx + fs * 1.6, fy - fs * 2.3); g.lineTo(fx + fs * 1.8, fy - fs * 1.4); g.lineTo(fx + fs * 2.4, fy - fs * .5); g.lineTo(fx + fs * 2.6, fy); g.closePath(); g.fill();
        dune(g, S, G.d1, G.u * 2, 3, 1, D ? '#1d1f33' : '#d9a965');
        dune(g, S, S.H * .97, G.u * 1.5, 2, 4, D ? '#17192a' : '#cf9b56');
      },
      update(S, dt) {
        if (!caravan) caravan = { x: -G.u * 30, v: G.u * 1.6 };
        caravan.x += caravan.v * dt; if (caravan.x > S.W + G.u * 30) caravan.x = -G.u * 30;
        for (const w of wisps) { w.x += w.v * dt; if (w.x > 1.2) { w.x = -.2; w.y = R(); } }
        hawk.a += dt * .35;
      },
      draw(S, g) {
        const D = S.dark, T = S.T, col = D ? '#0e1020' : '#6b4423';
        // le faucon : de grands cercles lents à droite, ailes qui battent rarement
        const hx = S.W * (G.wide ? .8 : .7) + Math.cos(hawk.a) * G.u * 9, hy = S.H * .26 + Math.sin(hawk.a) * G.u * 3, flap = Math.sin(T * 9) * (Math.sin(T * .7) > .6 ? 1 : .15);
        g.strokeStyle = D ? 'rgba(203,213,225,.55)' : 'rgba(87,56,30,.7)'; g.lineWidth = Math.max(1.2, G.u * .22); g.lineCap = 'round';
        g.beginPath(); g.moveTo(hx - G.u * 1.6, hy - G.u * flap * .6); g.quadraticCurveTo(hx - G.u * .7, hy - G.u * .5, hx, hy); g.quadraticCurveTo(hx + G.u * .7, hy - G.u * .5, hx + G.u * 1.6, hy - G.u * flap * .6); g.stroke();
        // la caravane, sur la crête de la dune du premier plan
        if (caravan) for (let i = 0; i < 4; i++) {
          const x = caravan.x - i * G.u * 6.5; if (x < -G.u * 6 || x > S.W + G.u * 6) continue;
          g.save(); g.translate(x, duneY(S, x) + G.u * .3); camel(g, G.u * (i ? 4.2 : 4.6), T, i * 1.3, col, D && i === 0); g.restore();
          if (i === 1) { g.save(); g.translate(x - G.u * 3.2, duneY(S, x - G.u * 3.2) + G.u * .3); const b = Math.abs(Math.sin(T * 3.4)) * G.u * .2; g.fillStyle = col; ell(g, 0, -G.u * 2.6 - b, G.u * .45, G.u * .45); g.fill(); g.fillRect(-G.u * .4, -G.u * 2.2 - b, G.u * .8, G.u * 1.6); g.lineWidth = G.u * .3; g.strokeStyle = col; g.beginPath(); g.moveTo(-G.u * .2, -G.u * .6 - b); g.lineTo(-G.u * .2 + Math.sin(T * 3.4) * G.u * .5, 0); g.moveTo(G.u * .2, -G.u * .6 - b); g.lineTo(G.u * .2 - Math.sin(T * 3.4) * G.u * .5, 0); g.stroke(); g.restore(); }
        }
        // le sable qui file au ras des dunes
        g.lineWidth = 1;
        for (const w of wisps) {
          const x = w.x * S.W, y = G.hz + (S.H - G.hz) * (.2 + .7 * w.y) + Math.sin(T + w.ph) * G.u * .3, L = w.l * S.W;
          const gr = g.createLinearGradient(x - L, 0, x, 0); gr.addColorStop(0, 'rgba(255,240,210,0)'); gr.addColorStop(1, D ? 'rgba(148,163,184,.22)' : 'rgba(255,244,220,.55)');
          g.strokeStyle = gr; g.beginPath(); g.moveTo(x - L, y + G.u * .3); g.quadraticCurveTo(x - L / 2, y - G.u * .4, x, y); g.stroke();
        }
      },
      debug(S, what) { if (what === 'caravan') { caravan = caravan || { v: G.u * 1.6 }; caravan.x = S.W * .55; } return { x: caravan && caravan.x }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🧊 Ice Caps (idée de finnnnn, 2026-10-24), assorti au bouton et au skin Ice : « des pics de glace hauts et pointus, ou
   * une rivière gelée avec des montagnes enneigées ». Les deux : des montagnes enneigées au fond, de grands pics de glace
   * bleue à facettes sur les côtés, et une rivière d'eau froide au milieu où dérivent des plaques de glace. La neige tombe,
   * des reflets brillent sur les facettes de temps en temps. Thème sombre : la nuit polaire et une aurore verte qui ondule
   * en haut ; thème clair : un ciel bleu glacé, la glace presque blanche.
   */
  SCENES.icecaps = layer => {
    const R = Math.random;
    let G = {}, floes = [], flakes = [], glints = [], spires = [];
    function spire(g, S, s) {
      const D = S.dark, { x, base, w, h, lean } = s, tip = [x + lean * w, base - h];
      const faces = [[[x - w / 2, base], tip, [x - w * .1, base]], [[x - w * .1, base], tip, [x + w * .2, base]], [[x + w * .2, base], tip, [x + w / 2, base]]];
      const cols = D ? ['#1e3a5f', '#2d5a86', '#16304f'] : ['#cfeefc', '#f5fcff', '#9fd8f2'];
      faces.forEach((f, i) => { g.fillStyle = cols[i]; g.beginPath(); g.moveTo(...f[0]); g.lineTo(...f[1]); g.lineTo(...f[2]); g.closePath(); g.fill(); });
      // une arête claire et de la neige sur la base
      g.strokeStyle = D ? 'rgba(165,243,252,.45)' : 'rgba(255,255,255,.95)'; g.lineWidth = Math.max(1, w * .02);
      g.beginPath(); g.moveTo(...tip); g.lineTo(x - w * .1, base); g.stroke();
      g.fillStyle = D ? '#5b6b88' : '#ffffff'; ell(g, x, base, w * .62, w * .1); g.fill();
    }
    const st = stage(layer, 'wic', {
      layout(S) {
        const wide = S.W > S.H * 1.1, u = clamp(Math.min(S.W, S.H) / 100, 3.6, 11);
        G = { u, hz: S.H * (wide ? .7 : .78), wide };
        G.river = [S.W * (wide ? .36 : .25), S.W * (wide ? .64 : .75)];
        const H = S.H, W = S.W, r = seeded(9);
        spires = [];
        // de grands pics sur les côtés (jamais derrière le texte du site), plus petits vers le milieu
        for (const side of [-1, 1]) for (let i = 0; i < (wide ? 4 : 2); i++) {
          const k = i / (wide ? 4 : 2), x = side < 0 ? W * (.03 + k * .3) : W * (.97 - k * .3);
          spires.push({ x, base: H * (wide ? .9 : .95) + r() * u * 3, w: u * (7 + r() * 5) * (1 - k * .4), h: H * (wide ? .42 : .3) * (1 - k * .5) * (.75 + r() * .35), lean: (r() - .5) * .3 });
        }
        spires.sort((a, b) => a.base - b.base);
        if (!floes.length) floes = Array.from({ length: 7 }, (_, i) => ({ y: i / 7, x: R(), s: rnd(.6, 1.2), ph: rnd(0, 7) }));
        if (!flakes.length) flakes = Array.from({ length: 70 }, () => ({ x: R(), y: R(), v: rnd(.03, .08), r: rnd(.6, 1.8), ph: rnd(0, 7) }));
      },
      paint(S, g) {
        const D = S.dark, { W, H } = S, u = G.u, hz = G.hz;
        if (D) starfield(g, W, hz, Math.round(W * H / 3000), 29, '255,255,255', .75);
        // les montagnes enneigées au fond, en deux rangs
        // une chaîne : de larges sommets, des cols entre eux, et un capuchon de neige qui suit les deux pentes
        const range = (y0, amp, seed, col, snow, shade) => {
          const r = seeded(seed), pts = [];
          for (let x = -u * 10; x <= W + u * 20; x += u * (16 + r() * 14)) pts.push([x, y0 - amp * (.5 + r() * .5)]);
          const vals = pts.slice(0, -1).map((p, i) => [(p[0] + pts[i + 1][0]) / 2 + (r() - .5) * u * 4, y0 - amp * r() * .2]);
          g.fillStyle = col; g.beginPath(); g.moveTo(pts[0][0], H); pts.forEach((p, i) => { g.lineTo(p[0], p[1]); if (vals[i]) g.lineTo(...vals[i]); }); g.lineTo(pts[pts.length - 1][0], H); g.fill();
          pts.forEach((p, i) => {
            const L = vals[i - 1] || [p[0] - u * 12, y0], Rv = vals[i] || [p[0] + u * 12, y0], k = .32, lx = p[0] + (L[0] - p[0]) * k, ly = p[1] + (L[1] - p[1]) * k, rx = p[0] + (Rv[0] - p[0]) * k, ry = p[1] + (Rv[1] - p[1]) * k;
            // le versant à l'ombre (à droite), puis la neige, dentelée en bas
            g.fillStyle = shade; g.beginPath(); g.moveTo(...p); g.lineTo(...Rv); g.lineTo(p[0] + (Rv[0] - p[0]) * .25, y0 + amp * .05); g.closePath(); g.fill();
            g.fillStyle = snow; g.beginPath(); g.moveTo(...p); g.lineTo(lx, ly);
            for (let j = 1; j < 4; j++) { const t = j / 4; g.lineTo(lx + (rx - lx) * t, ly + (ry - ly) * t + (j % 2 ? u * 1.2 : -u * .2)); }
            g.lineTo(rx, ry); g.closePath(); g.fill();
          });
        };
        range(hz - u * 1, H * (G.wide ? .2 : .1), 3, D ? '#1b2a44' : '#c9dcec', D ? '#8aa0bf' : '#ffffff', D ? 'rgba(8,15,32,.35)' : 'rgba(120,150,180,.18)');
        range(hz + u * 1.5, H * .1, 7, D ? '#14223a' : '#b2cbe0', D ? '#a7b8cf' : '#f4fbff', D ? 'rgba(8,15,32,.4)' : 'rgba(120,150,180,.2)');
        calm(g, S, D ? '8,15,32' : '236,247,253', D ? .45 : .85);
        // la neige des rives et la rivière (l'eau sombre et froide, en perspective)
        g.fillStyle = D ? '#3a4a66' : '#f8fcff'; g.fillRect(0, hz + u * 2, W, H);
        const [a, b] = G.river, mid = (a + b) / 2;
        const wg = g.createLinearGradient(0, hz, 0, H); wg.addColorStop(0, D ? '#0b2540' : '#5fb2d9'); wg.addColorStop(1, D ? '#123a5c' : '#2f86b8');
        g.fillStyle = wg; g.beginPath(); g.moveTo(mid - u * 2, hz + u * 2); g.lineTo(mid + u * 2, hz + u * 2); g.bezierCurveTo(b - u * 4, H * .82, b + u * 6, H * .9, b + u * 8, H); g.lineTo(a - u * 8, H); g.bezierCurveTo(a - u * 6, H * .9, a + u * 4, H * .82, mid - u * 2, hz + u * 2); g.fill();
        for (const s of spires) spire(g, S, s);
      },
      update(S, dt) {
        for (const f of floes) { f.y += dt * .022; if (f.y > 1) { f.y = 0; f.x = R(); } }
        for (const k of flakes) { k.y += k.v * dt; if (k.y > 1.02) { k.y = -.02; k.x = R(); } }
        if (R() < dt * .8 && spires.length) { const s = pick(spires); glints.push({ x: s.x + s.lean * s.w * .6, y: s.base - s.h * rnd(.3, .7), t: 0 }); }
        for (const q of glints) q.t += dt;
        glints = glints.filter(q => q.t < .9);
      },
      draw(S, g) {
        const D = S.dark, T = S.T, u = G.u, hz = G.hz, [a, b] = G.river, mid = (a + b) / 2;
        // l'aurore (sombre seulement) : deux rideaux verts qui ondulent, sur les côtés hauts de l'écran
        if (D) {
          g.save(); g.globalCompositeOperation = 'lighter';
          for (const [x0, x1, c] of [[0, S.W * .4, '52,211,153'], [S.W * .6, S.W, '45,212,191']]) {
            for (let x = x0; x < x1; x += 6) {
              const y = S.H * (.12 + .05 * Math.sin(x / 90 + T * .4) + .03 * Math.sin(x / 37 - T * .7)), h = S.H * (.16 + .06 * Math.sin(x / 50 + T * .5));
              // jamais derrière le texte du site, et des bouts de rideau fondus (pas de bord vertical)
              const q = (1 - quiet(S, x, y + h * .7)) * Math.sin(Math.PI * (x - x0) / (x1 - x0)); if (q < .02) continue;
              const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, `rgba(${c},0)`); gr.addColorStop(.7, `rgba(${c},${(.14 * q).toFixed(3)})`); gr.addColorStop(1, `rgba(${c},0)`);
              g.fillStyle = gr; g.fillRect(x, y, 6, h);
            }
          }
          g.restore();
        }
        // les plaques de glace qui descendent la rivière (plus grandes près de nous), et un reflet qui ondule
        for (const f of floes) {
          const p = f.y, y = hz + u * 2 + (S.H - hz - u * 2) * p * p, half = (u * 2 + ((b - a) / 2 + u * 8) * p * p), x = mid + (f.x - .5) * half * 1.4;
          const s = u * f.s * (.6 + 4 * p * p), bob = Math.sin(T * 1.3 + f.ph) * s * .05;
          g.fillStyle = D ? '#a9bfd6' : '#ffffff'; g.beginPath(); g.moveTo(x - s, y + bob); g.lineTo(x - s * .4, y - s * .3 + bob); g.lineTo(x + s * .7, y - s * .25 + bob); g.lineTo(x + s, y + s * .05 + bob); g.lineTo(x + s * .2, y + s * .3 + bob); g.closePath(); g.fill();
          g.fillStyle = D ? 'rgba(14,30,52,.6)' : 'rgba(47,134,184,.35)'; g.fillRect(x - s * .8, y + s * .3 + bob, s * 1.6, Math.max(1, s * .08));
        }
        g.strokeStyle = D ? 'rgba(165,243,252,.18)' : 'rgba(255,255,255,.5)'; g.lineWidth = 1;
        for (let i = 0; i < 5; i++) { const p = (i + .5) / 5, y = hz + u * 2 + (S.H - hz) * p * p, half = u * 2 + ((b - a) / 2) * p * p; g.beginPath(); g.moveTo(mid - half * .6 + Math.sin(T + i) * u, y); g.lineTo(mid + half * .2 + Math.sin(T + i) * u, y); g.stroke(); }
        // les reflets : une petite étoile qui s'allume sur une facette
        for (const q of glints) { const k = Math.sin(q.t / .9 * Math.PI), s = u * 1.4 * k; g.strokeStyle = `rgba(255,255,255,${(.9 * k).toFixed(2)})`; g.lineWidth = 1.2; g.beginPath(); g.moveTo(q.x - s, q.y); g.lineTo(q.x + s, q.y); g.moveTo(q.x, q.y - s); g.lineTo(q.x, q.y + s); g.stroke(); }
        // la neige
        for (const k of flakes) {
          const x = (k.x + Math.sin(T * .6 + k.ph) * .01) * S.W, y = k.y * S.H, q = 1 - .6 * quiet(S, x, y);
          g.fillStyle = D ? `rgba(255,255,255,${(.75 * q).toFixed(2)})` : `rgba(148,184,214,${(.8 * q).toFixed(2)})`; ell(g, x, y, k.r, k.r); g.fill();
        }
      },
      debug(S, what) { if (what === 'glint') for (const s of spires) glints.push({ x: s.x + s.lean * s.w * .6, y: s.base - s.h * .5, t: .4 }); return { spires: spires.length }; },
    });
    return st;
  };

  /* ---------------------------------------------------------------------------------------------------------------
   * 🎪 Circus (idée de sennybex1, 2026-10-28) : « un fond de cirque, avec des animaux, des drapeaux, à manger et à boire,
   * des obstacles, et un effet de rotation qui change la caméra ». On lève les yeux sous le grand chapiteau : les bandes
   * rouges et crème du toit convergent vers le mât, au-dessus du site, et tournent très lentement (la caméra qui tourne).
   * Des guirlandes de fanions, deux projecteurs qui balaient la piste. En bas, la piste : un éléphant fait rouler un
   * ballon, une otarie jongle, un cerceau à franchir (l'obstacle), un cornet de pop-corn qui saute et un gobelet de soda
   * sur le rebord. Thème sombre : le chapiteau le soir (rouge sombre, ampoules) ; thème clair : en plein jour (rouge vif et
   * crème, pâles en haut pour le texte).
   */
  SCENES.circus = layer => {
    const R = Math.random;
    let G = {}, pops = [], el = { x: .2, dir: 1 }, seal = { t: 0 }, roof = null;
    const FLAGS = ['#ef4444', '#facc15', '#3b82f6', '#22c55e', '#f97316', '#a855f7'];
    const st = stage(layer, 'wci', {
      layout(S) {
        const wide = S.W > S.H * 1.1, u = clamp(Math.min(S.W, S.H) / 100, 3.6, 11);
        G = { u, wide, cx: S.W / 2, cy: -S.H * .12, ringY: S.H * (wide ? .9 : .93), ringRx: S.W * (wide ? .46 : .6), ringRy: S.H * .07 };
        G.ringTop = G.ringY - G.ringRy;
        // le toit tourne : peint une fois dans son propre canevas (à demi-résolution), sous le décor, que le navigateur fait
        // seulement tourner (transform : aucun nouveau dessin)
        const Rr = Math.hypot(Math.max(G.cx, S.W - G.cx), S.H - G.cy) + 4, half = Math.ceil(Rr * .5);
        if (roof) roof.remove();
        const cv = roof = doc.createElement('canvas');
        cv.width = cv.height = half * 2; cv.className = 'wci-roof';
        cv.style.cssText = `left:${G.cx - Rr}px;top:${G.cy - Rr}px;width:${Rr * 2}px;height:${Rr * 2}px`;
        layer.insertBefore(cv, layer.querySelector('.wci-bg'));
        const g = cv.getContext('2d'), n = 24; g.scale(.5, .5);
        const c1 = S.dark ? '#5a1620' : '#f6c9c4', c2 = S.dark ? '#2a0c14' : '#fff4e6';
        for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? c1 : c2; g.beginPath(); g.moveTo(Rr, Rr); g.arc(Rr, Rr, Rr, i / n * Math.PI * 2, (i + 1) / n * Math.PI * 2); g.closePath(); g.fill(); }
        // les coutures et l'ombre qui monte vers le mât
        const sh = g.createRadialGradient(Rr, Rr, 0, Rr, Rr, Rr); sh.addColorStop(0, S.dark ? 'rgba(0,0,0,.55)' : 'rgba(120,40,40,.18)'); sh.addColorStop(.35, 'rgba(0,0,0,0)'); g.fillStyle = sh; g.fillRect(0, 0, Rr * 2, Rr * 2);
        G.Rr = Rr;
        calmEl(layer, S, S.dark ? '24,6,10' : '255,248,240', S.dark ? .6 : .82);
      },
      paint(S, g) {
        // la piste : le sable, le rebord rouge à étoiles dorées
        const D = S.dark, { cx, ringY, ringRx, ringRy, u } = G;
        g.fillStyle = D ? '#3b2a1a' : '#e9cf9e'; ell(g, cx, ringY + ringRy * .25, ringRx, ringRy * 1.4); g.fill();
        g.strokeStyle = D ? '#7f1d1d' : '#dc2626'; g.lineWidth = u * 1.6; ell(g, cx, ringY, ringRx, ringRy); g.stroke();
        g.fillStyle = D ? '#f5c66a' : '#facc15';
        for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, x = cx + Math.cos(a) * ringRx, y = ringY + Math.sin(a) * ringRy; if (Math.sin(a) < -.2) continue; ell(g, x, y, u * .3, u * .3); g.fill(); }
      },
      update(S, dt) {
        // l'éléphant va et vient sur la gauche de la piste et passe dans le cerceau (sur ordinateur, le milieu de la piste
        // est caché par les panneaux du site)
        el.x += el.dir * dt * .022; if (el.x > .3) el.dir = -1; if (el.x < .03) el.dir = 1;
        seal.t += dt;
        if (R() < dt * 1.5) pops.push({ x: rnd(-.3, .3), vy: -rnd(60, 110), y: 0, vx: rnd(-20, 20), t: 0 });
        for (const p of pops) { p.t += dt; p.vy += 220 * dt; p.y += p.vy * dt; p.x += p.vx * dt / 100; }
        pops = pops.filter(p => p.t < 1.4);
      },
      draw(S, g) {
        const D = S.dark, T = S.T, { cx, cy, u } = G;
        // le toit qui tourne (lentement : un tour en 3 minutes), puis un voile calme derrière le texte
        if (roof) roof.style.transform = `rotate(${(T * 2).toFixed(2)}deg)`;
        // deux guirlandes de fanions, qui se balancent un peu
        for (const [y0, sag, ph] of [[S.H * .1, S.H * .07, 0], [S.H * .2, S.H * .05, 2]]) {
          const P = t => [t * S.W, y0 + 4 * (sag + Math.sin(T * .8 + ph) * u * .3) * t * (1 - t)];
          g.strokeStyle = D ? 'rgba(254,243,199,.35)' : 'rgba(120,53,15,.4)'; g.lineWidth = 1; g.beginPath(); for (let i = 0; i <= 30; i++) { const [x, y] = P(i / 30); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
          const n = Math.round(S.W / (u * 4));
          for (let i = 1; i < n; i++) {
            const [x, y] = P(i / n), q = 1 - .75 * quiet(S, x, y);
            g.globalAlpha = (D ? .75 : .9) * q; g.fillStyle = FLAGS[(i + ph) % FLAGS.length];
            g.beginPath(); g.moveTo(x - u * .9, y); g.lineTo(x + u * .9, y); g.lineTo(x + Math.sin(T * 2 + i) * u * .15, y + u * 1.7); g.closePath(); g.fill();
          }
          g.globalAlpha = 1;
        }
        // les projecteurs : deux cônes de lumière qui balaient la piste depuis les coins hauts
        g.save(); g.globalCompositeOperation = D ? 'lighter' : 'source-over';
        for (const [x0, ph] of [[S.W * .02, 0], [S.W * .98, 2.2]]) {
          const tx = cx + Math.sin(T * .35 + ph) * G.ringRx * .7, ty = G.ringY, a = Math.atan2(ty - 0, tx - x0), L = Math.hypot(tx - x0, ty), w = .07;
          const gr = g.createLinearGradient(x0, 0, tx, ty); gr.addColorStop(0, D ? 'rgba(254,243,199,0)' : 'rgba(255,240,200,0)'); gr.addColorStop(1, D ? 'rgba(254,243,199,.18)' : 'rgba(255,236,170,.4)');
          g.fillStyle = gr; g.beginPath(); g.moveTo(x0, 0); g.arc(x0, 0, L, a - w, a + w); g.closePath(); g.fill();
          ell(g, tx, ty, G.ringRx * .16, G.ringRy * .5); g.fillStyle = D ? 'rgba(254,243,199,.16)' : 'rgba(255,248,220,.6)'; g.fill();
        }
        g.restore();
        const ink = D ? '#1a0b10' : '#3b2a2a';
        // le cerceau (l'obstacle), à gauche de la piste, sur le chemin de l'éléphant
        const hx = cx - G.ringRx * .78, hy = G.ringTop - u * 6;
        g.strokeStyle = D ? '#f59e0b' : '#f97316'; g.lineWidth = u * .5; ell(g, hx, hy, u * 3.4, u * 5.5); g.stroke();
        g.strokeStyle = ink; g.lineWidth = u * .35; g.beginPath(); g.moveTo(hx, hy + u * 5.5); g.lineTo(hx, G.ringTop + u * .5); g.stroke();
        // l'éléphant qui fait rouler son ballon (il marche dessus, le ballon tourne)
        const ex = cx - G.ringRx + G.ringRx * 2 * el.x, br = u * 3, by = G.ringTop - br, rot = ex / br;
        g.save(); g.translate(ex, by); g.rotate(rot);
        for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? (D ? '#1e40af' : '#3b82f6') : (D ? '#b91c1c' : '#ef4444'); g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, br, i * Math.PI / 2, (i + 1) * Math.PI / 2); g.closePath(); g.fill(); }
        g.fillStyle = D ? '#facc15' : '#fde047'; ell(g, 0, 0, br * .25, br * .25); g.fill();
        g.restore();
        {
          const s = u * 5, bob = Math.sin(T * 4) * u * .15;
          g.save(); g.translate(ex, by - br - bob); g.scale(el.dir, 1);
          g.fillStyle = D ? '#64748b' : '#94a3b8';
          ell(g, 0, -s * .45, s * .55, s * .38); g.fill();
          for (const [x, k] of [[-.3, 1], [.25, -1]]) { g.fillRect(s * x - s * .09, -s * .2, s * .18, s * .22 + Math.sin(T * 4) * k * s * .03); }
          ell(g, s * .5, -s * .65, s * .28, s * .26); g.fill();
          g.fillStyle = D ? '#475569' : '#7c8ea5'; ell(g, s * .38, -s * .65, s * .16, s * .22); g.fill();
          g.strokeStyle = D ? '#64748b' : '#94a3b8'; g.lineWidth = s * .1; g.lineCap = 'round'; g.beginPath(); g.moveTo(s * .72, -s * .6); g.quadraticCurveTo(s * .9, -s * .3, s * (.8 + Math.sin(T * 2) * .08), -s * .15); g.stroke();
          g.fillStyle = ink; ell(g, s * .58, -s * .72, s * .03, s * .03); g.fill();
          g.fillStyle = FLAGS[0]; g.beginPath(); g.moveTo(s * .4, -s * .9); g.lineTo(s * .55, -s * 1.15); g.lineTo(s * .62, -s * .88); g.closePath(); g.fill();
          g.restore();
        }
        // l'otarie qui jongle : assise à droite, le ballon monte et redescend sur son nez
        {
          const sx = cx + G.ringRx * .92, sy = G.ringTop, s = u * 4.2, j = Math.abs(Math.sin(seal.t * 2.4)), nose = [sx - s * .32, sy - s * 1.25];
          g.fillStyle = D ? '#334155' : '#475569';
          g.beginPath(); g.moveTo(sx + s * .4, sy); g.quadraticCurveTo(sx + s * .45, sy - s * .7, sx - s * .1, sy - s * 1.05); g.quadraticCurveTo(sx - s * .4, sy - s * 1.3, nose[0], nose[1] + s * .05); g.quadraticCurveTo(sx - s * .1, sy - s * .8, sx - s * .2, sy); g.closePath(); g.fill();
          ell(g, sx - s * .25, sy - s * .05, s * .22, s * .07); g.fill();
          g.fillStyle = ink; ell(g, sx - s * .15, sy - s * 1.12, s * .03, s * .03); g.fill();
          const bx = nose[0], byy = nose[1] - s * .22 - j * s * 1.1, bs = s * .2;
          g.save(); g.translate(bx, byy); g.rotate(seal.t * 5);
          for (let i = 0; i < 3; i++) { g.fillStyle = [FLAGS[1], FLAGS[2], FLAGS[0]][i]; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, bs, i * Math.PI * 2 / 3, (i + 1) * Math.PI * 2 / 3); g.closePath(); g.fill(); }
          g.restore();
        }
        // le pop-corn qui saute de son cornet, et le gobelet de soda, sur le rebord à gauche
        {
          const px = cx + G.ringRx * .68, py = G.ringTop + u * .5, s = u * 2.2;
          g.fillStyle = '#fffbeb'; for (const p of pops) { ell(g, px + p.x * s * 3, py - s * 1.5 + p.y, u * .32, u * .28); g.fill(); }
          g.fillStyle = '#fef3c7'; for (let i = 0; i < 5; i++) { ell(g, px + (i - 2) * s * .22, py - s * 1.45 - (i % 2) * s * .15, s * .2, s * .17); g.fill(); }
          g.fillStyle = '#dc2626'; g.beginPath(); g.moveTo(px - s * .55, py - s * 1.4); g.lineTo(px + s * .55, py - s * 1.4); g.lineTo(px + s * .38, py); g.lineTo(px - s * .38, py); g.closePath(); g.fill();
          g.fillStyle = '#fff'; for (const k of [-.18, .18]) g.fillRect(px + k * s - s * .06, py - s * 1.4, s * .12, s * 1.4);
          const dx = px + s * 1.4;
          g.fillStyle = D ? '#1d4ed8' : '#3b82f6'; g.beginPath(); g.moveTo(dx - s * .4, py - s * 1.2); g.lineTo(dx + s * .4, py - s * 1.2); g.lineTo(dx + s * .3, py); g.lineTo(dx - s * .3, py); g.closePath(); g.fill();
          g.fillStyle = '#fff'; g.fillRect(dx - s * .44, py - s * 1.3, s * .88, s * .12);
          g.strokeStyle = '#f472b6'; g.lineWidth = s * .08; g.beginPath(); g.moveTo(dx + s * .05, py - s * 1.3); g.lineTo(dx + s * .25, py - s * 1.9); g.stroke();
        }
      },
      stop() { if (roof) roof.remove(); const c = layer.querySelector(':scope > .wcalm'); if (c) c.remove(); },
      debug(S, what) { return { el: el.x }; },
    });
    return st;
  };

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
    const byLabel = l => keys.find(k => k.label === l);
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
    // correspondante s'enfonce avec son « thock ». Jamais pendant qu'on écrit (chat, champ de texte, raccourcis Ctrl/Cmd).
    const KEYMAP = { ' ': space, Backspace: back, Enter: enter, Escape: byLabel('Esc'), Tab: byLabel('Tab'), Delete: byLabel('Del'), CapsLock: byLabel('Caps'), Shift: byLabel('Shift'), Control: byLabel('Ctrl'), Alt: byLabel('Alt'), ArrowUp: byLabel('↑'), ArrowDown: byLabel('↓'), ArrowLeft: byLabel('←'), ArrowRight: byLabel('→'), PageUp: byLabel('PgUp'), PageDown: byLabel('PgDn'), End: byLabel('End') };
    const onKey = e => {
      if (e.repeat || e.metaKey || e.ctrlKey || !layer.classList.contains('wp-keyboard')) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const key = KEYMAP[e.key] || (e.key && e.key.length === 1 ? byLabel(e.key.toUpperCase()) : null);
      if (!key) return;
      press(key, true);
      if (st.S.still) { key.p = 1; st.redraw(); setTimeout(() => { key.p = 0; active.delete(key); st.redraw(); }, 150); }
    };
    doc.addEventListener('keydown', onKey);
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
          const t = S.T - key.t0, up = (t - .045 - key.hold) / .17;
          key.p = t < .045 ? easeOut(t / .045) : up < 0 ? 1 : up < 1 ? 1 - easeOut(up) - .14 * Math.sin(up * Math.PI) : 0;
          key.glow = Math.exp(-t / .45);
          if (t > 1.8) { key.p = 0; key.glow = 0; active.delete(key); }
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
      stop() { doc.removeEventListener('pointerdown', onDown); doc.removeEventListener('keydown', onKey); },
      debug(S, what) { if (what === 'type') { burst(S); } if (what && what.at) { const key = keyAt(what.at[0], what.at[1]); if (key) press(key, true); return key && key.label; } return { active: active.size }; },
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
   */
  SCENES.solarsystem = layer => {
    const PL = [
      { r: .75, c: ['#d8d0c6', '#6f665e'] }, { r: 1.2, c: ['#f4dfb0', '#a37f47'] }, { r: 1.3, c: ['#86bdf3', '#1f4f8f'], moon: 1 },
      { r: .95, c: ['#f0a07a', '#963c25'] }, { r: 2.8, c: ['#eed6b3', '#956743'], bands: 1 }, { r: 2.3, c: ['#f2e2b4', '#a2864f'], ring: 1 },
      { r: 1.7, c: ['#c2f0f3', '#4b97a2'] }, { r: 1.65, c: ['#8aa6f3', '#283d98'] },
    ].map(p => Object.assign(p, { th: rnd(0, Math.PI * 2) }));
    let G = {}, comet = null, nextComet = rnd(6, 10);
    const tw = twinklers(26, 1);
    const INK = '#3b4a6b';
    const pos = (p, th) => ({ x: G.cx + p.a * Math.cos(th), y: G.cy + p.a * G.e * Math.sin(th), k: 1 + .1 * Math.sin(th) });
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
    function drawComet(g, S) {
      const c = comet, q = c.t / c.dur, w = 1 - q;
      const x = w * w * c.p0[0] + 2 * w * q * c.p1[0] + q * q * c.p2[0], y = w * w * c.p0[1] + 2 * w * q * c.p1[1] + q * q * c.p2[1];
      const dx = x - G.cx, dy = y - G.cy, d = Math.hypot(dx, dy) || 1, tx = dx / d, ty = dy / d, px = -ty, py = tx;
      const near = clamp(1 - d / (Math.min(S.W, S.H) * .7), 0, 1), L = G.u * (9 + 22 * near), u = G.u;
      // la queue de poussière : un panache de taches de plus en plus larges et pâles, qui s'incurve vers l'arrière de la
      // trajectoire (elle ne pointe pas tout à fait à l'opposé du soleil, contrairement à la queue d'ions)
      let vx = 2 * w * (c.p1[0] - c.p0[0]) + 2 * q * (c.p2[0] - c.p1[0]), vy = 2 * w * (c.p1[1] - c.p0[1]) + 2 * q * (c.p2[1] - c.p1[1]);
      const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      g.globalCompositeOperation = S.dark ? 'lighter' : 'source-over';
      for (let i = 1; i <= 16; i++) {
        const f = i / 16, bend = f * f * .55, ox = x + (tx - vx * bend) * L * f, oy = y + (ty - vy * bend) * L * f, rad = u * (.4 + 2.6 * f);
        const gr = g.createRadialGradient(ox, oy, 0, ox, oy, rad), a = .2 * (1 - f) * (1 - f);
        gr.addColorStop(0, S.dark ? `rgba(255,244,214,${a.toFixed(3)})` : `rgba(59,74,107,${(a * .9).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,244,214,0)');
        g.fillStyle = gr; g.fillRect(ox - rad, oy - rad, rad * 2, rad * 2);
      }
      g.globalCompositeOperation = 'source-over';
      const ion = g.createLinearGradient(x, y, x + tx * L * 1.3, y + ty * L * 1.3);
      ion.addColorStop(0, S.dark ? 'rgba(147,197,253,.6)' : 'rgba(59,130,246,.45)'); ion.addColorStop(1, 'rgba(147,197,253,0)');
      g.strokeStyle = ion; g.lineWidth = Math.max(1, u * .25); g.beginPath(); g.moveTo(x, y); g.lineTo(x + tx * L * 1.3, y + ty * L * 1.3); g.stroke();
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
        const a0 = G.sun * 2.3, a1 = Math.max(S.W * (portrait ? .62 : .47), a0 * 4);
        PL.forEach((p, i) => { p.a = a0 + (a1 - a0) * Math.pow(i / 7, 1.12); p.P = Math.min(420, 24 * Math.pow(p.a / a0, 1.5)); });
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
        if (S.dark) {
          const halo = g.createRadialGradient(G.cx, G.cy, 0, G.cx, G.cy, G.sun * 14);
          halo.addColorStop(0, 'rgba(255,190,100,.16)'); halo.addColorStop(1, 'rgba(255,190,100,0)');
          g.fillStyle = halo; g.fillRect(G.cx - G.sun * 14, G.cy - G.sun * 14, G.sun * 28, G.sun * 28);
        }
      },
      update(S, dt) {
        for (const p of PL) p.th += dt * Math.PI * 2 / p.P;
        if (!comet && S.T > nextComet) newComet(S);
        if (comet && (comet.t += dt) > comet.dur) { comet = null; nextComet = S.T + rnd(28, 50); }
      },
      draw(S, g) {
        if (S.dark) twinkle(g, tw, S.W, S.H, '255,255,255', .9, S.T);
        const list = PL.map(p => ({ p, P: pos(p, p.th) })).sort((a, b) => a.P.y - b.P.y);
        for (const o of list) if (o.P.y < G.cy) planet(g, S, o.p, o.P);
        sun(g, S);
        for (const o of list) if (o.P.y >= G.cy) planet(g, S, o.p, o.P);
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
