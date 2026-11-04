// Fermes de bots (signalées par jonahfr, 2026-11-04) : 349 comptes créés en une demi-heure le 3 novembre (« TRING … »,
// « CID Cosmic… »), puis 104 dans la même minute le 4 (forge, shieis, cosmicly…). Ce script les retrouve par leur heure
// de création : les minutes où bien plus de comptes que d'habitude ont fait leur premier tirage (un jour normal : 10 à
// 20 par heure, donc rarement plus de 2 dans la même minute). Il liste tout, et ne suspend rien sans --apply (api/_lib.js, banPlayers : plus aucune
// action, retirés des classements et du compteur en ligne, rien n'est effacé).
//   node tools/ban-bots.js [--since 2026-11-03] [--min 6] [--keep "Nom 1,Nom 2"] [--apply]
// Sur le VPS, avec les mêmes variables que les autres outils (RNG_REDIS_URL, RNG_REDIS_TOKEN).
const L = require('../api/_lib');
const { redis, toObject, banPlayers } = L;

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const APPLY = process.argv.includes('--apply');
const SINCE = Date.parse(arg('since', '2026-11-03'));
const MIN = Number(arg('min', 6)); // comptes créés dans la même minute pour parler de rafale
const KEEP = new Set(String(arg('keep', '')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const SLICE = 60000;
const iso = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

(async () => {
  const names = toObject((await redis([['HGETALL', 'names']]))[0]);
  const ids = Object.keys(names), first = {};
  for (let i = 0; i < ids.length; i += 300) {
    const part = ids.slice(i, i + 300), got = await redis(part.map(id => ['HGET', `stats:${id}`, 'first']));
    part.forEach((id, j) => { const t = Number(got[j]) || 0; if (t >= SINCE) first[id] = t; });
  }
  const slices = {};
  for (const [id, t] of Object.entries(first)) (slices[Math.floor(t / SLICE)] ||= []).push(id);
  const bursts = Object.entries(slices).filter(([, l]) => l.length >= MIN).sort((a, b) => a[0] - b[0]);
  console.log(`${Object.keys(first).length} comptes créés depuis ${iso(SINCE)} ; minutes avec ${MIN}+ comptes :`);
  for (const [s, l] of bursts) console.log(`  ${iso(s * SLICE)}  ${l.length} comptes`);

  // Exclus d'office : compte Google (un bot n'en a pas), amis, photo de profil, ou nom passé dans --keep.
  const suspects = bursts.flatMap(([, l]) => l), ban = [], kept = [];
  for (let i = 0; i < suspects.length; i += 200) {
    const part = suspects.slice(i, i + 200);
    const got = await redis(part.flatMap(id => [['GET', `player:${id}:google`], ['SCARD', `fr:${id}`], ['HMGET', `stats:${id}`, 'rolls', 'gBet', 'spent', 'clanDonated'], ['HEXISTS', 'avpub', id]]));
    part.forEach((id, j) => {
      const [google, friends, [rolls, gBet, spent, donated], avatar] = got.slice(j * 4, j * 4 + 4);
      const why = google ? 'Google' : Number(friends) ? `${friends} ami(s)` : Number(avatar) ? 'photo' : KEEP.has(String(names[id]).toLowerCase()) ? '--keep' : '';
      const row = { id, name: names[id], first: iso(first[id]), rolls: Number(rolls) || 0, casino: Number(gBet) || 0, spent: Number(spent) || 0, clan: Number(donated) || 0, why };
      (why ? kept : ban).push(row);
    });
  }
  console.log(`\nÀ suspendre : ${ban.length}`);
  console.table(ban.map(({ id, why, ...r }) => ({ id: id.slice(0, 6), ...r })));
  console.log(`Gardés (à regarder à la main) : ${kept.length}`);
  if (kept.length) console.table(kept.map(({ id, ...r }) => ({ id: id.slice(0, 6), ...r })));

  // Clans où ces comptes ont versé des pièces : le coffre reste, c'est au créateur de décider.
  const clans = await redis(ban.map(r => ['HGET', 'clanof', r.id]));
  const cids = [...new Set(clans.filter(Boolean))];
  for (const cid of cids) {
    const c = toObject((await redis([['HGETALL', `clan:${cid}`]]))[0]);
    console.log(`Clan ${c.name} [${c.tag}] : coffre ${c.vault || 0}, chef ${names[c.leader] || c.leader}, ${clans.filter(x => x === cid).length} membre(s) suspendu(s)`);
  }

  if (!APPLY) { console.log('\nRien n\'a été suspendu. Relancer avec --apply pour suspendre la liste « À suspendre ».'); return; }
  const n = await banPlayers(ban.map(r => r.id));
  console.log(`\n${n} comptes suspendus.`);
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
