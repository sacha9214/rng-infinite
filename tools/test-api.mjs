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

// Fausse paire de clés "Google" : les jetons de test sont signés avec, et fetch sert la clé publique.
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const { privateKey: googlePrivate, publicKey: googlePublic } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...googlePublic.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

const { db, zset, run } = fakeRedis();
let calls = 0;
globalThis.fetch = async (url, opts) => {
  if (url === GOOGLE_CERTS_URL) return { ok: true, json: async () => ({ keys: [googleJwk] }) };
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
r = await call(history, { method: 'POST', body: { ...aliceTab, add: upload } });
assert.equal(r.body.stored, 2, 'doublons et entrées invalides ignorés');
assert.equal(r.body.rolls.length, before.length + 2);
assert.ok(r.body.rolls.every((x, i, all) => i === 0 || all[i - 1][1] <= x[1]), 'du plus ancien au plus récent');

r = await call(history, { method: 'POST', body: { ...aliceTab, add: [[42, t0]], fetch: false } });
assert.equal(r.body.stored, 0, 'renvoyer un tirage déjà connu ne crée pas de doublon');
assert.equal(r.body.rolls, undefined);
// Le même tirage à l'heure de l'appareil (0,7 s d'écart) n'est pas un nouveau tirage ; le même nombre 2 min plus tard, si.
r = await call(history, { method: 'POST', body: { ...aliceTab, add: [[42, t0 + 700], [42, t0 + 800]], fetch: false } });
assert.equal(r.body.stored, 0, 'même nombre à moins d\'une minute = même tirage');
r = await call(history, { method: 'POST', body: { ...aliceTab, add: [[42, t0 + 120000]], fetch: false } });
assert.equal(r.body.stored, 1, 'un vrai second 42 est gardé');

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
assert.deepEqual([r.body.size, r.body.mode, r.body.target], [10, 'rounds', 10]);
r = await roomPost(dave, 'create', { size: 1, mode: 'xp', target: 12345 });
assert.deepEqual([r.body.size, r.body.mode, r.body.target], [2, 'xp', 50000]);

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
  assert.equal(run([['GET', 'lb:xp:migrated']])[0].result, '2', 'rempli une seule fois');
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
  assert.equal(r.body.quests.length, 3, '3 quêtes par jour');
  assert.deepEqual(r.body.quests.map(q => q.id), Quests.ofDay(today()).map(q => q.id), 'les mêmes pour tout le monde');
  assert.deepEqual(new Set(Quests.ofDay(today()).map(q => q.group)), new Set(['rolls', 'rarity', 'duel']), 'une par groupe');
  assert.ok(r.body.quests.every(q => !q.claimed));
  assert.deepEqual([r.body.daily.claimed, r.body.daily.streak, r.body.daily.reward], [false, 0, 20]);
  const first = r.body.quests[0];
  // Pas finie : pas de récompense. Récompense d'une quête d'un autre jour : refusée.
  if (first.progress < first.target) assert.equal((await qPost(quinn, 'claim', { quest: first.id })).status, 422, 'quête pas finie');
  assert.equal((await qPost(quinn, 'claim', { quest: 'nope' })).status, 400);
  assert.equal((await qPost({ ...quinn, secret: '9'.repeat(32) }, 'claim', { quest: first.id })).status, 403);
  // Compteurs du jour remplis (comme après une grosse journée) : tout est réclamable, une seule fois.
  run([['HSET', `q:${today()}:${quinn.playerId}`, 'rolls', 40, 'xp', 200000, 't:uncommon', 8, 't:rare', 3, 't:epic', 1, 'duels', 3, 'duelWins', 1]]);
  let before = await coinsOf(quinn);
  r = await qPost(quinn, 'claim', { quest: first.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gained, first.reward);
  assert.equal(await coinsOf(quinn), before + first.reward, 'pièces créditées');
  assert.equal((await qPost(quinn, 'claim', { quest: first.id })).status, 422, 'une seule fois');
  assert.equal(await coinsOf(quinn), before + first.reward);
  assert.ok((await qGet(quinn)).body.quests[0].claimed);
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
    assert.equal(r.body.refund, r.body.duplicate ? 125 : 0, 'doublon : moitié rendue');
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
  // Le découpage : 9 001 Mythic, 900 Celestial, 90 Divine, 9 Infinite sur 1 000 001 nombres.
  const count = {};
  for (let n = 0; n <= 1000000; n++) { const k = tierOf(n); count[k] = (count[k] || 0) + 1; }
  assert.deepEqual([count.mythic, count.celestial, count.divine, count.infinite], [9001, 900, 90, 9]);
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
    await tick(); r = await g(frank, 'plinko', { bet: 100 });
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

console.log(`OK —${calls} allers-retours Redis simulés, tirages ${aliceFirst.n} (${aliceFirst.s} XP) et ${bobFirst.n} (${bobFirst.s} XP)`);
