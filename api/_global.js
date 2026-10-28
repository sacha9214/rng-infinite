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
// Ajouts du 2026-10-27 : réponses (r = { id, n, x } + ra = auteur cité, idée de Niall), grands tirages annoncés par le
// serveur (sys: 'roll', idée de R77 ; file gc:sysq), message épinglé par le créateur (gc:pin, idée de Big Sexy) et
// gc:gone = les 300 derniers messages supprimés ou modifiés (une citation ne montre jamais un texte retiré).
const crypto = require('node:crypto');
const { redis, ownsPlayer, readStats, statsKey, findPlayer, dayKey, nameKey } = require('./_lib');
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
  const text = normalize(raw);
  if (!text) throw refuse(422, 'Write a message first');
  if ([...text].length > MAX) throw refuse(422, `Messages are ${MAX} characters at most`);
  if (PERSONAL_RE[0].test(text)) throw refuse(422, SAFETY); // un e-mail avant les liens (il contient un domaine)
  if (LINK_RE.some(re => re.test(text))) throw refuse(422, LINK);
  if (PERSONAL_RE.some(re => re.test(text))) throw refuse(422, SAFETY);
  if (rude(text)) throw refuse(422, RUDE);
  return text;
}
// Emojis (idée de Deadshot, 2026-10-27) : le « liant » invisible U+200D colle les emojis composés (👨‍👩‍👧, 🏳️‍🌈, ❤️‍🔥).
// Il reste quand il est entre deux emojis ; partout ailleurs (entre des lettres, pour cacher un mot) il devient une espace.
const PICTO = /^[\p{Extended_Pictographic}\u{FE0F}\u{1F3FB}-\u{1F3FF}]$/u;
const charBefore = (s, i) => { const c = s.charCodeAt(i - 1); return c >= 0xdc00 && c <= 0xdfff ? s.slice(i - 2, i) : s.charAt(i - 1); };
const charAfter = (s, i) => (i + 1 < s.length ? String.fromCodePoint(s.codePointAt(i + 1)) : '');
function normalize(raw) {
  const s = String(raw == null ? '' : raw);
  return s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, (ch, i) => (ch === '‍' && PICTO.test(charBefore(s, i)) && PICTO.test(charAfter(s, i)) ? ch : ' '))
    .replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- @mentions (idée de casmictechthing, 2026-10-26)
// « @pseudo » d'un joueur qui existe : surligné chez tout le monde, et le joueur cité voit un point rouge sur 💬.
// Un @ qui ne correspond à aucun joueur reste refusé par le filtre (pseudos de réseaux sociaux). Pseudo sans espace,
// 5 au plus par message, lu par GET name:<clé> (jamais la recherche lente de findPlayer). On garde l'id des cités
// (m.at) pour savoir si le message est « pour moi », mais seuls les pseudos sortent d'ici (m.an).
const MENTION_RE = /(^|[\s(])@([\p{L}0-9_.\-']{2,20})/gu, MAX_MENTIONS = 5, AT_TTL = 7 * 86400;
const atKey = id => `gc:at:${id}`;
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function resolveMentions(text, me) {
  const tokens = [...new Set([...text.matchAll(MENTION_RE)].map(m => m[2].replace(/[.\-']+$/, '')).filter(x => x.length >= 2))].slice(0, MAX_MENTIONS);
  if (!tokens.length) return { ids: [], names: [], probe: text };
  const ids = await redis(tokens.map(x => ['GET', `name:${nameKey(x)}`]));
  const hit = tokens.map((x, i) => [x, ids[i]]).filter(([, id]) => id && isPlayerId(id));
  const [names] = hit.length ? await redis([['HMGET', 'names', ...hit.map(h => h[1])]]) : [[]];
  // Pour le filtre, « @Kiddo » d'un vrai joueur devient « Kiddo » : ce n'est pas un pseudo de réseau social.
  let probe = text;
  for (const [x] of hit) probe = probe.replace(new RegExp(`(^|[\\s(])@${reEsc(x)}`, 'giu'), (all, pre) => pre + x);
  const out = { ids: [], names: [], probe };
  hit.forEach(([, id], i) => { if (id !== me && !out.ids.includes(id)) { out.ids.push(id); out.names.push(names[i] || 'Player'); } });
  return out;
}
// Texte vérifié + mentions résolues (envoi et modification).
async function prepare(raw, me) {
  const text = normalize(raw);
  if ([...text].length > MAX) throw refuse(422, `Messages are ${MAX} characters at most`);
  const at = await resolveMentions(text, me);
  checkMessage(at.probe);
  return { text, at };
}
const mentionWrites = (ids, t) => ids.map(id => ['SET', atKey(id), String(t), 'EX', String(AT_TTL)]);

// ---------------------------------------------------------------- lecture
const EDIT_MS = 5 * 60000; // modifier son message : 5 minutes (idée de daddy finger, 2026-10-26)
// Message du serveur (grand tirage) : pas d'auteur, pas de texte libre ; le site écrit la phrase (et la traduit).
const view = (m, me, quote) => (m.sys ? { id: m.id, t: m.t, sys: m.sys, name: m.n || 'Player', n: m.v, tier: m.tr } : {
  id: m.id, t: m.t, name: m.n || 'Player', title: m.ti || null, text: m.x,
  ...(me && m.a === me ? { mine: true } : {}), ...(m.an && m.an.length ? { at: m.an } : {}),
  ...(me && ((Array.isArray(m.at) && m.at.includes(me)) || m.ra === me) ? { toMe: true } : {}), ...(m.e ? { edited: true } : {}),
  ...(m.r && quote ? { re: quote(m.r) } : {}) });
async function readAll() { const [raw] = await redis([['LRANGE', KEY, 0, -1]]); return (raw || []).map(parse).filter(Boolean); }

// ---------------------------------------------------------------- réponses (idée de Niall, 2026-10-27)
// Le message garde une petite référence { id, n: pseudo, x: ~60 premiers caractères }. À l'affichage, la citation suit
// l'original : encore là → son texte actuel ; supprimé → « deleted » sans aucun texte ; modifié puis sorti des 100 →
// sa nouvelle version (gc:gone). Le texte gardé ne sert que pour un original simplement trop ancien.
const QUOTE = 60, GONE = 'gc:gone', GONE_KEEP = 300;
const snip = x => { const c = [...String(x || '')]; return c.length > QUOTE ? `${c.slice(0, QUOTE).join('').trimEnd()}…` : c.join(''); };
const goneWrites = rows => rows.length ? [['RPUSH', GONE, ...rows.map(r => JSON.stringify(r))], ['LTRIM', GONE, -GONE_KEEP, -1]] : [];
async function quoter(msgs, all) {
  const live = new Map(all.map(m => [m.id, m])), gone = new Map();
  if (msgs.some(m => m.r && !live.has(m.r.id))) {
    const [raw] = await redis([['LRANGE', GONE, 0, -1]]);
    for (const g of (raw || []).map(parse).filter(Boolean)) gone.set(g.id, g); // le plus récent en dernier : il l'emporte
  }
  return r => {
    const o = live.get(r.id);
    if (o) return { id: r.id, name: o.n || 'Player', text: snip(o.x) };
    const g = gone.get(r.id);
    if (g && g.x == null) return { id: r.id, name: r.n || 'Player', gone: true };
    return { id: r.id, name: r.n || 'Player', text: g ? g.x : r.x };
  };
}

// ---------------------------------------------------------------- message épinglé (idée de Big Sexy, 2026-10-27)
// Un seul, posé ou retiré par le créateur. Une copie (il reste épinglé même sorti des 100 derniers), suivie quand
// l'original est modifié, retirée quand il est supprimé. Montré à tout le monde, lecteurs en lecture seule compris.
const PIN = 'gc:pin';
const pinCopy = m => { const c = { ...m }; delete c.a; delete c.at; delete c.ra; delete c.r; return c; };
const pinView = raw => { const p = parse(raw); return p ? view(p, null) : null; };

// ---------------------------------------------------------------- grands tirages (idée de R77, 2026-10-27)
// Divine ou mieux (comme la mention 🔔 Big Rolls du Discord, api/_discord.js), décidé ici à partir du tirage du serveur
// (api/_lib.js recordRoll). Annoncé 15 s plus tard (le joueur finit sa révélation avant que le chat la dévoile), au plus
// un toutes les 30 s pour tout le chat et un toutes les 10 min par joueur ; jamais pour un joueur rendu muet.
// La file gc:sysq (score = heure d'affichage) est vidée par la relecture du chat (list), sans requête en plus.
const BIG = ['divine', 'godlike', 'infinite'], SYSQ = 'gc:sysq', SYS_DELAY = 15000, SYS_GAP = 30000, SYS_PLAYER_GAP = 10 * 60000;
async function queueBigRoll(id, n, tier, t = Date.now()) {
  if (!BIG.includes(tier) || !isPlayerId(id)) return false;
  const [name, muted] = await redis([['HGET', 'names', id], ['GET', `gc:mute:${id}`]]);
  if (!name || muted) return false;
  const [mine] = await redis([['SET', `gc:sysp:${id}`, '1', 'PX', String(SYS_PLAYER_GAP), 'NX']]);
  if (mine !== 'OK') return false;
  const [all] = await redis([['SET', 'gc:sysrl', '1', 'PX', String(SYS_GAP), 'NX']]);
  if (all !== 'OK') { await redis([['DEL', `gc:sysp:${id}`]]); return false; }
  await redis([['ZADD', SYSQ, String(t + SYS_DELAY), JSON.stringify({ p: id, v: n, tr: tier, k: crypto.randomBytes(4).toString('hex') })]]);
  return true;
}
async function flushSys(due) {
  for (const member of due) {
    const [claimed] = await redis([['ZREM', SYSQ, member]]);
    if (Number(claimed) !== 1) continue; // un autre processus l'a pris
    const e = parse(member); if (!e || !isPlayerId(e.p)) continue;
    const [name, muted] = await redis([['HGET', 'names', e.p], ['GET', `gc:mute:${e.p}`]]);
    if (!name || muted) continue; // rendu muet entre-temps
    await append({ id: crypto.randomBytes(6).toString('hex'), sys: 'roll', n: name, v: Number(e.v), tr: e.tr });
  }
}
// Ajoute un message en fin de liste. Heure strictement croissante : « since » ne perd jamais un message écrit dans la
// même milliseconde.
async function append(m, extra = () => []) { // extra(t) : écritures de plus, avec l'heure du message
  const [last] = await redis([['LINDEX', KEY, -1]]);
  m.t = Math.max(Date.now(), ((parse(last) || {}).t || 0) + 1);
  await redis([['RPUSH', KEY, JSON.stringify(m)], ['LTRIM', KEY, -KEEP, -1], ['SET', REV, m.t], ...extra(m.t)]);
  return m;
}

// Mon statut : puis-je écrire, et sinon pourquoi ; suis-je muet (jusqu'à quand) ; suis-je modérateur.
async function meInfo(id, stats) {
  const [google, mute, lastAt] = await redis([['GET', `player:${id}:google`], ['GET', `gc:mute:${id}`], ['GET', atKey(id)]]);
  const rolls = Number(stats.rolls) || 0, owner = Number(stats.owner) >= 1, mod = owner || stats.gcMod === '1';
  const mutedUntil = mute ? Number(mute) : 0;
  // Sacha (2026-10-25) : plus besoin de compte Google, seulement 100 tirages.
  const reason = mutedUntil ? 'muted' : rolls < MIN_ROLLS ? 'rolls' : null;
  return { can: !reason, reason, rolls, need: MIN_ROLLS, google: !!google, mutedUntil, mod, owner, lastAt: Number(lastAt) || 0 };
}

// Relecture toutes les 3 s : réponse minuscule quand rien n'a changé (« same »). Après une suppression, la liste entière.
async function list(body, me, stats, again = false) {
  const [rev, del, pin, due] = await redis([['GET', REV], ['GET', DEL], ['GET', PIN], ['ZRANGEBYSCORE', SYSQ, '-inf', String(Date.now()), 'LIMIT', '0', '5']]);
  // Grand tirage arrivé à son heure : publié maintenant, puis relecture (une seule fois).
  if (due && due.length && !again) { await flushSys(due); return list(body, me, stats, true); }
  const out = { rev: Number(rev) || 0, del: Number(del) || 0, max: MAX, gap: GAP_MS, editMs: EDIT_MS, pin: pinView(pin) };
  if (me) out.me = await meInfo(me, stats);
  const since = Number(body.since) || 0, seenDel = Number(body.del) || 0;
  if (body.rev != null && Number(body.rev) === out.rev && seenDel === out.del) return { ...out, same: true };
  const all = await readAll();
  const full = !since || seenDel !== out.del;
  const msgs = full ? all : all.filter(m => m.t > since), quote = await quoter(msgs, all);
  return { ...out, full, msgs: msgs.map(m => view(m, me, quote)) };
}

// ---------------------------------------------------------------- écriture
async function post(me, stats, raw, replyTo) {
  const info = await meInfo(me, stats);
  if (info.reason === 'muted') throw refuse(403, info.mutedUntil < 0 ? 'You can no longer write in the chat' : 'You are muted for now');
  if (info.reason === 'rolls') throw refuse(403, `Make ${MIN_ROLLS} rolls to write in the chat (you have ${info.rolls})`);
  const { text, at } = await prepare(raw, me);
  if (!text) throw refuse(422, 'Write a message first');
  // Réponse (idée de Niall, 2026-10-27) : l'original doit encore être là, et ne pas être un message du serveur.
  let r = null, ra = null;
  if (replyTo) {
    const { m: o } = await findMsg(String(replyTo));
    if (o.sys) throw refuse(422, 'You cannot reply to this message');
    r = { id: o.id, n: o.n || 'Player', x: snip(o.x) };
    if (o.a && o.a !== me) ra = o.a; // l'auteur cité voit le point rouge, comme une @mention
  }
  const [ok] = await redis([['SET', `gc:rl:${me}`, '1', 'PX', GAP_MS, 'NX']]);
  if (ok !== 'OK') throw refuse(429, 'Wait 5 seconds between messages');
  const [names, title] = await redis([['HMGET', 'names', me], ['HGET', 'titles', me]]), name = (names || [])[0];
  const notify = ra && !at.ids.includes(ra) ? [...at.ids, ra] : at.ids;
  const m = { id: crypto.randomBytes(6).toString('hex'), a: me, n: name || 'Player', ti: title || null, x: text, ...(at.ids.length ? { at: at.ids, an: at.names } : {}), ...(r ? { r, ...(ra ? { ra } : {}) } : {}) };
  await append(m, t => [['HINCRBY', 'feat:gchat', dayKey(t), 1], ...mentionWrites(notify, t)]);
  return m;
}

// Modifier son message (idée de daddy finger, 2026-10-26) : 5 minutes, tous les filtres repassent. Remplacé par sa
// valeur (LINSERT puis LREM) et non par sa position : un message arrivé entre-temps décale les positions.
async function edit(me, stats, id, raw) {
  const info = await meInfo(me, stats);
  if (info.reason === 'muted') throw refuse(403, 'You are muted for now');
  const { entry, m } = await findMsg(id);
  if (m.a !== me) throw refuse(403, 'You can only edit your own messages');
  if (Date.now() - m.t >= EDIT_MS) throw refuse(422, 'Messages can be edited for 5 minutes');
  const { text, at } = await prepare(raw, me);
  if (!text) throw refuse(422, 'Write a message first');
  if (text === m.x) return;
  // Les cités déjà prévenus ne le sont pas une 2e fois ; seuls les nouveaux reçoivent le point rouge.
  const fresh = at.ids.filter(x => !(m.at || []).includes(x));
  const next = { ...m, x: text, e: 1 }; delete next.at; delete next.an;
  if (at.ids.length) Object.assign(next, { at: at.ids, an: at.names });
  const t = Date.now();
  const [ins, pin] = await redis([['LINSERT', KEY, 'BEFORE', entry, JSON.stringify(next)], ['GET', PIN]]);
  if (Number(ins) < 0) throw refuse(404, 'This message is gone');
  // DEL bouge aussi : les autres relisent la liste entière (une relecture « since » ne voit pas une modification).
  // Les réponses à ce message citent sa nouvelle version (gc:gone), et l'épinglé la suit.
  const pinned = (parse(pin) || {}).id === m.id ? [['SET', PIN, JSON.stringify(pinCopy(next))]] : [];
  await redis([['LREM', KEY, 1, entry], ['SET', REV, t], ['SET', DEL, t], ...mentionWrites(fresh, t), ...goneWrites([{ id: m.id, x: snip(text) }]), ...pinned]);
}

async function findMsg(id) {
  if (!/^[0-9a-f]{12}$/.test(String(id || ''))) throw refuse(400, 'Unknown message');
  const [raw] = await redis([['LRANGE', KEY, 0, -1]]);
  const entry = (raw || []).find(x => (parse(x) || {}).id === id);
  if (!entry) throw refuse(404, 'This message is gone');
  return { entry, m: parse(entry) };
}
// Supprimé : plus aucune citation ne montre son texte (gc:gone), et il n'est plus épinglé.
async function remove(entry) {
  const t = Date.now(), m = parse(entry) || {};
  const [pin] = await redis([['GET', PIN]]);
  await redis([['LREM', KEY, 1, entry], ['SET', REV, t], ['SET', DEL, t], ...goneWrites([{ id: m.id }]), ...((parse(pin) || {}).id === m.id ? [['DEL', PIN]] : [])]);
}

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
  if (body.action === 'gcSend') { await post(me, stats, body.text, body.replyTo); return list({ since: body.since, del: body.del }, me, stats); }
  if (body.action === 'gcReport') {
    const { m } = await findMsg(body.id);
    if (m.sys) throw refuse(422, 'You cannot report this message'); // message du serveur
    return Reports.fileReport({ reporter: me, author: m.a, text: m.x, where: 'global chat', msgT: m.t });
  }
  // Épingler / désépingler (idée de Big Sexy, 2026-10-27) : le créateur seul (pas les modérateurs ni les lecteurs).
  if (body.action === 'gcPin' || body.action === 'gcUnpin') {
    if (!owner) throw refuse(403, 'Owner only');
    if (body.action === 'gcUnpin') await redis([['DEL', PIN]]);
    else { const { m } = await findMsg(body.id); await redis([['SET', PIN, JSON.stringify(pinCopy(m))]]); }
    return list({}, me, stats);
  }
  if (body.action === 'gcEdit') { await edit(me, stats, String(body.id || ''), body.text); return list({}, me, stats); }
  if (['gcDelete', 'gcMute'].includes(body.action)) {
    const { entry, m } = await findMsg(body.id);
    // Supprimer son propre message (idée de daddy finger, 2026-10-26) ; le reste est réservé aux modérateurs.
    if (!mod && !(body.action === 'gcDelete' && m.a === me)) throw refuse(403, 'Moderators only');
    if (body.action === 'gcMute' && m.sys) throw refuse(422, 'This message was posted by the game');
    if (body.action === 'gcMute') await mute(me, m, String(body.dur || ''));
    await remove(entry);
    return list({}, me, stats);
  }
  // Réservé au créateur : silences en cours, lever un silence, donner ou retirer le rôle de Modérateur (par pseudo).
  if (['gcAdmin', 'gcUnmute', 'gcModSet'].includes(body.action)) {
    // Lecture seule (viewer) : la liste des silences et des modérateurs, sans rien changer (2026-10-26).
    if (!owner && body.action === 'gcAdmin' && require('./_lib').canViewOwner(stats)) return { ...(await ownerState()), readOnly: true };
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

module.exports = { handle, checkMessage, queueBigRoll, BIG, KEEP, MAX, MIN_ROLLS, EDIT_MS };
