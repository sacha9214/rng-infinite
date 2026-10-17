/* RNG∞ — pièces et skins.
 * Pur JS, chargeable dans le navigateur (window.RNGShop) et dans Node (module.exports).
 * Les pièces se gagnent en tirant (selon la rareté du tirage) et en gagnant des duels ; elles se lisent sur les stats
 * tenues par le serveur (stats:<id>), moins ce qui a été dépensé (champ "spent"). Pas d'argent réel.
 */
(function (root) {
  'use strict';

  // Pièces par tirage selon la rareté de la carte (Trash rapporte un peu plus que Common : lot de consolation).
  const COINS = { landwaste: 300, garbage: 50, trash: 3, common: 1, uncommon: 2, rare: 5, epic: 10, anomaly: 25, mythic: 100, celestial: 300, divine: 1000, godlike: 2500, infinite: 5000 };
  const DUEL_WIN_COINS = 25;
  // Pièces offertes une seule fois à un joueur qui associe son compte Google (il retrouve alors son joueur partout).
  const GOOGLE_BONUS = 150;

  // Apparence du nombre tiré (carte du résultat et cartes en duel). "classic" est offert.
  const SKINS = [
    { id: 'classic', name: 'Classic', emoji: '🔢', price: 0, desc: 'The original look' },
    { id: 'neon', name: 'Neon', emoji: '💡', price: 200, desc: 'Glowing tubes' },
    { id: 'lcd', name: 'LCD', emoji: '📟', price: 200, desc: 'Old pocket calculator' },
    { id: 'pixel', name: 'Pixel', emoji: '👾', price: 300, desc: '8-bit arcade' },
    { id: 'jersey', name: 'Jersey', emoji: '⚽', price: 500, desc: 'Soccer shirt number' },
    { id: 'slots', name: 'Slots', emoji: '🎰', price: 500, desc: 'Casino reels' },
    { id: 'scoreboard', name: 'Scoreboard', emoji: '🏟️', price: 500, desc: 'Stadium LED board' },
    { id: 'dice', name: 'Dice', emoji: '🎲', price: 600, desc: 'Digits on dice' },
    { id: 'chrome', name: 'Chrome', emoji: '🪞', price: 800, desc: 'Polished metal' },
    { id: 'gold', name: 'Gold', emoji: '🥇', price: 1000, desc: 'Solid gold' },
    { id: 'matrix', name: 'Matrix', emoji: '🟩', price: 1200, desc: 'Falling green code' },
    { id: 'fire', name: 'Fire', emoji: '🔥', price: 1500, desc: 'Burning digits' },
    { id: 'sky', name: 'Sky', emoji: '☁️', price: 1600, desc: 'Cloud digits; roll Mythic or better and the sky takes its color' }, // idée de Deadshot (2026-10-16)
    // Idée de Gunnar (2026-10-16, « heavenly ») : marbre et or, une auréole sur chaque chiffre.
    { id: 'heavenly', name: 'Heavenly', emoji: '😇', price: 2000, desc: 'White marble and gold leaf; every digit gets its halo' },
    { id: 'cards', name: 'Deck', emoji: '🃏', price: 1400, desc: 'Every digit is a card drawn from the deck' }, // idée de GamblrGod (2026-10-16)
    { id: 'galaxy', name: 'Galaxy', emoji: '🌌', price: 2500, desc: 'Written in the stars' },
    { id: 'rainbow', name: 'Rainbow', emoji: '🌈', price: 5000, desc: 'Every color at once' },
    // Ajoutés le 2026-09-28.
    { id: 'candy', name: 'Candy', emoji: '🍬', price: 400, desc: 'Glossy jelly sweets' },
    { id: 'ocean', name: 'Ocean', emoji: '🌊', price: 700, desc: 'Deep sea and bubbles' },
    { id: 'ice', name: 'Ice', emoji: '❄️', price: 900, desc: 'Frozen crystal' },
    { id: 'circuit', name: 'Circuit', emoji: '🔌', price: 1100, desc: 'Live circuit board' },
    { id: 'nixie', name: 'Nixie', emoji: '🔆', price: 1300, desc: 'Glowing vintage tubes' },
    { id: 'vaporwave', name: 'Vaporwave', emoji: '🌴', price: 1800, desc: 'Retro sunset grid' },
    { id: 'blocks', name: 'Blocks', emoji: '⛏️', price: 800, desc: 'Pixel grass blocks to mine' },
    { id: 'diamond', name: 'Diamond', emoji: '💎', price: 3500, desc: 'Cut gemstone' },
    // Skins premium (2026-10-07) : une signature animée complète autour de la carte, comme celle du créateur
    // (js/skinfx.js), leur propre feuille de style (css/premium.css). Hors caisses (trop chers pour leurs fourchettes).
    { id: 'sakura', name: 'Sakura', emoji: '🌸', price: 7500, desc: 'A blade, a branch in bloom, a rising moon', premium: true },
    { id: 'storm', name: 'Storm', emoji: '⚡', price: 10000, desc: 'Lightning strikes every digit', premium: true },
    { id: 'dragon', name: 'Dragon', emoji: '🐉', price: 12500, desc: 'A dragon circles your number and forges it', premium: true },
    { id: 'blackhole', name: 'Singularity', emoji: '🕳️', price: 15000, desc: 'Light bends around your number', premium: true },
    // Ajoutés le 2026-10-13 (suggestions de joueurs). Bakery : un skin de boutique comme les autres.
    { id: 'bakery', name: 'Bakery', emoji: '🥐', price: 1000, desc: 'Fresh bread and cookies' },
    // Halloween (idée de Deadshot, 2026-10-14) : en vente seulement jusqu'au 1er novembre (until), 666 pièces ; gardé
    // pour toujours par ceux qui l'ont acheté. Jamais dans une caisse.
    { id: 'pumpkin', name: "Jack-o'-Lantern", emoji: '🎃', price: 1031, desc: 'Digits carved in a pumpkin, lit by a flickering candle · until November 1', until: '2026-11-01T00:00:00Z' },
    { id: 'brew', name: "Witch's Brew", emoji: '🧪', price: 1313, desc: 'A bubbling green potion in a witch cauldron · until November 1', until: '2026-11-01T00:00:00Z' },
    { id: 'haunted', name: 'Haunted', emoji: '👻', price: 666, desc: 'A haunted house, ghostly digits, a graveyard full of ghosts · until November 1', until: '2026-11-01T00:00:00Z' },
    // Idée de Deadshot (2026-10-16) : des maisons du quartier, les portes s'ouvrent sur des bonbons en forme de chiffres ;
    // derrière les zéros de tête, la porte s'ouvre sur une maison vide.
    { id: 'trickortreat', name: 'Trick or Treat', emoji: '🍬', price: 1100, desc: 'Doors open on number-shaped candy; zeros are empty houses · until November 1', until: '2026-11-01T00:00:00Z' },
    // Idée d'un joueur (2026-10-14) : un skin pas cher, que de la mayonnaise et des flacons qui en giclent.
    { id: 'mayo', name: 'Mayo', emoji: '🥫', price: 250, desc: 'Squeeze bottles, piped mayonnaise, splat' },
    // Idée de Gunnar (2026-10-16) : les cousins du Mayo.
    // Idée d'un joueur (2026-10-16) : un skin « sang », stylisé, rien de gore.
    { id: 'bloodlust', name: 'Bloodlust', emoji: '🩸', price: 1400, desc: 'Glossy dark red drops that drip and splash' },
    // Idée de JBearr12 (2026-10-17) : un revolver tire sur des bouteilles qui éclatent en chiffres.
    { id: 'western', name: 'Western', emoji: '🤠', price: 1500, desc: 'A revolver shoots the bottles off the fence, and each one bursts into a digit' },
    { id: 'ketchup', name: 'Ketchup', emoji: '🍅', price: 250, desc: 'Red squeeze bottles, piped ketchup, splat' },
    { id: 'mustard', name: 'Mustard', emoji: '🌭', price: 250, desc: 'Yellow squeeze bottles, piped mustard, splat' },
    // Idée d'un joueur (2026-10-14) : de la pierre volcanique noire dont les fissures laissent voir la lave (Fire, lui, ce sont des flammes).
    { id: 'hellborn', name: 'HellBorn', emoji: '🌋', price: 4000, desc: 'Black volcanic stone with lava burning through the cracks' },
    // Infinity : jamais vendu, seulement tiré dans la caisse Premium (caseOnly : identifiant de la caisse), à une chance
    // fixe (chance : 0,5 %) au lieu du poids 1 / prix. Son prix ne sert qu'au rangement et à sa rareté (Legendary) ;
    // premium : signature animée, rangé avec les skins légendaires, jamais porté par un bot.
    { id: 'infinity', name: 'Infinity', emoji: '♾️', price: 20000, desc: 'A galaxy folded into an endless loop', premium: true, caseOnly: 'premium', chance: 0.005 },
  ];
  SKINS.sort((a, b) => a.price - b.price); // boutique rangée du moins cher au plus cher (tri stable)
  // Skin du créateur : hors boutique, donné par le serveur au seul compte Owner (rubis et signature en béryl rouge).
  const OWNER = { id: 'owner', name: 'Owner', emoji: '♛', price: 0, desc: 'Ruby, for the creator only', hidden: true };
  // Skin de remerciement : pour les joueurs qui ont contribué à la cagnotte du serveur (stats.supporter, posé par le
  // créateur depuis sa page). Ni achetable avec des pièces, ni dans les caisses, ni porté par les bots.
  const SUPPORTER = { id: 'supporter', name: 'Supporter', emoji: '💗', price: 0, desc: 'Rose gold, for those who keep the server alive', hidden: true, supporter: true };
  // Skin de la collab Canne & Dauphins (jeu de Firetail, 2026-10-15) : le pêcheur de son jeu pêche les chiffres. Exclusif :
  // ni en vente, ni dans les caisses ; débloqué en jouant aux deux jeux avec le même compte Google (stats.collabFish).
  // Tuile de la boutique montrée seulement quand le jeu de Firetail envoie ses connexions (son côté du kit publié).
  const COLLAB_LIVE = true; // son côté est en ligne depuis le 2026-10-15
  const FISHER = { id: 'fisher', name: 'Fisherman', emoji: '🎣', price: 0, desc: 'Collab with Canne & Dauphins: a fisherman reels in your digits', hidden: true, collab: true };
  // Cagnotte : objectif par défaut du mois, en centimes (réglable depuis la page Owner).
  const FUND_GOAL = 2000;
  const byId = new Map(SKINS.concat(OWNER, SUPPORTER, FISHER).map(s => [s.id, s]));
  // Skins remplacés : qui avait l'ancien a le nouveau (Donut → Slots, 2026-09-23).
  const ALIASES = { donut: 'slots' };
  const resolve = id => (id && ALIASES[id]) || id;

  const num = v => Number(v) || 0;
  // Victoires de duel récompensées = toutes les victoires − celles sans enjeu (même adversaire trop souvent dans la
  // journée, compte adverse trop neuf : champ "duelUnpaid", voir duelOutcome dans api/room.js).
  const rankedWins = st => Math.max(0, num(st.duelWins) - num(st.duelUnpaid));
  const earned = st => Object.entries(COINS).reduce((x, [tier, v]) => x + v * num(st[`t:${tier}`]), 0) + DUEL_WIN_COINS * rankedWins(st);
  // Solde = pièces gagnées en jouant + pièces reçues (quêtes, bonus quotidien, pots de duel, remboursements : champ
  // "bonus") − pièces dépensées (skins, caisses, mises de duel : champ "spent").
  const balance = st => earned(st) + num(st.bonus) - num(st.spent);

  // Caisses : un skin tiré au hasard par le serveur dans la liste de la caisse ; plus un skin est cher, plus il est rare
  // (poids = 1 / prix). Déjà possédé : la moitié du prix de la caisse est rendue. Un skin réservé à une caisse
  // (caseOnly) n'y entre pas par son prix mais avec sa chance fixe ; les autres se partagent le reste.
  const CASES = [
    { id: 'starter', name: 'Starter Case', emoji: '📦', price: 250, desc: 'A skin worth 200 to 800 coins', min: 200, max: 800 },
    { id: 'premium', name: 'Premium Case', emoji: '🎁', price: 900, desc: 'A skin worth 800 to 5,000 coins, or the rare Infinity', min: 800, max: 5000 },
    { id: 'elite', name: 'Elite Case', emoji: '💎', price: 1800, desc: 'Only skins worth 1,500 to 5,000 coins', min: 1500, max: 5000 }, // 2026-10-16
  ];
  const caseById = new Map(CASES.map(c => [c.id, c]));
  // Fonds d'écran animés (idée de MAYO, 2026-10-16) : changent tout l'arrière-plan du site, pour soi seul.
  const WALLPAPERS = [
    { id: 'forest', name: 'Night Forest', emoji: '🌲', price: 500, desc: 'Fireflies over a dark forest' },
    { id: 'stars', name: 'Starry Sky', emoji: '🌌', price: 600, desc: 'A night sky full of twinkling stars' },
    { id: 'abyss', name: 'Abyss', emoji: '🌊', price: 700, desc: 'Deep ocean, swaying light and bubbles' },
    { id: 'sakura', name: 'Sakura', emoji: '🌸', price: 800, desc: 'Cherry blossom petals falling' },
    { id: 'sunset', name: 'Sunset', emoji: '🌅', price: 900, desc: 'A glowing sun sinking into purple skies' },
    { id: 'synthwave', name: 'Synthwave', emoji: '🟣', price: 1200, desc: 'A neon grid rolling to the horizon' },
    { id: 'galaxy', name: 'Galaxy', emoji: '🌠', price: 1000, desc: 'A purple nebula with stars rushing past' },
    // Idée de JAKE (2026-10-17) : du code vert qui tombe, façon hacker.
    { id: 'hacker', name: 'Hacker', emoji: '💻', price: 900, desc: 'Green code raining down the screen' },
    // Fonds d'Halloween (idée de Deadshot, 2026-10-16) : dans l'onglet Limités, en vente jusqu'au 1er novembre.
    { id: 'graveyard', name: 'Moonlit Graveyard', emoji: '🪦', price: 666, desc: 'Tombstones under a full moon, bats flying across', until: '2026-11-01T00:00:00Z' },
    { id: 'pumpkins', name: 'Pumpkin Patch', emoji: '🎃', price: 777, desc: 'Glowing jack-o\'-lanterns in a foggy field', until: '2026-11-01T00:00:00Z' },
  ];
  const wallById = new Map(WALLPAPERS.map(w => [w.id, w]));
  const caseOnly = c => SKINS.filter(s => s.caseOnly === c.id);
  const casePool = c => SKINS.filter(s => !s.caseOnly && !s.until && s.price >= c.min && s.price <= c.max).concat(caseOnly(c));
  // Doublon : une part du prix de la caisse revient, selon la rareté du skin tiré (de la moitié pour un Common à
  // 90 % pour un Legendary). Toujours moins que le prix de la caisse.
  const DUPLICATE_REFUND = { blue: .5, purple: .55, pink: .65, red: .75, gold: .9 };
  const duplicateRefund = (c, skinId) => Math.round(c.price * (DUPLICATE_REFUND[(rarityOf(skinId) || RARITIES[0]).id] || .5));
  // Chances de chaque skin d'une caisse (somme = 1), pour l'affichage et pour le tirage. Les skins réservés à la caisse
  // viennent en dernier (les plus rares).
  function caseOdds(c) {
    const fixed = caseOnly(c), pool = casePool(c).filter(s => !s.caseOnly);
    const rest = 1 - fixed.reduce((x, s) => x + s.chance, 0);
    const total = pool.reduce((x, s) => x + 1 / s.price, 0);
    return pool.map(s => ({ id: s.id, p: (rest / s.price) / total })).concat(fixed.map(s => ({ id: s.id, p: s.chance })));
  }
  // Tirage : u uniforme dans [0, 1) fourni par l'appelant (crypto côté serveur).
  function drawCase(c, u) {
    let acc = 0;
    const odds = caseOdds(c);
    for (const o of odds) { acc += o.p; if (u < acc) return o.id; }
    return odds[odds.length - 1].id;
  }

  // Rareté d'un skin dans une caisse, par son prix, aux couleurs classiques des caisses (du plus courant au plus rare).
  const RARITIES = [
    { id: 'blue', name: 'Common', max: 300, color: '#4b69ff' },
    { id: 'purple', name: 'Uncommon', max: 700, color: '#8847ff' },
    { id: 'pink', name: 'Rare', max: 1200, color: '#d32ce6' },
    { id: 'red', name: 'Epic', max: 2500, color: '#eb4b4b' },
    { id: 'gold', name: 'Legendary', max: Infinity, color: '#ffd700' },
  ];
  const rarityOf = id => RARITIES.find(r => (byId.get(id) || { price: 0 }).price <= r.max);

  // Apparence du bouton qui lance un tirage (« Generate », « Roll again », « Roll round » en duel). Chaque skin de
  // nombre apporte le bouton assorti (même identifiant) ; ceux-ci se vendent à part et ne changent que le bouton.
  // Personne d'autre ne voit ton bouton : prix plus doux que les skins.
  const BUTTONS = [
    { id: 'keycap', name: 'Keycap', emoji: '⌨️', price: 150, desc: 'A chunky mechanical key' },
    { id: 'terminal', name: 'Terminal', emoji: '💻', price: 250, desc: 'Run the command yourself' },
    { id: 'arcade', name: 'Arcade', emoji: '🕹️', price: 350, desc: 'Big red cabinet button' },
    { id: 'ticket', name: 'Ticket', emoji: '🎟️', price: 450, desc: 'Tear off a raffle ticket' },
    { id: 'comic', name: 'Comic', emoji: '💥', price: 600, desc: 'Halftone and a loud outline' },
    { id: 'launch', name: 'Launch', emoji: '🚀', price: 900, desc: 'Hazard stripes, handle with care' },
    { id: 'hologram', name: 'Hologram', emoji: '🪩', price: 1400, desc: 'Foil that shifts with the light' },
    { id: 'royal', name: 'Royal', emoji: '👑', price: 2200, desc: 'Velvet with a gold trim' },
  ];
  const buttonById = new Map(BUTTONS.map(b => [b.id, b]));
  const MATCH = 'match'; // choix par défaut : le bouton suit le skin équipé
  // Bouton réellement affiché : le choix du joueur s'il le possède encore, sinon celui du skin équipé.
  // owned = skins possédés, buttons = boutons achetés à part.
  function buttonLook(choice, skin, owned, buttons) {
    const id = resolve(choice);
    if (id && id !== MATCH && ((byId.has(id) && (owned || []).includes(id)) || (buttonById.has(id) && (buttons || []).includes(id)))) return id;
    return resolve(skin) || 'classic';
  }

  // Émotes spéciales : en plus des six réactions de base (gratuites), à acheter une fois pour s'en servir en duel.
  // Dessinées et animées dans js/emotes.js (même identifiant).
  const BASE_EMOTES = ['laugh', 'cry', 'angry', 'cool', 'shock', 'king'];
  const EMOTES = [
    { id: 'gg', name: 'GG', price: 300 },
    { id: 'sleep', name: 'Zzz', price: 300 },
    { id: 'sweat', name: 'Phew', price: 400 },
    { id: 'love', name: 'Love', price: 500 },
    { id: 'rage', name: 'Rage', price: 600 },
    { id: 'clown', name: 'Clown', price: 700 },
    { id: 'money', name: 'Rich', price: 900 },
    { id: 'mindblown', name: 'Mind blown', price: 1200 },
  ];
  const emoteById = new Map(EMOTES.map(e => [e.id, e]));

  // Mises possibles pour un duel (0 = sans mise).
  const STAKES = [0, 50, 100, 250, 500, 1000];

  // Vitesse du tirage : 5 niveaux achetés l'un après l'autre. Chaque niveau raccourcit toute la révélation en solo
  // (chiffres, badges, fin de séquence) et, côté serveur, le délai entre deux tirages (8 s au départ, 4 s au niveau 5).
  // La révélation reste toujours un peu plus longue que ce délai. Les duels gardent leur rythme commun.
  const SPEED = { factors: [1, .9, .8, .7, .6, .5], prices: [1000, 2500, 6000, 15000, 40000] };
  const speedLevel = v => Math.max(0, Math.min(SPEED.prices.length, Math.floor(Number(v) || 0)));
  const speedFactor = v => SPEED.factors[speedLevel(v)];

  const api = { WALLPAPERS, wallById, COLLAB_LIVE, FISHER, SUPPORTER, FUND_GOAL, GOOGLE_BONUS, SPEED, speedLevel, speedFactor, COINS, DUEL_WIN_COINS, SKINS, OWNER, byId, resolve, earned, balance, rankedWins, CASES, caseById, casePool, caseOdds, drawCase, DUPLICATE_REFUND, duplicateRefund, STAKES, RARITIES, rarityOf, BUTTONS, buttonById, MATCH, buttonLook, BASE_EMOTES, EMOTES, emoteById };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGShop = api;
})(typeof window !== 'undefined' ? window : globalThis);
