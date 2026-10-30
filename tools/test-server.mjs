// Teste le serveur d'API du VPS (deploy/ovh/api-server.js) de bout en bout : un faux relais Redis en HTTP, le vrai
// serveur lancé dans un processus à part, et de vraies requêtes HTTP comme en envoie le site.
//   node tools/test-server.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeRedis } from './fake-redis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memory = fakeRedis();
let pipelines = 0;
const relay = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.headers.authorization !== 'Bearer test-token') { res.statusCode = 401; return res.end('{}'); }
  pipelines++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(memory.run(JSON.parse(raw))));
});
await new Promise(r => relay.listen(0, '127.0.0.1', r));

const PORT = 18787;
const child = spawn(process.execPath, [path.join(ROOT, 'deploy/ovh/api-server.js')], {
  env: { ...process.env, PORT: String(PORT), RNG_REDIS_URL: `http://127.0.0.1:${relay.address().port}`, RNG_REDIS_TOKEN: 'test-token', KOFI_TOKEN: 'kofi-test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
const post = async (p, body, type = 'text/plain', headers = {}) => { const r = await fetch(base + p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': type, ...headers } }); return { status: r.status, body: await r.json().catch(() => null) }; };

try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

  // 1. En vie, et les routes inconnues répondent proprement.
  let r = await get('/health');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal((await get('/api/nope')).status, 404);
  assert.equal((await get('/etc/passwd')).status, 404);
  assert.equal((await get('/api/_lib')).status, 404);

  // 2. Un tirage envoyé comme le fait le site depuis un autre domaine (text/plain, sans requête de contrôle).
  const alice = { playerId: 'a'.repeat(16), secret: '1'.repeat(32), name: 'Alice' };
  r = await post('/api/roll', { ...alice, nonce: 'abcdef0123456789' }, 'text/plain', { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Number.isInteger(r.body.n));
  // … et en application/json (comme sur le même domaine) : même traitement, le nonce rend le même tirage.
  const again = await post('/api/roll', { ...alice, nonce: 'abcdef0123456789' }, 'application/json');
  assert.equal(again.body.n, r.body.n);

  // 3. Lecture avec paramètres d'URL, et en-têtes CORS pour le site.
  r = await get(`/api/leaderboard?period=day&me=${alice.playerId}`);
  assert.equal(r.status, 200); assert.equal(r.body.entries[0].name, 'Alice');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const pre = await fetch(base + '/api/roll', { method: 'OPTIONS' });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-max-age'), '86400');

  // 4. Corps invalide ou trop gros : refusé sans faire tomber le serveur.
  assert.equal((await post('/api/roll', '{oops')).status, 400);
  assert.equal((await post('/api/roll', JSON.stringify({ pad: 'x'.repeat(300 * 1024) }))).status, 413);
  assert.equal((await post('/api/roll', '')).status, 400);

  // 5. Le formulaire de Ko-fi (application/x-www-form-urlencoded, champ data en JSON) arrive jusqu'à la fonction.
  const data = JSON.stringify({ verification_token: 'kofi-test', message_id: 'm1', type: 'Shop Order', amount: '3.00', currency: 'EUR' });
  r = await post('/api/site?kofi=1', new URLSearchParams({ data }).toString(), 'application/x-www-form-urlencoded');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bad = JSON.stringify({ verification_token: 'wrong', message_id: 'm2', type: 'Tip', amount: '3.00', currency: 'EUR' });
  assert.equal((await post('/api/site?kofi=1', new URLSearchParams({ data: bad }).toString(), 'application/x-www-form-urlencoded')).status, 401);

  // 6. La limite par adresse IP voit l'adresse transmise par Caddy : 900 par minute (300 avant le 2026-10-30), puis 429 ;
  // une autre adresse passe.
  let last = 0;
  for (let i = 0; i < 905; i++) last = (await get('/api/room?live=1', { 'X-Forwarded-For': '198.51.100.9' })).status;
  assert.equal(last, 429);
  assert.equal((await get('/api/room?live=1', { 'X-Forwarded-For': '198.51.100.10' })).status, 200);

  // 7. Toujours debout après tout ça, et arrêt propre sur SIGTERM (ce que fait une mise à jour).
  assert.equal((await get('/health')).status, 200);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  console.log(`OK — serveur d'API : ${pipelines} allers-retours vers le faux relais`);
} catch (err) {
  console.error(log);
  throw err;
} finally {
  child.kill('SIGKILL');
  relay.close();
}
