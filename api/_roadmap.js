// Feuille de route publique (idée de Phong67, 2026-10-26) : page #/roadmap, routée depuis /api/site (action roadmap).
// Deux listes tirées de la boîte à idées : « Planned » (statut planned) et « Recently added » (statut done depuis 30 jours,
// 50 au plus). Seulement des idées (jamais les bugs), jamais les refusées, jamais d'identifiant : le pseudo du joueur et
// un extrait court du texte, passé au filtre du chat global (une idée qui ne le passe pas n'est pas montrée).
// Gardée 5 minutes en mémoire : la page est publique et la boîte compte des milliers de suggestions.
const { redis } = require('./_lib');
const { checkMessage } = require('./_global');

const CACHE_MS = 5 * 60 * 1000, RECENT_DAYS = 30, MAX_ITEMS = 50, SNIPPET = 120, SCAN_MAX = 5000;
let cache = null;

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
  const planned = [], recent = [], since = now - RECENT_DAYS * 86400000;
  for (const r of rows) {
    const [kind, status, text, name, t, doneAt, ownerAt] = r || [];
    if (kind === 'bug' || !text || (status !== 'planned' && status !== 'done')) continue;
    // « Ajoutée le » : doneAt (noté depuis le 2026-10-26), sinon la dernière réponse du créateur, sinon l'envoi.
    const when = Number(status === 'done' ? doneAt || ownerAt || t : t) || 0;
    if (status === 'done' && when < since) continue;
    const list = status === 'planned' ? planned : recent;
    if (list.length >= MAX_ITEMS) continue;
    const clean = safe(text);
    if (!clean) continue;
    list.push({ name: String(name || 'Player').slice(0, 20), text: clean, t: when });
  }
  recent.sort((a, b) => b.t - a.t);
  return { planned, recent, at: now };
}

async function roadmap(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache;
  cache = await build(now);
  return cache;
}

module.exports = { roadmap, snippet, reset: () => { cache = null; } };
