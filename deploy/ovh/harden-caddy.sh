#!/usr/bin/env bash
# Durcit la configuration Caddy du site (audit de sécurité demandé par Sacha, 2026-11-02) :
#   - ne sert plus les notes internes (*.md : CLAUDE.md, HANDOFF.md, README.md) ni roblox/ ;
#   - ajoute les en-têtes de sécurité : HTTPS obligatoire (HSTS), pas d'affichage dans le cadre d'un autre site
#     (anti-clickjacking), pas de devinette du type des fichiers, adresse d'origine réduite, ni caméra, ni micro, ni
#     position demandés.
# Demande le mot de passe sudo une fois. Garde l'ancienne configuration (Caddyfile.bak-<date>) et ne remplace rien si
# Caddy refuse la nouvelle.
#   bash ~/rng-infinite/deploy/ovh/harden-caddy.sh
set -euo pipefail
FILE=/etc/caddy/Caddyfile
NEW=$(mktemp)
sudo cp "$FILE" "$FILE.bak-$(date -u +%Y%m%d%H%M)"

sudo cat "$FILE" | python3 -c '
import sys
s = sys.stdin.read()
old_hidden = "@hidden path /.git* /deploy/* /tools/* /node_modules/* /.claude/*"
new_hidden = "@hidden path /.git* /deploy/* /tools/* /node_modules/* /.claude/* /*.md /roblox/* /integration-review/* /skin-previews*"
if old_hidden in s:
    s = s.replace(old_hidden, new_hidden)
elif "/*.md" not in s:
    sys.exit("hidden-path line not found: nothing changed")
headers = """	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		-Server
	}
"""
site = "rng-infinite.com, www.rng-infinite.com {\n\tencode gzip\n"
if site in s and "X-Frame-Options" not in s:
    s = s.replace(site, site + headers)
sys.stdout.write(s)
' > "$NEW"

if sudo caddy validate --config "$NEW" --adapter caddyfile >/dev/null 2>&1; then
  sudo cp "$NEW" "$FILE"
  sudo systemctl reload caddy
  echo "Caddy hardened and reloaded."
else
  echo "Caddy refused the new config: nothing changed." >&2
  exit 1
fi
rm -f "$NEW"
