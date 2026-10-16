import fs from 'node:fs';
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
// Changer de nom libère l'ancien ; le classement affiche le nouveau.
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
let clock = 0;
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
assert.equal(Object.values(r.body.tiers).reduce((x, y) => x + y, 0), r.body.rolls);
assert.ok(r.body.luck >= 0 && r.body.luck <= 100);

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

// Limite par IP : au-delà de 300 requêtes par minute, 429 sans toucher à la base.
const ipHeaders = { 'x-forwarded-for': '203.0.113.7' };
let lastStatus = 0, before429 = calls;
for (let i = 0; i < 301; i++) lastStatus = (await call(roomApi, { url: '/api/room?code=ZZZZZ', headers: ipHeaders })).status;
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
  assert.match(run([['GET', 'lb:xp:migrated']])[0].result, /^6:[0-9a-f]{12}$/, 'rempli une seule fois, à la version des règles des badges');
  // Règles des badges changées (nouvelle empreinte) : l'XP à vie est recalculée depuis l'historique, plus l'ancien total.
  run([['SET', 'lb:xp:migrated', '5:00000000000a'], ['ZADD', 'lb:xp', 1, alice.playerId]]);
  r = await call(leaderboard, { url: '/api/leaderboard?period=xp' });
  assert.equal(r.body.entries.find(e => e.name === 'Alice').s, xpFromHistory(alice), 'recalculé après un changement de badges');
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

  // ============================================================== 23. Amis
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const fr = (who, action, name) => call(friendsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, name } });
  assert.equal((await call(friendsApi, { url: '/api/friends' })).status, 405, 'jamais en GET (le secret ne va pas dans une adresse)');
  assert.equal((await fr({ ...quinn, secret: '9'.repeat(32) }, 'list')).status, 403);
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
  assert.equal((await roomPost(w1, 'create', { size: 2, stake: 77 })).body.stake, 0, 'mise hors liste = pas de mise');
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
  const net = who => { const [b, s2] = run([['HGET', `stats:${who.playerId}`, 'bonus'], ['HGET', `stats:${who.playerId}`, 'spent']]).map(x => Number(x.result) || 0); return b - s2; };
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
  r = await site(boss, 'delete', { id: first.id });
  assert.equal(r.body.total, 5);
  assert.ok(!(await site(alice, 'mine')).body.mine.some(x => x.id === first.id), 'supprimée aussi chez le joueur');
  assert.equal((await site(boss, 'delete', { id: first.id })).status, 404);

  // Fréquentation : compteurs anonymes du jour.
  db.delete(`an:${today()}`);
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
  assert.ok(!JSON.stringify(an).includes('203.0.113'), 'aucune adresse IP stockée');
  // Pas plus de 60 balises par adresse et par heure (large : tout un collège peut partager la même adresse).
  for (let i = 0; i < 80; i++) await visit({ ref: 'spam.example' });
  assert.equal(Number(run([['HGET', `an:${today()}`, 'visits']])[0].result), 60, 'balises en trop ignorées, pas les 60 premières');
  // Un jour ne peut pas enfler : passé 400 champs, les origines inconnues vont dans « other ».
  run([['HSET', `an:${today()}`, ...Array.from({ length: 400 }, (_, i) => [`ref:filler${i}.example`, 1]).flat()]]);
  await site(null, 'visit', { ref: 'brand-new.example' }, { 'x-forwarded-for': '198.51.100.7' });
  assert.equal(run([['HGET', `an:${today()}`, 'ref:brand-new.example']])[0].result, null);
  assert.equal(run([['HGET', `an:${today()}`, 'ref:other']])[0].result, '1');
  r = await site(boss, 'stats');
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
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
  // Rafale : 12 messages par 30 s au plus, même en respectant l'écart entre deux messages.
  let statuses = [];
  for (let k = 0; k < 13; k++) await later(1300, async () => statuses.push((await say(frank, `message ${k}`)).status));
  assert.equal(statuses.filter(x => x === 200).length, 11, `11 de plus passent (12 avec le premier), puis 429 : ${statuses}`);
  assert.equal(statuses[statuses.length - 1], 429);
  r = await call(roomApi, { url: `/api/room?code=${code}&me=${frank.playerId}` });
  assert.equal(r.body.chat.length, 12);
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
  for (const g of [g1, g2, g4, g5, g6]) run([['HSET', `stats:${g.playerId}`, 'rolls', 400], ['HINCRBY', `stats:${g.playerId}`, 'bonus', 3000]]);
  run([['HINCRBY', `stats:${g3.playerId}`, 'bonus', 3000]]); // riche, mais un seul tirage
  // Amis : Gfgiver ↔ Gfgetter, Gfnewbie ↔ Gfgetter, Gfhelper ↔ Gfgetter, Gfextra ↔ Gfgetter. Gfstranger a seulement demandé.
  for (const g of [g1, g3, g5, g6]) { await fr(g, 'add', { name: 'Gfgetter' }); await fr(g2, 'accept', { name: g.name }); }
  await fr(g4, 'add', { name: 'Gfgetter' });
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  run([['DEL', `gift:${day}`]]);
  const before1 = await coinsOf(g1), before2 = await coinsOf(g2);
  // L'état de la liste dit ce qui reste à donner.
  r = await fr(g1, 'list');
  assert.deepEqual([r.body.gift.min, r.body.gift.max, r.body.gift.sendDay, r.body.gift.receiveDay, r.body.gift.rolls, r.body.gift.left, r.body.gift.coins], [10, 500, 1000, 2000, 300, 1000, before1]);
  // Un cadeau : débité d'un côté, crédité de l'autre, au même solde que la boutique.
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

// ================================================================ 54. Titre « 2026 » : débloqué par le badge Current Year
{
  const lib = require(path.join(ROOT, 'api/_lib.js'));
  const key = `stats:${alice.playerId}`;
  run([['HDEL', key, 'year2026']]);
  let r = await equip(alice, 'year2026');
  assert.equal(r.status, 422, 'verrouillé avant le badge');
  await lib.recordRoll(alice.playerId, 520269, Date.now());
  assert.equal(run([['HGET', key, 'year2026']])[0].result, '1');
  r = await equip(alice, 'year2026');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(run([['HGET', 'titles', alice.playerId]])[0].result, 'year2026');
  // Un nombre sans 2026 ne le donne pas.
  const Ach = require(path.join(ROOT, 'js/achievements.js'));
  assert.ok(!Ach.unlocked({ rolls: 5 }).includes('year2026'));
  assert.ok(Ach.unlocked({ year2026: 1 }).includes('year2026'));
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

// ================================================================ 51. Messages entre amis
{
  const friendsApi = require(path.join(ROOT, 'api/friends.js'));
  const fr = (who, action, name, extra = {}) => call(friendsApi, { method: 'POST', body: { playerId: who.playerId, secret: who.secret, action, name, ...extra } });
  const mk = (id, name) => ({ playerId: id.repeat(8), secret: (id + 'f').repeat(32).slice(0, 32), name });
  const ann = mk('3c', 'Annie'), ben = mk('4c', 'Benny'), cid = mk('5c', 'Cidney');
  for (const p of [ann, ben, cid]) { db.delete(`cooldown:${p.playerId}`); assert.equal((await call(roll, { method: 'POST', body: p })).status, 200); }
  // Pas encore amis : impossible d'écrire, même avec une demande en attente.
  assert.equal((await fr(ann, 'message', 'Benny', { text: 'hi' })).status, 403);
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

console.log(`OK —${calls} allers-retours Redis simulés, tirages ${aliceFirst.n} (${aliceFirst.s} XP) et ${bobFirst.n} (${bobFirst.s} XP)`);
