#!/usr/bin/env bash
# Pays des visiteurs (Sacha, 2026-11-02) : télécharge la base gratuite « IP to Country Lite » de DB-IP (CC BY 4.0,
# https://db-ip.com, sans compte) et la convertit pour api/_geo.js. Sans mot de passe : tout reste dans ~/geo.
#   bash ~/rng-infinite/deploy/ovh/geoip-update.sh             met la base à jour (celle du mois, sinon celle d'avant)
#   bash ~/rng-infinite/deploy/ovh/geoip-update.sh --install   pareil, puis l'ajoute à la crontab d'emma (le 3 de chaque mois)
# Le serveur relit le fichier tout seul quand il change (au plus une heure après) : pas de redémarrage.
set -euo pipefail
DIR="$HOME/geo"
REPO="$HOME/rng-infinite"
mkdir -p "$DIR"
cd "$DIR"

got=""
for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m)"; do
  url="https://download.db-ip.com/free/dbip-country-lite-$month.csv.gz"
  if curl -fsS --max-time 120 -o "dbip-country-lite.csv.gz.tmp" "$url"; then got="$month"; break; fi
done
if [ -z "$got" ]; then echo "$(date -u +%F) DB-IP download failed, kept the old file"; rm -f dbip-country-lite.csv.gz.tmp; exit 1; fi
mv dbip-country-lite.csv.gz.tmp dbip-country-lite.csv.gz
node "$REPO/tools/geoip-pack.mjs" "$DIR/dbip-country-lite.csv.gz" "$DIR/dbip-country.bin"
echo "$(date -u +%F) DB-IP $got installed"

if [ "${1:-}" = "--install" ]; then
  line="17 4 3 * * bash $REPO/deploy/ovh/geoip-update.sh >> $DIR/update.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'geoip-update.sh' || true; echo "$line" ) | crontab -
  echo "Monthly update added to the crontab"
fi
