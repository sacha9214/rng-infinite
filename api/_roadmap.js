// Feuille de route publique (idée de Phong67, 2026-10-26) : page #/roadmap, routée depuis /api/site (action roadmap).
// Deux listes tirées de la boîte à idées : « Planned » (statut planned, toutes : 500 au plus) et « Recently added » (statut
// done depuis 30 jours, 50 au plus). Sacha, 2026-11-05 : avec 50 Planned au plus, le tri du jour (68 idées prévues) avait
// caché les 84 plus anciennes, déjà promises. Seulement des idées (jamais les bugs), jamais les refusées, jamais d'identifiant : le pseudo du joueur et
// un extrait court du texte, passé au filtre du chat global (une idée qui ne le passe pas n'est pas montrée).
// Gardée 5 minutes en mémoire : la page est publique et la boîte compte des milliers de suggestions.
//
// Votes (idée de Trinity, 2026-11-05) : un joueur avec un pseudo et 100 tirages vote pour les idées prévues qu'il veut
// voir arriver d'abord (un vote par idée, retirable). Chaque idée sort avec une clé opaque (empreinte de son id, jamais
// l'id) ; rmv (hash : id → nombre de votes), rmv:<id> (qui a voté), rmv:by:<joueur> (ses votes). Les nombres sont lus
// à chaque demande, hors du cache.
const crypto = require('node:crypto');
const { redis } = require('./_lib');
const { checkMessage, MIN_ROLLS } = require('./_global');

const CACHE_MS = 5 * 60 * 1000, RECENT_DAYS = 30, MAX_ITEMS = 50, MAX_PLANNED = 500, SNIPPET = 120, SCAN_MAX = 5000;
let cache = null, byKey = new Map();
const keyOf = id => crypto.createHash('sha256').update(`rm:${id}`).digest('hex').slice(0, 12);
const VOTES = 'rmv', votersKey = id => `rmv:${id}`, mineKey = pid => `rmv:by:${pid}`;

// Premier ~120 caractères, coupé à un espace, sur une ligne.
function snippet(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (one.length <= SNIPPET) return one;
  const cut = one.slice(0, SNIPPET), sp = cut.lastIndexOf(' ');
  return `${(sp > 60 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}
function safe(text) { try { return checkMessage(snippet(text)); } catch (e) { return ''; } }

async function build(now) {
  const [ids] = await redis([['ZREVRANGE', 'sugg:all', 0, SCAN_MAX - 1]]);
  const FIELDS = ['kind', 'status', 'text', 'name', 't', 'doneAt', 'ownerAt'];
  const rows = [];
  for (let i = 0; i < (ids || []).length; i += 500) rows.push(...(await redis(ids.slice(i, i + 500).map(id => ['HMGET', `sugg:${id}`, ...FIELDS]))));
  const planned = [], recent = [], since = now - RECENT_DAYS * 86400000, keys = new Map();
  for (const [i, r] of rows.entries()) {
    const [kind, status, text, name, t, doneAt, ownerAt] = r || [];
    if (kind === 'bug' || !text || (status !== 'planned' && status !== 'done')) continue;
    // « Ajoutée le » : doneAt (noté depuis le 2026-10-26), sinon la dernière réponse du créateur, sinon l'envoi.
    const when = Number(status === 'done' ? doneAt || ownerAt || t : t) || 0;
    if (status === 'done' && when < since) continue;
    const list = status === 'planned' ? planned : recent;
    if (list.length >= (list === planned ? MAX_PLANNED : MAX_ITEMS)) continue;
    const clean = safe(text);
    if (!clean) continue;
    const item = { name: String(name || 'Player').slice(0, 20), text: clean, t: when };
    if (list === planned) { item.key = keyOf(ids[i]); keys.set(item.key, ids[i]); }
    list.push(item);
  }
  recent.sort((a, b) => b.t - a.t);
  return { data: { planned, recent, at: now }, keys };
}

async function cached(now) {
  if (cache && now - cache.at < CACHE_MS) return cache;
  const b = await build(now);
  cache = b.data; byKey = b.keys;
  return cache;
}
// Votes du moment de chaque idée prévue, et (joueur connu) les clés de celles pour qui il a voté.
async function votesOf(me) {
  const ids = [...byKey.values()], keys = [...byKey.keys()];
  const [counts] = ids.length ? await redis([['HMGET', VOTES, ...ids]]) : [[]];
  const [mine] = me ? await redis([['SMEMBERS', mineKey(me)]]) : [[]];
  const votes = {};
  keys.forEach((k, i) => { const n = Number((counts || [])[i]) || 0; if (n > 0) votes[k] = n; });
  const myIds = new Set(mine || []);
  return { votes, mine: keys.filter((k, i) => myIds.has(ids[i])) };
}
async function roadmap(now = Date.now(), me = null) {
  const data = await cached(now);
  return { ...data, ...(await votesOf(me)), canVote: !!me };
}
// Voter (on = true) ou retirer son vote (on = false) pour une idée encore prévue.
async function vote(me, stats, key, on, now = Date.now()) {
  const refuse = (status, error) => Object.assign(new Error(error), { status });
  const [name] = await redis([['HGET', 'names', me]]);
  if (!name) throw refuse(403, 'Pick a player name first');
  if ((Number(stats.rolls) || 0) < MIN_ROLLS) throw refuse(403, `Make ${MIN_ROLLS} rolls to vote for ideas`);
  await cached(now);
  const id = byKey.get(String(key || ''));
  if (!id) throw refuse(404, 'This idea is not planned anymore');
  const [ok] = await redis([['SET', `rmv:rl:${me}`, '1', 'PX', '400', 'NX']]);
  if (ok !== 'OK') throw refuse(429, 'Slow down a little');
  const [changed] = await redis([[on ? 'SADD' : 'SREM', votersKey(id), me]]);
  if (Number(changed) === 1) await redis([['HINCRBY', VOTES, id, on ? 1 : -1], [on ? 'SADD' : 'SREM', mineKey(me), id]]);
  return roadmap(now, me);
}

module.exports = { roadmap, vote, snippet, reset: () => { cache = null; byKey = new Map(); } };
