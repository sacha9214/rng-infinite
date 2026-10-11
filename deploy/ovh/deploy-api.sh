#!/usr/bin/env bash
# Met à jour l'API sur le VPS après un push (aucun mot de passe : le service tourne sous notre utilisateur).
#   ssh emma@<vps> 'bash ~/rng-infinite/deploy/ovh/deploy-api.sh'
set -euo pipefail
cd "$(dirname "$0")/../.."

before="$(git rev-parse --short HEAD)"
git fetch -q origin main
git merge -q --ff-only origin/main
after="$(git rev-parse --short HEAD)"

# Le nouveau code doit se charger avant de couper l'ancien : sinon on revient en arrière et on s'arrête là.
if ! PORT=0 node -e '
  process.env.RNG_REDIS_URL = "http://127.0.0.1:1"; process.env.RNG_REDIS_TOKEN = "check";
  for (const n of ["auth","friends","history","leaderboard","name","profile","quests","roll","room","shop","site","title"]) require("./api/" + n + ".js");
'; then
  git reset -q --hard "$before"
  echo "Le nouveau code ne se charge pas : retour à $before, service inchangé." >&2
  exit 1
fi

# SIGTERM : le serveur finit ses requêtes puis systemd le relance (1 s) avec le nouveau code.
pkill -TERM -u "$(id -u)" -f 'deploy/ovh/api-server.js' || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if out="$(curl -fs http://127.0.0.1:8787/health)"; then echo "$before -> $after  $out"; exit 0; fi
done
echo "L'API ne répond pas après la mise à jour (journalctl -u rng-api -n 50)." >&2
exit 1
