// Chat global du serveur (demandé par Sacha, 2026-10-25). Pas une fonction Vercel (nom en « _ ») : routé depuis
// api/friends.js (actions « gc… »). Les joueurs sont surtout des enfants : la sécurité passe avant tout.
// - Tout le monde lit. Écrire : compte Google associé ET 100 tirages au moins (un compte jetable ne peut pas spammer).
// - Un message toutes les 5 s, 200 caractères, texte seul. Refusés (jamais gardés) : liens, insultes (même liste que
//   le chat des duels, api/_chat.js, plus les lettres espacées), et infos personnelles (téléphone, e-mail, adresse,
//   pseudos de réseaux sociaux). Le joueur reçoit une erreur gentille qui dit pourquoi.
// - Modération : « Report » vers les signalements (api/_reports.js) ; le créateur et les Modérateurs (rôle donné par le
//   créateur sur la page Owner) suppriment un message et rendent muet 1 h, 24 h ou pour toujours.
// Clés : gc:msgs = les 100 derniers { id, a: auteur, n: pseudo, ti: titre, t, x } ; gc:rev = heure du dernier
// changement ; gc:del = heure de la dernière suppression ; gc:rl:<id> = délai de 5 s ; gc:mute:<id> = fin du silence
// (-1 = pour toujours) ; gc:mutes = { id: { until, n, by, t } } pour la page Owner ; gc:mods = les Modérateurs.
// Aucun identifiant de joueur ne sort d'ici : les messages sont désignés par leur id, les joueurs par leur pseudo.
const crypto = require('node:crypto');
const { redis, ownsPlayer, readStats, statsKey, findPlayer, dayKey } = require('./_lib');
const Reports = require('./_reports');
const { maskBad, shape, BLOCKED_SHAPES } = require('./_chat');

const KEY = 'gc:msgs', REV = 'gc:rev', DEL = 'gc:del', MUTES = 'gc:mutes', MODS = 'gc:mods';
const KEEP = 100, MAX = 200, GAP_MS = 5000, MIN_ROLLS = 100;
const MUTE_MS = { '1h': 3600e3, '24h': 86400e3, perm: -1 };
const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));
const refuse = (status, error) => Object.assign(new Error(error), { status });
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };

// ---------------------------------------------------------------- filtre automatique
const SAFETY = 'For your safety, don\'t share personal info (phone, e-mail, address or social media accounts)';
const RUDE = 'Let\'s keep the chat friendly: this message has a word that isn\'t allowed';
const LINK = 'Links aren\'t allowed in the chat';
const TLD = 'com|net|org|gg|io|fr|xyz|ru|tv|me|co|app|link|ly|be|ch|ca|uk|de|es|it|info|biz|site|online|shop|store|live|fun|club|top|pro|dev|us|eu|cc|to|sh|ai|gl|bit';
const LINK_RE = [
  /(?:https?:\/\/|www\.|\bhxxps?:)/i, // adresse complète
  // Domaine : « site.com » collé, ou « site dot com » / « site(dot)com ». Un point suivi d'une espace n'en est pas un
  // (« daily rollers. Be active » était refusé comme un site .be, « I won. It was… » comme un .it : 2026-10-25), sauf
  // devant les extensions qu'on ne trouve pas en début de phrase (« site . com »).
  new RegExp(`\\b[a-z0-9-]{2,}(?:\\.|\\s*(?:\\(dot\\)|\\[dot\\])\\s*|\\sdot\\s)(?:${TLD})\\b`, 'i'),
  /\b[a-z0-9-]{2,}\s*\.\s*(?:com|net|org|gg|io|xyz|ly|tk|ru|fr)\b/i,
  /\b(?:discord\.gg|discordapp|t\.me|bit\.ly|tinyurl)\b/i,
  /data:image|\.(?:png|jpe?g|gif|webp)\b/i, // pas d'image non plus
];
const PERSONAL_RE = [
  /[\w.+-]+\s*(?:@|\(at\)|\[at\])\s*[\w-]+\s*(?:\.|\(dot\)|\[dot\])\s*[a-z]{2,}/i, // e-mail
  /(?:\+?\d[\s.\-()]*){8,}/, // téléphone : 8 chiffres ou plus (les nombres du jeu en ont 7 au plus)
  /\b\d{1,5}\s+(?:[a-z]+\s+){0,3}(?:street|avenue|ave|road|rd|boulevard|blvd|lane|drive|terrace|crescent)\b/i, // adresse (anglais ; pas « way », « place »… trop courants)
  /\b\d{1,4}\s*(?:bis|ter)?\s*,?\s*(?:rue|avenue|boulevard|bd|chemin|all[ée]e|impasse|quai|r[ée]sidence)\b/i, // adresse (français ; pas « 3 place », « 2 cours »)
  /\b(?:i\s+live\s+(?:at|on)|my\s+address|j'?\s*habite\s+(?:au|à|a)\s+\d|mon\s+adresse|zip\s*code|code\s+postal)\b/i,
  /(?:^|[\s(])@[a-z0-9_.]{3,}/i, // @pseudo
  /\b(?:snap|snapchat|sc|insta|instagram|ig|tiktok|tik\s*tok|whatsapp|whats\s*app|wa|telegram|kik|facebook|fb|twitter|roblox\s+user(?:name)?)\s*[:=]/i,
  /\b(?:add|follow|text|dm|message|call|ajoute|appelle)\s*(?:me|moi)?\s+(?:on|sur)\s+(?:snap|snapchat|insta|instagram|ig|tiktok|whatsapp|telegram|kik|discord|facebook|fb|twitter)\b/i,
  /\b(?:my|mon|ma)\s+(?:snap|snapchat|insta|instagram|ig|tiktok|whatsapp|telegram|kik|discord|facebook|fb|twitter|phone\s+number|cell|email|e-mail|mail|num[ée]ro\s+de\s+t[ée]l\w*|t[ée]l[ée]phone\s+(?:est|c'?est))\b/i, // pas « my number » : on parle de tirages toute la journée
  /\b(?:snapchat|instagram|tiktok|whatsapp|telegram)\b/i,
  /\bdiscord\s*(?:is|:|=|est)\s*\S/i,
];
// Lettres séparées par des espaces ou des points (« f u c k », « n.i.g ») : on les recolle puis on compare.
const SPACED = /(?:^|[^\p{L}])((?:[\p{L}0-9@$!€][\s._*-]+){2,}[\p{L}0-9@$!€])(?=$|[^\p{L}])/gu;
function rude(text) {
  if (maskBad(text) !== text) return true;
  for (const m of text.matchAll(SPACED)) if (BLOCKED_SHAPES.has(shape(m[1].replace(/[\s._*-]+/g, '')))) return true;
  return false;
}
// Renvoie le texte nettoyé (une ligne) ou lève une erreur 422 qui explique au joueur pourquoi.
function checkMessage(raw) {
  const text = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw refuse(422, 'Write a message first');
  if ([...text].length > MAX) throw refuse(422, `Messages are ${MAX} characters at most`);
  if (PERSONAL_RE[0].test(text)) throw refuse(422, SAFETY); // un e-mail avant les liens (il contient un domaine)
  if (LINK_RE.some(re => re.test(text))) throw refuse(422, LINK);
  if (PERSONAL_RE.some(re => re.test(text))) throw refuse(422, SAFETY);
  if (rude(text)) throw refuse(422, RUDE);
  return text;
}

// ---------------------------------------------------------------- lecture
const view = (m, me) => ({ id: m.id, t: m.t, name: m.n || 'Player', title: m.ti || null, text: m.x, ...(me && m.a === me ? { mine: true } : {}) });
async function readAll() { const [raw] = await redis([['LRANGE', KEY, 0, -1]]); return (raw || []).map(parse).filter(Boolean); }

// Mon statut : puis-je écrire, et sinon pourquoi ; suis-je muet (jusqu'à quand) ; suis-je modérateur.
async function meInfo(id, stats) {
  const [google, mute] = await redis([['GET', `player:${id}:google`], ['GET', `gc:mute:${id}`]]);
  const rolls = Number(stats.rolls) || 0, owner = Number(stats.owner) >= 1, mod = owner || stats.gcMod === '1';
  const mutedUntil = mute ? Number(mute) : 0;
  // Sacha (2026-10-25) : plus besoin de compte Google, seulement 100 tirages.
  const reason = mutedUntil ? 'muted' : rolls < MIN_ROLLS ? 'rolls' : null;
  return { can: !reason, reason, rolls, need: MIN_ROLLS, google: !!google, mutedUntil, mod, owner };
}

// Relecture toutes les 3 s : réponse minuscule quand rien n'a changé (« same »). Après une suppression, la liste entière.
async function list(body, me, stats) {
  const [rev, del] = await redis([['GET', REV], ['GET', DEL]]);
  const out = { rev: Number(rev) || 0, del: Number(del) || 0, max: MAX, gap: GAP_MS };
  if (me) out.me = await meInfo(me, stats);
  const since = Number(body.since) || 0, seenDel = Number(body.del) || 0;
  if (body.rev != null && Number(body.rev) === out.rev && seenDel === out.del) return { ...out, same: true };
  const all = await readAll();
  const full = !since || seenDel !== out.del;
  return { ...out, full, msgs: (full ? all : all.filter(m => m.t > since)).map(m => view(m, me)) };
}

// ---------------------------------------------------------------- écriture
async function post(me, stats, raw) {
  const info = await meInfo(me, stats);
  if (info.reason === 'muted') throw refuse(403, info.mutedUntil < 0 ? 'You can no longer write in the chat' : 'You are muted for now');
  if (info.reason === 'rolls') throw refuse(403, `Make ${MIN_ROLLS} rolls to write in the chat (you have ${info.rolls})`);
  const text = checkMessage(raw);
  const [ok] = await redis([['SET', `gc:rl:${me}`, '1', 'PX', GAP_MS, 'NX']]);
  if (ok !== 'OK') throw refuse(429, 'Wait 5 seconds between messages');
  const [names, title] = await redis([['HMGET', 'names', me], ['HGET', 'titles', me]]), name = (names || [])[0];
  // Heure strictement croissante : « since » ne perd jamais un message écrit dans la même milliseconde.
  const [last] = await redis([['LINDEX', KEY, -1]]);
  const t = Math.max(Date.now(), ((parse(last) || {}).t || 0) + 1);
  const m = { id: crypto.randomBytes(6).toString('hex'), a: me, n: name || 'Player', ti: title || null, t, x: text };
  await redis([['RPUSH', KEY, JSON.stringify(m)], ['LTRIM', KEY, -KEEP, -1], ['SET', REV, t], ['HINCRBY', 'feat:gchat', dayKey(t), 1]]);
  return m;
}

async function findMsg(id) {
  if (!/^[0-9a-f]{12}$/.test(String(id || ''))) throw refuse(400, 'Unknown message');
  const [raw] = await redis([['LRANGE', KEY, 0, -1]]);
  const entry = (raw || []).find(x => (parse(x) || {}).id === id);
  if (!entry) throw refuse(404, 'This message is gone');
  return { entry, m: parse(entry) };
}
async function remove(entry) { const t = Date.now(); await redis([['LREM', KEY, 1, entry], ['SET', REV, t], ['SET', DEL, t]]); }

// Silence : sur un message (on ne connaît jamais l'id de l'auteur côté site). Les modérateurs ne peuvent pas rendre
// muet le créateur ni un autre modérateur. Le message est supprimé en même temps.
async function mute(byId, m, dur) {
  if (!(dur in MUTE_MS)) throw refuse(400, 'Pick 1 h, 24 h or forever');
  if (m.a === byId) throw refuse(422, 'You cannot mute yourself');
  const [st, byName] = await Promise.all([readStats(m.a), redis([['HGET', 'names', byId]])]);
  if (Number(st.owner) >= 1 || st.gcMod === '1') throw refuse(403, 'Moderators cannot be muted');
  const ms = MUTE_MS[dur], now = Date.now(), until = ms < 0 ? -1 : now + ms;
  await redis([
    ms < 0 ? ['SET', `gc:mute:${m.a}`, '-1'] : ['SET', `gc:mute:${m.a}`, String(until), 'PX', String(ms)],
    ['HSET', MUTES, m.a, JSON.stringify({ until, n: m.n, by: byName[0] || 'Moderator', t: now })],
  ]);
}

// Page Owner : silences en cours (les expirés sont retirés au passage) et modérateurs, par pseudo.
async function ownerState() {
  const [h, mods] = await redis([['HGETALL', MUTES], ['SMEMBERS', MODS]]);
  const flat = h || [], rows = [], now = Date.now(), gone = [];
  for (let i = 0; i < flat.length; i += 2) { const r = parse(flat[i + 1]); if (!r || (r.until > 0 && r.until <= now)) gone.push(flat[i]); else rows.push({ id: flat[i], ...r }); }
  if (gone.length) await redis([['HDEL', MUTES, ...gone]]);
  const names = rows.length ? (await redis([['HMGET', 'names', ...rows.map(r => r.id)]]))[0] || [] : [];
  const modNames = (mods || []).length ? (await redis([['HMGET', 'names', ...mods]]))[0] || [] : [];
  return { mutes: rows.map((r, i) => ({ name: names[i] || r.n || 'Player', until: r.until, by: r.by, t: r.t })).sort((a, b) => b.t - a.t), mods: modNames.filter(Boolean).sort() };
}

// ---------------------------------------------------------------- point d'entrée (depuis api/friends.js)
async function handle(body) {
  const playerId = String(body.playerId || ''), secret = String(body.secret || '');
  let me = null, stats = {};
  if (isPlayerId(playerId) && /^[0-9a-f]{32}$/.test(secret)) {
    // Joueur pas encore connu du serveur (jamais tiré, pas de pseudo) : il lit quand même, comme un visiteur.
    if (await ownsPlayer(playerId, secret)) { me = playerId; stats = await readStats(me); }
    else if (body.action !== 'gcList') throw refuse(403, 'This player id belongs to someone else');
  }
  // Lecture : ouverte à tous (même sans joueur).
  if (body.action === 'gcList') return list(body, me, stats);
  if (!me) throw refuse(400, 'Invalid player');
  const owner = Number(stats.owner) >= 1, mod = owner || stats.gcMod === '1';
  if (body.action === 'gcSend') { await post(me, stats, body.text); return list({ since: body.since, del: body.del }, me, stats); }
  if (body.action === 'gcReport') {
    const { m } = await findMsg(body.id);
    return Reports.fileReport({ reporter: me, author: m.a, text: m.x, where: 'global chat', msgT: m.t });
  }
  if (['gcDelete', 'gcMute'].includes(body.action)) {
    if (!mod) throw refuse(403, 'Moderators only');
    const { entry, m } = await findMsg(body.id);
    if (body.action === 'gcMute') await mute(me, m, String(body.dur || ''));
    await remove(entry);
    return list({}, me, stats);
  }
  // Réservé au créateur : silences en cours, lever un silence, donner ou retirer le rôle de Modérateur (par pseudo).
  if (['gcAdmin', 'gcUnmute', 'gcModSet'].includes(body.action)) {
    if (!owner) throw refuse(403, 'Owner only');
    if (body.action !== 'gcAdmin') {
      const who = await findPlayer(String(body.name || '').slice(0, 40));
      if (!who) throw refuse(404, 'No player with this name');
      if (body.action === 'gcUnmute') await redis([['DEL', `gc:mute:${who}`], ['HDEL', MUTES, who]]);
      else await redis(body.on === false ? [['HDEL', statsKey(who), 'gcMod'], ['SREM', MODS, who]] : [['HSET', statsKey(who), 'gcMod', '1'], ['SADD', MODS, who]]);
    }
    return ownerState();
  }
  throw refuse(400, 'Unknown action');
}

module.exports = { handle, checkMessage, KEEP, MAX, MIN_ROLLS };
