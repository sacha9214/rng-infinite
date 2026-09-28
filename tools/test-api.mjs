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

console.log(`OK —${calls} allers-retours Redis simulés, tirages ${aliceFirst.n} (${aliceFirst.s} XP) et ${bobFirst.n} (${bobFirst.s} XP)`);
