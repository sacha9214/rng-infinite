/* RNG∞ — quêtes du jour et série de connexion.
 * Pur JS, chargeable dans le navigateur (window.RNGQuests) et dans Node (module.exports).
 * Chaque jour (UTC), 5 quêtes identiques pour tout le monde : tirages, XP, rareté, duel, casino (5 depuis le 2026-10-16).
 * Les finir toutes le même jour fait monter la série de quêtes (questStreak), avec un bonus « tout fini » qui grossit.
 * La progression se lit sur les compteurs du jour tenus par le serveur (q:<jour>:<id>) : rolls, xp, t:<rareté>,
 * duels (parties finies, bots compris), duelWins (victoires contre de vrais joueurs).
 */
(function (root) {
  'use strict';

  const TIERS = ['landwaste', 'garbage', 'trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'infinite'];
  const num = v => Number(v) || 0;
  const atLeast = (c, tier) => TIERS.slice(TIERS.indexOf(tier)).reduce((x, t) => x + num(c[`t:${t}`]), 0);

  // group : une quête de chaque groupe par jour. value(c) = progression lue sur les compteurs du jour.
  const POOL = [
    { id: 'roll20', group: 'rolls', emoji: '🎲', text: 'Make 20 rolls', target: 20, reward: 30, value: c => num(c.rolls) },
    { id: 'roll40', group: 'rolls', emoji: '🎲', text: 'Make 40 rolls', target: 40, reward: 50, value: c => num(c.rolls) },
    { id: 'roll60', group: 'rolls', emoji: '🎲', text: 'Make 60 rolls', target: 60, reward: 70, value: c => num(c.rolls) },
    { id: 'xp100k', group: 'xp', emoji: '⚡', text: 'Earn 100,000 XP', target: 100000, reward: 40, value: c => num(c.xp) },
    { id: 'xp500k', group: 'xp', emoji: '⚡', text: 'Earn 500,000 XP', target: 500000, reward: 60, value: c => num(c.xp) },
    { id: 'xp1m', group: 'xp', emoji: '⚡', text: 'Earn 1,000,000 XP', target: 1000000, reward: 80, value: c => num(c.xp) },
    { id: 'unc8', group: 'rarity', emoji: '🟩', text: 'Roll 8 Uncommon or better', target: 8, reward: 30, value: c => atLeast(c, 'uncommon') },
    { id: 'rare3', group: 'rarity', emoji: '🟦', text: 'Roll 3 Rare or better', target: 3, reward: 45, value: c => atLeast(c, 'rare') },
    { id: 'epic1', group: 'rarity', emoji: '🟪', text: 'Roll an Epic or better', target: 1, reward: 60, value: c => atLeast(c, 'epic') },
    { id: 'duel1', group: 'duel', emoji: '⚔️', text: 'Finish a duel (bots count)', target: 1, reward: 30, value: c => num(c.duels) },
    { id: 'duel3', group: 'duel', emoji: '⚔️', text: 'Finish 3 duels (bots count)', target: 3, reward: 60, value: c => num(c.duels) },
    { id: 'win1', group: 'duel', emoji: '🏆', text: 'Win a duel against a player', target: 1, reward: 80, value: c => num(c.duelWins) },
    // Casino (compteurs du jour posés par api/_gamble.js) : le casino s'ouvre à 30 tirages.
    { id: 'cas5', group: 'casino', emoji: '🎰', text: 'Play 5 casino rounds', target: 5, reward: 25, value: c => num(c.casino) },
    { id: 'cas15', group: 'casino', emoji: '🎰', text: 'Play 15 casino rounds', target: 15, reward: 40, value: c => num(c.casino) },
    { id: 'bet500', group: 'casino', emoji: '🪙', text: 'Bet 500 coins in the casino', target: 500, reward: 40, value: c => num(c.casinoBet) },
  ];
  const byId = new Map(POOL.map(q => [q.id, q]));
  const GROUPS = ['rolls', 'xp', 'rarity', 'duel', 'casino'];

  // Petit hachage déterministe d'un texte (FNV-1a) : le même jour donne les mêmes quêtes partout.
  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Les 5 quêtes d'un jour "AAAA-MM-JJ".
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

  // Série de quêtes (idée d'un joueur, 2026-10-16) : un jour compte quand ses 5 quêtes sont réclamées. Bonus « tout fini » :
  // 50 pièces le 1er jour, +25 par jour de série, plafonné à 300 (11 jours et plus) ; en plus, 500 au 7e jour et 2 000 au 30e.
  const QUEST_STREAK_CAP = 11;
  const allDoneReward = streak => 50 + 25 * (Math.min(QUEST_STREAK_CAP, Math.max(1, streak)) - 1) + (streak === 7 ? 500 : 0) + (streak === 30 ? 2000 : 0);

  // Niveaux (idée de PRISMA123, 2026-10-16) : le niveau monte avec l'XP à vie (stats.xpLife). Niveau L dès L² × 200 000 XP :
  // 1 vers 30 tirages, 10 vers 20 M d'XP, 20 vers 80 M. Chaque niveau donne 25 × L pièces ; tous les 5 niveaux une clé
  // de Starter Case, tous les 25 une clé de Premium Case (à la place). Pas de rattrapage : un joueur d'avant les niveaux
  // part de son niveau du jour (stats.lvlPaid posé à la première lecture).
  const LEVEL_XP = 200000;
  const levelOf = xp => Math.floor(Math.sqrt(Math.max(0, num(xp)) / LEVEL_XP));
  const xpForLevel = L => L * L * LEVEL_XP;
  const levelReward = L => ({ coins: 25 * L, key: L % 25 === 0 ? 'premium' : L % 5 === 0 ? 'starter' : null });

  const api = { POOL, byId, ofDay, progress, dailyReward, nextStreak, dayBefore, STREAK_CAP, allDoneReward, QUEST_STREAK_CAP, levelOf, xpForLevel, levelReward, LEVEL_XP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGQuests = api;
})(typeof window !== 'undefined' ? window : globalThis);
