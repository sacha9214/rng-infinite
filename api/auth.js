// POST /api/auth  { credential, playerId, secret }
// Connexion Google : relie le compte Google à un joueur et donne à cet appareil un secret pour tirer sous ce joueur.
// Le même compte Google retrouve donc son joueur (et ses places au classement) sur n'importe quel appareil.
const crypto = require('node:crypto');
const config = require('../js/config.js');
const { redis, verifyGoogleToken, sha256, statsKey, OWNER_EMAIL_SHA256, markFresh, grantGoogleBonus, cors, send, flushDue } = require('./_lib');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
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

    // Un secret par appareil connecté : tous restent valides pour ce joueur.
    const secret = crypto.randomBytes(16).toString('hex');
    const writes = [
      ['SADD', `player:${playerId}:secrets`, sha256(secret)],
      ['HGET', 'names', playerId],
    ];
    // Le créateur du site (e-mail vérifié par Google) débloque le titre Owner ; l'e-mail n'est comparé qu'en mémoire.
    const email = String(google.email || '').trim().toLowerCase();
    if (google.email_verified && email && sha256(email) === OWNER_EMAIL_SHA256) writes.push(['HSET', statsKey(playerId), 'owner', 1]);
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
