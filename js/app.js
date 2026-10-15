/* RNG∞ — interface : tirage animé, historique, stats, collection, réglages. */
(function () {
  'use strict';

  const Engine = RNGEngine.createEngine(window.BADGE_META, window.SCORE_PERCENTILES);
  const TIERS_DESC = ['infinite', 'divine', 'celestial', 'mythic', 'anomaly', 'epic', 'rare', 'uncommon', 'common', 'trash'];
  const TIER_RANK = { trash: 0, common: 1, uncommon: 2, rare: 3, epic: 4, anomaly: 5, mythic: 6, celestial: 7, divine: 8, infinite: 9 };
  const TIER_EMOJI = { trash: '🟫', common: '⬜', uncommon: '🟩', rare: '🟦', epic: '🟪', anomaly: '🟧', mythic: '🟥', celestial: '💠', divine: '🌟', infinite: '♾️' };
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
        const body = await res.json().catch(() => ({}));
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
    async request(pathname, options = {}) {
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
    // Boîte à suggestions et fréquentation (api/site.js) ; toujours en POST.
    site(action, extra = {}) {
      const p = Store.player;
      return this.request('/api/site', { method: 'POST', body: JSON.stringify({ playerId: p.id, secret: p.secret, name: p.name, action, ...extra }) });
    },
    // Toujours en POST : le secret du joueur ne va jamais dans une adresse.
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
  const compact = v => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
  const tierPill = tier => `<span class="pill" data-tier="${tier}">${tier}</span>`;

  // "Top x %" / "Bottom x %" arrondi et coloré selon le percentile, comme l'écran de résultat d'origine.
  function percentileHTML(p) {
    // Jamais « <1 % » : sous 1 %, le chiffre exact (0,4 %, 0,05 %, 0,001 %).
    const text = p >= 50 ? `Top ${precisePct(100 - p)}%` : `Bottom ${precisePct(p)}%`;
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
    Store.setSetting('skinsOwned', state.owned || []);
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
  const spinChar = card => (card && card.classList.contains('skin-matrix') ? MatrixRain.glyph() : String((Math.random() * 10) | 0));
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
  function share(a) {
    const rank = Engine.topLabel(a.percentile);
    const canvas = document.createElement('canvas');
    const data = {
      str: a.str, tier: a.tier, rank: rank ? cap(rank.toLowerCase()) : '', xp: fmt(a.total), name: Store.player.name || '', host: 'rng-infinite.com',
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
  const TIER_RING = { uncommon: '#10b981', rare: '#3b82f6', epic: '#a855f7', anomaly: '#f97316', mythic: '#ec4899', celestial: '#22d3ee', divine: '#fde047', infinite: '#ffffff' };
  function shockwave(el, tier) {
    const color = TIER_RING[tier];
    if (!color || reducedMotion || !el) return;
    const r = el.getBoundingClientRect();
    const rings = TIER_RANK[tier] > TIER_RANK.mythic ? TIER_RANK[tier] - 3 : TIER_RANK[tier] >= TIER_RANK.epic ? 2 : 1; // Celestial 4, Divine 5, Infinite 6
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
      m.querySelector('[data-rewatch]').addEventListener('click', () => rewatch(r[0], `Your roll #${fmt(index + 1)}`));
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
      ${passwordHTML()}
      <div class="field"><label>Roll animation</label>${seg('speed', ['dramatic', 'normal'], SPEEDS[s.speed] ? s.speed : 'normal', SPEED_LABELS)}</div>
      <div class="field"><label>Skip known badges</label>${countedRolls() >= SKIP_BADGES_AT ? seg('skipBadges', ['on', 'off'], s.skipBadges === 'on' ? 'on' : 'off') : `<span class="panel-note">🔒 Unlocks at ${fmt(SKIP_BADGES_AT)} rolls (you have ${fmt(countedRolls())})</span>`}<span class="panel-note" style="display:block;margin-top:.25rem">Badges you already own appear at once. New badges always get their full reveal.</span></div>
      <div class="field"><label>Sound</label>${seg('sound', ['on', 'off'], soundOn() ? 'on' : 'off')}</div>
      <div class="field"><label>Performance mode</label>${seg('perf', ['on', 'off'], s.perf === 'on' ? 'on' : 'off')}<span class="panel-note" style="display:block;margin-top:.25rem">Fewer animations and effects, for tablets and devices that lag. Your rolls stay the same.</span></div>
      <div class="field"><label>Theme</label>${seg('theme', ['light', 'system', 'dark'], s.theme)}</div>
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
      m.querySelectorAll('[data-seg]').forEach(group => {
        group.addEventListener('click', e => {
          const btn = e.target.closest('button');
          if (!btn) return;
          group.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn));
          Store.setSetting(group.dataset.seg, btn.dataset.v);
          if (group.dataset.seg === 'theme') applyTheme();
          if (group.dataset.seg === 'sound') applySound(true);
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
          toast(`🎁 Code ${st.redeemed.code}: +${fmt(st.redeemed.coins)} coins${st.redeemed.title ? ' and a new title' : ''}!`, 5000, 'achv');
          Sound.play('reveal', { small: 1 });
        } catch (err) {
          toast(err.status && err.status < 500 ? err.message : 'Unavailable right now, try again');
        } finally { btn.disabled = false; }
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
          <button class="btn-roll${genClass()}" id="roll-btn">Generate</button>
          <p class="hint">
            ${rolls.length ? `${plural(countedRolls(), 'roll')} · ${fmt(lifetimeEP())} lifetime XP · ` : ''}
            ${name ? `playing as <b>${esc(name)}</b> · ` : '<a href="javascript:void 0" id="pick-name">pick a name</a> · '}
            press <kbd>Space</kbd>
          </p>
          ${soloAutoHTML()}
          <button class="btn ghost trailer-btn" data-trailer>${playIcon()} Watch the trailer</button>
          <div class="home-row"><div id="quests-slot"></div><div data-fund-slot></div></div>
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
    slot.onclick = async e => {
      const btn = e.target.closest('[data-quest], [data-daily]');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
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

  function googleAccountHTML() {
    if (!googleEnabled()) return '';
    const g = Store.player.google;
    return g
      ? `<div class="field"><label>Account</label>
          <div class="google-row"><span>Signed in with Google as <b>${esc(g.email || 'your account')}</b></span><button class="btn" id="google-out">Sign out</button></div>
          <span class="panel-note">Your player, leaderboard spots and whole roll history (stats, badges) follow you on every device.</span></div>`
      : `<div class="field"><label>Account</label>
          <div id="google-btn" class="google-btn"></div>
          ${GOOGLE_PROMO}
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
        <div class="result-actions"><button class="btn" data-rewatch>▶ Rewatch</button></div>
        ${breakdownHTML(n, a)}
      </div>`, m => {
      m.querySelector('[data-rewatch]').addEventListener('click', () => rewatch(n, caption || ''));
      animateDigits(m, { stagger: 120 });
    });
  }

  // Journal des mises à jour : un rond en bas à gauche, au-dessus du lien GitHub, avec une pastille tant que la
  // dernière entrée n'a pas été lue sur cet appareil. Les textes sont écrits dans les deux langues (pas traduits au vol).
  const UPDATES = [
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
  const newsUnread = () => Store.settings.newsSeen !== UPDATES[0].id;
  function paintNewsDot() { const b = $('#news-btn'); if (b) b.classList.toggle('unread', newsUnread()); }
  function openNews() {
    const fr = window.RNGI18n && window.RNGI18n.lang === 'fr';
    openModal(`<h2>${fr ? 'Nouveautés' : 'What\'s new'}</h2><div class="news-list" data-no-i18n>${UPDATES.map((u, i) => `
      <div class="news-item"><div class="eyebrow">${u.date}${i === 0 && newsUnread() ? ' <span class="new-tag">NEW</span>' : ''}</div><ul>${(fr ? u.fr : u.en).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>`);
    Store.setSetting('newsSeen', UPDATES[0].id);
    paintNewsDot();
  }

  // Revoir un tirage (le sien ou celui d'un autre) : la révélation complète rejouée avec mon skin, sans rien tirer ni
  // enregistrer. Les badges se rejouent tous (pas de saut), l'XP à vie ne bouge pas.
  function rewatch(n, caption) {
    if (session && !session.finished) session.cancel();
    closeModal();
    const back = (session && session.replayBack) || location.hash;
    currentView = 'result';
    session = playReveal({ n, a: analysis(n), previous: [], newIds: null, isFirst: false, lifetimeBefore: lifetimeEP(), index: -1, online: null, replay: { caption, back } });
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
  // Tirage auto en solo : relance toute seule à la fin de chaque révélation, tant que l'interrupteur est allumé.
  // Jamais gardé d'une visite à l'autre ; s'éteint en quittant l'écran de tirage, sur un tirage hors ligne, et
  // s'arrête de lui-même sur un Mythic ou mieux pour que le joueur le voie.
  const SoloAuto = { on: false, timer: 0 };
  // Rareté à laquelle le tirage auto s'arrête (choisie par le joueur, Mythic par défaut).
  const AUTO_STOPS = ['rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'infinite'];
  const autoStop = () => (AUTO_STOPS.includes(Store.settings.autoStop) ? Store.settings.autoStop : 'mythic');
  const soloAutoHTML = () => `<span class="solo-auto-box"><label class="room-auto solo-auto" title="Rolls again by itself after each reveal, until the rarity you chose"><input type="checkbox" id="solo-auto"${SoloAuto.on ? ' checked' : ''}><i aria-hidden="true"></i><span>Auto-roll</span></label><label class="solo-stop"><span>stop on</span><select id="solo-stop" aria-label="Rarity that stops auto-roll">${AUTO_STOPS.map(t => `<option value="${t}"${t === autoStop() ? ' selected' : ''} data-no-i18n>${cap(t)}${t === 'infinite' ? '' : '+'}</option>`).join('')}</select></label></span>`;
  function stopSoloAuto() {
    SoloAuto.on = false;
    clearTimeout(SoloAuto.timer);
    const box = $('#solo-auto');
    if (box) box.checked = false;
  }
  function bindSoloAuto() {
    const box = $('#solo-auto');
    if (!box) return;
    const stop = $('#solo-stop');
    if (stop) stop.addEventListener('change', () => { if (AUTO_STOPS.includes(stop.value)) Store.setSetting('autoStop', stop.value); });
    box.addEventListener('change', () => {
      SoloAuto.on = box.checked;
      clearTimeout(SoloAuto.timer);
      if (!SoloAuto.on) return;
      Sound.unlock();
      if (!session || session.finished) startRoll(true);
    });
  }
  function scheduleSoloAuto(delay) {
    clearTimeout(SoloAuto.timer);
    SoloAuto.timer = setTimeout(() => {
      if (!SoloAuto.on) return;
      if (currentView !== 'result' && currentView !== 'home') { stopSoloAuto(); return; }
      // Onglet caché ou fenêtre ouverte : on attend sans rien tirer.
      if (document.hidden || $('#modal-root').firstChild) { scheduleSoloAuto(1000); return; }
      startRoll(true);
    }, delay);
  }
  async function startRoll(force) {
    if (rollPending) return;
    if (session && !session.finished && force !== true && !session.canReroll) return;
    if (!Store.player.name) { askName(() => startRoll(force), '', '', 'Save & roll'); return; }
    rollPending = true;
    const buttons = Array.from(document.querySelectorAll('#roll-btn, #r-again'));
    buttons.forEach(b => { b.disabled = true; });
    let n, online = null;
    // Le serveur ne répond pas (réseau, délai dépassé) : on redemande deux fois le même tirage avant de renoncer.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    const asked = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await Online.roll(nonce); } catch (err) {
          if (err.status === 409 || err.status === 429 || err.status === 403 || attempt >= 2) throw err;
          if (!attempt) toast('The server is slow to answer, trying again…');
          await new Promise(resolve => setTimeout(resolve, 600 + 900 * attempt));
        }
      }
    })();
    Sound.play('click'); // après l'envoi de la demande : au tout premier tirage, ouvrir la sortie audio bloque la page ~0,1 s
    try {
      online = await asked;
      n = online.n;
    } catch (err) {
      if (err.status === 429 && SoloAuto.on) { rollPending = false; buttons.forEach(b => { b.disabled = false; }); scheduleSoloAuto(1500); return; }
      if (SoloAuto.on) stopSoloAuto();
      if (err.status === 409) {
        rollPending = false;
        buttons.forEach(b => { b.disabled = false; });
        askName(() => startRoll(force), '', `"${Store.player.name}" is already taken by another player. Pick a new name.`, 'Save & roll');
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
    if (ctx.replay) return `<p class="repeat-note">▶ Replay${ctx.replay.caption ? ` · <span data-no-i18n>${esc(ctx.replay.caption)}</span>` : ''} · nothing is rolled or counted</p>`;
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
    // Niveau de vitesse acheté dans la boutique : toute la révélation raccourcit, chiffres compris (un rewatch aussi).
    const kd = Shop.speedFactor(Store.settings.speedLv);
    const k = speed.base * kd, kb = speed.badges * kd;
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
    Sound.warm([['tier', { tier: a.tier }]]);
    // La scène du skin : particules et lumière dans la carte et autour, calées sur les mêmes instants.
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
      sfx('lock', i < lead ? { i, soft: 1 } : i === slotCount - 1 ? { i, final: 1 } : { i });
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
    const known = g => skipKnown && ![g.badge, ...g.subsidiary].some(b => ctx.newIds && ctx.newIds.has(b.id));
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
      if (ctx.online) { noteAchievements(ctx.online.achievements); QuestWatch.bump(questDelta(a.total, a.tier)); }
      // Compte Google associé avant que le bonus existe : il arrive avec ce tirage.
      if (ctx.online && ctx.online.googleBonus) setTimeout(() => { toast(`🪙 +${ctx.online.googleBonus} coins for linking your Google account`, 5000, 'achv'); if (Store.settings.coins != null) Store.setSetting('coins', Store.settings.coins + ctx.online.googleBonus); }, 1200);
    });
    step(REVEAL.stats, () => show($('#r-meta'), 'pop-in'));
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
      if (SoloAuto.on && !ctx.replay) {
        if (TIER_RANK[a.tier] >= TIER_RANK[autoStop()]) { stopSoloAuto(); toast(`✨ Auto-roll stopped on ${cap(a.tier)}: enjoy it!`, 5000, 'achv'); }
        else scheduleSoloAuto(900);
      }
    });

    const runStep = s => { if (!s.done) { s.done = true; late = performance.now() - began - s.at > 250; s.run(false); } };
    $('#r-share').addEventListener('click', () => share(a));
    if (ctx.replay) {
      $('#r-back').addEventListener('click', () => { if (session) session.cancel(); session = null; if (location.hash === ctx.replay.back) route(); else location.hash = ctx.replay.back || '#/'; });
      $('#r-replay').addEventListener('click', () => { if (session) session.cancel(); session = null; rewatch(n, ctx.replay.caption); });
    } else { $('#r-again').addEventListener('click', () => startRoll(true)); bindSoloAuto(); }

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
    let items = Store.rolls.map((r, i) => ({ n: r[0], s: r[1], t: r[2], i, tier: Engine.cardTier(r[1]), off: !!r[3] }));
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
      const a = analysis(n), top = Engine.topLabel(a.percentile);
      $('#xc-out').innerHTML = `
        <div class="xc-result">
          <span class="xc-sim">Simulation · not a roll</span>
          <div class="xc-num mono" data-no-i18n>${(() => { const full = String(n).padStart(6, '0'), lead = n ? full.search(/[1-9]/) : 5; return `<span class="xc-ghost">${full.slice(0, lead)}</span>${full.slice(lead)}`; })()}</div>
          <div class="xc-meta"><span class="badge-pill" data-tier="${a.tier}">${esc(a.tier)}</span><b class="mono">${fmt(a.total)} XP</b><span class="panel-note">${esc(top)}</span></div>
          <div class="pill-row xc-badges">${a.groups.length ? a.groups.map(g => `<span class="badge-pill" data-tier="${g.badge.tier}" data-badge="${g.badge.id}" style="cursor:pointer">${g.badge.emoji} ${esc(g.badge.label)}</span>`).join(' ') : '<span class="panel-note">No badge</span>'}</div>
        </div>`;
    });
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
    $('#p-title').innerHTML = `${esc(p.name)}${me ? ' <span class="muted">(you)</span>' : ''} ${titleHTML(p.title)}${topHTML(p.top)}${me ? '' : ' <button class="btn add-friend" id="p-friend">👥 Add friend</button>'}`;
    const addFriend = $('#p-friend');
    if (addFriend) addFriend.addEventListener('click', () => friendAction('add', p.name));
    if (me) noteAchievements(p.achievements);
    $('#p-body').innerHTML = `
      ${(p.tops || []).length > 1 ? `<p class="panel-note top-marks-row"><span>Monthly trophies</span> ${p.tops.map(topHTML).join('')}</p>` : ''}
      <p class="panel-note profile-sub">${p.rolls ? `Playing since ${day(p.since)} · last roll ${relTime(p.last)}` : 'No rolls yet'}</p>
      <div class="tiles">
        ${tile('Rolls', fmt(p.rolls), p.rolls ? `${fmt(p.lifetime / p.rolls)} XP per roll` : '–')}
        ${tile('Lifetime XP', compact(p.lifetime), `${fmt(p.lifetime)} XP`)}
        ${tile('Best roll', top ? `<span data-number="${top.n}" data-caption="${esc(caption(top))}" style="cursor:pointer">${analysis(top.n).str}</span>` : '–', top ? `${fmt(top.s)} XP` : '')}
        ${tile('All-time rank', p.rank ? '#' + p.rank : '–', 'best single roll')}
        ${tile('Badges', `${found}/${total}`, `${((found / total) * 100).toFixed(0)}% of the collection`)}
        ${tile('Best quest streak', p.questBest ? plural(p.questBest, 'day') : '–', 'days in a row with every quest done')}
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
      ...['infinite', 'divine', 'celestial', 'mythic', 'anomaly', 'epic', 'rare'].map(t => [`${cap(t)} rolls`, p => (p.tiers && p.tiers[t]) || 0, v => fmt(v), 1]),
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
  }

  // Catégories de la boutique, dans l'ordre des onglets.
  const SHOP_TABS = [['limited', '🎃', 'Limited'], ['skins', '🎨', 'Skins'], ['buttons', '🔘', 'Buttons'], ['emotes', '😎', 'Emotes'], ['cases', '📦', 'Cases'], ['speed', '⚡', 'Upgrades']];
  function renderShop() {
    currentView = 'shop';
    app.innerHTML = `
      <div class="page page-wide">
        <div class="g-head"><h1 class="page-title">Shop</h1><span class="g-wallet"><span class="eyebrow">Your coins</span><b class="mono" id="d-coins">${Store.settings.coins != null ? `🪙 ${fmt(Store.settings.coins)}` : '🪙 …'}</b></span></div>
        <p class="panel-note profile-sub">Earn coins by rolling, with the daily quests and by winning duels. <span class="case-odds" data-tip="${esc(`<b>Coins per roll</b><br>${Object.entries(Shop.COINS).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)} · ${fmt(v)}`).join('<br>')}<br><b>Duel won</b> · +${Shop.DUEL_WIN_COINS}`)}">How much? ⓘ</span></p>
        <div data-fund-slot></div>
        <div class="shop-tabs" id="shop-tabs" role="tablist">${SHOP_TABS.map(([id, emoji, label]) => `<button role="tab" data-shop-tab="${id}"><i aria-hidden="true">${emoji}</i><span>${label}</span></button>`).join('')}</div>
        <section class="shop-pane" data-shop-pane="limited" hidden>
        <div class="panel limited-panel">
          <div class="panel-head"><h3 class="panel-title">Limited skins</h3><span class="panel-note">for a short time only · once bought, yours forever</span></div>
          <div class="limited-banner" id="limited-banner"><i aria-hidden="true">🦇</i><i aria-hidden="true">🦇</i><i aria-hidden="true">🦇</i><b>🎃 HALLOWEEN EVENT</b><span id="limited-left"></span></div>
          <div class="skin-grid" id="d-limited"><div class="empty">Loading…</div></div>
        </div>
        </section>
        <section class="shop-pane" data-shop-pane="cases" hidden>
        <div class="panel">
          <div class="panel-head"><h3 class="panel-title">Cases</h3><span class="panel-note">a random skin · the pricier the skin, the rarer</span></div>
          <div class="case-grid" id="d-cases">${Shop.CASES.map(c => {
            const odds = Shop.caseOdds(c).map(o => `<span style="color:${Shop.rarityOf(o.id).color}">■</span> ${Shop.byId.get(o.id).emoji} ${Shop.byId.get(o.id).name} · ${(o.p * 100).toFixed(1)}%`).join('<br>');
            return `
            <div class="case-tile">
              <div class="case-box" aria-hidden="true">${c.emoji}</div>
              <div class="skin-name"><b>${esc(c.name)}</b><span>${esc(c.desc)}</span></div>
              <div class="case-contents" aria-hidden="true">${Shop.caseOdds(c).map(o => `<i style="--rar:${Shop.rarityOf(o.id).color}" title="${esc(Shop.byId.get(o.id).name)}"></i>`).join('')}</div>
              <span class="case-odds" data-tip="${esc(`<b>${c.name} odds</b><br>${odds}`)}">Odds ⓘ</span>
              <button class="btn" data-case="${c.id}">🪙 ${fmt(c.price)}</button>
            </div>`;
          }).join('')}</div>
          <p class="panel-note" style="margin:.6rem 0 0">Already own the skin you draw? Part of the case price comes back, more for rarer skins: 50% for a Common up to 90% for a Legendary. Coins only, no real money.</p>
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
        <section class="shop-pane" data-shop-pane="emotes" hidden>
        <div class="panel" id="d-emotes-panel" hidden>
          <div class="panel-head"><h3 class="panel-title">Emotes</h3><span class="panel-note">animated reactions for your duels · everyone sees them</span></div>
          <p class="panel-note" style="margin-top:-.3rem">The six classic emotes are free. These ones move: buy one once and it joins your reaction bar in every duel.</p>
          <div class="skin-grid emote-grid" id="d-emotes"></div>
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
    drawSpeed(state);
    const cases = $('#d-cases');
    if (cases) cases.onclick = e => {
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
          <div class="skin-name"><b>${k.emoji} ${esc(k.name)}</b><span>${esc(k.desc)}</span></div>
          <div class="skin-actions">${SkinFX.has(k.id) || k.id === 'owner' ? `<button class="btn ghost" data-skin-preview="${k.id}" title="Preview">▶ Preview</button>` : ''}${button}</div>
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
  const Gamble = { chip: 50, bets: {}, busy: false, coins: null, hand: null, tab: 'crash', top: 'winners', side: [false, false], asset: 'btc', tf: '1h', ind: { ma: true, vol: true }, lev: null, levSide: 'long', levX: 5, levSeen: 0, zoom: 90, hover: null, hy: null, mines: 3, mn: null, cr: null, raf: 0 };
  const gamble = (action, extra) => Online.shopAction(action, undefined, extra);
  const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  // Une carte : recto (deux index et la couleur en grand) et verso ; `fresh` la fait glisser depuis le sabot et se retourner.
  const cardHTML = (c, fresh, i = 0) => `<span class="pcard${c ? (c.s === 1 || c.s === 2 ? ' red' : '') : ' down'}${fresh ? ' deal' : ''}" style="--i:${i}" data-no-i18n><span class="pc-in"><span class="pc-front">${c ? `<b>${RANKS[c.r]}<i>${SUITS[c.s]}</i></b><em>${c.r > 10 ? RANKS[c.r] : SUITS[c.s]}</em><b class="low">${RANKS[c.r]}<i>${SUITS[c.s]}</i></b>` : ''}</span><span class="pc-back"></span></span></span>`;
  // Bandeau « en direct » du casino : tout l'argent qui y est passé (mises prises, gains versés, tous joueurs confondus
  // depuis l'ouverture) et les dernières manches.
  // Relu toutes les 20 s tant que la page est affichée. Ma propre manche n'y apparaît qu'après 7 s : le bandeau ne doit
  // pas annoncer le résultat avant la fin de l'animation (roue, bille, cartes).
  const GAME_ICONS = { crash: '🚀', mines: '💣', plinko: '🔻', roulette: '🎡', bj: '🃏', slots: '🎰' };
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
  function renderGamble() {
    currentView = 'gamble';
    const bet = (t, label, cls = '') => `<button class="rbet ${cls}" data-bet="${t}"><span>${label}</span><b class="mono"></b></button>`;
    app.innerHTML = `
      <div class="page page-wide">
        <div class="g-head"><h1 class="page-title">Gamble</h1><span class="g-wallet"><span class="eyebrow">Your coins</span><b class="mono" id="g-coins">${Store.settings.coins != null ? `🪙 ${fmt(Store.settings.coins)}` : '🪙 …'}</b></span></div>
        <p class="panel-note profile-sub">Play with the coins you earn in the game. No real money: coins cannot be bought or cashed out. Bets from ${fmt(10)} to ${fmt(1000)} coins, unlocked after 30 rolls.</p>
        <div class="g-live" id="g-live" hidden></div>
        <div class="g-tabs" id="g-tabs">${[['crash', '🚀', 'Crash'], ['mines', '💣', 'Mines'], ['plinko', '🔻', 'Plinko'], ['slots', '🎰', 'Slots'], ['roulette', '🎡', 'Roulette'], ['bj', '🃏', 'Blackjack'], ['btc', '📈', 'Crypto']].map(([id, e, label]) => `<button class="g-tab${id === Gamble.tab ? ' on' : ''}" data-game-tab="${id}"><i>${e}</i><span>${label}</span></button>`).join('')}</div>
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
          <div class="panel g-game" data-game="mines">
            <div class="panel-head"><h3 class="panel-title">Mines</h3><span class="panel-note">every safe tile raises the payout · one mine ends it · max win 250×</span></div>
            <div class="mn-setup"><span class="eyebrow">Mines</span><div class="seg" id="mn-count">${[1, 3, 5, 10, 24].map(m => `<button data-v="${m}" class="${m === Gamble.mines ? 'on' : ''}">${m}</button>`).join('')}</div><b class="mono" id="mn-mult"></b></div>
            <div class="mn-grid" id="mn-grid">${Array.from({ length: 25 }, (_, i) => `<button class="mn-cell" data-cell="${i}" disabled></button>`).join('')}</div>
            <div class="actions" style="justify-content:center"><button class="btn-roll small" id="mn-go">Start</button></div>
            <p class="panel-note g-result" id="mn-result"></p>
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
    const showCoins = c => { if (c != null) { Gamble.coins = c; Store.setSetting('coins', c); } if ($('#g-coins') && Gamble.coins != null) { $('#g-coins').textContent = `🪙 ${fmt(Gamble.coins)}`; } };
    if (Store.player.name) Online.shop().then(st => { if (currentView === 'gamble' && !Gamble.busy) showCoins(st.coins); }).catch(() => {});
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
    $('#g-tabs').addEventListener('click', e => { const b = e.target.closest('[data-game-tab]'); if (b && !Gamble.busy) showTab(b.dataset.gameTab); });
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
    drawCurve(1, 'idle'); $('#cr-go').textContent = `Start · ${fmt(Gamble.chip)}`; drawMines(null);
    $('#g-chips').addEventListener('click', () => { if (!Gamble.cr) $('#cr-go').textContent = `Start · ${fmt(Gamble.chip)}`; if (!Gamble.mn || Gamble.mn.done || Gamble.mn.idle) drawMines(Gamble.mn && Gamble.mn.idle ? { ...Gamble.mn, coins: null } : null); });
    drawBets();
    drawHand(null);
    if (!Store.player.name) { $('#bj-table').innerHTML = '<div class="empty">Roll once to start earning coins.</div>'; return; }
    // Parties laissées en cours (main de blackjack, grille de mines, fusée) : reprises l'une après l'autre, chacune
    // réessayée une fois, pour qu'aucune ne manque si le réseau accroche.
    const resume = async (game, apply) => { for (let k = 0; k < 2; k++) { try { const s = await gamble(game, { move: 'state' }); if (currentView === 'gamble') apply(s); return; } catch (err) { await new Promise(r => setTimeout(r, 500)); } } };
    (async () => {
      await resume('bj', h => drawHand(h));
      await resume('mines', g => { if (!g.idle) drawMines(g); else showCoins(g.coins); });
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
          Sound.play('lock', { i: k, soft: 1 });
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
  async function openCase(box, state, btn) {
    if (state.coins < box.price) { toast(`${fmt(box.price - state.coins)} more coins needed for the ${box.name}`); return; }
    if (btn) btn.disabled = true;
    let result;
    try {
      result = await Online.shopCase(box.id);
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
    const won = Shop.byId.get(result.won), rarity = Shop.rarityOf(won.id);
    const cell = id => {
      const k = Shop.byId.get(id), r = Shop.rarityOf(id);
      return `<div class="case-cell" style="--rar:${r.color}"><div class="num-card sm${skinClass(id)}" data-tier="rare">${slotsHTML('777')}</div><span>${k.emoji} ${esc(k.name)}</span></div>`;
    };
    openModal(`
      <div class="case-open" style="--rar:${rarity.color}">
        <h2>${box.emoji} ${esc(box.name)}</h2>
        <div class="case-reel" id="case-reel"><div class="case-marker" id="case-marker"></div><div class="case-strip" id="case-strip">${strip.map(cell).join('')}</div></div>
        <div class="case-result" id="case-result" hidden>
          <div class="case-glow" aria-hidden="true"></div>
          <div class="case-rarity">${rarity.name}</div>
          <div class="num-card md${skinClass(won.id)}" data-tier="${result.duplicate ? 'common' : 'epic'}">${slotsHTML('235711')}</div>
          <p><b>${won.emoji} ${esc(won.name)}</b> — ${result.duplicate ? `you already own it: 🪙 ${fmt(result.refund)} refunded` : 'new skin unlocked!'}</p>
          <div class="room-buttons">
            ${result.duplicate ? '' : `<button class="btn-roll small" id="case-equip">Equip</button>`}
            <button class="btn" id="case-again">Open another · 🪙 ${fmt(box.price)}</button>
          </div>
        </div>
      </div>`, () => {
      const el = $('#case-strip'), reel = $('#case-reel'), marker = $('#case-marker');
      const cells = Array.from(el.children), target = cells[WIN];
      const pitch = cells[1].offsetLeft - cells[0].offsetLeft, half = reel.clientWidth / 2;
      // Arrêt quelque part dans la case gagnée, pas pile au centre : parfois tout près du voisin.
      const end = target.offsetLeft + target.offsetWidth / 2 - half + (Math.random() - 0.5) * target.offsetWidth * 0.82;
      let raf = 0, done = false, lastIndex = -1;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        el.style.transform = `translateX(${-end}px)`;
        reel.classList.add('stopped');
        target.classList.add('won');
        setTimeout(() => {
          if (!$('#case-result')) return;
          $('#case-result').hidden = false;
          const big = ['red', 'gold'].includes(rarity.id);
          Sound.play(result.duplicate ? 'reveal' : big ? 'win' : 'reveal', { small: !big });
          if (!result.duplicate || big) FX.celebrate(big ? 'mythic' : 'epic', $('#case-result .num-card'));
          drawShop(result);
        }, reducedMotion ? 0 : 650);
      };
      if (reducedMotion) finish();
      else {
        const DURATION = 6400, t0 = performance.now();
        Sound.play('riser');
        const frame = now => {
          if (!el.isConnected) return; // fenêtre fermée : le skin est déjà acquis côté serveur
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
        try { drawShop(await Online.shopAction('equip', won.id)); toast(`${won.emoji} ${won.name} equipped`); closeModal(); } catch (err) { toast('Shop unavailable right now, try again'); }
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
    // Le créateur avec des suggestions non lues va droit à sa boîte de réception.
    if (Inbox.fresh > 0) { location.hash = '#/owner'; return; }
    if (!Store.player.name) { askName(openIdeas); return; }
    openModal(`
      <h2>💡 Ideas & bugs</h2>
      <p class="panel-note" style="margin:-.3rem 0 .8rem">Your message goes straight to the creator of the game.</p>
      <div class="seg idea-kind" id="idea-kind" role="tablist"><button data-kind="idea" class="on">💡 Suggest an idea</button><button data-kind="bug">🐞 Report a bug</button></div>
      <p class="idea-warn" id="idea-warn">🍀 <span>Luck will not be changed: the odds are the same for everyone and they stay that way, so please don't ask for more luck.</span></p>
      <textarea class="input idea-text" id="idea-text" maxlength="500" rows="4" placeholder="Your idea…" aria-label="Your message"></textarea>
      <div class="idea-shot" id="idea-shot" hidden>
        <label class="btn ghost idea-shot-btn"><input type="file" accept="image/*" id="idea-file" hidden>📎 Add a screenshot (optional)</label>
        <span class="panel-note">or paste it here (Ctrl+V / ⌘V)</span>
        <div class="idea-shot-prev" id="idea-shot-prev" hidden><img alt="Your screenshot" id="idea-shot-img"><button class="btn ghost" id="idea-shot-del" title="Remove the screenshot">✕</button></div>
      </div>
      <div class="idea-foot"><span class="panel-note mono" id="idea-count">0 / 500</span><button class="btn-roll small" id="idea-send">Send</button></div>
      <div id="idea-mine"><div class="empty">Loading…</div></div>`, () => {
      const text = $('#idea-text'), send = $('#idea-send');
      const draw = state => {
        const box = $('#idea-mine');
        if (!box) return;
        const seenBefore = Store.settings.suggReplySeen || 0;
        box.innerHTML = `
          ${state.owner ? '<p style="margin:.2rem 0 .6rem"><a class="btn" href="#/owner">📥 Inbox & visitors</a></p>' : state.viewer ? '<p style="margin:.2rem 0 .6rem"><a class="btn" href="#/owner">📊 Game dashboard (view only)</a></p>' : ''}
          ${state.mine.length ? `<div class="eyebrow" style="margin:.8rem 0 .3rem">Your suggestions</div>${state.mine.map(x => `
            <div class="idea-row" data-id="${x.id}">
              <div class="idea-head">${x.kind === 'bug' ? `<span class="o-pill bug">🐞 Bug${x.shot ? ' · 📎' : ''}</span>` : ''}<span class="idea-status" data-status="${x.status}">${SUGG_STATUS[x.status] || x.status}</span><span class="panel-note">${suggDate(x.t)}</span>${x.ownerAt > seenBefore ? '<span class="idea-new">New reply</span>' : ''}</div>
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
      // Idée ou bug : un bug peut avoir une capture d'écran (choisie ou collée), réduite ici en JPEG de moins de ~150 Ko.
      let kind = 'idea', shot = null;
      $('#idea-kind').addEventListener('click', e => {
        const b = e.target.closest('[data-kind]'); if (!b) return;
        kind = b.dataset.kind;
        document.querySelectorAll('#idea-kind [data-kind]').forEach(x => x.classList.toggle('on', x === b));
        $('#idea-shot').hidden = kind !== 'bug'; $('#idea-warn').hidden = kind === 'bug';
        text.placeholder = window.RNGI18n ? window.RNGI18n.t(kind === 'bug' ? 'What went wrong? What did you do just before?' : 'Your idea…') : text.placeholder;
        text.focus();
      });
      const shrink = file => new Promise((done, fail) => {
        const url = URL.createObjectURL(file), img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          let side = 1600, q = .82, out = '';
          for (let k = 0; k < 12; k++) {
            const r = Math.min(1, side / Math.max(img.width, img.height)), c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
            const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
            out = c.toDataURL('image/jpeg', q);
            if (out.length <= 190000) return done(out);
            if (q > .5) q -= .12; else side = Math.round(side * .8);
          }
          fail(new Error('too big'));
        };
        img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('not an image')); };
        img.src = url;
      });
      const setShot = async file => {
        if (!file || !/^image\//.test(file.type)) { toast('Pick an image'); return; }
        if (file.size > 25e6) { toast('This image is too big'); return; }
        try { shot = await shrink(file); $('#idea-shot-img').src = shot; $('#idea-shot-prev').hidden = false; }
        catch (err) { shot = null; toast('This screenshot could not be read: try another image'); }
      };
      $('#idea-file').addEventListener('change', e => { setShot(e.target.files[0]); e.target.value = ''; });
      $('#idea-shot-del').addEventListener('click', () => { shot = null; $('#idea-shot-prev').hidden = true; $('#idea-shot-img').removeAttribute('src'); });
      $('#modal-root').addEventListener('paste', e => {
        if (kind !== 'bug') return;
        const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(x => x.kind === 'file' && /^image\//.test(x.type));
        if (item) { e.preventDefault(); setShot(item.getAsFile()); }
      });
      send.addEventListener('click', async () => {
        if (text.value.trim().length < 5) { toast('Write a few words first'); return; }
        send.disabled = true;
        try {
          const state = await Online.site('suggest', { text: text.value, kind, shot: kind === 'bug' && shot ? shot : undefined, lang: (window.RNGI18n && window.RNGI18n.lang) || 'en' });
          text.value = '';
          $('#idea-count').textContent = '0 / 500';
          if (shot) $('#idea-shot-del').click();
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
  const OWNER_TABS = [['overview', '📊', 'Overview'], ['retention', '🔁', 'Retention'], ['traffic', '🌍', 'Traffic'], ['casino', '🎰', 'Casino'], ['crypto', '📈', 'Crypto & social'], ['players', '👥', 'Players'], ['fund', '💶', 'Fund'], ['inbox', '💡', 'Inbox']];
  function renderOwner() {
    currentView = 'owner';
    const wanted = (location.hash.split('/')[2] || '').split('?')[0];
    const first = OWNER_TABS.some(t => t[0] === wanted) ? wanted : Inbox.fresh > 0 ? 'inbox' : 'overview';
    app.innerHTML = `
      <div class="page page-wide o-page">
        <h1 class="page-title" data-no-i18n>Owner</h1>
        <p class="o-guest" id="o-guest" hidden>👀 View only: you can see everything here, but only the creator of the game can change it.</p>
        <nav class="o-tabs" role="tablist" aria-label="Owner sections">${OWNER_TABS.map(([id, emoji, name]) => `<button role="tab" data-tab="${id}"><i>${emoji}</i><span>${name}</span><b class="o-badge" data-badge="${id}" hidden></b></button>`).join('')}</nav>
        ${OWNER_TABS.map(([id]) => `<section class="o-pane" data-pane="${id}" role="tabpanel" hidden>${id === 'fund' ? '<div id="o-fund"><div class="empty">Loading…</div></div>' : id === 'inbox' ? '<div class="panel"><div class="panel-head"><h3 class="panel-title">Suggestions</h3><span class="panel-note" id="o-count"></span></div><div id="o-inbox"><div class="empty">Loading…</div></div></div>' : '<div class="empty">Loading…</div>'}</section>`).join('')}
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
    const GAME_NAMES = { crash: '🚀 Crash', mines: '💣 Mines', plinko: '🔻 Plinko', slots: '🎰 Slots', roulette: '🎡 Roulette', bj: '🃏 Blackjack' };
    const flag = c => (/^[A-Z]{2}$/.test(c) && c !== 'ZZ' ? String.fromCodePoint(...[...c].map(ch => 127397 + ch.charCodeAt(0))) : '🌐');

    // ---- ce qui attend une action du créateur (rempli quand la cagnotte et la boîte à idées ont répondu)
    const todo = { ideas: null, tips: null };
    const drawTodo = () => {
      const box = $('#o-todo');
      if (!box) return;
      const items = [];
      if (todo.ideas) items.push(`<button class="o-chip warn" data-go-tab="inbox">💡 ${todo.ideas} suggestion${todo.ideas === 1 ? '' : 's'} to read</button>`);
      if (todo.decide) items.push(`<button class="o-chip" data-go-tab="inbox" data-go-itab="seen">🤔 ${todo.decide} suggestion${todo.decide === 1 ? '' : 's'} to decide</button>`);
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
      if (R.quiet.length) reading.push(`<b>${R.quiet.length}</b> regular player${R.quiet.length === 1 ? ' has' : 's have'} gone quiet. <button class="o-link" data-go-tab="retention">See who</button>`);

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
      pane('retention').innerHTML = `
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
      pane('casino').innerHTML = `
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
      if (pane('crypto')) {
        const levNet = (F.levIn || 0) - (F.levOut || 0), cryptoNet = (F.value || 0) - (F.invested || 0), maxDm = Math.max(1, ...(F.dms || []).map(x => x.count));
        pane('crypto').innerHTML = `
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
      pane('players').innerHTML = `
        <div class="tiles">
          ${tile('Players', fmt(pl.rolled), `${fmt(R.active.week)} active in 7 days · ${fmt(R.active.month)} in 30`)}
          ${tile('Rolls, all time', compact(pl.totalRolls), `${fmt(Math.round(pl.totalRolls / Math.max(1, pl.rolled)))} per player on average`)}
          ${tile('Rolls per player per day', R.active.dauAvg ? fmt(Math.round(R.rolls.week / Math.max(1, sum(R.series.slice(0, 7), 'active')))) : '–', 'average over the last 7 days')}
          ${tile('Coins in circulation', compact(d.economy.coins), `${compact(d.economy.earned)} earned · ${compact(d.economy.spent)} spent`)}
          ${tile('Daily streak alive', fmt(pl.streaks), `${fmt(pl.questsDone)} quests claimed in all`)}
          ${tile('Top rolls ever', `${fmt(pl.top.infinite)} · ${fmt(pl.top.divine)} · ${fmt(pl.top.celestial)}`, 'Infinite · Divine · Celestial')}
          ${tile('Duels won', fmt(pl.duelWins), 'against real players and bots')}
          ${tile('Coins spent', pct(d.economy.spent, d.economy.earned), 'of all the coins ever earned')}
        </div>
        <div class="grid-2 stats-sep">
          ${bars('How much they have rolled · players', pl.rollBuckets, n => `${n} rolls`, '', pl.rolled)}
          ${bars('Roll speed level · players', pl.speed, x => x, '', pl.named)}
          ${bars('Equipped skins', pl.skins, n => (Shop.byId.has(n) ? `${Shop.byId.get(n).emoji} ${Shop.byId.get(n).name}` : n))}
          ${bars('Equipped Generate buttons', pl.buttons, n => (Shop.buttonById.has(n) ? `${Shop.buttonById.get(n).emoji} ${Shop.buttonById.get(n).name}` : Shop.byId.has(n) ? `${Shop.byId.get(n).emoji} ${Shop.byId.get(n).name}` : n === 'match' ? 'Match my skin' : n))}
        </div>`;
    }).catch(err => { if (currentView === 'owner') for (const id of ['overview', 'retention', 'traffic', 'casino', 'crypto', 'players']) if (pane(id)) pane(id).innerHTML = denied(err); });
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
    const inboxState = { tab: Store.settings.inboxTab || '', q: '' };
    const drawInboxList = () => {
      const box = $('#o-inbox'), data = inboxData;
      if (!box || !data) return;
      if (!data.suggestions.length) { box.innerHTML = '<div class="empty">No suggestion yet.</div>'; return; }
      const count = k => (k === 'all' ? data.suggestions.length : data.suggestions.filter(x => x.status === k).length);
      // Sans choix retenu : la première pile qui demande une action.
      let tab = inboxState.tab;
      if (!INBOX_TABS.some(t => t[0] === tab)) tab = count('new') ? 'new' : count('seen') ? 'seen' : 'planned';
      const q = inboxState.q.trim().toLowerCase();
      const list = data.suggestions
        .filter(x => tab === 'all' || x.status === tab)
        .filter(x => !q || `${x.name} ${x.text} ${x.thread.map(m => m.x || m.text || '').join(' ')}`.toLowerCase().includes(q));
      const replied = x => x.thread.length && x.thread[x.thread.length - 1].f === 'p';
      const row = x => `
        <div class="idea-row${x.status === 'new' ? ' unread' : ''}" data-id="${x.id}" data-status="${x.status}">
          <div class="idea-head">
            <a class="player-link" href="${profileHref(x.name)}">${esc(x.name)}</a>
            <span class="panel-note">${suggDate(x.t)} · ${x.lang || '?'}</span>
            ${x.kind === 'bug' ? '<span class="o-pill bug">🐞 Bug</span>' : ''}
            ${x.status === 'new' && replied(x) ? '<span class="o-pill reply">💬 Player replied</span>' : ''}
            ${tab === 'all' ? `<span class="o-pill st-${x.status}">${SUGG_STATUS[x.status]}</span>` : ''}
            <button class="btn ghost o-del" data-o="delete" title="Delete">🗑</button>
          </div>
          <p class="idea-body" data-no-i18n>${esc(x.text)}</p>
          ${x.shot ? `<div class="o-shot" data-shot="${x.id}"><button class="btn ghost" data-o="shot">📎 View the screenshot</button></div>` : ''}
          ${threadHTML(x.thread, 'Player')}
          <div class="o-moves">
            ${x.status === 'new' ? '<button class="btn" data-o="read">✓ Mark as read</button>' : '<button class="btn ghost" data-o="unread">↩ Not read</button>'}
            ${Object.entries(MOVES).filter(([k]) => k !== x.status).map(([k, [e, l]]) => `<button class="btn ghost o-move" data-o="move" data-st="${k}">${e} ${l}</button>`).join('')}
          </div>
          <div class="o-reply"><input class="input" maxlength="300" placeholder="${x.thread.length ? 'Reply in this conversation…' : 'Reply to the player (they can answer back)'}"><button class="btn" data-o="reply">Send reply</button></div>
        </div>`;
      const info = INBOX_TABS.find(t => t[0] === tab);
      const focused = document.activeElement && document.activeElement.id === 'o-inbox-q';
      box.innerHTML = `
        <div class="o-inbox-tabs" role="tablist">${INBOX_TABS.map(([k, e, l]) => { const n = count(k); return `<button role="tab" data-itab="${k}" class="${k === tab ? 'on' : ''}${k === 'new' && n ? ' hot' : ''}">${e} <span>${l}</span> <b>${n}</b></button>`; }).join('')}</div>
        <div class="o-inbox-head">
          <p class="panel-note o-inbox-hint">${info[3]}</p>
          <div class="o-inbox-tools">
            <input class="input" id="o-inbox-q" type="search" placeholder="Search a name or a word…" value="${esc(inboxState.q)}" autocomplete="off">
            ${tab === 'new' && count('new') > 1 ? '<button class="btn ghost" data-o="readall">✓ Mark all as read</button>' : ''}
          </div>
        </div>
        ${list.length ? list.map(row).join('') : `<div class="empty">${q ? 'Nothing matches this search.' : tab === 'new' ? 'You have read everything. 🎉' : tab === 'seen' ? 'Everything is sorted. 🎉' : 'Nothing here yet.'}</div>`}`;
      if (focused) { const i = $('#o-inbox-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    };
    const act = (action, extra) => Online.site(action, extra).then(drawInbox).catch(err => toast(err.status === 403 ? 'Owner only' : 'Unavailable right now, try again'));
    $('#o-inbox').addEventListener('input', e => { if (e.target.id === 'o-inbox-q') { inboxState.q = e.target.value; drawInboxList(); } });
    $('#o-inbox').addEventListener('click', e => {
      const tabBtn = e.target.closest('[data-itab]');
      if (tabBtn) { inboxState.tab = tabBtn.dataset.itab; Store.setSetting('inboxTab', inboxState.tab); drawInboxList(); return; }
      const btn = e.target.closest('[data-o]'), row = e.target.closest('.idea-row');
      if (btn && btn.dataset.o === 'readall') {
        // L'une après l'autre : chaque réponse est la boîte entière, la dernière est la bonne.
        btn.disabled = true;
        const ids = [...$('#o-inbox').querySelectorAll('.idea-row.unread')].map(r => r.dataset.id);
        ids.reduce((p, id, i) => p.then(() => Online.site('mark', { id, status: 'seen' })), Promise.resolve()).then(drawInbox).catch(() => { toast('Unavailable right now, try again'); btn.disabled = false; });
        return;
      }
      if (!btn || !row) return;
      // Capture d'écran d'un bug : chargée seulement quand on la demande (elle pèse jusqu'à ~150 Ko).
      if (btn.dataset.o === 'shot') {
        btn.disabled = true;
        Online.site('shot', { id: row.dataset.id }).then(r => { const box = btn.parentElement; box.innerHTML = '<img alt="Screenshot of the bug" title="Click to enlarge">'; const img = box.querySelector('img'); img.src = r.shot; img.addEventListener('click', () => box.classList.toggle('big')); })
          .catch(err => { btn.disabled = false; toast(err.status === 404 ? err.message : 'Unavailable right now, try again'); });
        return;
      }
      if (btn.dataset.o === 'read' || btn.dataset.o === 'unread') { act('mark', { id: row.dataset.id, status: btn.dataset.o === 'read' ? 'seen' : 'new' }); return; }
      if (btn.dataset.o === 'move') { act('mark', { id: row.dataset.id, status: btn.dataset.st }).then(() => toast(`Moved to ${INBOX_TABS.find(t => t[0] === btn.dataset.st)[2]}`)); return; }
      if (btn.dataset.o === 'delete') { if (confirm(window.RNGI18n.t('Delete this suggestion?'))) act('delete', { id: row.dataset.id }); } else if (row.querySelector('.o-reply input').value.trim()) act('mark', { id: row.dataset.id, reply: row.querySelector('.o-reply input').value }).then(() => toast('Reply sent')); else toast('Write a few words first');
    });
    Online.site('inbox').then(drawInbox).catch(err => { if ($('#o-inbox')) $('#o-inbox').innerHTML = denied(err); });
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
  const Messages = {
    count: 0, timer: 0,
    set(n) { this.count = n; const link = document.querySelector('.nav a[data-route="friends"], a[data-route="friends"]'); if (link) link.classList.toggle('has-msg', n > 0); },
    watch() { if (this.timer || !Store.player.name) return; const tick = () => { if (!document.hidden && Store.player.name) Online.friends('gifts').then(r => { this.set(r.messages || 0); if (r.gifts && r.gifts.length && currentView === 'friends') checkGifts(); }).catch(() => {}); }; this.timer = setInterval(tick, 180000); setTimeout(tick, 4000); },
  };
  function openChat(name) {
    let poll = 0, sig = '';
    const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    openModal(`
      <div class="dm-head"><h2>💬 <span data-no-i18n>${esc(name)}</span></h2><button class="btn ghost" id="dm-block"></button></div>
      <p class="panel-note dm-note">Only you two can read this. Messages are filtered and deleted after 7 days. Never share personal details.</p>
      <div class="dm-list" id="dm-list" aria-live="polite"><div class="empty">Loading…</div></div>
      <form class="dm-form" id="dm-form"><input class="input" id="dm-text" maxlength="140" placeholder="Write a message…" autocomplete="off" aria-label="Message"><button class="btn-roll small">Send</button></form>`, m => {
      const list = m.querySelector('#dm-list'), input = m.querySelector('#dm-text'), form = m.querySelector('#dm-form'), block = m.querySelector('#dm-block');
      const draw = d => {
        block.textContent = d.blocked ? 'Unblock' : '🚫 Block';
        block.dataset.blocked = d.blocked ? '1' : '';
        input.disabled = d.blocked; input.placeholder = d.blocked ? 'You blocked this player' : 'Write a message…';
        const html = d.messages.length ? d.messages.map(x => `<p class="dm-msg ${x.me ? 'me' : 'them'}"><span data-no-i18n>${esc(x.text)}</span><i>${time(x.t)}</i></p>`).join('') : '<div class="empty">No message yet. Say hi!</div>';
        if (html === sig) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        sig = html; list.innerHTML = html;
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
      const r = await Online.friends('gifts');
      Messages.set(r.messages || 0);
      if (!r.gifts || !r.gifts.length) return;
      if (r.coins != null) Store.setSetting('coins', r.coins);
      const total = r.gifts.reduce((x, g) => x + g.amount, 0);
      toast(r.gifts.length === 1 ? `🎁 ${r.gifts[0].name} sent you ${fmt(total)} coins` : `🎁 ${r.gifts.length} gifts from your friends: +${fmt(total)} coins`, 6000, 'achv');
      Sound.play('lock', { i: 5 });
    } catch (err) { /* hors ligne : ils seront annoncés la prochaine fois */ }
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
            <span class="live-dot${f.room ? ' on' : ''}"></span>
            <span class="friend-info"><a class="player-link" href="${profileHref(f.name)}">${esc(f.name)}</a>${titleHTML(f.title)}
              <span class="panel-note">${compact(f.xp)} lifetime XP · ${f.room ? 'in a duel right now' : f.seen ? `last roll ${relTime(f.seen)}` : 'no roll yet'}</span></span>
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
    const sig = `${shown.length}:${shown.length ? shown[shown.length - 1].t : 0}:${muted.size}:${me ? 1 : 0}`;
    if (sig !== Room.chatSig) {
      Room.chatSig = sig;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      list.innerHTML = shown.length ? shown.map(c => `
        <div class="chat-msg${c.me ? ' mine' : ''}"><b class="chat-name" data-no-i18n>${c.bot ? '🤖 ' : ''}${esc(c.name)}</b><span class="chat-text" data-no-i18n>${esc(c.m)}</span>${c.me || c.bot ? '' : `<button class="chat-hide" data-chat-hide="${esc(c.name)}" title="Hide this player's messages">Hide</button>`}</div>`).join('')
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
      const seats = d.players.map(p => `<span class="badge-pill">${p.host ? '👑 ' : ''}${p.bot ? '🤖 ' : ''}${esc(p.name)}${titleEmoji(p.title)}${topEmoji(p.top)}${p.me ? ' (you)' : ''}</span>`).join('')
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
        if (share) share.addEventListener('click', () => shareOrCopy(`⚔️ Live duel on RNG∞ (${d.size} players, ${goalText(d)}), code ${d.code}\n${location.origin + location.pathname}?ref=duel${roomHref(d.code)}`, 'Duel invite'));
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
      <div class="room-layout"><div class="room-main">
        <p class="panel-note profile-sub">${d.players.length} players · ${goalText(d)} · each round goes to the highest roll · ${d.bots ? 'with bots: your rolls count, but not duel wins or rivalries' : 'duel rolls count on the leaderboard'}${stakeText(d)}</p>
        <div class="room-board" id="room-board"></div>
        <div class="room-arena">
          <div class="room-stage${d.players.length > 2 ? ' many' : ''}" id="room-stage"></div>
          <div class="react-layer" id="react-layer" aria-hidden="true"></div>
        </div>
        ${me ? `<div class="room-reacts" id="room-reacts">${REACTIONS.map((e, i) => `<button class="react-btn" data-react="${e}" title="${EMOTE_LABELS[e]} (press ${i + 1})">${emoteHTML(e)}</button>`).concat(myEmotes().map(e => `<button class="react-btn special" data-react="${e}" title="${esc(Shop.emoteById.get(e).name)}">${emoteHTML(e)}</button>`)).join('')}</div>` : ''}
        <div class="room-actions"><div id="room-cta"></div><p class="hint" id="room-hint"></p>${me ? `<label class="room-auto" id="room-auto-wrap" title="Rolls every round for you until this duel ends"><input type="checkbox" id="room-auto"${Room.auto ? ' checked' : ''}><i aria-hidden="true"></i><span>Auto-roll</span></label>` : ''}</div>
        <div class="panel"><div class="panel-head"><h3 class="panel-title">Rounds</h3></div><div id="room-rounds"></div></div>
      </div><aside class="room-aside">
        <div class="panel chat-panel" id="room-chat">
          <div class="panel-head"><h3 class="panel-title">Chat</h3><span class="panel-note">be kind · never share personal details</span></div>
          <div class="chat-list" id="chat-list" aria-live="polite"></div>
          <p class="panel-note chat-hidden" id="chat-hidden"></p>
          <div id="chat-foot"></div>
        </div>
        ${me && Room.isOwner && d.players.some(p => !p.me && !p.bot) ? `<div class="prank-bar"><button class="btn prank-btn" id="prank-sound" title="Play a loud sound right now on a player's screen">📢 Loud sound</button><button class="btn prank-btn" id="prank-jackpot" title="Pick a player and a number: on the next round their card lands on it, then the joke. Nothing real changes.">🎭 Fake jackpot <b id="prank-left"></b></button></div>` : ''}
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
      $('#room-chat').addEventListener('click', e => {
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
      return `<div class="board-row${p.me ? ' me' : ''}" data-pi="${i}"><span class="rank">${k + 1}</span><span class="board-who">${who}${titleHTML(p.title)}${topHTML(p.top)}${p.me ? '<span class="muted">(you)</span>' : ''}</span>${ready}<span class="board-metric">${metric}</span></div>`;
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
      hint = Room.auto ? 'Auto-roll is on: rolling for you' : `${readyCount && people.length > 1 ? `${readyCount} / ${people.length} ready${countdown} · ` : ''}press <kbd>Space</kbd>`;
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
      return `<span class="num-card sm" data-tier="${a.tier}" data-number="${r.n[j]}" data-caption="${esc(`${d.players[j].name} · round ${i + 1}`)}" style="cursor:pointer">${a.str}</span>`;
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
        ? `<div class="num-card md${skinClass(p.skin)}" data-tier="${a.tier}" data-number="${r.n[j]}" data-caption="${esc(p.name)}" style="cursor:pointer">${slotsHTML(a.str)}</div>`
        : `<div class="num-card md neutral${spinning ? ' charging' : ''}${skinClass(p.skin)}" id="rc-${j}">${'??????'.split('').map(c => `<span class="slot${spinning ? ' spinning' : ''}">${spinning ? '0' : c}</span>`).join('')}</div>`, p.skin);
      return `
        <div class="room-side${won ? ' won' : ''}${p.me ? ' me' : ''}${skinClass(p.skin).replace('skin-', 'side-')}" id="rs-${j}">${Shop.resolve(p.skin) === 'fire' ? '<span class="side-embers" aria-hidden="true"></span>' : ''}
          <div class="room-name">${won ? '🏆 ' : ''}${p.bot ? '🤖 ' : ''}${esc(p.name)}${titleEmoji(p.title)}${topEmoji(p.top)}</div>
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
    Room.anim = { cancel() { timers.forEach(clearTimeout); clearInterval(spin); Sound.stop(); clearRoomFx(); at(clock + 600, keepMine); } };
    drawRoom();
  }

  // ---------------------------------------------------------------- leaderboard / à propos
  // Classement du meilleur tirage de chaque joueur (tirages illimités : l'XP total récompenserait juste le plus gros cliqueur).
  const lbState = { period: 'day' };
  let lbTimer = 0;

  function renderLeaderboard() {
    currentView = 'leaderboard';
    const name = Store.player.name;
    const tabs = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All-time'], ['xp', 'Lifetime XP'], ['coins', 'Coins']];
    const lbRule = () => ({ xp: 'Total XP of every roll ever made', coins: 'Coins each player holds right now · refreshed every minute', month: 'Best single roll per player · when the month ends, the top 10 earn a permanent badge 👑 Top 1 · 🥈 Top 5 · 🥉 Top 10 with the month and year' }[lbState.period] || 'Best single roll per player · days reset at midnight UTC');
    app.innerHTML = `
      <div class="page">
        <h1 class="page-title">Leaderboard</h1>
        <div id="today-slot"></div>
        <div class="lb-wrap">
          ${trophiesAsideHTML()}
          <div class="lb-card">
            <div class="lb-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-period="${k}" class="${lbState.period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
            <div id="lb-list"><div class="empty">Loading…</div></div>
          </div>
        </div>
        <p class="panel-note" style="text-align:center;margin-top:.9rem">
          <span id="lb-rule">${lbRule()}</span> ·
          ${name ? `playing as <b>${esc(name)}</b> · <a href="javascript:void 0" id="lb-name">change</a>` : '<a href="javascript:void 0" id="lb-name">pick a name</a>'}
        </p>
      </div>`;
    $('#lb-name').addEventListener('click', openSettings);
    $('.lb-tabs').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      lbState.period = btn.dataset.period;
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
    const row = (top, who) => `<li>${topHTML({ top, month })}<span>${who}</span></li>`;
    return `
      <aside class="lb-aside panel" aria-label="Monthly trophies">
        <div class="eyebrow">🏆 Monthly trophies</div>
        <p class="lb-aside-lead">Finish the month in the top 10 of <b>This month</b> to earn a badge with the month and year, kept forever.</p>
        <ul class="lb-aside-list">${row(1, '1st place')}${row(5, '2nd to 5th')}${row(10, '6th to 10th')}</ul>
        <p class="lb-aside-foot"><b>${left}</b> · it shows next to your name on the leaderboard, your profile and in duels</p>
      </aside>`;
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
    const when = { day: 'today', week: 'this week', month: 'this month', all: 'yet', xp: 'yet', coins: 'yet' }[period];
    $('#lb-list').innerHTML = data.entries.length
      ? data.entries.map(lbRowHTML).join('') + (data.mine ? `<div class="lb-gap">···</div>${lbRowHTML(data.mine)}` : '')
      : `<div class="empty">No rolls ${when}, be the first!</div>`;
    // Rafraîchi seulement quand l'onglet est visible : un onglet oublié ne doit pas vider le quota gratuit de la base.
    if (!document.hidden) lbTimer = setTimeout(() => { if (currentView === 'leaderboard') drawLeaderboard(); }, 60000);
  }

  // XP à vie : des milliards possibles, affichés en abrégé (le détail au survol).
  const compactXp = v => `<span title="${fmt(v)} XP">${v >= 1e6 ? compact(v) : fmt(v)} XP</span>`;
  function lbRowHTML(e) {
    // Classement des pièces : pas de tirage à montrer, juste le solde.
    if (lbState.period === 'coins') return `
      <div class="lb-row${e.me ? ' me' : ''}">
        <span class="lb-rank">${{ 1: '🥇', 2: '🥈', 3: '🥉' }[e.rank] || '#' + e.rank}</span>
        <span class="lb-who"><a class="lb-name" href="${profileHref(e.name)}">${esc(e.name)}${e.me ? ' <span class="muted">(you)</span>' : ''}</a>${titleHTML(e.title)}${topHTML(e.top)}</span>
        <span class="lb-coins mono">🪙 ${fmt(e.coins)}</span>
        <span class="lb-rolls">${plural(e.rolls, 'roll')}</span>
      </div>`;
    const a = analysis(e.n);
    const xp = lbState.period === 'xp';
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[e.rank];
    return `
      <div class="lb-row${e.me ? ' me' : ''}" data-number="${e.n}" data-caption="${esc(`#${e.rank} · ${e.name} · ${relTime(e.t)}`)}">
        <span class="lb-rank">${medal || '#' + e.rank}</span>
        <span class="lb-who"><a class="lb-name" href="${profileHref(e.name)}" title="See ${esc(e.name)}'s profile">${esc(e.name)}${e.me ? ' <span class="muted">(you)</span>' : ''}</a>${titleHTML(e.title)}${topHTML(e.top)}</span>
        <span class="lb-rolls mono" title="Rolls by this player ${{ day: 'today', week: 'this week', month: 'this month', all: 'in total', xp: 'in total' }[lbState.period]}">${e.rolls ? plural(e.rolls, 'roll') : '–'}</span>
        <span class="num-card sm" data-tier="${a.tier}"${xp ? ' title="Best roll"' : ''}>${a.str}</span>
        <span class="lb-ep mono${xp ? ' lifetime' : ''}"${xp ? ' title="Lifetime XP"' : ''}>${xp ? compactXp(e.s) : `${fmt(e.s)} XP`}</span>
      </div>`;
  }

  function renderAbout() {
    currentView = 'about';
    const cardRows = [['trash', 'bottom 1%'], ['common', 'bottom 50%'], ['uncommon', 'top 50–25%'], ['rare', 'top 25–10%'], ['epic', 'top 10–5%'], ['anomaly', 'top 5–1%'], ['mythic', 'top 1–0.1%'], ['celestial', 'top 0.1–0.01% (900 numbers)'], ['divine', 'top 0.01–0.001% (90 numbers)'], ['infinite', 'top 0.001% (the 9 best numbers)']];
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
      </div>`;
  }

  // ---------------------------------------------------------------- navigation, thème, clavier
  const ROUTES = { '': renderHome, gamble: renderGamble, history: renderHistory, stats: renderStats, badges: renderBadges, leaderboard: renderLeaderboard, about: renderAbout, duel: renderDuelHub, shop: renderShop, friends: renderFriends, owner: renderOwner };

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
    if (e.target.closest('[data-idea]')) { e.preventDefault(); openIdeas(); return; }
    if (e.target.closest('[data-fund]')) { e.preventDefault(); openFund(); return; }
    // Aperçu d'un skin demandé hors de la grille du Shop (fenêtre de la cagnotte) ; la grille a son propre écouteur.
    { const pv = e.target.closest('[data-skin-preview]'); if (pv && !pv.closest('.skin-grid')) { e.preventDefault(); previewSkin(pv.dataset.skinPreview); return; } }
    if (e.target.closest('[data-news]')) { e.preventDefault(); openNews(); return; }
    if (e.target.closest('[data-intro]')) { e.preventDefault(); openIntro(); return; }
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

  // Première visite (aucun tirage, pas de pseudo, pas un lien de duel) : les 3 écrans d'accueil.
  const brandNew = !Store.rolls.length && !Store.player.name;
  paintNewsDot();
  QuestWatch.sync(true); // état des quêtes du jour, pour annoncer celles qui se terminent ensuite
  // Skin et bouton de tirage choisis sur un autre appareil : on les reprend au chargement (joueurs connus seulement).
  if (Store.player.name) Online.shop().then(applyShop).catch(() => { /* hors ligne : on garde ce que l'appareil connaît */ });
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
