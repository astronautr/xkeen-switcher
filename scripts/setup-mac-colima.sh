#!/bin/bash
set -euo pipefail

BREW_PKGS=(colima docker docker-compose)
PLIST_PATH="/Library/LaunchDaemons/io.colima.default.plist"
COLIMA_BIN="/opt/homebrew/bin/colima"
CURRENT_USER="$(whoami)"
USER_HOME="$HOME"

echo "==> Installing Colima + Docker CLI via brew"
for p in "${BREW_PKGS[@]}"; do
  if ! brew list --formula "$p" >/dev/null 2>&1; then
    brew install "$p"
  else
    echo "    $p already installed"
  fi
done

echo "==> Writing LaunchDaemon plist: $PLIST_PATH"
sudo tee "$PLIST_PATH" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.colima.default</string>
  <key>ProgramArguments</key>
  <array>
    <string>${COLIMA_BIN}</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--cpu</string><string>1</string>
    <string>--memory</string><string>1</string>
    <string>--disk</string><string>10</string>
    <string>--mount-type</string><string>virtiofs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>UserName</key><string>${CURRENT_USER}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${USER_HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>${USER_HOME}/Library/Logs/colima.log</string>
  <key>StandardErrorPath</key><string>${USER_HOME}/Library/Logs/colima.err</string>
</dict>
</plist>
EOF

sudo chown root:wheel "$PLIST_PATH"
sudo chmod 644 "$PLIST_PATH"

echo "==> Stopping any user-started colima (so launchd can take over)"
colima stop 2>/dev/null || true

echo "==> Loading LaunchDaemon"
sudo launchctl bootout system "$PLIST_PATH" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST_PATH"

echo "==> Waiting for Colima/Docker to become available (up to 120s)"
for _ in $(seq 1 120); do
  if docker info >/dev/null 2>&1; then
    echo "    Docker is up"
    break
  fi
  sleep 1
done

docker context use colima || true
echo "==> Done. Verify: docker info"
