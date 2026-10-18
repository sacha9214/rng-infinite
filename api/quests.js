// GET  /api/quests?me=<playerId>                                  → quêtes du jour, progression, bonus quotidien, série
// POST /api/quests { playerId, secret, action: 'claim', quest }   → réclame la récompense d'une quête terminée
// POST /api/quests { playerId, secret, action: 'daily' }          → réclame le bonus quotidien (série de jours)
// Tout se lit sur les compteurs tenus par le serveur (q:<jour>:<id>) : rien ne se crédite depuis le site.
const { eco, redis, ownsPlayer, readStats, statsKey, questKey, dayKey, toObject, cors, send, flushDue } = require('./_lib');
const Quests = require('../js/quests.js');
const Shop = require('../js/shop.js');
const Events = require('../js/events.js');

// Événement de la semaine : progression, récompense réclamée, top 5 et ma place (classement des tirages du thème).
async function eventState(id, now) {
  const ev = Events.current(now), key = Events.key(ev);
  const [score, claimed, flat, rank, players] = await redis([['ZSCORE', key, id], ['SISMEMBER', `${key}:claimed`, id], ['ZREVRANGE', key, 0, 4, 'WITHSCORES'], ['ZREVRANK', key, id], ['ZCARD', key]]);
  const ids = []; for (let i = 0; i < (flat || []).length; i += 2) ids.push([flat[i], Number(flat[i + 1])]);
  const [names] = ids.length ? await redis([['HMGET', 'names', ...ids.map(x => x[0])]]) : [[]];
  return {
    id: ev.id, key: ev.key, emoji: ev.emoji, title: ev.title, desc: ev.desc, example: ev.example, goal: ev.goal, reward: ev.reward, end: ev.end,
    progress: Number(score) || 0, claimed: Number(claimed) === 1, rank: rank === null ? null : Number(rank) + 1, players: Number(players) || 0,
    top: ids.map(([pid, n], i) => ({ name: names[i] || 'Player', n, me: pid === id })),
  };
}

const isPlayerId = id => /^[0-9a-f]{16}$/.test(String(id || ''));

async function state(id, now = Date.now()) {
  const day = dayKey(now);
  // Première lecture depuis l'arrivée des niveaux : on part du niveau actuel (pas de récompenses en rattrapage).
  {
    const st0 = await readStats(id);
    if (st0.lvlPaid === undefined) { const L0 = Quests.levelOf(st0.xpLife); await redis([['HSETNX', statsKey(id), 'lvlPaid', L0], ['HSETNX', statsKey(id), 'lvlStart', L0]]); }
    else if (st0.lvlStart === undefined) await redis([['HSETNX', statsKey(id), 'lvlStart', st0.lvlPaid]]); // arrivés avant ce champ : leur dernier niveau payé
  }
  const [flat] = await redis([['HGETALL', questKey(day, id)]]);
  const counters = toObject(flat);
  const stats = await readStats(id);
  const claimedToday = stats.streakDay === day;
  // Série affichée : celle en cours si le bonus d'hier ou d'aujourd'hui a été pris, sinon elle est retombée à 0.
  const alive = claimedToday || stats.streakDay === Quests.dayBefore(day);
  const streak = alive ? Number(stats.streak) || 0 : 0;
  const event = await eventState(id, now);
  return {
    event,
    day,
    resetAt: Date.parse(`${day}T00:00:00Z`) + 86400000,
    coins: Shop.balance(stats),
    quests: Quests.ofDay(day).map(q => ({
      id: q.id, emoji: q.emoji, text: q.text, target: q.target, reward: q.reward,
      progress: Quests.progress(q, counters), claimed: counters[`claimed:${q.id}`] === '1',
    })),
    daily: { claimed: claimedToday, streak, reward: Quests.dailyReward(claimedToday ? streak : streak + 1), next: Quests.dailyReward((claimedToday ? streak : streak + 1) + 1) },
    level: (() => {
      const L = Quests.levelOf(stats.xpLife), paid = stats.lvlPaid === undefined ? L : Number(stats.lvlPaid) || 0;
      const pending = []; for (let l = paid + 1; l <= L; l++) pending.push(l);
      let coins = pending.reduce((x, l) => x + Quests.levelReward(l).coins, 0), keys = pending.map(l => Quests.levelReward(l).key).filter(Boolean);
      // Rattrapage des niveaux d'avant le système (une fois, plafonné) : lvlStart = niveau de départ du joueur.
      const start = Number(stats.lvlStart) || 0, catchup = start > 0 && stats.lvlCatch !== '1' ? Quests.catchUp(start) : null;
      if (catchup && (catchup.coins || catchup.keys.length)) { coins += catchup.coins; keys = keys.concat(catchup.keys); }
      const due = pending.length + (catchup && (catchup.coins || catchup.keys.length) ? 1 : 0);
      return { level: L, xp: Number(stats.xpLife) || 0, from: Quests.xpForLevel(L), to: Quests.xpForLevel(L + 1), pending: due, coins, keys, next: Quests.levelReward(L + 1), catchup: catchup && (catchup.coins || catchup.keys.length) ? catchup : null, start };
    })(),
    // Série de quêtes : jours de suite avec les 5 quêtes réclamées. Retombe à 0 si hier n'a pas été fini.
    questStreak: (() => {
      const doneToday = stats.qsDay === day, alive = doneToday || stats.qsDay === Quests.dayBefore(day), cur = alive ? Number(stats.qs) || 0 : 0;
      return { doneToday, streak: cur, best: Number(stats.qsBest) || 0, bonus: Quests.allDoneReward(doneToday ? cur : cur + 1) };
    })(),
  };
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  await flushDue();
  try {
    if (req.method === 'GET') {
      const me = new URL(req.url, 'http://localhost').searchParams.get('me');
      if (!isPlayerId(me)) return send(res, 400, { error: 'Invalid player' });
      return send(res, 200, await state(me));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const playerId = String(body.playerId || '');
    const secret = String(body.secret || '');
    if (!isPlayerId(playerId) || !/^[0-9a-f]{32}$/.test(secret)) return send(res, 400, { error: 'Invalid player' });
    if (!(await ownsPlayer(playerId, secret))) return send(res, 403, { error: 'This player id belongs to someone else' });
    const day = dayKey(Date.now());

    if (body.action === 'claim') {
      const quest = Quests.ofDay(day).find(q => q.id === String(body.quest || ''));
      if (!quest) return send(res, 400, { error: 'This quest is not available today' });
      const [flat] = await redis([['HGETALL', questKey(day, playerId)]]);
      if (Quests.progress(quest, toObject(flat)) < quest.target) return send(res, 422, { error: 'Quest not finished yet' });
      // Une seule fois : le marqueur du jour sert de verrou.
      const [first] = await redis([['HSETNX', questKey(day, playerId), `claimed:${quest.id}`, 1]]);
      if (Number(first) !== 1) return send(res, 422, { error: 'Reward already claimed' });
      await redis([['HINCRBY', statsKey(playerId), 'bonus', quest.reward], ['HINCRBY', statsKey(playerId), 'questsDone', 1], ...eco('in:quests', quest.reward)]);
      // Dernière quête du jour réclamée : la série de quêtes monte, et le bonus « tout fini » est versé (une seule fois).
      const [after] = await redis([['HGETALL', questKey(day, playerId)]]);
      const c = toObject(after);
      let allDone = null;
      if (Quests.ofDay(day).every(q => c[`claimed:${q.id}`] === '1')) {
        const [firstAll] = await redis([['HSETNX', questKey(day, playerId), 'allDone', 1]]);
        if (Number(firstAll) === 1) {
          const st = await readStats(playerId);
          const streak = st.qsDay === Quests.dayBefore(day) ? (Number(st.qs) || 0) + 1 : 1, bonus = Quests.allDoneReward(streak);
          await redis([['HSET', statsKey(playerId), 'qs', streak, 'qsDay', day, 'qsBest', Math.max(streak, Number(st.qsBest) || 0)], ['HINCRBY', statsKey(playerId), 'bonus', bonus]]);
          allDone = { streak, bonus };
        }
      }
      return send(res, 200, { ...(await state(playerId)), gained: quest.reward + (allDone ? allDone.bonus : 0), allDone });
    }

    if (body.action === 'level') {
      // Une réclamation à la fois (deux clics simultanés ne paient qu'une fois).
      const [lock] = await redis([['SET', `lvlclaim:${playerId}`, '1', 'NX', 'PX', 5000]]);
      if (lock !== 'OK') return send(res, 429, { error: 'Already claiming' });
      try {
        const st = await state(playerId), lv = st.level;
        if (!lv.pending) return send(res, 422, { error: 'No level reward to claim' });
        const writes = [['HSET', statsKey(playerId), 'lvlPaid', lv.level, ...(lv.catchup ? ['lvlCatch', '1'] : [])], ['HINCRBY', statsKey(playerId), 'bonus', lv.coins], ...eco('in:levels', lv.coins)];
        for (const k of lv.keys) writes.push(['HINCRBY', statsKey(playerId), `key:${k}`, 1]);
        await redis(writes);
        return send(res, 200, { ...(await state(playerId)), gained: lv.coins, keys: lv.keys, levels: lv.pending });
      } finally { await redis([['DEL', `lvlclaim:${playerId}`]]); }
    }
    // Récompense de l'événement de la semaine : une fois, objectif atteint (compté par le serveur à chaque tirage).
    if (body.action === 'event') {
      const ev = Events.current(), key = Events.key(ev);
      const [score] = await redis([['ZSCORE', key, playerId]]);
      if ((Number(score) || 0) < ev.goal) return send(res, 422, { error: `${ev.title}: ${Number(score) || 0} / ${ev.goal} so far` });
      const [fresh] = await redis([['SADD', `${key}:claimed`, playerId], ['EXPIRE', `${key}:claimed`, 60 * 86400]]);
      if (Number(fresh) !== 1) return send(res, 422, { error: 'Event reward already claimed' });
      await redis([['HINCRBY', statsKey(playerId), 'bonus', ev.reward], ['HINCRBY', statsKey(playerId), 'events', 1], ...eco('in:events', ev.reward)]);
      return send(res, 200, { ...(await state(playerId)), gained: ev.reward });
    }

    if (body.action === 'daily') {
      // Un seul bonus par jour, même avec deux clics simultanés.
      const [lock] = await redis([['SET', `daily:${day}:${playerId}`, '1', 'NX', 'EX', 2 * 86400]]);
      if (lock !== 'OK') return send(res, 422, { error: 'Daily bonus already claimed, come back tomorrow' });
      const stats = await readStats(playerId);
      const streak = Quests.nextStreak(day, stats.streakDay, stats.streak);
      const reward = Quests.dailyReward(streak);
      await redis([['HSET', statsKey(playerId), 'streak', streak, 'streakDay', day], ['HINCRBY', statsKey(playerId), 'bonus', reward], ...eco('in:daily', reward)]);
      return send(res, 200, { ...(await state(playerId)), gained: reward });
    }
    return send(res, 400, { error: 'Unknown action' });
  } catch (err) {
    return send(res, err.status || 500, { error: err.message });
  }
};
