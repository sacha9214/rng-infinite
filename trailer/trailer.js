/* RNG∞ — trailer (motion design piloté par le code).
 * Tout est une fonction du temps : seek(t) dessine l'image de l'instant t sans rien retenir de l'image d'avant.
 * L'aperçu (lecture dans le navigateur) et l'export (tools/trailer-render.mjs, image par image) passent par la même
 * fonction. Les animations CSS du site (défilement, révélation, cadres de duel…) sont en pause et calées sur t
 * (syncAnimations) : ce qu'on voit est le vrai rendu du jeu. Nombres, badges, XP et raretés sortent du moteur du jeu.
 *   ?format=v → 9:16 (1080×1920), sinon 16:9 (1920×1080)   ·   ?cut=15 ou ?cut=6 → version courte
 *   ?export → sans commandes   ·   ?t=12.5 → instant affiché
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const P = qs.get('format') === 'v';
  const W = P ? 1080 : 1920, H = P ? 1920 : 1080;
  const EXPORT = qs.has('export');
  const FPS = 60, DURATION = 30;

  // ------------------------------------------------------------------ instants clés (secondes)
  // Le montage est calé sur une grille à 120 battements par minute : un temps = 0,5 s, une mesure = 2 s. Les temps forts
  // (chiffre posé, changement de skin, changement de scène) tombent sur un temps, les moments clés (Mythic, mur des skins,
  // duel, 1re place, logo) sur le premier temps d'une mesure. N'importe quelle musique à 120 BPM se pose dessus.
  const T_CLICK = 0.5, T_SPIN = 0.62;
  const LOCK = [1, 1.5, 2, 2.5, 3, 4]; // un chiffre par temps, puis un temps de silence avant le dernier
  const T_PEAK = LOCK[5];
  const T_SPLIT = 4.75; // la carte se décale, les badges arrivent
  const T_HERO_OUT = 7.5; // badges et XP sortent, la carte revient au centre pour les skins
  // Skins : sur les temps (4), puis deux fois plus vite (6), puis quatre fois plus vite (4), comme un roulement vers le mur.
  // (2026-10-08) Les skins tiennent en deux mesures, le mur passe à 10 s : la mesure 12-14 est pour les skins légendaires.
  const SWAPS = [[8, 'neon'], [8.5, 'gold'], [9, 'vaporwave'], [9.25, 'fire'], [9.5, 'galaxy'], [9.625, 'blocks'], [9.75, 'candy'], [9.875, 'rainbow']];
  const T_WALL = 10, T_LEGEND = 12, T_DUEL = 14, T_LB = 20, T_OUTRO = 24;
  // Musique : à chaque mesure (ou presque), l'intensité (0 = silence tendu, 1 = pulsation, 2 = demi-rythme, 3 = rythme
  // complet, 4 = accord final) et l'accord. La bande-son est fabriquée à partir de cette partition.
  const SCORE = [[0, 1, 'G'], [2, 1, 'G'], [3, 0, 'G'], [4, 3, 'Em'], [6, 3, 'Em'], [8, 3, 'C'], [10, 3, 'C'], [12, 2, 'D'], [14, 3, 'G'], [16, 3, 'G'],
    [18, 3, 'Em'], [20, 2, 'C'], [21, 3, 'C'], [22, 3, 'D'], [24, 1, 'Em'], [26, 4, 'G']];

  // Versions courtes : elles gardent des passages du film complet (début et fin en secondes), tous coupés sur un temps.
  const CUTS = { 15: [[2, 6], [10, 13.5], [16, 17.5], [21.5, 23], [25.5, 30]], 6: [[3, 5.5], [26, 29.5]] };
  const CUT = CUTS[qs.get('cut')] ? qs.get('cut') : '';
  const EDIT = CUT ? CUTS[CUT] : [[0, DURATION]];
  const LENGTH = EDIT.reduce((x, [a, b]) => x + b - a, 0); // durée de la version affichée
  // Instant du film complet pour un instant de la version affichée, et l'inverse (null si le passage n'est pas gardé).
  const toSource = t => { for (const [a, b] of EDIT) { if (t < b - a) return a + t; t -= b - a; } return EDIT[EDIT.length - 1][1]; };
  const toOutput = src => { let at = 0; for (const [a, b] of EDIT) { if (src >= a && src < b) return at + src - a; at += b - a; } return null; };
  const JOINS = EDIT.slice(0, -1).map((r, i) => EDIT.slice(0, i + 1).reduce((x, [a, b]) => x + b - a, 0)); // instants des coupes

  // Sans "?export", la page est le lecteur : elle affiche le plan dans un cadre et pilote le temps.
  if (!EXPORT) { player(); return; }

  // ------------------------------------------------------------------ outils
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const prog = (t, t0, d) => clamp((t - t0) / d);
  // Courbe de Bézier cubique du CSS, pour reprendre les accélérations du site.
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const fx = u => ((ax * u + bx) * u + cx) * u, fy = u => ((ay * u + by) * u + cy) * u, dx = u => (3 * ax * u + 2 * bx) * u + cx;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let u = x;
      for (let i = 0; i < 8; i++) { const d = dx(u); if (Math.abs(d) < 1e-6) break; u -= (fx(u) - x) / d; }
      return fy(clamp(u));
    };
  }
  const E = {
    outQuad: x => 1 - (1 - x) * (1 - x),
    inCubic: x => x * x * x,
    outCubic: x => 1 - Math.pow(1 - x, 3),
    inOutCubic: x => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    outExpo: x => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    outBack: (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
    snap: bezier(.34, 1.36, .64, 1), // --ease-snap du site
    wave: bezier(.15, .75, .3, 1), // onde de choc du site
  };
  // Coup amorti qui part à t0 (échelle, secousse) : 1 à l'impact, puis retombe.
  const kick = (t, t0, decay = 11, freq = 20) => (t < t0 ? 0 : Math.exp(-decay * (t - t0)) * Math.cos(freq * (t - t0)));
  const rng = seed => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const hash = (a, b = 0, c = 0) => {
    let x = (Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263) ^ Math.imul(c + 13, 2246822519)) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  const mix = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a).toFixed(3)})`;
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const fmt = v => Math.round(v).toLocaleString('en-US');

  function el(tag, cls, html, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  const place = (pin, x, y, s = 1, r = 0) => { pin.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)${r ? ` rotate(${r.toFixed(3)}deg)` : ''}${s !== 1 ? ` scale(${s.toFixed(4)})` : ''}`; };
  const show = (e, on) => { const v = on ? '' : 'none'; if (e.style.display !== v) e.style.display = v; };
  const vis = (e, on) => { const v = on ? 'visible' : 'hidden'; if (e.style.visibility !== v) e.style.visibility = v; };
  const fadeTo = (e, o) => { vis(e, o > .002); e.style.opacity = o.toFixed(3); };
  const setText = (e, s) => { if (e.textContent !== s) e.textContent = s; };
  const setCls = (e, cls, on) => { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); };
  // Classe qui porte une animation CSS du site : on note son instant de départ, syncAnimations cale l'animation dessus.
  const setAnim = (e, cls, on, t0, name = '*') => { setCls(e, cls, on); if (on) (e.__t0 || (e.__t0 = {}))[name] = t0; };
  // Position d'un élément dans son conteneur, sans tenir compte des transformations (mesure de mise en page).
  function natRect(e, root) {
    let x = 0, y = 0;
    for (let n = e; n && n !== root; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return { x, y, w: e.offsetWidth, h: e.offsetHeight };
  }

  // ------------------------------------------------------------------ moteur du jeu : nombres, badges et XP réels
  const Engine = window.RNGEngine.createEngine(window.BADGE_META, window.SCORE_PERCENTILES);
  const Shop = window.RNGShop;
  // Le badge perso du site ne doit apparaître nulle part dans le trailer : un nombre qui le gagne arrête tout.
  const HIDDEN_BADGES = new Set(['DRASTIX']);
  const shownNumbers = new Map();
  function analysis(n) {
    let a = shownNumbers.get(n);
    if (!a) {
      a = Engine.analyze(n);
      const bad = a.earnedIds.find(id => HIDDEN_BADGES.has(id));
      if (bad) throw new Error(`Trailer: ${n} earns the hidden badge ${bad}`);
      shownNumbers.set(n, a);
    }
    return a;
  }

  const slotsHTML = str => str.split('').map(c => `<span class="slot">${c}</span>`).join('');
  const cardHTML = (str, { size = 'md', skin = 'classic', tier = '', cls = '' } = {}) =>
    `<div class="num-card ${size}${skin !== 'classic' ? ` skin-${skin}` : ''}${cls ? ` ${cls}` : ''}"${tier ? ` data-tier="${tier}"` : ''}>${slotsHTML(str)}</div>`;
  function setSkin(card, id) {
    if (card.__skin === id) return;
    if (card.__skin && card.__skin !== 'classic') card.classList.remove(`skin-${card.__skin}`);
    if (id !== 'classic') card.classList.add(`skin-${id}`);
    card.__skin = id;
  }
  const tierPill = tier => `<span class="pill" data-tier="${tier}">${tier}</span>`;
  // Chiffres sous un badge : ceux qui comptent s'allument un par un (même règle que le site).
  const GROUP_COLORS = [['#93c5fd', '#2563eb'], ['#86efac', '#059669'], ['#fcd34d', '#d97706'], ['#f9a8d4', '#db2777']];
  function tilesHTML(n, id) {
    const groups = Engine.highlight(id, n), multi = groups.length > 1, info = new Map();
    let offset = 0;
    groups.forEach((g, gi) => {
      const [bgc, bd] = multi ? GROUP_COLORS[gi % GROUP_COLORS.length] : ['var(--t-hl)', 'var(--t-hl-border)'];
      g.forEach((i, k) => { if (!info.has(i)) info.set(i, { bgc, bd, delay: offset + 80 * k }); });
      offset += 80 * g.length + 100;
    });
    return String(n).split('').map((ch, i) => {
      const x = info.get(i);
      return x ? `<span class="dt hl" data-delay="${x.delay}" style="--hl-bg:${x.bgc};--hl-bd:${x.bd}">${ch}</span>` : `<span class="dt">${ch}</span>`;
    }).join('');
  }
  function badgeHTML(g, n) {
    const b = g.badge;
    return `<div class="badge-card" data-tier="${b.tier}">
      <div class="badge-head">
        <div class="badge-title"><span class="emoji">${b.emoji}</span><span class="name">${esc(b.label)}</span>${tierPill(b.tier)}</div>
        <span class="ep-pill">+${fmt(b.score)} XP</span>
      </div>
      <div class="badge-desc">${esc(b.desc)}</div>
      <div class="digits">${tilesHTML(n, b.id)}</div>
    </div>`;
  }
  const pillsHTML = a => a.groups.slice(0, 2).map(g => `<span class="badge-pill" data-tier="${g.badge.tier}">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join('')
    + (a.groups.length > 2 ? `<span class="badge-pill more-pill">+${a.groups.length - 2}</span>` : '');

  // ------------------------------------------------------------------ plan et calques
  const stage = document.getElementById('stage');
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;
  document.documentElement.classList.add(P ? 'fmt-v' : 'fmt-h');
  if (EXPORT) document.documentElement.classList.add('export');
  if (qs.has('tc')) document.documentElement.classList.add('show-tc');
  const bg = el('canvas', 'layer', null, stage);
  const scenesEl = el('div', 'layer scenes', null, stage);
  const bug = el('div', 'bug', '<b>RNG∞</b><span>rng-infinite.com</span>', stage);
  const fx = el('canvas', 'layer fx', null, stage);
  const tcEl = el('div', 'tc', '', stage);
  bg.width = fx.width = W;
  bg.height = fx.height = H;
  const bgc = bg.getContext('2d'), fxc = fx.getContext('2d');

  // Ce que les scènes règlent à chaque image : lumières du fond, caméra, assombrissement.
  const IDENT = { z: 1, x: 0, y: 0 };
  const view = { lights: [], cam: IDENT, dark: 0 };
  const light = (x, y, r, c, a) => view.lights.push({ x, y, r, c, a });
  const toScreen = (x, y) => ({ x: view.cam.x + x * view.cam.z, y: view.cam.y + y * view.cam.z });

  // ------------------------------------------------------------------ animations CSS du site, calées sur t
  // Chaque animation CSS est mise en pause et placée à (t − départ). Le départ est noté par setAnim sur l'élément
  // (par nom d'animation, ou '*') ; sans départ noté (boucles de décor), l'animation suit simplement t.
  const anims = new Set();
  function syncAnimations(t) {
    for (const a of document.getAnimations()) anims.add(a);
    for (const a of anims) {
      const target = a.effect && a.effect.target;
      if (!target || !target.isConnected || a.playState === 'idle') { anims.delete(a); continue; }
      if (!('animationName' in a)) { anims.delete(a); continue; }
      const t0 = target.__t0 ? (target.__t0[a.animationName] ?? target.__t0['*'] ?? 0) : 0;
      if (a.playState !== 'paused') a.pause();
      a.currentTime = Math.max(0, (t - t0) * 1000);
    }
  }

  // ------------------------------------------------------------------ fond : lumière, champ de chiffres, vignette
  const BASE = '#111017'; // --site-bg du thème sombre
  const field = (() => {
    const r = rng(4242), list = [];
    for (let i = 0; i < (P ? 64 : 84); i++) {
      const z = .2 + r() * .8;
      list.push({ x: r() * W, y: r() * (H + 240), z, size: 18 + z * 40, v: 10 + z * 30, a: .03 + z * .06, k: i, rate: 1.4 + r() * 3 });
    }
    return list;
  })();
  const impulses = []; // { t0, x, y, amp, glow } : les chiffres du fond sont soufflés par les impacts
  const impulse = (t0, x, y, amp = 150, glow = 1) => impulses.push({ t0, x, y, amp, glow });
  function drawBg(t) {
    const c = bgc;
    c.fillStyle = BASE;
    c.fillRect(0, 0, W, H);
    for (const L of view.lights) {
      const g = c.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
      g.addColorStop(0, rgba(L.c, L.a));
      g.addColorStop(.45, rgba(L.c, L.a * .4));
      g.addColorStop(1, rgba(L.c, 0));
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
    const tint = view.lights.length ? view.lights[0].c : [168, 85, 247];
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const span = H + 240;
    for (const f of field) {
      let x = f.x, y = (((f.y - f.v * t) % span) + span) % span - 120, boost = 0;
      for (const im of impulses) {
        const tau = t - im.t0;
        if (tau < 0 || tau > 1.8) continue;
        const dx = x - im.x, dy = y - im.y, d = Math.hypot(dx, dy) || 1;
        const push = im.amp * f.z * Math.exp(-3 * tau) * (1 - Math.exp(-26 * tau)) * Math.exp(-d / 1500);
        x += (dx / d) * push;
        y += (dy / d) * push;
        boost += Math.exp(-3 * tau) * im.glow;
      }
      c.font = `700 ${f.size | 0}px "Space Mono", monospace`;
      c.fillStyle = rgba(mix([255, 255, 255], tint, .35 + clamp(boost) * .4), Math.min(.5, f.a * (1 + boost * 3)) * (1 - view.dark * .7));
      c.fillText(String(Math.floor(hash(f.k, Math.floor(t / f.rate + f.k * .37)) * 10)), x, y);
    }
    const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .35, W / 2, H / 2, Math.hypot(W, H) * .62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(.5 + view.dark * .4).toFixed(3)})`);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }

  // ------------------------------------------------------------------ effets : confettis, ondes de choc, flashs, volets
  const PX = 2.8; // un pixel du site vaut ~2,8 px du plan (les cartes y sont agrandies d'autant)
  const CONF = { // mêmes salves que le site (FX.celebrate)
    rare: { count: 26, speed: 5, colors: ['#60a5fa', '#bfdbfe', '#3b82f6', '#ffffff'], sparks: true },
    epic: { count: 60, speed: 7, colors: ['#a855f7', '#d8b4fe', '#7c3aed', '#f0abfc'] },
    anomaly: { count: 120, speed: 9, colors: ['#f97316', '#fdba74', '#fbbf24', '#ea580c'] },
    mythic: { count: 240, speed: 12, colors: ['#ec4899', '#a855f7', '#22d3ee', '#f43f5e', '#fde047'] },
    gold: { count: 110, speed: 8, colors: ['#fde68a', '#f59e0b', '#fbbf24', '#ffffff'] },
  };
  const TIER_RING = { uncommon: '#10b981', rare: '#3b82f6', epic: '#a855f7', anomaly: '#f97316', mythic: '#ec4899' };
  const FX = { bursts: [], rings: [], flashes: [], wipes: [], streaks: [] };
  function burst(t0, x, y, conf, seed, scale = PX) {
    if (!conf) return;
    const r = rng(seed), parts = [];
    for (let i = 0; i < conf.count; i++) {
      const ang = r() * Math.PI * 2, sp = conf.speed * (.35 + r()), spark = conf.sparks || r() < .18;
      parts.push({
        vx: Math.cos(ang) * sp * 60, vy: (Math.sin(ang) * sp - conf.speed * .35) * 60,
        w: spark ? 2.5 + r() * 3 : 4 + r() * 5, h: 6 + r() * 8, round: spark, rot: r() * 6, vr: (r() - .5) * 18, flip: r() * 6, vf: (.08 + r() * .18) * 60,
        sway: spark ? 0 : .4 + r() * .8, phase: r() * 60, color: conf.colors[i % conf.colors.length], life: ((spark ? 45 : 70) + r() * 60) / 60,
      });
    }
    FX.bursts.push({ t0, x, y, parts, scale, max: Math.max(...parts.map(p => p.life)) });
  }
  const ring = (t0, x, y, w, h, color, o = {}) => FX.rings.push({ t0, x, y, w, h, color, dur: 1, from: .9, grow: 2.6, radius: 16 * PX, width: 3 * PX, alpha: 1, ...o });
  const flash = (t0, dur, kind, alpha, x = W / 2, y = H * .4) => FX.flashes.push({ t0, dur, kind, alpha, x, y });
  // Repères sonores : chaque scène note ses temps forts (chiffre posé, impact, changement de skin…). La bande-son est
  // fabriquée à partir de cette liste par tools/trailer-audio.mjs : l'image et le son partagent les mêmes instants.
  const cues = [];
  const cue = (t, type, o = {}) => cues.push({ t: Math.round(t * 1000) / 1000, type, ...o });
  // Cliquetis des rouleaux tant que des chiffres tournent (un toutes les 55 ms, comme le changement de chiffre à l'image).
  const ticks = (from, to, o = {}) => { for (let t = from; t < to - .02; t += .055) cue(t, 'tick', o); };
  const wipe = (tc, colors, dur = .56) => { FX.wipes.push({ tc, colors, dur }); cue(tc - dur / 2 + .06, 'wipe', { dur: dur - .1 }); };
  const streak = (t0, x, y, c, o = {}) => FX.streaks.push({ t0, x, y, c, dur: .75, len: W * 1.25, thick: 30, ...o });

  // Le site simule les confettis image par image (gravité, frottement) ; ici la même trajectoire en formule.
  const DRAG = -Math.log(.985) * 60, GRAV = .22 * 3600;
  function drawFx(t, out = t) {
    const c = fxc, cam = view.cam;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y); // ondes et confettis vivent dans le décor : ils suivent la caméra
    for (const s of FX.streaks) { // éclat horizontal, comme un reflet d'objectif
      const p = (t - s.t0) / s.dur;
      if (p < 0 || p >= 1) continue;
      const a = 1 - E.outQuad(p);
      c.save();
      c.translate(s.x, s.y);
      c.scale((s.len / 2) * lerp(.25, 1, E.outExpo(p)), s.thick * lerp(1.7, .25, p));
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, rgba([255, 255, 255], a));
      g.addColorStop(.22, rgba(s.c, a * .75));
      g.addColorStop(1, rgba(s.c, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, 1, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    for (const r of FX.rings) {
      const p = (t - r.t0) / r.dur;
      if (p < 0 || p >= 1) continue;
      const e = E.wave(p), s = lerp(r.from, r.grow, e), w = r.w * s, h = r.h * s;
      c.save();
      c.globalAlpha = lerp(.9, 0, e) * r.alpha;
      c.strokeStyle = c.shadowColor = r.color;
      c.lineWidth = lerp(r.width, r.width * .35, e) * s;
      c.shadowBlur = 44;
      c.beginPath();
      c.roundRect(r.x - w / 2, r.y - h / 2, w, h, Math.min(r.radius * s, w / 2, h / 2));
      c.stroke();
      c.restore();
    }
    for (const b of FX.bursts) {
      const tau = t - b.t0;
      if (tau < 0 || tau > b.max) continue;
      const k = (1 - Math.exp(-DRAG * tau)) / DRAG;
      for (const p of b.parts) {
        if (tau > p.life) continue;
        const x = b.x + b.scale * (p.vx * k + (p.sway / .12) * (Math.cos(p.phase * .12) - Math.cos((tau * 60 + p.phase) * .12)));
        const y = b.y + b.scale * ((p.vy - GRAV / DRAG) * k + (GRAV / DRAG) * tau);
        c.save();
        c.globalAlpha = Math.max(0, 1 - tau / p.life);
        c.translate(x, y);
        c.rotate(p.rot + p.vr * tau);
        c.scale(Math.cos(p.flip + p.vf * tau), 1);
        c.fillStyle = p.color;
        if (p.round) { c.beginPath(); c.arc(0, 0, (p.w / 2) * b.scale, 0, Math.PI * 2); c.fill(); }
        else c.fillRect((-p.w / 2) * b.scale, (-p.h / 2) * b.scale, p.w * b.scale, p.h * b.scale);
        c.restore();
      }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    for (const f of FX.flashes) {
      const p = (t - f.t0) / f.dur;
      if (p < 0 || p >= 1) continue;
      const a = f.alpha * (1 - E.outQuad(p));
      if (f.kind === 'white') c.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      else {
        const stops = f.kind === 'gold' ? [[253, 230, 138, .5], [245, 158, 11, .3], [251, 146, 60, .1]] : [[236, 72, 153, .5], [168, 85, 247, .3], [34, 211, 238, .12]];
        const g = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.hypot(W, H) * .62);
        g.addColorStop(0, rgba(stops[0], stops[0][3] * a * 2));
        g.addColorStop(.4, rgba(stops[1], stops[1][3] * a * 2));
        g.addColorStop(.7, rgba(stops[2], stops[2][3] * a * 2));
        g.addColorStop(1, rgba(stops[2], 0));
        c.fillStyle = g;
      }
      c.fillRect(0, 0, W, H);
    }
    for (const j of JOINS) { // version courte : un bref éclat blanc adoucit chaque coupe
      const p = (out - j) / .16;
      if (p >= 0 && p < 1) { c.fillStyle = `rgba(255,255,255,${(.6 * (1 - p) * (1 - p)).toFixed(3)})`; c.fillRect(0, 0, W, H); }
    }
    // Volet : une grande bande inclinée traverse le cadre ; au milieu de sa course elle le couvre entièrement,
    // et c'est à cet instant que la scène change.
    for (const w of FX.wipes) {
      const u = (t - (w.tc - w.dur / 2)) / w.dur;
      if (u <= 0 || u >= 1) continue;
      const WW = P ? H : W, HH = P ? W : H, sk = HH * .32, len = WW + sk + WW * .5;
      const xl = -sk + E.inOutCubic(u) * (WW + len + sk), xt = xl - len;
      c.save();
      if (P) { c.translate(0, H); c.rotate(-Math.PI / 2); } // vertical : la bande monte du bas vers le haut
      const band = (x0, x1, fill) => {
        c.fillStyle = fill;
        c.beginPath();
        c.moveTo(x0 + sk, 0); c.lineTo(x1 + sk, 0); c.lineTo(x1, HH); c.lineTo(x0, HH);
        c.closePath();
        c.fill();
      };
      const g = c.createLinearGradient(xt, 0, xl + sk, 0);
      w.colors.forEach((col, i) => g.addColorStop(i / (w.colors.length - 1), col));
      band(xt, xl, g);
      band(xl + 70, xl + 112, w.colors[w.colors.length - 1]);
      band(xl + 164, xl + 180, '#ffffff');
      band(xt - 112, xt - 70, w.colors[0]);
      band(xt - 180, xt - 164, '#ffffff');
      c.restore();
    }
  }

  // ------------------------------------------------------------------ skin Matrix : pluie de code
  // Le site la dessine avec une minuterie (app.js, MatrixRain) ; ici la même pluie, mais fonction de t.
  const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>¦';
  const rains = [];
  function attachRain(card, res = 3) { // res : pixels de canvas par pixel de carte (la carte est agrandie à l'écran)
    const cv = document.createElement('canvas');
    cv.className = 'matrix-rain';
    card.prepend(cv);
    rains.push({ card, cv, ctx: cv.getContext('2d'), res, w: 0, h: 0, seed: rains.length * 97 + 5 });
  }
  function drawRains(t) {
    const tick = Math.floor(t / .055);
    for (const r of rains) {
      if (!r.card.classList.contains('skin-matrix') || !r.card.offsetParent) continue;
      const w = r.card.clientWidth, h = r.card.clientHeight;
      if (w !== r.w || h !== r.h) { r.w = w; r.h = h; r.cv.width = Math.round(w * r.res); r.cv.height = Math.round(h * r.res); }
      const c = r.ctx, size = Math.max(8, Math.round(h / 5)), cols = Math.ceil(w / size), rowsN = Math.ceil(h / size) + 1;
      c.setTransform(r.res, 0, 0, r.res, 0, 0);
      c.fillStyle = '#000';
      c.fillRect(0, 0, w, h);
      c.font = `${size}px 'Share Tech Mono', monospace`;
      c.textBaseline = 'top';
      for (let i = 0; i < cols; i++) {
        const every = 1 + Math.floor(hash(r.seed, i, 1) * 3), span = rowsN + 6 + Math.floor(hash(r.seed, i, 2) * 10);
        const head = (Math.floor(tick / every) + Math.floor(hash(r.seed, i, 3) * span)) % span;
        for (let j = 0; j < 14; j++) {
          const row = head - j;
          if (row < 0 || row >= rowsN) continue;
          c.fillStyle = j === 0 ? '#e6ffe9' : `rgba(0,255,65,${Math.pow(.8, j).toFixed(3)})`;
          c.fillText(GLYPHS[Math.floor(hash(r.seed + i, row, Math.floor(tick / (4 + (row % 5)))) * GLYPHS.length)], i * size, row * size);
        }
      }
    }
  }
  // Caractère affiché pendant que ça tourne : un chiffre, ou du code qui défile pour le skin Matrix.
  const spinGlyph = (skin, i, t, seed = 0) => {
    const k = hash(seed * 31 + i, Math.floor(t / .055), 5);
    return skin === 'matrix' ? GLYPHS[Math.floor(k * GLYPHS.length)] : String(Math.floor(k * 10));
  };

  // ------------------------------------------------------------------ textes
  // Titre : chaque mot monte derrière un cache. "*mot*" = mot accentué, "|" = retour à la ligne.
  function claim(parent, text, cls = '') {
    const box = el('div', `claim ${cls}`, text.split('|').map(line => `<div class="cl">${line.trim().split(/\s+/).map(w => {
      const acc = /^\*.*\*$/.test(w);
      return `<span class="w"><span class="wi${acc ? ' acc' : ''}">${esc(acc ? w.slice(1, -1) : w)}</span></span>`;
    }).join(' ')}</div>`).join(''), parent);
    const words = Array.from(box.querySelectorAll('.wi'));
    return {
      el: box,
      at(t, tin, tout = 1e9, stagger = .055) {
        const on = t >= tin && t < tout + .5;
        vis(box, on);
        if (!on) return;
        words.forEach((w, i) => {
          const a = E.outExpo(prog(t, tin + i * stagger, .6)), b = E.inCubic(prog(t, tout + i * stagger * .4, .3));
          w.style.transform = `translateY(${((1 - a) * 110 - b * 110).toFixed(2)}%)`;
        });
      },
    };
  }
  // Ligne secondaire : fondu avec un léger glissement.
  function fade(parent, cls, html) {
    const box = el('div', cls, html, parent);
    return {
      el: box,
      at(t, tin, tout = 1e9, dy = 18) {
        const a = E.outCubic(prog(t, tin, .45)), b = E.inCubic(prog(t, tout, .25));
        fadeTo(box, a * (1 - b));
        box.style.transform = `translateY(${((1 - a) * dy - b * dy * .6).toFixed(2)}px)`;
      },
    };
  }
  const put = (item, top, size) => { item.el.style.top = `${top}px`; if (size) item.el.style.fontSize = `${size}px`; return item; };

  // ------------------------------------------------------------------ scènes
  const scenes = [];
  function scene(id, start, end, build) {
    const root = el('div', 'scene', '', scenesEl);
    root.id = `sc-${id}`;
    scenes.push({ id, start, end, root, update: build(root) });
  }

  const C = { indigo: hex('#6366f1'), pink: hex('#ec4899'), purple: hex('#a855f7'), cyan: hex('#22d3ee'), orange: hex('#f97316'), gold: hex('#f5b301'), violet: hex('#8b5cf6') };
  const SKIN_LIGHT = {
    classic: C.pink, neon: hex('#ff4fd8'), slots: hex('#ef4444'), gold: hex('#d4a017'), matrix: hex('#00ff41'), fire: hex('#f97316'), vaporwave: hex('#c026d3'),
    galaxy: hex('#8b5cf6'), diamond: hex('#93c5fd'), candy: hex('#f9a8d4'), blocks: hex('#65a30d'), dice: hex('#16a34a'), ice: hex('#7dd3fc'), pixel: hex('#29adff'), rainbow: hex('#a855f7'),
  };

  function buildScenes() {
    // ================================================================ 2 bis. émotes animées et chat, par-dessus le duel
    scene('social', T_DUEL + 1.5, T_LB, root => {
      const T0 = T_DUEL + 1.5, EM = [['gg', 0, .3], ['love', .75, .62], ['rage', 1.5, .42], ['mindblown', 2.5, .7], ['money', 3.25, .26]];
      const CHAT = [['Kairo', 'gg!! 🔥', .5, 0], ['You', 'rematch?', 2, 1], ['Kairo', 'no way that was luck', 3, 0]];
      const svg = id => (window.RNGEmotes ? window.RNGEmotes.svg(id) : '');
      root.innerHTML = EM.map(([id]) => `<div class="tr-emote emote-tile"><span class="emote emote-svg">${svg(id)}</span></div>`).join('')
        + `<div class="tr-chat">${CHAT.map(([who, text, , me]) => `<div class="tr-msg${me ? ' me' : ''}"><b>${esc(who)}</b>${esc(text)}</div>`).join('')}</div>`;
      const ems = Array.from(root.querySelectorAll('.tr-emote')), msgs = Array.from(root.querySelectorAll('.tr-msg'));
      const tag = put(fade(root, 'sub', '<span class="chip">animated <b>emotes</b> · live <b>chat</b></span>'), P ? 1700 : 965, P ? 40 : 40);
      EM.forEach(([, at]) => cue(T0 + at, 'badge', { i: 2, of: 6 }));
      return t => {
        ems.forEach((e, i) => { const k = prog(t, T0 + EM[i][1], 1.9), a = E.outBack(prog(t, T0 + EM[i][1], .3), 2); e.style.opacity = (Math.min(1, k * 12) * (1 - E.inCubic(clamp((k - .7) / .3)))).toFixed(3); e.style.transform = `translate(${(W * EM[i][2] + Math.sin(k * 7 + i) * 26).toFixed(1)}px, ${(H * (P ? .7 : .86) - k * H * (P ? .2 : .3)).toFixed(1)}px) translate(-50%, -50%) scale(${(a * (P ? 1.7 : 1.5)).toFixed(3)})`; });
        msgs.forEach((m, i) => { const a = E.outBack(prog(t, T0 + CHAT[i][2], .32), 1.8), out = E.inCubic(prog(t, T_LB - .3, .25)); m.style.opacity = (prog(t, T0 + CHAT[i][2], .1) * (1 - out)).toFixed(3); m.style.transform = `translateY(${((1 - a) * 30).toFixed(1)}px) scale(${lerp(.85, 1, a).toFixed(3)})`; });
        tag.at(t, T0 + .2, T_LB - .4);
      };
    });

    // ================================================================ 1 bis. les quatre skins légendaires, signature comprise
    // Les vraies séquences du jeu (js/skinfx.js), avancées à la main par pas fixes avec un hasard à graine : la même
    // image pour le même instant, quel que soit l'ordre dans lequel le film est rendu. Chaque carte a déjà « tiré » ses
    // six chiffres avant d'apparaître (2 s de simulation hors champ), et révèle un Mythic en entrant.
    scene('legend', T_LEGEND, T_DUEL, root => {
      const LEG = [['sakura', '424242'], ['storm', '131313'], ['dragon', '888888'], ['blackhole', '999999']];
      const pos = P ? [[.5, .3], [.5, .47], [.5, .64], [.5, .81]] : [[.26, .4], [.74, .4], [.26, .76], [.74, .76]], S = P ? 1.75 : 1.8, PRE = 2, STEP = 1 / 120;
      root.innerHTML = `<div class="leg-back"></div>${LEG.map(([id, n], i) => `<div class="pin leg" style="left:${pos[i][0] * W}px;top:${pos[i][1] * H}px"><div class="leg-in"><div class="card-stage"><div class="num-card lg skin-${id}" data-tier="mythic">${n.split('').map(c => `<span class="slot">${c}</span>`).join('')}</div></div><div class="leg-name">${Shop.byId.get(id).emoji} ${esc(Shop.byId.get(id).name)}</div></div></div>`).join('')}`;
      const back = root.querySelector('.leg-back'), cells = Array.from(root.querySelectorAll('.leg-in'));
      const title = put(claim(root, P ? 'Legendary|*skins*' : 'Legendary *skins*'), P ? 150 : 56, P ? 120 : 96);
      const sims = LEG.map(([id], i) => ({ id, i, fx: null, t: 0, ev: 0, seed: 0 }));
      const prng = sim => () => { sim.seed = (sim.seed + 0x6D2B79F5) | 0; let x = Math.imul(sim.seed ^ (sim.seed >>> 15), 1 | sim.seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
      const withSeed = (sim, fn) => { const real = Math.random; Math.random = sim.rand; try { fn(); } finally { Math.random = real; } };
      function advance(sim, target) {
        if (!window.SkinFX) return;
        if (!sim.fx || target < sim.t - 1e-6) { // premier passage, ou retour en arrière : on repart du début
          if (sim.fx) sim.fx.destroy();
          const stage = cells[sim.i].querySelector('.card-stage'), card = stage.querySelector('.num-card');
          sim.seed = 1234 + sim.i * 777; sim.rand = prng(sim); sim.t = 0; sim.ev = 0;
          withSeed(sim, () => { sim.fx = window.SkinFX.mount(stage, card, sim.id, { manual: true }); });
          if (!sim.fx) return;
          const slots = Array.from(card.querySelectorAll('.slot'));
          sim.events = [[.2, 0], [.45, 1], [.7, 2], [.95, 3], [1.2, 4], [1.5, 5]].map(([at, k]) => [at, () => sim.fx.lock(slots[k], { last: k === 5 })])
            .concat([[1.25, () => sim.fx.build(900)], [PRE + sim.i * .25 + .12, () => sim.fx.reveal('mythic')]]).sort((a, b) => a[0] - b[0]);
        }
        if (!sim.fx) return;
        withSeed(sim, () => { while (sim.t + STEP <= target + 1e-9) { while (sim.ev < sim.events.length && sim.events[sim.ev][0] <= sim.t) sim.events[sim.ev++][1](); sim.fx.step(STEP); sim.t += STEP; } });
      }
      LEG.forEach((x, i) => { cue(T_LEGEND + i * .25, 'swap', { i, of: 4 }); cue(T_LEGEND + i * .25 + .12, 'lock', { i: i + 2 }); });
      cue(T_LEGEND, 'whoosh', { dur: .4 });
      return t => {
        back.style.opacity = E.outCubic(prog(t, T_LEGEND, .22)).toFixed(3);
        title.at(t, T_LEGEND + .05, T_DUEL - .35);
        cells.forEach((c, i) => {
          const t0 = T_LEGEND + i * .25, e = E.outBack(prog(t, t0, .32), 1.6), out = E.inCubic(prog(t, T_DUEL - .22, .22));
          c.style.opacity = (prog(t, t0, .08) * (1 - out)).toFixed(3);
          c.style.transform = `translate(-50%, -50%) scale(${(S * lerp(.72, 1, e) * (1 + .06 * out)).toFixed(4)})`;
          advance(sims[i], t - T_LEGEND + PRE);
        });
      };
    });

    // ================================================================ 1. le tirage, les badges, les skins
    scene('hero', 0, T_DUEL, root => {
      const N = 777777, a = analysis(N), str = a.str;
      const HC = P ? { x: 540, y: 900 } : { x: 960, y: 560 }; // centre de la carte
      const HB = P ? { x: 540, y: 500, s: .8 } : { x: 500, y: 430, s: .6 }; // carte décalée pendant les badges
      const MAX_W = P ? 900 : 1040, MAX_H = P ? 400 : 420;
      const SHOWN = P ? 3 : 4;
      const top = a.groups.slice(0, SHOWN); // les plus gros badges, du plus rare au moins rare (ordre final, de haut en bas)
      const times = P ? [5.5, 6, 6.5] : [5, 5.5, 6, 6.5]; // un badge par temps
      const tin = top.map((g, j) => times[SHOWN - 1 - j]); // le moins rare arrive en premier, chacun s'insère en haut
      const base = a.total - top.reduce((x, g) => x + g.badge.score, 0); // XP des badges non montrés

      root.innerHTML = `
        <div class="cam">
          <div class="pin" id="h-wall"><div class="ctr wall"></div></div>
          <div class="pin" id="h-group">
            <div class="pin hero-card" data-tier="mythic"><div class="ctr">
              <div class="card-stage"><div class="rays"></div><div class="num-card lg neutral">${slotsHTML('??????')}<span class="glint"></span></div><span class="slot-lever"></span></div>
            </div></div>
            <div class="pin" id="h-stamp"><div class="ctr stamp">MYTHIC</div></div>
            <div class="pin" id="h-meta" data-tier="mythic"><div class="ctr"><div class="result-meta big">${tierPill('mythic')}<span class="dot">•</span><span class="top" style="color:#eab308"></span></div></div></div>
            <div class="pin hero-xp" data-tier="mythic"><div class="ctr"><div class="ep-big pending">??? XP</div></div></div>
            <div class="pin" id="h-label"><div class="ctr skin-label"><span class="em"></span><span class="nm"></span><span class="pr"></span></div></div>
          </div>
          <div class="pin" id="h-badges"><div class="bstack">${top.map(g => `<div class="bslot">${badgeHTML(g, N)}</div>`).join('')}</div></div>
          <div class="pin" id="h-btn"><div class="ctr"><button class="btn-roll">Generate</button></div></div>
        </div>
        <div class="wall-dim"></div>`;
      const $ = s => root.querySelector(s);
      const cam = $('.cam'), pGroup = $('#h-group'), pCard = $('.hero-card'), cstage = $('.card-stage'), rays = $('.rays'), card = $('.num-card');
      const slots = Array.from(card.querySelectorAll('.slot'));
      const pStamp = $('#h-stamp'), stamp = $('.stamp'), pMeta = $('#h-meta'), pXP = $('.hero-xp'), xp = $('.ep-big');
      const pLabel = $('#h-label'), lbEm = $('.skin-label .em'), lbNm = $('.skin-label .nm'), lbPr = $('.skin-label .pr');
      const pBadges = $('#h-badges'), bslots = Array.from(root.querySelectorAll('.bslot')), pBtn = $('#h-btn'), btn = $('.btn-roll');
      const pWall = $('#h-wall'), wall = $('.wall'), dim = $('.wall-dim');
      $('.result-meta .top').textContent = `Top ${Math.round(100 - a.percentile) || '<1'}%`;
      attachRain(card, 4);
      const glint = card.querySelector('.glint');
      // Entre deux changements de skin la carte avance très lentement et un reflet la traverse : sans cela l'image se
      // figeait complètement une dizaine d'images, ce qui se lisait comme une saccade.
      const creep = (t, from) => 1 + .035 * clamp((t - from) / .6);

      // Taille naturelle de la carte pour chaque skin : toutes occupent la même largeur à l'écran.
      const K = {}, NAT = {};
      for (const s of Shop.SKINS) {
        setSkin(card, s.id);
        NAT[s.id] = { w: card.offsetWidth, h: card.offsetHeight };
        K[s.id] = Math.min(MAX_W / card.offsetWidth, MAX_H / card.offsetHeight);
      }
      setSkin(card, 'classic');
      const K0 = K.classic, cw = NAT.classic.w * K0, ch = NAT.classic.h * K0;
      const lastDx = (slots[5].offsetLeft + slots[5].offsetWidth / 2 - card.offsetWidth / 2) * K0; // dernier chiffre, depuis le centre
      const dyStamp = ch / 2 + 130, dyMeta = ch / 2 + 72, dyLabel = MAX_H / 2 + 130;
      const btnY = HC.y + ch / 2 + 150, S_BTN = 2.2;

      // Pile de badges.
      const BX = P ? 540 : 1420, BY = P ? 1090 : 150, SB = P ? 1.78 : 1.8, GAP = 13;
      const bh = bslots.map(s => s.offsetHeight);
      const tiles = bslots.map(s => Array.from(s.querySelectorAll('.dt.hl')).map(e => ({ e, d: Number(e.dataset.delay) / 1000 })));
      const bcards = bslots.map(s => s.querySelector('.badge-card'));

      // Mur des 22 skins : la dernière carte (Rainbow) est au centre, la caméra recule et les découvre tous.
      const cols = P ? 5 : 7, rows = P ? 11 : 7, order = Shop.SKINS.map(s => s.id), CELL_W = 236;
      const midR = (rows - 1) / 2, midC = (cols - 1) / 2, lastSkin = SWAPS[SWAPS.length - 1][1];
      const shift = (((order.indexOf(lastSkin) - (midR * 7 + midC)) % order.length) + order.length) % order.length;
      wall.innerHTML = Array.from({ length: rows }, (_, r) => `<div class="wrow">${Array.from({ length: cols }, (_, c) => {
        const s = Shop.byId.get(order[(r * 7 + c + shift) % order.length]);
        return `<div class="wcell" style="width:${CELL_W}px">${cardHTML(str, { skin: s.id, tier: 'mythic' })}<div class="wname">${s.emoji} ${esc(s.name)}</div></div>`;
      }).join('')}</div>`).join('');
      const wrows = Array.from(wall.children);
      wall.querySelectorAll('.num-card.skin-matrix').forEach(c => attachRain(c, 2));
      const midCard = wrows[midR].children[midC].querySelector('.num-card');
      const mr = natRect(midCard, wall);
      const wallOff = mr.y + mr.h / 2 - wall.offsetHeight / 2; // la carte du centre est un peu au-dessus du centre de sa case
      const wS0 = (NAT[lastSkin].w * K[lastSkin] * creep(T_WALL, SWAPS[SWAPS.length - 1][0])) / mr.w, wS1 = (P ? 290 : 300) / mr.w;

      // Textes.
      const cA = put(claim(root, P ? 'Roll a|*number*' : 'Roll a *number*'), P ? 330 : 92, P ? 132 : 118);
      const sA = put(fade(root, 'sub', 'from <b>0</b> to <b>1,000,000</b>'), P ? 622 : 226);
      const cB = put(claim(root, '230+ *badges*'), P ? 908 : 792, P ? 92 : 96);
      const sB = put(fade(root, 'sub', `<b>${a.earnedIds.length}</b> on this roll alone`), P ? 1014 : 908, 32);
      if (!P) { cB.el.style.right = sB.el.style.right = 'auto'; cB.el.style.width = sB.el.style.width = `${HB.x * 2}px`; }
      const cC = put(claim(root, P ? 'Make it|*yours*' : 'Make it *yours*'), P ? 330 : 92, P ? 132 : 118);
      const cW = put(claim(root, P ? `${Shop.SKINS.length}|*skins*` : `${Shop.SKINS.length} *skins*`), P ? 620 : 372, P ? 300 : 250);
      const sW = put(fade(root, 'sub', '<span class="chip">earned by playing · <b>no real money</b></span>'), P ? 1250 : 650, P ? 34 : 40);

      // Effets à instants fixes.
      ring(T_CLICK, HC.x, btnY, 150, 150, '#ffffff', { dur: .5, from: .3, grow: 3.2, radius: 999, width: 5, alpha: .6 });
      flash(T_PEAK, .3, 'white', .85);
      flash(T_PEAK, 1.0, 'mythic', .6, HC.x, HC.y);
      ring(T_PEAK, HC.x, HC.y, cw, ch, TIER_RING.mythic);
      ring(T_PEAK + .14, HC.x, HC.y, cw, ch, TIER_RING.mythic);
      ring(T_PEAK + .02, HC.x, HC.y, cw, ch, '#ffffff', { grow: 4.2, width: 4, alpha: .5, dur: .8 });
      burst(T_PEAK + .02, HC.x, HC.y, CONF.mythic, 7);
      impulse(T_PEAK, HC.x, HC.y, 260, 1);
      streak(T_PEAK, HC.x, HC.y, C.pink);
      for (let i = 0; i < 5; i++) impulse(LOCK[i], HC.x, HC.y, 26, .25);
      flash(tin[0], .7, 'mythic', .22, BX, BY);
      impulse(tin[0], BX, BY, 60, .5);
      cue(T_CLICK, 'click');
      ticks(T_SPIN, T_PEAK - .9);
      for (let j = 1; j <= 8; j++) cue(T_PEAK - .9 + .9 * (1 - Math.sqrt(1 - j / 9)), 'tick', { last: j / 8 }); // le dernier rouleau ralentit
      for (let i = 0; i < 5; i++) cue(LOCK[i], 'lock', { i });
      cue(LOCK[4] + .1, 'riser', { dur: T_PEAK - LOCK[4] - .17 });
      cue(T_PEAK, 'impact', { kind: 'mythic' });
      cue(T_SPLIT, 'whoosh', { dur: .5, pan: P ? 0 : -.5 });
      tin.forEach((t, j) => cue(t, 'badge', { i: SHOWN - 1 - j, of: SHOWN }));
      cue(T_HERO_OUT, 'whoosh', { dur: .45, pan: P ? 0 : .5 });
      SWAPS.forEach(([t], i) => cue(t, 'swap', { i, of: SWAPS.length }));
      cue(T_WALL, 'wall');

      // Le dernier rouleau ralentit avant de s'arrêter et frôle le 7.
      const spinChar = (i, t) => {
        if (i === 5 && t > T_PEAK - .9) {
          const u = (t - (T_PEAK - .9)) / .9;
          return '482903916'[Math.min(8, Math.floor(9 * (1 - (1 - u) * (1 - u))))];
        }
        return spinGlyph('classic', i, t);
      };

      return t => {
        const spinning = t >= T_SPIN, peak = t >= T_PEAK, skins = t >= T_HERO_OUT, walled = t >= T_WALL;
        let revealed = 0;
        for (let i = 0; i < 6; i++) if (t >= LOCK[i]) revealed = i + 1;

        // --- caméra : légère poussée pendant le tirage, zoom sur le dernier chiffre, recul sec à la révélation
        const push = E.inOutCubic(prog(t, LOCK[4] + .1, T_PEAK - LOCK[4] - .1)), back = E.outBack(prog(t, T_PEAK + .07, .55), 2.2);
        const hold = push * (1 - back);
        let z = 1 + (P ? .03 : .05) * E.inOutCubic(prog(t, T_SPIN, LOCK[4] - T_SPIN)) * (1 - back) + (P ? .13 : .26) * hold;
        for (let i = 0; i < 5; i++) z *= 1 + .028 * kick(t, LOCK[i], 12, 22);
        const fxp = HC.x + lastDx * (P ? .25 : .6) * hold, sh = peak ? 24 * Math.exp(-6 * (t - T_PEAK)) : 0;
        view.cam = { z, x: HC.x - fxp * z + sh * Math.sin((t - T_PEAK) * 91), y: HC.y - HC.y * z + sh * Math.cos((t - T_PEAK) * 77) };
        cam.style.transform = `translate(${view.cam.x.toFixed(2)}px,${view.cam.y.toFixed(2)}px) scale(${z.toFixed(4)})`;
        view.dark = hold * .8;

        // --- chiffres et carte
        slots.forEach((s, i) => {
          const locked = i < revealed;
          setText(s, locked ? str[i] : spinning ? spinChar(i, t) : '?');
          setAnim(s, 'spinning', spinning && !locked, 0);
          setAnim(s, 'revealed', locked && !skins, LOCK[i]);
        });
        setCls(card, 'neutral', !peak);
        setAnim(card, 'charging', spinning && !peak, T_SPIN, 'charge');
        if (peak) card.dataset.tier = 'mythic'; else delete card.dataset.tier;
        setAnim(card, 'shake', peak && t < T_PEAK + .5, T_PEAK, 'shake');
        const lastLock = revealed ? LOCK[revealed - 1] : -9;
        setAnim(cstage, 'thump', t - lastLock < .24, lastLock, 'thump');
        setCls(cstage, 'lit', peak && !skins);
        rays.style.opacity = (peak ? .5 * E.outCubic(prog(t, T_PEAK, .6)) * (1 - prog(t, T_HERO_OUT - .1, .3)) : 0).toFixed(3);

        // --- skins : la carte roule d'un skin au suivant, comme un rouleau
        let cur = 'classic', li = -1;
        for (let i = 0; i < SWAPS.length; i++) if (t >= SWAPS[i][0]) { cur = SWAPS[i][1]; li = i; }
        setSkin(card, cur);
        setCls(pCard, 'is-slots', cur === 'slots');
        let oy = 0, op = 1, cs = K[cur] * lerp(1.05, 1, E.outCubic(prog(t, 0, .5))) * (1 + .05 * kick(t, T_SPIN, 9, 16));
        const next = SWAPS[li + 1];
        if (next) { const e = E.inCubic(prog(t, next[0] - .07, .07)); oy -= e * 120; op *= 1 - e * .85; }
        if (li >= 0) { const e = E.outBack(prog(t, SWAPS[li][0], .26), 2); oy += (1 - e) * 140; op *= clamp(.3 + prog(t, SWAPS[li][0], .07)); cs *= lerp(.9, 1, e); }
        const held = li >= 0 ? SWAPS[li][0] : T_HERO_OUT + .5; // instant où la carte actuelle s'est posée
        if (skins) cs *= creep(t, held);
        const gp = skins ? prog(t, held + .1, .5) : 0;
        glint.style.opacity = gp > 0 && gp < 1 ? '1' : '0';
        glint.style.backgroundPosition = `${lerp(100, 0, E.inOutCubic(gp)).toFixed(2)}% 0`;
        place(pCard, 0, oy, cs);
        pCard.style.opacity = op.toFixed(3);

        // --- groupe (carte + ce qui l'entoure) : au centre, puis décalé pendant les badges
        const split = E.inOutCubic(prog(t, T_SPLIT, .55)) * (1 - E.inOutCubic(prog(t, T_HERO_OUT, .5)));
        const gx = lerp(HC.x, HB.x, split), gy = lerp(HC.y, HB.y, split);
        place(pGroup, gx, gy, lerp(1, HB.s, split));
        show(pGroup, !walled);

        const out = E.inCubic(prog(t, T_HERO_OUT, .28));
        const st = prog(t, T_PEAK + .1, .42);
        fadeTo(pStamp, clamp(st * 4) * (1 - out));
        place(pStamp, 0, -dyStamp - out * 60, lerp(2.3, 1, E.outExpo(st)));
        stamp.style.letterSpacing = `${lerp(.42, .05, E.outExpo(st)).toFixed(3)}em`;
        const mp = prog(t, T_PEAK + .45, .4);
        fadeTo(pMeta, clamp(mp * 3) * (1 - out));
        place(pMeta, 0, dyMeta, 3.4 * lerp(.7, 1, E.outBack(mp)));
        const xin = prog(t, T_PEAK + .62, .4);
        let xv = 0, xk = 0;
        top.forEach((g, j) => { xv += (g.badge.score + (j === SHOWN - 1 ? base : 0)) * E.outCubic(prog(t, tin[j], .42)); xk += kick(t, tin[j], 9, 0); });
        const counting = t >= tin[SHOWN - 1];
        setText(xp, counting ? `${fmt(xv)} XP` : '??? XP');
        setCls(xp, 'pending', !counting);
        setAnim(xp, 'glint', t >= tin[0] + .42, tin[0] + .07);
        fadeTo(pXP, clamp(xin * 3) * (1 - out));
        place(pXP, 0, dyMeta + lerp(112, P ? 144 : 168, split) + (1 - E.outCubic(xin)) * 20, lerp(3, P ? 4.6 : 5.4, split) * (1 + .07 * xk));

        // --- badges : chacun s'insère en haut de la pile et pousse les autres
        place(pBadges, BX, BY, SB);
        bslots.forEach((s, j) => {
          const on = t >= tin[j] && out < 1;
          show(s, on);
          if (!on) return;
          let y = 0;
          for (let m = 0; m < j; m++) y += (bh[m] + GAP) * E.outCubic(prog(t, tin[m], .32));
          const o = E.inCubic(prog(t, T_HERO_OUT + j * .03, .25));
          s.style.transform = `translate(${(P ? 0 : o * 90).toFixed(2)}px,${(y + (P ? o * 70 : 0)).toFixed(2)}px)`;
          s.style.opacity = (1 - o).toFixed(3);
          setAnim(bcards[j], 'reveal', true, tin[j]);
          tiles[j].forEach(x => { const t0 = tin[j] + .38 + x.d; setAnim(x.e, 'lit', t >= t0, t0); });
        });

        // --- bouton du début
        const bOut = E.inCubic(prog(t, T_SPIN, .3)), press = Math.sin(Math.PI * prog(t, T_CLICK - .04, .2));
        fadeTo(pBtn, 1 - bOut);
        place(pBtn, HC.x, btnY + bOut * 140, S_BTN * lerp(1.05, 1, E.outCubic(prog(t, 0, .5))) * (1 - .09 * press) * (1 - .15 * bOut));
        btn.style.filter = press > .01 ? `brightness(${(1 + press).toFixed(2)})` : '';

        // --- nom du skin sous la carte
        const s0 = li >= 0 ? SWAPS[li][0] : T_HERO_OUT + .35, sk = Shop.byId.get(cur), le = E.outCubic(prog(t, s0, .2));
        fadeTo(pLabel, skins && !walled ? le : 0);
        place(pLabel, 0, dyLabel + (1 - le) * 30, 1);
        setText(lbEm, sk.emoji);
        setText(lbNm, sk.name);
        setText(lbPr, sk.price ? `🪙 ${fmt(sk.price)}` : 'FREE');

        // --- mur
        show(pWall, walled);
        if (walled) {
          const wp = E.outExpo(prog(t, T_WALL, 1.1)), ws = lerp(wS0, wS1, wp);
          place(pWall, lerp(HC.x, W / 2, wp), lerp(HC.y, H / 2, wp) - wallOff * ws * (1 - wp), ws, -7 * wp);
          wrows.forEach((r, i) => { r.style.transform = `translateX(${(((i - midR) % 2 ? CELL_W / 2 : 0) + ((i - midR) % 2 ? 1 : -1) * 24 * (t - T_WALL)).toFixed(2)}px)`; });
        }
        dim.style.opacity = E.outCubic(prog(t, T_WALL + .28, .45)).toFixed(3);

        // --- lumière : indigo pendant le tirage, couleurs du Mythic à la révélation, puis celle du skin
        let lc = mix(C.indigo, C.pink, E.outCubic(prog(t, T_PEAK, .3)));
        let la = .09 + .018 * revealed + (peak ? .2 * Math.exp(-1.4 * (t - T_PEAK)) : 0); // chaque chiffre posé éclaire un peu plus
        if (li >= 0) { lc = mix(SKIN_LIGHT[li ? SWAPS[li - 1][1] : 'classic'], SKIN_LIGHT[cur], prog(t, SWAPS[li][0], .22)); la = .24; }
        if (walled) { lc = mix(lc, C.purple, prog(t, T_WALL, .5)); la = lerp(.24, .16, prog(t, T_WALL, .5)); }
        const lp = walled ? { x: W / 2, y: H / 2 } : toScreen(gx, gy);
        light(lp.x, lp.y, (P ? 1150 : 1250) * z, lc, la);
        if (peak && !skins) light(lp.x + (P ? 0 : 300), lp.y + (P ? 500 : 80), 900, C.cyan, .07 * (1 - out));

        cA.at(t, -.9, 2.75); // déjà en place à t = 0 : la première image du film est une image composée
        sA.at(t, -.7, 2.65);
        cB.at(t, T_SPLIT + .35, T_HERO_OUT - .1);
        sB.at(t, T_SPLIT + .65, T_HERO_OUT - .15);
        cC.at(t, T_HERO_OUT + .3, T_WALL - .5);
        cW.at(t, T_WALL + .25);
        sW.at(t, T_WALL + .55);
      };
    });

    // ================================================================ 2. duel en direct : 2 joueurs, puis 10
    // Une face de duel : le cadre du site (.room-side) avec la carte du joueur.
    function sideHTML(p) {
      return `<div class="room-side${p.me ? ' me' : ''}${p.skin !== 'classic' ? ` side-${p.skin}` : ''}">${p.skin === 'fire' ? '<span class="side-embers" aria-hidden="true"></span>' : ''}
        <div class="room-name"><span class="trophy-drop">🏆 </span>${esc(p.name)}</div>
        ${cardHTML('000000', { skin: p.skin, cls: 'neutral' })}
        <div class="room-meta">${tierPill(p.a.tier)}<span class="ep-pill">0 XP</span></div>
        <div class="pill-row">${pillsHTML(p.a)}</div>
      </div>`;
    }
    function sideParts(wrap, p, k) {
      const side = wrap.querySelector('.room-side'), card = side.querySelector('.num-card');
      if (p.skin === 'matrix') attachRain(card, 2);
      return { p, k, wrap, side, card, slots: Array.from(card.querySelectorAll('.slot')), meta: side.querySelector('.room-meta'), xp: side.querySelector('.ep-pill'),
        pills: Array.from(side.querySelectorAll('.pill-row .badge-pill')), row: side.querySelector('.pill-row'), trophy: side.querySelector('.trophy-drop'), str: p.a.str.padStart(6, '0') };
    }
    // Révélation d'une manche, comme sur le site : les chiffres de toutes les cartes tombent ensemble.
    function sideUpdate(S, t, locks, tRev, tWin, won, count = .7) {
      let revealed = 0;
      for (let i = 0; i < 6; i++) if (t >= locks[i]) revealed = i + 1;
      S.slots.forEach((s, i) => {
        const locked = i < revealed;
        setText(s, locked ? S.str[i] : spinGlyph(S.p.skin, i, t, S.k + 1));
        setAnim(s, 'spinning', !locked, 0);
        setAnim(s, 'revealed', locked, locks[i]);
      });
      const rev = t >= tRev, last = revealed ? locks[revealed - 1] : -9;
      setCls(S.card, 'neutral', !rev);
      setAnim(S.card, 'charging', !rev, 0, 'charge');
      if (rev) S.card.dataset.tier = S.p.a.tier; else delete S.card.dataset.tier;
      setAnim(S.side, 'thump', t - last < .24, last, 'thump');
      vis(S.meta, rev);
      vis(S.row, rev);
      if (rev) {
        setText(S.xp, `${fmt(S.p.a.total * E.outCubic(prog(t, tRev, count)))} XP`);
        S.pills.forEach((pl, i) => { const e = prog(t, tRev + .12 + i * .08, .4); pl.style.transform = `scale(${lerp(.4, 1, E.snap(e)).toFixed(3)})`; pl.style.opacity = clamp(e * 3).toFixed(3); });
      }
      const w = won && t >= tWin;
      setCls(S.side, 'won', w);
      show(S.trophy, w);
      if (w) S.trophy.__t0 = { '*': tWin };
    }

    scene('duel', T_DUEL, T_LB, root => {
      const D = T_DUEL;
      const LK = [.75, 1, 1.25, 1.5, 1.75, 2].map(x => D + x), T_REV = D + 2.12, T_WIN = D + 2.5, T_GRID = D + 4;
      const GK = [.375, .5, .625, .75, .875, 1].map(x => T_GRID + x), G_REV = T_GRID + 1.1, G_WIN = T_GRID + 1.25;
      const duo = [{ name: 'You', skin: 'fire', n: 123321, me: true }, { name: 'Kairo', skin: 'galaxy', n: 246810 }].map(p => ({ ...p, a: analysis(p.n) }));
      const ten = [['You', 'fire', 643216, true], ['Kairo', 'galaxy', 288200], ['Nova', 'neon', 201612], ['Mochi', 'candy', 115020], ['Zeph', 'matrix', 574475],
        ['Pixl', 'slots', 511951], ['Juno', 'vaporwave', 968427], ['Tako', 'gold', 707057], ['Rune', 'blocks', 306021], ['Lumen', 'rainbow', 250249]]
        .map(([name, skin, n, me]) => ({ name, skin, n, me: !!me, a: analysis(n) }));
      const best = list => list.reduce((b, p, i) => (p.a.total > list[b].a.total ? i : b), 0);
      const w2 = best(duo), w10 = best(ten), rowsSpec = P ? [2, 2, 2, 2, 2] : [5, 5];
      let k = 0;
      root.innerHTML = `
        <div class="pin" id="d-two"><div class="ctr duo">
          <div class="dside">${sideHTML(duo[0])}<div class="react-layer"></div></div>
          <div class="dvs">VS</div>
          <div class="dside">${sideHTML(duo[1])}<div class="react-layer"></div></div>
        </div></div>
        <div class="pin" id="d-grid"><div class="ctr g10">${rowsSpec.map(n => `<div class="room-stage many">${ten.slice(k, k += n).map(p => `<div class="dside">${sideHTML(p)}</div>`).join('')}</div>`).join('')}</div></div>`;
      const $ = s => root.querySelector(s);
      const pTwo = $('#d-two'), duoEl = $('.duo'), vs = $('.dvs'), pGrid = $('#d-grid'), gridEl = $('.g10');
      const S2 = Array.from(duoEl.querySelectorAll('.dside')).map((w, i) => sideParts(w, duo[i], i));
      const S10 = Array.from(gridEl.querySelectorAll('.dside')).map((w, i) => sideParts(w, ten[i], i + 2));
      // Emotes du site (mascotte dé) : le gagnant fanfaronne, le perdant pleure.
      const bubbles = [[w2, 'king', T_WIN + .25, w2 ? 91 : 9], [1 - w2, 'cry', T_WIN + .5, w2 ? 9 : 91], [w2, 'laugh', T_WIN + .75, w2 ? 9 : 91]].map(([side, id, t0, left]) => {
        const b = el('span', 'react-bubble', `<img class="emote" src="../img/emotes/${id}.png" alt=""><small>${esc(duo[side].name)}</small>`, S2[side].wrap.querySelector('.react-layer'));
        b.style.left = `calc(${left}% - 38px)`; // sur les bords du cadre : le nombre reste lisible
        b.__t0 = { '*': t0 };
        return { b, t0 };
      });

      const S_TWO = P ? 2.1 : 2.55, TWO = P ? { x: 540, y: 1040 } : { x: 960, y: 640 };
      const S_GRID = Math.min((W - (P ? 70 : 90)) / gridEl.offsetWidth, (P ? 1290 : 640) / gridEl.offsetHeight), GRID = P ? { x: 540, y: 1085 } : { x: 960, y: 665 };
      // Centre d'une carte du duel à deux, dans le plan.
      const cardAt = i => {
        const r = natRect(S2[i].card, duoEl);
        return { x: TWO.x + (r.x + r.w / 2 - duoEl.offsetWidth / 2) * S_TWO, y: TWO.y + (r.y + r.h / 2 - duoEl.offsetHeight / 2) * S_TWO, w: r.w * S_TWO, h: r.h * S_TWO };
      };
      const sideAt = i => {
        const r = natRect(S2[i].side, duoEl);
        return { x: TWO.x + (r.x + r.w / 2 - duoEl.offsetWidth / 2) * S_TWO, y: TWO.y + (r.y + r.h / 2 - duoEl.offsetHeight / 2) * S_TWO };
      };
      const c0 = cardAt(0), c1 = cardAt(1), cw = cardAt(w2), p0 = sideAt(0), p1 = sideAt(1);
      burst(T_REV, c0.x, c0.y, CONF[duo[0].a.tier], 21, 2.2);
      burst(T_REV, c1.x, c1.y, CONF[duo[1].a.tier], 22, 2.2);
      ring(T_WIN, cw.x, cw.y, cw.w, cw.h, TIER_RING[duo[w2].a.tier] || TIER_RING.uncommon, { radius: 12 * S_TWO, width: 3 * S_TWO });
      impulse(T_WIN, cw.x, cw.y, 150, .8);
      impulse(D + .5, TWO.x, TWO.y, 90, .5);
      flash(D + .5, .3, 'white', .08);
      cue(D + .5, 'slam');
      ticks(D + .62, LK[5], { soft: 1 });
      LK.forEach((t, i) => cue(t, 'lock', { i, soft: 1 }));
      cue(T_REV, 'reveal');
      cue(T_WIN, 'win');
      bubbles.forEach((x, i) => cue(x.t0, 'bubble', { i }));
      cue(T_GRID, 'whoosh', { dur: .35, pan: 0 });
      ticks(T_GRID + .1, GK[5], { soft: 1 });
      GK.forEach((t, i) => cue(t, 'lock', { i, soft: 1, grid: 1 }));
      cue(G_REV, 'reveal', { small: 1 });
      cue(G_WIN, 'win', { small: 1 });

      const c1a = put(claim(root, 'Duel your *friends*', 'hot'), P ? 270 : 64, P ? 98 : 112);
      const s1a = put(fade(root, 'sub', '<b>live</b> · everyone rolls at once'), P ? 392 : 192, P ? 34 : 38);
      const c2a = put(claim(root, 'Up to *10* *players*', 'hot'), P ? 270 : 150, P ? 98 : 124);

      return t => {
        // --- les deux cadres arrivent des bords et se font face
        const gout = E.inOutCubic(prog(t, T_GRID, .2));
        show(pTwo, gout < 1);
        place(pTwo, TWO.x, TWO.y, S_TWO * lerp(1, .8, gout) * (1 + .03 * prog(t, D, 4))); // lente avancée de la caméra
        pTwo.style.opacity = (1 - gout).toFixed(3);
        const sin = E.outExpo(prog(t, D + .04, .62)), bump = 1 + .03 * kick(t, D + .5, 10, 18), win = E.snap(prog(t, T_WIN, .45)), lose = prog(t, T_WIN, .4);
        S2.forEach((S, i) => {
          const off = (i ? 1 : -1) * (1 - sin) * (P ? 520 : 480), isW = i === w2;
          sideUpdate(S, t, LK, T_REV, T_WIN, isW);
          S.wrap.style.transform = `translate(${(P ? 0 : off).toFixed(2)}px,${((P ? off : 0) - (isW ? 6 * win : 0)).toFixed(2)}px) scale(${(bump * (isW ? 1 + .055 * win : 1 - .03 * lose)).toFixed(4)})`;
          S.wrap.style.opacity = (clamp(sin * 2) * (isW ? 1 : lerp(1, .5, lose))).toFixed(3);
          S.wrap.style.filter = !isW && lose > 0 ? `saturate(${lerp(1, .5, lose).toFixed(2)})` : '';
          S.wrap.style.zIndex = isW ? 2 : 1;
        });
        const ve = prog(t, D + .4, .36);
        vs.style.transform = `scale(${E.outBack(ve, 2.6).toFixed(3)}) rotate(${((1 - E.outCubic(ve)) * -40).toFixed(2)}deg)`;
        vs.style.opacity = clamp(ve * 4).toFixed(3);
        bubbles.forEach(x => show(x.b, t >= x.t0 && t < x.t0 + 2.8));

        // --- à dix : tout le monde tire au même instant
        const gin = E.outCubic(prog(t, T_GRID + .12, .4));
        show(pGrid, t >= T_GRID);
        place(pGrid, GRID.x, GRID.y, S_GRID * lerp(1.22, 1, gin));
        pGrid.style.opacity = clamp(prog(t, T_GRID + .12, .2)).toFixed(3);
        if (t >= T_GRID) {
          S10.forEach((S, i) => {
            sideUpdate(S, t, GK, G_REV, G_WIN, i === w10, .3);
            S.wrap.style.opacity = i === w10 ? 1 : lerp(1, .66, prog(t, G_WIN, .25)).toFixed(3);
          });
        }

        const k2 = 1 - gout;
        light(p0.x, p0.y, P ? 900 : 950, C.orange, (.2 + (w2 === 0 ? .14 : -.1) * lose) * k2 * sin);
        light(p1.x, p1.y, P ? 900 : 950, C.violet, (.2 + (w2 === 1 ? .14 : -.1) * lose) * k2 * sin);
        if (gout > 0) light(W / 2, GRID.y, 1300, C.purple, .16 * gout);
        c1a.at(t, D + .12, T_GRID - .12);
        s1a.at(t, D + .4, T_GRID - .16);
        c2a.at(t, T_GRID + .1);
      };
    });

    // ================================================================ 3. le classement
    scene('lb', T_LB, T_OUTRO, root => {
      const L = T_LB, T_FLIP = L + .5, T_CLIMB = L + .6, T_TOP = L + 2; // T_TOP : instant où je double le 1er, la ligne passe à l'or
      const NAMES = 'Nova Kairo Mochi Zeph Pixl Juno Tako Rune Lumen Orbit Vex Echo Finch Delta Quill Ember Onyx Sable Rift Halo Byte Comet Dusk Glitch Ivy Jinx Koi Lynx Mira Neko Opal Quark Rook Soda Tonic Umbra Volt Wisp Yuzu Zinc Axel Birch Clover'.split(' ');
      const NUMS = [314159, 999999, 271828, 262144, 65536, 100000, 531441, 111111, 123456, 987654, 5040, 500000, 101010, 322222, 200003, 979899, 443210, 167777, 133799, 799997,
        999933, 643216, 220011, 865431, 403403, 999176, 574475, 660606, 929928, 250249, 552522, 991099, 288200, 201612, 511951, 875435, 644467, 107750, 707057, 115020, 301219, 306021, 968427];
      const others = NUMS.map((n, i) => ({ name: NAMES[i], n, a: analysis(n) })).sort((x, y) => y.a.total - x.a.total);
      others.forEach(o => { o.lx = Math.log(o.a.total); });
      const before = analysis(8128), after = analysis(777777), X0 = Math.log(before.total), X1 = Math.log(after.total), XTOP = others[0].lx + .14; // XTOP : juste devant le 1er
      // La montée est pilotée par le rang, pas par l'XP : les XP des autres joueurs sont très inégalement espacés, et une
      // montée pilotée par l'XP s'arrêtait net dans les grands écarts (8 images figées en pleine course) avant de repartir.
      const P0 = others.filter(o => o.a.total > before.total).length; // joueurs devant moi au départ
      const CLIMB = (T_TOP - T_CLIMB) / (1 - Math.cbrt(1 / P0) / 2); // durée de la montée telle que le rang 0,5 soit atteint à T_TOP
      const rankAt = t => P0 * (1 - E.inOutCubic(prog(t, T_CLIMB, CLIMB))); // 0 = en tête
      // Mon XP se déduit du rang : au moment où je double le joueur i, j'ai exactement son XP.
      const xpAt = p => {
        if (p >= P0) return X0;
        if (p < .5) return lerp(XTOP, others[0].lx, p / .5);
        const k = Math.floor(p - .5), last = k + 1 >= P0;
        return lerp(others[k].lx, last ? X0 : others[k + 1].lx, (p - .5 - k) / (last ? .5 : 1));
      };
      const ROW = 50, VISIBLE = P ? 9 : 7, N = others.length;
      const rowHTML = (name, a, me) => `<div class="lb-row${me ? ' me' : ''}"><span class="lb-rank"></span><span class="lb-who"><span class="lb-name">${esc(name)}</span></span>
        <span class="num-card sm" data-tier="${a.tier}">${a.str}</span><span class="lb-ep mono">${fmt(a.total)} XP</span></div>`;
      root.innerHTML = `
        <div class="pin" id="l-board"><div class="ctr">
          <div class="lb-card lbx">
            <div class="lb-tabs"><button>Today</button><button>This week</button><button class="on">All-time</button><button>Lifetime XP</button></div>
            <div class="lbx-view" style="height:${VISIBLE * ROW}px"><div class="lbx-list">${others.map(o => rowHTML(o.name, o.a)).join('')}${rowHTML('You', before, true)}</div></div>
          </div>
        </div></div>`;
      const pBoard = root.querySelector('#l-board'), list = root.querySelector('.lbx-list'), rowsEl = Array.from(list.children), me = rowsEl[N];
      const ranks = rowsEl.map(r => r.querySelector('.lb-rank')), meCard = me.querySelector('.num-card'), meXp = me.querySelector('.lb-ep');
      const boardEl = root.querySelector('.lbx');
      const S = P ? 2.25 : 2.1, B = P ? { x: 540, y: 1130 } : { x: 1306, y: 560 };
      const rankText = r => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[r] || `#${r}`);
      // Position finale de ma ligne (première du classement), dans le plan.
      const viewTop = B.y + (natRect(root.querySelector('.lbx-view'), boardEl).y - boardEl.offsetHeight / 2) * S;
      const meFinal = { x: B.x, y: viewTop + (ROW / 2) * S, w: boardEl.offsetWidth * S, h: ROW * S };
      ring(T_TOP, meFinal.x, meFinal.y, meFinal.w, meFinal.h, '#fbbf24', { radius: 10 * S, width: 3 * S, grow: 1.9 });
      streak(T_TOP, meFinal.x, meFinal.y, C.gold, { len: W * 1.1 });
      burst(T_TOP + .02, meFinal.x, meFinal.y, CONF.gold, 31, 2.4);
      flash(T_TOP, .8, 'gold', .34, meFinal.x, meFinal.y);
      impulse(T_TOP, meFinal.x, meFinal.y, 170, .9);
      cue(L + .08, 'whoosh', { dur: .5, pan: P ? 0 : .4 });
      cue(T_FLIP, 'pop');
      // Un repère à chaque joueur doublé (rang k + 0,5), en inversant la courbe de la montée.
      for (let k = P0 - 1; k >= 1; k--) {
        const e = 1 - (k + .5) / P0, x = e < .5 ? Math.cbrt(e / 4) : 1 - Math.cbrt(2 * (1 - e)) / 2;
        cue(T_CLIMB + CLIMB * x, 'pass', { k, of: P0 });
      }
      cue(T_TOP, 'impact', { kind: 'gold' });

      const c = put(claim(root, P ? 'Climb|the *ranks*' : 'Climb|the|*ranks*', `gold${P ? '' : ' left'}`), P ? 250 : 300, P ? 124 : 132);
      const s = put(fade(root, `sub${P ? '' : ' left'}`, 'daily · weekly · <b>all-time</b>'), P ? 520 : 740, P ? 34 : 32);
      if (!P) { c.el.style.left = '110px'; s.el.style.left = '116px'; }

      return t => {
        const bin = E.outExpo(prog(t, L + .05, .6));
        place(pBoard, B.x, B.y + (1 - bin) * 220, S * (1 + .022 * prog(t, L, T_OUTRO - L))); // lente avancée : l'image ne se fige jamais
        pBoard.style.opacity = clamp(prog(t, L + .05, .25)).toFixed(3);

        // Mon rang descend de façon continue ; l'XP affiché suit (puis finit de grimper une fois en tête).
        const p = rankAt(t), lx = xpAt(p) + (X1 - XTOP) * E.outCubic(prog(t, T_TOP, .6));
        const scroll = clamp(p - (VISIBLE - 3), 0, N + 1 - VISIBLE);
        list.style.transform = `translateY(${(-scroll * ROW).toFixed(2)}px)`;
        others.forEach((o, i) => {
          const a = clamp(p - i); // 1 = encore devant moi, 0 = doublé : la ligne glisse alors d'un cran vers le bas
          rowsEl[i].style.transform = `translateY(${((i + 1 - a * a * (3 - 2 * a)) * ROW).toFixed(2)}px)`;
          setText(ranks[i], rankText(i + 1 + (a < .5 ? 1 : 0)));
        });
        const moving = Math.sin(Math.PI * prog(t, T_CLIMB, CLIMB)), land = kick(t, T_TOP, 8, 16), flipped = t >= T_FLIP, first = t >= T_TOP;
        me.style.transform = `translateY(${(p * ROW).toFixed(2)}px) scale(${(1 + .035 * moving + .05 * land).toFixed(4)})`;
        me.style.boxShadow = first ? `0 0 0 2px #fbbf24, 0 0 ${(26 + 30 * Math.max(0, land)).toFixed(0)}px rgba(251,191,36,.55)` : `0 0 0 2px var(--chart-accent), 0 10px 26px rgba(0,0,0,.5)`;
        setCls(me, 'first', first);
        setText(ranks[N], rankText(Math.round(p) + 1));
        setText(meCard, flipped ? after.str : before.str);
        meCard.dataset.tier = flipped ? after.tier : before.tier;
        meCard.style.transform = `scale(${(1 + .25 * kick(t, T_FLIP, 9, 14)).toFixed(3)})`;
        setText(meXp, `${fmt(Math.exp(lx))} XP`);

        light(B.x, B.y, P ? 1100 : 1150, mix(hex('#3b82f6'), C.gold, prog(t, T_TOP - .3, .5)), .16 + .1 * prog(t, T_TOP - .3, .5));
        c.at(t, L + .12);
        s.at(t, P ? 1e9 : L + .45);
      };
    });

    // ================================================================ 4. le logo : RNG8, dont le 8 bascule en ∞
    scene('outro', T_OUTRO, DURATION + 1, root => {
      const O = T_OUTRO, LETTERS = ['R', 'N', 'G'], LK = [O + .5, O + .75, O + 1], T_8 = O + 1.25, T_TURN = O + 1.5, T_HIT = O + 2, T_DONE = T_HIT + .12;
      root.innerHTML = `
        <div class="pin" id="o-logo"><div class="ctr logo">${LETTERS.map(ch => `<span class="ll">${ch}</span>`).join('')}<span class="l8"><i class="eight">8</i><i class="inf">∞</i></span><div class="logo-shine">RNG∞</div></div></div>
        <div class="pin" id="o-cta"><div class="ctr"><div class="btn-roll cta">rng-infinite.com</div></div></div>`;
      const pLogo = root.querySelector('#o-logo'), logo = root.querySelector('.logo'), ll = Array.from(root.querySelectorAll('.ll')), l8 = root.querySelector('.l8');
      const eight = root.querySelector('.eight'), inf = root.querySelector('.inf'), shine = root.querySelector('.logo-shine'), pCta = root.querySelector('#o-cta');
      // Chaque lettre garde la largeur de sa lettre finale : pendant qu'elle défile, le logo ne bouge pas.
      ll.forEach(s => { s.style.width = `${s.getBoundingClientRect().width}px`; });
      inf.style.position = 'static';
      eight.style.display = 'none';
      const wInf = l8.getBoundingClientRect().width;
      inf.style.position = '';
      eight.style.display = '';
      const w8 = l8.getBoundingClientRect().width;
      const LG = P ? { x: 540, y: 740 } : { x: 960, y: 400 }, CTA = P ? { x: 540, y: 1320 } : { x: 960, y: 846 }, S_CTA = 2.1;
      const lw = logo.offsetWidth - w8 + wInf, lh = logo.offsetHeight;
      ring(T_HIT, LG.x, LG.y, lw * 1.04, lh * .9, TIER_RING.mythic, { grow: 1.9, radius: 60 });
      ring(T_DONE, LG.x, LG.y, lw * 1.04, lh * .9, '#a855f7', { grow: 2.3, radius: 60 });
      burst(T_HIT + .02, LG.x, LG.y, CONF.mythic, 41, 2.6);
      flash(T_HIT, .9, 'mythic', .4, LG.x, LG.y);
      flash(T_HIT, .2, 'white', .3);
      impulse(T_HIT, LG.x, LG.y, 220, 1);
      streak(T_HIT, LG.x, LG.y, C.purple);
      ticks(O + .06, T_8, { soft: 1 });
      LK.forEach((t, i) => cue(t, 'letter', { i }));
      cue(T_8, 'letter', { i: 3 });
      cue(T_TURN, 'whoosh', { dur: .3, pan: 0 });
      cue(T_HIT, 'impact', { kind: 'logo' });
      cue(T_HIT + .75, 'pop');

      const tag = put(claim(root, P ? 'What will|*yours* be?' : 'What will *yours* be?'), P ? 936 : 612, P ? 112 : 92);
      const sub = put(fade(root, 'sub', 'free · no download · <b>infinite rolls</b>'), P ? 1440 : 966, P ? 30 : 32);
      const ALPHA = 'ABCDEFHJKLMPQSTUVWXYZ023456789';

      return t => {
        place(pLogo, LG.x, LG.y, lerp(.86, 1, E.outCubic(prog(t, O, .7))) * (1 + .045 * kick(t, T_HIT, 8, 15)) * (1 + .03 * prog(t, T_DONE, DURATION - T_DONE)));
        ll.forEach((s, i) => {
          const locked = t >= LK[i], e = E.snap(prog(t, LK[i], .42));
          setText(s, locked ? LETTERS[i] : ALPHA[Math.floor(hash(i + 40, Math.floor(t / .055)) * ALPHA.length)]);
          s.style.opacity = locked ? clamp(.35 + e).toFixed(3) : (.34 + .1 * Math.sin(t * 57 + i)).toFixed(3);
          s.style.transform = locked ? `translateY(${((1 - e) * -.12).toFixed(4)}em) scale(${lerp(1.1, 1, e).toFixed(4)})` : `translateY(${(.04 * Math.sin(t * 60 + i * 2)).toFixed(4)}em)`;
        });
        // Le 4e rouleau s'arrête sur 8… qui se couche et devient ∞.
        const l8on = t >= T_8, e8 = E.snap(prog(t, T_8, .42)), turn = E.outBack(prog(t, T_TURN, .32), 1.5), morph = t >= T_HIT ? 1 : 0;
        setText(eight, l8on ? '8' : String(Math.floor(hash(77, Math.floor(t / .055)) * 10)));
        l8.style.width = `${lerp(w8, wInf, E.inOutCubic(prog(t, T_TURN, .32))).toFixed(2)}px`;
        eight.style.opacity = (l8on ? clamp(.35 + e8) * (1 - morph) : .4).toFixed(3);
        eight.style.transform = l8on ? `translateY(${((1 - e8) * -.12).toFixed(4)}em) rotate(${(90 * turn).toFixed(2)}deg) scale(${lerp(1.1, 1, e8).toFixed(4)})` : `translateY(${(.04 * Math.sin(t * 60)).toFixed(4)}em)`;
        inf.style.opacity = morph.toFixed(3);
        inf.style.transform = `scale(${lerp(1.25, 1, E.outBack(prog(t, T_HIT, .4), 2)).toFixed(4)})`;
        // Reflet coloré qui traverse le logo une fois posé, puis repasse de temps en temps.
        const sp = prog(t, T_DONE + .05, .9), sp2 = prog(t, T_DONE + 1.55, .9); // la dernière image reste blanche
        vis(shine, t >= T_DONE);
        shine.style.backgroundPosition = `${lerp(100, 0, sp < 1 ? sp : sp2).toFixed(2)}% 0`;

        tag.at(t, T_DONE + .12);
        const ce = prog(t, T_HIT + .75, .5);
        fadeTo(pCta, clamp(ce * 3));
        place(pCta, CTA.x, CTA.y + (1 - E.outCubic(ce)) * 40, S_CTA * lerp(.8, 1, E.outBack(ce, 2)) * (1 + .012 * Math.sin((t - O) * 3.2)));
        sub.at(t, T_HIT + 1.25);

        const pulse = .5 + .5 * Math.sin((t - O) * 1.3);
        light(LG.x, LG.y, P ? 1150 : 1250, mix(C.pink, C.purple, pulse), .1 + .12 * prog(t, T_HIT, .4));
        light(CTA.x, CTA.y + 200, 900, C.cyan, .06 * prog(t, T_DONE, 1));
      };
    });

    wipe(T_DUEL, ['#fb923c', '#f43f5e', '#e879f9']);
    wipe(T_LB, ['#fde68a', '#f59e0b', '#fb923c']);
    wipe(T_OUTRO, ['#f472b6', '#a855f7', '#22d3ee']);
    SCORE.forEach(([t, level, chord]) => cue(t, 'music', { level, chord }));
  }

  // ------------------------------------------------------------------ une image
  function seek(out) {
    out = clamp(out, 0, LENGTH);
    const t = toSource(out); // instant du film complet
    view.lights.length = 0;
    view.cam = IDENT;
    view.dark = 0;
    for (const s of scenes) {
      const on = t >= s.start && t < s.end;
      show(s.root, on);
      if (on) s.update(t);
    }
    bug.style.opacity = (.85 * (1 - prog(t, T_WALL, .2) + prog(t, T_DUEL, .2)) * (1 - prog(t, T_OUTRO - .3, .25))).toFixed(3);
    drawBg(t);
    drawFx(t, out);
    drawRains(t);
    syncAnimations(t);
    setText(tcEl, out.toFixed(2));
  }

  async function init() {
    if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r, { once: true }));
    const faces = ['900 80px Inter', '800 80px Inter', '700 20px Inter', '600 20px Inter', '500 20px Inter', '400 20px Inter', '700 40px "Space Mono"', '400 40px "Space Mono"',
      '20px "Press Start 2P"', '20px Graduate', '20px "Share Tech Mono"'];
    await Promise.all(faces.map(f => document.fonts.load(f, 'RNG 0123456789 ｱ').catch(() => null)));
    await document.fonts.ready;
    await Promise.all(['laugh', 'cry', 'angry', 'cool', 'shock', 'king'].map(id => { const im = new Image(); im.src = `../img/emotes/${id}.png`; return im.decode().catch(() => null); }));
    buildScenes();
    seek(Number(qs.get('t')) || 0);
    // Pour l'export : window.__seek(t) dessine l'image t ; __trailer décrit le film et liste les nombres montrés.
    window.__seek = seek;
    // Repères de la version affichée : ceux des passages gardés, replacés sur sa ligne de temps. Pour une version courte,
    // on ajoute un repère à chaque coupe et on rappelle l'état de la musique au début de chaque passage.
    const list = [];
    for (const c of cues) { const o = toOutput(c.t); if (o !== null) list.push({ ...c, t: Math.round(o * 1000) / 1000 }); }
    if (CUT) {
      let at = 0;
      EDIT.forEach(([a, b], i) => {
        const [, level, chord] = SCORE.filter(x => x[0] <= a).pop();
        list.push({ t: at, type: 'music', level, chord });
        if (i) list.push({ t: at, type: 'cut' });
        at += b - a;
      });
    }
    window.__trailer = { width: W, height: H, fps: FPS, duration: LENGTH, cut: CUT, numbers: Array.from(shownNumbers.keys()), cues: list.sort((a, b) => a.t - b.t) };
    // Pour le lecteur (page parente) : il envoie l'instant à afficher.
    addEventListener('message', e => { if (e.data && typeof e.data.rngSeek === 'number') seek(e.data.rngSeek); });
    if (parent !== window) parent.postMessage('rng-ready', '*');
  }
  init().catch(err => { window.__trailerError = String((err && err.stack) || err); console.error(err); });

  // ------------------------------------------------------------------ lecteur : lecture, pause, déplacement
  // Le plan est rendu dans un cadre (iframe) à sa taille réelle, puis réduit pour tenir dans la fenêtre : les règles
  // "petit écran" du site dépendent de la largeur de la page et ne doivent pas se déclencher dans un aperçu étroit.
  function player() {
    const HUD_H = 56;
    document.getElementById('stage').remove();
    const frame = document.createElement('iframe');
    frame.title = 'RNG∞ trailer';
    frame.src = `${location.pathname}?export${P ? '&format=v' : ''}${CUT ? `&cut=${CUT}` : ''}${qs.has('tc') ? '&tc' : ''}`;
    Object.assign(frame.style, { position: 'absolute', width: `${W}px`, height: `${H}px`, border: '0', transformOrigin: '0 0', background: '#000' });
    document.getElementById('viewport').appendChild(frame);
    const hud = { play: document.getElementById('hud-play'), seek: document.getElementById('hud-seek'), time: document.getElementById('hud-time'), format: document.getElementById('hud-format') };
    let now = Number(qs.get('t')) || 0, playing = !qs.has('t'), last = 0, ready = false;
    const fit = () => {
      const s = Math.min(innerWidth / W, (innerHeight - HUD_H) / H);
      frame.style.transform = `scale(${s})`;
      frame.style.left = `${(innerWidth - W * s) / 2}px`;
      frame.style.top = `${(innerHeight - HUD_H - H * s) / 2}px`;
    };
    const draw = () => {
      if (ready) frame.contentWindow.postMessage({ rngSeek: Math.min(now, LENGTH) }, '*');
      hud.seek.value = now;
      hud.time.textContent = `${Math.min(now, LENGTH).toFixed(2)} / ${LENGTH.toFixed(2)}`;
      hud.play.textContent = playing ? 'Pause' : 'Play';
    };
    const go = t => { now = Math.min(LENGTH, Math.max(0, t)); draw(); };
    const loop = ts => {
      if (playing && ready) {
        now += Math.min(.1, (ts - last) / 1000);
        if (now >= LENGTH + 1.2) now = 0; // tient la dernière image un instant, puis reprend
        draw();
      }
      last = ts;
      requestAnimationFrame(loop);
    };
    hud.seek.max = LENGTH;
    hud.format.textContent = P ? '16:9' : '9:16';
    hud.format.href = `?${[P ? '' : 'format=v', CUT ? `cut=${CUT}` : ''].filter(Boolean).join('&')}`;
    hud.play.addEventListener('click', () => { playing = !playing; if (now >= LENGTH) now = 0; draw(); });
    hud.seek.addEventListener('input', () => { playing = false; go(Number(hud.seek.value)); });
    addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); hud.play.click(); }
      if (e.code === 'ArrowRight') { playing = false; go(now + (e.shiftKey ? 1 : 1 / FPS)); }
      if (e.code === 'ArrowLeft') { playing = false; go(now - (e.shiftKey ? 1 : 1 / FPS)); }
    });
    addEventListener('message', e => { if (e.data === 'rng-ready') { ready = true; draw(); } });
    addEventListener('resize', fit);
    fit();
    draw();
    requestAnimationFrame(loop);
  }
})();
