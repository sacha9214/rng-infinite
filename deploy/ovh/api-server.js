// L'API de RNG∞ sur notre VPS : les mêmes fonctions /api que sur Vercel, servies par un seul processus Node.
// Pas de quota de calcul, et la base est sur la même machine (un saut réseau de moins par appel).
//   node deploy/ovh/api-server.js      (service systemd rng-api, derrière Caddy : voir install-api.sh)
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 256 * 1024;

// La base : le relais local, avec son jeton lu dans le fichier que lui-même utilise (jamais écrit ailleurs).
// À faire avant de charger les fonctions : api/_lib.js lit ces variables au chargement.
if (!process.env.RNG_REDIS_URL) process.env.RNG_REDIS_URL = 'http://127.0.0.1:7379';
if (!process.env.RNG_REDIS_TOKEN && process.env.RNG_REDIS_TOKEN_FILE) {
  process.env.RNG_REDIS_TOKEN = fs.readFileSync(process.env.RNG_REDIS_TOKEN_FILE, 'utf8').trim();
}

const NAMES = ['auth', 'friends', 'history', 'leaderboard', 'name', 'profile', 'quests', 'roll', 'room', 'shop', 'site', 'title'];
const API = Object.fromEntries(NAMES.map(name => [name, require(path.join(ROOT, `api/${name}.js`))]));
let version = '';
try { version = fs.readFileSync(path.join(ROOT, '.git/refs/heads/main'), 'utf8').trim().slice(0, 7); } catch (e) { /* pas un dépôt */ }

function reply(res, status, body) {
  if (res.headersSent) return res.end();
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Le corps, comme Vercel le prépare : un objet. JSON quel que soit le Content-Type annoncé (le site envoie du
// text/plain depuis un autre domaine, pour éviter la requête de contrôle CORS), ou un formulaire (Ko-fi).
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  if (/^application\/x-www-form-urlencoded/i.test(req.headers['content-type'] || '')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch (e) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const pathname = String(req.url || '/').split('?')[0];
  try {
    if (pathname === '/health' || pathname === '/api/health') return reply(res, 200, { ok: true, version, up: Math.round(process.uptime()) });
    const handler = pathname.startsWith('/api/') ? API[pathname.slice(5)] : null;
    if (!handler) return reply(res, 404, { error: 'Not found' });
    req.body = req.method === 'POST' ? await readBody(req) : {};
    await handler(req, res);
  } catch (err) {
    if (!err.status) console.error(`${req.method} ${pathname}: ${err.stack || err}`);
    reply(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  } finally {
    const ms = Date.now() - started;
    if (ms > 2000) console.warn(`slow: ${req.method} ${pathname} ${ms} ms`);
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 65000;

// Une erreur perdue ne doit pas couper le jeu de tout le monde.
process.on('unhandledRejection', err => console.error('unhandledRejection:', err && err.stack || err));
process.on('uncaughtException', err => console.error('uncaughtException:', err && err.stack || err));

// Arrêt propre (mise à jour) : on finit les requêtes en cours, systemd relance aussitôt.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

// Positions à effet de levier : stop loss, take profit et liquidations vérifiés toutes les 15 s, même quand personne
// n'a le jeu ouvert (api/_lever.js).
const Lever = require(path.join(ROOT, 'api/_lever.js'));
setInterval(() => { Lever.tick().catch(err => console.error('lever tick:', err.message)); }, 15000).unref();
// Discord : nouveautés publiées au démarrage, podium du jour à minuit UTC (api/_discord_tasks.js).
require(path.join(ROOT, 'api/_discord_tasks.js')).start();

server.listen(PORT, HOST, () => console.log(`RNG∞ API ${version || '(dev)'} : http://${HOST}:${PORT}`));
