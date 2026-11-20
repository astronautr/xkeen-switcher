#!/bin/bash
# One-time server bootstrap (password-auth to router).
#
# Keenetic dropbear silently rejects user ed25519 pubkeys on most builds;
# password auth via sshpass is the only reliable path. If your router is one
# of the rare builds that accepts keys, edit this file accordingly.
#
# Prereqs:
#   - ./.env exists (copy .env.example) with ROUTER_HOST, ROUTER_USER, SSH_PASSWORD
#   - sshpass installed (macOS: brew install hudochenkov/sshpass/sshpass,
#     Debian/Ubuntu: sudo apt install sshpass)
#   - docker + docker compose working

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ ! -f .env ]; then
  cat >&2 <<'EOF'
ERROR: .env missing. Create it first:

  cp .env.example .env
  chmod 600 .env
  # then set ROUTER_HOST, SSH_PASSWORD and SUB_URL

Then re-run this script.
EOF
  exit 1
fi

command -v sshpass >/dev/null || {
  echo "ERROR: sshpass not installed (macOS: brew install hudochenkov/sshpass/sshpass; Debian/Ubuntu: sudo apt install sshpass)" >&2
  exit 1
}
command -v python3 >/dev/null || { echo "ERROR: python3 is required to read Compose configuration" >&2; exit 1; }

# Dotenv is not shell code: read the values Compose resolves instead of sourcing .env.
COMPOSE_CONFIG=$(docker compose --env-file .env config --format json)
compose_value() {
  printf '%s' "$COMPOSE_CONFIG" | python3 -c 'import json,sys; value=json.load(sys.stdin)["services"]["xk-switcher"]["environment"].get(sys.argv[1]); sys.stdout.write("" if value is None else str(value))' "$1"
}
ROUTER_HOST="$(compose_value ROUTER_HOST)"
ROUTER_PORT="$(compose_value ROUTER_PORT)"
SSH_PASSWORD="$(compose_value SSH_PASSWORD)"
unset COMPOSE_CONFIG
ROUTER_HOST="${ROUTER_HOST:?ROUTER_HOST missing in .env}"
ROUTER_PORT="${ROUTER_PORT:-22}"
: "${SSH_PASSWORD:?SSH_PASSWORD missing in .env (Keenetic dropbear rejects ed25519 keys; password is the working path)}"
unset SSH_PASSWORD

mkdir -p ssh data
# Docker can create an empty dir at ssh/xk_known_hosts if compose starts before the file exists.
# Wipe the path so the redirection below creates a regular file.
[ -e ssh/xk_known_hosts ] && rm -rf ssh/xk_known_hosts

echo "==> Recording router host key → ssh/xk_known_hosts"
if ! ssh-keyscan -p "$ROUTER_PORT" -H "$ROUTER_HOST" > ssh/xk_known_hosts 2>"${TMPDIR:-/tmp}/xk-keyscan.err"; then
  echo "ERROR: ssh-keyscan failed. stderr:" >&2
  cat "${TMPDIR:-/tmp}/xk-keyscan.err" >&2
  exit 1
fi
if [ ! -s ssh/xk_known_hosts ]; then
  echo "ERROR: ssh-keyscan returned empty; check reachability to $ROUTER_HOST:$ROUTER_PORT" >&2
  exit 1
fi

echo "==> Installing router helpers"
./scripts/install-routing-helper.sh --install-deps

echo "==> Building and starting container"
docker compose --env-file .env up -d --build

sleep 3
HOST_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
HOST_IP="${HOST_IP:-<server-ip>}"

cat <<EOF

=================================================
 Ready. Open:
   http://${HOST_IP}:8080/

 Create the admin password on the first-run screen.
 Change it later in settings. Offline password recovery:
   ./scripts/set-password.sh
=================================================
EOF
