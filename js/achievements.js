/* RNG∞ — succès et titres.
 * Pur JS, chargeable dans le navigateur (window.RNGAchievements) et dans Node (module.exports).
 * Chaque succès se lit sur les stats du joueur tenues par le serveur (stats:<id>) : un titre ne s'équipe que débloqué.
 * stats = { rolls, 't:<rareté>', best, badges (nombre de badges différents), drastix, year2026, dayTop, duelWins, flawless, bigWin, xpWin }
 */
(function (root) {
  'use strict';

  const TIERS = ['landwaste', 'garbage', 'trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite'];
  const num = v => Number(v) || 0;
  // Victoires de duel qui comptent pour les succès : sans celles « sans enjeu » (anti-farm, champ duelUnpaid).
  const ranked = st => Math.max(0, num(st.duelWins) - num(st.duelUnpaid));
  const atLeast = (st, tier) => TIERS.slice(TIERS.indexOf(tier)).reduce((x, t) => x + num(st[`t:${t}`]), 0);

  const LIST = [
    { id: 'rookie', emoji: '🎲', title: 'Rookie', desc: 'Make your first roll', test: st => num(st.rolls) >= 1 },
    { id: 'regular', emoji: '🔁', title: 'Regular', desc: 'Make 100 rolls', test: st => num(st.rolls) >= 100 },
    { id: 'addict', emoji: '🌀', title: 'Addict', desc: 'Make 1,000 rolls', test: st => num(st.rolls) >= 1000 },
    { id: 'nolife', emoji: '🧟', title: 'No Life', desc: 'Make 10,000 rolls', test: st => num(st.rolls) >= 10000 },
    { id: 'cursed', emoji: '🪦', title: 'Cursed', desc: 'Roll a Trash number (bottom 1%)', test: st => num(st['t:trash']) >= 1 },
    { id: 'lucky', emoji: '🍀', title: 'Lucky', desc: 'Roll a Rare or better', test: st => atLeast(st, 'rare') >= 1 },
    { id: 'blessed', emoji: '✨', title: 'Blessed', desc: 'Roll an Epic or better', test: st => atLeast(st, 'epic') >= 1 },
    { id: 'anomaly', emoji: '🌋', title: 'Anomaly', desc: 'Roll an Anomaly or better', test: st => atLeast(st, 'anomaly') >= 1 },
    { id: 'mythic', emoji: '🔮', title: 'Mythic', desc: 'Roll a Mythic or better (top 1%)', test: st => atLeast(st, 'mythic') >= 1 },
    { id: 'chosen', emoji: '👁️', title: 'Chosen One', desc: 'Roll 10 Mythics or better', test: st => atLeast(st, 'mythic') >= 10 },
    { id: 'celestial', emoji: '🌠', title: 'Celestial', desc: 'Roll a Celestial or better (top 0.1%)', test: st => atLeast(st, 'celestial') >= 1 },
    { id: 'godlike', emoji: '⚜️', title: 'Godlike', desc: 'Roll a Godlike or better (top 0.005%)', test: st => atLeast(st, 'godlike') >= 1 },
    { id: 'divine', emoji: '👼', title: 'Divine', desc: 'Roll a Divine or better (top 0.01%)', test: st => atLeast(st, 'divine') >= 1 },
    { id: 'infinite', emoji: '♾️', title: 'Infinite', desc: 'Roll an Infinite (top 0.001%: one of the 9 best numbers in the game)', test: st => num(st['t:infinite']) >= 1 },
    // XP à vie (idée d'Avaneesh_17, 2026-10-16) : stats.xpLife, tenue à chaque tirage et recalculée avec le classement.
    { id: 'centimillionaire', emoji: '💎', title: 'Centimillionaire', desc: 'Reach 100,000,000 lifetime XP', test: st => num(st.xpLife) >= 1e8 },
    { id: 'billionaire', emoji: '🏦', title: 'Billionaire', desc: 'Reach 1,000,000,000 lifetime XP', test: st => num(st.xpLife) >= 1e9 },
    { id: 'millionaire', emoji: '💰', title: 'Millionaire', desc: 'Roll a number worth 1,000,000 XP or more', test: st => num(st.best) >= 1000000 },
    { id: 'drastix', emoji: '💥', title: 'Drastix Fan', desc: 'Earn the Drastix badge (a number containing 235)', test: st => num(st.drastix) >= 1 },
    { id: 'year2026', emoji: '📅', title: '2026', desc: 'Earn the Current Year badge (a number containing 2026)', test: st => num(st.year2026) >= 1 },
    { id: 'collector', emoji: '📦', title: 'Collector', desc: 'Find 50 different badges', test: st => num(st.badges) >= 50 },
    { id: 'hoarder', emoji: '🗄️', title: 'Hoarder', desc: 'Find 100 different badges', test: st => num(st.badges) >= 100 },
    { id: 'completionist', emoji: '🏛️', title: 'Completionist', desc: 'Find 150 different badges', test: st => num(st.badges) >= 150 },
    { id: 'daily', emoji: '👑', title: 'Daily King', desc: 'Hold the best roll of the day on the leaderboard', test: st => num(st.dayTop) >= 1 },
    { id: 'duelist', emoji: '⚔️', title: 'Duelist', desc: 'Win a duel', test: st => ranked(st) >= 1 },
    { id: 'gladiator', emoji: '🛡️', title: 'Gladiator', desc: 'Win 10 duels', test: st => ranked(st) >= 10 },
    { id: 'flawless', emoji: '💎', title: 'Flawless', desc: 'Win a rounds duel (first to 2 or more) without anyone else winning a round', test: st => num(st.flawless) >= 1 },
    { id: 'warlord', emoji: '🏰', title: 'Warlord', desc: 'Win a duel with 5 players or more', test: st => num(st.bigWin) >= 1 },
    { id: 'speedrunner', emoji: '⚡', title: 'Speedrunner', desc: 'Win an XP race duel', test: st => num(st.xpWin) >= 1 },
    // Remerciement : contribution à la cagnotte du serveur (aucun avantage en jeu).
    { id: 'supporter', emoji: '💗', title: 'Supporter', desc: 'Contribute to the server fund', test: st => num(st.supporter) >= 1 },
    // Réservé au créateur du site (marqué à sa connexion Google) ; caché aux autres, même verrouillé.
    // Code SPOOKYMONTH (Halloween 2026) : caché à ceux qui ne l'ont pas, pour ne pas dévoiler le code.
    { id: 'gatekeep', emoji: '🚧', title: 'Gatekeep', desc: 'Redeemed the BC code', hidden: true, test: st => num(st.gatekeep) >= 1 },
    { id: 'spooky', emoji: '🎃', title: 'Spooky', desc: 'Redeemed the Halloween 2026 code', hidden: true, test: st => num(st.spooky) >= 1 },
    // Visible verrouillé (2026-10-16) : les joueurs savent qu'il y a 3 codes à chercher.
    { id: 'bughunter', emoji: '🐛', title: 'Bug Hunter', desc: 'Report a bug that gets fixed', test: st => num(st.bugsFixed) >= 1 },
    { id: 'contributor', emoji: '💡', title: 'Contributor', desc: 'Send an idea that gets added to the game', test: st => num(st.ideasAdded) >= 1 },
    { id: 'eventhunter', emoji: '🎯', title: 'Event Hunter', desc: 'Complete 3 weekly events', test: st => num(st.events) >= 3 },
    { id: 'codehunter', emoji: '🔑', title: 'Code Hunter', desc: 'Find the 3 secret codes hidden on the site', test: st => num(st.codehunter) >= 1 },
    { id: 'owner', emoji: '🛠️', title: 'Owner', desc: 'Made RNG∞', hidden: true, test: st => num(st.owner) >= 1 },
    // Réservé aux comptes que le créateur a invités à suivre le jeu avec lui (marqués à leur connexion Google : le
    // marqueur d'invité suffit, pour ceux qui se sont connectés avant que ce titre existe).
    // Donné à la main par le créateur à un joueur qui l'aide à trier les idées de la boîte à idées (2026-10-14).
    { id: 'ideas', emoji: '💡', title: 'Idea Manager', desc: 'Helps sort the ideas box', hidden: true, test: st => num(st.ideaManager) >= 1 },
    { id: 'manager', emoji: '🖥️', title: 'Manager', desc: 'Helps run RNG∞', hidden: true, test: st => num(st.manager) >= 1 || /^[0-9a-f]{64}$/.test(String(st.viewer || '')) },
  ];
  const byId = new Map(LIST.map(a => [a.id, a]));

  // Identifiants des succès débloqués, dans l'ordre de la liste.
  const unlocked = stats => LIST.filter(a => a.test(stats || {})).map(a => a.id);

  const api = { LIST, byId, unlocked };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGAchievements = api;
})(typeof window !== 'undefined' ? window : globalThis);
