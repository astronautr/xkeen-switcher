import json
import threading
import time
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import pytest
from xk_switcher import route_probe, routing
from xk_switcher.route_checks import CHECKS_FILE, FRESH_SEC, RouteChecks
from xk_switcher.router import Router
from xk_switcher.routing import RoutingError
from xk_switcher.service import Service
from xk_switcher.state import State
from xk_switcher.subscription import Location
from tests._helpers import make_test_server
from .test_service import _flag, _subscription_bytes

TARGETS = ["https://video.example/health", "https://shop.example/"]

def _loc(code, host=None, sni=None, protocol="vless"):
    host = host or code + ".example"
    return Location(code=code, name=f"{_flag(code[:2])} {code.upper()}", protocol=protocol, host=host, port=443,
                    uuid="U", network="tcp", security="reality", sni=sni or host, pbk="PBK", sid="SID",
                    spx="/", fingerprint="chrome")

LOCATIONS = [_loc("fi"), _loc("ru1"), _loc("de"), _loc("lv")]

class Clock:
    def __init__(self):
        self.value = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
    def __call__(self):
        return self.value
    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)

def _seed(state, locations):
    state.write_subscription({"fetched_at": "2026-11-18T00:00:00Z", "locations": [asdict(loc) for loc in locations]})

@pytest.fixture
def clock():
    return Clock()

@pytest.fixture
def service(tmp_path, clock):
    state = State(tmp_path)
    state.init({})
    _seed(state, LOCATIONS)
    state.write_state({"active_code": "ru1", "active_status": "ok", "xkeen_state": "running",
                       "subscription_url": "https://sub.example"})
    state.write_connectivity({"schema_version": 1, "check_urls": TARGETS})
    router = Router("mock")
    router.mock_probe_delay = 0
    router.mock_probe_outcomes = {"single>fi": "failed", "ru1>fi": "working", "de>fi": "unstable", "lv>fi": "failed",
                                  "fi>ru1": "failed"}
    instance = Service(state, router, fetch_fn=lambda url: _subscription_bytes(LOCATIONS))
    instance.route_checks = RouteChecks(instance, now=clock)
    yield instance
    instance.route_checks.stop()
    instance.routing.stop()

def _finish(checks, exit_code="fi", timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        view = checks.view(exit_code)
        if view["run"] and view["run"]["state"] != "running":
            return view
        time.sleep(0.01)
    pytest.fail("route checks did not finish")

def _rows(view):
    return {row["key"]: row for row in view["routes"]}

def _run(service, exit_code="fi"):
    run_id = routing.new_id()
    service.route_checks.start(exit_code, run_id)
    return run_id, _finish(service.route_checks, exit_code)

def test_checks_single_and_every_other_entry_in_stable_order(service):
    run_id, view = _run(service)
    assert [row["key"] for row in view["routes"]] == ["single", "ru1", "de", "lv"]
    rows = _rows(view)
    assert rows["single"]["state"] == "failed" and rows["single"]["mode"] == "single"
    assert rows["ru1"]["state"] == "working" and rows["ru1"]["entry_name"] == "🇷🇺 RU1"
    assert rows["de"]["state"] == "unstable"
    assert [item["ok"] for item in rows["de"]["rounds"]] == [True, False]
    assert all(len(item["results"]) == 2 for item in rows["de"]["rounds"])
    assert [row["applicable"] for row in view["routes"]] == [False, True, False, False]
    assert view["run"] == {**view["run"], "id": run_id, "state": "completed", "total": 4, "done": 4, "working": 1}
    assert view["conditions"] == {"targets": TARGETS, "timeout_sec": 5, "rounds": 2}

def test_opposite_direction_is_an_independent_route(service):
    _run(service, "fi")
    _, view = _run(service, "ru1")
    assert _rows(view)["fi"]["state"] == "failed"
    assert _rows(service.route_checks.view("fi"))["ru1"]["state"] == "working"

def test_route_on_main_is_marked_and_not_applicable(service):
    service.state.write_state({"active_code": "fi", "active_entry_code": "ru1"})
    _, view = _run(service)
    assert _rows(view)["ru1"]["on_main"] and not _rows(view)["ru1"]["applicable"]

def test_opening_and_reading_never_starts_checks(service):
    view = service.route_checks.view("fi")
    assert view["run"] is None and {row["state"] for row in view["routes"]} == {"unchecked"}
    assert service.status()["route_checks"] is None

def test_start_is_idempotent_and_one_run_at_a_time(service, monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(service.router, "probe_route", lambda *a, **k: gate.wait(5) and "D\n" or "")
    run_id = routing.new_id()
    first = service.route_checks.start("fi", run_id)
    assert first["active_run"]["id"] == run_id and first["run"]["state"] == "running"
    assert service.route_checks.start("fi", run_id)["run"]["id"] == run_id
    with pytest.raises(RoutingError, match="already in use"):
        service.route_checks.start("de", run_id)
    with pytest.raises(RoutingError) as busy:
        service.route_checks.start("de", routing.new_id())
    assert busy.value.code == "busy"
    assert service.status()["route_checks"]["state"] == "running"
    gate.set()
    _finish(service.route_checks)

def test_results_appear_as_ready_while_order_stays_fixed(service, monkeypatch):
    gates = {key: threading.Event() for key in ("single", "ru1", "de", "lv")}
    original = service.router.probe_route
    def probe(config, **kwargs):
        gates[kwargs["hint"]["entry_code"] or "single"].wait(5)
        return original(config, **kwargs)
    monkeypatch.setattr(service.router, "probe_route", probe)
    service.route_checks.start("fi", routing.new_id())
    gates["ru1"].set()
    deadline = time.monotonic() + 5
    while _rows(service.route_checks.view("fi"))["ru1"]["state"] != "working":
        assert time.monotonic() < deadline
        time.sleep(0.01)
    view = service.route_checks.view("fi")
    assert [row["key"] for row in view["routes"]] == ["single", "ru1", "de", "lv"]
    assert _rows(view)["single"]["state"] in {"checking", "queued"}
    assert not any(row["applicable"] for row in view["routes"])
    assert view["run"]["done"] == 1
    for gate in gates.values():
        gate.set()
    _finish(service.route_checks)

@pytest.mark.parametrize("change, reason", [
    ("expire", "more than 10 minutes"),
    ("sni", "configuration changed"),
    ("remove", "no longer in the subscription"),
    ("targets", "Test sites or check settings changed"),
])
def test_result_goes_stale(service, clock, change, reason):
    run_id, _ = _run(service)
    if change == "expire":
        clock.advance(FRESH_SEC)
    elif change == "sni":
        _seed(service.state, [_loc("fi", sni="new.example"), *LOCATIONS[1:]])
    elif change == "remove":
        _seed(service.state, [loc for loc in LOCATIONS if loc.code != "ru1"])
    else:
        service.state.write_connectivity({"schema_version": 1, "check_urls": TARGETS[:1]})
    row = _rows(service.route_checks.view("fi")).get("ru1")
    assert row["state"] == "stale" and reason in row["stale_reason"] and row["outcome"] == "working"
    assert not row["applicable"]
    with pytest.raises(RoutingError, match=reason) as refused:
        service.routing.submit_main("fi", routing.new_id(), entry_code="ru1", route_check_id=run_id)
    assert refused.value.code == "stale_check"
    assert service.router._mock_operations == {}

def test_unrelated_location_change_keeps_checked_pair_fresh(service, clock):
    run_id, _ = _run(service)
    clock.advance(FRESH_SEC - 1)
    _seed(service.state, [*LOCATIONS[:2], _loc("de", sni="rotated.example"), LOCATIONS[3], _loc("se")])
    rows = _rows(service.route_checks.view("fi"))
    assert rows["ru1"]["state"] == "working" and rows["ru1"]["applicable"]
    assert rows["de"]["state"] == "stale" and rows["se"]["state"] == "unchecked"
    assert service.route_checks.verify_apply(run_id, "fi", "ru1") == route_probe.candidate_hash(LOCATIONS[0], LOCATIONS[1])

def _wait_op(service, ident):
    for _ in range(300):
        op = service.routing.store.operation(ident)
        if op["phase"] in {"committed", "rejected", "rolled_back", "unknown"}:
            return op
        time.sleep(0.01)
    pytest.fail("operation did not finish")

def test_apply_from_check_switches_exactly_the_checked_chain(service):
    run_id, _ = _run(service)
    ident = routing.new_id()
    op = service.routing.submit_main("fi", ident, entry_code="ru1", route_check_id=run_id)
    assert op["id"] == ident
    assert _wait_op(service, ident)["phase"] == "committed"
    st = service.state.read_state()
    assert (st["active_entry_code"], st["active_code"]) == ("ru1", "fi")
    installed = json.loads(service.router._mock_outbound)
    assert installed == json.loads(route_probe.candidate(LOCATIONS[0], LOCATIONS[1]))
    assert _rows(service.route_checks.view("fi"))["ru1"]["on_main"]

def test_single_with_same_exit_leaves_a_chain(service):
    service.state.write_state({"active_code": "fi", "active_entry_code": "ru1"})
    service.router.mock_probe_outcomes["single>fi"] = "working"
    run_id, view = _run(service)
    assert _rows(view)["single"]["applicable"]
    ident = routing.new_id()
    service.routing.submit_main("fi", ident, route_check_id=run_id)
    assert _wait_op(service, ident)["phase"] == "committed"
    st = service.state.read_state()
    assert st["active_code"] == "fi" and st["active_entry_code"] is None

def test_only_fresh_working_routes_can_be_applied(service):
    run_id, _ = _run(service)
    for entry in (None, "de"):
        with pytest.raises(RoutingError, match="Only a Working route") as refused:
            service.routing.submit_main("fi", routing.new_id(), entry_code=entry, route_check_id=run_id)
        assert refused.value.code == "stale_check"
    with pytest.raises(RoutingError, match="no longer available"):
        service.routing.submit_main("de", routing.new_id(), entry_code="ru1", route_check_id=run_id)
    with pytest.raises(RoutingError, match="A newer check"):
        service.routing.submit_main("fi", routing.new_id(), entry_code="ru1", route_check_id=routing.new_id())

def test_lost_reply_replay_returns_accepted_operation_after_expiry(service, clock):
    run_id, _ = _run(service)
    ident = routing.new_id()
    service.routing.submit_main("fi", ident, entry_code="ru1", route_check_id=run_id)
    _wait_op(service, ident)
    clock.advance(FRESH_SEC * 3)
    replay = service.routing.submit_main("fi", ident, entry_code="ru1", route_check_id=run_id)
    assert replay["id"] == ident
    assert len(service.router._mock_operations) == 1
    with pytest.raises(RoutingError, match="already in use"):
        service.routing.submit_main("fi", ident, entry_code="de", route_check_id=run_id)

def test_config_change_after_acceptance_rejects_before_router_io(service, monkeypatch):
    run_id, _ = _run(service)
    original = service.prepare_main_operation
    def rotate_then_prepare(*args, **kwargs):
        _seed(service.state, [_loc("fi", sni="rotated.example"), *LOCATIONS[1:]])
        return original(*args, **kwargs)
    monkeypatch.setattr(service, "prepare_main_operation", rotate_then_prepare)
    ident = routing.new_id()
    service.routing.submit_main("fi", ident, entry_code="ru1", route_check_id=run_id)
    op = _wait_op(service, ident)
    assert op["phase"] == "rejected" and "Recheck routes" in op["message"]
    assert service.router._mock_operations == {}
    assert service.state.read_state()["active_code"] == "ru1"

def test_ordinary_main_switch_is_unaffected_by_checks(service):
    ident = routing.new_id()
    service.routing.submit_main("de", ident)
    assert _wait_op(service, ident)["phase"] == "committed"

def test_targets_changed_during_preparation_preserves_accepted_apply(service, monkeypatch):
    run_id, _ = _run(service)
    original = service.router.routing_health
    def change_targets_during_health_read():
        service.state.write_connectivity({"check_urls": ["https://other.example/"]})
        return original()
    monkeypatch.setattr(service.router, "routing_health", change_targets_during_health_read)
    monkeypatch.setattr(service.routing, "_launch", lambda ident: None)
    ident = routing.new_id()
    service.routing.submit_main("fi", ident, entry_code="ru1", route_check_id=run_id)
    service.routing._run(ident)
    assert service.routing.store.operation(ident)["phase"] == "committed"
    with pytest.raises(RoutingError, match="Test sites") as refused:
        service.routing.submit_main("fi", routing.new_id(), entry_code="ru1", route_check_id=run_id)
    assert refused.value.code == "stale_check"

def test_checks_do_not_touch_health_state_or_installed_config(service):
    before = (service.state.read_health(), service.state.read_state(), service.router._mock_outbound)
    _run(service)
    after = (service.state.read_health(), service.state.read_state(), service.router._mock_outbound)
    assert before == after

def test_restart_marks_unfinished_routes_unavailable(service, clock, tmp_path):
    _run(service)
    doc = json.loads((tmp_path / CHECKS_FILE).read_text())
    doc["runs"][-1]["state"] = "running"
    for route in doc["runs"][-1]["routes"][1:]:
        route["state"] = "checking" if route["key"] == "ru1" else "queued"
    (tmp_path / CHECKS_FILE).write_text(json.dumps(doc))
    fresh = RouteChecks(service, now=clock)
    fresh.recover()
    view = fresh.view("fi")
    assert view["run"]["state"] == "interrupted"
    rows = _rows(view)
    assert rows["single"]["state"] == "failed"
    assert {rows[key]["state"] for key in ("ru1", "de", "lv")} == {"unavailable"}
    assert "restarted" in rows["ru1"]["reason"] and not rows["ru1"]["applicable"]
    assert fresh.start("fi", routing.new_id())["run"]["state"] == "running"
    _finish(fresh)

def test_diagnostic_errors_are_unavailable_without_router_text(service, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("ssh: password=secret host=10.0.0.1")
    monkeypatch.setattr(service.router, "probe_route", broken)
    _, view = _run(service)
    assert {row["state"] for row in view["routes"]} == {"unavailable"}
    assert "secret" not in json.dumps(view)
    assert "Could not run the check" in view["routes"][0]["reason"]

def test_unsupported_route_reports_reason(service):
    service.router.mock_probe_outcomes["de>fi"] = "unsupported"
    _, view = _run(service)
    row = _rows(view)["de"]
    assert row["state"] == "unsupported" and "does not support hysteria2" in row["reason"]

def test_view_never_exposes_node_secrets(service):
    _, view = _run(service)
    text = json.dumps(view)
    assert "PBK" not in text and "fi.example" not in text and "candidate" not in text

def test_web_route_check_endpoints(tmp_path):
    state = State(tmp_path)
    state.init({"subscription_url": "https://sub.example"})
    _seed(state, LOCATIONS)
    state.write_state({"active_code": "ru1"})
    router = Router("mock")
    router.mock_probe_delay = 0
    server, client = make_test_server(state, router=router)
    try:
        assert client.get("/api/route-checks").status_code == 400
        assert client.get("/api/route-checks?exit=fi").json()["run"] is None
        run_id = routing.new_id()
        started = client.post("/api/route-checks", {"exit_code": "fi", "run_id": run_id})
        assert started.status_code == 202 and started.json()["run"]["id"] == run_id
        view = _finish(server.service.route_checks)
        ru1 = _rows(view)["ru1"]
        assert ru1["state"] == "working"
        assert client.get("/api/status").json()["route_checks"]["id"] == run_id
        stale = client.post("/api/switch", {"code": "fi", "entry_code": "de", "operation_id": routing.new_id(),
                                            "route_check_id": run_id})
        assert stale.status_code == 409 and stale.json()["code"] == "stale_check"
        ident = routing.new_id()
        accepted = client.post("/api/switch", {"code": "fi", "entry_code": "ru1", "operation_id": ident,
                                               "route_check_id": run_id})
        assert accepted.status_code == 202 and accepted.json()["operation"]["id"] == ident
    finally:
        server.service.route_checks.stop()
        server.service.routing.stop()
        server.shutdown()
        server.server_close()

def test_cancel_stops_a_run_and_keeps_finished_results(service, monkeypatch):
    started = threading.Event()
    original = service.router.probe_route
    def probe(config, **kwargs):
        if kwargs["hint"]["entry_code"] is None:
            return original(config, **kwargs)
        started.set()
        if kwargs["cancel"].wait(5):
            raise route_probe.ProbeCancelled()
        return original(config, **kwargs)
    monkeypatch.setattr(service.router, "probe_route", probe)
    service.route_checks._parallel = 1
    run_id = routing.new_id()
    service.route_checks.start("fi", run_id)
    assert started.wait(5)
    view = service.route_checks.cancel(run_id)
    assert view["run"]["state"] == "cancelled" and view["active_run"] is None
    assert {row["key"]: row["state"] for row in view["routes"]}["lv"] == "unavailable"
    view = _finish(service.route_checks)
    rows = _rows(view)
    assert view["run"]["state"] == "cancelled"
    assert rows["single"]["state"] == "failed"
    assert rows["ru1"]["state"] == "unavailable" and "Stopped before this route finished" in rows["ru1"]["reason"]
    assert rows["de"]["reason"] == "Stopped before this route was checked"
    assert service.route_checks.cancel(run_id)["run"]["state"] == "cancelled"
    # The router is free again for a new run.
    monkeypatch.undo()
    assert service.route_checks.start("fi", routing.new_id())["run"]["state"] == "running"
    _finish(service.route_checks)

def test_cancel_rejects_unknown_runs(service):
    with pytest.raises(RoutingError) as missing:
        service.route_checks.cancel(routing.new_id())
    assert missing.value.status == 404
    with pytest.raises(RoutingError):
        service.route_checks.cancel("not-an-id")

def test_router_probe_cancel_kills_the_ssh_session(tmp_path, monkeypatch):
    router = Router("router.example", password="x")
    monkeypatch.setattr(router, "_build_cmd", lambda command: ["sh", "-c", "cat >/dev/null; sleep 30"])
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    began = time.monotonic()
    with pytest.raises(route_probe.ProbeCancelled):
        router.probe_route(b"{}", port=20000, urls=TARGETS, timeout=5, rounds=2, limit=30,
                           user_agent="agent", hint={}, cancel=cancel)
    assert time.monotonic() - began < 3

def test_web_cancel_endpoint(tmp_path):
    state = State(tmp_path)
    state.init({"subscription_url": "https://sub.example"})
    _seed(state, LOCATIONS)
    router = Router("mock")
    router.mock_probe_delay = 2
    server, client = make_test_server(state, router=router)
    try:
        run_id = routing.new_id()
        assert client.post("/api/route-checks", {"exit_code": "fi", "run_id": run_id}).status_code == 202
        stopped = client.post("/api/route-checks/cancel", {"run_id": run_id})
        assert stopped.status_code == 200
        assert _finish(server.service.route_checks)["run"]["state"] == "cancelled"
        assert client.post("/api/route-checks/cancel", {"run_id": routing.new_id()}).status_code == 404
    finally:
        server.service.route_checks.stop()
        server.service.routing.stop()
        server.shutdown()
        server.server_close()

def _start_selected(service, kind, codes, exit_code=None, run_id=None):
    checks = service.route_checks
    args = {"codes" if kind == "single" else "entry_codes": codes}
    return checks.start(exit_code, run_id or routing.new_id(), kind=kind,
                        conditions_hash=checks.view(exit_code, kind=kind)["conditions"]["hash"], **args)

def _settle(checks, kind, exit_code=None):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        view = checks.view(exit_code, kind=kind)
        if view["run"] and view["run"]["state"] != "running":
            return view
        time.sleep(0.005)
    pytest.fail("route checks did not finish")

def test_selected_runs_keep_results_across_steps_and_eviction(service, clock):
    checks = service.route_checks
    service.router.mock_probe_outcomes.update({"single>de": "working", "single>ru1": "unstable"})
    first = _start_selected(service, "single", ["de", "ru1", "de"])["run"]["id"]
    singles = _rows(_settle(checks, "single"))
    assert list(singles) == ["fi", "ru1", "de", "lv"]
    assert singles["de"]["applicable"] and singles["fi"]["state"] == "unchecked"
    assert checks.summary() is None
    for _ in range(20):
        _start_selected(service, "chain", ["ru1"], "fi")
        view = _settle(checks, "chain", "fi")
    assert first not in [run["id"] for run in checks._read()["runs"]]
    assert checks.verify_apply(first, "de", None)
    assert checks.view(kind="single")["run"]["id"] == first
    replay = _start_selected(service, "single", ["ru1", "de"], run_id=first)
    assert not replay["active_run"]
    with pytest.raises(RoutingError, match="already in use"):
        _start_selected(service, "single", ["fi"], run_id=first)
    assert view["direct"]["state"] == "unchecked"
    assert _rows(view)["ru1"]["entry_reachable"] and _rows(view)["de"]["entry_reachable"]
    clock.advance(FRESH_SEC)
    assert _rows(checks.view("fi", kind="chain"))["ru1"]["entry_reachable"]
    _start_selected(service, "single", ["de"])
    _settle(checks, "single")
    with pytest.raises(RoutingError, match="A newer check"):
        checks.verify_apply(first, "de", None)

def test_unavailable_attempt_preserves_working_and_later_verdict_clears_note(service, clock, monkeypatch):
    checks = service.route_checks
    service.router.mock_probe_outcomes["single>de"] = "working"
    _start_selected(service, "single", ["de"])
    first = _rows(_settle(checks, "single"))["de"]["run_id"]
    clock.advance(1)
    monkeypatch.setattr(checks, "_probe", lambda *args: {"outcome": "unavailable", "reason": "No reply", "rounds": []})
    second = _start_selected(service, "single", ["de"])["run"]["id"]
    row = _rows(_settle(checks, "single"))["de"]
    assert row["run_id"] == first and row["applicable"]
    assert row["last_attempt"] == {"run_id": second, "reason": "No reply", "finished_at": clock().isoformat(timespec="microseconds")}
    monkeypatch.undo()
    _start_selected(service, "single", ["de"])
    assert _rows(_settle(checks, "single"))["de"]["last_attempt"] is None

def test_missing_pending_codes_are_skipped_without_router_io(service, monkeypatch):
    checks = service.route_checks
    entered, resume = threading.Event(), threading.Event()
    seen = []
    def probe(main, hint, conditions, protocols, cancel):
        seen.append(hint["exit_code"])
        entered.set()
        resume.wait(3)
        return {"outcome": "working", "reason": None, "rounds": []}
    monkeypatch.setattr(checks, "_probe", probe)
    checks._parallel = 1
    _start_selected(service, "single", [loc.code for loc in LOCATIONS])
    assert entered.wait(3)
    _seed(service.state, [])
    resume.set()
    view = _settle(checks, "single")
    assert seen == ["fi"] and not view["routes"] and view["run"]["done"] == 4
    assert all(r["reason"] == "This location left the subscription" for r in checks._read()["runs"][-1]["routes"][1:])

def test_migration_recovers_attempt_before_indexing_completed_v1_routes(service, clock, tmp_path):
    checks = service.route_checks
    first, _ = _run(service)
    clock.advance(10)
    second, _ = _run(service)
    doc = checks._read()
    path = tmp_path / CHECKS_FILE
    old = {"schema_version": 1, "runs": doc["runs"]}
    for run in old["runs"]:
        del run["kind"]
    run = old["runs"][-1]
    run.update(state="running", finished_at=None)
    route = next(r for r in run["routes"] if r["entry_code"] == "ru1")
    route.update(state="checking", outcome=None, finished_at=None)
    path.write_text(json.dumps(old))
    clock.advance(10)
    migrated = RouteChecks(service, now=clock)
    migrated.recover()
    row = _rows(migrated.view("fi", kind="chain"))["ru1"]
    assert row["run_id"] == first and row["state"] == "working" and row["applicable"]
    assert row["last_attempt"]["run_id"] == second and "restarted" in row["last_attempt"]["reason"]
    assert migrated.view("fi")["run"]["state"] == "interrupted"
    assert _rows(migrated.view(kind="single"))["fi"]["run_id"] == second
    saved, timestamp = path.read_bytes(), path.stat().st_mtime_ns
    RouteChecks(service, now=clock).recover()
    assert path.read_bytes() == saved and path.stat().st_mtime_ns == timestamp

def test_running_single_exposes_progress_on_chain_and_stop_keeps_prior_verdict(service, monkeypatch):
    service.router.mock_probe_outcomes["single>de"] = "working"
    checks = service.route_checks
    first = _start_selected(service, "single", ["de"])["run"]["id"]
    _settle(checks, "single")
    entered = threading.Event()
    def hold(main, hint, conditions, protocols, cancel):
        entered.set()
        cancel.wait(3)
        raise route_probe.ProbeCancelled()
    monkeypatch.setattr(checks, "_probe", hold)
    checks._parallel = 1
    second = _start_selected(service, "single", ["lv", "de"])["run"]["id"]
    assert entered.wait(3)
    assert checks.view("lv", kind="chain")["direct"]["state"] == "queued"
    assert checks.view("de", kind="chain")["direct"]["state"] == "checking"
    assert checks.summary() is None and checks.summary(legacy=False)["kind"] == "single"
    with pytest.raises(RoutingError, match="Location checks are already running"):
        checks.start("de", routing.new_id())
    with pytest.raises(RoutingError, match="Wait for route checks to finish"):
        checks.verify_apply(first, "de", None)
    stopped = checks.cancel(second)
    assert stopped["kind"] == "single" and stopped["run"]["state"] == "cancelled"
    row = _rows(stopped)["de"]
    assert row["run_id"] == first and row["state"] == "working" and row["applicable"]
    assert row["last_attempt"]["reason"] == "Stopped before this route finished"

def test_condition_and_node_changes_disable_and_restore_reachable(service):
    checks = service.route_checks
    service.router.mock_probe_outcomes["single>de"] = "working"
    first = _start_selected(service, "single", ["de"])["run"]["id"]
    baseline = _settle(checks, "single")
    saved = checks.view("fi", kind="chain")["conditions"]["hash"]
    service.state.write_connectivity({"check_urls": TARGETS[:1]})
    changed = checks.view("fi", kind="chain")
    assert changed["conditions"]["hash"] != saved and _rows(changed)["de"]["entry_reachable"] is None
    with pytest.raises(RoutingError, match="Review the list") as stale:
        checks.start("fi", routing.new_id(), kind="chain", entry_codes=["de"], conditions_hash=saved)
    assert stale.value.code == "stale_conditions" and len(checks._read()["runs"]) == 1
    service.state.write_connectivity({"check_urls": TARGETS})
    assert _rows(checks.view("fi", kind="chain"))["de"]["entry_reachable"]
    assert _rows(checks.view(kind="single"))["de"] == _rows(baseline)["de"]
    assert checks.verify_apply(first, "de", None)
    _seed(service.state, [_loc("de", sni="rotated.example"), *LOCATIONS[:2]])
    assert _rows(checks.view("fi", kind="chain"))["de"]["entry_reachable"] is None
    assert _rows(checks.view(kind="single"))["de"]["stale_kind"] == "config"

def test_selection_validation_and_subset_replay(service):
    checks = service.route_checks
    h = checks.view(kind="single")["conditions"]["hash"]
    ident = routing.new_id()
    for kind, exit_code, args, status, code in [
        ("single", None, {"codes": []}, 400, "validation"),
        ("chain", "fi", {"entry_codes": ["de", "fi"]}, 400, "validation"),
        ("single", None, {"codes": ["zz"]}, 409, "location"),
        ("chain", "zz", {"entry_codes": ["de"]}, 409, "location"),
    ]:
        with pytest.raises(RoutingError) as error:
            checks.start(exit_code, ident, kind=kind, conditions_hash=h, **args)
        assert (error.value.status, error.value.code) == (status, code)
    _start_selected(service, "single", ["de", "fi", "de"], run_id=ident)
    _settle(checks, "single")
    assert checks.start(None, ident, kind="single", codes=["fi", "de"], conditions_hash=h)["run"]["id"] == ident
    with pytest.raises(RoutingError, match="already in use"):
        checks.start(None, ident, kind="single", codes=["de"], conditions_hash=h)
    assert len(checks._read()["runs"]) == 1

def test_legacy_summary_counts_only_still_fresh_working_routes(service, clock):
    _run(service)
    assert service.route_checks.summary()["working"] == 1
    clock.advance(FRESH_SEC)
    assert service.route_checks.summary()["working"] == 0
    assert service.route_checks.view("fi")["run"]["working"] == 0

@pytest.mark.parametrize("saved", [b"{", b"[]", b'{"schema_version":3,"runs":[]}',
                                   b'{"schema_version":2,"runs":[],"index":[]}'])
def test_bad_existing_journal_blocks_writes_but_dashboard_remains_available(service, tmp_path, saved):
    path = tmp_path / CHECKS_FILE
    path.write_bytes(saved)
    checks = service.route_checks
    checks.recover()
    status = service.status()
    assert status["route_check_run"] is None and status["route_checks"] is None
    assert not checks.running()
    for action in (lambda: checks.start("de", routing.new_id()), lambda: checks.view(kind="single")):
        with pytest.raises(RoutingError) as error:
            action()
        assert (error.value.status, error.value.code) == (503, "storage")
    assert path.read_bytes() == saved

def test_unreadable_journal_fails_closed(service, tmp_path):
    # A directory in the file's place reliably raises OSError, including when run as root.
    (tmp_path / CHECKS_FILE).mkdir()
    with pytest.raises(RoutingError) as refused:
        service.route_checks.view(kind="single")
    assert refused.value.status == 503

def test_recovered_prepared_apply_rechecks_before_first_submission(service, clock, monkeypatch):
    run_id, _ = _run(service)
    monkeypatch.setattr(service.routing, "_launch", lambda ident: None)
    ident = routing.new_id()
    service.routing.submit_main("fi", ident, entry_code="ru1", route_check_id=run_id)
    op = service.routing.store.operation(ident)
    preview, _ = service.routing._prepare_main(op)
    # Simulate a crash after the snapshot write and before the first submission.
    service.routing._update(op, phase="prepared", before_snapshot=preview["base_snapshot"])
    clock.advance(FRESH_SEC + 1)
    service.routing._run(ident)
    result = service.routing.store.operation(ident)
    assert result["phase"] == "rejected" and "Recheck routes" in result["message"]
    assert not service.router._mock_operations

def test_pre_upgrade_accepted_main_uses_its_original_check(service, clock):
    original, _ = _run(service)
    candidate = service.route_checks.verify_apply(original, "fi", "ru1")
    clock.advance(1)
    service.router.mock_probe_outcomes["ru1>fi"] = "failed"
    _run(service)
    # v1 allowed a second browser to start a check after this intent was accepted.
    op = {"id": routing.new_id(), "kind": "main", "phase": "accepted", "target_code": "fi",
          "target_entry_code": "ru1", "trigger": "manual", "route_check_id": original,
          "expected_main_sha256": candidate}
    service.routing.store.put_operation(op)
    service.routing._run(op["id"])
    assert service.routing.store.operation(op["id"])["phase"] == "committed"

def test_evicted_legacy_run_keeps_freshness_and_rows(service, clock, monkeypatch):
    monkeypatch.setattr("xk_switcher.route_checks.KEEP_RUNS", 1)
    run_id, _ = _run(service)
    checks = service.route_checks
    _start_selected(service, "single", ["de"])
    _settle(checks, "single")
    assert all(run["id"] != run_id for run in checks._read()["runs"])
    assert _rows(checks.view("fi"))["ru1"]["state"] == "working"
    assert checks.summary()["working"] == 1
    clock.advance(FRESH_SEC)
    view = checks.view("fi")
    assert _rows(view)["ru1"]["state"] == "stale"
    assert checks.summary()["working"] == view["run"]["working"] == 0

def test_replay_archive_migrates_after_interrupted_json_save(service, monkeypatch, tmp_path):
    checks = service.route_checks
    original_id = routing.new_id()
    snapshot = checks._read()
    snapshot["past_requests"] = {original_id: checks._signature("single", None, ["de"])}
    path = tmp_path / CHECKS_FILE
    path.write_text(json.dumps(snapshot))
    def interrupt(*args):
        raise OSError("Interrupted before the progress journal was replaced")
    with monkeypatch.context() as patch:
        patch.setattr("xk_switcher.route_checks.atomic", interrupt)
        with pytest.raises(RoutingError):
            checks._write(checks._read())
    assert json.loads(path.read_text()) == snapshot
    checks._write(checks._read())
    assert "past_requests" not in json.loads(path.read_text())
    restarted = RouteChecks(service)
    args = {"kind": "single", "conditions_hash": restarted.view(kind="single")["conditions"]["hash"]}
    assert restarted.start(None, original_id, codes=["de"], **args)["active_run"] is None
    with pytest.raises(RoutingError, match="already in use"):
        restarted.start(None, original_id, codes=["fi"], **args)

def test_missing_replay_archive_refuses_new_checks(service, monkeypatch, tmp_path):
    monkeypatch.setattr("xk_switcher.route_checks.KEEP_RUNS", 1)
    _start_selected(service, "single", ["de"])
    _settle(service.route_checks, "single")
    _start_selected(service, "single", ["fi"])
    _settle(service.route_checks, "single")
    (tmp_path / "route-check-requests.sqlite3").rename(tmp_path / "missing-archive")
    with pytest.raises(RoutingError) as refused:
        _start_selected(service, "single", ["ru1"])
    assert (refused.value.status, refused.value.code) == (503, "storage")
