// POST /api/roll  { playerId, secret, name, nonce? }
// Le serveur tire le nombre (personne ne peut choisir son 1337), calcule l'XP avec le moteur du site,
// puis met à jour le meilleur tirage du joueur pour le jour, la semaine et tous les temps.
const crypto = require('node:crypto');
const { redis, cleanName, cors, send, claimPlayer, claimName, recordRoll, flushDue } = require('./_lib');

// Une révélation dure au moins ~10 s : 8 s minimum entre deux tirages ne gêne jamais un vrai joueur.
const COOLDOWN_MS = 8000;
// Réponse perdue en route (réseau lent, délai dépassé côté site) : le site redemande avec le même jeton et reçoit le
// tirage déjà fait, au lieu d'un refus ou d'un second tirage. Sans ça, il tirait un nombre en local, qui ne compte
// nulle part mais s'ajoutait à son XP affiché.
const NONCE_TTL_S = 120;
const nonceKey = (id, nonce) => `rr:${id}:${nonce}`;

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    const name = cleanName(body.name);
    if (!/^[0-9a-f]{16}$/.test(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!name) return send(res, 400, { error: 'Pick a player name first' });

    if (!(await claimPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    // Nom vérifié avant le délai d'attente : un joueur refusé pour son nom peut retirer aussitôt avec un autre.
    if (!(await claimName(playerId, name))) return send(res, 409, { error: 'This name is already taken, pick another one' });

    const nonce = /^[0-9a-f]{16,32}$/.test(String(body.nonce || '')) ? String(body.nonce) : '';
    const [cooldown, again] = await redis([['SET', `cooldown:${playerId}`, '1', 'PX', COOLDOWN_MS, 'NX'], ...(nonce ? [['GET', nonceKey(playerId, nonce)]] : [])]);
    if (again) return send(res, 200, { ...JSON.parse(again), again: true });
    if (cooldown !== 'OK') return send(res, 429, { error: 'Too fast, wait for the reveal to finish' });

    const n = crypto.randomInt(0, 1000001);
    const t = Date.now();
    const { s, bestToday, dayRank, achievements } = await recordRoll(playerId, n, t);
    const result = { n, s, t, bestToday, dayRank, achievements };
    if (nonce) await redis([['SET', nonceKey(playerId, nonce), JSON.stringify(result), 'EX', NONCE_TTL_S]]);
    return send(res, 200, result);
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
