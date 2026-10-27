// « About me » sur les profils (idée de Niall, 2026-10-27) : une petite ligne (80 caractères) écrite dans les réglages,
// montrée sur le profil public (#/player/Nom) et sur son propre profil. Pas une fonction Vercel (nom en « _ ») : routé
// depuis /api/profile (POST action: 'bio'). Les joueurs sont surtout des enfants : le texte passe par le même filtre que
// le chat global (api/_global.js checkMessage : liens, insultes, infos personnelles), un joueur rendu muet dans le chat
// ne peut pas en écrire, et le créateur peut effacer celui de n'importe qui (page Owner, onglets Chat et Reports).
// Redis : bio = hash id → { x: texte, t: heure } ; bio:rl:<id> = une modification toutes les 10 s.
const { redis, ownsPlayer, readStats, cleanName, findPlayer, send } = require('./_lib');
const Reports = require('./_reports');
const { checkMessage } = require('./_global');

const MAX = 80, GAP_MS = 10000, KEY = 'bio';
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const refuse = (status, error) => Object.assign(new Error(error), { status });
const parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };

// Renvoie le texte nettoyé, '' pour effacer, ou lève une erreur 422 qui dit pourquoi (mêmes phrases que le chat).
function clean(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if ([...text.replace(/\s+/g, ' ')].length > MAX) throw refuse(422, `"About me" is ${MAX} characters at most`);
  return checkMessage(text);
}

async function set(id, raw) {
  const [name, muted] = await redis([['HGET', 'names', id], ['GET', `gc:mute:${id}`]]);
  if (!name) throw refuse(403, 'Choose a player name first');
  if (muted) throw refuse(403, 'You are muted for now');
  const text = clean(raw);
  const [ok] = await redis([['SET', `bio:rl:${id}`, '1', 'PX', String(GAP_MS), 'NX']]);
  if (ok !== 'OK') throw refuse(429, 'Wait a few seconds before changing it again');
  await redis([text ? ['HSET', KEY, id, JSON.stringify({ x: text, t: Date.now() })] : ['HDEL', KEY, id]]);
  return text || null;
}

// POST /api/profile { action: 'bio', op: 'set' | 'report' | 'clear', playerId, secret, text?, name? }
async function handle(req, res) {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const id = String(body.playerId || ''), secret = String(body.secret || '');
    if (!isPlayerId(id) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(id, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    const op = String(body.op || '');
    if (op === 'set') return send(res, 200, { bio: await set(id, body.text), max: MAX });
    // Signaler l'« About me » d'un autre joueur → onglet Reports de la page Owner (where: 'about me').
    if (op === 'report' || op === 'clear') {
      const who = await findPlayer(cleanName(body.name));
      const [raw] = who ? await redis([['HGET', KEY, who]]) : [null];
      const b = parse(raw);
      if (op === 'report') {
        if (!b) return send(res, 404, { error: 'Nothing to report' });
        return send(res, 200, await Reports.fileReport({ reporter: id, author: who, text: b.x, where: 'about me', msgT: b.t }));
      }
      // Effacer celui de n'importe qui : le créateur seul (les lecteurs « viewer » ne changent rien).
      const st = await readStats(id);
      if (!(Number(st.owner) >= 1)) return send(res, 403, { error: 'Owner only' });
      if (!who) return send(res, 404, { error: 'No player with this name' });
      if (!b) return send(res, 404, { error: 'This player has no "About me"' });
      await redis([['HDEL', KEY, who]]);
      return send(res, 200, { cleared: true });
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
}

module.exports = { handle, clean, MAX };
