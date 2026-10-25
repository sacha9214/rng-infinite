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
    { id: 'sky', name: 'Sky', emoji: '☁️', price: 1600, desc: 'Cloud digits; roll Mythic or better and the sky takes its color', idea: 'Deadshot' }, // idée de Deadshot (2026-10-16)
    // Idée de Gunnar (2026-10-16, « heavenly ») : marbre et or, une auréole sur chaque chiffre.
    { id: 'heavenly', name: 'Heavenly', emoji: '😇', price: 2000, desc: 'White marble and gold leaf; every digit gets its halo', idea: 'MUSTARD' },
    { id: 'cards', name: 'Deck', emoji: '🃏', price: 1400, desc: 'Every digit is a card drawn from the deck', idea: 'GamblrGod' }, // idée de GamblrGod (2026-10-16)
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
    // Idée de kaz (2026-10-25) : légendaire, les chiffres se posent tour à tour en roche, glace, feu et vent, et la carte
    // prend la matière de l'élément en cours.
    { id: 'elemental', name: 'Elemental', emoji: '🌀', price: 14000, desc: 'Every digit lands as a new element, rock, ice, fire then wind, and the card turns into it', premium: true, idea: 'kaz' },
    { id: 'blackhole', name: 'Singularity', emoji: '🕳️', price: 15000, desc: 'Light bends around your number', premium: true },
    // Idée de Gray alt (2026-10-25) : un tribunal céleste, une balance, un pilier de lumière qui frappe chaque chiffre ;
    // le verdict final sur les grandes raretés. Legendary, entre Singularity et Infinity.
    { id: 'divine', name: 'Divine Judgment', emoji: '⚖️', price: 17500, desc: 'A heavenly tribunal weighs every digit, and a pillar of light strikes it into place; rare rolls get the final verdict', premium: true, idea: 'Gray alt' },
    // Ajoutés le 2026-10-13 (suggestions de joueurs). Bakery : un skin de boutique comme les autres.
    { id: 'bakery', name: 'Bakery', emoji: '🥐', price: 1000, desc: 'Fresh bread and cookies' },
    // Halloween (idée de Deadshot, 2026-10-14) : en vente seulement jusqu'au 1er novembre (until), 666 pièces ; gardé
    // pour toujours par ceux qui l'ont acheté. Jamais dans une caisse.
    { id: 'pumpkin', name: "Jack-o'-Lantern", emoji: '🎃', price: 1031, desc: 'Digits carved in a pumpkin, lit by a flickering candle · until November 1', until: '2026-11-01T00:00:00Z' },
    { id: 'brew', name: "Witch's Brew", emoji: '🧪', price: 1313, desc: 'A bubbling green potion in a witch cauldron · until November 1', until: '2026-11-01T00:00:00Z' },
    { id: 'haunted', name: 'Haunted', emoji: '👻', price: 666, desc: 'A haunted house, ghostly digits, a graveyard full of ghosts · until November 1', until: '2026-11-01T00:00:00Z' },
    // Idée de Deadshot (2026-10-16) : des maisons du quartier, les portes s'ouvrent sur des bonbons en forme de chiffres ;
    // derrière les zéros de tête, la porte s'ouvre sur une maison vide.
    { id: 'trickortreat', name: 'Trick or Treat', emoji: '🍬', price: 1100, desc: 'Doors open on number-shaped candy; zeros are empty houses · until November 1', until: '2026-11-01T00:00:00Z', idea: 'Deadshot' },
    // Noël (idées de JBearr12 et Angelicide9, 2026-10-25) : Legendary limité, en vente jusqu'au 26 décembre (until).
    { id: 'christmas', name: 'Christmas Morning', emoji: '🎄', price: 2512, desc: 'Six presents shaken under the tree pop open to reveal your digits, between two trees and twinkling lights · until December 26', until: '2026-12-26T00:00:00Z', idea: 'JBearr12' },
    // Idée d'un joueur (2026-10-14) : un skin pas cher, que de la mayonnaise et des flacons qui en giclent.
    { id: 'mayo', name: 'Mayo', emoji: '🥫', price: 250, desc: 'Squeeze bottles, piped mayonnaise, splat' },
    // Idée de Gunnar (2026-10-16) : les cousins du Mayo.
    // Idée d'un joueur (2026-10-16) : un skin « sang », stylisé, rien de gore.
    { id: 'bloodlust', name: 'Bloodlust', emoji: '🩸', price: 1400, desc: 'Glossy dark red drops that drip and splash' },
    // Idée de JBearr12 (2026-10-17) : un revolver tire sur des bouteilles qui éclatent en chiffres.
    { id: 'western', name: 'Western', emoji: '🤠', price: 1500, desc: 'A revolver shoots the bottles off the fence, and each one bursts into a digit', idea: 'JBearr12' },
    // Idée de costoroll (2026-10-18) : des météorites tombent sur chaque chiffre, la dernière plus fort.
    { id: 'meteor', name: 'Meteor', emoji: '☄️', price: 2200, desc: 'Meteors crash onto every digit over a city at night; the last one hits hardest', idea: 'costoroll' },
    { id: 'dynamite', name: 'Dynamite', emoji: '🧨', price: 2500, desc: 'A crate of dynamite: every fuse burns down and each stick blows up to reveal its digit; Mythic rolls end in a mushroom cloud', idea: 'casmictechthing' }, // idée de casmictechthing et ichi (2026-10-24)
    // Idée de jjcoolcid1 (2026-10-25) : une étoile qui meurt, néon bleu et violet, des ondes de choc à chaque chiffre.
    { id: 'supernova', name: 'Supernova', emoji: '💥', price: 3600, desc: 'A star collapses behind neon blue and violet digits; every digit sends out a shockwave, and the reveal goes supernova', idea: 'jjcoolcid1' },
    { id: 'shinydiamond', name: 'Shiny Diamond', emoji: '💍', price: 3000, desc: 'Every digit is engraved in a brilliant-cut diamond on black velvet: the facets flicker as it turns and each stone locks in with a tink and a star glint', idea: 'finnnnn' }, // idée de finnnnn : un vrai diamant taille brillant par chiffre
    { id: 'ketchup', name: 'Ketchup', emoji: '🍅', price: 250, desc: 'Red squeeze bottles, piped ketchup, splat', idea: 'MUSTARD' },
    { id: 'mustard', name: 'Mustard', emoji: '🌭', price: 250, desc: 'Yellow squeeze bottles, piped mustard, splat', idea: 'MUSTARD' },
    // Idée d'un joueur (2026-10-14) : de la pierre volcanique noire dont les fissures laissent voir la lave (Fire, lui, ce sont des flammes).
    // Idée de JAKECisthebest (2026-10-20) : de la cire ASMR croquante, pressée et craquée ; boutons et sons assortis.
    { id: 'asmr', name: 'ASMR', emoji: '🧈', price: 3000, desc: 'Pastel crunchy wax, kneaded while it rolls, pressed and crunched on every digit', idea: 'JAKECisthebest' },
    // Idée d'Edward (2026-10-20) : une énergie maudite bleu-violet, aura qui crépite et sceaux. Dessin original.
    { id: 'cursed', name: 'Cursed Energy', emoji: '🌀', price: 6000, desc: 'Violet cursed energy flows around every digit, and a seal burns on each one', idea: 'Edward' },
    // Idée de DandoriNinja (2026-10-21) : guimauves pastel qui tombent, canons à confettis de guimauves arc-en-ciel.
    { id: 'marsh', name: 'Marshmallow', emoji: '🍡', price: 2400, desc: 'Puffy pastel marshmallows fall from the sky, and party poppers burst rainbow minis', idea: 'DandoriNinja' },
    // Idée de costoroll (2026-10-21) : six tubes à essai dans un portoir, les chiffres s'allument dans leur liquide, tintent et pétillent.
    { id: 'lab', name: 'Lab', emoji: '🧪', price: 3200, desc: 'Six test tubes of coloured liquid; every digit lights up in its tube with a glassy clink, then fizzes', idea: 'costoroll' },
    // Idée de JBearr12 (2026-10-21) : un vélo en wheelie traverse la carte, les chiffres apparaissent dans son sillage.
    { id: 'wheelie', name: 'Wheelie', emoji: '🚲', price: 1800, desc: 'A rider pulls a wheelie across the street, and every digit pops up in his wake', idea: 'JBearr12' },
    // Idée de PongonLOLZFan (2026-10-21) : un donut 3D en polygones (low poly). Identifiant « polydonut » : « donut » est
    // l'ancien skin remplacé par Slots (ALIASES).
    { id: 'polydonut', name: 'Polygon Donut', emoji: '🍩', price: 2600, desc: 'A low-poly frosted donut spins behind faceted digits, and sprinkles bounce out on the reveal', idea: 'PongonLOLZFan' },
    // Idée de Matthew (2026-10-21) : des ondes sonores qui portent les chiffres, un « boum » à chaque chiffre.
    { id: 'sonic', name: 'Sonic Wave', emoji: '🔊', price: 2800, desc: 'Digits ride a glowing sound wave; every one lands with a shockwave, and the last one booms', idea: 'Matthew' },
    { id: 'money', name: 'Money', emoji: '💵', price: 1900, desc: 'A crisp 100 bill with gold-foil digits stamped one by one; coins rain down, and Mythic rolls make the gold melt', idea: 'JBearr12' }, // idée de JBearr12 et finnnnn (2026-10-25)
    // Idée de R77 (2026-10-25) : une double hélice d'ADN qui tourne ; chaque chiffre est une paire de bases qui s'emboîte.
    { id: 'dna', name: 'DNA Helix', emoji: '🧬', price: 2400, desc: 'A glowing double helix twists behind the digits; every digit snaps in like a base pair', idea: 'R77' },
    // Idée de R77 (2026-10-25) : de la poussière de fée dorée qui fait apparaître chaque chiffre d'un coup de baguette.
    { id: 'fairydust', name: 'Fairy Dust', emoji: '🧚', price: 2000, desc: 'Sparkling fairy dust swirls into every digit with a tap of the wand; rare rolls rain gold', idea: 'R77' },
    { id: 'waterfall', name: 'Waterfall', emoji: '🏞️', price: 2300, desc: 'A waterfall in a green valley carries every digit down into the pool with a splash; rare rolls make a rainbow in the spray', idea: 'JBearr12' }, // idée de JBearr12 et jjcoolcid1 (2026-10-24)
    // Idée de JBearr12 (2026-10-21) : une soucoupe qui dépose les chiffres sur l'herbe.
    // Idée de costoroll (2026-10-21) : un store vénitien fermé devant chaque chiffre, qui s'ouvre sur un chiffre néon jaune ;
    // la fenêtre donne sur un jardin au soleil, qui se couche (et la lune se lève) dès Mythic.
    { id: 'blinds', name: 'Blinds', emoji: '🪟', price: 2900, desc: 'Venetian blinds snap open on neon-yellow digits in a sunny window; on a Mythic, the sun sets and the moon rises', idea: 'costoroll' },
    { id: 'ufo', name: 'UFO', emoji: '🛸', price: 3400, desc: 'A flying saucer beams every digit down onto the grass, then zips away', idea: 'JBearr12' },
    { id: 'bowling', name: 'Bowling', emoji: '🎳', price: 2000, desc: 'Every digit is a pin on a polished lane: a ball rolls in and knocks it down, and good rolls end in a STRIKE', idea: 'JBearr12' }, // idée de JBearr12 (2026-10-25)
    { id: 'rocksmash', name: 'Rock Smash', emoji: '🪨', price: 1600, desc: 'A fist smashes every boulder open, and a glowing digit shines inside the cracked stone', idea: 'HSI' }, // idée de HSI (2026-10-25)
    { id: 'cracked', name: 'Cracked Screen', emoji: '📱', price: 1500, desc: 'A phone screen that glitches while it rolls; every digit hits the glass and cracks it a little more', idea: 'KMC' }, // idée de KMC (2026-10-25)
    { id: 'castle', name: 'Medieval Castle', emoji: '🏰', price: 2400, desc: 'Royal banners unfurl one by one on a stone castle wall lit by torches; rare rolls end in fireworks over the battlements', idea: 'BIGBOIJONER69' }, // idée de BIGBOIJONER69 (2026-10-25)
    { id: 'chocolate', name: 'Chocolate', emoji: '🍫', price: 1300, desc: 'A milk chocolate bar in gold foil: digits melt while it rolls, then every square snaps into shape; Mythic rolls drip with melted chocolate', idea: 'finnnnn' }, // idée de finnnnn (2026-10-25)
    { id: 'fish', name: 'Floppy Fish', emoji: '🐟', price: 2100, desc: 'A goofy fish flops out of the pond for every digit, and a giant fish leaps over the card on Mythic rolls', idea: 'AnnJoe' }, // idée d'AnnJoe (2026-10-25)
    { id: 'axeman', name: 'Axe Thrower', emoji: '🪓', price: 1900, desc: 'A stick man throws a spinning axe into every wooden target, and celebrates when the roll is good', idea: 'jjcoolcid1' }, // idée de jjcoolcid1 (2026-10-25)
    { id: 'math', name: 'Math', emoji: '➗', price: 1200, desc: 'Chalk digits are written on a blackboard while math symbols float around; great rolls end with Q.E.D.', idea: 'sennybex1' }, // idée de sennybex1 (2026-10-25)
    { id: 'greek', name: 'Greek', emoji: '🏛️', price: 2000, desc: 'Roman numerals spin on a marble column, then the real digit is chiselled into the stone', idea: 'kaz' }, // idée de kaz (2026-10-25)
    { id: 'burger', name: 'Burger', emoji: '🍔', price: 1700, desc: 'Every digit drops a topping on the bun, and the top bun slams down to finish the burger', idea: 'jaxoncool43' }, // idée de jaxoncool43 (2026-10-23)
    // Wood carving : idée de jjcoolcid1 et JBearr12 (2026-10-25) — une lame taille chaque chiffre en creux dans une planche de pin.
    { id: 'woodcarving', name: 'Wood Carving', emoji: '🪵', price: 2000, desc: 'A knife carves every digit into a pine plank and wood shavings fly; rare rolls get a coat of golden varnish', idea: 'jjcoolcid1' },
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
    // Idée de CrazyMiner22 (2026-10-21) : une caisse qui donne un fond d'écran (wall: true) au lieu d'un skin. Les fonds
    // normaux seulement (ni limités ni légendaires), poids 1 / prix comme les skins : valeur moyenne d'un tirage ≈ 812, caisse à 600 (0,74 : entre la Starter 0,70 et l'Elite 0,78).
    { id: 'wallpaper', name: 'Wallpaper Case', emoji: '🖼️', price: 600, desc: 'An animated wallpaper worth 500 to 1,200 coins', wall: true },
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
    // Idée de Me Cojoni (2026-10-20) : un fond galactique qui réagit à chaque tirage selon sa rareté (id « aether » :
    // « infinity » est déjà l'identifiant d'un skin).
    { id: 'aether', name: 'Aether', emoji: '♾️', price: 6000, premium: true, desc: 'A galaxy around a glowing infinity sign that reacts to the rarity of every roll' },
    { id: 'galaxy', name: 'Galaxy', emoji: '🌠', price: 1000, desc: 'A purple nebula with stars rushing past' },
    // Idée de JAKE (2026-10-17) : du code vert qui tombe, façon hacker.
    { id: 'hacker', name: 'Hacker', emoji: '💻', price: 900, desc: 'Green code raining down the screen' },
    // Assorti au skin Western (idée de JBearr12) : désert au coucher du soleil, palissade, virevoltants.
    { id: 'western', name: 'Western', emoji: '🌵', price: 1100, desc: 'A desert sunset, a wooden fence and tumbleweeds rolling by' },
    // Idée de JBearr12 (2026-10-21) : un diner américain des années 50, la nuit.
    { id: 'diner', name: 'Diner', emoji: '🍔', price: 1000, desc: 'A 50s diner at night: neon sign, red stools and fresh coffee' },
    // Idée de JBearr12 (2026-10-24) : une montagne avec le soleil, et la lune qui se lève sur les tirages Mythique et plus.
    { id: 'summit', name: 'Summit', emoji: '🏔️', price: 4000, premium: true, idea: 'JBearr12', desc: 'Snowy mountains under the sun; on a Mythic+ roll night falls and the moon rises behind the peaks' },
    // Idée de kingston (2026-10-24) : des bulles ASMR qu'on éclate en cliquant (sur le fond seulement, jamais sur le jeu).
    { id: 'bubbles', name: 'ASMR Bubbles', emoji: '🫧', price: 1000, idea: 'kingston', desc: 'Shiny bubbles float up behind the game; click the background to pop them' },
    // Idée d'AnnJoe (2026-10-24) : un fond légendaire sous la mer, avec des baleines, des requins et des dauphins qui nagent.
    { id: 'oceanic', name: 'Open Ocean', emoji: '🐋', price: 5000, premium: true, idea: 'AnnJoe', desc: 'Whales, sharks and dolphins swim by; rare rolls light up the water and Mythic+ rolls send a pod of dolphins racing past' },
    // Fonds d'Halloween (idée de Deadshot, 2026-10-16) : dans l'onglet Limités, en vente jusqu'au 1er novembre.
    { id: 'graveyard', name: 'Moonlit Graveyard', emoji: '🪦', price: 666, desc: 'Tombstones under a full moon, bats flying across', until: '2026-11-01T00:00:00Z' },
    { id: 'pumpkins', name: 'Pumpkin Patch', emoji: '🎃', price: 777, desc: 'Glowing jack-o\'-lanterns in a foggy field', until: '2026-11-01T00:00:00Z' },
  ];
  const wallById = new Map(WALLPAPERS.map(w => [w.id, w]));
  const caseOnly = c => (c.wall ? [] : SKINS.filter(s => s.caseOnly === c.id));
  // Ce qu'une caisse donne : un skin, ou un fond d'écran pour la caisse de fonds (des identifiants existent dans les deux
  // listes, comme galaxy ou sakura : toujours passer par la caisse).
  const caseItem = (c, id) => (c && c.wall ? wallById : byId).get(id);
  const casePool = c => c.wall ? WALLPAPERS.filter(w => !w.until && !w.premium).sort((a, b) => a.price - b.price) : SKINS.filter(s => !s.caseOnly && !s.until && s.price >= c.min && s.price <= c.max).concat(caseOnly(c));
  // Doublon : une part du prix de la caisse revient, selon la rareté du skin tiré (de la moitié pour un Common à
  // 90 % pour un Legendary). Toujours moins que le prix de la caisse.
  const DUPLICATE_REFUND = { blue: .5, purple: .55, pink: .65, red: .75, gold: .9 };
  const duplicateRefund = (c, skinId) => Math.round(c.price * (DUPLICATE_REFUND[(rarityOf(skinId, c.wall) || RARITIES[0]).id] || .5));
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
  const rarityOf = (id, wall) => (wall ? WALL_RARITIES : RARITIES).find(r => ((wall ? wallById : byId).get(id) || { price: 0 }).price <= r.max);
  // Fonds d'écran : mêmes couleurs, paliers resserrés sur leurs prix (500 à 1 200).
  const WALL_RARITIES = [
    { id: 'blue', name: 'Common', max: 600, color: '#4b69ff' },
    { id: 'purple', name: 'Uncommon', max: 800, color: '#8847ff' },
    { id: 'pink', name: 'Rare', max: 1000, color: '#d32ce6' },
    { id: 'red', name: 'Epic', max: 1500, color: '#eb4b4b' },
    { id: 'gold', name: 'Legendary', max: Infinity, color: '#ffd700' },
  ];

  // Apparence du bouton qui lance un tirage (« Generate », « Roll again », « Roll round » en duel). Chaque skin de
  // nombre apporte le bouton assorti (même identifiant) ; ceux-ci se vendent à part et ne changent que le bouton.
  // Personne d'autre ne voit ton bouton : prix plus doux que les skins.
  const BUTTONS = [
    { id: 'keycap', name: 'Keycap', emoji: '⌨️', price: 150, desc: 'A chunky mechanical key' },
    { id: 'terminal', name: 'Terminal', emoji: '💻', price: 250, desc: 'Run the command yourself' },
    { id: 'arcade', name: 'Arcade', emoji: '🕹️', price: 350, desc: 'Big red cabinet button' },
    { id: 'ticket', name: 'Ticket', emoji: '🎟️', price: 450, desc: 'Tear off a raffle ticket' },
    // Pack ASMR (idée de JAKECisthebest, 2026-10-20) : chacun a son propre son de pression (js/sound.js).
    { id: 'thock', name: 'Thock', emoji: '🎹', price: 500, desc: 'A lubed mechanical key with a deep thock' },
    { id: 'comic', name: 'Comic', emoji: '💥', price: 600, desc: 'Halftone and a loud outline' },
    { id: 'wax', name: 'Crunchy Wax', emoji: '🧈', price: 700, desc: 'A block of crunchy wax that crackles when pressed' },
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
    { id: 'spread', name: 'Money Spread', price: 1000 }, // idée de finnnnn (2026-10-24)
    { id: 'confused', name: 'Super confused', price: 800 }, // idée de finnnnn (2026-10-22)
    { id: 'mindblown', name: 'Mind blown', price: 1200 },
  ];
  const emoteById = new Map(EMOTES.map(e => [e.id, e]));

  // Packs de sons du tirage (idée d'Angelicide9, 2026-10-21) : chacun change la note de chaque chiffre et le son de la
  // rareté révélée, en gardant la montée selon la rareté (js/sound.js, PACKS). Achetés une fois, gardés pour toujours ;
  // le hash "snd" retient celui en service. "classic" (le son d'origine) est offert.
  // Priorité : les skins dont le son est l'identité (ASMR, Lab) gardent leurs chiffres ; le pack joue quand même la rareté.
  const SOUNDS = [
    { id: 'classic', name: 'Classic', emoji: '🎵', price: 0, desc: 'The original wooden notes' },
    { id: 'arcade', name: 'Arcade', emoji: '👾', price: 300, desc: '8-bit chiptune blips' },
    { id: 'coins', name: 'Coins', emoji: '🪙', price: 400, desc: 'Coin clinks and a jackpot' },
    { id: 'drums', name: 'Drums', emoji: '🥁', price: 500, desc: 'Taps, toms and a cymbal crash' },
    { id: 'space', name: 'Space', emoji: '🛸', price: 650, desc: 'Soft synth zaps' },
    { id: 'glass', name: 'Glass', emoji: '🔔', price: 800, desc: 'Crystal chimes' },
  ];
  const soundById = new Map(SOUNDS.map(p => [p.id, p]));
  // Pack réellement joué : le choix s'il est possédé (Classic l'est toujours), sinon Classic.
  const soundPack = (choice, owned) => (soundById.has(choice) && (choice === 'classic' || (owned || []).includes(choice)) ? choice : 'classic');

  // Mises possibles pour un duel (0 = sans mise).
  const STAKES = [0, 50, 100, 250, 500, 1000];

  // Vitesse du tirage : 5 niveaux achetés l'un après l'autre. Chaque niveau raccourcit toute la révélation en solo
  // (chiffres, badges, fin de séquence) et, côté serveur, le délai entre deux tirages (8 s au départ, 4 s au niveau 5).
  // La révélation reste toujours un peu plus longue que ce délai. Les duels gardent leur rythme commun.
  const SPEED = { factors: [1, .9, .8, .7, .6, .5], prices: [1000, 2500, 6000, 15000, 40000] };
  const speedLevel = v => Math.max(0, Math.min(SPEED.prices.length, Math.floor(Number(v) || 0)));
  const speedFactor = v => SPEED.factors[speedLevel(v)];

  // Collection complète (titre Collectible Connoisseur, idée de kaz, 2026-10-20) : tous les skins sauf les limités.
  // Classic est le skin gratuit de départ : jamais rangé dans skins:<id>, il ne compte pas (PRISMA123 bloqué, 2026-10-22).
  const collectible = () => SKINS.filter(k => !k.until && k.id !== 'classic').map(k => k.id);
  // Badges de collection (idée de PRISMA123, 2026-10-22) : tous les boutons, toutes les émotes, tous les fonds hors limités.
  const collectibleSets = { buttons: () => BUTTONS.filter(b => !b.until && !b.hidden).map(b => b.id), emotes: () => EMOTES.filter(e => !e.until && !e.hidden).map(e => e.id), walls: () => WALLPAPERS.filter(w => !w.until && !w.hidden && w.price).map(w => w.id) };
  // Quelle clé ouvre quelle caisse (idée de keys, 2026-10-22) : une clé Premium ouvre aussi les caisses moins chères
  // (Starter, Fonds d'écran) ; l'Élite ne s'ouvre jamais avec une clé.
  // Part du créateur (idée de Gray alt, acceptée par Sacha à 5 %, 2026-10-22) : à chaque achat d'un skin né d'une idée de
  // joueur (champ idea), son auteur reçoit 5 % du prix en pièces. Créées en plus : l'acheteur paie le prix normal.
  const IDEA_SHARE = 0.05;
  const KEY_OPENS = { starter: ['starter'], premium: ['premium', 'starter', 'wallpaper'] };
  const api = { IDEA_SHARE, KEY_OPENS, collectible, collectibleSets, WALLPAPERS, wallById, COLLAB_LIVE, FISHER, SUPPORTER, FUND_GOAL, GOOGLE_BONUS, SPEED, speedLevel, speedFactor, COINS, DUEL_WIN_COINS, SKINS, OWNER, byId, resolve, earned, balance, rankedWins, CASES, caseById, casePool, caseOdds, caseItem, WALL_RARITIES, drawCase, DUPLICATE_REFUND, duplicateRefund, STAKES, RARITIES, rarityOf, BUTTONS, buttonById, MATCH, buttonLook, SOUNDS, soundById, soundPack, BASE_EMOTES, EMOTES, emoteById };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGShop = api;
})(typeof window !== 'undefined' ? window : globalThis);
