// GET  /api/shop?me=<playerId>                                   → pièces, skins possédés, skin équipé
// POST /api/shop { playerId, secret, action: 'buy' | 'equip', skin } → achète (et équipe) ou équipe un skin
// GET  /api/shop?owners=1                                         → combien de joueurs possèdent chaque objet (public, en cache)
// POST /api/shop { playerId, secret, action: 'case', case }           → ouvre une caisse (skin, fond d'écran, bouton ou pack de sons, tiré par le serveur)
// POST /api/shop { playerId, secret, action: 'button' | 'buybutton', button } → équipe ou achète un bouton de tirage
// POST /api/shop { playerId, secret, action: 'sound' | 'buysound', sound } → met en service ou achète un pack de sons
// POST /api/shop { playerId, secret, action: 'buyemote', emote }      → achète une émote spéciale (réactions en duel)
// POST /api/shop { playerId, secret, action: 'redeem', code }         → utilise un code cadeau (une fois par joueur)
// Pièces = gains lus sur les stats tenues par le serveur, moins le champ "spent" : rien ne se crédite depuis le site.
const { eco, redis, ownsPlayer, readStats, statsKey, cors, send, flushDue, findPlayer } = require('./_lib');
const crypto = require('node:crypto');
const Shop = require('../js/shop.js');
const Gamble = require('./_gamble');
const Btc = require('./_btc');
const Lever = require('./_lever');

const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const ownedKey = id => `skins:${id}`;
const ownedEmotesKey = id => `emotes:${id}`; // émotes spéciales achetées (lu aussi par api/room.js)
const ownedButtonsKey = id => `btns:${id}`; // boutons achetés à part ; le hash "btns" retient le bouton choisi
const ownedSoundsKey = id => `snds:${id}`; // packs de sons achetés ; le hash "snd" retient celui en service
// Codes cadeaux (Joueur et réglages) : chaque code ne sert qu'une fois par joueur, après 30 tirages comme les cadeaux
// et le casino (un compte neuf ne sert pas à les ramasser). Majuscules/minuscules et espaces ignorés.
// Pour en ajouter un : une ligne ici, puis déployer. codes:<id> = les codes déjà utilisés par ce joueur.
const CODES = {
  SACHA: { coins: 200 },
  // Halloween 2026 : 300 pièces et le titre Spooky (stats.spooky), valable jusqu'au 1er novembre.
  SPOOKYMONTH: { coins: 300, title: 'spooky', until: '2026-11-01T00:00:00Z' },
  // Codes cachés dans le site (idée de PRISMA123, 2026-10-16) : page d'aide, console du navigateur, vérificateur d'XP
  // sur le nombre 0. 150 pièces chacun ; les trois donnent le titre Code Hunter (stats.codehunter).
  ROLLFOREVER: { coins: 150, hunt: true },
  CONSOLECAT: { coins: 150, hunt: true },
  ZEROHERO: { coins: 150, hunt: true },
  // Idée de MAYO (2026-10-16) : clin d'œil à son école, où ses amis et lui « gatekeepaient » le jeu au début.
  // 100 pièces et le titre Gatekeep (stats.gatekeep).
  BC: { coins: 100, title: 'gatekeep' },
  // Demandé par Sacha (2026-10-19) : 150 pièces et le titre Epitech (stats.epitech).
  'EPITECH>42': { coins: 150, title: 'epitech' },
  // Excuses pour la coupure du 2026-10-22 (le site a déménagé sur le VPS) : 500 pièces, valable une semaine.
  SORRY404: { coins: 500, until: '2026-10-30T00:00:00Z' },
  ICHI: { coins: 100 }, // demandé par Sacha (2026-10-23), pour son ami randomguy
};
const HUNT = Object.keys(CODES).filter(k => CODES[k].hunt);
const CODE_MIN_ROLLS = 30;
// Titre Collectible Connoisseur : posé une fois quand le joueur possède tous les skins hors limités (après un achat ou
// une caisse) ; un skin ajouté plus tard ne le retire pas.
async function checkCollection(playerId) {
  const [owned, btns, emos, walls] = await redis([['SMEMBERS', ownedKey(playerId)], ['SMEMBERS', ownedButtonsKey(playerId)], ['SMEMBERS', ownedEmotesKey(playerId)], ['SMEMBERS', ownedWallsKey(playerId)]]);
  const has = (list, set) => list.every(id => (set || []).includes(id)), w = [];
  if (has(Shop.collectible(), owned)) w.push(['HSET', statsKey(playerId), 'connoisseur', 1]);
  // Titres de collection (idée de PRISMA123, 2026-10-22) : tous les boutons, toutes les émotes, tous les fonds.
  if (has(Shop.collectibleSets.buttons(), btns)) w.push(['HSET', statsKey(playerId), 'allButtons', 1]);
  if (has(Shop.collectibleSets.emotes(), emos)) w.push(['HSET', statsKey(playerId), 'allEmotes', 1]);
  if (has(Shop.collectibleSets.walls(), walls)) w.push(['HSET', statsKey(playerId), 'allWalls', 1]);
  if (w.length) await redis(w);
}
const usedCodesKey = id => `codes:${id}`;
// Popularité (idée d'ann joe et de YU CHUAN 23, 2026-10-28) : un seul hash « owners », champ <genre>:<objet> = nombre
// de joueurs qui possèdent l'objet (genres : skins, walls, buttons, emotes, sounds, les noms de la page Owner). Au plus
// un champ par objet du catalogue (~230), jamais rien par joueur. +1 là où un objet entre dans un inventaire (achats et
// caisses : ce sont les seuls chemins, les cadeaux entre amis ne donnent que des pièces), lu par GET /api/shop?owners=1.
// Rattrapage des objets déjà possédés : tools/backfill-owners.js. Jamais qui possède quoi : seulement des nombres.
const OWNERS = 'owners';
const gained = (kind, id) => ['HINCRBY', OWNERS, `${kind}:${id}`, 1];
const OWNERS_TTL = 60 * 1000;
let ownersCache = { at: 0, data: null };
async function ownerCounts() {
  if (ownersCache.data && Date.now() - ownersCache.at < OWNERS_TTL) return ownersCache.data;
  const [flat] = await redis([['HGETALL', OWNERS]]), data = {};
  for (let i = 0; i < (flat || []).length; i += 2) { const n = Number(flat[i + 1]) || 0; if (n > 0) data[flat[i]] = n; }
  ownersCache = { at: Date.now(), data };
  return data;
}
// Part du créateur (5 %, Shop.IDEA_SHARE) : à chaque fois qu'un joueur dépense des pièces pour obtenir un skin né d'une
// idée (champ idea) — achat direct, et depuis le 2026-10-28 aussi quand ce skin sort d'une caisse payée (finnnnn ne
// touchait rien sur les skins tirés dans les caisses) : 5 % de ce que l'acheteur a payé (le prix du skin, ou celui de la
// caisse). Jamais pour soi-même, rien pour une caisse ouverte avec une clé ; un nom introuvable ne bloque rien.
async function payIdea(item, buyer, paid) {
  if (!item || !item.idea || !(paid > 0)) return;
  const author = await findPlayer(item.idea).catch(() => null), cut = Math.round(paid * Shop.IDEA_SHARE);
  if (author && author !== buyer && cut > 0) await redis([['HINCRBY', statsKey(author), 'bonus', cut], ['HINCRBY', statsKey(author), 'royalty', cut], ...eco('in:royalty', cut)]);
}
const ownedWallsKey = id => `walls:${id}`; // fonds d'écran achetés ; le hash "wall" retient celui affiché

async function state(id) {
  const stats = await readStats(id);
  const [owned, skin, bought, button, emotes, walls, wall, snds, snd, sold] = await redis([['SMEMBERS', ownedKey(id)], ['HGET', 'skins', id], ['SMEMBERS', ownedButtonsKey(id)], ['HGET', 'btns', id], ['SMEMBERS', ownedEmotesKey(id)], ['SMEMBERS', ownedWallsKey(id)], ['HGET', 'wall', id], ['SMEMBERS', ownedSoundsKey(id)], ['HGET', 'snd', id], ['HMGET', PRESTIGE_SOLD, ...Shop.PRESTIGE.map(x => x.id)]]);
  // Le skin Owner n'appartient qu'au compte du créateur (stats.owner, posé à sa connexion Google) : ni achetable ni donné.
  // Succès Coin Millionaire (idée d'A Dude, 2026-10-21) : posé une fois, la première fois que le solde atteint 1 000 000.
  if (!Number(stats.millionaire) && Shop.balance(stats) >= 1000000) await redis([['HSET', statsKey(id), 'millionaire', 1]]);
  // Sound Collector et Shopaholic (idées de dailycb, 2026-10-27) : posés une fois, d'après ce qui vient d'être lu (aucune
  // lecture en plus) ; ici plutôt qu'après chaque achat, pour que les joueurs qui avaient déjà tout les obtiennent aussi.
  // Shopaholic : tout ce qui s'achète en pièces, possédé en même temps (hors limités et Prestige, en stock limité).
  { const has = (list, set) => list.every(x => (set || []).includes(x)), w = [];
    const allSounds = has(Shop.collectibleSets.sounds(), snds);
    if (allSounds && !Number(stats.allSounds)) w.push('allSounds', 1);
    if (!Number(stats.allShop) && allSounds && Shop.speedLevel(stats.speedLv) === Shop.SPEED.prices.length && has(Shop.collectible(), owned) &&
      has(Shop.collectibleSets.buttons(), bought) && has(Shop.collectibleSets.emotes(), emotes) && has(Shop.collectibleSets.walls(), walls)) w.push('allShop', 1);
    if (w.length) await redis([['HSET', statsKey(id), ...w]]); }
  const isOwner = Number(stats.owner) >= 1, isSupporter = Number(stats.supporter) >= 1, isFisher = Number(stats.collabFish) >= 1;
  // Un skin réservé (Owner, Supporter) ne se porte que si le joueur y a droit.
  const allowed = s => !Shop.byId.get(s).hidden || (s === 'owner' ? isOwner : s === 'supporter' ? isSupporter : s === 'fisher' ? isFisher : false);
  const mine = [...new Set((owned || []).map(Shop.resolve))].filter(s => s !== 'classic' && Shop.byId.has(s) && !Shop.byId.get(s).hidden);
  const equipped = Shop.resolve(skin);
  const skins = ['classic', ...mine, ...(isFisher ? ['fisher'] : []), ...(isSupporter ? ['supporter'] : []), ...(isOwner ? ['owner'] : [])];
  const buttons = [...new Set(bought || [])].filter(b => Shop.buttonById.has(b));
  // Bouton de tirage : "match" (il suit le skin équipé) tant que le choix enregistré n'est pas un bouton possédé —
  // celui d'un skin possédé, ou un bouton acheté à part.
  const mineToo = button && (Shop.byId.has(button) ? skins.includes(button) : buttons.includes(button));
  return {
    coins: Shop.balance(stats),
    earned: Shop.earned(stats),
    royalty: Math.max(0, Number(stats.royalty) || 0), // pièces reçues comme créateur (part de 5 %), pour sa vue « Your creations »
    owned: skins,
    skin: equipped && Shop.byId.has(equipped) && allowed(equipped) ? equipped : 'classic',
    supporter: isSupporter,
    walls: (walls || []).filter(w => Shop.wallById.has(w)),
    wall: wall && Shop.wallById.has(wall) && (walls || []).includes(wall) ? wall : null,
    keys: Object.fromEntries(Shop.CASES.map(c => [c.id, Math.max(0, Number(stats[`key:${c.id}`]) || 0)])), // clés de caisse gagnées avec les niveaux
    buttons,
    button: mineToo ? button : Shop.MATCH,
    emotes: Shop.EMOTES.map(e => e.id).filter(e => (emotes || []).includes(e)),
    speed: Shop.speedLevel(stats.speedLv),
    sounds: Shop.SOUNDS.map(p => p.id).filter(p => p !== 'classic' && (snds || []).includes(p)),
    sound: Shop.soundPack(snd, snds),
    // Prestige : ce que le joueur possède et le stock restant de chaque titre.
    prestige: Shop.PRESTIGE.map((x, i) => ({ id: x.id, owned: Number(stats[`pr:${x.id}`]) >= 1, left: Math.max(0, x.stock - (Number((sold || [])[i]) || 0)) })),
  };
}
// Prestige (2026-10-25) : nombre d'exemplaires vendus de chaque titre (stock commun, Shop.PRESTIGE[].stock).
const PRESTIGE_SOLD = 'prestige:sold';

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  try {
    if (req.method === 'GET') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      // Compte de la maison du casino (ce qu'elle a donné et pris, dernières manches) : public, sans joueur.
      // Classement du casino (gagnants, perdants, plus gros parieurs) : public, pseudos seulement ; « me » situe le joueur.
      // Bitcoin du casino : prix du moment et historique 24 h (public) ; avec « me », les avoirs du joueur.
      if (query.get('candles')) { const asset = Btc.assetOf(query.get('asset')); if (!asset) return send(res, 400, { error: 'Unknown coin' }); return send(res, 200, await Btc.candles(asset, query.get('tf') || '1h')); }
      if (query.get('btc')) { const asset = Btc.assetOf(query.get('asset')); if (!asset) return send(res, 400, { error: 'Unknown coin' }); return send(res, 200, await Btc.view(isPlayerId(query.get('me')) ? query.get('me') : '', asset)); }
      if (query.get('casino') === 'top') return send(res, 200, await Gamble.board(isPlayerId(query.get('me')) ? query.get('me') : ''));
      if (query.get('casino')) return send(res, 200, await Gamble.house());
      if (query.get('owners')) return send(res, 200, { owners: await ownerCounts() }); // en cache 60 s ici, et côté site
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
        // Clé de caisse gagnée avec les niveaux (stats.key:<caisse>) : la caisse s'ouvre gratuitement.
        let price = box.price;
        if (body.free) {
          // free = true : la clé de cette caisse ; free = '<clé>' : une autre clé qui l'ouvre aussi (Shop.KEY_OPENS).
          const keyId = typeof body.free === 'string' ? body.free : box.id;
          if (!(Shop.KEY_OPENS[keyId] || []).includes(box.id)) return send(res, 422, { error: 'This key does not open this case' });
          const [left] = await redis([['HINCRBY', statsKey(playerId), `key:${keyId}`, -1]]);
          if (Number(left) < 0) { await redis([['HINCRBY', statsKey(playerId), `key:${keyId}`, 1]]); return send(res, 422, { error: 'No key for this case' }); }
          price = 0;
        } else if (st.coins < box.price) return send(res, 422, { error: `Not enough coins: ${box.price - st.coins} more needed` });
        const won = Shop.drawCase(box, crypto.randomInt(0, 2 ** 32) / 2 ** 32);
        // Caisse de fonds d'écran (idée de CrazyMiner22) : le fond gagné rejoint walls:<id>, comme un achat (buywall).
        // Caisse de boutons (idée de shadow2, 2026-10-27) : le bouton gagné rejoint btns:<id>, comme un achat (buybutton).
        // Caisse de sons (idée de shadow2 Jr, 2026-10-28) : le pack gagné rejoint snds:<id>, comme un achat (buysound).
        const duplicate = (box.snd ? st.sounds : box.btn ? st.buttons : box.wall ? st.walls : st.owned).includes(won);
        const refund = duplicate ? (price ? Shop.duplicateRefund(box, won) : Math.round(Shop.duplicateRefund(box, won) / 2)) : 0; // gratuite : moitié du remboursement, en pièces
        const writes = [['HINCRBY', statsKey(playerId), 'spent', price - refund], ['HINCRBY', statsKey(playerId), 'cases', 1], ...eco('out:cases', price - refund)];
        if (!duplicate) writes.push(['SADD', box.snd ? ownedSoundsKey(playerId) : box.btn ? ownedButtonsKey(playerId) : box.wall ? ownedWallsKey(playerId) : ownedKey(playerId), won],
          gained(box.snd ? 'sounds' : box.btn ? 'buttons' : box.wall ? 'walls' : 'skins', won));
        await redis(writes);
        if (!duplicate) await checkCollection(playerId);
        if (!duplicate && !box.snd && !box.btn && !box.wall) await payIdea(Shop.byId.get(won), playerId, price);
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
    // Fonds d'écran : acheter (une fois, il s'affiche aussitôt) ou choisir lequel afficher ('none' = le fond d'origine).
    if (body.action === 'wall') {
      const id = String(body.wall || '');
      const st = await state(playerId);
      if (id !== 'none' && !st.walls.includes(id)) return send(res, 422, { error: 'Buy this wallpaper first' });
      await redis([id === 'none' ? ['HDEL', 'wall', playerId] : ['HSET', 'wall', playerId, id]]);
      return send(res, 200, { ...st, wall: id === 'none' ? null : id });
    }
    if (body.action === 'buywall') {
      const item = Shop.wallById.get(String(body.wall || ''));
      if (!item) return send(res, 400, { error: 'Unknown wallpaper' });
      const owns = (await redis([['SISMEMBER', ownedWallsKey(playerId), item.id]]))[0];
      if (item.until && Date.now() >= Date.parse(item.until) && !Number(owns)) return send(res, 422, { error: 'This wallpaper is no longer for sale' });
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        if (!st.walls.includes(item.id)) {
          if (st.coins < item.price) return send(res, 422, { error: `Not enough coins: ${item.price - st.coins} more needed` });
          await redis([['HINCRBY', statsKey(playerId), 'spent', item.price], ['SADD', ownedWallsKey(playerId), item.id], gained('walls', item.id), ...eco('out:wallpapers', item.price)]);
          await checkCollection(playerId);
        }
        await redis([['HSET', 'wall', playerId, item.id]]); // acheté = affiché
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
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
            ['HINCRBY', statsKey(playerId), 'spent', item.price], ...eco('out:buttons', item.price),
            ['SADD', ownedButtonsKey(playerId), item.id], gained('buttons', item.id),
          ]);
          await checkCollection(playerId);
        }
        await redis([['HSET', 'btns', playerId, item.id]]); // acheté = équipé
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    // Packs de sons du tirage : mettre en service un pack possédé (ou Classic), ou en acheter un (acheté = en service).
    if (body.action === 'sound') {
      const id = String(body.sound || '');
      if (!Shop.soundById.has(id)) return send(res, 400, { error: 'Unknown sound pack' });
      const st = await state(playerId);
      if (id !== 'classic' && !st.sounds.includes(id)) return send(res, 422, { error: 'Buy this sound pack first' });
      await redis([id === 'classic' ? ['HDEL', 'snd', playerId] : ['HSET', 'snd', playerId, id]]);
      return send(res, 200, { ...st, sound: id });
    }
    if (body.action === 'buysound') {
      const item = Shop.soundById.get(String(body.sound || ''));
      if (!item || !item.price) return send(res, 400, { error: 'Unknown sound pack' });
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId);
        if (!st.sounds.includes(item.id)) {
          if (st.coins < item.price) return send(res, 422, { error: `Not enough coins: ${item.price - st.coins} more needed` });
          await redis([
            ['HINCRBY', statsKey(playerId), 'spent', item.price], ...eco('out:sounds', item.price),
            ['SADD', ownedSoundsKey(playerId), item.id], gained('sounds', item.id),
          ]);
        }
        await redis([['HSET', 'snd', playerId, item.id]]); // acheté = en service
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    // Section Gamble (api/_gamble.js) : un coup à la fois par joueur, sous le même verrou que les achats.
    const GAMES = { roulette: Gamble.roulette, bj: Gamble.blackjack, plinko: Gamble.plinko, mines: Gamble.mines, tower: Gamble.tower, keno: Gamble.keno, dice: Gamble.dice, teddy: Gamble.teddy, duck: Gamble.duck, crash: Gamble.crash, flip: Gamble.coinflip, slots: Gamble.slots, btc: Btc.trade, lever: Lever.act };
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
        await redis([['HINCRBY', statsKey(playerId), 'spent', price], ['HSET', statsKey(playerId), 'speedLv', st.speed + 1], ...eco('out:upgrades', price)]);
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
            ['HINCRBY', statsKey(playerId), 'spent', item.price], ...eco('out:emotes', item.price),
            ['SADD', ownedEmotesKey(playerId), item.id], gained('emotes', item.id),
          ]);
          await checkCollection(playerId);
        }
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    // Prestige (Sacha, 2026-10-25) : un titre de luxe, un exemplaire par joueur, stock limité pour tout le jeu. Le stock
    // est réservé d'abord (HINCRBY) et rendu si le joueur ne peut pas payer : jamais plus de ventes que le stock.
    if (body.action === 'prestige') {
      const item = Shop.prestigeById.get(String(body.item || ''));
      if (!item) return send(res, 400, { error: 'Unknown item' });
      const [lock] = await redis([['SET', `shop:${playerId}`, '1', 'PX', 5000, 'NX']]);
      if (lock !== 'OK') return send(res, 429, { error: 'Purchase already in progress' });
      try {
        const st = await state(playerId), mine = st.prestige.find(x => x.id === item.id);
        if (mine.owned) return send(res, 200, st);
        if (st.coins < item.price) return send(res, 422, { error: `Not enough coins: ${item.price - st.coins} more needed` });
        const [n] = await redis([['HINCRBY', PRESTIGE_SOLD, item.id, 1]]);
        if (Number(n) > item.stock) { await redis([['HINCRBY', PRESTIGE_SOLD, item.id, -1]]); return send(res, 422, { error: 'Sold out' }); }
        await redis([['HINCRBY', statsKey(playerId), 'spent', item.price], ['HSET', statsKey(playerId), `pr:${item.id}`, 1], ...eco('out:prestige', item.price), ['HSET', 'titles', playerId, item.id]]);
        return send(res, 200, await state(playerId));
      } finally {
        await redis([['DEL', `shop:${playerId}`]]);
      }
    }
    if (body.action === 'redeem') {
      const code = String(body.code || '').toUpperCase().replace(/\s+/g, '').slice(0, 32);
      const prize = Object.prototype.hasOwnProperty.call(CODES, code) ? CODES[code] : null;
      if (!prize) return send(res, 404, { error: 'This code does not exist' });
      if (prize.until && Date.now() >= Date.parse(prize.until)) return send(res, 410, { error: 'This code has expired' });
      const stats = await readStats(playerId);
      const rolls = Number(stats.rolls) || 0;
      if (rolls < CODE_MIN_ROLLS) return send(res, 422, { error: `Codes unlock after ${CODE_MIN_ROLLS} rolls (you have ${rolls})` });
      // SADD répond 1 la première fois seulement : deux envois simultanés ne créditent qu'une fois.
      const [fresh] = await redis([['SADD', usedCodesKey(playerId), code]]);
      if (Number(fresh) !== 1) return send(res, 409, { error: 'You already used this code' });
      await redis([['HINCRBY', statsKey(playerId), 'bonus', prize.coins], ...eco('in:codes', prize.coins), ['HINCRBY', 'codes:count', code, 1], ...(prize.title ? [['HSET', statsKey(playerId), prize.title, 1]] : [])]);
      let title = prize.title || null;
      if (prize.hunt) {
        const found = await redis(HUNT.map(c => ['SISMEMBER', usedCodesKey(playerId), c]));
        if (found.every(x => Number(x) === 1)) { await redis([['HSET', statsKey(playerId), 'codehunter', 1]]); title = 'codehunter'; }
      }
      return send(res, 200, { ...(await state(playerId)), redeemed: { code, coins: prize.coins, title, ...(prize.hunt ? { hunt: { found: (await redis(HUNT.map(c => ['SISMEMBER', usedCodesKey(playerId), c]))).filter(x => Number(x) === 1).length, of: HUNT.length } } : {}) } });
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
          // Réservé à une caisse (Infinity) : il ne s'obtient qu'en l'ouvrant.
          if (skin.until && Date.now() >= Date.parse(skin.until)) return send(res, 422, { error: 'This skin is no longer for sale' });
          if (skin.caseOnly) return send(res, 422, { error: `This skin only comes from the ${Shop.caseById.get(skin.caseOnly).name}` });
          if (st.coins < skin.price) return send(res, 422, { error: `Not enough coins: ${skin.price - st.coins} more needed` });
          await redis([
            ['HINCRBY', statsKey(playerId), 'spent', skin.price], ...eco('out:skins', skin.price),
            ['SADD', ownedKey(playerId), skin.id], gained('skins', skin.id),
          ]);
          await checkCollection(playerId);
          await payIdea(skin, playerId, skin.price); // 5 % pour le joueur qui a eu l'idée du skin
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
