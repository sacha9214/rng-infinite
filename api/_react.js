// Réactions emoji sur les messages (demandé par Sacha, 2026-11-02 : « réagir avec un emoji comme sur WhatsApp ») :
// chat global, messages entre amis, chat des duels et chat du clan. Pas une fonction Vercel (nom en « _ »).
// - 6 emojis fixes (choix de Sacha) : rien de grossier possible, aucun texte libre.
// - Comme WhatsApp : une réaction par joueur et par message ; en choisir une autre la remplace, toucher la sienne l'enlève.
// - Rangement : un hash par chat (rx:gc, rx:<clé du fil privé>, room:<code>:rx, clanrx:<cid>), champ « <message>|<joueur> »
//   = numéro de l'emoji. Un champ par joueur : deux joueurs qui réagissent en même temps ne s'écrasent pas.
//   Les réactions des messages sortis du chat sont retirées à la réaction suivante (prune) ; le hash expire avec le chat.
// - Ce qui sort : par message, [{ e, n, mine, who }] ; who = les pseudos (8 au plus), jamais un identifiant de joueur.
const { redis } = require('./_lib');

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const WHO_MAX = 8, GAP_MS = 300;
const refuse = (status, error) => Object.assign(new Error(error), { status });

// Lecture brute (HGETALL) → Map message → Map joueur → numéro d'emoji.
function group(flat) {
  const out = new Map();
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const f = String(flat[i]), cut = f.lastIndexOf('|'), idx = Number(flat[i + 1]);
    if (cut < 0 || !EMOJIS[idx]) continue;
    const msg = f.slice(0, cut);
    if (!out.has(msg)) out.set(msg, new Map());
    out.get(msg).set(f.slice(cut + 1), idx);
  }
  return out;
}

// Map message → [{ e, n, mine, who }] (emojis dans l'ordre de la liste), pour les messages encore là.
async function views(flat, me, live = null) {
  const g = group(flat);
  const ids = [...new Set([...g.values()].flatMap(m => [...m.keys()]))].filter(id => /^[0-9a-f]{16}$/.test(id));
  const [names] = ids.length ? await redis([['HMGET', 'names', ...ids]]) : [[]];
  const nameOf = new Map(ids.map((id, i) => [id, (names || [])[i] || 'Player']));
  const out = new Map();
  for (const [msg, by] of g) {
    if (live && !live.has(msg)) continue;
    const list = EMOJIS.map((e, k) => {
      const who = [...by].filter(([, x]) => x === k).map(([id]) => id);
      return who.length ? { e, n: who.length, mine: who.includes(me), who: who.slice(0, WHO_MAX).map(id => nameOf.get(id) || 'Player') } : null;
    }).filter(Boolean);
    if (list.length) out.set(msg, list);
  }
  return out;
}
const read = async key => (await redis([['HGETALL', key]]))[0] || [];

// Réagir (ou retirer sa réaction). live = les messages encore dans le chat (le reste est nettoyé au passage) ;
// ttl en secondes = celui du chat (rien pour le chat global, qui garde ses 100 derniers messages).
async function toggle(key, msg, me, emoji, { live = null, ttl = 0 } = {}) {
  const idx = EMOJIS.indexOf(String(emoji || ''));
  if (idx < 0) throw refuse(400, 'Unknown reaction');
  if (live && !live.has(String(msg))) throw refuse(404, 'This message is gone');
  const [ok] = await redis([['SET', `rx:rl:${me}`, '1', 'PX', String(GAP_MS), 'NX']]);
  if (ok !== 'OK') throw refuse(429, 'Slow down a little');
  const field = `${msg}|${me}`, flat = await read(key);
  let cur = null;
  const stale = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] === field) cur = Number(flat[i + 1]);
    const m = String(flat[i]).slice(0, String(flat[i]).lastIndexOf('|'));
    if (live && !live.has(m)) stale.push(flat[i]);
  }
  const writes = [cur === idx ? ['HDEL', key, field] : ['HSET', key, field, String(idx)]];
  if (stale.length) writes.push(['HDEL', key, ...stale]);
  if (ttl) writes.push(['EXPIRE', key, String(ttl)]);
  await redis(writes);
  return cur === idx ? null : EMOJIS[idx];
}

module.exports = { EMOJIS, group, views, read, toggle };
