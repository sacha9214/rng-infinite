// Outils partagés par les fonctions /api (le préfixe _ empêche Vercel d'en faire un endpoint).
const crypto = require('node:crypto');
const Discord = require('./_discord');
const Events = require('../js/events.js');
const { createEngine } = require('../js/engine.js');
const Achievements = require('../js/achievements.js');
const meta = require('../data/badge-meta.json');
const percentiles = require('../data/percentiles.json');

// Même moteur et mêmes données que le site : l'EP calculé ici est identique à celui affiché.
const engine = createEngine(meta, percentiles);
// Score de chaque nombre gardé en mémoire (1 000 001 nombres possibles, 4 Mo) : le recalcul des classements et les
// gros profils (jusqu'à 64 000 tirages) recalculaient des centaines de milliers de scores en bloquant le serveur.
{
  const raw = engine.scoreOf.bind(engine), memo = new Int32Array(1000001).fill(-1);
  engine.scoreOf = (n, onBadge) => {
    if (onBadge || !Number.isInteger(n) || n < 0 || n > 1000000) return raw(n, onBadge);
    const v = memo[n];
    return v >= 0 ? v : (memo[n] = raw(n));
  };
}
// Laisse passer les autres demandes pendant un long calcul (à appeler toutes les quelques milliers d'itérations).
const breathe = () => new Promise(done => setImmediate(done));

// Variables posées par l'intégration Upstash Redis de Vercel (noms KV_* ou UPSTASH_*).
// Base de données : notre Redis sur le VPS (RNG_REDIS_*, voir deploy/ovh) en priorité, sinon Upstash (variables de
// l'intégration Vercel, gardées pour revenir en arrière en supprimant simplement les deux RNG_REDIS_*).
const REDIS_URL = process.env.RNG_REDIS_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.RNG_REDIS_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Relais sur la même machine (VPS) : une connexion neuve par appel. En gardant la connexion ouverte, une réponse sur
// deux attendait 40 ms (le relais Python écrit en deux paquets, Nagle + ACK retardé) : 22 ms en moyenne par appel au
// lieu de 2 (mesuré le 2026-10-17, tous les tirages ralentis). Vers Upstash / HTTPS, on garde la connexion ouverte.
const LOCAL_RELAY = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(String(REDIS_URL || ''));

// Exécute une liste de commandes Redis en un seul aller-retour (API REST d'Upstash).
async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw Object.assign(new Error('Leaderboard database is not configured'), { status: 503 });
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json', ...(LOCAL_RELAY ? { Connection: 'close' } : {}) },
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
  const day = dayKey(t), week = weekKey(t), month = day.slice(0, 7);
  return [
    { period: 'day', lb: `lb:day:${day}`, best: `best:day:${day}`, count: `count:day:${day}`, total: `rolls:day:${day}`, ttl: 8 * 86400 },
    { period: 'week', lb: `lb:week:${week}`, best: `best:week:${week}`, count: `count:week:${week}`, total: `rolls:week:${week}`, ttl: 40 * 86400 },
    { period: 'month', lb: `lb:month:${month}`, best: `best:month:${month}`, count: `count:month:${month}`, total: `rolls:month:${month}`, ttl: 70 * 86400 },
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

// Comptes invités à consulter la page Owner sans rien pouvoir y changer (empreintes SHA-256 de leur e-mail Google, comme
// pour le créateur). Retirer une empreinte d'ici retire l'accès : elle est revérifiée à chaque demande.
const VIEWER_EMAILS_SHA256 = new Set((process.env.VIEWER_EMAILS_SHA256 || '34f4c34b6ef234e7f7bd0e326b51c73a293c8cc71ad1f5173f5bebbe6e9813a2').split(',').map(x => x.trim()).filter(Boolean));
// Accès en lecture seule aux pages du créateur (e-mail Google connu, ou donné à la main : HSET stats:<id> viewerGrant 1).
const canViewOwner = st => Number(st.owner) >= 1 || st.viewerGrant === '1' || (!!st.viewer && VIEWER_EMAILS_SHA256.has(st.viewer));

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
  // Images des photos de profil (GET ?avatar=…) : légères et mises en cache par le navigateur ; un classement en affiche
  // des dizaines d'un coup, et toute une classe derrière la même IP dépassait la limite (2026-10-26).
  if (req.method === 'GET' && /[?&]avatar=/.test(String(req.url || ''))) return false;
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
  res.setHeader('Access-Control-Max-Age', '86400');
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
  if (!Number(size)) await redis([['HSETNX', statsKey(playerId), 'v', STATS_VERSION], ['HSETNX', statsKey(playerId), 'tv', TIERS_VERSION], ['HSETNX', statsKey(playerId), 'gv', GODLIKE_VERSION]]);
}

// Clé d'unicité d'un nom : sans accents, majuscules, espaces ni ponctuation ("Sacha", "sâcha" et "Sa-cha!" = le même nom).
function nameKey(name) {
  const key = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key || String(name).toLowerCase().replace(/\s+/g, '');
}

// Réserve un nom pour ce joueur et libère son ancien nom. Faux si un autre joueur l'a déjà.
// Changer de pseudo coûte des pièces depuis le 2026-10-25 (api/name.js) : sans opts.rename, un joueur qui a déjà un
// pseudo garde le sien (un tirage, un duel envoyant un autre nom ne le change plus) ; seule la casse ou les espaces
// (même nameKey) restent libres. Réponse : true (ce nom est le sien), false (pris), { kept: <pseudo actuel> } (gardé, rien ne change).
async function claimName(playerId, name, opts = {}) {
  const key = `name:${nameKey(name)}`;
  if (!opts.rename) {
    const [prev, holder] = await redis([['HGET', 'names', playerId], ['GET', key]]);
    if (holder && holder !== playerId) return false; // le nom d'un autre : refusé, comme avant
    if (prev && nameKey(prev) !== nameKey(name)) return { kept: prev };
  }
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
// Classement « Most rolls » (idée de CrazyMiner22 et WpBejs, 2026-10-27) : id → nombre de tirages à vie (stats.rolls),
// un membre par joueur comme lb:xp. Incrémenté à chaque tirage ; les anciens joueurs y sont versés par migrateRolls
// (api/leaderboard.js).
const ROLLS_LB = 'lb:rolls';

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
const TIERS = ['landwaste', 'garbage', 'trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite'];
const STATS_VERSION = '1';
// Raretés au-dessus de Mythic (2026-10-09) : "tv" marque les compteurs déjà répartis entre Mythic et les trois nouvelles.
const TIERS_VERSION = '2';
const TOP_TIERS = ['celestial', 'divine', 'godlike', 'infinite'];
// Rareté Godlike (2026-10-16), prise dans Divine : "gv" marque les compteurs où les anciens Godlike ont été retirés de
// Divine (signalé par MAYO : les joueurs qui en avaient tiré un n'avaient pas le succès).
const GODLIKE_VERSION = '1';
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
    ['HSET', statsKey(playerId), 'rolls', rolls, 'best', best, 'drastix', drastix, 'v', STATS_VERSION, 'tv', TIERS_VERSION, 'gv', GODLIKE_VERSION, ...TIERS.flatMap(t => [`t:${t}`, tiers[t]])],
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
  if (stats.tv === TIERS_VERSION) return splitGodlike(playerId, stats);
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

// Les Godlike d'avant la nouvelle rareté étaient comptés en Divine : on les retrouve dans l'historique et on les déplace.
async function splitGodlike(playerId, stats) {
  if (stats.gv === GODLIKE_VERSION) return stats;
  const [first] = await redis([['HSETNX', statsKey(playerId), 'gv', GODLIKE_VERSION]]);
  stats.gv = GODLIKE_VERSION;
  const divine = Number(stats['t:divine']) || 0;
  if (Number(first) !== 1 || !divine) return stats;
  const [members] = await redis([['ZRANGE', historyKey(playerId), 0, -1]]);
  const seen = rollSet();
  let found = 0;
  for (const m of members || []) {
    const [t, n] = m.split(':').map(Number);
    if (seen.add(n, t) && engine.cardTier(engine.scoreOf(n)) === 'godlike') found++;
  }
  // Déjà comptés en Godlike (tirés depuis la mise à jour) : ils sont aussi dans l'historique.
  const already = Number(stats['t:godlike']) || 0;
  const moved = Math.max(0, Math.min(divine, found - already));
  if (!moved) return stats;
  await redis([['HINCRBY', statsKey(playerId), 't:divine', -moved], ['HINCRBY', statsKey(playerId), 't:godlike', moved]]);
  stats['t:divine'] = String(divine - moved); stats['t:godlike'] = String(already + moved);
  return stats;
}

// Bonus du compte Google : une fois par joueur (le marqueur posé en premier sert de verrou), donc une fois par compte
// Google, puisqu'un compte ne tient qu'un joueur. Rend le montant versé, ou 0 s'il l'avait déjà eu.
async function grantGoogleBonus(playerId) {
  const [first] = await redis([['HSETNX', statsKey(playerId), 'googleBonus', 1]]);
  if (Number(first) !== 1) return 0;
  const amount = require('../js/shop.js').GOOGLE_BONUS;
  await redis([['HINCRBY', statsKey(playerId), 'bonus', amount], ...eco('in:other', amount)]);
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
// Quêtes de la semaine (idée de Tumored, 2026-10-27) : compteurs de la semaine ISO d'un joueur (tirages, raretés Epic
// et mieux, jours où toutes les quêtes du jour ont été finies), un hash de quelques champs par joueur actif, gardé 10 jours.
const weekQuestKey = (week, playerId) => `qw:${week}:${playerId}`;
const WEEK_QUEST_TTL = 10 * 86400;
const WEEK_QUEST_TIERS = new Set(['epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite']);
// Joueurs actifs d'un jour : hash identifiant → nombre de tirages ce jour-là, gardé 400 jours. Sert uniquement aux
// totaux de la page Owner (actifs par jour, rétention par cohorte) ; jamais affiché par joueur.
const actKey = day => `act:${day}`, ACT_TTL = 400 * 86400;
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
// Économie (page Owner, 2026-10-18) : pièces créées et dépensées par jour, par source. eco:<jour> → in:<source> et
// out:<usage>. Les cadeaux et les mises de duel ne sont pas comptés : ils passent d'un joueur à l'autre.
const ecoKey = t => `eco:${dayKey(t)}`;
const eco = (field, amount, t = Date.now()) => (amount ? [['HINCRBY', ecoKey(t), field, Math.round(amount)], ['EXPIRE', ecoKey(t), 100 * 86400]] : []);
const WORST_LB = 'lb:worst', WORST_BEST = 'worst:all';
// Poubelle par période (idée d'Angelicide9, 2026-10-18) : pire tirage du jour, de la semaine et du mois, à côté des meilleurs.
const worstKeys = p => ({ lb: p.lb.replace(/^lb:/, 'lbw:'), best: p.best.replace(/^best:/, 'worstp:') });
// Alerte des amis (idée de Jguz01, 2026-10-26) : un tirage Celestial ou mieux (top 0,1 %, donc rare) est poussé dans
// la boîte bigin:<ami> de chaque ami, avec le pseudo seulement (jamais l'id). Les amis la lisent avec leur relève des
// cadeaux (toutes les minutes, api/friends.js 'gifts'). 10 dernières gardées, un jour.
const BIG_TIERS = new Set(['celestial', 'divine', 'godlike', 'infinite']), BIG_KEEP = 10, BIG_TTL = 86400;
const bigKey = id => `bigin:${id}`;
async function pushBigRoll(playerId, n, tier, t) {
  const [friends, name] = await redis([['SMEMBERS', `fr:${playerId}`], ['HGET', 'names', playerId]]);
  if (!name || !friends || !friends.length) return 0;
  const row = JSON.stringify({ name, n, tier, t });
  await redis(friends.flatMap(f => [['RPUSH', bigKey(f), row], ['LTRIM', bigKey(f), -BIG_KEEP, -1], ['EXPIRE', bigKey(f), BIG_TTL]]));
  return friends.length;
}

async function recordRoll(playerId, n, t) {
  const a = engine.analyze(n);
  const s = a.total;
  const periods = scopes(t);
  const wPeriods = periods.filter(p => p.period !== 'all');
  // clanof lu dans la même requête : l'XP du tirage compte pour le clan du joueur cette semaine (api/_clan.js).
  // rc:<jour>:<id> : numéro de ce tirage dans la journée UTC (rendements décroissants des pièces, Shop.ROLL_TIERS).
  const rcKey = `rc:${dayKey(t)}:${playerId}`;
  const [worst, clanId, ...rest] = await redis([['ZSCORE', WORST_LB, playerId], ['HGET', 'clanof', playerId], ...periods.map(p => ['ZSCORE', p.lb, playerId]), ...wPeriods.map(p => ['ZSCORE', worstKeys(p).lb, playerId]), ['INCR', rcKey], ['EXPIRE', rcKey, 2 * 86400]]);
  const current = rest.slice(0, periods.length), worstNow = rest.slice(periods.length, periods.length + wPeriods.length);
  const dayRoll = Number(rest[periods.length + wPeriods.length]) || 1;
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
    ['ZINCRBY', ROLLS_LB, 1, playerId],
    ['HINCRBY', statsKey(playerId), 'xpLife', s], // XP à vie dans les stats aussi : titres Centimillionaire / Billionaire
    ['HINCRBY', statsKey(playerId), `t:${a.tier}`, 1],
    // Compteurs du jour (quêtes) et dernière activité (liste d'amis).
    ['HINCRBY', questKey(dayKey(t), playerId), 'rolls', 1],
    ['HINCRBY', questKey(dayKey(t), playerId), 'xp', s],
    ['HINCRBY', questKey(dayKey(t), playerId), `t:${a.tier}`, 1],
    ['EXPIRE', questKey(dayKey(t), playerId), QUEST_TTL],
    // Quêtes de la semaine : tirages et raretés Epic ou mieux (les seules que demandent les quêtes de la semaine).
    ['HINCRBY', weekQuestKey(weekKey(t), playerId), 'rolls', 1],
    ...(WEEK_QUEST_TIERS.has(a.tier) ? [['HINCRBY', weekQuestKey(weekKey(t), playerId), `t:${a.tier}`, 1]] : []),
    ['EXPIRE', weekQuestKey(weekKey(t), playerId), WEEK_QUEST_TTL],
    ['ZADD', SEEN_KEY, t, playerId],
    // Activité par jour (page Owner : joueurs actifs, rétention) et date du tout premier tirage.
    ['HINCRBY', actKey(dayKey(t)), playerId, 1],
    ['EXPIRE', actKey(dayKey(t)), ACT_TTL],
    ['HSETNX', statsKey(playerId), 'first', t],
  ];
  if (a.earnedIds.length) writes.push(['SADD', badgesKey(playerId), ...a.earnedIds]);
  if (clanId) writes.push(...require('./_clan').rollWrites(clanId, playerId, s, t));
  // coins : ce que ce tirage rapporte, Weekend Rush compris (affiché sous l'XP, idée de jaxoncool43, 2026-10-24).
  let coins = 0;
  const Shop = require('../js/shop.js'), rate = Shop.rollRate(dayRoll);
  { const full = Shop.COINS[a.tier] || 0, c = Shop.rollPay(full, dayRoll, a.tier); writes.push(...eco('in:rolls', c, t)); coins = c;
    // Rendements décroissants : la part non versée va dans rollCut (le solde se calcule sur les compteurs de rareté).
    if (full > c) writes.push(['HINCRBY', statsKey(playerId), 'rollCut', full - c]);
    // Weekend Rush : +25 % de ce qui est versé, en bonus. rushBonus : la part du Weekend Rush dans « bonus » (tests, stats).
    const r = Events.rushBonus(c, t);
    if (r) { writes.push(['HINCRBY', statsKey(playerId), 'bonus', r], ['HINCRBY', statsKey(playerId), 'rushBonus', r], ...eco('in:weekend', r, t)); coins += r; } }
  // Événement de la semaine (js/events.js) : un tirage qui obtient un badge du thème compte une fois.
  { const ev = Events.current(t); if (Events.counts(ev, a.earnedIds)) writes.push(['ZINCRBY', Events.key(ev), 1, playerId], ['EXPIRE', Events.key(ev), 60 * 86400]); }
  if (a.earnedIds.includes('DRASTIX')) writes.push(['HSET', statsKey(playerId), 'drastix', 1]);
  // Nombre de tirages de la période, au total et par joueur (affichés au classement).
  for (const p of periods) {
    writes.push(['INCR', p.total], ['HINCRBY', p.count, playerId, 1]);
    if (p.ttl) writes.push(['EXPIRE', p.total, p.ttl], ['EXPIRE', p.count, p.ttl]);
  }
  // Classement Poubelle (idée d'un joueur, 2026-10-16) : le pire tirage de chaque joueur, de tous les temps.
  if (worst === null || s < Number(worst)) writes.push(['ZADD', WORST_LB, s, playerId], ['HSET', WORST_BEST, playerId, entry]);
  wPeriods.forEach((p, i) => {
    if (worstNow[i] !== null && s >= Number(worstNow[i])) return;
    const k = worstKeys(p);
    writes.push(['ZADD', k.lb, s, playerId], ['HSET', k.best, playerId, entry], ['EXPIRE', k.lb, p.ttl], ['EXPIRE', k.best, p.ttl]);
  });
  for (const p of improved) {
    writes.push(['ZADD', p.lb, s, playerId], ['HSET', p.best, playerId, entry]);
    if (p.ttl) writes.push(['EXPIRE', p.lb, p.ttl], ['EXPIRE', p.best, p.ttl]);
  }
  // Doublons (succès Déjà vu, idée de Lolha39, 2026-10-18) : nums:<id> = les nombres déjà tirés ; SADD répond 0 si
  // le nombre y était déjà.
  const dupAt = writes.length;
  writes.push(['SADD', `nums:${playerId}`, n]);
  writes.push(['HGETALL', statsKey(playerId)], ['SCARD', badgesKey(playerId)], ['ZCARD', historyKey(playerId)]);
  writes.push(['ZREVRANK', periods[0].lb, playerId]);
  const out = await redis(writes);
  if (BIG_TIERS.has(a.tier)) await pushBigRoll(playerId, n, a.tier, t).catch(() => {}); // une alerte ratée ne bloque pas le tirage
  const dayRank = out[out.length - 1] === null ? null : Number(out[out.length - 1]) + 1;
  let stats = { ...toObject(out[out.length - 4]), badges: Number(out[out.length - 3]) };

  // Meilleur tirage, "meilleur du jour" et nouveau joueur : écrits après coup, seulement s'ils changent.
  const fix = [];
  if (s > Number(stats.best || 0)) { fix.push(['HSET', statsKey(playerId), 'best', s]); stats.best = s; }
  if (dayRank === 1 && !Number(stats.dayTop)) { fix.push(['HSET', statsKey(playerId), 'dayTop', 1]); stats.dayTop = 1; }
  if (!stats.v && Number(out[out.length - 2]) <= 1) { fix.push(['HSET', statsKey(playerId), 'v', STATS_VERSION]); stats.v = STATS_VERSION; }
  if (stats.dv !== '1') {
    // Joueur d'avant ce compteur : ses doublons recomptés une fois depuis son historique (qui contient déjà ce tirage).
    const [members] = await redis([['ZRANGE', historyKey(playerId), 0, -1]]);
    const nums = (members || []).map(m => Number(String(m).split(':')[1])).filter(Number.isInteger), distinct = new Set(nums);
    fix.push(['HSET', statsKey(playerId), 'dups', nums.length - distinct.size, 'dv', 1]);
    if (distinct.size) fix.push(['SADD', `nums:${playerId}`, ...distinct]);
    stats.dups = String(nums.length - distinct.size); stats.dv = '1';
  } else if (Number(out[dupAt]) === 0) { fix.push(['HINCRBY', statsKey(playerId), 'dups', 1]); stats.dups = String((Number(stats.dups) || 0) + 1); }
  if (fix.length) await redis(fix);
  if (!stats.v) stats = await rebuildStats(playerId); // ancien joueur : reconstruites une fois depuis l'historique
  else stats = await splitTopTiers(playerId, stats);
  // Nouveau record Mythic ou mieux d'un joueur qui a lié son Discord : son rôle de rareté suit (api/_discord_link.js).
  if (['mythic', 'celestial', 'divine', 'godlike', 'infinite'].includes(a.tier) && Number(stats.best) === s) redis([['HGET', statsKey(playerId), 'discord']]).then(([uid]) => uid && require('./_discord_link').syncRoles(playerId)).catch(() => {});
  // Grand tirage (Celestial ou mieux) : annoncé sur le Discord, en arrière-plan.
  if (Discord.ANNOUNCED.includes(a.tier)) redis([['HGET', 'names', playerId]]).then(([name]) => Discord.announceRoll({ name, n, a })).catch(() => {});
  return { s, coins, rate, dayRoll, bestToday: improved.some(p => p.period === 'day'), dayRank, achievements: Achievements.unlocked(stats) };
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

module.exports = { bigKey, BIG_TIERS, eco, worstKeys, breathe, WORST_LB, WORST_BEST,
  grantGoogleBonus, queueReveal, flushDue, PENDING_KEY, XP_LB, ROLLS_LB, weekQuestKey, WEEK_QUEST_TTL, lifetimeXp, lifetimeTotals, questKey, QUEST_TTL, SEEN_KEY, actKey, ACT_TTL, settleWager,
  engine, redis, dayKey, weekKey, scopes, cleanName, sha256, cors, send, verifyGoogleToken,
  ownsPlayer, historyKey, HISTORY_CAP, claimPlayer, claimName, nameKey, rollSet, findPlayer, recordRoll,
  Achievements, statsKey, readStats, toObject, OWNER_EMAIL_SHA256, VIEWER_EMAILS_SHA256, canViewOwner, markFresh,
};
