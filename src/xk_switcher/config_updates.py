"""Compare effective outbound configurations and recognize SNI-only changes."""
import copy
import hashlib
import json
from .outbound import build
from .subscription import Location

SNI = "sni"
CONFIG = "config"
SNI_SETTINGS = {"tls": "tlsSettings", "reality": "realitySettings"}

def _digest(config: dict) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

def hashes(config: dict) -> dict:
    """Ignore only the active TLS/Reality serverName, never a host or key."""
    without_sni = copy.deepcopy(config)
    for outbound in without_sni.get("outbounds", []):
        if not isinstance(outbound, dict):
            continue
        stream = outbound.get("streamSettings") or {}
        if not isinstance(stream, dict) or not isinstance(stream.get("security"), str):
            continue
        settings = stream.get(SNI_SETTINGS.get(stream["security"]))
        if isinstance(settings, dict) and isinstance(settings.get("serverName"), str):
            settings.pop("serverName", None)
    return {"full": _digest(config), "without_sni": _digest(without_sni)}

def location_hashes(loc: Location, entry: Location | None = None) -> dict:
    return hashes(json.loads(build(loc, entry)))

def change_kind(applied: dict | None, candidate: dict) -> str | None:
    if not applied:
        return CONFIG
    if applied.get("full") == candidate["full"]:
        return None
    return SNI if applied.get("without_sni") == candidate["without_sni"] else CONFIG

def combined_kind(kinds) -> str | None:
    kinds = set(kinds)
    return CONFIG if CONFIG in kinds else SNI if SNI in kinds else None
