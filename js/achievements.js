/* RNG∞ — succès et titres.
 * Pur JS, chargeable dans le navigateur (window.RNGAchievements) et dans Node (module.exports).
 * Chaque succès se lit sur les stats du joueur tenues par le serveur (stats:<id>) : un titre ne s'équipe que débloqué.
 * stats = { rolls, 't:<rareté>', best, badges (nombre de badges différents), drastix, first (heure du premier tirage), dayTop, duelWins, flawless, bigWin, xpWin }
 */
(function (root) {
  'use strict';

  const TIERS = ['landwaste', 'garbage', 'trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite'];
  const num = v => Number(v) || 0;
  // Victoires de duel qui comptent pour les succès : sans celles « sans enjeu » (anti-farm, champ duelUnpaid).
  const ranked = st => Math.max(0, num(st.duelWins) - num(st.duelUnpaid));
  const atLeast = (st, tier) => TIERS.slice(TIERS.indexOf(tier)).reduce((x, t) => x + num(st[`t:${t}`]), 0);
  // Pièces gagnées en jouant (idée de logannn, 2026-10-27) : tirages (après rendements décroissants) + victoires de duel
  // (Shop.earned) + Weekend Rush. Ni cadeaux, ni casino, ni crypto, ni pots de mise : ils ne font que déplacer des pièces,
  // et le serveur ne garde pas le détail de tous (vente de crypto, pot reçu) ; ce total-là est exact pour tous les joueurs,
  // anciens compris, et impossible à gonfler.
  const shop = () => (typeof module === 'object' && module.exports ? require('./shop.js') : root.RNGShop);
  const coinsEarned = st => Math.max(0, shop().earned(st) + num(st.rushBonus));

  // Titres de collection par rareté de badge (idée de kaz, 2026-10-27). Le serveur pose "col:<rareté>" une fois que
  // badges:<id> contient tous les badges de cette rareté (api/_lib.js syncCollections) ; jamais retiré ensuite.
  // Au-delà d'Anomaly, impossible en pratique : ~1,2 million de tirages en moyenne pour tous les Mythic, ~4,8 millions
  // pour tous les Celestial (un nombre exact chacun).
  const COLLECT = [
    ['common', 'colcommon', '🧺', 'Common Collector'], ['uncommon', 'coluncommon', '🌿', 'Uncommon Admirer'],
    ['rare', 'colrare', '🔷', 'Rare Enthusiast'], ['epic', 'colepic', '🟣', 'Epic Obtainer'], ['anomaly', 'colanomaly', '🌋', 'Anomaly Hunter'],
  ];
  const cap = s => s[0].toUpperCase() + s.slice(1);
  // Rareté qui compte pour la collection : la plus rare entre la couleur du badge et sa fréquence réelle (counts[id] =
  // nombre de tirages de 0 à 1 000 000 qui l'obtiennent, data/badge-odds.json). Seuls quelques vieux badges perso valent
  // moins que leur rareté (ex. Important Birthday, Rare mais un seul nombre) : ils comptent dans la rareté de leur fréquence.
  function collectionSets(meta, counts, badgeTier) {
    const sets = Object.fromEntries(COLLECT.map(([t]) => [t, []]));
    for (const b of meta) {
      const n = num(counts[b.id]);
      const tier = badgeTier(n ? Math.max(b.score, (100 * 1000001) / n) : Infinity);
      if (sets[tier]) sets[tier].push(b.id);
    }
    return sets;
  }
  // Raretés complètes pour une collection de badges (Set ou tableau d'identifiants).
  const completeCollections = (sets, owned) => {
    const has = owned instanceof Set ? owned : new Set(owned || []);
    return COLLECT.map(([t]) => t).filter(t => sets[t].length && sets[t].every(id => has.has(id)));
  };

  const LIST = [
    { id: 'rookie', emoji: '🎲', title: 'Rookie', desc: 'Make your first roll', test: st => num(st.rolls) >= 1 },
    { id: 'regular', emoji: '🔁', title: 'Regular', desc: 'Make 100 rolls', test: st => num(st.rolls) >= 100 },
    { id: 'addict', emoji: '🌀', title: 'Addict', desc: 'Make 1,000 rolls', test: st => num(st.rolls) >= 1000 },
    { id: 'nolife', emoji: '🧟', title: 'No Life', desc: 'Make 10,000 rolls', test: st => num(st.rolls) >= 10000 },
    { id: 'connoisseur', emoji: '🖼️', title: 'Collectible Connoisseur', desc: 'Own every skin (limited ones excepted)', test: st => num(st.connoisseur) >= 1 }, // idée de kaz (2026-10-20)
    { id: 'allbuttons', emoji: '🔘', title: 'Button Masher', desc: 'Own every Generate button (limited ones excepted)', test: st => num(st.allButtons) >= 1 }, // idée de PRISMA123 (2026-10-22)
    { id: 'allemotes', emoji: '😎', title: 'Emote Lord', desc: 'Own every special emote', test: st => num(st.allEmotes) >= 1 },
    { id: 'allwalls', emoji: '🖼️', title: 'Interior Designer', desc: 'Own every wallpaper (limited ones excepted)', test: st => num(st.allWalls) >= 1 },
    { id: 'coinmillionaire', emoji: '🤑', title: 'Coin Millionaire', desc: 'Hold 1,000,000 coins at once', test: st => num(st.millionaire) >= 1 }, // idée d'A Dude (2026-10-21)
    { id: 'legend', emoji: '🗿', title: 'Legend', desc: 'Make 100,000 rolls', test: st => num(st.rolls) >= 100000 }, // idée de PRISMA123 (2026-10-20)
    { id: 'unemployking', emoji: '🛋️', title: 'The King Of Unemployment', desc: 'Make 1,000,000 rolls', test: st => num(st.rolls) >= 1000000 }, // idée d'A Dude (2026-10-22)
    { id: 'unemploygod', emoji: '🛐', title: 'The God Of Unemployment', desc: 'Make 10,000,000 rolls', test: st => num(st.rolls) >= 10000000 },
    { id: 'cardshark', emoji: '🃏', title: 'Card Shark', desc: 'Get 100 blackjacks in the casino', test: st => num(st.gNaturals) >= 100 }, // idée de Dylanrulez123 (2026-10-20)
    { id: 'cursed', emoji: '🪦', title: 'Cursed', desc: 'Roll a Trash number (bottom 1%)', test: st => num(st['t:trash']) >= 1 },
    { id: 'lucky', emoji: '🍀', title: 'Lucky', desc: 'Roll a Rare or better', test: st => atLeast(st, 'rare') >= 1 },
    { id: 'blessed', emoji: '✨', title: 'Blessed', desc: 'Roll an Epic or better', test: st => atLeast(st, 'epic') >= 1 },
    { id: 'anomaly', emoji: '🌋', title: 'Anomaly', desc: 'Roll an Anomaly or better', test: st => atLeast(st, 'anomaly') >= 1 },
    { id: 'mythic', emoji: '🔮', title: 'Mythic', desc: 'Roll a Mythic or better (top 1%)', test: st => atLeast(st, 'mythic') >= 1 },
    { id: 'chosen', emoji: '👁️', title: 'Chosen One', desc: 'Roll 10 Mythics or better', test: st => atLeast(st, 'mythic') >= 10 },
    { id: 'celestial', emoji: '🌠', title: 'Celestial', desc: 'Roll a Celestial or better (top 0.1%)', test: st => atLeast(st, 'celestial') >= 1 },
    { id: 'godlike', emoji: '⚜️', title: 'Godlike', desc: 'Roll a Godlike or better (top 0.005%)', test: st => atLeast(st, 'godlike') >= 1 },
    { id: 'divine', emoji: '👼', title: 'Divine', desc: 'Roll a Divine or better (top 0.01%)', test: st => atLeast(st, 'divine') >= 1 },
    { id: 'infinite', emoji: '♾️', title: 'Infinite', desc: 'Roll an Infinite (top 0.001%: one of the ~10 best numbers in the game)', test: st => num(st['t:infinite']) >= 1 },
    // XP à vie (idée d'Avaneesh_17, 2026-10-16) : stats.xpLife, tenue à chaque tirage et recalculée avec le classement.
    { id: 'centimillionaire', emoji: '💎', title: 'Centimillionaire', desc: 'Reach 100,000,000 lifetime XP', test: st => num(st.xpLife) >= 1e8 },
    { id: 'billionaire', emoji: '🏦', title: 'Billionaire', desc: 'Reach 1,000,000,000 lifetime XP', test: st => num(st.xpLife) >= 1e9 },
    // Palier suivant (demandé par Big Sexy, 2026-10-27, qui a passé le milliard).
    { id: 'decabillionaire', emoji: '🪐', title: 'Decabillionaire', desc: 'Reach 10,000,000,000 lifetime XP', test: st => num(st.xpLife) >= 1e10 },
    ...COLLECT.map(([tier, id, emoji, title]) => ({ id, emoji, title, desc: `Find every ${cap(tier)} badge`, test: st => num(st[`col:${tier}`]) >= 1 })),
    // Pièces gagnées en jouant (idée de logannn, 2026-10-27) ; Coin Millionaire, lui, compte le solde détenu d'un coup.
    { id: 'piggybank', emoji: '🐷', title: 'Piggy Bank', desc: 'Earn 10,000 coins from rolls and duels', test: st => coinsEarned(st) >= 1e4 },
    { id: 'moneymaker', emoji: '💸', title: 'Money Maker', desc: 'Earn 100,000 coins from rolls and duels', test: st => coinsEarned(st) >= 1e5 },
    { id: 'coinmachine', emoji: '🏧', title: 'Coin Machine', desc: 'Earn 1,000,000 coins from rolls and duels', test: st => coinsEarned(st) >= 1e6 },
    // Idées de dailycb (Discord #ideas, 2026-10-27) : tous les packs de sons, et tout ce qui s'achète en pièces.
    { id: 'allsounds', emoji: '🎧', title: 'Sound Collector', desc: 'Own every sound pack', test: st => num(st.allSounds) >= 1 },
    { id: 'shopaholic', emoji: '🛍️', title: 'Shopaholic', desc: 'Own every skin, button, emote, wallpaper, sound pack and upgrade sold for coins (limited ones excepted)', test: st => num(st.allShop) >= 1 },
    { id: 'millionaire', emoji: '💰', title: 'Millionaire', desc: 'Roll a number worth 1,000,000 XP or more', test: st => num(st.best) >= 1000000 },
    { id: 'drastix', emoji: '💥', title: 'Drastix Fan', desc: 'Earn the Drastix badge (a number containing 235)', test: st => num(st.drastix) >= 1 },
    // Titre d'ancien : pour qui a joué en 2026 (premier tirage avant le 1er janvier 2027). Les joueurs d'avant le champ
    // « first » ont forcément commencé en 2026 (le jeu date de 2026).
    { id: 'year2026', emoji: '📅', title: '2026', desc: 'Play in 2026', test: st => num(st.rolls) >= 1 && num(st.first) < Date.UTC(2027, 0, 1) },
    { id: 'collector', emoji: '📦', title: 'Collector', desc: 'Find 50 different badges', test: st => num(st.badges) >= 50 },
    { id: 'hoarder', emoji: '🗄️', title: 'Hoarder', desc: 'Find 100 different badges', test: st => num(st.badges) >= 100 },
    { id: 'completionist', emoji: '🏛️', title: 'Completionist', desc: 'Find 150 different badges', test: st => num(st.badges) >= 150 },
    { id: 'daily', emoji: '👑', title: 'Daily King', desc: 'Hold the best roll of the day on the leaderboard', test: st => num(st.dayTop) >= 1 },
    { id: 'duelist', emoji: '⚔️', title: 'Duelist', desc: 'Win a duel', test: st => ranked(st) >= 1 },
    { id: 'gladiator', emoji: '🛡️', title: 'Gladiator', desc: 'Win 10 duels', test: st => ranked(st) >= 10 },
    { id: 'flawless', emoji: '💎', title: 'Flawless', desc: 'Win a rounds duel (first to 2 or more) without anyone else winning a round', test: st => num(st.flawless) >= 1 },
    { id: 'warlord', emoji: '🏰', title: 'Warlord', desc: 'Win a duel with 5 players or more', test: st => num(st.bigWin) >= 1 },
    { id: 'champion', emoji: '🏆', title: 'Champion', desc: 'Win a daily tournament', test: st => num(st.tourneyWins) >= 1 }, // idée de PRISMA123 (2026-10-20)
    { id: 'speedrunner', emoji: '⚡', title: 'Speedrunner', desc: 'Win an XP race duel', test: st => num(st.xpWin) >= 1 },
    // Remerciement : contribution à la cagnotte du serveur (aucun avantage en jeu).
    { id: 'supporter', emoji: '💗', title: 'Supporter', desc: 'Contribute to the server fund', test: st => num(st.supporter) >= 1 },
    // Réservé au créateur du site (marqué à sa connexion Google) ; caché aux autres, même verrouillé.
    // Code SPOOKYMONTH (Halloween 2026) : caché à ceux qui ne l'ont pas, pour ne pas dévoiler le code.
    { id: 'gatekeep', emoji: '🚧', title: 'Gatekeep', desc: 'Redeemed the BC code', hidden: true, test: st => num(st.gatekeep) >= 1 },
    { id: 'epitech', emoji: '🖥️', title: 'Epitech > 42', desc: 'Redeemed the EPITECH>42 code', hidden: true, test: st => num(st.epitech) >= 1 },
    { id: 'spooky', emoji: '🎃', title: 'Spooky', desc: 'Redeemed the Halloween 2026 code', hidden: true, test: st => num(st.spooky) >= 1 },
    // Visible verrouillé (2026-10-16) : les joueurs savent qu'il y a 3 codes à chercher.
    { id: 'bughunter', emoji: '🐛', title: 'Bug Hunter', desc: 'Report a bug that gets fixed', test: st => num(st.bugsFixed) >= 1 },
    { id: 'contributor', emoji: '💡', title: 'Contributor', desc: 'Send an idea that gets added to the game', test: st => num(st.ideasAdded) >= 1 },
    // Idée d'Angelicide9 (2026-10-18) : des titres pour les pires raretés, et le pire tirage du mois.
    { id: 'garbageman', emoji: '🗑️', title: 'Garbage Collector', desc: 'Roll a Garbage (bottom 0.05%)', test: st => num(st['t:garbage']) >= 1 },
    { id: 'landwaster', emoji: '☣️', title: 'Land Waster', desc: 'Roll a Land waste, the worst score there is', test: st => num(st['t:landwaste']) >= 1 },
    // Clans (idée de BIGBOIJONER69 et KMC, 2026-10-25) : membre du clan n°1 d'une semaine (XP gagnée cette semaine-là).
    { id: 'clanchamp', emoji: '🏯', title: 'Clan Champion', desc: 'Earn XP for the #1 clan of a week', test: st => num(st.clanWeekWins) >= 1 },
    // Donateur de clan (idée de PRISMA123, 2026-10-26) : 10 000 pièces versées au coffre d'un clan, au total (stats.clanDonated).
    { id: 'clanpatron', emoji: '🪙', title: 'Clan Patron', desc: 'Donate 10,000 coins in total to a clan vault', test: st => num(st.clanDonated) >= 10000 },
    // Paliers suivants (idée de Yentizx, 2026-10-27), même compteur.
    { id: 'clanbenefactor', emoji: '🤝', title: 'Clan Benefactor', desc: 'Donate 100,000 coins in total to a clan vault', test: st => num(st.clanDonated) >= 100000 },
    { id: 'clanpillar', emoji: '💠', title: 'Clan Pillar', desc: 'Donate 1,000,000 coins in total to a clan vault', test: st => num(st.clanDonated) >= 1000000 },
    { id: 'trashking', emoji: '👑', title: 'Trash King', desc: 'Finish a month with the worst roll on the Trash leaderboard', test: st => num(st.trashKing) >= 1 },
    { id: 'dejavu', emoji: '🔁', title: 'Déjà Vu', desc: 'Roll 5 numbers you had already rolled', test: st => num(st.dups) >= 5 },
    { id: 'brokenrecord', emoji: '📀', title: 'Broken Record', desc: 'Roll 25 numbers you had already rolled', test: st => num(st.dups) >= 25 },
    { id: 'eventhunter', emoji: '🎯', title: 'Event Hunter', desc: 'Complete 3 weekly events', test: st => num(st.events) >= 3 },
    { id: 'codehunter', emoji: '🔑', title: 'Code Hunter', desc: 'Find the 3 secret codes hidden on the site', test: st => num(st.codehunter) >= 1 },
    { id: 'owner', emoji: '🛠️', title: 'Owner', desc: 'Made RNG∞', hidden: true, test: st => num(st.owner) >= 1 },
    // Réservé aux comptes que le créateur a invités à suivre le jeu avec lui (marqués à leur connexion Google : le
    // marqueur d'invité suffit, pour ceux qui se sont connectés avant que ce titre existe).
    // Donné à la main par le créateur à un joueur qui l'aide à trier les idées de la boîte à idées (2026-10-14).
    { id: 'ideas', emoji: '💡', title: 'Idea Manager', desc: 'Helps sort the ideas box', hidden: true, test: st => num(st.ideaManager) >= 1 },
    { id: 'manager', emoji: '🖥️', title: 'Manager', desc: 'Helps run RNG∞', hidden: true, test: st => num(st.manager) >= 1 || /^[0-9a-f]{64}$/.test(String(st.viewer || '')) },
    // Titres de prestige (Sacha, 2026-10-25) : achetés dans la boutique (js/shop.js PRESTIGE), en quantité limitée.
    { id: 'tycoon', emoji: '🎩', title: 'Tycoon', desc: 'Bought in the Prestige shop', hidden: true, test: st => num(st['pr:tycoon']) >= 1 },
    { id: 'magnate', emoji: '💼', title: 'Magnate', desc: 'Bought in the Prestige shop', hidden: true, test: st => num(st['pr:magnate']) >= 1 },
    { id: 'emperor', emoji: '👑', title: 'Coin Emperor', desc: 'Bought in the Prestige shop', hidden: true, test: st => num(st['pr:emperor']) >= 1 },
  ];
  const byId = new Map(LIST.map(a => [a.id, a]));

  // Identifiants des succès débloqués, dans l'ordre de la liste.
  const unlocked = stats => LIST.filter(a => a.test(stats || {})).map(a => a.id);

  const api = { LIST, byId, unlocked, COLLECT, collectionSets, completeCollections, coinsEarned };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGAchievements = api;
})(typeof window !== 'undefined' ? window : globalThis);
