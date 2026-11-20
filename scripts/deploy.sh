#!/bin/bash
# Sync code dev → server and rebuild container.
# First-time setup: ssh to server and run ./scripts/bootstrap-server.sh.

set -euo pipefail
SERVER="${1:?usage: deploy.sh <server>}"
ROUTING_UPGRADE="${2:-}"
case "$ROUTING_UPGRADE" in ''|--with-routing-helper) :;; *) echo 'Unknown option' >&2; exit 1;; esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Relative to the remote user's home. Keep the original default for existing installs.
DEPLOY_DIR="${XK_DEPLOY_DIR:-xkeen}"
if [[ ! "$DEPLOY_DIR" =~ ^[a-zA-Z0-9_-]+(/[a-zA-Z0-9_.-]+)*$ ]] || [[ "/$DEPLOY_DIR/" == *"/../"* ]]; then
  echo 'XK_DEPLOY_DIR must be a safe path relative to the remote home directory' >&2
  exit 1
fi

rsync -avz --delete \
  --exclude=data --exclude=.venv --exclude=__pycache__ \
  --exclude=.pytest_cache --exclude=tmp-data --exclude=.git \
  --exclude=.env --exclude=ssh \
  --exclude=node_modules --exclude=frontend/dist --exclude=frontend/storybook-static --exclude=test-results --exclude=playwright-report \
  --exclude=.agents --exclude=.codex --exclude=.cursor --exclude=skills.lock.toml \
  "$PROJECT_ROOT/" "$SERVER:~/$DEPLOY_DIR/"

if [ "$ROUTING_UPGRADE" = --with-routing-helper ]; then
  ssh "$SERVER" "bash -lc 'cd ~/$DEPLOY_DIR && ./scripts/deploy-local.sh --with-routing-helper'"
else
  ssh "$SERVER" "bash -lc 'cd ~/$DEPLOY_DIR && ./scripts/deploy-local.sh'"
fi
