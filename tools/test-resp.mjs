// Connexion directe à Redis (api/_resp.js) : chaque réponse doit être identique à celle du relais HTTP
// (deploy/ovh/redis-relay.py), sur un vrai Redis lancé pour l'occasion (redis-server doit être installé).
//   node tools/test-resp.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
try { execFileSync('redis-server', ['--version']); } catch (e) { console.log('redis-server absent : test ignoré'); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-resp-'));
const RPORT = 6390 + Math.floor(Math.random() * 500), HPORT = RPORT + 1000;
const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'test-token');
const redisProc = spawn('redis-server', ['--port', String(RPORT), '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
const relay = spawn('python3', [path.join(ROOT, 'deploy/ovh/redis-relay.py')], { env: { ...process.env, RELAY_PORT: String(HPORT), REDIS_PORT: String(RPORT), RELAY_TOKEN_FILE: tokenFile }, stdio: 'ignore' });
const stop = () => { redisProc.kill(); relay.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);

const { createClient, Reader, encode } = require(path.join(ROOT, 'api/_resp.js'));
const direct = createClient(`127.0.0.1:${RPORT}`);
const viaRelay = cmds => fetch(`http://127.0.0.1:${HPORT}/pipeline`, { method: 'POST', headers: { Authorization: 'Bearer test-token', Connection: 'close' }, body: JSON.stringify(cmds) }).then(r => r.json());
for (let i = 0; ; i++) { try { await viaRelay([['PING']]); await direct.pipeline([['PING']]); break; } catch (e) { if (i > 100) throw e; await new Promise(r => setTimeout(r, 50)); } }
const same = async (label, cmds) => { const a = await direct.pipeline(cmds), b = await viaRelay(cmds); assert.deepEqual(a, b, label); return a; };

// Types de réponses : simple, entier, chaîne, absent, tableaux (imbriqués, vides, avec des absents), erreurs.
await direct.pipeline([['SET', 'k', 'héllo 🎲 "quote" \\ ok'], ['HSET', 'h', 'a', '1', 'b', 'deux'], ['ZADD', 'z', '1', 'm1', '2.5', 'm2'], ['RPUSH', 'l', 'x', 'y'], ['SADD', 's', 'only'], ['INCR', 'n']]);
await same('lectures', [['GET', 'k'], ['GET', 'absent'], ['HGETALL', 'h'], ['HMGET', 'h', 'a', 'zz', 'b'], ['ZRANGE', 'z', '0', '-1', 'WITHSCORES'], ['ZSCORE', 'z', 'm2'], ['ZMSCORE', 'z', 'm1', 'nope'], ['LRANGE', 'l', '0', '-1'], ['LRANGE', 'vide', '0', '-1'], ['SMEMBERS', 's'], ['EXISTS', 'k'], ['TTL', 'k'], ['PING']]);
await same('erreurs dans une file', [['GET', 'h'], ['INCR', 'k'], ['GET', 'k'], ['NOPE_COMMAND']]);
await same('tableau imbriqué', [['SCAN', '0', 'MATCH', 'nothing*', 'COUNT', '100'], ['ZRANGE', 'z', '0', '0', 'WITHSCORES']]);
// Grosse réponse (un historique plein : 100 000 tirages), reçue en plusieurs morceaux.
const big = ['ZADD', 'hist'];
for (let i = 0; i < 100000; i++) big.push(String(1e12 + i), `${1e12 + i}:${i % 1000001}`);
await direct.pipeline([big]);
const [z] = await same('100 000 éléments', [['ZRANGE', 'hist', '0', '-1']]);
assert.equal(z.result.length, 100000);
// Beaucoup d'appels en même temps : chacun reçoit ses propres réponses, dans l'ordre.
const many = await Promise.all(Array.from({ length: 300 }, (_, i) => direct.pipeline([['SET', `p:${i}`, String(i)], ['GET', `p:${i}`], ['INCR', 'cpt']])));
many.forEach((r, i) => assert.equal(r[1].result, String(i), 'réponse à la bonne demande'));
assert.equal((await direct.pipeline([['GET', 'cpt']]))[0].result, '300');
// Commandes dangereuses refusées sans rien envoyer.
await assert.rejects(direct.pipeline([['FLUSHALL']]), e => e.unsent === true);
assert.equal((await direct.pipeline([['EXISTS', 'k']]))[0].result, 1, 'rien n\'a été effacé');

// Lecteur morcelé : la même réponse coupée à chaque octet donne le même résultat.
const wire = Buffer.from('*3\r\n$3\r\nabc\r\n*2\r\n:5\r\n$-1\r\n-ERR bad\r\n+OK\r\n$0\r\n\r\n*0\r\n*-1\r\n');
const whole = (() => { const r = new Reader(); r.push(wire); const out = []; for (let x = r.next(); x !== undefined; x = r.next()) out.push(x); return out; })();
assert.deepEqual(whole, [{ result: ['abc', [5, null], 'ERR bad'] }, { result: 'OK' }, { result: '' }, { result: [] }, { result: null }]);
for (let cut = 1; cut < wire.length; cut++) {
  const r = new Reader(), out = [];
  for (const part of [wire.subarray(0, cut), wire.subarray(cut)]) { r.push(part); for (let x = r.next(); x !== undefined; x = r.next()) out.push(x); }
  assert.deepEqual(out, whole, `coupé à ${cut}`);
}
assert.equal(encode([['SET', 'é', '1']]), '*3\r\n$3\r\nSET\r\n$2\r\né\r\n$1\r\n1\r\n', 'longueur en octets, pas en caractères');

// Redis arrêté : l'appel échoue (pas de blocage), puis la connexion revient quand Redis revient.
redisProc.kill();
await new Promise(r => setTimeout(r, 300));
await assert.rejects(direct.pipeline([['PING']]));
const back = spawn('redis-server', ['--port', String(RPORT), '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
process.on('exit', () => back.kill());
for (let i = 0; ; i++) { try { assert.equal((await direct.pipeline([['PING']]))[0].result, 'PONG'); break; } catch (e) { if (i > 100) throw e; await new Promise(r => setTimeout(r, 50)); } }

// Vitesse comparée (pour information) : 2 000 petits appels, 50 à la fois.
const bench = async call => { const t = performance.now(); for (let k = 0; k < 40; k++) await Promise.all(Array.from({ length: 50 }, () => call([['GET', 'k'], ['HGET', 'h', 'a'], ['ZSCORE', 'z', 'm1']]))); return (performance.now() - t).toFixed(0); };
await direct.pipeline([['SET', 'k', 'v'], ['HSET', 'h', 'a', '1'], ['ZADD', 'z', '1', 'm1']]);
const tDirect = await bench(c => direct.pipeline(c)), tRelay = await bench(viaRelay);
direct.close();
console.log(`OK — connexion directe identique au relais (2 000 appels : direct ${tDirect} ms, relais ${tRelay} ms)`);
process.exit(0);
