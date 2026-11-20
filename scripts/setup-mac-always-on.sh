#!/bin/bash
set -euo pipefail
echo "==> Disabling system sleep on power"
sudo pmset -c sleep 0 disksleep 0 displaysleep 10
echo "==> Enabling auto-restart after power failure"
sudo pmset -c autorestart 1
echo "==> Enabling Wake-on-LAN; disabling Power Nap"
sudo pmset -c womp 1 powernap 0
echo "==> Current power settings:"
pmset -g custom
cat <<EOF

Manual checklist (not automatable; requires System Settings):
  1. System Settings → Users & Groups → Automatic login: keep OFF (security)
  2. System Settings → Lock Screen → Require password: "Immediately"

EOF
