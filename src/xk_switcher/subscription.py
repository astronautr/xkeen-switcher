"""Fetch and parse a VLESS subscription.

Public: fetch(), decode_subscription(), parse_locations().
ss:// entries are silently skipped.
"""
import base64
import json
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from .codes import code_for

SUBSCRIPTION_TIMEOUT_SEC = 10
# Match Happ's subscription client so providers return the same client-specific
# representation that is known to work there.
USER_AGENT = "Happ/4.7.0"
VLESS_PREFIX = "vless://"
JSON_PREFIXES = ("[", "{")
PROXY_TAG = "proxy"
DEFAULT_FINGERPRINT = "chrome"
DEFAULT_SECURITY = "reality"
DEFAULT_NETWORK = "tcp"
DEFAULT_SPX = "/"
HYSTERIA_PROTOCOLS = {"hysteria", "hysteria2"}
HYSTERIA_NETWORKS = {"hysteria", "hysteria2"}

@dataclass
class Location:
    code: str
    name: str
    protocol: str
    host: str
    port: int
    uuid: str = ""
    flow: str = ""
    network: str = ""
    security: str = ""
    sni: str = ""
    pbk: str = ""
    sid: str = ""
    spx: str = DEFAULT_SPX
    path: str = ""
    mode: str = ""
    host_hdr: str = ""
    fingerprint: str = DEFAULT_FINGERPRINT
    outbound: dict = field(default_factory=dict)

def is_hysteria_location(location: Location | dict) -> bool:
    if isinstance(location, Location):
        protocol = location.protocol
        network = location.network
        outbound = location.outbound
    else:
        protocol = location.get("protocol", "")
        network = location.get("network", "")
        outbound = location.get("outbound", {})
    if not network:
        network = outbound.get("streamSettings", {}).get("network", "")
    return (
        str(protocol).lower() in HYSTERIA_PROTOCOLS
        or str(network).lower() in HYSTERIA_NETWORKS
    )

def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=SUBSCRIPTION_TIMEOUT_SEC) as r:
        return r.read()

def decode_subscription(raw: bytes) -> str:
    s = raw.decode("utf-8", errors="replace").strip()
    if s.startswith(JSON_PREFIXES):
        return s
    pad = (-len(s)) % 4
    return base64.b64decode(s + "=" * pad).decode("utf-8", errors="replace")

def parse_locations(decoded: str) -> list[Location]:
    if decoded.strip().startswith("["):
        return _parse_json_subscription(decoded)
    out = []
    for line in decoded.splitlines():
        line = line.strip()
        if not line.startswith(VLESS_PREFIX):
            continue
        try:
            out.append(_parse_vless(line))
        except (ValueError, KeyError, IndexError):
            continue
    return out

def _parse_json_subscription(decoded: str) -> list[Location]:
    out = []
    for cfg in json.loads(decoded):
        try:
            out.append(_location_from_config(cfg))
        except (ValueError, KeyError, IndexError, TypeError):
            continue
    return out

def _location_from_config(cfg: dict) -> Location:
    name = cfg.get("remarks", "")
    proxy = next((o for o in cfg.get("outbounds", []) if o.get("tag") == PROXY_TAG), None)
    if proxy is None:
        raise ValueError("no proxy outbound")
    host, port = _endpoint(proxy)
    return Location(
        code=code_for(name),
        name=name,
        protocol=proxy.get("protocol", ""),
        host=host,
        port=port,
        outbound=proxy,
    )

def _endpoint(outbound: dict) -> tuple[str, int]:
    settings = outbound.get("settings", {})
    vnext = settings.get("vnext")
    if vnext:
        return vnext[0]["address"], int(vnext[0]["port"])
    servers = settings.get("servers")
    if servers:
        return servers[0]["address"], int(servers[0]["port"])
    if "address" in settings:
        return settings["address"], int(settings["port"])
    raise ValueError("no endpoint in outbound")

def _parse_vless(url: str) -> Location:
    body = url[len(VLESS_PREFIX):]
    userinfo, sep, rest = body.partition("@")
    if not sep:
        raise ValueError("no userinfo@host separator")
    hostport, _, tail = rest.partition("?")
    query, _, fragment = tail.partition("#")
    host, sep, port_s = hostport.rpartition(":")
    if not sep:
        raise ValueError("no host:port separator")
    port = int(port_s)
    params = urllib.parse.parse_qs(query, keep_blank_values=True)
    def p(k, d=""):
        return params.get(k, [d])[0]
    pbk = p("pbk")
    if not pbk:
        raise ValueError("missing pbk")
    sid = p("sid")
    if not sid:
        raise ValueError("missing sid")
    name = urllib.parse.unquote(fragment)
    return Location(
        code=code_for(name),
        name=name,
        protocol="vless",
        host=host,
        port=port,
        uuid=userinfo,
        flow=p("flow"),
        network=p("type") or DEFAULT_NETWORK,
        security=p("security") or DEFAULT_SECURITY,
        sni=p("sni") or host,
        pbk=pbk,
        sid=sid,
        spx=urllib.parse.unquote(p("spx") or DEFAULT_SPX),
        path=urllib.parse.unquote(p("path")),
        mode=p("mode"),
        host_hdr=urllib.parse.unquote(p("host")),
        fingerprint=p("fp") or DEFAULT_FINGERPRINT,
    )
