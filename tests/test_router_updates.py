"""Local service tests. All helpers, clocks, release downloads and SSH calls are simulated."""
from datetime import datetime, timedelta, timezone

import pytest

from xk_switcher.router import Router, RouterError
from xk_switcher.router_updates import MSK, MockCatalog, RouterUpdates
from xk_switcher.routing import RoutingError, new_id
from xk_switcher.service import Service
from xk_switcher.state import State

@pytest.fixture
def setup(tmp_path):
    store = State(tmp_path)
    store.init({})
    service = Service(store, Router("mock", mock_data_dir=tmp_path))
    now = [datetime(2026, 11, 20, 2, 59, tzinfo=MSK)]
    service.router.mock_update_time = lambda: now[0].timestamp()
    updates = RouterUpdates(service, clock=lambda: now[0])
    # Step the same durable state machine explicitly, including simulated service restarts.
    updates._wake = lambda: None
    service.router_updates = updates
    updates.refresh()
    return service, updates, now

def finish(updates):
    for _ in range(8):
        op = updates.active()
        if not op:
            return
        updates._step(updates.doc["operations"][op["id"]])
    pytest.fail("Expected the operation to reach a terminal state")

def install(updates, name="xray", version="26.11.9", **opts):
    body = dict(id=new_id(), action="install", component=name, version=version, **opts)
    updates.start(body)
    return body

def test_durable_update_replays_upload_and_closed_id(setup, monkeypatch):
    service, updates, now = setup
    req = install(updates)
    updates._step(updates.doc["operations"][req["id"]])
    send = service.router.update_submit
    def lost(op, payload):
        send(op, payload)
        raise RouterError("SSH reply lost")
    monkeypatch.setattr(service.router, "update_submit", lost)
    with pytest.raises(RouterError):
        updates._step(updates.doc["operations"][req["id"]])
    restarted = RouterUpdates(service, clock=lambda: now[0])
    restarted._wake = lambda: None
    service.router_updates = restarted
    finish(restarted)
    assert restarted.start(req)["history"][0]["phase"] == "installed"
    assert len(service.router._software["steps"]) == 1
    with pytest.raises(RoutingError):
        restarted.start({**req, "version": "26.10.31"})

def test_chain_restore_confirmed_and_held_after_offline_operation(setup):
    service, updates, _ = setup
    install(updates, "xkeen", "2.1")
    finish(updates)
    install(updates)
    finish(updates)
    rows = updates.status()["components"]["xkeen"]["rollback"]
    assert [(r["component"], r["to"]) for r in rows] == [("xray", "26.3.27"), ("xkeen", "2.0")]
    with pytest.raises(RoutingError):
        updates.start(dict(id=new_id(), action="rollback", component="xkeen", version="2.0", plan=rows[-1:], revision=updates.status()["rollback_revision"]))
    # A local TUI uses the same router journal without a request on the Mac.
    service.router.update_submit({"id": new_id(), "component": "xkeen", "from": "2.1", "version": "2.0",
                                  "action": "rollback", "revision": service.router.update_inventory()["revision"]}, None)
    updates.tick()
    assert not updates.available()
    assert updates.status()["history"][0]["source"] == "router"
    assert updates.generation() == service.router.update_inventory()["last"]["id"]

def test_mutual_exclusion_and_stale_probe_result(setup):
    service, updates, _ = setup
    old_hash = service.route_checks.conditions_hash(service.route_checks.conditions())
    install(updates)
    with pytest.raises(RoutingError, match="software"):
        service.routing.ensure_idle()
    with pytest.raises(RoutingError, match="software"):
        service.route_checks.start("de", new_id())
    finish(updates)
    assert old_hash != service.route_checks.conditions_hash(service.route_checks.conditions())
    service.route_checks._threads[new_id()] = object()
    with pytest.raises(RoutingError, match="progress"):
        install(updates, "xkeen", "2.1")

def test_single_schedule_reserves_and_keeps_exact_version(setup):
    _, updates, now = setup
    updates.configure({"xkeen": False, "xray": True, "time": "03:00"})
    date = now[0] + timedelta(minutes=8)
    updates.schedule({"component": "xray", "version": "26.10.31", "at": date.isoformat()})
    now[0] += timedelta(minutes=2)
    updates.tick()
    assert updates.active() is None
    with pytest.raises(RoutingError, match="pinned"):
        install(updates)
    now[0] = date
    updates.tick()
    assert updates.active()["version"] == "26.10.31"
    finish(updates)
    assert updates.status()["components"]["xray"]["schedule"] is None
    assert updates.status()["history"][0]["source"] == "once"

def test_changed_release_is_rejected_before_submit(setup):
    _, updates, now = setup
    date = now[0] + timedelta(minutes=5)
    updates.schedule({"component": "xray", "version": "26.10.31", "at": date.isoformat()})
    class Replacement(MockCatalog):
        @staticmethod
        def list_releases(arch, installed):
            rows = MockCatalog.list_releases(arch, installed)
            rows[-1]["sha256"] = "f" * 64
            return rows
    updates.catalog = Replacement
    updates.refresh()
    now[0] = date
    updates.tick()
    assert updates.active() is None
    assert updates.status()["components"]["xray"]["schedule"]["state"] == "failed"

def test_missed_window_and_sensitive_collision(setup):
    _, updates, now = setup
    date = now[0].replace(hour=4, minute=0)
    updates.schedule({"component": "xkeen", "version": "2.1", "at": date.isoformat()})
    now[0] = date
    updates.tick()
    assert not updates.active()
    now[0] += timedelta(hours=2)
    updates.tick()
    assert updates.status()["components"]["xkeen"]["schedule"]["state"] == "missed"

def test_catalog_outage_allows_local_restore(setup):
    _, updates, _ = setup
    install(updates)
    finish(updates)
    class Offline:
        @staticmethod
        def list_releases(*_):
            raise OSError("credential must not leak")
    updates.catalog = Offline
    view = updates.refresh()
    assert view["catalog_error"] and "credential" not in view["catalog_error"]
    rows = view["components"]["xray"]["rollback"]
    updates.start(dict(id=new_id(), component="xray", action="rollback", version="26.3.27", plan=rows, revision=view["rollback_revision"]))
    finish(updates)
    assert updates.status()["history"][0]["phase"] == "rolled_back"

def test_manual_recovery_after_interruption(setup, monkeypatch):
    service, updates, _ = setup
    req = install(updates)
    op = updates.doc["operations"][req["id"]]
    updates._step(op)
    monkeypatch.setattr(service.router, "update_status", lambda _: {**req, "phase": "interrupted"})
    updates._step(updates.doc["operations"][req["id"]])
    assert updates.active()["phase"] == "interrupted"
    monkeypatch.setattr(service.router, "update_recover", lambda _: monkeypatch.setattr(
        service.router, "update_status", lambda __: {**req, "phase": "rolled_back"}))
    updates.recover(req["id"])
    finish(updates)
    assert updates.status()["history"][0]["phase"] == "rolled_back"

def test_bad_payloads_return_validation_errors(setup):
    _, updates, _ = setup
    invalid = [{"id": new_id(), "version": "2.1", "action": "install"},
               {"id": new_id(), "version": "2.1", "action": "install", "component": []},
               {"id": new_id(), "version": 23, "action": "install", "component": "xkeen"}]
    for body in invalid:
        with pytest.raises(RoutingError):
            updates.start(body)

def test_enabling_mid_window_waits_for_next_displayed_occurrence(setup):
    _, updates, now = setup
    now[0] += timedelta(minutes=4)
    status = updates.configure({"xkeen": True, "xray": False, "time": "03:00"})
    assert status["next_auto_at"].startswith("2026-11-21T03:00")
    updates.tick()
    assert updates.active() is None
    now[0] += timedelta(days=1)
    updates.tick()
    assert updates.active()["source"] == "auto"

def test_window_expires_while_artifact_is_staged(setup):
    service, updates, now = setup
    when = now[0] + timedelta(minutes=2)
    updates.schedule({"component": "xray", "version": "26.10.31", "at": when.isoformat()})
    now[0] = when
    updates.tick()
    ident = updates.active()["id"]
    updates._step(updates.doc["operations"][ident])
    assert updates.active()["phase"] == "submitting"
    now[0] += timedelta(hours=4)
    updates._step(updates.doc["operations"][ident])
    assert updates.status()["components"]["xray"]["schedule"]["state"] == "missed"
    assert service.router.update_status(ident)["phase"] == "unknown"

@pytest.mark.parametrize("outcome", ["start_failed", "rejected", "rolled_back", "rolled_back_start_failed"])
def test_second_automatic_component_waits_after_unsuccessful_first(setup, monkeypatch, outcome):
    service, updates, now = setup
    updates.configure({"xkeen": True, "xray": True, "time": "03:00"})
    now[0] += timedelta(minutes=1)
    updates.tick()
    first = updates.active()
    assert first["component"] == "xkeen"
    updates._step(updates.doc["operations"][first["id"]])
    monkeypatch.setattr(service.router, "update_status", lambda _: {**first, "phase": outcome})
    finish(updates)
    updates.tick()
    assert updates.active() is None
    assert [op["component"] for op in updates.status()["history"]] == ["xkeen"]

def test_slow_confirmed_install_extends_reserve_before_next_maintenance(setup, monkeypatch):
    service, updates, now = setup
    day = now[0].replace(hour=3, minute=45)
    assert not updates._conflict(day)
    inventory = service.router.update_inventory()
    inventory["last"] = {"id": new_id(), "action": "install", "component": "xray",
                         "version": "26.11.9", "phase": "installed", "duration_sec": 1200}
    monkeypatch.setattr(service.router, "update_inventory", lambda: inventory)
    updates._sync()
    assert updates.status()["maintenance_lead_minutes"] == 21
    restored = RouterUpdates(service, clock=lambda: now[0])
    assert restored._conflict(day)
    assert not restored._conflict(day.replace(minute=32))

def test_offline_restore_preserves_safe_runtime_details_in_history(setup, monkeypatch):
    service, updates, now = setup
    inv = service.router.update_inventory()
    inv["last"] = {"id": new_id(), "component": "xray", "version": "26.3.27", "action": "rollback",
                   "phase": "rolled_back_start_failed", "message": "SECRET",
                   "runtime": {"action": "restart", "control": "unavailable", "control_errno": 13,
                               "reason": ["SECRET"], "last_status": "stopped", "status_rc": 1,
                               "attempts": 15, "elapsed_sec": 45, "stderr": "SECRET"}}
    monkeypatch.setattr(service.router, "update_inventory", lambda: inv)
    updates._sync()
    view = RouterUpdates(service, clock=lambda: now[0]).status()
    message = view["history"][0]["message"]
    assert all(term in message for term in ("Previous files restored", "OS error 13", "stopped", "15 checks"))
    assert "SECRET" not in str(view)
    assert "SECRET" not in updates.path.read_text()

def pinned_operation(updates, now):
    when = now[0] + timedelta(minutes=1)
    updates.schedule({"component": "xray", "version": "26.10.31", "at": when.isoformat()})
    now[0] = when
    updates.tick()
    return updates.active()["id"]

@pytest.mark.parametrize("outage", ["ssh", "catalog", "download"])
def test_temporary_failure_retries_same_pin_then_installs(setup, monkeypatch, outage):
    service, updates, now = setup
    ident = pinned_operation(updates, now)
    with monkeypatch.context() as patch:
        def offline(*_):
            raise OSError("private details")
        if outage == "ssh":
            patch.setattr(service.router, "update_inventory", offline)
        elif outage == "catalog":
            patch.setattr(MockCatalog, "list_releases", offline)
        else:
            patch.setattr(MockCatalog, "payload", offline)
        assert updates._advance(updates.doc["operations"][ident])
        assert updates.active()["id"] == ident
        assert "Retrying" in updates.active()["message"]
        assert "private details" not in updates.active()["message"]
    now[0] += timedelta(seconds=31)
    finish(updates)
    assert updates.status()["history"][0]["phase"] == "installed"
    assert updates.status()["components"]["xray"]["installed"] == "26.10.31"

def test_day_outage_reports_missed_with_cause_without_submission(setup, monkeypatch):
    service, updates, now = setup
    ident = pinned_operation(updates, now)
    def offline(): raise RouterError("password must be redacted")
    monkeypatch.setattr(service.router, "update_inventory", offline)
    assert updates._advance(updates.doc["operations"][ident])
    now[0] += timedelta(minutes=10)
    updates._advance(updates.doc["operations"][ident])
    assert not updates.active()
    assert service.router.update_status(ident)["phase"] == "unknown"
    job = updates.status()["components"]["xray"]["schedule"]
    assert job["state"] == "missed" and "SSH" in job["reason"]

@pytest.mark.parametrize("change,detail", [("removed", "withdrawn"), ("digest", "checksum"), ("old", "no longer newer")])
def test_confirmed_pin_refusal_explains_release_specific_reason(setup, monkeypatch, change, detail):
    service, updates, now = setup
    ident = pinned_operation(updates, now)
    rows = MockCatalog.list_releases(None, {})
    if change == "removed":
        rows = [r for r in rows if r["version"] != "26.10.31"]
    if change == "digest":
        next(r for r in rows if r["version"] == "26.10.31")["sha256"] = "f" * 64
    if change == "old":
        service.router._software["versions"]["xray"] = "26.11.9"
    monkeypatch.setattr(MockCatalog, "list_releases", lambda *_: rows)
    updates._advance(updates.doc["operations"][ident])
    job = updates.status()["components"]["xray"]["schedule"]
    assert job["state"] == "failed" and detail in job["reason"]
    assert not updates.active()

def test_lost_accepted_record_never_reinstalls_and_recovers_from_verified_receipt(setup, monkeypatch):
    service, updates, _ = setup
    op = install(updates)
    ident = op["id"]
    updates._step(updates.doc["operations"][ident])
    updates._step(updates.doc["operations"][ident])
    assert updates.active()["phase"] == "accepted"
    send_count = len(service.router._software["steps"])
    receipt = service.router.update_status(ident)
    monkeypatch.setattr(service.router, "update_status", lambda _: {"id": ident, "phase": "unknown"})
    updates._advance(updates.doc["operations"][ident])
    assert updates.active()["phase"] == "journal_missing"
    updates.recover(ident)
    assert updates.active()["phase"] == "journal_missing"
    with pytest.raises(RoutingError):
        service.routing.ensure_idle()
    monkeypatch.setattr(service.router, "update_status", lambda _: {**receipt, "version": "7.0"})
    updates.recover(ident)
    assert updates.active()["phase"] == "journal_missing"
    monkeypatch.setattr(service.router, "update_status", lambda _: receipt)
    updates.recover(ident)
    assert not updates.active()
    assert updates.status()["history"][0]["phase"] == "installed"
    assert len(service.router._software["steps"]) == send_count

def test_router_rejection_preserves_finder_generation_and_existing_pin(setup, monkeypatch):
    service, updates, now = setup
    updates.schedule({"component": "xray", "version": "26.10.31", "at": (now[0] + timedelta(days=1)).isoformat()})
    original = updates.status()["components"]["xray"]["schedule"]
    generation = updates.generation()
    op = install(updates, cancel_schedule=True)
    ident = op["id"]
    updates._step(updates.doc["operations"][ident])
    response = {**op, "phase": "rejected"}
    inventory = service.router.update_inventory()
    inventory["last"] = response
    monkeypatch.setattr(service.router, "update_status", lambda _: response)
    monkeypatch.setattr(service.router, "update_inventory", lambda: inventory)
    finish(updates)
    assert updates.generation() == generation
    assert updates.status()["components"]["xray"]["schedule"] == original

@pytest.mark.parametrize("rc,stderr,exception,code", [
    (1, b"sshpass: invalid argument", RouterError, None),
    (2, b"sshpass: conflicting arguments", RouterError, None),
    (3, b"sshpass: runtime error", RouterError, None),
    (3, b"xk-update: Router busy; finish the active operation\n", RoutingError, "busy"),
    (1, b"xk-update: Scheduled installation window closed\n", RoutingError, "expired")
])
def test_transport_and_helper_refusals_are_distinct(monkeypatch, rc, stderr, exception, code):
    import subprocess
    router = Router("fixture.invalid", password="fixture")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess([], rc, b"", stderr))
    with pytest.raises(exception) as error:
        router._update_command(["recover", new_id()], None)
    assert getattr(error.value, "code", None) == code

def test_mock_multi_component_restore_holds_highest_removed_release(setup):
    _, updates, _ = setup
    install(updates, "xkeen", "2.1")
    finish(updates)
    for version in ("26.10.31", "26.11.9"):
        install(updates, version=version)
        finish(updates)
    view = updates.status()
    updates.start(dict(id=new_id(), component="xkeen", action="rollback", version="2.0",
                       plan=view["components"]["xkeen"]["rollback"], revision=view["rollback_revision"]))
    finish(updates)
    assert updates.status()["components"]["xray"]["held"] == "26.11.9"

def test_lost_ssh_before_admission_expires_on_router_and_preserves_old_version(setup, monkeypatch):
    service, updates, now = setup
    ident = pinned_operation(updates, now)
    updates._step(updates.doc["operations"][ident])
    def lost(*_): raise RouterError("No reply")
    with monkeypatch.context() as patch:
        patch.setattr(service.router, "update_submit", lost)
        assert updates._advance(updates.doc["operations"][ident])
    assert updates.active()["phase"] == "awaiting_receipt"
    now[0] += timedelta(minutes=10)
    assert not updates._advance(updates.doc["operations"][ident])
    assert not updates.active()
    assert updates.status()["components"]["xray"]["schedule"]["state"] == "missed"
    assert service.router.update_inventory()["components"]["xray"]["installed"] == "26.3.27"

def test_busy_and_maintenance_skips_give_a_reason_after_expiry(setup):
    _, updates, now = setup
    date = now[0].replace(hour=4, minute=0)
    updates.schedule({"component": "xray", "version": "26.10.31", "at": date.isoformat()})
    now[0] = date
    updates.tick()
    now[0] += timedelta(minutes=10)
    updates.tick()
    pin = updates.status()["components"]["xray"]["schedule"]
    assert pin["state"] == "missed" and "maintenance" in pin["reason"]
