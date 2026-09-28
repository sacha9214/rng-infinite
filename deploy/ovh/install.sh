#!/usr/bin/env bash
# Installe la base de données de RNG∞ sur le VPS : Redis (local uniquement) + relais compatible Upstash + Caddy (HTTPS).
# À lancer sur le serveur, depuis ce dossier :   bash install.sh
# Idempotent : on peut le relancer après une mise à jour du relais.
set -euo pipefail

DOMAIN="${DOMAIN:-db.rng-infinite.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(id -un)"

echo "== 1/6 Paquets (Redis, Caddy)"
sudo apt-get update -qq
sudo apt-get install -y -qq redis-server caddy curl

echo "== 2/6 Redis : écoute locale seulement, données gardées sur disque"
sudo install -d -m 755 /etc/redis/redis.conf.d 2>/dev/null || true
sudo tee /etc/redis/rng.conf >/dev/null <<'CONF'
bind 127.0.0.1 -::1
protected-mode yes
port 6379
appendonly yes
appendfsync everysec
save 3600 1 300 100 60 10000
maxmemory 1gb
maxmemory-policy noeviction
CONF
grep -q '^include /etc/redis/rng.conf' /etc/redis/redis.conf || echo 'include /etc/redis/rng.conf' | sudo tee -a /etc/redis/redis.conf >/dev/null
sudo systemctl enable --now redis-server
sudo systemctl restart redis-server

echo "== 3/6 Jeton secret du relais (créé une seule fois)"
sudo install -d -m 750 -o root -g "$USER_NAME" /etc/rng-relay
if ! sudo test -s /etc/rng-relay/token; then
  openssl rand -hex 32 | sudo tee /etc/rng-relay/token >/dev/null
fi
sudo chown root:"$USER_NAME" /etc/rng-relay/token
sudo chmod 640 /etc/rng-relay/token

echo "== 4/6 Relais (service systemd)"
sudo install -d -m 755 /opt/rng-relay
sudo install -m 755 "$HERE/redis-relay.py" /opt/rng-relay/redis-relay.py
sudo tee /etc/systemd/system/rng-relay.service >/dev/null <<UNIT
[Unit]
Description=RNG∞ - relais HTTP compatible Upstash devant Redis
After=network.target redis-server.service
Requires=redis-server.service

[Service]
User=$USER_NAME
Environment=RELAY_PORT=7379
Environment=RELAY_TOKEN_FILE=/etc/rng-relay/token
ExecStart=/usr/bin/python3 /opt/rng-relay/redis-relay.py
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now rng-relay
sudo systemctl restart rng-relay

echo "== 5/6 Caddy : HTTPS automatique sur $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:7379
}
CADDY
if command -v ufw >/dev/null && sudo ufw status | grep -q 'Status: active'; then
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "== 6/6 Sauvegarde quotidienne de la base (14 jours gardés, dans ~/rng-backups)"
sudo tee /etc/cron.daily/rng-redis-backup >/dev/null <<CRON
#!/bin/sh
redis-cli BGSAVE >/dev/null; sleep 20
install -d -o $USER_NAME -m 750 /home/$USER_NAME/rng-backups
cp /var/lib/redis/dump.rdb /home/$USER_NAME/rng-backups/dump-\$(date +%F).rdb
chown $USER_NAME /home/$USER_NAME/rng-backups/*.rdb
find /home/$USER_NAME/rng-backups -name 'dump-*.rdb' -mtime +14 -delete
CRON
sudo chmod 755 /etc/cron.daily/rng-redis-backup

echo
echo "== Vérifications"
redis-cli ping
curl -s http://127.0.0.1:7379/health && echo
echo
echo "Terminé. Il reste :"
echo "  1. DNS : un enregistrement A  db  →  $(curl -s -4 ifconfig.me 2>/dev/null || echo 'IP du VPS')  (dans Vercel → Domains → rng-infinite.com → DNS)"
echo "  2. Copier les données d'Upstash : python3 migrate.py   (voir le README de ce dossier)"
echo "  3. Dans Vercel, remplacer KV_REST_API_URL par https://$DOMAIN et KV_REST_API_TOKEN par le jeton :"
echo "       sudo cat /etc/rng-relay/token"
