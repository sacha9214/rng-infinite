// Lier son compte Discord à son joueur RNG∞ (2026-10-17, comme le « Update my Roles » des serveurs de jeux Roblox) :
//   POST /api/discord { playerId, secret, action: 'link', accessToken }  → vérifie le compte Discord (jeton OAuth2 de
//        l'utilisateur, portée identify + guilds.join), l'ajoute au serveur RNG∞ s'il n'y est pas, donne ses rôles ;
//   POST /api/discord { playerId, secret, action: 'state' | 'sync' | 'unlink' }
// Rôles donnés : Player, la rareté de son meilleur tirage de tous les temps (Mythic, Celestial, Divine, Godlike ou
// Infinite : un seul, le plus haut), Supporter et Idea Manager s'il les a en jeu. Ils suivent tout seuls : un tirage
// Mythic ou mieux d'un joueur lié relance la mise à jour (voir recordRoll dans _lib.js).
// Le jeton du bot est sur le VPS seulement (~/.config/rng/discord-bot-token) : ailleurs, l'action répond 503.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { redis, ownsPlayer, readStats, engine, statsKey, cors, send, flushDue } = require('./_lib');

const GUILD = '1561067220547670147';
const RARITY_ROLES = ['Mythic', 'Celestial', 'Divine', 'Godlike', 'Infinite'];
const MANAGED = ['Player', 'Supporter', 'Idea Manager', ...RARITY_ROLES];
const linkKey = 'discord:links'; // identifiant Discord → joueur (un compte Discord pour un seul joueur)
let BOT = '';
try { BOT = fs.readFileSync(path.join(os.homedir(), '.config/rng/discord-bot-token'), 'utf8').trim(); } catch (e) { /* pas ici */ }

async function dc(method, p, { body, bearer } = {}) {
  const res = await fetch(`https://discord.com/api/v10${p}`, {
    method, headers: { Authorization: bearer ? `Bearer ${bearer}` : `Bot ${BOT}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (rng-infinite, 1)' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Discord ${res.status}`), { status: res.status, detail: text.slice(0, 200) });
  return text ? JSON.parse(text) : null;
}

let roleCache = null, roleAt = 0;
async function roleIds() {
  if (!roleCache || Date.now() - roleAt > 600000) {
    roleCache = Object.fromEntries((await dc('GET', `/guilds/${GUILD}/roles`)).map(r => [r.name, r.id]));
    roleAt = Date.now();
  }
  return roleCache;
}

// Les rôles qu'un joueur doit avoir, d'après ses stats tenues par le serveur.
function wanted(stats) {
  const out = ['Player'];
  const best = Number(stats.best) || 0;
  if (best > 0) { const tier = engine.cardTier(best); if (RARITY_ROLES.includes(cap(tier))) out.push(cap(tier)); }
  if (Number(stats.supporter) >= 1) out.push('Supporter');
  if (Number(stats.ideaManager) >= 1) out.push('Idea Manager');
  return out;
}
const cap = s => s[0].toUpperCase() + s.slice(1);

async function syncRoles(playerId) {
  if (!BOT) return null;
  const [uid] = await redis([['HGET', statsKey(playerId), 'discord']]);
  if (!uid) return null;
  const ids = await roleIds(), want = new Set(wanted(await readStats(playerId)));
  let member;
  try { member = await dc('GET', `/guilds/${GUILD}/members/${uid}`); } catch (e) { if (e.status === 404) return { inGuild: false, roles: [] }; throw e; }
  const has = new Set(member.roles);
  for (const name of MANAGED) {
    const id = ids[name];
    if (!id) continue;
    if (want.has(name) && !has.has(id)) await dc('PUT', `/guilds/${GUILD}/members/${uid}/roles/${id}`);
    if (!want.has(name) && has.has(id)) await dc('DELETE', `/guilds/${GUILD}/members/${uid}/roles/${id}`);
  }
  return { inGuild: true, roles: [...want] };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || ''), secret = String(body.secret || ''), action = String(body.action || 'state');
    if (!/^[0-9a-f]{16}$/.test(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    const [uid, uname] = await redis([['HGET', statsKey(playerId), 'discord'], ['HGET', statsKey(playerId), 'discordName']]);
    if (action === 'state') return send(res, 200, { linked: !!uid, username: uname || null, available: !!BOT });
    if (!BOT) return send(res, 503, { error: 'Discord linking is not available right now' });
    if (action === 'unlink') {
      if (uid) await redis([['HDEL', statsKey(playerId), 'discord', 'discordName'], ['HDEL', linkKey, uid]]);
      return send(res, 200, { linked: false, username: null, available: true });
    }
    if (action === 'sync') return send(res, 200, { linked: !!uid, username: uname || null, available: true, ...(await syncRoles(playerId)) });
    if (action !== 'link') return send(res, 400, { error: 'Unknown action' });
    const token = String(body.accessToken || '');
    if (!/^[A-Za-z0-9._-]{10,200}$/.test(token)) return send(res, 400, { error: 'Missing Discord authorization' });
    let user;
    try { user = await dc('GET', '/users/@me', { bearer: token }); } catch (e) { return send(res, 401, { error: 'Discord did not accept the authorization, try again' }); }
    const [owner] = await redis([['HGET', linkKey, user.id]]);
    if (owner && owner !== playerId) return send(res, 409, { error: 'This Discord account is already linked to another player' });
    if (uid && uid !== user.id) await redis([['HDEL', linkKey, uid]]);
    await redis([['HSET', statsKey(playerId), 'discord', user.id, 'discordName', user.username], ['HSET', linkKey, user.id, playerId]]);
    // Ajout au serveur (portée guilds.join) ; déjà membre : Discord répond 204, rien à faire.
    try { await dc('PUT', `/guilds/${GUILD}/members/${user.id}`, { body: { access_token: token } }); } catch (e) { /* pas grave : il pourra rejoindre par le lien */ }
    const roles = await syncRoles(playerId);
    return send(res, 200, { linked: true, username: user.username, available: true, ...roles });
  } catch (err) {
    return send(res, err.status && err.status < 600 ? (err.status >= 500 ? 502 : err.status) : 500, { error: err.message });
  }
};
module.exports.syncRoles = syncRoles;
module.exports.wanted = wanted;
