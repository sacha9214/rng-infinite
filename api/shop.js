// GET  /api/shop?me=<playerId>                                   → pièces, skins possédés, skin équipé
// POST /api/shop { playerId, secret, action: 'buy' | 'equip', skin } → achète (et équipe) ou équipe un skin
// POST /api/shop { playerId, secret, action: 'case', case }           → ouvre une caisse (skin tiré par le serveur)
// POST /api/shop { playerId, secret, action: 'button' | 'buybutton', button } → équipe ou achète un bouton de tirage
// POST /api/shop { playerId, secret, action: 'buyemote', emote }      → achète une émote spéciale (réactions en duel)
// Pièces = gains lus sur les stats tenues par le serveur, moins le champ "spent" : rien ne se crédite depuis le site.
const { redis, ownsPlayer, readStats, statsKey, cors, send, flushDue } = require('./_lib');
const crypto = require('node:crypto');
const Shop = require('../js/shop.js');
const Gamble = require('./_gamble');

const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const ownedKey = id => `skins:${id}`;
const ownedEmotesKey = id => `emotes:${id}`; // émotes spéciales achetées (lu aussi par api/room.js)
const ownedButtonsKey = id => `btns:${id}`; // boutons achetés à part ; le hash "btns" retient le bouton choisi

async function state(id) {
  const stats = await readStats(id);
  const [owned, skin, bought, button, emotes] = await redis([['SMEMBERS', ownedKey(id)], ['HGET', 'skins', id], ['SMEMBERS', ownedButtonsKey(id)], ['HGET', 'btns', id], ['SMEMBERS', ownedEmotesKey(id)]]);
  // Le skin Owner n'appartient qu'au compte du créateur (stats.owner, posé à sa connexion Google) : ni achetable ni donné.
  const isOwner = Number(stats.owner) >= 1;
  const mine = [...new Set((owned || []).map(Shop.resolve))].filter(s => s !== 'classic' && Shop.byId.has(s) && !Shop.byId.get(s).hidden);
  const equipped = Shop.resolve(skin);
  const skins = ['classic', ...mine, ...(isOwner ? ['owner'] : [])];
  const buttons = [...new Set(bought || [])].filter(b => Shop.buttonById.has(b));
  // Bouton de tirage : "match" (il suit le skin équipé) tant que le choix enregistré n'est pas un bouton possédé —
  // celui d'un skin possédé, ou un bouton acheté à part.
  const mineToo = button && (Shop.byId.has(button) ? skins.includes(button) : buttons.includes(button));
  return {
    coins: Shop.balance(stats),
    earned: Shop.earned(stats),
    owned: skins,
    skin: equipped && Shop.byId.has(equipped) && (!Shop.byId.get(equipped).hidden || isOwner) ? equipped : 'classic',
    buttons,
    button: mineToo ? button : Shop.MATCH,
    emotes: Shop.EMOTES.map(e => e.id).filter(e => (emotes || []).includes(e)),
    speed: Shop.speedLevel(stats.speedLv),
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  try {
    if (req.method === 'GET') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      // Compte de la maison du casino (ce qu'elle a donné et pris, dernières manches) : public, sans joueur.
      if (query.get('casino')) return send(res, 200, await Gamble.house());
      const me = query.get('me');
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

    // Caisse : le serveur tire un skin de la liste (les plus chers sont les plus rares). Déjà possédé : la moitié du
    // prix est rendue. Même verrou que l'achat : deux clics rapides n'ouvrent pas deux caisses.
    if (body.action === 'case') {
      const box = Shop.caseById.get(String(body.case || ''));
      if (!box) return send(res, 400, { error: 'Unknown case' });
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        if (st.coins < box.price) return send(res, 422, { error: `Not enough coins: ${box.price - st.coins} more needed` });
        const won = Shop.drawCase(box, crypto.randomInt(0, 2 ** 32) / 2 ** 32);
        const duplicate = st.owned.includes(won);
        const refund = duplicate ? Math.round(box.price * Shop.DUPLICATE_REFUND) : 0;
        const writes = [['HINCRBY', statsKey(playerId), 'spent', box.price - refund], ['HINCRBY', statsKey(playerId), 'cases', 1]];
        if (!duplicate) writes.push(['SADD', ownedKey(playerId), won]);
        await redis(writes);
        return send(res, 200, { ...(await state(playerId)), won, duplicate, refund });
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    // Bouton de tirage. Équiper : "match", le bouton d'un skin possédé ou un bouton acheté. Acheter : seulement
    // ceux vendus à part (ceux des skins viennent avec le skin), même verrou que les autres achats.
    if (body.action === 'button') {
      const id = String(body.button || '');
      if (id !== Shop.MATCH && !Shop.byId.has(id) && !Shop.buttonById.has(id)) return send(res, 400, { error: 'Unknown button' });
      const st = await state(playerId);
      if (id !== Shop.MATCH && !(Shop.byId.has(id) ? st.owned.includes(id) : st.buttons.includes(id))) {
        return send(res, 422, { error: Shop.byId.has(id) ? 'This button comes with its skin: get the skin first' : 'Buy this button first' });
      }
      await redis([id === Shop.MATCH ? ['HDEL', 'btns', playerId] : ['HSET', 'btns', playerId, id]]);
      return send(res, 200, { ...st, button: id });
    }
    if (body.action === 'buybutton') {
      const item = Shop.buttonById.get(String(body.button || ''));
      if (!item) return send(res, 400, { error: 'Unknown button' });
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        if (!st.buttons.includes(item.id)) {
          if (st.coins < item.price) return send(res, 422, { error: `Not enough coins: ${item.price - st.coins} more needed` });
          await redis([
            ['HINCRBY', statsKey(playerId), 'spent', item.price],
            ['SADD', ownedButtonsKey(playerId), item.id],
          ]);
        }
        await redis([['HSET', 'btns', playerId, item.id]]); // acheté = équipé
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    // Section Gamble (api/_gamble.js) : un coup à la fois par joueur, sous le même verrou que les achats.
    const GAMES = { roulette: Gamble.roulette, bj: Gamble.blackjack, plinko: Gamble.plinko, mines: Gamble.mines, crash: Gamble.crash, slots: Gamble.slots };
    if (GAMES[body.action]) {
      // Deux demandes du même joueur peuvent se croiser sans faute de sa part : le sondage d'une manche de Crash et
      // son clic « Cash out », ou les trois reprises de partie à l'ouverture de la page. La seconde attend donc son
      // tour (jusqu'à ~1,5 s) au lieu d'être refusée ; l'heure qui compte pour le Crash reste celle de son arrivée.
      const at = Date.now();
      if (body.action === 'crash' && String(body.move || 'state') === 'state') {
        const flying = await Gamble.crashPeek(playerId, at);
        if (flying) return send(res, 200, flying);
      }
      let lock = null;
      for (let tries = 0; tries < 25 && lock !== 'OK'; tries++) {
        if (tries) await new Promise(resolve => setTimeout(resolve, 60));
        [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      }
      if (lock !== 'OK') return send(res, 429, { error: 'One move at a time' });
      try {
        return send(res, 200, await GAMES[body.action](playerId, body, at));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    // Vitesse du tirage : achète le niveau suivant (jamais deux d'un coup, jamais au-delà du dernier).
    if (body.action === 'speed') {
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        const price = Shop.SPEED.prices[st.speed];
        if (price === undefined) return send(res, 422, { error: 'Roll speed is already at its maximum' });
        if (st.coins < price) return send(res, 422, { error: `Not enough coins: ${price - st.coins} more needed` });
        await redis([['HINCRBY', statsKey(playerId), 'spent', price], ['HSET', statsKey(playerId), 'speedLv', st.speed + 1]]);
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    if (body.action === 'buyemote') {
      const item = Shop.emoteById.get(String(body.emote || ''));
      if (!item) return send(res, 400, { error: 'Unknown emote' });
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        if (!st.emotes.includes(item.id)) {
          if (st.coins < item.price) return send(res, 422, { error: `Not enough coins: ${item.price - st.coins} more needed` });
          await redis([
            ['HINCRBY', statsKey(playerId), 'spent', item.price],
            ['SADD', ownedEmotesKey(playerId), item.id],
          ]);
        }
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
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
