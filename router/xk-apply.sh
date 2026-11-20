#!/bin/sh
# Receives 04_outbounds.json on stdin, writes it atomically, restarts xkeen.
set -eu
if [ -x /opt/bin/xk-routing ]; then
    exec /opt/bin/xk-routing outbound
fi
CFG=/opt/etc/xray/configs/04_outbounds.json
TMP="${CFG}.new"
cat > "$TMP"
mv "$TMP" "$CFG"
xkeen -restart
