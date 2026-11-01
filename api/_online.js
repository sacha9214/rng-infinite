// Joueurs en ligne (idée de Thermonuclear Bomb, 2026-11-01 ; aussi Jguz01 et KMC) : combien de joueurs sont là en ce
// moment, montré sur l'écran de tirage et dans le chat global. Pas une fonction Vercel (nom en « _ ») : lu depuis
// api/leaderboard.js (GET ?online=1) et api/_global.js (réponse de gcList).
// En ligne = un signe de vie depuis moins de 150 s, comme « Online » dans la liste d'amis (api/friends.js) : la page
// ouverte et active (le signal « active » envoyé chaque minute avec la relève des cadeaux, gardé aussi dans le zset
// presz : heure → joueur, pour compter sans relire tout le hash presence), ou un tirage (zset seen, écrit par
// recordRoll). Un onglet caché ou sans action depuis 5 min (« afk ») ne compte pas, sauf s'il tire (tirage auto).
// Le compte est calculé au plus une fois toutes les 30 s par processus : un nombre, jamais qui.
const { redis, SEEN_KEY } = require('./_lib');

const PRES_Z = 'presz', ONLINE_MS = 150000, CACHE_MS = 30000;
// Sous ce nombre, le site n'affiche rien (une salle vide aux heures creuses fait fuir, remarque de KMC).
const SHOW_MIN = 5;
let cache = { at: 0, n: 0 }, busy = null;

// Écritures à ajouter au signal de présence d'un joueur : « active » l'inscrit, « afk » l'enlève.
const presenceWrites = (id, state, now = Date.now()) => (state === 'active' ? [['ZADD', PRES_Z, now, id]] : [['ZREM', PRES_Z, id]]);

async function compute(now) {
  const from = now - ONLINE_MS;
  // Les entrées trop vieilles sont retirées au passage : le zset ne garde que les 150 dernières secondes.
  const [, active, rolled] = await redis([
    ['ZREMRANGEBYSCORE', PRES_Z, '-inf', from - 1],
    ['ZRANGEBYSCORE', PRES_Z, from, '+inf'],
    ['ZRANGEBYSCORE', SEEN_KEY, from, '+inf'],
  ]);
  return new Set([...(active || []), ...(rolled || [])]).size;
}

async function count(now = Date.now()) {
  if (now - cache.at < CACHE_MS) return cache.n;
  if (!busy) busy = compute(now).then(n => { cache = { at: now, n }; return n; }).finally(() => { busy = null; });
  return busy;
}

// Ce qui part vers le site : le nombre seulement s'il atteint SHOW_MIN, sinon null (rien d'affiché).
async function shown(now = Date.now()) {
  try { const n = await count(now); return n >= SHOW_MIN ? n : null; } catch (e) { return null; }
}

module.exports = { count, shown, presenceWrites, PRES_Z, ONLINE_MS, CACHE_MS, SHOW_MIN, _reset() { cache = { at: 0, n: 0 }; busy = null; } };
