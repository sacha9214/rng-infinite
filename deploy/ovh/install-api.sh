#!/usr/bin/env bash
# Installe l'API de RNG∞ sur le VPS (à côté de la base) : Node, le service systemd rng-api, et la route /api/* dans Caddy.
# À lancer sur le serveur :   bash ~/rng-infinite/deploy/ovh/install-api.sh
# Idempotent. Aucun secret à saisir : le service lit le jeton du relais dans son fichier.
set -euo pipefail

DOMAIN="${DOMAIN:-db.rng-infinite.com}"
USER_NAME="$(id -un)"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8787

echo "== 1/4 Node.js"
if ! command -v node >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq nodejs
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) { console.error("Node 18 ou plus récent requis"); process.exit(1) }'
echo "   node $(node -v)"

echo "== 2/4 Service rng-api"
sudo tee /etc/systemd/system/rng-api.service >/dev/null <<UNIT
[Unit]
Description=RNG∞ - API du jeu (Node)
After=network.target rng-relay.service
Wants=rng-relay.service

[Service]
User=$USER_NAME
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=RNG_REDIS_URL=http://127.0.0.1:7379
Environment=RNG_REDIS_TOKEN_FILE=/etc/rng-relay/token
Environment=KOFI_RELAYED=1
ExecStart=$(command -v node) $REPO/deploy/ovh/api-server.js
Restart=always
RestartSec=1
NoNewPrivileges=true
MemoryMax=600M

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable rng-api >/dev/null 2>&1
sudo systemctl restart rng-api

echo "== 3/4 Caddy : $DOMAIN/api/* vers l'API, le reste vers la base (ancien fichier gardé en .bak)"
sudo cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
sudo tee /etc/caddy/Caddyfile.new >/dev/null <<CADDY
$DOMAIN {
	encode gzip
	@api path /api/* /health
	handle @api {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
		reverse_proxy 127.0.0.1:7379
	}
}
CADDY
if sudo caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1; then
  sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  sudo systemctl reload caddy
else
  sudo rm -f /etc/caddy/Caddyfile.new
  echo "   Configuration Caddy refusée : rien n'a été changé côté Caddy." >&2
  exit 1
fi

echo "== 4/4 Vérifications"
sleep 2
systemctl is-active rng-api
curl -s "http://127.0.0.1:$PORT/health" && echo
curl -s "https://$DOMAIN/health" && echo
echo
echo "Terminé. L'API répond sur https://$DOMAIN/api/…"
