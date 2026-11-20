"""End-to-end failover -> failback cycle with fake clock and fake router."""
from dataclasses import asdict
from datetime import datetime, timezone, timedelta

from xk_switcher.state import State
from .test_service import _service_with_subscription
from xk_switcher.failover import FailoverLoop, FailoverConfig
from xk_switcher.subscription import Location


T0 = datetime(2026, 4, 19, 6, 0, 0, tzinfo=timezone.utc)


class _Clock:
    def __init__(self, t):
        self.t = t

    def now(self):
        return self.t

    def advance(self, sec):
        self.t = self.t + timedelta(seconds=sec)


class _Router:
    def __init__(self, state):
        self.state = state
        self.applies = []
        self.xkeen_calls = []
        self._probes = {}

    def set_probe(self, code, ok, latency=50):
        self._probes[code] = (ok, latency)

    def apply(self, payload):
        self.applies.append(payload)

    def run_xkeen(self, action):
        self.xkeen_calls.append(action)
        return f"mock xkeen -{action}"


def _loc(code):
    return Location(
        code=code,
        name=f"NM {code}",
        protocol="vless",
        host=code,
        port=443,
        uuid="u",
        flow="",
        network="tcp",
        security="reality",
        sni="s",
        pbk="p",
        sid="i",
    )


def test_full_failover_failback_cycle(tmp_path, monkeypatch):
    state = State(tmp_path)
    state.init({})
    state.write_subscription({"locations": [asdict(_loc("de1")), asdict(_loc("ru2"))]})
    state.write_state({"active_code": "de1"})
    state.write_failover({
        "schema_version": 1,
        "enabled": True,
        "auto_failback": True,
        "auto_stop_on_total_failure": False,
        "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })

    clock = _Clock(T0)
    router = _Router(state)

    # Force service._now_iso to use fake clock so last_apply_at lines up with
    # the clock used by FailoverLoop.should_probe — otherwise grace check
    # compares fake-now with real wall-clock time and every post-switch tick
    # would be skipped.
    monkeypatch.setattr(
        "xk_switcher.service._now_iso",
        lambda: clock.now().replace(microsecond=0).isoformat(),
    )

    # _tcp_probe imports socket inside the method and calls
    # socket.create_connection((host, port), timeout=...). Monkeypatch the
    # stdlib attribute so non-active whitelisted codes resolve via _probes.
    def fake_create_connection(address, timeout):
        host, _port = address
        ok, _lat = router._probes.get(host, (False, None))
        if not ok:
            raise OSError("fake: connection refused")

        class _Conn:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

        return _Conn()

    monkeypatch.setattr("socket.create_connection", fake_create_connection)

    service = _service_with_subscription(state, router)
    cfg = FailoverConfig(
        check_interval_sec=300,
        fail_threshold=3,
        grace_after_switch_sec=60,
        dampening_ticks=3,
        tcp_timeout_sec=3,
    )
    loop = FailoverLoop(state=state, service=service, router=router, cfg=cfg, clock=clock.now)

    # Phase 1: both healthy — noop x 2
    router.set_probe("de1", ok=True, latency=87)
    router.set_probe("ru2", ok=True, latency=41)
    loop.tick_once(); clock.advance(300)
    loop.tick_once(); clock.advance(300)
    assert state.read_state()["active_code"] == "de1"
    assert state.read_state()["failover_active"] is False

    # Phase 2: de1 starts failing — 3 consecutive fails trigger switch to ru2
    router.set_probe("de1", ok=False)
    loop.tick_once(); clock.advance(300)   # fail 1
    loop.tick_once(); clock.advance(300)   # fail 2
    assert state.read_state()["active_code"] == "de1"
    loop.tick_once(); clock.advance(300)   # fail 3 -> switch
    assert state.read_state()["active_code"] == "ru2"
    assert state.read_state()["failover_active"] is True

    # Phase 3: de1 recovers — failback after dampening_ticks ok probes
    router.set_probe("de1", ok=True, latency=87)
    loop.tick_once(); clock.advance(300)   # ok 1
    loop.tick_once(); clock.advance(300)   # ok 2
    assert state.read_state()["active_code"] == "ru2"
    loop.tick_once(); clock.advance(300)   # ok 3 -> failback
    assert state.read_state()["active_code"] == "de1"
    assert state.read_state()["failover_active"] is False

    # Phase 4: post-failback tick must not crash (grace may skip it).
    loop.tick_once()
