// GET  /api/shop?me=<playerId>                                   → pièces, skins possédés, skin équipé
// POST /api/shop { playerId, secret, action: 'buy' | 'equip', skin } → achète (et équipe) ou équipe un skin
// Pièces = gains lus sur les stats tenues par le serveur, moins le champ "spent" : rien ne se crédite depuis le site.
const { redis, ownsPlayer, readStats, statsKey, cors, send, flushDue } = require('./_lib');
const Shop = require('../js/shop.js');

const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const ownedKey = id => `skins:${id}`;

async function state(id) {
  const stats = await readStats(id);
  const [owned, skin] = await redis([['SMEMBERS', ownedKey(id)], ['HGET', 'skins', id]]);
  // Le skin Owner n'appartient qu'au compte du créateur (stats.owner, posé à sa connexion Google) : ni achetable ni donné.
  const isOwner = Number(stats.owner) >= 1;
  const mine = [...new Set((owned || []).map(Shop.resolve))].filter(s => s !== 'classic' && Shop.byId.has(s) && !Shop.byId.get(s).hidden);
  const equipped = Shop.resolve(skin);
  return {
    coins: Shop.balance(stats),
    earned: Shop.earned(stats),
    owned: ['classic', ...mine, ...(isOwner ? ['owner'] : [])],
    skin: equipped && Shop.byId.has(equipped) && (!Shop.byId.get(equipped).hidden || isOwner) ? equipped : 'classic',
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  try {
    if (req.method === 'GET') {
      const me = new URL(req.url, 'http://localhost').searchParams.get('me');
      if (!isPlayerId(me)) return send(res, 400, { error: 'Invalid player' });
      return send(res, 200, await state(me));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    const skin = Shop.byId.get(String(body.skin || ''));
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    if (!skin) return send(res, 400, { error: 'Unknown skin' });

    if (body.action === 'equip') {
      const st = await state(playerId);
      if (!st.owned.includes(skin.id)) return send(res, 422, { error: 'Buy this skin first' });
      await redis([skin.id === 'classic' ? ['HDEL', 'skins', playerId] : ['HSET', 'skins', playerId, skin.id]]);
      return send(res, 200, { ...st, skin: skin.id });
    }

    if (body.action === 'buy') {
      // Un achat à la fois par joueur : deux clics rapides ne dépensent pas deux fois.
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        if (!st.owned.includes(skin.id)) {
          if (skin.hidden) return send(res, 422, { error: 'This skin is not for sale' });
          if (st.coins < skin.price) return send(res, 422, { error: `Not enough coins: ${skin.price - st.coins} more needed` });
          await redis([
            ['HINCRBY', statsKey(playerId), 'spent', skin.price],
            ['SADD', ownedKey(playerId), skin.id],
          ]);
        }
        await redis([['HSET', 'skins', playerId, skin.id]]); // acheté = équipé
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
