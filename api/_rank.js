// Badges Top 1 / Top 5 / Top 10 du classement du mois, avec le mois et l'année (« Top 1 · Oct 2026 »).
// Rien pendant le mois : à la fin du mois, les dix premiers reçoivent leur badge, gardé pour toujours.
// top = 1 (1re place), 5 (2e à 5e), 10 (6e à 10e).
// Remise paresseuse : la première requête du mois suivant fige le top 10 du mois fini (le classement du mois est
// gardé 70 jours). topawards:<id> = { mois: top } ; topbest = { id: « top:mois » }, le meilleur badge de chacun,
// montré à côté du nom (le meilleur rang, le plus récent à rang égal).
const { redis } = require('./_lib');

const TOP_SIZE = 10;
const BEST_KEY = 'topbest';
const awardKey = id => `topawards:${id}`;
const markOf = place => (place === 1 ? 1 : place <= 5 ? 5 : place <= TOP_SIZE ? 10 : null);
const prevMonth = t => { const d = new Date(t); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const parse = v => { if (!v) return null; const [top, month] = String(v).split(':'); return { top: Number(top), month }; };
const better = (a, b) => !b || a.top < b.top || (a.top === b.top && a.month > b.month);

let settled = ''; // dernier mois figé, gardé en mémoire : une seule lecture Redis par mois et par processus
async function settleMonth(t = Date.now()) {
  const month = prevMonth(t);
  if (settled === month) return;
  const [done] = await redis([['GET', `topawards:done:${month}`]]);
  if (!done) {
    // Les écritures sont idempotentes : deux requêtes simultanées donnent le même résultat.
    const [ids] = await redis([['ZREVRANGE', `lb:month:${month}`, 0, TOP_SIZE - 1]]);
    if (ids && ids.length) {
      const [bests] = await redis([['HMGET', BEST_KEY, ...ids]]);
      const writes = [];
      ids.forEach((id, i) => {
        const award = { top: markOf(i + 1), month };
        writes.push(['HSET', awardKey(id), month, award.top]);
        if (better(award, parse(bests[i]))) writes.push(['HSET', BEST_KEY, id, `${award.top}:${month}`]);
      });
      await redis(writes);
    }
    await redis([['SET', `topawards:done:${month}`, String(t)]]);
  }
  settled = month;
}

// Map identifiant → { top, month } : le meilleur badge de chacun.
async function bestAwards(ids, t = Date.now()) {
  await settleMonth(t);
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const [vals] = await redis([['HMGET', BEST_KEY, ...list]]);
  return new Map(list.map((id, i) => [id, parse(vals[i])]).filter(([, v]) => v));
}

// Tous les badges d'un joueur, du plus récent au plus ancien.
async function awardsOf(id, t = Date.now()) {
  await settleMonth(t);
  const [flat] = await redis([['HGETALL', awardKey(id)]]);
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) out.push({ top: Number(flat[i + 1]), month: flat[i] });
  return out.sort((a, b) => (a.month < b.month ? 1 : -1));
}

module.exports = { bestAwards, awardsOf, settleMonth, markOf, prevMonth, TOP_SIZE, _reset: () => { settled = ''; } };
