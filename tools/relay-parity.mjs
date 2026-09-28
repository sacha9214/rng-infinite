// Vérifie que deploy/ovh/redis-relay.py répond comme Upstash (et comme la fausse base des tests) : rejoue les
// commandes enregistrées pendant les tests (RECORD_REDIS=… node tools/test-api.mjs) sur la fausse base et sur un
// vrai Redis à travers le relais, puis compare chaque réponse.
//   node tools/relay-parity.mjs /tmp/rec.jsonl http://127.0.0.1:7391 <fichier du jeton>
import fs from 'node:fs';
import { fakeRedis } from './fake-redis.mjs';

const [file, url, tokenFile] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const { run } = fakeRedis();
const norm = v => JSON.stringify(v, (k, x) => (typeof x === 'number' ? String(x) : x)); // 1 et "1" : même valeur pour le site
let pipelines = 0, commands = 0, diffs = 0;
const volatile = /^(PTTL|TTL|SRANDMEMBER|SPOP|SCAN|RANDOMKEY)$/i; // réponses qui dépendent de l'heure réelle ou du hasard
for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const cmds = JSON.parse(line);
  let fake;
  try { fake = run(cmds); } catch (e) { fake = cmds.map(() => ({ error: String(e.message) })); }
  const res = await fetch(`${url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const real = await res.json();
  pipelines++;
  cmds.forEach((c, i) => {
    commands++;
    if (volatile.test(c[0])) return;
    const a = fake[i], b = real[i];
    const same = norm(a?.error ? { error: true } : a?.result) === norm(b?.error ? { error: true } : b?.result);
    // Ordre des HGETALL/SMEMBERS non garanti : comparer triés.
    const sorted = x => (Array.isArray(x) ? norm([...x].map(norm).sort()) : norm(x));
    if (!same && sorted(a?.result) !== sorted(b?.result)) {
      if (++diffs <= 12) console.log('ÉCART', JSON.stringify(c).slice(0, 90), '\n  faux :', JSON.stringify(a).slice(0, 120), '\n  vrai :', JSON.stringify(b).slice(0, 120));
    }
  });
}
console.log(`${pipelines} pipelines, ${commands} commandes rejouées, ${diffs} écarts`);
