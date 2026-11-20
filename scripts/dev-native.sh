#!/bin/bash
# Synthetic backend only. Real router/environment configuration is never loaded.
set -euo pipefail
cd "$(dirname "$0")/.."
export UI_BACKEND_PORT="${UI_BACKEND_PORT:-8765}"
export UI_DEV_PORT="${UI_DEV_PORT:-8766}"
exec "${UI_PYTHON:-.venv/bin/python}" -m tests.ui_support.dev --port "$UI_BACKEND_PORT"
