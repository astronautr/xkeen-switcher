"""Compile source-IP overrides without changing the user's routing document."""
import copy
import io
import ipaddress
import json
import tarfile
from . import jsonc, routing
from .outbound import VLESS_TAG, _proxy_outbound
from .subscription import Location

OUTBOUNDS_FILE = "04_outbounds.json"
ROUTING_FILE = "05_routing.json"
OVERLAY_FILE = "99_xk_devices_tail.json"
FILES = (OUTBOUNDS_FILE, ROUTING_FILE, OVERLAY_FILE)
TAG_PREFIX = "xk-device-"
MAX_BUNDLE_BYTES = 4 * 1024 * 1024

def fingerprint(files):
    return routing.digest("".join(f"{name}:{routing.digest(files[name]) if name in files else 'absent'}\n" for name in FILES).encode())

def pack(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in FILES:
            if name not in files:
                continue
            entry = tarfile.TarInfo(name)
            entry.size = len(files[name])
            entry.mode = 0o600
            archive.addfile(entry, io.BytesIO(files[name]))
    raw = stream.getvalue()
    if len(raw) > MAX_BUNDLE_BYTES:
        raise routing.RoutingError("Device routing configuration is too large", 422)
    return raw

def unpack(raw):
    if len(raw) > MAX_BUNDLE_BYTES:
        raise routing.RoutingError("Router configuration is too large", 422)
    files = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            for entry in archive:
                if entry.name not in FILES or not entry.isfile() or entry.name in files or entry.size > MAX_BUNDLE_BYTES:
                    raise ValueError("Unexpected bundle entry")
                files[entry.name] = archive.extractfile(entry).read()
        if not {OUTBOUNDS_FILE, ROUTING_FILE} <= files.keys():
            raise ValueError("Incomplete bundle")
    except (tarfile.TarError, ValueError) as error:
        raise routing.RoutingError("Invalid router configuration bundle", 503) from error
    return files

def _sources(rule, addresses):
    constraints = [rule[key] for key in ("source", "sourceIP") if key in rule]
    for constraint in constraints:
        if not isinstance(constraint, list):
            raise routing.RoutingError("Proxy source conditions must be IP addresses or CIDR networks", 422)
        if not constraint:
            continue
        try:
            networks = [ipaddress.ip_network(value, strict=False) for value in constraint]
        except ValueError as error:
            raise routing.RoutingError("Device locations cannot intersect geodata source conditions. Use IP/CIDR source conditions in proxy rules.", 422) from error
        addresses = [address for address in addresses if any(ipaddress.ip_address(address) in network for network in networks)]
    return addresses

def compile_overlay(raw, assignments, locations, main_raw):
    """Clone only proxy rules; every original condition and rule position survives.

    New outbounds live in a *tail* file so Xray's implicit default remains the
    original first outbound. Canonical routing bytes are never rewritten here.
    """
    if not assignments:
        return b"{}\n"
    document = jsonc.loads(raw.decode("utf-8-sig"))
    if not isinstance(document, dict) or document.get("outbounds"):
        raise routing.RoutingError("Device locations require outbounds in 04_outbounds.json only", 422, "layout")
    base = document.get("routing", {})
    if not isinstance(base, dict) or not isinstance(base.get("rules", []), list):
        raise routing.RoutingError("Invalid routing configuration", 422)
    rules = base.get("rules", [])
    grouped = {}
    used_ips = set()
    for assignment in assignments.values():
        address = str(ipaddress.IPv4Address(assignment["ip"]))
        if address in used_ips:
            raise routing.RoutingError("Two devices cannot share a location source IP", 409)
        used_ips.add(address)
        grouped.setdefault(assignment["code"], []).append(address)
    outbounds, tags = [], {}
    for code in sorted(grouped):
        if code not in locations:
            raise routing.RoutingError(f"No saved configuration for location {code}", 409)
        tag = TAG_PREFIX + routing.digest(code.encode())[:16]
        tags[code] = tag
        outbound = copy.deepcopy(_proxy_outbound(Location(**locations[code])))
        outbound["tag"] = tag
        outbounds.append(outbound)
    compiled = []
    for rule in rules:
        if not isinstance(rule, dict):
            raise routing.RoutingError("Invalid routing rule", 422)
        if rule.get("outboundTag") == VLESS_TAG:
            for code, addresses in grouped.items():
                sources = _sources(rule, sorted(addresses))
                if not sources:
                    continue
                clone = copy.deepcopy(rule)
                clone.pop("sourceIP", None)
                clone.update(source=sources, outboundTag=tags[code], ruleTag=tags[code])
                compiled.append(clone)
        compiled.append(copy.deepcopy(rule))
    # Xray sends unmatched traffic to the first outbound. Only mirror that
    # fallback when it is the main proxy; never turn a Direct default into Proxy.
    main = jsonc.loads(main_raw.decode("utf-8-sig")).get("outbounds", [])
    if any(item.get("tag", "").startswith(TAG_PREFIX) for item in main):
        raise routing.RoutingError("The xk-device- outbound tag prefix is reserved for device locations", 422, "layout")
    if main and main[0].get("tag") == VLESS_TAG:
        for code, addresses in grouped.items():
            compiled.append({"type": "field", "inboundTag": ["redirect", "tproxy"],
                             "source": sorted(addresses), "outboundTag": tags[code], "ruleTag": tags[code]})
    overlay = {"outbounds": outbounds, "routing": {**copy.deepcopy(base), "rules": compiled}}
    return (json.dumps(overlay, ensure_ascii=False, indent=2) + "\n").encode()
