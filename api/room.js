// Duel en direct avec un code, de 2 à 10 joueurs : tout le monde tire en même temps, manche par manche, et voit les
// tirages de tous se révéler ensemble. Deux modes :
//   - rounds : chaque manche va au plus gros tirage (égalité en tête : personne) ; le premier à N manches gagne (1 à 10) ;
//   - xp     : le premier à atteindre un total d'XP gagne (si plusieurs le franchissent ensemble : le plus gros total).
// Les tirages sont des tirages normaux (historique, compteurs, classement), faits par le serveur au même instant pour
// tous les joueurs. Une manche part quand tout le monde est prêt, ou 15 s après le premier joueur prêt : un absent ne
// bloque pas la partie (son nombre est tiré quand même, comme celui des autres).
// Pendant la partie, les joueurs peuvent envoyer des réactions (emoji) que tout le monde voit en direct.
//   POST /api/room { action: 'ask' | 'accept' | 'decline', code, who? } : un spectateur demande à entrer dans une partie
//        en cours ; l'hôte accepte (le joueur joue dès la manche suivante, avec son retard) ou refuse
//   POST /api/room { action: 'create' | 'join' | 'start' | 'ready' | 'react' | 'rematch', code?, size?, mode?, target?, emoji?, playerId, secret, name }
//   GET  /api/room?code=<code>&me=<playerId>   (sondé toutes les ~1,5 s par les joueurs et les spectateurs)
//   GET  /api/room?live=1                      → parties publiques en cours ("Live now"), à regarder ou rejoindre
// Bots : "create" avec bots: k (partie privée qui démarre aussitôt) ou "addBot" par l'hôte dans le salon. Toujours prêts,
// ils tirent comme tout le monde et réagissent après chaque manche. Une partie avec des bots ne compte ni en victoires
// de duel ni en face-à-face (sinon on farmerait) ; les tirages des humains, eux, comptent comme des tirages normaux.
const crypto = require('node:crypto');
const { engine, redis, cleanName, claimPlayer, claimName, queueReveal, readStats, statsKey, questKey, QUEST_TTL, dayKey, settleWager, Achievements, cors, send, flushDue } = require('./_lib');
const Shop = require('../js/shop.js');

const MIN_PLAYERS = 2, MAX_PLAYERS = 10;
const MAX_WINS = 10;
const XP_TARGETS = [25000, 50000, 100000, 250000, 1000000];
const MAX_ROUNDS = 100; // garde-fou : au-delà, le plus de manches (puis d'XP) gagne
const LEAD_MS = 2500; // délai avant la révélation commune : tout le monde a le temps de recevoir la manche
// Révélation complète d'une manche à l'écran (dernier chiffre + gagnant, voir roundLength dans app.js) : les tirages
// n'apparaissent dans l'historique, le classement et les stats qu'après.
const REVEAL_MS = 9700;
const SEEN_EVERY_MS = 10000;
const GAP_MS = 8000; // écart minimal entre deux manches, comme le délai entre deux tirages
const AUTO_MS = 15000; // la manche part toute seule 15 s après le premier joueur prêt
const ABANDON_MS = 30000; // plus aucun joueur sur la page depuis 30 s : la partie s'arrête (sans gagnant ni stats)
const TTL = 86400; // une salle est gardée un jour après sa dernière action
// Emotes (images img/emotes/<id>.png : la mascotte dé qui rit, pleure, s'énerve, fait le cool, est choquée, joue au roi).
const REACTIONS = ['laugh', 'cry', 'angry', 'cool', 'shock', 'king'];
const REACT_SHOWN_MS = 15000; // réactions renvoyées aux sondages pendant 15 s
const REACT_EVERY_MS = 700; // au plus une réaction toutes les 0,7 s par joueur
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I, 32 signes
const BOT_NAMES = ['Robo', 'DiceBot', 'Lucky 9000', 'Glitch', 'Byte', 'Clanky', 'Sparky', 'Nano', 'Beep Boop', 'Tux'];
const pick = list => list[crypto.randomInt(0, list.length)];

// Un bot : identifiant qui ne peut pas être celui d'un vrai joueur, nom libre dans la salle, skin au hasard.
function makeBot(taken) {
  const free = BOT_NAMES.filter(n => !taken.includes(n));
  return { id: `bot-${crypto.randomBytes(4).toString('hex')}`, name: free.length ? pick(free) : `Bot ${taken.length + 1}`, bot: true, title: null, skin: pick(Shop.SKINS.filter(k => !k.premium)).id }; // pas de skin premium sur un bot : ils se méritent
}
const roomKey = code => `room:${code}`;
const playersKey = code => `room:${code}:players`;
const roundsKey = code => `room:${code}:rounds`;
const reactsKey = code => `room:${code}:reacts`;
const LIVE_KEY = 'rooms:live'; // parties publiques, score = dernière activité
const LIVE_MS = 10 * 60000; // une partie sans activité depuis 10 min sort de la liste
const isCode = code => /^[A-Z2-9]{5}$/.test(code);
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const newCode = () => Array.from(crypto.randomBytes(5), b => ALPHABET[b % 32]).join('');

// Règles de la partie, bornées : taille 2-10, 1-10 manches gagnantes, ou un des paliers d'XP proposés.
function rules(body) {
  const size = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.round(Number(body.size) || 2)));
  const mode = body.mode === 'xp' ? 'xp' : 'rounds';
  const target = mode === 'xp'
    ? (XP_TARGETS.includes(Number(body.target)) ? Number(body.target) : XP_TARGETS[1])
    : Math.min(MAX_WINS, Math.max(1, Math.round(Number(body.target) || 3)));
  // Mise en pièces (0 = aucune) : chacun la paie en entrant, le gagnant prend le pot.
  const stake = Shop.STAKES.includes(Number(body.stake)) ? Number(body.stake) : 0;
  return { size, mode, target, stake, isPublic: body.public !== false };
}
const STAKE_REFUND_MS = 12 * 3600000; // filet : une salle à mise jamais réglée est remboursée au bout de 12 h
const stakeOf = room => Number(room.h.stake) || 0;
const potOf = room => Object.entries(room.h).filter(([k]) => k.startsWith('paid:')).reduce((x, [, v]) => x + (Number(v) || 0), 0);
const coinsOf = async id => Shop.balance(await readStats(id));

// Anti-farm (comptes secondaires) : une victoire de duel ne donne ses récompenses (pièces, quête, succès de duel) que
// si elle a un vrai enjeu. Le face-à-face et le nombre de victoires affichés, eux, comptent toujours.
const WIN_PAIR_CAP = 3; // victoires récompensées par jour contre le même adversaire
const WIN_DAY_CAP = 10; // victoires récompensées par jour, au total
const MIN_ROLLS_OPPONENT = 20; // l'adversaire battu doit avoir un vrai compte (au moins 20 tirages)
const MIN_ROLLS_STAKE = 30; // tirages nécessaires pour jouer un duel avec mise
const winsKey = (day, id) => `dw:${day}:${id}`; // victoires du jour d'un joueur : champ "total" + un champ par adversaire
// Refus d'une mise : pas assez de tirages (compte trop neuf) ou pas assez de pièces. null = accepté.
async function stakeRefusal(id, stake) {
  const stats = await readStats(id);
  const rolls = Number(stats.rolls) || 0;
  if (rolls < MIN_ROLLS_STAKE) return `Stakes unlock after ${MIN_ROLLS_STAKE} rolls (you have ${rolls})`;
  if (Shop.balance(stats) < stake) return `Not enough coins for this stake (${stake})`;
  return null;
}

// Une partie publique en cours reste dans "Live now" tant qu'elle bouge ; finie, elle en sort.
const touchLive = (room, now = Date.now()) => (room.h.public === '1' ? [['ZADD', LIVE_KEY, now, room.code]] : []);

// Une salle : son hash (règles, hôte, "ready:<id>" = manche pour laquelle le joueur est prêt, "first:<k>" = heure du
// premier prêt), la liste ordonnée des joueurs { id, name, title }, les manches { t, revealAt, n: [un nombre par joueur] }
// et les dernières réactions { t, i (index du joueur), e }.
async function load(code) {
  const [flat, players, rounds, reacts] = await redis([
    ['HGETALL', roomKey(code)], ['LRANGE', playersKey(code), 0, -1], ['LRANGE', roundsKey(code), 0, -1], ['LRANGE', reactsKey(code), -20, -1],
  ]);
  const h = {};
  for (let i = 0; i < (flat || []).length; i += 2) h[flat[i]] = flat[i + 1];
  if (!h.host) return null;
  return {
    code, h, host: h.host, size: Number(h.size), mode: h.mode, target: Number(h.target), started: h.started === '1',
    players: (players || []).map(p => JSON.parse(p)), rounds: (rounds || []).map(r => JSON.parse(r)),
    reacts: (reacts || []).map(r => JSON.parse(r)),
  };
}

// Index du seul maximum, ou null s'il y a égalité en tête.
function argmax(values) {
  const best = Math.max(...values);
  const top = values.map((v, i) => (v === best ? i : -1)).filter(i => i >= 0);
  return top.length === 1 ? top[0] : null;
}

function score(room) {
  const count = room.players.length;
  const wins = Array(count).fill(0), totals = Array(count).fill(0);
  const list = room.rounds.map(r => {
    const s = r.n.map(n => engine.scoreOf(n));
    s.forEach((v, i) => { totals[i] += v; });
    const winner = argmax(s);
    if (winner !== null) wins[winner]++;
    return { t: r.t, revealAt: r.revealAt, n: r.n, s, winner };
  });
  let done = false, winner = null;
  if (room.mode === 'xp' && totals.some(v => v >= room.target)) {
    done = true;
    winner = argmax(totals);
  } else if (room.mode !== 'xp' && wins.some(v => v >= room.target)) {
    done = true;
    winner = wins.findIndex(v => v >= room.target);
  } else if (room.rounds.length >= MAX_ROUNDS) {
    done = true;
    winner = argmax(wins);
    if (winner === null) winner = argmax(totals);
  }
  return { list, wins, totals, done, winner };
}

// Dernier signe de vie des joueurs humains (les bots ne comptent pas) ; à défaut, la création de la salle.
function lastSeen(room) {
  return Math.max(Number(room.h.created) || 0, ...humans(room).map(p => Number(room.h[`seen:${p.id}`]) || 0));
}

// Partie désertée : personne n'est revenu depuis 30 s → elle s'arrête pour de bon et sort de "Live now".
// Renvoie true si la partie est (ou vient d'être) arrêtée.
async function checkAbandoned(room, now = Date.now()) {
  if (room.h.ended === '1') return true;
  if (score(room).done || now - lastSeen(room) <= ABANDON_MS) return false;
  await redis([['HSET', roomKey(room.code), 'ended', 1], ['ZREM', LIVE_KEY, room.code]]);
  room.h.ended = '1';
  if (stakeOf(room)) await settleWager(room.code, null); // partie désertée : chacun récupère sa mise
  return true;
}

// Un joueur de la salle vient de se manifester (sondage ou action).
async function touchSeen(room, id, now = Date.now()) {
  if (!room.players.some(p => p.id === id && !p.bot)) return;
  // Écrit au plus toutes les 10 s : largement assez pour la règle des 30 s, et 1 commande de moins par sondage.
  if (now - (Number(room.h[`seen:${id}`]) || 0) < SEEN_EVERY_MS) return;
  // "inroom" : le duel où se trouve le joueur, pour que ses amis puissent le rejoindre (s'efface seul 45 s après).
  await redis([['HSET', roomKey(room.code), `seen:${id}`, now], ['SET', `inroom:${id}`, room.code, 'EX', 45]]);
  room.h[`seen:${id}`] = String(now);
}

// Manche pour laquelle un joueur est prêt ; un bot l'est toujours.
const readyFor = (room, p) => (p.bot ? room.rounds.length : room.h[`ready:${p.id}`] == null ? -1 : Number(room.h[`ready:${p.id}`]));
const humans = room => room.players.filter(p => !p.bot);
const hasBots = room => room.players.some(p => p.bot);

// Lance la manche suivante si tout le monde est prêt (ou 15 s après le premier prêt). Un seul appel (verrou par
// manche) tire les nombres de tous les joueurs au même instant.
async function advance(room, now = Date.now()) {
  if (!room.started || room.h.ended === '1' || score(room).done) return room;
  const k = room.rounds.length;
  // Les bots ne lancent jamais une manche : il faut au moins un humain prêt.
  const ready = humans(room).filter(p => readyFor(room, p) === k).length;
  if (!ready) return room;
  const first = Number(room.h[`first:${k}`] || now);
  if (ready < humans(room).length && now < first + AUTO_MS) return room;
  const last = room.rounds[k - 1];
  if (last && now < last.revealAt + GAP_MS) return room;
  // Un joueur prêt qui a tiré ailleurs il y a moins de 8 s (autre partie, tirage normal) : on attend son délai.
  // Sinon plusieurs parties en parallèle (contre des bots par exemple) multiplieraient ses tirages.
  const readyHumans = humans(room).filter(p => readyFor(room, p) === k);
  const ttls = await redis(readyHumans.map(p => ['PTTL', `cooldown:${p.id}`]));
  if (ttls.some(ms => Number(ms) > 0)) return room;
  const [lock] = await redis([['SET', `${roomKey(room.code)}:draw:${k}`, '1', 'NX', 'EX', TTL]]);
  if (lock !== 'OK') return (await load(room.code)) || room;
  const round = { t: now, revealAt: now + LEAD_MS, n: room.players.map(() => crypto.randomInt(0, 1000001)) };
  room.rounds.push(round);
  const outcome = await duelOutcome(room, now);
  // Tirages (et bilan du duel s'il se termine) appliqués seulement une fois la manche révélée : voir queueReveal.
  const rolls = room.players.map((p, i) => [p.id, round.n[i], round.t]).filter((x, i) => !room.players[i].bot);
  await redis([
    ['RPUSH', roundsKey(room.code), JSON.stringify(round)],
    ...[roomKey(room.code), playersKey(room.code), roundsKey(room.code)].map(key => ['EXPIRE', key, TTL]),
    // Pas de tirage normal en parallèle pendant la manche.
    ...humans(room).map(p => ['SET', `cooldown:${p.id}`, '1', 'PX', GAP_MS]),
    ...touchLive(room, now),
    ...botReactions(room, round),
    ...(score(room).done ? [['ZREM', LIVE_KEY, room.code]] : []), // partie finie : sort de Live now tout de suite
    queueReveal(round.revealAt + REVEAL_MS, { room: room.code, k, rolls, w: [...outcome.writes, ...questWrites(room, now, outcome.rewarded)],
      ...(score(room).done && stakeOf(room) ? { wager: { code: room.code, winner: score(room).winner === null ? null : room.players[score(room).winner].id } } : {}) }),
    ['HSET', roomKey(room.code), 'due', round.revealAt + REVEAL_MS], // le sondage de la salle saura quand appliquer
    ...(outcome.reward ? [['HSET', roomKey(room.code), 'reward', outcome.reward]] : []),
  ]);
  if (outcome.reward) room.h.reward = outcome.reward;
  room.h.due = String(round.revealAt + REVEAL_MS);
  return room;
}

// Réactions des bots, datées juste après la révélation (le site ne les montre qu'à cette heure-là) :
// 🔥 ou 🎉 pour le gagnant de la manche, 😭 💀 ou 😱 sinon, pas à chaque fois.
function botReactions(room, round) {
  const s = round.n.map(n => engine.scoreOf(n));
  const best = Math.max(...s);
  const out = [];
  room.players.forEach((p, i) => {
    if (!p.bot || crypto.randomInt(0, 100) >= 55) return;
    const e = s[i] === best ? pick(['laugh', 'cool', 'king']) : pick(['cry', 'angry', 'shock']);
    out.push(['RPUSH', reactsKey(room.code), JSON.stringify({ t: round.revealAt + 10500 + crypto.randomInt(0, 1500), i, e })]);
  });
  if (out.length) out.push(['LTRIM', reactsKey(room.code), -30, -1], ['EXPIRE', reactsKey(room.code), TTL]);
  return out;
}

// Dernière manche tirée (une seule fois, sous le verrou) : résultat de la partie dans les stats des succès.
// Partie avec des bots : rien (pas de victoire, de face-à-face ni de pièces de victoire à farmer).
// Bilan d'un duel terminé (duels joués, victoires, face-à-face), à appliquer avec la révélation de la dernière manche.
// Parties avec bots : rien (anti-farm).
// Renvoie { writes, rewarded, reward } : reward = 'ok' si la victoire est récompensée, sinon la raison ('pair' : déjà
// 3 victoires aujourd'hui contre ces adversaires, 'day' : 10 victoires récompensées aujourd'hui, 'new' : adversaires au
// compte trop neuf) ; absent s'il n'y a pas de gagnant à récompenser (partie en cours, bots, égalité).
async function duelOutcome(room, now = Date.now()) {
  const sc = score(room);
  if (!sc.done || hasBots(room)) return { writes: [], rewarded: false, reward: null };
  const writes = room.players.map(p => ['HINCRBY', statsKey(p.id), 'duels', 1]);
  if (sc.winner === null) return { writes, rewarded: false, reward: null };
  const winner = room.players[sc.winner], others = room.players.filter((p, i) => i !== sc.winner);
  const w = statsKey(winner.id), day = dayKey(now), wins = winsKey(day, winner.id);
  // Face-à-face : le gagnant bat chacun des autres (h2h:<id> → "w:<adversaire>" victoires, "l:<adversaire>" défaites).
  others.forEach(p => writes.push(['HINCRBY', `h2h:${winner.id}`, `w:${p.id}`, 1], ['HINCRBY', `h2h:${p.id}`, `l:${winner.id}`, 1]));
  writes.push(['HINCRBY', w, 'duelWins', 1]);
  const [flat] = await redis([['HGETALL', wins]]);
  const today = {};
  for (let i = 0; i < (flat || []).length; i += 2) today[flat[i]] = Number(flat[i + 1]) || 0;
  const rolls = await Promise.all(others.map(async p => Number((await readStats(p.id)).rolls) || 0));
  const real = others.filter((p, i) => rolls[i] >= MIN_ROLLS_OPPONENT);
  const reward = (today.total || 0) >= WIN_DAY_CAP ? 'day'
    : !real.length ? 'new'
    : !real.some(p => (today[p.id] || 0) < WIN_PAIR_CAP) ? 'pair'
    : 'ok';
  others.forEach(p => writes.push(['HINCRBY', wins, p.id, 1]));
  writes.push(['EXPIRE', wins, 2 * 86400]);
  if (reward !== 'ok') {
    writes.push(['HINCRBY', w, 'duelUnpaid', 1]); // victoire comptée, mais sans pièces ni succès (voir js/shop.js)
    return { writes, rewarded: false, reward };
  }
  writes.push(['HINCRBY', wins, 'total', 1]);
  const alone = sc.wins.every((v, i) => i === sc.winner || v === 0);
  if (room.mode !== 'xp' && room.target >= 2 && alone) writes.push(['HINCRBY', w, 'flawless', 1]);
  if (room.players.length >= 5) writes.push(['HINCRBY', w, 'bigWin', 1]);
  if (room.mode === 'xp') writes.push(['HINCRBY', w, 'xpWin', 1]);
  return { writes, rewarded: true, reward };
}

// Compteurs du jour pour les quêtes, à la fin d'un duel : « duel fini » pour chaque humain (bots compris dans la
// partie), « duel gagné » seulement contre de vrais joueurs.
function questWrites(room, now, rewarded) {
  const sc = score(room);
  if (!sc.done) return [];
  const day = dayKey(now);
  const writes = humans(room).flatMap(p => [['HINCRBY', questKey(day, p.id), 'duels', 1], ['EXPIRE', questKey(day, p.id), QUEST_TTL]]);
  if (sc.winner !== null && rewarded) writes.push(['HINCRBY', questKey(day, room.players[sc.winner].id), 'duelWins', 1]);
  return writes;
}

// État public, sans identifiant : `me` marque le joueur qui regarde. Partie finie : ses succès, pour annoncer les nouveaux.
// Skin équipé en ce moment (changé dans Shop en pleine partie) : relu seulement quand le site le demande (?fresh=1,
// un sondage sur 4) et recopié dans la liste des joueurs s'il a changé ; les autres sondages lisent cette liste.
async function refreshSkins(room) {
  const people = room.players.map((p, i) => [p, i]).filter(([p]) => !p.bot);
  if (!people.length) return;
  const [live] = await redis([['HMGET', 'skins', ...people.map(([p]) => p.id)]]);
  const writes = [];
  people.forEach(([p, i], j) => {
    const skin = Shop.resolve(live[j]) || null;
    if ((p.skin || null) === skin) return;
    room.players[i] = { ...p, skin };
    writes.push(['LSET', playersKey(room.code), i, JSON.stringify(room.players[i])]);
  });
  if (writes.length) await redis(writes);
}

// Demandes d'entrée en attente (champs "ask:<id>" du hash), les plus anciennes d'abord ; oubliées après 2 minutes.
const ASK_MS = 120000;
function asksOf(room, now = Date.now()) {
  return Object.entries(room.h).filter(([k]) => k.startsWith('ask:')).map(([k, v]) => { const a = JSON.parse(v); return { id: k.slice(4), name: a.name, t: a.t }; })
    .filter(a => now - a.t < ASK_MS && !room.players.some(p => p.id === a.id)).sort((a, b) => a.t - b.t);
}

async function view(room, me) {
  const sc = score(room);
  const k = room.rounds.length;
  const status = sc.done ? 'done' : room.h.ended === '1' ? 'abandoned' : !room.started ? 'lobby' : 'playing';
  const readyCount = humans(room).filter(p => readyFor(room, p) === k).length;
  const first = room.h[`first:${k}`];
  const last = room.rounds[k - 1];
  return {
    code: room.code, status, size: room.size, mode: room.mode, target: room.target, public: room.h.public === '1', bots: hasBots(room),
    reward: room.h.reward || null, // 'ok' ou la raison pour laquelle la victoire n'a pas été récompensée
    stake: stakeOf(room), pot: potOf(room), settled: !room.h.settled ? null : room.h.settled === 'refund' ? 'refund' : 'paid', // jamais d'identifiant
    players: room.players.map((p, i) => ({
      name: p.name, title: p.title || null, skin: p.skin || null, bot: !!p.bot, me: p.id === me, host: p.id === room.host,
      ready: status === 'playing' && !p.bot && readyFor(room, p) === k, wins: sc.wins[i], total: sc.totals[i],
    })),
    rounds: sc.list,
    winner: sc.winner,
    // La manche part d'elle-même à autoAt (si quelqu'un est prêt), jamais avant nextAt (8 s après la précédente).
    autoAt: status === 'playing' && readyCount && readyCount < humans(room).length && first ? Number(first) + AUTO_MS : null,
    nextAt: last ? last.revealAt + GAP_MS : 0,
    // Demandes d'entrée en cours de partie : l'hôte voit les noms, celui qui a demandé sait que c'est en attente.
    asks: me && me === room.host ? asksOf(room).map(a => a.name) : undefined,
    asked: me ? asksOf(room).some(a => a.id === me) : false,
    canAsk: status === 'playing' && room.players.length < MAX_PLAYERS && !stakeOf(room),
    next: room.h.next || null, // code de la revanche, une fois lancée
    nextBy: room.h.nextBy || null, // nom de celui qui l'a lancée
    reacts: room.reacts.filter(r => r.t > Date.now() - REACT_SHOWN_MS && room.players[r.i])
      .map(r => ({ t: r.t, name: room.players[r.i].name, e: r.e })),
    achievements: status === 'done' && room.players.some(p => p.id === me) ? Achievements.unlocked(await readStats(me)) : undefined,
    now: Date.now(),
  };
}

// Titre et skin équipés d'un joueur au moment où il entre dans la salle (affichés à côté de son nom et sur ses cartes).
async function seat(id, name) {
  const [title, skin] = await redis([['HGET', 'titles', id], ['HGET', 'skins', id]]);
  return { id, name, title: title || null, skin: Shop.resolve(skin) || null };
}

// "Live now" : les 10 parties publiques les plus récemment actives, sans identifiant.
async function liveRooms(now = Date.now()) {
  const [, codes] = await redis([['ZREMRANGEBYSCORE', LIVE_KEY, '-inf', now - LIVE_MS], ['ZREVRANGE', LIVE_KEY, 0, 9]]);
  if (!codes || !codes.length) return [];
  const out = await redis(codes.flatMap(code => [['HGETALL', roomKey(code)], ['LRANGE', playersKey(code), 0, -1], ['LLEN', roundsKey(code)]]));
  return codes.map((code, i) => {
    const h = {};
    const flat = out[i * 3] || [];
    for (let j = 0; j < flat.length; j += 2) h[flat[j]] = flat[j + 1];
    const players = (out[i * 3 + 1] || []).map(p => JSON.parse(p));
    if (!h.host || !players.length) return null;
    if (h.ended === '1' || now - lastSeen({ h, players }) > ABANDON_MS) return null; // désertée
    return {
      code, status: h.started === '1' ? 'playing' : 'lobby', size: Number(h.size), count: players.length,
      mode: h.mode, target: Number(h.target), round: Number(out[i * 3 + 2] || 0),
      host: (players.find(p => p.id === h.host) || players[0]).name, players: players.map(p => p.name),
    };
  }).filter(Boolean);
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  // Le sondage des duels (toutes les quelques secondes, par joueur) est la requête la plus fréquente : il ne lit que la
  // salle (4 commandes) et n'applique les tirages en attente que lorsque ceux de cette salle sont échus.
  if (req.method !== 'GET') await flushDue();
  try {
    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://localhost').searchParams;
      if (params.get('live')) return send(res, 200, { rooms: await liveRooms() });
      const code = String(params.get('code') || '').toUpperCase();
      const me = isPlayerId(params.get('me')) ? params.get('me') : '';
      let room = isCode(code) ? await load(code) : null;
      if (!room) return send(res, 404, { error: 'No duel with this code' });
      if (room.h.due && Date.now() >= Number(room.h.due)) {
        await flushDue();
        await redis([['HDEL', roomKey(room.code), 'due']]);
        if (stakeOf(room)) room = (await load(code)) || room; // le pot vient d'être versé : relire l'état de la mise
        delete room.h.due;
      }
      if (!(await checkAbandoned(room))) {
        if (me) await touchSeen(room, me);
        room = await advance(room);
      }
      if (params.get('fresh')) await refreshSkins(room);
      return send(res, 200, await view(room, me));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    const name = cleanName(body.name);
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!name) return send(res, 400, { error: 'Pick a player name first' });
    if (!(await claimPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    if (!(await claimName(playerId, name))) return send(res, 409, { error: 'This name is already taken, pick another one' });

    // Nouvelle salle avec ses règles ; pour une revanche, tous les joueurs y sont déjà et la partie commence aussitôt.
    async function createRoom(r, players) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const [created] = await redis([['HSETNX', roomKey(code), 'host', playerId]]);
        if (Number(created) !== 1) continue;
        const list = players || [await seat(playerId, name)];
        await redis([
          ['HSET', roomKey(code), 'size', players ? list.length : r.size, 'mode', r.mode, 'target', r.target, 'stake', r.stake || 0, 'created', Date.now(),
            'count', list.length, 'started', players ? 1 : 0, 'public', r.isPublic ? 1 : 0, ...list.flatMap(p => [`m:${p.id}`, 1]),
            ...list.filter(p => !p.bot).flatMap(p => [`seen:${p.id}`, Date.now()])],
          ['RPUSH', playersKey(code), ...list.map(p => JSON.stringify(p))],
          ['EXPIRE', roomKey(code), TTL],
          ['EXPIRE', playersKey(code), TTL],
          ...(r.isPublic ? [['ZADD', LIVE_KEY, Date.now(), code]] : []),
          // Mise : chaque joueur déjà assis la paie (séquestre), et un remboursement de secours est programmé.
          ...(r.stake ? list.flatMap(p => [['HINCRBY', statsKey(p.id), 'spent', r.stake], ['HSET', roomKey(code), `paid:${p.id}`, r.stake]]) : []),
          ...(r.stake ? [queueReveal(Date.now() + STAKE_REFUND_MS, { wager: { code, winner: null } })] : []),
        ]);
        return code;
      }
      return null;
    }

    if (body.action === 'create') {
      const bots = Math.min(MAX_PLAYERS - 1, Math.max(0, Math.round(Number(body.bots) || 0)));
      let players = null;
      if (bots) {
        players = [await seat(playerId, name)];
        for (let i = 0; i < bots; i++) players.push(makeBot(players.map(p => p.name)));
      }
      const r = bots ? { ...rules(body), isPublic: false, stake: 0 } : rules(body); // pas de mise contre des bots
      const refused = r.stake ? await stakeRefusal(playerId, r.stake) : null;
      if (refused) return send(res, 422, { error: refused });
      const code = await createRoom(r, players);
      if (!code) return send(res, 503, { error: 'Could not create a duel, try again' });
      return send(res, 200, await view(await load(code), playerId));
    }

    const code = String(body.code || '').trim().toUpperCase();
    let room = isCode(code) ? await load(code) : null;
    if (!room) return send(res, 404, { error: 'No duel with this code' });
    const member = room.players.some(p => p.id === playerId);
    if (body.action !== 'rematch' && (await checkAbandoned(room))) return send(res, 422, { error: 'This duel ended: everyone left' });
    if (member) await touchSeen(room, playerId);

    if (body.action === 'join') {
      if (member) return send(res, 200, await view(room, playerId));
      if (room.started) return send(res, 422, { error: 'This duel has already started' });
      const stake = stakeOf(room);
      const refused = stake ? await stakeRefusal(playerId, stake) : null;
      if (refused) return send(res, 422, { error: refused });
      // Une place à la fois : le marqueur de membre évite les doublons, le compteur évite de dépasser la taille.
      const [isNew] = await redis([['HSETNX', roomKey(code), `m:${playerId}`, 1]]);
      if (Number(isNew) !== 1) return send(res, 200, await view((await load(code)) || room, playerId));
      const [count] = await redis([['HINCRBY', roomKey(code), 'count', 1]]);
      if (Number(count) > room.size) {
        await redis([['HINCRBY', roomKey(code), 'count', -1], ['HDEL', roomKey(code), `m:${playerId}`]]);
        return send(res, 422, { error: 'This duel is full' });
      }
      const writes = [['RPUSH', playersKey(code), JSON.stringify(await seat(playerId, name))], ['HSET', roomKey(code), `seen:${playerId}`, Date.now()], ...touchLive(room)];
      if (stake) writes.push(['HINCRBY', statsKey(playerId), 'spent', stake], ['HSET', roomKey(code), `paid:${playerId}`, stake]); // mise sous séquestre
      if (Number(count) === room.size) writes.push(['HSET', roomKey(code), 'started', 1]); // complet : la partie commence
      await redis(writes);
      return send(res, 200, await view(await load(code), playerId));
    }

    // Entrer dans une partie déjà commencée : le spectateur demande, l'hôte tranche. Accepté, il s'assoit à la suite des
    // autres et joue dès la prochaine manche ; les manches déjà tirées n'ont pas de nombre pour lui (0 victoire, 0 XP).
    if (body.action === 'ask') {
      if (member) return send(res, 200, await view(room, playerId));
      if (!room.started) return send(res, 422, { error: 'This duel has not started: join it instead' });
      if (stakeOf(room)) return send(res, 422, { error: 'This duel has a stake: nobody can join once it has started' });
      if (score(room).done) return send(res, 422, { error: 'This duel is over' });
      if (room.players.length >= MAX_PLAYERS) return send(res, 422, { error: 'This duel is full' });
      if (asksOf(room).length >= 5 && !room.h[`ask:${playerId}`]) return send(res, 429, { error: 'Too many requests for this duel, try again later' });
      await redis([['HSET', roomKey(code), `ask:${playerId}`, JSON.stringify({ name, t: Date.now() })]]);
      return send(res, 200, await view(await load(code), playerId));
    }
    if (body.action === 'accept' || body.action === 'decline') {
      if (room.host !== playerId) return send(res, 422, { error: 'Only the host can answer' });
      const ask = asksOf(room).find(a => a.name === String(body.who || ''));
      if (!ask) return send(res, 404, { error: 'This request is gone' });
      if (body.action === 'decline') {
        await redis([['HDEL', roomKey(code), `ask:${ask.id}`]]);
        return send(res, 200, await view(await load(code), playerId));
      }
      if (score(room).done) return send(res, 422, { error: 'This duel is over' });
      // Une place à la fois, comme pour join : marqueur de membre, puis compteur borné.
      const [isNew] = await redis([['HSETNX', roomKey(code), `m:${ask.id}`, 1]]);
      if (Number(isNew) === 1) {
        const [count] = await redis([['HINCRBY', roomKey(code), 'count', 1]]);
        if (Number(count) > MAX_PLAYERS) {
          await redis([['HINCRBY', roomKey(code), 'count', -1], ['HDEL', roomKey(code), `m:${ask.id}`, `ask:${ask.id}`]]);
          return send(res, 422, { error: 'This duel is full' });
        }
        await redis([
          ['RPUSH', playersKey(code), JSON.stringify(await seat(ask.id, ask.name))],
          ['HSET', roomKey(code), `seen:${ask.id}`, Date.now(), 'size', Number(count)],
          ['HDEL', roomKey(code), `ask:${ask.id}`],
          ...touchLive(room),
        ]);
      }
      return send(res, 200, await view(await load(code), playerId));
    }

    // L'hôte complète une place du salon avec un bot ; salle pleine : la partie commence.
    if (body.action === 'addBot') {
      if (room.host !== playerId) return send(res, 422, { error: 'Only the host can add bots' });
      if (room.started) return send(res, 422, { error: 'This duel has already started' });
      if (stakeOf(room)) return send(res, 422, { error: 'No bots in a duel with a stake' });
      const [count] = await redis([['HINCRBY', roomKey(code), 'count', 1]]);
      if (Number(count) > room.size) {
        await redis([['HINCRBY', roomKey(code), 'count', -1]]);
        return send(res, 422, { error: 'This duel is full' });
      }
      const bot = makeBot(room.players.map(p => p.name));
      const writes = [['RPUSH', playersKey(code), JSON.stringify(bot)], ['HSET', roomKey(code), `m:${bot.id}`, 1], ...touchLive(room)];
      if (Number(count) === room.size) writes.push(['HSET', roomKey(code), 'started', 1]);
      await redis(writes);
      return send(res, 200, await view(await load(code), playerId));
    }

    if (body.action === 'start') {
      if (room.host !== playerId) return send(res, 422, { error: 'Only the host can start the duel' });
      if (room.started) return send(res, 200, await view(room, playerId));
      if (room.players.length < MIN_PLAYERS) return send(res, 422, { error: 'Wait for at least one opponent' });
      // La partie se joue à ceux qui sont là ; la salle se ferme aux nouveaux venus.
      await redis([['HSET', roomKey(code), 'started', 1, 'size', room.players.length], ...touchLive(room)]);
      return send(res, 200, await view(await load(code), playerId));
    }

    if (body.action === 'ready') {
      if (!member) return send(res, 422, { error: 'You are not in this duel' });
      if (!room.started) return send(res, 422, { error: 'The duel has not started yet' });
      if (score(room).done) return send(res, 422, { error: 'This duel is over' });
      const k = room.rounds.length;
      await redis([['HSET', roomKey(code), `ready:${playerId}`, k], ['HSETNX', roomKey(code), `first:${k}`, Date.now()]]);
      room = await advance(await load(code));
      return send(res, 200, await view(room, playerId));
    }

    // Réaction : un emoji de la liste, au plus une toutes les 0,7 s par joueur.
    if (body.action === 'react') {
      if (!member) return send(res, 422, { error: 'You are not in this duel' });
      if (!REACTIONS.includes(body.emoji) && !Shop.emoteById.has(body.emoji)) return send(res, 400, { error: 'Unknown reaction' });
      // Émote spéciale : il faut l'avoir achetée (une lecture de plus, seulement pour celles-là).
      if (Shop.emoteById.has(body.emoji)) {
        const [mine] = await redis([['SISMEMBER', `emotes:${playerId}`, body.emoji]]);
        if (Number(mine) !== 1) return send(res, 403, { error: 'Buy this emote first' });
      }
      const [ok] = await redis([['SET', `react:${playerId}`, '1', 'PX', REACT_EVERY_MS, 'NX']]);
      if (ok !== 'OK') return send(res, 429, { error: 'Too many reactions' });
      const i = room.players.findIndex(p => p.id === playerId);
      const reaction = { t: Date.now(), i, e: body.emoji };
      await redis([['RPUSH', reactsKey(code), JSON.stringify(reaction)], ['LTRIM', reactsKey(code), -30, -1], ['EXPIRE', reactsKey(code), TTL]]);
      room.reacts.push(reaction);
      return send(res, 200, await view(room, playerId));
    }

    // Revanche : une seule nouvelle salle par partie, mêmes joueurs et mêmes règles.
    if (body.action === 'rematch') {
      if (!member) return send(res, 422, { error: 'You are not in this duel' });
      if (!score(room).done) return send(res, 422, { error: 'This duel is not over yet' });
      let next = room.h.next || null;
      if (!next) {
        let stake = stakeOf(room);
        if (stake) {
          const coins = await Promise.all(room.players.map(p => coinsOf(p.id)));
          if (coins.some(c => c < stake)) stake = 0; // quelqu'un ne peut plus suivre : revanche sans mise
        }
        const code2 = await createRoom({ size: room.players.length, mode: room.mode, target: room.target, stake, isPublic: room.h.public === '1' }, room.players);
        if (!code2) return send(res, 503, { error: 'Could not create a duel, try again' });
        const [won] = await redis([['HSETNX', roomKey(code), 'next', code2]]);
        if (Number(won) === 1) {
          next = code2;
          await redis([['HSET', roomKey(code), 'nextBy', name]]);
        } else {
          await settleWager(code2, null); // la salle en double rend les mises avant de disparaître
          await redis([['DEL', roomKey(code2), playersKey(code2)]]);
          [next] = await redis([['HGET', roomKey(code), 'next']]);
        }
      }
      return send(res, 200, await view(await load(next), playerId));
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
