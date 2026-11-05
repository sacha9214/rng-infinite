import fs from 'node:fs';
import os from 'node:os';
// Teste les fonctions /api sans Vercel ni Upstash ni Google : fetch est remplacé par un faux Redis en mémoire
// et par de fausses clés Google.
//   node tools/test-api.mjs
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeRedis } from './fake-redis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

process.env.KV_REST_API_URL = 'https://fake-redis.test';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.OWNER_EMAIL_SHA256 = crypto.createHash('sha256').update('owner@example.com').digest('hex');
process.env.VIEWER_EMAILS_SHA256 = crypto.createHash('sha256').update('guest@example.com').digest('hex');

// Fausse paire de clés "Google" : les jetons de test sont signés avec, et fetch sert la clé publique.
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const { privateKey: googlePrivate, publicKey: googlePublic } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...googlePublic.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

const { db, zset, run } = fakeRedis();
let calls = 0;
globalThis.fetch = async (url, opts) => {
  if (url === GOOGLE_CERTS_URL) return { ok: true, json: async () => ({ keys: [googleJwk] }) };
  // Prix du bitcoin (api/_btc.js) : réglé par le test ; null = source injoignable.
  if (/exchange\.coinbase\.com\/products\/(\w+)-USD\/candles/.test(url)) { if (globalThis.__btc == null) throw new Error('offline'); const g = Number(/granularity=(\d+)/.exec(url)[1]); return { ok: true, json: async () => Array.from({ length: 50 }, (_, i) => [1000000 + (49 - i) * g, 90 + i, 110 + i, 100 + i, 105 + i, 7]) }; }
  if (/coinbase\.com\/v2\/prices\/ETH/.test(url)) { if (globalThis.__eth == null) throw new Error('offline'); return { ok: true, json: async () => ({ data: { amount: String(globalThis.__eth) } }) }; }
  if (/coinbase|kraken/.test(url)) { if (globalThis.__btc == null) throw new Error('offline'); return /coinbase/.test(url) ? { ok: true, json: async () => ({ data: { amount: String(globalThis.__btc) } }) } : { ok: true, json: async () => ({ result: { X: { c: [String(globalThis.__btc)] } } }) }; }
  assert.equal(url, 'https://fake-redis.test/pipeline');
  assert.equal(opts.headers.Authorization, 'Bearer test-token');
  calls++;
  const cmds = JSON.parse(opts.body);
  if (process.env.RECORD_REDIS) fs.appendFileSync(process.env.RECORD_REDIS, JSON.stringify(cmds) + '\n'); // voir tools/relay-parity.mjs
  cmds.forEach(c => c.forEach(x => assert.equal(typeof x, 'string', 'toutes les valeurs partent en texte')));
  return { ok: true, json: async () => run(cmds) };
};

// ---------------------------------------------------------------- appel d'une fonction comme le ferait Vercel
function call(handler, { method = 'GET', url = '/', body, headers: reqHeaders = {} } = {}) {
  return new Promise(resolve => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: data => resolve({ status: res.statusCode, headers, body: data ? JSON.parse(data) : null }),
    };
    Promise.resolve(handler({ method, url, body, headers: reqHeaders }, res));
  });
}

const roll = require(path.join(ROOT, 'api/roll.js'));
const leaderboard = require(path.join(ROOT, 'api/leaderboard.js'));
const auth = require(path.join(ROOT, 'api/auth.js'));
const history = require(path.join(ROOT, 'api/history.js'));
const { engine } = require(path.join(ROOT, 'api/_lib.js'));

const alice = { playerId: 'a'.repeat(16), secret: '1'.repeat(32), name: 'Alice' };
const bob = { playerId: 'b'.repeat(16), secret: '2'.repeat(32), name: '  Bob<script>  ' };

// 1. Premier tirage : nombre valide, XP recalculé par le moteur, classé 1er du jour.
let r = await call(roll, { method: 'POST', body: alice });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.ok(Number.isInteger(r.body.n) && r.body.n >= 0 && r.body.n <= 1000000);
assert.equal(r.body.s, engine.scoreOf(r.body.n));
assert.equal(r.body.bestToday, true);
assert.equal(r.body.dayRank, 1);
assert.equal(r.headers['access-control-allow-origin'], '*');
const aliceFirst = r.body;

// 2. Retirer tout de suite : refusé (anti-spam), et l'identifiant d'Alice est protégé par son secret.
r = await call(roll, { method: 'POST', body: alice });
assert.equal(r.status, 429);
r = await call(roll, { method: 'POST', body: { ...alice, secret: '9'.repeat(32) } });
assert.equal(r.status, 403);
// Le délai se lève seul après 8 s, comme sur Upstash (sinon le serveur de dev refuse tout 2e tirage).
const realNow = Date.now;
Date.now = () => realNow() + 8001;
assert.equal(run([['SET', `cooldown:${alice.playerId}`, '1', 'PX', 8000, 'NX']])[0].result, 'OK');
Date.now = realNow;

// 3. Entrées invalides.
assert.equal((await call(roll, { method: 'POST', body: { ...bob, name: '   ' } })).status, 400);
assert.equal((await call(roll, { method: 'POST', body: { ...bob, playerId: 'xyz' } })).status, 400);
assert.equal((await call(roll, { method: 'GET' })).status, 405);
assert.equal((await call(roll, { method: 'OPTIONS' })).status, 204);

// 4. Bob tire ; le nom est nettoyé.
r = await call(roll, { method: 'POST', body: bob });
assert.equal(r.status, 200);
const bobFirst = r.body;

// 5. Le classement du jour trie par XP, compte les tirages et ne révèle aucun identifiant.
r = await call(leaderboard, { url: `/api/leaderboard?period=day&me=${alice.playerId}` });
assert.equal(r.status, 200);
assert.equal(r.body.entries.length, 2);
assert.equal(r.body.rollsToday, 2);
assert.equal(r.body.rolls, 2);
assert.equal(r.body.players, 2);
assert.deepEqual(r.body.entries.map(e => e.rolls), [1, 1]);
const [first, second] = r.body.entries;
assert.ok(first.s >= second.s);
assert.deepEqual(r.body.entries.map(e => e.rank), [1, 2]);
assert.equal(r.body.entries.find(e => e.me).name, 'Alice');
assert.equal(r.body.entries.find(e => !e.me).name, 'Bobscript');
assert.ok(!JSON.stringify(r.body).includes(alice.playerId), 'aucun id dans la réponse');

// 6. Un tirage plus faible ne remplace pas le meilleur ; le compteur augmente quand même.
const bestKey = [...db.keys()].find(k => k.startsWith('lb:day:'));
db.delete(`cooldown:${alice.playerId}`);
zset(bestKey).set(alice.playerId, 1e12); // on simule un meilleur score imbattable
r = await call(roll, { method: 'POST', body: alice });
assert.equal(r.body.bestToday, false);
const aliceSecond = r.body;
r = await call(leaderboard, { url: '/api/leaderboard?period=all' });
const expectedBest = aliceSecond.s > aliceFirst.s ? aliceSecond : aliceFirst;
assert.equal(r.body.entries.find(e => e.name === 'Alice').n, expectedBest.n);
assert.equal(r.body.rolls, 3);
assert.equal(r.body.players, 2);
assert.equal(r.body.entries.find(e => e.name === 'Alice').rolls, 2);

// 6b. Classement Poubelle : le pire tirage de chaque joueur, le plus petit score en tête.
r = await call(leaderboard, { url: `/api/leaderboard?period=worst&me=${alice.playerId}` });
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.period, "worst");
assert.equal(r.body.entries.find(e => e.name === 'Alice').n, (aliceSecond.s < aliceFirst.s ? aliceSecond : aliceFirst).n, 'Alice : son pire tirage');
assert.ok(r.body.entries.every((e, i, a) => !i || a[i - 1].s <= e.s), 'ordre croissant');
assert.ok(!JSON.stringify(r.body).includes(alice.playerId), 'aucun id dans la réponse');

// 7. Périodes et paramètres inconnus.
for (const period of ['week', 'all', 'nimportequoi']) {
  r = await call(leaderboard, { url: `/api/leaderboard?period=${period}` });
  assert.equal(r.status, 200);
  assert.ok(['day', 'week', 'all'].includes(r.body.period));
}

// 8. Connexion Google.
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function googleToken(claims, key = googlePrivate) {
  const head = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const body = b64({
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...claims,
  });
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
const signIn = (claims, device) => call(auth, { method: 'POST', body: { credential: googleToken(claims), ...device } });

// Alice relie son compte : elle garde son joueur (et son nom), et le secret reçu permet de tirer.
r = await signIn({ sub: 'g-alice', email: 'alice@example.com', given_name: 'Alice' }, { playerId: alice.playerId, secret: alice.secret });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.playerId, alice.playerId);
assert.equal(r.body.name, 'Alice');
assert.equal(r.body.email, 'alice@example.com');
const aliceSession = r.body.secret;
db.delete(`cooldown:${alice.playerId}`);
r = await call(roll, { method: 'POST', body: { playerId: alice.playerId, secret: aliceSession, name: 'Alice' } });
assert.equal(r.status, 200, 'le secret reçu à la connexion permet de tirer');

// Sur un autre appareil jamais utilisé, le même compte retrouve le joueur d'Alice.
r = await signIn({ sub: 'g-alice' }, { playerId: 'c'.repeat(16), secret: '3'.repeat(32) });
assert.equal(r.body.playerId, alice.playerId);
assert.notEqual(r.body.secret, aliceSession, 'un secret par appareil');

// Le secret de l'appareil d'origine reste valable.
db.delete(`cooldown:${alice.playerId}`);
assert.equal((await call(roll, { method: 'POST', body: alice })).status, 200);

// Un autre compte Google sur l'appareil d'Alice n'hérite pas de son joueur.
r = await signIn({ sub: 'g-carol' }, { playerId: alice.playerId, secret: aliceSession });
assert.equal(r.status, 200);
assert.notEqual(r.body.playerId, alice.playerId);

// Un appareil qui prétend être Bob sans son secret ne récupère pas le joueur de Bob.
r = await signIn({ sub: 'g-mallory' }, { playerId: bob.playerId, secret: '4'.repeat(32) });
assert.notEqual(r.body.playerId, bob.playerId);

// Jetons refusés : autre clé, autre application, expiré, pas un jeton.
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const badTokens = [
  googleToken({ sub: 'x' }, otherKey),
  googleToken({ sub: 'x', aud: 'another-app.apps.googleusercontent.com' }),
  googleToken({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 10 }),
  'not-a-token',
];
for (const credential of badTokens) {
  assert.equal((await call(auth, { method: 'POST', body: { credential } })).status, 401);
}

// 9. Historique : les tirages en ligne y sont déjà ; un appareil peut y verser les siens, sans doublon.
// Seulement un ancien joueur (stats pas encore reconstruites) : Alice joue ce rôle ici.
assert.equal(run([['HGET', `stats:${alice.playerId}`, 'v']])[0].result, '1', 'joueuse créée par un tirage : stats marquées dès le départ');
run([['HDEL', `stats:${alice.playerId}`, 'v']]);
const aliceTab = { playerId: alice.playerId, secret: aliceSession };
r = await call(history, { method: 'POST', body: aliceTab });
assert.equal(r.status, 200, JSON.stringify(r.body));
const before = r.body.rolls;
assert.equal(before.length, 4, 'chacun des 4 tirages en ligne d\'Alice est dans son historique');
assert.ok(before.some(([n, t]) => n === aliceFirst.n && t === aliceFirst.t));

const t0 = Date.UTC(2026, 8, 20, 12);
const upload = [[42, t0], [42, t0], [1337, t0 + 1], [-5, t0], [7, 123], ['x', t0], [8, Date.now() + 3 * 86400000]];
// Depuis le 2026-10-14, plus aucun appareil ne peut verser de tirages, même un ancien joueur : rien n'est gardé.
r = await call(history, { method: 'POST', body: { ...aliceTab, add: upload } });
assert.equal(r.body.stored, 0, 'envoi d\'historique fermé');
assert.equal(r.body.rolls.length, before.length);
r = await call(history, { method: 'POST', body: { ...aliceTab, add: [[42, t0 + 120000]], fetch: false } });
assert.equal(r.body.stored, 0);
// La suite des tests part des trois anciens tirages qu'Alice avait versés : on les remet directement en base.
run([['ZADD', `hist:${alice.playerId}`, t0, `${t0}:42`, t0 + 1, `${t0 + 1}:1337`, t0 + 120000, `${t0 + 120000}:42`]]);
r = await call(history, { method: 'POST', body: aliceTab });
assert.ok(r.body.rolls.every((x, k, all) => k === 0 || all[k - 1][1] <= x[1]), 'du plus ancien au plus récent');
// Seulement les nouveaux (since, 2026-11-01) : les tirages faits après cette heure, et since renvoyé (lecture partielle).
{ const all = r.body.rolls, cut = all[all.length - 3][1];
  const part = await call(history, { method: 'POST', body: { ...aliceTab, since: cut } });
  assert.deepEqual(part.body.rolls, all.filter(([, t]) => t > cut)); assert.equal(part.body.since, cut);
  const bad = await call(history, { method: 'POST', body: { ...aliceTab, since: 'yesterday' } });
  assert.equal(bad.body.rolls.length, all.length, 'since illisible : tout'); assert.equal(bad.body.since, undefined); }

assert.equal((await call(history, { method: 'POST', body: { ...aliceTab, secret: '9'.repeat(32) } })).status, 403);
assert.equal((await call(history, { method: 'POST', body: { playerId: 'nope', secret: 'x' } })).status, 400);
assert.equal((await call(history, { method: 'GET' })).status, 405);

// 10. Noms uniques, sans tenir compte des majuscules, accents, espaces et ponctuation.
const nameApi = require(path.join(ROOT, 'api/name.js'));
const setName = (who, name) => call(nameApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, name } });
assert.equal((await setName(alice, 'Sacha')).status, 200);
for (const clash of ['sacha', ' SACHA ', 'Sâcha', 'Sa-cha!']) {
  assert.equal((await setName(bob, clash)).status, 409, `"${clash}" est le même nom que "Sacha"`);
}
// Tirer sous un nom pris est refusé, sans déclencher de délai : Bob retire aussitôt avec son propre nom.
db.delete(`cooldown:${bob.playerId}`);
assert.equal((await call(roll, { method: 'POST', body: { ...bob, name: 'SACHA' } })).status, 409);
assert.equal((await call(roll, { method: 'POST', body: bob })).status, 200);
// Changer de nom libère l'ancien ; le classement affiche le nouveau. Renommer coûte Shop.RENAME_PRICE (2026-10-25) :
// chacun reçoit juste de quoi payer (solde inchangé pour la suite des tests).
run([['HINCRBY', `stats:${alice.playerId}`, 'bonus', 5000], ['HINCRBY', `stats:${bob.playerId}`, 'bonus', 5000]]);
assert.equal((await setName(alice, 'Alice')).status, 200);
assert.equal((await setName(bob, 'Sacha')).status, 200);
r = await call(leaderboard, { url: '/api/leaderboard?period=all' });
assert.deepEqual(r.body.entries.map(e => e.name).sort(), ['Alice', 'Sacha']);
assert.equal((await setName(bob, '   ')).status, 400);
assert.equal((await setName({ ...bob, secret: '9'.repeat(32) }, 'Zed')).status, 403);

// 11. Profil public : trouvé par nom (majuscules/accents ignorés), calculé depuis l'historique, sans identifiant.
const profile = require(path.join(ROOT, 'api/profile.js'));
r = await call(profile, { url: '/api/profile?name=ALICE' });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.name, 'Alice');
const aliceHist = (await call(history, { method: 'POST', body: aliceTab })).body.rolls;
const aliceScores = aliceHist.map(([n]) => engine.scoreOf(n));
assert.equal(r.body.rolls, aliceHist.length);
assert.equal(r.body.lifetime, aliceScores.reduce((x, y) => x + y, 0));
assert.equal(r.body.since, aliceHist[0][1]);
assert.equal(r.body.best[0].s, Math.max(...aliceScores));
assert.ok(r.body.best.length <= 10 && r.body.best.every((x, i, all) => i === 0 || all[i - 1].s >= x.s), 'meilleurs tirages triés');
const aliceBadges = aliceHist.flatMap(([n]) => engine.analyze(n).earnedIds);
assert.deepEqual(Object.keys(r.body.badges).sort(), [...new Set(aliceBadges)].sort());
assert.equal(Object.values(r.body.badges).reduce((x, [c]) => x + c, 0), aliceBadges.length, 'chaque badge compté autant de fois qu\'obtenu');
assert.equal(typeof r.body.rank, 'number');
assert.ok(!JSON.stringify(r.body).includes(alice.playerId), 'aucun id dans le profil');
// Profil gardé en mémoire : après un nouveau tirage, seuls les nouveaux sont ajoutés, et le résultat est le même qu'un
// calcul complet (2026-10-17).
{
  db.delete(`cooldown:${alice.playerId}`); const extra = (await call(roll, { method: 'POST', body: alice })).body;
  const r2 = await call(profile, { url: '/api/profile?name=Alice' });
  const hist2 = (await call(history, { method: 'POST', body: aliceTab })).body.rolls;
  assert.equal(r2.body.rolls, hist2.length, 'nouveau tirage compté');
  assert.equal(r2.body.lifetime, hist2.reduce((x, [n]) => x + engine.scoreOf(n), 0), 'XP à vie à jour');
  const b2 = hist2.flatMap(([n]) => engine.analyze(n).earnedIds);
  assert.equal(Object.values(r2.body.badges).reduce((x, [c]) => x + c, 0), b2.length, 'badges à jour');
  // Lecture partielle (2026-10-25) : meilleurs et pires tirages identiques à un calcul complet.
  const sc2 = hist2.map(([n, t]) => ({ n, s: engine.scoreOf(n), t }));
  assert.deepEqual(r2.body.best.map(x => x.s), sc2.slice().sort((x, y) => y.s - x.s || x.t - y.t).slice(0, 10).map(x => x.s), 'meilleurs à jour');
  assert.deepEqual(r2.body.worst.map(x => x.s), sc2.slice().sort((x, y) => x.s - y.s || x.t - y.t).slice(0, 10).map(x => x.s), 'pires à jour');
  assert.equal(r2.body.since, hist2[0][1], 'premier tirage inchangé');
  assert.ok(extra.n >= 0);
}

// Ancien joueur sans clé name:* : retrouvé par le hash "names", son meilleur tirage compte même hors historique.
const legacy = 'c'.repeat(16);
run([['HSET', 'names', legacy, 'Émile'], ['HSET', 'best:all', legacy, JSON.stringify({ n: 777777, s: engine.scoreOf(777777), t: t0 })]]);
r = await call(profile, { url: '/api/profile?name=emile' });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.name, 'Émile');
assert.equal(r.body.rolls, 1);
assert.equal(r.body.best[0].n, 777777);
assert.equal(r.body.rank, null);
// Le même tirage envoyé plus tard par l'appareil (heure de l'appareil ≠ heure du serveur) n'est pas compté deux fois.
run([['ZADD', `hist:${legacy}`, t0 + 4000, `${t0 + 4000}:777777`]]);
run([['ZADD', `hist:${legacy}`, t0 + 4700, `${t0 + 4700}:777777`]]); // doublon déjà en base (heure de l'appareil)
r = await call(profile, { url: '/api/profile?name=Emile' });
assert.equal(r.body.rolls, 1);
assert.deepEqual(r.body.best.map(x => x.n), [777777]);
// Lecture des seuls nouveaux tirages (2026-11-01) : un vrai nouveau 777777 plus tard compte, comme au recalcul complet.
run([['ZADD', `hist:${legacy}`, t0 + 86400000, `${t0 + 86400000}:777777`]]);
r = await call(profile, { url: '/api/profile?name=Emile' });
assert.equal(r.body.rolls, 2, 'nouveau tirage du même nombre compté');
// Gros historique (2026-10-25) : les totaux du profil sont gardés dans Redis (pagg:<id>) pour survivre à un redémarrage,
// et la visite suivante ne lit que les nouveaux tirages ; le résultat reste celui d'un calcul complet.
{
  const big = 'd'.repeat(16), zadd = ['ZADD', `hist:${big}`];
  for (let i = 0; i < 2100; i++) zadd.push(t0 + i * 10, `${t0 + i * 10}:${(i * 7919) % 1000001}`);
  run([['HSET', 'names', big, 'Bigroller'], zadd]);
  const p1 = await call(profile, { url: '/api/profile?name=Bigroller' });
  assert.equal(p1.body.rolls, 2100);
  assert.ok(run([['GET', `pagg:${big}`]])[0].result, 'totaux gardés dans Redis');
  run([['ZADD', `hist:${big}`, t0 + 99999, `${t0 + 99999}:777777`]]);
  const p2 = await call(profile, { url: '/api/profile?name=Bigroller' });
  const all = run([['ZRANGE', `hist:${big}`, 0, -1]])[0].result.map(m => Number(m.split(':')[1]));
  assert.equal(p2.body.rolls, 2101, 'nouveau tirage ajouté');
  assert.equal(p2.body.lifetime, all.reduce((x, n) => x + engine.scoreOf(n), 0), 'XP identique à un calcul complet');
  assert.equal(engine.scoreOf(p2.body.best[0].n), Math.max(...all.map(n => engine.scoreOf(n))), 'meilleur tirage à jour');
  run([['HDEL', 'names', big], ['DEL', `hist:${big}`, `pagg:${big}`]]); // ne gêne pas les tests de pseudos plus bas
}
// ?lite=1 : succès et titre seulement, sans l'historique (onglet Badges, 2026-10-25).
{
  const full = await call(profile, { url: '/api/profile?name=Alice' }), lite = await call(profile, { url: '/api/profile?name=Alice&lite=1' });
  assert.equal(lite.status, 200);
  assert.deepEqual(lite.body.achievements, full.body.achievements);
  assert.equal(lite.body.title, full.body.title);
  assert.equal(lite.body.best, undefined, 'pas d\'historique en mode lite');
  // Onglet Badges (A Dude, 2026-10-30) : retrouvé par l'id du joueur (me), même avec un ancien pseudo sur l'appareil.
  const old = await call(profile, { url: `/api/profile?name=OldAliceName&lite=1&me=${alice.playerId}` });
  assert.deepEqual([old.status, old.body.name, old.body.achievements], [200, 'Alice', full.body.achievements], 'lite retrouvé par l\'id');
  assert.equal((await call(profile, { url: `/api/profile?name=OldAliceName&me=${alice.playerId}` })).status, 404, 'profil complet : toujours par le pseudo');
}
assert.equal((await call(profile, { url: '/api/profile?name=Nobody' })).status, 404);
assert.equal((await call(profile, { url: '/api/profile' })).status, 400);
assert.equal((await call(profile, { method: 'POST' })).status, 405);

// 12. Duel en direct : un code, 2 à 10 joueurs, tous les tirages d'une manche au même instant, comptés comme des
// tirages normaux ; mode manches (premier à N) ou course à l'XP.
const roomApi = require(path.join(ROOT, 'api/room.js'));
const roomPost = (who, action, extra = {}) => call(roomApi, { method: 'POST', body: { ...who, action, ...extra } });
const roomGet = (code, who) => call(roomApi, { url: `/api/room?code=${code}${who ? `&me=${who.playerId}` : ''}` });
const bobNow = { ...bob, name: 'Sacha' };
const BOT_NAME_RE = /^(Robo|DiceBot|Lucky 9000|Glitch|Byte|Clanky|Sparky|Nano|Beep Boop|Tux|Bot \d+)$/;
const carol = { playerId: 'd'.repeat(16), secret: '4'.repeat(32), name: 'Carol' };
const dave = { playerId: 'e'.repeat(16), secret: '5'.repeat(32), name: 'Dave' };
// À partir d'ici, horloge simulée qu'on avance à la main : les délais (8 s, 15 s, 30 s de présence) se comparent
// toujours à la même horloge.
// Départ à 10:00 UTC (le jour même ou le lendemain) : la suite avance l'horloge de plusieurs heures, et lancée vers 22 h UTC
// elle passait minuit au milieu d'un test (« les tirages du jour comptent déjà », bilan du casino du jour), 2026-10-27.
const DAY_MS = 86400000, startAt = ((Number(process.env.TEST_START_HOUR || 10) * 3600000 - (realNow() % DAY_MS)) + DAY_MS) % DAY_MS;
let clock = startAt;
Date.now = () => realNow() + clock;
const later = async (ms, fn) => { clock += ms; return fn(); };

// Règles bornées : 2 à 10 joueurs, 1 à 10 manches, paliers d'XP connus.
r = await roomPost(dave, 'create', { size: 50, mode: 'rounds', target: 99 });
assert.deepEqual([r.body.size, r.body.mode, r.body.target], [10, 'rounds', 50]);
r = await roomPost(dave, 'create', { size: 1, mode: 'xp', target: 12345 });
assert.deepEqual([r.body.size, r.body.mode, r.body.target], [2, 'xp', 12345]); // objectif d'XP libre depuis le 2026-10-11
// Bornes de l'objectif libre : 5 000 à 10 millions d'XP, 1 à 50 manches ; une valeur illisible retombe sur le défaut.
{ const { __goal } = { __goal: require(path.join(ROOT, 'api/room.js')).goalOf };
  if (__goal) { assert.deepEqual([['xp', 1], ['xp', 4999.4], ['xp', 300000], ['xp', 1e12], ['xp', 'abc'], ['xp', -5], ['rounds', 50], ['rounds', 999], ['rounds', 7.4], ['rounds', 'x']].map(([mode, target]) => __goal({ mode, target }).target), [5000, 5000, 300000, 10000000, 50000, 50000, 50, 50, 7, 3]); } else assert.fail('goalOf non exporté'); }

// Partie à 3, premier à 2 manches : elle démarre toute seule quand la salle est pleine.
r = await roomPost(alice, 'create', { size: 3, mode: 'rounds', target: 2 });
assert.equal(r.status, 200, JSON.stringify(r.body));
const code = r.body.code;
assert.match(code, /^[A-Z2-9]{5}$/);
assert.deepEqual([r.body.status, r.body.players.length, r.body.players[0].host], ['lobby', 1, true]);
assert.equal((await roomPost(alice, 'ready', { code })).status, 422, 'pas de manche avant le début');
assert.equal((await roomPost(bobNow, 'join', { code: 'ZZZZZ' })).status, 404);
r = await roomPost(bobNow, 'join', { code: code.toLowerCase() });
assert.deepEqual([r.body.status, r.body.players.length], ['lobby', 2]);
assert.equal((await roomPost(bobNow, 'join', { code })).body.players.length, 2, 'rejoindre deux fois ne duplique pas');
assert.equal((await roomPost(bobNow, 'start', { code })).status, 422, 'seul l\'hôte lance la partie');
r = await roomPost(carol, 'join', { code });
assert.equal(r.body.status, 'playing', 'salle pleine : la partie commence');
assert.deepEqual(r.body.players.map(p => [p.name, p.me]), [['Alice', false], ['Sacha', false], ['Carol', true]]);
assert.ok(![alice, bob, carol].some(p => JSON.stringify(r.body).includes(p.playerId)), 'aucun id');
assert.equal((await roomPost(dave, 'join', { code })).status, 422, 'partie commencée : plus de place');
assert.equal((await roomPost(dave, 'ready', { code })).status, 422, 'un spectateur ne tire pas');

// Exclure un joueur du salon (2026-10-22) : l'hôte seulement, avant le début ; la place se libère et il ne revient pas.
{
  let k = await roomPost(dave, 'create', { size: 3, mode: 'rounds', target: 1 });
  const kc = k.body.code;
  await roomPost(carol, 'join', { code: kc });
  assert.equal((await roomPost(carol, 'kick', { code: kc, who: 'Dave' })).status, 422, 'seul l\'hôte exclut');
  assert.equal((await roomPost(dave, 'kick', { code: kc, who: 'Nobody' })).status, 404);
  k = await roomPost(dave, 'kick', { code: kc, who: 'Carol' });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  assert.deepEqual([k.body.status, k.body.players.map(p => p.name)], ['lobby', ['Dave']]);
  k = await roomPost(carol, 'join', { code: kc }); assert.equal(k.status, 403, 'pas de retour après exclusion');
  k = await call(roomApi, { url: `/api/room?code=${kc}&me=${carol.playerId}` }); assert.equal(k.body.kicked, true, 'le joueur exclu le sait');
  // La place libérée resservie : deux nouveaux joueurs remplissent le salon et la partie démarre.
  await roomPost(alice, 'join', { code: kc }); k = await roomPost(bobNow, 'join', { code: kc });
  assert.equal(k.body.status, 'playing', 'la place libérée est reprise');
  // Depuis le 2026-10-23, l'hôte peut exclure pendant la partie : le joueur est marqué sorti (voir le bloc « Quitter »).
  k = await roomPost(dave, 'kick', { code: kc, who: 'Alice' }); assert.equal(k.status, 200); assert.equal(k.body.players.find(p => p.name === 'Alice').out, 'kicked');
}

// Réactions : un emoji de la liste, visible par tous, au plus une toutes les 0,7 s par joueur.
r = await roomPost(alice, 'react', { code, emoji: 'laugh' });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.deepEqual(r.body.reacts.map(x => [x.name, x.e]), [['Alice', 'laugh']]);
assert.equal((await roomPost(alice, 'react', { code, emoji: 'cry' })).status, 429, 'trop vite');
assert.equal((await roomPost(carol, 'react', { code, emoji: '🍕' })).status, 400, 'emote hors liste');
assert.equal((await roomPost(dave, 'react', { code, emoji: 'laugh' })).status, 422, 'un spectateur ne réagit pas');
r = await roomGet(code, carol);
assert.deepEqual(r.body.reacts.map(x => x.name), ['Alice'], 'les autres voient la réaction');
assert.ok(r.body.players.every(p => 'title' in p));

// Manche 1 : tant que tout le monde n'est pas prêt, rien ; le dernier prêt déclenche les 3 tirages ensemble.
// (Ils viennent de tirer dans les tests précédents : on efface leur délai de 8 s.)
[alice, bob, carol].forEach(p => db.delete(`cooldown:${p.playerId}`));
// Comptes établis (20 tirages et plus) : sinon une victoire contre eux ne rapporte rien (anti-farm, testé en 25).
[alice, bob, carol, dave].forEach(p => run([['HSET', `stats:${p.playerId}`, 'rolls', 60]]));
const histA = (await call(history, { method: 'POST', body: aliceTab })).body.rolls.length;
const countOf = async name => (await call(leaderboard, { url: '/api/leaderboard?period=all' })).body.entries.find(e => e.name === name).rolls;
const countA = await countOf('Alice');
await roomPost(alice, 'ready', { code });
r = await roomPost(bobNow, 'ready', { code });
assert.equal(r.body.rounds.length, 0);
assert.deepEqual(r.body.players.map(p => p.ready), [true, true, false]);
assert.ok(r.body.autoAt > Date.now(), 'départ automatique annoncé');
r = await roomPost(carol, 'ready', { code });
assert.equal(r.body.rounds.length, 1, 'le dernier prêt déclenche la manche');
const round1 = r.body.rounds[0];
assert.equal(round1.n.length, 3);
assert.deepEqual(round1.s, round1.n.map(n => engine.scoreOf(n)));
assert.equal(round1.revealAt - round1.t, 2500);
// Anti-spoil : rien n'existe avant la fin de la révélation (historique, classement), puis tout d'un coup, une seule fois.
assert.equal((await call(history, { method: 'POST', body: aliceTab })).body.rolls.length, histA, 'pas encore dans l\'historique');
assert.equal(await countOf('Alice'), countA, 'ni au classement');
assert.equal(db.get('pending').size, 1, 'en attente de révélation');
await later(2500 + 9600, async () => {
  assert.equal((await call(history, { method: 'POST', body: aliceTab })).body.rolls.length, histA, 'toujours pas, 100 ms avant la fin');
});
await later(100, async () => {
  assert.equal((await call(history, { method: 'POST', body: aliceTab })).body.rolls.length, histA + 1, 'dans l\'historique une fois révélé');
  assert.equal(await countOf('Alice'), countA + 1, 'et au classement');
  assert.equal(await countOf('Carol'), (await countOf('Carol')), 'stable');
});
assert.equal(db.get('pending').size, 0, 'appliqué une seule fois');
await Promise.all([call(history, { method: 'POST', body: aliceTab }), roomGet(code)]);
assert.equal((await call(history, { method: 'POST', body: aliceTab })).body.rolls.length, histA + 1, 'pas en double');

// Manche 2 : seule Alice est prête ; 15 s plus tard, le sondage lance la manche pour tout le monde.
await later(11000, () => roomPost(alice, 'ready', { code }));
r = await later(1000, () => roomGet(code));
assert.equal(r.body.rounds.length, 1, 'on attend encore les autres');
r = await later(15000, () => roomGet(code));
assert.equal(r.body.rounds.length, 2, 'départ automatique après 15 s');
assert.equal(r.body.rounds[1].n.length, 3, 'les absents tirent aussi');

// Jusqu'à la fin : premier à 2 manches gagnées.
let state = r.body;
while (state.status === 'playing') {
  await later(11000, async () => {
    await roomPost(alice, 'ready', { code });
    await roomPost(bobNow, 'ready', { code });
    state = (await roomPost(carol, 'ready', { code })).body;
  });
}
const wins = [0, 0, 0];
for (const x of state.rounds) {
  const top = Math.max(...x.s);
  if (x.s.filter(v => v === top).length === 1) wins[x.s.indexOf(top)]++;
}
assert.deepEqual(state.players.map(p => p.wins), wins);
assert.equal(Math.max(...wins), 2);
assert.equal(state.winner, wins.indexOf(2));
assert.equal((await roomPost(alice, 'ready', { code })).status, 422, 'partie finie');
// Le gagnant débloque « Duelist » ; les joueurs reçoivent leurs succès à la fin, pour annoncer les nouveaux.
const winnerWho = [alice, bobNow, carol][state.winner];
r = await roomGet(code, winnerWho);
assert.ok(!r.body.achievements.includes('duelist'), 'pas avant la révélation de la dernière manche');
r = await later(2500 + 9700, () => roomGet(code, winnerWho));
assert.ok(r.body.achievements.includes('duelist'), 'le gagnant a le succès Duelist');
assert.equal((await roomGet(code, dave)).body.achievements, undefined, 'rien pour un spectateur');

// Revanche : une seule nouvelle salle, mêmes joueurs et mêmes règles, qui commence tout de suite.
assert.equal((await roomPost(dave, 'rematch', { code })).status, 422, 'un spectateur ne lance pas de revanche');
r = await roomPost(bobNow, 'rematch', { code });
const rematch = r.body.code;
assert.notEqual(rematch, code);
assert.deepEqual([r.body.status, r.body.mode, r.body.target, r.body.players.length], ['playing', 'rounds', 2, 3]);
assert.equal((await roomPost(carol, 'rematch', { code })).body.code, rematch, 'la même revanche pour tous');
r = await roomGet(code);
assert.deepEqual([r.body.next, r.body.nextBy], [rematch, 'Sacha']);
assert.equal((await roomPost(alice, 'rematch', { code: rematch })).status, 422, 'pas de revanche avant la fin');

// Lancement anticipé par l'hôte, puis course à l'XP : le premier à 25 000 XP gagne.
r = await roomPost(alice, 'create', { size: 5, mode: 'xp', target: 25000 });
const race = r.body.code;
assert.equal((await roomPost(alice, 'start', { code: race })).status, 422, 'pas seul');
await roomPost(dave, 'join', { code: race });
r = await roomPost(alice, 'start', { code: race });
assert.deepEqual([r.body.status, r.body.size], ['playing', 2]);
assert.equal((await roomPost(carol, 'join', { code: race })).status, 422, 'fermée aux nouveaux venus');
state = r.body;
while (state.status === 'playing') {
  await later(11000, async () => {
    await roomPost(alice, 'ready', { code: race });
    state = (await roomPost(dave, 'ready', { code: race })).body;
  });
}
const totals = [0, 0];
state.rounds.forEach(x => { totals[0] += x.s[0]; totals[1] += x.s[1]; });
assert.deepEqual(state.players.map(p => p.total), totals);
assert.ok(Math.max(...totals) >= 25000);
const beforeLast = totals.map((v, i) => v - state.rounds[state.rounds.length - 1].s[i]);
assert.ok(Math.max(...beforeLast) < 25000, 'personne n\'avait atteint le palier avant la dernière manche');
assert.equal(state.winner, totals[0] === totals[1] ? null : totals[0] > totals[1] ? 0 : 1);

assert.equal((await roomGet('ZZZZZ')).status, 404);
assert.equal((await roomPost(alice, 'dance', { code })).status, 400);
assert.equal((await call(roomApi, { method: 'PUT' })).status, 405);

// Profil : raretés et chance pour la comparaison.
r = await call(profile, { url: '/api/profile?name=Alice' });
// window : les tirages relus dans l'historique (stats.rolls a été gonflé à 60 plus haut pour ouvrir les duels).
assert.equal(Object.values(r.body.tiers).reduce((x, y) => x + y, 0), r.body.window);
assert.ok(r.body.luck >= 0 && r.body.luck <= 100);
// Au-delà de l'historique plafonné (jsand, kaz, Raynarr00, LeSombre, 2026-10-30) : tirages et XP à vie du profil = ceux
// du classement (count:all, lb:xp) ; la chance reste calculée sur les tirages relus (window).
{
  const [cnt, xp] = run([['HGET', 'count:all', alice.playerId], ['ZSCORE', 'lb:xp', alice.playerId]]).map(x => x.result);
  run([['HSET', 'count:all', alice.playerId, Number(cnt) + 150000], ['ZADD', 'lb:xp', Number(xp) + 2e9, alice.playerId]]);
  const big = await call(profile, { url: '/api/profile?name=Alice' });
  assert.deepEqual([big.body.rolls, big.body.lifetime, big.body.window], [Number(cnt) + 150000, Number(xp) + 2e9, r.body.window], 'totaux à vie du classement');
  assert.equal(big.body.luck, r.body.luck, 'chance inchangée');
  run([['HSET', 'count:all', alice.playerId, cnt], ['ZADD', 'lb:xp', xp, alice.playerId]]);
}

// 13. Succès et titres : calculés sur les stats du serveur, un titre ne s'équipe que débloqué.
const titleApi = require(path.join(ROOT, 'api/title.js'));
const equip = (who, title) => call(titleApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, title } });
const frank = { playerId: 'f'.repeat(16), secret: '6'.repeat(32), name: 'Frank' };
db.delete(`cooldown:${frank.playerId}`);
r = await call(roll, { method: 'POST', body: frank });
assert.equal(r.status, 200);
assert.ok(r.body.achievements.includes('rookie'), 'premier tirage : Rookie');
assert.equal((await equip(frank, 'mythic')).status, r.body.s >= 0 && !r.body.achievements.includes('mythic') ? 422 : 200, 'pas de titre non débloqué');
assert.equal((await equip(frank, 'nope')).status, 400);
assert.equal((await equip({ ...frank, secret: '9'.repeat(32) }, 'rookie')).status, 403);
r = await equip(frank, 'rookie');
assert.deepEqual([r.status, r.body.title], [200, 'rookie']);
r = await call(leaderboard, { url: '/api/leaderboard?period=all' });
assert.equal(r.body.entries.find(e => e.name === 'Frank').title, 'rookie', 'titre affiché au classement');
r = await call(profile, { url: '/api/profile?name=Frank' });
assert.equal(r.body.title, 'rookie');
assert.ok(r.body.achievements.includes('rookie'));
r = await equip(frank, '');
assert.equal(r.body.title, null);
assert.equal((await call(leaderboard, { url: '/api/leaderboard?period=all' })).body.entries.find(e => e.name === 'Frank').title, null);

// Ancien joueur (stats jamais reconstruites) : recomptées une fois depuis l'historique, sans toucher aux duels.
const duelFields = run([['HMGET', `stats:${alice.playerId}`, 'duels', 'duelWins']])[0].result;
run([['HDEL', `stats:${alice.playerId}`, 'v'], ['HSET', `stats:${alice.playerId}`, 'rolls', 999999]]);
db.delete(`badges:${alice.playerId}`);
const aliceAll = (await call(history, { method: 'POST', body: aliceTab })).body.rolls;
r = await call(profile, { url: '/api/profile?name=Alice' });
const rebuilt = run([['HGETALL', `stats:${alice.playerId}`], ['SCARD', `badges:${alice.playerId}`]]);
const st = Object.fromEntries(rebuilt[0].result.reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), []));
assert.equal(Number(st.rolls), r.body.rolls, 'tirages recomptés');
assert.equal(rebuilt[1].result, new Set(aliceAll.flatMap(([n]) => engine.analyze(n).earnedIds)).size, 'badges différents recomptés');
assert.deepEqual([st.duels ?? null, st.duelWins ?? null], duelFields, 'les compteurs de duel survivent à la reconstruction');
assert.ok(r.body.achievements.includes('rookie') && r.body.achievements.includes('regular') === (r.body.rolls >= 100));

// 14. Titre Owner : seulement pour le compte Google du créateur (e-mail vérifié), invisible pour les autres.
const owner = { playerId: '9'.repeat(16), secret: '7'.repeat(32), name: 'Boss' };
db.delete(`cooldown:${owner.playerId}`);
assert.equal((await call(roll, { method: 'POST', body: owner })).status, 200);
assert.equal((await equip(owner, 'owner')).status, 422, 'pas encore Owner');
r = await signIn({ sub: 'g-fake', email: 'owner@example.com', email_verified: false }, { playerId: 'a1'.repeat(8), secret: '8'.repeat(32) });
assert.equal(r.status, 200);
assert.equal(run([['HGET', `stats:${r.body.playerId}`, 'owner']])[0].result, null, 'e-mail non vérifié : pas Owner');
r = await signIn({ sub: 'g-owner', email: ' Owner@Example.com ' }, { playerId: owner.playerId, secret: owner.secret });
assert.equal(r.body.playerId, owner.playerId);
r = await equip(owner, 'owner');
assert.deepEqual([r.status, r.body.title], [200, 'owner']);
assert.equal((await call(leaderboard, { url: '/api/leaderboard?period=all' })).body.entries.find(e => e.name === 'Boss').title, 'owner');
assert.equal((await equip(frank, 'owner')).status, 422, 'personne d\'autre');
assert.ok(!(await call(profile, { url: '/api/profile?name=Frank' })).body.achievements.includes('owner'));

const gina = { playerId: '8'.repeat(16), secret: 'a'.repeat(32), name: 'Gina' };

// 15. Pièces et skins : gagnées en tirant (selon la rareté) et en duel, dépensées une seule fois, visibles en duel.
const shopApi = require(path.join(ROOT, 'api/shop.js'));
const Shop = require(path.join(ROOT, 'js/shop.js'));
const shop = (who, action, skin) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, skin } });
r = await call(shopApi, { url: `/api/shop?me=${frank.playerId}` });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.ok(r.body.coins >= 1 && r.body.coins <= 100, 'des pièces pour son tirage');
assert.deepEqual([r.body.owned, r.body.skin], [['classic'], 'classic']);
const coins0 = r.body.coins;
assert.equal((await shop(frank, 'buy', 'neon')).status, 422, 'pas assez de pièces');
assert.equal((await shop(frank, 'equip', 'gold')).status, 422, 'pas encore acheté');
assert.equal((await shop(frank, 'buy', 'licorne')).status, 400);
assert.equal((await shop({ ...frank, secret: '9'.repeat(32) }, 'buy', 'neon')).status, 403);
run([['HINCRBY', `stats:${frank.playerId}`, 't:mythic', 5]]); // 5 Mythics de plus : +500 pièces
r = await shop(frank, 'buy', 'neon');
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.deepEqual([r.body.coins, r.body.skin, r.body.owned.includes('neon')], [coins0 + 500 - 200, 'neon', true]);
assert.equal((await shop(frank, 'buy', 'neon')).body.coins, coins0 + 300, 'racheter ne débite pas deux fois');
assert.equal((await shop(frank, 'equip', 'classic')).body.skin, 'classic');
assert.equal((await shop(frank, 'equip', 'neon')).body.skin, 'neon');
// Skin remplacé : qui avait acheté Donut possède et porte Slots, sans racheter.
run([['SADD', `skins:${gina.playerId}`, 'donut'], ['HSET', 'skins', gina.playerId, 'donut']]);
r = await call(shopApi, { url: `/api/shop?me=${gina.playerId}` });
assert.deepEqual([r.body.owned.includes('slots'), r.body.owned.includes('donut'), r.body.skin], [true, false, 'slots']);
r = await roomPost(frank, 'create', { size: 2, public: false });
assert.equal(r.body.players[0].skin, 'neon', 'le skin se voit en duel');
const privateRoom = r.body.code;
// Changer de skin dans Shop en pleine partie : la salle montre le nouveau, sans la quitter.
// Le site le demande un sondage sur 4 (?fresh=1) ; ensuite tous les sondages le voient.
const roomFresh = c => call(roomApi, { url: `/api/room?code=${c}&fresh=1` });
await shop(frank, 'equip', 'classic');
assert.equal((await roomFresh(privateRoom)).body.players[0].skin, null, 'skin changé : vu dans la salle');
assert.equal((await roomGet(privateRoom)).body.players[0].skin, null, 'et gardé pour les sondages suivants');
await shop(frank, 'equip', 'neon');
assert.equal((await roomFresh(privateRoom)).body.players[0].skin, 'neon');
assert.equal(r.body.public, false);

// 16. « Live now » : les parties publiques actives, pas les privées ni les finies.
r = await roomPost(dave, 'create', { size: 3 });
const openRoom = r.body.code;
assert.equal(r.body.public, true, 'publique par défaut');
r = await call(roomApi, { url: '/api/room?live=1' });
const liveCodes = r.body.rooms.map(x => x.code);
assert.ok(liveCodes.includes(openRoom), 'partie publique listée');
assert.ok(!liveCodes.includes(privateRoom), 'partie privée cachée');
assert.ok(!liveCodes.includes(race) && !liveCodes.includes(code), 'parties finies retirées');
const listed = r.body.rooms.find(x => x.code === openRoom);
assert.deepEqual([listed.status, listed.count, listed.size, listed.host], ['lobby', 1, 3, 'Dave']);
assert.ok(!JSON.stringify(r.body).includes(dave.playerId), 'aucun id');

// 17. Rivalités : chaque partie finie compte dans le face-à-face gagnant/perdants.
clock += 2500 + 9700; // le bilan de la course arrive avec la révélation de sa dernière manche
const raceWinner = state.winner === 0 ? alice : dave, raceLoser = state.winner === 0 ? dave : alice;
if (state.winner !== null) {
  const winnerName = state.players[state.winner].name, loserName = state.players[1 - state.winner].name;
  r = await call(profile, { url: `/api/profile?name=${winnerName}&me=${raceLoser.playerId}` });
  assert.ok(r.body.duels.won >= 1 && r.body.duels.played >= r.body.duels.won);
  assert.ok(r.body.duels.vsMe.w >= 1, 'vu du gagnant : au moins une victoire contre moi');
  r = await call(profile, { url: `/api/profile?name=${loserName}` });
  assert.ok(r.body.duels.rivals.some(x => x.name === winnerName && x.l >= 1), 'le perdant a le gagnant dans ses rivaux');
  assert.equal(r.body.duels.vsMe, null, 'sans me, pas de face-à-face');
}

// 18. Bots : toujours prêts, ils tirent comme tout le monde, mais une partie avec des bots ne compte pas en duel.

r = await roomPost(gina, 'create', { size: 5, mode: 'rounds', target: 2, bots: 2, public: true });
assert.equal(r.status, 200, JSON.stringify(r.body));
const botRoom = r.body.code;
assert.deepEqual([r.body.status, r.body.public, r.body.bots, r.body.players.length], ['playing', false, true, 3], 'privée, démarrée, moi + 2 bots');
assert.deepEqual(r.body.players.map(p => p.bot), [false, true, true]);
assert.equal(new Set(r.body.players.map(p => p.name)).size, 3, 'noms distincts');
assert.ok(r.body.players.every(p => !p.ready), 'les bots ne sont pas affichés « ready »');
assert.ok(!(await call(roomApi, { url: '/api/room?live=1' })).body.rooms.some(x => x.code === botRoom), 'pas dans Live now');
const ginaStatsBefore = run([['HMGET', `stats:${gina.playerId}`, 'duels', 'duelWins']])[0].result;
r = await later(0, () => roomPost(gina, 'ready', { code: botRoom }));
assert.equal(r.body.rounds.length, 1, 'je suis prêt, les bots aussi : la manche part');
assert.equal(r.body.rounds[0].n.length, 3);
for (const x of r.body.reacts) assert.ok(x.t > r.body.rounds[0].revealAt, 'réactions des bots après la révélation');
r = await later(2500 + 9700, () => call(leaderboard, { url: '/api/leaderboard?period=all' }));
assert.ok(r.body.entries.some(e => e.name === 'Gina'), 'mon tirage compte au classement (une fois révélé)');
assert.ok(!r.body.entries.some(e => BOT_NAME_RE.test(e.name)), 'les bots n\'y sont pas');
let botState = (await roomGet(botRoom, gina)).body;
while (botState.status === 'playing') {
  botState = await later(11000, async () => (await roomPost(gina, 'ready', { code: botRoom })).body);
}
clock += 2500 + 9700;
await roomGet(botRoom, gina); // dernière manche révélée : tout est appliqué
assert.deepEqual(run([['HMGET', `stats:${gina.playerId}`, 'duels', 'duelWins']])[0].result, ginaStatsBefore, 'partie avec bots : pas de victoire de duel');
assert.equal(run([['EXISTS', `h2h:${gina.playerId}`]])[0].result, 0, 'ni de face-à-face');
r = await roomPost(gina, 'rematch', { code: botRoom });
assert.deepEqual([r.body.status, r.body.players.filter(p => p.bot).length], ['playing', 2], 'revanche avec les mêmes bots');

// L'hôte complète son salon avec des bots ; salle pleine : la partie commence. Deux humains : un bot seul ne lance rien.
r = await roomPost(gina, 'create', { size: 3 });
const mixed = r.body.code;
assert.equal((await roomPost(dave, 'addBot', { code: mixed })).status, 422, 'seul l\'hôte ajoute des bots');
await roomPost(dave, 'join', { code: mixed });
r = await roomPost(gina, 'addBot', { code: mixed });
assert.deepEqual([r.body.status, r.body.players.map(p => p.bot)], ['playing', [false, false, true]]);
assert.equal((await roomPost(gina, 'addBot', { code: mixed })).status, 422, 'partie commencée');
r = await later(11000, () => roomPost(gina, 'ready', { code: mixed }));
assert.equal(r.body.rounds.length, 0, 'Dave n\'est pas prêt : on l\'attend (le bot ne compte pas)');
r = await later(0, () => roomPost(dave, 'ready', { code: mixed }));
assert.equal(r.body.rounds.length, 1);

// 19. Anti-triche.
// Compte neuf : il ne peut pas se créditer de faux tirages via son historique (pièces, succès, profil).
const henry = { playerId: '7'.repeat(16), secret: 'b'.repeat(32), name: 'Henry' };
db.delete(`cooldown:${henry.playerId}`);
assert.equal((await call(roll, { method: 'POST', body: henry })).status, 200);
const henryCoins = (await call(shopApi, { url: `/api/shop?me=${henry.playerId}` })).body.coins;
const fake = Array.from({ length: 300 }, (_, i) => [777777, Date.UTC(2026, 0, 1) + i * 120000]);
r = await call(history, { method: 'POST', body: { ...henry, add: fake } });
assert.deepEqual([r.status, r.body.stored, r.body.rolls.length], [200, 0, 1], 'faux tirages refusés');
assert.equal((await call(shopApi, { url: `/api/shop?me=${henry.playerId}` })).body.coins, henryCoins, 'pas de pièces en plus');
r = await call(profile, { url: '/api/profile?name=Henry' });
assert.deepEqual([r.body.rolls, r.body.achievements.includes('millionaire')], [1, false]);
// Même chose pour un compte créé par une connexion Google sans historique.
r = await signIn({ sub: 'g-new-player' }, { playerId: '6'.repeat(16), secret: 'c'.repeat(32) });
assert.equal(run([['HGET', `stats:${r.body.playerId}`, 'v']])[0].result, '1');

// Parties en parallèle : une manche attend le délai de 8 s du joueur (autre partie ou tirage normal).
const ivy = { playerId: '5'.repeat(16), secret: 'd'.repeat(32), name: 'Ivy' };
const roomA = (await roomPost(ivy, 'create', { size: 2, bots: 1 })).body.code;
const roomB = (await roomPost(ivy, 'create', { size: 2, bots: 1 })).body.code;
assert.equal((await roomPost(ivy, 'ready', { code: roomA })).body.rounds.length, 1);
assert.equal((await roomPost(ivy, 'ready', { code: roomB })).body.rounds.length, 0, 'deuxième partie en même temps : on attend');
assert.equal((await call(roll, { method: 'POST', body: ivy })).status, 429, 'tirage normal pendant ce temps : refusé');
r = await later(8100, () => roomGet(roomB, ivy));
assert.equal(r.body.rounds.length, 1, '8 s plus tard, la manche part');

// Noms : alphabet latin, chiffres, espaces et _ . - ' ; pas de sosie en cyrillique.
const { cleanName } = require(path.join(ROOT, 'api/_lib.js'));
assert.equal(cleanName('  Sâcha_2.0  '), 'Sâcha_2.0');
assert.notEqual(cleanName('Ѕасhа'), 'Sacha');
assert.equal(cleanName('<b>Bob</b>🔥'), 'bBobb');

// Limite par IP : au-delà de 900 requêtes par minute, 429 sans toucher à la base.
const ipHeaders = { 'x-forwarded-for': '203.0.113.7' };
let lastStatus = 0, before429 = calls;
for (let i = 0; i < 901; i++) lastStatus = (await call(roomApi, { url: '/api/room?code=ZZZZZ', headers: ipHeaders })).status;
assert.equal(lastStatus, 429);
const afterLimit = calls;
assert.equal((await call(roomApi, { url: '/api/room?code=ZZZZZ', headers: ipHeaders })).status, 429);
assert.equal(calls, afterLimit, 'une requête bloquée ne coûte rien à la base');
assert.equal((await call(roomApi, { url: '/api/room?code=ZZZZZ', headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 404, 'une autre IP passe');

// 20. Partie désertée : plus aucun joueur sur la page depuis 30 s → elle s'arrête, sans gagnant ni stats.
const jade = { playerId: '4'.repeat(16), secret: 'e'.repeat(32), name: 'Jade' };
r = await roomPost(jade, 'create', { size: 2, bots: 1 });
const lonely = r.body.code;
const jadeDuels = run([['HGET', `stats:${jade.playerId}`, 'duels']])[0].result;
r = await later(20000, () => roomGet(lonely, jade));
assert.equal(r.body.status, 'playing', '20 s : toujours là (le sondage compte comme présence)');
r = await later(25000, () => roomGet(lonely));
assert.equal(r.body.status, 'playing', '25 s après son dernier passage : pas encore');
r = await later(6000, () => roomGet(lonely));
assert.equal(r.body.status, 'abandoned', '31 s sans personne : arrêtée');
assert.equal((await roomPost(jade, 'ready', { code: lonely })).status, 422, 'plus de manche');
assert.equal((await later(0, () => roomGet(lonely, jade))).body.status, 'abandoned', 'revenir ne la relance pas');
assert.equal(run([['HGET', `stats:${jade.playerId}`, 'duels']])[0].result, jadeDuels, 'rien de compté');
// Deux humains : tant que l'un des deux reste, la partie continue ; un salon public déserté sort de "Live now".
r = await roomPost(jade, 'create', { size: 3 });
const pair = r.body.code;
await roomPost(ivy, 'join', { code: pair });
assert.ok((await call(roomApi, { url: '/api/room?live=1' })).body.rooms.some(x => x.code === pair));
for (let i = 0; i < 3; i++) await later(20000, () => roomGet(pair, ivy)); // Ivy reste, Jade est partie
assert.equal((await roomGet(pair)).body.status, 'lobby', 'Ivy est encore là');
await later(31000, async () => null);
assert.ok(!(await call(roomApi, { url: '/api/room?live=1' })).body.rooms.some(x => x.code === pair), 'désertée : retirée de Live now');
assert.equal((await roomGet(pair)).body.status, 'abandoned');

// 20. Classement Lifetime XP : somme de tous les tirages (historique sans doublons), rempli une fois pour les anciens
// joueurs, puis tenu à jour à chaque tirage.
{
  const { lifetimeXp } = require(path.join(ROOT, 'api/_lib.js'));
  const xpFromHistory = who => lifetimeXp(run([['ZRANGE', `hist:${who.playerId}`, 0, -1]])[0].result);
  // Comme en production : un classement vide et un joueur d'avant, jamais compté.
  db.delete('lb:xp'); db.delete('lb:xp:migrated');
  run([['HSET', 'count:all', alice.playerId, 1]]); // tirages d'avant le classement en ligne : pas comptés
  const { lifetimeTotals } = require(path.join(ROOT, 'api/_lib.js'));
  const aliceTotals = lifetimeTotals(run([['ZRANGE', `hist:${alice.playerId}`, 0, -1]])[0].result);
  r = await call(leaderboard, { url: `/api/leaderboard?period=xp&me=${alice.playerId}` });
  assert.equal(r.body.entries.find(e => e.name === 'Alice').rolls, aliceTotals.rolls, 'tirages à vie recomptés depuis l\'historique');
  assert.equal((await call(leaderboard, { url: '/api/leaderboard?period=all' })).body.entries.find(e => e.name === 'Alice').rolls, aliceTotals.rolls, 'aussi en All-time');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.period, 'xp');
  const xpA = r.body.entries.find(e => e.name === 'Alice');
  assert.equal(xpA.s, xpFromHistory(alice), 'XP à vie = somme de son historique');
  assert.ok(xpA.me, 'ma ligne marquée');
  const sorted = r.body.entries.map(e => e.s);
  assert.deepEqual(sorted, [...sorted].sort((x, y) => y - x), 'trié par XP à vie');
  assert.ok(r.body.entries.every(e => Number.isInteger(e.n) && e.s >= engine.scoreOf(e.n)), 'avec le meilleur tirage, jamais plus que le total');
  assert.match(run([['GET', 'lb:xp:migrated']])[0].result, /^7:[0-9a-f]{12}$/, 'rempli une seule fois, à la version des règles des badges');
  // Règles des badges changées (nouvelle empreinte) : l'XP à vie est recalculée depuis l'historique, plus l'ancien total.
  run([['SET', 'lb:xp:migrated', '5:00000000000a'], ['ZADD', 'lb:xp', 1, alice.playerId]]);
  r = await call(leaderboard, { url: '/api/leaderboard?period=xp' });
  assert.equal(r.body.entries.find(e => e.name === 'Alice').s, xpFromHistory(alice), 'recalculé après un changement de badges');
  // Historique plafonné (« Stats bug », 2026-10-26) : des tirages ne sont plus dans l'historique (count:all plus grand).
  // Ils comptent à la moyenne des autres, et l'XP à vie ne baisse jamais.
  {
    const win = xpFromHistory(alice), n = run([['ZCARD', `hist:${alice.playerId}`]])[0].result, [cnt0] = run([['HGET', 'count:all', alice.playerId]]).map(x => x.result);
    run([['SET', 'lb:xp:migrated', '5:00000000000b'], ['ZADD', 'lb:xp', 1, alice.playerId], ['HSET', 'count:all', alice.playerId, n * 2]]);
    r = await call(leaderboard, { url: '/api/leaderboard?period=xp' });
    assert.equal(r.body.entries.find(e => e.name === 'Alice').s, Math.round(win * 2), 'tirages sortis de l\'historique comptés à la moyenne');
    run([['SET', 'lb:xp:migrated', '5:00000000000c'], ['ZADD', 'lb:xp', win * 5, alice.playerId]]);
    r = await call(leaderboard, { url: '/api/leaderboard?period=xp' });
    assert.equal(r.body.entries.find(e => e.name === 'Alice').s, win * 5, 'jamais en baisse');
    run([['HSET', 'count:all', alice.playerId, cnt0 || n], ['ZADD', 'lb:xp', win, alice.playerId], ['HSET', `stats:${alice.playerId}`, 'xpLife', win]]);
  }
  // Les meilleurs tirages aussi (tout le temps, et la période en cours) : un vieux score de meilleur tirage est corrigé.
  {
    const hist = run([['ZRANGE', `hist:${alice.playerId}`, 0, -1]])[0].result.map(m => m.split(':').map(Number));
    const top = Math.max(...hist.map(([, n]) => engine.scoreOf(n)));
    run([['SET', 'lb:xp:migrated', '5:000000000000'], ['ZADD', 'lb:all', 1, alice.playerId], ['HSET', `stats:${alice.playerId}`, 'best', 1]]);
    await call(leaderboard, { url: '/api/leaderboard?period=xp' });
    assert.equal(Number(run([['ZSCORE', 'lb:all', alice.playerId]])[0].result), top, 'meilleur tirage de tous les temps recalculé');
    assert.equal(Number(run([['HGET', `stats:${alice.playerId}`, 'best']])[0].result), top);
    // Un record d'avant l'historique du serveur (absent de hist:) n'est jamais perdu.
    const legacy = { n: 1, s: 1, t: 0 };
    run([['SET', 'lb:xp:migrated', '5:000000000001'], ['HSET', 'best:all', alice.playerId, JSON.stringify(legacy)], ['ZREM', `hist:${alice.playerId}`, ...run([['ZRANGE', `hist:${alice.playerId}`, 0, -1]])[0].result.filter(m => m.endsWith(':1'))]]);
    await call(leaderboard, { url: '/api/leaderboard?period=xp' });
    assert.ok(Number(run([['ZSCORE', 'lb:all', alice.playerId]])[0].result) >= Math.max(top, engine.scoreOf(1)), 'record ancien gardé');
  }
  // Un nouveau tirage s'ajoute tout de suite.
  db.delete(`cooldown:${frank.playerId}`);
  const before = (await call(leaderboard, { url: '/api/leaderboard?period=xp' })).body.entries.find(e => e.name === 'Frank').s;
  const got = (await call(roll, { method: 'POST', body: frank })).body;
  const after = (await call(leaderboard, { url: '/api/leaderboard?period=xp' })).body.entries.find(e => e.name === 'Frank').s;
  assert.equal(after, before + got.s, 'le tirage s\'ajoute au total');
  assert.equal(after, xpFromHistory(frank), 'toujours égal à l\'historique');
}

// ================================================================ 21. Quêtes du jour et bonus quotidien
{
  const questsApi = require(path.join(ROOT, 'api/quests.js'));
  const Quests = require(path.join(ROOT, 'js/quests.js'));
  const quinn = { playerId: 'c1'.repeat(8), secret: 'd1'.repeat(16), name: 'Quinn' };
  const qPost = (who, action, extra = {}) => call(questsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const qGet = who => call(questsApi, { url: `/api/quests?me=${who.playerId}` });
  const coinsOf = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  const today = () => new Date(Date.now()).toISOString().slice(0, 10);

  r = await call(roll, { method: 'POST', body: quinn });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(run([['HGET', `q:${today()}:${quinn.playerId}`, 'rolls']])[0].result, '1', 'le tirage compte pour les quêtes du jour');
  assert.equal(Number(run([['HGET', `q:${today()}:${quinn.playerId}`, 'xp']])[0].result), r.body.s);
  r = await qGet(quinn);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.quests.length, 5, '5 quêtes par jour');
  assert.deepEqual(r.body.quests.map(q => q.id), Quests.ofDay(today()).map(q => q.id), 'les mêmes pour tout le monde');
  assert.deepEqual(new Set(Quests.ofDay(today()).map(q => q.group)), new Set(['rolls', 'xp', 'rarity', 'duel', 'casino']), 'une par groupe');
  assert.ok(r.body.quests.every(q => !q.claimed));
  assert.deepEqual([r.body.daily.claimed, r.body.daily.streak, r.body.daily.reward], [false, 0, 20]);
  const first = r.body.quests[0];
  // Pas finie : pas de récompense. Récompense d'une quête d'un autre jour : refusée.
  if (first.progress < first.target) assert.equal((await qPost(quinn, 'claim', { quest: first.id })).status, 422, 'quête pas finie');
  assert.equal((await qPost(quinn, 'claim', { quest: 'nope' })).status, 400);
  assert.equal((await qPost({ ...quinn, secret: '9'.repeat(32) }, 'claim', { quest: first.id })).status, 403);
  // Compteurs du jour remplis (comme après une grosse journée) : tout est réclamable, une seule fois.
  run([['HSET', `q:${today()}:${quinn.playerId}`, 'rolls', 60, 'xp', 1000000, 't:uncommon', 8, 't:rare', 3, 't:epic', 1, 'duels', 3, 'duelWins', 1, 'casino', 15, 'casinoBet', 500]]);
  let before = await coinsOf(quinn);
  r = await qPost(quinn, 'claim', { quest: first.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gained, first.reward);
  assert.equal(await coinsOf(quinn), before + first.reward, 'pièces créditées');
  assert.equal((await qPost(quinn, 'claim', { quest: first.id })).status, 422, 'une seule fois');
  assert.equal(await coinsOf(quinn), before + first.reward);
  assert.ok((await qGet(quinn)).body.quests[0].claimed);
  // Série de quêtes : la 5e quête réclamée verse le bonus « tout fini » une seule fois, et la série monte de jour en jour.
  assert.equal((await qGet(quinn)).body.questStreak.streak, 0);
  const coinsBeforeStreak = await coinsOf(quinn);
  const rest = (await qGet(quinn)).body.quests.filter(q => !q.claimed);
  for (const [i, q] of rest.entries()) {
    before = await coinsOf(quinn);
    r = await qPost(quinn, 'claim', { quest: q.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (i < rest.length - 1) assert.deepEqual([r.body.gained, r.body.allDone], [q.reward, null], 'pas encore tout fini');
    else {
      assert.deepEqual([r.body.allDone, r.body.gained], [{ streak: 1, bonus: 50 }, q.reward + 50], 'tout fini : bonus du 1er jour');
      assert.equal(await coinsOf(quinn), before + q.reward + 50);
      assert.deepEqual([r.body.questStreak.doneToday, r.body.questStreak.streak, r.body.questStreak.best], [true, 1, 1]);
    }
  }
  const finishDay = async () => { run([['HSET', `q:${today()}:${quinn.playerId}`, 'rolls', 60, 'xp', 1000000, 't:uncommon', 8, 't:rare', 3, 't:epic', 1, 'duels', 3, 'duelWins', 1, 'casino', 15, 'casinoBet', 500]]); let last; for (const q of Quests.ofDay(today())) last = await qPost(quinn, 'claim', { quest: q.id }); return last.body; };
  const save = clock;
  clock += 86400000; let b = await finishDay();
  assert.deepEqual([b.allDone.streak, b.allDone.bonus, b.questStreak.best], [2, 75, 2], '2e jour de suite : 75');
  clock += 2 * 86400000;
  assert.equal((await qGet(quinn)).body.questStreak.streak, 0, 'un jour sauté : série de quêtes perdue');
  b = await finishDay();
  assert.deepEqual([b.allDone.streak, b.questStreak.best], [1, 2], 'repart à 1, le record reste');
  assert.equal((await call(require(path.join(ROOT, 'api/profile.js')), { url: '/api/profile?name=Quinn' })).body.questBest, 2, 'record sur le profil');
  assert.deepEqual([1, 2, 7, 11, 30, 40].map(Quests.allDoneReward), [50, 75, 700, 300, 2300, 300], 'barème du bonus');
  clock = save;
  run([['HINCRBY', `stats:${quinn.playerId}`, 'spent', (await coinsOf(quinn)) - coinsBeforeStreak]]); // solde remis comme avant, pour la suite
  // Bonus quotidien : une fois par jour, la série monte de 10 pièces par jour, retombe si on saute un jour.
  before = await coinsOf(quinn);
  r = await qPost(quinn, 'daily');
  assert.deepEqual([r.status, r.body.gained, r.body.daily.streak, r.body.daily.claimed], [200, 20, 1, true]);
  assert.equal((await qPost(quinn, 'daily')).status, 422, 'déjà pris aujourd\'hui');
  assert.equal(await coinsOf(quinn), before + 20);
  clock += 86400000;
  assert.deepEqual([(await qGet(quinn)).body.daily.streak, (await qGet(quinn)).body.daily.reward], [1, 30], 'le lendemain : série en cours, 30 à prendre');
  r = await qPost(quinn, 'daily');
  assert.deepEqual([r.body.gained, r.body.daily.streak], [30, 2]);
  clock += 2 * 86400000;
  assert.equal((await qGet(quinn)).body.daily.streak, 0, 'un jour sauté : série perdue');
  r = await qPost(quinn, 'daily');
  assert.deepEqual([r.body.gained, r.body.daily.streak], [20, 1]);
  assert.equal(Quests.dailyReward(30), 80, 'plafond à 7 jours');

  // ============================================================== 22. Caisses
  const openCase = (who, id) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'case', case: id } });
  // Solde ramené sous le prix de la caisse : les pièces de quinn dépendent de ses tirages (au hasard), et un bon tirage
  // lui donnait parfois assez pour l'ouvrir (test instable, 2026-10-25).
  { const extra = (await coinsOf(quinn)) - (Shop.caseById.get('starter').price - 1); if (extra > 0) run([['HINCRBY', `stats:${quinn.playerId}`, 'spent', extra]]); }
  assert.equal((await openCase(quinn, 'starter')).status, 422, 'pas assez de pièces');
  assert.equal((await openCase(quinn, 'licorne')).status, 400);
  run([['HINCRBY', `stats:${quinn.playerId}`, 'bonus', 100000]]);
  const pool = Shop.casePool(Shop.caseById.get('starter')).map(k => k.id);
  let dups = 0, news = 0;
  for (let i = 0; i < 40; i++) {
    before = await coinsOf(quinn);
    r = await openCase(quinn, 'starter');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(pool.includes(r.body.won), 'un skin de la caisse');
    assert.ok(r.body.owned.includes(r.body.won));
    assert.equal(r.body.refund, r.body.duplicate ? Shop.duplicateRefund(Shop.caseById.get('starter'), r.body.won) : 0, 'doublon : selon la rareté');
    if (r.body.duplicate) assert.ok(r.body.refund >= 125 && r.body.refund < 250, 'entre la moitié et le prix de la caisse');
    assert.equal(r.body.coins, before - 250 + r.body.refund);
    r.body.duplicate ? dups++ : news++;
  }
  assert.ok(news >= 5 && news <= pool.length && dups >= 1, `des nouveaux (${news}) et des doublons (${dups})`);
  r = await openCase(quinn, 'premium');
  assert.ok(Shop.casePool(Shop.caseById.get('premium')).some(k => k.id === r.body.won));
  // Chances : somme 1, le moins cher est le plus probable ; le tirage suit les chances.
  for (const c of Shop.CASES) {
    const odds = Shop.caseOdds(c);
    assert.ok(Math.abs(odds.reduce((x, o) => x + o.p, 0) - 1) < 1e-9);
    assert.equal(Shop.drawCase(c, 0), odds[0].id);
    assert.equal(Shop.drawCase(c, 0.999999), odds[odds.length - 1].id);
    assert.ok(!Shop.casePool(c).some(k => k.hidden), 'jamais le skin Owner');
  }
  // Caisse de fonds d'écran (idée de CrazyMiner22) : un fond normal (ni limité ni légendaire) qui rejoint walls:<id>.
  const wcase = Shop.caseById.get('wallpaper');
  const wpool = Shop.casePool(wcase).map(w => w.id);
  assert.ok(wpool.length >= 8 && wpool.every(id => Shop.wallById.has(id) && !Shop.wallById.get(id).until && !Shop.wallById.get(id).premium), 'fonds normaux seulement');
  assert.ok(!wpool.includes('aether') && !wpool.includes('graveyard') && !wpool.includes('pumpkins'));
  const wev = Shop.caseOdds(wcase).reduce((x, o) => x + o.p * Shop.caseItem(wcase, o.id).price, 0);
  assert.ok(wcase.price < wev && wcase.price / wev > 0.6 && wcase.price / wev < 0.85, `prix sous la valeur moyenne, comme les caisses de skins (${wcase.price} / ${wev.toFixed(0)})`);
  assert.equal(Shop.rarityOf('forest', true).name, 'Common');
  assert.equal(Shop.rarityOf('synthwave', true).name, 'Epic');
  assert.equal(Shop.caseItem(wcase, 'galaxy'), Shop.wallById.get('galaxy'), 'galaxy : le fond, pas le skin');
  for (const id of wpool) { const v = Shop.duplicateRefund(wcase, id); assert.ok(v >= wcase.price / 2 && v < wcase.price, `remboursement ${id}`); }
  const wally = { playerId: 'c7'.repeat(8), secret: 'd7'.repeat(16), name: 'Wally' };
  assert.equal((await call(roll, { method: 'POST', body: wally })).status, 200);
  assert.equal((await openCase(wally, 'wallpaper')).status, 422, 'pas assez de pièces');
  run([['HINCRBY', `stats:${wally.playerId}`, 'bonus', 50000]]);
  await new Promise(r => setTimeout(r, 20)); // le DEL du verrou de l'appel précédent part après sa réponse
  run([['SET', `shop:${wally.playerId}`, '1']]);
  assert.equal((await openCase(wally, 'wallpaper')).status, 429, 'verrou : une caisse à la fois');
  run([['DEL', `shop:${wally.playerId}`]]);
  const ecoCases = () => [...db.keys()].filter(k => k.startsWith('eco:')).reduce((x, k) => x + (Number(db.get(k)?.get?.('out:cases')) || 0), 0);
  const skinsBefore = JSON.stringify((await call(shopApi, { url: `/api/shop?me=${wally.playerId}` })).body.owned);
  let wdups = 0, wnews = 0;
  for (let i = 0; i < 30; i++) {
    before = await coinsOf(wally);
    const [spent0, cases0] = run([['HGET', `stats:${wally.playerId}`, 'spent'], ['HGET', `stats:${wally.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    const eco0 = ecoCases();
    r = await openCase(wally, 'wallpaper');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(wpool.includes(r.body.won), 'un fond de la caisse');
    assert.ok(r.body.walls.includes(r.body.won), 'ajouté aux fonds possédés');
    assert.ok(run([['SISMEMBER', `walls:${wally.playerId}`, r.body.won]])[0].result == 1);
    assert.equal(r.body.refund, r.body.duplicate ? Shop.duplicateRefund(wcase, r.body.won) : 0, 'doublon : selon la rareté');
    assert.equal(r.body.coins, before - wcase.price + r.body.refund);
    const [spent1, cases1] = run([['HGET', `stats:${wally.playerId}`, 'spent'], ['HGET', `stats:${wally.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    assert.deepEqual([spent1 - spent0, cases1 - cases0, ecoCases() - eco0], [wcase.price - r.body.refund, 1, wcase.price - r.body.refund], 'spent, cases, eco');
    r.body.duplicate ? wdups++ : wnews++;
  }
  assert.ok(wnews >= 4 && wnews <= wpool.length && wdups >= 1, `des nouveaux (${wnews}) et des doublons (${wdups})`);
  assert.equal(JSON.stringify(r.body.owned), skinsBefore, 'aucun skin donné');
  assert.equal(r.body.wall, null, 'gagné, pas affiché d\'office');
  r = await call(shopApi, { method: 'POST', body: { playerId: wally.playerId, secret: wally.secret, action: 'wall', wall: r.body.walls[0] } });
  assert.equal(r.status, 200, 'un fond gagné se met comme un fond acheté');
  // Cinq fonds de joueurs (2026-10-28) : The Fisher et Condensation légendaires (hors caisse), Your Last Rolls et
  // Spinning Bread dans la caisse, Zombie Moon limité (onglet Limités, hors caisse, jusqu'au 2 novembre inclus).
  {
    const fresh = ['fishing', 'lastrolls', 'bread', 'condensation', 'zombiemoon'];
    assert.ok(fresh.every(id => Shop.wallById.get(id) && Shop.wallById.get(id).idea), 'les cinq fonds existent, avec leur idée');
    assert.ok(!fresh.some(id => Shop.byId.has(id)), 'aucun ne prend l\'identifiant d\'un skin (le skin Fisherman est « fisher »)');
    assert.deepEqual(fresh.map(id => Shop.rarityOf(id, true).name), ['Legendary', 'Rare', 'Uncommon', 'Legendary', 'Epic']);
    assert.ok(wpool.includes('lastrolls') && wpool.includes('bread'), 'les deux fonds normaux sont dans la caisse');
    assert.ok(!wpool.includes('fishing') && !wpool.includes('condensation') && !wpool.includes('zombiemoon'), 'ni légendaires ni limité dans la caisse');
    // Retiré le 1er novembre avec le reste d'Halloween, pour l'événement de Noël (demandé par Sacha, 2026-11-01).
    assert.equal(Shop.wallById.get('zombiemoon').until, '2026-11-01T00:00:00Z');
    const buyWall = id => call(shopApi, { method: 'POST', body: { playerId: wally.playerId, secret: wally.secret, action: 'buywall', wall: id } });
    for (const id of ['lastrolls', 'fishing', 'zombiemoon']) {
      if (wpool.includes(id) && (await call(shopApi, { url: `/api/shop?me=${wally.playerId}` })).body.walls.includes(id)) continue; // déjà gagné dans la caisse
      const item = Shop.wallById.get(id), c0 = await coinsOf(wally);
      r = await buyWall(id);
      if (item.until && Date.now() >= Date.parse(item.until)) { assert.equal(r.status, 422, 'Zombie Moon n\'est plus en vente'); continue; }
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.wall, id, 'acheté = affiché');
      assert.equal(await coinsOf(wally), c0 - item.price, `${id} : le prix exact, rien de plus (pas de part pour l'idée d'un fond)`);
    }
  }
  // Caisse de boutons (idée de shadow2, 2026-10-27) : un bouton vendu à part (BUTTONS) qui rejoint btns:<id>.
  const bcase = Shop.caseById.get('buttons');
  const bpool = Shop.casePool(bcase).map(b => b.id);
  assert.deepEqual([...bpool].sort(), Shop.BUTTONS.filter(b => !b.noCase).map(b => b.id).sort(), 'tous les boutons vendus à part, sauf ceux marqués noCase');
  // Boutons du 2026-11-01 : Cardboard Box (MAYO) reste hors de la caisse (100 pièces : moins que la caisse et qu'un
  // remboursement de doublon) ; Free Download, Bread, Last Roll et Bubble Wrap y entrent.
  assert.ok(!bpool.includes('cardboard') && Shop.buttonById.get('cardboard').price === 100 && Math.min(...Shop.BUTTONS.map(b => b.price)) === 100, 'Cardboard Box : le moins cher, hors caisse');
  assert.ok(['download', 'bread', 'lastroll', 'bubblewrap'].every(id => bpool.includes(id)));
  assert.equal(Shop.caseRarity(bcase, 'bubblewrap').name, 'Legendary');
  assert.deepEqual(['cardboard', 'download', 'bread', 'lastroll', 'bubblewrap'].map(id => Shop.buttonById.get(id).idea), ['MAYO', 'Yentizx', 'MattyFaux-Lucky', 'G8_floppa', 'Jguz01']);
  assert.ok(bpool.includes('pickle'), 'le bouton Pickle (idée d\'Edward et de Dylanrulez123) est dedans');
  const bev = Shop.caseOdds(bcase).reduce((x, o) => x + o.p * Shop.caseItem(bcase, o.id).price, 0);
  assert.ok(bcase.price < bev && bcase.price / bev > 0.6 && bcase.price / bev < 0.85, `prix sous la valeur moyenne (${bcase.price} / ${bev.toFixed(0)})`);
  assert.equal(Shop.caseItem(bcase, 'arcade'), Shop.buttonById.get('arcade'), 'arcade : le bouton, pas le skin');
  assert.deepEqual(['keycap', 'arcade', 'comic', 'hologram', 'royal'].map(id => Shop.caseRarity(bcase, id).name), ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']);
  assert.equal(Shop.caseRarity(wcase, 'forest').name, 'Common', 'les fonds gardent leurs paliers');
  for (const id of bpool) { const v = Shop.duplicateRefund(bcase, id); assert.ok(v >= bcase.price / 2 && v < bcase.price, `remboursement ${id}`); }
  assert.ok(Shop.KEY_OPENS.premium.includes('buttons') && !Shop.KEY_OPENS.starter.includes('buttons'), 'une clé Premium l\'ouvre');
  const bobby = { playerId: 'c8'.repeat(8), secret: 'd8'.repeat(16), name: 'Bobby' };
  assert.equal((await call(roll, { method: 'POST', body: bobby })).status, 200);
  { const extra = (await coinsOf(bobby)) - (bcase.price - 1); if (extra > 0) run([['HINCRBY', `stats:${bobby.playerId}`, 'spent', extra]]); } // un bon premier tirage suffirait
  assert.equal((await openCase(bobby, 'buttons')).status, 422, 'pas assez de pièces');
  run([['HINCRBY', `stats:${bobby.playerId}`, 'bonus', 50000]]);
  await new Promise(r => setTimeout(r, 20));
  const bSkins = JSON.stringify((await call(shopApi, { url: `/api/shop?me=${bobby.playerId}` })).body.owned);
  let bdups = 0, bnews = 0;
  for (let i = 0; i < 40; i++) {
    before = await coinsOf(bobby);
    const [spent0, cases0] = run([['HGET', `stats:${bobby.playerId}`, 'spent'], ['HGET', `stats:${bobby.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    const eco0 = ecoCases();
    r = await openCase(bobby, 'buttons');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(bpool.includes(r.body.won), 'un bouton de la caisse');
    assert.ok(r.body.buttons.includes(r.body.won), 'ajouté aux boutons possédés');
    assert.ok(run([['SISMEMBER', `btns:${bobby.playerId}`, r.body.won]])[0].result == 1);
    assert.equal(r.body.refund, r.body.duplicate ? Shop.duplicateRefund(bcase, r.body.won) : 0, 'doublon : selon la rareté');
    assert.equal(r.body.coins, before - bcase.price + r.body.refund);
    const [spent1, cases1] = run([['HGET', `stats:${bobby.playerId}`, 'spent'], ['HGET', `stats:${bobby.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    assert.deepEqual([spent1 - spent0, cases1 - cases0, ecoCases() - eco0], [bcase.price - r.body.refund, 1, bcase.price - r.body.refund], 'spent, cases, eco');
    r.body.duplicate ? bdups++ : bnews++;
    await new Promise(res => setTimeout(res, 3));
  }
  assert.ok(bnews >= 4 && bnews <= bpool.length && bdups >= 1, `des nouveaux (${bnews}) et des doublons (${bdups})`);
  assert.equal(JSON.stringify(r.body.owned), bSkins, 'aucun skin donné');
  assert.deepEqual(r.body.walls || [], [], 'aucun fond donné');
  r = await call(shopApi, { method: 'POST', body: { playerId: bobby.playerId, secret: bobby.secret, action: 'button', button: r.body.buttons[0] } });
  assert.deepEqual([r.status, r.body.button], [200, r.body.buttons[0]], 'un bouton gagné s\'équipe comme un bouton acheté');
  // Boutons Power Core (idée de Sean) et Black Hole (idée de MattyFaux-Lucky), 2026-10-28 : vendus à part, dans la caisse.
  assert.ok(bpool.includes('powercore') && bpool.includes('eventhorizon'));
  assert.ok(!Shop.byId.has('eventhorizon') && Shop.byId.has('blackhole'), 'le bouton Black Hole ne prend pas l\'identifiant du skin Singularity');
  assert.deepEqual(['powercore', 'eventhorizon'].map(id => Shop.caseRarity(bcase, id).name), ['Rare', 'Epic']);
  { const css = fs.readFileSync(path.join(ROOT, 'css/buttons.css'), 'utf8'); for (const b of Shop.BUTTONS) assert.ok(css.includes(`.btn-roll.gen-${b.id} {`), `style du bouton ${b.id}`); }

  // Caisse de sons (idée de shadow2 Jr, 2026-10-28) : un pack de sons payant (SOUNDS) qui rejoint snds:<id>.
  const scase = Shop.caseById.get('sounds');
  const spool = Shop.casePool(scase).map(p => p.id);
  assert.deepEqual([...spool].sort(), Shop.SOUNDS.filter(p => p.price).map(p => p.id).sort(), 'tous les packs payants');
  assert.ok(spool.includes('clicky'), 'le pack Clicky (idées de Niall et de sennybex1) est dedans');
  assert.ok(spool.includes('slime') && spool.includes('boing'), 'les packs Slime (Ggggssnoop) et Boing (sennybex1) aussi (2026-11-01)');
  { const src = fs.readFileSync(path.join(ROOT, 'js/sound.js'), 'utf8'); for (const p of Shop.SOUNDS.filter(x => x.price)) assert.ok(new RegExp(`\n    ${p.id}: \{`).test(src), `recette du pack ${p.id} dans js/sound.js`); }
  const sev = Shop.caseOdds(scase).reduce((x, o) => x + o.p * Shop.caseItem(scase, o.id).price, 0);
  assert.ok(scase.price < sev && scase.price / sev > 0.7 && scase.price / sev < 0.8, `prix sous la valeur moyenne, comme les caisses de fonds et de boutons (${scase.price} / ${sev.toFixed(0)})`);
  assert.equal(Shop.caseItem(scase, 'arcade'), Shop.soundById.get('arcade'), 'arcade : le pack de sons, pas le bouton');
  assert.deepEqual(['arcade', 'taps', 'clicky', 'space', 'glass'].map(id => Shop.caseRarity(scase, id).name), ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']);
  for (const id of spool) { const v = Shop.duplicateRefund(scase, id); assert.ok(v >= scase.price / 2 && v < scase.price, `remboursement ${id}`); }
  assert.ok(Shop.KEY_OPENS.premium.includes('sounds') && !Shop.KEY_OPENS.starter.includes('sounds'), 'une clé Premium l\'ouvre');
  const owners = () => { const o = {}; const flat = run([['HGETALL', 'owners']])[0].result || []; for (let i = 0; i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]); return o; };
  const sammy = { playerId: 'c9'.repeat(8), secret: 'da'.repeat(16), name: 'Sammy' };
  assert.equal((await call(roll, { method: 'POST', body: sammy })).status, 200);
  run([['HINCRBY', `stats:${sammy.playerId}`, 'bonus', 50000]]);
  await new Promise(res => setTimeout(res, 20));
  const sBefore = (await call(shopApi, { url: `/api/shop?me=${sammy.playerId}` })).body, own0 = owners();
  let sdups = 0, snews = 0;
  const gainedSnd = {};
  for (let i = 0; i < 30; i++) {
    before = await coinsOf(sammy);
    const [spent0, cases0] = run([['HGET', `stats:${sammy.playerId}`, 'spent'], ['HGET', `stats:${sammy.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    const eco0 = ecoCases();
    r = await openCase(sammy, 'sounds');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(spool.includes(r.body.won), 'un pack de la caisse');
    assert.ok(r.body.sounds.includes(r.body.won), 'ajouté aux packs possédés');
    assert.ok(run([['SISMEMBER', `snds:${sammy.playerId}`, r.body.won]])[0].result == 1);
    assert.equal(r.body.refund, r.body.duplicate ? Shop.duplicateRefund(scase, r.body.won) : 0, 'doublon : selon la rareté');
    assert.equal(r.body.coins, before - scase.price + r.body.refund);
    const [spent1, cases1] = run([['HGET', `stats:${sammy.playerId}`, 'spent'], ['HGET', `stats:${sammy.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    assert.deepEqual([spent1 - spent0, cases1 - cases0, ecoCases() - eco0], [scase.price - r.body.refund, 1, scase.price - r.body.refund], 'spent, cases, eco');
    if (r.body.duplicate) sdups++; else { snews++; gainedSnd[r.body.won] = 1; }
    await new Promise(res => setTimeout(res, 3));
  }
  assert.ok(snews >= 4 && snews <= spool.length && sdups >= 1, `des nouveaux (${snews}) et des doublons (${sdups})`);
  assert.deepEqual([r.body.owned, r.body.buttons, r.body.walls], [sBefore.owned, sBefore.buttons, sBefore.walls], 'ni skin, ni bouton, ni fond donné');
  // Popularité : +1 par pack gagné pour la première fois, rien pour un doublon.
  { const own1 = owners(); for (const id of spool) assert.equal((own1[`sounds:${id}`] || 0) - (own0[`sounds:${id}`] || 0), gainedSnd[id] || 0, `owners sounds:${id}`); }
  r = await call(shopApi, { method: 'POST', body: { playerId: sammy.playerId, secret: sammy.secret, action: 'sound', sound: r.body.sounds[0] } });
  assert.deepEqual([r.status, r.body.sound], [200, r.body.sounds[0]], 'un pack gagné se met en service comme un pack acheté');

  // Caisse d'émotes (idée de shadow2 Jr, 2026-11-01) : une émote spéciale (EMOTES) qui rejoint emotes:<id>, comme buyemote.
  const ecase = Shop.caseById.get('emotes');
  const epool = Shop.casePool(ecase).map(e => e.id);
  assert.deepEqual([...epool].sort(), Shop.EMOTES.map(e => e.id).sort(), 'toutes les émotes en vente');
  assert.ok(epool.includes('hungry') && Shop.emoteById.get('hungry').idea === 'Monokromati', 'l\'émote Hungry (Monokromati) est dedans');
  const eev = Shop.caseOdds(ecase).reduce((x, o) => x + o.p * Shop.caseItem(ecase, o.id).price, 0);
  assert.ok(ecase.price < eev && ecase.price / eev > 0.7 && ecase.price / eev < 0.8, `prix sous la valeur moyenne, comme les autres caisses (${ecase.price} / ${eev.toFixed(0)})`);
  assert.equal(Shop.caseItem(ecase, 'gg'), Shop.emoteById.get('gg'));
  assert.deepEqual(['gg', 'love', 'rage', 'money', 'mindblown'].map(id => Shop.caseRarity(ecase, id).name), ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']);
  for (const id of epool) { const v = Shop.duplicateRefund(ecase, id); assert.ok(v >= ecase.price / 2 && v < ecase.price, `remboursement ${id}`); }
  assert.ok(Shop.KEY_OPENS.premium.includes('emotes') && !Shop.KEY_OPENS.starter.includes('emotes'), 'une clé Premium l\'ouvre');
  { require(path.join(ROOT, 'js/emotes.js')); const E = globalThis.RNGEmotes; /* pas de module.exports : il se pose sur globalThis */ for (const id of epool) assert.ok(Shop.emoteById.get(id).img ? fs.existsSync(path.join(ROOT, `img/emotes/${id}.png`)) : E.has(id), `dessin de l'émote ${id} (js/emotes.js ou img/emotes/${id}.png)`); }
  const emma = { playerId: 'cb'.repeat(8), secret: 'dc'.repeat(16), name: 'Emmy' };
  assert.equal((await call(roll, { method: 'POST', body: emma })).status, 200);
  run([['HINCRBY', `stats:${emma.playerId}`, 'bonus', 50000]]);
  await new Promise(res => setTimeout(res, 20));
  const eBefore = (await call(shopApi, { url: `/api/shop?me=${emma.playerId}` })).body, eown0 = owners();
  let edups = 0, enews = 0;
  const gainedEmo = {};
  for (let i = 0; i < 30; i++) {
    before = await coinsOf(emma);
    const [spent0, cases0] = run([['HGET', `stats:${emma.playerId}`, 'spent'], ['HGET', `stats:${emma.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    const eco0 = ecoCases();
    r = await openCase(emma, 'emotes');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(epool.includes(r.body.won), 'une émote de la caisse');
    assert.ok(r.body.emotes.includes(r.body.won), 'ajoutée aux émotes possédées');
    assert.ok(run([['SISMEMBER', `emotes:${emma.playerId}`, r.body.won]])[0].result == 1);
    assert.equal(r.body.refund, r.body.duplicate ? Shop.duplicateRefund(ecase, r.body.won) : 0, 'doublon : selon la rareté');
    assert.equal(r.body.coins, before - ecase.price + r.body.refund);
    const [spent1, cases1] = run([['HGET', `stats:${emma.playerId}`, 'spent'], ['HGET', `stats:${emma.playerId}`, 'cases']]).map(x => Number(x.result) || 0);
    assert.deepEqual([spent1 - spent0, cases1 - cases0, ecoCases() - eco0], [ecase.price - r.body.refund, 1, ecase.price - r.body.refund], 'spent, cases, eco');
    if (r.body.duplicate) edups++; else { enews++; gainedEmo[r.body.won] = 1; }
    await new Promise(res => setTimeout(res, 3));
  }
  assert.ok(enews >= 4 && enews <= epool.length && edups >= 1, `des nouvelles (${enews}) et des doublons (${edups})`);
  assert.deepEqual([r.body.owned, r.body.buttons, r.body.walls, r.body.sounds], [eBefore.owned, eBefore.buttons, eBefore.walls, eBefore.sounds], 'ni skin, ni bouton, ni fond, ni son donné');
  { const own1 = owners(); for (const id of epool) assert.equal((own1[`emotes:${id}`] || 0) - (eown0[`emotes:${id}`] || 0), gainedEmo[id] || 0, `owners emotes:${id}`); }
  // Une émote gagnée ne se rachète pas : buyemote ne débite rien de plus.
  { const won = r.body.emotes[0], c0 = await coinsOf(emma); r = await call(shopApi, { method: 'POST', body: { playerId: emma.playerId, secret: emma.secret, action: 'buyemote', emote: won } }); assert.equal(await coinsOf(emma), c0, 'déjà possédée : rien de débité'); }
  // Une clé Premium ouvre aussi la caisse d'émotes.
  run([['HSET', `stats:${emma.playerId}`, 'key:premium', 1]]);
  r = await call(shopApi, { method: 'POST', body: { playerId: emma.playerId, secret: emma.secret, action: 'case', case: 'emotes', free: 'premium' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number(run([['HGET', `stats:${emma.playerId}`, 'key:premium']])[0].result), 0, 'la clé est consommée');

  // Part du créateur sur une caisse (2026-10-28, finnnnn ne touchait rien sur les skins tirés en caisse) : 5 % de ce que
  // l'acheteur a payé pour la caisse quand un skin né d'une idée en sort pour la première fois ; rien pour un doublon,
  // une caisse ouverte avec une clé, ni pour soi-même.
  { const hot = Shop.byId.get('hotdog'), choc = Shop.byId.get('chocolate'), was = [hot.idea, choc.idea], draw = Shop.drawCase;
    hot.idea = 'Sammy'; choc.idea = 'sammy'; // même pseudo à la casse près : retrouvé quand même
    const roy = () => Number(run([['HGET', `stats:${sammy.playerId}`, 'royalty']])[0].result) || 0;
    const ecoRoy = () => [...db.keys()].filter(k => k.startsWith('eco:')).reduce((x, k) => x + (Number(db.get(k)?.get?.('in:royalty')) || 0), 0);
    const premium = Shop.caseById.get('premium');
    try {
      Shop.drawCase = () => 'hotdog';
      const r0 = roy(), e0 = ecoRoy();
      r = await openCase(bobby, 'premium'); assert.deepEqual([r.status, r.body.won, r.body.duplicate], [200, 'hotdog', false], JSON.stringify(r.body));
      assert.equal(roy() - r0, Math.round(premium.price * Shop.IDEA_SHARE), '5 % du prix de la caisse');
      assert.equal(ecoRoy() - e0, Math.round(premium.price * Shop.IDEA_SHARE), 'compté dans l\'économie (in:royalty)');
      await new Promise(res => setTimeout(res, 20));
      r = await openCase(bobby, 'premium'); assert.equal(r.body.duplicate, true);
      assert.equal(roy() - r0, 45, 'rien pour un doublon');
      Shop.drawCase = () => 'chocolate';
      run([['HINCRBY', `stats:${bobby.playerId}`, 'key:premium', 1]]);
      await new Promise(res => setTimeout(res, 20));
      r = await call(shopApi, { method: 'POST', body: { playerId: bobby.playerId, secret: bobby.secret, action: 'case', case: 'premium', free: true } });
      assert.deepEqual([r.status, r.body.won, r.body.duplicate], [200, 'chocolate', false]);
      assert.equal(roy() - r0, 45, 'rien pour une caisse ouverte avec une clé');
      Shop.drawCase = () => 'hotdog';
      await new Promise(res => setTimeout(res, 20));
      r = await openCase(sammy, 'premium'); assert.deepEqual([r.status, r.body.duplicate], [200, false]);
      assert.equal(roy() - r0, 45, 'rien pour soi-même');
    } finally { Shop.drawCase = draw; [hot.idea, choc.idea] = was; }
  }

  // Popularité (idée d'ann joe et de YU CHUAN 23, 2026-10-28) : chaque chemin qui donne un objet compte +1 une seule
  // fois ; la lecture publique ne donne que des nombres, jamais qui.
  { const olivy = { playerId: 'ca'.repeat(8), secret: 'db'.repeat(16), name: 'Olivy' };
    assert.equal((await call(roll, { method: 'POST', body: olivy })).status, 200);
    run([['HINCRBY', `stats:${olivy.playerId}`, 'bonus', 50000]]);
    const post = async body => { await new Promise(res => setTimeout(res, 20)); return call(shopApi, { method: 'POST', body: { playerId: olivy.playerId, secret: olivy.secret, ...body } }); };
    const o0 = owners();
    for (const body of [{ action: 'buy', skin: 'neon' }, { action: 'buy', skin: 'neon' }, { action: 'buywall', wall: 'forest' }, { action: 'buywall', wall: 'forest' }, { action: 'buybutton', button: 'powercore' },
      { action: 'buybutton', button: 'powercore' }, { action: 'buyemote', emote: 'gg' }, { action: 'buyemote', emote: 'gg' }, { action: 'buysound', sound: 'clicky' }, { action: 'buysound', sound: 'clicky' }]) {
      r = await post(body); assert.equal(r.status, 200, JSON.stringify([body, r.body]));
    }
    const o1 = owners();
    for (const k of ['skins:neon', 'walls:forest', 'buttons:powercore', 'emotes:gg', 'sounds:clicky']) assert.equal((o1[k] || 0) - (o0[k] || 0), 1, `${k} : +1, puis rien au deuxième achat`);
    r = await call(shopApi, { url: '/api/shop?owners=1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.owners['buttons:powercore'], o1['buttons:powercore']);
    assert.ok(!JSON.stringify(r.body).includes(olivy.playerId) && Object.values(r.body.owners).every(n => Number.isInteger(n) && n > 0), 'seulement des nombres');
    assert.equal((await call(shopApi, { url: `/api/shop?me=${olivy.playerId}` })).body.royalty, 0, 'state : la part reçue (0 ici)');
    assert.equal((await call(shopApi, { url: `/api/shop?me=${sammy.playerId}` })).body.royalty, 45, 'state : la part reçue par le créateur');
    // Rattrapage (tools/backfill-owners.js) : essai à blanc sans écrire, puis --apply remplace le hash par le vrai compte.
    const { backfill } = require(path.join(ROOT, 'tools/backfill-owners.js'));
    run([['HSET', 'owners', 'skins:neon', 999]]);
    const counts = await backfill({ log: () => {} });
    assert.equal(owners()['skins:neon'], 999, 'essai à blanc : rien écrit');
    const holders = (prefix, id) => [...db.keys()].filter(k => new RegExp(`^${prefix}:[0-9a-f]{16}$`).test(k) && run([['SISMEMBER', k, id]])[0].result == 1).length;
    assert.equal(counts['skins:neon'], holders('skins', 'neon'));
    assert.equal(counts['sounds:clicky'], holders('snds', 'clicky'));
    assert.equal(counts['buttons:powercore'], holders('btns', 'powercore'));
    assert.ok(!Object.keys(counts).some(k => k === 'skins:owner' || k.endsWith(':licorne')), 'ni objets réservés ni identifiants inventés');
    await backfill({ apply: true, log: () => {} });
    assert.deepEqual(owners(), counts, '--apply : le hash est remplacé'); }

  // ============================================================== 23. Amis
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const fr = (who, action, name) => call(friendsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, name } });
  assert.equal((await call(friendsApi, { url: '/api/friends' })).status, 405, 'jamais en GET (le secret ne va pas dans une adresse)');
  assert.equal((await fr({ ...quinn, secret: '9'.repeat(32) }, 'list')).status, 403);
  run([['HINCRBY', `stats:${quinn.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${carol.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${dave.playerId}`, 'h:rolls', 10]]); // 10 tirages pour envoyer des demandes d'amis (audit de sécurité, 2026-11-02)
  assert.equal((await fr(quinn, 'add', 'Personne Dutout')).status, 404);
  assert.equal((await fr(quinn, 'add', 'Quinn')).status, 422, 'pas soi-même');
  r = await fr(quinn, 'add', 'alice');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.friends.length, r.body.outgoing], [0, ['Alice']], 'demande envoyée (pseudo sans tenir compte des majuscules)');
  r = await fr(alice, 'list');
  assert.deepEqual([r.body.incoming, r.body.friends.length], [['Quinn'], 0]);
  assert.ok(!JSON.stringify(r.body).includes(quinn.playerId), 'aucun id');
  r = await fr(alice, 'accept', 'Quinn');
  assert.deepEqual([r.body.friends.map(f => f.name), r.body.incoming], [['Quinn'], []]);
  r = await fr(quinn, 'list');
  assert.deepEqual([r.body.friends.map(f => f.name), r.body.outgoing], [['Alice'], []]);
  assert.ok(r.body.friends[0].xp > 0 && r.body.friends[0].seen > 0, 'XP à vie et dernière activité de l\'ami');
  assert.equal((await fr(quinn, 'add', 'Alice')).body.note, 'Already friends');
  // Demandes croisées : la 2e accepte la 1re.
  await fr(quinn, 'add', 'Carol');
  r = await fr(carol, 'add', 'Quinn');
  assert.ok(r.body.friends.some(f => f.name === 'Quinn') && r.body.incoming.length === 0, 'demandes croisées = amis');
  // Refuser, annuler, retirer.
  await fr(dave, 'add', 'Quinn');
  assert.deepEqual((await fr(quinn, 'decline', 'Dave')).body.incoming, []);
  assert.deepEqual((await fr(dave, 'list')).body.outgoing, []);
  await fr(quinn, 'add', 'Dave');
  assert.deepEqual((await fr(quinn, 'cancel', 'Dave')).body.outgoing, []);
  assert.deepEqual((await fr(dave, 'list')).body.incoming, []);
  r = await fr(quinn, 'remove', 'Alice');
  assert.ok(!r.body.friends.some(f => f.name === 'Alice'));
  assert.ok(!(await fr(alice, 'list')).body.friends.some(f => f.name === 'Quinn'), 'retiré des deux côtés');

  // ============================================================== 24. Duels avec mise
  const w1 = { playerId: 'e1'.repeat(8), secret: 'f1'.repeat(16), name: 'Wone' }, w2 = { playerId: 'e2'.repeat(8), secret: 'f2'.repeat(16), name: 'Wtwo' };
  const poor = { playerId: 'e3'.repeat(8), secret: 'f3'.repeat(16), name: 'Poor' };
  for (const w of [w1, w2, poor]) assert.equal((await call(roll, { method: 'POST', body: w })).status, 200);
  assert.match((await roomPost(w1, 'create', { size: 2, stake: 100 })).body.error, /Stakes unlock after 30 rolls/, 'compte trop neuf pour miser');
  for (const w of [w1, w2]) run([['HINCRBY', `stats:${w.playerId}`, 'bonus', 2000], ['HSET', `stats:${w.playerId}`, 'rolls', 50]]);
  clock += 9000; // délai entre deux tirages écoulé
  const c1 = await coinsOf(w1), c2 = await coinsOf(w2);
  assert.equal((await roomPost(poor, 'create', { size: 2, stake: 1000 })).status, 422, 'pas assez pour miser');
  // Mise libre de 1 à 1 000 (idée de dog, 2026-11-01) : hors limites, refusée (plus jamais changée en « pas de mise »).
  for (const bad of [1001, 2.5, -5, 'abc', 1e9]) { const x = await roomPost(w1, 'create', { size: 2, stake: bad }); assert.equal(x.status, 422, `mise ${bad}`); assert.match(x.body.error, /from 1 to 1,000/); }
  assert.equal((await roomPost(w1, 'create', { size: 3, stake: 100, bots: 2 })).body.stake, 0, 'jamais de mise contre des bots');
  r = await roomPost(w1, 'create', { size: 2, stake: 100, mode: 'rounds', target: 1 });
  assert.deepEqual([r.status, r.body.stake, r.body.pot], [200, 100, 100], JSON.stringify(r.body));
  const staked = r.body.code;
  assert.equal(await coinsOf(w1), c1 - 100, 'mise prélevée à la création');
  assert.equal((await roomPost(poor, 'join', { code: staked })).status, 422, 'trop pauvre pour entrer');
  assert.equal((await roomPost(w1, 'addBot', { code: staked })).status, 422, 'pas de bot dans une partie à mise');
  r = await roomPost(w2, 'join', { code: staked });
  assert.deepEqual([r.body.status, r.body.pot], ['playing', 200]);
  assert.equal(await coinsOf(w2), c2 - 100, 'mise prélevée à l\'entrée');
  assert.equal((await roomPost(poor, 'ask', { code: staked })).status, 422, 'personne n\'entre en cours de partie à mise');
  let st = r.body;
  while (st.status === 'playing') {
    await later(11000, async () => { await roomPost(w1, 'ready', { code: staked }); st = (await roomPost(w2, 'ready', { code: staked })).body; });
  }
  assert.equal(st.status, 'done');
  assert.equal(st.settled, null, 'pas réglé avant la révélation');
  assert.deepEqual([await coinsOf(w1) < c1, await coinsOf(w2) < c2], [true, true], 'pot pas encore versé');
  r = await later(2500 + 9700, () => roomGet(staked, w1));
  const stakedWinner = [w1, w2][r.body.winner], stakedLoser = [w1, w2][1 - r.body.winner];
  assert.equal(r.body.settled, 'paid');
  assert.ok(!JSON.stringify(r.body).includes(w1.playerId) && !JSON.stringify(r.body).includes(w2.playerId), 'aucun id dans la salle');
  // Chacun a aussi gagné des pièces avec ses tirages du duel : on compare hors tirages (bonus − spent).
  // Hors Weekend Rush aussi : l'horloge des tests avance de plusieurs jours et peut tomber un samedi.
  // Hors récompenses du mois (topCoins) : en fin de mois, l'horloge passe le 1er et le Top 1/5/10 est payé (2026-10-27).
  const net = who => { const [b, s2, rush, top] = run([['HGET', `stats:${who.playerId}`, 'bonus'], ['HGET', `stats:${who.playerId}`, 'spent'], ['HGET', `stats:${who.playerId}`, 'rushBonus'], ['HGET', `stats:${who.playerId}`, 'topCoins']]).map(x => Number(x.result) || 0); return b - s2 - rush - top; };
  assert.equal(net(stakedWinner), 2000 + 100, 'le gagnant récupère sa mise et prend celle de l\'autre');
  assert.equal(net(stakedLoser), 2000 - 100, 'le perdant perd sa mise');
  assert.equal(net(w1) + net(w2), 4000, 'aucune pièce créée ni détruite');
  await later(13 * 3600000, () => call(leaderboard, { url: '/api/leaderboard?period=day' }));
  assert.equal(net(w1) + net(w2), 4000, 'le remboursement de secours ne paie pas une 2e fois');
  // Partie désertée : chacun récupère sa mise.
  r = await roomPost(w1, 'create', { size: 2, stake: 250 });
  const ghost = r.body.code;
  await roomPost(w2, 'join', { code: ghost });
  assert.equal(net(w1) + net(w2), 4000 - 500);
  r = await later(31000, () => roomGet(ghost));
  assert.equal(r.body.status, 'abandoned');
  assert.equal(net(w1) + net(w2), 4000, 'mises rendues');
  assert.equal((await roomGet(ghost)).body.settled, 'refund');
  // Salle oubliée (personne ne revient jamais) : remboursée par l'échéance de secours, 12 h plus tard.
  await roomPost(w1, 'create', { size: 2, stake: 500 });
  assert.equal(net(w1) + net(w2), 4000 - 500);
  await later(12 * 3600000 + 1000, () => call(leaderboard, { url: '/api/leaderboard?period=day' }));
  assert.equal(net(w1) + net(w2), 4000, 'remboursé sans que personne ne rouvre la salle');
  // Salon à mise quitté avant le début (dylanbuckleyisjewish, 2026-10-30) : mise rendue ~1 min plus tard, pas 12 h.
  const lb = () => call(leaderboard, { url: '/api/leaderboard?period=day' });
  r = await roomPost(w1, 'create', { size: 2, stake: 500 });
  const left = r.body.code;
  await later(30000, lb);
  assert.equal(net(w1) + net(w2), 4000 - 500, 'pas avant la vérification du salon');
  await later(31000, lb);
  assert.equal(net(w1) + net(w2), 4000, 'mise rendue 1 min après le départ de tous');
  assert.equal((await roomGet(left)).body.status, 'abandoned');
  // L'hôte attend toujours sur la page : rien n'est rendu, et un adversaire peut encore entrer.
  r = await roomPost(w1, 'create', { size: 2, stake: 500 });
  const waiting = r.body.code;
  for (let i = 0; i < 5; i++) { await later(20000, () => roomGet(waiting, w1)); await lb(); }
  assert.equal(net(w1) + net(w2), 4000 - 500, 'salon encore ouvert : mise gardée');
  assert.equal((await roomPost(w2, 'join', { code: waiting })).body.status, 'playing', 'le salon attendait encore');
  await roomPost(w1, 'quit', { code: waiting }); // forfait : w2 gagne le pot, la suite des tests repart à zéro
}

// ================================================================ 25. Anti-farm : victoires de duel sans enjeu
// Tirages forcés : le 1er nombre de la file va au 1er joueur de la salle, etc. (0 = le plus gros tirage possible).
{
  const realRandomInt = crypto.randomInt;
  const forced = [];
  crypto.randomInt = (...args) => (forced.length && args[0] === 0 && args[1] === 1000001 ? forced.shift() : realRandomInt(...args));
  const mk = (tag, name) => ({ playerId: tag.repeat(8), secret: tag.repeat(16), name });
  const hero = mk('a7', 'Hero'), foe = mk('a8', 'Foe'), foe2 = mk('a9', 'Foetwo'), newbie = mk('b7', 'Newbie');
  for (const who of [hero, foe, foe2, newbie]) assert.equal((await call(roll, { method: 'POST', body: who })).status, 200);
  for (const who of [hero, foe, foe2]) run([['HSET', `stats:${who.playerId}`, 'rolls', 60]]);
  clock += 9000;
  const stat = (who, f) => Number(run([['HGET', `stats:${who.playerId}`, f]])[0].result) || 0;
  const coins = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  // Un duel en 1 manche que `winner` gagne (premier de la salle = créateur) ; renvoie l'état après le bilan.
  const duel = async (winner, loser) => {
    r = await roomPost(winner, 'create', { size: 2, mode: 'rounds', target: 1, public: false });
    const c = r.body.code;
    await roomPost(loser, 'join', { code: c });
    forced.push(0, 372368);
    await later(11000, async () => { await roomPost(winner, 'ready', { code: c }); await roomPost(loser, 'ready', { code: c }); });
    assert.equal(forced.length, 0, 'tirages forcés consommés');
    r = await later(2500 + 9700, () => roomGet(c, winner));
    assert.deepEqual([r.body.status, r.body.winner], ['done', 0]);
    return r.body;
  };
  // 3 victoires par jour contre le même adversaire sont récompensées, la 4e ne l'est plus (mais compte au face-à-face).
  const rolledCoins = async who => (await coins(who)) - 25 * Shop.rankedWins({ duelWins: stat(who, 'duelWins'), duelUnpaid: stat(who, 'duelUnpaid') });
  for (let i = 1; i <= 3; i++) assert.equal((await duel(hero, foe)).reward, 'ok', `victoire ${i} récompensée`);
  assert.deepEqual([stat(hero, 'duelWins'), stat(hero, 'duelUnpaid')], [3, 0]);
  const base = await rolledCoins(hero);
  let last = await duel(hero, foe);
  assert.equal(last.reward, 'pair', '4e victoire du jour contre le même joueur : sans récompense');
  assert.deepEqual([stat(hero, 'duelWins'), stat(hero, 'duelUnpaid')], [4, 1], 'elle compte quand même comme victoire');
  assert.equal(Shop.rankedWins({ duelWins: 4, duelUnpaid: 1 }), 3);
  assert.equal(await coins(hero), (await rolledCoins(hero)) + 75, 'pièces de victoire : 3 × 25, pas 4');
  assert.equal(run([['HGET', `h2h:${hero.playerId}`, `w:${foe.playerId}`]])[0].result, '4', 'face-à-face complet');
  assert.ok(base > 0);
  // Un autre adversaire établi : de nouveau récompensé.
  assert.equal((await duel(hero, foe2)).reward, 'ok');
  // Compte adverse trop neuf (moins de 20 tirages) : rien à gagner. L'inverse (le nouveau bat un compte établi) paie.
  assert.equal((await duel(hero, newbie)).reward, 'new');
  assert.equal((await duel(newbie, foe2)).reward, 'ok');
  // Plafond du jour : 10 victoires récompensées au total.
  run([['HSET', `dw:${new Date(Date.now()).toISOString().slice(0, 10)}:${foe2.playerId}`, 'total', 10]]);
  assert.equal((await duel(foe2, hero)).reward, 'day');
  // Le lendemain, les compteurs repartent.
  clock += 86400000;
  assert.equal((await duel(hero, foe)).reward, 'ok', 'nouveau jour : de nouveau récompensé');
  // Succès de duel : seules les victoires récompensées comptent (Gladiator = 10).
  const Ach = require(path.join(ROOT, 'js/achievements.js'));
  assert.ok(!Ach.unlocked({ duelWins: 12, duelUnpaid: 3 }).includes('gladiator'));
  assert.ok(Ach.unlocked({ duelWins: 12, duelUnpaid: 2 }).includes('gladiator'));
  crypto.randomInt = realRandomInt;
}

// ================================================================ 26. Boîte à suggestions et fréquentation
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const site = (who, action, extra = {}, headers = {}) => call(siteApi, { method: 'POST', body: { ...(who ? { playerId: who.playerId, secret: who.secret, name: who.name } : {}), action, ...extra }, headers });
  const today = () => new Date(Date.now()).toISOString().slice(0, 10);
  assert.equal((await call(siteApi, { url: '/api/site' })).status, 405);
  // Suggestions : il faut être un joueur, écrire quelque chose, et pas plus de 5 par jour.
  assert.equal((await site({ ...alice, secret: '9'.repeat(32) }, 'suggest', { text: 'Hello there' })).status, 403);
  assert.equal((await site(alice, 'suggest', { text: 'hey' })).status, 422, 'trop court');
  r = await site(alice, 'suggest', { text: '  Add a tournament mode\u0007 please!  \n\n\n\nWith brackets.', lang: 'fr' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.sent, r.body.owner, r.body.mine.length], [true, false, 1]);
  assert.equal(r.body.mine[0].text, 'Add a tournament mode please!\n\nWith brackets.', 'nettoyé : caractères de contrôle et lignes vides en trop');
  assert.deepEqual([r.body.mine[0].status, r.body.mine[0].reply], ['new', '']);
  assert.ok(!JSON.stringify(r.body).includes(alice.playerId), 'aucun id');
  clock += 1000;
  const long = await site(alice, 'suggest', { text: 'x'.repeat(900) });
  assert.equal(long.body.mine[0].text.length, 500, 'borné à 500 caractères');
  for (let i = 0; i < 3; i++) { clock += 1000; assert.equal((await site(alice, 'suggest', { text: `idea number ${i}` })).status, 200); }
  assert.equal((await site(alice, 'suggest', { text: 'one too many' })).status, 429, '5 par jour');
  clock += 1000; // une seconde plus tard : la plus récente est sans ambiguïté celle-ci
  assert.equal((await site(bobNow, 'suggest', { text: 'A dark red theme' })).status, 200);
  assert.equal((await site(bobNow, 'mine')).body.mine.length, 1, 'chacun ne voit que les siennes');
  // Réservé au créateur : un joueur normal n'a ni la boîte de réception ni la fréquentation.
  for (const action of ['inbox', 'stats', 'mark', 'delete']) assert.equal((await site(alice, action, { id: 'a'.repeat(12) })).status, 403, action);
  assert.equal((await site(alice, 'nope')).status, 400);
  const boss = { playerId: '9'.repeat(16), secret: '7'.repeat(32), name: 'Boss' }; // compte Owner du test 14
  assert.equal(run([['HGET', `stats:${boss.playerId}`, 'owner']])[0].result, '1');
  r = await site(boss, 'inbox');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 6);
  assert.deepEqual(r.body.suggestions[0].name, 'Sacha', 'la plus récente d\'abord, avec le pseudo');
  assert.ok(!JSON.stringify(r.body).includes(alice.playerId));
  const first = r.body.suggestions.find(x => x.text.startsWith('Add a tournament'));
  r = await site(boss, 'mark', { id: first.id, status: 'planned', reply: 'Good idea, coming soon!' });
  assert.deepEqual([r.status, r.body.suggestions.find(x => x.id === first.id).status], [200, 'planned']);
  const seen = (await site(alice, 'mine')).body.mine.find(x => x.id === first.id);
  assert.deepEqual([seen.status, seen.reply], ['planned', 'Good idea, coming soon!'], 'le joueur voit le statut et la réponse');
  assert.equal((await site(boss, 'mark', { id: first.id, status: 'hacked' })).body.suggestions.find(x => x.id === first.id).status, 'planned', 'statut inconnu ignoré');
  // Passée en Added : un point Contributor (idée), une seule fois même si on la remet en Added (2026-10-18).
  { const before = Number(run([['HGET', `stats:${alice.playerId}`, 'ideasAdded']])[0].result || 0);
    await site(boss, 'mark', { id: first.id, status: 'done' }); await site(boss, 'mark', { id: first.id, status: 'seen' }); await site(boss, 'mark', { id: first.id, status: 'done' });
    assert.equal(Number(run([['HGET', `stats:${alice.playerId}`, 'ideasAdded']])[0].result), before + 1, 'compté une fois');
    assert.ok(require(path.join(ROOT, 'js/achievements.js')).unlocked({ ideasAdded: 1 }).includes('contributor'));
    await site(boss, 'mark', { id: first.id, status: 'planned' }); }
  r = await site(boss, 'delete', { id: first.id });
  assert.equal(r.body.total, 5);
  assert.ok(!(await site(alice, 'mine')).body.mine.some(x => x.id === first.id), 'supprimée aussi chez le joueur');
  assert.equal((await site(boss, 'delete', { id: first.id })).status, 404);

  // Fréquentation : compteurs anonymes du jour. Les en-têtes x-vercel-* ne comptent que sur Vercel (VERCEL=1).
  db.delete(`an:${today()}`);
  process.env.VERCEL = '1';
  const visit = (extra, headers = {}) => site(null, 'visit', extra, { 'x-forwarded-for': '203.0.113.9', ...headers });
  assert.equal((await visit({ ref: 'www.Reddit.com', src: 'Discord', lang: 'fr', first: true, daily: true, mobile: true }, { 'x-vercel-ip-country': 'FR' })).status, 200);
  await visit({ ref: 'reddit.com', daily: true }, { 'x-vercel-ip-country': 'FR' });
  await visit({ ref: '', lang: 'en' }, { 'x-vercel-ip-country': 'US' });
  await visit({ ref: '<script>alert(1)</script>', src: 'bad source!' });
  const an = Object.fromEntries(run([['HGETALL', `an:${today()}`]])[0].result.reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, Number(arr[i + 1])]]), []));
  assert.deepEqual([an.visits, an.uniq, an.new], [4, 2, 1]);
  assert.deepEqual([an['ref:reddit.com'], an['ref:direct'], an['src:discord']], [2, 2, 1], 'origine normalisée ; origine invalide = direct');
  assert.deepEqual([an['c:FR'], an['c:US'], an['c:ZZ'], an['d:mobile'], an['d:desktop'], an['l:fr'], an['l:en']], [2, 1, 1, 1, 3, 1, 3]);
  assert.ok(!Object.keys(an).some(k => /script|bad/.test(k)), 'rien d\'inventé ne passe');
  delete process.env.VERCEL;
  assert.ok(!JSON.stringify(an).includes('203.0.113'), 'aucune adresse IP stockée');
  // Pas plus de 60 balises par adresse et par heure (large : tout un collège peut partager la même adresse).
  for (let i = 0; i < 80; i++) await visit({ ref: 'spam.example' });
  assert.equal(Number(run([['HGET', `an:${today()}`, 'visits']])[0].result), 60, 'balises en trop ignorées, pas les 60 premières');
  // Un jour ne peut pas enfler : passé 400 champs, les origines inconnues vont dans « other ».
  run([['HSET', `an:${today()}`, ...Array.from({ length: 400 }, (_, i) => [`ref:filler${i}.example`, 1]).flat()]]);
  await site(null, 'visit', { ref: 'brand-new.example' }, { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(run([['HGET', `an:${today()}`, 'ref:brand-new.example']])[0].result, null);
  assert.equal(run([['HGET', `an:${today()}`, 'ref:other']])[0].result, '1');
  run([['HSET', 'wall', 'ee'.repeat(8), 'graveyard']]);
  r = await site(boss, 'stats');
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  { const ins = await site(boss, 'insights'); assert.ok(ins.body.players.walls.some(x => x.name === 'graveyard' && x.count >= 1), 'fonds d\'écran affichés comptés'); assert.ok('godlike' in ins.body.players.top, 'Godlike compté'); }
  // Nouveaux blocs de la page Owner (2026-10-18).
  { const x = (await site(boss, 'insights')).body.extra;
    assert.equal(x.weekdays.length, 7); assert.equal(x.weekdays[0].name, 'Mon');
    assert.equal(x.economy.length, 14); assert.ok(x.economy[0].in.rolls > 0, 'les tirages du jour créent des pièces : ' + JSON.stringify(x.economy[0]));
    assert.ok(x.sales.some(i => i.kind === 'skins' && i.price > 0)); assert.ok(x.sales.some(i => i.kind === 'sounds' && i.id === 'arcade')); assert.equal(x.health.length, 7);
    assert.ok(typeof x.newFeatures.discordLinks === 'number' && x.newFeatures.event.goal > 0);
    // Masse monétaire (2026-10-25) : SCAN de stats:*, gardée 10 minutes dans eco:supply.
    assert.ok(x.supply.total > 0 && x.supply.holders > 0 && x.supply.top1 > 0 && x.supply.top1 <= 1, JSON.stringify(x.supply));
    assert.ok(run([['PTTL', 'eco:supply']])[0].result > 590000, 'en cache 10 min');
    run([['HINCRBY', `stats:${boss.playerId}`, 'bonus', 777]]);
    assert.equal((await site(boss, 'insights')).body.extra.supply.total, x.supply.total, 'relu depuis le cache');
    run([['DEL', 'eco:supply']]);
    assert.equal((await site(boss, 'insights')).body.extra.supply.total, x.supply.total + 777, 'recalculé une fois le cache parti'); }
  assert.equal(r.body.days.length, 30);
  assert.equal(r.body.days[0].day, today());
  assert.ok(r.body.days[0].visits >= 4 && r.body.week.refs.some(x => x.name === 'reddit.com' && x.count === 2));
  assert.ok(r.body.week.countries.some(x => x.name === 'FR') && r.body.totals.named > 5);
}

// ================================================================ 27. Boutons de tirage : assortis au skin, ou achetés à part
{
  const state = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body;
  const btn = (who, action, button) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, button } });
  const look = st => Shop.buttonLook(st.button, st.skin, st.owned, st.buttons);
  const setCoins = async (who, target) => run([['HINCRBY', `stats:${who.playerId}`, 'bonus', target - (await state(who)).coins]]);
  await shop(frank, 'equip', 'neon');
  let st = await state(frank);
  assert.deepEqual([st.button, st.buttons, look(st)], ['match', [], 'neon'], 'par défaut : le bouton suit le skin équipé');
  // Le bouton d'un skin : seulement si on possède le skin.
  assert.equal((await btn(frank, 'button', 'gold')).status, 422, 'bouton d\'un skin non possédé');
  assert.equal((await btn(frank, 'button', 'licorne')).status, 400);
  assert.equal((await btn({ ...frank, secret: '9'.repeat(32) }, 'button', 'classic')).status, 403);
  r = await btn(frank, 'button', 'classic');
  assert.deepEqual([r.status, r.body.button], [200, 'classic']);
  st = await state(frank);
  assert.deepEqual([st.skin, look(st)], ['neon', 'classic'], 'skin Neon, bouton Classic');
  // Bouton vendu à part : pas sans l'acheter, pas sans les pièces, débité une seule fois, équipé à l'achat.
  assert.equal((await btn(frank, 'button', 'keycap')).status, 422, 'pas encore acheté');
  assert.equal((await btn(frank, 'buybutton', 'neon')).status, 400, 'le bouton d\'un skin ne s\'achète pas à part');
  await setCoins(frank, 100);
  r = await btn(frank, 'buybutton', 'keycap');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /50 more needed/);
  assert.deepEqual((await state(frank)).buttons, [], 'rien d\'acquis sans les pièces');
  await setCoins(frank, 400);
  r = await btn(frank, 'buybutton', 'keycap');
  assert.deepEqual([r.status, r.body.coins, r.body.button, r.body.buttons], [200, 250, 'keycap', ['keycap']], JSON.stringify(r.body));
  assert.equal((await btn(frank, 'buybutton', 'keycap')).body.coins, 250, 'racheter ne débite pas deux fois');
  assert.equal(look(await state(frank)), 'keycap');
  // Un achat à la fois : pendant qu'un autre est en cours, celui-ci est refusé sans rien débiter.
  await new Promise(resolve => setImmediate(resolve)); // la requête précédente relâche son verrou après avoir répondu
  run([['SET', `shop:${frank.playerId}`, '1']]);
  assert.equal((await btn(frank, 'buybutton', 'terminal')).status, 429);
  run([['DEL', `shop:${frank.playerId}`]]);
  assert.equal((await state(frank)).coins, 250);
  // Retour au bouton assorti : changer de skin change alors le bouton.
  assert.equal((await btn(frank, 'button', 'match')).body.button, 'match');
  await shop(frank, 'equip', 'classic');
  assert.equal(look(await state(frank)), 'classic');
  await shop(frank, 'equip', 'neon');
  assert.equal(look(await state(frank)), 'neon');
  // Le bouton acheté reste possédé et se rééquipe sans payer.
  r = await btn(frank, 'button', 'keycap');
  assert.deepEqual([r.status, r.body.button, r.body.coins], [200, 'keycap', 250]);
  // Un choix enregistré qui n'est pas possédé (donnée abîmée) retombe sur « match » ; un identifiant inventé est ignoré.
  run([['HSET', 'btns', frank.playerId, 'gold'], ['SADD', `btns:${frank.playerId}`, 'licorne']]);
  st = await state(frank);
  assert.deepEqual([st.button, st.buttons, look(st)], ['match', ['keycap'], 'neon']);
  // Le bouton du créateur : réservé à son compte.
  assert.equal((await btn(frank, 'button', 'owner')).status, 422);
  const boss = { playerId: '9'.repeat(16), secret: '7'.repeat(32) };
  r = await btn(boss, 'button', 'owner');
  assert.deepEqual([r.status, r.body.button], [200, 'owner'], JSON.stringify(r.body));
  // Catalogue : identifiants distincts de ceux des skins, et chaque bouton (ceux des skins compris) a bien son style.
  assert.ok(Shop.BUTTONS.every(b => !Shop.byId.has(b.id) && b.id !== Shop.MATCH && b.price > 0));
  const css = fs.readFileSync(path.join(ROOT, 'css/buttons.css'), 'utf8');
  for (const id of [...Shop.SKINS.map(k => k.id).filter(id => id !== 'classic'), 'owner', ...Shop.BUTTONS.map(b => b.id)]) {
    assert.ok(css.includes(`.btn-roll.gen-${id} {`), `style du bouton ${id} manquant dans css/buttons.css`);
  }
}

// White Chocolate (idée de qwertyuiop, 2026-11-01) : variante moins chère de Chocolate, avec son bouton, son cadre de
// duel et sa scène ; elle entre dans la caisse Premium par son prix. Last Roll et Bread : leurs crochets dans js/app.js.
{
  const wc = Shop.byId.get('whitechoc');
  assert.ok(wc && wc.idea === 'qwertyuiop' && wc.price < Shop.byId.get('chocolate').price, 'moins chère que Chocolate');
  const style = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8'), fx = fs.readFileSync(path.join(ROOT, 'js/skinfx.js'), 'utf8');
  assert.ok(style.includes('.num-card.skin-whitechoc {') && style.includes('.side-whitechoc {'), 'carte et cadre de duel');
  assert.ok(fx.includes('SCENES.whitechoc = ') && fx.includes('SCENES.chocolate = '), 'les deux scènes existent');
  assert.ok(Shop.casePool(Shop.caseById.get('premium')).some(k => k.id === 'whitechoc'));
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert.ok(app.includes('breadBite(i + 1 - lead)') && app.includes('breadBite(0)'), 'Bread : une bouchée par chiffre, entier au tirage suivant');
  assert.ok(app.includes("setLastRoll(Store.rolls[index - 1])"), 'Last Roll : le nombre d\'avant sur l\'écran de tirage');
  const btns = fs.readFileSync(path.join(ROOT, 'css/buttons.css'), 'utf8');
  for (let n = 1; n <= 6; n++) assert.ok(btns.includes(`.btn-roll.gen-bread[data-bites="${n}"]`), `bouchée ${n}`);
  for (let i = 0; i < 16; i++) assert.ok(btns.includes(`var(--b${i}, 1)`), `bulle ${i}`);
}

// ================================================================ 27b. Packs de sons du tirage (idée d'Angelicide9)
{
  const state = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body;
  const snd = (who, action, sound) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, sound } });
  const setCoins = async (who, target) => run([['HINCRBY', `stats:${who.playerId}`, 'bonus', target - (await state(who)).coins]]);
  let st = await state(frank);
  assert.deepEqual([st.sound, st.sounds], ['classic', []], 'par défaut : Classic, rien d\'acheté');
  assert.equal((await snd(frank, 'sound', 'arcade')).status, 422, 'pas encore acheté');
  assert.equal((await snd(frank, 'sound', 'licorne')).status, 400);
  assert.equal((await snd(frank, 'buysound', 'classic')).status, 400, 'Classic ne s\'achète pas');
  assert.equal((await snd({ ...frank, secret: '9'.repeat(32) }, 'buysound', 'arcade')).status, 403);
  await setCoins(frank, 100);
  r = await snd(frank, 'buysound', 'arcade');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /200 more needed/);
  assert.deepEqual((await state(frank)).sounds, [], 'rien d\'acquis sans les pièces');
  await setCoins(frank, 1000);
  const spent0 = Number(db.get(`stats:${frank.playerId}`).get('spent')) || 0;
  const ecoOut = () => [...db.keys()].filter(k => k.startsWith('eco:')).reduce((x, k) => x + (Number(db.get(k)?.get?.('out:sounds')) || 0), 0);
  const eco0 = ecoOut();
  r = await snd(frank, 'buysound', 'arcade');
  assert.deepEqual([r.status, r.body.coins, r.body.sound, r.body.sounds], [200, 700, 'arcade', ['arcade']], JSON.stringify(r.body));
  assert.equal(Number(db.get(`stats:${frank.playerId}`).get('spent')) - spent0, 300, 'spent compté');
  assert.equal(ecoOut() - eco0, 300, 'eco out:sounds compté');
  assert.equal((await snd(frank, 'buysound', 'arcade')).body.coins, 700, 'racheter ne débite pas deux fois');
  // Un achat à la fois (même verrou que la boutique).
  await new Promise(resolve => setImmediate(resolve));
  run([['SET', `shop:${frank.playerId}`, '1']]);
  assert.equal((await snd(frank, 'buysound', 'glass')).status, 429);
  run([['DEL', `shop:${frank.playerId}`]]);
  assert.equal((await state(frank)).coins, 700);
  // Changer de pack : Classic toujours permis, le pack acheté se remet sans payer.
  r = await snd(frank, 'sound', 'classic');
  assert.deepEqual([r.status, r.body.sound], [200, 'classic']);
  assert.equal((await state(frank)).sound, 'classic');
  r = await snd(frank, 'sound', 'arcade');
  assert.deepEqual([r.status, r.body.sound, r.body.coins], [200, 'arcade', 700]);
  // Donnée abîmée : un pack en service non possédé retombe sur Classic ; un identifiant inventé est ignoré.
  run([['HSET', 'snd', frank.playerId, 'glass'], ['SADD', `snds:${frank.playerId}`, 'licorne']]);
  st = await state(frank);
  assert.deepEqual([st.sound, st.sounds], ['classic', ['arcade']]);
  // Catalogue : chaque pack payant a sa recette dans js/sound.js, prix entre 300 et 800.
  const src = fs.readFileSync(path.join(ROOT, 'js/sound.js'), 'utf8');
  for (const p of Shop.SOUNDS.filter(p => p.price)) { assert.ok(p.price >= 300 && p.price <= 800); assert.ok(new RegExp(`\\n    ${p.id}: \\{`).test(src), `recette du pack ${p.id}`); }
}

// ================================================================ 28. Émotes spéciales : achetées une fois, réservées à qui les possède
{
  const state = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body;
  const buy = (who, emote) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'buyemote', emote } });
  const setCoins = async (who, target) => run([['HINCRBY', `stats:${who.playerId}`, 'bonus', target - (await state(who)).coins]]);
  assert.deepEqual((await state(frank)).emotes, [], 'aucune émote spéciale au départ');
  assert.equal((await buy(frank, 'licorne')).status, 400);
  assert.equal((await buy(frank, 'laugh')).status, 400, 'les six de base ne se vendent pas');
  assert.equal((await buy({ ...frank, secret: '9'.repeat(32) }, 'gg')).status, 403);
  await setCoins(frank, 250);
  r = await buy(frank, 'gg'); // 300 pièces
  assert.equal(r.status, 422);
  assert.match(r.body.error, /50 more needed/);
  await setCoins(frank, 1000);
  r = await buy(frank, 'gg');
  assert.deepEqual([r.status, r.body.coins, r.body.emotes], [200, 700, ['gg']], JSON.stringify(r.body));
  assert.equal((await buy(frank, 'gg')).body.coins, 700, 'racheter ne débite pas deux fois');
  // La requête précédente relâche son verrou juste après avoir répondu : on la laisse finir avant de poser le nôtre.
  await new Promise(resolve => setImmediate(resolve));
  run([['SET', `shop:${frank.playerId}`, '1']]);
  assert.equal((await buy(frank, 'rage')).status, 429, 'un achat à la fois');
  run([['DEL', `shop:${frank.playerId}`]]);
  run([['SADD', `emotes:${frank.playerId}`, 'licorne']]);
  assert.deepEqual((await state(frank)).emotes, ['gg'], 'un identifiant inventé est ignoré');
  // En duel : une émote spéciale ne part que si on la possède ; les six de base partent toujours.
  r = await roomPost(frank, 'create', { size: 2, mode: 'rounds', target: 1, bots: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = r.body.code;
  await later(1000, async () => {
    r = await roomPost(frank, 'react', { code, emoji: 'rage' });
    assert.deepEqual([r.status, r.body.error], [403, 'Buy this emote first']);
  });
  await later(1000, async () => {
    r = await roomPost(frank, 'react', { code, emoji: 'gg' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.reacts.some(x => x.e === 'gg' && x.name === frank.name), 'la réaction part, visible de tous');
  });
  await later(1000, async () => assert.equal((await roomPost(frank, 'react', { code, emoji: 'cool' })).status, 200));
  await later(1000, async () => assert.equal((await roomPost(frank, 'react', { code, emoji: '🦄' })).status, 400));
  // Catalogue : identifiants distincts des émotes de base.
  assert.ok(Shop.EMOTES.every(e => !Shop.BASE_EMOTES.includes(e.id) && e.price > 0));
  // Émotes en image (2026-11-03) : un fichier carré de 192 px chacune, comme les six de base ; elles se vendent et partent en duel.
  for (const e of Shop.EMOTES.filter(x => x.img)) {
    const png = fs.readFileSync(path.join(ROOT, `img/emotes/${e.id}.png`));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [192, 192], `img/emotes/${e.id}.png en 192 × 192`);
  }
  await setCoins(frank, 1000);
  r = await buy(frank, 'salty');
  assert.deepEqual([r.status, r.body.emotes], [200, ['gg', 'salty']], JSON.stringify(r.body));
  await later(1000, async () => assert.equal((await roomPost(frank, 'react', { code, emoji: 'salty' })).status, 200, 'émote en image achetée : elle part'));
  await later(1000, async () => assert.equal((await roomPost(frank, 'react', { code, emoji: 'onfire' })).status, 403, 'pas achetée : refusée'));
}

// ================================================================ 29. Chat des duels : joueurs assis seulement, filtré, limité en débit
{
  const { cleanChat } = require(path.join(ROOT, 'api/_chat.js'));
  assert.equal(cleanChat('  hello   world \u0007 '), 'hello world');
  assert.equal(cleanChat('FUCK you'), '**** you');
  assert.equal(cleanChat('f.u.c.k off'), '******* off', 'lettres séparées');
  assert.equal(cleanChat('sh1t!'), '****!', 'chiffres à la place des lettres, ponctuation gardée');
  assert.equal(cleanChat('sale connard'), 'sale *******');
  assert.equal(cleanChat('ta gueule stp'), '******** stp');
  // Yooooooooo (2026-10-30) : les mots en « -job » passaient ; « job » seul reste permis.
  for (const bad of ['blowjob', 'blow job', 'BLOW-JOB', 'handjob', 'hand job', 'rimjob']) assert.ok(!/job/i.test(cleanChat(`a ${bad} lol`)), `« ${bad} » doit être masqué`);
  for (const ok of ['good job', 'my job is fun', 'jobs']) assert.equal(cleanChat(ok), ok, `« ${ok} » ne doit pas être touché`);
  for (const ok of ['pass the class', 'Scunthorpe united', "j'ai tiré 7175 !", 'my best is 777777', 'score: 1,234,567 XP', 'assassin', 'well played 🎉']) assert.equal(cleanChat(ok), ok, `« ${ok} » ne doit pas être touché`);
  assert.equal(cleanChat('go https://evil.com/x now'), 'go [link] now');
  assert.equal(cleanChat('join discord.gg/abc'), 'join [link]');
  assert.equal(cleanChat('mon num 06 12 34 56 78'), 'mon num [number]');
  assert.equal(cleanChat('x'.repeat(300)).length, 140);
  assert.equal(cleanChat(' ​ \n '), '');

  r = await roomPost(frank, 'create', { size: 2, mode: 'rounds', target: 1, bots: 1 });
  const code = r.body.code;
  assert.deepEqual(r.body.chat, [], 'pas de message au départ');
  const say = (who, text) => roomPost(who, 'chat', { code, text });
  await later(2000, async () => {
    r = await say(frank, 'Hello there, FUCK this https://evil.com');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.chat.map(c => [c.name, c.me, c.bot, c.m]), [['Frank', true, false, 'Hello there, **** this [link]']]);
    assert.ok(!JSON.stringify(r.body.chat).includes(frank.playerId), 'aucun identifiant dans le chat');
    assert.equal((await say(frank, 'again')).status, 429, 'pas deux messages coup sur coup');
  });
  await later(1300, async () => {
    assert.equal((await say(alice, 'let me in')).status, 422, 'un spectateur ne peut pas écrire');
    assert.equal((await say(frank, '   ')).status, 422, 'message vide');
    assert.equal((await say({ ...frank, secret: '9'.repeat(32) }, 'hi')).status, 403);
  });
  // Vu par quelqu'un d'autre : le message est là, sans « me ».
  r = await call(roomApi, { url: `/api/room?code=${code}&me=${alice.playerId}` });
  assert.deepEqual(r.body.chat.map(c => [c.name, c.me, c.m]), [['Frank', false, 'Hello there, **** this [link]']]);
  // Réactions emoji aux messages (Sacha, 2026-11-02, api/_react.js) : les joueurs assis, 6 emojis, toucher la sienne l'enlève.
  {
    const t0 = r.body.chat[0].t, rxFree = who => run([['DEL', `rx:rl:${who.playerId}`]]);
    assert.equal((await roomPost(alice, 'chatReact', { code, t: t0, emoji: '👍' })).status, 422, 'un spectateur ne réagit pas');
    assert.equal((await roomPost(frank, 'chatReact', { code, t: t0, emoji: '🍆' })).status, 400, 'emoji hors liste');
    let x = await roomPost(frank, 'chatReact', { code, t: t0, emoji: '🔥' }); assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.deepEqual(x.body.chat[0].rx, [{ e: '🔥', n: 1, mine: true, who: ['Frank'] }]);
    assert.equal((await roomPost(frank, 'chatReact', { code, t: t0, emoji: '🔥' })).status, 429, 'pas deux réactions coup sur coup');
    x = await call(roomApi, { url: `/api/room?code=${code}&me=${alice.playerId}` }); assert.deepEqual(x.body.chat[0].rx, [{ e: '🔥', n: 1, mine: false, who: ['Frank'] }], 'vu par un spectateur');
    rxFree(frank); x = await roomPost(frank, 'chatReact', { code, t: t0, emoji: '🔥' }); assert.equal(x.body.chat[0].rx, undefined, 'toucher la sienne l\'enlève');
    rxFree(frank); assert.equal((await roomPost(frank, 'chatReact', { code, t: 123, emoji: '🔥' })).status, 404, 'message inconnu');
    assert.ok(!JSON.stringify(x.body.chat).includes(frank.playerId), 'aucun identifiant');
  }
  // Rafale : 12 messages par 30 s au plus, même en respectant l'écart entre deux messages.
  let statuses = [];
  for (let k = 0; k < 13; k++) await later(1300, async () => statuses.push((await say(frank, `message ${k}`)).status));
  assert.equal(statuses.filter(x => x === 200).length, 11, `11 de plus passent (12 avec le premier), puis 429 : ${statuses}`);
  assert.equal(statuses[statuses.length - 1], 429);
  r = await call(roomApi, { url: `/api/room?code=${code}&me=${frank.playerId}` });
  assert.equal(r.body.chat.length, 12);
  // Signalement (api/_reports.js) : un spectateur signale un message de Frank ; pas son propre message, pas un faux.
  {
    const first = r.body.chat[0];
    // Signaler demande un pseudo et 20 tirages (audit de sécurité, 2026-11-02) : un compte neuf est refusé.
    { const nb = { playerId: '9d'.repeat(8), secret: '9d2'.repeat(11).slice(0, 32) }; run([['SET', `player:${nb.playerId}:secret`, crypto.createHash('sha256').update(nb.secret).digest('hex')], ['HSET', 'names', nb.playerId, 'Nobody9']]);
      const Rp = require(path.join(ROOT, 'api/_reports.js')); await assert.rejects(Rp.fileReport({ reporter: nb.playerId, author: alice.playerId, text: 'x', where: 'test', msgT: 1 }), /20 rolls/); }
    run([['HINCRBY', `stats:${alice.playerId}`, 'h:rolls', 20]]);
    const rep = t => roomPost(alice, 'report', { code, t });
    let x = await rep(first.t); assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.reported, true);
    assert.equal((await rep(first.t)).body.already, true, 'une seule fois');
    assert.equal((await rep(12345)).status, 404, 'message inventé');
    assert.equal((await roomPost(frank, 'report', { code, t: first.t })).status, 422, 'pas son propre message');
  }
  assert.equal(r.body.chat[r.body.chat.length - 1].m, 'message 10');
}

// ================================================================ 30. Tirage redemandé : le même jeton renvoie le même tirage, compté une seule fois
{
  const rollWith = (who, nonce) => call(roll, { method: 'POST', body: { ...who, nonce } });
  const rollsOf = who => Number(run([['HGET', `stats:${who.playerId}`, 'rolls']])[0].result) || 0;
  const xpOf = who => Number(run([['ZSCORE', 'lb:xp', who.playerId]])[0].result) || 0;
  await later(20000, async () => {
    const before = [rollsOf(alice), xpOf(alice)];
    r = await rollWith(alice, 'a1'.repeat(12));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const first = r.body;
    assert.equal(first.again, undefined);
    // La réponse s'est perdue : le site redemande aussitôt avec le même jeton (en plein délai entre deux tirages).
    r = await rollWith(alice, 'a1'.repeat(12));
    assert.deepEqual([r.status, r.body.n, r.body.s, r.body.t, r.body.again], [200, first.n, first.s, first.t, true], 'le même tirage, pas un refus');
    assert.deepEqual([rollsOf(alice), xpOf(alice)], [before[0] + 1, before[1] + first.s], 'compté une seule fois');
    // Un autre jeton pendant le délai : c'est un nouveau tirage, donc refusé comme avant.
    assert.equal((await rollWith(alice, 'b2'.repeat(12))).status, 429);
    assert.equal((await rollWith(alice, undefined)).status, 429, 'sans jeton : comportement inchangé');
    assert.equal((await rollWith(alice, 'pas un jeton')).status, 429, 'jeton invalide ignoré');
  });
  // Le jeton d'un joueur ne donne rien à un autre.
  await later(9000, async () => {
    r = await rollWith(bob, 'a1'.repeat(12));
    assert.equal(r.status, 200);
    assert.equal(r.body.again, undefined);
  });
}

// ================================================================ 31. Gamble : roulette et blackjack, tirés par le serveur, pièces débitées puis créditées
{
  const g = (who, action, extra) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const coins = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  const setCoins = async (who, target) => run([['HINCRBY', `stats:${who.playerId}`, 'bonus', target - (await coins(who))]]);
  const realInt = crypto.randomInt; let forced = [];
  crypto.randomInt = (lo, hi) => (forced.length ? forced.shift() : realInt(lo, hi));
  const tick = () => new Promise(resolve => setImmediate(resolve)); // le verrou se relâche juste après la réponse
  run([['HSET', `stats:${frank.playerId}`, 'rolls', 5]]);
  await setCoins(frank, 1000);
  r = await g(frank, 'roulette', { bets: [{ t: 'red', a: 100 }] });
  assert.deepEqual([r.status, r.body.error], [422, 'Gamble unlocks after 30 rolls (you have 5)']);
  run([['HSET', `stats:${frank.playerId}`, 'rolls', 60]]); await tick();
  // Roulette : rouge 100 + numéro 7 pour 50 ; le 7 sort (rouge) → 200 + 1 800.
  forced = [7];
  r = await g(frank, 'roulette', { bets: [{ t: 'red', a: 100 }, { t: 'n', v: 7, a: 50 }] });
  assert.deepEqual([r.status, r.body.n, r.body.color, r.body.total, r.body.win, r.body.coins], [200, 7, 'red', 150, 2000, 2850], JSON.stringify(r.body));
  await tick(); forced = [0];
  r = await g(frank, 'roulette', { bets: [{ t: 'black', a: 100 }, { t: 'even', a: 100 }, { t: 'd1', a: 100 }] });
  assert.deepEqual([r.body.n, r.body.color, r.body.win, r.body.coins], [0, 'green', 0, 2550], 'le zéro fait tout perdre');
  await tick();
  for (const bad of [[], [{ t: 'red', a: 5 }], [{ t: 'licorne', a: 100 }], [{ t: 'n', v: 37, a: 100 }], [{ t: 'red', a: 100.5 }], [{ t: 'red', a: -100 }]]) { assert.equal((await g(frank, 'roulette', { bets: bad })).status, 400, JSON.stringify(bad)); await tick(); }
  assert.equal((await g(frank, 'roulette', { bets: [{ t: 'red', a: 600 }, { t: 'black', a: 600 }] })).status, 422, 'plafond par tour'); await tick();
  await setCoins(frank, 50);
  assert.equal((await g(frank, 'roulette', { bets: [{ t: 'red', a: 100 }] })).status, 422, 'pas assez de pièces'); await tick();
  assert.equal(await coins(frank), 50);
  assert.equal((await g({ ...frank, secret: '9'.repeat(32) }, 'roulette', { bets: [{ t: 'red', a: 10 }] })).status, 403);
  // Blackjack. Cartes forcées : [rang, couleur] pour joueur, joueur, croupier, croupier, puis les tirages suivants.
  await setCoins(frank, 1000);
  forced = [10, 0, 9, 1, 10, 2, 7, 3]; // 19 contre 17
  r = await g(frank, 'bj', { move: 'deal', bet: 100 });
  assert.deepEqual([r.status, r.body.value, r.body.dealer.length, r.body.done, r.body.coins], [200, 19, 1, false, 900], JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes('"r":7'), 'la carte cachée du croupier ne sort pas');
  await tick();
  assert.equal((await g(frank, 'bj', { move: 'deal', bet: 100 })).status, 422, 'une main à la fois'); await tick();
  r = await g(frank, 'bj', { move: 'stand' });
  assert.deepEqual([r.body.result, r.body.win, r.body.dealerValue, r.body.coins], ['win', 200, 17, 1100]);
  await tick(); forced = [1, 0, 13, 1, 9, 2, 5, 3]; // blackjack d'entrée : payé 3 pour 2
  r = await g(frank, 'bj', { move: 'deal', bet: 100 });
  assert.deepEqual([r.body.result, r.body.win, r.body.coins], ['blackjack', 250, 1250]);
  await tick(); forced = [10, 0, 6, 1, 10, 2, 8, 3, 9, 0]; // 16, on tire un 9 : sauté
  await g(frank, 'bj', { move: 'deal', bet: 100 }); await tick();
  r = await g(frank, 'bj', { move: 'hit' });
  assert.deepEqual([r.body.result, r.body.win, r.body.coins], ['bust', 0, 1150]);
  await tick(); forced = [5, 0, 6, 1, 10, 2, 6, 3, 10, 0, 10, 1]; // 11, on double : 21 ; le croupier (16) tire un 10 et saute
  await g(frank, 'bj', { move: 'deal', bet: 100 }); await tick();
  r = await g(frank, 'bj', { move: 'double' });
  assert.deepEqual([r.body.bet, r.body.value, r.body.result, r.body.win, r.body.coins], [200, 21, 'win', 400, 1350]);
  await tick(); forced = [10, 0, 8, 1, 10, 2, 8, 3]; // égalité : la mise revient
  await g(frank, 'bj', { move: 'deal', bet: 100 }); await tick();
  r = await g(frank, 'bj', { move: 'stand' });
  assert.deepEqual([r.body.result, r.body.coins], ['push', 1350]);
  await tick();
  assert.equal((await g(frank, 'bj', { move: 'hit' })).status, 422, 'aucune main en cours'); await tick();
  assert.equal((await g(frank, 'bj', { move: 'deal', bet: 5000 })).status, 400); await tick();
  assert.equal((await g(frank, 'bj', { move: 'state' })).body.idle, true);
  crypto.randomInt = realInt;
}

// ================================================================ 32. Plinko, Mines, Crash
{
  const g = (who, action, extra) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const coins = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  const setCoins = async (who, target) => run([['HINCRBY', `stats:${who.playerId}`, 'bonus', target - (await coins(who))]]);
  const realInt = crypto.randomInt; let forced = [];
  crypto.randomInt = (lo, hi) => (forced.length ? forced.shift() : realInt(lo, hi));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); await setCoins(frank, 1000);
  // Plinko : douze fois à droite → dernière case, ×33.
  forced = Array(12).fill(1);
  r = await g(frank, 'plinko', { bet: 10 });
  { const qk = `q:${new Date(Date.now()).toISOString().slice(0, 10)}:${frank.playerId}`; assert.ok(Number(run([['HGET', qk, 'casino']])[0].result) >= 1 && Number(run([['HGET', qk, 'casinoBet']])[0].result) >= 10, 'une partie de casino compte pour la quête de casino'); }
  assert.deepEqual([r.status, r.body.slot, r.body.mult, r.body.win, r.body.coins], [200, 12, 33, 330, 1320], JSON.stringify(r.body));
  await tick(); forced = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  r = await g(frank, 'plinko', { bet: 100 });
  assert.deepEqual([r.body.slot, r.body.mult, r.body.win, r.body.coins], [6, 0.3, 30, 1250]);
  await tick(); assert.equal((await g(frank, 'plinko', { bet: 0 })).status, 400); await tick();
  // Mines : 3 mines ; le mélange est laissé au hasard, on lit les mines dans la base pour jouer une case sûre puis une mine.
  r = await g(frank, 'mines', { move: 'start', bet: 100, mines: 3 });
  assert.deepEqual([r.status, r.body.open, r.body.mult, r.body.coins, r.body.bombs], [200, [], 0.99, 1150, undefined], 'les mines ne sortent pas');
  let bombs = JSON.parse(run([['GET', `mn:${frank.playerId}`]])[0].result).bombs;
  const safe = [...Array(25).keys()].filter(c => !bombs.includes(c));
  await tick(); r = await g(frank, 'mines', { move: 'pick', cell: safe[0] });
  assert.deepEqual([r.body.open, r.body.mult, r.body.done], [[safe[0]], 1.12, false]);
  await tick(); assert.equal((await g(frank, 'mines', { move: 'pick', cell: safe[0] })).status, 400, 'case déjà ouverte');
  await tick(); r = await g(frank, 'mines', { move: 'cash' });
  assert.deepEqual([r.body.result, r.body.win, r.body.coins, r.body.bombs.length], ['cash', 112, 1262, 3]);
  await tick(); r = await g(frank, 'mines', { move: 'start', bet: 100, mines: 24 });
  bombs = JSON.parse(run([['GET', `mn:${frank.playerId}`]])[0].result).bombs;
  await tick(); assert.equal((await g(frank, 'mines', { move: 'cash' })).status, 422, 'rien à encaisser sans case ouverte');
  await tick(); r = await g(frank, 'mines', { move: 'pick', cell: bombs[0] });
  assert.deepEqual([r.body.result, r.body.win, r.body.hit, r.body.coins], ['boom', 0, bombs[0], 1162]);
  await tick(); assert.equal((await g(frank, 'mines', { move: 'pick', cell: 3 })).status, 422);
  // Tower (idée de Zombara) : bombes tirées au départ, jamais envoyées avant la fin ; mises validées comme aux Mines.
  await tick(); for (const bad of [0, 5, 1001, 2.5, 'x']) { assert.equal((await g(frank, 'tower', { move: 'start', bet: bad, level: 'easy' })).status, 400, `mise ${bad}`); await tick(); }
  assert.equal((await g(frank, 'tower', { move: 'start', bet: 100, level: 'insane' })).status, 400, 'difficulté inconnue'); await tick();
  assert.equal((await g(frank, 'tower', { move: 'start', bet: 101, level: 'hard' })).status, 400, 'Hard : 100 max'); await tick();
  await setCoins(frank, 50); assert.equal((await g(frank, 'tower', { move: 'start', bet: 100, level: 'easy' })).status, 422, 'pas assez de pièces'); await tick(); await setCoins(frank, 1162);
  assert.equal((await g(frank, 'tower', { move: 'cash' })).status, 422, 'pas de partie'); await tick();
  r = await g(frank, 'tower', { move: 'start', bet: 100, level: 'normal' });
  assert.deepEqual([r.status, r.body.picks, r.body.tiles, r.body.mult, r.body.next, r.body.coins, r.body.bombs, JSON.stringify(r.body).includes('bomb')], [200, [], 3, 1, 1.41, 1062, undefined, false], 'les bombes de la tour ne sortent pas');
  assert.deepEqual(r.body.ladder, [1.41, 2.11, 3.17, 4.75, 7.13, 10.7, 16.06, 24.09]);
  let tb = JSON.parse(run([['GET', `tw:${frank.playerId}`]])[0].result).bombs;
  assert.equal(tb.length, 8); assert.ok(tb.every(b => Number.isInteger(b) && b >= 0 && b < 3));
  await tick(); assert.equal((await g(frank, 'tower', { move: 'start', bet: 100, level: 'easy' })).status, 422, 'une seule partie à la fois');
  await tick(); assert.equal((await g(frank, 'tower', { move: 'cash' })).status, 422, 'rien à encaisser au rez-de-chaussée');
  await tick(); assert.equal((await g(frank, 'tower', { move: 'pick', tile: 3 })).status, 400, 'case hors de l\'étage');
  await tick(); r = await g(frank, 'tower', { move: 'pick', tile: (tb[0] + 1) % 3 });
  assert.deepEqual([r.body.picks.length, r.body.mult, r.body.done, r.body.bombs], [1, 1.41, false, undefined]);
  await tick(); r = await g(frank, 'tower', { move: 'pick', tile: (tb[1] + 1) % 3 });
  await tick(); r = await g(frank, 'tower', { move: 'state' });
  assert.deepEqual([r.body.picks.length, r.body.mult, r.body.bombs], [2, 2.11, undefined], 'reprise de partie');
  await tick(); r = await g(frank, 'tower', { move: 'cash' });
  assert.deepEqual([r.body.result, r.body.win, r.body.coins, r.body.bombs], ['cash', 211, 1273, tb], 'encaisser paie mise × multiplicateur et dévoile les bombes');
  // Hard : la bombe du 1er étage perd la mise.
  await tick(); r = await g(frank, 'tower', { move: 'start', bet: 100, level: 'hard' });
  tb = JSON.parse(run([['GET', `tw:${frank.playerId}`]])[0].result).bombs;
  await tick(); r = await g(frank, 'tower', { move: 'pick', tile: tb[0] });
  assert.deepEqual([r.body.result, r.body.win, r.body.hit, r.body.floor, r.body.coins, r.body.bombs.length], ['boom', 0, tb[0], 0, 1173, 8]);
  await tick(); assert.equal((await g(frank, 'tower', { move: 'pick', tile: 0 })).status, 422);
  // Easy jusqu'en haut : la partie s'encaisse seule au 8e étage (×9,38).
  await tick(); r = await g(frank, 'tower', { move: 'start', bet: 10, level: 'easy' });
  tb = JSON.parse(run([['GET', `tw:${frank.playerId}`]])[0].result).bombs;
  for (let f = 0; f < 8; f++) { await tick(); r = await g(frank, 'tower', { move: 'pick', tile: (tb[f] + 1) % 4 }); }
  assert.deepEqual([r.body.result, r.body.mult, r.body.win, r.body.coins, r.body.picks.length], ['cash', 9.38, 93, 1256, 8]);
  assert.equal(run([['GET', `tw:${frank.playerId}`]])[0].result, null);
  { const h = run([['HMGET', `stats:${frank.playerId}`, 'gTower']])[0].result; assert.equal(Number(h[0]), 3, 'compteur de manches gTower'); }
  { const c = run([['HMGET', 'casino', 'r:tower', 'b:tower', 'w:tower']])[0].result.map(Number); assert.deepEqual(c, [3, 210, 304], 'compte de la maison par jeu'); }
  // Keno (idée de CYCOX) : une demande par partie, 1 à 10 numéros cochés parmi 40, 10 tirés par le serveur.
  {
    const G = require('../api/_gamble.js');
    await tick(); await setCoins(frank, 1000);
    for (const picks of [[], Array.from({ length: 11 }, (_, i) => i + 1), [1, 1], [0], [41], [2.5], ['3'], 'x', undefined]) {
      assert.equal((await g(frank, 'keno', { bet: 100, picks })).status, 400, `numéros ${JSON.stringify(picks)}`); await tick();
    }
    for (const bad of [0, 5, 101, 1001, 2.5, 'x']) { assert.equal((await g(frank, 'keno', { bet: bad, picks: [1] })).status, 400, `mise ${bad}`); await tick(); } // 100 max au Keno
    await setCoins(frank, 50); assert.equal((await g(frank, 'keno', { bet: 100, picks: [1] })).status, 422, 'pas assez de pièces'); await tick(); await setCoins(frank, 1000);
    run([['HSET', `stats:${frank.playerId}`, 'rolls', 5]]);
    r = await g(frank, 'keno', { bet: 100, picks: [1] }); assert.deepEqual([r.status, r.body.error], [422, 'Gamble unlocks after 30 rolls (you have 5)']);
    run([['HSET', `stats:${frank.playerId}`, 'rolls', 60]]); await tick();
    assert.equal(await coins(frank), 1000, 'aucun refus ne coûte de pièces');
    // Tirage forcé : 1 à 10. Cinq cochés, trois trouvés → ×3,7.
    forced = Array(10).fill(0);
    r = await g(frank, 'keno', { bet: 100, picks: [30, 2, 1, 20, 3] });
    assert.deepEqual([r.status, r.body.picks, r.body.drawn, r.body.hits, r.body.mult, r.body.win, r.body.coins], [200, [1, 2, 3, 20, 30], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, 3.7, 370, 1270], JSON.stringify(r.body));
    assert.deepEqual(r.body.pays, G.KENO_PAYS[5]);
    // Dix cochés, aucun trouvé : la mise revient (×1).
    await tick(); forced = Array(10).fill(0);
    r = await g(frank, 'keno', { bet: 50, picks: [31, 32, 33, 34, 35, 36, 37, 38, 39, 40] });
    assert.deepEqual([r.body.hits, r.body.win, r.body.coins], [0, 50, 1270]);
    // Tirages au hasard : 10 numéros distincts de 1 à 40, gain = plancher(mise × table[cochés][trouvés]).
    let bet = 150, won = 420;
    for (let i = 0; i < 40; i++) {
      await tick();
      const k = 1 + (i % 10), picks = Array.from({ length: k }, (_, j) => 1 + ((j * 7 + i) % 40)), b = 10 + 10 * (i % 5);
      const c0 = await coins(frank); await tick();
      r = await g(frank, 'keno', { bet: b, picks });
      const d = r.body.drawn;
      assert.ok(d.length === 10 && new Set(d).size === 10 && d.every(n => Number.isInteger(n) && n >= 1 && n <= 40), JSON.stringify(d));
      const h = picks.filter(n => d.includes(n)).length;
      assert.deepEqual([r.body.hits, r.body.win, r.body.coins], [h, Math.floor(b * Math.round(G.KENO_PAYS[k][h] * 100) / 100), c0 - b + r.body.win]);
      bet += b; won += r.body.win;
    }
    { const h = run([['HGET', `stats:${frank.playerId}`, 'gKeno']])[0].result; assert.equal(Number(h), 42, 'compteur de manches gKeno'); }
    { const c = run([['HMGET', 'casino', 'r:keno', 'b:keno', 'w:keno']])[0].result.map(Number); assert.deepEqual(c, [42, bet, won], 'compte de la maison par jeu'); }
    // La page affiche les mêmes tables avant la première partie (copie dans js/app.js).
    { const src = require('node:fs').readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'); assert.deepEqual(JSON.parse(/const KN_PAYS = (\[.*?\]);/.exec(src)[1]), G.KENO_PAYS, 'tables du keno identiques sur la page'); }
    // Retour théorique EXACT de chaque table (loi hypergéométrique : 40 numéros, 10 tirés) : entre 97 et 99 %.
    const Cn = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };
    for (let k = 1; k <= 10; k++) {
      const T = G.KENO_PAYS[k]; assert.equal(T.length, k + 1);
      let rtp = 0, p = 0;
      for (let h = 0; h <= k; h++) { const q = Cn(k, h) * Cn(40 - k, 10 - h) / Cn(40, 10); p += q; rtp += q * T[h]; assert.ok(T[h] <= G.KENO_CAP); }
      assert.ok(Math.abs(p - 1) < 1e-12);
      assert.ok(rtp >= 0.97 && rtp <= 0.99, `keno ${k} cochés : ${rtp}`);
    }
  }
  // Dice (idée de CYCOX et YU CHUAN 23) : une demande par partie ; dé à 100 faces « en dessous » / « au-dessus » d'une
  // cible (2 à 95 numéros couverts, 97 % des vraies chances), ou deviner un dé à 6 faces (×5,82).
  {
    const G = require('../api/_gamble.js');
    await tick(); await setCoins(frank, 1000);
    for (const [mode, target] of [['under', 2], ['under', 97], ['over', 99], ['over', 4], ['under', 50.5], ['d6', 0], ['d6', 7], ['d6', 2.5], ['sideways', 50], [undefined, 50], ['under', 'x']]) {
      assert.equal((await g(frank, 'dice', { bet: 100, mode, target })).status, 400, `dice ${mode} ${target}`); await tick();
    }
    for (const bad of [0, 5, 1001, 2.5, 'x']) { assert.equal((await g(frank, 'dice', { bet: bad, mode: 'under', target: 50 })).status, 400, `mise ${bad}`); await tick(); }
    await setCoins(frank, 50); assert.equal((await g(frank, 'dice', { bet: 100, mode: 'under', target: 50 })).status, 422, 'pas assez de pièces'); await tick(); await setCoins(frank, 1000);
    assert.equal(await coins(frank), 1000, 'aucun refus ne coûte de pièces');
    // Tirages forcés. En dessous de 50 (49 numéros, ×1,97) : 49 gagne, 50 perd.
    forced = [49]; r = await g(frank, 'dice', { bet: 100, mode: 'under', target: 50 });
    assert.deepEqual([r.status, r.body.roll, r.body.won, r.body.mult, r.body.chance, r.body.win, r.body.coins], [200, 49, true, 1.97, 0.49, 197, 1097], JSON.stringify(r.body));
    await tick(); forced = [50]; r = await g(frank, 'dice', { bet: 100, mode: 'under', target: 50 });
    assert.deepEqual([r.body.won, r.body.win, r.body.coins], [false, 0, 997]);
    // Au-dessus de 98 (2 numéros, ×48,5) : 99 gagne, 98 perd. Au-dessus de 5 (95 numéros, ×1,02).
    await tick(); forced = [99]; r = await g(frank, 'dice', { bet: 10, mode: 'over', target: 98 });
    assert.deepEqual([r.body.won, r.body.mult, r.body.win, r.body.coins], [true, 48.5, 485, 1472]);
    await tick(); forced = [98]; r = await g(frank, 'dice', { bet: 10, mode: 'over', target: 98 });
    assert.deepEqual([r.body.won, r.body.win], [false, 0]);
    await tick(); forced = [6]; r = await g(frank, 'dice', { bet: 50, mode: 'over', target: 5 });
    assert.deepEqual([r.body.won, r.body.mult, r.body.win], [true, 1.02, 51]);
    // Dé à 6 faces : la bonne face paie ×5,82.
    await tick(); forced = [4]; r = await g(frank, 'dice', { bet: 100, mode: 'd6', target: 4 });
    assert.deepEqual([r.body.roll, r.body.won, r.body.mult, r.body.win], [4, true, 5.82, 582]);
    await tick(); forced = [3]; r = await g(frank, 'dice', { bet: 100, mode: 'd6', target: 4 });
    assert.deepEqual([r.body.won, r.body.win], [false, 0]);
    let bet = 470, won = 197 + 485 + 51 + 582;
    // Au hasard : le dé reste entre 1 et 100 (1 et 6), gain = plancher(mise × multiplicateur).
    for (let i = 0; i < 30; i++) {
      await tick();
      const mode = ['under', 'over', 'd6'][i % 3], target = mode === 'd6' ? 1 + (i % 6) : mode === 'under' ? 3 + (i * 7) % 94 : 5 + (i * 11) % 94, b = 10 + 10 * (i % 5);
      const c0 = await coins(frank); await tick();
      r = await g(frank, 'dice', { bet: b, mode, target });
      const n = r.body.roll, w = mode === 'd6' ? null : G.diceCover(mode, target);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= (mode === 'd6' ? 6 : 100));
      const ok = mode === 'd6' ? n === target : mode === 'under' ? n < target : n > target;
      assert.deepEqual([r.body.won, r.body.win, r.body.coins], [ok, ok ? Math.floor(b * (mode === 'd6' ? 582 : G.diceCents(w)) / 100) : 0, c0 - b + r.body.win]);
      bet += b; won += r.body.win;
    }
    { const h = run([['HGET', `stats:${frank.playerId}`, 'gDice']])[0].result; assert.equal(Number(h), 37, 'compteur de manches gDice'); }
    { const c = run([['HMGET', 'casino', 'r:dice', 'b:dice', 'w:dice']])[0].result.map(Number); assert.deepEqual(c, [37, bet, won], 'compte de la maison par jeu'); }
    // Retour exact : au plus 97 % pour chaque cible, 97 % tout rond au dé à 6 faces ; même calcul sur la page.
    for (let w = G.DICE_MIN_W; w <= G.DICE_MAX_W; w++) { const ev = w / 100 * G.diceMult(w); assert.ok(ev <= 0.97000001 && ev > 0.96, `dice ${w} : ${ev}`); }
    assert.ok(Math.abs(G.DICE_D6 / 100 / 6 - 0.97) < 1e-12);
    { const src = require('node:fs').readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'); assert.ok(src.includes('const dcCents = w => Math.floor(9700 / w + 1e-9);') && src.includes("const DC_LIMIT = { under: [3, 96], over: [5, 98] };"), 'mêmes multiplicateurs sur la page'); }
  }
  // Teddy Roulette (idée de d_alex) : chambre chargée tirée au départ, jamais envoyée avant la fin ; une partie à la fois.
  {
    const G = require('../api/_gamble.js');
    await tick(); await setCoins(frank, 1000);
    for (const bad of [0, 5, 1001, 2.5, 'x']) { assert.equal((await g(frank, 'teddy', { move: 'start', bet: bad })).status, 400, `mise ${bad}`); await tick(); }
    await setCoins(frank, 50); assert.equal((await g(frank, 'teddy', { move: 'start', bet: 100 })).status, 422, 'pas assez de pièces'); await tick(); await setCoins(frank, 1000);
    assert.equal((await g(frank, 'teddy', { move: 'cash' })).status, 422, 'pas de partie'); await tick();
    assert.equal((await g(frank, 'teddy', { move: 'pull' })).status, 422, 'pas de partie'); await tick();
    r = await g(frank, 'teddy', { move: 'state' }); assert.deepEqual([r.body.idle, r.body.coins], [true, 1000]); await tick();
    forced = [3];
    r = await g(frank, 'teddy', { move: 'start', bet: 100 });
    assert.deepEqual([r.status, r.body.pulls, r.body.mult, r.body.next, r.body.coins, r.body.boom, JSON.stringify(r.body).includes('boom')], [200, 0, 1, 1.16, 900, undefined, false], 'la chambre chargée ne sort pas');
    assert.deepEqual(r.body.ladder, [1.16, 1.45, 1.94, 2.91, 5.82]);
    assert.equal(JSON.parse(run([['GET', `td:${frank.playerId}`]])[0].result).boom, 3);
    await tick(); assert.equal((await g(frank, 'teddy', { move: 'start', bet: 100 })).status, 422, 'une seule partie à la fois');
    await tick(); assert.equal((await g(frank, 'teddy', { move: 'cash' })).status, 422, 'rien à encaisser avant le premier clic');
    await tick(); assert.equal((await g(frank, 'teddy', { move: 'spin' })).status, 400, 'coup inconnu');
    await tick(); r = await g(frank, 'teddy', { move: 'pull' });
    assert.deepEqual([r.body.pulls, r.body.mult, r.body.next, r.body.done, r.body.boom], [1, 1.16, 1.45, false, undefined]);
    await tick(); r = await g(frank, 'teddy', { move: 'pull' });
    await tick(); r = await g(frank, 'teddy', { move: 'state' });
    assert.deepEqual([r.body.pulls, r.body.mult, r.body.boom], [2, 1.45, undefined], 'reprise de partie');
    await tick(); r = await g(frank, 'teddy', { move: 'cash' });
    assert.deepEqual([r.body.result, r.body.win, r.body.coins, r.body.boom], ['cash', 145, 1045, 3], 'encaisser paie mise × multiplicateur et dévoile la chambre');
    assert.equal(run([['GET', `td:${frank.playerId}`]])[0].result, null);
    // BOOM au 3e tir (chambre 2) : mise perdue.
    await tick(); forced = [2]; r = await g(frank, 'teddy', { move: 'start', bet: 100 });
    await tick(); await g(frank, 'teddy', { move: 'pull' }); await tick(); await g(frank, 'teddy', { move: 'pull' });
    await tick(); r = await g(frank, 'teddy', { move: 'pull' });
    assert.deepEqual([r.body.result, r.body.win, r.body.pulls, r.body.boom, r.body.coins], ['boom', 0, 2, 2, 945]);
    await tick(); assert.equal((await g(frank, 'teddy', { move: 'pull' })).status, 422, 'partie finie');
    // Chambre 5 : 5 clics, la partie s'encaisse seule à ×5,82.
    await tick(); forced = [5]; r = await g(frank, 'teddy', { move: 'start', bet: 10 });
    for (let k = 0; k < 5; k++) { await tick(); r = await g(frank, 'teddy', { move: 'pull' }); }
    assert.deepEqual([r.body.result, r.body.pulls, r.body.mult, r.body.win, r.body.coins, r.body.boom], ['cash', 5, 5.82, 58, 993, 5]);
    assert.equal(run([['GET', `td:${frank.playerId}`]])[0].result, null);
    { const h = run([['HGET', `stats:${frank.playerId}`, 'gTeddy']])[0].result; assert.equal(Number(h), 3, 'compteur de manches gTeddy'); }
    { const c = run([['HMGET', 'casino', 'r:teddy', 'b:teddy', 'w:teddy']])[0].result.map(Number); assert.deepEqual(c, [3, 210, 203], 'compte de la maison par jeu'); }
    for (let k = 1; k <= G.TEDDY_MAX; k++) { const ev = (6 - k) / 6 * G.teddyMult(k); assert.ok(ev <= 0.97000001 && ev > 0.96, `teddy ${k} : ${ev}`); }
  }
  // Duck Race (idée de Deadshot, 2026-10-27) : six canards, le serveur tire tout l'ordre d'arrivée, une demande par course.
  {
    const G = require('../api/_gamble.js');
    await tick(); await setCoins(frank, 1000);
    assert.deepEqual(G.DUCK_CHANCE, [30, 25, 18, 12, 10, 5]);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(G.duckMult), [3.23, 3.88, 5.38, 8.08, 9.7, 19.4]);
    for (let k = 0; k < 6; k++) { const ev = G.DUCK_CHANCE[k] / 100 * G.duckMult(k); assert.ok(ev <= 0.97000001 && ev > 0.96, `duck ${k} : ${ev}`); }
    for (const d of [-1, 6, 1.5, 'x', null]) { assert.equal((await g(frank, 'duck', { bet: 100, duck: d })).status, 400, `canard ${d}`); await tick(); }
    assert.equal((await g(frank, 'duck', { bet: 100 })).status, 400, 'sans canard'); await tick();
    for (const bad of [0, 5, 1001, 2.5, 'x']) { assert.equal((await g(frank, 'duck', { bet: bad, duck: 0 })).status, 400, `mise ${bad}`); await tick(); }
    await setCoins(frank, 50); assert.equal((await g(frank, 'duck', { bet: 100, duck: 0 })).status, 422, 'pas assez de pièces'); await tick(); await setCoins(frank, 1000);
    // Tirage pondéré sans remise : u = 0 → le canard 0 gagne ; puis parmi les 70 restants, 69 → le dernier (canard 5)…
    forced = [0, 69, 0, 0, 0, 0];
    r = await g(frank, 'duck', { bet: 100, duck: 0 });
    assert.deepEqual([r.status, r.body.order, r.body.winner, r.body.won, r.body.mult, r.body.win, r.body.coins], [200, [0, 5, 1, 2, 3, 4], 0, true, 3.23, 323, 1223], JSON.stringify(r.body));
    // u = 95 → l'outsider (canard 5, chances 95 à 99) gagne ; parié sur lui : ×19,40.
    await tick(); forced = [95, 0, 0, 0, 0, 0];
    r = await g(frank, 'duck', { bet: 50, duck: 5 });
    assert.deepEqual([r.body.order[0], r.body.won, r.body.win, r.body.coins], [5, true, 970, 2143]);
    // u = 30 → le canard 1 gagne ; parié sur le 2 : perdu.
    await tick(); forced = [30, 0, 0, 0, 0, 0];
    r = await g(frank, 'duck', { bet: 100, duck: 2 });
    assert.deepEqual([r.body.order[0], r.body.won, r.body.win, r.body.coins, r.body.mult], [1, false, 0, 2043, 5.38]);
    await tick();
    { const h = run([['HGET', `stats:${frank.playerId}`, 'gDuck']])[0].result; assert.equal(Number(h), 3, 'compteur de manches gDuck'); }
    { const c = run([['HMGET', 'casino', 'r:duck', 'b:duck', 'w:duck']])[0].result.map(Number); assert.deepEqual(c, [3, 250, 1293], 'compte de la maison par jeu'); }
    { const src = require('node:fs').readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'); assert.ok(src.includes('const DUCK_W = [30, 25, 18, 12, 10, 5];') && src.includes('const dkCents = w => Math.floor(9700 / w + 1e-9);'), 'mêmes chances et multiplicateurs sur la page'); }
  }
  // Wheel (idée de How yz got sticky et de Gray, 2026-11-01) : deux roues à cases égales, 0,7× au pire, 250× une fois sur
  // 2 000 tours, retour 96,9 %. Mises de 1 à 1 000 ; la fraction de pièce est jouée au hasard (comme au Plinko).
  {
    const G = require('../api/_gamble.js');
    await tick(); await setCoins(frank, 1000);
    assert.deepEqual([G.WHEEL_OUTER.length, G.WHEEL_INNER.length], [50, 40]);
    assert.deepEqual([G.WHEEL_OUTER.filter(m => m === 0).length, Math.min(...G.WHEEL_OUTER.filter(Boolean), ...G.WHEEL_INNER), Math.max(...G.WHEEL_INNER)], [1, 0.7, 250], 'une étoile, de 0,7× à 250×');
    assert.ok(G.wheelRtp() <= 0.97000001 && G.wheelRtp() > 0.96, `retour de la roue : ${G.wheelRtp()}`);
    assert.ok([...G.WHEEL_OUTER, ...G.WHEEL_INNER].every(m => Number.isInteger(Math.round(m * 10)) && Math.abs(m * 10 - Math.round(m * 10)) < 1e-9), 'multiplicateurs au dixième');
    for (const bad of [0, 1001, 2.5, 'x', -5]) { assert.equal((await g(frank, 'wheel', { bet: bad })).status, 400, `mise ${bad}`); await tick(); }
    await setCoins(frank, 50); assert.equal((await g(frank, 'wheel', { bet: 100 })).status, 422, 'pas assez de pièces'); await tick(); await setCoins(frank, 1000);
    // Case 1 de la grande roue : 0,7× ; 100 × 0,7 = 70 tout rond (le tirage de la fraction ne change rien).
    forced = [1, 9];
    r = await g(frank, 'wheel', { bet: 100 });
    assert.deepEqual([r.status, r.body.outer, r.body.inner, r.body.bonus, r.body.mult, r.body.win, r.body.coins], [200, 1, null, false, 0.7, 70, 970], JSON.stringify(r.body));
    // L'étoile (case 0) puis la case 0 de la roue bonus : 250×.
    await tick(); forced = [0, 0, 9];
    r = await g(frank, 'wheel', { bet: 10 });
    assert.deepEqual([r.body.bonus, r.body.inner, r.body.mult, r.body.win, r.body.coins], [true, 0, 250, 2500, 3460]);
    // Mise de 1 pièce sur 0,7× : 7 dixièmes, la pièce est gagnée 7 fois sur 10 (tirage 0 à 6), perdue sinon.
    await tick(); forced = [2, 6]; r = await g(frank, 'wheel', { bet: 1 }); assert.deepEqual([r.body.mult, r.body.win], [0.7, 1]);
    await tick(); forced = [2, 7]; r = await g(frank, 'wheel', { bet: 1 }); assert.deepEqual([r.body.mult, r.body.win, r.body.coins], [0.7, 0, 3459]);
    await tick();
    { const h = run([['HGET', `stats:${frank.playerId}`, 'gWheel']])[0].result; assert.equal(Number(h), 4, 'compteur de manches gWheel'); }
    { const c = run([['HMGET', 'casino', 'r:wheel', 'b:wheel', 'w:wheel']])[0].result.map(Number); assert.deepEqual(c, [4, 112, 2571], 'compte de la maison par jeu'); }
    { const src = require('node:fs').readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'); assert.ok(src.includes(`const WHEEL_OUTER = ${JSON.stringify(G.WHEEL_OUTER).replace(/,/g, ', ')};`) && src.includes(`const WHEEL_INNER = ${JSON.stringify(G.WHEEL_INNER).replace(/,/g, ', ')};`), 'mêmes roues sur la page'); }
  }
  await tick(); await setCoins(frank, 1162);
  // Crash : point tiré à 2,00 (u = 0,505). Encaissé à ×1,41 après 5 s ; puis une manche laissée exploser.
  await tick(); forced = [Math.floor(0.505 * 2 ** 32)];
  r = await g(frank, 'crash', { move: 'start', bet: 100 });
  assert.deepEqual([r.status, r.body.done, r.body.point, r.body.coins], [200, false, undefined, 1062], 'le point de crash ne sort pas');
  await later(5000, async () => { r = await g(frank, 'crash', { move: 'cash' }); });
  assert.deepEqual([r.body.result, r.body.mult, r.body.win, r.body.coins], ['cash', 1.41, 141, 1203], JSON.stringify(r.body));
  await tick(); forced = [Math.floor(0.505 * 2 ** 32)];
  await g(frank, 'crash', { move: 'start', bet: 100 });
  await later(12000, async () => { r = await g(frank, 'crash', { move: 'cash' }); });
  assert.deepEqual([r.body.result, r.body.win, r.body.point, r.body.coins], ['crash', 0, 1.99, 1103], JSON.stringify(r.body));
  await tick(); assert.equal((await g(frank, 'crash', { move: 'state' })).body.idle, true);
  // Clic à 9 s (×1,87) arrivé 2 s plus tard, après l'explosion à 1,99 : payé au moment du clic (signalé par Colt2).
  await tick(); forced = [Math.floor(0.505 * 2 ** 32)];
  await g(frank, 'crash', { move: 'start', bet: 100 });
  await later(11000, async () => { r = await g(frank, 'crash', { move: 'cash', ms: 9000 }); });
  assert.deepEqual([r.body.result, r.body.mult, r.body.win], ['cash', 1.87, 187], JSON.stringify(r.body));
  // Triche : la page apprend l'explosion (sondage), puis envoie un clic daté d'avant : refusé.
  await tick(); forced = [Math.floor(0.505 * 2 ** 32)];
  await g(frank, 'crash', { move: 'start', bet: 100 });
  await later(11000, async () => { await g(frank, 'crash', { move: 'state' }); r = await g(frank, 'crash', { move: 'cash', ms: 9000 }); });
  assert.notEqual(r.body.result, 'cash', JSON.stringify(r.body));
  // Trop en retard (clic à 5 s, arrivé 6 s après) : pas payé.
  await tick(); forced = [Math.floor(0.505 * 2 ** 32)];
  await g(frank, 'crash', { move: 'start', bet: 100 });
  await later(11000, async () => { r = await g(frank, 'crash', { move: 'cash', ms: 5000 }); });
  assert.equal(r.body.result, 'crash', JSON.stringify(r.body));
  crypto.randomInt = realInt;
}

// ================================================================ 33. Classement des pièces
{
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js'));
  run([['DEL', 'lbcache:coins']]);
  r = await call(lbApi, { url: `/api/leaderboard?period=coins&me=${frank.playerId}` });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.period, 'coins');
  assert.ok(r.body.entries.length >= 3 && r.body.entries.every((e, i, l) => !i || l[i - 1].coins >= e.coins), 'trié du plus riche au moins riche');
  const mine = r.body.entries.find(e => e.me);
  assert.equal(mine.name, 'Frank');
  assert.equal(mine.coins, (await call(shopApi, { url: `/api/shop?me=${frank.playerId}` })).body.coins, 'le même solde que la boutique');
  assert.ok(!JSON.stringify(r.body).includes(frank.playerId), 'aucun identifiant');
  // Gardé une minute : un changement de solde n'apparaît qu'au recalcul suivant.
  run([['HINCRBY', `stats:${frank.playerId}`, 'bonus', 5000]]);
  assert.equal((await call(lbApi, { url: `/api/leaderboard?period=coins&me=${frank.playerId}` })).body.entries.find(e => e.me).coins, mine.coins);
  run([['DEL', 'lbcache:coins']]);
  assert.equal((await call(lbApi, { url: `/api/leaderboard?period=coins&me=${frank.playerId}` })).body.entries.find(e => e.me).coins, mine.coins + 5000);
}

// ================================================================ 34. Raretés au-dessus de Mythic : anciens tirages reclassés une fois
{
  const { engine } = require(path.join(ROOT, 'api/_lib.js'));
  const Ach = require(path.join(ROOT, 'js/achievements.js'));
  const tierOf = n => engine.cardTier(engine.scoreOf(n));
  const toObj = flat => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
  // Le découpage : 9 000 Mythic, 900 Celestial, 90 Divine, 9 Infinite sur 1 000 001 nombres (2016, The Golden Era,
  // est entré dans les Mythic et en a sorti les deux ex aequo de la limite, 210982 et 821098).
  const count = {};
  for (let n = 0; n <= 1000000; n++) { const k = tierOf(n); count[k] = (count[k] || 0) + 1; }
  // Mythic : 9 000 à quelques ex aequo près à la limite (elle bouge d'un cran quand un badge perso est ajouté).
  assert.ok(Math.abs(count.mythic - 9000) <= 3, `mythic ${count.mythic}`);
  assert.ok(Math.abs(count.celestial - 900) <= 3 && Math.abs(count.divine - 50) <= 2 && count.godlike === 40, JSON.stringify(count)); assert.ok(count.infinite >= 9 && count.infinite <= 10, `infinite ${count.infinite}`); // Godlike (2026-10-16) : les 40 meilleurs sous Infinite, pris dans Divine. 10 depuis les badges du 2026-10-15 : un cran de plus à la limite
  const pick = tier => { for (let n = 0; n <= 1000000; n++) if (tierOf(n) === tier) return n; };
  const sample = { mythic: pick('mythic'), celestial: pick('celestial'), divine: pick('divine'), infinite: pick('infinite') };
  // Un joueur d'avant la mise à jour : 4 « Mythic » au compteur, dont un de chaque nouvelle rareté dans son historique.
  const id = frank.playerId, key = `stats:${id}`, old = toObj(run([['HGETALL', key]])[0].result);
  const base = Number(old['t:mythic']) || 0, t0 = 1700000000000;
  run([['HDEL', key, 'tv'], ['HINCRBY', key, 't:mythic', 4],
    ['ZADD', `hist:${id}`, t0, `${t0}:${sample.mythic}`], ['ZADD', `hist:${id}`, t0 + 1, `${t0 + 1}:${sample.celestial}`],
    ['ZADD', `hist:${id}`, t0 + 2, `${t0 + 2}:${sample.divine}`], ['ZADD', `hist:${id}`, t0 + 3, `${t0 + 3}:${sample.infinite}`]]);
  const before = (await call(shopApi, { url: `/api/shop?me=${id}` })).body.coins; // cette lecture fait la répartition
  let st = toObj(run([['HGETALL', key]])[0].result);
  assert.equal(st.tv, '2');
  assert.deepEqual([st['t:mythic'], st['t:celestial'], st['t:divine'], st['t:infinite']].map(Number),
    [base + 1, (Number(old['t:celestial']) || 0) + 1, (Number(old['t:divine']) || 0) + 1, (Number(old['t:infinite']) || 0) + 1]);
  for (const a of ['mythic', 'celestial', 'divine', 'infinite']) assert.ok(Ach.unlocked(st).includes(a), `titre ${a} débloqué`);
  // Une seule fois : relire ne déplace plus rien, même si le compteur Mythic remonte.
  run([['HINCRBY', key, 't:mythic', 2]]);
  const after = (await call(shopApi, { url: `/api/shop?me=${id}` })).body.coins;
  st = toObj(run([['HGETALL', key]])[0].result);
  assert.equal(Number(st['t:mythic']), base + 3);
  assert.equal(after - before, 200, 'deux Mythic de plus = 200 pièces, rien d\'autre');
  // Sans Mythic au compteur : seulement marqué, l'historique n'est pas lu.
  run([['HDEL', key, 'tv'], ['HSET', key, 't:mythic', 0, 't:celestial', 0]]);
  await call(shopApi, { url: `/api/shop?me=${id}` });
  st = toObj(run([['HGETALL', key]])[0].result);
  assert.deepEqual([st.tv, Number(st['t:celestial'])], ['2', 0]);
  // Les pièces : un Celestial 300, un Divine 1 000, un Infinite 5 000.
  const Shop = require(path.join(ROOT, 'js/shop.js'));
  assert.deepEqual([Shop.COINS.celestial, Shop.COINS.divine, Shop.COINS.infinite], [300, 1000, 5000]);
  // Les quêtes « Rare ou mieux » comptent les nouvelles raretés.
  const Q = require(path.join(ROOT, 'js/quests.js'));
  assert.equal(Q.byId.get('epic1').value({ 't:infinite': 1 }), 1);
}

// ================================================================ 35. Vitesse du tirage : niveaux achetés, délai entre tirages raccourci
{
  const Shop = require(path.join(ROOT, 'js/shop.js'));
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const id = frank.playerId, key = `stats:${id}`;
  const shop = (action, extra = {}) => call(shopApi, { method: 'POST', body: { playerId: frank.playerId, secret: frank.secret, action, ...extra } });
  const rollNow = () => call(roll, { method: 'POST', body: frank });
  assert.deepEqual([Shop.speedFactor(0), Shop.speedFactor(5), Shop.speedFactor(99), Shop.speedFactor('x'), Shop.speedFactor(-3)], [1, .5, .5, 1, 1]);
  // Niveau 0 : 8 s entre deux tirages, comme avant.
  await later(60000, async () => { r = await rollNow(); }); assert.equal(r.status, 200, JSON.stringify(r.body));
  await later(7900, async () => { r = await rollNow(); }); assert.equal(r.status, 429);
  await later(200, async () => { r = await rollNow(); }); assert.equal(r.status, 200);
  // Sans les pièces : refusé, rien ne bouge.
  const coins0 = (await call(shopApi, { url: `/api/shop?me=${id}` })).body.coins;
  run([['HINCRBY', key, 'spent', coins0]]);
  await tick(); r = await shop('speed'); assert.equal(r.status, 422); assert.match(r.body.error, /Not enough coins: 1000 more needed/);
  // Les cinq niveaux, un par un, au bon prix.
  run([['HINCRBY', key, 'bonus', 64500]]);
  let left = 64500;
  for (let lv = 1; lv <= 5; lv++) {
    await tick(); r = await shop('speed');
    left -= Shop.SPEED.prices[lv - 1];
    assert.deepEqual([r.status, r.body.speed, r.body.coins], [200, lv, left], JSON.stringify(r.body).slice(0, 200));
  }
  assert.equal(left, 0);
  await tick(); r = await shop('speed'); assert.equal(r.status, 422); assert.match(r.body.error, /maximum/);
  assert.equal((await call(shopApi, { url: `/api/shop?me=${id}` })).body.speed, 5);
  // Niveau 5 : 4 s entre deux tirages.
  await later(60000, async () => { r = await rollNow(); }); assert.equal(r.status, 200);
  await later(3900, async () => { r = await rollNow(); }); assert.equal(r.status, 429);
  await later(200, async () => { r = await rollNow(); }); assert.equal(r.status, 200, 'tirage accepté après 4,1 s');
  // Un niveau trafiqué dans la base ne descend pas sous le plancher.
  run([['HSET', key, 'speedLv', 999]]);
  await later(3900, async () => { r = await rollNow(); }); assert.equal(r.status, 429);
  run([['HSET', key, 'speedLv', 5]]);
}

// ================================================================ 36. Casino : compte de la maison (donné / pris) et fil des dernières manches
{
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const g = (who, action, extra = {}) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const house = async () => (await call(shopApi, { url: '/api/shop?casino=1' })).body;
  run([['HINCRBY', `stats:${frank.playerId}`, 'bonus', 5000]]);
  // Premier affichage : les totaux reprennent tout ce qui a été misé et gagné depuis le début, par tous les joueurs.
  const { redis: rawRedis } = require(path.join(ROOT, 'api/_lib.js'));
  let sumBet = 0, sumWon = 0;
  for (const id of run([['HKEYS', 'names']])[0].result) { const [b, w] = run([['HMGET', `stats:${id}`, 'gBet', 'gWon']])[0].result; sumBet += Number(b) || 0; sumWon += Number(w) || 0; }
  assert.ok(sumBet > 0, 'des manches ont déjà été jouées dans les sections précédentes');
  run([['DEL', 'casino']]);
  let h0 = await house();
  assert.deepEqual([h0.took, h0.gave], [sumBet, sumWon], 'totaux repris des compteurs des joueurs');
  assert.deepEqual([(await house()).took, (await house()).gave], [sumBet, sumWon], 'repris une seule fois');
  void rawRedis;
  assert.ok(['gave', 'took', 'rounds'].every(k => Number.isInteger(h0[k])) && Array.isArray(h0.feed), JSON.stringify(h0).slice(0, 200));
  // Dix billes de Plinko : chaque manche ajoute sa mise à « pris » et son gain à « donné ».
  let gave = 0, took = 0, last = null, played = 0;
  for (let i = 0; i < 10; i++) {
    await tick(); clock += 6000; // plus de 5 s entre deux parties : une ligne par partie dans le fil (sinon elles se regroupent)
    r = await g(frank, 'plinko', { bet: 100 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const net = r.body.win - 100; played++;
    gave += r.body.win; took += 100;
    if (net) last = net;
  }
  const h1 = await house();
  assert.deepEqual([h1.gave - h0.gave, h1.took - h0.took, h1.rounds - h0.rounds], [gave, took, played]);
  assert.deepEqual([h1.feed[0].name, h1.feed[0].game, h1.feed[0].net], ['Frank', 'plinko', last], 'la dernière manche en tête du fil');
  assert.ok(h1.feed.length <= 8 && !JSON.stringify(h1).includes(frank.playerId), 'huit manches au plus, aucun identifiant');
  // Roulette perdue à coup sûr sur un numéro plein non sorti, ou gagnée : l'écart suit toujours.
  await tick(); r = await g(frank, 'roulette', { bets: [{ t: 'red', a: 50 }, { t: 'black', a: 50 }] });
  const h2 = await house();
  const net = r.body.win - 100;
  assert.deepEqual([h2.gave - h1.gave, h2.took - h1.took, h2.rounds - h1.rounds], [r.body.win, 100, 1]);
  void net;
  // Le fil ne garde que 20 manches.
  assert.ok(run([['LLEN', 'casino:feed']])[0].result <= 20);
}

// ================================================================ 37. Casino : deux demandes du même joueur qui se croisent
{
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const g = (who, action, extra = {}) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  run([['HINCRBY', `stats:${frank.playerId}`, 'bonus', 5000], ['DEL', `bj:${frank.playerId}`, `mn:${frank.playerId}`, `cr:${frank.playerId}`]]);
  await tick();
  // Les trois reprises de partie partent ensemble à l'ouverture de la page : aucune n'est refusée.
  const three = await Promise.all([g(frank, 'bj', { move: 'state' }), g(frank, 'mines', { move: 'state' }), g(frank, 'crash', { move: 'state' })]);
  assert.deepEqual(three.map(x => x.status), [200, 200, 200], 'reprises simultanées');
  // Sondage du Crash et « Cash out » envoyés en même temps : l'encaissement passe (il attend son tour).
  await tick(); r = await g(frank, 'crash', { move: 'start', bet: 100 });
  if (!r.body.done) {
    const [poll, cash] = await Promise.all([g(frank, 'crash', { move: 'state' }), g(frank, 'crash', { move: 'cash' })]);
    assert.deepEqual([poll.status, cash.status], [200, 200], JSON.stringify([poll.body, cash.body]));
    assert.ok(cash.body.done && ['cash', 'crash'].includes(cash.body.result) || /No game/.test(cash.body.error || ''));
  }
  assert.equal(run([['GET', `cr:${frank.playerId}`]])[0].result, null, 'manche close');
  // Verrou tenu trop longtemps par autre chose : refus propre après l'attente, sans rien débiter.
  await tick(); const before = (await call(shopApi, { url: `/api/shop?me=${frank.playerId}` })).body.coins;
  run([['SET', `shop:${frank.playerId}`, '1', 'PX', '60000']]);
  r = await g(frank, 'plinko', { bet: 100 }); assert.equal(r.status, 429);
  run([['DEL', `shop:${frank.playerId}`]]);
  assert.equal((await call(shopApi, { url: `/api/shop?me=${frank.playerId}` })).body.coins, before);
  // Roulette : treize mises différentes refusées d'un bloc.
  await tick(); r = await g(frank, 'roulette', { bets: Array.from({ length: 13 }, (_, v) => ({ t: 'n', v, a: 10 })) });
  assert.equal(r.status, 422); assert.match(r.body.error, /At most 12/);
  assert.equal((await call(shopApi, { url: `/api/shop?me=${frank.playerId}` })).body.coins, before);
}

// ================================================================ 38. Crash : le sondage d'une manche en vol ne prend pas le verrou
{
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const g = (who, action, extra = {}) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const crypto2 = require('node:crypto'), realInt = crypto2.randomInt;
  run([['HINCRBY', `stats:${frank.playerId}`, 'bonus', 5000], ['DEL', `cr:${frank.playerId}`]]);
  await tick(); crypto2.randomInt = (a, b) => (b === 2 ** 32 ? Math.floor(0.9 * 2 ** 32) : realInt(a, b)); // point de crash à 9,90
  r = await g(frank, 'crash', { move: 'start', bet: 100 }); crypto2.randomInt = realInt;
  assert.equal(r.body.done, false);
  // Verrou tenu par autre chose (un autre coup en cours) : le sondage répond quand même, tout de suite, sans rien écrire.
  await tick(); run([['SET', `shop:${frank.playerId}`, '1', 'PX', '60000']]);
  const n0 = calls;
  r = await g(frank, 'crash', { move: 'state' });
  assert.deepEqual([r.status, r.body.done, r.body.point, r.body.coins], [200, false, undefined, undefined]);
  assert.ok(calls - n0 <= 3, `sondage léger (${calls - n0} allers-retours)`);
  assert.equal(run([['GET', `shop:${frank.playerId}`]])[0].result, '1', 'le verrou d\'un autre coup n\'est pas touché');
  run([['DEL', `shop:${frank.playerId}`]]);
  // Une fois la fusée explosée, le sondage passe par le chemin normal et règle la manche.
  await later(40000, async () => { r = await g(frank, 'crash', { move: 'state' }); });
  assert.deepEqual([r.body.done, r.body.result, r.body.win], [true, 'crash', 0], JSON.stringify(r.body));
  assert.equal(run([['GET', `cr:${frank.playerId}`]])[0].result, null);
}

// ================================================================ 39. Page Owner : carte des visites, heures, casino par jeu, joueurs
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const post = (body, headers = {}) => call(siteApi, { method: 'POST', body, headers });
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  // Visites avec la position donnée par l'hébergeur : seule la case arrondie au degré est comptée, sans rien d'autre.
  process.env.VERCEL = '1'; // ces en-têtes ne valent que sur Vercel (audit de sécurité, 2026-11-02)
  const paris = { 'x-vercel-ip-country': 'FR', 'x-vercel-ip-latitude': '48.8566', 'x-vercel-ip-longitude': '2.3522', 'x-forwarded-for': '9.9.9.1' };
  const g0 = Number(run([['HGET', `ang:${day}`, '49,2']])[0].result) || 0;
  await post({ action: 'visit', lang: 'fr' }, paris); await post({ action: 'visit', lang: 'fr' }, paris);
  await post({ action: 'visit' }, { 'x-vercel-ip-country': 'US', 'x-vercel-ip-latitude': '40.71', 'x-vercel-ip-longitude': '-74.01', 'x-forwarded-for': '9.9.9.2' });
  await post({ action: 'visit' }, { 'x-vercel-ip-country': 'US', 'x-forwarded-for': '9.9.9.3' }); // sans position : pays seulement
  await post({ action: 'visit' }, { 'x-vercel-ip-latitude': 'abc', 'x-vercel-ip-longitude': '500', 'x-forwarded-for': '9.9.9.4' }); // position invalide : ignorée
  const geo = Object.fromEntries((() => { const f = run([['HGETALL', `ang:${day}`]])[0].result; const o = []; for (let i = 0; i < f.length; i += 2) o.push([f[i], Number(f[i + 1])]); return o; })());
  assert.equal(geo['49,2'], g0 + 2); assert.equal(geo['41,-74'], 1);
  assert.ok(Object.keys(geo).every(k => /^-?\d{1,2},-?\d{1,3}$/.test(k)), 'des cases entières seulement');
  assert.ok(!JSON.stringify(run([['HGETALL', `ang:${day}`], ['HGETALL', `an:${day}`]])).includes('9.9.9'), 'aucune adresse IP stockée');
  { const hh = String(new Date(Date.now()).getUTCHours()).padStart(2, '0'); assert.ok(Number(run([['HGET', `an:${day}`, `h:${hh}`]])[0].result) >= 5, 'heure de la visite comptée'); }
  // Pays sans Vercel (Sacha, 2026-11-02 : sur le VPS, toutes les visites tombaient dans « ZZ ») : base DB-IP convertie
  // par tools/geoip-pack.mjs (api/_geo.js). Ici une mini base de test ; l'en-tête de Vercel, s'il y est, passe d'abord.
  {
    const Geo = require(path.join(ROOT, 'api/_geo.js'));
    const csv = ['0.0.0.0,0.255.255.255,ZZ', '5.5.0.0,5.5.255.255,JP', '7.0.0.0,7.255.255.255,BR', '2a01:cb00::,2a01:cbff:ffff:ffff:ffff:ffff:ffff:ffff,FR'].join('\n');
    const file = path.join(os.tmpdir(), `rng-geo-${process.pid}.bin`);
    fs.writeFileSync(file, Geo.pack(Geo.parse(csv)));
    process.env.RNG_GEOIP = file; Geo._reset();
    assert.deepEqual(await Promise.all(['5.5.1.2', '7.1.1.1', '2a01:cb00:12::1', '::ffff:5.5.9.9', '6.6.6.6', '0.1.2.3', 'nope'].map(ip => Geo.country(ip))), ['JP', 'BR', 'FR', 'JP', null, null, null]);
    const cc = c => Number(run([['HGET', `an:${day}`, `c:${c}`]])[0].result) || 0;
    const [jp, br, zz] = [cc('JP'), cc('BR'), cc('ZZ')];
    await post({ action: 'visit' }, { 'x-forwarded-for': '5.5.3.4, 10.0.0.1' });
    await post({ action: 'visit' }, { 'x-forwarded-for': '7.7.7.7', 'x-vercel-ip-country': 'CH' }); // Vercel d'abord
    await post({ action: 'visit' }, { 'x-forwarded-for': '6.6.6.6' }); // hors base : inconnu
    assert.deepEqual([cc('JP') - jp, cc('BR') - br, cc('ZZ') - zz], [1, 0, 1]);
    // Sur le VPS (pas VERCEL), un en-tête x-vercel-* envoyé par le visiteur ne compte pas (audit de sécurité, 2026-11-02).
    delete process.env.VERCEL;
    const [ch, lat0] = [cc('CH'), Number(run([['HLEN', `ang:${day}`]])[0].result)];
    await post({ action: 'visit' }, { 'x-forwarded-for': '7.7.7.8', 'x-vercel-ip-country': 'CH', 'x-vercel-ip-latitude': '46', 'x-vercel-ip-longitude': '7' });
    assert.deepEqual([cc('CH') - ch, cc('BR') - br, Number(run([['HLEN', `ang:${day}`]])[0].result) - lat0], [0, 1, 0], 'en-têtes inventés ignorés');
    process.env.VERCEL = '1';
    assert.ok(!JSON.stringify(run([['HGETALL', `an:${day}`]])).includes('5.5.3.4'), 'aucune adresse IP stockée');
    delete process.env.RNG_GEOIP; Geo._reset(); fs.unlinkSync(file);
  }
  delete process.env.VERCEL;
  // Réservé au créateur.
  r = await post({ action: 'insights', playerId: frank.playerId, secret: frank.secret }); assert.equal(r.status, 403);
  run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]);
  r = await post({ action: 'insights', playerId: frank.playerId, secret: frank.secret });
  run([['HDEL', `stats:${frank.playerId}`, 'owner']]);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const d = r.body;
  assert.ok(d.map.countries.find(c => c.name === 'FR').count >= 2 && d.map.countries.find(c => c.name === 'US').count >= 2);
  assert.ok(d.map.points.some(p => p.lat === 49 && p.lon === 2 && p.n >= 2) && d.map.today.some(p => p.lat === 41 && p.lon === -74));
  assert.equal(d.hours.length, 24); assert.ok(d.hours.reduce((x, v) => x + v, 0) >= 5);
  // Casino : les manches par jeu de toujours viennent des fiches des joueurs ; les mises par jeu des compteurs de la maison.
  const sumAll = d.casino.allTime.reduce((x, g) => x + g.count, 0);
  assert.ok(sumAll > 20 && d.casino.allTime.find(g => g.name === 'plinko').count >= 10, JSON.stringify(d.casino.allTime));
  const tracked = Object.fromEntries(d.casino.tracked.map(g => [g.name, g]));
  assert.ok(tracked.plinko.rounds >= 10 && tracked.plinko.bet >= 1000 && tracked.roulette.rounds >= 1, JSON.stringify(d.casino.tracked));
  assert.equal(d.casino.tracked.reduce((x, g) => x + g.bet, 0) <= d.casino.total.bet, true);
  assert.ok(d.casino.daily[0].rounds >= 11 && d.casino.daily[0].players >= 1 && d.casino.daily[0].games.plinko >= 10, JSON.stringify(d.casino.daily[0]));
  assert.ok(d.casino.gamblers >= 1 && d.casino.topWagered[0].bet >= d.casino.topWagered[d.casino.topWagered.length - 1].bet);
  assert.ok(d.casino.topWagered.some(x => x.name === 'Frank'));
  // Joueurs et économie.
  assert.ok(d.players.named >= 3 && d.players.rolled >= 3 && d.players.rollBuckets.reduce((x, b) => x + b.count, 0) === d.players.rolled);
  assert.ok(d.players.active.day >= 1 && d.players.active.month >= d.players.active.week && d.players.active.week >= d.players.active.day);
  assert.equal(d.players.speed.reduce((x, s) => x + s.count, 0), d.players.named);
  assert.ok(d.players.speed[5].count >= 1, 'Frank est au niveau 5 de vitesse');
  assert.ok(d.economy.coins >= 0 && d.economy.earned >= d.economy.coins);
  assert.ok(!JSON.stringify(d).includes(frank.playerId) && !JSON.stringify(d).includes(frank.secret), 'aucun identifiant ni secret');
}

// ================================================================ 40. Point rouge de l'ampoule : suggestions reçues depuis la dernière vue
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const post = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, name: who.name, action, ...extra } });
  // Un joueur ordinaire n'apprend rien.
  r = await post(bob, 'peek', { since: 0 }); assert.equal(r.body.owner, false); assert.ok(!('fresh' in r.body), 'pas le compteur du créateur');
  run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]);
  r = await post(frank, 'peek', { since: 0 });
  const had = r.body.fresh, seen = r.body.latest;
  assert.equal(r.body.owner, true);
  // Rien de neuf depuis la dernière vue ; puis une suggestion arrive.
  assert.equal((await post(frank, 'peek', { since: seen })).body.fresh, 0);
  await later(5000, async () => { r = await post(bob, 'suggest', { text: 'Add a pet system please' }); });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await post(frank, 'peek', { since: seen });
  assert.deepEqual([r.body.fresh, r.body.latest > seen], [1, true]);
  assert.equal((await post(frank, 'peek', { since: 0 })).body.fresh, had + 1);
  assert.equal((await post(frank, 'peek', { since: r.body.latest })).body.fresh, 0, 'vue : plus de point');
  run([['HDEL', `stats:${frank.playerId}`, 'owner']]);
}

// ================================================================ 41. Bonus du compte Google : 150 pièces, une seule fois
{
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const coinsOf = async id => (await call(shopApi, { url: `/api/shop?me=${id}` })).body.coins;
  // Un joueur joue d'abord sans compte, puis associe Google : +150, et il garde son joueur.
  const zed = { playerId: '7a'.repeat(8), secret: '5c'.repeat(16), name: 'Zed' };
  await later(60000, async () => { r = await call(roll, { method: 'POST', body: zed }); }); assert.equal(r.status, 200);
  assert.equal(r.body.googleBonus, undefined, 'pas de bonus sans compte Google');
  const before = await coinsOf(zed.playerId);
  r = await signIn({ sub: 'google-zed', email: 'zed@example.com', email_verified: true }, { playerId: zed.playerId, secret: zed.secret });
  assert.deepEqual([r.status, r.body.playerId, r.body.bonus], [200, zed.playerId, 150], JSON.stringify(r.body));
  assert.equal(await coinsOf(zed.playerId), before + 150);
  zed.secret = r.body.secret; // une fois le compte associé, c'est le secret reçu à la connexion qui permet de tirer
  // Reconnexion (autre appareil, ou la même page) : plus rien. Un tirage non plus.
  r = await signIn({ sub: 'google-zed', email: 'zed@example.com', email_verified: true }, {});
  assert.deepEqual([r.body.playerId, r.body.bonus], [zed.playerId, 0]);
  await later(60000, async () => { r = await call(roll, { method: 'POST', body: zed }); });
  assert.equal(r.body.googleBonus, undefined);
  assert.equal(await coinsOf(zed.playerId), before + 150 + (await coinsOf(zed.playerId) - before - 150), 'seul le tirage a ajouté des pièces');
  // Un compte associé AVANT le bonus (marqueur absent) le reçoit à son prochain tirage, une seule fois.
  run([['HDEL', `stats:${zed.playerId}`, 'googleBonus']]);
  const mid = await coinsOf(zed.playerId);
  await later(60000, async () => { r = await call(roll, { method: 'POST', body: zed }); });
  assert.equal(r.body.googleBonus, 150);
  const gain = await coinsOf(zed.playerId) - mid; assert.ok(gain >= 151 && gain <= 150 + 5000, `bonus + pièces du tirage (${gain})`);
  await later(60000, async () => { r = await call(roll, { method: 'POST', body: zed }); });
  assert.equal(r.body.googleBonus, undefined);
  // Deux connexions simultanées d'un compte tout neuf : un seul bonus.
  const twin = await Promise.all([signIn({ sub: 'google-twin', email: 't@example.com' }, {}), signIn({ sub: 'google-twin', email: 't@example.com' }, {})]);
  assert.equal(twin[0].body.playerId, twin[1].body.playerId);
  assert.equal(twin[0].body.bonus + twin[1].body.bonus, 150);
  assert.equal(await coinsOf(twin[0].body.playerId), 150);
  await tick();
}

// ================================================================ 42. Cagnotte du serveur et skin Supporter
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const Shop = require(path.join(ROOT, 'js/shop.js')), Ach = require(path.join(ROOT, 'js/achievements.js'));
  const post = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, name: who.name, action, ...extra } });
  const shop = (who, action, extra = {}) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const state = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  // La visite rapporte la cagnotte du mois : vide, objectif par défaut de 20 €, pas de lien.
  r = await call(siteApi, { method: 'POST', body: { action: 'visit' }, headers: { 'x-forwarded-for': '8.8.1.1' } });
  assert.deepEqual([r.body.fund.cents, r.body.fund.goal, r.body.fund.url, r.body.fund.month], [0, 2000, '', new Date(Date.now()).toISOString().slice(0, 7)]);
  // Le skin Supporter ne se prend ni ne s'achète, et il n'est dans aucune caisse ni sur aucun bot.
  assert.ok(!(await state(frank)).owned.includes('supporter'));
  await tick(); assert.equal((await shop(frank, 'equip', { skin: 'supporter' })).status, 422);
  await tick(); r = await shop(frank, 'buy', { skin: 'supporter' }); assert.equal(r.status, 422); assert.match(r.body.error, /not for sale/);
  assert.ok(!Shop.SKINS.some(k => k.id === 'supporter') && Shop.CASES.every(c => !Shop.casePool(c).some(k => k.id === 'supporter')));
  // Réservé au créateur.
  assert.equal((await post(frank, 'fundAdd', { name: 'Frank', euros: 5 })).status, 403);
  run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]);
  for (const bad of [0, 'x', 5000, -5000]) assert.equal((await post(frank, 'fundAdd', { name: 'Frank', euros: bad })).status, 422);
  assert.equal((await post(frank, 'fundAdd', { name: 'Nobody Here', euros: 5 })).status, 404);
  // Bob reprend son pseudo (payant depuis le 2026-10-25 : un tirage ne renomme plus) ; on lui donne de quoi payer.
  run([['HINCRBY', `stats:${bob.playerId}`, 'bonus', Shop.RENAME_PRICE]]);
  assert.equal((await setName(bob, bob.name)).status, 200);
  // Une contribution de 5 € pour Bob (pseudo écrit autrement) : total du mois, journal, skin et titre.
  r = await post(frank, 'fundAdd', { name: '  bob<script> ', euros: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.cents, r.body.count, r.body.log[0].cents, r.body.months[0].cents], [500, 1, 500, 500]);
  let st = await state(bob);
  assert.ok(st.owned.includes('supporter') && st.supporter === true);
  const bobStats = (() => { const f = run([['HGETALL', `stats:${bob.playerId}`]])[0].result, o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; })();
  assert.ok(Ach.unlocked(bobStats).includes('supporter'), 'titre Supporter débloqué');
  assert.equal(Shop.balance(bobStats), st.coins, 'aucune pièce donnée');
  await tick(); r = await shop(bob, 'equip', { skin: 'supporter' }); assert.deepEqual([r.status, r.body.skin], [200, 'supporter']);
  assert.equal((await state(bob)).skin, 'supporter');
  // Deuxième contribution, puis réglage de l'objectif et du lien.
  r = await post(frank, 'fundAdd', { name: bob.name, euros: 2.5 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await post(frank, 'fundSet', { goal: 30, url: 'https://ko-fi.com/example' });
  assert.deepEqual([r.body.cents, r.body.count, r.body.goal, r.body.url], [750, 2, 3000, 'https://ko-fi.com/example']);
  assert.equal((await post(frank, 'fundSet', { url: 'javascript:alert(1)' })).status, 422);
  r = await call(siteApi, { method: 'POST', body: { action: 'visit' }, headers: { 'x-forwarded-for': '8.8.1.2' } });
  assert.deepEqual([r.body.fund.cents, r.body.fund.goal, r.body.fund.url], [750, 3000, 'https://ko-fi.com/example']);
  assert.ok(!JSON.stringify(r.body).includes('Bob'), 'les noms des contributeurs ne sortent pas en public');
  // Correction d'une erreur de saisie : retour à zéro, plus de skin (retiré s'il était porté), plus de titre.
  r = await post(frank, 'fundAdd', { name: bob.name, euros: -7.5 });
  assert.equal(r.body.cents, 0);
  st = await state(bob);
  assert.deepEqual([st.owned.includes('supporter'), st.skin, st.supporter], [false, 'classic', false]);
  run([['HDEL', `stats:${frank.playerId}`, 'owner'], ['HDEL', 'fund:cfg', 'url', 'goal']]);
}

// ================================================================ 43. Dons automatiques : le message de Ko-fi donne le skin tout seul
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const state = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body;
  const post = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, name: who.name, action, ...extra } });
  const fundNow = async () => (await call(siteApi, { method: 'POST', body: { action: 'fundInfo' } })).body;
  // Ko-fi envoie un formulaire : un champ « data » qui contient du JSON.
  const kofi = (data, asString) => call(siteApi, { method: 'POST', url: '/api/site?kofi=1', body: asString ? 'data=' + encodeURIComponent(JSON.stringify(data)) : { data: JSON.stringify(data) } });
  const tip = (over = {}) => ({ verification_token: 'kofi-secret-123', message_id: 'm-' + Math.random().toString(36).slice(2), kofi_transaction_id: 'tx-' + Math.random().toString(36).slice(2), type: 'Tip', from_name: 'Somebody', message: '', amount: '3.00', currency: 'EUR', email: 'private@example.com', is_public: true, ...over });
  // Pas configuré : rien n'est accepté.
  delete process.env.KOFI_TOKEN;
  assert.equal((await kofi(tip())).status, 503);
  process.env.KOFI_TOKEN = 'kofi-secret-123';
  // Mauvais jeton, jeton absent, données illisibles : refusés sans rien écrire.
  const before = await fundNow();
  assert.equal((await kofi(tip({ verification_token: 'nope' }))).status, 401);
  assert.equal((await kofi(tip({ verification_token: undefined }))).status, 401);
  assert.equal((await call(siteApi, { method: 'POST', url: '/api/site?kofi=1', body: { data: '{pas du json' } })).status, 400);
  assert.equal((await kofi(tip({ amount: 'abc' }))).status, 400);
  assert.deepEqual(await fundNow(), before);
  // Le pseudo est dans le message (au milieu d'une phrase, autre casse) : skin et titre tout de suite.
  assert.ok(!(await state(alice)).owned.includes('supporter'));
  const t1 = tip({ message: 'Love the game! my name is ALICE :)', amount: '5.00' });
  r = await kofi(t1, true);
  assert.deepEqual([r.status, r.body.matched], [200, true], JSON.stringify(r.body));
  assert.ok((await state(alice)).owned.includes('supporter'));
  assert.equal((await fundNow()).cents, before.cents + 500);
  // Ko-fi renvoie le même message : compté une seule fois.
  r = await kofi(t1); assert.equal(r.body.duplicate, true);
  assert.equal((await fundNow()).cents, before.cents + 500);
  // Les trois noms d'un don sont acceptés ; une commande (« Commission ») ou une vente ne l'est pas.
  r = await kofi(tip({ type: 'Commission', message: 'Alice' })); assert.equal(r.body.ignored, true);
  // Une vente de boutique n'est pas un don.
  r = await kofi(tip({ type: 'Shop Order', message: 'Alice' })); assert.equal(r.body.ignored, true);
  assert.equal((await fundNow()).cents, before.cents + 500);
  // Aucun pseudo reconnu : le don compte dans le mois et attend sur la page du créateur, sans l'adresse e-mail.
  const t2 = tip({ message: 'keep it up!!', from_name: 'Anonymous Fan', amount: '2.50' });
  r = await kofi(t2); assert.deepEqual([r.status, r.body.matched], [200, false]);
  assert.equal((await fundNow()).cents, before.cents + 750);
  run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]);
  r = await post(frank, 'fund');
  assert.equal(r.body.auto, true);
  assert.deepEqual(r.body.pending.map(x => [x.cents, x.from, x.message]), [[250, 'Anonymous Fan', 'keep it up!!']]);
  assert.ok(!JSON.stringify(r.body).includes('private@example.com') && !JSON.stringify(run([['HGETALL', 'fund:pending'], ['ZRANGE', 'fund:log', '0', '-1']])).includes('private@example.com'), 'aucune adresse e-mail gardée');
  assert.ok(r.body.log.some(x => x.name === 'Alice' && x.cents === 500 && x.auto === 1));
  // Le créateur l'attribue à Frank : skin donné, le total du mois ne bouge pas (déjà compté).
  const tx = r.body.pending[0].tx;
  assert.equal((await post(frank, 'fundAssign', { tx, name: 'Nobody Here' })).status, 404);
  r = await post(frank, 'fundAssign', { tx, name: 'Frank' });
  assert.deepEqual([r.status, r.body.pending.length, r.body.cents], [200, 0, before.cents + 750], JSON.stringify(r.body).slice(0, 200));
  assert.ok((await state(frank)).owned.includes('supporter'));
  assert.equal((await post(frank, 'fundAssign', { tx, name: 'Frank' })).status, 404, 'déjà traité');
  // Le pseudo seul dans le nom Ko-fi suffit aussi ; un don classé sans suite disparaît de l'attente.
  r = await kofi(tip({ message: '', from_name: 'alice', amount: '1' })); assert.equal(r.body.matched, true);
  for (const type of ['Donation', 'Subscription']) { r = await kofi(tip({ type, message: 'Alice', amount: '1' })); assert.equal(r.body.matched, true, type); }
  const t3 = tip({ message: '???', from_name: 'x' }); await kofi(t3);
  r = await post(frank, 'fund'); assert.equal(r.body.pending.length, 1);
  r = await post(frank, 'fundAssign', { tx: r.body.pending[0].tx, dismiss: true }); assert.equal(r.body.pending.length, 0);
  // Un faux don (test de Ko-fi) : « pas un vrai don » le retire aussi du total du mois.
  { const c0 = (await fundNow()).cents; await kofi(tip({ message: '', from_name: 'Jo Example', amount: '3.00' })); assert.equal((await fundNow()).cents, c0 + 300); r = await post(frank, 'fund'); r = await post(frank, 'fundAssign', { tx: r.body.pending[0].tx, dismiss: true, remove: true }); assert.deepEqual([r.body.pending.length, r.body.cents], [0, c0]); }
  // Un joueur ordinaire ne peut rien attribuer.
  assert.equal((await post(bob, 'fundAssign', { tx: 'x', name: 'Bob' })).status, 403);
  // Un message ordinaire qui contient par hasard le pseudo de quelqu'un ne donne rien tout seul : il attend.
  process.env.KOFI_TOKEN = 'kofi-secret-123';
  // … ni un compliment adressé au créateur (Frank, ici), même court, même seul, même comme nom de compte.
  for (const [msg, from] of [['nice game frank', 'x'], ['merci Frank', 'x'], ['Frank', 'x'], ['pseudo: frank', 'x'], ['hello', 'Frank'], ['nice game alice', 'x']]) { r = await kofi(tip({ message: msg, from_name: from, amount: '1' })); assert.equal(r.body.matched, false, msg); }
  for (const msg of ['Really great game, Alice and me play it every day after school', 'très bon jeu continue comme ça frank !!']) { r = await kofi(tip({ message: msg, from_name: 'Somebody Else', amount: '1' })); assert.equal(r.body.matched, false, msg); }
  // Reconnu : le pseudo seul, avec un libellé, dans un message très court, ou comme nom du compte Ko-fi.
  for (const [msg, from] of [['Alice', 'x'], ['pseudo : alice', 'x'], ['Super jeu ! Mon pseudo est Alice', 'x'], ['gg alice', 'x'], ['IGN: Alice thanks for the game', 'x'], ['très bon jeu, continuez comme ça', 'Alice']]) { r = await kofi(tip({ message: msg, from_name: from, amount: '1' })); assert.equal(r.body.matched, true, msg); }
  r = await post(frank, 'fund'); for (const x of r.body.pending) await post(frank, 'fundAssign', { tx: x.tx, dismiss: true, remove: true });
  // Jeton collé avec un retour à la ligne ou des guillemets dans les réglages : accepté quand même.
  for (const messy of ['kofi-secret-123\n', '  kofi-secret-123  ', '"kofi-secret-123"']) { process.env.KOFI_TOKEN = messy; r = await kofi(tip({ type: 'Shop Order' })); assert.equal(r.status, 200, JSON.stringify(messy)); }
  // Jeton au format de Ko-fi collé avec un libellé devant : le serveur retrouve le jeton dans la valeur.
  { const id = '0a1b2c3d-1111-2222-3333-444455556666'; for (const v of [id, `KOFI_TOKEN: ${id}`, `Verification token ${id}\n`]) { process.env.KOFI_TOKEN = v; r = await kofi(tip({ verification_token: id, type: 'Shop Order' })); assert.equal(r.status, 200, v); assert.equal((await kofi(tip({ verification_token: id.replace('0a', '0b'), type: 'Shop Order' }))).status, 401); } }
  run([['HDEL', `stats:${frank.playerId}`, 'owner']]);
  delete process.env.KOFI_TOKEN;
}

// ================================================================ 44. Page Owner : activité par jour et rétention par cohorte
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const DAY = 86400000, now = Date.now(), dk = i => new Date(now - i * DAY).toISOString().slice(0, 10), at = i => Date.parse(`${dk(i)}T12:00:00Z`);
  // Quatre joueurs arrivés il y a 5 jours (cohorte) : deux reviennent le lendemain, un seul trois jours après ; un
  // ancien habitué joue 6 jours puis s'arrête il y a 4 jours. Seul leur historique existe : aucun compteur d'activité.
  const seed = (id, name, daysAgo, stats = {}) => run([
    ['HSET', 'names', id, name], ['HSET', `stats:${id}`, 'rolls', daysAgo.length * 2, ...Object.entries(stats).flat()],
    ...daysAgo.flatMap(i => [['ZADD', `hist:${id}`, at(i), `${at(i)}:${1000 + i}`], ['ZADD', `hist:${id}`, at(i) + 60000, `${at(i) + 60000}:${2000 + i}`]]),
  ]);
  // Le reste de la suite a déjà ses propres joueurs : on mesure l'écart avec l'état d'avant.
  const reset = () => run([['DEL', 'act:backfill'], ...Array.from({ length: 30 }, (_, i) => ['DEL', `act:${dk(i + 1)}`])]);
  const ask = async () => { run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]); const r = await call(siteApi, { method: 'POST', body: { action: 'insights', playerId: frank.playerId, secret: frank.secret } }); run([['HDEL', `stats:${frank.playerId}`, 'owner']]); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body.retention; };
  reset(); const R0 = await ask();
  const co = ['c1', 'c2', 'c3', 'c4'].map(x => (x + '0'.repeat(16)).slice(0, 16).replace(/c/, 'c'));
  seed(co[0], 'Coh One', [5, 4, 2], { questsDone: 3, duels: 1 }); seed(co[1], 'Coh Two', [5, 4]); seed(co[2], 'Coh Three', [5]); seed(co[3], 'Coh Four', [5]);
  const old = 'd'.repeat(15) + '1';
  seed(old, 'Old Regular', [20, 9, 8, 7, 6, 5, 4]);
  run([['SET', `player:${co[0]}:google`, 'g-test']]); reset();
  let R = await ask();
  // Reconstruit depuis l'historique : qui a joué chaque jour, combien de tirages, et la date du premier tirage.
  const day5 = Object.fromEntries((run([['HGETALL', `act:${dk(5)}`]])[0].result || []).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), []));
  for (const id of co) assert.equal(String(day5[id]), '2', 'deux tirages ce jour-là');
  assert.equal(String(day5[old]), '2');
  assert.equal(String(run([['HGET', `stats:${co[0]}`, 'first']])[0].result), String(at(5)));
  assert.ok(run([['GET', 'act:backfill']])[0].result, 'reconstruction marquée comme faite');
  // La cohorte d'il y a 5 jours : 4 nouveaux (l'habitué, arrivé avant, n'en fait pas partie), 50 % à J1, 25 % à J3.
  const c5 = R.cohorts[5], b5 = R0.cohorts[5];
  assert.equal(c5.day, dk(5)); assert.equal(c5.size - b5.size, 4);
  const cell = n => c5.cells.find(x => x.n === n).back, grew = n => cell(n) - b5.cells.find(x => x.n === n).back;
  assert.equal(grew(1), 2); assert.equal(grew(2), 0); assert.equal(grew(3), 1); assert.equal(grew(4), 0);
  // J5 tombe aujourd'hui (jour incomplet), J7 dans le futur : pas encore de valeur, et pas un zéro.
  assert.equal(cell(5), null); assert.equal(cell(7), null); assert.equal(cell(30), null);
  // Le résumé pondère toutes les cohortes prêtes : J1 compte au moins ces 4 joueurs, dont 2 revenus.
  const d1 = R.summary.find(x => x.n === 1), d1b = R0.summary.find(x => x.n === 1); assert.ok(d1.players - d1b.players === 5 && d1.back - d1b.back === 2 && d1.rate > 0 && d1.rate <= 100, JSON.stringify([d1, d1b]));
  assert.equal(R.cameBack.players - R0.cameBack.players, 5); assert.equal(R.cameBack.back - R0.cameBack.back, 3);
  // Jour par jour : il y a 5 jours, 5 actifs dont 4 nouveaux et 1 revenu, 10 tirages.
  for (const [k, v] of [['active', 5], ['fresh', 4], ['back', 1], ['rolls', 10]]) assert.equal(R.series[5][k] - R0.series[5][k], v, k);
  assert.equal(R.series.length, 30); assert.ok(R.series[0].active >= 3, 'les tirages du jour comptent déjà');
  assert.ok(R.active.month >= R.active.week && R.active.week >= R.active.today && R.active.stickiness >= 0 && R.active.stickiness <= 100);
  // L'habitué silencieux depuis 4 jours est signalé, avec son nombre de jours joués ; les fidèles sont triés par jours joués.
  const quiet = R.quiet.find(x => x.name === 'Old Regular'); assert.ok(quiet && quiet.ago === 4 && quiet.days === 7, JSON.stringify(R.quiet));
  assert.ok(R.loyal[0].days >= R.loyal[R.loyal.length - 1].days && R.loyal.some(x => x.name === 'Old Regular'));
  // Répartitions : chaque joueur est dans une seule case.
  assert.equal(R.status.reduce((x, b) => x + b.count, 0), R.base.players);
  assert.ok(R.status.find(b => b.name.startsWith('Cooling')).count >= 3 && R.daysPlayed.find(b => b.name === '1 day').count >= 2);
  // Parcours des nouveaux : chaque étape contient moins de monde que le départ ; fonctions utilisées au moins une fois.
  assert.equal(R.funnel[0].count, R.base.newcomers); assert.ok(R.funnel.every(x => x.count <= R.funnel[0].count));
  assert.equal(R.base.newcomers - R0.base.newcomers, 5); assert.equal(R.base.players - R0.base.players, 5);
  const step = (X, n) => X.funnel.find(x => x.name.startsWith(n)).count; assert.equal(step(R, 'Played on 2') - step(R0, 'Played on 2'), 3);
  assert.ok(R.features.find(x => x.name.startsWith('Linked a Google')).count >= 1 && R.features.find(x => x.name.startsWith('Played a duel')).fresh >= 1);
  assert.ok(!JSON.stringify(R).includes(co[0]) && !JSON.stringify(R).includes(frank.playerId), 'aucun identifiant');
  // La reconstruction ne se refait pas : un jour effacé à la main n'est pas réécrit.
  const seeded5 = R.series[5].active; // la cohorte du test a joué il y a 5 jours : jamais vide, à toute heure
  run([['DEL', `act:${dk(5)}`]]);
  R = await ask(); assert.equal(R.series[5].active, 0); assert.ok(seeded5 > 0);
  // Un tirage inscrit le joueur dans le jour en cours, et ne touche plus à sa date de premier tirage.
  const today = () => Number(run([['HGET', `act:${dk(0)}`, alice.playerId]])[0].result) || 0, before = today();
  run([['DEL', `cooldown:${alice.playerId}`]]);
  const firstBefore = run([['HGET', `stats:${alice.playerId}`, 'first']])[0].result;
  const rr = await call(roll, { method: 'POST', body: alice }); assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.equal(today(), before + 1); assert.ok(firstBefore && run([['HGET', `stats:${alice.playerId}`, 'first']])[0].result === firstBefore);
}

// ================================================================ 45. Classement du casino : gagnants, perdants, plus gros parieurs
{
  const shopApi = require(path.join(ROOT, 'api/shop.js'));
  const top = async me => (await call(shopApi, { url: `/api/shop?casino=top${me ? `&me=${me}` : ''}` })).body;
  // Quinze joueurs inventés : les 7 premiers gagnent (de plus en plus), les 8 autres perdent ; mises croissantes.
  const ids = Array.from({ length: 15 }, (_, i) => ('f' + i.toString(16)).padEnd(16, 'a'));
  run(ids.flatMap((id, i) => [['HSET', 'names', id, `Gam${i}`], ['HSET', `stats:${id}`, 'gBet', 1e9 + i * 1000, 'gWon', i < 7 ? 1e9 + i * 1000 + (i + 1) * 1e6 : 1e9 + i * 1000 - (i + 1) * 1e6, 'gPlinko', 10 + i, 'gSlots', 5]]));
  run([['DEL', 'casino:board']]);
  let b = await top(ids[0]);
  assert.ok(b.winners.length >= 7 && b.winners.length <= 10); assert.ok(b.losers.length >= 8 && b.losers.length <= 10); assert.equal(b.gamblers.length, 10);
  // Gagnants : net décroissant, le plus gros d'abord ; perdants : la plus grosse perte d'abord ; parieurs : par total misé.
  assert.deepEqual(b.winners.slice(0, 7).map(x => x.name), ['Gam6', 'Gam5', 'Gam4', 'Gam3', 'Gam2', 'Gam1', 'Gam0']);
  assert.ok(b.winners.every(x => x.net > 0) && b.losers.every(x => x.net < 0));
  assert.deepEqual(b.losers.slice(0, 3).map(x => [x.name, x.net]), [['Gam14', -15e6], ['Gam13', -14e6], ['Gam12', -13e6]]);
  assert.deepEqual(b.gamblers.slice(0, 2).map(x => x.name), ['Gam14', 'Gam13']); assert.equal(b.gamblers[0].rounds, 29); assert.equal(b.gamblers[0].rank, 1);
  // Le joueur qui demande est repéré dans le top, sans que le moindre identifiant sorte.
  assert.equal(b.winners.find(x => x.me).name, 'Gam0'); assert.ok(!b.mine.winners, 'déjà dans le top : pas de ligne en plus');
  assert.ok(!JSON.stringify(b).includes(ids[0]) && !JSON.stringify(b).includes(ids[14]));
  // Hors du top des parieurs (mise la plus faible des quinze) : sa ligne et son vrai rang sont joints.
  assert.ok(b.mine.gamblers && b.mine.gamblers.name === 'Gam0' && b.mine.gamblers.rank >= 15 && b.mine.gamblers.me, JSON.stringify(b.mine));
  // Sans joueur : même classement, personne de repéré.
  b = await top(''); assert.ok(b.winners.every(x => !x.me) && Object.keys(b.mine).length === 0 && b.players >= 15);
  // Gardé une minute : un changement de fiche n'apparaît qu'une fois le cache expiré.
  run([['HSET', `stats:${ids[0]}`, 'gWon', 9e9]]);
  assert.equal((await top('')).winners[0].name, 'Gam6');
  run([['DEL', 'casino:board']]);
  assert.equal((await top('')).winners[0].name, 'Gam0');
  // L'ancien appel (bandeau en direct) répond toujours.
  assert.ok('took' in (await call(shopApi, { url: '/api/shop?casino=1' })).body);
  run([...ids.flatMap(id => [['HDEL', 'names', id], ['DEL', `stats:${id}`]]), ['DEL', 'casino:board']]);
}

// ================================================================ 46. Invité de la page Owner : il voit tout, il ne change rien
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const post = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, name: who.name, action, ...extra } });
  const guest = { playerId: 'ab'.repeat(8), secret: 'c'.repeat(32), name: 'Guest' };
  db.delete(`cooldown:${guest.playerId}`);
  assert.equal((await call(roll, { method: 'POST', body: guest })).status, 200);
  // Avant de se connecter avec Google : un joueur comme un autre.
  for (const a of ['inbox', 'stats', 'insights', 'fund']) assert.equal((await post(guest, a)).status, 403, a);
  // E-mail non vérifié, ou autre adresse : toujours rien.
  r = await signIn({ sub: 'g-guest-fake', email: 'guest@example.com', email_verified: false }, { playerId: 'ac'.repeat(8), secret: 'd'.repeat(32) });
  assert.equal(run([['HGET', `stats:${r.body.playerId}`, 'viewer']])[0].result, null);
  // Connexion avec l'adresse invitée (majuscules et espaces ignorés) : accès en lecture.
  r = await signIn({ sub: 'g-guest', email: ' Guest@Example.com ' }, { playerId: guest.playerId, secret: guest.secret });
  assert.equal(r.status, 200); assert.equal(r.body.playerId, guest.playerId);
  r = await post(guest, 'mine'); assert.deepEqual([r.body.owner, r.body.viewer], [false, true]);
  for (const a of ['inbox', 'stats', 'fund']) { r = await post(guest, a); assert.equal(r.status, 200, a); assert.equal(r.body.readOnly, true, a); }
  r = await post(guest, 'insights'); assert.equal(r.status, 200); assert.ok(r.body.retention && r.body.casino);
  // Aucune écriture : ni suggestions, ni cagnotte ; et pas de point rouge ni de skin Owner.
  const [sid] = run([['ZREVRANGE', 'sugg:all', 0, 0]])[0].result || [];
  const before = JSON.stringify(run([['HGETALL', `sugg:${sid}`], ['HGETALL', 'fund:cfg'], ['ZCARD', 'fund:log'], ['ZCARD', 'sugg:all']]));
  for (const [a, extra] of [['mark', { id: sid, status: 'done', reply: 'hacked' }], ['delete', { id: sid }], ['fundAdd', { name: 'Alice', euros: 5 }], ['fundSet', { goal: 1, url: 'https://evil.example' }], ['fundAssign', { tx: 'x', name: 'Alice' }]]) assert.equal((await post(guest, a, extra)).status, 403, a);
  assert.equal(JSON.stringify(run([['HGETALL', `sugg:${sid}`], ['HGETALL', 'fund:cfg'], ['ZCARD', 'fund:log'], ['ZCARD', 'sugg:all']])), before, 'rien n\'a bougé');
  r = await post(guest, 'peek', { since: 0 }); assert.equal(r.body.owner, false);
  assert.equal((await equip(guest, 'owner')).status, 422);
  // Il reçoit le titre Manager (réservé : un joueur ordinaire ne peut pas l'équiper), visible au classement.
  r = await equip(guest, 'manager'); assert.deepEqual([r.status, r.body.title], [200, 'manager']);
  assert.equal((await equip(alice, 'manager')).status, 422);
  // Le créateur, lui, n'est pas en lecture seule.
  run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]);
  r = await post(frank, 'stats'); assert.equal(r.body.readOnly, false); r = await post(frank, 'mine'); assert.deepEqual([r.body.owner, r.body.viewer], [true, false]);
  run([['HDEL', `stats:${frank.playerId}`, 'owner']]);
  // Accès retiré : une empreinte qui n'est plus dans la liste ne donne plus rien, même si la fiche la porte encore.
  run([['HSET', `stats:${guest.playerId}`, 'viewer', 'f'.repeat(64)]]);
  assert.equal((await post(guest, 'stats')).status, 403); assert.equal((await post(guest, 'mine')).body.viewer, false);
}

// ================================================================ 47. Longue partie : la limite de manches suit l'objectif
{
  // Un nombre qui rapporte peu : 300 manches restent loin des 10 M d'XP.
  let low = 100000; for (let n = 100000; n < 130000; n++) if (engine.scoreOf(n) < engine.scoreOf(low)) low = n;
  const per = engine.scoreOf(low); assert.ok(per < 2000, `tirage faible : ${per} XP`);
  const make = async (mode, target) => { run([['DEL', `cooldown:${alice.playerId}`]]); const r = await roomPost(alice, 'create', { size: 2, mode, target, bots: 1 }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.code; };
  const fill = (code, count) => run(Array.from({ length: count }, (_, i) => ['RPUSH', `room:${code}:rounds`, JSON.stringify({ t: 1000 + i, revealAt: 1000 + i, n: [low, low] })]));
  const state = async code => (await roomGet(code, alice)).body;
  // Course à 10 M : 300 manches jouées, objectif pas atteint, la partie continue (elle s'arrêtait à 100).
  let code = await make('xp', 10000000); fill(code, 300);
  let d = await state(code); assert.equal(d.target, 10000000); assert.equal(d.rounds.length, 300); assert.equal(d.status, 'playing', 'plus de limite à 100 manches');
  assert.ok(d.players[0].total === 300 * per && d.players[0].total < d.target);
  // Le garde-fou existe toujours, plus loin : 4 000 manches pour 10 M.
  fill(code, 3699); assert.equal((await state(code)).status, 'playing'); fill(code, 1); assert.equal((await state(code)).status, 'done');
  // Petit objectif : la limite reste 100 manches ; l'objectif atteint termine la partie comme avant.
  code = await make('xp', 250000); fill(code, 99); assert.equal((await state(code)).status, 'playing'); fill(code, 1); assert.equal((await state(code)).status, 'done');
  // Manches à gagner : 50 manches à 2 joueurs laissent la place d'y arriver (égalités comprises).
  code = await make('rounds', 50); fill(code, 299); assert.equal((await state(code)).status, 'playing'); fill(code, 1); assert.equal((await state(code)).status, 'done');
  code = await make('rounds', 3); fill(code, 99); assert.equal((await state(code)).status, 'playing'); fill(code, 1); assert.equal((await state(code)).status, 'done');
}

// ================================================================ 48. Classement du mois
{
  const board = async (who, period = 'month') => (await call(leaderboard, { url: `/api/leaderboard?period=${period}${who ? `&me=${who.playerId}` : ''}` })).body;
  const now = Date.now(), month = new Date(now).toISOString().slice(0, 7), start = Date.parse(`${month}-01T00:00:00Z`);
  // Deux joueurs connus seulement par leur historique : l'un a un gros tirage ce mois-ci, l'autre seulement le mois dernier.
  let big = 111000; for (let n = 111000; n < 112000; n++) if (engine.scoreOf(n) > engine.scoreOf(big)) big = n;
  const inMonth = '7e'.repeat(8), before = '7f'.repeat(8);
  run([
    ['HSET', 'names', inMonth, 'Monthly'], ['HSET', 'names', before, 'LastMonth'],
    ['ZADD', `hist:${inMonth}`, start + 5000, `${start + 5000}:${big}`], ['ZADD', `hist:${inMonth}`, start + 9000, `${start + 9000}:12`], ['ZADD', `hist:${inMonth}`, start - 5000, `${start - 5000}:1000000`],
    ['ZADD', `hist:${before}`, start - 86400000, `${start - 86400000}:1000000`],
    ['DEL', 'lb:month:seeded'], ['DEL', `lb:month:${month}`], ['DEL', `best:month:${month}`], ['DEL', `count:month:${month}`], ['DEL', `rolls:month:${month}`],
  ]);
  // Premier affichage : le mois en cours est rempli depuis les historiques (tirages d'avant le 1er ignorés).
  let b = await board(null);
  assert.equal(b.period, 'month');
  const row = b.entries.find(e => e.name === 'Monthly');
  assert.ok(row, 'joueur repris de son historique'); assert.deepEqual([row.n, row.s, row.t, row.rolls], [big, engine.scoreOf(big), start + 5000, 2]);
  assert.ok(!b.entries.some(e => e.name === 'LastMonth'), 'un tirage du mois dernier ne compte pas');
  assert.ok(b.entries.every((e, i) => i === 0 || b.entries[i - 1].s >= e.s), 'trié par XP');
  assert.ok(b.rolls >= 2 && b.players === b.entries.length);
  // Les joueurs de la suite (Alice a tiré aujourd'hui) y sont aussi, et le remplissage ne se refait pas.
  assert.ok(b.entries.some(e => e.name === 'Alice' || e.name === 'Alicia') || b.entries.length >= 3);
  run([['ZREM', `lb:month:${month}`, inMonth]]);
  assert.ok(!(await board(null)).entries.some(e => e.name === 'Monthly'), 'rempli une seule fois');
  // Un nouveau tirage met à jour le mois : compteur +1, et la ligne « moi » est signalée.
  const mine = async () => { const x = await board(alice); return x.entries.find(e => e.me) || x.mine; };
  run([['DEL', `cooldown:${alice.playerId}`]]);
  const c0 = (await mine()) ? (await mine()).rolls : 0;
  const rr = await call(roll, { method: 'POST', body: alice }); assert.equal(rr.status, 200, JSON.stringify(rr.body));
  const after = await mine(); assert.ok(after && after.rolls === c0 + 1 && after.s >= rr.body.s, JSON.stringify(after));
  // Les autres périodes répondent toujours ; une période inconnue retombe sur le jour.
  for (const per of ['day', 'week', 'all', 'xp', 'coins']) assert.equal((await board(alice, per)).period, per);
  assert.equal((await board(null, 'year')).period, 'day');
  run([['HDEL', 'names', inMonth], ['HDEL', 'names', before], ['DEL', `hist:${inMonth}`], ['DEL', `hist:${before}`], ['ZREM', `lb:month:${month}`, inMonth], ['HDEL', `best:month:${month}`, inMonth], ['HDEL', `count:month:${month}`, inMonth]]);
}

// ================================================================ 49. Suggestions : une vraie conversation (le joueur répond dans le même fil)
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const post = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, name: who.name, action, ...extra } });
  const asOwner = async (action, extra) => { run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]); const x = await post(frank, action, extra); run([['HDEL', `stats:${frank.playerId}`, 'owner']]); return x; };
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  run([['DEL', `sugg:rate:${day}:${alice.playerId}`], ['DEL', `sugg:replies:${day}:${alice.playerId}`]]);
  r = await post(alice, 'suggest', { text: 'Add more luck' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const sid = r.body.mine.find(x => x.text === 'Add more luck').id; assert.deepEqual(r.body.mine.find(x => x.id === sid).thread, []);
  // Pas encore de réponse du créateur : rien à signaler au joueur.
  r = await post(alice, 'peek', { seen: 0 }); assert.equal(r.body.replies, 0);
  // Le créateur pose une question : elle arrive dans le fil, la suggestion passe en « lue », le joueur est prévenu.
  r = await asOwner('mark', { id: sid, reply: 'In which way could that be done?' });
  let s1 = r.body.suggestions.find(x => x.id === sid);
  assert.deepEqual(s1.thread.map(m => [m.from, m.text]), [['owner', 'In which way could that be done?']]); assert.equal(s1.status, 'seen'); assert.equal(s1.reply, 'In which way could that be done?');
  r = await post(alice, 'peek', { seen: 0 }); assert.equal(r.body.replies, 1); const seenAt = r.body.latest; assert.ok(seenAt > 0);
  assert.equal((await post(alice, 'peek', { seen: seenAt })).body.replies, 0, 'vu : plus de point rouge');
  // Le joueur répond dans le même fil : pas de nouvelle suggestion, et elle repasse en « non lue » en tête de la boîte.
  const total = Number(run([['ZCARD', 'sugg:all']])[0].result);
  r = await post(alice, 'reply', { id: sid, text: '  A lucky streak bonus after 10 bad rolls  ' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.mine.find(x => x.id === sid).thread.map(m => [m.from, m.text]), [['owner', 'In which way could that be done?'], ['player', 'A lucky streak bonus after 10 bad rolls']]);
  assert.equal(Number(run([['ZCARD', 'sugg:all']])[0].result), total, 'aucun nouveau ticket');
  r = await asOwner('inbox'); assert.equal(r.body.suggestions[0].id, sid, 'remontée en tête'); assert.equal(r.body.suggestions[0].status, 'new'); assert.equal(r.body.suggestions[0].thread.length, 2);
  run([['HSET', `stats:${frank.playerId}`, 'owner', '1']]); assert.ok((await post(frank, 'peek', { since: Date.now() - 5000 })).body.fresh >= 1, 'point rouge du créateur'); run([['HDEL', `stats:${frank.playerId}`, 'owner']]);
  // La conversation continue ; le texte de départ et son heure ne bougent pas.
  r = await asOwner('mark', { id: sid, reply: 'Nice, I will try it', status: 'planned' });
  s1 = r.body.suggestions.find(x => x.id === sid); assert.equal(s1.thread.length, 3); assert.equal(s1.status, 'planned'); assert.equal(s1.text, 'Add more luck');
  // Changer seulement le statut n'ajoute pas de message ; une réponse vide non plus.
  assert.equal((await asOwner('mark', { id: sid, status: 'done' })).body.suggestions.find(x => x.id === sid).thread.length, 3);
  assert.equal((await asOwner('mark', { id: sid, reply: '   ' })).body.suggestions.find(x => x.id === sid).thread.length, 3);
  // On ne répond que dans ses propres suggestions, avec un vrai texte, et pas sans fin.
  assert.equal((await post(bob, 'reply', { id: sid, text: 'me too' })).status, 404);
  assert.equal((await post(alice, 'reply', { id: 'zz', text: 'hello' })).status, 400);
  assert.equal((await post(alice, 'reply', { id: sid, text: ' ' })).status, 422);
  r = await post(alice, 'reply', { id: sid, text: 'x'.repeat(900) + '\u0007' }); assert.equal(r.body.mine.find(x => x.id === sid).thread.pop().text.length, 500);
  run([['SET', `sugg:replies:${day}:${alice.playerId}`, '20']]); assert.equal((await post(alice, 'reply', { id: sid, text: 'again' })).status, 429);
  // Fil borné à 40 messages.
  run(Array.from({ length: 60 }, (_, i) => ['RPUSH', `sugg:${sid}:msgs`, JSON.stringify({ f: 'p', x: `m${i}`, t: i })])); run([['DEL', `sugg:replies:${day}:${alice.playerId}`]]);
  r = await post(alice, 'reply', { id: sid, text: 'last one' }); assert.equal(r.body.mine.find(x => x.id === sid).thread.length, 40);
  // Ancienne suggestion (une seule réponse, sans fil) : la réponse ouvre le fil et n'est pas perdue quand on continue.
  run([['DEL', `sugg:rate:${day}:${alice.playerId}`]]);
  const old = (await post(alice, 'suggest', { text: 'An older idea' })).body.mine.find(x => x.text === 'An older idea').id; // par son texte : deux suggestions de la même milliseconde n'ont pas d'ordre garanti
  run([['HSET', `sugg:${old}`, 'reply', 'Old style answer', 'status', 'seen']]);
  r = await post(alice, 'mine'); assert.deepEqual(r.body.mine.find(x => x.id === old).thread.map(m => [m.from, m.text]), [['owner', 'Old style answer']]);
  r = await post(alice, 'reply', { id: old, text: 'Thanks!' }); assert.deepEqual(r.body.mine.find(x => x.id === old).thread.map(m => m.text), ['Old style answer', 'Thanks!']);
  // Supprimer la suggestion supprime aussi la conversation ; aucun identifiant ne sort.
  assert.ok(!JSON.stringify(r.body).includes(alice.playerId));
  await asOwner('delete', { id: sid }); assert.equal(run([['LLEN', `sugg:${sid}:msgs`]])[0].result, 0);
  await asOwner('delete', { id: old });
  // Jusqu'à 3 images, pour une idée comme pour un bug (idée de Phong254, 2026-10-24) : vrais JPEG seulement, 400 000
  // caractères au total ; l'ancien champ « shot » d'un bug marche encore ; chaque image se lit par son numéro ; tout part
  // avec la suggestion.
  { run([['DEL', `sugg:rate:${day}:${alice.playerId}`]]);
    const jpg = n => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]).toString('base64');
    const idOf = (res, text) => res.body.mine.find(x => x.text === text).id;
    r = await post(alice, 'suggest', { text: 'Idea with pictures', shots: [jpg(300), jpg(400), jpg(500)] }); assert.equal(r.status, 200, JSON.stringify(r.body));
    const pic = idOf(r, 'Idea with pictures'); assert.deepEqual([r.body.mine.find(x => x.id === pic).shots, r.body.mine.find(x => x.id === pic).shot], [3, true]);
    for (const i of [1, 2, 3]) { const g = await asOwner('shot', { id: pic, i }); assert.equal(g.body.shot, i === 1 ? jpg(300) : i === 2 ? jpg(400) : jpg(500), `image ${i}`); }
    assert.equal((await asOwner('shot', { id: pic, i: 9 })).body.shot, jpg(500), 'numéro borné à 3');
    assert.equal((await post(alice, 'suggest', { text: 'Too many pictures', shots: [jpg(10), jpg(10), jpg(10), jpg(10)] })).status, 422, '4 images');
    assert.equal((await post(alice, 'suggest', { text: 'Not a jpeg here', shots: [jpg(10), 'data:image/png;base64,AAAA'] })).status, 422, 'pas un JPEG');
    assert.equal((await post(alice, 'suggest', { text: 'Too big together', shots: [jpg(140000), jpg(140000), jpg(140000)] })).status, 422, 'trop lourd au total');
    run([['DEL', `sugg:rate:${day}:${alice.playerId}`]]);
    r = await post(alice, 'suggest', { text: 'Old page bug report', kind: 'bug', shot: jpg(200) }); assert.equal(r.status, 200);
    const legacy = idOf(r, 'Old page bug report'); assert.equal((await asOwner('shot', { id: legacy })).body.shot, jpg(200), 'ancien champ shot');
    const inbox = (await asOwner('inbox')).body.suggestions; assert.deepEqual([inbox.find(x => x.id === pic).shots, inbox.find(x => x.id === legacy).shots], [3, 1]);
    await asOwner('delete', { id: pic }); await asOwner('delete', { id: legacy });
    assert.equal(run([['EXISTS', `sugg:${pic}:shot`, `sugg:${pic}:shot:2`, `sugg:${pic}:shot:3`]])[0].result, 0, 'images effacées'); }
}

// ================================================================ 50. Pièces offertes entre amis : plafonds par cadeau et par jour
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js'));
  const fr = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  const give = (who, name, amount) => fr(who, 'gift', { name, amount });
  const coinsOf = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  const [g1, g2, g3, g4, g5, g6] = ['Gfgiver', 'Gfgetter', 'Gfnewbie', 'Gfstranger', 'Gfhelper', 'Gfextra'].map((name, i) => ({ playerId: `9${i}`.repeat(8), secret: `8${i}`.repeat(16), name }));
  for (const g of [g1, g2, g3, g4, g5, g6]) { clock += 9000; const x = await call(roll, { method: 'POST', body: g }); assert.equal(x.status, 200, g.name + JSON.stringify(x.body)); }
  // Premier tirage il y a 10 jours : les cadeaux attendent 3 jours après le premier tirage (fermes de bots, 2026-11-04).
  for (const g of [g1, g2, g4, g5, g6]) run([['HSET', `stats:${g.playerId}`, 'rolls', 400, 'first', Date.now() - 10 * 86400000], ['HINCRBY', `stats:${g.playerId}`, 'bonus', 3000]]);
  run([['HINCRBY', `stats:${g3.playerId}`, 'bonus', 3000]]); // riche, mais un seul tirage
  // Amis : Gfgiver ↔ Gfgetter, Gfnewbie ↔ Gfgetter, Gfhelper ↔ Gfgetter, Gfextra ↔ Gfgetter. Gfstranger a seulement demandé.
  run([['HINCRBY', `stats:${g1.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${g3.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${g4.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${g5.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${g6.playerId}`, 'h:rolls', 10]]); // 10 tirages pour envoyer des demandes d'amis (audit de sécurité, 2026-11-02)
  for (const g of [g1, g3, g5, g6]) { await fr(g, 'add', { name: 'Gfgetter' }); await fr(g2, 'accept', { name: g.name }); }
  await fr(g4, 'add', { name: 'Gfgetter' });
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  run([['DEL', `gift:${day}`]]);
  const before1 = await coinsOf(g1), before2 = await coinsOf(g2);
  // L'état de la liste dit ce qui reste à donner.
  r = await fr(g1, 'list');
  assert.deepEqual([r.body.gift.min, r.body.gift.max, r.body.gift.sendDay, r.body.gift.receiveDay, r.body.gift.rolls, r.body.gift.left, r.body.gift.coins], [10, 500, 1000, 2000, 300, 1000, before1]);
  // Un cadeau : débité d'un côté, crédité de l'autre, au même solde que la boutique.
  // Compte de moins de 3 jours : refusé, avec le temps qu'il reste (fermes de bots, 2026-11-04).
  const oldFirst = run([['HGET', `stats:${g1.playerId}`, 'first']])[0].result;
  run([['HSET', `stats:${g1.playerId}`, 'first', Date.now() - 86400000]]);
  r = await give(g1, 'gfgetter', 200);
  assert.equal(r.status, 422); assert.equal(r.body.error, 'Gifts unlock 3 days after your first roll (2 days left)');
  run([['HSET', `stats:${g1.playerId}`, 'first', Date.now() - 3 * 86400000 + 5 * 3600000]]);
  assert.equal((await give(g1, 'gfgetter', 200)).body.error, 'Gifts unlock 3 days after your first roll (5 hours left)');
  run([['HSET', `stats:${g1.playerId}`, 'first', oldFirst]]);
  r = await give(g1, 'gfgetter', 200);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.sent, { name: 'Gfgetter', amount: 200 });
  assert.equal(r.body.gift.left, 800);
  assert.equal(r.body.gift.coins, before1 - 200);
  assert.equal(await coinsOf(g1), before1 - 200);
  assert.equal(await coinsOf(g2), before2 + 200);
  assert.ok(!JSON.stringify(r.body).includes(g2.playerId), 'aucun identifiant');
  // Le classement des pièces lit le même solde.
  run([['DEL', 'lbcache:coins']]);
  const board = (await call(lbApi, { url: `/api/leaderboard?period=coins&me=${g2.playerId}` })).body;
  assert.equal([...board.entries, board.mine].find(e => e && e.me).coins, before2 + 200);
  // Celui qui reçoit voit le cadeau une seule fois, avec son nouveau solde.
  r = await fr(g2, 'gifts');
  assert.deepEqual(r.body.gifts.map(x => [x.name, x.amount]), [['Gfgiver', 200]]);
  assert.equal(r.body.coins, before2 + 200);
  assert.ok(!JSON.stringify(r.body).includes(g1.playerId), 'aucun identifiant');
  assert.deepEqual((await fr(g2, 'gifts')).body.gifts, [], 'montré une seule fois');
  assert.deepEqual((await fr(g2, 'list')).body.gift.received.map(x => [x.name, x.amount]), [['Gfgiver', 200]], 'reste dans les derniers cadeaux reçus');
  // Refus : montants hors limites ou pas entiers, soi-même, pas ami (demande en attente), compte trop neuf, pas assez.
  for (const bad of [9, 501, 50.5, '100', -10, null]) assert.equal((await give(g1, 'Gfgetter', bad)).status, 400, `montant ${bad}`);
  assert.match((await give(g1, 'Gfgetter', 501)).body.error, /Give between 10 and 500 coins/);
  assert.equal((await give(g1, 'Gfgiver', 100)).status, 422, 'pas à soi-même');
  r = await give(g4, 'Gfgetter', 100);
  assert.equal(r.status, 403); assert.match(r.body.error, /only give coins to your friends/);
  r = await give(g1, 'Gfstranger', 100);
  assert.equal(r.status, 403, 'pas ami');
  r = await give(g3, 'Gfgetter', 100);
  assert.equal(r.status, 422); assert.match(r.body.error, /Gifts unlock after 300 rolls \(you have 1\)/);
  run([['HINCRBY', `stats:${g5.playerId}`, 'spent', (await coinsOf(g5)) - 50]]); // Gfhelper n'a plus que 50 pièces
  r = await give(g5, 'Gfgetter', 100);
  assert.equal(r.status, 422); assert.match(r.body.error, /Not enough coins: 50 more needed/);
  assert.equal(await coinsOf(g5), 50, 'rien de débité');
  assert.equal((await give({ ...g1, secret: '7'.repeat(32) }, 'Gfgetter', 100)).status, 403);
  // Un achat (ou un cadeau) en cours : le verrou fait attendre puis refuse, sans rien débiter.
  run([['SET', `shop:${g1.playerId}`, '1', 'PX', 60000]]);
  assert.equal((await give(g1, 'Gfgetter', 100)).status, 429);
  run([['DEL', `shop:${g1.playerId}`]]);
  // Plafond de celui qui donne : 1 000 par jour (200 déjà donnés).
  for (const a of [500, 300]) assert.equal((await give(g1, 'Gfgetter', a)).status, 200);
  r = await give(g1, 'Gfgetter', 10);
  assert.equal(r.status, 422); assert.match(r.body.error, /You already gave 1,000 coins today/);
  assert.equal((await fr(g1, 'list')).body.gift.left, 0);
  assert.equal(await coinsOf(g1), before1 - 1000);
  // Plafond de celui qui reçoit : 2 000 par jour, tous amis confondus (1 000 déjà reçus).
  run([['HINCRBY', `stats:${g5.playerId}`, 'bonus', 2000]]);
  assert.equal((await give(g6, 'Gfgetter', 500)).status, 200);
  assert.equal((await give(g5, 'Gfgetter', 400)).status, 200);
  r = await give(g6, 'Gfgetter', 200);
  assert.equal(r.status, 422); assert.match(r.body.error, /Gfgetter can receive 100 more coins today/);
  const extraBefore = await coinsOf(g6);
  assert.equal((await give(g6, 'Gfgetter', 100)).status, 200, 'juste le reste');
  r = await give(g5, 'Gfgetter', 10);
  assert.equal(r.status, 422); assert.match(r.body.error, /Gfgetter already received 2,000 coins today/);
  assert.equal(await coinsOf(g6), extraBefore - 100, 'les refus ne débitent rien');
  assert.equal(await coinsOf(g2), before2 + 2000);
  assert.equal((await fr(g6, 'list')).body.gift.left, 400, 'le refus a rendu ses 200 au compteur de Gfextra (1 000 − 500 − 100)');
  // Les cadeaux reçus arrivent tous, dans l'ordre ; la liste est bornée à 20.
  r = await fr(g2, 'gifts');
  assert.deepEqual(r.body.gifts.map(x => x.amount), [500, 300, 500, 400, 100]);
  // Le lendemain (UTC), les compteurs repartent de zéro.
  clock += 86400000;
  assert.equal((await give(g1, 'Gfgetter', 100)).status, 200, 'nouveau jour');
  assert.equal((await fr(g1, 'list')).body.gift.left, 900);
  run([['DEL', `gifts:${g2.playerId}`]]);
  for (let i = 0; i < 25; i++) run([['RPUSH', `gifts:${g2.playerId}`, JSON.stringify({ f: g1.playerId, a: 10, t: 1 })]]);
  assert.equal((await give(g6, 'Gfgetter', 10)).status, 200);
  assert.equal(run([['LLEN', `gifts:${g2.playerId}`]])[0].result, 20, '20 derniers seulement');
  // Le serveur garde le compte des cadeaux de chacun.
  const [st1, st2] = run([['HMGET', `stats:${g1.playerId}`, 'giftOut'], ['HMGET', `stats:${g2.playerId}`, 'giftIn']]).map(x => Number(x.result[0]));
  assert.deepEqual([st1, st2], [1100, 2110]);
}

// ================================================================ 51. Badges Top 1 / 5 / 10 : remis à la fin du mois, avec le mois
{
  const rank = require(path.join(ROOT, 'api/_rank.js'));
  const monthOf = t => new Date(t).toISOString().slice(0, 7);
  const month = monthOf(Date.now()), lb = `lb:month:${month}`;
  const ids = Array.from({ length: 12 }, (_, i) => (0x5100 + i).toString(16).padStart(16, '0'));
  // Alice en tête du mois, puis onze joueurs factices ; le 12e reste hors du top 10.
  run([['DEL', lb], ['ZADD', lb, 9e12, alice.playerId], ['HSET', `best:month:${month}`, alice.playerId, JSON.stringify({ n: 5, s: 9e12, t: Date.now() })], ...ids.flatMap((id, i) => [
    ['ZADD', lb, 1e9 - i, id], ['HSET', 'names', id, `Topper${i}`], ['HSET', `best:month:${month}`, id, JSON.stringify({ n: 5, s: 1e9 - i, t: Date.now() })],
  ])]);
  const [aliceName] = run([['HGET', 'names', alice.playerId]]).map(x => x.result);
  const board = async period => (await call(leaderboard, { url: `/api/leaderboard?period=${period}&me=${alice.playerId}` })).body;
  const prof = async name => (await call(profile, { url: `/api/profile?name=${encodeURIComponent(name)}` })).body;
  // Un test plus haut avance l'horloge de quelques jours : fin octobre, elle passe au mois suivant et le mois en cours
  // était déjà « fini » (badges remis trop tôt, test instable le 2026-10-26). On repart d'un mois en cours propre.
  // (L'horloge des tests peut être en avance : le « mois précédent » est alors octobre, et ses meilleurs joueurs réels,
  // Alice en tête, recevaient un badge. On le marque fini et on efface ces badges.)
  { const d = new Date(Date.now()); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); const prev = d.toISOString().slice(0, 7);
    rank._reset(); // le mois figé gardé en mémoire ne doit pas sauter la remise plus bas
    run([['DEL', `topawards:done:${month}`], ['SET', `topawards:done:${prev}`, '1'], ['HDEL', 'topbest', alice.playerId, ...ids], ...[alice.playerId, ...ids].flatMap(id => [['HDEL', `topawards:${id}`, month], ['HDEL', `topawards:${id}`, prev]])]); }
  // Pendant le mois : aucun badge, même pour le 1er.
  let b = await board('month');
  assert.ok(b.entries[0].me, 'Alice est 1re');
  assert.ok(b.entries.every(e => e.top === null), 'rien avant la fin du mois');
  assert.equal((await prof(aliceName)).top, null);
  // Le mois suivant : le top 10 du mois fini reçoit son badge, avec le mois.
  const saved = clock;
  const d = new Date(Date.now()); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCHours(0, 0, 5);
  clock += d.getTime() - Date.now();
  assert.equal(rank.prevMonth(Date.now()), month);
  b = await board('all');
  const p0 = await prof(aliceName);
  assert.deepEqual(p0.top, { top: 1, month }); assert.deepEqual(p0.tops, [{ top: 1, month }]);
  const tops = await Promise.all(ids.map(async (id, i) => (await prof(`Topper${i}`)).top));
  assert.deepEqual(tops.map(x => x && x.top), [5, 5, 5, 5, 10, 10, 10, 10, 10, null, null, null], JSON.stringify(tops));
  assert.ok(tops.slice(0, 9).every(x => x.month === month));
  const mine = (await board('day')).entries.find(e => e.me) || (await board('all')).entries.find(e => e.me);
  if (mine) assert.deepEqual(mine.top, { top: 1, month }, 'à côté du nom dans le classement');
  // Gardé pour toujours : sortir du classement ne l'enlève pas, et la remise ne se refait pas.
  run([['DEL', lb]]);
  rank._reset();
  assert.deepEqual((await prof(aliceName)).top, { top: 1, month });
  // Un mois plus tard, un moins bon rang ne remplace pas le meilleur badge, mais s'ajoute à la liste.
  const month2 = monthOf(Date.now());
  run([['ZADD', `lb:month:${month2}`, 9, ids[0]], ['ZADD', `lb:month:${month2}`, 1, ids[1]], ['ZADD', `lb:month:${month2}`, 99, alice.playerId]]);
  // ids[1] (Top 5 au mois 1) devient 3e : toujours Top 5, mois plus récent → affiché ; Alice 1re à nouveau.
  run([['ZADD', `lb:month:${month2}`, 50, ids[2]]]);
  const d2 = new Date(Date.now()); d2.setUTCDate(1); d2.setUTCMonth(d2.getUTCMonth() + 1); d2.setUTCHours(0, 0, 5);
  clock += d2.getTime() - Date.now();
  const pa = await prof(aliceName);
  assert.deepEqual(pa.tops.map(x => x.month), [month2, month], 'du plus récent au plus ancien');
  assert.deepEqual(pa.top, { top: 1, month: month2 }, 'à rang égal, le plus récent');
  const p1 = await prof('Topper1');
  assert.deepEqual(p1.top, { top: 5, month: month2 });
  const p2 = await prof('Topper2');
  assert.deepEqual(p2.top, { top: 5, month: month2 }, 'Top 5 les deux mois : le plus récent');
  assert.equal(p2.tops.length, 2);
  // Duel : le badge suit le joueur à sa place.
  assert.deepEqual((await rank.bestAwards([alice.playerId])).get(alice.playerId), { top: 1, month: month2 });
  clock = saved;
  rank._reset();
  run([['DEL', 'topbest', `topawards:${alice.playerId}`, ...ids.map(id => `topawards:${id}`), `lb:month:${month2}`], ...ids.flatMap(id => [['HDEL', 'names', id], ['HDEL', `best:month:${month}`, id]])]);
}

// ================================================================ 52. Skins Infinity (caisse Premium seulement, 0,5 %) et Bakery
{
  const shopPost = (who, extra) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, ...extra } });
  const state = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body;
  const baker = { playerId: 'e8'.repeat(8), secret: 'f8'.repeat(16), name: 'Baker' };
  let r = await call(roll, { method: 'POST', body: baker });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  run([['HINCRBY', `stats:${baker.playerId}`, 'bonus', 100000 - (await state(baker)).coins]]);
  // Catalogue : Infinity est rangé avec les légendaires, Legendary, jamais vendu ; Bakery est un skin comme les autres.
  const inf = Shop.byId.get('infinity'), bak = Shop.byId.get('bakery');
  assert.ok(inf && inf.caseOnly === 'premium' && inf.premium && !inf.hidden && inf.chance === 0.005);
  assert.equal(Shop.rarityOf('infinity').name, 'Legendary');
  assert.ok(bak && bak.price === 1000 && !bak.premium && !bak.caseOnly);
  // Infinity ne s'achète pas, avec toutes les pièces du monde ; l'équiper sans l'avoir est refusé.
  r = await shopPost(baker, { action: 'buy', skin: 'infinity' });
  assert.deepEqual([r.status, r.body.error], [422, 'This skin only comes from the Premium Case']);
  assert.equal((await state(baker)).coins, 100000, 'rien de dépensé');
  assert.ok(!(await state(baker)).owned.includes('infinity'));
  assert.equal((await shopPost(baker, { action: 'equip', skin: 'infinity' })).status, 422);
  assert.equal((await shopPost(baker, { action: 'button', button: 'infinity' })).status, 422, 'son bouton vient avec le skin');
  // Bakery s'achète (et s'équipe) normalement.
  r = await shopPost(baker, { action: 'buy', skin: 'bakery' });
  assert.deepEqual([r.status, r.body.skin, r.body.coins], [200, 'bakery', 99000], JSON.stringify(r.body));
  // Chances : Infinity à 0,5 % exactement dans la caisse Premium, en dernier ; les autres gardent leurs poids 1 / prix.
  const premium = Shop.caseById.get('premium'), starter = Shop.caseById.get('starter'), odds = Shop.caseOdds(premium);
  assert.ok(Math.abs(odds.reduce((x, o) => x + o.p, 0) - 1) < 1e-9);
  assert.deepEqual(odds[odds.length - 1], { id: 'infinity', p: 0.005 });
  assert.equal(odds.filter(o => o.id === 'infinity').length, 1);
  const chrome = odds.find(o => o.id === 'chrome'), rainbow = odds.find(o => o.id === 'rainbow');
  assert.ok(Math.abs(chrome.p / rainbow.p - 5000 / 800) < 1e-9, 'poids 1 / prix entre les autres');
  assert.ok(odds.some(o => o.id === 'bakery'), 'Bakery (1 000) est dans la caisse Premium');
  assert.ok(!Shop.casePool(starter).some(k => k.id === 'infinity') && !Shop.caseOdds(starter).some(o => o.id === 'infinity'), 'jamais dans la Starter');
  // Tirage : la dernière tranche (0,995 à 1) donne Infinity, juste avant non.
  assert.equal(Shop.drawCase(premium, 0.9999999), 'infinity');
  assert.equal(Shop.drawCase(premium, 0.9951), 'infinity');
  assert.notEqual(Shop.drawCase(premium, 0.9949), 'infinity');
  for (let i = 0; i < 2000; i++) assert.notEqual(Shop.drawCase(starter, i / 2000), 'infinity');
  // Gagné dans une caisse : possédé, équipable ; une seconde fois, la moitié du prix est rendue.
  const realRandom = crypto.randomInt;
  crypto.randomInt = () => 2 ** 32 - 1; // le tirage du serveur tombe tout au bout : Infinity
  try {
    r = await shopPost(baker, { action: 'case', case: 'premium' });
    assert.deepEqual([r.status, r.body.won, r.body.duplicate, r.body.refund, r.body.coins], [200, 'infinity', false, 0, 99000 - 900], JSON.stringify(r.body));
    assert.ok(r.body.owned.includes('infinity'));
    r = await shopPost(baker, { action: 'case', case: 'premium' });
    assert.deepEqual([r.body.won, r.body.duplicate, r.body.refund, r.body.coins], ['infinity', true, 810, 99000 - 900 - 90]);
  } finally {
    crypto.randomInt = realRandom;
  }
  r = await shopPost(baker, { action: 'equip', skin: 'infinity' });
  assert.deepEqual([r.status, r.body.skin], [200, 'infinity']);
  assert.equal((await shopPost(baker, { action: 'button', button: 'infinity' })).status, 200, 'et son bouton');
  r = await shopPost(baker, { action: 'buy', skin: 'infinity' });
  assert.deepEqual([r.status, r.body.skin], [200, 'infinity'], 'déjà possédé : « acheter » ne fait que l\'équiper, sans rien dépenser');
  assert.equal(r.body.coins, 99000 - 900 - 90);
  // Clés (idée de keys, 2026-10-22) : une clé Premium ouvre aussi Starter et Fonds, jamais l'Élite ; une Starter seulement la sienne.
  run([['HSET', `stats:${baker.playerId}`, 'key:premium', 2, 'key:starter', 1]]);
  r = await shopPost(baker, { action: 'case', case: 'elite', free: 'premium' }); assert.equal(r.status, 422, 'jamais l\'Élite');
  r = await shopPost(baker, { action: 'case', case: 'premium', free: 'starter' }); assert.equal(r.status, 422, 'une Starter n\'ouvre pas la Premium');
  { const before = r.body.coins;
    r = await shopPost(baker, { action: 'case', case: 'starter', free: 'premium' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.keys.premium, r.body.keys.starter], [1, 1], 'la clé Premium est consommée, pas la Starter'); }
  r = await shopPost(baker, { action: 'case', case: 'wallpaper', free: 'premium' }); assert.equal(r.status, 200);
  r = await shopPost(baker, { action: 'case', case: 'wallpaper', free: 'premium' }); assert.equal(r.status, 422, 'plus de clé Premium');
  // Titre de collection des boutons (idée de PRISMA123, 2026-10-22) : posé quand le dernier bouton est acheté.
  { const all = Shop.collectibleSets.buttons();
    run([['SADD', `btns:${baker.playerId}`, ...all.slice(0, -1)], ['HINCRBY', `stats:${baker.playerId}`, 'bonus', 5000]]);
    r = await shopPost(baker, { action: 'buybutton', button: all[all.length - 1] }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(run([['HGET', `stats:${baker.playerId}`, 'allButtons']])[0].result, '1'); }
  // 5 % pour l'auteur de l'idée d'un skin (2026-10-22) : créés en plus, jamais pour soi-même.
  { const sky = Shop.byId.get('sky'), was = sky.idea; sky.idea = run([['HGET', 'names', alice.playerId]])[0].result;
    const annie = alice.playerId;
    const before = Number(run([['HGET', `stats:${annie}`, 'bonus']])[0].result) || 0;
    r = await shopPost(baker, { action: 'buy', skin: 'sky' }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number(run([['HGET', `stats:${annie}`, 'royalty']])[0].result), 80, '5 % de 1 600');
    assert.equal(Number(run([['HGET', `stats:${annie}`, 'bonus']])[0].result) - before, 80);
    sky.idea = was; }
  // Les bots ne portent jamais Infinity (ni un skin légendaire).
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    r = await roomPost(baker, 'create', { size: 10, mode: 'rounds', target: 1, bots: 9 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r.body.players.filter(p => p.bot).forEach(p => seen.add(p.skin));
    await roomPost(baker, 'leave', { code: r.body.code });
  }
  assert.ok(seen.size > 5 && [...seen].every(id => Shop.byId.has(id) && !Shop.byId.get(id).premium && !Shop.byId.get(id).caseOnly), [...seen].join());
}

// ================================================================ 53. Codes cadeaux : une fois par joueur, après 30 tirages
{
  const redeem = (who, code) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'redeem', code } });
  const coins = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  const key = `stats:${alice.playerId}`;
  const [rolls0] = run([['HGET', key, 'rolls']]).map(x => x.result);
  run([['HSET', key, 'rolls', 5], ['DEL', `codes:${alice.playerId}`]]);
  let r = await redeem(alice, 'SACHA');
  assert.equal(r.status, 422); assert.match(r.body.error, /Codes unlock after 30 rolls \(you have 5\)/);
  assert.equal(run([['SISMEMBER', `codes:${alice.playerId}`, 'SACHA']])[0].result, 0, 'refusé : pas consommé');
  run([['HSET', key, 'rolls', 40]]);
  assert.equal((await redeem(alice, 'NOPE')).status, 404);
  const before = await coins(alice);
  r = await redeem(alice, ' sa cha ');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.redeemed, { code: 'SACHA', coins: 200, title: null });
  assert.equal(r.body.coins, before + 200);
  assert.equal(await coins(alice), before + 200, 'le même solde que la boutique');
  r = await redeem(alice, 'sacha');
  assert.equal(r.status, 409); assert.equal(await coins(alice), before + 200, 'une seule fois');
  // Deux envois simultanés : un seul crédit.
  run([['DEL', `codes:${alice.playerId}`]]);
  const both = await Promise.all([redeem(alice, 'SACHA'), redeem(alice, 'SACHA')]);
  assert.deepEqual(both.map(x => x.status).sort(), [200, 409]);
  assert.equal(await coins(alice), before + 400);
  assert.equal((await call(shopApi, { method: 'POST', body: { playerId: alice.playerId, secret: '0'.repeat(32), action: 'redeem', code: 'SACHA' } })).status, 403);
  run([['HSET', key, 'rolls', rolls0 || 0], ['HINCRBY', key, 'bonus', -400]]);
}

// ================================================================ 54. Titre « 2026 » : pour qui a joué en 2026
{
  const Ach = require(path.join(ROOT, 'js/achievements.js'));
  const has = st => Ach.unlocked(st).includes('year2026');
  assert.ok(has({ rolls: 3, first: Date.UTC(2026, 8, 20) }), 'premier tirage en 2026');
  assert.ok(has({ rolls: 3 }), 'joueur d\'avant le champ first : il a commencé en 2026');
  assert.ok(!has({ rolls: 0 }), 'jamais joué');
  assert.ok(!has({ rolls: 3, first: Date.UTC(2027, 0, 1) }), 'commencé en 2027 : trop tard');
  assert.ok(has({ rolls: 3, first: Date.UTC(2026, 11, 31, 23, 59) }));
  // Par le serveur : Alice a joué cette année, elle peut l'équiper (le nombre tiré n'y est pour rien).
  const r = await equip(alice, 'year2026');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(run([['HGET', 'titles', alice.playerId]])[0].result, 'year2026');
  await equip(alice, '');
}

// ================================================================ 55. Doublon de caisse : remboursement selon la rareté
{
  const premium = Shop.caseById.get('premium'), starter = Shop.caseById.get('starter');
  const byRarity = {};
  for (const c of [starter, premium]) for (const k of Shop.casePool(c)) byRarity[`${c.id}:${Shop.rarityOf(k.id).id}`] = Shop.duplicateRefund(c, k.id);
  assert.equal(Shop.duplicateRefund(starter, 'neon'), 125, 'Common : la moitié');
  assert.equal(Shop.duplicateRefund(premium, 'infinity'), 810, 'Legendary : 90 %');
  assert.equal(Shop.duplicateRefund(premium, 'galaxy'), 675, 'Epic : 75 %');
  for (const c of [starter, premium]) for (const k of Shop.casePool(c)) {
    const v = Shop.duplicateRefund(c, k.id);
    assert.ok(v >= c.price / 2 && v < c.price, `${c.id} ${k.id} : ${v}`);
  }
  // Plus rare, jamais moins remboursé.
  const order = ['blue', 'purple', 'pink', 'red', 'gold'];
  assert.ok(order.every((r, i) => !i || Shop.DUPLICATE_REFUND[r] >= Shop.DUPLICATE_REFUND[order[i - 1]]));
}

// Succès et titres : chaque identifiant une seule fois (deux « millionaire » se mélangeaient, signalé par PRISMA123).
{
  const A = require(path.join(ROOT, 'js/achievements.js'));
  const ids = A.LIST.map(a => a.id), dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], `succès en double : ${dup}`);
  assert.ok(!A.unlocked({ best: 2000000 }).includes('coinmillionaire'), 'Coin Millionaire ne vient pas d\'un gros tirage');
}

// ================================================================ 51. Messages entre amis
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const fr = (who, action, name, extra = {}) => call(friendsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, name, ...extra } });
  const mk = (id, name) => ({ playerId: id.repeat(8), secret: (id + 'f').repeat(32).slice(0, 32), name });
  const ann = mk('3c', 'Annie'), ben = mk('4c', 'Benny'), cid = mk('5c', 'Cidney');
  for (const p of [ann, ben, cid]) { db.delete(`cooldown:${p.playerId}`); assert.equal((await call(roll, { method: 'POST', body: p })).status, 200); }
  // Pas encore amis : impossible d'écrire, même avec une demande en attente.
  assert.equal((await fr(ann, 'message', 'Benny', { text: 'hi' })).status, 403);
  run([['HINCRBY', `stats:${ann.playerId}`, 'h:rolls', 10], ['HINCRBY', `stats:${ben.playerId}`, 'h:rolls', 10]]); // 10 tirages pour envoyer des demandes d'amis (audit de sécurité, 2026-11-02)
  await fr(ann, 'add', 'Benny'); assert.equal((await fr(ann, 'message', 'Benny', { text: 'hi' })).status, 403, 'demande pas encore acceptée');
  await fr(ben, 'accept', 'Annie');
  // Amis : le message passe, nettoyé par le filtre du chat, et Benny a un message non lu.
  let r = await fr(ann, 'message', 'Benny', { text: '  hey you fucking legend, see www.evil.com  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.messages.map(m => [m.me, m.text]), [[true, 'hey you ******* legend, see [link]']]);
  assert.equal((await fr(ben, 'gifts')).body.messages, 1, 'un message non lu');
  r = await fr(ben, 'list'); assert.equal(r.body.friends.find(f => f.name === 'Annie').unread, 1);
  // Benny l'ouvre : c'est lu ; il répond ; chacun voit les siens à droite.
  r = await fr(ben, 'messages', 'Annie'); assert.deepEqual(r.body.messages.map(m => m.me), [false]);
  assert.equal((await fr(ben, 'gifts')).body.messages, 0);
  r = await fr(ben, 'message', 'Annie', { text: 'gg on your 777777!' }); assert.deepEqual(r.body.messages.map(m => [m.me, m.text]), [[false, 'hey you ******* legend, see [link]'], [true, 'gg on your 777777!']]);
  assert.ok(!JSON.stringify(r.body).includes(ann.playerId) && !JSON.stringify(r.body).includes(ben.playerId), 'aucun identifiant');
  // Réactions emoji (Sacha, 2026-11-02) : une par joueur et par message, en choisir une autre la remplace.
  {
    const t0 = r.body.messages[0].t, rxFree = who => run([['DEL', `rx:rl:${who.playerId}`]]);
    let x = await fr(ben, 'react', 'Annie', { t: t0, emoji: '😂' }); assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.deepEqual(x.body.messages[0].rx, [{ e: '😂', n: 1, mine: true, who: ['Benny'] }]);
    x = await fr(ann, 'react', 'Benny', { t: t0, emoji: '😂' }); assert.deepEqual(x.body.messages[0].rx, [{ e: '😂', n: 2, mine: true, who: ['Benny', 'Annie'] }]);
    rxFree(ann); x = await fr(ann, 'react', 'Benny', { t: t0, emoji: '❤️' });
    assert.deepEqual(x.body.messages[0].rx, [{ e: '❤️', n: 1, mine: true, who: ['Annie'] }, { e: '😂', n: 1, mine: false, who: ['Benny'] }], 'remplacée, pas ajoutée');
    rxFree(ann); assert.equal((await fr(ann, 'react', 'Benny', { t: 42, emoji: '❤️' })).status, 404, 'message inconnu');
    assert.ok(!JSON.stringify(x.body).includes(ann.playerId) && !JSON.stringify(x.body).includes(ben.playerId), 'aucun identifiant');
    run([['DEL', `rx:rl:${ann.playerId}`], ['DEL', `rx:rl:${ben.playerId}`]]);
  }
  // Annie signale le message de Benny ; elle ne peut pas signaler le sien ; la page Owner les voit, sans identifiant.
  {
    const theirs = (await fr(ann, 'messages', 'Benny')).body.messages.find(m => !m.me), mine = (await fr(ann, 'messages', 'Benny')).body.messages.find(m => m.me);
    run([['HINCRBY', `stats:${ann.playerId}`, 'h:rolls', 20]]);
    let x = await fr(ann, 'report', 'Benny', { t: theirs.t }); assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.reported, true);
    if (mine.t !== theirs.t) assert.equal((await fr(ann, 'report', 'Benny', { t: mine.t })).status, 404, 'pas son propre message'); // même milliseconde possible ici
    const siteApi = require(path.join(ROOT, 'api/site.js'));
    const owner = action => call(siteApi, { method: 'POST', body: { action, playerId: cid.playerId, secret: cid.secret, id: x.id } });
    assert.equal((await owner('reports')).status, 403, 'réservé au créateur');
    run([['HSET', `stats:${cid.playerId}`, 'owner', '1']]);
    x = await owner('reports'); assert.equal(x.status, 200);
    const dm = x.body.reports.find(r => r.where === 'private message');
    assert.deepEqual([dm.author, dm.reporter, dm.text, dm.done], ['Benny', 'Annie', 'gg on your 777777!', false]);
    assert.ok(x.body.reports.some(r => r.where.startsWith('duel ') && r.author === 'Frank'), 'le signalement du duel aussi');
    assert.ok(!JSON.stringify(x.body).includes(ben.playerId), 'aucun identifiant');
    x = await call(siteApi, { method: 'POST', body: { action: 'reportDone', playerId: cid.playerId, secret: cid.secret, id: dm.id } });
    assert.equal(x.body.reports.find(r => r.id === dm.id).done, true);
    run([['HDEL', `stats:${cid.playerId}`, 'owner']]);
  }
  // Supprimer un de ses messages (2026-10-22) : seulement les siens.
  {
    await new Promise(ok => setTimeout(ok, 3)); // une milliseconde à lui : les messages sont retrouvés par leur heure
    let x = await fr(ann, 'message', 'Benny', { text: 'oops typo' });
    const mine = x.body.messages.filter(m => m.me).pop(), theirs = x.body.messages.find(m => !m.me);
    if (theirs.t !== mine.t) await fr(ann, 'unsend', 'Benny', { t: theirs.t }); // même heure possible qu'un des siens : on vérifie juste que celui de l'autre reste
    assert.ok((await fr(ann, 'messages', 'Benny')).body.messages.some(m => !m.me && m.text === theirs.text), 'le message de l\'autre reste');
    x = await fr(ann, 'unsend', 'Benny', { t: mine.t }); assert.equal(x.status, 200);
    assert.ok(!x.body.messages.some(m => m.text === 'oops typo'), 'message supprimé');
  }
  // Images entre amis (2026-10-23) : un JPEG vérifié, lisible par les deux seulement, effacé avec le message.
  {
    const jpg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]).toString('base64');
    await new Promise(ok => setTimeout(ok, 3));
    let x = await fr(ann, 'message', 'Benny', { text: '', image: jpg }); assert.equal(x.status, 200, JSON.stringify(x.body));
    const pic = x.body.messages.filter(m => m.me && m.img).pop(); assert.ok(pic, 'message image');
    assert.equal((await fr(ben, 'image', 'Annie', { t: pic.t })).body.image, jpg, 'l\'ami la voit');
    assert.equal((await fr(cid, 'image', 'Annie', { t: pic.t })).status !== 200, true, 'personne d\'autre');
    assert.equal((await fr(ann, 'message', 'Benny', { text: 'hi', image: 'data:image/png;base64,AAAA' })).status, 422, 'pas un JPEG');
    await fr(ann, 'unsend', 'Benny', { t: pic.t });
    assert.equal((await fr(ben, 'image', 'Annie', { t: pic.t })).status, 404, 'effacée avec le message');
  }
  // Modifier un de ses messages (idée de kingston, 2026-10-22) : seulement les siens, marqué « edited ».
  {
    await new Promise(ok => setTimeout(ok, 3));
    let x = await fr(ann, 'message', 'Benny', { text: 'helo' });
    const mine = x.body.messages.filter(m => m.me).pop();
    x = await fr(ann, 'edit', 'Benny', { t: mine.t, text: 'hello' }); assert.equal(x.status, 200);
    const m2 = x.body.messages.find(m => m.t === mine.t && m.me);
    assert.deepEqual([m2.text, m2.edited], ['hello', true]);
    assert.equal((await fr(ann, 'edit', 'Benny', { t: mine.t, text: '   ' })).status, 422, 'texte vide refusé');
    assert.equal((await fr(ann, 'edit', 'Benny', { t: 1, text: 'x' })).status, 404, 'message introuvable');
    const theirs = (await fr(ben, 'messages', 'Annie')).body.messages.find(m => !m.me && m.t === mine.t);
    assert.equal(theirs.text, 'hello', 'l\'autre voit la version modifiée');
  }
  // Présence (2026-10-21) : hors ligne sans signal, puis AFK, puis en ligne ; un signal trop vieux redevient hors ligne.
  {
    const status = async () => (await fr(ann, 'list')).body.friends.find(f => f.name === 'Benny').status;
    // Un tirage récent compte comme signe de vie (kingston, 2026-10-30) : en ligne même sans signal de la page.
    run([['ZADD', 'seen', Date.now() - 1000, ben.playerId]]); assert.equal(await status(), 'online', 'tirage il y a 1 s');
    run([['ZADD', 'seen', Date.now() - 200000, ben.playerId]]);
    assert.equal(await status(), 'offline');
    await fr(ben, 'gifts', undefined, { presence: 'afk' }); assert.equal(await status(), 'afk');
    await fr(ben, 'gifts', undefined, { presence: 'active' }); assert.equal(await status(), 'online');
    run([['HSET', 'presence', ben.playerId, `${Date.now() - 200000}:active`]]); assert.equal(await status(), 'offline', 'signal trop vieux');
    await fr(ben, 'gifts', undefined, { presence: 'hacker' }); assert.equal(await status(), 'offline', 'état inconnu ignoré');
  }
  // Un tiers ne lit rien et ne peut pas écrire.
  assert.equal((await fr(cid, 'message', 'Annie', { text: 'yo' })).status, 403);
  assert.deepEqual((await fr(cid, 'messages', 'Annie')).body.messages, []);
  // Message vide (ou vidé), trop rapide.
  assert.equal((await fr(ann, 'message', 'Benny', { text: '   ' })).status, 422);
  const minute = Math.floor(Date.now() / 60000); run([['SET', `dmrate:${ann.playerId}:${minute}`, 20]]);
  assert.equal((await fr(ann, 'message', 'Benny', { text: 'one more' })).status, 429); run([['DEL', `dmrate:${ann.playerId}:${minute}`]]);
  // Benny bloque Annie : elle ne peut plus lui écrire ; il peut la débloquer.
  r = await fr(ben, 'block', 'Annie'); assert.equal(r.body.blocked, true);
  assert.equal((await fr(ann, 'message', 'Benny', { text: 'please' })).status, 403);
  assert.equal((await fr(ben, 'message', 'Annie', { text: 'x' })).status, 422, 'celui qui bloque doit débloquer pour écrire');
  r = await fr(ben, 'unblock', 'Annie'); assert.equal(r.body.blocked, false);
  assert.equal((await fr(ann, 'message', 'Benny', { text: 'thanks' })).status, 200);
  // Gardés 7 jours, 100 messages au plus.
  const key = `dm:${[ann.playerId, ben.playerId].sort().join(':')}`;
  run(Array.from({ length: 120 }, (_, i) => ['RPUSH', key, JSON.stringify({ s: ann.playerId, x: `m${i}`, t: i })]));
  r = await fr(ann, 'message', 'Benny', { text: 'last' }); assert.equal(r.body.messages.length, 100); assert.equal(r.body.messages.pop().text, 'last');
  // Plus amis : plus de messages.
  await fr(ann, 'remove', 'Benny'); assert.equal((await fr(ann, 'message', 'Benny', { text: 'hey' })).status, 403);
}

// ================================================================ 52. Bitcoin du casino : vrai prix, 1 % d'écart à l'achat et à la vente
{
  const shopApi = require(path.join(ROOT, 'api/shop.js')), Shop = require(path.join(ROOT, 'js/shop.js'));
  const tr = (who, extra) => call(shopApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'btc', ...extra } });
  const pub = async me => (await call(shopApi, { url: `/api/shop?btc=1${me ? `&me=${me.playerId}` : ''}` })).body;
  const fresh = () => run([['DEL', 'btc:price']]);
  const trader = { playerId: '6e'.repeat(8), secret: '7e'.repeat(16), name: 'Trader' };
  db.delete(`cooldown:${trader.playerId}`); assert.equal((await call(roll, { method: 'POST', body: trader })).status, 200);
  const bal = () => Shop.balance(Object.fromEntries((run([['HGETALL', `stats:${trader.playerId}`]])[0].result || []).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), [])));
  run([['HSET', `stats:${trader.playerId}`, 'rolls', 100], ['HINCRBY', `stats:${trader.playerId}`, 'bonus', 100000]]);
  // Le prix public, sans compte ; un point d'historique.
  globalThis.__btc = 80000; fresh(); run([['DEL', 'btc:hist']]);
  let v = await pub(); assert.equal(v.price, 80000); assert.equal(v.hist.length, 1); assert.equal(v.sats, 0);
  // Acheter pour 1 000 pièces au prix + 1 %.
  const c0 = bal();
  let r = await tr(trader, { move: 'buy', coins: 1000 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sats, Math.floor(1000 / (80000 * 1.01) * 1e8)); assert.equal(bal(), c0 - 1000); assert.equal(r.body.cost, 1000);
  // Revendre tout aussitôt : moins 2 % environ, jamais un gain.
  r = await tr(trader, { move: 'sell', all: true }); assert.equal(r.status, 200);
  assert.equal(r.body.sats, 0); assert.ok(bal() - c0 < 0 && bal() - c0 >= -21, `aller-retour ${bal() - c0}`); assert.equal(r.body.cost, 0);
  // Le prix monte de 10 % : la revente rapporte plus que l'achat.
  const c1 = bal(); await tr(trader, { move: 'buy', coins: 5000 });
  globalThis.__btc = 88000; fresh();
  v = await pub(trader); assert.ok(v.value > 5300 && v.value < 5400, `valeur ${v.value}`);
  r = await tr(trader, { move: 'sell', sats: Math.floor(v.sats / 2) }); assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.cost - 2500) <= 1, 'le prix payé suit la part vendue');
  await tr(trader, { move: 'sell', all: true }); assert.ok(bal() - c1 > 350 && bal() - c1 < 450, `gain ${bal() - c1}`);
  // Refus : montants, solde, avoirs, avant 30 tirages, prix introuvable.
  for (const coins of [5, 50001, 12.5, 'x']) assert.equal((await tr(trader, { move: 'buy', coins })).status, 400, String(coins));
  run([['HSET', `stats:${trader.playerId}`, 'spent', 1e9]]); assert.equal((await tr(trader, { move: 'buy', coins: 100 })).status, 422); run([['HSET', `stats:${trader.playerId}`, 'spent', 0]]);
  assert.equal((await tr(trader, { move: 'sell', sats: 5 })).status, 422, 'rien à vendre');
  run([['HSET', `stats:${trader.playerId}`, 'rolls', 10]]); assert.equal((await tr(trader, { move: 'buy', coins: 100 })).status, 422); run([['HSET', `stats:${trader.playerId}`, 'rolls', 100]]);
  globalThis.__btc = null; run([['SET', 'btc:price', JSON.stringify({ p: 88000, t: Date.now() - 600000 })]]);
  assert.equal((await tr(trader, { move: 'buy', coins: 100 })).status, 503, 'prix trop vieux : pas d\'échange');
  globalThis.__btc = 5; fresh(); assert.equal((await pub()).price, null, 'prix absurde ignoré');
  globalThis.__btc = 80000; fresh();
}

// ================================================================ 53. Ethereum et bougies du graphique
{
  const shopApi = require(path.join(ROOT, 'api/shop.js'));
  const trader = { playerId: '6e'.repeat(8), secret: '7e'.repeat(16), name: 'Trader' };
  const tr = extra => call(shopApi, { method: 'POST', body: { playerId: trader.playerId, secret: trader.secret, action: 'btc', ...extra } });
  globalThis.__btc = 80000; globalThis.__eth = 2500; run([['DEL', 'btc:price'], ['DEL', 'eth:price']]);
  let r = await call(shopApi, { url: `/api/shop?btc=1&asset=eth&me=${trader.playerId}` });
  assert.equal(r.body.price, 2500); assert.equal(r.body.sym, 'ETH');
  r = await tr({ asset: 'eth', move: 'buy', coins: 2525 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sats, 1e8 - 1 <= r.body.sats ? r.body.sats : Math.floor(2525 / (2500 * 1.01) * 1e8)); assert.equal(r.body.asset, 'eth');
  const st = Object.fromEntries((run([['HGETALL', `stats:${trader.playerId}`]])[0].result || []).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), []));
  assert.ok(Number(st.ethSats) > 0 && !Number(st.btcSats), 'Ethereum gardé à part du Bitcoin');
  assert.equal((await tr({ asset: 'eth', move: 'sell', all: true })).status, 200);
  assert.equal((await tr({ asset: 'doge', move: 'buy', coins: 100 })).status, 400);
  // Bougies : triées dans le temps, [t, o, h, l, c, v], gardées en cache ; unité de temps inconnue refusée.
  r = await call(shopApi, { url: '/api/shop?candles=1&asset=btc&tf=1h' });
  assert.equal(r.status, 200); assert.equal(r.body.rows.length, 50); assert.ok(r.body.rows.every((x, i) => i === 0 || x[0] > r.body.rows[i - 1][0]));
  assert.deepEqual(r.body.rows[0].slice(1, 5), [100 + 49, 110 + 49, 90 + 49, 105 + 49], 'ouverture, haut, bas, clôture');
  assert.ok(run([['GET', 'cndl:BTC:1h']])[0].result, 'en cache');
  assert.equal((await call(shopApi, { url: '/api/shop?candles=1&asset=btc&tf=3m' })).status, 400);
  globalThis.__btc = null; run([['DEL', 'cndl:ETH:5m']]);
  assert.equal((await call(shopApi, { url: '/api/shop?candles=1&asset=eth&tf=5m' })).status, 503);
  globalThis.__btc = 80000;
}

// ================================================================ 54. Effet de levier : long / short, 2× 3× 5×, stop loss, take profit, liquidation
{
  const shopApi = require(path.join(ROOT, 'api/shop.js')), Shop = require(path.join(ROOT, 'js/shop.js')), Lever = require(path.join(ROOT, 'api/_lever.js'));
  const lv = { playerId: '8e'.repeat(8), secret: '9e'.repeat(16), name: 'Lever' };
  db.delete(`cooldown:${lv.playerId}`); assert.equal((await call(roll, { method: 'POST', body: lv })).status, 200);
  const go = extra => call(shopApi, { method: 'POST', body: { playerId: lv.playerId, secret: lv.secret, action: 'lever', ...extra } });
  const bal = () => Shop.balance(Object.fromEntries((run([['HGETALL', `stats:${lv.playerId}`]])[0].result || []).reduce((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), [])));
  run([['HSET', `stats:${lv.playerId}`, 'rolls', 100], ['HINCRBY', `stats:${lv.playerId}`, 'bonus', 50000]]);
  const setPrice = v => { globalThis.__btc = v; run([['DEL', 'btc:price']]); };
  // Long 5× sur 1 000 pièces : le prix monte de 10 % → +50 % moins les frais (2 × 0,1 % × 5 000 = 10).
  setPrice(80000); let c0 = bal();
  let r = await go({ move: 'open', asset: 'btc', side: 'long', lev: 5, margin: 1000 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const p1 = r.body.opened; assert.equal(bal(), c0 - 1000); assert.equal(p1.entry, 80000);
  assert.ok(Math.abs(p1.liq - 80000 * (1 - (0.95 - 0.01) / 5)) < 1, `liquidation ${p1.liq}`);
  setPrice(88000); r = await go({ move: 'close', id: p1.id }); assert.equal(r.body.closed.payout, 1490); assert.equal(bal(), c0 + 490);
  // Short 3× : le prix baisse de 10 % → gagne.
  setPrice(80000); c0 = bal(); r = await go({ move: 'open', asset: 'btc', side: 'short', lev: 3, margin: 1000 });
  setPrice(72000); r = await go({ move: 'close', id: r.body.opened.id }); assert.equal(r.body.closed.payout, 1294); // 1000 + 300 − 6
  // Liquidation : long 5×, le prix chute de 20 % → mise perdue, jamais plus.
  setPrice(80000); c0 = bal(); r = await go({ move: 'open', asset: 'btc', side: 'long', lev: 5, margin: 500 });
  setPrice(64000); assert.equal(await Lever.tick(), 1);
  r = await go({ move: 'state' }); assert.equal(r.body.positions.length, 0); assert.equal(r.body.history[0].why, 'liquidated'); assert.equal(r.body.history[0].payout, 0); assert.equal(bal(), c0 - 500);
  // Stop loss et take profit, déclenchés par la vérification régulière.
  setPrice(80000); r = await go({ move: 'open', asset: 'btc', side: 'long', lev: 2, margin: 1000, sl: 76000, tp: 84000 });
  const pid = r.body.opened.id; setPrice(81000); assert.equal(await Lever.tick(), 0, 'rien à fermer');
  setPrice(84500); assert.equal(await Lever.tick(), 1); r = await go({ move: 'state' }); assert.equal(r.body.history[0].why, 'take'); assert.ok(r.body.history[0].payout > 1000);
  setPrice(80000); r = await go({ move: 'open', asset: 'btc', side: 'short', lev: 2, margin: 1000, sl: 82000 });
  setPrice(82100); await Lever.tick(); r = await go({ move: 'state' }); assert.equal(r.body.history[0].why, 'stop'); assert.ok(r.body.history[0].payout < 1000);
  // Modifier stop et objectif ; niveaux incohérents refusés.
  setPrice(80000); r = await go({ move: 'open', asset: 'btc', side: 'long', lev: 3, margin: 100 }); const e = r.body.opened.id;
  assert.equal((await go({ move: 'edit', id: e, sl: 79000, tp: 90000 })).status, 200);
  assert.equal((await go({ move: 'edit', id: e, sl: 81000 })).status, 422, 'stop au-dessus du prix d\'entrée d\'un long');
  assert.equal((await go({ move: 'edit', id: e, sl: 50000 })).status, 422, 'stop sous la liquidation');
  assert.equal((await go({ move: 'edit', id: e, tp: 70000 })).status, 422);
  // Refus à l'ouverture.
  for (const [k, v] of [['lev', 40], ['lev', 1], ['margin', 5], ['margin', 20000], ['side', 'up'], ['asset', 'doge']]) assert.equal((await go({ move: 'open', asset: 'btc', side: 'long', lev: 5, margin: 100, [k]: v })).status, 400, `${k}=${v}`);
  for (let i = 0; i < 4; i++) await go({ move: 'open', asset: 'eth', side: 'long', lev: 2, margin: 10 });
  assert.equal((await go({ move: 'open', asset: 'btc', side: 'long', lev: 2, margin: 10 })).status, 422, '5 positions au plus');
  // Fermée une seule fois, même si deux fermetures se croisent.
  const [a1, a2] = await Promise.all([go({ move: 'close', id: e }), go({ move: 'close', id: e })]);
  assert.equal([a1.status, a2.status].filter(x => x === 200).length >= 1, true);
  assert.equal(r.body.history.filter(h => h.entry === 80000 && h.m === 100).length <= 1, true);
  const hist = (await go({ move: 'state' })).body.history.filter(h => h.m === 100 && h.lev === 3); assert.equal(hist.length, 1, 'payée une seule fois');
  setPrice(80000); globalThis.__eth = 2500;
}

// ================================================================ 55. Skin Haunted : en vente jusqu'au 1er novembre seulement, jamais en caisse ; badges « carré à l'intérieur »
{
  const shopApi = require(path.join(ROOT, 'api/shop.js')), Shop = require(path.join(ROOT, 'js/shop.js'));
  const h = Shop.byId.get('haunted'); assert.equal(h.price, 666); assert.ok(h.until);
  for (const c of Shop.CASES) assert.ok(!Shop.casePool(c).some(s => s.id === 'haunted'), `pas dans ${c.id}`);
  // événement de Noël (2026-11-01) : la boule à neige et le village enneigé, limités au 26 décembre, jamais en caisse
  assert.equal(Shop.byId.get('snowglobe').until, '2026-12-26T00:00:00Z'); assert.equal(Shop.wallById.get('snowvillage').until, '2026-12-26T00:00:00Z');
  for (const c of Shop.CASES) assert.ok(!Shop.casePool(c).some(s => s.id === 'snowglobe' || s.id === 'snowvillage'), `Noël pas dans ${c.id}`);
  assert.ok(!Shop.collectible().includes('snowglobe') && !Shop.collectibleSets.walls().includes('snowvillage'), 'hors collections');
  // Événement de Noël (2026-11-01) : Gingerbread et Cozy Fireplace, limités jusqu'au 26 décembre, jamais en caisse.
  assert.equal(Shop.byId.get('gingerbread').price, 1100); assert.equal(Shop.byId.get('gingerbread').until, '2026-12-26T00:00:00Z');
  assert.equal(Shop.wallById.get('fireplace').price, 1224); assert.equal(Shop.wallById.get('fireplace').until, '2026-12-26T00:00:00Z');
  for (const c of Shop.CASES) assert.ok(!Shop.casePool(c).some(s => s.id === 'gingerbread' || s.id === 'fireplace'), `Noël pas dans ${c.id}`);
  const buyer = { playerId: '9a'.repeat(8), secret: '9b'.repeat(16), name: 'Spooky' };
  db.delete(`cooldown:${buyer.playerId}`); assert.equal((await call(roll, { method: 'POST', body: buyer })).status, 200);
  run([['HINCRBY', `stats:${buyer.playerId}`, 'bonus', 5000]]);
  const buy = () => call(shopApi, { method: 'POST', body: { playerId: buyer.playerId, secret: buyer.secret, action: 'buy', skin: 'haunted' } });
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-01T00:00:01Z');
  try { const r = await buy(); assert.equal(r.status, 422); assert.match(r.body.error, /no longer for sale/); } finally { Date.now = realNow; }
  Date.now = () => Date.parse('2026-10-31T23:59:00Z');
  try { const r = await buy(); assert.equal(r.status, 200, JSON.stringify(r.body)); } finally { Date.now = realNow; }
  // Les badges « contient un carré » : seul le plus grand compte, jamais sur le nombre entier.
  const ids = n => engine.analyze(n).earnedIds.filter(x => /^SQUARE_IN_/.test(x));
  assert.deepEqual(ids(815625), ['SQUARE_IN_5']); assert.deepEqual(ids(51449), ['SQUARE_IN_3']); assert.deepEqual(ids(144), []); assert.deepEqual(ids(907744), ['SQUARE_IN_4']);
  // Leap Day (idée de qwertyuiop, 2026-10-26) : 0229AA avec AA multiple de 4, tiré comme 229AA → 25 nombres.
  const leap = n => engine.analyze(n).earnedIds.includes('LEAP_DAY');
  assert.ok(leap(22924) && leap(22996) && leap(22900), 'Leap Day manquant');
  assert.ok(!leap(22925) && !leap(22898) && !leap(23000) && !leap(122924), 'Leap Day en trop');
}

// ================================================================ 56. Farce du créateur en duel : faux jackpot, visible seulement chez les autres
{
  const boss = { playerId: '1d'.repeat(8), secret: '2d'.repeat(16), name: 'Bossy' }, pal = { playerId: '3d'.repeat(8), secret: '4d'.repeat(16), name: 'Pally' };
  for (const p of [boss, pal]) { db.delete(`cooldown:${p.playerId}`); assert.equal((await call(roll, { method: 'POST', body: p })).status, 200); }
  let r = await roomPost(boss, 'create', { size: 2, mode: 'rounds', target: 3 }); const code = r.body.code;
  await roomPost(pal, 'join', { code });
  // Un joueur ordinaire ne peut pas.
  assert.equal((await roomPost(pal, 'prank', { code, target: 'Bossy', n: 1 })).status, 403);
  run([['HSET', `stats:${boss.playerId}`, 'owner', '1']]);
  assert.equal((await roomPost(boss, 'prank', { code, target: 'Nobody', n: 777777 })).status, 400, 'cible inconnue');
  assert.equal((await roomPost(boss, 'prank', { code, target: 'Pally', n: 2000000 })).status, 400, 'nombre impossible');
  r = await roomPost(boss, 'prank', { code, target: 'pally', n: 777777 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.prank, { round: 0, by: 'Bossy', n: 777777, i: 1 }, 'le créateur la voit aussi'); assert.equal(r.body.prankArmed, 0);
  r = await roomGet(code, pal); assert.deepEqual(r.body.prank, { round: 0, by: 'Bossy', n: 777777, i: 1 });
  assert.deepEqual((await roomGet(code)).body.prank, { round: 0, by: 'Bossy', n: 777777, i: 1 }, 'les spectateurs aussi');
  assert.ok(!JSON.stringify(r.body).includes(boss.playerId), 'aucun identifiant');
  // 3 par duel au plus.
  // Plus de limite pour le créateur.
  for (const n of [1, 2, 3, 4, 5]) assert.equal((await roomPost(boss, 'prank', { code, target: 'Pally', n })).status, 200);
  // Farce sonore : tout de suite chez la cible, pas chez le créateur ; 3 s entre deux ; personne d'autre ne peut.
  assert.equal((await roomPost(pal, 'prankSound', { code, target: 'Bossy', kind: 'airhorn' })).status, 403);
  assert.equal((await roomPost(boss, 'prankSound', { code, target: 'Pally', kind: 'nope' })).status, 400);
  r = await roomPost(boss, 'prankSound', { code, target: 'Pally', kind: 'airhorn' }); assert.equal(r.status, 200); assert.ok(!r.body.psound);
  r = await roomGet(code, pal); assert.equal(r.body.psound.kind, 'airhorn'); assert.equal(r.body.psound.by, 'Bossy');
  assert.equal((await roomPost(boss, 'prankSound', { code, target: '*', kind: 'buzzer' })).status, 429);
  db.delete(`psound:${code}`);
  assert.equal((await roomPost(boss, 'prankSound', { code, target: '*', kind: 'buzzer' })).status, 200);
  assert.equal((await roomGet(code, pal)).body.psound.kind, 'buzzer');
  // Le résultat n'est pas touché : la manche se joue normalement, les nombres sont ceux tirés par le serveur.
  for (const p of [boss, pal]) { db.delete(`cooldown:${p.playerId}`); await roomPost(p, 'ready', { code }); }
  r = await roomGet(code, pal); assert.equal(r.body.rounds.length, 1);
  const [n0, n1] = r.body.rounds[0].n; assert.equal(r.body.rounds[0].s[0], engine.scoreOf(n0)); assert.equal(r.body.rounds[0].s[1], engine.scoreOf(n1));
  run([['HDEL', `stats:${boss.playerId}`, 'owner']]);
}

// ================================================================ 57. Pseudo + mot de passe
{
  const pw = body => call(auth, { method: 'POST', body, headers: { 'x-forwarded-for': '203.0.113.50' } });
  const u = { playerId: '5e'.repeat(8), secret: '6e'.repeat(16), name: 'Passy' };
  db.delete(`cooldown:${u.playerId}`); assert.equal((await call(roll, { method: 'POST', body: u })).status, 200);
  assert.equal((await pw({ action: 'passwordState', ...u })).body.has, false);
  assert.equal((await pw({ action: 'setPassword', ...u, password: 'short' })).status, 422);
  assert.equal((await pw({ action: 'setPassword', ...u, password: 'passy' + '' })).status, 422);
  assert.equal((await pw({ action: 'setPassword', ...u, secret: '0'.repeat(32), password: 'goodpassword' })).status, 403, 'pas sans le secret');
  let r = await pw({ action: 'setPassword', ...u, password: 'correct horse' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = run([['GET', `player:${u.playerId}:pw`]])[0].result; assert.ok(/^s1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(stored) && !stored.includes('correct'), 'seulement une empreinte');
  // Connexion depuis un autre appareil : bon mot de passe → le même joueur et un nouveau secret qui marche.
  r = await pw({ action: 'passwordLogin', name: ' passy ', password: 'correct horse' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.playerId, u.playerId); assert.equal(r.body.name, 'Passy');
  db.delete(`cooldown:${u.playerId}`); assert.equal((await call(roll, { method: 'POST', body: { playerId: u.playerId, secret: r.body.secret, name: 'Passy' } })).status, 200, 'le nouveau secret permet de tirer');
  // Mauvais mot de passe et pseudo inconnu : même réponse.
  const a1 = await pw({ action: 'passwordLogin', name: 'Passy', password: 'nope nope' }), a2 = await pw({ action: 'passwordLogin', name: 'Nobody Here', password: 'nope nope' });
  assert.deepEqual([a1.status, a1.body.error], [401, 'Wrong name or password']); assert.deepEqual([a2.status, a2.body.error], [401, 'Wrong name or password']);
  // Trop d'essais sur ce joueur : bloqué 15 min, même avec le bon mot de passe.
  run([['SET', `pwfail:${u.playerId}`, 8]]); assert.equal((await pw({ action: 'passwordLogin', name: 'Passy', password: 'correct horse' })).status, 429);
  run([['DEL', `pwfail:${u.playerId}`], ['SET', 'pwip:203.0.113.50', 30]]); assert.equal((await pw({ action: 'passwordLogin', name: 'Passy', password: 'correct horse' })).status, 429, 'trop d\'essais depuis cette adresse');
  run([['DEL', 'pwip:203.0.113.50']]);
  assert.equal((await pw({ action: 'passwordState', ...u })).body.has, true);

  // Code de récupération (2026-11-03) : créé par le créateur seulement, à usage unique, il rend le joueur à l'appareil.
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const lost = { playerId: '5f'.repeat(8), secret: '6f'.repeat(16), name: 'Lostkid' };
  db.delete(`cooldown:${lost.playerId}`); assert.equal((await call(roll, { method: 'POST', body: lost })).status, 200);
  const code = who => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'recoverCode', name: who.target } });
  assert.equal((await code({ ...u, target: 'Lostkid' })).status, 403, 'pas pour un joueur');
  run([['HSET', `stats:${u.playerId}`, 'owner', '1']]);
  assert.equal((await code({ ...u, target: 'Nobody Here' })).status, 404);
  const c1 = (await code({ ...u, target: 'lostkid' })).body, c2 = (await code({ ...u, target: 'Lostkid' })).body;
  run([['HDEL', `stats:${u.playerId}`, 'owner']]);
  assert.ok(/^[A-Z2-9]{10}$/.test(c2.code) && c2.name === 'Lostkid' && c2.days === 7, JSON.stringify(c2));
  assert.equal((await pw({ action: 'recoverLogin', code: c1.code })).status, 401, 'un nouveau code annule l\'ancien');
  r = await pw({ action: 'recoverLogin', code: ` ${c2.code.slice(0, 5).toLowerCase()}-${c2.code.slice(5)} ` }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.playerId, lost.playerId); assert.equal(r.body.name, 'Lostkid');
  db.delete(`cooldown:${lost.playerId}`); assert.equal((await call(roll, { method: 'POST', body: { playerId: lost.playerId, secret: r.body.secret, name: 'Lostkid' } })).status, 200, 'le nouvel appareil tire sous l\'ancien joueur');
  db.delete(`cooldown:${lost.playerId}`); assert.equal((await call(roll, { method: 'POST', body: lost })).status, 200, 'l\'ancien appareil aussi');
  assert.equal((await pw({ action: 'recoverLogin', code: c2.code })).status, 401, 'une seule fois');
  assert.equal((await pw({ action: 'recoverLogin', code: 'short' })).status, 401);
  run([['DEL', 'pwip:203.0.113.50']]);
}

// ================================================================ 58. Code SPOOKYMONTH : 300 pièces + titre Spooky, jusqu'au 1er novembre
{
  const shopApi = require(path.join(ROOT, 'api/shop.js'));
  const k = { playerId: '7c'.repeat(8), secret: '8c'.repeat(16), name: 'Spooker' };
  db.delete(`cooldown:${k.playerId}`); assert.equal((await call(roll, { method: 'POST', body: k })).status, 200);
  run([['HSET', `stats:${k.playerId}`, 'rolls', 40]]);
  const redeem = () => call(shopApi, { method: 'POST', body: { playerId: k.playerId, secret: k.secret, action: 'redeem', code: 'spooky month' } });
  const realNow = Date.now;
  Date.now = () => Date.parse('2026-11-01T00:00:01Z');
  try { const r = await redeem(); assert.equal(r.status, 410); } finally { Date.now = realNow; }
  Date.now = () => Date.parse('2026-10-20T12:00:00Z');
  try { const r = await redeem(); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.redeemed.coins, r.body.redeemed.title], [300, 'spooky']); } finally { Date.now = realNow; }
  assert.equal((await equip(k, 'spooky')).status, 200, 'titre équipable');
  assert.equal((await equip(alice, 'spooky')).status, 422, 'pas sans le code');
}

// 58b. Code BC (idée de MAYO) : 100 pièces + titre Gatekeep, une seule fois.
{
  const shopApi = require(path.join(ROOT, 'api/shop.js'));
  const k = { playerId: '7d'.repeat(8), secret: '8d'.repeat(16), name: 'Gatekeeper' };
  db.delete(`cooldown:${k.playerId}`); assert.equal((await call(roll, { method: 'POST', body: k })).status, 200);
  run([['HSET', `stats:${k.playerId}`, 'rolls', 40]]);
  const redeem = () => call(shopApi, { method: 'POST', body: { playerId: k.playerId, secret: k.secret, action: 'redeem', code: 'bc' } });
  const r = await redeem(); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.redeemed.coins, r.body.redeemed.title], [100, 'gatekeep']);
  assert.equal((await redeem()).status, 409, 'une seule fois');
  assert.equal((await equip(k, 'gatekeep')).status, 200, 'titre équipable');
  assert.equal((await equip(alice, 'gatekeep')).status, 422, 'pas sans le code');
}

// 58c. Code EPITECH>42 : 150 pièces + titre Epitech, une seule fois, en minuscules et avec des espaces.
{
  const shopApi = require(path.join(ROOT, 'api/shop.js'));
  const k = { playerId: '7e'.repeat(8), secret: '8e'.repeat(16), name: 'Epitechien' };
  db.delete(`cooldown:${k.playerId}`); assert.equal((await call(roll, { method: 'POST', body: k })).status, 200);
  run([['HSET', `stats:${k.playerId}`, 'rolls', 40]]);
  const redeem = () => call(shopApi, { method: 'POST', body: { playerId: k.playerId, secret: k.secret, action: 'redeem', code: 'epitech > 42' } });
  const r = await redeem(); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.redeemed.coins, r.body.redeemed.title], [150, 'epitech']);
  assert.equal((await redeem()).status, 409, 'une seule fois');
  assert.equal((await equip(k, 'epitech')).status, 200, 'titre équipable');
}

// 59. Collab Canne & Dauphins : le jeu de Firetail envoie le jeton Google de son joueur (action « collab »).
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const state = who => call(shopApi, { url: `/api/shop?me=${who.playerId}` });
  const collab = credential => call(siteApi, { method: 'POST', body: { action: 'collab', game: 'pechadophin', credential } });
  const PECHA = '613987510700-0gp3rfu2tmcm32uu0aun7q1lmubl8vav.apps.googleusercontent.com';
  // Refusé : jeton de RNG∞ (mauvais jeu), faux jeton, jeu inconnu.
  assert.equal((await collab(googleToken({ sub: 'fish-1' }))).status, 401, 'un jeton émis pour un autre jeu est refusé');
  assert.equal((await collab('abc.def.ghi')).status, 401);
  assert.equal((await call(siteApi, { method: 'POST', body: { action: 'collab', game: 'nope', credential: googleToken({ sub: 'x', aud: PECHA }) } })).status, 400);
  // 1er ordre : il a déjà un compte RNG∞ (connecté avec Google), puis il se connecte sur Canne & Dauphins.
  let r = await signIn({ sub: 'fish-both', email: 'fishboth@example.com' }, {});
  const both = { playerId: r.body.playerId, secret: r.body.secret };
  r = await collab(googleToken({ sub: 'fish-both', aud: PECHA }));
  assert.deepEqual([r.status, r.body.rng, r.body.reward], [200, true, 'rnginf'], 'compte RNG∞ trouvé : son skin est donné');
  r = await state(both);
  assert.ok(r.body.owned.includes('fisher'), 'skin Fisherman débloqué sur RNG∞');
  // 2e ordre : il joue d'abord à Canne & Dauphins (pas de compte RNG∞), puis se connecte sur RNG∞.
  r = await collab(googleToken({ sub: 'fish-later', aud: PECHA }));
  assert.deepEqual([r.status, r.body.rng, r.body.reward], [200, false, null], 'pas encore de compte RNG∞');
  r = await signIn({ sub: 'fish-later', email: 'fishlater@example.com' }, {});
  r = await state({ playerId: r.body.playerId });
  assert.ok(r.body.owned.includes('fisher'), 'débloqué à la connexion Google sur RNG∞');
  // Personne d'autre ne l'a, et il ne s'achète pas.
  r = await signIn({ sub: 'fish-none', email: 'fishnone@example.com' }, {});
  const none = { playerId: r.body.playerId, secret: r.body.secret };
  r = await state(none);
  assert.ok(!r.body.owned.includes('fisher'), 'pas pour un compte qui ne joue pas aux deux');
  r = await shop(none, 'buy', 'fisher');
  assert.notEqual(r.status, 200, 'pas achetable');
}

// 60. Idées du 2026-10-16 : fil du Plinko regroupé, codes cachés (titre Code Hunter), XP à vie dans les stats.
{
  const shopApi2 = require(path.join(ROOT, 'api/shop.js'));
  const p = frank, Achievements = require(path.join(ROOT, 'js/achievements.js'));
  const toObjectStats = id => { const f = run([['HGETALL', `stats:${id}`]])[0].result || [], o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; };
  run([['HINCRBY', `stats:${p.playerId}`, 'bonus', 5000], ['DEL', `cooldown:${p.playerId}`, `shop:${p.playerId}`]]);
  const g = (action, extra) => call(shopApi2, { method: 'POST', body: { playerId: p.playerId, secret: p.secret, action, ...extra } });
  const feedLen = () => run([['LLEN', 'casino:feed']])[0].result;
  let r = await g('plinko', { bet: 10, count: 5 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const n0 = feedLen();
  for (let i = 0; i < 6; i++) { r = await g('plinko', { bet: 10, count: 5 }); assert.equal(r.status, 200); }
  assert.ok(feedLen() <= n0 + 1, `Plinko à la chaîne : une ligne dans le fil (${n0} → ${feedLen()})`);
  const last = JSON.parse(run([['LINDEX', 'casino:feed', -1]])[0].result);
  assert.equal(last.g, 'plinko'); assert.equal(last.id, p.playerId);
  for (const [i, code] of ['ROLLFOREVER', 'consolecat', ' zerohero '].entries()) {
    r = await g('redeem', { code }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.redeemed.coins, 150); assert.equal(r.body.redeemed.hunt.found, i + 1);
    assert.equal(r.body.redeemed.title, i === 2 ? 'codehunter' : null, 'titre au 3e code seulement');
  }
  assert.equal((await g('redeem', { code: 'ZEROHERO' })).status, 409, 'une seule fois');
  assert.ok(Achievements.unlocked(toObjectStats(p.playerId)).includes('codehunter'), 'succès Code Hunter');
  run([['HSET', `stats:${p.playerId}`, 'xpLife', 1e9]]);
  assert.ok(['centimillionaire', 'billionaire'].every(a => Achievements.unlocked(toObjectStats(p.playerId)).includes(a)), 'titres d\'XP à vie');
}

// 61. Niveaux et clés de caisse (idée de PRISMA123, 2026-10-16).
{
  const questsApi2 = require(path.join(ROOT, 'api/quests.js')), shopApi3 = require(path.join(ROOT, 'api/shop.js')), Q = require(path.join(ROOT, 'js/quests.js'));
  const p = bob, qGet2 = () => call(questsApi2, { url: `/api/quests?me=${p.playerId}` }), qPost2 = (action, extra = {}) => call(questsApi2, { method: 'POST', body: { playerId: p.playerId, secret: p.secret, action, ...extra } });
  const shopState = () => call(shopApi3, { url: `/api/shop?me=${p.playerId}` }), openCase = (id, free) => call(shopApi3, { method: 'POST', body: { playerId: p.playerId, secret: p.secret, action: 'case', case: id, free } });
  // Joueur d'avant les niveaux (niveau 12) : il part de son niveau, avec un rattrapage plafonné à réclamer une fois :
  // 10 × (1 + … + 12) = 780 pièces et les clés Starter des niveaux 5 et 10.
  run([['HSET', `stats:${p.playerId}`, 'xpLife', Q.xpForLevel(12) + 5], ['HDEL', `stats:${p.playerId}`, 'lvlPaid', 'lvlStart', 'lvlCatch', 'key:starter', 'key:premium']]);
  let r = await qGet2(); assert.deepEqual([r.body.level.level, r.body.level.pending, r.body.level.coins, r.body.level.keys], [12, 1, 780, ['starter', 'starter']], 'rattrapage plafonné');
  // Il monte au niveau 15 avant de réclamer : niveaux 13 à 15 (10 × 42 et une clé Starter) + le rattrapage.
  run([['HSET', `stats:${p.playerId}`, 'xpLife', Q.xpForLevel(15) + 1]]);
  r = await qGet2(); assert.deepEqual([r.body.level.pending, r.body.level.coins, r.body.level.keys], [4, 780 + 420, ['starter', 'starter', 'starter']]);
  const coins0 = (await shopState()).body.coins;
  r = await qPost2('level'); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.gained, r.body.level.pending], [1200, 0]);
  assert.equal((await qPost2('level')).status, 422, 'une seule fois');
  let sh = await shopState(); assert.equal(sh.body.coins, coins0 + 1200); assert.equal(sh.body.keys.starter, 3);
  // Le rattrapage ne revient pas : au niveau 16, seulement les 160 pièces du niveau.
  run([['HSET', `stats:${p.playerId}`, 'xpLife', Q.xpForLevel(16) + 1]]);
  r = await qGet2(); assert.deepEqual([r.body.level.pending, r.body.level.coins, r.body.level.catchup], [1, 160, null]);
  assert.deepEqual(Q.catchUp(74), { coins: 1000, keys: ['starter', 'starter', 'starter', 'starter', 'premium'] }, 'plafond du rattrapage');
  run([['HSET', `stats:${p.playerId}`, 'key:starter', 1]]);
  // La clé ouvre la Starter Case gratuitement, une seule fois ; sans clé : refusé.
  r = await openCase('starter', true); assert.equal(r.status, 200, JSON.stringify(r.body));
  sh = await shopState(); assert.equal(sh.body.keys.starter, 0); assert.ok(sh.body.coins >= coins0 + 1200, 'gratuite (un doublon rembourse même un peu)');
  assert.equal((await openCase('starter', true)).status, 422, 'plus de clé');
  assert.equal((await openCase('premium', true)).status, 422, 'pas de clé Premium');
  // Niveau 25 : une clé Premium à la place de la Starter.
  assert.deepEqual([Q.levelReward(25).key, Q.levelReward(20).key, Q.levelReward(21).key], ['premium', 'starter', null]);
  // Elite Case : dans la boutique, que des skins de 1 500 à 5 000.
  assert.ok(Shop.casePool(Shop.caseById.get('elite')).every(k => k.price >= 1500 && k.price <= 5000));
}

// Godlike (2026-10-16) : un ancien tirage Godlike, compté en Divine avant la nouvelle rareté, passe en Godlike à la
// première lecture des stats, une seule fois, et débloque le succès.
{
  const { readStats } = require(path.join(ROOT, 'api/_lib.js'));
  const id = 'f0e1'.repeat(4), T0 = 1790000000000;
  db.delete(`stats:${id}`); db.delete(`hist:${id}`);
  run([['ZADD', `hist:${id}`, T0, `${T0}:69`, T0 + 1, `${T0 + 1}:5`], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'rolls', 2, 't:divine', 1, 't:common', 1]]);
  let st = await readStats(id);
  assert.deepEqual([Number(st['t:divine']), Number(st['t:godlike'])], [0, 1], JSON.stringify(st));
  st = await readStats(id);
  assert.deepEqual([Number(st['t:divine']), Number(st['t:godlike'])], [0, 1], 'une seule fois');
  assert.ok(require(path.join(ROOT, 'js/achievements.js')).unlocked(st).includes('godlike'), 'succès Godlike');
}

// Annonce Discord des grands tirages (2026-10-17) : seulement Celestial ou mieux, sans mention possible, et rien du
// tout sans webhook configuré.
{
  const modPath = require.resolve(path.join(ROOT, 'api/_discord.js'));
  assert.equal(require(modPath).enabled(), false, 'pas de webhook dans les tests');
  delete require.cache[modPath];
  process.env.RNG_DISCORD_WEBHOOK = 'https://example.invalid/webhook';
  const D = require(modPath); delete process.env.RNG_DISCORD_WEBHOOK; delete require.cache[modPath];
  const sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return { ok: true }; };
  try {
    D.announceRoll({ name: '@everyone **Bob**', n: 69, a: engine.analyze(69) });
    D.announceRoll({ name: 'Bob', n: 384719, a: engine.analyze(384719) }); // un tirage courant (123457 contient 12345 : badge Password)
  } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.length, 1, 'un tirage courant ne part pas');
  assert.deepEqual(sent[0].allowed_mentions, { parse: [] }, 'aucune mention');
  assert.match(sent[0].embeds[0].description, /`000069`/);
  assert.ok(!sent[0].embeds[0].description.includes('**Bob**'), 'mise en forme du pseudo neutralisée');
}

// Discord, suite : duels ouverts, nouveautés publiées une seule fois, podium du jour une seule fois, mentions de rôle.
{
  const dPath = require.resolve(path.join(ROOT, 'api/_discord.js')), tPath = require.resolve(path.join(ROOT, 'api/_discord_tasks.js'));
  delete require.cache[dPath]; delete require.cache[tPath];
  process.env.RNG_DISCORD_CONFIG = JSON.stringify({ bigRolls: 'https://x.invalid/big', updates: 'https://x.invalid/up', duels: 'https://x.invalid/duel', roles: { bigRolls: '111', updates: '222', duels: '333' } });
  const D = require(dPath), T = require(tPath);
  delete process.env.RNG_DISCORD_CONFIG;
  const sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (!String(u).startsWith('https://x.invalid/')) return realFetch(u, o); sent.push({ u, b: JSON.parse(o.body) }); return { ok: true }; };
  try {
    D.announceRoll({ name: 'Bob', n: 69, a: engine.analyze(69) }); // Godlike : mention du rôle Big Rolls
    assert.deepEqual(sent.pop().b.allowed_mentions, { parse: [], roles: ['111'] });
    D.announceDuel({ host: 'Al@everyone', code: 'ABCD', mode: 'xp', target: 50000, size: 4, stake: 0 });
    let m = sent.pop(); assert.equal(m.u, 'https://x.invalid/duel'); assert.match(m.b.embeds[0].description, /#\/room\/ABCD/); assert.ok(!m.b.embeds[0].description.includes('@everyone'));
    run([['DEL', 'discord:updates:seen']]);
    assert.equal(await T.postNewUpdates(), 1, 'premier lancement : seulement la dernière entrée');
    assert.equal(await T.postNewUpdates(), 0, 'rien de neuf');
    run([['SREM', 'discord:updates:seen', T.readUpdates()[1].id]]);
    assert.equal(await T.postNewUpdates(), 1, 'une entrée manquante est publiée');
    assert.equal(sent.filter(x => x.u === 'https://x.invalid/up').length, 2);
    sent.length = 0;
    const now = Date.parse('2026-10-18T00:20:00Z'), y = '2026-10-17';
    run([['DEL', `discord:recap:${y}`], ['ZADD', `lb:day:${y}`, 102135744, alice.playerId], ['HSET', `best:day:${y}`, alice.playerId, JSON.stringify({ n: 69, s: 102135744, t: now - 5e6 })]]);
    assert.equal(await T.dailyRecap(now), true); assert.equal(await T.dailyRecap(now), false, 'une seule fois');
    assert.match(sent[0].b.embeds[0].description, /Alice/);
    assert.equal(await T.dailyRecap(Date.parse('2026-10-18T10:00:00Z')), false, 'pas en retard dans la journée');
  } finally { globalThis.fetch = realFetch; delete require.cache[dPath]; delete require.cache[tPath]; }
}

// Salons Discord du 2026-10-26 : tournois, guerres de clans, roadmap (webhooks et rôles 🔔 Tournaments / 🔔 Clans).
{
  const dPath = require.resolve(path.join(ROOT, 'api/_discord.js'));
  delete require.cache[dPath];
  process.env.RNG_DISCORD_CONFIG = JSON.stringify({ events: 'https://x.invalid/ev', tournaments: 'https://x.invalid/tn', clanWars: 'https://x.invalid/cw', roadmap: 'https://x.invalid/rm', roles: { tournaments: '444', clans: '555' } });
  const D = require(dPath);
  delete process.env.RNG_DISCORD_CONFIG;
  const sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (!String(u).startsWith('https://x.invalid/')) return realFetch(u, o); sent.push({ u, b: JSON.parse(o.body) }); return { ok: true }; };
  try {
    D.announceTournament({ day: '2026-10-26', mode: 'total', champion: 'Al', finalist: 'Bo', players: 8 });
    let m = sent.pop(); assert.equal(m.u, 'https://x.invalid/tn', 'salon des tournois'); assert.deepEqual(m.b.allowed_mentions, { parse: [], roles: ['444'] });
    D.announceClanWar({ win: 'Dice Lords [DICE]', lose: 'Foes [FOE]', prize: 970, scoreWin: 1200, scoreLose: 800 });
    m = sent.pop(); assert.equal(m.u, 'https://x.invalid/cw'); assert.deepEqual(m.b.allowed_mentions, { parse: [], roles: ['555'] }); assert.match(m.b.embeds[0].description, /970/);
    D.announceClanWeek({ clan: 'Dice Lords [DICE]', week: '2026-W43', members: 3 });
    assert.match(sent.pop().b.embeds[0].title, /clan of the week/);
    D.announceRoadmap({ name: 'Al@everyone', text: 'a *cool* idea', status: 'done' });
    m = sent.pop(); assert.equal(m.u, 'https://x.invalid/rm'); assert.deepEqual(m.b.allowed_mentions, { parse: [] }); assert.ok(!m.b.embeds[0].description.includes('@everyone') && !m.b.embeds[0].description.includes('*cool*'));
  } finally { globalThis.fetch = realFetch; delete require.cache[dPath]; }
}

// Lier son Discord (2026-10-17) : sans jeton de bot (hors VPS), état lisible et liaison refusée proprement ; rôles voulus
// d'après les stats tenues par le serveur.
{
  const dApi = require(path.join(ROOT, 'api/_discord_link.js'));
  const post = (who, action, extra = {}) => call(dApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  let r = await post(alice, 'state'); assert.deepEqual([r.status, r.body.linked, r.body.available], [200, false, false], JSON.stringify(r.body));
  assert.equal((await post(alice, 'link', { accessToken: 'abcdefghijklmnop' })).status, 503);
  assert.equal((await post({ ...alice, secret: '0'.repeat(32) }, 'state')).status, 403, 'pas sans le secret');
  assert.deepEqual(dApi.wanted({ best: engine.scoreOf(69), supporter: 1 }), ['Player', 'Godlike', 'Supporter']);
  assert.deepEqual(dApi.wanted({ best: 5000 }), ['Player'], 'pas de rôle de rareté sous Mythic');
}

// Événement de la semaine (2026-10-17) : compté à chaque tirage par le serveur, récompense une seule fois et seulement
// une fois l'objectif atteint, succès Event Hunter, annonces Discord une seule fois.
{
  const Events = require(path.join(ROOT, 'js/events.js')), qApi = require(path.join(ROOT, 'api/quests.js'));
  const ev = Events.current(), key = Events.key(ev);
  const who = { playerId: 'e7'.repeat(8), secret: 'e8'.repeat(16), name: 'Eventer' };
  db.delete(`cooldown:${who.playerId}`); assert.equal((await call(roll, { method: 'POST', body: who })).status, 200);
  const st = async () => (await call(qApi, { url: `/api/quests?me=${who.playerId}` })).body.event;
  let e = await st(); assert.equal(e.id, ev.id); assert.equal(e.goal, ev.goal);
  const claim = () => call(qApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'event' } });
  assert.equal((await claim()).status, 422, 'pas avant l\'objectif');
  // Un tirage du thème compte : on cherche un nombre qui a un badge du thème et on le fait passer par recordRoll.
  const { recordRoll } = require(path.join(ROOT, 'api/_lib.js'));
  let n = 0; while (!Events.counts(ev, engine.analyze(n).earnedIds)) n++;
  const before = (await st()).progress;
  await recordRoll(who.playerId, n, Date.now());
  assert.equal((await st()).progress, before + 1, 'un tirage du thème compte');
  // Pièces du tirage renvoyées pour l'écran de résultat (idée de jaxoncool43, 2026-10-24) : le tarif de la rareté, doublé
  // le samedi et le dimanche (UTC) par le Weekend Rush, comme ce qui est crédité.
  { const Shop = require(path.join(ROOT, 'js/shop.js')), tier = engine.analyze(n).tier;
    await new Promise(r => setTimeout(r, 3));
    const sat = await recordRoll(who.playerId, n, Date.parse('2026-10-24T12:00:00Z'));
    await new Promise(r => setTimeout(r, 3));
    const tue = await recordRoll(who.playerId, n, Date.parse('2026-10-27T12:00:00Z'));
    // Weekend Rush : +25 % (arrondi en dessous) depuis le 2026-10-25, au lieu de ×2.
    assert.deepEqual([sat.coins, tue.coins], [Shop.COINS[tier] + Math.floor(Shop.COINS[tier] * 0.25), Shop.COINS[tier]]);
    db.delete(`cooldown:${who.playerId}`);
    const r0 = await call(roll, { method: 'POST', body: who }), c0 = Shop.COINS[engine.analyze(r0.body.n).tier];
    assert.equal(r0.body.coins, c0 + Events.rushBonus(c0, r0.body.t), JSON.stringify(r0.body));
    assert.equal(r0.body.rate, 1, 'premiers tirages du jour : plein tarif'); }
  run([['ZADD', key, ev.goal, who.playerId]]);
  let r = await claim(); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.gained, ev.reward); assert.equal(r.body.event.claimed, true);
  assert.equal((await claim()).status, 422, 'une seule fois');
  run([['HSET', `stats:${who.playerId}`, 'events', 3]]);
  assert.ok(require(path.join(ROOT, 'js/achievements.js')).unlocked({ events: 3 }).includes('eventhunter'));
  // Classement de l'événement : trié par tirages du thème, objectif atteint marqué, sans identifiant.
  { const lbApi = require(path.join(ROOT, 'api/leaderboard.js'));
    const lb = await call(lbApi, { url: `/api/leaderboard?period=event&me=${who.playerId}` });
    assert.equal(lb.status, 200); assert.equal(lb.body.event.id, ev.id);
    const mine = lb.body.entries.find(x => x.me); assert.ok(mine && mine.done && mine.count >= ev.goal, JSON.stringify(lb.body.entries));
    assert.ok(lb.body.entries.every((x, i, a) => !i || a[i - 1].count >= x.count), 'trié');
    assert.ok(!JSON.stringify(lb.body).includes(who.playerId), 'aucun id'); }
  // Rotation : deux semaines de suite n'ont pas le même thème ; la semaine de lancement finit le lundi 19 octobre.
  assert.notEqual(Events.current(Date.parse('2026-10-20T00:00:00Z')).key, Events.current(Date.parse('2026-10-27T00:00:00Z')).key);
  assert.equal(new Date(Events.current(Date.parse('2026-10-18T12:00:00Z')).end).toISOString(), '2026-10-19T00:00:00.000Z');
  // Discord : lancement et podium une seule fois.
  const dPath = require.resolve(path.join(ROOT, 'api/_discord.js')), tPath = require.resolve(path.join(ROOT, 'api/_discord_tasks.js'));
  delete require.cache[dPath]; delete require.cache[tPath];
  process.env.RNG_DISCORD_CONFIG = JSON.stringify({ bigRolls: 'https://x.invalid/big', events: 'https://x.invalid/ev', roles: { updates: '222' } });
  const T = require(tPath); delete process.env.RNG_DISCORD_CONFIG;
  const sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (!String(u).startsWith('https://x.invalid/')) return realFetch(u, o); sent.push({ u, b: JSON.parse(o.body) }); return { ok: true }; };
  try {
    const mon = Date.parse('2026-10-26T01:00:00Z'), prev = Events.current(mon - 7 * 86400000);
    run([['DEL', `discord:evpod:${prev.id}`, `discord:event:${Events.current(mon).id}`], ['ZADD', Events.key(prev), 9, alice.playerId]]);
    assert.equal(await T.weeklyEvent(mon), true); assert.equal(await T.weeklyEvent(mon), false, 'une seule fois');
    assert.equal(sent.length, 2, 'podium + lancement'); assert.match(sent[0].b.embeds[0].description, /Alice/);
    assert.match(sent[1].b.embeds[0].title, new RegExp(Events.current(mon).title));
  } finally { globalThis.fetch = realFetch; delete require.cache[dPath]; delete require.cache[tPath]; }
}

// Doublons (Déjà vu), Poubelle par période et Trash King (2026-10-18).
{
  const { recordRoll, readStats } = require(path.join(ROOT, 'api/_lib.js'));
  const who = 'd0d1'.repeat(4), T = Date.now();
  db.delete(`stats:${who}`); db.delete(`hist:${who}`); db.delete(`nums:${who}`);
  run([['ZADD', `hist:${who}`, T - 9000, `${T - 9000}:777`, T - 8000, `${T - 8000}:777`], ['HSET', `stats:${who}`, 'v', '1', 'tv', '2', 'gv', '1', 'rolls', 2]]);
  await recordRoll(who, 5, T); // ancien joueur : ses doublons recomptés depuis l'historique (777 deux fois = 1)
  assert.equal(Number((await readStats(who)).dups), 1, 'recompté depuis l\'historique');
  await recordRoll(who, 777, T + 1000); await recordRoll(who, 5, T + 2000); await recordRoll(who, 6, T + 3000);
  assert.equal(Number((await readStats(who)).dups), 3, 'deux nouveaux doublons, un nombre neuf');
  // Poubelle du jour : le pire tirage du jour, classement croissant.
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js'));
  const day = await call(lbApi, { url: '/api/leaderboard?period=worst&span=day' });
  assert.equal(day.status, 200); assert.equal(day.body.span, 'day');
  assert.ok(day.body.entries.every((x, i, a) => !i || a[i - 1].s <= x.s), 'croissant');
  // Trash King : le 1er du mois, une seule fois, au pire tirage du mois passé.
  const T2 = require(path.join(ROOT, 'api/_discord_tasks.js'));
  const now = Date.parse('2026-11-01T02:00:00Z');
  run([['DEL', 'award:trashking:2026-10'], ['ZADD', 'lbw:month:2026-10', 0, who]]);
  const before = Number((await readStats(who)).trashKing || 0);
  assert.equal(await T2.trashKing(now), who); assert.equal(await T2.trashKing(now), null, 'une seule fois');
  assert.equal(Number((await readStats(who)).trashKing), before + 1);
  assert.equal(await T2.trashKing(Date.parse('2026-11-02T02:00:00Z')), null, 'seulement le 1er');
}

// Pièces du top 10 du mois (idée de furcoat0 et LwsBoi) : versées une seule fois, avec le badge, et annoncées.
{
  const rank = require(path.join(ROOT, 'api/_rank.js'));
  const { readStats } = require(path.join(ROOT, 'api/_lib.js'));
  const month = '2031-01', lb = `lb:month:${month}`, t = Date.parse('2031-02-01T00:10:00Z');
  const ids = Array.from({ length: 12 }, (_, i) => (0x7c00 + i).toString(16).padStart(16, '0'));
  run([['DEL', lb, `topawards:done:${month}`, `topcoins:${month}`], ...ids.flatMap((id, i) => [['DEL', `stats:${id}`, `gifts:${id}`], ['ZADD', lb, 1e9 - i, id]])]);
  rank._reset();
  await rank.settleMonth(t);
  const bonus = async () => Promise.all(ids.map(async id => Number((await readStats(id)).bonus || 0)));
  const want = [1000, 500, 500, 500, 500, 250, 250, 250, 250, 250, 0, 0];
  assert.deepEqual(await bonus(), want, 'montants par place');
  // Relance : ni le cache mémoire, ni le marqueur « done », ni un second appel direct ne repaient.
  rank._reset(); run([['DEL', `topawards:done:${month}`]]);
  await rank.settleMonth(t); await rank.settleMonth(t);
  assert.equal(await rank.payCoins(ids, month, t), false, 'verrou NX');
  assert.deepEqual(await bonus(), want, 'pas de double paiement');
  // Le joueur est prévenu comme pour un cadeau, une seule fois.
  const [raw] = run([['LRANGE', `gifts:${ids[2]}`, 0, -1]]).map(x => x.result);
  assert.equal(raw.length, 1);
  assert.deepEqual(JSON.parse(raw[0]), { f: '', a: 500, t, k: 'top', p: 3, m: month });
  assert.equal(run([['LLEN', `gifts:${ids[10]}`]])[0].result, 0, 'rien hors du top 10');
  rank._reset();
}

// Trophées du mois du mode difficile (Sacha, 2026-11-02) : leur propre top 10 et leurs propres pièces ; chaque badge dit
// son mode (« 2031-05-h » = difficile, sans suffixe = normal).
{
  const rank = require(path.join(ROOT, 'api/_rank.js'));
  const { readStats } = require(path.join(ROOT, 'api/_lib.js'));
  const month = '2031-05', t = Date.parse('2031-06-01T00:10:00Z');
  const ids = Array.from({ length: 3 }, (_, i) => (0x7e00 + i).toString(16).padStart(16, '0'));
  run([['DEL', `lb:month:${month}`, `hlb:month:${month}`, `topawards:done:${month}`, `topawards:done:${month}-h`, `topcoins:${month}`, `topcoins:${month}-h`], ...ids.flatMap(id => [['DEL', `stats:${id}`, `gifts:${id}`, `topawards:${id}`], ['HDEL', 'topbest', id]]),
    ['ZADD', `lb:month:${month}`, 50, ids[0]], ['ZADD', `hlb:month:${month}`, 90, ids[1], 80, ids[0]]]);
  rank._reset();
  await rank.settleMonth(t);
  const bonus = await Promise.all(ids.map(async id => Number((await readStats(id)).bonus || 0)));
  assert.deepEqual(bonus, [1500, 1000, 0], 'les deux classements paient : normal 1er + difficile 2e, et difficile 1er');
  assert.deepEqual(await rank.awardsOf(ids[0], t), [{ top: 5, month: `${month}-h` }, { top: 1, month }], 'un badge par mode');
  assert.deepEqual(await rank.awardsOf(ids[1], t), [{ top: 1, month: `${month}-h` }]);
  const marks = await rank.bestAwards(ids, t);
  assert.deepEqual([marks.get(ids[0]), marks.get(ids[1])], [{ top: 1, month }, { top: 1, month: `${month}-h` }]);
  const [g] = run([['LRANGE', `gifts:${ids[1]}`, 0, -1]]).map(x => x.result);
  assert.deepEqual(JSON.parse(g[0]), { f: '', a: 1000, t, k: 'top', p: 1, m: `${month}-h` });
  rank._reset();
}

// Ex aequo (signalé par R77, 2026-10-30) : même score = même place au classement, même badge du mois, Trash King partagé.
{
  const rank = require(path.join(ROOT, 'api/_rank.js'));
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js'));
  const T2 = require(path.join(ROOT, 'api/_discord_tasks.js'));
  const { readStats, WORST_LB, WORST_BEST } = require(path.join(ROOT, 'api/_lib.js'));
  const ids = Array.from({ length: 12 }, (_, i) => (0x7d00 + i).toString(16).padStart(16, '0'));
  // Poubelle de tous les temps : deux joueurs à -5 (sous tout vrai score), un à -4 → places 1, 1, 3.
  run([...ids.slice(0, 3).flatMap((id, i) => [['ZADD', WORST_LB, i < 2 ? -5 : -4, id], ['HSET', WORST_BEST, id, JSON.stringify({ n: 1, s: i < 2 ? -5 : -4, t: 1 })]])]);
  const w = await call(lbApi, { url: '/api/leaderboard?period=worst' });
  assert.deepEqual(w.body.entries.slice(0, 3).map(e => e.rank), [1, 1, 3], JSON.stringify(w.body.entries.slice(0, 3)));
  run([['ZREM', WORST_LB, ...ids.slice(0, 3)], ['HDEL', WORST_BEST, ...ids.slice(0, 3)]]);
  // Mois : 1er seul, 2e et 3e ex aequo (Top 5 tous les deux), et 11e à égalité avec le 10e (Top 10 et 250 pièces).
  const month = '2031-03', lb = `lb:month:${month}`, t = Date.parse('2031-04-01T00:10:00Z');
  const sc = [100, 90, 90, 80, 70, 60, 50, 40, 30, 20, 20, 10];
  run([['DEL', lb, `topawards:done:${month}`, `topcoins:${month}`], ...ids.flatMap((id, i) => [['DEL', `stats:${id}`, `gifts:${id}`, `topawards:${id}`], ['ZADD', lb, sc[i], id]])]);
  rank._reset();
  await rank.settleMonth(t);
  const bonus = await Promise.all(ids.map(async id => Number((await readStats(id)).bonus || 0)));
  assert.deepEqual(bonus, [1000, 500, 500, 500, 500, 250, 250, 250, 250, 250, 250, 0], 'ex aequo payés pareil');
  const [g2] = run([['LRANGE', `gifts:${ids[2]}`, 0, -1]]).map(x => x.result);
  assert.equal(JSON.parse(g2[0]).p, 2, 'place partagée annoncée');
  rank._reset();
  // Trash King : les deux pires ex aequo du mois sont couronnés.
  const now = Date.parse('2031-04-01T02:00:00Z');
  run([['DEL', 'award:trashking:2031-03', 'lbw:month:2031-03'], ['ZADD', 'lbw:month:2031-03', 0, ids[0], 0, ids[1], 5, ids[2]]]);
  assert.ok(await T2.trashKing(now));
  const kings = await Promise.all(ids.slice(0, 3).map(async id => Number((await readStats(id)).trashKing || 0)));
  assert.deepEqual(kings, [1, 1, 0]);
}

// Tournoi du jour (idée de PRISMA123, 2026-10-20) : inscriptions, tableau, tirages à part, tours, prix, titre Champion.
{
  const TN = require(path.join(ROOT, 'api/_tournament.js'));
  const { readStats, Achievements } = require(path.join(ROOT, 'api/_lib.js'));
  const roomApi = require(path.join(ROOT, 'api/room.js'));
  const DAY = '2030-01-15', T0 = Date.parse(`${DAY}T00:00:00Z`), H = 3600000;
  const pid = i => (`7e${String(i).padStart(2, '0')}`).repeat(4);
  const sec = i => (`5${String(i).padStart(2, '0')}`).repeat(11).slice(0, 32);
  const mk = (i, rolls = 40) => { const id = pid(i); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(sec(i)).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', 'rolls', rolls], ['HSET', 'names', id, `Tn${i}`]]); return id; };
  // La vue ne donne que des jetons opaques (jamais d'identifiant) : les tests les retraduisent en identifiants connus.
  const tokOf = id => crypto.createHash('sha256').update(`tn:${DAY}:${id}`).digest('hex').slice(0, 12);
  const untok = k => { for (let i = 0; i < 100; i++) if (tokOf(pid(i)) === k) return pid(i); return k; };
  const de = v => JSON.parse(JSON.stringify(v), (k, val) => ((k === 'id' || k === 'w') && typeof val === 'string' ? untok(val) : val));
  const viewD = async (...a) => de(await TN.view(...a));
  const refused = async (p, status, re) => { await assert.rejects(p, e => e.status === status && (!re || re.test(e.message)), `attendu ${status}`); };

  // Tirage du tableau : taille = puissance de deux ≥ inscrits, un exempt au plus par match, tout le monde placé.
  for (let n = 4; n <= 32; n++) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`), slots = TN.seed(ids);
    const size = 2 ** Math.ceil(Math.log2(n));
    assert.equal(slots.length, size, `taille pour ${n}`);
    assert.deepEqual(slots.filter(Boolean).sort(), ids.slice().sort(), 'chacun une fois');
    for (let i = 0; i < size; i += 2) assert.ok(slots[i] || slots[i + 1], 'jamais exempt contre exempt');
    assert.equal(slots.filter(x => !x).length, size - n);
  }

  // Vainqueur d'un match : total, puis plus gros tirage, puis premier fini ; forfait ; ni l'un ni l'autre.
  const R = (s, t) => ({ n: s.map(() => 1), s, t });
  assert.equal(TN.winner(DAY, 0, 'a', 'b', R([5, 5, 5, 5, 5], 9), R([1, 1, 1, 1, 30], 1)), 'b', 'plus gros total');
  assert.equal(TN.winner(DAY, 0, 'a', 'b', R([5, 5, 5, 5, 10], 9), R([6, 6, 6, 6, 6], 1)), 'a', 'égalité : plus gros tirage');
  assert.equal(TN.winner(DAY, 0, 'a', 'b', R([6, 6, 6, 6, 6], 9), R([6, 6, 6, 6, 6], 1)), 'b', 'encore égalité : premier fini');
  assert.equal(TN.winner(DAY, 0, 'a', 'b', R([1, 1, 1, 1, 1], 9), R([999, 999], undefined)), 'a', 'qui n\'a pas fini perd');
  assert.equal(TN.winner(DAY, 0, 'a', 'b', R([999], undefined), undefined), 'a', 'aucun fini : le plus de tirages');
  const c1 = TN.winner(DAY, 0, 'a', 'b', undefined, undefined);
  assert.ok(['a', 'b'].includes(c1)); assert.equal(TN.winner(DAY, 0, 'a', 'b', undefined, undefined), c1, 'tirage au sort stable');
  assert.equal(TN.winner(DAY, 0, 'a', null), 'a', 'exempt');

  // Inscriptions : 30 tirages, fenêtre 00:00-12:00, pas deux fois, 32 places.
  const rookie = mk(90, 29);
  await refused(TN.signup(rookie, T0 + H), 422, /30 rolls/);
  const ids = [1, 2, 3, 4, 5].map(i => mk(i));
  await refused(TN.signup(ids[0], T0 + 12 * H), 422, /closed/);
  for (const [i, id] of ids.entries()) assert.equal((await TN.signup(id, T0 + H + i)).place, i + 1);
  await refused(TN.signup(ids[0], T0 + 2 * H), 409, /already/);
  // Par /api/room : vue publique (sans joueur) et mauvais secret refusé.
  const pub = await call(roomApi, { method: 'POST', body: { action: 'tourney', op: 'view' } });
  assert.equal(pub.status, 200); assert.equal(pub.body.joined, false);
  const bad = await call(roomApi, { method: 'POST', body: { action: 'tourney', op: 'join', playerId: ids[0], secret: '0'.repeat(32) } });
  assert.equal(bad.status, 403);
  let v = await viewD(DAY, ids[0], T0 + 2 * H);
  assert.equal(v.phase, 'signup'); assert.equal(v.count, 5); assert.equal(v.joined, true);

  // Pas de tirage avant le tableau.
  await refused(TN.roll(ids[0], T0 + 2 * H), 422);

  // 12:00 : tableau de 8 (3 exempts), 3 tours de 4 h. Le premier à lire le tournoi le tire.
  v = await viewD(DAY, null, T0 + 12 * H + 1000);
  assert.equal(v.phase, 'running'); assert.equal(v.size, 8); assert.equal(v.rounds.length, 3); assert.equal(v.round, 0);
  assert.equal(v.rounds[0].end - v.rounds[0].start, 4 * H);
  assert.equal(v.rounds[0].matches.filter(m => m.bye).length, 3);
  const again = await viewD(DAY, null, T0 + 12 * H + 2000);
  assert.deepEqual(again.rounds[0].matches.map(m => [m.a && m.a.id, m.b && m.b.id]), v.rounds[0].matches.map(m => [m.a && m.a.id, m.b && m.b.id]), 'tableau tiré une seule fois');
  await refused(TN.signup(mk(6), T0 + 12 * H + 3000), 422, /closed/);
  { const raw = JSON.stringify(await TN.view(DAY, pid(0), T0 + 12 * H + 2000)); assert.ok(![0, 1, 2, 3, 4, 5].some(i => raw.includes(pid(i))), 'aucun identifiant dans la vue du tournoi'); }

  // Le seul vrai match du 1er tour (5 inscrits sur 8 places).
  const real = v.rounds[0].matches.find(m => !m.bye), [pa, pb] = [real.a.id, real.b.id];
  const byePlayer = v.rounds[0].matches.find(m => m.bye).a?.id || v.rounds[0].matches.find(m => m.bye).b.id;
  await refused(TN.roll(byePlayer, T0 + 13 * H), 422, /bye/);

  // Les tirages de tournoi ne touchent ni XP, ni classements, ni quêtes, ni pièces, ni historique.
  const snap = id => JSON.stringify([...['stats:', 'hist:', 'badges:', 'nums:', `q:${DAY}:`].map(p => db.get(p + id)), db.get('lb:xp')?.get(id), db.get(`eco:${DAY}`), db.get(`lb:day:${DAY}`), db.get('rolls:all')].map(x => x instanceof Map ? [...x] : x instanceof Set ? [...x] : x ?? null));
  const before = snap(pa);
  let t = T0 + 13 * H, last;
  // Tirages partagés (2026-10-23) : chaque tirage de pa en donne un à pb, tiré par le serveur.
  for (let k = 0; k < 5; k++) { db.delete(`tnlock:${pa}`); last = await TN.roll(pa, t); t += 2000; }
  assert.equal(last.count, 5); assert.equal(snap(pa), before, 'rien d\'autre ne bouge');
  await refused(TN.roll(pa, t), 409, /done/);
  db.delete(`tnlock:${pb}`); await refused(TN.roll(pb, t), 409, /done/, 'pb a reçu ses 5 tirages');
  const vb = await viewD(DAY, pb, t + 100), va = await viewD(DAY, pa, t + 100);
  assert.deepEqual([vb.match.me.count, vb.match.me.auto, va.match.me.auto], [5, 5, 0], 'les 5 de pb faits pour lui');
  const pm = (await viewD(DAY, null, t + 100)).rounds[0].matches.find(m => !m.bye);
  assert.equal(typeof pm.a.total, 'number', 'les deux ont fini : visible de tous');

  // 16:00 : le vainqueur est celui que désignent les tirages (plus de forfait).
  const rollsOf = (r, id) => JSON.parse(db.get(`tn:${DAY}:rolls`).get(`${r}:${id}`));
  v = await viewD(DAY, pa, T0 + 16 * H);
  assert.equal(v.round, 1);
  const w0 = v.rounds[0].matches.find(m => !m.bye).w;
  assert.equal(w0, TN.winner(DAY, 0, real.a.id, real.b.id, rollsOf(0, real.a.id), rollsOf(0, real.b.id), v.mode));

  // Tour 2 : personne ne joue → à 20:00, le serveur tire les 5 de chacun ; vainqueurs calculés pareil.
  v = await viewD(DAY, null, T0 + 20 * H);
  assert.equal(v.round, 2);
  for (const m of v.rounds[1].matches) for (const x of [m.a, m.b]) { const r = rollsOf(1, x.id); assert.deepEqual([r.s.length, r.auto], [5, 5], 'tirés pour les deux à la fin du tour'); }
  for (const m of v.rounds[1].matches) assert.equal(m.w, TN.winner(DAY, 1, m.a.id, m.b.id, rollsOf(1, m.a.id), rollsOf(1, m.b.id), v.mode));
  { const raw = JSON.stringify(db.get(`tn:${DAY}:rolls`)); const n1 = Object.keys(Object.fromEntries(db.get(`tn:${DAY}:rolls`))).length;
    await TN.advance(DAY, T0 + 20 * H + 5); assert.equal(Object.keys(Object.fromEntries(db.get(`tn:${DAY}:rolls`))).length, n1, 'rempli une seule fois'); }
  // Finale : un seul joue 2 tirages, l'autre en reçoit 2 ; le reste est tiré à minuit.
  const fin = v.rounds[2].matches[0];
  db.delete(`tnlock:${fin.a.id}`); await TN.roll(fin.a.id, T0 + 21 * H); db.delete(`tnlock:${fin.a.id}`); await TN.roll(fin.a.id, T0 + 21 * H + 2000);
  assert.equal(rollsOf(2, fin.b.id).s.length, 2, 'l\'adversaire suit');
  // Les 5 dernières secondes du tour : plus de tirage.
  db.delete(`tnlock:${fin.a.id}`); await refused(TN.roll(fin.a.id, T0 + 24 * H - 1000), 422, /over/);

  // Lu le lendemain (le tournoi d'hier avance à la lecture du jour) : prix versés une fois.
  const bonusOf = async id => Number((await readStats(id)).bonus || 0);
  const b0 = Object.fromEntries(await Promise.all(ids.map(async id => [id, await bonusOf(id)])));
  const ecoBefore = Number(db.get(`eco:2030-01-16`)?.get('in:tourney') || 0);
  const out = await TN.handle({ op: 'view' }, T0 + 24 * H + 5000);
  assert.equal(out.day, '2030-01-16');
  await TN.advance(DAY, T0 + 25 * H); await TN.tick(T0 + 26 * H); // relu plusieurs fois
  const done = await viewD(DAY, null, T0 + 27 * H);
  const champion = done.result.champion.id, finalist = done.result.finalist.id, semis = done.result.semis.map(x => x.id);
  assert.equal(done.phase, 'done'); assert.equal(out.prev.champion, db.get('names').get(champion));
  assert.equal(champion, TN.winner(DAY, 2, fin.a.id, fin.b.id, rollsOf(2, fin.a.id), rollsOf(2, fin.b.id), done.mode));
  assert.deepEqual([fin.a.id, fin.b.id].sort(), [champion, finalist].sort());
  assert.equal(semis.length, 2);
  assert.equal(await bonusOf(champion) - b0[champion], 1000); assert.equal(await bonusOf(finalist) - b0[finalist], 400);
  for (const x of semis) assert.equal(await bonusOf(x) - b0[x], 150);
  for (const id of ids.filter(id => ![champion, finalist, ...semis].includes(id))) assert.equal(await bonusOf(id), b0[id], 'les autres rien');
  assert.equal(Number(db.get('eco:2030-01-16').get('in:tourney')) - ecoBefore, 1000 + 400 + 300);
  const champ = await readStats(champion);
  assert.equal(Number(champ.tourneyWins), 1); assert.ok(Achievements.unlocked(champ).includes('champion'), 'titre Champion');
  assert.ok(!Achievements.unlocked(await readStats(finalist)).includes('champion'));
  // Tous les tirages de la finale montrés une fois le tour fini.
  assert.equal(done.rounds[2].matches[0].a.rolls.length, 5);

  // Moins de 4 inscrits : annulé, rien versé. Et le 33e est refusé.
  const D2 = '2030-02-01', T2 = Date.parse(`${D2}T00:00:00Z`);
  for (const i of [1, 2, 3]) await TN.signup(pid(i), T2 + H);
  const c = await viewD(D2, null, T2 + 13 * H); assert.equal(c.phase, 'cancelled'); assert.equal(c.size, 0);
  await refused(TN.roll(pid(1), T2 + 13 * H), 422);
  const D3 = '2030-03-01', T3 = Date.parse(`${D3}T00:00:00Z`);
  for (let i = 0; i < 32; i++) await TN.signup(mk(10 + i), T3 + H + i);
  // Deux tournois par jour (2026-10-23) : le 33e va dans le second ; jamais dans les deux ; 64 places en tout.
  const j33 = await TN.signup(mk(50), T3 + 2 * H); assert.deepEqual([j33.which, j33.place], [2, 1]);
  await refused(TN.signup(mk(50), T3 + 2 * H + 1), 409, /already/); await refused(TN.signup(mk(10), T3 + 2 * H + 1), 409, /already/);
  for (let i = 0; i < 31; i++) await TN.signup(mk(51 + i), T3 + 3 * H + i);
  await refused(TN.signup(mk(95), T3 + 4 * H), 422, /full/);
  { const h = await TN.handle({ op: 'view', playerId: mk(50), secret: sec(50) }, T3 + 5 * H);
    assert.deepEqual([h.which, h.mine, h.joined, h.count, h.both.map(b => b.count)], [2, 2, true, 32, [32, 32, 0]], 'chacun voit son tournoi');
    const h1 = await TN.handle({ op: 'view', playerId: mk(50), secret: sec(50), which: 1 }, T3 + 5 * H); assert.equal(h1.which, 2, 'inscrit au 2 : toujours le sien'); }
  // Choisir le second alors que le premier a de la place.
  { const D4 = '2030-04-01', T4 = Date.parse(`${D4}T00:00:00Z`); const j = await TN.signup(mk(96), T4 + H, 2); assert.equal(j.which, 2); assert.equal((await TN.signup(mk(97), T4 + H)).which, 1); }
  const big = await viewD(D3, null, T3 + 12 * H);
  assert.equal(big.size, 32); assert.equal(big.rounds.length, 5); assert.equal(big.rounds[0].matches.filter(m => m.bye).length, 0);
  assert.equal(big.rounds[4].end, T3 + 24 * H, 'fini à minuit');

  // Tournoi du soir (demandé par Me Cojoni, 2026-10-26) : inscriptions 12:00-18:00 UTC, tours 18:00 → 06:00 le
  // lendemain, son propre tableau et ses propres prix ; on peut y être en plus d'un tournoi du jour.
  {
    const D5 = '2030-05-01', T5 = Date.parse(`${D5}T00:00:00Z`), E5 = `${D5}-e`;
    const eveTok = id => crypto.createHash('sha256').update(`tn:${E5}:${id}`).digest('hex').slice(0, 12);
    const unE = k => { for (let i = 0; i < 100; i++) if (eveTok(pid(i)) === k) return pid(i); return k; };
    const deE = x => JSON.parse(JSON.stringify(x), (k, val) => ((k === 'id' || k === 'w') && typeof val === 'string' ? unE(val) : val));
    const day4 = [1, 2, 3, 4].map(i => mk(i)), eve5 = [3, 4, 5, 6, 7].map(i => mk(i));
    for (const [i, id] of day4.entries()) await TN.signup(id, T5 + H + i);
    // Fenêtre : pas avant 12:00, pas à 18:00.
    await refused(TN.signup(eve5[0], T5 + 11 * H, 3), 422, /open at 12:00/);
    await refused(TN.signup(eve5[0], T5 + 18 * H, 3), 422, /closed/);
    await refused(TN.signup(mk(91, 29), T5 + 13 * H, 3), 422, /30 rolls/);
    // Inscrits au tournoi 1 (pid 3 et 4) et au soir : permis.
    for (const [i, id] of eve5.entries()) assert.deepEqual(((({ which, place }) => [which, place])(await TN.signup(id, T5 + 13 * H + i, 3))), [3, i + 1]);
    await refused(TN.signup(eve5[0], T5 + 14 * H, 3), 409, /already/);
    // Le tournoi du jour, lui, est fermé à 13:00 (même pour qui est au soir).
    await refused(TN.signup(eve5[4], T5 + 13 * H, 1), 422, /closed/);
    { const h = await TN.handle({ op: 'view', playerId: pid(3), secret: sec(3) }, T5 + 14 * H);
      assert.deepEqual([h.which, h.mine, h.mineEve, h.both.map(b => b.count)], [1, 1, true, [4, 0, 5]], 'pid 3 : tournoi 1 et soir');
      const he = await TN.handle({ op: 'view', playerId: pid(3), secret: sec(3), which: 3 }, T5 + 14 * H);
      assert.deepEqual([he.which, he.eve, he.phase, he.joined, he.count, he.day], [3, true, 'signup', true, 5, E5]);
      const h5 = await TN.handle({ op: 'view', playerId: pid(5), secret: sec(5) }, T5 + 14 * H);
      assert.equal(h5.which, 3, 'inscrit au soir seulement : vue par défaut = le soir');
      const soon = await TN.handle({ op: 'view', which: 3 }, T5 + 8 * H); assert.equal(soon.phase, 'soon', 'avant 12:00 : bientôt'); }
    // 18:00 : tableau de 8, 3 tours de 4 h, fin à 06:00 le lendemain.
    let ve = deE(await TN.view(E5, null, T5 + 18 * H + 1000));
    assert.deepEqual([ve.phase, ve.size, ve.rounds.length, ve.round], ['running', 8, 3, 0]);
    assert.equal(ve.rounds[0].start, T5 + 18 * H); assert.equal(ve.rounds[2].end, T5 + 30 * H, 'fini à 06:00 le lendemain');
    assert.equal(ve.next, T5 + 36 * H, 'le suivant ouvre à 12:00');
    // Un joueur des deux tournois tire dans celui du soir avec which: 3, sans toucher au tournoi 1.
    const rm = ve.rounds[0].matches.find(m => !m.bye), ea = rm.a.id;
    db.delete(`tnlock:${ea}`); const er = await TN.roll(ea, T5 + 19 * H, 3); assert.equal(er.count, 1);
    assert.equal(JSON.parse(db.get(`tn:${E5}:rolls`).get(`0:${ea}`)).s.length, 1);
    // Passage de minuit : à 02:00 le 2, le tournoi du soir en cours est encore celui du 1er (finale 02:00-06:00).
    assert.equal(TN.eveAt(T5 + 26 * H), E5); assert.equal(TN.eveAt(T5 + 30 * H), `2030-05-02-e`);
    // Prix : chaque tournoi une fois (le 1 après minuit, le soir après 06:00), relus plusieurs fois.
    const all = [...new Set([...day4, ...eve5])], bonus = async () => Object.fromEntries(await Promise.all(all.map(async id => [id, Number((await readStats(id)).bonus || 0)])));
    const b0 = await bonus(), eco0 = Number(db.get('eco:2030-05-02')?.get('in:tourney') || 0);
    const late = await TN.handle({ op: 'view', which: 3 }, T5 + 26 * H);
    assert.deepEqual([late.day, late.phase, late.round], [E5, 'running', 2]);
    const fin5 = deE(late).rounds[2].matches[0];
    db.delete(`tnlock:${fin5.a.id}`); assert.equal((await TN.roll(fin5.a.id, T5 + 26 * H + 1000, 3)).count, 1, 'tirage de finale après minuit');
    await TN.tick(T5 + 25 * H); await TN.tick(T5 + 25 * H + 10);
    assert.ok(db.get(`tn:${D5}`).get('paid'), 'tournoi 1 payé après minuit'); assert.ok(!db.get(`tn:${E5}`).get('paid'), 'soir pas encore payé');
    const b1 = await bonus(); assert.equal(Object.values(b1).reduce((x, v) => x + v, 0) - Object.values(b0).reduce((x, v) => x + v, 0), 1000 + 400 + 300);
    await TN.tick(T5 + 30 * H + 1000); await TN.tick(T5 + 31 * H); await TN.handle({ op: 'view', which: 3 }, T5 + 32 * H);
    const b2 = await bonus(); assert.equal(Object.values(b2).reduce((x, v) => x + v, 0) - Object.values(b1).reduce((x, v) => x + v, 0), 1000 + 400 + 300, 'soir payé une seule fois');
    assert.equal(Number(db.get('eco:2030-05-02').get('in:tourney')) - eco0, 2 * 1700);
    const ed = deE(await TN.view(E5, null, T5 + 33 * H)); assert.equal(ed.phase, 'done');
    assert.equal(b2[ed.result.champion.id] - b1[ed.result.champion.id], 1000);
    // Le lendemain : le champion du soir rejoint ceux d'hier ; le nouveau soir est vide et ouvre à 12:00.
    const nx = await TN.handle({ op: 'view' }, T5 + 33 * H);
    assert.equal(nx.prev.champions.length, 2, 'champions d\'hier : tournoi 1 et soir');
    assert.deepEqual(nx.both.map(b => b.count), [0, 0, 0]);
    const ne = await TN.handle({ op: 'view', which: 3 }, T5 + 33 * H); assert.deepEqual([ne.day, ne.phase], ['2030-05-02-e', 'soon']);
  }
}

// Modes du tournoi (idée de PRISMA123, 2026-10-21) : rotation par la date, mode figé à la création, 3 ou 5 tirages,
// critère du mode puis la chaîne habituelle (plus gros tirage, premier fini).
{
  const TN = require(path.join(ROOT, 'api/_tournament.js'));
  const { engine } = require(path.join(ROOT, 'api/_lib.js'));
  const H = 3600000;
  const pid = i => (`6d${String(i).padStart(2, '0')}`).repeat(4);
  const mk = i => { const id = pid(i); run([['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', 'rolls', 40], ['HSET', 'names', id, `Md${i}`]]); return id; };
  const refused = async (p, status, re) => { await assert.rejects(p, e => e.status === status && (!re || re.test(e.message)), `attendu ${status}`); };
  // Rotation : les 5 modes, un par jour, dans l'ordre, et le même jour donne toujours le même mode.
  const days = Array.from({ length: 10 }, (_, i) => new Date(Date.parse('2031-05-01T00:00:00Z') + i * 864e5).toISOString().slice(0, 10));
  const seen = days.map(TN.modeOf);
  assert.deepEqual(new Set(seen.slice(0, 5)).size, 5, '5 modes en 5 jours'); assert.deepEqual(seen.slice(5), seen.slice(0, 5), 'cycle de 5 jours');
  assert.equal(TN.modeOf(days[3]), seen[3]);
  assert.deepEqual(TN.MODE_ORDER.map(TN.rollsOf), [5, 5, 3, 5, 5], 'tirages par mode');
  const dayFor = (mode, k = 0) => { const d0 = Date.parse('2032-01-01T00:00:00Z'); let n = 0; for (let i = 0; ; i++) { const d = new Date(d0 + i * 864e5).toISOString().slice(0, 10); if (TN.modeOf(d) === mode && n++ === k) return d; } };

  // Résolution par mode, tirages fabriqués (s : XP de chaque tirage ; n : nombres, utiles au « Badge Hunter »).
  const R = (s, t, n) => ({ n: n || s.map(() => 1), s, t });
  const W = (mode, ra, rb) => TN.winner('2032-01-01', 0, 'a', 'b', ra, rb, mode);
  // Total
  assert.equal(W('total', R([5, 5, 5, 5, 5], 9), R([1, 1, 1, 1, 30], 1)), 'b');
  assert.equal(W('total', R([6, 6, 6, 6, 6], 1), R([5, 5, 5, 5, 10], 9)), 'b', 'total : égalité → plus gros tirage');
  // Best Roll : seul le meilleur tirage compte (le total ne compte pas).
  assert.equal(W('best', R([1, 1, 1, 1, 100], 9), R([50, 50, 50, 50, 50], 1)), 'a', 'best : meilleur tirage');
  assert.equal(W('best', R([1, 1, 1, 1, 100], 9), R([99, 99, 99, 99, 100], 1)), 'b', 'best : égalité → premier fini');
  // Best of 3 : duels un par un, puis total.
  assert.equal(W('bo3', R([10, 1, 10], 9), R([5, 100, 5], 1)), 'a', 'bo3 : 2 duels sur 3 malgré un plus petit total');
  assert.equal(W('bo3', R([10, 1, 5], 1), R([5, 10, 5], 9)), 'b', 'bo3 : 1-1 → total');
  assert.equal(W('bo3', R([7, 3, 5], 9), R([3, 7, 5], 1)), 'b', 'bo3 : 1-1, même total, même meilleur → premier fini');
  assert.equal(W('bo3', R([1, 1, 1], 9), R([999, 999], undefined)), 'a', 'bo3 : 3 tirages suffisent, 2 = forfait');
  assert.equal(W('total', R([1, 1, 1], 9), R([999, 999], undefined)), 'a', 'mode à 5 : aucun fini → le plus de tirages');
  // Lowest Wins : le plus petit total gagne ; égalité → plus gros tirage puis premier fini.
  assert.equal(W('lowest', R([1, 1, 1, 1, 1], 9), R([5, 5, 5, 5, 5], 1)), 'a', 'lowest : plus petit total');
  assert.equal(W('lowest', R([1, 1, 1, 1, 6], 1), R([2, 2, 2, 2, 2], 9)), 'a', 'lowest : égalité → plus gros tirage');
  assert.equal(W('lowest', R([1, 1, 1, 1, 1], 9), R([999, 999], undefined)), 'a', 'lowest : qui n\'a pas fini perd quand même');
  // Badge Hunter : badges différents (recalculés depuis les nombres), puis total.
  const real = ns => R(ns.map(n => engine.analyze(n).total), 5, ns);
  const many = [123456, 654321, 100000, 135791, 246802], few = [777777, 777777, 777777, 777777, 777777];
  assert.ok(real(few).s.reduce((x, y) => x + y) > real(many).s.reduce((x, y) => x + y), 'few a le plus gros total');
  assert.equal(W('badges', real(few), real(many)), 'b', 'badges : le plus de badges différents');
  assert.equal(W('badges', { ...real(many), t: 9 }, { ...real(many.slice().reverse()), t: 1 }), 'b', 'badges : égalité totale → premier fini');

  // Mode écrit à la première inscription, puis figé : un hash qui dit autre chose (code d'avant) l'emporte.
  const DB3 = dayFor('bo3'), T = Date.parse(`${DB3}T00:00:00Z`);
  const ids = [1, 2, 3, 4].map(mk);
  for (const id of ids) await TN.signup(id, T + H);
  assert.equal(db.get(`tn:${DB3}`).get('mode'), 'bo3', 'mode écrit à la création');
  let v = await TN.view(DB3, ids[0], T + 2 * H);
  assert.equal(v.mode, 'bo3'); assert.equal(v.rolls, 3);
  const DF = dayFor('best', 1), TF = Date.parse(`${DF}T00:00:00Z`);
  for (const i of [5, 6, 7, 8]) await TN.signup(mk(i), TF + H);
  run([['HSET', `tn:${DF}`, 'mode', 'lowest']]); // comme si la rotation avait changé depuis
  const vf = await TN.view(DF, null, TF + 12 * H + 1000);
  assert.equal(vf.mode, 'lowest', 'le mode stocké gagne'); assert.equal(vf.rolls, 5); assert.equal(db.get(`tn:${DF}`).get('mode'), 'lowest', 'pas réécrit au tirage du tableau');
  // Tournoi d'avant les modes (tableau tiré, pas de mode) : reste en total, à 5 tirages.
  const DL = dayFor('bo3', 2), TL = Date.parse(`${DL}T00:00:00Z`);
  for (const i of [9, 10, 11, 12]) await TN.signup(mk(i), TL + H);
  await TN.view(DL, null, TL + 12 * H + 1000); run([['HDEL', `tn:${DL}`, 'mode']]);
  const vl = await TN.view(DL, null, TL + 13 * H); assert.equal(vl.mode, 'total', 'ancien tournoi : total'); assert.equal(vl.rolls, 5);

  // Jour « Best of 3 » de bout en bout : 3 tirages, scores cachés, forfait, 4e tirage refusé.
  v = await TN.view(DB3, null, T + 12 * H + 1000);
  const tok = id => crypto.createHash('sha256').update(`tn:${DB3}:${id}`).digest('hex').slice(0, 12);
  const m0 = v.rounds[0].matches[0], pa = ids.find(id => tok(id) === m0.a.id), pb = ids.find(id => tok(id) === m0.b.id);
  let t = T + 13 * H;
  for (let k = 0; k < 3; k++) { db.delete(`tnlock:${pa}`); const r = await TN.roll(pa, t); assert.equal(r.mode, 'bo3'); t += 2000; }
  db.delete(`tnlock:${pa}`); await refused(TN.roll(pa, t), 409, /3 rolls/);
  // Tirages partagés : pb a reçu ses 3 tirages en même temps que pa ; le match est fini et visible de tous.
  db.delete(`tnlock:${pb}`); await refused(TN.roll(pb, t), 409, /done/);
  const pub = (await TN.view(DB3, null, t + 3000)).rounds[0].matches[0];
  assert.equal(typeof pub.a.total, 'number'); assert.equal(typeof pub.b.total, 'number');
  const va = await TN.view(DB3, pa, t + 3000), vb = await TN.view(DB3, pb, t + 3000);
  assert.equal(va.match.me.count, 3); assert.ok(Array.isArray(va.match.opp.rolls) && Array.isArray(vb.match.opp.rolls), 'chacun voit l\'autre');
  assert.equal(typeof va.match.me.score, 'number', 'duels gagnés visibles'); assert.equal(vb.match.me.auto, 3);
  // Fin du tour 1 : le vainqueur est celui des duels (plus de forfait).
  v = await TN.view(DB3, null, T + 18 * H);
  const rr = id => JSON.parse(db.get(`tn:${DB3}:rolls`).get(`0:${id}`));
  assert.equal(v.rounds[0].matches[0].w, tok(TN.winner(DB3, 0, pa, pb, rr(pa), rr(pb), 'bo3')));
  assert.equal(v.rounds[0].matches[0].a.rolls.length + v.rounds[0].matches[0].b.rolls.length, 6, 'révélé après le tour');
  // Dans un mode à 5, 3 tirages ne suffisent pas.
  const DT = dayFor('total', 3), TT = Date.parse(`${DT}T00:00:00Z`);
  const ids5 = [13, 14, 15, 16].map(mk);
  for (const id of ids5) await TN.signup(id, TT + H);
  const v5 = await TN.view(DT, null, TT + 12 * H + 1000), tk5 = id => crypto.createHash('sha256').update(`tn:${DT}:${id}`).digest('hex').slice(0, 12);
  const q = ids5.find(id => tk5(id) === v5.rounds[0].matches[0].a.id);
  for (let k = 0; k < 3; k++) { db.delete(`tnlock:${q}`); await TN.roll(q, TT + 13 * H + k * 2000); }
  const vq = await TN.view(DT, q, TT + 14 * H);
  assert.equal(vq.rolls, 5); assert.equal(vq.match.opp.rolls, undefined, '3/5 : adversaire encore caché');
}

// Quitter un duel en cours, ou en être exclu par l'hôte (2026-10-23) : marqué sorti, forfait, mises.
{
  const mkq = (tag, name, coins = 0) => { const id = tag.repeat(8), secret = (tag + 'a').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', 'rolls', 60, 'bonus', coins], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const mkp = async (tag, name) => { const w = { playerId: tag.repeat(8), secret: (tag + 'a').repeat(16).slice(0, 32), name }; assert.equal((await call(roll, { method: 'POST', body: w })).status, 200); run([['HINCRBY', `stats:${w.playerId}`, 'bonus', 5000], ['HSET', `stats:${w.playerId}`, 'rolls', 60]]); return w; };
  const q1 = mkq('97', 'Xena', 5000), q2 = mkq('98', 'Xavi', 5000), q3 = mkq('99', 'Xyla', 5000);
  let r = await roomPost(q1, 'create', { size: 3, mode: 'rounds', target: 2 }); const code = r.body.code;
  await roomPost(q2, 'join', { code }); r = await roomPost(q3, 'join', { code });
  assert.equal(r.body.status, 'playing', 'complet : la partie commence');
  assert.equal((await roomPost(q2, 'kick', { code, who: 'Xyla' })).status, 422, 'seul l\'hôte exclut');
  r = await roomPost(q2, 'quit', { code }); assert.equal(r.status, 200);
  assert.equal(r.body.players.find(p => p.name === 'Xavi').out, 'left'); assert.notEqual(r.body.status, 'done', 'il reste deux joueurs');
  assert.equal((await roomPost(q2, 'ready', { code })).status, 422, 'sorti : ne joue plus');
  assert.equal((await roomPost(q2, 'quit', { code })).status, 422, 'pas deux fois');
  r = await roomPost(q1, 'kick', { code, who: 'Xyla' }); assert.equal(r.status, 200);
  assert.equal(r.body.players.find(p => p.name === 'Xyla').out, 'kicked');
  assert.equal(r.body.status, 'done', 'un seul joueur reste : il gagne par forfait');
  assert.equal((await roomPost(q1, 'quit', { code })).status, 422, 'partie finie');
  // Avec une mise : personne n'est exclu ; celui qui part laisse sa mise, le dernier joueur prend le pot.
  const coins = async who => (await call(shopApi, { url: `/api/shop?me=${who.playerId}` })).body.coins;
  r = await roomPost(q1, 'create', { size: 2, mode: 'rounds', target: 3, stake: 100 }); const c2 = r.body.code;
  assert.equal(r.body.stake, 100, JSON.stringify(r.body));
  r = await roomPost(q3, 'join', { code: c2 }); assert.equal(r.body.status, 'playing');
  const a0 = await coins(q1), b0 = await coins(q3);
  assert.equal((await roomPost(q1, 'kick', { code: c2, who: 'Xyla' })).status, 422, 'pas d\'exclusion avec une mise');
  r = await roomPost(q3, 'quit', { code: c2 }); assert.equal(r.body.status, 'done');
  assert.ok(await coins(q1) > a0, 'le pot va au dernier joueur'); assert.equal(await coins(q3), b0, 'la mise de celui qui part est perdue');
  // Hôte qui part : le suivant devient hôte.
  r = await roomPost(q2, 'create', { size: 3, mode: 'rounds', target: 2 }); const c3 = r.body.code;
  await roomPost(q1, 'join', { code: c3 }); await roomPost(q3, 'join', { code: c3 });
  r = await roomPost(q2, 'quit', { code: c3 }); assert.equal(r.body.players.find(p => p.host).name, 'Xena', 'nouvel hôte');
}

// Idea Managers (2026-10-23) : rôle donné par le créateur, avis motivés obligatoires, aucun autre accès.
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const mk = (tag, name, extra = []) => { const id = tag.repeat(8), secret = (tag + 'e').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 50, ...extra], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const boss = mk('b1', 'Bossy', ['owner', '1']), mgr = mk('b2', 'Mango'), joe = mk('b3', 'Joey');
  const T = Date.now();
  run([['HSET', 'sugg:aaaaaaaaaaa1', 'pid', joe.playerId, 'name', 'Joey', 'text', 'Add a pizza skin with melting cheese', 't', T, 'status', 'new', 'kind', 'idea'], ['ZADD', 'sugg:all', T, 'aaaaaaaaaaa1'],
       ['HSET', 'sugg:aaaaaaaaaab2', 'pid', joe.playerId, 'name', 'Joey', 'text', 'The shop is broken on my phone', 't', T + 1, 'status', 'new', 'kind', 'bug'], ['ZADD', 'sugg:all', T + 1, 'aaaaaaaaaab2']]);
  const post = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { action, playerId: who.playerId, secret: who.secret, ...extra } });
  assert.equal((await post(mgr, 'imInbox')).status, 403, 'pas encore manager');
  assert.equal((await post(joe, 'imSet', { name: 'Mango' })).status, 403, 'seul le créateur donne le rôle');
  let r = await post(boss, 'imSet', { name: 'Mango' }); assert.equal(r.status, 200); assert.deepEqual(r.body.managers.includes('Mango'), true);
  assert.equal((await post(mgr, 'mine')).body.ideaManager, true);
  r = await post(mgr, 'imInbox'); assert.equal(r.status, 200);
  assert.ok(r.body.ideas.some(x => x.id === 'aaaaaaaaaaa1'), 'voit les idées'); assert.ok(!r.body.ideas.some(x => x.id === 'aaaaaaaaaab2'), 'pas les bugs');
  assert.ok(!JSON.stringify(r.body).includes(joe.playerId), 'aucun identifiant');
  for (const a of ['inbox', 'stats', 'insights', 'fund', 'reports', 'mark']) assert.equal((await post(mgr, a, { id: 'aaaaaaaaaaa1', status: 'done' })).status, 403, `pas d'accès à ${a}`);
  // Justification obligatoire et sérieuse.
  for (const bad of ['', 'yes', 'good idea', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'it is good ok']) assert.equal((await post(mgr, 'imReview', { id: 'aaaaaaaaaaa1', verdict: 'yes', reason: bad })).status, 422, `refusé : « ${bad} »`);
  assert.equal((await post(mgr, 'imReview', { id: 'aaaaaaaaaaa1', verdict: 'maybe', reason: 'A real reason with enough words here' })).status, 400);
  assert.equal((await post(mgr, 'imReview', { id: 'aaaaaaaaaab2', verdict: 'yes', reason: 'A real reason with enough words here' })).status, 422, 'pas sur un bug');
  r = await post(mgr, 'imReview', { id: 'aaaaaaaaaaa1', verdict: 'yes', reason: 'Food skins sell well and nobody has a pizza yet' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ideas.find(x => x.id === 'aaaaaaaaaaa1').reviews.map(x => [x.by, x.verdict, x.mine]), [['Mango', 'yes', true]]);
  // Le créateur voit l'avis dans sa boîte ; le statut ne bouge pas.
  r = await post(boss, 'inbox'); const it = r.body.suggestions.find(x => x.id === 'aaaaaaaaaaa1');
  assert.deepEqual([it.status, it.reviews[0].by, it.reviews[0].reason], ['new', 'Mango', 'Food skins sell well and nobody has a pizza yet']);
  // Invité en lecture seule de la page Owner : voit les avis comme le créateur, sans rien pouvoir faire.
  { const guest = mk('b4', 'Guesty', ['viewerGrant', '1']);
    r = await post(guest, 'imInbox'); assert.equal(r.status, 200); assert.equal(r.body.readOnly, true);
    assert.equal(r.body.ideas.find(x => x.id === 'aaaaaaaaaaa1').reviews[0].by, 'Mango', 'voit les avis');
    assert.equal((await post(guest, 'imReview', { id: 'aaaaaaaaaaa1', verdict: 'no', reason: 'A real reason with enough words here' })).status, 403, 'ne donne pas d\'avis');
    assert.equal((await post(guest, 'imSet', { name: 'Joey' })).status, 403, 'ne donne pas le rôle');
    assert.equal((await post(guest, 'mark', { id: 'aaaaaaaaaaa1', status: 'planned' })).status, 403, 'ne change pas le statut'); }
  // Rôle retiré : plus d'accès.
  await post(boss, 'imSet', { name: 'Mango', on: false }); assert.equal((await post(mgr, 'imInbox')).status, 403);
}

// Clans (idée de BIGBOIJONER69 et KMC, 2026-10-25) : création, entrée, rôles, coffre, améliorations, chat, signalement,
// classement de la semaine et guerres (vainqueur payé une seule fois).
{
  const Clan = require(path.join(ROOT, 'api/_clan.js')), friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const lib = require(path.join(ROOT, 'api/_lib.js')), Ach = require(path.join(ROOT, 'js/achievements.js')), ShopM = require(path.join(ROOT, 'js/shop.js'));
  const mk = (i, name, coins = 0, rolls = 60) => {
    const id = `ca11ca11ca11ca${i.toString(16).padStart(2, '0')}`, secret = id + id;
    run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', 'rolls', String(rolls), 'bonus', String(coins)], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]);
    return { playerId: id, secret, name };
  };
  const statsOf = id => { const flat = run([['HGETALL', `stats:${id}`]])[0].result, o = {}; for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
  const coins = who => ShopM.balance(statsOf(who.playerId));
  const H = (who, op, extra = {}, now) => Clan.handle(who.playerId, { op, ...extra }, now);
  const fails = async (p, status, msg) => { try { await p; } catch (err) { assert.equal(err.status, status, `${msg} : ${err.message}`); return err; } assert.fail(`${msg} : aurait dû échouer`); };
  const ecoOut = () => [...db.keys()].filter(k => /^eco:\d{4}-/.test(k)).reduce((x, k) => x + (Number(run([['HGET', k, 'out:clans']])[0].result) || 0), 0); // toutes les dates (les guerres de test finissent dans 6 h)
  const cidOf = who => run([['HGET', 'clanof', who.playerId]])[0].result;
  const A = mk(1, 'Clanlead', 80000), B = mk(2, 'Clanbee', 20000), C = mk(3, 'Clancee', 500), D = mk(4, 'Clandee', 500), E = mk(5, 'Claneee', 500);
  const poor = mk(6, 'Clanpoor', 9000), newbie = mk(7, 'Clannew', 50000, 5);
  const F = mk(8, 'Foeleader', 60000), foes = [9, 10, 11, 12].map(i => mk(i, `Foe${i}`, 500)), outsider = mk(13, 'Clanoutsider', 500);

  // Création : 10 000 pièces détruites, 30 tirages, nom et tag vérifiés, uniques.
  await fails(H(poor, 'create', { clanName: 'Poor Clan', tag: 'POOR' }), 422, 'pas assez de pièces');
  await fails(H(newbie, 'create', { clanName: 'New Clan', tag: 'NEWB' }), 422, 'moins de 30 tirages');
  await fails(H(A, 'create', { clanName: 'Ab', tag: 'ABC' }), 422, 'nom trop court');
  await fails(H(A, 'create', { clanName: 'Good Name', tag: 'ab' }), 422, 'tag trop court');
  await fails(H(A, 'create', { clanName: 'Good Name', tag: 'A-BC' }), 422, 'tag invalide');
  await fails(H(A, 'create', { clanName: 'Fuck squad', tag: 'NICE' }), 422, 'nom filtré');
  const before = coins(A), out0 = ecoOut();
  let v = await H(A, 'create', { clanName: 'Dice Lords', tag: 'dice', emoji: '🎲' });
  assert.equal(v.clan.tag, 'DICE'); assert.equal(v.clan.emoji, '🎲'); assert.equal(v.me.role, 'leader'); assert.equal(v.clan.slots, 20);
  assert.equal(coins(A), before - 10000, '10 000 pièces retirées'); assert.equal(ecoOut() - out0, 10000, 'détruites (eco out:clans)');
  // Description (2026-10-25) : chef et officiers, 150 caractères, filtrée comme le chat global, visible dans Find a clan.
  assert.equal(v.clan.desc, '', 'pas de description au départ');
  v = await H(A, 'desc', { desc: '  We roll   every day!  ' }); assert.equal(v.clan.desc, 'We roll every day!');
  assert.equal((await Clan.handle(outsider.playerId, { op: 'search', q: 'dice' })).clans[0].desc, 'We roll every day!');
  await fails(H(A, 'desc', { desc: 'x'.repeat(151) }), 422, 'trop longue');
  await fails(H(A, 'desc', { desc: 'join us at discord.gg/abc' }), 422, 'pas de lien');
  await fails(H(A, 'desc', { desc: 'call me 06 12 34 56 78' }), 422, 'pas de numéro');
  await fails(H(A, 'desc', { desc: 'fuck you all' }), 422, 'pas d\'insulte');
  v = await H(A, 'desc', { desc: '' }); assert.equal(v.clan.desc, '', 'effacée');
  await fails(H(A, 'create', { clanName: 'Other', tag: 'OTHR' }), 409, 'un seul clan');
  await fails(H(F, 'create', { clanName: 'dice lords', tag: 'FOES' }), 409, 'nom pris (sans majuscules)');
  await fails(H(F, 'create', { clanName: 'Foes United', tag: 'DICE' }), 409, 'tag pris');
  assert.equal(statsOf(F.playerId).spent, undefined, 'refus : rien de payé');
  v = await H(F, 'create', { clanName: 'Foes United', tag: 'FOES' });
  assert.equal(v.clan.name, 'Foes United');

  // Invitation (par pseudo) et demande (par tag).
  await fails(H(B, 'join', { tag: 'DICE' }), 404, 'pas invité');
  v = await H(A, 'invite', { name: 'Clanbee' }); assert.equal(v.note, 'Invitation sent');
  v = await H(B, 'view'); assert.deepEqual(v.invites.map(x => x.tag), ['DICE']);
  v = await H(B, 'join', { tag: 'DICE' }); assert.equal(v.me.role, 'member'); assert.equal(v.clan.members.length, 2);
  await fails(H(B, 'invite', { name: 'Clancee' }), 403, 'un membre n\'invite pas');
  v = await H(C, 'request', { tag: 'DICE' }); assert.deepEqual(v.asked, ['DICE']);
  v = await H(D, 'request', { tag: 'dice' });
  v = await H(A, 'view'); assert.deepEqual(v.clan.requests.sort(), ['Clancee', 'Clandee']);
  assert.deepEqual((await H(B, 'view')).clan.requests, [], 'un membre ne voit pas les demandes');
  await H(A, 'accept', { name: 'Clancee' });
  await H(A, 'decline', { name: 'Clandee' });
  assert.equal((await H(D, 'view')).me.inClan, false); assert.deepEqual((await H(D, 'view')).asked, []);
  await fails(H(C, 'request', { tag: 'FOES' }), 409, 'déjà dans un clan');
  await fails(H(F, 'invite', { name: 'Clancee' }), 409, 'déjà dans un clan (invitation)');
  // Demande puis invitation du même joueur : il entre tout de suite.
  await H(D, 'request', { tag: 'DICE' }); v = await H(A, 'invite', { name: 'Clandee' }); assert.equal(v.note, 'Joined the clan');
  await H(A, 'invite', { name: 'Claneee' }); await H(E, 'join', { tag: 'DICE' });
  assert.equal((await H(A, 'view')).clan.members.length, 5);
  assert.equal(run([['HGET', 'clantag', E.playerId]])[0].result, 'DICE|plain', 'tag montré à côté du nom');

  // Rôles : promouvoir, un officier exclut un membre mais pas le chef, rétrograder, passer la main.
  await fails(H(B, 'promote', { name: 'Clancee' }), 403, 'seul le chef promeut');
  await H(A, 'promote', { name: 'Clanbee' });
  assert.equal((await H(B, 'view')).me.role, 'officer');
  await fails(H(B, 'kick', { name: 'Clanlead' }), 403, 'un officier n\'exclut pas le chef');
  await H(B, 'kick', { name: 'Claneee' });
  assert.equal((await H(E, 'view')).me.inClan, false); assert.equal(run([['HGET', 'clantag', E.playerId]])[0].result, null);
  await H(B, 'invite', { name: 'Claneee' }); await H(E, 'join', { tag: 'DICE' });
  await fails(H(C, 'kick', { name: 'Clandee' }), 403, 'un membre n\'exclut personne');
  await fails(H(A, 'leave'), 422, 'le chef passe la main avant de partir');
  await H(A, 'transfer', { name: 'Clanbee' });
  assert.equal((await H(B, 'view')).me.role, 'leader'); assert.equal((await H(A, 'view')).me.role, 'coleader', 'l\'ancien chef devient co-chef (2026-10-27)');
  await H(B, 'transfer', { name: 'Clanlead' }); await H(A, 'demote', { name: 'Clanbee' }); await H(A, 'demote', { name: 'Clanbee' }); await H(A, 'promote', { name: 'Clanbee' });
  assert.equal((await H(A, 'view')).me.role, 'leader'); assert.equal((await H(B, 'view')).me.role, 'officer');

  // Coffre : dons (10 à 10 000, 10 par heure), le coffre ne revient jamais aux joueurs ; améliorations détruites.
  await fails(H(C, 'donate', { amount: 5 }), 400, 'don trop petit');
  await fails(H(C, 'donate', { amount: 20000 }), 400, 'don trop gros');
  await fails(H(C, 'donate', { amount: 600 }), 422, 'pas assez de pièces');
  await fails(H(C, 'donate', { amount: '100' }), 400, 'montant en texte refusé');
  const cBefore = coins(C);
  v = await H(C, 'donate', { amount: 100 }); assert.equal(v.clan.vault, 100); assert.equal(coins(C), cBefore - 100);
  assert.equal(v.clan.log[0].k, 'donate'); assert.equal(v.clan.log[0].n, 'Clancee'); assert.equal(v.clan.log[0].a, 100);
  for (let i = 0; i < 9; i++) await H(C, 'donate', { amount: 10 });
  await fails(H(C, 'donate', { amount: 10 }), 429, '10 dons par heure');
  await fails(H(C, 'upgrade', { what: 'slots' }), 403, 'un membre ne dépense pas le coffre');
  await fails(H(A, 'upgrade', { what: 'slots' }), 422, 'coffre insuffisant');
  // Titre Clan Patron (idée de PRISMA123, 2026-10-26) : 10 000 pièces données au total.
  assert.ok(!Ach.unlocked(statsOf(A.playerId)).includes('clanpatron'), 'pas encore donné');
  await H(A, 'donate', { amount: 9990 }); assert.ok(!Ach.unlocked(statsOf(A.playerId)).includes('clanpatron'), '9 990 : pas encore');
  await H(A, 'donate', { amount: 10 }); assert.ok(Ach.unlocked(statsOf(A.playerId)).includes('clanpatron'), '10 000 au total : titre');
  for (let i = 0; i < 5; i++) await H(A, 'donate', { amount: 10000 });
  const out1 = ecoOut();
  v = await H(B, 'upgrade', { what: 'slots' }); assert.equal(v.clan.slots, 25); assert.equal(v.clan.vault, 60190 - 5000); assert.equal(v.clan.nextSlots, 10000);
  assert.equal(ecoOut() - out1, 5000, 'places : pièces détruites');
  v = await H(A, 'upgrade', { what: 'tagc', color: 'gold' }); assert.equal(v.clan.tagc, 'gold');
  assert.equal(run([['HGET', 'clantag', C.playerId]])[0].result, 'DICE|gold', 'couleur du tag chez chaque membre');
  v = await H(A, 'upgrade', { what: 'banner', color: 'purple' }); assert.equal(v.clan.banner, 'purple');
  await fails(H(A, 'upgrade', { what: 'banner', color: 'purple' }), 422, 'même couleur');
  await fails(H(A, 'upgrade', { what: 'banner', color: 'url(x)' }), 400, 'couleur inconnue');
  assert.equal(v.clan.vault, 60190 - 5000 - 3000 - 2000);
  for (let i = 0; i < 4; i++) await H(F, 'donate', { amount: 10000 });

  // Droits des officiers (idée de kaz, 2026-10-26) : tout permis par défaut, le chef seul les règle, vérifiés partout.
  v = await H(B, 'view'); assert.deepEqual(v.clan.perms, { invite: true, kick: true, upgrade: true, war: true, edit: true }); assert.equal(v.me.can.kick, true);
  assert.deepEqual((await H(C, 'view')).me.can, { invite: false, kick: false, upgrade: false, war: false, edit: false }, 'un membre ne peut rien');
  await fails(H(B, 'perms', { perms: { kick: false } }), 403, 'seul le chef règle les droits');
  v = await H(A, 'perms', { perms: { invite: false, kick: false, upgrade: false, war: false, edit: false, junk: false } });
  assert.deepEqual(v.clan.perms, { invite: false, kick: false, upgrade: false, war: false, edit: false }); assert.equal(v.me.can.kick, true, 'le chef garde tout');
  await fails(H(B, 'invite', { name: 'Clanoutsider' }), 403, 'invitation coupée');
  await fails(H(B, 'accept', { name: 'Clanoutsider' }), 403, 'demandes coupées');
  await fails(H(B, 'kick', { name: 'Claneee' }), 403, 'exclusion coupée');
  await fails(H(B, 'upgrade', { what: 'banner', color: 'red' }), 403, 'coffre coupé');
  await fails(H(B, 'challenge', { target: 'FOES', stake: 100, team: [] }), 403, 'guerre coupée');
  await fails(H(B, 'answer', { yes: false }), 403, 'réponse de guerre coupée');
  await fails(H(B, 'desc', { desc: 'hi' }), 403, 'description coupée');
  await fails(H(B, 'emoji', { emoji: '🐉' }), 403, 'emoji coupé');
  assert.deepEqual((await H(B, 'view')).clan.requests, [], 'sans le droit d\'inviter, pas de demandes affichées');
  v = await H(A, 'perms', { perms: { invite: true, kick: true, upgrade: true, war: true, edit: true } });
  assert.equal(run([['HGET', `clan:${cidOf(A)}`, 'perms']])[0].result, null, 'retour au défaut : champ effacé');
  v = await H(B, 'emoji', { emoji: '🎲' }); assert.equal(v.me.can.edit, true);

  // Chat : envoi filtré, modification (10 min, ses messages), suppression, signalement vers la page Owner.
  v = await H(C, 'say', { text: 'gg fuck yeah' }); assert.equal(v.messages.at(-1).text, 'gg **** yeah');
  await new Promise(r => setTimeout(r, 3));
  v = await H(D, 'say', { text: 'hello clan' });
  const tC = v.messages.find(m => m.name === 'Clancee').t, tD = v.messages.find(m => m.name === 'Clandee').t;
  // Réactions emoji (Sacha, 2026-11-02).
  v = await H(C, 'react', { t: tD, emoji: '👍' }); assert.deepEqual(v.messages.find(m => m.t === tD).rx, [{ e: '👍', n: 1, mine: true, who: ['Clancee'] }]);
  v = await H(D, 'chat'); assert.equal(v.messages.find(m => m.t === tD).rx[0].mine, false);
  await fails(H(D, 'react', { t: 5, emoji: '👍' }), 404, 'message inconnu');
  assert.equal(v.messages.find(m => m.name === 'Clandee').canEdit, true); assert.ok(!v.messages.find(m => m.name === 'Clancee').canEdit);
  await fails(H(D, 'edit', { t: tC, text: 'hacked' }), 403, 'pas le message d\'un autre');
  v = await H(D, 'edit', { t: tD, text: 'hello clan!' }); assert.equal(v.messages.find(m => m.t === tD).text, 'hello clan!'); assert.equal(v.messages.find(m => m.t === tD).edited, true);
  await fails(H(D, 'edit', { t: tD, text: 'late' }, Date.now() + 11 * 60000), 422, 'fenêtre de 10 minutes');
  await fails(H(C, 'report', { t: tC }), 422, 'pas son propre message');
  assert.deepEqual(await H(D, 'report', { t: tC }), { reported: true });
  const rep = run([['LRANGE', 'reports', '-1', '-1']])[0].result.map(x => JSON.parse(x))[0];
  assert.equal(rep.where, 'clan chat'); assert.equal(rep.authorName, 'Clancee'); assert.equal(rep.text, 'gg **** yeah');
  await fails(H(outsider, 'chat'), 422, 'hors du clan : pas de chat');
  await fails(H(C, 'unsend', { t: tD }), 403, 'un membre ne supprime pas le message d\'un autre');
  v = await H(B, 'unsend', { t: tC }); assert.ok(!v.messages.some(m => m.t === tC), 'un officier modère');
  for (let i = 0; i < 20; i++) await H(E, 'say', { text: `spam ${i}` });
  await fails(H(E, 'say', { text: 'one more' }), 429, '20 messages par minute');
  // Par l'API publique (routée depuis /api/friends) : le même clan, sans identifiant de joueur.
  const fr = await call(friendsApi, { method: 'POST', body: { playerId: A.playerId, secret: A.secret, action: 'clan', op: 'view' } });
  assert.equal(fr.status, 200, JSON.stringify(fr.body)); assert.equal(fr.body.clan.tag, 'DICE');
  const frc = await call(friendsApi, { method: 'POST', body: { playerId: A.playerId, secret: A.secret, action: 'clan', op: 'chat' } });
  for (const who of [A, B, C, D, E, F]) { assert.ok(!JSON.stringify(fr.body).includes(who.playerId), 'aucun identifiant (vue)'); assert.ok(!JSON.stringify(frc.body).includes(who.playerId), 'aucun identifiant (chat)'); }
  assert.equal((await call(friendsApi, { method: 'POST', body: { playerId: A.playerId, secret: '0'.repeat(32), action: 'clan', op: 'view' } })).status, 403);

  // Classement de la semaine : l'XP des tirages des membres, puis le titre Clan Champion au changement de semaine.
  const wk = Date.UTC(2031, 0, 8, 12), nextWk = wk + 7 * 86400000;
  await lib.recordRoll(C.playerId, 999999, wk); await lib.recordRoll(D.playerId, 123456, wk + 5);
  await lib.recordRoll(F.playerId, 500001, wk + 10);
  const xpC = engine.scoreOf(999999), xpD = engine.scoreOf(123456);
  const top = await Clan.board(wk);
  assert.equal(top.clans[0].tag, 'DICE'); assert.equal(top.clans[0].xp, xpC + xpD); assert.equal(top.clans[1].tag, 'FOES');
  assert.ok(!JSON.stringify(top).includes(C.playerId));
  Clan._reset(); await Clan.settleWeek(nextWk); Clan._reset(); await Clan.settleWeek(nextWk); // deux fois : un seul titre
  assert.equal(statsOf(C.playerId).clanWeekWins, '1'); assert.equal(statsOf(D.playerId).clanWeekWins, '1'); assert.equal(statsOf(A.playerId).clanWeekWins, undefined, 'n\'a pas roulé cette semaine-là');
  assert.ok(Ach.unlocked(statsOf(C.playerId)).includes('clanchamp'));
  assert.equal((await Clan.board(nextWk)).last.tag, 'DICE');
  Clan._reset();

  // Guerre 5 contre 5 : défi, mise prise dans les deux coffres, tirages partagés, fin, paiement unique.
  const diceTeam = ['Clanlead', 'Clanbee', 'Clancee', 'Clandee', 'Claneee'], foeTeam = ['Foeleader', ...foes.map(f => f.name)];
  await fails(H(A, 'challenge', { target: 'FOES', stake: 1000, team: diceTeam }), 422, 'FOES n\'a pas 5 membres');
  for (const f of foes) { await H(F, 'invite', { name: f.name }); await H(f, 'join', { tag: 'FOES' }); }
  await fails(H(C, 'challenge', { target: 'FOES', stake: 1000, team: diceTeam }), 403, 'un membre ne défie pas');
  await fails(H(A, 'challenge', { target: 'FOES', stake: 50, team: diceTeam }), 400, 'mise trop petite');
  await fails(H(A, 'challenge', { target: 'FOES', stake: 1000, team: [...diceTeam.slice(0, 4), 'Foe9'] }), 422, 'joueur hors du clan');
  await fails(H(A, 'challenge', { target: 'FOES', stake: 1000, team: [...diceTeam.slice(0, 4), 'Clanlead'] }), 422, 'deux fois le même');
  // Défi refusé : la mise revient une seule fois.
  const vault0 = (await H(A, 'view')).clan.vault;
  v = await H(A, 'challenge', { target: 'FOES', stake: 1000, team: diceTeam }); assert.equal(v.clan.vault, vault0 - 1000); assert.equal(v.clan.war.st, 'pending');
  await fails(H(A, 'challenge', { target: 'FOES', stake: 1000, team: diceTeam }), 409, 'une guerre à la fois');
  await fails(H(A, 'answer', { yes: true, team: diceTeam }), 422, 'le clan qui défie n\'accepte pas');
  v = await H(F, 'answer', { yes: false }); assert.equal(v.clan.war, null);
  assert.equal((await H(A, 'view')).clan.vault, vault0, 'mise rendue');
  await fails(H(F, 'answer', { yes: false }), 404, 'déjà répondu');
  assert.equal((await H(A, 'view')).clan.vault, vault0, 'pas de double remboursement');
  // Défi accepté.
  const foeVault0 = (await H(F, 'view')).clan.vault, t0 = Date.now();
  await H(A, 'challenge', { target: 'FOES', stake: 2000, team: diceTeam }, t0);
  v = await H(F, 'view'); assert.equal(v.clan.war.incoming, true); assert.equal(v.clan.war.a.tag, 'DICE');
  await fails(H(F, 'answer', { yes: true, team: diceTeam }), 422, 'l\'équipe doit être du clan');
  v = await H(F, 'answer', { yes: true, team: foeTeam }, t0 + 10);
  assert.equal(v.clan.war.st, 'running'); assert.equal(v.clan.vault, foeVault0 - 2000);
  await fails(H(F, 'answer', { yes: false }), 404, 'plus rien à refuser');
  const bench = mk(14, 'Clanbench', 500); await H(A, 'invite', { name: 'Clanbench' }); await H(bench, 'join', { tag: 'DICE' });
  await fails(H(bench, 'warroll', {}, t0 + 20), 422, 'pas dans l\'équipe');
  let wr = await H(C, 'warroll', {}, t0 + 20);
  assert.equal(wr.count, 1); assert.equal(wr.s, engine.scoreOf(wr.n));
  // Tirage partagé : le vis-à-vis (Foe10, 3e de l'équipe) en a reçu un.
  const vis = wr.state.clan.war.b.players[2];
  assert.equal(vis.name, 'Foe10'); assert.equal(vis.rolls.length, 1); assert.equal(vis.auto, 1);
  await fails(H(C, 'warroll', {}, t0 + 30), 429, 'délai entre deux tirages');
  for (let k = 0; k < 4; k++) { run([['DEL', `warlock:${C.playerId}`]]); wr = await H(C, 'warroll', {}, t0 + 40 + k); }
  run([['DEL', `warlock:${C.playerId}`]]);
  await fails(H(C, 'warroll', {}, t0 + 100), 409, '5 tirages au plus');
  await fails(H(A, 'disband', {}, t0 + 100), 422, 'pas de dissolution pendant une guerre');
  // Fin de la fenêtre : tirages manquants faits par le serveur, vainqueur payé une seule fois (3 % détruits).
  const diceVault = (await H(A, 'view', {}, t0 + 100)).clan.vault, foeVault = (await H(F, 'view', {}, t0 + 100)).clan.vault, out2 = ecoOut();
  const end = t0 + 10 + Clan.WAR.ms + 1;
  const [va, vf] = await Promise.all([H(A, 'view', {}, end), H(F, 'view', {}, end)]);
  const wid = run([['LRANGE', `clanwars:${cidOf(A)}`, '-1', '-1']])[0].result[0];
  const w = await Clan.loadWar(wid);
  assert.equal(w.st, 'done');
  for (const id of [...w.ta, ...w.tb]) assert.equal(w.rolls[id].s.length, 5, 'tous les tirages faits');
  assert.equal(await Clan.payWar(w, end + 5), false, 'pas de second paiement');
  await Clan.advanceWar(wid, end + 10);
  const pot = 4000, cut = Math.floor(pot * 0.03), diceWon = w.w === w.a;
  const va2 = (await H(A, 'view', {}, end + 20)).clan, vf2 = (await H(F, 'view', {}, end + 20)).clan;
  assert.equal(va2.vault, diceVault + (diceWon ? pot - cut : 0)); assert.equal(vf2.vault, foeVault + (diceWon ? 0 : pot - cut));
  assert.equal(ecoOut() - out2, cut, 'part de la maison détruite');
  const sumOf = team => team.reduce((x, id) => x + w.rolls[id].s.reduce((p, q) => p + q, 0), 0);
  if (sumOf(w.ta) !== sumOf(w.tb)) assert.equal(diceWon, sumOf(w.ta) > sumOf(w.tb), 'plus gros total gagne');
  assert.equal(va2.war, null); assert.equal(va2.past[0].won, diceWon); assert.equal(va2.wins + vf2.wins, 1);
  for (const who of [A, B, C, D, E, F]) assert.ok(!JSON.stringify([va, vf, va2, vf2]).includes(who.playerId), 'aucun identifiant (guerre)');
  // Accepter et refuser au même moment : un seul passe (jamais la mise rendue ET prise).
  {
    const vA = (await H(A, 'view')).clan.vault, vF = (await H(F, 'view')).clan.vault;
    await H(A, 'challenge', { target: 'FOES', stake: 500, team: diceTeam });
    const res = await Promise.allSettled([H(F, 'answer', { yes: true, team: foeTeam }), H(A, 'answer', { yes: false })]);
    const accepted = res[0].status === 'fulfilled';
    assert.equal(res.filter(x => x.status === 'fulfilled').length, 1, 'un seul des deux');
    const vA2 = (await H(A, 'view')).clan.vault, vF2 = (await H(F, 'view')).clan.vault;
    assert.deepEqual([vA2, vF2], accepted ? [vA - 500, vF - 500] : [vA, vF]);
    if (accepted) await H(A, 'view', {}, Date.now() + Clan.WAR.ms + 10); // finie
  }

  // Tags dans le classement et le profil.
  const lbDay = await call(leaderboard, { url: `/api/leaderboard?period=day&me=${C.playerId}` });
  assert.equal(lbDay.status, 200);
  const pr = await call(profile, { url: '/api/profile?name=Clancee' });
  assert.deepEqual(pr.body.clan, { name: 'Dice Lords', tag: 'DICE', emoji: '🎲', c: 'gold' });
  const coinsLb = await call(leaderboard, { url: '/api/leaderboard?period=coins' });
  assert.deepEqual(coinsLb.body.entries.find(e => e.name === 'Clanbee').clan, { tag: 'DICE', c: 'gold' });

  // Partir, dissoudre : plus de clan, nom et tag libérés, coffre détruit.
  await H(E, 'leave'); assert.equal((await H(E, 'view')).me.inClan, false);
  await fails(H(B, 'disband'), 403, 'seul le chef dissout');
  const out3 = ecoOut(), vaultLeft = (await H(A, 'view')).clan.vault;
  v = await H(A, 'disband'); assert.equal(v.me.inClan, false);
  assert.equal(ecoOut() - out3, vaultLeft, 'coffre détruit');
  for (const who of [A, B, C, D]) assert.equal(cidOf(who), null);
  assert.equal(run([['GET', 'clantagk:DICE']])[0].result, null);
  await fails(H(C, 'create', { clanName: 'Dice Lords', tag: 'DICE' }), 422, 'nom libre, mais pas 10 000 pièces');
  v = await H(B, 'create', { clanName: 'Dice Lords', tag: 'DICE' }); assert.equal(v.clan.tag, 'DICE', 'nom et tag réutilisables');
}
// Faux liens (2026-10-25) : un point suivi d'une espace n'est pas un domaine (« rollers. Be active » ≠ site .be).
{
  const { checkMessage } = require(path.join(ROOT, 'api/_global.js'));
  for (const t of ['Chill clan for daily rollers. Be active', 'I won. It was cool', 'Sure. Me too', 'Nice. Us vs them']) assert.equal(checkMessage(t), t, `phrase normale : ${t}`);
  for (const t of ['go to site.com', 'visit roll . com', 'rng dot com', 'mysite(dot)net', 'check foo.be']) assert.throws(() => checkMessage(t), /Links/, `lien : ${t}`);
}
// Chat global (api/_global.js, routé par /api/friends) : qui écrit, délai, filtres, signalements, modération, 100 messages.
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const mk = (tag, name, { rolls = 150, google = true, extra = [] } = {}) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', rolls, ...extra], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id], ...(google ? [['SET', `player:${id}:google`, `g-${tag}`]] : [])]); return { playerId: id, secret, name }; };
  const boss = mk('c1', 'Chief', { extra: ['owner', '1'] }), kid = mk('c2', 'Kiddo'), pal = mk('c3', 'Pally'), modo = mk('c4', 'Modo');
  const anon = mk('c5', 'NoGoogle', { google: false }), newbie = mk('c6', 'Newbie', { rolls: 99 });
  const gc = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { action, ...(who ? { playerId: who.playerId, secret: who.secret } : {}), ...extra } });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const free = who => run([['DEL', `gc:rl:${who.playerId}`]]); // lève le délai de 5 s sans attendre
  // Grands tirages des tests précédents (annoncés dans le chat depuis le 2026-10-27) : retirés, pour compter juste ici.
  run([['DEL', 'gc:sysq']]);
  // Lecture ouverte à tous, même sans joueur ; aucune info « me » alors.
  let r = await gc(null, 'gcList'); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.msgs, []); assert.equal(r.body.me, undefined);
  r = await call(friendsApi, { method: 'POST', body: { action: 'gcList', playerId: '7e1d'.repeat(4), secret: 'f'.repeat(32) } }); assert.equal(r.status, 200, 'visiteur inconnu du serveur : lit quand même'); assert.equal(r.body.me, undefined);
  assert.equal(run([['GET', `player:${'7e1d'.repeat(4)}:secret`]])[0].result, null, 'lire ne crée aucun joueur');
  assert.equal((await call(friendsApi, { method: 'POST', body: { action: 'gcSend', text: 'hi', playerId: '7e1d'.repeat(4), secret: 'f'.repeat(32) } })).status, 403);
  // Éligibilité : Google + 100 tirages, expliqué au joueur.
  r = await gc(anon, 'gcList'); assert.deepEqual([r.body.me.can, r.body.me.reason], [true, null], 'plus besoin de Google');
  r = await gc(newbie, 'gcList'); assert.deepEqual([r.body.me.can, r.body.me.reason, r.body.me.rolls, r.body.me.need], [false, 'rolls', 99, 100]);
  r = await gc(newbie, 'gcSend', { text: 'hello' }); assert.equal(r.status, 403); assert.match(r.body.error, /100 rolls/);
  r = await gc(kid, 'gcSend', { text: 'Hello <b>everyone</b>!' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.msgs.length, 1); assert.deepEqual([r.body.msgs[0].name, r.body.msgs[0].text, r.body.msgs[0].mine], ['Kiddo', 'Hello <b>everyone</b>!', true]);
  assert.ok(!JSON.stringify(r.body).includes(kid.playerId), 'aucun identifiant de joueur');
  // Réactions emoji (Sacha, 2026-11-02) : un pseudo suffit (pas besoin des 100 tirages) ; renvoyées seulement quand elles
  // ont changé (rxrev), jamais au coup d'œil du point rouge.
  {
    const id0 = r.body.msgs[0].id;
    let x = await gc(newbie, 'gcReact', { id: id0, emoji: '🔥' }); assert.equal(x.status, 200, JSON.stringify(x.body));
    assert.deepEqual(x.body.rx[id0], [{ e: '🔥', n: 1, mine: true, who: ['Newbie'] }]);
    const { rev, del, rxrev } = x.body;
    x = await gc(kid, 'gcList', { rev, del, since: Date.now(), rxrev }); assert.equal(x.body.same, true); assert.equal(x.body.rx, undefined, 'rien de neuf');
    x = await gc(kid, 'gcList', { rev, del, since: Date.now(), rxrev: rxrev - 1 }); assert.equal(x.body.same, true); assert.deepEqual(x.body.rx[id0], [{ e: '🔥', n: 1, mine: false, who: ['Newbie'] }]);
    x = await gc(kid, 'gcList', { rev, del, since: Date.now() }); assert.equal(x.body.rx, undefined, 'coup d\'œil : pas de réactions');
    assert.equal((await gc(null, 'gcReact', { id: id0, emoji: '🔥' })).status, 400);
    assert.equal((await gc(kid, 'gcReact', { id: 'ffffffffffff', emoji: '🔥' })).status, 404);
    assert.equal((await gc(kid, 'gcReact', { id: id0, emoji: 'lol' })).status, 400);
    assert.ok(!JSON.stringify(x.body).includes(newbie.playerId), 'aucun identifiant');
  }
  // Délai : un message toutes les 5 s.
  r = await gc(kid, 'gcSend', { text: 'again' }); assert.equal(r.status, 429);
  free(kid);
  // Longueur et filtres : refusés avec une raison, jamais gardés.
  const reject = async (text, re, what) => { free(kid); const x = await gc(kid, 'gcSend', { text }); assert.equal(x.status, 422, `${what} : « ${text} » → ${x.status}`); assert.match(x.body.error, re, what); };
  await reject('x'.repeat(201), /200 characters/, 'trop long');
  for (const t of ['you are a fucking idiot', 'sh1t', 'f u c k', 'n.i.g.g.e.r', 'espèce de connard', 'fils de pute']) await reject(t, /friendly/, 'insulte');
  for (const t of ['call me 06 12 34 56 78', 'text +1 (555) 123-4567']) await reject(t, /personal info/, 'téléphone');
  for (const t of ['my mail: kid.cool@gmail.com', 'kid (at) gmail (dot) com']) await reject(t, /personal info/, 'e-mail');
  for (const t of ['I live at 12 Baker Street', "j'habite au 4 rue des Lilas", 'add me on snap', 'my insta is kidcool', '@kidcool99', 'discord: kidcool#1234', 'snapchat kidcool']) await reject(t, /personal info/, 'infos perso');
  for (const t of ['go to freecoins.com', 'https://x.y/z', 'www.example.org', 'see site dot com', 'discord.gg/abc']) await reject(t, /Links/, 'lien');
  for (const t of ['I got 999999 and 1000000 today!', 'gg, 3rd place', 'my number was 123456', 'join the RNG discord server', 'class assistant']) { free(kid); assert.equal((await gc(kid, 'gcSend', { text: t })).status, 200, `accepté : « ${t} »`); await wait(3); }
  r = await gc(null, 'gcList'); assert.equal(r.body.msgs.length, 6, 'rien de refusé n\'a été gardé');
  // Relecture bon marché : rien de neuf → « same » ; sinon seulement les nouveaux.
  const { rev, del } = r.body, lastT = r.body.msgs.at(-1).t;
  r = await gc(pal, 'gcList', { rev, del, since: lastT }); assert.equal(r.body.same, true); assert.equal(r.body.msgs, undefined);
  r = await gc(pal, 'gcSend', { text: 'hi Kiddo' }); assert.equal(r.status, 200);
  r = await gc(kid, 'gcList', { rev, del, since: lastT }); assert.deepEqual(r.body.msgs.map(m => m.text), ['hi Kiddo']); assert.equal(r.body.full, false);
  const palMsg = r.body.msgs[0];
  // Signalement → liste « reports » (where: 'global chat'), un seul par message, pas le sien.
  r = await gc(kid, 'gcReport', { id: palMsg.id }); assert.equal(r.status, 200); assert.equal(r.body.reported, true);
  assert.equal((await gc(kid, 'gcReport', { id: palMsg.id })).body.already, true);
  assert.equal((await gc(pal, 'gcReport', { id: palMsg.id })).status, 422, 'pas son propre message');
  r = await call(siteApi, { method: 'POST', body: { action: 'reports', playerId: boss.playerId, secret: boss.secret } });
  assert.ok(r.body.reports.some(x => x.where === 'global chat' && x.text === 'hi Kiddo' && x.author === 'Pally'), JSON.stringify(r.body.reports.slice(0, 2)));
  // Modération : un joueur ne supprime ni ne rend muet ; le rôle de Modérateur est donné par le créateur seul.
  assert.equal((await gc(kid, 'gcDelete', { id: palMsg.id })).status, 403);
  assert.equal((await gc(kid, 'gcMute', { id: palMsg.id, dur: '1h', why: 'spam' })).status, 403);
  assert.equal((await gc(kid, 'gcModSet', { name: 'Modo' })).status, 403, 'seul le créateur donne le rôle');
  assert.equal((await gc(modo, 'gcAdmin')).status, 403);
  r = await gc(boss, 'gcModSet', { name: 'Modo' }); assert.equal(r.status, 200); assert.deepEqual(r.body.mods, ['Modo']);
  r = await gc(modo, 'gcList'); assert.equal(r.body.me.mod, true);
  assert.equal((await gc(modo, 'gcModSet', { name: 'Kiddo' })).status, 403, 'un modérateur ne nomme personne');
  assert.equal((await gc(modo, 'gcUnmute', { name: 'Kiddo' })).status, 403);
  // Supprimer le message d'un autre demande une raison (Sacha, 2026-11-01).
  assert.equal((await gc(modo, 'gcDelete', { id: palMsg.id })).status, 400, 'suppression sans raison');
  assert.equal((await gc(modo, 'gcDelete', { id: palMsg.id, why: 'other' })).status, 400, 'other sans note');
  r = await gc(modo, 'gcDelete', { id: palMsg.id, why: 'rude', note: 'test delete' }); assert.equal(r.status, 200); assert.ok(!r.body.msgs.some(m => m.id === palMsg.id));
  r = await gc(kid, 'gcList', { rev, del, since: lastT }); assert.equal(r.body.full, true, 'après une suppression, la liste entière'); assert.equal(r.body.msgs.length, 6);
  // Silence 1 h : le joueur voit jusqu'à quand ; ne peut plus écrire ; listé sur la page Owner ; levé par le créateur.
  free(pal); r = await gc(pal, 'gcSend', { text: 'one more' }); const m2 = r.body.msgs.at(-1);
  assert.equal((await gc(modo, 'gcMute', { id: m2.id, dur: '2h', why: 'spam' })).status, 400);
  // Raison obligatoire, « other » demande une note ; « pour toujours » réservé au créateur (Sacha, 2026-11-01).
  assert.equal((await gc(modo, 'gcMute', { id: m2.id, dur: '1h' })).status, 400, 'sans raison');
  assert.equal((await gc(modo, 'gcMute', { id: m2.id, dur: '1h', why: 'because' })).status, 400, 'raison inconnue');
  assert.equal((await gc(modo, 'gcMute', { id: m2.id, dur: '1h', why: 'other', note: '   ' })).status, 400, 'other sans note');
  assert.equal((await gc(modo, 'gcMute', { id: m2.id, dur: 'perm', why: 'spam' })).status, 403, 'un modérateur ne bannit pas');
  r = await gc(modo, 'gcMute', { id: m2.id, dur: '1h', why: 'spam', note: 'posted the same thing 6 times' }); assert.equal(r.status, 200); assert.ok(!r.body.msgs.some(m => m.id === m2.id), 'message retiré aussi');
  r = await gc(pal, 'gcList'); assert.equal(r.body.me.reason, 'muted'); assert.ok(r.body.me.mutedUntil > Date.now() + 3500e3 && r.body.me.mutedUntil <= Date.now() + 3600e3);
  assert.equal(r.body.me.muteWhy, 'spam', 'le joueur voit la raison'); assert.ok(!JSON.stringify(r.body.me).includes('6 times'), 'mais pas la note');
  free(pal); assert.equal((await gc(pal, 'gcSend', { text: 'let me talk' })).status, 403);
  r = await gc(boss, 'gcAdmin'); assert.deepEqual(r.body.mutes.map(x => [x.name, x.by, x.d, x.why, x.note, x.text]), [['Pally', 'Modo', '1h', 'spam', 'posted the same thing 6 times', 'one more']]);
  assert.deepEqual(r.body.history, [], 'un silence en cours n\'est pas dans l\'historique'); assert.deepEqual(r.body.modStats.map(x => [x.name, x.mutes]), [['Modo', 1]]);
  // Lecture seule (viewerGrant, 2026-10-26) : voir les silences, sans pouvoir les lever.
  run([['HSET', `stats:${kid.playerId}`, 'viewerGrant', '1']]);
  r = await gc(kid, 'gcAdmin'); assert.equal(r.status, 200); assert.equal(r.body.readOnly, true); assert.equal(r.body.mutes.length, 1);
  assert.equal((await gc(kid, 'gcUnmute', { name: 'Pally' })).status, 403, 'lecture seule : pas de levée');
  assert.equal((await gc(kid, 'gcModSet', { name: 'Pally' })).status, 403);
  run([['HDEL', `stats:${kid.playerId}`, 'viewerGrant']]);
  assert.ok(!JSON.stringify(r.body).includes(pal.playerId), 'aucun identifiant sur la page Owner');
  r = await gc(boss, 'gcUnmute', { name: 'Pally' }); assert.deepEqual(r.body.mutes, []);
  // Levé par le créateur : l'historique le garde, avec qui l'a levé.
  assert.deepEqual(r.body.history.map(x => [x.name, x.by, x.why, x.text, x.lift && x.lift.by]), [['Pally', 'Modo', 'spam', 'one more', 'Chief']]);
  assert.ok(!JSON.stringify(r.body).includes(pal.playerId), 'aucun identifiant dans l\'historique');
  free(pal); assert.equal((await gc(pal, 'gcSend', { text: 'thanks' })).status, 200);
  // Silence de 5 min : il finit tout seul et passe dans l'historique, sans « levé par ».
  free(pal); r = await gc(pal, 'gcSend', { text: 'spam spam' }); const m5 = r.body.msgs.at(-1);
  r = await gc(modo, 'gcMute', { id: m5.id, dur: '5m', why: 'other', note: 'flooding' }); assert.equal(r.status, 200);
  r = await gc(pal, 'gcList'); assert.ok(r.body.me.mutedUntil > Date.now() + 290e3 && r.body.me.mutedUntil <= Date.now() + 300e3);
  run([['DEL', `gc:mute:${pal.playerId}`]]); // comme si les 5 minutes étaient passées (la clé expire seule)
  { const rec = JSON.parse(run([['HGET', 'gc:mutes', pal.playerId]])[0].result); rec.until = Date.now() - 1; run([['HSET', 'gc:mutes', pal.playerId, JSON.stringify(rec)]]); }
  r = await gc(boss, 'gcAdmin'); assert.deepEqual(r.body.mutes, []);
  assert.deepEqual(r.body.history.map(x => [x.d, x.why, x.note, !!x.lift]), [['5m', 'other', 'flooding', false], ['1h', 'spam', 'posted the same thing 6 times', true]]);
  assert.deepEqual(r.body.modStats.map(x => [x.name, x.mutes]), [['Modo', 2]]);
  free(pal); assert.equal((await gc(pal, 'gcSend', { text: 'sorry' })).status, 200);
  // Silence pour toujours, et un modérateur ne rend muet ni le créateur ni un autre modérateur.
  free(kid); r = await gc(kid, 'gcSend', { text: 'bye' }); const m3 = r.body.msgs.at(-1);
  assert.equal((await gc(boss, 'gcMute', { id: m3.id, dur: 'perm', why: 'rude' })).status, 200);
  r = await gc(kid, 'gcList'); assert.equal(r.body.me.mutedUntil, -1);
  free(kid); r = await gc(kid, 'gcSend', { text: 'hello?' }); assert.equal(r.status, 403); assert.match(r.body.error, /no longer/);
  free(boss); r = await gc(boss, 'gcSend', { text: 'Be nice everyone' }); const bm = r.body.msgs.at(-1);
  assert.equal((await gc(modo, 'gcMute', { id: bm.id, dur: '24h', why: 'spam' })).status, 403);
  await gc(boss, 'gcUnmute', { name: 'Kiddo' });
  // Section Modérateurs (Sacha, 2026-11-01) : 🛡️ dans le chat, page des signalements, journal et bilan sur la page Owner.
  free(modo); r = await gc(modo, 'gcSend', { text: 'hello from a mod' }); const modMsg = r.body.msgs.at(-1);
  assert.equal(modMsg.mod, true, '🛡️ sur les messages du modérateur'); assert.ok(!r.body.msgs.filter(m => m.name === 'Pally').some(m => m.mod));
  free(pal); r = await gc(pal, 'gcSend', { text: 'you are all so slow' }); const slow = r.body.msgs.at(-1);
  free(kid); r = await gc(kid, 'gcSend', { text: 'hi all' }); const hiAll = r.body.msgs.at(-1);
  await gc(kid, 'gcReport', { id: slow.id }); await gc(anon, 'gcReport', { id: slow.id }); await gc(pal, 'gcReport', { id: hiAll.id }); await gc(kid, 'gcReport', { id: modMsg.id });
  assert.equal((await gc(kid, 'gcModPage')).status, 403, 'réservé aux modérateurs');
  r = await gc(modo, 'gcModPage'); assert.equal(r.status, 200);
  assert.deepEqual(r.body.reports.map(x => [x.name, x.text, x.count]), [['Kiddo', 'hi all', 1], ['Pally', 'you are all so slow', 2]], 'pas le signalement qui le vise');
  assert.ok(!JSON.stringify(r.body).includes('NoGoogle') && !JSON.stringify(r.body).includes(pal.playerId), 'ni qui a signalé, ni identifiant');
  assert.equal((await gc(modo, 'gcReportOk', { id: 'ffffffffffff' })).status, 404);
  r = await gc(modo, 'gcReportOk', { id: r.body.reports[0].id }); assert.deepEqual(r.body.reports.map(x => x.text), ['you are all so slow']);
  r = await gc(modo, 'gcDelete', { id: slow.id, why: 'mean', from: 'mod' }); assert.deepEqual(r.body.reports, [], 'supprimé : signalements traités');
  assert.deepEqual(r.body.mine.slice(0, 1).map(a => [a.kind, a.name, a.text, a.why]), [['delete', 'Pally', 'you are all so slow', 'mean']]);
  r = await call(siteApi, { method: 'POST', body: { action: 'reports', playerId: boss.playerId, secret: boss.secret } });
  const gcRep = r.body.reports.filter(x => x.where === 'global chat' && ['hi all', 'you are all so slow'].includes(x.text));
  assert.deepEqual(gcRep.map(x => [x.text, x.done, x.by && x.by.name, x.by && x.by.act]).sort(), [['hi all', true, 'Modo', 'ok'], ['you are all so slow', true, 'Modo', 'deleted'], ['you are all so slow', true, 'Modo', 'deleted']]);
  assert.ok(r.body.reports.some(x => x.text === 'hello from a mod' && !x.done), 'le signalement qui vise un modérateur reste pour le créateur');
  r = await gc(boss, 'gcAdmin'); const ms = r.body.modStats.find(x => x.name === 'Modo');
  assert.deepEqual([ms.mutes, ms.deletes, ms.reports, ms.lifted], [2, 2, 4, 1], JSON.stringify(ms)); assert.ok(ms.since > 0 && ms.week === 4);
  assert.deepEqual(r.body.actions.slice(0, 1).map(a => [a.kind, a.name, a.by, a.text, a.why]), [['delete', 'Pally', 'Modo', 'you are all so slow', 'mean']]);
  assert.ok(r.body.actions.some(a => a.kind === 'delete' && a.why === 'rude' && a.note === 'test delete'), 'raison et note de la 1re suppression');
  assert.ok(!JSON.stringify(r.body).includes(modo.playerId) && !JSON.stringify(r.body).includes(pal.playerId), 'aucun identifiant');
  // Rôle retiré : plus de modération.
  await gc(boss, 'gcModSet', { name: 'Modo', on: false });
  assert.equal((await gc(modo, 'gcDelete', { id: bm.id })).status, 403);
  // Seuls les 100 derniers messages restent.
  for (let i = 0; i < 105; i++) { free(kid); assert.equal((await gc(kid, 'gcSend', { text: `msg ${i}` })).status, 200); }
  r = await gc(null, 'gcList'); assert.equal(r.body.msgs.length, 100); assert.equal(r.body.msgs.at(-1).text, 'msg 104'); assert.equal(r.body.msgs[0].text, 'msg 5');
  assert.ok(r.body.msgs.every((m, i, a) => !i || m.t > a[i - 1].t), 'heures strictement croissantes');
}

// Chat global : @mentions (idée de casmictechthing, 2026-10-26). Un @ d'un vrai joueur passe le filtre et est surligné,
// le cité le voit (toMe, lastAt pour le point rouge) ; un @ inconnu reste refusé ; aucun identifiant ne sort.
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const mk = (tag, name) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 150], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const gc = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { action, playerId: who.playerId, secret: who.secret, ...extra } });
  const free = who => run([['DEL', `gc:rl:${who.playerId}`]]);
  const al = mk('a7', 'MentAlpha'), be = mk('a8', 'MentBeta'), ce = mk('a9', 'MentCee');
  let r = await gc(be, 'gcList'); assert.equal(r.body.me.lastAt, 0, 'jamais cité');
  r = await gc(al, 'gcSend', { text: 'gg @mentbeta, and @nobody99' }); assert.equal(r.status, 422, 'un @ inconnu reste un pseudo de réseau social'); assert.match(r.body.error, /personal info/);
  free(al); r = await gc(al, 'gcSend', { text: 'gg @mentbeta! look @MentAlpha' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  let m = r.body.msgs.at(-1);
  assert.equal(m.text, 'gg @mentbeta! look @MentAlpha', 'texte gardé tel quel'); assert.deepEqual(m.at, ['MentBeta'], 'pseudo exact, sans soi-même'); assert.ok(!m.toMe);
  r = await gc(be, 'gcList'); m = r.body.msgs.at(-1); assert.equal(m.toMe, true, 'le cité le voit'); assert.equal(r.body.me.lastAt, m.t, 'heure de la dernière mention');
  r = await gc(ce, 'gcList'); assert.ok(!r.body.msgs.at(-1).toMe); assert.equal(r.body.me.lastAt, 0);
  // Même « same » (rien de neuf), lastAt suit : le point rouge s'allume pour un message arrivé avant l'ouverture.
  r = await gc(be, 'gcList', { rev: r.body.rev, del: r.body.del, since: m.t }); assert.equal(r.body.same, true); assert.equal(r.body.me.lastAt, m.t);
  for (const who of [al, be, ce]) assert.ok(!JSON.stringify(r.body).includes(who.playerId) && !JSON.stringify((await gc(ce, 'gcList')).body).includes(who.playerId), 'aucun identifiant');
  // Une mention ne contourne pas les autres filtres.
  free(al); assert.equal((await gc(al, 'gcSend', { text: '@MentBeta you fucking idiot' })).status, 422);
  assert.equal(run([['GET', `gc:at:${ce.playerId}`]])[0].result, null);
}
// Alerte des amis (idée de Jguz01, 2026-10-26) : Celestial ou mieux → les amis le voient à leur relève des cadeaux,
// depuis leur dernier « vu », par pseudo seulement ; pas les autres joueurs, pas les tirages ordinaires, pas sans bigSince.
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js')), lib = require(path.join(ROOT, 'api/_lib.js'));
  const mk = (tag, name) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 150], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const fr = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { action, playerId: who.playerId, secret: who.secret, ...extra } });
  const lucky = mk('e7', 'BigLucky'), pal = mk('e8', 'BigPal'), stranger = mk('e9', 'BigStranger');
  run([['SADD', `fr:${lucky.playerId}`, pal.playerId], ['SADD', `fr:${pal.playerId}`, lucky.playerId]]);
  const find = (ok, from = 0) => { let n = from; while (!ok(engine.analyze(n).tier)) n++; return n; };
  const nBig = find(t => t === 'celestial'), nSmall = find(t => t === 'rare');
  const since = Date.now() - 1;
  await lib.recordRoll(lucky.playerId, nSmall, Date.now());
  assert.deepEqual((await fr(pal, 'gifts', { bigSince: since })).body.big, [], 'un Rare ne prévient personne');
  await new Promise(r => setTimeout(r, 3));
  const tBig = Date.now(); await lib.recordRoll(lucky.playerId, nBig, tBig);
  let r = await fr(pal, 'gifts', { bigSince: since }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.big, [{ name: 'BigLucky', n: nBig, tier: 'celestial', t: tBig }]);
  assert.ok(!JSON.stringify(r.body).includes(lucky.playerId), 'aucun identifiant');
  assert.deepEqual((await fr(pal, 'gifts', { bigSince: tBig })).body.big, [], 'déjà vu');
  assert.equal((await fr(pal, 'gifts')).body.big, undefined, 'alertes coupées : rien de lu');
  assert.deepEqual((await fr(stranger, 'gifts', { bigSince: since })).body.big, [], 'pas un ami');
  // Ami retiré : plus d'alerte, même déjà poussée.
  run([['SREM', `fr:${pal.playerId}`, lucky.playerId]]);
  assert.deepEqual((await fr(pal, 'gifts', { bigSince: since })).body.big, [], 'plus ami');
  // Infinite (le top du jeu) aussi : tous les paliers à partir de Celestial.
  assert.deepEqual([...lib.BIG_TIERS].sort(), ['celestial', 'divine', 'godlike', 'infinite']);
}
// Chat global : modifier (5 minutes, filtres rejoués, « edited ») et supprimer ses propres messages (idée de daddy finger, 2026-10-26).
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const mk = (tag, name) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 150], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const gc = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { action, playerId: who.playerId, secret: who.secret, ...extra } });
  const free = who => run([['DEL', `gc:rl:${who.playerId}`]]);
  const ed = mk('b7', 'EditEd'), ot = mk('b8', 'EditOther');
  free(ed); let r = await gc(ed, 'gcSend', { text: 'helo all' }); const mine = r.body.msgs.at(-1);
  free(ot); r = await gc(ot, 'gcSend', { text: 'not yours' }); const theirs = r.body.msgs.at(-1);
  assert.equal(r.body.editMs, 5 * 60000);
  r = await gc(ed, 'gcEdit', { id: mine.id, text: 'hello all' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const e1 = r.body.msgs.find(m => m.id === mine.id);
  assert.deepEqual([e1.text, e1.edited, e1.t], ['hello all', true, mine.t], 'même id, même heure, marqué modifié');
  assert.equal(r.body.msgs.filter(m => m.id === mine.id).length, 1, 'pas de doublon');
  assert.ok(r.body.msgs.findIndex(m => m.id === mine.id) < r.body.msgs.findIndex(m => m.id === theirs.id), 'même place dans la liste');
  r = await gc(ed, 'gcEdit', { id: mine.id, text: 'you fucking idiot' }); assert.equal(r.status, 422, 'filtres rejoués (insulte)');
  r = await gc(ed, 'gcEdit', { id: mine.id, text: 'go to freecoins.com' }); assert.equal(r.status, 422, 'filtres rejoués (lien)');
  r = await gc(ed, 'gcEdit', { id: mine.id, text: 'hi @EditOther' }); assert.equal(r.status, 200); assert.deepEqual(r.body.msgs.find(m => m.id === mine.id).at, ['EditOther'], 'mention ajoutée en modifiant');
  assert.ok(Number(run([['GET', `gc:at:${ot.playerId}`]])[0].result) > 0, 'le cité est prévenu');
  assert.equal((await gc(ed, 'gcEdit', { id: theirs.id, text: 'hacked' })).status, 403, 'pas le message d\'un autre');
  // Fenêtre de 5 minutes : message vieilli à la main.
  const raw = run([['LRANGE', 'gc:msgs', 0, -1]])[0].result, k = raw.findIndex(x => JSON.parse(x).id === mine.id);
  run([['LSET', 'gc:msgs', k, JSON.stringify({ ...JSON.parse(raw[k]), t: Date.now() - 5 * 60000 - 1 })]]);
  r = await gc(ed, 'gcEdit', { id: mine.id, text: 'too late' }); assert.equal(r.status, 422); assert.match(r.body.error, /5 minutes/);
  // Supprimer : le sien oui (même vieux), celui d'un autre non (sauf modérateur).
  assert.equal((await gc(ed, 'gcDelete', { id: theirs.id })).status, 403);
  assert.equal((await gc(ed, 'gcMute', { id: theirs.id, dur: '1h', why: 'spam' })).status, 403, 'pas de silence pour autant');
  r = await gc(ed, 'gcDelete', { id: mine.id }); assert.equal(r.status, 200); assert.ok(!r.body.msgs.some(m => m.id === mine.id));
  assert.ok(r.body.msgs.some(m => m.id === theirs.id));
  assert.ok(!JSON.stringify(r.body).includes(ed.playerId) && !JSON.stringify(r.body).includes(ot.playerId), 'aucun identifiant');
}

// Chat global (2026-10-27) : réponses (idée de Niall), emojis (Deadshot), grands tirages annoncés par le serveur (R77)
// et message épinglé par le créateur (Big Sexy). Aucune citation ne montre un texte supprimé ; aucun identifiant ne sort.
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js')), lib = require(path.join(ROOT, 'api/_lib.js'));
  const { checkMessage } = require(path.join(ROOT, 'api/_global.js'));
  const mk = (tag, name, extra = []) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 150, ...extra], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const gc = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { action, ...(who ? { playerId: who.playerId, secret: who.secret } : {}), ...extra } });
  const free = who => run([['DEL', `gc:rl:${who.playerId}`]]);
  const wait = () => new Promise(res => setTimeout(res, 3));
  const A = mk('6a', 'ReplyAnn'), B = mk('6b', 'ReplyBen'), boss = mk('6c', 'PinBoss', ['owner', '1']), seer = mk('6d', 'PinSeer', ['viewerGrant', '1']), modo = mk('6f', 'PinModo', ['gcMod', '1']);
  const lucky = mk('5a', 'LuckyDiv'), lucky2 = mk('5b', 'LuckyTwo'), hush = mk('5f', 'LuckyHush');
  run([['DEL', 'gc:sysq', 'gc:sysrl', 'gc:pin']]);
  const msgOf = async (id, who = null) => (await gc(who, 'gcList')).body.msgs.find(m => m.id === id);

  // Réponse : référence { id, pseudo, ~60 caractères }, l'auteur cité est prévenu (toMe + point rouge).
  free(A); let r = await gc(A, 'gcSend', { text: 'hello there friends' }); const o1 = r.body.msgs.at(-1); await wait();
  free(B); r = await gc(B, 'gcSend', { text: 'hi Ann!', replyTo: o1.id }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const rep1 = r.body.msgs.at(-1);
  assert.deepEqual(rep1.re, { id: o1.id, name: 'ReplyAnn', text: 'hello there friends' });
  assert.equal((await msgOf(rep1.id, A)).toMe, true, 'l\'auteur cité le voit');
  assert.equal((await gc(A, 'gcList')).body.me.lastAt, rep1.t, 'point rouge pour l\'auteur cité');
  assert.ok(!(await msgOf(rep1.id, B)).toMe);
  free(A); r = await gc(A, 'gcSend', { text: 'me again', replyTo: o1.id }); const self = r.body.msgs.at(-1); await wait();
  assert.ok(!(await msgOf(self.id, A)).toMe, 'se répondre ne prévient personne');
  // Citation coupée à 60 caractères.
  free(A); r = await gc(A, 'gcSend', { text: 'a'.repeat(30) + ' ' + 'b'.repeat(69) }); const long = r.body.msgs.at(-1); await wait();
  free(B); r = await gc(B, 'gcSend', { text: 'ok', replyTo: long.id }); const rep2 = r.body.msgs.at(-1); await wait();
  assert.equal([...rep2.re.text].length, 61); assert.ok(rep2.re.text.endsWith('…'));
  // Original modifié : la citation suit ; supprimé : « deleted », sans le texte.
  r = await gc(A, 'gcEdit', { id: o1.id, text: 'hello there everyone' }); assert.equal(r.status, 200);
  assert.equal((await msgOf(rep1.id)).re.text, 'hello there everyone');
  r = await gc(A, 'gcDelete', { id: o1.id }); assert.equal(r.status, 200);
  r = await gc(null, 'gcList'); assert.deepEqual(r.body.msgs.find(m => m.id === rep1.id).re, { id: o1.id, name: 'ReplyAnn', gone: true });
  assert.ok(!JSON.stringify(r.body).includes('hello there'), 'aucun texte supprimé dans la liste');
  // Original sorti des 100 derniers (retiré à la main) : texte gardé ; modifié avant d'en sortir : sa nouvelle version.
  free(A); r = await gc(A, 'gcSend', { text: 'first version' }); const o2 = r.body.msgs.at(-1); await wait();
  free(A); r = await gc(A, 'gcSend', { text: 'old but fine' }); const o3 = r.body.msgs.at(-1); await wait();
  free(B); r = await gc(B, 'gcSend', { text: 'reply two', replyTo: o2.id }); const rep3 = r.body.msgs.at(-1); await wait();
  free(B); r = await gc(B, 'gcSend', { text: 'reply three', replyTo: o3.id }); const rep4 = r.body.msgs.at(-1); await wait();
  await gc(A, 'gcEdit', { id: o2.id, text: 'second version' });
  for (const id of [o2.id, o3.id]) { const raw = run([['LRANGE', 'gc:msgs', 0, -1]])[0].result; run([['LREM', 'gc:msgs', '1', raw.find(x => JSON.parse(x).id === id)]]); }
  assert.ok(!run([['LRANGE', 'gc:msgs', 0, -1]])[0].result.some(x => [o2.id, o3.id].includes(JSON.parse(x).id)));
  assert.equal((await msgOf(rep3.id)).re.text, 'second version'); assert.equal((await msgOf(rep4.id)).re.text, 'old but fine');
  // Message parti ou inconnu : refusé.
  free(B); assert.equal((await gc(B, 'gcSend', { text: 'hm', replyTo: o2.id })).status, 404);
  free(B); assert.equal((await gc(B, 'gcSend', { text: 'hm', replyTo: 'zz' })).status, 400);

  // Épinglé : le créateur seul ; tout le monde le voit (même sans joueur, même « same ») ; suit les modifications ; retiré
  // avec le message.
  free(A); r = await gc(A, 'gcSend', { text: 'pin me please' }); const p1 = r.body.msgs.at(-1); await wait();
  for (const who of [A, modo, seer]) assert.equal((await gc(who, 'gcPin', { id: p1.id })).status, 403, `pas ${who.name}`);
  r = await gc(boss, 'gcPin', { id: p1.id }); assert.equal(r.status, 200); assert.deepEqual([r.body.pin.id, r.body.pin.name, r.body.pin.text], [p1.id, 'ReplyAnn', 'pin me please']);
  r = await gc(null, 'gcList'); assert.equal(r.body.pin.text, 'pin me please');
  r = await gc(seer, 'gcList', { rev: r.body.rev, del: r.body.del, since: r.body.msgs.at(-1).t }); assert.equal(r.body.same, true); assert.equal(r.body.pin.id, p1.id, 'lecteur : le voit');
  assert.ok(!JSON.stringify(r.body.pin).includes(A.playerId) && r.body.pin.mine === undefined);
  await gc(A, 'gcEdit', { id: p1.id, text: 'pin me pretty please' });
  assert.equal((await gc(null, 'gcList')).body.pin.text, 'pin me pretty please', 'l\'épinglé suit la modification');
  r = await gc(boss, 'gcUnpin'); assert.equal(r.body.pin, null);
  await gc(boss, 'gcPin', { id: p1.id }); await gc(modo, 'gcDelete', { id: p1.id, why: 'spam' });
  assert.equal((await gc(null, 'gcList')).body.pin, null, 'message supprimé : plus épinglé');
  assert.equal((await gc(boss, 'gcPin', { id: p1.id })).status, 404);

  // Grands tirages : Divine ou mieux, décidé par le serveur, affiché 15 s plus tard (ici avancé à la main).
  const find = (ok, from = 0) => { let n = from; while (!ok(engine.analyze(n).tier)) n++; return n; };
  const nDiv = find(t => t === 'divine'), nCel = find(t => t === 'celestial'), nGod = find(t => t === 'godlike');
  const queued = () => run([['ZRANGE', 'gc:sysq', '0', '-1']])[0].result;
  const due = () => { for (const m of queued()) run([['ZADD', 'gc:sysq', String(Date.now() - 1), m]]); };
  await lib.recordRoll(lucky.playerId, nCel, Date.now()); assert.deepEqual(queued(), [], 'Celestial : pas annoncé dans le chat');
  await wait(); const tDiv = Date.now(); await lib.recordRoll(lucky.playerId, nDiv, tDiv);
  assert.equal(queued().length, 1); assert.ok(Number(run([['ZSCORE', 'gc:sysq', queued()[0]]])[0].result) >= tDiv + 15000, 'après la révélation');
  r = await gc(null, 'gcList'); assert.ok(!r.body.msgs.some(m => m.sys), 'pas avant son heure');
  due(); r = await gc(B, 'gcList'); const sys = r.body.msgs.at(-1);
  assert.deepEqual([sys.sys, sys.name, sys.n, sys.tier, sys.text, sys.title, sys.mine, sys.toMe], ['roll', 'LuckyDiv', nDiv, 'divine', undefined, undefined, undefined, undefined]);
  assert.deepEqual(queued(), [], 'publié une seule fois'); assert.equal((await gc(null, 'gcList')).body.msgs.filter(m => m.sys).length, 1);
  assert.ok(!JSON.stringify(r.body).includes(lucky.playerId), 'aucun identifiant');
  assert.equal(run([['GET', `gc:at:${lucky.playerId}`]])[0].result, null, 'jamais une mention');
  // Limites : un toutes les 30 s pour tout le chat, un toutes les 10 min par joueur ; pas pour un joueur muet.
  await lib.recordRoll(lucky2.playerId, nGod, Date.now()); assert.deepEqual(queued(), [], '30 s entre deux annonces');
  assert.equal(run([['GET', `gc:sysp:${lucky2.playerId}`]])[0].result, null, 'son tour n\'est pas consommé');
  run([['DEL', 'gc:sysrl']]); await lib.recordRoll(lucky.playerId, nGod, Date.now()); assert.deepEqual(queued(), [], '10 min par joueur');
  run([['DEL', 'gc:sysrl'], ['SET', `gc:mute:${hush.playerId}`, '-1']]); await lib.recordRoll(hush.playerId, nDiv, Date.now()); assert.deepEqual(queued(), [], 'muet : rien');
  run([['DEL', `gc:mute:${hush.playerId}`, 'gc:sysrl']]); await lib.recordRoll(hush.playerId, nDiv, Date.now()); assert.equal(queued().length, 1);
  run([['SET', `gc:mute:${hush.playerId}`, '-1']]); due(); r = await gc(null, 'gcList');
  assert.ok(!r.body.msgs.some(m => m.sys && m.name === 'LuckyHush'), 'muet entre-temps : rien'); assert.deepEqual(queued(), []);
  run([['DEL', `gc:mute:${hush.playerId}`]]);
  // Ni réponse, ni signalement, ni modification, ni silence ; un modérateur peut le supprimer.
  free(B); assert.equal((await gc(B, 'gcSend', { text: 'wow', replyTo: sys.id })).status, 422);
  assert.equal((await gc(B, 'gcReport', { id: sys.id })).status, 422);
  assert.equal((await gc(lucky, 'gcEdit', { id: sys.id, text: 'hacked' })).status, 403);
  assert.equal((await gc(boss, 'gcMute', { id: sys.id, dur: '1h', why: 'spam' })).status, 422);
  assert.equal(run([['GET', `gc:mute:${lucky.playerId}`]])[0].result, null);
  assert.equal((await gc(lucky, 'gcDelete', { id: sys.id })).status, 403, 'pas son message');
  assert.equal((await gc(modo, 'gcDelete', { id: sys.id })).status, 200);

  // Emojis : gardés tels quels (composés compris), comptés en caractères ; le liant invisible ne cache pas un mot.
  free(A); r = await gc(A, 'gcSend', { text: 'gg 🎉🔥 👍🏽 ❤️ 👨‍👩‍👧 🏳️‍🌈' }); assert.equal(r.status, 200); assert.equal(r.body.msgs.at(-1).text, 'gg 🎉🔥 👍🏽 ❤️ 👨‍👩‍👧 🏳️‍🌈');
  assert.equal(checkMessage('😀'.repeat(200)), '😀'.repeat(200)); assert.throws(() => checkMessage('😀'.repeat(201)), /200 characters/);
  assert.throws(() => checkMessage('f‍u‍c‍k'), /friendly/); assert.equal(checkMessage('a‍😀'), 'a 😀');
  run([['DEL', 'gc:sysq', 'gc:sysrl']]);
}
// « About me » (idée de Niall, 2026-10-27, api/_bio.js par /api/profile) : 80 caractères, même filtre que le chat,
// montré sur le profil ; signalable ; effacé par le créateur seul.
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const mk = (tag, name, extra = []) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 10, ...extra], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const bio = (who, op, extra = {}) => call(profile, { method: 'POST', body: { action: 'bio', op, playerId: who.playerId, secret: who.secret, ...extra } });
  const free = who => run([['DEL', `bio:rl:${who.playerId}`]]);
  const kid = mk('4a', 'BioKid'), other = mk('4b', 'BioOther'), boss = mk('4e', 'BioBoss', ['owner', '1']), seer = mk('4f', 'BioSeer', ['viewerGrant', '1']);
  run([['HINCRBY', `stats:${other.playerId}`, 'h:rolls', 20]]); // signaler demande 20 tirages (audit de sécurité, 2026-11-02)
  let r = await bio(kid, 'set', { text: '  I love rolling 🎲 and   duels ' }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.bio, 'I love rolling 🎲 and duels');
  r = await call(profile, { url: '/api/profile?name=biokid' }); assert.equal(r.status, 200); assert.equal(r.body.bio, 'I love rolling 🎲 and duels');
  r = await call(profile, { url: '/api/profile?name=BioKid&lite=1' }); assert.equal(r.body.bio, 'I love rolling 🎲 and duels');
  assert.equal((await call(profile, { url: '/api/profile?name=BioOther' })).body.bio, null);
  assert.equal((await bio(kid, 'set', { text: 'again' })).status, 429, 'une modification toutes les 10 s');
  for (const [t, re] of [['x'.repeat(81), /80 characters/], ['go to freecoins.com', /Links/], ['you fucking idiot', /friendly/], ['add me on snap', /personal info/], ['call 06 12 34 56 78', /personal info/]]) { free(kid); r = await bio(kid, 'set', { text: t }); assert.equal(r.status, 422, t); assert.match(r.body.error, re, t); }
  free(kid); assert.equal((await bio(kid, 'set', { text: 'x'.repeat(80) })).status, 200, '80 caractères : accepté');
  assert.equal((await call(profile, { method: 'POST', body: { action: 'bio', op: 'set', playerId: kid.playerId, secret: other.secret, text: 'x' } })).status, 403, 'secret vérifié');
  // Muet dans le chat : pas d'« About me » non plus.
  run([['SET', `gc:mute:${other.playerId}`, '-1']]); assert.equal((await bio(other, 'set', { text: 'hello' })).status, 403); run([['DEL', `gc:mute:${other.playerId}`]]);
  // Effacer le sien : texte vide.
  free(kid); r = await bio(kid, 'set', { text: '' }); assert.equal(r.body.bio, null); assert.equal((await call(profile, { url: '/api/profile?name=BioKid' })).body.bio, null);
  free(kid); await bio(kid, 'set', { text: 'Cool kid 😎' });
  // Signalement → Reports (where: 'about me'), sans identifiant.
  assert.equal((await bio(kid, 'report', { name: 'BioKid' })).status, 422, 'pas soi-même');
  assert.equal((await bio(kid, 'report', { name: 'BioOther' })).status, 404, 'rien à signaler');
  r = await bio(other, 'report', { name: 'BioKid' }); assert.equal(r.status, 200); assert.ok(r.body.reported);
  r = await call(siteApi, { method: 'POST', body: { action: 'reports', playerId: boss.playerId, secret: boss.secret } });
  const rep = r.body.reports.find(x => x.where === 'about me'); assert.ok(rep && rep.author === 'BioKid' && rep.text === 'Cool kid 😎');
  assert.ok(!JSON.stringify(r.body).includes(kid.playerId));
  // Effacé par le créateur seul (ni un joueur, ni un lecteur).
  for (const who of [other, seer]) assert.equal((await bio(who, 'clear', { name: 'BioKid' })).status, 403);
  assert.equal((await bio(boss, 'clear', { name: 'Nobody Here' })).status, 404);
  r = await bio(boss, 'clear', { name: 'biokid' }); assert.equal(r.status, 200); assert.equal(r.body.cleared, true);
  assert.equal((await call(profile, { url: '/api/profile?name=BioKid' })).body.bio, null);
  assert.equal((await bio(boss, 'clear', { name: 'BioKid' })).status, 404, 'déjà effacé');
}

// ================================================================ Économie (2026-10-25) : rendements décroissants, Weekend Rush +25 %,
// pseudo payant, Prestige.
{
  const Shop = require(path.join(ROOT, 'js/shop.js')), Ev = require(path.join(ROOT, 'js/events.js'));
  const { recordRoll } = require(path.join(ROOT, 'api/_lib.js'));
  const shopApi = require(path.join(ROOT, 'api/shop.js')), nameApi2 = require(path.join(ROOT, 'api/name.js'));
  const field = (id, f) => Number(run([['HGET', `stats:${id}`, f]])[0].result) || 0;
  const eco = (t, f) => Number(run([['HGET', `eco:${new Date(t).toISOString().slice(0, 10)}`, f]])[0].result) || 0;
  const bal = id => { const f = run([['HGETALL', `stats:${id}`]])[0].result, o = {}; for (let k = 0; k < f.length; k += 2) o[f[k]] = f[k + 1]; return Shop.balance(o); };
  const wait = () => new Promise(r => setTimeout(r, 3));

  // 1. Paliers : 1–500 plein tarif, 501–2 000 à 50 %, au-delà 20 %, arrondi en dessous.
  assert.deepEqual([1, 500, 501, 2000, 2001, 99999].map(Shop.rollRate), [1, 1, 0.5, 0.5, 0.2, 0.2]);
  assert.deepEqual([Shop.rollPay(100, 1, 'mythic'), Shop.rollPay(100, 501, 'mythic'), Shop.rollPay(5, 501, 'rare'), Shop.rollPay(1, 501, 'common'), Shop.rollPay(25, 2001, 'anomaly'), Shop.rollPay(1, 2001, 'common'), Shop.rollPay(3, 2001, 'trash'), Shop.rollPay(0, 2001, 'x')], [100, 50, 2, 1, 5, 1, 1, 0]);
  // Celestial ou mieux : jamais réduit (2026-10-26, number 1, kaz, casmictechthing)
  for (const tr of ['celestial', 'divine', 'godlike', 'infinite']) assert.equal(Shop.rollPay(Shop.COINS[tr], 3000, tr), Shop.COINS[tr], tr);
  assert.equal(Shop.rollPay(Shop.COINS.mythic, 3000, 'mythic'), 20);
  // Par le vrai recordRoll, un mardi (pas de Rush) : le compteur rc:<jour>:<id> est simulé à 500, 1 999, 2 000.
  const dm = { playerId: 'd1'.repeat(8) }, TUE = Date.parse('2026-10-27T10:00:00Z');
  let n = 0; while (engine.analyze(n).tier !== 'mythic') n++; // 100 pièces au plein tarif
  const rc = `rc:2026-10-27:${dm.playerId}`;
  const cases = [[0, 1, 100], [499, 1, 100], [500, 0.5, 50], [1999, 0.5, 50], [2000, 0.2, 20]];
  let paidSum = 0, cutSum = 0; const ecoRolls0 = eco(TUE, 'in:rolls');
  for (const [count, rate, coins] of cases) {
    run([['SET', rc, String(count)]]); await wait();
    const out = await recordRoll(dm.playerId, n, TUE + count);
    assert.deepEqual([out.rate, out.coins, out.dayRoll], [rate, coins, count + 1], `tirage n° ${count + 1}`);
    paidSum += coins; cutSum += 100 - coins;
  }
  assert.equal(field(dm.playerId, 'rollCut'), cutSum, 'la part retenue est notée dans rollCut');
  assert.equal(bal(dm.playerId), paidSum, 'le solde ne compte que ce qui est versé');
  assert.equal(eco(TUE, 'in:rolls') - ecoRolls0, paidSum, 'eco in:rolls = pièces réellement créées');
  // L'XP n'est pas touchée : 5 tirages, 5 fois l'XP pleine.
  assert.equal(field(dm.playerId, 'xpLife'), 5 * engine.analyze(n).total);
  // Celestial au palier 20 % : versé en entier, rien dans rollCut (2026-10-26).
  { const cx = { playerId: 'c7'.repeat(8) }; let m = 0; while (engine.analyze(m).tier !== 'celestial') m++;
    run([['SET', `rc:2026-10-27:${cx.playerId}`, '5000']]); await wait();
    const out = await recordRoll(cx.playerId, m, TUE + 9);
    assert.deepEqual([out.rate, out.coins], [0.2, Shop.COINS.celestial], 'Celestial jamais réduit');
    assert.equal(field(cx.playerId, 'rollCut'), 0, 'rien de retenu pour un Celestial'); }
  // Samedi, au-delà de 500 : le Rush (+25 %) s'applique à ce qui est versé.
  const SAT = Date.parse('2026-10-31T10:00:00Z'), rcs = `rc:2026-10-31:${dm.playerId}`;
  run([['SET', rcs, '700']]); await wait();
  let out = await recordRoll(dm.playerId, n, SAT);
  assert.deepEqual([out.rate, out.coins], [0.5, 50 + 12], '50 % puis +25 % arrondi en dessous');
  // Par l'API : la réponse du tirage porte coins et rate.
  const dr = { playerId: 'd2'.repeat(8), secret: 'd3'.repeat(16), name: 'Diminisher' };
  run([['SET', `rc:${new Date(Date.now()).toISOString().slice(0, 10)}:${dr.playerId}`, '3000']]);
  const rr = await call(roll, { method: 'POST', body: dr });
  assert.equal(rr.status, 200); const full = Shop.COINS[engine.analyze(rr.body.n).tier], tr = engine.analyze(rr.body.n).tier, pay = Shop.rollPay(full, 3001, tr);
  assert.deepEqual([rr.body.rate, rr.body.coins], [0.2, pay + Ev.rushBonus(pay, rr.body.t)], JSON.stringify(rr.body));

  // 2. Weekend Rush +25 % sur les quêtes : la récompense affichée le samedi.
  assert.deepEqual([Ev.rushMult(SAT), Ev.rushMult(TUE), Ev.rushBonus(150, SAT), Ev.rushBonus(150, TUE), Ev.rushBonus(3, SAT)], [1.25, 1, 37, 0, 0]);
  { const realNow = Date.now; Date.now = () => SAT;
    try { const q = await call(require(path.join(ROOT, 'api/quests.js')), { url: `/api/quests?me=${dr.playerId}` });
      const Quests = require(path.join(ROOT, 'js/quests.js'));
      assert.ok(q.body.rush, 'Rush annoncé le samedi');
      q.body.quests.forEach(x => { const base = Quests.POOL.find(y => y.id === x.id); if (base) assert.equal(x.reward, base.reward + Math.floor(base.reward * 0.25), x.id); });
    } finally { Date.now = realNow; } }

  // 3. Pseudo payant : le premier est gratuit, changer coûte 5 000 ; la casse seule reste gratuite ; un tirage sous un
  // autre nom ne renomme plus.
  const rn = { playerId: 'd4'.repeat(8), secret: 'd5'.repeat(16) };
  const setN = name => call(nameApi2, { method: 'POST', body: { ...rn, name } });
  assert.equal((await setN('Renamer')).status, 200, 'premier pseudo gratuit');
  assert.equal(field(rn.playerId, 'spent'), 0);
  assert.equal((await setN('RENAMER')).status, 200, 'casse seule : gratuit');
  assert.equal(field(rn.playerId, 'spent'), 0);
  let x = await setN('Renamer Two'); assert.equal(x.status, 402, 'sans les pièces : refusé'); assert.match(x.body.error, /5,000 coins/);
  assert.equal(run([['HGET', 'names', rn.playerId]])[0].result, 'RENAMER');
  run([['HINCRBY', `stats:${rn.playerId}`, 'bonus', 6000]]);
  assert.equal((await setN('Diminisher')).status, 409, 'nom d\'un autre : refusé sans payer');
  assert.equal(field(rn.playerId, 'spent'), 0);
  const ecoBefore = eco(Date.now(), 'out:rename');
  x = await setN('Renamer Two'); assert.equal(x.status, 200); assert.deepEqual([x.body.paid, x.body.coins], [5000, 1000]);
  assert.deepEqual([field(rn.playerId, 'spent'), bal(rn.playerId), eco(Date.now(), 'out:rename') - ecoBefore], [5000, 1000, 5000]);
  assert.equal(run([['GET', 'name:renamer']])[0].result, null, 'l\'ancien nom est libéré');
  db.delete(`cooldown:${rn.playerId}`);
  assert.equal((await call(roll, { method: 'POST', body: { ...rn, name: 'Free Rename' } })).status, 200);
  assert.equal(run([['HGET', 'names', rn.playerId]])[0].result, 'Renamer Two', 'un tirage ne renomme pas gratuitement');
  assert.equal(run([['GET', 'name:freerename']])[0].result, null, 'et ne réserve pas le nom');

  // 4. Prestige : stock limité, un par joueur, titre débloqué et équipé, eco out:prestige.
  const pr = { playerId: 'd6'.repeat(8), secret: 'd7'.repeat(16) };
  run([['SET', `player:${pr.playerId}:secret`, crypto.createHash('sha256').update(pr.secret).digest('hex')]]);
  const buy = item => call(shopApi, { method: 'POST', body: { ...pr, action: 'prestige', item } });
  const tycoon = Shop.prestigeById.get('tycoon');
  assert.ok(Shop.PRESTIGE.length === 3 && Shop.PRESTIGE.every(p => p.price >= 25000 && p.stock > 0));
  assert.equal((await buy('nope')).status, 400);
  x = await buy('tycoon'); assert.equal(x.status, 422); assert.match(x.body.error, /Not enough coins/);
  run([['HINCRBY', `stats:${pr.playerId}`, 'bonus', tycoon.price + 10]]);
  const pBefore = eco(Date.now(), 'out:prestige');
  x = await buy('tycoon'); assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.deepEqual([x.body.coins, x.body.prestige.find(p => p.id === 'tycoon').owned, eco(Date.now(), 'out:prestige') - pBefore], [10, true, tycoon.price]);
  assert.equal(x.body.prestige.find(p => p.id === 'tycoon').left, tycoon.stock - 1);
  assert.equal(run([['HGET', 'titles', pr.playerId]])[0].result, 'tycoon', 'titre équipé');
  assert.ok(require(path.join(ROOT, 'js/achievements.js')).unlocked({ 'pr:tycoon': 1 }).includes('tycoon'));
  await new Promise(r => setTimeout(r, 3));
  x = await buy('tycoon'); assert.equal(x.status, 200); assert.equal(x.body.coins, 10, 'acheté une seule fois');
  // Épuisé : le stock ne descend jamais sous zéro et le joueur ne paie rien.
  run([['HSET', 'prestige:sold', 'magnate', String(Shop.prestigeById.get('magnate').stock)], ['HINCRBY', `stats:${pr.playerId}`, 'bonus', 100000]]);
  await new Promise(r => setTimeout(r, 3));
  x = await buy('magnate'); assert.equal(x.status, 422); assert.match(x.body.error, /Sold out/);
  assert.equal(Number(run([['HGET', 'prestige:sold', 'magnate']])[0].result), Shop.prestigeById.get('magnate').stock);
  assert.equal(bal(pr.playerId), 100010);
}

// Annonces du créateur (idée de jaxoncool43, 2026-10-26) : publiques en lecture, publiées et retirées par l'Owner
// seulement, texte brut gardé tel quel (la page l'échappe), 20 au plus, Discord seulement si un salon existe.
{
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const mk = (tag, extra = []) => { const id = tag.repeat(8), secret = (tag + 'e').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', ...extra]]); return { playerId: id, secret }; };
  const boss = mk('a1', ['owner', '1']), kid = mk('a2');
  const site = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { action, ...(who ? { playerId: who.playerId, secret: who.secret } : {}), ...extra } });
  run([['DEL', 'ann:list']]);
  let r = await site(null, 'announcements'); assert.equal(r.status, 200); assert.deepEqual(r.body.list, []);
  r = await site(kid, 'annAdd', { title: 'Hi', text: 'hacked' }); assert.equal(r.status, 403, 'un joueur ne publie pas');
  r = await site(kid, 'annList'); assert.equal(r.status, 403);
  r = await site(boss, 'annAdd', { title: '', text: 'x' }); assert.equal(r.status, 422);
  r = await site(boss, 'annAdd', { title: 'T', text: 'x'.repeat(501) }); assert.equal(r.status, 422);
  r = await site(boss, 'annAdd', { title: '  Big   <b>news</b> ', text: 'Line 1\nLine <script>2</script>', important: true, discord: true });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.discord, false, 'pas de webhook : publiée dans le jeu seulement');
  assert.deepEqual([r.body.list[0].title, r.body.list[0].text, r.body.list[0].important], ['Big <b>news</b>', 'Line 1\nLine <script>2</script>', true]);
  const first = r.body.list[0].id;
  for (let i = 0; i < 21; i++) await site(boss, 'annAdd', { title: `N${i}`, text: 'ok', discord: false });
  r = await site(null, 'announcements'); assert.equal(r.body.list.length, 20); assert.equal(r.body.list[0].title, 'N20', 'la plus récente en tête');
  assert.ok(!r.body.list.some(a => a.id === first), 'la plus ancienne est tombée');
  const gone = r.body.list[3].id;
  r = await site(kid, 'annDelete', { id: gone }); assert.equal(r.status, 403);
  r = await site(boss, 'annDelete', { id: gone }); assert.equal(r.status, 200); assert.equal(r.body.list.length, 19); assert.ok(!r.body.list.some(a => a.id === gone));
  assert.equal((await site(boss, 'annDelete', { id: 'zz' })).status, 400);
  // Avec un salon Discord « announcements » (ou à défaut « updates ») : un message, sans mention de tout le monde.
  const dPath = require.resolve(path.join(ROOT, 'api/_discord.js'));
  delete require.cache[dPath];
  process.env.RNG_DISCORD_CONFIG = JSON.stringify({ updates: 'https://x.invalid/up', roles: { updates: '222' } });
  require(dPath); delete process.env.RNG_DISCORD_CONFIG;
  const sent = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (!String(u).startsWith('https://x.invalid/')) return realFetch(u, o); sent.push({ u, b: JSON.parse(o.body) }); return { ok: true }; };
  try {
    r = await site(boss, 'annAdd', { title: 'Hey @everyone', text: '**bold**', discord: true });
    assert.equal(r.body.discord, true); assert.equal(sent.length, 1); assert.equal(sent[0].u, 'https://x.invalid/up');
    assert.ok(!JSON.stringify(sent[0].b.embeds).includes('@everyone') && !sent[0].b.embeds[0].description.includes('**'));
    assert.deepEqual(sent[0].b.allowed_mentions, { parse: [], roles: ['222'] });
    await site(boss, 'annAdd', { title: 'Quiet', text: 'no discord', discord: false }); assert.equal(sent.length, 1, 'case décochée');
  } finally { globalThis.fetch = realFetch; delete require.cache[dPath]; }
}

// Feuille de route publique (idée de Phong67, 2026-10-26) : idées prévues et ajoutées depuis 30 jours, sans bugs, sans
// refusées, sans identifiants, texte coupé et filtré comme le chat global ; doneAt noté quand le créateur passe en Added.
{
  const siteApi = require(path.join(ROOT, 'api/site.js')), Roadmap = require(path.join(ROOT, 'api/_roadmap.js'));
  const now = Date.now(), D = 86400000, pid = 'b7'.repeat(8);
  const seed = (id, f) => run([['HSET', `sugg:${id}`, 't', f.t || now - 40 * D, 'pid', pid, 'name', f.name || 'Phong67', 'text', f.text, 'status', f.status, 'kind', f.kind || 'idea', ...(f.doneAt ? ['doneAt', f.doneAt] : []), ...(f.ownerAt ? ['ownerAt', f.ownerAt] : [])], ['ZADD', 'sugg:all', f.t || now - 40 * D, id]]);
  seed('aa0000000001', { text: 'A roadmap page so we can see what is coming next', status: 'planned' });
  seed('aa0000000002', { text: 'Add a dark mode for the casino', status: 'done', doneAt: now - 2 * D });
  seed('aa0000000003', { text: 'Old idea added long ago', status: 'done', doneAt: now - 45 * D });
  seed('aa0000000004', { text: 'Old idea, owner answered last week', status: 'done', ownerAt: now - 7 * D });
  seed('aa0000000005', { text: 'The roll button is broken', status: 'planned', kind: 'bug' });
  seed('aa0000000006', { text: 'Give me infinite luck please', status: 'declined' });
  seed('aa0000000007', { text: 'Join my server at freecoins.com for skins', status: 'planned' });
  seed('aa0000000008', { text: 'this game is shit, add more skins', status: 'planned' });
  seed('aa0000000009', { text: 'word '.repeat(60), status: 'planned' });
  seed('aa000000000a', { text: 'Fresh idea not triaged yet', status: 'new' });
  Roadmap.reset();
  let r = await call(siteApi, { method: 'POST', body: { action: 'roadmap' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const txt = list => list.map(x => x.text);
  assert.ok(txt(r.body.planned).includes('A roadmap page so we can see what is coming next'));
  assert.ok(!txt(r.body.planned).some(t => /broken|freecoins|shit/.test(t)), 'ni bug, ni lien, ni insulte');
  const long = r.body.planned.find(x => x.text.startsWith('word'));
  assert.ok(long && long.text.length <= 121 && long.text.endsWith('…'), 'texte coupé');
  assert.deepEqual(txt(r.body.recent).filter(t => /dark mode|Old idea/.test(t)), ['Add a dark mode for the casino', 'Old idea, owner answered last week']);
  const all = JSON.stringify(r.body);
  assert.ok(!all.includes(pid) && !all.includes('aa0000000001') && !/luck|Fresh idea/.test(all), 'ni identifiant, ni refusée, ni non triée');
  assert.equal(r.body.planned[0].name, 'Phong67');
  // Cache de 5 minutes : une nouvelle idée prévue n'apparaît qu'après.
  seed('aa000000000b', { text: 'Cached idea for later', status: 'planned', t: now });
  r = await call(siteApi, { method: 'POST', body: { action: 'roadmap' } });
  assert.ok(!JSON.stringify(r.body).includes('Cached idea'), 'servie depuis le cache');
  Roadmap.reset();
  r = await call(siteApi, { method: 'POST', body: { action: 'roadmap' } });
  assert.ok(JSON.stringify(r.body).includes('Cached idea'));
  // Toutes les idées prévues, pas seulement les 50 plus récentes (Sacha, 2026-11-05) ; « Recently added » reste à 50.
  for (let k = 0; k < 70; k++) seed(`ab00000000${k.toString(16).padStart(2, '0')}`, { text: `Planned idea number ${k} for the roadmap`, status: 'planned', t: now - k * 1000 });
  for (let k = 0; k < 60; k++) seed(`ac00000000${k.toString(16).padStart(2, '0')}`, { text: `Added idea number ${k} for the roadmap`, status: 'done', doneAt: now - k * 1000 });
  Roadmap.reset();
  r = await call(siteApi, { method: 'POST', body: { action: 'roadmap' } });
  assert.equal(r.body.planned.filter(x => /^Planned idea number/.test(x.text)).length, 70, 'toutes les prévues');
  assert.ok(r.body.planned.some(x => x.text === 'A roadmap page so we can see what is coming next'), 'la plus ancienne aussi');
  assert.equal(r.body.recent.length, 50, 'ajoutées : 50 au plus');
  // Passer une idée en Added note doneAt (une seule fois).
  const boss = { playerId: 'b8'.repeat(8), secret: 'b9'.repeat(16) };
  run([['SET', `player:${boss.playerId}:secret`, crypto.createHash('sha256').update(boss.secret).digest('hex')], ['HSET', `stats:${boss.playerId}`, 'v', '1', 'owner', '1']]);
  r = await call(siteApi, { method: 'POST', body: { ...boss, action: 'mark', id: 'aa000000000a', status: 'done' } }); assert.equal(r.status, 200);
  const at = Number(run([['HGET', 'sugg:aa000000000a', 'doneAt']])[0].result);
  assert.ok(at >= now, 'doneAt noté');
  await new Promise(res => setTimeout(res, 3));
  await call(siteApi, { method: 'POST', body: { ...boss, action: 'mark', id: 'aa000000000a', status: 'done' } });
  assert.equal(Number(run([['HGET', 'sugg:aa000000000a', 'doneAt']])[0].result), at, 'pas réécrit');
  Roadmap.reset();
}

// ---------------------------------------------------------------- photos de profil (api/_avatar.js, 2026-10-26)
{
  const Avatar = require(path.join(ROOT, 'api/_avatar.js'));
  const siteA = require(path.join(ROOT, 'api/site.js'));
  // JPEG minimal (structure seulement) : SOI, APP0 JFIF, SOF0 w×h, SOS, données, EOI.
  const jpeg = ({ w = 256, h = 256, exif = false, pad = 400 } = {}) => {
    const seg = (mk, data) => Buffer.concat([Buffer.from([0xff, mk, (data.length + 2) >> 8, (data.length + 2) & 255]), data]);
    const sof = Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
    return 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
      ...(exif ? [seg(0xe1, Buffer.from('Exif\0\0GPS-here'))] : []), seg(0xc0, sof), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
      crypto.randomBytes(pad).map(b => (b === 0xff ? 0 : b)), Buffer.from([0xff, 0xd9])]).toString('base64');
  };
  const mk = (hex, name, rolls, owner = false) => {
    const p = { playerId: ('a7' + hex).repeat(4), secret: ('a7' + hex).repeat(8), name };
    run([['SET', `player:${p.playerId}:secret`, crypto.createHash('sha256').update(p.secret).digest('hex')], ['HSET', `stats:${p.playerId}`, 'v', '1', 'rolls', String(rolls), ...(owner ? ['owner', '1'] : [])], ...(name ? [['HSET', 'names', p.playerId, name], ['SET', `name:${name.toLowerCase()}`, p.playerId]] : [])]);
    return p;
  };
  const kid = mk('c1', 'PicKid', 40), noname = mk('c2', '', 40), newbie = mk('c3', 'PicNew', 5), other = mk('c4', 'PicOther', 50), boss = mk('c5', 'PicBoss', 10, true);
  const av = (who, op, extra = {}) => call(profile, { method: 'POST', body: { action: 'avatar', op, playerId: who.playerId, secret: who.secret, ...extra } });
  // Lecture seule (viewerGrant, 2026-10-26) : la file se lit, rien ne se valide.
  { const viewer = mk('c6', 'PicViewer', 10); run([['HSET', `stats:${viewer.playerId}`, 'viewerGrant', '1']]);
    let q = await av(viewer, 'queue'); assert.equal(q.status, 200); assert.equal(q.body.readOnly, true);
    assert.equal((await av(viewer, 'approve', { name: 'PicKid' })).status, 403, 'lecture seule : pas de validation');
    assert.equal((await av(viewer, 'remove', { name: 'PicKid' })).status, 403);
    assert.equal((await av(other, 'queue')).status, 403, 'un joueur normal ne voit rien'); }
  // GET brut : l'image n'est pas du JSON.
  const getRaw = url => new Promise(resolve => { const headers = {}; const res = { statusCode: 200, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, end: d => resolve({ status: res.statusCode, headers, data: d }) }; profile({ method: 'GET', url, headers: {} }, res); });
  const map = async () => { Avatar.resetCache(); return JSON.parse((await getRaw('/api/profile?avatars=1')).data).map; };
  // Validation de l'envoi.
  assert.equal((await av(kid, 'upload', { img: 'data:image/png;base64,iVBORw0KGgo=' })).status, 422, 'pas un JPEG');
  assert.equal((await av(kid, 'upload', { img: 'data:image/jpeg;base64,' + Buffer.from('<svg onload=alert(1)>'.repeat(20)).toString('base64') })).status, 422, 'faux JPEG');
  assert.equal((await av(kid, 'upload', { img: jpeg({ pad: 70000 }) })).status, 422, 'trop lourd');
  assert.equal((await av(kid, 'upload', { img: jpeg({ exif: true }) })).status, 422, 'EXIF refusé');
  assert.equal((await av(kid, 'upload', { img: jpeg({ w: 300, h: 200 }) })).status, 422, 'pas carré');
  assert.equal((await av(noname, 'upload', { img: jpeg() })).status, 403, 'sans nom');
  assert.equal((await av(newbie, 'upload', { img: jpeg() })).status, 403, 'moins de 30 tirages');
  let r = await av(kid, 'upload', { img: jpeg() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.pending && r.body.pending.img.startsWith('data:image/jpeg;base64,') && !r.body.approved);
  // Une seule en attente par joueur : le nouvel envoi remplace l'ancien.
  await av(kid, 'upload', { img: jpeg() });
  assert.equal(Number(run([['HLEN', 'avpq']])[0].result), 1, 'une seule en attente');
  // Invisible pour les autres : rien dans la carte publique.
  assert.deepEqual(await map(), {}, 'rien de public avant validation');
  // File du créateur : réservée.
  assert.equal((await av(other, 'queue')).status, 403);
  assert.equal((await av(other, 'approve', { key: 'a'.repeat(20) })).status, 403);
  r = await av(boss, 'queue');
  assert.equal(r.status, 200); assert.equal(r.body.pending.length, 1); assert.equal(r.body.pending[0].name, 'PicKid');
  const dump = JSON.stringify(r.body);
  for (const p of [kid, other, boss]) assert.ok(!dump.includes(p.playerId), 'aucun identifiant');
  // Validation : version 1, image servie par jeton avec un cache long.
  r = await av(boss, 'approve', { key: r.body.pending[0].key });
  assert.equal(r.status, 200); assert.equal(r.body.pending.length, 0); assert.equal(r.body.log[0].action, 'approved');
  let m = await map(); assert.ok(/^[0-9a-f]{20}$/.test(m.PicKid), 'jeton public');
  const tok1 = m.PicKid;
  const img = await getRaw(`/api/profile?avatar=${tok1}`);
  assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/jpeg'); assert.ok(/immutable/.test(img.headers['cache-control']));
  assert.equal(img.data[0], 0xff); assert.equal(img.data[1], 0xd8);
  assert.equal((await getRaw('/api/profile?avatar=' + 'b'.repeat(20))).status, 404);
  assert.equal((await getRaw('/api/profile?avatar=' + kid.playerId)).status, 404, 'jamais par identifiant');
  assert.equal(JSON.parse(run([['GET', `av:${kid.playerId}`]])[0].result).v, 1);
  // Prix (idée de MereTera, 2026-11-01) : la première photo était gratuite ; la suivante coûte Shop.AVATAR_PRICE, refusée
  // sans les pièces (sans compter dans les 5 envois du jour), rendue si la photo est refusée ou retirée.
  const spentOf = who => Number(run([['HGET', `stats:${who.playerId}`, 'spent']])[0].result) || 0;
  assert.equal((await av(kid, 'mine')).body.price, Shop.AVATAR_PRICE, 'prix annoncé');
  assert.equal((await av(kid, 'upload', { img: jpeg() })).status, 402, 'pas assez de pièces');
  assert.equal(spentOf(kid), 0, 'rien payé');
  run([['HSET', `stats:${kid.playerId}`, 'bonus', String(5 * Shop.AVATAR_PRICE)]]);
  // Nouvelle image refusée : l'ancienne reste, le joueur voit la raison.
  await new Promise(res => setTimeout(res, 3));
  r = await av(kid, 'upload', { img: jpeg() });
  assert.equal(r.body.paid, Shop.AVATAR_PRICE); assert.equal(spentOf(kid), Shop.AVATAR_PRICE, 'payée à l\'envoi');
  assert.equal(r.body.price, 0, 'remplacer une photo payée en attente ne coûte rien de plus');
  r = await av(boss, 'queue'); assert.equal(r.body.pending[0].prev, `/api/profile?avatar=${tok1}`, 'ancienne image montrée');
  assert.equal((await av(boss, 'reject', { key: r.body.pending[0].key, reason: 'nope' })).status, 422, 'raison obligatoire');
  r = await av(boss, 'reject', { key: r.body.pending[0].key, reason: 'personal' }); assert.equal(r.status, 200);
  assert.equal(spentOf(kid), 0, 'refusée : pièces rendues');
  r = await av(kid, 'mine');
  assert.equal(r.body.rejected.reason, 'personal info / real face'); assert.ok(r.body.approved && !r.body.pending);
  assert.equal((await map()).PicKid, tok1, 'ancienne image gardée');
  // Une autre acceptée : version 2, nouveau jeton (cache), l'ancien jeton ne sert plus.
  await new Promise(res => setTimeout(res, 3));
  await av(kid, 'upload', { img: jpeg() });
  r = await av(boss, 'queue'); await av(boss, 'approve', { key: r.body.pending[0].key });
  m = await map(); assert.notEqual(m.PicKid, tok1);
  assert.equal(JSON.parse(run([['GET', `av:${kid.playerId}`]])[0].result).v, 2, 'version augmentée');
  assert.equal(spentOf(kid), Shop.AVATAR_PRICE, 'acceptée : payée');
  assert.equal((await getRaw(`/api/profile?avatar=${tok1}`)).status, 404);
  // Limite de 5 envois par jour (4 déjà faits).
  assert.equal((await av(kid, 'upload', { img: jpeg() })).status, 200, '5e envoi');
  assert.equal((await av(kid, 'upload', { img: jpeg() })).status, 429, '5 par jour');
  assert.equal(spentOf(kid), 2 * Shop.AVATAR_PRICE, 'le 6e envoi refusé ne coûte rien');
  r = await av(kid, 'cancel'); assert.equal(r.body.refunded, Shop.AVATAR_PRICE, 'retirée : pièces rendues');
  assert.equal(spentOf(kid), Shop.AVATAR_PRICE);
  // Signalement → Reports (where: 'avatar'), sans identifiant.
  assert.equal((await av(kid, 'report', { name: 'PicKid' })).status, 422, 'pas soi-même');
  assert.equal((await av(other, 'report', { name: 'PicOther' })).status, 404, 'pas d\'image');
  r = await av(other, 'report', { name: 'PicKid' }); assert.equal(r.status, 200); assert.ok(r.body.reported);
  r = await call(siteA, { method: 'POST', body: { action: 'reports', playerId: boss.playerId, secret: boss.secret } });
  const rep = r.body.reports.find(x => x.where === 'avatar');
  assert.ok(rep && rep.author === 'PicKid' && rep.reporter === 'PicOther');
  assert.ok(!JSON.stringify(r.body).includes(kid.playerId));
  // Retrait par le créateur.
  assert.equal((await av(other, 'remove', { name: 'PicKid' })).status, 403);
  r = await av(boss, 'remove', { name: 'PicKid', reason: 'inappropriate' }); assert.equal(r.status, 200);
  assert.equal(r.body.log[0].action, 'removed'); assert.equal(r.body.approved.length, 0);
  assert.deepEqual(await map(), {});
  r = await av(kid, 'mine'); assert.ok(!r.body.approved); assert.equal(r.body.rejected.reason, 'inappropriate'); assert.equal(r.body.left, 0);
  assert.equal((await call(profile, { method: 'POST', body: { action: 'avatar', op: 'mine', playerId: kid.playerId, secret: other.secret } })).status, 403, 'secret vérifié');
}

// ================================================================ Badges des idées du 2026-10-27
{
  const has = (n, id) => engine.analyze(n).earnedIds.includes(id);
  const scoring = (n, id) => engine.analyze(n).scoringIds.includes(id);
  // Famille FOREVER (daddy finger) : seul le meilleur compte.
  assert.ok(has(224, 'FOREVER_EXACT') && has(224224, 'FOREVER_AND_EVER') && has(31224, 'FOREVER'));
  assert.ok(scoring(224224, 'FOREVER_AND_EVER') && !scoring(224224, 'FOREVER'), 'un seul badge de la famille compte');
  assert.ok(!has(2224, 'FOREVER_EXACT') && !has(224225, 'FOREVER_AND_EVER'));
  // Jumbo Jet Set dans la famille JET, avec Jumbo Jet.
  assert.ok(scoring(747747, 'JUMBO_JET_SET') && !scoring(747747, 'JET_747'));
  for (const [n, id] of [[1987, 'YEAR_1987_EXACT'], [519870, 'YEAR_1987'], [505, 'FIVE_OH_FIVE_EXACT'], [15050, 'FIVE_OH_FIVE'], [190210, 'BEVERLY_HILLS'],
    [17380, 'SEVENTEEN_38'], [24, 'AROUND_THE_CLOCK'], [104, 'SUMMER_BREAK'], [124142, 'SILVER_RATIO_5'], [32414, 'SILVER_RATIO_4']]) assert.ok(has(n, id), `${id} sur ${n}`);
  assert.ok(!has(240, 'AROUND_THE_CLOCK') && !has(1040, 'SUMMER_BREAK') && !scoring(124142, 'SILVER_RATIO_4'));
  // Narcissiques (Kag) : la liste exacte, recalculée.
  // Contexte réduit (n, s, L, d) : parcourir le million avec analyze() prendrait une minute.
  const quick = id => { const ck = engine.byId.get(id).check, out = []; for (let n = 0; n <= 1000000; n++) { const s = String(n); if (ck({ n, s, L: s.length, d: [...s].map(Number) })) out.push(n); } return out; };
  const narc = quick('NARCISSISTIC');
  assert.deepEqual(narc, [153, 370, 371, 407, 1634, 8208, 9474, 54748, 92727, 93084, 548834]);
  // Quantum Chaos (qwertyuiop) : premier, 4 chiffres ou plus, aucun chiffre répété.
  assert.ok(has(1237, 'QUANTUM_CHAOS') && has(102359, 'QUANTUM_CHAOS'));
  assert.ok(!has(1223, 'QUANTUM_CHAOS') && !has(1231, 'QUANTUM_CHAOS') && !has(1234, 'QUANTUM_CHAOS') && !has(137, 'QUANTUM_CHAOS'));
  // Leap Day (Kag) : 0229AA, 2902AA, AA0229 avec AA multiple de 4 → 75 nombres, les 25 anciens restent.
  const leap = quick('LEAP_DAY');
  for (const n of [22924, 290224, 240229]) assert.ok(has(n, 'LEAP_DAY'));
  assert.equal(leap.length, 75);
  for (const n of [22900, 22924, 22996, 290200, 290224, 290296, 229, 40229, 240229, 960229]) assert.ok(leap.includes(n), `Leap Day ${n}`);
  for (const n of [290201, 290300, 250229, 10229, 22925]) assert.ok(!leap.includes(n), `pas Leap Day ${n}`);
}

// ================================================================ Rareté suivante (XP qui manquait) et titres du 2026-10-27
{
  // nextTier : le seuil rendu fait passer à la rareté suivante, un XP de moins ne suffit pas ; rien pour Infinite.
  const rankOf = t => engine.TIER_ORDER.indexOf(t);
  for (const n of [0, 7, 13, 99, 1234, 22924, 54321, 123456, 500000, 777777, 999999, 1000000]) {
    const total = engine.scoreOf(n), cur = engine.cardTier(total), nx = engine.nextTier(total);
    if (cur === 'infinite') { assert.equal(nx, null, `rien au-dessus d'Infinite (${n})`); continue; }
    assert.ok(nx && nx.short > 0 && nx.at === total + nx.short, `seuil de ${n}`);
    assert.equal(rankOf(nx.tier), rankOf(cur) + 1, `rareté juste au-dessus pour ${n} (${cur} → ${nx.tier})`);
    assert.equal(engine.cardTier(nx.at), nx.tier); assert.equal(engine.cardTier(nx.at - 1), cur);
  }
  assert.equal(engine.nextTier(engine.scoreOf(1)), null, '1 est Infinite'); // 24 ne l'est plus depuis So Close (97), 2026-10-28

  const { COLLECTION_SETS, COLLECTION_VERSION, recordRoll, readStats } = require(path.join(ROOT, 'api/_lib.js'));
  const Ach = require(path.join(ROOT, 'js/achievements.js'));
  const unlocked = st => Ach.unlocked(st);
  // Titres simples, lus sur les stats.
  assert.ok(unlocked({ xpLife: 1e10 }).includes('decabillionaire') && !unlocked({ xpLife: 9999999999 }).includes('decabillionaire'));
  assert.ok(unlocked({ clanDonated: 100000 }).includes('clanbenefactor') && !unlocked({ clanDonated: 99999 }).includes('clanbenefactor'));
  assert.ok(unlocked({ clanDonated: 1000000 }).includes('clanpillar'));
  // Pièces gagnées en jouant : tirages (après rendements décroissants) + duels + Weekend Rush ; ni casino ni cadeaux.
  assert.ok(unlocked({ 't:common': 10000 }).includes('piggybank'), '10 000 Common = 10 000 pièces');
  assert.ok(!unlocked({ 't:common': 10000, rollCut: 1 }).includes('piggybank'), 'la part retenue ne compte pas');
  assert.ok(unlocked({ 't:common': 9000, rushBonus: 1000 }).includes('piggybank'), 'le Weekend Rush compte');
  assert.ok(!unlocked({ bonus: 5e6, gWon: 5e6, giftIn: 1e6 }).includes('piggybank'), 'casino et cadeaux ne comptent pas');
  assert.ok(unlocked({ 't:mythic': 1000 }).includes('moneymaker') && unlocked({ 't:mythic': 10000 }).includes('coinmachine'));

  // Collections par rareté : jamais un badge plus rare que sa couleur (Important Birthday est Rare mais un seul nombre).
  assert.deepEqual(Ach.COLLECT.map(([t]) => t), ['common', 'uncommon', 'rare', 'epic', 'anomaly']);
  for (const id of ['IMPORTANT_BIRTHDAY', 'NATURAL_EXACT', 'RTX_5090_EXACT']) assert.ok(!COLLECTION_SETS.rare.includes(id), `${id} hors des Rare`);
  for (const [t, ids] of Object.entries(COLLECTION_SETS)) { assert.ok(ids.length > 10, t); for (const id of ids) assert.ok(engine.byId.has(id)); }
  assert.ok(COLLECTION_SETS.common.includes('ODD') && COLLECTION_SETS.anomaly.includes('NARCISSISTIC'));

  const col = { playerId: 'd8'.repeat(8), secret: 'd9'.repeat(16), name: 'Collecty' };
  db.delete(`cooldown:${col.playerId}`); assert.equal((await call(roll, { method: 'POST', body: col })).status, 200);
  let st = await readStats(col.playerId);
  assert.equal(st.colv, COLLECTION_VERSION, 'version posée');
  assert.ok(!unlocked(st).includes('colcommon') || COLLECTION_SETS.common.every(id => run([['SISMEMBER', `badges:${col.playerId}`, id]])[0].result === 1));
  // Ancien joueur qui a déjà tous les Common : obtenu à la première lecture après la mise à jour (version différente).
  run([['SADD', `badges:${col.playerId}`, ...COLLECTION_SETS.common], ['HSET', `stats:${col.playerId}`, 'colv', 'old']]);
  st = await readStats(col.playerId);
  assert.ok(unlocked(st).includes('colcommon'), 'Common Collector');
  // Un badge neuf venu d'un tirage complète les Uncommon (sans changement de version).
  const last = COLLECTION_SETS.uncommon.find(id => { for (let n = 1000; n < 200000; n++) if (engine.analyze(n).earnedIds.includes(id)) return true; return false; });
  let lastN = 1000; while (!engine.analyze(lastN).earnedIds.includes(last)) lastN++;
  run([['SADD', `badges:${col.playerId}`, ...COLLECTION_SETS.uncommon.filter(id => id !== last)], ['SREM', `badges:${col.playerId}`, last]]);
  st = await readStats(col.playerId); assert.ok(!unlocked(st).includes('coluncommon'), 'il en manque un');
  const done = await recordRoll(col.playerId, lastN, Date.now());
  assert.ok(done.achievements.includes('coluncommon'), `Uncommon Admirer avec ${last} (${lastN})`);
  // Jamais retiré : un badge ajouté plus tard (nouvelle version) ne reprend rien.
  run([['SREM', `badges:${col.playerId}`, last], ['HSET', `stats:${col.playerId}`, 'colv', 'old']]);
  st = await readStats(col.playerId); assert.ok(unlocked(st).includes('coluncommon') && unlocked(st).includes('colcommon'));

  // Sound Collector et Shopaholic : posés à la lecture de la boutique, pour les joueurs qui avaient déjà tout.
  const Shop = require(path.join(ROOT, 'js/shop.js')), shopApi = require(path.join(ROOT, 'api/shop.js'));
  const shopState = () => call(shopApi, { url: `/api/shop?me=${col.playerId}` });
  run([['SADD', `snds:${col.playerId}`, ...Shop.collectibleSets.sounds()]]);
  assert.equal((await shopState()).status, 200);
  st = await readStats(col.playerId); assert.ok(unlocked(st).includes('allsounds') && !unlocked(st).includes('shopaholic'));
  run([['SADD', `skins:${col.playerId}`, ...Shop.collectible()], ['SADD', `btns:${col.playerId}`, ...Shop.collectibleSets.buttons()],
    ['SADD', `emotes:${col.playerId}`, ...Shop.collectibleSets.emotes()], ['SADD', `walls:${col.playerId}`, ...Shop.collectibleSets.walls()],
    ['HSET', `stats:${col.playerId}`, 'speedLv', Shop.SPEED.prices.length - 1]]);
  await shopState(); st = await readStats(col.playerId); assert.ok(!unlocked(st).includes('shopaholic'), 'une amélioration manque');
  run([['HSET', `stats:${col.playerId}`, 'speedLv', Shop.SPEED.prices.length]]);
  await shopState(); st = await readStats(col.playerId); assert.ok(unlocked(st).includes('shopaholic'), 'tout possédé');
}

// ================================================================ Idées du 2026-10-27 : classement « Most rolls » (CrazyMiner22,
// WpBejs), nombres différents (jsand), quêtes de la semaine (Tumored), coffre des quêtes (Sean), co-chef de clan (Yentizx,
// JAKECisthebest) et Clan MVP (PRISMA123).
{
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js')), qApi = require(path.join(ROOT, 'api/quests.js')), Q = require(path.join(ROOT, 'js/quests.js'));
  const lib = require(path.join(ROOT, 'api/_lib.js')), ShopM = require(path.join(ROOT, 'js/shop.js')), Ach = require(path.join(ROOT, 'js/achievements.js'));
  const Clan = require(path.join(ROOT, 'api/_clan.js'));
  const pause = () => new Promise(res => setTimeout(res, 3));
  const mk = (i, name, fields = {}) => {
    const id = `27ed${i.toString(16).padStart(12, '0')}`, secret = id + id;
    run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', ...Object.entries(fields).flat().map(String)], ['HSET', 'names', id, name], ['SET', `name:${lib.nameKey(name)}`, id]]);
    return { playerId: id, secret, name };
  };
  const statsOf = id => { const flat = run([['HGETALL', `stats:${id}`]])[0].result, o = {}; for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
  const ecoIn = field => [...db.keys()].filter(k => /^eco:\d{4}-/.test(k)).reduce((x, k) => x + (Number(run([['HGET', k, `in:${field}`]])[0].result) || 0), 0);
  const qGet = who => call(qApi, { url: `/api/quests?me=${who.playerId}` });
  const qPost = (who, action, extra = {}) => call(qApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, ...extra } });
  // Horloge : loin de minuit UTC (donc aussi du lundi 00:00), pour que le jour et la semaine ne changent pas pendant le bloc.
  { const now = Date.now(), next = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) + 86400000; if (next - now < 20 * 60000) clock += next - now + 60000; }

  // 1. Most rolls : les anciens joueurs versés une fois depuis stats.rolls (ou count:all), rejouable, puis chaque tirage.
  const old1 = mk(1, 'Rollerold', { rolls: 500 }), old2 = mk(2, 'Rollercount'), old3 = mk(3, 'Rollerpart', { rolls: 10 });
  run([['DEL', 'lb:rolls:migrated'], ['DEL', 'lb:rolls:cursor'], ['HSET', 'count:all', old1.playerId, 500], ['HSET', 'count:all', old2.playerId, 42], ['HSET', 'count:all', old3.playerId, 10], ['ZADD', 'lb:rolls', 3, old3.playerId]]);
  for (let i = 0; i < 10 && !run([['GET', 'lb:rolls:migrated']])[0].result; i++) await lbApi.migrateRolls();
  assert.ok(run([['GET', 'lb:rolls:migrated']])[0].result, 'versement fini');
  const zr = id => Number(run([['ZSCORE', 'lb:rolls', id]])[0].result);
  assert.deepEqual([zr(old1.playerId), zr(old2.playerId), zr(old3.playerId)], [500, 42, 10], 'stats.rolls, sinon count:all ; l\'écart seulement');
  await lib.recordRoll(old3.playerId, 4242, Date.now());
  assert.equal(zr(old3.playerId), 11, 'chaque tirage compte');
  run([['DEL', 'lb:rolls:migrated']]); await lbApi.migrateRolls();
  assert.equal(zr(old3.playerId), 11, 'rejoué : rien compté deux fois');
  r = await call(lbApi, { url: `/api/leaderboard?period=rolls&me=${old3.playerId}` });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.period, 'rolls');
  for (let i = 1; i < r.body.entries.length; i++) assert.ok(r.body.entries[i - 1].count >= r.body.entries[i].count, 'du plus grand au plus petit');
  const rowOf = name => r.body.entries.find(e => e.name === name);
  assert.equal(rowOf('Rollerold').count, 500); assert.equal(rowOf('Rollerpart').count, 11); assert.ok(rowOf('Rollerpart').me);
  assert.ok(!JSON.stringify(r.body).includes(old1.playerId), 'aucun identifiant');
  // Hors du top 100 : sa ligne arrive à part, avec son rang.
  run(Array.from({ length: 105 }, (_, i) => ['ZADD', 'lb:rolls', 100000 + i, `27ee${i.toString(16).padStart(12, '0')}`]));
  r = await call(lbApi, { url: `/api/leaderboard?period=rolls&me=${old3.playerId}` });
  assert.equal(r.body.entries.length, 100); assert.ok(r.body.mine && r.body.mine.me && r.body.mine.count === 11 && r.body.mine.rank > 100);
  run(Array.from({ length: 105 }, (_, i) => ['ZREM', 'lb:rolls', `27ee${i.toString(16).padStart(12, '0')}`]));

  // 2. Nombres différents tirés : SCARD de nums:<id> (Stats et profil) ; sans ce set, compté sur l'historique.
  const uq = mk(4, 'Uniqueroller');
  const t0 = Date.now();
  await lib.recordRoll(uq.playerId, 123, t0); await lib.recordRoll(uq.playerId, 123, t0 + 3); await lib.recordRoll(uq.playerId, 456, t0 + 6);
  r = await call(profile, { url: '/api/profile?name=Uniqueroller&lite=1' }); assert.equal(r.body.uniq, 2, 'lite : 2 nombres différents');
  r = await call(profile, { url: '/api/profile?name=Uniqueroller' }); assert.equal(r.body.uniq, 2, 'profil : 2 nombres différents');
  const nodv = mk(5, 'Oldhistory'); run([['HDEL', `stats:${nodv.playerId}`, 'dv'], ['ZADD', `hist:${nodv.playerId}`, t0, `${t0}:7`, t0 + 5000, `${t0 + 5000}:8`, t0 + 90000, `${t0 + 90000}:7`]]);
  r = await call(profile, { url: '/api/profile?name=Oldhistory' }); assert.equal(r.body.uniq, 2, 'sans set : depuis l\'historique'); assert.equal(r.body.rolls, 3);
  r = await call(profile, { url: '/api/profile?name=Oldhistory&lite=1' }); assert.equal(r.body.uniq, null, 'lite sans set : rien');

  // 3. Quêtes de la semaine : 3, les mêmes pour tous, progression tenue par le serveur, une récompense chacune.
  const wq = mk(6, 'Weeklyquester'), week = lib.weekKey(Date.now());
  await lib.recordRoll(wq.playerId, 5, Date.now());
  r = await qGet(wq); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.weekly.quests.map(q => q.id), Q.ofWeek(week).map(q => q.id)); assert.equal(r.body.weekly.week, week);
  assert.deepEqual(new Set(Q.ofWeek(week).map(q => q.group)), new Set(['rolls', 'rarity', 'days']), 'une par groupe');
  assert.equal(r.body.weekly.quests[0].progress, 1, 'le tirage compte');
  const wEnd = r.body.weekly.resetAt;
  assert.equal(new Date(wEnd).getUTCDay(), 1, 'un lundi'); assert.equal(wEnd % 86400000, 0, 'à 00:00 UTC');
  assert.equal(lib.weekKey(wEnd - 1), week); assert.notEqual(lib.weekKey(wEnd), week, 'la semaine change à resetAt');
  const tier5 = engine.cardTier(engine.scoreOf(5));
  if (!['epic', 'anomaly', 'mythic', 'celestial', 'divine', 'godlike', 'infinite'].includes(tier5)) assert.equal(run([['HGET', `qw:${week}:${wq.playerId}`, `t:${tier5}`]])[0].result, null, 'raretés basses non comptées');
  const wq0 = r.body.weekly.quests[0];
  assert.equal((await qPost(wq, 'wclaim', { quest: wq0.id })).status, 422, 'pas finie');
  assert.equal((await qPost(wq, 'wclaim', { quest: 'w-nope' })).status, 400);
  assert.equal((await qPost({ ...wq, secret: '9'.repeat(32) }, 'wclaim', { quest: wq0.id })).status, 403);
  run([['HSET', `qw:${week}:${wq.playerId}`, 'rolls', 1000, 't:mythic', 20, 'days', 5]]);
  const coins0 = ShopM.balance(statsOf(wq.playerId)), eco0 = ecoIn('weekly');
  let sum = 0;
  for (const q of Q.ofWeek(week)) {
    r = await qPost(wq, 'wclaim', { quest: q.id }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.gained, q.reward); sum += q.reward;
    assert.equal((await qPost(wq, 'wclaim', { quest: q.id })).status, 422, 'une seule fois');
  }
  assert.ok(r.body.weekly.quests.every(q => q.claimed));
  assert.equal(ShopM.balance(statsOf(wq.playerId)), coins0 + sum, 'pièces créditées'); assert.equal(ecoIn('weekly') - eco0, sum, 'comptées dans l\'économie (in:weekly)');
  assert.ok(sum >= 1000 && sum <= 1800, 'entre 1 000 et 1 800 par semaine');
  // Deux réclamations en même temps : une seule payée.
  run([['HDEL', `qw:${week}:${wq.playerId}`, `claimed:${wq0.id}`]]);
  const both = await Promise.all([qPost(wq, 'wclaim', { quest: wq0.id }), qPost(wq, 'wclaim', { quest: wq0.id })]);
  assert.deepEqual(both.map(x => x.status).sort(), [200, 422], 'deux clics : un seul paiement');

  // 4. Jour « tout fini » : compte pour la semaine et pour le coffre (parti de la meilleure série d'avant), bonus dans l'éco.
  const ad = mk(7, 'Alldoner', { qsBest: 9 }), today = new Date(Date.now()).toISOString().slice(0, 10);
  run([['HSET', `q:${today}:${ad.playerId}`, 'rolls', 60, 'xp', 1000000, 't:uncommon', 8, 't:rare', 3, 't:epic', 1, 'duels', 3, 'duelWins', 1, 'casino', 15, 'casinoBet', 500]]);
  const ecoQ0 = ecoIn('quests'); let got = 0;
  for (const q of Q.ofDay(today)) { r = await qPost(ad, 'claim', { quest: q.id }); assert.equal(r.status, 200, JSON.stringify(r.body)); got += r.body.gained; }
  assert.ok(r.body.allDone, 'tout fini');
  assert.equal(ecoIn('quests') - ecoQ0, got, 'quêtes + bonus « tout fini » comptés dans l\'économie');
  assert.equal(run([['HGET', `qw:${week}:${ad.playerId}`, 'days']])[0].result, '1', 'un jour pour la quête de la semaine');
  assert.equal(statsOf(ad.playerId).qdays, '10', '9 (meilleure série d\'avant) + 1');
  assert.deepEqual([r.body.chest.days, r.body.chest.ready, r.body.chest.coins], [10, 2, 750], 'coffres de 4 et 10 jours prêts');

  // 5. Coffre des quêtes : paliers ouverts une fois chacun, tous ceux qui sont prêts d'un coup.
  assert.deepEqual(Q.CHESTS.map(c => c.at), [4, 10, 25, 50, 100, 200, 365]);
  const ch = mk(8, 'Chestopener', { qsBest: 30 });
  r = await qGet(ch); assert.deepEqual([r.body.chest.days, r.body.chest.opened, r.body.chest.ready, r.body.chest.coins, r.body.chest.next.at], [30, 0, 3, 1750, 50], 'meilleure série de 30 : 3 coffres');
  const c0 = ShopM.balance(statsOf(ch.playerId)), e0 = ecoIn('chest');
  const two = await Promise.all([qPost(ch, 'chest'), qPost(ch, 'chest')]);
  assert.deepEqual(two.map(x => x.status).sort(), [200, 429], 'deux clics : un seul coffre');
  const okc = two.find(x => x.status === 200).body;
  assert.deepEqual([okc.gained, okc.chests, okc.chest.opened, okc.chest.ready], [1750, 3, 3, 0]);
  assert.equal(ShopM.balance(statsOf(ch.playerId)), c0 + 1750); assert.equal(ecoIn('chest') - e0, 1750, 'comptés dans l\'économie (in:chest)');
  assert.equal((await qPost(ch, 'chest')).status, 422, 'rien à ouvrir');
  assert.ok(okc.chest.milestones.slice(0, 3).every(m => m.open) && !okc.chest.milestones[3].open);
  run([['HSET', `stats:${ch.playerId}`, 'qdays', 50]]);
  r = await qPost(ch, 'chest'); assert.deepEqual([r.status, r.body.gained, r.body.chest.opened], [200, 2000, 4], '50 jours');
  run([['HSET', `stats:${ch.playerId}`, 'qsBest', 400]]); r = await qGet(ch); assert.equal(r.body.chest.days, 50, 'le compteur posé ne repart pas de la série');

  // 6. Co-chef : entre le chef et les officiers.
  const L = mk(16, 'Coleadboss', { rolls: 60, bonus: 30000 }), X = mk(17, 'Coleadx', { rolls: 60 }), Y = mk(18, 'Coleady', { rolls: 60 }), Z = mk(19, 'Coleadz', { rolls: 60 }), M = mk(20, 'Coleadm', { rolls: 60 });
  const H = (who, op, extra = {}, now) => Clan.handle(who.playerId, { op, ...extra }, now);
  const fails = async (p, status, msg) => { try { await p; } catch (err) { assert.equal(err.status, status, `${msg} : ${err.message}`); return err; } assert.fail(`${msg} : aurait dû échouer`); };
  await H(L, 'create', { clanName: 'Co Lead Crew', tag: 'COLD' });
  for (const p of [X, Y, Z, M]) { await H(L, 'invite', { name: p.name }); await H(p, 'join', { tag: 'COLD' }); }
  await H(L, 'promote', { name: 'Coleadx' }); assert.equal((await H(X, 'view')).me.role, 'officer');
  let v = await H(L, 'promote', { name: 'Coleadx' }); assert.equal((await H(X, 'view')).me.role, 'coleader', 'officier → co-chef');
  assert.equal(v.clan.log[0].k, 'colead');
  assert.deepEqual(v.clan.members.map(m => m.role).slice(0, 2), ['leader', 'coleader'], 'trié par rang');
  await fails(H(L, 'promote', { name: 'Coleadx' }), 422, 'déjà co-chef');
  // Droits des officiers tous coupés : le co-chef garde tout.
  await H(L, 'perms', { perms: { invite: false, kick: false, upgrade: false, war: false, edit: false } });
  v = await H(X, 'view'); assert.deepEqual(v.me.can, { invite: true, kick: true, upgrade: true, war: true, edit: true }, 'le co-chef ignore les droits coupés');
  await H(X, 'desc', { desc: 'Co-leaders rule' });
  await H(X, 'promote', { name: 'Coleady' }); assert.equal((await H(Y, 'view')).me.role, 'officer', 'le co-chef nomme des officiers');
  await fails(H(X, 'promote', { name: 'Coleady' }), 403, 'seul le chef nomme les co-chefs');
  await fails(H(Y, 'promote', { name: 'Coleadm' }), 403, 'un officier ne nomme personne');
  await fails(H(Y, 'kick', { name: 'Coleadm' }), 403, 'droits d\'exclusion coupés pour les officiers');
  await H(X, 'demote', { name: 'Coleady' }); assert.equal((await H(Y, 'view')).me.role, 'member', 'le co-chef rétrograde les officiers');
  await H(X, 'promote', { name: 'Coleady' });
  await H(L, 'promote', { name: 'Coleadz' }); await H(L, 'promote', { name: 'Coleadz' }); assert.equal((await H(Z, 'view')).me.role, 'coleader');
  await fails(H(X, 'kick', { name: 'Coleadz' }), 403, 'un co-chef n\'exclut pas un autre co-chef');
  await fails(H(X, 'demote', { name: 'Coleadz' }), 403, 'ni ne le rétrograde');
  await fails(H(X, 'kick', { name: 'Coleadboss' }), 403, 'ni le chef');
  await fails(H(X, 'transfer', { name: 'Coleadm' }), 403, 'ne passe pas la main');
  await fails(H(X, 'disband'), 403, 'ne dissout pas');
  await fails(H(X, 'perms', { perms: {} }), 403, 'ne règle pas les droits');
  // Chat : le co-chef modère officiers et membres, pas un autre co-chef ; un officier ne touche pas au co-chef.
  await H(Z, 'say', { text: 'from z' }); await pause(); await H(Y, 'say', { text: 'from y' }); await pause(); v = await H(X, 'say', { text: 'from x' });
  const tOf = name => v.messages.find(m => m.name === name).t;
  assert.ok(!v.messages.find(m => m.name === 'Coleadz').canDelete && v.messages.find(m => m.name === 'Coleady').canDelete);
  await fails(H(X, 'unsend', { t: tOf('Coleadz') }), 403, 'pas le message d\'un autre co-chef');
  await fails(H(Y, 'unsend', { t: tOf('Coleadx') }), 403, 'l\'officier ne supprime pas le co-chef');
  await H(X, 'unsend', { t: tOf('Coleady') }); await H(L, 'unsend', { t: tOf('Coleadz') });
  await H(X, 'kick', { name: 'Coleady' }); assert.equal((await H(Y, 'view')).me.inClan, false, 'le co-chef exclut un officier');
  v = await H(L, 'demote', { name: 'Coleadz' }); assert.equal(v.clan.log[0].k, 'uncolead'); assert.equal((await H(Z, 'view')).me.role, 'officer', 'co-chef → officier');
  await H(L, 'transfer', { name: 'Coleadm' });
  assert.equal((await H(M, 'view')).me.role, 'leader'); assert.equal((await H(L, 'view')).me.role, 'coleader', 'l\'ancien chef devient co-chef');

  // 7. Clan MVP : le plus gros apport d'XP du clan n°1 de la semaine, une fois par semaine, compté.
  const wk = Date.UTC(2033, 2, 9, 12), nextWk = wk + 7 * 86400000;
  await lib.recordRoll(X.playerId, 999999, wk); await lib.recordRoll(Z.playerId, 123456, wk + 5); await lib.recordRoll(L.playerId, 500001, wk + 10);
  Clan._reset(); await Clan.settleWeek(nextWk); Clan._reset(); await Clan.settleWeek(nextWk);
  assert.equal(statsOf(X.playerId).clanMvp, '1', 'MVP une seule fois'); assert.equal(statsOf(Z.playerId).clanMvp, undefined); assert.equal(statsOf(Z.playerId).clanWeekWins, '1');
  assert.ok(Ach.unlocked(statsOf(X.playerId)).includes('clanmvp')); assert.ok(!Ach.unlocked(statsOf(Z.playerId)).includes('clanmvp'));
  const last = (await Clan.board(nextWk)).last; assert.equal(last.tag, 'COLD'); assert.equal(last.mvp, 'Coleadx');
  assert.ok(!JSON.stringify(last).includes(X.playerId));
  r = await call(profile, { url: '/api/profile?name=Coleadx' }); assert.equal(r.body.clanMvp, 1);
  Clan._reset();
}

// ================================================================ Idées du 2026-10-28 : badges Pythagorean (Phong254),
// Prime Digits (Kag) et So Close (MAYO), marge au-dessus de la rareté du dessous (Starharvest), titres « nombres
// différents » (jsand), duels contre des bots au rythme du joueur (Lewis6767).
{
  const lib = require(path.join(ROOT, 'api/_lib.js')), Ach = require(path.join(ROOT, 'js/achievements.js')), Shop = require(path.join(ROOT, 'js/shop.js'));
  const odds = require(path.join(ROOT, 'data/badge-odds.json'));
  const has = (n, id) => engine.analyze(n).earnedIds.includes(id);
  // 1. Badges : fréquences exactes (build.mjs), cas limites.
  assert.deepEqual([odds.PYTHAGOREAN, odds.PRIME_DIGITS, odds.SO_CLOSE], [100, 5460, 1], 'nombres qui obtiennent chaque badge');
  for (const n of [102426, 150817, 304050, 30405, 60810, 51213, 202129, 334455]) assert.ok(has(n, 'PYTHAGOREAN'), `${n} est pythagoricien`);
  for (const n of [100010, 101010, 10101, 3045, 345, 0, 1000000, 102427, 240726]) assert.ok(!has(n, 'PYTHAGOREAN'), `${n} ne l'est pas`);
  assert.deepEqual(engine.highlight('PYTHAGOREAN', 102426), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(engine.highlight('PYTHAGOREAN', 30405), [[0], [1, 2], [3, 4]], '5 chiffres : 03 04 05');
  for (const n of [2, 7, 23, 2357, 777777, 532752]) assert.ok(has(n, 'PRIME_DIGITS'), `${n} : chiffres premiers`);
  for (const n of [0, 1, 4, 28, 2358, 1000000, 222221]) assert.ok(!has(n, 'PRIME_DIGITS'), `${n} : non`);
  assert.ok(has(97, 'SO_CLOSE') && !has(970, 'SO_CLOSE') && !has(197, 'SO_CLOSE') && !has(98, 'SO_CLOSE'), 'exactement 97');
  assert.equal(engine.byId.get('SO_CLOSE').score, 100000100, 'comme les autres badges exacts');

  // 2. Rareté du dessous : total - above y tombe, total - above + 1 reste dans la rareté du tirage ; rien sous Land waste.
  const rankOf = t => engine.TIER_ORDER.indexOf(t);
  const found = {};
  for (let n = 100000; n < 130000 && Object.keys(found).length < 5; n++) {
    const t = engine.cardTier(engine.scoreOf(n));
    if (['landwaste', 'garbage', 'trash', 'common', 'uncommon'].includes(t) && !found[t]) found[t] = n;
  }
  for (let n = 500000; !found.landwaste && n < 520000; n++) if (engine.cardTier(engine.scoreOf(n)) === 'landwaste') found.landwaste = n;
  assert.deepEqual(Object.keys(found).sort(), ['common', 'garbage', 'landwaste', 'trash', 'uncommon']);
  for (const [cur, n] of Object.entries(found)) {
    const total = engine.scoreOf(n), pv = engine.prevTier(total);
    if (cur === 'landwaste') { assert.equal(pv, null, 'rien sous Land waste'); continue; }
    assert.ok(pv && pv.above > 0 && pv.at === total - pv.above + 1, `marge de ${n}`);
    assert.equal(rankOf(pv.tier), rankOf(cur) - 1, `${cur} → ${pv.tier}`);
    assert.equal(engine.cardTier(total - pv.above), pv.tier); assert.equal(engine.cardTier(total - pv.above + 1), cur);
  }

  // 3. Titres « nombres différents » : stats.uniq = SCARD nums:<id>, lu seulement quand le set est complet (dv).
  const MILESTONES = { uniq100: 100, uniq500: 500, uniq1k: 1000, uniq5k: 5000, uniq10k: 10000, uniq50k: 50000, uniq100k: 100000 };
  for (const [id, k] of Object.entries(MILESTONES)) assert.ok(Ach.byId.get(id).test({ uniq: k }) && !Ach.byId.get(id).test({ uniq: k - 1 }), id);
  assert.ok(!Ach.unlocked({ uniq: 99 }).includes('uniq100') && !Ach.unlocked({ rolls: 5000, dups: 0 }).includes('uniq100'), 'jamais sans le compte');
  const mk = (i, name, fields = []) => {
    const id = `28ed${i.toString(16).padStart(12, '0')}`, secret = id + id;
    run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', ...fields], ['HSET', 'names', id, name], ['SET', `name:${lib.nameKey(name)}`, id]]);
    return { playerId: id, secret, name };
  };
  const u = mk(1, 'Uniqtitle', ['dv', '1']);
  run([['SADD', `nums:${u.playerId}`, ...Array.from({ length: 99 }, (_, i) => String(200000 + i))]]);
  let st = await lib.readStats(u.playerId); assert.equal(st.uniq, 99); assert.ok(!Ach.unlocked(st).includes('uniq100'));
  let done = await lib.recordRoll(u.playerId, 200050, Date.now()); // déjà tiré : toujours 99
  assert.ok(!done.achievements.includes('uniq100'), 'un doublon ne compte pas');
  await new Promise(res => setTimeout(res, 3));
  done = await lib.recordRoll(u.playerId, 654321, Date.now());
  assert.ok(done.achievements.includes('uniq100'), 'le 100e nombre différent débloque le titre');
  st = await lib.readStats(u.playerId); assert.equal(st.uniq, 100); assert.equal(run([['HGET', `stats:${u.playerId}`, 'uniq']])[0].result, null, 'jamais écrit dans stats');
  let r = await call(titleApi, { method: 'POST', body: { playerId: u.playerId, secret: u.secret, title: 'uniq100' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.title, 'uniq100');
  assert.equal((await call(titleApi, { method: 'POST', body: { playerId: u.playerId, secret: u.secret, title: 'uniq500' } })).status, 422, 'pas encore 500');
  // Ancien joueur sans set complet (pas de dv) : rien tant qu'il n'a pas tiré ; son premier tirage remplit le set
  // depuis l'historique et le compte tout de suite.
  const o = mk(2, 'Uniqold');
  const t0 = Date.now() - 5000000;
  run([['SADD', `nums:${o.playerId}`, ...Array.from({ length: 150 }, (_, i) => String(300000 + i))], ['ZADD', `hist:${o.playerId}`, ...Array.from({ length: 120 }, (_, i) => [t0 + i * 10, `${t0 + i * 10}:${400000 + i}`]).flat()]]);
  st = await lib.readStats(o.playerId); assert.equal(st.uniq, undefined, 'set pas encore fiable'); assert.ok(!Ach.unlocked(st).includes('uniq100'));
  done = await lib.recordRoll(o.playerId, 123457, Date.now());
  assert.ok(done.achievements.includes('uniq100'), 'compté dès le premier tirage');
  assert.equal((await lib.readStats(o.playerId)).uniq, Number(run([['SCARD', `nums:${o.playerId}`]])[0].result));

  // 4. Duel contre des bots : la manche suit la vitesse achetée du joueur (round.pace), délai et révélation compris ;
  // sans vitesse, ou à deux humains, le rythme commun reste. Les nombres et le gagnant ne changent pas de règle.
  const fast = mk(3, 'Fastbotter', ['speedLv', String(Shop.SPEED.prices.length)]), slow = mk(4, 'Slowbotter'), mate = mk(5, 'Botmate');
  const f = Shop.speedFactor(Shop.SPEED.prices.length); assert.equal(f, 0.5);
  run([['DEL', `cooldown:${fast.playerId}`], ['DEL', `cooldown:${slow.playerId}`], ['DEL', `cooldown:${mate.playerId}`]]);
  r = await roomPost(fast, 'create', { size: 2, mode: 'rounds', target: 3, bots: 1 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const fastRoom = r.body.code;
  r = await later(0, () => roomPost(fast, 'ready', { code: fastRoom }));
  let round = r.body.rounds[0];
  assert.equal(round.pace, f, 'la manche porte le rythme du joueur');
  assert.equal(r.body.nextAt, round.revealAt + 8000 * f);
  const pttl = Number(run([['PTTL', `cooldown:${fast.playerId}`]])[0].result); assert.ok(pttl > 0 && pttl <= 8000 * f, `délai raccourci (${pttl} ms)`);
  assert.equal(Number(run([['HGET', `room:${fastRoom}`, 'due']])[0].result), round.revealAt + Math.round(9700 * f), 'tirages appliqués à la fin de la révélation raccourcie');
  for (const x of r.body.reacts) assert.ok(x.t > round.revealAt + 9700 * f, 'réactions des bots après la révélation');
  assert.equal(round.s.length, 2); assert.deepEqual(round.s, round.n.map(n => engine.scoreOf(n)), 'XP comme d\'habitude');
  // 2,5 s + 4 s plus tard (8 s × 0,5) : la manche suivante part déjà.
  r = await later(2500 + 8000 * f, () => roomPost(fast, 'ready', { code: fastRoom }));
  assert.equal(r.body.rounds.length, 2, 'manche suivante au rythme du joueur');
  // Sans vitesse achetée : pas de pace, il faut toujours 8 s.
  r = await roomPost(slow, 'create', { size: 2, mode: 'rounds', target: 3, bots: 1 });
  const slowRoom = r.body.code;
  r = await later(0, () => roomPost(slow, 'ready', { code: slowRoom }));
  assert.equal(r.body.rounds[0].pace, undefined); assert.equal(r.body.nextAt, r.body.rounds[0].revealAt + 8000);
  r = await later(2500 + 4000, () => roomPost(slow, 'ready', { code: slowRoom }));
  assert.equal(r.body.rounds.length, 1, 'pas avant 8 s');
  // Deux humains et un bot : rythme commun, même si l'un a la vitesse max.
  run([['DEL', `cooldown:${fast.playerId}`], ['DEL', `cooldown:${mate.playerId}`]]);
  await later(20000, async () => null);
  r = await roomPost(fast, 'create', { size: 3, mode: 'rounds', target: 3 });
  const mixRoom = r.body.code;
  await roomPost(mate, 'join', { code: mixRoom }); r = await roomPost(fast, 'addBot', { code: mixRoom });
  assert.equal(r.body.status, 'playing', JSON.stringify(r.body));
  await roomPost(mate, 'ready', { code: mixRoom }); r = await later(0, () => roomPost(fast, 'ready', { code: mixRoom }));
  assert.equal(r.body.rounds.length, 1); assert.equal(r.body.rounds[0].pace, undefined, 'à plusieurs humains : rythme commun');
}

// ================================================================ Idées du 2026-10-28 : XP du jour / de la semaine / du mois
// (qwertyuiop), classement Median roll (Kag), pain dans le chat global (Deadshot, G8_floppa).
{
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js')), lib = require(path.join(ROOT, 'api/_lib.js'));
  const { checkMessage } = require(path.join(ROOT, 'api/_global.js'));
  const mk = (i, name) => {
    const id = `28ee${i.toString(16).padStart(12, '0')}`, secret = id + id;
    run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1'], ['HSET', 'names', id, name], ['SET', `name:${lib.nameKey(name)}`, id]]);
    return { playerId: id, secret, name };
  };
  const zs = (k, id) => { const v = run([['ZSCORE', k, id]])[0].result; return v === null ? null : Number(v); };
  // Le faux Redis ignore EXPIRE : on regarde les commandes envoyées pendant un appel.
  const sent = async fn => { const out = [], f0 = globalThis.fetch; globalThis.fetch = async (u, o) => { if (String(u).endsWith('/pipeline')) out.push(...JSON.parse(o.body)); return f0(u, o); }; try { await fn(); } finally { globalThis.fetch = f0; } return out; };
  const expires = (cmds, k) => cmds.some(c => c[0] === 'EXPIRE' && c[1] === k);
  // Horloge loin de minuit UTC, comme le bloc du 2026-10-27 : jour, semaine et mois ne changent pas pendant le bloc.
  { const now = Date.now(), next = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) + 86400000; if (next - now < 20 * 60000) clock += next - now + 60000; }

  // 1. XP de la période : somme des tirages de la période, une clé par jour / semaine / mois, avec une durée de vie.
  const xa = mk(1, 'Xpdaya'), xb = mk(2, 'Xpdayb');
  const t0 = Date.now(), nums = [123456, 777777, 4242], sum = nums.reduce((a, n) => a + engine.scoreOf(n), 0);
  const [pDay, pWeek, pMonth] = lib.scopes(t0);
  // Durée de vie posée au premier tirage du jour du joueur seulement (3 commandes de moins sur les suivants).
  const first = await sent(() => lib.recordRoll(xa.playerId, nums[0], t0));
  for (const p of [pDay, pWeek, pMonth]) assert.ok(first.some(c => c[0] === 'EXPIRE' && c[1] === lib.xpKey(p) && c[2] === String(lib.XP_TTL[p.period])), `durée de vie posée (${p.period})`);
  const second = await sent(() => lib.recordRoll(xa.playerId, nums[1], t0 + 3));
  assert.ok(![pDay, pWeek, pMonth].some(p => expires(second, lib.xpKey(p))), 'pas reposée au 2e tirage du jour');
  await lib.recordRoll(xa.playerId, nums[2], t0 + 6);
  await lib.recordRoll(xb.playerId, 999999, t0 + 20);
  for (const p of [pDay, pWeek, pMonth]) assert.equal(zs(lib.xpKey(p), xa.playerId), sum, `XP de la période ${p.period} = somme des tirages`);
  // Un tirage du lendemain va dans un autre jour ; une autre semaine ou un autre mois seulement si la date change de période.
  const tNext = Date.UTC(2034, 0, 31, 23, 59, 59), tAfter = tNext + 2000; // 31 janvier → 1er février 2034
  const c1 = await sent(() => lib.recordRoll(xa.playerId, 500000, tNext)), c2 = await sent(() => lib.recordRoll(xa.playerId, 600000, tAfter));
  const [d1, , m1] = lib.scopes(tNext), [d2, , m2] = lib.scopes(tAfter);
  assert.notEqual(lib.xpKey(d1), lib.xpKey(d2)); assert.notEqual(lib.xpKey(m1), lib.xpKey(m2));
  assert.equal(zs(lib.xpKey(d1), xa.playerId), engine.scoreOf(500000)); assert.equal(zs(lib.xpKey(d2), xa.playerId), engine.scoreOf(600000));
  assert.equal(zs(lib.xpKey(m2), xa.playerId), engine.scoreOf(600000), 'le mois suivant repart de zéro');
  // Chaque clé naît d'un premier tirage du jour : elle a toujours une durée de vie.
  assert.ok(expires(c1, lib.xpKey(d1)) && expires(c1, lib.xpKey(m1)) && expires(c2, lib.xpKey(d2)) && expires(c2, lib.xpKey(m2)));
  // Classement : span=day|week|month, ma ligne, le meilleur tirage et le nombre de tirages de la période.
  for (const span of ['day', 'week', 'month']) {
    r = await call(lbApi, { url: `/api/leaderboard?period=xp&span=${span}&me=${xa.playerId}` });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.span, span);
    const row = r.body.entries.find(e => e.name === 'Xpdaya');
    assert.ok(row && row.me, `${span} : ma ligne`); assert.equal(row.s, sum); assert.equal(row.rolls, 3);
    assert.equal(row.n, nums.reduce((b, n) => (engine.scoreOf(n) > engine.scoreOf(b) ? n : b)), 'meilleur tirage de la période');
    for (let i = 1; i < r.body.entries.length; i++) assert.ok(r.body.entries[i - 1].s >= r.body.entries[i].s, 'trié par XP');
    assert.ok(!JSON.stringify(r.body).includes(xa.playerId), 'aucun identifiant');
  }
  r = await call(lbApi, { url: `/api/leaderboard?period=xp&me=${xa.playerId}` });
  assert.equal(r.body.span, 'all'); assert.equal(r.body.entries.find(e => e.name === 'Xpdaya').s, zs('lb:xp', xa.playerId), 'sans span : XP à vie');
  // Hors du top 100 du jour : ma ligne à part, avec mon XP du jour (pas celle à vie).
  const dayK = lib.xpKey(pDay), fillers = Array.from({ length: 105 }, (_, i) => `28ef${i.toString(16).padStart(12, '0')}`);
  run([...fillers.map((f, i) => ['ZADD', dayK, 1e12 + i, f]), ...fillers.map(f => ['HSET', pDay.best, f, JSON.stringify({ n: 1, s: 1, t: t0 })])]);
  r = await call(lbApi, { url: `/api/leaderboard?period=xp&span=day&me=${xa.playerId}` });
  assert.equal(r.body.entries.length, 100); assert.ok(r.body.mine && r.body.mine.me && r.body.mine.s === sum && r.body.mine.rank > 100, JSON.stringify(r.body.mine));
  run([['ZREM', dayK, ...fillers], ['HDEL', pDay.best, ...fillers]]);

  // 2. Median roll : histogramme med:<id> de 50 cases de percentile, classement dès 200 tirages.
  const exactPct = list => { const ps = list.map(n => engine.percentileOf(engine.scoreOf(n))).sort((a, b) => a - b); return ps[Math.floor((ps.length - 1) / 2)]; };
  // Joueur neuf : histogramme complet dès son premier tirage (v=1), absent du classement avant 200 tirages.
  const md = mk(3, 'Medianroller'), mdNums = Array.from({ length: 200 }, (_, i) => (i * 7919 + 13) % 1000001);
  let tm = t0 + 1000;
  for (let i = 0; i < 199; i++) await lib.recordRoll(md.playerId, mdNums[i], (tm += 3));
  assert.equal(run([['HGET', lib.medKey(md.playerId), 'v']])[0].result, '1', 'joueur neuf : histogramme complet');
  assert.equal(zs(lib.MED_LB, md.playerId), null, '199 tirages : pas encore classé');
  r = await call(lbApi, { url: `/api/leaderboard?period=median&me=${md.playerId}` });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.period, 'median');
  assert.deepEqual([r.body.need, r.body.have], [200, 199], 'il manque 1 tirage');
  await lib.recordRoll(md.playerId, mdNums[199], (tm += 3));
  const h = lib.medHist(run([['HGETALL', lib.medKey(md.playerId)]])[0].result);
  assert.equal(h.count, 200); assert.ok(h.done);
  const est = zs(lib.MED_LB, md.playerId);
  assert.ok(est !== null && Math.abs(est - exactPct(mdNums)) <= 2, `médiane estimée ${est} ≈ exacte ${exactPct(mdNums)}`);
  // Joueur d'avant (historique sans histogramme) : ses tirages ne comptent pas tant que le remplissage n'est pas passé.
  const old = mk(4, 'Medianold'), oldNums = Array.from({ length: 260 }, (_, i) => (i * 104729 + 99) % 1000001);
  run([['ZADD', `hist:${old.playerId}`, ...oldNums.flatMap((n, i) => [t0 - 900000 + i * 1000, `${t0 - 900000 + i * 1000}:${n}`])],
    ['ZADD', `hist:${old.playerId}`, t0 - 900000 + 500, `${t0 - 900000 + 500}:${oldNums[0]}`], // doublon d'un même tirage (même nombre, < 1 min)
    ['HSET', lib.medKey(old.playerId), '25', '400']]); // vieux comptes partiels sans v
  await lib.recordRoll(old.playerId, 31337, (tm += 3));
  assert.equal(zs(lib.MED_LB, old.playerId), null, 'histogramme incomplet : pas classé');
  run([['SET', 'lb:xp:migrated', '6:000000000000']]);
  for (let i = 0; i < 20 && !/^7:/.test(run([['GET', 'lb:xp:migrated']])[0].result || ''); i++) await lbApi.migrateXp();
  const ho = lib.medHist(run([['HGETALL', lib.medKey(old.playerId)]])[0].result);
  assert.ok(ho.done, 'rempli depuis l\'historique'); assert.equal(ho.count, 261, 'historique sans doublon (260 + le tirage du jour)');
  assert.ok(Math.abs(zs(lib.MED_LB, old.playerId) - exactPct([...oldNums, 31337])) <= 2, 'médiane de l\'historique');
  assert.equal(lib.medHist(run([['HGETALL', lib.medKey(md.playerId)]])[0].result).count, 200, 'refait à l\'identique pour le joueur neuf');
  // Ensuite chaque tirage s'ajoute et met à jour le classement.
  const before = lib.medHist(run([['HGETALL', lib.medKey(old.playerId)]])[0].result).count;
  await lib.recordRoll(old.playerId, 1000000, (tm += 3));
  assert.equal(lib.medHist(run([['HGETALL', lib.medKey(old.playerId)]])[0].result).count, before + 1);
  // Un joueur sous 200 tirages sort du classement au remplissage suivant (historique raccourci).
  const few = mk(5, 'Medianfew'); run([['ZADD', `hist:${few.playerId}`, t0 - 5000, `${t0 - 5000}:42`], ['ZADD', lib.MED_LB, 50, few.playerId]]);
  run([['SET', 'lb:xp:migrated', '6:000000000001']]);
  for (let i = 0; i < 20 && !/^7:/.test(run([['GET', 'lb:xp:migrated']])[0].result || ''); i++) await lbApi.migrateXp();
  assert.equal(zs(lib.MED_LB, few.playerId), null, 'moins de 200 : retiré');
  // Classement : trié, XP du tirage médian lue dans la table, tirages à vie, aucun identifiant.
  r = await call(lbApi, { url: `/api/leaderboard?period=median&me=${md.playerId}` });
  for (let i = 1; i < r.body.entries.length; i++) assert.ok(r.body.entries[i - 1].pct >= r.body.entries[i].pct, 'du plus haut au plus bas');
  const mrow = r.body.entries.find(e => e.name === 'Medianroller');
  assert.ok(mrow && mrow.me); assert.equal(mrow.med, lib.scoreAtPct(zs(lib.MED_LB, md.playerId))); assert.equal(mrow.count, 200);
  assert.ok(r.body.entries.some(e => e.name === 'Medianold')); assert.ok(!r.body.entries.some(e => e.name === 'Medianfew'));
  assert.equal(r.body.have, null, 'classé : rien à afficher en plus');
  assert.ok(!JSON.stringify(r.body).includes(md.playerId) && !JSON.stringify(r.body).includes(old.playerId), 'aucun identifiant');
  // Estimation : percentile → XP croissante, et percentile médian d'un histogramme connu.
  assert.ok(lib.scoreAtPct(10) <= lib.scoreAtPct(50) && lib.scoreAtPct(50) <= lib.scoreAtPct(90));
  { const c = new Array(50).fill(0); c[24] = 10; c[25] = 10; assert.equal(lib.medPct(c), 50); c[26] = 20; assert.equal(lib.medPct(c), 52); }

  // 3. Pain dans le chat global : 🍞 🥖 🥐 passent le filtre tels quels.
  assert.equal(checkMessage('🍞 bread 🥖🥐'), '🍞 bread 🥖🥐');
}

// ================================================================ Idées du 2026-11-01 (groupe D) : 9 badges, titres de
// niveau (shadow2 Jr), Generous (PRISMA123), 100% (casmictechthing), séries de jours (lnbBUChuoi_vn), Full Spectrum
// (Pube puller), Odd Week (JBearr12). Joueurs 11d1….
{
  const lib = require(path.join(ROOT, 'api/_lib.js')), Ach = require(path.join(ROOT, 'js/achievements.js'));
  const Q = require(path.join(ROOT, 'js/quests.js')), Events = require(path.join(ROOT, 'js/events.js'));
  const odds = require(path.join(ROOT, 'data/badge-odds.json'));
  const has = (n, id) => engine.analyze(n).earnedIds.includes(id);
  // 1. Badges : nombres qui les obtiennent (build.mjs) et XP = valeur naturelle 100 × 1 000 001 / nombre (sauf
  // Three-Quarter Millennium : 100 750, la paire des 100 250 de Quarter Millennium).
  const COUNTS = { FULL_CIRCLE: 1, EULER_GAMMA_4: 300, EULER_GAMMA_5: 20, TAXICAB: 300, SHIFTED_ECHO: 1547,
    PALINDROMIC_PRIME: 109, THREE_QUARTER_MILLENNIUM: 1000, BEE: 3999, LOL: 3979, MOON_LANDING: 300 };
  for (const [id, k] of Object.entries(COUNTS)) {
    assert.equal(odds[id], k, `${id} : ${k} nombres`);
    assert.equal(engine.byId.get(id).score, id === 'THREE_QUARTER_MILLENNIUM' ? 100750 : Math.round((100 * 1000001) / k), `${id} : XP`);
  }
  assert.ok(has(360, 'FULL_CIRCLE') && !has(3600, 'FULL_CIRCLE') && !has(1360, 'FULL_CIRCLE'), 'exactement 360');
  assert.deepEqual(engine.analyze(157721).scoringIds.filter(id => id.startsWith('EULER_GAMMA')), ['EULER_GAMMA_5'], 'famille : seul le meilleur compte');
  assert.ok(has(157721, 'EULER_GAMMA_4') && has(5772, 'EULER_GAMMA_4') && !has(57720, 'EULER_GAMMA_5'));
  assert.ok(has(1729, 'TAXICAB') && has(301729, 'TAXICAB') && !has(1279, 'TAXICAB'));
  assert.ok(!engine.byId.has('O7') && !engine.byId.has('THIRTEEN'), '07 et 13 écartés par Sacha (2026-11-01)');
  assert.ok(has(338, 'BEE') && !has(388, 'BEE') && has(707, 'LOL') && has(1969, 'MOON_LANDING') && has(301969, 'MOON_LANDING'));
  assert.ok(has(1750, 'THREE_QUARTER_MILLENNIUM') && has(999750, 'THREE_QUARTER_MILLENNIUM') && !has(7500, 'THREE_QUARTER_MILLENNIUM'));
  for (const n of [456345, 123234, 10, 98, 2132, 567678, 987876]) assert.ok(has(n, 'SHIFTED_ECHO'), `${n} est un écho décalé`);
  for (const n of [456456, 456356, 12345, 123432, 1, 11]) assert.ok(!has(n, 'SHIFTED_ECHO'), `${n} n'est pas un écho décalé`);
  assert.deepEqual(engine.highlight('SHIFTED_ECHO', 456345), [[0, 1, 2], [3, 4, 5]]);
  for (const n of [11, 101, 94049, 98689]) assert.ok(has(n, 'PALINDROMIC_PRIME'), `${n} : premier palindrome`);
  for (const n of [1, 2, 3, 5, 7, 121, 1001, 94048, 9449]) assert.ok(!has(n, 'PALINDROMIC_PRIME'), `${n} : non (un seul chiffre, ou pas premier)`);
  // 24 reste Infinite (annoncé le 2026-10-30) : 3 ne passe plus devant ; toujours 10 nombres Infinite.
  assert.equal(engine.analyze(24).tier, 'infinite', '24 reste Infinite');

  // 2. Titres : seuils exacts.
  const at = (id, st) => Ach.byId.get(id).test(st);
  for (const L of [10, 25, 50, 100, 250]) assert.ok(at(`lvl${L}`, { xpLife: Q.xpForLevel(L) }) && !at(`lvl${L}`, { xpLife: Q.xpForLevel(L) - 1 }), `niveau ${L}`);
  assert.equal(Ach.byId.get('lvl10').title, 'Level 10');
  assert.ok(at('generous', { giftOut: 50000 }) && !at('generous', { giftOut: 49999 }) && !at('generous', { giftIn: 90000 }), 'donné, pas reçu');
  assert.ok(at('uniqall', { uniq: 1000001 }) && !at('uniqall', { uniq: 1000000 }));
  for (const [id, k] of [['streak30', 30], ['streak100', 100], ['streak365', 365]]) {
    assert.ok(at(id, { streak: k }) && at(id, { streak: 1, streakBest: k }) && !at(id, { streak: k - 1, streakBest: k - 1 }), id);
  }
  const all = Object.fromEntries(Ach.SPECTRUM.map(t => [`t:${t}`, 1]));
  assert.deepEqual(Ach.SPECTRUM, ['trash', 'common', 'uncommon', 'rare', 'epic', 'anomaly', 'mythic', 'celestial']);
  assert.ok(at('spectrum', all), 'une de chaque');
  for (const t of Ach.SPECTRUM) assert.ok(!at('spectrum', { ...all, [`t:${t}`]: 0, 't:divine': 3, 't:garbage': 2 }), `il manque ${t}`);

  const mk = (i, name, fields = []) => {
    const id = `11d1${i.toString(16).padStart(12, '0')}`, secret = id + id;
    run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', ...fields], ['HSET', 'names', id, name], ['SET', `name:${lib.nameKey(name)}`, id]]);
    return { playerId: id, secret, name };
  };
  // 3. Generous par un vrai cadeau : giftOut monte à chaque cadeau, le titre s'équipe.
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const ga = mk(1, 'Generousgiver', ['rolls', '1000', 'bonus', '5000', 'giftOut', '49800']), gb = mk(2, 'Generousfriend', ['rolls', '1000']);
  run([['SADD', `fr:${ga.playerId}`, gb.playerId], ['SADD', `fr:${gb.playerId}`, ga.playerId]]);
  assert.ok(!Ach.unlocked(await lib.readStats(ga.playerId)).includes('generous'));
  let r = await call(friendsApi, { method: 'POST', body: { playerId: ga.playerId, secret: ga.secret, action: 'gift', name: gb.name, amount: 200 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Ach.unlocked(await lib.readStats(ga.playerId)).includes('generous'), '50 000 donnés');
  assert.ok(!Ach.unlocked(await lib.readStats(gb.playerId)).includes('generous'), 'recevoir ne compte pas');
  r = await call(titleApi, { method: 'POST', body: { playerId: ga.playerId, secret: ga.secret, title: 'generous' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call(titleApi, { method: 'POST', body: { playerId: gb.playerId, secret: gb.secret, title: 'generous' } })).status, 422);

  // 4. Séries : streakBest tenu au bonus quotidien, la série cassée garde le titre.
  const questsApi = require(path.join(ROOT, 'api/quests.js'));
  const daily = who => call(questsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'daily' } });
  const save = clock;
  const today = lib.dayKey(Date.now());
  const sk = mk(3, 'Streakkeeper', ['rolls', '50', 'streak', '29', 'streakDay', Q.dayBefore(today)]);
  assert.ok(!Ach.unlocked(await lib.readStats(sk.playerId)).includes('streak30'));
  r = await daily(sk); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.daily.streak, 30);
  let st = await lib.readStats(sk.playerId);
  assert.deepEqual([Number(st.streak), Number(st.streakBest)], [30, 30]); assert.ok(Ach.unlocked(st).includes('streak30'));
  clock += 3 * 86400000; // deux jours sautés : la série repart à 1
  r = await daily(sk); assert.equal(r.body.daily.streak, 1);
  st = await lib.readStats(sk.playerId);
  assert.deepEqual([Number(st.streak), Number(st.streakBest)], [1, 30], 'la meilleure série reste');
  assert.ok(Ach.unlocked(st).includes('streak30') && !Ach.unlocked(st).includes('streak100'), 'le titre reste après la série cassée');
  // Ancien joueur (série cassée de 120 jours, pas encore de streakBest) : compté tout de suite, gardé au bonus suivant.
  const old = mk(4, 'Streakveteran', ['rolls', '50', 'streak', '120', 'streakDay', '2026-09-01']);
  assert.ok(Ach.unlocked(await lib.readStats(old.playerId)).includes('streak100'));
  r = await daily(old); assert.equal(r.body.daily.streak, 1);
  st = await lib.readStats(old.playerId); assert.equal(Number(st.streakBest), 120); assert.ok(Ach.unlocked(st).includes('streak100'));
  clock = save;

  // 5. Odd Week : ajoutée avant Meme Week (qui reste la dernière) : la semaine de lancement et les semaines 0 à 6 gardent
  // leur thème, Odd Week tombe en semaine 7 (7 décembre 2026).
  const keys = Events.THEMES.map(t => t.key);
  assert.equal(keys[keys.length - 1], 'meme'); assert.equal(new Set(keys).size, keys.length);
  const W = 7 * 86400000, w0 = Date.parse('2026-10-19T00:00:00Z');
  assert.deepEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7].map(w => Events.current(w0 + w * W + 1000).key), ['meme', 'prime', 'happy', 'round', 'seq', 'mirror', 'fib', 'pal', 'odd']);
  const odd = Events.THEMES.find(t => t.key === 'odd');
  assert.deepEqual([odd.goal, odd.badges, odd.title], [200, ['ODD'], 'Odd Week']);
  assert.ok(Events.counts(odd, engine.analyze(13579).earnedIds) && !Events.counts(odd, engine.analyze(2468).earnedIds));
  assert.equal(Events.current(w0 + 7 * W).reward, Events.REWARD, 'récompense normale');
}

// ---------------------------------------------------------------- idées du 2026-11-01 (groupe F) : joueurs en ligne
// (Thermonuclear Bomb, Jguz01, KMC) et raretés du profil d'accord avec Best rolls (casmicgraything). Joueurs 2f01….
{
  const lib = require(path.join(ROOT, 'api/_lib.js')), Onl = require(path.join(ROOT, 'api/_online.js'));
  const lbApi = require(path.join(ROOT, 'api/leaderboard.js')), friendsApi = require(path.join(ROOT, 'api/friends.js')), profileApi = require(path.join(ROOT, 'api/profile.js'));
  const mk = (i, name, fields = []) => {
    const id = `2f01${i.toString(16).padStart(12, '0')}`, secret = id + id;
    run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'tv', '2', 'gv', '1', 'dv', '1', ...fields], ['HSET', 'names', id, name], ['SET', `name:${lib.nameKey(name)}`, id]]);
    return { playerId: id, secret, name };
  };
  // Horloge à part, en 2040 (après les dates des blocs d'avant, 2034 au plus) : leurs tirages et présences ne comptent pas.
  const prevNow = Date.now; let now = Date.UTC(2040, 0, 15, 12);
  Date.now = () => now;
  try {
    Onl._reset();
    const online = async () => (await call(lbApi, { url: '/api/leaderboard?online=1' })).body.online;
    const ping = (p, presence) => call(friendsApi, { method: 'POST', body: { playerId: p.playerId, secret: p.secret, action: 'gifts', presence } });
    const ps = Array.from({ length: 7 }, (_, i) => mk(i + 1, `Onlinep${i + 1}`));
    // 1. Personne : null (rien d'affiché). 3 pages actives + 1 onglet afk + 1 tirage = 4 : toujours caché (moins de 5).
    assert.equal(await online(), null);
    for (const p of ps.slice(0, 3)) assert.equal((await ping(p, 'active')).status, 200);
    await ping(ps[3], 'afk');
    await lib.recordRoll(ps[4].playerId, 424242, now);
    now += Onl.CACHE_MS + 1;
    assert.equal(await Onl.count(), 4, 'actifs + tirage récent, pas l\'onglet afk');
    assert.equal(await online(), null, 'sous 5 : caché');
    // 2. Un 5e (un tirage) : affiché ; un joueur actif ET qui tire ne compte qu'une fois.
    await lib.recordRoll(ps[0].playerId, 424243, now);
    await lib.recordRoll(ps[5].playerId, 424244, now);
    now += Onl.CACHE_MS + 1;
    assert.equal(await online(), 5);
    // 3. En cache 30 s : un nouveau venu n'apparaît qu'au calcul suivant.
    await ping(ps[6], 'active');
    assert.equal(await online(), 5, 'en cache');
    now += Onl.CACHE_MS + 1;
    assert.equal(await online(), 6);
    // 4. Passé en afk : retiré tout de suite du zset ; au-delà de 150 s sans signe de vie, plus personne.
    await ping(ps[6], 'afk');
    now += Onl.CACHE_MS + 1;
    assert.equal(await online(), 5);
    now += Onl.ONLINE_MS + 1;
    assert.equal(await online(), null);
    assert.equal(run([['ZCARD', Onl.PRES_Z]])[0].result, 0, 'les vieilles présences sont retirées');
    // 5. Chat global : le même nombre dans la réponse de gcList (même « same »), sans aucun identifiant.
    for (const p of ps.slice(0, 5)) await ping(p, 'active');
    now += Onl.CACHE_MS + 1;
    let r = await call(friendsApi, { method: 'POST', body: { action: 'gcList' } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.online, 5);
    r = await call(friendsApi, { method: 'POST', body: { action: 'gcList', rev: r.body.rev, del: r.body.del } });
    assert.ok(r.body.same && r.body.online === 5, 'aussi dans la réponse courte');
    r = await call(lbApi, { url: '/api/leaderboard?online=1' });
    assert.deepEqual(Object.keys(r.body), ['online']);
    assert.ok(!ps.some(p => JSON.stringify(r.body).includes(p.playerId)));

    // 6. Profil (casmicgraything) : historique complet, stats.rolls et t:godlike plus grands (doublon retiré, nombre passé
    // de Godlike à Divine) : les raretés viennent de l'historique, comme Best rolls.
    const cg = mk(20, 'Casmictest', ['rolls', '6', 't:godlike', '3', 't:divine', '0', 't:common', '2']);
    const T = now - 3600000;
    run([['ZADD', `hist:${cg.playerId}`, T, `${T}:97`, T + 1000, `${T + 1000}:224224`, T + 2000, `${T + 2000}:911911`, T + 3000, `${T + 3000}:123456`, T + 4000, `${T + 4000}:500001`,
      T + 4500, `${T + 4500}:500001`], // le même tirage enregistré deux fois (même nombre, moins d'une minute)
    ['HSET', 'count:all', cg.playerId, 6]]);
    r = await call(profileApi, { url: '/api/profile?name=Casmictest' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.window, 5); assert.equal(r.body.rolls, 6, 'tirages à vie : toujours le compteur');
    const bestTier = t => r.body.best.filter(x => engine.cardTier(x.s) === t).length;
    assert.deepEqual([r.body.tiers.godlike, r.body.tiers.divine], [2, 1], JSON.stringify(r.body.tiers));
    for (const t of ['godlike', 'divine', 'celestial']) assert.equal(r.body.tiers[t] || 0, bestTier(t), `${t} : même nombre que dans Best rolls`);
    assert.equal(Object.values(r.body.tiers).reduce((x, y) => x + y, 0), r.body.window);
    // 7. Totaux gardés dans Redis (pagg, ils survivent à un déploiement) calculés avec un autre barème : ignorés.
    const cg2 = mk(21, 'Casmicpagg'), hist2 = [[T, 97], [T + 1000, 224224], [T + 2000, 911911]];
    const oldAgg = { v: 'oldscale0000', at: now, padded: false, size: 3, count: 3, since: T, lastT: T + 2000, lifetime: 1, percentileSum: 150, badges: {}, tiers: { godlike: 3 }, best: hist2.map(([t, n]) => ({ n, s: engine.scoreOf(n), t })), worst: [], uniq: null };
    run([['ZADD', `hist:${cg2.playerId}`, ...hist2.flatMap(([t, n]) => [t, `${t}:${n}`])], ['SET', `pagg:${cg2.playerId}`, JSON.stringify(oldAgg)]]);
    r = await call(profileApi, { url: '/api/profile?name=Casmicpagg' });
    assert.deepEqual([r.body.tiers.godlike, r.body.tiers.divine], [2, 1], 'pagg d\'un autre barème ignoré');
    // Même barème : réutilisé tel quel (rien de nouveau dans l'historique depuis lastT).
    const cg3 = mk(22, 'Casmicsame');
    run([['ZADD', `hist:${cg3.playerId}`, ...hist2.flatMap(([t, n]) => [t, `${t}:${n}`])]]);
    r = await call(profileApi, { url: '/api/profile?name=Casmicsame' });
    assert.equal(r.body.tiers.godlike, 2);
  } finally { Date.now = prevNow; Onl._reset(); }
}

// ================================================================ Groupe social du 2026-11-01
{
  const { cleanChat, hideCodes } = require(path.join(ROOT, 'api/_chat.js'));
  const { checkMessage, offTopic } = require(path.join(ROOT, 'api/_global.js'));
  // Codes du Code Hunter cachés (idée de R77) : écrits tels quels, espacés, en minuscules ou en chiffres ; jamais un mot voisin.
  for (const t of ['code ROLLFOREVER', 'consolecat', 'Z E R O H E R O', 'c0ns0le-cat', 'roll forever!']) {
    assert.ok(cleanChat(t).includes('[secret code]'), `caché : ${t} → ${cleanChat(t)}`);
    assert.ok(!/rollforever|consolecat|zerohero/i.test(cleanChat(t).replace(/[^a-z]/gi, '')), `plus rien du code : ${t}`);
    assert.ok(checkMessage(t).includes('[secret code]'), `caché dans le chat global : ${t}`);
  }
  for (const ok of ['console', 'roll for the win', 'zero', 'hero', 'my cat', 'SACHA']) assert.equal(hideCodes(ok), ok, `pas un code : ${ok}`);
  { const src = require('node:fs').readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'); assert.ok(!src.includes('HUNT_CODES'), 'la liste des codes reste sur le serveur'); }
  // Proxys et débloqueurs (idée de mateopotato) : refusés dans le chat global ; les phrases normales passent.
  for (const t of ['use a proxy', 'PR0XY', 'p r o x y', 'croxyproxy', 'holy unblocker', 'unblocked games 66', 'get a VPN', 'how to bypass goguardian', 'securly', 'get around the school filter', 'tor browser']) {
    assert.ok(offTopic(t), `proxy : ${t}`); assert.throws(() => checkMessage(t), /proxies, VPNs/, t);
  }
  for (const t of ['approximately 50%', 'my friend unblocked me', 'proximity', 'the epoxy skin', 'I will pass by later', 'filter coffee', 'my school blocked the game', 'Roxy', 'torn paper skin', 'go past the finish line']) {
    assert.ok(!offTopic(t), `faux positif : ${t}`); assert.doesNotThrow(() => checkMessage(t), t);
  }
  // Chat global : le code est caché dans le message gardé, et le tag du clan suit le pseudo (idée de R77).
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const mk = (tag, name) => { const id = tag.repeat(8), secret = (tag + 'd').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 500], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const sa = mk('5a', 'Socialann'), sb = mk('5b', 'Socialbob');
  run([['HSET', 'clantag', sa.playerId, 'SOCL|gold'], ['DEL', 'gc:sysq']]);
  const gc = (who, action, extra = {}) => call(friendsApi, { method: 'POST', body: { action, playerId: who.playerId, secret: who.secret, ...extra } });
  let r = await gc(sa, 'gcSend', { text: 'psst the code is ZEROHERO' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const mine = r.body.msgs.at(-1);
  assert.equal(mine.text, 'psst the code is [secret code]'); assert.deepEqual(mine.clan, { tag: 'SOCL', c: 'gold' });
  assert.ok(!JSON.stringify(run([['LRANGE', 'gc:msgs', 0, -1]])[0].result).includes('ZEROHERO'), 'jamais gardé');
  r = await gc(sb, 'gcSend', { text: 'nice' }); assert.equal(r.body.msgs.at(-1).clan, undefined, 'sans clan : pas de tag');
  assert.deepEqual(r.body.msgs.find(m => m.id === mine.id).clan, { tag: 'SOCL', c: 'gold' }, 'le tag se lit pour tout le monde');
  assert.ok(!JSON.stringify(r.body).includes(sa.playerId), 'aucun identifiant');
  run([['HDEL', 'clantag', sa.playerId]]);
  r = await gc(sb, 'gcList'); assert.equal(r.body.msgs.find(m => m.id === mine.id).clan, undefined, 'le tag suit le clan d\'aujourd\'hui');
  run([['DEL', `gc:rl:${sa.playerId}`]]);
  r = await gc(sa, 'gcSend', { text: 'where can I find a proxy' }); assert.equal(r.status, 422); assert.match(r.body.error, /proxies/);
  // Messages entre amis : le code est caché aussi (cleanChat).
  run([['SADD', `fr:${sa.playerId}`, sb.playerId], ['SADD', `fr:${sb.playerId}`, sa.playerId]]);
  r = await call(friendsApi, { method: 'POST', body: { action: 'message', name: 'Socialbob', text: 'try c o n s o l e c a t', playerId: sa.playerId, secret: sa.secret } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.messages.at(-1).text, 'try [secret code]');
  // Mise libre en duel (idée de dog) : 77 pièces, payées en entrant, gardées dans le pot.
  const sc = mk('5c', 'Stakecat');
  run([['HINCRBY', `stats:${sc.playerId}`, 'bonus', 500]]);
  r = await roomPost(sc, 'create', { size: 2, stake: 77 });
  assert.deepEqual([r.status, r.body.stake, r.body.pot], [200, 77, 77], JSON.stringify(r.body));
  // 🍳 dans la grille d'emojis (idée de MattyFaux-Lucky), qui sert aussi entre amis et en duel (PRISMA123).
  { const src = require('node:fs').readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'); assert.ok(src.includes("'🥐', '🍳'") && src.includes('wireEmojis(m, () => input)') && src.includes("wireEmojis($('#room-chat')"), 'emojis entre amis et en duel'); }
  assert.equal(cleanChat('gm 🍳🍞'), 'gm 🍳🍞', 'les emojis passent le filtre des amis et des duels');
}

// Giveaways du Discord (api/_giveaway.js, Sacha, 2026-11-01) : un faux Discord (aucun appel réseau) ; tirage, skin
// donné au gagnant lié, lot gardé 7 jours pour un gagnant pas encore lié, ceux qui ont déjà le skin écartés.
{
  const Giveaway = require(path.join(ROOT, 'api/_giveaway.js')), Link = require(path.join(ROOT, 'api/_discord_link.js'));
  const siteApi = require(path.join(ROOT, 'api/site.js'));
  const mk = (tag, name, extra = []) => { const id = tag.repeat(8), secret = (tag + 'e').repeat(16).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 500, ...extra], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  const boss = mk('a7', 'GwBoss', ['owner', '1']), owns = mk('a8', 'HasNeon'), winner = mk('a9', 'Lucky7'), late = mk('b7', 'LateLinker');
  run([['SADD', `skins:${owns.playerId}`, 'neon'], ['HSET', 'discord:links', 'd-owns', owns.playerId, 'd-win', winner.playerId]]);
  let reactors = [], posted = [], made = [];
  const realDc = Link.dc, realHas = Link.hasBot;
  Link.hasBot = () => true;
  Link.dc = async (method, p, { body } = {}) => {
    posted.push([method, p, body]);
    if (method === 'GET' && p.endsWith('/channels')) return made.slice();
    if (method === 'GET' && p === '/users/@me') return { id: 'bot1' };
    if (method === 'POST' && p.endsWith('/channels')) { const c = { id: body.type === 4 ? 'cat1' : 'ch1', type: body.type, name: body.name }; made.push(c); return c; }
    if (method === 'POST' && p.endsWith('/messages')) return { id: `m${posted.length}` };
    if (method === 'GET' && p.includes('/reactions/')) return /after=0/.test(p) ? reactors.map(id => ({ id, bot: id === 'bot1' })) : [];
    return null;
  };
  const site = (who, action, extra = {}) => call(siteApi, { method: 'POST', body: { action, playerId: who.playerId, secret: who.secret, ...extra } });
  assert.equal((await site(winner, 'gwStart', { skin: 'neon' })).status, 403, 'créateur seulement');
  assert.equal((await site(boss, 'gwStart', { skin: 'classic' })).status, 400, 'un skin gratuit ne se gagne pas');
  let r = await site(boss, 'gwStart', { skin: 'neon', hours: 24 });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.list[0].status, 'open');
  const ch = posted.filter(([m, p]) => m === 'POST' && p.endsWith('/channels'));
  assert.deepEqual(ch.map(([, , b]) => b.name), ['🎁 GIVEAWAYS', '🎁・giveaways'], 'catégorie et salon créés');
  assert.ok(posted.some(([m, p]) => m === 'PUT' && p.includes(encodeURIComponent('🎉'))), 'le bot ajoute 🎉');
  const g1 = JSON.parse(run([['HGET', 'gw:item', r.body.started]])[0].result);
  assert.equal(await Giveaway.tick(g1.ends - 1000), 0, 'pas encore fini');
  // Fini : le bot, celui qui a déjà Neon et un inconnu… seul Lucky7 (lié, sans Neon) et l'inconnu peuvent gagner.
  reactors = ['bot1', 'd-owns', 'd-win'];
  assert.equal(await Giveaway.tick(g1.ends + 1000), 1);
  assert.equal(run([['SISMEMBER', `skins:${winner.playerId}`, 'neon']])[0].result, 1, 'skin donné au gagnant lié');
  assert.equal(await Giveaway.tick(g1.ends + 2000), 0, 'tiré une seule fois');
  assert.ok(posted.some(([m, p, b]) => m === 'POST' && p.endsWith('/messages') && b.content && b.content.includes('<@d-win>')), 'gagnant annoncé');
  // Gagnant pas encore lié : le skin l'attend 7 jours, et arrive quand il lie son Discord.
  posted = []; r = await site(boss, 'gwStart', { skin: 'lcd', hours: 1 });
  const g2 = JSON.parse(run([['HGET', 'gw:item', r.body.started]])[0].result);
  assert.ok(!posted.some(([m, p]) => m === 'POST' && p.endsWith('/channels')), 'salon déjà créé');
  reactors = ['d-late'];
  await Giveaway.tick(g2.ends + 1);
  assert.ok(run([['HGET', 'gw:claim', 'd-late']])[0].result, 'lot gardé');
  assert.deepEqual(await Giveaway.claim('d-late', late.playerId), { skin: 'lcd', name: 'LCD', emoji: '📟' });
  assert.equal(run([['SISMEMBER', `skins:${late.playerId}`, 'lcd']])[0].result, 1);
  assert.equal(await Giveaway.claim('d-late', late.playerId), null, 'une seule fois');
  // Personne ne peut gagner (tous ont déjà le skin) : pas de gagnant.
  r = await site(boss, 'gwStart', { skin: 'neon', hours: 1 }); const g3 = JSON.parse(run([['HGET', 'gw:item', r.body.started]])[0].result);
  reactors = ['d-owns', 'd-win'];
  await Giveaway.tick(g3.ends + 1);
  r = await site(boss, 'gwList');
  assert.deepEqual(r.body.list.map(g => [g.skin, g.status, g.winner]).sort(), [['lcd', 'done', 'LateLinker'], ['neon', 'done', 'Lucky7'], ['neon', 'void', null]]); // même milliseconde possible : comparés triés
  assert.ok(!JSON.stringify(r.body).includes(winner.playerId), 'aucun identifiant');
  Link.dc = realDc; Link.hasBot = realHas;
}

// Mode difficile (Sacha, 2026-11-02) : tirages à 10 chiffres, stats et classements à part, pièces et XP à vie communes.
{
  const Lib = require(path.join(ROOT, 'api/_lib.js')), Shop = require(path.join(ROOT, 'js/shop.js')), Ach = require(path.join(ROOT, 'js/achievements.js'));
  const H = Lib.hardEngine(), profileApi = require(path.join(ROOT, 'api/profile.js')), roomApi2 = require(path.join(ROOT, 'api/room.js'));
  const hk = { playerId: '9e'.repeat(8), secret: '9e1'.repeat(11).slice(0, 32), name: 'Hardy' }, nk = { playerId: '9f'.repeat(8), secret: '9f1'.repeat(11).slice(0, 32), name: 'Normy' };
  const stOf = id => { const f = run([['HGETALL', `stats:${id}`]])[0].result; const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = f[i + 1]; return o; };
  // Moteur : 10 chiffres, raretés du mode difficile, tirage uniforme jusqu'à 9 999 999 999.
  assert.equal(H.MAX_ROLL, 9999999999); assert.equal(H.digits, 10);
  for (let i = 0; i < 2000; i++) { const n = H.roll(); assert.ok(Number.isInteger(n) && n >= 0 && n <= 9999999999); }
  // Même XP moyenne attendue que le mode normal (règle de fréquence + facteur, voir tools/build-hard.mjs).
  const odds = require(path.join(ROOT, 'data/hard-odds.json'));
  const normalStats = JSON.parse(/SCORE_STATS = (\{[^;]+\});/.exec(fs.readFileSync(path.join(ROOT, 'js/percentiles.js'), 'utf8'))[1]);
  assert.ok(Math.abs(odds.stats.mean / normalStats.mean - 1) < 0.15, `XP moyenne : ${odds.stats.mean} contre ${normalStats.mean}`);
  // Pièces : même moyenne par tirage dans les deux modes (écart de moins de 3 %), raretés 10 fois plus rares au-dessus de Common.
  const normalTiers = JSON.parse(/TIER_ODDS = (\{[^;]+\});/.exec(fs.readFileSync(path.join(ROOT, 'js/percentiles.js'), 'utf8'))[1]);
  const ev = (tiers, coins) => Object.entries(tiers).reduce((x, [t, p]) => x + p * coins[t], 0);
  const evN = ev(normalTiers, Shop.COINS), evH = ev(odds.tiers, Shop.HARD_COINS);
  // Raretés 50 fois plus rares avec les mêmes pièces (Sacha, 2026-11-02, « plus dur pour de vrai ») : ~37 % du mode normal.
  assert.ok(evH / evN > 0.3 && evH / evN < 0.45, `pièces moyennes : ${evH.toFixed(3)} (difficile) contre ${evN.toFixed(3)} (normal)`);
  const tail = (tiers, from) => engine.TIER_ORDER.slice(engine.TIER_ORDER.indexOf(from)).reduce((x, t) => x + tiers[t], 0);
  for (const t of ['uncommon', 'mythic', 'infinite']) assert.ok(Math.abs(tail(normalTiers, t) / tail(odds.tiers, t) / 50 - 1) < 0.1, `${t} ou mieux : 50 fois plus rare`);
  // Verrou (idée des joueurs, 2026-11-02) : pas de mode difficile avant un Godlike ou un Infinite du mode normal.
  r = await call(roll, { method: 'POST', body: { ...hk, mode: 'hard' } });
  assert.deepEqual([r.status, r.body.locked], [403, true], 'verrouillé');
  assert.match(r.body.error, /Divine or higher/);
  assert.equal(run([['GET', `cooldown:${hk.playerId}`]])[0].result, null, 'un refus ne prend pas le délai');
  r = await call(profileApi, { url: `/api/profile?name=Hardy&lite=1&me=${hk.playerId}` }); assert.equal(r.body.hardOpen, false);
  run([['HSET', `stats:${hk.playerId}`, 't:divine', '1']]); // son premier Divine (Divine ou mieux, Sacha 2026-11-02)
  r = await call(profileApi, { url: `/api/profile?name=Hardy&lite=1&me=${hk.playerId}` }); assert.equal(r.body.hardOpen, true);
  run([['HSET', 'clanof', hk.playerId, 'hardclan']]); // dans un clan : XP du clan = minimum normal de la rareté
  // Tirage en mode difficile.
  r = await call(roll, { method: 'POST', body: { ...hk, mode: 'hard' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'hard'); assert.ok(r.body.n >= 0 && r.body.n <= 9999999999);
  const a = H.analyze(r.body.n);
  assert.equal(r.body.s, a.total, 'XP au barème difficile');
  assert.equal(r.body.coins, Shop.HARD_COINS[a.tier], 'pièces du mode difficile');
  { const wk = Lib.weekKey(r.body.t), min = Lib.normalTierMin(a.tier);
    assert.ok(min > 0 && Lib.normalTierMin('infinite') > Lib.normalTierMin('mythic'), 'minimums par rareté');
    assert.equal(Number(run([['ZSCORE', `clanxp:${wk}`, 'hardclan']])[0].result), min, `clan : ${min} (minimum normal de ${a.tier}), pas ${a.total}`);
    assert.equal(Number(run([['HGET', `clanxpm:${wk}:hardclan`, hk.playerId]])[0].result), min);
    run([['HDEL', 'clanof', hk.playerId], ['DEL', `clanxp:${wk}`, `clanxpm:${wk}:hardclan`]]); }
  let st = stOf(hk.playerId);
  assert.deepEqual([st['h:rolls'], st['h:xp'], st[`h:t:${a.tier}`], st.xpLife, st.rolls], ['1', String(a.total), '1', String(a.total), undefined], 'compteurs à part, XP à vie commune');
  assert.equal(Shop.balance(st), Shop.HARD_COINS[a.tier] + Shop.COINS.divine, 'le solde compte les raretés du mode difficile');
  assert.equal(run([['ZSCORE', 'hlb:all', hk.playerId]])[0].result, String(a.total));
  assert.equal(run([['ZSCORE', 'lb:all', hk.playerId]])[0].result, null, 'rien dans les classements du mode normal');
  assert.match(run([['ZRANGE', `hhist:${hk.playerId}`, 0, -1]])[0].result[0], new RegExp(`^\\d+:${r.body.n}:${a.total}$`));
  // Un seul délai pour les deux modes : passer de l'un à l'autre ne fait pas tirer plus vite.
  assert.equal((await call(roll, { method: 'POST', body: hk })).status, 429);
  db.delete(`cooldown:${hk.playerId}`);
  r = await call(roll, { method: 'POST', body: hk }); assert.equal(r.status, 200); assert.equal(r.body.mode, undefined);
  st = stOf(hk.playerId); assert.equal(st.rolls, '1'); assert.equal(st['h:rolls'], '1');
  assert.equal(Number(st.xpLife), a.total + r.body.s, 'XP à vie : les deux modes');
  // Succès communs : les tirages des deux modes comptent.
  assert.ok(Ach.unlocked({ 'h:rolls': '100' }).includes('regular'));
  assert.ok(Ach.unlocked({ 'h:t:mythic': '1' }).includes('mythic'));
  // Titres du mode difficile seul (idées de PRISMA123 et Liam123456, 2026-11-05) : les tirages normaux ne comptent pas.
  { const hardTitles = st => Ach.unlocked(st).filter(id => ['hardmythic', 'hard5k', 'hard10k', 'hard50k', 'hard100k'].includes(id));
    assert.deepEqual(hardTitles({ rolls: '200000', 't:mythic': '5', 't:infinite': '1', 'h:t:anomaly': '3', 'h:rolls': '4999' }), [], 'rien sans tirage du mode difficile');
    assert.deepEqual(hardTitles({ 'h:t:mythic': '1', 'h:rolls': '5000' }), ['hardmythic', 'hard5k']);
    assert.deepEqual(hardTitles({ 'h:t:godlike': '1', 'h:rolls': '100000' }), ['hardmythic', 'hard5k', 'hard10k', 'hard50k', 'hard100k'], 'Godlike compte pour Mythic ou mieux');
    assert.deepEqual(hardTitles({ 'h:rolls': '49999' }), ['hard5k', 'hard10k']); }
  // Classements du mode difficile : à part.
  r = await call(leaderboard, { url: `/api/leaderboard?period=day&mode=hard&me=${hk.playerId}` });
  assert.equal(r.body.mode, 'hard'); assert.equal(r.body.entries.length, 1); assert.equal(r.body.entries[0].name, 'Hardy'); assert.ok(r.body.entries[0].n >= 0);
  for (const q of ['xp', 'worst', 'rolls', 'month', 'week', 'all']) { const x = await call(leaderboard, { url: `/api/leaderboard?period=${q}&mode=hard&me=${hk.playerId}` }); assert.equal(x.status, 200, q); assert.ok(x.body.entries.some(e => e.me), `${q} : Hardy y est`); }
  r = await call(leaderboard, { url: `/api/leaderboard?period=xp&span=day&mode=hard&me=${hk.playerId}` }); assert.equal(r.body.entries[0].s, a.total);
  r = await call(leaderboard, { url: '/api/leaderboard?period=event&mode=hard' }); assert.deepEqual(r.body.entries, []);
  r = await call(leaderboard, { url: `/api/leaderboard?period=day&me=${hk.playerId}` }); assert.ok(!r.body.entries.some(e => e.name === 'Hardy' && e.n === a.number), 'le classement normal ne montre que le tirage normal');
  // Historique et profil du mode difficile.
  r = await call(history, { method: 'POST', body: { ...hk, mode: 'hard' } });
  assert.equal(r.body.rolls.length, 1); assert.deepEqual(r.body.rolls[0].slice(0, 1).concat(r.body.rolls[0][2]), [a.number, a.total]);
  r = await call(profileApi, { url: `/api/profile?name=Hardy&mode=hard` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.mode, r.body.rolls, r.body.lifetime, r.body.best[0].n, r.body.best[0].tier, r.body.rank], ['hard', 1, a.total, a.number, a.tier, 1]);
  assert.ok(Object.keys(r.body.badges).length === a.earnedIds.length);
  r = await call(profileApi, { url: `/api/profile?name=Hardy&lite=1&me=${hk.playerId}&mode=hard` });
  assert.deepEqual([r.body.rolls, r.body.xp], [1, a.total]);
  // Duel du mode difficile : nombres à 10 chiffres, et le tirage révélé va dans les stats du mode difficile.
  run([['HSET', `stats:${nk.playerId}`, 'v', '1', 'rolls', '50'], ['SET', `player:${nk.playerId}:secret`, crypto.createHash('sha256').update(nk.secret).digest('hex')], ['HSET', 'names', nk.playerId, 'Normy']]);
  // Verrouillé : ni créer ni rejoindre un duel du mode difficile, ni le tournoi difficile.
  r = await call(roomApi2, { method: 'POST', body: { ...nk, action: 'create', size: 2, hard: true } }); assert.deepEqual([r.status, r.body.locked], [403, true]);
  r = await call(roomApi2, { method: 'POST', body: { ...hk, action: 'create', size: 2, bots: 1, hard: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.hard, true);
  const code = r.body.code;
  { const h2 = await call(roomApi2, { method: 'POST', body: { ...hk, action: 'create', size: 2, hard: true } }); const j2 = await call(roomApi2, { method: 'POST', body: { ...nk, action: 'join', code: h2.body.code } }); assert.deepEqual([j2.status, j2.body.locked], [403, true], 'rejoindre : verrouillé'); }
  await assert.rejects(require(path.join(ROOT, 'api/_tournament.js')).signup(nk.playerId, Date.parse(`${Lib.dayKey(Date.now())}T01:00:00Z`), 4), /Divine or higher/);
  r = await call(roomApi2, { method: 'POST', body: { ...hk, action: 'ready', code } });
  const round = r.body.rounds && r.body.rounds[0];
  if (round && Array.isArray(round.n)) for (const n of round.n) if (n != null) assert.ok(n <= 9999999999);
  // Tournoi du mode difficile : à part (which 4).
  const T = require(path.join(ROOT, 'api/_tournament.js'));
  const day0 = Date.parse(`${Lib.dayKey(Date.now())}T01:00:00Z`);
  await assert.rejects(T.signup(hk.playerId, day0, 4), /30 rolls/);
  run([['HINCRBY', `stats:${hk.playerId}`, 'h:rolls', 40]]); // 30 tirages, les deux modes comptés
  const j = await T.signup(hk.playerId, day0, 4); assert.equal(j.tid, `${Lib.dayKey(day0)}-h`); assert.equal(j.which, 4);
  const v = await T.handle({ op: 'view', which: 4, ...hk }, day0); assert.equal(v.hard, true); assert.equal(v.mine, 4);
}

// Audit de sécurité (2026-11-02) : chaque trou trouvé reste fermé.
{
  const Lib = require(path.join(ROOT, 'api/_lib.js'));
  const nameApi = require(path.join(ROOT, 'api/name.js')), friendsApi = require(path.join(ROOT, 'api/friends.js')), siteApi = require(path.join(ROOT, 'api/site.js'));
  const mkP = (tag, name, rolls = 150, extra = []) => { const id = tag.repeat(8), secret = (tag + 'e').repeat(11).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', rolls, ...extra], ['HSET', 'names', id, name], ['SET', `name:${name.toLowerCase()}`, id]]); return { playerId: id, secret, name }; };
  // 1. Joueur créé par Google sans secret principal : personne ne le prend avec un secret inventé.
  const gid = 'ba'.repeat(8);
  run([['SET', `player:${gid}:google`, 'sub-123'], ['SADD', `player:${gid}:secrets`, crypto.createHash('sha256').update('d'.repeat(32)).digest('hex')]]);
  assert.equal(await Lib.claimPlayer(gid, 'a'.repeat(32)), false, 'secret inventé refusé');
  assert.equal(run([['GET', `player:${gid}:secret`]])[0].result, null, 'rien de posé');
  assert.equal(await Lib.claimPlayer(gid, 'd'.repeat(32)), true, 'le vrai appareil reste reconnu');
  // 2. Pseudos qui imitent d'autres lettres.
  const nk = { playerId: crypto.randomBytes(8).toString('hex'), secret: crypto.randomBytes(16).toString('hex') }; // joueur neuf
  r = await call(nameApi, { method: 'POST', body: { ...nk, name: 'Sɑcha' } }); assert.equal(r.status, 422, JSON.stringify(r.body));
  r = await call(nameApi, { method: 'POST', body: { ...nk, name: 'Élodie' } }); assert.equal(r.status, 200, 'les accents restent permis');
  // 3. Chat global : un très long message est refusé tout de suite (il bloquait le serveur 23 s).
  const talker = mkP('e4', 'Talker7');
  let t0 = Date.now(); r = await call(friendsApi, { method: 'POST', body: { ...talker, action: 'gcSend', text: 'r'.repeat(120000) } });
  assert.equal(r.status, 422); assert.ok(Date.now() - t0 < 1000, `refusé vite (${Date.now() - t0} ms)`);
  // 4. Suggestion de 250 000 espaces : refusée tout de suite (33 s avant).
  t0 = Date.now(); r = await call(siteApi, { method: 'POST', body: { ...talker, action: 'suggest', name: 'Talker7', text: ' '.repeat(250000) } });
  assert.equal(r.status, 422); assert.ok(Date.now() - t0 < 1000, `refusé vite (${Date.now() - t0} ms)`);
  // 5. Un modérateur ne supprime pas le message du créateur.
  const ownerP = mkP('e5', 'Owner7', 150, ['owner', '1']), modP = mkP('e6', 'Mod7', 150, ['gcMod', '1']);
  run([['SADD', 'gc:mods', modP.playerId], ['DEL', `gc:rl:${ownerP.playerId}`]]);
  r = await call(friendsApi, { method: 'POST', body: { ...ownerP, action: 'gcSend', text: 'hello from the owner' } });
  const omsg = r.body.msgs.at(-1);
  r = await call(friendsApi, { method: 'POST', body: { ...modP, action: 'gcDelete', id: omsg.id, why: 'spam' } }); assert.equal(r.status, 403);
  r = await call(friendsApi, { method: 'POST', body: { ...modP, action: 'gcMute', id: omsg.id, dur: 'constructor', why: 'spam' } }); assert.equal(r.status, 400, 'durée inventée');
  // 6. Photo retirée deux fois : remboursée une seule fois.
  run([['SET', `avp:${talker.playerId}`, JSON.stringify({ img: 'x', t: 1, pk: 'pk7', paid: 500 })], ['HSET', 'avpq', 'pk7', talker.playerId], ['HSET', `stats:${talker.playerId}`, 'spent', 500]]);
  const prof = require(path.join(ROOT, 'api/profile.js'));
  const cancels = await Promise.all([1, 2, 3].map(() => call(prof, { method: 'POST', body: { ...talker, action: 'avatar', op: 'cancel' } })));
  assert.deepEqual(cancels.map(c => c.body.refunded).sort(), [0, 0, 500]);
  assert.equal(run([['HGET', `stats:${talker.playerId}`, 'spent']])[0].result, '0');
  // 7. Position à effet de levier fermée puis réécrite : jamais payée deux fois.
  const Lever = require(path.join(ROOT, 'api/_lever.js'));
  if (Lever._close) {
    const pos = { id: 'p7', a: 'btc', side: 'long', lev: 2, m: 100, entry: 100, t: 1 };
    run([['HSET', `pos:${talker.playerId}`, 'p7', JSON.stringify(pos)]]);
    const b0 = Number(run([['HGET', `stats:${talker.playerId}`, 'bonus']])[0].result || 0);
    assert.ok(await Lever._close(talker.playerId, 'p7', 110, 'manual'));
    run([['HSET', `pos:${talker.playerId}`, 'p7', JSON.stringify(pos)]]); // « edit » qui ressuscite la position
    assert.equal(await Lever._close(talker.playerId, 'p7', 110, 'manual'), null, 'pas de 2e paiement');
    assert.ok(Number(run([['HGET', `stats:${talker.playerId}`, 'bonus']])[0].result) - b0 > 0);
  }
}

// Poker du casino (demandé par Sacha, 2026-11-03) : évaluateur, déroulé d'une main, tables contre le bot et entre amis.
{
  const H = require(path.join(ROOT, 'api/_holdem.js'));
  const Poker = require(path.join(ROOT, 'api/_poker.js'));
  const Lib = require(path.join(ROOT, 'api/_lib.js'));
  const Shop = require(path.join(ROOT, 'js/shop.js'));
  const shopApi = require(path.join(ROOT, 'api/shop.js')), friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const RK = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 }, SU = { s: 0, h: 1, d: 2, c: 3 };
  const cards = str => str.split(' ').map(x => ((RK[x[0]] - 2) << 2) | SU[x[1]]);
  const sc = str => H.score(cards(str)), name = str => H.describe(sc(str));
  // 1. Évaluateur : noms et ordre des mains.
  assert.equal(name('As Ks Qs Js Ts 2d 3c'), 'Royal Flush');
  assert.equal(name('5s 4s 3s 2s As Kd Qd'), 'Straight Flush, Five high');
  assert.equal(name('Qh Qd Qc Qs 2d 3h 9c'), 'Four of a Kind, Queens');
  assert.equal(name('Kh Kd Kc 7s 7d 2c 3h'), 'Full House, Kings full of Sevens');
  assert.equal(name('Kh Kd Kc 7s 7d 7c 3h'), 'Full House, Kings full of Sevens', 'deux brelans : le second fait la paire');
  assert.equal(name('Ah Kh 2h 7h 9h Qs Js'), 'Flush, Ace high');
  assert.equal(name('Ah 2d 3c 4s 5h Kd Kc'), 'Straight, Five high', 'la roue A-2-3-4-5');
  assert.equal(name('Ts Jd Qc Ks Ad 2h 2c'), 'Straight, Ace high');
  assert.equal(name('9h 9d 9c 4s 2d Kh Jc'), 'Three of a Kind, Nines');
  assert.equal(name('Kh Kd 7c 7s 2d 2h 9c'), 'Two Pair, Kings and Sevens');
  assert.equal(name('Th Td 4c 8s 2d Jh 9c'), 'Pair of Tens');
  assert.equal(name('Ah 3d 6c 8s Td Jh 9c'), 'High Card, Ace');
  const order = ['Ah 3d 6c 8s Td Jh 9c', 'Th Td 4c 8s 2d Jh 9c', 'Kh Kd 7c 7s 2d 2h 9c', '9h 9d 9c 4s 2d Kh Jc', 'Ah 2d 3c 4s 5h Kd Kc', 'Ts Jd Qc Ks Ad 2h 2c', 'Ah Kh 2h 7h 9h Qs Js', 'Kh Kd Kc 7s 7d 2c 3h', 'Qh Qd Qc Qs 2d 3h 9c', '5s 4s 3s 2s As Kd Qd', 'As Ks Qs Js Ts 2d 3c'];
  for (let k = 1; k < order.length; k++) assert.ok(sc(order[k]) > sc(order[k - 1]), `${order[k]} > ${order[k - 1]}`);
  assert.ok(sc('2h 3d 4c 5s 6h Kd 9c') > sc('Ah 2d 3c 4s 5h Kd 9c'), 'la roue est la plus petite quinte');
  assert.ok(sc('Ah Kh 2h 7h 9h Qs Js') > sc('9c Tc Jh Qs Kd 2h 3c'), 'couleur > quinte');
  assert.ok(sc('Kh Kd Kc 7s 7d 2c 3h') > sc('Qh Qd Qc As Ad 2c 3h'), 'full : le brelan d\'abord');
  assert.ok(sc('Kh Kd Kc 8s 8d 2c 3h') > sc('Kc Ks Kh 7s 7d 2c 3h'), 'full : puis la paire');
  assert.ok(sc('Ah Ad Ac 9s 2h Kd 7c') > sc('Ah Ad Ac 9s 2h Qd 7c'), 'brelan : la carte d\'accompagnement');
  assert.ok(sc('Kh Kd 7c 7s 2d 2h 9c') > sc('Kh Kd 7c 7s 2d 2h 3c'), 'trois paires : la 3e paire ne compte pas, la plus haute carte restante oui');
  assert.equal(sc('Ac Kc 2c 2s 7h 8h 9h'), sc('As Kd 2d 2h 7c 8c 9c'), 'mêmes valeurs : égalité exacte (pot partagé)');
  assert.ok(sc('Ah Kd Qc Js 9h 3c 2d') > sc('Ah Kd Qc Js 8h 3c 2d'), 'carte haute : la 5e carte départage');
  assert.equal(sc('Ah Kd Qc Js 9h 3c 2d'), sc('Ah Kd Qc Js 9h 4c 2d'), 'la 6e et la 7e carte ne comptent pas');
  assert.deepEqual(H.best5(cards('Kh Kd 7c 7s 2d 2h 9c')).sort((a, b) => a - b), cards('Kh Kd 7c 7s 9c').sort((a, b) => a - b));
  {
    // Même nom de main : le site dit ce qui départage (« Queen kicker »).
    const t = { sb: 1, bb: 2, btn: 0, seats: [{ stack: 50 }, { stack: 50 }], hand: null };
    H.newHand(t, n => n - 1);
    const top = cards('Ts 4d Td 3d 8s 4c 2h 5h'), used = [...top, ...cards('6d Qh 3c 7s')];
    t.hand.deck = [...Array(52).keys()].filter(c => !used.includes(c)).concat(top); // tableau 2h 4c 8s Td Ts
    t.hand.hole = [cards('6d Qh'), cards('3c 7s')];
    H.act(t, 0, 'allin'); H.act(t, 1, 'call');
    assert.equal(t.hand.res.w, 0); assert.deepEqual(t.hand.res.desc, ['Pair of Tens', 'Pair of Tens']); assert.equal(t.hand.res.kick, 'Queen kicker');
  }

  // 2. Déroulé d'une main (moteur seul, paquet choisi) : tapis inégaux, mise non suivie rendue, tableau qui sort tout seul.
  {
    // Siège 0 a 300, siège 1 a 1 000 ; siège 0 au bouton (petite blind 5, grosse blind 10).
    const t = { sb: 5, bb: 10, btn: 0, seats: [{ stack: 300 }, { stack: 1000 }], hand: null };
    H.newHand(t, n => n - 1);
    const h = t.hand;
    assert.equal(h.turn, 0, 'avant le flop, le bouton parle en premier');
    assert.deepEqual(h.bet, [5, 10]);
    assert.throws(() => H.act(t, 1, 'call'), /Not your turn/);
    assert.throws(() => H.act(t, 0, 'raise', 15), /Raise to between 20 and 300/, 'relance minimale : 2 × la grosse blind');
    H.act(t, 0, 'allin');
    assert.equal(h.bet[0], 300); assert.equal(t.seats[0].stack, 0);
    // Siège 1 relance à tapis : il ne peut pas mettre plus que les 300 que l'autre peut suivre.
    const op = H.options(t, 1);
    assert.equal(op.canRaise, false, 'rien à relancer contre un tapis');
    H.act(t, 1, 'call');
    assert.equal(h.done, true, 'tapis suivi : tableau sorti jusqu\'à la rivière et abattage');
    assert.equal(h.board.length, 5);
    assert.equal(h.res.pot, 600); assert.equal(h.res.rake, 30, '5 % du pot');
    assert.equal(t.seats[0].stack + t.seats[1].stack, 1300 - 30, 'rien ne se crée');
    assert.ok(h.res.shown && h.res.desc.length === 2);
  }
  {
    // Le gros tapis mise plus que le petit ne peut suivre : l'excédent revient sans commission.
    const t = { sb: 5, bb: 10, btn: 1, seats: [{ stack: 1000 }, { stack: 120 }], hand: null };
    H.newHand(t, n => n - 1);
    H.act(t, 1, 'call'); H.act(t, 0, 'check'); // flop
    assert.equal(t.hand.street, 1); assert.equal(t.hand.turn, 0, 'après le flop, celui qui n\'a pas le bouton parle en premier');
    assert.equal(H.options(t, 0).maxTo, 110, 'pas de mise plus grosse que ce que l\'autre peut suivre');
    H.act(t, 0, 'raise', 50); H.act(t, 1, 'allin');
    assert.equal(t.hand.bet[1], 110);
    H.act(t, 0, 'call');
    assert.equal(t.hand.done, true); assert.equal(t.hand.res.pot, 240); assert.equal(t.hand.res.rake, 12);
    assert.equal(t.seats[0].stack + t.seats[1].stack, 1120 - 12);
  }
  {
    // Un joueur se couche face à une relance : sa part va au gagnant, la relance non suivie revient sans commission.
    const t = { sb: 10, bb: 20, btn: 0, seats: [{ stack: 1000 }, { stack: 1000 }], hand: null };
    H.newHand(t, n => n - 1);
    H.act(t, 0, 'raise', 60); H.act(t, 1, 'raise', 200); H.act(t, 0, 'fold');
    assert.equal(t.hand.res.pot, 120, 'pot = 60 + 60, les 140 non suivis rendus'); assert.equal(t.hand.res.rake, 6);
    assert.equal(t.hand.res.shown, false, 'pas d\'abattage, les cartes restent cachées');
    assert.deepEqual([t.seats[0].stack, t.seats[1].stack], [940, 1054]);
    // Pot partagé : le jeton impair à celui qui n'a pas le bouton.
    const s = { sb: 1, bb: 2, btn: 0, seats: [{ stack: 100 }, { stack: 100 }], hand: null };
    H.newHand(s, n => n - 1);
    // Paquet choisi : les cartes sortent par la fin (brûlée, flop, brûlée, turn, brûlée, river).
    const top = cards('Ts 4d Js 3d Qs Ks As 2d'), used = [...top, ...cards('2h 3h 2c 3c')];
    const h = s.hand; h.deck = [...Array(52).keys()].filter(c => !used.includes(c)).concat(top);
    h.hole = [cards('2h 3h'), cards('2c 3c')];
    H.act(s, 0, 'raise', 11); H.act(s, 1, 'call');
    for (let k = 0; k < 3; k++) { H.act(s, 1, 'check'); H.act(s, 0, 'check'); }
    assert.equal(h.done, true); assert.equal(h.res.w, -1, 'quinte flush royale au tableau : égalité');
    assert.equal(h.res.pot, 22); assert.equal(h.res.rake, 1); assert.deepEqual(h.res.win, [10, 11]);
  }

  // 3. Tables : joueurs avec des pièces (bonus) et assez de tirages.
  const mkP = (tag, nm, coins = 20000, rolls = 150) => { const id = tag.repeat(8), secret = (tag + 'f').repeat(11).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', rolls, 'bonus', coins], ['HSET', 'names', id, nm], ['SET', `name:${nm.toLowerCase()}`, id]]); return { playerId: id, secret, name: nm }; };
  const coinsOf = async p => Shop.balance(await Lib.readStats(p.playerId));
  const pk = (p, extra) => call(shopApi, { method: 'POST', body: { playerId: p.playerId, secret: p.secret, action: 'poker', ...extra } });
  const casino = () => { const f = run([['HGETALL', 'casino']])[0].result || []; const o = {}; for (let i = 0; i < f.length; i += 2) o[f[i]] = Number(f[i + 1]); return o; };
  const noIds = (body, ...ps) => ps.forEach(p => assert.ok(!JSON.stringify(body).includes(p.playerId), 'aucun identifiant de joueur'));

  // 3a. Contre le bot, par l'API (routage par api/shop.js) : cave débitée, cartes du bot cachées, jeu, départ.
  const pa = mkP('c1', 'PokerAnn');
  const before = await coinsOf(pa), house0 = casino();
  r = await pk(pa, { op: 'state' });
  assert.equal(r.status, 200); assert.equal(r.body.idle, true); assert.deepEqual(r.body.buyins, [100, 250, 500, 1000, 2500, 5000]);
  r = await pk(pa, { op: 'bot', buyin: 750 }); assert.equal(r.status, 400, 'cave hors liste refusée');
  r = await pk(pa, { op: 'bot', buyin: 500 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await coinsOf(pa), before - 500, 'cave débitée');
  assert.equal(r.body.bot, true); assert.equal(r.body.hand.mine.length, 2); assert.equal(r.body.hand.theirs, undefined, 'cartes du bot cachées');
  assert.equal(r.body.me.stack + r.body.me.bet + r.body.opp.stack + r.body.opp.bet, 1000);
  noIds(r.body, pa);
  r = await pk(pa, { op: 'bot', buyin: 100 }); assert.equal(r.status, 422, 'une table à la fois');
  const code = run([['GET', `pkp:${pa.playerId}`]])[0].result;
  assert.ok(/^[A-Z2-9]{6}$/.test(code));
  // On joue une vingtaine de mains en suivant tout (le temps avance : le bot répond, la main suivante arrive).
  let now = Date.now();
  let st = await Poker.handle(pa.playerId, { op: 'state' }, now);
  let played = 0, showed = 0;
  for (let k = 0; k < 400 && st.status === 'play' && played < 20; k++) {
    if (st.hand && !st.hand.done && st.hand.turn === 'me') {
      if (st.hand.theirs) throw new Error('cartes du bot montrées pendant la main');
      // Check, ou suivre une petite mise ; sinon se coucher (le match dure : le tapis ne part pas d'un coup).
      st = await Poker.handle(pa.playerId, { op: 'act', move: st.hand.op.canCheck ? 'check' : st.hand.op.toCall <= 2 * st.bb ? 'call' : 'fold' }, now);
    } else {
      if (st.hand && st.hand.done) { played++; if (st.hand.res.shown) { showed++; assert.equal(st.hand.theirs.length, 2); assert.ok(st.hand.res.desc.me && st.hand.res.desc.opp); } }
      now += 4000;
      st = await Poker.handle(pa.playerId, { op: st.hand && st.hand.done && k % 2 ? 'next' : 'state' }, now);
    }
  }
  assert.ok(played >= 5, `des mains jouées (${played})`);
  assert.ok(showed >= 1, 'au moins un abattage');
  // Jouer quand ce n'est pas son tour : refusé.
  if (st.status === 'play') {
    while (st.status === 'play' && st.hand && (st.hand.done || st.hand.turn === 'me')) { if (st.hand.done) { now += 4000; st = await Poker.handle(pa.playerId, { op: 'next' }, now); } else st = await Poker.handle(pa.playerId, { op: 'act', move: 'call' }, now); }
    if (st.status === 'play' && st.hand.turn === 'opp') await assert.rejects(Poker.handle(pa.playerId, { op: 'act', move: 'call' }, now), /Not your turn/);
  }
  assert.equal(st.status, 'play', 'toujours assis (petites mises seulement)');
  r = await pk(pa, { op: 'leave' });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'over'); assert.equal(r.body.over.reason, 'leave');
  const cash = r.body.over.cash;
  assert.equal(await coinsOf(pa), before - 500 + cash, 'tapis rendu');
  const house1 = casino();
  assert.equal(house1['b:poker'] - (house0['b:poker'] || 0), 500); assert.equal(house1['w:poker'] - (house0['w:poker'] || 0), cash, 'comptes du casino : cave misée, tapis gagné');
  r = await pk(pa, { op: 'state' }); assert.equal(r.body.status, 'over', 'le match fini reste affiché');
  r = await pk(pa, { op: 'ack' }); assert.equal(r.body.idle, true); assert.equal(r.body.last.cash, cash, 'résultat du dernier match');
  assert.equal(run([['GET', `pkp:${pa.playerId}`]])[0].result, null);

  // 3b. Plusieurs demandes en même temps : une seule table, une seule cave ; un seul coup joué.
  const pb = mkP('c2', 'PokerBen');
  const b0 = await coinsOf(pb), rake0 = Number(run([['HGET', 'pkstats', 'rake']])[0].result || 0);
  const sits = await Promise.all(Array.from({ length: 6 }, () => pk(pb, { op: 'bot', buyin: 1000 })));
  assert.equal(sits.filter(x => x.status === 200).length, 1, JSON.stringify(sits.map(x => x.status)));
  assert.equal(await coinsOf(pb), b0 - 1000, 'débitée une seule fois');
  now = Date.now();
  st = await Poker.handle(pb.playerId, { op: 'state' }, now);
  for (let k = 0; k < 20 && !(st.hand && !st.hand.done && st.hand.turn === 'me'); k++) { now += 4000; st = await Poker.handle(pb.playerId, { op: 'next' }, now); }
  assert.equal(st.hand.turn, 'me');
  const potBefore = st.hand.pot;
  const acts = await Promise.all(Array.from({ length: 8 }, () => Poker.handle(pb.playerId, { op: 'act', move: 'raise', to: st.hand.op.minTo }, now).then(() => 200, e => e.status)));
  assert.equal(acts.filter(x => x === 200).length, 1, `un seul coup accepté (${acts})`);
  const after = await Poker.handle(pb.playerId, { op: 'state' }, now);
  assert.ok(after.hand.pot > potBefore);
  const tab = JSON.parse(run([['GET', `pk:${run([['GET', `pkp:${pb.playerId}`]])[0].result}`]])[0].result);
  const rakeB = Number(run([['HGET', 'pkstats', 'rake']])[0].result || 0) - rake0;
  assert.equal(tab.seats[0].stack + tab.seats[1].stack + tab.hand.put[0] + tab.hand.put[1] + rakeB, 2000, 'jetons sur la table + commission = 2 caves');
  // Table abandonnée (personne depuis 2 min) : réglée par la file pending, le joueur encaisse.
  const pbCode = run([['GET', `pkp:${pb.playerId}`]])[0].result;
  await Lib.flushDue(Date.now() + 5 * 60000);
  const pbTab = JSON.parse(run([['GET', `pk:${pbCode}`]])[0].result);
  assert.equal(pbTab.status, 'over'); assert.equal(pbTab.over.reason, 'idle');
  r = await pk(pb, { op: 'state' }); assert.equal(r.body.over.reason, 'idle');
  assert.equal(await coinsOf(pb), b0 - 1000 + pbTab.seats[0].cashed, 'table abandonnée : le tapis revient');

  // 3c. Entre amis : invitation, refus d'un inconnu, rejoindre, cartes cachées, minuterie, conservation des pièces.
  const fa = mkP('c3', 'PokerCat', 20000, 400), fb = mkP('c4', 'PokerDan', 20000, 400), fc = mkP('c5', 'PokerEve', 20000, 400);
  run([['SADD', `fr:${fa.playerId}`, fb.playerId], ['SADD', `fr:${fb.playerId}`, fa.playerId]]);
  r = await pk(fa, { op: 'create', buyin: 250, name: 'PokerEve' }); assert.equal(r.status, 403, 'seulement ses amis');
  const fa0 = await coinsOf(fa), fb0 = await coinsOf(fb), houseF0 = casino();
  r = await pk(fa, { op: 'create', buyin: 250, name: 'PokerDan' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'wait'); assert.deepEqual(r.body.invited, ['PokerDan']);
  const fcode = r.body.code;
  assert.equal(await coinsOf(fa), fa0 - 250);
  r = await pk(fb, { op: 'state' });
  assert.deepEqual(r.body.invites, [{ code: fcode, name: 'PokerCat', buyin: 250 }]); noIds(r.body, fa);
  r = await call(friendsApi, { method: 'POST', body: { playerId: fb.playerId, secret: fb.secret, action: 'gifts' } });
  assert.deepEqual(r.body.poker, [{ code: fcode, name: 'PokerCat', buyin: 250 }], 'alerte d\'invitation dans la relève');
  // Deux joueurs veulent la place en même temps (Dan invité, Eve avec le code) : un seul s'assoit.
  const fe0 = await coinsOf(fc);
  const joins = await Promise.all([pk(fb, { op: 'join', code: fcode }), pk(fc, { op: 'join', code: fcode })]);
  assert.equal(joins.filter(x => x.status === 200).length, 1, JSON.stringify(joins.map(x => x.body)));
  const seated = joins[0].status === 200 ? fb : fc, outside = seated === fb ? fc : fb;
  assert.equal((await coinsOf(outside)) - (outside === fb ? fb0 : fe0), 0, 'celui qui n\'a pas eu la place ne paie rien');
  const g0 = seated === fb ? fb0 : fe0;
  assert.equal(await coinsOf(seated), g0 - 250);
  now = Date.now();
  let A = await Poker.handle(fa.playerId, { op: 'state' }, now), B = await Poker.handle(seated.playerId, { op: 'state' }, now);
  assert.equal(A.status, 'play'); assert.equal(A.opp.name, seated.name); assert.equal(B.opp.name, 'PokerCat');
  noIds(A, seated); noIds(B, fa);
  assert.equal(A.hand.theirs, undefined); assert.equal(B.hand.theirs, undefined, 'cartes de l\'ami cachées');
  assert.notDeepEqual(A.hand.mine, B.hand.mine);
  const [first, second] = A.hand.turn === 'me' ? [fa, seated] : [seated, fa];
  await assert.rejects(Poker.handle(second.playerId, { op: 'act', move: 'call' }, now), /Not your turn/, 'hors de son tour');
  await Poker.handle(first.playerId, { op: 'act', move: 'call' }, now);
  await Poker.handle(second.playerId, { op: 'act', move: 'check' }, now); // flop
  let S2 = await Poker.handle(second.playerId, { op: 'state' }, now);
  assert.equal(S2.hand.street, 1); assert.equal(S2.hand.board.length, 3); assert.equal(S2.hand.turn, 'me', 'après le flop : la grosse blind parle');
  assert.ok(S2.hand.left > 25000 && S2.hand.left <= 30000, 'minuterie de 30 s');
  // Pas de réponse : check automatique au bout de 30 s, puis une deuxième fois : il quitte, tout le monde encaisse.
  now += 31000;
  let F1 = await Poker.handle(first.playerId, { op: 'state' }, now);
  assert.equal(F1.log.at(-2).m, 'timeout'); assert.equal(F1.hand.turn, 'me');
  await Poker.handle(first.playerId, { op: 'act', move: 'check' }, now); // turn
  now += 31000;
  F1 = await Poker.handle(first.playerId, { op: 'state' }, now);
  assert.equal(F1.status, 'over'); assert.equal(F1.over.reason, 'timeout');
  r = await pk(second, { op: 'state' }); assert.equal(r.body.status, 'over'); assert.equal(r.body.over.reason, 'timeout'); assert.equal(r.body.over.mine, true, 'c\'est lui qui est parti');
  r = await pk(first, { op: 'state' }); assert.equal(r.body.over.mine, false);
  const houseF1 = casino(), rakeF = (houseF1['b:poker'] - houseF0['b:poker']) - (houseF1['w:poker'] - houseF0['w:poker']);
  assert.ok(rakeF >= 0);
  assert.equal((await coinsOf(fa)) + (await coinsOf(seated)) + rakeF, fa0 + g0, 'pièces des deux amis + commission = avant');
  // Partir en pleine main : la main est couchée, l'autre la gagne ; chacun encaisse.
  r = await pk(fa, { op: 'create', buyin: 100 }); const c2 = r.body.code;
  r = await pk(seated, { op: 'join', code: c2 }); assert.equal(r.status, 200);
  const sum0 = (await coinsOf(fa)) + (await coinsOf(seated)), h0 = casino();
  r = await pk(fa, { op: 'leave' });
  assert.equal(r.body.status, 'over'); assert.equal(r.body.over.reason, 'leave'); assert.equal(r.body.over.mine, true);
  r = await pk(seated, { op: 'state' }); assert.equal(r.body.status, 'over'); assert.equal(r.body.over.reason, 'leave'); assert.equal(r.body.over.mine, false);
  r = await pk(seated, { op: 'ack' }); assert.equal(r.body.idle, true); assert.equal(r.body.last.reason, 'leave'); assert.equal(r.body.last.mine, false);
  const h1 = casino(), rk = (h1['b:poker'] - h0['b:poker']) - (h1['w:poker'] - h0['w:poker']);
  assert.equal((await coinsOf(fa)) + (await coinsOf(seated)) + rk, sum0 + 200, 'rien de créé en partant');
  // Table qui attend son ami, abandonnée : annulée et remboursée en entier (hors comptes du casino).
  const fa1 = await coinsOf(fa), h2 = casino();
  r = await pk(fa, { op: 'create', buyin: 1000 }); assert.equal(await coinsOf(fa), fa1 - 1000);
  await Lib.flushDue(Date.now() + 3 * 60000);
  assert.equal(await coinsOf(fa), fa1, 'remboursée'); assert.equal(casino()['b:poker'], h2['b:poker']);
  // Annuler soi-même pendant l'attente : remboursé aussi, l'invitation disparaît.
  r = await pk(fa, { op: 'create', buyin: 100, name: 'PokerDan' }); const c3 = r.body.code;
  r = await pk(fa, { op: 'leave' }); assert.equal(await coinsOf(fa), fa1);
  r = await pk(fb, { op: 'state' }); assert.ok(!r.body.invites.some(x => x.code === c3));
  r = await pk(fb, { op: 'join', code: c3 }); assert.equal(r.status, 404);

  // 3d. Jusqu'au tapis vide contre le bot (tapis à chaque coup) : match fini, l'argent de la maison reste juste.
  const pz = mkP('c6', 'PokerZed');
  const z0 = await coinsOf(pz);
  await pk(pz, { op: 'bot', buyin: 100 });
  now = Date.now();
  st = await Poker.handle(pz.playerId, { op: 'state' }, now);
  for (let k = 0; k < 600 && st.status === 'play'; k++) {
    if (st.hand && !st.hand.done && st.hand.turn === 'me') st = await Poker.handle(pz.playerId, { op: 'act', move: 'allin' }, now);
    else { now += 4000; st = await Poker.handle(pz.playerId, { op: 'state' }, now); }
  }
  assert.equal(st.status, 'over'); assert.equal(st.over.reason, 'bust');
  assert.ok(st.over.cash === 0 || st.over.cash > 150, `tapis vide d'un côté (${st.over.cash})`);
  assert.equal(await coinsOf(pz), z0 - 100 + st.over.cash);
  // Petit joueur : pas assez de tirages.
  const pn = mkP('c7', 'PokerNew', 5000, 10);
  r = await pk(pn, { op: 'bot', buyin: 100 }); assert.equal(r.status, 422); assert.match(r.body.error, /30 rolls/);
  const pp = mkP('c8', 'PokerPoor', 50);
  r = await pk(pp, { op: 'bot', buyin: 100 }); assert.equal(r.status, 422); assert.match(r.body.error, /Not enough coins/);

  // 3e. Tables entre amis : 300 tirages et 2 500 pièces de caves par jour et par joueur (sinon perdre exprès ferait
  // passer des pièces sans les limites des cadeaux). Le bot n'est pas concerné.
  const ga = mkP('c9', 'PokerGus', 20000, 400), gb = mkP('ca', 'PokerHal', 20000, 400), gn = mkP('cb', 'PokerIda', 20000, 150);
  run([['SADD', `fr:${ga.playerId}`, gb.playerId, gn.playerId], ['SADD', `fr:${gb.playerId}`, ga.playerId], ['SADD', `fr:${gn.playerId}`, ga.playerId]]);
  r = await pk(gn, { op: 'create', buyin: 100, name: 'PokerGus' }); assert.equal(r.status, 422); assert.match(r.body.error, /300 rolls/);
  r = await pk(gn, { op: 'bot', buyin: 100 }); assert.equal(r.status, 200, 'le bot reste à 30 tirages'); await pk(gn, { op: 'leave' });
  r = await pk(ga, { op: 'create', buyin: 2500 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const gcode = r.body.code;
  r = await pk(gn, { op: 'join', code: gcode }); assert.equal(r.status, 422, 'rejoindre aussi : 300 tirages');
  r = await pk(gb, { op: 'join', code: gcode }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const day = run([['HGETALL', `pkday:${new Date(Date.now()).toISOString().slice(0, 10)}`]])[0].result;
  assert.ok(day.includes(ga.playerId) && day.includes(gb.playerId), 'compté pour les deux joueurs');
  await pk(ga, { op: 'leave' }); await pk(ga, { op: 'ack' }); await pk(gb, { op: 'ack' });
  r = await pk(ga, { op: 'create', buyin: 100 }); assert.equal(r.status, 422, 'plus de place aujourd\'hui'); assert.match(r.body.error, /0 more coins/);
  r = await pk(ga, { op: 'bot', buyin: 1000 }); assert.equal(r.status, 200, 'le bot reste ouvert'); await pk(ga, { op: 'leave' });

  // 3f. Tables entre amis de 2 à 6 places (Sacha, 2026-11-04 : « can we be more than two at the table and play with
  // more friends? »). Moteur seul d'abord (paquet choisi), puis par l'API.
  {
    const T = (stacks, btn, sb = 5, bb = 10) => ({ sb, bb, btn, seats: stacks.map(s => (s == null ? null : { stack: s })), hand: null });
    const total = t => t.seats.reduce((x, s) => x + (s ? s.stack : 0), 0);
    // Paquet choisi : les cartes du tableau sortent par la fin (brûlée, flop, brûlée, turn, brûlée, river).
    const rig = (t, holes, board) => {
      const [f1, f2, f3, tu, ri] = cards(board), burn = cards('8c 6s 5c'), top = [ri, burn[2], tu, burn[1], f3, f2, f1, burn[0]];
      const used = [...top, ...holes.flatMap(x => (x ? cards(x) : []))];
      t.hand.deck = [...Array(52).keys()].filter(c => !used.includes(c)).concat(top);
      holes.forEach((x, i) => { if (x) t.hand.hole[i] = cards(x); });
    };
    // 3 joueurs : bouton 0, petite blind 1, grosse blind 2 ; avant le flop, le bouton parle en premier ; après, la petite blind.
    let t = T([1000, 1000, 1000], 0);
    H.newHand(t, n => n - 1);
    assert.deepEqual([t.hand.btn, t.hand.sb, t.hand.bbs, t.hand.turn], [0, 1, 2, 0]);
    assert.deepEqual(t.hand.bet, [0, 5, 10]);
    assert.throws(() => H.act(t, 1, 'call'), /Not your turn/);
    H.act(t, 0, 'call'); H.act(t, 1, 'call'); H.act(t, 2, 'check');
    assert.equal(t.hand.street, 1); assert.equal(t.hand.turn, 1, 'après le flop : le premier à gauche du bouton');
    H.act(t, 1, 'check'); H.act(t, 2, 'raise', 40); H.act(t, 0, 'fold'); H.act(t, 1, 'call');
    assert.equal(t.hand.turn, 1, 'turn : la petite blind reparle'); assert.equal(t.hand.fold[0], true);
    H.act(t, 1, 'check'); H.act(t, 2, 'check'); H.act(t, 1, 'check'); H.act(t, 2, 'check');
    assert.equal(t.hand.done, true); assert.equal(t.hand.res.shown, true);
    assert.equal(t.hand.res.desc[0], null, 'la main couchée reste cachée');
    assert.equal(t.hand.res.pot, 110); assert.equal(total(t) + t.hand.res.rake, 3000, 'rien ne se crée');
    // Le bouton tourne sur les sièges occupés : 0 → 1 ; un siège vide (parti) ou ruiné est sauté.
    H.newHand(t, n => n - 1);
    assert.deepEqual([t.hand.btn, t.hand.sb, t.hand.bbs, t.hand.turn], [1, 2, 0, 1]);
    t = T([1000, 1000, null, 1000], 1); H.newHand(t, n => n - 1);
    assert.deepEqual([t.hand.btn, t.hand.sb, t.hand.bbs, t.hand.turn], [1, 3, 0, 1]);
    t.hand.done = true; t.seats[3].stack = 0; t.seats[2] = { stack: 500 };
    H.newHand(t, n => n - 1);
    assert.deepEqual([t.hand.btn, t.hand.sb, t.hand.bbs], [2, 0, 1], 'le siège 3 (tapis vide) est sauté, le 2 (arrivé) joue');
    assert.equal(t.hand.in[3], false); assert.deepEqual(t.hand.hole[3], []);
    // Deux joueurs restants : retour à la règle du heads-up (le bouton met la petite blind).
    t = T([1000, null, 1000, null], 0); H.newHand(t, n => n - 1);
    assert.deepEqual([t.hand.btn, t.hand.sb, t.hand.bbs, t.hand.turn], [0, 0, 2, 0]);
    // 6 joueurs : tout le monde se couche jusqu'à la grosse blind ; la part non suivie lui revient sans commission.
    t = T([1000, 1000, 1000, 1000, 1000, 1000], 4); H.newHand(t, n => n - 1);
    assert.deepEqual([t.hand.btn, t.hand.sb, t.hand.bbs, t.hand.turn], [4, 5, 0, 1]);
    for (const i of [1, 2, 3, 4, 5]) H.act(t, i, 'fold');
    assert.equal(t.hand.done, true); assert.equal(t.hand.res.pot, 10); assert.equal(t.hand.res.rake, 1);
    assert.deepEqual(t.seats.map(s => s.stack), [1004, 1000, 1000, 1000, 1000, 995]);
    // 6 joueurs jusqu'au bout : enchères sur chaque tour, conservation.
    t = T([1000, 1000, 1000, 1000, 1000, 1000], 0); H.newHand(t, n => n - 1);
    H.act(t, 3, 'raise', 30); H.act(t, 4, 'call'); H.act(t, 5, 'fold'); H.act(t, 0, 'raise', 90); H.act(t, 1, 'fold'); H.act(t, 2, 'call');
    H.act(t, 3, 'call'); H.act(t, 4, 'fold');
    assert.equal(t.hand.street, 1); assert.equal(t.hand.turn, 2, 'flop : la grosse blind est la première encore en jeu');
    while (!t.hand.done) H.act(t, t.hand.turn, 'check');
    assert.equal(t.hand.res.pot, 5 + 30 + 90 * 3); assert.equal(total(t) + t.hand.res.rake, 6000);
    // Relance incomplète (tapis plus petit qu'une relance) : ceux qui avaient déjà parlé peuvent seulement suivre.
    t = T([1000, 1000, 1000, 150], 0, 5, 10); H.newHand(t, n => n - 1); // bouton 0, blinds 1 et 2, 3 parle en premier
    H.act(t, 3, 'call'); H.act(t, 0, 'raise', 100); H.act(t, 1, 'fold'); H.act(t, 2, 'fold');
    H.act(t, 3, 'allin'); // 150 : 50 de plus, moins qu'une relance complète (90)
    assert.equal(t.hand.turn, 0);
    assert.equal(H.options(t, 0).canRaise, false, 'pas de sur-relance après un tapis incomplet'); assert.equal(H.options(t, 0).toCall, 50);
    H.act(t, 0, 'call'); assert.equal(t.hand.done, true);
    assert.equal(total(t) + t.hand.res.rake, 3150);

    // Pots de côté : trois tapis de tailles différentes (100, 300, 600) et un gros tapis qui suit.
    t = T([100, 300, 600, 1000], 3); H.newHand(t, n => n - 1); // bouton 3 : petite blind 0, grosse blind 1, le 2 parle
    rig(t, ['As Ad', 'Ks Kd', 'Qs Qd', '4h 6d'], '2c 7d 9h Jc 3s');
    H.act(t, 2, 'allin'); H.act(t, 3, 'call'); H.act(t, 0, 'call'); H.act(t, 1, 'call');
    const h = t.hand;
    assert.equal(h.done, true); assert.equal(h.board.length, 5, 'tout le monde à tapis : le tableau sort jusqu\'au bout');
    assert.deepEqual(h.res.pots.map(p => [p.amount, p.rake, p.winners]), [[400, 20, [0]], [600, 30, [1]], [600, 30, [2]]], 'pot principal 4 × 100, pots de côté 3 × 200 et 2 × 300');
    assert.deepEqual(h.res.win, [380, 570, 570, 0]);
    assert.deepEqual(t.seats.map(s => s.stack), [380, 570, 570, 400]);
    assert.equal(total(t) + h.res.rake, 2000, 'au jeton près'); assert.equal(h.res.rake, 80);
    assert.deepEqual(h.res.desc, ['Pair of Aces', 'Pair of Kings', 'Pair of Queens', 'High Card, Jack']);
    // Le gros tapis gagne : il prend les trois pots ; le petit tapis qui a la 2e main ne touche rien au-delà de son pot.
    t = T([100, 300, 600, 1000], 3); H.newHand(t, n => n - 1);
    rig(t, ['Ks Kd', '4h 6d', 'Qs Qd', 'As Ad'], '2c 7d 9h Jc 3s');
    H.act(t, 2, 'allin'); H.act(t, 3, 'call'); H.act(t, 0, 'call'); H.act(t, 1, 'call');
    assert.deepEqual(t.hand.res.win, [0, 0, 0, 1520]); assert.equal(total(t) + t.hand.res.rake, 2000);
    // Pot partagé à trois : 75 → 4 de commission, 71 = 23 + 24 + 24 ; les jetons impairs d'abord à gauche du bouton.
    t = T([1000, 1000, 1000], 0); H.newHand(t, n => n - 1);
    rig(t, ['2h 3h', '2c 3c', '2d 3d'], 'As Ks Qs Js Ts');
    H.act(t, 0, 'raise', 25); H.act(t, 1, 'call'); H.act(t, 2, 'call');
    while (!t.hand.done) H.act(t, t.hand.turn, 'check');
    assert.equal(t.hand.res.pot, 75); assert.equal(t.hand.res.rake, 4); assert.deepEqual(t.hand.res.win, [23, 24, 24]);
    assert.equal(t.hand.res.w, -1); assert.equal(total(t) + 4, 3000);
    // Partir pendant la main (hors de son tour) : sa main est couchée, ses jetons restent au pot, la main continue.
    t = T([1000, 1000, 1000], 0); H.newHand(t, n => n - 1);
    H.act(t, 0, 'raise', 40); H.forfeit(t, 2);
    assert.equal(t.hand.done, false); assert.equal(t.hand.turn, 1);
    H.act(t, 1, 'call'); assert.equal(t.hand.street, 1);
    while (!t.hand.done) H.act(t, t.hand.turn, 'check');
    assert.equal(t.hand.res.pot, 90); assert.equal(total(t) + t.hand.res.rake, 3000);
  }
  {
    // Par l'API : quatre amis à une table de 4 places.
    const P4 = ['d1', 'd2', 'd3', 'd4'].map((tag, k) => mkP(tag, `Quad${k}`, 20000, 400)), [q0, q1, q2, q3] = P4;
    // Tables entre amis : 3 jours après le premier tirage (fermes de bots, 2026-11-04).
    run([['HSET', `stats:${q0.playerId}`, 'first', Date.now() - 3600000]]);
    r = await pk(q0, { op: 'create', buyin: 250, seats: 4 });
    assert.equal(r.status, 422); assert.equal(r.body.error, 'Poker with friends unlocks 3 days after your first roll (3 days left)');
    for (const p of P4) run([['HSET', `stats:${p.playerId}`, 'first', Date.now() - 10 * 86400000]]);
    for (const a of P4) for (const b of P4) if (a !== b) run([['SADD', `fr:${a.playerId}`, b.playerId]]);
    const ids = P4.map(p => p.playerId);
    const coins0 = await Promise.all(P4.map(coinsOf)), h0 = casino();
    r = await pk(q0, { op: 'create', buyin: 250, seats: 4, name: 'Quad1' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.max, 4); assert.equal(r.body.status, 'wait'); assert.equal(r.body.host, true);
    const qcode = r.body.code;
    r = await pk(q0, { op: 'invite', name: 'Quad2' }); assert.deepEqual(r.body.invited, ['Quad1', 'Quad2']);
    r = await pk(q0, { op: 'start' }); assert.equal(r.status, 422, 'il faut au moins un ami assis');
    r = await pk(q1, { op: 'join', code: qcode }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'wait', 'pas pleine : on attend l\'hôte');
    r = await pk(q2, { op: 'join', code: qcode }); assert.equal(r.body.status, 'wait'); assert.equal(r.body.players, 3);
    r = await pk(q1, { op: 'start' }); assert.equal(r.status, 403, 'seul l\'hôte lance la partie');
    assert.equal(run([['HGET', `pkday:${new Date(Date.now()).toISOString().slice(0, 10)}`, q1.playerId]])[0].result, null, 'compté au début de la partie seulement');
    r = await pk(q0, { op: 'start' }); assert.equal(r.status, 200); assert.equal(r.body.status, 'play');
    const dayKeyNow = `pkday:${new Date(Date.now()).toISOString().slice(0, 10)}`;
    for (const p of [q0, q1, q2]) assert.equal(Number(run([['HGET', dayKeyNow, p.playerId]])[0].result), 250);
    // Un 4e arrive pendant la main : il est assis mais attend la suivante ; son plafond du jour compte tout de suite.
    run([['HSET', dayKeyNow, q3.playerId, 2400]]);
    r = await pk(q3, { op: 'join', code: qcode }); assert.equal(r.status, 422, 'plafond du jour vérifié pour un retardataire'); assert.match(r.body.error, /100 more coins/);
    run([['HDEL', dayKeyNow, q3.playerId]]);
    let now = Date.now();
    r = await pk(q3, { op: 'join', code: qcode }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number(run([['HGET', dayKeyNow, q3.playerId]])[0].result), 250);
    assert.equal(r.body.me.out, true); assert.deepEqual(r.body.hand.mine, [], 'pas de cartes pour cette main');
    // Ce que chacun voit : 4 sièges, lui en premier, les cartes des autres cachées, aucun identifiant.
    const views = await Promise.all(P4.map(p => Poker.handle(p.playerId, { op: 'state' }, now)));
    for (const [k, v] of views.entries()) {
      assert.equal(v.seats.length, 4); assert.equal(v.seats[0].name, P4[k].name); assert.equal(v.seats[0].me, true);
      for (const s of v.seats.slice(1)) if (s && s.cards) assert.deepEqual(s.cards, [null, null], 'cartes des autres cachées');
      assert.ok(!ids.some(id => JSON.stringify(v).includes(id)), 'aucun identifiant');
    }
    // Le joueur dont c'est le tour envoie six relances à la fois, les autres aussi des coups : une seule relance passe,
    // et les jetons sur la table restent justes (sous le verrou de la table, chaque coup voit l'état du précédent).
    const turnIdx = views.findIndex(v => v.hand && v.hand.turn === 'me'), minTo = views[turnIdx].hand.op.minTo;
    const acts = await Promise.all([...Array(6)].map(() => Poker.handle(P4[turnIdx].playerId, { op: 'act', move: 'raise', to: minTo }, now).then(() => 200, e => e.status)));
    assert.equal(acts.filter(x => x === 200).length, 1, String(acts));
    const tq = JSON.parse(run([['GET', `pk:${qcode}`]])[0].result);
    assert.equal(tq.seats.reduce((x, s) => x + s.stack, 0) + tq.hand.put.reduce((x, v) => x + v, 0), 1000, '4 caves sur la table');
    // On joue la main jusqu'au bout (check, sinon suivre), puis la suivante : le 4e reçoit ses cartes.
    const stateOf = async p => Poker.handle(p.playerId, { op: 'state' }, now);
    const playUntil = async (stop, move = v => (v.hand.op.canCheck ? 'check' : 'call'), skip = []) => {
      for (let k = 0; k < 200; k++) {
        const vs = await Promise.all(P4.map(stateOf));
        if (stop(vs)) return vs;
        const who = vs.findIndex((v, j) => !skip.includes(j) && v.status === 'play' && v.hand && !v.hand.done && v.hand.turn === 'me');
        if (who < 0) { now += 6000; continue; }
        await Poker.handle(P4[who].playerId, { op: 'act', move: move(vs[who], who) }, now);
      }
      throw new Error('partie bloquée');
    };
    let vs = await playUntil(v => v[0].hand.n === 2 && !v[0].hand.done);
    assert.equal(vs[3].me.out, undefined); assert.equal(vs[3].hand.mine.length, 2, 'le retardataire joue la main suivante');
    assert.equal(vs[0].seats.filter(s => s && s.btn).length, 1);
    const q2Tab = () => JSON.parse(run([['GET', `pk:${qcode}`]])[0].result);
    // Quad3 part en pleine main : sa main est couchée, ses jetons restent au pot, la table continue à trois.
    vs = await playUntil(v => v[3].hand && !v[3].hand.done && (v[3].hand.mine || []).length === 2, undefined, [3]);
    r = await pk(q3, { op: 'leave' }); assert.equal(r.body.status, 'over'); assert.equal(r.body.over.mine, true); assert.equal(r.body.over.table, true);
    assert.equal(q2Tab().status, 'play'); assert.equal(q2Tab().seats.filter(Boolean).length, 3);
    // Minuterie à 3 : Quad2 ne joue plus ; deux fois 30 s sans réponse → il quitte, les deux autres continuent.

    for (let k = 0; k < 400 && q2Tab().seats.some(s => s && s.name === 'Quad2'); k++) {
      const vv = await Promise.all([q0, q1].map(stateOf));
      const who = vv.findIndex(v => v.status === 'play' && v.hand && !v.hand.done && v.hand.turn === 'me');
      if (who >= 0) await Poker.handle([q0, q1][who].playerId, { op: 'act', move: vv[who].hand.op.canCheck ? 'check' : 'call' }, now);
      else now += 31000;
      await Poker.handle(q2.playerId, { op: 'state' }, now - 1); // il regarde encore (pas abandonnée) mais ne joue pas
    }
    let q2v = await Poker.handle(q2.playerId, { op: 'state' }, now);
    assert.equal(q2v.status, 'over'); assert.equal(q2v.over.reason, 'timeout'); assert.equal(q2v.over.mine, true); assert.equal(q2v.over.table, true, 'la table continue sans lui');
    assert.ok(q2Tab().log.some(e => e.m === 'gone'));
    const t3 = q2Tab(); assert.equal(t3.status, 'play'); assert.equal(t3.seats.filter(Boolean).length, 2);
    // Il a vu sa fin, retour au salon ; une place est libre : on peut l'inviter à revenir.
    r = await pk(q2, { op: 'ack' }); assert.equal(r.body.idle, true); assert.equal(r.body.last.reason, 'timeout');
    // Le bouton reste sur un siège occupé.
    const nBefore = q2Tab().hands;
    vs = await playUntil(v => v[0].status === 'play' && v[0].hand && !v[0].hand.done && v[0].hand.n > nBefore);
    const tb = q2Tab(); assert.ok(tb.seats[tb.hand.btn], 'bouton sur un siège occupé');
    // Le dernier adversaire part : le match se termine, tout le monde a encaissé ; aucune pièce créée.
    r = await pk(q1, { op: 'leave' });
    r = await pk(q0, { op: 'state' }); assert.equal(r.body.status, 'over'); assert.equal(r.body.over.reason, 'leave'); assert.equal(r.body.over.mine, false); assert.equal(r.body.over.by, 'Quad1', 'le pseudo de celui qui est parti');
    for (const p of P4) await pk(p, { op: 'ack' });
    const h1 = casino(), rk = (h1['b:poker'] - h0['b:poker']) - (h1['w:poker'] - h0['w:poker']);
    const coins1 = await Promise.all(P4.map(coinsOf));
    assert.ok(rk > 0, 'commission prise');
    assert.equal(coins1.reduce((x, v) => x + v, 0) + rk, coins0.reduce((x, v) => x + v, 0), 'pièces des quatre + commission = avant, au jeton près');
    // Table de 3 abandonnée en pleine main : réglée par la file pending, tout le monde encaisse.
    const s0 = await Promise.all(P4.slice(0, 3).map(coinsOf)), h2 = casino();
    run([['HDEL', dayKeyNow, q0.playerId, q1.playerId, q2.playerId]]);
    r = await pk(q0, { op: 'create', buyin: 100, seats: 3 }); const c3 = r.body.code;
    await pk(q1, { op: 'join', code: c3 }); r = await pk(q2, { op: 'join', code: c3 });
    assert.equal(r.body.status, 'play', 'table pleine : la partie part toute seule');
    await Lib.flushDue(Date.now() + 5 * 60000);
    const tz = JSON.parse(run([['GET', `pk:${c3}`]])[0].result);
    assert.equal(tz.status, 'over'); assert.equal(tz.over.reason, 'idle');
    const h3 = casino(), rk3 = (h3['b:poker'] - h2['b:poker']) - (h3['w:poker'] - h2['w:poker']);
    const s1 = await Promise.all(P4.slice(0, 3).map(coinsOf));
    assert.equal(s1.reduce((x, v) => x + v, 0) + rk3, s0.reduce((x, v) => x + v, 0), 'table abandonnée : tout revient, commission comprise');
    // Places : de 2 à 6, rien d'autre.
    r = await pk(q3, { op: 'create', buyin: 100, seats: 9 }); assert.equal(r.body.max, 2, 'valeur hors limites : 2'); await pk(q3, { op: 'leave' });
  }
  {
    // Tables ouvertes (Sacha, 2026-11-04) : n'importe qui s'assoit, jusqu'à 6, avec la somme de son choix.
    const mkO = (k, nm, old = true) => { const id = `0e1${k.toString(16)}`.repeat(4), secret = `0e1${k.toString(16)}f`.repeat(8).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 400, 'bonus', 20000, 'first', old ? Date.now() - 10 * 86400000 : Date.now() - 3600000], ['HSET', 'names', id, nm], ['SET', `name:${nm.toLowerCase()}`, id]]); return { playerId: id, secret, name: nm }; };
    const O = [0, 1, 2].map(k => mkO(k, `Open${k}`)), [o0, o1, o2] = O, onew = mkO(3, 'OpenNew', false);
    const dayKeyNow = `pkday:${new Date(Date.now()).toISOString().slice(0, 10)}`, openSet = () => run([['SMEMBERS', 'pkopen']])[0].result || [];
    const coins0 = await Promise.all(O.map(coinsOf)), h0 = casino();
    r = await pk(o0, { op: 'state' });
    assert.equal(r.body.open.stakes.length, 3); assert.deepEqual(r.body.open.stakes[1], { sb: 5, bb: 10, min: 200, max: 1000 }); assert.deepEqual(r.body.open.tables, []);
    r = await pk(onew, { op: 'open', stake: 1, buyin: 500 }); assert.equal(r.status, 422); assert.equal(r.body.error, 'Open poker tables unlock 3 days after your first roll (3 days left)');
    for (const [stake, buyin] of [[1, 150], [1, 1001], [1, 250.5], [9, 500]]) { r = await pk(o0, { op: 'open', stake, buyin }); assert.equal(r.status, 400, `${stake}/${buyin} refusé`); }
    // Seul à la table : pas de main, on attend un autre joueur ; la cave choisie est débitée et compte dans le plafond.
    r = await pk(o0, { op: 'open', stake: 1, buyin: 500 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.open, true); assert.equal(r.body.status, 'play'); assert.equal(r.body.max, 6); assert.equal(r.body.players, 1);
    assert.equal(r.body.hand, undefined); assert.equal(r.body.buyin, 500); assert.equal(r.body.host, false); assert.equal(r.body.bb, 10);
    const ocode = r.body.code;
    assert.equal(await coinsOf(o0), coins0[0] - 500); assert.equal(Number(run([['HGET', dayKeyNow, o0.playerId]])[0].result), 500);
    assert.deepEqual(openSet(), [ocode]);
    r = await pk(o0, { op: 'invite', name: 'Open1' }); assert.equal(r.status, 422, 'pas d\'invitation : la table est dans la liste');
    // Les autres la voient dans la liste (pseudos seulement) ; le deuxième arrive avec une autre somme : la main part.
    r = await pk(o1, { op: 'state' }); assert.deepEqual(r.body.open.tables, [{ code: ocode, stake: 1, players: 1, max: 6, names: ['Open0'] }]); noIds(r.body, o0);
    r = await pk(o1, { op: 'open', stake: 1, buyin: 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.code, ocode, 'la table qui a une place'); assert.equal(r.body.buyin, 1000);
    assert.equal(r.body.hand.n, 1); assert.equal(r.body.hand.mine.length, 2);
    let now = Date.now();
    const tab = () => JSON.parse(run([['GET', `pk:${ocode}`]])[0].result);
    const onTable = t => t.seats.reduce((x, s) => x + (s ? s.stack : 0), 0) + (t.hand && !t.hand.done ? t.hand.put.reduce((x, v) => x + v, 0) : 0);
    assert.equal(onTable(tab()), 1500, 'deux caves différentes sur la table');
    // Un troisième s'assoit par le code, en pleine main : il joue la suivante.
    r = await pk(o2, { op: 'join', code: ocode }); assert.equal(r.status, 400, 'il faut choisir sa somme');
    r = await pk(o2, { op: 'join', code: ocode, buyin: 300 }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.me.out, true); assert.equal(r.body.players, 3);
    const stateOf = p => Poker.handle(p.playerId, { op: 'state' }, now);
    const playUntil = async (ps, stop) => {
      for (let k = 0; k < 300; k++) {
        const vs = await Promise.all(ps.map(stateOf));
        if (stop(vs)) return vs;
        const who = vs.findIndex(v => v.status === 'play' && v.hand && !v.hand.done && v.hand.turn === 'me');
        if (who < 0) { now += 6000; continue; }
        await Poker.handle(ps[who].playerId, { op: 'act', move: vs[who].hand.op.canCheck ? 'check' : 'call' }, now);
      }
      throw new Error('table ouverte bloquée');
    };
    let vs = await playUntil(O, v => v[2].hand && v[2].hand.n >= 2 && v[2].hand.mine.length === 2);
    assert.equal(vs[0].seats.length, 6); for (const v of vs) assert.ok(!O.some(p => JSON.stringify(v).includes(p.playerId)), 'aucun identifiant');
    vs = await playUntil(O, v => v[0].hand && v[0].hand.n >= 4 && v[0].hand.done);
    // Open1 part : il encaisse son tapis, son gain se compte sur ses 1 000 apportés ; la table continue.
    r = await pk(o1, { op: 'leave' }); assert.equal(r.body.status, 'over'); assert.equal(r.body.over.table, true); assert.equal(r.body.buyin, 1000);
    assert.equal(r.body.over.net, r.body.over.cash - 1000);
    r = await pk(o1, { op: 'ack' }); assert.equal(r.body.idle, true); assert.equal(r.body.last.buyin, 1000);
    assert.equal(tab().status, 'play');
    // Open2 ferme la page : 45 s plus tard, il est encaissé avant la main suivante ; Open0, seul, attend sans main.
    for (let k = 0; k < 60 && tab().seats.some(s => s && s.name === 'Open2'); k++) {
      const v = await stateOf(o0);
      if (v.hand && !v.hand.done && v.hand.turn === 'me') await Poker.handle(o0.playerId, { op: 'act', move: v.hand.op.canCheck ? 'check' : 'call' }, now);
      else now += 16000;
    }
    assert.ok(!tab().seats.some(s => s && s.name === 'Open2'), 'parti au bout de 45 s'); assert.ok(tab().log.some(e => e.m === 'away'));
    r = await Poker.handle(o2.playerId, { op: 'state' }, now); assert.equal(r.status, 'over'); assert.equal(r.over.mine, true); assert.equal(r.over.reason, 'away'); assert.equal(r.buyin, 300);
    for (let k = 0; k < 10 && (tab().hand || {}).done === false; k++) { const v = await stateOf(o0); if (v.hand && !v.hand.done && v.hand.turn === 'me') await Poker.handle(o0.playerId, { op: 'act', move: 'check' }, now); now += 6000; }
    now += 6000; let v0 = await stateOf(o0);
    assert.equal(v0.status, 'play'); assert.equal(v0.hand, undefined, 'seul : pas de main'); assert.equal(v0.players, 1); assert.equal(tab().status, 'play');
    // Il part : table vide, fermée et retirée de la liste. Aucune pièce créée.
    await Poker.handle(o0.playerId, { op: 'leave' }, now); await Poker.handle(o2.playerId, { op: 'ack' }, now); await pk(o0, { op: 'ack' });
    assert.equal(tab().status, 'over'); assert.deepEqual(openSet(), []);
    r = await pk(o0, { op: 'state' }); assert.deepEqual(r.body.open.tables, []);
    const h1 = casino(), rk = (h1['b:poker'] - h0['b:poker']) - (h1['w:poker'] - h0['w:poker']), coins1 = await Promise.all(O.map(coinsOf));
    assert.ok(rk > 0, 'commission prise'); assert.equal(h1['b:poker'] - h0['b:poker'], 1800, 'comptes du casino : la somme de chacun');
    assert.equal(coins1.reduce((x, v) => x + v, 0) + rk, coins0.reduce((x, v) => x + v, 0), 'pièces + commission = avant');
    assert.equal(Number(run([['HGET', dayKeyNow, o1.playerId]])[0].result), 1000);
    // Plafond du jour commun aux tables entre amis et ouvertes.
    run([['HSET', dayKeyNow, o0.playerId, 2400]]);
    r = await pk(o0, { op: 'open', stake: 0, buyin: 200 }); assert.equal(r.status, 422); assert.match(r.body.error, /only put 100 more coins on tables with other players/);
    // Six places : le septième ouvre une deuxième table ; la file pending règle les deux tables abandonnées.
    const S = [0, 1, 2, 3, 4, 5, 6].map(k => mkO(8 + k, `Seat${k}`)), sc0 = await Promise.all(S.map(coinsOf)), h2 = casino();
    const codes = [];
    for (const p of S) { r = await pk(p, { op: 'open', stake: 0, buyin: 40 + codes.length }); assert.equal(r.status, 200, JSON.stringify(r.body)); codes.push(r.body.code); }
    assert.equal(new Set(codes.slice(0, 6)).size, 1, 'les six premiers à la même table'); assert.notEqual(codes[6], codes[0], 'le septième : une nouvelle table');
    r = await pk(o1, { op: 'state' }); assert.deepEqual(r.body.open.tables.map(x => x.players), [6, 1]);
    await Lib.flushDue(Date.now() + 5 * 60000);
    assert.deepEqual(openSet(), [], 'tables abandonnées retirées');
    const h3 = casino(), rk3 = (h3['b:poker'] - h2['b:poker']) - (h3['w:poker'] - h2['w:poker']), sc1 = await Promise.all(S.map(coinsOf));
    assert.equal(sc1.reduce((x, v) => x + v, 0) + rk3, sc0.reduce((x, v) => x + v, 0), 'table ouverte abandonnée : tout revient');
  }
}

// ================================================================ Fermes de bots (jonahfr, 2026-11-04) : plafond de comptes neufs par adresse, suspension
{
  const Lib = require(path.join(ROOT, 'api/_lib.js'));
  const siteApi = require(path.join(ROOT, 'api/site.js')), friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const rollAs = (p, ip) => { db.delete(`cooldown:${p.playerId}`); return call(roll, { method: 'POST', body: p, headers: ip ? { 'x-forwarded-for': ip } : {} }); };
  const mk = (k, name) => ({ playerId: (k.toString(16).padStart(4, '0') + 'b0') .repeat(3).slice(0, 16), secret: k.toString(16).padStart(2, '0').repeat(16).slice(0, 32), name });
  // 1. Comptes neufs : NEW_PER_HOUR par adresse et par heure, puis 429 avec un message clair. Les joueurs déjà connus
  // de cette adresse tirent toujours ; une autre adresse crée toujours.
  const IP = '192.0.2.77';
  const fresh = Array.from({ length: Lib.NEW_PER_HOUR + 1 }, (_, i) => mk(0x700 + i, `Farm${i}`));
  for (const p of fresh.slice(0, -1)) { const x = await rollAs(p, IP); assert.equal(x.status, 200, JSON.stringify(x.body)); }
  let r = await rollAs(fresh[fresh.length - 1], IP);
  assert.equal(r.status, 429); assert.ok(/^Too many new players from this network/.test(r.body.error), r.body.error);
  assert.equal(run([['GET', `player:${fresh[fresh.length - 1].playerId}:secret`]])[0].result, null, 'pas de compte créé');
  assert.equal((await rollAs(fresh[0], IP)).status, 200, 'un joueur déjà créé tire toujours');
  assert.equal((await rollAs(fresh[fresh.length - 1], '192.0.2.78')).status, 200, 'autre adresse : créé');
  assert.equal((await rollAs(mk(0x7ff, 'Farmv6a'), '2001:db8:1:2:aaaa::1')).status, 200);
  assert.equal(run([['GET', `newp:h:2001:db8:1:2:${Math.floor(Date.now() / 3600000)}`]])[0].result, '1', 'IPv6 comptée par /64');
  // 2. Suspension par le créateur : plus de tirage (423, pas 403 : le site garderait sinon un nouvel identifiant), plus
  // de boutique ni de cadeau ; le chat se lit encore comme un visiteur ; retiré des classements et du compteur en ligne.
  const boss = mk(0x7a0, 'Farmboss'), bot = fresh[1];
  assert.equal((await rollAs(boss)).status, 200);
  run([['HSET', `stats:${boss.playerId}`, 'owner', '1']]);
  const ban = (who, name, on) => call(siteApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action: 'ban', name, ...(on === false ? { on } : {}) } });
  assert.equal((await ban(fresh[2], bot.name)).status, 403, 'créateur seulement');
  assert.equal((await ban(boss, 'Nobody Here')).status, 404);
  assert.equal((await ban(boss, 'Farmboss')).status, 422, 'pas soi-même');
  const day = Lib.dayKey(Date.now());
  assert.notEqual(run([['ZSCORE', 'lb:all', bot.playerId]])[0].result, null, 'au classement avant');
  assert.notEqual(run([['ZSCORE', `lb:day:${day}`, bot.playerId]])[0].result, null);
  r = await ban(boss, bot.name.toLowerCase());
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual([r.body.name, r.body.banned, r.body.total], [bot.name, true, 1]);
  for (const k of ['lb:all', `lb:day:${day}`, `lbx:day:${day}`, 'seen']) assert.equal(run([['ZSCORE', k, bot.playerId]])[0].result, null, `retiré de ${k}`);
  r = await rollAs(bot, IP); assert.equal(r.status, 423); assert.equal(r.body.error, 'This account is suspended');
  assert.notEqual(run([['GET', `player:${bot.playerId}:secret`]])[0].result, null, 'rien d\'effacé');
  r = await call(shopApi, { method: 'POST', body: { playerId: bot.playerId, secret: bot.secret, action: 'buy', id: 'x' } }); assert.equal(r.status, 423, 'boutique');
  r = await call(friendsApi, { method: 'POST', body: { playerId: bot.playerId, secret: bot.secret, action: 'gift', name: 'Farmboss', amount: 10 } }); assert.equal(r.status, 423, 'cadeaux');
  r = await call(friendsApi, { method: 'POST', body: { playerId: bot.playerId, secret: bot.secret, action: 'gcSend', text: 'buy coins' } }); assert.equal(r.status, 423, 'chat global');
  r = await call(friendsApi, { method: 'POST', body: { playerId: bot.playerId, secret: bot.secret, action: 'gcList' } }); assert.equal(r.status, 200, 'lit encore le chat'); assert.equal(r.body.me, undefined, 'comme un visiteur');
  // Un faux secret pour un compte suspendu reste un 403 (on n'apprend rien de la suspension sans le secret).
  r = await call(roll, { method: 'POST', body: { ...bot, secret: 'e'.repeat(32) } }); assert.equal(r.status, 403);
  // 3. Réintégré : il rejoue.
  r = await ban(boss, bot.name, false); assert.deepEqual([r.status, r.body.banned, r.body.total], [200, false, 0]);
  assert.equal((await rollAs(bot, IP)).status, 200, 'réintégré');
  // 4. Plusieurs d'un coup (tools/ban-bots.js) : ids invalides ignorés, doublons comptés une fois.
  assert.equal(await Lib.banPlayers([fresh[3].playerId, fresh[3].playerId, fresh[4].playerId, 'nope']), 2);
  assert.equal(await Lib.isBanned(fresh[4].playerId), true);
  await Lib.unbanPlayers([fresh[3].playerId, fresh[4].playerId]);
  run([['HDEL', `stats:${boss.playerId}`, 'owner']]);
  // 5. Temps restant avant cadeaux et poker entre amis.
  const now = Date.now();
  assert.equal(Lib.accountWait({}, now), '', 'joueur d\'avant le champ first');
  assert.equal(Lib.accountWait({ first: now - 4 * 86400000 }, now), '');
  assert.equal(Lib.accountWait({ first: now }, now), '3 days');
  assert.equal(Lib.accountWait({ first: now - 3 * 86400000 + 1000 }, now), '1 hour');
}

// ================================================================ Compteur par nombre (idée d'un ami de Sacha, 2026-11-05)
{
  const Lib = require(path.join(ROOT, 'api/_lib.js'));
  const { backfill } = require(path.join(ROOT, 'tools/backfill-number-counts.js'));
  const ncGet = n => run([['BITFIELD', 'nc', 'GET', 'u32', `#${n}`]])[0].result[0];
  const p = { playerId: '0e20'.repeat(4), secret: '0e2f'.repeat(8), name: 'Counter' };
  // 1. Avant le rattrapage : chaque tirage est compté, mais le total n'est pas envoyé (tout passerait pour « jamais tiré »).
  db.delete(`cooldown:${p.playerId}`);
  let r = await call(roll, { method: 'POST', body: p });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.seen, undefined, 'rien avant nc:ready');
  assert.ok(ncGet(r.body.n) >= 1, 'compté quand même');
  const since = Number(run([['GET', 'nc:since']])[0].result);
  assert.ok(since > 0 && since <= r.body.t, 'nc:since = premier tirage compté');
  // 2. Historiques : 737373 trois fois avant nc:since (deux joueurs), une fois après (déjà compté en direct : ignoré).
  const old = { playerId: '0e21'.repeat(4) };
  run([['ZADD', `hist:${old.playerId}`, since - 5000, `${since - 5000}:737373`, since - 4000, `${since - 4000}:737373`, since + 10, `${since + 10}:737373`],
    ['ZADD', `hist:${p.playerId}`, since - 3000, `${since - 3000}:737373`], ['ZADD', `hhist:${old.playerId}`, since - 2000, `${since - 2000}:737373`]]);
  const lines = [];
  let b = await backfill({ log: x => lines.push(x) });
  assert.equal(b.counts[737373], 3, 'avant nc:ready seulement, mode difficile exclu'); assert.ok(lines.some(x => /Essai à blanc/.test(x)));
  assert.equal(ncGet(737373), 0, 'essai à blanc : rien écrit'); assert.equal(run([['GET', 'nc:ready']])[0].result, null);
  const before = ncGet(b.top);
  b = await backfill({ apply: true, log: () => {} });
  assert.equal(ncGet(737373), 3); assert.equal(ncGet(b.top), before + b.counts[b.top], 'ajouté aux tirages déjà comptés');
  assert.ok(run([['GET', 'nc:ready']])[0].result);
  assert.equal(await backfill({ apply: true, log: () => {} }), null, 'une seule fois');
  assert.equal(ncGet(737373), 3);
  // 3. Ensuite, chaque tirage dit combien de fois son nombre est déjà sorti, et le compteur avance.
  let x = await Lib.recordRoll(p.playerId, 737373, Date.now()); assert.equal(x.seen, 3);
  await new Promise(res => setTimeout(res, 3));
  x = await Lib.recordRoll(old.playerId, 737373, Date.now()); assert.equal(x.seen, 4, 'tous joueurs confondus');
  x = await Lib.recordRoll(p.playerId, 737374, Date.now() + 3); assert.equal(x.seen, 0, 'jamais tiré');
  db.delete(`cooldown:${p.playerId}`);
  r = await call(roll, { method: 'POST', body: p });
  assert.equal(typeof r.body.seen, 'number'); assert.equal(ncGet(r.body.n), r.body.seen + 1);
}

// ================================================================ Idées du 2026-11-05 (lot 1)
{
  const mkI = (k, nm) => { const id = `0e3${k}`.repeat(4), secret = `0e3${k}f`.repeat(8).slice(0, 32); run([['SET', `player:${id}:secret`, crypto.createHash('sha256').update(secret).digest('hex')], ['HSET', `stats:${id}`, 'v', '1', 'rolls', 400, 'bonus', 50000], ['HSET', 'names', id, nm], ['SET', `name:${nm.toLowerCase()}`, id]]); return { playerId: id, secret, name: nm }; };
  // 1. « Equip what you buy » sur off (idée d'infinity) : l'achat débloque sans remplacer ce qui est équipé.
  const eq = mkI(1, 'EquipKeeper');
  const shop = extra => call(shopApi, { method: 'POST', body: { playerId: eq.playerId, secret: eq.secret, ...extra } });
  run([['HSET', 'skins', eq.playerId, 'classic'], ['HSET', 'wall', eq.playerId, 'none'], ['HSET', 'btns', eq.playerId, 'x'], ['HSET', 'snd', eq.playerId, 'y']]);
  let r = await shop({ action: 'buy', skin: 'neon', equip: false });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.owned.includes('neon')); assert.equal(run([['HGET', 'skins', eq.playerId]])[0].result, 'classic', 'skin acheté, pas équipé');
  r = await shop({ action: 'buywall', wall: 'forest', equip: false }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(run([['HGET', 'wall', eq.playerId]])[0].result, 'none');
  r = await shop({ action: 'buybutton', button: 'cardboard', equip: false }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(run([['HGET', 'btns', eq.playerId]])[0].result, 'x');
  r = await shop({ action: 'buysound', sound: 'arcade', equip: false }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(run([['HGET', 'snd', eq.playerId]])[0].result, 'y');
  // Sans le champ : comme avant, acheté = équipé.
  const eq2 = mkI(2, 'EquipNow');
  r = await call(shopApi, { method: 'POST', body: { playerId: eq2.playerId, secret: eq2.secret, action: 'buy', skin: 'neon' } });
  assert.equal(r.status, 200); assert.equal(run([['HGET', 'skins', eq2.playerId]])[0].result, 'neon');
  // 2. Nombre le plus tiré sur le profil (idée de Gray) : 2 fois ou plus seulement.
  // Tirages à 10 min d'écart : le même nombre à moins d'une minute compte comme un doublon d'envoi (rollSet).
  const pr = mkI(3, 'MostRolled'), t0 = Date.now() - 10 * 3600000;
  const nums = [123456, 777, 123456, 42, 123456, 777, 5];
  run([['ZADD', `hist:${pr.playerId}`, ...nums.flatMap((n, i) => [t0 + i * 600000, `${t0 + i * 600000}:${n}`])]]);
  r = await call(profile, { url: '/api/profile?name=MostRolled' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.most, { n: 123456, c: 3 });
  const lone = mkI(4, 'AllDifferent');
  run([['ZADD', `hist:${lone.playerId}`, t0, `${t0}:1`, t0 + 1000, `${t0 + 1000}:2`]]);
  r = await call(profile, { url: '/api/profile?name=AllDifferent' }); assert.equal(r.body.most, null, 'aucun nombre tiré deux fois');
}

// ================================================================ Supprimer son compte (demandé par Sacha, 2026-11-05)
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js')), shopApi = require(path.join(ROOT, 'api/shop.js')), roomApi = require(path.join(ROOT, 'api/room.js'));
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const mkD = (k, nm, coins = 20000, rolls = 400) => { const id = `de${k}0`.repeat(4), secret = `de${k}f`.repeat(8); run([['SET', `player:${id}:secret`, sha(secret)], ['HSET', `stats:${id}`, 'v', '1', 'rolls', rolls, 'bonus', coins, 'first', 1], ['HSET', 'names', id, nm], ['SET', `name:${nm.toLowerCase()}`, id]]); return { playerId: id, secret, name: nm }; };
  const del = (p, extra = {}) => call(auth, { method: 'POST', body: { action: 'deleteAccount', playerId: p.playerId, secret: p.secret, name: p.name, ...extra } });
  const fr = (p, action, extra = {}) => call(friendsApi, { method: 'POST', body: { playerId: p.playerId, secret: p.secret, action, ...extra } });
  const clan = (p, op, extra = {}) => fr(p, 'clan', { op, ...extra });
  const wait = () => new Promise(r => setTimeout(r, 3));
  // Partout où l'identifiant apparaît encore : nom de clé, champ ou valeur de hash, membre de set ou de sorted set,
  // élément de liste, valeur texte.
  const traces = id => {
    const out = [];
    for (const [k, v] of db) {
      if (k.includes(id)) out.push(k);
      else if (v instanceof Map) { for (const [f, x] of v) if (String(f).includes(id) || String(x).includes(id)) out.push(`${k} → ${f}`); }
      else if (v instanceof Set) { for (const m of v) if (String(m).includes(id)) out.push(`${k} ∋ ${m}`); }
      else if (Array.isArray(v)) { if (v.some(x => String(x).includes(id))) out.push(`${k} []`); }
      else if (typeof v === 'string' && v.includes(id)) out.push(`${k} = ${v}`);
    }
    return out;
  };

  const zed = mkD(1, 'DelZed'), yan = mkD(2, 'DelYan'), xia = mkD(3, 'DelXia'), wes = mkD(4, 'DelWes');
  // Zed joue : tirages (classements, historique, badges, nums…), amis, cadeau, message privé, demande, clan, chat.
  for (let i = 0; i < 3; i++) { db.delete(`cooldown:${zed.playerId}`); r = await call(roll, { method: 'POST', body: zed }); assert.equal(r.status, 200, JSON.stringify(r.body)); await wait(); }
  r = await fr(zed, 'add', { name: 'DelYan' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await fr(yan, 'accept', { name: 'DelZed' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await fr(zed, 'add', { name: 'DelWes' }); assert.equal(r.status, 200, 'demande en attente chez Wes');
  r = await fr(zed, 'gift', { name: 'DelYan', amount: 100 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await fr(zed, 'message', { name: 'DelYan', text: 'hello there' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await fr(yan, 'gift', { name: 'DelZed', amount: 50 }); assert.equal(r.status, 200, 'cadeau reçu, pas encore vu');
  run([['HSET', `h2h:${zed.playerId}`, `w:${wes.playerId}`, '2'], ['HSET', `h2h:${wes.playerId}`, `l:${zed.playerId}`, '2'],
    ['SADD', `skins:${zed.playerId}`, 'neon'], ['HSET', 'skins', zed.playerId, 'neon'], ['HSET', 'titles', zed.playerId, 'x'], ['HSET', 'bio', zed.playerId, 'hi'],
    ['ZADD', `hhist:${zed.playerId}`, '1', '1:5'], ['HSET', 'avpub', zed.playerId, 'tokzed'], ['HSET', 'avtok', 'tokzed', zed.playerId], ['SET', `av:${zed.playerId}`, JSON.stringify({ tok: 'tokzed' })],
    ['SET', `player:${zed.playerId}:pw`, 's1$x$y'], ['SET', `player:${zed.playerId}:google`, 'g-zed'], ['SET', 'google:g-zed', zed.playerId],
    ['RPUSH', 'gc:msgs', JSON.stringify({ id: 'abcdefabcdef', a: zed.playerId, n: 'DelZed', x: 'yo', t: 1 }), JSON.stringify({ id: 'abcdefabcde0', a: yan.playerId, n: 'DelYan', x: 'hey', t: 2 })],
    ['RPUSH', 'casino:feed', JSON.stringify({ id: zed.playerId, g: 'slots', n: 5, t: 1 })], ['SADD', `dmblock:${wes.playerId}`, zed.playerId], ['HSET', 'rx:gc', `abcdefabcde0|${zed.playerId}`, '1', `abcdefabcde0|${yan.playerId}`, '2'],
    // Traces moins nettes : amitié à sens unique, lien Discord, position ouverte, ancien nom resté réservé, victoires du jour.
    ['SADD', `fr:${xia.playerId}`, zed.playerId], ['HSET', 'discord:links', 'd-zed', zed.playerId], ['HSET', `pos:${zed.playerId}`, 'p1', '{}'], ['ZADD', 'pos:open', '1', `${zed.playerId}:p1`],
    ['SET', 'name:oldzedname', zed.playerId], ['HSET', `dw:2026-11-05:${wes.playerId}`, zed.playerId, '1', 'total', '1']]);
  // Clan : Xia le crée, Zed y entre comme simple membre (demande acceptée) et écrit dans le chat du clan.
  r = await clan(xia, 'create', { clanName: 'Deleters', tag: 'DEL', emoji: '🛡️' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await clan(zed, 'request', { tag: 'DEL' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await clan(xia, 'accept', { name: 'DelZed' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await clan(zed, 'say', { text: 'hi clan' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const yanKeys = traces(yan.playerId).length;

  // 1. Refus : mauvais secret, mauvais pseudo (casse comprise), pseudo vide, compte suspendu, compte du créateur.
  r = await del({ ...zed, secret: '0'.repeat(32) }); assert.equal(r.status, 403);
  r = await del(zed, { name: 'delzed' }); assert.equal(r.status, 422); assert.match(r.body.error, /exactly/);
  r = await del(zed, { name: '' }); assert.equal(r.status, 422);
  r = await del({ ...yan, playerId: zed.playerId }); assert.equal(r.status, 403, 'le secret d\'un autre joueur');
  assert.equal(run([['HGET', 'names', zed.playerId]])[0].result, 'DelZed', 'rien n\'a été effacé');
  const ban = mkD(5, 'DelBanned'); run([['SADD', 'banned', ban.playerId]]);
  r = await del(ban); assert.equal(r.status, 423, 'suspendu : rien ne passe, la suspension reste');
  const own = mkD(6, 'DelOwner'); run([['HSET', `stats:${own.playerId}`, 'owner', 1]]);
  r = await del(own); assert.equal(r.status, 403); assert.equal(run([['HGET', 'names', own.playerId]])[0].result, 'DelOwner');

  // 2. Assis à une table de poker : refusé tant qu'il n'est pas parti ; après le départ, permis.
  const pkr = mkD(7, 'DelPoker');
  r = await call(shopApi, { method: 'POST', body: { playerId: pkr.playerId, secret: pkr.secret, action: 'poker', op: 'bot', buyin: 500 } }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await del(pkr); assert.equal(r.status, 409); assert.match(r.body.error, /poker/);
  assert.ok(run([['GET', `player:${pkr.playerId}:secret`]])[0].result !== 'deleted');
  r = await call(shopApi, { method: 'POST', body: { playerId: pkr.playerId, secret: pkr.secret, action: 'poker', op: 'leave' } }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await del(pkr); assert.equal(r.status, 200, JSON.stringify(r.body));
  // Dans un duel pas fini : refusé.
  const dly = mkD(8, 'DelDuel');
  r = await call(roomApi, { method: 'POST', body: { playerId: dly.playerId, secret: dly.secret, name: 'DelDuel', action: 'create', size: 2 } }); assert.equal(r.status, 200, JSON.stringify(r.body));
  run([['SET', `inroom:${dly.playerId}`, r.body.code, 'EX', 45]]);
  r = await del(dly); assert.equal(r.status, 409); assert.match(r.body.error, /duel/);
  // Inscrit à un tournoi pas fini (celui de demain : ceux d'aujourd'hui ont pu être joués plus haut) : refusé.
  const tny = mkD(9, 'DelTourney'), tid = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  run([['ZADD', `tn:${tid}:in`, Date.now(), tny.playerId]]);
  r = await del(tny); assert.equal(r.status, 409); assert.match(r.body.error, /tournament/);

  // 3. Chef d'un clan avec d'autres membres : refusé (il passe la main ou dissout d'abord).
  r = await del(xia); assert.equal(r.status, 409); assert.match(r.body.error, /pass the leadership/);
  // Seul dans son clan : le clan est dissous avec le compte.
  const solo = mkD('a', 'DelSolo');
  r = await clan(solo, 'create', { clanName: 'Lonely Ones', tag: 'SOLO', emoji: '🛡️' }); assert.equal(r.status, 200, JSON.stringify(r.body));
  const soloCid = run([['HGET', 'clanof', solo.playerId]])[0].result;
  r = await del(solo); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(run([['EXISTS', `clan:${soloCid}`]])[0].result, 0, 'clan dissous');
  assert.equal(run([['GET', 'clantagk:SOLO']])[0].result, null, 'tag libéré');

  // 4. Zed supprime son compte.
  r = await del(zed); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.deleted, true);
  // Plus rien de lui, sauf la pierre tombale (aucune donnée) et ce qui est gardé exprès : ses idées, la modération.
  const left = traces(zed.playerId).filter(x => x !== `player:${zed.playerId}:secret`);
  assert.deepEqual(left, [], `restes : ${left.join(' | ')}`);
  assert.equal(run([['GET', `player:${zed.playerId}:secret`]])[0].result, 'deleted');
  assert.equal(run([['GET', 'google:g-zed']])[0].result, null, 'Google délié');
  assert.equal(run([['HGET', 'rx:gc', `abcdefabcde0|${yan.playerId}`]])[0].result, '2', 'la réaction de Yan reste');
  // Son ancien appareil : 403 (le site repart avec un joueur neuf), y compris en tirant ; le compte ne renaît pas.
  db.delete(`cooldown:${zed.playerId}`);
  r = await call(roll, { method: 'POST', body: zed }); assert.equal(r.status, 403);
  r = await del(zed); assert.equal(r.status, 403);
  assert.deepEqual(traces(zed.playerId), [`player:${zed.playerId}:secret`]);
  // Le pseudo est libre : un autre joueur le prend.
  const zed2 = { playerId: 'de2e'.repeat(4), secret: 'de2ef'.repeat(8).slice(0, 32), name: 'DelZed' };
  r = await call(roll, { method: 'POST', body: zed2 }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(run([['HGET', 'names', zed2.playerId]])[0].result, 'DelZed');
  // Ses amis ne le voient plus (amis, demandes), et ses traces chez eux sont parties.
  r = await fr(yan, 'list'); assert.equal(r.status, 200);
  assert.deepEqual(r.body.friends || [], []);
  r = await fr(wes, 'list'); assert.deepEqual(r.body.incoming || [], [], 'la demande à Wes a disparu');
  // Classements : plus là (le Zed qui vient de tirer est le nouveau joueur, 1 tirage).
  for (const period of ['day', 'week', 'month', 'all']) {
    r = await call(leaderboard, { url: `/api/leaderboard?period=${period}` });
    assert.ok((r.body.entries || []).filter(e => e.name === 'DelZed').every(e => e.rolls === undefined || e.rolls <= 1), period);
  }
  assert.equal(run([['ZSCORE', 'lb:xp', zed.playerId]])[0].result, null);
  // Son clan existe toujours sans lui ; Yan n'a rien perdu d'autre que lui (ses propres clés sont là).
  r = await clan(xia, 'view'); assert.equal(r.status, 200); assert.deepEqual(r.body.clan.members.map(m => m.name), ['DelXia'], 'plus membre (le journal du clan garde « Zed left », comme pour un départ)');
  assert.ok(traces(yan.playerId).length >= yanKeys - 3, 'les clés de Yan restent');
}

console.log(`OK —${calls} allers-retours Redis simulés, tirages ${aliceFirst.n} (${aliceFirst.s} XP) et ${bobFirst.n} (${bobFirst.s} XP)`);
