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
