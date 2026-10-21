// Tournoi du jour (idée de PRISMA123, 2026-10-20) : un tableau à élimination directe, joué en différé (les joueurs ne
// sont pas en ligne au même moment). Atteint par /api/room (action 'tourney', voir plus bas) : api/ est déjà à 12
// fonctions, la limite de Vercel.
//
// Règles (heures UTC) :
//   - un tournoi par jour, identifié par la date ; inscriptions gratuites de 00:00 à 12:00, 30 tirages minimum (comme
//     le casino, contre les comptes secondaires), 32 places au plus, dans l'ordre d'inscription ;
//   - à 12:00 le tableau est tiré au sort : taille = la plus petite puissance de deux ≥ inscrits (4, 8, 16 ou 32) ; les
//     places en trop sont des exempts (bye), au plus un par match, donc un exempt ne croise jamais un autre exempt ;
//     moins de 4 inscrits : tournoi annulé ;
//   - les tours se partagent 12:00 → 24:00 à parts égales (4 joueurs : 2 tours de 6 h ; 8 : 4 h ; 16 : 3 h ; 32 : 2 h 24) ;
//   - dans un match, chacun fait 5 tirages de tournoi (tirés par le serveur, même moteur que les tirages normaux, mais
//     qui ne comptent nulle part : ni XP, ni classement, ni quêtes, ni pièces). Plus gros total d'XP gagne ; égalité :
//     plus gros tirage ; encore égalité : le premier à avoir fini. Celui qui n'a pas fini ses 5 tirages à la fin du tour
//     perd ; si aucun des deux n'a fini, le plus de tirages faits gagne, puis un tirage au sort (fixé par le jour, le
//     tour et les deux joueurs, donc le même pour tout le monde) ;
//   - les tours avancent quand quelqu'un lit le tournoi (sûr sur Vercel comme sur le VPS), et par le tic toutes les
//     10 minutes du VPS (api/_discord_tasks.js) ;
//   - prix, versés une seule fois (HSETNX 'paid') : vainqueur 1 000 pièces + une victoire de tournoi (succès et titre
//     Champion), finaliste 400, demi-finalistes 150.
const crypto = require('node:crypto');
const { redis, engine, eco, readStats, statsKey, toObject, ownsPlayer, dayKey } = require('./_lib');
const Discord = require('./_discord');

const MIN_ROLLS = 30, MIN_PLAYERS = 4, MAX_PLAYERS = 32, ROLLS = 5;
const SIGNUP_MS = 12 * 3600000, DAY_MS = 24 * 3600000;
const LAST_CALL_MS = 5000; // les 5 dernières secondes d'un tour, plus de tirage : le résultat ne bouge plus
const COOLDOWN_MS = 1500; // entre deux tirages de tournoi (le temps de la révélation à l'écran)
const PRIZES = { champion: 1000, finalist: 400, semi: 150 };
const TTL = 14 * 86400;

const key = day => `tn:${day}`, inKey = day => `tn:${day}:in`, rollsKey = day => `tn:${day}:rolls`;
const refuse = (status, error) => Object.assign(new Error(error), { status });

function times(day, size) {
  const open = Date.parse(`${day}T00:00:00Z`), close = open + SIGNUP_MS, end = open + DAY_MS;
  const rounds = size ? Math.log2(size) : 0, len = rounds ? (end - close) / rounds : 0;
  return { open, close, end, rounds, start: r => close + r * len, stop: r => close + (r + 1) * len };
}

// Mélange de Fisher-Yates avec le hasard du serveur.
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Places du premier tour : les b premiers matchs ont un exempt (null), les autres deux joueurs.
function seed(ids) {
  let size = MIN_PLAYERS;
  while (size < ids.length) size *= 2;
  const byes = size - ids.length, p = shuffle(ids), slots = [];
  let k = 0;
  for (let m = 0; m < size / 2; m++) {
    slots.push(p[k++]);
    slots.push(m < byes ? null : p[k++]);
  }
  return slots;
}

const coin = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest()[0] & 1;
const doneOf = x => !!x && x.s.length >= ROLLS;
const sum = x => (x ? x.s.reduce((a, b) => a + b, 0) : 0);
const top = x => (x && x.s.length ? Math.max(...x.s) : 0);

// Vainqueur d'un match (a et b : identifiants ou null pour un exempt ; ra, rb : leurs tirages { n, s, t }).
function winner(day, r, a, b, ra, rb) {
  if (!a || !b) return a || b || null;
  const da = doneOf(ra), db = doneOf(rb);
  if (da && db) {
    if (sum(ra) !== sum(rb)) return sum(ra) > sum(rb) ? a : b;
    if (top(ra) !== top(rb)) return top(ra) > top(rb) ? a : b;
    if (ra.t !== rb.t) return ra.t < rb.t ? a : b;
  } else if (da || db) return da ? a : b;
  else {
    const ca = ra ? ra.s.length : 0, cb = rb ? rb.s.length : 0;
    if (ca !== cb) return ca > cb ? a : b;
  }
  return coin(day, r, a, b) ? a : b;
}

async function load(day) {
  const [flat, ins, rflat] = await redis([['HGETALL', key(day)], ['ZRANGE', inKey(day), 0, -1], ['HGETALL', rollsKey(day)]]);
  const h = toObject(flat), raw = toObject(rflat), rolls = {};
  for (const [k, v] of Object.entries(raw)) rolls[k] = JSON.parse(v);
  return { day, h, ins: ins || [], rolls, slots: h.slots ? JSON.parse(h.slots) : null };
}

// Joueurs du tour r (dans l'ordre du tableau), ou null si le tour d'avant n'est pas encore tranché.
function playersOf(t, r) {
  if (!t.slots) return null;
  if (r === 0) return t.slots;
  return t.h[`w:${r - 1}`] ? JSON.parse(t.h[`w:${r - 1}`]) : null;
}

// Fait avancer le tournoi jusqu'à `now` : tirage du tableau, tours échus, prix. Sans danger si plusieurs requêtes le
// font en même temps : chaque étape est écrite avec HSETNX et le résultat d'un tour ne dépend que des tirages.
async function advance(day, now = Date.now()) {
  let t = await load(day);
  const base = times(day, 0);
  if (now < base.close) return t;
  if (!t.h.slots) {
    const ids = t.ins.slice(0, MAX_PLAYERS), cancelled = ids.length < MIN_PLAYERS;
    await redis([['HSETNX', key(day), 'slots', JSON.stringify(cancelled ? [] : seed(ids))], ['EXPIRE', key(day), TTL]]);
    t = await load(day);
  }
  if (!t.slots.length) return t; // annulé
  const tm = times(day, t.slots.length);
  for (let r = 0; r < tm.rounds; r++) {
    if (t.h[`w:${r}`]) continue;
    if (now < tm.stop(r)) break;
    const p = playersOf(t, r), w = [];
    for (let i = 0; i < p.length; i += 2) w.push(winner(day, r, p[i], p[i + 1], t.rolls[`${r}:${p[i]}`], t.rolls[`${r}:${p[i + 1]}`]));
    await redis([['HSETNX', key(day), `w:${r}`, JSON.stringify(w)]]);
    t = await load(day);
  }
  if (t.h[`w:${tm.rounds - 1}`] && !t.h.paid) { await payout(t, now); t = await load(day); }
  return t;
}

// Classement final : champion, finaliste, demi-finalistes (perdants du tour d'avant la finale).
function podium(t) {
  const R = Math.log2(t.slots.length), champion = JSON.parse(t.h[`w:${R - 1}`])[0];
  const final = playersOf(t, R - 1), finalist = final.find(id => id && id !== champion) || null;
  const semis = R >= 2 ? playersOf(t, R - 2).filter(id => id && !final.includes(id)) : [];
  return { champion, finalist, semis };
}

async function payout(t, now) {
  const [first] = await redis([['HSETNX', key(t.day), 'paid', now]]);
  if (Number(first) !== 1) return false;
  const { champion, finalist, semis } = podium(t);
  const gifts = [[champion, PRIZES.champion], [finalist, PRIZES.finalist], ...semis.map(id => [id, PRIZES.semi])].filter(([id]) => id);
  const total = gifts.reduce((x, [, v]) => x + v, 0);
  await redis([...gifts.map(([id, v]) => ['HINCRBY', statsKey(id), 'bonus', v]), ['HINCRBY', statsKey(champion), 'tourneyWins', 1], ...eco('in:tourney', total, now)]);
  if (finalist) redis([['HMGET', 'names', champion, finalist]]).then(([names]) => Discord.announceTournament({ day: t.day, champion: names[0] || 'Player', finalist: names[1] || 'Player', players: t.slots.filter(Boolean).length })).catch(() => {});
  return true;
}

// Tour en cours à `now` (index), ou -1.
function currentRound(t, now) {
  if (!t.slots || !t.slots.length) return -1;
  const tm = times(t.day, t.slots.length);
  for (let r = 0; r < tm.rounds; r++) if (now >= tm.start(r) && now < tm.stop(r)) return r;
  return -1;
}

async function signup(playerId, now = Date.now()) {
  const day = dayKey(now), tm = times(day, 0);
  if (now >= tm.close) throw refuse(422, 'Sign-ups for today\'s tournament are closed (they open at 00:00 UTC)');
  const st = await readStats(playerId), rolls = Number(st.rolls) || 0;
  if (rolls < MIN_ROLLS) throw refuse(422, `Tournaments unlock after ${MIN_ROLLS} rolls (you have ${rolls})`);
  const [added] = await redis([['ZADD', inKey(day), 'NX', now, playerId], ['EXPIRE', inKey(day), TTL]]);
  if (Number(added) !== 1) throw refuse(409, 'You are already signed up');
  const [rank] = await redis([['ZRANK', inKey(day), playerId]]);
  if (Number(rank) >= MAX_PLAYERS) {
    await redis([['ZREM', inKey(day), playerId]]);
    throw refuse(422, `Today's tournament is full (${MAX_PLAYERS} players)`);
  }
  return { ok: true, place: Number(rank) + 1 };
}

// Un tirage de tournoi : tiré par le serveur et gardé dans le tournoi seulement.
async function roll(playerId, now = Date.now()) {
  const day = dayKey(now), t = await advance(day, now), r = currentRound(t, now);
  if (r < 0) throw refuse(422, 'No tournament round is being played right now');
  const p = playersOf(t, r) || [], i = p.indexOf(playerId);
  if (i < 0) throw refuse(422, 'You have no match in this round');
  if (!p[i ^ 1]) throw refuse(422, 'You have a bye this round: you go through without playing');
  if (now >= times(day, t.slots.length).stop(r) - LAST_CALL_MS) throw refuse(422, 'This round is over');
  const field = `${r}:${playerId}`;
  const done = raw => raw && JSON.parse(raw).s.length >= ROLLS;
  if (done(t.rolls[field] && JSON.stringify(t.rolls[field]))) throw refuse(409, `You already made your ${ROLLS} rolls`);
  // Le verrou sert aussi de délai : deux tirages du même joueur ne se croisent jamais (lecture puis écriture).
  const [lock] = await redis([['SET', `tnlock:${playerId}`, '1', 'PX', COOLDOWN_MS, 'NX']]);
  if (lock !== 'OK') throw refuse(429, 'Too fast, wait for the reveal to finish');
  const [raw] = await redis([['HGET', rollsKey(day), field]]);
  if (done(raw)) throw refuse(409, `You already made your ${ROLLS} rolls`);
  const mine = raw ? JSON.parse(raw) : { n: [], s: [] };
  const n = crypto.randomInt(0, 1000001), s = engine.analyze(n).total;
  mine.n.push(n); mine.s.push(s);
  if (mine.s.length === ROLLS) mine.t = now;
  await redis([['HSET', rollsKey(day), field, JSON.stringify(mine)], ['EXPIRE', rollsKey(day), TTL]]);
  return { n, s, count: mine.s.length, total: sum(mine) };
}

// État du tournoi d'un jour, tel que le voit `me` (null : public). Les tirages d'un match du tour en cours restent
// cachés à tout le monde tant que les deux joueurs n'ont pas fini (sinon on « snipe » l'adversaire) ; un joueur voit
// toujours les siens, et ceux de son adversaire une fois ses 5 tirages faits.
async function view(day, me, now = Date.now()) {
  const t = await advance(day, now), base = times(day, 0);
  const size = t.slots ? t.slots.length : 0, tm = times(day, size), cur = currentRound(t, now);
  const ids = new Set(t.ins.slice(0, MAX_PLAYERS));
  (t.slots || []).forEach(id => id && ids.add(id));
  const list = [...ids];
  const [names] = list.length ? await redis([['HMGET', 'names', ...list]]) : [[]];
  const nameOf = Object.fromEntries(list.map((id, i) => [id, names[i] || 'Player']));
  const phase = now < base.close ? 'signup' : !size ? 'cancelled' : t.h.paid ? 'done' : 'running';
  // Les identifiants ne sortent jamais du serveur : chaque joueur devient un jeton opaque propre au tournoi du jour,
  // et « me » signale sa propre ligne.
  const tok = id => (id ? require('node:crypto').createHash('sha256').update(`tn:${day}:${id}`).digest('hex').slice(0, 12) : id);
  const side = (r, id, reveal) => {
    if (!id) return null;
    const x = t.rolls[`${r}:${id}`], o = { id: tok(id), me: !!me && id === me, name: nameOf[id], count: x ? x.s.length : 0 };
    if (reveal && x) Object.assign(o, { total: sum(x), best: top(x), rolls: x.n });
    return o;
  };
  const rounds = [];
  for (let r = 0; r < tm.rounds; r++) {
    const p = playersOf(t, r), w = t.h[`w:${r}`] ? JSON.parse(t.h[`w:${r}`]) : null, matches = [];
    const n = size / 2 ** (r + 1);
    for (let m = 0; m < n; m++) {
      const a = p ? p[2 * m] : undefined, b = p ? p[2 * m + 1] : undefined;
      const both = p && doneOf(t.rolls[`${r}:${a}`]) && doneOf(t.rolls[`${r}:${b}`]);
      const reveal = !!w || !!both;
      matches.push({ a: p ? side(r, a, reveal) : undefined, b: p ? side(r, b, reveal) : undefined, bye: !!p && (!a || !b), w: w ? tok(w[m]) : null });
    }
    rounds.push({ start: tm.start(r), end: tm.stop(r), matches });
  }
  const out = {
    day, now, phase, open: base.open, close: base.close, end: base.end, size, round: cur, rolls: ROLLS, minRolls: MIN_ROLLS, max: MAX_PLAYERS, minPlayers: MIN_PLAYERS, prizes: PRIZES,
    count: Math.min(t.ins.length, MAX_PLAYERS), entrants: t.ins.slice(0, MAX_PLAYERS).map(id => ({ id: tok(id), me: !!me && id === me, name: nameOf[id] })), joined: !!me && ids.has(me), rounds,
  };
  if (phase === 'done') { const pd = podium(t); out.result = { champion: side(0, pd.champion, false), finalist: side(0, pd.finalist, false), semis: pd.semis.map(id => side(0, id, false)) }; }
  if (me && ids.has(me) && size) {
    // Dernier tour où ce joueur apparaît : son match en cours, ou celui où il a été éliminé.
    let r = -1;
    for (let k = 0; k < tm.rounds; k++) if ((playersOf(t, k) || []).includes(me)) r = k;
    if (r >= 0) {
      const p = playersOf(t, r), i = p.indexOf(me), opp = p[i ^ 1], w = t.h[`w:${r}`] ? JSON.parse(t.h[`w:${r}`])[i >> 1] : null;
      const mine = t.rolls[`${r}:${me}`] || { n: [], s: [] }, theirs = t.rolls[`${r}:${opp}`];
      const showOpp = !!w || doneOf(mine) || r < cur;
      out.match = {
        round: r, live: r === cur && !w, start: tm.start(r), end: tm.stop(r), bye: !opp, result: w ? (w === me ? 'won' : 'lost') : null,
        me: { rolls: mine.n, scores: mine.s, total: sum(mine), count: mine.s.length },
        opp: opp ? { id: tok(opp), name: nameOf[opp], count: theirs ? theirs.s.length : 0, ...(showOpp && theirs ? { rolls: theirs.n, scores: theirs.s, total: sum(theirs) } : {}) } : null,
      };
    }
  }
  return out;
}

// Tournoi d'hier (terminé à minuit) et d'aujourd'hui : appelé par le tic du VPS pour verser les prix sans attendre.
async function tick(now = Date.now()) {
  await advance(dayKey(now - DAY_MS), now);
  await advance(dayKey(now), now);
}

// Point d'entrée depuis /api/room : { action: 'tourney', op: 'view' | 'join' | 'roll', playerId?, secret?, day? }.
// La vue sans identifiant (ou avec un mauvais secret) est la vue publique.
async function handle(body, now = Date.now()) {
  const op = String(body.op || 'view'), playerId = String(body.playerId || ''), secret = String(body.secret || '');
  const valid = /^[0-9a-f]{16}$/.test(playerId) && /^[0-9a-f]{32}$/.test(secret);
  const me = valid && (await ownsPlayer(playerId, secret)) ? playerId : null;
  const today = dayKey(now), yesterday = dayKey(now - DAY_MS);
  if (op === 'view') {
    const day = body.day === 'prev' ? yesterday : today;
    const out = await view(day, me, now);
    if (day === today) {
      // Hier se termine à minuit : on le fait avancer (prix compris) et on rappelle son champion.
      const prev = await advance(yesterday, now);
      if (prev.h.paid) { const pd = podium(prev), [names] = await redis([['HMGET', 'names', pd.champion]]); out.prev = { day: yesterday, champion: names[0] || 'Player' }; }
    }
    return out;
  }
  if (!me) throw refuse(valid ? 403 : 400, valid ? 'This player id belongs to someone else' : 'Invalid player');
  if (op === 'join') { await signup(me, now); return view(today, me, now); }
  if (op === 'roll') { const r = await roll(me, now); return { ...r, state: await view(today, me, now) }; }
  throw refuse(400, 'Unknown tournament action');
}

module.exports = { handle, view, advance, signup, roll, tick, seed, winner, times, PRIZES, MIN_ROLLS, ROLLS, MAX_PLAYERS };
