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
  const earned = st => Object.entries(COINS).reduce((x, [tier, v]) => x + v * num(st[`t:${tier}`]), 0) + DUEL_WIN_COINS * num(st.duelWins);
  const balance = st => earned(st) - num(st.spent);

  const api = { COINS, DUEL_WIN_COINS, SKINS, OWNER, byId, resolve, earned, balance };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGShop = api;
})(typeof window !== 'undefined' ? window : globalThis);
