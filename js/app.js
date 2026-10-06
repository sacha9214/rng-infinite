/* RNG∞ — interface : tirage animé, historique, stats, collection, réglages. */
(function () {
  'use strict';

  const Engine = RNGEngine.createEngine(window.BADGE_META, window.SCORE_PERCENTILES);
  const TIERS_DESC = ['mythic', 'anomaly', 'epic', 'rare', 'uncommon', 'common', 'trash'];
  const TIER_RANK = { trash: 0, common: 1, uncommon: 2, rare: 3, epic: 4, anomaly: 5, mythic: 6 };
  const TIER_EMOJI = { trash: '🟫', common: '⬜', uncommon: '🟩', rare: '🟦', epic: '🟪', anomaly: '🟧', mythic: '🟥' };
  // Rythme de révélation du site d'origine (ms). Chaque vitesse applique un facteur à toutes ces durées.
  const REVEAL = {
    digitStart: 2000, digitBase: 1000, digitMax: 2000,
    badgeStart: 1000, badgeBase: 500, badgeMax: 1500, badgeEp: 500,
    summary: 1500, rarity: 1000, stats: 250, lifetimeShow: 1000, lifetimePause: 1500, lifetimeTick: 1500, end: 500,
  };
  // Les chiffres tournent toujours au rythme d'origine et ne se sautent pas.
  // badges : arrivée des badges ; base : fin de séquence (rareté, XP à vie).
  const SPEEDS = {
    dramatic: { badges: 1, base: 1 },
    normal: { badges: 0.85, base: 0.6 },
  };
  const SPEED_LABELS = { dramatic: 'original', normal: 'normal' };
  // Chaque chiffre suivant se fait attendre un peu plus ; idem pour les badges, jusqu'au plus rare.
  const digitDelay = (i, count) => REVEAL.digitBase + (REVEAL.digitMax - REVEAL.digitBase) * Math.pow(i / (count - 1), 2);
  const badgeDelay = (i, count) => (count <= 1 ? REVEAL.badgeBase
    : REVEAL.badgeBase + (REVEAL.badgeMax - REVEAL.badgeBase) * Math.pow(i / (count - 1), 1.5));
  const GROUP_COLORS = [['#93c5fd', '#2563eb'], ['#86efac', '#059669'], ['#fcd34d', '#d97706'], ['#f9a8d4', '#db2777']];
  const RIPPLE_FROM_CENTER = new Set(['MOUNTAIN', 'VALLEY']);
  const LABELS = new Map(Engine.badges.map(b => [b.id, b.label.toLowerCase()]));
  // Sons du tirage (js/sound.js). Fichier absent ou navigateur sans Web Audio : le jeu reste muet, et intact.
  const Sound = window.Sound || { play() {}, tick() {}, badge() {}, stop() {}, unlock() {}, enable() {}, warm() {}, LEAD: 900 };
  // Séquences des skins pendant un tirage (js/skinfx.js) : absentes, la carte garde simplement ses animations CSS.
  const SkinFX = window.SkinFX || { mount: () => null };

  // ---------------------------------------------------------------- serveur (classement en ligne, hébergé sur Vercel)
  // Sur Vercel l'API est sur le même domaine ; depuis GitHub Pages on appelle le déploiement Vercel.
  const API_BASE = location.hostname.endsWith('github.io') ? window.RNG_CONFIG.apiBase : '';
  const Online = {
    async request(pathname, options = {}) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const res = await fetch(API_BASE + pathname, { ...options, signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
        return body;
      } finally {
        clearTimeout(timer);
      }
    },
    roll() {
      const p = Store.player;
      return this.request('/api/roll', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name: p.name }) });
    },
    equip(title) {
      const p = Store.player;
      return this.request('/api/title', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, title }) });
    },
    room(code, fresh = false) {
      return this.request(`/api/room?code=${encodeURIComponent(code)}&me=${Store.player.id}${fresh ? '&fresh=1' : ''}`);
    },
    roomAction(action, code, extra = {}) {
      const p = Store.player;
      return this.request('/api/room', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name: p.name, action, code, ...extra }) });
    },
    leaderboard(period) {
      return this.request(`/api/leaderboard?period=${period}&me=${Store.player.id}`);
    },
    profile(name) {
      return this.request(`/api/profile?name=${encodeURIComponent(name)}&me=${Store.player.id}`);
    },
    shop() {
      return this.request(`/api/shop?me=${Store.player.id}`);
    },
    shopAction(action, skin) {
      const p = Store.player;
      return this.request('/api/shop', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, skin }) });
    },
    liveRooms() {
      return this.request('/api/room?live=1');
    },
    shopCase(id) {
      const p = Store.player;
      return this.request('/api/shop', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action: 'case', case: id }) });
    },
    quests() {
      return this.request(`/api/quests?me=${Store.player.id}`);
    },
    questAction(action, quest) {
      const p = Store.player;
      return this.request('/api/quests', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, quest }) });
    },
    // Toujours en POST : le secret du joueur ne va jamais dans une adresse.
    friends(action = 'list', name) {
      const p = Store.player;
      return this.request('/api/friends', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, name }) });
    },
    claimName(name) {
      const p = Store.player;
      return this.request('/api/name', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name }) });
    },
    // Sans "add" : renvoie tout l'historique du compte. Avec "add" : y verse ces tirages.
    history(add, fetchAll = true) {
      const p = Store.player;
      return this.request('/api/history', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, add, fetch: fetchAll }) });
    },
  };

  const app = document.getElementById('app');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let currentView = 'home';
  let session = null;

  // ---------------------------------------------------------------- utilitaires
  const $ = (sel, el = document) => el.querySelector(sel);
  const fmt = v => Math.round(v).toLocaleString('en-US');
  const compact = v => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (k, word) => `${fmt(k)} ${word}${k === 1 ? '' : 's'}`;
  const pctStr = p => {
    const v = p * 100;
    if (v === 0) return '0%';
    if (v < 0.01) return v.toFixed(4).replace(/0+$/, '') + '%';
    if (v < 1) return v.toFixed(2) + '%';
    return v.toFixed(1) + '%';
  };
  const oneIn = p => (p > 0 ? '1 in ' + fmt(1 / p) : '—');
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const sup = k => String(k).split('').map(ch => SUP[ch]).join('');
  const tierPill = tier => `<span class="pill" data-tier="${tier}">${tier}</span>`;

  // "Top x %" / "Bottom x %" arrondi et coloré selon le percentile, comme l'écran de résultat d'origine.
  function percentileHTML(p) {
    const text = p >= 50 ? `Top ${Math.round(100 - p) || '<1'}%` : `Bottom ${Math.round(p) || '<1'}%`;
    const color = p >= 95 ? '#eab308' : p >= 80 ? '#22c55e' : p >= 50 ? '#10b981' : p >= 20 ? '#f97316' : '#ef4444';
    return `<span class="top" style="color:${color}">${text}</span>`;
  }

  function relTime(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 172800) return 'yesterday';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const fullDate = t => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  let toastTimer = 0;
  function toast(msg, ms = 2600, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast${kind ? ` ${kind}` : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('out'); // sort en glissant, puis disparaît
      toastTimer = setTimeout(() => { el.hidden = true; }, reducedMotion ? 0 : 220);
    }, ms);
  }

  // ---------------------------------------------------------------- succès et titres
  // Le serveur renvoie la liste des succès débloqués (après un tirage, sur le profil, en fin de duel) ;
  // on annonce ceux que cet appareil n'a pas encore vus. Le titre d'un succès s'équipe depuis son profil.
  const Ach = window.RNGAchievements;
  const Shop = window.RNGShop;
  const Quests = window.RNGQuests;
  const skinClass = raw => {
    const id = Shop.resolve(raw);
    if (id === 'owner') return ' owner-ruby'; // le rubis du créateur
    return id && id !== 'classic' && Shop.byId.has(id) ? ` skin-${id}` : '';
  };
  // Skin Slots : une manette sur le côté de la machine, qu'on abaisse au lancement (voir .slot-lever dans le CSS).
  const LEVER = '<span class="slot-lever" aria-hidden="true"></span>';
  const withLever = (card, raw) => (Shop.resolve(raw) === 'slots' ? `<span class="lever-wrap">${card}${LEVER}</span>` : card);
  const slotsHTML = str => str.split('').map(c => `<span class="slot">${c}</span>`).join('');

  // Skin Matrix : chaque carte reçoit un canvas derrière ses chiffres, avec des colonnes de caractères (katakana et
  // chiffres) qui tombent à des vitesses différentes, tête presque blanche, traînée verte qui s'efface, comme dans le film.
  const MatrixRain = (() => {
    const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>¦';
    const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
    const rains = new Map(); // carte → { canvas, ctx, w, h, size, cols }
    // Minuterie de 55 ms (~18 images/s, la pluie du film est saccadée) ; le navigateur la ralentit en arrière-plan.
    let timer = 0, queued = false;

    function setup(r, card) {
      const dpr = window.devicePixelRatio || 1;
      r.w = card.clientWidth;
      r.h = card.clientHeight;
      r.canvas.width = Math.round(r.w * dpr);
      r.canvas.height = Math.round(r.h * dpr);
      r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      r.size = Math.max(8, Math.round(r.h / 5));
      r.cols = Array.from({ length: Math.ceil(r.w / r.size) }, () => ({ y: -Math.random() * 12, every: 1 + ((Math.random() * 3) | 0), tick: 0 }));
      r.ctx.fillStyle = '#000';
      r.ctx.fillRect(0, 0, r.w, r.h);
    }

    let frames = 0;
    function frame() {
      timer = 0;
      // Onglet caché : rien à dessiner, on repasse dans 1 s.
      if (document.hidden) { if (rains.size) timer = setTimeout(frame, 1000); return; }
      frames++;
      for (const [card, r] of rains) {
        if (!card.isConnected) { rains.delete(card); continue; }
        // Taille relue 2 fois par seconde seulement (la lire à chaque image force le navigateur à recalculer la page).
        if (!r.w || frames % 9 === 0) { if (card.clientWidth !== r.w || card.clientHeight !== r.h) setup(r, card); }
        const { ctx, size } = r;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
        ctx.fillRect(0, 0, r.w, r.h);
        ctx.font = `${size}px 'Share Tech Mono', monospace`;
        ctx.textBaseline = 'top';
        r.cols.forEach((c, i) => {
          if (++c.tick % c.every) return;
          const x = i * size, y = c.y * size;
          ctx.fillStyle = '#00ff41';
          ctx.fillText(glyph(), x, y - size); // le caractère d'avant repasse en vert
          ctx.fillStyle = '#e6ffe9';
          ctx.fillText(glyph(), x, y); // tête de colonne, presque blanche
          c.y += 1;
          if (y > r.h && Math.random() > 0.85) c.y = -Math.random() * 6;
        });
      }
      if (rains.size) timer = setTimeout(frame, 55);
    }

    // Cherche les cartes Matrix de la page (une fois par salve de changements) ; remet le canvas si la carte a été redessinée.
    function scan() {
      queued = false;
      document.querySelectorAll('.num-card.skin-matrix').forEach(card => {
        const known = rains.get(card);
        if (known) {
          if (known.canvas.parentNode !== card) card.prepend(known.canvas);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.className = 'matrix-rain';
        canvas.setAttribute('aria-hidden', 'true');
        card.prepend(canvas);
        const r = { canvas, ctx: canvas.getContext('2d') };
        setup(r, card);
        rains.set(card, r);
      });
      if (rains.size && !timer) timer = setTimeout(frame, 55);
    }

    function watch(root) {
      if (reducedMotion) return;
      new MutationObserver(() => {
        if (!queued) { queued = true; setTimeout(scan, 0); }
      }).observe(root, { childList: true, subtree: true });
    }
    return { glyph, watch };
  })();
  // Chiffre affiché pendant que ça tourne : du code qui défile pour le skin Matrix, un chiffre sinon.
  const spinChar = card => (card && card.classList.contains('skin-matrix') ? MatrixRain.glyph() : String((Math.random() * 10) | 0));
  const titleHTML = id => {
    const a = id && Ach.byId.get(id);
    if (!a) return '';
    // Titre du créateur : le mot seul, en rouge béryl, sans pastille autour.
    if (a.hidden) return `<span class="title-owner" title="${esc(a.desc)}">${esc(a.title)}</span>`;
    return `<span class="title-pill" title="${esc(a.desc)}">${a.emoji} <span class="t">${esc(a.title)}</span></span>`;
  };

  function noteAchievements(list) {
    if (!Array.isArray(list)) return;
    const seen = Store.settings.achSeen;
    Store.setSetting('achSeen', list);
    if (!Array.isArray(seen)) return; // première liste reçue sur cet appareil : pas d'avalanche d'annonces
    const fresh = list.filter(id => !seen.includes(id)).map(id => Ach.byId.get(id)).filter(Boolean);
    if (!fresh.length) return;
    toast(fresh.length === 1
      ? `🏆 Achievement unlocked: ${fresh[0].emoji} ${fresh[0].title}. Equip its title from your profile`
      : `🏆 ${fresh.length} achievements unlocked: ${fresh.map(a => `${a.emoji} ${a.title}`).join(', ')}`, 6000, 'achv');
  }

  // Analyses mises en cache : un nombre donne toujours le même résultat.
  const cache = new Map();
  function analysis(n) {
    let a = cache.get(n);
    if (!a) {
      a = Engine.analyze(n);
      cache.set(n, a);
      if (cache.size > 20000) cache.delete(cache.keys().next().value);
    }
    return a;
  }

  // Index de collection : badges obtenus et nombres déjà tirés.
  const Collection = {
    built: false,
    badges: new Map(),
    seen: new Map(),
    ensure() { if (!this.built) this.rebuild(); return this; },
    rebuild() {
      this.badges.clear();
      this.seen.clear();
      Store.rolls.forEach((r, i) => this.add(r, i));
      this.built = true;
    },
    add(r, i) {
      for (const id of analysis(r[0]).earnedIds) {
        let e = this.badges.get(id);
        if (!e) this.badges.set(id, (e = { count: 0, first: i, last: i }));
        e.count++;
        e.last = i;
      }
      const list = this.seen.get(r[0]);
      if (list) list.push(i); else this.seen.set(r[0], [i]);
    },
  };

  const lifetimeEP = () => Store.rolls.reduce((acc, r) => acc + r[1], 0);

  function bestRollIndex() {
    let best = -1;
    Store.rolls.forEach((r, i) => { if (best < 0 || r[1] > Store.rolls[best][1]) best = i; });
    return best;
  }

  function topRollIndices(k) {
    return Store.rolls.map((r, i) => i).sort((a, b) => Store.rolls[b][1] - Store.rolls[a][1] || a - b).slice(0, k);
  }

  // ---------------------------------------------------------------- badges : rendu
  // Chiffres sous un badge : chaque chiffre concerné reçoit sa couleur et son délai d'allumage
  // (80 ms d'écart, groupe après groupe ; Mountain/Valley s'allument depuis le centre). animateDigits les allume.
  function digitTiles(n, id) {
    const s = String(n);
    const groups = Engine.highlight(id, n);
    const multi = groups.length > 1;
    const info = new Map();
    let offset = 0;
    groups.forEach((g, gi) => {
      const [bg, bd] = multi ? GROUP_COLORS[gi % GROUP_COLORS.length] : ['var(--t-hl)', 'var(--t-hl-border)'];
      g.forEach((i, k) => { if (!info.has(i)) info.set(i, { bg, bd, delay: offset + 80 * k }); });
      offset += 80 * g.length + 100;
    });
    if (RIPPLE_FROM_CENTER.has(id)) {
      const idx = [...info.keys()].sort((a, b) => a - b);
      const mid = idx[Math.floor(idx.length / 2)];
      info.forEach((v, i) => { v.delay = 80 * Math.abs(i - mid); });
    }
    return s.split('').map((ch, i) => {
      const t = info.get(i);
      return t
        ? `<span class="dt hl" data-delay="${t.delay}" style="--hl-bg:${t.bg};--hl-bd:${t.bd}">${ch}</span>`
        : `<span class="dt">${ch}</span>`;
    }).join('');
  }

  // Boucle sur chaque rangée de chiffres : allumage en vague (avec un petit pop), maintien, extinction en vague, pause.
  // S'arrête d'elle-même quand la carte quitte la page.
  const DIGIT_HOLD_MS = 1800;
  const DIGIT_REST_MS = 400;
  function animateDigits(root, { start = 100, stagger = 0 } = {}) {
    root.querySelectorAll('.digits:not([data-animated])').forEach((box, index) => {
      box.dataset.animated = '1';
      const tiles = Array.from(box.querySelectorAll('.dt.hl'));
      if (!tiles.length) return;
      if (reducedMotion) { tiles.forEach(t => t.classList.add('lit')); return; }
      tiles.forEach(t => { t.style.transitionDelay = t.style.animationDelay = t.dataset.delay + 'ms'; });
      const span = Math.max(...tiles.map(t => Number(t.dataset.delay)));
      const later = (fn, ms) => setTimeout(() => { if (box.isConnected) fn(); }, ms);
      const lightUp = () => {
        tiles.forEach(t => { t.style.transitionDuration = '250ms'; t.classList.add('lit'); });
        later(fadeOut, span + 250 + DIGIT_HOLD_MS);
      };
      const fadeOut = () => {
        tiles.forEach(t => { t.style.transitionDuration = '350ms'; t.classList.remove('lit'); });
        later(lightUp, span + 350 + DIGIT_REST_MS);
      };
      later(lightUp, start + stagger * index);
    });
  }

  const POWER_K = { SQUARE: 2, CUBE: 3, FOURTH_POWER: 4, FIFTH_POWER: 5, SIXTH_POWER: 6, SEVENTH_POWER: 7, EIGHTH_POWER: 8, NINTH_POWER: 9, TENTH_POWER: 10, ELEVENTH_POWER: 11, THIRTEENTH_POWER: 13, SEVENTEENTH_POWER: 17, NINETEENTH_POWER: 19 };
  const BASES = { POWER_OF_TWO: 2, POWER_OF_THREE: 3, POWER_OF_FIVE: 5, POWER_OF_SEVEN: 7 };
  const DIVS = { DOZEN: 12, LUCKY_SEVEN_DIV: 7, ELEVEN: 11 };

  // Petite ligne d'explication sous certains badges ("7 × 9 = 63", "2¹⁰"...).
  function badgeDetail(id, n) {
    const s = String(n);
    const digits = s.split('').map(Number);
    const sum = digits.reduce((a, b) => a + b, 0);
    const parts = () => Engine.highlight(id, n).map(g => Number(g.map(i => s[i]).join('')));
    if (POWER_K[id]) return `${Math.round(Math.pow(n, 1 / POWER_K[id]))}${sup(POWER_K[id])}`;
    if (BASES[id]) { let k = 0, p = 1; while (p < n) { p *= BASES[id]; k++; } return `${BASES[id]}${sup(k)}`; }
    if (DIVS[id]) return `${fmt(n)} = ${DIVS[id]} × ${fmt(n / DIVS[id])}`;
    switch (id) {
      case 'EQUATION': {
        const [a, b, c] = parts();
        const op = a + b === c ? '+' : a - b === c ? '−' : a * b === c ? '×' : '÷';
        return `${a} ${op} ${b} = ${c}`;
      }
      case 'ARITHMETIC': { const v = parts(); const d = v[1] - v[0]; return `${v.join(' → ')}  (step ${d > 0 ? '+' : ''}${d})`; }
      case 'GEOMETRIC': { const v = parts(); return `${v.join(' → ')}  (×${+(v[1] / v[0]).toFixed(3)})`; }
      case 'CONSEC_PAIR_EXACT': case 'CONSEC_TRIPLE_EXACT': case 'CONSEC_TRIPLE_SCRAMBLED':
      case 'CONSEC_QUAD_EXACT': case 'CONSEC_QUAD_SCRAMBLED': case 'CONSEC_PAIR_ADJACENT':
      case 'CONSEC_PAIR_NEARBY': case 'CONSEC_TRIPLE_CONTAINS': case 'CONSEC_QUAD_CONTAINS':
        return parts().join(' · ');
      case 'HARSHAD': return `${fmt(n)} ÷ ${sum} = ${fmt(n / sum)}`;
      case 'PRONIC': { const k = Math.round((Math.sqrt(1 + 4 * n) - 1) / 2); return `${k} × ${k + 1}`; }
      case 'FACTORIAL': { let k = 1, f = 1; while (f < n) f *= ++k; return `${k}!`; }
      case 'OUROBOROS': { let k = 1; while (Math.pow(k, k) < n) k++; return `${k}${sup(k)}`; }
      case 'FEATHER': case 'HEAVY': case 'BLACKJACK': return `digit sum = ${sum}`;
      case 'SPY': return `sum ${sum} = product ${digits.reduce((a, b) => a * b, 1)}`;
      case 'BALANCED': {
        const h = s.length / 2;
        const l = digits.slice(0, h).reduce((a, b) => a + b, 0);
        return `${s.slice(0, h)} → ${l}  =  ${s.slice(h)} → ${l}`;
      }
      default: return '';
    }
  }

  function badgeCardHTML(group, n, opts) {
    const b = group.badge;
    const detail = badgeDetail(b.id, n);
    const isNew = opts.newIds && opts.newIds.has(b.id);
    const anim = opts.animate ? ' reveal' : '';
    const delay = opts.animate ? ` style="animation-delay:${opts.delay}ms"` : '';
    const subs = group.subsidiary.map(sb => `
      <div class="sub-badge${opts.animate ? ' fade-in' : ''}" data-tier="${sb.tier}"${delay}>
        <span>└</span><span>${sb.emoji}</span>
        <span class="name" data-badge="${sb.id}" style="cursor:pointer">${esc(sb.label)}</span>
        ${opts.newIds && opts.newIds.has(sb.id) ? '<span class="new-tag">NEW</span>' : ''}
        <span class="digits mini">${digitTiles(n, sb.id)}</span>
        <span class="earned">(earned)</span>
      </div>`).join('');
    return `<div class="badge-group">
      <div class="badge-card${anim}" data-tier="${b.tier}"${delay}>
        <div class="badge-head">
          <div class="badge-title">
            <span class="emoji">${b.emoji}</span>
            <span class="name" data-badge="${b.id}" style="cursor:pointer">${esc(b.label)}</span>
            ${tierPill(b.tier)}
            ${isNew ? '<span class="new-tag">NEW</span>' : ''}
          </div>
          <span class="ep-pill">+${fmt(b.score)} XP</span>
        </div>
        <div class="badge-desc">${esc(b.desc)}</div>
        ${detail ? `<div class="badge-extra">${esc(detail)}</div>` : ''}
        <div class="digits">${digitTiles(n, b.id)}</div>
      </div>${subs}</div>`;
  }

  function breakdownHTML(n, a, opts = {}) {
    const count = a.earnedIds.length;
    const stagger = opts.stagger || 0;
    return `
      <section class="breakdown">
        <h2 class="section-title">Badge breakdown</h2>
        <div class="section-sub">${plural(count, 'badge')} earned</div>
        <div class="list">${a.groups.map((g, i) => badgeCardHTML(g, n, { newIds: opts.newIds, animate: opts.animate, delay: i * stagger })).join('')}</div>
      </section>`;
  }

  function shareText(a) {
    // "rank" et pas "top" : dans le navigateur, "top" nu désigne window.top.
    const rank = Engine.topLabel(a.percentile);
    const lines = [`RNG∞ 🎲 ${a.str}`, '', `${TIER_EMOJI[a.tier]} ${a.tier.toUpperCase()}${rank ? ' • ' + cap(rank.toLowerCase()) : ''}`, ''];
    a.groups.slice(0, 3).forEach(g => lines.push(`${TIER_EMOJI[g.badge.tier]} ${g.badge.emoji} ${g.badge.label}`));
    if (a.groups.length > 3) lines.push(`+${a.groups.length - 3} more`);
    lines.push('', `${fmt(a.total)} XP`, location.origin + location.pathname);
    return lines.join('\n');
  }

  const share = a => shareOrCopy(shareText(a));

  // Téléphone : feuille de partage du système. Ordinateur : presse-papiers, ou le texte sélectionné s'il est refusé.
  async function shareOrCopy(text, title = 'Share') {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.share) {
      try { await navigator.share({ text }); } catch (e) { /* annulé */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch (e) {
      // Presse-papiers refusé par le navigateur : on montre le texte déjà sélectionné, prêt à copier.
      openModal(`<h2>${esc(title)}</h2><p class="panel-note" style="margin:-.3rem 0 .6rem">Copy this text (Cmd/Ctrl + C) and paste it anywhere.</p>
        <textarea class="input" style="width:100%;height:12rem;padding:.6rem;font-family:var(--font-mono)" readonly>${esc(text)}</textarea>`, m => {
        const area = m.querySelector('textarea');
        area.focus();
        area.select();
      });
    }
  }

  // ---------------------------------------------------------------- effets
  const FX = (() => {
    const canvas = $('#fx');
    const ctx = canvas.getContext('2d');
    let parts = [];
    let raf = 0;
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    addEventListener('resize', resize);
    resize();
    const CONF = {
      rare: { count: 26, speed: 5, colors: ['#60a5fa', '#bfdbfe', '#3b82f6', '#ffffff'], sparks: true },
      epic: { count: 60, speed: 7, colors: ['#a855f7', '#d8b4fe', '#7c3aed', '#f0abfc'] },
      anomaly: { count: 120, speed: 9, colors: ['#f97316', '#fdba74', '#fbbf24', '#ea580c'] },
      mythic: { count: 240, speed: 12, colors: ['#ec4899', '#a855f7', '#22d3ee', '#f43f5e', '#fde047'] },
    };
    function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter(p => p.life < p.max);
      for (const p of parts) {
        p.life++;
        p.vy += 0.22;
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.x += Math.sin((p.life + p.phase) * 0.12) * p.sway;
        p.rot += p.vr;
        p.flip += p.vf;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(Math.cos(p.flip), 1); // le confetti se retourne comme un morceau de papier
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      raf = parts.length ? requestAnimationFrame(tick) : 0;
    }
    function celebrate(tier, el) {
      const c = CONF[tier];
      if (!c || reducedMotion || !el) return;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (let i = 0; i < c.count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = c.speed * (0.35 + Math.random());
        const spark = c.sparks || Math.random() < 0.18;
        parts.push({
          x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - c.speed * 0.35,
          w: spark ? 2.5 + Math.random() * 3 : 4 + Math.random() * 5, h: 6 + Math.random() * 8, round: spark,
          rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, flip: Math.random() * 6, vf: 0.08 + Math.random() * 0.18,
          sway: spark ? 0 : 0.4 + Math.random() * 0.8, phase: Math.random() * 60,
          color: c.colors[i % c.colors.length], life: 0, max: (spark ? 45 : 70) + Math.random() * 60,
        });
      }
      if (tier === 'mythic') {
        const f = document.createElement('div');
        f.className = 'flash';
        f.style.background = 'radial-gradient(circle at 50% 30%, rgba(236,72,153,.5), rgba(168,85,247,.3) 40%, rgba(34,211,238,.12) 70%, transparent)';
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 1000);
      }
      if (parts.length > 600) parts.splice(0, parts.length - 600);
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function clear() {
      parts = [];
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
    return { celebrate, clear };
  })();

  // Relance une animation CSS portée par une classe (même si elle vient de jouer).
  function replay(el, cls) {
    if (!el || reducedMotion) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // Onde de choc à la couleur de la rareté, qui part de la carte au moment où la rareté se révèle.
  const TIER_RING = { uncommon: '#10b981', rare: '#3b82f6', epic: '#a855f7', anomaly: '#f97316', mythic: '#ec4899' };
  function shockwave(el, tier) {
    const color = TIER_RING[tier];
    if (!color || reducedMotion || !el) return;
    const r = el.getBoundingClientRect();
    const rings = TIER_RANK[tier] >= TIER_RANK.epic ? 2 : 1;
    for (let k = 0; k < rings; k++) {
      const w = document.createElement('div');
      w.className = 'shockwave';
      Object.assign(w.style, { left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px`, width: `${r.width}px`, height: `${r.height}px`, borderColor: color, color, animationDelay: `${k * 140}ms` });
      document.body.appendChild(w);
      setTimeout(() => w.remove(), 1100 + k * 140);
    }
  }

  // Un nouveau countUp sur le même élément annule le précédent.
  function countUp(el, from, to, duration, format) {
    const token = (el._countToken = (el._countToken || 0) + 1);
    if (!duration || reducedMotion) { el.textContent = format(to); return; }
    const t0 = performance.now();
    const step = now => {
      if (!el.isConnected || el._countToken !== token) return;
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = format(from + (to - from) * eased);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- tooltip
  const tip = $('#tooltip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
    tip.style.top = (y + 16 + h > innerHeight - 8 ? y - h - 12 : y + 16) + 'px';
  }
  document.addEventListener('pointermove', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) showTip(el.dataset.tip, e.clientX, e.clientY); else if (!tip.hidden) tip.hidden = true;
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  // ---------------------------------------------------------------- modale
  function closeModal() {
    const root = $('#modal-root');
    if (!root.firstChild) return;
    root.innerHTML = '';
    document.body.style.overflow = '';
  }
  function openModal(html, onMount) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true"><button class="modal-close" aria-label="Close">×</button>${html}</div></div>`;
    const backdrop = root.firstChild;
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop || e.target.closest('.modal-close')) closeModal();
    });
    document.body.style.overflow = 'hidden';
    if (onMount) onMount(backdrop.querySelector('.modal'));
  }

  // Trailer : la vidéo (33 Mo) ne se charge qu'au clic ; sur un téléphone tenu droit, c'est la version verticale.
  const playIcon = () => '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>';
  function openTrailer() {
    const tall = window.matchMedia('(max-width: 720px) and (orientation: portrait)').matches, f = tall ? '9x16' : '16x9';
    openModal(`<video class="trailer-video${tall ? ' tall' : ''}" src="media/trailer-${f}.mp4" poster="media/trailer-${f}.jpg" controls autoplay playsinline preload="auto"></video>`, m => {
      m.classList.add('wide');
      if (tall) m.classList.add('tall');
      const video = m.querySelector('video');
      video.focus(); // Espace = lecture / pause
      video.play().catch(() => { /* lecture automatique refusée : les commandes restent là */ });
    });
  }

  // Dons facultatifs (« Buy me a coffee ») : PayPal, ou USDT / USDC sur le réseau Ethereum. Aucun avantage en jeu.
  const TIP = { paypal: 'https://paypal.me/sacha9214', wallet: '0x85c90AD40EC0914Cc8519138099F860Bb5a41E2A' };
  function openCoffee() {
    const pay = TIP.paypal;
    openModal(`
      <h2>☕ Buy me a coffee</h2>
      <p class="panel-note" style="margin:-.3rem 0 1rem">RNG∞ is free and has no ads. If you enjoy it, you can chip in. It is entirely optional and gives nothing in the game: no coins, no skins, no luck.</p>
      <div class="field"><label>PayPal</label><a class="btn-roll small" href="${pay}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Donate with PayPal</a></div>
      <div class="field"><label>Crypto — USDT or USDC, Ethereum network (ERC-20) only</label>
        <div class="tip-wallet"><code id="tip-wallet">${TIP.wallet}</code><button class="btn" id="tip-copy">Copy</button></div>
        <span class="panel-note">Send only USDT or USDC on Ethereum to this address. Anything sent on another network may be lost.</span></div>
      <div class="actions"><button class="btn" id="tip-done">Close</button></div>`, m => {
      m.querySelector('#tip-done').addEventListener('click', closeModal);
      m.querySelector('#tip-copy').addEventListener('click', async e => {
        try { await navigator.clipboard.writeText(TIP.wallet); e.target.textContent = 'Copied'; }
        catch (err) { const r = document.createRange(); r.selectNodeContents(m.querySelector('#tip-wallet')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Select and copy the address'); }
      });
    });
  }

  function openRollModal(index) {
    const r = Store.rolls[index];
    if (!r) return;
    Collection.ensure();
    const a = analysis(r[0]);
    const occ = Collection.seen.get(r[0]) || [];
    openModal(`
      <div class="result" data-tier="${a.tier}" style="padding-top:.2rem">
        <div class="eyebrow">Roll #${fmt(index + 1)} · ${fullDate(r[2])}</div>
        <div style="margin-top:.9rem"><span class="num-card lg" data-tier="${a.tier}">${a.str}</span></div>
        <div class="result-meta">${tierPill(a.tier)}<span class="dot">•</span>${percentileHTML(a.percentile)}</div>
        <div class="ep-big">${fmt(a.total)} XP</div>
        ${occ.length > 1 ? `<p class="repeat-note">Rolled ${occ.length}× in your history: ${occ.map(i => `<a href="javascript:void 0" data-roll="${i}">#${fmt(i + 1)}</a>`).join(', ')}</p>` : ''}
        <div class="result-actions"><button class="btn" data-share>${shareIcon()} Share</button></div>
        ${breakdownHTML(r[0], a)}
      </div>`, m => {
      m.querySelector('[data-share]').addEventListener('click', () => share(a));
      animateDigits(m, { stagger: 120 });
    });
  }

  function openBadgeModal(id) {
    const b = Engine.byId.get(id);
    if (!b) return;
    Collection.ensure();
    const e = Collection.badges.get(id);
    const odds = window.BADGE_ODDS[id];
    const holders = [];
    if (e) {
      for (let i = Store.rolls.length - 1; i >= 0 && holders.length < 40; i--) {
        if (analysis(Store.rolls[i][0]).earnedIds.includes(id)) holders.push(i);
      }
    }
    const family = b.family ? Engine.badges.filter(x => x.family === b.family).sort((x, y) => y.score - x.score) : [];
    openModal(`
      <div style="text-align:center">
        <div style="font-size:2.6rem;line-height:1.2">${b.emoji}</div>
        <h2 style="margin:.35rem 0 .5rem">${esc(b.label)}</h2>
        <div class="pill-row">${tierPill(b.tier)}<span class="ep-pill">+${fmt(b.score)} XP</span></div>
        <p class="badge-desc" style="font-size:.74rem;margin:.8rem 0 1rem">${esc(b.desc)}</p>
        ${b.custom ? '<p class="panel-note" style="margin:-.4rem 0 1rem">Custom badge — not in the original game</p>' : ''}
      </div>
      <div class="kv"><span class="k">Odds</span><span class="v">${oneIn(odds)} · ${pctStr(odds)}</span></div>
      <div class="kv"><span class="k">You earned it</span><span class="v">${e ? plural(e.count, 'time') : 'Not yet'}</span></div>
      ${e ? `<div class="kv"><span class="k">First found</span><span class="v"><a href="javascript:void 0" data-roll="${e.first}">${Store.rolls[e.first][0]}</a> · ${relTime(Store.rolls[e.first][2])}</span></div>` : ''}
      ${family.length > 1 ? `
        <div class="kv"><span class="k">Family</span><span class="v" style="font-family:var(--font-sans);font-weight:500;text-align:right;line-height:1.7">
          ${family.map(f => `<span class="badge-pill" data-tier="${f.tier}" data-badge="${f.id}" style="cursor:pointer;${f.id === id ? 'font-weight:700' : ''}">${f.emoji} ${esc(f.label)}</span>`).join(' ')}
        </span></div>
        <p class="panel-note" style="margin:.2rem 0 0">Only the highest-scoring badge of a family counts toward XP; the others show as “earned”.</p>` : ''}
      ${holders.length ? `<div class="eyebrow" style="margin:1.1rem 0 .6rem">Your rolls with this badge${e.count > holders.length ? ` (latest ${holders.length})` : ''}</div>
        <div class="pill-row" style="justify-content:flex-start">${holders.map(i => `<button class="num-card sm" data-tier="${Engine.cardTier(Store.rolls[i][1])}" data-roll="${i}">${Store.rolls[i][0]}</button>`).join('')}</div>` : ''}
    `);
  }

  function openSettings() {
    const s = Store.settings;
    const seg = (name, options, value, labels = {}) => `<div class="seg" data-seg="${name}">${options.map(o => `<button data-v="${o}" class="${o === value ? 'on' : ''}">${labels[o] || o}</button>`).join('')}</div>`;
    openModal(`
      <h2>Player & settings</h2>
      <div class="field">
        <label for="set-name">Player name</label>
        <input class="input" id="set-name" maxlength="20" autocomplete="off" value="${esc(Store.player.name)}" placeholder="Player">
        <p class="field-error" id="set-name-error" hidden></p>
        <span class="panel-note">Shown on the leaderboard. Each name belongs to one player only.</span>
      </div>
      ${Store.player.name ? `<div class="field"><a class="btn" href="${profileHref(Store.player.name)}" id="set-profile">My profile</a></div>` : ''}
      ${googleAccountHTML()}
      <div class="field"><label>Roll animation</label>${seg('speed', ['dramatic', 'normal'], SPEEDS[s.speed] ? s.speed : 'normal', SPEED_LABELS)}</div>
      <div class="field"><label>Sound</label>${seg('sound', ['on', 'off'], soundOn() ? 'on' : 'off')}</div>
      <div class="field"><label>Theme</label>${seg('theme', ['light', 'system', 'dark'], s.theme)}</div>
      <div class="danger-zone">
        <button class="btn" id="set-export">Export history</button>
        <button class="btn" id="set-import">Import</button>
        <button class="btn danger" id="set-clear">Clear history</button>
        <input type="file" id="set-file" accept="application/json,.json" hidden>
      </div>
      <div class="actions"><button class="btn" id="set-done">Done</button></div>
    `, m => {
      // Le nom n'est enregistré qu'une fois validé par le serveur (Entrée ou sortie du champ).
      const name = m.querySelector('#set-name');
      const nameError = m.querySelector('#set-name-error');
      name.addEventListener('change', async () => {
        const previous = Store.player.name;
        if (!name.value.trim() || name.value.trim() === previous) { name.value = previous; return; }
        const result = await saveName(name.value);
        if (result.ok) {
          nameError.hidden = true;
          toast('Name saved');
          return;
        }
        name.value = previous;
        nameError.textContent = result.error;
        nameError.hidden = false;
        if (!name.isConnected) toast(result.error);
      });
      const googleSlot = m.querySelector('#google-btn');
      if (googleSlot) renderGoogleButton(googleSlot);
      const googleOut = m.querySelector('#google-out');
      if (googleOut) googleOut.addEventListener('click', signOutGoogle);
      m.querySelectorAll('[data-seg]').forEach(group => {
        group.addEventListener('click', e => {
          const btn = e.target.closest('button');
          if (!btn) return;
          group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
          Store.setSetting(group.dataset.seg, btn.dataset.v);
          if (group.dataset.seg === 'theme') applyTheme();
          if (group.dataset.seg === 'sound') applySound(true);
        });
      });
      m.querySelector('#set-done').addEventListener('click', closeModal);
      m.querySelector('#set-export').addEventListener('click', exportHistory);
      const file = m.querySelector('#set-file');
      m.querySelector('#set-import').addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files[0];
        if (!f) return;
        try {
          const added = Store.importJSON(await f.text(), n => analysis(n).total);
          Collection.built = false;
          toast(`Imported ${plural(added, 'roll')}`);
          closeModal();
          route();
        } catch (err) {
          toast('That file is not a valid RNG∞ export.');
        }
      });
      m.querySelector('#set-clear').addEventListener('click', () => {
        const k = Store.rolls.length;
        if (!k) { toast('History is already empty.'); return; }
        if (!confirm(`Delete all ${fmt(k)} rolls from this device? Export first if you want to keep them.`)) return;
        Store.clearRolls();
        Collection.built = false;
        closeModal();
        toast('History cleared');
        route();
      });
    });
  }

  function exportHistory() {
    const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rng-infinite-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const shareIcon = () => '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>';

  // ---------------------------------------------------------------- accueil
  function renderHome() {
    currentView = 'home';
    const rolls = Store.rolls;
    const best = bestRollIndex();
    const name = Store.player.name;
    const recent = rolls.slice(-12).map((r, k) => ({ r, i: rolls.length - Math.min(12, rolls.length) + k })).reverse();
    app.innerHTML = `
      <div class="page">
        <section class="hero">
          <div class="qmarks" aria-hidden="true">${'??????'.split('').map(c => `<span>${c}</span>`).join('')}</div>
          <p class="tagline">Infinite rolls. One number at a time. What will yours be?</p>
          <button class="btn-roll" id="roll-btn">Generate</button>
          <p class="hint">
            ${rolls.length ? `${plural(rolls.length, 'roll')} · ${fmt(lifetimeEP())} lifetime XP · ` : ''}
            ${name ? `playing as <b>${esc(name)}</b> · ` : '<a href="javascript:void 0" id="pick-name">pick a name</a> · '}
            press <kbd>Space</kbd>
          </p>
          <button class="btn ghost trailer-btn" data-trailer>${playIcon()} Watch the trailer</button>
          <div id="quests-slot"></div>
          <div id="today-slot"></div>
          <div class="duel-entry">
            <div class="eyebrow">⚔️ Live duel with a friend</div>
            <div class="duel-entry-row">
              <a class="btn" href="#/duel">Create a duel</a>
              <form class="duel-join" id="room-join-form">
                <input class="input mono" id="room-code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Duel code">
                <button class="btn" type="submit">Join</button>
              </form>
            </div>
          </div>
          ${best >= 0 ? featureCardHTML(best) : ''}
          ${recent.length > 1 ? `
            <div class="recent-strip">
              <div class="eyebrow">Recent rolls</div>
              <div class="chips">${recent.map(({ r, i }) => `<button class="num-card sm" data-tier="${Engine.cardTier(r[1])}" data-roll="${i}">${r[0]}</button>`).join('')}</div>
            </div>` : ''}
          <p class="credit">Based on <a href="https://www.rngdle.com" target="_blank" rel="noopener">rngdle.com</a>, without the daily limit</p>
        </section>
      </div>`;
    $('#roll-btn').addEventListener('click', startRoll);
    const pick = $('#pick-name');
    if (pick) pick.addEventListener('click', openSettings);
    loadTodayCard($('#today-slot'));
    loadQuests($('#quests-slot'));
    $('#room-join-form').addEventListener('submit', e => { e.preventDefault(); joinRoom($('#room-code').value); });
  }

  // ---------------------------------------------------------------- quêtes du jour et bonus quotidien (accueil)
  // 3 quêtes par jour, les mêmes pour tous ; la progression et les récompenses viennent du serveur.
  async function loadQuests(slot, state) {
    if (!slot || !Store.player.name) return;
    if (!state) {
      try { state = await Online.quests(); } catch (err) { return; }
      if (!slot.isConnected) return;
    }
    const left = Math.max(0, state.resetAt - Date.now());
    const resetIn = left > 3600000 ? `${Math.floor(left / 3600000)} h` : `${Math.max(1, Math.ceil(left / 60000))} min`;
    const d = state.daily;
    slot.innerHTML = `
      <div class="quests-card">
        <div class="quests-head"><span class="eyebrow">Daily quests</span><span class="coins mono">🪙 ${fmt(state.coins)}</span></div>
        <div class="quest daily${d.claimed ? ' done' : ''}">
          <span class="quest-emoji">🔥</span>
          <span class="quest-text"><b>Daily bonus</b><span class="panel-note">${d.streak ? `${plural(d.streak, 'day')} streak` : 'Start a streak'}${d.claimed ? ` · tomorrow: ${d.next} coins` : ''}</span></span>
          ${d.claimed ? '<span class="quest-state">✓ Claimed</span>' : `<button class="btn-roll small" data-daily>+${d.reward} 🪙</button>`}
        </div>
        ${state.quests.map(q => {
          const done = q.progress >= q.target;
          return `
          <div class="quest${q.claimed ? ' done' : ''}">
            <span class="quest-emoji">${q.emoji}</span>
            <span class="quest-text"><b>${esc(q.text)}</b>
              <span class="quest-bar"><span style="width:${Math.min(100, (q.progress / q.target) * 100)}%"></span></span>
              <span class="panel-note">${q.target >= 1000 ? `${compact(q.progress)} / ${compact(q.target)}` : `${q.progress} / ${q.target}`}</span></span>
            ${q.claimed ? '<span class="quest-state">✓ Claimed</span>' : done ? `<button class="btn-roll small" data-quest="${q.id}">+${q.reward} 🪙</button>` : `<span class="quest-reward mono">${q.reward} 🪙</span>`}
          </div>`;
        }).join('')}
        <p class="panel-note quests-foot">New quests in ${resetIn} · coins buy skins and cases in the <a href="#/shop">Shop</a></p>
      </div>`;
    slot.onclick = async e => {
      const btn = e.target.closest('[data-quest], [data-daily]');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      try {
        const next = await Online.questAction(btn.dataset.quest ? 'claim' : 'daily', btn.dataset.quest);
        toast(`🪙 +${next.gained} coins${btn.dataset.quest ? '' : ` · ${plural(next.daily.streak, 'day')} streak`}`, 2600, 'achv');
        Sound.play('lock', { i: 5 });
        loadQuests(slot, next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Quests unavailable right now, try again');
      }
    };
  }

  function featureCardHTML(i) {
    const r = Store.rolls[i];
    const a = analysis(r[0]);
    const pills = a.groups.slice(0, 7).map(g => `<span class="badge-pill" data-tier="${g.badge.tier}">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join('');
    const more = a.earnedIds.length - Math.min(7, a.groups.length);
    return `
      <div class="feature-card" data-tier="${a.tier}" data-roll="${i}" style="cursor:pointer">
        <div class="eyebrow">Your best roll</div>
        <span class="num-card md" data-tier="${a.tier}">${a.str}</span>
        <div class="feature-meta">roll #${fmt(i + 1)} · ${relTime(r[2])}</div>
        <div class="pill-row">${pills}${more > 0 ? `<span class="more">+${more} more</span>` : ''}</div>
        <div class="ep-big" style="display:inline-block;font-size:.85rem">${fmt(a.total)} XP</div>
      </div>`;
  }

  // ---------------------------------------------------------------- tirage
  // Réserve le nom sur le serveur (un nom = un seul joueur). Serveur injoignable : on le garde localement,
  // le serveur tranchera au prochain tirage.
  async function saveName(raw) {
    const name = String(raw).trim().replace(/\s+/g, ' ').slice(0, 20);
    // Même règle que le serveur : alphabet latin (accents compris), chiffres, espaces et _ . - ' (pas de sosie en cyrillique).
    if (!/^[\p{Script=Latin}0-9 _.\-']+$/u.test(name)) return { ok: false, error: "Use letters, digits, spaces and _ . - ' only." };
    try {
      const data = await Online.claimName(name);
      Store.setPlayerName(data.name || name);
      return { ok: true };
    } catch (err) {
      if (err.status === 409) {
        const hint = googleEnabled() && !Store.player.google ? ', or sign in with Google if it is yours' : '';
        return { ok: false, error: `"${name}" is already taken. Pick another name${hint}.` };
      }
      if (err.status === 400) return { ok: false, error: 'That name is not valid.' };
      Store.setPlayerName(name);
      return { ok: true };
    }
  }

  function askName(then, suggested = '', error = '') {
    const offerGoogle = googleEnabled() && !Store.player.google;
    openModal(`
      <h2>Choose your player name</h2>
      <p class="panel-note" style="margin:-.3rem 0 1rem">It appears on the leaderboard next to your best rolls. Each name belongs to one player only.</p>
      <form id="name-form">
        <input class="input" id="name-input" maxlength="20" autocomplete="off" placeholder="Your name" value="${esc(suggested)}" style="width:100%">
        <p class="field-error" id="name-error"${error ? '' : ' hidden'}>${esc(error)}</p>
        <div class="actions"><button class="btn-roll small" type="submit">Save & roll</button></div>
      </form>
      ${offerGoogle ? '<div class="or-google"><span class="panel-note">or sign in to keep your player on every device</span><div id="google-btn" class="google-btn"></div></div>' : ''}`, m => {
      const input = m.querySelector('#name-input');
      const errorEl = m.querySelector('#name-error');
      const submit = m.querySelector('#name-form button');
      input.focus();
      m.querySelector('#name-form').addEventListener('submit', async e => {
        e.preventDefault();
        if (!input.value.trim()) { input.focus(); return; }
        submit.disabled = true;
        const result = await saveName(input.value);
        submit.disabled = false;
        if (!result.ok) {
          errorEl.textContent = result.error;
          errorEl.hidden = false;
          input.focus();
          return;
        }
        afterGoogle = null;
        closeModal();
        then();
      });
      if (offerGoogle) {
        afterGoogle = then;
        renderGoogleButton(m.querySelector('#google-btn'));
      }
    });
  }

  // ---------------------------------------------------------------- connexion Google (Google Identity Services)
  // Le compte Google sert d'identité de joueur : le serveur vérifie le jeton et renvoie le même joueur sur chaque appareil.
  const googleEnabled = () => !!window.RNG_CONFIG.googleClientId;
  let googleReady = null;
  let afterGoogle = null; // action à reprendre après la connexion (ex. le tirage qui attendait un nom)

  function loadGoogle() {
    if (!googleReady) {
      googleReady = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = () => {
          google.accounts.id.initialize({ client_id: window.RNG_CONFIG.googleClientId, callback: onGoogleCredential, auto_select: false });
          resolve(google.accounts.id);
        };
        script.onerror = () => { googleReady = null; reject(new Error('Google sign-in could not load')); };
        document.head.appendChild(script);
      });
    }
    return googleReady;
  }

  async function renderGoogleButton(slot) {
    try {
      const gid = await loadGoogle();
      if (!slot.isConnected) return;
      const dark = document.documentElement.classList.contains('dark');
      gid.renderButton(slot, { theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 260 });
    } catch (err) {
      slot.innerHTML = '<span class="panel-note">Google sign-in is unavailable right now.</span>';
    }
  }

  async function onGoogleCredential(response) {
    try {
      const p = Store.player;
      const data = await Online.request('/api/auth', {
        method: 'POST',
        body: JSON.stringify({ credential: response.credential, playerId: p.id, secret: p.secret }),
      });
      Store.setIdentity({ id: data.playerId, secret: data.secret, google: { email: data.email } });
      if (data.name) Store.setPlayerName(data.name);
      closeModal();
      const restored = await syncHistory().catch(() => 0);
      toast(`Signed in as ${data.email || 'your Google account'}${restored ? ` · ${plural(restored, 'roll')} restored` : ''}`);
      const next = afterGoogle;
      afterGoogle = null;
      if (!Store.player.name) askName(next || (() => {}), (data.givenName || '').slice(0, 20));
      else if (next) next();
      else if (currentView !== 'result') route();
    } catch (err) {
      toast('Google sign-in failed, try again');
    }
  }

  // Synchronise l'historique avec le serveur, dans les deux sens : récupère les tirages faits sur d'autres appareils
  // (compte Google), puis envoie ceux que seul cet appareil connaît. Les stats, badges et l'XP total en découlent.
  // Sans Google aussi : le profil public du joueur (clic sur son nom au classement) inclut ses tirages hors ligne.
  let syncing = null;
  function syncHistory() {
    if (!Store.player.google && !Store.player.name) return Promise.resolve(0);
    if (!syncing) {
      syncing = (async () => {
        try {
          const server = await Online.history();
          const onServer = Store.rollSet(server.rolls);
          const localOnly = Store.rolls.filter(r => !onServer.has(r[0], r[2])).map(r => [r[0], r[2]]);
          const added = Store.mergeRolls(server.rolls, n => Engine.scoreOf(n));
          for (let i = 0; i < localOnly.length; i += 2000) await Online.history(localOnly.slice(i, i + 2000), false);
          if (added) {
            Collection.built = false;
            if (currentView !== 'result' && !$('#modal-root').firstChild) route();
          }
          return added;
        } finally {
          syncing = null;
        }
      })();
    }
    return syncing;
  }

  // Déconnexion : l'historique n'est retiré de cet appareil qu'une fois chaque tirage confirmé sur le compte.
  async function signOutGoogle() {
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    closeModal();
    try {
      await syncHistory();
      const server = await Online.history();
      const onServer = Store.rollSet(server.rolls);
      // Le serveur n'accepte plus les tirages faits hors ligne (anti-triche) : on prévient avant de les retirer d'ici.
      const localOnly = Store.rolls.filter(r => !onServer.has(r[0], r[2])).length;
      if (localOnly && !confirm(`${plural(localOnly, 'roll')} on this device could not be saved to your account (made offline). Sign out anyway and remove ${localOnly === 1 ? 'it' : 'them'} from this device?`)) return;
    } catch (err) {
      toast('Could not reach your account, try signing out again');
      return;
    }
    Store.clearRolls();
    Collection.built = false;
    Store.signOut();
    toast('Signed out: your history is saved in your Google account');
    route();
  }

  function googleAccountHTML() {
    if (!googleEnabled()) return '';
    const g = Store.player.google;
    return g
      ? `<div class="field"><label>Account</label>
          <div class="google-row"><span>Signed in with Google as <b>${esc(g.email || 'your account')}</b></span><button class="btn" id="google-out">Sign out</button></div>
          <span class="panel-note">Your player, leaderboard spots and whole roll history (stats, badges) follow you on every device.</span></div>`
      : `<div class="field"><label>Account</label>
          <div id="google-btn" class="google-btn"></div>
          <span class="panel-note">Sign in to keep the same player, your leaderboard spots and your whole roll history (stats, badges) on every device.</span></div>`;
  }

  // Détail d'un nombre tiré par quelqu'un d'autre (classement, meilleur tirage du jour).
  function openNumberModal(n, caption) {
    const a = analysis(n);
    openModal(`
      <div class="result" data-tier="${a.tier}" style="padding-top:.2rem">
        ${caption ? `<div class="eyebrow">${esc(caption)}</div>` : ''}
        <div style="margin-top:.9rem"><span class="num-card lg" data-tier="${a.tier}">${a.str}</span></div>
        <div class="result-meta">${tierPill(a.tier)}<span class="dot">•</span>${percentileHTML(a.percentile)}</div>
        <div class="ep-big">${fmt(a.total)} XP</div>
        ${breakdownHTML(n, a)}
      </div>`, m => animateDigits(m, { stagger: 120 }));
  }

  function todayCardHTML(entry, rollsToday) {
    const a = analysis(entry.n);
    const pills = a.groups.slice(0, 7).map(g => `<span class="badge-pill" data-tier="${g.badge.tier}">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join('');
    const more = a.earnedIds.length - Math.min(7, a.groups.length);
    return `
      <div class="feature-card" id="today-card" data-tier="${a.tier}" data-number="${entry.n}" data-caption="${esc(`Today's best · ${entry.name}`)}" style="cursor:pointer">
        <div class="eyebrow">Today's best roll</div>
        <span class="num-card md" data-tier="${a.tier}">${a.str}</span>
        <div class="feature-meta">rolled by <a class="player-link" href="${profileHref(entry.name)}">${esc(entry.name)}</a>${entry.me ? ' (you)' : ''} ${titleHTML(entry.title)}</div>
        <div class="pill-row">${pills}${more > 0 ? `<span class="more">+${more} more</span>` : ''}</div>
        <div class="ep-big" style="display:inline-block;font-size:.85rem">${fmt(entry.s)} XP</div>
        <div class="feature-meta" style="margin-bottom:0">${plural(rollsToday, 'roll')} today</div>
      </div>`;
  }

  // Remplit la carte "Today's best roll" ; si le serveur est injoignable, la carte disparaît sans bruit.
  async function loadTodayCard(slot) {
    try {
      const data = await Online.leaderboard('day');
      if (!slot.isConnected) return;
      slot.innerHTML = data.entries.length
        ? todayCardHTML(data.entries[0], data.rollsToday)
        : '<div class="feature-card"><div class="eyebrow">Today\'s best roll</div><p class="feature-meta">No rolls yet today — be the first!</p></div>';
    } catch (err) {
      slot.innerHTML = '';
    }
  }

  // Le nombre est tiré par le serveur, ce qui le fait compter au classement. Si le serveur ne répond pas,
  // on tire en local : le tirage reste dans l'historique mais pas au classement.
  // Rien ne se saute : pendant la révélation, Espace est ignoré ; une fois la rareté affichée, il relance.
  let rollPending = false;
  async function startRoll(force) {
    if (rollPending) return;
    if (session && !session.finished && force !== true && !session.canReroll) return;
    if (!Store.player.name) { askName(() => startRoll(force)); return; }
    rollPending = true;
    const buttons = Array.from(document.querySelectorAll('#roll-btn, #r-again'));
    buttons.forEach(b => { b.disabled = true; });
    let n, online = null;
    const asked = Online.roll();
    Sound.play('click'); // après l'envoi de la demande : au tout premier tirage, ouvrir la sortie audio bloque la page ~0,1 s
    try {
      online = await asked;
      n = online.n;
    } catch (err) {
      if (err.status === 409) {
        rollPending = false;
        buttons.forEach(b => { b.disabled = false; });
        askName(() => startRoll(force), '', `"${Store.player.name}" is already taken by another player. Pick a new name.`);
        return;
      }
      const wasGoogle = !!Store.player.google;
      if (err.status === 403) {
        if (wasGoogle) Store.signOut(); else Store.resetIdentity();
      }
      if (err.status === 429 || err.status === 403) {
        rollPending = false;
        buttons.forEach(b => { b.disabled = false; });
        toast(err.status === 429 ? 'Wait for the reveal to finish'
          : wasGoogle ? 'Session expired: sign in with Google again to get your player back' : 'Player id reset, roll again');
        return;
      }
      n = Engine.roll();
      toast('Leaderboard offline: this roll stays on your device only');
    }
    rollPending = false;
    if (session && !session.finished) session.cancel();
    closeModal();
    Collection.ensure();
    const a = analysis(n);
    const previous = (Collection.seen.get(n) || []).slice();
    const newIds = new Set(a.earnedIds.filter(id => !Collection.badges.has(id)));
    const isFirst = Store.rolls.length === 0;
    const lifetimeBefore = lifetimeEP();
    // Le tirage est enregistré avant l'animation : quitter la page ne permet pas de relancer.
    const { saved } = Store.addRoll(n, a.total, online ? online.t : Date.now());
    const index = Store.rolls.length - 1;
    Collection.add(Store.rolls[index], index);
    if (!saved) toast('Could not save — storage is full. Export your history from the player menu.');
    session = playReveal({ n, a, previous, newIds: isFirst ? null : newIds, isFirst, lifetimeBefore, index, online });
  }

  function notesHTML(ctx, a) {
    const notes = [];
    if (ctx.isFirst) notes.push('<p class="new-note">First roll on this device — welcome!</p>');
    if (ctx.newIds && ctx.newIds.size) {
      const list = [...ctx.newIds].map(id => Engine.byId.get(id)).sort((x, y) => y.score - x.score);
      notes.push(`<p class="new-note">✨ ${plural(list.length, 'new badge')}: ${list.slice(0, 4).map(b => `${b.emoji} ${esc(b.label)}`).join(', ')}${list.length > 4 ? '…' : ''}</p>`);
    }
    if (ctx.previous.length) {
      const lastIdx = ctx.previous[ctx.previous.length - 1];
      notes.push(`<p class="repeat-note">You've rolled <b class="mono">${a.str}</b> before — ${ctx.previous.length}× (last ${relTime(Store.rolls[lastIdx][2])}, <a href="javascript:void 0" data-roll="${lastIdx}">#${fmt(lastIdx + 1)}</a>)</p>`);
    }
    if (!ctx.online) notes.push('<p class="repeat-note">Offline roll: not on the leaderboard</p>');
    else if (ctx.online.bestToday) notes.push(`<p class="new-note">🏆 Your best roll today: #${ctx.online.dayRank} on <a href="#/leaderboard">today's leaderboard</a></p>`);
    return notes.join('');
  }

  // Révélation en étapes chronométrées, comme l'original :
  // chiffres → badges un par un (XP qui monte) → compteur de badges → rareté → TOP x % → XP à vie.
  // Rien ne peut être sauté ; le menu reste verrouillé jusqu'à l'affichage de la rareté.
  function playReveal(ctx) {
    currentView = 'result';
    const { n, a } = ctx;
    const speed = SPEEDS[Store.settings.speed] || SPEEDS.normal;
    const k = speed.base, kb = speed.badges;
    const slotCount = Math.max(6, a.str.length);
    const padded = a.str.padStart(slotCount, '0');
    const lead = slotCount - a.str.length;
    const ascending = a.groups.slice().reverse();
    // Skin Owner (réservé au créateur, équipé depuis la boutique) : chiffres en rubis et signature en béryl rouge.
    const owner = Shop.resolve(Store.settings.skin) === 'owner';

    app.innerHTML = `
      <div class="vignette" id="r-vignette"></div>
      <div class="page">
        <section class="result" data-tier="${a.tier}">
          <div class="card-stage" id="card-stage"><div class="rays" aria-hidden="true"></div>
          <div class="num-card lg neutral charging${skinClass(Store.settings.skin)}" id="num-card">
            ${Array.from({ length: slotCount }, () => '<span class="slot spinning">0</span>').join('')}
          </div>${Shop.resolve(Store.settings.skin) === 'slots' ? LEVER : ''}</div>
          <div class="result-meta invisible" id="r-meta">${tierPill(a.tier)}<span class="dot">•</span>${percentileHTML(a.percentile)}</div>
          <div class="ep-big pending" id="r-ep">??? XP</div>
          <div class="lifetime invisible" id="r-life">
            <div class="lifetime-row"><span class="v" id="r-life-v">${fmt(ctx.lifetimeBefore)}</span><span class="delta" id="r-life-delta" hidden>+${fmt(a.total)}</span></div>
            <div class="l">Your lifetime XP</div>
          </div>
          <div class="result-actions invisible" id="r-actions">
            <button class="btn" id="r-share">${shareIcon()} Share</button>
            <button class="btn-roll small" id="r-again">Roll again</button>
          </div>
          <p class="hint invisible" id="r-hint"></p>
          <div id="r-notes" style="text-align:center"></div>
          <section class="breakdown" id="r-breakdown" hidden>
            <h2 class="section-title">Badge breakdown</h2>
            <div class="section-sub invisible" id="r-count">${plural(a.earnedIds.length, 'badge')} earned</div>
            <div class="list" id="r-list"></div>
          </section>
        </section>
      </div>`;

    const card = $('#num-card');
    const slots = Array.from(card.querySelectorAll('.slot'));
    const ep = $('#r-ep');
    const vignette = $('#r-vignette');
    const steps = [];
    const timers = [];
    let clock = 0, revealed = 0, running = 0, finished = false, canReroll = false;
    const step = (delay, run, factor = k) => { clock += delay * factor; steps.push({ at: clock, run, done: false }); };
    const show = (el, cls) => { el.classList.remove('invisible'); if (cls && !reducedMotion) el.classList.add(cls); };
    // Sons : une étape en retard (onglet endormi puis réveillé, tout tombe d'un coup) se joue sans le sien.
    const began = performance.now(), lastWait = digitDelay(slotCount - 2, slotCount);
    let late = false, lastFrom = 0;
    const sfx = (type, o) => { if (!late) Sound.play(type, o); };
    Sound.warm([['tier', { tier: a.tier }]]);
    // La scène du skin : particules et lumière dans la carte et autour, calées sur les mêmes instants.
    const skinFx = SkinFX.mount($('#card-stage'), card, owner ? '' : Shop.resolve(Store.settings.skin), { owner });

    const spin = setInterval(() => {
      for (let i = revealed; i < slotCount; i++) slots[i].textContent = spinChar(card);
      // Cliquetis des rouleaux ; sur le dernier, il devient de plus en plus grave et fort jusqu'au chiffre.
      if (revealed < slotCount) Sound.tick(revealed === slotCount - 1 ? { last: Math.min(8, 1 + Math.floor((8 * (performance.now() - lastFrom)) / lastWait)) } : {});
    }, 55);
    requestAnimationFrame(() => vignette.classList.add('on'));
    // Menu verrouillé pendant la révélation : on ne peut pas aller voir le résultat ailleurs avant la fin.
    document.body.classList.add('locked');

    // 1. Chiffres de gauche à droite, chacun un peu plus lent que le précédent.
    const revealDigit = i => () => {
      const el = slots[i];
      el.textContent = padded[i];
      el.classList.remove('spinning');
      el.classList.add('revealed');
      if (i < lead) el.classList.add('ghost');
      revealed = i + 1;
      if (revealed === slotCount - 1) lastFrom = performance.now();
      // Une note par chiffre, en montant la gamme ; plus discrète pour un zéro de tête, plus appuyée pour le dernier.
      sfx('lock', i < lead ? { i, soft: 1 } : i === slotCount - 1 ? { i, final: 1 } : { i });
      if (skinFx) skinFx.lock(el, { ghost: i < lead, last: i === slotCount - 1 });
      replay($('#card-stage'), 'thump'); // sur le conteneur : la carte garde ses propres animations (lueur, tremblement)
    };
    step(REVEAL.digitStart, revealDigit(0), 1);
    for (let i = 1; i < slotCount; i++) step(digitDelay(i - 1, slotCount), revealDigit(i), 1);
    steps.push({ at: clock - Sound.LEAD, run: () => { sfx('riser'); if (skinFx) skinFx.build(Sound.LEAD); }, done: false }); // montée de tension, coupée juste avant le dernier chiffre
    step(0, quick => {
      clearInterval(spin);
      card.classList.remove('charging');
      if (!lead) return;
      const collapse = () => slots.slice(0, lead).forEach(el => el.classList.add('collapsed'));
      if (quick) collapse(); else setTimeout(collapse, 260);
    });

    // 2. Badges un par un, du moins rare au plus rare : chacun s'insère en haut et fait monter l'XP.
    ascending.forEach((g, i) => {
      step(i === 0 ? REVEAL.badgeStart : badgeDelay(i - 1, ascending.length), quick => {
        $('#r-breakdown').hidden = false;
        $('#r-list').insertAdjacentHTML('afterbegin', badgeCardHTML(g, n, { newIds: ctx.newIds, animate: !quick && !reducedMotion, delay: 0 }));
        animateDigits($('#r-list'), { start: reducedMotion ? 0 : 450 });
        const from = running;
        running += g.badge.score;
        countUp(ep, from, running, quick ? 0 : REVEAL.badgeEp * kb, v => `${fmt(v)} XP`);
        if (!late) Sound.badge(i, ascending.length);
      }, kb);
    });

    // 3. Résumé, rareté, TOP x %, XP à vie.
    step(REVEAL.summary, () => {
      show($('#r-count'), 'fade-in');
      $('#r-notes').innerHTML = notesHTML(ctx, a);
    });
    step(REVEAL.rarity, () => {
      card.classList.remove('neutral');
      card.removeAttribute('title');
      if (!reducedMotion) card.classList.add(a.tier === 'anomaly' || a.tier === 'mythic' ? 'shake' : 'reveal-pulse');
      ep.classList.remove('pending');
      countUp(ep, 0, a.total, 0, v => `${fmt(v)} XP`);
      replay(ep, 'glint');
      FX.celebrate(a.tier, card);
      shockwave(card, a.tier);
      sfx('tier', { tier: a.tier });
      if (skinFx) skinFx.reveal(a.tier);
      if (TIER_RANK[a.tier] >= TIER_RANK.epic) $('#card-stage').classList.add('lit'); // rayons derrière la carte
      show($('#r-actions'), 'fade-in');
      $('#r-hint').innerHTML = '<kbd>Space</kbd> to roll again · click a badge name for details';
      show($('#r-hint'), 'fade-in');
      document.body.classList.remove('locked');
      canReroll = true;
      if (ctx.online) noteAchievements(ctx.online.achievements);
    });
    step(REVEAL.stats, () => show($('#r-meta'), 'pop-in'));
    step(REVEAL.lifetimeShow, () => show($('#r-life'), 'fade-in'));
    step(REVEAL.lifetimePause, quick => {
      const delta = $('#r-life-delta');
      delta.hidden = false;
      if (!quick && !reducedMotion) delta.classList.add('float-up');
      countUp($('#r-life-v'), ctx.lifetimeBefore, ctx.lifetimeBefore + a.total, quick ? 0 : REVEAL.lifetimeTick * k, fmt);
    });
    step(REVEAL.lifetimeTick + REVEAL.end, () => {
      vignette.classList.remove('on');
      finished = true;
    });

    const runStep = s => { if (!s.done) { s.done = true; late = performance.now() - began - s.at > 250; s.run(false); } };
    $('#r-share').addEventListener('click', () => share(a));
    $('#r-again').addEventListener('click', () => startRoll(true));

    steps.forEach(s => timers.push(setTimeout(() => runStep(s, false), s.at)));

    return {
      get finished() { return finished; },
      get canReroll() { return canReroll; },
      cancel() { timers.forEach(clearTimeout); clearInterval(spin); finished = true; document.body.classList.remove('locked'); Sound.stop(); if (skinFx) skinFx.stop(); },
    };
  }

  // ---------------------------------------------------------------- historique
  const histState = { q: '', tier: 'all', sort: 'new', limit: 100 };

  function emptyStateHTML() {
    return `<div class="panel empty"><div style="font-size:2rem">🎲</div><p>No rolls yet.</p><a class="btn" href="#/">Go roll</a></div>`;
  }

  function renderHistory() {
    currentView = 'history';
    const total = Store.rolls.length;
    if (!total) {
      app.innerHTML = `<div class="page"><h1 class="page-title">Roll history</h1>${emptyStateHTML()}</div>`;
      return;
    }
    Collection.ensure();
    const tierOptions = [['all', 'All rarities'], ['rare+', 'Rare or better'], ...TIERS_DESC.map(t => [t, cap(t)])];
    const sortOptions = [['new', 'Newest first'], ['old', 'Oldest first'], ['high', 'Highest XP'], ['low', 'Lowest XP']];
    const options = (list, value) => list.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('');
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Roll history</h1>
        <div class="toolbar">
          <input class="input grow" id="h-q" type="search" placeholder="Search a number or a badge…" value="${esc(histState.q)}">
          <select class="select" id="h-tier" aria-label="Rarity">${options(tierOptions, histState.tier)}</select>
          <select class="select" id="h-sort" aria-label="Sort">${options(sortOptions, histState.sort)}</select>
        </div>
        <div class="count-line" id="h-count"></div>
        <div class="table-card" id="h-list"></div>
      </div>`;
    const redraw = () => { histState.limit = 100; drawHistoryList(); };
    $('#h-q').addEventListener('input', e => { histState.q = e.target.value; redraw(); });
    $('#h-tier').addEventListener('change', e => { histState.tier = e.target.value; redraw(); });
    $('#h-sort').addEventListener('change', e => { histState.sort = e.target.value; redraw(); });
    drawHistoryList();
  }

  function filteredRolls() {
    let items = Store.rolls.map((r, i) => ({ n: r[0], s: r[1], t: r[2], i, tier: Engine.cardTier(r[1]) }));
    if (histState.tier === 'rare+') items = items.filter(x => TIER_RANK[x.tier] >= 3);
    else if (histState.tier !== 'all') items = items.filter(x => x.tier === histState.tier);
    const q = histState.q.trim().toLowerCase();
    if (q) {
      const digits = q.replace(/[\s,]/g, '');
      if (/^\d+$/.test(digits)) items = items.filter(x => String(x.n).includes(digits));
      else items = items.filter(x => analysis(x.n).earnedIds.some(id => LABELS.get(id).includes(q)));
    }
    const sorters = {
      new: (a, b) => b.i - a.i,
      old: (a, b) => a.i - b.i,
      high: (a, b) => b.s - a.s || b.i - a.i,
      low: (a, b) => a.s - b.s || b.i - a.i,
    };
    return items.sort(sorters[histState.sort]);
  }

  function drawHistoryList() {
    const rows = filteredRolls();
    const shown = rows.slice(0, histState.limit);
    $('#h-count').textContent = `${fmt(rows.length)} of ${plural(Store.rolls.length, 'roll')}`;
    $('#h-list').innerHTML = shown.length
      ? shown.map(rowHTML).join('') + (rows.length > shown.length
        ? `<div class="load-more"><button class="btn" id="h-more">Load more (${fmt(rows.length - shown.length)} left)</button></div>` : '')
      : '<div class="empty">No roll matches.</div>';
    const more = $('#h-more');
    if (more) more.addEventListener('click', () => { histState.limit += 100; drawHistoryList(); });
  }

  function rowHTML(x) {
    const a = analysis(x.n);
    const reps = (Collection.seen.get(x.n) || []).length;
    return `
      <div class="row" data-roll="${x.i}">
        <span class="idx">#${fmt(x.i + 1)}</span>
        <span><span class="num-card sm" data-tier="${x.tier}">${a.str}</span></span>
        <span class="mid">${tierPill(x.tier)}<span class="emojis">${a.groups.slice(0, 4).map(g => g.badge.emoji).join(' ')}</span>${reps > 1 ? `<span class="muted" style="font-size:.66rem" title="Rolled ${reps} times">×${reps}</span>` : ''}</span>
        <span class="right"><span class="ep-pill">${fmt(x.s)} XP</span><span class="when" title="${fullDate(x.t)}">${relTime(x.t)}</span></span>
      </div>`;
  }

  // ---------------------------------------------------------------- stats
  function computeStats() {
    const rolls = Store.rolls;
    const N = rolls.length;
    const scores = rolls.map(r => r[1]);
    const sorted = scores.slice().sort((a, b) => a - b);
    const tierCounts = Object.fromEntries(TIERS_DESC.map(t => [t, 0]));
    const digitCounts = new Array(10).fill(0);
    const buckets = new Array(10).fill(0);
    let pctSum = 0, digitTotal = 0;
    let sinceRare = null, sinceEpic = null, sinceMythic = null, dry = 0, longestDry = 0;
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    let today = 0;
    rolls.forEach((r, i) => {
      const tier = Engine.cardTier(r[1]);
      tierCounts[tier]++;
      pctSum += Engine.percentileOf(r[1]);
      const s = String(r[0]);
      for (let k = 0; k < s.length; k++) digitCounts[s.charCodeAt(k) - 48]++;
      digitTotal += s.length;
      buckets[Math.min(9, Math.floor(r[0] / 100000))]++;
      if (TIER_RANK[tier] >= 3) { sinceRare = i; dry = 0; } else { dry++; longestDry = Math.max(longestDry, dry); }
      if (TIER_RANK[tier] >= 4) sinceEpic = i;
      if (tier === 'mythic') sinceMythic = i;
      if (r[2] >= startOfDay) today++;
    });
    const since = i => (i === null ? 'never' : fmt(N - 1 - i));
    let rarest = null;
    for (const id of Collection.badges.keys()) {
      if (!rarest || window.BADGE_ODDS[id] < window.BADGE_ODDS[rarest]) rarest = id;
    }
    let repeats = 0;
    for (const list of Collection.seen.values()) if (list.length > 1) repeats++;
    return {
      N, today, tierCounts, digitCounts, digitTotal, buckets, rarest, repeats, longestDry,
      lifetime: scores.reduce((a, b) => a + b, 0),
      median: sorted[Math.floor((N - 1) / 2)],
      luck: pctSum / N,
      sinceRare: since(sinceRare), sinceEpic: since(sinceEpic), sinceMythic: since(sinceMythic),
      top: topRollIndices(10),
      first: rolls[0][2],
    };
  }

  function roundedTop(x, yTop, w, h, r) {
    if (h <= 0.5) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}Z`;
  }

  // Barres verticales mono-teinte + trait pointillé "attendu".
  function barChartSVG({ labels, values, expected, tickFormat, tips }) {
    const W = 360, H = 190, m = { l: 40, r: 6, t: 12, b: 24 };
    const plotW = W - m.l - m.r, plotH = H - m.t - m.b, base = m.t + plotH;
    const max = Math.max(...values, ...expected) * 1.15 || 1;
    const band = plotW / values.length, gap = Math.max(3, band * 0.3), bw = band - gap;
    const y = v => base - (v / max) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (let k = 0; k <= 3; k++) {
      const v = (max / 1.15) * (k / 3);
      svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--chart-grid)" stroke-width="1"/>`;
      svg += `<text x="${m.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${tickFormat(v)}</text>`;
    }
    values.forEach((v, i) => {
      const x0 = m.l + i * band;
      svg += `<rect class="hit" x="${x0}" y="${m.t}" width="${band}" height="${plotH + m.b}" data-tip="${esc(tips[i])}"/>`;
    });
    values.forEach((v, i) => {
      const x0 = m.l + i * band + gap / 2;
      svg += `<path class="mark" d="${roundedTop(x0, y(v), bw, base - y(v), 4)}" fill="var(--chart-accent)"/>`;
      const ey = y(expected[i]);
      svg += `<line class="mark" x1="${x0 - 2}" x2="${x0 + bw + 2}" y1="${ey}" y2="${ey}" stroke="var(--prose-2)" stroke-width="2" stroke-dasharray="3 2"/>`;
      svg += `<text class="lbl" x="${x0 + bw / 2}" y="${H - 7}" text-anchor="middle">${labels[i]}</text>`;
    });
    return svg + '</svg>';
  }

  // Nuage de points XP par tirage, échelle log.
  function epChartSVG() {
    const rolls = Store.rolls;
    const start = Math.max(0, rolls.length - 300);
    const pts = rolls.slice(start);
    const W = 680, H = 230, m = { l: 46, r: 14, t: 12, b: 24 };
    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const maxScore = Math.max(...pts.map(r => r[1]));
    const lo = 3, hi = Math.max(6, Math.ceil(Math.log10(maxScore)));
    const y = v => m.t + ((hi - Math.log10(Math.max(v, 1000))) / (hi - lo)) * plotH;
    const step = pts.length > 1 ? plotW / (pts.length - 1) : 0;
    const x = i => (pts.length > 1 ? m.l + i * step : m.l + plotW / 2);
    const LABEL = { 3: '1K', 4: '10K', 5: '100K', 6: '1M', 7: '10M', 8: '100M', 9: '1B' };
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (let e = lo; e <= hi; e++) {
      svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(10 ** e)}" y2="${y(10 ** e)}" stroke="var(--chart-grid)"/>`;
      svg += `<text x="${m.l - 7}" y="${y(10 ** e) + 3.5}" text-anchor="end">${LABEL[e]}</text>`;
    }
    const med = window.SCORE_STATS.median;
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(med)}" y2="${y(med)}" stroke="var(--prose-3)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    svg += `<text class="halo" x="${W - m.r}" y="${y(med) - 5}" text-anchor="end">typical roll · ${compact(med)} XP</text>`;
    const hitW = pts.length > 1 ? step : plotW;
    pts.forEach((r, i) => {
      const a = analysis(r[0]);
      const tipHtml = `<b>${a.str}</b> · roll #${fmt(start + i + 1)}<br>${fmt(r[1])} XP · ${a.tier.toUpperCase()}`;
      svg += `<rect class="hit" x="${x(i) - hitW / 2}" y="${m.t}" width="${hitW}" height="${plotH}" data-tip="${esc(tipHtml)}" data-roll="${start + i}" style="cursor:pointer"/>`;
    });
    pts.forEach((r, i) => {
      svg += `<circle class="mark" cx="${x(i)}" cy="${y(r[1])}" r="4" fill="var(--chart-accent)" stroke="var(--surface)" stroke-width="2"/>`;
    });
    svg += `<text x="${m.l}" y="${H - 6}">#${fmt(start + 1)}</text><text x="${W - m.r}" y="${H - 6}" text-anchor="end">#${fmt(rolls.length)}</text>`;
    return svg + '</svg>';
  }

  function rarityDistHTML(st) {
    const shares = Object.fromEntries(TIERS_DESC.map(t => [t, st.tierCounts[t] / st.N]));
    const max = Math.max(...TIERS_DESC.map(t => Math.max(shares[t], window.TIER_ODDS[t])));
    return `<div class="dist">${TIERS_DESC.map(t => {
      const exp = window.TIER_ODDS[t];
      const tipHtml = `<b>${t.toUpperCase()}</b><br>${plural(st.tierCounts[t], 'roll')} · ${pctStr(shares[t])}<br>expected ${pctStr(exp)} (≈ ${(exp * st.N).toFixed(1)} rolls)`;
      return `
        <div class="dist-row" data-tip="${esc(tipHtml)}">
          <span>${tierPill(t)}</span>
          <div class="dist-track">
            <div class="dist-fill" style="width:${(shares[t] / max) * 100}%"></div>
            <span class="dist-exp" style="left:${(exp / max) * 100}%"></span>
          </div>
          <span class="dist-val">${fmt(st.tierCounts[t])} · ${pctStr(shares[t])} <small>/ ${pctStr(exp)}</small></span>
        </div>`;
    }).join('')}</div>`;
  }

  function recordsHTML(indices) {
    return `<div class="records">${indices.map((i, k) => {
      const r = Store.rolls[i];
      const a = analysis(r[0]);
      return `
        <div class="record" data-roll="${i}">
          <span class="rank">${k + 1}</span>
          <span class="num-card sm" data-tier="${a.tier}">${a.str}</span>
          <span class="grow">${a.groups.slice(0, 3).map(g => `${g.badge.emoji} ${esc(g.badge.label)}`).join(' · ')}</span>
          <span class="ep-pill">${compact(r[1])}</span>
        </div>`;
    }).join('')}</div>`;
  }

  const legendHTML = (seriesLabel) => `<div class="legend"><span><i style="background:var(--chart-accent)"></i>${seriesLabel}</span><span><i class="line"></i>Expected</span></div>`;
  const tile = (label, value, sub) => `<div class="tile"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

  function renderStats() {
    currentView = 'stats';
    const N = Store.rolls.length;
    if (!N) {
      app.innerHTML = `<div class="page"><h1 class="page-title">Stats</h1>${emptyStateHTML()}</div>`;
      return;
    }
    Collection.ensure();
    const st = computeStats();
    const bestI = st.top[0];
    const found = Collection.badges.size, totalBadges = Engine.badges.length;
    const expectedLuck = window.SCORE_STATS.meanPct;

    const digitShares = st.digitCounts.map(c => c / st.digitTotal);
    const digitSVG = barChartSVG({
      labels: digitShares.map((_, d) => String(d)),
      values: digitShares,
      expected: window.DIGIT_ODDS,
      tickFormat: v => (v * 100).toFixed(0) + '%',
      tips: digitShares.map((v, d) => `<b>Digit ${d}</b><br>${pctStr(v)} of your digits (${fmt(st.digitCounts[d])})<br>expected ${pctStr(window.DIGIT_ODDS[d])}`),
    });
    const bucketExp = st.buckets.map((_, k) => (N * (k === 9 ? 100001 : 100000)) / 1000001);
    const bucketSVG = barChartSVG({
      labels: st.buckets.map((_, k) => (k === 0 ? '0' : k + '00K')),
      values: st.buckets,
      expected: bucketExp,
      tickFormat: v => compact(v),
      tips: st.buckets.map((c, k) => `<b>${fmt(k * 100000)} – ${fmt(k === 9 ? 1000000 : (k + 1) * 100000 - 1)}</b><br>${plural(c, 'roll')} · expected ≈ ${bucketExp[k].toFixed(1)}`),
    });

    app.innerHTML = `
      <div class="page page-wide">
        <h1 class="page-title">Stats</h1>
        <div class="tiles">
          ${tile('Rolls', fmt(N), `${fmt(st.today)} today`)}
          ${tile('Lifetime XP', compact(st.lifetime), `${fmt(st.lifetime / N)} XP per roll`)}
          ${tile('Median roll', fmt(st.median) + ' XP', `typical: ${fmt(window.SCORE_STATS.median)} XP`)}
          ${tile('Luck', st.luck.toFixed(1), `avg percentile · expected ${expectedLuck.toFixed(1)}`)}
          ${tile('Best roll', `<span data-roll="${bestI}" style="cursor:pointer">${Store.rolls[bestI][0]}</span>`, `${fmt(Store.rolls[bestI][1])} XP`)}
          ${tile('Badges', `${found}/${totalBadges}`, `${((found / totalBadges) * 100).toFixed(0)}% of the collection`)}
        </div>

        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Rarity distribution</h3><span class="panel-note">your rolls vs. expected odds</span></div>
          ${rarityDistHTML(st)}
          ${legendHTML('Your rolls')}
        </div>

        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">XP per roll</h3><span class="panel-note">last ${fmt(Math.min(N, 300))} rolls · log scale · click a point</span></div>
          <div class="chart-wrap">${epChartSVG()}</div>
        </div>

        <div class="grid-2 stats-sep">
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Digit frequency</h3><span class="panel-note">share of all digits rolled</span></div>
            <div class="chart-wrap">${digitSVG}</div>
            ${legendHTML('Your digits')}
          </div>
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Where numbers land</h3><span class="panel-note">rolls per 100,000 range</span></div>
            <div class="chart-wrap">${bucketSVG}</div>
            ${legendHTML('Your rolls')}
          </div>
        </div>

        <div class="grid-2 stats-sep">
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Top 10 rolls</h3></div>
            ${recordsHTML(st.top)}
          </div>
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Streaks & oddities</h3></div>
            <div class="kv"><span class="k">Rolls since last Rare or better</span><span class="v">${st.sinceRare}</span></div>
            <div class="kv"><span class="k">Rolls since last Epic or better</span><span class="v">${st.sinceEpic}</span></div>
            <div class="kv"><span class="k">Rolls since last Mythic</span><span class="v">${st.sinceMythic}</span></div>
            <div class="kv"><span class="k">Longest run without Rare+</span><span class="v">${fmt(st.longestDry)}</span></div>
            <div class="kv"><span class="k">Numbers rolled more than once</span><span class="v">${fmt(st.repeats)}</span></div>
            ${st.rarest ? `<div class="kv"><span class="k">Rarest badge found</span><span class="v" data-badge="${st.rarest}" style="cursor:pointer">${Engine.byId.get(st.rarest).emoji} ${oneIn(window.BADGE_ODDS[st.rarest])}</span></div>` : ''}
            <div class="kv"><span class="k">First roll</span><span class="v">${new Date(st.first).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
          </div>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- collection
  const collState = { filter: 'all', q: '' };

  // Une collection se lit par get(id) → { count, first } ou rien : la mienne (historique local)
  // ou celle d'un autre joueur (réponse de /api/profile : { id: [nombre de fois, premier nombre] }).
  const localCollection = () => ({
    get(id) { const e = Collection.badges.get(id); return e && { count: e.count, first: Store.rolls[e.first][0] }; },
  });
  const profileCollection = badges => ({
    get(id) { const e = badges[id]; return e && { count: e[0], first: e[1] }; },
  });

  function renderBadges() {
    currentView = 'badges';
    Collection.ensure();
    app.innerHTML = `
      <div class="page page-wide">
        <h1 class="page-title">Badges</h1>
        <div id="b-ach"><div class="panel"><div class="empty">${Store.player.name ? 'Loading your achievements…' : 'Roll once to start unlocking achievements and titles.'}</div></div></div>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Badge collection</h3></div>
          ${collectionHTML(Collection.badges.size, collState)}
        </div>
      </div>`;
    mountCollection(localCollection(), collState);
    loadMyAchievements();
  }

  // Mes succès (calculés par le serveur) et le titre équipé, dans l'onglet Badges.
  async function loadMyAchievements() {
    const slot = $('#b-ach');
    if (!slot || !Store.player.name) return;
    let p;
    try {
      p = await Online.profile(Store.player.name);
    } catch (err) {
      if (slot.isConnected) slot.innerHTML = `<div class="panel"><div class="empty">${err.status === 404 ? 'Roll once to start unlocking achievements and titles.' : 'Achievements unavailable right now.'}</div></div>`;
      return;
    }
    if (!slot.isConnected || currentView !== 'badges') return;
    noteAchievements(p.achievements);
    slot.innerHTML = `${p.title ? `<p class="panel-note equipped-title">Equipped title: ${titleHTML(p.title)}</p>` : ''}${achievementsPanelHTML(p, true)}`;
    wireEquip(slot, loadMyAchievements);
  }

  function collectionHTML(found, state) {
    const total = Engine.badges.length;
    return `
      <div class="panel-head"><span class="mono" style="font-weight:700">${found} / ${total} found</span><span class="panel-note">${((found / total) * 100).toFixed(1)}% complete</span></div>
      <div class="progress"><div style="width:${(found / total) * 100}%"></div></div>
      <div class="toolbar">
        <input class="input grow" id="c-q" type="search" placeholder="Search badges…" value="${esc(state.q)}">
        <div class="seg" id="c-filter">${['all', 'found', 'missing'].map(f => `<button data-v="${f}" class="${state.filter === f ? 'on' : ''}">${f}</button>`).join('')}</div>
      </div>
      <div id="c-body"></div>`;
  }

  function mountCollection(src, state) {
    $('#c-q').addEventListener('input', e => { state.q = e.target.value; drawCollection(src, state); });
    $('#c-filter').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state.filter = btn.dataset.v;
      $('#c-filter').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
      drawCollection(src, state);
    });
    drawCollection(src, state);
  }

  function drawCollection(src, state) {
    const q = state.q.trim().toLowerCase();
    const blocks = ['mythic', 'anomaly', 'epic', 'rare', 'uncommon', 'common'].map(tier => {
      const all = Engine.badges.filter(b => b.tier === tier);
      const foundInTier = all.filter(b => src.get(b.id)).length;
      const list = all
        .filter(b => state.filter === 'all' || (state.filter === 'found') === !!src.get(b.id))
        .filter(b => !q || b.label.toLowerCase().includes(q) || b.desc.toLowerCase().includes(q))
        .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
      if (!list.length) return '';
      return `
        <div class="tier-block">
          <h3>${tierPill(tier)} <span class="muted mono">${foundInTier}/${all.length}</span></h3>
          <div class="badge-grid">${list.map(b => collTileHTML(b, src.get(b.id))).join('')}</div>
        </div>`;
    }).join('');
    $('#c-body').innerHTML = blocks || '<div class="empty">No badge matches.</div>';
  }

  function collTileHTML(b, e) {
    return `
      <button class="coll${e ? '' : ' missing'}"${e ? ` data-tier="${b.tier}"` : ''} data-badge="${b.id}">
        <span class="top"><span class="emoji">${b.emoji}</span><span class="name">${esc(b.label)}</span><span class="ep-pill">${compact(b.score)}</span></span>
        <span class="desc">${esc(b.desc)}</span>
        <span class="foot">${e
          ? `<span class="count">×${fmt(e.count)}</span><span>first: <span class="mono">${e.first}</span></span>`
          : `<span>${oneIn(window.BADGE_ODDS[b.id])}</span><span class="muted">not found</span>`}</span>
      </button>`;
  }

  // ---------------------------------------------------------------- profil public d'un joueur
  // Ouvert en cliquant un nom (classement, meilleur tirage du jour) : meilleurs tirages et collection, calculés par le serveur.
  const profileHref = name => `#/player/${encodeURIComponent(name)}`;
  let profileToken = 0;

  async function renderProfile(name) {
    currentView = 'profile';
    const token = ++profileToken;
    app.innerHTML = `
      <div class="page page-wide">
        <a class="back-link" href="#/leaderboard">← Leaderboard</a>
        <h1 class="page-title" id="p-title">${esc(name)}</h1>
        <div id="p-body"><div class="empty">Loading…</div></div>
      </div>`;
    // Mon propre profil, calculé de la même façon, pour la comparaison (inutile sur ma page).
    const self = Store.player.name;
    const minePromise = self && self.toLowerCase() !== name.toLowerCase() ? Online.profile(self).catch(() => null) : Promise.resolve(null);
    let p, mine;
    try {
      [p, mine] = await Promise.all([Online.profile(name), minePromise]);
    } catch (err) {
      if (token === profileToken && currentView === 'profile') {
        $('#p-body').innerHTML = `<div class="empty">${err.status === 404 ? `No player called “${esc(name)}”.` : 'Profile unavailable right now.'}</div>`;
      }
      return;
    }
    if (token !== profileToken || currentView !== 'profile') return;

    const me = !!Store.player.name && p.name === Store.player.name;
    const found = Object.keys(p.badges).length, total = Engine.badges.length;
    const top = p.best[0];
    const day = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const caption = x => `${p.name} · ${fullDate(x.t)}`;
    const collectionState = { filter: 'all', q: '' };
    $('#p-title').innerHTML = `${esc(p.name)}${me ? ' <span class="muted">(you)</span>' : ''} ${titleHTML(p.title)}${me ? '' : ' <button class="btn add-friend" id="p-friend">👥 Add friend</button>'}`;
    const addFriend = $('#p-friend');
    if (addFriend) addFriend.addEventListener('click', () => friendAction('add', p.name));
    if (me) noteAchievements(p.achievements);
    $('#p-body').innerHTML = `
      <p class="panel-note profile-sub">${p.rolls ? `Playing since ${day(p.since)} · last roll ${relTime(p.last)}` : 'No rolls yet'}</p>
      <div class="tiles">
        ${tile('Rolls', fmt(p.rolls), p.rolls ? `${fmt(p.lifetime / p.rolls)} XP per roll` : '–')}
        ${tile('Lifetime XP', compact(p.lifetime), `${fmt(p.lifetime)} XP`)}
        ${tile('Best roll', top ? `<span data-number="${top.n}" data-caption="${esc(caption(top))}" style="cursor:pointer">${analysis(top.n).str}</span>` : '–', top ? `${fmt(top.s)} XP` : '')}
        ${tile('All-time rank', p.rank ? '#' + p.rank : '–', 'best single roll')}
        ${tile('Badges', `${found}/${total}`, `${((found / total) * 100).toFixed(0)}% of the collection`)}
      </div>
      ${!me && mine ? compareHTML(mine, p) : ''}
      ${duelsPanelHTML(p, me)}
      ${achievementsPanelHTML(p, me)}
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">Best rolls</h3><span class="panel-note">click a number for its badges</span></div>
        ${p.best.length ? `<div class="records">${p.best.map((x, k) => {
          const a = analysis(x.n);
          return `
            <div class="record" data-number="${x.n}" data-caption="${esc(caption(x))}">
              <span class="rank">${k + 1}</span>
              <span class="num-card sm" data-tier="${a.tier}">${a.str}</span>
              <span class="grow">${a.groups.slice(0, 3).map(g => `${g.badge.emoji} ${esc(g.badge.label)}`).join(' · ')}</span>
              <span class="when" title="${fullDate(x.t)}">${relTime(x.t)}</span>
              <span class="ep-pill">${compact(x.s)} XP</span>
            </div>`;
        }).join('')}</div>` : '<div class="empty">No rolls yet.</div>'}
      </div>
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">Badge collection</h3></div>
        ${collectionHTML(found, collectionState)}
      </div>`;
    mountCollection(profileCollection(p.badges), collectionState);
    if (me) wireEquip($('#p-body'), () => renderProfile(p.name));
  }

  // Grille des succès d'un joueur (profil, onglet Badges) ; chez soi, boutons pour équiper le titre d'un succès.
  function achievementsPanelHTML(p, me) {
    const unlocked = new Set(p.achievements || []);
    // Les succès cachés (Owner) n'apparaissent que chez qui les a.
    const list = Ach.LIST.filter(a => !a.hidden || unlocked.has(a.id));
    const total = Ach.LIST.filter(a => !a.hidden).length;
    const done = [...unlocked].filter(id => Ach.byId.has(id) && !Ach.byId.get(id).hidden).length;
    return `
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">Achievements & titles</h3><span class="panel-note">${done} / ${total} unlocked${me ? ' · equip one: its title shows next to your name on the leaderboard and in duels' : ''}</span></div>
        <div class="ach-grid">${list.map(a => {
          const on = unlocked.has(a.id), equipped = p.title === a.id;
          const action = !me || !on ? '' : equipped
            ? '<button class="btn ach-btn" data-equip="">Unequip</button>'
            : `<button class="btn ach-btn" data-equip="${a.id}">Equip</button>`;
          return `<div class="ach${on ? '' : ' locked'}${equipped ? ' equipped' : ''}"><span class="ach-emoji">${on ? a.emoji : '🔒'}</span><span class="ach-text"><b>${esc(a.title)}</b><span>${esc(a.desc)}</span></span>${action}</div>`;
        }).join('')}</div>
      </div>`;
  }

  function wireEquip(root, rerender) {
    const grid = root.querySelector('.ach-grid');
    if (!grid) return;
    grid.addEventListener('click', async e => {
      const btn = e.target.closest('[data-equip]');
      if (!btn) return;
      btn.disabled = true;
      try {
        const r = await Online.equip(btn.dataset.equip);
        const a = Ach.byId.get(r.title);
        toast(a ? `Title equipped: ${a.emoji} ${a.title}` : 'Title removed');
        rerender();
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Could not change your title, try again');
      }
    });
  }

  // Duels d'un joueur : bilan, face-à-face avec moi, rivaux les plus affrontés.
  function duelsPanelHTML(p, me) {
    const d = p.duels;
    if (!d || (!d.played && !(d.rivals || []).length)) return '';
    const rate = d.played ? ` · ${Math.round((d.won / d.played) * 100)}% win rate` : '';
    const vs = !me && d.vsMe ? `
      <div class="h2h">
        <span>You vs ${esc(p.name)}</span>
        <b class="mono">${d.vsMe.l} – ${d.vsMe.w}</b>
        <span class="panel-note">${d.vsMe.l > d.vsMe.w ? 'you lead' : d.vsMe.l < d.vsMe.w ? `${esc(p.name)} leads` : d.vsMe.l ? 'tied' : 'no duel between you yet'}</span>
      </div>` : '';
    const rivals = (d.rivals || []).map(r => `
      <div class="rival-row"><a class="player-link" href="${profileHref(r.name)}">${esc(r.name)}</a><span class="mono">${r.w} – ${r.l}</span></div>`).join('');
    return `
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">Duels</h3><span class="panel-note">${fmt(d.won)} won / ${fmt(d.played)} played${rate}</span></div>
        ${vs}
        ${rivals ? `<div class="eyebrow" style="margin:.4rem 0 .3rem">Rivals (${me ? 'your' : 'their'} wins – losses)</div>${rivals}` : ''}
      </div>`;
  }

  // Comparaison complète avec un autre joueur (deux profils calculés par le serveur) :
  // chaque ligne met en valeur le meilleur des deux, puis le score, les meilleurs tirages et les badges de chacun.
  function compareHTML(mine, theirs) {
    const found = p => Object.keys(p.badges).length;
    const rarest = p => Object.keys(p.badges).map(id => Engine.byId.get(id)).filter(Boolean).sort((x, y) => y.score - x.score)[0] || null;
    const day = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const bestCell = p => (p.best[0]
      ? `<span class="mono" data-number="${p.best[0].n}" data-caption="${esc(`${p.name} · best roll`)}" style="cursor:pointer">${analysis(p.best[0].n).str}</span> · ${compact(p.best[0].s)} XP`
      : '–');
    const rarestCell = p => { const b = rarest(p); return b ? `<span data-badge="${b.id}" style="cursor:pointer">${b.emoji} ${esc(b.label)}</span>` : '–'; };
    // [libellé, valeur comparée, affichage, sens] : 1 = plus haut gagne, -1 = plus bas gagne, 0 = pas de gagnant.
    const rows = [
      ['Rolls', p => p.rolls, v => fmt(v), 1],
      ['Lifetime XP', p => p.lifetime, v => compact(v), 1],
      ['XP per roll', p => (p.rolls ? p.lifetime / p.rolls : 0), v => fmt(v), 1],
      ['Best roll', p => (p.best[0] ? p.best[0].s : 0), (v, p) => bestCell(p), 1],
      ['All-time rank', p => p.rank || Infinity, v => (v === Infinity ? '–' : '#' + v), -1],
      ['Luck (avg percentile)', p => (p.luck == null ? -1 : p.luck), v => (v < 0 ? '–' : v.toFixed(1)), 1],
      ...['mythic', 'anomaly', 'epic', 'rare'].map(t => [`${cap(t)} rolls`, p => (p.tiers && p.tiers[t]) || 0, v => fmt(v), 1]),
      ['Duels won', p => (p.duels ? p.duels.won : 0), v => fmt(v), 1],
      ['Duel win rate', p => (p.duels && p.duels.played ? p.duels.won / p.duels.played : -1), v => (v < 0 ? '–' : `${Math.round(v * 100)}%`), 1],
      ['Badges found', found, v => `${v}/${Engine.badges.length}`, 1],
      ['Rarest badge', p => (rarest(p) ? rarest(p).score : 0), (v, p) => rarestCell(p), 1],
      ['Playing since', p => p.since || 0, v => (v ? day(v) : '–'), 0],
    ];
    let myWins = 0, theirWins = 0;
    const body = rows.map(([label, get, show, dir]) => {
      const a = get(mine), b = get(theirs);
      const win = dir === 0 || a === b ? 0 : (a > b) === (dir > 0) ? 1 : 2;
      if (win === 1) myWins++;
      if (win === 2) theirWins++;
      return `<div class="compare-row"><span class="k">${label}</span><span class="v${win === 1 ? ' win' : ''}">${show(a, mine)}</span><span class="v${win === 2 ? ' win' : ''}">${show(b, theirs)}</span></div>`;
    }).join('');
    const score = myWins === theirWins ? `Tied ${myWins}–${theirWins}`
      : myWins > theirWins ? `You lead ${myWins}–${theirWins}` : `${esc(theirs.name)} leads ${theirWins}–${myWins}`;

    const mineSet = new Set(Object.keys(mine.badges)), theirSet = new Set(Object.keys(theirs.badges));
    const onlyThem = [...theirSet].filter(id => !mineSet.has(id));
    const onlyMe = [...mineSet].filter(id => !theirSet.has(id));
    const common = [...mineSet].filter(id => theirSet.has(id)).length;
    const pills = ids => {
      const list = ids.map(id => Engine.byId.get(id)).filter(Boolean).sort((x, y) => y.score - x.score);
      if (!list.length) return '<span class="muted">none</span>';
      return list.slice(0, 40).map(b => `<span class="badge-pill" data-tier="${b.tier}" data-badge="${b.id}" style="cursor:pointer">${b.emoji} ${esc(b.label)}</span>`).join('')
        + (list.length > 40 ? `<span class="more">+${list.length - 40} more</span>` : '');
    };
    const top5 = p => p.best.slice(0, 5).map((x, k) => {
      const a = analysis(x.n);
      return `<div class="record" data-number="${x.n}" data-caption="${esc(`${p.name} · ${fullDate(x.t)}`)}"><span class="rank">${k + 1}</span><span class="num-card sm" data-tier="${a.tier}">${a.str}</span><span class="grow"></span><span class="ep-pill">${compact(x.s)} XP</span></div>`;
    }).join('') || '<div class="empty">No rolls yet.</div>';

    return `
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">You vs ${esc(theirs.name)}</h3><span class="compare-score">${score}</span></div>
        <div class="compare">
          <div class="compare-row head"><span></span><span>You</span><span>${esc(theirs.name)}</span></div>
          ${body}
        </div>
        <div class="grid-2 compare-top">
          <div><div class="eyebrow">Your top 5</div><div class="records">${top5(mine)}</div></div>
          <div><div class="eyebrow">${esc(theirs.name)}'s top 5</div><div class="records">${top5(theirs)}</div></div>
        </div>
        <div class="compare-badges">
          <div class="eyebrow">Only ${esc(theirs.name)} has (${onlyThem.length})</div>
          <div class="pill-row left">${pills(onlyThem)}</div>
          <div class="eyebrow">Only you have (${onlyMe.length})</div>
          <div class="pill-row left">${pills(onlyMe)}</div>
          <p class="panel-note">${plural(common, 'badge')} in common</p>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- duel en direct
  // Un joueur crée une partie (2 à 10 joueurs ; premier à N manches, ou premier à un total d'XP) et donne le code.
  // Tout le monde tire en même temps, manche par manche : le serveur tire tous les nombres au même instant et fixe
  // l'heure de la révélation commune (horloges recalées sur celle du serveur). Ce sont des tirages normaux :
  // historique, XP et classement. Une manche part toute seule 15 s après le premier joueur prêt.
  const roomHref = code => `#/room/${code}`;
  const stakeText = d => (d.stake ? ` · 🪙 stake ${fmt(d.stake)} each, pot ${fmt(d.pot)}` : '');
  const ROOM_POLL_MS = 1500;
  const ROOM_IDLE_MS = 10 * 60000; // sans aucun changement pendant 10 min, on arrête de sonder (quota de la base)
  const XP_TARGETS = [25000, 50000, 100000, 250000, 1000000];
  const Room = { code: null, token: 0, timer: 0, offset: 0, rtt: Infinity, data: null, shown: 0, anim: null, view: null, sig: '', changedAt: 0, reactSeen: new Set(), reactBusy: false, achNoted: false };
  // Emotes de duel : la mascotte dé (images dessinées pour le site). Touches 1 à 6.
  const REACTIONS = ['laugh', 'cry', 'angry', 'cool', 'shock', 'king'];
  const EMOTE_LABELS = { laugh: 'Laugh', cry: 'Cry', angry: 'Angry', cool: 'Cool', shock: 'Shocked', king: 'King' };
  const emoteHTML = (id, cls = '') => (EMOTE_LABELS[id]
    ? `<img class="emote${cls}" src="img/emotes/${id}.png" alt="${EMOTE_LABELS[id]}" draggable="false">`
    : esc(id)); // ancienne réaction en emoji (salles d'avant les emotes)
  const titleEmoji = id => (id && Ach.byId.get(id) && !Ach.byId.get(id).hidden ? ` ${Ach.byId.get(id).emoji}` : '');
  const goalText = d => (d.mode === 'xp' ? `first to ${compact(d.target)} XP` : `first to ${plural(d.target, 'round win')}`);

  // Derniers réglages choisis, retenus sur l'appareil.
  function duelPrefs() {
    const d = Store.settings.duel || {};
    return {
      size: Math.min(10, Math.max(2, Number(d.size) || 2)),
      mode: d.mode === 'xp' ? 'xp' : 'rounds',
      wins: Math.min(10, Math.max(1, Number(d.wins) || 3)),
      xp: XP_TARGETS.includes(Number(d.xp)) ? Number(d.xp) : 50000,
      isPublic: d.isPublic !== false,
      stake: Shop.STAKES.includes(Number(d.stake)) ? Number(d.stake) : 0,
    };
  }

  // Onglet Duel : parties publiques en cours, créer ou rejoindre une partie, boutique de skins.
  let hubTimer = 0;
  function renderDuelHub() {
    currentView = 'duel';
    app.innerHTML = `
      <div class="page page-wide">
        <h1 class="page-title">Duel</h1>
        <p class="panel-note profile-sub">Everyone rolls at the same time and all numbers are revealed together, digit by digit. Duel rolls are normal rolls: they stay in your history and count on the leaderboard.</p>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Live now</h3><span class="panel-note">public games · watch or join without a code</span></div>
          <div id="d-live"><div class="empty">Loading…</div></div>
        </div>
        <div class="grid-2 stats-sep">
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Create a game</h3></div>
            <div id="d-setup"></div>
            <div class="room-buttons" style="justify-content:flex-start">
              <button class="btn-roll small" id="d-create">⚔️ Create the game</button>
              <button class="btn" id="d-bots"></button>
            </div>
            <p class="panel-note" style="margin:.6rem 0 0">Against bots the game starts at once and your rolls count as usual, but not duel wins, rivalries or duel achievements.</p>
          </div>
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">Join with a code</h3></div>
            <form class="duel-join" id="d-join">
              <input class="input mono" id="d-code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Duel code">
              <button class="btn" type="submit">Join</button>
            </form>
            <p class="panel-note">Ask the host for the 5-character code, or open the link they share.</p>
          </div>
        </div>
      </div>`;
    const drawSetup = () => {
      const p = duelPrefs();
      const seg = (id, values, current, label = v => v) => `<div class="seg wrap" data-pref="${id}">${values.map(v => `<button data-v="${v}" class="${v === current ? 'on' : ''}">${label(v)}</button>`).join('')}</div>`;
      $('#d-setup').innerHTML = `
        <div class="field"><label>Players</label>${seg('size', [2, 3, 4, 5, 6, 7, 8, 9, 10], p.size)}</div>
        <div class="field"><label>How to win</label>${seg('mode', ['rounds', 'xp'], p.mode, v => (v === 'xp' ? 'XP race' : 'Rounds'))}</div>
        ${p.mode === 'xp'
          ? `<div class="field"><label>First to reach (XP)</label>${seg('xp', XP_TARGETS, p.xp, v => compact(v))}</div>`
          : `<div class="field"><label>Round wins needed</label>${seg('wins', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p.wins)}</div>`}
        <div class="field"><label>Visibility</label>${seg('isPublic', ['true', 'false'], String(p.isPublic), v => (v === 'true' ? 'Public' : 'Private'))}</div>
        <div class="field"><label>Stake (coins each, winner takes the pot)</label>${seg('stake', Shop.STAKES, p.stake, v => (v ? `🪙 ${v}` : 'None'))}</div>
        <p class="panel-note">${p.size} players · ${goalText({ mode: p.mode, target: p.mode === 'xp' ? p.xp : p.wins })} · ${p.isPublic ? 'listed in Live now' : 'code only'}${p.stake ? ` · 🪙 ${fmt(p.stake)} each, pot ${fmt(p.stake * p.size)}: paid on joining, refunded on a draw or if everyone leaves, no bots` : ''}</p>`;
      $('#d-bots').textContent = `🤖 Play vs ${plural(p.size - 1, 'bot')}`;
    };
    drawSetup();
    $('#d-setup').addEventListener('click', e => {
      const btn = e.target.closest('[data-pref] button');
      if (!btn) return;
      const key = btn.parentElement.dataset.pref;
      const value = key === 'mode' ? btn.dataset.v : key === 'isPublic' ? btn.dataset.v === 'true' : Number(btn.dataset.v);
      Store.setSetting('duel', { ...duelPrefs(), [key]: value });
      drawSetup();
    });
    $('#d-create').addEventListener('click', () => createRoom());
    $('#d-bots').addEventListener('click', () => createRoom(duelPrefs().size - 1));
    $('#d-join').addEventListener('submit', e => { e.preventDefault(); joinRoom($('#d-code').value); });
    drawLive();
  }

  function renderShop() {
    currentView = 'shop';
    app.innerHTML = `
      <div class="page page-wide">
        <h1 class="page-title">Shop</h1>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Cases</h3><span class="panel-note">a random skin · the pricier the skin, the rarer</span></div>
          <div class="case-grid" id="d-cases">${Shop.CASES.map(c => {
            const odds = Shop.caseOdds(c).map(o => `${Shop.byId.get(o.id).emoji} ${Shop.byId.get(o.id).name} · ${(o.p * 100).toFixed(1)}%`).join('<br>');
            return `
            <div class="case-tile">
              <div class="case-box" aria-hidden="true">${c.emoji}</div>
              <div class="skin-name"><b>${esc(c.name)}</b><span>${esc(c.desc)}</span></div>
              <span class="case-odds" data-tip="${esc(`<b>${c.name} odds</b><br>${odds}`)}">Odds ⓘ</span>
              <button class="btn" data-case="${c.id}">🪙 ${fmt(c.price)}</button>
            </div>`;
          }).join('')}</div>
          <p class="panel-note" style="margin:.6rem 0 0">Already own the skin you draw? Half of the case price comes back. Coins only, no real money.</p>
        </div>
        <div class="panel stats-sep">
          <div class="panel-head"><h3 class="panel-title">Skins</h3><span class="coins mono" id="d-coins"></span></div>
          <p class="panel-note" style="margin-top:-.3rem">Change how your number looks, on your rolls and on your cards in duels. Earn coins by rolling (${Object.entries(Shop.COINS).map(([t, v]) => `${t[0].toUpperCase()}${t.slice(1)} ${v}`).join(', ')}) and by winning duels (+${Shop.DUEL_WIN_COINS}).</p>
          <div class="skin-grid" id="d-skins"></div>
        </div>
      </div>`;
    drawShop();
  }

  // "Live now", rafraîchi toutes les 10 s tant que l'onglet est visible.
  async function drawLive() {
    clearTimeout(hubTimer);
    let rooms;
    try {
      rooms = (await Online.liveRooms()).rooms;
    } catch (err) {
      if ($('#d-live')) $('#d-live').innerHTML = '<div class="empty">Live games unavailable right now.</div>';
      return;
    }
    const box = $('#d-live');
    if (currentView !== 'duel' || !box) return;
    const changed = setHTML(box, rooms.length ? rooms.map(r => {
      const mine = Store.player.name && r.players.includes(Store.player.name);
      const action = mine ? `<a class="btn" href="${roomHref(r.code)}">Back to it</a>`
        : r.status === 'lobby' && r.count < r.size ? `<button class="btn-roll small" data-join="${r.code}">Join</button>`
        : `<a class="btn" href="${roomHref(r.code)}">Watch</a>`;
      return `
        <div class="live-row">
          <span class="live-dot${r.status === 'playing' ? ' on' : ''}"></span>
          <span class="live-info"><b>${esc(r.host)}'s game</b>
            <span class="panel-note">${r.count}/${r.size} players · ${goalText(r)} · ${r.status === 'lobby' ? 'waiting for players' : `round ${r.round + 1}`}</span>
            <span class="live-players">${r.players.map(esc).join(', ')}</span></span>
          ${action}
        </div>`;
    }).join('') : '<div class="empty">No public game right now. Create one!</div>');
    // Écouteurs posés seulement quand la liste a changé : sinon chaque rafraîchissement en ajouterait un de plus.
    if (changed) box.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => joinRoom(b.dataset.join)));
    if (!document.hidden) hubTimer = setTimeout(() => { if (currentView === 'duel') drawLive(); }, 10000);
  }

  // Boutique : pièces, skins possédés et équipé ; acheter = équiper.
  async function drawShop(state) {
    const grid = $('#d-skins');
    if (!grid) return;
    if (!state) {
      if (!Store.player.name) {
        grid.innerHTML = '<div class="empty">Roll once to start earning coins.</div>';
        return;
      }
      try {
        state = await Online.shop();
      } catch (err) {
        grid.innerHTML = '<div class="empty">Shop unavailable right now.</div>';
        return;
      }
      if (currentView !== 'shop' || !$('#d-skins')) return;
    }
    Store.setSetting('skin', state.skin);
    $('#d-coins').textContent = `🪙 ${fmt(state.coins)}`;
    const cases = $('#d-cases');
    if (cases) cases.onclick = e => {
      const btn = e.target.closest('[data-case]');
      if (btn && !btn.disabled) openCase(Shop.caseById.get(btn.dataset.case), state, btn);
    };
    // Le skin du créateur n'apparaît que chez celui qui le possède, en tête de boutique.
    grid.innerHTML = (state.owned.includes('owner') ? [Shop.OWNER] : []).concat(Shop.SKINS).map(k => {
      const owned = state.owned.includes(k.id), equipped = state.skin === k.id;
      const button = equipped ? '<span class="skin-state">Equipped</span>'
        : owned ? `<button class="btn" data-skin-equip="${k.id}">Equip</button>`
        : `<button class="btn${state.coins >= k.price ? '' : ' disabled'}" data-skin-buy="${k.id}">🪙 ${fmt(k.price)}</button>`;
      return `
        <div class="skin-tile${equipped ? ' equipped' : ''}">
          ${withLever(`<div class="num-card md${skinClass(k.id)}" data-tier="rare">${slotsHTML('235711')}</div>`, k.id)}
          <div class="skin-name"><b>${k.emoji} ${esc(k.name)}</b><span>${esc(k.desc)}</span></div>
          ${button}
        </div>`;
    }).join('');
    grid.onclick = async e => {
      const buy = e.target.closest('[data-skin-buy]'), equip = e.target.closest('[data-skin-equip]');
      const btn = buy || equip;
      if (!btn || btn.disabled) return;
      const skin = Shop.byId.get(btn.dataset.skinBuy || btn.dataset.skinEquip);
      if (buy && state.coins < skin.price) { toast(`${fmt(skin.price - state.coins)} more coins needed for ${skin.name}`); return; }
      btn.disabled = true;
      try {
        const next = await Online.shopAction(buy ? 'buy' : 'equip', skin.id);
        toast(buy ? `${skin.emoji} ${skin.name} unlocked and equipped` : `${skin.emoji} ${skin.name} equipped`);
        drawShop(next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      }
    };
  }

  // Ouverture d'une caisse : le serveur tire le skin, le site fait défiler une bande de skins qui s'arrête dessus.
  async function openCase(box, state, btn) {
    if (state.coins < box.price) { toast(`${fmt(box.price - state.coins)} more coins needed for the ${box.name}`); return; }
    btn.disabled = true;
    let result;
    try {
      result = await Online.shopCase(box.id);
    } catch (err) {
      btn.disabled = false;
      toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      return;
    }
    btn.disabled = false;
    const pool = Shop.caseOdds(box);
    const pick = () => { let u = Math.random(), acc = 0; for (const o of pool) { acc += o.p; if (u < acc) return o.id; } return pool[0].id; };
    const WIN = 32, strip = Array.from({ length: 38 }, (_, i) => (i === WIN ? result.won : pick()));
    const won = Shop.byId.get(result.won);
    const cell = id => `<div class="case-cell"><div class="num-card sm${skinClass(id)}" data-tier="rare">${slotsHTML('777')}</div><span>${Shop.byId.get(id).emoji} ${esc(Shop.byId.get(id).name)}</span></div>`;
    openModal(`
      <h2>${box.emoji} ${esc(box.name)}</h2>
      <div class="case-reel"><div class="case-marker"></div><div class="case-strip" id="case-strip">${strip.map(cell).join('')}</div></div>
      <div class="case-result" id="case-result" hidden>
        <div class="num-card md${skinClass(won.id)}" data-tier="${result.duplicate ? 'common' : 'epic'}">${slotsHTML('235711')}</div>
        <p><b>${won.emoji} ${esc(won.name)}</b> — ${result.duplicate ? `you already own it: 🪙 ${fmt(result.refund)} refunded` : 'new skin unlocked!'}</p>
        <div class="room-buttons">
          ${result.duplicate ? '' : `<button class="btn-roll small" id="case-equip">Equip</button>`}
          <button class="btn" id="case-again">Open another · 🪙 ${fmt(box.price)}</button>
        </div>
      </div>`, () => {
      const el = $('#case-strip'), reel = el.parentElement;
      const target = el.children[WIN];
      // Arrêt sur le skin gagné, légèrement décalé du centre comme une vraie roue.
      const shift = target.offsetLeft + target.offsetWidth / 2 - reel.clientWidth / 2 + (Math.random() - 0.5) * target.offsetWidth * 0.6;
      const finish = () => {
        target.classList.add('won');
        $('#case-result').hidden = false;
        Sound.play('lock', { i: result.duplicate ? 1 : 6 });
        if (!result.duplicate) FX.celebrate('epic', target);
        drawShop(result);
      };
      if (reducedMotion) { el.style.transform = `translateX(${-shift}px)`; finish(); }
      else {
        requestAnimationFrame(() => { el.style.transition = 'transform 4.2s cubic-bezier(.12, .7, .1, 1)'; el.style.transform = `translateX(${-shift}px)`; });
        setTimeout(finish, 4300);
      }
      const equip = $('#case-equip');
      if (equip) equip.addEventListener('click', async () => {
        try { drawShop(await Online.shopAction('equip', won.id)); toast(`${won.emoji} ${won.name} equipped`); closeModal(); } catch (err) { toast('Shop unavailable right now, try again'); }
      });
      $('#case-again').addEventListener('click', () => { closeModal(); openCase(box, result, btn); });
    });
  }

  // ---------------------------------------------------------------- amis
  let friendsTimer = 0;
  function renderFriends() {
    currentView = 'friends';
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Friends</h1>
        <p class="panel-note profile-sub">Add players by name to follow their progress and jump into their duels.</p>
        <div class="panel">
          <form class="duel-join" id="f-add">
            <input class="input" id="f-name" maxlength="16" placeholder="Player name" autocomplete="off" spellcheck="false" aria-label="Player name">
            <button class="btn" type="submit">Add friend</button>
          </form>
        </div>
        <div id="f-body"><div class="empty">Loading…</div></div>
      </div>`;
    $('#f-add').addEventListener('submit', e => { e.preventDefault(); friendAction('add', $('#f-name').value.trim()); });
    $('#f-body').addEventListener('click', e => {
      const btn = e.target.closest('[data-fr]');
      if (!btn) return;
      if (btn.dataset.fr === 'remove' && !confirm(`Remove ${btn.dataset.name} from your friends?`)) return;
      friendAction(btn.dataset.fr, btn.dataset.name);
    });
    drawFriends();
  }
  async function friendAction(action, name) {
    if (!Store.player.name) { askName(() => friendAction(action, name)); return; }
    if (!name) { toast('Enter a player name'); return; }
    try {
      const state = await Online.friends(action, name);
      if (state.note) toast(state.note);
      if (action === 'add' && $('#f-name')) $('#f-name').value = '';
      drawFriends(state);
    } catch (err) {
      toast([404, 422].includes(err.status) ? err.message : 'Friends unavailable right now, try again');
    }
  }
  async function drawFriends(state) {
    clearTimeout(friendsTimer);
    const body = $('#f-body');
    if (!body) return;
    if (!Store.player.name) { body.innerHTML = '<div class="empty">Roll once (and pick a name) to add friends.</div>'; return; }
    if (!state) {
      try { state = await Online.friends(); } catch (err) { body.innerHTML = '<div class="empty">Friends unavailable right now.</div>'; return; }
      if (currentView !== 'friends' || !$('#f-body')) return;
    }
    const btn = (action, name, label, cls = 'btn') => `<button class="${cls}" data-fr="${action}" data-name="${esc(name)}">${label}</button>`;
    setHTML(body, `
      ${state.incoming.length ? `
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Friend requests</h3></div>
          ${state.incoming.map(n => `<div class="friend-row"><a class="player-link" href="${profileHref(n)}">${esc(n)}</a><span class="friend-actions">${btn('accept', n, 'Accept', 'btn-roll small')}${btn('decline', n, 'Decline')}</span></div>`).join('')}
        </div>` : ''}
      <div class="panel stats-sep">
        <div class="panel-head"><h3 class="panel-title">Your friends</h3><span class="panel-note">${state.friends.length} / ${state.max}</span></div>
        ${state.friends.length ? state.friends.map(f => `
          <div class="friend-row">
            <span class="live-dot${f.room ? ' on' : ''}"></span>
            <span class="friend-info"><a class="player-link" href="${profileHref(f.name)}">${esc(f.name)}</a>${titleHTML(f.title)}
              <span class="panel-note">${compact(f.xp)} lifetime XP · ${f.room ? 'in a duel right now' : f.seen ? `last roll ${relTime(f.seen)}` : 'no roll yet'}</span></span>
            <span class="friend-actions">${f.room ? `<a class="btn-roll small" href="${roomHref(f.room)}">Join / watch</a>` : ''}${btn('remove', f.name, '✕', 'btn ghost')}</span>
          </div>`).join('') : '<div class="empty">No friends yet. Add one by name above, or from a player profile.</div>'}
      </div>
      ${state.outgoing.length ? `
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Requests sent</h3></div>
          ${state.outgoing.map(n => `<div class="friend-row"><a class="player-link" href="${profileHref(n)}">${esc(n)}</a><span class="friend-actions">${btn('cancel', n, 'Cancel')}</span></div>`).join('')}
        </div>` : ''}`);
    if (!document.hidden) friendsTimer = setTimeout(() => { if (currentView === 'friends') drawFriends(); }, 15000);
  }

  function roomError(err, retry) {
    if (err.status === 409) { askName(retry, '', `"${Store.player.name}" is already taken by another player. Pick a new name.`); return; }
    toast(err.status === 404 ? 'No duel with this code' : err.status === 422 ? err.message : 'Duel unavailable right now, try again');
  }

  // bots : nombre de bots pour une partie immédiate contre eux (0 = partie normale, on attend les joueurs).
  async function createRoom(bots = 0) {
    if (!Store.player.name) { askName(() => createRoom(bots)); return; }
    const p = duelPrefs();
    try {
      const d = await Online.roomAction('create', null, { size: p.size, mode: p.mode, target: p.mode === 'xp' ? p.xp : p.wins, public: p.isPublic, bots, stake: bots ? 0 : p.stake });
      location.hash = roomHref(d.code);
    } catch (err) {
      roomError(err, () => createRoom(bots));
    }
  }

  async function joinRoom(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{5}$/.test(code)) { toast('Enter the 5-character duel code'); return; }
    if (!Store.player.name) { askName(() => joinRoom(code)); return; }
    try {
      await Online.roomAction('join', code);
      if (location.hash === roomHref(code)) route(); else location.hash = roomHref(code);
    } catch (err) {
      roomError(err, () => joinRoom(code));
    }
  }

  // Envoie une action (prêt, lancement) et applique aussitôt l'état renvoyé.
  async function roomSend(action, btn, extra) {
    if (btn) btn.disabled = true;
    const token = Room.token, sent = Date.now();
    try {
      applyRoom(await Online.roomAction(action, Room.code, extra), token, sent, Date.now());
    } catch (err) {
      if (btn) btn.disabled = false;
      roomError(err, () => roomSend(action, null, extra));
    }
  }

  function roomReady() {
    Sound.unlock(); // la manche se révèlera plus tard, sans geste du joueur : le son s'ouvre maintenant
    const btn = $('#room-roll');
    if (btn && !btn.disabled) roomSend('ready', btn);
  }

  async function roomRematch() {
    const d = Room.data;
    if (d.next) { location.hash = roomHref(d.next); return; }
    try {
      const next = await Online.roomAction('rematch', d.code);
      location.hash = roomHref(next.code);
    } catch (err) {
      roomError(err, roomRematch);
    }
  }

  function stopRoom() {
    clearTimeout(Room.timer);
    if (Room.anim) Room.anim.cancel();
    Room.anim = null;
    Room.token++;
  }

  function renderRoom(code) {
    currentView = 'room';
    REACTIONS.forEach(id => { new Image().src = `img/emotes/${id}.png`; });
    stopRoom();
    Object.assign(Room, { code: code.toUpperCase(), data: null, shown: 0, rtt: Infinity, view: null, sig: '', changedAt: Date.now(), reactSeen: new Set(), achNoted: false });
    app.innerHTML = `
      <div class="page page-wide">
        <a class="back-link" href="#/duel">← Duel</a>
        <h1 class="page-title">Live duel <span class="muted mono">${esc(Room.code)}</span></h1>
        <div id="room-body"><div class="empty">Loading…</div></div>
      </div>`;
    pollRoom(Room.token);
  }

  // Sondé tant que la partie n'est pas finie et que l'onglet est visible, au rythme de nextPollMs.
  async function pollRoom(token) {
    clearTimeout(Room.timer);
    const sent = Date.now();
    try {
      // Un sondage sur 4 relit les skins équipés (changés dans Shop en pleine partie).
      Room.polls = (Room.polls || 0) + 1;
      applyRoom(await Online.room(Room.code, Room.polls % 4 === 0), token, sent, Date.now());
    } catch (err) {
      if (token !== Room.token || currentView !== 'room') return;
      if (err.status === 404) {
        $('#room-body').innerHTML = '<div class="empty">No duel with this code. Duels are kept for one day.</div>';
        return;
      }
    }
    if (token !== Room.token || currentView !== 'room') return;
    // Onglet caché : un simple "je suis là" toutes les 10 s, pour que la partie ne s'arrête pas (30 s sans personne).
    if (document.hidden) {
      if (Room.data && ['lobby', 'playing'].includes(Room.data.status)) Room.timer = setTimeout(() => pollRoom(token), 10000);
      return;
    }
    // Onglet oublié ouvert (joueurs qui ne viennent pas, partie abandonnée) : pause au bout de 10 min sans changement.
    if (Date.now() - Room.changedAt > ROOM_IDLE_MS) {
      if (!$('#room-idle')) {
        $('#room-body').insertAdjacentHTML('beforeend', '<p class="room-wait" id="room-idle" style="animation:none">Paused after 10 minutes without activity. <button class="btn" id="room-resume">Resume</button></p>');
        $('#room-resume').addEventListener('click', () => { $('#room-idle').remove(); Room.changedAt = Date.now(); pollRoom(Room.token); });
      }
      return;
    }
    // Partie finie : sondée plus lentement, seulement pour voir arriver la revanche.
    const d = Room.data;
    if (d && d.status === 'abandoned') return;
    if (!d || d.status !== 'done') Room.timer = setTimeout(() => pollRoom(token), nextPollMs(d));
    else if (!d.next && d.players.some(p => p.me)) Room.timer = setTimeout(() => pollRoom(token), 4000);
  }

  // Rythme du sondage selon ce qui peut arriver : vite seulement quand une manche peut partir sans action de ma part
  // (je suis prêt et j'attends les autres), sinon plus lentement — mes propres actions reçoivent l'état aussitôt.
  function nextPollMs(d) {
    if (Room.anim) return 3000;
    if (!d || d.status !== 'playing') return 3000;
    const me = d.players.find(p => p.me);
    if (!me) return 2000; // spectateur
    if (me.ready) return ROOM_POLL_MS;
    // Pas prêt : la manche ne part qu'au départ automatique (heure connue) ; on sonde juste après.
    const auto = d.autoAt ? d.autoAt - serverNow() : Infinity;
    return Math.max(ROOM_POLL_MS, Math.min(4000, auto + 200));
  }

  function applyRoom(d, token, sent, got) {
    if (token !== Room.token || currentView !== 'room') return;
    // Décalage avec l'horloge du serveur, pris sur l'échange le plus rapide (comme NTP).
    if (got - sent <= Room.rtt) {
      Room.rtt = got - sent;
      Room.offset = d.now - (sent + got) / 2;
    }
    const sig = JSON.stringify([d.status, d.players.length, d.rounds.length, d.players.map(p => p.ready), d.next]);
    if (sig !== Room.sig) {
      Room.sig = sig;
      Room.changedAt = Date.now();
    }
    if (!Room.data) {
      // Arrivée en cours de partie : les manches déjà finies s'affichent sans animation.
      Room.shown = d.rounds.filter(r => r.revealAt - Room.offset + roundLength() < Date.now()).length;
    }
    Room.data = d;
    drawRoom();
    for (const r of d.reacts || []) {
      const key = `${r.t}:${r.name}:${r.e}`;
      if (Room.reactSeen.has(key)) continue;
      Room.reactSeen.add(key);
      const wait = r.t - serverNow();
      if (wait > 0) setTimeout(() => { if (currentView === 'room') reactBubble(r); }, wait);
      else if (wait > -6000) reactBubble(r);
    }
    if (!Room.anim && Room.shown < d.rounds.length) playRound(Room.shown);
  }

  // Réactions : bulles qui montent au-dessus des cartes, avec le nom de l'envoyeur.
  function reactBubble(r) {
    const layer = $('#react-layer');
    if (!layer) return;
    const el = document.createElement('span');
    el.className = 'react-bubble';
    el.style.left = `${8 + Math.random() * 84}%`;
    el.innerHTML = `${emoteHTML(r.e)}<small>${esc(r.name)}</small>`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  async function sendReaction(emoji) {
    if (Room.reactBusy || !Room.data || !Room.data.players.some(p => p.me)) return;
    Room.reactBusy = true;
    setTimeout(() => { Room.reactBusy = false; }, 700);
    const token = Room.token, sent = Date.now();
    try {
      applyRoom(await Online.roomAction('react', Room.code, { emoji }), token, sent, Date.now());
    } catch (err) {
      if (err.status !== 429) toast('Reaction not sent');
    }
  }

  // Durée d'une révélation : les chiffres au rythme d'origine, puis l'XP et le gagnant de la manche.
  const roundLength = () => REVEAL.digitStart + Array.from({ length: 5 }, (_, i) => digitDelay(i, 6)).reduce((x, y) => x + y, 0) + 1500;
  const serverNow = () => Date.now() + Room.offset;

  // Score affiché : seulement les manches déjà révélées à l'écran.
  function shownScore() {
    const d = Room.data, count = d.players.length;
    const wins = Array(count).fill(0), totals = Array(count).fill(0);
    d.rounds.slice(0, Room.shown).forEach(r => {
      r.s.forEach((v, i) => { totals[i] += v; });
      if (r.winner !== null) wins[r.winner]++;
    });
    return { wins, totals };
  }

  // Ne remplace le contenu que s'il a changé : redessiner un bouton à chaque sondage pourrait avaler un clic.
  function setHTML(el, html) {
    if (!el || el.dataset.html === html) return false;
    el.innerHTML = html;
    el.dataset.html = html;
    return true;
  }

  function drawRoom() {
    const d = Room.data, body = $('#room-body');
    if (!body) return;
    const me = d.players.find(p => p.me);

    if (d.status === 'abandoned' && !Room.anim) {
      if (Room.view === 'abandoned') return;
      Room.view = 'abandoned';
      body.innerHTML = `
        <div class="room-code-box">
          <div class="room-result">⏹ This duel ended</div>
          <p class="panel-note">Everyone left for more than 30 seconds, so nothing was counted for this game (your rolls still are).</p>
          <div class="room-buttons"><a class="btn-roll small" href="#/duel">⚔️ New game</a><a class="btn" href="#/">Home</a></div>
        </div>`;
      return;
    }

    if (d.status === 'lobby') {
      if (Room.view !== 'lobby') {
        Room.view = 'lobby';
        body.innerHTML = '<div class="room-code-box" id="room-lobby"></div>';
      }
      const host = d.players.find(p => p.host);
      const seats = d.players.map(p => `<span class="badge-pill">${p.host ? '👑 ' : ''}${p.bot ? '🤖 ' : ''}${esc(p.name)}${titleEmoji(p.title)}${p.me ? ' (you)' : ''}</span>`).join('')
        + '<span class="badge-pill empty-seat">…</span>'.repeat(Math.max(0, d.size - d.players.length));
      const wait = !me ? '' : me.host
        ? (d.players.length > 1 ? 'Start now, or wait: the game starts by itself when it is full' : 'Waiting for players…')
        : `Waiting for ${esc(host.name)} to start (or for the game to fill up)…`;
      const html = `
        <div class="eyebrow">Duel code</div>
        <div class="room-code mono">${esc(d.code)}</div>
        <p class="panel-note">${d.size} players · ${goalText(d)} · each round goes to the highest roll${stakeText(d)}</p>
        <div class="pill-row room-seats">${seats}</div>
        <p class="panel-note">${d.players.length} / ${d.size} players</p>
        <div class="room-buttons">
          ${me ? '<button class="btn" id="room-share">Share invite</button>' : '<button class="btn-roll small" id="room-join">⚔️ Join</button>'}
          ${me && me.host && d.players.length < d.size ? '<button class="btn" id="room-bot">🤖 Add a bot</button>' : ''}
          ${me && me.host && d.players.length > 1 ? `<button class="btn-roll small" id="room-start">Start now with ${d.players.length}</button>` : ''}
        </div>
        ${wait ? `<p class="room-wait">${wait}</p>` : ''}`;
      if (setHTML($('#room-lobby'), html)) {
        const share = $('#room-share');
        if (share) share.addEventListener('click', () => shareOrCopy(`⚔️ Live duel on RNG∞ (${d.size} players, ${goalText(d)}), code ${d.code}\n${location.origin + location.pathname + roomHref(d.code)}`, 'Duel invite'));
        const join = $('#room-join');
        if (join) join.addEventListener('click', () => joinRoom(d.code));
        const start = $('#room-start');
        if (start) start.addEventListener('click', () => roomSend('start', start));
        const addBot = $('#room-bot');
        if (addBot) addBot.addEventListener('click', () => roomSend('addBot', addBot));
      }
      return;
    }

    const seats = `${d.players.length}|${!!me}`;
    if (Room.view === 'playing' && Room.seats !== seats && !Room.anim) Room.view = null; // quelqu'un est entré en cours de partie
    if (Room.view !== 'playing') {
      Room.view = 'playing';
      Room.seats = seats;
      body.innerHTML = `
        <p class="panel-note profile-sub">${d.players.length} players · ${goalText(d)} · each round goes to the highest roll · ${d.bots ? 'with bots: your rolls count, but not duel wins or rivalries' : 'duel rolls count on the leaderboard'}${stakeText(d)}</p>
        <div class="room-board" id="room-board"></div>
        <div class="room-arena">
          <div class="room-stage${d.players.length > 2 ? ' many' : ''}" id="room-stage"></div>
          <div class="react-layer" id="react-layer" aria-hidden="true"></div>
        </div>
        ${me ? `<div class="room-reacts" id="room-reacts">${REACTIONS.map((e, i) => `<button class="react-btn" data-react="${e}" title="${EMOTE_LABELS[e]} (press ${i + 1})">${emoteHTML(e)}</button>`).join('')}</div>` : ''}
        <div class="room-actions"><div id="room-cta"></div><p class="hint" id="room-hint"></p></div>
        <div class="panel"><div class="panel-head"><h3 class="panel-title">Rounds</h3></div><div id="room-rounds"></div></div>`;
      if (!Room.anim) { $('#room-stage').innerHTML = stageHTML(Room.shown ? d.rounds[Room.shown - 1] : null); Room.skinSig = skinSig(d); }
      const reacts = $('#room-reacts');
      if (reacts) reacts.addEventListener('click', e => { const b = e.target.closest('[data-react]'); if (b) sendReaction(b.dataset.react); });
    }
    // Un joueur a changé de skin dans Shop : ses cartes changent entre deux manches, jamais pendant une révélation.
    if (!Room.anim && $('#room-stage') && Room.skinSig !== skinSig(d)) {
      const r = Room.shown ? d.rounds[Room.shown - 1] : null;
      $('#room-stage').innerHTML = stageHTML(r);
      if (r && r.winner !== null) d.players.forEach((p, j) => { if (j !== r.winner) $(`#rs-${j}`).classList.add('lost'); });
      Room.skinSig = skinSig(d);
    }

    // Classement de la partie : manches gagnées (puis XP), ou barre de progression vers le palier d'XP.
    const { wins, totals } = shownScore();
    const order = d.players.map((p, i) => i).sort((x, y) => (d.mode === 'xp' ? totals[y] - totals[x] : wins[y] - wins[x] || totals[y] - totals[x]));
    setHTML($('#room-board'), order.map((i, k) => {
      const p = d.players[i];
      const metric = d.mode === 'xp'
        ? `<span class="xp-bar"><span style="width:${Math.min(100, (totals[i] / d.target) * 100)}%"></span></span><span class="mono">${compact(totals[i])} / ${compact(d.target)}</span>`
        : `<span class="mono board-wins">${wins[i]} / ${d.target}</span><span class="panel-note">${compact(totals[i])} XP</span>`;
      const ready = d.status === 'playing' && p.ready && !Room.anim ? '<span class="ready-chip">ready</span>' : '';
      const who = p.bot ? `<span class="bot-name">🤖 ${esc(p.name)}</span>` : `<a class="player-link" href="${profileHref(p.name)}">${esc(p.name)}</a>`;
      return `<div class="board-row${p.me ? ' me' : ''}" data-pi="${i}"><span class="rank">${k + 1}</span>${who}${titleHTML(p.title)}${p.me ? '<span class="muted">(you)</span>' : ''}${ready}<span class="board-metric">${metric}</span></div>`;
    }).join(''));

    const finished = d.status === 'done' && Room.shown === d.rounds.length && !Room.anim;
    const people = d.players.filter(p => !p.bot); // les bots sont toujours prêts : on ne compte que les humains
    const readyCount = people.filter(p => p.ready).length;
    const countdown = d.autoAt ? ` · starts by itself in ${Math.max(0, Math.ceil((d.autoAt - serverNow()) / 1000))} s` : '';
    let cta, hint = '';
    // Les succès du duel arrivent avec la révélation de la dernière manche : annoncés dès qu'ils changent.
    if (finished && d.achievements && Room.achNoted !== JSON.stringify(d.achievements)) {
      Room.achNoted = JSON.stringify(d.achievements);
      noteAchievements(d.achievements);
    }
    if (finished) {
      const w = d.winner;
      const how = w === null ? '' : d.mode === 'xp' ? ` with ${fmt(totals[w])} XP` : ` with ${plural(wins[w], 'round')}`;
      const pot = !d.stake ? '' : w === null ? ' · stakes refunded' : ` · 🪙 ${fmt(d.pot)} pot`;
      const banner = (w === null ? '🤝 Draw' : d.players[w].me ? `🏆 You win${how}` : `🏆 ${esc(d.players[w].name)} wins${how}`) + pot;
      const rematch = !me ? ''
        : d.next ? `<button class="btn-roll small" id="room-rematch">🔁 ${d.nextBy === me.name ? 'Back to the rematch' : `${esc(d.nextBy)} wants a rematch: play`}</button>`
        : '<button class="btn-roll small" id="room-rematch">🔁 Rematch</button>';
      cta = `<div class="room-result">${banner}</div><div class="room-buttons">${rematch}<a class="btn" href="#/duel">New game</a></div>`;
    } else if (Room.anim) {
      cta = `<p class="room-wait">Round ${Room.shown + 1}…</p>`;
    } else if (!me) {
      cta = `<p class="room-wait">Watching live</p>${d.asked ? '<p class="panel-note">Request sent: waiting for the host…</p>' : d.canAsk ? '<button class="btn-roll small" id="room-ask">⚔️ Ask to join</button>' : ''}`;
      hint = `${readyCount} / ${people.length} ready${countdown}`;
    } else if (me.ready) {
      const missing = people.filter(p => !p.ready).map(p => p.name);
      cta = `<p class="room-wait">Waiting for ${missing.length <= 3 ? esc(missing.join(', ')) : `${missing.length} players`}…</p>`;
      hint = `${readyCount} / ${people.length} ready${countdown}`;
    } else {
      cta = `<button class="btn-roll" id="room-roll">🎲 Roll round ${d.rounds.length + 1}</button>`;
      hint = `${readyCount && people.length > 1 ? `${readyCount} / ${people.length} ready${countdown} · ` : ''}press <kbd>Space</kbd>`;
    }
    if (!finished && d.asks && d.asks.length) cta += d.asks.map(n => `<div class="room-ask"><span><b>${esc(n)}</b> wants to join</span><button class="btn-roll small" data-accept="${esc(n)}">Accept</button><button class="btn" data-decline="${esc(n)}">Decline</button></div>`).join('');
    if (setHTML($('#room-cta'), cta)) {
      const askBtn = $('#room-ask');
      if (askBtn) askBtn.addEventListener('click', () => (Store.player.name ? roomSend('ask', askBtn) : askName(() => roomSend('ask'))));
      $('#room-cta').querySelectorAll('[data-accept], [data-decline]').forEach(b => b.addEventListener('click', () => roomSend(b.dataset.accept ? 'accept' : 'decline', b, { who: b.dataset.accept || b.dataset.decline })));
      const roll = $('#room-roll');
      if (roll) roll.addEventListener('click', roomReady);
      const rematchBtn = $('#room-rematch');
      if (rematchBtn) rematchBtn.addEventListener('click', roomRematch);
    }
    setHTML($('#room-hint'), hint);

    // Manches : le gagnant et son nombre, plus le mien si ce n'est pas moi.
    const mine = d.players.findIndex(p => p.me);
    const numberCard = (r, j, i) => {
      const a = analysis(r.n[j]);
      return `<span class="num-card sm" data-tier="${a.tier}" data-number="${r.n[j]}" data-caption="${esc(`${d.players[j].name} · round ${i + 1}`)}" style="cursor:pointer">${a.str}</span>`;
    };
    setHTML($('#room-rounds'), Room.shown ? d.rounds.slice(0, Room.shown).map((r, i) => `
      <div class="room-round">
        <span class="rank">${i + 1}</span>
        ${r.winner === null ? '<span class="muted">tie at the top</span>' : `${numberCard(r, r.winner, i)}<span>🏆 ${esc(d.players[r.winner].name)} · ${compact(r.s[r.winner])} XP</span>`}
        ${mine >= 0 && mine !== r.winner && r.n[mine] != null ? `<span class="room-round-mine">you: ${numberCard(r, mine, i)}</span>` : ''}
      </div>`).join('') : '<div class="empty">No round yet.</div>');
  }

  // Badges d'une carte de duel : les 2 plus gros, + le nombre des autres. Survol = détail (description, calcul, XP,
  // badges inclus) ; clic = fiche du badge (sur téléphone, sans survol).
  function duelBadgesHTML(a, n) {
    const tipOf = g => {
      const b = g.badge, detail = badgeDetail(b.id, n);
      const subs = g.subsidiary.length ? `<br><span style="opacity:.75">Includes ${g.subsidiary.map(sb => `${sb.emoji} ${esc(sb.label)}`).join(', ')}</span>` : '';
      return `<b>${b.emoji} ${esc(b.label)}</b> · ${b.tier}<br>${esc(b.desc)}${detail ? `<br><b>${esc(detail)}</b>` : ''}<br><b>+${fmt(b.score)} XP</b>${subs}`;
    };
    const pills = a.groups.slice(0, 2).map(g => `<span class="badge-pill" data-tier="${g.badge.tier}" data-badge="${g.badge.id}" data-tip="${esc(tipOf(g))}" style="cursor:help">${g.badge.emoji} ${esc(g.badge.label)}</span>`);
    const rest = a.groups.slice(2);
    if (rest.length) {
      const list = rest.map(g => `${g.badge.emoji} ${esc(g.badge.label)} · +${fmt(g.badge.score)} XP`).join('<br>');
      pills.push(`<span class="badge-pill more-pill" data-tip="${esc(`<b>${plural(rest.length, 'more badge')}</b><br>${list}`)}" style="cursor:help">+${rest.length}</span>`);
    }
    return pills.join('');
  }

  const skinSig = d => d.players.map(p => p.skin || '').join('|');

  // Scène : une carte par joueur. Sans manche : "??????" ; sinon la manche révélée, avec son gagnant.
  function stageHTML(r, spinning = false) {
    const d = Room.data;
    const sides = d.players.map((p, j) => {
      const a = r && !spinning && r.n[j] != null ? analysis(r.n[j]) : null; // arrivé en cours de partie : pas de nombre pour les manches d'avant
      const won = a && r.winner === j;
      const card = withLever(a
        ? `<div class="num-card md${skinClass(p.skin)}" data-tier="${a.tier}" data-number="${r.n[j]}" data-caption="${esc(p.name)}" style="cursor:pointer">${slotsHTML(a.str)}</div>`
        : `<div class="num-card md neutral${spinning ? ' charging' : ''}${skinClass(p.skin)}" id="rc-${j}">${'??????'.split('').map(c => `<span class="slot${spinning ? ' spinning' : ''}">${spinning ? '0' : c}</span>`).join('')}</div>`, p.skin);
      return `
        <div class="room-side${won ? ' won' : ''}${p.me ? ' me' : ''}${skinClass(p.skin).replace('skin-', 'side-')}" id="rs-${j}">${Shop.resolve(p.skin) === 'fire' ? '<span class="side-embers" aria-hidden="true"></span>' : ''}
          <div class="room-name">${won ? '🏆 ' : ''}${p.bot ? '🤖 ' : ''}${esc(p.name)}${titleEmoji(p.title)}</div>
          ${card}
          <div class="room-meta" id="rm-${j}">${a ? `${tierPill(a.tier)}<span class="ep-pill">${fmt(a.total)} XP</span>` : ''}</div>
          <div class="pill-row" id="rb-${j}">${a ? duelBadgesHTML(a, r.n[j]) : ''}</div>
        </div>`;
    });
    return d.players.length === 2 ? sides.join('<div class="room-vs">VS</div>') : sides.join('');
  }

  // Révélation d'une manche, en même temps chez tous les joueurs : les chiffres de toutes les cartes tombent ensemble.
  function playRound(i) {
    const d = Room.data, r = d.rounds[i];
    const stage = $('#room-stage');
    if (!stage) return;
    const sides = r.n.map((n, j) => ({ n, s: r.s[j], a: analysis(n) }));
    const slotCount = Math.max(6, ...sides.map(x => x.a.str.length));
    stage.innerHTML = stageHTML(r, true);
    Room.skinSig = skinSig(d);
    const cards = sides.map((x, j) => $(`#rc-${j}`));
    cards.forEach(c => { c.innerHTML = Array.from({ length: slotCount }, () => '<span class="slot spinning">0</span>').join(''); });
    const slots = cards.map(c => Array.from(c.querySelectorAll('.slot')));
    const padded = sides.map(x => x.a.str.padStart(slotCount, '0'));

    // Mon tirage n'entre dans l'historique qu'une fois révélé (une seule fois, même après rechargement) : un autre onglet
    // ouvert sur History ne peut pas le montrer avant. Le serveur fait de même (queueReveal dans api/room.js).
    const mine = d.players.findIndex(p => p.me);
    const keepMine = () => {
      if (mine < 0 || !sides[mine] || Store.rolls.some(x => x[0] === sides[mine].n && x[2] === r.t)) return;
      Collection.ensure();
      Store.addRoll(sides[mine].n, sides[mine].s, r.t);
      Collection.add(Store.rolls[Store.rolls.length - 1], Store.rolls.length - 1);
    };

    let revealed = 0;
    const timers = [];
    // Sons, plus discrets qu'en solo (encore plus à trois joueurs ou plus). Manche rattrapée en retard (rechargement,
    // onglet endormi) : tout tombe d'un coup, donc en silence.
    const late = r.revealAt - Room.offset + REVEAL.digitStart - Date.now() < -250;
    const sfx = (type, o) => { if (!late) Sound.play(type, o); };
    const size = sides.length <= 2 ? {} : { small: 1 };
    // La signature du créateur se joue aussi en duel, sur sa carte (skin Owner équipé).
    const ownerFx = late ? [] : d.players.map((p, j) => (Shop.resolve(p.skin) === 'owner' && cards[j] && cards[j].offsetParent ? SkinFX.mount(cards[j].offsetParent, cards[j], '', { owner: true }) : null));
    const spin = setInterval(() => {
      slots.forEach((list, j) => { for (let k = revealed; k < slotCount; k++) list[k].textContent = spinChar(cards[j]); });
      if (!late && revealed < slotCount) Sound.tick({ soft: 1 });
    }, 55);
    const at = (ms, fn) => timers.push(setTimeout(fn, Math.max(0, r.revealAt - Room.offset + ms - Date.now())));
    let clock = REVEAL.digitStart;
    for (let k = 0; k < slotCount; k++) {
      if (k) clock += digitDelay(k - 1, slotCount);
      at(clock, () => {
        slots.forEach((list, j) => {
          list[k].textContent = padded[j][k];
          list[k].classList.remove('spinning');
          list[k].classList.add('revealed');
          if (k < slotCount - sides[j].a.str.length) list[k].classList.add('ghost');
        });
        sides.forEach((x, j) => replay($(`#rs-${j}`), 'thump'));
        revealed = k + 1;
        ownerFx.forEach((fx, j) => { if (fx) fx.lock(slots[j][k], { ghost: k < slotCount - sides[j].a.str.length, last: k === slotCount - 1 }); });
        sfx('lock', { i: k, soft: 1 });
      });
    }
    at(clock + 600, () => {
      clearInterval(spin);
      keepMine();
      sfx('reveal', size);
      ownerFx.forEach((fx, j) => { if (fx) fx.reveal(sides[j].a.tier); });
      sides.forEach((x, j) => {
        cards[j].classList.remove('neutral', 'charging');
        cards[j].dataset.tier = x.a.tier;
        $(`#rm-${j}`).innerHTML = `${tierPill(x.a.tier)}<span class="ep-pill">0 XP</span>`;
        countUp($(`#rm-${j} .ep-pill`), 0, x.s, reducedMotion ? 0 : 700, v => `${fmt(v)} XP`);
        $(`#rb-${j}`).innerHTML = duelBadgesHTML(x.a, x.n);
        // À 3 joueurs ou plus, les confettis seulement pour moi et le gagnant de la manche (10 salves = saccades).
        if (sides.length <= 2 || d.players[j].me || r.winner === j) FX.celebrate(x.a.tier, cards[j]);
      });
    });
    at(clock + 1500, () => {
      if (r.winner !== null) {
        const side = $(`#rs-${r.winner}`);
        side.classList.add('won');
        side.querySelector('.room-name').insertAdjacentHTML('afterbegin', '<span class="trophy-drop">🏆</span> ');
        shockwave(cards[r.winner], sides[r.winner].a.tier === 'common' || sides[r.winner].a.tier === 'trash' ? 'uncommon' : sides[r.winner].a.tier);
        d.players.forEach((p, j) => { if (j !== r.winner) $(`#rs-${j}`).classList.add('lost'); });
        sfx('win', size);
      }
      Room.anim = null;
      Room.shown = i + 1;
      drawRoom();
      if (r.winner !== null) replay($(`.board-row[data-pi="${r.winner}"]`), 'bump');
      if (Room.shown < Room.data.rounds.length) playRound(Room.shown);
    });
    // Animation coupée (on quitte le duel) : le tirage est gardé quand même, à l'heure où il aurait été révélé.
    Room.anim = { cancel() { timers.forEach(clearTimeout); clearInterval(spin); Sound.stop(); ownerFx.forEach(fx => { if (fx) fx.stop(); }); at(clock + 600, keepMine); } };
    drawRoom();
  }

  // ---------------------------------------------------------------- leaderboard / à propos
  // Classement du meilleur tirage de chaque joueur (tirages illimités : l'XP total récompenserait juste le plus gros cliqueur).
  const lbState = { period: 'day' };
  let lbTimer = 0;

  function renderLeaderboard() {
    currentView = 'leaderboard';
    const name = Store.player.name;
    const tabs = [['day', 'Today'], ['week', 'This week'], ['all', 'All-time'], ['xp', 'Lifetime XP']];
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Leaderboard</h1>
        <div id="today-slot"></div>
        <div class="lb-card">
          <div class="lb-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-period="${k}" class="${lbState.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div id="lb-list"><div class="empty">Loading…</div></div>
        </div>
        <p class="panel-note" style="text-align:center;margin-top:.9rem">
          <span id="lb-rule">${lbState.period === 'xp' ? 'Total XP of every roll ever made' : 'Best single roll per player · days reset at midnight UTC'}</span> ·
          ${name ? `playing as <b>${esc(name)}</b> · <a href="javascript:void 0" id="lb-name">change</a>` : '<a href="javascript:void 0" id="lb-name">pick a name</a>'}
        </p>
      </div>`;
    $('#lb-name').addEventListener('click', openSettings);
    $('.lb-tabs').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      lbState.period = btn.dataset.period;
      document.querySelectorAll('.lb-tabs button').forEach(b => b.classList.toggle('on', b === btn));
      $('#lb-rule').textContent = lbState.period === 'xp' ? 'Total XP of every roll ever made' : 'Best single roll per player · days reset at midnight UTC';
      $('#lb-list').innerHTML = '<div class="empty">Loading…</div>';
      drawLeaderboard();
    });
    loadTodayCard($('#today-slot'));
    drawLeaderboard();
  }

  async function drawLeaderboard() {
    clearTimeout(lbTimer);
    const period = lbState.period;
    let data;
    try {
      data = await Online.leaderboard(period);
    } catch (err) {
      if ($('#lb-list')) $('#lb-list').innerHTML = '<div class="empty">Leaderboard unavailable right now.</div>';
      return;
    }
    if (currentView !== 'leaderboard' || period !== lbState.period || !$('#lb-list')) return;
    const when = { day: 'today', week: 'this week', all: 'yet', xp: 'yet' }[period];
    $('#lb-list').innerHTML = data.entries.length
      ? data.entries.map(lbRowHTML).join('') + (data.mine ? `<div class="lb-gap">···</div>${lbRowHTML(data.mine)}` : '')
      : `<div class="empty">No rolls ${when}, be the first!</div>`;
    // Rafraîchi seulement quand l'onglet est visible : un onglet oublié ne doit pas vider le quota gratuit de la base.
    if (!document.hidden) lbTimer = setTimeout(() => { if (currentView === 'leaderboard') drawLeaderboard(); }, 60000);
  }

  // XP à vie : des milliards possibles, affichés en abrégé (le détail au survol).
  const compactXp = v => `<span title="${fmt(v)} XP">${v >= 1e6 ? compact(v) : fmt(v)} XP</span>`;
  function lbRowHTML(e) {
    const a = analysis(e.n);
    const xp = lbState.period === 'xp';
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[e.rank];
    return `
      <div class="lb-row${e.me ? ' me' : ''}" data-number="${e.n}" data-caption="${esc(`#${e.rank} · ${e.name} · ${relTime(e.t)}`)}">
        <span class="lb-rank">${medal || '#' + e.rank}</span>
        <span class="lb-who"><a class="lb-name" href="${profileHref(e.name)}" title="See ${esc(e.name)}'s profile">${esc(e.name)}${e.me ? ' <span class="muted">(you)</span>' : ''}</a>${titleHTML(e.title)}</span>
        <span class="lb-rolls mono" title="Rolls by this player ${{ day: 'today', week: 'this week', all: 'in total', xp: 'in total' }[lbState.period]}">${e.rolls ? plural(e.rolls, 'roll') : '–'}</span>
        <span class="num-card sm" data-tier="${a.tier}"${xp ? ' title="Best roll"' : ''}>${a.str}</span>
        <span class="lb-ep mono${xp ? ' lifetime' : ''}"${xp ? ' title="Lifetime XP"' : ''}>${xp ? compactXp(e.s) : `${fmt(e.s)} XP`}</span>
      </div>`;
  }

  function renderAbout() {
    currentView = 'about';
    const cardRows = [['trash', 'bottom 1%'], ['common', 'bottom 50%'], ['uncommon', 'top 50–25%'], ['rare', 'top 25–10%'], ['epic', 'top 10–5%'], ['anomaly', 'top 5–1%'], ['mythic', 'top 1%']];
    const badgeRows = [['common', 'more than 10% of rolls'], ['uncommon', '1–10% of rolls'], ['rare', '0.1–1% of rolls'], ['epic', '0.01–0.1% of rolls'], ['anomaly', '0.001–0.01% of rolls'], ['mythic', 'under 0.001% (1 in 100,000+)']];
    app.innerHTML = `
      <div class="page prose">
        <h1 class="page-title">What is RNG∞?</h1>
        <p>A random number game with no daily limit. Each roll draws a number from 0 to 1,000,000. The number is checked against ${Engine.badges.length} patterns — palindromes, primes, repeated digits, meme numbers, sequences and more — and every badge it earns is worth XP (experience points).</p>
        <button class="trailer-thumb" data-trailer aria-label="Watch the trailer">
          <img src="media/trailer-16x9.jpg" alt="RNG∞ trailer: a Mythic roll, 777777" width="1280" height="720" loading="lazy">
          <span class="trailer-play">${playIcon()} Watch the trailer · 30 s</span>
        </button>
        <div class="steps">
          <div class="step"><span class="n">1</span><span><b>Roll</b> — hit Generate (or Space) as often as you like.</span></div>
          <div class="step"><span class="n">2</span><span><b>Discover</b> — see which badges your number earns.</span></div>
          <div class="step"><span class="n">3</span><span><b>Collect</b> — fill the ${Engine.badges.length}-badge collection.</span></div>
          <div class="step"><span class="n">4</span><span><b>Track</b> — every roll is kept in your history and stats.</span></div>
        </div>
        <h2 class="panel-title">Number rarity</h2>
        <p>Your roll's rarity compares its total XP with every possible roll.</p>
        <div class="rarity-table">${cardRows.map(([t, l]) => `${tierPill(t)}<span>${l}</span>`).join('')}</div>
        <h2 class="panel-title">Badge rarity & XP</h2>
        <p>A badge is worth <span class="mono">100 × 1,000,001 ÷ (numbers that earn it)</span> XP, so a badge earned by 1 number in 1,000 is worth about 100,000 XP. Related badges form a family (e.g. Pair → Two Pair → Three Pair); only the best badge of a family counts toward your total.</p>
        <div class="rarity-table">${badgeRows.map(([t, l]) => `${tierPill(t)}<span>${l}</span>`).join('')}</div>
        <h2 class="panel-title">Your data</h2>
        <p>Numbers are drawn by the server, so nobody can pick their own 1337. Your best roll of the day, the week and all time goes on the leaderboard under your player name.</p>
        <p>Click a name on the leaderboard to see that player's profile (best rolls, badge collection) and compare it with yours.</p>
        <p>No one around? Play a duel against bots from the Duel tab: your rolls count as usual, but not duel wins, rivalries or duel achievements.</p>
        <p>Coins and skins: every roll earns coins (more for rarer rolls) and so does every duel you win. Spend them in the Shop tab on skins that change how your number looks. In-game coins only.</p>
        <p>Achievements unlock titles: equip one from your profile and it shows next to your name on the leaderboard and in duels. They are checked by the server, so nobody can wear a title they did not earn.</p>
        <p>Duel (top menu): create a game for 2 to 10 players and send the code. Everyone rolls at the same time and all numbers are revealed together; each round goes to the highest roll. Win by being first to 1–10 round wins, or first to an XP total. Duel rolls are normal rolls, so they stay in your history and can make the leaderboard.</p>
        <p>Sign in with Google to keep your history, stats and badges on every device. You can also export them (JSON) from the player menu.</p>
        <p class="muted">Based on the daily game <a href="https://www.rngdle.com" target="_blank" rel="noopener">rngdle.com</a>: this version removes the daily limit and adds history, stats, Google sign-in and a leaderboard between friends.</p>
        <p class="muted"><a href="privacy.html">Privacy policy</a></p>
        <p><a class="btn" href="#/">Go roll</a></p>
      </div>`;
  }

  // ---------------------------------------------------------------- navigation, thème, clavier
  const ROUTES = { '': renderHome, history: renderHistory, stats: renderStats, badges: renderBadges, leaderboard: renderLeaderboard, about: renderAbout, duel: renderDuelHub, shop: renderShop, friends: renderFriends };

  function route() {
    if (session && !session.finished) session.cancel();
    FX.clear();
    clearTimeout(lbTimer);
    stopRoom();
    clearTimeout(hubTimer);
    clearTimeout(friendsTimer);
    closeModal();
    tip.hidden = true;
    const [key, ...rest] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
    if (key === 'player' && rest.length) renderProfile(decodeURIComponent(rest.join('/')));
    else if (key === 'room' && rest.length) renderRoom(rest[0]);
    else (ROUTES[key] || renderHome)();
    const navKey = key === 'player' ? 'leaderboard' : key === 'room' ? 'duel' : key;
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navKey));
    window.scrollTo(0, 0);
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const pref = Store.settings.theme;
    document.documentElement.classList.toggle('dark', pref === 'dark' || (pref === 'system' && media.matches));
    document.querySelectorAll('[data-theme-pref]').forEach(b => {
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(b.dataset.themePref === pref));
    });
  }
  media.addEventListener('change', applyTheme);
  document.querySelectorAll('[data-theme-pref]').forEach(b => b.addEventListener('click', () => {
    Store.setSetting('theme', b.dataset.themePref);
    applyTheme();
  }));

  // Son des tirages : coupé ou remis depuis la barre du haut ou les réglages. L'ancienne valeur par défaut (false, jamais
  // proposée au joueur) compte comme « activé ».
  const soundOn = () => Store.settings.sound !== 'off';
  function applySound(heard) {
    const on = soundOn(), btn = $('#sound-btn');
    Sound.enable(on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Sound on' : 'Sound off';
    if (on && heard) Sound.play('lock', { i: 3 }); // une note, pour entendre qu'il est remis
  }
  $('#sound-btn').addEventListener('click', () => {
    Store.setSetting('sound', soundOn() ? 'off' : 'on');
    applySound(true);
  });

  function syncPlayer() { $('#player-name').textContent = Store.player.name || 'Player'; }
  Store.onChange(syncPlayer);
  $('#player-btn').addEventListener('click', openSettings);

  document.addEventListener('click', e => {
    // Lien vers une page du site (profil d'un joueur…) dans une ligne cliquable : la navigation l'emporte.
    if (e.target.closest('a[href^="#/"]')) return;
    if (e.target.closest('[data-trailer]')) { e.preventDefault(); openTrailer(); return; }
    if (e.target.closest('[data-coffee]')) { e.preventDefault(); openCoffee(); return; }
    const badge = e.target.closest('[data-badge]');
    if (badge) { e.preventDefault(); openBadgeModal(badge.dataset.badge); return; }
    const number = e.target.closest('[data-number]');
    if (number) { e.preventDefault(); openNumberModal(Number(number.dataset.number), number.dataset.caption || ''); return; }
    const roll = e.target.closest('[data-roll]');
    if (roll) { e.preventDefault(); openRollModal(Number(roll.dataset.roll)); }
  });

  document.addEventListener('keydown', e => {
    const modalOpen = !!$('#modal-root').firstChild;
    if (e.key === 'Escape' && modalOpen) { closeModal(); return; }
    if (!modalOpen && currentView === 'room' && e.target.tagName !== 'INPUT') {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) roomReady();
        return;
      }
      const k = Number(e.key);
      if (k >= 1 && k <= REACTIONS.length && !e.metaKey && !e.ctrlKey && !e.altKey) { sendReaction(REACTIONS[k - 1]); return; }
    }
    if (modalOpen || (currentView !== 'home' && currentView !== 'result')) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (!e.repeat) startRoll();
    } else if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') {
      e.preventDefault();
      if (!e.repeat) startRoll();
    }
  });

  // Si la liste des badges ou leurs XP changent (ex. badge perso ajouté), on recalcule l'XP des anciens tirages.
  const SCORE_VERSION = (() => {
    let h = 0;
    for (const b of window.BADGE_META) for (const ch of b.id + b.score) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return String(h);
  })();
  Store.dedupeRolls();
  if (!Store.rolls.length && !Array.isArray(Store.settings.achSeen)) Store.setSetting('achSeen', []);
  Store.rescore(n => Engine.scoreOf(n), SCORE_VERSION);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentView === 'leaderboard') drawLeaderboard();
    if (!document.hidden && currentView === 'duel') drawLive();
    if (!document.hidden && currentView === 'room' && Room.code) {
      Room.changedAt = Date.now();
      if ($('#room-idle')) $('#room-idle').remove();
      pollRoom(Room.token);
    }
  });

  MatrixRain.watch(app);
  window.addEventListener('hashchange', route);
  applyTheme();
  applySound();
  syncPlayer();
  route();
  syncHistory().catch(() => {});
})();
