import base64
import json
import pytest
from xk_switcher.subscription import decode_subscription, fetch, parse_locations, Location

def _json_node(remarks, proxy):
    return {
        "remarks": remarks,
        "outbounds": [
            proxy,
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ],
    }

SAMPLE_JSON_SUB = json.dumps([
    _json_node("FIN 🇫🇮 1gbit⚡️", {
        "tag": "proxy", "protocol": "vless",
        "settings": {"vnext": [{"address": "fin.example", "port": 443,
            "users": [{"id": "UUID", "flow": "xtls-rprx-vision", "encryption": "none"}]}]},
        "streamSettings": {"network": "tcp", "security": "reality",
            "realitySettings": {"serverName": "fin.example", "publicKey": "PBK", "shortId": "SID"}},
    }),
    _json_node("FIN Alt 🇫🇮 1gbit⚡️", {
        "tag": "proxy", "protocol": "shadowsocks",
        "settings": {"servers": [{"address": "ss.example", "port": 7443,
            "method": "chacha20-ietf-poly1305", "password": "PW"}]},
        "streamSettings": {"network": "tcp", "security": "none"},
    }),
    _json_node("NL 🇳🇱 1gbit⚡️", {
        "tag": "proxy", "protocol": "hysteria",
        "settings": {"address": "nl.example", "port": 443, "version": 2},
        "streamSettings": {"network": "hysteria", "security": "tls"},
    }),
])

SAMPLE_VLESS_TCP = (
    "vless://00000000-0000-4000-8000-000000000001@fi.example.invalid:443"
    "?security=reality&type=tcp&headerType=&path=&host="
    "&flow=xtls-rprx-vision&sni=fi.example.invalid&fp=chrome"
    "&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "&sid=0123456789abcdef&spx=%2F"
    "#FIN%20%F0%9F%87%AB%F0%9F%87%AE%201gbit%E2%9A%A1%EF%B8%8F"
)
SAMPLE_VLESS_XHTTP = (
    "vless://00000000-0000-4000-8000-000000000001"
    "@ru3.example.invalid:7443"
    "?security=reality&type=xhttp&headerType=&path=%2F&host=cdn.example.invalid"
    "&flow=&mode=auto&sni=sni.example.invalid&fp="
    "&pbk=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    "&sid=fedcba9876543210"
    "#RU%203%20%F0%9F%87%B7%F0%9F%87%BA"
)
SAMPLE_SS = (
    "ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNzd29yZA"
    "@lv.example.invalid:443#LV%20alt"
)

def test_fetch_uses_happ_desktop_user_agent(monkeypatch):
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def read(self):
            return b"subscription"

    def fake_urlopen(request, timeout):
        captured["user_agent"] = request.get_header("User-agent")
        return Response()

    monkeypatch.setattr("xk_switcher.subscription.urllib.request.urlopen", fake_urlopen)

    assert fetch("https://subscription.example") == b"subscription"
    assert captured["user_agent"] == "Happ/4.7.0"

def test_decode_passes_json_through():
    raw = SAMPLE_JSON_SUB.encode("utf-8")
    assert decode_subscription(raw) == SAMPLE_JSON_SUB

def test_parse_json_subscription_all_protocols():
    locs = parse_locations(SAMPLE_JSON_SUB)
    assert [l.code for l in locs] == ["fi", "fialt", "nl"]
    assert [l.protocol for l in locs] == ["vless", "shadowsocks", "hysteria"]
    assert [(l.host, l.port) for l in locs] == [
        ("fin.example", 443), ("ss.example", 7443), ("nl.example", 443),
    ]

def test_parse_json_captures_proxy_outbound():
    ss = parse_locations(SAMPLE_JSON_SUB)[1]
    assert ss.outbound["protocol"] == "shadowsocks"
    assert ss.outbound["settings"]["servers"][0]["password"] == "PW"

def test_decode_strips_and_pads():
    encoded = base64.b64encode(b"vless://x\nvless://y").decode("ascii")
    without_padding = (encoded.rstrip("=") + "\n  ").encode("utf-8")
    result = decode_subscription(without_padding)
    assert "vless://x" in result and "vless://y" in result

def test_parse_tcp_location_fields():
    locs = parse_locations(SAMPLE_VLESS_TCP)
    assert len(locs) == 1
    loc = locs[0]
    assert loc.code == "fi"
    assert loc.protocol == "vless"
    assert loc.host == "fi.example.invalid"
    assert loc.port == 443
    assert loc.uuid == "00000000-0000-4000-8000-000000000001"
    assert loc.flow == "xtls-rprx-vision"
    assert loc.network == "tcp"
    assert loc.security == "reality"
    assert loc.sni == "fi.example.invalid"
    assert loc.pbk == "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    assert loc.sid == "0123456789abcdef"
    assert loc.spx == "/"
    assert loc.fingerprint == "chrome"

def test_parse_xhttp_transport():
    locs = parse_locations(SAMPLE_VLESS_XHTTP)
    loc = locs[0]
    assert loc.code == "ru3"
    assert loc.network == "xhttp"
    assert loc.port == 7443
    assert loc.path == "/"
    assert loc.host_hdr == "cdn.example.invalid"
    assert loc.mode == "auto"
    assert loc.flow == ""
    assert loc.fingerprint == "chrome"

def test_skip_ss_entries():
    decoded = "\n".join([SAMPLE_VLESS_TCP, SAMPLE_SS])
    locs = parse_locations(decoded)
    assert [loc.protocol for loc in locs] == ["vless"]

def test_skip_missing_pbk():
    broken = SAMPLE_VLESS_TCP.replace(
        "pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "pbk="
    )
    assert parse_locations(broken) == []

def test_skip_blank_and_comment_lines():
    decoded = "\n".join(["", "   ", "#comment-like", SAMPLE_VLESS_TCP])
    assert len(parse_locations(decoded)) == 1

def test_empty_input_returns_empty_list():
    assert parse_locations("") == []
