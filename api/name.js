// POST /api/name  { playerId, secret, name }
// Réserve un nom de joueur : un nom n'appartient qu'à un seul joueur (sans tenir compte des majuscules, accents,
// espaces ni ponctuation). Changer de nom libère l'ancien.
// Depuis le 2026-10-25 (Sacha, pour retirer des pièces du jeu) : le premier pseudo est gratuit, le changer coûte
// Shop.RENAME_PRICE pièces (eco 'out:rename'). Changer seulement la casse ou les espaces reste gratuit.
const { wallet, claimPlayer, claimName, cleanName, cors, send, redis, statsKey, readStats, nameKey, eco } = require('./_lib');
const Shop = require('../js/shop.js');
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
    const [previous] = await redis([['HGET', 'names', playerId]]);
    const paid = !!previous && nameKey(previous) !== nameKey(name);
    if (paid) {
      // Nom déjà pris : refusé avant de parler de prix.
      const [holder] = await redis([['GET', `name:${nameKey(name)}`]]);
      if (holder && holder !== playerId) return send(res, 409, { error: 'This name is already taken' });
      // Verrou du porte-monnaie, le même que la boutique (audit de sécurité, 2026-11-02 : un changement de pseudo et un
      // achat en même temps passaient tous les deux avec un seul solde).
      const out = await wallet(playerId, async () => {
        const st = await readStats(playerId);
        if (Shop.balance(st) < Shop.RENAME_PRICE) return [402, { error: `Changing your name costs ${Shop.RENAME_PRICE.toLocaleString('en-US')} coins` }];
        // Le nom d'abord (il peut être pris), le paiement ensuite : un refus ne coûte rien.
        if (!(await claimName(playerId, name, { rename: true }))) return [409, { error: 'This name is already taken' }];
        await redis([['HINCRBY', statsKey(playerId), 'spent', Shop.RENAME_PRICE], ['HINCRBY', statsKey(playerId), 'renames', 1], ...eco('out:rename', Shop.RENAME_PRICE)]);
        return [200, { name, paid: Shop.RENAME_PRICE, coins: Shop.balance(st) - Shop.RENAME_PRICE }];
      }, 'Name change already in progress');
      return send(res, out[0], out[1]);
    }
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
