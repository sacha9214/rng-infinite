// Signalements de messages (demandé par Sacha, 2026-10-19) : un petit « Report » sur les messages des autres joueurs,
// dans le chat des duels et dans les messages entre amis. Le serveur retrouve lui-même le message (on ne peut pas
// signaler un texte inventé), puis le range dans la liste « reports » lue par la page Owner (onglet Reports).
// reports = les 500 derniers (le plus récent à la fin) { id, t, where, text, msgT, author, authorName, reporter, reporterName } ;
// reports:done = ceux que le créateur a traités ; reported:<id> = déjà signalés par ce joueur (un seul par message).
// reports:by = { id: { by, bi, act, t } } : signalement du chat global traité par un Modérateur (Sacha, 2026-11-01) :
// act = ok (rien à faire), deleted ou muted. La page Owner le montre pour juger le travail des modérateurs.
const crypto = require('node:crypto');
const { redis, dayKey } = require('./_lib');

const KEY = 'reports', DONE = 'reports:done', BY = 'reports:by', KEEP = 500, PER_DAY = 20;
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };
const refuse = (status, error) => Object.assign(new Error(error), { status });

async function fileReport({ reporter, author, text, where, msgT }) {
  if (!author || author === reporter) throw refuse(422, 'You cannot report this message');
  // Des comptes jetables poussaient les vrais signalements hors des 500 gardés (audit de sécurité, 2026-11-02) : signaler
  // demande un pseudo et 20 tirages.
  const [rname, rolls, hrolls] = await redis([['HGET', 'names', reporter], ['HGET', `stats:${reporter}`, 'rolls'], ['HGET', `stats:${reporter}`, 'h:rolls']]);
  if (!rname || (Number(rolls) || 0) + (Number(hrolls) || 0) < 20) throw refuse(403, 'Make 20 rolls to report a message');
  const now = Date.now(), day = dayKey(now);
  const [fresh, n] = await redis([
    ['SADD', `reported:${reporter}`, `${author}:${msgT}`], ['INCR', `reportn:${reporter}:${day}`],
    ['EXPIRE', `reported:${reporter}`, 30 * 86400], ['EXPIRE', `reportn:${reporter}:${day}`, 2 * 86400],
  ]);
  if (Number(fresh) !== 1) return { already: true };
  if (Number(n) > PER_DAY) throw refuse(429, 'Too many reports today');
  const [names] = await redis([['HMGET', 'names', reporter, author]]);
  const r = { id: crypto.randomBytes(6).toString('hex'), t: now, where, text: String(text).slice(0, 300), msgT, author, authorName: names[1] || 'Player', reporter, reporterName: names[0] || 'Player' };
  await redis([['RPUSH', KEY, JSON.stringify(r)], ['LTRIM', KEY, -KEEP, -1]]);
  return { reported: true };
}

// Pour la page Owner : sans identifiants, avec le nombre de signalements visant le même joueur.
async function listReports() {
  const [raw, done, byRaw] = await redis([['LRANGE', KEY, -KEEP, -1], ['SMEMBERS', DONE], ['HGETALL', BY]]);
  const all = (raw || []).map(parse).filter(Boolean).reverse(); // le plus récent d'abord
  const by = handledMap(byRaw);
  // Les signalements sortis des 500 derniers n'ont plus besoin de leur « traité par » (le hachage ne grossit pas).
  const live = new Set(all.map(r => r.id)), stale = [...by.keys()].filter(id => !live.has(id));
  if (stale.length) await redis([['HDEL', BY, ...stale]]);
  const against = {};
  all.forEach(r => { against[r.author] = (against[r.author] || 0) + 1; });
  const isDone = new Set(done || []);
  return all.map(r => ({ id: r.id, t: r.t, where: r.where, text: r.text, msgT: r.msgT, author: r.authorName, reporter: r.reporterName, against: against[r.author], done: isDone.has(r.id), ...(by.has(r.id) ? { by: pub(by.get(r.id)) } : {}) }));
}
const markDone = id => redis([['SADD', DONE, id]]);
const handledMap = flat => { const m = new Map(); for (let i = 0; i < (flat || []).length; i += 2) { const v = parse(flat[i + 1]); if (v) m.set(flat[i], v); } return m; };
const pub = h => ({ name: h.by, act: h.act, t: h.t });

// ---------------------------------------------------------------- Modérateurs du chat global (Sacha, 2026-11-01)
// Signalements du chat global encore ouverts, avec l'id de l'auteur (reste dans api/_global.js, qui ne le renvoie jamais)
// et sans le pseudo de celui qui signale : un modérateur est un joueur comme les autres.
async function openGlobal() {
  const [raw, done] = await redis([['LRANGE', KEY, -KEEP, -1], ['SMEMBERS', DONE]]);
  const isDone = new Set(done || []), all = (raw || []).map(parse).filter(r => r && r.where === 'global chat');
  const against = {};
  all.forEach(r => { against[r.author] = (against[r.author] || 0) + 1; });
  return all.filter(r => !isDone.has(r.id)).map(r => ({ id: r.id, t: r.t, author: r.author, msgT: r.msgT, text: r.text, against: against[r.author] }));
}
// Traité par un modérateur : rangé comme « traité » pour le créateur aussi, avec qui et comment.
async function markHandled(ids, byId, byName, act) {
  if (!ids.length) return;
  const v = JSON.stringify({ by: byName || 'Moderator', bi: byId, act, t: Date.now() });
  await redis([['SADD', DONE, ...ids], ['HSET', BY, ...ids.flatMap(id => [id, v])]]);
}
// Combien de signalements chaque modérateur a traités (par identifiant).
async function handledCounts() {
  const [flat] = await redis([['HGETALL', BY]]), out = {};
  for (const v of handledMap(flat).values()) if (v.bi) out[v.bi] = (out[v.bi] || 0) + 1;
  return out;
}

module.exports = { fileReport, listReports, markDone, openGlobal, markHandled, handledCounts };
