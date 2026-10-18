// Tâches Discord lancées par le serveur d'API du VPS (deploy/ovh/api-server.js), voir api/_discord.js :
//   - au démarrage (donc à chaque mise en ligne), les nouvelles entrées du journal des mises à jour partent dans
//     🆕・updates ; une entrée n'est publiée qu'une fois (ensemble discord:updates:seen) ;
//   - toutes les 10 minutes : si le jour UTC a changé, le podium d'hier part dans 🏆・big-rolls (une seule fois).
const fs = require('node:fs'), path = require('node:path');
const { redis, dayKey } = require('./_lib');
const Discord = require('./_discord');
const Events = require('../js/events.js');

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

// Le lundi (dans les 6 premières heures de la semaine) : podium de l'événement passé, puis lancement du nouveau.
async function weeklyEvent(now = Date.now()) {
  if (!Discord.has('events')) return false;
  const ev = Events.current(now);
  const prev = Events.current(ev.start - 1), key = Events.key(prev);
  // Podium : seulement dans les 6 premières heures (un redémarrage en milieu de semaine ne le publie pas en retard).
  const [podium] = now - ev.start <= 6 * 3600000 ? await redis([['SET', `discord:evpod:${prev.id}`, '1', 'NX', 'EX', 30 * 86400]]) : [null];
  if (podium === 'OK') {
    const [flat, players] = await redis([['ZREVRANGE', key, 0, 2, 'WITHSCORES'], ['ZCARD', key]]);
    const ids = []; for (let i = 0; i < (flat || []).length; i += 2) ids.push([flat[i], Number(flat[i + 1])]);
    if (ids.length) {
      const [names] = await redis([['HMGET', 'names', ...ids.map(x => x[0])]]);
      Discord.announceEventPodium(prev, ids.map(([, n], i) => ({ name: names[i] || 'Player', n })), Number(players) || 0);
    }
  }
  // Lancement : une fois par événement, tant qu'il reste au moins 12 h (le tout premier, lancé en cours de semaine, aussi).
  if (ev.end - now < 12 * 3600000) return false;
  const [launch] = await redis([['SET', `discord:event:${ev.id}`, '1', 'NX', 'EX', 30 * 86400]]);
  if (launch === 'OK') Discord.announceEvent(ev);
  return launch === 'OK';
}

// Titre Trash King (idée d'Angelicide9, 2026-10-18) : le 1er du mois, dans les 6 premières heures, le joueur au pire
// tirage du mois qui vient de finir (classement lbw:month:<mois>) reçoit le titre ; une seule fois par mois.
async function trashKing(now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCDate() !== 1 || d.getUTCHours() >= 6) return null;
  const month = dayKey(now - 86400000).slice(0, 7);
  const [ok] = await redis([['SET', `award:trashking:${month}`, '1', 'NX', 'EX', 90 * 86400]]);
  if (ok !== 'OK') return null;
  const [low] = await redis([['ZRANGE', `lbw:month:${month}`, 0, 0]]);
  if (!low || !low.length) return null;
  await redis([['HINCRBY', `stats:${low[0]}`, 'trashKing', 1]]);
  return low[0];
}

// Weekend Rush : annonce le samedi, dans les 6 premières heures, une seule fois par week-end.
async function weekendRush(now = Date.now()) {
  if (!Discord.has('events') || new Date(now).getUTCDay() !== 6 || new Date(now).getUTCHours() >= 6) return false;
  const [ok] = await redis([['SET', `discord:rush:${dayKey(now)}`, '1', 'NX', 'EX', 7 * 86400]]);
  if (ok === 'OK') Discord.announceRush(Events.rushEnd(now));
  return ok === 'OK';
}

function start() {
  postNewUpdates().catch(err => console.error('discord updates:', err.message));
  const tick = () => { dailyRecap().catch(err => console.error('discord recap:', err.message)); weeklyEvent().catch(err => console.error('discord event:', err.message)); trashKing().catch(err => console.error('trash king:', err.message)); weekendRush().catch(err => console.error('discord rush:', err.message)); };
  tick();
  setInterval(tick, 10 * 60000).unref();
}

module.exports = { weekendRush, start, readUpdates, postNewUpdates, dailyRecap, weeklyEvent, trashKing };
