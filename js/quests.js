/* RNG∞ — quêtes du jour et série de connexion.
 * Pur JS, chargeable dans le navigateur (window.RNGQuests) et dans Node (module.exports).
 * Chaque jour (UTC), 3 quêtes identiques pour tout le monde : une de tirages, une de rareté, une de duel.
 * La progression se lit sur les compteurs du jour tenus par le serveur (q:<jour>:<id>) : rolls, xp, t:<rareté>,
 * duels (parties finies, bots compris), duelWins (victoires contre de vrais joueurs).
 */
(function (root) {
  'use strict';

  const TIERS = ['trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'infinite'];
  const num = v => Number(v) || 0;
  const atLeast = (c, tier) => TIERS.slice(TIERS.indexOf(tier)).reduce((x, t) => x + num(c[`t:${t}`]), 0);

  // group : une quête de chaque groupe par jour. value(c) = progression lue sur les compteurs du jour.
  const POOL = [
    { id: 'roll20', group: 'rolls', emoji: '🎲', text: 'Make 20 rolls', target: 20, reward: 30, value: c => num(c.rolls) },
    { id: 'roll40', group: 'rolls', emoji: '🎲', text: 'Make 40 rolls', target: 40, reward: 50, value: c => num(c.rolls) },
    { id: 'xp100k', group: 'rolls', emoji: '⚡', text: 'Earn 100,000 XP', target: 100000, reward: 40, value: c => num(c.xp) },
    { id: 'unc8', group: 'rarity', emoji: '🟩', text: 'Roll 8 Uncommon or better', target: 8, reward: 30, value: c => atLeast(c, 'uncommon') },
    { id: 'rare3', group: 'rarity', emoji: '🟦', text: 'Roll 3 Rare or better', target: 3, reward: 45, value: c => atLeast(c, 'rare') },
    { id: 'epic1', group: 'rarity', emoji: '🟪', text: 'Roll an Epic or better', target: 1, reward: 60, value: c => atLeast(c, 'epic') },
    { id: 'duel1', group: 'duel', emoji: '⚔️', text: 'Finish a duel (bots count)', target: 1, reward: 30, value: c => num(c.duels) },
    { id: 'duel3', group: 'duel', emoji: '⚔️', text: 'Finish 3 duels (bots count)', target: 3, reward: 60, value: c => num(c.duels) },
    { id: 'win1', group: 'duel', emoji: '🏆', text: 'Win a duel against a player', target: 1, reward: 80, value: c => num(c.duelWins) },
  ];
  const byId = new Map(POOL.map(q => [q.id, q]));
  const GROUPS = ['rolls', 'rarity', 'duel'];

  // Petit hachage déterministe d'un texte (FNV-1a) : le même jour donne les mêmes quêtes partout.
  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Les 3 quêtes d'un jour "AAAA-MM-JJ".
  function ofDay(day) {
    return GROUPS.map(g => {
      const list = POOL.filter(q => q.group === g);
      return list[hash(`${day}:${g}`) % list.length];
    });
  }
  const progress = (quest, counters) => Math.min(quest.target, quest.value(counters || {}));

  // Bonus quotidien : 20 pièces le 1er jour, +10 par jour de série, plafonné à 80 (7 jours et plus).
  const STREAK_CAP = 7;
  const dailyReward = streak => 20 + 10 * (Math.min(STREAK_CAP, Math.max(1, streak)) - 1);
  const dayBefore = day => new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  // Série après une réclamation faite `day`, sachant la dernière (`lastDay`) et la série d'alors.
  const nextStreak = (day, lastDay, streak) => (lastDay === dayBefore(day) ? num(streak) + 1 : 1);

  const api = { POOL, byId, ofDay, progress, dailyReward, nextStreak, dayBefore, STREAK_CAP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGQuests = api;
})(typeof window !== 'undefined' ? window : globalThis);
