// Serveur de dev : le site + les fonctions /api, avec une base Redis en mémoire (aucun compte nécessaire).
//   node tools/dev.mjs   →   http://localhost:8124
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeRedis } from './fake-redis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8124);
const require = createRequire(import.meta.url);

// Les fonctions parlent à "Upstash" : on intercepte ces appels vers le faux Redis, le reste passe (clés Google…).
process.env.KV_REST_API_URL = 'http://fake-redis.local';
process.env.KV_REST_API_TOKEN = 'dev';
const memory = fakeRedis();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => (url === 'http://fake-redis.local/pipeline'
  ? Promise.resolve({ ok: true, json: async () => memory.run(JSON.parse(opts.body)) })
  : realFetch(url, opts));

const API = Object.fromEntries(['roll', 'leaderboard', 'auth', 'history', 'name', 'profile', 'room', 'title', 'shop'].map(name => [name, require(path.join(ROOT, `api/${name}.js`))]));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const handler = API[url.pathname.slice(5)];
    if (!handler) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw ? JSON.parse(raw) : {};
    return handler(req, res);
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    // Plages d'octets, comme en production : sans elles on ne peut pas se déplacer dans la vidéo, et Safari refuse de la lire.
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = stat.size - 1;
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else start = Math.max(0, stat.size - Number(range[2])); // « -500 » : les 500 derniers octets
      if (start > end) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${stat.size}`); return res.end(); }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD' || !stat.size) return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}).listen(PORT, () => console.log(`RNG∞ dev : http://localhost:${PORT} (API + Redis en mémoire)`));
