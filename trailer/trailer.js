/* RNG∞ — trailer v2 (motion design piloté par le code), demandé par Sacha le 2026-10-26 : un film promo de 38 s qui
 * montre tout ce qui est arrivé depuis le premier trailer (skins légendaires, fonds animés, chat global, clans, tournois,
 * casino, photos de profil, titres Prestige, feuille de route des idées de joueurs) et finit sur un tirage Infinite.
 * Tout est une fonction du temps : seek(t) dessine l'image de l'instant t sans rien retenir de l'image d'avant.
 * L'aperçu (lecture dans le navigateur) et l'export (tools/trailer-render.mjs, image par image) passent par la même
 * fonction. Les animations CSS du site sont en pause et calées sur t (syncAnimations) : ce qu'on voit est le vrai rendu
 * du jeu (vraies cartes, vrais skins avec leur séquence js/skinfx.js, vrais panneaux). Nombres, badges, XP et raretés
 * sortent du moteur du jeu. Joueurs inventés (Nova, Pixel, Rex…), avatars dessinés ici (aucun visage réel).
 *   ?format=v → 9:16 (1080×1920), sinon 16:9 (1920×1080)   ·   ?cut=15 ou ?cut=6 → version courte
 *   ?export → sans commandes   ·   ?t=12.5 → instant affiché
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const P = qs.get('format') === 'v';
  const W = P ? 1080 : 1920, H = P ? 1920 : 1080;
  const EXPORT = qs.has('export');
  const FPS = 60, DURATION = 38;

  // ------------------------------------------------------------------ montage (secondes)
  // Grille à 120 battements par minute : un temps = 0,5 s, une mesure = 2 s. Chaque coupe tombe sur un temps, chaque
  // révélation sur un temps fort ; la bande-son (tools/trailer-audio.mjs) est écrite à partir des mêmes instants.
  const T = {
    HOOK: 0, ROLL: 2, SKINS: 6, FUN: 11.5, WALL: 14, DIVE: 15.5, SUMMIT: 16.75, CHAT: 18, CLAN: 20, TN: 22,
    CASINO: 24, DICE: 25, BJ: 26, PRESTIGE: 27, ROAD: 28, TURN: 29.5, CLIMAX: 30, DROP: 32, END: 34,
  };
  // Partition : [instant, intensité, accord]. 0 = silence tendu, 1 = pulsation, 2 = demi-rythme, 3 = rythme complet,
  // 4 = drop (tout + mélodie), 5 = accord final.
  const SCORE = [[0, 1, 'Em'], [2, 2, 'Em'], [4, 3, 'C'], [6, 3, 'Em'], [8, 3, 'C'], [10, 3, 'G'], [12, 3, 'D'],
    [14, 2, 'Em'], [16, 2, 'C'], [18, 3, 'Em'], [20, 3, 'C'], [22, 3, 'G'], [24, 3, 'D'], [26, 3, 'Em'], [27, 3, 'C'],
    [28, 2, 'G'], [29.5, 1, 'D'], [30, 2, 'Em'], [31.5, 0, 'D'], [32, 4, 'G'], [34, 5, 'G']];

  // Versions courtes : des passages du film complet (début, fin), tous coupés sur un temps.
  const CUTS = { 15: [[0, 2], [6, 8.5], [18, 19.5], [24, 25], [30, 38]], 6: [[31, 34], [35, 38]] };
  const CUT = CUTS[qs.get('cut')] ? qs.get('cut') : '';
  const EDIT = CUT ? CUTS[CUT] : [[0, DURATION]];
  const LENGTH = EDIT.reduce((x, [a, b]) => x + b - a, 0);
  const toSource = t => { for (const [a, b] of EDIT) { if (t < b - a) return a + t; t -= b - a; } return EDIT[EDIT.length - 1][1]; };
  const toOutput = src => { let at = 0; for (const [a, b] of EDIT) { if (src >= a && src < b) return at + src - a; at += b - a; } return null; };
  const JOINS = EDIT.slice(0, -1).map((r, i) => EDIT.slice(0, i + 1).reduce((x, [a, b]) => x + b - a, 0));

  if (!EXPORT) { player(); return; }

  // ------------------------------------------------------------------ outils
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const prog = (t, t0, d) => clamp((t - t0) / d);
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
  // Une seule famille de courbes dans tout le film : sorties en expo (entrées franches qui se posent), aller-retour en
  // quint pour les mouvements de caméra (lent, très rapide, lent : le filé d'un panoramique), retour élastique "snap"
  // du site pour ce qui claque.
  const E = {
    outQuad: x => 1 - (1 - x) * (1 - x),
    inCubic: x => x * x * x,
    outCubic: x => 1 - Math.pow(1 - x, 3),
    inOutCubic: x => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    inOutQuint: x => (x < .5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
    outExpo: x => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    inExpo: x => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
    outBack: (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
    snap: bezier(.34, 1.36, .64, 1), // --ease-snap du site
    wave: bezier(.15, .75, .3, 1),
  };
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
  const setAnim = (e, cls, on, t0, name = '*') => { setCls(e, cls, on); if (on) (e.__t0 || (e.__t0 = {}))[name] = t0; };
  function natRect(e, root) {
    let x = 0, y = 0;
    for (let n = e; n && n !== root; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return { x, y, w: e.offsetWidth, h: e.offsetHeight };
  }
  // Entrée « pop » : 0 avant t0, monte avec un léger dépassement, 1 posé.
  const popIn = (t, t0, d = .32, s = 1.9) => (t < t0 ? 0 : E.outBack(prog(t, t0, d), s));

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
  // Nombre de nombres Infinite entre 0 et 1 000 000 : compté une fois (sert à l'accroche « only 10 are infinite »).
  const INFINITE_COUNT = 10;

  const slotsHTML = str => str.split('').map(c => `<span class="slot">${c}</span>`).join('');
  const tierPill = tier => `<span class="pill" data-tier="${tier}">${tier}</span>`;
  const GROUP_COLORS = [['#93c5fd', '#2563eb'], ['#86efac', '#059669'], ['#fcd34d', '#d97706'], ['#f9a8d4', '#db2777']];
  function tilesHTML(n, id) {
    const groups = Engine.highlight(id, n), multi = groups.length > 1, info = new Map();
    let offset = 0;
    groups.forEach((g, gi) => {
      const [bgc, bd] = multi ? GROUP_COLORS[gi % GROUP_COLORS.length] : ['var(--t-hl)', 'var(--t-hl-border)'];
      g.forEach((i, k) => { if (!info.has(i)) info.set(i, { bgc, bd, delay: offset + 80 * k }); });
      offset += 80 * g.length + 100;
    });
    return String(n).padStart(6, '0').split('').map((ch, i) => {
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

  // ------------------------------------------------------------------ avatars dessinés (jamais de vrais visages)
  // Petites mascottes abstraites : une forme, deux yeux, une bouche, une couleur par joueur. Rendues en SVG dans le
  // même <span class="av"> que le site (la lettre reste dessous, comme quand l'image charge).
  function avatarSVG(seed) {
    const r = rng(seed * 977 + 13), hue = Math.floor(r() * 360), hue2 = (hue + 40 + r() * 80) % 360, kind = Math.floor(r() * 4);
    const body = [
      `<circle cx="50" cy="56" r="30" fill="hsl(${hue2} 80% 62%)"/>`,
      `<rect x="20" y="28" width="60" height="56" rx="18" fill="hsl(${hue2} 75% 60%)"/>`,
      `<path d="M50 20 L82 80 H18 Z" fill="hsl(${hue2} 80% 62%)" stroke="hsl(${hue2} 80% 62%)" stroke-width="10" stroke-linejoin="round"/>`,
      `<ellipse cx="50" cy="58" rx="33" ry="27" fill="hsl(${hue2} 78% 60%)"/><circle cx="28" cy="34" r="9" fill="hsl(${hue2} 78% 60%)"/><circle cx="72" cy="34" r="9" fill="hsl(${hue2} 78% 60%)"/>`,
    ][kind];
    const ey = kind === 2 ? 60 : 54, smile = r() < .5 ? `<path d="M40 ${ey + 12} Q50 ${ey + 20} 60 ${ey + 12}" stroke="#1f1235" stroke-width="4" fill="none" stroke-linecap="round"/>` : `<ellipse cx="50" cy="${ey + 15}" rx="6" ry="4.5" fill="#1f1235"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 32%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 18%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>${body}<circle cx="40" cy="${ey}" r="7" fill="#fff"/><circle cx="60" cy="${ey}" r="7" fill="#fff"/><circle cx="41.5" cy="${ey + 1}" r="3.4" fill="#1f1235"/><circle cx="61.5" cy="${ey + 1}" r="3.4" fill="#1f1235"/>${smile}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  const avHue = name => { let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };
  const AV_SEED = { Nova: 3, Pixel: 8, Rex: 11, Mochi: 21, Juno: 5, Zeph: 17, Kairo: 30, Tako: 41, Lumen: 2, Orbit: 9, Echo: 14, Finch: 27, Comet: 33, Volt: 6 };
  const avatar = (name, cls = 'av-sm') => `<span class="av ${cls}" data-av="${esc(name)}" style="--av-h:${avHue(name)}"><i>${esc(name[0])}</i><img alt="" src="${avatarSVG(AV_SEED[name] || name.length)}"></span>`;
  const titlePill = id => { const p = Shop.PRESTIGE.find(x => x.id === id); return `<span class="title-owner title-fx tt-${id}"><i aria-hidden="true">${p.emoji}</i>${esc(p.name)}</span>`; };

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
  const grade = el('div', 'layer grade', null, stage);
  const tcEl = el('div', 'tc', '', stage);
  bg.width = fx.width = W;
  bg.height = fx.height = H;
  const bgc = bg.getContext('2d'), fxc = fx.getContext('2d');

  const IDENT = { z: 1, x: 0, y: 0 };
  const view = { lights: [], cam: IDENT, dark: 0, speed: 0 };
  const light = (x, y, r, c, a) => view.lights.push({ x, y, r, c, a });

  // ------------------------------------------------------------------ animations CSS du site, calées sur t
  // Chaque animation CSS est mise en pause et placée à (t − départ) × vitesse. Départ et vitesse sont notés sur
  // l'élément (__t0 par nom d'animation ou '*', __rate) ; sans départ noté (boucles de décor), l'animation suit t.
  const anims = new Set();
  function syncAnimations(t) {
    for (const a of document.getAnimations()) anims.add(a);
    for (const a of anims) {
      const target = a.effect && a.effect.target;
      if (!target || !target.isConnected || a.playState === 'idle') { anims.delete(a); continue; }
      if (!('animationName' in a)) { anims.delete(a); continue; }
      const t0 = target.__t0 ? (target.__t0[a.animationName] ?? target.__t0['*'] ?? 0) : 0;
      if (a.playState !== 'paused') a.pause();
      a.currentTime = Math.max(0, (t - t0) * 1000 * (target.__rate || 1));
    }
  }

  // ------------------------------------------------------------------ fond : lumière, champ de chiffres, vignette
  const BASE = '#111017';
  const field = (() => {
    const r = rng(4242), list = [];
    for (let i = 0; i < (P ? 64 : 84); i++) {
      const z = .2 + r() * .8;
      list.push({ x: r() * W, y: r() * (H + 240), z, size: 18 + z * 40, v: 10 + z * 30, a: .03 + z * .06, k: i, rate: 1.4 + r() * 3 });
    }
    return list;
  })();
  const impulses = [];
  const impulse = (t0, x, y, amp = 150, glow = 1) => impulses.push({ t0, x, y, amp, glow });
  // Le champ de chiffres file très vite pendant l'accroche puis reprend sa dérive : la position est l'intégrale de la
  // vitesse (jamais de saut).
  const bgTime = t => t + 5 * Math.min(t, 1.6) + 3 * clamp(t - 1.6, 0, .4) * (1 - clamp(t - 1.6, 0, .4) / .8) + 18 * clamp(t - 31.5, 0, .5) ** 2;
  function drawBg(t) {
    const c = bgc, bt = bgTime(t);
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
      let x = f.x, y = (((f.y - f.v * bt) % span) + span) % span - 120, boost = 0;
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
      c.fillStyle = rgba(mix([255, 255, 255], tint, .35 + clamp(boost) * .4), Math.min(.5, f.a * (1 + boost * 3)) * (1 - view.dark * .8));
      c.fillText(String(Math.floor(hash(f.k, Math.floor(t / f.rate + f.k * .37)) * 10)), x, y);
    }
    const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .35, W / 2, H / 2, Math.hypot(W, H) * .62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${(.5 + view.dark * .45).toFixed(3)})`);
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }

  // ------------------------------------------------------------------ effets : confettis, ondes, flashs, volets
  const CONF = {
    rare: { count: 26, speed: 5, colors: ['#60a5fa', '#bfdbfe', '#3b82f6', '#ffffff'], sparks: true },
    epic: { count: 60, speed: 7, colors: ['#a855f7', '#d8b4fe', '#7c3aed', '#f0abfc'] },
    mythic: { count: 200, speed: 11, colors: ['#ec4899', '#a855f7', '#22d3ee', '#f43f5e', '#fde047'] },
    gold: { count: 110, speed: 8, colors: ['#fde68a', '#f59e0b', '#fbbf24', '#ffffff'] },
    infinite: { count: 300, speed: 13, colors: ['#ec4899', '#a855f7', '#3b82f6', '#10b981', '#eab308', '#f97316', '#ffffff'] },
  };
  const TIER_RING = { uncommon: '#10b981', rare: '#3b82f6', epic: '#a855f7', anomaly: '#f97316', mythic: '#ec4899', celestial: '#22d3ee', divine: '#fde047', godlike: '#fb7185', infinite: '#ffffff' };
  const FX = { bursts: [], rings: [], flashes: [], wipes: [], streaks: [] };
  function burst(t0, x, y, conf, seed, scale = 2.8) {
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
  const ring = (t0, x, y, w, h, color, o = {}) => FX.rings.push({ t0, x, y, w, h, color, dur: 1, from: .9, grow: 2.6, radius: 45, width: 8, alpha: 1, ...o });
  const flash = (t0, dur, kind, alpha, x = W / 2, y = H * .45) => FX.flashes.push({ t0, dur, kind, alpha, x, y });
  const cues = [];
  const cue = (t, type, o = {}) => cues.push({ t: Math.round(t * 1000) / 1000, type, ...o });
  const ticks = (from, to, o = {}) => { for (let t = from; t < to - .02; t += .055) cue(t, 'tick', o); };
  const wipe = (tc, colors, dur = .5) => { FX.wipes.push({ tc, colors, dur }); cue(tc - dur / 2 + .06, 'wipe', { dur: dur - .1 }); };
  const streak = (t0, x, y, c, o = {}) => FX.streaks.push({ t0, x, y, c, dur: .75, len: W * 1.25, thick: 30, ...o });

  const DRAG = -Math.log(.985) * 60, GRAV = .22 * 3600;
  const FLASH_STOPS = {
    gold: [[253, 230, 138, .5], [245, 158, 11, .3], [251, 146, 60, .1]],
    mythic: [[236, 72, 153, .5], [168, 85, 247, .3], [34, 211, 238, .12]],
    divine: [[254, 249, 195, .55], [253, 224, 71, .3], [245, 158, 11, .1]],
    infinite: [[236, 72, 153, .3], [168, 85, 247, .36], [34, 211, 238, .16]],
    ocean: [[165, 243, 252, .4], [14, 116, 144, .25], [8, 47, 73, .1]],
  };
  function drawFx(t, out = t) {
    const c = fxc, cam = view.cam;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, H);
    c.setTransform(cam.z, 0, 0, cam.z, cam.x, cam.y);
    for (const s of FX.streaks) {
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
      else if (f.kind === 'black') c.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
      else {
        const stops = FLASH_STOPS[f.kind];
        const g = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.hypot(W, H) * .62);
        g.addColorStop(0, rgba(stops[0], stops[0][3] * a * 2));
        g.addColorStop(.4, rgba(stops[1], stops[1][3] * a * 2));
        g.addColorStop(.7, rgba(stops[2], stops[2][3] * a * 2));
        g.addColorStop(1, rgba(stops[2], 0));
        c.fillStyle = g;
      }
      c.fillRect(0, 0, W, H);
    }
    for (const j of JOINS) {
      const p = (out - j) / .16;
      if (p >= 0 && p < 1) { c.fillStyle = `rgba(255,255,255,${(.5 * (1 - p) * (1 - p)).toFixed(3)})`; c.fillRect(0, 0, W, H); }
    }
    for (const w of FX.wipes) {
      const u = (t - (w.tc - w.dur / 2)) / w.dur;
      if (u <= 0 || u >= 1) continue;
      const WW = P ? H : W, HH = P ? W : H, sk = HH * .32, len = WW + sk + WW * .5;
      const xl = -sk + E.inOutCubic(u) * (WW + len + sk), xt = xl - len;
      c.save();
      if (P) { c.translate(0, H); c.rotate(-Math.PI / 2); }
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

  // ------------------------------------------------------------------ textes
  // Titre : chaque mot monte derrière un cache. "*mot*" = mot accentué (dégradé de la marque), "|" = retour à la ligne.
  // kick : petite étiquette au-dessus (« NEW »), qui s'ouvre en largeur.
  function claim(parent, text, cls = '', kick = '') {
    text = text.replace(/\*([^*]+)\*/g, (m, x) => x.trim().split(/\s+/).map(w => `*${w}*`).join(' '));
    const box = el('div', `claim ${cls}`, `${kick ? `<div class="kick"><span class="kick-in">${kick}</span></div>` : ''}${text.split('|').map(line => `<div class="cl">${line.trim().split(/\s+/).map(w => {
      const acc = /^\*.*\*$/.test(w);
      return `<span class="w"><span class="wi${acc ? ' acc' : ''}">${esc(acc ? w.slice(1, -1) : w)}</span></span>`;
    }).join(' ')}</div>`).join('')}`, parent);
    const words = Array.from(box.querySelectorAll('.wi')), kk = box.querySelector('.kick-in');
    return {
      el: box,
      at(t, tin, tout = 1e9, stagger = .05) {
        const on = t >= tin - .01 && t < tout + .5;
        vis(box, on);
        if (!on) return;
        words.forEach((w, i) => {
          const a = E.outExpo(prog(t, tin + i * stagger, .55)), b = E.inCubic(prog(t, tout + i * stagger * .4, .26));
          w.style.transform = `translateY(${((1 - a) * 110 - b * 110).toFixed(2)}%)`;
        });
        if (kk) {
          const a = E.outExpo(prog(t, tin - .05, .45)), b = E.inCubic(prog(t, tout, .2));
          kk.style.clipPath = `inset(0 ${((1 - a) * 50 + b * 50).toFixed(2)}% 0 ${((1 - a) * 50 + b * 50).toFixed(2)}%)`;
        }
      },
    };
  }
  function fade(parent, cls, html) {
    const box = el('div', cls, html, parent);
    return {
      el: box,
      at(t, tin, tout = 1e9, dy = 18) {
        const a = E.outCubic(prog(t, tin, .4)), b = E.inCubic(prog(t, tout, .22));
        fadeTo(box, a * (1 - b));
        box.style.transform = `translateY(${((1 - a) * dy - b * dy * .6).toFixed(2)}px)`;
      },
    };
  }
  const put = (item, top, size, left) => {
    item.el.style.top = `${top}px`;
    if (size) item.el.style.fontSize = `${size}px`;
    if (left != null) { item.el.style.left = `${left}px`; item.el.style.right = 'auto'; item.el.classList.add('left'); }
    return item;
  };

  // ------------------------------------------------------------------ scènes et transitions
  // Panoramique filé entre deux scènes : la scène qui part accélère hors du cadre, la suivante arrive du côté opposé et
  // se pose (outExpo). Les deux vont dans le même sens, comme une seule caméra qui pivote ; le rendu --pro ajoute le
  // vrai flou de mouvement. dir = [dx, dy] : [1, 0] = la caméra part vers la droite (le décor file vers la gauche).
  const scenes = [];
  function scene(id, start, end, build, o = {}) {
    const root = el('div', 'scene', '', scenesEl);
    root.id = `sc-${id}`;
    scenes.push({ id, start, end, root, update: build(root), inDir: o.inDir, outDir: o.outDir });
  }
  const WHIP_OUT = .2, WHIP_IN = .32;
  function whipShift(s, t) {
    let dx = 0, dy = 0;
    if (s.inDir) { const k = .6 * (1 - E.outExpo(prog(t, s.start, WHIP_IN))); dx += s.inDir[0] * k * W; dy += s.inDir[1] * k * H; }
    if (s.outDir) { const p = prog(t, s.end - WHIP_OUT, WHIP_OUT), k = .65 * (p * p * p * p) - .012 * Math.sin(Math.PI * Math.min(1, p * 2.2)); dx -= s.outDir[0] * k * W; dy -= s.outDir[1] * k * H; }
    return [dx, dy];
  }
  const whip = (tc, dir = [1, 0]) => { cue(tc - .16, 'whip', { pan: dir[0] }); cue(tc, 'hit', { soft: 1 }); };

  const C = { indigo: hex('#6366f1'), pink: hex('#ec4899'), purple: hex('#a855f7'), cyan: hex('#22d3ee'), orange: hex('#f97316'), gold: hex('#f5b301'), violet: hex('#8b5cf6'), teal: hex('#14b8a6'), green: hex('#22c55e'), red: hex('#ef4444'), blue: hex('#3b82f6') };

  // ------------------------------------------------------------------ séquences des skins (js/skinfx.js), pas à pas
  // Les vraies scènes du jeu, avancées à la main par pas fixes avec un hasard à graine : la même image pour le même
  // instant, quel que soit l'ordre dans lequel le film est rendu. Les calques sont dessinés en 2× (devicePixelRatio
  // forcé) : les cartes sont agrandies à l'écran.
  const STEP = 1 / 120;
  function skinSim(stageEl, card, id, seed, events) {
    const sim = { fx: null, t: 0, ev: 0, seed: 0 };
    const prng = () => { sim.seed = (sim.seed + 0x6D2B79F5) | 0; let x = Math.imul(sim.seed ^ (sim.seed >>> 15), 1 | sim.seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const withSeed = fn => { const real = Math.random; Math.random = prng; try { fn(); } finally { Math.random = real; } };
    const slots = Array.from(card.querySelectorAll('.slot'));
    sim.at = target => {
      if (!window.SkinFX) return;
      if (!sim.fx || target < sim.t - 1e-6) {
        if (sim.fx) sim.fx.destroy();
        sim.seed = seed; sim.t = 0; sim.ev = 0;
        withSeed(() => { sim.fx = window.SkinFX.mount(stageEl, card, id, { manual: true }); });
        if (!sim.fx) return;
      }
      if (!sim.fx) return;
      withSeed(() => {
        while (sim.t + STEP <= target + 1e-9) {
          while (sim.ev < events.length && events[sim.ev][0] <= sim.t) events[sim.ev++][1](sim.fx, slots);
          sim.fx.step(STEP);
          sim.t += STEP;
        }
      });
    };
    return sim;
  }
  // Un tirage avec un skin : les chiffres se posent aux instants `locks` (absolus), révélation à `rev`.
  function rollCard({ id, n, locks, rev, pre = 1.6, seed = 1 }) {
    const a = analysis(n), str = a.str.padStart(6, '0');
    const wrap = el('div', 'card-stage', `<div class="num-card lg${id !== 'classic' ? ` skin-${id}` : ''}">${slotsHTML(str)}</div>`);
    const card = wrap.querySelector('.num-card'), slots = Array.from(card.querySelectorAll('.slot'));
    const t0 = locks[0] - pre; // instant du film où la simulation commence (avant que la carte soit à l'écran)
    const events = locks.map((at, k) => [at - t0, (f, s) => f.lock(s[k], { last: k === 5 })])
      .concat([[rev - .6 - t0, f => f.build(600)], [rev - t0, f => f.reveal(a.tier)]]).sort((x, y) => x[0] - y[0]);
    let sim = null;
    return {
      a, str, wrap, card, slots, rev, locks,
      update(t, seedK = 0) {
        if (!sim) sim = id !== 'classic' && window.SkinFX && window.SkinFX.has(id) ? skinSim(wrap, card, id, 1234 + seed * 777, events) : { at() {} };
        let revealed = 0;
        for (let i = 0; i < 6; i++) if (t >= locks[i]) revealed = i + 1;
        slots.forEach((s, i) => {
          const locked = i < revealed;
          setText(s, locked ? str[i] : String(Math.floor(hash(seed * 31 + i + seedK, Math.floor(t / .055), 5) * 10)));
          setAnim(s, 'spinning', !locked, 0);
          setAnim(s, 'revealed', locked, locks[i]);
        });
        const on = t >= rev;
        setCls(card, 'neutral', !on);
        setAnim(card, 'charging', !on, 0, 'charge');
        if (on) card.dataset.tier = a.tier; else delete card.dataset.tier;
        sim.at(Math.max(0, t - t0));
      },
    };
  }

  function buildScenes() {
    // ================================================================ 0. l'accroche : 1 000 000 de nombres, 10 Infinite
    scene('hook', T.HOOK, T.ROLL, root => {
      const MIL = '1,000,000';
      root.innerHTML = `
        <div class="pin" id="hk-a"><div class="ctr hk-a"><div class="hk-num">${MIL.split('').map(ch => `<span class="hk-d${ch === ',' ? ' cm' : ''}">${ch}</span>`).join('')}</div><div class="hk-word">numbers</div></div></div>
        <div class="pin" id="hk-b"><div class="ctr hk-b"><div class="hk-only">only <b>${INFINITE_COUNT}</b> are</div><div class="hk-inf"><span class="hk-inf-t">∞ infinite</span><span class="hk-shine">∞ infinite</span></div></div></div>`;
      const pA = root.querySelector('#hk-a'), pB = root.querySelector('#hk-b'), digs = Array.from(root.querySelectorAll('.hk-d')), word = root.querySelector('.hk-word');
      const only = root.querySelector('.hk-only'), inf = root.querySelector('.hk-inf'), shine = root.querySelector('.hk-shine');
      digs.forEach(d => { d.style.width = `${d.getBoundingClientRect().width}px`; });
      const CY = P ? H * .47 : H * .5, S = P ? .52 : .85;
      const T_B = 1.0;
      flash(T_B, .25, 'white', .7);
      flash(T_B, .9, 'infinite', .5, W / 2, CY);
      ring(T_B, W / 2, CY, P ? 900 : 1300, P ? 260 : 330, '#ffffff', { grow: 1.8, width: 6, radius: 160 });
      impulse(T_B, W / 2, CY, 260, 1);
      impulse(0, W / 2, CY, 160, .6);
      streak(T_B, W / 2, CY, C.purple);
      cue(0, 'hit');
      cue(T_B - .5, 'riser', { dur: .45 });
      cue(T_B, 'impact', { kind: 'infinite' });
      digs.forEach((d, i) => { if (i > 0 && !d.classList.contains('cm')) cue(.05 * i, 'lock', { i: Math.min(4, i >> 1), soft: 1 }); });
      return t => {
        // A : « 1,000,000 » se pose chiffre par chiffre pendant que la caméra avance, puis éclate vers l'avant.
        const aOut = E.inExpo(prog(t, T_B - .12, .12));
        fadeTo(pA, 1 - aOut);
        place(pA, W / 2, CY, S * lerp(1, 1.09, prog(t, 0, 1)) * (1 + aOut * .5));
        digs.forEach((d, i) => {
          if (d.classList.contains('cm')) return;
          const at = .05 * i, locked = t >= at, e = E.snap(prog(t, at, .3));
          setText(d, locked ? MIL[i] : String(Math.floor(hash(i, Math.floor(t / .045)) * 10)));
          d.style.transform = locked ? `translateY(${((1 - e) * -.18).toFixed(3)}em)` : `translateY(${(.06 * Math.sin(t * 70 + i)).toFixed(3)}em)`;
          d.style.opacity = locked ? '1' : '.45';
        });
        word.style.letterSpacing = `${lerp(.6, .32, E.outExpo(prog(t, .2, .7))).toFixed(3)}em`;
        fadeTo(word, E.outCubic(prog(t, .2, .3)));
        // B : « only 10 are ∞ INFINITE » claque sur le temps fort.
        const on = t >= T_B, e = E.outBack(prog(t, T_B, .38), 2.2);
        fadeTo(pB, on ? clamp(prog(t, T_B, .05)) : 0);
        place(pB, W / 2, CY, S * lerp(1.7, 1, e) * (1 + .03 * prog(t, T_B, 1)));
        only.style.transform = `translateY(${((1 - E.outExpo(prog(t, T_B + .08, .4))) * 40).toFixed(1)}px)`;
        only.style.opacity = E.outCubic(prog(t, T_B + .08, .25)).toFixed(3);
        inf.style.letterSpacing = `${lerp(.3, .02, E.outExpo(prog(t, T_B, .5))).toFixed(3)}em`;
        shine.style.backgroundPosition = `${lerp(100, 0, E.inOutCubic(prog(t, T_B + .35, .6))).toFixed(2)}% 0`;
        view.dark = .3;
        light(W / 2, CY, P ? 1100 : 1300, t < T_B ? C.indigo : mix(C.pink, C.purple, .5), t < T_B ? .14 : .3 * Math.exp(-1.5 * (t - T_B)) + .12);
      };
    }, { outDir: [1, 0] });

    // ================================================================ 1. un tirage : chiffres, Mythic, badges
    scene('roll', T.ROLL, T.SKINS, root => {
      const N = 808808, a = analysis(N), str = a.str;
      const HC = P ? { x: 540, y: 820 } : { x: 960, y: 540 };
      const HB = P ? { x: 540, y: 600, s: .8 } : { x: 560, y: 390, s: .78 };
      const LOCK = [2.75, 3, 3.25, 3.5, 3.75, 4], REV = 4, CLICK = 2.2, SPIN = 2.3;
      const SHOWN = 3, top = a.groups.slice(0, SHOWN), tin = [4.75, 4.5, 4.25];
      const base = a.total - top.reduce((x, g) => x + g.badge.score, 0);
      root.innerHTML = `
        <div class="cam">
          <div class="pin" id="r-group">
            <div class="pin hero-card"><div class="ctr"><div class="card-stage"><div class="rays"></div><div class="num-card lg neutral">${slotsHTML('??????')}</div></div></div></div>
            <div class="pin" id="r-stamp"><div class="ctr stamp">MYTHIC</div></div>
            <div class="pin" id="r-meta" data-tier="mythic"><div class="ctr"><div class="result-meta big">${tierPill('mythic')}<span class="dot">•</span><span class="top" style="color:#eab308">Top ${(100 - a.percentile).toFixed(2)}%</span></div></div></div>
            <div class="pin" id="r-xp" data-tier="mythic"><div class="ctr"><div class="ep-big pending">??? XP</div></div></div>
            <div class="pin" id="r-btn"><div class="ctr"><button class="btn-roll">Generate</button></div></div>
          </div>
          <div class="pin" id="r-badges"><div class="bstack">${top.map(g => `<div class="bslot">${badgeHTML(g, N)}</div>`).join('')}</div></div>
        </div>`;
      const $ = s => root.querySelector(s);
      const cam = $('.cam'), pGroup = $('#r-group'), pCard = $('.hero-card'), cstage = $('.card-stage'), rays = $('.rays'), card = $('.num-card');
      const slots = Array.from(card.querySelectorAll('.slot'));
      const pStamp = $('#r-stamp'), stamp = $('.stamp'), pMeta = $('#r-meta'), pXP = $('#r-xp'), xp = $('.ep-big'), pBtn = $('#r-btn'), btn = $('.btn-roll');
      const pBadges = $('#r-badges'), bslots = Array.from(root.querySelectorAll('.bslot'));
      const K = (P ? 900 : 1000) / card.offsetWidth, ch = card.offsetHeight * K, cw = card.offsetWidth * K;
      const BX = P ? 540 : 1400, BY = P ? 950 : 200, SB = P ? 1.78 : 1.75, GAP = 13;
      const bh = bslots.map(s => s.offsetHeight);
      const tiles = bslots.map(s => Array.from(s.querySelectorAll('.dt.hl')).map(e => ({ e, d: Number(e.dataset.delay) / 1000 })));
      const bcards = bslots.map(s => s.querySelector('.badge-card'));
      const cA = put(claim(root, P ? 'Roll a|*number*' : 'Roll a *number*'), P ? 270 : 70, P ? 132 : 112);
      const sA = put(fade(root, 'sub', 'from <b>0</b> to <b>1,000,000</b>'), P ? 560 : 196);
      const cB = put(claim(root, P ? '240+ *badges*' : '240+|*badges*'), P ? 1650 : 790, P ? 112 : 92);
      const sB = put(fade(root, 'sub', 'score every roll'), P ? 1785 : 1000, 34);
      if (!P) { cB.el.style.right = sB.el.style.right = 'auto'; cB.el.style.width = sB.el.style.width = `${HB.x * 2}px`;  }

      flash(REV, .22, 'white', .55);
      flash(REV, 1, 'mythic', .5, HC.x, HC.y);
      ring(REV, HC.x, HC.y, cw, ch, TIER_RING.mythic);
      ring(REV + .14, HC.x, HC.y, cw, ch, TIER_RING.mythic);
      burst(REV + .02, HC.x, HC.y, CONF.mythic, 7);
      impulse(REV, HC.x, HC.y, 240, 1);
      streak(REV, HC.x, HC.y, C.pink);
      for (let i = 0; i < 5; i++) impulse(LOCK[i], HC.x, HC.y, 26, .25);
      cue(CLICK, 'click');
      ticks(SPIN, REV - .6);
      for (let j = 1; j <= 6; j++) cue(REV - .6 + .6 * (1 - Math.sqrt(1 - j / 7)), 'tick', { last: j / 6 });
      LOCK.slice(0, 5).forEach((t, i) => cue(t, 'lock', { i }));
      cue(LOCK[4] + .06, 'riser', { dur: REV - LOCK[4] - .1 });
      cue(REV, 'impact', { kind: 'mythic' });
      cue(4.15, 'whoosh', { dur: .35, pan: P ? 0 : -.4 });
      tin.forEach((t, j) => cue(t, 'badge', { i: SHOWN - 1 - j, of: SHOWN }));

      return t => {
        const peak = t >= REV, spinning = t >= SPIN;
        let revealed = 0;
        for (let i = 0; i < 6; i++) if (t >= LOCK[i]) revealed = i + 1;
        // caméra : lente poussée pendant le tirage, recul sec à la révélation, secousse
        let z = (1 + .06 * E.inOutCubic(prog(t, SPIN, REV - SPIN)) * (1 - E.outBack(prog(t, REV + .05, .5), 2))) * (1 + .05 * prog(t, 4.6, 1.4));
        for (let i = 0; i < 5; i++) z *= 1 + .022 * kick(t, LOCK[i], 12, 22);
        const sh = peak ? 20 * Math.exp(-6 * (t - REV)) : 0;
        view.cam = { z, x: HC.x - HC.x * z + sh * Math.sin((t - REV) * 91), y: HC.y - HC.y * z + sh * Math.cos((t - REV) * 77) };
        cam.style.transform = `translate(${view.cam.x.toFixed(2)}px,${view.cam.y.toFixed(2)}px) scale(${z.toFixed(4)})`;
        view.dark = .25 * prog(t, LOCK[4], .2) * (1 - prog(t, REV, .2));

        slots.forEach((s, i) => {
          const locked = i < revealed;
          setText(s, locked ? str[i] : spinning ? String(Math.floor(hash(i, Math.floor(t / .055), 5) * 10)) : '?');
          setAnim(s, 'spinning', spinning && !locked, 0);
          setAnim(s, 'revealed', locked, LOCK[i]);
        });
        setCls(card, 'neutral', !peak);
        setAnim(card, 'charging', spinning && !peak, SPIN, 'charge');
        if (peak) { card.dataset.tier = 'mythic'; pCard.dataset.tier = 'mythic'; } else { delete card.dataset.tier; delete pCard.dataset.tier; }
        setAnim(card, 'shake', peak && t < REV + .5, REV, 'shake');
        const lastLock = revealed ? LOCK[revealed - 1] : -9;
        setAnim(cstage, 'thump', t - lastLock < .24, lastLock, 'thump');
        setCls(cstage, 'lit', peak);
        rays.style.opacity = (peak ? .5 * E.outCubic(prog(t, REV, .6)) : 0).toFixed(3);
        place(pCard, 0, 0, K * lerp(1.04, 1, E.outCubic(prog(t, 2, .6))) * (1 + .04 * kick(t, SPIN, 9, 16)));

        const split = E.inOutCubic(prog(t, 4.15, .5));
        place(pGroup, lerp(HC.x, HB.x, split), lerp(HC.y, HB.y, split), lerp(1, HB.s, split));
        const st = prog(t, REV + .08, .4);
        fadeTo(pStamp, clamp(st * 4));
        place(pStamp, 0, -ch / 2 - 120, lerp(2.3, 1, E.outExpo(st)));
        stamp.style.letterSpacing = `${lerp(.42, .05, E.outExpo(st)).toFixed(3)}em`;
        const mp = prog(t, REV + .3, .35);
        fadeTo(pMeta, clamp(mp * 3));
        place(pMeta, 0, ch / 2 + 70, 3.2 * lerp(.7, 1, E.outBack(mp)));
        const xin = prog(t, REV + .45, .35);
        let xv = 0, xk = 0;
        top.forEach((g, j) => { xv += (g.badge.score + (j === SHOWN - 1 ? base : 0)) * E.outCubic(prog(t, tin[j], .42)); xk += kick(t, tin[j], 9, 0); });
        const counting = t >= tin[SHOWN - 1];
        setText(xp, counting ? `${fmt(xv)} XP` : '??? XP');
        setCls(xp, 'pending', !counting);
        fadeTo(pXP, clamp(xin * 3));
        place(pXP, 0, ch / 2 + 190, 3.4 * (1 + .07 * xk));

        place(pBadges, BX, BY, SB);
        bslots.forEach((s, j) => {
          const on = t >= tin[j];
          show(s, on);
          if (!on) return;
          let y = 0;
          for (let m = 0; m < j; m++) y += (bh[m] + GAP) * E.outCubic(prog(t, tin[m], .32));
          const e = E.outExpo(prog(t, tin[j], .4));
          s.style.transform = `translate(${((1 - e) * (P ? 0 : 80)).toFixed(2)}px,${(y + (P ? (1 - e) * 40 : 0)).toFixed(2)}px)`;
          s.style.opacity = clamp(e * 2).toFixed(3);
          setAnim(bcards[j], 'reveal', true, tin[j]);
          tiles[j].forEach(x => { const t0 = tin[j] + .3 + x.d * .6; setAnim(x.e, 'lit', t >= t0, t0); });
        });

        const bOut = E.inCubic(prog(t, SPIN, .3)), press = Math.sin(Math.PI * prog(t, CLICK - .04, .2));
        fadeTo(pBtn, 1 - bOut);
        place(pBtn, 0, ch / 2 + 150 + bOut * 140, 2.3 * (1 - .09 * press) * (1 - .15 * bOut));
        btn.style.filter = press > .01 ? `brightness(${(1 + press).toFixed(2)})` : '';

        const lc = mix(C.indigo, C.pink, E.outCubic(prog(t, REV, .3)));
        light(HC.x, HC.y, (P ? 1150 : 1250) * z, lc, .1 + .02 * revealed + (peak ? .2 * Math.exp(-1.4 * (t - REV)) : 0));
        cA.at(t, 2.08, 3.85);
        sA.at(t, 2.25, 3.8);
        cB.at(t, 4.55, 5.88);
        sB.at(t, 4.8, 5.85);
      };
    }, { inDir: [1, 0], outDir: [1, 0] });

    // ================================================================ 2. skins légendaires : un plan par skin, filés
    const SHOTS = [
      { id: 'divine', n: 314159, s: T.SKINS, rev: 7, tag: 'Legendary' },
      { id: 'comicbook', n: 500000, s: 7.5, rev: 8, tag: 'Legendary' },
      { id: 'milkyway', n: 271828, s: 8.5, rev: 9, tag: 'Legendary' },
      { id: 'christmas', n: 121212, s: 9.5, rev: 10, tag: 'Limited' },
      { id: 'infinity', n: 999999, s: 10.5, rev: 11, tag: 'Legendary' },
    ];
    scene('skins', T.SKINS, T.FUN, root => {
      const CY = P ? 980 : 590, MAXW = P ? 860 : 980;
      root.innerHTML = '<div class="sk-strip"></div>';
      const strip = root.querySelector('.sk-strip');
      const shots = SHOTS.map((sh, i) => {
        // Les chiffres tombent avant l'arrivée du plan ; le dernier sur le temps qui suit, la révélation sur le temps fort.
        const span = sh.rev - sh.s >= 1 ? [.875, .75, .625, .5, .375, .25] : [1.5, 1.25, 1, .75, .5, .25];
        const rc = rollCard({ id: sh.id, n: sh.n, locks: span.map(d => sh.rev - d), rev: sh.rev, seed: i + 3 });
        const pin = el('div', 'pin sk-shot', '', strip), inner = el('div', 'sk-in', '', pin);
        inner.appendChild(rc.wrap);
        const skin = Shop.byId.get(sh.id);
        const lt = el('div', 'lt', `<span class="lt-em">${skin.emoji}</span><span class="lt-nm">${esc(skin.name)}</span><span class="lt-tag${sh.tag === 'Limited' ? ' lim' : ''}">${sh.tag}</span>`, pin);
        return { ...sh, rc, pin, inner, lt, i, end: SHOTS[i + 1] ? SHOTS[i + 1].s : T.FUN };
      });
      shots.forEach(s => { s.K = Math.min(MAXW / s.rc.card.offsetWidth, (P ? 330 : 300) / s.rc.card.offsetHeight); s.ch = s.rc.card.offsetHeight * s.K; });
      const title = put(claim(root, P ? 'Legendary|*skins*' : 'New legendary *skins*', '', 'new'), P ? 250 : 64, P ? 120 : 96);
      shots.forEach((s, i) => {
        if (i) whip(s.s);
        s.rc.locks.forEach((at, k) => { if (at >= s.s) cue(at, 'lock', { i: k, soft: 1 }); });
        ticks(Math.max(s.s, s.rev - 1.2), s.rc.locks[5], { soft: 1 });
        cue(s.rev, 'reveal');
        cue(s.rev, 'impact', { kind: s.rc.a.tier === 'divine' ? 'gold' : 'epic', soft: 1 });
        impulse(s.rev, W / 2, CY, 160, .8);
        flash(s.rev, .5, s.id === 'divine' ? 'divine' : 'mythic', .3, W / 2, CY);
      });
      const SKL = { divine: hex('#fde047'), comicbook: hex('#ef4444'), milkyway: hex('#8b5cf6'), christmas: hex('#16a34a'), infinity: hex('#a855f7') };
      return t => {
        // caméra : une position par plan, filé très rapide entre deux plans (inOutQuint sur 0,28 s)
        let camPos = 0;
        for (let i = 1; i < shots.length; i++) camPos += E.inOutQuint(prog(t, shots[i].s - .12, .28));
        let lc = SKL[shots[0].id], la = .2;
        shots.forEach((s, i) => {
          const dx = (i - camPos) * W * 1.05, onScreen = Math.abs(dx) < W * 1.1;
          show(s.pin, onScreen);
          if (!onScreen) return;
          s.rc.update(t, i * 7);
          const push = 1 + .07 * prog(t, s.s - .2, s.end - s.s + .3), hit = 1 + .05 * kick(t, s.rev, 9, 15);
          place(s.pin, W / 2 + dx, CY, 1);
          place(s.inner, 0, 0, s.K * push * hit);
          const le = E.outExpo(prog(t, s.s + .05, .45));
          s.lt.style.opacity = le.toFixed(3);
          s.lt.style.transform = `translate(-50%, ${(s.ch / 2 * push + (P ? 120 : 90) + (1 - le) * 40).toFixed(1)}px)`;
          if (Math.abs(dx) < W * .5) { lc = SKL[s.id]; la = .2 + .25 * (t >= s.rev ? Math.exp(-2 * (t - s.rev)) : 0); }
        });
        light(W / 2, CY, P ? 1200 : 1300, lc, la);
        title.at(t, T.SKINS + .08, 7.3);
      };
    }, { inDir: [1, 0], outDir: [1, 0] });

    // ================================================================ 2 bis. skins pour s'amuser : Blackjack, Bowling, Dynamite
    scene('fun', T.FUN, T.WALL, root => {
      const FUN = [{ id: 'blackjack', n: 212121, rev: 12.25 }, { id: 'bowling', n: 101010, rev: 12.75 }, { id: 'dynamite', n: 100000, rev: 13.25 }];
      const pos = P ? [[540, 700], [540, 1130], [540, 1560]] : [[350, 620], [960, 620], [1570, 620]];
      const cards = FUN.map((f, i) => {
        const rc = rollCard({ id: f.id, n: f.n, locks: [.75, .625, .5, .375, .25, .125].map(d => f.rev - d), rev: f.rev, seed: 20 + i });
        const pin = el('div', 'pin fun-shot', '', root), inner = el('div', 'sk-in', '', pin);
        inner.appendChild(rc.wrap);
        const skin = Shop.byId.get(f.id);
        const lt = el('div', 'lt sm', `<span class="lt-em">${skin.emoji}</span><span class="lt-nm">${esc(skin.name)}</span>`, pin);
        return { ...f, rc, pin, inner, lt, i, x: pos[i][0], y: pos[i][1] };
      });
      cards.forEach(c => { c.K = Math.min((P ? 760 : 560) / c.rc.card.offsetWidth, (P ? 240 : 230) / c.rc.card.offsetHeight); c.ch = c.rc.card.offsetHeight * c.K; });
      const title = put(claim(root, `${Shop.SKINS.length} *skins*`, ''), P ? 250 : 80, P ? 150 : 120);
      const sub = put(fade(root, 'sub', '<span class="tchip">earned by playing · <b>no real money</b></span>'), P ? 1780 : 900, P ? 34 : 38);
      cards.forEach((c, i) => {
        cue(Math.max(T.FUN, T.FUN - .15 + i * .125), 'pop');
        cue(c.rev, 'reveal', { small: 1 });
        ticks(T.FUN + .2, c.rc.locks[5], { soft: 1 });
        c.rc.locks.forEach((at, k) => cue(at, 'lock', { i: k, soft: 1, grid: 1 }));
        impulse(c.rev, c.x, c.y, 90, .5);
      });
      return t => {
        cards.forEach((c, i) => {
          c.rc.update(t, i * 11);
          const t0 = T.FUN - .15 + i * .125, e = E.outBack(prog(t, t0, .4), 1.6), drop = (1 - E.outExpo(prog(t, t0, .45))) * 260;
          const hit = 1 + .06 * kick(t, c.rev, 9, 15), drift = 1 + .04 * prog(t, T.FUN, 2.5);
          place(c.pin, c.x, c.y - drop, 1);
          place(c.inner, 0, 0, c.K * lerp(.75, 1, e) * hit * drift);
          c.pin.style.opacity = clamp(prog(t, t0, .12)).toFixed(3);
          const le = E.outExpo(prog(t, c.rev + .05, .4));
          c.lt.style.opacity = le.toFixed(3);
          c.lt.style.transform = `translate(-50%, ${(c.ch / 2 + (P ? 70 : 70) + (1 - le) * 24).toFixed(1)}px)`;
        });
        light(W / 2, H / 2, P ? 1200 : 1400, mix(C.green, C.orange, prog(t, 12.5, 1)), .17);
        title.at(t, T.FUN + .1, 13.7);
        sub.at(t, 12.4, 13.75);
      };
    }, { inDir: [1, 0], outDir: [0, 1] });

    // ================================================================ 3. fonds d'écran animés : Open Ocean → Deep Dive → Summit
    // Les vrais fonds du site (#wallpaper + calques <i>, tout en CSS). Un élément transformé devient le repère des
    // descendants en position fixe : chaque fond tient dans sa boîte, que la caméra déplace.
    scene('wall', T.WALL, T.CHAT, root => {
      root.innerHTML = `
        <div class="wpbox" id="wb-ocean"><div id="wallpaper" class="wp wp-oceanic"><i class="wpo-whale"></i><i class="wpo-shark"></i><i class="wpo-glow"></i><i class="wpo-fizz"></i><i class="wpo-pod"></i></div></div>
        <div class="wpbox" id="wb-sub"><div id="wallpaper" class="wp wp-submarine"><i class="wpd-glow"></i><i class="wpd-sub"><b class="wpd-burst"></b></i></div></div>
        <div class="wpbox" id="wb-summit"><div id="wallpaper" class="wp wp-summit"><i class="wps-night"></i><i class="wps-stars"></i><i class="wps-moon"></i><i class="wps-clouds"></i></div></div>
        <div class="pin" id="wb-card"><div class="ctr"><div class="card-stage"><div class="num-card lg" data-tier="mythic">${slotsHTML('808808')}</div></div></div></div>`;
      const $ = s => root.querySelector(s);
      const bOcean = $('#wb-ocean'), bSub = $('#wb-sub'), bSum = $('#wb-summit');
      const wOcean = bOcean.firstElementChild, wSub = bSub.firstElementChild, wSum = bSum.firstElementChild;
      const whale = $('.wpo-whale'), shark = $('.wpo-shark'), sub = $('.wpd-sub'), pCard = $('#wb-card');
      whale.style.animation = 'wpo-bob 9s ease-in-out infinite alternate';
      shark.style.animation = 'wpo-bob 5s ease-in-out infinite alternate';
      sub.style.animation = 'none';
      const T_REACT = 14.6, T_SUBHIT = 16.25, T_SUM_REACT = 16.95;
      wOcean.dataset.react = 'mythic'; wOcean.__rate = 1.6; [...wOcean.children].forEach(c => { c.__t0 = { '*': T_REACT, 'wpo-bob': 0 }; c.__rate = 1.6; });
      wSum.dataset.react = 'mythic'; [...wSum.children].forEach(c => { c.__t0 = { '*': T_SUM_REACT, 'wps-clouds': 0 }; c.__rate = 3.6; });
      const burstEl = $('.wpd-burst'), glowEl = $('.wpd-glow');
      const ttl = put(claim(root, P ? 'Living|*wallpapers*' : 'Living *wallpapers*', '', 'new'), P ? 250 : 64, P ? 124 : 100);
      const lts = [['🌊', 'Open Ocean', 14.15, 15.4], ['🫧', 'Deep Dive', 15.75, 16.65], ['🏔️', 'Summit', 16.9, 17.85]].map(([em, nm, a, b]) => ({ a, b, el: el('div', 'lt wl', `<span class="lt-em">${em}</span><span class="lt-nm">${nm}</span>`, root) }));
      const react = put(fade(root, 'sub', '<span class="tchip">reacts to <b>your rolls</b></span>'), P ? 1380 : 770, P ? 38 : 38);
      cue(T.DIVE - .2, 'whoosh', { dur: .5, pan: 0 });
      cue(T_REACT, 'swell');
      cue(T_SUBHIT, 'boom');
      cue(T_SUBHIT + .05, 'bubbles');
      cue(T.SUMMIT, 'hit', { soft: 1 });
      cue(T_SUM_REACT, 'reveal');
      flash(T.SUMMIT, .3, 'white', .5);
      return t => {
        // Plongée : l'océan monte hors du cadre pendant que les abysses arrivent par le bas (même vitesse : une seule caméra).
        const dive = E.inOutQuint(prog(t, T.DIVE - .2, .5));
        const onSum = t >= T.SUMMIT;
        show(bOcean, !onSum && dive < 1);
        show(bSub, !onSum && dive > 0);
        show(bSum, onSum);
        const zO = 1.04 + .05 * prog(t, T.WALL, 1.6);
        bOcean.style.transform = `translateY(${(-dive * H).toFixed(1)}px) scale(${zO.toFixed(4)})`;
        bSub.style.transform = `translateY(${((1 - dive) * H).toFixed(1)}px) scale(${(1.02 + .04 * prog(t, T.DIVE, 1.3)).toFixed(4)})`;
        bSum.style.transform = `translateY(${(-30 * prog(t, T.SUMMIT, 1.25)).toFixed(1)}px) scale(${lerp(1.12, 1.04, E.outCubic(prog(t, T.SUMMIT, 1.25))).toFixed(4)})`;
        // la baleine et le requin traversent le cadre (ils mettent 95 s et 38 s sur le site : ici en quelques secondes)
        whale.style.translate = `${lerp(W * .62, -W * .38, prog(t, T.WALL - .3, 2.2)).toFixed(1)}px 0`;
        shark.style.translate = `${lerp(-W * .3, W * .9, prog(t, T.WALL, 1.6)).toFixed(1)}px 0`;
        // le sous-marin pique du nez puis file jusqu'au fond (Mythic) et lâche sa gerbe de bulles
        const down = E.inCubic(prog(t, 15.85, .4)), nose = E.outCubic(prog(t, 15.6, .3)) * (1 - E.outCubic(prog(t, T_SUBHIT, .3)));
        const subW = Math.min(W * .5, 460), bottom = H * .79 - subW * 114 / 520;
        sub.style.translate = `0 ${(lerp(H * .05, bottom, down) + 8 * Math.sin(t * 3)).toFixed(1)}px`;
        sub.style.rotate = `${(7 * nose).toFixed(2)}deg`;
        setCls(wSub, 'tr-hit', t >= T_SUBHIT);
        if (t >= T_SUBHIT) { wSub.dataset.react = 'mythic'; wSub.dataset.dive = '1'; burstEl.__t0 = { '*': T_SUBHIT }; glowEl.__t0 = { '*': T_SUBHIT }; burstEl.__rate = glowEl.__rate = 1.8; }
        else { delete wSub.dataset.react; delete wSub.dataset.dive; }
        // petite carte Mythic sur le sommet : c'est elle qui fait tomber la nuit
        const ce = popIn(t, T_SUM_REACT - .12, .35, 2);
        fadeTo(pCard, onSum ? clamp(ce * 2) * (1 - E.inCubic(prog(t, 17.7, .25))) : 0);
        place(pCard, W / 2, P ? H * .6 : H * .56, (P ? 2.2 : 1.9) * ce);
        lts.forEach(l => {
          const e = E.outExpo(prog(t, l.a, .4)), o = E.inCubic(prog(t, l.b - .15, .15));
          l.el.style.opacity = (e * (1 - o)).toFixed(3);
          l.el.style.transform = `translate(-50%, 0) translateY(${((1 - e) * 30).toFixed(1)}px)`;
        });
        ttl.at(t, T.WALL + .12, 15.2);
        react.at(t, 17.15, 17.8);
        view.dark = 0;
      };
    }, { inDir: [0, 1], outDir: [1, 0] });

    // ================================================================ 4. chat global, @mentions, photos de profil, alertes
    scene('chat', T.CHAT, T.CLAN, root => {
      const MSG = [
        ['Nova', 'just rolled a Godlike 424242 🔥', '', 'tycoon', 17.9],
        ['Rex', 'no way 😱 screenshot or it didn’t happen', '', '', 18.45],
        ['Mochi', 'gg <b class="gc-at">@Pixel</b> that roll was insane', 'gc-tome', '', 18.7],
        ['Pixel', 'thx!! clan war at 8? ⚔️', 'gc-mine', 'magnate', 18.95],
      ];
      root.innerHTML = `
        <div class="pin" id="c-panel"><div class="ctr tr-gc"><section class="gc-panel"><header class="gc-head"><h2 class="gc-title">💬 Global chat</h2><span class="gc-note">Be kind · no personal info</span></header>
          <div class="gc-list">${MSG.map(([n, txt, cls, ttl], i) => `<div class="gc-msg ${cls}"><div class="gc-meta">${avatar(n, 'av-xs')}<a class="player-link gc-name">${n}</a>${ttl ? titlePill(ttl) : ''}<time class="gc-time">20:0${i + 1}</time></div><p class="gc-text">${txt}</p></div>`).join('')}</div>
          <footer class="gc-foot"><form class="gc-form"><input class="input gc-input" placeholder="Write a message… (@name to mention)"><button class="btn-roll small gc-send" type="button">Send</button></form></footer></section></div></div>
        <div class="pin" id="c-toast"><div class="ctr"><div class="toast achv tr-toast">🌟 Nova rolled a Godlike 424242!</div></div></div>`;
      const pPanel = root.querySelector('#c-panel'), msgs = Array.from(root.querySelectorAll('.gc-msg')), pToast = root.querySelector('#c-toast');
      const at = root.querySelector('.gc-tome');
      const cl = put(claim(root, P ? 'Global|*chat*' : 'Global|*chat*', P ? '' : 'left', 'new'), P ? 190 : 250, P ? 116 : 140, P ? null : 120);
      const feats = [['@mentions', 18.7], ['profile pictures', 18.95], ['friend alerts', 19.25]].map(([txt, a], i) => ({ a, el: put(fade(root, `sub feat${P ? '' : ' left'}`, `<span class="tchip">✦ <b>${txt}</b></span>`), P ? 560 + i * 52 : 690 + i * 74, P ? 30 : 34, P ? null : 124) }));
      const S = P ? 2.6 : 2.45, PX = P ? 540 : 1300, PY = P ? 1250 : 560;
      msgs.forEach((m, i) => { if (MSG[i][4] >= T.CHAT) cue(MSG[i][4], 'chat', { i }); });
      cue(18.7, 'ping');
      cue(19.25, 'toast');
      return t => {
        place(pPanel, PX - (P ? 0 : 40) * prog(t, T.CHAT, 2), PY - 50 * prog(t, T.CHAT, 2), S * (1 + .06 * prog(t, T.CHAT, 2)));
        msgs.forEach((m, i) => {
          const a = prog(t, MSG[i][4], .3), k = E.outBack(a, 1.6);
          m.style.opacity = clamp(a * 4).toFixed(3);
          m.style.transform = `translateY(${((1 - k) * 26).toFixed(1)}px)`;
        });
        at.style.boxShadow = t >= 18.7 ? `inset ${(3 + 5 * Math.exp(-4 * (t - 18.7))).toFixed(1)}px 0 0 #f5b301` : '';
        const te = popIn(t, 19.25, .4, 1.7), tout = E.inCubic(prog(t, 19.85, .15));
        fadeTo(pToast, clamp(te * 3) * (1 - tout));
        place(pToast, P ? 540 : 1300, (P ? 1800 : 1000) + (1 - te) * 80, (P ? 2.5 : 2.3) * lerp(.8, 1, te));
        light(PX, PY, 1200, mix(C.indigo, C.gold, prog(t, 19.2, .4)), .18);
        cl.at(t, T.CHAT + .1, 19.88);
        feats.forEach(f => f.el.at(t, f.a, 19.85));
      };
    }, { inDir: [1, 0], outDir: [1, 0] });

    // ================================================================ 5. clans : bannière, coffre, guerre 5 contre 5
    scene('clan', T.CLAN, T.TN, root => {
      const mine = [['Pixel', 132], ['Nova', 118], ['Rex', 96], ['Mochi', 88], ['Juno', 71]], them = [['Zeph', 120], ['Kairo', 101], ['Tako', 84], ['Lumen', 69], ['Orbit', 52]];
      const team = (tag, color, list, cls) => `<div class="cl-team ${cls}"><div class="cl-team-head"><span class="cl-tag cl-c-${color}">[${tag}]</span> <b class="mono tw-total">0 XP</b></div><ol>${list.map(([n]) => `<li><span class="cl-pn">${avatar(n, 'av-xs')} ${n}</span><span class="cl-pr">5/5</span><b class="mono tw-v">0</b></li>`).join('')}</ol></div>`;
      root.innerHTML = `
        <div class="pin" id="k-left"><div class="ctr tr-clan">
          <div class="cl-banner cl-b-purple"><span class="cl-emoji big" aria-hidden="true">🦉</span><div class="cl-banner-txt"><h2>Night Owls</h2><div><span class="cl-tag cl-c-rainbow">[OWL]</span> <span class="cl-role cl-r-leader">👑 Leader</span></div><p class="cl-desc">We roll at midnight.</p></div></div>
          <div class="tiles cl-tiles">
            <div class="tile"><div class="l">Vault</div><div class="v">🪙 <span class="k-vault">12,400</span></div><div class="s">for upgrades and wars</div></div>
            <div class="tile"><div class="l">This week</div><div class="v">#1</div><div class="s"><span>2.4M</span> XP</div></div>
            <div class="tile"><div class="l">Members</div><div class="v"><span>18/20</span></div><div class="s">📨 3 waiting</div></div>
            <div class="tile"><div class="l">Wars</div><div class="v"><span class="k-wars">6–1</span></div><div class="s">won – lost</div></div>
          </div></div></div>
        <div class="pin" id="k-war"><div class="ctr tr-clan"><div class="panel cl-war"><div class="panel-head"><h3 class="panel-title k-wt">⚔️ War in progress</h3><span class="panel-note">🪙 <span>5,000</span> · 5 v 5</span></div>
          <div class="cl-teams">${team('OWL', 'rainbow', mine, 'mine')}${team('FOX', 'orange', them, '')}</div></div>
          <div class="k-stamp">war won!</div></div></div>`;
      const $ = s => root.querySelector(s);
      const pL = $('#k-left'), pW = $('#k-war'), vault = $('.k-vault'), wars = $('.k-wars'), wt = $('.k-wt'), stampEl = $('.k-stamp');
      const totals = Array.from(root.querySelectorAll('.tw-total')), vals = [Array.from(root.querySelectorAll('.cl-team.mine .tw-v')), Array.from(root.querySelectorAll('.cl-team:not(.mine) .tw-v'))];
      const rows = Array.from(root.querySelectorAll('.cl-team li'));
      const cl = put(claim(root, P ? 'Clans|*5v5 wars*' : 'Clans · *5v5 wars*', '', 'new'), P ? 230 : 56, P ? 124 : 96);
      const sub = put(fade(root, 'sub', 'banner · vault · upgrades · <b>weekly title</b>'), P ? 1790 : 1000, P ? 30 : 32);
      // Deux plans dans un même décor : la bannière et le coffre, puis la caméra file vers la guerre.
      const T_WON = 21.4, T_PAN = 20.85, GAPW = P ? 0 : 1250, GAPH = P ? 1500 : 0, S = P ? 1.8 : 2.05, CY = P ? 1080 : 620;
      const panAt = t => E.inOutQuint(prog(t, T_PAN - .1, .32));
      const WX = W / 2 + GAPW * (1 - panAt(T_WON)), WY = CY + GAPH * (1 - panAt(T_WON));
      cue(T_PAN - .1, 'whip', { pan: P ? 0 : 1 });
      cue(T.CLAN + .5, 'coin');
      cue(T.CLAN + .75, 'coin');
      for (let i = 0; i < 5; i++) cue(20.95 + i * .08, 'tick', { soft: 1 });
      cue(T_WON, 'impact', { kind: 'gold', soft: 1 });
      burst(T_WON + .02, WX, WY, CONF.gold, 51, 2.2);
      flash(T_WON, .6, 'gold', .3, WX, WY);
      impulse(T_WON, WX, WY, 150, .8);
      return t => {
        const k = panAt(t), drift = 1 + .08 * prog(t, T.CLAN, 2);
        place(pL, W / 2 - GAPW * k, CY - GAPH * k + (P ? 40 : 0), S * drift);
        place(pW, W / 2 + GAPW * (1 - k), CY + GAPH * (1 - k) + (P ? 60 : 30), S * drift * (1 + .03 * kick(t, T_WON, 9, 14)));
        setText(vault, fmt(12400 + 6500 * E.outCubic(prog(t, T.CLAN + .25, .5))));
        setText(wars, t >= T_WON + .1 ? '7–1' : '6–1');
        // les dix lancers de la guerre arrivent un par un, les totaux montent
        [mine, them].forEach((list, s) => {
          let tot = 0;
          list.forEach(([, v], i) => { const k = E.outCubic(prog(t, 20.95 + i * .08 + s * .04, .3)); tot += v * 1000 * k; setText(vals[s][i], `${Math.round(v * k)}K`); });
          setText(totals[s], `${Math.round(tot / 1000)}K XP`);
        });
        rows.forEach((r, i) => setCls(r, 'me', i === 0));
        setText(wt, t >= T_WON ? '⚔️ 🏆 War won!' : '⚔️ War in progress');
        const se = prog(t, T_WON, .35);
        fadeTo(stampEl, clamp(se * 4));
        stampEl.style.transform = `translate(-50%, -50%) rotate(-8deg) scale(${lerp(2.4, 1, E.outExpo(se)).toFixed(3)})`;
        light(W / 2, CY, 1200, C.purple, .17);
        light(WX, WY, 1000, mix(C.orange, C.gold, prog(t, T_WON, .3)), .1 + .12 * prog(t, T_WON, .3));
        cl.at(t, T.CLAN + .1, 21.85);
        sub.at(t, T.CLAN + .35, 21.85);
      };
    }, { inDir: [1, 0], outDir: [1, 0] });

    // ================================================================ 6. trois tournois par jour + tableau
    scene('tn', T.TN, T.CASINO, root => {
      const QF = [['Nova', 'Rex'], ['Pixel', 'Juno'], ['Mochi', 'Zeph'], ['Kairo', 'Tako']], W1 = ['Nova', 'Pixel', 'Mochi', 'Kairo'], SF = [['Nova', 'Pixel'], ['Mochi', 'Kairo']], W2 = ['Nova', 'Mochi'], CH = 'Nova';
      const score = (n, r) => fmt(200000 + Math.floor(hash(n.length * 7 + r, n.charCodeAt(0)) * 900000));
      const match = (pair, win, r) => `<div class="tn-match">${pair.map(n => `<div class="tn-p" data-n="${n}" data-w="${n === win ? 1 : 0}"><span class="tn-name">${avatar(n, 'av-xs')} ${n}</span><span class="mono">${score(n, r)}</span></div>`).join('')}</div>`;
      const col = (name, time, html, cls = '') => `<div class="tn-col ${cls}"><div class="tn-col-head"><b>${name}</b><span class="panel-note mono">${time}</span></div><div class="tn-matches">${html}</div></div>`;
      root.innerHTML = `
        <div class="pin" id="n-top"><div class="ctr tr-tn"><div class="seg tn-which"><button data-tn-which="1">🏆 <span>Tournament</span> 1 <span class="mono">32/32</span></button><button data-tn-which="2">🏆 <span>Tournament</span> 2 <span class="mono">32/32</span></button><button data-tn-which="3">🌙 <span>Evening</span> <span class="mono">24/32</span></button></div></div></div>
        <div class="pin" id="n-br"><div class="ctr tr-tn"><div class="panel"><div class="panel-head"><h3 class="panel-title">Bracket</h3><span class="panel-note">➕ Total XP · 5 rolls each</span></div>
          <div class="tn-bracket" style="--tn-cols:4">
            ${col('Quarter-finals', '12:00–15:00', QF.map((p, i) => match(p, W1[i], 1)).join(''))}
            ${col('Semi-finals', '15:00–18:00', SF.map((p, i) => match(p, W2[i], 2)).join(''))}
            ${col('Final', '18:00–24:00', match(W2, CH, 3))}
            ${col('Champion', '🪙 1,000', `<div class="tn-podium"><div class="tn-champ">🏆 ${avatar(CH, 'av-sm')} ${CH}</div><div class="panel-note">+ Champion title</div></div>`, 'tn-chcol')}
          </div></div></div></div>`;
      const $ = s => root.querySelector(s);
      const pTop = $('#n-top'), pBr = $('#n-br'), btns = Array.from(root.querySelectorAll('.tn-which button')), colsEl = Array.from(root.querySelectorAll('.tn-col')), champ = $('.tn-podium');
      const ROUND_T = [22.7, 23.0, 23.3];
      const cl = put(claim(root, P ? '3 tournaments|*a day*' : '3 tournaments *a day*', 'gold'), P ? 240 : 56, P ? 104 : 100);
      const sub = put(fade(root, 'sub', 'brackets · prizes · <b>champion title</b>'), P ? 480 : 168, P ? 30 : 32);
      const S = P ? 2.3 : 1.85, BX = P ? 540 : 960, BY = P ? 1200 : 660;
      btns.forEach((b, i) => { if (i) cue(21.95 + i * .15, 'pop'); });
      ROUND_T.forEach((t0, i) => cue(t0, 'lock', { i: i + 2, soft: 1 }));
      cue(23.55, 'win');
      const panAt = t => (P ? lerp(-420, 420, E.inOutCubic(prog(t, 22.2, 1.5))) : lerp(-330, 330, E.inOutCubic(prog(t, 22.2, 1.5))));
      // le champion : confettis dorés sur sa case (position mesurée dans la mise en page, au même instant du panoramique)
      const box = pBr.firstElementChild, cr = natRect(champ, box);
      const cx = BX - panAt(23.52) + (cr.x + cr.w / 2 - box.offsetWidth / 2) * S, cy = BY + (cr.y + cr.h / 2 - box.offsetHeight / 2) * S;
      burst(23.52, cx, cy, CONF.gold, 61, 2);
      flash(23.5, .5, 'gold', .25, cx, cy);
      impulse(23.5, cx, cy, 140, .8);
      return t => {
        btns.forEach((b, i) => {
          const e = popIn(t, 21.95 + i * .15, .3, 2.2);
          b.style.transform = `scale(${lerp(.5, 1, e).toFixed(3)})`;
          b.style.opacity = clamp(e * 3).toFixed(3);
          setCls(b, 'on', t >= 21.95 + i * .15 && t < 21.95 + (i + 1) * .15 + (i === 2 ? 9 : 0));
        });
        place(pTop, W / 2, P ? 640 : 270, P ? 1.75 : 1.9);
        // le tableau glisse pour suivre le tour en cours (panoramique de gauche à droite en 16:9)
        const pan = panAt(t);
        place(pBr, BX - pan, BY, S * (1 + .03 * prog(t, T.TN, 2)));
        colsEl.forEach((c, ci) => {
          const done = ci < 3 && t >= ROUND_T[ci];
          setCls(c, 'now', ci < 3 ? t >= (ROUND_T[ci - 1] || 0) && !done : t >= 23.5);
          c.querySelectorAll('.tn-p').forEach(p => { setCls(p, 'win', done && p.dataset.w === '1'); setCls(p, 'lose', done && p.dataset.w === '0'); setCls(p, 'me', p.dataset.n === 'Nova'); });
          if (ci > 0) c.style.opacity = clamp(prog(t, ci < 3 ? ROUND_T[ci - 1] - .05 : 23.45, .15) * .85 + .15).toFixed(3);
        });
        const ce = popIn(t, 23.5, .35, 2);
        champ.style.transform = `scale(${lerp(.4, 1, ce).toFixed(3)})`;
        champ.style.opacity = clamp(ce * 3).toFixed(3);
        light(W / 2, BY, 1300, mix(C.blue, C.gold, prog(t, 23.4, .4)), .16 + .08 * prog(t, 23.4, .4));
        cl.at(t, T.TN + .08, 23.85);
        sub.at(t, T.TN + .3, 23.85);
      };
    }, { inDir: [1, 0] });

    // ================================================================ 7. casino : Plinko, Dice, Blackjack (pièces du jeu)
    scene('casino', T.CASINO, T.PRESTIGE, root => {
      const PW = 520, PH = 360, ROWS = 12, GAPX = PW / (ROWS + 2), GAPY = (PH - 40) / ROWS, TABLE = [33, 11, 4, 2, 1.1, .6, .3, .6, 1.1, 2, 4, 11, 33];
      const slotM = m => (m >= 100 ? 'top' : m >= 4 ? 'hi' : m >= 1 ? 'mid' : 'lo');
      const card = (rank, suit, red, cls = '') => `<span class="pcard${red ? ' red' : ''} ${cls}"><span class="pc-in"><span class="pc-front"><b>${rank}<i>${suit}</i></b><em>${/[AJQK]/.test(rank) ? rank : suit}</em><b class="low">${rank}<i>${suit}</i></b></span><span class="pc-back"></span></span></span>`;
      root.innerHTML = `
        <div class="cas-strip">
          <div class="pin cas-shot"><div class="ctr tr-cas"><div class="panel g-game"><div class="panel-head"><h3 class="panel-title">🔻 Plinko</h3><span class="panel-note">12 rows · the edges pay the most</span></div>
            <div class="pk-board"><canvas class="pk-c" width="1040" height="720"></canvas></div>
            <div class="pk-slots" data-risk="normal">${TABLE.map((m, i) => `<span data-slot="${i}" data-m="${slotM(m)}">${m}×</span>`).join('')}</div>
            <p class="panel-note g-result cas-res" data-won="yes">11× · you get 550 coins</p></div></div></div>
          <div class="pin cas-shot"><div class="ctr tr-cas"><div class="panel g-game"><div class="panel-head"><h3 class="panel-title">🎲 Dice</h3><span class="panel-note">Roll under · 97% RTP</span></div>
            <div class="dc-table" data-mode="under"><div class="dc-view dc-100"><div class="dc-die mono">50</div>
              <div class="dc-track"><div class="dc-zone" style="left:0%;width:49%"></div><div class="dc-mark mono" style="left:50%">50</div></div>
              <div class="dc-scale mono"><span>1</span><span>25</span><span>50</span><span>75</span><span>100</span></div><p class="dc-rule">Win if the roll is under 50</p></div>
              <div class="dc-stats"><span><i>Win chance</i><b class="mono">49%</b></span><span><i>Multiplier</i><b class="mono">1.97×</b></span><span><i>Payout</i><b class="mono">🪙 197</b></span></div></div>
            <p class="panel-note g-result cas-res" data-won="yes">37 · you win 197 coins</p></div></div></div>
          <div class="pin cas-shot"><div class="ctr tr-cas"><div class="panel g-game"><div class="panel-head"><h3 class="panel-title">🃏 Blackjack</h3><span class="panel-note">Blackjack pays 3 to 2</span></div>
            <div class="bj-table"><div class="bj-shoe" aria-hidden="true"></div>
              <div class="bj-row"><span class="eyebrow">Dealer · 10</span><div class="bj-cards">${card('K', '♠', false, 'cd0')}${card('7', '♣', false, 'cd1 down')}</div></div>
              <div class="bj-felt-text">BLACKJACK PAYS 3 TO 2</div>
              <div class="bj-row"><span class="eyebrow cas-you">You · 21</span><div class="bj-cards">${card('A', '♥', true, 'cd2')}${card('K', '♦', true, 'cd3')}</div><span class="bj-stack">100</span></div></div>
            <p class="panel-note g-result cas-res" data-won="yes">Blackjack! · you win 250 coins</p></div></div></div>
        </div>
        <div class="pin" id="g-wallet"><div class="ctr"><span class="g-wallet"><span class="eyebrow">Your coins</span><b class="mono g-coins">🪙 24,310</b></span></div></div>
        <div class="pin" id="g-bj"><div class="ctr bj-stamp">Blackjack!</div></div>`;
      const $ = s => root.querySelector(s);
      const shots = Array.from(root.querySelectorAll('.cas-shot')), results = Array.from(root.querySelectorAll('.cas-res'));
      const pk = $('.pk-c').getContext('2d'), pkSlots = Array.from(root.querySelectorAll('.pk-slots span'));
      const die = $('.dc-die'), mark = $('.dc-mark'), dcTable = $('.dc-table');
      const pcs = [0, 1, 2, 3].map(i => $(`.cd${i}`)), pWallet = $('#g-wallet'), coins = $('.g-coins'), pBj = $('#g-bj');
      const cl = put(claim(root, P ? 'Casino|*for fun*' : 'Casino *for fun*', 'gold', 'new'), P ? 230 : 52, P ? 124 : 96);
      const chip = put(fade(root, 'sub', '<span class="tchip">🪙 <b>in-game coins only</b> · no real money</span>'), P ? 1760 : 962, P ? 30 : 34);
      const STARTS = [T.CASINO, T.DICE, T.BJ], S = P ? 1.8 : 1.62, CY = P ? 1080 : 600;
      // Billes de Plinko : chemins fixés d'avance (gauche/droite à chaque rangée), une rangée toutes les 55 ms.
      const PATHS = [[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0], [1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1], [1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1]];
      const BALLS = PATHS.map((path, k) => ({ path, t0: T.CASINO + .08 + k * .16, dur: .66 }));
      BALLS.forEach(b => { b.slot = b.path.reduce((x, y) => x + y, 0); for (let r = 0; r < ROWS; r++) cue(b.t0 + (r + 1) * b.dur / ROWS, 'peg', { k: r }); cue(b.t0 + b.dur, 'coin'); });
      const levelX = (r, i) => PW / 2 + (i - r / 2) * GAPX, levelY = r => 26 + r * GAPY - GAPY * .45;
      function ballAt(b, t) {
        const u = clamp((t - b.t0) / b.dur) * ROWS, r = Math.min(ROWS - 1, Math.floor(u)), f = u - r;
        let i = 0;
        for (let k = 0; k < r; k++) i += b.path[k];
        const x0 = levelX(r, i), x1 = levelX(r + 1, i + b.path[r]);
        return { x: lerp(x0, x1, f), y: lerp(levelY(r), levelY(r + 1), f) - Math.sin(Math.PI * f) * GAPY * .35, r, i, f, u };
      }
      function drawPlinko(t) {
        pk.setTransform(2, 0, 0, 2, 0, 0);
        pk.clearRect(0, 0, PW, PH);
        const hot = new Map();
        for (const b of BALLS) {
          if (t < b.t0) continue;
          let i = 0;
          for (let r = 0; r < ROWS; r++) { const th = b.t0 + (r + .5) * b.dur / ROWS; if (t >= th) hot.set(`${r}:${i + b.path[r]}`, Math.max(hot.get(`${r}:${i + b.path[r]}`) || 0, 1 - (t - th) / .42)); i += b.path[r]; }
        }
        for (let r = 0; r < ROWS; r++) for (let i = 0; i <= r + 1; i++) {
          const x = PW / 2 + (i - (r + 1) / 2) * GAPX, y = 26 + r * GAPY, h = Math.max(0, hot.get(`${r}:${i}`) || 0);
          pk.beginPath(); pk.arc(x + 1.5, y + 2.5, 4.2, 0, 7); pk.fillStyle = 'rgba(0,0,0,.45)'; pk.fill();
          if (h > 0) { pk.beginPath(); pk.arc(x, y, 4 + 9 * h, 0, 7); pk.fillStyle = `rgba(251,191,36,${.35 * h})`; pk.fill(); }
          const g = pk.createRadialGradient(x - 1.4, y - 1.6, .5, x, y, 4.4); g.addColorStop(0, '#fff'); g.addColorStop(1, h > 0 ? '#fbbf24' : '#8b93a7');
          pk.beginPath(); pk.arc(x, y, 4.2, 0, 7); pk.fillStyle = g; pk.fill();
        }
        for (const b of BALLS) {
          if (t < b.t0 - .05 || t > b.t0 + b.dur + .12) continue;
          const q = ballAt(b, t), fall = clamp((t - b.t0 - b.dur) / .12);
          for (let k = 8; k >= 1; k--) { const p = ballAt(b, t - k * .012); pk.beginPath(); pk.arc(p.x, p.y, 7 * (1 - k / 9), 0, 7); pk.fillStyle = `rgba(251,191,36,${(.18 * (1 - k / 9)).toFixed(3)})`; pk.fill(); }
          const y = q.y + fall * 40;
          pk.globalAlpha = 1 - fall;
          pk.beginPath(); pk.ellipse(q.x + 3, y + 6, 8, 5, 0, 0, 7); pk.fillStyle = 'rgba(0,0,0,.4)'; pk.fill();
          const g = pk.createRadialGradient(q.x - 3, y - 3, 1, q.x, y, 9); g.addColorStop(0, '#fff7c2'); g.addColorStop(.5, '#fbbf24'); g.addColorStop(1, '#b45309');
          pk.beginPath(); pk.arc(q.x, y, 9, 0, 7); pk.fillStyle = g; pk.fill();
          pk.beginPath(); pk.arc(q.x, y, 12, 0, 7); pk.strokeStyle = 'rgba(245,158,11,.35)'; pk.lineWidth = 3; pk.stroke();
          pk.globalAlpha = 1;
        }
      }
      const T_DIE = T.DICE + .5, T_BJ = T.BJ + .55;
      for (let k = 0; k < 7; k++) cue(T.DICE + .12 + k * .055, 'tick', { soft: 1 });
      cue(T_DIE, 'win', { small: 1 });
      [0, 1, 2, 3].forEach(i => cue(T.BJ + .08 + i * .1, 'card', { i }));
      cue(T.BJ + .45, 'card', { i: 4 });
      cue(T_BJ, 'impact', { kind: 'gold', soft: 1 });
      cue(T.DICE, 'whip', { pan: 1 }); cue(T.BJ, 'whip', { pan: 1 });
      burst(T_BJ, W / 2, CY, CONF.gold, 71, 2);
      return t => {
        let camPos = E.inOutQuint(prog(t, T.DICE - .12, .28)) + E.inOutQuint(prog(t, T.BJ - .12, .28));
        shots.forEach((s, i) => {
          const dx = (i - camPos) * W * 1.05;
          show(s, Math.abs(dx) < W * 1.1);
          place(s, W / 2 + dx, CY - 30 * prog(t, STARTS[i] - .2, 1.3), S * (1 + .08 * prog(t, STARTS[i] - .2, 1.3)));
        });
        // Plinko
        if (t < T.DICE + .3) {
          drawPlinko(t);
          const landed = BALLS.filter(b => t >= b.t0 + b.dur);
          pkSlots.forEach((sp, i) => { const b = landed.find(x => x.slot === i); setCls(sp, 'hit', !!b && t - (b.t0 + b.dur) < .35); });
        }
        // Dice
        const rolling = t >= T.DICE + .1 && t < T_DIE;
        setText(die, t < T.DICE + .1 ? '50' : rolling ? String(1 + Math.floor(hash(9, Math.floor(t / .055)) * 100)) : '37');
        die.style.transform = `scale(${(1 + .25 * kick(t, T_DIE, 10, 16)).toFixed(3)})`;
        mark.style.left = `${t >= T_DIE ? lerp(50, 37, E.outExpo(prog(t, T_DIE, .3))) : 50}%`;
        setText(mark, t >= T_DIE ? '37' : '50');
        if (t >= T_DIE) dcTable.dataset.result = 'win'; else delete dcTable.dataset.result;
        // Blackjack : quatre cartes distribuées, la carte cachée du croupier reste cachée, A + K = 21
        pcs.forEach((c, i) => {
          const t0 = T.BJ + .08 + i * .1, e = E.outExpo(prog(t, t0, .3));
          c.style.opacity = clamp(prog(t, t0, .06)).toFixed(3);
          c.style.transform = `translate(${((1 - e) * 190).toFixed(1)}px, ${((1 - e) * -110).toFixed(1)}px) rotate(${((1 - e) * 24).toFixed(1)}deg)`;
          const flip = i === 1 ? 0 : E.outCubic(prog(t, t0 + .12, .25));
          c.querySelector('.pc-in').style.transform = `rotateY(${(180 * (1 - flip)).toFixed(1)}deg)`;
        });
        const be = prog(t, T_BJ, .35);
        fadeTo(pBj, clamp(be * 4) * (1 - E.inCubic(prog(t, 26.85, .15))));
        place(pBj, W / 2, CY - (P ? 40 : 20), (P ? 1.12 : 1.6) * lerp(2.2, 1, E.outExpo(be)));
        // résultats et porte-monnaie
        const R = [BALLS[0].t0 + BALLS[0].dur + .05, T_DIE + .1, T_BJ + .1];
        results.forEach((r, i) => { r.style.opacity = E.outCubic(prog(t, R[i], .25)).toFixed(3); });
        const gain = 550 * E.outCubic(prog(t, R[0], .4)) + 197 * E.outCubic(prog(t, R[1], .4)) + 250 * E.outCubic(prog(t, R[2], .4));
        setText(coins, `🪙 ${fmt(24310 + gain)}`);
        place(pWallet, P ? 540 : 1640, P ? 1640 : 180, (P ? 2 : 1.8) * (1 + .06 * (kick(t, R[0], 9, 14) + kick(t, R[1], 9, 14) + kick(t, R[2], 9, 14))));
        pWallet.style.opacity = E.outCubic(prog(t, T.CASINO + .1, .3)).toFixed(3);
        light(W / 2, CY, 1300, [hex('#6366f1'), hex('#22c55e'), hex('#16a34a')][Math.min(2, Math.round(camPos))], .17);
        cl.at(t, T.CASINO + .08, 26.85);
        chip.at(t, T.CASINO + .3, 26.88);
      };
    }, { inDir: [1, 0], outDir: [1, 0] });

    // ================================================================ 8. titres Prestige
    scene('prestige', T.PRESTIGE, T.ROAD, root => {
      const LEFT = { tycoon: 37, magnate: 18, emperor: 7 };
      root.innerHTML = `<div class="pin" id="p-grid"><div class="ctr tr-pr"><div class="skin-grid pr-grid">${Shop.PRESTIGE.map(p => `<div class="skin-tile pr-tile"><div class="pr-badge" aria-hidden="true">${p.emoji}</div><div class="skin-name"><b>${titlePill(p.id)}</b><span>${esc(p.desc)}</span></div><span class="pr-left">${LEFT[p.id]} of ${p.stock} left</span><button class="btn" type="button">🪙 ${fmt(p.price)}</button></div>`).join('')}</div></div></div>`;
      const pG = root.querySelector('#p-grid'), tiles = Array.from(root.querySelectorAll('.pr-tile'));
      const cl = put(claim(root, P ? 'Prestige|*titles*' : 'Prestige *titles*', 'gold', 'new'), P ? 250 : 80, P ? 130 : 104);
      const sub = put(fade(root, 'sub', 'limited stock · <b>for the whole game</b>'), P ? 1835 : 880, P ? 28 : 34);
      tiles.forEach((x, i) => { if (i) cue(T.PRESTIGE - .1 + i * .12, 'badge', { i, of: 3 }); });
      return t => {
        place(pG, W / 2, P ? 1200 : 570, (P ? 1.8 : 2.3) * (1 + .08 * prog(t, T.PRESTIGE, 1)));
        tiles.forEach((x, i) => {
          const e = popIn(t, T.PRESTIGE - .1 + i * .12, .35, 2);
          x.style.opacity = clamp(e * 3).toFixed(3);
          x.style.transform = `translateY(${((1 - e) * 40).toFixed(1)}px) scale(${lerp(.7, 1, e).toFixed(3)})`;
        });
        light(W / 2, H / 2, 1300, C.gold, .18);
        cl.at(t, T.PRESTIGE + .05, 27.85);
        sub.at(t, T.PRESTIGE + .4, 27.85);
      };
    }, { inDir: [1, 0], outDir: [1, 0] });

    // ================================================================ 9. la feuille de route : les idées des joueurs
    scene('road', T.ROAD, T.TURN, root => {
      const ITEMS = [['Clans with 5v5 wars', 'Nova'], ['Profile pictures', 'Pixel'], ['@mentions in global chat', 'Rex'], ['Deep Dive wallpaper', 'Mochi'], ['A third daily tournament', 'Juno']];
      root.innerHTML = `<div class="pin" id="m-panel"><div class="ctr tr-rm"><div class="panel rm-panel"><div class="panel-head"><h3 class="panel-title">✅ Recently added</h3><span class="panel-note">last 30 days</span></div>
        <ul class="rm-list">${ITEMS.map(([txt, by], i) => `<li class="rm-item"><p class="rm-text">${esc(txt)}</p><span class="rm-by">idea by <a class="player-link">${by}</a> · ${i + 1}d ago</span></li>`).join('')}</ul></div></div></div>`;
      const pM = root.querySelector('#m-panel'), items = Array.from(root.querySelectorAll('.rm-item'));
      const cl = put(claim(root, P ? 'Built from|*your ideas*' : 'Built from|*your ideas*', P ? '' : 'left'), P ? 240 : 340, P ? 124 : 108, P ? null : 100);
      const sub = put(fade(root, `sub${P ? '' : ' left'}`, 'send yours with the 💡 button'), P ? 520 : 620, P ? 30 : 28, P ? null : 106);
      items.forEach((x, i) => { if (i > 1) cue(T.ROAD - .15 + i * .15, 'chat', { i }); });
      return t => {
        place(pM, P ? 540 : 1350, (P ? 1180 : 560) - 60 * prog(t, T.ROAD, 1.5), (P ? 1.95 : 1.95) * (1 + .07 * prog(t, T.ROAD, 1.5)));
        items.forEach((x, i) => {
          const e = E.outExpo(prog(t, T.ROAD - .15 + i * .15, .4));
          x.style.opacity = e.toFixed(3);
          x.style.transform = `translateX(${((1 - e) * 60).toFixed(1)}px)`;
        });
        light(P ? 540 : 1300, H / 2, 1200, C.teal, .15);
        cl.at(t, T.ROAD + .05, 29.3);
        sub.at(t, T.ROAD + .4, 29.3);
      };
    }, { inDir: [1, 0] });

    // ================================================================ 10. « your turn » : un temps de noir avant le tirage
    scene('turn', T.TURN, T.CLIMAX, root => {
      const cl = put(claim(root, P ? 'Your|*turn*' : 'Your *turn*'), P ? H * .42 : H * .4, P ? 180 : 170);
      cue(T.TURN, 'hit');
      cue(T.TURN + .05, 'riser', { dur: .4 });
      return t => {
        view.dark = 1;
        cl.at(t, T.TURN - .25, 1e9, .25);
        cl.el.style.transform = `scale(${(1 + .08 * prog(t, T.TURN, .5)).toFixed(4)})`;
        light(W / 2, H / 2, 900, C.purple, .1);
      };
    });

    // ================================================================ 11. le tirage final : 777777, INFINITE
    scene('climax', T.CLIMAX, T.END, root => {
      const N = 777777, a = analysis(N), str = a.str;
      if (a.tier !== 'infinite') throw new Error(`Trailer: ${N} is ${a.tier}, not infinite`);
      const HC = P ? { x: 540, y: 900 } : { x: 960, y: 590 };
      const LOCK = [30.5, 30.75, 31, 31.25, 31.5, T.DROP], REV = T.DROP, SPIN = 30.15, CLICK = 30.08;
      root.innerHTML = `
        <div class="cam">
          <div class="pin hero-card"><div class="ctr"><div class="card-stage"><div class="rays"></div><div class="num-card lg neutral">${slotsHTML('??????')}</div></div></div></div>
          <div class="pin" id="x-stamp"><div class="ctr stamp inf"><span>∞ infinite</span></div></div>
          <div class="pin" id="x-meta" data-tier="infinite"><div class="ctr"><div class="result-meta big">${tierPill('infinite')}<span class="dot">•</span><span class="top" style="color:#eab308">Top 0.001% <span class="one-in">· 1 in 100,000</span></span></div></div></div>
          <div class="pin" id="x-xp" data-tier="infinite"><div class="ctr"><div class="ep-big">0 XP</div></div></div>
          <div class="pin" id="x-btn"><div class="ctr"><button class="btn-roll">Generate</button></div></div>
        </div>`;
      const $ = s => root.querySelector(s);
      const cam = $('.cam'), pCard = $('.hero-card'), cstage = $('.card-stage'), rays = $('.rays'), card = $('.num-card'), slots = Array.from(card.querySelectorAll('.slot'));
      const pStamp = $('#x-stamp'), stampEl = $('.stamp'), pMeta = $('#x-meta'), pXP = $('#x-xp'), xp = $('.ep-big'), pBtn = $('#x-btn'), btn = $('.btn-roll');
      const K = (P ? 920 : 1080) / card.offsetWidth, cw = card.offsetWidth * K, ch = card.offsetHeight * K;
      const lastDx = (slots[5].offsetLeft + slots[5].offsetWidth / 2 - card.offsetWidth / 2) * K;
      flash(REV, .2, 'white', .8);
      flash(REV, 1.3, 'infinite', .42, HC.x, HC.y);
      for (let i = 0; i < 6; i++) ring(REV + i * .1, HC.x, HC.y, cw, ch, ['#ffffff', '#ec4899', '#a855f7', '#3b82f6', '#10b981', '#eab308'][i], { grow: 2.4 + i * .3, width: 10, dur: 1.2, radius: 60 });
      for (let k = 0; k < 3; k++) burst(REV + .02 + k * .55, HC.x, HC.y, CONF.infinite, 81 + k, 2.8);
      impulse(REV, HC.x, HC.y, 340, 1.4);
      impulse(REV + .55, HC.x, HC.y, 160, .7);
      streak(REV, HC.x, HC.y, C.purple, { thick: 46 });
      streak(REV + .05, HC.x, HC.y, C.cyan, { thick: 20, len: W * 1.6 });
      for (let i = 0; i < 5; i++) impulse(LOCK[i], HC.x, HC.y, 40, .35);
      cue(CLICK, 'click');
      ticks(SPIN, 31.5);
      for (let j = 1; j <= 9; j++) cue(31.5 + .5 * (1 - Math.sqrt(1 - j / 10)), 'tick', { last: j / 9 });
      LOCK.slice(0, 5).forEach((t, i) => cue(t, 'lock', { i }));
      cue(31.52, 'riser', { dur: .45 });
      cue(REV, 'impact', { kind: 'infinite' });
      cue(REV + .55, 'sparkle');
      cue(REV + 1.1, 'sparkle');
      // le dernier rouleau ralentit et frôle le 7 (8, 9, 0, 4, 6… 7)
      const SLOW = '58904613689046';
      return t => {
        const peak = t >= REV, spinning = t >= SPIN;
        let revealed = 0;
        for (let i = 0; i < 6; i++) if (t >= LOCK[i]) revealed = i + 1;
        const push = E.inOutCubic(prog(t, 31.5, .45)), back = E.outBack(prog(t, REV + .02, .6), 2.2), hold = push * (1 - back);
        let z = 1 + .08 * E.inOutCubic(prog(t, SPIN, 31.5 - SPIN)) * (1 - back) + (P ? .16 : .3) * hold;
        for (let i = 0; i < 5; i++) z *= 1 + .03 * kick(t, LOCK[i], 12, 22);
        const fxp = HC.x + lastDx * (P ? .3 : .62) * hold, sh = peak ? 30 * Math.exp(-5 * (t - REV)) : 0;
        view.cam = { z, x: HC.x - fxp * z + sh * Math.sin((t - REV) * 91), y: HC.y - HC.y * z + sh * Math.cos((t - REV) * 77) };
        cam.style.transform = `translate(${view.cam.x.toFixed(2)}px,${view.cam.y.toFixed(2)}px) scale(${z.toFixed(4)})`;
        view.dark = Math.max(.35 * (1 - prog(t, T.CLIMAX, .3)) + .2 * E.inOutCubic(prog(t, SPIN, 1.3)), .85 * hold);

        slots.forEach((s, i) => {
          const locked = i < revealed;
          let ch2 = '?';
          if (locked) ch2 = str[i];
          else if (i === 5 && t >= 31.5) ch2 = SLOW[Math.min(SLOW.length - 1, Math.floor(SLOW.length * (1 - (1 - prog(t, 31.5, .5)) ** 2)))];
          else if (spinning) ch2 = String(Math.floor(hash(i + 50, Math.floor(t / .055), 5) * 10));
          setText(s, ch2);
          setAnim(s, 'spinning', spinning && !locked, 0);
          setAnim(s, 'revealed', locked, LOCK[i]);
        });
        setCls(card, 'neutral', !peak);
        setAnim(card, 'charging', spinning && !peak, SPIN, 'charge');
        if (peak) { card.dataset.tier = 'infinite'; pCard.dataset.tier = 'infinite'; } else { delete card.dataset.tier; delete pCard.dataset.tier; }
        setAnim(card, 'shake', peak && t < REV + .6, REV, 'shake');
        const lastLock = revealed ? LOCK[revealed - 1] : -9;
        setAnim(cstage, 'thump', t - lastLock < .24, lastLock, 'thump');
        setCls(cstage, 'lit', peak);
        rays.style.opacity = (peak ? .75 * E.outCubic(prog(t, REV, .6)) : 0).toFixed(3);
        place(pCard, HC.x, HC.y, K * (1 + .05 * kick(t, SPIN, 9, 16)) * (1 + .035 * prog(t, REV + .6, 1.4)));

        const st = prog(t, REV + .06, .5);
        fadeTo(pStamp, clamp(st * 4));
        place(pStamp, HC.x, HC.y - ch / 2 - (P ? 170 : 120), (P ? .8 : 1) * lerp(2.6, 1, E.outExpo(st)));
        stampEl.style.letterSpacing = `${lerp(.5, .04, E.outExpo(st)).toFixed(3)}em`;
        stampEl.style.backgroundPosition = `${(-prog(t, REV, 2) * 100).toFixed(2)}% 0`;
        const mp = prog(t, REV + .35, .35);
        fadeTo(pMeta, clamp(mp * 3));
        place(pMeta, HC.x, HC.y + ch / 2 + 70, (P ? 3.2 : 3.4) * lerp(.7, 1, E.outBack(mp)));
        const xe = prog(t, REV + .5, 1.2);
        fadeTo(pXP, clamp(xe * 6));
        setText(xp, `${fmt(a.total * E.outExpo(xe))} XP`);
        setAnim(xp, 'glint', t >= REV + 1.7, REV + 1.7);
        place(pXP, HC.x, HC.y + ch / 2 + (P ? 230 : 185), (P ? 3.8 : 4) * (1 + .05 * kick(t, REV + 1.7, 8, 12)));

        const bOut = E.inCubic(prog(t, SPIN, .3)), press = Math.sin(Math.PI * prog(t, CLICK - .04, .2));
        fadeTo(pBtn, (1 - bOut) * clamp(prog(t, T.CLIMAX, .06)));
        place(pBtn, HC.x, HC.y + ch / 2 + 150 + bOut * 140, 2.3 * (1 - .09 * press) * (1 - .15 * bOut));
        btn.style.filter = press > .01 ? `brightness(${(1 + press).toFixed(2)})` : '';

        const hue = (t - REV) * 1.4;
        const lc = peak ? mix(mix(C.pink, C.cyan, .5 + .5 * Math.sin(hue)), C.purple, .5 + .5 * Math.cos(hue * .7)) : mix(C.indigo, C.violet, prog(t, 31, 1));
        light(HC.x, HC.y, (P ? 1300 : 1400) * z, lc, .1 + .03 * revealed + (peak ? .28 * Math.exp(-1.2 * (t - REV)) + .1 : 0));
        if (peak) light(HC.x + (P ? 0 : 420), HC.y + (P ? 520 : 120), 1000, C.cyan, .1);
      };
    }, { inDir: [0, 0] });

    // ================================================================ 12. fin : RNG8 → RNG∞, adresse, promesse
    scene('end', T.END, DURATION + 1, root => {
      const O = T.END, LETTERS = ['R', 'N', 'G'], LK = [O + .2, O + .32, O + .44], T_8 = O + .56, T_TURN = O + .7, T_HIT = O + 1, T_DONE = T_HIT + .1;
      root.innerHTML = `
        <div class="pin" id="o-logo"><div class="ctr logo">${LETTERS.map(ch => `<span class="ll">${ch}</span>`).join('')}<span class="l8"><i class="eight">8</i><i class="inf">∞</i></span><div class="logo-shine">RNG∞</div></div></div>
        <div class="pin" id="o-cta"><div class="ctr"><div class="btn-roll cta">rng-infinite.com</div></div></div>`;
      const pLogo = root.querySelector('#o-logo'), logo = root.querySelector('.logo'), ll = Array.from(root.querySelectorAll('.ll')), l8 = root.querySelector('.l8');
      const eight = root.querySelector('.eight'), inf = root.querySelector('.inf'), shine = root.querySelector('.logo-shine'), pCta = root.querySelector('#o-cta');
      ll.forEach(s => { s.style.width = `${s.getBoundingClientRect().width}px`; });
      inf.style.position = 'static';
      eight.style.display = 'none';
      const wInf = l8.getBoundingClientRect().width;
      inf.style.position = '';
      eight.style.display = '';
      const w8 = l8.getBoundingClientRect().width;
      const LG = P ? { x: 540, y: 760 } : { x: 960, y: 380 }, CTA = P ? { x: 540, y: 1180 } : { x: 960, y: 690 }, S_CTA = P ? 2.3 : 2.2;
      const lw = logo.offsetWidth - w8 + wInf, lh = logo.offsetHeight;
      ring(T_HIT, LG.x, LG.y, lw * 1.04, lh * .9, TIER_RING.mythic, { grow: 1.9, radius: 60 });
      ring(T_DONE, LG.x, LG.y, lw * 1.04, lh * .9, '#a855f7', { grow: 2.3, radius: 60 });
      flash(T_HIT, .9, 'mythic', .35, LG.x, LG.y);
      impulse(T_HIT, LG.x, LG.y, 200, 1);
      streak(T_HIT, LG.x, LG.y, C.purple);
      ticks(O + .06, T_8, { soft: 1 });
      LK.forEach((t, i) => cue(t, 'letter', { i }));
      cue(T_8, 'letter', { i: 3 });
      cue(T_TURN, 'whoosh', { dur: .25, pan: 0 });
      cue(T_HIT, 'impact', { kind: 'logo' });
      cue(T_HIT + .5, 'pop');
      const tag = put(fade(root, 'sub tagline', P ? 'free <i>·</i> no ads<br><b>play in your browser</b>' : 'free <i>·</i> no ads <i>·</i> <b>play in your browser</b>'), P ? 1400 : 870, P ? 50 : 50);
      const ALPHA = 'ABCDEFHJKLMPQSTUVWXYZ023456789';
      return t => {
        place(pLogo, LG.x, LG.y, lerp(.9, 1, E.outCubic(prog(t, O, .5))) * (1 + .045 * kick(t, T_HIT, 8, 15)) * (1 + .07 * prog(t, T_DONE, DURATION - T_DONE)));
        ll.forEach((s, i) => {
          const locked = t >= LK[i], e = E.snap(prog(t, LK[i], .36));
          setText(s, locked ? LETTERS[i] : ALPHA[Math.floor(hash(i + 40, Math.floor(t / .055)) * ALPHA.length)]);
          s.style.opacity = locked ? clamp(.35 + e).toFixed(3) : (.34 + .1 * Math.sin(t * 57 + i)).toFixed(3);
          s.style.transform = locked ? `translateY(${((1 - e) * -.12).toFixed(4)}em) scale(${lerp(1.1, 1, e).toFixed(4)})` : `translateY(${(.04 * Math.sin(t * 60 + i * 2)).toFixed(4)}em)`;
        });
        const l8on = t >= T_8, e8 = E.snap(prog(t, T_8, .36)), turn = E.outBack(prog(t, T_TURN, .28), 1.5), morph = t >= T_HIT ? 1 : 0;
        setText(eight, l8on ? '8' : String(Math.floor(hash(77, Math.floor(t / .055)) * 10)));
        l8.style.width = `${lerp(w8, wInf, E.inOutCubic(prog(t, T_TURN, .28))).toFixed(2)}px`;
        eight.style.opacity = (l8on ? clamp(.35 + e8) * (1 - morph) : .4).toFixed(3);
        eight.style.transform = l8on ? `translateY(${((1 - e8) * -.12).toFixed(4)}em) rotate(${(90 * turn).toFixed(2)}deg) scale(${lerp(1.1, 1, e8).toFixed(4)})` : `translateY(${(.04 * Math.sin(t * 60)).toFixed(4)}em)`;
        inf.style.opacity = morph.toFixed(3);
        inf.style.transform = `scale(${lerp(1.25, 1, E.outBack(prog(t, T_HIT, .4), 2)).toFixed(4)})`;
        const sp = prog(t, T_DONE + .05, .9), sp2 = prog(t, T_DONE + 1.6, .9), sp3 = prog(t, T_DONE + 2.65, .9);
        vis(shine, t >= T_DONE);
        shine.style.backgroundPosition = `${lerp(100, 0, sp < 1 ? sp : sp2 < 1 ? sp2 : sp3).toFixed(2)}% 0`;
        const ce = prog(t, T_HIT + .5, .5);
        fadeTo(pCta, clamp(ce * 3));
        place(pCta, CTA.x, CTA.y + (1 - E.outCubic(ce)) * 40, S_CTA * lerp(.8, 1, E.outBack(ce, 2)) * (1 + .025 * Math.sin((t - T_HIT) * 4.2)));
        tag.at(t, T_HIT + .85);
        const pulse = .5 + .5 * Math.sin((t - O) * 1.3);
        light(LG.x, LG.y, P ? 1150 : 1250, mix(C.pink, C.purple, pulse), .1 + .12 * prog(t, T_HIT, .4));
        light(CTA.x, CTA.y + 200, 900, C.cyan, .06 * prog(t, T_DONE, 1));
      };
    });

    // ---------------------------------------------------------------- coupes : filés, éclairs, volets
    whip(T.ROLL); // l'accroche part en filé
    [T.SKINS, T.FUN, T.CHAT, T.CLAN, T.TN, T.PRESTIGE, T.ROAD].forEach(t => whip(t));
    cue(T.WALL - .16, 'whip', { pan: 0 }); cue(T.WALL, 'hit', { soft: 1 });
    wipe(T.CASINO, ['#fde68a', '#f59e0b', '#22c55e']);
    flash(T.CLIMAX, .2, 'white', .35);
    wipe(T.END, ['#ec4899', '#a855f7', '#3b82f6', '#10b981', '#eab308']);
    // roulements de caisse claire avant les deux révélations (tirage Mythic, tirage final)
    cue(3, 'roll', { dur: 1 });
    cue(30.5, 'roll', { dur: 1 });
    SCORE.forEach(([t, level, chord]) => cue(t, 'music', { level, chord }));
  }

  // ------------------------------------------------------------------ une image
  function seek(out) {
    out = clamp(out, 0, LENGTH);
    const t = toSource(out);
    view.lights.length = 0;
    view.cam = IDENT;
    view.dark = 0;
    for (const s of scenes) {
      const on = t >= s.start && t < s.end;
      show(s.root, on);
      if (!on) continue;
      s.update(t);
      const [dx, dy] = whipShift(s, t);
      s.root.style.transform = dx || dy ? `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)` : '';
    }
    bug.style.opacity = (.85 * prog(t, T.ROLL + .2, .3) * (1 - prog(t, T.TURN - .2, .2))).toFixed(3);
    drawBg(t);
    drawFx(t, out);
    syncAnimations(t);
    setText(tcEl, out.toFixed(2));
  }

  async function init() {
    if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r, { once: true }));
    const faces = ['900 80px Inter', '800 80px Inter', '700 20px Inter', '600 20px Inter', '500 20px Inter', '400 20px Inter', '700 40px "Space Mono"', '400 40px "Space Mono"',
      '20px "Press Start 2P"', '20px Graduate', '20px "Share Tech Mono"'];
    await Promise.all(faces.map(f => document.fonts.load(f, 'RNG 0123456789 ∞').catch(() => null)));
    await document.fonts.ready;
    // Les séquences des skins dessinent leurs calques en 2× : les cartes sont agrandies à l'écran.
    try { Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true }); } catch (e) { /* tant pis : 1× */ }
    buildScenes();
    // Les avatars (images SVG) doivent être décodés avant la première capture.
    await Promise.all(Array.from(document.images).map(im => (im.decode ? im.decode().catch(() => null) : null)));
    seek(Number(qs.get('t')) || 0);
    window.__seek = seek;
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
    addEventListener('message', e => { if (e.data && typeof e.data.rngSeek === 'number') seek(e.data.rngSeek); });
    if (parent !== window) parent.postMessage('rng-ready', '*');
  }
  init().catch(err => { window.__trailerError = String((err && err.stack) || err); console.error(err); });

  // ------------------------------------------------------------------ lecteur : lecture, pause, déplacement
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
        if (now >= LENGTH + 1.2) now = 0;
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
