/* RNG∞ — version française de l'interface.
 * Le jeu est écrit en anglais ; ce module traduit ce qui s'affiche (textes, infobulles, champs) au moment où ça arrive
 * dans la page, et garde l'original de chaque texte pour revenir à l'anglais d'un clic. Rien d'autre du jeu ne change :
 * ni la logique, ni ce qui part au serveur. Un texte absent du dictionnaire reste simplement en anglais.
 * Non traduits, volontairement : les pseudos, les noms des 234 badges, des raretés, des skins et des titres
 * (vocabulaire du jeu, identique pour tous les joueurs).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- dictionnaire (texte anglais exact → français)
  const FR = {
    // navigation, barre du haut
    'Duel': 'Duel', 'Leaderboard': 'Classement', 'Badges': 'Badges', 'Stats': 'Stats', 'History': 'Historique', 'Shop': 'Boutique', 'Friends': 'Amis',
    'How it works': 'Comment ça marche', 'Player & settings': 'Joueur et réglages', 'Player': 'Joueur', 'Theme': 'Thème', 'Light': 'Clair', 'System': 'Système', 'Dark': 'Sombre',
    'Sound on': 'Son activé', 'Sound off': 'Son coupé', 'Sound': 'Son', 'Buy me a coffee': 'Offre-moi un café', 'RNG∞ on GitHub': 'RNG∞ sur GitHub', 'Close': 'Fermer',
    'RNG∞ needs JavaScript to roll.': 'RNG∞ a besoin de JavaScript pour tirer.',
    // accueil
    'Infinite rolls. One number at a time. What will yours be?': 'Des tirages à l\'infini. Un nombre à la fois. Quel sera le tien ?',
    'Generate': 'Générer', 'pick a name': 'choisis un pseudo', 'playing as': 'tu joues en tant que', 'press': 'appuie sur', 'Space': 'Espace',
    'Watch the trailer': 'Voir la bande-annonce', '⚔️ Live duel with a friend': '⚔️ Duel en direct avec un ami', 'Live duel with a friend': 'Duel en direct avec un ami',
    'Create a duel': 'Créer un duel', 'Join': 'Rejoindre', 'CODE': 'CODE', 'Duel code': 'Code du duel', 'Recent rolls': 'Derniers tirages',
    'Based on': 'Inspiré de', ', without the daily limit': ', sans la limite quotidienne', 'Your best roll': 'Ton meilleur tirage', "Today's best roll": 'Meilleur tirage du jour',
    'rolled by': 'tiré par', 'No rolls yet today — be the first!': 'Aucun tirage aujourd\'hui — sois le premier !', 'lifetime XP': 'XP à vie',
    // quêtes
    'Daily quests': 'Quêtes du jour', 'Daily bonus': 'Bonus quotidien', 'Start a streak': 'Commence une série', '✓ Claimed': '✓ Réclamé', 'Claimed': 'Réclamé',
    'coins buy skins and cases in the': 'les pièces achètent skins et caisses dans la',
    'Make 20 rolls': 'Fais 20 tirages', 'Make 40 rolls': 'Fais 40 tirages', 'Earn 100,000 XP': 'Gagne 100 000 XP', 'Roll 8 Uncommon or better': 'Tire 8 Uncommon ou mieux',
    'Roll 3 Rare or better': 'Tire 3 Rare ou mieux', 'Roll an Epic or better': 'Tire un Epic ou mieux', 'Finish a duel (bots count)': 'Termine un duel (les bots comptent)',
    'Finish 3 duels (bots count)': 'Termine 3 duels (les bots comptent)', 'Win a duel against a player': 'Gagne un duel contre un joueur',
    'Quests unavailable right now, try again': 'Quêtes indisponibles pour le moment, réessaie', 'Quest not finished yet': 'Quête pas encore terminée',
    'Reward already claimed': 'Récompense déjà réclamée', 'Daily bonus already claimed, come back tomorrow': 'Bonus quotidien déjà pris, reviens demain',
    // tirage / résultat
    'Roll again': 'Retirer', 'Roll': 'Tirer', 'Share': 'Partager', 'Copy': 'Copier', 'Share this roll': 'Partager ce tirage', 'Share image': 'Partager l\'image', 'Copy image': 'Copier l\'image', 'Download': 'Télécharger', 'Copy text': 'Copier le texte', 'Send the image to Discord, a story or a friend.': 'Envoie l\'image sur Discord, en story ou à un ami.', 'Copy the image, then paste it in Discord (Ctrl/Cmd + V).': 'Copie l\'image, puis colle-la dans Discord (Ctrl/Cmd + V).', 'Image copied: paste it in Discord': 'Image copiée : colle-la dans Discord', 'Your browser cannot copy images: use Download': 'Ton navigateur ne sait pas copier les images : utilise Télécharger', 'Your browser cannot share images: use Download': 'Ton navigateur ne sait pas partager les images : utilise Télécharger', 'Roll speed': 'Vitesse de tirage', 'a faster reveal, so more rolls per minute': 'une révélation plus rapide, donc plus de tirages par minute', '8 s between rolls': '8 s entre deux tirages', 'Max level': 'Niveau max', 'Your rolls are as fast as they get. Duels keep their shared pace.': 'Tes tirages ne peuvent pas aller plus vite. Les duels gardent leur rythme commun.', 'Roll speed is already at its maximum': 'La vitesse de tirage est déjà au maximum', 'Buttons': 'Boutons', 'Emotes': 'Émotes', 'Cases': 'Caisses', 'Speed': 'Vitesse', 'Earn coins by rolling, with the daily quests and by winning duels.': 'Gagne des pièces en tirant, avec les quêtes du jour et en gagnant des duels.', 'How much? ⓘ': 'Combien ? ⓘ', 'how your number looks, on your rolls and in duels': 'l\'apparence de ton nombre, sur tes tirages et en duel', 'Your Generate button follows your skin. You can also wear the button of any skin you own, or one of the buttons sold only here.': 'Ton bouton Generate suit ton skin. Tu peux aussi porter le bouton de n\'importe quel skin que tu possèdes, ou l\'un des boutons vendus seulement ici.', 'Live': 'En direct', 'gave': 'a donné', 'took': 'a pris', 'At most 12 different bets per spin': '12 mises différentes au plus par tour', 'Too fast, try again in a second': 'Trop rapide, réessaie dans une seconde', 'Copied to clipboard': 'Copié dans le presse-papiers', 'NEW': 'NOUVEAU', '(earned)': '(obtenu)',
    'First roll on this device — welcome!': 'Premier tirage sur cet appareil — bienvenue !', 'Wait for the reveal to finish': 'Attends la fin de la révélation',
    'Leaderboard offline: this roll stays on your device only': 'Classement hors ligne : ce tirage reste sur ton appareil', 'Offline roll: not on the leaderboard': 'Tirage hors ligne : pas au classement',
    'Player id reset, roll again': 'Identifiant réinitialisé, retire', 'Session expired: sign in with Google again to get your player back': 'Session expirée : reconnecte-toi avec Google pour retrouver ton joueur',
    'Your lifetime XP': 'Ton XP à vie', 'Badge breakdown': 'Détail des badges', 'Total': 'Total', 'Rarity': 'Rareté', 'Family': 'Famille', 'First found': 'Trouvé le', 'Expected': 'Attendu',
    'You earned it': 'Tu l\'as obtenu', 'Not yet': 'Pas encore', 'not found': 'pas trouvé', 'Custom badge — not in the original game': 'Badge maison — absent du jeu d\'origine',
    'Could not save — storage is full. Export your history from the player menu.': 'Sauvegarde impossible — stockage plein. Exporte ton historique depuis le menu joueur.',
    // pseudo, réglages, compte
    'Choose your player name': 'Choisis ton pseudo', 'Your name': 'Ton pseudo', 'Player name': 'Pseudo', 'Save & roll': 'Enregistrer et tirer', 'Save': 'Enregistrer', 'Name saved': 'Pseudo enregistré',
    'That name is not valid.': 'Ce pseudo n\'est pas valide.', 'It appears on the leaderboard next to your best rolls. Each name belongs to one player only.': 'Il apparaît au classement à côté de tes meilleurs tirages. Chaque pseudo n\'appartient qu\'à un seul joueur.',
    'Shown on the leaderboard. Each name belongs to one player only.': 'Affiché au classement. Chaque pseudo n\'appartient qu\'à un seul joueur.', 'This name is already taken, pick another one': 'Ce pseudo est déjà pris, choisis-en un autre',
    'Pick a player name first': 'Choisis d\'abord un pseudo', 'Account': 'Compte', 'Sign out': 'Se déconnecter', 'Signed in with Google as': 'Connecté avec Google :', 'your Google account': 'ton compte Google', 'your account': 'ton compte',
    'or sign in to keep your player on every device': 'ou connecte-toi pour garder ton joueur sur tous tes appareils', ', or sign in with Google if it is yours': ', ou connecte-toi avec Google si c\'est le tien',
    'Google sign-in could not load': 'La connexion Google n\'a pas pu se charger', 'Google sign-in failed, try again': 'Connexion Google échouée, réessaie', 'Google sign-in is unavailable right now.': 'Connexion Google indisponible pour le moment.',
    'Signed out: your history is saved in your Google account': 'Déconnecté : ton historique est gardé dans ton compte Google', 'Could not reach your account, try signing out again': 'Compte injoignable, réessaie de te déconnecter',
    'Roll animation': 'Animation du tirage', 'original': 'originale', 'normal': 'normale', 'Your data': 'Tes données', 'Export history': 'Exporter l\'historique', 'Import': 'Importer', 'Clear history': 'Effacer l\'historique',
    'History cleared': 'Historique effacé', 'History is already empty.': 'L\'historique est déjà vide.', 'That file is not a valid RNG∞ export.': 'Ce fichier n\'est pas un export RNG∞ valide.', 'My profile': 'Mon profil', 'Privacy policy': 'Confidentialité', 'Done': 'OK',
    // dons
    '☕ Buy me a coffee': '☕ Offre-moi un café', 'Donate with PayPal': 'Donner avec PayPal', 'Select and copy the address': 'Sélectionne et copie l\'adresse',
    'RNG∞ is free and has no ads. If you enjoy it, you can chip in. It is entirely optional and gives nothing in the game: no coins, no skins, no luck.': 'RNG∞ est gratuit et sans pub. Si tu l\'aimes, tu peux participer. C\'est entièrement facultatif et ça ne donne rien dans le jeu : ni pièces, ni skins, ni chance.',
    'Send only USDT or USDC on Ethereum to this address. Anything sent on another network may be lost.': 'N\'envoie que de l\'USDT ou de l\'USDC sur Ethereum à cette adresse. Tout envoi sur un autre réseau peut être perdu.',
    'Crypto — USDT or USDC, Ethereum network (ERC-20) only': 'Crypto — USDT ou USDC, réseau Ethereum (ERC-20) uniquement',
    // historique
    'Roll history': 'Historique des tirages', 'Search a number or a badge…': 'Cherche un nombre ou un badge…', 'All rarities': 'Toutes les raretés', 'Newest first': 'Plus récents d\'abord', 'Oldest first': 'Plus anciens d\'abord',
    'Highest XP': 'XP le plus haut', 'Lowest XP': 'XP le plus bas', 'No rolls yet.': 'Aucun tirage pour l\'instant.', 'No roll matches.': 'Aucun tirage ne correspond.', 'Go roll': 'Aller tirer', 'Sort': 'Trier', 'just now': 'à l\'instant', 'yesterday': 'hier',
    // stats
    'Your rolls': 'Tes tirages', 'Rolls': 'Tirages', 'Lifetime XP': 'XP à vie', 'Best roll': 'Meilleur tirage', 'Median roll': 'Tirage médian', 'Luck (avg percentile)': 'Chance (percentile moyen)', 'XP per roll': 'XP par tirage',
    'Rarity distribution': 'Répartition des raretés', 'your rolls vs. expected odds': 'tes tirages face aux chances attendues', 'Your digits': 'Tes chiffres', 'Digit frequency': 'Fréquence des chiffres', 'share of all digits rolled': 'part de tous les chiffres tirés',
    'Where numbers land': 'Où tombent les nombres', 'rolls per 100,000 range': 'tirages par tranche de 100 000', 'Streaks & oddities': 'Séries et curiosités', 'Longest run without Rare+': 'Plus longue série sans Rare+',
    'Rolls since last Rare or better': 'Tirages depuis le dernier Rare ou mieux', 'Rolls since last Epic or better': 'Tirages depuis le dernier Epic ou mieux', 'Rolls since last Mythic': 'Tirages depuis le dernier Mythic',
    'Numbers rolled more than once': 'Nombres tirés plus d\'une fois', 'Rarest badge': 'Badge le plus rare', 'Rarest badge found': 'Badge le plus rare trouvé', 'Your top 5': 'Ton top 5', 'Top 10 rolls': 'Top 10 des tirages',
    'click a number for its badges': 'clique un nombre pour voir ses badges', 'Rare or better': 'Rare ou mieux', 'First roll': 'Premier tirage', 'none': 'aucun', "You've rolled": 'Tu as tiré',
    // badges, succès, titres
    'Badge collection': 'Collection de badges', 'Badges found': 'Badges trouvés', 'Search badges…': 'Cherche un badge…', 'No badge matches.': 'Aucun badge ne correspond.', 'Badge rarity & XP': 'Rareté et XP des badges',
    'Achievements & titles': 'Succès et titres', 'Achievements': 'Succès', 'Equip': 'Équiper', 'Equipped': 'Équipé', 'Unequip': 'Retirer', 'Title removed': 'Titre retiré', 'Could not change your title, try again': 'Impossible de changer ton titre, réessaie',
    'Loading your achievements…': 'Chargement de tes succès…', 'Achievements unavailable right now.': 'Succès indisponibles pour le moment.', 'Roll once to start unlocking achievements and titles.': 'Fais un tirage pour commencer à débloquer succès et titres.',
    ' · equip one: its title shows next to your name on the leaderboard and in duels': ' · équipes-en un : son titre s\'affiche à côté de ton pseudo au classement et en duel',
    'equip one: its title shows next to your name on the leaderboard and in duels': 'équipes-en un : son titre s\'affiche à côté de ton pseudo au classement et en duel',
    'Make your first roll': 'Fais ton premier tirage', 'Make 100 rolls': 'Fais 100 tirages', 'Make 1,000 rolls': 'Fais 1 000 tirages', 'Make 10,000 rolls': 'Fais 10 000 tirages', 'Roll a Trash number (bottom 1%)': 'Tire un nombre Trash (1 % le plus bas)',
    'Roll a Rare or better': 'Tire un Rare ou mieux', 'Roll an Anomaly or better': 'Tire un Anomaly ou mieux', 'Roll a Mythic or better (top 1%)': 'Tire un Mythic ou mieux (top 1 %)', 'Roll 10 Mythics or better': 'Tire 10 Mythic ou mieux', 'Roll a Celestial or better (top 0.1%)': 'Tire un Celestial ou mieux (top 0,1 %)', 'Roll a Divine or better (top 0.01%)': 'Tire un Divine ou mieux (top 0,01 %)', 'Roll an Infinite (top 0.001%: one of the 9 best numbers in the game)': 'Tire un Infinite (top 0,001 % : l\'un des 9 meilleurs nombres du jeu)', 'Rolls since last Mythic or better': 'Tirages depuis le dernier Mythic ou mieux', 'top 1–0.1%': 'top 1–0,1 %', 'top 0.1–0.01% (900 numbers)': 'top 0,1–0,01 % (900 nombres)', 'top 0.01–0.001% (90 numbers)': 'top 0,01–0,001 % (90 nombres)', 'top 0.001% (the 9 best numbers)': 'top 0,001 % (les 9 meilleurs nombres)',
    'Roll a number worth 1,000,000 XP or more': 'Tire un nombre valant 1 000 000 XP ou plus', 'Earn the Drastix badge (a number containing 235)': 'Obtiens le badge Drastix (un nombre contenant 235)',
    'Find 50 different badges': 'Trouve 50 badges différents', 'Find 100 different badges': 'Trouve 100 badges différents', 'Find 150 different badges': 'Trouve 150 badges différents',
    'Hold the best roll of the day on the leaderboard': 'Détiens le meilleur tirage du jour au classement', 'Win a duel': 'Gagne un duel', 'Win 10 duels': 'Gagne 10 duels',
    'Win a rounds duel (first to 2 or more) without anyone else winning a round': 'Gagne un duel en manches (premier à 2 ou plus) sans qu\'un autre gagne une manche',
    'Win a duel with 5 players or more': 'Gagne un duel à 5 joueurs ou plus', 'Win an XP race duel': 'Gagne un duel en course à l\'XP', 'Made RNG∞': 'A créé RNG∞',
    // classement
    'Today': 'Aujourd\'hui', 'This week': 'Cette semaine', 'All-time': 'Depuis toujours', 'Best single roll per player · days reset at midnight UTC': 'Meilleur tirage de chaque joueur · remise à zéro à minuit UTC',
    'Best single roll per player': 'Meilleur tirage de chaque joueur', 'days reset at midnight UTC': 'remise à zéro à minuit UTC', 'Total XP of every roll ever made': 'XP total de tous les tirages jamais faits',
    'change': 'changer', 'Leaderboard unavailable right now.': 'Classement indisponible pour le moment.', '(you)': '(toi)', 'you:': 'toi :',
    // profil
    '← Leaderboard': '← Classement', 'Profile unavailable right now.': 'Profil indisponible pour le moment.', 'No rolls yet': 'Aucun tirage', 'All-time rank': 'Rang depuis toujours', 'best single roll': 'meilleur tirage',
    'Best rolls': 'Meilleurs tirages', 'Duels': 'Duels', 'Duels won': 'Duels gagnés', 'Duel win rate': 'Taux de victoire', 'no duel between you yet': 'aucun duel entre vous', 'you lead': 'tu mènes', 'You': 'Toi',
    '👥 Add friend': '👥 Ajouter en ami', 'Add friend': 'Ajouter en ami',
    // amis
    'Add players by name to follow their progress and jump into their duels.': 'Ajoute des joueurs par leur pseudo pour suivre leur progression et rejoindre leurs duels.', 'Friend requests': 'Demandes d\'ami', 'Your friends': 'Tes amis',
    'Requests sent': 'Demandes envoyées', 'Accept': 'Accepter', 'Decline': 'Refuser', 'Cancel': 'Annuler', 'Join / watch': 'Rejoindre / regarder', 'in a duel right now': 'en duel en ce moment', 'no roll yet': 'aucun tirage',
    'No friends yet. Add one by name above, or from a player profile.': 'Pas encore d\'amis. Ajoutes-en un par son pseudo ci-dessus, ou depuis un profil.', 'Roll once (and pick a name) to add friends.': 'Fais un tirage (et choisis un pseudo) pour ajouter des amis.',
    'Friends unavailable right now.': 'Amis indisponibles pour le moment.', 'Friends unavailable right now, try again': 'Amis indisponibles pour le moment, réessaie', 'Enter a player name': 'Entre un pseudo', 'Request sent': 'Demande envoyée',
    'You are now friends': 'Vous êtes maintenant amis', 'Already friends': 'Déjà amis', 'No player with this name': 'Aucun joueur avec ce pseudo', 'That is you': 'C\'est toi', 'This request is gone': 'Cette demande n\'existe plus',
    'Too many pending requests': 'Trop de demandes en attente', 'This player has too many pending requests': 'Ce joueur a trop de demandes en attente', 'Friends list full': 'Liste d\'amis pleine',
    // duel : accueil et création
    'Everyone rolls at the same time and all numbers are revealed together, digit by digit. Duel rolls are normal rolls: they stay in your history and count on the leaderboard.': 'Tout le monde tire en même temps et tous les nombres se révèlent ensemble, chiffre par chiffre. Les tirages de duel sont des tirages normaux : ils restent dans ton historique et comptent au classement.',
    'Live now': 'En direct', 'public games · watch or join without a code': 'parties publiques · regarde ou rejoins sans code', 'public games': 'parties publiques', 'watch or join without a code': 'regarde ou rejoins sans code',
    'No public game right now. Create one!': 'Aucune partie publique pour l\'instant. Crées-en une !', 'Live games unavailable right now.': 'Parties en direct indisponibles pour le moment.', 'Watch': 'Regarder', 'Back to it': 'Y retourner',
    'waiting for players': 'en attente de joueurs', 'New duel': 'Nouveau duel', 'Join with a code': 'Rejoindre avec un code', 'Ask the host for the 5-character code, or open the link they share.': 'Demande le code à 5 caractères à l\'hôte, ou ouvre le lien qu\'il partage.',
    '1 · Who do you play against?': '1 · Contre qui joues-tu ?', 'Who do you play against?': 'Contre qui joues-tu ?', 'Other players': 'D\'autres joueurs', 'You get a code to share': 'Tu reçois un code à partager', 'Bots': 'Des bots', 'Starts right away': 'Démarre tout de suite',
    '2 · How many players?': '2 · Combien de joueurs ?', 'How many players?': 'Combien de joueurs ?', '3 · How do you win?': '3 · Comment gagne-t-on ?', 'How do you win?': 'Comment gagne-t-on ?', 'Rounds': 'Manches', 'The highest roll wins the round': 'Le plus gros tirage gagne la manche',
    'XP race': 'Course à l\'XP', 'Every roll adds up': 'Tous les tirages s\'additionnent', 'First to reach': 'Premier à atteindre', 'First to win': 'Premier à gagner', 'round': 'manche', 'rounds': 'manches',
    '4 · Who can join?': '4 · Qui peut rejoindre ?', 'Who can join?': 'Qui peut rejoindre ?', 'Everyone': 'Tout le monde', 'Listed in Live now': 'Visible dans En direct', 'Only with the code': 'Seulement avec le code', 'Hidden from the list': 'Cachée de la liste',
    '5 · Play for coins?': '5 · Jouer pour des pièces ?', 'Play for coins?': 'Jouer pour des pièces ?', 'optional': 'facultatif', 'No stake': 'Sans mise', 'Just for fun: nobody pays anything.': 'Juste pour le fun : personne ne paie rien.',
    '⚔️ Create the duel': '⚔️ Créer le duel', 'against bots': 'contre des bots', 'public': 'publique', 'private': 'privée', 'Less': 'Moins', 'More': 'Plus',
    'Against bots your rolls count as usual, but not duel wins, rivalries or duel achievements.': 'Contre des bots, tes tirages comptent comme d\'habitude, mais pas les victoires de duel, les rivalités ni les succès de duel.',
    'Enter the 5-character duel code': 'Entre le code du duel (5 caractères)', 'No duel with this code': 'Aucun duel avec ce code', 'Duel unavailable right now, try again': 'Duel indisponible pour le moment, réessaie',
    // duel : salle
    '← Duel': '← Duel', 'Live duel': 'Duel en direct', 'each round goes to the highest roll': 'chaque manche va au plus gros tirage', 'duel rolls count on the leaderboard': 'les tirages de duel comptent au classement',
    'with bots: your rolls count, but not duel wins or rivalries': 'avec des bots : tes tirages comptent, mais pas les victoires ni les rivalités', 'Share invite': 'Partager l\'invitation', 'Duel invite': 'Invitation au duel',
    'Waiting for players…': 'En attente de joueurs…', 'Start now, or wait: the game starts by itself when it is full': 'Démarre maintenant, ou attends : la partie démarre toute seule quand elle est pleine',
    '🤖 Add a bot': '🤖 Ajouter un bot', '⚔️ Join': '⚔️ Rejoindre', '⚔️ Ask to join': '⚔️ Demander à rejoindre', '⚔️ New game': '⚔️ Nouvelle partie', 'New game': 'Nouvelle partie', '🔁 Rematch': '🔁 Revanche', 'Back to the rematch': 'Retour à la revanche',
    'Watching live': 'Tu regardes en direct', 'Request sent: waiting for the host…': 'Demande envoyée : en attente de l\'hôte…', 'wants to join': 'veut rejoindre', 'ready': 'prêt', 'No round yet.': 'Aucune manche pour l\'instant.',
    'tie at the top': 'égalité en tête', '⏹ This duel ended': '⏹ Ce duel est terminé', 'This duel ended': 'Ce duel est terminé', 'Paused after 10 minutes without activity.': 'En pause après 10 minutes sans activité.', 'Resume': 'Reprendre',
    'No duel with this code. Duels are kept for one day.': 'Aucun duel avec ce code. Les duels sont gardés un jour.', 'Reaction not sent': 'Réaction non envoyée', '🤝 Draw': '🤝 Égalité', 'stakes refunded': 'mises remboursées',
    'This duel has already started': 'Ce duel a déjà commencé', 'This duel is full': 'Ce duel est complet', 'This duel is over': 'Ce duel est terminé', 'This duel ended: everyone left': 'Ce duel est terminé : tout le monde est parti',
    'You are not in this duel': 'Tu n\'es pas dans ce duel', 'Only the host can start the duel': 'Seul l\'hôte peut lancer le duel', 'Only the host can add bots': 'Seul l\'hôte peut ajouter des bots', 'Wait for at least one opponent': 'Attends au moins un adversaire',
    'No bots in a duel with a stake': 'Pas de bots dans un duel avec mise', 'This duel has a stake: nobody can join once it has started': 'Ce duel a une mise : personne ne peut entrer une fois commencé',
    // boutique, caisses
    'Skins': 'Skins', 'Cases': 'Caisses', 'a random skin · the pricier the skin, the rarer': 'un skin au hasard · plus le skin est cher, plus il est rare', 'a random skin': 'un skin au hasard', 'the pricier the skin, the rarer': 'plus le skin est cher, plus il est rare',
    'Already own the skin you draw? Half of the case price comes back. Coins only, no real money.': 'Tu possèdes déjà le skin tiré ? La moitié du prix de la caisse t\'est rendue. Des pièces uniquement, pas d\'argent réel.',
    'Starter Case': 'Caisse Starter', 'Premium Case': 'Caisse Premium', 'A skin worth 200 to 800 coins': 'Un skin valant 200 à 800 pièces', 'A skin worth 800 to 5,000 coins': 'Un skin valant 800 à 5 000 pièces', 'Odds ⓘ': 'Chances ⓘ', 'Odds': 'Chances',
    'new skin unlocked!': 'nouveau skin débloqué !', 'Roll once to start earning coins.': 'Fais un tirage pour commencer à gagner des pièces.', 'Shop unavailable right now.': 'Boutique indisponible pour le moment.',
    'Shop unavailable right now, try again': 'Boutique indisponible pour le moment, réessaie', 'Purchase already in progress': 'Achat déjà en cours', 'Buy this skin first': 'Achète d\'abord ce skin', 'This skin is not for sale': 'Ce skin n\'est pas à vendre',
    // Skins premium et aperçu (boutique)
    'Legendary skins': 'Skins légendaires', 'a full animated signature around your number': 'une signature animée complète autour de ton nombre', 'also plays in duels': 'jouée aussi en duel',
    '▶ Preview': '▶ Aperçu', 'Preview': 'Aperçu', '↻ Replay': '↻ Rejouer', 'shown as a Mythic roll, the strongest reveal': 'montré comme un tirage Mythic, la révélation la plus forte',
    'A blade, a branch in bloom, a rising moon': 'Une lame, une branche en fleurs, la lune qui se lève', 'Lightning strikes every digit': 'La foudre frappe chaque chiffre', 'A dragon circles your number and forges it': 'Un dragon tourne autour de ton nombre et le forge', 'Light bends around your number': 'La lumière se courbe autour de ton nombre',
    // Tirages hors ligne (le serveur n'a pas répondu) : gardés, non comptés
    'Server unreachable: this roll stays on your device and is not counted': 'Serveur injoignable : ce tirage reste sur ton appareil et ne compte pas', 'The server is slow to answer, trying again…': 'Le serveur tarde à répondre, nouvel essai…',
    'offline roll': 'tirage hors ligne', 'not counted': 'non compté', 'offline': 'hors ligne', 'Rolled while the server was unreachable: not counted on the leaderboard or in your lifetime XP': 'Tiré alors que le serveur était injoignable : ne compte ni au classement ni dans ton XP à vie',
    // Gamble
    'Gamble': 'Casino', 'Roulette': 'Roulette', 'Blackjack': 'Blackjack', 'one zero': 'un seul zéro', 'red or black pays 2×': 'rouge ou noir paie 2×', 'a number pays 36×': 'un numéro paie 36×', 'dealer stands on 17': 'le croupier reste à 17', 'blackjack pays 3 to 2': 'le blackjack paie 3 pour 2',
    'Red': 'Rouge', 'Black': 'Noir', 'Even': 'Pair', 'Odd': 'Impair', '+ Number': '+ Numéro', 'Number': 'Numéro', 'Clear': 'Effacer', 'Spin': 'Lancer', 'Hit': 'Carte', 'Stand': 'Rester', 'Double': 'Doubler', 'Dealer': 'Croupier',
    'Place a bet and deal.': 'Mise, puis distribue.', 'Place a bet first': 'Pose d\'abord une mise', 'Pick a number from 0 to 36': 'Choisis un numéro de 0 à 36', 'Maximum 1,000 coins per spin': '1 000 pièces au plus par tour', 'One move at a time': 'Un coup à la fois', 'Gamble unavailable right now, try again': 'Casino indisponible pour le moment, réessaie',
    'Blackjack!': 'Blackjack !', 'You win': 'Tu gagnes', 'Push: your bet comes back': 'Égalité : ta mise revient', 'Dealer wins': 'Le croupier gagne', 'Bust': 'Sauté', 'Finish your hand first': 'Termine d\'abord ta main', 'No hand in progress': 'Aucune main en cours', 'Invalid bet': 'Mise invalide', 'You can only double on your first two cards': 'On ne double que sur ses deux premières cartes',
    'Skip known badges': 'Passer les badges connus', 'Badges you already own appear at once. New badges always get their full reveal.': 'Les badges que tu as déjà s\'affichent d\'un coup. Un nouveau badge garde toujours sa révélation complète.',
    'What\'s new': 'Nouveautés', '▶ Rewatch': '▶ Revoir', '← Back': '← Retour', 'nothing is rolled or counted': 'rien n\'est tiré ni compté', '▶ Replay': '▶ Rediffusion',
    'Bet': 'Mise', 'Crash': 'Crash', 'Mines': 'Mines', 'Plinko': 'Plinko', 'cash out before it crashes': 'encaisse avant que ça explose', 'every safe tile raises the payout': 'chaque case sûre fait monter le gain', 'one mine ends it': 'une mine et c\'est fini', '12 rows': '12 rangées', 'the edges pay the most': 'les bords paient le plus',
    'Start': 'Démarrer', 'Drop': 'Lâcher', 'Pick a tile': 'Choisis une case', 'Finish your game first': 'Termine d\'abord ta partie', 'No game in progress': 'Aucune partie en cours', 'Open a tile first': 'Ouvre d\'abord une case', 'Pick a closed tile': 'Choisis une case fermée', 'Between 1 and 24 mines': 'Entre 1 et 24 mines',
    'Coins': 'Pièces', 'Your coins': 'Tes pièces', 'Coins each player holds right now': 'Les pièces que chaque joueur possède en ce moment', 'refreshed every minute': 'actualisé chaque minute',
    // Chat du duel
    'Chat': 'Chat', 'be kind': 'reste sympa', 'never share personal details': 'ne donne jamais d\'informations personnelles', 'Write a message…': 'Écris un message…', 'Message': 'Message',
    'Only players in this duel can write.': 'Seuls les joueurs de ce duel peuvent écrire.', 'Only players in this duel can write': 'Seuls les joueurs de ce duel peuvent écrire', 'No message yet. Say hi!': 'Aucun message pour l\'instant. Dis bonjour !',
    'Hide': 'Masquer', 'Hide this player\'s messages': 'Masquer les messages de ce joueur', 'Show again': 'Réafficher', 'Slow down a little': 'Doucement, pas si vite', 'Message not sent': 'Message non envoyé', 'Write something first': 'Écris d\'abord quelque chose',
    // Émotes spéciales (boutique, duel)
    'Emotes': 'Émotes', 'animated reactions for your duels': 'des réactions animées pour tes duels', 'everyone sees them': 'tout le monde les voit', 'Owned': 'Possédée',
    'The six classic emotes are free. These ones move: buy one once and it joins your reaction bar in every duel.': 'Les six émotes classiques sont gratuites. Celles-ci bougent : achètes-en une une fois, elle rejoint ta barre de réactions dans tous les duels.',
    'Buy this emote first': 'Achète d\'abord cette émote', 'Unknown emote': 'Émote inconnue',
    // Boutons de tirage (boutique)
    'Generate button': 'Bouton Générer', 'only you see it': 'toi seul le vois', 'press one to try it': 'appuie dessus pour l\'essayer',
    'Your Generate button follows your skin: every skin comes with its own button. You can also wear the button of any skin you own, or one of the buttons sold only here.': 'Ton bouton Générer suit ton skin : chaque skin a son propre bouton. Tu peux aussi porter le bouton de n\'importe quel skin que tu possèdes, ou l\'un des boutons vendus uniquement ici.',
    '🔗 Match my skin': '🔗 Assorti à mon skin', 'Follows the skin you have equipped': 'Suit le skin que tu as équipé', 'Comes with your skin': 'Fourni avec ton skin', 'Comes with the skin': 'Fourni avec le skin', '🔒 Get the skin': '🔒 Obtiens le skin',
    'Your button now follows your skin': 'Ton bouton suit maintenant ton skin', 'Unknown button': 'Bouton inconnu', 'Buy this button first': 'Achète d\'abord ce bouton', 'This button comes with its skin: get the skin first': 'Ce bouton est fourni avec son skin : obtiens d\'abord le skin',
    'A chunky mechanical key': 'Une grosse touche mécanique', 'Run the command yourself': 'Lance la commande toi-même', 'Big red cabinet button': 'Gros bouton rouge de borne', 'Tear off a raffle ticket': 'Détache un billet de tombola',
    'Halftone and a loud outline': 'Trame de points et gros contour', 'Hazard stripes, handle with care': 'Bandes de danger, à manier avec soin', 'Foil that shifts with the light': 'Un film qui change avec la lumière', 'Velvet with a gold trim': 'Velours et liseré d\'or',
    'The original look': 'Le style d\'origine', 'Glowing tubes': 'Tubes lumineux', 'Old pocket calculator': 'Vieille calculatrice de poche', '8-bit arcade': 'Arcade 8 bits', 'Glossy jelly sweets': 'Bonbons gélifiés brillants', 'Soccer shirt number': 'Numéro de maillot de foot',
    'Casino reels': 'Rouleaux de casino', 'Stadium LED board': 'Tableau LED de stade', 'Digits on dice': 'Chiffres sur des dés', 'Deep sea and bubbles': 'Fonds marins et bulles', 'Polished metal': 'Métal poli', 'Pixel grass blocks to mine': 'Blocs d\'herbe pixel à miner',
    'Frozen crystal': 'Cristal gelé', 'Solid gold': 'Or massif', 'Live circuit board': 'Circuit imprimé vivant', 'Falling green code': 'Pluie de code vert', 'Glowing vintage tubes': 'Tubes vintage lumineux', 'Burning digits': 'Chiffres en feu',
    'Retro sunset grid': 'Coucher de soleil rétro', 'Written in the stars': 'Écrit dans les étoiles', 'Cut gemstone': 'Gemme taillée', 'Every color at once': 'Toutes les couleurs à la fois', 'Ruby, for the creator only': 'Rubis, réservé au créateur',
    // à propos
    'What is RNG∞?': 'RNG∞, c\'est quoi ?', 'Discover': 'Découvre', 'Collect': 'Collectionne', 'Track': 'Suis', 'Number rarity': 'Rareté des nombres', 'Based on the daily game': 'Inspiré du jeu quotidien',
    "Your roll's rarity compares its total XP with every possible roll.": 'La rareté de ton tirage compare son XP total à celui de tous les tirages possibles.', 'A badge is worth': 'Un badge vaut', 'more than 10% of rolls': 'plus de 10 % des tirages',
    '— see which badges your number earns.': '— découvre les badges que ton nombre obtient.', '— every roll is kept in your history and stats.': '— chaque tirage est gardé dans ton historique et tes stats.',
    'Click a name on the leaderboard to see that player\'s profile (best rolls, badge collection) and compare it with yours.': 'Clique un pseudo au classement pour voir le profil du joueur (meilleurs tirages, collection de badges) et le comparer au tien.',
    'No one around? Play a duel against bots from the Duel tab: your rolls count as usual, but not duel wins, rivalries or duel achievements.': 'Personne en ligne ? Joue un duel contre des bots depuis l\'onglet Duel : tes tirages comptent comme d\'habitude, mais pas les victoires de duel, les rivalités ni les succès de duel.',
    // compléments (audit de couverture)
    'to roll again': 'pour retirer', 'click a badge name for details': 'clique le nom d\'un badge pour le détail', 'all': 'tous', 'found': 'trouvés', 'missing': 'manquants', 'Luck': 'Chance',
    'avg percentile': 'percentile moyen', 'log scale': 'échelle log', 'click a point': 'clique un point', 'typical roll': 'tirage typique', 'never': 'jamais', 'off': 'coupé', 'light': 'clair', 'system': 'système', 'dark': 'sombre',
    'Sign in to keep the same player, your leaderboard spots and your whole roll history (stats, badges) on every device.': 'Connecte-toi pour garder le même joueur, tes places au classement et tout ton historique (stats, badges) sur tous tes appareils.',
    'Numbers are drawn by the server, so nobody can pick their own 1337. Your best roll of the day, the week and all time goes on the leaderboard under your player name.': 'Les nombres sont tirés par le serveur : personne ne peut choisir son 1337. Ton meilleur tirage du jour, de la semaine et de toujours va au classement sous ton pseudo.',
    'Coins and skins: every roll earns coins (more for rarer rolls) and so does every duel you win. Spend them in the Shop tab on skins that change how your number looks. In-game coins only.': 'Pièces et skins : chaque tirage rapporte des pièces (plus s\'il est rare), chaque duel gagné aussi. Dépense-les dans l\'onglet Boutique pour des skins qui changent l\'apparence de ton nombre. Des pièces du jeu uniquement.',
    'Achievements unlock titles: equip one from your profile and it shows next to your name on the leaderboard and in duels. They are checked by the server, so nobody can wear a title they did not earn.': 'Les succès débloquent des titres : équipes-en un depuis ton profil et il s\'affiche à côté de ton pseudo au classement et en duel. Ils sont vérifiés par le serveur : personne ne peut porter un titre qu\'il n\'a pas gagné.',
    'Duel (top menu): create a game for 2 to 10 players and send the code. Everyone rolls at the same time and all numbers are revealed together; each round goes to the highest roll. Win by being first to 1–10 round wins, or first to an XP total. Duel rolls are normal rolls, so they stay in your history and can make the leaderboard.': 'Duel (menu du haut) : crée une partie pour 2 à 10 joueurs et envoie le code. Tout le monde tire en même temps et tous les nombres se révèlent ensemble ; chaque manche va au plus gros tirage. Gagne en étant le premier à 1–10 manches gagnées, ou à un total d\'XP. Les tirages de duel sont des tirages normaux : ils restent dans ton historique et peuvent entrer au classement.',
    'Sign in with Google to keep your history, stats and badges on every device. You can also export them (JSON) from the player menu.': 'Connecte-toi avec Google pour garder ton historique, tes stats et tes badges sur tous tes appareils. Tu peux aussi les exporter (JSON) depuis le menu joueur.',
    ': this version removes the daily limit and adds history, stats, Google sign-in and a leaderboard between friends.': ' : cette version retire la limite quotidienne et ajoute l\'historique, les stats, la connexion Google et un classement entre amis.',
    '— hit Generate (or Space) as often as you like.': '— appuie sur Générer (ou Espace) autant que tu veux.', 'XP, so a badge earned by 1 number in 1,000 is worth about 100,000 XP. Related badges form a family (e.g. Pair → Two Pair → Three Pair); only the best badge of a family counts toward your total.': 'XP : un badge obtenu par 1 nombre sur 1 000 vaut donc environ 100 000 XP. Les badges proches forment une famille (ex. Pair → Two Pair → Three Pair) ; seul le meilleur badge d\'une famille compte dans ton total.',
    '100 × 1,000,001 ÷ (numbers that earn it)': '100 × 1 000 001 ÷ (nombres qui l\'obtiennent)', 'under 0.001% (1 in 100,000+)': 'moins de 0,001 % (1 sur 100 000 et plus)',
    'Common': 'Common', 'Legendary': 'Legendary',
    'you already beat this opponent 3 times today': 'tu as déjà battu cet adversaire 3 fois aujourd\'hui', 'you reached the limit of 10 rewarded wins today': 'tu as atteint la limite de 10 victoires récompensées aujourd\'hui',
    "your opponent's account is too new (under 20 rolls)": 'le compte de ton adversaire est trop récent (moins de 20 tirages)',
    // suggestions
    '💡 Suggest an idea': '💡 Proposer une idée', 'Suggest an idea': 'Proposer une idée', 'An idea, a bug, something missing? Your message goes straight to the creator of the game.': 'Une idée, un bug, un manque ? Ton message arrive directement au créateur du jeu.',
    'Your idea…': 'Ton idée…', 'Your idea': 'Ton idée', 'Send': 'Envoyer', 'Your suggestions': 'Tes suggestions', 'Reply from the creator': 'Réponse du créateur', 'Sent': 'Envoyée', 'Read': 'Lue', 'Planned': 'Prévue', 'Added': 'Ajoutée', 'Not planned': 'Pas prévue',
    'Write a few words first': 'Écris d\'abord quelques mots', 'Thanks! Your suggestion was sent': 'Merci ! Ta suggestion est envoyée', 'Could not send your suggestion, try again': 'Envoi impossible, réessaie', '📥 Inbox & visitors': '📥 Suggestions reçues et visiteurs',
    // accueil des nouveaux joueurs
    'Every number hides badges': 'Chaque nombre cache des badges', 'Duel your friends, live': 'Défie tes amis en direct', 'Earn coins, unlock skins': 'Gagne des pièces, débloque des skins',
    'Create a duel, share the code, and everyone rolls at the same time. The highest roll wins the round. Nobody around? Play against bots.': 'Crée un duel, partage le code, et tout le monde tire en même temps. Le plus gros tirage gagne la manche. Personne en ligne ? Joue contre des bots.',
    'Every roll earns coins. So do the daily quests and your duel wins. Spend them in the Shop on skins and cases that change how your number looks.': 'Chaque tirage rapporte des pièces. Les quêtes du jour et tes victoires en duel aussi. Dépense-les dans la Boutique en skins et en caisses qui changent l\'apparence de ton nombre.',
    'Skip': 'Passer', 'Next': 'Suivant', 'Back': 'Retour', '🎲 Roll my first number': '🎲 Tirer mon premier nombre', 'Replay the intro': 'Revoir l\'intro',
    // page du créateur
    'Suggestions': 'Suggestions', 'Visits today': 'Visites aujourd\'hui', 'Visits, 7 days': 'Visites, 7 jours', 'Visits, 30 days': 'Visites, 30 jours', 'Players': 'Joueurs', 'Where visitors come from': 'D\'où viennent les visiteurs', '30 days': '30 jours',
    'Tagged links (?ref=…)': 'Liens marqués (?ref=…)', 'Countries': 'Pays', 'Device and language': 'Appareil et langue', 'Day by day': 'Jour par jour', 'players and rolls are kept 8 days': 'joueurs et tirages gardés 8 jours',
    'Day': 'Jour', 'Visits': 'Visites', 'Devices': 'Appareils', 'New': 'Nouveaux', 'Direct (typed, bookmark, app)': 'Direct (adresse tapée, favori, appli)', 'share': 'share', 'a shared roll': 'un tirage partagé', 'a duel invite': 'une invitation en duel',
    'Unknown': 'Inconnu', 'Nothing yet.': 'Rien pour l\'instant.', 'No suggestion yet.': 'Aucune suggestion pour l\'instant.', 'Delete': 'Supprimer', 'Save reply': 'Enregistrer la réponse', 'Reply saved': 'Réponse enregistrée',
    'Reply shown to the player (optional)': 'Réponse montrée au joueur (facultatif)', 'Status': 'Statut', 'This page is for the creator of the game.': 'Cette page est réservée au créateur du jeu.', 'Unavailable right now.': 'Indisponible pour le moment.',
    'Unavailable right now, try again': 'Indisponible pour le moment, réessaie', 'Owner only': 'Réservé à l\'Owner', 'Delete this suggestion?': 'Supprimer cette suggestion ?',
    'Anonymous daily counters, since 6 Oct 2026: no cookie, no IP address, nothing about who the visitor is. A visit = the site opened in a browser tab. Days in UTC.': 'Compteurs anonymes par jour, depuis le 6 oct. 2026 : pas de cookie, pas d\'adresse IP, rien sur l\'identité du visiteur. Une visite = le site ouvert dans un onglet. Jours en UTC.',
    // divers
    'Loading…': 'Chargement…', 'Home': 'Accueil', 'Invalid player': 'Joueur invalide', 'This player id belongs to someone else': 'Cet identifiant appartient à quelqu\'un d\'autre', 'Too fast, wait for the reveal to finish': 'Trop vite, attends la fin de la révélation',
  };

  // ---------------------------------------------------------------- phrases à nombres (motif → traduction)
  const s = n => (Number(String(n).replace(/[^\d.]/g, '')) === 1 ? '' : 's');
  const nb = n => String(n).replace(/,/g, ' '); // 1,000 → 1 000 (espace fine insécable)
  const P = [
    [/^([\d,]+) rolls?$/, m => `${nb(m[1])} tirage${s(m[1])}`],
    [/^([\d,]+) players?$/, m => `${nb(m[1])} joueur${s(m[1])}`],
    [/^([\d,]+) bots?$/, m => `${m[1]} bot${s(m[1])}`],
    [/^([\d,]+) opponents?$/, m => `${m[1]} adversaire${s(m[1])}`],
    [/^([\d,]+) rounds?$/, m => `${m[1]} manche${s(m[1])}`],
    [/^([\d,]+) days? streak$/, m => `série de ${m[1]} jour${s(m[1])}`],
    [/^([\d,]+) new badges?$/, m => `${m[1]} nouveau${s(m[1]) ? 'x' : ''} badge${s(m[1])}`],
    [/^([\d,]+) more badges?$/, m => `${m[1]} autre${s(m[1])} badge${s(m[1])}`],
    [/^\+([\d,]+) more$/, m => `+${m[1]} autres`],
    [/^([\d,]+) more$/, m => `${m[1]} autres`], [/^([\d,]+) coins$/, m => `${nb(m[1])} pièces`],
    [/^You \+ ([\d,]+) (bot|opponent)s?$/, m => `Toi + ${m[1]} ${m[2] === 'bot' ? 'bot' : 'adversaire'}${s(m[1])}`],
    [/^first to ([\d,]+) round wins?$/, m => `premier à ${m[1]} manche${s(m[1])} gagnée${s(m[1])}`],
    [/^first to (\S+) XP$/, m => `premier à ${m[1]} XP`],
    [/^(\S+) lifetime XP$/, m => `${nb(m[1])} XP à vie`],
    [/^last roll (.+)$/, m => `dernier tirage ${one(m[1])}`],
    [/^Playing since (.+)$/, m => `Joue depuis le ${m[1]}`],
    [/^(\d+)m ago$/, m => `il y a ${m[1]} min`], [/^(\d+)h ago$/, m => `il y a ${m[1]} h`], [/^(\d+)d ago$/, m => `il y a ${m[1]} j`],
    [/^New quests in (\d+) (h|min)$/, m => `Nouvelles quêtes dans ${m[1]} ${m[2]}`],
    [/^tomorrow: (\d+) coins$/, m => `demain : ${m[1]} pièces`],
    [/^\+([\d,]+) coins$/, m => `+${nb(m[1])} pièces`],
    [/^Play with the coins you earn in the game\. No real money: coins cannot be bought or cashed out\. Bets from (\d+) to ([\d,]+) coins, unlocked after 30 rolls\.$/, m => `Joue avec les pièces gagnées dans le jeu. Pas d'argent réel : les pièces ne s'achètent pas et ne se retirent pas. Mises de ${m[1]} à ${nb(m[2])} pièces, débloqué après 30 tirages.`],
    [/^Gamble unlocks after 30 rolls \(you have (\d+)\)$/, m => `Le casino se débloque après 30 tirages (tu en as ${m[1]})`],
    [/^Spin · ([\d,]+)$/, m => `Lancer · ${nb(m[1])}`], [/^Deal · ([\d,]+)$/, m => `Distribuer · ${nb(m[1])}`], [/^Dealer · (\d+)$/, m => `Croupier · ${m[1]}`], [/^You · (\d+)$/, m => `Toi · ${m[1]}`],
    [/^Bet: ([\d,]+) coins$/, m => `Mise : ${nb(m[1])} pièces`], [/^you get ([\d,]+) coins$/, m => `tu reçois ${nb(m[1])} pièces`], [/^you get ([\d,]+) coins \(([+−])([\d,]+)\)$/, m => `tu reçois ${nb(m[1])} pièces (${m[2]}${nb(m[3])})`], [/^no win this time \(−([\d,]+)\)$/, m => `perdu cette fois (−${nb(m[1])})`],
    [/^Bet between (\d+) and (\d+) coins$/, m => `Mise entre ${m[1]} et ${m[2]} pièces`], [/^Maximum (\d+) coins per spin$/, m => `${m[1]} pièces au plus par tour`],
    [/^🔒 Unlocks at ([\d,]+) rolls \(you have ([\d,]+)\)$/, m => `🔒 Débloqué à ${nb(m[1])} tirages (tu en as ${nb(m[2])})`],
    [/^Start · ([\d,]+)$/, m => `Démarrer · ${nb(m[1])}`], [/^Cash out · ([\d,]+)$/, m => `Encaisser · ${nb(m[1])}`], [/^Boom · −([\d,]+)$/, m => `Boum · −${nb(m[1])}`], [/^Crashed at ([\d.]+)×$/, m => `Explosé à ${m[1]}×`],
    [/^Cashed out at ([\d.]+)×$/, m => `Encaissé à ${m[1]}×`], [/^you get ([\d,]+) coins \(it crashed at ([\d.]+)×\)$/, m => `tu reçois ${nb(m[1])} pièces (explosion à ${m[2]}×)`],
    [/^You have 🪙 ([\d,]+)$/, m => `Tu as 🪙 ${nb(m[1])}`],
    [/^(\d+) players? hidden$/, m => `${m[1]} joueur${m[1] === '1' ? '' : 's'} masqué${m[1] === '1' ? '' : 's'}`],
    [/^([\d,]+) more coins needed for the (.+) emote$/, m => `Il manque ${nb(m[1])} pièces pour l'émote ${m[2]}`],
    [/^(.+) emote unlocked: use it in your next duel$/, m => `Émote ${m[1]} débloquée : utilise-la dans ton prochain duel`],
    [/^([\d,]+) more coins needed for the (.+) button$/, m => `Il manque ${nb(m[1])} pièces pour le bouton ${m[2]}`],
    [/^([\d,]+) more coins needed for (?:the )?(.+)$/, m => `Il manque ${nb(m[1])} pièces pour ${one(m[2])}`],
    [/^Not enough coins: ([\d,]+) more needed$/, m => `Pas assez de pièces : il en manque ${nb(m[1])}`],
    [/^Not enough coins for this stake \(([\d,]+)\)$/, m => `Pas assez de pièces pour cette mise (${nb(m[1])})`],
    [/^(.+) button unlocked and equipped$/, m => `Bouton ${m[1]} débloqué et équipé`], [/^(.+) button equipped$/, m => `Bouton ${m[1]} équipé`],
    [/^(.+) unlocked and equipped$/, m => `${m[1]} débloqué et équipé`], [/^(.+) equipped$/, m => `${m[1]} équipé`],
    [/^Round (\d+)…$/, m => `Manche ${m[1]}…`], [/^round (\d+)$/, m => `manche ${m[1]}`], [/^Roll round (\d+)$/, m => `Tirer la manche ${m[1]}`],
    [/^([\d,]+) \/ ([\d,]+) players$/, m => `${m[1]} / ${m[2]} joueurs`], [/^(\d+)\/(\d+) players$/, m => `${m[1]}/${m[2]} joueurs`],
    [/^(\d+) \/ (\d+) ready$/, m => `${m[1]} / ${m[2]} prêts`],
    [/^starts by itself in (\d+) s$/, m => `démarre tout seul dans ${m[1]} s`],
    [/^Waiting for (.+)…$/, m => `En attente de ${m[1]}…`], [/^Waiting for (.+) to start \(or for the game to fill up\)…$/, m => `En attente que ${m[1]} lance la partie (ou qu'elle soit pleine)…`],
    [/^You win with (.+)$/, m => `Tu gagnes avec ${one(m[1])}`], [/^(.+) wins with (.+)$/, m => `${m[1]} gagne avec ${one(m[2])}`],
    [/^([\d,]+) pot$/, m => `pot de ${nb(m[1])}`], [/^stake ([\d,]+) each, pot ([\d,]+)$/, m => `mise de ${nb(m[1])} chacun, pot de ${nb(m[2])}`],
    [/^([\d,]+) each$/, m => `${nb(m[1])} chacun`],
    [/^(.+)'s game$/, m => `Partie de ${m[1]}`], [/^(.+) wants a rematch: play$/, m => `${m[1]} veut une revanche : jouer`],
    [/^Start vs ([\d,]+) bots?$/, m => `Lancer contre ${m[1]} bot${s(m[1])}`], [/^Play vs ([\d,]+) bots?$/, m => `Jouer contre ${m[1]} bot${s(m[1])}`],
    [/^Each player pays 🪙 ([\d,]+) when joining\. The winner takes the pot of 🪙 ([\d,]+)\. Refunded on a draw or if everyone leaves\. Needs 30 rolls on your account\.$/, m => `Chaque joueur paie 🪙 ${nb(m[1])} en entrant. Le gagnant prend le pot de 🪙 ${nb(m[2])}. Remboursé en cas d'égalité ou si tout le monde part. Il faut 30 tirages sur ton compte.`],
    [/^No coins or achievements for this win: (.+)\. It still counts in your head-to-head\.$/, m => `Pas de pièces ni de succès pour cette victoire : ${one(m[1])}. Elle compte quand même dans ton face-à-face.`],
    [/^Stakes unlock after (\d+) rolls \(you have ([\d,]+)\)$/, m => `Les mises se débloquent après ${m[1]} tirages (tu en as ${nb(m[2])})`],
    [/^you already own it: 🪙 ([\d,]+) refunded$/, m => `tu l'as déjà : 🪙 ${nb(m[1])} remboursées`],
    [/^Open another$/, () => 'En ouvrir une autre'],
    [/^([\d,.]+) XP per roll$/, m => `${nb(m[1])} XP par tirage`], [/^(\d+)% of the collection$/, m => `${m[1]} % de la collection`],
    [/^Top (\S+)%$/, m => `Top ${m[1].replace('.', ',')} %`], [/^Bottom (\S+)%$/, m => `${m[1].replace('.', ',')} % les plus bas`],
    [/^Your best roll today: #(\d+) on$/, m => `Ton meilleur tirage du jour : n° ${m[1]} sur`], [/^today's leaderboard$/, () => 'le classement du jour'],
    [/^Achievement unlocked: (.+)\. Equip its title from your profile$/, m => `Succès débloqué : ${m[1]}. Équipe son titre depuis ton profil`],
    [/^(\d+) achievements unlocked: (.+)$/, m => `${m[1]} succès débloqués : ${m[2]}`],
    [/^All the coins that went through the casino, all players together: bets taken and winnings paid · ([\d,]+) rounds played$/, m => `Toutes les pièces passées par le casino, tous joueurs confondus : mises prises et gains versés · ${nb(m[1])} manches jouées`],
    [/^🔒 (\d+) more buttons come with skins you do not own yet: every skin brings its own button\.$/, m => `🔒 ${m[1]} autres boutons viennent avec des skins que tu n'as pas encore : chaque skin apporte son bouton.`],
    [/^Level (\d) \/ (\d)$/, m => `Niveau ${m[1]} / ${m[2]}`], [/^Upgrade · 🪙 ([\d,]+)$/, m => `Améliorer · 🪙 ${nb(m[1])}`],
    [/^reveal (\d+)% faster · ([\d.]+) s between rolls$/, m => `révélation ${m[1]} % plus rapide · ${m[2].replace('.', ',')} s entre deux tirages`],
    [/^Next level: reveal (\d+)% faster, ([\d.]+) s between rolls\. Solo rolls only: duels keep their shared pace\.$/, m => `Niveau suivant : révélation ${m[1]} % plus rapide, ${m[2].replace('.', ',')} s entre deux tirages. Tirages en solo seulement : les duels gardent leur rythme commun.`],
    [/^Roll speed level (\d): your reveals are now (\d+)% faster$/, m => `Vitesse de tirage niveau ${m[1]} : tes révélations sont ${m[2]} % plus rapides`],
    [/^([\d,]+) more coins needed for the next speed level$/, m => `Il manque ${nb(m[1])} pièces pour le niveau de vitesse suivant`],
    [/^Quest complete: (\S+) (.+) · \+(\d+) 🪙 to claim on the home page$/, m => `Quête terminée : ${m[1]} ${one(m[2])} · +${m[3]} 🪙 à récupérer sur l'accueil`],
    [/^(\d+) quests complete · \+(\d+) 🪙 to claim on the home page$/, m => `${m[1]} quêtes terminées · +${m[2]} 🪙 à récupérer sur l'accueil`],
    [/^No rolls (today|this week|yet), be the first!$/, m => `Aucun tirage ${m[1] === 'today' ? 'aujourd\'hui' : m[1] === 'this week' ? 'cette semaine' : 'pour l\'instant'}, sois le premier !`],
    [/^Remove (.+) from your friends\?$/, m => `Retirer ${m[1]} de tes amis ?`],
    [/^"(.+)" is already taken by another player\. Pick a new name\.$/, m => `« ${m[1]} » est déjà pris par un autre joueur. Choisis un autre pseudo.`],
    [/^(.+) odds$/, m => `Chances — ${one(m[1])}`],
    [/^(\d+) badges? earned$/, m => `${m[1]} badge${s(m[1])} obtenu${s(m[1])}`],
    [/^([\d,]+) rolls? today$/, m => `${nb(m[1])} tirage${s(m[1])} aujourd'hui`], [/^([\d,]+) today$/, m => `${nb(m[1])} aujourd'hui`],
    [/^See (.+)'s profile$/, m => `Voir le profil de ${m[1]}`],
    [/^Rolls by this player (today|this week|in total)$/, m => `Tirages de ce joueur ${m[1] === 'today' ? 'aujourd\'hui' : m[1] === 'this week' ? 'cette semaine' : 'au total'}`],
    [/^(\d+) \/ (\d+) found$/, m => `${m[1]} / ${m[2]} trouvés`], [/^([\d.]+)% complete$/, m => `${m[1]} % complété`],
    [/^typical: (.+) XP$/, m => `typique : ${nb(m[1])} XP`], [/^expected (\S+)$/, m => `attendu ${m[1]}`], [/^last ([\d,]+) rolls?$/, m => `${nb(m[1])} dernier${s(m[1])} tirage${s(m[1])}`],
    [/^([\d,]+) of ([\d,]+) rolls?$/, m => `${nb(m[1])} sur ${nb(m[2])} tirage${s(m[2])}`],
    [/^Change how your number looks, on your rolls and on your cards in duels\. Earn coins by rolling \((.+)\) and by winning duels \(\+(\d+)\)\.$/, m => `Change l'apparence de ton nombre, sur tes tirages et sur tes cartes en duel. Gagne des pièces en tirant (${m[1]}) et en gagnant des duels (+${m[2]}).`],
    [/^A random number game with no daily limit\. Each roll draws a number from 0 to 1,000,000\. The number is checked against (\d+) patterns — palindromes, primes, repeated digits, meme numbers, sequences and more — and every badge it earns is worth XP \(experience points\)\.$/, m => `Un jeu de nombres aléatoires sans limite quotidienne. Chaque tirage sort un nombre de 0 à 1 000 000. Le nombre est comparé à ${m[1]} motifs — palindromes, nombres premiers, chiffres répétés, nombres mèmes, suites et bien d'autres — et chaque badge qu'il obtient vaut de l'XP (points d'expérience).`],
    [/^— fill the (\d+)-badge collection\.$/, m => `— complète la collection de ${m[1]} badges.`],
    [/^bottom (\S+)%$/, m => `les ${m[1]} % les plus bas`], [/^top (\S+)%$/, m => `top ${m[1]} %`], [/^([\d.–]+)% of rolls$/, m => `${m[1].replace(/\./g, ',')} % des tirages`],
    [/^(Laugh|Cry|Angry|Cool|Shocked|King) \(press (\d)\)$/, m => `${{ Laugh: 'Rire', Cry: 'Pleurer', Angry: 'Colère', Cool: 'Cool', Shocked: 'Choqué', King: 'Roi' }[m[1]]} (touche ${m[2]})`],
    [/^Delete all ([\d,]+) rolls from this device\? Export first if you want to keep them\.$/, m => `Supprimer les ${nb(m[1])} tirages de cet appareil ? Exporte-les d'abord si tu veux les garder.`],
    [/^You can send (\d+) suggestions a day: come back tomorrow$/, m => `Tu peux envoyer ${m[1]} suggestions par jour : reviens demain`],
    [/^Hit Generate to roll a number from 0 to 1,000,000\. Each pattern in it is a badge worth XP: the rarer the badge, the more XP\. There are (\d+) badges to collect\.$/, m => `Appuie sur Générer pour tirer un nombre de 0 à 1 000 000. Chaque motif qu'il contient est un badge qui rapporte de l'XP : plus le badge est rare, plus il en donne. Il y a ${m[1]} badges à collectionner.`],
    [/^([\d,]+) received$/, m => `${nb(m[1])} reçue${s(m[1])}`], [/^([\d,]+) devices$/, m => `${nb(m[1])} appareils`], [/^([\d,]+) new$/, m => `${nb(m[1])} nouveaux`],
    [/^([\d,]+) new devices$/, m => `${nb(m[1])} nouveaux appareils`], [/^([\d,]+) on the leaderboard$/, m => `${nb(m[1])} au classement`],
    [/^Friends list full \((\d+)\)$/, m => `Liste d'amis pleine (${m[1]})`],
  ];

  // ---------------------------------------------------------------- traduction d'un texte
  // Un segment : tel quel, puis sans ses symboles/ponctuation de bord (emojis, « : », « … »), puis par motif.
  function one(seg) {
    if (FR[seg] !== undefined) return FR[seg];
    for (const [re, fn] of P) { const hit = re.exec(seg); if (hit) return fn(hit); } // phrase entière (avec sa ponctuation)
    const m = /^([^\p{L}\p{N}"(]*)([\s\S]*?)([\s:…!.?]*)$/u.exec(seg);
    const core = m ? m[2] : seg;
    if (m && core !== seg && FR[core] !== undefined) return m[1] + FR[core] + m[3];
    for (const [re, fn] of P) {
      const hit = re.exec(core);
      if (hit) return (m ? m[1] : '') + fn(hit) + (m ? m[3] : '');
    }
    return seg;
  }
  // Un texte complet : on garde les espaces de bord, on essaie d'abord en entier, puis morceau par morceau (« a · b »).
  function translate(text) {
    const lead = /^\s*/.exec(text)[0], trail = /\s*$/.exec(text)[0];
    const body = text.slice(lead.length, text.length - trail.length);
    if (!body || !/[A-Za-z]{2}/.test(body)) return text;
    const whole = one(body);
    if (whole !== body) return lead + whole + trail;
    if (!body.includes(' · ')) return text;
    return lead + body.split(' · ').map(one).join(' · ') + trail;
  }

  // ---------------------------------------------------------------- application à la page
  const SKIP = '.player-link, .lb-name, .room-name, #player-name, .num-card, .room-code, .board-row > a, .live-players, .bot-name, .friend-info > a, [data-no-i18n], script, style, input, textarea';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];
  const originals = new WeakMap(); // nœud texte → texte anglais
  const attrOriginals = new WeakMap(); // élément → { attribut: valeur anglaise }
  const STORE_KEY = 'rng-lang';
  let lang = 'en';
  try { lang = localStorage.getItem(STORE_KEY) || ((navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'); } catch (e) { /* stockage bloqué : anglais */ }
  let applying = false;

  function textNode(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP)) return;
    // Texte changé par le jeu depuis notre dernière traduction : c'est un nouvel original.
    const known = originals.get(node);
    if (known === undefined || (node.nodeValue !== known.en && node.nodeValue !== known.fr)) {
      originals.set(node, { en: node.nodeValue, fr: translate(node.nodeValue) });
    }
    const o = originals.get(node), want = lang === 'fr' ? o.fr : o.en;
    if (node.nodeValue !== want) node.nodeValue = want;
  }
  function element(el) {
    if (el.matches && el.matches('script, style')) return;
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      let map = attrOriginals.get(el);
      if (!map) attrOriginals.set(el, (map = {}));
      const value = el.getAttribute(a);
      if (!map[a] || (value !== map[a].en && value !== map[a].fr)) {
        // Une infobulle (data-tip) est du HTML : on traduit ses morceaux de texte, pas ses balises.
        map[a] = { en: value, fr: a === 'data-tip' ? value.replace(/(^|>)([^<]+)(?=<|$)/g, (x, open, t) => open + translate(t)) : translate(value) };
      }
      const want = lang === 'fr' ? map[a].fr : map[a].en;
      if (value !== want) el.setAttribute(a, want);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType !== 1) return;
    element(root);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) (n.nodeType === 3 ? textNode : element)(n);
  }
  function apply(root) {
    applying = true;
    try { walk(root || document.body); } finally { applying = false; }
  }

  function setLang(next) {
    lang = next === 'fr' ? 'fr' : 'en';
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* tant pis : la langue ne sera pas retenue */ }
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    apply();
  }

  function start() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-lang]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
      b.addEventListener('click', () => setLang(b.dataset.lang));
    });
    apply();
    // Tout ce que le jeu ajoute ou change ensuite est traduit à son arrivée. En anglais : rien à faire tant qu'on n'a
    // jamais traduit (les originaux sont le texte du jeu).
    new MutationObserver(list => {
      if (applying || lang === 'en') return;
      applying = true;
      try {
        for (const m of list) {
          if (m.type === 'characterData') textNode(m.target);
          else if (m.type === 'attributes') element(m.target);
          else m.addedNodes.forEach(walk);
        }
      } finally { applying = false; }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // Pour les rares textes hors de la page (fenêtres confirm() du navigateur).
  window.RNGI18n = { t: text => (lang === 'fr' ? translate(String(text)) : text), tr: translate, skip: SKIP, get lang() { return lang; }, setLang };
})();
