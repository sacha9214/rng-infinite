/* RNG∞ — persistance locale (localStorage).
 * Un tirage est stocké en tableau compact [nombre, XP, timestamp] ; les badges se recalculent à la demande.
 * Le champ player.id sert d'identifiant stable pour le futur leaderboard en ligne.
 */
(function (root) {
  'use strict';

  const KEY = 'rnginf.v1';
  const MAX_ROLL = 1000000;

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
        rolls: Array.isArray(data.rolls) ? data.rolls.filter(isValidRoll) : [],
      };
    } catch (e) {
      return defaults();
    }
  }

  function isValidRoll(r) {
    return Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= 0 && r[0] <= MAX_ROLL &&
      Number.isFinite(r[1]) && Number.isFinite(r[2]);
  }

  const listeners = new Set();

  const Store = {
    state: read(),

    save() {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.state));
        return true;
      } catch (e) {
        return false;
      }
    },

    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { listeners.forEach(fn => fn(this.state)); },

    get rolls() { return this.state.rolls; },
    get player() { return this.state.player; },
    get settings() { return this.state.settings; },

    // t = heure du serveur pour un tirage en ligne : c'est la même clé que dans l'historique du compte.
    addRoll(n, ep, t = Date.now()) {
      const roll = [n, ep, t];
      this.state.rolls.push(roll);
      const ok = this.save();
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
      Object.assign(this.state.player, { id, secret, google });
      this.save();
      this.emit();
    },

    // Déconnexion : l'appareil repart avec un nouveau joueur anonyme ; le compte Google garde le sien.
    signOut() {
      this.state.player = { id: uid(), secret: uid() + uid(), name: '' };
      this.save();
      this.emit();
    },

    // Ajoute les tirages du compte ([nombre, timestamp]) que cet appareil n'a pas encore ; renvoie le nombre ajouté.
    mergeRolls(entries, scoreOf) {
      const known = rollSet(this.state.rolls.map(r => [r[0], r[2]]));
      let added = 0;
      for (const [n, t] of entries) {
        if (!known.add(n, t)) continue;
        this.state.rolls.push([n, scoreOf(n), t]);
        added++;
      }
      if (added) {
        this.state.rolls.sort((a, b) => a[2] - b[2]);
        this.save();
        this.emit();
      }
      return added;
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
        if (!Array.isArray(r) || !Number.isInteger(r[0]) || r[0] < 0 || r[0] > MAX_ROLL || !Number.isFinite(r[2])) continue;
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

  root.Store = Store;
})(window);
