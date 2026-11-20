from datetime import datetime, timezone, timedelta
import time
from unittest.mock import patch
import pytest
from xk_switcher import routing
from xk_switcher.device_routing_settings import DeviceRoutingSettings
from xk_switcher.failover import FailoverConfig, FailoverLoop, HealthTracker, ProbeResult
from .test_device_locations import service, assign, MAC

SERVER = "02:00:00:00:00:10"
NOW = datetime(2026, 9, 22, 15, tzinfo=timezone.utc)

def setup(service, server=SERVER, policies=None):
    settings = service.device_routing_settings
    settings.save({"revision": settings.read()["revision"], "policy_ids": ["policy:Policy0"] if policies is None else policies})
    return settings.set_server({"revision": settings.read()["revision"], "id": server})

def loop_for(service, ok=True):
    loop = FailoverLoop(state=service.state, service=service, router=service.router,
                        cfg=FailoverConfig(300, 3, 0, 1, 1), clock=lambda: NOW,
                        route_check_fn=lambda: {"ok": ok, "results": [{"name": "example.test", "ok": ok, "status": 204 if ok else 503}]})
    loop._tcp_probe = lambda host, port: (True, 15)
    return loop

def route_check_for(service, code):
    # The post-commit route check runs after the operation settles; wait for its record.
    for _ in range(500):
        check = service.status()["server_route"]["check"]
        if check and check["active_code"] == code:
            return check
        time.sleep(.01)
    pytest.fail(f"No route check recorded for {code}")

def test_device_location_fetches_new_exit_without_applying_pending_main_config(service):
    from .test_service import _sample_loc, _subscription_bytes
    from .test_device_locations import overlay, wait_operation
    setup(service)
    main_before = service.router.read_bundle()["04_outbounds.json"]
    service.failover_loop = loop_for(service)
    service.fetch_fn = lambda url: _subscription_bytes([
        _sample_loc("fi", host="fresh-main.example"), _sample_loc("tr", host="fresh-server.example"), _sample_loc("de"),
    ])
    operation = assign(service, "tr", SERVER)
    assert "fresh-server.example" in str(overlay(service))
    assert service.router.read_bundle()["04_outbounds.json"] == main_before
    assert service.state.read_state()["pending_reapply_code"] == "fi"
    check = route_check_for(service, "tr")
    assert check["ok"] and check["tcp"]["latency_ms"] == 15
    result = service.device_locations.undo(operation["id"])
    assert wait_operation(service, result["operation"])["phase"] == "committed"
    assert route_check_for(service, "fi")["ok"]

def test_post_failover_result_is_not_overwritten_by_previous_route_check(service):
    setup(service)
    loop = loop_for(service)
    service.failover_loop = loop
    service.state.write_failover({"enabled": True, "whitelist": ["fi", "de"]})
    loop._decider.fail_threshold = 1
    loop._route_check_fn = lambda: {"ok": service.state.read_state()["active_code"] == "de", "results": []}
    result = loop.check_current_route()
    assert result["active_code"] == "fi" and result["active_after"] == "de"
    saved = service.status()["server_route"]["check"]
    assert saved["active_code"] == "de" and saved["ok"]

def test_saved_policy_mapping_overrides_name_and_environment_without_router_writes(service):
    service.devices.gateway.data["policies"] = {"Policy0": {"description": "VPN"}}
    assert not service.devices.snapshot()["locations"]["policy_ids"]
    with patch.object(service.router, "apply") as apply, patch.object(service.devices.gateway, "rci", wraps=service.devices.gateway.rci) as rci:
        snapshot = setup(service)
        assert snapshot["locations"]["policy_ids"] == ["policy:Policy0"]
        assert next(d for d in snapshot["devices"] if d["id"] == MAC)["location"]["editable"]
        assert not apply.called
        assert all(len(call.args) == 1 for call in rci.call_args_list)
    service.config.xkeen_policy_ids = ("default",)
    service.device_routing_settings = DeviceRoutingSettings(service)
    assert service.devices.snapshot()["locations"]["policy_ids"] == ["policy:Policy0"]
    assert setup(service, policies=[])["locations"]["policy_ids"] == []

@pytest.mark.parametrize("changes", [{"policy_ids": ["deny"]}, {"policy_ids": ["segment"]}, {"policy_ids": ["policy:missing"]},
                                     {"policy_ids": ["default", "default"]}, {"policy_ids": [123]}])
def test_invalid_mapping_never_saves(service, changes):
    body = {"revision": None, "policy_ids": ["policy:Policy0"], **changes}
    with pytest.raises(routing.RoutingError):
        service.device_routing_settings.save(body)
    assert not service.device_routing_settings.path.exists()

def test_stale_settings_and_corrupt_storage_are_not_silently_overwritten(service):
    setup(service)
    with pytest.raises(routing.RoutingError, match="changed"):
        service.device_routing_settings.save({"revision": None, "policy_ids": []})
    service.device_routing_settings.path.write_text("{}")
    with pytest.raises(routing.RoutingError, match="cannot be read"):
        service.device_routing_settings.read()

def test_server_badge_and_main_fixed_outside_contexts(service):
    snapshot = setup(service)
    assert [d["id"] for d in snapshot["devices"] if d["is_server"]] == [SERVER]
    assert service.status()["server_route"]["mode"] == "main"
    assign(service, "tr", SERVER)
    context = service.device_routing_settings.context(refresh=True)
    assert context["mode"] == "fixed" and context["code"] == "tr" and context["main_code"] == "fi"
    service.switch("de")
    assert service.status()["server_route"]["code"] == "tr"
    assert service.status()["server_route"]["main_code"] == "de"
    service.devices.gateway.data["settings"][SERVER].pop("policy")
    assert service.device_routing_settings.context(refresh=True)["mode"] == "outside"

def test_fixed_server_check_cannot_change_default_health_or_trigger_failover(service):
    setup(service)
    assign(service, "tr", SERVER)
    service.state.write_failover({"enabled": True, "whitelist": ["fi", "de"]})
    before = service.state.read_health()
    loop = loop_for(service, ok=False)
    with patch.object(service, "apply_failover") as apply:
        result = loop.check_current_route()
        assert not result["ok"] and result["scope"] == "server" and result["active_code"] == "tr"
        assert result["main_code"] == "fi" and not apply.called
    assert service.state.read_health() == before
    assert service.status()["server_route"]["check"]["route"]["server_code"] == "tr"
    assert service.status()["server_route"]["check"]["ok"] is False

def test_periodic_default_health_ignores_fixed_server_http_failure(service):
    setup(service)
    assign(service, "tr", SERVER)
    service.state.write_failover({"enabled": True, "whitelist": ["fi", "de"]})
    service.state.write_state({"last_apply_at": (NOW - timedelta(seconds=600)).isoformat()})
    loop_for(service, ok=False).tick_once()
    entry = service.state.read_health()["map"]["fi"]
    assert entry["ok"] and entry["tcp_ok"] and entry["route_checked_at"] is None
    assert service.status()["server_route"]["check"]["ok"] is False

def test_tcp_failure_streaks_continue_when_http_belongs_to_another_route():
    tracker = HealthTracker()
    tracker.record_components("fi", ProbeResult(True, 12, "tcp"), {"ok": False}, NOW)
    for _ in range(3):
        tracker.record_components("fi", ProbeResult(False, None, "tcp"), {"ok": True, "unattributed": True}, NOW)
    assert tracker.get("fi")["fail_streak"] == 3
    assert tracker.get("fi")["route_checked_at"] is None

def test_same_country_fixed_server_still_does_not_follow_default(service):
    setup(service)
    assign(service, "fi", SERVER)
    result = loop_for(service).check_current_route()
    assert result["scope"] == "server" and result["route"]["unattributed"]
    assert service.state.read_health()["map"] == {}

def test_return_to_main_reenables_combined_checks_and_invalidates_old_result(service):
    setup(service)
    assign(service, "tr", SERVER)
    loop = loop_for(service)
    loop.check_current_route()
    assign(service, None, SERVER)
    assert service.status()["server_route"]["check"] is None
    loop.check_current_route()
    entry = service.state.read_health()["map"]["fi"]
    assert entry["route_ok"] and entry["tcp_ok"]

def test_check_evidence_survives_restart_and_is_invalidated_on_mapping_change(service):
    setup(service)
    loop_for(service).check_current_route()
    service.device_routing_settings = DeviceRoutingSettings(service)
    service.devices.snapshot()
    assert service.status()["server_route"]["check"]["ok"]
    setup(service, server=MAC)
    assert service.status()["server_route"]["check"] is None

def test_unknown_identity_or_inventory_failure_does_not_claim_default_health(service):
    setup(service, server=None)
    assert loop_for(service).check_current_route()["route"]["unattributed"]
    setup(service)
    with patch.object(service.devices.gateway, "snapshot", side_effect=RuntimeError("offline")):
        assert loop_for(service).check_current_route()["route"]["unattributed"]
    assert service.state.read_health()["map"] == {}

def test_tcp_failure_replaces_previous_green_server_result_when_following_main(service):
    setup(service)
    loop = loop_for(service)
    assert loop.check_current_route()["ok"]
    loop._tcp_probe = lambda host, port: (False, None)
    assert not loop.check_current_route()["ok"]
    check = service.status()["server_route"]["check"]
    assert not check["ok"] and not check["tcp"]["ok"] and check["route"]["skipped"]

def test_periodic_tcp_failure_updates_server_result(service):
    setup(service)
    loop = loop_for(service)
    loop.check_current_route()
    service.state.write_failover({"enabled": True, "whitelist": ["fi", "de"]})
    service.state.write_state({"last_apply_at": (NOW - timedelta(seconds=600)).isoformat()})
    loop._tcp_probe = lambda host, port: (False, None)
    loop.tick_once()
    check = service.status()["server_route"]["check"]
    assert not check["ok"] and not check["tcp"]["ok"]

def test_server_starts_unknown_and_can_be_marked_replaced_and_unmarked(service):
    settings = service.device_routing_settings
    assert settings.status()["mode"] == "unknown"
    assert not any(d["is_server"] for d in service.devices.snapshot()["devices"])
    for device in (SERVER, MAC, None):
        result = settings.set_server({"revision": settings.read()["revision"], "id": device})
        assert [d["id"] for d in result["devices"] if d["is_server"]] == ([] if device is None else [device])
        assert settings.read()["policy_ids"] is None
        assert result["locations"]["settings"]["source"] == "automatic"
    assert settings.status()["mode"] == "unknown"

def test_server_mark_rejects_unknown_unregistered_or_stale_devices(service):
    settings = service.device_routing_settings
    for device in ("missing", "02:00:00:00:00:45", 123):
        with pytest.raises(routing.RoutingError):
            settings.set_server({"revision": None, "id": device})
    settings.set_server({"revision": None, "id": SERVER})
    with pytest.raises(routing.RoutingError, match="changed"):
        settings.set_server({"revision": None, "id": MAC})
    assert settings.read()["server_device_id"] == SERVER

def test_vanished_default_recovery_cannot_claim_fixed_server_http_as_success(service):
    setup(service)
    assign(service, "tr", SERVER)
    service.state.write_failover({"enabled": True, "whitelist": ["de", "fi"]})
    result = loop_for(service).recover_vanished_active()
    assert result["attempted"] and not result["recovered"]
    assert result["route_verification"] == "unavailable"
    assert len(result["attempts"]) == 1 and result["attempts"][0]["route_ok"] is None
