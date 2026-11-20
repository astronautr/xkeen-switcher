#!/bin/bash
# Run on the application server. Installs helpers; does not apply routing/restart XKeen.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
# Dotenv is not shell code: passwords/URLs may contain literal $, spaces or quotes.
# Read the same resolved values used by the application without eval/source.
command -v python3 >/dev/null || { echo 'python3 is required to read Compose configuration' >&2; exit 1; }
COMPOSE_CONFIG=$(docker compose --env-file .env config --format json)
compose_value() {
  printf '%s' "$COMPOSE_CONFIG" | python3 -c 'import json,sys; value=json.load(sys.stdin)["services"]["xk-switcher"]["environment"].get(sys.argv[1]); sys.stdout.write("" if value is None else str(value))' "$1"
}
ROUTER_HOST="$(compose_value ROUTER_HOST)"
ROUTER_USER="$(compose_value ROUTER_USER)"
ROUTER_PORT="$(compose_value ROUTER_PORT)"
SSH_PASSWORD="$(compose_value SSH_PASSWORD)"
unset COMPOSE_CONFIG
ROUTER_HOST="${ROUTER_HOST:?ROUTER_HOST missing}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PORT="${ROUTER_PORT:-22}"
SSH_PASSWORD="${SSH_PASSWORD:?SSH_PASSWORD missing}"
export SSHPASS="$SSH_PASSWORD"
REMOTE=(sshpass -e ssh -o UserKnownHostsFile=ssh/xk_known_hosts -o StrictHostKeyChecking=yes -p "$ROUTER_PORT" "$ROUTER_USER@$ROUTER_HOST")
if [ "${1:-}" = "--install-deps" ]; then
  "${REMOTE[@]}" 'PATH=/opt/bin:/opt/sbin:$PATH
    if ! command -v setsid >/dev/null && ! command -v daemonize >/dev/null; then
      opkg update || echo "Some OPKG feeds are unavailable; trying daemonize from available package lists" >&2
      opkg install daemonize || exit 1
      command -v daemonize >/dev/null || exit 1
    fi
    if ! /opt/bin/python3 -c "import fcntl, hashlib, json, subprocess, tarfile, tempfile, uuid, zlib" 2>/dev/null; then
      opkg update || echo "Trying cached Entware package lists" >&2
      opkg install python3 || exit 1
      /opt/bin/python3 -c "import fcntl, hashlib, json, subprocess, tarfile, tempfile, uuid, zlib" || exit 1
    fi'
fi
"${REMOTE[@]}" 'PATH=/opt/bin:/opt/sbin:$PATH; set -e
  command -v setsid >/dev/null || command -v daemonize >/dev/null || { echo "Run installer with --install-deps (Entware daemonize is required)" >&2; exit 1; }
  test ! -d /opt/var/lib/xk-switcher/routing/lock || { echo "Routing operation/recovery in progress; refusing helper upgrade" >&2; exit 1; }
  test -f /opt/etc/xray/configs/05_routing.json
  test -d /opt/etc/xray/dat
  command -v sha256sum >/dev/null
  command -v mktemp >/dev/null
  command -v nohup >/dev/null
  command -v tar >/dev/null
  XRAY_LOCATION_ASSET=/opt/etc/xray/dat xray run -test -confdir /opt/etc/xray/configs'
"${REMOTE[@]}" 'PATH=/opt/bin:/opt/sbin:$PATH; set -e; umask 077; mkdir -p /opt/var/lib/xk-switcher/routing
  if command -v fsync >/dev/null 2>&1; then fsync /opt/var/lib/xk-switcher/routing /opt/var/lib/xk-switcher /opt/var/lib; else sync; fi
  mkdir /opt/var/lib/xk-switcher/routing/lock; printf "%s\n" helper-install > /opt/var/lib/xk-switcher/routing/lock/owner'
release_install_lock() {
  "${REMOTE[@]}" 'lock=/opt/var/lib/xk-switcher/routing/lock; if [ "$(cat "$lock/owner" 2>/dev/null)" = helper-install ]; then rm -f "$lock/owner"; rmdir "$lock"; fi' || true
}
trap release_install_lock EXIT
install_file() {
  local source_file=$1 remote_file=$2 validate="sh -n"
  if [[ "$source_file" == *.py ]]; then
    validate='if [ -x /opt/bin/python3 ]; then /opt/bin/python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$1"; fi'
    validate="sh -c '$validate' sh"
  fi
  "${REMOTE[@]}" "PATH=/opt/bin:/opt/sbin:\$PATH; set -e; umask 077; cat > '$remote_file.new'; $validate '$remote_file.new'; chmod 755 '$remote_file.new'; if [ -f '$remote_file' ]; then cp -p '$remote_file' '$remote_file.previous'; fi
    if command -v fsync >/dev/null 2>&1; then fsync '$remote_file.new'; if [ -f '$remote_file.previous' ]; then fsync '$remote_file.previous'; fi; else sync; fi
    mv '$remote_file.new' '$remote_file'
    if command -v fsync >/dev/null 2>&1; then fsync '${remote_file%/*}'; else sync; fi" < "$source_file"
}
install_file router/xk-update.py /opt/bin/xk-update
install_file router/xk-update-recovery.sh /opt/bin/xk-update-recovery
install_file router/S04xk-routing /opt/etc/init.d/S04xk-routing
install_file router/S06xk-routing /opt/etc/init.d/S06xk-routing
install_file router/xk-routing.sh /opt/bin/xk-routing
install_file router/xk-apply.sh /opt/bin/xk-apply
CAPABILITIES=$("${REMOTE[@]}" '/opt/bin/xk-routing capabilities')
printf '%s\n' "$CAPABILITIES"
printf '%s' "$CAPABILITIES" | python3 -c 'import json,sys; caps=json.load(sys.stdin); sys.exit(0 if caps.get("ready") and caps.get("version") == 3 and caps.get("selective") else 1)' || { echo 'Helper v3 selective transaction readiness check failed' >&2; exit 1; }
echo 'Routing helpers installed. Configuration was not changed; XKeen was not restarted.'
