/* RNG∞ — quêtes du jour et série de connexion.
 * Pur JS, chargeable dans le navigateur (window.RNGQuests) et dans Node (module.exports).
 * Chaque jour (UTC), 5 quêtes identiques pour tout le monde : tirages, XP, rareté, duel, casino (5 depuis le 2026-10-16).
 * Les finir toutes le même jour fait monter la série de quêtes (questStreak), avec un bonus « tout fini » qui grossit.
 * La progression se lit sur les compteurs du jour tenus par le serveur (q:<jour>:<id>) : rolls, xp, t:<rareté>,
 * duels (parties finies, bots compris), duelWins (victoires contre de vrais joueurs).
 */
(function (root) {
  'use strict';

  const TIERS = ['landwaste', 'garbage', 'trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite'];
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
  // 10 × L pièces (25 × L le premier jour : trop généreux, environ 30 % de pièces en plus de celles des tirages).
  const levelReward = L => ({ coins: 10 * L, key: L % 25 === 0 ? 'premium' : L % 5 === 0 ? 'starter' : null });
  // Rattrapage, une seule fois, pour les joueurs arrivés avec un niveau (stats.lvlPaid posé à leur niveau d'alors) :
  // les clés de ces niveaux (au plus 4 Starter et 1 Premium) et leurs pièces, plafonnées à 1 000.
  const CATCHUP = { coins: 1000, starter: 4, premium: 1 };
  const catchUp = upTo => {
    let coins = 0, starter = 0, premium = 0;
    for (let l = 1; l <= upTo; l++) { const r = levelReward(l); coins += r.coins; if (r.key === 'starter') starter++; if (r.key === 'premium') premium++; }
    return { coins: Math.min(CATCHUP.coins, coins), keys: [...Array(Math.min(CATCHUP.starter, starter)).fill('starter'), ...Array(Math.min(CATCHUP.premium, premium)).fill('premium')] };
  };

  // Quêtes de la semaine (idée de Tumored, 2026-10-27) : 3 par semaine ISO (reset le lundi 00:00 UTC), une par groupe,
  // les mêmes pour tous, lues sur les compteurs de la semaine (qw:<semaine>:<id>, tenus par le serveur : rolls, t:<rareté>
  // pour Epic et mieux, days = jours où les 5 quêtes du jour ont été finies). Tumored proposait ~2 500 pièces pour
  // « 5 Anomaly » : un Anomaly ou mieux sort 1 fois sur 20, soit ~100 tirages (15 min), plus que les pièces d'une journée
  // de tirages ; on reste donc entre 300 et 700 par quête. Une semaine rapporte 1 000 à 1 800 pièces (~1 350 en moyenne),
  // soit moins de 10 % de ce que gagne en tirages un joueur qui fait 500 tirages par jour (~4,7 pièces par tirage).
  const WEEK_POOL = [
    { id: 'w-roll400', group: 'rolls', emoji: '🎲', text: 'Make 400 rolls this week', target: 400, reward: 300, value: c => num(c.rolls) },
    { id: 'w-roll700', group: 'rolls', emoji: '🎲', text: 'Make 700 rolls this week', target: 700, reward: 450, value: c => num(c.rolls) },
    { id: 'w-roll1000', group: 'rolls', emoji: '🎲', text: 'Make 1,000 rolls this week', target: 1000, reward: 600, value: c => num(c.rolls) },
    { id: 'w-anom5', group: 'rarity', emoji: '🌋', text: 'Roll 5 Anomaly or better', target: 5, reward: 300, value: c => atLeast(c, 'anomaly') },
    { id: 'w-epic15', group: 'rarity', emoji: '🟪', text: 'Roll 15 Epic or better', target: 15, reward: 350, value: c => atLeast(c, 'epic') },
    { id: 'w-myth2', group: 'rarity', emoji: '🔮', text: 'Roll 2 Mythic or better', target: 2, reward: 500, value: c => atLeast(c, 'mythic') },
    { id: 'w-days3', group: 'days', emoji: '📅', text: 'Finish all daily quests on 3 days', target: 3, reward: 400, value: c => num(c.days) },
    { id: 'w-days4', group: 'days', emoji: '📅', text: 'Finish all daily quests on 4 days', target: 4, reward: 550, value: c => num(c.days) },
    { id: 'w-days5', group: 'days', emoji: '📅', text: 'Finish all daily quests on 5 days', target: 5, reward: 700, value: c => num(c.days) },
  ];
  const WEEK_GROUPS = ['rolls', 'rarity', 'days'];
  const ofWeek = week => WEEK_GROUPS.map(g => { const list = WEEK_POOL.filter(q => q.group === g); return list[hash(`${week}:week:${g}`) % list.length]; });

  // Coffre des quêtes (idée de Sean, 2026-10-27) : les jours où les 5 quêtes du jour ont été finies (stats.qdays, à vie,
  // jamais remis à zéro) ouvrent des coffres aux paliers, une fois chacun (stats.qchest = coffres déjà ouverts).
  // Un jour « tout fini » rapporte déjà ~250 pièces de quêtes + 50 à 300 de bonus ; les coffres ajoutent 20 250 pièces
  // sur 365 jours finis, soit ~55 par jour fini (environ +15 %), étalées pour récompenser la régularité.
  const CHESTS = [{ at: 4, coins: 250 }, { at: 10, coins: 500 }, { at: 25, coins: 1000 }, { at: 50, coins: 2000 }, { at: 100, coins: 3500 }, { at: 200, coins: 5000 }, { at: 365, coins: 8000 }];
  // Coffres prêts à ouvrir : ceux d'après les déjà ouverts dont le palier est atteint.
  const chestsReady = (days, opened) => CHESTS.slice(Math.max(0, num(opened))).filter(c => num(days) >= c.at);

  const api = { WEEK_POOL, ofWeek, CHESTS, chestsReady, POOL, byId, ofDay, progress, dailyReward, nextStreak, dayBefore, STREAK_CAP, allDoneReward, QUEST_STREAK_CAP, levelOf, xpForLevel, levelReward, LEVEL_XP, catchUp, CATCHUP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGQuests = api;
})(typeof window !== 'undefined' ? window : globalThis);
