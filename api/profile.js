// GET /api/profile?name=<nom>&me=<playerId>   (me : facultatif, pour le face-à-face avec celui qui regarde)
// Profil public d'un joueur, ouvert depuis le classement : ses meilleurs tirages et sa collection de badges.
// Calculé à partir de son historique (hist:<id>), comme ses propres pages History et Badges ; le classement,
// lui, ne compte que les tirages faits par le serveur. Ni l'identifiant ni la liste complète des tirages ne sortent d'ici.
const { breathe, engine, redis, cleanName, findPlayer, historyKey, rollSet, readStats, Achievements, cors, send, flushDue } = require('./_lib');
const { awardsOf } = require('./_rank');

const BEST_LIMIT = 10;

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const name = cleanName(params.get('name'));
    const me = /^[0-9a-f]{16}$/.test(params.get('me') || '') ? params.get('me') : '';
    if (!name) return send(res, 400, { error: 'Missing player name' });
    const id = await findPlayer(name);
    if (!id) return send(res, 404, { error: 'No player with this name' });

    const [members, shownName, bestAll, rank, title, h2hFlat, ownedSkins, ownedWalls] = await redis([
      ['ZRANGE', historyKey(id), 0, -1],
      ['HGET', 'names', id],
      ['HGET', 'best:all', id],
      ['ZREVRANK', 'lb:all', id],
      ['HGET', 'titles', id],
      ['HGETALL', `h2h:${id}`],
      // Inventaire visible par tous (idée de kaz, 2026-10-17) : skins et fonds d'écran achetés ou gagnés.
      ['SMEMBERS', `skins:${id}`],
      ['SMEMBERS', `walls:${id}`],
    ]);
    const stats = await readStats(id);
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

    // Historique trié par date ; le meilleur tirage all-time y est ajouté s'il date d'avant l'historique serveur.
    // Comparé par nombre seul : un vieux tirage envoyé par l'appareil porte l'heure de l'appareil, pas celle du serveur.
    if (bestAll) {
      const d = JSON.parse(bestAll);
      if (!members.some(m => m.endsWith(`:${d.n}`))) members.push(`${d.t}:${d.n}`);
    }
    // Les doublons d'un même tirage déjà en base (voir rollSet) ne comptent qu'une fois.
    const known = rollSet();
    const rolls = members.map(m => m.split(':').map(Number)).sort((a, b) => a[0] - b[0]).filter(([t, n]) => known.add(n, t));

    // ~20 µs par nombre distinct : 2 s au pire pour un historique plein (100 000 tirages).
    const analyses = new Map();
    const analyze = n => analyses.get(n) || (analyses.set(n, engine.analyze(n)), analyses.get(n));
    let lifetime = 0, percentileSum = 0;
    const badges = {}, tiers = {};
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
    const scored = rolls.map(([t, n]) => ({ n, s: analyze(n).total, t }));
    const best = scored.slice().sort((x, y) => y.s - x.s || x.t - y.t).slice(0, BEST_LIMIT);
    // Les 10 pires tirages (idée d'Angelicide9, 2026-10-17), le plus mauvais en premier.
    const worst = scored.sort((x, y) => x.s - y.s || x.t - y.t).slice(0, 10);

    return send(res, 200, {
      name: shownName || name,
      rolls: rolls.length,
      lifetime,
      since: rolls.length ? rolls[0][0] : null,
      last: rolls.length ? rolls[rolls.length - 1][0] : null,
      rank: rank === null ? null : Number(rank) + 1,
      // Chance = percentile moyen des tirages (50 attendu) ; tiers = nombre de tirages par rareté de carte.
      luck: rolls.length ? Math.round((percentileSum / rolls.length) * 10) / 10 : null,
      tiers,
      best,
      worst,
      inventory: { skins: (ownedSkins || []).filter(k => k !== 'owner'), walls: ownedWalls || [] },
      badges,
      achievements, // succès débloqués (stats du serveur) et titre équipé
      title: title || null,
      top, tops, // badges Top 1 / 5 / 10 gagnés à la fin d'un mois : { top, month }
      duels,
      questBest: Number(stats.qsBest) || 0,
      level: require('../js/quests.js').levelOf(stats.xpLife), // niveau du joueur (XP à vie) // meilleure série de jours avec toutes les quêtes finies
    });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
