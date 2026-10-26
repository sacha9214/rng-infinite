// Le jeu parle sur le serveur Discord de RNG∞ (2026-10-17) :
//   - grands tirages (Celestial ou mieux) dans 🏆・big-rolls, avec la mention du rôle 🔔 Big Rolls à partir de Divine ;
//   - nouveautés du journal des mises à jour (UPDATES de js/app.js) dans 🆕・updates, rôle 🔔 Updates ;
//   - duels publics ouverts dans ⚔️・duels avec le lien pour rejoindre, rôle 🔔 Duels ;
//   - à minuit UTC, le récapitulatif « tirages du jour » dans 🏆・big-rolls.
// Les adresses des webhooks sont secrètes : fichier ~/.config/rng/discord.json sur le VPS (ou RNG_DISCORD_WEBHOOK pour
// les grands tirages seuls, ancien format ~/.config/rng/discord-webhook). Sans configuration (tests, Vercel), rien ne
// part. Jamais bloquant : chaque envoi part en arrière-plan avec un délai maximum, une erreur est ignorée.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Card = require('./_discord_card');
let engine = null; // rang « Top x % » de la carte ; chargé tard (_lib requiert ce module)
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');

const DIR = path.join(os.homedir(), '.config/rng');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'discord.json'), 'utf8')); } catch (e) { /* pas de fichier */ }
try { if (!cfg.bigRolls) cfg.bigRolls = fs.readFileSync(path.join(DIR, 'discord-webhook'), 'utf8').trim(); } catch (e) { /* idem */ }
if (process.env.RNG_DISCORD_WEBHOOK) cfg = { bigRolls: process.env.RNG_DISCORD_WEBHOOK };
if (process.env.RNG_DISCORD_CONFIG) cfg = JSON.parse(process.env.RNG_DISCORD_CONFIG); // tests
const roles = cfg.roles || {};

const SITE = 'https://rng-infinite.com';
const ANNOUNCED = ['celestial', 'divine', 'godlike', 'infinite'];
const PINGED = ['divine', 'godlike', 'infinite']; // Celestial : ~100 par jour, sans mention
const LOOK = {
  celestial: { color: 0x22d3ee, emoji: '💠', title: 'Celestial roll!' },
  divine: { color: 0xfde047, emoji: '🌟', title: 'DIVINE ROLL!' },
  godlike: { color: 0xfb7185, emoji: '⚜️', title: '⚜️ GODLIKE ROLL ⚜️' },
  infinite: { color: 0xc084fc, emoji: '♾️', title: '♾️ INFINITE ROLL ♾️' },
};
const clean = s => String(s || '').replace(/[*_`~|>\\]/g, '').replace(/@/g, '@​'); // pas de mise en forme ni de mention par un pseudo

function post(url, body, file) {
  if (!url) return;
  if (file) { // image jointe (carte du tirage) : envoi en multipart, l'embed la montre par « attachment://… »
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ username: 'RNG∞', ...body }));
    form.append('files[0]', new Blob([file.data], { type: 'image/png' }), file.name);
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 10000);
    fetch(url, { method: 'POST', body: form, signal: ctrl.signal }).catch(() => {}).finally(() => clearTimeout(timer));
    return;
  }
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 5000);
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'RNG∞', ...body }), signal: ctrl.signal })
    .catch(() => {}).finally(() => clearTimeout(timer));
}
// Mention d'un rôle d'abonnement (choisi par le joueur à l'arrivée sur le serveur), et seulement celui-là.
const ping = role => (role ? { content: `<@&${role}>`, allowed_mentions: { parse: [], roles: [role] } } : { allowed_mentions: { parse: [] } });

function announceRoll({ name, n, a }) {
  if (!engine) try { engine = require('./_lib').engine; } catch (e) { /* sans rang */ }
  if (!cfg.bigRolls || !ANNOUNCED.includes(a.tier)) return;
  const look = LOOK[a.tier], number = String(n).padStart(6, '0');
  const badges = (a.groups || []).slice(0, 4).map(g => `${g.badge.emoji} ${g.badge.label}`).join(' · ');
  // Carte image, la même que le bouton « Share » du site (api/_discord_card.js) ; sans elle, le texte seul.
  const png = Card.render({
    str: a.str, tier: a.tier, rank: (engine && engine.topLabel ? cap((engine.topLabel(a.percentile) || '').toLowerCase()) : ''),
    xp: a.total.toLocaleString('en-US'), name: String(name || ''), host: 'rng-infinite.com',
    badges: (a.groups || []).slice(0, 5).map(g => ({ emoji: g.badge.emoji, label: g.badge.label, tier: g.badge.tier })), more: Math.max(0, (a.groups || []).length - 5),
  });
  post(cfg.bigRolls, {
    ...(PINGED.includes(a.tier) ? ping(roles.bigRolls) : { allowed_mentions: { parse: [] } }),
    embeds: [{
      title: `${look.emoji} ${look.title}`,
      url: `${SITE}/#/player/${encodeURIComponent(name || '')}`,
      description: `**${clean(name) || 'A player'}** rolled **\`${number}\`** · ${a.total.toLocaleString('en-US')} XP${png ? '' : badges ? `\n${badges}` : ''}`,
      color: look.color,
      ...(png ? { image: { url: 'attachment://roll.png' } } : {}),
      footer: { text: `${cap(a.tier)} · roll yours on rng-infinite.com` },
      timestamp: new Date().toISOString(),
    }],
  }, png ? { name: 'roll.png', data: png } : null);
}

function announceDuel({ host, code, mode, target, size, stake }) {
  if (!cfg.duels) return;
  const goal = mode === 'xp' ? `first to ${Number(target).toLocaleString('en-US')} XP` : `first to ${target} round${target > 1 ? 's' : ''}`;
  post(cfg.duels, {
    ...ping(roles.duels),
    embeds: [{
      title: '⚔️ A duel is open!',
      url: `${SITE}/#/room/${code}`,
      description: `**${clean(host) || 'A player'}** is waiting for opponents: ${goal}, up to ${size} players${stake ? `, 🪙 ${Number(stake).toLocaleString('en-US')} stake each` : ''}.\n**[Join the duel](${SITE}/#/room/${code})** · code \`${code}\``,
      color: 0xf97316,
    }],
  });
}

function announceUpdate(entry) {
  if (!cfg.updates) return;
  post(cfg.updates, {
    ...ping(roles.updates),
    embeds: [{
      title: `🆕 Update · ${entry.date}`,
      url: SITE,
      description: entry.en.map(x => `• ${x}`).join('\n').slice(0, 3900),
      color: 0x22c55e,
    }],
  });
}

// Annonce écrite par le créateur sur la page Owner (idée de jaxoncool43, 2026-10-26) : salon « announcements » s'il
// existe, sinon celui des nouveautés. Renvoie false sans webhook (l'annonce reste publiée dans le jeu).
function announceNews(entry) {
  const url = cfg.announcements || cfg.updates;
  if (!url) return false;
  post(url, {
    ...ping(cfg.announcements ? roles.announcements : roles.updates),
    embeds: [{ title: `📣 ${clean(entry.title)}`.slice(0, 250), url: SITE, description: clean(entry.text).slice(0, 3900), color: entry.important ? 0xef4444 : 0x6366f1 }],
  });
  return true;
}

function announceRecap({ day, rows, rolls }) {
  if (!cfg.bigRolls || !rows.length) return;
  const medal = ['🥇', '🥈', '🥉'];
  post(cfg.bigRolls, {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `🏆 Rolls of the day · ${day}`,
      url: `${SITE}/#/leaderboard`,
      description: rows.map((r, i) => `${medal[i]} **${clean(r.name)}** · \`${String(r.n).padStart(6, '0')}\` · ${r.s.toLocaleString('en-US')} XP`).join('\n') +
        `\n\n🎲 ${Number(rolls || 0).toLocaleString('en-US')} rolls were made that day. A new day starts now!`,
      color: 0xa855f7,
    }],
  });
}

// Événement de la semaine (js/events.js) : le lancement le lundi, et le podium de la semaine passée.
function announceEvent(ev) {
  if (!cfg.events) return;
  post(cfg.events, {
    ...ping(roles.updates),
    embeds: [{
      title: `${ev.emoji} This week's event: ${ev.title}`,
      url: SITE,
      description: `**${ev.desc}** before <t:${Math.floor(ev.end / 1000)}:F> and win **🪙 ${ev.reward} coins**.\nEvery roll with a matching badge counts. Track your progress on the home page of ${SITE}`,
      color: 0xf59e0b,
    }],
  });
}
function announceEventPodium(ev, rows, players) {
  if (!cfg.events || !rows.length) return;
  const medal = ['🥇', '🥈', '🥉'];
  post(cfg.events, {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `${ev.emoji} ${ev.title} is over!`,
      description: rows.map((r, i) => `${medal[i]} **${clean(r.name)}** · ${r.n} hits`).join('\n') + `\n\n${players} players took part. A new event starts now!`,
      color: 0xf59e0b,
    }],
  });
}

// Weekend Rush (js/events.js) : le samedi à son lancement.
function announceRush(end) {
  if (!cfg.events) return;
  post(cfg.events, {
    ...ping(roles.updates),
    embeds: [{
      title: '🔥 Weekend Rush is on!',
      url: SITE,
      description: `Until <t:${Math.floor(end / 1000)}:F>, **+25% coins from rolls and daily quests**.\nRoll on ${SITE}`,
      color: 0xf97316,
    }],
  });
}

// Tournoi du jour terminé (api/_tournament.js) : le champion et le finaliste, dans le salon des événements.
// Le mode du jour (idée de PRISMA123) est rappelé dans le message.
const TOURNEY_MODES = { total: 'Total XP', best: 'Best Roll', bo3: 'Best of 3', lowest: 'Lowest Wins', badges: 'Badge Hunter' };
function announceTournament({ day, mode, champion, finalist, players }) {
  if (!cfg.events) return;
  const label = TOURNEY_MODES[mode] || TOURNEY_MODES.total;
  post(cfg.events, {
    embeds: [{
      title: `🏆 ${champion} wins the daily tournament!`,
      url: SITE,
      description: `Tournament of ${day} · mode **${label}**: **${champion}** beat **${finalist}** in the final (${players} players).\nSign-ups for the next one open at 00:00 UTC on ${SITE}`,
      color: 0xeab308,
    }],
  });
}

module.exports = { announceTournament, announceRush, announceEvent, announceEventPodium, announceRoll, announceDuel, announceUpdate, announceNews, announceRecap, ANNOUNCED, enabled: () => !!cfg.bigRolls, has: k => !!cfg[k] };
