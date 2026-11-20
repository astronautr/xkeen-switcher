"""Generate the 04_outbounds.json body for a given Location."""
import copy
import json
from .subscription import Location

CHAIN_ENTRY_TAG = "xk-chain-entry"
VLESS_TAG = "vless-reality"
DIRECT_TAG = "direct"
BLOCK_TAG = "block"
FREEDOM_PROTOCOL = "freedom"
BLACKHOLE_PROTOCOL = "blackhole"
DEFAULT_FINGERPRINT = "chrome"
DEFAULT_MODE = "auto"
DEFAULT_PATH = "/"
NETWORK_XHTTP = "xhttp"

def build(loc: Location, entry: Location | None = None) -> str:
    proxy = _proxy_outbound(loc)
    nodes = [proxy]
    if entry is not None:
        if loc.code == entry.code:
            raise ValueError("Entry and exit locations must be different")
        inbound = _proxy_outbound(entry)
        inbound["tag"] = CHAIN_ENTRY_TAG
        proxy.setdefault("streamSettings", {}).setdefault("sockopt", {})["dialerProxy"] = CHAIN_ENTRY_TAG
        nodes.append(inbound)
    doc = {
        "outbounds": [
            *nodes,
            {"tag": DIRECT_TAG, "protocol": FREEDOM_PROTOCOL},
            {"tag": BLOCK_TAG, "protocol": BLACKHOLE_PROTOCOL},
        ]
    }
    return json.dumps(doc, indent=2, ensure_ascii=False)

def _proxy_outbound(loc: Location) -> dict:
    # JSON-subscription nodes carry a ready proxy outbound (any protocol);
    # pass it through, re-tagged to the tag 05_routing.json references.
    if loc.outbound:
        return {**copy.deepcopy(loc.outbound), "tag": VLESS_TAG}
    return _vless_outbound(loc)

def _vless_outbound(loc: Location) -> dict:
    user = {"id": loc.uuid, "encryption": "none"}
    if loc.flow:
        user["flow"] = loc.flow
    stream = {
        "network": loc.network,
        "security": loc.security,
        "realitySettings": {
            "fingerprint": loc.fingerprint or DEFAULT_FINGERPRINT,
            "serverName": loc.sni,
            "publicKey": loc.pbk,
            "shortId": loc.sid,
            "spiderX": loc.spx,
        },
    }
    if loc.network == NETWORK_XHTTP:
        stream["xhttpSettings"] = {
            "path": loc.path or DEFAULT_PATH,
            "host": loc.host_hdr,
            "mode": loc.mode or DEFAULT_MODE,
        }
    return {
        "tag": VLESS_TAG,
        "protocol": "vless",
        "settings": {
            "vnext": [{
                "address": loc.host,
                "port": loc.port,
                "users": [user],
            }]
        },
        "streamSettings": stream,
    }
