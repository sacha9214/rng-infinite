// GET /api/profile?name=<nom>&me=<playerId>   (me : facultatif, pour le face-à-face avec celui qui regarde)
// Profil public d'un joueur, ouvert depuis le classement : ses meilleurs tirages et sa collection de badges.
// Calculé à partir de son historique (hist:<id>), comme ses propres pages History et Badges ; le classement,
// lui, ne compte que les tirages faits par le serveur. Ni l'identifiant ni la liste complète des tirages ne sortent d'ici.
const { statsKey, breathe, engine, redis, cleanName, findPlayer, historyKey, HISTORY_CAP, XP_LB, rollSet, readStats, Achievements, cors, send, flushDue } = require('./_lib');
const Shop = require('../js/shop.js');
// Totaux des profils déjà calculés (voir plus bas), par identifiant de joueur.
const AGG = new Map();
const { awardsOf } = require('./_rank');
// Photos de profil (2026-10-26, demandé par Sacha) : envoi, validation par le créateur et images, dans api/_avatar.js.
const Avatar = require('./_avatar');
const Bio = require('./_bio');

const bioText = raw => { try { const b = raw ? JSON.parse(raw) : null; return b && b.x ? b.x : null; } catch (e) { return null; } };
const BEST_LIMIT = 10;
const AGG_TTL_MS = 6 * 3600 * 1000; // recalcul complet au plus toutes les 6 h (badges changés entre-temps, etc.)
const paggKey = id => `pagg:${id}`, PAGG_MIN = 2000;
// Nombres différents tirés (idée de jsand, 2026-10-27) : le set nums:<id> existe déjà (succès Déjà vu, api/_lib.js) ;
// son SCARD est immédiat, sans relire l'historique. Il est exact depuis que le joueur a ce set (stats.dv, posé à son
// premier tirage depuis le 2026-10-18, rempli alors depuis son historique) : seul un nombre tiré uniquement dans les
// plus vieux tirages d'un historique déjà plafonné (HISTORY_CAP, 100 000) peut manquer. Joueur sans set (pas tiré
// depuis) : compté sur son historique quand le profil le relit en entier (fallback), sinon rien.
const uniqueOf = (st, scard, fallback) => (st.dv === '1' ? Number(scard) || 0 : fallback);

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method === 'POST' && (req.body || {}).action === 'avatar') return Avatar.handle(req, res);
  // « About me » (idée de Niall, 2026-10-27) : écrire le sien, signaler ou (créateur) effacer celui d'un autre.
  if (req.method === 'POST' && (req.body || {}).action === 'bio') return Bio.handle(req, res);
  await flushDue();
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (params.has('avatar') || params.has('avatars')) return await Avatar.serve(req, res, params);
    const name = cleanName(params.get('name'));
    const me = /^[0-9a-f]{16}$/.test(params.get('me') || '') ? params.get('me') : '';
    // ?lite=1 n'est demandé que pour soi-même (onglet Badges, accueil, Stats, bio) : le joueur est retrouvé par son id
    // (me) avant son pseudo. Signalé par A Dude (2026-10-30) : un appareil dont le pseudo local n'est plus celui du
    // serveur (pseudo changé ailleurs, ou gardé sur l'appareil quand le serveur n'a pas répondu, voir saveName) recevait
    // un 404, et l'onglet Badges disait « Roll once to start… » à un joueur de 18 000 tirages ; si ce pseudo était
    // pris par un autre, il montrait même les succès de l'autre.
    const lite = params.get('lite') === '1';
    const [meName] = lite && me ? await redis([['HGET', 'names', me]]) : [null];
    if (!name && !meName) return send(res, 400, { error: 'Missing player name' });
    const id = meName ? me : await findPlayer(name);
    if (!id) return send(res, 404, { error: 'No player with this name' });
    // ?lite=1 (onglet Badges : mes succès et mon titre) : sans l'historique, qui peut prendre plusieurs secondes à
    // calculer pour un gros joueur ; le site abandonne au bout de 6 s (« Achievements unavailable », 2026-10-25).
    if (lite) {
      const [shown, liteTitle, liteBio] = await redis([['HGET', 'names', id], ['HGET', 'titles', id], ['HGET', 'bio', id]]);
      const lst = await readStats(id);
      const [liteUniq] = await redis([['SCARD', `nums:${id}`]]);
      // xp / rolls : les totaux à vie tenus par le serveur, affichés à l'accueil et dans Stats à la place des totaux de
      // l'appareil, qui ne gardent qu'une partie des tirages (« Stats bug » sur Discord, 2026-10-26).
      return send(res, 200, { name: shown || name, achievements: Achievements.unlocked(lst), title: liteTitle || null, xp: Number(lst.xpLife) || 0, rolls: Number(lst.rolls) || 0, bio: bioText(liteBio), uniq: uniqueOf(lst, liteUniq, null) });
    }

    // Lenteurs du serveur (2026-10-25) : relire les 100 000 tirages d'un gros joueur à chaque visite de son profil
    // bloquait Redis et le processus Node plusieurs secondes (et, l'historique étant plafonné, le cache ne servait plus
    // jamais). Si ses totaux sont déjà en mémoire, on ne lit que les tirages arrivés depuis (ZRANGEBYSCORE : le score
    // est l'heure du tirage) ; la lecture complète ne se fait qu'au premier passage, puis au plus toutes les 6 heures.
    // Après un redémarrage (chaque déploiement), la mémoire est vide : les totaux sont aussi gardés dans Redis (pagg:<id>),
    // sinon chaque gros profil recalculait ses 100 000 tirages juste après la mise à jour et ralentissait tout le monde.
    if (!AGG.has(id)) { try { const [raw] = await redis([['GET', paggKey(id)]]); if (raw) AGG.set(id, JSON.parse(raw)); } catch (e) { /* recalculé */ } }
    const prev0 = AGG.get(id), cached = prev0 && Date.now() - prev0.at < AGG_TTL_MS;
    const [members, shownName, bestAll, rank, title, h2hFlat, ownedSkins, ownedWalls, skin, discordName, histSize, bioRaw, lbXp, countAll] = await redis([
      cached ? ['ZRANGEBYSCORE', historyKey(id), `(${prev0.lastT}`, '+inf'] : ['ZRANGE', historyKey(id), 0, -1],
      ['HGET', 'names', id],
      ['HGET', 'best:all', id],
      ['ZREVRANK', 'lb:all', id],
      ['HGET', 'titles', id],
      ['HGETALL', `h2h:${id}`],
      // Inventaire visible par tous (idée de kaz, 2026-10-17) : skins et fonds d'écran achetés ou gagnés.
      ['SMEMBERS', `skins:${id}`],
      ['SMEMBERS', `walls:${id}`],
      ['HGET', 'skins', id], // skin équipé : le meilleur tirage s'affiche avec, en tête du profil
      ['HGET', statsKey(id), 'discordName'],
      ['ZCARD', historyKey(id)],
      ['HGET', 'bio', id], // « About me » (idée de Niall, 2026-10-27, api/_bio.js)
      // Totaux à vie du classement (voir lifeRolls plus bas) : XP à vie et nombre de tirages à vie.
      ['ZSCORE', XP_LB, id],
      ['HGET', 'count:all', id],
    ]);
    // Clan du joueur (api/_clan.js) : tag, nom et emoji, affichés sous son nom.
    const [cid] = await redis([['HGET', 'clanof', id]]);
    const [cinfo] = cid ? await redis([['HMGET', `clan:${cid}`, 'name', 'tag', 'emoji', 'tagc']]) : [null];
    const clan = cinfo && cinfo[1] ? { name: cinfo[0], tag: cinfo[1], emoji: cinfo[2], c: cinfo[3] || 'plain' } : null;
    const stats = await readStats(id);
    const [numsCount] = await redis([['SCARD', `nums:${id}`]]);
    // Badges Top 1 / 5 / 10 des mois finis : tous, et le meilleur (rang, puis le plus récent) pour l'en-tête.
    const tops = await awardsOf(id);
    const top = tops.slice().sort((a, b) => a.top - b.top || (a.month < b.month ? 1 : -1))[0] || null;
    const achievements = Achievements.unlocked(stats);

    // Duels : bilan, rivaux les plus affrontés (face-à-face) et bilan contre celui qui regarde.
    const h2h = new Map();
    for (let i = 0; i < (h2hFlat || []).length; i += 2) {
      const [kind, other] = [h2hFlat[i].slice(0, 1), h2hFlat[i].slice(2)];
      const e = h2h.get(other) || { w: 0, l: 0 };
      e[kind === 'w' ? 'w' : 'l'] += Number(h2hFlat[i + 1]);
      h2h.set(other, e);
    }
    const rivalIds = [...h2h.keys()].filter(o => o !== me).sort((a, b) => (h2h.get(b).w + h2h.get(b).l) - (h2h.get(a).w + h2h.get(a).l)).slice(0, 5);
    const [rivalNames] = rivalIds.length ? await redis([['HMGET', 'names', ...rivalIds]]) : [[]];
    const duels = {
      played: Number(stats.duels || 0),
      won: Number(stats.duelWins || 0),
      rivals: rivalIds.map((o, i) => ({ name: rivalNames[i] || 'Player', ...h2h.get(o) })),
      vsMe: me && me !== id ? h2h.get(me) || { w: 0, l: 0 } : null, // vu de ce joueur : w = ses victoires contre moi
    };

    // Historique effacé ou remplacé depuis le dernier calcul : on repart de zéro.
    // Aussi quand le meilleur tirage all-time avait été ajouté à la main (hors historique) : il faut le redédoublonner.
    const prev = cached && !prev0.padded && Number(histSize) >= Math.min(prev0.size, HISTORY_CAP) ? prev0 : null;
    let fresh = members || [];
    if (cached && !prev) fresh = (await redis([['ZRANGE', historyKey(id), 0, -1]]))[0] || [];
    // Premier calcul : le meilleur tirage all-time y est ajouté s'il date d'avant l'historique serveur.
    // Comparé par nombre seul : un vieux tirage envoyé par l'appareil porte l'heure de l'appareil, pas celle du serveur.
    let padded = false;
    if (!prev && bestAll) {
      const d = JSON.parse(bestAll);
      if (!fresh.some(m => m.endsWith(`:${d.n}`))) { fresh.push(`${d.t}:${d.n}`); padded = true; }
    }
    // Les doublons d'un même tirage déjà en base (voir rollSet) ne comptent qu'une fois.
    const known = rollSet();
    const rolls = fresh.map(m => m.split(':').map(Number)).sort((a, b) => a[0] - b[0]).filter(([t, n]) => known.add(n, t));

    // ~70 µs par tirage : 7 s pour un historique plein (100 000 tirages). Les totaux restent en mémoire ; ensuite seuls
    // les nouveaux tirages sont analysés, et les meilleurs / pires tirages sont tenus à jour au lieu d'être recalculés.
    const analyze = n => engine.analyze(n);
    let lifetime = prev ? prev.lifetime : 0, percentileSum = prev ? prev.percentileSum : 0;
    const badges = prev ? Object.fromEntries(Object.entries(prev.badges).map(([k, v]) => [k, v.slice()])) : {}, tiers = prev ? { ...prev.tiers } : {};
    let step = 0;
    for (const [, n] of rolls) {
      if (++step % 2000 === 0) await breathe(); // gros historique : laisse passer les autres demandes
      const a = analyze(n);
      lifetime += a.total;
      percentileSum += a.percentile;
      tiers[a.tier] = (tiers[a.tier] || 0) + 1;
      for (const b of a.earnedIds) {
        if (badges[b]) badges[b][0]++;
        else badges[b] = [1, n];
      }
    }
    const scored = rolls.map(([t, n]) => ({ n, s: engine.scoreOf(n), t }));
    const best = [...(prev ? prev.best : []), ...scored].sort((x, y) => y.s - x.s || x.t - y.t).slice(0, BEST_LIMIT);
    // Les 10 pires tirages (idée d'Angelicide9, 2026-10-17), le plus mauvais en premier.
    const worst = [...(prev ? prev.worst : []), ...scored].sort((x, y) => x.s - y.s || x.t - y.t).slice(0, 10);
    const count = (prev ? prev.count : 0) + rolls.length;
    const since = prev ? prev.since : rolls.length ? rolls[0][0] : null;
    const lastT = rolls.length ? rolls[rolls.length - 1][0] : prev ? prev.lastT : null;
    // Joueur sans set nums (voir uniqueOf) : compté sur l'historique relu en entier, gardé avec les totaux.
    const uniqFull = prev ? (prev.uniq ?? null) : stats.dv === '1' ? null : new Set(rolls.map(([, n]) => n)).size;
    if (count) {
      AGG.delete(id); // remis en dernier : les profils les moins vus sortent de la mémoire en premier
      const agg = { at: prev ? prev.at : Date.now(), padded, size: Number(histSize) || 0, count, since, lastT, lifetime, percentileSum, badges, tiers, best, worst, uniq: uniqFull };
      AGG.set(id, agg);
      if (AGG.size > 300) AGG.delete(AGG.keys().next().value);
      // Gardé dans Redis seulement pour les gros historiques (ceux qui coûtent à recalculer), jusqu'au recalcul complet.
      if (count >= PAGG_MIN) await redis([['SET', paggKey(id), JSON.stringify(agg), 'PX', Math.max(1000, agg.at + AGG_TTL_MS - Date.now())]]);
    }

    // Totaux à vie (2026-10-30, signalé par jsand, kaz, Raynarr00 et LeSombre) : l'historique ne garde que les
    // HISTORY_CAP (100 000) derniers tirages, donc le profil et la comparaison restaient bloqués à 99 999 tirages, et
    // l'XP à vie y avait jusqu'à 2 milliards de moins qu'au classement. Tirages et XP à vie viennent maintenant des
    // compteurs du classement (count:all et lb:xp, stats.rolls en secours) ; la chance, les meilleurs / pires tirages et
    // les badges restent calculés sur les tirages relus (window).
    const lifeRolls = Math.max(count, Number(countAll) || 0, Number(stats.rolls) || 0);
    const lifeXp = Math.max(lifetime, Number(lbXp) || 0);
    // Raretés : compteurs à vie des stats (t:<rareté>) quand l'historique ne couvre pas tous les tirages.
    const lifeTiers = lifeRolls > count ? Object.fromEntries(engine.TIER_ORDER.map(k => [k, Math.max(tiers[k] || 0, Number(stats[`t:${k}`]) || 0)]).filter(([, v]) => v)) : tiers;

    return send(res, 200, {
      name: shownName || name,
      rolls: lifeRolls,
      lifetime: lifeXp,
      window: count, // tirages relus dans l'historique (chance, meilleurs et pires tirages, badges)
      since: Number(stats.first) && (!since || Number(stats.first) < since) ? Number(stats.first) : since, // premier tirage, même sorti de l'historique
      last: lastT,
      rank: rank === null ? null : Number(rank) + 1,
      // Chance = percentile moyen des tirages (50 attendu) ; tiers = nombre de tirages par rareté de carte.
      luck: count ? Math.round((percentileSum / count) * 10) / 10 : null,
      tiers: lifeTiers,
      best,
      worst,
      skin: Shop.resolve(skin) || 'classic', discord: discordName || null,
      inventory: { skins: (ownedSkins || []).filter(k => k !== 'owner'), walls: ownedWalls || [] },
      badges,
      achievements, // succès débloqués (stats du serveur) et titre équipé
      title: title || null, clan, bio: bioText(bioRaw),
      top, tops, // badges Top 1 / 5 / 10 gagnés à la fin d'un mois : { top, month }
      duels,
      questBest: Number(stats.qsBest) || 0,
      uniq: uniqueOf(stats, numsCount, uniqFull), // nombres différents tirés (idée de jsand, 2026-10-27)
      clanMvp: Number(stats.clanMvp) || 0, // semaines où il a été le MVP du clan n°1 (idée de PRISMA123, 2026-10-27)
      spent: Number(stats.spent) || 0, cases: Number(stats.cases) || 0, // pièces dépensées et caisses ouvertes (idée de PRISMA123, 2026-10-20)
      level: require('../js/quests.js').levelOf(stats.xpLife), // niveau du joueur (XP à vie) // meilleure série de jours avec toutes les quêtes finies
    });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
