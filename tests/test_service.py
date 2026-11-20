import base64
import json
import re
from datetime import datetime, timedelta, timezone
from dataclasses import asdict
from unittest.mock import MagicMock
import pytest
from xk_switcher.state import State
from xk_switcher.subscription import Location
from xk_switcher.outbound import build as build_outbound
from xk_switcher.service import Service, UnknownCodeError, TRIGGER_MANUAL
from xk_switcher.router import RouterError
from xk_switcher.failover import FailoverConfig, FailoverLoop


class _FakeRouter:
    def __init__(self, apply_raises=None, xkeen_raises=None, outbound=None, outbound_raises=None):
        self.applies = []
        self.xkeen_calls = []
        self._apply_raises = apply_raises
        self._xkeen_raises = xkeen_raises
        self._outbound = outbound
        self._outbound_raises = outbound_raises

    def apply(self, payload):
        if self._apply_raises:
            raise self._apply_raises
        self.applies.append(payload)

    def run_xkeen(self, action):
        if self._xkeen_raises:
            raise self._xkeen_raises
        self.xkeen_calls.append(action)
        return f"mock xkeen -{action}"

    def read_outbound(self):
        if self._outbound_raises:
            raise self._outbound_raises
        return self._outbound or {"outbounds": []}

_FLAG_OFFSET = 0x1F1E6
_ALPHA_OFFSET = ord("A")

def _flag(code):
    return "".join(chr(_FLAG_OFFSET + ord(ch.upper()) - _ALPHA_OFFSET) for ch in code)

def _sample_loc(code="fi", host="h.example", pbk="PBK"):
    return Location(
        code=code, name=f"{_flag(code)} name", protocol="vless",
        host=host, port=443, uuid="UUID", flow="xtls-rprx-vision",
        network="tcp", security="reality", sni=host,
        pbk=pbk, sid="SID", spx="/", fingerprint="chrome",
    )

def _seed_sub(state, locations):
    state.write_subscription({
        "fetched_at": "2026-04-18T00:00:00Z",
        "locations": [asdict(l) for l in locations],
    })

def _encoded(locs):
    lines = []
    for l in locs:
        q = (
            f"security={l.security}&type={l.network}&flow={l.flow}"
            f"&sni={l.sni}&fp={l.fingerprint}&pbk={l.pbk}&sid={l.sid}&spx=%2F"
        )
        lines.append(f"vless://{l.uuid}@{l.host}:{l.port}?{q}#{l.name}")
    return base64.b64encode("\n".join(lines).encode("utf-8"))

def _json_loc(server_name="sni.example", public_key="PBK"):
    host = "se.example.invalid"
    return Location(
        code="tr", name=f"TR {_flag('tr')}", protocol="vless",
        host=host, port=6443,
        outbound={
            "tag": "proxy",
            "protocol": "vless",
            "settings": {
                "vnext": [{
                    "address": host,
                    "port": 6443,
                    "users": [{"id": "UUID", "encryption": "none"}],
                }],
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "realitySettings": {
                    "serverName": server_name,
                    "publicKey": public_key,
                    "shortId": "SID",
                },
            },
        },
    )

def _json_encoded(locs):
    return json.dumps([
        {"remarks": loc.name, "outbounds": [loc.outbound]}
        for loc in locs
    ]).encode("utf-8")

def _subscription_bytes(locs):
    from xk_switcher.codes import code_for
    from xk_switcher.outbound import build
    rows = []
    for loc in locs:
        name = loc.name
        if code_for(name) != loc.code:
            country = re.match(r"[a-z]{2}", loc.code)[0]
            name = f"{_flag(country)} {loc.code[2:]}"
        rows.append({"remarks": name, "outbounds": [{**json.loads(build(loc))["outbounds"][0], "tag": "proxy"}]})
    return json.dumps(rows).encode()

def _service_with_subscription(state, router):
    state.write_state({"subscription_url": "https://sub.example"})
    return Service(state, router, fetch_fn=lambda url: _subscription_bytes([
        Location(**loc) for loc in state.read_subscription().get("locations", [])
    ]))

@pytest.fixture
def service(tmp_data_dir):
    state = State(tmp_data_dir)
    state.init({"subscription_url": "https://sub.example"})
    router = MagicMock()
    return _service_with_subscription(state, router)

def test_switch_applies_outbound_and_updates_state(service):
    _seed_sub(service.state, [_sample_loc("fi"), _sample_loc("de", host="d.example", pbk="PBK2")])
    service.switch("fi")
    service.router.apply.assert_called_once()
    payload = service.router.apply.call_args[0][0]
    assert "h.example" in payload
    assert service.state.read_state()["active_code"] == "fi"

def test_switch_unknown_code_raises(service):
    _seed_sub(service.state, [_sample_loc("fi")])
    with pytest.raises(UnknownCodeError):
        service.switch("xx")

def test_switch_router_error_preserves_state(service):
    _seed_sub(service.state, [_sample_loc("fi")])
    service.router.apply.side_effect = Exception("ssh fail")
    with pytest.raises(Exception, match="ssh fail"):
        service.switch("fi")
    assert service.state.read_state()["active_code"] is None

def test_update_noop_when_nothing_changed(service):
    loc = _sample_loc("fi")
    _seed_sub(service.state, [loc])
    service.state.write_state({"active_code": "fi"})
    service.fetch_fn = lambda url: _encoded([loc])
    service.update()
    service.router.apply.assert_not_called()

@pytest.mark.parametrize("trigger", ["manual", "cron"])
@pytest.mark.parametrize("failure", ["fetch", "parse"])
def test_update_failure_marks_status_and_preserves_saved_configuration(service, trigger, failure, caplog):
    _seed_sub(service.state, [_sample_loc("fi")])
    service.state.write_state({
        "active_code": "fi", "last_update_status": "ok", "last_update_at": "2026-09-22T00:00:00Z",
        "pending_reapply_code": "fi", "pending_reapply_since": "2026-09-22T00:00:00Z",
        "pending_main_config": True, "pending_device_configs": False, "pending_update_kind": "config",
        "pending_non_sni_since": "2026-09-22T00:00:00Z",
    })
    before = service.state.read_state()
    saved = service.state.read_subscription()
    def fail_fetch(url):
        raise RuntimeError("https://private.example/sub/SECRET failed")
    service.fetch_fn = fail_fetch if failure == "fetch" else lambda url: b"[{ invalid json"

    with pytest.raises((RuntimeError, ValueError)):
        service.update(trigger=trigger)

    assert service.state.read_state() == {**before, "last_update_status": "fail"}
    assert service.state.read_subscription() == saved
    assert service.cached_subscription_warning() is not None
    service.router.apply.assert_not_called()
    history = service.state.read_history(100)
    assert len(history) == 1
    assert history[0]["action"] == "update" and history[0]["result"] == "fail"
    assert history[0]["trigger"] == trigger
    assert not history[0].get("cached_subscription")
    assert "SECRET" not in caplog.text and "SECRET" not in json.dumps(history)

def test_successful_update_clears_previous_refresh_failure(service):
    location = _sample_loc("fi")
    _seed_sub(service.state, [location])
    service.state.write_state({"active_code": "fi", "last_update_status": "ok",
                               "last_update_at": "2026-09-22T00:00:00Z"})
    def fail_fetch(url):
        raise TimeoutError("provider unavailable")
    service.fetch_fn = fail_fetch
    with pytest.raises(TimeoutError):
        service.update()
    assert service.state.read_state()["last_update_status"] == "fail"

    service.fetch_fn = lambda url: _encoded([location])
    service.update()

    state = service.state.read_state()
    assert state["last_update_status"] == "ok"
    assert state["last_update_at"] != "2026-09-22T00:00:00Z"
    assert service.state.read_subscription()["fetched_at"] != "2026-04-18T00:00:00Z"
    assert state["pending_reapply_code"] is None
    assert service.cached_subscription_warning() is None

def test_refresh_before_apply_failure_keeps_cached_fallback(service, caplog):
    _seed_sub(service.state, [_sample_loc("fi")])
    service.state.write_state({"active_code": "fi", "last_update_status": "ok",
                               "last_update_at": "2026-09-22T00:00:00Z"})
    before = service.state.read_state()
    saved = service.state.read_subscription()
    def fail_fetch(url):
        raise RuntimeError("https://private.example/sub/SECRET failed")
    service.fetch_fn = fail_fetch

    result = service.refresh_before_apply()

    assert result["cached"] is True and result["warning"]
    assert service.state.read_state() == {**before, "last_update_status": "fail"}
    assert service.state.read_subscription() == saved
    history = service.state.read_history(100)
    assert len(history) == 1 and history[0]["cached_subscription"] is True
    assert history[0]["result"] == "fail"
    assert "SECRET" not in caplog.text and "SECRET" not in json.dumps(history)

def test_update_queues_reapply_when_active_params_differ(service):
    old = _sample_loc("fi", host="old.example")
    new = _sample_loc("fi", host="new.example")
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "fi"})
    service.fetch_fn = lambda url: _encoded([new])
    result = service.update()
    service.router.apply.assert_not_called()
    assert result["queued_reapply"] is True
    assert service.state.read_state()["pending_reapply_code"] == "fi"

def test_update_queues_reapply_when_only_reality_server_name_changes(service):
    old = _json_loc(server_name="old-sni.example")
    new = _json_loc(server_name="new-sni.example")
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "tr"})
    service.fetch_fn = lambda url: _json_encoded([new])

    result = service.update()

    service.router.apply.assert_not_called()
    assert result["noop"] is False
    assert result["reapplied"] is False
    assert result["queued_reapply"] is True
    assert service.state.read_state()["pending_reapply_code"] == "tr"
    cached = service.state.read_subscription()["locations"][0]
    assert (
        cached["outbound"]["streamSettings"]["realitySettings"]["serverName"]
        == "new-sni.example"
    )

def test_update_queues_reapply_when_reality_credentials_change(service):
    old = _json_loc(server_name="old-sni.example", public_key="OLD-PBK")
    new = _json_loc(server_name="new-sni.example", public_key="NEW-PBK")
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "tr"})
    service.fetch_fn = lambda url: _json_encoded([new])

    result = service.update()

    service.router.apply.assert_not_called()
    assert result["reapplied"] is False
    assert result["queued_reapply"] is True
    assert service.state.read_state()["pending_reapply_code"] == "tr"

def test_apply_pending_reapply_uses_latest_config_and_clears_queue(service):
    old = _json_loc(server_name="old-sni.example")
    new = _json_loc(server_name="new-sni.example")
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "tr"})
    service.fetch_fn = lambda url: _json_encoded([new])
    service.update()
    service.state.write_state({
        "auto_update_enabled": True,
        "auto_update_mode": "interval",
        "pending_reapply_since": "2020-01-01T00:00:00+00:00",
    })

    applied = service.apply_pending_reapply()

    assert applied is True
    service.router.apply.assert_called_once()
    assert "new-sni.example" in service.router.apply.call_args[0][0]
    assert service.state.read_state()["pending_reapply_code"] is None

def test_apply_pending_reapply_is_noop_without_queued_change(service):
    _seed_sub(service.state, [_json_loc()])
    service.state.write_state({"active_code": "tr"})

    applied = service.apply_pending_reapply()

    assert applied is False
    service.router.apply.assert_not_called()

@pytest.mark.parametrize("reason", ["empty", "future", "disabled", "stopped"])
def test_scheduled_noop_does_not_publish_an_update_activity(service, auto_update_clock, monkeypatch, reason):
    service.state.write_state({
        "active_code": "tr", "xkeen_state": "running", "auto_update_enabled": True,
        "auto_update_mode": "interval", "auto_update_interval_minutes": 5,
        "pending_reapply_code": "tr", "pending_reapply_since": "2026-09-10T08:00:00+00:00",
    })
    changes = {"empty": {"pending_reapply_code": None},
               "future": {"pending_reapply_since": auto_update_clock.current.isoformat()},
               "disabled": {"auto_update_enabled": False}, "stopped": {"xkeen_state": "stopped"}}
    service.state.write_state(changes[reason])
    activity = MagicMock(wraps=service.routing.activity)
    monkeypatch.setattr(service.routing, "activity", activity)
    service.fetch_fn = MagicMock()

    assert service.apply_pending_reapply() is False

    activity.assert_not_called()
    service.fetch_fn.assert_not_called()
    service.router.apply.assert_not_called()
    assert service.state.read_state()["auto_update_attempt_at"] is None

def test_scheduled_apply_publishes_only_due_work_and_rechecks_after_admission(service, auto_update_clock, monkeypatch):
    from contextlib import contextmanager
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 5})
    _pending_auto_update(service)
    auto_update_clock.current += timedelta(minutes=5)
    admission = service.routing.admission

    @contextmanager
    def postponed_admission(**kwargs):
        with admission(**kwargs):
            service.state.write_state({"auto_update_changed_at": auto_update_clock.current.isoformat()})
            yield

    monkeypatch.setattr(service.routing, "admission", postponed_admission)
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_not_called()
    assert service.state.read_state()["auto_update_attempt_at"] is None

    monkeypatch.setattr(service.routing, "admission", admission)
    auto_update_clock.current += timedelta(minutes=5)
    fetch = service.fetch_fn
    activities = []

    def observe_refresh(url):
        activities.append(service.routing.public_operation())
        return fetch(url)

    service.fetch_fn = observe_refresh
    assert service.apply_pending_reapply() is True
    assert activities[0]["kind"] == "apply_pending_reapply"
    assert activities[0]["source"] == "scheduler"
    assert activities[0]["blocking"] is True
    assert service.routing.public_operation() is None

def test_apply_pending_reapply_does_not_start_manually_stopped_xkeen(service):
    _seed_sub(service.state, [_json_loc()])
    service.state.write_state({
        "active_code": "tr",
        "xkeen_state": "stopped",
        "xkeen_stop_cause": "manual",
        "pending_reapply_code": "tr",
    })

    applied = service.apply_pending_reapply()

    assert applied is False
    service.router.apply.assert_not_called()
    assert service.state.read_state()["pending_reapply_code"] == "tr"

def test_update_marks_stale_when_active_missing(service):
    _seed_sub(service.state, [_sample_loc("fi")])
    service.state.write_state({"active_code": "fi"})
    service.fetch_fn = lambda url: _encoded([_sample_loc("de", host="d.example", pbk="PBK2")])
    service.update()
    service.router.apply.assert_not_called()
    assert service.state.read_state()["active_status"] == "stale"


def test_update_prunes_vanished_locations_from_failover_whitelist(service):
    fi = _sample_loc("fi")
    de = _sample_loc("de", host="d.example", pbk="PBK2")
    lv = _sample_loc("lv", host="l.example", pbk="PBK3")
    _seed_sub(service.state, [fi, lv, de])
    service.state.write_state({"active_code": "fi"})
    service.state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["fi", "lv", "de"],
    })
    service.fetch_fn = lambda url: _encoded([fi, de])

    service.update()

    assert service.state.read_failover()["whitelist"] == ["fi", "de"]


def _route_result(ok):
    return {
        "ok": ok,
        "results": [
            {"name": "youtube", "ok": ok, "status": 204 if ok else 503},
            {"name": "avito", "ok": False, "status": 503},
        ],
    }


def _service_with_vanished_active(tmp_path, route_check_fn):
    from ._helpers import mark_server_for_route_checks
    state = State(tmp_path)
    state.init({"subscription_url": "https://sub.example"})
    lv = _sample_loc("lv", host="l.example", pbk="PBK1")
    de = _sample_loc("de", host="d.example", pbk="PBK2")
    fi = _sample_loc("fi", host="f.example", pbk="PBK3")
    _seed_sub(state, [lv, de, fi])
    state.write_state({"active_code": "lv", "xkeen_state": "running"})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["lv", "de", "fi"],
    })
    router = _FakeRouter()
    service = Service(state=state, router=router, fetch_fn=lambda url: _encoded([de, fi]))
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        route_check_fn=route_check_fn,
    )
    loop._tcp_probe = lambda host, port: (True, 20)
    service.failover_loop = loop
    return service, router


def test_update_recovery_tries_tcp_candidates_until_route_works(tmp_path):
    routes = MagicMock(side_effect=[_route_result(False), _route_result(True)])
    service, router = _service_with_vanished_active(tmp_path, routes)

    result = service.update()

    assert len(router.applies) == 2
    assert routes.call_count == 2
    assert service.state.read_state()["active_code"] == "fi"
    assert service.state.read_state()["active_status"] == "ok"
    assert result["recovery_attempted"] is True
    assert result["recovered"] is True
    assert result["stale"] is False


def test_update_recovery_stays_on_last_checked_when_no_route_works(tmp_path):
    service, router = _service_with_vanished_active(
        tmp_path, lambda: _route_result(False),
    )

    result = service.update()

    assert len(router.applies) == 2
    assert service.state.read_state()["active_code"] == "fi"
    assert result["recovery_attempted"] is True
    assert result["recovered"] is False
    assert result["stale"] is False


def test_update_recovery_skips_tcp_unreachable_candidates(tmp_path):
    service, router = _service_with_vanished_active(
        tmp_path, lambda: _route_result(True),
    )
    service.failover_loop._tcp_probe = lambda host, port: (
        host != "d.example", 20 if host != "d.example" else None,
    )

    result = service.update()

    assert len(router.applies) == 1
    assert service.state.read_state()["active_code"] == "fi"
    assert result["recovered"] is True
    assert result["recovery_attempts"] == [
        {"code": "de", "tcp_ok": False, "applied": False, "route_ok": None},
        {"code": "fi", "tcp_ok": True, "applied": True, "route_ok": True},
    ]


def test_set_subscription_url_validates_by_fetching(service):
    service.fetch_fn = lambda url: _encoded([_sample_loc("fi")])
    service.set_subscription_url("https://new.example")
    assert service.state.read_state()["subscription_url"] == "https://new.example"

def test_set_subscription_url_fetches_new_subscription_once(service):
    calls = []

    def fetch(url):
        calls.append(url)
        return _encoded([_sample_loc("fi")])

    service.fetch_fn = fetch
    service.set_subscription_url("https://new.example")
    assert calls == ["https://new.example"]

def test_set_subscription_url_queues_active_change_without_applying(service):
    old = _sample_loc("fi", host="old.example")
    new = _sample_loc("fi", host="new.example")
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "fi"})
    service.fetch_fn = lambda url: _encoded([new])

    service.set_subscription_url("https://new.example")

    service.router.apply.assert_not_called()
    st = service.state.read_state()
    assert st["subscription_url"] == "https://new.example"
    assert st["pending_reapply_code"] == "fi"

def test_set_subscription_url_rejects_broken(service):
    service.fetch_fn = lambda url: b"not-base64-and-no-vless"
    with pytest.raises(ValueError):
        service.set_subscription_url("https://bad.example")
    assert service.state.read_state()["subscription_url"] == "https://sub.example"


def test_apply_failover_updates_active_and_logs_history(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_sample_loc("de1")), asdict(_sample_loc("ru2"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.apply_failover("ru2", reason="failover-switch")
    st = state.read_state()
    assert st["active_code"] == "ru2"
    assert st["failover_active"] is True  # ru2 is not primary (de1)
    assert st["failover_since"] is not None
    assert st["last_apply_at"] is not None
    hist = state.read_history()
    assert hist[-1]["action"] == "failover-switch"
    assert hist[-1]["trigger"] == "failover"
    assert hist[-1]["code"] == "ru2"


def test_apply_failover_clears_flag_when_switching_to_primary(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_sample_loc("de1")), asdict(_sample_loc("ru2"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": True,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    state.write_state({"failover_active": True, "failover_since": "2026-04-19T06:00:00+00:00"})
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.apply_failover("de1", reason="failback")
    st = state.read_state()
    assert st["active_code"] == "de1"
    assert st["failover_active"] is False
    assert st["failover_since"] is None


def test_apply_failover_router_error_keeps_active(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_sample_loc("de1")), asdict(_sample_loc("ru2"))]})
    state.write_state({"active_code": "de1"})
    router = _FakeRouter(apply_raises=RouterError("ssh timeout"))
    service = _service_with_subscription(state, router)
    with pytest.raises(RouterError):
        service.apply_failover("ru2", reason="failover-switch")
    assert state.read_state()["active_code"] == "de1"
    hist = state.read_history()
    assert hist[-1]["result"] == "fail"
    assert hist[-1]["trigger"] == "failover"


def test_handle_total_failure_stops_xkeen_and_sets_cause(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"xkeen_state": "running"})
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.handle_total_failure()
    st = state.read_state()
    assert st["xkeen_state"] == "stopped"
    assert st["xkeen_stop_cause"] == "failover"
    assert "stop" in router.xkeen_calls
    hist = state.read_history()
    assert hist[-1]["action"] == "total-failure-stop"
    assert hist[-1]["trigger"] == "failover"


def test_handle_total_failure_router_error_keeps_state(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"xkeen_state": "running"})
    router = _FakeRouter(xkeen_raises=RouterError("ssh down"))
    service = _service_with_subscription(state, router)
    service.handle_total_failure()  # MUST NOT raise — logs and returns
    st = state.read_state()
    assert st["xkeen_state"] == "running"
    assert st["xkeen_stop_cause"] is None
    hist = state.read_history()
    assert hist[-1]["action"] == "total-failure-stop"
    assert hist[-1]["result"] == "fail"


def test_xkeen_control_manual_stop_sets_cause_manual(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"xkeen_state": "running", "xkeen_stop_cause": None})
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.xkeen_control("stop")
    st = state.read_state()
    assert st["xkeen_state"] == "stopped"
    assert st["xkeen_stop_cause"] == "manual"


def test_xkeen_control_manual_start_clears_cause(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"xkeen_state": "stopped", "xkeen_stop_cause": "failover"})
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.xkeen_control("start")
    st = state.read_state()
    assert st["xkeen_state"] == "running"
    assert st["xkeen_stop_cause"] is None


def test_xkeen_control_restart_clears_cause(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"xkeen_state": "stopped", "xkeen_stop_cause": "failover"})
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.xkeen_control("restart")
    st = state.read_state()
    assert st["xkeen_state"] == "running"
    assert st["xkeen_stop_cause"] is None


def test_manual_switch_resets_failover_active(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_sample_loc("de1")), asdict(_sample_loc("ru2"))]})
    state.write_state({"active_code": "ru2", "failover_active": True,
                       "failover_since": "2026-04-19T06:00:00+00:00"})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.switch("de1", trigger=TRIGGER_MANUAL)
    st = state.read_state()
    assert st["active_code"] == "de1"
    assert st["failover_active"] is False
    assert st["failover_since"] is None


def test_manual_switch_records_last_apply_at(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_sample_loc("de1"))]})
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    service.switch("de1", trigger=TRIGGER_MANUAL)
    assert state.read_state()["last_apply_at"] is not None


def _outbound_config(host, port):
    return {
        "outbounds": [
            {
                "tag": "vless-reality",
                "protocol": "vless",
                "settings": {"vnext": [{"address": host, "port": port, "users": [{}]}]},
            },
            {"tag": "direct", "protocol": "freedom"},
        ],
    }


def test_sync_active_from_router_matches_by_host_port(tmp_path):
    state = State(tmp_path)
    state.init({})
    _seed_sub(state, [_sample_loc("de", host="d.example"), _sample_loc("fi", host="f.example")])
    router = _FakeRouter(outbound=_outbound_config("f.example", 443))
    service = _service_with_subscription(state, router)
    code = service.sync_active_from_router()
    assert code == "fi"
    assert state.read_state()["active_code"] == "fi"


def _outbound_config_ss(host, port):
    return {
        "outbounds": [
            {
                "tag": "vless-reality",
                "protocol": "shadowsocks",
                "settings": {"servers": [{"address": host, "port": port}]},
            },
            {"tag": "direct", "protocol": "freedom"},
        ],
    }


def test_sync_active_from_router_matches_servers_form(tmp_path):
    state = State(tmp_path)
    state.init({})
    _seed_sub(state, [_sample_loc("fialt", host="ss.example")])
    router = _FakeRouter(outbound=_outbound_config_ss("ss.example", 443))
    service = _service_with_subscription(state, router)
    assert service.sync_active_from_router() == "fialt"


def test_sync_active_from_router_idempotent_when_already_set(tmp_path):
    state = State(tmp_path)
    state.init({"active_code": "fi"})
    _seed_sub(state, [_sample_loc("fi", host="f.example")])
    router = _FakeRouter(outbound=_outbound_config("f.example", 443))
    service = _service_with_subscription(state, router)
    code = service.sync_active_from_router()
    assert code == "fi"


def test_sync_active_from_router_no_match_keeps_state(tmp_path):
    state = State(tmp_path)
    state.init({"active_code": "de"})
    _seed_sub(state, [_sample_loc("de", host="d.example")])
    router = _FakeRouter(outbound=_outbound_config("unknown.example", 443))
    service = _service_with_subscription(state, router)
    assert service.sync_active_from_router() is None
    assert state.read_state()["active_code"] == "de"


def test_sync_active_from_router_tolerates_ssh_error(tmp_path):
    state = State(tmp_path)
    state.init({"active_code": "de"})
    _seed_sub(state, [_sample_loc("de", host="d.example")])
    router = _FakeRouter(outbound_raises=RuntimeError("ssh dead"))
    service = _service_with_subscription(state, router)
    assert service.sync_active_from_router() is None
    assert state.read_state()["active_code"] == "de"


def test_sync_active_from_router_tolerates_bad_config_shape(tmp_path):
    state = State(tmp_path)
    state.init({"active_code": "de"})
    _seed_sub(state, [_sample_loc("de", host="d.example")])
    router = _FakeRouter(outbound={"outbounds": [{"tag": "direct", "protocol": "freedom"}]})
    service = _service_with_subscription(state, router)
    assert service.sync_active_from_router() is None
    assert state.read_state()["active_code"] == "de"

@pytest.fixture
def auto_update_clock(monkeypatch):
    class Clock(datetime):
        current = datetime(2026, 9, 10, 9, tzinfo=timezone.utc)

        @classmethod
        def now(cls, tz=None):
            return cls.current.astimezone(tz)

    monkeypatch.setattr("xk_switcher.service.datetime", Clock)
    return Clock

def _pending_auto_update(service):
    _seed_sub(service.state, [_json_loc(server_name="old.example")])
    service.state.write_state({"active_code": "tr", "xkeen_state": "running"})
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="new.example")])
    service.update()

def _pending_sni_update(service, **settings):
    _seed_sub(service.state, [_json_loc(server_name="applied.example")])
    service.switch("tr")
    service.router.apply.reset_mock()
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 120,
                             "daily_time": "04:30", "sni_daily": True, **settings})
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="pending.example")])
    service.update()

def test_sni_daily_batches_latest_sni_and_survives_restart(service, auto_update_clock):
    _pending_sni_update(service)
    status = service.status()
    assert status["pending_update_kind"] == "sni"
    assert status["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"
    assert service.state.read_state()["pending_non_sni_since"] is None
    auto_update_clock.current += timedelta(hours=3)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="latest.example")])
    service.update()
    assert service.apply_pending_reapply() is False
    assert service.status()["auto_update"]["next_apply_at"] == status["auto_update"]["next_apply_at"]
    restarted = Service(State(service.state.data_dir), service.router, fetch_fn=service.fetch_fn)
    auto_update_clock.current = datetime(2026, 9, 11, 1, 30, tzinfo=timezone.utc)
    assert restarted.apply_pending_reapply() is True
    assert restarted.apply_pending_reapply() is False
    service.router.apply.assert_called_once()
    assert "latest.example" in service.router.apply.call_args[0][0]
    assert restarted.status()["pending_update_kind"] is None

def test_non_sni_change_starts_its_own_interval_and_later_sni_cannot_downgrade_it(service, auto_update_clock):
    _pending_sni_update(service)
    auto_update_clock.current += timedelta(hours=1)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="pending.example", public_key="NEW")])
    service.update()
    expected = "2026-09-10T12:00:00+00:00"
    assert service.status()["pending_update_kind"] == "config"
    assert service.status()["auto_update"]["next_apply_at"] == expected
    auto_update_clock.current += timedelta(minutes=30)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="newer.example", public_key="NEW")])
    service.update()
    assert service.status()["pending_update_kind"] == "config"
    assert service.status()["auto_update"]["next_apply_at"] == expected
    auto_update_clock.current = datetime.fromisoformat(expected)
    assert service.apply_pending_reapply() is True
    assert "newer.example" in service.router.apply.call_args[0][0]
    assert "NEW" in service.router.apply.call_args[0][0]
    assert service.status()["auto_update"]["next_apply_at"] is None

def test_reverted_non_sni_change_returns_to_daily_and_full_revert_clears_pending(service, auto_update_clock):
    _pending_sni_update(service)
    auto_update_clock.current += timedelta(hours=1)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(public_key="NEW")])
    service.update()
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="pending.example")])
    service.update()
    assert service.status()["pending_update_kind"] == "sni"
    assert service.state.read_state()["pending_non_sni_since"] is None
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="applied.example")])
    service.update()
    assert service.status()["pending_reapply_code"] is None
    assert service.status()["pending_update_kind"] is None
    assert not service.apply_pending_reapply()
    service.router.apply.assert_not_called()

@pytest.mark.parametrize("method", ["apply_pending_reapply_now", "recover_pending_active"])
@pytest.mark.parametrize("enabled", [True, False])
def test_sni_schedule_does_not_block_manual_or_recovery_apply(service, auto_update_clock, method, enabled):
    _pending_sni_update(service, enabled=enabled)
    assert not service.apply_pending_reapply()
    assert getattr(service, method)()
    service.router.apply.assert_called_once()
    assert service.status()["pending_update_kind"] is None

@pytest.mark.parametrize("failure", ["fetch", "router"])
def test_failed_sni_daily_apply_preserves_pending_and_retries_next_day(service, auto_update_clock, failure):
    _pending_sni_update(service)
    auto_update_clock.current = datetime(2026, 9, 11, 1, 30, tzinfo=timezone.utc)
    if failure == "fetch":
        service.fetch_fn = MagicMock(side_effect=RuntimeError("offline"))
    else:
        service.router.apply.side_effect = RuntimeError("offline")
    with pytest.raises(RuntimeError, match="offline"):
        service.apply_pending_reapply()
    if failure == "fetch":
        service.router.apply.assert_not_called()
    assert service.status()["pending_update_kind"] == "sni"
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-12T01:30:00+00:00"
    restarted = Service(State(service.state.data_dir), service.router, fetch_fn=service.fetch_fn)
    assert not restarted.apply_pending_reapply()

def test_sni_daily_skips_missed_run_and_respects_stopped_xkeen(service, auto_update_clock):
    _pending_sni_update(service)
    auto_update_clock.current = datetime(2026, 9, 11, 9, tzinfo=timezone.utc)
    assert not service.apply_pending_reapply()
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-12T01:30:00+00:00"
    auto_update_clock.current = datetime(2026, 9, 12, 1, 30, tzinfo=timezone.utc)
    service.state.write_state({"xkeen_state": "stopped"})
    assert not service.apply_pending_reapply()
    assert service.state.read_state()["auto_update_attempt_at"] is None
    service.router.apply.assert_not_called()

def test_sni_opt_out_and_daily_mode_keep_existing_scheduling(service, auto_update_clock):
    _pending_sni_update(service, sni_daily=False)
    assert service.status()["pending_update_kind"] == "sni"
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-10T11:00:00+00:00"
    cfg = {"enabled": True, "mode": "daily", "daily_time": "22:15", "interval_minutes": 120}
    service.set_auto_update({**cfg, "sni_daily": True})
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-10T19:15:00+00:00"
    service.set_auto_update(cfg)
    assert service.status()["auto_update"]["sni_daily"] is True
    service.set_auto_update({**cfg, "mode": "interval"})
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-10T19:15:00+00:00"

def test_refresh_at_sni_deadline_cannot_apply_new_keys_before_the_interval(service, auto_update_clock):
    _pending_sni_update(service)
    auto_update_clock.current = datetime(2026, 9, 11, 1, 30, tzinfo=timezone.utc)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="pending.example", public_key="NEW")])
    assert not service.apply_pending_reapply()
    service.router.apply.assert_not_called()
    assert service.status()["pending_update_kind"] == "config"
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T03:30:00+00:00"
    auto_update_clock.current += timedelta(hours=2)
    assert service.apply_pending_reapply()
    service.router.apply.assert_called_once()

def test_refresh_at_interval_deadline_can_return_remaining_sni_to_daily(service, auto_update_clock):
    _pending_sni_update(service)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(public_key="NEW")])
    service.update()
    auto_update_clock.current += timedelta(hours=2)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="pending.example")])
    assert not service.apply_pending_reapply()
    assert service.status()["pending_update_kind"] == "sni"
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"
    service.router.apply.assert_not_called()

@pytest.mark.parametrize("pending_before_upgrade", [True, False])
def test_sni_baseline_upgrade_uses_confirmed_applied_config(service, auto_update_clock, pending_before_upgrade):
    _pending_sni_update(service)
    applied = json.loads(build_outbound(_json_loc(server_name="applied.example")))
    service.state.write_state({"applied_main_config_hashes": None})
    if not pending_before_upgrade:
        _seed_sub(service.state, [_json_loc(server_name="applied.example")])
    service.router.read_outbound.return_value = applied
    service.update()
    assert service.status()["pending_update_kind"] == "sni"
    assert service.state.read_state()["applied_main_config_hashes"]

def test_missing_baseline_never_guesses_sni_only_from_the_last_refresh(service, auto_update_clock):
    _pending_sni_update(service)
    service.state.write_state({"applied_main_config_hashes": None})
    service.router.read_outbound.side_effect = RuntimeError("unreachable")
    service.update()
    assert service.status()["pending_update_kind"] == "config"

def _attach_route_checker(service, route_check_fn):
    from ._helpers import mark_server_for_route_checks
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=service.state, service=service, router=service.router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        route_check_fn=route_check_fn,
    )
    loop._tcp_probe = MagicMock(return_value=(True, 20))
    service.failover_loop = loop
    return loop

@pytest.mark.parametrize("operation", ["switch", "failover", "start", "restart"])
def test_ordinary_location_apply_uses_available_config_without_fetching(service, operation):
    old = _json_loc(server_name="old.example")
    latest = _json_loc(server_name="fresh.example")
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "tr", "xkeen_state": "running"})
    events = []
    fetch_latest = MagicMock(side_effect=AssertionError("Ordinary switches must not fetch"))
    def apply(payload):
        assert "old.example" in payload and "fresh.example" not in payload
        events.append("apply")
    def check():
        events.append("check")
        assert service.state.read_state()["active_code"] == "tr"
        return _route_result(True)
    service.fetch_fn = fetch_latest
    service.router.apply.side_effect = apply
    loop = _attach_route_checker(service, check)
    if operation == "switch":
        service.switch("tr")
    elif operation == "failover":
        service.apply_failover("tr", reason="failover-switch")
    else:
        service.xkeen_control(operation)
    assert events == ["apply", "check"]
    fetch_latest.assert_not_called()
    loop._tcp_probe.assert_called_once_with(old.host, old.port)
    result = service.status()["server_route"]["check"]
    assert result["ok"] and result["active_code"] == "tr"
    assert result["tcp"]["latency_ms"] == 20

@pytest.mark.parametrize("operation", ["switch", "failover", "restart"])
def test_ordinary_apply_rejects_target_missing_from_available_subscription(service, operation):
    _seed_sub(service.state, [_sample_loc("de")])
    service.state.write_state({"active_code": "fi", "xkeen_state": "running"})
    checker = MagicMock(return_value=_route_result(True))
    _attach_route_checker(service, checker)
    service.fetch_fn = MagicMock(return_value=_encoded([_sample_loc("fi")]))
    with pytest.raises(UnknownCodeError):
        if operation == "switch":
            service.switch("fi")
        elif operation == "failover":
            service.apply_failover("fi", reason="failover-switch")
        else:
            service.xkeen_control("restart")
    service.router.apply.assert_not_called()
    service.router.run_xkeen.assert_not_called()
    checker.assert_not_called()
    service.fetch_fn.assert_not_called()

def test_post_apply_check_runs_http_even_when_tcp_fails_without_recursive_failover(service):
    _seed_sub(service.state, [_sample_loc("fi"), _sample_loc("de")])
    service.state.write_failover({"enabled": True, "whitelist": ["fi", "de"]})
    checker = MagicMock(return_value=_route_result(False))
    loop = _attach_route_checker(service, checker)
    loop._tcp_probe.return_value = (False, None)
    loop._decider.fail_threshold = 1
    service.switch("fi")
    service.router.apply.assert_called_once()
    checker.assert_called_once()
    check = service.status()["server_route"]["check"]
    assert not check["ok"] and check["route"]["results"]
    assert service.state.read_state()["active_code"] == "fi"

@pytest.mark.parametrize("trigger", ["manual", "cron"])
@pytest.mark.parametrize("changed", [False, True])
def test_subscription_update_checks_route_and_records_health(service, trigger, changed):
    old = _sample_loc("fi")
    new = _sample_loc("fi", pbk="NEW" if changed else old.pbk)
    _seed_sub(service.state, [old])
    service.state.write_state({"active_code": "fi", "xkeen_state": "running"})
    service.fetch_fn = lambda url: _encoded([new])
    route_check = MagicMock(return_value=_route_result(True))
    loop = _attach_route_checker(service, route_check)

    result = service.update(trigger=trigger)

    route_check.assert_called_once()
    loop._tcp_probe.assert_called_once_with(old.host, old.port)
    health = service.state.read_health()["map"]["fi"]
    assert health["tcp_ok"] is True
    assert health["route_ok"] is True
    assert health["route_checked_at"] is not None
    assert result["queued_reapply"] is changed
    service.router.apply.assert_not_called()

def test_subscription_url_change_checks_route(service):
    loc = _sample_loc("fi")
    _seed_sub(service.state, [loc])
    service.state.write_state({"active_code": "fi", "xkeen_state": "running"})
    service.fetch_fn = lambda url: _encoded([loc])
    observed_urls = []

    def check_route():
        observed_urls.append(service.state.read_state()["subscription_url"])
        return _route_result(True)

    _attach_route_checker(service, check_route)
    service.set_subscription_url("https://new.example")
    assert observed_urls == ["https://new.example"]

@pytest.mark.parametrize("state_patch", [
    {"active_code": None},
    {"active_code": "de"},
    {"xkeen_state": "stopped"},
])
def test_subscription_update_skips_route_without_running_active(service, state_patch):
    loc = _sample_loc("fi")
    _seed_sub(service.state, [loc])
    service.router.read_outbound.return_value = {"outbounds": []}
    service.state.write_state({"active_code": "fi", "xkeen_state": "running", **state_patch})
    service.fetch_fn = lambda url: _encoded([loc])
    route_check = MagicMock(return_value=_route_result(True))
    loop = _attach_route_checker(service, route_check)

    service.update()

    route_check.assert_not_called()
    loop._tcp_probe.assert_not_called()

@pytest.mark.parametrize("automatic", [False, True])
def test_pending_apply_checks_route_once_after_router_apply(service, auto_update_clock, automatic):
    service.set_auto_update({"enabled": True, "interval_minutes": 5})
    _pending_auto_update(service)
    auto_update_clock.current += timedelta(minutes=5)
    observed_applies = []

    def check_route():
        observed_applies.append(service.router.apply.call_count)
        assert service.state.read_state()["pending_reapply_code"] is None
        return _route_result(True)

    _attach_route_checker(service, check_route)
    apply = service.apply_pending_reapply if automatic else service.apply_pending_reapply_now

    assert apply() is True
    assert observed_applies == [1]
    assert service.state.read_health()["map"]["tr"]["ok"] is True

@pytest.mark.parametrize("failure", ["fetch", "apply"])
def test_failed_pending_apply_does_not_check_route(service, failure):
    _pending_auto_update(service)
    route_check = MagicMock(return_value=_route_result(True))
    _attach_route_checker(service, route_check)
    if failure == "fetch":
        service.fetch_fn = MagicMock(side_effect=RuntimeError("fetch failed"))
    else:
        service.router.apply.side_effect = RuntimeError("apply failed")

    with pytest.raises(RuntimeError, match="failed"):
        service.apply_pending_reapply_now()

    route_check.assert_not_called()
    assert service.state.read_state()["pending_reapply_code"] == "tr"

def test_automatic_route_failure_uses_shared_failover_health(service):
    locs = [_sample_loc("fi"), _sample_loc("de", host="d.example")]
    _seed_sub(service.state, locs)
    service.state.write_state({"active_code": "fi", "xkeen_state": "running"})
    service.state.write_failover({"enabled": True, "whitelist": ["fi", "de"]})
    service.fetch_fn = lambda url: _encoded(locs)
    _attach_route_checker(service, lambda: _route_result(False))

    for _ in range(2):
        service.update()
    assert service.state.read_state()["active_code"] == "fi"
    service.update()

    assert service.state.read_health()["map"]["fi"]["fail_streak"] == 3
    assert service.state.read_state()["active_code"] == "de"
    service.router.apply.assert_called_once()

def test_update_route_check_refreshes_pending_recovery_without_recursion(service):
    _seed_sub(service.state, [_sample_loc("fi", pbk="OLD")])
    service.state.write_state({"active_code": "fi", "xkeen_state": "running"})
    service.state.write_failover({"enabled": True, "whitelist": ["fi"]})
    service.state.write_health({"map": {"fi": {"ok": False, "fail_streak": 2}}})
    service.fetch_fn = MagicMock(side_effect=[
        _encoded([_sample_loc("fi", pbk="QUEUED")]),
        _encoded([_sample_loc("fi", pbk="FRESH")]),
    ])
    route_check = MagicMock(side_effect=[_route_result(False), _route_result(True)])
    loop = _attach_route_checker(service, route_check)

    service.update()

    assert service.fetch_fn.call_count == 2
    assert route_check.call_count == 2
    assert loop._tcp_probe.call_count == 2
    service.router.apply.assert_called_once()
    assert "FRESH" in service.router.apply.call_args[0][0]
    assert service.state.read_state()["pending_reapply_code"] is None
    assert service.state.read_health()["map"]["fi"]["route_ok"] is True
    assert service.state.read_health()["map"]["fi"]["fail_streak"] == 0

def test_route_checker_error_does_not_fail_successful_apply(service, caplog):
    _pending_auto_update(service)
    loop = _attach_route_checker(service, lambda: _route_result(True))
    loop.check_current_route = MagicMock(side_effect=RuntimeError("checker failed"))

    assert service.apply_pending_reapply_now() is True

    assert service.state.read_state()["pending_reapply_code"] is None
    assert service.state.read_state()["last_update_status"] == "ok"
    assert "post-apply route check failed" in caplog.text

@pytest.mark.parametrize("method", ["apply_pending_reapply_now", "apply_pending_reapply", "recover_pending_active"])
def test_pending_apply_fetches_config_rotated_after_queue(service, auto_update_clock, method):
    service.set_auto_update({"enabled": True, "interval_minutes": 5})
    _pending_auto_update(service)
    service.fetch_fn = MagicMock(return_value=_json_encoded([_json_loc(server_name="fresh.example")]))
    auto_update_clock.current += timedelta(minutes=5)
    apply = getattr(service, method)
    assert apply() is True
    service.fetch_fn.assert_called_once_with("https://sub.example")
    assert "fresh.example" in service.router.apply.call_args[0][0]
    assert service.state.read_state()["pending_reapply_code"] is None

@pytest.mark.parametrize("method", ["apply_pending_reapply_now", "apply_pending_reapply", "recover_pending_active"])
def test_pending_apply_fetch_failure_never_applies_cache(service, auto_update_clock, method):
    service.set_auto_update({"enabled": True, "interval_minutes": 5})
    _pending_auto_update(service)
    service.fetch_fn = MagicMock(side_effect=RuntimeError("subscription unavailable"))
    auto_update_clock.current += timedelta(minutes=5)
    apply = getattr(service, method)
    with pytest.raises(RuntimeError, match="subscription unavailable"):
        apply()
    service.router.apply.assert_not_called()
    assert service.state.read_state()["pending_reapply_code"] == "tr"
    assert service.state.read_state()["last_update_status"] == "fail"
    if method == "apply_pending_reapply":
        assert apply() is False
        service.fetch_fn.assert_called_once()

def test_pending_apply_does_not_apply_vanished_location(service):
    _pending_auto_update(service)
    service.fetch_fn = lambda url: _encoded([_sample_loc("fi")])
    assert service.apply_pending_reapply_now() is False
    service.router.apply.assert_not_called()
    assert service.state.read_state()["active_status"] == "stale"

def test_pending_apply_unchanged_refresh_still_applies_queued_config(service):
    _pending_auto_update(service)
    assert service.apply_pending_reapply_now() is True
    assert "new.example" in service.router.apply.call_args[0][0]

def test_pending_apply_refresh_recovers_vanished_active_without_applying_twice(tmp_path):
    route_check = MagicMock(return_value=_route_result(True))
    service, router = _service_with_vanished_active(tmp_path, route_check)
    service.state.write_state({"pending_reapply_code": "lv"})
    assert service.apply_pending_reapply_now() is True
    assert len(router.applies) == 1
    route_check.assert_called_once()
    assert service.state.read_state()["active_code"] == "de"
    assert service.state.read_state()["pending_reapply_code"] is None

@pytest.mark.parametrize("route_ok", [False, True])
def test_failover_pending_refresh_handles_vanished_active_once(tmp_path, route_ok):
    service, router = _service_with_vanished_active(tmp_path, lambda: _route_result(route_ok))
    service.state.write_state({"pending_reapply_code": "lv"})
    service.state.write_health({"map": {"lv": {"ok": False, "fail_streak": 2}}})
    service.failover_loop._route_check_fn = MagicMock(
        side_effect=[_route_result(False)] + [_route_result(route_ok)] * 2,
    )

    service.failover_loop.tick_once()

    expected_codes = ["de"] if route_ok else ["de", "fi"]
    assert len(router.applies) == len(expected_codes)
    assert service.state.read_state()["active_code"] == expected_codes[-1]
    assert service.state.read_state()["pending_reapply_code"] is None
    assert service.state.read_failover()["whitelist"] == ["de", "fi"]
    for code in expected_codes:
        assert service.state.read_health()["map"][code]["route_ok"] is route_ok

def test_auto_update_batches_latest_config_without_extending_deadline(service, auto_update_clock):
    service.set_auto_update({"enabled": True, "interval_minutes": 60})
    _pending_auto_update(service)
    due = service.status()["auto_update"]["next_apply_at"]
    assert due == "2026-09-10T10:00:00+00:00"
    auto_update_clock.current += timedelta(minutes=59)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="latest.example")])
    service.update()
    assert service.status()["auto_update"]["next_apply_at"] == due
    assert service.apply_pending_reapply() is False
    auto_update_clock.current += timedelta(minutes=1)
    restarted = Service(State(service.state.data_dir), service.router, fetch_fn=service.fetch_fn)
    assert restarted.apply_pending_reapply() is True
    assert "latest.example" in service.router.apply.call_args[0][0]
    assert restarted.apply_pending_reapply() is False
    assert restarted.status()["auto_update"]["next_apply_at"] is None
    service.router.apply.assert_called_once()

@pytest.mark.parametrize("manual", [False, True])
def test_disabled_auto_update_keeps_manual_and_recovery_available(service, auto_update_clock, manual):
    service.set_auto_update({"enabled": False, "interval_minutes": 60})
    _pending_auto_update(service)
    auto_update_clock.current += timedelta(days=2)
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_not_called()
    apply = service.apply_pending_reapply_now if manual else service.recover_pending_active
    assert apply() is True
    service.router.apply.assert_called_once()

def test_enabling_and_changing_interval_start_fresh_timer(service, auto_update_clock):
    _pending_auto_update(service)
    auto_update_clock.current += timedelta(days=2)
    service.set_auto_update({"enabled": True, "interval_minutes": 60})
    assert service.apply_pending_reapply() is False
    auto_update_clock.current += timedelta(minutes=30)
    config = service.set_auto_update({"enabled": True, "interval_minutes": 5})
    assert config["next_apply_at"] == "2026-09-12T09:35:00+00:00"
    auto_update_clock.current += timedelta(minutes=4)
    assert service.set_auto_update({"enabled": True, "interval_minutes": 5}) == config
    assert service.apply_pending_reapply() is False
    service.set_auto_update({"enabled": False, "interval_minutes": 5})
    auto_update_clock.current += timedelta(minutes=1)
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_not_called()

def test_auto_update_failure_retains_pending_and_waits_before_retry(service, auto_update_clock):
    service.set_auto_update({"enabled": True, "interval_minutes": 5})
    _pending_auto_update(service)
    auto_update_clock.current += timedelta(minutes=5)
    service.router.apply.side_effect = RuntimeError("router unavailable")
    with pytest.raises(RuntimeError, match="router unavailable"):
        service.apply_pending_reapply()
    assert service.state.read_state()["pending_reapply_code"] == "tr"
    assert service.apply_pending_reapply() is False
    restarted = Service(State(service.state.data_dir), service.router, fetch_fn=service.fetch_fn)
    auto_update_clock.current += timedelta(minutes=4)
    assert restarted.apply_pending_reapply() is False
    auto_update_clock.current += timedelta(minutes=1)
    service.router.apply.side_effect = None
    assert restarted.apply_pending_reapply() is True
    assert service.router.apply.call_count == 2

def test_auto_update_due_does_not_start_stopped_router(service, auto_update_clock):
    service.set_auto_update({"enabled": True, "interval_minutes": 5})
    _pending_auto_update(service)
    service.state.write_state({"xkeen_state": "stopped", "xkeen_stop_cause": "manual"})
    auto_update_clock.current += timedelta(minutes=5)
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_not_called()
    assert service.state.read_state()["auto_update_attempt_at"] is None

def test_auto_update_with_no_changes_never_restarts(service, auto_update_clock):
    loc = _json_loc()
    _seed_sub(service.state, [loc])
    service.state.write_state({"active_code": "tr"})
    service.fetch_fn = lambda url: _json_encoded([loc])
    service.set_auto_update({"enabled": True, "interval_minutes": 5})
    auto_update_clock.current += timedelta(days=2)
    service.update()
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_not_called()

def test_daily_auto_update_defaults_to_0430_moscow_and_applies_once(service, auto_update_clock):
    auto_update_clock.current = datetime(2026, 9, 10, 1, tzinfo=timezone.utc)
    _pending_auto_update(service)
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-10T01:30:00+00:00"
    auto_update_clock.current += timedelta(minutes=29, seconds=59)
    assert service.apply_pending_reapply() is False
    auto_update_clock.current += timedelta(seconds=1)
    assert service.apply_pending_reapply() is True
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_called_once()

def test_daily_auto_update_skips_missed_run_after_restart(service, auto_update_clock):
    auto_update_clock.current = datetime(2026, 9, 10, 1, tzinfo=timezone.utc)
    _pending_auto_update(service)
    auto_update_clock.current += timedelta(hours=8)
    restarted = Service(State(service.state.data_dir), service.router, fetch_fn=service.fetch_fn)
    assert restarted.apply_pending_reapply() is False
    assert restarted.status()["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"
    service.router.apply.assert_not_called()

def test_daily_auto_update_custom_time_and_failure_retry_next_day(service, auto_update_clock):
    service.set_auto_update({
        "enabled": True, "mode": "daily", "daily_time": "00:15", "interval_minutes": 60,
    })
    _pending_auto_update(service)
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-10T21:15:00+00:00"
    auto_update_clock.current = datetime(2026, 9, 10, 21, 15, 20, tzinfo=timezone.utc)
    service.router.apply.side_effect = RuntimeError("offline")
    with pytest.raises(RuntimeError, match="offline"):
        service.apply_pending_reapply()
    assert service.apply_pending_reapply() is False
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T21:15:00+00:00"

@pytest.mark.parametrize("config", [
    {"mode": "unknown"}, {"mode": []}, {"daily_time": "24:00"},
    {"daily_time": "4:30"}, {"daily_time": "12:60"}, {"daily_time": None},
])
def test_auto_update_rejects_invalid_schedule(service, config):
    before = service.state.read_state()
    with pytest.raises(ValueError):
        service.set_auto_update({"enabled": True, "interval_minutes": 60, **config})
    assert service.state.read_state() == before

def test_interval_starts_at_first_new_config_not_previous_apply(service, auto_update_clock):
    moscow = timezone(timedelta(hours=3))
    auto_update_clock.current = datetime(2026, 9, 10, 14, 0, tzinfo=moscow)
    service.set_auto_update({"enabled": True, "interval_minutes": 60})
    _seed_sub(service.state, [_json_loc(server_name="applied.example")])
    service.switch("tr")
    service.state.write_state({"auto_update_attempt_at": auto_update_clock.current.isoformat()})
    service.router.apply.reset_mock()

    auto_update_clock.current += timedelta(minutes=59)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="first.example")])
    service.update()
    expected = datetime(2026, 9, 10, 15, 59, tzinfo=moscow)
    due = datetime.fromisoformat(service.status()["auto_update"]["next_apply_at"])
    assert due == expected

    auto_update_clock.current += timedelta(minutes=1)
    assert service.apply_pending_reapply() is False
    service.router.apply.assert_not_called()

    auto_update_clock.current += timedelta(minutes=30)
    service.fetch_fn = lambda url: _json_encoded([_json_loc(server_name="latest.example")])
    service.update()
    assert datetime.fromisoformat(service.status()["auto_update"]["next_apply_at"]) == expected
    assert service.apply_pending_reapply() is False

    auto_update_clock.current = expected - timedelta(seconds=1)
    assert service.apply_pending_reapply() is False
    auto_update_clock.current = expected
    assert service.apply_pending_reapply() is True
    service.router.apply.assert_called_once()
    assert "latest.example" in service.router.apply.call_args[0][0]
    assert service.status()["auto_update"]["next_apply_at"] is None

@pytest.mark.parametrize("operation", ["switch", "failover", "start", "restart"])
def test_ordinary_apply_uses_saved_location_after_previous_refresh_failure(service, operation, caplog):
    location = _sample_loc("fi", host="saved.example")
    _seed_sub(service.state, [location])
    service.state.write_state({"active_code": "fi", "xkeen_state": "running",
                               "last_update_at": "2026-09-22T00:00:00Z", "last_update_status": "fail"})
    before = service.state.read_subscription()
    service.fetch_fn = MagicMock(side_effect=RuntimeError("https://private.example/sub/SECRET failed"))
    if operation == "switch":
        service.switch("fi")
    elif operation == "failover":
        service.apply_failover("fi", reason="failover-switch")
    else:
        service.xkeen_control(operation)
    service.router.apply.assert_called_once()
    assert "saved.example" in service.router.apply.call_args[0][0]
    assert service.state.read_subscription() == before
    state = service.state.read_state()
    assert state["active_code"] == "fi" and state["xkeen_state"] == "running"
    assert state["last_update_status"] == "fail"
    assert state["last_update_at"] == "2026-09-22T00:00:00Z"
    history = service.state.read_history(100)
    assert history[-1]["result"] == "ok"
    assert history[-1]["warning"] == "Subscription refresh failed; using saved location configuration."
    service.fetch_fn.assert_not_called()
    assert "SECRET" not in caplog.text and "SECRET" not in json.dumps(history)

@pytest.mark.parametrize("failure", ["fetch", "parse", "missing-url"])
def test_available_subscription_rejects_unknown_target_without_fetch_or_router_io(service, failure):
    _seed_sub(service.state, [_sample_loc("fi")])
    service.state.write_state({"last_update_status": "ok"})
    if failure == "missing-url":
        service.state.write_state({"subscription_url": ""})
    elif failure == "parse":
        service.fetch_fn = lambda url: b"[{ invalid json"
    else:
        service.fetch_fn = MagicMock(side_effect=RuntimeError("provider unavailable"))
    with pytest.raises(UnknownCodeError):
        service.switch("de")
    service.router.apply.assert_not_called()
    service.router.run_xkeen.assert_not_called()
    assert service.state.read_state()["last_update_status"] == "ok"

def test_saved_subscription_fallback_does_not_mask_failed_cache_write(service, monkeypatch):
    _seed_sub(service.state, [_sample_loc("fi")])
    def fail_write(*args, **kwargs):
        raise OSError("subscription storage unavailable")
    monkeypatch.setattr(service.state, "write_subscription", fail_write)
    with pytest.raises(OSError, match="storage unavailable"):
        service.refresh_before_apply()
    service.router.apply.assert_not_called()
    assert not any(entry.get("cached_subscription") for entry in service.state.read_history(100))

@pytest.mark.parametrize("previous_status", [None, "ok"])
@pytest.mark.parametrize("operation", ["switch", "failover", "start", "restart"])
def test_ordinary_apply_does_not_invent_a_subscription_failure(service, previous_status, operation):
    _seed_sub(service.state, [_sample_loc("fi")])
    service.state.write_state({"active_code": "fi", "last_update_status": previous_status})
    service.fetch_fn = MagicMock(side_effect=AssertionError("A slow provider must not enter the switch path"))
    if operation == "switch":
        service.switch("fi")
    elif operation == "failover":
        service.apply_failover("fi", reason="failover-switch")
    else:
        service.xkeen_control(operation)
    service.fetch_fn.assert_not_called()
    service.router.apply.assert_called_once()
    assert service.state.read_state()["last_update_status"] == previous_status
    assert "warning" not in service.state.read_history(100)[-1]


@pytest.mark.parametrize("path", ["start", "restart", "manual", "failover", "scheduled"])
def test_chain_survives_every_reapply_path(tmp_path, path, auto_update_clock):
    from dataclasses import replace
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit = _sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code="ru")
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 5})
    service._update_from_locations([replace(entry, sni="changed"), exit], trigger="manual")
    assert state.read_state()["pending_reapply_entry_code"] == "ru"
    assert state.read_state()["pending_update_kind"] == "sni"
    if path in ("start", "restart"):
        service.xkeen_control(path)
    elif path == "manual":
        assert service.apply_pending_reapply_now()
    elif path == "failover":
        assert service.recover_pending_active()
    else:
        auto_update_clock.current += timedelta(minutes=6)
        assert service.apply_pending_reapply()
    assert state.read_state()["active_entry_code"] == "ru"
    assert state.read_state()["pending_reapply_code"] is None
    nodes = json.loads(router.applies[-1])["outbounds"]
    assert nodes[0]["streamSettings"]["sockopt"]["dialerProxy"] == nodes[1]["tag"]
    assert nodes[1]["streamSettings"]["realitySettings"]["serverName"] == "changed"
    service.switch("fi")
    assert state.read_state()["active_entry_code"] is None
    assert len(json.loads(router.applies[-1])["outbounds"]) == 3

@pytest.mark.parametrize("trigger", ["manual", "cron"])
@pytest.mark.parametrize("change, message", [("none", None),
    ("entry", "active config update pending"), ("missing", "active chain location vanished from subscription")])
def test_chain_subscription_refresh_logs_only_changes(tmp_path, trigger, change, message):
    from dataclasses import replace
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit = _sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code="ru")
    events_before = state.read_events()
    nodes = {"none": [entry, exit], "entry": [replace(entry, sni="changed"), exit], "missing": [exit]}[change]
    service.fetch_fn = lambda url: _subscription_bytes(nodes)

    service.update(trigger=trigger)

    events = state.read_events()
    if message is None:
        assert events == events_before
        return
    assert len(events) == len(events_before) + 1
    event = events[-1]
    assert event["action"] == "update" and event["result"] == "ok"
    assert event["trigger"] == trigger and event["message"] == message
    assert event["code"] == "fi" and event["entry_code"] == "ru"
    assert event["event_id"]
    assert len(router.applies) == 1
    assert state.read_state()["active_entry_code"] == "ru"

@pytest.mark.parametrize("missing", ["ru", "fi"])
def test_chain_missing_node_stays_stale_without_recovery(tmp_path, missing):
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    nodes = [_sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")]
    _seed_sub(state, nodes)
    state.write_failover({"enabled": True, "whitelist": ["ru", "fi"]})
    service.switch("fi", entry_code="ru")
    result = service._update_from_locations([n for n in nodes if n.code != missing], trigger="manual")
    assert result["stale"] and not result["recovery_attempted"]
    assert state.read_failover()["whitelist"] == ["ru", "fi"]
    assert not service.apply_pending_reapply_now()
    assert len(router.applies) == 1
    assert service.status()["active_missing_codes"] == [missing]
    assert service.status()["active_entry_code"] == "ru"
    assert service.status()["failover"]["suspended"]

def test_startup_sync_restores_chain_without_collapsing_it(tmp_path):
    state = State(tmp_path)
    entry, exit = _sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")
    _seed_sub(state, [entry, exit])
    router = _FakeRouter(outbound=json.loads(build_outbound(exit, entry)))
    service = Service(state, router)
    assert service.sync_active_from_router() == "fi"
    assert state.read_state()["active_entry_code"] == "ru"
    router._outbound = json.loads(build_outbound(exit))
    assert service.sync_active_from_router() == "fi"
    assert state.read_state()["active_entry_code"] is None


def test_chain_sni_daily_rechecks_both_nodes_after_refresh(tmp_path, auto_update_clock):
    from dataclasses import replace
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit = _sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code="ru")
    service.set_auto_update({"enabled": True, "mode": "interval", "interval_minutes": 120, "sni_daily": True})
    service._update_from_locations([replace(entry, sni="new-sni"), exit], trigger="manual")
    assert service.status()["auto_update"]["next_apply_at"] == "2026-09-11T01:30:00+00:00"
    auto_update_clock.current = datetime(2026, 9, 11, 1, 30, tzinfo=timezone.utc)
    service.fetch_fn = lambda url: _subscription_bytes([replace(entry, sni="new-sni"), replace(exit, pbk="new-key")])
    assert not service.apply_pending_reapply()
    assert service.status()["pending_update_kind"] == "config"
    assert len(router.applies) == 1
    auto_update_clock.current += timedelta(hours=2)
    assert service.apply_pending_reapply()
    assert state.read_state()["active_entry_code"] == "ru"
    assert len(router.applies) == 2

def test_chain_pending_refresh_failure_keeps_pair_and_installed_bytes(tmp_path):
    from dataclasses import replace
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit = _sample_loc("ru"), _sample_loc("fi")
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code="ru")
    service._update_from_locations([replace(entry, pbk="new-key"), exit], trigger="manual")
    service.fetch_fn = MagicMock(side_effect=RuntimeError("offline"))
    with pytest.raises(RuntimeError):
        service.apply_pending_reapply_now()
    assert len(router.applies) == 1
    assert state.read_state()["pending_reapply_entry_code"] == "ru"

def test_startup_chain_matches_distinct_credentials_on_same_endpoint(tmp_path):
    state = State(tmp_path)
    entry, exit = _sample_loc("ru", pbk="ENTRY"), _sample_loc("fi", pbk="EXIT")
    _seed_sub(state, [entry, exit])
    router = _FakeRouter(outbound=json.loads(build_outbound(exit, entry)))
    service = Service(state, router)
    assert service.sync_active_from_router() == "fi"
    assert state.read_state()["active_entry_code"] == "ru"
    service._update_from_locations([entry, exit], trigger="manual")
    assert not state.read_state()["pending_reapply_code"]

def test_startup_sync_does_not_override_accepted_main_intent(service):
    from xk_switcher.routing import new_id
    service.routing.store.put_operation({"id": new_id(), "kind": "main", "phase": "accepted",
                                        "created_at": "2026-11-16T12:00:00+00:00",
                                        "target_code": "fi", "target_entry_code": "ru"})
    assert service.sync_active_from_router() is None
    service.router.read_outbound.assert_not_called()

@pytest.mark.parametrize("missing", ["ru", "fi"])
def test_startup_chain_keeps_vanished_identity_despite_endpoint_alias(tmp_path, missing):
    from dataclasses import replace
    state = State(tmp_path)
    entry, exit = _sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")
    router = _FakeRouter(outbound=json.loads(build_outbound(exit, entry)))
    service = _service_with_subscription(state, router)
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code="ru")
    alias = replace(entry if missing == "ru" else exit, code="de", name="🇩🇪 alias", uuid="OTHER")
    remaining = [node for node in [entry, exit] if node.code != missing] + [alias]
    service._update_from_locations(remaining, trigger="manual")
    before = state.read_state()
    service.sync_active_from_router()
    st = state.read_state()
    assert (st["active_entry_code"], st["active_code"]) == ("ru", "fi")
    assert st["active_status"] == "stale" and st["active_missing_codes"] == [missing]
    assert st["active_route"] == before["active_route"]
    service._update_from_locations(remaining, trigger="manual")
    assert not service.apply_pending_reapply_now()
    assert len(router.applies) == 1

@pytest.mark.parametrize("saved_pair", [False, True])
def test_startup_chain_never_infers_new_identity_from_endpoint(tmp_path, saved_pair):
    from dataclasses import replace
    state = State(tmp_path)
    entry, exit = _sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")
    router = _FakeRouter(outbound=json.loads(build_outbound(exit, entry)))
    service = Service(state, router)
    # The saved entry still exists but moved; only an unrelated node shares the installed endpoint.
    _seed_sub(state, [replace(entry, host="moved", pbk="NEW"), exit,
                      replace(entry, code="de", name="🇩🇪 alias", uuid="OTHER")])
    if saved_pair:
        state.write_state({"active_code": "fi", "active_entry_code": "ru"})
    before = state.read_state()
    assert service.sync_active_from_router() is None
    assert state.read_state() == before

def test_startup_chain_matches_shadowsocks_credentials_without_transport(tmp_path):
    from dataclasses import replace
    state = State(tmp_path)
    def shadowsocks(code, password):
        return replace(_sample_loc(code), protocol="shadowsocks", outbound={
            "tag": "proxy", "protocol": "shadowsocks", "settings": {"servers": [
                {"address": "h.example", "port": 443, "method": "aes-128-gcm", "password": password}]}})
    entry, exit = shadowsocks("ru", "ENTRY"), shadowsocks("fi", "EXIT")
    _seed_sub(state, [entry, exit])
    service = Service(state, _FakeRouter(outbound=json.loads(build_outbound(exit, entry))))
    assert service.sync_active_from_router() == "fi"
    assert state.read_state()["active_entry_code"] == "ru"
    service._update_from_locations([entry, exit], trigger="manual")
    assert state.read_state()["pending_reapply_code"] is None

@pytest.mark.parametrize("saved_code", [None, "de"])
def test_startup_single_preserves_legacy_first_endpoint_match(tmp_path, saved_code):
    state = State(tmp_path)
    first, second = _sample_loc("fi", pbk="FIRST"), _sample_loc("de", pbk="SECOND")
    _seed_sub(state, [first, second])
    state.write_state({"active_code": saved_code})
    service = Service(state, _FakeRouter(outbound=json.loads(build_outbound(second))))
    assert service.sync_active_from_router() == "fi"
    assert state.read_state()["active_code"] == "fi"
    assert state.read_state()["active_entry_code"] is None
