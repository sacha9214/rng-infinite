// Annonce des grands tirages sur le serveur Discord de RNG∞ (salon 🏆・big-rolls, 2026-10-17) : chaque tirage
// Celestial ou mieux part en message riche par un webhook. L'adresse du webhook est secrète : elle vient de
// RNG_DISCORD_WEBHOOK ou du fichier ~/.config/rng/discord-webhook sur le VPS ; sans elle (tests, Vercel), rien ne part.
// Jamais bloquant : la demande part en arrière-plan, avec un délai maximum, et une erreur est ignorée.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const FILE = path.join(os.homedir(), '.config/rng/discord-webhook');
let url = process.env.RNG_DISCORD_WEBHOOK || '';
try { if (!url) url = fs.readFileSync(FILE, 'utf8').trim(); } catch (e) { /* pas de webhook : pas d'annonce */ }

const SITE = 'https://rng-infinite.com';
const ANNOUNCED = ['celestial', 'divine', 'godlike', 'infinite'];
const LOOK = {
  celestial: { color: 0x22d3ee, emoji: '💠', title: 'Celestial roll!' },
  divine: { color: 0xfde047, emoji: '🌟', title: 'DIVINE ROLL!' },
  godlike: { color: 0xfb7185, emoji: '⚜️', title: '⚜️ GODLIKE ROLL ⚜️' },
  infinite: { color: 0xc084fc, emoji: '♾️', title: '♾️ INFINITE ROLL ♾️' },
};

function announceRoll({ name, n, a }) {
  if (!url || !ANNOUNCED.includes(a.tier)) return;
  const look = LOOK[a.tier], number = String(n).padStart(6, '0');
  const badges = (a.groups || []).slice(0, 4).map(g => `${g.badge.emoji} ${g.badge.label}`).join(' · ');
  const body = {
    username: 'RNG∞',
    allowed_mentions: { parse: [] }, // jamais de @everyone ni de mention, même si un pseudo en contient
    embeds: [{
      title: `${look.emoji} ${look.title}`,
      url: `${SITE}/#/player/${encodeURIComponent(name || '')}`,
      description: `**${String(name || 'A player').replace(/[*_`~|>]/g, '')}** rolled **\`${number}\`**\n${a.total.toLocaleString('en-US')} XP${badges ? `\n${badges}` : ''}`,
      color: look.color,
      footer: { text: `${a.tier[0].toUpperCase()}${a.tier.slice(1)} · roll yours on rng-infinite.com` },
      timestamp: new Date().toISOString(),
    }],
  };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 5000);
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
    .catch(() => {}).finally(() => clearTimeout(timer));
}

module.exports = { announceRoll, ANNOUNCED, enabled: () => !!url };
