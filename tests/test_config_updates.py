import copy
import json
from dataclasses import replace
import pytest
from xk_switcher import config_updates
from xk_switcher.outbound import build
from .test_service import _json_loc, _sample_loc

@pytest.mark.parametrize("security", ["reality", "tls"])
def test_only_active_server_name_is_deferred_without_mutating_configs(security):
    before = json.loads(build(_json_loc()))
    stream = before["outbounds"][0]["streamSettings"]
    stream["security"] = security
    settings = stream.pop("realitySettings")
    stream[security + "Settings"] = settings
    original = copy.deepcopy(before)
    after = copy.deepcopy(before)
    after["outbounds"][0]["streamSettings"][security + "Settings"]["serverName"] = "rotated.example"
    assert config_updates.change_kind(config_updates.hashes(before), config_updates.hashes(after)) == "sni"
    assert before == original
    assert after["outbounds"][0]["streamSettings"][security + "Settings"]["serverName"] == "rotated.example"

@pytest.mark.parametrize("path,value", [
    (("settings", "vnext", 0, "address"), "new.example"),
    (("settings", "vnext", 0, "port"), 8443),
    (("settings", "vnext", 0, "users", 0, "id"), "new-id"),
    (("streamSettings", "realitySettings", "publicKey"), "new-key"),
    (("streamSettings", "realitySettings", "shortId"), "new-id"),
    (("streamSettings", "network"), "xhttp"),
    (("streamSettings", "security"), "tls"),
])
def test_sni_plus_connection_change_requires_regular_update(path, value):
    before = json.loads(build(_json_loc()))
    after = json.loads(build(_json_loc(server_name="rotated.example")))
    target = after["outbounds"][0]
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    assert config_updates.change_kind(config_updates.hashes(before), config_updates.hashes(after)) == "config"

def test_http_host_and_inactive_tls_settings_are_not_sni_changes():
    before = json.loads(build(_json_loc()))
    for settings in ({"xhttpSettings": {"host": "new.example"}}, {"tlsSettings": {"serverName": "new.example"}}):
        after = copy.deepcopy(before)
        after["outbounds"][0]["streamSettings"].update(settings)
        assert config_updates.change_kind(config_updates.hashes(before), config_updates.hashes(after)) == "config"

def test_uri_locations_and_added_or_removed_sni_are_compared_as_effective_config():
    loc = _sample_loc()
    assert config_updates.change_kind(config_updates.location_hashes(loc), config_updates.location_hashes(replace(loc, sni="new.example"))) == "sni"
    assert config_updates.change_kind(config_updates.location_hashes(loc), config_updates.location_hashes(replace(loc, name="Renamed"))) is None
    before = json.loads(build(loc))
    after = copy.deepcopy(before)
    after["outbounds"][0]["streamSettings"]["realitySettings"].pop("serverName")
    assert config_updates.change_kind(config_updates.hashes(before), config_updates.hashes(after)) == "sni"

def test_json_key_order_does_not_create_an_update():
    before = json.loads(build(_json_loc()))
    reordered = json.loads(json.dumps(before, sort_keys=True))
    assert config_updates.change_kind(config_updates.hashes(before), config_updates.hashes(reordered)) is None

def test_unknown_baseline_and_invalid_sni_are_not_optional():
    before = json.loads(build(_json_loc()))
    after = json.loads(build(_json_loc(server_name=["invalid"])))
    assert config_updates.change_kind(None, config_updates.hashes(before)) == "config"
    assert config_updates.change_kind(config_updates.hashes(before), config_updates.hashes(after)) == "config"


@pytest.mark.parametrize("entry_sni,exit_sni,entry_key,expected", [
    (True, False, False, "sni"), (False, True, False, "sni"),
    (True, True, False, "sni"), (True, True, True, "config"),
    (False, False, False, None),
])
def test_chain_hashes_classify_both_nodes(entry_sni, exit_sni, entry_key, expected):
    entry, exit = _sample_loc("ru"), _sample_loc("fi")
    baseline = config_updates.location_hashes(exit, entry)
    changed_entry = replace(entry, sni="new" if entry_sni else entry.sni, pbk="new" if entry_key else entry.pbk)
    changed_exit = replace(exit, sni="new" if exit_sni else exit.sni)
    assert config_updates.change_kind(baseline, config_updates.location_hashes(changed_exit, changed_entry)) == expected
    assert config_updates.change_kind(baseline, config_updates.location_hashes(exit)) == "config"
