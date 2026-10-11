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

## The game API on the same server

The twelve `/api` functions also run here, as one Node process next to the database: no compute quota, and one
network hop fewer per call. The copy hosted with the site stays deployed as a fallback (the site switches to it
by itself for a minute when this server does not answer) and still receives the visit beacon (country lookup)
and the Ko-fi webhook.

| File | Role |
|---|---|
| `api-server.js` | Serves `api/*.js` unchanged on `127.0.0.1:8787` (JSON or form bodies, clean shutdown on SIGTERM) |
| `install-api.sh` | Installs Node, the systemd service `rng-api` and the Caddy route `/api/*` (asks for the sudo password once, no secret to type) |
| `deploy-api.sh` | Pulls `main`, checks that the new code loads, restarts the service (no password) |

Checked by `node tools/test-server.mjs` (real HTTP against the server with a fake relay).

1. On the VPS: `git clone https://github.com/sacha9214/rng-infinite ~/rng-infinite`, then `bash ~/rng-infinite/deploy/ovh/install-api.sh`.
2. Set `apiBase` in `js/config.js` to `https://db.rng-infinite.com`.
3. After each push that touches `api/` or the shared modules: `ssh <vps> 'bash ~/rng-infinite/deploy/ovh/deploy-api.sh'`.
