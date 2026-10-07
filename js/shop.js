/* RNG∞ — pièces et skins.
 * Pur JS, chargeable dans le navigateur (window.RNGShop) et dans Node (module.exports).
 * Les pièces se gagnent en tirant (selon la rareté du tirage) et en gagnant des duels ; elles se lisent sur les stats
 * tenues par le serveur (stats:<id>), moins ce qui a été dépensé (champ "spent"). Pas d'argent réel.
 */
(function (root) {
  'use strict';

  // Pièces par tirage selon la rareté de la carte (Trash rapporte un peu plus que Common : lot de consolation).
  const COINS = { trash: 3, common: 1, uncommon: 2, rare: 5, epic: 10, anomaly: 25, mythic: 100 };
  const DUEL_WIN_COINS = 25;

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
  ];
  SKINS.sort((a, b) => a.price - b.price); // boutique rangée du moins cher au plus cher (tri stable)
  // Skin du créateur : hors boutique, donné par le serveur au seul compte Owner (rubis et signature en béryl rouge).
  const OWNER = { id: 'owner', name: 'Owner', emoji: '♛', price: 0, desc: 'Ruby, for the creator only', hidden: true };
  const byId = new Map(SKINS.concat(OWNER).map(s => [s.id, s]));
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
  // (poids = 1 / prix). Déjà possédé : la moitié du prix de la caisse est rendue.
  const CASES = [
    { id: 'starter', name: 'Starter Case', emoji: '📦', price: 250, desc: 'A skin worth 200 to 800 coins', min: 200, max: 800 },
    { id: 'premium', name: 'Premium Case', emoji: '🎁', price: 900, desc: 'A skin worth 800 to 5,000 coins', min: 800, max: 5000 },
  ];
  const caseById = new Map(CASES.map(c => [c.id, c]));
  const casePool = c => SKINS.filter(s => s.price >= c.min && s.price <= c.max);
  const DUPLICATE_REFUND = 0.5;
  // Chances de chaque skin d'une caisse (somme = 1), pour l'affichage et pour le tirage.
  function caseOdds(c) {
    const pool = casePool(c);
    const total = pool.reduce((x, s) => x + 1 / s.price, 0);
    return pool.map(s => ({ id: s.id, p: 1 / s.price / total }));
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

  // Mises possibles pour un duel (0 = sans mise).
  const STAKES = [0, 50, 100, 250, 500, 1000];

  const api = { COINS, DUEL_WIN_COINS, SKINS, OWNER, byId, resolve, earned, balance, rankedWins, CASES, caseById, casePool, caseOdds, drawCase, DUPLICATE_REFUND, STAKES, RARITIES, rarityOf, BUTTONS, buttonById, MATCH, buttonLook };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGShop = api;
})(typeof window !== 'undefined' ? window : globalThis);
