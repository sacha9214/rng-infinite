// Test de bout en bout d'un duel (2026-10-23) : faux Redis, vrai serveur d'API, vrai navigateur (muet). Le créateur ouvre un
// salon, un joueur le rejoint (la partie démarre), les deux écrivent : le chat et les boutons du créateur doivent s'afficher.
//   node tools/e2e-duel.mjs <dossier des captures>
import http from 'node:http'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process';
import { fakeRedis } from './fake-redis.mjs';
import { firefox } from './.deps/node_modules/playwright/index.mjs';
const OUT = process.argv[2];
const mem = fakeRedis();
const relay = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(mem.run(JSON.parse(raw)))); });
await new Promise(r => relay.listen(0, '127.0.0.1', r));
const api = spawn(process.execPath, ['deploy/ovh/api-server.js'], { env: { ...process.env, PORT: '18799', RNG_REDIS_URL: `http://127.0.0.1:${relay.address().port}`, RNG_REDIS_TOKEN: 'x' }, stdio: 'ignore' });
const web = spawn('python3', ['-m', 'http.server', '8195'], { stdio: 'ignore' });
const P = (c, name, owner) => { const id = c.repeat(16), secret = c.repeat(32); mem.run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', 'rolls', '40', ...(owner ? ['owner', '1'] : [])], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
const O = P('a', 'Sacha', true), B = P('b', 'Bob');
const post = (who, action, extra = {}) => fetch('http://127.0.0.1:18799/api/room', { method: 'POST', body: JSON.stringify({ ...who, action, ...extra }) }).then(r => r.json());
try {
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:18799/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  const room = await post(O, 'create', { size: 2, mode: 'rounds', target: 3 });
  const code = room.code; console.log('code', code, room.error || '');
  const b = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0' } });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('http://localhost:8195/api/**', async r => { const u = new URL(r.request().url()); const resp = await r.fetch({ url: 'http://127.0.0.1:18799' + u.pathname + u.search }); r.fulfill({ response: resp }); });
  await p.addInitScript(o => localStorage.setItem('rnginf.v1', JSON.stringify({ player: { id: o.playerId, secret: o.secret, name: o.name }, settings: { onboarded: true }, rolls: [] })), O);
  await p.goto('http://localhost:8195/#/room/' + code); await p.waitForTimeout(2500);
  await post(B, 'join', { code }); await p.waitForTimeout(3500);
  console.log('c1', JSON.stringify(await post(B, 'chat', { code, text: 'hello from bob' })).slice(0,200)); await new Promise(r=>setTimeout(r,1500)); console.log('c2', JSON.stringify((await post(O, 'chat', { code, text: 'hi bob' })).chat)); await p.waitForTimeout(3000);
  const st = await p.evaluate(() => ({ view: document.querySelector('#chat-list') ? document.querySelector('#chat-list').innerText.slice(0, 120) : 'NO CHAT', prank: document.querySelector('#prank-bar') ? !document.querySelector('#prank-bar').hidden : 'none' }));
  console.log(JSON.stringify(st), errs);
  await p.screenshot({ path: OUT + '/duel-join.png' }); await b.close();
} finally { api.kill(); web.kill(); relay.close(); }
