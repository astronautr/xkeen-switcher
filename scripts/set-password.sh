#!/bin/bash
# Set or recover the admin password without concurrent server writes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [ ! -t 0 ]; then
  echo "Run this command in an interactive terminal (use ssh -t remotely)." >&2
  exit 1
fi

docker compose build xk-switcher
docker compose stop xk-switcher
# Resume the service even if password entry is cancelled or fails.
trap 'docker compose up -d --no-build xk-switcher' EXIT
docker compose run --rm --no-deps xk-switcher python -m xk_switcher.auth set-password
