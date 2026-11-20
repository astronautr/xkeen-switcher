#!/bin/bash
# Rebuild and restart the container on the current machine.
# Run this ON the server after updating the code locally (git pull / edit in place).
# For pushing code from a dev machine, use ./scripts/deploy.sh <server> instead.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
case "${1:-}" in
  --with-routing-helper) ./scripts/install-routing-helper.sh --install-deps;;
  '') :;;
  *) echo 'Unknown option' >&2; exit 1;;
esac
docker compose --env-file .env up -d --build
