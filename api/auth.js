// POST /api/auth  { credential, playerId, secret }                      → connexion Google
// POST /api/auth  { action: 'setPassword', playerId, secret, password }   → mot de passe pour son pseudo
// POST /api/auth  { action: 'passwordLogin', name, password }             → se connecter avec pseudo + mot de passe
// POST /api/auth  { action: 'passwordState', playerId, secret }          → a-t-il déjà un mot de passe ?
// Connexion Google : relie le compte Google à un joueur et donne à cet appareil un secret pour tirer sous ce joueur.
// Le même compte Google retrouve donc son joueur (et ses places au classement) sur n'importe quel appareil.
const crypto = require('node:crypto');
const config = require('../js/config.js');
const { redis, ownsPlayer, findPlayer, cleanName, verifyGoogleToken, sha256, statsKey, OWNER_EMAIL_SHA256, VIEWER_EMAILS_SHA256, markFresh, grantGoogleBonus, cors, send, flushDue } = require('./_lib');

// ---------------------------------------------------------------- pseudo + mot de passe (2026-10-14)
// Pour retrouver son joueur sur un autre appareil sans Google. Le mot de passe n'est jamais gardé tel quel : seulement
// son empreinte scrypt avec un sel propre au joueur (player:<id>:pw = « s1$sel$empreinte »). Pas d'e-mail : un mot de
// passe oublié se règle avec le créateur. Essais ratés limités par joueur et par adresse, 15 min.
const PW_MIN = 8, PW_MAX = 100, FAIL_MAX = 8, IP_MAX = 30, FAIL_WINDOW_S = 900;
const pwKey = id => `player:${id}:pw`;
const scrypt = (pw, salt) => new Promise((ok, ko) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? ko(e) : ok(k))));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); return `s1$${salt.toString('hex')}$${(await scrypt(pw, salt)).toString('hex')}`; }
async function checkPassword(pw, stored) {
  const [v, salt, hash] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const got = await scrypt(pw, Buffer.from(salt, 'hex')), want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
async function passwords(req, body) {
  const pw = typeof body.password === 'string' ? body.password : '';
  if (body.action === 'passwordState' || body.action === 'setPassword') {
    const playerId = String(body.playerId || ''), secret = String(body.secret || '');
    if (!/^[0-9a-f]{16}$/.test(playerId) || !/^[0-9a-f]{32}$/.test(secret) || !(await ownsPlayer(playerId, secret))) return [403, { error: 'This player id belongs to someone else' }];
    if (body.action === 'passwordState') { const [has] = await redis([['EXISTS', pwKey(playerId)]]); return [200, { has: Number(has) === 1 }]; }
    const [name] = await redis([['HGET', 'names', playerId]]);
    if (!name) return [422, { error: 'Pick a player name first' }];
    if (pw.length < PW_MIN || pw.length > PW_MAX) return [422, { error: `Use ${PW_MIN} to ${PW_MAX} characters` }];
    if (pw.toLowerCase() === String(name).toLowerCase()) return [422, { error: 'Your password cannot be your name' }];
    await redis([['SET', pwKey(playerId), await hashPassword(pw)]]);
    return [200, { has: true, name }];
  }
  // Connexion : même réponse que le pseudo existe ou non, pour ne rien apprendre à celui qui devine.
  const ip = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim() || 'unknown';
  const [ipFails] = await redis([['GET', `pwip:${ip}`]]);
  if (Number(ipFails) >= IP_MAX) return [429, { error: 'Too many tries: wait 15 minutes' }];
  const wrong = async id => { await redis([['INCR', `pwip:${ip}`], ['EXPIRE', `pwip:${ip}`, FAIL_WINDOW_S], ...(id ? [['INCR', `pwfail:${id}`], ['EXPIRE', `pwfail:${id}`, FAIL_WINDOW_S]] : [])]); return [401, { error: 'Wrong name or password' }]; };
  const name = cleanName(body.name), playerId = name ? await findPlayer(name) : null;
  if (!playerId || !pw) return wrong(null);
  const [stored, fails] = await redis([['GET', pwKey(playerId)], ['GET', `pwfail:${playerId}`]]);
  if (Number(fails) >= FAIL_MAX) return [429, { error: 'Too many tries on this player: wait 15 minutes' }];
  if (!stored || !(await checkPassword(pw, stored))) return wrong(playerId);
  const secret = crypto.randomBytes(16).toString('hex');
  const [, real] = await redis([['SADD', `player:${playerId}:secrets`, sha256(secret)], ['HGET', 'names', playerId], ['DEL', `pwfail:${playerId}`]]);
  return [200, { playerId, secret, name: real || name }];
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  {
    const early = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (['setPassword', 'passwordLogin', 'passwordState'].includes(early.action)) {
      try { const [status, out] = await passwords(req, early); return send(res, status, out); } catch (err) { return send(res, err.status || 500, { error: err.message }); }
    }
  }
  if (!config.googleClientId) return send(res, 503, { error: 'Google sign-in is not configured' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    let google;
    try {
      google = await verifyGoogleToken(body.credential || '', config.googleClientId);
    } catch (err) {
      return send(res, 401, { error: 'Invalid Google sign-in' });
    }

    const accountKey = `google:${google.sub}`;
    let [playerId] = await redis([['GET', accountKey]]);

    if (!playerId) {
      // Premier passage de ce compte : il reprend le joueur de cet appareil si l'appareil le possède bien
      // et qu'aucun autre compte Google ne l'a déjà pris ; sinon il reçoit un joueur neuf.
      let candidate = null;
      const deviceId = /^[0-9a-f]{16}$/.test(body.playerId || '') ? body.playerId : null;
      const deviceSecret = /^[0-9a-f]{32}$/.test(body.secret || '') ? body.secret : null;
      if (deviceId && deviceSecret) {
        const hash = sha256(deviceSecret);
        const [owner, member, linked] = await redis([
          ['GET', `player:${deviceId}:secret`],
          ['SISMEMBER', `player:${deviceId}:secrets`, hash],
          ['GET', `player:${deviceId}:google`],
        ]);
        const owns = owner === null || owner === hash || Number(member) === 1;
        if (owns && linked === null) candidate = deviceId;
      }
      candidate = candidate || crypto.randomBytes(8).toString('hex');
      const [, winner] = await redis([
        ['SET', accountKey, candidate, 'NX'],
        ['GET', accountKey],
        ['SET', `player:${candidate}:google`, google.sub, 'NX'],
      ]);
      playerId = winner;
      await markFresh(playerId); // joueur neuf (sans historique) : pas de reconstruction à tromper
    }

    // Collab Canne & Dauphins : ce compte Google joue aussi au jeu de Firetail (api/site.js, action « collab ») → skin Fisherman.
    const [fisher] = await redis([['SISMEMBER', 'collab:pechadophin:subs', google.sub]]);
    if (Number(fisher) === 1) await redis([['HSET', statsKey(playerId), 'collabFish', 1]]);

    // Un secret par appareil connecté : tous restent valides pour ce joueur.
    const secret = crypto.randomBytes(16).toString('hex');
    const writes = [
      ['SADD', `player:${playerId}:secrets`, sha256(secret)],
      ['HGET', 'names', playerId],
    ];
    // Le créateur du site (e-mail vérifié par Google) débloque le titre Owner ; l'e-mail n'est comparé qu'en mémoire.
    const email = String(google.email || '').trim().toLowerCase();
    if (google.email_verified && email && sha256(email) === OWNER_EMAIL_SHA256) writes.push(['HSET', statsKey(playerId), 'owner', 1]);
    // Invité de la page Owner (lecture seule) : on garde l'empreinte, pour pouvoir retirer l'accès plus tard. Il reçoit
    // aussi le titre Manager.
    if (google.email_verified && email && VIEWER_EMAILS_SHA256.has(sha256(email))) writes.push(['HSET', statsKey(playerId), 'viewer', sha256(email)], ['HSET', statsKey(playerId), 'manager', 1]);
    const [, name] = await redis(writes);
    // 150 pièces la première fois que ce joueur a un compte Google (rien les fois suivantes, ni sur un autre appareil).
    const bonus = await grantGoogleBonus(playerId);

    return send(res, 200, {
      playerId,
      secret,
      name: name || null,
      email: google.email || null,
      givenName: google.given_name || null,
      bonus,
    });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
