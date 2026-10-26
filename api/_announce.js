// Annonces dans le jeu (idée de jaxoncool43, 2026-10-26) : le créateur écrit une courte annonce depuis la page Owner
// (onglet Announce) ; les joueurs la voient en tête de « What's new » (point rouge sur 📰), et une annonce « important »
// s'affiche une fois en bandeau à la visite suivante. Routé depuis /api/site (actions announcements, annAdd, annDelete).
// ann:list = les 20 dernières, la plus récente à la fin (RPUSH), en JSON { id, t, title, text, important }. Texte brut : la page
// l'échappe à l'affichage, aucune balise n'est interprétée.
const crypto = require('node:crypto');
const { redis } = require('./_lib');

const KEY = 'ann:list', KEEP = 20, TITLE_MAX = 80, TEXT_MAX = 500;
const refuse = (status, error) => Object.assign(new Error(error), { status });
const clean = (raw, max, oneLine) => {
  let s = String(raw || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  s = oneLine ? s.replace(/\s+/g, ' ') : s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
};
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };

async function list() {
  const [raw] = await redis([['LRANGE', KEY, -KEEP, -1]]);
  return (raw || []).map(parse).filter(Boolean).reverse(); // la plus récente d'abord
}

// Publie une annonce. discord : aussi sur le salon Discord des annonces (ou des nouveautés) s'il est configuré ;
// sans webhook, l'annonce part quand même dans le jeu et la réponse le dit (discord: false).
async function add({ title, text, important, discord }) {
  const t = clean(title, TITLE_MAX, true), x = clean(text, TEXT_MAX);
  if (!t) throw refuse(422, 'Write a title');
  if ([...t].length > TITLE_MAX) throw refuse(422, `The title is ${TITLE_MAX} characters at most`);
  if (!x) throw refuse(422, 'Write the announcement');
  if ([...x].length > TEXT_MAX) throw refuse(422, `Announcements are ${TEXT_MAX} characters at most`);
  const entry = { id: crypto.randomBytes(4).toString('hex'), t: Date.now(), title: t, text: x, important: !!important };
  await redis([['RPUSH', KEY, JSON.stringify(entry)], ['LTRIM', KEY, -KEEP, -1]]);
  let posted = false;
  if (discord) { try { posted = require('./_discord').announceNews(entry); } catch (e) { posted = false; } }
  return { entry, discord: posted };
}

async function remove(id) {
  if (!/^[0-9a-f]{8}$/.test(String(id || ''))) throw refuse(400, 'Unknown announcement');
  const [raw] = await redis([['LRANGE', KEY, 0, -1]]);
  const hit = (raw || []).find(x => (parse(x) || {}).id === id);
  if (hit) await redis([['LREM', KEY, 1, hit]]);
  return !!hit;
}

module.exports = { list, add, remove, KEY, KEEP, TITLE_MAX, TEXT_MAX };
