// Signalements de messages (demandé par Sacha, 2026-10-19) : un petit « Report » sur les messages des autres joueurs,
// dans le chat des duels et dans les messages entre amis. Le serveur retrouve lui-même le message (on ne peut pas
// signaler un texte inventé), puis le range dans la liste « reports » lue par la page Owner (onglet Reports).
// reports = les 500 derniers (le plus récent à la fin) { id, t, where, text, msgT, author, authorName, reporter, reporterName } ;
// reports:done = ceux que le créateur a traités ; reported:<id> = déjà signalés par ce joueur (un seul par message).
const crypto = require('node:crypto');
const { redis, dayKey } = require('./_lib');

const KEY = 'reports', DONE = 'reports:done', KEEP = 500, PER_DAY = 20;
const refuse = (status, error) => Object.assign(new Error(error), { status });

async function fileReport({ reporter, author, text, where, msgT }) {
  if (!author || author === reporter) throw refuse(422, 'You cannot report this message');
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
  const [raw, done] = await redis([['LRANGE', KEY, -KEEP, -1], ['SMEMBERS', DONE]]);
  const all = (raw || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).reverse(); // le plus récent d'abord
  const against = {};
  all.forEach(r => { against[r.author] = (against[r.author] || 0) + 1; });
  const isDone = new Set(done || []);
  return all.map(r => ({ id: r.id, t: r.t, where: r.where, text: r.text, msgT: r.msgT, author: r.authorName, reporter: r.reporterName, against: against[r.author], done: isDone.has(r.id) }));
}
const markDone = id => redis([['SADD', DONE, id]]);

module.exports = { fileReport, listReports, markDone };
