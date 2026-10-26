// Photos de profil (demandé par Sacha, 2026-10-26 ; idée de kingston et JAKECisthebest) : un joueur envoie une image,
// personne d'autre ne la voit tant que le créateur ne l'a pas acceptée sur la page Owner (onglet Avatars).
// Les joueurs sont surtout des enfants : tout passe par la file de validation, rien n'est publié automatiquement.
//
// Le navigateur recadre l'image en carré 256×256 et la réencode en JPEG sur un canvas (ce qui enlève EXIF, GPS…) ;
// ici on n'accepte qu'un vrai JPEG (octets magiques, segments lus), sans bloc EXIF, de 60 Ko au plus.
//
// Redis (en mémoire sur le VPS : on garde peu de chose) :
//   avp:<id>    en attente : { img (base64), t, pk }   (une seule par joueur ; un nouvel envoi la remplace)
//   avpq        hash pk → id : la file du créateur (pk = jeton opaque, l'identifiant ne sort jamais)
//   av:<id>     acceptée : { img, v, tok, t }          v = version (cache), tok = jeton public de l'image
//   avpub       hash id → tok ;  avtok : hash tok → id  (les images se servent par jeton, jamais par identifiant)
//   avr:<id>    dernier refus { reason, t } (30 jours) ;  avn:<id>:<jour> envois du jour ;  avlog : 200 dernières décisions
const crypto = require('node:crypto');
const { redis, ownsPlayer, readStats, dayKey, cleanName, findPlayer, send } = require('./_lib');
const Reports = require('./_reports');

const MAX_BYTES = 60 * 1024, PER_DAY = 5, MIN_ROLLS = 30, LOG_KEEP = 200, MAX_SIDE = 512;
const REASONS = {
  inappropriate: 'inappropriate',
  personal: 'personal info / real face',
  brand: 'brand or copyright',
  quality: 'low quality',
  other: 'not allowed',
};
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const isTok = t => /^[0-9a-f]{20}$/.test(String(t || ''));
const refuse = (status, error) => Object.assign(new Error(error), { status });
const parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
const url = (tok) => `/api/profile?avatar=${tok}`;

// Vérifie un JPEG : début FFD8, segments bien formés jusqu'au SOF (dimensions), pas d'APP1 (EXIF/XMP), fin FFD9.
// Renvoie le Buffer ou null.
function checkJpeg(raw) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(raw || ''));
  if (!m || m[1].length > Math.ceil(MAX_BYTES / 3) * 4 + 4) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 200 || buf.length > MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return null;
  let i = 2, size = null;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const mk = buf[i + 1];
    if (mk === 0xff) { i++; continue; }
    if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (mk === 0xe1) return null; // EXIF / XMP : le canvas n'en met pas, on refuse ce qui n'est pas passé par lui
    if ((mk >= 0xc0 && mk <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(mk)) { size = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; break; }
    if (mk === 0xda) break; // données d'image avant tout SOF : invalide
    i += 2 + len;
  }
  if (!size || !size.w || size.w !== size.h || size.w > MAX_SIDE) return null;
  return buf;
}

// Carte publique nom → jeton des avatars acceptés (gardée 30 s en mémoire) : le site s'en sert pour savoir qui en a un.
let mapCache = null;
async function publicMap() {
  if (mapCache && Date.now() - mapCache.at < 30000) return mapCache.map;
  const [flat] = await redis([['HGETALL', 'avpub']]);
  const ids = [], toks = [];
  for (let i = 0; i < (flat || []).length; i += 2) { ids.push(flat[i]); toks.push(flat[i + 1]); }
  const [names] = ids.length ? await redis([['HMGET', 'names', ...ids]]) : [[]];
  const map = {};
  ids.forEach((id, k) => { if (names[k]) map[names[k]] = toks[k]; });
  mapCache = { at: Date.now(), map };
  return map;
}
const resetCache = () => { mapCache = null; };

// GET /api/profile?avatar=<jeton>  → l'image (cache long : le jeton change à chaque nouvelle version)
// GET /api/profile?avatars=1        → { map: { nom: jeton } }
async function serve(req, res, params) {
  if (params.get('avatars') === '1') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store'); // déjà gardée 30 s ici : une image acceptée apparaît vite
    return res.end(JSON.stringify({ map: await publicMap() }));
  }
  const tok = params.get('avatar');
  const notFound = () => { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end('{"error":"No avatar"}'); };
  if (!isTok(tok)) return notFound();
  const [id] = await redis([['HGET', 'avtok', tok]]);
  if (!id) return notFound();
  const [raw] = await redis([['GET', `av:${id}`]]);
  const a = parse(raw);
  if (!a || a.tok !== tok) return notFound();
  const buf = Buffer.from(a.img, 'base64');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(buf);
}

async function log(action, id, extra = {}) {
  const [name] = await redis([['HGET', 'names', id]]);
  await redis([['RPUSH', 'avlog', JSON.stringify({ t: Date.now(), action, name: name || 'Player', ...extra })], ['LTRIM', 'avlog', -LOG_KEEP, -1]]);
}

async function mine(id) {
  const day = dayKey(Date.now());
  const [p, a, r, n] = await redis([['GET', `avp:${id}`], ['GET', `av:${id}`], ['GET', `avr:${id}`], ['GET', `avn:${id}:${day}`]]);
  const pend = parse(p), appr = parse(a), rej = parse(r);
  return {
    pending: pend ? { img: `data:image/jpeg;base64,${pend.img}`, t: pend.t } : null,
    approved: appr ? { url: url(appr.tok), t: appr.t } : null,
    rejected: rej && (!appr || rej.t >= appr.t) && (!pend || rej.t >= pend.t) ? { reason: rej.reason, t: rej.t } : null,
    left: Math.max(0, PER_DAY - (Number(n) || 0)), minRolls: MIN_ROLLS,
  };
}

async function upload(id, stats, img) {
  const buf = checkJpeg(img);
  if (!buf) throw refuse(422, 'The picture must be a square JPEG under 60 KB');
  const [name] = await redis([['HGET', 'names', id]]);
  if (!name) throw refuse(403, 'Choose a player name first');
  if ((Number(stats.rolls) || 0) < MIN_ROLLS) throw refuse(403, `You need ${MIN_ROLLS} rolls to add a profile picture`);
  const day = dayKey(Date.now());
  const [n] = await redis([['INCR', `avn:${id}:${day}`], ['EXPIRE', `avn:${id}:${day}`, 2 * 86400]]);
  if (Number(n) > PER_DAY) throw refuse(429, 'Too many pictures today, try again tomorrow');
  const [old] = await redis([['GET', `avp:${id}`]]);
  const prev = parse(old);
  const pk = crypto.randomBytes(10).toString('hex');
  await redis([
    ...(prev ? [['HDEL', 'avpq', prev.pk]] : []),
    ['SET', `avp:${id}`, JSON.stringify({ img: buf.toString('base64'), t: Date.now(), pk })],
    ['HSET', 'avpq', pk, id],
  ]);
}

async function queue(q) {
  const [flat, rawLog, pubFlat] = await redis([['HGETALL', 'avpq'], ['LRANGE', 'avlog', -LOG_KEEP, -1], ['HGETALL', 'avpub']]);
  const pending = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    const pk = flat[i], id = flat[i + 1];
    const [p, a, nm] = await redis([['GET', `avp:${id}`], ['GET', `av:${id}`], ['HGET', 'names', id]]);
    const pend = parse(p), appr = parse(a);
    if (!pend || pend.pk !== pk) { await redis([['HDEL', 'avpq', pk]]); continue; }
    pending.push({ key: pk, name: nm || 'Player', img: `data:image/jpeg;base64,${pend.img}`, t: pend.t, prev: appr ? url(appr.tok) : null });
  }
  pending.sort((a, b) => a.t - b.t); // le plus ancien d'abord
  const ids = [], toks = [];
  for (let i = 0; i < (pubFlat || []).length; i += 2) { ids.push(pubFlat[i]); toks.push(pubFlat[i + 1]); }
  const [names] = ids.length ? await redis([['HMGET', 'names', ...ids]]) : [[]];
  const needle = String(q || '').toLowerCase();
  const approved = ids.map((id, k) => ({ name: names[k] || 'Player', url: url(toks[k]) }))
    .filter(x => !needle || x.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  return { pending, approved, total: ids.length, log: (rawLog || []).map(parse).filter(Boolean).reverse(), reasons: REASONS };
}

async function decide(op, body) {
  const pk = String(body.key || '');
  const [id] = /^[0-9a-f]{20}$/.test(pk) ? await redis([['HGET', 'avpq', pk]]) : [null];
  if (!id) throw refuse(404, 'This picture is no longer waiting');
  const [p, a] = await redis([['GET', `avp:${id}`], ['GET', `av:${id}`]]);
  const pend = parse(p), appr = parse(a);
  if (!pend || pend.pk !== pk) { await redis([['HDEL', 'avpq', pk]]); throw refuse(404, 'This picture is no longer waiting'); }
  if (op === 'approve') {
    const tok = crypto.randomBytes(10).toString('hex'), v = (appr ? Number(appr.v) || 0 : 0) + 1;
    await redis([
      ['SET', `av:${id}`, JSON.stringify({ img: pend.img, v, tok, t: Date.now() })],
      ...(appr ? [['HDEL', 'avtok', appr.tok]] : []),
      ['HSET', 'avtok', tok, id], ['HSET', 'avpub', id, tok],
      ['DEL', `avp:${id}`], ['HDEL', 'avpq', pk], ['DEL', `avr:${id}`],
    ]);
    await log('approved', id, { v });
  } else {
    const code = Object.prototype.hasOwnProperty.call(REASONS, body.reason) ? body.reason : null;
    if (!code) throw refuse(422, 'Choose a reason');
    await redis([['DEL', `avp:${id}`], ['HDEL', 'avpq', pk], ['SET', `avr:${id}`, JSON.stringify({ reason: REASONS[code], t: Date.now() }), 'EX', 30 * 86400]]);
    await log('rejected', id, { reason: REASONS[code] });
  }
  resetCache();
}

async function removeApproved(name, reason) {
  const id = await findPlayer(cleanName(name));
  const [a] = id ? await redis([['GET', `av:${id}`]]) : [null];
  const appr = parse(a);
  if (!appr) throw refuse(404, 'No approved picture for this player');
  const code = Object.prototype.hasOwnProperty.call(REASONS, reason) ? reason : 'other';
  await redis([['DEL', `av:${id}`], ['HDEL', 'avpub', id], ['HDEL', 'avtok', appr.tok], ['SET', `avr:${id}`, JSON.stringify({ reason: REASONS[code], t: Date.now() }), 'EX', 30 * 86400]]);
  await log('removed', id, { reason: REASONS[code] });
  resetCache();
}

// POST /api/profile { action: 'avatar', op, playerId, secret, … }
async function handle(req, res) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const id = String(body.playerId || ''), secret = String(body.secret || '');
    if (!isPlayerId(id) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(id, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    const op = String(body.op || '');
    if (op === 'mine') return send(res, 200, await mine(id));
    const stats = await readStats(id);
    if (op === 'upload') { await upload(id, stats, body.img); return send(res, 200, { ...(await mine(id)), sent: true }); }
    if (op === 'cancel') {
      const [p] = await redis([['GET', `avp:${id}`]]); const pend = parse(p);
      if (pend) await redis([['DEL', `avp:${id}`], ['HDEL', 'avpq', pend.pk]]);
      return send(res, 200, await mine(id));
    }
    if (op === 'report') {
      const author = await findPlayer(cleanName(body.name));
      const [a] = author ? await redis([['GET', `av:${author}`]]) : [null];
      const appr = parse(a);
      if (!appr) return send(res, 404, { error: 'No picture to report' });
      return send(res, 200, await Reports.fileReport({ reporter: id, author, text: 'Profile picture', where: 'avatar', msgT: appr.t }));
    }
    if (!(Number(stats.owner) >= 1)) return send(res, 403, { error: 'Owner only' }); // NaN quand le champ manque
    if (op === 'queue') return send(res, 200, await queue(body.q));
    if (op === 'approve' || op === 'reject') { await decide(op, body); return send(res, 200, await queue(body.q)); }
    if (op === 'remove') { await removeApproved(body.name, body.reason); return send(res, 200, await queue(body.q)); }
    return send(res, 400, { error: 'Unknown action' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
}

// Nombre d'images en attente, pour le badge de l'onglet du créateur.
async function pendingCount() { const [n] = await redis([['HLEN', 'avpq']]); return Number(n) || 0; }

module.exports = { handle, serve, checkJpeg, pendingCount, resetCache, REASONS };
