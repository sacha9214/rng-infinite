// POST /api/site { action, … } — ce qui concerne le site plutôt qu'une partie : boîte à suggestions et fréquentation.
//   visit                       (sans compte) compteurs anonymes du jour : visites, site d'origine, pays, appareil, langue
//   suggest  { text }           (joueur) envoie une suggestion
//   mine                        (joueur) ses suggestions, leur statut et la réponse éventuelle ; dit aussi s'il est Owner
//   inbox                       (Owner) toutes les suggestions
//   mark     { id, status, reply }   (Owner) change le statut et/ou répond     · delete { id } (Owner) supprime
//   stats                       (Owner) fréquentation des 30 derniers jours
// Fréquentation : uniquement des compteurs agrégés par jour (an:<jour>), sans identifiant, sans adresse IP, sans cookie.
const crypto = require('node:crypto');
const { redis, ownsPlayer, readStats, dayKey, cleanName, toObject, cors, send, flushDue } = require('./_lib');

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
const anKey = day => `an:${day}`;
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
  const fields = ['visits', `ref:${ref}`, `c:${country}`, `d:${body.mobile ? 'mobile' : 'desktop'}`, `l:${body.lang === 'fr' ? 'fr' : 'en'}`];
  if (body.daily) fields.push('uniq');
  if (body.first) fields.push('new');
  if (src) fields.push(`src:${src}`);
  // Un jour ne peut pas enfler sans fin (quelqu'un qui enverrait des milliers d'origines inventées) : passé 400 champs,
  // les origines inconnues vont dans « other ».
  const [size, ...known] = await redis([['HLEN', anKey(day)], ...fields.map(f => ['HEXISTS', anKey(day), f])]);
  const safe = fields.map((f, i) => (Number(known[i]) === 1 || Number(size) < AN_FIELDS_MAX || !/^(ref|src):/.test(f) ? f : `${f.split(':')[0]}:other`));
  await redis([...safe.map(f => ['HINCRBY', anKey(day), f, 1]), ['EXPIRE', anKey(day), AN_TTL]]);
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

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (body.action === 'visit') {
      await recordVisit(req, body);
      return send(res, 200, { ok: true });
    }
    await flushDue();
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    const stats = await readStats(playerId);
    const isOwner = Number(stats.owner) >= 1;

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
    if (!['inbox', 'mark', 'delete', 'stats'].includes(body.action)) return send(res, 400, { error: 'Unknown action' });
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
    const [ids, total] = await redis([['ZREVRANGE', 'sugg:all', 0, INBOX_MAX - 1], ['ZCARD', 'sugg:all']]);
    return send(res, 200, { suggestions: await listSuggestions(ids || []), total: Number(total) || 0 });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
