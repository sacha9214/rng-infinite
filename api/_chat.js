// Chat des duels : nettoyage d'un message avant de le garder. Ce n'est pas une fonction Vercel (nom en « _ »).
// Un filtre se contourne toujours : il retire le plus courant, le reste est l'affaire du bouton « masquer ce joueur »
// côté site. Tout ce qui est remplacé l'est par des astérisques ou un mot entre crochets, jamais supprimé en silence.
const MAX_CHARS = 140;

// Mots masqués (français et anglais), écrits sans accents ni majuscules : insultes, injures racistes, homophobes ou
// sexistes, vocabulaire sexuel cru. Comparés mot par mot (pas en sous-chaîne, pour ne pas masquer « passage » ou
// « Scunthorpe »), après avoir ramené les variantes à la même forme : « f.u.c.k », « fuuuck », « fvck », « sh1t ».
const BLOCKED = new Set(`
fuck fucker fucking fuckin fucked fck fuk fuq motherfucker mofo shit shitty bullshit bitch bitches bastard asshole
dick dickhead cock cocksucker pussy cunt twat wanker whore slut hoe cum jizz porn porno nude nudes boobs tits
nigger nigga negro faggot fag fags dyke tranny retard retarded spic chink kike paki coon kys rape rapist
nazi hitler
merde merdeux putain pute putes salope salopes salaud salop connard connards connasse enculer encule
encules enculee nique niquer niquez ntm fdp tg ftg batard batarde batards couille couilles
branleur branleuse branler pd pede pedes pedale tapette tarlouze gouine negre negres negresse bougnoule bicot
youpin youtre chinetoque pouffiasse petasse trouduc bouffon bouffonne abruti abrutie debile debiles
mongolien attarde sucer suceuse viol violer violeur
`.split(/\s+/).filter(Boolean));
// Ceux-là sont masqués même collés à autre chose (ils ne se cachent dans aucun mot courant).
const ANYWHERE = ['nigger', 'nigga', 'faggot', 'motherfuck', 'enculé', 'encule', 'salope', 'connard', 'fils de pute', 'filsdepute', 'nique ta', 'niquetamere', 'ta gueule'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '€': 'e' };
const plain = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Forme de comparaison d'un mot : sans accents, chiffres et symboles ramenés aux lettres qu'ils imitent, lettres
// répétées réduites à une seule (« fuuuck » → « fuck », mais aussi « putain » inchangé).
const shape = word => plain(word).replace(/[0134578@$!€]/g, c => LEET[c] || c).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
const BLOCKED_SHAPES = new Set([...BLOCKED].map(shape));
const stars = n => '*'.repeat(Math.max(3, Math.min(8, n)));

function cleanChat(raw) {
  // Une seule ligne, sans caractères de contrôle ni caractères invisibles (largeur nulle, sens d'écriture forcé).
  let text = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) return '';
  // Pas de lien (hameçonnage, pub) ni de longue suite de chiffres (numéro de téléphone) : les nombres du jeu ont 7 chiffres au plus.
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link]').replace(/\b[a-z0-9-]{2,}\.(?:com|net|org|gg|io|fr|xyz|ru|tv|me|co|app|link|ly)\b\S*/gi, '[link]');
  text = text.replace(/(?:\d[\s.\-]?){9,}/g, '[number] ');
  // Expressions masquées où qu'elles soient, puis mot par mot (lettres séparées par des points ou des tirets comprises).
  for (const bad of ANYWHERE) {
    const re = new RegExp(plain(bad).split('').map(c => (c === ' ' ? '[\\s._-]*' : `${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}+[\\s._-]*`)).join(''), 'gi');
    const flat = plain(text);
    if (flat.length === text.length) { let m; const cuts = []; while ((m = re.exec(flat))) { cuts.push([m.index, m[0].trimEnd().length]); if (!m[0].length) re.lastIndex++; } for (const [i, n] of cuts.reverse()) text = text.slice(0, i) + stars(n) + text.slice(i + n); }
  }
  // Un nombre seul n'est jamais masqué (on parle de nombres toute la journée ici), et la ponctuation finale est gardée.
  text = text.replace(/[\p{L}\p{N}@$!€]+(?:[._-][\p{L}\p{N}@$!€])*[\p{L}\p{N}@$!€]*/gu, word => {
    const [, core, tail] = /^(.*?)([!$€]*)$/u.exec(word);
    return /\p{L}/u.test(core) && BLOCKED_SHAPES.has(shape(core)) ? stars(core.length) + tail : word;
  });
  return text.replace(/\s+/g, ' ').trim();
}

module.exports = { cleanChat, MAX_CHARS };
