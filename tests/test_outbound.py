import json
from xk_switcher.outbound import build, VLESS_TAG
from xk_switcher.subscription import Location

def _tcp_loc(**overrides):
    base = dict(
        code="fi", name="FIN 🇫🇮",
        protocol="vless", host="h.example", port=443,
        uuid="uuid-1", flow="xtls-rprx-vision",
        network="tcp", security="reality",
        sni="h.example", pbk="PBK", sid="SID", spx="/",
        fingerprint="chrome",
    )
    base.update(overrides)
    return Location(**base)

def _xhttp_loc(**overrides):
    base = dict(
        code="ru3", name="RU 3 🇷🇺",
        protocol="vless", host="r.example", port=7443,
        uuid="uuid-1", flow="",
        network="xhttp", security="reality",
        sni="sni.example", pbk="PBK2", sid="SID2", spx="/",
        path="/", host_hdr="cdn.example.invalid", mode="auto",
        fingerprint="chrome",
    )
    base.update(overrides)
    return Location(**base)

def test_tcp_outbound_shape():
    doc = json.loads(build(_tcp_loc()))
    out = doc["outbounds"]
    assert [o["tag"] for o in out] == [VLESS_TAG, "direct", "block"]
    vless = out[0]
    v = vless["settings"]["vnext"][0]
    assert v["address"] == "h.example" and v["port"] == 443
    user = v["users"][0]
    assert user["id"] == "uuid-1"
    assert user["encryption"] == "none"
    assert user["flow"] == "xtls-rprx-vision"
    stream = vless["streamSettings"]
    assert stream["network"] == "tcp"
    rs = stream["realitySettings"]
    assert rs["fingerprint"] == "chrome"
    assert rs["serverName"] == "h.example"
    assert rs["publicKey"] == "PBK"
    assert rs["shortId"] == "SID"
    assert rs["spiderX"] == "/"
    assert "xhttpSettings" not in stream

def test_xhttp_outbound_shape():
    doc = json.loads(build(_xhttp_loc()))
    vless = doc["outbounds"][0]
    user = vless["settings"]["vnext"][0]["users"][0]
    assert "flow" not in user
    stream = vless["streamSettings"]
    assert stream["network"] == "xhttp"
    assert stream["xhttpSettings"] == {
        "path": "/", "host": "cdn.example.invalid", "mode": "auto",
    }

def test_empty_fingerprint_defaults_to_chrome():
    doc = json.loads(build(_tcp_loc(fingerprint="")))
    assert doc["outbounds"][0]["streamSettings"]["realitySettings"]["fingerprint"] == "chrome"

def test_output_is_stable():
    loc = _tcp_loc()
    assert build(loc) == build(loc)

def _passthrough_loc(protocol, proxy):
    return Location(code="x", name="X", protocol=protocol,
                    host=proxy_endpoint(proxy), port=1, outbound=proxy)

def proxy_endpoint(proxy):
    s = proxy["settings"]
    if "servers" in s:
        return s["servers"][0]["address"]
    return s.get("address", "x")

def test_passthrough_shadowsocks_retags_and_preserves():
    proxy = {
        "tag": "proxy", "protocol": "shadowsocks",
        "settings": {"servers": [{"address": "ss.example", "port": 7443,
            "method": "chacha20-ietf-poly1305", "password": "PW"}]},
        "streamSettings": {"network": "tcp", "security": "none"},
    }
    doc = json.loads(build(_passthrough_loc("shadowsocks", proxy)))
    out = doc["outbounds"]
    assert [o["tag"] for o in out] == [VLESS_TAG, "direct", "block"]
    assert out[0]["protocol"] == "shadowsocks"
    assert out[0]["settings"]["servers"][0]["password"] == "PW"

def test_passthrough_hysteria_passes_unsupported_protocol():
    proxy = {
        "tag": "proxy", "protocol": "hysteria",
        "settings": {"address": "nl.example", "port": 443, "version": 2},
        "streamSettings": {"network": "hysteria", "security": "tls"},
    }
    doc = json.loads(build(_passthrough_loc("hysteria", proxy)))
    assert doc["outbounds"][0]["protocol"] == "hysteria"
    assert doc["outbounds"][0]["tag"] == VLESS_TAG


def test_chain_deep_copies_nodes_and_merges_transport_settings():
    import copy
    from dataclasses import replace
    from xk_switcher.outbound import CHAIN_ENTRY_TAG
    entry = _tcp_loc(code="ru")
    exit = _xhttp_loc(code="fi")
    raw = json.loads(build(exit))["outbounds"][0]
    raw["streamSettings"]["sockopt"] = {"mark": 255}
    exit = replace(exit, outbound=raw)
    before = copy.deepcopy(exit.outbound)
    nodes = json.loads(build(exit, entry))["outbounds"]
    assert [o["tag"] for o in nodes] == [VLESS_TAG, CHAIN_ENTRY_TAG, "direct", "block"]
    assert nodes[0]["streamSettings"]["sockopt"] == {"mark": 255, "dialerProxy": CHAIN_ENTRY_TAG}
    assert nodes[0]["streamSettings"]["xhttpSettings"] == raw["streamSettings"]["xhttpSettings"]
    assert nodes[1]["settings"] == json.loads(build(entry))["outbounds"][0]["settings"]
    nodes[0]["settings"]["vnext"][0]["users"][0]["id"] = "mutated"
    assert exit.outbound == before
    single = json.loads(build(exit))["outbounds"]
    assert len(single) == 3
    assert "dialerProxy" not in single[0]["streamSettings"]["sockopt"]

def test_chain_rejects_identical_nodes():
    import pytest
    with pytest.raises(ValueError, match="must be different"):
        build(_tcp_loc(), _tcp_loc())
