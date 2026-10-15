# Kit de la collab RNG∞ × Canne & Dauphins

Salut Firetail ! Voici de quoi ajouter RNG∞ dans ton jeu, de la part de Sacha (https://rng-infinite.com).

## Ce qu'il y a dans le dossier

| Fichier | C'est quoi |
|---|---|
| `rng-collab-kit.js` | Le code à coller dans ton `index.html` (4 parties, détaillées ci-dessous) |
| `apercu-skin-rng.gif` | Ce que ça donne : ton pêcheur avec le skin RNG∞ et un tirage au-dessus de sa tête |
| `apercu-skin-rng.png`, `apercu-defilement.png` | Deux images fixes de l'aperçu |
| `chiffres.png` | Les 10 chiffres de RNG∞ en pixel art |

Les aperçus ont été faits avec **ton propre code** de sprites (`spr`, `tint`, `PAL_P`, `LEGS`, `PLANK`, copiés tels quels de ton jeu), donc ça s'affichera pareil chez toi.

## Où coller le code

Colle tout `rng-collab-kit.js` **juste après le tableau `SKINS`** (avant la ligne `SKINS.sort(...)`), puis ajoute cette ligne juste après :

```js
SKINS.push(RNG_SKIN);
```

C'est important qu'il soit avant `SKINS.sort` : ta boucle qui fabrique les sprites des skins et `loadShop()` passent juste après.

## 1. Les chiffres

`RNG_DIGITS['0']` … `RNG_DIGITS['9']` : les chiffres blancs avec contour sombre (police Press Start 2P, 7×7 pixels).
`RNG_DIGITS_WET[...]` : les mêmes en bleu, pour l'effet « sous l'eau » pendant le tirage.

## 2. L'animation de tirage au-dessus du perso

- `rngRoll(n)` lance un tirage qui finit sur `n` (ou au hasard avec `rngRoll()`).
- `drawRngRoll(cx, top)` dessine le tirage : à appeler à chaque image après `drawPlayer()`, avec `cx` = le milieu du perso et `top` = le haut du perso (dans les mêmes coordonnées que ton `drawPlayer`).

Même rythme que sur RNG∞ : les 6 chiffres défilent en bleu, puis se posent un par un avec un petit coup de « ferrage » (le chiffre plonge, il est arraché vers le haut, il retombe). Le nombre reste 3 secondes puis s'efface.

Idées pour le déclencher quand le skin RNG∞ est équipé : à chaque dauphin attrapé, ou toutes les 8 secondes quand le perso ne bouge pas.

## 3. Le skin RNG∞

`RNG_SKIN` est au format de ton tableau `SKINS` : bonnet violet à points de dé, sweat violet aux reflets dorés, canne dorée qui brille. Change les couleurs ou les grilles comme tu veux, c'est ton style.

Il a `price: 0` et `collab: true`. Comme ta boutique affiche tous les skins, il faut le **cacher tant qu'il n'est pas débloqué**, sinon il apparaîtrait « OFFERT » pour tout le monde. Dans la boucle qui affiche les skins de ta boutique (vers la ligne `const owned=shop.owned.includes(sk.id)`), ajoute au début :

```js
if (sk.collab && !shop.owned.includes(sk.id)) continue;
```

(ou affiche-le verrouillé avec le texte « Joue à RNG∞ avec le même compte Google », comme tu préfères.)

## 4. La récompense par compte Google

Dans ta fonction `gOnCredential(resp)`, ajoute à la fin :

```js
rngCollab(resp.credential);
```

Quand un joueur se connecte avec Google dans ton jeu :
- **s'il a aussi un compte RNG∞** (connecté avec le même compte Google), il reçoit tout de suite le skin RNG∞ chez toi, et le skin **Fisherman** (ton pêcheur qui pêche les chiffres) chez nous ;
- **sinon**, le serveur de RNG∞ s'en souvient : le jour où il crée son compte RNG∞ avec ce compte Google, il reçoit le skin Fisherman chez nous. Pour avoir le skin RNG∞ chez toi, il devra juste se reconnecter une fois sur ton jeu.

Côté sécurité et vie privée : le serveur vérifie la signature de Google et que le jeton a bien été émis pour ton jeu (ton identifiant client Google). Aucun e-mail n'est envoyé ni stocké, seulement l'identifiant Google (`sub`).

## Lien vers RNG∞

Pour que Sacha voie combien de joueurs viennent de ton jeu, utilise ce lien :

**https://rng-infinite.com/?ref=pechadophin**

Si tu as une question, demande à Sacha !
