// Convertit la base gratuite « IP to Country Lite » de DB-IP (CSV, gzip ou non) en fichier binaire pour api/_geo.js.
//   node tools/geoip-pack.mjs <dbip-country-lite.csv.gz> <dbip-country.bin>
// Lancé chaque mois par deploy/ovh/geoip-update.sh, sur le VPS (Sacha, 2026-11-02 : pays des visiteurs).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Geo = require('../api/_geo.js');
const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('Usage: node tools/geoip-pack.mjs <in.csv.gz> <out.bin>'); process.exit(1); }
const raw = fs.readFileSync(src);
const text = (src.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
const rows = Geo.parse(text);
if (rows.v4rows.length < 100000) { console.error(`Only ${rows.v4rows.length} IPv4 ranges: file looks broken, kept the old one`); process.exit(1); }
fs.writeFileSync(`${out}.tmp`, Geo.pack(rows));
fs.renameSync(`${out}.tmp`, out); // remplacé d'un coup : le serveur ne lit jamais un fichier à moitié écrit
console.log(`${out}: ${rows.v4rows.length} IPv4 + ${rows.v6rows.length} IPv6 ranges`);
