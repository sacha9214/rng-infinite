// Hall of Fame (idée d'Avaneesh_17, 2026-11-02 : « the first person to roll each of the infinite numbers and the first to
// reach 1 billion xp ») : les premiers joueurs à atteindre les grands paliers du jeu, gardés pour toujours.
// Un seul hash « hof », un champ par palier, posé une fois (HSETNX) par le tirage qui l'atteint :
//   inf:<n>        premier à tirer le nombre Infinite n (mode normal)
//   h:<rareté>     premier tirage Mythic, Celestial, Divine, Godlike, Infinite du mode difficile
//   xp:<palier>    premier à 100 M, 1 G, 10 G, 100 G d'XP à vie (stats.xpLife, commune aux deux modes)
//   rolls:<palier> premier à 10 000, 100 000, 1 000 000 tirages (mode normal, stats.rolls)
// Valeur : { id, t } (+ n pour un tirage, + approx quand le rattrapage ne connaît qu'une date au plus tard). L'id ne sort
// jamais d'ici : la page reçoit le pseudo. Rattrapage des paliers d'avant ce hash : tools/backfill-hof.js (Sacha).
const { redis, engine } = require('./_lib');

const HOF = 'hof';
// Posés par les rattrapages (--apply) : avant, la page et le compteur ne montrent rien, sinon le premier à tirer 777777
// après le déploiement passerait pour le premier de tous, et chaque badge semblerait n'avoir presque aucun propriétaire.
const HOF_READY = 'hof:ready', OWNERS_READY = 'bown:ready';
// Les nombres Infinite du mode normal : les chercher prend ~45 s (1 000 001 analyses), ils sont donc écrits ici et
// revérifiés au chargement (un badge changé peut en retirer un). Un nouveau nombre Infinite tiré s'ajoute de lui-même à la
// page (son champ inf:<n> est posé par recordRoll d'après la rareté du moteur). Liste à refaire après un changement de
// badges : node -e "const e=require('./api/_lib').engine;for(let n=0;n<=1e6;n++)if(e.analyze(n).tier==='infinite')console.log(n)"
const INFINITE = [0, 1, 2, 4, 5, 7, 24, 666666, 777777, 1000000].filter(n => engine.analyze(n).tier === 'infinite');
const HARD_TIERS = ['mythic', 'celestial', 'divine', 'godlike', 'infinite'];
const XP_MARKS = [1e8, 1e9, 1e10, 1e11];
const ROLL_MARKS = [10000, 100000, 1000000];

// Commandes à ajouter au tirage (api/_lib.js recordRoll / recordHardRoll). stats : les stats relues après ce tirage.
// HSETNX : le premier arrivé garde sa place, même si deux tirages se croisent.
function rollWrites({ playerId, n, t, tier, s, stats, hard = false }) {
  const w = [], put = (field, extra = {}) => w.push(['HSETNX', HOF, field, JSON.stringify({ id: playerId, t, ...extra })]);
  if (hard ? HARD_TIERS.includes(tier) : tier === 'infinite') put(hard ? `h:${tier}` : `inf:${n}`, { n });
  const xp = Number(stats.xpLife) || 0;
  for (const m of XP_MARKS) if (xp >= m && xp - s < m) put(`xp:${m}`);
  const rolls = Number(stats.rolls) || 0;
  if (!hard && ROLL_MARKS.includes(rolls)) put(`rolls:${rolls}`);
  return w;
}

// La page (GET /api/leaderboard?hof=1) : chaque palier avec le pseudo, l'heure, ou null s'il n'est pas encore atteint.
// Gardée une minute en mémoire : la page est publique et le hash change rarement.
let cache = { at: 0, data: null };
async function view(now = Date.now()) {
  if (cache.data && now - cache.at < 60000) return cache.data;
  const [flat, ready] = await redis([['HGETALL', HOF], ['GET', HOF_READY]]), raw = {};
  if (!ready) { cache = { at: now, data: { ready: false } }; return cache.data; }
  for (let i = 0; i < (flat || []).length; i += 2) { try { raw[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* champ abîmé : ignoré */ } }
  const ids = [...new Set(Object.values(raw).map(x => x.id).filter(Boolean))];
  const names = ids.length ? (await redis([['HMGET', 'names', ...ids]]))[0] : [];
  const nameOf = new Map(ids.map((id, i) => [id, names[i]]));
  const who = field => { const x = raw[field]; return x ? { name: nameOf.get(x.id) || 'Player', t: Number(x.t) || null, ...(x.approx ? { approx: 1 } : {}) } : null; };
  // nombres Infinite : la liste connue, plus ceux devenus Infinite depuis (posés par un tirage)
  const extra = Object.keys(raw).filter(f => /^inf:\d+$/.test(f)).map(f => Number(f.slice(4))).filter(n => !INFINITE.includes(n) && engine.analyze(n).tier === 'infinite');
  const data = {
    ready: true,
    infinite: [...INFINITE, ...extra].sort((a, b) => a - b).map(n => ({ n, first: who(`inf:${n}`) })),
    xp: XP_MARKS.map(m => ({ m, first: who(`xp:${m}`) })),
    rolls: ROLL_MARKS.map(m => ({ m, first: who(`rolls:${m}`) })),
    hard: HARD_TIERS.map(tier => { const x = raw[`h:${tier}`]; return { tier, first: who(`h:${tier}`), n: x && Number.isFinite(Number(x.n)) ? Number(x.n) : null }; }),
  };
  cache = { at: now, data };
  return data;
}
const clearCache = () => { cache = { at: 0, data: null }; };

// Propriétaires de chaque badge (idée de Tumored, 2026-10-31), lus dans « bown » (normal) ou « hbown » (difficile),
// gardés une minute. players : joueurs qui ont au moins un badge (le « sur combien »), lu sur le classement à vie.
let ownersCache = {};
async function badgeOwners(hard = false, now = Date.now()) {
  const c = ownersCache[hard ? 'h' : 'n'];
  if (c && now - c.at < 60000) return c.data;
  const L = require('./_lib');
  const [flat, players, ready] = await redis([['HGETALL', hard ? L.hardKey(L.BADGE_OWNERS) : L.BADGE_OWNERS], ['ZCARD', hard ? 'hlb:all' : 'lb:all'], ['GET', OWNERS_READY]]);
  const counts = {};
  for (let i = 0; i < (flat || []).length; i += 2) { const k = Number(flat[i + 1]) || 0; if (k > 0) counts[flat[i]] = k; }
  const data = ready ? { ready: true, counts, players: Number(players) || 0 } : { ready: false };
  ownersCache[hard ? 'h' : 'n'] = { at: now, data };
  return data;
}
const clearOwnersCache = () => { ownersCache = {}; };

module.exports = { HOF, HOF_READY, OWNERS_READY, INFINITE, HARD_TIERS, XP_MARKS, ROLL_MARKS, rollWrites, view, clearCache, badgeOwners, clearOwnersCache };
