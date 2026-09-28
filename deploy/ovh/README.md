# Self-hosted database (OVH VPS)

Replaces Upstash with a Redis on our own VPS, behind a tiny relay that speaks the Upstash REST API
(`POST /pipeline`, `Authorization: Bearer <token>`), so the site code does not change: only the two Vercel
environment variables do.

| File | Role |
|---|---|
| `redis-relay.py` | Upstash-compatible HTTP relay in front of local Redis (stdlib only, admin commands refused) |
| `install.sh` | Installs Redis (localhost only, AOF + RDB), the relay (systemd `rng-relay`), Caddy (HTTPS) and a daily backup to `~/rng-backups` (14 days) |
| `migrate.py` | Copies every key (type + TTL) from Upstash to the VPS and checks the result |

Checked before shipping: `tools/relay-parity.mjs` replays the 4,300 Redis commands of the API test suite through
the relay and compares every reply with the test double (0 differences).

## Steps
1. On the VPS: `bash install.sh` (asks for the sudo password once).
2. DNS: `A db → <VPS IP>` in Vercel → Domains → rng-infinite.com.
3. When Upstash answers again: `UPSTASH_URL=… UPSTASH_TOKEN=… python3 migrate.py` on the VPS.
4. Vercel → Settings → Environment Variables: `KV_REST_API_URL=https://db.rng-infinite.com`,
   `KV_REST_API_TOKEN=$(sudo cat /etc/rng-relay/token)`; add `"regions": ["fra1"]` to `vercel.json`
   (functions next to the VPS in Zurich); redeploy.
