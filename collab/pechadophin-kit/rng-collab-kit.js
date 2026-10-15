/* =====================================================================================================
   KIT DE LA COLLAB  RNG∞ × Canne & Dauphins  (pour Firetail, de la part de Sacha, rng-infinite.com)
   À coller dans index.html, n'importe où APRÈS la définition de spr(), tint(), SKINS et AVANT la boucle de jeu.
   Rien ici ne modifie ton jeu tant que tu n'appelles pas les fonctions (voir LISEZMOI.md).
   ===================================================================================================== */

/* ---- 1. Les chiffres de RNG∞ : police Press Start 2P (la même que ton jeu), 7×7 pixels, au format de spr() ---- */
const RNG_DIGIT_ROWS = {
 '0':["..www..", ".w..ww.", "ww...ww", "ww...ww", "ww...ww", ".ww..w.", "..www.."],
 '1':["...ww..", "..www..", "...ww..", "...ww..", "...ww..", "...ww..", ".wwwwww"],
 '2':[".wwwww.", "ww...ww", "....www", "..wwww.", ".wwww..", "www....", "wwwwwww"],
 '3':[".wwwwww", "....ww.", "...ww..", "..wwww.", ".....ww", "ww...ww", ".wwwww."],
 '4':["...www.", "..wwww.", ".ww.ww.", "ww..ww.", "wwwwwww", "....ww.", "....ww."],
 '5':["wwwwww.", "ww.....", "wwwwww.", ".....ww", ".....ww", "ww...ww", ".wwwww."],
 '6':["..wwww.", ".ww....", "ww.....", "wwwwww.", "ww...ww", "ww...ww", ".wwwww."],
 '7':["wwwwwww", "ww...ww", "....ww.", "...ww..", "..ww...", "..ww...", "..ww..."],
 '8':[".wwww..", "ww...w.", "www..w.", ".wwww..", "w..wwww", "w....ww", ".wwwww."],
 '9':[".wwwww.", "ww...ww", "ww...ww", ".wwwwww", ".....ww", "....ww.", ".wwww.."]
};
const RNG_DIGITS = {}, RNG_DIGITS_WET = {};
for (const k in RNG_DIGIT_ROWS) {
  RNG_DIGITS[k] = spr(RNG_DIGIT_ROWS[k], { w: '#ffffff', k: '#14182c' }, true);     // chiffre posé : blanc, contour sombre
  RNG_DIGITS_WET[k] = spr(RNG_DIGIT_ROWS[k], { w: '#a8dcff', k: '#27479a' }, true); // pendant le tirage : « sous l'eau »
}

/* ---- 2. L'animation de tirage de RNG∞, à afficher au-dessus de ton perso ----
   rngRoll(n)              lance un tirage qui finit sur le nombre n (0 à 999999) ; rngRoll() = au hasard
   drawRngRoll(cx, top)    à appeler à chaque image, après drawPlayer() : cx = milieu du perso, top = haut du perso
   Même rythme que sur rng-infinite.com : les 6 chiffres défilent en bleu, puis se posent un par un de gauche à droite,
   chacun avec le petit « coup de ferrage » (il plonge, il est arraché vers le haut, il retombe). Les zéros de tête
   restent pâles. Le nombre reste affiché 3 s puis s'efface. Utilise ta variable globale time (en secondes). */
let rngR = null;
function rngRoll(n) {
  if (n === undefined) n = Math.floor(Math.random() * 1000000);
  rngR = { s: String(Math.max(0, Math.min(999999, n | 0))).padStart(6, '0'), t0: time };
}
function drawRngRoll(cx, top) {
  if (!rngR) return;
  const el = time - rngR.t0, W = 9, x0 = Math.round(cx - (W * 6) / 2), y0 = Math.round(top - 14);
  const lockAt = i => 0.7 + i * 0.28, end = lockAt(5) + 3;
  if (el > end + 0.5) { rngR = null; return; }
  const lead = rngR.s.search(/[1-9]/), alpha = el > end ? 1 - (el - end) / 0.5 : 1;
  ctx.save(); ctx.globalAlpha = Math.max(0, alpha);
  for (let i = 0; i < 6; i++) {
    const x = x0 + i * W, since = el - lockAt(i);
    if (since < 0) {   // défile : un chiffre au hasard toutes les 60 ms, qui ondule d'un pixel
      const d = String(Math.floor(Math.random() * 10)), wob = Math.floor(time * 12 + i) % 2;
      ctx.drawImage(RNG_DIGITS_WET[d], x, y0 + wob);
    } else {          // posé : coup de ferrage sur 0,3 s (plonge +2, arraché -4, retombe)
      const u = Math.min(1, since / 0.3), dy = u < 0.25 ? 2 : u < 0.55 ? -4 : u < 0.8 ? 1 : 0;
      const ghost = lead === -1 ? i < 5 : i < lead;
      ctx.globalAlpha = Math.max(0, alpha) * (ghost ? 0.3 : 1);
      ctx.drawImage(RNG_DIGITS[rngR.s[i]], x, y0 + dy);
      ctx.globalAlpha = Math.max(0, alpha);
    }
  }
  ctx.restore();
}

/* ---- 3. Idée de skin « RNG∞ » (récompense de la collab) au format de ton tableau SKINS ----
   Bonnet violet avec des points de dé, sweat violet aux reflets dorés, canne dorée qui brille.
   collab: true sert à le garder hors de ta boutique : il se débloque avec la récompense (voir LISEZMOI.md). */
const RNG_SKIN = {
  id: 'rnginf', name: 'RNG∞', price: 0, collab: true, rod: '#fde047', glow: '#c4b5fd',
  pal: { h: '#7c3aed', H: '#4c1d95', w: '#ffffff', b: '#6d28d9', B: '#4c1d95', g: '#fde047', p: '#312e81', n: '#1e1b4b' },
  hat: ["................", "....kkkkkkkk....", "...khhwhhwhhk...", "..khhhhhhhhhhk..", "..kHHHHHHHHHHk.."],
  face: ["...kssssssssk...", "...kssssskssk...", "...ksssssssSk...", "....kkssssskk..."],
  torso: ["...kbbbbbbbbk...", "...kbgbgbbbbssk.", "...kBBgBBBBBk..."],
};

/* ---- 4. Récompense croisée par compte Google ----
   À appeler dans gOnCredential(resp), juste après gCheckDev() :   rngCollab(resp.credential);
   Ton jeu envoie le jeton de connexion Google (signé par Google) au serveur de RNG∞. Le serveur vérifie la signature et
   que le jeton a bien été émis pour TON jeu (ton identifiant client Google), puis :
     - il retient que ce compte Google joue à Canne & Dauphins → le joueur reçoit le skin Fisherman sur RNG∞ ;
     - si ce compte Google a déjà un compte RNG∞, il répond { rng: true } → ici, on débloque le skin RNG∞.
   Aucun e-mail n'est envoyé ni stocké : seul l'identifiant Google (sub) est gardé. */
const RNG_COLLAB_API = 'https://db.rng-infinite.com/api/site';
function rngCollab(credential) {
  if (!credential) return;
  fetch(RNG_COLLAB_API, { method: 'POST', body: JSON.stringify({ action: 'collab', game: 'pechadophin', credential }) })
    .then(r => r.json())
    .then(d => {
      if (!d || !d.rng || shop.owned.includes(RNG_SKIN.id)) return;
      shop.owned.push(RNG_SKIN.id); saveShop();
      try { if (typeof renderSkins === 'function') renderSkins(); } catch (e) { /* boutique pas ouverte */ }
    })
    .catch(() => { /* hors ligne : on réessaiera à la prochaine connexion */ });
}
