"""Failover module tests — pure logic."""
import pytest
from datetime import datetime, timezone
from unittest.mock import MagicMock
from ._helpers import mark_server_for_route_checks

from xk_switcher.failover import HealthTracker, ProbeResult


T0 = datetime(2026, 4, 19, 6, 0, 0, tzinfo=timezone.utc)


def test_tracker_fresh_ok_sets_ok_streak_1():
    tracker = HealthTracker()
    tracker.record("de1", ProbeResult(ok=True, latency_ms=87, method="socks"), at=T0)
    state = tracker.get("de1")
    assert state["ok"] is True
    assert state["ok_streak"] == 1
    assert state["fail_streak"] == 0
    assert state["last_ok_at"] == T0.isoformat()
    assert state["last_fail_at"] is None
    assert state["last_latency_ms"] == 87
    assert state["probe_method"] == "socks"


def test_tracker_consecutive_ok_increments_streak():
    tracker = HealthTracker()
    for _ in range(3):
        tracker.record("de1", ProbeResult(ok=True, latency_ms=90, method="socks"), at=T0)
    assert tracker.get("de1")["ok_streak"] == 3
    assert tracker.get("de1")["fail_streak"] == 0


def test_tracker_fail_resets_ok_streak_and_increments_fail():
    tracker = HealthTracker()
    tracker.record("de1", ProbeResult(ok=True, latency_ms=87, method="socks"), at=T0)
    tracker.record("de1", ProbeResult(ok=True, latency_ms=87, method="socks"), at=T0)
    tracker.record("de1", ProbeResult(ok=False, latency_ms=None, method="socks"), at=T0)
    state = tracker.get("de1")
    assert state["ok"] is False
    assert state["ok_streak"] == 0
    assert state["fail_streak"] == 1
    assert state["last_latency_ms"] is None


def test_tracker_skipped_probe_records_method_skipped():
    tracker = HealthTracker()
    tracker.record("de1", ProbeResult(ok=False, latency_ms=None, method="skipped"), at=T0)
    state = tracker.get("de1")
    assert state["probe_method"] == "skipped"


def test_tracker_snapshot_returns_full_map():
    tracker = HealthTracker()
    tracker.record("de1", ProbeResult(ok=True, latency_ms=50, method="socks"), at=T0)
    tracker.record("ru2", ProbeResult(ok=False, latency_ms=None, method="socks"), at=T0)
    snap = tracker.snapshot()
    assert set(snap.keys()) == {"de1", "ru2"}
    assert snap["de1"]["ok"] is True


def test_tracker_load_from_snapshot_restores_state():
    tracker = HealthTracker.from_snapshot({
        "de1": {
            "ok": True, "fail_streak": 0, "ok_streak": 5,
            "last_ok_at": T0.isoformat(), "last_fail_at": None,
            "last_latency_ms": 87, "probe_method": "socks",
        }
    })
    assert tracker.get("de1")["ok_streak"] == 5


from xk_switcher.failover import ProbePolicy


def _policy_state(**overrides):
    base = {
        "enabled": True,
        "xkeen_stop_cause": None,
        "last_apply_at": None,
    }
    base.update(overrides)
    return base


def test_policy_skip_when_disabled():
    assert ProbePolicy.should_probe(_policy_state(enabled=False), grace_sec=60, now=T0) is False


def test_policy_skip_when_xkeen_stopped_manually():
    assert ProbePolicy.should_probe(_policy_state(xkeen_stop_cause="manual"), grace_sec=60, now=T0) is False


def test_policy_skip_in_grace_period():
    last_apply = "2026-04-19T06:00:00+00:00"
    now = datetime(2026, 4, 19, 6, 0, 30, tzinfo=timezone.utc)  # 30s after
    assert ProbePolicy.should_probe(_policy_state(last_apply_at=last_apply), grace_sec=60, now=now) is False


def test_policy_allow_when_grace_expired():
    last_apply = "2026-04-19T06:00:00+00:00"
    now = datetime(2026, 4, 19, 6, 1, 30, tzinfo=timezone.utc)  # 90s after
    assert ProbePolicy.should_probe(_policy_state(last_apply_at=last_apply), grace_sec=60, now=now) is True


def test_policy_allow_when_no_apply_ever():
    assert ProbePolicy.should_probe(_policy_state(last_apply_at=None), grace_sec=60, now=T0) is True


def test_policy_allow_when_last_apply_is_malformed():
    # Defensive: invalid timestamp → treat as no last_apply (allow probe)
    assert ProbePolicy.should_probe(_policy_state(last_apply_at="not-iso"), grace_sec=60, now=T0) is True


from xk_switcher.failover import FailoverDecider, Decision


def _cfg(**overrides):
    base = {
        "enabled": True,
        "auto_failback": False,
        "auto_stop_on_total_failure": False,
        "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2", "nl1"],
    }
    base.update(overrides)
    return base


def _health(**per_code):
    m = {}
    for code, vals in per_code.items():
        m[code] = {
            "ok": vals.get("ok", True),
            "fail_streak": vals.get("fail_streak", 0),
            "ok_streak": vals.get("ok_streak", 1),
            "probe_method": vals.get("method", "socks"),
        }
    return m


def test_decider_noop_when_all_ok():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(),
        health=_health(de1={"ok": True}, ru2={"ok": True}, nl1={"ok": True}),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_switch_when_active_dead_with_alive_fallback():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(),
        health=_health(
            de1={"ok": False, "fail_streak": 3},
            ru2={"ok": True, "ok_streak": 5},
            nl1={"ok": True, "ok_streak": 5},
        ),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "switch"
    assert decision.code == "ru2"
    assert decision.reason == "failover-switch"


def test_decider_picks_first_alive_in_whitelist_order():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(whitelist=["de1", "ru2", "nl1"]),
        health=_health(
            de1={"ok": False, "fail_streak": 3},
            ru2={"ok": False, "fail_streak": 3},
            nl1={"ok": True, "ok_streak": 5},
        ),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "switch"
    assert decision.code == "nl1"


def test_decider_does_not_switch_when_fail_streak_below_threshold():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(),
        health=_health(
            de1={"ok": False, "fail_streak": 2},
            ru2={"ok": True, "ok_streak": 5},
        ),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_no_switch_when_active_not_in_whitelist():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(whitelist=["de1", "ru2"]),
        health=_health(
            de1={"ok": True, "ok_streak": 5},
            ru2={"ok": True, "ok_streak": 5},
        ),
        active="some-other-code",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_skips_when_failover_disabled():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(enabled=False),
        health=_health(de1={"ok": False, "fail_streak": 10}),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_skips_when_xkeen_stopped_manually():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(),
        health=_health(de1={"ok": False, "fail_streak": 10}),
        active="de1",
        xkeen_state="stopped",
        xkeen_stop_cause="manual",
    )
    assert decision.kind == "noop"


def test_decider_failback_when_preferred_alive_dampening_met():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_failback=True),
        health=_health(
            de1={"ok": True, "ok_streak": 3},
            ru2={"ok": True, "ok_streak": 5},
        ),
        active="ru2",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "switch"
    assert decision.code == "de1"
    assert decision.reason == "failback"


def test_decider_no_failback_before_dampening():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_failback=True),
        health=_health(
            de1={"ok": True, "ok_streak": 2},
            ru2={"ok": True, "ok_streak": 5},
        ),
        active="ru2",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_no_failback_when_auto_failback_off():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_failback=False),
        health=_health(
            de1={"ok": True, "ok_streak": 10},
            ru2={"ok": True, "ok_streak": 10},
        ),
        active="ru2",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_total_failure_stops_xkeen_when_auto_stop_on():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_stop_on_total_failure=True),
        health=_health(
            de1={"ok": False, "fail_streak": 3},
            ru2={"ok": False, "fail_streak": 3},
            nl1={"ok": False, "fail_streak": 3},
        ),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "stop_xkeen"
    assert decision.reason == "total-failure-stop"


def test_decider_total_failure_noop_when_auto_stop_off():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_stop_on_total_failure=False),
        health=_health(
            de1={"ok": False, "fail_streak": 3},
            ru2={"ok": False, "fail_streak": 3},
        ),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "noop"


def test_decider_total_failure_considers_skipped_irrelevant():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    # nl1 is "skipped" (vanished). All non-skipped (de1, ru2) are dead → total failure
    decision = d.decide(
        cfg=_cfg(auto_stop_on_total_failure=True),
        health=_health(
            de1={"ok": False, "fail_streak": 3, "method": "socks"},
            ru2={"ok": False, "fail_streak": 3, "method": "socks"},
            nl1={"ok": False, "fail_streak": 0, "method": "skipped"},
        ),
        active="de1",
        xkeen_state="running",
        xkeen_stop_cause=None,
    )
    assert decision.kind == "stop_xkeen"


def test_decider_recovery_via_tcp_starts_and_switches():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_stop_on_total_failure=True, auto_restart_on_recovery=True),
        health=_health(
            de1={"ok": False, "fail_streak": 0, "method": "tcp"},
            ru2={"ok": True, "ok_streak": 1, "method": "tcp"},
        ),
        active="de1",
        xkeen_state="stopped",
        xkeen_stop_cause="failover",
    )
    assert decision.kind == "start_and_switch"
    assert decision.code == "ru2"
    assert decision.reason == "auto-recovery"


def test_decider_recovery_noop_when_auto_restart_off():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_stop_on_total_failure=True, auto_restart_on_recovery=False),
        health=_health(
            de1={"ok": True, "ok_streak": 1, "method": "tcp"},
        ),
        active="de1",
        xkeen_state="stopped",
        xkeen_stop_cause="failover",
    )
    assert decision.kind == "noop"


def test_decider_recovery_noop_when_no_tcp_alive():
    d = FailoverDecider(fail_threshold=3, dampening_ticks=3)
    decision = d.decide(
        cfg=_cfg(auto_stop_on_total_failure=True, auto_restart_on_recovery=True),
        health=_health(
            de1={"ok": False, "method": "tcp"},
            ru2={"ok": False, "method": "tcp"},
        ),
        active="de1",
        xkeen_state="stopped",
        xkeen_stop_cause="failover",
    )
    assert decision.kind == "noop"


# ---------------------------------------------------------------------------
# FailoverLoop tests
# ---------------------------------------------------------------------------
from dataclasses import asdict

from xk_switcher.failover import FailoverLoop, FailoverConfig
from xk_switcher.state import State
from .test_service import _service_with_subscription


class FakeClock:
    def __init__(self, now: datetime):
        self._now = now

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: int) -> None:
        from datetime import timedelta as _td
        self._now = self._now + _td(seconds=seconds)


class FakeRouter:
    def __init__(self):
        self.applies = []
        self.xkeen_calls = []

    def apply(self, payload):
        self.applies.append(payload)

    def run_xkeen(self, action):
        self.xkeen_calls.append(action)
        return f"mock xkeen -{action}"


def _patch_tcp(loop, per_host: dict):
    """Patch _tcp_probe on loop to return per-host results (keyed by host string)."""
    def fake_tcp(host, port):
        return per_host.get(host, (False, None))
    loop._tcp_probe = fake_tcp


def _loc(code: str):
    from xk_switcher.subscription import Location
    return Location(
        code=code, name=f"NM {code}", protocol="vless",
        host=f"{code}.example", port=443, uuid="uuid", flow="",
        network="tcp", security="reality", sni=f"{code}.example",
        pbk="pbk", sid="sid", spx="/", fingerprint="chrome",
    )


def _hysteria_loc(code: str):
    from xk_switcher.subscription import Location
    return Location(
        code=code, name=f"HY {code}", protocol="hysteria",
        host=f"{code}.example", port=443,
        outbound={
            "tag": "proxy",
            "protocol": "hysteria",
            "settings": {
                "address": f"{code}.example",
                "port": 443,
                "version": 2,
            },
            "streamSettings": {
                "network": "hysteria",
                "security": "tls",
                "hysteriaSettings": {"version": 2, "auth": "secret"},
            },
        },
    )


def _make_loop(state, service, router, ok=True, latency_ms=50):
    cfg = FailoverConfig(
        check_interval_sec=300, fail_threshold=3, grace_after_switch_sec=60,
        dampening_ticks=3, tcp_timeout_sec=3,
    )
    clock = FakeClock(T0)
    return FailoverLoop(state=state, service=service, router=router,
                        cfg=cfg, clock=clock.now)


def test_loop_tick_writes_health_json_for_whitelist(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_state({"active_code": "de1"})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    cfg = FailoverConfig(
        check_interval_sec=300, fail_threshold=3, grace_after_switch_sec=60,
        dampening_ticks=3, tcp_timeout_sec=3,
    )
    clock = FakeClock(T0)
    loop = FailoverLoop(state=state, service=service, router=router, cfg=cfg, clock=clock.now)
    _patch_tcp(loop, {"de1.example": (True, 87), "ru2.example": (False, None)})
    loop.tick_once()
    health = state.read_health()
    assert "de1" in health["map"]
    assert health["map"]["de1"]["ok"] is True
    assert health["map"]["de1"]["last_latency_ms"] == 87
    assert health["map"]["de1"]["probe_method"] == "tcp"
    assert health["map"]["ru2"]["ok"] is False
    assert health["map"]["ru2"]["fail_streak"] == 1
    assert health["map"]["ru2"]["probe_method"] == "tcp"
    assert health["updated_at"] is not None
    assert health["next_probe_at"] is not None


def test_loop_applies_switch_decision(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "de1"})
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    # Seed health: de1 at fail_streak=2, ru2 healthy
    state.write_health({
        "schema_version": 1, "updated_at": None, "next_probe_at": None,
        "map": {
            "de1": {"ok": False, "fail_streak": 2, "ok_streak": 0,
                    "last_ok_at": None, "last_fail_at": None,
                    "last_latency_ms": None, "probe_method": "socks"},
            "ru2": {"ok": True, "fail_streak": 0, "ok_streak": 5,
                    "last_ok_at": None, "last_fail_at": None,
                    "last_latency_ms": 50, "probe_method": "tcp"},
        },
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    cfg = FailoverConfig(
        check_interval_sec=300, fail_threshold=3, grace_after_switch_sec=60,
        dampening_ticks=3, tcp_timeout_sec=3,
    )
    clock = FakeClock(T0)
    loop = FailoverLoop(state=state, service=service, router=router, cfg=cfg, clock=clock.now)
    _patch_tcp(loop, {"de1.example": (False, None), "ru2.example": (True, 50)})
    loop.tick_once()  # de1 fail_streak → 3, triggers switch to ru2
    assert state.read_state()["active_code"] == "ru2"
    assert state.read_state()["failover_active"] is True


def test_loop_route_failure_counts_against_active_and_switches(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "de1", "xkeen_state": "running"})
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    state.write_health({
        "schema_version": 1, "updated_at": None, "next_probe_at": None,
        "map": {
            "de1": {"ok": False, "fail_streak": 2, "ok_streak": 0,
                    "last_ok_at": None, "last_fail_at": None,
                    "last_latency_ms": None, "probe_method": "route"},
        },
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": False,
            "results": [{"name": "youtube", "ok": False, "status": 403,
                         "latency_ms": 20, "error": "HTTP 403"}],
        },
    )
    _patch_tcp(loop, {"de1.example": (True, 20), "ru2.example": (True, 30)})

    loop.tick_once()

    health = state.read_health()["map"]["de1"]
    assert health["tcp_ok"] is True
    assert health["route_ok"] is False
    assert health["probe_method"] == "route"
    assert health["fail_streak"] == 3
    assert state.read_state()["active_code"] == "ru2"


def test_loop_applies_pending_active_config_before_failover_and_recovers(tmp_path):
    state = State(tmp_path)
    state.init({"subscription_url": "https://sub.example"})
    state.write_state({
        "active_code": "de1",
        "xkeen_state": "running",
        "pending_reapply_code": "de1",
        "pending_reapply_since": T0.isoformat(),
    })
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    state.write_health({
        "schema_version": 1, "updated_at": None, "next_probe_at": None,
        "map": {
            "de1": {"ok": False, "fail_streak": 2, "ok_streak": 0,
                    "last_ok_at": None, "last_fail_at": None,
                    "last_latency_ms": None, "probe_method": "route"},
        },
    })
    routes = iter([
        {"ok": False, "results": [{"name": "youtube", "ok": False}]},
        {"ok": True, "results": [{"name": "youtube", "ok": True}]},
    ])
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    service._fetch_and_parse = MagicMock(return_value=[_loc("de1"), _loc("ru2")])
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: next(routes),
    )
    service.failover_loop = loop
    _patch_tcp(loop, {"de1.example": (True, 20), "ru2.example": (True, 30)})

    loop.tick_once()

    assert len(router.applies) == 1
    service._fetch_and_parse.assert_called_once_with("https://sub.example")
    assert state.read_state()["active_code"] == "de1"
    assert state.read_state()["pending_reapply_code"] is None
    assert state.read_health()["map"]["de1"]["route_ok"] is True


def test_loop_fails_over_when_pending_active_config_does_not_recover(tmp_path):
    state = State(tmp_path)
    state.init({"subscription_url": "https://sub.example"})
    state.write_state({
        "active_code": "de1",
        "xkeen_state": "running",
        "pending_reapply_code": "de1",
        "pending_reapply_since": T0.isoformat(),
    })
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    state.write_health({
        "schema_version": 1, "updated_at": None, "next_probe_at": None,
        "map": {
            "de1": {"ok": False, "fail_streak": 2, "ok_streak": 0,
                    "last_ok_at": None, "last_fail_at": None,
                    "last_latency_ms": None, "probe_method": "route"},
        },
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    service._fetch_and_parse = MagicMock(return_value=[_loc("de1"), _loc("ru2")])
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": False,
            "results": [{"name": "youtube", "ok": False}],
        },
    )
    service.failover_loop = loop
    _patch_tcp(loop, {"de1.example": (True, 20), "ru2.example": (True, 30)})

    loop.tick_once()

    assert len(router.applies) == 2
    assert "de1.example" in router.applies[0]
    assert "ru2.example" in router.applies[1]
    assert state.read_state()["active_code"] == "ru2"
    assert state.read_state()["pending_reapply_code"] is None


def test_manual_route_failure_switches_only_to_fresh_tcp_alive_candidate(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "de1", "xkeen_state": "running"})
    state.write_subscription({
        "locations": [asdict(_loc("de1")), asdict(_loc("ru2")), asdict(_loc("nl1"))],
    })
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2", "nl1"],
    })
    state.write_health({
        "schema_version": 1, "updated_at": T0.isoformat(), "next_probe_at": None,
        "map": {
            "de1": {"ok": False, "fail_streak": 2, "ok_streak": 0,
                    "last_ok_at": None, "last_fail_at": T0.isoformat(),
                    "last_latency_ms": None, "probe_method": "route"},
            "ru2": {"ok": True, "fail_streak": 0, "ok_streak": 5,
                    "last_ok_at": T0.isoformat(), "last_fail_at": None,
                    "last_latency_ms": 20, "probe_method": "tcp"},
            "nl1": {"ok": False, "fail_streak": 1, "ok_streak": 0,
                    "last_ok_at": None, "last_fail_at": T0.isoformat(),
                    "last_latency_ms": None, "probe_method": "tcp"},
        },
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": False,
            "results": [
                {"name": "youtube", "ok": False, "status": 503},
                {"name": "avito", "ok": False, "status": 503},
            ],
        },
    )
    _patch_tcp(loop, {
        "de1.example": (True, 15),
        "ru2.example": (False, None),
        "nl1.example": (True, 25),
    })

    result = loop.check_current_route()

    assert result["active_after"] == "nl1"
    health = state.read_health()["map"]
    assert health["ru2"]["tcp_ok"] is False
    assert health["nl1"]["tcp_ok"] is True


def test_manual_route_check_updates_same_failover_health(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "de1", "xkeen_state": "running"})
    state.write_subscription({"locations": [asdict(_loc("de1"))]})
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": True,
            "results": [
                {"name": "youtube", "ok": True, "status": 204,
                 "latency_ms": 20, "error": None},
                {"name": "avito", "ok": True, "status": 200,
                 "latency_ms": 30, "error": None},
            ],
        },
    )
    _patch_tcp(loop, {"de1.example": (True, 15)})

    result = loop.check_current_route()

    assert result["active_code"] == "de1"
    assert result["ok"] is True
    assert result["tcp"]["ok"] is True
    assert result["route"]["ok"] is True
    health = state.read_health()["map"]["de1"]
    assert health["ok"] is True
    assert health["tcp_ok"] is True
    assert health["route_ok"] is True


def test_manual_route_check_succeeds_when_at_least_one_target_works(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "de1", "xkeen_state": "running"})
    state.write_subscription({"locations": [asdict(_loc("de1"))]})
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": False,
            "results": [
                {"name": "youtube", "ok": True, "status": 204,
                 "latency_ms": 102, "error": None},
                {"name": "avito", "ok": False, "status": 503,
                 "latency_ms": 133, "error": "HTTP 503"},
            ],
        },
    )
    _patch_tcp(loop, {"de1.example": (True, 15)})

    result = loop.check_current_route()

    assert result["ok"] is True
    assert result["route"]["ok"] is True
    assert state.read_health()["map"]["de1"]["route_ok"] is True


def test_hysteria_is_alive_only_while_active_route_passes(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "nl", "xkeen_state": "running"})
    state.write_subscription({
        "locations": [asdict(_hysteria_loc("nl")), asdict(_loc("fi"))],
    })
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["nl", "fi"],
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": True,
            "results": [{"name": "youtube", "ok": True, "status": 204}],
        },
    )
    service.failover_loop = loop
    probed_hosts = []

    def tcp_probe(host, port):
        probed_hosts.append(host)
        return True, 20

    loop._tcp_probe = tcp_probe

    loop.tick_once()

    health = state.read_health()["map"]
    assert probed_hosts == ["fi.example"]
    assert health["nl"]["ok"] is True
    assert health["nl"]["probe_method"] == "route"
    assert health["nl"]["tcp_ok"] is None
    assert health["nl"]["route_ok"] is True

    service.switch("fi")

    inactive = state.read_health()["map"]["nl"]
    assert inactive["ok"] is False
    assert inactive["probe_method"] == "skipped"
    assert inactive["fail_streak"] == 0
    assert inactive["route_ok"] is None
    assert inactive["route_checked_at"] is None

    service.switch("nl")

    selected = state.read_health()["map"]["nl"]
    assert selected["probe_method"] == "route"
    assert selected["ok"] is True

    result = loop.check_current_route()

    assert result["ok"] is True
    assert state.read_health()["map"]["nl"]["ok"] is True


def test_manual_route_check_for_hysteria_does_not_require_tcp(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "us", "xkeen_state": "running"})
    state.write_subscription({"locations": [asdict(_hysteria_loc("us"))]})
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": True,
            "results": [{"name": "avito", "ok": True, "status": 200}],
        },
    )
    loop._tcp_probe = lambda host, port: (_ for _ in ()).throw(
        AssertionError("hysteria must not use a TCP probe")
    )

    result = loop.check_current_route()

    assert result["ok"] is True
    assert result["tcp"] is None
    assert result["route"]["ok"] is True
    health = state.read_health()["map"]["us"]
    assert health["ok"] is True
    assert health["tcp_ok"] is None
    assert health["route_ok"] is True


def test_recovery_does_not_restore_stale_hysteria_health(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "gone", "xkeen_state": "running"})
    state.write_subscription({
        "locations": [asdict(_loc("fi")), asdict(_hysteria_loc("nl"))],
    })
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["fi", "nl"],
    })
    state.write_health({
        "schema_version": 1, "updated_at": T0.isoformat(), "next_probe_at": None,
        "map": {
            "nl": {
                "ok": True, "fail_streak": 0, "ok_streak": 2,
                "last_ok_at": T0.isoformat(), "last_fail_at": None,
                "last_latency_ms": None, "probe_method": "route",
                "tcp_ok": None, "tcp_checked_at": None,
                "tcp_latency_ms": None, "route_ok": True,
                "route_checked_at": T0.isoformat(), "route_results": [],
            },
        },
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
        route_check_fn=lambda: {
            "ok": True,
            "results": [{"name": "youtube", "ok": True, "status": 204}],
        },
    )
    service.failover_loop = loop
    _patch_tcp(loop, {"fi.example": (True, 20)})

    result = loop.recover_vanished_active()

    assert result["recovered"] is True
    assert result["active_after"] == "fi"
    inactive = state.read_health()["map"]["nl"]
    assert inactive["ok"] is False
    assert inactive["probe_method"] == "skipped"
    assert inactive["route_ok"] is None
    assert inactive["route_checked_at"] is None


def test_tcp_probe_of_active_does_not_reuse_stored_route_failure(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_state({"active_code": "de1", "xkeen_state": "running"})
    state.write_subscription({"locations": [asdict(_loc("de1"))]})
    state.write_health({
        "schema_version": 1, "updated_at": T0.isoformat(), "next_probe_at": None,
        "map": {
            "de1": {
                "ok": False, "fail_streak": 1, "ok_streak": 0,
                "last_ok_at": None, "last_fail_at": T0.isoformat(),
                "last_latency_ms": None, "probe_method": "route",
                "tcp_ok": True, "route_ok": False,
                "route_checked_at": T0.isoformat(),
                "route_results": [{"name": "avito", "ok": False, "status": 403}],
            },
        },
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    loop = FailoverLoop(
        state=state, service=service, router=router,
        cfg=FailoverConfig(300, 3, 60, 3, 3),
        clock=FakeClock(T0).now,
    )
    _patch_tcp(loop, {"de1.example": (True, 15)})

    result = loop.probe_codes(["de1"])

    assert result["de1"]["ok"] is True
    health = state.read_health()["map"]["de1"]
    assert health["ok"] is False
    assert health["fail_streak"] == 1
    assert health["tcp_ok"] is True
    assert health["tcp_latency_ms"] == 15
    assert health["tcp_checked_at"] == T0.isoformat()
    assert health["route_ok"] is False
    assert health["route_checked_at"] == T0.isoformat()


def test_loop_skips_when_disabled(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_failover({
        "schema_version": 1, "enabled": False, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1"],
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    cfg = FailoverConfig(
        check_interval_sec=300, fail_threshold=3, grace_after_switch_sec=60,
        dampening_ticks=3, tcp_timeout_sec=3,
    )
    clock = FakeClock(T0)
    loop = FailoverLoop(state=state, service=service, router=router, cfg=cfg, clock=clock.now)
    loop.tick_once()
    h = state.read_health()
    assert h["map"] == {}


def test_loop_marks_vanished_locations_as_skipped(tmp_path):
    state = State(tmp_path)
    state.init({})
    # whitelist has "gone" but subscription only has "de1"
    state.write_subscription({"locations": [asdict(_loc("de1"))]})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "gone"],
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    cfg = FailoverConfig(
        check_interval_sec=300, fail_threshold=3, grace_after_switch_sec=60,
        dampening_ticks=3, tcp_timeout_sec=3,
    )
    clock = FakeClock(T0)
    loop = FailoverLoop(state=state, service=service, router=router, cfg=cfg, clock=clock.now)
    _patch_tcp(loop, {"de1.example": (True, 50)})
    loop.tick_once()
    h = state.read_health()
    assert h["map"]["gone"]["probe_method"] == "skipped"
    assert h["map"]["gone"]["ok"] is False


def test_loop_probes_all_via_tcp(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_state({"active_code": "de1"})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    mark_server_for_route_checks(service)
    cfg = FailoverConfig(
        check_interval_sec=300, fail_threshold=3, grace_after_switch_sec=60,
        dampening_ticks=3, tcp_timeout_sec=3,
    )
    clock = FakeClock(T0)
    loop = FailoverLoop(state=state, service=service, router=router, cfg=cfg, clock=clock.now)
    _patch_tcp(loop, {"de1.example": (True, 80), "ru2.example": (True, 50)})
    loop.tick_once()
    health = state.read_health()
    assert health["map"]["de1"]["probe_method"] == "tcp"
    assert health["map"]["de1"]["ok"] is True
    assert health["map"]["de1"]["last_latency_ms"] == 80
    assert health["map"]["ru2"]["probe_method"] == "tcp"
    assert health["map"]["ru2"]["ok"] is True
    assert health["map"]["ru2"]["last_latency_ms"] == 50

def test_diagnostic_does_not_block_main_acceptance_or_publish_after_pending_apply(tmp_path, monkeypatch):
    import threading
    import time
    from xk_switcher import routing
    from xk_switcher.router import Router
    from xk_switcher.service import Service
    from .test_routing_service import seed_main
    state = State(tmp_path)
    state.init({})
    service = Service(state, Router("mock"))
    seed_main(service)
    state.write_state({"xkeen_state": "running"})
    mark_server_for_route_checks(service)
    entered, release = threading.Event(), threading.Event()
    def delayed_route():
        entered.set()
        assert release.wait(3)
        return {"ok": False, "results": []}
    loop = FailoverLoop(state=state, service=service, router=service.router,
        cfg=FailoverConfig(300, 3, 60, 3, 3), clock=FakeClock(T0).now, route_check_fn=delayed_route)
    monkeypatch.setattr(loop, "_tcp_probe", lambda *args: (True, 10))
    monkeypatch.setattr(service.routing, "_launch", lambda ident: None)
    health = state.read_health()
    results = []
    thread = threading.Thread(target=lambda: results.append(loop.check_current_route(allow_failover=False)))
    thread.start()
    try:
        assert entered.wait(1)
        started = time.monotonic()
        op = service.routing.submit_main("de", routing.new_id())
        assert time.monotonic() - started < .5
        assert op["phase"] == "accepted"
        context = service.device_routing_settings.context()
        newer = {"ok": True, "checked_at": "newer-evidence"}
        service.device_routing_settings.record_check(context, newer)
        release.set()
        thread.join(2)
        assert not thread.is_alive()
        assert results[0]["stale"]
        assert state.read_health() == health
        assert service.device_routing_settings.status()["check"] == newer
    finally:
        release.set()
        thread.join(3)
        service.routing.stop()

def test_synchronous_admission_does_not_discard_its_own_diagnostic(tmp_path, monkeypatch):
    from xk_switcher.router import Router
    from xk_switcher.service import Service
    from .test_routing_service import seed_main
    state = State(tmp_path)
    state.init({})
    service = Service(state, Router("mock"))
    seed_main(service)
    state.write_state({"xkeen_state": "running"})
    mark_server_for_route_checks(service)
    loop = FailoverLoop(state=state, service=service, router=service.router,
        cfg=FailoverConfig(300, 3, 60, 3, 3), clock=FakeClock(T0).now,
        route_check_fn=lambda: {"ok": True, "results": []})
    monkeypatch.setattr(loop, "_tcp_probe", lambda *args: (True, 10))
    with service.routing.admission(kind="switch"):
        result = loop.check_current_route(allow_failover=False)
    assert result["ok"] and not result.get("stale")
    assert state.read_health()["map"]["fi"]["route_ok"]

def test_failed_strict_pending_refresh_still_allows_cached_failover_candidate(tmp_path):
    state = State(tmp_path)
    state.init({"subscription_url": "https://sub.example"})
    state.write_state({"active_code": "de1", "xkeen_state": "running",
                       "pending_reapply_code": "de1", "pending_reapply_since": T0.isoformat()})
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_failover({"schema_version": 1, "enabled": True, "auto_failback": False,
                         "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
                         "whitelist": ["de1", "ru2"]})
    router = FakeRouter()
    service = _service_with_subscription(state, router)
    service.fetch_fn = MagicMock(side_effect=RuntimeError("provider unavailable"))
    loop = FailoverLoop(state=state, service=service, router=router,
        cfg=FailoverConfig(300, 1, 0, 1, 3), clock=FakeClock(T0).now)
    service.failover_loop = loop
    _patch_tcp(loop, {"de1.example": (False, None), "ru2.example": (True, 30)})
    loop.tick_once()
    service.fetch_fn.assert_called_once()  # Strict active refresh; the fallback uses available locations.
    assert len(router.applies) == 1 and "ru2.example" in router.applies[0]
    assert "de1.example" not in router.applies[0]
    assert state.read_state()["active_code"] == "ru2"
    assert state.read_state()["last_update_status"] == "fail"
    history = state.read_history(100)
    assert any(entry["action"] == "active-refresh" and entry["result"] == "fail" for entry in history)
    assert any(entry["action"] == "failover-switch" and entry["result"] == "ok" and entry.get("warning") for entry in history)


@pytest.mark.parametrize("attributed,route_ok", [(True, True), (True, False), (False, True), (False, False)])
def test_chain_health_uses_only_attributed_http_and_never_changes_route(tmp_path, attributed, route_ok):
    from unittest.mock import MagicMock
    from .test_service import _FakeRouter, _sample_loc, _seed_sub, _service_with_subscription, _attach_route_checker
    from xk_switcher.state import State
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    _seed_sub(state, [_sample_loc("ru", host="entry"), _sample_loc("fi", host="exit")])
    service.switch("fi", entry_code="ru")
    loop = _attach_route_checker(service, lambda: {"ok": route_ok})
    if not attributed:
        service.device_routing_settings.inventory = None
        service.device_routing_settings.read = lambda: {"revision": None, "policy_ids": [], "server_device_id": None}
    loop._tcp_probe = MagicMock(side_effect=AssertionError("Chain health cannot probe nodes"))
    state.write_failover({"enabled": True, "whitelist": ["ru", "fi"], "auto_failback": True,
                          "auto_stop_on_total_failure": True, "auto_restart_on_recovery": True})
    state.write_state({"last_apply_at": None})
    for _ in range(4):
        loop.check_current_route()
        loop.tick_once()
    health = service.status()["active_health"]
    assert health["tcp_ok"] is None
    assert health["route_ok"] == (route_ok if attributed else None)
    assert health["fail_streak"] == (8 if attributed and not route_ok else 0)
    assert len(router.applies) == 1
    assert not router.xkeen_calls
    assert not loop.recover_vanished_active()["attempted"]
    service.apply_failover("ru", "failback")
    service.handle_total_failure()
    assert len(router.applies) == 1 and not router.xkeen_calls
    assert service.status()["failover"]["suspension_reason"] == "chain_active"


def test_chain_failed_http_can_reapply_pending_pair_without_fallback(tmp_path):
    from dataclasses import replace
    from .test_service import _FakeRouter, _sample_loc, _seed_sub, _service_with_subscription, _attach_route_checker
    from xk_switcher.state import State
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit = _sample_loc("ru"), _sample_loc("fi")
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code="ru")
    service._update_from_locations([replace(entry, pbk="changed"), exit], trigger="manual")
    state.write_failover({"enabled": True, "whitelist": ["ru", "fi"], "auto_failback": True})
    loop = _attach_route_checker(service, lambda: {"ok": len(router.applies) > 1})
    loop._tcp_probe = MagicMock(side_effect=AssertionError("No TCP health for chains"))
    for _ in range(3):
        loop.check_current_route()
    assert len(router.applies) == 2
    assert service.status()["active_health"]["route_ok"]
    assert state.read_state()["active_entry_code"] == "ru"
    assert state.read_state()["pending_reapply_code"] is None

@pytest.mark.parametrize("change", ["entry", "generation", "attribution", "health"])
def test_chain_pending_recovery_revalidates_after_publication(tmp_path, change):
    from dataclasses import replace
    from .test_service import _FakeRouter, _sample_loc, _seed_sub, _service_with_subscription, _attach_route_checker
    from xk_switcher.state import State
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit, other = [_sample_loc(code, host=code) for code in ("ru", "fi", "de")]
    _seed_sub(state, [entry, exit, other])
    service.switch("fi", entry_code="ru")
    state.write_failover({"enabled": True, "whitelist": ["ru", "fi", "de"]})
    loop = _attach_route_checker(service, lambda: {"ok": False})
    loop.check_current_route()
    loop.check_current_route()
    original_lock = loop._diagnostic_lock
    expected = {}
    class PublishBoundary:
        def acquire(self, **kwargs):
            return original_lock.acquire(**kwargs)
        def release(self):
            original_lock.release()
            loop._diagnostic_lock = original_lock
            # Interleave immediately after the failed check releases its locks.
            loop._route_check_fn = lambda: {"ok": True}
            if change == "generation":
                _seed_sub(state, [replace(entry, pbk="REINSTALLED"), exit, other])
            if change in {"entry", "generation"}:
                service.switch("fi", entry_code="de" if change == "entry" else "ru")
            elif change == "attribution":
                service.device_routing_settings.inventory = None
                service.device_routing_settings.read = lambda: {"revision": None, "policy_ids": [], "server_device_id": None}
            else:
                loop.check_current_route(allow_failover=False)
            service._update_from_locations([replace(entry, pbk="NEW"), replace(exit, pbk="NEW"), other], trigger="manual")
            expected.update(state=state.read_state(), applies=len(router.applies))
    loop._diagnostic_lock = PublishBoundary()
    result = loop.check_current_route()
    if change != "health":
        assert result["stale"]
    assert state.read_state() == expected["state"]
    assert len(router.applies) == expected["applies"]
    assert state.read_state()["pending_reapply_code"] == "fi"

@pytest.mark.parametrize("entry_code", [None, "ru"])
def test_pending_recovery_holds_coordinator_through_admission(tmp_path, monkeypatch, entry_code):
    import threading
    from dataclasses import replace
    from .test_service import _FakeRouter, _sample_loc, _seed_sub, _service_with_subscription, _attach_route_checker
    from xk_switcher.state import State
    state = State(tmp_path)
    router = _FakeRouter()
    service = _service_with_subscription(state, router)
    entry, exit = _sample_loc("ru"), _sample_loc("fi")
    _seed_sub(state, [entry, exit])
    service.switch("fi", entry_code=entry_code)
    service._update_from_locations([entry, replace(exit, pbk="PENDING")], trigger="manual")
    state.write_failover({"enabled": True, "whitelist": ["fi"]})
    loop = _attach_route_checker(service, lambda: {"ok": len(router.applies) > 1})
    original = service.recover_pending_active
    admissions = []
    def recover():
        def competing_mutation():
            acquired = service._op_lock.acquire(blocking=False)
            admissions.append(acquired)
            if acquired:
                service._op_lock.release()
        competitor = threading.Thread(target=competing_mutation)
        competitor.start()
        competitor.join(1)
        assert not competitor.is_alive()
        return original()
    monkeypatch.setattr(service, "recover_pending_active", recover)
    for _ in range(3):
        loop.check_current_route()
    assert admissions == [False]
    assert len(router.applies) == 2
    assert state.read_state()["pending_reapply_code"] is None
    assert state.read_state()["active_entry_code"] == entry_code

def test_periodic_chain_http_check_does_not_hold_mutation_coordinator(tmp_path):
    import threading
    from .test_service import _FakeRouter, _sample_loc, _seed_sub, _service_with_subscription, _attach_route_checker
    from xk_switcher.state import State
    state = State(tmp_path)
    service = _service_with_subscription(state, _FakeRouter())
    _seed_sub(state, [_sample_loc("ru"), _sample_loc("fi")])
    service.switch("fi", entry_code="ru")
    observed = []
    def check():
        def competing_action():
            acquired = service._op_lock.acquire(blocking=False)
            observed.append(acquired)
            if acquired:
                service._op_lock.release()
        worker = threading.Thread(target=competing_action)
        worker.start()
        worker.join(1)
        assert not worker.is_alive()
        return {"ok": True}
    loop = _attach_route_checker(service, check)
    state.write_failover({"enabled": True, "whitelist": ["ru", "fi"]})
    state.write_state({"last_apply_at": None})
    loop.tick_once()
    assert observed == [True]
    assert service.status()["active_health"]["route_ok"] is True

def test_manual_tick_reports_busy_if_admission_changes_after_precheck(tmp_path):
    from .test_service import _FakeRouter, _service_with_subscription, _attach_route_checker
    from xk_switcher.state import State
    from xk_switcher.failover import FailoverBusyError
    service = _service_with_subscription(State(tmp_path), _FakeRouter())
    loop = _attach_route_checker(service, lambda: {"ok": True})
    coordinator = MagicMock()
    coordinator.acquire.return_value = False
    service._op_lock = coordinator
    with pytest.raises(FailoverBusyError):
        loop.tick_once(reject_busy=True)
    coordinator.release.assert_not_called()
    loop.tick_once()  # Periodic checks still skip quietly when admission is busy.
