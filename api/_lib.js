// Outils partagés par les fonctions /api (le préfixe _ empêche Vercel d'en faire un endpoint).
const crypto = require('node:crypto');
const { createEngine } = require('../js/engine.js');
const Achievements = require('../js/achievements.js');
const meta = require('../data/badge-meta.json');
const percentiles = require('../data/percentiles.json');

// Même moteur et mêmes données que le site : l'EP calculé ici est identique à celui affiché.
const engine = createEngine(meta, percentiles);

// Variables posées par l'intégration Upstash Redis de Vercel (noms KV_* ou UPSTASH_*).
// Base de données : notre Redis sur le VPS (RNG_REDIS_*, voir deploy/ovh) en priorité, sinon Upstash (variables de
// l'intégration Vercel, gardées pour revenir en arrière en supprimant simplement les deux RNG_REDIS_*).
const REDIS_URL = process.env.RNG_REDIS_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.RNG_REDIS_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Exécute une liste de commandes Redis en un seul aller-retour (API REST d'Upstash).
async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw Object.assign(new Error('Leaderboard database is not configured'), { status: 503 });
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map(c => c.map(String))),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  return (await res.json()).map(r => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

// Le jour change à minuit UTC, comme sur le site d'origine.
const dayKey = t => new Date(t).toISOString().slice(0, 10);

// Semaine ISO (lundi → dimanche), en UTC.
function weekKey(t) {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Pour chaque période : un sorted set (score = EP du meilleur tirage du joueur), un hash avec le détail de ce tirage,
// un hash du nombre de tirages par joueur et un compteur du total de tirages.
function scopes(t) {
  const day = dayKey(t), week = weekKey(t);
  return [
    { period: 'day', lb: `lb:day:${day}`, best: `best:day:${day}`, count: `count:day:${day}`, total: `rolls:day:${day}`, ttl: 8 * 86400 },
    { period: 'week', lb: `lb:week:${week}`, best: `best:week:${week}`, count: `count:week:${week}`, total: `rolls:week:${week}`, ttl: 40 * 86400 },
    { period: 'all', lb: 'lb:all', best: 'best:all', count: 'count:all', total: 'rolls:all', ttl: 0 },
  ];
}

// ---------------------------------------------------------------- connexion Google
// Vérifie un jeton d'identité Google (JWT RS256) avec les clés publiques de Google, sans dépendance.
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let googleKeys = { keys: [], fetchedAt: 0 };

async function googleKey(kid) {
  const fresh = Date.now() - googleKeys.fetchedAt < 3600 * 1000;
  let key = googleKeys.keys.find(k => k.kid === kid);
  if (!key || !fresh) {
    const res = await fetch(GOOGLE_CERTS_URL);
    if (!res.ok) throw new Error(`Google certs HTTP ${res.status}`);
    googleKeys = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
    key = googleKeys.keys.find(k => k.kid === kid);
  }
  return key;
}

async function verifyGoogleToken(token, clientId) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [head, body, sig] = parts;
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('Unexpected algorithm');
  const jwk = await googleKey(header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url'))) throw new Error('Bad signature');
  if (claims.aud !== clientId) throw new Error('Token is for another app');
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error('Unexpected issuer');
  if (!(claims.exp * 1000 > Date.now())) throw new Error('Expired token');
  if (!claims.sub) throw new Error('No subject');
  return claims;
}

// Compte du créateur du site : empreinte SHA-256 de son e-mail Google (l'adresse n'apparaît ni dans le code ni en base).
const OWNER_EMAIL_SHA256 = process.env.OWNER_EMAIL_SHA256 || '15fcdda9573617a0e5814e3fc4e37be0d01ebd0cc7a568b0dcb7a3a1fb26b9c7';

// Noms : lettres de l'alphabet latin (accents compris), chiffres, espaces et _ . - ' seulement ; pas de sosies en
// cyrillique ("Ѕасhа") ni de caractères invisibles. Les caractères de contrôle ne passent donc plus non plus.
const cleanName = raw => String(raw || '').normalize('NFC').replace(/[^\p{Script=Latin}0-9 _.\-']/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// CORS ouvert : le site est aussi servi depuis GitHub Pages. Renvoie true si la requête était un préflight.
// Limite par adresse IP, gardée en mémoire par l'instance (sans toucher à la base) : un script qui bombarde l'API est
// coupé avant d'épuiser le quota gratuit. 300 requêtes par minute et par IP, soit ~7 onglets de duel à la fois.
const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60000;
const hits = new Map();
function limited(req) {
  const fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  const ip = fwd ? String(fwd).split(',')[0].trim() : '';
  if (!ip) return false;
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.start > RATE_WINDOW_MS) {
    h = { start: now, count: 0 };
    hits.set(ip, h);
  }
  h.count++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k);
  return h.count > RATE_LIMIT;
}

// CORS ouvert : le site est aussi servi depuis GitHub Pages. Renvoie true si la requête est déjà traitée
// (préflight, ou IP qui dépasse la limite).
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (limited(req)) {
    send(res, 429, { error: 'Too many requests, slow down' });
    return true;
  }
  return false;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Le premier appel réserve l'identifiant ; ensuite seul le détenteur d'un de ses secrets peut agir sous cet id
// (secret d'origine, ou secret d'un appareil connecté avec Google).
async function claimPlayer(playerId, secret) {
  const hash = sha256(secret);
  const [created, owner, member] = await redis([
    ['SET', `player:${playerId}:secret`, hash, 'NX'],
    ['GET', `player:${playerId}:secret`],
    ['SISMEMBER', `player:${playerId}:secrets`, hash],
  ]);
  if (created === 'OK') await markFresh(playerId);
  return owner === hash || Number(member) === 1;
}

// Joueur neuf, sans historique : ses stats partent de zéro, déjà "vérifiées". Seuls les anciens joueurs (d'avant les
// succès) voient leurs stats reconstruites une fois depuis leur historique ; sinon un compte neuf pourrait envoyer
// un faux historique (/api/history) puis se faire créditer pièces et succès.
async function markFresh(playerId) {
  const [size] = await redis([['ZCARD', historyKey(playerId)]]);
  if (!Number(size)) await redis([['HSETNX', statsKey(playerId), 'v', STATS_VERSION], ['HSETNX', statsKey(playerId), 'tv', TIERS_VERSION]]);
}

// Clé d'unicité d'un nom : sans accents, majuscules, espaces ni ponctuation ("Sacha", "sâcha" et "Sa-cha!" = le même nom).
function nameKey(name) {
  const key = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key || String(name).toLowerCase().replace(/\s+/g, '');
}

// Réserve un nom pour ce joueur et libère son ancien nom. Faux si un autre joueur l'a déjà.
async function claimName(playerId, name) {
  const key = `name:${nameKey(name)}`;
  const [, owner, previous] = await redis([['SET', key, playerId, 'NX'], ['GET', key], ['HGET', 'names', playerId]]);
  if (owner !== playerId) return false;
  if (previous === name) return true;
  const writes = [['HSET', 'names', playerId, name]];
  if (previous && nameKey(previous) !== nameKey(name)) {
    const oldKey = `name:${nameKey(previous)}`;
    const [oldOwner] = await redis([['GET', oldKey]]);
    if (oldOwner === playerId) writes.push(['DEL', oldKey]);
  }
  await redis(writes);
  return true;
}

// Vrai si ce secret appartient au joueur : secret d'origine, ou secret d'un appareil connecté avec Google.
async function ownsPlayer(playerId, secret) {
  const hash = sha256(secret);
  const [owner, member] = await redis([
    ['GET', `player:${playerId}:secret`],
    ['SISMEMBER', `player:${playerId}:secrets`, hash],
  ]);
  return owner === hash || Number(member) === 1;
}

// Historique d'un joueur : sorted set (score = timestamp, membre = "timestamp:nombre", donc sans doublon).
const historyKey = playerId => `hist:${playerId}`;
const HISTORY_CAP = 100000;
const XP_LB = 'lb:xp';

// XP à vie et nombre de tirages recalculés depuis l'historique (mêmes doublons écartés que rebuildStats),
// pour remplir lb:xp et count:all une fois (tirages faits avant le classement en ligne compris).
function lifetimeTotals(members) {
  const seen = rollSet();
  let xp = 0, rolls = 0;
  for (const m of members || []) {
    const [t, n] = m.split(':').map(Number);
    if (seen.add(n, t)) { xp += engine.scoreOf(n); rolls++; }
  }
  return { xp, rolls };
}
const lifetimeXp = members => lifetimeTotals(members).xp;

// Un même tirage peut porter l'heure du serveur ou, envoyé par une ancienne version du site, celle de l'appareil
// (quelques dixièmes de seconde d'écart) : même nombre à moins d'une minute = même tirage. Même règle que js/store.js.
const SAME_ROLL_MS = 60000;
function rollSet() {
  const byN = new Map();
  const has = (n, t) => (byN.get(n) || []).some(x => Math.abs(x - t) <= SAME_ROLL_MS);
  return {
    has,
    add(n, t) {
      if (has(n, t)) return false;
      if (!byN.has(n)) byN.set(n, []);
      byN.get(n).push(t);
      return true;
    },
  };
}

// Nom → id. Les joueurs qui n'ont pas tiré depuis l'arrivée des noms uniques n'ont que le hash "names".
async function findPlayer(name) {
  const key = nameKey(name);
  const [id] = await redis([['GET', `name:${key}`]]);
  if (id) return id;
  const [flat] = await redis([['HGETALL', 'names']]);
  for (let i = 0; i < (flat || []).length; i += 2) if (nameKey(flat[i + 1]) === key) return flat[i];
  return null;
}

// ---------------------------------------------------------------- stats des succès
// Tenues par le serveur, donc infalsifiables : stats:<id> (compteurs) et badges:<id> (badges différents obtenus).
// Pour un ancien joueur, elles sont reconstruites une fois depuis son historique ("v" marque une reconstruction faite).
const TIERS = ['trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'infinite'];
const STATS_VERSION = '1';
// Raretés au-dessus de Mythic (2026-10-09) : "tv" marque les compteurs déjà répartis entre Mythic et les trois nouvelles.
const TIERS_VERSION = '2';
const TOP_TIERS = ['celestial', 'divine', 'infinite'];
const statsKey = id => `stats:${id}`;
const badgesKey = id => `badges:${id}`;
const toObject = flat => {
  const o = {};
  for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};

// Recalcule les compteurs de tirages depuis l'historique ; garde ceux des duels et du "meilleur du jour".
async function rebuildStats(playerId) {
  const [members] = await redis([['ZRANGE', historyKey(playerId), 0, -1]]);
  const seen = rollSet();
  const tiers = Object.fromEntries(TIERS.map(t => [t, 0]));
  const badges = new Set();
  let rolls = 0, best = 0, drastix = 0;
  for (const m of members || []) {
    const [t, n] = m.split(':').map(Number);
    if (!seen.add(n, t)) continue;
    const a = engine.analyze(n);
    rolls++;
    tiers[a.tier]++;
    best = Math.max(best, a.total);
    a.earnedIds.forEach(id => badges.add(id));
    if (a.earnedIds.includes('DRASTIX')) drastix = 1;
  }
  const writes = [
    ['HSET', statsKey(playerId), 'rolls', rolls, 'best', best, 'drastix', drastix, 'v', STATS_VERSION, 'tv', TIERS_VERSION, ...TIERS.flatMap(t => [`t:${t}`, tiers[t]])],
    ['DEL', badgesKey(playerId)],
  ];
  if (badges.size) writes.push(['SADD', badgesKey(playerId), ...badges]);
  writes.push(['HGETALL', statsKey(playerId)]);
  const out = await redis(writes);
  return { ...toObject(out[out.length - 1]), badges: badges.size };
}

// Anciens Mythic : une fois par joueur, ceux qui tombent dans une des nouvelles raretés y sont reclassés, depuis son
// historique. Les compteurs ne font que monter de rareté (les pièces aussi) ; rien d'autre n'est touché. Un joueur
// sans aucun Mythic est seulement marqué. Le marqueur posé en premier sert de verrou : une seule répartition.
async function splitTopTiers(playerId, stats) {
  if (stats.tv === TIERS_VERSION) return stats;
  const [first] = await redis([['HSETNX', statsKey(playerId), 'tv', TIERS_VERSION]]);
  stats.tv = TIERS_VERSION;
  const mythic = Number(stats['t:mythic']) || 0;
  if (Number(first) !== 1 || !mythic) return stats;
  const [members] = await redis([['ZRANGE', historyKey(playerId), 0, -1]]);
  const seen = rollSet(), found = Object.fromEntries(TOP_TIERS.map(t => [t, 0]));
  for (const m of members || []) {
    const [t, n] = m.split(':').map(Number);
    if (!seen.add(n, t)) continue;
    const tier = engine.cardTier(engine.scoreOf(n));
    if (tier in found) found[tier]++;
  }
  // Déjà comptés dans les nouvelles raretés (tirages faits depuis la mise à jour) : ils sont aussi dans l'historique.
  const already = TOP_TIERS.reduce((x, k) => x + (Number(stats[`t:${k}`]) || 0), 0);
  const total = TOP_TIERS.reduce((x, k) => x + found[k], 0);
  const moved = Math.max(0, Math.min(mythic, total - already));
  if (!moved) return stats;
  // Du plus rare au moins rare : si l'historique en montre plus que l'ancien compteur n'en avait, le surplus est ignoré.
  let left = moved + already;
  const writes = [['HINCRBY', statsKey(playerId), 't:mythic', -moved]];
  for (const k of TOP_TIERS.slice().reverse()) {
    const v = Math.max(Number(stats[`t:${k}`]) || 0, Math.min(found[k], left));
    left -= Math.min(found[k], left);
    writes.push(['HSET', statsKey(playerId), `t:${k}`, v]);
    stats[`t:${k}`] = String(v);
  }
  stats['t:mythic'] = String(mythic - moved);
  await redis(writes);
  return stats;
}

// Bonus du compte Google : une fois par joueur (le marqueur posé en premier sert de verrou), donc une fois par compte
// Google, puisqu'un compte ne tient qu'un joueur. Rend le montant versé, ou 0 s'il l'avait déjà eu.
async function grantGoogleBonus(playerId) {
  const [first] = await redis([['HSETNX', statsKey(playerId), 'googleBonus', 1]]);
  if (Number(first) !== 1) return 0;
  const amount = require('../js/shop.js').GOOGLE_BONUS;
  await redis([['HINCRBY', statsKey(playerId), 'bonus', amount]]);
  return amount;
}

async function readStats(playerId) {
  const [flat, count] = await redis([['HGETALL', statsKey(playerId)], ['SCARD', badgesKey(playerId)]]);
  const stats = toObject(flat);
  if (!stats.v) return rebuildStats(playerId);
  return { ...(await splitTopTiers(playerId, stats)), badges: Number(count) };
}

// ---------------------------------------------------------------- quêtes, pièces offertes, mises de duel
// Compteurs du jour d'un joueur (voir js/quests.js), gardés 3 jours.
const questKey = (day, playerId) => `q:${day}:${playerId}`;
const QUEST_TTL = 3 * 86400;
const SEEN_KEY = 'seen'; // dernière activité de chaque joueur (score = heure)

// Mise d'un duel : chaque joueur l'a payée en entrant (stats.spent += mise, champ "paid:<id>" de la salle).
// Règlement une seule fois par salle (HSETNX "settled") : le pot au gagnant, ou chacun remboursé (égalité, partie
// désertée, salle oubliée). Appelé à la fin du duel, à l'abandon, et par une échéance de secours dans `pending`.
async function settleWager(code, winnerId) {
  const key = `room:${code}`;
  const [flat] = await redis([['HGETALL', key]]);
  const h = toObject(flat);
  const paid = Object.entries(h).filter(([k]) => k.startsWith('paid:')).map(([k, v]) => [k.slice(5), Number(v) || 0]).filter(([, v]) => v > 0);
  if (!paid.length) return null;
  const [first] = await redis([['HSETNX', key, 'settled', winnerId || 'refund']]);
  if (Number(first) !== 1) return null;
  const pot = paid.reduce((x, [, v]) => x + v, 0);
  if (winnerId && paid.some(([id]) => id === winnerId)) {
    await redis([['HINCRBY', statsKey(winnerId), 'bonus', pot], ['HINCRBY', statsKey(winnerId), 'wagerWon', pot - (paid.find(([id]) => id === winnerId)[1])]]);
    return { winner: winnerId, pot };
  }
  await redis(paid.map(([id, v]) => ['HINCRBY', statsKey(id), 'spent', -v]));
  return { refunded: paid.length, pot };
}

// ---------------------------------------------------------------- enregistrement d'un tirage
// Historique, compteurs, meilleurs tirages (jour, semaine, all-time) et stats des succès d'un joueur.
// Appelé par /api/roll et par les duels. Lit puis écrit le meilleur score : le délai de 8 s entre deux tirages
// (et entre deux manches) évite que deux tirages du même joueur se croisent.
async function recordRoll(playerId, n, t) {
  const a = engine.analyze(n);
  const s = a.total;
  const periods = scopes(t);
  const current = await redis(periods.map(p => ['ZSCORE', p.lb, playerId]));
  const improved = periods.filter((p, i) => current[i] === null || s > Number(current[i]));
  const entry = JSON.stringify({ n, s, t });
  const writes = [
    // Historique du joueur, retrouvé sur tous ses appareils une fois connecté avec Google.
    ['ZADD', historyKey(playerId), t, `${t}:${n}`],
    ['ZREMRANGEBYRANK', historyKey(playerId), 0, -(HISTORY_CAP + 1)],
    // Stats des succès.
    ['HINCRBY', statsKey(playerId), 'rolls', 1],
    // XP à vie (classement « Lifetime XP ») : la somme de tous ses tirages.
    ['ZINCRBY', XP_LB, s, playerId],
    ['HINCRBY', statsKey(playerId), `t:${a.tier}`, 1],
    // Compteurs du jour (quêtes) et dernière activité (liste d'amis).
    ['HINCRBY', questKey(dayKey(t), playerId), 'rolls', 1],
    ['HINCRBY', questKey(dayKey(t), playerId), 'xp', s],
    ['HINCRBY', questKey(dayKey(t), playerId), `t:${a.tier}`, 1],
    ['EXPIRE', questKey(dayKey(t), playerId), QUEST_TTL],
    ['ZADD', SEEN_KEY, t, playerId],
  ];
  if (a.earnedIds.length) writes.push(['SADD', badgesKey(playerId), ...a.earnedIds]);
  if (a.earnedIds.includes('DRASTIX')) writes.push(['HSET', statsKey(playerId), 'drastix', 1]);
  // Nombre de tirages de la période, au total et par joueur (affichés au classement).
  for (const p of periods) {
    writes.push(['INCR', p.total], ['HINCRBY', p.count, playerId, 1]);
    if (p.ttl) writes.push(['EXPIRE', p.total, p.ttl], ['EXPIRE', p.count, p.ttl]);
  }
  for (const p of improved) {
    writes.push(['ZADD', p.lb, s, playerId], ['HSET', p.best, playerId, entry]);
    if (p.ttl) writes.push(['EXPIRE', p.lb, p.ttl], ['EXPIRE', p.best, p.ttl]);
  }
  writes.push(['HGETALL', statsKey(playerId)], ['SCARD', badgesKey(playerId)], ['ZCARD', historyKey(playerId)]);
  writes.push(['ZREVRANK', periods[0].lb, playerId]);
  const out = await redis(writes);
  const dayRank = out[out.length - 1] === null ? null : Number(out[out.length - 1]) + 1;
  let stats = { ...toObject(out[out.length - 4]), badges: Number(out[out.length - 3]) };

  // Meilleur tirage, "meilleur du jour" et nouveau joueur : écrits après coup, seulement s'ils changent.
  const fix = [];
  if (s > Number(stats.best || 0)) { fix.push(['HSET', statsKey(playerId), 'best', s]); stats.best = s; }
  if (dayRank === 1 && !Number(stats.dayTop)) { fix.push(['HSET', statsKey(playerId), 'dayTop', 1]); stats.dayTop = 1; }
  if (!stats.v && Number(out[out.length - 2]) <= 1) { fix.push(['HSET', statsKey(playerId), 'v', STATS_VERSION]); stats.v = STATS_VERSION; }
  if (fix.length) await redis(fix);
  if (!stats.v) stats = await rebuildStats(playerId); // ancien joueur : reconstruites une fois depuis l'historique
  else stats = await splitTopTiers(playerId, stats);
  return { s, bestToday: improved.some(p => p.period === 'day'), dayRank, achievements: Achievements.unlocked(stats) };
}

// Tirages en attente de révélation. Un tirage de duel n'existe pour personne (historique, classement, stats, pièces,
// succès) tant que sa révélation n'est pas finie à l'écran : sinon un 2e onglet ouvert sur History la gâche.
// Chaque entrée = { rolls: [[id, n, t]…], w: [commandes Redis] }, score = heure de révélation complète.
// N'importe quelle requête d'API applique les entrées échues ; ZREM garantit qu'une seule l'applique.
const PENDING_KEY = 'pending';
const queueReveal = (due, entry) => ['ZADD', PENDING_KEY, due, JSON.stringify(entry)];
async function flushDue(now = Date.now()) {
  try {
    const [due] = await redis([['ZRANGEBYSCORE', PENDING_KEY, '-inf', now, 'LIMIT', 0, 20]]);
    for (const member of due || []) {
      const [claimed] = await redis([['ZREM', PENDING_KEY, member]]);
      if (Number(claimed) !== 1) continue;
      const entry = JSON.parse(member);
      for (const [id, n, t] of entry.rolls || []) await recordRoll(id, n, t);
      if (entry.w && entry.w.length) await redis(entry.w);
      if (entry.wager) await settleWager(entry.wager.code, entry.wager.winner || null); // pot du duel, ou remboursement
    }
  } catch (err) {
    console.error('flushDue', err); // la requête en cours passe quand même ; la prochaine réessaiera
  }
}

module.exports = {
  grantGoogleBonus, queueReveal, flushDue, PENDING_KEY, XP_LB, lifetimeXp, lifetimeTotals, questKey, QUEST_TTL, SEEN_KEY, settleWager,
  engine, redis, dayKey, weekKey, scopes, cleanName, sha256, cors, send, verifyGoogleToken,
  ownsPlayer, historyKey, HISTORY_CAP, claimPlayer, claimName, nameKey, rollSet, findPlayer, recordRoll,
  Achievements, statsKey, readStats, toObject, OWNER_EMAIL_SHA256, markFresh,
};
