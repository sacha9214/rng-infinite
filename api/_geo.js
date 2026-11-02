// Pays d'un visiteur sans Vercel (demandé par Sacha, 2026-11-02 : « 13 000 visites sans pays » sur la page Owner).
// Depuis le passage du site sur le VPS (2026-10-21), plus aucune requête ne porte l'en-tête x-vercel-ip-country : toutes
// les visites tombaient dans « ZZ ». Ici, la base gratuite « IP to Country Lite » de DB-IP (licence CC BY 4.0, crédit
// affiché sur la page Owner), téléchargée chaque mois sur le VPS par deploy/ovh/geoip-update.sh.
// Le CSV (« début,fin,PAYS », ~730 000 plages) est converti une fois, au téléchargement, par tools/geoip-pack.mjs en un
// fichier binaire (~10 Mo) : le lire ne prend que quelques millisecondes. Lire le CSV ici bloquait le serveur ~3 s et
// prenait ~400 Mo.
// Fichier : RNG_GEOIP (par défaut ~/geo/dbip-country.bin). Rien n'est gardé de l'adresse : on en tire seulement le code
// du pays (api/site.js recordVisit). Relu quand le fichier change (vérifié au plus une fois par heure).
// Sans fichier (tests, poste de dev) : null, et la visite reste « ZZ » comme avant.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fileOf = () => process.env.RNG_GEOIP || path.join(os.homedir(), 'geo', 'dbip-country.bin');
const MAGIC = 'RNGGEO1\n';
const CHECK_MS = 3600000;
let db = null, mtime = 0, checkedAt = 0, loading = null;

// IPv4 → entier 32 bits ; IPv6 → les 64 bits de tête (les plages de DB-IP ne descendent pas sous /64).
function v4(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { const v = Number(x); if (!/^\d{1,3}$/.test(x) || v > 255) return null; n = n * 256 + v; }
  return n;
}
function v6(s) {
  if (!s.includes(':')) return null;
  let [head, tail] = s.split('::');
  if (s.split('::').length > 2) return null;
  const hs = head ? head.split(':') : [], ts = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined && hs.length !== 8) return null;
  if (hs.length + ts.length > (tail === undefined ? 8 : 7)) return null; // trop de groupes : adresse invalide
  const groups = tail === undefined ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  let n = 0n;
  for (let i = 0; i < 4; i++) n = (n << 16n) | BigInt(parseInt(groups[i], 16));
  return n;
}

// CSV → plages triées (utilisé par tools/geoip-pack.mjs).
function parse(text) {
  const v4rows = [], v6rows = [];
  for (const line of text.split('\n')) {
    const [a, b, c] = line.split(',');
    if (!c || !/^[A-Z]{2}$/.test(c.trim())) continue;
    const cc = c.trim();
    if (a.includes(':')) { const x = v6(a), y = v6(b); if (x !== null && y !== null) v6rows.push([x, y, cc]); }
    else { const x = v4(a), y = v4(b); if (x !== null && y !== null) v4rows.push([x, y, cc]); }
  }
  v4rows.sort((p, q) => p[0] - q[0]); v6rows.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
  return { v4rows, v6rows };
}
// Pays sur 2 octets (« FR » → 0x4652).
const code16 = cc => (cc.charCodeAt(0) << 8) | cc.charCodeAt(1);
const uncode16 = v => String.fromCharCode(v >> 8, v & 255);
// Format : MAGIC, n4 et n6 (UInt32), puis débuts et fins IPv6 (BigUInt64), débuts et fins IPv4 (UInt32), pays v6 et v4
// (UInt16) : les tableaux de 8 octets d'abord, chacun reste aligné.
function pack({ v4rows, v6rows }) {
  const n4 = v4rows.length, n6 = v6rows.length, head = Buffer.alloc(16);
  head.write(MAGIC, 0, 'latin1'); head.writeUInt32LE(n4, 8); head.writeUInt32LE(n6, 12);
  const s6 = BigUint64Array.from(v6rows.map(r => r[0])), e6 = BigUint64Array.from(v6rows.map(r => r[1]));
  const s4 = Uint32Array.from(v4rows.map(r => r[0])), e4 = Uint32Array.from(v4rows.map(r => r[1]));
  const c6 = Uint16Array.from(v6rows.map(r => code16(r[2]))), c4 = Uint16Array.from(v4rows.map(r => code16(r[2])));
  return Buffer.concat([head, ...[s6, e6, s4, e4, c6, c4].map(a => Buffer.from(a.buffer))]);
}
function unpack(buf) {
  if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('not a geoip file');
  const n4 = buf.readUInt32LE(8), n6 = buf.readUInt32LE(12);
  const ab = new ArrayBuffer(buf.length - 16); new Uint8Array(ab).set(buf.subarray(16)); // copie alignée
  let at = 0;
  const take = (T, n) => { const a = new T(ab, at, n); at += n * T.BYTES_PER_ELEMENT; return a; };
  const s6 = take(BigUint64Array, n6), e6 = take(BigUint64Array, n6), s4 = take(Uint32Array, n4), e4 = take(Uint32Array, n4);
  const c6 = take(Uint16Array, n6), c4 = take(Uint16Array, n4);
  return { s4, e4, c4, s6, e6, c6 };
}

// Dernière plage dont le début est ≤ x, si x est dedans (les plages sont triées et ne se chevauchent pas).
function find(starts, ends, codes, x) {
  let lo = 0, hi = starts.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= x) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at >= 0 && x <= ends[at] ? uncode16(codes[at]) : null;
}

async function load() {
  if (loading) return loading; // vérification ou chargement en cours : tout le monde attend le même
  if (Date.now() - checkedAt < CHECK_MS) return db;
  checkedAt = Date.now();
  loading = (async () => {
    const FILE = fileOf();
    let st;
    try { st = await fs.promises.stat(FILE); } catch (e) { return db; }
    if (!db || st.mtimeMs !== mtime) { db = unpack(await fs.promises.readFile(FILE)); mtime = st.mtimeMs; }
    return db;
  })().catch(err => { console.error('geoip', err.message); return db; }).finally(() => { loading = null; });
  return loading;
}

// Code pays à deux lettres de l'adresse, ou null (inconnue, privée, pas de base).
async function country(ip) {
  const d = await load();
  if (!d) return null;
  const a = String(ip || '').trim().replace(/^::ffff:/i, '');
  const x4 = v4(a);
  const cc = x4 !== null ? find(d.s4, d.e4, d.c4, x4) : (() => { const x6 = v6(a); return x6 === null ? null : find(d.s6, d.e6, d.c6, x6); })();
  return cc && cc !== 'ZZ' ? cc : null;
}

module.exports = { country, parse, pack, unpack, v4, v6, fileOf, _reset() { db = null; mtime = 0; checkedAt = 0; } };
