// Surveillance des bots (demandé par Sacha, 2026-11-06) : l'onglet « Bot watch » de la page Owner. Après les fermes du
// 3 et du 4 novembre (468 comptes créés par rafales, jusqu'à 31 % des tirages d'un jour), on garde un œil sur trois
// signes, sans rien décider tout seul :
//   1. les rafales d'inscriptions : 6 comptes ou plus dont le premier tirage tombe dans la même minute (un jour normal :
//      10 à 20 par heure ; une classe entière derrière le Wi-Fi de l'école peut en faire une petite, d'où les exemptions) ;
//   2. les gros tireurs sans rien d'humain autour : 5 000 tirages ou plus dans la journée (le tirage auto laissé ouvert
//      en fait autant, ce n'est pas une preuve), sans Google, sans ami et sans photo ;
//   3. les tirages refusés parce que trop rapides (429), rapportés aux tirages acceptés : le jeu attend la fin du délai
//      depuis le 2026-11-06, donc un rapport qui remonte au-dessus de 1 veut dire des scripts qui frappent l'API.
// Suspendre une rafale reprend les règles de tools/ban-bots.js : on garde les comptes liés à Google, qui ont des amis
// ou une photo. Les identifiants ne quittent jamais le serveur : la page ne voit que des pseudos et des minutes.
const { redis, toObject, dayKey, banPlayers, BANNED, SEEN_KEY, actKey } = require('./_lib');

const DAY = 86400000, MINUTE = 60000, DAYS = 7, BURST_MIN = 6, HEAVY = 5000;
const chunked = async (cmds, size = 500) => { const out = []; for (let i = 0; i < cmds.length; i += size) out.push(...await redis(cmds.slice(i, i + size))); return out; };

// Tous les joueurs nommés, avec l'heure de leur premier tirage.
async function players() {
  const names = toObject((await redis([['HGETALL', 'names']]))[0]), ids = Object.keys(names);
  const got = await chunked(ids.map(id => ['HGET', `stats:${id}`, 'first']));
  const first = {}; ids.forEach((id, i) => { first[id] = Number(got[i]) || 0; });
  return { names, ids, first };
}

// Les rafales depuis « since » : minute → identifiants.
function bursts(first, since) {
  const per = new Map();
  for (const [id, t] of Object.entries(first)) if (t >= since) { const m = Math.floor(t / MINUTE) * MINUTE; if (!per.has(m)) per.set(m, []); per.get(m).push(id); }
  return new Map([...per].filter(([, l]) => l.length >= BURST_MIN));
}

// Pourquoi garder un compte d'une rafale (un bot n'a ni Google, ni amis, ni photo validée) : '' si rien ne le retient.
async function keepReasons(ids) {
  const got = await chunked(ids.flatMap(id => [['GET', `player:${id}:google`], ['SCARD', `fr:${id}`], ['HEXISTS', 'avpub', id]]), 600);
  const out = {};
  ids.forEach((id, i) => { const [g, fr, av] = got.slice(i * 3, i * 3 + 3); out[id] = g ? 'Google' : Number(fr) ? 'friends' : Number(av) ? 'photo' : ''; });
  return out;
}

async function report(now = Date.now()) {
  const { names, ids, first } = await players();
  const days = Array.from({ length: DAYS }, (_, i) => dayKey(now - i * DAY)), since = Date.parse(`${days[DAYS - 1]}T00:00:00Z`);
  const groups = bursts(first, since), inBurst = new Set([...groups.values()].flat());
  const [banned] = await redis([['SMEMBERS', BANNED]]), ban = new Set(banned || []);
  const raw = await redis(days.flatMap(d => [['HGETALL', actKey(d)], ['GET', `rolls:day:${d}`], ['HGET', `health:${d}`, 'r429:roll']]));
  const daily = days.map((d, i) => {
    const act = toObject(raw[i * 3]);
    let total = 0, fromBursts = 0;
    for (const [id, n] of Object.entries(act)) { total += Number(n) || 0; if (inBurst.has(id)) fromBursts += Number(n) || 0; }
    const born = ids.filter(id => first[id] && dayKey(first[id]) === d);
    return { day: d, fresh: born.length, burst: born.filter(id => inBurst.has(id)).length, rolls: Number(raw[i * 3 + 1]) || total, counted: total, fromBursts, refused: Number(raw[i * 3 + 2]) || 0, act };
  });
  const today = daily[0].act;
  const keep = await keepReasons([...inBurst]);
  const list = [...groups].sort((a, b) => b[0] - a[0]).map(([at, l]) => ({
    at, count: l.length,
    active: l.filter(id => Number(today[id]) > 0).length,
    suspended: l.filter(id => ban.has(id)).length,
    suspendable: l.filter(id => !ban.has(id) && !keep[id]).length,
    names: l.slice(0, 8).map(id => names[id] || '?'),
  }));
  // Les comptes à regarder aujourd'hui : gros tireurs sans rien d'humain autour, et comptes de rafale qui tirent encore.
  const heavy = Object.entries(today).filter(([id, n]) => !ban.has(id) && (Number(n) >= HEAVY || (inBurst.has(id) && Number(n) > 0))).sort((a, b) => b[1] - a[1]).slice(0, 120).map(([id]) => id);
  const why = await keepReasons(heavy);
  const info = heavy.length ? await chunked(heavy.flatMap(id => [['HMGET', `stats:${id}`, 'rolls', 'gBet'], ['ZSCORE', SEEN_KEY, id]]), 400) : [];
  const suspects = heavy.map((id, j) => ({ id, j })).filter(({ id }) => !why[id]).slice(0, 40).map(({ id, j }) => {
    const [rolls, gBet] = info[j * 2] || [], seen = info[j * 2 + 1];
    return { name: names[id] || '?', first: first[id] || 0, today: Number(today[id]) || 0, total: Number(rolls) || 0, casino: Number(gBet) || 0, seen: Number(seen) || 0, burst: inBurst.has(id) };
  });
  return {
    days: daily.map(({ act, ...d }) => d),
    bursts: list, suspects,
    totals: { burstAccounts: inBurst.size, suspended: ban.size, open: list.reduce((n, b) => n + b.suspendable, 0), recent: list.filter(b => b.at > now - DAY && b.suspendable > 0).length },
    rules: { burstMin: BURST_MIN, heavy: HEAVY, days: DAYS },
  };
}

// Suspendre une rafale (par sa minute, recalculée ici) : seulement les comptes que rien ne retient.
async function suspendBurst(at, now = Date.now()) {
  at = Number(at);
  if (!Number.isFinite(at) || at % MINUTE || at < now - (DAYS + 1) * DAY || at > now) throw Object.assign(new Error('Unknown burst'), { status: 404 });
  const { first } = await players();
  const group = bursts(first, at).get(at) || [];
  if (group.length < BURST_MIN) throw Object.assign(new Error('Unknown burst'), { status: 404 });
  const keep = await keepReasons(group), ids = group.filter(id => !keep[id]);
  const n = await banPlayers(ids);
  return { suspended: n, kept: group.length - ids.length };
}

module.exports = { report, suspendBurst, BURST_MIN, HEAVY };
