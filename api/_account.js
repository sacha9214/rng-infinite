// Supprimer son compte (demandé par Sacha, 2026-11-05) : bouton « Delete my account » des réglages. Pas une fonction
// Vercel (nom en « _ ») : routé depuis api/auth.js (action 'deleteAccount'), api/ est déjà à 12 fonctions publiques.
//
// POST /api/auth { action: 'deleteAccount', playerId, secret, name } → { deleted: true }
//
// Le joueur prouve qu'il est lui (secret de cet appareil) et retape son pseudo exact. Seul SON identifiant est touché.
// Refusé (rien n'est effacé) :
//   - compte suspendu : ownsPlayer répond 423, comme partout (supprimer ne sert pas à fuir une suspension) ;
//   - compte du créateur ou d'un invité de la page Owner (canViewOwner) : 403, ces accès se règlent à la main ;
//   - assis à une table de poker, dans un duel en cours, un tirage de duel pas encore révélé, un tournoi pas fini, ou
//     l'équipe d'une guerre de clans en attente ou en cours : 409. Encaisser à sa place mélangerait la suppression et
//     les règles de ces jeux (pots, remboursements, adversaires) ; le joueur quitte d'abord, puis recommence ;
//   - chef d'un clan qui a d'autres membres : 409, il passe la main ou dissout d'abord (même règle que « Leave »). Seul
//     dans son clan : le clan est dissous, comme quand il le quitte.
//
// Effacé : toutes les clés qui portent l'identifiant (stats, historiques des deux modes, badges, nums, objets, quêtes,
// avatar, messages privés, cadeaux et invitations reçus…), l'identifiant dans tous les hash, sets et sorted sets
// partagés (pseudo, classements, présence, skins équipés, titre, bio, clan…), chaque nom réservé name:<clé> qui pointe
// sur lui, les liens Google (google:<sub>) et Discord (discord:links), le mot de passe, le code de récupération, ses
// traces dans les clés des autres joueurs (amis et demandes, non-lus, blocages, face-à-face, victoires du jour,
// cadeaux reçus de lui), ses positions ouvertes (pos:open), ses réactions, ses messages du chat global et de son clan,
// ses lignes du fil du casino.
// Une seule lecture de toutes les clés (SCAN), puis des envois par paquets : une suppression est rare, quelques secondes
// sur le vrai serveur suffisent (banPlayers parcourt déjà tout de la même façon).
//
// Gardé, et pourquoi :
//   - player:<id>:secret = « deleted » : une pierre tombale sans donnée personnelle. Un autre appareil qui a encore
//     l'ancien identifiant reçoit 403 et repart avec un joueur neuf (sans elle, claimPlayer recréait le compte vide au
//     premier secret venu) ;
//   - « banned » : la suspension reste (on ne peut de toute façon pas supprimer un compte suspendu) ;
//   - les totaux anonymes (casino, eco:*, rolls:*, tirages par nombre « nc ») : ils ne disent rien du joueur ;
//   - les idées envoyées (sugg:*) : le créateur les garde, elles ne sont plus reliées à aucun compte vivant ;
//   - les journaux de modération (reports, avlog, gc:mutelog, gc:dellog) : comme « banned », pour juger les cas ;
//   - les salles de duel finies (1 jour), tournois finis (14 jours) et guerres finies (30 jours) : l'historique des
//     autres joueurs, qui s'efface seul ; l'identifiant n'y renvoie plus à rien.
//   - les messages des AUTRES joueurs du chat global qui lui répondent ou le citent (champs ra et at, jamais envoyés au
//     site) : ils sortent des 100 derniers messages ; les gagnants des giveaways passés (gw:item).
const { redis, ownsPlayer, readStats, canViewOwner, nameKey, statsKey, PENDING_KEY } = require('./_lib');

const refuse = (status, error) => Object.assign(new Error(error), { status });
const isId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const HAS_ID = /[0-9a-f]{16}/; // clé propre à un joueur (le sien ou un autre) : jamais balayée champ par champ
const KEEP = new Set(['banned']);
const TOMB = 'deleted';
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };

async function scan(opts = []) {
  const out = [];
  let cur = '0';
  do {
    const [[next, keys]] = await redis([['SCAN', cur, 'COUNT', 2000, ...opts]]);
    cur = String(next);
    out.push(...keys);
  } while (cur !== '0');
  return out;
}
// Les commandes par paquets : un seul envoi peut être énorme (des centaines de classements par jour).
async function inChunks(cmds, size = 500) {
  const out = [];
  for (let i = 0; i < cmds.length; i += size) out.push(...(await redis(cmds.slice(i, i + size))));
  return out;
}

// Ce qui empêche de supprimer tout de suite (rien n'est écrit ici). keys = toutes les clés de la base.
async function busy(me, keys, now) {
  const Poker = require('./_poker'), Tournament = require('./_tournament');
  const [seat, room, pending] = await redis([['GET', Poker.seatKey(me)], ['GET', `inroom:${me}`], ['ZRANGE', PENDING_KEY, 0, -1]]);
  if (seat) {
    const [raw] = await redis([['GET', Poker.tableKey(seat)]]), t = parse(raw);
    const s = t && t.status !== 'over' && (t.seats || []).find(x => x && x.id === me);
    if (s && s.cashed == null) throw refuse(409, 'Leave your poker table first, then try again');
  }
  if (await require('./_chess').live(me)) throw refuse(409, 'Finish your chess game first, then try again');
  if (room) {
    const [h] = await redis([['HMGET', `room:${room}`, 'ended', 'settled']]);
    if (h && h[0] !== '1' && !h[1]) throw refuse(409, 'Leave your duel first, then try again in a minute');
  }
  // Tirage de duel pas encore révélé (api/_lib.js, queueReveal) : il recréerait des stats à l'arrivée.
  if ((pending || []).some(m => m.includes(me))) throw refuse(409, 'Your last duel roll is still being revealed: try again in a minute');
  const tns = keys.filter(k => /^tn:.+:in$/.test(k)).map(k => k.slice(3, -3));
  const signed = tns.length ? await inChunks(tns.flatMap(tid => [['ZSCORE', `tn:${tid}:in`, me], ['HGET', `tn:${tid}`, 'paid']])) : [];
  tns.forEach((tid, i) => { if (signed[2 * i] !== null && !signed[2 * i + 1] && now < Tournament.times(tid, 0).end) throw refuse(409, 'You are in a tournament: try again when it is over'); });
  await require('./_clan').leaveOnDelete(me, now, true);
}

async function deleteAccount(body, now = Date.now()) {
  const me = String(body.playerId || ''), secret = String(body.secret || '');
  if (!isId(me) || !/^[0-9a-f]{32}$/.test(secret) || !(await ownsPlayer(me, secret))) throw refuse(403, 'This player id belongs to someone else');
  const [name] = await redis([['HGET', 'names', me]]);
  if (!name) throw refuse(422, 'This player has no name yet: nothing to delete on the server');
  if (String(body.name || '').trim() !== name) throw refuse(422, 'Type your player name exactly as it is shown');
  if (canViewOwner(await readStats(me))) throw refuse(403, 'This account cannot be deleted from here');
  // Un achat, un pari ou une autre suppression en même temps : verrou des achats (shop:<id>), effacé avec le reste.
  const [lock] = await redis([['SET', `shop:${me}`, '1', 'PX', 30000, 'NX']]);
  if (lock !== 'OK') throw refuse(429, 'Busy, try again');
  let keys;
  try {
    keys = await scan();
    await busy(me, keys, now);
  } catch (err) { await redis([['DEL', `shop:${me}`]]); throw err; }

  // 1. Plus personne n'agit sous cet identifiant : pierre tombale, secrets d'appareils, Google et mot de passe.
  const [google, recover, avRaw, avpRaw] = await redis([['GET', `player:${me}:google`], ['GET', `recover:id:${me}`], ['GET', `av:${me}`], ['GET', `avp:${me}`]]);
  await redis([['SET', `player:${me}:secret`, TOMB], ['DEL', `player:${me}:secrets`, `player:${me}:google`, `player:${me}:pw`],
    ...(google ? [['DEL', `google:${google}`]] : []), ...(recover ? [['DEL', `recover:${recover}`]] : [])]);

  // 2. Clan : il le quitte (ou le dissout s'il y est seul).
  await require('./_clan').leaveOnDelete(me, now);

  // 3. Ses traces dans les clés des autres joueurs, rangées par préfixe (amitiés et demandes même à sens unique,
  // non-lus, blocages, face-à-face, victoires du jour) et dans quelques clés partagées dont la valeur le nomme.
  const others = keys.filter(k => !k.includes(me)), pre = p => others.filter(k => k.startsWith(p));
  const w = [
    ...['fr:', 'frin:', 'frout:', 'dmblock:'].flatMap(p => pre(p).map(k => ['SREM', k, me])),
    ...pre('dmu:').map(k => ['HDEL', k, me]), ...pre('dw:').map(k => ['HDEL', k, me]),
    ...pre('h2h:').map(k => ['HDEL', k, `w:${me}`, `l:${me}`]),
    // Plafonds du jour des cadeaux (api/friends.js) : champs « o:<id> » (donné) et « i:<id> » (reçu).
    ...pre('gift:').map(k => ['HDEL', k, `o:${me}`, `i:${me}`]),
  ];
  // Cadeaux qu'il a faits, dans la liste de chaque ami (ses amis d'abord : ce sont les seuls à en avoir reçu).
  const [fr, avpq, clanweek, links, open, asked] = await redis([['SMEMBERS', `fr:${me}`], ['HGETALL', 'avpq'], ['HGETALL', 'clanweek'], ['HGETALL', 'discord:links'], ['ZRANGE', 'pos:open', 0, -1], ['SMEMBERS', `clanasked:${me}`]]);
  const friends = (fr || []).filter(isId);
  const gifts = friends.length ? await redis(friends.map(o => ['LRANGE', `gifts:${o}`, 0, -1])) : [];
  friends.forEach((o, i) => (gifts[i] || []).filter(g => (parse(g) || {}).f === me).forEach(g => w.push(['LREM', `gifts:${o}`, 0, g])));
  // Champ dont la valeur est son identifiant : file des photos (avpq), lien Discord, meilleur joueur d'un clan.
  const byValue = (key, flat, keep = () => true) => { for (let i = 0; i < (flat || []).length; i += 2) if (flat[i + 1] === me && keep(flat[i])) w.push(['HDEL', key, flat[i]]); };
  byValue('avpq', avpq); byValue('discord:links', links); byValue('clanweek', clanweek, f => f.endsWith(':mvp'));
  const av = parse(avRaw), avp = parse(avpRaw);
  if (av && av.tok) w.push(['HDEL', 'avtok', av.tok]);
  if (avp && avp.pk) w.push(['HDEL', 'avpq', avp.pk]);
  // Positions ouvertes (api/_lever.js) : membres « <id>:<position> » ; sinon le règlement recréerait ses stats.
  (open || []).filter(m => m.startsWith(`${me}:`)).forEach(m => w.push(['ZREM', 'pos:open', m]));
  (asked || []).forEach(cid => w.push(['HDEL', `clanreq:${cid}`, me]));
  // Ses réactions (api/_react.js) : champs « <message>|<id> » du chat global, des chats de clan et de duel.
  const rxKeys = ['rx:gc', ...others.filter(k => /^clanrx:|^room:.+:rx$/.test(k))];
  const rxFields = await inChunks(rxKeys.map(k => ['HKEYS', k]));
  rxKeys.forEach((k, i) => { const f = (rxFields[i] || []).filter(x => String(x).endsWith(`|${me}`)); if (f.length) w.push(['HDEL', k, ...f]); });
  // Chaque nom réservé qui pointe sur lui (le pseudo actuel, et un ancien resté réservé) : il redevient libre.
  const nameKeys = others.filter(k => k.startsWith('name:'));
  const holders = await inChunks(nameKeys.map(k => ['GET', k]));
  nameKeys.forEach((k, i) => { if (holders[i] === me) w.push(['DEL', k]); });
  // Ses messages du chat global (les autres relisent la liste : rev et del bougent) et ses lignes du fil du casino.
  const [gc, feed] = await redis([['LRANGE', 'gc:msgs', 0, -1], ['LRANGE', 'casino:feed', 0, -1]]);
  const mine = (gc || []).filter(x => (parse(x) || {}).a === me);
  if (mine.length) w.push(...mine.map(x => ['LREM', 'gc:msgs', 1, x]), ['SET', 'gc:rev', now], ['SET', 'gc:del', now]);
  (feed || []).filter(x => (parse(x) || {}).id === me).forEach(x => w.push(['LREM', 'casino:feed', 1, x]));
  await inChunks(w);

  // 4. Toutes les clés qui portent son identifiant (sauf la pierre tombale).
  await inChunks(keys.filter(k => k.includes(me) && k !== `player:${me}:secret`).map(k => ['DEL', k]));

  // 5. Son identifiant comme champ ou membre des clés partagées : classements (comme banPlayers), pseudo, présence,
  // skins équipés, titre, bio, meilleurs tirages du jour… Les clés propres à un autre joueur ne sont pas lues ici.
  const shared = others.filter(k => !HAS_ID.test(k) && !KEEP.has(k));
  const types = await inChunks(shared.map(k => ['TYPE', k]));
  const CMD = { hash: 'HDEL', set: 'SREM', zset: 'ZREM' };
  await inChunks(shared.map((k, i) => CMD[types[i]] && [CMD[types[i]], k, me]).filter(Boolean));

  // 6. Caches d'une minute qui le montraient encore.
  await redis([['DEL', 'lbcache:coins', 'casino:board', statsKey(me)]]);
  require('./_avatar').resetCache();
  return { deleted: true };
}

module.exports = { deleteAccount, TOMB };
