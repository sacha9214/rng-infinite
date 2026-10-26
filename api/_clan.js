// Clans (idée de BIGBOIJONER69 et KMC, 2026-10-25). Atteint par /api/friends (action 'clan', op …) : api/ est déjà à
// 12 fonctions publiques.
//
// Règles :
//   - créer un clan coûte 10 000 pièces, détruites (eco out:clans). Nom de 3 à 20 caractères (nettoyé comme un pseudo,
//     unique sans accents ni majuscules), tag de 3 ou 4 lettres majuscules ou chiffres (unique), un emoji de la liste ;
//   - 20 membres au départ, jusqu'à 40 par paliers de 5 achetés avec le coffre ; un joueur n'est que dans un clan ;
//   - rôles : chef (leader), officiers, membres. Entrée sur invitation (un officier ou le chef invite par pseudo) ou sur
//     demande (un officier ou le chef accepte). Un officier exclut des membres, le chef exclut n'importe qui, promeut,
//     rétrograde, passe la main, dissout ;
//   - coffre : les membres y versent des pièces (10 à 10 000 par don, 10 dons par heure). Le coffre ne revient jamais
//     aux joueurs : le chef et les officiers le dépensent en améliorations qui détruisent les pièces (places, couleurs)
//     ou le mettent en jeu dans une guerre de clans. Historique gardé (50 lignes) ;
//   - chat du clan : mêmes règles que les messages entre amis (filtre, 140 caractères, 20 par minute, signalement vers
//     api/_reports.js), modification possible 10 minutes ;
//   - classement de la semaine : somme de l'XP gagnée par les membres cette semaine (comptée à chaque tirage dans
//     recordRoll, api/_lib.js). Au changement de semaine, les membres du clan n°1 qui ont roulé pour lui reçoivent le
//     titre Clan Champion (une seule fois par semaine, verrou NX comme les prix du mois dans api/_rank.js) ;
//   - guerres : un chef ou officier défie un autre clan, 5 contre 5, mise de 100 à 50 000 prise dans chaque coffre ;
//     chacun des 10 joueurs a 5 tirages (tirés par le serveur avec crypto.randomInt) pendant 6 heures, en tirages
//     partagés comme le tournoi (quand un joueur tire, son vis-à-vis reçoit un tirage s'il en a moins ; ceux qui
//     manquent sont tirés à la fin). Plus gros total d'XP gagne ; le vainqueur reçoit les deux mises moins 3 % détruits.
//
// Clés : clan:<cid> (hash : name, tag, emoji, leader, slots, vault, banner, tagc, war, wins, losses, t),
// clanm:<cid> (id → rôle), clanof (id → cid), clantag (id → « TAG|couleur », lu par les classements et les duels),
// clanname:<clé du nom> et clantagk:<TAG> (unicité), clans (set des cid), claninv:<id> (cid → heure),
// clanreq:<cid> (id → heure), clanlog:<cid> (coffre), clanchat:<cid> (messages), clanxp:<semaine> (zset cid → XP),
// clanxpm:<semaine>:<cid> (id → XP), war:<wid> (hash), war:<wid>:r (id → tirages).
// Les identifiants des joueurs ne sortent jamais d'ici : tout se fait par pseudo.
const crypto = require('node:crypto');
const { redis, eco, engine, readStats, statsKey, cleanName, nameKey, findPlayer, weekKey, dayKey, toObject } = require('./_lib');
const Shop = require('../js/shop.js');
const Reports = require('./_reports');
const { cleanChat, MAX_CHARS } = require('./_chat');
// Description du clan (demandée par Sacha, 2026-10-25, comme dans les grands jeux de clans) : 150 caractères, mêmes
// filtres que le chat global (liens, insultes, infos personnelles), modifiable par le chef et les officiers.
const DESC_MAX = 150;
function checkDesc(raw) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if ([...text].length > DESC_MAX) throw refuse(422, `Descriptions are ${DESC_MAX} characters at most`);
  return require('./_global').checkMessage(text);
}

const CREATE_COST = 10000, MIN_ROLLS = 30;
const SLOTS_BASE = 20, SLOTS_MAX = 40, SLOT_STEP = 5;
// Prix des paliers de places, de 20 → 25 jusqu'à 35 → 40 : de plus en plus chers.
const SLOT_PRICES = [5000, 10000, 20000, 40000];
const slotPrice = slots => SLOT_PRICES[(slots - SLOTS_BASE) / SLOT_STEP];
// Couleurs de bannière et de tag : des identifiants courts, la couleur est dans le CSS (.cl-b-<id>, .cl-c-<id>).
const BANNERS = ['slate', 'red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple', 'pink', 'black'];
const TAG_COLORS = ['plain', 'red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple', 'pink', 'rainbow'];
const BANNER_PRICE = 2000, TAGC_PRICE = 3000, RAINBOW_PRICE = 15000;
const EMOJIS = ['🛡️', '⚔️', '🐉', '🦁', '🐺', '🦅', '🔥', '❄️', '⚡', '🌙', '⭐', '💎', '👑', '🎲', '🍀', '🌊', '🌋', '🚀', '👾', '🤖', '🐸', '🦈', '🍕', '🎯'];
const DONATE = { min: 10, max: 10000, perHour: 10 };
const CHAT_KEEP = 100, CHAT_TTL = 7 * 86400, CHAT_PER_MIN = 20, CHAT_PER_DAY = 400, EDIT_MS = 10 * 60000;
const LOG_KEEP = 50, INVITE_TTL = 7 * 86400, MAX_REQUESTS = 30, MAX_INVITES = 20;
const WAR = { size: 5, rolls: 5, ms: 6 * 3600000, pendingMs: 24 * 3600000, min: 100, max: 50000, cut: 0.03, lastCall: 5000, cooldown: 1500 };
const WEEK_TTL = 40 * 86400;
const RANK = { member: 1, officer: 2, leader: 3 };

const refuse = (status, error) => Object.assign(new Error(error), { status });
const fmt = v => Number(v).toLocaleString('en-US');
const ckey = cid => `clan:${cid}`, mkey = cid => `clanm:${cid}`, reqKey = cid => `clanreq:${cid}`, invKey = id => `claninv:${id}`;
const logKey = cid => `clanlog:${cid}`, chatKey = cid => `clanchat:${cid}`;
const xpKey = week => `clanxp:${week}`, xpmKey = (week, cid) => `clanxpm:${week}:${cid}`;
const warKey = wid => `war:${wid}`, warRollsKey = wid => `war:${wid}:r`;
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };
const tagValue = c => `${c.tag}|${c.tagc || 'plain'}`;

// Verrou court (même principe que shop:<id> pour les achats) : quelques essais, puis « réessaie ».
async function locked(key, fn, busy = 'Busy, try again') {
  let lock = null;
  for (let tries = 0; tries < 25 && lock !== 'OK'; tries++) {
    if (tries) await new Promise(r => setTimeout(r, 60));
    [lock] = await redis([['SET', key, '1', 'PX', 5000, 'NX']]);
  }
  if (lock !== 'OK') throw refuse(429, busy);
  try { return await fn(); } finally { await redis([['DEL', key]]); }
}

async function loadClan(cid) {
  if (!cid) return null;
  const [flat, mflat] = await redis([['HGETALL', ckey(cid)], ['HGETALL', mkey(cid)]]);
  const h = toObject(flat);
  if (!h.tag) return null;
  const members = toObject(mflat);
  return { cid, ...h, slots: Number(h.slots) || SLOTS_BASE, vault: Number(h.vault) || 0, members };
}
const clanOf = async id => { const [cid] = await redis([['HGET', 'clanof', id]]); return cid || null; };
async function myClan(id) {
  const c = await loadClan(await clanOf(id));
  if (!c || !c.members[id]) return null;
  return c;
}
function need(c, id, role) {
  if (!c) throw refuse(422, 'You are not in a clan');
  if (RANK[c.members[id]] < RANK[role]) throw refuse(403, role === 'leader' ? 'Only the clan leader can do this' : 'Only the leader and officers can do this');
}
// Droits des officiers (idée de kaz, 2026-10-26) : le chef choisit ce que ses officiers peuvent faire. Rangé dans
// clan:<cid> (champ perms, JSON des droits retirés) ; par défaut tout est permis, comme avant. Le chef peut tout.
const PERMS = ['invite', 'kick', 'upgrade', 'war', 'edit'];
const permsOf = c => { const off = parse(c && c.perms) || {}; return Object.fromEntries(PERMS.map(k => [k, off[k] !== false])); };
const can = (c, id, perm) => !!c && (c.members[id] === 'leader' || (c.members[id] === 'officer' && permsOf(c)[perm]));
function needPerm(c, id, perm) {
  need(c, id, 'officer');
  if (!can(c, id, perm)) throw refuse(403, 'Your clan leader turned this off for officers');
}
const pushLog = (cid, entry) => [['RPUSH', logKey(cid), JSON.stringify({ ...entry, t: entry.t || Date.now() })], ['LTRIM', logKey(cid), -LOG_KEEP, -1]];

// Nom et tag : nettoyés comme un pseudo, sans mot filtré par le chat (un tag « FUKK » ne passe pas non plus).
function checkName(raw) {
  const name = cleanName(raw);
  if (name.length < 3) throw refuse(422, 'Clan names need 3 to 20 letters or digits');
  if (cleanChat(name) !== name) throw refuse(422, 'Pick another clan name');
  return name;
}
function checkTag(raw) {
  const tag = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(tag)) throw refuse(422, 'Tags are 3 or 4 capital letters or digits');
  if (cleanChat(tag.toLowerCase()) !== tag.toLowerCase()) throw refuse(422, 'Pick another tag');
  return tag;
}

// ---------------------------------------------------------------- création, entrée, sortie
async function create(me, body) {
  const name = checkName(body.clanName), tag = checkTag(body.tag), emoji = EMOJIS.includes(body.emoji) ? body.emoji : EMOJIS[0], desc = checkDesc(body.desc);
  if (await clanOf(me)) throw refuse(409, 'You are already in a clan');
  return locked(`shop:${me}`, async () => {
    const st = await readStats(me), coins = Shop.balance(st), rolls = Number(st.rolls) || 0;
    if (rolls < MIN_ROLLS) throw refuse(422, `Clans unlock after ${MIN_ROLLS} rolls (you have ${rolls})`);
    if (coins < CREATE_COST) throw refuse(422, `A clan costs ${fmt(CREATE_COST)} coins: ${fmt(CREATE_COST - coins)} more needed`);
    const cid = crypto.randomBytes(5).toString('hex'), nk = `clanname:${nameKey(name)}`, tk = `clantagk:${tag}`;
    const [n1, t1] = await redis([['SET', nk, cid, 'NX'], ['SET', tk, cid, 'NX']]);
    if (n1 !== 'OK' || t1 !== 'OK') {
      await redis([...(n1 === 'OK' ? [['DEL', nk]] : []), ...(t1 === 'OK' ? [['DEL', tk]] : [])]);
      throw refuse(409, n1 !== 'OK' ? 'This clan name is taken' : 'This tag is taken');
    }
    const [mine] = await redis([['HSETNX', 'clanof', me, cid]]);
    if (Number(mine) !== 1) { await redis([['DEL', nk], ['DEL', tk]]); throw refuse(409, 'You are already in a clan'); }
    const t = Date.now(), [myName] = await redis([['HGET', 'names', me]]);
    await redis([
      ['HSET', ckey(cid), 'name', name, 'tag', tag, 'emoji', emoji, 'leader', me, 'slots', SLOTS_BASE, 'vault', 0, 'banner', 'slate', 'tagc', 'plain', 't', t, 'desc', desc],
      ['HSET', mkey(cid), me, 'leader'], ['HSET', 'clantag', me, `${tag}|plain`], ['SADD', 'clans', cid],
      ['HINCRBY', statsKey(me), 'spent', CREATE_COST], ['HINCRBY', statsKey(me), 'clanSpent', CREATE_COST], ['DEL', invKey(me)],
      ...pushLog(cid, { k: 'create', n: myName || 'Player', a: 0, t }), ...eco('out:clans', CREATE_COST, t),
    ]);
    return cid;
  }, 'One purchase at a time');
}

// Entrée d'un joueur (invitation acceptée ou demande acceptée), sous le verrou du clan : jamais plus que les places.
async function admit(cid, id, byName) {
  return locked(`clanlock:${cid}`, async () => {
    const c = await loadClan(cid);
    if (!c) throw refuse(404, 'This clan is gone');
    if (Object.keys(c.members).length >= c.slots) throw refuse(422, 'This clan is full');
    const [ok] = await redis([['HSETNX', 'clanof', id, cid]]);
    if (Number(ok) !== 1) throw refuse(409, (await clanOf(id)) === cid ? 'Already in this clan' : 'This player is already in a clan');
    const [name] = await redis([['HGET', 'names', id]]);
    await redis([['HSET', mkey(cid), id, 'member'], ['HSET', 'clantag', id, tagValue(c)], ['HDEL', reqKey(cid), id], ['DEL', invKey(id)],
      ...pushLog(cid, { k: 'join', n: name || 'Player', by: byName || null })]);
  });
}

// Sortie (départ, exclusion) : le joueur n'a plus de clan, ses demandes restent ailleurs.
async function removeMember(c, id, kind, byName) {
  const [name] = await redis([['HGET', 'names', id]]);
  await redis([['HDEL', mkey(c.cid), id], ['HDEL', 'clanof', id], ['HDEL', 'clantag', id], ...pushLog(c.cid, { k: kind, n: name || 'Player', by: byName || null })]);
}

async function disband(c, t = Date.now()) {
  if (c.war) {
    const w = await loadWar(c.war);
    if (w && w.st === 'running') throw refuse(422, 'Finish your clan war first');
    if (w && w.st === 'pending') await closeWar(w, 'off', t);
  }
  const ids = Object.keys(c.members);
  await redis([
    ...ids.flatMap(id => [['HDEL', 'clanof', id], ['HDEL', 'clantag', id]]),
    ['DEL', ckey(c.cid)], ['DEL', mkey(c.cid)], ['DEL', reqKey(c.cid)], ['DEL', chatKey(c.cid)], ['DEL', logKey(c.cid)],
    ['DEL', `clanname:${nameKey(c.name)}`], ['DEL', `clantagk:${c.tag}`], ['SREM', 'clans', c.cid], ['ZREM', xpKey(weekKey(t)), c.cid],
    ...eco('out:clans', c.vault, t), // le coffre restant disparaît avec le clan
  ]);
}

// ---------------------------------------------------------------- coffre et améliorations
async function donate(me, c, raw) {
  const amount = raw;
  if (!Number.isInteger(amount) || amount < DONATE.min || amount > DONATE.max) throw refuse(400, `Donate between ${DONATE.min} and ${fmt(DONATE.max)} coins`);
  return locked(`shop:${me}`, async () => {
    const st = await readStats(me), coins = Shop.balance(st), rolls = Number(st.rolls) || 0;
    if (rolls < MIN_ROLLS) throw refuse(422, `Donations unlock after ${MIN_ROLLS} rolls (you have ${rolls})`);
    if (coins < amount) throw refuse(422, `Not enough coins: ${fmt(amount - coins)} more needed`);
    const t = Date.now(), hour = `clandon:${me}:${Math.floor(t / 3600000)}`;
    const [n] = await redis([['INCR', hour], ['EXPIRE', hour, 7200]]);
    if (Number(n) > DONATE.perHour) throw refuse(429, `${DONATE.perHour} donations per hour at most: try again later`);
    // Toujours membre (il a pu être exclu entre-temps) : le don ne part que s'il l'est encore.
    const [role] = await redis([['HGET', mkey(c.cid), me]]);
    if (!role) throw refuse(422, 'You are not in a clan');
    const [name] = await redis([['HGET', 'names', me]]);
    await redis([['HINCRBY', statsKey(me), 'spent', amount], ['HINCRBY', statsKey(me), 'clanDonated', amount], ['HINCRBY', ckey(c.cid), 'vault', amount],
      ...pushLog(c.cid, { k: 'donate', n: name || 'Player', a: amount, t })]);
    return amount;
  }, 'One purchase at a time');
}

// Dépense du coffre (amélioration ou mise de guerre) : sous le verrou du clan, refusée si le coffre ne suffit pas.
async function spendVault(cid, cost, entry, destroy, t = Date.now()) {
  const [v] = await redis([['HGET', ckey(cid), 'vault']]);
  if ((Number(v) || 0) < cost) throw refuse(422, `The clan vault needs ${fmt(cost - (Number(v) || 0))} more coins`);
  await redis([['HINCRBY', ckey(cid), 'vault', -cost], ...pushLog(cid, { ...entry, a: -cost, t }), ...(destroy ? eco('out:clans', cost, t) : [])]);
}

async function upgrade(me, c, body) {
  needPerm(c, me, 'upgrade');
  const [myName] = await redis([['HGET', 'names', me]]), by = myName || 'Player';
  return locked(`clanlock:${c.cid}`, async () => {
    const now = await loadClan(c.cid);
    if (body.what === 'slots') {
      if (now.slots >= SLOTS_MAX) throw refuse(422, `Your clan already has ${SLOTS_MAX} member slots`);
      const price = slotPrice(now.slots);
      await spendVault(c.cid, price, { k: 'buy', x: `slots:${now.slots + SLOT_STEP}`, n: by }, true);
      await redis([['HSET', ckey(c.cid), 'slots', now.slots + SLOT_STEP]]);
      return;
    }
    if (body.what === 'banner') {
      if (!BANNERS.includes(body.color)) throw refuse(400, 'Unknown color');
      if (now.banner === body.color) throw refuse(422, 'Your banner already has this color');
      await spendVault(c.cid, BANNER_PRICE, { k: 'buy', x: `banner:${body.color}`, n: by }, true);
      await redis([['HSET', ckey(c.cid), 'banner', body.color]]);
      return;
    }
    if (body.what === 'tagc') {
      if (!TAG_COLORS.includes(body.color)) throw refuse(400, 'Unknown color');
      if (now.tagc === body.color) throw refuse(422, 'Your tag already has this color');
      await spendVault(c.cid, body.color === 'rainbow' ? RAINBOW_PRICE : TAGC_PRICE, { k: 'buy', x: `tagc:${body.color}`, n: by }, true);
      const ids = Object.keys(now.members);
      await redis([['HSET', ckey(c.cid), 'tagc', body.color], ...ids.map(id => ['HSET', 'clantag', id, `${now.tag}|${body.color}`])]);
      return;
    }
    throw refuse(400, 'Unknown upgrade');
  });
}

// ---------------------------------------------------------------- chat du clan (mêmes règles que api/friends.js)
async function chatView(me, c) {
  const [raw] = await redis([['LRANGE', chatKey(c.cid), 0, -1]]);
  const rows = (raw || []).map(parse).filter(Boolean);
  const ids = [...new Set(rows.map(m => m.s))];
  const [names] = ids.length ? await redis([['HMGET', 'names', ...ids]]) : [[]];
  const nameOf = Object.fromEntries(ids.map((id, i) => [id, names[i] || 'Player']));
  const canMod = RANK[c.members[me]] >= RANK.officer, now = Date.now();
  return {
    max: MAX_CHARS, editMs: EDIT_MS,
    messages: rows.map(m => ({ t: m.t, name: nameOf[m.s], role: c.members[m.s] || null, me: m.s === me, text: String(m.x || ''), ...(m.e ? { edited: true } : {}),
      ...(m.s === me && now - m.t < EDIT_MS ? { canEdit: true } : {}), ...(m.s === me || (canMod && RANK[c.members[m.s]] !== RANK.leader) ? { canDelete: true } : {}) })),
  };
}
async function chatSend(me, c, raw) {
  const text = cleanChat(raw);
  if (!text) throw refuse(422, 'Write a message first');
  const t = Date.now(), minute = Math.floor(t / 60000);
  const [perMin, perDay] = await redis([['INCR', `clanrate:${me}:${minute}`], ['INCR', `clanrate:${me}:${dayKey(t)}`], ['EXPIRE', `clanrate:${me}:${minute}`, 120], ['EXPIRE', `clanrate:${me}:${dayKey(t)}`, 2 * 86400]]);
  if (Number(perMin) > CHAT_PER_MIN || Number(perDay) > CHAT_PER_DAY) throw refuse(429, 'Slow down: too many messages');
  await redis([['RPUSH', chatKey(c.cid), JSON.stringify({ s: me, x: text, t })], ['LTRIM', chatKey(c.cid), -CHAT_KEEP, -1], ['EXPIRE', chatKey(c.cid), CHAT_TTL]]);
}
async function findMsg(c, t) {
  const [raw] = await redis([['LRANGE', chatKey(c.cid), 0, -1]]);
  const k = (raw || []).findIndex(x => { const m = parse(x); return m && Number(m.t) === Number(t); });
  return k < 0 ? null : { k, raw: raw[k], m: parse(raw[k]) };
}

// ---------------------------------------------------------------- classement de la semaine et titre
let settledWeek = '';
const prevWeek = t => weekKey(t - 7 * 86400000);
async function settleWeek(t = Date.now()) {
  const week = prevWeek(t);
  if (settledWeek === week) return;
  // Une seule remise par semaine, même avec deux processus : le premier qui pose le verrou remet le titre.
  const [first] = await redis([['SET', `clanweek:done:${week}`, String(t), 'NX', 'EX', 90 * 86400]]);
  if (first === 'OK') {
    const [top] = await redis([['ZREVRANGE', xpKey(week), 0, 0, 'WITHSCORES']]);
    if (top && top.length && Number(top[1]) > 0) {
      const cid = top[0], [ids] = await redis([['HKEYS', xpmKey(week, cid)]]);
      const w = [['HSET', 'clanweek', week, cid], ['HINCRBY', ckey(cid), 'weekWins', 1]];
      // Les membres qui ont roulé pour le clan cette semaine-là (même partis depuis) : titre Clan Champion.
      for (const id of ids || []) w.push(['HINCRBY', statsKey(id), 'clanWeekWins', 1]);
      await redis(w);
      try { const [[cname, ctag]] = await redis([['HMGET', ckey(cid), 'name', 'tag']]); require('./_discord').announceClanWeek({ clan: `${cname || 'A clan'} [${ctag || '?'}]`, week, members: (ids || []).length }); } catch (e) { /* Discord facultatif */ }
    }
  }
  settledWeek = week;
}

async function board(t = Date.now(), limit = 20) {
  const week = weekKey(t), [flat, lastCid] = await redis([['ZREVRANGE', xpKey(week), 0, limit - 1, 'WITHSCORES'], ['HGET', 'clanweek', prevWeek(t)]]);
  const rows = [];
  for (let i = 0; i < (flat || []).length; i += 2) rows.push([flat[i], Number(flat[i + 1])]);
  const cids = [...rows.map(r => r[0]), ...(lastCid ? [lastCid] : [])];
  const info = cids.length ? await redis(cids.flatMap(cid => [['HMGET', ckey(cid), 'name', 'tag', 'emoji', 'banner', 'tagc', 'slots', 'desc'], ['HLEN', mkey(cid)]])) : [];
  const card = i => { const [name, tag, emoji, banner, tagc, slots, desc] = info[2 * i] || []; return tag ? { name, tag, emoji, desc: desc || '', banner, tagc, members: Number(info[2 * i + 1]) || 0, slots: Number(slots) || SLOTS_BASE } : null; };
  return {
    week, end: weekEnd(t),
    clans: rows.map((r, i) => (card(i) ? { rank: i + 1, xp: r[1], ...card(i) } : null)).filter(Boolean),
    last: lastCid ? card(rows.length) : null,
  };
}
// Fin de la semaine ISO en cours (lundi suivant, 00:00 UTC).
function weekEnd(t) { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + (8 - (d.getUTCDay() || 7))); return d.getTime(); }

// Clans à rejoindre (recherche par nom ou tag, sinon les plus actifs de la semaine puis les plus récents).
async function search(q) {
  const [cids] = await redis([['SMEMBERS', 'clans']]);
  if (!cids || !cids.length) return [];
  const info = await redis(cids.flatMap(cid => [['HMGET', ckey(cid), 'name', 'tag', 'emoji', 'banner', 'tagc', 'slots', 't', 'desc'], ['HLEN', mkey(cid)], ['ZSCORE', xpKey(weekKey(Date.now())), cid]]));
  const needle = String(q || '').trim().toLowerCase();
  return cids.map((cid, i) => { const [name, tag, emoji, banner, tagc, slots, t, desc] = info[3 * i] || []; return tag ? { name, tag, emoji, desc: desc || '', banner, tagc, slots: Number(slots) || SLOTS_BASE, members: Number(info[3 * i + 1]) || 0, xp: Number(info[3 * i + 2]) || 0, t: Number(t) || 0 } : null; })
    .filter(c => c && (!needle || c.name.toLowerCase().includes(needle) || c.tag.toLowerCase().includes(needle)))
    .sort((a, b) => b.xp - a.xp || b.t - a.t).slice(0, 30).map(({ t, ...c }) => c);
}

// ---------------------------------------------------------------- guerres de clans
async function loadWar(wid) {
  if (!wid) return null;
  const [flat, rflat] = await redis([['HGETALL', warKey(wid)], ['HGETALL', warRollsKey(wid)]]);
  const h = toObject(flat);
  if (!h.a) return null;
  const rolls = {};
  for (const [k, v] of Object.entries(toObject(rflat))) rolls[k] = parse(v);
  return { wid, ...h, stake: Number(h.stake) || 0, ta: parse(h.ta) || [], tb: parse(h.tb) || [], start: Number(h.start) || 0, end: Number(h.end) || 0, t: Number(h.t) || 0, rolls };
}
const total = x => (x ? x.s.reduce((a, b) => a + b, 0) : 0);
const best = x => (x && x.s.length ? Math.max(...x.s) : 0);
const sideTotal = (w, team) => team.reduce((a, id) => a + total(w.rolls[id]), 0);
const sideBest = (w, team) => Math.max(0, ...team.map(id => best(w.rolls[id])));

// Équipe choisie : 5 pseudos différents, tous membres du clan.
async function pickTeam(c, names) {
  if (!Array.isArray(names) || names.length !== WAR.size) throw refuse(422, `Pick ${WAR.size} members`);
  const ids = [];
  for (const raw of names) {
    const id = await findPlayer(cleanName(raw));
    if (!id || !c.members[id]) throw refuse(422, `${cleanName(raw) || 'This player'} is not in your clan`);
    if (ids.includes(id)) throw refuse(422, 'Pick 5 different members');
    ids.push(id);
  }
  return ids;
}

// Fin d'une guerre en attente (refusée, annulée, expirée) : la mise du clan qui défie lui revient, une seule fois.
async function closeWar(w, why, t = Date.now()) {
  const [first] = await redis([['HSETNX', warKey(w.wid), 'closed', why]]);
  if (Number(first) !== 1) return false;
  const [aWar, bWar] = await redis([['HGET', ckey(w.a), 'war'], ['HGET', ckey(w.b), 'war']]);
  const [aExists] = await redis([['EXISTS', ckey(w.a)]]);
  await redis([['HSET', warKey(w.wid), 'st', 'off'],
    ...(Number(aExists) ? [['HINCRBY', ckey(w.a), 'vault', w.stake], ...pushLog(w.a, { k: 'refund', a: w.stake, x: why, t })] : eco('out:clans', w.stake, t)),
    ...(aWar === w.wid ? [['HDEL', ckey(w.a), 'war']] : []), ...(bWar === w.wid ? [['HDEL', ckey(w.b), 'war']] : [])]);
  return true;
}

async function challenge(me, c, body, t = Date.now()) {
  needPerm(c, me, 'war');
  const stake = body.stake;
  if (!Number.isInteger(stake) || stake < WAR.min || stake > WAR.max) throw refuse(400, `Stakes go from ${WAR.min} to ${fmt(WAR.max)} coins`);
  const tag = String(body.target || '').trim().toUpperCase();
  const [bid] = await redis([['GET', `clantagk:${tag}`]]);
  if (!bid) throw refuse(404, 'No clan with this tag');
  if (bid === c.cid) throw refuse(422, 'That is your clan');
  const b = await loadClan(bid);
  if (!b) throw refuse(404, 'No clan with this tag');
  if (Object.keys(b.members).length < WAR.size) throw refuse(422, `${b.name} needs ${WAR.size} members for a war`);
  const team = await pickTeam(c, body.team);
  const wid = crypto.randomBytes(6).toString('hex');
  return locked(`clanlock:${c.cid}`, async () => {
    // Une guerre à la fois par clan, des deux côtés (posée avec HSETNX, retirée si l'autre est déjà pris).
    const [okA] = await redis([['HSETNX', ckey(c.cid), 'war', wid]]);
    if (Number(okA) !== 1) throw refuse(409, 'Your clan already has a war going on');
    const [okB] = await redis([['HSETNX', ckey(bid), 'war', wid]]);
    if (Number(okB) !== 1) { await redis([['HDEL', ckey(c.cid), 'war']]); throw refuse(409, `${b.name} already has a war going on`); }
    try {
      const [myName] = await redis([['HGET', 'names', me]]);
      await spendVault(c.cid, stake, { k: 'stake', x: b.tag, n: myName || 'Player' }, false, t);
      await redis([['HSET', warKey(wid), 'a', c.cid, 'b', bid, 'stake', stake, 'st', 'pending', 't', t, 'by', myName || 'Player', 'ta', JSON.stringify(team)], ['EXPIRE', warKey(wid), 30 * 86400],
        ['RPUSH', `clanwars:${c.cid}`, wid], ['LTRIM', `clanwars:${c.cid}`, -20, -1], ['RPUSH', `clanwars:${bid}`, wid], ['LTRIM', `clanwars:${bid}`, -20, -1]]);
    } catch (err) {
      await redis([['HDEL', ckey(c.cid), 'war'], ['HDEL', ckey(bid), 'war']]);
      throw err;
    }
    return wid;
  });
}

async function answer(me, c, body, t = Date.now()) {
  needPerm(c, me, 'war');
  const w = await loadWar(c.war);
  if (!w || w.st !== 'pending') throw refuse(404, 'No war to answer');
  if (body.yes === false) {
    if (w.b !== c.cid && w.a !== c.cid) throw refuse(404, 'No war to answer');
    await closeWar(w, w.a === c.cid ? 'cancelled' : 'declined', t);
    return;
  }
  if (w.b !== c.cid) throw refuse(422, 'Wait for the other clan to answer');
  const team = await pickTeam(c, body.team);
  return locked(`clanlock:${c.cid}`, async () => {
    const [v] = await redis([['HGET', ckey(c.cid), 'vault']]);
    if ((Number(v) || 0) < w.stake) throw refuse(422, `The clan vault needs ${fmt(w.stake - (Number(v) || 0))} more coins`);
    // Accepter et refuser se disputent le même HSETNX : un seul des deux passe.
    const [first] = await redis([['HSETNX', warKey(w.wid), 'closed', 'accepted']]);
    if (Number(first) !== 1) throw refuse(409, 'This war was already answered');
    const [myName] = await redis([['HGET', 'names', me]]);
    const [aTag] = await redis([['HGET', ckey(w.a), 'tag']]);
    await redis([['HINCRBY', ckey(c.cid), 'vault', -w.stake], ...pushLog(c.cid, { k: 'stake', x: aTag || '', n: myName || 'Player', a: -w.stake, t }),
      ['HSET', warKey(w.wid), 'st', 'running', 'tb', JSON.stringify(team), 'start', t, 'end', t + WAR.ms]]);
  });
}

// Fait avancer une guerre : attente expirée, ou fin de la fenêtre (tirages manquants, vainqueur, paiement unique).
async function advanceWar(wid, now = Date.now()) {
  let w = await loadWar(wid);
  if (!w) return null;
  if (w.st === 'pending' && now > w.t + WAR.pendingMs) { await closeWar(w, 'expired', now); return loadWar(wid); }
  if (w.st !== 'running' || now < w.end) return w;
  const [lock] = await redis([['SET', `warfill:${wid}`, '1', 'EX', 30 * 86400, 'NX']]);
  if (lock === 'OK') {
    const writes = [];
    for (const id of [...w.ta, ...w.tb]) {
      const x = w.rolls[id] || { n: [], s: [] };
      if (x.s.length >= WAR.rolls) continue;
      while (x.s.length < WAR.rolls) { const n = crypto.randomInt(0, 1000001); x.n.push(n); x.s.push(engine.analyze(n).total); x.auto = (x.auto || 0) + 1; }
      writes.push(['HSET', warRollsKey(wid), id, JSON.stringify(x)]);
    }
    if (writes.length) await redis([...writes, ['EXPIRE', warRollsKey(wid), 30 * 86400]]);
    w = await loadWar(wid);
    await payWar(w, now);
  }
  return loadWar(wid);
}

// Vainqueur : plus gros total d'XP, puis plus gros tirage, puis un tirage au sort fixé par la guerre (le même pour tous).
function warWinner(w) {
  const sa = sideTotal(w, w.ta), sb = sideTotal(w, w.tb);
  if (sa !== sb) return sa > sb ? w.a : w.b;
  const ba = sideBest(w, w.ta), bb = sideBest(w, w.tb);
  if (ba !== bb) return ba > bb ? w.a : w.b;
  return crypto.createHash('sha256').update(w.wid).digest()[0] & 1 ? w.a : w.b;
}
async function payWar(w, now = Date.now()) {
  const [first] = await redis([['HSETNX', warKey(w.wid), 'paid', now]]);
  if (Number(first) !== 1) return false;
  const win = warWinner(w), lose = win === w.a ? w.b : w.a, pot = 2 * w.stake, cut = Math.floor(pot * WAR.cut), prize = pot - cut;
  const [winTag, loseTag, winExists, aWar, bWar] = await redis([['HGET', ckey(win), 'tag'], ['HGET', ckey(lose), 'tag'], ['EXISTS', ckey(win)], ['HGET', ckey(w.a), 'war'], ['HGET', ckey(w.b), 'war']]);
  await redis([
    ['HSET', warKey(w.wid), 'st', 'done', 'w', win, 'sa', sideTotal(w, w.ta), 'sb', sideTotal(w, w.tb), 'cut', cut],
    ...(Number(winExists) ? [['HINCRBY', ckey(win), 'vault', prize], ['HINCRBY', ckey(win), 'wins', 1], ...pushLog(win, { k: 'won', x: loseTag || '', a: prize, t: now })] : eco('out:clans', prize, now)),
    ['HINCRBY', ckey(lose), 'losses', 1], ...pushLog(lose, { k: 'lost', x: winTag || '', a: 0, t: now }),
    ...(aWar === w.wid ? [['HDEL', ckey(w.a), 'war']] : []), ...(bWar === w.wid ? [['HDEL', ckey(w.b), 'war']] : []),
    ...eco('out:clans', cut, now),
  ]);
  // Annonce dans #⚔️・clan-wars (2026-10-26) : une seule fois, grâce au HSETNX « paid » plus haut.
  try {
    const [[winName], [loseName]] = await redis([['HMGET', ckey(win), 'name'], ['HMGET', ckey(lose), 'name']]);
    const sa = sideTotal(w, w.ta), sb = sideTotal(w, w.tb);
    require('./_discord').announceClanWar({ win: `${winName || 'A clan'} [${winTag || '?'}]`, lose: `${loseName || 'a clan'} [${loseTag || '?'}]`, prize: Number(winExists) ? prize : 0, scoreWin: win === w.a ? sa : sb, scoreLose: win === w.a ? sb : sa });
  } catch (e) { /* Discord facultatif */ }
  return true;
}

async function warRoll(me, c, now = Date.now()) {
  if (!c || !c.war) throw refuse(422, 'Your clan has no war going on');
  const w = await advanceWar(c.war, now);
  if (!w || w.st !== 'running') throw refuse(422, 'Your clan has no war going on');
  if (now >= w.end - WAR.lastCall) throw refuse(422, 'This war is over');
  const mineSide = w.ta.includes(me) ? w.ta : w.tb.includes(me) ? w.tb : null;
  if (!mineSide) throw refuse(422, 'You are not in the war team');
  const i = mineSide.indexOf(me), opp = (mineSide === w.ta ? w.tb : w.ta)[i];
  const [lock] = await redis([['SET', `warlock:${me}`, '1', 'PX', WAR.cooldown, 'NX']]);
  if (lock !== 'OK') throw refuse(429, 'Too fast, wait for the reveal to finish');
  // Relu sous le verrou : deux onglets ne dépassent jamais les 5 tirages.
  const [raw, oraw] = await redis([['HGET', warRollsKey(w.wid), me], ['HGET', warRollsKey(w.wid), opp]]);
  const mine = parse(raw) || { n: [], s: [] };
  if (mine.s.length >= WAR.rolls) throw refuse(409, `Your ${WAR.rolls} rolls are done`);
  const n = crypto.randomInt(0, 1000001), s = engine.analyze(n).total;
  mine.n.push(n); mine.s.push(s);
  const writes = [['HSET', warRollsKey(w.wid), me, JSON.stringify(mine)]];
  // Tirage partagé : le vis-à-vis de l'autre clan en reçoit un s'il en a moins (comme le tournoi).
  const theirs = parse(oraw) || { n: [], s: [] };
  if (theirs.s.length < mine.s.length) {
    const on = crypto.randomInt(0, 1000001);
    theirs.n.push(on); theirs.s.push(engine.analyze(on).total); theirs.auto = (theirs.auto || 0) + 1;
    writes.push(['HSET', warRollsKey(w.wid), opp, JSON.stringify(theirs)]);
  }
  await redis([...writes, ['EXPIRE', warRollsKey(w.wid), 30 * 86400]]);
  return { n, s, count: mine.s.length, total: total(mine) };
}

// Ce qu'un membre voit d'une guerre : les deux clans, les équipes par pseudo, tirages et totaux.
async function warView(w, me, cid) {
  if (!w) return null;
  const ids = [...w.ta, ...w.tb];
  const [[names], info] = await Promise.all([ids.length ? redis([['HMGET', 'names', ...ids]]) : [[]], redis([['HMGET', ckey(w.a), 'name', 'tag', 'emoji'], ['HMGET', ckey(w.b), 'name', 'tag', 'emoji']])]);
  const nameOf = id => names[ids.indexOf(id)] || 'Player';
  const side = (team, k) => ({ name: (info[k] || [])[0] || 'Clan', tag: (info[k] || [])[1] || '???', emoji: (info[k] || [])[2] || '🛡️', mine: (k === 0 ? w.a : w.b) === cid,
    total: sideTotal(w, team), players: team.map(id => { const x = w.rolls[id]; return { name: nameOf(id), me: id === me, rolls: x ? x.n : [], scores: x ? x.s : [], total: total(x), auto: x ? x.auto || 0 : 0 }; }) });
  return {
    st: w.st, stake: w.stake, rolls: WAR.rolls, by: w.by, t: w.t, start: w.start, end: w.end, expires: w.t + WAR.pendingMs, cut: WAR.cut,
    a: side(w.ta, 0), b: { ...side(w.tb, 1), picked: w.tb.length > 0 },
    incoming: w.b === cid, won: w.st === 'done' ? w.w === cid : null, closed: w.closed || null,
  };
}

// ---------------------------------------------------------------- vue d'un joueur
async function view(me, now = Date.now()) {
  await settleWeek(now);
  const c = await myClan(me);
  const out = { me: { inClan: !!c }, prices: { create: CREATE_COST, banner: BANNER_PRICE, tagc: TAGC_PRICE, rainbow: RAINBOW_PRICE, slots: SLOT_PRICES, slotStep: SLOT_STEP, slotsMax: SLOTS_MAX, slotsBase: SLOTS_BASE },
    emojis: EMOJIS, banners: BANNERS, tagColors: TAG_COLORS, donate: DONATE, war: { size: WAR.size, rolls: WAR.rolls, ms: WAR.ms, min: WAR.min, max: WAR.max, cut: WAR.cut }, minRolls: MIN_ROLLS, now };
  if (!c) {
    // Sans clan : ses invitations, et les clans où il a demandé à entrer.
    const [inv] = await redis([['HGETALL', invKey(me)]]);
    const cids = []; for (let i = 0; i < (inv || []).length; i += 2) if (now - Number(inv[i + 1]) < INVITE_TTL * 1000) cids.push(inv[i]);
    const info = cids.length ? await redis(cids.flatMap(cid => [['HMGET', ckey(cid), 'name', 'tag', 'emoji', 'banner', 'tagc', 'slots', 'desc'], ['HLEN', mkey(cid)]])) : [];
    out.invites = cids.map((cid, i) => { const [name, tag, emoji, banner, tagc, slots, desc] = info[2 * i] || []; return tag ? { name, tag, emoji, desc: desc || '', banner, tagc, slots: Number(slots) || SLOTS_BASE, members: Number(info[2 * i + 1]) || 0 } : null; }).filter(Boolean);
    const [reqs] = await redis([['SMEMBERS', `clanasked:${me}`]]);
    out.asked = [];
    if (reqs && reqs.length) {
      const still = await redis(reqs.map(cid => ['HEXISTS', reqKey(cid), me]));
      const tags = await redis(reqs.map(cid => ['HGET', ckey(cid), 'tag']));
      reqs.forEach((cid, i) => { if (Number(still[i]) === 1 && tags[i]) out.asked.push(tags[i]); });
    }
    const st = await readStats(me);
    out.me.coins = Shop.balance(st); out.me.rolls = Number(st.rolls) || 0;
    return out;
  }
  const ids = Object.keys(c.members), week = weekKey(now);
  const [[names], [xps], [presence], [reqFlat], [logRaw], [rank, score], [warIds]] = await Promise.all([
    redis([['HMGET', 'names', ...ids]]), redis([['HMGET', xpmKey(week, c.cid), ...ids]]), redis([['HMGET', 'presence', ...ids]]),
    redis([['HGETALL', reqKey(c.cid)]]), redis([['LRANGE', logKey(c.cid), 0, -1]]),
    redis([['ZREVRANK', xpKey(week), c.cid], ['ZSCORE', xpKey(week), c.cid]]), redis([['LRANGE', `clanwars:${c.cid}`, -5, -1]]),
  ]);
  const online = raw => { const [t, s] = String(raw || '').split(':'); return t && now - Number(t) <= 150000 ? (s === 'afk' ? 'afk' : 'online') : 'offline'; };
  const officer = can(c, me, 'invite');
  const reqIds = []; for (let i = 0; i < (reqFlat || []).length; i += 2) reqIds.push(reqFlat[i]);
  const [reqNames] = officer && reqIds.length ? await redis([['HMGET', 'names', ...reqIds]]) : [[]];
  const war = c.war ? await warView(await advanceWar(c.war, now), me, c.cid) : null;
  // Guerres passées (les 5 dernières finies), en résumé.
  const past = [];
  for (const wid of (warIds || []).slice().reverse()) {
    if (wid === c.war) continue;
    const w = await loadWar(wid);
    if (!w || w.st !== 'done') continue;
    const [oTag] = await redis([['HGET', ckey(w.a === c.cid ? w.b : w.a), 'tag']]);
    past.push({ vs: oTag || '???', won: w.w === c.cid, stake: w.stake, t: w.end, us: Number(w.a === c.cid ? w.sa : w.sb) || 0, them: Number(w.a === c.cid ? w.sb : w.sa) || 0 });
  }
  const st = await readStats(me);
  out.me = { inClan: true, role: c.members[me], can: Object.fromEntries(PERMS.map(k => [k, can(c, me, k)])), coins: Shop.balance(st), rolls: Number(st.rolls) || 0 };
  out.clan = {
    name: c.name, tag: c.tag, emoji: c.emoji, desc: c.desc || '', banner: c.banner || 'slate', tagc: c.tagc || 'plain', slots: c.slots, vault: c.vault,
    wins: Number(c.wins) || 0, losses: Number(c.losses) || 0, weekWins: Number(c.weekWins) || 0,
    rank: rank === null ? null : Number(rank) + 1, xp: Number(score) || 0, nextSlots: c.slots < SLOTS_MAX ? slotPrice(c.slots) : null,
    members: ids.map((id, i) => ({ name: names[i] || 'Player', role: c.members[id], xp: Number(xps[i]) || 0, me: id === me, status: online(presence[i]) }))
      .sort((a, b) => RANK[b.role] - RANK[a.role] || b.xp - a.xp || a.name.localeCompare(b.name)),
    requests: officer ? reqIds.map((id, i) => reqNames[i] || 'Player') : [],
    log: (logRaw || []).map(parse).filter(Boolean).reverse(),
    war, past, perms: permsOf(c),
  };
  return out;
}

// ---------------------------------------------------------------- point d'entrée (depuis api/friends.js, joueur vérifié)
async function handle(me, body, now = Date.now()) {
  const op = String(body.op || 'view');
  if (op === 'view') return view(me, now);
  if (op === 'top') { await settleWeek(now); return board(now); }
  if (op === 'search') return { clans: await search(body.q) };
  if (op === 'create') { await create(me, body); return view(me); }
  const c = await myClan(me);
  if (op === 'request') {
    if (c) throw refuse(409, 'You are already in a clan');
    const [cid] = await redis([['GET', `clantagk:${String(body.tag || '').trim().toUpperCase()}`]]);
    if (!cid) throw refuse(404, 'No clan with this tag');
    // Déjà invité par ce clan : on entre tout de suite.
    const [invited] = await redis([['HGET', invKey(me), cid]]);
    if (invited && now - Number(invited) < INVITE_TTL * 1000) { await admit(cid, me); return view(me); }
    const [n] = await redis([['HLEN', reqKey(cid)]]);
    if (Number(n) >= MAX_REQUESTS) throw refuse(422, 'This clan has too many requests waiting');
    await redis([['HSET', reqKey(cid), me, now], ['SADD', `clanasked:${me}`, cid], ['EXPIRE', `clanasked:${me}`, INVITE_TTL]]);
    return { ...(await view(me)), note: 'Request sent' };
  }
  if (op === 'join') {
    // Invitation acceptée (par le tag du clan).
    if (c) throw refuse(409, 'You are already in a clan');
    const [cid] = await redis([['GET', `clantagk:${String(body.tag || '').trim().toUpperCase()}`]]);
    const [invited] = cid ? await redis([['HGET', invKey(me), cid]]) : [null];
    if (!invited || now - Number(invited) >= INVITE_TTL * 1000) throw refuse(404, 'This invitation is gone');
    await admit(cid, me);
    return view(me);
  }
  if (op === 'ignore') {
    const [cid] = await redis([['GET', `clantagk:${String(body.tag || '').trim().toUpperCase()}`]]);
    if (cid) await redis([['HDEL', invKey(me), cid]]);
    return view(me);
  }
  if (op === 'unask') {
    const [cid] = await redis([['GET', `clantagk:${String(body.tag || '').trim().toUpperCase()}`]]);
    if (cid) await redis([['HDEL', reqKey(cid), me], ['SREM', `clanasked:${me}`, cid]]);
    return view(me);
  }
  if (!c) throw refuse(422, 'You are not in a clan');
  const [myName] = await redis([['HGET', 'names', me]]);
  const by = myName || 'Player';
  const target = async () => {
    const id = await findPlayer(cleanName(body.name));
    if (!id) throw refuse(404, 'No player with this name');
    return id;
  };
  if (op === 'invite') {
    needPerm(c, me, 'invite');
    const id = await target();
    if (c.members[id]) throw refuse(409, 'Already in your clan');
    if (await clanOf(id)) throw refuse(409, 'This player is already in a clan');
    if (Object.keys(c.members).length >= c.slots) throw refuse(422, 'Your clan is full');
    // Il avait déjà demandé : il entre tout de suite.
    const [asked] = await redis([['HEXISTS', reqKey(c.cid), id]]);
    if (Number(asked) === 1) { await admit(c.cid, id, by); return { ...(await view(me)), note: 'Joined the clan' }; }
    const [n] = await redis([['HLEN', invKey(id)]]);
    if (Number(n) >= MAX_INVITES) throw refuse(422, 'This player has too many invitations');
    await redis([['HSET', invKey(id), c.cid, now], ['EXPIRE', invKey(id), INVITE_TTL]]);
    return { ...(await view(me)), note: 'Invitation sent' };
  }
  if (op === 'accept' || op === 'decline') {
    needPerm(c, me, 'invite');
    const id = await target();
    const [asked] = await redis([['HEXISTS', reqKey(c.cid), id]]);
    if (Number(asked) !== 1) throw refuse(404, 'This request is gone');
    if (op === 'accept') await admit(c.cid, id, by);
    else await redis([['HDEL', reqKey(c.cid), id], ['SREM', `clanasked:${id}`, c.cid]]);
    return view(me);
  }
  if (op === 'leave') {
    if (c.members[me] === 'leader') {
      if (Object.keys(c.members).length > 1) throw refuse(422, 'Pass the leadership to someone first, or disband the clan');
      await disband(c, now);
      return view(me);
    }
    await locked(`clanlock:${c.cid}`, () => removeMember(c, me, 'leave'));
    return view(me);
  }
  if (op === 'disband') {
    need(c, me, 'leader');
    await locked(`clanlock:${c.cid}`, () => disband(c, now));
    return view(me);
  }
  if (op === 'kick' || op === 'promote' || op === 'demote' || op === 'transfer') {
    const id = await target();
    if (!c.members[id]) throw refuse(404, 'This player is not in your clan');
    if (id === me) throw refuse(422, 'That is you');
    await locked(`clanlock:${c.cid}`, async () => {
      const now2 = await loadClan(c.cid), mine = now2.members[me], theirs = now2.members[id];
      if (!theirs) throw refuse(404, 'This player is not in your clan');
      const [name] = await redis([['HGET', 'names', id]]);
      if (op === 'kick') {
        // Un officier exclut des membres ; le chef exclut n'importe qui.
        if (!(mine === 'leader' || (mine === 'officer' && theirs === 'member'))) throw refuse(403, mine === 'officer' ? 'Officers can only kick members' : 'Only the leader and officers can do this');
        if (!can(now2, me, 'kick')) throw refuse(403, 'Your clan leader turned this off for officers');
        await removeMember(now2, id, 'kick', by);
        return;
      }
      need(now2, me, 'leader');
      if (op === 'promote') { if (theirs !== 'member') throw refuse(422, 'Already an officer'); await redis([['HSET', mkey(c.cid), id, 'officer'], ...pushLog(c.cid, { k: 'promote', n: name || 'Player', by })]); return; }
      if (op === 'demote') { if (theirs !== 'officer') throw refuse(422, 'Not an officer'); await redis([['HSET', mkey(c.cid), id, 'member'], ...pushLog(c.cid, { k: 'demote', n: name || 'Player', by })]); return; }
      await redis([['HSET', mkey(c.cid), id, 'leader'], ['HSET', mkey(c.cid), me, 'officer'], ['HSET', ckey(c.cid), 'leader', id], ...pushLog(c.cid, { k: 'leader', n: name || 'Player', by })]);
    });
    return view(me);
  }
  if (op === 'donate') { await donate(me, c, body.amount); return view(me); }
  if (op === 'upgrade') { await upgrade(me, c, body); return view(me); }
  if (op === 'perms') {
    // Seul le chef règle les droits ; on ne garde que les droits retirés (défaut = tout permis).
    need(c, me, 'leader');
    const off = {};
    for (const k of PERMS) if (body.perms && body.perms[k] === false) off[k] = false;
    await redis([Object.keys(off).length ? ['HSET', ckey(c.cid), 'perms', JSON.stringify(off)] : ['HDEL', ckey(c.cid), 'perms'], ...pushLog(c.cid, { k: 'perms', n: by })]);
    return view(me);
  }
  if (op === 'desc') {
    needPerm(c, me, 'edit');
    const desc = checkDesc(body.desc);
    await redis([desc ? ['HSET', ckey(c.cid), 'desc', desc] : ['HDEL', ckey(c.cid), 'desc']]);
    return view(me);
  }
  if (op === 'emoji') {
    needPerm(c, me, 'edit');
    if (!EMOJIS.includes(body.emoji)) throw refuse(400, 'Unknown emoji');
    await redis([['HSET', ckey(c.cid), 'emoji', body.emoji]]);
    return view(me);
  }
  // Chat du clan.
  if (op === 'chat') return chatView(me, c);
  if (op === 'say') { await chatSend(me, c, body.text); return chatView(me, c); }
  if (op === 'edit' || op === 'unsend' || op === 'report') {
    const f = await findMsg(c, body.t);
    if (!f || !f.m) throw refuse(404, 'This message is gone');
    if (op === 'report') {
      if (f.m.s === me) throw refuse(422, 'You cannot report this message');
      return Reports.fileReport({ reporter: me, author: f.m.s, text: f.m.x, where: 'clan chat', msgT: f.m.t });
    }
    if (op === 'edit') {
      if (f.m.s !== me) throw refuse(403, 'You can only edit your own messages');
      if (now - f.m.t >= EDIT_MS) throw refuse(422, 'Messages can be edited for 10 minutes');
      const text = cleanChat(body.text);
      if (!text) throw refuse(422, 'Write a message first');
      await redis([['LSET', chatKey(c.cid), f.k, JSON.stringify({ ...f.m, x: text, e: 1 })]]);
      return chatView(me, c);
    }
    // Supprimer : son propre message, ou celui d'un membre pour un officier (jamais celui du chef).
    const canMod = RANK[c.members[me]] >= RANK.officer && c.members[f.m.s] !== 'leader';
    if (f.m.s !== me && !canMod) throw refuse(403, 'You can only delete your own messages');
    await redis([['LREM', chatKey(c.cid), 1, f.raw]]);
    return chatView(me, c);
  }
  // Guerres.
  if (op === 'challenge') { await challenge(me, c, body, now); return view(me, now); }
  if (op === 'answer') { await answer(me, c, body, now); return view(me, now); }
  if (op === 'warroll') { const r = await warRoll(me, c, now); return { ...r, state: await view(me, now) }; }
  throw refuse(400, 'Unknown clan action');
}

// Tag du clan de plusieurs joueurs (classements, profils, duels) : { tag, c } ou null, dans l'ordre des ids.
async function tagsOf(ids) {
  if (!ids || !ids.length) return [];
  const [vals] = await redis([['HMGET', 'clantag', ...ids]]);
  return (vals || []).map(v => { if (!v) return null; const [tag, c] = String(v).split('|'); return { tag, c: c || 'plain' }; });
}

// Tirage normal d'un membre : son XP compte pour son clan cette semaine (appelé par recordRoll, api/_lib.js).
const rollWrites = (cid, playerId, s, t) => {
  if (!cid || !s) return [];
  const week = weekKey(t);
  return [['ZINCRBY', xpKey(week), s, cid], ['EXPIRE', xpKey(week), WEEK_TTL], ['HINCRBY', xpmKey(week, cid), playerId, s], ['EXPIRE', xpmKey(week, cid), WEEK_TTL]];
};

module.exports = { handle, PERMS, tagsOf, rollWrites, settleWeek, advanceWar, payWar, loadWar, warWinner, board, CREATE_COST, SLOT_PRICES, WAR, DONATE, EDIT_MS, _reset: () => { settledWeek = ''; } };
