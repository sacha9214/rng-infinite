// Giveaways sur le Discord (demandé par Sacha, 2026-11-01 : « pour que les gens aillent sur le Discord ») : le créateur
// choisit un skin sur la page Owner, le bot le met en jeu dans 🎁・giveaways, on participe en réagissant 🎉 (tout membre
// du Discord, choix de Sacha), et au bout de 24 h le serveur tire UN gagnant (crypto.randomInt, jamais le site).
// Gagnant dont le Discord est lié à un joueur : le skin arrive tout seul. Sinon : il a 7 jours pour lier son Discord
// (Me → 🔗 Link my Discord) et le reçoit à ce moment-là (claim, appelé par api/_discord_link.js).
// Ceux dont le compte lié possède déjà le skin ne peuvent pas le gagner (tirés à nouveau).
// Seulement des réactions et l'API REST du bot (jeton sur le VPS) : pas de connexion permanente à Discord, aucun réglage
// à faire dans le portail des développeurs. Sans jeton (tests, Vercel), rien ne part vers Discord.
// Clés : gw:ch = le salon ; gw:item = { id: giveaway } ; gw:ids = les giveaways par date ; gw:claim = { discordId: lot }.
const crypto = require('node:crypto');
const { redis } = require('./_lib');
const Shop = require('../js/shop.js');

const CH = 'gw:ch', ITEM = 'gw:item', IDS = 'gw:ids', CLAIM = 'gw:claim', EMOJI = '🎉';
const HOURS = [1, 24, 48, 72], CLAIM_MS = 7 * 86400e3, SITE = 'https://rng-infinite.com';
const refuse = (status, error) => Object.assign(new Error(error), { status });
const parse = x => { try { return JSON.parse(x); } catch (e) { return null; } };
const Link = () => require('./_discord_link');
const skinOf = id => Shop.SKINS.find(s => s.id === id && s.price > 0);
const unix = t => Math.floor(t / 1000);

// Permissions Discord (bits) : le salon est en lecture seule pour les membres, qui peuvent seulement réagir.
const P = { VIEW: 1n << 10n, SEND: 1n << 11n, EMBED: 1n << 14n, HISTORY: 1n << 16n, REACT: 1n << 6n, THREADS: (1n << 35n) | (1n << 36n) | (1n << 38n) };

// Crée la catégorie 🎁 GIVEAWAYS et le salon 🎁・giveaways (une seule fois ; le salon est retrouvé s'il existe déjà).
async function setup() {
  const { dc, GUILD } = Link();
  const [have] = await redis([['GET', CH]]);
  const chans = await dc('GET', `/guilds/${GUILD}/channels`);
  if (have && chans.some(c => c.id === have)) return have;
  const found = chans.find(c => c.type === 0 && /giveaways/i.test(c.name));
  if (found) { await redis([['SET', CH, found.id]]); return found.id; }
  const me = await dc('GET', '/users/@me');
  const cat = await dc('POST', `/guilds/${GUILD}/channels`, { body: { name: '🎁 GIVEAWAYS', type: 4, position: 1 } });
  const ch = await dc('POST', `/guilds/${GUILD}/channels`, { body: {
    name: '🎁・giveaways', type: 0, parent_id: cat.id, topic: 'Free RNG∞ skins! React 🎉 on a giveaway to join. One winner, picked by the game.',
    permission_overwrites: [
      { id: GUILD, type: 0, allow: String(P.VIEW | P.HISTORY | P.REACT), deny: String(P.SEND | P.THREADS) }, // @everyone
      { id: me.id, type: 1, allow: String(P.VIEW | P.HISTORY | P.REACT | P.SEND | P.EMBED) }, // le bot
    ],
  } });
  await redis([['SET', CH, ch.id]]);
  return ch.id;
}

const embedOpen = (g, s) => ({
  title: `🎁 GIVEAWAY · ${s.emoji} ${s.name} skin`,
  color: 0xf472b6,
  description: [
    `React with ${EMOJI} below to join!`,
    '',
    `🏆 **1 winner** gets the **${s.name}** skin in RNG∞ (${s.price.toLocaleString('en-US')} coins in the shop).`,
    s.desc ? `*${s.desc}*` : null,
    `⏰ Ends <t:${unix(g.ends)}:R> (<t:${unix(g.ends)}:f>)`,
    '',
    `🔗 Link your Discord in the game (**Me → 🔗 Link my Discord**) and the skin arrives by itself. Not linked yet? You can still win: you'll have 7 days to link it.`,
    `🎲 Play: ${SITE}`,
  ].filter(x => x !== null).join('\n'),
  footer: { text: 'The winner is picked at random by the game server · one entry per person' },
});
const embedDone = (g, s, text) => ({ title: `🎁 ENDED · ${s.emoji} ${s.name} skin`, color: 0x64748b, description: text, footer: { text: `${g.entries || 0} ${g.entries === 1 ? 'entry' : 'entries'}` } });

async function start(skinId, hours) {
  const s = skinOf(String(skinId || ''));
  if (!s) throw refuse(400, 'Pick a skin from the shop');
  const h = HOURS.includes(Number(hours)) ? Number(hours) : 24;
  const { dc } = Link();
  const ch = await setup();
  const now = Date.now(), g = { id: crypto.randomBytes(6).toString('hex'), skin: s.id, ch, t: now, ends: now + h * 3600e3, status: 'open' };
  const msg = await dc('POST', `/channels/${ch}/messages`, { body: { embeds: [embedOpen(g, s)], allowed_mentions: { parse: [] } } });
  g.msg = msg.id;
  await dc('PUT', `/channels/${ch}/messages/${msg.id}/reactions/${encodeURIComponent(EMOJI)}/@me`);
  await redis([['HSET', ITEM, g.id, JSON.stringify(g)], ['ZADD', IDS, String(now), g.id]]);
  return g;
}

// Tous ceux qui ont réagi 🎉 (par pages de 100), sans les bots.
async function entrants(g) {
  const { dc } = Link();
  const out = [];
  let after = '0';
  for (let page = 0; page < 100; page++) {
    const list = await dc('GET', `/channels/${g.ch}/messages/${g.msg}/reactions/${encodeURIComponent(EMOJI)}?limit=100&after=${after}`);
    for (const u of list) if (!u.bot) out.push(u.id);
    if (list.length < 100) break;
    after = list[list.length - 1].id;
  }
  return [...new Set(out)];
}

// Tirage d'un giveaway fini : un seul processus le fait (verrou), même si plusieurs serveurs tournent.
async function draw(g) {
  const [lock] = await redis([['SET', `gw:lock:${g.id}`, '1', 'NX', 'EX', '300']]);
  if (lock !== 'OK') return null;
  const { dc } = Link(), s = skinOf(g.skin) || { id: g.skin, name: g.skin, emoji: '🎁' };
  const ids = await entrants(g);
  g.entries = ids.length;
  const links = ids.length ? (await redis([['HMGET', 'discord:links', ...ids]]))[0] || [] : [];
  // Ceux dont le joueur lié a déjà le skin ne peuvent pas le gagner.
  const owns = links.some(Boolean) ? await redis(links.map(pid => (pid ? ['SISMEMBER', `skins:${pid}`, g.skin] : ['EXISTS', 'gw:none']))) : [];
  const pool = ids.map((id, i) => ({ id, pid: links[i] || null })).filter((x, i) => !(x.pid && Number(owns[i]) === 1));
  let text;
  if (!pool.length) {
    g.status = 'void';
    text = ids.length ? 'Nobody could win: everyone who joined already owns this skin.' : 'Nobody joined this one. Next time! 🎲';
  } else {
    const w = pool[crypto.randomInt(pool.length)];
    Object.assign(g, { status: 'done', winner: w.id, pid: w.pid, drawn: Date.now() });
    if (w.pid) {
      await redis([['SADD', `skins:${w.pid}`, g.skin], ['HINCRBY', 'gw:won', w.pid, 1]]);
      g.given = true;
      text = `🎉 Congratulations <@${w.id}>! You won the **${s.emoji} ${s.name}** skin. It's already yours in RNG∞: open the Shop → Skins to put it on.`;
    } else {
      await redis([['HSET', CLAIM, w.id, JSON.stringify({ gw: g.id, skin: g.skin, until: Date.now() + CLAIM_MS })]]);
      text = `🎉 Congratulations <@${w.id}>! You won the **${s.emoji} ${s.name}** skin. To get it, link your Discord in RNG∞ within 7 days: ${SITE}/#/me → **🔗 Link my Discord**. The skin arrives as soon as it's linked.`;
    }
  }
  await redis([['HSET', ITEM, g.id, JSON.stringify(g)]]);
  try { await dc('PATCH', `/channels/${g.ch}/messages/${g.msg}`, { body: { embeds: [embedDone(g, s, g.winner ? `Winner: <@${g.winner}>` : text)], allowed_mentions: { parse: [] } } }); } catch (e) { /* message supprimé : pas grave */ }
  await dc('POST', `/channels/${g.ch}/messages`, { body: { content: text, message_reference: { message_id: g.msg, fail_if_not_exists: false }, allowed_mentions: { users: g.winner ? [g.winner] : [] } } });
  return g;
}

// Appelé toutes les minutes par le serveur du VPS : tire les giveaways finis.
async function tick(now = Date.now()) {
  if (!Link().hasBot()) return 0;
  const [ids] = await redis([['ZRANGEBYSCORE', IDS, String(now - 30 * 86400e3), '+inf']]);
  if (!ids || !ids.length) return 0;
  const rows = (await redis([['HMGET', ITEM, ...ids]]))[0] || [];
  let n = 0;
  for (const g of rows.map(parse)) if (g && g.status === 'open' && g.ends <= now) { if (await draw(g)) n++; }
  return n;
}

// Un gagnant lie son Discord : il reçoit son skin (dans les 7 jours). Renvoie le lot donné, ou null.
async function claim(discordId, playerId) {
  const [raw] = await redis([['HGET', CLAIM, discordId]]);
  const c = parse(raw);
  if (!c) return null;
  const [gone] = await redis([['HDEL', CLAIM, discordId]]);
  if (Number(gone) !== 1 || c.until < Date.now()) return null; // déjà donné (autre requête) ou trop tard
  await redis([['SADD', `skins:${playerId}`, c.skin], ['HINCRBY', 'gw:won', playerId, 1]]);
  const [graw] = await redis([['HGET', ITEM, c.gw]]), g = parse(graw);
  if (g) { g.pid = playerId; g.given = true; await redis([['HSET', ITEM, g.id, JSON.stringify(g)]]); }
  const s = skinOf(c.skin);
  return { skin: c.skin, name: s ? s.name : c.skin, emoji: s ? s.emoji : '🎁' };
}

// Page Owner : les giveaways récents (le gagnant par son pseudo dans le jeu s'il est lié), et les skins possibles.
async function ownerState() {
  const [ids, ch] = await redis([['ZREVRANGE', IDS, 0, 29], ['GET', CH]]);
  const rows = ids && ids.length ? ((await redis([['HMGET', ITEM, ...ids]]))[0] || []).map(parse).filter(Boolean) : [];
  const pids = [...new Set(rows.map(g => g.pid).filter(Boolean))];
  const names = pids.length ? (await redis([['HMGET', 'names', ...pids]]))[0] || [] : [];
  const nameOf = new Map(pids.map((p, i) => [p, names[i]]));
  return {
    ready: Link().hasBot(), channel: !!ch, hours: HOURS,
    skins: Shop.SKINS.filter(s => s.price > 0).map(s => ({ id: s.id, name: s.name, emoji: s.emoji, price: s.price })),
    list: rows.map(g => { const s = skinOf(g.skin); return { id: g.id, skin: g.skin, name: s ? s.name : g.skin, emoji: s ? s.emoji : '🎁', t: g.t, ends: g.ends, status: g.status, entries: g.entries ?? null, winner: g.status === 'done' ? (g.pid ? nameOf.get(g.pid) || 'Player' : null) : null, given: !!g.given, link: `https://discord.com/channels/${Link().GUILD}/${g.ch}/${g.msg}` }; }),
  };
}

module.exports = { setup, start, draw, tick, claim, ownerState, HOURS };
