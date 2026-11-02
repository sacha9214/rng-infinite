/* RNG∞ — persistance locale (localStorage).
 * Un tirage est stocké en tableau compact [nombre, XP, timestamp] ; les badges se recalculent à la demande.
 * Le champ player.id sert d'identifiant stable pour le futur leaderboard en ligne.
 */
(function (root) {
  'use strict';

  const KEY = 'rnginf.v1';
  const MAX_ROLL = 1000000;
  // Mode difficile (Sacha, 2026-11-02) : ses tirages (0 à 9 999 999 999) ont leur propre historique, rangé à part sous
  // KEY_HARD avec le même format compact. Store.rolls est toujours l'historique du mode choisi (settings.mode) : les pages
  // (History, Stats, Badges…) montrent ainsi le mode en cours sans rien changer.
  const KEY_HARD = 'rnginf.hard';
  const HARD_MAX = 9999999999;
  const maxOf = mode => (mode === 'hard' ? HARD_MAX : MAX_ROLL);

  // Un même tirage peut porter l'heure du serveur ou, enregistré par une ancienne version du site, celle de l'appareil
  // (quelques dixièmes de seconde d'écart) : même nombre à moins d'une minute = même tirage.
  const SAME_ROLL_MS = 60000;
  function rollSet(pairs = []) {
    const byN = new Map();
    const has = (n, t) => (byN.get(n) || []).some(x => Math.abs(x - t) <= SAME_ROLL_MS);
    const set = {
      has,
      add(n, t) {
        if (has(n, t)) return false;
        if (!byN.has(n)) byN.set(n, []);
        byN.get(n).push(t);
        return true;
      },
    };
    for (const [n, t] of pairs) set.add(n, t);
    return set;
  }

  // Historique compact (2026-10-30, signalé par jonahfr : « storage is full » vers 170 000 tirages, le navigateur garde
  // ~5 millions de caractères). Au lieu de [123456,4321,1793238134225] (~29 caractères), chaque tirage s'écrit en base 36
  // « nombre.XP.écart » avec l'écart en ms depuis le tirage précédent, « ! » à la fin s'il est hors ligne : ~13 caractères.
  // Rangé dans « rz » ; « rolls » reste lu pour les anciennes sauvegardes (et par un vieil onglet encore ouvert).
  const pack1 = (r, prev) => r[0].toString(36) + '.' + Math.round(r[1]).toString(36) + '.' + (r[2] - prev).toString(36) + (r[3] ? '!' : '');
  function packRolls(rolls) {
    const out = new Array(rolls.length);
    let prev = 0;
    for (let i = 0; i < rolls.length; i++) { out[i] = pack1(rolls[i], prev); prev = rolls[i][2]; }
    return out.join(',');
  }
  function unpackRolls(s) {
    const rolls = [];
    if (!s) return rolls;
    let prev = 0;
    for (const part of s.split(',')) {
      const off = part.endsWith('!');
      const [a, b, c] = (off ? part.slice(0, -1) : part).split('.');
      const t = prev + parseInt(c, 36);
      prev = t;
      const r = [parseInt(a, 36), parseInt(b, 36), t];
      if (off) r.push(1);
      rolls.push(r);
    }
    return rolls;
  }

  function uid() {
    const bytes = new Uint8Array(8);
    try { crypto.getRandomValues(bytes); } catch (e) { for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256); }
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function defaults() {
    return {
      version: 1,
      // secret : prouve au serveur que c'est bien ce navigateur qui tire sous cet identifiant.
      player: { id: uid(), secret: uid() + uid(), name: '' },
      // sound : 'on' ou 'off'. Les anciennes sauvegardes contiennent false (réglage jamais proposé) : il vaut 'on'.
      settings: { speed: 'normal', theme: 'system', sound: 'on' },
      scoreVersion: null,
      rolls: [],
    };
  }

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const data = JSON.parse(raw);
      const base = defaults();
      return {
        version: 1,
        player: Object.assign(base.player, data.player),
        settings: Object.assign(base.settings, data.settings),
        scoreVersion: data.scoreVersion || null,
        rolls: (typeof data.rz === 'string' ? unpackRolls(data.rz) : Array.isArray(data.rolls) ? data.rolls : []).filter(r => isValidRoll(r)),
      };
    } catch (e) {
      return defaults();
    }
  }
  function readHard() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY_HARD) || 'null') || {};
      return { scoreVersion: data.scoreVersion || null, rolls: (typeof data.rz === 'string' ? unpackRolls(data.rz) : []).filter(r => isValidRoll(r, HARD_MAX)), packed: null };
    } catch (e) {
      return { scoreVersion: null, rolls: [], packed: null };
    }
  }

  function isValidRoll(r, max = MAX_ROLL) {
    return Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= 0 && r[0] <= max &&
      Number.isFinite(r[1]) && Number.isFinite(r[2]);
  }
  // Chaîne compacte d'un historique, recalculée seulement s'il a changé depuis la dernière fois.
  const rzOf = c => (c.packed && c.packed.rolls === c.rolls && c.packed.len === c.rolls.length ? c.packed.s : (c.packed = { s: packRolls(c.rolls), len: c.rolls.length, rolls: c.rolls }).s);

  const listeners = new Set();

  const Store = {
    state: read(),

    // Chaîne compacte déjà calculée : un tirage ajouté par addRoll ne fait qu'allonger la fin (200 000 tirages à
    // réécrire à chaque tirage du tirage auto, sinon). Toute autre modification de l'historique la recalcule entière.
    packed: null,
    // Historique de l'autre mode, gardé en mémoire (modes : 'normal' | 'hard').
    other: null, hardDirty: false,

    get mode() { return this.state.mode || 'normal'; },
    maxRoll() { return maxOf(this.mode); },

    save(appended = false) {
      const rolls = this.state.rolls;
      const pk = this.packed;
      let rz;
      if (appended && pk && pk.rolls === rolls && pk.len === rolls.length - 1) {
        const last = rolls[rolls.length - 1];
        rz = pk.s + (pk.len ? ',' : '') + pack1(last, pk.len ? rolls[pk.len - 1][2] : 0);
      } else {
        rz = packRolls(rolls);
      }
      this.packed = { s: rz, len: rolls.length, rolls };
      const hard = this.mode === 'hard', o = this.other;
      // Le mode normal reste dans KEY (anciennes versions du site comprises) ; le mode difficile va dans KEY_HARD.
      const normal = hard ? { rz: o ? rzOf(o) : '', scoreVersion: o ? o.scoreVersion : null } : { rz, scoreVersion: this.state.scoreVersion };
      try {
        localStorage.setItem(KEY, JSON.stringify({ version: this.state.version, player: this.state.player, settings: this.state.settings, scoreVersion: normal.scoreVersion, rz: normal.rz }));
        if (hard) localStorage.setItem(KEY_HARD, JSON.stringify({ scoreVersion: this.state.scoreVersion, rz }));
        else if (this.hardDirty) localStorage.setItem(KEY_HARD, JSON.stringify({ scoreVersion: o ? o.scoreVersion : null, rz: o ? rzOf(o) : '' }));
        this.hardDirty = false;
        return true;
      } catch (e) {
        return false;
      }
    },

    // Passe au mode normal ou difficile : Store.rolls devient l'historique de ce mode. Renvoie true s'il a changé.
    useMode(mode) {
      mode = mode === 'hard' ? 'hard' : 'normal';
      if (mode === this.mode && this.state.settings.mode === mode) return false;
      const cur = { rolls: this.state.rolls, scoreVersion: this.state.scoreVersion, packed: this.packed };
      const next = this.other || (mode === 'hard' ? readHard() : { rolls: [], scoreVersion: null, packed: null });
      this.other = cur;
      this.state.rolls = next.rolls; this.state.scoreVersion = next.scoreVersion; this.packed = next.packed;
      this.state.mode = mode; this.state.settings.mode = mode;
      this.save();
      this.emit();
      return true;
    },
    // Vide les deux historiques (autre joueur sur l'appareil, déconnexion).
    clearBoth() {
      this.state.rolls = []; this.packed = null;
      this.other = { rolls: [], scoreVersion: null, packed: null }; this.hardDirty = true;
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { listeners.forEach(fn => fn(this.state)); },

    get rolls() { return this.state.rolls; },
    get player() { return this.state.player; },
    get settings() { return this.state.settings; },

    // t = heure du serveur pour un tirage en ligne : c'est la même clé que dans l'historique du compte.
    // offline : tiré sur l'appareil faute de réponse du serveur. Il reste dans l'historique mais ne compte ni au
    // classement ni dans l'XP affiché (4e case à 1 ; un tirage compté n'en a que trois).
    addRoll(n, ep, t = Date.now(), offline = false) {
      const roll = offline ? [n, ep, t, 1] : [n, ep, t];
      this.state.rolls.push(roll);
      const ok = this.save(true);
      this.emit();
      return { roll, saved: ok };
    },

    setPlayerName(name) {
      this.state.player.name = String(name || '').trim().slice(0, 20);
      this.save();
      this.emit();
    },

    setSetting(key, value) {
      this.state.settings[key] = value;
      this.save();
      this.emit();
    },

    // Nouvel identifiant si l'ancien est réservé sur le serveur par un autre secret (ex. données effacées).
    resetIdentity() {
      this.state.player.id = uid();
      this.state.player.secret = uid() + uid();
      this.save();
    },

    // Adopte le joueur renvoyé par la connexion Google (le même sur tous les appareils).
    setIdentity({ id, secret, google }) {
      // Autre joueur sur cet appareil (signalé par costoroll, 2026-10-30) : un ami se connecte sur mon ordinateur (Google
      // ou mot de passe), puis je me reconnecte ; ses tirages restaient mêlés aux miens (total, meilleurs tirages,
      // Divines), car seul l'identifiant changeait. L'historique de l'appareil est celui du joueur actif : on le vide, et
      // syncHistory recharge celui du compte depuis le serveur. Même joueur (premier lien Google) : rien n'est retiré.
      if (id !== this.state.player.id) { this.clearBoth(); delete this.state.settings.coins; }
      Object.assign(this.state.player, { id, secret, google });
      this.save();
      this.emit();
    },

    // Déconnexion : l'appareil repart avec un nouveau joueur anonyme ; le compte Google garde le sien.
    signOut() {
      this.state.player = { id: uid(), secret: uid() + uid(), name: '' };
      // Les tirages et le solde du compte restent sur le serveur, pas sur l'appareil (costoroll, 2026-10-30).
      this.clearBoth(); delete this.state.settings.coins;
      this.save();
      this.emit();
    },

    // Ajoute les tirages du compte ([nombre, timestamp]) que cet appareil n'a pas encore ; renvoie le nombre ajouté.
    mergeRolls(entries, scoreOf) {
      const known = rollSet(this.state.rolls.map(r => [r[0], r[2]]));
      let added = 0;
      for (const [n, t, s] of entries) { // s : XP envoyée par le serveur (mode difficile), sinon recalculée
        if (!known.add(n, t)) continue;
        this.state.rolls.push([n, Number.isFinite(s) ? s : scoreOf(n), t]);
        added++;
      }
      if (added) {
        this.state.rolls.sort((a, b) => a[2] - b[2]);
        this.save();
        this.emit();
      }
      return added;
    },

    // Après lecture de l'historique du compte : un tirage absent du serveur est « hors ligne » (non compté), un tirage
    // présent ne l'est pas. Les tout récents sont laissés tels quels : le serveur n'enregistre un tirage de duel qu'à
    // la fin de sa révélation. Renvoie le nombre de tirages dont la marque a changé.
    // after : seuls les tirages plus récents sont jugés (lecture partielle de l'historique, 2026-11-01).
    markOffline(onServer, graceMs = 120000, now = Date.now(), after = -Infinity) {
      let changed = 0;
      for (const r of this.state.rolls) {
        if (r[2] <= after) continue;
        const counted = onServer.has(r[0], r[2]);
        if (counted && r[3]) { r.length = 3; changed++; }
        else if (!counted && !r[3] && now - r[2] > graceMs) { r[3] = 1; changed++; }
      }
      if (changed) { this.save(); this.emit(); }
      return changed;
    },

    // Retire les doublons d'un même tirage (voir rollSet) : la synchronisation du 21/09/2026 en a copié quelques-uns.
    dedupeRolls() {
      const known = rollSet();
      const kept = this.state.rolls.filter(r => known.add(r[0], r[2]));
      const removed = this.state.rolls.length - kept.length;
      if (removed) {
        this.state.rolls = kept;
        this.save();
        this.emit();
      }
      return removed;
    },

    rollSet,

    // Recalcule l'XP stocké de chaque tirage quand la version des scores change.
    rescore(scoreOf, version) {
      if (this.state.scoreVersion === version) return 0;
      let changed = 0;
      for (const r of this.state.rolls) {
        const s = scoreOf(r[0]);
        if (s !== r[1]) { r[1] = s; changed++; }
      }
      this.state.scoreVersion = version;
      this.save();
      return changed;
    },

    clearRolls() {
      this.state.rolls = [];
      this.save();
      this.emit();
    },

    exportJSON() {
      return JSON.stringify({
        app: 'rng-infinite',
        exportedAt: new Date().toISOString(),
        player: this.state.player,
        rolls: this.state.rolls,
      });
    },

    // Fusionne un export : les XP sont recalculés par l'appelant (rescore) pour ne jamais faire confiance au fichier.
    importJSON(text, rescore) {
      const data = JSON.parse(text);
      const incoming = Array.isArray(data.rolls) ? data.rolls : [];
      const seen = new Set(this.state.rolls.map(r => r[2] + ':' + r[0]));
      let added = 0;
      for (const r of incoming) {
        if (!Array.isArray(r) || !Number.isInteger(r[0]) || r[0] < 0 || r[0] > this.maxRoll() || !Number.isFinite(r[2])) continue;
        const key = r[2] + ':' + r[0];
        if (seen.has(key)) continue;
        seen.add(key);
        this.state.rolls.push([r[0], rescore(r[0]), r[2]]);
        added++;
      }
      this.state.rolls.sort((a, b) => a[2] - b[2]);
      this.save();
      this.emit();
      return added;
    },
  };

  // Toujours ouvert en mode normal ; le site repasse en mode difficile (useMode) une fois ses données chargées.
  Store.state.mode = 'normal';

  root.Store = Store;
})(window);
