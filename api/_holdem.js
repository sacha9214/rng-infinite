// Poker du casino : Texas Hold'em à deux (heads-up), sans limite. Demandé par Sacha (2026-11-03) : « in casino, add a
// poker table so you can play against bot or against your friend to bet your money » (pièces du jeu seulement).
// Ce fichier est le cœur du jeu, sans base de données ni réseau : les cartes, l'évaluateur de mains à 7 cartes, le
// déroulé d'une main (blinds, enchères, tapis, abattage, commission) et le bot. api/_poker.js garde les tables dans
// Redis et bouge les pièces ; tools/poker-sim.mjs fait jouer le bot contre des stratégies écrites à l'avance pour
// vérifier que la maison garde l'avantage (règle du casino : il doit toujours gagner en moyenne).
'use strict';

// Commission de la maison (« rake ») : 5 % de chaque pot gagné, contre le bot comme entre amis. Ces pièces disparaissent.
const RAKE = 0.05;
const rakeOf = pot => Math.round(pot * RAKE);

// ---------------------------------------------------------------- cartes
// Une carte = un entier de 0 à 51 : valeur (c >> 2) + 2 (2 … 14 = as), couleur c & 3 (♠ ♥ ♦ ♣, l'ordre du site).
const rankOf = c => (c >> 2) + 2, suitOf = c => c & 3;
// Pour le site : { r, s } avec r = 1 pour l'as … 13 pour le roi, comme les cartes du blackjack (cardHTML dans app.js).
const toClient = c => ({ r: rankOf(c) === 14 ? 1 : rankOf(c), s: suitOf(c) });

// ---------------------------------------------------------------- évaluateur
// score(cartes) : un entier, plus grand = meilleure main, égal = égalité exacte. Catégorie << 20, puis jusqu'à cinq
// valeurs de 4 bits (ce qui départage : la paire, puis les cartes d'accompagnement). Marche avec 5, 6 ou 7 cartes.
// Tableaux réutilisés : le bot appelle cette fonction des centaines de fois par décision.
const RC = new Int8Array(15), SM = new Int32Array(4), SC = new Int8Array(4);
const HIGH = 0, PAIR = 1, TWO_PAIR = 2, TRIPS = 3, STRAIGHT = 4, FLUSH = 5, FULL = 6, QUADS = 7, STRAIGHT_FLUSH = 8;
// Plus haute quinte contenue dans un masque de valeurs (bit r = valeur r présente) ; l'as compte aussi pour 1 (A-2-3-4-5).
function straightHigh(mask) {
  if (mask & (1 << 14)) mask |= 2;
  for (let h = 14; h >= 5; h--) if (((mask >> (h - 4)) & 31) === 31) return h;
  return 0;
}
// Les n plus hautes valeurs du masque, rangées à partir du décalage `shift` (16 = première place).
function kick(mask, n, shift) {
  let out = 0;
  for (let r = 14; r >= 2 && n > 0; r--) if (mask & (1 << r)) { out |= r << shift; shift -= 4; n--; }
  return out;
}
function score(cards, n = cards.length) {
  RC.fill(0); SM[0] = SM[1] = SM[2] = SM[3] = 0; SC[0] = SC[1] = SC[2] = SC[3] = 0;
  let mask = 0;
  for (let i = 0; i < n; i++) { const c = cards[i], r = (c >> 2) + 2, s = c & 3; RC[r]++; SM[s] |= 1 << r; SC[s]++; mask |= 1 << r; }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (SC[s] >= 5) fs = s;
  if (fs >= 0) { const h = straightHigh(SM[fs]); if (h) return (STRAIGHT_FLUSH << 20) | (h << 16); }
  let q = 0, t1 = 0, t2 = 0, p1 = 0, p2 = 0;
  for (let r = 14; r >= 2; r--) {
    const k = RC[r];
    if (k === 4) q = r;
    else if (k === 3) { if (!t1) t1 = r; else if (!t2) t2 = r; }
    else if (k === 2) { if (!p1) p1 = r; else if (!p2) p2 = r; }
  }
  if (q) return (QUADS << 20) | (q << 16) | kick(mask & ~(1 << q), 1, 12);
  // Deux brelans : le second fait la paire du full. Brelan + deux paires : la plus haute paire.
  if (t1 && (t2 || p1)) return (FULL << 20) | (t1 << 16) | (Math.max(t2, p1) << 12);
  if (fs >= 0) return (FLUSH << 20) | kick(SM[fs], 5, 16);
  const st = straightHigh(mask);
  if (st) return (STRAIGHT << 20) | (st << 16);
  if (t1) return (TRIPS << 20) | (t1 << 16) | kick(mask & ~(1 << t1), 2, 12);
  // Trois paires possibles avec 7 cartes : la troisième peut servir de carte d'accompagnement.
  if (p1 && p2) return (TWO_PAIR << 20) | (p1 << 16) | (p2 << 12) | kick(mask & ~(1 << p1) & ~(1 << p2), 1, 8);
  if (p1) return (PAIR << 20) | (p1 << 16) | kick(mask & ~(1 << p1), 3, 12);
  return kick(mask, 5, 16);
}
const categoryOf = s => s >> 20;
// Nom de la main, en anglais (js/i18n.js le traduit par motif) : « Two Pair, Kings and Sevens ».
const ONE = ['', '', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const MANY = ['', '', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
function describe(s) {
  const k = i => (s >> (16 - 4 * i)) & 15;
  switch (s >> 20) {
    case STRAIGHT_FLUSH: return k(0) === 14 ? 'Royal Flush' : `Straight Flush, ${ONE[k(0)]} high`;
    case QUADS: return `Four of a Kind, ${MANY[k(0)]}`;
    case FULL: return `Full House, ${MANY[k(0)]} full of ${MANY[k(1)]}`;
    case FLUSH: return `Flush, ${ONE[k(0)]} high`;
    case STRAIGHT: return `Straight, ${ONE[k(0)]} high`;
    case TRIPS: return `Three of a Kind, ${MANY[k(0)]}`;
    case TWO_PAIR: return `Two Pair, ${MANY[k(0)]} and ${MANY[k(1)]}`;
    case PAIR: return `Pair of ${MANY[k(0)]}`;
    default: return `High Card, ${ONE[k(0)]}`;
  }
}
// Première carte d'accompagnement qui départage deux mains de même nom : « Queen kicker ».
function kicker(win, lose) {
  for (let i = 0; i < 5; i++) { const a = (win >> (16 - 4 * i)) & 15, b = (lose >> (16 - 4 * i)) & 15; if (a !== b) return `${ONE[a]} kicker`; }
  return null;
}
// Les 5 cartes qui font la main (pour les faire briller à l'écran) : la meilleure des 21 combinaisons.
function best5(cards) {
  if (cards.length <= 5) return cards.slice();
  let best = -1, out = null;
  const pick = [];
  const walk = (from, left) => {
    if (!left) { const s = score(pick, 5); if (s > best) { best = s; out = pick.slice(); } return; }
    for (let i = from; i <= cards.length - left; i++) { pick.push(cards[i]); walk(i + 1, left - 1); pick.pop(); }
  };
  walk(0, 5);
  return out;
}

// ---------------------------------------------------------------- déroulé d'une main
// La table `t` : { sb, bb, seats: [siège | null, …], hand, btn }, de 2 à 6 sièges (tables entre amis, demandé par
// Sacha le 2026-11-04 : « can we be more than two at the table ») ; les tables contre le bot en ont toujours 2.
// Un siège : { stack, … } ; null = place libre. Les jetons d'une main en cours sont dans hand.put (misés depuis le début
// de la main) et hand.bet (misés sur ce tour d'enchères) ; seats[i].stack = le reste. hand.in[i] : le siège a reçu des
// cartes (un joueur arrivé pendant la main attend la suivante) ; hand.fold[i] : il s'est couché.
// Le bouton tourne sur les sièges occupés ; petite blind puis grosse blind à sa gauche. À deux, le bouton met la petite
// blind et parle en premier avant le flop, en dernier après (règle du heads-up, inchangée).
// rnd(n) → entier dans [0, n) : crypto.randomInt sur le serveur, un générateur rapide dans la simulation.
const seatIn = (h, i) => (h.in ? !!h.in[i] : true); // les mains d'avant le 2026-11-04 n'ont pas « in » : tout le monde
const live = (t, i) => { const h = t.hand; return seatIn(h, i) && !(h.fold && h.fold[i]); };
const chips = (t, i) => (t.seats[i] ? t.seats[i].stack : 0);
// Les sièges qui suivent `from` dans le sens du jeu (sens des aiguilles d'une montre), `from` en dernier, filtrés par ok.
function around(t, from, ok) {
  const n = t.seats.length, out = [];
  for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (ok(i)) out.push(i); }
  return out;
}
function newHand(t, rnd) {
  const n = t.seats.length, deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) { const j = rnd(i + 1); const x = deck[i]; deck[i] = deck[j]; deck[j] = x; }
  const ok = i => !!t.seats[i] && t.seats[i].stack > 0;
  const start = t.btn || 0;
  const b = t.hand ? around(t, t.hand.btn, ok)[0] : ok(start) ? start : around(t, start, ok)[0];
  const order = around(t, b, ok); // le premier à gauche du bouton … le bouton en dernier
  const heads = order.length === 2, sb = heads ? b : order[0], bb = heads ? order[0] : order[1];
  const fill = v => Array.from({ length: n }, () => v);
  const h = { btn: b, sb, bbs: bb, deck, hole: Array.from({ length: n }, () => []), in: fill(false), fold: fill(false), board: [], street: 0, bet: fill(0), put: fill(0), cur: 0, minr: t.bb, acted: fill(false), chk: fill(false), noRaise: fill(false), turn: b, done: false, res: null, last: null };
  for (const i of order) h.in[i] = true;
  for (let k = 0; k < 2; k++) for (const i of order) h.hole[i].push(deck.pop());
  t.hand = h; t.btn = b;
  post(t, sb, t.sb); post(t, bb, t.bb);
  h.cur = Math.max(...h.bet);
  // Premier à parler avant le flop : à gauche de la grosse blind (à deux : le bouton). Une blind qui met déjà quelqu'un
  // à tapis : la main peut n'avoir plus rien à décider.
  const first = around(t, bb, i => h.in[i])[0];
  h.turn = first;
  if (!needs(t, first)) { const next = around(t, first, i => needs(t, i))[0]; if (next != null) h.turn = next; else closeStreet(t); }
  return h;
}
function post(t, i, amount) {
  const h = t.hand, a = Math.min(amount, t.seats[i].stack);
  t.seats[i].stack -= a; h.bet[i] += a; h.put[i] += a;
}
// Le joueur i doit-il encore parler sur ce tour ? Non s'il est couché ou à tapis, ou si tous les autres encore en jeu
// sont à tapis et qu'il a déjà mis au moins autant qu'eux (il n'y a plus rien à suivre ni à relancer).
function needs(t, i) {
  const h = t.hand;
  if (!h || h.done || !live(t, i) || chips(t, i) === 0) return false;
  let others = false, top = 0;
  for (let j = 0; j < t.seats.length; j++) if (j !== i && live(t, j)) { if (chips(t, j) > 0) others = true; top = Math.max(top, h.bet[j]); }
  if (!others && h.bet[i] >= top) return false;
  return !h.acted[i] || h.bet[i] < h.cur;
}
// Ce que le joueur i peut faire. Relancer « à » un montant total sur ce tour : au moins la dernière relance en plus
// (ou tapis s'il n'a pas assez), au plus ce que le plus gros tapis d'en face peut encore suivre (au-delà, personne ne
// suivrait). Après un tapis plus petit qu'une relance complète, ceux qui avaient déjà parlé peuvent seulement suivre.
function options(t, i) {
  const h = t.hand, st = chips(t, i);
  const toCall = Math.min(h.cur - h.bet[i], st);
  let cover = 0, others = false;
  for (let j = 0; j < t.seats.length; j++) if (j !== i && live(t, j)) { cover = Math.max(cover, h.bet[j] + chips(t, j)); if (chips(t, j) > 0) others = true; }
  const maxTo = Math.min(h.bet[i] + st, cover);
  const canRaise = others && maxTo > h.cur && st > toCall && !(h.noRaise && h.noRaise[i]);
  return { toCall, canCheck: toCall === 0, canRaise, minTo: canRaise ? Math.min(h.cur + h.minr, maxTo) : 0, maxTo: canRaise ? maxTo : 0 };
}
const refuse = (status, error) => Object.assign(new Error(error), { status });
// À qui le tour après le siège i : le prochain qui doit parler, sinon le tour d'enchères est fini.
function pass(t, i) {
  const next = around(t, i, j => needs(t, j))[0];
  if (next != null) t.hand.turn = next; else closeStreet(t);
}
// Joue un coup pour le joueur i. move : fold | check | call | raise (to = montant total sur ce tour) | allin.
// Tout est vérifié ici : le site n'envoie qu'une intention, jamais un montant qu'on croirait sur parole.
function act(t, i, move, to) {
  const h = t.hand;
  if (!h || h.done) throw refuse(422, 'No hand in play');
  if (h.turn !== i) throw refuse(422, 'Not your turn');
  const op = options(t, i);
  if (move === 'allin') { if (op.canRaise) { move = 'raise'; to = op.maxTo; } else move = 'call'; }
  if (move === 'call' && op.toCall === 0) move = 'check';
  if (move === 'fold') { h.last = { s: i, m: 'fold' }; return fold(t, i); }
  if (move === 'check') {
    if (!op.canCheck) throw refuse(422, 'You cannot check: call, raise or fold');
    h.last = { s: i, m: 'check' }; h.chk[i] = true;
  } else if (move === 'call') {
    post(t, i, op.toCall);
    h.last = { s: i, m: 'call', a: op.toCall, allin: t.seats[i].stack === 0 };
  } else if (move === 'raise') {
    to = Number(to);
    if (!op.canRaise) throw refuse(422, 'You cannot raise now');
    if (!Number.isInteger(to) || to < op.minTo || to > op.maxTo) throw refuse(400, `Raise to between ${op.minTo} and ${op.maxTo}`);
    post(t, i, to - h.bet[i]);
    const full = to - h.cur >= h.minr;
    if (full) h.minr = to - h.cur; // une relance complète ; un tapis plus petit ne la change pas
    h.last = { s: i, m: h.cur === 0 ? 'bet' : 'raise', a: to, allin: t.seats[i].stack === 0 };
    h.cur = to;
    for (let j = 0; j < t.seats.length; j++) {
      if (j === i || !live(t, j)) continue;
      if (h.noRaise) h.noRaise[j] = full ? false : h.noRaise[j] || h.acted[j]; // relance incomplète : pas de sur-relance
      h.acted[j] = false;
    }
  } else throw refuse(400, 'Unknown move');
  h.acted[i] = true;
  pass(t, i);
}
// Se coucher hors de son tour : seulement en quittant la table (le joueur abandonne la main en cours).
function forfeit(t, i) {
  const h = t.hand;
  if (!h || h.done || !live(t, i)) return;
  h.last = { s: i, m: 'fold' };
  fold(t, i);
}
function fold(t, i) {
  const h = t.hand;
  h.folded = i;
  if (h.fold) h.fold[i] = true; else h.fold = h.bet.map((_, j) => j === i);
  const left = h.bet.map((_, j) => j).filter(j => live(t, j));
  if (left.length === 1) {
    // Tout le monde s'est couché : la part de la mise du gagnant que personne n'a suivie lui revient avant le partage
    // (sans commission dessus), puis il prend tout.
    const w = left[0], other = Math.max(0, ...h.bet.filter((_, j) => j !== w && seatIn(h, j)));
    const extra = h.bet[w] - other;
    if (extra > 0) { t.seats[w].stack += extra; h.bet[w] -= extra; h.put[w] -= extra; }
    return settle(t, false);
  }
  if (h.turn === i || !needs(t, h.turn)) pass(t, i);
}
// Fin d'un tour d'enchères : la plus grosse mise, pour la part que personne n'a pu suivre, revient à son auteur.
// Si au plus un joueur a encore des jetons, plus personne ne peut miser : le tableau sort jusqu'au bout et on abat.
function closeStreet(t) {
  const h = t.hand, n = t.seats.length;
  let top = -1;
  for (let j = 0; j < n; j++) if (live(t, j) && (top < 0 || h.bet[j] > h.bet[top])) top = j; // un joueur couché ne reprend rien
  const second = Math.max(0, ...h.bet.filter((_, j) => j !== top && seatIn(h, j)));
  if (top >= 0 && h.bet[top] > second) { const extra = h.bet[top] - second; t.seats[top].stack += extra; h.bet[top] -= extra; h.put[top] -= extra; }
  const withChips = h.bet.map((_, j) => j).filter(j => live(t, j) && chips(t, j) > 0);
  if (h.street === 3 || withChips.length <= 1) {
    while (h.board.length < 5) { h.deck.pop(); for (let k = h.board.length ? 1 : 3; k > 0; k--) h.board.push(h.deck.pop()); }
    h.street = 3;
    return showdown(t);
  }
  h.street++;
  h.deck.pop(); // carte brûlée, comme au vrai casino
  for (let k = h.street === 1 ? 3 : 1; k > 0; k--) h.board.push(h.deck.pop());
  const zero = () => Array.from({ length: n }, () => 0), no = () => Array.from({ length: n }, () => false);
  h.bet = zero(); h.cur = 0; h.minr = t.bb; h.acted = no(); h.chk = no(); h.noRaise = no();
  // Après le flop : le premier encore en jeu à gauche du bouton (à deux : celui qui n'a pas le bouton).
  const first = around(t, h.btn, j => needs(t, j))[0];
  if (first != null) h.turn = first; else closeStreet(t);
}
function showdown(t) {
  const h = t.hand, s = h.bet.map((_, i) => (live(t, i) ? score([...h.hole[i], ...h.board]) : -1));
  settle(t, true, s);
}
// Les pots : un pot principal, puis un pot de côté à chaque tapis d'une taille différente. Chaque pot va à la meilleure
// main parmi ceux qui y ont mis autant que lui, moins 5 % ; égalité : partagé, les jetons impairs d'abord au premier
// gagnant à gauche du bouton. Les jetons des joueurs couchés restent dans les pots où ils les ont mis.
function pots(t) {
  const h = t.hand, n = t.seats.length, out = [];
  const liveIdx = h.put.map((_, i) => i).filter(i => live(t, i));
  const levels = [...new Set(liveIdx.map(i => h.put[i]))].sort((a, b) => a - b);
  let prev = 0;
  for (const L of levels) {
    let amount = 0;
    for (let i = 0; i < n; i++) if (seatIn(h, i)) amount += Math.max(0, Math.min(h.put[i], L) - prev);
    if (amount > 0) out.push({ amount, elig: liveIdx.filter(i => h.put[i] >= L) });
    prev = L;
  }
  let extra = 0; for (let i = 0; i < n; i++) if (seatIn(h, i)) extra += Math.max(0, h.put[i] - prev);
  if (extra) { if (out.length) out[out.length - 1].amount += extra; else out.push({ amount: extra, elig: liveIdx }); }
  return out;
}
function settle(t, shown, s) {
  const h = t.hand, n = t.seats.length, win = Array.from({ length: n }, () => 0);
  const seatOrder = around(t, h.btn, () => true); // à gauche du bouton d'abord : pour les jetons impairs
  const all = pots(t).map(p => {
    const rake = rakeOf(p.amount), net = p.amount - rake;
    const best = shown ? Math.max(...p.elig.map(i => s[i])) : null;
    const winners = (shown ? p.elig.filter(i => s[i] === best) : p.elig.slice()).sort((a, b) => seatOrder.indexOf(a) - seatOrder.indexOf(b));
    const share = Math.floor(net / winners.length);
    winners.forEach((i, k) => { win[i] += share + (k < net - share * winners.length ? 1 : 0); });
    return { amount: p.amount, rake, winners, elig: p.elig };
  });
  for (let i = 0; i < n; i++) if (win[i]) t.seats[i].stack += win[i];
  const pot = h.put.reduce((x, v) => x + v, 0), rake = all.reduce((x, p) => x + p.rake, 0);
  const winners = win.map((v, i) => i).filter(i => win[i] > 0);
  h.done = true; h.turn = -1;
  h.res = { pot, rake, win, w: winners.length === 1 ? winners[0] : -1, shown, pots: all };
  if (shown) {
    h.res.desc = s.map(v => (v >= 0 ? describe(v) : null));
    const main = all[0], w0 = main.winners[0];
    // Même nom de main que le meilleur perdant (« Pair of Tens » contre « Pair of Tens ») : on dit ce qui a départagé.
    const losers = main.elig.filter(i => !main.winners.includes(i)).sort((a, b) => s[b] - s[a]);
    if (main.winners.length === 1 && losers.length && h.res.desc[w0] === h.res.desc[losers[0]]) h.res.kick = kicker(s[w0], s[losers[0]]);
    h.res.best = best5([...h.hole[w0], ...h.board]);
  }
}

// ---------------------------------------------------------------- le bot
// Il ne triche pas : il ne reçoit que ce qu'un joueur voit (ses deux cartes, le tableau, les mises, les tapis) et ce
// qu'il a observé des coups passés de l'adversaire (botView). Il estime ses chances par Monte-Carlo contre les mains
// que l'adversaire peut avoir, compare au prix à payer (cote du pot, commission comprise), mise ses bonnes mains, bluffe
// parfois au hasard, et s'adapte : contre quelqu'un qui relance tout, il suit plus large ; contre quelqu'un qui ne se
// couche jamais, il arrête de bluffer et mise plus de mains pour la valeur.
function botView(t, i) {
  const h = t.hand, o = 1 - i;
  return {
    hole: h.hole[i].slice(), board: h.board.slice(), street: h.street, bb: t.bb, ip: h.btn === i,
    pot: h.put[0] + h.put[1], myBet: h.bet[i], oppBet: h.bet[o], cur: h.cur,
    myStack: t.seats[i].stack, oppStack: t.seats[o].stack, ...options(t, i),
    // Mise volontaire de l'adversaire (la grosse blind n'en est pas une : sa main est quelconque).
    voluntary: h.street > 0 ? h.cur > 0 : h.cur > t.bb,
    // Il a parlé (check) sur ce tour et l'adversaire a misé derrière : une mise « qui profite du check ».
    checked: h.street > 0 && !!(h.chk && h.chk[i]) && h.cur > 0,
  };
}
// Force d'une main de départ (formule de Chen) → rang en centile parmi les 1 326 mains : 0 = la meilleure, 1 = la pire.
function chen(a, b) {
  const ra = rankOf(a), rb = rankOf(b), hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  const pts = r => (r === 14 ? 10 : r === 13 ? 8 : r === 12 ? 7 : r === 11 ? 6 : r / 2);
  let v = pts(hi);
  if (ra === rb) return Math.max(5, v * 2);
  if (suitOf(a) === suitOf(b)) v += 2;
  const gap = hi - lo - 1;
  v -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 12) v += 1;
  return Math.ceil(v);
}
const PRE = new Float32Array(52 * 52);
{
  const all = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) all.push([a, b, chen(a, b)]);
  all.sort((x, y) => y[2] - x[2]);
  // Centile au milieu des ex æquo : une main vaut autant que toutes celles qui ont la même note.
  for (let i = 0; i < all.length;) {
    let j = i; while (j < all.length && all[j][2] === all[i][2]) j++;
    const pct = (i + j) / 2 / all.length;
    for (let k = i; k < j; k++) { PRE[all[k][0] * 52 + all[k][1]] = pct; PRE[all[k][1] * 52 + all[k][0]] = pct; }
    i = j;
  }
}
// Force d'une main de l'adversaire après le flop, pour imaginer ce qu'il mise : sa main faite, avec un tirage
// couleur ou quinte compté comme une petite paire (il mise souvent ces mains-là).
function postStrength(a, b, board) {
  const cards = [a, b, ...board];
  let s = score(cards);
  if (board.length < 5 && s < (TWO_PAIR << 20)) {
    const sc = [0, 0, 0, 0]; for (const c of cards) sc[c & 3]++;
    const flushDraw = sc.some((n, su) => n === 4 && (suitOf(a) === su || suitOf(b) === su));
    let mask = 0; for (const c of cards) mask |= 1 << rankOf(c);
    if (mask & (1 << 14)) mask |= 2;
    let oesd = false; for (let lo = 1; lo <= 10 && !oesd; lo++) if (((mask >> lo) & 15) === 15 && (((1 << rankOf(a)) | (1 << rankOf(b))) & (15 << lo))) oesd = true;
    if (flushDraw || oesd) s = Math.max(s, (PAIR << 20) | (6 << 16));
  }
  return s;
}
// Chances de gagner (égalité = moitié) contre une main au hasard parmi celles qui passent `range` (fraction des
// meilleures mains de l'adversaire : 1 = n'importe laquelle), par tirages au sort des cartes inconnues.
function equity(hole, board, iters, rng, range = 1) {
  const known = new Set([...hole, ...board]);
  const rest = []; for (let c = 0; c < 52; c++) if (!known.has(c)) rest.push(c);
  const need = 5 - board.length, me = new Array(7), op = new Array(7);
  me[0] = hole[0]; me[1] = hole[1];
  for (let k = 0; k < board.length; k++) { me[2 + k] = board[k]; op[2 + k] = board[k]; }
  let keep = null;
  if (range < 0.999) {
    if (board.length === 0) keep = (a, b) => PRE[a * 52 + b] <= range;
    else {
      // Seuil de force : on tire 120 mains possibles, on garde la fraction `range` des plus fortes.
      const s = [];
      for (let k = 0; k < 120; k++) {
        const i = Math.floor(rng() * rest.length); let j = Math.floor(rng() * (rest.length - 1)); if (j >= i) j++;
        s.push(postStrength(rest[i], rest[j], board));
      }
      s.sort((x, y) => y - x);
      const cut = s[Math.min(s.length - 1, Math.max(0, Math.floor(range * s.length) - 1))];
      keep = (a, b) => postStrength(a, b, board) >= cut;
    }
  }
  let won = 0, n = 0;
  for (let it = 0; it < iters; it++) {
    let tries = 0;
    for (;;) {
      for (let k = 0; k < 2; k++) { const j = k + Math.floor(rng() * (rest.length - k)); const x = rest[k]; rest[k] = rest[j]; rest[j] = x; }
      if (!keep || keep(rest[0], rest[1]) || ++tries > 30) break;
    }
    for (let k = 0; k < need; k++) { const j = 2 + k + Math.floor(rng() * (rest.length - 2 - k)); const x = rest[2 + k]; rest[2 + k] = rest[j]; rest[j] = x; }
    for (let k = 0; k < need; k++) { me[2 + board.length + k] = rest[2 + k]; op[2 + board.length + k] = rest[2 + k]; }
    op[0] = rest[0]; op[1] = rest[1];
    const a = score(me, 7), b = score(op, 7);
    won += a > b ? 1 : a === b ? 0.5 : 0; n++;
  }
  return n ? won / n : 0.5;
}
// Ce que le bot a observé de son adversaire (gardé dans la table, mis à jour à chaque coup de l'humain) :
// pa/po = relances / occasions de relancer avant le flop, qa/qo = après ; fb/ff = mises du bot affrontées / couchés.
// sa/so = mises de l'adversaire après un check du bot / occasions de le faire (après le flop).
const newModel = () => ({ pa: 0, po: 0, qa: 0, qo: 0, fb: 0, ff: 0, sa: 0, so: 0 });
// À appeler AVANT d'appliquer le coup de l'adversaire (op = ses options à ce moment-là).
function observe(m, t, i, move) {
  const op = options(t, i), pre = t.hand.street === 0;
  if (op.canRaise) { if (pre) m.po++; else m.qo++; if (move === 'raise' || move === 'allin') { if (pre) m.pa++; else m.qa++; } }
  if (op.toCall > 0 && (t.hand.street > 0 || t.hand.cur > t.bb)) { m.fb++; if (move === 'fold') m.ff++; }
  const h = t.hand;
  if (h.street > 0 && op.toCall === 0 && op.canRaise && h.acted[1 - i]) { m.so = (m.so || 0) + 1; if (move === 'raise' || move === 'allin') m.sa = (m.sa || 0) + 1; }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ITERS = 260;
// Réglages du bot, trouvés avec tools/poker-sim.mjs (qui peut les changer le temps d'un essai : POKER_TUNE='{"…":…}').
// Premier réglage (mise rare, bluff 22 % au flop) : une copie du bot qui misait 40 % des fois où il aurait parlé le
// battait (+8 grosses blinds pour 100 mains). Le bot mise donc plus souvent en premier (lead, bluffs) et suit un peu
// moins large (margin) : plus aucune stratégie testée ne gagne.
const P = { rangeMul: 1.5, stabMul: 0.5, thin: 0.62, bluffPre: 0.12, bluffFlop: 0.35, bluffLater: 0.25, strongPre: 0.6, strongPost: 0.7, crFreq: 0.3, crEq: 0.3, margin: 0.05, lead: 0.4 };
function decide(v, m, rng) {
  const pre = v.street === 0;
  // Fréquence de relance de l'adversaire (avec un a priori d'environ 1 sur 3) → largeur de la main qu'il représente.
  const aggr = pre ? (m.pa + 2) / (m.po + 6) : (m.qa + 2) / (m.qo + 6);
  const foldRate = (m.ff + 2) / (m.fb + 5); // à quel point il se couche face aux mises du bot
  const potIfCall = v.pot + v.toCall;
  // Plus la mise est grosse par rapport au pot, plus la main de l'adversaire est forte (mais jamais moins de 10 %).
  const rel = v.voluntary ? v.toCall / Math.max(1, v.pot - v.toCall) : 0;
  // Sa fréquence de relance sous-estime sa main réelle : il mise aussi des mains faibles (bluffs). D'où le × 1,5.
  let range = v.voluntary ? clamp(P.rangeMul * aggr * (1.2 - 0.2 * Math.min(2, rel)), 0.15, 1) : 1;
  // Quelqu'un qui mise presque à chaque fois que le bot parle n'a pas toujours une main : on le suit plus large, et on
  // le relance parfois en bluff (check-raise).
  const stab = ((m.sa || 0) + 1) / ((m.so || 0) + 3);
  if (v.checked) range = clamp(range * (P.stabMul + stab), 0.15, 1);
  const e = equity(v.hole, v.board, ITERS, rng, range);
  const raiseTo = frac => {
    // Relance « à » : ce qui est déjà misé + frac × (pot après avoir suivi), bornée par les règles.
    const want = Math.round(v.cur + frac * potIfCall);
    return clamp(want, v.minTo, v.maxTo);
  };
  const shove = { move: 'raise', to: v.maxTo };
  const spr = Math.min(v.myStack, v.oppStack + v.oppBet - v.myBet) / Math.max(1, potIfCall);
  const r = rng();
  if (v.toCall === 0) {
    // Personne n'a misé : miser pour la valeur, bluffer de temps en temps, sinon parler (check).
    const thin = clamp(P.thin - 0.1 * (0.45 - foldRate) / 0.45, P.thin - 0.1, P.thin + 0.04) - (pre ? 0 : P.lead * stab); // seuil plus bas contre ceux qui suivent tout
    if (v.canRaise && e >= thin) {
      if (spr < 1.2 || (e > 0.85 && r < 0.3)) return shove;
      return { move: 'raise', to: raiseTo(pre ? 0.9 + 0.5 * rng() : 0.5 + 0.4 * rng()) };
    }
    const bluff = (pre ? P.bluffPre : v.street === 1 ? P.bluffFlop : P.bluffLater) * clamp(foldRate / 0.4, 0, 1.4);
    if (v.canRaise && e < 0.42 && r < bluff) return { move: 'raise', to: raiseTo(0.5 + 0.3 * rng()) };
    return { move: 'check' };
  }
  // Face à une mise : le prix (commission comprise) contre les chances de gagner contre ce qu'il représente.
  const need = v.toCall / (potIfCall * (1 - RAKE) + v.toCall * RAKE);
  const strong = pre ? P.strongPre : P.strongPost;
  if (v.canRaise && e >= strong && r < 0.75) {
    if (spr < 2 || e > 0.86) return shove;
    return { move: 'raise', to: raiseTo(pre ? 1 + 0.6 * rng() : 0.7 + 0.4 * rng()) };
  }
  if (v.checked && v.canRaise && e > P.crEq && r < P.crFreq * clamp((stab - 0.4) / 0.5, 0, 1) && v.myStack > v.toCall * 3) return { move: 'raise', to: raiseTo(0.9 + 0.3 * rng()) };
  if (e >= need + P.margin || (v.toCall <= v.bb && e >= need - 0.04)) return { move: 'call' };
  // Relance de bluff, rare, seulement quand la mise est petite et que l'adversaire se couche souvent.
  if (v.canRaise && rel < 0.8 && r < 0.05 * clamp(foldRate / 0.4, 0, 1.5) && v.myStack > v.toCall * 4) return { move: 'raise', to: raiseTo(0.9) };
  return { move: 'fold' };
}
// Le coup du bot pour le siège i (jamais rien d'autre que botView).
const botMove = (t, i, m, rng) => decide(botView(t, i), m, rng);

module.exports = { P, RAKE, rakeOf, rankOf, suitOf, toClient, score, categoryOf, describe, best5, newHand, needs, options, act, forfeit, pots, around, live, botView, botMove, decide, equity, chen, newModel, observe };
