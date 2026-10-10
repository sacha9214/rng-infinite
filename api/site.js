// POST /api/site { action, … } — ce qui concerne le site plutôt qu'une partie : boîte à suggestions et fréquentation.
//   visit                       (sans compte) compteurs anonymes du jour : visites, site d'origine, pays, appareil, langue
//   suggest  { text }           (joueur) envoie une suggestion
//   peek     { since }          (Owner) nombre de suggestions reçues depuis « since » : le point rouge de l'ampoule
//   mine                        (joueur) ses suggestions, leur statut et la réponse éventuelle ; dit aussi s'il est Owner
//   inbox                       (Owner) toutes les suggestions
//   mark     { id, status, reply }   (Owner) change le statut et/ou répond     · delete { id } (Owner) supprime
//   stats                       (Owner) fréquentation des 30 derniers jours
//   fund                        (Owner) contributions reçues ; fundAdd { name, euros } inscrit une contribution et donne
//                               au joueur le skin et le titre Supporter ; fundSet { goal, url } règle l'objectif et le lien
//   insights                    (Owner) carte des visites, heures d'activité, casino par jeu, joueurs et économie
// Fréquentation : uniquement des compteurs agrégés par jour (an:<jour>), sans identifiant, sans adresse IP, sans cookie.
// Carte : la position approximative d'une visite (donnée par l'hébergeur d'après l'adresse, arrondie au degré, soit
// une case d'environ 100 km) est seulement comptée dans la case du jour (ang:<jour>) ; rien ne la relie à un joueur.
const crypto = require('node:crypto');
const { redis, ownsPlayer, readStats, dayKey, cleanName, toObject, cors, send, flushDue, statsKey, SEEN_KEY, findPlayer, nameKey } = require('./_lib');
const Shop = require('../js/shop.js');

const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const DAY_MS = 86400000;

// ---------------------------------------------------------------- suggestions
const SUGG_MAX = 500, SUGG_MIN = 5, SUGG_PER_DAY = 5, REPLY_MAX = 300, INBOX_MAX = 200;
const STATUSES = ['new', 'seen', 'planned', 'done', 'declined'];
const suggKey = id => `sugg:${id}`, byPlayer = id => `sugg:by:${id}`;
// Texte libre : on retire les caractères de contrôle et on borne la longueur ; l'affichage l'échappe côté site.
const cleanText = (raw, max) => String(raw || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

async function listSuggestions(ids) {
  if (!ids.length) return [];
  const rows = await redis(ids.map(id => ['HGETALL', suggKey(id)]));
  return rows.map((flat, i) => ({ id: ids[i], ...toObject(flat) })).filter(x => x.text)
    .map(x => ({ id: x.id, t: Number(x.t), name: x.name || 'Player', text: x.text, status: STATUSES.includes(x.status) ? x.status : 'new', reply: x.reply || '', lang: x.lang || '' }));
}

// ---------------------------------------------------------------- fréquentation
const AN_TTL = 200 * 86400, AN_FIELDS_MAX = 400;
const anKey = day => `an:${day}`, geoKey = day => `ang:${day}`, GEO_CELLS_MAX = 1500;
const host = raw => {
  const h = String(raw || '').toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && h.length <= 60 ? h : '';
};
const tag = raw => { const v = String(raw || '').toLowerCase(); return /^[a-z0-9_.-]{1,30}$/.test(v) ? v : ''; };
// Une visite = une balise. Plafond par adresse et par heure, large exprès : tout un collège peut jouer derrière la
// même adresse (Wi-Fi commun). Au-delà, on ignore, sans rien stocker.
const beacons = new Map();
function tooManyBeacons(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const hour = Math.floor(Date.now() / 3600000);
  if (beacons.size > 5000) beacons.clear();
  const key = `${ip}|${hour}`;
  const n = (beacons.get(key) || 0) + 1;
  beacons.set(key, n);
  return n > 60;
}

async function recordVisit(req, body) {
  if (tooManyBeacons(req)) return;
  const day = dayKey(Date.now());
  const ref = host(body.ref) || 'direct', src = tag(body.src);
  const country = /^[A-Z]{2}$/.test(String(req.headers['x-vercel-ip-country'] || '')) ? req.headers['x-vercel-ip-country'] : 'ZZ';
  const fields = ['visits', `ref:${ref}`, `c:${country}`, `d:${body.mobile ? 'mobile' : 'desktop'}`, `l:${body.lang === 'fr' ? 'fr' : 'en'}`, `h:${String(new Date(Date.now()).getUTCHours()).padStart(2, "0")}`];
  // Case de la carte : latitude et longitude arrondies au degré. Absentes (test local, adresse inconnue) : rien.
  const lat = Number(req.headers['x-vercel-ip-latitude']), lon = Number(req.headers['x-vercel-ip-longitude']);
  const cell = req.headers['x-vercel-ip-latitude'] && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? `${Math.round(lat)},${Math.round(lon)}` : '';
  if (body.daily) fields.push('uniq');
  if (body.first) fields.push('new');
  if (src) fields.push(`src:${src}`);
  // Un jour ne peut pas enfler sans fin (quelqu'un qui enverrait des milliers d'origines inventées) : passé 400 champs,
  // les origines inconnues vont dans « other ».
  const [size, ...known] = await redis([['HLEN', anKey(day)], ...fields.map(f => ['HEXISTS', anKey(day), f])]);
  const safe = fields.map((f, i) => (Number(known[i]) === 1 || Number(size) < AN_FIELDS_MAX || !/^(ref|src):/.test(f) ? f : `${f.split(':')[0]}:other`));
  await redis([...safe.map(f => ['HINCRBY', anKey(day), f, 1]), ['EXPIRE', anKey(day), AN_TTL]]);
  if (cell) {
    // 64 800 cases possibles au plus sur Terre, mais un jour reste borné : passé 1 500 cases, les nouvelles sont ignorées.
    const [cells, has] = await redis([['HLEN', geoKey(day)], ['HEXISTS', geoKey(day), cell]]);
    if (Number(has) === 1 || Number(cells) < GEO_CELLS_MAX) await redis([['HINCRBY', geoKey(day), cell, 1], ['EXPIRE', geoKey(day), AN_TTL]]);
  }
}

async function siteStats(days = 30) {
  const now = Date.now();
  const keys = Array.from({ length: days }, (_, i) => dayKey(now - i * DAY_MS));
  const rows = await redis(keys.flatMap(d => [['HGETALL', anKey(d)], ['ZCARD', `lb:day:${d}`], ['GET', `rolls:day:${d}`]]));
  const daily = keys.map((d, i) => {
    const h = toObject(rows[i * 3]);
    return { day: d, visits: Number(h.visits) || 0, uniq: Number(h.uniq) || 0, fresh: Number(h.new) || 0, players: Number(rows[i * 3 + 1]) || 0, rolls: Number(rows[i * 3 + 2]) || 0, h };
  });
  // Totaux par origine / pays / appareil / langue sur 7 et 30 jours.
  const sum = (list, prefix) => {
    const out = {};
    for (const d of list) for (const [k, v] of Object.entries(d.h)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = (out[k.slice(prefix.length)] || 0) + (Number(v) || 0);
    return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, count]) => ({ name, count }));
  };
  const group = list => ({ refs: sum(list, 'ref:'), sources: sum(list, 'src:'), countries: sum(list, 'c:'), devices: sum(list, 'd:'), langs: sum(list, 'l:') });
  const [names, google] = await redis([['HLEN', 'names'], ['ZCARD', 'lb:all']]);
  return {
    days: daily.map(({ h, ...d }) => d), week: group(daily.slice(0, 7)), month: group(daily),
    totals: { named: Number(names) || 0, ranked: Number(google) || 0 },
  };
}

// ---------------------------------------------------------------- page Owner : comprendre les joueurs
// Tout est agrégé ici, à la demande : la carte (pays et cases sur 30 jours, cases du jour), les heures d'activité, le
// casino (par jeu, par jour, plus gros joueurs) et l'état des joueurs (activité, ancienneté en tirages, économie).
const GAMES = ['crash', 'mines', 'plinko', 'slots', 'roulette', 'bj'];
const COUNTERS = { crash: 'gCrash', mines: 'gMines', plinko: 'gPlinko', slots: 'gSlots', roulette: 'gSpins', bj: 'gHands' };
const num = v => Number(v) || 0;
async function insights() {
  const now = Date.now();
  const days = Array.from({ length: 30 }, (_, i) => dayKey(now - i * DAY_MS));
  const rows = await redis([
    ...days.flatMap(d => [['HGETALL', anKey(d)], ['HGETALL', geoKey(d)]]),
    ...days.slice(0, 14).flatMap(d => [['HGETALL', `casino:d:${d}`], ['SCARD', `casino:p:${d}`]]),
    ['HGETALL', 'casino'], ['HKEYS', 'names'], ['HGETALL', 'skins'], ['HGETALL', 'btns'],
    ['ZCOUNT', SEEN_KEY, now - DAY_MS, '+inf'], ['ZCOUNT', SEEN_KEY, now - 7 * DAY_MS, '+inf'], ['ZCOUNT', SEEN_KEY, now - 30 * DAY_MS, '+inf'],
  ]);
  // Carte et heures.
  const countries = {}, cells = {}, hours = new Array(24).fill(0);
  days.forEach((d, i) => {
    for (const [k, v] of Object.entries(toObject(rows[i * 2]))) {
      if (k.startsWith('c:')) countries[k.slice(2)] = (countries[k.slice(2)] || 0) + num(v);
      else if (k.startsWith('h:')) hours[Number(k.slice(2))] += num(v);
    }
    for (const [k, v] of Object.entries(toObject(rows[i * 2 + 1]))) cells[k] = (cells[k] || 0) + num(v);
  });
  const point = ([k, n]) => { const [lat, lon] = k.split(',').map(Number); return { lat, lon, n }; };
  const base = 60;
  // Casino.
  const house = toObject(rows[base + 28]);
  const daily = days.slice(0, 14).map((d, i) => { const h = toObject(rows[base + i * 2]); const r = GAMES.reduce((x, g) => x + num(h[`r:${g}`]), 0); return { day: d, rounds: r, bet: GAMES.reduce((x, g) => x + num(h[`b:${g}`]), 0), won: GAMES.reduce((x, g) => x + num(h[`w:${g}`]), 0), players: num(rows[base + i * 2 + 1]), games: Object.fromEntries(GAMES.map(g => [g, num(h[`r:${g}`])])) }; });
  // Joueurs : une lecture de chaque fiche, par paquets.
  const ids = rows[base + 29] || [];
  const stats = [];
  for (let i = 0; i < ids.length; i += 200) (await redis(ids.slice(i, i + 200).map(id => ['HGETALL', statsKey(id)]))).forEach(flat => stats.push(toObject(flat)));
  const names = ids.length ? (await redis([['HMGET', 'names', ...ids]]))[0] || [] : [];
  const BUCKETS = [[1, 9], [10, 29], [30, 99], [100, 499], [500, 1999], [2000, Infinity]];
  const rollBuckets = BUCKETS.map(([a, b]) => ({ name: b === Infinity ? `${a}+` : `${a}–${b}`, count: 0 }));
  const allTime = Object.fromEntries(GAMES.map(g => [g, 0]));
  const speed = [0, 0, 0, 0, 0, 0], top = { celestial: 0, divine: 0, infinite: 0, mythic: 0 };
  let rolled = 0, coins = 0, earned = 0, spent = 0, gamblers = 0, unlocked = 0, questsDone = 0, duelWins = 0, totalRolls = 0, streaks = 0;
  const gamblerRows = [];
  const today = dayKey(now), yesterday = dayKey(now - DAY_MS);
  stats.forEach((st, i) => {
    const rolls = num(st.rolls);
    if (rolls > 0) { rolled++; rollBuckets[BUCKETS.findIndex(([a, b]) => rolls >= a && rolls <= b)].count++; }
    totalRolls += rolls;
    if (rolls >= 30) unlocked++;
    coins += Math.max(0, Shop.balance(st)); earned += Shop.earned(st) + num(st.bonus); spent += num(st.spent);
    for (const g of GAMES) allTime[g] += num(st[COUNTERS[g]]);
    if (num(st.gBet) > 0) { gamblers++; gamblerRows.push({ name: names[i] || 'Player', bet: num(st.gBet), net: num(st.gWon) - num(st.gBet), rounds: GAMES.reduce((x, g) => x + num(st[COUNTERS[g]]), 0) }); }
    speed[Shop.speedLevel(st.speedLv)]++;
    for (const k of Object.keys(top)) top[k] += num(st[`t:${k}`]);
    questsDone += num(st.questsDone); duelWins += num(st.duelWins);
    if (st.streakDay === today || st.streakDay === yesterday) streaks++;
  });
  const tally = flat => { const out = {}; const o = toObject(flat); for (const v of Object.values(o)) { const k = Shop.resolve(v) || v; out[k] = (out[k] || 0) + 1; } return Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })); };
  const byBet = gamblerRows.slice().sort((a, b) => b.bet - a.bet).slice(0, 8);
  return {
    map: {
      countries: Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      points: Object.entries(cells).map(point).sort((a, b) => b.n - a.n).slice(0, 600),
      today: Object.entries(toObject(rows[1])).map(point),
    },
    hours,
    casino: {
      total: { rounds: num(house.rounds), bet: num(house.bet), won: num(house.won) },
      allTime: GAMES.map(g => ({ name: g, count: allTime[g] })),
      tracked: GAMES.map(g => ({ name: g, rounds: num(house[`r:${g}`]), bet: num(house[`b:${g}`]), won: num(house[`w:${g}`]) })),
      daily, gamblers, unlocked,
      topWagered: byBet, topWinners: gamblerRows.slice().sort((a, b) => b.net - a.net).slice(0, 5), topLosers: gamblerRows.slice().sort((a, b) => a.net - b.net).slice(0, 5),
    },
    players: {
      named: ids.length, rolled, totalRolls, active: { day: num(rows[base + 32]), week: num(rows[base + 33]), month: num(rows[base + 34]) },
      rollBuckets, speed: speed.map((count, lv) => ({ name: `Level ${lv}`, count })), streaks, questsDone, duelWins, top,
      skins: tally(rows[base + 30]), buttons: tally(rows[base + 31]),
    },
    economy: { coins, earned, spent },
  };
}

// ---------------------------------------------------------------- cagnotte du serveur
// Les contributions passent par une page de dons extérieure : le site n'encaisse rien et ne voit aucun paiement. Le
// créateur inscrit ici chaque contribution reçue (pseudo, montant) ; le joueur reçoit alors le skin et le titre
// Supporter (stats.supporter = total de ses contributions, en centimes) et le total du mois avance.
const FUND_CFG = 'fund:cfg', FUND_LOG = 'fund:log';
const monthKey = t => new Date(t).toISOString().slice(0, 7), fundKey = month => `fund:${month}`;
const safeUrl = raw => { const u = String(raw || '').trim(); return /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s<>"']*)?$/i.test(u) && u.length <= 200 ? u : ''; };
async function fundState() {
  const month = monthKey(Date.now());
  const [cfg, flat] = await redis([['HGETALL', FUND_CFG], ['HGETALL', fundKey(month)]]);
  const c = toObject(cfg), m = toObject(flat);
  return { month, cents: Math.max(0, Number(m.cents) || 0), count: Number(m.count) || 0, goal: Number(c.goal) || Shop.FUND_GOAL, url: safeUrl(c.url) };
}

// Une contribution pour un joueur : son total (skin et titre Supporter), le total du mois (sauf si le montant y est
// déjà : `counted`) et le journal. Une correction qui le ramène à zéro lui retire le skin s'il le portait.
async function creditFund({ target, name, cents, counted = false, auto = false }) {
  const now = Date.now(), month = monthKey(now);
  const [total] = await redis([['HINCRBY', statsKey(target), 'supporter', cents]]);
  const writes = [['ZADD', FUND_LOG, now, JSON.stringify({ t: now, name, cents, month, ...(auto ? { auto: 1 } : {}) })]];
  if (!counted) writes.push(['HINCRBY', fundKey(month), 'cents', cents], ['HINCRBY', fundKey(month), 'count', cents > 0 ? 1 : 0]);
  if (Number(total) <= 0) { writes.push(['HDEL', statsKey(target), 'supporter']); const [worn] = await redis([['HGET', 'skins', target]]); if (worn === 'supporter') writes.push(['HDEL', 'skins', target]); }
  await redis(writes);
}

// ---------------------------------------------------------------- attribution automatique (webhook Ko-fi)
// À chaque don, Ko-fi appelle /api/site?kofi=1 avec un formulaire dont le champ « data » est un JSON : montant, message
// du donateur, numéro de transaction, et un jeton secret que seuls Ko-fi et le serveur connaissent (variable
// d'environnement KOFI_TOKEN, posée par le créateur). Sans ce jeton exact, rien n'est pris en compte.
// Le pseudo est cherché dans le message (puis dans le nom Ko-fi) ; trouvé, le joueur reçoit skin et titre aussitôt.
// Introuvable, le don compte quand même dans le mois et attend sur la page Owner que le créateur dise à qui il est.
// L'adresse e-mail du donateur n'est jamais gardée.
const FUND_PENDING = 'fund:pending';
async function matchPlayer(message, fromName) {
  const text = String(message || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
  const words = text.split(/[\s,;:!?()"'«»]+/).filter(w => w.length >= 2 && w.length <= 20);
  const stripped = text.replace(/^.*?(?:pseudo|player name|username|name|nom|je suis|i am|i'm|my name is|c'est)\s*(?:is|est)?\s*[:=\-]?\s*/i, '');
  const tries = [text, stripped, stripped.split(/[\s,;.!?]+/)[0], ...words, ...words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`), String(fromName || '')];
  const seen = new Set();
  for (const raw of tries) {
    const name = cleanName(raw);
    if (!name || seen.has(nameKey(name)) || seen.size >= 30) continue;
    seen.add(nameKey(name));
    const [id] = await redis([['GET', `name:${nameKey(name)}`]]);
    if (id) { const [real] = await redis([['HGET', 'names', id]]); return { target: id, name: real || name }; }
  }
  return null;
}
async function kofiWebhook(req) {
  const token = process.env.KOFI_TOKEN || '';
  if (!token) return [503, { error: 'Automatic contributions are not configured' }];
  let data;
  try {
    const body = req.body;
    const raw = typeof body === 'string' ? (new URLSearchParams(body).get('data') || body) : body && body.data !== undefined ? body.data : body;
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return [400, { error: 'Unreadable message' }]; }
  const given = Buffer.from(String((data && data.verification_token) || '')), expected = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return [401, { error: 'Wrong token' }];
  // Seuls les dons comptent (ponctuels ou mensuels) ; une vente de boutique ou une commande est ignorée.
  // Ko-fi nomme un don « Tip » (« Donation » dans son ancien format) et un don mensuel « Subscription ».
  if (!['Tip', 'Donation', 'Subscription'].includes(String(data.type))) return [200, { ok: true, ignored: true }];
  const cents = Math.round(Number(data.amount) * 100), tx = String(data.kofi_transaction_id || data.message_id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  if (!Number.isFinite(cents) || cents <= 0 || cents > 1000000 || !tx) return [400, { error: 'Unreadable amount' }];
  // Ko-fi renvoie un message tant qu'il n'a pas reçu de réponse : chaque transaction ne compte qu'une fois.
  const [first] = await redis([['SET', `kofi:tx:${tx}`, '1', 'NX', 'EX', 200 * 86400]]);
  if (first !== 'OK') return [200, { ok: true, duplicate: true }];
  const found = await matchPlayer(data.message, data.from_name);
  if (found) { await creditFund({ ...found, cents, auto: true }); return [200, { ok: true, matched: true }]; }
  const now = Date.now(), month = monthKey(now);
  await redis([['HINCRBY', fundKey(month), 'cents', cents], ['HINCRBY', fundKey(month), 'count', 1],
    ['HSET', FUND_PENDING, tx, JSON.stringify({ tx, t: now, cents, from: cleanText(data.from_name, 40), message: cleanText(data.message, 200), currency: String(data.currency || '').slice(0, 5) })]]);
  return [200, { ok: true, matched: false }];
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    // Message automatique de la page de dons (Ko-fi) : il arrive sur /api/site?kofi=1, dans un autre format.
    if (/[?&]kofi=1/.test(req.url || '')) return send(res, ...(await kofiWebhook(req)));
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (body.action === 'visit') {
      await recordVisit(req, body);
      // La cagnotte du mois part avec la réponse : le site l'affiche sans demande supplémentaire.
      return send(res, 200, { ok: true, fund: await fundState() });
    }
    // Cagnotte du mois (total, objectif, lien) : public, sans joueur. Aucun nom de contributeur.
    if (body.action === 'fundInfo') return send(res, 200, await fundState());
    await flushDue();
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    const stats = await readStats(playerId);
    const isOwner = Number(stats.owner) >= 1;

    // Pour le créateur seulement : combien de suggestions sont arrivées depuis la dernière qu'il a vue (« since », l'heure
    // de celle-ci, gardée par son navigateur) et l'heure de la plus récente. Sert au point rouge sur l'ampoule.
    if (body.action === 'peek') {
      if (!isOwner) return send(res, 200, { owner: false });
      const since = Number(body.since) || 0;
      const [fresh, last] = await redis([['ZCOUNT', 'sugg:all', since + 1, '+inf'], ['ZREVRANGE', 'sugg:all', 0, 0]]);
      const [t] = last && last.length ? await redis([['HGET', suggKey(last[0]), 't']]) : [0];
      return send(res, 200, { owner: true, fresh: Number(fresh) || 0, latest: Number(t) || 0 });
    }

    if (body.action === 'mine') {
      const [ids] = await redis([['ZREVRANGE', byPlayer(playerId), 0, 19]]);
      return send(res, 200, { owner: isOwner, mine: (await listSuggestions(ids || [])).map(({ name, ...x }) => x), max: SUGG_MAX, perDay: SUGG_PER_DAY });
    }

    if (body.action === 'suggest') {
      const text = cleanText(body.text, SUGG_MAX);
      const name = cleanName(body.name);
      if (!name) return send(res, 400, { error: 'Pick a player name first' });
      if (text.length < SUGG_MIN) return send(res, 422, { error: 'Write a few words first' });
      const day = dayKey(Date.now());
      const [count] = await redis([['INCR', `sugg:rate:${day}:${playerId}`], ['EXPIRE', `sugg:rate:${day}:${playerId}`, 2 * 86400]]);
      if (Number(count) > SUGG_PER_DAY) return send(res, 429, { error: `You can send ${SUGG_PER_DAY} suggestions a day: come back tomorrow` });
      const id = crypto.randomBytes(6).toString('hex'), t = Date.now();
      await redis([
        ['HSET', suggKey(id), 't', t, 'pid', playerId, 'name', name, 'text', text, 'status', 'new', 'lang', body.lang === 'fr' ? 'fr' : 'en'],
        ['ZADD', 'sugg:all', t, id],
        ['ZADD', byPlayer(playerId), t, id],
      ]);
      const [ids] = await redis([['ZREVRANGE', byPlayer(playerId), 0, 19]]);
      return send(res, 200, { owner: isOwner, mine: (await listSuggestions(ids || [])).map(({ name: n, ...x }) => x), max: SUGG_MAX, perDay: SUGG_PER_DAY, sent: true });
    }

    // ------------------------------------------------------------ réservé au créateur du site
    if (!['inbox', 'mark', 'delete', 'stats', 'insights', 'fund', 'fundAdd', 'fundSet', 'fundAssign'].includes(body.action)) return send(res, 400, { error: 'Unknown action' });
    if (!isOwner) return send(res, 403, { error: 'Owner only' });
    const id = String(body.id || '');
    if (body.action === 'mark' || body.action === 'delete') {
      if (!/^[0-9a-f]{12}$/.test(id)) return send(res, 400, { error: 'Unknown suggestion' });
      const [pid] = await redis([['HGET', suggKey(id), 'pid']]);
      if (!pid) return send(res, 404, { error: 'Unknown suggestion' });
      if (body.action === 'delete') await redis([['DEL', suggKey(id)], ['ZREM', 'sugg:all', id], ['ZREM', byPlayer(pid), id]]);
      else {
        const writes = [];
        if (STATUSES.includes(body.status)) writes.push(['HSET', suggKey(id), 'status', body.status]);
        if (typeof body.reply === 'string') writes.push(['HSET', suggKey(id), 'reply', cleanText(body.reply, REPLY_MAX)]);
        if (writes.length) await redis(writes);
      }
    }
    if (body.action === 'stats') return send(res, 200, await siteStats());
    if (body.action === 'insights') return send(res, 200, await insights());
    if (body.action === 'fundSet') {
      const writes = [];
      const goal = Math.round(Number(body.goal) * 100);
      if (Number.isFinite(goal) && goal >= 100 && goal <= 1000000) writes.push(['HSET', FUND_CFG, 'goal', goal]);
      if (typeof body.url === 'string') writes.push(body.url.trim() ? (safeUrl(body.url) ? ['HSET', FUND_CFG, 'url', safeUrl(body.url)] : null) : ['HDEL', FUND_CFG, 'url']);
      if (writes.includes(null)) return send(res, 422, { error: 'The link must start with https://' });
      if (writes.length) await redis(writes);
    }
    if (body.action === 'fundAdd') {
      // Montant en euros, positif pour une contribution, négatif pour corriger une erreur de saisie.
      const cents = Math.round(Number(body.euros) * 100);
      if (!Number.isFinite(cents) || !cents || Math.abs(cents) > 100000) return send(res, 422, { error: 'Amount between 0.01 and 1,000 euros' });
      const who = cleanName(body.name);
      const target = who ? await findPlayer(who) : null;
      if (!target) return send(res, 404, { error: 'No player with this name' });
      await creditFund({ target, name: who, cents });
    }
    // Contribution arrivée toute seule mais sans pseudo reconnu : le créateur dit à qui elle revient (le montant est
    // déjà dans le total du mois), ou la classe sans suite.
    if (body.action === 'fundAssign') {
      const [raw] = await redis([['HGET', FUND_PENDING, String(body.tx || '')]]);
      if (!raw) return send(res, 404, { error: 'This contribution is no longer waiting' });
      const item = JSON.parse(raw);
      if (!body.dismiss) {
        const who = cleanName(body.name), target = who ? await findPlayer(who) : null;
        if (!target) return send(res, 404, { error: 'No player with this name' });
        await creditFund({ target, name: who, cents: item.cents, counted: true, auto: true });
      }
      // Un faux don (le test de Ko-fi) : retiré aussi du total du mois où il avait été compté.
      if (body.dismiss && body.remove) { const mo = monthKey(item.t); await redis([['HINCRBY', fundKey(mo), 'cents', -item.cents], ['HINCRBY', fundKey(mo), 'count', -1]]); }
      await redis([['HDEL', FUND_PENDING, String(body.tx)]]);
    }
    if (['fund', 'fundAdd', 'fundSet', 'fundAssign'].includes(body.action)) {
      const [raw, waiting] = await redis([['ZREVRANGE', FUND_LOG, 0, 49], ['HVALS', FUND_PENDING]]);
      const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
      const totals = await redis(months.map(mo => ['HGETALL', fundKey(mo)]));
      return send(res, 200, { ...(await fundState()), auto: !!process.env.KOFI_TOKEN, pending: (waiting || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t), log: (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean), months: months.map((mo, i) => ({ month: mo, cents: Number(toObject(totals[i]).cents) || 0, count: Number(toObject(totals[i]).count) || 0 })) });
    }
    const [ids, total] = await redis([['ZREVRANGE', 'sugg:all', 0, INBOX_MAX - 1], ['ZCARD', 'sugg:all']]);
    return send(res, 200, { suggestions: await listSuggestions(ids || []), total: Number(total) || 0 });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
