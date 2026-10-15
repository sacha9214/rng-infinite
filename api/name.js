// POST /api/name  { playerId, secret, name }
// Réserve un nom de joueur : un nom n'appartient qu'à un seul joueur (sans tenir compte des majuscules, accents,
// espaces ni ponctuation). Changer de nom libère l'ancien.
const { claimPlayer, claimName, cleanName, cors, send, redis, statsKey } = require('./_lib');
// Lien d'arrivée (?ref=…, par exemple ?ref=pechadophin pour la collab) : gardé par la page dès la première visite et
// envoyé avec le premier pseudo. Le joueur est alors compté pour cette source (page Owner > Traffic), une seule fois.
const SRC_MAX = 5000;
const srcTag = raw => { const v = String(raw || '').toLowerCase(); return /^[a-z0-9_.-]{1,30}$/.test(v) ? v : ''; };

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    const name = cleanName(body.name);
    if (!/^[0-9a-f]{16}$/.test(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!name) return send(res, 400, { error: 'Invalid name' });
    if (!(await claimPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    if (!(await claimName(playerId, name))) return send(res, 409, { error: 'This name is already taken' });
    const src = srcTag(body.src);
    if (src) {
      const [fresh, size] = await redis([['HSETNX', statsKey(playerId), 'src', src], ['SCARD', `srcp:${src}`]]);
      if (Number(fresh) === 1 && Number(size) < SRC_MAX) await redis([['SADD', `srcp:${src}`, playerId]]);
    }
    return send(res, 200, { name });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
