import copy
import json
import time
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
import pytest
from xk_switcher import device_routing as compiler, routing
from xk_switcher.router import Router
from xk_switcher.service import Service
from xk_switcher.state import State
from .test_service import _sample_loc, _seed_sub, _service_with_subscription
from .test_service import auto_update_clock

MAC = "02:00:00:00:00:32"
SECOND = "02:00:00:00:00:54"

@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("ROUTER_HOST", "mock")
    state = State(tmp_path); state.init({})
    _seed_sub(state, [_sample_loc("fi"), _sample_loc("tr"), _sample_loc("de")])
    result = _service_with_subscription(state, Router("mock", mock_data_dir=tmp_path))
    result.switch("fi")
    return result

def body(service, code="tr", mac=MAC):
    snapshot = service.devices.snapshot()
    device = next(d for d in snapshot["devices"] if d["id"] == mac)
    return {"id": mac, "code": code, "revision": device["revision"],
            "locations_revision": snapshot["locations"]["revision"], "operation_id": routing.new_id()}

def assign(service, code="tr", mac=MAC):
    operation = service.device_locations.change(body(service, code, mac))["operation"]
    for _ in range(200):
        operation = service.routing.store.operation(operation["id"])
        if operation["phase"] in {"committed", "rolled_back", "rejected", "unknown"}:
            assert operation["phase"] == "committed", operation
            with service._op_lock:
                pass  # Let the worker finish its acknowledgement and release the coordinator.
            return operation
        time.sleep(.01)
    pytest.fail("Operation did not finish")

def overlay(service):
    return json.loads(service.router.read_bundle()[compiler.OVERLAY_FILE])

def test_inventory_read_is_not_reported_as_pending_device_location(service):
    assert service.devices.snapshot()["locations"]["pending_operation"] is None

def test_main_switch_preserves_applied_device_config_and_pending_schedule(service):
    assign(service)
    before = service.router.read_bundle()
    revision = service.device_locations.read()["revision"]
    service._update_from_locations([_sample_loc("fi"), _sample_loc("tr", pbk="ROTATED"), _sample_loc("de")], trigger="manual")
    pending_since = service.state.read_state()["pending_reapply_since"]
    refresh = service.fetch_fn
    service.fetch_fn = MagicMock(side_effect=AssertionError("Ordinary switches must not fetch"))
    service.switch("de")
    service.fetch_fn.assert_not_called()
    assert service.router.read_bundle()[compiler.OVERLAY_FILE] == before[compiler.OVERLAY_FILE]
    assert service.device_locations.read()["revision"] == revision
    assert service.state.read_state()["pending_reapply_code"] == "de"
    assert service.state.read_state()["pending_reapply_since"] == pending_since
    service.fetch_fn = refresh
    service.apply_pending_reapply_now()
    assert overlay(service)["outbounds"][0]["streamSettings"]["realitySettings"]["publicKey"] == "ROTATED"
    assert service.state.read_state()["pending_reapply_code"] is None

def test_fixed_exit_sni_survives_main_switch_and_applies_at_daily_time(service, auto_update_clock):
    assign(service)
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 120, "sni_daily": True})
    locations = [_sample_loc("fi"), replace(_sample_loc("tr"), sni="rotated.example"), _sample_loc("de")]
    service._update_from_locations(locations, trigger="manual")
    assert service.status()["pending_update_kind"] == "sni"
    before = service.router.read_bundle()[compiler.OVERLAY_FILE]
    since = service.state.read_state()["pending_reapply_since"]
    service.switch("de")
    assert service.router.read_bundle()[compiler.OVERLAY_FILE] == before
    assert service.status()["pending_update_kind"] == "sni"
    assert service.state.read_state()["pending_reapply_since"] == since
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"
    auto_update_clock.current = datetime(2026, 9, 11, 1, 30, tzinfo=timezone.utc)
    assert service.apply_pending_reapply()
    assert overlay(service)["outbounds"][0]["streamSettings"]["realitySettings"]["serverName"] == "rotated.example"
    assert service.status()["pending_update_kind"] is None

def test_main_sni_cannot_hide_fixed_exit_key_update_or_extend_its_timer(service, auto_update_clock):
    assign(service)
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 120, "sni_daily": True})
    service._update_from_locations([replace(_sample_loc("fi"), sni="one.example"), _sample_loc("tr"), _sample_loc("de")], trigger="manual")
    auto_update_clock.current += timedelta(hours=1)
    locations = [replace(_sample_loc("fi"), sni="two.example"), _sample_loc("tr", pbk="NEW"), _sample_loc("de")]
    service._update_from_locations(locations, trigger="manual")
    deadline = service.status()["auto_update"]["next_apply_at"]
    assert deadline == "2026-09-10T12:00:00+00:00"
    auto_update_clock.current += timedelta(minutes=30)
    service.switch("de")
    assert service.status()["pending_update_kind"] == "config"
    assert service.status()["auto_update"]["next_apply_at"] == deadline
    auto_update_clock.current = datetime.fromisoformat(deadline)
    assert service.apply_pending_reapply()
    assert overlay(service)["outbounds"][0]["streamSettings"]["realitySettings"]["publicKey"] == "NEW"
    assert service.status()["pending_update_kind"] is None

def test_unused_exit_change_does_not_create_pending_update(service):
    service._update_from_locations([_sample_loc("fi"), replace(_sample_loc("tr"), sni="rotated.example"), _sample_loc("de", pbk="NEW")], trigger="manual")
    assert service.status()["pending_reapply_code"] is None
    assert service.status()["pending_update_kind"] is None

def test_main_key_apply_leaves_fixed_sni_on_daily_schedule(service, auto_update_clock):
    assign(service)
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 120, "sni_daily": True})
    locations = [_sample_loc("fi", pbk="NEW"), replace(_sample_loc("tr"), sni="rotated.example"), _sample_loc("de")]
    service._update_from_locations(locations, trigger="manual")
    assert service.status()["pending_update_kind"] == "config"
    service.switch("fi")
    assert service.status()["pending_update_kind"] == "sni"
    assert service.state.read_state()["pending_non_sni_since"] is None
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"

def test_last_assignment_removal_exits_managed_mode_and_removes_overlay(service):
    assign(service)
    assign(service, None)
    assert not service.device_locations.managed()
    assert compiler.OVERLAY_FILE not in service.router.read_bundle()

@pytest.mark.parametrize("rotated", ["fi", "tr"])
def test_provider_reverting_pending_config_cancels_unnecessary_apply(service, rotated):
    assign(service)
    original = [_sample_loc(code) for code in ("fi", "tr", "de")]
    changed = [_sample_loc(code, pbk="ROTATED" if code == rotated else "PBK") for code in ("fi", "tr", "de")]
    before = service.router.read_bundle()
    service._update_from_locations(changed, trigger="manual")
    assert service.state.read_state()["pending_reapply_code"] == "fi"
    service._update_from_locations(original, trigger="manual")
    state = service.state.read_state()
    assert state["pending_reapply_code"] is None
    assert state["pending_reapply_since"] is None
    assert not state["pending_main_config"] and not state["pending_device_configs"]
    assert not service.apply_pending_reapply()
    assert service.router.read_bundle() == before

def test_main_switch_keeps_canonical_snapshot_and_draft_usable(service):
    assign(service)
    current = service.routing.state()["current"]
    base, _ = service.routing.store.blob("snapshots", current["id"])
    model = copy.deepcopy(base["model"])
    model["groups"][-1]["action"] = "direct"
    draft = service.routing.save_draft({"expected_revision": None, "base_hash": current["sha256"], "model": model})
    service.switch("de")
    assert service.routing.store.read("current.json") == current
    assert service.routing.store.read("draft.json")["revision"] == draft["revision"]

def test_compiler_preserves_direct_block_order_and_intersects_sources():
    rules = [{"type":"field", "outboundTag":"block", "domain":["bad.test"]},
             {"type":"field", "outboundTag":"vless-reality", "domain":["proxy.test"], "source":["192.168.1.0/24"], "network":"tcp"},
             {"type":"field", "outboundTag":"direct"}]
    raw = json.dumps({"routing":{"domainStrategy":"IPIfNonMatch", "rules":rules}}).encode()
    assignments = {"one":{"code":"tr", "ip":"192.168.1.2"}, "two":{"code":"tr", "ip":"192.168.2.2"}}
    result = json.loads(compiler.compile_overlay(raw, assignments, {"tr":asdict(_sample_loc("tr"))}, b'{"outbounds":[{"tag":"direct"}]}'))
    compiled = result["routing"]["rules"]
    assert compiled[0] == rules[0] and compiled[2:] == rules[1:]
    assert compiled[1]["source"] == ["192.168.1.2"]
    assert compiled[1]["domain"] == ["proxy.test"] and compiled[1]["network"] == "tcp"
    assert len(result["outbounds"]) == 1
    assert result["routing"]["domainStrategy"] == "IPIfNonMatch"

def test_source_geodata_is_rejected_instead_of_bypassed():
    raw = b'{"routing":{"rules":[{"outboundTag":"vless-reality","source":["geoip:private"]}]}}'
    with pytest.raises(routing.RoutingError, match="geodata"):
        compiler.compile_overlay(raw, {"d":{"code":"tr","ip":"192.168.1.2"}}, {"tr":asdict(_sample_loc("tr"))}, b'{}')

def test_assignment_pins_ip_persists_and_main_switch_keeps_custom(service):
    canonical = service.router.read_routing()
    assign(service)
    assert service.devices.gateway.snapshot()["records"][MAC]["reserved_ip"] == "192.168.2.32"
    assert service.router.read_routing() == canonical
    before = overlay(service)
    service.switch("de")
    assert overlay(service) == before
    assert service.status()["active_code"] == "de"
    restarted = _service_with_subscription(service.state, Router("mock", mock_data_dir=service.state.data_dir))
    assert restarted.device_locations.read() == service.device_locations.read()
    assert overlay(restarted) == before

def test_distinct_locations_share_one_outbound_per_code_and_remove_cleanly(service):
    assign(service); assign(service, "tr", SECOND)
    assert len(overlay(service)["outbounds"]) == 1
    assign(service, "de", SECOND)
    assert len(overlay(service)["outbounds"]) == 2
    assign(service, None); assign(service, None, SECOND)
    assert compiler.OVERLAY_FILE not in service.router.read_bundle()
    assert service.devices.gateway.snapshot()["records"][MAC]["reserved_ip"]

def test_stale_requests_and_unsafe_unpin_are_rejected(service):
    stale = body(service)
    assign(service)
    with pytest.raises(routing.RoutingError, match="locations changed"):
        service.device_locations.change(stale)
    device = next(d for d in service.devices.snapshot()["devices"] if d["id"] == MAC)
    for values in ({"ip_pinned":False}, {"registered":False}):
        with pytest.raises(routing.RoutingError, match="Use main location"):
            service.devices.change({"operation_id":routing.new_id(), "changes":[{"id":MAC,"revision":device["revision"],"values":values}]})
    pin_op = service.devices._read()[0]
    with pytest.raises(routing.RoutingError, match="Use main location"):
        service.devices.undo(pin_op["id"])

def test_policy_change_preserves_saved_assignment_and_marks_inactive(service):
    assign(service)
    snapshot = service.devices.snapshot(); device = next(d for d in snapshot["devices"] if d["id"] == MAC)
    result = service.devices.change({"operation_id":routing.new_id(),"changes":[{"id":MAC,"revision":device["revision"],"values":{"policy":"default"}}]})
    location = next(d for d in result["devices"] if d["id"] == MAC)["location"]
    assert location["code"] == "tr" and not location["in_xkeen"]
    assert overlay(service)["outbounds"]

def test_vanished_custom_location_keeps_last_config(service):
    assign(service)
    before = overlay(service)
    service._update_from_locations([_sample_loc("fi"), _sample_loc("de")], trigger="manual")
    service.switch("de")
    assert overlay(service) == before
    location = next(d for d in service.devices.snapshot()["devices"] if d["id"] == MAC)["location"]
    assert location["unavailable"]

def test_custom_config_refresh_queues_and_applies_all_used_configs(service):
    assign(service)
    locations = [_sample_loc("fi"), _sample_loc("tr", pbk="ROTATED"), _sample_loc("de")]
    service._update_from_locations(locations, trigger="manual")
    assert service.status()["pending_reapply_code"] == "fi"
    service.apply_pending_reapply_now()
    assert overlay(service)["outbounds"][0]["streamSettings"]["realitySettings"]["publicKey"] == "ROTATED"
    assert not service.status()["pending_reapply_code"]

def test_main_failover_keeps_device_route_and_does_not_stop_shared_xray(service):
    assign(service)
    before = overlay(service)
    service.apply_failover("de", "failover-switch")
    assert overlay(service) == before
    service.handle_total_failure()
    assert service.router.routing_health() == "running"

def test_xray_rejection_does_not_pin_or_save_assignment(service):
    with patch.object(service.router, "validate_bundle", side_effect=routing.RoutingError("unsupported protocol",422)):
        with pytest.raises(routing.RoutingError, match="unsupported"):
            service.device_locations.change(body(service))
    assert not service.device_locations.has_assignments()
    assert not service.devices.gateway.snapshot()["records"][MAC]["reserved_ip"]

def test_lost_reply_reconciles_bundle_and_assignment_after_restart(service):
    original = service.router.start_bundle
    def lose_reply(*args):
        original(*args)
        raise TimeoutError("Lost SSH response")
    with patch.object(service.router, "start_bundle", side_effect=lose_reply):
        operation = service.device_locations.change(body(service))["operation"]
        for _ in range(200):
            if service.routing.store.operation(operation["id"])["phase"] == "unknown": break
            time.sleep(.01)
    service.routing.stop()
    restarted = _service_with_subscription(service.state, Router("mock", mock_data_dir=service.state.data_dir))
    restarted.routing.recover()
    for _ in range(200):
        if restarted.routing.store.operation(operation["id"])["phase"] == "committed":
            break
        time.sleep(.01)
    assert restarted.routing.store.operation(operation["id"])["phase"] == "committed"
    assert restarted.device_locations.read()["assignments"][MAC]["code"] == "tr"

def test_routing_edit_and_raw_restore_recompile_overlay_keep_exact_bytes(service):
    assign(service)
    state = service.routing.state()
    original = state["current"]["id"]
    model = copy.deepcopy(state["model"])
    model["groups"][-1]["action"] = "direct"
    draft = service.routing.save_draft({"expected_revision":None,"base_hash":state["current"]["sha256"],"model":model})
    preview = service.routing.preview({"expected_current_hash":state["current"]["sha256"],"draft_revision":draft["revision"]})
    operation = service.routing.apply({"operation_id":routing.new_id(),"preview_id":preview["id"]})
    for _ in range(200):
        if service.routing.store.operation(operation["id"])["phase"] in {"committed","unknown","rejected"}: break
        time.sleep(.01)
    assert service.routing.store.operation(operation["id"])["phase"] == "committed"
    assert any(rule.get("outboundTag") == "direct" and not rule.get("domain") for rule in overlay(service)["routing"]["rules"])
    state = service.routing.state()
    restore = service.routing.preview({"intent":"restore","snapshot_id":original,"expected_current_hash":state["current"]["sha256"]})
    op = service.routing.apply({"operation_id":routing.new_id(),"preview_id":restore["id"]})
    for _ in range(200):
        if service.routing.store.operation(op["id"])["phase"] == "committed": break
        time.sleep(.01)
    assert service.router.read_routing() == service.routing.store.blob("snapshots", original)[1]

def wait_operation(service, operation):
    for _ in range(200):
        result = service.routing.store.operation(operation["id"])
        if result["phase"] in {"committed", "rejected", "unknown", "rolled_back"}: return result
        time.sleep(.01)
    pytest.fail("Operation did not finish")

def test_location_undo_survives_restart_keeps_pin_and_main_location(service):
    operation = assign(service)
    restarted = _service_with_subscription(service.state, Router("mock", mock_data_dir=service.state.data_dir))
    restarted.switch("de")
    result = restarted.devices.undo(operation["id"])
    assert wait_operation(restarted, result["operation"])["phase"] == "committed"
    assert not restarted.device_locations.has_assignments()
    assert restarted.state.read_state()["active_code"] == "de"
    assert restarted.devices.gateway.snapshot()["records"][MAC]["reserved_ip"] == "192.168.2.32"

def test_location_undo_rejects_newer_assignment(service):
    first = assign(service)
    assign(service, "de")
    with pytest.raises(routing.RoutingError, match="changed again"):
        service.devices.undo(first["id"])

def test_external_ip_change_does_not_rewrite_fixed_exit_on_main_switch(service):
    assign(service)
    service.devices.gateway.data["reservations"][MAC] = "192.168.2.99"
    before = service.router.read_bundle()
    service.switch("de")
    assert service.router.read_bundle()[compiler.OVERLAY_FILE] == before[compiler.OVERLAY_FILE]
    device = next(d for d in service.devices.snapshot()["devices"] if d["id"] == MAC)
    assert device["location"]["ip_conflict"]
    assign(service, None)
    assert not service.device_locations.has_assignments()

def test_segment_policy_inherits_xkeen_and_explicit_policy_ids(service):
    gateway = service.devices.gateway
    original = gateway.rci
    def rci(path, payload=None):
        value = original(path, payload)
        if path == "ip/hotspot" and payload is None:
            value["policy"][0]["policy"] = "Policy0"
        return value
    with patch.object(gateway, "rci", side_effect=rci):
        ipad = next(d for d in service.devices.snapshot()["devices"] if d["name"] == "iPad")
        assert ipad["policy"] == "segment" and ipad["location"]["in_xkeen"]
    service.config.xkeen_policy_ids = ("default",)
    snapshot = service.devices.snapshot()
    assert next(d for d in snapshot["devices"] if d["name"] == "Hue Bridge")["location"]["in_xkeen"]
    assert not next(d for d in snapshot["devices"] if d["id"] == MAC)["location"]["in_xkeen"]

def test_foreign_routing_fragments_and_old_helper_rejected_before_pin(service):
    with patch.object(service.router, "config_dependencies", return_value={"07_custom.json":b'{"routing":{"rules":[]}}'}):
        with pytest.raises(routing.RoutingError, match="07_custom.json"):
            service.device_locations.change(body(service))
    with patch.object(service.router, "routing_capabilities", return_value={"version":1,"ready":True}):
        with pytest.raises(routing.RoutingError, match="helper v3"):
            service.device_locations.change(body(service))
    assert not service.devices.gateway.snapshot()["records"][MAC]["reserved_ip"]

def test_first_assignment_does_not_overwrite_an_unowned_overlay(service):
    foreign = b'{"routing":{"rules":[{"outboundTag":"direct"}]}}'
    service.router._mock_overlay = foreign
    with pytest.raises(routing.RoutingError, match="already exists"):
        service.device_locations.change(body(service))
    assert service.router.read_bundle()[compiler.OVERLAY_FILE] == foreign
    assert not service.devices.gateway.snapshot()["records"][MAC]["reserved_ip"]

@pytest.mark.parametrize("asynchronous", [False, True])
def test_unavailable_subscription_allows_cached_main_and_preserves_fixed_exits(service, asynchronous):
    from .test_routing_service import wait_terminal
    assign(service)
    before = service.router.read_bundle()
    device_state = service.device_locations.read()
    service.state.write_state({"last_update_status": "fail"})
    service.fetch_fn = MagicMock(side_effect=AssertionError("Ordinary switches must not fetch"))
    if asynchronous:
        op = service.routing.submit_main("de", routing.new_id())
        result = wait_terminal(service.routing, op)
        assert result["phase"] == "committed"
        assert result["warning"] == "Subscription refresh failed; using saved location configuration."
    else:
        service.switch("de")
    service.fetch_fn.assert_not_called()
    after = service.router.read_bundle()
    assert after[compiler.ROUTING_FILE] == before[compiler.ROUTING_FILE]
    assert after[compiler.OVERLAY_FILE] == before[compiler.OVERLAY_FILE]
    assert service.device_locations.read() == device_state
    assert service.state.read_state()["active_code"] == "de"
    assert service.status()["last_update_status"] == "fail"
    switches = [entry for entry in service.state.read_history(100) if entry.get("action") == "switch" and entry.get("code") == "de"]
    assert len(switches) == 1 and switches[0]["result"] == "ok"
    assert switches[0]["warning"]

def test_unavailable_subscription_allows_cached_device_assignment(service):
    main = service.router.read_bundle()[compiler.OUTBOUNDS_FILE]
    service.fetch_fn = lambda url: (_ for _ in ()).throw(RuntimeError("provider unavailable"))
    op = assign(service, "tr")
    assert op["phase"] == "committed"
    assert op["warning"] == "Subscription refresh failed; using saved location configuration."
    assert op["kind"] == "device-location"
    assert service.device_locations.read()["assignments"][MAC]["code"] == "tr"
    assert service.router.read_bundle()[compiler.OUTBOUNDS_FILE] == main
    assert service.status()["last_update_status"] == "fail"
    assert any(entry.get("cached_subscription") for entry in service.state.read_history(100))
    history = [entry for entry in service.state.read_history(100) if entry.get("operation_id") == op["id"]]
    assert len(history) == 1 and history[0]["result"] == "ok" and history[0]["warning"] == op["warning"]

def test_cached_main_warning_is_visible_while_router_apply_is_pending(service, monkeypatch):
    import threading
    from .test_routing_service import wait_terminal
    entered, release = threading.Event(), threading.Event()
    original = service.router.start_bundle
    def delayed(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(service.router, "start_bundle", delayed)
    service.state.write_state({"last_update_status": "fail"})
    service.fetch_fn = lambda url: (_ for _ in ()).throw(AssertionError("Ordinary switches must not fetch"))
    op = service.routing.submit_main("de", routing.new_id())
    try:
        assert entered.wait(1)
        current = service.status()["operation"]
        assert current["id"] == op["id"] and current["blocking"]
        assert current["warning"] == "Subscription refresh failed; using saved location configuration."
        assert service.status()["last_update_status"] == "fail"
    finally:
        release.set()
    assert wait_terminal(service.routing, op)["phase"] == "committed"

def test_main_deferred_validation_rejects_invalid_outbound_before_any_live_write(service):
    before = service.router.read_bundle()
    before_state = service.device_locations.read()
    with patch.object(service.router, "validate_bundle", wraps=service.router.validate_bundle) as validate:
        bundle_id, environment = service.device_locations.prepare(None, main="{invalid JSON", main_only=True)
        validate.assert_not_called()
        result = service.routing.apply_bundle(bundle_id=bundle_id, environment=environment, synchronous=True)
        assert result["phase"] == "rejected", result
        validate.assert_called_once()
    assert service.router.read_bundle() == before
    assert service.device_locations.read() == before_state
    assert service.state.read_state()["active_code"] == "fi"
    assert service.router.routing_health() == "running"

@pytest.mark.parametrize("change", ["environment", "routing", "overlay"])
@pytest.mark.parametrize("during_validation", [False, True])
def test_main_deferred_validation_keeps_compare_and_swap_guards(service, monkeypatch, change, during_validation):
    from xk_switcher.outbound import build
    assign(service)
    before = service.router.read_bundle()
    bundle_id, environment = service.device_locations.prepare(None, main=build(_sample_loc("de")), main_only=True)
    bundle, candidate = service.routing.store.blob("bundles", bundle_id)
    original_validate = service.router.validate_bundle
    def external_change():
        if change == "environment":
            monkeypatch.setattr(service.router, "bundle_environment", lambda: "f" * 64)
        elif change == "routing":
            service.router._mock_routing = before[compiler.ROUTING_FILE] + b"\n// external change\n"
        else:
            service.router._mock_overlay = before[compiler.OVERLAY_FILE] + b"\n"
    if during_validation:
        def validate(payload):
            original_validate(payload)
            external_change()
        monkeypatch.setattr(service.router, "validate_bundle", validate)
    else:
        external_change()
    ident = routing.new_id()
    service.router.start_bundle(ident, bundle["before_hash"], environment, candidate)
    assert service.router.routing_operation(ident)["phase"] == "rejected"
    after = service.router.read_bundle()
    assert after[compiler.OUTBOUNDS_FILE] == before[compiler.OUTBOUNDS_FILE]
    assert after[compiler.ROUTING_FILE] == before[compiler.ROUTING_FILE] + (b"\n// external change\n" if change == "routing" else b"")
    assert after[compiler.OVERLAY_FILE] == before[compiler.OVERLAY_FILE] + (b"\n" if change == "overlay" else b"")
    assert service.state.read_state()["active_code"] == "fi"


def test_chain_switch_and_device_routing_edits_preserve_ownership(service):
    from .test_routing_service import draft_and_preview, wait_result
    assign(service)
    before = service.router.read_bundle()
    devices = service.device_locations.read()
    service.switch("de", entry_code="fi")
    after = service.router.read_bundle()
    assert after[compiler.ROUTING_FILE] == before[compiler.ROUTING_FILE]
    assert after[compiler.OVERLAY_FILE] == before[compiler.OVERLAY_FILE]
    assert service.device_locations.read() == devices
    main = after[compiler.OUTBOUNDS_FILE]
    assign(service, code="de")
    assert service.router.read_bundle()[compiler.OUTBOUNDS_FILE] == main
    _, _, preview = draft_and_preview(service)
    op = wait_result(service.routing, service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()}))
    assert op["phase"] == "committed", op
    assert service.router.read_bundle()[compiler.OUTBOUNDS_FILE] == main
    assert service.state.read_state()["active_entry_code"] == "fi"
