/* RNG∞ — interface : tirage animé, historique, stats, collection, réglages. */
(function () {
  'use strict';

  const Engine = RNGEngine.createEngine(window.BADGE_META, window.SCORE_PERCENTILES);
  const TIERS_DESC = ['infinite', 'godlike', 'divine', 'celestial', 'mythic', 'anomaly', 'epic', 'rare', 'uncommon', 'common', 'trash', 'garbage', 'landwaste'];
  const TIER_RANK = { landwaste: -2, garbage: -1, trash: 0, common: 1, uncommon: 2, rare: 3, epic: 4, anomaly: 5, mythic: 6, celestial: 7, divine: 8, godlike: 9, infinite: 10 };
  const TIER_EMOJI = { landwaste: '☣️', garbage: '🗑️', trash: '🟫', common: '⬜', uncommon: '🟩', rare: '🟦', epic: '🟪', anomaly: '🟧', mythic: '🟥', celestial: '💠', divine: '🌟', godlike: '⚜️', infinite: '♾️' };
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
  // L'API tourne sur notre serveur (RNG_CONFIG.apiBase) ; la copie hébergée avec le site (même domaine) sert de secours.
  // En local et sur les aperçus, tout reste sur le même domaine.
  const HOSTED = /(^|\.)rng-infinite\.com$/.test(location.hostname) || location.hostname.endsWith('github.io');
  const API_SAME = location.hostname.endsWith('github.io') ? window.RNG_CONFIG.apiFallback : '';
  const API_BASE = HOSTED && window.RNG_CONFIG.apiBase !== location.origin ? window.RNG_CONFIG.apiBase : '';
  // Notre serveur lit le JSON quel que soit le type annoncé ; la copie hébergée avec le site exige application/json.
  const API_PLAIN = API_BASE && API_BASE !== window.RNG_CONFIG.apiFallback;
  const API_RETRY_MS = 60000;
  let apiDownUntil = 0;
  const HdrCoins = {
    timer: 0,
    set(n) { const el = document.getElementById('hdr-coins'); if (!el) return; el.hidden = !Store.player.name; el.querySelector('b').textContent = innerWidth <= 520 && n >= 10000 ? compact(n) : fmt(n); el.title = `${fmt(n)} coins`; },
    // Après un tirage (pièces gagnées) : une seule relecture, un peu après le dernier.
    soon(ms = 2500) { clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), ms); },
    refresh() { if (Store.player.name && !document.hidden) Online.shop().catch(() => {}); },
  };
  // Signale au serveur un cas anormal (compteur anonyme, une fois par nom et par visite) : voir api/site.js « evt ».
  const seenEvt = new Set();
  const clientEvt = name => { if (seenEvt.has(name)) return; seenEvt.add(name); try { Online.request('/api/site', { method: 'POST', body: JSON.stringify({ action: 'evt', name }) }).catch(() => {}); } catch (e) { /* rien */ } };
  const Online = {
    // Un seul essai sur une base. Vers un autre domaine, le corps part en text/plain et sans en-tête ajouté : le
    // navigateur n'envoie alors pas de requête de contrôle avant chaque appel (deux fois moins d'allers-retours).
    async attempt(base, pathname, options) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const headers = API_PLAIN && base === API_BASE ? (options.body ? { 'Content-Type': 'text/plain' } : {}) : { 'Content-Type': 'application/json' };
        const res = await fetch(base + pathname, { ...options, signal: ctrl.signal, headers });
        // Le serveur est en train de redémarrer : la requête n'a pas été traitée, on peut la rejouer ailleurs.
        if (base && base === API_BASE && (res.status === 502 || res.status === 503)) throw Object.assign(new Error(`HTTP ${res.status}`), { unreached: true });
        // Corps lu en entier : coupé par le délai (AbortError) ou illisible, une réponse « 200 » n'est pas une réponse.
        // Avant, elle devenait {} et un tirage s'affichait « undefined » (Yentizx, 2026-10-23).
        const raw = await res.text();
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { if (res.ok) throw new Error('Bad response from the server'); }
        if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
        return body;
      } catch (err) {
        // Échec réseau (TypeError) : rien n'est arrivé au serveur. Un délai dépassé, lui, a pu être traité.
        if (err instanceof TypeError) err.unreached = true;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    // { local: true } : toujours la copie du même domaine (la balise de visite, qui a besoin du pays vu par l'hébergeur).
    // Solde en haut à droite (demandé par Sacha, 2026-10-19) : toute réponse de la boutique (casino compris) ou des
    // quêtes porte le solde du joueur ; on le recopie au passage.
    async request(pathname, options = {}) {
      const r = await this.send(pathname, options);
      // Au casino, le solde se met à jour à la fin de l'animation (showCoins), pour ne pas dévoiler le résultat avant.
      if (r && typeof r.coins === 'number' && /^\/api\/(shop|quests|name)\b/.test(pathname) && currentView !== 'gamble') HdrCoins.set(r.coins);
      return r;
    },
    async send(pathname, options = {}) {
      const { local, ...opts } = options;
      if (!API_BASE || API_BASE === API_SAME || local || Date.now() < apiDownUntil) return this.attempt(API_SAME, pathname, opts);
      try {
        return await this.attempt(API_BASE, pathname, opts);
      } catch (err) {
        const timedOut = err.name === 'AbortError';
        if (!err.unreached && !timedOut) throw err;
        apiDownUntil = Date.now() + API_RETRY_MS;
        if (timedOut) throw err;
        return this.attempt(API_SAME, pathname, opts);
      }
    },
    // nonce : le même pour chaque nouvelle tentative d'un même tirage (le serveur renvoie alors le tirage déjà fait).
    roll(nonce) {
      const p = Store.player;
      return this.request('/api/roll', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name: p.name, nonce }) });
    },
    // Chat global (api/_global.js par /api/friends) : le joueur s'identifie s'il en a un, la lecture marche sans.
    global(action, extra = {}) {
      const p = Store.player;
      return this.request('/api/friends', { method: 'POST', body: JSON.stringify({ ...(p.id && p.secret ? { playerId: p.id, secret: p.secret } : {}), action, ...extra }) });
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
    leaderboard(period, span) {
      return this.request(`/api/leaderboard?period=${period}${span ? `&span=${span}` : ''}&me=${Store.player.id}`);
    },
    profile(name, lite) {
      return this.request(`/api/profile?name=${encodeURIComponent(name)}&me=${Store.player.id}${lite ? '&lite=1' : ''}`);
    },
    shop() {
      return this.request(`/api/shop?me=${Store.player.id}`);
    },
    house() {
      return this.request('/api/shop?casino=1');
    },
    casinoTop() {
      return this.request(`/api/shop?casino=top&me=${Store.player.id}`);
    },
    shopAction(action, skin, extra = {}) {
      const p = Store.player;
      return this.request('/api/shop', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, skin, ...extra }) });
    },
    liveRooms() {
      return this.request('/api/room?live=1');
    },
    // Tournoi du jour (api/_tournament.js, par /api/room) : en POST, le secret prouve qui regarde (ses tirages cachés).
    tourney(op, extra = {}) {
      const p = Store.player;
      return this.request('/api/room', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action: 'tourney', op, ...extra }) });
    },
    shopCase(id, free) {
      const p = Store.player;
      return this.request('/api/shop', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action: 'case', case: id, free: typeof free === 'string' ? free : !!free }) });
    },
    quests() {
      return this.request(`/api/quests?me=${Store.player.id}`);
    },
    questAction(action, quest) {
      const p = Store.player;
      return this.request('/api/quests', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, quest }) });
    },
    // Boîte à suggestions et fréquentation (api/site.js) ; toujours en POST.
    site(action, extra = {}) {
      const p = Store.player;
      return this.request('/api/site', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name: p.name, action, ...extra }) });
    },
    // Photo de profil (api/_avatar.js par /api/profile, 2026-10-26) : envoi, état, file du créateur.
    avatar(op, extra = {}) {
      const p = Store.player;
      return this.request('/api/profile', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action: 'avatar', op, ...extra }) });
    },
    // Toujours en POST : le secret du joueur ne va jamais dans une adresse.
    discord(action = 'state', extra = {}) {
      const p = Store.player;
      return this.request('/api/discord', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, ...extra }) });
    },
    // Clans (api/_clan.js, routés par /api/friends) : toujours en POST, le secret prouve qui joue.
    clan(op = 'view', extra = {}) {
      return this.friends('clan', undefined, { op, ...extra });
    },
    friends(action = 'list', name, extra = {}) {
      const p = Store.player;
      return this.request('/api/friends', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, action, name, ...extra }) });
    },
    claimName(name) {
      const p = Store.player;
      return this.request('/api/name', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name, src: (() => { try { return localStorage.getItem('rng-first-src') || ''; } catch (e) { return ''; } })() }) });
    },
    // Sans "add" : renvoie tout l'historique du compte. Avec "add" : y verse ces tirages.
    history(add, fetchAll = true) {
      const p = Store.player;
      return this.request('/api/history', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, add, fetch: fetchAll }) });
    },
  };

  const app = document.getElementById('app');
  // Mode performance (réglages) : pour les tablettes et appareils qui rament. Mêmes coupes que « réduire les
  // animations » du système (pas de particules, de secousse ni de signature de skin), et en plus, par la classe perf
  // sur <html>, plus aucune animation décorative en boucle ni flou d'arrière-plan (css/style.css) ; les chiffres
  // tournent toujours.
  const osReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let reducedMotion = osReducedMotion || Store.settings.perf === 'on';
  function applyPerf() {
    const on = Store.settings.perf === 'on';
    document.documentElement.classList.toggle('perf', on);
    reducedMotion = osReducedMotion || on;
  }
  applyPerf();
  // Une révélation qui saccade (moins de ~28 images/s en moyenne pendant les chiffres) : on propose le mode
  // performance, une seule fois par appareil.
  function watchFps(ms) {
    if (Store.settings.perf === 'on' || Store.settings.perfHint || reducedMotion || !window.requestAnimationFrame) return;
    let frames = 0, first = 0;
    const tick = now => {
      if (!first) first = now;
      frames++;
      if (now - first < ms) { requestAnimationFrame(tick); return; }
      if (document.hidden || frames * 1000 / (now - first) >= 28) return;
      Store.setSetting('perfHint', 1);
      toast('Laggy? Turn on Performance mode for fewer animations (tap here)', 8000, '', openSettings);
    };
    requestAnimationFrame(tick);
  }
  let currentView = 'home';
  let session = null;

  // ---------------------------------------------------------------- utilitaires
  const $ = (sel, el = document) => el.querySelector(sel);
  const fmt = v => Math.round(v).toLocaleString('en-US');
  // Arrondi vers le bas (jamais plus que la vraie valeur) : 14 950 pièces s'affichaient « 15K » (« coin bug » signalé sur
  // Discord, 2026-10-26). On tronque à un chiffre après la virgule dans l'unité choisie, puis Intl met le K / M / B.
  const compact = v => {
    const n = Number(v) || 0, abs = Math.abs(n), unit = abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1;
    const down = unit === 1 ? Math.trunc(n) : (Math.trunc((n / unit) * 10 + 1e-9) / 10) * unit;
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(down);
  };
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // ---------------------------------------------------------------- photos de profil (demandé par Sacha, 2026-10-26)
  // Seules les images acceptées par le créateur sont publiques : une carte nom → jeton (relue toutes les 5 min), puis
  // l'image par jeton, en cache long. Sans image : l'initiale du joueur sur un rond coloré. Taille fixe (aucun saut).
  const Avatars = {
    map: {}, at: 0, busy: null,
    url(tok) { return `${API_BASE || API_SAME}/api/profile?avatar=${tok}`; },
    tok(name) { return name && Object.prototype.hasOwnProperty.call(this.map, name) ? this.map[name] : null; },
    hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360; return h; },
    html(name, cls = '') {
      const n = String(name || '?'), t = this.tok(n), ini = esc((Array.from(n.trim())[0] || '?').toUpperCase());
      return `<span class="av ${cls}" data-av="${esc(n)}" style="--av-h:${this.hue(n)}" aria-hidden="true"><i>${ini}</i>${t ? `<img alt="" loading="lazy" decoding="async" src="${this.url(t)}">` : ''}</span>`;
    },
    load(force) {
      if (this.busy) return this.busy;
      if (!force && Date.now() - this.at < 300000) return Promise.resolve();
      this.at = Date.now();
      this.busy = Online.request('/api/profile?avatars=1').then(d => { this.map = (d && d.map) || {}; this.paint(); }).catch(() => {}).finally(() => { this.busy = null; });
      return this.busy;
    },
    // Met à jour les ronds déjà affichés (carte arrivée après le dessin de la page).
    paint(root = document) {
      root.querySelectorAll('.av[data-av]').forEach(el => {
        const t = this.tok(el.dataset.av), img = el.querySelector('img');
        if (!t) { if (img) img.remove(); return; }
        if (img && img.getAttribute('src') === this.url(t)) return;
        const i = img || document.createElement('img');
        i.alt = ''; i.loading = 'lazy'; i.decoding = 'async'; i.src = this.url(t);
        if (!img) el.appendChild(i);
      });
      syncHeaderAvatar();
    },
  };
  // Image introuvable (retirée entre-temps) : l'initiale reste.
  document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.parentElement && t.parentElement.classList.contains('av')) t.remove(); }, true);
  // Bouton du joueur en haut à droite : sa photo acceptée à la place de l'icône.
  function syncHeaderAvatar() {
    const b = document.getElementById('player-btn'); if (!b) return;
    const n = Store.player.name, t = Avatars.tok(n), svg = b.querySelector('svg');
    let el = b.querySelector('.av');
    if (!t) { if (el) el.remove(); if (svg) svg.style.display = ''; return; }
    if (!el || el.dataset.av !== n) { if (el) el.remove(); b.insertAdjacentHTML('afterbegin', Avatars.html(n, 'av-xs')); }
    if (svg) svg.style.display = 'none';
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (k, word) => `${fmt(k)} ${word}${k === 1 ? '' : 's'}`;
  const precisePct = v => (v > 0 && v < .001 ? '<0.001' : v <= 0 ? '<0.001' : RNGEngine.formatPct(v));
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
  const TIER_LABEL = { landwaste: 'land waste' };
  const tierPill = tier => `<span class="pill" data-tier="${tier}">${TIER_LABEL[tier] || tier}</span>`;

  // "Top x %" / "Bottom x %" arrondi et coloré selon le percentile, comme l'écran de résultat d'origine.
  function percentileHTML(p) {
    // Jamais « <1 % » : sous 1 %, le chiffre exact (0,4 %, 0,05 %, 0,001 %).
    const text = p >= 50 ? `Top ${precisePct(100 - p)}%` : `Bottom ${precisePct(p)}%`;
    const color = p >= 95 ? '#eab308' : p >= 80 ? '#22c55e' : p >= 50 ? '#10b981' : p >= 20 ? '#f97316' : '#ef4444';
    // « environ 1 tirage sur N » aussi bon (ou aussi mauvais), dès que c'est rare (idée de PRISMA123, 2026-10-20).
    const share = p >= 50 ? 100 - p : p, n = share > 0 ? Math.round(100 / share) : 0;
    const odds = share <= 10 && n >= 10 ? ` <span class="one-in" title="${esc(`About 1 roll in ${fmt(n)} is this ${p >= 50 ? 'good' : 'bad'} or ${p >= 50 ? 'better' : 'worse'}`)}">· ~1 in ${fmt(n)}</span>` : '';
    return `<span class="top" style="color:${color}">${text}${odds}</span>`;
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
  function toast(msg, ms = 2600, kind = '', onClick = null) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast${kind ? ` ${kind}` : ''}${onClick ? ' link' : ''}`;
    el.onclick = onClick ? () => { el.hidden = true; onClick(); } : null;
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
  const ShareCard = window.RNGShareCard;
  const skinClass = raw => {
    const id = Shop.resolve(raw);
    if (id === 'owner') return ' owner-ruby'; // le rubis du créateur
    return id && id !== 'classic' && Shop.byId.has(id) ? ` skin-${id}` : '';
  };
  // Bouton de tirage (« Generate », « Roll again », « Roll round ») : il porte le skin choisi dans la boutique, par
  // défaut celui du skin de nombre équipé (css/buttons.css). settings.button = bouton à afficher, calculé depuis la
  // boutique ; tant qu'elle n'a pas répondu sur cet appareil, on suit le skin connu.
  const ROLL_BUTTONS = '#roll-btn, #r-again, #room-roll';
  const genClass = raw => {
    const id = Shop.resolve(raw === undefined ? Store.settings.button || Store.settings.skin : raw);
    return id && id !== 'classic' && (Shop.byId.has(id) || Shop.buttonById.has(id)) ? ` gen-${id}` : '';
  };
  function paintRollButtons() {
    const cls = genClass().trim();
    document.querySelectorAll(ROLL_BUTTONS).forEach(b => {
      [...b.classList].filter(c => c.startsWith('gen-') && c !== cls).forEach(c => b.classList.remove(c));
      if (cls) b.classList.add(cls);
    });
  }
  // État de la boutique reçu du serveur : skin équipé et bouton de tirage, retenus sur l'appareil.
  function applyShop(state) {
    Store.setSetting('skin', state.skin);
    Store.setSetting('button', Shop.buttonLook(state.button, state.skin, state.owned, state.buttons));
    Store.setSetting('emotes', state.emotes || []);
    Store.setSetting('coins', state.coins);
    Store.setSetting('speedLv', state.speed || 0);
    Store.setSetting('soundPack', state.sound || 'classic'); // pas 'sound' : ce réglage-là, c'est le son coupé ou non
    Store.setSetting('skinsOwned', state.owned || []);
    Store.setSetting('wall', state.wall || '');
    paintWallpaper();
    paintRollButtons();
    // Le skin Owner n'appartient qu'au créateur : c'est lui, on surveille sa boîte à suggestions.
    Room.isOwner = (state.owned || []).includes('owner');
    if ((state.owned || []).includes('owner') || Store.settings.hasSugg) Inbox.watch();
    Messages.watch();
  }
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
  // Greek : pendant le tirage, le fût de colonne tourne et montre des chiffres romains (un seul caractère Unicode, Ⅰ à Ⅸ,
  // N pour zéro, pour garder la largeur de la case) ; le chiffre arabe gravé n'apparaît qu'à la pose (lisible).
  const ROMAN = ['N', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ'];
  const spinChar = card => (card && card.classList.contains('skin-matrix') ? MatrixRain.glyph()
    : card && card.classList.contains('skin-greek') ? ROMAN[(Math.random() * 10) | 0] : String((Math.random() * 10) | 0));
  // Badges Top 1 / 5 / 10 : remis à la fin de chaque mois aux dix premiers du classement du mois, gardés pour toujours
  // (voir api/_rank.js). award = { top: 1 | 5 | 10, month: 'AAAA-MM' } ; le serveur envoie le meilleur de chacun.
  const TOP_MARKS = { 1: ['👑', 'Top 1', 'gold'], 5: ['🥈', 'Top 5', 'silver'], 10: ['🥉', 'Top 10', 'bronze'] };
  const monthLabel = month => {
    const fr = window.RNGI18n && window.RNGI18n.lang === 'fr';
    const txt = new Date(`${month}-15T12:00:00Z`).toLocaleDateString(fr ? 'fr-FR' : 'en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    return txt.charAt(0).toUpperCase() + txt.slice(1);
  };
  const topHTML = award => {
    const m = award && TOP_MARKS[award.top];
    if (!m || !/^\d{4}-\d{2}$/.test(award.month || '')) return '';
    const when = monthLabel(award.month);
    const tip = award.top === 1 ? `First place on the monthly leaderboard · ${when}` : `Top ${award.top} on the monthly leaderboard · ${when}`;
    return `<span class="top-mark ${m[2]}" title="${esc(tip)}" data-no-i18n>${m[0]} ${m[1]} · ${esc(when)}</span>`;
  };
  // Pièces versées avec le badge (mêmes montants que REWARDS dans api/_rank.js).
  const TOP_COINS = { 1: 1000, 5: 500, 10: 250 };
  const topEmoji = award => (award && TOP_MARKS[award.top] ? ` ${TOP_MARKS[award.top][0]}` : '');
  const titleHTML = id => {
    const a = id && Ach.byId.get(id);
    if (!a) return '';
    // Titres réservés : le mot seul, sans pastille, avec un reflet. Rouge béryl et couronne pour le créateur, bleu et
    // invite de terminal pour un Manager.
    if (a.hidden && (a.id === 'owner' || a.id === 'manager')) return `<span class="title-owner${a.id === 'manager' ? ' title-manager' : ''}" title="${esc(a.desc)}">${esc(a.title)}</span>`;
    // Tous les titres ont le style du titre Owner : le mot seul en petites capitales, un dégradé à leur couleur (css/style.css,
    // .tt-<id>) avec un reflet qui passe, et leur icône devant.
    return `<span class="title-owner title-fx tt-${esc(a.id)}" title="${esc(a.desc)}"><i aria-hidden="true">${a.emoji}</i>${esc(a.title)}</span>`;
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

  // ---------------------------------------------------------------- quête du jour terminée : annonce avec sa récompense
  // L'état des quêtes est gardé en mémoire et avancé sur place à chaque tirage compté (mêmes règles que le serveur,
  // js/quests.js) ; quand une quête semble atteinte, le serveur confirme avant l'annonce. Chaque quête n'est annoncée
  // qu'une fois par jour et par appareil (settings.questSeen), et jamais au chargement : pas d'avalanche d'annonces.
  const QuestWatch = {
    state: null, busy: false,
    seen() { const s = Store.settings.questSeen; return s && this.state && s.day === this.state.day ? s.ids : []; },
    ready(q) { return q.progress >= q.target && !q.claimed; },
    // Reçoit un état frais du serveur. quiet : ce qui est déjà terminé est noté sans être annoncé.
    take(state, quiet) {
      if (!state || !Array.isArray(state.quests)) return;
      this.state = state;
      const seen = this.seen(), fresh = state.quests.filter(q => this.ready(q) && !seen.includes(q.id));
      const done = state.quests.filter(q => q.progress >= q.target).map(q => q.id);
      Store.setSetting('questSeen', { day: state.day, ids: [...new Set([...seen, ...done])] });
      if (quiet || !fresh.length) return;
      const total = fresh.reduce((x, q) => x + q.reward, 0);
      const msg = fresh.length === 1
        ? `✅ Quest complete: ${fresh[0].emoji} ${fresh[0].text} · +${fresh[0].reward} 🪙 to claim on the home page`
        : `✅ ${fresh.length} quests complete · +${total} 🪙 to claim on the home page`;
      // Attend son tour si une autre annonce (succès débloqué) est encore à l'écran.
      const show = tries => {
        if (!$('#toast').hidden && tries < 12) { setTimeout(() => show(tries + 1), 700); return; }
        toast(msg, 6500, 'achv', () => { location.hash = '#/'; });
        Sound.play('lock', { i: 5 });
      };
      show(0);
    },
    async sync(quiet) {
      if (this.busy || !Store.player.name) return;
      this.busy = true;
      try { this.take(await Online.quests(), quiet); } catch (err) { /* hors ligne : on réessaiera au prochain tirage */ }
      this.busy = false;
    },
    // Après un tirage compté par le serveur (delta = compteurs du jour qu'il vient d'ajouter) ou la fin d'un duel (sans delta).
    bump(delta) {
      const today = new Date(serverNow()).toISOString().slice(0, 10);
      if (!this.state || this.state.day !== today) { this.sync(!this.state); return; }
      if (!delta) { this.sync(false); return; }
      const seen = this.seen();
      let crossed = false;
      for (const q of this.state.quests) {
        const def = Quests.byId.get(q.id);
        if (!def || q.progress >= q.target) continue;
        q.progress = Math.min(q.target, q.progress + def.value(delta));
        if (this.ready(q) && !seen.includes(q.id)) crossed = true;
      }
      if (crossed) this.sync(false);
    },
  };
  const questDelta = (score, tier) => ({ rolls: 1, xp: score, [`t:${tier}`]: 1 });

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

  // XP à vie et nombre de tirages : seuls comptent ceux que le serveur a tirés (les mêmes qu'au classement). Un tirage
  // fait hors ligne (4e case à 1, voir Store.addRoll) reste dans l'historique, marqué, sans s'ajouter au total.
  const lifetimeEP = () => Store.rolls.reduce((acc, r) => acc + (r[3] ? 0 : r[1]), 0);
  // Totaux à vie du serveur (« Stats bug », 2026-10-26) : l'appareil ne garde pas tous les tirages et leur XP enregistrée
  // date du tirage, d'où trois chiffres différents (accueil, Stats, classement). On montre ceux du serveur dès qu'on les a.
  const ServerLife = {
    at: 0, xp: null, rolls: null, busy: null,
    async load() {
      if (!Store.player.name) return null;
      if (Date.now() - this.at < 60000 && this.xp != null) return this;
      if (!this.busy) this.busy = Online.profile(Store.player.name, true).then(p => { this.xp = p.xp; this.rolls = p.rolls; this.at = Date.now(); }).catch(() => {}).finally(() => { this.busy = null; });
      await this.busy;
      return this.xp != null ? this : null;
    },
  };
  const countedRolls = () => Store.rolls.reduce((acc, r) => acc + (r[3] ? 0 : 1), 0);
  // Passer les badges déjà obtenus : une récompense pour ceux qui ont assez tiré, éteinte par défaut.
  const SKIP_BADGES_AT = 500;
  const skipBadgesOn = () => Store.settings.skipBadges === 'on' && countedRolls() >= SKIP_BADGES_AT;

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
    lines.push('', `${fmt(a.total)} XP`, `${location.origin + location.pathname}?ref=share`);
    return lines.join('\n');
  }

  // Partage d'un tirage : une carte en image (js/sharecard.js) à coller dans Discord, à télécharger ou à envoyer par la
  // feuille de partage du téléphone ; le texte d'avant reste proposé à côté.
  function share(a, owner = Store.player.name || '') {
    const rank = Engine.topLabel(a.percentile);
    const canvas = document.createElement('canvas');
    const data = {
      str: a.str, tier: a.tier, rank: rank ? cap(rank.toLowerCase()) : '', xp: fmt(a.total), name: owner, host: 'rng-infinite.com',
      badges: a.groups.slice(0, 5).map(g => ({ emoji: g.badge.emoji, label: g.badge.label, tier: g.badge.tier })), more: Math.max(0, a.groups.length - 5),
    };
    const blobOf = () => new Promise(done => canvas.toBlob(done, 'image/png'));
    const file = `rng-infinite-${a.str}.png`;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    openModal(`
      <h2>Share this roll</h2>
      <img class="share-card" id="share-img" alt="Card of the roll ${esc(a.str)}" width="1200" height="630">
      <div class="actions share-actions">
        ${touch && navigator.canShare ? '<button class="btn-roll small" id="share-send">Share image</button>' : '<button class="btn-roll small" id="share-copy">Copy image</button>'}
        <button class="btn ghost" id="share-dl">Download</button>
        <button class="btn ghost" id="share-text">Copy text</button>
      </div>
      <p class="panel-note share-note">${touch ? 'Send the image to Discord, a story or a friend.' : 'Copy the image, then paste it in Discord (Ctrl/Cmd + V).'}</p>`, async m => {
      // Les polices du site doivent être prêtes avant de dessiner, sinon le canvas retombe sur une police système.
      try { await Promise.all([document.fonts.load("900 46px 'Inter'"), document.fonts.load("700 26px 'Inter'"), document.fonts.load("700 170px 'Space Mono'")]); } catch (e) { /* dessin avec les polices disponibles */ }
      ShareCard.draw(canvas, data);
      const img = m.querySelector('#share-img');
      if (!img) return;
      img.src = canvas.toDataURL('image/png');
      const on = (id, fn) => { const b = m.querySelector(id); if (b) b.addEventListener('click', fn); };
      on('#share-copy', async () => {
        try {
          // La promesse est passée telle quelle : Safari exige que l'écriture démarre dans le clic.
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobOf() })]);
          toast('Image copied: paste it in Discord');
        } catch (e) { toast('Your browser cannot copy images: use Download'); }
      });
      on('#share-send', async () => {
        const f = new File([await blobOf()], file, { type: 'image/png' });
        try {
          if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], text: `RNG∞ 🎲 ${a.str} · ${location.origin + location.pathname}?ref=share` });
          else toast('Your browser cannot share images: use Download');
        } catch (e) { /* annulé */ }
      });
      on('#share-dl', async () => {
        const url = URL.createObjectURL(await blobOf()), link = document.createElement('a');
        link.href = url; link.download = file; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      });
      on('#share-text', () => shareOrCopy(shareText(a)));
    });
  }

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
      // Au-dessus de Mythic : plus de confettis, plus vite, et des salves qui se répètent (waves).
      celestial: { count: 300, speed: 13, colors: ['#22d3ee', '#a5f3fc', '#ffffff', '#38bdf8', '#818cf8'], waves: 2, flash: 'rgba(34,211,238,.5), rgba(129,140,248,.3) 40%, rgba(255,255,255,.12) 70%' },
      divine: { count: 340, speed: 14, colors: ['#fde047', '#fef9c3', '#ffffff', '#f59e0b', '#fbbf24'], waves: 3, flash: 'rgba(253,224,71,.6), rgba(245,158,11,.35) 40%, rgba(255,255,255,.15) 70%' },
      godlike: { count: 360, speed: 14, colors: ['#fb7185', '#fde047', '#ffffff', '#f43f5e', '#fbbf24'], waves: 4, flash: 'rgba(251,113,133,.6), rgba(253,224,71,.4) 40%, rgba(255,255,255,.18) 70%' },
      infinite: { count: 380, speed: 15, colors: ['#f472b6', '#c084fc', '#60a5fa', '#34d399', '#fde047', '#fb923c', '#ffffff'], waves: 5, flash: 'rgba(255,255,255,.75), rgba(192,132,252,.45) 35%, rgba(96,165,250,.2) 70%' },
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
    function celebrate(tier, el, wave = 0) {
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
      if ((tier === 'mythic' || c.flash) && !wave) {
        const f = document.createElement('div');
        f.className = 'flash';
        f.style.background = `radial-gradient(circle at 50% 30%, ${c.flash || 'rgba(236,72,153,.5), rgba(168,85,247,.3) 40%, rgba(34,211,238,.12) 70%'}, transparent)`;
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 1000);
        // Salves suivantes : la même gerbe, toutes les 550 ms, tant que la carte est encore à l'écran.
        if (c.waves) for (let k = 1; k < c.waves; k++) setTimeout(() => { if (el.isConnected) celebrate(tier, el, k); }, k * 550);
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
  const TIER_RING = { uncommon: '#10b981', rare: '#3b82f6', epic: '#a855f7', anomaly: '#f97316', mythic: '#ec4899', celestial: '#22d3ee', divine: '#fde047', godlike: '#fb7185', infinite: '#ffffff' };
  function shockwave(el, tier) {
    const color = TIER_RING[tier];
    if (!color || reducedMotion || !el) return;
    const r = el.getBoundingClientRect();
    const rings = TIER_RANK[tier] > TIER_RANK.mythic ? Math.min(6, TIER_RANK[tier] - 3) : TIER_RANK[tier] >= TIER_RANK.epic ? 2 : 1; // Celestial 4, Divine 5, Infinite 6
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
  // Écran tactile (iPad, téléphone : signalé par Aussie Haüs, 2026-10-23) : pas de survol, donc un toucher ouvre la bulle
  // au-dessus de l'élément, et un toucher ailleurs (ou le même) la referme.
  let tipTouch = false, tipFor = null;
  document.addEventListener('pointerdown', e => { tipTouch = e.pointerType === 'touch' || e.pointerType === 'pen'; }, { capture: true, passive: true });
  document.addEventListener('click', e => {
    if (!tipTouch) return;
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el !== tipFor) { const r = el.getBoundingClientRect(); showTip(el.dataset.tip, r.left, r.bottom - 8); tipFor = el; }
    else { tip.hidden = true; tipFor = null; }
  }, true);
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
  const TIP = { kofi: 'https://ko-fi.com/sacha9214all', paypal: 'https://paypal.me/sacha9214', wallet: '0x85c90AD40EC0914Cc8519138099F860Bb5a41E2A' };
  // ---------------------------------------------------------------- cagnotte du serveur
  // Le total du mois arrive avec la balise de visite (une fois par onglet), sinon par une petite demande gardée 5 min.
  // Le site n'encaisse rien : « Contribuer » ouvre la page de dons ; le créateur inscrit ensuite la contribution, et
  // le joueur reçoit le skin et le titre Supporter. Aucun avantage en jeu.
  const euros = cents => { const v = cents / 100; return `${Number.isInteger(v) ? v : v.toFixed(2)} €`; };
  const Fund = {
    state: null,
    set(s) { if (!s || typeof s.cents !== 'number') return; this.state = s; try { sessionStorage.setItem('rng-fund', JSON.stringify({ t: Date.now(), s })); } catch (e) { /* stockage bloqué */ } this.paint(); },
    async load() {
      if (this.state) return this.paint();
      try { const c = JSON.parse(sessionStorage.getItem('rng-fund') || 'null'); if (c && Date.now() - c.t < 120000) { this.state = c.s; return this.paint(); } } catch (e) { /* cache illisible */ }
      try { this.set(await Online.request('/api/site', { method: 'POST', body: JSON.stringify({ action: 'fundInfo' }) })); } catch (err) { /* hors ligne : pas de carte */ }
    },
    html() {
      const s = this.state;
      if (!s) return '';
      const pct = Math.min(100, (s.cents / s.goal) * 100), month = new Date(`${s.month}-15`).toLocaleDateString('en-US', { month: 'long' });
      return `
        <div class="fund-card${s.cents >= s.goal ? ' reached' : ''}">
          <div class="fund-head"><span class="eyebrow">🖥️ Server fund · ${month}</span><b class="mono" data-no-i18n>${euros(s.cents)} / ${euros(s.goal)}</b></div>
          <span class="fund-bar"><span style="width:${Math.max(pct, s.cents ? 3 : 0)}%"></span></span>
          <div class="fund-foot"><span class="panel-note"><span>${s.cents >= s.goal ? 'Goal reached this month, thank you!' : 'Pays for the server each month.'}</span> <span>Contributors get the 💗 Supporter skin and title.</span></span><button class="btn" data-fund>Contribute</button></div>
        </div>`;
    },
    paint() { document.querySelectorAll('[data-fund-slot]').forEach(el => { el.innerHTML = this.html(); }); },
  };
  function openFund() {
    const s = Fund.state || { cents: 0, goal: Shop.FUND_GOAL, url: '' }, name = Store.player.name;
    const link = s.url || TIP.kofi; // la page de dons par défaut ; la page Owner peut en régler une autre
    openModal(`
      <h2>🖥️ Server fund</h2>
      <p class="panel-note" style="margin:-.3rem 0 .8rem">RNG∞ is free and has no ads. The fund pays for the server: when it reaches ${euros(s.goal)} in a month, the game can move to a better one. Contributing is optional.</p>
      <div class="fund-perk">
        <div class="fund-perk-card"><div class="num-card md skin-supporter" data-tier="rare">${slotsHTML('235711')}</div><button class="btn ghost" data-skin-preview="supporter">▶ Preview</button></div>
        <div><b>💗 Supporter skin and title</b><span class="panel-note">A thank-you for any contribution, whatever the amount. It is only a look: no coins, no luck, no advantage in the game.</span></div>
      </div>
      <ol class="fund-steps">
        <li>Open the contribution page and give what you want.</li>
        <li>Write your player name in the message${name ? `: <b data-no-i18n>${esc(name)}</b>` : ''}.</li>
        <li>Your skin arrives right away if your name is recognised, otherwise within a day.</li>
      </ol>
      <p class="panel-note">Under 18? Ask a parent first: it is their money and their decision.</p>
      <div class="actions"><button class="btn" id="fund-close">Close</button><a class="btn-roll small" href="${esc(link)}" target="_blank" rel="noopener" style="text-decoration:none">Contribute</a></div>`, m => {
      m.querySelector('#fund-close').addEventListener('click', closeModal);
    });
  }

  function openCoffee() {
    const pay = TIP.paypal;
    openModal(`
      <h2>☕ Buy me a coffee</h2>
      <p class="panel-note" style="margin:-.3rem 0 1rem">RNG∞ is free and has no ads. If you enjoy it, you can chip in to the server fund. It is entirely optional. Write your player name in the message and you get the 💗 Supporter skin as a thank-you: only a look, no coins, no luck.</p>
      <div class="field"><label>Ko-fi (card or PayPal)</label><a class="btn-roll small" href="${TIP.kofi}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Contribute on Ko-fi</a></div>
      <div class="field"><label>PayPal</label><a class="btn" href="${pay}" target="_blank" rel="noopener" style="text-align:center;text-decoration:none">Donate with PayPal</a></div>
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
        <div class="result-actions"><button class="btn" data-share>${shareIcon()} Share</button><button class="btn" data-rewatch>▶ Rewatch</button></div>
        ${breakdownHTML(r[0], a)}
      </div>`, m => {
      m.querySelector('[data-share]').addEventListener('click', () => share(a));
      m.querySelector('[data-rewatch]').addEventListener('click', () => rewatch(r[0], `Your roll #${fmt(index + 1)}`, Store.player.name || ''));
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
      ${countedRolls() >= SKIP_BADGES_AT ? `<div class="kv"><span class="k">Skip known badges</span><span class="v"><button class="btn ghost small" id="bm-full">${(Store.settings.fullBadges || []).includes(id) ? '⭐ Always shown in full' : '⏩ Skipped when known'}</button></span></div>` : ''}
      ${holders.length ? `<div class="eyebrow" style="margin:1.1rem 0 .6rem">Your rolls with this badge${e.count > holders.length ? ` (latest ${holders.length})` : ''}</div>
        <div class="pill-row" style="justify-content:flex-start">${holders.map(i => `<button class="num-card sm" data-tier="${Engine.cardTier(Store.rolls[i][1])}" data-roll="${i}">${Store.rolls[i][0]}</button>`).join('')}</div>` : ''}
    `, m => {
      const b2 = m.querySelector('#bm-full');
      if (b2) b2.addEventListener('click', () => {
        const set = new Set(Store.settings.fullBadges || []);
        if (set.has(id)) set.delete(id); else set.add(id);
        Store.setSetting('fullBadges', [...set].slice(-300));
        b2.textContent = set.has(id) ? '⭐ Always shown in full' : '⏩ Skipped when known';
        toast(set.has(id) ? 'This badge will always get its full reveal' : 'This badge is skipped again when you already have it');
      });
    });
  }

  // Touche de tirage choisie par le joueur (idée de jia jun, 2026-10-20) : Espace par défaut, Entrée marche toujours.
  const rollKey = () => Store.settings.rollKey || 'Space';
  const keyName = (code = rollKey()) => (code === 'Space' ? 'Space' : code.replace(/^Key|^Digit|^Numpad/, '').replace(/^Arrow/, '↕ '));
  const isRollKey = e => e.code === rollKey() || (rollKey() === 'Space' && e.key === ' ');
  // Alerte des amis (idée de Jguz01, 2026-10-26) : un ami tire Celestial ou mieux → un toast, à la relève des cadeaux
  // (chaque minute). Réglage « Friend alerts » (coupé = on ne demande rien au serveur). Dernière alerte vue : bigSeen ;
  // la toute première fois, on part de maintenant (pas d'alertes d'avant).
  function bigAlertSince() {
    if (Store.settings.friendAlerts === 'off') return {};
    let seen = 0; try { seen = Number(localStorage.getItem('bigSeen')) || 0; } catch (e) { seen = 0; }
    if (!seen) { seen = Date.now(); try { localStorage.setItem('bigSeen', String(seen)); } catch (e) { /* stockage bloqué */ } }
    return { bigSince: seen };
  }
  function announceBigRolls(rows) {
    if (!rows.length || Store.settings.friendAlerts === 'off') return;
    rows.forEach((r, i) => {
      const tier = r.tier.charAt(0).toUpperCase() + r.tier.slice(1);
      setTimeout(() => toast(`🌟 ${r.name} rolled ${tier === 'Infinite' ? 'an' : 'a'} ${tier} ${r.n}!`, 6000, 'achv'), i * 1500);
    });
    try { localStorage.setItem('bigSeen', String(Math.max(...rows.map(r => r.t)))); } catch (e) { /* stockage bloqué */ }
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
        <span class="panel-note">Shown on the leaderboard. Each name belongs to one player only.${Store.player.name ? ` Changing it costs 🪙 ${fmt(Shop.RENAME_PRICE)}.` : ''}</span>
      </div>
      ${Store.player.name ? `<div class="field"><a class="btn" href="${profileHref(Store.player.name)}" id="set-profile">My profile</a></div>` : ''}
      ${Store.player.name ? avatarFieldHTML() : ''}
      ${googleAccountHTML()}
      ${passwordHTML()}
      <div class="field"><label>Roll animation</label>${seg('speed', ['dramatic', 'normal'], SPEEDS[s.speed] ? s.speed : 'normal', SPEED_LABELS)}</div>
      <div class="field"><label>Skip known badges</label>${countedRolls() >= SKIP_BADGES_AT ? seg('skipBadges', ['on', 'off'], s.skipBadges === 'on' ? 'on' : 'off') : `<span class="panel-note">🔒 Unlocks at ${fmt(SKIP_BADGES_AT)} rolls (you have ${fmt(countedRolls())})</span>`}<span class="panel-note" style="display:block;margin-top:.25rem">Badges you already own appear at once. New badges always get their full reveal. To keep a badge's full reveal anyway, open the badge and pick “Always shown in full”.</span></div>
      <div class="field"><label>Roll key</label><button class="btn" id="set-rollkey" type="button"><kbd>${esc(keyName())}</kbd> · change</button></div>
      <div class="field"><label>Sound</label>${seg('sound', ['on', 'off'], soundOn() ? 'on' : 'off')}</div>
      <div class="field"><label>Music</label>${seg('music', ['on', 'off'], Store.settings.music === 'off' ? 'off' : 'on')}<span class="panel-note" style="display:block;margin-top:.25rem">🎵 “Distant Odds” by Phong67</span></div>
      <div class="field"><label>Performance mode</label>${seg('perf', ['on', 'off'], s.perf === 'on' ? 'on' : 'off')}<span class="panel-note" style="display:block;margin-top:.25rem">Fewer animations and effects, for tablets and devices that lag. Your rolls stay the same.</span></div>
      <div class="field"><label>Theme</label>${seg('theme', ['light', 'system', 'dark'], s.theme)}</div>
      ${Store.player.name ? `<div class="field"><label>Friend alerts</label>${seg('friendAlerts', ['on', 'off'], s.friendAlerts === 'off' ? 'off' : 'on')}<span class="panel-note" style="display:block;margin-top:.25rem">A message when a friend rolls Celestial or better.</span></div>` : ''}
      ${Store.player.name ? `<div class="field"><label for="set-code">Redeem a code</label><form class="code-form" id="set-code-form"><input class="input" id="set-code" maxlength="32" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE"><button class="btn" type="submit">Redeem</button></form><span class="panel-note">Got a code? Enter it to get its prize. Each code works once.</span></div>` : ''}
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
        // Renommer coûte des pièces (2026-10-25) ; la casse ou les espaces seuls restent gratuits, comme sur le serveur.
        if (previous && !sameName(previous, name.value) && !confirm(window.RNGI18n.t(`Change your name to "${name.value.trim()}" for ${fmt(Shop.RENAME_PRICE)} coins?`))) { name.value = previous; return; }
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
      bindPassword(m);
      bindAvatarField(m);
      m.querySelectorAll('[data-seg]').forEach(group => {
        group.addEventListener('click', e => {
          const btn = e.target.closest('button');
          if (!btn) return;
          group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
          Store.setSetting(group.dataset.seg, btn.dataset.v);
          if (group.dataset.seg === 'theme') applyTheme();
          if (group.dataset.seg === 'sound') { applySound(true); Music.sync(); }
          if (group.dataset.seg === 'music') Music.sync();
          if (group.dataset.seg === 'perf') applyPerf();
        });
      });
      m.querySelector('#set-done').addEventListener('click', closeModal);
      // Code cadeau : vérifié et crédité par le serveur (api/shop.js), une fois par joueur.
      const codeForm = m.querySelector('#set-code-form');
      if (codeForm) codeForm.addEventListener('submit', async e => {
        e.preventDefault();
        const input = m.querySelector('#set-code'), btn = codeForm.querySelector('button');
        if (!input.value.trim()) return;
        btn.disabled = true;
        try {
          const st = await Online.shopAction('redeem', undefined, { code: input.value });
          Store.setSetting('coins', st.coins);
          input.value = '';
          toast(st.redeemed.hunt ? (st.redeemed.title === 'codehunter' ? `🔑 All ${st.redeemed.hunt.of} hidden codes found! +${fmt(st.redeemed.coins)} coins and the Code Hunter title` : `🔑 Hidden code ${st.redeemed.hunt.found}/${st.redeemed.hunt.of}: +${fmt(st.redeemed.coins)} coins`) : `🎁 Code ${st.redeemed.code}: +${fmt(st.redeemed.coins)} coins${st.redeemed.title ? ' and a new title' : ''}!`, 5000, 'achv');
          Sound.play('reveal', { small: 1 });
        } catch (err) {
          toast(err.status && err.status < 500 ? err.message : 'Unavailable right now, try again');
        } finally { btn.disabled = false; }
      });
      m.querySelector('#set-rollkey').addEventListener('click', e => {
        const btn = e.currentTarget;
        btn.textContent = window.RNGI18n ? window.RNGI18n.t('Press a key…') : 'Press a key…';
        const grab = ev => {
          ev.preventDefault(); ev.stopPropagation();
          document.removeEventListener('keydown', grab, true);
          if (!['Escape', 'Tab', 'Enter', 'NumpadEnter'].includes(ev.code) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) Store.setSetting('rollKey', ev.code);
          btn.innerHTML = `<kbd>${esc(keyName())}</kbd> · change`;
        };
        document.addEventListener('keydown', grab, true);
      });
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
        if (!confirm(window.RNGI18n.t(`Delete all ${fmt(k)} rolls from this device? Export first if you want to keep them.`))) return;
        Store.clearRolls();
        Collection.built = false;
        closeModal();
        toast('History cleared');
        route();
      });
    });
  }

  // Photo de profil dans les réglages (2026-10-26) : recadrage carré au centre (zoom facultatif), réencodée en JPEG
  // 256×256 sur un canvas, ce qui enlève les métadonnées (EXIF, position GPS) avant l'envoi. Personne ne la voit avant
  // que le créateur l'accepte ; le joueur voit son état (en attente, acceptée, refusée et pourquoi).
  const AV_SIDE = 256;
  function avatarFieldHTML() {
    return `<div class="field av-field"><label>Profile picture</label>
      <div class="av-set">
        <div class="av-pv" id="av-pv">${Avatars.html(Store.player.name, 'av-xl')}</div>
        <div class="av-side">
          <p class="av-status" id="av-status">Loading…</p>
          <div class="av-btns" id="av-btns"><label class="btn small av-pick">📷 Choose a picture<input type="file" id="av-file" accept="image/*" hidden></label></div>
          <div class="av-edit" id="av-edit" hidden>
            <label class="av-zoom"><span>Zoom</span><input type="range" id="av-zoom" min="1" max="3" step="0.01" value="1"></label>
            <div class="av-btns"><button class="btn small" id="av-send" type="button">Send for review</button><button class="btn ghost small" id="av-undo" type="button">Cancel</button></div>
          </div>
        </div>
      </div>
      <span class="panel-note">Don't use photos of yourself or personal info. The creator checks every picture.</span></div>`;
  }
  function bindAvatarField(m) {
    const file = m.querySelector('#av-file'); if (!file) return;
    const pv = m.querySelector('#av-pv'), status = m.querySelector('#av-status'), edit = m.querySelector('#av-edit'), zoom = m.querySelector('#av-zoom'), btns = m.querySelector('#av-btns');
    let img = null, mine = null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AV_SIDE; canvas.className = 'av-canvas';
    const draw = () => {
      const c = canvas.getContext('2d'), w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h) / Number(zoom.value);
      c.fillStyle = '#fff'; c.fillRect(0, 0, AV_SIDE, AV_SIDE); // fond blanc : les PNG transparents ne deviennent pas noirs
      c.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AV_SIDE, AV_SIDE);
    };
    const show = d => {
      mine = d;
      if (!status.isConnected) return;
      const t = s => (window.RNGI18n ? window.RNGI18n.t(s) : s);
      if (img) return;
      pv.innerHTML = d.pending ? `<span class="av av-xl"><img alt="" src="${d.pending.img}"></span>` : d.approved ? `<span class="av av-xl"><img alt="" src="${(API_BASE || API_SAME) + d.approved.url}"></span>` : Avatars.html(Store.player.name, 'av-xl');
      status.innerHTML = d.pending ? `⏳ <span>${t('Waiting for review')}</span>`
        : d.rejected ? `❌ <span>${t('Rejected')}:</span> <b>${esc(t(d.rejected.reason))}</b>${d.approved ? ` <span class="panel-note">${t('(your previous picture stays)')}</span>` : ''}`
        : d.approved ? `✅ <span>${t('Approved')}</span>` : `<span>${t('No picture yet')}</span>`;
      btns.querySelectorAll('[data-av-withdraw]').forEach(x => x.remove());
      if (d.pending) btns.insertAdjacentHTML('beforeend', `<button class="btn ghost small" type="button" data-av-withdraw>${t('Withdraw')}</button>`);
      btns.querySelector('.av-pick').classList.toggle('disabled', !d.left);
      if (!d.left) status.insertAdjacentHTML('beforeend', ` <span class="panel-note">${t('5 pictures a day: try again tomorrow.')}</span>`);
    };
    const fail = err => toast(err && err.status && err.status < 500 ? err.message : 'Unavailable right now, try again');
    Online.avatar('mine').then(show).catch(() => { status.textContent = window.RNGI18n ? window.RNGI18n.t('Unavailable right now.') : 'Unavailable right now.'; });
    file.addEventListener('change', () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      const url = URL.createObjectURL(f), im = new Image();
      im.onload = () => { img = im; zoom.value = 1; draw(); pv.innerHTML = ''; const wrap = document.createElement('span'); wrap.className = 'av av-xl'; wrap.appendChild(canvas); pv.appendChild(wrap); edit.hidden = false; btns.hidden = true; URL.revokeObjectURL(url); };
      im.onerror = () => { URL.revokeObjectURL(url); toast('This picture cannot be opened. Try a JPEG or PNG.'); };
      im.src = url;
    });
    zoom.addEventListener('input', () => { if (img) draw(); });
    const reset = () => { img = null; edit.hidden = true; btns.hidden = false; if (mine) show(mine); };
    m.querySelector('#av-undo').addEventListener('click', reset);
    m.querySelector('#av-send').addEventListener('click', async e => {
      if (!img) return;
      const btn = e.currentTarget; btn.disabled = true;
      // Qualité ~0,8, baissée si l'image dépasse la limite du serveur (60 Ko).
      let data = '';
      for (const q of [0.8, 0.7, 0.6, 0.5, 0.4]) { data = canvas.toDataURL('image/jpeg', q); if (data.length * 0.75 < 58 * 1024) break; }
      try { const d = await Online.avatar('upload', { img: data }); img = null; edit.hidden = true; btns.hidden = false; show(d); toast('Picture sent. The creator will check it soon.'); } catch (err) { fail(err); } finally { btn.disabled = false; }
    });
    btns.addEventListener('click', async e => {
      if (!e.target.closest('[data-av-withdraw]')) return;
      try { show(await Online.avatar('cancel')); } catch (err) { fail(err); }
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
  // Remplace les totaux de l'appareil par ceux du serveur (accueil et Stats), une fois la page dessinée.
  async function fillServerLife() {
    const life = await ServerLife.load();
    if (!life) return;
    const home = document.getElementById('home-life');
    if (home) home.textContent = `${plural(life.rolls, 'roll')} · ${fmt(life.xp)} lifetime XP`;
    const sr = document.getElementById('st-rolls'), sl = document.getElementById('st-life');
    if (sr) { const v = sr.querySelector('.v'); if (v) v.textContent = fmt(life.rolls); }
    if (sl) { const v = sl.querySelector('.v'), sub = sl.querySelector('.s'); if (v) v.textContent = compact(life.xp); if (sub && life.rolls) sub.textContent = `${fmt(life.xp / life.rolls)} XP per roll`; }
  }

  function renderHome() {
    setTimeout(fillServerLife, 0);
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
          <button class="btn-roll${genClass()}" id="roll-btn">Generate</button>
          <p class="hint">
            ${rolls.length ? `<span id="home-life">${plural(countedRolls(), 'roll')} · ${fmt(lifetimeEP())} lifetime XP</span> · ` : ''}
            ${name ? `playing as <b>${esc(name)}</b> · ` : '<a href="javascript:void 0" id="pick-name">pick a name</a> · '}
            press <kbd>${esc(keyName())}</kbd>
          </p>
          ${soloAutoHTML()}
          <button class="btn ghost trailer-btn" data-trailer>${playIcon()} Watch the trailer</button>
          <div class="home-row"><div id="quests-slot"></div><div data-fund-slot></div><div id="event-side"></div></div>
          <div id="tn-banner-slot"></div>
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
    bindSoloAuto();
    const pick = $('#pick-name');
    if (pick) pick.addEventListener('click', openSettings);
    loadTodayCard($('#today-slot'));
    drawTourneyBanner($('#tn-banner-slot'));
    loadQuests($('#quests-slot'));
    Fund.load();
    $('#room-join-form').addEventListener('submit', e => { e.preventDefault(); joinRoom($('#room-code').value); });
  }

  // ---------------------------------------------------------------- quêtes du jour et bonus quotidien (accueil)
  // 5 quêtes par jour, les mêmes pour tous ; la progression et les récompenses viennent du serveur. Les finir toutes fait
  // monter la série de quêtes, avec un bonus « tout fini » (js/quests.js).
  async function loadQuests(slot, state) {
    if (!slot || !Store.player.name) return;
    if (!state) {
      try { state = await Online.quests(); } catch (err) { return; }
      if (!slot.isConnected) return;
    }
    if (!state.daily || !Array.isArray(state.quests)) return; // réponse coupée en route (page rechargée pendant la lecture)
    QuestWatch.take(state, true);
    const left = Math.max(0, state.resetAt - Date.now());
    const resetIn = left > 3600000 ? `${Math.floor(left / 3600000)} h` : `${Math.max(1, Math.ceil(left / 60000))} min`;
    const d = state.daily;
    slot.innerHTML = `
      <div class="quests-card">
        <div class="quests-head"><span class="eyebrow">Daily quests</span><span class="coins mono">🪙 ${fmt(state.coins)}</span></div>
        ${state.rush ? `<div class="rush-banner">🔥 <b>Weekend Rush</b> · +25% coins from rolls and quests · ends in ${Math.max(1, Math.floor((state.rush.end - Date.now()) / 3600000))} h</div>` : ''}
        ${state.event ? (() => { const ev = state.event, done = ev.progress >= ev.goal, left = Math.max(0, ev.end - Date.now());
          const leftTxt = left > 86400000 ? `${Math.floor(left / 86400000)} d ${Math.floor(left / 3600000) % 24} h left` : `${Math.max(1, Math.floor(left / 3600000))} h left`;
          return `<div class="quest event-quest${ev.claimed ? ' done' : ''}">
          <span class="quest-emoji">${ev.emoji}</span>
          <span class="quest-text"><b>🎯 Event: ${esc(ev.title)}</b><span class="panel-note">${esc(ev.desc)} · ${leftTxt}</span>
            <span class="quest-bar"><span style="width:${Math.min(100, (ev.progress / ev.goal) * 100)}%"></span></span>
            <span class="panel-note">${Math.min(ev.progress, ev.goal)} / ${ev.goal}${ev.rank ? ` · #${ev.rank} of ${fmt(ev.players)} this week` : ''}</span>
            <span class="event-how">ℹ️ How it works: just roll as usual. Every roll that gets one of this week's badges counts +1${ev.example ? ` (e.g. ${esc(ev.example)})` : ''}. Reach the goal before Monday to claim the coins.</span>
            ${ev.top.length ? `<span class="event-top">${ev.top.slice(0, 3).map((t, i) => `<span${t.me ? ' class="me"' : ''}>${['🥇', '🥈', '🥉'][i]} <span data-no-i18n>${esc(t.name)}</span> ${t.n}</span>`).join('')}</span>` : ''}
            <a class="event-lb-link" href="#/leaderboard" data-event-lb>🏆 See the event leaderboard</a></span>
          ${ev.claimed ? '<span class="quest-state">✓ Claimed</span>' : done ? `<button class="btn-roll small" data-event>+${fmt(ev.reward)} 🪙</button>` : `<span class="quest-reward mono">${fmt(ev.reward)} 🪙</span>`}
        </div>`; })() : ''}
        ${state.level ? (() => { const lv = state.level, pct = Math.min(100, ((lv.xp - lv.from) / Math.max(1, lv.to - lv.from)) * 100), KEY = { starter: '📦', premium: '🎁', elite: '💎' };
          const nextTxt = `next level: +${fmt(lv.next.coins)} 🪙${lv.next.key ? ` and a ${KEY[lv.next.key]} key` : ''}`;
          return `<div class="quest level${lv.pending ? '' : ' done'}" data-level-road title="See the level rewards road">
          <span class="quest-emoji">⭐</span>
          <span class="quest-text"><b>Level ${fmt(lv.level)}</b>
            <span class="quest-bar"><span style="width:${pct}%"></span></span>
            <span class="panel-note">${compact(lv.xp)} / ${compact(lv.to)} XP · ${nextTxt}</span>
            <span class="level-road-link">🛣️ See all rewards</span></span>
          ${lv.pending ? `<button class="btn-roll small" data-level>+${fmt(lv.coins)} 🪙${lv.keys.length ? ` ${lv.keys.map(k => KEY[k]).join('')}` : ''}</button>` : ''}
        </div>`; })() : ''}
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
        ${state.questStreak ? (() => { const qs = state.questStreak, claimed = state.quests.filter(q => q.claimed).length; return `
        <div class="quest qstreak${qs.doneToday ? ' done' : ''}">
          <span class="quest-emoji">🏅</span>
          <span class="quest-text"><b>Quest streak${qs.streak ? `: ${plural(qs.streak, 'day')}` : ''}</b>
            <span class="panel-note">${qs.doneToday ? 'All quests done today, come back tomorrow' : `Finish all ${state.quests.length} quests today (${claimed}/${state.quests.length}) for a bonus`}${qs.best ? ` · best: ${plural(qs.best, 'day')}` : ''}</span></span>
          ${qs.doneToday ? '<span class="quest-state">✓ Done</span>' : `<span class="quest-reward mono">+${fmt(qs.bonus)} 🪙</span>`}
        </div>`; })() : ''}
        <p class="panel-note quests-foot">New quests in ${resetIn} · coins buy skins and cases in the <a href="#/shop">Shop</a></p>
      </div>`;
    // Sur grand écran, l'événement de la semaine passe sous la cagnotte (moins de choses empilées dans les quêtes).
    { const side = $('#event-side'), ev = slot.querySelector('.event-quest');
      if (side) { side.innerHTML = ''; if (ev && matchMedia('(min-width: 1180px)').matches) { side.appendChild(ev); side.onclick = e => slot.onclick(e); } } }
    slot.onclick = async e => {
      if (!e.target.closest('[data-level]') && e.target.closest('[data-level-road]')) { openLevelRoad(state.level); return; }
      if (e.target.closest('[data-event-lb]')) { lbState.period = 'event'; lbState.tab = 'event'; lbState.scroll = true; return; } // le lien mène au classement, sur l'onglet Event, liste à l'écran
      const btn = e.target.closest('[data-quest], [data-daily], [data-level], [data-event]');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      if (btn.dataset.event !== undefined) {
        try {
          const next = await Online.questAction('event');
          toast(`🎯 Event complete! +${fmt(next.gained)} coins`, 4500, 'achv');
          FX.celebrate('epic', slot); Sound.play('reveal', { small: 1 });
          loadQuests(slot, next);
        } catch (err) { btn.disabled = false; toast([422, 429].includes(err.status) ? err.message : 'Quests unavailable right now, try again'); }
        return;
      }
      if (btn.dataset.level !== undefined) {
        try {
          const next = await Online.questAction('level');
          toast(`⭐ Level ${next.level.level}! +${fmt(next.gained)} coins${next.keys.length ? ` and ${next.keys.length} case key${next.keys.length > 1 ? 's' : ''} (Shop, Cases tab)` : ''}`, 4500, 'achv');
          FX.celebrate(next.keys.length ? 'epic' : 'uncommon', slot); Sound.play('reveal', { small: 1 });
          loadQuests(slot, next);
        } catch (err) { btn.disabled = false; toast([422, 429].includes(err.status) ? err.message : 'Quests unavailable right now, try again'); }
        return;
      }
      try {
        const next = await Online.questAction(btn.dataset.quest ? 'claim' : 'daily', btn.dataset.quest);
        toast(next.allDone ? `🏅 All quests done! +${fmt(next.gained)} coins · quest streak: ${plural(next.allDone.streak, 'day')}` : `🪙 +${next.gained} coins${btn.dataset.quest ? '' : ` · ${plural(next.daily.streak, 'day')} streak`}`, next.allDone ? 4000 : 2600, 'achv');
        if (next.allDone) FX.celebrate(next.allDone.streak >= 7 ? 'epic' : 'uncommon', slot);
        Sound.play('lock', { i: 5 });
        loadQuests(slot, next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Quests unavailable right now, try again');
      }
    };
  }

  // Route des récompenses de niveau (2026-10-16) : du niveau d'avant jusqu'au prochain palier de 25, chaque niveau avec
  // ses pièces et sa clé de caisse ; les niveaux à clé ressortent, ceux déjà payés sont cochés.
  function openLevelRoad(lv) {
    if (!lv) return;
    const KEY = { starter: ['📦', 'Starter Case key'], premium: ['🎁', 'Premium Case key'] };
    const paidUpTo = lv.level - lv.pending, from = Math.max(1, lv.level - 2), to = Math.max(lv.level + 12, Math.ceil((lv.level + 1) / 25) * 25);
    const rows = [];
    for (let L = from; L <= to; L++) {
      const r = Quests.levelReward(L), state = L <= paidUpTo ? 'paid' : L <= lv.level ? 'ready' : 'locked';
      rows.push(`<div class="road-step ${state}${r.key ? ` key-${r.key}` : ''}${L === lv.level + 1 ? ' next' : ''}">
        <span class="road-n">${fmt(L)}</span>
        <span class="road-r">+${fmt(r.coins)} 🪙${r.key ? ` <b>${KEY[r.key][0]} ${KEY[r.key][1]}</b>` : ''}</span>
        <span class="road-x mono">${compact(Quests.xpForLevel(L))} XP</span>
        <span class="road-s">${state === 'paid' ? '✓' : state === 'ready' ? '🎁' : '🔒'}</span>
      </div>`);
    }
    openModal(`
      <h2>⭐ Level ${fmt(lv.level)}</h2>
      <p class="panel-note" style="margin:-.3rem 0 .8rem">Your level goes up with your lifetime XP (${compact(lv.xp)} XP). Every level gives coins, every 5 levels a 📦 Starter Case key, every 25 levels a 🎁 Premium Case key.${lv.pending ? ' You have rewards to claim on the home page!' : ''}</p>
      ${lv.catchup ? `<div class="road-step ready road-catchup"><span class="road-n">🎁</span><span class="road-r"><b>Catch-up for your earlier levels:</b> +${fmt(lv.catchup.coins)} 🪙${lv.catchup.keys.length ? ` ${lv.catchup.keys.map(k => KEY[k][0]).join('')}` : ''}</span><span class="road-x"></span><span class="road-s">🎁</span></div>` : ''}
      <div class="road">${rows.join('')}</div>
      <div class="actions">${lv.pending ? `<button class="btn-roll small" data-road-claim>Claim +${fmt(lv.coins)} 🪙${lv.keys.length ? ` ${lv.keys.map(k => KEY[k][0]).join('')}` : ''}</button>` : ''}<button class="btn" data-close>Close</button></div>`, m => {
      const b = m.querySelector('[data-close]'); if (b) b.onclick = closeModal;
      const n = m.querySelector('.road-step.next'); if (n) n.scrollIntoView({ block: 'center' });
      // Réclamer directement depuis la route (même action que le bouton des quêtes du jour).
      const claim = m.querySelector('[data-road-claim]');
      if (claim) claim.onclick = async () => {
        claim.disabled = true;
        try {
          const next = await Online.questAction('level');
          toast(`⭐ Level ${next.level.level}! +${fmt(next.gained)} coins${next.keys.length ? ` and ${next.keys.length} case key${next.keys.length > 1 ? 's' : ''} (Shop, Cases tab)` : ''}`, 4500, 'achv');
          FX.celebrate(next.keys.length ? 'epic' : 'uncommon', m); Sound.play('reveal', { small: 1 });
          LevelWatch.state = next.level; document.dispatchEvent(new CustomEvent('rng:level', { detail: next }));
          if ($('#quests-slot')) loadQuests($('#quests-slot'), next); // la carte des quêtes de l'accueil suit
          openLevelRoad(next.level);
        } catch (err) { claim.disabled = false; toast([422, 429].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
      };
    });
  }
  const LevelWatch = { state: null };

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
  // Même clé que nameKey (api/_lib.js), en plus simple : sans accents, casse, espaces ni ponctuation.
  const sameName = (a, b) => { const k = v => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); return k(a) === k(b); };
  async function saveName(raw) {
    const name = String(raw).trim().replace(/\s+/g, ' ').slice(0, 20);
    // Même règle que le serveur : alphabet latin (accents compris), chiffres, espaces et _ . - ' (pas de sosie en cyrillique).
    if (!/^[\p{Script=Latin}0-9 _.\-']+$/u.test(name)) return { ok: false, error: "Use letters, digits, spaces and _ . - ' only." };
    try {
      const data = await Online.claimName(name);
      Store.setPlayerName(data.name || name);
      if (typeof data.coins === 'number') Store.setSetting('coins', data.coins);
      return { ok: true };
    } catch (err) {
      if (err.status === 409) {
        const hint = googleEnabled() && !Store.player.google ? ', or sign in with Google if it is yours' : '';
        return { ok: false, error: `"${name}" is already taken. Pick another name${hint}.` };
      }
      if (err.status === 400) return { ok: false, error: 'That name is not valid.' };
      if (err.status === 402 || err.status === 429) return { ok: false, error: `${err.message}.` };
      Store.setPlayerName(name);
      return { ok: true };
    }
  }

  // Sous chaque bouton Google : ce que l'on gagne à associer son compte (une seule fois par joueur).
  const GOOGLE_PROMO = `<span class="google-promo">🪙 +${Shop.GOOGLE_BONUS} coins when you link your Google account</span>`;
  function askName(then, suggested = '', error = '', label = 'Save') {
    const offerGoogle = googleEnabled() && !Store.player.google;
    openModal(`
      <h2>Choose your player name</h2>
      <p class="panel-note" style="margin:-.3rem 0 1rem">It appears on the leaderboard next to your best rolls. Each name belongs to one player only.</p>
      <form id="name-form">
        <input class="input" id="name-input" maxlength="20" autocomplete="off" placeholder="Your name" value="${esc(suggested)}" style="width:100%">
        <p class="field-error" id="name-error"${error ? '' : ' hidden'}>${esc(error)}</p>
        <div class="actions"><button class="btn-roll small" type="submit">${label}</button></div>
      </form>
      ${offerGoogle ? `<div class="or-google"><span class="panel-note">or sign in to keep your player on every device</span><div id="google-btn" class="google-btn"></div>${GOOGLE_PROMO}</div>` : ''}`, m => {
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
      if (data.bonus) { toast(`🪙 +${data.bonus} coins for linking your Google account`, 5000, 'achv'); Sound.play('lock', { i: 5 }); if (Store.settings.coins != null) Store.setSetting('coins', Store.settings.coins + data.bonus); }
      else toast(`Signed in as ${data.email || 'your Google account'}${restored ? ` · ${plural(restored, 'roll')} restored` : ''}`);
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
          // Les tirages déjà marqués hors ligne ont été proposés au serveur, qui ne les prend plus : inutile d'y revenir.
          const localOnly = Store.rolls.filter(r => !r[3] && !onServer.has(r[0], r[2])).map(r => [r[0], r[2]]);
          const added = Store.mergeRolls(server.rolls, n => Engine.scoreOf(n));
          for (let i = 0; i < localOnly.length; i += 2000) await Online.history(localOnly.slice(i, i + 2000), false);
          // L'XP affiché ne compte que les tirages présents sur le compte : c'est le même total qu'au classement.
          const marked = Store.markOffline(onServer);
          if (added || marked) {
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
      if (localOnly && !confirm(window.RNGI18n.t(`${plural(localOnly, 'roll')} on this device could not be saved to your account (made offline). Sign out anyway and remove ${localOnly === 1 ? 'it' : 'them'} from this device?`))) return;
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

  // ---- Pseudo + mot de passe (api/auth.js) : choisir un mot de passe pour son joueur, ou se connecter avec sur cet
  // appareil. Aucun e-mail : un mot de passe oublié se règle avec le créateur.
  function passwordHTML() {
    return `<div class="field pw-field"><label>Password</label>
      <div id="pw-state" class="panel-note">${Store.player.name ? 'Set a password to sign in with your player name on any device.' : 'Pick a player name first, then you can set a password.'}</div>
      ${Store.player.name ? `<form class="pw-form" id="pw-set"><input class="input" type="password" name="password" autocomplete="new-password" minlength="8" maxlength="100" placeholder="New password (8+ characters)" aria-label="New password" required><input class="input" type="password" name="again" autocomplete="new-password" placeholder="Same password again" aria-label="Same password again" required><button class="btn">Save password</button></form>` : ''}
      <details class="pw-login"><summary>Sign in with a name and password</summary>
        <form class="pw-form" id="pw-login"><input class="input" name="name" autocomplete="username" maxlength="20" placeholder="Player name" aria-label="Player name" required><input class="input" type="password" name="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required><button class="btn">Sign in</button></form>
        <span class="panel-note">This device switches to that player. The player you use here now stays saved on the server under its name.</span>
      </details></div>`;
  }
  function bindPassword(m) {
    const state = m.querySelector('#pw-state'), set = m.querySelector('#pw-set'), login = m.querySelector('#pw-login'), p = Store.player;
    if (p.name) Online.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'passwordState', playerId: p.id, secret: p.secret }) }).then(r => { if (r.has && state) state.textContent = window.RNGI18n.t('✓ You have a password: sign in on another device with your name and it. You can change it below.'); }).catch(() => {});
    if (set) set.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(set);
      if (f.get('password') !== f.get('again')) { toast('The two passwords are different'); return; }
      try { await Online.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'setPassword', playerId: p.id, secret: p.secret, password: f.get('password') }) }); set.reset(); state.textContent = window.RNGI18n.t('✓ You have a password: sign in on another device with your name and it. You can change it below.'); toast('Password saved', 2500, 'achv'); }
      catch (err) { toast([403, 422].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
    });
    if (login) login.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(login), btn = login.querySelector('button');
      btn.disabled = true;
      try {
        const data = await Online.request('/api/auth', { method: 'POST', body: JSON.stringify({ action: 'passwordLogin', name: f.get('name'), password: f.get('password') }) });
        Store.setIdentity({ id: data.playerId, secret: data.secret, google: null });
        Store.setPlayerName(data.name);
        closeModal();
        const restored = await syncHistory().catch(() => 0);
        toast(`Signed in as ${data.name}${restored ? ` · ${plural(restored, 'roll')} restored` : ''}`, 3500, 'achv');
        route();
      } catch (err) { btn.disabled = false; toast([401, 429].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
    });
  }

  // Aide sous le bouton Google (Sacha, 2026-10-25) : un bloqueur de pub ou de pop-ups empêche la fenêtre de Google de
  // s'ouvrir, et le clic ne fait alors rien du tout ; on le dit, avec l'autre façon de se connecter (mot de passe).
  function googleAccountHTML() {
    if (!googleEnabled()) return '';
    const g = Store.player.google;
    return g
      ? `<div class="field"><label>Account</label>
          <div class="google-row"><span>Signed in with Google as <b>${esc(g.email || 'your account')}</b></span><button class="btn" id="google-out">Sign out</button></div>
          <span class="panel-note">Your player, leaderboard spots and whole roll history (stats, badges) follow you on every device.</span></div>`
      : `<div class="field"><label>Account</label>
          <div id="google-btn" class="google-btn"></div>
          <span class="panel-note google-help">Nothing happens? Allow pop-ups or pause your ad blocker for this site, or use a password below.</span>
          ${GOOGLE_PROMO}
          <span class="panel-note">Sign in to keep the same player, your leaderboard spots and your whole roll history (stats, badges) on every device.</span></div>`;
  }

  // Détail d'un nombre tiré par quelqu'un d'autre (classement, meilleur tirage du jour).
  // owner : le joueur qui a fait ce tirage (le partage affiche son nom, pas le mien : « Share bug » signalé sur Discord,
  // 2026-10-26). Vide si on ne le connaît pas : la carte n'affiche alors aucun nom.
  function openNumberModal(n, caption, owner = '') {
    const a = analysis(n);
    openModal(`
      <div class="result" data-tier="${a.tier}" style="padding-top:.2rem">
        ${caption ? `<div class="eyebrow">${esc(caption)}</div>` : ''}
        <div style="margin-top:.9rem"><span class="num-card lg" data-tier="${a.tier}">${a.str}</span></div>
        <div class="result-meta">${tierPill(a.tier)}<span class="dot">•</span>${percentileHTML(a.percentile)}</div>
        <div class="ep-big">${fmt(a.total)} XP</div>
        <div class="result-actions"><button class="btn" data-rewatch>▶ Rewatch</button></div>
        ${breakdownHTML(n, a)}
      </div>`, m => {
      m.querySelector('[data-rewatch]').addEventListener('click', () => rewatch(n, caption || '', owner));
      animateDigits(m, { stagger: 120 });
    });
  }

  // Journal des mises à jour : un rond en bas à gauche, au-dessus du lien GitHub, avec une pastille tant que la
  // dernière entrée n'a pas été lue sur cet appareil. Les textes sont écrits dans les deux langues (pas traduits au vol).
  const UPDATES = [
    { id: '2026-10-26-trailer-v2', date: 'Oct 26, 2026', en: ['🎬 New trailer (▶ Watch the trailer on the home page): the legendary skins, living wallpapers, clans and 5v5 wars, the global chat, the three daily tournaments, the casino, Prestige titles and the roadmap of player ideas, and it ends on an Infinite roll.'], fr: ['🎬 Nouvelle bande-annonce (▶ Voir la bande-annonce sur l\'accueil) : les skins légendaires, les fonds animés, les clans et les guerres à 5 contre 5, le chat global, les trois tournois du jour, le casino, les titres Prestige et la feuille de route des idées de joueurs, et elle finit sur un tirage Infinite.'] },
    { id: '2026-10-26-avatars', date: 'Oct 26, 2026', en: ['🖼️ Profile pictures: add one in ⚙️ Player & settings (after 30 rolls). The creator checks every picture before anyone else can see it, then it shows on your profile, the leaderboards, the global chat, your clan and your friends\' lists. Don\'t use photos of yourself or personal info (asked by kingston and JAKECisthebest).'], fr: ['🖼️ Photos de profil : ajoute la tienne dans ⚙️ Joueur et réglages (après 30 tirages). Le créateur vérifie chaque image avant que quiconque puisse la voir ; elle s\'affiche ensuite sur ton profil, les classements, le chat global, ton clan et la liste de tes amis. N\'utilise pas de photo de toi ni d\'infos personnelles (demandé par kingston et JAKECisthebest).'] },
    { id: '2026-10-26-roadmap', date: 'Oct 26, 2026', en: ['🗺️ Roadmap: a new page lists the player ideas that are planned and the ones added in the last 30 days. Open it from the 💡 ideas window or the About page (idea by Phong67).'], fr: ['🗺️ Feuille de route : une nouvelle page liste les idées de joueurs prévues et celles ajoutées ces 30 derniers jours. Ouvre-la depuis la fenêtre 💡 des idées ou la page À propos (idée de Phong67).'] },
    { id: '2026-10-26-announcements', date: 'Oct 26, 2026', en: ['📣 Announcements: news from the creator now appear at the top of 📰 What\'s new (with a red dot), and important ones pop up once when you come back (idea by jaxoncool43).'], fr: ['📣 Annonces : les messages du créateur apparaissent maintenant en haut de 📰 Nouveautés (avec un point rouge), et les plus importants s\'affichent une fois à ton retour (idée de jaxoncool43).'] },
    { id: '2026-10-26-evening-tournament', date: 'Oct 26, 2026', en: ['🌙 New evening tournament every day: sign up from 12:00 to 18:00 UTC (evening in Europe, morning and afternoon in the Americas), matches until 06:00 UTC. Same prizes, its own bracket, and you can play it on top of tournament 1 or 2. The tournament page shows every time in your own time zone (idea by Me Cojoni and Idea:Tournaments)'], fr: ['🌙 Nouveau tournoi du soir chaque jour : inscriptions de 12:00 à 18:00 UTC (le soir en Europe, le matin et l\'après-midi en Amérique), matchs jusqu\'à 06:00 UTC. Mêmes prix, son propre tableau, et tu peux le jouer en plus du tournoi 1 ou 2. La page du tournoi montre toutes les heures à ton heure locale (idée de Me Cojoni et Idea:Tournaments)'] },
    { id: '2026-10-26-friend-alerts', date: 'Oct 26, 2026', en: ['🌟 Friend alerts: when one of your friends rolls a Celestial or better, a message pops up for you. Turn it off in ⚙️ Settings (idea by Jguz01).'], fr: ['🌟 Alertes d\'amis : quand un de tes amis tire un Celestial ou mieux, un message s\'affiche chez toi. Désactivable dans ⚙️ Réglages (idée de Jguz01).'] },
    { id: '2026-10-26-gc-edit', date: 'Oct 26, 2026', en: ['✏️ Global chat: you can now edit your messages for 5 minutes and delete them anytime (⋯ menu). Edited messages show "edited" (idea by daddy finger).'], fr: ['✏️ Chat global : tu peux maintenant modifier tes messages pendant 5 minutes et les supprimer quand tu veux (menu ⋯). Les messages modifiés affichent « modifié » (idée de daddy finger).'] },
    { id: '2026-10-26-gc-mentions', date: 'Oct 26, 2026', en: ['💬 Global chat: write @name to mention a player. Their name lights up, and they get a red dot on 💬 even if they were away (idea by casmictechthing).'], fr: ['💬 Chat global : écris @pseudo pour mentionner un joueur. Son pseudo est surligné, et il voit un point rouge sur 💬 même s\'il était absent (idée de casmictechthing).'] },
    { id: '2026-10-26-clan-patron', date: 'Oct 26, 2026', en: ['🪙 New title: Clan Patron, for players who donated 10,000 coins in total to a clan vault (idea by PRISMA123).'], fr: ['🪙 Nouveau titre : Mécène de clan, pour les joueurs qui ont versé 10 000 pièces au total dans le coffre d\'un clan (idée de PRISMA123).'] },
    { id: '2026-10-26-clan-perms', date: 'Oct 26, 2026', en: ['⭐ Clan leaders can now choose what officers may do: invite and accept requests, kick members, spend the vault, start wars, edit the description (idea by kaz).'], fr: ['⭐ Les chefs de clan peuvent maintenant choisir ce que les officiers ont le droit de faire : inviter et accepter les demandes, exclure, dépenser le coffre, lancer des guerres, modifier la description (idée de kaz).'] },
    { id: '2026-10-26-coin-tiers', date: 'Oct 26, 2026', en: ['🪙 Softer coin rate after many rolls: every roll still pays at least 1 coin, and Celestial rolls or better always pay 100% (asked by number 1, kaz and casmictechthing).'], fr: ['🪙 Taux de pièces adouci après beaucoup de tirages : chaque tirage rapporte toujours au moins 1 pièce, et les tirages Celestial ou mieux rapportent toujours 100 % (demandé par number 1, kaz et casmictechthing).'] },
    { id: '2026-10-26-leap-day', date: 'Oct 26, 2026', en: ['🐸 New badge: Leap Day, for numbers that read as February 29 of a leap year (0229YY, like 022924, rolled as 22924). Only 25 numbers out of a million (idea by qwertyuiop)'], fr: ['🐸 Nouveau badge : Leap Day, pour les nombres qui se lisent comme un 29 février d\'une année bissextile (0229AA, comme 022924, tiré 22924). Seulement 25 nombres sur un million (idée de qwertyuiop)'] },
    { id: '2026-10-26-walls', date: 'Oct 26, 2026', en: ['🦇 Pumpkin Patch wallpaper: a bat now flies across the screen from time to time (idea by ....)', '♾️ Aether wallpaper: Celestial rolls and better now light up the whole background (idea by shadow2)'], fr: ['🦇 Fond Pumpkin Patch : une chauve-souris traverse l\'écran de temps en temps (idée de ....)', '♾️ Fond Aether : les tirages Celestial ou mieux illuminent maintenant tout le fond (idée de shadow2)'] },
    { id: '2026-10-26-blackjack-skin', date: 'Oct 26, 2026', en: ['🃏 New skin: Blackjack (3,250 coins). The dealer shuffles a deck beside a green felt table, deals every digit face down and flips it over; good rolls fan out the cards and throw chips, and Mythic rolls hit BLACKJACK! (idea by kaz)'], fr: ['🃏 Nouveau skin : Blackjack (3 250 pièces). Le croupier mélange un paquet à côté d\'une table de feutre vert, distribue chaque chiffre face cachée et le retourne ; les bons tirages ouvrent les cartes en éventail et font voler des jetons, et les Mythic font BLACKJACK! (idée de kaz)'] },
    { id: '2026-10-26-rocket-skin', date: 'Oct 26, 2026', en: ['🚀 New skin: Rocket (1,200 coins). A night launch pad: a rocket blasts off behind every digit and launches it into place, and good rolls end in fireworks (idea by HSI)'], fr: ['🚀 Nouveau skin : Rocket (1 200 pièces). Un pas de tir la nuit : une fusée décolle derrière chaque chiffre et le propulse à sa place, et les bons tirages finissent en feu d\'artifice (idée de HSI)'] },
    { id: '2026-10-26-sushi-skin', date: 'Oct 26, 2026', en: ['🍣 New skin: Sushi (1,200 coins). Every digit is a sushi roll on a wooden board: the rolls spin, then plop down with a splash of soy sauce, and Mythic rolls drop a giant roll that bursts into rice (idea by Gray alt)'], fr: ['🍣 Nouveau skin : Sushi (1 200 pièces). Chaque chiffre est un maki sur une planche en bois : les makis tournent, puis tombent dans une éclaboussure de sauce soja, et les Mythic font tomber un maki géant qui éclate en riz (idée de Gray alt)'] },
    { id: '2026-10-26-comicbook-skin', date: 'Oct 26, 2026', en: ['💥 New Legendary skin: Comic Book (13,000 coins, Premium). A halftone comic panel with speed lines: every digit lands with its own POW!, BAM! or ZAP! burst, and rare rolls end in a giant KA-BOOM!, with comic panels slamming around Mythic rolls (idea by JBearr12)'], fr: ['💥 Nouveau skin Legendary : Comic Book (13 000 pièces, Premium). Une case de BD tramée avec des lignes de vitesse : chaque chiffre tombe avec sa bulle POW!, BAM! ou ZAP!, et les tirages rares finissent en KA-BOOM! géant, avec des cases de BD qui claquent autour des Mythic (idée de JBearr12)'] },
    { id: '2026-10-26-hotdog-skin', date: 'Oct 26, 2026', en: ['🌭 New skin: Hot Dog (1,700 coins). A grilled hot dog in a golden bun: every digit is squeezed out as a drizzle that switches between ketchup and mustard, and great rolls steam and get fully dressed (idea by finnnnn)'], fr: ['🌭 Nouveau skin : Hot Dog (1 700 pièces). Un hot-dog grillé dans un pain doré : chaque chiffre sort du flacon en filet, ketchup puis moutarde, et les beaux tirages fument et sont entièrement garnis (idée de finnnnn)'] },
    { id: '2026-10-26-radioactive-skin', date: 'Oct 26, 2026', en: ['☢️ New skin: Radioactive (2,200 coins). Glowing green goo in a leaking hazard barrel: digits crackle like a Geiger counter, plop into place in a green flash, and Mythic rolls light up a hazard sign and make the goo drip (idea by shadow2)'], fr: ['☢️ Nouveau skin : Radioactive (2 200 pièces). De la gelée verte qui luit dans un fût qui fuit : les chiffres grésillent comme un compteur Geiger, tombent en place dans un éclair vert, et les tirages Mythic allument un panneau de danger et font couler la gelée (idée de shadow2)'] },
    { id: '2026-10-26-milkyway-skin', date: 'Oct 26, 2026', en: ['🌌 New Legendary skin: Milky Way (13,500 coins, Premium). A spiral galaxy turns around your number, faster as the roll builds up, every digit ignites like a star, and Mythic rolls set the galaxy core ablaze (idea by shadow2 Jr)'], fr: ['🌌 Nouveau skin Legendary : Milky Way (13 500 pièces, Premium). Une galaxie spirale tourne autour de ton nombre, de plus en plus vite pendant le tirage, chaque chiffre s\'allume comme une étoile, et les tirages Mythic embrasent le cœur de la galaxie (idée de shadow2 Jr)'] },
    { id: '2026-10-26-wp-japan', date: 'Oct 26, 2026', en: ['⛩️ New wallpaper Spring Shrine (1,100 coins): cherry blossoms drift past a red shrine gate, with a snowy mountain and a misty lake at dawn (idea by ichi)'], fr: ['⛩️ Nouveau fond Sanctuaire de printemps (1 100 pièces) : des pétales de cerisier passent devant un portail rouge, avec une montagne enneigée et un lac brumeux à l\'aube (idée d\'ichi)'] },
    { id: '2026-10-26-wp-bank', date: 'Oct 26, 2026', en: ['🏦 New wallpaper Grand Bank (1,200 coins): a golden coupe, a white limo and a red supercar cruise past the columns of a grand bank at sunset (idea by finnnnn)'], fr: ['🏦 Nouveau fond Grande Banque (1 200 pièces) : un coupé doré, une limousine blanche et un bolide rouge passent devant les colonnes d\'une grande banque au coucher du soleil (idée de finnnnn)'] },
    { id: '2026-10-26-wp-playground', date: 'Oct 26, 2026', en: ['🛝 New wallpaper Playground (800 coins): a sunny day at the playground, a kid swings high next to the slide and the sandbox while clouds drift by (idea by finnnnn)'], fr: ['🛝 Nouveau fond Aire de jeux (800 pièces) : une journée ensoleillée au parc, un enfant se balance à côté du toboggan et du bac à sable pendant que les nuages passent (idée de finnnnn)'] },
    { id: '2026-10-26-wp-cybervoid', date: 'Oct 26, 2026', en: ['🌐 New wallpaper Cyber Void (1,100 coins): a glowing cyan grid races toward the horizon under a deep purple sky, past wireframe mountains (idea by Sean)'], fr: ['🌐 Nouveau fond Cyber Néant (1 100 pièces) : une grille cyan lumineuse file vers l\'horizon sous un ciel violet profond, devant des montagnes en fil de fer (idée de Sean)'] },
    { id: '2026-10-26-wp-submarine', date: 'Oct 26, 2026', en: ['🔱 New legendary wallpaper Deep Dive (4,500 coins): a yellow submarine patrols the deep sea and dives during every roll; a Mythic+ roll sends it all the way to the seabed in a burst of bubbles (idea by ....)'], fr: ['🔱 Nouveau fond légendaire Grande Plongée (4 500 pièces) : un sous-marin jaune patrouille au fond de la mer et plonge pendant chaque tirage ; un tirage Mythic+ l\'envoie jusqu\'au fond dans une gerbe de bulles (idée de ....)'] },
    { id: '2026-10-25-clan-desc', date: 'Oct 25, 2026', en: ['📝 Clans can now have a description: tell players what your clan is about. The leader and officers write it (150 characters, no links or personal info), and it shows in Find a clan.'], fr: ['📝 Les clans peuvent maintenant avoir une description pour dire de quoi parle ton clan. Le chef et les officiers l\'écrivent (150 caractères, sans liens ni infos perso), et elle s\'affiche dans Find a clan.'] },
    { id: '2026-10-25-clans', date: 'Oct 25, 2026', en: ['🏯 Clans are here! Create one for 10,000 coins (name, tag and emoji) or join one by invitation or request. Share a vault, chat with your clan, buy more member slots and colors, climb the weekly clan leaderboard (the #1 clan earns the Clan Champion title) and fight 5 vs 5 clan wars for a stake. Your clan tag shows next to your name. Open it from Profile & Friends (idea by BIGBOIJONER69 and KMC)'], fr: ['🏯 Les clans arrivent ! Crées-en un pour 10 000 pièces (nom, tag et emoji) ou rejoins-en un sur invitation ou sur demande. Partagez un coffre, discutez dans le chat du clan, achetez des places et des couleurs, grimpez au classement des clans de la semaine (le clan n°1 gagne le titre Clan Champion) et menez des guerres de clans à 5 contre 5 avec une mise. Ton tag de clan s\'affiche à côté de ton pseudo. Ouvre-les depuis Profil & amis (idée de BIGBOIJONER69 et KMC)'] },
    { id: '2026-10-25-global-chat', date: 'Oct 25, 2026', en: ['💬 Global chat: press 💬 to talk with every player. Anyone can read; to write you need 100 rolls. Be kind: links, insults and personal info (phone, e-mail, address, social accounts) are blocked, and every message can be reported'], fr: ['💬 Chat global : appuie sur 💬 pour parler avec tous les joueurs. Tout le monde peut lire ; pour écrire, il faut 100 tirages. Sois gentil : liens, insultes et infos perso (téléphone, e-mail, adresse, réseaux sociaux) sont bloqués, et chaque message peut être signalé'] },
    { id: '2026-10-25-economy', date: 'Oct 25, 2026', en: ['🪙 Coin balance: there were too many coins in the game, so skins were losing their value. Your XP, your luck and the leaderboards do not change', '🎲 Coins from rolls now depend on how many rolls you made today (UTC): your first 500 rolls pay full coins, rolls 501 to 2,000 pay 50%, and after that 20%. The rate shows under your coins after a roll', '🔥 Weekend Rush now gives +25% coins from rolls and quests (instead of ×2)', '✏️ Your first name is free; changing it now costs 5,000 coins', '👑 New Prestige tab in the Shop: three rare titles (Tycoon, Magnate, Coin Emperor) with a limited stock for the whole game'], fr: ['🪙 Équilibre des pièces : il y avait trop de pièces dans le jeu, les skins perdaient leur valeur. Ton XP, ta chance et les classements ne changent pas', '🎲 Les pièces des tirages dépendent maintenant du nombre de tirages faits aujourd\'hui (UTC) : tes 500 premiers tirages rapportent toutes leurs pièces, du 501e au 2 000e 50 %, et ensuite 20 %. Le taux s\'affiche sous tes pièces après un tirage', '🔥 Le Weekend Rush donne maintenant +25 % de pièces sur les tirages et les quêtes (au lieu de ×2)', '✏️ Ton premier pseudo est gratuit ; le changer coûte maintenant 5 000 pièces', '👑 Nouvel onglet Prestige dans la boutique : trois titres rares (Tycoon, Magnate, Coin Emperor) en stock limité pour tout le jeu'] },
    { id: '2026-10-25-exact-61-55', date: 'Oct 25, 2026', en: ['🔢 New badges: 🧪 Exact 61 (idea by schoolroller) and 🖐️ Exact 55 (idea by qwertyuiop)'], fr: ['🔢 Nouveaux badges : 🧪 Exact 61 (idée de schoolroller) et 🖐️ Exact 55 (idée de qwertyuiop)'] },
    { id: '2026-10-25-odd-abundant', date: 'Oct 25, 2026', en: ['🍇 New badge: Odd Abundant, an odd number smaller than the sum of its divisors (only 1,996 of them, about 1 roll in 500; idea by JAKECisthebest)'], fr: ['🍇 Nouveau badge : Odd Abundant, un nombre impair plus petit que la somme de ses diviseurs (seulement 1 996, environ 1 tirage sur 500 ; idée de JAKECisthebest)'] },
    { id: '2026-10-25-vortrox-gina', date: 'Oct 25, 2026', en: ['💞 New badge: Vortrox and Gina, for numbers containing 4992 or 9249, Geometry Dash numbers like 554992 included (idea by CococoC)'], fr: ['💞 Nouveau badge : Vortrox and Gina, pour les nombres qui contiennent 4992 ou 9249, nombres Geometry Dash comme 554992 compris (idée de CococoC)'] },
    { id: '2026-10-25-monthly-coins', date: 'Oct 25, 2026', en: ['🏆 The monthly leaderboard now pays coins too: when the month ends, 1st place gets 1,000 coins, 2nd to 5th 500 and 6th to 10th 250, on top of their Top 1 / 5 / 10 badge (idea by furcoat0 and LwsBoi)'], fr: ['🏆 Le classement du mois rapporte aussi des pièces : à la fin du mois, la 1re place gagne 1 000 pièces, les 2e à 5e 500 et les 6e à 10e 250, en plus de leur badge Top 1 / 5 / 10 (idée de furcoat0 et LwsBoi)'] },
    { id: '2026-10-25-christmas-skin', date: 'Oct 25, 2026', en: ['🎄 New limited Legendary skin: Christmas Morning (2,512 coins, until December 26). Six presents get shaken while you roll, then pop open one by one to reveal your digits, between two snowy trees and red and green lights; rare rolls bring snow and a shining star (ideas by JBearr12 and Angelicide9)'], fr: ['🎄 Nouveau skin Legendary limité : Christmas Morning (2 512 pièces, jusqu\'au 26 décembre). Six cadeaux sont secoués pendant le tirage puis s\'ouvrent un par un pour révéler tes chiffres, entre deux sapins enneigés et une guirlande rouge et verte ; les tirages rares font tomber la neige et briller une étoile (idées de JBearr12 et Angelicide9)'] },
    { id: '2026-10-25-money-skin', date: 'Oct 25, 2026', en: ['💵 New skin: Money (1,900 coins). A crisp 100 bill with gold-foil digits stamped one by one, coins raining down on good rolls, and on Mythic rolls the gold melts and drips off the bill (ideas by JBearr12 and finnnnn)'], fr: ['💵 Nouveau skin : Money (1 900 pièces). Un billet de 100 tout neuf aux chiffres en dorure tamponnés un par un, une pluie de pièces sur les beaux tirages, et sur un tirage Mythic l\'or fond et coule du billet (idées de JBearr12 et finnnnn)'] },
    { id: '2026-10-25-bowling-skin', date: 'Oct 25, 2026', en: ['🎳 New skin: Bowling (2,000 coins). Every digit is a pin on a polished lane: a ball rolls in and knocks it down, and good rolls end in a STRIKE (idea by JBearr12)'], fr: ['🎳 Nouveau skin : Bowling (2 000 pièces). Chaque chiffre est une quille sur une piste cirée : une boule arrive et la renverse, et les bons tirages finissent en STRIKE (idée de JBearr12)'] },
    { id: '2026-10-25-rocksmash-skin', date: 'Oct 25, 2026', en: ['🪨 New skin: Rock Smash (1,600 coins). A fist smashes every boulder open, and a glowing digit shines inside the cracked stone (idea by HSI)'], fr: ['🪨 Nouveau skin : Rock Smash (1 600 pièces). Un poing fracasse chaque rocher, et un chiffre lumineux brille dans la pierre fendue (idée de HSI)'] },
    { id: '2026-10-25-cracked-skin', date: 'Oct 25, 2026', en: ['📱 New skin: Cracked Screen (1,500 coins). A phone screen that glitches while it rolls; every digit hits the glass and cracks it a little more, and Mythic rolls shatter it (idea by KMC)'], fr: ['📱 Nouveau skin : Cracked Screen (1 500 pièces). Un écran de téléphone qui bugue pendant le tirage ; chaque chiffre frappe la vitre et la fissure un peu plus, et les Mythic la font voler en éclats (idée de KMC)'] },
    { id: '2026-10-25-castle-skin', date: 'Oct 25, 2026', en: ['🏰 New skin: Medieval Castle (2,400 coins). Royal banners unfurl one by one on a stone castle wall lit by torches, and rare rolls end in fireworks over the battlements (idea by BIGBOIJONER69)'], fr: ['🏰 Nouveau skin : Medieval Castle (2 400 pièces). Des bannières royales se déroulent une à une sur un rempart de pierre éclairé par des torches, et les tirages rares finissent en feu d\'artifice au-dessus des créneaux (idée de BIGBOIJONER69)'] },
    { id: '2026-10-25-chocolate-skin', date: 'Oct 25, 2026', en: ['🍫 New skin: Chocolate (1,300 coins). A milk chocolate bar in gold foil: digits melt while it rolls, then every square snaps into shape, and Mythic rolls drip with melted chocolate (idea by finnnnn)'], fr: ['🍫 Nouveau skin : Chocolate (1 300 pièces). Une tablette de chocolat au lait dans du papier doré : les chiffres fondent pendant le tirage, puis chaque carré se fige d\'un coup sec, et les Mythic dégoulinent de chocolat fondu (idée de finnnnn)'] },
    { id: '2026-10-25-fish-skin', date: 'Oct 25, 2026', en: ['🐟 New skin: Floppy Fish (2,100 coins). A goofy fish flops out of the pond for every digit, the digits jump out of the water, and a giant fish leaps over the card on Mythic rolls (idea by AnnJoe)'], fr: ['🐟 Nouveau skin : Floppy Fish (2 100 pièces). Un poisson rigolo saute hors de la mare pour chaque chiffre, les chiffres bondissent hors de l\'eau, et un poisson géant saute par-dessus la carte sur les Mythic (idée d\'AnnJoe)'] },
    { id: '2026-10-25-axeman-skin', date: 'Oct 25, 2026', en: ['🪓 New skin: Axe Thrower (1,900 coins). A stick man throws a spinning axe into every wooden target (thunk!), and celebrates when the roll is good (idea by jjcoolcid1)'], fr: ['🪓 Nouveau skin : Axe Thrower (1 900 pièces). Un bonhomme bâton lance une hache qui tournoie dans chaque cible en bois (tchac !), et fait la fête quand le tirage est bon (idée de jjcoolcid1)'] },
    { id: '2026-10-25-math-skin', date: 'Oct 25, 2026', en: ['➗ New skin: Math (1,200 coins). Chalk digits are written on a blackboard while math symbols (+ − × ÷ π √ ∑ ∞) float around, and great rolls end with Q.E.D. (idea by sennybex1)'], fr: ['➗ Nouveau skin : Math (1 200 pièces). Des chiffres à la craie s\'écrivent sur un tableau noir pendant que des symboles mathématiques (+ − × ÷ π √ ∑ ∞) flottent autour, et les grands tirages finissent par CQFD (idée de sennybex1)'] },
    { id: '2026-10-25-supernova-skin', date: 'Oct 25, 2026', en: ['💥 New skin: Supernova (3,600 coins). A dying star in neon blue and violet: every digit sends out a shockwave, and the reveal goes supernova, bigger on Mythic rolls (idea by jjcoolcid1)'], fr: ['💥 Nouveau skin : Supernova (3 600 pièces). Une étoile qui meurt, en néon bleu et violet : chaque chiffre envoie une onde de choc, et la révélation explose en supernova, encore plus fort sur un Mythic (idée de jjcoolcid1)'] },
    { id: '2026-10-25-woodcarving-skin', date: 'Oct 25, 2026', en: ['🪵 New skin: Wood Carving (2,000 coins, ideas by jjcoolcid1 and JBearr12). A knife carves every digit into a pine plank and the shavings fly; rare rolls get a coat of golden varnish'], fr: ['🪵 Nouveau skin : Wood Carving (2 000 pièces, idées de jjcoolcid1 et JBearr12). Une lame taille chaque chiffre dans une planche de pin et les copeaux volent ; les tirages rares reçoivent une couche de vernis doré'] },
    { id: '2026-10-25-greek-skin', date: 'Oct 25, 2026', en: ['🏛️ New skin: Greek (2,000 coins, idea by kaz). Every digit is carved on a turning marble column: roman numerals spin past, then the drum stops and the real digit is chiselled in, with a puff of marble dust; rare rolls get a golden laurel glow'], fr: ['🏛️ Nouveau skin : Grec (2 000 pièces, idée de kaz). Chaque chiffre est gravé sur une colonne de marbre qui tourne : des chiffres romains défilent, puis le fût s\'arrête et le vrai chiffre est ciselé, dans un nuage de poussière de marbre ; les tirages rares brillent d\'une lueur de laurier doré'] },
    { id: '2026-10-25-dna-skin', date: 'Oct 25, 2026', en: ['🧬 New skin: DNA Helix (2,400 coins). A glowing double helix twists behind the digits, and every digit snaps in like a base pair (idea by R77)'], fr: ['🧬 Nouveau skin : DNA Helix (2 400 pièces). Une double hélice lumineuse tourne derrière les chiffres, et chaque chiffre s\'emboîte comme une paire de bases (idée de R77)'] },
    { id: '2026-10-25-fairydust-skin', date: 'Oct 25, 2026', en: ['🧚 New skin: Fairy Dust (2,000 coins, idea by R77). Sparkling fairy dust swirls into every digit with a tap of the wand, a fairy circles the card leaving a glittering trail, and rare rolls rain gold'], fr: ['🧚 Nouveau skin : Fairy Dust (2 000 pièces, idée de R77). Une poussière de fée scintillante se rassemble en chaque chiffre d\'un coup de baguette, une fée tourne autour de la carte en laissant une traînée de paillettes, et les tirages rares font pleuvoir de l\'or'] },
    { id: '2026-10-25-elemental-skin', date: 'Oct 25, 2026', en: ['🌀 New legendary skin: Elemental (14,000 coins). Every digit lands as a new element, rock, ice, fire then wind, and the card turns into it, with four element spirits circling it (idea by kaz)'], fr: ['🌀 Nouveau skin légendaire : Elemental (14 000 pièces). Chaque chiffre se pose dans un nouvel élément, roche, glace, feu puis vent, et la carte en prend la matière, avec quatre esprits des éléments qui tournent autour (idée de kaz)'] },
    { id: '2026-10-25-divine-skin', date: 'Oct 25, 2026', en: ['⚖️ New Legendary skin: Divine Judgment (17,500 coins, Premium). A heavenly tribunal weighs every digit on golden scales, a pillar of light strikes each one into place, and Mythic rolls get a halo and falling feathers (idea by Gray alt)'], fr: ['⚖️ Nouveau skin Legendary : Divine Judgment (17 500 pièces, Premium). Un tribunal céleste pèse chaque chiffre sur une balance dorée, un pilier de lumière le frappe en place, et les tirages Mythic reçoivent une auréole et des plumes (idée de Gray alt)'] },
    { id: '2026-10-25-wp-summit', date: 'Oct 25, 2026', en: ['🏔️ New legendary wallpaper Summit (4,000 coins): snowy mountains under the sun, and on every Mythic+ roll night falls, the stars come out and the moon rises behind the peaks (idea by JBearr12)'], fr: ['🏔️ Nouveau fond légendaire Sommet (4 000 pièces) : des montagnes enneigées sous le soleil, et à chaque tirage Mythic+ la nuit tombe, les étoiles s\'allument et la lune se lève derrière les sommets (idée de JBearr12)'] },
    { id: '2026-10-25-wp-bubbles', date: 'Oct 25, 2026', en: ['🫧 New wallpaper ASMR Bubbles (1,000 coins): shiny bubbles float up behind the game, and you can pop them with a click on the background, with a soft pop sound (idea by kingston)'], fr: ['🫧 Nouveau fond Bulles ASMR (1 000 pièces) : des bulles irisées montent derrière le jeu, et tu peux les éclater d\'un clic sur le fond, avec un petit « pop » (idée de kingston)'] },
    { id: '2026-10-25-wp-oceanic', date: 'Oct 25, 2026', en: ['🐋 New legendary wallpaper Open Ocean (5,000 coins): a humpback whale, sharks and dolphins swim across the screen; rare rolls light up the water, Anomaly+ sends up bubbles and Mythic+ a pod of dolphins (idea by AnnJoe)'], fr: ['🐋 Nouveau fond légendaire Pleine mer (5 000 pièces) : une baleine à bosse, des requins et des dauphins traversent l\'écran ; les tirages rares illuminent l\'eau, les Anomaly+ font monter des bulles et les Mythic+ un banc de dauphins (idée d\'AnnJoe)'] },
    { id: '2026-10-25-wp-racetrack', date: 'Oct 25, 2026', en: ['🏎️ New wallpaper Grand Prix (1,100 coins): race cars scream down the main straight in front of a packed grandstand (idea by YU CHUAN 23)'], fr: ['🏎️ Nouveau fond Grand Prix (1 100 pièces) : des monoplaces filent sur la ligne droite devant une tribune pleine (idée de YU CHUAN 23)'] },
    { id: '2026-10-25-wp-windybeach', date: 'Oct 25, 2026', en: ['🏖️ New wallpaper Windy Beach (900 coins): the umbrella leans in the gusts, sand blows across the screen and a beach ball rolls by (idea by 17black)'], fr: ['🏖️ Nouveau fond Plage venteuse (900 pièces) : le parasol penche dans les rafales, le sable vole et un ballon de plage roule (idée de 17black)'] },
    { id: '2026-10-24-waterfall-skin', date: 'Oct 24, 2026', en: ['🏞️ New skin: Waterfall (2,300 coins). A waterfall in a green valley carries every digit down into the pool with a splash, and rare rolls make a rainbow in the spray (ideas by JBearr12 and jjcoolcid1)'], fr: ['🏞️ Nouveau skin : Waterfall (2 300 pièces). Une cascade dans une vallée verte emporte chaque chiffre dans le bassin avec une éclaboussure, et les tirages rares font un arc-en-ciel dans les embruns (idées de JBearr12 et jjcoolcid1)'] },
    { id: '2026-10-25-shinydiamond-skin', date: 'Oct 25, 2026', en: ['💍 New skin: Shiny Diamond (3,000 coins). Every digit is engraved in a brilliant-cut diamond on black velvet: the facets flicker while it turns, each stone locks in with a star glint, and rare rolls throw rainbow sparkles (idea by finnnnn)'], fr: ['💍 Nouveau skin : Shiny Diamond (3 000 pièces). Chaque chiffre est gravé dans un diamant taille brillant sur du velours noir : les facettes scintillent pendant le tirage, chaque pierre se sertit avec un éclat en étoile, et les tirages rares lancent des étincelles arc-en-ciel (idée de finnnnn)'] },
    { id: '2026-10-24-dynamite-skin', date: 'Oct 24, 2026', en: ['🧨 New skin: Dynamite (2,500 coins). A crate of dynamite: every fuse burns down and each stick blows up to reveal its digit, and Mythic rolls end in a mushroom cloud (ideas by casmictechthing and ichi)'], fr: ['🧨 Nouveau skin : Dynamite (2 500 pièces). Une caisse de dynamite : chaque mèche brûle et chaque bâton explose pour révéler son chiffre, et les tirages Mythic finissent en champignon de fumée (idées de casmictechthing et ichi)'] },
    { id: '2026-10-24-infinity-rework', date: 'Oct 24, 2026', en: ['♾️ The Infinity skin was remade to match Singularity: dark space glass with a loop of light running through it, bright white digits that are easy to read, digits pulled around the loop while rolling, and the big ∞ stays visible the whole roll (idea by kaz)'], fr: ['♾️ Le skin Infinity a été refait pour être au niveau de Singularity : du verre spatial sombre traversé par une boucle de lumière, des chiffres blancs bien lisibles, entraînés autour de la boucle pendant le tirage, et le grand ∞ visible pendant tout le tirage (idée de kaz)'] },
    { id: '2026-10-23-burger-skin', date: 'Oct 23, 2026', en: ['🍔 New skin: Burger (idea by jaxoncool43). Every digit drops a topping (lettuce, cheddar, patty, tomato, onion, pickle), then the top bun slams down to finish the burger; rare rolls come out steaming'], fr: ['🍔 Nouveau skin : Burger (idée de jaxoncool43). Chaque chiffre fait tomber un ingrédient (salade, cheddar, steak, tomate, oignon, cornichon), puis le pain du dessus s\'écrase pour finir le burger ; les tirages rares sortent tout fumants'] },
    { id: '2026-10-24-emote-spread', date: 'Oct 24, 2026', en: ['💸 New emote in the shop: Money Spread, a smug dice fanning out a stack of bills (idea by finnnnn)'], fr: ['💸 Nouvelle émote dans la boutique : Éventail de billets, un dé tout fier qui étale une liasse de billets (idée de finnnnn)'] },
    { id: '2026-10-24-idea-images', date: 'Oct 24, 2026', en: ['📎 Ideas and bug reports: you can now attach up to 3 images, to an idea too (pick them or paste them in the 💡 window) (idea by Phong254)'], fr: ['📎 Idées et bugs : tu peux maintenant joindre jusqu\'à 3 images, à une idée aussi (choisis-les ou colle-les dans la fenêtre 💡) (idée de Phong254)'] },
    { id: '2026-10-24-casino-order', date: 'Oct 24, 2026', en: ['↕ Casino: put the games in your own order. Press "Reorder games" under the tabs, then use the arrows or drag the tabs (idea by jia jun)'], fr: ['↕ Casino : range les jeux dans ton ordre. Appuie sur « Réorganiser les jeux » sous les onglets, puis utilise les flèches ou fais glisser les onglets (idée de jia jun)'] },
    { id: '2026-10-24-result-coins', date: 'Oct 24, 2026', en: ['🪙 The result screen now shows the coins a roll earned, right under its XP (idea by jaxoncool43)'], fr: ['🪙 L\'écran de résultat affiche maintenant les pièces gagnées par le tirage, juste sous son XP (idée de jaxoncool43)'] },
    { id: '2026-10-23-jet-badges', date: 'Oct 23, 2026', en: ['✈️ New Jet badges for airliner numbers: 🛫 Jet 737, ✈️ Jumbo Jet (747), 🛩️ Jet 757, 🛬 Jet 767 and 🌤️ Jet 787 (ideas by TibotyTWO and CococoC). Only the best Jet badge of a roll counts, and 777 stays the Jackpot'], fr: ['✈️ Nouveaux badges Jet pour les numéros d\'avions de ligne : 🛫 Jet 737, ✈️ Jumbo Jet (747), 🛩️ Jet 757, 🛬 Jet 767 et 🌤️ Jet 787 (idées de TibotyTWO et CococoC). Seul le meilleur badge Jet d\'un tirage compte, et 777 reste le Jackpot'] },
    { id: '2026-10-23-hist-reps', date: 'Oct 23, 2026', en: ['🔁 History: new sort "Most rolled" to see the numbers you got the most times first (idea by CococoC)'], fr: ['🔁 Historique : nouveau tri « Les plus tirés » pour voir d\'abord les nombres que tu as eus le plus de fois (idée de CococoC)'] },
    { id: '2026-10-24-title2026', date: 'Oct 24, 2026', en: ['The 📅 2026 title now goes to everyone who plays in 2026 (equip it from your profile). From January 1st, 2027, it can no longer be earned. The Current Year badge for numbers containing 2026 stays'], fr: ['Le titre 📅 2026 va maintenant à tous ceux qui jouent en 2026 (équipe-le depuis ton profil). À partir du 1er janvier 2027, il ne se gagne plus. Le badge Current Year pour les nombres contenant 2026 reste'] },
    { id: '2026-10-24-badges-250-99-727', date: 'Oct 24, 2026', en: ['🔢 New badges: ⏳ Quarter Millennium (ends in 250, idea by WpBejs), 9️⃣ Ninety-Nine and 🎯 Exact 99 (idea by kaz), 👀 WYSI and 🫣 Exact WYSI (727, idea by Phong254) and 🔁 Cyclic Number (exactly 142857, idea by JBearr12)'], fr: ['🔢 Nouveaux badges : ⏳ Quarter Millennium (finit par 250, idée de WpBejs), 9️⃣ Ninety-Nine et 🎯 Exact 99 (idée de kaz), 👀 WYSI et 🫣 Exact WYSI (727, idée de Phong254) et 🔁 Cyclic Number (exactement 142857, idée de JBearr12)'] },
    { id: '2026-10-23h', date: 'Oct 23, 2026', en: ['🐞 Fixed: a roll could show "undefined" when the server answered slowly (reported by Yentizx). The game now asks again for the same roll, so nothing is lost'], fr: ['🐞 Corrigé : un tirage pouvait afficher « undefined » quand le serveur répondait lentement (signalé par Yentizx). Le jeu redemande maintenant le même tirage, rien n\'est perdu'] },
    { id: '2026-10-23g', date: 'Oct 23, 2026', en: ['🚪 Duels: you can now leave a game in progress (button under the roll button), and the host can remove a player during the game with the ✕ next to their name. If everyone else leaves, the last player wins. In a duel with a bet, nobody can be removed, and a player who leaves loses their bet'], fr: ['🚪 Duels : tu peux maintenant quitter une partie en cours (bouton sous le bouton de tirage), et l\'hôte peut exclure un joueur pendant la partie avec le ✕ à côté de son nom. Si tous les autres partent, le dernier joueur gagne. Dans un duel avec mise, personne ne peut être exclu, et celui qui part perd sa mise'] },
    { id: '2026-10-23f', date: 'Oct 23, 2026', en: ['🏆 Tournaments: there are now two tournaments every day (32 players each, you can only join one), and you no longer need to be online at the same time as your opponent. When one of you rolls, the server rolls for the other too, and any rolls left are made for both at the end of the round. No more losing just because you were asleep!'], fr: ['🏆 Tournois : il y a maintenant deux tournois par jour (32 joueurs chacun, tu ne peux en rejoindre qu\'un), et plus besoin d\'être en ligne en même temps que ton adversaire. Quand l\'un de vous tire, le serveur tire aussi pour l\'autre, et les tirages qui restent sont faits pour les deux à la fin du tour. Fini de perdre parce que tu dormais !'] },
    { id: '2026-10-23e', date: 'Oct 23, 2026', en: ['🐞 Fixes: the case Odds ⓘ now open with a tap on iPad and phones (reported by Aussie Haüs); tapping Roll again while auto-roll is revealing no longer cuts the roll (reported by jaxoncool43)'], fr: ['🐞 Corrections : les chances des caisses (Odds ⓘ) s\'ouvrent d\'un toucher sur iPad et téléphone (signalé par Aussie Haüs) ; toucher Rejouer pendant une révélation en tirage auto ne coupe plus le tirage (signalé par jaxoncool43)'] },
    { id: '2026-10-23d', date: 'Oct 23, 2026', en: ['📷 You can now send images and screenshots to your friends: press 📷 next to the message box. Click an image to enlarge it'], fr: ['📷 Tu peux maintenant envoyer des images et des captures d\'écran à tes amis : appuie sur 📷 à côté du message. Clique une image pour l\'agrandir'] },
    { id: '2026-10-23c', date: 'Oct 23, 2026', en: ['🐞 Duels: the chat no longer disappears when the game starts, no refresh needed'], fr: ['🐞 Duels : le chat ne disparaît plus quand la partie commence, plus besoin de recharger'] },
    { id: '2026-10-23b', date: 'Oct 23, 2026', en: ['🎁 New code for my friend randomguy: use ICHI in Player & settings for 🪙 100 coins'], fr: ['🎁 Nouveau code pour mon ami randomguy : utilise ICHI dans Joueur et réglages pour 🪙 100 pièces'] },
    { id: '2026-10-23a', date: 'Oct 23, 2026', en: [
      '🔢 New badges: 🇺🇸 American (1776, idea by jaxoncool43), 😇 Angel Number (82, idea by kaz), 🧿 Vortrox Curse (92, idea by CococoC), 🧃 Sixty-One (61, idea by schoolroller), 🖤 Juice WRLD (999, idea by Colt2), 👑 Brainrot King (6741 or 4167) and 🫅 Brainrot Emperor (exactly 676741 or 674141, ideas by CrazyMiner22)',
      '🛋️ New titles: The King Of Unemployment (1,000,000 rolls) and The God Of Unemployment (10,000,000 rolls), idea by A Dude',
      '🔘 New collection titles: Button Masher, Emote Lord and Interior Designer, for owning every button, emote or wallpaper (idea by PRISMA123)',
      '😵‍💫 New emote: Super confused (idea by finnnnn)',
      '✏️ You can now edit your messages, with friends and in the duel chat (idea by kingston)',
      '🔑 A Premium key can now also open a Starter or Wallpaper case (idea by keys)',
      '🧈 The ASMR skin crunches more naturally (idea by JAKECisthebest)',
      '⭐ Skip known badges: open any badge and pick “Always shown in full” to keep its full reveal (idea by Aussie Haüs)',
      '🚲 Wheelie skin: the rider no longer hides under the top bar during a roll (reported by jia jun)',
      '🎲 Back from another tab: the rolls made while you were away now also show your best one (idea by kingston)',
      '💡 Skin creators: when someone buys a skin that came from a player\'s idea, that player now gets 5% of the price in coins. Look for “Idea by” in the Shop! (idea by Gray alt)',
      '🐞 Fixes: the Collectible Connoisseur title no longer needs the free Classic skin; coins no longer go up before a roll is revealed; auto-roll no longer cuts a roll you started by hand',
    ], fr: [
      '🔢 Nouveaux badges : 🇺🇸 American (1776, idée de jaxoncool43), 😇 Angel Number (82, idée de kaz), 🧿 Vortrox Curse (92, idée de CococoC), 🧃 Sixty-One (61, idée de schoolroller), 🖤 Juice WRLD (999, idée de Colt2), 👑 Brainrot King (6741 ou 4167) et 🫅 Brainrot Emperor (exactement 676741 ou 674141, idées de CrazyMiner22)',
      '🛋️ Nouveaux titres : le Roi du Chômage (1 000 000 de tirages) et le Dieu du Chômage (10 000 000), idée d\'A Dude',
      '🔘 Nouveaux titres de collection : Maître des boutons, Seigneur des émotes et Décorateur, pour avoir tous les boutons, émotes ou fonds (idée de PRISMA123)',
      '😵‍💫 Nouvelle émote : Super perdu (idée de finnnnn)',
      '✏️ Tu peux maintenant modifier tes messages, entre amis et dans le chat des duels (idée de kingston)',
      '🔑 Une clé Premium ouvre aussi une caisse Starter ou Fonds (idée de keys)',
      '🧈 Le skin ASMR craque de façon plus naturelle (idée de JAKECisthebest)',
      '⭐ Passer les badges connus : ouvre un badge et choisis « Toujours montré en entier » pour garder sa révélation (idée d\'Aussie Haüs)',
      '🚲 Skin Wheelie : le cycliste ne se cache plus sous la barre du haut pendant un tirage (signalé par jia jun)',
      '🎲 Retour d\'un autre onglet : les tirages faits pendant ton absence montrent aussi ton meilleur (idée de kingston)',
      '💡 Créateurs de skins : quand quelqu\'un achète un skin né de l\'idée d\'un joueur, ce joueur reçoit 5 % du prix en pièces. Cherche « Idea by » dans la boutique ! (idée de Gray alt)',
      '🐞 Corrections : le titre Grand collectionneur ne demande plus le skin Classic gratuit ; les pièces ne montent plus avant la fin du tirage ; le tirage auto ne coupe plus un tirage lancé à la main',
    ] },
    { id: '2026-10-22m', date: 'Oct 22, 2026', en: [
      '🎲 New casino game: Dice (idea by CYCOX and YU CHUAN 23). Set your target, pick Roll under or Roll over: the lower your chance, the bigger the payout (up to 48.5×). Or guess a 6-sided die for 5.82×',
      '🧸 New casino game: Teddy Roulette (idea by d_alex). A confetti popper with 6 chambers aims at a cute teddy: each click raises your payout (up to 5.82×), but one chamber goes BOOM. Cash out whenever you like!',
      '▶ Every skin in the shop now has a Preview button, ASMR included',
      '🔊 Roll sound packs: a new Sounds tab in the Shop with 5 packs (Arcade, Coins, Drums, Space, Glass, 300 to 800 coins). Each changes the sound of every digit and of the rarity reveal. Press ▶ Preview to listen before buying (idea by Angelicide9)',
    ], fr: [
      '🎲 Nouveau jeu au casino : les Dés (idée de CYCOX et YU CHUAN 23). Règle ta cible, choisis En dessous ou Au-dessus : moins tu as de chances, plus le gain est gros (jusqu\'à 48,5×). Ou devine un dé à 6 faces pour 5,82×',
      '🧸 Nouveau jeu au casino : la Roulette Nounours (idée de d_alex). Un canon à confettis à 6 chambres vise un nounours : chaque clic fait monter ton gain (jusqu\'à 5,82×), mais une chambre fait BOUM. Encaisse quand tu veux !',
      '▶ Tous les skins de la boutique ont maintenant un bouton Aperçu, ASMR compris',
      '🔊 Packs de sons du tirage : un nouvel onglet Sons dans la boutique avec 5 packs (Arcade, Coins, Drums, Space, Glass, de 300 à 800 pièces). Chacun change le son de chaque chiffre et de la rareté. Appuie sur ▶ Aperçu pour écouter avant d\'acheter (idée d\'Angelicide9)',
    ] },
    { id: '2026-10-22l', date: 'Oct 22, 2026', en: [
      '🏆 Tournament modes: the daily tournament now changes its rules every day: Total XP, Best Roll, Best of 3, Lowest Wins (trash is gold!) and Badge Hunter (idea by PRISMA123)',
      '🪟 New skin Blinds: every digit hides behind a closed blind; the slats snap open on a glowing neon-yellow number, and from Mythic the sun sets and the moon rises (idea by costoroll)',
    ], fr: [
      '🏆 Modes de tournoi : le tournoi du jour change de règles chaque jour : Total d\'XP, Meilleur tirage, En 3 manches, Le plus bas gagne (la poubelle vaut de l\'or !) et Chasseur de badges (idée de PRISMA123)',
      '🪟 Nouveau skin Blinds : chaque chiffre se cache derrière un store fermé ; les lames s\'ouvrent d\'un coup sec sur un chiffre jaune néon, et dès Mythic le soleil se couche et la lune se lève (idée de costoroll)',
    ] },
    { id: '2026-10-22k', date: 'Oct 22, 2026', en: ['🙏 Sorry for today\'s outage! RNG∞ moved to its own server so it can stay online for good. To say sorry, use the code SORRY404 in Player & settings for 🪙 500 coins (until October 29). If you still see a "404" page, close your browser completely and open it again'], fr: ['🙏 Désolé pour la coupure d\'aujourd\'hui ! RNG∞ a déménagé sur son propre serveur pour rester en ligne pour de bon. Pour nous excuser, utilise le code SORRY404 dans Joueur et réglages : 🪙 500 pièces (jusqu\'au 29 octobre). Si tu vois encore une page « 404 », ferme complètement ton navigateur et rouvre-le'] },
    { id: '2026-10-22j', date: 'Oct 22, 2026', en: ['⚖️ History: tap Compare, then two rolls, to see them side by side: XP difference, badges in common and badges each one has (idea by kingston)', '🗑️ You can delete your own messages in private chats and in the duel chat (idea by Ann Joe NO.1 gambler)', '👽 New badge Area 51: contains 51 (idea by hii)'], fr: ['⚖️ Historique : touche Comparer, puis deux tirages, pour les voir côte à côte : écart d\'XP, badges en commun et badges propres à chacun (idée de kingston)', '🗑️ Tu peux supprimer tes propres messages en privé et dans le chat des duels (idée d\'Ann Joe NO.1 gambler)', '👽 Nouveau badge Area 51 : contient 51 (idée de hii)'] },
    { id: '2026-10-22i', date: 'Oct 22, 2026', en: ['Fixed: auto-roll could sometimes start the next roll right away; the result now always stays on screen for a moment, also when you come back to the tab (reported by WpBejs)'], fr: ['Corrigé : le tirage auto pouvait parfois relancer tout de suite ; le résultat reste maintenant toujours affiché un instant, aussi au retour sur l\'onglet (signalé par WpBejs)'] },
    { id: '2026-10-22h', date: 'Oct 22, 2026', en: ['⚔️ Duels: the host can remove a player from the lobby with the small ✕ next to their name, before the game starts. Their stake is refunded and they can\'t rejoin that duel'], fr: ['⚔️ Duels : l\'hôte peut exclure un joueur du salon avec le petit ✕ à côté de son nom, avant le début de la partie. Sa mise lui est rendue et il ne peut plus revenir dans ce duel'] },
    { id: '2026-10-22g', date: 'Oct 22, 2026', en: ['🗼 Tower: Easy and Normal multipliers are lower, to match how likely each floor is (Normal top floor: ×24.09, Easy: ×9.38). Hard stays as it is'], fr: ['🗼 Tour : les multiplicateurs Facile et Normal sont plus bas, pour coller aux vraies chances de chaque étage (sommet en Normal : ×24,09, en Facile : ×9,38). Le Difficile ne change pas'] },
    { id: '2026-10-22f', date: 'Oct 22, 2026', en: [
      '🔊 New skin Sonic Wave: the digits ride a glowing sound wave, every one lands with a shockwave and the last one booms (idea by Matthew)',
      '🛸 New skin UFO: a flying saucer beams every digit down onto the grass, then zips away (idea by JBearr12)',
      '🚲 New skin Wheelie: a rider pulls a wheelie along the curb and every digit pops up in his wake, then he jumps on the reveal (idea by JBearr12)',
      '🍩 New skin Polygon Donut: a low-poly frosted donut spins behind faceted digits, and sprinkles bounce out on the reveal (idea by PongonLOLZFan)',
      '✨ Legendary skins upgraded: Sakura, Storm, Dragon and Singularity now have a finale that grows with rarity, from Mythic up to Divine and beyond (idea by PRISMA123)',
      '🖼️ New Wallpaper Case: 600 coins for a random animated wallpaper worth 500 to 1,200; part of the price comes back if you already own it (idea by CrazyMiner22)',
    ], fr: [
      '🔊 Nouveau skin Sonic Wave : les chiffres voyagent sur une onde sonore lumineuse, chacun se pose avec une onde de choc et le dernier fait boum (idée de Matthew)',
      '🛸 Nouveau skin UFO : une soucoupe volante dépose chaque chiffre sur l\'herbe avec son rayon, puis file à toute vitesse (idée de JBearr12)',
      '🚲 Nouveau skin Wheelie : un cycliste roule en wheelie sur la bordure et chaque chiffre surgit dans son sillage, puis il saute à la révélation (idée de JBearr12)',
      '🍩 Nouveau skin Polygon Donut : un donut glacé en polygones tourne derrière des chiffres à facettes, et des vermicelles rebondissent à la révélation (idée de PongonLOLZFan)',
      '✨ Skins légendaires améliorés : Sakura, Storm, Dragon et Singularity ont un final qui grandit avec la rareté, de Mythic jusqu\'à Divine et au-delà (idée de PRISMA123)',
      '🖼️ Nouvelle caisse de fonds : 600 pièces pour un fond animé au hasard valant 500 à 1 200 ; une partie du prix revient si tu l\'as déjà (idée de CrazyMiner22)',
    ] },
    { id: '2026-10-22e', date: 'Oct 22, 2026', en: ['🗼 Tower rebalanced: multipliers are a little lower (the casino keeps 3%, like the other games) and Hard bets are capped at 100 coins, so one lucky climb can\'t break the leaderboard'], fr: ['🗼 Tour rééquilibrée : les multiplicateurs sont un peu plus bas (le casino garde 3 %, comme les autres jeux) et les mises en Difficile sont plafonnées à 100 pièces, pour qu\'un seul coup de chance ne fausse plus le classement'] },
    { id: '2026-10-22d', date: 'Oct 22, 2026', en: ['🥈🥉 The "Today\'s best roll" card now shows the 2nd and 3rd best rolls too (idea by JAKECisthebest)', '🔀 New badge Countdown Shuffle: the digits of 10, 9, 8, 7, 6 in any order (idea by MereTera)'], fr: ['🥈🥉 La carte « Meilleur tirage du jour » montre aussi le 2e et le 3e (idée de JAKECisthebest)', '🔀 Nouveau badge Countdown Shuffle : les chiffres de 10, 9, 8, 7, 6 dans n\'importe quel ordre (idée de MereTera)'] },
    { id: '2026-10-22c', date: 'Oct 22, 2026', en: ['Fixed: Coin Millionaire showed as unlocked for players who had rolled a 1M+ XP number (reported by PRISMA123)', '🧪 Lab: the tubes are now orange, blue, white, purple, green and red (asked by costoroll)'], fr: ['Corrigé : Coin Millionaire apparaissait débloqué chez ceux qui avaient tiré un nombre à plus d\'1M d\'XP (signalé par PRISMA123)', '🧪 Lab : les tubes sont maintenant orange, bleu, blanc, violet, vert et rouge (demandé par costoroll)'] },
    { id: '2026-10-22b', date: 'Oct 22, 2026', en: ['🎱 New casino game: Keno (idea by CYCOX). Pick 1 to 10 numbers out of 40, bet up to 100 coins and watch 10 balls being drawn. The more of your numbers come out, the bigger the win, up to 1000×. Your last picks are remembered for a quick replay'], fr: ['🎱 Nouveau jeu de casino : le Keno (idée de CYCOX). Coche 1 à 10 numéros parmi 40, mise jusqu\'à 100 pièces et regarde les 10 boules sortir. Plus tu trouves de numéros, plus tu gagnes, jusqu\'à 1000×. Tes derniers numéros sont gardés pour rejouer en un clic'] },
    { id: '2026-10-22a', date: 'Oct 22, 2026', en: [
      '🟢 Friends: see if each friend is Online, AFK (tab hidden or idle for 5 min) or Offline',
      '🧪 New skin Lab: six test tubes of coloured liquid; every digit lights up in its tube with a glassy clink, then fizzes (idea by costoroll)',
      '🍡 New skin Marshmallow: puffy pastel digits, marshmallows falling from the sky and party poppers on the reveal (idea by DandoriNinja)',
      '🍔 New Diner wallpaper: a 50s diner at night with a flickering neon sign (idea by JBearr12)',
      '🏆 A banner on the home page and in the casino tells you when the daily tournament is open or when your match is ready (idea by PRISMA123)',
      '🤖 Duels: the host can fill the empty seats with bots after 2 minutes (idea by Aussie Haüs)',
      '🤑 New achievement Coin Millionaire: hold 1,000,000 coins at once (idea by A Dude)',
      '🏷️ New badges: Forty-Nine (49) and Double Five (55) (idea by A Dude), AK (47) (idea by R77)',
      '👑 A note shows when a number contains your best roll ever (idea by spookiedookie)',
      'Fixed: pressing Roll during an auto-roll reveal could cut the roll short (found by shadow2)',
      'Fixed: old Garbage and Land waste rolls now count for their rarity and titles (reported by R77)',
    ], fr: [
      '🟢 Amis : vois si chaque ami est En ligne, AFK (onglet caché ou inactif depuis 5 min) ou Hors ligne',
      '🧪 Nouveau skin Lab : six tubes à essai de liquides colorés ; chaque chiffre s\'allume dans son tube avec un tintement de verre, puis pétille (idée de costoroll)',
      '🍡 Nouveau skin Marshmallow : des chiffres en guimauve pastel, des guimauves qui tombent du ciel et des canons à confettis à la révélation (idée de DandoriNinja)',
      '🍔 Nouveau fond Diner : un diner des années 50, la nuit, avec son enseigne néon qui grésille (idée de JBearr12)',
      '🏆 Un bandeau sur l\'accueil et au casino te prévient quand le tournoi du jour est ouvert ou quand ton match est prêt (idée de PRISMA123)',
      '🤖 Duels : l\'hôte peut compléter les places vides avec des bots après 2 minutes (idée d\'Aussie Haüs)',
      '🤑 Nouveau succès Millionnaire : possède 1 000 000 de pièces en même temps (idée d\'A Dude)',
      '🏷️ Nouveaux badges : Forty-Nine (49) et Double Five (55) (idée d\'A Dude), AK (47) (idée de R77)',
      '👑 Une note s\'affiche quand un nombre contient ton meilleur tirage (idée de spookiedookie)',
      'Corrigé : appuyer sur Roll pendant la révélation d\'un tirage auto pouvait couper le tirage (trouvé par shadow2)',
      'Corrigé : les anciens tirages Garbage et Land waste comptent maintenant pour leur rareté et leurs titres (signalé par R77)',
    ] },
    { id: '2026-10-21e', date: 'Oct 21, 2026', en: ['♾️ New legendary wallpaper Aether: a galaxy around a glowing infinity sign that reacts to every roll: calm on common rolls, a wave of colour on rare ones, sparkles from Mythic and a celestial burst on Divine and above (idea by Me Cojoni)'], fr: ['♾️ Nouveau fond légendaire Aether : une galaxie autour d\'un signe infini lumineux qui réagit à chaque tirage : calme sur les tirages courants, une vague de couleur sur les rares, des éclats dès Mythique et une explosion céleste à partir de Divine (idée de Me Cojoni)'] },
    { id: '2026-10-21d', date: 'Oct 21, 2026', en: [
      '🏆 Daily tournaments (idea by PRISMA123)! Sign up for free before 12:00 UTC (30 rolls needed), then play your match whenever you like during its round: 5 tournament rolls each, highest total wins. Tournament rolls don\'t count anywhere else. Winner gets 1,000 coins and the Champion title, finalist 400, semi-finalists 150. Find it on the Duel page',
      '🌀 New skin Cursed Energy: violet cursed energy flows around every digit and a seal burns on each one, with a matching Generate button and duel frame (idea by Edward)',
    ], fr: [
      '🏆 Tournois quotidiens (idée de PRISMA123) ! Inscris-toi gratuitement avant 12:00 UTC (30 tirages requis), puis joue ton match quand tu veux pendant son tour : 5 tirages de tournoi chacun, le plus gros total gagne. Les tirages de tournoi ne comptent nulle part ailleurs. Le vainqueur gagne 1 000 pièces et le titre Champion, le finaliste 400, les demi-finalistes 150. À retrouver sur la page Duel',
      '🌀 Nouveau skin Cursed Energy : une énergie maudite violette coule autour de chaque chiffre et un sceau brûle sur chacun, avec son bouton Generate et son cadre de duel assortis (idée d\'Edward)',
    ] },
    { id: '2026-10-21c', date: 'Oct 21, 2026', en: ['📺 New badge 852655: exactly 852655 (idea by CococoC)', '🖼️ New title Collectible Connoisseur: own every skin, limited ones excepted (idea by kaz)'], fr: ['📺 Nouveau badge 852655 : exactement 852655 (idée de CococoC)', '🖼️ Nouveau titre Grand collectionneur : possède tous les skins, sauf les limités (idée de kaz)'] },
    { id: '2026-10-21b', date: 'Oct 21, 2026', en: ['🎵 RNG∞ has music! “Distant Odds” by Phong67 plays softly in the background. Turn it off in Player & settings (Music), or with the sound button'], fr: ['🎵 RNG∞ a sa musique ! « Distant Odds » de Phong67 joue doucement en fond. Coupe-la dans Joueur et réglages (Musique), ou avec le bouton du son'] },
    { id: '2026-10-21a', date: 'Oct 21, 2026', en: [
      '🗼 New casino game: Tower (idea by Zombara). Bet, then climb 8 floors by picking a safe tile on each one: Easy (4 tiles), Normal (3) or Hard (2), one bomb per floor. Every floor raises the multiplier, up to 250×. Cash out whenever you like',
      '🧈 ASMR pack (idea by JAKECisthebest): the new ASMR skin turns your digits into pastel crunchy wax, kneaded while it rolls and pressed with a satisfying crunch. Two new Generate buttons, Thock and Crunchy Wax, each with its own sound',
      '🌵 New Western wallpaper: a desert sunset, a wooden fence and tumbleweeds rolling by (idea by JBearr12)',
      '😇 Heavenly digits are much easier to read (reported by casmictechthing)',
      '⚙️ Auto-roll: type your own XP amount, stop on a bad roll (Trash or worse), or never stop (ideas by WpBejs, CococoC and Angelicide9)',
      '🎯 Rare rolls show about how often they happen: "~1 in 3,000" (idea by PRISMA123)',
      '🔎 History: search a roll by its number, like #3333 (idea by kaz)',
      '⏩ Skip button when opening a case (idea by Applepi)',
      '💬 A small message tells you when a friend writes to you while you play (idea by JAKECisthebest)',
      '⌨️ Choose your own roll key in Player & settings (idea by jia jun)',
      '🪙 Your profile shows how many coins you spent and how many cases you opened (idea by PRISMA123)',
      '🗿 New achievements: Legend (100,000 rolls, idea by PRISMA123) and 🃏 Card Shark (100 blackjacks, idea by Dylanrulez123)',
      '🏷️ New badges: Med Check (504), Over 9000 (9001), Password (12345), 2077, 2099 and Root of Two (1414, 14142) (ideas by CococoC and R79a)',
    ], fr: [
      '🗼 Nouveau jeu au casino : la Tour (idée de Zombara). Mise, puis grimpe 8 étages en choisissant une case sûre à chaque étage : Facile (4 cases), Normal (3) ou Difficile (2), une bombe par étage. Chaque étage fait monter le multiplicateur, jusqu\'à 250×. Encaisse quand tu veux',
      '🧈 Pack ASMR (idée de JAKECisthebest) : le nouveau skin ASMR transforme tes chiffres en cire croquante pastel, malaxée pendant le tirage puis pressée avec un craquement satisfaisant. Deux nouveaux boutons Generate, Thock et Cire croquante, chacun avec son son',
      '🌵 Nouveau fond Western : un coucher de soleil dans le désert, une palissade et des virevoltants (idée de JBearr12)',
      '😇 Les chiffres de Heavenly se lisent bien mieux (signalé par casmictechthing)',
      '⚙️ Tirage auto : tape ton propre montant d\'XP, arrête-toi sur un mauvais tirage (Trash ou pire), ou ne t\'arrête jamais (idées de WpBejs, CococoC et Angelicide9)',
      '🎯 Les tirages rares montrent à peu près leur fréquence : « ~1 sur 3 000 » (idée de PRISMA123)',
      '🔎 Historique : cherche un tirage par son numéro, comme #3333 (idée de kaz)',
      '⏩ Bouton Passer à l\'ouverture d\'une caisse (idée d\'Applepi)',
      '💬 Un petit message te prévient quand un ami t\'écrit pendant que tu joues (idée de JAKECisthebest)',
      '⌨️ Choisis ta touche de tirage dans Joueur et réglages (idée de jia jun)',
      '🪙 Ton profil montre combien de pièces tu as dépensées et combien de caisses tu as ouvertes (idée de PRISMA123)',
      '🗿 Nouveaux succès : Légende (100 000 tirages, idée de PRISMA123) et 🃏 As des cartes (100 blackjacks, idée de Dylanrulez123)',
      '🏷️ Nouveaux badges : Med Check (504), Over 9000 (9001), Password (12345), 2077, 2099 et Racine de deux (1414, 14142) (idées de CococoC et R79a)',
    ] },
    { id: '2026-10-20b', date: 'Oct 20, 2026', en: ['💥 New badge Exact Drastix: exactly 235 (reported by CococoC)', '🏆 The Golden Era (exactly 2016) is now worth as much as the other exact badges: 2016 is Godlike instead of Mythic (idea by Gray alt)', 'Your past rolls of 235 and 2016 were upgraded automatically: rarity, lifetime XP, coins and leaderboards'], fr: ['💥 Nouveau badge Exact Drastix : exactement 235 (signalé par CococoC)', '🏆 The Golden Era (exactement 2016) vaut maintenant autant que les autres badges exacts : 2016 passe de Mythic à Godlike (idée de Gray alt)', 'Tes anciens tirages de 235 et 2016 ont été reclassés automatiquement : rareté, XP à vie, pièces et classements'] },
    { id: '2026-10-20a', date: 'Oct 20, 2026', en: ['Fixed: closing a case before the end of the animation now updates your coins right away (the case was always paid, only the display was late; reported by JBearr12)'], fr: ['Corrigé : fermer une caisse avant la fin de l\'animation met ton solde à jour tout de suite (la caisse était toujours payée, seul l\'affichage était en retard ; signalé par JBearr12)'] },
    { id: '2026-10-19d', date: 'Oct 19, 2026', en: ['🪙 Your coin balance is always shown at the top right, next to the language. Click it to open the Shop'], fr: ['🪙 Ton solde de pièces s\'affiche en permanence en haut à droite, à côté de la langue. Clique dessus pour ouvrir la boutique'] },
    { id: '2026-10-19c', date: 'Oct 19, 2026', en: ['🚩 You can now report a message in the duel chat or in your private messages with the small Report button. It goes straight to the creator of the game'], fr: ['🚩 Tu peux maintenant signaler un message dans le chat des duels ou dans tes messages privés avec le petit bouton Signaler. Il arrive directement au créateur du jeu'] },
    { id: '2026-10-19b', date: 'Oct 19, 2026', en: ['🎲 Auto-roll keeps rolling when you switch to another tab (without the animation). The tab title counts your rolls, and you get a summary when you come back (idea by Phong)'], fr: ['🎲 Le tirage auto continue quand tu passes sur un autre onglet (sans l\'animation). Le titre de l\'onglet compte tes tirages, et un résumé s\'affiche à ton retour (idée de Phong)'] },
    { id: '2026-10-19a', date: 'Oct 19, 2026', en: ['🖥️ New code EPITECH>42: 150 coins and the Epitech > 42 title (enter it in Player & settings, after 30 rolls)'], fr: ['🖥️ Nouveau code EPITECH>42 : 150 pièces et le titre Epitech > 42 (à entrer dans Joueur et réglages, après 30 tirages)'] },
    { id: '2026-10-18h', date: 'Oct 18, 2026', en: ['⚙️ Auto-roll can now stop on an XP amount too, from 25K to 10M XP (idea by WpBejs)', '📍 Every leaderboard tab shows your spot at the top, Trash included (idea by WpBejs)', '🗿 New badges: Forty-One (contains 41) and 🃏 Super 21 (contains 2121) (ideas by WpBejs)', 'Fixed: the wallpaper previews in the Shop were a thin line (reported by Me Cojoni)'], fr: ['⚙️ Le tirage auto peut aussi s\'arrêter sur un montant d\'XP, de 25K à 10M XP (idée de WpBejs)', '📍 Chaque onglet du classement montre ta place en haut, Poubelle comprise (idée de WpBejs)', '🗿 Nouveaux badges : Forty-One (contient 41) et 🃏 Super 21 (contient 2121) (idées de WpBejs)', 'Corrigé : les aperçus des fonds dans la boutique étaient un simple trait (signalé par Me Cojoni)'] },
    { id: '2026-10-18g', date: 'Oct 18, 2026', en: ['🔥 Weekend Rush: every Saturday and Sunday (UTC), coins from rolls and daily quests are doubled (casino not included)'], fr: ['🔥 Weekend Rush : chaque samedi et dimanche (UTC), les pièces des tirages et des quêtes du jour sont doublées (hors casino)'] },
    { id: '2026-10-18e', date: 'Oct 18, 2026', en: ['🏆 Leaderboard: Today, This week, This month and All-time are now inside one Best roll tab, like the Trash one, so all tabs fit on one row'], fr: ['🏆 Classement : Aujourd\'hui, Cette semaine, Ce mois-ci et Tout le temps sont maintenant dans un seul onglet Meilleur tirage, comme la Poubelle, et tous les onglets tiennent sur une ligne'] },
    { id: '2026-10-18d', date: 'Oct 18, 2026', en: ['🗑️ The Trash leaderboard now has Today, This week, This month and All-time (idea by Angelicide9)', '👑 New title Trash King: the worst roll of the month wins it when the month ends', '🗑️ New titles Garbage Collector and ☣️ Land Waster for rolling a Garbage or a Land waste (idea by Angelicide9)', '🔁 New achievements Déjà Vu (5 duplicates) and 📀 Broken Record (25) (idea by Lolha39)', 'History: sort by smallest or biggest number (idea by Lolha39)', 'Fixed: the Singularity ring, aura and orbiting dots now shrink with shorter numbers and stay above the rarity line (reported by A Dude)'], fr: ['🗑️ Le classement Poubelle a maintenant Aujourd\'hui, Cette semaine, Ce mois-ci et Tout le temps (idée d\'Angelicide9)', '👑 Nouveau titre Trash King : le pire tirage du mois le gagne à la fin du mois', '🗑️ Nouveaux titres Éboueur et ☣️ Désastre total pour avoir tiré un Garbage ou un Land waste (idée d\'Angelicide9)', '🔁 Nouveaux succès Déjà vu (5 doublons) et 📀 Disque rayé (25) (idée de Lolha39)', 'Historique : tri par plus petit ou plus grand nombre (idée de Lolha39)', 'Corrigé : l\'anneau, l\'aura et les points de Singularity rétrécissent avec les nombres plus courts et restent au-dessus de la ligne de rareté (signalé par A Dude)'] },
    { id: '2026-10-18c', date: 'Oct 18, 2026', en: ['☄️ New skin Meteor: meteors crash onto every digit over a city at night, the last one hits hardest (idea by costoroll)', '🔁 "Duplicate!" shows under the XP when you roll a number you already had (idea by MereTera)', '🃏 New badges: Twenty-One and Exact 21 (idea by kaz), Player 456 and Exact 456 (idea by R77), Halving 8421 and Exact Halving 168421 (idea by finnnnn)', '🐛 New titles Bug Hunter and 💡 Contributor: send a bug that gets fixed or an idea that gets added', 'Fixed: the Singularity ring stays centered on shorter numbers and no longer hits the rarity line; skin animations keep looping slowly instead of stopping; no big effect on Garbage rolls (reported by A Dude)', 'Fixed: Vaporwave digits are no longer cut or overlapping (reported by A Dude)', 'Fixed: the profile of a friend shows "Friends" instead of "Add friend" (reported by kaz)', 'Auto-roll now leaves each result on screen longer so you can see its badges and XP (reported by finnnnn)'], fr: ['☄️ Nouveau skin Meteor : des météorites s\'écrasent sur chaque chiffre au-dessus d\'une ville la nuit, la dernière frappe le plus fort (idée de costoroll)', '🔁 « Doublon ! » s\'affiche sous l\'XP quand tu tires un nombre que tu as déjà eu (idée de MereTera)', '🃏 Nouveaux badges : Twenty-One et Exact 21 (idée de kaz), Player 456 et Exact 456 (idée de R77), Halving 8421 et Exact Halving 168421 (idée de finnnnn)', '🐛 Nouveaux titres Bug Hunter et 💡 Contributor : envoie un bug qui est corrigé ou une idée qui est ajoutée', 'Corrigé : l\'anneau de Singularity reste centré sur les nombres plus courts et ne touche plus la ligne de rareté ; les animations des skins continuent doucement au lieu de s\'arrêter ; plus de grand effet sur les tirages Garbage (signalé par A Dude)', 'Corrigé : les chiffres de Vaporwave ne sont plus coupés ni collés (signalé par A Dude)', 'Corrigé : le profil d\'un ami affiche « Amis » au lieu de « Ajouter en ami » (signalé par kaz)', 'Le tirage auto laisse chaque résultat plus longtemps à l\'écran pour voir ses badges et son XP (signalé par finnnnn)'] },
    { id: '2026-10-18b', date: 'Oct 18, 2026', en: ['🎯 Event leaderboard: a new Event tab in the Leaderboard shows everyone\'s progress on this week\'s event', 'The event card now explains how it works, with an example, and links to the event leaderboard'], fr: ['🎯 Classement de l\'événement : un nouvel onglet Événement dans le Classement montre la progression de chacun sur l\'événement de la semaine', 'La carte de l\'événement explique maintenant comment ça marche, avec un exemple, et mène à son classement'] },
    { id: '2026-10-18a', date: 'Oct 18, 2026', en: ['🎯 Weekly events! Every week has a theme (Prime Time, Happy Week, Meme Week…): hit the goal before Monday for 500 coins, and climb the event podium. Find it at the top of your daily quests', '🎯 New achievement Event Hunter: complete 3 weekly events', '🛡️ The Discord now has automatic moderation against insults, spam and scam links'], fr: ['🎯 Événements de la semaine ! Chaque semaine a un thème (Prime Time, Happy Week, Meme Week…) : atteins l\'objectif avant lundi pour 500 pièces, et grimpe sur le podium de l\'événement. C\'est en haut de tes quêtes du jour', '🎯 Nouveau succès Event Hunter : termine 3 événements de la semaine', '🛡️ Le Discord a maintenant une modération automatique contre les insultes, le spam et les liens d\'arnaque'] },
    { id: '2026-10-17e', date: 'Oct 17, 2026', en: ['👤 New profile page: a header card with your best roll shown in your skin and your key numbers, then tabs (Overview, Rolls, Badges, Achievements, Duels, Inventory) instead of one long page'], fr: ['👤 Nouvelle page de profil : une carte d\'en-tête avec ton meilleur tirage dans ton skin et tes chiffres clés, puis des onglets (Aperçu, Tirages, Badges, Succès, Duels, Inventaire) au lieu d\'une longue page'] },
    { id: '2026-10-17d', date: 'Oct 17, 2026', en: ['🔗 Link your Discord in Profile & Friends: you get your rarity role (Mythic to Infinite), Supporter and Idea Manager on the RNG∞ server, and it follows your new records', '🏆 The Discord now announces every Celestial and better roll live, open duels, game updates, and the rolls of the day at midnight UTC. Pick what pings you when you join'], fr: ['🔗 Lie ton Discord dans Profil & amis : tu reçois ton rôle de rareté (de Mythic à Infinite), Supporter et Idea Manager sur le serveur RNG∞, et il suit tes nouveaux records', '🏆 Le Discord annonce maintenant en direct chaque tirage Celestial ou mieux, les duels ouverts, les mises à jour, et les tirages du jour à minuit UTC. Choisis ce qui te mentionne en arrivant'] },
    { id: '2026-10-17c', date: 'Oct 17, 2026', en: ['💬 RNG∞ has a Discord server! Click the Discord button in the corner to join: share your rolls, find duels, send ideas', 'Faster server: rolls, leaderboards and profiles answer much quicker'], fr: ['💬 RNG∞ a son serveur Discord ! Clique sur le bouton Discord dans le coin pour le rejoindre : partage tes tirages, trouve des duels, envoie tes idées', 'Serveur plus rapide : tirages, classements et profils répondent beaucoup plus vite'] },
    { id: '2026-10-17b', date: 'Oct 17, 2026', en: ['🤠 New skin Western: a revolver shoots the bottles off the fence and each one bursts into a digit (idea by JBearr12)'], fr: ['🤠 Nouveau skin Western : un revolver tire sur les bouteilles de la palissade et chacune éclate en un chiffre (idée de JBearr12)'] },
    { id: '2026-10-17a', date: 'Oct 17, 2026', en: ['Fixed: in Crash, a Cash out that reached the server late because of the network is now paid at the moment you clicked, if it was before the crash (reported by Colt2)', 'Fixed: the XP checker no longer says "null" for common numbers (reported by A Dude)', 'Fixed: auto-roll starts again by itself when you come back to the roll page (reported by MereTera)', 'Fixed: the Sunset clouds and the Abyss light rays (reported by A Dude)', '🗑️ Your 10 worst rolls on your profile (idea by Angelicide9)', '🎒 Inventory on every profile: the skins and wallpapers a player owns (idea by kaz)', '💻 New Hacker wallpaper: green code raining down (idea by JAKE)', '😊 New badges: Happy, Happy Prime (idea by A Dude), 369 and Exact 369 (idea by GamblrGod)', '😇 Heavenly now has a beam of light from above and floating specks of light (idea by casmictechthing)'], fr: ['Corrigé : au Crash, un « Encaisser » arrivé en retard au serveur à cause du réseau est payé au moment du clic, s\'il était avant l\'explosion (signalé par Colt2)', 'Corrigé : le vérificateur d\'XP n\'affiche plus « null » pour les nombres courants (signalé par A Dude)', 'Corrigé : le tirage auto repart tout seul quand on revient sur la page des tirages (signalé par MereTera)', 'Corrigé : les nuages de Sunset et les rayons d\'Abyss (signalé par A Dude)', '🗑️ Tes 10 pires tirages sur ton profil (idée d\'Angelicide9)', '🎒 Inventaire sur chaque profil : les skins et fonds d\'un joueur (idée de kaz)', '💻 Nouveau fond Hacker : du code vert qui tombe (idée de JAKE)', '😊 Nouveaux badges : Happy, Happy Prime (idée de A Dude), 369 et Exact 369 (idée de GamblrGod)', '😇 Heavenly a maintenant un rayon de lumière venu d\'en haut et des poussières de lumière qui flottent (idée de casmictechthing)'] },
    { id: '2026-10-16t', date: 'Oct 16, 2026', en: ['🎃 Two Halloween wallpapers in the shop\'s Limited tab until October 31: Moonlit Graveyard and Pumpkin Patch (idea by Deadshot)', 'Fixed: players who rolled a Godlike number before the new rarity now have it counted, and get the Godlike achievement (reported by MAYO)'], fr: ['🎃 Deux fonds d\'Halloween dans l\'onglet Limités de la boutique jusqu\'au 31 octobre : Cimetière au clair de lune et Champ de citrouilles (idée de Deadshot)', 'Corrigé : les joueurs qui avaient tiré un nombre Godlike avant la nouvelle rareté l\'ont maintenant dans leurs stats, avec le succès Godlike (signalé par MAYO)'] },
    { id: '2026-10-16s', date: 'Oct 16, 2026', en: ['💠 Badges now go up to Celestial: the 45 badges that only one number in a million can earn (idea by Meretera)'], fr: ['💠 Les badges montent maintenant jusqu\'à Celestial : les 45 badges qu\'un seul nombre sur un million peut obtenir (idée de Meretera)'] },
    { id: '2026-10-16r', date: 'Oct 16, 2026', en: ['⚜️ New rarity Godlike, between Divine and Infinite: the 40 best numbers under the Infinite ones (top 0.005%), worth 2,500 coins (idea by MAYO)', '🍬 New Halloween skin Trick or Treat: the doors open on number-shaped candy, and leading zeros are empty houses (idea by Deadshot)'], fr: ['⚜️ Nouvelle rareté Godlike, entre Divine et Infinite : les 40 meilleurs nombres sous les Infinite (top 0,005 %), 2 500 pièces (idée de MAYO)', '🍬 Nouveau skin d\'Halloween Trick or Treat : les portes s\'ouvrent sur des bonbons en forme de chiffres, et les zéros de tête sont des maisons vides (idée de Deadshot)'] },
    { id: '2026-10-16q', date: 'Oct 16, 2026', en: ['🗑️ New Trash leaderboard: the worst roll of every player, of all time', '🌠 New Galaxy wallpaper: a purple nebula with stars rushing past', '🩸 New Bloodlust skin: glossy dark red drops that drip and splash'], fr: ['🗑️ Nouveau classement Poubelle : le pire tirage de chaque joueur, de tous les temps', '🌠 Nouveau fond Galaxie : une nébuleuse violette et des étoiles qui filent', '🩸 Nouveau skin Bloodlust : des gouttes rouge sombre qui coulent et éclaboussent'] },
    { id: '2026-10-16p', date: 'Oct 16, 2026', en: ['😇 New skin Heavenly: white marble and gold, a halo lands on every digit (idea by Gunnar)', '🍅 Ketchup and 🌭 Mustard skins, the cousins of Mayo (idea by Gunnar)', '🖼️ Preview any wallpaper full screen before buying it'], fr: ['😇 Nouveau skin Heavenly : marbre blanc et or, une auréole se pose sur chaque chiffre (idée de Gunnar)', '🍅 Skins Ketchup et 🌭 Moutarde, les cousins du Mayo (idée de Gunnar)', '🖼️ Aperçu en plein écran de chaque fond avant de l\'acheter'] },
    { id: '2026-10-16o', date: 'Oct 16, 2026', en: ['🖼️ New in the Shop: 6 animated wallpapers (Night forest, Starry sky, Abyss, Sakura, Sunset, Synthwave), thanks to MAYO for the idea'], fr: ['🖼️ Nouveau dans la Boutique : 6 fonds d\'écran animés (Forêt de nuit, Ciel étoilé, Abysses, Sakura, Coucher de soleil, Synthwave), merci à MAYO pour l\'idée'] },
    { id: '2026-10-16n', date: 'Oct 16, 2026', en: ['🔑 The Code Hunter title is now in the Badges tab: find the 3 secret codes hidden on the site to unlock it'], fr: ['🔑 Le titre Code Hunter est maintenant dans l\'onglet Badges : trouve les 3 codes secrets cachés sur le site pour le débloquer'] },
    { id: '2026-10-16m', date: 'Oct 16, 2026', en: ['⭐ Level rewards rebalanced: 10 coins × the level (they gave too much). Players who already had levels can now claim a one-time catch-up for those earlier levels: their case keys (up to 4 Starter and 1 Premium) and up to 1,000 coins. Open the level rewards road to claim it'], fr: ['⭐ Récompenses de niveau rééquilibrées : 10 pièces × le niveau (elles donnaient trop). Les joueurs qui avaient déjà des niveaux peuvent réclamer une fois un rattrapage pour ces niveaux : leurs clés de caisse (jusqu\'à 4 Starter et 1 Premium) et jusqu\'à 1 000 pièces. Ouvre la route des récompenses de niveau pour le réclamer'] },
    { id: '2026-10-16l', date: 'Oct 16, 2026', en: ['⭐ Level rewards are easier to find: click the Level tile in Profile & Friends (or your level at the top of the daily quests) to open the rewards road, and claim right from there'], fr: ['⭐ Les récompenses de niveau sont plus faciles à trouver : clique sur la tuile Niveau dans Profil & amis (ou sur ton niveau en haut des quêtes du jour) pour ouvrir la route des récompenses, et réclame directement depuis là'] },
    { id: '2026-10-16k', date: 'Oct 16, 2026', en: ['The Friends tab is now Profile & Friends: your profile summary (level, lifetime XP, best roll, rank) is at the top, with a button to open your full profile'], fr: ['L\'onglet Amis devient Profil & amis : le résumé de ton profil (niveau, XP à vie, meilleur tirage, rang) est en haut, avec un bouton pour ouvrir ton profil complet'] },
    { id: '2026-10-16j', date: 'Oct 16, 2026', en: ['🛣️ Level rewards road: click your level at the top of the daily quests to see every upcoming level and its reward'], fr: ['🛣️ Route des récompenses de niveau : clique sur ton niveau en haut des quêtes du jour pour voir tous les niveaux à venir et leurs récompenses'] },
    { id: '2026-10-16i', date: 'Oct 16, 2026', en: ['⭐ Levels! Your level goes up with your lifetime XP and is shown on your profile. Every new level gives coins, every 5 levels a free Starter Case key and every 25 levels a Premium Case key. Claim them at the top of your daily quests (thanks PRISMA123!)', '💎 New Elite Case in the shop: only skins worth 1,500 to 5,000 coins'], fr: ['⭐ Les niveaux ! Ton niveau monte avec ton XP à vie et s\'affiche sur ton profil. Chaque nouveau niveau donne des pièces, tous les 5 niveaux une clé de Caisse Starter gratuite et tous les 25 une clé de Caisse Premium. Réclame-les en haut de tes quêtes du jour (merci PRISMA123 !)', '💎 Nouvelle Caisse Élite dans la boutique : seulement des skins de 1 500 à 5 000 pièces'] },
    { id: '2026-10-16h', date: 'Oct 16, 2026', en: ['🌙 New Mythic badges: Perigee (363104), Apogee (405696) and Moon Distance (384400), the Earth to Moon distances in km (thanks A Dude!), and 🛡️ True Spartan (711117, thanks casmictechthing!)', '💎 New lifetime XP titles: Centimillionaire (100 million XP) and 🏦 Billionaire (1 billion XP)', '🔑 3 secret codes are hidden on the site. Each gives 150 coins, and finding all 3 unlocks a hidden title. Good luck!', 'The help page now shows the XP range of each rarity', 'Plinko: holding the button no longer floods the casino live feed, your balls are grouped in one line'], fr: ['🌙 Nouveaux badges Mythiques : Perigee (363104), Apogee (405696) et Moon Distance (384400), les distances Terre-Lune en km (merci A Dude !), et 🛡️ True Spartan (711117, merci casmictechthing !)', '💎 Nouveaux titres d\'XP à vie : Centimillionaire (100 millions d\'XP) et 🏦 Billionaire (1 milliard d\'XP)', '🔑 3 codes secrets sont cachés sur le site. Chacun donne 150 pièces, et trouver les 3 débloque un titre caché. Bonne chasse !', 'La page d\'aide montre maintenant la plage d\'XP de chaque rareté', 'Plinko : garder le bouton enfoncé n\'inonde plus le fil du casino, tes billes sont regroupées en une ligne'] },
    { id: '2026-10-16g', date: 'Oct 16, 2026', en: ['Fixed: best rolls on the leaderboard now follow badge changes too (a roll that gained a new badge shows its new XP)', 'Fixed: the casino coin balance now updates by itself when you earn coins in another tab', 'Fixed: auto-roll no longer turns itself off after a connection problem, it tries again every 5 seconds'], fr: ['Corrigé : les meilleurs tirages du classement suivent aussi les changements de badges (un tirage qui a gagné un nouveau badge affiche son nouvel XP)', 'Corrigé : le solde de pièces du casino se met à jour tout seul quand tu gagnes des pièces dans un autre onglet', 'Corrigé : le tirage auto ne s\'éteint plus après un problème de connexion, il réessaie toutes les 5 secondes'] },
    { id: '2026-10-16f', date: 'Oct 16, 2026', en: ['🪙 Coin flip is harder: ×1.9 per win (was ×1.96) and up to 7 wins in a row (×89)'], fr: ['🪙 Le pile ou face est plus dur : ×1,9 par lancer gagné (au lieu de ×1,96) et 7 de suite au plus (×89)'] },
    { id: '2026-10-16e', date: 'Oct 16, 2026', en: ['🗑️ Two new rarities at the very bottom, below Trash: Garbage (the 471 worst numbers, about 1 roll in 2,100, +50 coins) and ☣️ Land waste (the 73 worst numbers of all, 1 roll in 13,700, +300 coins). Bad luck has never been this rare'], fr: ['🗑️ Deux nouvelles raretés tout en bas, sous Trash : Garbage (les 471 pires nombres, environ 1 tirage sur 2 100, +50 pièces) et ☣️ Land waste (les 73 pires nombres, 1 tirage sur 13 700, +300 pièces). La malchance n\'a jamais été aussi rare'] },
    { id: '2026-10-16d', date: 'Oct 16, 2026', en: ['☁️ New skin: Sky (1,600 coins). Cloud digits that condense out of the mist, clouds drifting around your card, and if you roll Mythic or better the whole sky takes its color (thanks Deadshot!)', '🃏 New skin: Deck (1,400 coins). Every digit is a playing card dealt from the deck and flipped onto the felt, and big rolls end in a Solitaire card cascade (thanks GamblrGod!)'], fr: ['☁️ Nouveau skin : Sky (1 600 pièces). Des chiffres en nuage qui se forment dans la brume, des nuages autour de ta carte, et si tu tires Mythique ou mieux tout le ciel prend sa couleur (merci Deadshot !)', '🃏 Nouveau skin : Deck (1 400 pièces). Chaque chiffre est une carte distribuée du paquet et retournée sur le tapis, et les gros tirages finissent en cascade de cartes comme au Solitaire (merci GamblrGod !)'] },
    { id: '2026-10-16c', date: 'Oct 16, 2026', en: ['🪙 New casino game: Coin flip, double or nothing. Pick heads or tails: win ×1.96, then cash out or flip again to double it, up to 8 wins in a row (×217)'], fr: ['🪙 Nouveau jeu au casino : Pile ou face, quitte ou double. Choisis face ou pile : gagné ×1,96, puis encaisse ou relance pour doubler, jusqu\'à 8 fois de suite (×217)'] },
    { id: '2026-10-16b', date: 'Oct 16, 2026', en: ['📋 5 daily quests instead of 3: new XP and casino quests', '🏅 Quest streak: finish all your quests in a day to grow it. The bonus grows every day (from 50 to 300 coins), plus 500 on day 7 and 2,000 on day 30. Your best quest streak is on your profile'], fr: ['📋 5 quêtes du jour au lieu de 3 : nouvelles quêtes d\'XP et de casino', '🏅 Série de quêtes : finis toutes tes quêtes dans la journée pour la faire monter. Le bonus grossit chaque jour (de 50 à 300 pièces), plus 500 au 7e jour et 2 000 au 30e. Ton record est sur ton profil'] },
    { id: '2026-10-16a', date: 'Oct 16, 2026', en: ['🔎 XP checker on the Badges page: type any number to see its XP and badges (shown as a simulation, it is not a roll)', 'New badges: 🪖 Spartans (contains 117) and Exact Spartan (exactly 117), and Fibonacci slices like the Pi ones: contains 112, 1123, 11235, and Exact Fibonacci (112358). Only the best badge of each family counts, like Pi', 'Crash: an instant crash at 1.00× now says so (it happens about 2 times in 100)'], fr: ['🔎 Vérificateur d\'XP dans la page Badges : tape un nombre pour voir son XP et ses badges (affiché comme une simulation, ce n\'est pas un tirage)', 'Nouveaux badges : 🪖 Spartans (contient 117) et Exact Spartan (exactement 117), et des tranches de Fibonacci comme pour Pi : contient 112, 1123, 11235, et Exact Fibonacci (112358). Seul le meilleur badge de chaque famille compte, comme pour Pi', 'Crash : une explosion immédiate à 1.00× l\'explique maintenant (ça arrive environ 2 fois sur 100)'] },
    { id: '2026-10-15g', date: 'Oct 15, 2026', en: ['🎣 New exclusive skin: Fisherman, a collab with Canne & Dauphins by L\'taleshy & cocobat. Their fisherman reels in your digits one by one, and dolphins jump over your card. To get it, sign in with the same Google account on RNG∞ and on Canne & Dauphins (you also get an RNG∞ skin in their game!). It is in the Shop, Skins tab'], fr: ['🎣 Nouveau skin exclusif : Pêcheur, en collab avec Canne & Dauphins de L\'taleshy et cocobat. Leur pêcheur remonte tes chiffres un par un, et des dauphins sautent par-dessus ta carte. Pour l\'avoir, connecte-toi avec le même compte Google sur RNG∞ et sur Canne & Dauphins (tu gagnes aussi un skin RNG∞ dans leur jeu !). Il est dans la boutique, onglet Skins'] },
    { id: '2026-10-15f', date: 'Oct 15, 2026', en: ['🎣 Fishing now has 8-bit sounds: the cast, the splash, a beep at each round multiplier, the reel, a little fanfare for your catch (longer for pink and red dolphins), the shark\'s bite and the line snapping', 'Bug fixes from your reports, thank you! The Lifetime XP leaderboard now matches the XP on your page again (it is recalculated whenever badges change). Haunted: the leading zero no longer shows as a little grey block, and the windows are back on the houses. Galaxy and the other skins: no more streaks left on the side of the screen. Blackjack: the Match bet explanation now says it compares your card with the dealer\'s face-up card, by exact rank'], fr: ['🎣 La pêche a maintenant des sons 8-bit : le lancer, le plouf, un bip à chaque multiplicateur rond, le moulinet, une petite fanfare pour ta prise (plus longue pour les dauphins roses et rouges), la morsure du requin et le fil qui casse', 'Bugs corrigés grâce à vos signalements, merci ! Le classement Lifetime XP correspond de nouveau à l\'XP de ta page (il est recalculé quand les badges changent). Haunted : le zéro de tête n\'apparaît plus en petit bloc gris, et les fenêtres sont revenues sur les maisons. Galaxy et les autres skins : plus de traînées sur le bord de l\'écran. Blackjack : l\'explication du pari Match précise qu\'il compare ta carte à la carte visible du croupier, au rang exact'] },
    { id: '2026-10-15e', date: 'Oct 15, 2026', en: ['🎣 Fishing: smoother animation. The line, the camera, the dolphins and the shark now glide instead of moving pixel by pixel, with the same crisp pixel art'], fr: ['🎣 Pêche : animation plus fluide. La ligne, la caméra, les dauphins et le requin glissent maintenant au lieu d\'avancer pixel par pixel, avec le même pixel art bien net'] },
    { id: '2026-10-15d', date: 'Oct 15, 2026', en: ['🎣 Collab with Canne & Dauphins by L\'taleshy & cocobat: Crash now has a Fishing mode in their pixel art. The fisherman casts his line, it sinks as the multiplier climbs, cash out to reel in a dolphin (blue, pink above 2×, red above 10×), but if you wait too long the demon shark snaps the line. The rocket is still there with the 🚀 button', 'Crash: the delay before the screen shows the explosion now adapts to your connection, so the line or rocket never goes past the crash point'], fr: ['🎣 Collab avec Canne & Dauphins de L\'taleshy et cocobat : le Crash a maintenant un mode Pêche dans leur pixel art. Le pêcheur lance sa ligne, elle descend pendant que le multiplicateur monte, encaisse pour remonter un dauphin (bleu, rose au-dessus de 2×, rouge au-dessus de 10×), mais si tu attends trop le requin démon casse le fil. La fusée est toujours là avec le bouton 🚀', 'Crash : le retard avant l\'explosion à l\'écran s\'adapte maintenant à ta connexion, la ligne ou la fusée ne dépasse plus le point de crash'] },
    { id: '2026-10-15c', date: 'Oct 15, 2026', en: ['4 new badges: 💼 9 to 5 (contains 925, Rare) and 👩‍💼 Exact Job (exactly 925, Mythic), for the Dolly Parton song', '🎩 Exact Munchausen (exactly 3435: 3³ + 4⁴ + 3³ + 5⁵ = 3435, Mythic)', '📐 Exact Pythag (exactly 91625: 9 + 16 = 25, Mythic)'], fr: ['4 nouveaux badges : 💼 9 to 5 (contient 925, Rare) et 👩‍💼 Exact Job (exactement 925, Mythique), pour la chanson de Dolly Parton', '🎩 Exact Munchausen (exactement 3435 : 3³ + 4⁴ + 3³ + 5⁵ = 3435, Mythique)', '📐 Exact Pythag (exactement 91625 : 9 + 16 = 25, Mythique)'] },
    { id: '2026-10-15b', date: 'Oct 15, 2026', en: ['🎲 Natural now only needs your number to contain 711, and 🎮 RTX 5090 to contain 5090 (thanks casmictechthing!). The exact numbers have their own badges: Exact Natural (000711) and Exact RTX 5090 (005090), with the big XP'], fr: ['🎲 Natural demande maintenant juste que ton nombre contienne 711, et 🎮 RTX 5090 qu\'il contienne 5090 (merci casmictechthing !). Les nombres exacts ont leurs propres badges : Exact Natural (000711) et Exact RTX 5090 (005090), avec le gros XP'] },
    { id: '2026-10-15a', date: 'Oct 15, 2026', en: ['🐞 Report a bug: the 💡 window now has a Report a bug option, and you can add a screenshot (pick a file or paste it)'], fr: ['🐞 Signaler un bug : la fenêtre 💡 a maintenant une option Signaler un bug, et tu peux ajouter une capture d\'écran (choisis un fichier ou colle-la)'] },
    { id: '2026-10-14r', date: 'Oct 14, 2026', en: ['🚀 Crash: the rocket now stops the instant you click Cash out, and you get exactly the multiplier you saw. When it explodes, it no longer flies past the crash point first'], fr: ['🚀 Crash : la fusée s\'arrête maintenant dès que tu cliques sur Encaisser, et tu reçois exactement le multiplicateur que tu as vu. Quand elle explose, elle ne dépasse plus le point de crash avant'] },
    { id: '2026-10-14q', date: 'Oct 14, 2026', en: ['🔥 Plinko High risk: 15 rows, up to 1000× on the edges (max 100 coins per ball). The normal board is still there', '🃏 Blackjack: insurance when the dealer shows an ace (pays 2 to 1), and lucky-hand bonuses: 7-7-7 pays 7×, 21 in 5 cards 1×, 6 cards 3×, 7 cards or more 10×', 'Thanks A Dude for both ideas!'], fr: ['🔥 Plinko Gros risque : 15 rangées, jusqu\'à 1000× sur les bords (100 pièces max par bille). Le plateau normal est toujours là', '🃏 Blackjack : assurance quand le croupier montre un as (payée 2 contre 1), et bonus des mains chanceuses : 7-7-7 paie 7×, 21 en 5 cartes 1×, en 6 cartes 3×, en 7 cartes ou plus 10×', 'Merci A Dude pour les deux idées !'] },
    { id: '2026-10-14p', date: 'Oct 14, 2026', en: ['Duels: on a computer the chat is now a sidebar on the right, always in view, and player names are no longer cut in the duel scoreboard (tested with 10 players)'], fr: ['Duels : sur ordinateur, le chat est maintenant une barre à droite, toujours visible, et les noms ne sont plus coupés dans le classement du duel (testé à 10 joueurs)'] },
    { id: '2026-10-14o', date: 'Oct 14, 2026', en: ["🎃 Halloween event in the shop's Limited tab: two new skins, Jack-o'-Lantern (digits carved in a pumpkin, bats fly out) and Witch's Brew (a bubbling green potion). On sale until October 31 only"], fr: ["🎃 Événement d'Halloween dans l'onglet Limités de la boutique : deux nouveaux skins, Jack-o'-Lantern (chiffres creusés dans une citrouille, des chauves-souris s'envolent) et Witch's Brew (une potion verte qui bouillonne). En vente jusqu'au 31 octobre seulement"] },
    { id: '2026-10-14n', date: 'Oct 14, 2026', en: ['Shop: a new Limited tab for event skins, with the time left', 'Haunted skin: a graveyard around your number, with ghosts rising from the graves'], fr: ['Boutique : un nouvel onglet Limités pour les skins d\'événement, avec le temps qu\'il reste', 'Skin Haunted : un cimetière autour de ton nombre, avec des fantômes qui sortent des tombes'] },
    { id: '2026-10-14m', date: 'Oct 14, 2026', en: ['🎃 Halloween code: SPOOKYMONTH gives 300 coins and the Spooky title. Enter it in Player & settings → Redeem a code (after 30 rolls). Valid until October 31'], fr: ['🎃 Code d\'Halloween : SPOOKYMONTH donne 300 pièces et le titre Spooky. Entre-le dans Joueur et réglages → Utiliser un code (après 30 tirages). Valable jusqu\'au 31 octobre'] },
    { id: '2026-10-14l', date: 'Oct 14, 2026', en: ['New: sign in with your player name and a password (Player & settings). No e-mail needed'], fr: ['Nouveau : connecte-toi avec ton pseudo et un mot de passe (Joueur et réglages). Pas besoin d\'e-mail'] },
    { id: '2026-10-14k', date: 'Oct 14, 2026', en: ['Every title now has its own style, like the Owner one: its own colours, a shine that passes over it and its icon (a moving rainbow for Infinite)'], fr: ['Chaque titre a maintenant son propre style, comme celui du créateur : ses couleurs, un reflet qui passe dessus et son icône (un arc-en-ciel qui défile pour Infinite)'] },
    { id: '2026-10-14j', date: 'Oct 14, 2026', en: ['Crypto is now live: the price, the last candle and your position gains move with every real trade, several times a second'], fr: ['La crypto est maintenant en direct : le prix, la dernière bougie et les gains de tes positions bougent à chaque vrai échange, plusieurs fois par seconde'] },
    { id: '2026-10-14i', date: 'Oct 14, 2026', en: ['HellBorn now has its own animation (embers, sparks on every digit, an eruption and lava drips) and a Preview in the shop', 'Mayo skin reworked: a real mayonnaise jar, glossy piped digits, better squeeze bottles and a big zigzag at the end'], fr: ['HellBorn a maintenant sa propre animation (braises, étincelles sur chaque chiffre, éruption et gouttes de lave) et un aperçu dans la boutique', 'Skin Mayo refait : un vrai pot de mayonnaise, des chiffres de mayo brillants à la poche, de plus beaux flacons et un grand zigzag à la fin'] },
    { id: '2026-10-14h', date: 'Oct 14, 2026', en: ['🎃 Halloween skin: Haunted (666 coins), on sale until November 1 only. A haunted house under the moon, ghostly digits, ghosts flying out at the reveal', 'New badges for numbers that contain a perfect square: Little, Inside, Big and Huge Square (444 to 24,307 XP, set by how rare they are)'], fr: ['🎃 Skin d\'Halloween : Haunted (666 pièces), en vente jusqu\'au 1er novembre seulement. Une maison hantée sous la lune, des chiffres fantômes, des fantômes qui s\'envolent à la révélation', 'Nouveaux badges pour les nombres qui contiennent un carré parfait : Little, Inside, Big et Huge Square (de 444 à 24 307 XP, selon leur rareté)'] },
    { id: '2026-10-14g', date: 'Oct 14, 2026', en: ['New cheap skin: Mayo (250 coins). Squeeze bottles pop up and squirt mayonnaise on every digit'], fr: ['Nouveau skin pas cher : Mayo (250 pièces). Des flacons surgissent et giclent de la mayonnaise sur chaque chiffre'] },
    { id: '2026-10-14f', date: 'Oct 14, 2026', en: ['Crypto: leverage trading. Go long or short with 2×, 3× or 5×, with an optional stop loss and take profit (checked every 15 seconds, even when you are away). You can never lose more than your margin', 'New badge: Important Birthday (061209)'], fr: ['Crypto : trading à effet de levier. Joue la hausse (long) ou la baisse (short) en 2×, 3× ou 5×, avec stop loss et take profit facultatifs (vérifiés toutes les 15 secondes, même quand tu n\'es pas là). Tu ne peux jamais perdre plus que ta mise', 'Nouveau badge : Important Birthday (061209)'] },
    { id: '2026-10-14e', date: 'Oct 14, 2026', en: ['Gamble: the Bitcoin tab becomes Crypto, with Ethereum too, and a real candlestick chart like TradingView: time frames from 5 minutes to 1 day, moving averages 20 and 50, volume, crosshair with open/high/low/close, zoom with the mouse wheel'], fr: ['Gamble : l\'onglet Bitcoin devient Crypto, avec l\'Ethereum en plus, et un vrai graphique en bougies comme TradingView : unités de 5 minutes à 1 jour, moyennes mobiles 20 et 50, volume, réticule avec ouverture/haut/bas/clôture, zoom à la molette'] },
    { id: '2026-10-14d', date: 'Oct 14, 2026', en: ['Gamble: a new Bitcoin tab. Buy and sell Bitcoin with your coins at the real live price (1 coin = 1 $), with a 24-hour chart. Game coins only, no real money'], fr: ['Gamble : un nouvel onglet Bitcoin. Achète et revends du Bitcoin avec tes pièces au vrai prix en direct (1 pièce = 1 $), avec la courbe sur 24 h. Pièces du jeu seulement, pas de vrai argent'] },
    { id: '2026-10-14c', date: 'Oct 14, 2026', en: ['Fixed: the Pixel skin no longer covers the rarity and percentage under your number', 'Blackjack: two optional Match side bets. Your 1st or 2nd card has the same value as the dealer\'s face-up card: 8×, same suit too: 24×, both your cards match: ×1.5'], fr: ['Corrigé : le skin Pixel ne cache plus la rareté et le pourcentage sous ton nombre', 'Blackjack : deux mises annexes Match facultatives. Ta 1re ou 2e carte a la même valeur que la carte visible du croupier : 8×, même couleur aussi : 24×, tes deux cartes correspondent : ×1,5'] },
    { id: '2026-10-14b', date: 'Oct 14, 2026', en: ['Friends: send messages to your friends with the 💬 button. Only you two can read them, they are filtered like the duel chat, deleted after 7 days, and you can block someone', 'New skin: HellBorn, black volcanic stone with lava in the cracks'], fr: ['Amis : envoie des messages à tes amis avec le bouton 💬. Vous seuls pouvez les lire, ils sont filtrés comme le chat des duels, supprimés au bout de 7 jours, et tu peux bloquer quelqu\'un', 'Nouveau skin : HellBorn, pierre volcanique noire avec de la lave dans les fissures'] },
    { id: '2026-10-14a', date: 'Oct 14, 2026', en: ['Auto-roll: choose the rarity it stops on, from Rare to Infinite', 'New badge: Natural (exactly 711, 71,100 XP)'], fr: ['Tirage auto : choisis la rareté à laquelle il s\'arrête, de Rare à Infinite', 'Nouveau badge : Natural (exactement 711, 71 100 XP)'] },
    { id: '2026-10-13l', date: 'Oct 13, 2026', en: ['Cases: a skin you already own now refunds more when it is rarer — 50% of the case price for a Common, 55% Uncommon, 65% Rare, 75% Epic, 90% Legendary'], fr: ['Caisses : un skin que tu as déjà rembourse maintenant plus quand il est rare — 50 % du prix de la caisse pour un Common, 55 % Uncommon, 65 % Rare, 75 % Epic, 90 % Legendary'] },
    { id: '2026-10-13k', date: 'Oct 13, 2026', en: ['New title to equip: 📅 2026 — unlocked when you earn the Current Year badge (a number containing 2026). Equip it from your profile'], fr: ['Nouveau titre à équiper : 📅 2026 — débloqué quand tu obtiens le badge Current Year (un nombre contenant 2026). Équipe-le depuis ton profil'] },
    { id: '2026-10-13j', date: 'Oct 13, 2026', en: ['New badge: Current Year 📅 — any number containing 2026 (12026, 520269, 202600…) earns 20,260 XP'], fr: ['Nouveau badge : Current Year 📅 — tout nombre contenant 2026 (12026, 520269, 202600…) rapporte 20 260 XP'] },
    { id: '2026-10-13i', date: 'Oct 13, 2026', en: ['Gift codes: enter a code in Player & settings to get its prize (each code works once, after 30 rolls). Try SACHA for 200 coins'], fr: ['Codes cadeaux : entre un code dans Joueur et réglages pour gagner son prix (chaque code marche une fois, après 30 tirages). Essaie SACHA pour 200 pièces'] },
    { id: '2026-10-13h', date: 'Oct 13, 2026', en: ['New skin: Bakery 🥐 — digits of golden crust with chocolate chips, and steam rising at the end (1,000 coins)'], fr: ['Nouveau skin : Bakery 🥐 — des chiffres en croûte dorée aux pépites de chocolat, et de la vapeur qui monte à la fin (1 000 pièces)'] },
    { id: '2026-10-13g', date: 'Oct 13, 2026', en: ['New legendary skin: Infinity ♾️ — a living nebula and a comet tracing an infinity loop around your number. Only from the Premium Case, 1 chance in 200'], fr: ['Nouveau skin légendaire : Infinity ♾️ — une nébuleuse vivante et une comète qui trace un infini autour de ton nombre. Seulement dans la caisse Premium, 1 chance sur 200'] },
    { id: '2026-10-13f', date: 'Oct 13, 2026', en: ['Performance mode (Player & settings): fewer animations and effects for tablets and devices that lag'], fr: ['Mode performance (Joueur et réglages) : moins d\'animations et d\'effets pour les tablettes et appareils qui rament'] },
    { id: '2026-10-13e', date: 'Oct 13, 2026', en: ['Top 1 👑, Top 5 🥈 and Top 10 🥉 badges are now earned at the end of the month: the ten best players of the monthly leaderboard keep their badge forever, with the month and year ("Top 1 · Oct 2026"). Climb before the month ends!'], fr: ['Les badges Top 1 👑, Top 5 🥈 et Top 10 🥉 se gagnent maintenant à la fin du mois : les dix meilleurs du classement du mois gardent leur badge pour toujours, avec le mois et l\'année (« Top 1 · Oct. 2026 »). Grimpe avant la fin du mois !'] },
    { id: '2026-10-13d', date: 'Oct 13, 2026', en: ['Top 1 👑, Top 5 🥈 and Top 10 🥉 badges: only the ten best players of this month\'s leaderboard wear one, next to their name on the leaderboard, on their profile and in duels. Drop out of the top 10 and it\'s gone'], fr: ['Badges Top 1 👑, Top 5 🥈 et Top 10 🥉 : seuls les dix meilleurs joueurs du classement du mois en portent un, à côté de leur nom dans le classement, sur leur profil et en duel. Sors du top 10 et il disparaît'] },
    { id: '2026-10-13c', date: 'Oct 13, 2026', en: ['Give coins to your friends (suggested by players): a 🎁 button next to each friend sends 10 to 500 coins. Up to 1,000 coins given and 2,000 received per day, unlocked after 30 rolls. Your friend sees it the next time they play'], fr: ['Offre des pièces à tes amis (suggéré par des joueurs) : un bouton 🎁 à côté de chaque ami envoie de 10 à 500 pièces. Jusqu\'à 1 000 pièces données et 2 000 reçues par jour, débloqué après 30 tirages. Ton ami le voit la prochaine fois qu\'il joue'] },
    { id: '2026-10-13b', date: 'Oct 13, 2026', en: ['Auto-roll is no longer only for duels: turn it on under Generate and the game rolls again by itself after each reveal. It stops on a Mythic or better so you never miss it'], fr: ['Le tirage auto n\'est plus réservé aux duels : active-le sous Générer et le jeu relance tout seul après chaque révélation. Il s\'arrête sur un Mythic ou mieux pour que tu ne le rates jamais'] },
    { id: '2026-10-13a', date: 'Oct 13, 2026', en: ['Two new badges suggested by players: RTX 5090 🎮 (exactly 5090, 50,900 XP) and The Golden Era 🏆 (exactly 2016, 216,000 XP)'], fr: ['Deux nouveaux badges suggérés par des joueurs : RTX 5090 🎮 (exactement 5090, 50 900 XP) et The Golden Era 🏆 (exactement 2016, 216 000 XP)'] },
    { id: '2026-10-12b', date: 'Oct 12, 2026', en: ['Ideas 💡: when the creator answers your suggestion, you can now reply in the same conversation (no need to send a new one), and the bulb shows a red dot when there is an answer for you'], fr: ['Idées 💡 : quand le créateur répond à ta suggestion, tu peux maintenant lui répondre dans la même conversation (plus besoin d\'en envoyer une nouvelle), et l\'ampoule affiche un point rouge quand une réponse t\'attend'] },
    { id: '2026-10-12a', date: 'Oct 12, 2026', en: ['Leaderboard: a new This month tab with the best roll of the month (it already counts every roll since the 1st)'], fr: ['Classement : un nouvel onglet Ce mois avec le meilleur tirage du mois (il compte déjà tous les tirages depuis le 1er)'] },
    { id: '2026-10-11j', date: 'Oct 11, 2026', en: ['Fixed: long duels no longer stop after 100 rounds, so an XP race to 10M (or 50 rounds to win) now really goes to the end'], fr: ['Corrigé : les longs duels ne s\'arrêtent plus au bout de 100 manches, une course à 10 M d\'XP (ou 50 manches à gagner) va maintenant vraiment jusqu\'au bout'] },
    { id: '2026-10-11i', date: 'Oct 11, 2026', en: ['Duels: an Auto-roll switch under the round button rolls every round for you, against bots or players, until the duel ends'], fr: ['Duels : un interrupteur « Tirage auto » sous le bouton de la manche lance chaque manche à ta place, contre des bots ou des joueurs, jusqu\'à la fin du duel'] },
    { id: '2026-10-11h', date: 'Oct 11, 2026', en: ['Gamble: a casino leaderboard under the games, with the biggest winners, the biggest losers and the biggest gamblers of all time (and your own rank)'], fr: ['Gamble : un classement du casino sous les jeux, avec les plus gros gagnants, les plus gros perdants et les plus gros joueurs depuis toujours (et ton propre rang)'] },
    { id: '2026-10-11g', date: 'Oct 11, 2026', en: ['Duels: type your own goal, up to 50 rounds to win or any XP target from 5K to 10M (the usual buttons are still there)', 'Supporter skin: an animated heartbeat on every digit'], fr: ['Duels : tape ton propre objectif, jusqu\'à 50 manches à gagner ou n\'importe quel objectif d\'XP de 5 000 à 10 millions (les boutons habituels sont toujours là)', 'Skin Supporter : un battement de cœur animé sur chaque chiffre'] },
    { id: '2026-10-11f', date: 'Oct 11, 2026', en: ['Mines: a win is now capped at 250× the bet, like the slot jackpot (the game cashes out by itself when you reach it)'], fr: ['Mines : un gain est maintenant plafonné à 250 fois la mise, comme le jackpot de la machine à sous (la partie s\'encaisse toute seule quand tu l\'atteins)'] },
    { id: '2026-10-11e', date: 'Oct 11, 2026', en: ['Server fund: a monthly goal to pay for a better server. Contributing is optional and gives nothing in the game except a thank-you: the 💗 Supporter skin and title'], fr: ['Cagnotte du serveur : un objectif mensuel pour payer un meilleur serveur. Contribuer est facultatif et ne donne rien en jeu, à part un remerciement : le skin et le titre 💗 Supporter'] },
    { id: '2026-10-11d', date: 'Oct 11, 2026', en: ['Link your Google account and get 150 coins (once). Already linked? You get them on your next roll'], fr: ['Associe ton compte Google et reçois 150 pièces (une seule fois). Déjà associé ? Tu les reçois à ton prochain tirage'] },
    { id: '2026-10-11c', date: 'Oct 11, 2026', en: ['Shop: the Speed tab is now Upgrades, and shows your progress toward Skip known badges (unlocked at 500 rolls) with its on/off switch'], fr: ['Shop : l\'onglet Vitesse devient Boosts, et montre où tu en es pour « Skip known badges » (débloqué à 500 tirages) avec son interrupteur'] },
    { id: '2026-10-11b', date: 'Oct 11, 2026', en: ['Plinko: bet as little as 1 coin, and drop as many balls as you want at once (click fast or hold the button)'], fr: ['Plinko : mise à partir de 1 pièce, et autant de billes que tu veux en même temps (clique vite ou maintiens le bouton)'] },
    { id: '2026-10-11', date: 'Oct 11, 2026', en: ['Casino: a slot machine 🎰 with three animated reels, a lever to pull and a 250× jackpot on 7 7 7'], fr: ['Casino : une machine à sous 🎰 avec trois rouleaux animés, un levier à tirer et un jackpot à 250× sur 7 7 7'] },
    { id: '2026-10-10g', date: 'Oct 10, 2026', en: ['New badge: Full Stack 🧱 — any number containing 64 (a full stack of blocks) earns 6,400 XP'], fr: ['Nouveau badge : Full Stack 🧱 — tout nombre contenant 64 (une pile complète de blocs) rapporte 6 400 XP'] },
    { id: '2026-10-10f', date: 'Oct 10, 2026', en: ['Crash: the rocket is much smoother, and Cash out no longer answers "One move at a time"'], fr: ['Crash : la fusée est beaucoup plus fluide, et « Cash out » ne répond plus « One move at a time »'] },
    { id: '2026-10-10e', date: 'Oct 10, 2026', en: ['Casino fixes: on phones the roulette wheel no longer covers the Red, Black and Even bets; a Crash cash-out is never refused because of bad timing; a blackjack hand or a Mines grid left open is kept for a week and always comes back after a reload'], fr: ['Corrections du casino : sur téléphone, la roue de la roulette ne recouvre plus les mises Rouge, Noir et Pair ; un encaissement au Crash n\'est plus jamais refusé pour une question de timing ; une main de blackjack ou une grille de Mines laissée ouverte est gardée une semaine et revient toujours après un rechargement'] },
    { id: '2026-10-10d', date: 'Oct 10, 2026', en: ['Casino: a small live strip shows all the coins that went through it (bets taken, winnings paid) and the latest results'], fr: ['Casino : un petit bandeau en direct montre toutes les pièces qui y sont passées (mises prises, gains versés) et les derniers résultats'] },
    { id: '2026-10-10c', date: 'Oct 10, 2026', en: ['Duels: the score is now a compact strip and the roll button always stays on screen, so no more scrolling down to roll'], fr: ['Duels : le score tient maintenant en une bande compacte et le bouton de tirage reste toujours à l\'écran, plus besoin de descendre pour tirer'] },
    { id: '2026-10-10b', date: 'Oct 10, 2026', en: ['Shop reorganised: one tab per category (Skins, Buttons, Emotes, Cases, Speed) and your coins always shown at the top'], fr: ['Shop réorganisé : un onglet par catégorie (Skins, Boutons, Émotes, Caisses, Vitesse) et tes pièces toujours affichées en haut'] },
    { id: '2026-10-10', date: 'Oct 10, 2026', en: ['Roll speed upgrades in the Shop: five levels bought with coins, each one makes the reveal faster and shortens the wait between rolls (down to 4 s)'], fr: ['Vitesse de tirage dans le Shop : cinq niveaux à acheter avec tes pièces, chacun accélère la révélation et raccourcit l\'attente entre deux tirages (jusqu\'à 4 s)'] },
    { id: '2026-10-09', date: 'Oct 9, 2026', en: ['Three new rarities above Mythic: Celestial (about 1 roll in 1,000), Divine (1 in 10,000) and Infinite (1 in 100,000), each with its own reveal, sound and coin reward', 'A new title for each of them. Your old rolls count: past Mythics that qualify are upgraded automatically'], fr: ['Trois nouvelles raretés au-dessus de Mythic : Celestial (environ 1 tirage sur 1 000), Divine (1 sur 10 000) et Infinite (1 sur 100 000), chacune avec sa révélation, son son et sa récompense en pièces', 'Un nouveau titre pour chacune. Tes anciens tirages comptent : les anciens Mythic concernés sont reclassés automatiquement'] },
    { id: '2026-10-08f', date: 'Oct 8, 2026', en: ['Share a roll as an image card: press Share, then copy it straight into Discord or download it'], fr: ['Partage un tirage en image : appuie sur Partager, puis colle la carte directement dans Discord ou télécharge-la'] },
    { id: '2026-10-08e', date: 'Oct 8, 2026', en: ['A notification tells you when you complete a daily quest, with its coin reward'], fr: ['Une notification te prévient quand tu termines une quête du jour, avec sa récompense en pièces'] },
    { id: '2026-10-08d', date: 'Oct 8, 2026', en: ['Layout pass for every screen size: on phones and tablets the four round buttons now sit at the bottom of the page instead of floating over the game, and the menu fits on the smallest phones'], fr: ['Mise en page revue pour toutes les tailles d\'écran : sur téléphone et tablette, les quatre boutons ronds sont rangés en bas de page au lieu de flotter sur le jeu, et le menu tient sur les plus petits téléphones'] },
    { id: '2026-10-08c', date: 'Oct 8, 2026', en: ['Coins leaderboard', 'Your coin balance is shown when you set a duel stake and at the top of the casino', 'New trailer'], fr: ['Classement des pièces', 'Ton solde s\'affiche quand tu choisis une mise en duel et en haut du casino', 'Nouveau trailer'] },
    { id: '2026-10-08b', date: 'Oct 8, 2026', en: ['Casino tables redrawn: a real 3D roulette wheel with its ball, dealt and flipped cards, a bouncing Plinko ball, flipping Mines tiles, a Crash rocket'], fr: ['Tables du casino redessinées : vraie roue de roulette en 3D avec sa bille, cartes distribuées et retournées, bille de Plinko qui rebondit, cases de Mines qui basculent, fusée de Crash'] },
    { id: '2026-10-08', date: 'Oct 8, 2026', en: ['Rewatch any roll: open a roll (yours or another player\'s) and press Rewatch', 'Casino: three new games (Crash, Mines, Plinko) and a new look', 'This update log'], fr: ['Revoir un tirage : ouvre un tirage (le tien ou celui d\'un autre) et appuie sur Rewatch', 'Casino : trois nouveaux jeux (Crash, Mines, Plinko) et un nouveau décor', 'Ce journal des mises à jour'] },
    { id: '2026-10-07b', date: 'Oct 7, 2026', en: ['Skip known badges: a setting unlocked at 500 rolls', 'Gamble section: roulette and blackjack with your coins', 'Vaporwave skin redesigned', 'The XP on the Generate screen now matches the leaderboard'], fr: ['Passer les badges connus : un réglage débloqué à 500 tirages', 'Section Casino : roulette et blackjack avec tes pièces', 'Skin Vaporwave refait', 'L\'XP de l\'écran Générer est maintenant celui du classement'] },
    { id: '2026-10-07a', date: 'Oct 7, 2026', en: ['4 legendary skins with a full animated signature: Sakura, Storm, Dragon, Singularity', 'Preview any skin in the shop before buying', 'Every skin\'s animation now plays in duels', '8 animated emotes to buy', 'Chat in duels', 'Generate button skins'], fr: ['4 skins légendaires avec une signature animée : Sakura, Storm, Dragon, Singularity', 'Aperçu de chaque skin dans la boutique avant d\'acheter', 'L\'animation de chaque skin se joue en duel', '8 émotes animées à acheter', 'Chat dans les duels', 'Skins du bouton Générer'] },
    { id: '2026-10-06', date: 'Oct 6, 2026', en: ['Daily quests and login streak', 'Duels with a coin stake', 'Skin cases', 'Friends', 'French version of the game', 'Suggestion box'], fr: ['Quêtes du jour et série de connexion', 'Duels avec une mise en pièces', 'Caisses de skins', 'Amis', 'Version française du jeu', 'Boîte à idées'] },
  ];
  // Annonces du créateur (idée de jaxoncool43, 2026-10-26) : lues une fois au chargement (api/_announce.js), en tête
  // de « What's new » ; une nouvelle annonce allume aussi le point rouge de 📰. Une annonce « important » jamais vue
  // s'affiche une fois en notification (un clic ouvre la fenêtre).
  let announcements = [];
  const annUnread = () => !!announcements.length && Store.settings.annSeen !== announcements[0].id;
  const newsUnread = () => Store.settings.newsSeen !== UPDATES[0].id || annUnread();
  function paintNewsDot() { const b = $('#news-btn'); if (b) b.classList.toggle('unread', newsUnread()); }
  const annHTML = (a, fresh) => `<div class="news-item ann-item${a.important ? ' ann-important' : ''}"><div class="eyebrow">📣 ${esc(fullDate(a.t))}${fresh ? ' <span class="new-tag">NEW</span>' : ''}</div><h3 class="ann-title" data-no-i18n>${esc(a.title)}</h3><p class="ann-text" data-no-i18n>${esc(a.text)}</p></div>`;
  function openNews() {
    const fr = window.RNGI18n && window.RNGI18n.lang === 'fr';
    const seenAnn = Store.settings.annSeen, seenAt = announcements.findIndex(a => a.id === seenAnn);
    // NEW sur les annonces arrivées depuis la dernière ouverture (toutes si aucune n'a encore été vue).
    const anns = announcements.slice(0, 5).map((a, i) => annHTML(a, seenAt === -1 ? true : i < seenAt)).join('');
    openModal(`<h2>${fr ? 'Nouveautés' : 'What\'s new'}</h2>${anns ? `<div class="news-list ann-list">${anns}</div>` : ''}<div class="news-list" data-no-i18n>${UPDATES.map((u, i) => `
      <div class="news-item"><div class="eyebrow">${u.date}${i === 0 && Store.settings.newsSeen !== UPDATES[0].id ? ' <span class="new-tag">NEW</span>' : ''}</div><ul>${(fr ? u.fr : u.en).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>`);
    Store.setSetting('newsSeen', UPDATES[0].id);
    if (announcements.length) Store.setSetting('annSeen', announcements[0].id);
    paintNewsDot();
  }
  function loadAnnouncements() {
    Online.request('/api/site', { method: 'POST', body: JSON.stringify({ action: 'announcements' }) }).then(r => {
      announcements = (r && Array.isArray(r.list) ? r.list : []).filter(a => a && a.id && a.title);
      paintNewsDot();
      // Seulement la plus récente des importantes, une seule fois par appareil, et si elle a moins de 14 jours.
      const big = announcements.find(a => a.important);
      if (big && Store.settings.annToast !== big.id && Date.now() - big.t < 14 * 86400000) {
        Store.setSetting('annToast', big.id);
        setTimeout(() => toast(`📣 ${big.title}`, 9000, 'ann', openNews), 1500);
      }
    }).catch(() => {});
  }

  // Revoir un tirage (le sien ou celui d'un autre) : la révélation complète rejouée avec mon skin, sans rien tirer ni
  // enregistrer. Les badges se rejouent tous (pas de saut), l'XP à vie ne bouge pas.
  function rewatch(n, caption, owner = '') {
    if (session && !session.finished) { clientEvt('reveal_cut'); session.cancel(); }
    closeModal();
    const back = (session && session.replayBack) || location.hash;
    currentView = 'result';
    session = playReveal({ n, a: analysis(n), previous: [], newIds: null, isFirst: false, lifetimeBefore: lifetimeEP(), index: -1, online: null, replay: { caption, back, owner } });
  }

  function todayCardHTML(entry, rollsToday, runners = []) {
    const a = analysis(entry.n);
    const pills = a.groups.slice(0, 7).map(g => `<span class="badge-pill" data-tier="${g.badge.tier}">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join('');
    const more = a.earnedIds.length - Math.min(7, a.groups.length);
    return `
      <div class="feature-card" id="today-card" data-tier="${a.tier}" data-number="${entry.n}" data-owner="${esc(entry.name)}" data-caption="${esc(`Today's best · ${entry.name}`)}" style="cursor:pointer">
        <div class="eyebrow">Today's best roll</div>
        <span class="num-card md" data-tier="${a.tier}">${a.str}</span>
        <div class="feature-meta">rolled by <a class="player-link" href="${profileHref(entry.name)}">${esc(entry.name)}</a>${entry.me ? ' (you)' : ''} ${titleHTML(entry.title)}</div>
        <div class="pill-row">${pills}${more > 0 ? `<span class="more">+${more} more</span>` : ''}</div>
        <div class="ep-big" style="display:inline-block;font-size:.85rem">${fmt(entry.s)} XP</div>
        ${runners.length ? `<div class="today-podium">${runners.map((r, i) => { const b = analysis(r.n); return `<div class="today-podium-row" data-number="${r.n}" data-owner="${esc(r.name)}" data-caption="${esc(`Today's #${i + 2} · ${r.name}`)}"><span>${['🥈', '🥉'][i]}</span><a class="player-link" href="${profileHref(r.name)}" data-no-i18n>${esc(r.name)}</a>${r.me ? ' <span class="muted">(you)</span>' : ''}<span class="num-card sm" data-tier="${b.tier}">${b.str}</span><span class="mono">${compact(r.s)} XP</span></div>`; }).join('')}</div>` : ''}
        <div class="feature-meta" style="margin-bottom:0">${plural(rollsToday, 'roll')} today</div>
      </div>`;
  }

  // Remplit la carte "Today's best roll" ; si le serveur est injoignable, la carte disparaît sans bruit.
  async function loadTodayCard(slot) {
    try {
      const data = await Online.leaderboard('day');
      if (!slot.isConnected) return;
      slot.innerHTML = data.entries.length
        ? todayCardHTML(data.entries[0], data.rollsToday, data.entries.slice(1, 3)) // podium : le 2e et le 3e en dessous (idée de JAKECisthebest, 2026-10-22)
        : '<div class="feature-card"><div class="eyebrow">Today\'s best roll</div><p class="feature-meta">No rolls yet today — be the first!</p></div>';
    } catch (err) {
      slot.innerHTML = '';
    }
  }

  // Le nombre est tiré par le serveur, ce qui le fait compter au classement. Si le serveur ne répond pas,
  // on tire en local : le tirage reste dans l'historique mais pas au classement.
  // Rien ne se saute : pendant la révélation, Espace est ignoré ; une fois la rareté affichée, il relance.
  let rollPending = false;
  // Tirage auto en solo : relance toute seule à la fin de chaque révélation, tant que l'interrupteur est allumé.
  // Jamais gardé d'une visite à l'autre ; s'éteint en quittant l'écran de tirage, sur un tirage hors ligne, et
  // s'arrête de lui-même sur un Mythic ou mieux pour que le joueur le voie.
  const SoloAuto = { on: false, timer: 0, shownAt: 0 };
  const SOLO_PAUSE = 1800; // ms minimum entre la fin d'une révélation visible et le tirage auto suivant
  // Rareté à laquelle le tirage auto s'arrête (choisie par le joueur, Mythic par défaut).
  const AUTO_STOPS = ['rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite'];
  // Ou un seuil d'XP (idée de WpBejs, 2026-10-18) : s'arrête sur le premier tirage qui rapporte au moins autant.
  const AUTO_XP = [25000, 50000, 100000, 250000, 500000, 1000000, 10000000];
  // Mauvais tirage (idée de CococoC, 2026-10-20) : s'arrête sur Trash ou pire ; « never » ne s'arrête jamais
  // (Angelicide9) ; un seuil d'XP libre « xp:<n> » se tape à la main (WpBejs).
  const AUTO_LOW = ['trash', 'garbage', 'landwaste'];
  const STOP_OK = v => AUTO_STOPS.includes(v) || v === 'never' || AUTO_LOW.map(t => `low:${t}`).includes(v) || /^xp:[1-9]\d{0,9}$/.test(v);
  // Le tirage arrête-t-il l'auto-roll ?
  const autoStops = a => {
    const st = autoStop();
    if (st === 'never') return false;
    if (st.startsWith('xp:')) return a.total >= Number(st.slice(3));
    if (st.startsWith('low:')) return TIER_RANK[a.tier] <= TIER_RANK[st.slice(4)];
    return TIER_RANK[a.tier] >= TIER_RANK[st];
  };
  const stopToast = a => { const st = autoStop(); return st.startsWith('xp:') ? `✨ Auto-roll stopped on ${fmt(a.total)} XP: enjoy it!` : st.startsWith('low:') ? `🗑️ Auto-roll stopped on ${cap(a.tier)}: what a roll!` : `✨ Auto-roll stopped on ${cap(a.tier)}: enjoy it!`; };
  const autoStop = () => (STOP_OK(Store.settings.autoStop) ? Store.settings.autoStop : 'mythic');
  const kfmt = x => (x >= 1e6 ? `${x / 1e6}M` : `${x / 1e3}K`);
  const soloAutoHTML = () => `<span class="solo-auto-box"><label class="room-auto solo-auto" title="Rolls again by itself after each reveal, until the rarity you chose"><input type="checkbox" id="solo-auto"${SoloAuto.on ? ' checked' : ''}><i aria-hidden="true"></i><span>Auto-roll</span></label><label class="solo-stop"><span>stop on</span><select id="solo-stop" aria-label="Rarity that stops auto-roll"><optgroup label="Rarity">${AUTO_STOPS.map(t => `<option value="${t}"${t === autoStop() ? ' selected' : ''} data-no-i18n>${cap(t)}${t === 'infinite' ? '' : '+'}</option>`).join('')}</optgroup><optgroup label="XP">${AUTO_XP.map(x => `<option value="xp:${x}"${`xp:${x}` === autoStop() ? ' selected' : ''} data-no-i18n>${kfmt(x)} XP+</option>`).join('')}${autoStop().startsWith('xp:') && !AUTO_XP.includes(Number(autoStop().slice(3))) ? `<option value="${autoStop()}" selected data-no-i18n>${fmt(Number(autoStop().slice(3)))} XP+</option>` : ''}<option value="xp:custom">Custom XP…</option></optgroup><optgroup label="Bad roll">${AUTO_LOW.map(t => `<option value="low:${t}"${`low:${t}` === autoStop() ? ' selected' : ''}>${cap(t)}${t === 'landwaste' ? '' : ' or worse'}</option>`).join('')}</optgroup><option value="never"${autoStop() === 'never' ? ' selected' : ''}>Never stop</option></select></label></span>`;
  function stopSoloAuto() {
    SoloAuto.on = false;
    BgTimer.clear(SoloAuto.timer);
    const box = $('#solo-auto');
    if (box) box.checked = false;
  }
  function bindSoloAuto() {
    const box = $('#solo-auto');
    if (!box) return;
    // Retour sur l'accueil avec le tirage auto encore allumé (parti sur un autre onglet du jeu en plein tirage) : il
    // repart tout seul au lieu d'attendre un premier clic (signalé par MereTera le 2026-10-17).
    if (SoloAuto.on && currentView === 'home' && !rollPending) scheduleSoloAuto(900);
    const stop = $('#solo-stop');
    if (stop) stop.addEventListener('change', () => {
      if (stop.value === 'xp:custom') {
        const raw = prompt(window.RNGI18n ? window.RNGI18n.t('Stop auto-roll on a roll worth at least how much XP?') : 'Stop auto-roll on a roll worth at least how much XP?', '');
        const v = Math.round(Number(String(raw || '').replace(/[^0-9]/g, '')));
        if (v >= 1 && v <= 9999999999) Store.setSetting('autoStop', `xp:${v}`);
        const box = $('.solo-auto-box'); if (box) { box.outerHTML = soloAutoHTML(); bindSoloAuto(); }
        return;
      }
      if (STOP_OK(stop.value)) Store.setSetting('autoStop', stop.value);
    });
    box.addEventListener('change', () => {
      SoloAuto.on = box.checked;
      BgTimer.clear(SoloAuto.timer);
      if (!SoloAuto.on) return;
      Sound.unlock();
      if (!session || session.finished) startRoll(true);
    });
  }
  // Minuteur d'un Worker : dans un onglet caché, le navigateur ralentit les setTimeout de la page (jusqu'à un par
  // minute dans Chrome), pas ceux d'un Worker. Repli sur setTimeout si les Workers sont bloqués.
  const BgTimer = (() => {
    let w = null, seq = 0; const cbs = new Map();
    try {
      w = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })));
      w.onmessage = e => { const f = cbs.get(e.data); cbs.delete(e.data); if (f) f(); };
    } catch (e) { w = null; }
    return {
      set(fn, ms) { if (!w) return setTimeout(fn, ms); const id = `b${++seq}`; cbs.set(id, fn); w.postMessage({ id, ms }); return id; },
      clear(id) { if (typeof id === 'string') cbs.delete(id); else clearTimeout(id); },
    };
  })();
  // Signaler un message (chat des duels, messages entre amis) : confirmation, puis le bouton devient « Reported ».
  async function reportMessage(btn, send) {
    if (btn.disabled || !confirm(window.RNGI18n ? window.RNGI18n.t('Report this message to the creator of the game?') : 'Report this message to the creator of the game?')) return;
    btn.disabled = true;
    try { await send(); btn.textContent = window.RNGI18n ? window.RNGI18n.t('Reported') : 'Reported'; toast('Thanks, the message was reported', 2500, 'achv'); }
    catch (err) { btn.disabled = false; toast([404, 422, 429].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
  }
  function scheduleSoloAuto(delay) {
    BgTimer.clear(SoloAuto.timer);
    SoloAuto.timer = BgTimer.set(() => {
      if (!SoloAuto.on) return;
      if (currentView !== 'result' && currentView !== 'home') { stopSoloAuto(); return; }
      // Onglet caché (demandé par Sacha, 2026-10-19) : on continue sans animation, voir bgSoloRoll.
      if (document.hidden) { bgSoloRoll(); return; }
      // Fenêtre ouverte : on attend sans rien tirer.
      if ($('#modal-root').firstChild) { scheduleSoloAuto(1000); return; }
      // Pause garantie : le dernier résultat reste visible au moins 1,8 s, quel que soit le chemin qui a programmé ce
      // tirage (retour d'un autre onglet, réaffichage de l'accueil…) ; signalé par WpBejs, 2026-10-22.
      // Un tirage est déjà en cours (lancé à la main pendant la pause) : on attend sa fin au lieu de le couper (Nero, 2026-10-21).
      if (rollPending || (session && !session.finished)) { scheduleSoloAuto(500); return; }
      const wait = SOLO_PAUSE - (Date.now() - SoloAuto.shownAt);
      if (wait > 50) { scheduleSoloAuto(wait); return; }
      startRoll(true);
    }, delay);
  }
  // Tirage auto pendant que l'onglet est caché : même tirage serveur, enregistré tout pareil, sans révélation.
  // Le titre de l'onglet compte les tirages ; au retour, un message résume (et dit si l'auto-roll s'est arrêté).
  const BgRolls = { count: 0, stopped: null, title: '', best: null }; // best : le meilleur tirage fait en arrière-plan (kingston, 2026-10-22)
  async function bgSoloRoll() {
    if (rollPending) { scheduleSoloAuto(1000); return; }
    rollPending = true;
    let online;
    try {
      online = await Online.roll(Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''));
      if (!Number.isInteger(online.n)) throw new Error('Bad roll from the server'); // réponse coupée : on réessaie plus tard
    } catch (err) {
      rollPending = false;
      if (err.status !== 429) clientEvt('bg_error'); // 429 = pause du serveur pas finie : on réessaie, rien n'est perdu
      if (err.status === 403 || err.status === 409) { stopSoloAuto(); return; }
      scheduleSoloAuto(err.status === 429 ? 1500 : 5000); return;
    }
    rollPending = false;
    Collection.ensure();
    const n = online.n, a = analysis(n);
    HdrCoins.soon();
    Store.addRoll(n, a.total, online.t, false);
    Collection.add(Store.rolls[Store.rolls.length - 1], Store.rolls.length - 1);
    if (!BgRolls.count) BgRolls.title = document.title;
    BgRolls.count++;
    if (!BgRolls.best || a.total > BgRolls.best.a.total) BgRolls.best = { n, a };
    document.title = `(${BgRolls.count}) ${BgRolls.title}`;
    if (autoStops(a)) {
      stopSoloAuto(); BgRolls.stopped = { n, a };
      document.title = `✨ ${cap(a.tier)}! ${BgRolls.title}`;
      return;
    }
    scheduleSoloAuto(1800);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) SoloAuto.shownAt = Date.now(); // retour sur l'onglet : on laisse voir l'écran avant le tirage suivant
    if (document.hidden || !BgRolls.count) return;
    const { count, stopped, best } = BgRolls;
    document.title = BgRolls.title; BgRolls.count = 0; BgRolls.stopped = null; BgRolls.best = null;
    const bestTxt = best && (!stopped || best.n !== stopped.n) ? ` · best: ${best.a.str} (${cap(best.a.tier)}, ${fmt(best.a.total)} XP)` : '';
    toast(stopped ? `✨ ${plural(count, 'roll')} while you were away. Auto-roll stopped on ${stopped.a.str} (${cap(stopped.a.tier)}, ${fmt(stopped.a.total)} XP)${bestTxt}`
      : `🎲 ${plural(count, 'roll')} while you were away, all saved${bestTxt}`, 8000, stopped ? 'achv' : undefined);
    if (currentView === 'home') route(); // l'accueil et ses compteurs à jour
  });
  async function startRoll(force) {
    if (rollPending) return;
    if (session && !session.finished && force !== true && !session.canReroll) return;
    // Auto-roll allumé : un appui sur Roll / Espace pendant une révélation coupait le tirage en cours, qui semblait perdu
    // (trouvé par shadow2, 2026-10-21). L'auto-roll enchaîne déjà tout seul : on ignore l'appui.
    if (SoloAuto.on && force !== true && session && !session.finished) return;
    if (!Store.player.name) { askName(() => startRoll(force), '', '', 'Save & roll'); return; }
    rollPending = true;
    const buttons = Array.from(document.querySelectorAll('#roll-btn, #r-again'));
    buttons.forEach(b => { b.disabled = true; });
    let n, online = null;
    // Le serveur ne répond pas (réseau, délai dépassé) : on redemande deux fois le même tirage avant de renoncer.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    const asked = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await Online.roll(nonce);
          // Pas de nombre valide : on redemande le même tirage (le serveur renvoie celui déjà fait grâce au nonce).
          if (!Number.isInteger(r.n) || r.n < 0 || r.n > 1000000) throw new Error('Bad roll from the server');
          return r;
        } catch (err) {
          if (err.status === 409 || err.status === 429 || err.status === 403 || attempt >= 2) throw err;
          if (!attempt) toast('The server is slow to answer, trying again…');
          await new Promise(resolve => setTimeout(resolve, 600 + 900 * attempt));
        }
      }
    })();
    Sound.play('click', { look: genClass().trim().slice(4) || undefined }); // son propre au bouton affiché (pack ASMR) ; après l'envoi de la demande : au tout premier tirage, ouvrir la sortie audio bloque la page ~0,1 s
    try {
      online = await asked;
      n = online.n;
      // Pièces relues à la fin de la révélation seulement : avant, le compteur montait pendant l'animation et trahissait
      // un bon tirage avant le 2e chiffre (kingston, 2026-10-21).
    } catch (err) {
      if (err.status === 429 && SoloAuto.on) {
        clientEvt('auto_429'); rollPending = false; buttons.forEach(b => { b.disabled = false; }); scheduleSoloAuto(1500); return; }
      // Réseau ou serveur qui hoquette (pas de réponse, 5xx) : l'auto-roll reste allumé et réessaie dans 5 s, au lieu de
      // s'éteindre et de laisser le joueur croire à un plantage (signalé par un joueur le 2026-10-16).
      if (SoloAuto.on && (!err.status || err.status >= 500)) {
        rollPending = false; buttons.forEach(b => { b.disabled = false; });
        toast('Connection problem: auto-roll will try again in 5 s', 3000);
        scheduleSoloAuto(5000); return;
      }
      if (SoloAuto.on) stopSoloAuto();
      if (err.status === 409) {
        rollPending = false;
        buttons.forEach(b => { b.disabled = false; });
        askName(() => startRoll(force), '', `"${Store.player.name}" is already taken by another player. Pick a new name.`, 'Save & roll');
        return;
      }
      const wasGoogle = !!Store.player.google;
      if (err.status === 403) {
        clientEvt('id_reset');
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
      clientEvt('offline_roll');
      if (SoloAuto.on) stopSoloAuto();
      toast('Server unreachable: this roll stays on your device and is not counted');
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
    const { saved } = Store.addRoll(n, a.total, online ? online.t : Date.now(), !online);
    const index = Store.rolls.length - 1;
    Collection.add(Store.rolls[index], index);
    if (!saved) clientEvt('storage_full');
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
    // Le nombre contient ton meilleur tirage d'avant (idée de spookiedookie, 2026-10-21) : un clin d'œil, sans XP.
    if (!ctx.replay && ctx.index > 0) {
      let best = null;
      for (let i = 0; i < ctx.index; i++) { const r = Store.rolls[i]; if (!r[3] && (!best || r[1] > best[1])) best = r; }
      if (best && best[0] !== Number(a.str) && a.str.includes(String(best[0]))) notes.push(`<p class="new-note">👑 This number contains your best roll ever, <b class="mono">${esc(String(best[0]))}</b>!</p>`);
      else if (best && best[0] === Number(a.str)) notes.push('<p class="new-note">👑 You rolled your best number ever again!</p>');
    }
    if (ctx.previous.length) {
      const lastIdx = ctx.previous[ctx.previous.length - 1];
      notes.push(`<p class="repeat-note">You've rolled <b class="mono">${a.str}</b> before — ${ctx.previous.length}× (last ${relTime(Store.rolls[lastIdx][2])}, <a href="javascript:void 0" data-roll="${lastIdx}">#${fmt(lastIdx + 1)}</a>)</p>`);
    }
    if (ctx.replay) return `<p class="repeat-note">▶ Replay${ctx.replay.caption ? ` · <span data-no-i18n>${esc(ctx.replay.caption)}</span>` : ''} · nothing is rolled or counted</p>`;
    if (!ctx.online) notes.push('<p class="repeat-note">Offline roll: not on the leaderboard</p>');
    else if (ctx.online.bestToday) notes.push(`<p class="new-note">🏆 Your best roll today: #${ctx.online.dayRank} on <a href="#/leaderboard">today's leaderboard</a></p>`);
    return notes.join('');
  }

  // Révélation en étapes chronométrées, comme l'original :
  // chiffres → badges un par un (XP qui monte) → compteur de badges → rareté → TOP x % → XP à vie.
  // Rien ne peut être sauté ; le menu reste verrouillé jusqu'à l'affichage de la rareté.
  // Pièces gagnées par le tirage (idée de jaxoncool43, 2026-10-24) : le serveur dit combien il a crédité, Weekend Rush
  // compris ; un serveur d'avant ce champ laisse le tarif de la rareté (Shop.COINS).
  // Rendements décroissants (2026-10-25) : le serveur envoie aussi le taux du moment (rate) ; sous 100 %, une petite
  // note le dit, avec le détail des paliers dans l'infobulle.
  function coinsTagHTML(online, tier) {
    const base = Shop.COINS[tier] || 0, got = typeof online.coins === 'number' ? online.coins : base;
    // 2026-10-26 (number 1, kaz, casmictechthing) : au moins 1 pièce, Celestial+ jamais réduit → pas de note dans ce cas.
    const rate = typeof online.rate === 'number' ? online.rate : 1, paid = Shop.rollPayAt ? Shop.rollPayAt(base, rate, tier) : Math.floor(base * rate);
    const tiers = Shop.ROLL_TIERS || [], tip = `Coin rate today: 100% for your first ${fmt(tiers[0] ? tiers[0].upTo : 500)} rolls, then 50% until ${fmt(tiers[1] ? tiers[1].upTo : 2000)}, then 20%. Every roll still pays at least 1 coin, and Celestial or better always pays 100%. XP and luck never change. Resets at 00:00 UTC.`;
    const rateTag = rate < 1 && paid < base ? ` <em class="r-rate" data-tip="${esc(tip)}">Coin rate today: ${Math.round(rate * 100)}%</em>` : '';
    return `<div class="r-coins" id="r-coins" hidden>+🪙 ${fmt(got)} <span>${got === 1 ? 'coin' : 'coins'}</span>${got > paid && paid ? ' <i>🔥 +25% Weekend Rush</i>' : ''}${rateTag}</div>`;
  }

  function playReveal(ctx) {
    currentView = 'result';
    const { n, a } = ctx;
    const speed = SPEEDS[Store.settings.speed] || SPEEDS.normal;
    // Niveau de vitesse acheté dans la boutique : toute la révélation raccourcit, chiffres compris (un rewatch aussi).
    const kd = Shop.speedFactor(Store.settings.speedLv);
    const k = speed.base * kd, kb = speed.badges * kd;
    const slotCount = Math.max(6, a.str.length);
    const padded = a.str.padStart(slotCount, '0');
    const lead = slotCount - a.str.length;
    const ascending = a.groups.slice().reverse();
    // Skin Owner (réservé au créateur, équipé depuis la boutique) : chiffres en rubis et signature en béryl rouge.
    const owner = Shop.resolve(Store.settings.skin) === 'owner';
    wallDive(); // fond Deep Dive : le sous-marin plonge pendant le tirage

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
          ${ctx.online && !ctx.replay ? coinsTagHTML(ctx.online, a.tier) : ''}
          ${ctx.previous.length && !ctx.replay ? `<div class="dup-tag" id="r-dup" hidden>🔁 Duplicate! <span>rolled ${plural(ctx.previous.length + 1, 'time')}</span></div>` : ''}
          <div class="lifetime invisible" id="r-life"${ctx.replay ? ' hidden' : ''}>
            <div class="lifetime-row"><span class="v" id="r-life-v">${fmt(ctx.lifetimeBefore)}</span><span class="delta" id="r-life-delta" hidden>${ctx.online ? `+${fmt(a.total)}` : 'offline roll · not counted'}</span></div>
            <div class="l">Your lifetime XP</div>
          </div>
          <div class="result-actions invisible" id="r-actions">
            <button class="btn" id="r-share">${shareIcon()} Share</button>
            ${ctx.replay ? '<button class="btn" id="r-back">← Back</button><button class="btn" id="r-replay">↻ Replay</button>' : `<button class="btn-roll small${genClass()}" id="r-again">Roll again</button>`}
          </div>
          <p class="hint invisible" id="r-hint"></p>
          ${ctx.replay ? '' : `<div class="solo-auto-row">${soloAutoHTML()}</div>`}
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
    const began = performance.now(), lastWait = digitDelay(slotCount - 2, slotCount) * kd;
    let late = false, lastFrom = 0;
    const sfx = (type, o) => { if (!late) Sound.play(type, o); };
    // Pack de sons acheté (boutique, onglet Sounds) : il change la note des chiffres et le son de la rareté. Les skins dont
    // le son est l'identité (ASMR, Lab) gardent leurs chiffres ; le pack joue quand même la rareté.
    const pack = Store.settings.soundPack && Store.settings.soundPack !== 'classic' ? Store.settings.soundPack : undefined;
    Sound.warm([['tier', { tier: a.tier, pack }]]);
    // La scène du skin : particules et lumière dans la carte et autour, calées sur les mêmes instants.
    const lockSkin = owner ? '' : Shop.resolve(Store.settings.skin);
    if (pack && lockSkin !== 'asmr' && lockSkin !== 'lab') Sound.warm(Array.from({ length: slotCount }, (_, i) => ['lock', i === slotCount - 1 ? { i, final: 1, pack } : { i, pack }]));
    if (lockSkin === 'asmr' || lockSkin === 'lab') Sound.warm(Array.from({ length: slotCount }, (_, i) => ['lock', i === slotCount - 1 ? { i, final: 1, skin: lockSkin } : { i, skin: lockSkin }]));
    const skinFx = SkinFX.mount($('#card-stage'), card, owner ? '' : Shop.resolve(Store.settings.skin), { owner });
    if (!ctx.replay) watchFps(1800);

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
      const lk = i < lead ? { i, soft: 1 } : i === slotCount - 1 ? { i, final: 1 } : { i };
      if (lockSkin === 'asmr' || lockSkin === 'lab') lk.skin = lockSkin; // la cire craque / le tube tinte sous chaque chiffre (js/sound.js)
      else if (pack) lk.pack = pack;
      sfx('lock', lk);
      if (skinFx) skinFx.lock(el, { ghost: i < lead, last: i === slotCount - 1 });
      replay($('#card-stage'), 'thump'); // sur le conteneur : la carte garde ses propres animations (lueur, tremblement)
    };
    step(REVEAL.digitStart, revealDigit(0), kd);
    for (let i = 1; i < slotCount; i++) step(digitDelay(i - 1, slotCount), revealDigit(i), kd);
    steps.push({ at: clock - Sound.LEAD, run: () => { sfx('riser'); if (skinFx) skinFx.build(Sound.LEAD); }, done: false }); // montée de tension, coupée juste avant le dernier chiffre
    step(0, quick => {
      clearInterval(spin);
      card.classList.remove('charging');
      if (!lead) return;
      const collapse = () => slots.slice(0, lead).forEach(el => el.classList.add('collapsed'));
      if (quick) collapse(); else setTimeout(collapse, 260);
    });

    // 2. Badges un par un, du moins rare au plus rare : chacun s'insère en haut et fait monter l'XP.
    // Réglage « Skip known badges » (débloqué à SKIP_BADGES_AT tirages) : un badge déjà obtenu se pose d'un coup ; un
    // badge jamais vu garde toujours sa révélation complète. Chiffres et rareté ne se sautent jamais.
    const skipKnown = skipBadgesOn() && !ctx.isFirst && !ctx.replay;
    // Badges choisis pour toujours garder leur révélation complète (idée d'Aussie Haüs, 2026-10-22 : fiche du badge).
    const always = new Set(Store.settings.fullBadges || []);
    const known = g => skipKnown && ![g.badge, ...g.subsidiary].some(b => (ctx.newIds && ctx.newIds.has(b.id)) || always.has(b.id));
    ascending.forEach((g, i) => {
      const fast = known(g);
      step(fast ? (i === 0 ? 260 : 70) / kb : i === 0 ? REVEAL.badgeStart : badgeDelay(i - 1, ascending.length), q0 => {
        const quick = q0 || fast;
        $('#r-breakdown').hidden = false;
        $('#r-list').insertAdjacentHTML('afterbegin', badgeCardHTML(g, n, { newIds: ctx.newIds, animate: !quick && !reducedMotion, delay: 0 }));
        animateDigits($('#r-list'), { start: reducedMotion ? 0 : 450 });
        const from = running;
        running += g.badge.score;
        countUp(ep, from, running, quick ? 0 : REVEAL.badgeEp * kb, v => `${fmt(v)} XP`);
        if (!late && !fast) Sound.badge(i, ascending.length);
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
      if (!reducedMotion) card.classList.add(TIER_RANK[a.tier] >= TIER_RANK.anomaly ? 'shake' : 'reveal-pulse');
      ep.classList.remove('pending');
      countUp(ep, 0, a.total, 0, v => `${fmt(v)} XP`);
      replay(ep, 'glint');
      // Pièces gagnées par ce tirage, à côté de l'XP (idée de jaxoncool43, 2026-10-24) : seulement maintenant, avec la
      // rareté, pour ne pas trahir un bon tirage avant sa révélation. Hors ligne : rien n'est gagné, pas de pastille.
      { const c = $('#r-coins'); if (c) { c.hidden = false; if (!reducedMotion) c.classList.add('pop-in'); } }
      FX.celebrate(a.tier, card);
      shockwave(card, a.tier);
      sfx('tier', { tier: a.tier, pack });
      if (skinFx) skinFx.reveal(a.tier);
      wallReact(a.tier); // même en retard : le fond réagit quand même (un onglet caché est filtré dans wallReact)
      if (TIER_RANK[a.tier] >= TIER_RANK.epic) $('#card-stage').classList.add('lit'); // rayons derrière la carte
      show($('#r-actions'), 'fade-in');
      $('#r-hint').innerHTML = `<kbd>${esc(keyName())}</kbd> to roll again · click a badge name for details`;
      show($('#r-hint'), 'fade-in');
      document.body.classList.remove('locked');
      canReroll = true;
      if (ctx.online) { noteAchievements(ctx.online.achievements); QuestWatch.bump(questDelta(a.total, a.tier)); }
      // Compte Google associé avant que le bonus existe : il arrive avec ce tirage.
      if (ctx.online && ctx.online.googleBonus) setTimeout(() => { toast(`🪙 +${ctx.online.googleBonus} coins for linking your Google account`, 5000, 'achv'); if (Store.settings.coins != null) Store.setSetting('coins', Store.settings.coins + ctx.online.googleBonus); }, 1200);
    });
    step(REVEAL.stats, () => { show($('#r-meta'), 'pop-in'); const dup = $('#r-dup'); if (dup) { dup.hidden = false; dup.classList.add('pop-in'); } }); // « Duplicate! » (idée de MereTera, 2026-10-18)
    step(REVEAL.lifetimeShow, () => show($('#r-life'), 'fade-in'));
    step(REVEAL.lifetimePause, quick => {
      const delta = $('#r-life-delta');
      delta.hidden = false;
      if (!quick && !reducedMotion) delta.classList.add('float-up');
      if (ctx.online) countUp($('#r-life-v'), ctx.lifetimeBefore, ctx.lifetimeBefore + a.total, quick ? 0 : REVEAL.lifetimeTick * k, fmt);
    });
    step(REVEAL.lifetimeTick + REVEAL.end, () => {
      vignette.classList.remove('on');
      finished = true;
      SoloAuto.shownAt = Date.now();
      if (ctx.online) HdrCoins.soon(300);
      if (SoloAuto.on && !ctx.replay) {
        if (autoStops(a)) { stopSoloAuto(); toast(stopToast(a), 5000, 'achv'); }
        // Le résultat reste lisible au moins 1,8 s (0,9 s avant : un tirage pouvait défiler sans qu'on voie ses badges
        // ni son XP, surtout quand la page avait été ralentie et que la révélation se jouait d'un coup ; finnnnn, 2026-10-18).
        else scheduleSoloAuto(late ? 3000 : 1800);
      }
    });

    const runStep = s => { if (!s.done) { s.done = true; late = performance.now() - began - s.at > 250; s.run(false); } };
    $('#r-share').addEventListener('click', () => share(a, ctx.replay ? ctx.replay.owner || '' : Store.player.name || ''));
    if (ctx.replay) {
      $('#r-back').addEventListener('click', () => { if (session) session.cancel(); session = null; if (location.hash === ctx.replay.back) route(); else location.hash = ctx.replay.back || '#/'; });
      $('#r-replay').addEventListener('click', () => { if (session) session.cancel(); session = null; rewatch(n, ctx.replay.caption, ctx.replay.owner); });
    } else { $('#r-again').addEventListener('click', () => startRoll('again')); bindSoloAuto(); } // pas « true » : ce bouton ne doit pas couper un tirage auto en cours (jaxoncool43, kingston, 2026-10-23)

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
    const sortOptions = [['new', 'Newest first'], ['old', 'Oldest first'], ['high', 'Highest XP'], ['low', 'Lowest XP'], ['numUp', 'Smallest number'], ['numDown', 'Biggest number'], ['reps', 'Most rolled']]; // tri par valeur : idée de Lolha39 (2026-10-18) ; « Most rolled » : idée de CococoC (2026-10-23)
    const options = (list, value) => list.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${l}</option>`).join('');
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Roll history</h1>
        <div class="toolbar">
          <input class="input grow" id="h-q" type="search" placeholder="Search a number, a badge or #roll…" value="${esc(histState.q)}">
          <select class="select" id="h-tier" aria-label="Rarity">${options(tierOptions, histState.tier)}</select>
          <select class="select" id="h-sort" aria-label="Sort">${options(sortOptions, histState.sort)}</select>
          <button class="btn" id="h-compare" type="button" aria-pressed="false">⚖️ Compare</button>
        </div>
        <p class="panel-note" id="h-compare-note" hidden>Click two rolls to compare them</p>
        <div class="count-line" id="h-count"></div>
        <div class="table-card" id="h-list"></div>
      </div>`;
    const redraw = () => { histState.limit = 100; drawHistoryList(); };
    $('#h-q').addEventListener('input', e => { histState.q = e.target.value; redraw(); });
    $('#h-tier').addEventListener('change', e => { histState.tier = e.target.value; redraw(); });
    $('#h-sort').addEventListener('change', e => { histState.sort = e.target.value; redraw(); });
    // Comparer deux tirages (idée de kingston, 2026-10-22) : mode « Compare », on clique deux lignes, une fenêtre les met
    // côte à côte (XP, écart, badges en commun et propres à chacun).
    let picked = [];
    const setCompare = on => {
      histState.compare = on; picked = [];
      $('#h-compare').setAttribute('aria-pressed', String(on)); $('#h-compare').classList.toggle('on', on);
      $('#h-compare-note').hidden = !on;
      document.querySelectorAll('#h-list .picked').forEach(el => el.classList.remove('picked'));
    };
    $('#h-compare').addEventListener('click', () => setCompare(!histState.compare));
    $('#h-list').addEventListener('click', e => {
      if (!histState.compare) return;
      const row = e.target.closest('[data-roll]'); if (!row) return;
      e.preventDefault(); e.stopPropagation();
      const i = Number(row.dataset.roll);
      if (picked.includes(i)) { picked = picked.filter(x => x !== i); row.classList.remove('picked'); return; }
      picked.push(i); row.classList.add('picked');
      if (picked.length === 2) { const [a, b] = picked; setCompare(false); openCompareModal(a, b); }
    }, true);
    setCompare(!!histState.compare);
    drawHistoryList();
  }

  function openCompareModal(ia, ib) {
    const side = i => { const r = Store.rolls[i], a = analysis(r[0]); return { i, n: r[0], a, ids: new Set(a.earnedIds) }; };
    const A = side(ia), B = side(ib);
    const pill = id => { const b = Engine.byId.get(id); return b ? `<span class="badge-pill" data-tier="${b.tier}">${b.emoji} ${esc(b.label)}</span>` : ''; };
    const list = ids => (ids.length ? ids.sort((x, y) => (Engine.byId.get(y)?.score || 0) - (Engine.byId.get(x)?.score || 0)).map(pill).join(' ') : '<span class="panel-note">none</span>');
    const common = [...A.ids].filter(id => B.ids.has(id)), onlyA = [...A.ids].filter(id => !B.ids.has(id)), onlyB = [...B.ids].filter(id => !A.ids.has(id));
    const diff = A.a.total - B.a.total;
    const card = x => `<div class="cmp-side"><span class="panel-note">#${fmt(x.i + 1)}</span><span class="num-card md" data-tier="${x.a.tier}">${x.a.str}</span><span class="badge-pill" data-tier="${x.a.tier}">${cap(x.a.tier)}</span><b class="mono">${fmt(x.a.total)} XP</b><span class="panel-note">${plural(x.ids.size, 'badge')}</span></div>`;
    openModal(`
      <h2>⚖️ Compare rolls</h2>
      <div class="cmp-grid">${card(A)}<div class="cmp-vs">${diff === 0 ? '=' : diff > 0 ? '◀' : '▶'}<span class="panel-note">${diff === 0 ? 'same XP' : `${fmt(Math.abs(diff))} XP more`}</span></div>${card(B)}</div>
      <div class="cmp-badges"><div class="eyebrow">In common (${common.length})</div><div class="pill-row">${list(common)}</div></div>
      <div class="cmp-badges"><div class="eyebrow">Only #${fmt(A.i + 1)} (${onlyA.length})</div><div class="pill-row">${list(onlyA)}</div></div>
      <div class="cmp-badges"><div class="eyebrow">Only #${fmt(B.i + 1)} (${onlyB.length})</div><div class="pill-row">${list(onlyB)}</div></div>`);
  }

  function filteredRolls() {
    let items = Store.rolls.map((r, i) => ({ n: r[0], s: r[1], t: r[2], i, tier: Engine.cardTier(r[1]), off: !!r[3] }));
    if (histState.tier === 'rare+') items = items.filter(x => TIER_RANK[x.tier] >= 3);
    else if (histState.tier !== 'all') items = items.filter(x => x.tier === histState.tier);
    const q = histState.q.trim().toLowerCase();
    if (q) {
      const digits = q.replace(/[\s,]/g, '');
      // « #3333 » ou « roll 3333 » : le tirage numéro 3333 (idée de kaz, 2026-10-20).
      const nth = digits.match(/^(?:#|roll#?)(\d+)$/);
      if (nth) items = items.filter(x => x.i + 1 === Number(nth[1]));
      else if (/^\d+$/.test(digits)) items = items.filter(x => String(x.n).includes(digits));
      else items = items.filter(x => analysis(x.n).earnedIds.some(id => LABELS.get(id).includes(q)));
    }
    // Nombre de fois où le nombre est sorti (tout l'historique, comme le « ×N » des lignes) ; les égalités restent groupées par nombre.
    const reps = x => (Collection.seen.get(x.n) || []).length;
    const sorters = {
      new: (a, b) => b.i - a.i,
      old: (a, b) => a.i - b.i,
      numUp: (a, b) => a.n - b.n || b.i - a.i,
      numDown: (a, b) => b.n - a.n || b.i - a.i,
      high: (a, b) => b.s - a.s || b.i - a.i,
      low: (a, b) => a.s - b.s || b.i - a.i,
      reps: (a, b) => reps(b) - reps(a) || a.n - b.n || b.i - a.i,
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
        <span class="mid">${tierPill(x.tier)}<span class="emojis">${a.groups.slice(0, 4).map(g => g.badge.emoji).join(' ')}</span>${reps > 1 ? `<span class="muted" style="font-size:.66rem" title="Rolled ${reps} times">×${reps}</span>` : ''}${x.off ? '<span class="offline-tag" title="Rolled while the server was unreachable: not counted on the leaderboard or in your lifetime XP">offline</span>' : ''}</span>
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
      if (TIER_RANK[tier] >= TIER_RANK.mythic) sinceMythic = i;
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
    setTimeout(fillServerLife, 0);
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
          <span id="st-rolls">${tile('Rolls', fmt(N), `${fmt(st.today)} today`)}</span>
          <span id="st-life">${tile('Lifetime XP', compact(st.lifetime), `${fmt(st.lifetime / N)} XP per roll`)}</span>
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
            <div class="kv"><span class="k">Rolls since last Mythic or better</span><span class="v">${st.sinceMythic}</span></div>
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
        <div class="panel xc-panel">
          <div class="panel-head"><h3 class="panel-title">🔎 XP checker</h3><span class="panel-note">type any number to see its XP and badges · it is not a roll</span></div>
          <form id="xc-form" class="xc-form"><input class="input mono" id="xc-n" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="e.g. 112358" aria-label="Number to check"><button class="btn">Check</button></form>
          <div id="xc-out"></div>
        </div>
        <div id="b-ach"><div class="panel"><div class="empty">${Store.player.name ? 'Loading your achievements…' : 'Roll once to start unlocking achievements and titles.'}</div></div></div>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Badge collection</h3></div>
          ${collectionHTML(Collection.badges.size, collState)}
        </div>
      </div>`;
    mountCollection(localCollection(), collState);
    loadMyAchievements();
    // Vérificateur d'XP (idée d'un joueur, 2026-10-16) : n'importe quel nombre, calculé ici comme un tirage, mais affiché
    // exprès autrement qu'un tirage (cadre pointillé, « SIMULATION », pas de skin) : une capture ne peut pas passer pour un vrai.
    $('#xc-form').addEventListener('submit', e => {
      e.preventDefault();
      const raw = $('#xc-n').value.trim(), n = Number(raw);
      if (!/^\d{1,7}$/.test(raw) || n > Engine.MAX_ROLL) { toast(`Type a whole number from 0 to ${fmt(Engine.MAX_ROLL)}`); return; }
      const a = analysis(n), secret = n === 0 ? '<p class="xc-secret" data-no-i18n>🔑 ZEROHERO</p>' : '';
      $('#xc-out').innerHTML = `
        <div class="xc-result">
          <span class="xc-sim">Simulation · not a roll</span>
          <div class="xc-num mono" data-no-i18n>${(() => { const full = String(n).padStart(6, '0'), lead = n ? full.search(/[1-9]/) : 5; return `<span class="xc-ghost">${full.slice(0, lead)}</span>${full.slice(lead)}`; })()}</div>
          <div class="xc-meta"><span class="badge-pill" data-tier="${a.tier}">${esc(a.tier)}</span><b class="mono">${fmt(a.total)} XP</b>${percentileHTML(a.percentile)}</div>
          ${secret}<div class="pill-row xc-badges">${a.groups.length ? a.groups.map(g => `<span class="badge-pill" data-tier="${g.badge.tier}" data-badge="${g.badge.id}" style="cursor:pointer">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join(' ') : '<span class="panel-note">No badge</span>'}</div>
        </div>`;
    });
  }

  // Mes succès (calculés par le serveur) et le titre équipé, dans l'onglet Badges.
  async function loadMyAchievements() {
    const slot = $('#b-ach');
    if (!slot || !Store.player.name) return;
    let p;
    try {
      // lite : succès et titre seulement, sans l'historique (un gros historique dépassait le délai de 6 s, 2026-10-25).
      p = await Online.profile(Store.player.name, true);
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
    const blocks = ['celestial', 'mythic', 'anomaly', 'epic', 'rare', 'uncommon', 'common'].map(tier => {
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
    // Profil en deux temps (refait le 2026-10-17, « parti en bazar ») : une carte d'en-tête (qui il est, son meilleur
    // tirage dans son skin, 4 chiffres clés), puis des onglets au lieu de dix blocs empilés.
    $('#p-title').remove();
    const topRoll = top ? analysis(top.n) : null;
    const tierCount = t => (p.tiers && p.tiers[t]) || 0;
    const rollRow = (x, k) => {
      const a = analysis(x.n);
      return `
        <div class="record" data-number="${x.n}" data-owner="${esc(p.name)}" data-caption="${esc(caption(x))}">
          <span class="rank">${k + 1}</span>
          <span class="num-card sm" data-tier="${a.tier}">${a.str}</span>
          <span class="grow">${a.groups.slice(0, 3).map(g => `${g.badge.emoji} ${esc(g.badge.label)}`).join(' · ')}</span>
          <span class="when" title="${fullDate(x.t)}">${relTime(x.t)}</span>
          <span class="ep-pill">${compact(x.s)} XP</span>
        </div>`;
    };
    const rollList = list => (list && list.length ? `<div class="records">${list.map(rollRow).join('')}</div>` : '<div class="empty">No rolls yet.</div>');
    const inv = p.inventory || { skins: [], walls: [] };
    const invSkins = inv.skins.filter(k => Shop.byId.has(k)).map(k => Shop.byId.get(k)).sort((x, y) => y.price - x.price);
    const invWalls = inv.walls.filter(k => Shop.wallById.has(k)).map(k => Shop.wallById.get(k));
    const achDone = (p.achievements || []).filter(id => Ach.byId.has(id) && !Ach.byId.get(id).hidden).length;
    const achTotal = Ach.LIST.filter(a => !a.hidden).length;
    const d = p.duels || {};
    const TABS = [
      ['overview', '🏠', 'Overview'],
      ['rolls', '🎲', 'Rolls'],
      ['badges', '🏅', `Badges <small>${found}</small>`],
      ['achievements', '🏆', `Achievements <small>${achDone}</small>`],
      ...(d.played || (d.rivals || []).length ? [['duels', '⚔️', `Duels <small>${fmt(d.won || 0)}</small>`]] : []),
      ['inventory', '🎒', `Inventory <small>${invSkins.length + invWalls.length}</small>`],
    ];
    let tab = 'overview';
    try { const t = sessionStorage.getItem('rngProfileTab'); if (TABS.some(x => x[0] === t)) tab = t; } catch (e) { /* onglet par défaut */ }
    const rarities = ['infinite', 'godlike', 'divine', 'celestial', 'mythic', 'anomaly', 'epic', 'rare'];

    $('#p-body').innerHTML = `
      <section class="pf-hero">
        <div class="pf-id">
          <div class="pf-name">${Avatars.html(p.name, 'av-lg')}<span>${esc(p.name)}${me ? ' <span class="muted">(you)</span>' : ''}</span></div>
          <div class="pf-tags">${p.clan ? `<a class="cl-ptag" href="#/clan" title="Clan">${esc(p.clan.emoji || '🛡️')} <span data-no-i18n>${esc(p.clan.name)}</span> ${clanTagHTML(p.clan)}</a>` : ''}${titleHTML(p.title)}${(p.tops || []).map(topHTML).join('')}${p.discord ? `<span class="pf-discord" title="Discord linked">💬 ${esc(p.discord)}</span>` : ''}</div>
          <div class="pf-since">${p.rolls ? `Playing since ${day(p.since)} · last roll ${relTime(p.last)}` : 'No rolls yet'}</div>
          <div class="pf-actions">${me ? '<a class="btn" href="#/friends">⚙️ Edit my profile</a>' : `<button class="btn add-friend" id="p-friend">👥 Add friend</button>${Store.player.name && Avatars.tok(p.name) ? '<button class="btn ghost small" id="p-av-report" title="Report this profile picture">🚩 Report picture</button>' : ''}`}</div>
        </div>
        <div class="pf-best">
          ${topRoll ? `<div class="pf-best-label">Best roll ever</div>
          <span class="num-card md skin-${esc(p.skin || 'classic')}" data-tier="${topRoll.tier}" data-number="${top.n}" data-owner="${esc(p.name)}" data-caption="${esc(caption(top))}" style="cursor:pointer">${(() => { const lead = top.n ? topRoll.str.search(/[1-9]/) : topRoll.str.length - 1; return topRoll.str.split('').map((c, i) => `<span class="slot${i < lead ? ' ghost' : ''}">${c}</span>`).join(''); })()}</span>
          <div class="pf-best-meta">${tierPill(topRoll.tier)}<b class="mono">${fmt(top.s)} XP</b></div>` : '<div class="empty">No rolls yet</div>'}
        </div>
        <div class="pf-stats">
          <div class="pf-stat"><span>Level</span><b>${p.level != null ? `⭐ ${fmt(p.level)}` : '–'}</b></div>
          <div class="pf-stat"><span>Lifetime XP</span><b title="${fmt(p.lifetime)} XP">${compact(p.lifetime)}</b></div>
          <div class="pf-stat"><span>All-time rank</span><b>${p.rank ? '#' + fmt(p.rank) : '–'}</b></div>
          <div class="pf-stat"><span>Badges</span><b>${found}<small>/${total}</small></b></div>
        </div>
        <div class="pf-more">🎲 ${plural(p.rolls, 'roll')}${p.rolls ? ` · ${fmt(p.lifetime / p.rolls)} XP per roll` : ''}${me && p.spent ? ` · 🪙 ${fmt(p.spent)} coins spent${p.cases ? ` (${plural(p.cases, 'case')} opened)` : ''}` : ''}${p.questBest ? ` · 🔥 best quest streak ${plural(p.questBest, 'day')}` : ''}${d.played ? ` · ⚔️ ${fmt(d.won)} / ${fmt(d.played)} duels won` : ''}</div>
      </section>
      <div class="lb-tabs pf-tabs" role="tablist" style="grid-template-columns:repeat(${TABS.length},1fr)">${TABS.map(([id, icon, label]) => `<button role="tab" data-ptab="${id}" class="${id === tab ? 'on' : ''}"><i aria-hidden="true">${icon}</i> ${label}</button>`).join('')}</div>
      <div class="pf-pane" data-pane="overview">
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Rare rolls</h3><span class="panel-note">how many times ${me ? 'you' : esc(p.name)} hit each top rarity</span></div>
          <div class="pf-rarities">${rarities.map(t => `<div class="pf-rar${tierCount(t) ? '' : ' none'}" data-tier="${t}"><b>${fmt(tierCount(t))}</b><span>${cap(t)}</span></div>`).join('')}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Top 5 rolls</h3><span class="panel-note">click a number for its badges · all of them in Rolls</span></div>
          ${rollList(p.best.slice(0, 5))}
        </div>
        ${!me && mine ? compareHTML(mine, p) : ''}
      </div>
      <div class="pf-pane" data-pane="rolls" hidden>
        <div class="grid-2 pf-rolls">
          <div class="panel"><div class="panel-head"><h3 class="panel-title">🏆 Best rolls</h3><span class="panel-note">the 10 highest</span></div>${rollList(p.best)}</div>
          <div class="panel"><div class="panel-head"><h3 class="panel-title">🗑️ Worst rolls</h3><span class="panel-note">the 10 lowest, worst first</span></div>${rollList(p.worst)}</div>
        </div>
      </div>
      <div class="pf-pane" data-pane="badges" hidden>
        <div class="panel"><div class="panel-head"><h3 class="panel-title">Badge collection</h3></div>${collectionHTML(found, collectionState)}</div>
      </div>
      <div class="pf-pane" data-pane="achievements" hidden>${achievementsPanelHTML(p, me)}</div>
      <div class="pf-pane" data-pane="duels" hidden>${duelsPanelHTML(p, me)}</div>
      <div class="pf-pane" data-pane="inventory" hidden>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">🎨 Skins</h3><span class="panel-note">${plural(invSkins.length, 'skin')}${p.skin && p.skin !== 'classic' && Shop.byId.has(p.skin) ? ` · wearing ${Shop.byId.get(p.skin).emoji} ${esc(Shop.byId.get(p.skin).name)}` : ''}</span></div>
          ${invSkins.length ? `<div class="pf-inv">${invSkins.map(k => `<div class="pf-inv-item${k.id === p.skin ? ' on' : ''}" title="${esc(k.desc)}"><span class="num-card sm skin-${k.id}" data-tier="rare">${slotsHTML('777')}</span><b>${k.emoji} ${esc(k.name)}</b></div>`).join('')}</div>` : '<div class="empty">No skins yet.</div>'}
        </div>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">🖼️ Wallpapers</h3><span class="panel-note">${plural(invWalls.length, 'wallpaper')}</span></div>
          ${invWalls.length ? `<div class="pf-inv">${invWalls.map(w => `<div class="pf-inv-item" title="${esc(w.desc)}"><span class="wall-preview wp wp-${w.id}" aria-hidden="true"></span><b>${w.emoji} ${esc(w.name)}</b></div>`).join('')}</div>` : '<div class="empty">No wallpapers yet.</div>'}
        </div>
      </div>`;
    const showTab = id => {
      tab = id;
      $('#p-body').querySelectorAll('[data-ptab]').forEach(b => b.classList.toggle('on', b.dataset.ptab === id));
      $('#p-body').querySelectorAll('.pf-pane').forEach(el => { el.hidden = el.dataset.pane !== id; });
      try { sessionStorage.setItem('rngProfileTab', id); } catch (e) { /* idem */ }
    };
    showTab(tab);
    $('#p-body').querySelector('.pf-tabs').addEventListener('click', e => { const b = e.target.closest('[data-ptab]'); if (b) showTab(b.dataset.ptab); });
    const avReport = $('#p-av-report');
    if (avReport) avReport.addEventListener('click', async () => {
      if (!confirm(window.RNGI18n ? window.RNGI18n.t('Report this profile picture to the creator?') : 'Report this profile picture to the creator?')) return;
      avReport.disabled = true;
      try { await Online.avatar('report', { name: p.name }); toast('Thanks, the creator will look at it'); } catch (err) { avReport.disabled = false; toast(err.status && err.status < 500 ? err.message : 'Unavailable right now, try again'); }
    });
    const addFriend = $('#p-friend');
    if (addFriend) {
      addFriend.addEventListener('click', () => friendAction(addFriend.dataset.act || 'add', p.name).then(() => renderProfile(p.name)));
      // Déjà ami, demande envoyée ou reçue : le bon bouton, pas « Add friend » (signalé par kaz, 2026-10-18).
      if (Store.player.name) Online.friends().then(fs => {
        if (!addFriend.isConnected) return;
        const low = String(p.name).toLowerCase(), has = list => (list || []).some(x => String(x && x.name || x).toLowerCase() === low);
        if (has(fs.friends)) { addFriend.textContent = '✓ Friends'; addFriend.disabled = true; addFriend.classList.add('is-friend'); }
        else if (has(fs.outgoing)) { addFriend.textContent = '⏳ Request sent'; addFriend.disabled = true; }
        else if (has(fs.incoming)) { addFriend.textContent = '✓ Accept friend request'; addFriend.dataset.act = 'accept'; }
      }).catch(() => {});
    }
    if (me) noteAchievements(p.achievements);
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
      ? `<span class="mono" data-number="${p.best[0].n}" data-owner="${esc(p.name)}" data-caption="${esc(`${p.name} · best roll`)}" style="cursor:pointer">${analysis(p.best[0].n).str}</span> · ${compact(p.best[0].s)} XP`
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
      ...['infinite', 'godlike', 'divine', 'celestial', 'mythic', 'anomaly', 'epic', 'rare'].map(t => [`${cap(t)} rolls`, p => (p.tiers && p.tiers[t]) || 0, v => fmt(v), 1]),
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
      return `<div class="record" data-number="${x.n}" data-owner="${esc(p.name)}" data-caption="${esc(`${p.name} · ${fullDate(x.t)}`)}"><span class="rank">${k + 1}</span><span class="num-card sm" data-tier="${a.tier}">${a.str}</span><span class="grow"></span><span class="ep-pill">${compact(x.s)} XP</span></div>`;
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
  // Rythmes de sondage allongés le 2026-10-11 : chaque appel coûte du temps de calcul chez l'hébergeur, dont le quota
  // mensuel gratuit (4 h) était consommé aux trois quarts. Les duels restent synchronisés par l'heure du serveur.
  const ROOM_POLL_MS = 2000;
  const ROOM_IDLE_MS = 10 * 60000; // sans aucun changement pendant 10 min, on arrête de sonder (quota de la base)
  const XP_TARGETS = [25000, 50000, 100000, 250000, 1000000];
  // Objectifs libres d'un duel (mêmes bornes que api/room.js) : manches à gagner, XP à atteindre.
  const DUEL_WINS_MAX = 50, DUEL_XP_MIN = 5000, DUEL_XP_MAX = 10000000;
  // « 300k », « 1.5m », « 250 000 » → un nombre ; NaN si ce n'en est pas un.
  const parseAmount = raw => { const m = String(raw).trim().toLowerCase().replace(/[\s,_']/g, '').replace(/xp$/, '').match(/^(\d+(?:\.\d+)?)([km]?)$/); return m ? Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)) : NaN; };
  const Room = { code: null, token: 0, timer: 0, offset: 0, rtt: Infinity, data: null, shown: 0, anim: null, view: null, sig: '', changedAt: 0, reactSeen: new Set(), reactBusy: false, achNoted: false, chatSeen: 0, chatAt: 0, chatSig: '', auto: false, autoCode: '', autoRound: -1, autoTimer: 0 };
  // Emotes de duel : la mascotte dé (images dessinées pour le site). Touches 1 à 6.
  const REACTIONS = ['laugh', 'cry', 'angry', 'cool', 'shock', 'king'];
  const EMOTE_LABELS = { laugh: 'Laugh', cry: 'Cry', angry: 'Angry', cool: 'Cool', shock: 'Shocked', king: 'King' };
  // Les six de base sont des images ; les émotes spéciales (achetées dans la boutique) sont dessinées et animées en
  // SVG (js/emotes.js). Tout le monde les voit, seuls ceux qui les possèdent peuvent les envoyer.
  const Emotes = window.RNGEmotes || { svg: () => '', has: () => false };
  const emoteHTML = (id, cls = '') => (EMOTE_LABELS[id]
    ? `<img class="emote${cls}" src="img/emotes/${id}.png" alt="${EMOTE_LABELS[id]}" draggable="false">`
    : Emotes.has(id) ? `<span class="emote emote-svg${cls}" role="img" aria-label="${esc((Shop.emoteById.get(id) || {}).name || id)}" data-no-i18n>${Emotes.svg(id)}</span>`
    : esc(id)); // ancienne réaction en emoji (salles d'avant les emotes)
  const myEmotes = () => (Store.settings.emotes || []).filter(e => Shop.emoteById.has(e) && Emotes.has(e));
  const titleEmoji = id => (id && Ach.byId.get(id) && !Ach.byId.get(id).hidden ? ` ${Ach.byId.get(id).emoji}` : '');
  const goalText = d => (d.mode === 'xp' ? `first to ${compact(d.target)} XP` : `first to ${plural(d.target, 'round win')}`);

  // Derniers réglages choisis, retenus sur l'appareil.
  function duelPrefs() {
    const d = Store.settings.duel || {};
    return {
      size: Math.min(10, Math.max(2, Number(d.size) || 2)),
      mode: d.mode === 'xp' ? 'xp' : 'rounds',
      wins: Math.min(DUEL_WINS_MAX, Math.max(1, Math.round(Number(d.wins)) || 3)),
      xp: Number(d.xp) > 0 ? Math.min(DUEL_XP_MAX, Math.max(DUEL_XP_MIN, Math.round(Number(d.xp)))) : 50000,
      isPublic: d.isPublic !== false,
      stake: Shop.STAKES.includes(Number(d.stake)) ? Number(d.stake) : 0,
      opp: d.opp === 'bots' ? 'bots' : 'friends',
    };
  }

  // Onglet Duel : parties publiques en cours, créer ou rejoindre une partie, boutique de skins.
  let hubTimer = 0;
  function renderDuelHub() {
    currentView = 'duel';
    // Solde à jour pour la ligne de mise (« You have 🪙 … »).
    if (Store.player.name) Online.shop().then(st => { applyShop(st); const w = $('#d-wallet'); if (w) w.textContent = `You have 🪙 ${fmt(st.coins)}`; }).catch(() => {});
    app.innerHTML = `
      <div class="page page-wide">
        <h1 class="page-title">Duel</h1>
        <p class="panel-note profile-sub">Everyone rolls at the same time and all numbers are revealed together, digit by digit. Duel rolls are normal rolls: they stay in your history and count on the leaderboard.</p>
        <div class="panel tn-teaser" id="d-tourney"><span class="panel-note">🏆 Loading the tournament…</span></div>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Live now</h3><span class="panel-note">public games · watch or join without a code</span></div>
          <div id="d-live"><div class="empty">Loading…</div></div>
        </div>
        <div class="duel-layout stats-sep">
          <div class="panel">
            <div class="panel-head"><h3 class="panel-title">New duel</h3></div>
            <div id="d-setup"></div>
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
    // Création en questions simples, dans l'ordre où on se les pose ; chaque choix dit ce qu'il change.
    const drawSetup = () => {
      const p = duelPrefs();
      const bots = p.opp === 'bots';
      const choice = (key, value, on, emoji, title, text) => `<button class="choice${on ? ' on' : ''}" data-pref="${key}" data-v="${value}"><span class="choice-emoji">${emoji}</span><span class="choice-text"><b>${title}</b><span>${text}</span></span></button>`;
      // typed : le nombre du milieu devient un champ où l'on peut écrire sa valeur.
      const stepper = (key, value, min, max, typed) => `<div class="stepper"><button data-step="${key}" data-d="-1"${value <= min ? ' disabled' : ''} aria-label="Less">−</button>${typed ? `<input class="mono step-input" data-type="${key}" inputmode="numeric" maxlength="3" value="${value}" aria-label="Rounds to win">` : `<b class="mono">${value}</b>`}<button data-step="${key}" data-d="1"${value >= max ? ' disabled' : ''} aria-label="More">+</button></div>`;
      const chips = (key, values, current, label) => `<div class="chips-row">${values.map(v => `<button class="chip${v === current ? ' on' : ''}" data-pref="${key}" data-v="${v}">${label(v)}</button>`).join('')}</div>`;
      const others = p.size - 1;
      $('#d-setup').innerHTML = `
        <div class="setup-step">
          <div class="setup-q">1 · Who do you play against?</div>
          <div class="choice-row">
            ${choice('opp', 'friends', !bots, '👥', 'Other players', 'You get a code to share')}
            ${choice('opp', 'bots', bots, '🤖', 'Bots', 'Starts right away')}
          </div>
        </div>
        <div class="setup-step">
          <div class="setup-q">2 · How many players?</div>
          <div class="setup-line">${stepper('size', p.size, 2, 10)}<span class="panel-note">You + ${bots ? plural(others, 'bot') : plural(others, 'opponent')}</span></div>
        </div>
        <div class="setup-step">
          <div class="setup-q">3 · How do you win?</div>
          <div class="choice-row">
            ${choice('mode', 'rounds', p.mode !== 'xp', '🏁', 'Rounds', 'The highest roll wins the round')}
            ${choice('mode', 'xp', p.mode === 'xp', '⚡', 'XP race', 'Every roll adds up')}
          </div>
          ${p.mode === 'xp'
            ? `<div class="setup-line"><span class="panel-note">First to reach</span>${chips('xp', XP_TARGETS, p.xp, v => `${compact(v)} XP`)}</div>
               <div class="setup-line setup-custom"><span class="panel-note">or type your own</span><input class="input setup-input${XP_TARGETS.includes(p.xp) ? '' : ' on'}" data-type="xp" inputmode="decimal" maxlength="12" placeholder="e.g. 300k" value="${XP_TARGETS.includes(p.xp) ? '' : fmt(p.xp)}" aria-label="XP to reach"><span class="panel-note">XP · ${compact(DUEL_XP_MIN)} to ${compact(DUEL_XP_MAX)}</span></div>`
            : `<div class="setup-line"><span class="panel-note">First to win</span>${stepper('wins', p.wins, 1, DUEL_WINS_MAX, true)}<span class="panel-note">${p.wins === 1 ? 'round' : 'rounds'} · type a number up to ${DUEL_WINS_MAX}</span></div>`}
        </div>
        ${bots ? '' : `
        <div class="setup-step">
          <div class="setup-q">4 · Who can join?</div>
          <div class="choice-row">
            ${choice('isPublic', 'true', p.isPublic, '🌍', 'Everyone', 'Listed in Live now')}
            ${choice('isPublic', 'false', !p.isPublic, '🔒', 'Only with the code', 'Hidden from the list')}
          </div>
        </div>
        <div class="setup-step">
          <div class="setup-q">5 · Play for coins? <span class="panel-note">optional</span></div>
          ${chips('stake', Shop.STAKES, p.stake, v => (v ? `🪙 ${fmt(v)}` : 'No stake'))}
          <p class="panel-note d-wallet" id="d-wallet">${Store.settings.coins != null ? `You have 🪙 ${fmt(Store.settings.coins)}` : ''}</p>
          <p class="panel-note setup-help">${p.stake
            ? `Each player pays 🪙 ${fmt(p.stake)} when joining. The winner takes the pot of 🪙 ${fmt(p.stake * p.size)}. Refunded on a draw or if everyone leaves. Needs 30 rolls on your account.`
            : 'Just for fun: nobody pays anything.'}</p>
        </div>`}
        <div class="setup-summary">
          <span>${plural(p.size, 'player')} · ${goalText({ mode: p.mode, target: p.mode === 'xp' ? p.xp : p.wins })}${bots ? ' · against bots' : ` · ${p.isPublic ? 'public' : 'private'}${p.stake ? ` · 🪙 ${fmt(p.stake)} each` : ''}`}</span>
          <button class="btn-roll small" id="d-go">${bots ? `🤖 Start vs ${plural(others, 'bot')}` : '⚔️ Create the duel'}</button>
        </div>
        ${bots ? '<p class="panel-note setup-help">Against bots your rolls count as usual, but not duel wins, rivalries or duel achievements.</p>' : ''}`;
    };
    drawSetup();
    $('#d-setup').addEventListener('click', e => {
      const p = duelPrefs();
      const step = e.target.closest('[data-step]');
      if (step) {
        const key = step.dataset.step, [min, max] = key === 'size' ? [2, 10] : [1, DUEL_WINS_MAX];
        Store.setSetting('duel', { ...p, [key]: Math.min(max, Math.max(min, p[key] + Number(step.dataset.d))) });
        return drawSetup();
      }
      if (e.target.closest('#d-go')) return createRoom(p.opp === 'bots' ? p.size - 1 : 0);
      const btn = e.target.closest('[data-pref]');
      if (!btn) return;
      const key = btn.dataset.pref, v = btn.dataset.v;
      const value = key === 'mode' || key === 'opp' ? v : key === 'isPublic' ? v === 'true' : Number(v);
      Store.setSetting('duel', { ...p, [key]: value });
      drawSetup();
    });
    // Valeur tapée à la main (manches à gagner, XP à atteindre) : prise en compte quand on quitte le champ ou sur Entrée.
    const typed = e => {
      const field = e.target.closest('[data-type]');
      if (!field) return;
      const p = duelPrefs(), key = field.dataset.type, n = parseAmount(field.value);
      if (!Number.isFinite(n) || n <= 0) { if (field.value.trim()) toast(key === 'xp' ? 'Type an amount of XP, like 300k or 2m' : 'Type a number of rounds'); return drawSetup(); }
      const [min, max] = key === 'xp' ? [DUEL_XP_MIN, DUEL_XP_MAX] : [1, DUEL_WINS_MAX], value = Math.min(max, Math.max(min, n));
      if (value !== n) toast(key === 'xp' ? `Between ${compact(min)} and ${compact(max)} XP` : `Between ${min} and ${max} rounds`);
      Store.setSetting('duel', { ...p, [key]: value });
      drawSetup();
    };
    $('#d-setup').addEventListener('change', typed);
    $('#d-setup').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('[data-type]')) { e.preventDefault(); e.target.blur(); } });
    $('#d-join').addEventListener('submit', e => { e.preventDefault(); joinRoom($('#d-code').value); });
    drawLive();
    drawTourneyTeaser();
  }

  // Catégories de la boutique, dans l'ordre des onglets.
  const SHOP_TABS = [['limited', '🎃', 'Limited'], ['skins', '🎨', 'Skins'], ['buttons', '🔘', 'Buttons'], ['emotes', '😎', 'Emotes'], ['sounds', '🔊', 'Sounds'], ['walls', '🖼️', 'Wallpapers'], ['cases', '📦', 'Cases'], ['speed', '⚡', 'Upgrades'], ['prestige', '👑', 'Prestige']];
  function renderShop() {
    currentView = 'shop';
    app.innerHTML = `
      <div class="page page-wide">
        <div class="g-head"><h1 class="page-title">Shop</h1><span class="g-wallet"><span class="eyebrow">Your coins</span><b class="mono" id="d-coins">${Store.settings.coins != null ? `🪙 ${fmt(Store.settings.coins)}` : '🪙 …'}</b></span></div>
        <p class="panel-note profile-sub">Earn coins by rolling, with the daily quests and by winning duels. <span class="case-odds" data-tip="${esc(`<b>Coins per roll</b><br>${Object.entries(Shop.COINS).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)} · ${fmt(v)}`).join('<br>')}<br><b>Duel won</b> · +${Shop.DUEL_WIN_COINS}<br><b>Coin rate per day</b><br>Rolls 1–500 · 100%<br>Rolls 501–2,000 · 50%<br>After 2,000 rolls · 20%`)}">How much? ⓘ</span></p>
        <div data-fund-slot></div>
        <div class="shop-tabs" id="shop-tabs" role="tablist">${SHOP_TABS.map(([id, emoji, label]) => `<button role="tab" data-shop-tab="${id}"><i aria-hidden="true">${emoji}</i><span>${label}</span></button>`).join('')}</div>
        <section class="shop-pane" data-shop-pane="limited" hidden>
        <div class="panel limited-panel">
          <div class="panel-head"><h3 class="panel-title">Limited skins</h3><span class="panel-note">for a short time only · once bought, yours forever</span></div>
          <div class="limited-banner" id="limited-banner"><i aria-hidden="true">🦇</i><i aria-hidden="true">🦇</i><i aria-hidden="true">🦇</i><b>🎃 HALLOWEEN EVENT</b><span id="limited-left"></span></div>
          <div class="skin-grid" id="d-limited"><div class="empty">Loading…</div></div>
          <div class="panel-head" style="margin-top:1rem"><h3 class="panel-title">Limited wallpapers</h3><span class="panel-note">animated backgrounds · until October 31</span></div>
          <div class="skin-grid wall-grid" id="d-limited-walls"></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="cases" hidden>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Cases</h3><span class="panel-note">a random skin · the pricier the skin, the rarer</span></div>
          <div class="case-grid" id="d-cases">${Shop.CASES.map(c => {
            // Caisse de fonds d'écran : ses lots se cherchent dans les fonds (Shop.caseItem), avec leurs propres raretés.
            const item = id => Shop.caseItem(c, id), rar = id => Shop.rarityOf(id, c.wall);
            const odds = Shop.caseOdds(c).map(o => `<span style="color:${rar(o.id).color}">■</span> ${item(o.id).emoji} ${item(o.id).name} · ${(o.p * 100).toFixed(1)}%`).join('<br>');
            return `
            <div class="case-tile">
              <div class="case-box" aria-hidden="true">${c.emoji}</div>
              <div class="skin-name"><b>${esc(c.name)}</b><span>${esc(c.desc)}</span></div>
              <div class="case-contents" aria-hidden="true">${Shop.caseOdds(c).map(o => `<i style="--rar:${rar(o.id).color}" title="${esc(item(o.id).name)}"></i>`).join('')}</div>
              <span class="case-odds" data-tip="${esc(`<b>${c.name} odds</b><br>${odds}`)}">Odds ⓘ</span>
              <button class="btn" data-case="${c.id}">🪙 ${fmt(c.price)}</button>
              <button class="btn-roll small case-free" data-case-free="${c.id}" hidden>🔑 Open free</button>
            </div>`;
          }).join('')}</div>
          <p class="panel-note" style="margin:.6rem 0 0">Already own the skin you draw? Part of the case price comes back, more for rarer skins: 50% for a Common up to 90% for a Legendary. Coins only, no real money.</p>
          <p class="panel-note" style="margin:.3rem 0 0">The Wallpaper Case works the same way with animated wallpapers: already own the one you draw? Part of the price comes back too.</p>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="skins" hidden>
        <div class="panel premium-panel" id="d-premium-panel" hidden>
          <div class="panel-head"><h3 class="panel-title">Legendary skins</h3><span class="panel-note">a full animated signature around your number · also plays in duels</span></div>
          <div class="skin-grid premium-grid" id="d-premium"></div>
        </div>
        <div class="panel stats-sep">
          <div class="panel-head"><h3 class="panel-title">Skins</h3><span class="panel-note">how your number looks, on your rolls and in duels</span></div>
          <div class="skin-grid" id="d-skins"></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="speed" hidden>
        <div class="panel" id="d-speed-panel" hidden>
          <div class="panel-head"><h3 class="panel-title">Roll speed</h3><span class="panel-note">a faster reveal, so more rolls per minute</span></div>
          <div id="d-speed"></div>
        </div>
        <div class="panel" id="d-skip-panel">
          <div class="panel-head"><h3 class="panel-title">Skip known badges</h3><span class="panel-note">free · unlocked by playing, not with coins</span></div>
          <div id="d-skip"></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="walls" hidden>
        <div class="panel premium-panel">
          <div class="panel-head"><h3 class="panel-title">Legendary wallpapers</h3><span class="panel-note">they react to every roll you make</span></div>
          <div class="skin-grid wall-grid premium-grid" id="d-premium-walls"></div>
        </div>
        <div class="panel stats-sep">
          <div class="panel-head"><h3 class="panel-title">Wallpapers</h3><span class="panel-note">animated backgrounds for the whole site · only you see yours</span></div>
          <div class="skin-grid wall-grid" id="d-walls"></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="emotes" hidden>
        <div class="panel" id="d-emotes-panel" hidden>
          <div class="panel-head"><h3 class="panel-title">Emotes</h3><span class="panel-note">animated reactions for your duels · everyone sees them</span></div>
          <p class="panel-note" style="margin-top:-.3rem">The six classic emotes are free. These ones move: buy one once and it joins your reaction bar in every duel.</p>
          <div class="skin-grid emote-grid" id="d-emotes"></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="sounds" hidden>
        <div class="panel" id="d-sounds-panel" hidden>
          <div class="panel-head"><h3 class="panel-title">Roll sounds</h3><span class="panel-note">only you hear them · ▶ to listen first</span></div>
          <p class="panel-note" style="margin-top:-.3rem">A sound pack changes the note of each digit and the sound of the rarity reveal. Rarer rolls still sound bigger. The ASMR and Lab skins keep their own digit sounds.</p>
          <div class="skin-grid sound-grid" id="d-sounds"></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="prestige" hidden>
        <div class="panel pr-panel">
          <div class="panel-head"><h3 class="panel-title">Prestige</h3><span class="panel-note">rare titles · limited stock for the whole game · one each</span></div>
          <p class="panel-note" style="margin-top:-.3rem">Show off your coins: a prestige title appears next to your name on the leaderboards, your profile and in duels. When the stock runs out, nobody can buy it again.</p>
          <div class="skin-grid pr-grid" id="d-prestige"><div class="empty">Loading…</div></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="buttons" hidden>
        <div class="panel" id="d-buttons-panel" hidden>
          <div class="panel-head"><h3 class="panel-title">Generate button</h3><span class="panel-note">only you see it · press one to try it</span></div>
          <p class="panel-note" style="margin-top:-.3rem">Your Generate button follows your skin. You can also wear the button of any skin you own, or one of the buttons sold only here.</p>
          <div class="skin-grid gen-grid" id="d-buttons"></div>
        </div>
        </section>
      </div>`;
    // Onglets : une catégorie à la fois, la dernière ouverte est retenue sur cet appareil.
    const openTab = id => {
      const tab = SHOP_TABS.some(x => x[0] === id) ? id : 'skins';
      app.querySelectorAll('[data-shop-pane]').forEach(el => { el.hidden = el.dataset.shopPane !== tab; });
      app.querySelectorAll('[data-shop-tab]').forEach(el => { el.classList.toggle('on', el.dataset.shopTab === tab); el.setAttribute('aria-selected', el.dataset.shopTab === tab); });
      if (Store.settings.shopTab !== tab) Store.setSetting('shopTab', tab);
    };
    $('#shop-tabs').onclick = e => { const b = e.target.closest('[data-shop-tab]'); if (b) openTab(b.dataset.shopTab); };
    openTab(Store.settings.shopTab);
    drawSkip();
    Fund.load();
    drawShop();
  }

  // "Live now", rafraîchi toutes les 30 s tant que l'onglet est visible.
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
    if (!document.hidden) hubTimer = setTimeout(() => { if (currentView === 'duel') drawLive(); }, 30000);
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
    applyShop(state);
    $('#d-coins').textContent = `🪙 ${fmt(state.coins)}`;
    drawButtons(state);
    drawEmotes(state);
    drawPrestige(state);
    drawSounds(state);
    drawWalls(state);
    drawSpeed(state);
    const cases = $('#d-cases');
    // Clés de caisse gagnées avec les niveaux : un bouton « ouvrir gratuitement » sur la caisse correspondante.
    // Sa propre clé d'abord, sinon une clé plus haute qui l'ouvre aussi (une clé Premium ouvre Starter et Fonds).
    document.querySelectorAll('[data-case-free]').forEach(b => {
      const id = b.dataset.caseFree, keys = state.keys || {};
      const k = [id, ...Object.keys(Shop.KEY_OPENS).filter(x => x !== id)].find(x => (Shop.KEY_OPENS[x] || []).includes(id) && keys[x] > 0);
      b.hidden = !k; b.dataset.key = k || '';
      if (k) b.textContent = k === id ? `🔑 Open free (${keys[k]})` : `🔑 Use a ${Shop.caseById.get(k).name.replace(' Case', '')} key (${keys[k]})`;
    });
    if (cases) cases.onclick = e => {
      const free = e.target.closest('[data-case-free]');
      if (free && !free.disabled) { openCase(Shop.caseById.get(free.dataset.caseFree), state, free, free.dataset.key && free.dataset.key !== free.dataset.caseFree ? free.dataset.key : true); return; }
      const btn = e.target.closest('[data-case]');
      if (btn && !btn.disabled) openCase(Shop.caseById.get(btn.dataset.case), state, btn);
    };
    const tile = k => {
      const owned = state.owned.includes(k.id), equipped = state.skin === k.id;
      const button = equipped ? '<span class="skin-state">Equipped</span>'
        : owned ? `<button class="btn" data-skin-equip="${k.id}">Equip</button>`
        // Réservé à une caisse (Infinity) : pas de prix, le bouton mène à l'onglet des caisses.
        : k.caseOnly ? `<button class="btn ghost case-only" data-case-go>${Shop.caseById.get(k.caseOnly).emoji} ${esc(Shop.caseById.get(k.caseOnly).name)} only · ${+(k.chance * 100).toFixed(2)}%</button>`
        : k.until && Date.now() + Room.offset >= Date.parse(k.until) ? '<span class="skin-state">No longer for sale</span>'
        : `<button class="btn${state.coins >= k.price ? '' : ' disabled'}" data-skin-buy="${k.id}">🪙 ${fmt(k.price)}</button>`;
      return `
        <div class="skin-tile${equipped ? ' equipped' : ''}${k.premium ? ' premium' : ''}">
          ${withLever(`<div class="num-card md${skinClass(k.id)}" data-tier="rare">${slotsHTML('235711')}</div>`, k.id)}
          <div class="skin-name"><b>${k.emoji} ${esc(k.name)}</b><span>${esc(k.desc)}</span>${k.idea ? `<span class="skin-idea" title="This player gets 5% of every purchase">💡 Idea by <a href="${profileHref(k.idea)}" data-no-i18n>${esc(k.idea)}</a></span>` : ''}</div>
          <div class="skin-actions">${k.id !== 'classic' ? `<button class="btn ghost" data-skin-preview="${k.id}" title="Preview">▶ Preview</button>` : ''}${button}</div>
        </div>`;
    };
    // Skin Supporter : montré à tout le monde. Qui l'a peut l'équiper ; les autres voient comment l'obtenir.
    const supporterTile = () => {
      const k = Shop.SUPPORTER, owned = state.owned.includes(k.id), equipped = state.skin === k.id;
      return `
        <div class="skin-tile supporter-tile${equipped ? ' equipped' : ''}">
          <div class="num-card md skin-supporter" data-tier="rare">${slotsHTML('235711')}</div>
          <div class="skin-name"><b>${k.emoji} ${esc(k.name)}</b><span>${esc(k.desc)}</span></div>
          <div class="skin-actions"><button class="btn ghost" data-skin-preview="${k.id}" title="Preview">▶ Preview</button>${equipped ? '<span class="skin-state">Equipped</span>' : owned ? `<button class="btn" data-skin-equip="${k.id}">Equip</button>` : '<button class="btn" data-fund>💗 Contribute to get it</button>'}</div>
        </div>`;
    };
    // Skin Fisherman (collab Canne & Dauphins) : montré à tout le monde. Il ne s'achète pas : on l'obtient en se connectant
    // avec le même compte Google sur les deux jeux (api/site.js, action « collab », et api/auth.js).
    const fisherTile = () => {
      const k = Shop.FISHER, owned = state.owned.includes(k.id), equipped = state.skin === k.id;
      return `
        <div class="skin-tile fisher-tile${equipped ? ' equipped' : ''}">
          <div class="num-card md skin-fisher" data-tier="rare">${slotsHTML('235711')}</div>
          <div class="skin-name"><b>${k.emoji} ${esc(k.name)}</b><span>${esc(k.desc)}</span>${owned ? '' : `<ol class="fisher-steps">
            <li>${Store.player.google ? '<span class="fisher-done">✓ Signed in with Google on RNG∞</span>' : '<button class="btn ghost small" data-fish-google>Sign in with Google here</button>'}</li>
            <li>Open Canne &amp; Dauphins and sign in with the <b>same Google account</b></li>
            <li>Come back here: the skin unlocks by itself</li>
          </ol>`}</div>
          <div class="skin-actions"><button class="btn ghost" data-skin-preview="${k.id}" title="Preview">▶ Preview</button>${equipped ? '<span class="skin-state">Equipped</span>' : owned ? `<button class="btn" data-skin-equip="${k.id}">Equip</button>` : '<a class="btn" href="https://pechadophin.vercel.app/" target="_blank" rel="noopener" data-fish-out>🎣 Play Canne &amp; Dauphins</a>'}</div>
        </div>`;
    };
    // Le skin du créateur n'apparaît que chez celui qui le possède, en tête de boutique.
    grid.innerHTML = (state.owned.includes('owner') ? [Shop.OWNER] : []).concat(Shop.SKINS.filter(k => !k.premium && !k.until)).map(tile).join('') + supporterTile() + (Shop.COLLAB_LIVE || state.owned.includes('fisher') ? fisherTile() : '');
    // Retour sur l'onglet après s'être connecté sur Canne & Dauphins : la boutique se relit d'elle-même (une fois), pour
    // que le skin Fisherman apparaisse sans recharger la page.
    if (!state.owned.includes('fisher') && !drawShop.watching) {
      drawShop.watching = true;
      const back = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', back); drawShop.watching = false;
        if (currentView === 'shop') Online.shop().then(st => { if (currentView === 'shop' && st.owned.includes('fisher')) { drawShop(st); toast('🎣 Fisherman skin unlocked!', 3500, 'achv'); } }).catch(() => {});
      };
      document.addEventListener('visibilitychange', back);
    }
    grid.querySelectorAll('[data-fish-google]').forEach(b => b.addEventListener('click', () => openSettings()));
    // Ce lien vers son jeu compte aussi dans l'encadré Collab de la page Owner.
    grid.querySelectorAll('[data-fish-out]').forEach(a => a.addEventListener('click', () => { Online.request('/api/site', { local: true, method: 'POST', keepalive: true, body: JSON.stringify({ action: 'out', to: 'pechadophin' }) }).catch(() => {}); }));
    const premium = $('#d-premium');
    premium.innerHTML = Shop.SKINS.filter(k => k.premium).map(tile).join('');
    $('#d-premium-panel').hidden = false;
    // Skins limités : leur propre onglet, avec le temps qu'il reste ; un skin terminé n'y reste que chez ceux qui l'ont.
    const limited = $('#d-limited'), left = k => { const ms = Date.parse(k.until) - Date.now(); if (ms <= 0) return 'Ended'; const d = Math.floor(ms / 864e5), hh = Math.floor(ms / 36e5) % 24; return d ? `Ends in ${d} day${d > 1 ? 's' : ''} ${hh} h` : `Ends in ${hh} h`; };
    const lim = Shop.SKINS.filter(k => k.until && (Date.now() < Date.parse(k.until) || state.owned.includes(k.id)));
    { const ev = Date.parse('2026-11-01T00:00:00Z'), b = $('#limited-banner'); if (b) { if (Date.now() >= ev) b.hidden = true; else { const ms = ev - Date.now(); $('#limited-left').textContent = window.RNGI18n.t(`Ends after October 31 · ${Math.floor(ms / 864e5)} days ${Math.floor(ms / 36e5) % 24} h left`); } } }
    limited.innerHTML = lim.length ? lim.map(k => tile(k).replace('<div class="skin-name">', `<div class="limited-clock">⏳ ${left(k)}</div><div class="skin-name">`)).join('') : '<div class="empty">No limited skin right now. Come back for the next event!</div>';
    grid.onclick = premium.onclick = limited.onclick = async e => {
      const preview = e.target.closest('[data-skin-preview]');
      if (preview) { previewSkin(preview.dataset.skinPreview); return; }
      if (e.target.closest('[data-case-go]')) { $('#shop-tabs [data-shop-tab="cases"]').click(); window.scrollTo(0, 0); return; }
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

  // ---------------------------------------------------------------- Gamble : roulette et blackjack, avec les pièces du jeu
  // Tout se joue sur le serveur (api/_gamble.js) : le site envoie des mises et des choix, reçoit le résultat et le
  // nouveau solde. Aucun argent réel : les pièces ne s'achètent pas et ne se retirent pas.
  const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const rouletteColor = n => (n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black');
  const Gamble = { chip: 50, bets: {}, busy: false, coins: null, hand: null, tab: 'crash', top: 'winners', side: [false, false], asset: 'btc', tf: '1h', ind: { ma: true, vol: true }, lev: null, levSide: 'long', levX: 5, levSeen: 0, zoom: 90, hover: null, hy: null, mines: 3, mn: null, twLevel: 'normal', tw: null, td: null, cr: null, raf: 0 };
  const gamble = (action, extra) => Online.shopAction(action, undefined, extra);
  // Faces d'un dé à jouer : 3 × 3 emplacements, les points allumés selon la face.
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const dicePips = n => `<span class="dc-pips" data-n="${n}">${Array.from({ length: 9 }, (_, i) => `<i${PIPS[n].includes(i) ? ' class="on"' : ''}></i>`).join('')}</span>`;
  // Teddy Roulette (idée de d_alex) : un canon à confettis de fête (cône rayé sur roulettes, barillet de 6 chambres)
  // pointé sur un nounours. Tout est dessiné ici, sans image : le barillet tourne d'un cran à chaque clic, et sur
  // « BOOM » le nounours se retrouve couvert de confettis (calque .td-splat).
  const teddySVG = () => {
    const ch = Array.from({ length: 6 }, (_, i) => { const a = i * Math.PI / 3; return `<circle class="td-ch" data-ch="${i}" cx="${(62 + 19 * Math.cos(a)).toFixed(1)}" cy="${(100 + 19 * Math.sin(a)).toFixed(1)}" r="7"/>`; }).join('');
    const COLORS = ['#f472b6', '#facc15', '#38bdf8', '#4ade80', '#a78bfa', '#fb923c'];
    let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const splat = Array.from({ length: 46 }, (_, i) => { const x = 222 + rnd() * 86, y = 46 + rnd() * 124, c = COLORS[i % 6]; return i % 3 ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="6" height="3.4" rx="1" fill="${c}" transform="rotate(${Math.round(rnd() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>` : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${c}"/>`; }).join('');
    return `<svg class="td-svg" viewBox="0 0 340 185" role="img" aria-label="A confetti popper aimed at a teddy bear">
      <defs><pattern id="td-stripes" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="14" height="14" fill="#f9a8d4"/><rect width="7" height="14" fill="#fde68a"/></pattern></defs>
      <ellipse class="td-floor" cx="170" cy="176" rx="160" ry="7"/>
      <g class="td-cannon">
        <rect x="34" y="128" width="84" height="12" rx="6" fill="#c4b5fd" stroke="#6d28d9" stroke-width="3"/>
        <circle cx="50" cy="150" r="14" fill="#f9a8d4" stroke="#6d28d9" stroke-width="3"/><circle cx="50" cy="150" r="4" fill="#6d28d9"/>
        <circle cx="102" cy="150" r="14" fill="#f9a8d4" stroke="#6d28d9" stroke-width="3"/><circle cx="102" cy="150" r="4" fill="#6d28d9"/>
        <g class="td-barrel">
          <path d="M66 90 L156 66 L156 134 L66 110 Z" fill="url(#td-stripes)" stroke="#6d28d9" stroke-width="3" stroke-linejoin="round"/>
          <ellipse cx="156" cy="100" rx="9" ry="34" fill="#fef3c7" stroke="#6d28d9" stroke-width="3"/>
          <ellipse cx="156" cy="100" rx="4" ry="22" fill="#fbcfe8"/>
        </g>
        <g class="td-drum"><circle cx="62" cy="100" r="31" fill="#e9d5ff" stroke="#6d28d9" stroke-width="3"/>${ch}<circle cx="62" cy="100" r="5" fill="#6d28d9"/></g>
        <path class="td-aim" d="M90 86 l8 14 l-8 14" fill="none" stroke="#fef3c7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <g class="td-bear">
        <circle cx="234" cy="52" r="15" fill="#c8905e"/><circle cx="234" cy="52" r="8" fill="#f5d0a9"/>
        <circle cx="296" cy="52" r="15" fill="#c8905e"/><circle cx="296" cy="52" r="8" fill="#f5d0a9"/>
        <ellipse cx="226" cy="138" rx="10" ry="17" fill="#b67d4f" transform="rotate(20 226 138)"/>
        <ellipse cx="304" cy="138" rx="10" ry="17" fill="#b67d4f" transform="rotate(-20 304 138)"/>
        <ellipse cx="265" cy="142" rx="38" ry="31" fill="#c8905e"/><ellipse cx="265" cy="148" rx="23" ry="19" fill="#f5d0a9"/>
        <ellipse cx="243" cy="170" rx="14" ry="8" fill="#b67d4f"/><ellipse cx="287" cy="170" rx="14" ry="8" fill="#b67d4f"/>
        <circle cx="265" cy="80" r="37" fill="#c8905e"/>
        <ellipse cx="265" cy="93" rx="17" ry="12.5" fill="#f5d0a9"/>
        <ellipse cx="265" cy="87" rx="6.5" ry="4.5" fill="#3b2314"/>
        <path class="td-smile" d="M258 96 Q265 103 272 96" fill="none" stroke="#3b2314" stroke-width="2.4" stroke-linecap="round"/>
        <ellipse class="td-oh" cx="265" cy="99" rx="4" ry="5" fill="#3b2314"/>
        <g class="td-eyes"><circle cx="251" cy="74" r="4.8" fill="#2b1a10"/><circle cx="279" cy="74" r="4.8" fill="#2b1a10"/><circle cx="252.6" cy="72.4" r="1.6" fill="#fff"/><circle cx="280.6" cy="72.4" r="1.6" fill="#fff"/></g>
        <path class="td-happy" d="M245 75 Q251 69 257 75 M273 75 Q279 69 285 75" fill="none" stroke="#2b1a10" stroke-width="2.6" stroke-linecap="round"/>
        <ellipse cx="242" cy="90" rx="6.5" ry="3.6" fill="#fda4af" opacity=".75"/><ellipse cx="288" cy="90" rx="6.5" ry="3.6" fill="#fda4af" opacity=".75"/>
        <path d="M265 116 l-14 -7 v14 z M265 116 l14 -7 v14 z" fill="#f472b6" stroke="#be185d" stroke-width="1.6" stroke-linejoin="round"/><circle cx="265" cy="116" r="3.6" fill="#be185d"/>
        <g class="td-splat">${splat}</g>
      </g>
    </svg>`;
  };
  const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  // Une carte : recto (deux index et la couleur en grand) et verso ; `fresh` la fait glisser depuis le sabot et se retourner.
  const cardHTML = (c, fresh, i = 0) => `<span class="pcard${c ? (c.s === 1 || c.s === 2 ? ' red' : '') : ' down'}${fresh ? ' deal' : ''}" style="--i:${i}" data-no-i18n><span class="pc-in"><span class="pc-front">${c ? `<b>${RANKS[c.r]}<i>${SUITS[c.s]}</i></b><em>${c.r > 10 ? RANKS[c.r] : SUITS[c.s]}</em><b class="low">${RANKS[c.r]}<i>${SUITS[c.s]}</i></b>` : ''}</span><span class="pc-back"></span></span></span>`;
  // Bandeau « en direct » du casino : tout l'argent qui y est passé (mises prises, gains versés, tous joueurs confondus
  // depuis l'ouverture) et les dernières manches.
  // Relu toutes les 20 s tant que la page est affichée. Ma propre manche n'y apparaît qu'après 7 s : le bandeau ne doit
  // pas annoncer le résultat avant la fin de l'animation (roue, bille, cartes).
  const GAME_ICONS = { crash: '🚀', mines: '💣', tower: '🗼', keno: '🎱', dice: '🎲', teddy: '🧸', plinko: '🔻', roulette: '🎡', bj: '🃏', slots: '🎰', flip: '🪙' };
  let houseTimer = 0;
  async function drawHouse() {
    clearTimeout(houseTimer);
    const box = $('#g-live');
    if (currentView !== 'gamble' || !box) return;
    if (!document.hidden) {
      try {
        const h = await Online.house();
        if (currentView !== 'gamble' || !box.isConnected) return;
        const now = Date.now() + Room.offset, mine = Store.player.name;
        const feed = h.feed.filter(r => !(r.name === mine && now - r.t < 7000)).slice(0, 5);
        const html = `
          <span class="g-live-dot" aria-hidden="true"></span><span class="eyebrow">Live</span>
          <span class="g-live-tot">took <b class="mono down">🪙 ${fmt(h.took)}</b></span>
          <span class="g-live-tot">gave <b class="mono up">🪙 ${fmt(h.gave)}</b></span>
          <span class="g-live-feed">${feed.map(r => `<span class="g-live-row ${r.net > 0 ? 'up' : 'down'}">${GAME_ICONS[r.game] || '🎲'} <span data-no-i18n>${esc(r.name)}</span> <b class="mono">${r.net > 0 ? '+' : '−'}${fmt(Math.abs(r.net))}</b></span>`).join('')}</span>`;
        if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
        box.title = `All the coins that went through the casino, all players together: bets taken and winnings paid · ${fmt(h.rounds)} rounds played`;
        box.hidden = false;
      } catch (err) { /* hors ligne : le bandeau garde ses derniers chiffres */ }
    }
    houseTimer = setTimeout(drawHouse, 20000);
  }
  // Classement du casino : trois tableaux (gagnants, perdants, plus gros parieurs), relus chaque minute tant que
  // l'onglet Gamble est ouvert. Hors du top 10, le joueur voit sa propre ligne et son rang en dessous.
  let topTimer = 0, topData = null;
  async function drawCasinoTop(fetchNow) {
    const box = $('#g-top-list');
    if (currentView !== 'gamble' || !box) return;
    if (fetchNow) {
      clearTimeout(topTimer);
      if (!document.hidden) { try { topData = await Online.casinoTop(); } catch (err) { /* hors ligne : on garde le dernier classement */ } }
      topTimer = setTimeout(() => drawCasinoTop(true), 60000);
      if (currentView !== 'gamble' || !box.isConnected) return;
    }
    if (!topData) { box.innerHTML = '<div class="empty">Leaderboard unavailable right now.</div>'; return; }
    const key = Gamble.top, list = topData[key] || [], mine = topData.mine && topData.mine[key];
    const money = v => `🪙 ${v >= 1e5 ? compact(v) : fmt(v)}`;
    const row = x => `
      <div class="g-top-row${x.me ? ' me' : ''}">
        <span class="g-top-rank">${{ 1: '🥇', 2: '🥈', 3: '🥉' }[x.rank] || '#' + x.rank}</span>
        <a class="player-link" href="${profileHref(x.name)}" data-no-i18n>${esc(x.name)}</a>
        <span class="mono g-top-rounds" title="${fmt(x.rounds)}">${x.rounds >= 1e5 ? compact(x.rounds) : fmt(x.rounds)}</span>
        <span class="mono" title="🪙 ${fmt(x.bet)}">${money(x.bet)}</span>
        <b class="mono ${x.net >= 0 ? 'up' : 'down'}" title="${x.net >= 0 ? '+' : '−'}${fmt(Math.abs(x.net))}">${x.net >= 0 ? '+' : '−'}${money(Math.abs(x.net)).slice(3)}</b>
      </div>`;
    const EMPTY = { winners: 'Nobody is ahead of the house yet.', losers: 'Nobody has lost coins yet.', gamblers: 'Nobody has gambled yet.' };
    box.innerHTML = list.length ? `
      <div class="g-top-row head"><span>#</span><span>Player</span><span class="g-top-rounds">Rounds</span><span>Wagered</span><span>${key === 'gamblers' ? 'Net' : key === 'winners' ? 'Won' : 'Lost'}</span></div>
      ${list.map(row).join('')}${mine ? `<div class="lb-gap">···</div>${row(mine)}` : ''}` : `<div class="empty">${EMPTY[key]}</div>`;
  }
  // Onglets des jeux du casino, dans l'ordre choisi par le joueur (idée de jia jun, 2026-10-24 : flèches ou glisser-
  // déposer en mode « Reorder », gardé dans Store.settings.casinoOrder). Un jeu ajouté plus tard se range à la fin.
  const G_TABS = [['crash', '🚀', 'Crash'], ['flip', '🪙', 'Coin flip'], ['mines', '💣', 'Mines'], ['tower', '🗼', 'Tower'], ['keno', '🎱', 'Keno'], ['dice', '🎲', 'Dice'], ['teddy', '🧸', 'Teddy Roulette'], ['plinko', '🔻', 'Plinko'], ['slots', '🎰', 'Slots'], ['roulette', '🎡', 'Roulette'], ['bj', '🃏', 'Blackjack'], ['btc', '📈', 'Crypto']];
  const gTabOrder = () => {
    const ids = G_TABS.map(t => t[0]), saved = Array.isArray(Store.settings.casinoOrder) ? Store.settings.casinoOrder.filter(id => ids.includes(id)) : [];
    return [...new Set(saved)].concat(ids.filter(id => !saved.includes(id)));
  };
  const gTabsHTML = edit => gTabOrder().map(id => {
    const [, e, label] = G_TABS.find(t => t[0] === id), on = id === Gamble.tab ? ' on' : '';
    return edit
      ? `<div class="g-tab${on}" data-game-tab="${id}" draggable="true"><i>${e}</i><span>${label}</span><span class="g-moves"><button type="button" class="g-move" data-move="-1" aria-label="Move ${label} left">◀</button><button type="button" class="g-move" data-move="1" aria-label="Move ${label} right">▶</button></span></div>`
      : `<button class="g-tab${on}" data-game-tab="${id}"><i>${e}</i><span>${label}</span></button>`;
  }).join('');

  function renderGamble() {
    currentView = 'gamble';
    const bet = (t, label, cls = '') => `<button class="rbet ${cls}" data-bet="${t}"><span>${label}</span><b class="mono"></b></button>`;
    app.innerHTML = `
      <div class="page page-wide">
        <div id="tn-banner-slot"></div>
        <div class="g-head"><h1 class="page-title">Gamble</h1><span class="g-wallet"><span class="eyebrow">Your coins</span><b class="mono" id="g-coins">${Store.settings.coins != null ? `🪙 ${fmt(Store.settings.coins)}` : '🪙 …'}</b></span></div>
        <p class="panel-note profile-sub">Play with the coins you earn in the game. No real money: coins cannot be bought or cashed out. Bets from ${fmt(10)} to ${fmt(1000)} coins, unlocked after 30 rolls.</p>
        <div class="g-live" id="g-live" hidden></div>
        <div class="g-tabs" id="g-tabs">${gTabsHTML(false)}</div>
        <div class="g-order-row"><button type="button" class="g-order-reset" id="g-order-reset" hidden>Reset order</button><button type="button" class="g-order-btn" id="g-order" aria-pressed="false">↕ Reorder games</button></div>
        <div class="g-bet"><span class="eyebrow">Bet</span><div class="gchips" id="g-chips">${[1, 5, 10, 50, 100, 250, 500, 1000].map(c => `<button class="gchip${c === Gamble.chip ? ' on' : ''}${c < 10 ? ' pk-only' : ''}" data-chip="${c}">${c >= 1000 ? '1K' : c}</button>`).join('')}</div></div>
        <div class="g-stage">
          <div class="panel g-game" data-game="crash">
            <div class="panel-head"><h3 class="panel-title">Crash</h3><span class="panel-note">cash out before it crashes</span></div>
            <div class="seg cr-mode" id="cr-mode" role="tablist"><button data-mode="fish">🎣 Fishing</button><button data-mode="rocket">🚀 Rocket</button></div>
            <div class="crash-screen" id="cr-screen" data-state="idle" data-mode="fish"><canvas id="cr-canvas" width="640" height="260"></canvas><canvas id="fish-canvas" width="256" height="144" aria-label="A fisherman on a pier"></canvas><b class="mono" id="cr-mult">1.00×</b></div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="cr-go">Start</button></div>
            <p class="panel-note g-result" id="cr-result"></p>
            <p class="panel-note fish-collab" id="fish-collab">🎣 Collab with <a href="https://pechadophin.vercel.app/" target="_blank" rel="noopener" data-no-i18n>Canne &amp; Dauphins</a> by L'taleshy &amp; cocobat · the deeper the line, the bigger the dolphin, but watch out for the shark</p>
          </div>
          <div class="panel g-game" data-game="flip">
            <div class="panel-head"><h3 class="panel-title">Coin flip</h3><span class="panel-note">double or nothing · ×1.9 per win · up to 7 wins in a row</span></div>
            <div class="cf-stage"><div class="cf-coin" id="cf-coin" data-side="heads"><div class="cf-face cf-heads"><span>∞</span></div><div class="cf-face cf-tails"><span>🎲</span></div></div></div>
            <div class="cf-ladder" id="cf-ladder"></div>
            <div class="actions cf-actions"><button class="btn-roll small" data-cf="heads">∞ Heads</button><button class="btn-roll small" data-cf="tails">🎲 Tails</button></div>
            <div class="actions" style="justify-content:center"><button class="btn" id="cf-cash" hidden></button></div>
            <p class="panel-note g-result" id="cf-result"></p>
          </div>
          <div class="panel g-game" data-game="mines">
            <div class="panel-head"><h3 class="panel-title">Mines</h3><span class="panel-note">every safe tile raises the payout · one mine ends it · max win 250×</span></div>
            <div class="mn-setup"><span class="eyebrow">Mines</span><div class="seg" id="mn-count">${[1, 3, 5, 10, 24].map(m => `<button data-v="${m}" class="${m === Gamble.mines ? 'on' : ''}">${m}</button>`).join('')}</div><b class="mono" id="mn-mult"></b></div>
            <div class="mn-grid" id="mn-grid">${Array.from({ length: 25 }, (_, i) => `<button class="mn-cell" data-cell="${i}" disabled></button>`).join('')}</div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="mn-go">Start</button></div>
            <p class="panel-note g-result" id="mn-result"></p>
          </div>
          <div class="panel g-game" data-game="tower">
            <div class="panel-head"><h3 class="panel-title">Tower</h3><span class="panel-note">climb 8 floors · one bomb per floor · cash out any time</span></div>
            <div class="mn-setup tw-setup"><span class="eyebrow">Difficulty</span><div class="seg" id="tw-level">${[['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']].map(([v, l]) => `<button data-v="${v}" class="${v === Gamble.twLevel ? 'on' : ''}">${l}</button>`).join('')}</div><b class="mono" id="tw-mult"></b></div>
            <div class="tw-tower" id="tw-tower"></div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="tw-go">Start</button></div>
            <p class="panel-note g-result" id="tw-result"></p>
          </div>
          <div class="panel g-game" data-game="keno">
            <div class="panel-head"><h3 class="panel-title">Keno</h3><span class="panel-note">pick 1 to 10 numbers · 10 are drawn · max win 1000×</span></div>
            <div class="kn-table">
              <div class="kn-setup"><span class="kn-count mono" id="kn-count"></span><span class="kn-tools"><button class="btn small" id="kn-random">🎲 Random pick</button><button class="btn small" id="kn-clear">Clear</button></span></div>
              <div class="kn-board" id="kn-board">${Array.from({ length: 40 }, (_, i) => `<button class="kn-cell mono" data-n="${i + 1}" aria-pressed="false" data-no-i18n>${i + 1}</button>`).join('')}</div>
              <div class="kn-pays" id="kn-pays"></div>
            </div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="kn-go">Play</button></div>
            <p class="panel-note g-result" id="kn-result"></p>
          </div>
          <div class="panel g-game" data-game="dice">
            <div class="panel-head"><h3 class="panel-title">Dice</h3><span class="panel-note">a 100-sided die · pick your odds · or guess a 6-sided die for 5.82×</span></div>
            <div class="seg dc-mode" id="dc-mode" role="tablist"><button data-mode="under">⬇️ Roll under</button><button data-mode="over">⬆️ Roll over</button><button data-mode="d6">🎲 Guess the die</button></div>
            <div class="dc-table" id="dc-table" data-mode="under">
              <div class="dc-view dc-100">
                <div class="dc-die mono" id="dc-die" data-no-i18n>50</div>
                <div class="dc-track" id="dc-track"><div class="dc-zone" id="dc-zone"></div><div class="dc-mark mono" id="dc-mark" hidden data-no-i18n></div></div>
                <input type="range" class="dc-range" id="dc-target" min="3" max="96" step="1" value="50" aria-label="Target">
                <div class="dc-scale mono" aria-hidden="true" data-no-i18n><span>1</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
                <p class="dc-rule" id="dc-rule"></p>
              </div>
              <div class="dc-view dc-6">
                <div class="dc-cube" id="dc-cube"></div>
                <div class="dc-faces" id="dc-faces" role="group" aria-label="Pick a face">${[1, 2, 3, 4, 5, 6].map(n => `<button class="dc-face" data-face="${n}" aria-pressed="false" aria-label="Face ${n}">${dicePips(n)}</button>`).join('')}</div>
              </div>
              <div class="dc-stats"><span><i>Win chance</i><b class="mono" id="dc-chance"></b></span><span><i>Multiplier</i><b class="mono" id="dc-mult"></b></span><span><i>Payout</i><b class="mono" id="dc-pay"></b></span></div>
            </div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="dc-go">Roll</button></div>
            <p class="panel-note g-result" id="dc-result"></p>
          </div>
          <div class="panel g-game" data-game="teddy">
            <div class="panel-head"><h3 class="panel-title">Teddy Roulette</h3><span class="panel-note">a confetti popper with 6 chambers · one goes BOOM · every click raises the payout · cash out any time</span></div>
            <div class="td-scene" id="td-scene" data-state="idle">${teddySVG()}<div class="td-pop" id="td-pop" aria-live="polite"></div><div class="td-burst" id="td-burst" aria-hidden="true"></div></div>
            <div class="td-ladder" id="td-ladder"></div>
            <div class="actions cf-actions"><button class="btn-roll small" id="td-go">Start</button><button class="btn" id="td-cash" hidden></button></div>
            <p class="panel-note g-result" id="td-result"></p>
          </div>
          <div class="panel g-game" data-game="slots">
            <div class="panel-head"><h3 class="panel-title">Slots</h3><span class="panel-note">three of a kind pays the most · 7 7 7 pays 250×</span></div>
            <div class="sm-machine" id="sm-machine" data-state="idle">
              <div class="sm-crown"><span class="sm-bulbs" aria-hidden="true">${'<i></i>'.repeat(11)}</span><b class="sm-name" data-no-i18n>LUCKY ∞</b><span class="sm-bulbs" aria-hidden="true">${'<i></i>'.repeat(11)}</span></div>
              <div class="sm-body">
                <div class="sm-window">
                  ${[0, 1, 2].map(r => `<div class="sm-reel" data-reel="${r}"><div class="sm-strip"></div></div>`).join('')}
                  <div class="sm-payline" aria-hidden="true"></div>
                  <div class="sm-glass" aria-hidden="true"></div>
                </div>
                <button class="sm-lever" id="sm-lever" aria-label="Pull the lever"><span class="sm-arm"><i></i></span></button>
              </div>
              <div class="sm-tray"><span class="sm-win mono" id="sm-win" data-no-i18n></span></div>
            </div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="sm-go">Spin</button></div>
            <p class="panel-note g-result" id="sm-result"></p>
            <div class="sm-pays" id="sm-pays"></div>
          </div>
          <div class="panel g-game" data-game="plinko">
            <div class="panel-head"><h3 class="panel-title">Plinko</h3><span class="panel-note" id="pk-note">12 rows · the edges pay the most</span></div>
            <div class="pk-risk" id="pk-risk" role="group" aria-label="Risk"><button class="pk-risk-btn on" data-risk="normal">Normal</button><button class="pk-risk-btn" data-risk="high" title="15 rows: up to 1000×, but the middle pays very little. Max 100 coins per ball">🔥 High risk · up to 1000×</button></div>
            <div class="pk-board" id="pk-board"><canvas id="pk-canvas" width="520" height="360"></canvas></div>
            <div class="pk-slots" id="pk-slots"></div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="pk-go">Drop</button></div>
            <p class="panel-note pk-hint">click as fast as you like, or hold the button</p>
            <p class="panel-note g-result" id="pk-result"></p>
          </div>
          <div class="panel g-game" data-game="roulette">
            <div class="panel-head"><h3 class="panel-title">Roulette</h3><span class="panel-note">one zero · red or black pays 2× · a number pays 36×</span></div>
            <div class="rw-scene"><div class="rw-tilt"><canvas id="rw-canvas" width="520" height="520"></canvas></div><div class="rw-readout" id="r-wheel" data-color="idle"><span class="mono" id="r-number">?</span></div></div>
            <div class="rbets" id="r-bets">
              ${bet('red', 'Red', 'red')}${bet('black', 'Black', 'black')}${bet('even', 'Even')}${bet('odd', 'Odd')}${bet('low', '1–18')}${bet('high', '19–36')}
              ${bet('d1', '1–12')}${bet('d2', '13–24')}${bet('d3', '25–36')}
              <span class="rbet number"><input class="input mono" id="r-pick" type="number" min="0" max="36" placeholder="0–36" aria-label="Number"><button class="btn" data-bet="n">+ Number</button><b class="mono" id="r-nbets"></b></span>
            </div>
            <div class="actions"><button class="btn ghost" id="r-clear">Clear</button><button class="btn-roll small" id="r-spin">Spin</button></div>
            <p class="panel-note g-result" id="r-result"></p>
          </div>
          <div class="panel g-game" data-game="bj">
            <div class="panel-head"><h3 class="panel-title">Blackjack</h3><span class="panel-note">dealer stands on 17 · blackjack pays 3 to 2</span></div>
            <div class="bj-table" id="bj-table"></div>
            <div class="actions" id="bj-actions"></div>
            <p class="panel-note g-result" id="bj-result"></p>
          </div>
          <div class="panel g-game" data-game="btc">
            <div class="panel-head"><h3 class="panel-title">Crypto</h3><span class="panel-note">the real price, live · 1 coin = 1 $</span></div>
            <div id="btc-body"><div class="empty">Loading…</div></div>
            <p class="panel-note btc-note">Game coins only: this is not real crypto, nothing can be bought or cashed out with real money. Buying and selling each cost 1%.</p>
          </div>
        </div>
        <div class="panel g-top stats-sep" id="g-top">
          <div class="panel-head"><h3 class="panel-title">Casino leaderboard</h3><span class="panel-note">all time · refreshed every minute</span></div>
          <div class="g-top-tabs" role="tablist">${[['winners', '💰', 'Biggest winners'], ['losers', '📉', 'Biggest losers'], ['gamblers', '🎲', 'Biggest gamblers']].map(([id, e, label]) => `<button role="tab" data-top="${id}" class="${id === Gamble.top ? 'on' : ''}"><i>${e}</i><span>${label}</span></button>`).join('')}</div>
          <div id="g-top-list"><div class="empty">Loading…</div></div>
        </div>
      </div>`;
    drawHouse();
    drawCasinoTop(true);
    $('#g-top').addEventListener('click', e => { const b = e.target.closest('[data-top]'); if (!b) return; Gamble.top = b.dataset.top; $('#g-top').querySelectorAll('[data-top]').forEach(x => x.classList.toggle('on', x === b)); drawCasinoTop(false); });
    const showCoins = c => { if (c != null) { Gamble.coins = c; Store.setSetting('coins', c); HdrCoins.set(c); } if ($('#g-coins') && Gamble.coins != null) { $('#g-coins').textContent = `🪙 ${fmt(Gamble.coins)}`; } };
    if (Store.player.name) Online.shop().then(st => { if (currentView === 'gamble' && !Gamble.busy) showCoins(st.coins); }).catch(() => {});
    drawTourneyBanner($('#tn-banner-slot'));
    // Pièces gagnées ailleurs (un autre onglet qui tire, des quêtes) : le solde se relit quand la page revient au premier
    // plan, et toutes les 10 s tant qu'elle est affichée, seulement entre deux parties (signalé par un joueur le 2026-10-16).
    const idle = () => currentView === 'gamble' && !Gamble.busy && !Gamble.cr && !Gamble.cf && !(Gamble.pk && (Gamble.pk.balls.length || Gamble.pk.queue || Gamble.pk.sending)) && !(Gamble.hand && !Gamble.hand.done && !Gamble.hand.idle) && !(Gamble.tw && !Gamble.tw.done && !Gamble.tw.idle) && !(Gamble.td && !Gamble.td.done && !Gamble.td.idle);
    const refreshCoins = () => { if (!Store.player.name || document.hidden || !idle()) return; Online.shop().then(st => { if (idle()) showCoins(st.coins); }).catch(() => {}); };
    clearInterval(Gamble.coinTimer); Gamble.coinTimer = setInterval(() => { if (currentView !== 'gamble') { clearInterval(Gamble.coinTimer); return; } refreshCoins(); }, 10000);
    if (!Gamble.coinWatch) { Gamble.coinWatch = true; document.addEventListener('visibilitychange', () => refreshCoins()); window.addEventListener('focus', () => refreshCoins()); }
    const fail = err => toast(err.status === 422 || err.status === 400 ? err.message : err.status === 429 ? 'Too fast, try again in a second' : 'Gamble unavailable right now, try again');
    // ---- roulette : la roue européenne (ordre réel des cases), dessinée à plat puis inclinée en CSS
    const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
    const rw = $('#rw-canvas').getContext('2d'), RC = 260, SEG = (Math.PI * 2) / 37;
    let wheelAngle = Gamble.wheelAngle || 0;
    const drawWheel = (wa, ball) => {
      rw.clearRect(0, 0, 520, 520);
      const ring = (r, fill) => { rw.beginPath(); rw.arc(RC, RC, r, 0, 7); rw.fillStyle = fill; rw.fill(); };
      const wood = rw.createRadialGradient(RC, RC, 200, RC, RC, 258); wood.addColorStop(0, '#3b1d0a'); wood.addColorStop(.5, '#7a4318'); wood.addColorStop(1, '#2a1406');
      ring(258, wood); ring(232, '#1a0f08');
      const track = rw.createRadialGradient(RC, RC, 196, RC, RC, 232); track.addColorStop(0, '#5a3413'); track.addColorStop(1, '#8a5524'); ring(230, track);
      rw.save(); rw.translate(RC, RC); rw.rotate(wa);
      WHEEL.forEach((n, i) => {
        const a0 = i * SEG - SEG / 2 - Math.PI / 2;
        rw.beginPath(); rw.moveTo(0, 0); rw.arc(0, 0, 196, a0, a0 + SEG); rw.closePath();
        rw.fillStyle = n === 0 ? '#15803d' : RED_NUMBERS.has(n) ? '#b91c1c' : '#141416'; rw.fill();
        rw.strokeStyle = '#d4a84a'; rw.lineWidth = 1.2; rw.stroke();
        rw.save(); rw.rotate(i * SEG); rw.fillStyle = '#fff'; rw.font = '700 15px Inter, sans-serif'; rw.textAlign = 'center'; rw.fillText(String(n), 0, -170); rw.restore();
      });
      rw.beginPath(); rw.arc(0, 0, 150, 0, 7); rw.strokeStyle = '#d4a84a'; rw.lineWidth = 2; rw.stroke();
      const cone = rw.createRadialGradient(-20, -24, 6, 0, 0, 112); cone.addColorStop(0, '#a26a2c'); cone.addColorStop(.7, '#5b3311'); cone.addColorStop(1, '#2f1a08');
      rw.beginPath(); rw.arc(0, 0, 112, 0, 7); rw.fillStyle = cone; rw.fill();
      for (let k = 0; k < 4; k++) { rw.save(); rw.rotate(k * Math.PI / 2); const g = rw.createLinearGradient(0, -6, 0, 6); g.addColorStop(0, '#fff3c4'); g.addColorStop(1, '#a16207'); rw.fillStyle = g; rw.fillRect(14, -4, 70, 8); rw.beginPath(); rw.arc(88, 0, 9, 0, 7); rw.fill(); rw.restore(); }
      const hub = rw.createRadialGradient(-6, -8, 2, 0, 0, 24); hub.addColorStop(0, '#fff8d6'); hub.addColorStop(1, '#a16207'); rw.beginPath(); rw.arc(0, 0, 22, 0, 7); rw.fillStyle = hub; rw.fill();
      rw.restore();
      if (ball) { const bx = RC + Math.cos(ball.a) * ball.r, by = RC + Math.sin(ball.a) * ball.r; rw.beginPath(); rw.arc(bx + 3, by + 4, 9, 0, 7); rw.fillStyle = 'rgba(0,0,0,.4)'; rw.fill(); const bg = rw.createRadialGradient(bx - 3, by - 3, 1, bx, by, 9); bg.addColorStop(0, '#fff'); bg.addColorStop(1, '#b8bcc4'); rw.beginPath(); rw.arc(bx, by, 9, 0, 7); rw.fillStyle = bg; rw.fill(); }
    };
    drawWheel(wheelAngle, Gamble.ball || null);
    const spinWheel = n => new Promise(done => {
      const T = 5600, t0 = performance.now(), w0 = wheelAngle, wTurn = Math.PI * 2 * 2.6;
      const wEnd = w0 + wTurn, target = wEnd + WHEEL.indexOf(n) * SEG - Math.PI / 2; // où la case tirée s'arrêtera
      const b0 = target + Math.PI * 2 * 7.5 + Math.random() * .2; // la bille part loin en avant et revient à contresens
      let lastTick = 0;
      const frame = now => {
        const k = Math.min(1, (now - t0) / T), e = 1 - Math.pow(1 - k, 3);
        wheelAngle = w0 + wTurn * e;
        const be = 1 - Math.pow(1 - k, 2.4), drop = Math.max(0, (k - .62) / .38), bounce = drop > 0 && drop < 1 ? Math.abs(Math.sin(drop * Math.PI * 3)) * (1 - drop) * 12 : 0;
        // tant qu'elle roule sur la piste, la bille est libre ; dans le dernier tiers elle se cale sur la roue
        const free = b0 - (b0 - target) * be - (wEnd - wheelAngle) * (1 - drop), a = k < 1 ? free : target;
        const ball = { a, r: 214 - 40 * (1 - Math.pow(1 - drop, 2)) + bounce };
        Gamble.ball = ball; Gamble.wheelAngle = wheelAngle;
        drawWheel(wheelAngle, ball);
        const step = Math.floor(a / SEG); if (step !== lastTick && k < .97) { lastTick = step; if (k > .25 || step % 3 === 0) Sound.tick({ soft: k < .7 }); }
        if (k < 1 && currentView === 'gamble') requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
    const drawBets = () => {
      document.querySelectorAll('#r-bets [data-bet]').forEach(b => { const v = Gamble.bets[b.dataset.bet]; const out = b.querySelector('b'); if (out) out.textContent = v ? fmt(v) : ''; b.classList.toggle('on', !!v); });
      const nums = Object.entries(Gamble.bets).filter(([k]) => k.startsWith('n:'));
      $('#r-nbets').textContent = nums.map(([k, v]) => `${k.slice(2)}: ${fmt(v)}`).join(' · ');
      const total = Object.values(Gamble.bets).reduce((x, v) => x + v, 0);
      $('#r-spin').textContent = total ? `Spin · ${fmt(total)}` : 'Spin';
    };
    $('#g-chips').addEventListener('click', e => { const c = e.target.closest('[data-chip]'); if (!c) return; Gamble.chip = Number(c.dataset.chip); document.querySelectorAll('.gchip').forEach(x => x.classList.toggle('on', x === c)); });
    $('#r-bets').addEventListener('click', e => {
      const b = e.target.closest('[data-bet]');
      if (!b || Gamble.busy) return;
      let key = b.dataset.bet;
      if (key === 'n') { const v = Number($('#r-pick').value); if (!Number.isInteger(v) || v < 0 || v > 36 || $('#r-pick').value === '') { toast('Pick a number from 0 to 36'); return; } key = `n:${v}`; }
      const total = Object.values(Gamble.bets).reduce((x, v) => x + v, 0);
      if (total + Gamble.chip > 1000) { toast('Maximum 1,000 coins per spin'); return; }
      if (!Gamble.bets[key] && Object.keys(Gamble.bets).length >= 12) { toast('At most 12 different bets per spin'); return; }
      Gamble.bets[key] = (Gamble.bets[key] || 0) + Gamble.chip;
      drawBets();
    });
    $('#r-clear').addEventListener('click', () => { if (!Gamble.busy) { Gamble.bets = {}; drawBets(); } });
    $('#r-spin').addEventListener('click', async () => {
      const bets = Object.entries(Gamble.bets).map(([k, a]) => (k.startsWith('n:') ? { t: 'n', v: Number(k.slice(2)), a } : { t: k, a }));
      if (!bets.length) { toast('Place a bet first'); return; }
      if (Gamble.busy) return;
      Gamble.busy = true;
      const wheel = $('#r-wheel'), num = $('#r-number');
      try {
        const res = await gamble('roulette', { bets });
        // La roue tourne dans un sens, la bille dans l'autre ; elle ralentit, descend et se loge dans la case tirée.
        wheel.dataset.color = 'spin'; num.textContent = '';
        await spinWheel(res.n);
        if (currentView !== 'gamble') { Store.setSetting('coins', res.coins); return; } // parti pendant le tour : le solde reste juste ailleurs
        num.textContent = res.n; wheel.dataset.color = res.color; replay(wheel, 'landed');
        const net = res.win - res.total;
        $('#r-result').textContent = res.win ? `${res.n} · you get ${fmt(res.win)} coins (${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))})` : `${res.n} · no win this time (−${fmt(res.total)})`;
        if (net > 0) { Sound.play('reveal', { small: 1 }); FX.celebrate(net >= res.total * 5 ? 'epic' : 'uncommon', wheel); }
        showCoins(res.coins);
      } catch (err) { fail(err); } finally { Gamble.busy = false; }
    });
    // ---- blackjack
    const BJ_BONUS = { triple7: '7-7-7', five: '5-card 21', six: '6-card 21', seven: '7-card 21' };
    const BJ_TEXT = { blackjack: 'Blackjack!', win: 'You win', push: 'Push: your bet comes back', lose: 'Dealer wins', bust: 'Bust' };
    const drawHand = h => {
      Gamble.hand = h;
      const seen = h && !h.idle && Gamble.bjSeen && Gamble.bjKey === h.bet + ':' + h.player[0].r + h.player[0].s ? Gamble.bjSeen : { p: 0, d: 0 };
      if (h && !h.idle) Gamble.bjKey = h.bet + ':' + h.player[0].r + h.player[0].s;
      const playing = h && !h.idle && !h.done;
      $('#bj-table').innerHTML = !h || h.idle ? '<div class="empty">Place a bet and deal.</div>' : `
        <div class="bj-shoe" aria-hidden="true"></div>
        <div class="bj-row"><span class="eyebrow">Dealer${h.done ? ` · ${h.dealerValue}` : ''}</span><div class="bj-cards">${h.dealer.map((c, i) => cardHTML(c, i >= seen.d, i - seen.d)).join('')}${h.done ? '' : cardHTML(null, seen.d < 2, 1)}</div></div>
        <div class="bj-felt-text" aria-hidden="true">BLACKJACK PAYS 3 TO 2</div>
        <div class="bj-felt-bonus">BONUS · 7-7-7 ×7 · 21 IN 5 CARDS ×1 · 6 CARDS ×3 · 7+ CARDS ×10</div>
        <div class="bj-row"><span class="eyebrow">You · ${h.value}</span><div class="bj-cards">${h.player.map((c, i) => cardHTML(c, i >= seen.p, i - seen.p)).join('')}</div><span class="bj-stack" data-no-i18n>${fmt(h.bet)}</span></div>`;
      Gamble.bjSeen = h && !h.idle ? { p: h.player.length, d: h.done ? h.dealer.length : 1 } : { p: 0, d: 0 };
      // Assurance (as visible) : moitié de la mise ou toute la mise, ou non merci ; jouer la main la refuse aussi.
      const half = h && Math.max(10, Math.floor(h.bet / 2));
      const insure = playing && h.canInsure ? `<span class="bj-ins" title="The dealer shows an ace. Insurance pays 2 to 1 if the dealer has blackjack"><b>🛡️ Insurance?</b><button class="chip" data-bj="insure" data-amt="${half}">Half · ${fmt(half)}</button>${h.bet > half ? `<button class="chip" data-bj="insure" data-amt="${h.bet}">All · ${fmt(h.bet)}</button>` : ''}<button class="chip" data-bj="noinsure">No thanks</button></span>` : '';
      $('#bj-actions').innerHTML = playing
        ? insure + `<button class="btn-roll small" data-bj="hit">Hit</button><button class="btn" data-bj="stand">Stand</button>${h.canDouble ? '<button class="btn" data-bj="double">Double</button>' : ''}`
        : `<span class="bj-side" title="Your card is the same card rank as the dealer's face-up card (his first card, not the hidden one): 8×. A 10 and a king do not match. Same suit too: 24×. Both your cards match: ×1.5">${['1st', '2nd'].map((n, i) => `<button class="chip${Gamble.side[i] ? ' on' : ''}" data-side="${i}">🎯 Match ${n} card</button>`).join('')}</span><button class="btn-roll small" data-bj="deal">Deal · ${fmt(Gamble.chip * (1 + Gamble.side.filter(Boolean).length))}</button>`;
      // Résultat des mises annexes, morceau par morceau à travers la traduction (la phrase entière ne figure pas au dictionnaire).
      const tr = x => (window.RNGI18n && window.RNGI18n.t ? window.RNGI18n.t(x) : x);
      const sideText = h && !h.idle && h.sides ? ' · ' + h.sides.map((x, i) => (x.bet ? `${tr(i ? 'Match 2nd' : 'Match 1st')}: ${x.win ? `+${fmt(x.win)}${x.kind === 'suited' ? ` (${tr('same suit!')})` : ''}` : tr('no match')}` : '')).filter(Boolean).join(' · ') : '';
      const insText = h && !h.idle && h.insurance ? ` · ${tr('Insurance')}: ${h.insWin ? `+${fmt(h.insWin)}` : `−${fmt(h.insurance)}`}` : '';
      const bonusText = h && h.bonus ? ` · ${tr(BJ_BONUS[h.bonus.kind])} ${tr('bonus')}: +${fmt(h.bonus.win)}` : '';
      $('#bj-result').textContent = (h && h.done && !h.idle ? `${BJ_TEXT[h.result]} · ${h.win ? `you get ${fmt(h.win)} coins` : `−${fmt(h.bet)}`}` : playing ? `Bet: ${fmt(h.bet)} coins` : '') + bonusText + insText + sideText;
      if (h) showCoins(h.coins);
    };
    // Changer de pièce redessine le bouton « Deal » ; sans le solde de la dernière main, qui a pu changer depuis
    // (il remettait à l'écran le solde d'avant les parties jouées entre-temps).
    $('#g-chips').addEventListener('click', () => { if (!Gamble.hand || Gamble.hand.done) drawHand(Gamble.hand ? { ...Gamble.hand, coins: null } : null); });
    $('#bj-actions').addEventListener('click', async e => {
      const sb = e.target.closest('[data-side]');
      if (sb) { Gamble.side[sb.dataset.side] = !Gamble.side[sb.dataset.side]; drawHand(Gamble.hand ? { ...Gamble.hand, coins: null } : null); return; }
      const b = e.target.closest('[data-bj]');
      if (!b || Gamble.busy) return;
      Gamble.busy = true;
      try {
        const h = await gamble('bj', { move: b.dataset.bj, bet: Gamble.chip, amount: b.dataset.amt ? Number(b.dataset.amt) : undefined, side: b.dataset.bj === 'deal' ? Gamble.side.map(on => (on ? Gamble.chip : 0)) : undefined });
        if (h.sides && h.sides.some(x => x.win) && b.dataset.bj === 'deal') { Sound.play('reveal', { small: 1 }); FX.celebrate(h.sides.some(x => x.kind === 'suited') ? 'epic' : 'uncommon', $('#bj-table')); }
        Sound.play('lock', { i: h.player.length, soft: 1 });
        drawHand(h);
        if (h.bonus) { Sound.play('reveal', {}); FX.celebrate('epic', $('#bj-table')); }
        else if (h.done && (h.result === 'win' || h.result === 'blackjack')) { Sound.play('reveal', { small: 1 }); FX.celebrate(h.result === 'blackjack' ? 'epic' : 'uncommon', $('#bj-table')); }
      } catch (err) { fail(err); } finally { Gamble.busy = false; }
    });
    // ---- bitcoin : vrai prix (api/_btc.js), relu toutes les 20 s tant que l'onglet est ouvert
    const btcFmt = sats => (sats / 1e8).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
    // Graphique en bougies, façon TradingView : bougies vertes / rouges, volume en bas, moyennes mobiles 20 et 50,
    // ligne du dernier prix, réticule qui donne l'ouverture, le haut, le bas et la clôture. Molette ou pincement : zoom.
    const TFS = [['5m', '5m'], ['15m', '15m'], ['1h', '1H'], ['6h', '6H'], ['1d', '1D']];
    const sma = (rows, n) => rows.map((_, i) => (i + 1 < n ? null : rows.slice(i + 1 - n, i + 1).reduce((x, r) => x + r[4], 0) / n));
    const pfmt = v => (v >= 1000 ? fmt(Math.round(v)) : v.toFixed(2));
    function drawCandles(cv, rows, o) {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
      const dark = document.documentElement.classList.contains('dark') || matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
      const GRID = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)', INK = dark ? '#9ca3af' : '#6b7280', UP = '#26a69a', DOWN = '#ef5350';
      const n = Math.max(20, Math.min(rows.length, o.count)), show = rows.slice(-n), ma20 = sma(rows, 20).slice(-n), ma50 = sma(rows, 50).slice(-n);
      const R = 58, B = 18, plotW = W - R, volH = o.vol ? (H - B) * .18 : 0, priceH = H - B - volH - 6;
      let lo = Math.min(...show.map(r => r[3])), hi = Math.max(...show.map(r => r[2]));
      if (o.ma) for (const v of [...ma20, ...ma50]) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      const pad = (hi - lo) * .06 || 1; lo -= pad; hi += pad;
      const Y = v => 4 + (1 - (v - lo) / (hi - lo)) * (priceH - 4), step = plotW / n, bw = Math.max(1, step * .68), X = i => i * step + step / 2;
      c.font = '10px ' + getComputedStyle(document.body).fontFamily; c.textBaseline = 'middle';
      // grille et prix à droite
      for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4, y = Y(v); c.strokeStyle = GRID; c.beginPath(); c.moveTo(0, y); c.lineTo(plotW, y); c.stroke(); c.fillStyle = INK; c.fillText(pfmt(v), plotW + 6, y); }
      // heures en bas
      const lab = t => { const d = new Date(t * 1000); return o.tf === '1d' ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : o.tf === '6h' ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.getHours() + 'h' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
      c.textAlign = 'center'; const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 80))));
      for (let i = 0; i < n; i += every) { c.fillStyle = INK; const tx = lab(show[i][0]), half = c.measureText(tx).width / 2; if (X(i) - half >= 0 && X(i) + half <= plotW) c.fillText(tx, X(i), H - B / 2); c.strokeStyle = GRID; c.beginPath(); c.moveTo(X(i), 0); c.lineTo(X(i), H - B); c.stroke(); }
      c.textAlign = 'left';
      // volume
      if (o.vol) { const vmax = Math.max(...show.map(r => r[5])) || 1; show.forEach((r, i) => { const h = (r[5] / vmax) * volH; c.fillStyle = (r[4] >= r[1] ? UP : DOWN) + '55'; c.fillRect(X(i) - bw / 2, H - B - h, bw, h); }); }
      // bougies
      show.forEach((r, i) => {
        const up = r[4] >= r[1], col = up ? UP : DOWN, x = X(i);
        c.strokeStyle = col; c.lineWidth = 1; c.beginPath(); c.moveTo(Math.round(x) + .5, Y(r[2])); c.lineTo(Math.round(x) + .5, Y(r[3])); c.stroke();
        const y1 = Y(Math.max(r[1], r[4])), y2 = Y(Math.min(r[1], r[4])); c.fillStyle = col; c.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
      });
      // moyennes mobiles
      if (o.ma) for (const [line, col] of [[ma20, '#f5a623'], [ma50, '#7b61ff']]) { c.strokeStyle = col; c.lineWidth = 1.4; c.beginPath(); let on = false; line.forEach((v, i) => { if (v == null) return; if (on) c.lineTo(X(i), Y(v)); else { c.moveTo(X(i), Y(v)); on = true; } }); c.stroke(); }
      // positions ouvertes : entrée, stop loss, take profit, liquidation
      for (const [v, col, name] of o.lines || []) { if (!(v > lo && v < hi)) continue; const y = Y(v); c.setLineDash(name === 'Entry' ? [] : [6, 4]); c.strokeStyle = col; c.lineWidth = 1; c.beginPath(); c.moveTo(0, y); c.lineTo(plotW, y); c.stroke(); c.setLineDash([]); c.fillStyle = col; c.fillText(name, 4, y - 7); }
      // dernier prix
      const last = o.price || show[show.length - 1][4], ly = Y(last), lup = last >= show[show.length - 1][1];
      c.setLineDash([3, 3]); c.strokeStyle = lup ? UP : DOWN; c.beginPath(); c.moveTo(0, ly); c.lineTo(plotW, ly); c.stroke(); c.setLineDash([]);
      c.fillStyle = lup ? UP : DOWN; c.fillRect(plotW, ly - 8, R, 16); c.fillStyle = '#fff'; c.fillText(pfmt(last), plotW + 6, ly);
      // réticule
      if (o.hover != null && o.hover >= 0 && o.hover < n) {
        const r = show[o.hover], x = X(o.hover); c.strokeStyle = INK; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H - B); c.stroke();
        if (o.hy != null && o.hy < priceH) { c.beginPath(); c.moveTo(0, o.hy); c.lineTo(plotW, o.hy); c.stroke(); const v = lo + (1 - (o.hy - 4) / (priceH - 4)) * (hi - lo); c.setLineDash([]); c.fillStyle = dark ? '#374151' : '#e5e7eb'; c.fillRect(plotW, o.hy - 8, R, 16); c.fillStyle = dark ? '#fff' : '#111'; c.fillText(pfmt(v), plotW + 6, o.hy); }
        c.setLineDash([]);
        return r;
      }
      return show[show.length - 1];
    }
    const btcChart = () => `
      <div class="tv-bar">
        <div class="tv-group">${TFS.map(([k, l]) => `<button class="tv-btn${Gamble.tf === k ? ' on' : ''}" data-tf="${k}">${l}</button>`).join('')}</div>
        <div class="tv-group"><button class="tv-btn${Gamble.ind.ma ? ' on' : ''}" data-ind="ma" title="Moving averages 20 and 50">MA</button><button class="tv-btn${Gamble.ind.vol ? ' on' : ''}" data-ind="vol" title="Volume">Vol</button></div>
      </div>
      <div class="tv-ohlc mono" id="tv-ohlc"></div>
      <div class="tv-wrap"><canvas class="tv-chart" id="tv-chart"></canvas><div class="tv-legend">${Gamble.ind.ma ? '<span style="color:#f5a623">MA 20</span><span style="color:#7b61ff">MA 50</span>' : ''}</div></div>`;
    const paintChart = () => {
      const cv = $('#tv-chart'), data = Gamble.cndl;
      if (!cv || !data || data.asset !== Gamble.asset || data.tf !== Gamble.tf) { if (cv) { const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); } return; }
      const lines = ((Gamble.lev && Gamble.lev.positions) || []).filter(p => p.a === Gamble.asset).flatMap(p => [[p.entry, '#9ca3af', 'Entry'], [p.liq, '#ef5350', 'Liq.'], ...(p.sl ? [[p.sl, '#f59e0b', 'SL']] : []), ...(p.tp ? [[p.tp, '#26a69a', 'TP']] : [])]);
      const r = drawCandles(cv, data.rows, { lines, count: Gamble.zoom, ma: Gamble.ind.ma, vol: Gamble.ind.vol, tf: Gamble.tf, price: Gamble.btc && Gamble.btc.price, hover: Gamble.hover, hy: Gamble.hy });
      const o = $('#tv-ohlc'); if (o && r) { const ch = ((r[4] - r[1]) / r[1]) * 100; o.innerHTML = `O <b>${pfmt(r[1])}</b> H <b>${pfmt(r[2])}</b> L <b>${pfmt(r[3])}</b> C <b class="${ch >= 0 ? 'up' : 'down'}">${pfmt(r[4])} (${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%)</b>`; }
    };
    const loadCandles = async () => {
      const asset = Gamble.asset, tf = Gamble.tf;
      try { const d = await Online.request(`/api/shop?candles=1&asset=${asset}&tf=${tf}`); if (asset === Gamble.asset && tf === Gamble.tf) { Gamble.cndl = { ...d, asset }; paintChart(); } }
      catch (err) { const o = $('#tv-ohlc'); if (o) o.textContent = 'The chart is unavailable right now.'; }
    };
    // ---- effet de levier (api/_lever.js) : long ou short, 2× 3× 5×, stop loss / take profit facultatifs
    const T = x => (window.RNGI18n && window.RNGI18n.t ? window.RNGI18n.t(x) : x);
    const WHY = { take: '🎯 Take profit', stop: '🛑 Stop loss', liquidated: '💥 Liquidated', manual: 'Closed' };
    const leverHTML = () => {
      const L = Gamble.lev, d = Gamble.btc;
      if (!L || !d) return '';
      const mine = L.positions, hist = L.history.slice(0, 5);
      return `
        <div class="lev">
          <div class="lev-head"><h4>⚡ Leverage</h4><span class="panel-note">bet on a rise (long) or a fall (short) with ${L.leverages.join('×, ')}× · you can never lose more than your margin</span></div>
          <form class="lev-form" id="lev-form">
            <div class="seg lev-side"><button type="button" data-lev-side="long" class="${Gamble.levSide === 'long' ? 'on' : ''}">▲ Long</button><button type="button" data-lev-side="short" class="${Gamble.levSide === 'short' ? 'on' : ''}">▼ Short</button></div>
            <div class="lev-x">${L.leverages.map(x => `<button type="button" class="chip${Gamble.levX === x ? ' on' : ''}" data-lev-x="${x}">${x}×</button>`).join('')}</div>
            <label class="lev-field"><span>Margin</span><input class="input mono" name="margin" type="number" inputmode="numeric" min="${L.min}" max="${L.max}" value="100" required></label>
            <label class="lev-field"><span>Stop loss</span><input class="input mono" name="sl" type="number" inputmode="decimal" step="any" placeholder="optional"></label>
            <label class="lev-field"><span>Take profit</span><input class="input mono" name="tp" type="number" inputmode="decimal" step="any" placeholder="optional"></label>
            <button class="btn-roll small lev-go ${Gamble.levSide}">${Gamble.levSide === 'long' ? '▲ Open long' : '▼ Open short'} ${Gamble.levX}× ${d.sym}</button>
          </form>
          ${mine.length ? `<div class="lev-list">${mine.map(p => { const pnl = p.value - p.m, pct = (pnl / p.m) * 100; return `
            <div class="lev-pos" data-pos="${p.id}">
              <div class="lev-pos-top"><b class="${p.side}">${p.side === 'long' ? '▲ Long' : '▼ Short'} ${p.lev}× ${p.a.toUpperCase()}</b><span class="mono ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl))} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)</span><button class="btn" data-lev-close="${p.id}">Close</button></div>
              <div class="lev-pos-info mono" data-no-i18n>${T('Margin')} 🪙 ${fmt(p.m)} · ${T('Entry')} ${pfmt(p.entry)} · ${T('Now')} ${p.price ? pfmt(p.price) : '–'} · <span class="down">Liq. ${pfmt(p.liq)}</span></div>
              <form class="lev-edit" data-lev-edit="${p.id}"><input class="input mono" name="sl" type="number" step="any" placeholder="Stop loss" value="${p.sl || ''}" aria-label="Stop loss"><input class="input mono" name="tp" type="number" step="any" placeholder="Take profit" value="${p.tp || ''}" aria-label="Take profit"><button class="btn ghost">Save</button></form>
            </div>`; }).join('')}</div>` : ''}
          ${hist.length ? `<div class="lev-hist"><span class="eyebrow">Last closed</span>${hist.map(h => `<div class="mono"><span>${WHY[h.why] || h.why}</span><span>${h.side === 'long' ? '▲' : '▼'} ${h.lev}× ${h.a.toUpperCase()}</span><span class="${h.payout >= h.m ? 'up' : 'down'}">${h.payout >= h.m ? '+' : '−'}${fmt(Math.abs(h.payout - h.m))}</span></div>`).join('')}</div>` : ''}
        </div>`;
    };
    // Une position fermée toute seule (stop, objectif, liquidation) depuis la dernière fois : annoncée une fois.
    const setLever = L => {
      const fresh = L.history.filter(h => h.t > Gamble.levSeen && h.why !== 'manual');
      if (Gamble.levSeen && fresh.length) for (const h of fresh) toast(`${WHY[h.why]}: ${h.side === 'long' ? 'long' : 'short'} ${h.lev}× ${h.a.toUpperCase()} closed, you get 🪙 ${fmt(h.payout)}`, 5000, h.payout >= h.m ? 'achv' : '');
      Gamble.levSeen = Math.max(Gamble.levSeen || 1, ...L.history.map(h => h.t));
      Gamble.lev = L;
      const box = $('#lev-box'); if (box) box.innerHTML = leverHTML();
      paintChart();
    };
    // Prix en direct : le flux public de Coinbase (chaque échange, plusieurs fois par seconde), seulement pour l'affichage.
    // Le prix de la dernière bougie, le prix affiché et les gains des positions bougent en direct ; les achats et ventes
    // se font toujours au prix lu par le serveur (moins de 3 s).
    const Live = { ws: null, p: {}, raf: 0, retry: 0 };
    const liveStart = () => {
      if (Live.ws || typeof WebSocket === 'undefined') return;
      try {
        const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
        Live.ws = ws;
        ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker'] }));
        ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.type !== 'ticker' || !m.price) return; const a = m.product_id === 'ETH-USD' ? 'eth' : 'btc'; Live.p[a] = Number(m.price); if (a === Gamble.asset && !Live.raf) Live.raf = requestAnimationFrame(liveTick); };
        ws.onclose = () => { Live.ws = null; if (currentView === 'gamble' && Gamble.tab === 'btc') Live.retry = setTimeout(liveStart, 3000); };
        ws.onerror = () => { try { ws.close(); } catch (e) { /* déjà fermée */ } };
      } catch (e) { Live.ws = null; }
    };
    const liveStop = () => { clearTimeout(Live.retry); if (Live.ws) { Live.ws.onclose = null; try { Live.ws.close(); } catch (e) { /* déjà fermée */ } Live.ws = null; } };
    const liveTick = () => {
      Live.raf = 0;
      const P = Live.p[Gamble.asset], d = Gamble.btc;
      if (!P || !d || currentView !== 'gamble' || Gamble.tab !== 'btc') { if (currentView !== 'gamble') liveStop(); return; }
      const el = $('#btc-body .btc-price');
      if (el) { const prev = d.livePrice || d.price; el.textContent = `🪙 ${P >= 1000 ? fmt(Math.round(P)) : P.toFixed(2)}`; if (prev && P !== prev) { el.classList.remove('tick-up', 'tick-down'); void el.offsetWidth; el.classList.add(P > prev ? 'tick-up' : 'tick-down'); } d.livePrice = P; }
      // la dernière bougie suit le prix ; une nouvelle commence quand son temps est écoulé
      const c = Gamble.cndl;
      if (c && c.asset === Gamble.asset && c.rows.length) {
        const g = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 }[c.tf], now = Date.now() / 1000, last = c.rows[c.rows.length - 1];
        if (now >= last[0] + g) c.rows.push([Math.floor(now / g) * g, last[4], Math.max(last[4], P), Math.min(last[4], P), P, 0]);
        else { last[4] = P; last[2] = Math.max(last[2], P); last[3] = Math.min(last[3], P); }
        Gamble.btc.price = P; paintChart();
      }
      // gains des positions à effet de levier, en direct
      for (const p of (Gamble.lev && Gamble.lev.positions) || []) {
        if (p.a !== Gamble.asset) continue;
        const v = Math.max(0, Math.floor(p.m + p.m * p.lev * (p.side === 'short' ? -1 : 1) * (P / p.entry - 1) - p.m * p.lev * .002)), pnl = v - p.m, row = $(`#btc-body [data-pos="${p.id}"] .lev-pos-top span`);
        if (row) { row.textContent = `${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl))} (${pnl >= 0 ? '+' : ''}${((pnl / p.m) * 100).toFixed(1)}%)`; row.className = `mono ${pnl >= 0 ? 'up' : 'down'}`; }
      }
    };
    async function drawBtc(fetchNow) {
      clearTimeout(Gamble.btcTimer);
      const box = $('#btc-body');
      if (!box || currentView !== 'gamble' || Gamble.tab !== 'btc' && !fetchNow) return;
      if (fetchNow || !Gamble.btc || Gamble.btc.asset !== Gamble.asset) { try { Gamble.btc = await Online.request(`/api/shop?btc=1&asset=${Gamble.asset}&me=${Store.player.id}`); loadCandles(); if (Store.player.name) gamble('lever', { move: 'state' }).then(setLever).catch(() => {}); } catch (err) { if (!Gamble.btc) { box.innerHTML = '<div class="empty">The Bitcoin price is unavailable right now.</div>'; } } }
      Gamble.btcTimer = setTimeout(() => { if (currentView === 'gamble' && Gamble.tab === 'btc' && !document.hidden) drawBtc(true); else if (currentView === 'gamble') Gamble.btcTimer = setTimeout(() => drawBtc(true), 20000); }, 20000);
      const d = Gamble.btc;
      if (!d || !$('#btc-body')) return;
      if (d.coins != null) showCoins(d.coins);
      const day = Gamble.cndl && Gamble.cndl.asset === d.asset && Gamble.cndl.tf === '1h' ? Gamble.cndl.rows.slice(-24)[0] : null, first = day ? day[1] : d.hist.length ? d.hist[0][1] : d.price, change = d.price && first ? ((d.price - first) / first) * 100 : 0;
      const profit = d.value != null ? d.value - d.cost : 0, keep = $('#btc-buy') ? $('#btc-buy').value : '100';
      box.innerHTML = `
        <div class="tv-assets">${[['btc', '₿ Bitcoin'], ['eth', 'Ξ Ethereum']].map(([k, l]) => `<button class="chip${Gamble.asset === k ? ' on' : ''}" data-asset="${k}" data-no-i18n>${l}</button>`).join('')}</div>
        <div class="btc-top"><span class="btc-price mono">${d.price ? `🪙 ${d.price >= 1000 ? fmt(Math.round(d.price)) : d.price.toFixed(2)}` : '—'}</span><span class="btc-unit" data-no-i18n>${window.RNGI18n ? window.RNGI18n.t('for 1') : 'for 1'} ${d.sym}</span>${d.hist.length > 1 || day ? `<span class="btc-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}% · 24 h</span>` : ''}</div>
        ${btcChart()}
        <div class="btc-own">
          <div><span class="eyebrow">You own</span><b class="mono" data-no-i18n>${btcFmt(d.sats)} ${d.sym}</b></div>
          <div><span class="eyebrow">Worth now</span><b class="mono">🪙 ${fmt(d.value || 0)}</b></div>
          <div><span class="eyebrow">Profit</span><b class="mono ${profit >= 0 ? 'up' : 'down'}">${d.sats ? `${profit >= 0 ? '+' : '−'}${fmt(Math.abs(profit))}` : '–'}</b></div>
        </div>
        <div class="btc-trade">
          <form id="btc-buy-form"><input class="input mono" id="btc-buy" type="number" inputmode="numeric" min="${d.min}" max="${d.max}" step="1" value="${esc(keep)}" aria-label="Coins to spend"><button class="btn-roll small">Buy</button></form>
          <div class="btc-presets">${[100, 1000, 10000].map(v => `<button class="chip" data-btc-amt="${v}">🪙 ${v >= 1000 ? `${v / 1000}K` : v}</button>`).join('')}<button class="chip" data-btc-amt="max">Max</button></div>
          <div class="btc-sell">${[[25, '25%'], [50, '50%'], [100, 'Sell all']].map(([k, l]) => `<button class="btn${k === 100 ? '' : ' ghost'}" data-btc-sell="${k}"${d.sats ? '' : ' disabled'}>${l}</button>`).join('')}</div>
        </div>
        <p class="panel-note g-result" id="btc-result">${Gamble.btcMsg || ''}</p>
        <div id="lev-box">${leverHTML()}</div>`;
      paintChart();
      if (Live.p[Gamble.asset] && !Live.raf) Live.raf = requestAnimationFrame(liveTick);
      const cv = $('#tv-chart');
      if (cv) {
        const at = ev => { const r = cv.getBoundingClientRect(), p = ev.touches ? ev.touches[0] : ev, n = Math.max(20, Math.min((Gamble.cndl && Gamble.cndl.rows.length) || 0, Gamble.zoom)); Gamble.hover = Math.floor(((p.clientX - r.left) / Math.max(1, r.width - 58)) * n); Gamble.hy = p.clientY - r.top; paintChart(); };
        cv.addEventListener('mousemove', at); cv.addEventListener('touchmove', at, { passive: true }); cv.addEventListener('touchstart', at, { passive: true });
        cv.addEventListener('mouseleave', () => { Gamble.hover = null; Gamble.hy = null; paintChart(); });
        cv.addEventListener('wheel', ev => { ev.preventDefault(); Gamble.zoom = Math.max(20, Math.min(300, Math.round(Gamble.zoom * (ev.deltaY > 0 ? 1.15 : .87)))); paintChart(); }, { passive: false });
      }
    }
    $('#btc-body').addEventListener('click', async e => {
      const as = e.target.closest('[data-asset]'), tf = e.target.closest('[data-tf]'), ind = e.target.closest('[data-ind]');
      if (as && as.dataset.asset !== Gamble.asset) { Gamble.asset = as.dataset.asset; Gamble.btcMsg = ''; Gamble.hover = null; drawBtc(true); return; }
      if (tf) { Gamble.tf = tf.dataset.tf; Gamble.hover = null; $('#btc-body').querySelectorAll('[data-tf]').forEach(b => b.classList.toggle('on', b === tf)); paintChart(); loadCandles(); return; }
      if (ind) { Gamble.ind[ind.dataset.ind] = !Gamble.ind[ind.dataset.ind]; ind.classList.toggle('on'); const lg = $('#btc-body .tv-legend'); if (lg) lg.innerHTML = Gamble.ind.ma ? '<span style="color:#f5a623">MA 20</span><span style="color:#7b61ff">MA 50</span>' : ''; paintChart(); return; }
      const ls = e.target.closest('[data-lev-side]'), lx = e.target.closest('[data-lev-x]'), lc = e.target.closest('[data-lev-close]');
      if (ls || lx) { if (ls) Gamble.levSide = ls.dataset.levSide; if (lx) Gamble.levX = Number(lx.dataset.levX); const f = $('#lev-form'), keep = f ? Object.fromEntries(new FormData(f)) : {}; $('#lev-box').innerHTML = leverHTML(); const g = $('#lev-form'); if (g) for (const [k, v] of Object.entries(keep)) g.elements[k].value = v; return; }
      if (lc) { if (Gamble.busy) return; Gamble.busy = true; try { const L = await gamble('lever', { move: 'close', id: lc.dataset.levClose }); const h = L.closed; Gamble.levSeen = Math.max(Gamble.levSeen, h ? h.t : 0); setLever(L); if (h) toast(`Closed: you get 🪙 ${fmt(h.payout)}`, 3500, h.payout >= h.m ? 'achv' : ''); Online.shop().then(st => showCoins(st.coins)).catch(() => {}); } catch (err) { fail(err); } finally { Gamble.busy = false; } return; }
      const amt = e.target.closest('[data-btc-amt]'), sell = e.target.closest('[data-btc-sell]');
      if (amt) { $('#btc-buy').value = amt.dataset.btcAmt === 'max' ? Math.max(0, Math.min(Gamble.btc.max, Gamble.coins || 0)) : amt.dataset.btcAmt; return; }
      if (!sell || Gamble.busy) return;
      const k = Number(sell.dataset.btcSell), sats = Gamble.btc.sats;
      Gamble.busy = true;
      try { Gamble.btc = await gamble('btc', k === 100 ? { asset: Gamble.asset, move: 'sell', all: true } : { asset: Gamble.asset, move: 'sell', sats: Math.floor(sats * k / 100) }); Gamble.btcMsg = `Sold ${btcFmt(Gamble.btc.done.sats)} ${Gamble.btc.sym} for 🪙 ${fmt(Gamble.btc.done.coins)}`; Sound.play('lock', { i: 4 }); drawBtc(); }
      catch (err) { fail(err); } finally { Gamble.busy = false; }
    });
    $('#btc-body').addEventListener('submit', async e => {
      const lf = e.target.closest('#lev-form'), le = e.target.closest('[data-lev-edit]');
      if (lf || le) {
        e.preventDefault();
        if (Gamble.busy) return;
        const f = Object.fromEntries(new FormData(lf || le)), num = v => (v === '' || v == null ? null : Number(v));
        Gamble.busy = true;
        try {
          const L = lf ? await gamble('lever', { move: 'open', asset: Gamble.asset, side: Gamble.levSide, lev: Gamble.levX, margin: Math.floor(Number(f.margin)), sl: num(f.sl), tp: num(f.tp) }) : await gamble('lever', { move: 'edit', id: le.dataset.levEdit, sl: num(f.sl), tp: num(f.tp) });
          setLever(L); toast(lf ? `${Gamble.levSide === 'long' ? '▲ Long' : '▼ Short'} ${Gamble.levX}× opened` : 'Saved', 2500);
          Online.shop().then(st => showCoins(st.coins)).catch(() => {});
        } catch (err) { fail(err); } finally { Gamble.busy = false; }
        return;
      }
      e.preventDefault();
      if (Gamble.busy) return;
      const coins = Math.floor(Number($('#btc-buy').value));
      Gamble.busy = true;
      try { Gamble.btc = await gamble('btc', { asset: Gamble.asset, move: 'buy', coins }); Gamble.btcMsg = `Bought ${btcFmt(Gamble.btc.done.sats)} ${Gamble.btc.sym} for 🪙 ${fmt(Gamble.btc.done.coins)}`; Sound.play('lock', { i: 4 }); drawBtc(); }
      catch (err) { fail(err); } finally { Gamble.busy = false; }
    });
    // ---- onglets des jeux
    const showTab = id => {
      // Les pièces de 1 et 5 n'existent qu'au Plinko : ailleurs elles disparaissent, et la mise remonte à 10.
      $('#g-chips').dataset.game = id;
      if (id !== 'plinko' && Gamble.chip < 10) $('#g-chips .gchip[data-chip="10"]').click();
      const bet = document.querySelector('.g-bet'); if (bet) bet.hidden = id === 'btc';
      if (id === 'btc') { drawBtc(true); liveStart(); } else { clearTimeout(Gamble.btcTimer); liveStop(); }
      Gamble.tab = id; document.querySelectorAll('.g-tab').forEach(b => b.classList.toggle('on', b.dataset.gameTab === id)); document.querySelectorAll('.g-game').forEach(g => { g.hidden = g.dataset.game !== id; }); };
    // Mode « Reorder » : chaque onglet a ses flèches ◀ ▶ (au doigt comme à la souris) et se glisse-dépose sur ordinateur.
    let editing = false, dragId = null;
    const drawTabs = () => { $('#g-tabs').innerHTML = gTabsHTML(editing); $('#g-tabs').classList.toggle('editing', editing); };
    const saveOrder = order => { Store.setSetting('casinoOrder', order); drawTabs(); };
    const moveTab = (id, to) => { const o = gTabOrder().filter(x => x !== id); o.splice(Math.max(0, Math.min(o.length, to)), 0, id); saveOrder(o); };
    $('#g-order').addEventListener('click', () => {
      editing = !editing; drawTabs();
      $('#g-order').textContent = editing ? '✓ Done' : '↕ Reorder games'; $('#g-order').setAttribute('aria-pressed', String(editing));
      $('#g-order-reset').hidden = !editing;
    });
    $('#g-order-reset').addEventListener('click', () => saveOrder(G_TABS.map(t => t[0])));
    $('#g-tabs').addEventListener('click', e => {
      const mv = e.target.closest('[data-move]');
      if (mv) { const id = mv.closest('[data-game-tab]').dataset.gameTab; moveTab(id, gTabOrder().indexOf(id) + Number(mv.dataset.move)); return; }
      const b = e.target.closest('[data-game-tab]'); if (b && !Gamble.busy) showTab(b.dataset.gameTab);
    });
    $('#g-tabs').addEventListener('dragstart', e => { const t = e.target.closest('[data-game-tab]'); if (!editing || !t) return; dragId = t.dataset.gameTab; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* vieux navigateurs */ } });
    $('#g-tabs').addEventListener('dragover', e => { if (editing && dragId) e.preventDefault(); });
    $('#g-tabs').addEventListener('drop', e => {
      const t = e.target.closest('[data-game-tab]'); if (!editing || !dragId || !t) return;
      e.preventDefault();
      const r = t.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2, o = gTabOrder().filter(x => x !== dragId);
      o.splice(o.indexOf(t.dataset.gameTab) + (after ? 1 : 0), 0, dragId); dragId = null; saveOrder(o);
    });
    $('#g-tabs').addEventListener('dragend', () => { dragId = null; });
    showTab(Gamble.tab);
    const say = (el, win, bet, text) => { el.textContent = text; el.dataset.won = win > bet ? 'yes' : win === bet ? 'even' : 'no'; };
    // ---- plinko : la bille suit le chemin tiré par le serveur, un clou toutes les 110 ms
    const pk = $('#pk-canvas').getContext('2d'), PW = 520, PH = 360;
    // Deux plateaux : Normal (12 rangées) et High risk (15 rangées, 1000× aux bords ; mêmes tables que api/_gamble.js).
    const PK_TABLES = { normal: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33], high: [1000, 130, 26, 5, 2, 0.8, 0.3, 0.2, 0.2, 0.3, 0.8, 2, 5, 26, 130, 1000] };
    let ROWS = 12, GAPX = 0, GAPY = 0;
    const pkSetRisk = risk => {
      Gamble.pkRisk = risk; const t = PK_TABLES[risk];
      ROWS = t.length - 1; GAPX = PW / (ROWS + 2); GAPY = (PH - 40) / ROWS;
      $('#pk-slots').dataset.risk = risk;
      $('#pk-slots').innerHTML = t.map((m, i) => `<span data-slot="${i}" data-m="${m >= 100 ? 'top' : m >= 4 ? 'hi' : m >= 1 ? 'mid' : 'lo'}">${m}×</span>`).join('');
      $('#pk-note').textContent = risk === 'high' ? '15 rows · 1000× on the edges · max 100 per ball' : '12 rows · the edges pay the most';
      document.querySelectorAll('#pk-risk [data-risk]').forEach(b => b.classList.toggle('on', b.dataset.risk === risk));
      lit.clear();
    };
    const peg = (r, i) => ({ x: PW / 2 + (i - r / 2) * GAPX, y: 26 + r * GAPY });
    const lit = new Map(); // clou touché → instant, pour le faire briller un moment
    const drawBoard = (balls = []) => {
      pk.clearRect(0, 0, PW, PH);
      const now = performance.now();
      for (let r = 0; r < ROWS; r++) for (let i = 0; i <= r + 1; i++) {
        const q = peg(r + 1, i), y = q.y - GAPY, hot = Math.max(0, 1 - (now - (lit.get(`${r}:${i}`) || 0)) / 420);
        pk.beginPath(); pk.arc(q.x + 1.5, y + 2.5, 4.2, 0, 7); pk.fillStyle = 'rgba(0,0,0,.45)'; pk.fill();
        if (hot > 0) { pk.beginPath(); pk.arc(q.x, y, 4 + 9 * hot, 0, 7); pk.fillStyle = `rgba(251,191,36,${.35 * hot})`; pk.fill(); }
        const g = pk.createRadialGradient(q.x - 1.4, y - 1.6, .5, q.x, y, 4.4); g.addColorStop(0, '#fff'); g.addColorStop(1, hot > 0 ? '#fbbf24' : '#8b93a7');
        pk.beginPath(); pk.arc(q.x, y, 4.2, 0, 7); pk.fillStyle = g; pk.fill();
      }
      for (const ball of balls) {
        ball.trail.forEach((q, k) => { pk.beginPath(); pk.arc(q.x, q.y, 7 * (k / ball.trail.length), 0, 7); pk.fillStyle = `rgba(251,191,36,${.18 * (k / ball.trail.length)})`; pk.fill(); });
        pk.beginPath(); pk.ellipse(ball.x + 3, ball.y + 6, 8, 5, 0, 0, 7); pk.fillStyle = 'rgba(0,0,0,.4)'; pk.fill();
        const g = pk.createRadialGradient(ball.x - 3, ball.y - 3, 1, ball.x, ball.y, 9); g.addColorStop(0, '#fff7c2'); g.addColorStop(.5, '#fbbf24'); g.addColorStop(1, '#b45309');
        pk.beginPath(); pk.arc(ball.x, ball.y, 9, 0, 7); pk.fillStyle = g; pk.fill();
        pk.beginPath(); pk.arc(ball.x, ball.y, 12, 0, 7); pk.strokeStyle = 'rgba(245,158,11,.35)'; pk.lineWidth = 3; pk.stroke(); // halo sans shadowBlur
      }
    };
    pkSetRisk(Gamble.pkRisk || 'normal'); drawBoard();
    // Changer de plateau seulement quand aucune bille n'est en jeu ni en attente.
    $('#pk-risk').addEventListener('click', e => {
      const b = e.target.closest('[data-risk]'); if (!b || b.dataset.risk === Gamble.pkRisk) return;
      if (PK.balls.length || PK.queue || PK.sending) { toast('Wait for the balls to land', 1500); return; }
      pkSetRisk(b.dataset.risk); drawBoard(); pkLabel();
    });
    // Plusieurs billes à la fois, comme dans les Plinko en ligne : chaque clic ajoute une bille. Pendant qu'une demande
    // est en route, les clics suivants s'accumulent et partent ensemble dans la suivante (20 billes au plus par demande),
    // si bien qu'on peut marteler le bouton sans noyer le serveur. Une seule boucle anime toutes les billes ; le solde
    // affiché ne compte un gain qu'à l'arrivée de sa bille.
    const PK = Gamble.pk = { balls: [], queue: 0, sending: false, pending: 0, raf: 0, lastTick: 0, lastFx: 0, n: 0, net: 0, idle: 0, hold: 0, wait: 0 };
    const pkLabel = () => { $('#pk-go').textContent = `Drop · ${fmt(Gamble.pkRisk === 'high' ? Math.min(Gamble.chip, 100) : Gamble.chip)}`; };
    const pkCoins = () => { if ($('#g-coins') && Gamble.coins != null) $('#g-coins').textContent = `🪙 ${fmt(Gamble.coins - PK.pending)}`; };
    const pkTarget = ball => {
      const r = ball.r, q = r < ROWS ? peg(r + 1, ball.pos + ball.path[r]) : null;
      ball.from = { x: ball.x, y: ball.y };
      ball.to = q ? { x: q.x - (ball.path[r] ? 6 : -6), y: q.y - GAPY - 12 } : { x: ball.x, y: PH + 4 };
      ball.t0 = performance.now(); ball.ms = r === 0 ? 260 : Math.max(120, 190 - r * 6);
    };
    const pkLand = ball => {
      PK.pending -= ball.win; pkCoins();
      const slot = document.querySelector(`#pk-slots span[data-slot="${ball.slot}"]`);
      if (slot) { slot.classList.add('hit'); clearTimeout(slot._off); slot._off = setTimeout(() => slot.classList.remove('hit'), 900); }
      PK.n++; PK.net += ball.win - ball.bet;
      clearTimeout(PK.idle); PK.idle = setTimeout(() => { PK.n = 0; PK.net = 0; }, 5000); // une série s'arrête après 5 s sans bille
      const series = PK.n > 1 ? ` · ${PK.n} balls: ${PK.net >= 0 ? '+' : '−'}${fmt(Math.abs(PK.net))}` : '';
      say($('#pk-result'), PK.n > 1 ? PK.net + 1 : ball.win, PK.n > 1 ? 1 : ball.bet, `${ball.mult}× · ${ball.win === 1 ? 'you get 1 coin' : ball.win ? `you get ${fmt(ball.win)} coins` : `−${fmt(ball.bet)}`}${series}`);
      const now = performance.now();
      if (ball.win > ball.bet && now - PK.lastFx > 220) { PK.lastFx = now; Sound.play('reveal', { small: 1 }); if (ball.mult >= 4) FX.celebrate(ball.mult >= 11 ? 'epic' : 'uncommon', $('#pk-slots')); }
    };
    const pkFrame = now => {
      PK.raf = 0;
      if (currentView !== 'gamble') { PK.balls.length = 0; PK.pending = 0; return; } // parti : le vrai solde est déjà enregistré
      for (const ball of PK.balls.slice()) {
        const k = Math.min(1, (now - ball.t0) / ball.ms);
        ball.x = ball.from.x + (ball.to.x - ball.from.x) * k;
        ball.y = ball.from.y + (ball.to.y - ball.from.y) * k * k - Math.sin(Math.PI * k) * 11;
        ball.trail.push({ x: ball.x, y: ball.y }); if (ball.trail.length > 9) ball.trail.shift();
        if (k < 1) continue;
        if (ball.r < ROWS) {
          ball.pos += ball.path[ball.r]; lit.set(`${ball.r}:${ball.pos}`, now); PK.lastLit = now;
          if (now - PK.lastTick > 45) { PK.lastTick = now; Sound.tick({ soft: 1 }); }
          ball.r++; pkTarget(ball);
        } else { PK.balls.splice(PK.balls.indexOf(ball), 1); pkLand(ball); }
      }
      drawBoard(PK.balls);
      // La boucle tourne encore un peu après la dernière bille, le temps que les clous s'éteignent.
      if (PK.balls.length || now - PK.lastLit < 450) PK.raf = requestAnimationFrame(pkFrame);
    };
    const pkLaunch = (b, bet) => {
      const ball = { ...b, bet, r: 0, pos: 0, x: PW / 2 + (Math.random() - .5) * 6, y: -6, trail: [] };
      pkTarget(ball); PK.balls.push(ball);
      if (!PK.raf) PK.raf = requestAnimationFrame(pkFrame);
    };
    const pkPump = async () => {
      if (PK.sending || !PK.queue) return;
      PK.sending = true;
      const count = Math.min(20, PK.queue), risk = Gamble.pkRisk || 'normal', bet = risk === 'high' ? Math.min(Gamble.chip, 100) : Gamble.chip;
      PK.queue -= count;
      try {
        const res = await gamble('plinko', { bet, count, risk });
        const balls = res.balls || [res];
        PK.pending += balls.reduce((x, b) => x + b.win, 0);
        Gamble.coins = res.coins; Store.setSetting('coins', res.coins); pkCoins();
        balls.forEach((b, i) => setTimeout(() => { if (currentView === 'gamble') pkLaunch(b, bet); else PK.pending = 0; }, i * 95));
      } catch (err) { PK.queue = 0; pkStop(); PK.blocked = performance.now() + 1500; fail(err); } finally { PK.sending = false; if (PK.queue) pkPump(); } // refus (solde trop court…) : un seul message, les clics des 1,5 s suivantes sont ignorés
    };
    const pkDrop = () => {
      if (Gamble.busy || performance.now() < (PK.blocked || 0)) return;
      if (PK.queue + PK.balls.length >= 60) return; // 60 billes en jeu ou en attente au plus
      PK.queue++; pkPump();
    };
    // Maintenir le bouton : une bille tout de suite, puis une toutes les 110 ms après un court délai.
    const pkStop = () => { clearTimeout(PK.wait); clearInterval(PK.hold); PK.hold = 0; };
    const go = $('#pk-go');
    go.addEventListener('pointerdown', e => { if (e.button) return; pkStop(); pkDrop(); PK.wait = setTimeout(() => { PK.hold = setInterval(() => { if (currentView === 'gamble' && document.body.contains(go)) pkDrop(); else pkStop(); }, 110); }, 320); });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev => go.addEventListener(ev, pkStop));
    go.addEventListener('click', e => { if (e.detail === 0) pkDrop(); }); // clavier (Entrée, Espace) : la souris et le doigt passent par pointerdown
    go.addEventListener('contextmenu', e => e.preventDefault()); // appui long sur téléphone : pas de menu
    pkLabel();
    $('#g-chips').addEventListener('click', pkLabel);
    // ---- machine à sous : trois bandes de symboles qui défilent vers le bas et s'arrêtent l'une après l'autre sur le
    // tirage du serveur. Les symboles sont dessinés en SVG (pas d'émojis : le même rendu partout).
    const SM = {
      cherry: '<svg viewBox="0 0 64 64"><path d="M40 8c-9 6-15 16-17 30M40 8c2 10 6 20 6 28" fill="none" stroke="#15803d" stroke-width="3.5" stroke-linecap="round"/><path d="M40 8c8-4 16-2 20 4-8 4-15 3-20-4z" fill="#22c55e"/><circle cx="21" cy="44" r="13" fill="#dc2626"/><circle cx="46" cy="42" r="12" fill="#ef4444"/><circle cx="16" cy="39" r="4" fill="#fecaca" opacity=".8"/><circle cx="42" cy="37" r="3.5" fill="#fecaca" opacity=".8"/></svg>',
      lemon: '<svg viewBox="0 0 64 64"><ellipse cx="32" cy="35" rx="24" ry="17" transform="rotate(-24 32 35)" fill="#facc15"/><ellipse cx="32" cy="35" rx="24" ry="17" transform="rotate(-24 32 35)" fill="none" stroke="#ca8a04" stroke-width="2.5"/><path d="M9 45c-3 2-5 1-6-1M55 25c3-2 5-1 6 1" stroke="#ca8a04" stroke-width="3" stroke-linecap="round" fill="none"/><ellipse cx="25" cy="29" rx="8" ry="4" transform="rotate(-24 25 29)" fill="#fef9c3" opacity=".75"/><path d="M48 14c4-6 10-7 14-4-3 6-9 8-14 4z" fill="#22c55e"/></svg>',
      bell: '<svg viewBox="0 0 64 64"><path d="M32 8c-11 0-17 8-17 20v10l-7 10h48l-7-10V28c0-12-6-20-17-20z" fill="#f59e0b"/><path d="M32 8c-11 0-17 8-17 20v10l-7 10h20z" fill="#fbbf24"/><path d="M8 48h48" stroke="#b45309" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="55" r="5" fill="#b45309"/><rect x="29" y="3" width="6" height="7" rx="3" fill="#b45309"/><path d="M22 20c1-5 4-8 8-9" stroke="#fef3c7" stroke-width="3" stroke-linecap="round" fill="none" opacity=".8"/></svg>',
      star: '<svg viewBox="0 0 64 64"><path d="M32 5l8 18 19 2-14 13 4 19-17-10-17 10 4-19L5 25l19-2z" fill="#fde047" stroke="#ca8a04" stroke-width="2.5" stroke-linejoin="round"/><path d="M32 13l5 12 12 1-9 8 3 12-11-6z" fill="#fef9c3" opacity=".65"/></svg>',
      diamond: '<svg viewBox="0 0 64 64"><path d="M16 12h32l12 14-28 30L4 26z" fill="#22d3ee"/><path d="M16 12l8 14H4zM48 12l-8 14h20zM24 26h16l-8 30z" fill="#67e8f9"/><path d="M16 12h32l-8 14H24z" fill="#a5f3fc"/><path d="M16 12h32l12 14-28 30L4 26z" fill="none" stroke="#0e7490" stroke-width="2.5" stroke-linejoin="round"/></svg>',
      seven: '<svg viewBox="0 0 64 64"><path d="M12 9h42v10L34 57H18l18-34H12z" fill="#b91c1c" stroke="#fde047" stroke-width="3.5" stroke-linejoin="round"/><path d="M16 13h34v3L30 53h-5l19-36H16z" fill="#ef4444"/></svg>',
    };
    const SM_NAMES = Object.keys(SM), SM_THREE = { seven: 250, diamond: 75, star: 30, bell: 12, lemon: 8, cherry: 5 }, SM_TWO = { seven: 5, cherry: 2, lemon: 1 };
    const smCell = (s, extra = '') => `<span class="sm-cell${extra}" data-sym="${s}">${SM[s]}</span>`;
    const smAny = () => SM_NAMES[Math.floor(Math.random() * SM_NAMES.length)];
    const machine = $('#sm-machine'), strips = [...document.querySelectorAll('.sm-strip')];
    // Ce que chaque rouleau montre au repos : [au-dessus, ligne de gain, en dessous].
    Gamble.smShown = Gamble.smShown || [['lemon', 'seven', 'bell'], ['star', 'seven', 'cherry'], ['diamond', 'seven', 'lemon']];
    strips.forEach((st, r) => { st.innerHTML = Gamble.smShown[r].map(s => smCell(s)).join(''); });
    $('#sm-pays').innerHTML = [...Object.entries(SM_THREE).map(([s, m]) => [SM[s].repeat(3), m]), ...Object.entries(SM_TWO).map(([s, m]) => [SM[s].repeat(2), m])]
      .map(([icons, m]) => `<span class="sm-pay"><span class="sm-pay-icons">${icons}</span><b class="mono">${m}×</b></span>`).join('');
    const smLabel = () => { $('#sm-go').textContent = `Spin · ${fmt(Gamble.chip)}`; };
    smLabel();
    $('#g-chips').addEventListener('click', () => { if (!Gamble.busy) smLabel(); });
    // Un rouleau : la bande est remplie de symboles au hasard entre ce qu'il montre et ce qu'il doit montrer, placée
    // tout en haut, puis ramenée à zéro. Les symboles défilent donc vers le bas, et la fin de course rebondit un peu.
    const smSpin = (r, final, ms) => new Promise(done => {
      const st = strips[r], filler = Array.from({ length: 14 + r * 5 + Math.round(ms / 260) }, smAny);
      const cells = [...final, ...filler, ...Gamble.smShown[r]];
      st.style.transition = 'none';
      st.innerHTML = cells.map(s => smCell(s)).join('');
      const cell = st.firstElementChild.getBoundingClientRect().height;
      st.style.transform = `translateY(${-(cells.length - 3) * cell}px)`;
      st.classList.add('blur');
      void st.offsetHeight; // la position de départ est prise en compte avant de lancer la course
      st.style.transition = `transform ${ms}ms cubic-bezier(.16, .62, .24, 1.045)`;
      st.style.transform = 'translateY(0)';
      setTimeout(() => st.classList.remove('blur'), ms * .72);
      setTimeout(() => {
        st.style.transition = 'none'; st.innerHTML = final.map(s => smCell(s)).join(''); st.style.transform = 'translateY(0)';
        Gamble.smShown[r] = final;
        st.parentElement.classList.remove('stopped'); void st.parentElement.offsetWidth; st.parentElement.classList.add('stopped');
        done();
      }, ms + 30);
    });
    const smPlay = async () => {
      if (Gamble.busy) return;
      Gamble.busy = true;
      const lever = $('#sm-lever');
      try {
        $('#sm-result').textContent = ''; $('#sm-result').dataset.won = ''; $('#sm-win').textContent = '';
        machine.querySelectorAll('.sm-cell.win').forEach(c => c.classList.remove('win'));
        lever.classList.remove('pull'); void lever.offsetWidth; lever.classList.add('pull');
        Sound.play('click');
        const res = await gamble('slots', { bet: Gamble.chip });
        showCoins(res.coins - res.win); // le gain s'affiche quand le dernier rouleau s'arrête
        machine.dataset.state = 'spin';
        const quick = reducedMotion ? .35 : 1;
        // Deux premiers rouleaux identiques : le troisième se fait attendre, les lumières s'emballent.
        const tease = res.reels[0] === res.reels[1] && !reducedMotion;
        const times = [1500, 2150, tease ? 4100 : 2800].map(x => x * quick);
        const ticks = setInterval(() => { if (currentView === 'gamble') Sound.tick({ soft: 1 }); }, 85);
        const stops = res.reels.map((sym, r) => smSpin(r, [smAny(), sym, smAny()], times[r]).then(() => {
          if (currentView !== 'gamble') return;
          Sound.play('lock', { i: r + 2, final: r === 2 ? 1 : 0 });
          if (r === 1 && tease) machine.dataset.state = 'tease';
        }));
        await Promise.all(stops);
        clearInterval(ticks);
        if (currentView !== 'gamble') { Store.setSetting('coins', res.coins); return; }
        machine.dataset.state = res.win > res.bet ? (res.mult >= 30 ? 'jackpot' : 'win') : 'idle';
        // Les symboles payés s'allument sur la ligne de gain.
        const three = res.reels[0] === res.reels[1] && res.reels[1] === res.reels[2];
        const paid = three ? res.reels[0] : Object.keys(SM_TWO).find(k => res.reels.filter(x => x === k).length === 2);
        if (res.mult) strips.forEach((st, r) => { if (res.reels[r] === paid) st.children[1].classList.add('win'); });
        say($('#sm-result'), res.win, res.bet, res.win ? `${res.mult}× · you get ${fmt(res.win)} coins` : `No line · −${fmt(res.bet)}`);
        if (res.win > res.bet) {
          countUp($('#sm-win'), 0, res.win, 900, v => `+${fmt(v)}`);
          Sound.play(res.mult >= 30 ? 'tier' : 'reveal', res.mult >= 30 ? { tier: res.mult >= 250 ? 'mythic' : 'anomaly' } : { small: 1 });
          FX.celebrate(res.mult >= 250 ? 'mythic' : res.mult >= 30 ? 'anomaly' : res.mult >= 8 ? 'epic' : 'uncommon', machine);
        }
        showCoins(res.coins);
      } catch (err) { machine.dataset.state = 'idle'; fail(err); } finally { Gamble.busy = false; smLabel(); }
    };
    $('#sm-go').addEventListener('click', smPlay);
    $('#sm-lever').addEventListener('click', smPlay);
    // ---- mines
    const drawMines = g => {
      Gamble.mn = g;
      const live = g && !g.idle && !g.done;
      document.querySelectorAll('.mn-cell').forEach(c => { const i = Number(c.dataset.cell); const open = g && g.open && g.open.includes(i), bomb = g && g.bombs && g.bombs.includes(i); const was = c.dataset.face || ''; const face = open ? 'gem' : bomb ? 'bomb' : ''; c.className = `mn-cell${face ? ` ${face}` : ''}${g && g.hit === i ? ' hit' : ''}${face && face !== was ? ' flip' : ''}`; c.dataset.face = face; c.innerHTML = face === 'gem' ? '<span class="mn-gem"></span>' : face === 'bomb' ? '<span class="mn-bomb">💣</span>' : ''; c.disabled = !live || open; });
      $('#mn-go').textContent = live ? (g.open.length ? `Cash out · ${fmt(Math.floor(g.bet * g.mult))}` : 'Pick a tile') : `Start · ${fmt(Gamble.chip)}`;
      $('#mn-go').disabled = live && !g.open.length;
      $('#mn-mult').textContent = live ? `${g.mult.toFixed(2)}×${g.next ? ` → ${g.next.toFixed(2)}×` : ''}` : '';
      if (g && g.done && !g.idle) say($('#mn-result'), g.win, g.bet, g.result === 'cash' ? `${g.mult.toFixed(2)}×${g.capped ? ' · max win reached' : ''} · you get ${fmt(g.win)} coins` : `Boom · −${fmt(g.bet)}`);
      if (g) showCoins(g.coins);
    };
    $('#mn-count').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || (Gamble.mn && !Gamble.mn.done)) return; Gamble.mines = Number(b.dataset.v); document.querySelectorAll('#mn-count button').forEach(x => x.classList.toggle('on', x === b)); });
    const minesMove = async extra => { if (Gamble.busy) return; Gamble.busy = true; try { const g = await gamble('mines', extra); drawMines(g); if (g.result === 'boom') Sound.play('lock', { i: 0 }); else if (g.result === 'cash') { Sound.play('reveal', { small: 1 }); FX.celebrate(g.mult >= 5 ? 'epic' : 'uncommon', $('#mn-grid')); } else Sound.play('lock', { i: g.open.length, soft: 1 }); } catch (err) { fail(err); } finally { Gamble.busy = false; } };
    $('#mn-go').addEventListener('click', () => { const g = Gamble.mn; if (g && !g.done && !g.idle) minesMove({ move: 'cash' }); else { $('#mn-result').textContent = ''; minesMove({ move: 'start', bet: Gamble.chip, mines: Gamble.mines }); } });
    $('#mn-grid').addEventListener('click', e => { const c = e.target.closest('.mn-cell'); if (c && !c.disabled) minesMove({ move: 'pick', cell: Number(c.dataset.cell) }); });
    // ---- tour (api/_gamble.js) : 8 étages, une bombe par étage parmi 4, 3 ou 2 cases. Le serveur ne dévoile les bombes
    // qu'à la fin ; d'ici là on ne connaît que les cases choisies. Les multiplicateurs de chaque étage sont affichés à côté.
    const TW_TILES = { easy: 4, normal: 3, hard: 2 };
    // Même calcul que le serveur (towerMult), pour afficher l'échelle avant la première partie.
    const twLadder = n => { const out = []; let x = 0.99; for (let i = 0; i < 8; i++) { x *= n / (n - 1); out.push(Math.min(250, Math.floor(x * 100) / 100)); } return out; };
    const drawTower = (g, fresh) => {
      Gamble.tw = g;
      const live = g && !g.idle && !g.done, n = g && g.tiles ? g.tiles : TW_TILES[Gamble.twLevel];
      const ladder = g && g.ladder ? g.ladder : twLadder(n), picks = g && g.picks ? g.picks : [], at = picks.length;
      const rows = [];
      for (let f = 7; f >= 0; f--) {
        const state = f < at ? 'passed' : live && f === at ? 'current' : g && g.done && !g.idle && g.result === 'boom' && f === g.floor ? 'lost' : '';
        const tiles = Array.from({ length: n }, (_, t) => {
          const safe = picks[f] === t, bomb = g && g.bombs && g.bombs[f] === t, hit = g && g.result === 'boom' && g.floor === f && g.hit === t;
          const face = safe ? 'safe' : bomb ? 'bomb' : g && g.bombs ? 'clear' : '';
          const pop = fresh && ((safe && f === at - 1) || hit) ? ' pop' : '';
          return `<button class="tw-tile${face ? ` ${face}` : ''}${hit ? ' hit' : ''}${pop}" data-floor="${f}" data-tile="${t}" ${live && f === at ? '' : 'disabled'} aria-label="Floor ${f + 1}, tile ${t + 1}">${face === 'safe' ? '<span class="tw-gem"></span>' : face === 'bomb' ? '<span class="tw-bomb">💣</span>' : ''}</button>`;
        }).join('');
        rows.push(`<div class="tw-floor${state ? ` ${state}` : ''}" style="--n:${n}"><span class="tw-lvl mono">${f + 1}</span><div class="tw-row">${tiles}</div><b class="tw-x mono">${ladder[f].toFixed(2)}×</b></div>`);
      }
      $('#tw-tower').innerHTML = rows.join('');
      $('#tw-tower').dataset.level = g && g.level ? g.level : Gamble.twLevel;
      $('#tw-go').textContent = live ? (at ? `Cash out · ${fmt(Math.floor(g.bet * g.mult))}` : 'Pick a tile') : `Start · ${fmt(Gamble.chip)}`;
      $('#tw-go').disabled = !!(live && !at);
      $('#tw-mult').textContent = live ? `${at ? g.mult.toFixed(2) : '1.00'}×${g.next ? ` → ${g.next.toFixed(2)}×` : ''}` : '';
      document.querySelectorAll('#tw-level button').forEach(x => { x.disabled = !!live; x.classList.toggle('on', x.dataset.v === (live ? g.level : Gamble.twLevel)); });
      if (g && g.done && !g.idle) say($('#tw-result'), g.win, g.bet, g.result === 'cash' ? `${g.mult.toFixed(2)}×${at === 8 ? ' · top floor' : ''} · you get ${fmt(g.win)} coins` : `Boom · −${fmt(g.bet)}`);
      if (g) showCoins(g.coins);
    };
    $('#tw-level').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || (Gamble.tw && !Gamble.tw.done && !Gamble.tw.idle)) return; Gamble.twLevel = b.dataset.v; $('#tw-result').textContent = ''; drawTower(null); });
    const towerMove = async extra => {
      if (Gamble.busy) return; Gamble.busy = true;
      try {
        const g = await gamble('tower', extra); drawTower(g, true);
        // Une note de plus en plus haute à chaque étage ; la bombe, un coup sourd et la tour qui tremble.
        if (g.result === 'boom') { Sound.play('tier', { tier: 'trash' }); const t = $('#tw-tower'); t.classList.remove('shake'); void t.offsetWidth; t.classList.add('shake'); }
        else if (g.result === 'cash') { Sound.play('reveal', { small: 1 }); FX.celebrate(g.mult >= 5 ? 'epic' : 'uncommon', $('#tw-tower')); }
        else if (g.picks.length) Sound.play('lock', { i: g.picks.length + 1, final: g.picks.length === 7 });
      } catch (err) { fail(err); } finally { Gamble.busy = false; }
    };
    $('#tw-go').addEventListener('click', () => { const g = Gamble.tw; if (g && !g.done && !g.idle) towerMove({ move: 'cash' }); else { $('#tw-result').textContent = ''; towerMove({ move: 'start', bet: Gamble.chip, level: Gamble.twLevel }); } });
    $('#tw-tower').addEventListener('click', e => { const c = e.target.closest('.tw-tile'); if (c && !c.disabled) towerMove({ move: 'pick', tile: Number(c.dataset.tile) }); });
    // ---- keno (idée de CYCOX, api/_gamble.js) : 40 numéros, 1 à 10 cochés, le serveur en tire 10 d'un coup. Les boules
    // sortent ici une à une (~150 ms, tout de suite si les animations sont réduites). Les derniers numéros cochés sont
    // gardés sur l'appareil pour rejouer en un clic.
    // Mêmes tables que KENO_PAYS dans api/_gamble.js (vérifié par tools/test-api.mjs) : KN_PAYS[cochés][trouvés].
    const KN_PAYS = [null, [0, 3.95], [0, 1.3, 8.4], [0, 1, 2.4, 18], [0, 0.5, 2, 6.2, 40], [0, 0.25, 1.4, 3.7, 15, 150], [0, 0, 1.1, 2.5, 9, 40, 400], [0, 0, 0.6, 2, 5.4, 24, 100, 1000], [0, 0, 0.4, 1.4, 3.9, 12, 60, 300, 1000], [0, 0, 0.3, 0.9, 2.65, 8, 40, 150, 500, 1000], [1, 0, 0.2, 0.7, 1.95, 5, 20, 80, 250, 500, 1000]];
    const KN_KEY = 'rng-keno-picks';
    if (!Gamble.kn) {
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem(KN_KEY) || '[]'); } catch (e) { saved = []; }
      Gamble.kn = { picks: Array.isArray(saved) ? [...new Set(saved.filter(n => Number.isInteger(n) && n >= 1 && n <= 40))].slice(0, 10) : [], drawn: [], hits: null };
    }
    const knSave = () => { try { localStorage.setItem(KN_KEY, JSON.stringify(Gamble.kn.picks)); } catch (e) { /* stockage bloqué : rien de grave */ } };
    const knMult = m => `${m}×`;
    const drawKeno = () => {
      const kn = Gamble.kn, k = kn.picks.length, shown = new Set(kn.drawn);
      document.querySelectorAll('.kn-cell').forEach(c => {
        const n = Number(c.dataset.n), mine = kn.picks.includes(n), out = shown.has(n);
        c.classList.toggle('on', mine); c.classList.toggle('drawn', out); c.classList.toggle('hit', mine && out);
        c.classList.toggle('miss', kn.drawn.length > 0 && kn.hits != null && !out);
        c.setAttribute('aria-pressed', mine ? 'true' : 'false');
      });
      $('#kn-count').textContent = `${k}/10 picked`;
      $('#kn-pays').innerHTML = k ? KN_PAYS[k].map((m, h) => ({ m, h })).filter(x => x.m > 0).reverse().map(x => `<span class="kn-pay${kn.hits === x.h && kn.done ? ' lit' : ''}"><i class="mono">${x.h} hit${x.h === 1 ? '' : 's'}</i><b class="mono">${knMult(x.m)}</b></span>`).join('') : '<span class="kn-hint">Pick numbers on the board to see the payouts</span>';
      $('#kn-go').textContent = `Play · ${fmt(Gamble.chip)}`;
      $('#kn-go').disabled = !k;
    };
    const knReset = () => { Gamble.kn.drawn = []; Gamble.kn.hits = null; Gamble.kn.done = false; $('#kn-result').textContent = ''; };
    $('#kn-board').addEventListener('click', e => {
      const c = e.target.closest('.kn-cell'); if (!c || Gamble.busy) return;
      const kn = Gamble.kn, n = Number(c.dataset.n);
      if (kn.done) knReset();
      if (kn.picks.includes(n)) kn.picks = kn.picks.filter(x => x !== n);
      else if (kn.picks.length < 10) kn.picks.push(n);
      else { toast('10 numbers at most'); return; }
      Sound.play('click'); knSave(); drawKeno();
    });
    $('#kn-random').addEventListener('click', () => {
      if (Gamble.busy) return;
      const want = Gamble.kn.picks.length || 5, all = Array.from({ length: 40 }, (_, i) => i + 1);
      for (let i = 39; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
      knReset(); Gamble.kn.picks = all.slice(0, want); Sound.play('click'); knSave(); drawKeno();
    });
    $('#kn-clear').addEventListener('click', () => { if (Gamble.busy) return; knReset(); Gamble.kn.picks = []; knSave(); drawKeno(); });
    $('#kn-go').addEventListener('click', async () => {
      const kn = Gamble.kn;
      if (Gamble.busy || !kn.picks.length) return;
      if (Gamble.chip > 100) { toast('Keno: 100 coins max per game'); return; }
      Gamble.busy = true; $('#kn-go').disabled = true;
      try {
        knReset(); drawKeno(); Sound.play('click');
        const res = await gamble('keno', { bet: Gamble.chip, picks: kn.picks });
        showCoins(res.coins - res.win); // le gain s'affiche quand la dernière boule est sortie
        let found = 0;
        for (let i = 0; i < res.drawn.length; i++) {
          if (currentView !== 'gamble') break;
          const n = res.drawn[i], hit = res.picks.includes(n);
          kn.drawn.push(n); if (hit) found++;
          const cell = document.querySelector(`.kn-cell[data-n="${n}"]`);
          drawKeno();
          if (!reducedMotion) {
            if (cell) { cell.classList.remove('pop'); void cell.offsetWidth; cell.classList.add('pop'); }
            if (hit) Sound.play('lock', { i: found + 1, final: found === res.picks.length ? 1 : 0 }); else Sound.tick({ soft: 1 });
            await new Promise(r => setTimeout(r, 150));
          }
        }
        kn.drawn = res.drawn; kn.hits = res.hits; kn.done = true;
        if (currentView !== 'gamble') { Store.setSetting('coins', res.coins); return; }
        drawKeno();
        say($('#kn-result'), res.win, res.bet, res.win ? `${res.hits}/${res.picks.length} hits · ${knMult(res.mult)} · you get ${fmt(res.win)} coins` : `${res.hits}/${res.picks.length} hits · −${fmt(res.bet)}`);
        if (res.win > res.bet) {
          Sound.play(res.mult >= 50 ? 'tier' : 'reveal', res.mult >= 50 ? { tier: res.mult >= 400 ? 'mythic' : 'anomaly' } : { small: 1 });
          FX.celebrate(res.mult >= 400 ? 'mythic' : res.mult >= 50 ? 'anomaly' : res.mult >= 5 ? 'epic' : 'uncommon', $('#kn-board'));
        }
        showCoins(res.coins);
      } catch (err) { fail(err); } finally { Gamble.busy = false; drawKeno(); }
    });
    drawKeno();
    // ---- dés (idée de CYCOX et YU CHUAN 23, api/_gamble.js) : un dé à 100 faces, « en dessous » ou « au-dessus » d'une
    // cible réglée au curseur, ou deviner la face d'un dé à 6 faces (×5,82). Le serveur tire ; ici on fait rouler le
    // chiffre ~0,7 s (rien si les animations sont réduites) avant de poser le vrai résultat.
    // Mêmes bornes et même calcul que le serveur (diceCover, diceCents) : 2 à 95 numéros couverts, 97 % des vraies chances.
    const DC_LIMIT = { under: [3, 96], over: [5, 98] };
    const dcCover = (mode, t) => (mode === 'under' ? t - 1 : 100 - t);
    const dcCents = w => Math.floor(9700 / w + 1e-9);
    if (!Gamble.dc) Gamble.dc = { mode: 'under', target: { under: 50, over: 50 }, face: 1, roll: null, won: null };
    const drawDice = () => {
      const dc = Gamble.dc, d6 = dc.mode === 'd6', table = $('#dc-table');
      table.dataset.mode = dc.mode;
      document.querySelectorAll('#dc-mode button').forEach(b => { b.classList.toggle('on', b.dataset.mode === dc.mode); b.disabled = Gamble.busy; });
      let cents, chance;
      if (d6) { cents = 582; chance = 100 / 6; }
      else {
        const [lo, hi] = DC_LIMIT[dc.mode], t = Math.min(hi, Math.max(lo, dc.target[dc.mode])), w = dcCover(dc.mode, t);
        dc.target[dc.mode] = t;
        const r = $('#dc-target'); r.min = lo; r.max = hi; r.value = t; r.disabled = Gamble.busy;
        r.style.setProperty('--p', `${(t - 1) / 99 * 100}%`);
        const zone = $('#dc-zone');
        if (dc.mode === 'under') { zone.style.left = '0%'; zone.style.width = `${t - 1}%`; } else { zone.style.left = `${t}%`; zone.style.width = `${100 - t}%`; }
        $('#dc-rule').textContent = `Win if the roll is ${dc.mode} ${t}`;
        cents = dcCents(w); chance = w;
      }
      document.querySelectorAll('.dc-face').forEach(b => { const on = Number(b.dataset.face) === dc.face; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = Gamble.busy; });
      $('#dc-chance').textContent = `${d6 ? chance.toFixed(2) : chance}%`;
      $('#dc-mult').textContent = `${(cents / 100).toFixed(2)}×`;
      $('#dc-pay').textContent = `🪙 ${fmt(Math.floor(Gamble.chip * cents / 100))}`;
      if (!Gamble.busy) $('#dc-go').textContent = `Roll · ${fmt(Gamble.chip)}`;
      $('#dc-go').disabled = Gamble.busy;
    };
    const dcSetCube = n => { $('#dc-cube').innerHTML = dicePips(n); };
    const dcClear = () => { const dc = Gamble.dc; dc.roll = null; dc.won = null; $('#dc-result').textContent = ''; $('#dc-table').dataset.result = ''; $('#dc-mark').hidden = true; };
    $('#dc-mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b || Gamble.busy) return; Gamble.dc.mode = b.dataset.mode; dcClear(); Sound.play('click'); drawDice(); });
    $('#dc-target').addEventListener('input', e => { if (Gamble.busy) return; const dc = Gamble.dc; dc.target[dc.mode] = Number(e.target.value); if (dc.roll != null) dcClear(); drawDice(); Sound.tick({ soft: 1 }); });
    $('#dc-faces').addEventListener('click', e => { const b = e.target.closest('.dc-face'); if (!b || Gamble.busy) return; Gamble.dc.face = Number(b.dataset.face); dcClear(); dcSetCube(Gamble.dc.face); Sound.play('click'); drawDice(); });
    $('#dc-go').addEventListener('click', async () => {
      const dc = Gamble.dc;
      if (Gamble.busy) return;
      Gamble.busy = true; dcClear(); drawDice(); $('#dc-go').textContent = 'Rolling…';
      const d6 = dc.mode === 'd6', table = $('#dc-table'), die = $('#dc-die'), cube = $('#dc-cube');
      // Le chiffre roule pendant que le serveur répond (au moins 0,7 s, pour le suspense).
      let spin = 0, turns = 0;
      if (!reducedMotion) {
        table.classList.add('rolling');
        spin = setInterval(() => { turns++; if (d6) dcSetCube(1 + Math.floor(Math.random() * 6)); else die.textContent = 1 + Math.floor(Math.random() * 100); if (turns % 2) Sound.tick({ soft: 1 }); }, 60);
      }
      try {
        const [res] = await Promise.all([gamble('dice', d6 ? { bet: Gamble.chip, mode: 'd6', target: dc.face } : { bet: Gamble.chip, mode: dc.mode, target: dc.target[dc.mode] }), new Promise(r => setTimeout(r, reducedMotion ? 0 : 700))]);
        clearInterval(spin); table.classList.remove('rolling');
        if (currentView !== 'gamble') { Store.setSetting('coins', res.coins); return; }
        dc.roll = res.roll; dc.won = res.won;
        if (d6) dcSetCube(res.roll);
        else { die.textContent = res.roll; const m = $('#dc-mark'); m.hidden = false; m.textContent = res.roll; m.style.left = `${(res.roll - 0.5)}%`; }
        table.dataset.result = res.won ? 'win' : 'lose';
        if (!reducedMotion) { const el = d6 ? cube : die; el.classList.remove('land'); void el.offsetWidth; el.classList.add('land'); }
        say($('#dc-result'), res.win, res.bet, res.won ? `${res.roll} · ${res.mult.toFixed(2)}× · you get ${fmt(res.win)} coins` : `${res.roll} · −${fmt(res.bet)}`);
        if (res.won) { Sound.play(res.mult >= 10 ? 'tier' : 'reveal', res.mult >= 10 ? { tier: res.mult >= 30 ? 'mythic' : 'anomaly' } : { small: 1 }); FX.celebrate(res.mult >= 30 ? 'mythic' : res.mult >= 10 ? 'anomaly' : res.mult >= 3 ? 'epic' : 'uncommon', d6 ? cube : die); }
        else Sound.play('lock', { i: 0, soft: 1 });
        showCoins(res.coins);
      } catch (err) { clearInterval(spin); table.classList.remove('rolling'); if (!d6) die.textContent = '?'; fail(err); } finally { Gamble.busy = false; drawDice(); }
    });
    dcSetCube(Gamble.dc.face); drawDice();
    // ---- Teddy Roulette (idée de d_alex, api/_gamble.js) : 6 chambres, une seule fait « BOOM » (confettis sur le
    // nounours, mise perdue). Chaque « clic » fait tourner le barillet d'un cran et monter le gain ; on encaisse quand on
    // veut, et le 5e clic s'encaisse seul. Le serveur ne dit où était la chambre chargée qu'à la fin.
    const tdLadder = () => [1, 2, 3, 4, 5].map(k => Math.floor(97 * 6 / (6 - k) + 1e-9) / 100);
    const tdBurst = () => {
      const box = $('#td-burst'); if (!box || reducedMotion) return;
      const w = box.clientWidth, h = box.clientHeight, C = ['#f472b6', '#facc15', '#38bdf8', '#4ade80', '#a78bfa', '#fb923c'];
      box.innerHTML = Array.from({ length: 44 }, (_, i) => {
        const dx = w * (0.18 + Math.random() * 0.36), dy = h * (Math.random() - 0.55) * 0.9;
        return `<i style="--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--r:${Math.round(Math.random() * 720 - 360)}deg;--d:${Math.round(Math.random() * 120)}ms;background:${C[i % 6]}${i % 3 ? '' : ';border-radius:50%'}"></i>`;
      }).join('');
      setTimeout(() => { if (box.isConnected) box.innerHTML = ''; }, 1400);
    };
    const tdPop = (text, kind) => { const p = $('#td-pop'); p.textContent = text; p.dataset.kind = kind || ''; p.classList.remove('show'); void p.offsetWidth; if (text) p.classList.add('show'); };
    const drawTeddy = g => {
      Gamble.td = g;
      const live = g && !g.idle && !g.done, pulls = g && g.pulls ? g.pulls : 0, ladder = g && g.ladder ? g.ladder : tdLadder();
      const scene = $('#td-scene');
      scene.dataset.state = !g || g.idle ? 'idle' : live ? 'live' : g.result;
      scene.style.setProperty('--rot', `${-60 * (g && g.result === 'boom' ? g.boom : pulls)}deg`);
      scene.querySelectorAll('.td-ch').forEach(c => { const i = Number(c.dataset.ch); c.setAttribute('class', `td-ch${i < pulls ? ' empty' : ''}${g && g.done && !g.idle && i === g.boom ? ' loaded' : ''}${live && i === pulls ? ' next' : ''}`); });
      $('#td-ladder').innerHTML = ladder.map((m, i) => `<span class="td-step${i < pulls ? ' passed' : ''}${live && i === pulls ? ' next' : ''}${g && g.result === 'cash' && i === pulls - 1 ? ' lit' : ''}"><i class="mono">${i + 1} click${i ? 's' : ''}</i><b class="mono">${m.toFixed(2)}×</b></span>`).join('');
      $('#td-go').textContent = live ? 'Pull 🎉' : `Start · ${fmt(Gamble.chip)}`;
      const cash = $('#td-cash'); cash.hidden = !(live && pulls); cash.style.display = cash.hidden ? 'none' : ''; if (live && pulls) cash.textContent = `Cash out · ${fmt(Math.floor(g.bet * g.mult))}`;
      if (g && g.done && !g.idle) say($('#td-result'), g.win, g.bet, g.result === 'cash' ? `${g.mult.toFixed(2)}×${pulls === 5 ? ' · all 5 clicks' : ''} · you get ${fmt(g.win)} coins` : `BOOM! Confetti everywhere · −${fmt(g.bet)}`);
      if (g) showCoins(g.coins);
    };
    const teddyMove = async extra => {
      if (Gamble.busy) return; Gamble.busy = true;
      const scene = $('#td-scene');
      try {
        if (extra.move === 'pull' && !reducedMotion) { scene.classList.remove('pulling'); void scene.offsetWidth; scene.classList.add('pulling'); }
        const [g] = await Promise.all([gamble('teddy', extra), new Promise(r => setTimeout(r, extra.move === 'pull' && !reducedMotion ? 420 : 0))]);
        if (currentView !== 'gamble') return;
        drawTeddy(g);
        if (g.result === 'boom') { tdPop('BOOM!', 'boom'); tdBurst(); Sound.play('lock', { i: 0 }); Sound.play('tick', { k: 9 }); }
        else if (g.result === 'cash') { tdPop(g.pulls === 5 ? 'Phew! 🧸' : '', 'cash'); Sound.play('reveal', { small: 1 }); FX.celebrate(g.mult >= 2.9 ? 'epic' : 'uncommon', $('#td-scene')); }
        else if (extra.move === 'pull') { tdPop('click!', 'click'); Sound.play('click'); Sound.play('lock', { i: g.pulls + 1, soft: 1 }); }
        else tdPop('', '');
      } catch (err) { fail(err); } finally { Gamble.busy = false; scene.classList.remove('pulling'); }
    };
    $('#td-go').addEventListener('click', () => { const g = Gamble.td; if (g && !g.done && !g.idle) teddyMove({ move: 'pull' }); else { $('#td-result').textContent = ''; teddyMove({ move: 'start', bet: Gamble.chip }); } });
    $('#td-cash').addEventListener('click', () => { const g = Gamble.td; if (g && !g.done && !g.idle && g.pulls) teddyMove({ move: 'cash' }); });
    drawTeddy(null);
    // ---- pile ou face « double ou rien » (api/_gamble.js) : la pièce tourne pendant que le serveur répond, puis se pose
    // sur le côté tiré. Gagné : on encaisse ou on relance pour doubler encore (×1,96 par lancer gagné, 8 au plus).
    const CF_MULT = k => Math.floor(Math.pow(1.9, k) * 100) / 100, CF_MAX = 7; // mêmes valeurs que api/_gamble.js
    const drawFlip = g => {
      Gamble.cf = g && !g.done && !g.idle ? g : null;
      const wins = Gamble.cf ? g.wins : 0;
      $('#cf-ladder').innerHTML = Array.from({ length: CF_MAX }, (_, i) => `<span class="${i < wins ? 'on' : ''}${i === wins && Gamble.cf ? ' next' : ''}">×${CF_MULT(i + 1)}</span>`).join('');
      const cash = $('#cf-cash');
      cash.hidden = !Gamble.cf;
      if (Gamble.cf) cash.textContent = `Cash out · ${fmt(Math.floor(g.bet * g.mult))}`;
      document.querySelectorAll('[data-cf]').forEach(b => { b.disabled = !!(Gamble.cf && wins >= CF_MAX); b.textContent = `${b.dataset.cf === 'heads' ? '∞ Heads' : '🎲 Tails'}${Gamble.cf ? ` · ×${CF_MULT(wins + 1)}` : ` · ${fmt(Gamble.chip)}`}`; });
      if (g && g.coins != null) showCoins(g.coins);
    };
    let cfTurns = 0;
    const spinCoin = side => new Promise(done => {
      const coin = $('#cf-coin'); cfTurns += 4;
      coin.style.transition = 'transform .9s cubic-bezier(.2,.7,.25,1)';
      coin.style.transform = `rotateY(${cfTurns * 360 + (side === 'tails' ? 180 : 0)}deg)`;
      setTimeout(done, 950);
    });
    document.querySelector('.cf-actions').addEventListener('click', async e => {
      const b = e.target.closest('[data-cf]');
      if (!b || b.disabled || Gamble.busy) return;
      Gamble.busy = true;
      try {
        const res = await gamble('flip', Gamble.cf ? { move: 'flip', side: b.dataset.cf } : { move: 'flip', side: b.dataset.cf, bet: Gamble.chip });
        Sound.play('tick', { k: 3 });
        await spinCoin(res.last);
        const lost = res.done && res.result === 'lose';
        say($('#cf-result'), lost ? 0 : 2, 1, lost ? `${res.last === 'heads' ? '∞ Heads' : '🎲 Tails'}: lost · −${fmt(res.bet)}` : `${res.last === 'heads' ? '∞ Heads' : '🎲 Tails'}! ×${res.mult} · cash out ${fmt(Math.floor(res.bet * res.mult))} or flip again`);
        if (!lost) { Sound.play('reveal', { small: 1 }); if (res.wins >= 3) FX.celebrate(res.wins >= 5 ? 'epic' : 'uncommon', $('#cf-coin')); }
        drawFlip(res);
      } catch (err) { fail(err); } finally { Gamble.busy = false; }
    });
    $('#cf-cash').addEventListener('click', async () => {
      if (Gamble.busy || !Gamble.cf) return;
      Gamble.busy = true;
      try {
        const res = await gamble('flip', { move: 'cash' });
        say($('#cf-result'), res.win, res.bet, `Cashed out at ×${res.mult} · you get ${fmt(res.win)} coins`);
        Sound.play('reveal', { small: 1 });
        drawFlip(res);
      } catch (err) { fail(err); } finally { Gamble.busy = false; }
    });
    $('#g-chips').addEventListener('click', () => { if (!Gamble.cf) drawFlip(null); });
    drawFlip(null);
    // ---- crash : la courbe monte avec l'heure du serveur ; on sonde pour savoir si c'est fini
    const cc = $('#cr-canvas').getContext('2d'), screen = $('#cr-screen');
    // Pêche (collab Canne & Dauphins, js/fishing.js) ou fusée : même partie côté serveur, seul le dessin change.
    // La pêche est affichée par défaut ; le choix du joueur est retenu.
    const Fish = window.RNGFishing ? window.RNGFishing.create($('#fish-canvas')) : null;
    const setCrMode = mode => {
      mode = mode === 'rocket' || !Fish ? 'rocket' : 'fish';
      screen.dataset.mode = mode; $('#fish-collab').hidden = mode !== 'fish';
      document.querySelectorAll('#cr-mode [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
      if (Fish && mode === 'fish') Fish.wake();
    };
    setCrMode(Store.settings.crMode);
    // Clic vers le jeu de Firetail : compté (page Owner > Traffic, encadré Collab), sans rien retarder.
    $('#fish-collab a').addEventListener('click', () => {
      try { Online.request('/api/site', { local: true, method: 'POST', keepalive: true, body: JSON.stringify({ action: 'out', to: 'pechadophin' }) }).catch(() => {}); } catch (e) { /* jamais bloquant */ }
    });
        $('#cr-mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b) return; Store.setSetting('crMode', b.dataset.mode); setCrMode(b.dataset.mode); });
    const stars = Array.from({ length: 70 }, () => ({ x: Math.random() * 640, y: Math.random() * 260, z: .3 + Math.random() * .7 })), boom = [];
    const drawCurve = (mult, state) => {
      cc.clearRect(0, 0, 640, 260);
      const speed = state === 'run' ? .6 + Math.log(mult) * 2.4 : .15;
      stars.forEach(st => { st.x -= speed * st.z * 2; st.y += speed * st.z; if (st.x < 0 || st.y > 260) { st.x = 640 * Math.random() + 200; st.y = -4; } cc.fillStyle = `rgba(255,255,255,${.25 + .5 * st.z})`; cc.fillRect(st.x, st.y, 1 + st.z * 1.4 + (state === 'run' ? speed * st.z : 0), 1 + st.z * .6); });
      const top = Math.max(2, mult * 1.18), X = m => 34 + 560 * Math.min(1, Math.log(m) / Math.log(top)), Y = m => 236 - 200 * ((m - 1) / (top - 1));
      cc.font = '600 10px ui-monospace, monospace'; cc.textAlign = 'left';
      for (let k = 0; k <= 4; k++) { const m = 1 + ((top - 1) * k) / 4, y = Y(m); cc.strokeStyle = 'rgba(255,255,255,.07)'; cc.lineWidth = 1; cc.beginPath(); cc.moveTo(34, y); cc.lineTo(626, y); cc.stroke(); cc.fillStyle = 'rgba(255,255,255,.4)'; cc.fillText(`${m.toFixed(top > 4 ? 1 : 2)}×`, 2, y + 3); }
      const color = state === 'crash' ? '#ef4444' : state === 'cash' ? '#22c55e' : '#fbbf24', pts = [];
      for (let k = 0; k <= 48; k++) { const m = 1 + ((mult - 1) * k) / 48; pts.push([X(m), Y(m)]); }
      const fill = cc.createLinearGradient(0, Y(mult), 0, 236); fill.addColorStop(0, color + '55'); fill.addColorStop(1, color + '00');
      cc.beginPath(); cc.moveTo(34, 236); pts.forEach(([x, y]) => cc.lineTo(x, y)); cc.lineTo(pts[48][0], 236); cc.closePath(); cc.fillStyle = fill; cc.fill();
      cc.beginPath(); pts.forEach(([x, y], k) => (k ? cc.lineTo(x, y) : cc.moveTo(x, y))); cc.lineCap = 'round'; cc.lineJoin = 'round'; cc.strokeStyle = color + '33'; cc.lineWidth = 14; cc.stroke(); cc.strokeStyle = color + '55'; cc.lineWidth = 8; cc.stroke(); cc.strokeStyle = color; cc.lineWidth = 4; cc.stroke(); // halo sans shadowBlur, trop lent à chaque image
      const [hx, hy] = pts[48], [px, py] = pts[44], ang = Math.atan2(hy - py, hx - px);
      if (state === 'crash') { if (!boom.length) for (let k = 0; k < 26; k++) { const a = Math.random() * 7, v = 1 + Math.random() * 4; boom.push({ x: hx, y: hy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, l: 1 }); } boom.forEach(b => { b.x += b.vx; b.y += b.vy; b.vy += .08; b.l *= .95; cc.fillStyle = `rgba(251,146,60,${b.l})`; cc.beginPath(); cc.arc(b.x, b.y, 3 * b.l + 1, 0, 7); cc.fill(); }); return; }
      boom.length = 0;
      cc.save(); cc.translate(hx, hy); cc.rotate(ang);
      if (state === 'run') { const fl = cc.createLinearGradient(-34, 0, -8, 0); fl.addColorStop(0, 'rgba(251,146,60,0)'); fl.addColorStop(.6, '#fb923c'); fl.addColorStop(1, '#fff7c2'); cc.fillStyle = fl; cc.beginPath(); cc.moveTo(-10, -5); cc.lineTo(-30 - Math.random() * 10, 0); cc.lineTo(-10, 5); cc.closePath(); cc.fill(); }
      const body = cc.createLinearGradient(0, -8, 0, 8); body.addColorStop(0, '#ffffff'); body.addColorStop(1, '#94a3b8');
      cc.fillStyle = '#ef4444'; cc.beginPath(); cc.moveTo(-10, -7); cc.lineTo(-18, -13); cc.lineTo(-4, -7); cc.closePath(); cc.fill(); cc.beginPath(); cc.moveTo(-10, 7); cc.lineTo(-18, 13); cc.lineTo(-4, 7); cc.closePath(); cc.fill();
      cc.fillStyle = body; cc.beginPath(); cc.moveTo(-12, -7); cc.lineTo(8, -7); cc.quadraticCurveTo(22, 0, 8, 7); cc.lineTo(-12, 7); cc.closePath(); cc.fill();
      cc.fillStyle = '#38bdf8'; cc.beginPath(); cc.arc(5, 0, 3.4, 0, 7); cc.fill(); cc.strokeStyle = '#0f172a'; cc.lineWidth = 1; cc.stroke();
      cc.restore();
    };
    const endCrash = res => { cancelAnimationFrame(Gamble.raf); clearInterval(Gamble.poll); Gamble.cr = null; const m = res.result === 'cash' ? res.mult : res.point; if (Fish) { if (res.result === 'cash') Fish.catch(res.mult); else Fish.snap(res.point); } screen.dataset.state = res.result; $('#cr-mult').textContent = `${m.toFixed(2)}×`; drawCurve(m, res.result); if (res.result === 'crash') { let n = 0; const ex = () => { if (n++ < 40 && currentView === 'gamble' && !Gamble.cr) { drawCurve(m, 'crash'); requestAnimationFrame(ex); } }; requestAnimationFrame(ex); } $('#cr-go').textContent = `Start · ${fmt(Gamble.chip)}`; say($('#cr-result'), res.win, res.bet, res.result === 'cash' ? `Cashed out at ${res.mult.toFixed(2)}× · you get ${fmt(res.win)} coins (it crashed at ${res.point.toFixed(2)}×)` : res.point <= 1 ? `Instant crash at 1.00×: it happens about 2 times in 100, that is the casino's edge · −${fmt(res.bet)}` : `Crashed at ${res.point.toFixed(2)}× · −${fmt(res.bet)}`); if (res.result === 'cash') { Sound.play('reveal', { small: 1 }); if (res.mult >= 2) FX.celebrate(res.mult >= 5 ? 'epic' : 'uncommon', screen); } showCoins(res.coins); };
    // La manche n'existe plus côté serveur (expirée, ou finie depuis un autre onglet) : retour à l'écran de départ.
    const resetCrash = coins => { cancelAnimationFrame(Gamble.raf); clearInterval(Gamble.poll); Gamble.cr = null; if (Fish) Fish.idle(); screen.dataset.state = 'idle'; $('#cr-mult').textContent = '1.00×'; drawCurve(1, 'idle'); $('#cr-go').textContent = `Start · ${fmt(Gamble.chip)}`; showCoins(coins); };
    // La fusée (ou la ligne de pêche) s'affiche avec un peu de retard sur le serveur, et on sonde toutes les CR_POLL ms : l'explosion est
    // connue avant que la fusée affichée n'atteigne le point, elle ne le dépasse plus (elle allait jusqu'à 1 s trop loin
    // puis revenait en arrière). Au clic, la fusée s'arrête aussitôt et le serveur paie le temps affiché (api/_gamble.js).
    // Le retard s'adapte au réseau du joueur : le pire délai pour apprendre l'explosion est un intervalle de sondage plus
    // un aller-retour, donc retard = aller-retour mesuré + CR_POLL + marge (200 ms au moins). Fixé au départ de chaque
    // partie, pour que la fusée ne recule jamais. On paie toujours le temps affiché : ce retard ne coûte rien au joueur.
    const CR_POLL = 150;
    const crLag = () => Math.min(700, Math.max(200, (Gamble.crRtt || 160) + CR_POLL + 60));
    const crRttSeen = ms => { Gamble.crRtt = Gamble.crRtt ? Math.max(ms, Gamble.crRtt * .8 + ms * .2) : ms; };
    const crElapsed = () => Math.max(0, Date.now() - Gamble.cr.t0 - Gamble.cr.lag);
    const runCrash = (st, resumed) => {
      Gamble.cr = { t0: st.t0 + (Date.now() - st.now), bet: st.bet, rate: st.rate, lag: crLag() };
      if (Fish) { if (resumed) Fish.resume(Math.exp(st.rate * crElapsed())); else Fish.cast(); } screen.dataset.state = 'run'; $('#cr-result').textContent = ''; showCoins(st.coins);
      const frame = () => { if (!Gamble.cr || Gamble.cr.frozen != null || currentView !== 'gamble') return; // Le texte suit l'arrondi du serveur (deux décimales, vers le bas) ; la courbe et la fusée suivent la valeur exacte,
        // prise sur l'horloge de l'image : dessinées avec la valeur arrondie, elles avançaient par à-coups (7 pas par seconde).
        const exact = Math.exp(Gamble.cr.rate * crElapsed()), m = Math.floor(exact * 100) / 100; const mt = `${m.toFixed(2)}×`, bt = `Cash out · ${fmt(Math.floor(Gamble.cr.bet * m))}`; if (Gamble.cr.mt !== mt) { Gamble.cr.mt = mt; $('#cr-mult').textContent = mt; } if (Gamble.cr.bt !== bt) { Gamble.cr.bt = bt; $('#cr-go').textContent = bt; } drawCurve(exact, 'run'); if (Fish) Fish.depth(exact); Gamble.raf = requestAnimationFrame(frame); };
      Gamble.cr.frame = frame; frame();
      clearInterval(Gamble.poll);
      Gamble.poll = setInterval(async () => { if (!Gamble.cr || currentView !== 'gamble') { clearInterval(Gamble.poll); return; } if (Gamble.busy || Gamble.crPolling) return; Gamble.crPolling = true; try { const sent = Date.now(), s2 = await gamble('crash', { move: 'state' }); crRttSeen(Date.now() - sent); if (s2.done && s2.result === 'crash' && Gamble.cr) endCrash(s2); else if (s2.done && s2.idle && Gamble.cr) resetCrash(s2.coins); } catch (err) { /* prochain sondage */ } finally { Gamble.crPolling = false; } }, CR_POLL);
    };
    $('#cr-go').addEventListener('click', async () => {
      if (Gamble.busy) return;
      Gamble.busy = true;
      try {
        // Un refus passager (429 : deux demandes qui se croisent, ou trop de demandes depuis la même connexion) ne doit
        // jamais faire rater un encaissement : la même demande repart aussitôt, jusqu'à quatre fois.
        let move = { move: 'start', bet: Gamble.chip };
        if (Gamble.cr) {
          // Arrêt immédiat à l'écran : la fusée se fige sur la valeur vue au clic, le serveur paie cette valeur.
          const ms = crElapsed(), m = Math.floor(Math.exp(Gamble.cr.rate * ms) * 100) / 100;
          Gamble.cr.frozen = ms; cancelAnimationFrame(Gamble.raf);
          $('#cr-mult').textContent = `${m.toFixed(2)}×`; drawCurve(Math.exp(Gamble.cr.rate * ms), 'cash'); $('#cr-go').textContent = 'Cashing out…';
          move = { move: 'cash', ms };
        }
        let res;
        for (let k = 0; ; k++) { try { const sent = Date.now(); res = await gamble('crash', move); crRttSeen(Date.now() - sent); break; } catch (err) { if (err.status !== 429 || k >= 4 || move.move !== 'cash') throw err; await new Promise(r => setTimeout(r, 120)); } }
        if (res.done) endCrash(res); else runCrash(res);
      } catch (err) {
        if (err.status === 422 && Gamble.cr && /No game/.test(err.message)) resetCrash();
        else { if (Gamble.cr && Gamble.cr.frozen != null) { Gamble.cr.frozen = null; Gamble.cr.bt = null; Gamble.cr.frame(); } fail(err); } // encaissement raté : la fusée repart
      } finally { Gamble.busy = false; }
    });
    drawCurve(1, 'idle'); $('#cr-go').textContent = `Start · ${fmt(Gamble.chip)}`; drawMines(null); drawTower(null);
    $('#g-chips').addEventListener('click', () => { if (!Gamble.cr) $('#cr-go').textContent = `Start · ${fmt(Gamble.chip)}`; if (!Gamble.mn || Gamble.mn.done || Gamble.mn.idle) drawMines(Gamble.mn && Gamble.mn.idle ? { ...Gamble.mn, coins: null } : null); if (!Gamble.tw || Gamble.tw.done || Gamble.tw.idle) $('#tw-go').textContent = `Start · ${fmt(Gamble.chip)}`; if (!Gamble.busy) $('#kn-go').textContent = `Play · ${fmt(Gamble.chip)}`; if (!Gamble.busy) drawDice(); if (!Gamble.td || Gamble.td.done || Gamble.td.idle) $('#td-go').textContent = `Start · ${fmt(Gamble.chip)}`; });
    drawBets();
    drawHand(null);
    if (!Store.player.name) { $('#bj-table').innerHTML = '<div class="empty">Roll once to start earning coins.</div>'; return; }
    // Parties laissées en cours (main de blackjack, grille de mines, fusée) : reprises l'une après l'autre, chacune
    // réessayée une fois, pour qu'aucune ne manque si le réseau accroche.
    const resume = async (game, apply) => { for (let k = 0; k < 2; k++) { try { const s = await gamble(game, { move: 'state' }); if (currentView === 'gamble') apply(s); return; } catch (err) { await new Promise(r => setTimeout(r, 500)); } } };
    (async () => {
      await resume('bj', h => drawHand(h));
      await resume('mines', g => { if (!g.idle) drawMines(g); else showCoins(g.coins); });
      await resume('tower', g => { if (!g.idle) drawTower(g); });
      await resume('teddy', g => { if (!g.idle) drawTeddy(g); });
      await resume('flip', g => { if (!g.idle) drawFlip(g); });
      await resume('crash', st => { if (!st.done) runCrash(st, true); else if (st.result === 'crash') endCrash(st); });
    })();
  }

  // « Skip known badges » dans la boutique, à côté de la vitesse : ce n'est pas un achat (il se débloque à
  // SKIP_BADGES_AT tirages), mais c'est ici qu'on voit qu'il existe, où l'on en est, et qu'on l'allume une fois acquis.
  function drawSkip() {
    const box = $('#d-skip');
    if (!box) return;
    const rolls = countedRolls(), open = rolls >= SKIP_BADGES_AT, on = Store.settings.skipBadges === 'on';
    box.innerHTML = `
      <div class="speed-row">
        <div class="up-progress"><span class="quest-bar"><span style="width:${Math.min(100, (rolls / SKIP_BADGES_AT) * 100)}%"></span></span><span class="panel-note mono">${fmt(Math.min(rolls, SKIP_BADGES_AT))} / ${fmt(SKIP_BADGES_AT)} rolls</span></div>
        <div class="speed-text"><b>${open ? 'Unlocked' : `${fmt(SKIP_BADGES_AT - rolls)} more rolls to unlock`}</b><span class="panel-note">${open ? (on ? 'on: badges you already own land instantly' : 'off: every badge plays its full reveal') : `unlocks at ${fmt(SKIP_BADGES_AT)} rolls`}</span></div>
        ${open ? `<div class="seg" id="d-skip-seg"><button data-v="on" class="${on ? 'on' : ''}">on</button><button data-v="off" class="${on ? '' : 'on'}">off</button></div>` : '<span class="skin-state locked">🔒 Locked</span>'}
      </div>
      <p class="panel-note speed-note">Badges you have already collected land at once instead of one by one, so a roll ends sooner. A badge you have never seen always gets its full reveal, and the digits and the rarity are never skipped.</p>`;
    const seg = $('#d-skip-seg');
    if (seg) seg.onclick = e => { const b = e.target.closest('button'); if (!b) return; Store.setSetting('skipBadges', b.dataset.v); toast(b.dataset.v === 'on' ? 'Known badges will now be skipped' : 'Every badge plays its full reveal again'); drawSkip(); };
  }

  // Vitesse du tirage : cinq niveaux achetés l'un après l'autre (js/shop.js). Le serveur raccourcit d'autant le délai
  // entre deux tirages ; la durée affichée est celle d'un tirage sans badge, au réglage d'animation « normal ».
  function drawSpeed(state) {
    const box = $('#d-speed');
    if (!box) return;
    $('#d-speed-panel').hidden = false;
    const lv = state.speed || 0, max = Shop.SPEED.prices.length, price = Shop.SPEED.prices[lv];
    const pct = l => Math.round((1 - Shop.SPEED.factors[l]) * 100);
    const wait = l => (8 * Shop.SPEED.factors[l]).toFixed(1).replace(/\.0$/, '');
    box.innerHTML = `
      <div class="speed-row">
        <div class="speed-pips" aria-label="Level ${lv} of ${max}">${Shop.SPEED.prices.map((p, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div>
        <div class="speed-text"><b>Level ${lv} / ${max}</b><span class="panel-note">${lv ? `reveal ${pct(lv)}% faster · ${wait(lv)} s between rolls` : `8 s between rolls`}</span></div>
        ${price === undefined ? '<span class="skin-state">Max level</span>' : `<button class="btn-roll small${state.coins >= price ? '' : ' disabled'}" id="d-speed-buy">Upgrade · 🪙 ${fmt(price)}</button>`}
      </div>
      <p class="panel-note speed-note">${price === undefined ? 'Your rolls are as fast as they get. Duels keep their shared pace.' : `Next level: reveal ${pct(lv + 1)}% faster, ${wait(lv + 1)} s between rolls. Solo rolls only: duels keep their shared pace.`}</p>`;
    const btn = $('#d-speed-buy');
    if (btn) btn.onclick = async () => {
      if (state.coins < price) { toast(`${fmt(price - state.coins)} more coins needed for the next speed level`); return; }
      btn.disabled = true;
      try {
        const next = await Online.shopAction('speed');
        toast(`⚡ Roll speed level ${next.speed}: your reveals are now ${pct(next.speed)}% faster`, 4000, 'achv');
        Sound.play('lock', { i: 5 });
        drawShop(next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      }
    };
  }

  // Émotes spéciales : une tuile par émote, animée en permanence ici ; achetée une fois, elle rejoint la barre de
  // réactions de tous les duels.
  // Fonds d'écran (2026-10-16) : un aperçu animé par fond, acheter (il s'affiche aussitôt) ou choisir, et revenir au fond
  // d'origine.
  function drawWalls(state) {
    const grid = $('#d-walls'), limitedGrid = $('#d-limited-walls');
    if (!grid) return;
    const owned = state.walls || [], on = state.wall || null;
    // Fonds d'Halloween : dans l'onglet Limités tant qu'ils sont en vente ; ensuite seulement chez ceux qui les ont.
    const onSale = w => !w.until || Date.now() < Date.parse(w.until);
    const wallTile = w => `
      <div class="skin-tile wall-tile${on === w.id ? ' equipped' : ''}${w.premium ? ' premium' : ''}">
        <div class="wall-preview wp wp-${w.id}" aria-hidden="true"></div>
        <div class="skin-name"><b>${w.emoji} ${esc(w.name)}</b><span>${esc(w.desc)}</span></div>
        <div class="skin-actions"><button class="btn ghost" data-wall-try="${w.id}" title="Preview">▶ Preview</button>${on === w.id ? '<span class="skin-state">Equipped</span>' : owned.includes(w.id) ? `<button class="btn" data-wall="${w.id}">Use</button>` : `<button class="btn${state.coins >= w.price ? '' : ' disabled'}" data-wall-buy="${w.id}">🪙 ${fmt(w.price)}</button>`}</div>
      </div>`;
    if (limitedGrid) limitedGrid.innerHTML = Shop.WALLPAPERS.filter(w => w.until && onSale(w)).map(wallTile).join('') || '<div class="empty">No limited wallpaper right now.</div>';
    grid.innerHTML = `
      <div class="skin-tile wall-tile${on ? '' : ' equipped'}">
        <div class="wall-preview wp-none" aria-hidden="true"></div>
        <div class="skin-name"><b>⬛ Original</b><span>The plain background</span></div>
        <div class="skin-actions">${on ? '<button class="btn" data-wall="none">Use</button>' : '<span class="skin-state">Equipped</span>'}</div>
      </div>` + Shop.WALLPAPERS.filter(w => !w.premium && (!w.until || owned.includes(w.id))).map(wallTile).join('');
    // Fonds légendaires (2026-10-21) : ceux qui réagissent aux tirages, dans leur propre panneau, comme les skins légendaires.
    const premiumWalls = $('#d-premium-walls');
    if (premiumWalls) { premiumWalls.innerHTML = Shop.WALLPAPERS.filter(w => w.premium).map(wallTile).join(''); premiumWalls.onclick = e => grid.onclick(e); }
    grid.onclick = async e => {
      const tryBtn = e.target.closest('[data-wall-try]');
      if (tryBtn) { tryWallpaper(tryBtn.dataset.wallTry, state); return; }
      const buy = e.target.closest('[data-wall-buy]'), use = e.target.closest('[data-wall]');
      const btn = buy || use;
      if (!btn || btn.disabled) return;
      const id = btn.dataset.wallBuy || btn.dataset.wall, item = Shop.wallById.get(id);
      if (buy && state.coins < item.price) { toast(`${fmt(item.price - state.coins)} more coins needed for ${item.name}`); return; }
      btn.disabled = true;
      try {
        const next = await Online.shopAction(buy ? 'buywall' : 'wall', undefined, { wall: id });
        toast(id === 'none' ? 'Back to the original background' : buy ? `${item.emoji} ${item.name} unlocked and on` : `${item.emoji} ${item.name} on`);
        drawShop(next);
      } catch (err) { btn.disabled = false; toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again'); }
    };
    if (limitedGrid) limitedGrid.onclick = grid.onclick;
  }
  // Aperçu d'un fond : il passe derrière tout le site, le contenu s'efface pour le montrer en plein écran, et une barre
  // en bas permet de l'acheter (ou de le mettre) ou de fermer. Rien n'est enregistré ; Échap ou Fermer remet le vrai fond.
  function tryWallpaper(id, state) {
    const item = Shop.wallById.get(id);
    if (!item) return;
    document.querySelector('.wall-try-bar')?.remove();
    paintWallpaper(id);
    document.documentElement.classList.add('wall-trying');
    const owned = (state.walls || []).includes(id), on = state.wall === id;
    const bar = document.createElement('div');
    bar.className = 'wall-try-bar';
    bar.innerHTML = `<b>${item.emoji} ${esc(item.name)}</b>
      ${on ? '<span class="skin-state">Equipped</span>' : owned ? `<button class="btn" data-wall="${id}">Use</button>` : `<button class="btn${state.coins >= item.price ? '' : ' disabled'}" data-wall-buy="${id}">🪙 ${fmt(item.price)}</button>`}
      <button class="btn ghost" data-wall-close>Close</button>`;
    document.body.append(bar);
    const end = () => { bar.remove(); document.documentElement.classList.remove('wall-trying'); removeEventListener('keydown', onKey); paintWallpaper(); };
    const onKey = e => { if (e.key === 'Escape') end(); };
    addEventListener('keydown', onKey);
    addEventListener('hashchange', end, { once: true });
    bar.onclick = e => {
      if (e.target.closest('[data-wall-close]')) { end(); return; }
      const act = e.target.closest('[data-wall-buy],[data-wall]');
      if (act) { end(); document.querySelector(`#d-walls [${act.hasAttribute('data-wall-buy') ? 'data-wall-buy' : 'data-wall'}="${id}"], #d-premium-walls [${act.hasAttribute('data-wall-buy') ? 'data-wall-buy' : 'data-wall'}="${id}"], #d-limited-walls [${act.hasAttribute('data-wall-buy') ? 'data-wall-buy' : 'data-wall'}="${id}"]`)?.click(); }
    };
  }
  // Calques en plus des ::before / ::after, seulement sur le vrai fond (pas dans les aperçus de la boutique).
  const WALL_LAYERS = { aether: '<i class="wpi-glow"></i><i class="wpi-spark"></i>', pumpkins: '<i class="wpp-bat"></i>', summit: '<i class="wps-night"></i><i class="wps-stars"></i><i class="wps-moon"></i><i class="wps-clouds"></i>', oceanic: '<i class="wpo-whale"></i><i class="wpo-shark"></i><i class="wpo-glow"></i><i class="wpo-fizz"></i><i class="wpo-pod"></i>', racetrack: '<i class="wpf-far"></i>', windybeach: '<i class="wpw-foam"></i><i class="wpw-ball"></i>', japan: '<i class="wpj-mist"></i>', playground: '<i class="wpp-clouds"></i>', cybervoid: '<i class="wpc-pulse"></i>', submarine: '<i class="wpd-glow"></i><i class="wpd-sub"><b class="wpd-burst"></b></i>', comicpage: '<i class="wcm-page"><b></b><b></b><b></b><b></b><b></b><b></b><b></b></i><i class="wcm-flash"></i><i class="wcm-dots"></i><i class="wcm-pow"></i><i class="wcm-bam"></i><i class="wcm-boom"></i>', accretion: '<i class="wbh-glow"></i><i class="wbh-lens"></i><i class="wbh-hole"></i><i class="wbh-disc"><b><u></u></b><s></s></i><i class="wbh-hole wbh-top"></i><i class="wbh-flare"></i><i class="wbh-swoop"><b></b></i>', city: '<i class="wct-clouds"></i><i class="wct-flA"></i><i class="wct-flB"></i><i class="wct-beacons"></i><i class="wct-plane"></i><i class="wct-heli"><u></u><b></b></i>', jungle: '<i class="wjg-bl"></i><i class="wjg-br"><b></b></i><i class="wjg-tl"></i><i class="wjg-tr"><b></b></i><i class="wjg-vine"></i><i class="wjg-vine"></i><i class="wjg-vine"></i><i class="wjg-fly"><b><u></u></b></i><i class="wjg-bird"><b></b></i>', rainrainbow: '<i class="wrb-sky"></i><i class="wrb-rays"></i><i class="wrb-sun"></i><i class="wrb-bow2"></i><i class="wrb-bow"></i><i class="wrb-cl"></i><i class="wrb-cl"></i><i class="wrb-lit"></i><i class="wrb-rain"></i>', crystalcave: '<i class="wcc-lamp"></i><i class="wcc-drip"></i><i class="wcc-drip"></i><i class="wcc-bat"><b></b></i>', lake: '<i class="wlk-drop"></i><i class="wlk-drop"></i><i class="wlk-j wlk-f1"><b><u></u></b><s></s><s></s></i><i class="wlk-j wlk-f2"><b><u></u></b><s></s><s></s></i><i class="wlk-j wlk-dol"><b><u></u></b><s></s><s></s></i>' };
  // Fonds qui réagissent aux tirages (data-react) et combien de temps la réaction dure (ms).
  // Comic Book, Black Hole et Rain to Rainbow (2026-10-27) : l'arc-en-ciel dure le plus longtemps, la pluie revient doucement.
  const WALL_REACT = { aether: 4500, summit: 9000, oceanic: 4500, submarine: 6500, comicpage: 4200, accretion: 6500, rainrainbow: 15000 };
  // Le fond choisi, derrière tout le site (un calque fixe), dès le chargement grâce au dernier choix connu.
  function paintWallpaper(force) {
    const want = force || Store.settings.wall;
    const id = want && Shop.wallById.has(want) ? want : null;
    let layer = document.getElementById('wallpaper');
    if (!id) { if (layer) layer.remove(); document.documentElement.classList.remove('has-wall'); return; }
    if (!layer) { layer = document.createElement('div'); layer.id = 'wallpaper'; layer.setAttribute('aria-hidden', 'true'); document.body.prepend(layer); }
    if (!layer.classList.contains(`wp-${id}`)) layer.innerHTML = WALL_LAYERS[id] || '';
    layer.className = `wp wp-${id}`;
    document.documentElement.classList.add('has-wall');
    if (id === 'bubbles' && !layer.querySelector('.wpb-b')) wallBubbles(layer);
  }
  // Fond Infinity (idée de Me Cojoni) : à la révélation, le fond prend la couleur de la rareté pendant quelques
  // secondes (data-react), puis se calme. Tout le visuel est en CSS ; ici on ne fait que poser et retirer l'attribut.
  let wallReactTimer = 0;
  function wallReact(tier) {
    const layer = document.getElementById('wallpaper');
    const id = layer && Object.keys(WALL_REACT).find(w => layer.classList.contains(`wp-${w}`));
    if (!id || document.hidden) return;
    clearTimeout(wallReactTimer);
    layer.removeAttribute('data-react');
    void layer.offsetWidth; // relance l'animation même si deux tirages de suite ont la même rareté
    layer.dataset.react = tier;
    // Deep Dive : sous Mythic, le sous-marin remonte tout de suite ; un Mythic+ reste au fond le temps de la réaction.
    if (id === 'submarine' && !(TIER_RANK[tier] >= TIER_RANK.mythic)) layer.removeAttribute('data-dive');
    wallReactTimer = setTimeout(() => { layer.removeAttribute('data-react'); layer.removeAttribute('data-dive'); }, WALL_REACT[id]);
  }
  // Fond Deep Dive (idée de ...., 2026-10-26) : le sous-marin commence à plonger pendant CHAQUE tirage (data-dive), pour
  // ne rien trahir avant la révélation ; c'est wallReact qui décide ensuite (fond pour un Mythic+, sinon il remonte).
  let wallDiveTimer = 0;
  function wallDive() {
    const layer = document.getElementById('wallpaper');
    if (!layer || !layer.classList.contains('wp-submarine') || document.hidden) return;
    clearTimeout(wallReactTimer);
    layer.removeAttribute('data-react');
    layer.dataset.dive = '1';
    clearTimeout(wallDiveTimer);
    // filet : un tirage quitté avant la révélation (ou un onglet caché à ce moment-là) ne laisse pas le sous-marin en bas
    wallDiveTimer = setTimeout(() => { if (!layer.dataset.react) layer.removeAttribute('data-dive'); }, 25000);
  }

  // Bulles ASMR (idée de kingston, 2026-10-24) : des bulles montent derrière le site et éclatent quand on clique dessus.
  // Le calque garde pointer-events: none : on écoute les clics de la page sans jamais les bloquer (pas de
  // preventDefault), et une bulle n'éclate que si le clic tombe sur le fond lui-même (body, le vide de #app, ou l'aperçu
  // plein écran), jamais sur un bouton ou un panneau du jeu.
  const BUBBLES = 14;
  function wallBubble(b, delay) {
    const r = Math.random;
    b.style.cssText = `--x:${(2 + r() * 92).toFixed(1)}vw;--s:${Math.round(28 + r() * 62)}px;--d:${(14 + r() * 14).toFixed(1)}s;--w:${(2.4 + r() * 2.4).toFixed(1)}s;--dx:${(r() * 8 - 4).toFixed(1)}vw;--y:${Math.round(12 + r() * 76)};animation-delay:${delay.toFixed(1)}s`;
  }
  function wallBubbles(layer) {
    for (let i = 0; i < BUBBLES; i++) { const b = document.createElement('i'); b.className = 'wpb-b'; wallBubble(b, -Math.random() * 28); layer.appendChild(b); }
  }
  document.addEventListener('pointerdown', e => {
    const layer = document.getElementById('wallpaper');
    if (!layer || !layer.classList.contains('wp-bubbles') || e.button > 0) return;
    const t = e.target, root = document.documentElement;
    if (!(t === document.body || t === root || t.id === 'app' || (root.classList.contains('wall-trying') && !t.closest('.wall-try-bar')))) return;
    const hit = [...layer.querySelectorAll('.wpb-b:not(.gone)')].find(b => {
      const r = b.getBoundingClientRect(), rad = r.width / 2;
      return Math.hypot(e.clientX - (r.left + rad), e.clientY - (r.top + r.height / 2)) <= rad + 6;
    });
    if (!hit) return;
    const r = hit.getBoundingClientRect(), pop = document.createElement('i');
    pop.className = 'wpb-pop';
    pop.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;--s:${r.width}px`;
    layer.appendChild(pop);
    setTimeout(() => pop.remove(), 700);
    hit.classList.add('gone');
    Sound.play('bubblePop', { k: Math.floor(Math.random() * 6) });
    // une nouvelle bulle repart du bas un peu plus tard (même élément : le nombre de bulles ne bouge pas)
    setTimeout(() => { hit.classList.remove('gone'); wallBubble(hit, 0); hit.style.animation = 'none'; void hit.offsetWidth; hit.style.animation = ''; }, 900);
  });

  // Prestige (Sacha, 2026-10-25) : trois titres chers en stock limité, pour retirer des pièces du jeu. Achat vérifié par
  // le serveur (api/shop.js, action « prestige »), le titre est équipé aussitôt.
  function drawPrestige(state) {
    const grid = $('#d-prestige');
    if (!grid) return;
    const mine = id => (state.prestige || []).find(x => x.id === id) || { owned: false, left: 0 };
    grid.innerHTML = Shop.PRESTIGE.map(p => { const m = mine(p.id); return `
      <div class="skin-tile pr-tile${m.owned ? ' owned' : ''}">
        <div class="pr-badge" aria-hidden="true">${p.emoji}</div>
        <div class="skin-name"><b>${titleHTML(p.id) || esc(p.name)}</b><span>${esc(p.desc)}</span></div>
        <span class="pr-left">${m.owned ? 'Yours' : m.left ? `${fmt(m.left)} of ${fmt(p.stock)} left` : 'Sold out'}</span>
        ${m.owned ? '<span class="skin-state">Owned</span>' : m.left ? `<button class="btn${state.coins >= p.price ? '' : ' disabled'}" data-pr-buy="${p.id}">🪙 ${fmt(p.price)}</button>` : ''}
      </div>`; }).join('');
    grid.onclick = async ev => {
      const btn = ev.target.closest('[data-pr-buy]');
      if (!btn || btn.disabled) return;
      const item = Shop.prestigeById.get(btn.dataset.prBuy);
      if (state.coins < item.price) { toast(`${fmt(item.price - state.coins)} more coins needed for ${item.name}`); return; }
      if (!confirm(window.RNGI18n.t(`Buy the ${item.name} title for ${fmt(item.price)} coins?`))) return;
      btn.disabled = true;
      try {
        const next = await Online.shopAction('prestige', undefined, { item: item.id });
        toast(`${item.name} is yours: the title is now on your name`);
        drawShop(next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      }
    };
  }

  function drawEmotes(state) {
    const grid = $('#d-emotes');
    if (!grid) return;
    $('#d-emotes-panel').hidden = false;
    grid.innerHTML = Shop.EMOTES.filter(e => Emotes.has(e.id)).map(e => `
      <div class="skin-tile emote-tile${state.emotes.includes(e.id) ? ' owned' : ''}">
        ${emoteHTML(e.id)}
        <div class="skin-name"><b data-no-i18n>${esc(e.name)}</b></div>
        ${state.emotes.includes(e.id) ? '<span class="skin-state">Owned</span>' : `<button class="btn${state.coins >= e.price ? '' : ' disabled'}" data-emote-buy="${e.id}">🪙 ${fmt(e.price)}</button>`}
      </div>`).join('');
    grid.onclick = async ev => {
      const btn = ev.target.closest('[data-emote-buy]');
      if (!btn || btn.disabled) return;
      const item = Shop.emoteById.get(btn.dataset.emoteBuy);
      if (state.coins < item.price) { toast(`${fmt(item.price - state.coins)} more coins needed for the ${item.name} emote`); return; }
      btn.disabled = true;
      try {
        const next = await Online.shopAction('buyemote', undefined, { emote: item.id });
        toast(`${item.name} emote unlocked: use it in your next duel`);
        drawShop(next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      }
    };
  }

  // Packs de sons (idée d'Angelicide9) : ▶ joue une démo (six chiffres puis une rareté), sans rien acheter.
  let soundDemo = [];
  function previewSound(id) {
    soundDemo.forEach(clearTimeout);
    Sound.stop();
    Sound.unlock();
    const pack = id === 'classic' ? undefined : id, at = [0, 260, 500, 720, 920, 1250];
    Sound.warm([...at.map((_, i) => ['lock', i === 5 ? { i, final: 1, pack } : { i, pack }]), ['tier', { tier: 'rare', pack }], ['tier', { tier: 'epic', pack }]]);
    // Un rare, puis (deuxième écoute) un epic : on entend l'escalade.
    const tier = previewSound.last === id ? 'epic' : 'rare';
    previewSound.last = tier === 'epic' ? '' : id;
    soundDemo = at.map((t, i) => setTimeout(() => Sound.play('lock', i === 5 ? { i, final: 1, pack } : { i, pack }), 120 + t))
      .concat(setTimeout(() => Sound.play('tier', { tier, pack }), 120 + 1250 + 650));
    if (Store.settings.sound === 'off') toast('Sound is off: turn it on with 🔊 at the top');
  }
  function drawSounds(state) {
    const grid = $('#d-sounds');
    if (!grid) return;
    $('#d-sounds-panel').hidden = false;
    const mine = id => id === 'classic' || (state.sounds || []).includes(id), on = state.sound || 'classic';
    grid.innerHTML = Shop.SOUNDS.map(p => `
      <div class="skin-tile sound-tile${mine(p.id) ? ' owned' : ''}${on === p.id ? ' equipped' : ''}">
        <div class="sound-icon" aria-hidden="true">${p.emoji}</div>
        <div class="skin-name"><b data-no-i18n>${esc(p.name)}</b><span>${esc(p.desc)}</span></div>
        <button class="btn sound-play" data-sound-play="${p.id}" aria-label="Preview ${esc(p.name)}">▶ Preview</button>
        ${on === p.id ? '<span class="skin-state">In use</span>'
          : mine(p.id) ? `<button class="btn" data-sound-use="${p.id}">Use</button>`
          : `<button class="btn${state.coins >= p.price ? '' : ' disabled'}" data-sound-buy="${p.id}">🪙 ${fmt(p.price)}</button>`}
      </div>`).join('');
    grid.onclick = async ev => {
      const play = ev.target.closest('[data-sound-play]');
      if (play) { previewSound(play.dataset.soundPlay); return; }
      const btn = ev.target.closest('[data-sound-buy], [data-sound-use]');
      if (!btn || btn.disabled) return;
      const buy = !!btn.dataset.soundBuy, item = Shop.soundById.get(btn.dataset.soundBuy || btn.dataset.soundUse);
      if (buy && state.coins < item.price) { toast(`${fmt(item.price - state.coins)} more coins needed for the ${item.name} sounds`); return; }
      btn.disabled = true;
      try {
        const next = await Online.shopAction(buy ? 'buysound' : 'sound', undefined, { sound: item.id });
        if (buy) toast(`${item.name} sounds unlocked: they play on your next roll`);
        drawShop(next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      }
    };
  }

  // Aperçu d'un skin avant l'achat : un tirage de démonstration (aucun nombre n'est tiré, rien n'est enregistré), au
  // rythme d'un vrai mais resserré, révélé comme un Mythic pour montrer toute la séquence. Rejouable.
  function previewSkin(id) {
    const skin = Shop.byId.get(id);
    if (!skin) return;
    openModal(`
      <h2>${skin.emoji} ${esc(skin.name)}</h2>
      <p class="panel-note" style="margin:-.3rem 0 0">Preview · shown as a Mythic roll, the strongest reveal</p>
      <div class="skin-preview"><div class="card-stage" id="sp-stage"></div></div>
      <div class="actions" style="justify-content:center"><button class="btn" id="sp-again">↻ Replay</button>${skin.supporter && !(Store.settings.skinsOwned || []).includes('supporter') ? '<button class="btn-roll small" data-fund>💗 Contribute to get it</button>' : ''}</div>
      ${skin.supporter ? '<p class="panel-note" style="text-align:center;margin:.6rem 0 0">A thank-you for contributing to the server fund. Only a look: no coins, no advantage.</p>' : ''}
      ${skin.collab ? '<p class="panel-note" style="text-align:center;margin:.6rem 0 0">Collab with Canne &amp; Dauphins by L\'taleshy &amp; cocobat. To unlock it: sign in with Google on RNG∞, then sign in with the same Google account on Canne &amp; Dauphins.</p>' : ''}`, m => {
      const stage = m.querySelector('#sp-stage');
      let timers = [], spin = 0, fx = null;
      const stop = () => { timers.forEach(clearTimeout); timers = []; clearInterval(spin); if (fx) fx.destroy(); fx = null; };
      const play = () => {
        stop();
        const digits = Array.from({ length: 6 }, (_, k) => String(k ? (Math.random() * 10) | 0 : 1 + ((Math.random() * 9) | 0)));
        stage.innerHTML = withLever(`<div class="num-card lg neutral charging${skinClass(id)}">${digits.map(() => '<span class="slot spinning">0</span>').join('')}</div>`, id);
        const card = stage.querySelector('.num-card'), slots = [...card.querySelectorAll('.slot')];
        let shown = 0;
        fx = id === 'owner' ? SkinFX.mount(stage, card, '', { owner: true }) : SkinFX.mount(stage, card, id);
        spin = setInterval(() => {
          if (!m.isConnected) { stop(); return; } // fenêtre fermée : tout s'arrête
          for (let k = shown; k < 6; k++) slots[k].textContent = spinChar(card);
          if (shown < 6) Sound.tick({ soft: 1 });
        }, 55);
        const at = (ms, fn) => timers.push(setTimeout(() => { if (m.isConnected) fn(); }, ms));
        const LOCKS = [700, 1150, 1600, 2100, 2700, 3900];
        LOCKS.forEach((ms, k) => at(ms, () => {
          slots[k].textContent = digits[k]; slots[k].classList.remove('spinning'); slots[k].classList.add('revealed'); shown = k + 1;
          if (fx) fx.lock(slots[k], { last: k === 5 });
          Sound.play('lock', { i: k, soft: 1, ...(id === 'asmr' || id === 'lab' ? { skin: id, final: k === 5 ? 1 : 0 } : {}) });
        }));
        at(LOCKS[5] - Sound.LEAD, () => { if (fx) fx.build(Sound.LEAD); });
        at(LOCKS[5] + 600, () => {
          clearInterval(spin);
          card.classList.remove('neutral', 'charging'); card.dataset.tier = 'mythic';
          if (fx) fx.reveal('mythic');
          Sound.play('reveal', { small: 1 });
        });
      };
      m.querySelector('#sp-again').addEventListener('click', play);
      play();
    });
  }

  // Boutons de tirage : « Match my skin » (défaut), les boutons vendus à part, puis ceux des skins (possédés d'abord).
  // Chaque aperçu est un vrai bouton : on peut l'enfoncer pour sentir sa course, il ne lance rien.
  function drawButtons(state) {
    const grid = $('#d-buttons');
    if (!grid) return;
    $('#d-buttons-panel').hidden = false; // caché tant que la boutique n'a pas répondu (ou sans pseudo)
    const tile = (look, choice, title, sub, action) => `
      <div class="skin-tile gen-tile${state.button === choice ? ' equipped' : ''}">
        <button type="button" class="btn-roll small${genClass(look)}" tabindex="-1" data-gen-try>Generate</button>
        <div class="skin-name"><b>${title}</b><span>${sub}</span></div>
        ${state.button === choice ? '<span class="skin-state">Equipped</span>' : action}
      </div>`;
    const equip = id => `<button class="btn" data-gen-equip="${id}">Equip</button>`;
    const skins = (state.owned.includes('owner') ? [Shop.OWNER] : []).concat(state.owned.includes('supporter') ? [Shop.SUPPORTER] : [], state.owned.includes('fisher') ? [Shop.FISHER] : [], Shop.SKINS);
    // Seuls les boutons qu'on peut porter ou acheter ici : celui d'un skin pas encore possédé s'obtient avec le skin.
    const mine = skins.filter(k => state.owned.includes(k.id)), locked = skins.length - mine.length;
    grid.innerHTML = [
      tile(state.skin, Shop.MATCH, '🔗 Match my skin', 'Follows the skin you have equipped', equip(Shop.MATCH)),
      ...Shop.BUTTONS.map(b => tile(b.id, b.id, `${b.emoji} ${esc(b.name)}`, esc(b.desc), state.buttons.includes(b.id) ? equip(b.id)
        : `<button class="btn${state.coins >= b.price ? '' : ' disabled'}" data-gen-buy="${b.id}">🪙 ${fmt(b.price)}</button>`)),
      ...mine.map(k => tile(k.id, k.id, `${k.emoji} ${esc(k.name)}`, 'Comes with your skin', equip(k.id))),
    ].join('') + (locked ? `<p class="panel-note shop-more">🔒 ${locked} more buttons come with skins you do not own yet: every skin brings its own button.</p>` : '');
    grid.onclick = async e => {
      const buy = e.target.closest('[data-gen-buy]'), eq = e.target.closest('[data-gen-equip]');
      const btn = buy || eq;
      if (!btn || btn.disabled) return;
      const id = btn.dataset.genBuy || btn.dataset.genEquip;
      const item = Shop.buttonById.get(id) || Shop.byId.get(id);
      if (buy && state.coins < item.price) { toast(`${fmt(item.price - state.coins)} more coins needed for the ${item.name} button`); return; }
      btn.disabled = true;
      try {
        const next = await Online.shopAction(buy ? 'buybutton' : 'button', undefined, { button: id });
        toast(id === Shop.MATCH ? 'Your button now follows your skin' : buy ? `${item.emoji} ${item.name} button unlocked and equipped` : `${item.emoji} ${item.name} button equipped`);
        drawShop(next);
      } catch (err) {
        btn.disabled = false;
        toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      }
    };
  }

  // Ouverture d'une caisse, façon caisses de jeu de tir : le serveur a déjà tiré le skin ; la bande file, ralentit
  // longuement et s'arrête dessus, avec un tic à chaque skin qui passe sous le repère, puis la révélation dans la
  // couleur de sa rareté. Le résultat ne dépend pas de l'animation (elle peut être coupée sans rien changer).
  async function openCase(box, state, btn, free) {
    if (!free && state.coins < box.price) { toast(`${fmt(box.price - state.coins)} more coins needed for the ${box.name}`); return; }
    if (btn) btn.disabled = true;
    let result;
    try {
      result = await Online.shopCase(box.id, free);
    } catch (err) {
      if (btn) btn.disabled = false;
      toast(err.status === 422 ? err.message : 'Shop unavailable right now, try again');
      return;
    }
    if (btn) btn.disabled = false;
    const pool = Shop.caseOdds(box);
    const pick = () => { let u = Math.random(), acc = 0; for (const o of pool) { acc += o.p; if (u < acc) return o.id; } return pool[0].id; };
    const WIN = 58, COUNT = 64;
    const strip = Array.from({ length: COUNT }, (_, i) => (i === WIN ? result.won : pick()));
    // Juste après le skin gagné, un skin rare : le « presque » qui fait retenir son souffle.
    const rarest = pool[pool.length - 1].id;
    if (result.won !== rarest && Math.random() < 0.55) strip[WIN + 1] = rarest;
    // Caisse de fonds d'écran (idée de CrazyMiner22) : la bande montre des aperçus de fonds au lieu de cartes de nombre.
    const wall = !!box.wall;
    const won = Shop.caseItem(box, result.won), rarity = Shop.rarityOf(won.id, wall);
    const look = (id, size) => wall ? `<div class="wall-preview wp wp-${id} case-wall${size === 'md' ? ' md' : ''}" aria-hidden="true"></div>`
      : `<div class="num-card ${size}${skinClass(id)}" data-tier="${size === 'md' ? (result.duplicate ? 'common' : 'epic') : 'rare'}">${slotsHTML(size === 'md' ? '235711' : '777')}</div>`;
    const cell = id => {
      const k = Shop.caseItem(box, id), r = Shop.rarityOf(id, wall);
      return `<div class="case-cell" style="--rar:${r.color}">${look(id, 'sm')}<span>${k.emoji} ${esc(k.name)}</span></div>`;
    };
    openModal(`
      <div class="case-open" style="--rar:${rarity.color}">
        <h2>${box.emoji} ${esc(box.name)}</h2>
        <div class="case-reel" id="case-reel"><div class="case-marker" id="case-marker"></div><div class="case-strip" id="case-strip">${strip.map(cell).join('')}</div></div>
        <button class="btn ghost small case-skip" id="case-skip" type="button">Skip ⏩</button>
        <div class="case-result" id="case-result" hidden>
          <div class="case-glow" aria-hidden="true"></div>
          <div class="case-rarity">${rarity.name}</div>
          ${look(won.id, 'md')}
          <p><b>${won.emoji} ${esc(won.name)}</b> — ${result.duplicate ? `you already own it: 🪙 ${fmt(result.refund)} refunded` : wall ? 'new wallpaper unlocked!' : 'new skin unlocked!'}</p>
          <div class="room-buttons">
            ${result.duplicate ? '' : `<button class="btn-roll small" id="case-equip">${wall ? 'Use' : 'Equip'}</button>`}
            <button class="btn" id="case-again">Open another · 🪙 ${fmt(box.price)}</button>
          </div>
        </div>
      </div>`, () => {
      const el = $('#case-strip'), reel = $('#case-reel'), marker = $('#case-marker');
      const cells = Array.from(el.children), target = cells[WIN];
      const pitch = cells[1].offsetLeft - cells[0].offsetLeft, half = reel.clientWidth / 2;
      // Arrêt quelque part dans la case gagnée, pas pile au centre : parfois tout près du voisin.
      const end = target.offsetLeft + target.offsetWidth / 2 - half + (Math.random() - 0.5) * target.offsetWidth * 0.82;
      let raf = 0, done = false, lastIndex = -1, synced = false;
      // Le Shop (solde, skins possédés) suit le résultat même si la fenêtre est fermée pendant l'animation : sinon le
      // solde affiché restait l'ancien et faisait croire que la caisse était gratuite (signalé par JBearr12, 2026-10-20).
      const sync = () => { if (synced) return; synced = true; if (currentView === 'shop') drawShop(result); };
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        el.style.transform = `translateX(${-end}px)`;
        reel.classList.add('stopped');
        target.classList.add('won');
        const skip = $('#case-skip'); if (skip) skip.hidden = true;
        setTimeout(() => {
          if (!$('#case-result')) { sync(); return; }
          $('#case-result').hidden = false;
          const big = ['red', 'gold'].includes(rarity.id);
          Sound.play(result.duplicate ? 'reveal' : big ? 'win' : 'reveal', { small: !big });
          if (!result.duplicate || big) FX.celebrate(big ? 'mythic' : 'epic', $('#case-result .num-card, #case-result .wall-preview'));
          sync();
        }, reducedMotion ? 0 : 650);
      };
      // Passer l'animation (idée d'Applepi, 2026-10-20) : la bande s'arrête tout de suite sur le skin gagné.
      $('#case-skip').addEventListener('click', finish);
      if (reducedMotion) finish();
      else {
        const DURATION = 6400, t0 = performance.now();
        Sound.play('riser');
        const frame = now => {
          if (!el.isConnected) { sync(); return; } // fenêtre fermée : le skin est déjà acquis côté serveur
          const t = Math.min(1, (now - t0) / DURATION);
          const x = end * (1 - Math.pow(1 - t, 4.4)); // départ très vite, puis un long ralenti
          el.style.transform = `translateX(${-x}px)`;
          // Un tic à chaque skin qui passe sous le repère : ils s'espacent à mesure que la bande ralentit.
          const index = Math.floor((x + half) / pitch);
          if (index !== lastIndex) {
            lastIndex = index;
            Sound.tick({ soft: t < 0.35, last: t > 0.8 ? Math.round((t - 0.8) * 40) : 0 });
            marker.classList.remove('tick'); void marker.offsetWidth; marker.classList.add('tick');
          }
          if (t < 1) raf = requestAnimationFrame(frame); else finish();
        };
        raf = requestAnimationFrame(frame);
      }
      const equip = $('#case-equip');
      if (equip) equip.addEventListener('click', async () => {
        try {
          if (wall) { const next = await Online.shopAction('wall', undefined, { wall: won.id }); drawShop(next); toast(`${won.emoji} ${won.name} on`); }
          else { drawShop(await Online.shopAction('equip', won.id)); toast(`${won.emoji} ${won.name} equipped`); }
          closeModal();
        } catch (err) { toast('Shop unavailable right now, try again'); }
      });
      $('#case-again').addEventListener('click', () => { closeModal(); openCase(box, result, btn); });
    });
  }

  // ---------------------------------------------------------------- boîte à suggestions (bouton 💡)
  const SUGG_STATUS = { new: 'Sent', seen: 'Read', planned: 'Planned', done: 'Added', declined: 'Not planned' };
  const suggDate = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // Point rouge sur l'ampoule, pour le créateur : une suggestion est arrivée depuis la dernière qu'il a vue sur la page
  // Owner (settings.suggSeen garde l'heure de celle-ci, sur cet appareil). Revérifié toutes les 2 minutes, onglet visible.
  const Inbox = {
    timer: 0, fresh: 0, latest: 0, replies: 0, replyLatest: 0,
    paint() {
      const b = document.querySelector('.idea-corner');
      if (!b) return;
      b.classList.toggle('unread', this.fresh > 0 || this.replies > 0);
      b.title = this.fresh > 0 ? `${this.fresh} new suggestion${this.fresh > 1 ? 's' : ''}` : this.replies > 0 ? 'The creator replied to your suggestion' : 'Suggest an idea';
    },
    async check() {
      if (document.hidden || !Store.player.name) return;
      try {
        const since = Store.settings.suggSeen || 0;
        const r = await Online.site('peek', { since, seen: Store.settings.suggReplySeen || 0 });
        // Un joueur : point rouge quand le créateur a répondu à l'une de ses suggestions (vérifié moins souvent).
        if (!r.owner) { this.replies = r.replies || 0; this.replyLatest = r.latest || 0; this.paint(); if (!this.slow) { clearInterval(this.timer); this.slow = true; this.timer = r.latest || Store.settings.hasSugg ? setInterval(() => this.check(), 600000) : 0; } return; }
        if ((Store.settings.suggSeen || 0) !== since) return; // la boîte a été ouverte entre-temps : réponse périmée
        this.fresh = r.fresh; this.latest = r.latest; this.paint();
      } catch (err) { /* prochain passage */ }
    },
    watch() { if (this.timer) return; this.timer = setInterval(() => this.check(), 120000); this.check(); },
    // La page Owner est ouverte : tout ce qui est arrivé jusqu'ici est vu.
    seen(latest) { if (latest > (Store.settings.suggSeen || 0)) Store.setSetting('suggSeen', latest); this.fresh = 0; this.paint(); },
    // Le joueur a ouvert ses suggestions : les réponses du créateur sont vues.
    repliesSeen(latest) { if (latest > (Store.settings.suggReplySeen || 0)) Store.setSetting('suggReplySeen', latest); this.replies = 0; this.paint(); },
  };
  // Fil d'une suggestion : les messages du créateur et du joueur, dans l'ordre. `mine` = libellé du côté joueur.
  const threadHTML = (thread, mine) => (thread && thread.length ? `<div class="idea-thread">${thread.map(m => `<p class="idea-msg ${m.from}"><b>${m.from === 'owner' ? 'Creator' : mine}</b><span data-no-i18n>${esc(m.text)}</span>${m.t ? `<i>${suggDate(m.t)}</i>` : ''}</p>`).join('')}</div>` : '');
  function openIdeas() {
    // Le créateur peut aussi écrire une idée : la fenêtre s'ouvre toujours, et le lien vers sa boîte dit combien sont non lues.
    if (!Store.player.name) { askName(openIdeas); return; }
    openModal(`
      <h2>💡 Ideas & bugs</h2>
      <p class="panel-note" style="margin:-.3rem 0 .8rem">Your message goes straight to the creator of the game.</p>
      <div class="seg idea-kind" id="idea-kind" role="tablist"><button data-kind="idea" class="on">💡 Suggest an idea</button><button data-kind="bug">🐞 Report a bug</button></div>
      <p class="idea-warn" id="idea-warn">🍀 <span>Luck will not be changed: the odds are the same for everyone and they stay that way, so please don't ask for more luck.</span></p>
      <p class="idea-roadmap"><a href="#/roadmap">🗺️ See the roadmap: planned and recently added ideas</a></p>
      <p class="idea-note">💛 <span>Thank you so much for all your ideas and reports! I get about a hundred every day and I'm making the game on my own, so answers and new features can take a little longer. Thanks for understanding!</span></p>
      <textarea class="input idea-text" id="idea-text" maxlength="500" rows="4" placeholder="Your idea…" aria-label="Your message"></textarea>
      <div class="idea-shot" id="idea-shot">
        <label class="btn ghost idea-shot-btn" id="idea-shot-add"><input type="file" accept="image/*" id="idea-file" multiple hidden>📎 Add images (optional, up to 3)</label>
        <span class="panel-note">or paste them here (Ctrl+V / ⌘V)</span>
        <div class="idea-shots" id="idea-shots" hidden></div>
      </div>
      <div class="idea-foot"><span class="panel-note mono" id="idea-count">0 / 500</span><button class="btn-roll small" id="idea-send">Send</button></div>
      <div id="idea-mine"><div class="empty">Loading…</div></div>`, () => {
      const text = $('#idea-text'), send = $('#idea-send');
      const draw = state => {
        const box = $('#idea-mine');
        if (!box) return;
        const seenBefore = Store.settings.suggReplySeen || 0;
        box.innerHTML = `
          ${state.owner ? `<p style="margin:.2rem 0 .6rem"><a class="btn${Inbox.fresh > 0 ? ' btn-roll small' : ''}" href="#/owner">📥 Inbox & visitors${Inbox.fresh > 0 ? ` (${Inbox.fresh} unread)` : ''}</a></p>` : state.viewer ? '<p style="margin:.2rem 0 .6rem"><a class="btn" href="#/owner">📊 Game dashboard (view only)</a></p>' : ''}${state.ideaManager ? '<p style="margin:.2rem 0 .6rem"><a class="btn" href="#/ideas">🧑‍⚖️ Idea Manager</a></p>' : ''}
          ${state.mine.length ? `<div class="eyebrow" style="margin:.8rem 0 .3rem">Your suggestions</div>${state.mine.map(x => `
            <div class="idea-row" data-id="${x.id}">
              <div class="idea-head">${x.kind === 'bug' ? `<span class="o-pill bug">🐞 Bug${x.shots ? ` · 📎${x.shots > 1 ? ` ${x.shots}` : ''}` : ''}</span>` : x.shots ? `<span class="panel-note" title="Images">📎 ${x.shots}</span>` : ''}<span class="idea-status" data-status="${x.status}">${SUGG_STATUS[x.status] || x.status}</span><span class="panel-note">${suggDate(x.t)}</span>${x.ownerAt > seenBefore ? '<span class="idea-new">New reply</span>' : ''}</div>
              <p class="idea-body" data-no-i18n>${esc(x.text)}</p>
              ${threadHTML(x.thread, 'You')}
              ${x.thread.some(m => m.from === 'owner') ? `<form class="idea-answer"><input class="input" maxlength="500" placeholder="Reply to the creator…" aria-label="Reply to the creator"><button class="btn">Reply</button></form>` : ''}
            </div>`).join('')}` : ''}`;
        // Tout ce qui est affiché est vu : le point rouge de l'ampoule s'éteint.
        if (state.mine.length) Store.setSetting('hasSugg', true);
        Inbox.repliesSeen(Math.max(0, ...state.mine.map(x => x.ownerAt || 0)));
      };
      // Répondre dans le fil d'une suggestion (au lieu d'en envoyer une nouvelle).
      $('#idea-mine').addEventListener('submit', async e => {
        const form = e.target.closest('.idea-answer');
        if (!form) return;
        e.preventDefault();
        const input = form.querySelector('input'), btn = form.querySelector('button');
        if (input.value.trim().length < 2) { toast('Write a few words first'); return; }
        btn.disabled = true;
        try { draw(await Online.site('reply', { id: form.closest('.idea-row').dataset.id, text: input.value })); toast('Reply sent', 2200, 'achv'); }
        catch (err) { btn.disabled = false; toast([422, 429].includes(err.status) ? err.message : 'Could not send your reply, try again'); }
      });
      text.addEventListener('input', () => { $('#idea-count').textContent = `${text.value.length} / 500`; });
      // Idée ou bug : jusqu'à 3 images (choisies ou collées), réduites ici en JPEG de moins de 125 000 caractères chacune
      // (le serveur en accepte 400 000 au total ; idée de Phong254, 2026-10-24 : avant, une seule et pour un bug).
      let kind = 'idea', shots = [];
      $('#idea-kind').addEventListener('click', e => {
        const b = e.target.closest('[data-kind]'); if (!b) return;
        kind = b.dataset.kind;
        document.querySelectorAll('#idea-kind [data-kind]').forEach(x => x.classList.toggle('on', x === b));
        $('#idea-warn').hidden = kind === 'bug';
        text.placeholder = window.RNGI18n ? window.RNGI18n.t(kind === 'bug' ? 'What went wrong? What did you do just before?' : 'Your idea…') : text.placeholder;
        text.focus();
      });
      const shrink = shrinkImage;
      const SHOTS_MAX = 3;
      const drawShots = () => {
        const box = $('#idea-shots'); box.hidden = !shots.length;
        box.innerHTML = shots.map((s, i) => `<div class="idea-shot-prev"><img alt="Your image ${i + 1}" src="${s}"><button class="btn ghost" data-shot-del="${i}" title="Remove this image">✕</button></div>`).join('');
        const full = shots.length >= SHOTS_MAX; $('#idea-shot-add').classList.toggle('disabled', full); $('#idea-file').disabled = full;
      };
      const addShot = async file => {
        if (shots.length >= SHOTS_MAX) { toast('Up to 3 images'); return; }
        if (!file || !/^image\//.test(file.type)) { toast('Pick an image'); return; }
        if (file.size > 25e6) { toast('This image is too big'); return; }
        try { shots.push(await shrink(file, 125000)); drawShots(); }
        catch (err) { toast('This screenshot could not be read: try another image'); }
      };
      $('#idea-file').addEventListener('change', async e => { const files = [...e.target.files]; e.target.value = ''; for (const f of files) await addShot(f); });
      $('#idea-shots').addEventListener('click', e => { const d = e.target.closest('[data-shot-del]'); if (d) { shots.splice(Number(d.dataset.shotDel), 1); drawShots(); } });
      $('#modal-root').addEventListener('paste', async e => {
        const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter(x => x.kind === 'file' && /^image\//.test(x.type));
        if (!items.length) return;
        e.preventDefault(); for (const it of items) await addShot(it.getAsFile());
      });
      send.addEventListener('click', async () => {
        if (text.value.trim().length < 5) { toast('Write a few words first'); return; }
        send.disabled = true;
        try {
          const state = await Online.site('suggest', { text: text.value, kind, shots: shots.length ? shots : undefined, lang: (window.RNGI18n && window.RNGI18n.lang) || 'en' });
          text.value = '';
          $('#idea-count').textContent = '0 / 500';
          shots = []; drawShots();
          toast(kind === 'bug' ? 'Thanks! Your bug report was sent' : 'Thanks! Your suggestion was sent', 2600, 'achv');
          draw(state);
        } catch (err) {
          toast([422, 429].includes(err.status) ? err.message : 'Could not send your suggestion, try again');
        }
        send.disabled = false;
      });
      Online.site('mine').then(draw).catch(() => { const box = $('#idea-mine'); if (box) box.innerHTML = ''; });
      text.focus();
    });
  }

  // ---------------------------------------------------------------- page du créateur : tableau de bord en onglets
  // Le serveur ne répond qu'au compte Owner : pour tout autre joueur, cette page reste vide.
  // Page Owner refaite le 2026-10-18 : 7 onglets (Joueurs = rétention + stats, Économie = pièces + boutique + casino + crypto).
  const OWNER_TABS = [['overview', '📊', 'Overview'], ['players', '👥', 'Players'], ['traffic', '🌍', 'Traffic'], ['economy', '🪙', 'Economy'], ['server', '🖥️', 'Server'], ['inbox', '💡', 'Inbox'], ['ideas', '🧑‍⚖️', 'Idea Managers'], ['reports', '🚩', 'Reports'], ['avatars', '🖼️', 'Avatars'], ['chat', '💬', 'Chat'], ['announce', '📣', 'Announce'], ['fund', '💶', 'Fund']];
  // ---------------------------------------------------------------- Idea Managers (demandé par Sacha, 2026-10-23)
  // Des joueurs choisis trient les idées : un avis (Yes / No / Discuss / Already exists) et une justification obligatoire.
  // Le créateur voit leurs avis dans sa boîte et décide seul ; eux ne voient que les idées à trier, rien d'autre.
  const IM_V = { yes: ['✅', 'Yes'], no: ['❌', 'No'], discuss: ['🤔', 'Discuss'], exists: ['♻️', 'Already exists'] };
  const imReviewsHTML = list => (list && list.length ? `<div class="im-reviews">${list.map(r => `<div class="im-review v-${r.verdict}"><b>${IM_V[r.verdict][0]} ${IM_V[r.verdict][1]}</b> <span class="panel-note">by <span data-no-i18n>${esc(r.by)}</span>${r.mine ? ' (you)' : ''}</span><p data-no-i18n>${esc(r.reason)}</p></div>`).join('')}</div>` : '');
  function renderIdeas() {
    currentView = 'ideas';
    app.innerHTML = `<div class="page page-wide"><h1 class="page-title">🧑‍⚖️ Idea Manager</h1>
      <p class="panel-note profile-sub">Read each player idea and say what you think: Yes, No, Discuss or Already exists, and always explain why. Sacha reads every review and makes the final call; players never see your reviews.</p>
      <div class="panel im-howto">
        <h3 class="panel-title">📝 How to review an idea</h3>
        <ol>
          <li><b>Pick your answer</b>: ✅ Yes, ❌ No, 🤔 Discuss or ♻️ Already exists.</li>
          <li><b>Write why</b> in the box under it (at least 20 characters). This part is required: a review without a reason is not saved.</li>
          <li><b>Press “Send my review”</b>. You'll see “Review saved” and the idea moves to the “Reviewed by me” tab. If it doesn't move, it was not sent.</li>
        </ol>
        <div class="im-example"><span class="panel-note">Example</span>
          <p><i>“Add a pizza skin with melting cheese”</i></p>
          <p>✅ <b>Yes</b> · “Food skins like Mayo and Bakery sell well, and there is no pizza yet. The melting cheese could be the reveal.”</p>
        </div>
      </div>
      <div id="im-body"><div class="empty">Loading…</div></div></div>`;
    mountIdeaManager($('#im-body'), false);
  }
  function mountIdeaManager(box, owner) {
    if (!box) return;
    let data = null, tab = owner ? 'reviewed' : 'todo', filter = '';
    const mine = x => x.reviews.find(r => r.mine);
    const split = x => { const v = new Set(x.reviews.map(r => r.verdict)); return v.has('yes') && v.has('no'); };
    const draw = () => {
      if (!data || !box.isConnected) return;
      const TABS = owner ? [['reviewed', 'Reviewed'], ['yes', '✅ Yes'], ['no', '❌ No'], ['split', '⚖️ Disagreements'], ['todo', 'Not reviewed']] : [['todo', 'To review'], ['done', 'Reviewed by me'], ['all', 'All']];
      const pick = x => (tab === 'todo' ? (owner ? !x.reviews.length : !mine(x)) : tab === 'done' ? !!mine(x) : tab === 'reviewed' ? x.reviews.length > 0 : tab === 'yes' ? x.reviews.some(r => r.verdict === 'yes') : tab === 'no' ? x.reviews.some(r => r.verdict === 'no') : tab === 'split' ? split(x) : true);
      const q = filter.trim().toLowerCase();
      const list = data.ideas.filter(pick).filter(x => !q || `${x.name} ${x.text}`.toLowerCase().includes(q));
      const count = k => { const t0 = tab; tab = k; const n = data.ideas.filter(pick).length; tab = t0; return n; };
      const card = x => {
        const me = mine(x);
        return `<div class="im-card" data-id="${x.id}">
          <div class="ib-meta"><b data-no-i18n>${esc(x.name)}</b> · ${suggDate(x.t)}${x.shots ? ` · <button class="btn ghost small" data-im-shot title="Images">📎 ${x.shots}</button>` : ''}</div>
          <p class="idea-body" data-no-i18n>${esc(x.text)}</p>
          <div class="im-shot" hidden></div>
          ${imReviewsHTML(x.reviews)}
          ${owner ? (data.readOnly ? '' : `<div class="o-moves"><button class="btn ghost" data-im-mark="planned">📌 Plan</button><button class="btn ghost" data-im-mark="declined">🚫 Decline</button><a class="btn ghost" href="#/owner/inbox" data-im-open>Open in Inbox</a></div>`) : `
          <form class="im-form">
            <div class="seg im-verdict">${Object.entries(IM_V).map(([k, [e, l]]) => `<button type="button" data-v="${k}" class="${me && me.verdict === k ? 'on' : ''}">${e} ${l}</button>`).join('')}</div>
            <textarea class="input" maxlength="${data.max}" rows="2" placeholder="Why? (at least ${data.min} characters)">${me ? esc(me.reason) : ''}</textarea>
            <div class="im-form-foot"><span class="panel-note im-left"></span><button class="btn">${me ? 'Update my review' : 'Send my review'}</button></div>
          </form>`}
        </div>`;
      };
      const focused = document.activeElement && document.activeElement.id === 'im-q';
      box.innerHTML = `${owner && !data.readOnly ? `<div class="panel im-admin"><div class="panel-head"><h3 class="panel-title">Idea Managers</h3><span class="panel-note">they only see ideas to sort, nothing else</span></div>
          <div class="im-managers">${(data.managers || []).map(n => `<span class="chip">${esc(n)} <button class="im-x" data-im-remove="${esc(n)}" title="Remove">×</button></span>`).join('') || '<span class="panel-note">Nobody yet.</span>'}</div>
          <form class="im-add"><input class="input" id="im-add" placeholder="Player name" maxlength="20" autocomplete="off"><button class="btn">Give the role</button></form></div>` : ''}
        <div class="o-inbox-tabs">${TABS.map(([k, l]) => `<button data-im-tab="${k}" class="${k === tab ? 'on' : ''}">${l} <b>${count(k)}</b></button>`).join('')}</div>
        <input class="input im-search" id="im-q" type="search" placeholder="Search a name or a word…" value="${esc(filter)}" autocomplete="off">
        <div class="im-list">${list.length ? list.slice(0, 60).map(card).join('') : `<div class="empty">${tab === 'todo' ? 'Nothing left to review. 🎉' : 'Nothing here yet.'}</div>`}</div>
        ${list.length > 60 ? `<p class="panel-note">Showing 60 of ${list.length}. Review some to see more.</p>` : ''}`;
      if (focused) { const i = $('#im-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
      box.querySelectorAll('.im-form').forEach(f => {
        const ta = f.querySelector('textarea'), left = f.querySelector('.im-left');
        const upd = () => { const n = ta.value.trim().length; left.textContent = n < data.min ? `${data.min - n} more characters` : '✓'; };
        ta.addEventListener('input', upd); upd();
      });
    };
    const load = (action = 'imInbox', extra) => Online.site(action, extra).then(d => { data = d; draw(); }).catch(err => { if (!data) box.innerHTML = `<div class="empty">${err.status === 403 ? 'This page is for Idea Managers.' : 'Unavailable right now.'}</div>`; else toast(err.message || 'Unavailable right now, try again'); throw err; });
    box.addEventListener('input', e => { if (e.target.id === 'im-q') { filter = e.target.value; draw(); } });
    box.addEventListener('click', async e => {
      const t = e.target.closest('[data-im-tab]'); if (t) { tab = t.dataset.imTab; draw(); return; }
      const v = e.target.closest('.im-verdict [data-v]'); if (v) { v.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === v)); return; }
      const rm = e.target.closest('[data-im-remove]'); if (rm) { if (confirm(window.RNGI18n ? window.RNGI18n.t('Remove this Idea Manager?') : 'Remove this Idea Manager?')) load('imSet', { name: rm.dataset.imRemove, on: false }).catch(() => {}); return; }
      const card = e.target.closest('.im-card'); if (!card) return;
      if (e.target.closest('[data-im-shot]')) {
        const holder = card.querySelector('.im-shot');
        const n = Number((data.ideas.find(x => x.id === card.dataset.id) || {}).shots) || 1;
        Promise.all(Array.from({ length: n }, (_, k) => Online.site('shot', { id: card.dataset.id, i: k + 1 }))).then(rs => { holder.innerHTML = rs.map(r => `<img alt="Image" src="${r.shot}">`).join(''); holder.hidden = false; }).catch(err => toast(err.message || 'Unavailable right now'));
        return;
      }
      const mk = e.target.closest('[data-im-mark]');
      if (mk) { mk.disabled = true; Online.site('mark', { id: card.dataset.id, status: mk.dataset.imMark }).then(() => { toast(mk.dataset.imMark === 'planned' ? 'Moved to Planned' : 'Moved to Not planned'); return load(); }).catch(() => { mk.disabled = false; }); }
    });
    box.addEventListener('submit', e => {
      e.preventDefault();
      if (e.target.classList.contains('im-add')) { const n = $('#im-add').value.trim(); if (n) load('imSet', { name: n, on: true }).then(() => toast('Role given')).catch(() => {}); return; }
      const f = e.target.closest('.im-form'); if (!f) return;
      const card = f.closest('.im-card'), on = f.querySelector('.im-verdict .on'), reason = f.querySelector('textarea').value.trim();
      if (!on) { toast('Pick Yes, No, Discuss or Already exists'); return; }
      if (reason.length < data.min) { toast(`Explain why in at least ${data.min} characters`); return; }
      const btn = f.querySelector('button.btn'); btn.disabled = true;
      load('imReview', { id: card.dataset.id, verdict: on.dataset.v, reason }).then(() => toast('Review saved')).catch(() => { btn.disabled = false; });
    });
    load().catch(() => {});
  }

  function renderOwner() {
    currentView = 'owner';
    const wanted = (location.hash.split('/')[2] || '').split('?')[0];
    const first = OWNER_TABS.some(t => t[0] === wanted) ? wanted : Inbox.fresh > 0 ? 'inbox' : 'overview';
    app.innerHTML = `
      <div class="page page-wide o-page">
        <h1 class="page-title" data-no-i18n>Owner</h1>
        <p class="o-guest" id="o-guest" hidden>👀 View only: you can see everything here, but only the creator of the game can change it.</p>
        <nav class="o-tabs" role="tablist" aria-label="Owner sections">${OWNER_TABS.map(([id, emoji, name]) => `<button role="tab" data-tab="${id}"><i>${emoji}</i><span>${name}</span><b class="o-badge" data-badge="${id}" hidden></b></button>`).join('')}</nav>
        ${OWNER_TABS.map(([id]) => `<section class="o-pane" data-pane="${id}" role="tabpanel" hidden>${id === 'fund' ? '<div id="o-fund"><div class="empty">Loading…</div></div>' : id === 'ideas' ? '<div id="o-im"><div class="empty">Loading…</div></div>' : id === 'inbox' ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">Suggestions</h3><span class="panel-note" id="o-count"></span></div><div id="o-inbox"><div class="empty">Loading…</div></div></div>' : '<div class="empty">Loading…</div>'}</section>`).join('')}
      </div>`;
    const pane = id => app.querySelector(`[data-pane="${id}"]`);
    const show = (id, keep) => {
      app.querySelectorAll('.o-tabs button').forEach(b => { const on = b.dataset.tab === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      app.querySelectorAll('.o-pane').forEach(p => { p.hidden = p.dataset.pane !== id; });
      if (!keep) { try { history.replaceState(null, '', `#/owner/${id}`); } catch (e) { /* adresse inchangée */ } }
    };
    const badge = (id, n) => { const b = app.querySelector(`[data-badge="${id}"]`); if (b) { b.hidden = !n; b.textContent = n; } };
    app.querySelector('.o-tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });
    app.addEventListener('click', e => { const go = e.target.closest('[data-go-tab]'); if (go && currentView === 'owner') { if (go.dataset.goItab) { inboxState.tab = go.dataset.goItab; drawInboxList(); } show(go.dataset.goTab); window.scrollTo({ top: 0 }); } });
    show(first, true);
    // Invité (lecture seule) : le serveur refuse de toute façon ses écritures ; ici on retire juste les commandes.
    const guest = on => { if (!on || currentView !== 'owner') return; const page = app.querySelector('.o-page'); if (!page) return; page.classList.add('o-readonly'); $('#o-guest').hidden = false; page.querySelectorAll('.o-status').forEach(x => { x.disabled = true; }); };

    // ---- petits outils d'affichage
    const denied = err => `<div class="empty">${err && err.status === 403 ? 'This page is for the creator of the game.' : 'Unavailable right now.'}</div>`;
    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
    const bars = (title, list, label = x => x, note = '', share = 0) => {
      const max = Math.max(1, ...list.map(x => x.count));
      return `<div class="panel"><div class="panel-head"><h3 class="panel-title">${title}</h3>${note ? `<span class="panel-note">${note}</span>` : ''}</div>${list.length ? list.slice(0, 12).map(x => `
        <div class="o-bar"><span class="o-name"${label(x.name) === x.name ? ' data-no-i18n' : ''}>${esc(label(x.name))}</span><span class="o-track"><span style="width:${(x.count / max) * 100}%"></span></span><span class="mono">${fmt(x.count)}${share ? ` <em class="o-share">${pct(x.count, share)}</em>` : ''}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>'}</div>`;
    };
    const table = (cols, rows, cls = '') => `<div class="o-table"><div class="o-tr head ${cls}">${cols.map(c => `<span>${c}</span>`).join('')}</div>${rows.length ? rows.map(r => `<div class="o-tr ${cls}">${r.map(c => `<span>${c}</span>`).join('')}</div>`).join('') : '<div class="empty">Nothing yet.</div>'}</div>`;
    const panel = (title, note, body) => `<div class="panel"><div class="panel-head"><h3 class="panel-title">${title}</h3>${note ? `<span class="panel-note">${note}</span>` : ''}</div>${body}</div>`;
    const sum = (list, k) => list.reduce((x, d) => x + d[k], 0);
    // Évolution par rapport à la période d'avant : flèche et pourcentage, ou rien si la base est vide.
    const trend = (cur, prev, what = 'vs the 7 days before') => {
      if (!prev) return cur ? `new ${what.replace('vs ', 'since ')}` : `– ${what}`;
      const d = ((cur - prev) / prev) * 100;
      return `<span class="${d >= 0 ? 'o-up' : 'o-down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span> ${what}`;
    };
    const who = name => `<a class="player-link" href="${profileHref(name)}" data-no-i18n>${esc(name)}</a>`;
    const ago = n => (n === 0 ? 'today' : `${n}d ago`);
    const GAME_NAMES = { crash: '🚀 Crash', mines: '💣 Mines', tower: '🗼 Tower', keno: '🎱 Keno', dice: '🎲 Dice', teddy: '🧸 Teddy Roulette', plinko: '🔻 Plinko', slots: '🎰 Slots', roulette: '🎡 Roulette', bj: '🃏 Blackjack', flip: '🪙 Coin flip' };
    const flag = c => (/^[A-Z]{2}$/.test(c) && c !== 'ZZ' ? String.fromCodePoint(...[...c].map(ch => 127397 + ch.charCodeAt(0))) : '🌐');

    // ---- ce qui attend une action du créateur (rempli quand la cagnotte et la boîte à idées ont répondu)
    const todo = { ideas: null, tips: null };
    const drawTodo = () => {
      const box = $('#o-todo');
      if (!box) return;
      const items = [];
      if (todo.ideas) items.push(`<button class="o-chip warn" data-go-tab="inbox">💡 ${todo.ideas} suggestion${todo.ideas === 1 ? '' : 's'} to read</button>`);
      if (todo.decide) items.push(`<button class="o-chip" data-go-tab="inbox" data-go-itab="seen">🤔 ${todo.decide} suggestion${todo.decide === 1 ? '' : 's'} to decide</button>`);
      if (todo.reports) items.push(`<button class="o-chip warn" data-go-tab="reports">🚩 ${todo.reports} reported message${todo.reports === 1 ? '' : 's'}</button>`);
      if (todo.server) items.push(`<button class="o-chip warn" data-go-tab="server">🖥️ ${todo.server}</button>`);
      if (todo.tips) items.push(`<button class="o-chip warn" data-go-tab="fund">💶 ${todo.tips} tip${todo.tips === 1 ? '' : 's'} waiting for a player</button>`);
      box.innerHTML = items.length ? items.join('') : todo.ideas === null && todo.tips === null ? '' : '<span class="o-chip">✅ Nothing waiting for you</span>';
    };

    // ---- Vue d'ensemble, rétention, fréquentation, casino, joueurs : deux lectures (stats + insights) et la carte.
    Promise.all([Online.site('stats'), Online.site('insights'), fetch('data/world-map.json').then(r => r.json()).catch(() => null)]).then(([st, d, world]) => {
      if (currentView !== 'owner' || !pane('overview')) return;
      guest(st.readOnly);
      const R = d.retention, week = st.days.slice(0, 7), prevWeek = st.days.slice(7, 14);
      const step = n => R.summary.find(x => x.n === n);
      const rateTile = (label, s, hint) => tile(label, s.rate === null ? '–' : `${s.rate}%`, s.players ? `${fmt(s.back)} of ${fmt(s.players)} new players · ${hint}` : 'not enough days of data yet');

      // Graphique des joueurs actifs : une colonne par jour, les revenus en bas, les nouveaux au-dessus.
      const series = R.series.slice().reverse(), maxA = Math.max(1, ...series.map(x => x.active));
      const daysChart = `<div class="o-days">${series.map((x, i) => `<span class="o-day${i === series.length - 1 ? ' partial' : ''}" data-tip="${esc(`<b>${x.day}${i === series.length - 1 ? ' (today, so far)' : ''}</b><br>${fmt(x.active)} players · ${fmt(x.fresh)} new · ${fmt(x.back)} returning<br>${fmt(x.rolls)} rolls`)}"><i class="new" style="height:${(x.fresh / maxA) * 100}%"></i><i class="back" style="height:${(x.back / maxA) * 100}%"></i><em>${i % 5 === 4 || i === series.length - 1 ? x.day.slice(8) : ''}</em></span>`).join('')}</div>
        <div class="o-legend"><span><i class="back"></i>Returning players</span><span><i class="new"></i>New players</span><span class="panel-note">Days in UTC · today is still filling up</span></div>`;

      // Lecture en clair : trois ou quatre phrases tirées des chiffres, pour savoir où regarder.
      const reading = [];
      const d1 = step(1), d7 = step(7), oneDay = R.daysPlayed.find(x => x.name === '1 day'), everyone = R.daysPlayed.reduce((x, b) => x + b.count, 0);
      if (d1.players >= 5) reading.push(`<b>${Math.round(d1.rate / 10)} in 10</b> new players come back the day after their first roll${d1.rate >= 35 ? ': that is strong.' : d1.rate >= 20 ? ': decent, room to grow.' : ': most leave after day one, so the first session is where to improve.'}`);
      if (d7.players >= 5) reading.push(`<b>${d7.rate}%</b> are still playing one week later.`);
      if (everyone) reading.push(`<b>${pct(oneDay.count, everyone)}</b> of the players seen in the last 30 days played on one single day.`);
      const drops = R.funnel.slice(1).map((x, i) => ({ from: R.funnel[i], to: x, lost: R.funnel[i].count - x.count })).filter(x => x.from.count > 0).sort((a, b) => b.lost / b.from.count - a.lost / a.from.count)[0];
      if (drops && R.funnel[0].count >= 5) reading.push(`Biggest drop for newcomers: from “${drops.from.name}” to “${drops.to.name}” (<b>${pct(drops.lost, drops.from.count)}</b> lost).`);
      const topRef = st.month.refs.filter(x => x.name !== 'direct')[0];
      if (topRef) reading.push(`Best outside source of visits: <b data-no-i18n>${esc(topRef.name)}</b> (${fmt(topRef.count)} in 30 days).`);
      if (R.quiet.length) reading.push(`<b>${R.quiet.length}</b> regular player${R.quiet.length === 1 ? ' has' : 's have'} gone quiet. <button class="o-link" data-go-tab="players">See who</button>`);

      pane('overview').innerHTML = `
        <div class="o-todo" id="o-todo"></div>
        <div class="tiles">
          ${tile('Players today', fmt(R.active.today), `${fmt(R.active.yesterday)} yesterday`)}
          ${tile('Daily players, 7-day average', fmt(R.active.dauAvg), trend(R.active.dauAvg, R.active.dauPrev))}
          ${tile('New players, 7 days', fmt(R.fresh.week), trend(R.fresh.week, R.fresh.prev))}
          ${tile('Rolls, 7 days', compact(R.rolls.week), trend(R.rolls.week, R.rolls.prev))}
          ${tile('Visits, 7 days', fmt(sum(week, 'visits')), trend(sum(week, 'visits'), sum(prevWeek, 'visits')))}
          ${rateTile('Back the next day', d1, 'day 1')}
          ${rateTile('Back a week later', d7, 'day 7')}
          ${tile('Stickiness', R.active.stickiness === null ? '–' : `${R.active.stickiness}%`, `${fmt(R.active.month)} players in 30 days · share who play on a given day`)}
        </div>
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Players per day · 30 days</h3><span class="panel-note">a player = someone who rolled that day</span></div>${daysChart}</div>
        <div class="grid-2 stats-sep">
          ${panel('What the numbers say', '', reading.length ? `<ul class="o-read">${reading.map(x => `<li>${x}</li>`).join('')}</ul>` : '<div class="empty">Not enough data yet.</div>')}
          ${panel('From visit to player · 30 days', 'new devices that became players', `
            <div class="o-funnel">
              ${[['New devices on the site', sum(st.days, 'fresh')], ['New players (first roll)', R.fresh.month], ['Came back another day', R.funnel.find(x => x.name.startsWith('Played on 2')).count]].map(([name, n], i, all) => `<div class="o-step"><span class="o-name">${name}</span><span class="o-track"><span style="width:${Math.min(100, (n / Math.max(1, all[0][1])) * 100)}%"></span></span><span class="mono">${fmt(n)}</span><em class="o-share">${i ? pct(n, all[i - 1][1]) : ''}</em></div>`).join('')}
            </div><p class="panel-note">The percentage is the share kept from the line above. Devices are counted in the browser, players on the server, so the first step is an estimate.</p>`)}
        </div>`;
      drawTodo();

      // ---------------- Rétention
      const cohortRows = R.cohorts.filter(c => c.size > 0);
      const heat = c => c.cells.map(x => (x.back === null ? '<span class="o-cell none">·</span>' : `<span class="o-cell" style="background:rgba(52,211,153,${(.06 + .7 * (x.back / c.size)).toFixed(2)})" data-tip="${esc(`<b>${c.day} · day ${x.n}</b><br>${x.back} of ${c.size} played`)}">${Math.round((100 * x.back) / c.size)}%</span>`)).join('');
      const funnelTop = Math.max(1, R.funnel[0].count);
      const retentionHTML = `
        <p class="panel-note profile-sub">Retention = how many new players come back. “Day 1” means they rolled again the day after their first roll, “day 7” exactly one week after. Days are UTC, over the last 90 days; today is never counted as a missed day. Rough guide for a casual web game: day 1 above 30% is good, day 7 above 10% is good.</p>
        <div class="tiles">
          ${rateTile('Day 1', step(1), 'next day')}
          ${rateTile('Day 3', step(3), '3 days later')}
          ${rateTile('Day 7', step(7), '1 week later')}
          ${rateTile('Day 14', step(14), '2 weeks later')}
          ${rateTile('Day 30', step(30), '1 month later')}
          ${tile('Came back at least once', R.cameBack.rate === null ? '–' : `${R.cameBack.rate}%`, `${fmt(R.cameBack.back)} of ${fmt(R.cameBack.players)} players, on any later day`)}
        </div>
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Cohorts · new players by first day</h3><span class="panel-note">each row: the players who started that day, and the share who played N days later</span></div>
          <div class="o-table"><div class="o-cohort head"><span>First day</span><span>New</span>${R.steps.map(n => `<span>D${n}</span>`).join('')}</div>
          ${cohortRows.length ? cohortRows.map(c => `<div class="o-cohort"><span>${c.day.slice(5)}</span><span>${fmt(c.size)}</span>${heat(c)}</div>`).join('') : '<div class="empty">No new player in the last 3 weeks.</div>'}</div>
        </div>
        <div class="grid-2 stats-sep">
          ${panel('Newcomer journey · started in the last 30 days', `${fmt(R.base.newcomers)} players`, `<div class="o-funnel">${R.funnel.map(x => `<div class="o-step"><span class="o-name">${x.name}</span><span class="o-track"><span style="width:${(x.count / funnelTop) * 100}%"></span></span><span class="mono">${fmt(x.count)}</span><em class="o-share">${pct(x.count, R.funnel[0].count)}</em></div>`).join('')}</div>`)}
          ${bars('Where every player stands today', R.status, x => x, 'by the last day they rolled', R.base.players)}
        </div>
        <div class="grid-2 stats-sep">
          ${bars('Days played in the last 30 days', R.daysPlayed, x => x, 'players by number of different days', R.daysPlayed.reduce((x, b) => x + b.count, 0))}
          ${bars('Features used at least once', R.features.slice().sort((a, b) => b.count - a.count), x => x, `share of the ${fmt(R.base.players)} players`, R.base.players)}
        </div>
        <div class="grid-2 stats-sep">
          ${panel('Regulars who went quiet', 'played 4+ days, silent for 3 to 20 days', table(['Player', 'Days', 'Last roll', 'Rolls'], R.quiet.map(x => [who(x.name), fmt(x.days), ago(x.ago), fmt(x.rolls)]), 'c4'))}
          ${panel('Most loyal players', 'different days played in the last 30', table(['Player', 'Days', 'Last roll', 'Rolls'], R.loyal.map(x => [who(x.name), fmt(x.days), ago(x.ago), fmt(x.rolls)]), 'c4'))}
        </div>`;

      // ---------------- Fréquentation
      const byCountry = new Map(d.map.countries.map(c => [c.name, c.count])), visits = d.map.countries.reduce((x, c) => x + c.count, 0);
      const maxC = Math.max(1, ...d.map.countries.filter(c => c.name !== 'ZZ').map(c => c.count));
      const nameOf = c => (world && world.points[c] ? world.points[c][2] : c === 'ZZ' ? 'Unknown' : c);
      let mapHTML = '<div class="empty">Map unavailable right now.</div>';
      if (world) {
        // Chaque pays teinté selon ses visites (échelle logarithmique), un rond par case de 100 km, celles du jour pulsent.
        const X = lon => ((lon + 180) / 360) * world.w, Y = lat => ((world.top - lat) / 360) * world.w;
        const shade = n => (n ? `rgba(129,140,248,${(.22 + .68 * (Math.log(1 + n) / Math.log(1 + maxC))).toFixed(2)})` : '');
        const dot = (p, cls) => `<circle class="${cls}" cx="${X(p.lon).toFixed(1)}" cy="${Y(p.lat).toFixed(1)}" r="${Math.min(9, 1.6 + Math.sqrt(p.n) * .9).toFixed(1)}" data-tip="${esc(`<b>${fmt(p.n)}</b> ${p.n > 1 ? 'visits' : 'visit'} around ${Math.abs(p.lat)}°${p.lat < 0 ? 'S' : 'N'} ${Math.abs(p.lon)}°${p.lon < 0 ? 'W' : 'E'}`)}"/>`;
        mapHTML = `<svg class="o-map" viewBox="0 0 ${world.w} ${world.h}" role="img" aria-label="World map of visits">
          ${world.countries.map(c => { const n = byCountry.get(c.c) || 0; return `<path d="${c.d}"${n ? ` style="fill:${shade(n)}"` : ''} data-tip="${esc(`<b>${c.n}</b><br>${n ? `${fmt(n)} visits · ${pct(n, visits)}` : 'no visit'}`)}"/>`; }).join('')}
          ${d.map.points.map(p => dot(p, 'o-dot')).join('')}${d.map.today.map(p => dot(p, 'o-ping')).join('')}
        </svg>`;
      }
      const offset = -new Date().getTimezoneOffset() / 60, localHours = d.hours.map((_, h) => d.hours[((h - Math.round(offset)) % 24 + 24) % 24]), maxH = Math.max(1, ...localHours);
      const peak = localHours.indexOf(Math.max(...localHours));
      const today = st.days[0], byDay = new Map(R.series.map(x => [x.day, x]));
      pane('traffic').innerHTML = `
        <p class="panel-note profile-sub">Anonymous daily counters, since 6 Oct 2026: no cookie, no IP address, nothing about who the visitor is. A visit = the site opened in a browser tab. Days in UTC. The map counts visits per square of about 100 km, never per player.</p>
        <div class="tiles">
          ${tile('Visits today', fmt(today.visits), `${fmt(today.uniq)} devices · ${fmt(today.fresh)} new`)}
          ${tile('Visits, 7 days', fmt(sum(week, 'visits')), trend(sum(week, 'visits'), sum(prevWeek, 'visits')))}
          ${tile('Visits, 30 days', fmt(sum(st.days, 'visits')), `${fmt(sum(st.days, 'fresh'))} new devices`)}
          ${tile('Players with a name', fmt(st.totals.named), `${fmt(st.totals.ranked)} on the leaderboard`)}
        </div>
        <div class="panel stats-sep">
          <div class="panel-head"><h3 class="panel-title">Where players connect from · 30 days</h3><span class="panel-note">${fmt(d.map.countries.filter(x => x.name !== 'ZZ').length)} countries · ${d.map.points.length ? `${fmt(d.map.points.length)} areas, the pulsing ones are today` : 'area dots start filling in from today'}</span></div>
          <div class="o-map-wrap">${mapHTML}
            <div class="o-countries">${d.map.countries.slice(0, 12).map(x => `<div class="o-country"><span data-no-i18n>${flag(x.name)} ${esc(nameOf(x.name))}</span><b class="mono">${fmt(x.count)}</b><span class="panel-note mono">${pct(x.count, visits)}</span></div>`).join('') || '<div class="empty">Nothing yet.</div>'}</div>
          </div>
        </div>
        ${panel('When they play · 30 days', `your local time · busiest hour: ${peak}:00`, `<div class="o-hours">${localHours.map((n, h) => `<span class="o-hour" data-tip="${esc(`<b>${h}:00 – ${h}:59</b><br>${fmt(n)} visits`)}"><i style="height:${Math.max(2, (n / maxH) * 100)}%"></i><em>${h % 3 === 0 ? h : ''}</em></span>`).join('')}</div>`).replace('class="panel"', 'class="panel stats-sep"')}
        <div class="grid-2 stats-sep">
          ${bars('Where visitors come from · 30 days', st.month.refs, n => (n === 'direct' ? 'Direct (typed, bookmark, app)' : n))}
          ${bars('Tagged links (?ref=…) · 30 days', st.month.sources, n => ({ share: 'share · a shared roll', duel: 'duel · a duel invite', pechadophin: 'pechadophin · Firetail\'s game (collab)' }[n] || n))}
          ${bars('New devices from a tagged link · 30 days', st.month.sourcesNew || [], n => ({ pechadophin: 'pechadophin · Firetail\'s game (collab)' }[n] || n))}
          ${bars('Device · 30 days', st.month.devices, x => x, '', sum(st.month.devices, 'count'))}
          ${bars('Language · 30 days', st.month.langs, x => x, '', sum(st.month.langs, 'count'))}
        </div>
        ${(() => {
          // Collab Pechadophin, tout au même endroit : ce que son jeu nous amène, et ce que le nôtre lui envoie.
          const get = (list, n) => ((list || []).find(x => x.name === n) || { count: 0 }).count;
          const m = st.month, w = st.week, came = (st.sourcePlayers || []).find(x => x.name === 'pechadophin') || { count: 0, players: [] };
          const box = (label, v7, v30) => `<div class="o-collab-k"><span class="panel-note">${label}</span><b class="mono">${fmt(v30)}</b><span class="panel-note">${fmt(v7)} in 7 days</span></div>`;
          return `<div class="panel stats-sep o-collab"><div class="panel-head"><h3 class="panel-title">🎣 Collab Pechadophin</h3><span class="panel-note">last 30 days · link to give: <b data-no-i18n>rng-infinite.com/?ref=pechadophin</b></span></div>
            <div class="o-collab-grid">
              ${box('Visits from his game', get(w.sources, 'pechadophin'), get(m.sources, 'pechadophin'))}
              ${box('New devices from his game', get(w.sourcesNew, 'pechadophin'), get(m.sourcesNew, 'pechadophin'))}
              <div class="o-collab-k"><span class="panel-note">Players who picked a name</span><b class="mono">${fmt(came.count)}</b><span class="panel-note">since the start</span></div>
              ${box('Clicks we sent to his site', get(w.out, 'pechadophin'), get(m.out, 'pechadophin'))}
            </div>
            ${came.players.length ? `<div class="o-src-names">${came.players.map(n => `<a class="badge-pill" href="${profileHref(n)}" data-no-i18n>${esc(n)}</a>`).join(' ')}</div>` : ''}
          </div>`;
        })()}
                ${(st.sourcePlayers || []).length ? `<div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Players brought by a tagged link</h3><span class="panel-note">they arrived by the link, then picked a name</span></div>
          ${st.sourcePlayers.map(x => `<div class="o-src-players"><b data-no-i18n>?ref=${esc(x.name)}</b> <span class="panel-note">${fmt(x.count)} player${x.count > 1 ? 's' : ''}</span><div class="o-src-names">${x.players.map(n => `<a class="badge-pill" href="${profileHref(n)}" data-no-i18n>${esc(n)}</a>`).join(' ')}</div></div>`).join('')}</div>` : ''}
                <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Day by day</h3><span class="panel-note">last 14 days</span></div>
          ${table(['Day', 'Visits', 'Devices', 'New devices', 'Players', 'New players', 'Rolls'], st.days.slice(0, 14).map(x => { const a = byDay.get(x.day) || { active: 0, fresh: 0, rolls: 0 }; return [x.day.slice(5), fmt(x.visits), fmt(x.uniq), fmt(x.fresh), fmt(a.active), fmt(a.fresh), fmt(a.rolls)]; }), 'c7')}
        </div>`;

      // ---------------- Casino
      const c = d.casino, allRounds = c.allTime.reduce((x, g) => x + g.count, 0), keeps = c.total.bet - c.total.won;
      const best = c.allTime.slice().sort((a, b) => b.count - a.count)[0];
      const tracked = c.tracked.filter(g => g.rounds).sort((a, b) => b.rounds - a.rounds);
      const netCell = x => `<span class="${x.net >= 0 ? 'o-up' : 'o-down'}">${x.net >= 0 ? '+' : '−'}${compact(Math.abs(x.net))}</span>`;
      const casinoHTML = `
        <div class="tiles">
          ${tile('Rounds played', fmt(allRounds), `most played: ${best && best.count ? GAME_NAMES[best.name] : '–'}`)}
          ${tile('Coins wagered', compact(c.total.bet), `${compact(c.total.won)} paid back`)}
          ${keeps >= 0 ? tile('The house kept', compact(keeps), `${pct(keeps, c.total.bet)} of the bets`) : tile('The house lost', compact(-keeps), 'players are ahead overall')}
          ${tile('Players who gambled', fmt(c.gamblers), `${pct(c.gamblers, c.unlocked)} of the ${fmt(c.unlocked)} who unlocked it`)}
        </div>
        <div class="grid-2 stats-sep">
          ${bars('Most played games · all time', c.allTime.slice().sort((a, b) => b.count - a.count), n => GAME_NAMES[n] || n, '', allRounds)}
          ${panel('Per game', 'counted since 11 Oct 2026', table(['Game', 'Rounds', 'Wagered', 'Paid', 'Return'], tracked.map(g => [GAME_NAMES[g.name], fmt(g.rounds), compact(g.bet), compact(g.won), pct(g.won, g.bet)]), 'c5'))}
        </div>
        <div class="grid-2 stats-sep">
          ${panel('Casino, day by day', 'last 14 days', table(['Day', 'Players', 'Rounds', 'Wagered', 'House', 'Top game'], c.daily.filter(x => x.rounds).map(x => { const topGame = Object.entries(x.games).sort((a, b) => b[1] - a[1])[0]; return [x.day.slice(5), fmt(x.players), fmt(x.rounds), compact(x.bet), `${x.bet - x.won >= 0 ? '+' : '−'}${compact(Math.abs(x.bet - x.won))}`, GAME_NAMES[topGame[0]]]; }), 'c6'))}
          ${panel('Biggest gamblers', 'all time · net = won − wagered', table(['Player', 'Rounds', 'Wagered', 'Net'], c.topWagered.map(x => [who(x.name), fmt(x.rounds), compact(x.bet), netCell(x)]), 'c4'))}
        </div>
        <div class="grid-2 stats-sep">
          ${panel('Biggest winners', 'all time', table(['Player', 'Rounds', 'Wagered', 'Net'], c.topWinners.filter(x => x.net > 0).map(x => [who(x.name), fmt(x.rounds), compact(x.bet), netCell(x)]), 'c4'))}
          ${panel('Biggest losers', 'all time', table(['Player', 'Rounds', 'Wagered', 'Net'], c.topLosers.filter(x => x.net < 0).map(x => [who(x.name), fmt(x.rounds), compact(x.bet), netCell(x)]), 'c4'))}
        </div>`;

      // ---------------- Joueurs et économie
      const pl = d.players;
      // ---------------- Crypto, levier, cadeaux, codes, messages (nouveautés d'octobre)
      const F = d.features || {};
      let cryptoHTML = '';
      {
        const levNet = (F.levIn || 0) - (F.levOut || 0), cryptoNet = (F.value || 0) - (F.invested || 0), maxDm = Math.max(1, ...(F.dms || []).map(x => x.count));
        cryptoHTML = `
          <p class="panel-note profile-sub">Game coins only. “Invested” is what players paid for the crypto they still hold; “worth now” is that crypto at today's price (${F.btcPrice ? `BTC ${fmt(Math.round(F.btcPrice))} $` : 'BTC –'} · ${F.ethPrice ? `ETH ${fmt(Math.round(F.ethPrice))} $` : 'ETH –'}).</p>
          <h2 class="o-section">Crypto</h2>
          <div class="tiles">
            ${tile('Players holding', fmt((F.btcHolders || 0) + (F.ethHolders || 0)), `${fmt(F.btcHolders || 0)} Bitcoin · ${fmt(F.ethHolders || 0)} Ethereum`)}
            ${tile('Coins invested', compact(F.invested || 0), `worth ${compact(F.value || 0)} now`)}
            ${tile('Players are', `${cryptoNet >= 0 ? '+' : '−'}${compact(Math.abs(cryptoNet))}`, cryptoNet >= 0 ? 'up on the crypto they hold' : 'down on the crypto they hold')}
            ${tile('Trades', fmt(F.trades || 0), 'buys and sells, all time')}
          </div>
          <h2 class="o-section">Leverage</h2>
          <div class="tiles">
            ${tile('Players who used it', fmt(F.levPlayers || 0), `${fmt(F.openPositions || 0)} positions open right now`)}
            ${tile('Margin put in', compact(F.levIn || 0), `${compact(F.levOut || 0)} paid back`)}
            ${tile(levNet >= 0 ? 'Players lost' : 'Players won', compact(Math.abs(levNet)), 'margin in − paid back (open positions count as lost until closed)')}
          </div>
          <div class="grid-2 stats-sep">
            ${panel('Coin gifts between friends', 'all time', `<div class="tiles">${tile('Players who gave', fmt(F.givers || 0), '')}${tile('Coins given', compact(F.giftOut || 0), '')}</div>`)}
            ${panel('Gift codes', 'times each code was used', table(['Code', 'Used'], (F.codes || []).map(x => [`<span data-no-i18n>${esc(x.name)}</span>`, fmt(x.count)]), 'c2'))}
          </div>
          ${panel('Friend messages · 7 days', 'messages sent per day (their content is private)', `<div class="o-hours o-dms">${(F.dms || []).slice().reverse().map(x => `<span class="o-hour" data-tip="${esc(`<b>${x.day}</b><br>${fmt(x.count)} messages`)}"><i style="height:${Math.max(2, (x.count / maxDm) * 100)}%"></i><em>${x.day.slice(8)}</em></span>`).join('')}</div>`).replace('class="panel"', 'class="panel stats-sep"')}`;
      }
      const playersHTML = `
        <div class="tiles">
          ${tile('Players', fmt(pl.rolled), `${fmt(R.active.week)} active in 7 days · ${fmt(R.active.month)} in 30`)}
          ${tile('Rolls, all time', compact(pl.totalRolls), `${fmt(Math.round(pl.totalRolls / Math.max(1, pl.rolled)))} per player on average`)}
          ${tile('Rolls per player per day', R.active.dauAvg ? fmt(Math.round(R.rolls.week / Math.max(1, sum(R.series.slice(0, 7), 'active')))) : '–', 'average over the last 7 days')}
          ${tile('Coins in circulation', compact(d.economy.coins), `${compact(d.economy.earned)} earned · ${compact(d.economy.spent)} spent`)}
          ${tile('Daily streak alive', fmt(pl.streaks), `${fmt(pl.questsDone)} quests claimed in all`)}
          ${tile('Top rolls ever', `${fmt(pl.top.infinite)} · ${fmt(pl.top.godlike || 0)} · ${fmt(pl.top.divine)} · ${fmt(pl.top.celestial)}`, 'Infinite · Godlike · Divine · Celestial')}
          ${tile('Duels won', fmt(pl.duelWins), 'against real players and bots')}
          ${tile('Coins spent', pct(d.economy.spent, d.economy.earned), 'of all the coins ever earned')}
        </div>
        <div class="grid-2 stats-sep">
          ${bars('How much they have rolled · players', pl.rollBuckets, n => `${n} rolls`, '', pl.rolled)}
          ${bars('Roll speed level · players', pl.speed, x => x, '', pl.named)}
          ${bars('Equipped skins', pl.skins, n => (Shop.byId.has(n) ? `${Shop.byId.get(n).emoji} ${Shop.byId.get(n).name}` : n))}
          ${bars('Equipped Generate buttons', pl.buttons, n => (Shop.buttonById.has(n) ? `${Shop.buttonById.get(n).emoji} ${Shop.buttonById.get(n).name}` : Shop.byId.has(n) ? `${Shop.byId.get(n).emoji} ${Shop.byId.get(n).name}` : n === 'match' ? 'Match my skin' : n))}
          ${bars('Wallpapers in use', pl.walls || [], n => (Shop.wallById.has(n) ? `${Shop.wallById.get(n).emoji} ${Shop.wallById.get(n).name}` : n))}
        </div>`;

      // ---------------- Nouveaux blocs (2026-10-18) et répartition dans les onglets
      const X = d.extra || {};
      const section = (title, desc) => `<h2 class="o-section">${title}</h2>${desc ? `<p class="o-section-desc">${desc}</p>` : ''}`;
      const kpi = (label, value, sub, tone = '') => `<div class="o-kpi ${tone}"><span class="o-kpi-l">${label}</span><b class="o-kpi-v">${value}</b><span class="o-kpi-s">${sub || ''}</span></div>`;
      const kpis = list => `<div class="o-kpis">${list.join('')}</div>`;
      // Jours de la semaine
      const wk = X.weekdays || [], maxWP = Math.max(1, ...wk.map(x => x.players)), maxWR = Math.max(1, ...wk.map(x => x.rolls));
      const weekdayHTML = wk.length ? panel('Activity by day of the week', 'average over the last 8 weeks · UTC days', `
        <div class="o-week">${wk.map(x => `<div class="o-wd${['Sat', 'Sun'].includes(x.name) ? ' weekend' : ''}" data-tip="${esc(`<b>${x.name}</b><br>${fmt(x.players)} players · ${fmt(x.rolls)} rolls<br>average of ${x.days} day${x.days === 1 ? '' : 's'}`)}">
          <span class="o-wd-bars"><i class="p" style="height:${(x.players / maxWP) * 100}%"></i><i class="r" style="height:${(x.rolls / maxWR) * 100}%"></i></span><em>${x.name}</em><b class="mono">${fmt(x.players)}</b></div>`).join('')}</div>
        <div class="o-legend"><span><i class="p"></i>Players</span><span><i class="r"></i>Rolls</span><span class="panel-note">weekend in orange</span></div>`) : '';
      // Économie
      const E = X.economy || [], LABEL_IN = { rolls: '🎲 Rare rolls', quests: '📋 Quests', daily: '🔥 Daily bonus', levels: '⭐ Levels', events: '🎯 Events', duels: '⚔️ Duels won', codes: '🔑 Codes', casino: '🎰 Casino payouts', crypto: '📈 Crypto sold', leverage: '📈 Leverage paid back', weekend: '🔥 Weekend Rush', other: '🎁 Other' }, LABEL_OUT = { skins: '🎨 Skins', cases: '📦 Cases', wallpapers: '🖼️ Wallpapers', buttons: '🔘 Buttons', emotes: '😎 Emotes', sounds: '🔊 Sound packs', upgrades: '⚡ Upgrades', casino: '🎰 Casino bets', crypto: '📈 Crypto bought', leverage: '📈 Leverage margin', rename: '✏️ Name changes', prestige: '👑 Prestige' };
      const tot = o => Object.values(o || {}).reduce((x, v) => x + v, 0);
      const span = (list, k) => { const out = {}; list.forEach(x => Object.entries(x[k]).forEach(([n, v]) => { out[n] = (out[n] || 0) + v; })); return out; };
      const w7 = E.slice(0, 7), in7 = tot(span(w7, 'in')), out7 = tot(span(w7, 'out')), net7 = in7 - out7, ecoDays = E.filter(x => tot(x.in) || tot(x.out)).length;
      // Masse monétaire et casino par jour (2026-10-25) : mises − gains = ce que le casino retire du jeu.
      const casinoNet = d => (d.out.casino || 0) - (d.in.casino || 0), signed = n => `${n >= 0 ? '+' : '−'}${compact(Math.abs(n))}`;
      const net0 = E[0] ? tot(E[0].in) - tot(E[0].out) : 0;
      const flowBars = (title, obj, labels) => bars(title, Object.entries(obj).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([name, count]) => ({ name, count })), n => labels[n] || n, 'last 14 days', tot(obj));
      const ecoHTML = `
        ${section('Coins', 'Coins created (in) and spent (out) every day. Gifts and duel stakes move coins between players and are not counted. If more coins come in than go out for long, skins lose their value.')}
        ${X.supply ? kpis([kpi('Total supply', compact(X.supply.total), `held by ${fmt(X.supply.holders)} player${X.supply.holders === 1 ? '' : 's'} · updated every 10 min`), kpi('Held by the top 1%', `${Math.round(X.supply.top1 * 100)}%`, 'of all coins', X.supply.top1 > 0.5 ? 'warn' : ''), kpi('Net today', signed(net0), X.supply.total ? `${((net0 / X.supply.total) * 100).toFixed(1)}% of the supply` : '', net0 > 0 ? 'warn' : 'good'), kpi('Casino net, 7 days', signed(w7.reduce((x, d) => x + casinoNet(d), 0)), 'bets minus payouts')]) : ''}
        ${kpis([kpi('Created, 7 days', compact(in7), 'coins given to players'), kpi('Spent, 7 days', compact(out7), 'coins taken back by the game'), kpi('Net, 7 days', `${net7 >= 0 ? '+' : '−'}${compact(Math.abs(net7))}`, net7 > 0 ? 'more coins in the game' : 'fewer coins in the game', net7 > 0 ? 'warn' : 'good'), kpi('Spent / created', in7 ? `${Math.round((out7 / in7) * 100)}%` : '–', 'below 70% for long = inflation')])}
        ${ecoDays < 3 ? '<p class="panel-note">Counted since 18 Oct 2026: the numbers fill in over the next days.</p>' : ''}
        <div class="grid-2 stats-sep">${flowBars('Where coins come from', span(E, 'in'), LABEL_IN)}${flowBars('Where coins go', span(E, 'out'), LABEL_OUT)}</div>
        ${panel('Day by day', 'coins in, out, the casino alone and the difference', table(['Day', 'In', 'Out', 'Casino net', 'Net'], E.filter(x => tot(x.in) || tot(x.out)).map(x => { const n = tot(x.in) - tot(x.out), cn = casinoNet(x); return [x.day.slice(5), compact(tot(x.in)), compact(tot(x.out)), `<span class="${cn >= 0 ? 'o-up' : 'o-down'}" data-tip="${esc('Bets minus payouts: positive = the casino took coins out of the game')}">${signed(cn)}</span>`, `<span class="${n > 0 ? 'o-down' : 'o-up'}">${signed(n)}</span>`]; }), 'c5')).replace('class="panel"', 'class="panel stats-sep"')}`;
      // Ventes de la boutique
      const S = (X.sales || []).filter(x => !x.caseOnly || x.owners), KIND = { skins: '🎨', walls: '🖼️', buttons: '🔘', emotes: '😎', sounds: '🔊' };
      const topSales = S.slice().sort((x, y) => y.owners * y.price - x.owners * x.price);
      const never = S.filter(x => !x.owners && !x.limited);
      const salesHTML = `
        ${section('Shop', 'How many players own each item (bought or won in a case) and what that is worth at its price. Use it to set prices and decide what to make next.')}
        ${kpis([kpi('Items owned', fmt(S.reduce((x, i) => x + i.owners, 0)), `${fmt(S.filter(x => x.owners).length)} different items`), kpi('Worth at shop price', compact(S.reduce((x, i) => x + i.owners * i.price, 0)), 'coins'), kpi('Best seller', topSales[0] && topSales[0].owners ? `${topSales[0].emoji} ${esc(topSales[0].name)}` : '–', topSales[0] ? `${fmt(topSales[0].owners)} owners` : ''), kpi('Never bought', fmt(never.length), 'items nobody owns yet', never.length ? 'warn' : '')])}
        <div class="grid-2 stats-sep">
          ${panel('Top items', 'by coins at shop price', table(['Item', 'Price', 'Owners', 'Worth'], topSales.filter(x => x.owners).slice(0, 12).map(x => [`${KIND[x.kind]} ${x.emoji} <span data-no-i18n>${esc(x.name)}</span>`, fmt(x.price), fmt(x.owners), compact(x.owners * x.price)]), 'c4'))}
          ${panel('Nobody owns these yet', 'maybe too expensive or not visible enough', never.length ? `<div class="o-src-names">${never.slice().sort((x, y) => x.price - y.price).slice(0, 12).map(x => `<span class="badge-pill">${KIND[x.kind]} ${x.emoji} <span data-no-i18n>${esc(x.name)}</span> · ${fmt(x.price)}</span>`).join(' ')}${never.length > 12 ? ` <span class="panel-note">+${never.length - 12} more</span>` : ''}</div>` : '<div class="empty">Every item has at least one owner 🎉</div>')}
        </div>`;
      // Serveur
      const H = X.health || [], h0 = H[0] || {}, routesToday = Object.entries(h0.routes || {}).sort((x, y) => y[1].max - x[1].max);
      const slowPct = h0.req ? (100 * h0.slow) / h0.req : 0, up = h0.started ? Math.max(0, Date.now() - h0.started) : 0;
      const upTxt = up ? (up > 86400000 ? `${Math.floor(up / 86400000)} d ${Math.floor(up / 3600000) % 24} h` : `${Math.floor(up / 3600000)} h ${Math.floor(up / 60000) % 60} min`) : '–';
      const NF = X.newFeatures || {};
      const serverHTML = `
        ${section('Server health', 'Counted by the game server on the VPS: every request, the slow ones (more than 2 seconds) and the errors. Today is still filling up.')}
        ${kpis([kpi('Requests today', fmt(h0.req || 0), `${fmt(H.slice(1).reduce((x, d) => x + d.req, 0))} the 6 days before`), kpi('Slow requests', `${slowPct.toFixed(slowPct < 1 ? 2 : 1)}%`, `${fmt(h0.slow || 0)} over 2 s today`, slowPct > 1 ? 'warn' : 'good'), kpi('Errors', fmt(h0.err || 0), 'server errors today', h0.err ? 'warn' : 'good'), kpi('Version online', `<span data-no-i18n>${esc(h0.version || '–')}</span>`, `running for ${upTxt}`)])}
        ${!H.some(x => x.req) ? '<p class="panel-note">Counted since 18 Oct 2026: the numbers appear within a minute of the next requests.</p>' : ''}
        <div class="grid-2 stats-sep">
          ${panel('Last 7 days', 'requests, slow ones and errors', table(['Day', 'Requests', 'Slow', 'Errors'], H.filter(x => x.req).map(x => [x.day.slice(5), fmt(x.req), `${fmt(x.slow)} <em class="o-share">${pct(x.slow, x.req)}</em>`, fmt(x.err)]), 'c4'))}
          ${panel('Slowest pages today', 'slowest single answer per API route', table(['Route', 'Requests', 'Slow', 'Slowest'], routesToday.slice(0, 10).map(([r, v]) => [`<span data-no-i18n>${esc(r)}</span>`, fmt(v.req), fmt(v.slow), `<span class="${v.max > 2000 ? 'o-down' : ''}">${v.max >= 1000 ? `${(v.max / 1000).toFixed(1)} s` : `${v.max} ms`}</span>`]), 'c4'))}
        </div>
        ${section('New features', 'Are players using what came out recently?')}
        ${kpis([kpi('Discord accounts linked', fmt(NF.discordLinks || 0), `of ${fmt(pl.named)} named players`), kpi(`${NF.event ? NF.event.emoji : '🎯'} Event this week`, fmt(NF.event ? NF.event.players : 0), NF.event ? `${esc(NF.event.title)} · ${fmt(NF.event.done)} reached ${NF.event.goal} · ${fmt(NF.event.claimed)} claimed` : ''), kpi('🔁 Déjà Vu', fmt(NF.dejavu || 0), 'players with 5+ duplicates'), kpi('🐛 Bug Hunters · 💡 Contributors', `${fmt(NF.bugHunters || 0)} · ${fmt(NF.contributors || 0)}`, 'players credited for a fixed bug / an added idea')])}`;

      pane('overview').insertAdjacentHTML('beforeend', `<div class="stats-sep">${weekdayHTML}</div>`);
      pane('players').innerHTML = `${section('Retention', '')}${retentionHTML}${section('Players', '')}${playersHTML}`;
      pane('economy').innerHTML = `${ecoHTML}${salesHTML}${section('Casino', '')}${casinoHTML}${cryptoHTML}`;
      pane('server').innerHTML = serverHTML;
      // Rappel sur la vue d'ensemble si le serveur souffre aujourd'hui (erreurs ou plus de 1 % de requêtes lentes).
      todo.server = h0.err ? `${fmt(h0.err)} server error${h0.err === 1 ? '' : 's'} today` : slowPct > 1 ? `${slowPct.toFixed(1)}% slow requests today` : null;
      drawTodo();
    }).catch(err => { if (currentView === 'owner') for (const id of ['overview', 'players', 'traffic', 'economy', 'server']) if (pane(id)) pane(id).innerHTML = denied(err); });
    // ---- Cagnotte : inscrire une contribution reçue (le joueur reçoit le skin et le titre Supporter), régler
    // l'objectif du mois et le lien de la page de dons, relire les dernières contributions.
    const drawFund = f => {
      const box = $('#o-fund');
      if (currentView !== 'owner' || !box) return;
      Fund.set({ month: f.month, cents: f.cents, count: f.count, goal: f.goal, url: f.url });
      todo.tips = (f.pending || []).length; badge('fund', todo.tips); drawTodo();
      setTimeout(() => guest(f.readOnly), 0);
      box.innerHTML = `
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Server fund</h3><span class="panel-note" data-no-i18n>${f.month} · ${euros(f.cents)} / ${euros(f.goal)} · ${f.count} contribution${f.count === 1 ? '' : 's'}</span></div>
          <span class="fund-bar"><span style="width:${Math.min(100, (f.cents / f.goal) * 100)}%"></span></span>
          <p class="panel-note o-fund-auto">${f.auto ? '🟢 Automatic: a tip whose message contains a player name gives the skin by itself.' : '⚪ Automatic attribution is off (no Ko-fi token on the server yet): record contributions by hand below.'}</p>
          ${(f.pending || []).length ? `<div class="o-fund-pending"><span class="eyebrow">Waiting for a player · ${f.pending.length}</span><span class="panel-note">These tips arrived without a recognisable player name. The amount is already counted in the month: just say who gets the skin.</span>${f.pending.map(x => `
            <form class="o-pending" data-tx="${esc(x.tx)}"><span class="o-pending-what"><b data-no-i18n>${euros(x.cents)}</b> <span class="panel-note" data-no-i18n>${suggDate(x.t)} · ${esc(x.from || '?')}</span><em data-no-i18n>${esc(x.message || '(no message)')}</em></span>
              <input class="input" name="name" maxlength="20" placeholder="Player name" aria-label="Player name" required><button class="btn">Give the skin</button><button class="btn ghost" type="button" data-dismiss title="Keep the amount in the month, give no skin">Dismiss</button><button class="btn ghost" type="button" data-remove title="A test or a mistake: also take the amount out of the month">Not a real tip</button></form>`).join('')}</div>` : ''}
          <div class="o-fund-forms">
            <form class="o-fund-form" id="o-fund-add">
              <span class="eyebrow">Record a contribution</span>
              <input class="input" name="name" maxlength="20" placeholder="Player name" aria-label="Player name" required>
              <input class="input" name="euros" inputmode="decimal" placeholder="€ (5 or 2.50)" aria-label="Amount in euros" required>
              <button class="btn-roll small">Add + give the skin</button>
              <span class="panel-note">The player gets the Supporter skin and title at once. A wrong entry? Add the same amount with a minus sign.</span>
            </form>
            <form class="o-fund-form" id="o-fund-set">
              <span class="eyebrow">Settings</span>
              <input class="input" name="goal" inputmode="decimal" value="${f.goal / 100}" aria-label="Monthly goal in euros">
              <input class="input" name="url" maxlength="200" value="${esc(f.url)}" placeholder="https://… contribution page (empty = PayPal)" aria-label="Contribution page">
              <button class="btn">Save</button>
              <span class="panel-note">Goal in euros per month, and the page the Contribute button opens.</span>
            </form>
          </div>
          <div class="grid-2">
            ${panel('Latest contributions', '', table(['When', 'Player', 'Amount'], f.log.slice(0, 12).map(x => [suggDate(x.t), `<a class="player-link" href="${profileHref(x.name)}" data-no-i18n>${esc(x.name)}</a>`, `<span class="${x.cents >= 0 ? 'o-up' : 'o-down'}" data-no-i18n>${x.cents >= 0 ? '+' : '−'}${euros(Math.abs(x.cents))}</span>`]), 'c3'))}
            ${panel('Month by month', '', table(['Month', 'Contributions', 'Total'], f.months.map(x => [x.month, fmt(x.count), `<span data-no-i18n>${euros(x.cents)}</span>`]), 'c3'))}
          </div>
        </div>`;
      const send = (form, action, pick) => form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form)), btn = form.querySelector('button');
        btn.disabled = true;
        try { drawFund(await Online.site(action, pick(data))); toast(action === 'fundAdd' ? 'Contribution recorded' : 'Saved'); }
        catch (err) { btn.disabled = false; toast([404, 422].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
      });
      send($('#o-fund-add'), 'fundAdd', d => ({ name: d.name, euros: Number(String(d.euros).replace(',', '.')) }));
      box.querySelectorAll('.o-pending').forEach(form => {
        const run = extra => Online.site('fundAssign', { tx: form.dataset.tx, ...extra }).then(next => { drawFund(next); toast(extra.dismiss ? 'Dismissed' : 'Skin given'); }).catch(err => toast([404, 422].includes(err.status) ? err.message : 'Unavailable right now, try again'));
        form.addEventListener('submit', e => { e.preventDefault(); run({ name: new FormData(form).get('name') }); });
        form.querySelector('[data-dismiss]').addEventListener('click', () => run({ dismiss: true }));
        form.querySelector('[data-remove]').addEventListener('click', () => run({ dismiss: true, remove: true }));
      });
      send($('#o-fund-set'), 'fundSet', d => ({ goal: Number(String(d.goal).replace(',', '.')), url: d.url }));
    };
    Online.site('fund').then(drawFund).catch(err => { if ($('#o-fund')) $('#o-fund').innerHTML = denied(err); });
    // ---- Signalements de messages (chat des duels, messages entre amis), du plus récent au plus ancien.
    const drawReports = d => {
      if (currentView !== 'owner' || !pane('reports')) return;
      const open = d.reports.filter(r => !r.done);
      badge('reports', open.length);
      todo.reports = open.length; drawTodo();
      const row = r => `<div class="o-report${r.done ? ' done' : ''}">
        <div class="o-report-head">${who(r.author)}${r.against > 1 ? ` <span class="o-chip warn">${r.against} reports</span>` : ''}<span class="panel-note">${esc(r.where)} · ${relTime(r.msgT)} · reported by ${who(r.reporter)}</span></div>
        <p class="o-report-text" data-no-i18n>${esc(r.text)}</p>
        ${r.done ? '<span class="panel-note">✓ Handled</span>' : d.readOnly ? '' : `<button class="btn ghost small" data-report-done="${r.id}">✓ Mark as handled</button>${r.where === 'avatar' ? ` <button class="btn ghost small" data-av-rm="${esc(r.author)}" data-av-why="inappropriate">🗑️ Remove picture</button>` : ''}`}</div>`;
      pane('reports').innerHTML = panel('Reported messages', `${fmt(open.length)} to look at · messages players reported from duel chats and private messages`,
        d.reports.length ? [...open, ...d.reports.filter(r => r.done)].map(row).join('') : '<div class="empty">No report yet.</div>');
    };
    Online.site('reports').then(drawReports).catch(err => { if (pane('reports')) pane('reports').innerHTML = denied(err); });
    // ---- Photos de profil (api/_avatar.js, 2026-10-26) : à valider avant que quiconque les voie ; retrait possible ensuite.
    let avQ = '';
    const avImg = u => (API_BASE || API_SAME) + u;
    const drawAvatars = d => {
      const box = pane('avatars'); if (currentView !== 'owner' || !box) return;
      badge('avatars', d.pending.length);
      const reasons = Object.entries(d.reasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
      const ICON = { approved: '✅', rejected: '❌', removed: '🗑️' };
      box.innerHTML = panel('Pictures to review', `${fmt(d.pending.length)} waiting · nobody else sees a picture before you approve it`,
        d.pending.length ? d.pending.map(x => `<div class="av-q" data-key="${x.key}">
          <img class="av-big" src="${x.img}" alt="">
          <div class="av-q-side">
            <div><b data-no-i18n>${esc(x.name)}</b> <span class="panel-note">${relTime(x.t)}</span></div>
            ${x.prev ? `<div class="av-prev panel-note">Current picture <img src="${avImg(x.prev)}" alt=""></div>` : '<div class="panel-note">First picture</div>'}
            <div class="av-moves"><button class="btn" data-av-ok>✅ Approve</button></div>
            <div class="av-moves"><select class="input av-reason" aria-label="Reason">${reasons}</select><button class="btn ghost" data-av-no>❌ Reject</button></div>
          </div></div>`).join('') : '<div class="empty">Nothing to review. 🎉</div>')
        + panel('Approved pictures', `${fmt(d.total)} in total`, `<form class="av-search"><input class="input" name="q" type="search" placeholder="Search a name" value="${esc(avQ)}" autocomplete="off"><button class="btn">Search</button></form>
          <div class="av-grid">${d.approved.map(a => `<div class="av-cell"><img src="${avImg(a.url)}" alt="" loading="lazy"><span data-no-i18n>${esc(a.name)}</span><button class="btn ghost small" data-av-rm="${esc(a.name)}">Remove</button></div>`).join('') || '<div class="empty">None yet.</div>'}</div>`)
        + panel('Recent decisions', 'the last 200', d.log.length ? d.log.slice(0, 60).map(l => `<div class="av-log">${ICON[l.action] || '•'} <b data-no-i18n>${esc(l.name)}</b> <span class="panel-note">${esc(l.action)}${l.reason ? ` · ${esc(l.reason)}` : ''} · ${relTime(l.t)}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>');
    };
    const avDo = (op, extra) => Online.avatar(op, { q: avQ, ...extra }).then(d => { drawAvatars(d); Avatars.load(true); return d; });
    Online.avatar('queue').then(d => { drawAvatars(d); guest(d.readOnly); }).catch(err => { if (pane('avatars')) pane('avatars').innerHTML = denied(err); });
    // Écouteurs posés une seule fois (app reste le même élément d'une visite à l'autre de la page Owner).
    if (!renderOwner.avBound) { renderOwner.avBound = true;
    app.addEventListener('click', async e => {
      if (currentView !== 'owner') return;
      const ok = e.target.closest('[data-av-ok]'), no = e.target.closest('[data-av-no]'), rm = e.target.closest('[data-av-rm]');
      if (!ok && !no && !rm) return;
      const b = ok || no || rm;
      if (rm && !confirm(window.RNGI18n ? window.RNGI18n.t('Remove this profile picture?') : 'Remove this profile picture?')) return;
      b.disabled = true;
      try {
        if (rm) { await avDo('remove', { name: rm.dataset.avRm, reason: rm.dataset.avWhy || 'other' }); toast('Picture removed'); return; }
        const q = b.closest('.av-q');
        await avDo(ok ? 'approve' : 'reject', { key: q.dataset.key, reason: no ? q.querySelector('.av-reason').value : undefined });
        toast(ok ? 'Approved' : 'Rejected');
      } catch (err) { b.disabled = false; toast(err.status && err.status < 500 ? err.message : 'Unavailable right now, try again'); }
    });
    app.addEventListener('submit', e => {
      const f = e.target.closest('.av-search'); if (!f || currentView !== 'owner') return;
      e.preventDefault(); avQ = String(new FormData(f).get('q') || '').trim();
      avDo('queue').catch(() => {});
    });
    }
    app.addEventListener('click', async e => {
      const b = e.target.closest('[data-report-done]'); if (!b || currentView !== 'owner') return;
      b.disabled = true;
      try { drawReports(await Online.site('reportDone', { id: b.dataset.reportDone })); } catch (err) { b.disabled = false; toast('Unavailable right now, try again'); }
    });
    // ---- Chat global (api/_global.js) : Modérateurs (donnés ou retirés par pseudo) et silences en cours, levés d'un clic.
    const drawChat = d => {
      const box = pane('chat'); if (currentView !== 'owner' || !box) return;
      badge('chat', d.mutes.length);
      const until = u => (u < 0 ? 'forever' : `until ${fullDate(u)}`);
      box.innerHTML = panel('Chat moderators', 'they can delete messages and mute players in the global chat', `
          <div class="im-managers">${d.mods.map(n => `<span class="chip"><span data-no-i18n>${esc(n)}</span> <button class="im-x" data-gc-mod="${esc(n)}" title="Remove">×</button></span>`).join('') || '<span class="panel-note">Nobody yet.</span>'}</div>
          <form class="im-add gc-mod-add"><input class="input" name="name" placeholder="Player name" maxlength="20" autocomplete="off"><button class="btn">Give the role</button></form>`)
        + panel('Muted players', `${fmt(d.mutes.length)} right now`, d.mutes.length ? d.mutes.map(m => `<div class="o-report gc-mute-row"><div class="o-report-head">${who(m.name)}<span class="panel-note">${until(m.until)} · by <span data-no-i18n>${esc(m.by)}</span> · ${relTime(m.t)}</span></div><button class="btn ghost small" data-gc-unmute="${esc(m.name)}">🔊 Unmute</button></div>`).join('') : '<div class="empty">Nobody is muted.</div>');
    };
    const chatRun = (action, extra) => Online.global(action, extra).then(d => { drawChat(d); guest(d.readOnly); });
    chatRun('gcAdmin').catch(err => { if (pane('chat')) pane('chat').innerHTML = denied(err); });
    // Écouteurs posés sur l'onglet lui-même (recréé à chaque visite de la page) : jamais en double.
    pane('chat').addEventListener('click', e => {
      if (currentView !== 'owner') return;
      const un = e.target.closest('[data-gc-unmute]'); if (un) { un.disabled = true; chatRun('gcUnmute', { name: un.dataset.gcUnmute }).then(() => toast('Unmuted')).catch(err => { un.disabled = false; toast(err.message || 'Unavailable right now, try again'); }); return; }
      const rm = e.target.closest('[data-gc-mod]'); if (rm && confirm(window.RNGI18n ? window.RNGI18n.t('Remove this moderator?') : 'Remove this moderator?')) chatRun('gcModSet', { name: rm.dataset.gcMod, on: false }).catch(err => toast(err.message || 'Unavailable right now, try again'));
    });
    pane('chat').addEventListener('submit', e => {
      const f = e.target.closest('.gc-mod-add'); if (!f || currentView !== 'owner') return;
      e.preventDefault(); const n = f.elements.name.value.trim(); if (!n) return;
      chatRun('gcModSet', { name: n, on: true }).then(() => toast('Role given')).catch(err => toast(err.message || 'Unavailable right now, try again'));
    });
    // ---- Annonces (idée de jaxoncool43, 2026-10-26) : titre + texte (500 caractères), « important » = notification
    // une fois chez chaque joueur, et Discord si le salon est configuré. Les 20 dernières, chacune supprimable.
    const drawAnn = d => {
      const box = pane('announce'); if (currentView !== 'owner' || !box) return;
      const keep = box.querySelector('.ann-form') && !d.posted ? { t: box.querySelector('[name=title]').value, x: box.querySelector('[name=text]').value } : null;
      box.innerHTML = panel('New announcement', 'players see it at the top of 📰 What\'s new, with a red dot', `
          <form class="ann-form"><input class="input" name="title" maxlength="80" placeholder="Title" autocomplete="off" required>
          <textarea class="input" name="text" maxlength="500" rows="4" placeholder="Short announcement (500 characters max)" required></textarea>
          <div class="ann-opts"><label><input type="checkbox" name="important"> Important (shown once as a notification)</label>
          <label><input type="checkbox" name="discord" checked> Also post on Discord${d.discordReady ? '' : ' <span class="panel-note">(no Discord channel set up: skipped)</span>'}</label></div>
          <div class="ann-foot"><span class="panel-note mono" data-ann-count>0 / 500</span><button class="btn-roll small">📣 Publish</button></div></form>`)
        + panel('Published', `${fmt(d.list.length)} of the last 20`, d.list.length ? d.list.map(a => `<div class="o-report ann-row"><div class="o-report-head"><b data-no-i18n>${a.important ? '❗ ' : ''}${esc(a.title)}</b><span class="panel-note">${relTime(a.t)}</span></div><p class="ann-text" data-no-i18n>${esc(a.text)}</p><button class="btn ghost small" data-ann-del="${esc(a.id)}">🗑️ Delete</button></div>`).join('') : '<div class="empty">No announcement yet.</div>');
      if (keep) { box.querySelector('[name=title]').value = keep.t; box.querySelector('[name=text]').value = keep.x; }
      guest(d.readOnly);
    };
    Online.site('annList').then(drawAnn).catch(err => { if (pane('announce')) pane('announce').innerHTML = denied(err); });
    pane('announce').addEventListener('input', e => { const c = pane('announce').querySelector('[data-ann-count]'); if (c && e.target.name === 'text') c.textContent = `${e.target.value.length} / 500`; });
    pane('announce').addEventListener('click', e => {
      const del = e.target.closest('[data-ann-del]'); if (!del || currentView !== 'owner') return;
      if (!confirm(window.RNGI18n ? window.RNGI18n.t('Delete this announcement?') : 'Delete this announcement?')) return;
      del.disabled = true;
      Online.site('annDelete', { id: del.dataset.annDel }).then(d => { drawAnn(d); toast('Deleted'); }).catch(err => { del.disabled = false; toast(err.message || 'Unavailable right now, try again'); });
    });
    pane('announce').addEventListener('submit', e => {
      const f = e.target.closest('.ann-form'); if (!f || currentView !== 'owner') return;
      e.preventDefault();
      const btn = f.querySelector('button'); btn.disabled = true;
      Online.site('annAdd', { title: f.elements.title.value, text: f.elements.text.value, important: f.elements.important.checked, discord: f.elements.discord.checked })
        .then(d => { drawAnn(d); toast(f.elements.discord.checked && !d.discord ? 'Published (not on Discord: no channel set up)' : 'Published'); announcements = d.list; paintNewsDot(); })
        .catch(err => { btn.disabled = false; toast(err.message || 'Unavailable right now, try again'); });
    });
    const drawInbox = data => {
      const box = $('#o-inbox');
      if (currentView !== 'owner' || !box) return;
      $('#o-count').textContent = `${data.total} received`;
      todo.ideas = data.suggestions.filter(x => x.status === 'new').length; todo.decide = data.suggestions.filter(x => x.status === 'seen').length; badge('inbox', todo.ideas); drawTodo();
      setTimeout(() => guest(data.readOnly), 0);
      Inbox.seen(Math.max(0, ...data.suggestions.map(x => x.t)));
      // Une suggestion par statut, rangée dans son onglet : à lire (nouvelle, ou le joueur a répondu), à décider (lue,
      // rien de choisi), prévue, ajoutée, pas prévue. Chaque carte se range d'un clic ; l'onglet choisi est retenu.
      inboxData = data;
      drawInboxList();
    };
    const INBOX_TABS = [
      ['new', '📥', 'To read', 'New suggestions and player replies'],
      ['seen', '🤔', 'To decide', 'Read, but not sorted yet: plan it, mark it added, or decline it'],
      ['planned', '📌', 'Planned', 'Your to-do list: the player sees “Planned”'],
      ['done', '✅', 'Added', 'Already in the game'],
      ['declined', '🚫', 'Not planned', 'Ideas you decided not to do'],
      ['all', '🗂️', 'All', 'Every suggestion'],
    ];
    const MOVES = { seen: ['🤔', 'To decide'], planned: ['📌', 'Plan'], done: ['✅', 'Added'], declined: ['🚫', 'Decline'] };
    let inboxData = null;
    // Boîte de réception en liste compacte : une ligne par suggestion (nom, aperçu, date), un clic l'ouvre en dessous.
    // Après un tri (Plan, Added, Decline…), la suivante de la liste s'ouvre seule : on enchaîne sans chercher.
    const inboxState = { tab: Store.settings.inboxTab || '', q: '', kind: '', sort: 'new', open: '', limit: 50 };
    const replied = x => x.thread.length > 0 && x.thread[x.thread.length - 1].from === 'player';
    const inboxList = tab => {
      const data = inboxData, q = inboxState.q.trim().toLowerCase();
      const list = data.suggestions
        .filter(x => tab === 'all' || x.status === tab)
        .filter(x => !inboxState.kind || x.kind === inboxState.kind)
        .filter(x => !q || `${x.name} ${x.text} ${x.thread.map(m => m.text).join(' ')}`.toLowerCase().includes(q));
      const last = x => Math.max(x.t, ...x.thread.map(m => m.t || 0));
      return list.sort(inboxState.sort === 'old' ? (a, b) => a.t - b.t : (a, b) => last(b) - last(a));
    };
    const inboxTab = () => {
      const data = inboxData, count = k => (k === 'all' ? data.suggestions.length : data.suggestions.filter(x => x.status === k).length);
      return INBOX_TABS.some(t => t[0] === inboxState.tab) ? inboxState.tab : count('new') ? 'new' : count('seen') ? 'seen' : 'planned';
    };
    const drawInboxList = () => {
      const box = $('#o-inbox'), data = inboxData;
      if (!box || !data) return;
      if (!data.suggestions.length) { box.innerHTML = '<div class="empty">No suggestion yet.</div>'; return; }
      const count = k => (k === 'all' ? data.suggestions.length : data.suggestions.filter(x => x.status === k).length);
      const tab = inboxTab(), list = inboxList(tab), shown = list.slice(0, inboxState.limit);
      const detail = x => `
          <div class="ib-detail">
            <div class="ib-meta"><a class="player-link" href="${profileHref(x.name)}">${esc(x.name)}</a> · ${suggDate(x.t)} · ${x.lang || '?'} · <span class="o-pill st-${x.status}">${SUGG_STATUS[x.status]}</span><button class="btn ghost o-del" data-o="delete" title="Delete">🗑</button></div>
            <p class="idea-body" data-no-i18n>${esc(x.text)}</p>
            ${x.shots ? `<div class="o-shot" data-shot="${x.id}" data-n="${x.shots}"><button class="btn ghost" data-o="shot">📎 View the ${x.shots > 1 ? `${x.shots} images` : 'screenshot'}</button></div>` : ''}
            ${imReviewsHTML(x.reviews)}
            ${threadHTML(x.thread, 'Player')}
            <div class="o-reply"><input class="input" maxlength="300" placeholder="${x.thread.length ? 'Reply in this conversation…' : 'Reply to the player (they can answer back)'}"><button class="btn" data-o="reply">Send reply</button></div>
            <div class="o-moves">
              ${Object.entries(MOVES).filter(([k]) => k !== x.status).map(([k, [e, l]]) => `<button class="btn${k === 'planned' || k === 'done' ? '' : ' ghost'} o-move" data-o="move" data-st="${k}">${e} ${l}</button>`).join('')}
              ${x.status === 'new' ? '<button class="btn ghost" data-o="read">✓ Mark as read</button>' : '<button class="btn ghost" data-o="unread">↩ Not read</button>'}
            </div>
          </div>`;
      const row = x => {
        const open = x.id === inboxState.open;
        return `
        <div class="idea-row ib-row${x.status === 'new' ? ' unread' : ''}${open ? ' open' : ''}" data-id="${x.id}" data-status="${x.status}">
          <button class="ib-line" data-o="toggle" aria-expanded="${open}">
            <span class="ib-kind" title="${x.kind === 'bug' ? 'Bug' : 'Idea'}">${x.kind === 'bug' ? '🐞' : '💡'}</span>
            <b class="ib-name">${esc(x.name)}</b>
            <span class="ib-text" data-no-i18n>${esc(x.text)}</span>
            ${x.reviews && x.reviews.length ? `<span class="ib-n" title="Idea Manager reviews">${x.reviews.map(r => IM_V[r.verdict][0]).join('')}</span>` : ''}
            ${replied(x) ? '<span class="o-pill reply">💬 replied</span>' : x.thread.length ? `<span class="ib-n" title="Messages">💬 ${x.thread.length}</span>` : ''}
            ${x.shots ? `<span class="ib-n" title="Images">📎${x.shots > 1 ? ` ${x.shots}` : ''}</span>` : ''}
            ${tab === 'all' ? `<span class="o-pill st-${x.status}">${SUGG_STATUS[x.status]}</span>` : ''}
            <span class="ib-date">${suggDate(x.t)}</span>
          </button>
          ${open ? detail(x) : ''}
        </div>`;
      };
      const info = INBOX_TABS.find(t => t[0] === tab);
      const focused = document.activeElement && document.activeElement.id === 'o-inbox-q';
      const kinds = [['', 'All types'], ['idea', '💡 Ideas'], ['bug', '🐞 Bugs']];
      box.innerHTML = `
        <div class="o-inbox-tabs" role="tablist">${INBOX_TABS.map(([k, e, l]) => { const n = count(k); return `<button role="tab" data-itab="${k}" class="${k === tab ? 'on' : ''}${k === 'new' && n ? ' hot' : ''}">${e} <span>${l}</span> <b>${n}</b></button>`; }).join('')}</div>
        <div class="o-inbox-head">
          <p class="panel-note o-inbox-hint">${info[3]}</p>
          <div class="o-inbox-tools">
            <input class="input" id="o-inbox-q" type="search" placeholder="Search a name or a word…" value="${esc(inboxState.q)}" autocomplete="off">
            <span class="ib-seg">${kinds.map(([k, l]) => `<button class="${inboxState.kind === k ? 'on' : ''}" data-ikind="${k}">${l}</button>`).join('')}</span>
            <span class="ib-seg"><button class="${inboxState.sort === 'new' ? 'on' : ''}" data-isort="new">Latest activity</button><button class="${inboxState.sort === 'old' ? 'on' : ''}" data-isort="old">Oldest first</button></span>
            ${tab === 'new' && count('new') > 1 ? '<button class="btn ghost" data-o="readall">✓ Mark all as read</button>' : ''}
          </div>
        </div>
        <p class="panel-note ib-count">${list.length} suggestion${list.length === 1 ? '' : 's'}${list.length > shown.length ? ` · showing ${shown.length}` : ''} · click one to open it</p>
        <div class="ib-list">${shown.length ? shown.map(row).join('') : `<div class="empty">${inboxState.q || inboxState.kind ? 'Nothing matches.' : tab === 'new' ? 'You have read everything. 🎉' : tab === 'seen' ? 'Everything is sorted. 🎉' : 'Nothing here yet.'}</div>`}</div>
        ${list.length > shown.length ? `<div class="actions" style="justify-content:center"><button class="btn ghost" data-o="more">Show more (${list.length - shown.length} left)</button></div>` : ''}`;
      if (focused) { const i = $('#o-inbox-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
      const op = box.querySelector('.ib-row.open');
      if (op && op.getBoundingClientRect().top < 0) op.scrollIntoView({ block: 'start' });
    };
    const act = (action, extra) => Online.site(action, extra).then(drawInbox).catch(err => toast(err.status === 403 ? 'Owner only' : 'Unavailable right now, try again'));
    $('#o-inbox').addEventListener('input', e => { if (e.target.id === 'o-inbox-q') { inboxState.q = e.target.value; inboxState.limit = 50; drawInboxList(); } });
    // Après un tri : ouvre la suivante dans l'onglet courant (celle qui venait juste après).
    const nextOpen = id => { const l = inboxList(inboxTab()).map(x => x.id), k = l.indexOf(id); return k >= 0 && k + 1 < l.length ? l[k + 1] : ''; };
    $('#o-inbox').addEventListener('click', e => {
      const tabBtn = e.target.closest('[data-itab]');
      if (tabBtn) { inboxState.tab = tabBtn.dataset.itab; inboxState.open = ''; inboxState.limit = 50; Store.setSetting('inboxTab', inboxState.tab); drawInboxList(); return; }
      const kindBtn = e.target.closest('[data-ikind]'), sortBtn = e.target.closest('[data-isort]');
      if (kindBtn) { inboxState.kind = kindBtn.dataset.ikind; inboxState.limit = 50; drawInboxList(); return; }
      if (sortBtn) { inboxState.sort = sortBtn.dataset.isort; drawInboxList(); return; }
      const btn = e.target.closest('[data-o]'), row = e.target.closest('.idea-row');
      if (btn && btn.dataset.o === 'readall') {
        // L'une après l'autre : chaque réponse est la boîte entière, la dernière est la bonne.
        btn.disabled = true;
        const ids = [...$('#o-inbox').querySelectorAll('.idea-row.unread')].map(r => r.dataset.id);
        ids.reduce((p, id, i) => p.then(() => Online.site('mark', { id, status: 'seen' })), Promise.resolve()).then(drawInbox).catch(() => { toast('Unavailable right now, try again'); btn.disabled = false; });
        return;
      }
      if (btn && btn.dataset.o === 'more') { inboxState.limit += 50; drawInboxList(); return; }
      if (!btn || !row) return;
      if (btn.dataset.o === 'toggle') {
        const id = row.dataset.id; inboxState.open = inboxState.open === id ? '' : id; drawInboxList();
        // Ouvrir une nouvelle suggestion la marque lue, sans la sortir de la vue tout de suite.
        return;
      }
      // Capture d'écran d'un bug : chargée seulement quand on la demande (elle pèse jusqu'à ~150 Ko).
      if (btn.dataset.o === 'shot') {
        btn.disabled = true;
        const box = btn.parentElement, n = Number(box.dataset.n) || 1;
        Promise.all(Array.from({ length: n }, (_, k) => Online.site('shot', { id: row.dataset.id, i: k + 1 }))).then(rs => {
          box.innerHTML = rs.map(() => '<img alt="Image sent with the message" title="Click to enlarge">').join('');
          box.querySelectorAll('img').forEach((img, k) => { img.src = rs[k].shot; img.addEventListener('click', () => box.classList.toggle('big')); });
        })
          .catch(err => { btn.disabled = false; toast(err.status === 404 ? err.message : 'Unavailable right now, try again'); });
        return;
      }
      if (btn.dataset.o === 'read' || btn.dataset.o === 'unread') { if (inboxTab() !== 'all') inboxState.open = nextOpen(row.dataset.id); act('mark', { id: row.dataset.id, status: btn.dataset.o === 'read' ? 'seen' : 'new' }); return; }
      if (btn.dataset.o === 'move') { const id = row.dataset.id, nx = inboxTab() === 'all' ? id : nextOpen(id); inboxState.open = nx; act('mark', { id, status: btn.dataset.st }).then(() => toast(`Moved to ${INBOX_TABS.find(t => t[0] === btn.dataset.st)[2]}`)); return; }
      if (btn.dataset.o === 'delete') { if (confirm(window.RNGI18n.t('Delete this suggestion?'))) act('delete', { id: row.dataset.id }); } else if (row.querySelector('.o-reply input').value.trim()) act('mark', { id: row.dataset.id, reply: row.querySelector('.o-reply input').value }).then(() => toast('Reply sent')); else toast('Write a few words first');
    });
    Online.site('inbox').then(drawInbox).catch(err => { if ($('#o-inbox')) $('#o-inbox').innerHTML = denied(err); });
    mountIdeaManager($('#o-im'), true);
  }

  // ---------------------------------------------------------------- accueil d'un nouveau joueur : 3 écrans
  // Montré une fois, à la première visite (aucun tirage, pas de pseudo) ; rejouable depuis « How it works ».
  function openIntro() {
    const demo = analysis(123321);
    const mini = (n, skin, tier = 'rare') => `<div class="num-card sm${skin ? skinClass(skin) : ''}" data-tier="${tier}">${slotsHTML(String(n))}</div>`;
    const slides = [
      { emoji: '🎲', title: 'Every number hides badges',
        visual: `<div class="num-card md" data-tier="${demo.tier}">${slotsHTML(demo.str)}</div><div class="pill-row">${demo.groups.slice(0, 3).map(g => `<span class="badge-pill" data-tier="${g.badge.tier}">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join('')}</div><span class="ep-pill">${fmt(demo.total)} XP</span>`,
        text: `Hit Generate to roll a number from 0 to 1,000,000. Each pattern in it is a badge worth XP: the rarer the badge, the more XP. There are ${Engine.badges.length} badges to collect.` },
      { emoji: '⚔️', title: 'Duel your friends, live',
        visual: `<div class="intro-vs">${mini(777420, 'fire', 'epic')}<b>VS</b>${mini(372368, 'ocean')}</div>`,
        text: 'Create a duel, share the code, and everyone rolls at the same time. The highest roll wins the round. Nobody around? Play against bots.' },
      { emoji: '🪙', title: 'Earn coins, unlock skins',
        visual: `<div class="intro-vs">${mini(235, 'neon')}${mini(711, 'gold')}${mini(42, 'blocks')}</div>`,
        text: 'Every roll earns coins. So do the daily quests and your duel wins. Spend them in the Shop on skins and cases that change how your number looks.' },
    ];
    let at = 0;
    const done = () => { Store.setSetting('onboarded', true); };
    openModal(`<div class="intro" id="intro"></div>`, () => {
      const draw = () => {
        const sl = slides[at], last = at === slides.length - 1;
        $('#intro').innerHTML = `
          <div class="intro-visual">${sl.visual}</div>
          <h2>${sl.emoji} ${sl.title}</h2>
          <p class="intro-text">${sl.text}</p>
          <div class="intro-dots">${slides.map((_, i) => `<i class="${i === at ? 'on' : ''}"></i>`).join('')}</div>
          <div class="intro-buttons">
            ${last ? '' : '<button class="btn ghost" data-onboard-skip>Skip</button>'}
            ${at ? '<button class="btn" data-intro-back>Back</button>' : ''}
            <button class="btn-roll small" data-intro-next>${last ? '🎲 Roll my first number' : 'Next'}</button>
          </div>`;
      };
      draw();
      done(); // vu = on ne le remontre plus, même fermé par la croix
      $('#intro').addEventListener('click', e => {
        if (e.target.closest('[data-onboard-skip]')) return closeModal();
        if (e.target.closest('[data-intro-back]')) { at--; return draw(); }
        if (e.target.closest('[data-intro-next]')) {
          if (at < slides.length - 1) { at++; return draw(); }
          closeModal();
          if (location.hash.replace(/^#\/?/, '')) location.hash = '#/';
          setTimeout(startRoll, 60);
        }
      });
    });
  }

  // ---------------------------------------------------------------- amis
  let friendsTimer = 0;
  function renderFriends() {
    currentView = 'friends';
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Profile &amp; Friends</h1>
        ${Store.player.name ? `<div class="panel me-panel" id="f-me">
          <div class="panel-head"><h3 class="panel-title">My profile</h3><span class="panel-note" data-no-i18n>${esc(Store.player.name)}</span></div>
          <div class="me-row" id="f-me-body"><div class="empty">Loading…</div></div>
          <div class="discord-link" id="f-discord"></div>
          <div class="actions"><a class="btn-roll small" href="${profileHref(Store.player.name)}">Open my profile</a><button class="btn" id="f-settings">⚙️ Player &amp; settings</button></div>
        </div>` : ''}
        <a class="panel cl-entry" href="#/clan"><span class="cl-emoji" aria-hidden="true">🏯</span><span><b>Clans</b><small>Team up, share a vault, chat and fight clan wars</small></span><span aria-hidden="true">›</span></a>
        <h2 class="panel-title" style="margin:1.4rem 0 .35rem">Friends</h2>
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
    // Mon profil, en résumé (fusion des onglets Profil et Amis, 2026-10-16).
    if ($('#f-settings')) $('#f-settings').addEventListener('click', openSettings);
    if ($('#f-discord')) drawDiscordLink();
    if (Store.player.name) Online.profile(Store.player.name).then(p => {
      const box = $('#f-me-body'); if (!box) return;
      const t = p.title ? titleHTML(p.title) : '';
      box.innerHTML = `
        ${t ? `<div class="me-title">${t}</div>` : ''}
        <div class="tiles me-tiles">
          <button class="tile tile-btn" id="f-level" title="See the level rewards road"><div class="l">Level</div><div class="v">${p.level != null ? `⭐ ${fmt(p.level)}` : '–'}</div><div class="s" id="f-level-sub">🛣️ See all rewards</div></button>
          ${tile('Lifetime XP', compact(p.lifetime), `${fmt(p.rolls)} rolls`)}
          ${tile('Best roll', p.best && p.best[0] ? analysis(p.best[0].n).str : '–', p.best && p.best[0] ? `${fmt(p.best[0].s)} XP` : '')}
          ${tile('All-time rank', p.rank ? '#' + p.rank : '–', 'best single roll')}
        </div>`;
      // Le niveau détaillé (récompenses en attente) vient des quêtes : la tuile ouvre la route, et signale ce qu'il y a à prendre.
      Online.quests().then(q => {
        const btn = $('#f-level'); if (!btn || !q.level) return;
        if (q.level.pending) { btn.classList.add('ready'); $('#f-level-sub').textContent = `🎁 ${q.level.pending} reward${q.level.pending > 1 ? 's' : ''} to claim`; }
        btn.onclick = () => openLevelRoad(q.level);
        document.addEventListener('rng:level', e => { if ($('#f-level')) { btn.classList.remove('ready'); $('#f-level-sub').textContent = '🛣️ See all rewards'; btn.onclick = () => openLevelRoad(e.detail.level); } }, { once: true });
      }).catch(() => {});
    }).catch(() => { const box = $('#f-me-body'); if (box) box.innerHTML = '<div class="empty">Roll once to start your profile.</div>'; });
    $('#f-body').addEventListener('click', e => {
      const btn = e.target.closest('[data-fr]');
      if (!btn) return;
      if (btn.dataset.fr === 'remove' && !confirm(window.RNGI18n.t(`Remove ${btn.dataset.name} from your friends?`))) return;
      if (btn.dataset.fr === 'gift') { openGift(btn.dataset.name); return; }
      if (btn.dataset.fr === 'chat') { openChat(btn.dataset.name); return; }
      friendAction(btn.dataset.fr, btn.dataset.name);
    });
    drawFriends();
    checkGifts();
  }
  // Pièces offertes à un ami (api/friends.js, action « gift ») : le serveur vérifie tout (amitié, 30 tirages, 10 à 500
  // pièces, 1 000 données et 2 000 reçues par jour, solde). La fenêtre affiche ce qu'il reste à donner aujourd'hui.
  let friendsState = null;
  function openGift(name) {
    const g = friendsState && friendsState.gift;
    if (!g) return;
    const locked = g.myRolls < g.rolls, most = Math.min(g.max, g.left, Math.max(0, g.coins));
    const start = Math.min(100, most) >= g.min ? Math.min(100, most) : g.min;
    openModal(`
      <h2>Give coins to <span data-no-i18n>${esc(name)}</span></h2>
      <p class="panel-note" style="margin:-.3rem 0 1rem">From ${g.min} to ${g.max} coins per gift. Up to ${fmt(g.sendDay)} a day, and a friend can receive up to ${fmt(g.receiveDay)} a day.</p>
      <form id="gift-form">
        <div class="chips-row gift-presets">${[50, 100, 250, 500].map(v => `<button type="button" class="chip${v === start ? ' on' : ''}" data-amt="${v}"${v > most ? ' disabled' : ''}>🪙 ${v}</button>`).join('')}</div>
        <input class="input" id="gift-amount" type="number" inputmode="numeric" min="${g.min}" max="${g.max}" step="1" value="${start}" aria-label="Amount" style="width:100%">
        <p class="panel-note gift-left">${locked ? `🔒 Gifts unlock after ${g.rolls} rolls (you have ${fmt(g.myRolls)})` : g.left > 0 ? `You can still give ${fmt(g.left)} coins today` : 'You gave all you can today: come back tomorrow'} · You have 🪙 ${fmt(g.coins)}</p>
        <p class="field-error" id="gift-error" hidden></p>
        <div class="actions"><button class="btn-roll small" type="submit"${locked || !g.left ? ' disabled' : ''}>Send gift</button></div>
      </form>`, m => {
      const input = m.querySelector('#gift-amount'), errorEl = m.querySelector('#gift-error'), submit = m.querySelector('#gift-form button[type=submit]');
      const sync = () => m.querySelectorAll('[data-amt]').forEach(c => c.classList.toggle('on', Number(c.dataset.amt) === Number(input.value)));
      m.querySelector('.gift-presets').addEventListener('click', e => { const c = e.target.closest('[data-amt]'); if (!c || c.disabled) return; input.value = c.dataset.amt; sync(); input.focus(); });
      input.addEventListener('input', sync);
      if (!locked && g.left) input.focus();
      m.querySelector('#gift-form').addEventListener('submit', async e => {
        e.preventDefault();
        const amount = Number(input.value);
        if (!Number.isInteger(amount) || amount < g.min || amount > g.max) { errorEl.textContent = `Give between ${g.min} and ${g.max} coins`; errorEl.hidden = false; input.focus(); return; }
        submit.disabled = true;
        try {
          const state = await Online.friends('gift', name, { amount });
          Store.setSetting('coins', state.gift.coins);
          closeModal();
          toast(`🎁 You sent ${fmt(state.sent.amount)} coins to ${state.sent.name}`, 4000, 'achv');
          Sound.play('lock', { i: 3 });
          if (currentView === 'friends') drawFriends(state);
        } catch (err) {
          submit.disabled = false;
          errorEl.textContent = [400, 403, 404, 422, 429].includes(err.status) ? err.message : 'Unavailable right now, try again';
          errorEl.hidden = false;
        }
      });
    });
  }
  // Cadeaux reçus depuis la dernière fois : annoncés une seule fois (le serveur les marque vus), au chargement du jeu
  // et à l'ouverture des amis. Le solde gardé sur l'appareil suit.
  // ---- Messages entre amis (api/friends.js) : une fenêtre de conversation par ami, relue toutes les 4 s tant qu'elle
  // est ouverte. Le filtre du chat des duels s'applique côté serveur ; on peut bloquer un ami depuis la fenêtre.
  // Présence pour la liste d'amis : « afk » si l'onglet est caché ou sans action depuis 5 min, sinon « active ».
  let lastInput = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));
  const presenceState = () => (document.hidden || Date.now() - lastInput > 5 * 60000 ? 'afk' : 'active');
  const Messages = {
    count: 0, timer: 0,
    // Nouveau message pendant qu'on joue ailleurs : un petit message en bas, qui ouvre les amis (idée de
    // JAKECisthebest, 2026-10-20). Relu toutes les 60 s au lieu de 3 min.
    set(n) { if (n > this.count && this.seenOnce && currentView !== 'friends' && !$('.dm-list')) toast(`💬 ${n - this.count === 1 ? 'New message from a friend' : `${n - this.count} new messages from friends`} · open Friends`, 4500); this.seenOnce = true; this.count = n; const link = document.querySelector('.nav a[data-route="friends"], a[data-route="friends"]'); if (link) link.classList.toggle('has-msg', n > 0); },
    watch() { if (this.timer || !Store.player.name) return; const tick = () => { if (Store.player.name) Online.friends('gifts', undefined, { presence: presenceState(), ...bigAlertSince() }).then(r => { this.set(r.messages || 0); if (r.big) announceBigRolls(r.big); if (r.gifts && r.gifts.length && (currentView === 'friends' || r.gifts.some(g => g.kind === 'top'))) announceGifts(r); }).catch(() => {}); }; this.timer = setInterval(tick, 60000); setTimeout(tick, 4000); },
  };
  // Réduit une image choisie par le joueur en JPEG de 190 000 caractères au plus (capture d'un bug, image entre amis).
  const shrinkImage = (file, max = 190000) => new Promise((done, fail) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let side = 1600, q = .82, out = '';
      for (let k = 0; k < 12; k++) {
        const r = Math.min(1, side / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', q);
        if (out.length <= max) return done(out);
        if (q > .5) q -= .12; else side = Math.round(side * .8);
      }
      fail(new Error('too big'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('not an image')); };
    img.src = url;
  });
  function openChat(name) {
    let poll = 0, sig = '';
    const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    openModal(`
      <div class="dm-head"><h2>💬 <span data-no-i18n>${esc(name)}</span></h2><button class="btn ghost" id="dm-block"></button></div>
      <p class="panel-note dm-note">Only you two can read this. Messages are filtered and deleted after 7 days. Never share personal details.</p>
      <div class="dm-list" id="dm-list" aria-live="polite"><div class="empty">Loading…</div></div>
      <form class="dm-form" id="dm-form"><label class="btn ghost dm-pic" title="Send an image or a screenshot (you can also paste it with Ctrl/Cmd + V)">📷<input type="file" id="dm-file" accept="image/*" hidden></label><input class="input" id="dm-text" maxlength="140" placeholder="Write a message…" autocomplete="off" aria-label="Message"><button class="btn-roll small">Send</button></form>`, m => {
      const list = m.querySelector('#dm-list'), input = m.querySelector('#dm-text'), form = m.querySelector('#dm-form'), block = m.querySelector('#dm-block'), file = m.querySelector('#dm-file');
      const imgs = new Map();
      // Une image choisie (📷), collée (Ctrl/Cmd + V) ou glissée dans la conversation part tout de suite.
      const sendImage = async f => {
        if (!f || !/^image\//.test(f.type)) { if (f) toast('Pick an image'); return; }
        if (f.size > 25e6) { toast('This image is too big'); return; }
        let image;
        try { image = await shrinkImage(f); } catch (err) { toast('This image could not be read: try another one'); return; }
        try { draw(await Online.friends('message', name, { text: input.value, image })); input.value = ''; list.scrollTop = list.scrollHeight; }
        catch (err) { toast([403, 422, 429].includes(err.status) ? err.message : 'Could not send your image, try again'); }
      };
      file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; sendImage(f); });
      m.addEventListener('paste', e => {
        const cd = e.clipboardData; if (!cd || input.disabled) return;
        // Selon le navigateur, l'image collée est dans files (Safari) ou dans items (Chrome, Firefox).
        const f = [...(cd.files || [])].find(x => /^image\//.test(x.type)) || ([...(cd.items || [])].find(x => x.kind === 'file' && /^image\//.test(x.type)) || { getAsFile: () => null }).getAsFile();
        if (!f) return;
        e.preventDefault(); sendImage(f);
      });
      list.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
      list.addEventListener('drop', e => { const f = [...e.dataTransfer.files].find(x => /^image\//.test(x.type)); if (f) { e.preventDefault(); sendImage(f); } });
      const draw = d => {
        block.textContent = d.blocked ? 'Unblock' : '🚫 Block';
        block.dataset.blocked = d.blocked ? '1' : '';
        input.disabled = d.blocked; input.placeholder = d.blocked ? 'You blocked this player' : 'Write a message…';
        const html = d.messages.length ? d.messages.map(x => `<p class="dm-msg ${x.me ? 'me' : 'them'}">${x.img ? `<img class="dm-img" data-dm-img="${x.t}" alt="Image" title="Click to enlarge">` : ''}${x.text ? `<span data-no-i18n>${esc(x.text)}</span>` : ''}<i>${time(x.t)}${x.edited ? ' · edited' : ''}${x.me ? ` · <button class="dm-report" data-dm-edit="${x.t}" data-text="${esc(x.text)}" title="Edit this message">Edit</button> · <button class="dm-report" data-dm-unsend="${x.t}" title="Delete this message">Delete</button>` : ` · <button class="dm-report" data-dm-report="${x.t}" title="Report this message to the creator of the game">Report</button>`}</i></p>`).join('') : '<div class="empty">No message yet. Say hi!</div>';
        if (html === sig) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        sig = html; list.innerHTML = html;
        // Images : chargées une fois chacune, puis gardées tant que la conversation est ouverte.
        list.querySelectorAll('[data-dm-img]').forEach(im => {
          const t = Number(im.dataset.dmImg);
          if (imgs.has(t)) { im.src = imgs.get(t); return; }
          Online.friends('image', name, { t }).then(r => { imgs.set(t, r.image); list.querySelectorAll(`[data-dm-img="${t}"]`).forEach(x => { x.src = r.image; }); }).catch(() => { im.replaceWith(Object.assign(document.createElement('i'), { className: 'dm-gone', textContent: '🖼️ image expired' })); });
        });
        if (atBottom || !list.dataset.ready) list.scrollTop = list.scrollHeight;
        list.dataset.ready = '1';
      };
      const load = () => Online.friends('messages', name).then(d => { if (m.isConnected) draw(d); }).catch(() => {});
      const loop = () => { if (!m.isConnected) { clearInterval(poll); checkGifts(); if (currentView === 'friends') drawFriends(); return; } if (!document.hidden) load(); };
      poll = setInterval(loop, 4000);
      load();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!input.value.trim()) return;
        const btn = form.querySelector('button'); btn.disabled = true;
        try { draw(await Online.friends('message', name, { text: input.value })); input.value = ''; list.scrollTop = list.scrollHeight; }
        catch (err) { toast([403, 422, 429].includes(err.status) ? err.message : 'Could not send your message, try again'); }
        btn.disabled = false; input.focus();
      });
      list.addEventListener('click', async e => {
        const pic = e.target.closest('.dm-img'); if (pic) { pic.classList.toggle('big'); return; }
        const rep = e.target.closest('[data-dm-report]'); if (rep) { reportMessage(rep, () => Online.friends('report', name, { t: Number(rep.dataset.dmReport) })); return; }
        const ed = e.target.closest('[data-dm-edit]');
        if (ed) {
          const v = prompt(window.RNGI18n ? window.RNGI18n.t('Edit your message') : 'Edit your message', ed.dataset.text);
          if (v == null || !v.trim() || v === ed.dataset.text) return;
          try { draw(await Online.friends('edit', name, { t: Number(ed.dataset.dmEdit), text: v })); } catch (err) { toast([404, 422].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
          return;
        }
        const del = e.target.closest('[data-dm-unsend]'); if (!del) return;
        del.disabled = true;
        try { draw(await Online.friends('unsend', name, { t: Number(del.dataset.dmUnsend) })); } catch (err) { del.disabled = false; toast('Unavailable right now, try again'); }
      });
      block.addEventListener('click', async () => {
        const blocking = !block.dataset.blocked;
        if (blocking && !confirm(window.RNGI18n.t(`Block ${name}? They will not be able to message you.`))) return;
        try { draw(await Online.friends(blocking ? 'block' : 'unblock', name)); toast(blocking ? 'Blocked' : 'Unblocked'); } catch (err) { toast('Unavailable right now, try again'); }
      });
      input.focus();
    });
  }
  async function checkGifts() {
    if (!Store.player.name) return;
    try {
      announceGifts(await Online.friends('gifts'));
    } catch (err) { /* hors ligne : ils seront annoncés la prochaine fois */ }
  }
  // Cadeaux reçus (amis) et pièces du classement du mois (kind: 'top'), déjà marqués vus par le serveur.
  function announceGifts(r) {
    {
      Messages.set(r.messages || 0);
      if (!r.gifts || !r.gifts.length) return;
      if (r.coins != null) Store.setSetting('coins', r.coins);
      // Pièces du classement du mois : annoncées à part, une par une.
      r.gifts.filter(g => g.kind === 'top').forEach(g => toast(`🏆 #${g.place} on the ${monthLabel(g.month)} monthly leaderboard: +${fmt(g.amount)} coins`, 8000, 'achv'));
      r.gifts = r.gifts.filter(g => g.kind !== 'top');
      if (!r.gifts.length) { Sound.play('lock', { i: 5 }); return; }
      const total = r.gifts.reduce((x, g) => x + g.amount, 0);
      toast(r.gifts.length === 1 ? `🎁 ${r.gifts[0].name} sent you ${fmt(total)} coins` : `🎁 ${r.gifts.length} gifts from your friends: +${fmt(total)} coins`, 6000, 'achv');
      Sound.play('lock', { i: 5 });
    }
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
    friendsState = state;
    const btn = (action, name, label, cls = 'btn') => `<button class="${cls}" data-fr="${action}" data-name="${esc(name)}">${label}</button>`;
    const received = (state.gift && state.gift.received) || [];
    setHTML(body, `
      ${state.incoming.length ? `
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Friend requests</h3></div>
          ${state.incoming.map(n => `<div class="friend-row"><a class="player-link" href="${profileHref(n)}">${esc(n)}</a><span class="friend-actions">${btn('accept', n, 'Accept', 'btn-roll small')}${btn('decline', n, 'Decline')}</span></div>`).join('')}
        </div>` : ''}
      <div class="panel stats-sep">
        <div class="panel-head"><h3 class="panel-title">Your friends</h3><span class="panel-note">${state.friends.length} / ${state.max}</span></div>
        ${state.friends.length ? state.friends.map(f => `
          <div class="friend-row">
            <span class="live-dot fr-${f.room ? 'duel' : f.status || 'offline'}${f.room ? ' on' : ''}" title="${f.room ? 'In a duel' : f.status === 'online' ? 'Online' : f.status === 'afk' ? 'AFK' : 'Offline'}"></span>
            ${Avatars.html(f.name, 'av-sm')}<span class="friend-info"><a class="player-link" href="${profileHref(f.name)}">${esc(f.name)}</a>${titleHTML(f.title)}
              <span class="panel-note">${compact(f.xp)} lifetime XP · ${f.room ? 'in a duel right now' : f.status === 'online' ? '<b class="fr-st online">Online</b>' : f.status === 'afk' ? '<b class="fr-st afk">AFK</b>' : `Offline · ${f.seen ? `last roll ${relTime(f.seen)}` : 'no roll yet'}`}</span></span>
            <span class="friend-actions">${f.room ? `<a class="btn-roll small" href="${roomHref(f.room)}">Join / watch</a>` : ''}<button class="btn fr-chat" data-fr="chat" data-name="${esc(f.name)}" title="Messages">💬${f.unread ? `<b class="fr-unread">${f.unread > 9 ? '9+' : f.unread}</b>` : ''}</button>${state.gift ? `<button class="btn" data-fr="gift" data-name="${esc(f.name)}" title="Give coins">🎁 <span class="gift-label">Give coins</span></button>` : ''}${btn('remove', f.name, '✕', 'btn ghost')}</span>
          </div>`).join('') : '<div class="empty">No friends yet. Add one by name above, or from a player profile.</div>'}
      </div>
      ${state.outgoing.length ? `
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Requests sent</h3></div>
          ${state.outgoing.map(n => `<div class="friend-row"><a class="player-link" href="${profileHref(n)}">${esc(n)}</a><span class="friend-actions">${btn('cancel', n, 'Cancel')}</span></div>`).join('')}
        </div>` : ''}
      ${received.length ? `
        <div class="panel stats-sep"><div class="panel-head"><h3 class="panel-title">Gifts received</h3></div>
          ${received.map(x => `<div class="friend-row"><a class="player-link" href="${profileHref(x.name)}">${esc(x.name)}</a><span class="panel-note">🪙 ${fmt(x.amount)} · ${relTime(x.t)}</span></div>`).join('')}
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
    clearTimeout(Room.autoTimer);
    if (Room.anim) Room.anim.cancel();
    Room.anim = null;
    clearRoomFx();
    Room.token++;
  }

  function renderRoom(code) {
    currentView = 'room';
    REACTIONS.forEach(id => { new Image().src = `img/emotes/${id}.png`; });
    stopRoom();
    Object.assign(Room, { code: code.toUpperCase(), data: null, shown: 0, rtt: Infinity, view: null, sig: '', changedAt: Date.now(), reactSeen: new Set(), achNoted: false, chatSeen: 0, chatAt: 0, chatSig: '' });
    // Le tirage auto vaut pour une partie : une autre salle (ou la revanche) repart éteint.
    if (Room.autoCode !== Room.code) { Room.auto = false; Room.autoCode = Room.code; }
    Room.autoRound = -1;
    app.innerHTML = `
      <div class="page page-wide room-page">
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
    // On discute (un message vient d'arriver ou de partir, ou le champ est ouvert) : le chat doit rester vif.
    if (Date.now() - Room.chatAt < 20000 || (document.activeElement && document.activeElement.id === 'chat-input')) return ROOM_POLL_MS;
    if (Room.anim) return 4500; // une révélation dure une dizaine de secondes : rien à apprendre pendant ce temps
    if (!d || d.status !== 'playing') return 4000;
    const me = d.players.find(p => p.me);
    if (!me) return 3000; // spectateur
    if (me.ready) return ROOM_POLL_MS;
    // Pas prêt : la manche ne part qu'au départ automatique (heure connue) ; on sonde juste après.
    const auto = d.autoAt ? d.autoAt - serverNow() : Infinity;
    return Math.max(ROOM_POLL_MS, Math.min(6000, auto + 200));
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

  // Chat du duel : les messages arrivent avec chaque sondage, déjà filtrés par le serveur. Chacun peut masquer un
  // joueur (ses messages disparaissent sur cet appareil, dans tous les duels) ; seuls les joueurs assis écrivent.
  function drawChat(d) {
    const list = $('#chat-list');
    if (!list || !d) return;
    const me = d.players.find(p => p.me), muted = new Set(Store.settings.chatMuted || []);
    const chat = d.chat || [], shown = chat.filter(c => c.me || !muted.has(c.name));
    const sig = `${shown.length}:${shown.length ? shown[shown.length - 1].t : 0}:${muted.size}:${me ? 1 : 0}:${shown.filter(c => c.edited).map(c => `${c.t}.${c.m}`).join('|')}`; // un message modifié redessine aussi
    if (sig !== Room.chatSig) {
      Room.chatSig = sig;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      list.innerHTML = shown.length ? shown.map(c => `
        <div class="chat-msg${c.me ? ' mine' : ''}"><b class="chat-name" data-no-i18n>${c.bot ? '🤖 ' : ''}${esc(c.name)}</b><span class="chat-text" data-no-i18n>${esc(c.m)}</span>${c.edited ? '<i class="chat-edited">(edited)</i>' : ''}${c.bot ? '' : c.me ? `<button class="chat-hide chat-report" data-chat-edit="${c.t}" data-text="${esc(c.m)}" title="Edit this message">Edit</button><button class="chat-hide chat-report" data-chat-unsay="${c.t}" title="Delete this message">Delete</button>` : `<button class="chat-hide" data-chat-hide="${esc(c.name)}" title="Hide this player's messages">Hide</button><button class="chat-hide chat-report" data-chat-report="${c.t}" title="Report this message to the creator of the game">Report</button>`}</div>`).join('')
        : '<div class="empty">No message yet. Say hi!</div>';
      if (atBottom) list.scrollTop = list.scrollHeight;
      const hidden = d.players.filter(p => !p.me && muted.has(p.name)).length;
      $('#chat-hidden').innerHTML = hidden ? `${plural(hidden, 'player')} hidden · <button class="chat-show" data-chat-show>Show again</button>` : '';
      setHTML($('#chat-foot'), me
        ? '<form class="chat-form" id="chat-form"><input class="input" id="chat-input" maxlength="140" autocomplete="off" enterkeyhint="send" placeholder="Write a message…" aria-label="Message"><button class="btn" type="submit">Send</button></form>'
        : '<p class="panel-note">Only players in this duel can write.</p>');
    }
    const last = chat.length ? chat[chat.length - 1] : null;
    if (last && last.t > Room.chatSeen) {
      if (Room.chatSeen && !last.me && !muted.has(last.name)) Sound.tick({ soft: 1 }); // pas de son pour l'historique à l'arrivée
      Room.chatSeen = last.t;
      if (Date.now() - last.t + Room.offset < 30000) Room.chatAt = Date.now();
    }
  }

  async function sendChat(text) {
    const token = Room.token, sent = Date.now();
    Room.chatAt = sent;
    try {
      applyRoom(await Online.roomAction('chat', Room.code, { text }), token, sent, Date.now());
      return true;
    } catch (err) {
      toast(err.status === 429 ? 'Slow down a little' : err.status === 422 ? err.message : 'Message not sent');
      return false;
    }
  }

  async function sendReaction(emoji) {
    if (Room.reactBusy || !Room.data || !Room.data.players.some(p => p.me)) return;
    Room.reactBusy = true;
    setTimeout(() => { Room.reactBusy = false; }, 700);
    const token = Room.token, sent = Date.now();
    try {
      applyRoom(await Online.roomAction('react', Room.code, { emoji }), token, sent, Date.now());
    } catch (err) {
      if (err.status !== 429) toast(err.status === 403 ? 'Buy this emote first' : 'Reaction not sent');
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
    // Sorti de la partie (parti ou exclu) : la suite se regarde comme un spectateur.
    const me = d.players.find(p => p.me && !p.out);

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

    // Exclu par l'hôte : on le prévient une fois, et le salon redevient pour lui celui d'un spectateur.
    if (d.kicked && Room.kickedSeen !== d.code) { Room.kickedSeen = d.code; toast('The host removed you from this duel', 4500); }
    if (d.status === 'lobby') {
      if (Room.view !== 'lobby') {
        Room.view = 'lobby';
        body.innerHTML = '<div class="room-code-box" id="room-lobby"></div>';
      }
      const host = d.players.find(p => p.host);
      const seats = d.players.map(p => `<span class="badge-pill">${p.host ? '👑 ' : ''}${p.bot ? '🤖 ' : ''}${esc(p.name)}${p.clan ? ` [${esc(p.clan.tag)}]` : ''}${titleEmoji(p.title)}${topEmoji(p.top)}${p.me ? ' (you)' : ''}${me && me.host && !p.host ? `<button class="seat-kick" type="button" data-kick="${esc(p.name)}" title="Remove from the duel" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</span>`).join('')
        + '<span class="badge-pill empty-seat">…</span>'.repeat(Math.max(0, d.size - d.players.length));
      // Places vides complétées par des bots après 2 min (idée d'Aussie Haüs, 2026-10-21) : choix de l'hôte, gardé sur son
      // appareil ; jamais dans un duel avec mise (le serveur le refuse aussi). Un bot à la fois, à chaque relecture du salon.
      const canFill = me && me.host && !d.stake && d.players.length < d.size;
      const fillOn = canFill && Store.settings.botFill === 'on';
      if (canFill) { Room.lobbyAt = Room.lobbyAt && Room.lobbyAt.code === d.code ? Room.lobbyAt : { code: d.code, t: Date.now() }; }
      const fillLeft = fillOn ? Math.max(0, 120000 - (Date.now() - Room.lobbyAt.t)) : 0;
      if (fillOn && !fillLeft && !Room.filling) { Room.filling = true; Online.roomAction('addBot', d.code).catch(() => {}).finally(() => { Room.filling = false; }); }
      const wait = !me ? '' : me.host
        ? (fillOn ? `Bots fill the empty seats in ${Math.ceil(fillLeft / 1000)} s` : d.players.length > 1 ? 'Start now, or wait: the game starts by itself when it is full' : 'Waiting for players…')
        : `Waiting for ${esc(host.name)} to start (or for the game to fill up)…`;
      const html = `
        <div class="eyebrow">Duel code</div>
        <div class="room-code mono">${esc(d.code)}</div>
        <p class="panel-note">${d.size} players · ${goalText(d)} · each round goes to the highest roll${stakeText(d)}</p>
        <div class="pill-row room-seats">${seats}</div>
        <p class="panel-note">${d.players.length} / ${d.size} players</p>
        <div class="room-buttons">
          ${me ? '<button class="btn" id="room-share">Share invite</button>' : '<button class="btn-roll small" id="room-join">⚔️ Join</button>'}
          ${me && !me.host ? '<button class="btn ghost" id="room-leave">🚪 Leave</button>' : ''}
          ${me && me.host && d.players.length < d.size ? '<button class="btn" id="room-bot">🤖 Add a bot</button>' : ''}
          ${canFill ? `<label class="room-auto room-fill"><input type="checkbox" id="room-fill"${fillOn ? ' checked' : ''}><i aria-hidden="true"></i><span>Fill with bots after 2 min</span></label>` : ''}
          ${me && me.host && d.players.length > 1 ? `<button class="btn-roll small" id="room-start">Start now with ${d.players.length}</button>` : ''}
        </div>
        ${wait ? `<p class="room-wait">${wait}</p>` : ''}`;
      if (setHTML($('#room-lobby'), html)) {
        const share = $('#room-share');
        if (share) share.addEventListener('click', () => shareOrCopy(`⚔️ Live duel on RNG∞ (${d.size} players, ${goalText(d)}), code ${d.code}\n${location.origin + location.pathname}?ref=duel${roomHref(d.code)}`, 'Duel invite'));
        const join = $('#room-join');
        if (join) join.addEventListener('click', () => joinRoom(d.code));
        const leave = $('#room-leave');
        if (leave) leave.addEventListener('click', () => roomSend('quit', leave));
        const start = $('#room-start');
        if (start) start.addEventListener('click', () => roomSend('start', start));
        const addBot = $('#room-bot');
        if (addBot) addBot.addEventListener('click', () => roomSend('addBot', addBot));
        // Exclure un joueur (hôte, avant le début) : il ne pourra plus revenir dans ce duel.
        $('#room-lobby').onclick = e => {
          const k = e.target.closest('[data-kick]'); if (!k) return;
          if (!confirm(window.RNGI18n ? window.RNGI18n.t(`Remove ${k.dataset.kick} from this duel? They won't be able to come back.`) : `Remove ${k.dataset.kick} from this duel? They won't be able to come back.`)) return;
          roomSend('kick', k, { who: k.dataset.kick });
        };
        const fill = $('#room-fill');
        if (fill) fill.addEventListener('change', () => { Store.setSetting('botFill', fill.checked ? 'on' : 'off'); if (Room.lobbyAt) Room.lobbyAt.t = Date.now(); });
      }
      return;
    }

    const seats = `${d.players.length}|${!!me}|${Room.isOwner ? 1 : 0}`; // le statut de créateur peut arriver après le premier affichage
    if (Room.view === 'playing' && Room.seats !== seats && !Room.anim) Room.view = null; // quelqu'un est entré en cours de partie
    if (Room.view !== 'playing') {
      Room.view = 'playing';
      Room.seats = seats;
      Room.chatSig = ''; // salon reconstruit (un joueur arrive) : la liste du chat est neuve, il faut la redessiner
      body.innerHTML = `
      <div class="room-layout"><div class="room-main">
        <p class="panel-note profile-sub">${d.players.length} players · ${goalText(d)} · each round goes to the highest roll · ${d.bots ? 'with bots: your rolls count, but not duel wins or rivalries' : 'duel rolls count on the leaderboard'}${stakeText(d)}</p>
        <div class="room-board" id="room-board"></div>
        <div class="room-arena">
          <div class="room-stage${d.players.length > 2 ? ' many' : ''}" id="room-stage"></div>
          <div class="react-layer" id="react-layer" aria-hidden="true"></div>
        </div>
        ${me ? `<div class="room-reacts" id="room-reacts">${REACTIONS.map((e, i) => `<button class="react-btn" data-react="${e}" title="${EMOTE_LABELS[e]} (press ${i + 1})">${emoteHTML(e)}</button>`).concat(myEmotes().map(e => `<button class="react-btn special" data-react="${e}" title="${esc(Shop.emoteById.get(e).name)}">${emoteHTML(e)}</button>`)).join('')}</div>` : ''}
        <div class="room-actions"><div id="room-cta"></div><p class="hint" id="room-hint"></p>${me ? '<button class="btn ghost small room-quit" id="room-quit" type="button">🚪 Leave the game</button>' : ''}${me ? `<label class="room-auto" id="room-auto-wrap" title="Rolls every round for you until this duel ends"><input type="checkbox" id="room-auto"${Room.auto ? ' checked' : ''}><i aria-hidden="true"></i><span>Auto-roll</span></label>` : ''}</div>
        <div class="panel"><div class="panel-head"><h3 class="panel-title">Rounds</h3></div><div id="room-rounds"></div></div>
      </div><aside class="room-aside">
        <div class="panel chat-panel" id="room-chat">
          <div class="panel-head"><h3 class="panel-title">Chat</h3><span class="panel-note">be kind · never share personal details</span></div>
          <div class="chat-list" id="chat-list" aria-live="polite"></div>
          <p class="panel-note chat-hidden" id="chat-hidden"></p>
          <div id="chat-foot"></div>
        </div>
        ${Room.isOwner ? `<div class="prank-bar" id="prank-bar" hidden><button class="btn prank-btn" id="prank-sound" title="Play a loud sound right now on a player's screen">📢 Loud sound</button><button class="btn prank-btn" id="prank-jackpot" title="Pick a player and a number: on the next round their card lands on it, then the joke. Nothing real changes.">🎭 Fake jackpot <b id="prank-left"></b></button></div>` : ''}
      </aside></div>`;
      const pb = $('#prank-jackpot');
      const ps = $('#prank-sound');
      if (ps) ps.addEventListener('click', () => {
        const others = Room.data.players.filter(p => !p.me && !p.bot);
        openModal(`
          <h2>📢 Loud sound</h2>
          <p class="panel-note" style="margin:-.3rem 0 .8rem">Plays right now on their screen (only if their sound is on). 3 seconds between two sounds.</p>
          <form id="psound-form" class="prank-form">
            <label class="lev-field"><span>Who</span><select class="input" name="target"><option value="*">Everyone</option>${others.map(p => `<option value="${esc(p.name)}" data-no-i18n>${esc(p.name)}</option>`).join('')}</select></label>
            <div class="chips-row">${[['airhorn', '📯 Air horn'], ['trombone', '🎺 Sad trombone'], ['buzzer', '🚨 Buzzer'], ['scream', '😱 Scream']].map(([k, l]) => `<button type="button" class="chip" data-ps="${k}">${l}</button>`).join('')}</div>
            <p class="panel-note">Tap a sound to send it (you hear a quiet preview).</p>
          </form>`, m => {
          m.querySelector('.chips-row').addEventListener('click', async e => {
            const c = e.target.closest('[data-ps]'); if (!c) return;
            prankSound(c.dataset.ps, .15);
            try { applyRoom(await Online.roomAction('prankSound', Room.code, { target: m.querySelector('[name="target"]').value, kind: c.dataset.ps }), Room.token, Date.now(), Date.now()); toast('📢 Sent', 1500); }
            catch (err) { toast([400, 403, 422, 429].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
          });
        });
      });
      // 🎭 Choisir la cible et le nombre qu'elle verra se poser sur sa carte à la prochaine manche.
      if (pb) pb.addEventListener('click', () => {
        const others = Room.data.players.filter(p => !p.me && !p.bot);
        openModal(`
          <h2>🎭 Fake jackpot</h2>
          <p class="panel-note" style="margin:-.3rem 0 .8rem">On the next round, their own card rolls and lands on this number (rarity, XP, badges, confetti), then their real roll comes back. Nothing real changes.</p>
          <form id="prank-form" class="prank-form">
            <label class="lev-field"><span>Who</span><select class="input" name="target">${others.map(p => `<option value="${esc(p.name)}" data-no-i18n>${esc(p.name)}</option>`).join('')}</select></label>
            <label class="lev-field"><span>Number they will see</span><input class="input mono" name="n" type="number" min="0" max="1000000" value="777777" required></label>
            <div class="chips-row">${['777777', '999999', '000000', '1000000', '123456', '69420'].map(v => `<button type="button" class="chip" data-pn="${v}" data-no-i18n>${v}</button>`).join('')}</div>
            <p class="panel-note" id="prank-preview"></p>
            <div class="actions"><button class="btn-roll small">Arm the prank</button></div>
          </form>`, m => {
          const f = m.querySelector('#prank-form'), input = f.elements.n, prev = m.querySelector('#prank-preview');
          const show = () => { const v = Number(input.value); if (Number.isInteger(v) && v >= 0 && v <= 1000000) { const a = analysis(v); prev.innerHTML = `They will see <b class="mono" data-no-i18n>${a.str.padStart(6, '0')}</b> · ${tierPill(a.tier)} · ${fmt(a.total)} XP`; } else prev.textContent = 'From 0 to 1,000,000'; };
          m.querySelector('.chips-row').addEventListener('click', e => { const c = e.target.closest('[data-pn]'); if (c) { input.value = Number(c.dataset.pn); show(); } });
          input.addEventListener('input', show); show();
          f.addEventListener('submit', async e => {
            e.preventDefault();
            try { applyRoom(await Online.roomAction('prank', Room.code, { target: f.elements.target.value, n: Number(input.value) }), Room.token, Date.now(), Date.now()); closeModal(); toast(`🎭 Armed for ${f.elements.target.value}'s next round`, 3000); }
            catch (err) { toast([400, 403, 422, 429].includes(err.status) ? err.message : 'Unavailable right now, try again'); }
          });
        });
      });
      // Quitter la partie, ou (hôte) exclure un joueur depuis le classement.
      const quit = $('#room-quit');
      if (quit) quit.addEventListener('click', () => {
        if (!confirm(window.RNGI18n ? window.RNGI18n.t(Room.data.stake ? 'Leave this duel? You lose your bet and cannot come back.' : 'Leave this duel? You cannot come back.') : (Room.data.stake ? 'Leave this duel? You lose your bet and cannot come back.' : 'Leave this duel? You cannot come back.'))) return;
        Room.auto = false; roomSend('quit', quit);
      });
      $('#room-board').addEventListener('click', e => {
        const k = e.target.closest('[data-kick]'); if (!k) return;
        e.preventDefault();
        if (!confirm(window.RNGI18n ? window.RNGI18n.t(`Remove ${k.dataset.kick} from this duel? They won't be able to come back.`) : `Remove ${k.dataset.kick} from this duel? They won't be able to come back.`)) return;
        roomSend('kick', k, { who: k.dataset.kick });
      });
      $('#room-chat').addEventListener('click', e => {
        const rep = e.target.closest('[data-chat-report]');
        if (rep) { reportMessage(rep, () => Online.roomAction('report', Room.code, { t: Number(rep.dataset.chatReport) })); return; }
        const ed = e.target.closest('[data-chat-edit]');
        if (ed) {
          const v = prompt(window.RNGI18n ? window.RNGI18n.t('Edit your message') : 'Edit your message', ed.dataset.text);
          if (v != null && v.trim() && v !== ed.dataset.text) { Room.chatSig = ''; roomSend('edit', ed, { t: Number(ed.dataset.chatEdit), text: v }); }
          return;
        }
        const unsay = e.target.closest('[data-chat-unsay]');
        if (unsay) { Room.chatSig = ''; roomSend('unsay', unsay, { t: Number(unsay.dataset.chatUnsay) }); return; }
        const hide = e.target.closest('[data-chat-hide]'), show = e.target.closest('[data-chat-show]');
        if (!hide && !show) return;
        const muted = new Set(Store.settings.chatMuted || []);
        if (hide) muted.add(hide.dataset.chatHide); else muted.clear();
        Store.setSetting('chatMuted', [...muted].slice(-200));
        Room.chatSig = '';
        drawChat(Room.data);
      });
      $('#room-chat').addEventListener('submit', async e => {
        e.preventDefault();
        const input = $('#chat-input'), text = input.value.trim();
        if (!text || input.disabled) return;
        input.disabled = true;
        if (await sendChat(text)) input.value = '';
        input.disabled = false;
        input.focus();
      });
      if (!Room.anim) { $('#room-stage').innerHTML = stageHTML(Room.shown ? d.rounds[Room.shown - 1] : null); Room.skinSig = skinSig(d); }
      const reacts = $('#room-reacts');
      if (reacts) reacts.addEventListener('click', e => { const b = e.target.closest('[data-react]'); if (b) sendReaction(b.dataset.react); });
    }
    // Boutons du créateur : toujours dessinés pour lui, montrés dès qu'un vrai joueur est là (y compris un joueur arrivé en
    // cours de partie ; avant, ils n'apparaissaient qu'au premier affichage du salon, signalé par Sacha le 2026-10-23).
    const prankBar = $('#prank-bar');
    if (prankBar) prankBar.hidden = !(me && d.players.some(p => !p.me && !p.bot));
    // Un joueur a changé de skin dans Shop : ses cartes changent entre deux manches, jamais pendant une révélation.
    if (!Room.anim && $('#room-stage') && Room.skinSig !== skinSig(d)) {
      const r = Room.shown ? d.rounds[Room.shown - 1] : null;
      clearRoomFx();
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
        : `<span class="mono board-wins">${wins[i]} / ${d.target}</span><span class="panel-note board-xp">${compact(totals[i])} XP</span>`;
      const ready = d.status === 'playing' && p.ready && !Room.anim ? '<span class="ready-chip">ready</span>' : '';
      const who = p.bot ? `<span class="bot-name">🤖 ${esc(p.name)}</span>` : `<a class="player-link" href="${profileHref(p.name)}">${esc(p.name)}</a>`;
      // Sorti, ou bouton ✕ de l'hôte pour exclure un joueur pendant la partie (pas dans un duel avec mise).
      const out = p.out ? `<span class="out-chip">${p.out === 'kicked' ? '✕ removed' : '🚪 left'}</span>` : '';
      const kick = me && me.host && !p.me && !p.out && d.status === 'playing' && !d.stake ? `<button class="seat-kick" type="button" data-kick="${esc(p.name)}" title="Remove from the duel" aria-label="Remove ${esc(p.name)}">✕</button>` : '';
      return `<div class="board-row${p.me ? ' me' : ''}${p.out ? ' out' : ''}" data-pi="${i}">${out}${kick}<span class="rank">${k + 1}</span><span class="board-who">${who}${clanTagHTML(p.clan)}${titleHTML(p.title)}${topHTML(p.top)}${p.me ? '<span class="muted">(you)</span>' : ''}</span>${ready}<span class="board-metric">${metric}</span></div>`;
    }).join(''));

    const finished = d.status === 'done' && Room.shown === d.rounds.length && !Room.anim;
    { const q = $('#room-quit'); if (q) q.hidden = d.status !== 'playing'; }
    const people = d.players.filter(p => !p.bot); // les bots sont toujours prêts : on ne compte que les humains
    const readyCount = people.filter(p => p.ready).length;
    const countdown = d.autoAt ? ` · starts by itself in ${Math.max(0, Math.ceil((d.autoAt - serverNow()) / 1000))} s` : '';
    let cta, hint = '';
    // Les succès du duel arrivent avec la révélation de la dernière manche : annoncés dès qu'ils changent.
    if (finished && d.achievements && Room.achNoted !== JSON.stringify(d.achievements)) {
      Room.achNoted = JSON.stringify(d.achievements);
      noteAchievements(d.achievements);
    }
    // Quêtes de duel : comptées par le serveur à la révélation de la dernière manche, une vérification par partie finie.
    if (finished && d.players.some(p => p.me) && Room.questNoted !== `${d.code}:${d.rounds.length}:${d.rounds[d.rounds.length - 1].t}`) {
      Room.questNoted = `${d.code}:${d.rounds.length}:${d.rounds[d.rounds.length - 1].t}`;
      setTimeout(() => QuestWatch.bump(), 2500);
    }
    if (finished) {
      const w = d.winner;
      const how = w === null ? '' : d.mode === 'xp' ? ` with ${fmt(totals[w])} XP` : ` with ${plural(wins[w], 'round')}`;
      const pot = !d.stake ? '' : w === null ? ' · stakes refunded' : ` · 🪙 ${fmt(d.pot)} pot`;
      const banner = (w === null ? '🤝 Draw' : d.players[w].me ? `🏆 You win${how}` : `🏆 ${esc(d.players[w].name)} wins${how}`) + pot;
      const rematch = !me ? ''
        : d.next ? `<button class="btn-roll small" id="room-rematch">🔁 ${d.nextBy === me.name ? 'Back to the rematch' : `${esc(d.nextBy)} wants a rematch: play`}</button>`
        : '<button class="btn-roll small" id="room-rematch">🔁 Rematch</button>';
      // Victoire sans récompense (anti-farm) : on dit pourquoi au gagnant, pour qu'il ne croie pas à un bug.
      const why = { pair: 'you already beat this opponent 3 times today', day: 'you reached the limit of 10 rewarded wins today', new: 'your opponent\'s account is too new (under 20 rolls)' }[d.reward];
      const noReward = why && w !== null && d.players[w].me ? `<p class="panel-note room-noreward">No coins or achievements for this win: ${why}. It still counts in your head-to-head.</p>` : '';
      cta = `<div class="room-result">${banner}</div>${noReward}<div class="room-buttons">${rematch}<a class="btn" href="#/duel">New game</a></div>`;
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
      cta = `<button class="btn-roll${genClass()}" id="room-roll">🎲 Roll round ${d.rounds.length + 1}</button>`;
      hint = Room.auto ? 'Auto-roll is on: rolling for you' : `${readyCount && people.length > 1 ? `${readyCount} / ${people.length} ready${countdown} · ` : ''}press <kbd>${esc(keyName())}</kbd>`;
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
    { const left = $('#prank-left'); if (left) left.textContent = d.prankArmed != null && d.prankArmed >= d.rounds.length ? '· armed' : ''; }
    // Farce sonore reçue : jouée une seule fois.
    if (d.psound && d.psound.t !== Room.psoundSeen) { Room.psoundSeen = d.psound.t; prankSound(d.psound.kind); }
    // Hauteur de la barre d'action, pour que les émotes s'accrochent juste au-dessus sur téléphone (css/style.css).
    { const bar = app.querySelector('.room-actions'); if (bar) requestAnimationFrame(() => document.documentElement.style.setProperty('--room-bar-h', `${bar.offsetHeight}px`)); }
    // Tirage auto : dès que c'est à moi de lancer une manche, elle part toute seule (une fois par manche, après un
    // court instant pour voir le résultat de la précédente). S'arrête avec la partie : la revanche reste un vrai clic.
    const autoWrap = $('#room-auto-wrap');
    if (autoWrap) {
      autoWrap.hidden = finished;
      const box = $('#room-auto');
      if (!box.dataset.wired) {
        box.dataset.wired = '1';
        box.addEventListener('change', () => { Room.auto = box.checked; Room.autoRound = -1; clearTimeout(Room.autoTimer); if (Room.auto) Sound.unlock(); if (Room.data) drawRoom(); });
      }
      if (Room.auto && !finished && $('#room-roll') && Room.autoRound !== d.rounds.length) {
        Room.autoRound = d.rounds.length;
        const code = d.code;
        clearTimeout(Room.autoTimer);
        Room.autoTimer = setTimeout(() => {
          if (!Room.auto || Room.code !== code) return;
          roomReady();
          // Le bouton n'était pas là (révélation en cours) ou l'envoi a échoué : on retente au prochain affichage.
          Room.autoTimer = setTimeout(() => { Room.autoRound = -1; if (Room.auto && Room.code === code && Room.data) drawRoom(); }, 4000);
        }, d.rounds.length ? 900 : 300);
      }
    }

    // Manches : le gagnant et son nombre, plus le mien si ce n'est pas moi.
    const mine = d.players.findIndex(p => p.me);
    const numberCard = (r, j, i) => {
      const a = analysis(r.n[j]);
      return `<span class="num-card sm" data-tier="${a.tier}" data-number="${r.n[j]}" data-owner="${esc(d.players[j].name)}" data-caption="${esc(`${d.players[j].name} · round ${i + 1}`)}" style="cursor:pointer">${a.str}</span>`;
    };
    drawChat(d);
    // Longue partie : seules les 30 dernières manches sont affichées (la liste entière ralentirait la page).
    const hiddenRounds = Math.max(0, Room.shown - 30);
    setHTML($('#room-rounds'), Room.shown ? (hiddenRounds ? `<p class="panel-note room-rounds-more">${fmt(hiddenRounds)} earlier rounds not shown</p>` : '') + d.rounds.slice(hiddenRounds, Room.shown).map((r, k) => { const i = hiddenRounds + k; return `
      <div class="room-round">
        <span class="rank">${i + 1}</span>
        ${r.winner === null ? '<span class="muted">tie at the top</span>' : `${numberCard(r, r.winner, i)}<span>🏆 ${esc(d.players[r.winner].name)} · ${compact(r.s[r.winner])} XP</span>`}
        ${mine >= 0 && mine !== r.winner && r.n[mine] != null ? `<span class="room-round-mine">you: ${numberCard(r, mine, i)}</span>` : ''}
      </div>`; }).join('') : '<div class="empty">No round yet.</div>');
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
  // Retire les séquences de skin encore affichées dans la salle (manche précédente).
  const FX_CARDS = 4; // nombre de cartes animées en même temps dans un duel
  function clearRoomFx() {
    (Room.fx || []).forEach(fx => { if (fx) fx.destroy(); });
    Room.fx = [];
  }

  // Scène : une carte par joueur. Sans manche : "??????" ; sinon la manche révélée, avec son gagnant.
  function stageHTML(r, spinning = false) {
    const d = Room.data;
    const sides = d.players.map((p, j) => {
      const a = r && !spinning && r.n[j] != null ? analysis(r.n[j]) : null; // arrivé en cours de partie : pas de nombre pour les manches d'avant
      const won = a && r.winner === j;
      const card = withLever(a
        ? `<div class="num-card md${skinClass(p.skin)}" data-tier="${a.tier}" data-number="${r.n[j]}" data-owner="${esc(p.name)}" data-caption="${esc(p.name)}" style="cursor:pointer">${slotsHTML(a.str)}</div>`
        : `<div class="num-card md neutral${spinning ? ' charging' : ''}${skinClass(p.skin)}" id="rc-${j}">${'??????'.split('').map(c => `<span class="slot${spinning ? ' spinning' : ''}">${spinning ? '0' : c}</span>`).join('')}</div>`, p.skin);
      return `
        <div class="room-side${won ? ' won' : ''}${p.me ? ' me' : ''}${skinClass(p.skin).replace('skin-', 'side-')}" id="rs-${j}">${Shop.resolve(p.skin) === 'fire' ? '<span class="side-embers" aria-hidden="true"></span>' : ''}
          <div class="room-name">${won ? '🏆 ' : ''}${p.bot ? '🤖 ' : ''}${esc(p.name)}${p.clan ? ` [${esc(p.clan.tag)}]` : ''}${titleEmoji(p.title)}${topEmoji(p.top)}</div>
          ${card}
          <div class="room-meta" id="rm-${j}">${a ? `${tierPill(a.tier)}<span class="ep-pill">${fmt(a.total)} XP</span>` : ''}</div>
          <div class="pill-row" id="rb-${j}">${a ? duelBadgesHTML(a, r.n[j]) : ''}</div>
        </div>`;
    });
    return d.players.length === 2 ? sides.join('<div class="room-vs">VS</div>') : sides.join('');
  }

  // Révélation d'une manche, en même temps chez tous les joueurs : les chiffres de toutes les cartes tombent ensemble.
  // 📢 Sons de farce, fabriqués sur place (aucun fichier) : forts mais passés dans un compresseur, jamais au-delà du
  // maximum normal du navigateur. Rien ne joue si le son du jeu est coupé ou si la page n'a jamais été touchée.
  let prankCtx = null;
  function prankSound(kind, vol = 1) {
    if (Store.settings.sound === 'off') return; // son du jeu coupé : on respecte
    try {
      prankCtx = prankCtx || new (window.AudioContext || window.webkitAudioContext)();
      const c = prankCtx; if (c.state === 'suspended') c.resume();
      const out = c.createDynamicsCompressor(), master = c.createGain(); master.gain.value = .9 * vol; out.connect(master); master.connect(c.destination);
      const t0 = c.currentTime;
      const tone = (type, f0, f1, start, dur, g = .5) => { const o = c.createOscillator(), a = c.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t0 + start); o.frequency.linearRampToValueAtTime(f1, t0 + start + dur); a.gain.setValueAtTime(0, t0 + start); a.gain.linearRampToValueAtTime(g, t0 + start + .02); a.gain.setValueAtTime(g, t0 + start + dur - .05); a.gain.linearRampToValueAtTime(0, t0 + start + dur); o.connect(a); a.connect(out); o.start(t0 + start); o.stop(t0 + start + dur + .05); };
      if (kind === 'airhorn') for (const [st, d] of [[0, .35], [.45, .35], [.9, 1.1]]) for (const f of [415, 523, 622]) tone('sawtooth', f, f * 1.01, st, d, .35);
      else if (kind === 'trombone') [[392, 370], [370, 349], [349, 330], [330, 262]].forEach(([a, b], i) => tone('sawtooth', a, b, i * .45, i === 3 ? 1.2 : .4, .45));
      else if (kind === 'buzzer') for (let i = 0; i < 3; i++) tone('square', 110, 105, i * .5, .4, .6);
      else if (kind === 'scream') { tone('sawtooth', 600, 1400, 0, .5, .4); tone('sawtooth', 1400, 900, .5, .9, .4); tone('square', 650, 1500, 0, .5, .15); }
    } catch (e) { /* pas de son possible : tant pis */ }
  }
  // 🎭 Fin de la farce : une annonce par-dessus l'écran, signée par le créateur.
  function prankReveal(by) {
    const el = document.createElement('div');
    el.className = 'fake-jackpot fj-reveal';
    el.innerHTML = `<div class="fj-box"><div class="fj-title">😂 JUST KIDDING</div><div class="fj-sub" data-no-i18n>👑 prank by ${esc(by)}</div></div>`;
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('fj-out'); setTimeout(() => el.remove(), 600); }, 2000);
  }
  function playRound(i) {
    const d = Room.data, r = d.rounds[i];
    const stage = $('#room-stage');
    if (!stage) return;
    const sides = r.n.map((n, j) => ({ n, s: r.s[j], a: analysis(n) }));
    // 🎭 Farce du créateur : sur cette manche, la carte de la cible tourne et se pose, chiffre par chiffre et chez tout le
    // monde, sur le nombre choisi (rareté, XP, badges, confettis), puis reprend le vrai tirage avant l'annonce du gagnant.
    const real = sides.slice(), pk = d.prank && d.prank.round === i && d.players[d.prank.i] ? d.prank : null, faked = pk ? pk.i : -1;
    if (faked >= 0) { const fa = analysis(pk.n); sides[faked] = { n: pk.n, s: fa.total, a: fa }; }
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
      if (mine < 0 || !real[mine] || Store.rolls.some(x => x[0] === real[mine].n && x[2] === r.t)) return;
      Collection.ensure();
      Store.addRoll(real[mine].n, real[mine].s, r.t);
      QuestWatch.bump(questDelta(real[mine].s, real[mine].a.tier));
      Collection.add(Store.rolls[Store.rolls.length - 1], Store.rolls.length - 1);
    };

    let revealed = 0;
    const timers = [];
    // Sons, plus discrets qu'en solo (encore plus à trois joueurs ou plus). Manche rattrapée en retard (rechargement,
    // onglet endormi) : tout tombe d'un coup, donc en silence.
    const late = r.revealAt - Room.offset + REVEAL.digitStart - Date.now() < -250;
    const sfx = (type, o) => { if (!late) Sound.play(type, o); };
    const size = sides.length <= 2 ? {} : { small: 1 };
    // La séquence de chaque skin se joue en duel comme en solo, sur la carte de son joueur (la signature du créateur
    // avec le skin Owner). Celles de la manche d'avant sont retirées d'abord : leur calque vit hors de la scène
    // (au-dessus des cartes) et resterait affiché par-dessus la nouvelle manche. Au-delà de FX_CARDS cartes, seule la
    // mienne est animée, et à plusieurs les scènes sont allégées : dix scènes complètes à la fois font saccader.
    clearRoomFx();
    const roomFx = Room.fx = d.players.map((p, j) => {
      const skin = Shop.resolve(p.skin);
      if (late || !cards[j] || !cards[j].offsetParent || (sides.length > FX_CARDS && !p.me)) return null;
      const o = { q: sides.length <= 2 ? 1 : .6 };
      return skin === 'owner' ? SkinFX.mount(cards[j].offsetParent, cards[j], '', { ...o, owner: true }) : SkinFX.mount(cards[j].offsetParent, cards[j], skin, o);
    });
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
        roomFx.forEach((fx, j) => { if (fx) fx.lock(slots[j][k], { ghost: k < slotCount - sides[j].a.str.length, last: k === slotCount - 1 }); });
        sfx('lock', { i: k, soft: 1 });
      });
    }
    at(clock - Sound.LEAD, () => roomFx.forEach(fx => { if (fx) fx.build(Sound.LEAD); })); // la tension monte avant le dernier chiffre
    at(clock + 600, () => {
      clearInterval(spin);
      keepMine();
      sfx('reveal', size);
      roomFx.forEach((fx, j) => { if (fx) fx.reveal(sides[j].a.tier); });
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
    if (faked >= 0) at(clock + 2800, () => {
      // la vérité : le vrai nombre reprend sa place, avec sa rareté et ses badges
      const x = real[faked], str = x.a.str.padStart(slotCount, '0');
      cards[faked].innerHTML = str.split('').map((c, k) => `<span class="slot${k < slotCount - x.a.str.length ? ' ghost' : ''}">${c}</span>`).join('');
      cards[faked].dataset.tier = x.a.tier;
      $(`#rm-${faked}`).innerHTML = `${tierPill(x.a.tier)}<span class="ep-pill">${fmt(x.s)} XP</span>`;
      $(`#rb-${faked}`).innerHTML = duelBadgesHTML(x.a, x.n);
      prankReveal(pk.by);
    });
    at(clock + 1500 + (faked >= 0 ? 2800 : 0), () => {
      if (r.winner !== null) {
        const side = $(`#rs-${r.winner}`);
        side.classList.add('won');
        side.querySelector('.room-name').insertAdjacentHTML('afterbegin', '<span class="trophy-drop">🏆</span> ');
        shockwave(cards[r.winner], ['common', 'trash', 'garbage', 'landwaste'].includes(sides[r.winner].a.tier) ? 'uncommon' : sides[r.winner].a.tier);
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
    Room.anim = { cancel() { timers.forEach(clearTimeout); clearInterval(spin); Sound.stop(); clearRoomFx(); at(clock + 600, keepMine); } };
    drawRoom();
  }

  // ---------------------------------------------------------------- leaderboard / à propos
  // Classement du meilleur tirage de chaque joueur (tirages illimités : l'XP total récompenserait juste le plus gros cliqueur).
  // tab : l'onglet affiché ; period : le classement demandé au serveur (« Best roll » regroupe jour, semaine, mois et
  // tout le temps derrière des boutons de période, comme la Poubelle ; demandé par Sacha le 2026-10-18).
  const lbState = { tab: 'best', period: 'day' };
  const lbTabOf = period => (['day', 'week', 'month', 'all'].includes(period) ? 'best' : period);
  let lbTimer = 0;

  function renderLeaderboard() {
    currentView = 'leaderboard';
    const name = Store.player.name;
    const tabs = [['best', '🏆 Best roll'], ['xp', 'Lifetime XP'], ['coins', 'Coins'], ['worst', '🗑️ Trash'], ['event', '🎯 Event']];
    lbState.tab = lbTabOf(lbState.period);
    const lbRule = () => ({ xp: 'Total XP of every roll ever made', coins: 'Coins each player holds right now · refreshed every minute', worst: 'Worst single roll per player, of all time · the lowest XP comes first', event: 'Rolls that matched this week\'s event theme · resets every Monday 00:00 UTC', month: 'Best single roll per player · when the month ends, the top 10 earn a permanent badge 👑 Top 1 · 🥈 Top 5 · 🥉 Top 10 with the month and year, plus 🪙 1,000 · 500 · 250 coins' }[lbState.period] || 'Best single roll per player · days reset at midnight UTC');
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Leaderboard</h1>
        <div id="today-slot"></div>
        <div class="lb-wrap">
          ${trophiesAsideHTML()}
          <div class="lb-card">
            <div class="lb-tabs lb-tabs-5" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${lbState.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
            <div id="lb-list"><div class="empty">Loading…</div></div>
          </div>
        </div>
        <p class="panel-note" style="text-align:center;margin-top:.9rem">
          <span id="lb-rule">${lbRule()}</span> ·
          ${name ? `playing as <b>${esc(name)}</b> · <a href="javascript:void 0" id="lb-name">change</a>` : '<a href="javascript:void 0" id="lb-name">pick a name</a>'}
        </p>
      </div>`;
    $('#lb-name').addEventListener('click', openSettings);
    $('#lb-list').addEventListener('click', e => {
      const b = e.target.closest('[data-span]');
      if (!b) return;
      if (lbState.tab === 'best') { lbState.bestSpan = b.dataset.span; lbState.period = b.dataset.span; $('#lb-rule').textContent = lbRule(); }
      else lbState.span = b.dataset.span;
      $('#lb-list').innerHTML = '<div class="empty">Loading…</div>';
      drawLeaderboard();
    });
    $('.lb-tabs').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      lbState.tab = btn.dataset.tab;
      lbState.period = lbState.tab === 'best' ? (lbState.bestSpan || 'day') : lbState.tab;
      document.querySelectorAll('.lb-tabs button').forEach(b => b.classList.toggle('on', b === btn));
      $('#lb-rule').textContent = lbRule();
      $('#lb-list').innerHTML = '<div class="empty">Loading…</div>';
      drawLeaderboard();
    });
    loadTodayCard($('#today-slot'));
    drawLeaderboard();
  }

  // Vitrine des badges Top 1 / 5 / 10 : à droite du classement sur grand écran, au-dessus sur petit écran.
  // Montre les trois badges du mois en cours, comment les gagner et le temps qu'il reste avant la remise.
  function trophiesAsideHTML() {
    const now = new Date(serverNow()), month = now.toISOString().slice(0, 7);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const days = Math.ceil((end - now.getTime()) / 86400000);
    const left = days <= 1 ? 'Ends today (midnight UTC)' : `Ends in ${days} days`;
    const row = (top, who) => `<li>${topHTML({ top, month })}<span>${who}</span><b class="mono" data-no-i18n>🪙 ${fmt(TOP_COINS[top])}</b></li>`;
    return `
      <aside class="lb-aside panel" aria-label="Monthly trophies">
        <div class="eyebrow">🏆 Monthly trophies</div>
        <p class="lb-aside-lead">Finish the month in the top 10 of <b>This month</b> to earn a badge with the month and year, kept forever, and coins.</p>
        <ul class="lb-aside-list">${row(1, '1st place')}${row(5, '2nd to 5th')}${row(10, '6th to 10th')}</ul>
        <p class="lb-aside-foot"><b>${left}</b> · it shows next to your name on the leaderboard, your profile and in duels</p>
      </aside>`;
  }

  async function drawLeaderboard() {
    clearTimeout(lbTimer);
    const period = lbState.period;
    let data;
    try {
      data = await Online.leaderboard(period, period === 'worst' ? lbState.span || 'all' : null);
    } catch (err) {
      if ($('#lb-list')) $('#lb-list').innerHTML = '<div class="empty">Leaderboard unavailable right now.</div>';
      return;
    }
    if (currentView !== 'leaderboard' || period !== lbState.period || !$('#lb-list')) return;
    const when = { day: 'today', week: 'this week', month: 'this month', all: 'yet', xp: 'yet', coins: 'yet' }[period];
    const evHead = period === 'event' && data.event ? (() => { const e = data.event, left = Math.max(0, e.end - Date.now()), lt = left > 86400000 ? `${Math.floor(left / 86400000)} d ${Math.floor(left / 3600000) % 24} h left` : `${Math.max(1, Math.floor(left / 3600000))} h left`;
      return `<div class="lb-event-head"><span class="lb-event-emoji">${e.emoji}</span><span><b>${esc(e.title)}</b><span class="panel-note">${esc(e.desc)} · reach ${e.goal} for 🪙 ${fmt(e.reward)} · ${lt}</span></span></div>`; })() : '';
    // Poubelle : jour, semaine, mois ou tout le temps (idée d'Angelicide9, 2026-10-18).
    const SPANS = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All-time']];
    const bestBar = lbState.tab === 'best' ? `<div class="lb-spans">${SPANS.map(([k, l]) => `<button class="lb-span${period === k ? ' on' : ''}" data-span="${k}">${l}</button>`).join('')}</div>` : '';
    const spanBar = period === 'worst' ? `<div class="lb-spans">${SPANS.map(([k, l]) => `<button class="lb-span${(lbState.span || 'all') === k ? ' on' : ''}" data-span="${k}">${l}</button>`).join('')}</div>${(lbState.span || 'all') === 'month' ? '<p class="panel-note lb-span-note">👑 The worst roll of the month earns the <b>Trash King</b> title when the month ends</p>' : ''}` : '';
    // Ma place, en tête de liste (idée de WpBejs, 2026-10-18 : voir son meilleur sur la Poubelle sans chercher).
    const me = data.entries.find(e => e.me) || data.mine;
    const meBar = me && period !== 'coins' ? `<div class="lb-me-bar">📍 Your spot: <b>#${fmt(me.rank)}</b>${period === 'event' ? '' : period === 'xp' ? ` · ${fmt(me.s)} XP` : ` · <span class="mono">${String(me.n).padStart(6, '0')}</span> · ${fmt(me.s)} XP`}</div>` : '';
    $('#lb-list').innerHTML = bestBar + spanBar + evHead + meBar + (data.entries.length
      ? data.entries.map(lbRowHTML).join('') + (data.mine ? `<div class="lb-gap">···</div>${lbRowHTML(data.mine)}` : '')
      : `<div class="empty">${period === 'event' ? 'No matching roll yet this week, be the first!' : `No rolls ${when}, be the first!`}</div>`);
    if (lbState.scroll) { lbState.scroll = false; const card = $('.lb-card'); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    // Rafraîchi seulement quand l'onglet est visible : un onglet oublié ne doit pas vider le quota gratuit de la base.
    if (!document.hidden) lbTimer = setTimeout(() => { if (currentView === 'leaderboard') drawLeaderboard(); }, 60000);
  }

  // XP à vie : des milliards possibles, affichés en abrégé (le détail au survol).
  const compactXp = v => `<span title="${fmt(v)} XP">${v >= 1e6 ? compact(v) : fmt(v)} XP</span>`;
  function lbRowHTML(e) {
    // Classement des pièces : pas de tirage à montrer, juste le solde.
    // Événement de la semaine : nombre de tirages du thème, ✓ quand l'objectif est atteint.
    if (lbState.period === 'event') return `
      <div class="lb-row${e.me ? ' me' : ''}">
        <span class="lb-rank">${{ 1: '🥇', 2: '🥈', 3: '🥉' }[e.rank] || '#' + e.rank}</span>
        <span class="lb-who">${Avatars.html(e.name, 'av-sm')}<a class="lb-name" href="${profileHref(e.name)}">${esc(e.name)}${e.me ? ' <span class="muted">(you)</span>' : ''}</a>${clanTagHTML(e.clan)}${titleHTML(e.title)}${topHTML(e.top)}</span>
        <span class="lb-rolls">${e.done ? '✓ goal reached' : ''}</span>
        <span class="lb-coins mono">🎯 ${fmt(e.count)}</span>
      </div>`;
    if (lbState.period === 'coins') return `
      <div class="lb-row${e.me ? ' me' : ''}">
        <span class="lb-rank">${{ 1: '🥇', 2: '🥈', 3: '🥉' }[e.rank] || '#' + e.rank}</span>
        <span class="lb-who">${Avatars.html(e.name, 'av-sm')}<a class="lb-name" href="${profileHref(e.name)}">${esc(e.name)}${e.me ? ' <span class="muted">(you)</span>' : ''}</a>${clanTagHTML(e.clan)}${titleHTML(e.title)}${topHTML(e.top)}</span>
        <span class="lb-coins mono">🪙 ${fmt(e.coins)}</span>
        <span class="lb-rolls">${plural(e.rolls, 'roll')}</span>
      </div>`;
    const a = analysis(e.n);
    const xp = lbState.period === 'xp';
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[e.rank];
    return `
      <div class="lb-row${e.me ? ' me' : ''}" data-number="${e.n}" data-caption="${esc(`#${e.rank} · ${e.name} · ${relTime(e.t)}`)}">
        <span class="lb-rank">${medal || '#' + e.rank}</span>
        <span class="lb-who">${Avatars.html(e.name, 'av-sm')}<a class="lb-name" href="${profileHref(e.name)}" title="See ${esc(e.name)}'s profile">${esc(e.name)}${e.me ? ' <span class="muted">(you)</span>' : ''}</a>${clanTagHTML(e.clan)}${titleHTML(e.title)}${topHTML(e.top)}</span>
        <span class="lb-rolls mono" title="Rolls by this player ${{ day: 'today', week: 'this week', month: 'this month', all: 'in total', xp: 'in total', worst: 'in total' }[lbState.period]}">${e.rolls ? plural(e.rolls, 'roll') : '–'}</span>
        <span class="num-card sm" data-tier="${a.tier}"${xp ? ' title="Best roll"' : ''}>${a.str}</span>
        <span class="lb-ep mono${xp ? ' lifetime' : ''}"${xp ? ' title="Lifetime XP"' : ''}>${xp ? compactXp(e.s) : `${fmt(e.s)} XP`}</span>
      </div>`;
  }

  // Feuille de route publique (idée de Phong67, 2026-10-26) : idées prévues et ajoutées depuis 30 jours, lues dans la
  // boîte à idées par le serveur (api/_roadmap.js) : pseudo et extrait court, jamais les bugs ni les idées refusées.
  function renderRoadmap() {
    currentView = 'roadmap';
    app.innerHTML = `
      <div class="page rm-page">
        <h1 class="page-title">🗺️ Roadmap</h1>
        <p class="panel-note rm-intro">Player ideas the creator plans to make, and the ones added in the last 30 days. Got one? Send it with the 💡 button.</p>
        <div id="rm-body"><div class="empty">Loading…</div></div>
      </div>`;
    const item = x => `<li class="rm-item"><p class="rm-text" data-no-i18n>${esc(x.text)}</p><span class="rm-by">idea by <a class="player-link" href="${profileHref(x.name)}" data-no-i18n>${esc(x.name)}</a>${x.t ? ` · ${relTime(x.t)}` : ''}</span></li>`;
    const section = (title, note, list, empty) => `<div class="panel rm-panel"><div class="panel-head"><h3 class="panel-title">${title}</h3><span class="panel-note">${note}</span></div>${list.length ? `<ul class="rm-list">${list.map(item).join('')}</ul>` : `<div class="empty">${empty}</div>`}</div>`;
    Online.request('/api/site', { method: 'POST', body: JSON.stringify({ action: 'roadmap' }) }).then(d => {
      const box = $('#rm-body'); if (currentView !== 'roadmap' || !box) return;
      box.innerHTML = section('🛠️ Planned', `${fmt(d.planned.length)} ideas`, d.planned, 'Nothing planned right now.')
        + section('✅ Recently added', 'last 30 days', d.recent, 'Nothing added in the last 30 days.');
    }).catch(() => { const box = $('#rm-body'); if (box && currentView === 'roadmap') box.innerHTML = '<div class="empty">Unavailable right now.</div>'; });
  }

  function renderAbout() {
    currentView = 'about';
    const cardRows = [['landwaste', 'the worst score (73 numbers)'], ['garbage', 'bottom 0.05% (471 numbers)'], ['trash', 'bottom 1%'], ['common', 'bottom 50%'], ['uncommon', 'top 50–25%'], ['rare', 'top 25–10%'], ['epic', 'top 10–5%'], ['anomaly', 'top 5–1%'], ['mythic', 'top 1–0.1%'], ['celestial', 'top 0.1–0.01% (900 numbers)'], ['divine', 'top 0.01–0.005% (about 50 numbers)'], ['godlike', 'top 0.005–0.001% (40 numbers)'], ['infinite', 'top 0.001% (about 10 numbers)']];
    // Plage d'XP de chaque rareté (idée d'un joueur, 2026-10-16), lue dans la table des rangs : le plus petit total de la
    // rareté, jusqu'au plus petit de la suivante.
    const lows = {};
    for (const [score] of window.SCORE_PERCENTILES || []) { const t = Engine.cardTier(score); if (!(t in lows) || score < lows[t]) lows[t] = score; }
    const ordered = Object.entries(lows).sort((a, b) => a[1] - b[1]);
    const xpOf = v => (v < 100000 ? fmt(v) : compact(v)); // exact en bas (les raretés du bas ne diffèrent que de quelques XP)
    const xpRange = Object.fromEntries(ordered.map(([t, lo], i) => { const hi = i + 1 < ordered.length ? ordered[i + 1][1] - 1 : null; return [t, hi === null ? `${xpOf(lo)}+ XP` : hi === lo ? `${xpOf(lo)} XP` : `${xpOf(lo)} – ${xpOf(hi)} XP`]; }));
    const badgeRows = [['common', 'more than 10% of rolls'], ['uncommon', '1–10% of rolls'], ['rare', '0.1–1% of rolls'], ['epic', '0.01–0.1% of rolls'], ['anomaly', '0.001–0.01% of rolls'], ['mythic', '1 in 100,000 to 1 in 1,000,000'], ['celestial', 'a single number (1 in 1,000,000)']];
    app.innerHTML = `
      <div class="page prose">
        <h1 class="page-title">What is RNG∞?</h1>
        <p class="rm-about"><a href="#/roadmap">🗺️ Roadmap: the player ideas that are planned and the ones recently added</a></p>
        <p>A random number game with no daily limit. Each roll draws a number from 0 to 1,000,000. The number is checked against ${Engine.badges.length} patterns — palindromes, primes, repeated digits, meme numbers, sequences and more — and every badge it earns is worth XP (experience points).</p>
        <button class="trailer-thumb" data-trailer aria-label="Watch the trailer">
          <img src="media/trailer-16x9.jpg" alt="RNG∞ trailer: an Infinite roll, 777777" width="1280" height="720" loading="lazy">
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
        <div class="rarity-table">${cardRows.map(([t, l]) => `${tierPill(t)}<span>${l}${xpRange[t] ? ` <span class="muted mono">· ${xpRange[t]}</span>` : ''}</span>`).join('')}</div>
        <h2 class="panel-title">Badge rarity & XP</h2>
        <p>A badge is worth <span class="mono">100 × 1,000,001 ÷ (numbers that earn it)</span> XP, so a badge earned by 1 number in 1,000 is worth about 100,000 XP. Related badges form a family (e.g. Pair → Two Pair → Three Pair); only the best badge of a family counts toward your total.</p>
        <div class="rarity-table">${badgeRows.map(([t, l]) => `${tierPill(t)}<span>${l}</span>`).join('')}</div>
        <h2 class="panel-title">Your data</h2>
        <p>Numbers are drawn by the server, so nobody can pick their own 1337. Your best roll of the day, the week, the month and all time goes on the leaderboard under your player name.</p>
        <p>Click a name on the leaderboard to see that player's profile (best rolls, badge collection) and compare it with yours.</p>
        <p>No one around? Play a duel against bots from the Duel tab: your rolls count as usual, but not duel wins, rivalries or duel achievements.</p>
        <p>Coins and skins: every roll earns coins (more for rarer rolls) and so does every duel you win. Spend them in the Shop tab on skins that change how your number looks. In-game coins only.</p>
        <p>Achievements unlock titles: equip one from your profile and it shows next to your name on the leaderboard and in duels. They are checked by the server, so nobody can wear a title they did not earn.</p>
        <p>Duel (top menu): create a game for 2 to 10 players and send the code. Everyone rolls at the same time and all numbers are revealed together; each round goes to the highest roll. Win by being first to 1–10 round wins, or first to an XP total. Duel rolls are normal rolls, so they stay in your history and can make the leaderboard.</p>
        <p>Sign in with Google to keep your history, stats and badges on every device. You can also export them (JSON) from the player menu.</p>
        <p class="muted">Based on the daily game <a href="https://www.rngdle.com" target="_blank" rel="noopener">rngdle.com</a>: this version removes the daily limit and adds history, stats, Google sign-in and a leaderboard between friends.</p>
        <p class="muted"><a href="privacy.html">Privacy policy</a></p>
        <p><a class="btn" href="#/">Go roll</a> <button class="btn ghost" data-intro>Replay the intro</button> <button class="btn ghost" data-idea>💡 Suggest an idea</button></p>
        <p class="hidden-code" data-no-i18n aria-hidden="true">🔑 ROLLFOREVER</p>
      </div>`;
  }

  // ---------------------------------------------------------------- tournoi du jour (idée de PRISMA123, 2026-10-20)
  // Tableau à élimination directe joué en différé (règles dans api/_tournament.js). Les tirages de l'adversaire restent
  // cachés tant que ses tirages ou les tiens (3 ou 5 selon le mode du jour) ne sont pas faits.
  let tnTimer = 0, tnTick = 0, tnSkew = 0, tnState = null, tnBusy = false, tnWhich = 0; // tnWhich : tournoi choisi (1, 2 ou 3 = celui du soir), 0 = le sien
  const tnClock = () => Date.now() + tnSkew;
  const tnCd = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':'); };
  const tnHour = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function tnRoundName(r, total) {
    const left = total - r;
    return left === 1 ? 'Final' : left === 2 ? 'Semi-finals' : left === 3 ? 'Quarter-finals' : `Round ${r + 1}`;
  }
  // Mode du jour (idée de PRISMA123, 2026-10-21) : nom, règle en une ligne, unité du score affiché.
  const TN_MODES = {
    total: { name: '➕ Total XP', rule: '5 rolls each: the highest total XP wins.', unit: 'XP' },
    best: { name: '🎯 Best Roll', rule: '5 rolls each: only your single best roll counts.', unit: 'XP' },
    bo3: { name: '⚔️ Best of 3', rule: '3 rolls each, compared one by one (roll 1 vs roll 1…): win 2 of the 3 duels. Tie: total XP.', unit: 'duels' },
    lowest: { name: '🗑️ Lowest Wins', rule: '5 rolls each: the LOWEST total XP wins. Trash is gold today!', unit: 'XP' },
    badges: { name: '🏅 Badge Hunter', rule: '5 rolls each: the most different badges wins. Tie: total XP.', unit: 'badges' },
  };
  const tnMode = st => TN_MODES[st.mode] || TN_MODES.total;
  // « 1 duel », « 2 duels » : l'unité au singulier pour 1.
  const tnUnit = (st, v) => { const u = tnMode(st).unit; return v === 1 && u !== 'XP' ? u.slice(0, -1) : u; };
  const tnScore = (st, p) => (p.score === undefined || p.score === null ? `${fmt(p.total)} XP` : `${fmt(p.score)} ${tnUnit(st, p.score)}`);
  function stopTournament() { clearTimeout(tnTimer); clearInterval(tnTick); tnTimer = 0; tnTick = 0; }
  async function loadTournament() {
    const st = await Online.tourney('view', tnWhich ? { which: tnWhich } : {});
    tnSkew = st.now - Date.now();
    return st;
  }
  // Bandeau du tournoi sur l'accueil et le casino (idée de PRISMA123, 2026-10-21) : seulement quand il y a quelque chose à
  // faire (s'inscrire, ou jouer son match). Relu au plus une fois par minute.
  let tnBannerCache = null;
  async function drawTourneyBanner(slot) {
    if (!slot || !Store.player.name) return;
    try {
      // Tournoi du soir (Me Cojoni, 2026-10-26) : s'il n'y a rien à faire dans le tournoi par défaut, on regarde celui du soir.
      if (!tnBannerCache || Date.now() - tnBannerCache.at > 60000) {
        let st = await loadTournament();
        const idle = s => !(s.phase === 'signup' || (s.phase === 'running' && s.match && s.match.live && !s.match.bye && s.match.me.count < s.rolls));
        if (idle(st) && st.which !== 3) { const e = await Online.tourney('view', { which: 3 }); if (!idle(e)) st = e; }
        tnBannerCache = { at: Date.now(), st };
      }
      const st = tnBannerCache.st, m = st.match;
      let text = '';
      const md = `<span class="tn-mode-chip">${tnMode(st).name}</span>`;
      if (st.phase === 'signup' && !st.joined && st.eve) text = `🌙 <b>Evening tournament</b> ${md} · sign up before <span class="mono">${tnHour(st.close)}</span> · <span class="mono">${st.count}/${st.max}</span> players · 🪙 ${fmt(st.prizes.champion)} to win`;
      else if (st.phase === 'signup' && !st.joined) text = `🏆 <b>Daily tournament</b> ${md} · sign up before <span class="mono">${tnHour(st.close)}</span> · <span class="mono">${st.count}/${st.max}</span> players · 🪙 ${fmt(st.prizes.champion)} to win`;
      else if (st.phase === 'signup' && st.eve) text = `🌙 <b>You're in the evening tournament</b> ${md} · matches start at <span class="mono">${tnHour(st.close)}</span>`;
      else if (st.phase === 'signup') text = `🏆 <b>You're in today's tournament</b> ${md} · matches start at <span class="mono">${tnHour(st.close)}</span>`;
      else if (st.phase === 'running' && m && m.live && !m.bye && m.me.count < st.rolls) text = `🏆 <b>Your tournament match is ready!</b> ${md} · <span class="mono">${m.me.count}/${st.rolls}</span> rolls`;
      if (!slot.isConnected) return;
      // Texte dans un seul bloc qui peut passer à la ligne : en morceaux séparés dans le flex, il débordait sur téléphone
      // (+32 px à 390 px, page d'accueil, 2026-10-26).
      slot.innerHTML = text ? `<a class="tn-banner" href="#/tournament"><span class="tn-banner-txt">${text}</span><span class="tn-banner-go">→</span></a>` : '';
    } catch (err) { /* hors ligne : pas de bandeau */ }
  }
  // Carte du Duel : l'état du tournoi en une ligne, et le lien vers sa page.
  async function drawTourneyTeaser() {
    const box = $('#d-tourney');
    if (!box) return;
    try {
      const st = await loadTournament();
      if (!$('#d-tourney')) return;
      const line = st.phase === 'signup' ? `<span>Sign-ups open</span> · <span class="mono">${st.count}/${st.max}</span> · <span>closes at</span> <span class="mono">${tnHour(st.close)}</span>`
        : st.phase === 'running' ? `<span>${st.round >= 0 ? tnRoundName(st.round, st.rounds.length) : 'In progress'}</span> · <span class="mono">${st.entrants.length}</span> <span>players</span>`
        : st.phase === 'done' ? `<span>Champion:</span> <b data-no-i18n>${esc(st.result.champion.name)}</b>` : '<span>Cancelled: not enough players</span>';
      box.innerHTML = `<div class="tn-teaser-text"><b>Daily tournament</b> <span class="tn-mode-chip">${tnMode(st).name}</span><span class="panel-note tn-teaser-line">${line}</span></div><a class="btn" href="#/tournament">${st.joined ? 'My match' : 'Open'}</a>`;
    } catch (err) { box.innerHTML = '<span class="panel-note">Tournament unavailable</span>'; }
  }

  function renderTournament() {
    currentView = 'tournament';
    tnState = null;
    app.innerHTML = `
      <div class="page page-wide tn-page">
        <a class="back-link" href="#/duel">← Duel</a>
        <h1 class="page-title">🏆 Tournament</h1>
        <p class="panel-note profile-sub">Three tournaments every day (32 players each). Tournaments 1 and 2: sign up before 12:00 UTC (you can join one of them). Evening tournament: sign up from 12:00 to 18:00 UTC, matches until 06:00 UTC; you can join it too. No need to be online at the same time as your opponent: when one of you rolls, the server also rolls for the other, and anything left is rolled for both at the end of the round. The rules change every day (5 modes in turn). Tournament rolls don't count for XP, leaderboards, quests or coins.</p>
        <div id="tn-body"><div class="empty">Loading…</div></div>
      </div>`;
    const refresh = async () => {
      clearTimeout(tnTimer);
      try { tnState = await loadTournament(); drawTournament(); }
      catch (err) { if (!tnState) $('#tn-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
      if (currentView === 'tournament' && !document.hidden) tnTimer = setTimeout(refresh, 15000);
    };
    // Comptes à rebours, à la seconde ; une échéance passée relit l'état (tour suivant, résultats).
    tnTick = setInterval(() => {
      if (currentView !== 'tournament') return stopTournament();
      let due = false;
      document.querySelectorAll('[data-cd]').forEach(el => { const left = Number(el.dataset.cd) - tnClock(); el.textContent = tnCd(left); if (left <= -2000 && left > -3000) due = true; });
      if (due) refresh();
    }, 1000);
    refresh();
  }

  function drawTournament() {
    const st = tnState, body = $('#tn-body');
    if (!st || !body) return;
    const now = tnClock(), R = st.rounds.length;
    const nm = p => `<span class="tn-name" data-no-i18n>${esc(p.name)}</span>`;
    // État du jour
    let status = '';
    // Heures du tournoi regardé, à l'heure du joueur (tournoi du soir : demandé par Me Cojoni, 2026-10-26).
    const hours = `<p class="panel-note tn-hours">${st.eve ? '🌙 <b>Evening tournament</b>' : `🏆 <b>Tournament ${st.which || 1}</b>`} · <span>Sign-ups</span> <span class="mono">${tnHour(st.open)}–${tnHour(st.close)}</span> · <span>Matches</span> <span class="mono">${tnHour(st.close)}–${tnHour(st.end)}</span> <span>(your time)</span></p>`;
    if (st.phase === 'soon') {
      status = `<div class="tn-status"><div><div class="tn-big"><span>Sign-ups open in</span> <span class="mono" data-cd="${st.open}">${tnCd(st.open - now)}</span></div>
        <div class="panel-note"><span>Free · needs ${st.minRolls} rolls · at least ${st.minPlayers} players</span></div></div></div>`;
    } else if (st.phase === 'signup') {
      const can = Store.player.name && !st.joined && (st.eve || !st.mine) && st.count < st.max;
      status = `<div class="tn-status">
          <div><div class="tn-big"><span>Sign-ups close in</span> <span class="mono" data-cd="${st.close}">${tnCd(st.close - now)}</span></div>
          <div class="panel-note"><span class="mono">${st.count}/${st.max}</span> · <span>Free · needs ${st.minRolls} rolls · at least ${st.minPlayers} players</span></div></div>
          ${st.joined ? '<span class="tn-in">✓ You\'re in</span>' : st.mine && !st.eve ? `<span class="tn-in">✓ <span>You're in tournament</span> ${st.mine}</span>` : `<button class="btn-roll small" id="tn-join"${can ? '' : ' disabled'}>${st.count >= st.max ? 'Full' : 'Sign up'}</button>`}
        </div>
        ${st.entrants.length ? `<div class="tn-entrants">${st.entrants.map(e => `<span class="chip${e.me ? ' on' : ''}" data-no-i18n>${esc(e.name)}</span>`).join('')}</div>` : '<p class="panel-note">Nobody yet: be the first!</p>'}`;
    } else if (st.phase === 'running') {
      const r = st.round;
      status = `<div class="tn-status"><div><div class="tn-big">${r >= 0 ? `<span>${tnRoundName(r, R)}</span> · <span>ends in</span> <span class="mono" data-cd="${st.rounds[r].end}">${tnCd(st.rounds[r].end - now)}</span>` : '<span>Results coming</span>'}</div>
        <div class="panel-note"><span class="mono">${st.entrants.length}</span> <span>players</span></div></div></div>`;
    } else if (st.phase === 'done') {
      const res = st.result;
      status = `<div class="tn-podium"><div class="tn-champ">🏆 ${nm(res.champion)}</div>
        <div class="panel-note"><span>Final:</span> ${res.finalist ? nm(res.finalist) : '–'}${res.semis.length ? ` · <span>Semi-finals:</span> ${res.semis.map(nm).join(', ')}` : ''}</div>
        <div class="panel-note"><span>Next tournament opens in</span> <span class="mono" data-cd="${st.next || st.end}">${tnCd((st.next || st.end) - now)}</span></div></div>`;
    } else {
      status = `<div class="tn-status"><div><div class="tn-big"><span>Cancelled: fewer than ${st.minPlayers} players signed up</span></div>
        <div class="panel-note"><span>Next tournament opens in</span> <span class="mono" data-cd="${st.next || st.end}">${tnCd((st.next || st.end) - now)}</span></div></div></div>`;
    }
    if (st.prev) status += `<p class="panel-note tn-prev"><span>${st.prev.champions && st.prev.champions.length > 1 ? 'Yesterday\'s champions:' : 'Yesterday\'s champion:'}</span> <b data-no-i18n>${esc(st.prev.champion)}</b></p>`;
    // Les deux tournois du jour : on regarde l'un ou l'autre (inscrit dans l'un, on ne peut pas entrer dans l'autre).
    status = hours + status;
    // Le tournoi du soir (3) est à part : on peut y être en plus d'un des deux premiers.
    if (st.both) status = `<div class="seg tn-which">${st.both.map(b => `<button data-tn-which="${b.which}" class="${b.which === st.which ? 'on' : ''}">${b.eve ? '🌙 <span>Evening</span>' : `🏆 <span>Tournament</span> ${b.which}`} <span class="mono">${b.count}/${st.max}</span></button>`).join('')}</div>` + status;
    const mode = tnMode(st);
    status = `<div class="tn-mode"><span class="tn-mode-label">Today's mode</span><b class="tn-mode-name">${mode.name}</b><span class="panel-note tn-mode-rule">${mode.rule}</span></div>` + status;

    // Mon match
    let match = '';
    const m = st.match;
    if (m) {
      // « Best of 3 » : chaque carte montre si elle gagne son duel (adversaire visible seulement).
      const duel = (i, s, other) => (st.mode === 'bo3' && other && other[i] !== undefined ? (s > other[i] ? ' tn-duel-win' : s < other[i] ? ' tn-duel-lose' : '') : '');
      const card = (n, s, cls = '') => `<span class="num-card sm${cls}" data-tier="${Engine.cardTier(s)}">${n}</span>`;
      const hidden = k => Array.from({ length: k }, () => '<span class="num-card sm neutral tn-hidden">?</span>').join('');
      const empty = k => Array.from({ length: k }, () => '<span class="num-card sm neutral tn-empty">·</span>').join('');
      const oppScores = m.opp && m.opp.rolls ? m.opp.scores : null;
      const mine = m.me.rolls.map((n, i) => card(n, m.me.scores[i], duel(i, m.me.scores[i], oppScores))).join('') + empty(st.rolls - m.me.count);
      const opp = m.opp ? (m.opp.rolls ? m.opp.rolls.map((n, i) => card(n, m.opp.scores[i], duel(i, m.opp.scores[i], m.me.scores))).join('') + empty(st.rolls - m.opp.count) : hidden(m.opp.count) + empty(st.rolls - m.opp.count)) : '';
      const banner = m.result === 'won' ? (st.phase === 'done' ? '<div class="tn-banner win">🏆 You won the tournament!</div>' : '<div class="tn-banner win">✅ You won this match</div>')
        : m.result === 'lost' ? '<div class="tn-banner lose">❌ You were knocked out</div>' : '';
      const canRoll = m.live && !m.bye && m.me.count < st.rolls;
      match = `<div class="panel">
        <div class="panel-head"><h3 class="panel-title">Your match · <span>${tnRoundName(m.round, R)}</span></h3>${m.live ? `<span class="panel-note"><span>ends in</span> <span class="mono" data-cd="${m.end}">${tnCd(m.end - now)}</span></span>` : now < m.start ? `<span class="panel-note"><span>starts at</span> <span class="mono">${tnHour(m.start)}</span></span>` : ''}</div>
        ${banner}
        ${m.bye ? '<p class="panel-note">Bye: you go straight to the next round.</p>' : `
        <div class="tn-vs">
          <div class="tn-side"><div class="tn-side-head"><b>You</b><span class="mono">${tnScore(st, m.me)}</span></div><div class="tn-cards">${mine}</div>${m.me.auto ? `<p class="panel-note tn-auto">🤖 <span class="mono">${m.me.auto}</span> <span>rolled for you</span></p>` : ''}</div>
          <div class="tn-side"><div class="tn-side-head">${nm(m.opp)}<span class="mono">${m.opp.rolls ? tnScore(st, m.opp) : `${m.opp.count}/${st.rolls}`}</span></div><div class="tn-cards">${opp}</div>
          ${m.opp.rolls && m.opp.auto ? `<p class="panel-note tn-auto">🤖 <span class="mono">${m.opp.auto}</span> <span>rolled for them</span></p>` : ''}
          ${!m.opp.rolls && m.live ? '<p class="panel-note">Their numbers show once you\'ve made all your rolls.</p>' : ''}</div>
        </div>
        ${canRoll ? `<div class="tn-roll-row"><button class="btn-roll" id="tn-roll">🎲 <span>Roll</span> (<span class="mono">${m.me.count + 1}/${st.rolls}</span>)</button></div>` : ''}`}
      </div>`;
    }

    // Tableau
    let bracket = '';
    if (st.size) {
      const side = (p, w, bye) => {
        if (p === undefined) return '<div class="tn-p tn-tbd">–</div>';
        if (!p) return `<div class="tn-p tn-bye">${bye ? 'bye' : '–'}</div>`;
        const cls = w ? (w === p.id ? ' win' : ' lose') : '';
        const score = p.total !== undefined ? (p.score !== undefined && p.score !== null && st.mode !== 'total' && st.mode !== 'lowest' ? `${fmt(p.score)} ${tnUnit(st, p.score)}` : fmt(p.total)) : `${p.count}/${st.rolls}`;
        return `<div class="tn-p${cls}${p.me ? ' me' : ''}">${nm(p)}<span class="mono">${score}</span></div>`;
      };
      bracket = `<div class="panel"><div class="panel-head"><h3 class="panel-title">Bracket</h3><span class="panel-note"><span class="mono">${st.size}</span> <span>slots</span></span></div>
        <div class="tn-bracket" style="--tn-cols:${R}">${st.rounds.map((rd, r) => `<div class="tn-col${r === st.round ? ' now' : ''}">
          <div class="tn-col-head"><b>${tnRoundName(r, R)}</b><span class="panel-note mono">${tnHour(rd.start)}–${tnHour(rd.end)}</span></div>
          <div class="tn-matches">${rd.matches.map(x => `<div class="tn-match">${side(x.a, x.w, x.bye)}${side(x.b, x.w, x.bye)}</div>`).join('')}</div>
        </div>`).join('')}</div></div>`;
    }

    const prizes = `<div class="panel"><div class="panel-head"><h3 class="panel-title">Prizes</h3></div>
      <div class="tn-prizes"><div><span>🥇</span><b class="mono">🪙 ${fmt(st.prizes.champion)}</b><span class="panel-note">+ Champion title</span></div>
      <div><span>🥈</span><b class="mono">🪙 ${fmt(st.prizes.finalist)}</b><span class="panel-note">Finalist</span></div>
      <div><span>🥉</span><b class="mono">🪙 ${fmt(st.prizes.semi)}</b><span class="panel-note">Semi-finalists</span></div></div></div>`;

    body.innerHTML = `<div class="panel">${status}</div>${match}${bracket}${prizes}`;
    body.querySelectorAll('[data-tn-which]').forEach(b => b.addEventListener('click', async () => {
      tnWhich = Number(b.dataset.tnWhich);
      try { tnState = await loadTournament(); drawTournament(); } catch (err) { toast(err.message, 3500, 'error'); }
    }));
    const join = $('#tn-join');
    if (join) join.addEventListener('click', async () => {
      if (tnBusy) return; tnBusy = true; join.disabled = true;
      try { tnState = { ...(await Online.tourney('join', { which: tnState.which })), prev: tnState.prev }; toast(tnState.which === 3 ? '✓ Signed up for the evening tournament' : `✓ Signed up for tournament ${tnState.which}`); tnWhich = tnState.which === 3 ? 3 : 0; drawTournament(); }
      catch (err) { toast(err.message, 3500, 'error'); join.disabled = false; }
      finally { tnBusy = false; }
    });
    const rollBtn = $('#tn-roll');
    if (rollBtn) rollBtn.addEventListener('click', async () => {
      if (tnBusy) return; tnBusy = true; rollBtn.disabled = true;
      try {
        const r = await Online.tourney('roll', { which: tnState.which });
        try { Sound.play('lock', { i: 3 }); } catch (e) { /* son facultatif */ }
        tnState = { ...r.state, prev: tnState.prev }; drawTournament();
        const last = document.querySelectorAll('.tn-side:first-child .tn-cards .num-card:not(.neutral)');
        if (last.length) last[last.length - 1].classList.add('tn-pop');
      } catch (err) { toast(err.message, 3500, 'error'); rollBtn.disabled = false; }
      finally { setTimeout(() => { tnBusy = false; const b = $('#tn-roll'); if (b) b.disabled = false; }, 1500); }
    });
  }

  // ---------------------------------------------------------------- navigation, thème, clavier
  // Code caché n°2 (les deux autres : bas de la page d'aide, et le nombre 0 dans le vérificateur d'XP).
  try { console.log('%c🔑 You found a hidden code: CONSOLECAT', 'font: 700 14px monospace; color: #facc15; background: #111; padding: 6px 10px; border-radius: 6px'); } catch (e) { /* pas de console */ }
  try { paintWallpaper(); } catch (e) { /* jamais bloquant */ }
  // ---- Clans (api/_clan.js, par /api/friends ; idée de BIGBOIJONER69 et KMC, 2026-10-25) : créer ou rejoindre un clan,
  // coffre commun, chat, classement de la semaine et guerres 5 contre 5. Tout est décidé par le serveur ; la page relit
  // le chat et la guerre toutes les 5 s tant qu'elle est ouverte (sans toucher aux formulaires en cours).
  const clanTagHTML = c => (c && c.tag ? `<span class="cl-tag cl-c-${esc(c.c || c.tagc || 'plain')}" title="Clan ${esc(c.tag)}" data-no-i18n>[${esc(c.tag)}]</span>` : '');
  const CL_ROLE = { leader: '👑 Leader', officer: '⭐ Officer', member: 'Member' };
  const CL_RANK = { member: 1, officer: 2, leader: 3 };
  let clanTimer = 0, clanTab = 'mine', clanState = null, clanChatSig = '', clanWarSig = '', clanBusy = false;
  function stopClan() { clearInterval(clanTimer); clanTimer = 0; }
  const clanErr = err => toast([400, 403, 404, 409, 422, 429].includes(err.status) ? err.message : 'Clans unavailable right now, try again');
  const clanLeft = ms => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  function renderClan() {
    currentView = 'clan';
    app.innerHTML = `
      <div class="page cl-page">
        <h1 class="page-title">🏯 Clans</h1>
        <div class="cl-tabs" role="tablist">
          <button class="cl-tabbtn" type="button" role="tab" data-cltab="mine">🛡️ My clan</button><button class="cl-tabbtn" type="button" role="tab" data-cltab="top">🏆 This week</button><button class="cl-tabbtn" type="button" role="tab" data-cltab="find">🔎 Find a clan</button>
        </div>
        <div id="cl-body" class="cl-body"><div class="empty">Loading…</div></div>
      </div>`;
    app.querySelector('.cl-tabs').addEventListener('click', e => { const b = e.target.closest('[data-cltab]'); if (!b) return; clanTab = b.dataset.cltab; drawClanTab(); });
    $('#cl-body').addEventListener('click', onClanClick);
    $('#cl-body').addEventListener('submit', onClanSubmit);
    if (!Store.player.name) { $('#cl-body').innerHTML = '<div class="empty">Roll once and pick a player name to join a clan.</div>'; return; }
    drawClanTab();
    stopClan();
    clanTimer = setInterval(() => {
      if (currentView !== 'clan' || !$('#cl-body')) { stopClan(); return; }
      if (document.hidden || clanTab !== 'mine' || !clanState || !clanState.clan || clanBusy) return;
      loadClanChat();
      const w = clanState.clan.war;
      if (w && (w.st === 'running' || w.st === 'pending')) Online.clan('view').then(d => { if (currentView === 'clan' && clanTab === 'mine') { clanState = d; drawClanWar(); } }).catch(() => {});
    }, 5000);
  }
  function drawClanTab() {
    document.querySelectorAll('.cl-tabbtn').forEach(b => { b.classList.toggle('on', b.dataset.cltab === clanTab); b.setAttribute('aria-selected', String(b.dataset.cltab === clanTab)); });
    const body = $('#cl-body'); if (!body) return;
    body.innerHTML = '<div class="empty">Loading…</div>';
    if (clanTab === 'top') { Online.clan('top').then(drawClanTop).catch(() => { body.innerHTML = '<div class="empty">Clans unavailable right now, try again</div>'; }); return; }
    if (clanTab === 'find') { drawClanFind(); return; }
    Online.clan('view').then(d => { clanState = d; drawClanMine(); }).catch(() => { body.innerHTML = '<div class="empty">Clans unavailable right now, try again</div>'; });
  }
  const clanCard = (c, extra = '') => `<div class="cl-card cl-b-${esc(c.banner || 'slate')}"><span class="cl-emoji" aria-hidden="true">${esc(c.emoji || '🛡️')}</span><span class="cl-card-name"><b data-no-i18n>${esc(c.name)}</b> ${clanTagHTML(c)}<small>👥 <span data-no-i18n>${c.members}/${c.slots}</span>${c.xp != null ? ` · <span data-no-i18n>${compact(c.xp)}</span> XP` : ''}</small>${c.desc ? `<span class="cl-card-desc" data-no-i18n>${esc(c.desc)}</span>` : ''}</span>${extra}</div>`;
  function drawClanTop(d) {
    const body = $('#cl-body'); if (!body || clanTab !== 'top') return;
    const ends = clanLeft(d.end - Date.now());
    body.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">Clan leaderboard</h3><span class="panel-note">Ends in <span data-no-i18n>${ends}</span></span></div>
        <p class="panel-note cl-note">XP earned this week by all the members of each clan. The members of the #1 clan who rolled for it get the 🏯 Clan Champion title when the week ends (Monday 00:00 UTC).</p>
        ${d.last ? `<p class="cl-last-week">🏯 Last week's champions: <b data-no-i18n>${esc(d.last.emoji)} ${esc(d.last.name)}</b> ${clanTagHTML(d.last)}</p>` : ''}
        ${d.clans.length ? `<ol class="cl-top">${d.clans.map(c => `<li class="cl-top-row"><span class="cl-rank" data-no-i18n>#${c.rank}</span>${clanCard(c)}</li>`).join('')}</ol>` : '<div class="empty">No clan has earned XP this week yet.</div>'}
      </div>`;
  }
  function drawClanFind(q = '') {
    const body = $('#cl-body'); if (!body) return;
    body.innerHTML = `
      <div class="panel">
        <form class="cl-row" id="cl-search"><input class="input" id="cl-q" maxlength="20" placeholder="Clan name or tag" autocomplete="off" spellcheck="false" aria-label="Clan name or tag" value="${esc(q)}"><button class="btn" type="submit">🔎 Search</button></form>
        <div id="cl-found"><div class="empty">Loading…</div></div>
      </div>`;
    Online.clan('search', { q }).then(d => {
      const box = $('#cl-found'); if (!box) return;
      const mine = clanState && clanState.clan, asked = (clanState && clanState.asked) || [];
      box.innerHTML = d.clans.length ? `<ul class="cl-list">${d.clans.map(c => `<li>${clanCard(c, mine ? '' : asked.includes(c.tag) ? '<span class="cl-pill">Asked</span>' : c.members >= c.slots ? '<span class="cl-pill">Full</span>' : `<button class="btn" type="button" data-cl="request" data-tag="${esc(c.tag)}">Ask to join</button>`)}</li>`).join('')}</ul>` : '<div class="empty">No clan found. Create yours!</div>';
    }).catch(() => { const box = $('#cl-found'); if (box) box.innerHTML = '<div class="empty">Clans unavailable right now, try again</div>'; });
  }
  function drawClanMine() {
    const body = $('#cl-body'), d = clanState; if (!body || clanTab !== 'mine' || !d) return;
    clanChatSig = ''; clanWarSig = '';
    if (!d.clan) {
      const p = d.prices;
      body.innerHTML = `
        ${d.invites && d.invites.length ? `<div class="panel"><div class="panel-head"><h3 class="panel-title">📨 Invitations</h3></div><ul class="cl-list">${d.invites.map(c => `<li>${clanCard(c, `<span class="cl-actions"><button class="btn-roll small" type="button" data-cl="join" data-tag="${esc(c.tag)}">Join</button><button class="btn ghost" type="button" data-cl="ignore" data-tag="${esc(c.tag)}">Ignore</button></span>`)}</li>`).join('')}</ul></div>` : ''}
        ${d.asked && d.asked.length ? `<div class="panel"><div class="panel-head"><h3 class="panel-title">⏳ Waiting for an answer</h3></div><ul class="cl-list">${d.asked.map(tag => `<li class="cl-asked">${clanTagHTML({ tag })}<button class="btn ghost" type="button" data-cl="unask" data-tag="${esc(tag)}">Cancel</button></li>`).join('')}</ul></div>` : ''}
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Join a clan</h3></div>
          <p class="panel-note cl-note">Ask a clan to let you in, or get invited by its leader or an officer. You can be in one clan at a time.</p>
          <div class="actions"><button class="btn" type="button" data-cl="tab-find">🔎 Find a clan</button></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Create a clan</h3><span class="panel-note">🪙 <span data-no-i18n>${fmt(p.create)}</span></span></div>
          <p class="panel-note cl-note">${p.slotsBase} members to start, up to ${p.slotsMax} with upgrades. You have 🪙 <span data-no-i18n>${fmt(d.me.coins || 0)}</span>.</p>
          <form id="cl-create" class="cl-form">
            <label class="cl-field"><span>Name</span><input class="input" id="cl-name" maxlength="20" minlength="3" placeholder="3 to 20 letters" autocomplete="off" spellcheck="false" required></label>
            <label class="cl-field"><span>Tag</span><input class="input cl-tag-input" id="cl-tagin" maxlength="4" minlength="3" placeholder="ABC" autocomplete="off" spellcheck="false" required></label>
            <label class="cl-field cl-field-wide"><span>Description</span><textarea class="input cl-desc-input" id="cl-descin" maxlength="150" rows="2" placeholder="Tell players what your clan is about (optional)" spellcheck="true"></textarea></label>
            <div class="cl-field"><span>Emoji</span><div class="cl-emojis" id="cl-emojis">${d.emojis.map((e, i) => `<button type="button" class="cl-emo${i ? '' : ' on'}" data-emo="${esc(e)}" aria-label="${esc(e)}">${e}</button>`).join('')}</div></div>
            <div class="actions"><button class="btn-roll small" type="submit"${(d.me.coins || 0) < p.create || (d.me.rolls || 0) < d.minRolls ? ' disabled' : ''}>Create for 🪙 <span data-no-i18n>${fmt(p.create)}</span></button></div>
            ${(d.me.rolls || 0) < d.minRolls ? `<p class="panel-note">🔒 Clans unlock after ${d.minRolls} rolls</p>` : ''}
          </form>
        </div>`;
      const tagIn = $('#cl-tagin'); if (tagIn) tagIn.addEventListener('input', () => { tagIn.value = tagIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
      return;
    }
    const c = d.clan, role = d.me.role, leader = role === 'leader', p = d.prices;
    // Droits des officiers réglés par le chef (idée de kaz, 2026-10-26) : le serveur dit ce que je peux faire.
    const can = d.me.can || {}, officer = CL_RANK[role] >= 2;
    const PERM_LABEL = { invite: '📨 Invite and accept requests', kick: '🥾 Kick members', upgrade: '🪙 Spend the vault on upgrades', war: '⚔️ Start and answer wars', edit: '✏️ Edit description and emoji' };
    const memberRow = m => {
      const acts = [];
      if (!m.me) {
        if (leader && m.role === 'member') acts.push(`<button class="cl-mini" type="button" data-cl="promote" data-name="${esc(m.name)}" title="Make officer">⭐</button>`);
        if (leader && m.role === 'officer') acts.push(`<button class="cl-mini" type="button" data-cl="demote" data-name="${esc(m.name)}" title="Back to member">⬇️</button>`);
        if (leader) acts.push(`<button class="cl-mini" type="button" data-cl="transfer" data-name="${esc(m.name)}" title="Make leader">👑</button>`);
        if (leader || (role === 'officer' && can.kick && m.role === 'member')) acts.push(`<button class="cl-mini" type="button" data-cl="kick" data-name="${esc(m.name)}" title="Kick from the clan">✕</button>`);
      }
      return `<li class="cl-member${m.me ? ' me' : ''}"><span class="cl-dot ${esc(m.status)}" title="${m.status === 'online' ? 'Online' : m.status === 'afk' ? 'Away' : 'Offline'}"></span>${Avatars.html(m.name, 'av-sm')}<a class="cl-mname" href="${profileHref(m.name)}" data-no-i18n>${esc(m.name)}</a><span class="cl-role cl-r-${esc(m.role)}">${CL_ROLE[m.role]}</span><span class="cl-mxp" data-no-i18n>${compact(m.xp)} XP</span>${acts.length ? `<span class="cl-macts">${acts.join('')}</span>` : ''}</li>`;
    };
    body.innerHTML = `
      <div class="cl-banner cl-b-${esc(c.banner)}">
        <span class="cl-emoji big" aria-hidden="true">${esc(c.emoji)}</span>
        <div class="cl-banner-txt"><h2 data-no-i18n>${esc(c.name)}</h2><div>${clanTagHTML(c)} <span class="cl-role cl-r-${esc(role)}">${CL_ROLE[role]}</span></div>${c.desc ? `<p class="cl-desc" data-no-i18n>${esc(c.desc)}</p>` : ''}</div>
      </div>
      ${can.edit ? `<details class="cl-descedit"><summary>✏️ ${c.desc ? 'Edit description' : 'Add a description'}</summary>
        <form id="cl-descform" class="cl-form"><textarea class="input cl-desc-input" id="cl-descedit" maxlength="150" rows="2" placeholder="Tell players what your clan is about">${esc(c.desc || '')}</textarea>
        <div class="actions"><button class="btn-roll small" type="submit">Save</button><span class="panel-note">150 characters · no links or personal info</span></div></form></details>` : ''}
      <div class="tiles cl-tiles">
        ${tile('Vault', `🪙 <span data-no-i18n>${fmt(c.vault)}</span>`, 'for upgrades and wars')}
        ${tile('This week', c.rank ? `#${c.rank}` : '–', `<span data-no-i18n>${compact(c.xp)}</span> XP`)}
        ${tile('Members', `<span data-no-i18n>${c.members.length}/${c.slots}</span>`, c.requests.length ? `📨 ${c.requests.length} waiting` : '&nbsp;')}
        ${tile('Wars', `<span data-no-i18n>${c.wins}–${c.losses}</span>`, c.weekWins ? `🏯 ×${c.weekWins}` : 'won – lost')}
      </div>
      <div class="panel cl-war" id="cl-war"></div>
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">💬 Clan chat</h3></div>
        <div class="dm-list cl-chat" id="cl-chat" aria-live="polite"><div class="empty">Loading…</div></div>
        <form class="dm-form cl-chatform" id="cl-say"><input class="input" id="cl-text" maxlength="140" placeholder="Message to your clan…" autocomplete="off" aria-label="Message"><button class="btn-roll small">Send</button></form>
      </div>
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">👥 Members</h3><span class="panel-note" data-no-i18n>${c.members.length}/${c.slots}</span></div>
        ${can.invite && c.requests.length ? `<div class="cl-reqs"><b>📨 Asking to join</b><ul class="cl-list">${c.requests.map(n => `<li class="cl-asked"><span data-no-i18n>${esc(n)}</span><span class="cl-actions"><button class="btn" type="button" data-cl="accept" data-name="${esc(n)}">Accept</button><button class="btn ghost" type="button" data-cl="decline" data-name="${esc(n)}">Decline</button></span></li>`).join('')}</ul></div>` : ''}
        ${can.invite ? `<form class="cl-row" id="cl-invite"><input class="input" id="cl-inv" maxlength="20" placeholder="Player name" autocomplete="off" spellcheck="false" aria-label="Player name"><button class="btn" type="submit">📨 Invite</button></form>` : ''}
        <ul class="cl-members">${c.members.map(memberRow).join('')}</ul>
      </div>
      <div class="panel">
        <div class="panel-head"><h3 class="panel-title">🪙 Vault</h3><span class="panel-note">🪙 <span data-no-i18n>${fmt(c.vault)}</span></span></div>
        <p class="panel-note cl-note">Coins given to the vault stay in the clan: the leader and officers spend them on upgrades or put them at stake in wars. You have 🪙 <span data-no-i18n>${fmt(d.me.coins || 0)}</span>.</p>
        <form class="cl-row" id="cl-donate"><input class="input" id="cl-amt" type="number" inputmode="numeric" min="${d.donate.min}" max="${d.donate.max}" step="1" value="100" aria-label="Amount"><button class="btn" type="submit">Donate</button></form>
        ${can.upgrade ? `<div class="cl-upgrades">
          <div class="cl-up"><b>🧱 Member slots</b><span class="panel-note" data-no-i18n>${c.slots}/${p.slotsMax}</span>${c.nextSlots ? `<button class="btn" type="button" data-cl="up-slots">+${p.slotStep} · 🪙 <span data-no-i18n>${fmt(c.nextSlots)}</span></button>` : '<span class="cl-pill">Max</span>'}</div>
          <div class="cl-up"><b>🎨 Banner color</b><span class="panel-note">🪙 <span data-no-i18n>${fmt(p.banner)}</span></span><div class="cl-swatches">${d.banners.map(b => `<button type="button" class="cl-sw cl-b-${b}${b === c.banner ? ' on' : ''}" data-cl="up-banner" data-color="${b}" title="${b}" aria-label="${b}"></button>`).join('')}</div></div>
          <div class="cl-up"><b>🏷️ Tag color</b><span class="panel-note">🪙 <span data-no-i18n>${fmt(p.tagc)}</span> · 🌈 <span data-no-i18n>${fmt(p.rainbow)}</span></span><div class="cl-swatches">${d.tagColors.map(t => `<button type="button" class="cl-sw cl-tsw${t === c.tagc ? ' on' : ''}" data-cl="up-tagc" data-color="${t}" title="${t}" aria-label="${t}"><span class="cl-tag cl-c-${t}" data-no-i18n>${esc(c.tag)}</span></button>`).join('')}</div></div>
        </div>` : ''}
        <details class="cl-log"><summary>Vault history</summary><ul>${c.log.map(clanLogLine).join('') || '<li class="muted">Nothing yet</li>'}</ul></details>
      </div>
      ${leader ? `<div class="panel">
        <div class="panel-head"><h3 class="panel-title">⭐ What officers can do</h3></div>
        <p class="panel-note cl-note">Only you can change this. You can always do everything.</p>
        <div class="cl-perms">${Object.keys(PERM_LABEL).map(k => `<label class="cl-perm"><input type="checkbox" data-cl="perm" data-perm="${k}"${c.perms && c.perms[k] === false ? '' : ' checked'}><span>${PERM_LABEL[k]}</span></label>`).join('')}</div>
      </div>` : officer ? `<div class="panel"><p class="panel-note cl-note"><span>⭐ Officers can:</span> ${Object.keys(PERM_LABEL).filter(k => can[k]).map(k => `<span>${PERM_LABEL[k]}</span>`).join(' · ') || '<span>nothing more than members</span>'}</p></div>` : ''}
      <div class="panel cl-danger">
        ${leader ? `<button class="btn ghost" type="button" data-cl="disband">🗑️ Disband the clan</button>` : `<button class="btn ghost" type="button" data-cl="leave">🚪 Leave the clan</button>`}
      </div>`;
    drawClanWar();
    loadClanChat();
  }
  function clanLogLine(x) {
    const n = `<b data-no-i18n>${esc(x.n || '')}</b>`, a = v => `<b class="mono" data-no-i18n>${fmt(Math.abs(v || 0))}</b>`, by = x.by ? ` <span class="muted">(<span data-no-i18n>${esc(x.by)}</span>)</span>` : '';
    const when = `<i data-no-i18n>${new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</i>`;
    const tag = x.x ? clanTagHTML({ tag: x.x }) : '';
    const kind = String(x.x || '').split(':')[0];
    const line = {
      create: `🏯 ${n} <span>founded the clan</span>`, join: `👋 ${n} <span>joined</span>${by}`, leave: `🚪 ${n} <span>left</span>`, kick: `🥾 ${n} <span>was kicked</span>${by}`,
      promote: `⭐ ${n} <span>is now an officer</span>${by}`, demote: `⬇️ ${n} <span>is a member again</span>${by}`, leader: `👑 ${n} <span>is the new leader</span>${by}`,
      donate: `🪙 ${n} <span>donated</span> ${a(x.a)}`, perms: `⭐ ${n} <span>changed what officers can do</span>`,
      buy: `${kind === 'slots' ? '🧱' : kind === 'banner' ? '🎨' : '🏷️'} ${n} <span>${kind === 'slots' ? 'bought 5 member slots' : kind === 'banner' ? 'changed the banner color' : 'changed the tag color'}</span> −${a(x.a)}`,
      stake: `⚔️ ${n} <span>put coins at stake against</span> ${tag} −${a(x.a)}`, refund: `↩️ <span>War stake returned</span> +${a(x.a)}`,
      won: `🏆 <span>Won the war against</span> ${tag} +${a(x.a)}`, lost: `💀 <span>Lost the war against</span> ${tag}`,
    }[x.k] || '';
    return line ? `<li>${line} ${when}</li>` : '';
  }
  function drawClanWar() {
    const box = $('#cl-war'), d = clanState; if (!box || !d || !d.clan) return;
    const c = d.clan, w = c.war, officer = !!(d.me.can || {}).war;
    const picker = id => `<div class="cl-pick" id="${id}">${c.members.map(m => `<label class="cl-pickm"><input type="checkbox" value="${esc(m.name)}"><span data-no-i18n>${esc(m.name)}</span></label>`).join('')}</div>`;
    let html;
    if (!w || w.st === 'off') {
      html = `<div class="panel-head"><h3 class="panel-title">⚔️ Clan war</h3></div>
        <p class="panel-note cl-note">${d.war.size} against ${d.war.size}: each player gets ${d.war.rolls} server rolls over ${d.war.ms / 3600000} hours (missing rolls are made at the end). Highest total XP wins both stakes, minus ${Math.round(d.war.cut * 100)}%.</p>
        ${c.past.length ? `<ul class="cl-past">${c.past.map(x => `<li>${x.won ? '🏆' : '💀'} ${clanTagHTML({ tag: x.vs })} <span data-no-i18n>${compact(x.us)} – ${compact(x.them)}</span> · 🪙 <span data-no-i18n>${fmt(x.stake)}</span></li>`).join('')}</ul>` : ''}
        ${officer ? (c.members.length >= d.war.size ? `<form id="cl-challenge" class="cl-form">
          <div class="cl-row"><input class="input cl-tag-input" id="cl-target" maxlength="4" placeholder="Their tag" autocomplete="off" spellcheck="false" aria-label="Their tag"><input class="input" id="cl-stake" type="number" inputmode="numeric" min="${d.war.min}" max="${d.war.max}" step="1" value="1000" aria-label="Stake"></div>
          <p class="panel-note">Pick ${d.war.size} players:</p>${picker('cl-pick-a')}
          <div class="actions"><button class="btn-roll small" type="submit">⚔️ Challenge</button></div></form>` : `<p class="panel-note">🔒 You need ${d.war.size} members for a war.</p>`) : ''}`;
    } else if (w.st === 'pending') {
      html = `<div class="panel-head"><h3 class="panel-title">⚔️ ${w.incoming ? 'War challenge!' : 'Challenge sent'}</h3><span class="panel-note">🪙 <span data-no-i18n>${fmt(w.stake)}</span></span></div>
        <p class="cl-vs">${clanTagHTML(w.a)} <b data-no-i18n>${esc(w.a.name)}</b> <span class="muted">vs</span> ${clanTagHTML(w.b)} <b data-no-i18n>${esc(w.b.name)}</b></p>
        <p class="panel-note">Expires in <span data-no-i18n>${clanLeft(w.expires - Date.now())}</span></p>
        ${w.incoming && officer ? `<form id="cl-answer" class="cl-form"><p class="panel-note">Pick ${d.war.size} players to accept:</p>${picker('cl-pick-b')}<div class="actions"><button class="btn-roll small" type="submit">✅ Accept</button><button class="btn ghost" type="button" data-cl="war-no">Decline</button></div></form>` : ''}
        ${!w.incoming && officer ? '<div class="actions"><button class="btn ghost" type="button" data-cl="war-no">Cancel the challenge</button></div>' : ''}`;
    } else {
      const mine = w.a.mine ? w.a : w.b, theirs = w.a.mine ? w.b : w.a, meP = mine.players.find(p => p.me);
      const team = s => `<div class="cl-team${s.mine ? ' mine' : ''}"><div class="cl-team-head">${clanTagHTML(s)} <b class="mono" data-no-i18n>${compact(s.total)} XP</b></div><ol>${s.players.map(p => `<li${p.me ? ' class="me"' : ''}><span class="cl-pn" data-no-i18n>${esc(p.name)}</span><span class="cl-pr" data-no-i18n>${p.scores.length}/${w.rolls}</span><b class="mono" data-no-i18n>${compact(p.total)}</b></li>`).join('')}</ol></div>`;
      const done = w.st === 'done';
      html = `<div class="panel-head"><h3 class="panel-title">⚔️ ${done ? (w.won ? '🏆 War won!' : '💀 War lost') : 'War in progress'}</h3><span class="panel-note">🪙 <span data-no-i18n>${fmt(w.stake)}</span>${done ? '' : ` · Ends in <span data-no-i18n>${clanLeft(w.end - Date.now())}</span>`}</span></div>
        <div class="cl-teams">${team(mine)}${team(theirs)}</div>
        ${!done && meP ? `<div class="actions"><button class="btn-roll small" type="button" data-cl="war-roll"${meP.scores.length >= w.rolls ? ' disabled' : ''}>🎲 War roll <span data-no-i18n>${meP.scores.length}/${w.rolls}</span></button></div>${meP.rolls.length ? `<p class="cl-myrolls" data-no-i18n>${meP.rolls.map((n, i) => `${String(n).padStart(6, '0')} · ${compact(meP.scores[i])}`).join('  |  ')}</p>` : ''}` : ''}
        ${!done && !meP ? '<p class="panel-note">Cheer for your team: their rolls show up here.</p>' : ''}`;
    }
    // La guerre se relit toutes les 5 s : on ne réécrit le cadre que s'il a changé et qu'aucun choix n'y est en cours.
    if (html === clanWarSig || box.querySelector('input:checked, input:focus')) return;
    clanWarSig = html; box.innerHTML = html;
  }
  function loadClanChat() {
    return Online.clan('chat').then(drawClanChat).catch(() => {});
  }
  function drawClanChat(d) {
    const list = $('#cl-chat'); if (!list) return;
    const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const html = d.messages.length ? d.messages.map(x => `<p class="dm-msg ${x.me ? 'me' : 'them'}">${x.me ? '' : `<b class="cl-from" data-no-i18n>${esc(x.name)}${x.role === 'leader' ? ' 👑' : x.role === 'officer' ? ' ⭐' : ''}</b>`}<span data-no-i18n>${esc(x.text)}</span><i>${time(x.t)}${x.edited ? ' · edited' : ''}${x.canEdit ? ` · <button class="dm-report" data-cl="msg-edit" data-t="${x.t}" data-text="${esc(x.text)}">Edit</button>` : ''}${x.canDelete ? ` · <button class="dm-report" data-cl="msg-del" data-t="${x.t}">Delete</button>` : ''}${x.me ? '' : ` · <button class="dm-report" data-cl="msg-report" data-t="${x.t}" title="Report this message to the creator of the game">Report</button>`}</i></p>`).join('') : '<div class="empty">No message yet. Say hi to your clan!</div>';
    if (html === clanChatSig) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    clanChatSig = html; list.innerHTML = html;
    if (atBottom || !list.dataset.ready) list.scrollTop = list.scrollHeight;
    list.dataset.ready = '1';
  }
  async function clanDo(op, extra = {}, btn) {
    if (clanBusy) return null;
    clanBusy = true; if (btn) btn.disabled = true;
    try {
      const d = await Online.clan(op, extra);
      if (d && d.me) { clanState = d; if (d.me.coins != null) Store.setSetting('coins', d.me.coins); if (clanTab === 'mine') drawClanMine(); else if (clanTab === 'find') drawClanFind(($('#cl-q') || {}).value || ''); }
      if (d && d.note) toast(d.note);
      return d;
    } catch (err) { clanErr(err); if (btn) btn.disabled = false; return null; }
    finally { clanBusy = false; }
  }
  const clanPicked = id => [...document.querySelectorAll(`#${id} input:checked`)].map(x => x.value);
  async function onClanClick(e) {
    const emo = e.target.closest('[data-emo]');
    if (emo) { document.querySelectorAll('.cl-emo').forEach(b => b.classList.toggle('on', b === emo)); return; }
    const b = e.target.closest('[data-cl]'); if (!b) return;
    const op = b.dataset.cl, name = b.dataset.name, tag = b.dataset.tag;
    const T = s => (window.RNGI18n ? window.RNGI18n.t(s) : s);
    if (op === 'tab-find') { clanTab = 'find'; drawClanTab(); return; }
    if (op === 'perm') {
      // Le chef coche ou décoche un droit : on envoie tout l'état des cases (idée de kaz, 2026-10-26).
      const perms = Object.fromEntries([...document.querySelectorAll('[data-cl="perm"]')].map(x => [x.dataset.perm, x.checked]));
      const d = await clanDo('perms', { perms }); if (d) toast('Officer rights saved', 2000, 'achv'); return;
    }
    if (['request', 'join', 'ignore', 'unask'].includes(op)) { const d = await clanDo(op, { tag }, b); if (d && op === 'join') toast('Welcome to the clan!', 3000, 'achv'); if (d && op === 'request' && clanTab === 'find') drawClanFind(($('#cl-q') || {}).value || ''); return; }
    if (['accept', 'decline', 'promote', 'demote'].includes(op)) { clanDo(op, { name }, b); return; }
    if (op === 'kick' && confirm(T(`Kick ${name} from the clan?`))) { clanDo('kick', { name }, b); return; }
    if (op === 'transfer' && confirm(T(`Make ${name} the clan leader? You will become an officer.`))) { clanDo('transfer', { name }, b); return; }
    if (op === 'leave' && confirm(T('Leave the clan?'))) { clanDo('leave', {}, b); return; }
    if (op === 'disband' && confirm(T('Disband the clan? The vault coins are lost and every member leaves.'))) { clanDo('disband', {}, b); return; }
    if (op === 'up-slots' && confirm(T('Spend vault coins on 5 more member slots?'))) { clanDo('upgrade', { what: 'slots' }, b); return; }
    if ((op === 'up-banner' || op === 'up-tagc') && !b.classList.contains('on') && confirm(T('Spend vault coins on this color?'))) { clanDo('upgrade', { what: op === 'up-banner' ? 'banner' : 'tagc', color: b.dataset.color }, b); return; }
    if (op === 'war-no' && confirm(T('Call off this war? The stake goes back to the clan that sent it.'))) { clanDo('answer', { yes: false }, b); return; }
    if (op === 'war-roll') {
      if (clanBusy) return;
      clanBusy = true; b.disabled = true;
      try { const r = await Online.clan('warroll'); clanState = r.state; clanWarSig = ''; drawClanWar(); toast(`🎲 ${String(r.n).padStart(6, '0')} · +${fmt(r.s)} XP`, 2500, 'achv'); Sound.play('lock', { i: 2 }); }
      catch (err) { clanErr(err); b.disabled = false; }
      finally { clanBusy = false; }
      return;
    }
    if (op === 'msg-report') { reportMessage(b, () => Online.clan('report', { t: Number(b.dataset.t) })); return; }
    if (op === 'msg-del') { try { drawClanChat(await Online.clan('unsend', { t: Number(b.dataset.t) })); } catch (err) { clanErr(err); } return; }
    if (op === 'msg-edit') {
      const v = prompt(T('Edit your message'), b.dataset.text);
      if (v == null || !v.trim() || v === b.dataset.text) return;
      try { drawClanChat(await Online.clan('edit', { t: Number(b.dataset.t), text: v })); } catch (err) { clanErr(err); }
    }
  }
  async function onClanSubmit(e) {
    const f = e.target; e.preventDefault();
    const btn = f.querySelector('button[type=submit], button:not([type])');
    if (f.id === 'cl-search') { drawClanFind($('#cl-q').value.trim()); return; }
    if (f.id === 'cl-create') {
      const emoji = (document.querySelector('.cl-emo.on') || {}).dataset;
      const d = await clanDo('create', { clanName: $('#cl-name').value.trim(), tag: $('#cl-tagin').value.trim(), emoji: emoji ? emoji.emo : undefined, desc: ($('#cl-descin') || {}).value || '' }, btn);
      if (d && d.clan) { toast(`🏯 ${d.clan.name} is born!`, 3500, 'achv'); Sound.play('lock', { i: 5 }); }
      return;
    }
    // Description du clan (Sacha, 2026-10-25) : chef et officiers ; vide = effacée.
    if (f.id === 'cl-descform') { const d = await clanDo('desc', { desc: $('#cl-descedit').value }, btn); if (d) toast('Description saved', 2000, 'achv'); return; }
    if (f.id === 'cl-invite') { const n = $('#cl-inv').value.trim(); if (!n) { toast('Enter a player name'); return; } clanDo('invite', { name: n }, btn); return; }
    if (f.id === 'cl-donate') { const amount = Number($('#cl-amt').value); const d = await clanDo('donate', { amount }, btn); if (d) { toast(`🪙 ${fmt(amount)} → ${d.clan.tag}`, 2500, 'achv'); Sound.play('lock', { i: 3 }); } return; }
    if (f.id === 'cl-say') {
      const input = $('#cl-text'); if (!input.value.trim()) return;
      btn.disabled = true;
      try { drawClanChat(await Online.clan('say', { text: input.value })); input.value = ''; const l = $('#cl-chat'); if (l) l.scrollTop = l.scrollHeight; }
      catch (err) { clanErr(err); }
      btn.disabled = false; input.focus();
      return;
    }
    if (f.id === 'cl-challenge') {
      const team = clanPicked('cl-pick-a');
      if (team.length !== clanState.war.size) { toast(`Pick ${clanState.war.size} players`); return; }
      clanWarSig = '';
      clanDo('challenge', { target: $('#cl-target').value.trim(), stake: Number($('#cl-stake').value), team }, btn);
      return;
    }
    if (f.id === 'cl-answer') {
      const team = clanPicked('cl-pick-b');
      if (team.length !== clanState.war.size) { toast(`Pick ${clanState.war.size} players`); return; }
      clanWarSig = '';
      clanDo('answer', { yes: true, team }, btn);
    }
  }

  const ROUTES = { clan: renderClan, '': renderHome, gamble: renderGamble, history: renderHistory, stats: renderStats, badges: renderBadges, leaderboard: renderLeaderboard, about: renderAbout, duel: renderDuelHub, tournament: renderTournament, shop: renderShop, friends: renderFriends, owner: renderOwner, ideas: renderIdeas, roadmap: renderRoadmap };

  function route() {
    Avatars.load();
    if (session && !session.finished) session.cancel();
    FX.clear();
    clearTimeout(lbTimer);
    stopRoom();
    clearTimeout(hubTimer);
    stopTournament();
    stopClan();
    clearTimeout(friendsTimer);
    closeModal();
    tip.hidden = true;
    const [key, ...rest] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
    if (key === 'player' && rest.length) renderProfile(decodeURIComponent(rest.join('/')));
    else if (key === 'room' && rest.length) renderRoom(rest[0]);
    else (ROUTES[key] || renderHome)();
    const navKey = key === 'player' ? 'leaderboard' : key === 'room' || key === 'tournament' ? 'duel' : key === 'clan' ? 'friends' : key;
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
  // Musique de fond « Distant Odds » de Phong67 (2026-10-21) : en boucle, très bas, coupée avec le son ou à part dans
  // les réglages. Les navigateurs refusent le son avant une première action du joueur : elle démarre à son premier clic
  // ou sa première touche, et se met en pause quand l'onglet est caché.
  const MUSIC_VOLUME = 0.03;
  const Music = {
    el: null, started: false,
    on: () => Store.settings.music !== 'off' && soundOn(),
    sync() {
      if (this.started && this.on() && !document.hidden) {
        if (!this.el) { this.el = new Audio('media/music/distant-odds.mp3'); this.el.loop = true; this.el.volume = MUSIC_VOLUME; }
        this.el.play().catch(() => {});
      } else if (this.el) this.el.pause();
    },
    start() { if (this.started) return; this.started = true; this.sync(); },
  };
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => Music.start(), { once: true, capture: true }));
  document.addEventListener('visibilitychange', () => Music.sync());
  $('#sound-btn').addEventListener('click', () => {
    Store.setSetting('sound', soundOn() ? 'off' : 'on');
    applySound(true);
    Music.sync();
  });

  function syncPlayer() { $('#player-name').textContent = Store.player.name || 'Player'; syncHeaderAvatar(); }
  Store.onChange(syncPlayer);
  $('#player-btn').addEventListener('click', openSettings);
  // ---------------------------------------------------------------- chat global (demandé par Sacha, 2026-10-25)
  // Un panneau ouvert par le bouton 💬 (coin en bas à droite ; en bas de page sur téléphone, comme les autres coins).
  // Tout le monde lit ; écrire demande Google + 100 tirages (vérifié par le serveur, api/_global.js, qui refuse aussi
  // liens, insultes et infos personnelles). Relecture toutes les 3 s seulement panneau ouvert ET onglet visible.
  // Les messages sont du texte échappé (esc), marqués data-no-i18n (pseudos : .player-link) : jamais de HTML d'un joueur, jamais traduits.
  const GChat = {
    open: false, timer: 0, msgs: [], rev: null, del: 0, me: null, busy: false, menu: null,
    el: null,
    mount() {
      if (this.el) return this.el;
      const el = document.createElement('section');
      el.className = 'gc-panel'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Global chat');
      el.innerHTML = `<header class="gc-head"><h2 class="gc-title">💬 Global chat</h2><span class="gc-note">Be kind · no personal info</span><button class="gc-close" aria-label="Close" title="Close">×</button></header>
        <div class="gc-list" aria-live="polite"><div class="empty">Loading…</div></div>
        <footer class="gc-foot"></footer>`;
      document.body.appendChild(el);
      el.querySelector('.gc-close').addEventListener('click', () => this.close());
      el.addEventListener('click', e => this.onClick(e));
      el.addEventListener('submit', e => { e.preventDefault(); this.send(); });
      el.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });
      this.el = el;
      return el;
    },
    toggle() { this.open ? this.close() : this.show(); },
    show() {
      const el = this.mount();
      el.hidden = false; this.open = true;
      document.querySelectorAll('[data-gchat]').forEach(b => b.setAttribute('aria-expanded', 'true'));
      this.rev = null; // première lecture : la liste entière
      this.dot(false);
      this.poll();
    },
    close() {
      if (this.el) this.el.hidden = true;
      this.open = false; clearTimeout(this.timer);
      document.querySelectorAll('[data-gchat]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    },
    // Relecture : une seule à la fois, la suivante 3 s après la réponse ; rien si le panneau est fermé ou l'onglet caché.
    async poll() {
      clearTimeout(this.timer);
      if (!this.open || document.hidden) return;
      try { this.apply(await Online.global('gcList', { rev: this.rev, del: this.del, since: this.last() })); } catch (err) { if (!this.msgs.length) this.list().innerHTML = '<div class="empty">Unavailable right now.</div>'; }
      if (this.open && !document.hidden) this.timer = setTimeout(() => this.poll(), 3000);
    },
    // Point rouge sur 💬 (demandé par Sacha, 2026-10-25) : panneau fermé, un coup d'œil toutes les 30 s (onglet visible)
    // compare le compteur de messages du serveur (rev) au dernier vu (gardé dans le navigateur, gcSeen). Réponse minuscule
    // (« same ») quand rien n'a bougé. Le premier passage note simplement le compteur, sans point.
    dot(on) { document.querySelectorAll('[data-gchat]').forEach(b => b.classList.toggle('unread', !!on)); },
    seen(rev) { if (rev != null) try { localStorage.setItem('gcSeen', String(rev)); } catch (e) { /* stockage plein ou bloqué */ } },
    peekRev: null, peekDel: 0, peekTimer: 0,
    async peek() {
      clearTimeout(this.peekTimer);
      if (!this.open && !document.hidden) {
        try {
          const d = await Online.global('gcList', { rev: this.peekRev, del: this.peekDel, since: Date.now() });
          this.peekRev = d.rev; this.peekDel = d.del;
          let seen = null; try { seen = localStorage.getItem('gcSeen'); } catch (e) { seen = null; }
          if (seen === null) { this.seen(d.rev); this.dot(this.mentioned(d.me)); } // 1re visite : rien, sauf une mention
          else if (!this.open) this.dot((Number(d.rev) > Number(seen) && Number(d.rev) !== Number(d.del)) || this.mentioned(d.me)); // une suppression seule n'allume rien
        } catch (err) { /* hors ligne : on réessaie plus tard */ }
      }
      this.peekTimer = setTimeout(() => this.peek(), 30000);
    },
    // @mentions (idée de casmictechthing, 2026-10-26) : le serveur donne l'heure de ma dernière mention (lastAt) ; tant
    // qu'elle est plus récente que la dernière vue (gcAtSeen), le point rouge reste, même si le message est arrivé avant.
    mentioned(me) { if (!me || !me.lastAt) return false; let s = 0; try { s = Number(localStorage.getItem('gcAtSeen')) || 0; } catch (e) { s = 0; } return me.lastAt > s; },
    seenAt(me) { if (me && me.lastAt) try { localStorage.setItem('gcAtSeen', String(me.lastAt)); } catch (e) { /* stockage bloqué */ } },
    // Texte d'un message avec les @pseudo cités surlignés (seulement les joueurs que le serveur a reconnus).
    textHTML(m) {
      const at = (m.at || []).map(n => n.toLowerCase());
      if (!at.length) return esc(m.text);
      return String(m.text).split(/((?:^|(?<=[\s(]))@[\p{L}0-9_.\-']{2,20})/u).map(part => {
        const name = part.startsWith('@') ? part.slice(1).replace(/[.\-']+$/, '') : null;
        if (!name || !at.includes(name.toLowerCase())) return esc(part);
        return `<b class="gc-at">@${esc(name)}</b>${esc(part.slice(1 + name.length))}`;
      }).join('');
    },
    last() { return this.msgs.length ? this.msgs[this.msgs.length - 1].t : 0; },
    list() { return this.el.querySelector('.gc-list'); },
    apply(d) {
      const before = JSON.stringify(this.me);
      this.rev = d.rev; this.del = d.del; this.max = d.max || 200; if (d.editMs) this.editMs = d.editMs;
      if (this.open) { this.seen(d.rev); this.seenAt(d.me); this.dot(false); }
      if (d.me) this.me = d.me;
      if (JSON.stringify(this.me) !== before || !this.el.querySelector('.gc-foot').childElementCount) this.drawFoot();
      if (d.same) return;
      this.msgs = d.full ? d.msgs : [...this.msgs, ...d.msgs.filter(m => m.t > this.last())].slice(-100);
      this.drawList();
    },
    drawList() {
      const box = this.list(), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      const me = this.me || {}, signed = !!Store.player.name;
      const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      box.innerHTML = this.msgs.length ? this.msgs.map(m => `<div class="gc-msg${m.mine ? ' gc-mine' : ''}${m.toMe ? ' gc-tome' : ''}" data-id="${esc(m.id)}">
          <div class="gc-meta">${Avatars.html(m.name, 'av-xs')}<a class="player-link gc-name" href="${profileHref(m.name)}">${esc(m.name)}</a>${titleHTML(m.title)}<time class="gc-time" datetime="${new Date(m.t).toISOString()}" title="${esc(fullDate(m.t))}">${time(m.t)}</time>
${m.edited ? '<span class="gc-edited">edited</span>' : ''}
            ${signed || me.mod ? `<button class="gc-more" data-gc-menu aria-label="Message options" title="Options">⋯</button>` : ''}</div>
          <p class="gc-text" data-no-i18n>${this.textHTML(m)}</p>
          ${this.menu === m.id ? `<div class="gc-actions">${!m.mine && signed ? '<button data-gc="report">🚩 Report</button>' : ''}${m.mine && Date.now() - m.t < (this.editMs || 300000) ? '<button data-gc="edit">✏️ Edit</button>' : ''}${me.mod || m.mine ? `<button data-gc="delete">🗑️ Delete</button>${m.mine ? '' : '<button data-gc="mute" data-dur="1h">🔇 1 h</button><button data-gc="mute" data-dur="24h">🔇 24 h</button><button data-gc="mute" data-dur="perm">⛔ Forever</button>'}` : ''}</div>` : ''}
        </div>`).join('') : '<div class="empty">No message yet. Say hi! 👋</div>';
      if (stick) box.scrollTop = box.scrollHeight;
    },
    // Pied du panneau : la zone d'écriture, ou pourquoi on ne peut pas écrire (Google, tirages, silence).
    drawFoot() {
      const foot = this.el.querySelector('.gc-foot'), me = this.me;
      const keep = foot.querySelector('.gc-input'), draft = keep ? keep.value : '', had = keep && document.activeElement === keep;
      if (me && me.can) {
        foot.innerHTML = `<form class="gc-form"><input class="input gc-input" maxlength="${this.max || 200}" placeholder="Write a message… (@name to mention)" aria-label="Write a message" autocomplete="off" enterkeyhint="send"><button class="btn-roll small gc-send">Send</button></form>`;
        const i = foot.querySelector('.gc-input'); i.value = draft; if (had) i.focus();
        return;
      }
      const why = !me || !Store.player.name ? 'Pick a player name and make 100 rolls to write here.'
        : me.reason === 'muted' ? (me.mutedUntil < 0 ? '🔇 You can no longer write in the chat.' : `🔇 You are muted until ${fullDate(me.mutedUntil)}.`)
        : me.reason === 'google' ? `To write here, link a Google account (⚙️ Settings) and make ${me.need} rolls.`
        : `To write here, make ${me.need} rolls (you have ${fmt(me.rolls)}).`;
      foot.innerHTML = `<p class="gc-why">${esc(why)}</p>${me && me.reason === 'google' ? '<button class="btn ghost small" data-gc="google">⚙️ Link Google</button>' : ''}`;
    },
    async send() {
      const input = this.el.querySelector('.gc-input'); if (!input || this.busy) return;
      const text = input.value.trim(); if (!text) return;
      this.busy = true; const btn = this.el.querySelector('.gc-send'); btn.disabled = true;
      try {
        this.apply(await Online.global('gcSend', { text, since: this.last(), del: this.del }));
        input.value = ''; this.list().scrollTop = this.list().scrollHeight;
      } catch (err) { toast(err.status && err.status < 500 ? err.message : 'Unavailable right now, try again', 4500); if (err.status === 403) this.poll(); }
      finally { this.busy = false; btn.disabled = false; }
    },
    async onClick(e) {
      const menu = e.target.closest('[data-gc-menu]');
      if (menu) { const id = menu.closest('.gc-msg').dataset.id; this.menu = this.menu === id ? null : id; this.drawList(); return; }
      const b = e.target.closest('[data-gc]'); if (!b) return;
      if (b.dataset.gc === 'google') { this.close(); openSettings(); return; }
      const id = b.closest('.gc-msg').dataset.id, t = s => (window.RNGI18n ? window.RNGI18n.t(s) : s);
      try {
        // Modifier son message, 5 minutes (idée de daddy finger, 2026-10-26) : le serveur rejoue tous les filtres.
        if (b.dataset.gc === 'edit') {
          const m = this.msgs.find(x => x.id === id); if (!m) return;
          const v = prompt(t('Edit your message'), m.text);
          if (v == null || !v.trim() || v.trim() === m.text) return;
          this.apply(await Online.global('gcEdit', { id, text: v })); toast('Message edited');
        } else
        if (b.dataset.gc === 'report') { const r = await Online.global('gcReport', { id }); toast(r.already ? 'Already reported' : 'Reported: thank you!'); }
        else if (b.dataset.gc === 'delete') { if (!confirm(t('Delete this message?'))) return; this.apply(await Online.global('gcDelete', { id })); toast('Message deleted'); }
        else if (b.dataset.gc === 'mute') { if (!confirm(t('Mute this player and delete the message?'))) return; this.apply(await Online.global('gcMute', { id, dur: b.dataset.dur })); toast('Player muted'); }
        this.menu = null; this.drawList();
      } catch (err) { toast(err.status && err.status < 500 ? err.message : 'Unavailable right now, try again'); }
    },
  };
  GChat.peek();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !GChat.open) GChat.peek(); });
  document.addEventListener('visibilitychange', () => { if (GChat.open && !document.hidden) GChat.poll(); });
  // Changer de page ferme le panneau : il couvrirait la droite de la page (et tout l'écran sur téléphone).
  window.addEventListener('hashchange', () => GChat.close());

  // Roue crantée en haut à droite (demandé par Sacha, 2026-10-23) : les réglages, thème compris, à la place des trois boutons de thème.
  $('#gear-btn').addEventListener('click', openSettings);

  document.addEventListener('click', e => {
    // Feuille de route depuis la fenêtre des idées : déjà sur #/roadmap, l'adresse ne change pas ; on ferme quand même.
    if (e.target.closest('.idea-roadmap a')) closeModal();
    // Lien vers une page du site (profil d'un joueur…) dans une ligne cliquable : la navigation l'emporte.
    if (e.target.closest('a[href^="#/"]')) return;
    if (e.target.closest('[data-trailer]')) { e.preventDefault(); openTrailer(); return; }
    if (e.target.closest('[data-coffee]')) { e.preventDefault(); openCoffee(); return; }
    if (e.target.closest('[data-idea]')) { e.preventDefault(); openIdeas(); return; }
    if (e.target.closest('[data-gchat]')) { e.preventDefault(); GChat.toggle(); return; }
    if (e.target.closest('[data-fund]')) { e.preventDefault(); openFund(); return; }
    // Aperçu d'un skin demandé hors de la grille du Shop (fenêtre de la cagnotte) ; la grille a son propre écouteur.
    { const pv = e.target.closest('[data-skin-preview]'); if (pv && !pv.closest('.skin-grid')) { e.preventDefault(); previewSkin(pv.dataset.skinPreview); return; } }
    if (e.target.closest('[data-news]')) { e.preventDefault(); openNews(); return; }
    if (e.target.closest('[data-intro]')) { e.preventDefault(); openIntro(); return; }
    const badge = e.target.closest('[data-badge]');
    if (badge) { e.preventDefault(); openBadgeModal(badge.dataset.badge); return; }
    const number = e.target.closest('[data-number]');
    if (number) { e.preventDefault(); openNumberModal(Number(number.dataset.number), number.dataset.caption || '', number.dataset.owner || ''); return; }
    const roll = e.target.closest('[data-roll]');
    if (roll) { e.preventDefault(); openRollModal(Number(roll.dataset.roll)); }
  });

  document.addEventListener('keydown', e => {
    const modalOpen = !!$('#modal-root').firstChild;
    if (e.key === 'Escape' && modalOpen) { closeModal(); return; }
    if (!modalOpen && currentView === 'room' && e.target.tagName !== 'INPUT') {
      if (isRollKey(e)) {
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
    if (isRollKey(e)) {
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

  // ---- Discord : lier son compte (rôles de rareté, Supporter… donnés tout seuls sur le serveur RNG∞, 2026-10-17).
  // Connexion OAuth2 « implicite » : Discord renvoie sur le site avec #access_token=… ; le serveur vérifie le jeton.
  const DISCORD = { app: '1561067574509183136', invite: 'https://discord.gg/Jz5VRa5w9R' };
  function discordAuthorize() {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    try { sessionStorage.setItem('rngDiscordState', state); } catch (e) { /* sans stockage : refusé au retour */ }
    location.href = `https://discord.com/oauth2/authorize?client_id=${DISCORD.app}&response_type=token&scope=${encodeURIComponent('identify guilds.join')}&redirect_uri=${encodeURIComponent(location.origin + '/')}&state=${state}`;
  }
  async function drawDiscordLink() {
    const box = $('#f-discord');
    if (!box) return;
    let st = null;
    try { st = await Online.discord('state'); } catch (e) { box.innerHTML = ''; return; }
    if (!$('#f-discord')) return;
    box.innerHTML = st.linked
      ? `<span class="dl-on">✓ Discord linked: <b data-no-i18n>${esc(st.username || '')}</b></span><button class="btn ghost" data-dl="sync">🔄 Update my roles</button><button class="btn ghost" data-dl="unlink">Unlink</button>`
      : `<span class="dl-off">Link Discord to get your rarity role on the <a href="${DISCORD.invite}" target="_blank" rel="noopener">RNG∞ server</a></span>${st.available ? '<button class="btn dl-btn" data-dl="link">🔗 Link my Discord</button>' : ''}`;
    box.onclick = async e => {
      const b = e.target.closest('[data-dl]');
      if (!b) return;
      if (b.dataset.dl === 'link') { discordAuthorize(); return; }
      b.disabled = true;
      try {
        const r = await Online.discord(b.dataset.dl);
        toast(b.dataset.dl === 'unlink' ? 'Discord unlinked' : r.inGuild === false ? 'Join the RNG∞ Discord first, then update your roles' : `Roles updated: ${(r.roles || []).join(', ')}`);
      } catch (err) { toast(err.message || 'Discord is not answering, try again'); }
      drawDiscordLink();
    };
  }
  // Retour de Discord après l'autorisation.
  if (/access_token=/.test(location.hash) || /[#&]error=/.test(location.hash)) {
    const q = new URLSearchParams(location.hash.slice(1));
    let expected = null;
    try { expected = sessionStorage.getItem('rngDiscordState'); sessionStorage.removeItem('rngDiscordState'); } catch (e) { /* idem */ }
    history.replaceState(null, '', location.pathname + location.search + '#/friends');
    const token = q.get('access_token');
    if (token && expected && q.get('state') === expected && Store.player.id) {
      Online.discord('link', { accessToken: token })
        .then(r => { toast(`🎉 Discord linked as ${r.username}${r.roles && r.roles.length ? ` · roles: ${r.roles.join(', ')}` : ''}`, 6000, 'achv'); drawDiscordLink(); })
        .catch(err => toast(err.message || 'Could not link Discord, try again', 5000));
    } else if (q.get('error')) toast('Discord link cancelled');
  }

  MatrixRain.watch(app);
  window.addEventListener('hashchange', route);
  applyTheme();
  applySound();
  syncPlayer();
  route();
  syncHistory().catch(() => {});

  // Nouvelle version en ligne (demandé par Sacha, 2026-10-22) : la page relit la version au serveur toutes les 5 min et au retour sur
  // l'onglet, compare le tampon de js/app.js avec le sien, et se recharge seule à un moment sans risque (rien en cours :
  // pas de tirage, d'auto-roll, de duel, de partie de casino ni de fenêtre ouverte). Sinon, un bandeau propose de recharger.
  const Updater = {
    mine: (document.querySelector('script[src*="js/app.js"]')?.getAttribute('src').match(/v=([^&"]+)/) || [])[1] || null,
    ready: false,
    async check() {
      if (!this.mine || this.ready) return;
      try {
        // Demandé au serveur de jeu (VPS), pas à l'hébergeur du site : rien ne compte dans les quotas de Vercel.
        const live = (await Online.request('/api/site', { method: 'POST', body: JSON.stringify({ action: 'version' }) })).app;
        if (live && live !== this.mine) { this.ready = true; this.apply(); }
      } catch (e) { /* hors ligne : on réessaiera */ }
    },
    safe() {
      return !$('#modal-root').firstChild && !rollPending && (!session || session.finished) && !SoloAuto.on && !Gamble.busy && !['room', 'tournament'].includes(currentView);
    },
    apply() {
      if (!this.ready) return;
      if (this.safe()) { location.reload(); return; }
      if (!document.getElementById('update-bar') && !document.hidden) {
        const bar = document.createElement('button');
        bar.id = 'update-bar'; bar.className = 'update-bar'; bar.type = 'button';
        bar.innerHTML = `🆕 <b>${window.RNGI18n ? window.RNGI18n.t('New version available') : 'New version available'}</b> · ${window.RNGI18n ? window.RNGI18n.t('Refresh') : 'Refresh'}`;
        bar.addEventListener('click', () => location.reload());
        document.body.appendChild(bar);
      }
    },
  };
  setInterval(() => { if (!document.hidden) Updater.check(); Updater.apply(); }, 300000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Updater.check(); else Updater.apply(); });
  window.addEventListener('hashchange', () => setTimeout(() => Updater.apply(), 300)); // changement de page : souvent un bon moment

  // Première visite (aucun tirage, pas de pseudo, pas un lien de duel) : les 3 écrans d'accueil.
  const brandNew = !Store.rolls.length && !Store.player.name;
  paintNewsDot();
  loadAnnouncements();
  QuestWatch.sync(true); // état des quêtes du jour, pour annoncer celles qui se terminent ensuite
  // Skin et bouton de tirage choisis sur un autre appareil : on les reprend au chargement (joueurs connus seulement).
  if (Store.player.name) Online.shop().then(applyShop).catch(() => { /* hors ligne : on garde ce que l'appareil connaît */ });
  setInterval(() => HdrCoins.refresh(), 60000); // le solde bouge aussi ailleurs (cadeaux, duels, autre appareil)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) HdrCoins.refresh(); });
  // Pièces offertes par un ami depuis la dernière visite (la page Amis s'en charge elle-même).
  if (Store.player.name && currentView !== 'friends') setTimeout(checkGifts, 1500);
  if (brandNew && !Store.settings.onboarded && currentView === 'home') setTimeout(() => { if (currentView === 'home' && !$('#modal-root').firstChild) openIntro(); }, 350);

  // Fréquentation : une balise anonyme par visite (une fois par onglet), pour savoir d'où viennent les joueurs.
  // Envoyé : le site d'origine (pas l'adresse complète), ?ref= ou ?utm_source= s'il y en a, téléphone ou ordinateur,
  // la langue, et deux drapeaux « première visite » / « première visite du jour » tenus sur l'appareil.
  // Rien n'identifie le visiteur ; les navigateurs pilotés par un robot ne comptent pas. Seule exception : arrivé par un
  // lien tagué, le lien est gardé sur l'appareil et rattaché au joueur quand il choisit son pseudo (api/name.js).
  try {
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if (!sessionStorage.getItem('rng-visit') && (!navigator.webdriver || local)) {
      sessionStorage.setItem('rng-visit', '1');
      const today = new Date().toISOString().slice(0, 10);
      const first = brandNew && !localStorage.getItem('rng-first-visit');
      const daily = localStorage.getItem('rng-last-visit') !== today;
      if (!localStorage.getItem('rng-first-visit')) localStorage.setItem('rng-first-visit', today);
      localStorage.setItem('rng-last-visit', today);
      let ref = '';
      try { const h = new URL(document.referrer).hostname; if (h && h !== location.hostname) ref = h; } catch (e) { /* pas d'origine */ }
      const q = new URLSearchParams(location.search);
      // Premier lien d'arrivée (?ref=…), gardé pour l'envoyer avec le pseudo : on saura quel joueur il a amené.
      const arrived = (q.get('utm_source') || q.get('ref') || '').toLowerCase();
      if (arrived && /^[a-z0-9_.-]{1,30}$/.test(arrived) && !localStorage.getItem('rng-first-src') && !Store.player.name) localStorage.setItem('rng-first-src', arrived);
      Online.request('/api/site', { local: true, method: 'POST', body: JSON.stringify({
        action: 'visit', ref, src: q.get('utm_source') || q.get('ref') || '', first, daily,
        mobile: window.matchMedia('(max-width: 720px)').matches || /Mobi|Android/i.test(navigator.userAgent),
        lang: (window.RNGI18n && window.RNGI18n.lang) || 'en',
      }) }).then(r => { if (r && r.fund) Fund.set(r.fund); }).catch(() => {});
    }
  } catch (e) { /* stockage bloqué : pas de balise */ }
})();
