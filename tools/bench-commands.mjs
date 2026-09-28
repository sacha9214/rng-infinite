// Compte les commandes Redis (celles que facture Upstash) par requête d'API, sur la fausse base.
//   node tools/bench-commands.mjs
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeRedis } from './fake-redis.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.env.KV_REST_API_URL = 'https://fake-redis.test';
process.env.KV_REST_API_TOKEN = 'test-token';
const { run } = fakeRedis();
let commands = 0;
globalThis.fetch = async (url, opts) => { const cmds = JSON.parse(opts.body); commands += cmds.length; return { ok: true, json: async () => run(cmds) }; };
const call = (handler, { method = 'GET', url = '/', body } = {}) => new Promise(resolve => {
  const res = { statusCode: 200, setHeader() {}, end: d => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }) };
  handler({ method, url, body, headers: {} }, res);
});
const count = async fn => { const before = commands; await fn(); return commands - before; };
const room = require(path.join(ROOT, 'api/room.js'));
const roll = require(path.join(ROOT, 'api/roll.js'));
const leaderboard = require(path.join(ROOT, 'api/leaderboard.js'));
const p = (n) => ({ playerId: crypto.randomBytes(8).toString('hex'), secret: crypto.randomBytes(16).toString('hex'), name: n });
const a = p('Alice'), b = p('Bob');
await call(roll, { method: 'POST', body: a }); await call(roll, { method: 'POST', body: b });
let r = await call(room, { method: 'POST', body: { ...a, action: 'create', size: 2 } });
const code = r.body.code;
await call(room, { method: 'POST', body: { ...b, action: 'join', code } });
const get = (who, extra = '') => call(room, { url: `/api/room?code=${code}&me=${who.playerId}${extra}` });
const polls = [];
for (let i = 0; i < 10; i++) polls.push(await count(() => get(a)));
const avg = polls.reduce((x, y) => x + y, 0) / polls.length;
const lb = await count(() => call(leaderboard, { url: `/api/leaderboard?period=day&me=${a.playerId}` }));
console.log(`sondage de duel (moyenne sur 10) : ${avg.toFixed(1)} commandes ; classement : ${lb} commandes`);
console.log(`→ 1 h de duel à 2 joueurs, sondage toutes les 1,5 s : ${Math.round(avg * 2 * 3600 / 1.5).toLocaleString('fr-FR')} commandes`);
