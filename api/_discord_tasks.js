// Tâches Discord lancées par le serveur d'API du VPS (deploy/ovh/api-server.js), voir api/_discord.js :
//   - au démarrage (donc à chaque mise en ligne), les nouvelles entrées du journal des mises à jour partent dans
//     🆕・updates ; une entrée n'est publiée qu'une fois (ensemble discord:updates:seen) ;
//   - toutes les 10 minutes : si le jour UTC a changé, le podium d'hier part dans 🏆・big-rolls (une seule fois).
const fs = require('node:fs'), path = require('node:path');
const { redis, dayKey } = require('./_lib');
const Discord = require('./_discord');

const SEEN = 'discord:updates:seen';

// Les entrées UPDATES de js/app.js (des littéraux seulement : id, date, en, fr).
function readUpdates() {
  const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const start = src.indexOf('const UPDATES = [');
  if (start < 0) return [];
  const end = src.indexOf('\n  ];', start);
  return Function(`"use strict"; return ${src.slice(start + 'const UPDATES = '.length, end + 4)}`)();
}

async function postNewUpdates() {
  if (!Discord.has('updates')) return 0;
  const list = readUpdates();
  if (!list.length) return 0;
  const [seen, first] = await redis([['SMEMBERS', SEEN], ['EXISTS', SEEN]]);
  if (!Number(first)) {
    // Tout premier lancement : on ne republie pas tout l'historique, seulement la dernière entrée.
    await redis([['SADD', SEEN, ...list.map(u => u.id)]]);
    Discord.announceUpdate(list[0]);
    return 1;
  }
  const fresh = list.filter(u => !seen.includes(u.id)).reverse(); // du plus ancien au plus récent
  if (!fresh.length) return 0;
  // SADD répond 1 seulement la première fois : deux démarrages simultanés ne publient pas deux fois.
  const added = await redis(fresh.map(u => ['SADD', SEEN, u.id]));
  fresh.forEach((u, i) => { if (Number(added[i]) === 1) Discord.announceUpdate(u); });
  return fresh.length;
}

async function dailyRecap(now = Date.now()) {
  if (!Discord.enabled()) return false;
  const day = dayKey(now - 86400000);
  // Seulement dans les 3 premières heures du jour suivant (un redémarrage tard dans la journée ne publie pas en retard).
  if (now - Date.parse(`${dayKey(now)}T00:00:00Z`) > 3 * 3600000) return false;
  const [ok] = await redis([['SET', `discord:recap:${day}`, '1', 'NX', 'EX', 3 * 86400]]);
  if (ok !== 'OK') return false;
  const [top, rolls] = await redis([['ZREVRANGE', `lb:day:${day}`, 0, 2], ['GET', `rolls:day:${day}`]]);
  if (!top || !top.length) return false;
  const [names, best] = await redis([['HMGET', 'names', ...top], ['HMGET', `best:day:${day}`, ...top]]);
  const rows = top.map((id, i) => { const b = best[i] ? JSON.parse(best[i]) : null; return b && { name: names[i] || 'Player', n: b.n, s: b.s }; }).filter(Boolean);
  Discord.announceRecap({ day, rows, rolls });
  return true;
}

function start() {
  postNewUpdates().catch(err => console.error('discord updates:', err.message));
  const tick = () => dailyRecap().catch(err => console.error('discord recap:', err.message));
  tick();
  setInterval(tick, 10 * 60000).unref();
}

module.exports = { start, readUpdates, postNewUpdates, dailyRecap };
