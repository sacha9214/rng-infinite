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
const { redis, ownsPlayer, readStats, dayKey, cleanName, toObject, cors, send, flushDue, statsKey, SEEN_KEY, findPlayer, nameKey, actKey, ACT_TTL, historyKey, VIEWER_EMAILS_SHA256 } = require('./_lib');
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

// ---------------------------------------------------------------- activité et rétention
// Qui a joué quel jour : act:<jour> (identifiant → tirages), tenu à jour à chaque tirage depuis le 2026-10-11. Les
// jours d'avant sont reconstruits une seule fois depuis l'historique des joueurs (qui garde chaque tirage et son heure).
const ACT_DAYS = 90, ACT_DONE = 'act:backfill', ACT_LOCK = 'act:lock';
const dayStart = day => Date.parse(`${day}T00:00:00Z`);
const chunked = async (commands, size = 800) => { const out = []; for (let i = 0; i < commands.length; i += size) out.push(...(await redis(commands.slice(i, i + size)))); return out; };
async function backfillActivity(ids, now) {
  const [done] = await redis([['GET', ACT_DONE]]);
  if (done || !ids.length) return false;
  const [lock] = await redis([['SET', ACT_LOCK, '1', 'NX', 'EX', 300]]);
  if (lock !== 'OK') return false;
  const firsts = (await chunked(ids.map(id => ['ZRANGE', historyKey(id), 0, 0, 'WITHSCORES']))).map(r => (r && r.length >= 2 ? Number(r[1]) : 0));
  const oldest = dayStart(dayKey(now - (ACT_DAYS - 1) * DAY_MS)), today = dayStart(dayKey(now));
  const asks = [];
  ids.forEach((id, i) => { if (firsts[i]) for (let t = Math.max(oldest, dayStart(dayKey(firsts[i]))); t <= today; t += DAY_MS) asks.push([id, t]); });
  const counts = await chunked(asks.map(([id, t]) => ['ZCOUNT', historyKey(id), t, t + DAY_MS - 1]));
  const writes = [], touched = new Set();
  asks.forEach(([id, t], i) => { if (Number(counts[i]) > 0) { writes.push(['HSET', actKey(dayKey(t)), id, Number(counts[i])]); touched.add(dayKey(t)); } });
  ids.forEach((id, i) => { if (firsts[i]) writes.push(['HSETNX', statsKey(id), 'first', firsts[i]]); });
  for (const d of touched) writes.push(['EXPIRE', actKey(d), ACT_TTL]);
  await chunked(writes);
  await redis([['SET', ACT_DONE, String(now)], ['DEL', ACT_LOCK]]);
  return true;
}

// Tout est calculé sur des jours UTC. « Jn » = le joueur a tiré exactement n jours après son premier jour ; le jour
// en cours, incomplet, ne compte jamais comme un jour de retour manqué.
const RET_STEPS = [1, 2, 3, 4, 5, 6, 7, 14, 30];
function retention(now, ids, names, stats, linked, act) {
  const days = act.map(a => a.day), index = new Map(days.map((d, i) => [d, i]));
  const played = new Map(ids.map(id => [id, []])); // identifiant → index des jours joués (0 = aujourd'hui), croissant
  act.forEach((a, i) => { for (const id of Object.keys(a.h)) if (played.has(id)) played.get(id).push(i); });
  const rate = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  const people = ids.map((id, i) => {
    const st = stats[i], mine = played.get(id), firstDay = num(st.first) ? dayKey(num(st.first)) : mine.length ? days[mine[mine.length - 1]] : '';
    // Premier jour : son index dans la fenêtre, ou -1 s'il est plus ancien (ou inconnu).
    return { id, name: names[i] || 'Player', st, mine, set: new Set(mine), first: index.has(firstDay) ? index.get(firstDay) : -1, last: mine.length ? mine[0] : -1, rolls: num(st.rolls), linked: !!linked[i] };
  }).filter(p => p.rolls > 0 || p.mine.length);
  // Jour par jour : actifs, nouveaux, revenus, tirages.
  const series = act.slice(0, 30).map((a, i) => {
    const active = Object.keys(a.h).length, fresh = people.filter(p => p.first === i).length;
    return { day: a.day, active, fresh, back: Math.max(0, active - fresh), rolls: Object.values(a.h).reduce((x, v) => x + num(v), 0) };
  });
  // Cohortes : les nouveaux d'un jour, et la part qui a joué n jours plus tard.
  const cohort = c => {
    const members = people.filter(p => p.first === c);
    return { day: days[c], size: members.length, cells: RET_STEPS.map(n => (c - n >= 1 ? { n, back: members.filter(p => p.set.has(c - n)).length } : { n, back: null })) };
  };
  const all = days.map((_, c) => cohort(c));
  const summary = RET_STEPS.map((n, k) => {
    const ready = all.filter(c => c.cells[k].back !== null && c.size);
    const size = ready.reduce((x, c) => x + c.size, 0), back = ready.reduce((x, c) => x + c.cells[k].back, 0);
    return { n, players: size, back, rate: rate(back, size) };
  });
  // Revenus au moins une fois : parmi ceux qui ont eu au moins un jour complet après leur premier jour.
  const mature = people.filter(p => p.first >= 2), returned = mature.filter(p => p.mine.some(i => i < p.first && i >= 1));
  const bucket = (list, value, edges) => edges.map(([a, b, name]) => ({ name, count: list.filter(p => value(p) >= a && value(p) <= b).length }));
  const distinct = (from, to) => people.filter(p => p.mine.some(i => i >= from && i <= to)).length;
  const mean = (from, to) => series.slice(from, to + 1).reduce((x, d) => x + d.active, 0) / Math.max(1, Math.min(series.length - 1, to) - from + 1);
  const sum = (k, from, to) => series.slice(from, to + 1).reduce((x, d) => x + d[k], 0);
  const mau = distinct(0, 29), dauAvg = mean(1, 7);
  // Parcours des nouveaux des 30 derniers jours, et ce que tous les joueurs ont déjà fait au moins une fois.
  const STEPS = [
    ['Rolled at least once', () => true], ['10 rolls or more', p => p.rolls >= 10], ['30 rolls (casino unlocked)', p => p.rolls >= 30],
    ['Played on 2 different days', p => p.mine.length >= 2], ['100 rolls or more', p => p.rolls >= 100], ['Played on 7 different days', p => p.mine.length >= 7],
  ];
  const FEATURES = [
    ['Claimed a daily quest', p => num(p.st.questsDone) > 0], ['Spent coins in the shop', p => num(p.st.spent) > 0], ['Played a duel', p => num(p.st.duels) > 0],
    ['Gambled in the casino', p => num(p.st.gBet) > 0], ['Linked a Google account', p => p.linked], ['Opened a case', p => num(p.st.cases) > 0],
    ['Bought a speed upgrade', p => num(p.st.speedLv) > 0], ['Supported the server', p => num(p.st.supporter) > 0],
  ];
  const newcomers = people.filter(p => p.first >= 0 && p.first <= 29);
  const row = p => ({ name: p.name, days: p.mine.filter(i => i <= 29).length, ago: p.last, rolls: p.rolls });
  return {
    since: days[days.length - 1], steps: RET_STEPS, series,
    active: { today: series[0].active, yesterday: series[1] ? series[1].active : 0, week: distinct(0, 6), month: mau, dauAvg: Math.round(dauAvg * 10) / 10, dauPrev: Math.round(mean(8, 14) * 10) / 10, stickiness: rate(dauAvg, mau) },
    fresh: { week: sum('fresh', 0, 6), prev: sum('fresh', 7, 13), month: sum('fresh', 0, 29) },
    rolls: { week: sum('rolls', 0, 6), prev: sum('rolls', 7, 13) },
    summary, cameBack: { players: mature.length, back: returned.length, rate: rate(returned.length, mature.length) },
    cohorts: all.slice(0, 21),
    daysPlayed: bucket(people.filter(p => p.mine.length), p => p.mine.filter(i => i <= 29).length, [[1, 1, '1 day'], [2, 3, '2–3 days'], [4, 7, '4–7 days'], [8, 14, '8–14 days'], [15, 30, '15+ days']]),
    status: bucket(people, p => (p.last < 0 ? 999 : p.last), [[0, 0, 'Played today'], [1, 2, 'Active (1–2 days ago)'], [3, 6, 'Cooling off (3–6 days)'], [7, 13, 'At risk (7–13 days)'], [14, 29, 'Dormant (14–29 days)'], [30, 999, 'Gone (30+ days)']]),
    funnel: STEPS.map(([name, test]) => ({ name, count: newcomers.filter(test).length })),
    features: FEATURES.map(([name, test]) => ({ name, count: people.filter(test).length, fresh: newcomers.filter(test).length })),
    base: { players: people.length, newcomers: newcomers.length },
    quiet: people.filter(p => p.mine.length >= 4 && p.last >= 3 && p.last <= 20).sort((a, b) => b.mine.length - a.mine.length || a.last - b.last).slice(0, 10).map(row),
    loyal: people.filter(p => p.mine.length >= 2).sort((a, b) => b.mine.filter(i => i <= 29).length - a.mine.filter(i => i <= 29).length || b.rolls - a.rolls).slice(0, 10).map(row),
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
  await backfillActivity(ids, now);
  const linked = [];
  for (let i = 0; i < ids.length; i += 200) (await redis(ids.slice(i, i + 200).flatMap(id => [['HGETALL', statsKey(id)], ['EXISTS', `player:${id}:google`]]))).forEach((r, k) => (k % 2 ? linked.push(Number(r) === 1) : stats.push(toObject(r))));
  const actDays = Array.from({ length: ACT_DAYS }, (_, i) => dayKey(now - i * DAY_MS));
  const act = (await redis(actDays.map(d => ['HGETALL', actKey(d)]))).map((flat, i) => ({ day: actDays[i], h: toObject(flat) }));
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
    retention: retention(now, ids, names, stats, linked, act),
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
// Prudence : un mot d'une phrase ordinaire (« très bon jeu ») peut être le pseudo de quelqu'un d'autre. Un pseudo
// n'est donc reconnu que dans quatre cas : le message entier est un pseudo ; il suit un libellé (« pseudo : X »,
// « my name is X ») ; le message est très court (deux mots au plus : « gg alice ») ; ou le nom du compte Ko-fi est
// un pseudo. Le créateur du jeu n'est jamais reconnu : « nice game sacha » s'adresse à lui, ce n'est pas son don.
// Tout le reste attend que le créateur tranche.
async function matchPlayer(message, fromName) {
  const text = String(message || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  const words = text.split(/[\s,;:!?()"'«».]+/).filter(w => w.length >= 2 && w.length <= 20);
  const tries = [text];
  const label = text.match(/(?:pseudo|player name|username|in[- ]?game name|ign|name|nom|je suis|i am|i'm|my name is|c'est|it's|its)\s*(?:is|est)?\s*[:=\-]?\s*(.+)$/i);
  if (label) { const rest = label[1].trim(), w = rest.split(/[\s,;.!?()]+/).filter(Boolean); tries.push(rest, w.slice(0, 2).join(' '), w[0] || ''); }
  if (words.length <= 2) tries.push(...words);
  tries.push(String(fromName || ''));
  const seen = new Set();
  for (const raw of tries) {
    const name = cleanName(raw);
    if (!name || seen.has(nameKey(name)) || seen.size >= 20) continue;
    seen.add(nameKey(name));
    const [id] = await redis([['GET', `name:${nameKey(name)}`]]);
    if (!id) continue;
    const [real, owner] = await redis([['HGET', 'names', id], ['HGET', statsKey(id), 'owner']]);
    if (Number(owner) >= 1) continue; // le créateur : jamais attribué tout seul
    return { target: id, name: real || name };
  }
  return null;
}
async function kofiWebhook(req) {
  // Espaces, retours à la ligne ou guillemets collés par mégarde avec le jeton dans les réglages : ignorés.
  // Espaces, retours à la ligne ou guillemets collés par mégarde avec le jeton dans les réglages : ignorés. Le jeton
  // de Ko-fi est un identifiant de 36 caractères (8-4-4-4-12) : s'il y en a un dans la valeur, c'est lui qui compte,
  // même entouré d'un libellé collé avec (« KOFI_TOKEN: … »).
  const rawToken = String(process.env.KOFI_TOKEN || '').trim().replace(/^["']|["']$/g, '').trim();
  const uuid = rawToken.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const token = uuid ? uuid[0] : rawToken;
  if (!token) return [503, { error: 'Automatic contributions are not configured' }];
  let data;
  try {
    const body = req.body;
    const raw = typeof body === 'string' ? (new URLSearchParams(body).get('data') || body) : body && body.data !== undefined ? body.data : body;
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) { return [400, { error: 'Unreadable message' }]; }
  const given = Buffer.from(String((data && data.verification_token) || '').trim()), expected = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    // Pour comprendre un refus sans jamais écrire de secret : seulement la forme du message et la longueur des deux jetons.
    console.warn(`kofi 401: body=${typeof req.body}${req.body && typeof req.body === 'object' ? ' keys=' + Object.keys(req.body).slice(0, 6).join(',') : ''} type=${String(req.headers['content-type'] || '').slice(0, 50)} fields=${data && typeof data === 'object' ? Object.keys(data).slice(0, 5).join(',') : typeof data} given=${given.length} expected=${expected.length}`);
    return [401, { error: 'Wrong token' }];
  }
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
    // Invité : il voit tout ce que voit le créateur sur sa page, sans pouvoir rien modifier.
    const isViewer = !isOwner && !!stats.viewer && VIEWER_EMAILS_SHA256.has(stats.viewer), canSee = isOwner || isViewer;

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
      return send(res, 200, { owner: isOwner, viewer: isViewer, mine: (await listSuggestions(ids || [])).map(({ name, ...x }) => x), max: SUGG_MAX, perDay: SUGG_PER_DAY });
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
      return send(res, 200, { owner: isOwner, viewer: isViewer, mine: (await listSuggestions(ids || [])).map(({ name: n, ...x }) => x), max: SUGG_MAX, perDay: SUGG_PER_DAY, sent: true });
    }

    // ------------------------------------------------------------ réservé au créateur du site
    if (!['inbox', 'mark', 'delete', 'stats', 'insights', 'fund', 'fundAdd', 'fundSet', 'fundAssign'].includes(body.action)) return send(res, 400, { error: 'Unknown action' });
    if (!(['inbox', 'stats', 'insights', 'fund'].includes(body.action) ? canSee : isOwner)) return send(res, 403, { error: 'Owner only' });
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
    if (body.action === 'stats') return send(res, 200, { ...(await siteStats()), readOnly: !isOwner });
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
      return send(res, 200, { ...(await fundState()), readOnly: !isOwner, auto: !!process.env.KOFI_TOKEN || process.env.KOFI_RELAYED === '1', pending: (waiting || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t), log: (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean), months: months.map((mo, i) => ({ month: mo, cents: Number(toObject(totals[i]).cents) || 0, count: Number(toObject(totals[i]).count) || 0 })) });
    }
    const [ids, total] = await redis([['ZREVRANGE', 'sugg:all', 0, INBOX_MAX - 1], ['ZCARD', 'sugg:all']]);
    return send(res, 200, { suggestions: await listSuggestions(ids || []), total: Number(total) || 0, readOnly: !isOwner });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
