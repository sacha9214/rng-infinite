// Badges Top 1 / Top 5 / Top 10 : la place actuelle d'un joueur dans le classement du mois.
// Ils ne s'obtiennent qu'en étant dans ce classement : sortir du top 10 (ou changer de mois) les retire.
// top = 1 (1re place), 5 (2e à 5e), 10 (6e à 10e).
const { redis, scopes } = require('./_lib');

const TOP_SIZE = 10;
const markOf = place => (place === 1 ? 1 : place <= 5 ? 5 : place <= TOP_SIZE ? 10 : null);

// Map identifiant → 1 | 5 | 10 pour les dix premiers du mois en cours.
async function monthTop(t = Date.now()) {
  const scope = scopes(t).find(p => p.period === 'month');
  const [ids] = await redis([['ZREVRANGE', scope.lb, 0, TOP_SIZE - 1]]);
  return new Map((ids || []).map((id, i) => [id, markOf(i + 1)]));
}

module.exports = { monthTop, markOf, TOP_SIZE };
