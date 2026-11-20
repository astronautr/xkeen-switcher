"""Exercise grouped installs against the local router, clock and persistent journals."""
from datetime import datetime, timedelta

import pytest

from xk_switcher.router import RouterError
from xk_switcher.router_updates import MockCatalog, RouterUpdates
from xk_switcher.routing import RoutingError, new_id

from .test_router_updates import setup as update_service

VERSIONS = {"xkeen": "2.1", "xray": "26.10.31"}

def request_pair(at=None):
    body = {"id": new_id(), "versions": dict(VERSIONS)}
    if at is not None:
        body["at"] = at.isoformat()
    return body

def advance(updates):
    ident = updates.doc["active"]
    if ident:
        updates._advance(updates.doc["operations"][ident].copy())
    else:
        updates.tick()

def until(updates, predicate):
    for _ in range(16):
        if predicate():
            return
        advance(updates)
    pytest.fail(f"Unexpected update state: {updates.status()['pair']}")

def terminal(updates):
    until(updates, lambda: updates.status()["pair"]["state"] in {"installed", "missed", "failed", "cancelled"})
    return updates.status()["pair"]

def restarted(service, now):
    updates = RouterUpdates(service, clock=lambda: now[0])
    updates._wake = lambda: None
    service.router_updates = updates
    return updates

def test_one_confirmation_installs_both_in_order_with_individual_restore_points(update_service):
    _, updates, _ = update_service
    request = request_pair()
    updates.create_pair(request)
    result = terminal(updates)
    assert result["id"] == request["id"]
    assert result["versions"] == VERSIONS
    assert result["steps"] == {"xkeen": "installed", "xray": "installed"}
    assert result["state"] == "installed"
    final = updates.status()
    assert [(op["component"], op["phase"]) for op in reversed(final["history"])] == [
        ("xkeen", "installed"), ("xray", "installed")]
    assert final["components"]["xray"]["installed"] == "26.10.31"
    assert [row["component"] for row in final["components"]["xkeen"]["rollback"]] == ["xray", "xkeen"]

def test_worker_completes_pair_without_another_scheduler_tick(update_service):
    _, updates, _ = update_service
    del updates._wake  # Enable the same background worker that a dashboard request starts.
    try:
        updates.create_pair(request_pair())
        updates.worker.join(timeout=15)
        assert not updates.worker.is_alive()
        assert updates.status()["pair"]["steps"] == {"xkeen": "installed", "xray": "installed"}
    finally:
        updates.stop()

@pytest.mark.parametrize("field, bad", [
    ("versions", {"xkeen": "2.1"}), ("versions", {"xkeen": "2.1", "xray": "999.9"}),
    ("versions", {"xkeen": "2.1", "xray": "26.3.27"}), ("versions", {"xkeen": "2.1", "xray": []}),
    ("id", "unknown"), ("at", "2026-11-20T03:05:00"), ("at", "2000-01-01T03:05:00+03:00"),
])
def test_invalid_pair_leaves_no_single_install_or_schedule(update_service, field, bad):
    _, updates, _ = update_service
    with pytest.raises(RoutingError):
        updates.create_pair({**request_pair(), field: bad})
    assert updates.status()["pair"] is None and not updates.active()
    assert not updates.status()["history"]
    assert all(row["schedule"] is None for row in updates.status()["components"].values())

def test_both_artifact_hashes_must_exist_before_pair_is_reserved(update_service, monkeypatch):
    _, updates, _ = update_service
    releases = MockCatalog.list_releases(None, {})
    next(row for row in releases if row["version"] == VERSIONS["xray"])["sha256"] = ""
    monkeypatch.setattr(MockCatalog, "list_releases", lambda *_: releases)
    updates.refresh()
    with pytest.raises(RoutingError):
        updates.create_pair(request_pair())
    assert updates.status()["pair"] is None
    assert not updates.active() and not updates.status()["history"]

def test_reschedule_both_survives_restart_then_only_runs_at_revised_time(update_service):
    service, updates, now = update_service
    first = now[0] + timedelta(minutes=2)
    second = first + timedelta(minutes=5)
    request = request_pair(first)
    scheduled = updates.create_pair(request)["pair"]
    assert scheduled["state"] == "pending" and scheduled["steps"] == {"xkeen": "pending", "xray": "pending"}
    updates.reschedule_pair({"id": request["id"], "at": second.isoformat()})
    now[0] = first
    updates = restarted(service, now)
    updates.tick()
    assert not updates.active() and not updates.status()["history"]
    assert datetime.fromisoformat(updates.status()["pair"]["at"]) == second
    now[0] = second
    assert terminal(updates)["state"] == "installed"
    assert service.router.update_inventory()["components"]["xray"]["installed"] == VERSIONS["xray"]

def test_pending_pair_reserves_both_components_and_releases_them_after_cancel(update_service):
    service, updates, now = update_service
    updates.configure({"xkeen": True, "xray": True, "time": "03:00"})
    request = request_pair(now[0] + timedelta(hours=6))
    updates.create_pair(request)
    now[0] += timedelta(minutes=2)
    updates.tick()
    service.routing.ensure_idle()
    assert not updates.active() and updates.status()["pair"]["state"] == "pending"
    for component, version in VERSIONS.items():
        with pytest.raises(RoutingError):
            updates.start({"id": new_id(), "action": "install", "component": component,
                           "version": version, "cancel_schedule": True})
        with pytest.raises(RoutingError):
            updates.schedule({"component": component, "version": version, "at": request["at"]})
    assert not updates.status()["history"]
    assert updates.cancel_pair(request["id"])["pair"]["state"] == "cancelled"
    updates.start({"id": new_id(), "action": "install", "component": "xray", "version": VERSIONS["xray"]})
    assert updates.active()["component"] == "xray"

def test_pair_replay_never_overwrites_another_request_or_reinstalls(update_service):
    service, updates, now = update_service
    old = request_pair(now[0] + timedelta(hours=1))
    updates.create_pair(old)
    updates.create_pair(old.copy())
    with pytest.raises(RoutingError):
        updates.create_pair({**old, "versions": {**VERSIONS, "xray": "26.11.9"}})
    updates.cancel_pair(old["id"])
    new = request_pair()
    updates.create_pair(new)
    updates = restarted(service, now)
    assert updates.create_pair(old)["pair"]["id"] == new["id"]
    assert updates.cancel_pair(old["id"])["pair"]["id"] == new["id"]
    with pytest.raises(RoutingError):
        updates.reschedule_pair({"id": old["id"], "at": (now[0] + timedelta(hours=2)).isoformat()})
    assert terminal(updates)["state"] == "installed"
    updates.create_pair(new)
    assert len(service.router._software["steps"]) == 2
    assert not updates.active()

@pytest.mark.parametrize("when", ["scheduled", "now"])
def test_pair_keeps_existing_single_reservation_intact(update_service, when):
    _, updates, now = update_service
    date = now[0] + timedelta(hours=1)
    updates.schedule({"component": "xray", "version": "26.11.9", "at": date.isoformat()})
    before = updates.status()["components"]["xray"]["schedule"]
    with pytest.raises(RoutingError):
        updates.create_pair(request_pair(date if when == "scheduled" else None))
    assert updates.status()["components"]["xray"]["schedule"] == before
    assert updates.status()["pair"] is None and not updates.active()

def make_single_schedules(updates, now):
    for index, (component, version) in enumerate(VERSIONS.items()):
        updates.schedule({"component": component, "version": version,
                          "at": (now + timedelta(hours=index + 1)).isoformat()})
    return {name: row["schedule"] for name, row in updates.status()["components"].items()}

def confirmed_schedules(schedules):
    return {name: {"version": pin["version"], "at": pin["at"]} for name, pin in schedules.items()}

def test_new_pair_can_replace_both_specific_single_schedules_once(update_service):
    _, updates, now = update_service
    previous = make_single_schedules(updates, now[0])
    request = request_pair(now[0] + timedelta(minutes=4))
    request["replace_schedules"] = confirmed_schedules(previous)
    result = updates.create_pair(request)
    assert result["pair"]["id"] == request["id"]
    assert all(row["schedule"] is None for row in result["components"].values())
    assert updates.create_pair(request)["pair"] == result["pair"]
    now[0] += timedelta(minutes=4)
    assert terminal(updates)["state"] == "installed"

@pytest.mark.parametrize("change", ["rescheduled", "missing", "wrong_release", "unavailable_version"])
def test_replacement_refusal_preserves_every_single_schedule(update_service, change):
    _, updates, now = update_service
    previous = make_single_schedules(updates, now[0])
    request = request_pair(now[0] + timedelta(minutes=4))
    review = confirmed_schedules(previous)
    request["replace_schedules"] = review
    if change == "rescheduled":
        updates.schedule({"component": "xkeen", "version": "2.1", "at": (now[0] + timedelta(hours=3)).isoformat()})
    elif change == "missing":
        review.pop("xray")
    elif change == "wrong_release":
        review["xray"]["version"] = "26.11.9"
    else:
        request["versions"]["xray"] = "999.9"
    expected = {name: row["schedule"] for name, row in updates.status()["components"].items()}
    with pytest.raises(RoutingError):
        updates.create_pair(request)
    status = updates.status()
    assert status["pair"] is None and not updates.active()
    assert {name: row["schedule"] for name, row in status["components"].items()} == expected

@pytest.mark.parametrize("failure", ["rejected", "start_failed"])
def test_xray_and_daily_scheduler_wait_after_failed_first_step(update_service, monkeypatch, failure):
    service, updates, now = update_service
    updates.configure({"xkeen": True, "xray": True, "time": "03:00"})
    when = now[0] + timedelta(minutes=1)
    updates.create_pair(request_pair(when))
    now[0] = when
    submit = service.router.update_submit
    calls = []
    def fail_first(op, payload):
        calls.append(op["component"])
        if failure == "rejected":
            raise RoutingError("Router refused installation.", 409, "precondition")
        receipt = submit(op, payload)
        receipt["phase"] = failure
        return receipt
    monkeypatch.setattr(service.router, "update_submit", fail_first)
    final = terminal(updates)
    expected = "start_unconfirmed" if failure == "start_failed" else "failed"
    assert final["state"] == "failed" and final["steps"] == {"xkeen": expected, "xray": "skipped"}
    assert final["message"] and calls == ["xkeen"]
    updates.tick()
    assert not updates.active()
    assert all(op["component"] == "xkeen" for op in updates.status()["history"])

@pytest.mark.parametrize("succeeded", [True, False])
def test_pair_waits_for_runtime_verification_and_explains_the_outcome(update_service, monkeypatch, succeeded):
    service, updates, now = update_service
    updates.create_pair(request_pair())
    until(updates, lambda: (updates.active() or {}).get("phase") == "accepted")
    ident = updates.active()["id"]
    actual_status = service.router.update_status
    runtime = {"action": "restart", "control": "nonzero", "rc": 1, "last_status": "running",
               "status_rc": 0, "attempts": 2, "elapsed_sec": 3, "process": "unchanged",
               "reason": "other", "ready": False, "stderr_saved": True, "stderr": "SECRET"}
    receipt = {**actual_status(ident), "runtime": runtime, "phase": "installing", "message": "SECRET"}
    monkeypatch.setattr(service.router, "update_status", lambda i: receipt if i == ident else actual_status(i))
    advance(updates)
    active = updates.status()["operation"]
    assert active["id"] == ident and "exit code 1" in active["message"]
    assert "SECRET" not in active["message"]
    assert updates.status()["pair"]["steps"]["xray"] == "pending"
    receipt["phase"] = "installed" if succeeded else "start_failed"
    runtime.update(attempts=4, elapsed_sec=9, process="replaced" if succeeded else "unchanged", ready=succeeded)
    final = terminal(updates)
    assert final["steps"] == ({"xkeen": "installed", "xray": "installed"} if succeeded else
                              {"xkeen": "start_unconfirmed", "xray": "skipped"})
    view = restarted(service, now).status()
    message = next(op["message"] for op in view["history"] if op["id"] == ident)
    assert all(term in message for term in ("exit code 1", "running", "4 checks", "9 s"))
    assert f"/updates/operations/{ident}/" in message
    assert "SECRET" not in str(view)
    if not succeeded:
        assert message == final["message"]
        assert "same process" in message

def test_old_failed_pair_and_history_explain_only_the_matching_install(update_service):
    service, updates, now = update_service
    request = request_pair()
    updates.create_pair(request)
    ident = updates.active()["id"]
    legacy = "Software installed, but the service failed to start. Manual rollback is available."
    doc = updates.doc
    doc["active"] = None
    doc["operations"][ident].update(phase="start_failed", message=legacy)
    pair = doc["pairs"][request["id"]]
    pair.update(state="failed", steps={"xkeen": "failed", "xray": "skipped"}, message=legacy)
    updates._save(doc)
    view = restarted(service, now).status()
    assert view["pair"]["steps"]["xkeen"] == "start_unconfirmed"
    assert "did not record restart diagnostics" in view["pair"]["message"]
    assert "not confirmed" in view["history"][0]["message"]
    doc["operations"][ident]["pair_id"] = new_id()
    updates._save(doc)
    assert restarted(service, now).status()["pair"]["steps"]["xkeen"] == "failed"

def test_xray_release_replaced_after_xkeen_install_reports_partial_success(update_service, monkeypatch):
    service, updates, now = update_service
    request = request_pair(now[0] + timedelta(minutes=1))
    updates.create_pair(request)
    now[0] += timedelta(minutes=1)
    until(updates, lambda: service.router.update_inventory()["components"]["xkeen"]["installed"] == "2.1")
    releases = MockCatalog.list_releases(None, {})
    next(row for row in releases if row["version"] == VERSIONS["xray"])["sha256"] = "c" * 64
    monkeypatch.setattr(MockCatalog, "list_releases", lambda *_: releases)
    final = terminal(updates)
    assert final["state"] == "failed" and final["steps"] == {"xkeen": "installed", "xray": "failed"}
    assert final["message"]
    assert updates.status()["components"]["xkeen"]["rollback"][0]["to"] == "2.0"
    assert updates.status()["components"]["xray"]["installed"] == "26.3.27"

def test_xray_withdrawn_before_first_step_prevents_changes_to_either_component(update_service, monkeypatch):
    service, updates, now = update_service
    when = now[0] + timedelta(minutes=1)
    updates.create_pair(request_pair(when))
    releases = [row for row in MockCatalog.list_releases(None, {}) if row["version"] != VERSIONS["xray"]]
    monkeypatch.setattr(MockCatalog, "list_releases", lambda *_: releases)
    now[0] = when
    assert terminal(updates)["state"] == "failed"
    assert not service.router._software["steps"]

def test_local_xkeen_rollback_before_second_step_aborts_xray(update_service):
    service, updates, _ = update_service
    updates.create_pair(request_pair())
    until(updates, lambda: updates.status()["pair"]["steps"]["xkeen"] == "installed")
    router = service.router
    rollback = {"id": new_id(), "component": "xkeen", "action": "rollback", "from": "2.1", "version": "2.0",
                "revision": router.update_inventory()["revision"]}
    router.update_submit(rollback, None)
    final = terminal(updates)
    assert final["state"] == "failed" and final["steps"]["xray"] == "failed"
    assert updates.status()["components"]["xkeen"]["installed"] == "2.0"
    assert router.update_inventory()["components"]["xray"]["installed"] == "26.3.27"

def test_old_pair_honors_new_offline_hold_but_owner_can_explicitly_select_it_again(update_service):
    service, updates, now = update_service
    router = service.router
    when = now[0] + timedelta(minutes=1)
    updates.create_pair(request_pair(when))
    router.update_submit({"id": new_id(), "action": "install", "component": "xray", "from": "26.3.27",
                          "version": VERSIONS["xray"]}, b"xray")
    router.update_submit({"id": new_id(), "action": "rollback", "component": "xray", "from": VERSIONS["xray"],
                          "version": "26.3.27", "revision": router.update_inventory()["revision"]}, None)
    now[0] = when
    final = terminal(updates)
    assert final["state"] == "cancelled" and final["message"]
    assert final["steps"] == {"xkeen": "skipped", "xray": "skipped"}
    assert router.update_inventory()["held"]["xray"] == VERSIONS["xray"]
    assert not router._software["steps"]
    updates.create_pair(request_pair())
    assert terminal(updates)["state"] == "installed"
    assert router.update_inventory()["components"]["xray"]["installed"] == VERSIONS["xray"]

def test_successful_pair_owns_daily_occurrence_and_keeps_pinned_xray_until_next_day(update_service):
    _, updates, now = update_service
    when = now[0] + timedelta(minutes=1)
    updates.configure({"xkeen": True, "xray": True, "time": "03:00"})
    updates.create_pair(request_pair(when))
    now[0] = when
    assert terminal(updates)["state"] == "installed"
    updates.tick()
    assert not updates.active() and len(updates.status()["history"]) == 2
    assert updates.status()["components"]["xray"]["installed"] == VERSIONS["xray"]
    now[0] = when + timedelta(days=1)
    updates.tick()
    assert (updates.active()["component"], updates.active()["version"]) == ("xray", "26.11.9")

def test_single_install_lost_reply_during_pair_is_reconciled_after_restart(update_service, monkeypatch):
    service, updates, now = update_service
    submit = service.router.update_submit
    calls = []
    def lose_reply(op, payload):
        receipt = submit(op, payload)
        calls.append((op["component"], op["id"]))
        if len(calls) == 1:
            raise RouterError("SSH reply lost")
        return receipt
    monkeypatch.setattr(service.router, "update_submit", lose_reply)
    updates.create_pair(request_pair())
    until(updates, lambda: bool(calls))
    assert calls[0][0] == "xkeen" and updates.status()["pair"]["state"] == "running"
    updates = restarted(service, now)
    assert terminal(updates)["state"] == "installed"
    assert [name for name, _ in calls] == ["xkeen", "xray"]
    assert len({ident for _, ident in calls}) == 2
    assert len(service.router._software["steps"]) == 2

def test_ambiguous_first_receipt_blocks_handoff_and_other_mutations(update_service, monkeypatch):
    service, updates, _ = update_service
    request = request_pair()
    updates.create_pair(request)
    until(updates, lambda: (updates.active() or {}).get("phase") == "accepted")
    with monkeypatch.context() as patch:
        patch.setattr(service.router, "update_status", lambda ident: {"id": ident, "phase": "unknown"})
        advance(updates)
        assert updates.active()["phase"] == "journal_missing"
        assert updates.status()["pair"]["steps"]["xray"] == "pending"
        with pytest.raises(RoutingError):
            service.routing.ensure_idle()
        with pytest.raises(RoutingError):
            updates.cancel_pair(request["id"])
        with pytest.raises(RoutingError):
            updates.start({"id": new_id(), "action": "install", "component": "xray", "version": "26.11.9"})
        assert [r["component"] for r in service.router._software["steps"]] == ["xkeen"]
    updates.recover(updates.active()["id"])
    assert terminal(updates)["state"] == "installed"

def test_long_observed_first_install_still_runs_second_step_immediately(update_service, monkeypatch):
    service, updates, now = update_service
    when = now[0] + timedelta(minutes=1)
    updates.create_pair(request_pair(when))
    now[0] = when
    until(updates, lambda: (updates.active() or {}).get("phase") == "accepted")
    first = updates.active()
    with monkeypatch.context() as patch:
        patch.setattr(service.router, "update_status", lambda _: {**first, "phase": "installing"})
        now[0] += timedelta(minutes=14)
        advance(updates)
        assert updates.active()["phase"] == "installing"
    now[0] += timedelta(seconds=20)
    assert terminal(updates)["state"] == "installed"

def test_restart_hours_after_first_install_records_it_without_starting_xray(update_service):
    service, updates, now = update_service
    when = now[0] + timedelta(minutes=1)
    updates.create_pair(request_pair(when))
    now[0] = when
    until(updates, lambda: (updates.active() or {}).get("phase") == "accepted")
    now[0] += timedelta(hours=7)
    updates = restarted(service, now)
    final = terminal(updates)
    assert final["state"] == "missed"
    assert final["steps"] == {"xkeen": "installed", "xray": "skipped"}
    assert [row["component"] for row in service.router._software["steps"]] == ["xkeen"]

@pytest.mark.parametrize("delivered", [False, True])
def test_ambiguous_submit_crossing_maintenance_only_reconciles(update_service, monkeypatch, delivered):
    service, updates, now = update_service
    now[0] = now[0].replace(hour=3, minute=49, second=57)
    updates.create_pair(request_pair())
    advance(updates)
    submit = service.router.update_submit
    def lose_reply(op, payload):
        if delivered:
            submit(op, payload)
        raise RouterError("SSH connection lost")
    with monkeypatch.context() as patch:
        patch.setattr(service.router, "update_submit", lose_reply)
        advance(updates)
    assert updates.active()["phase"] == "awaiting_receipt"
    now[0] += timedelta(seconds=5)
    assert updates._conflict(now[0])
    with monkeypatch.context() as patch:
        patch.setattr(service.router, "update_submit", lambda *_: pytest.fail("Replay could start during maintenance"))
        advance(updates)
    if delivered:
        assert updates.status()["pair"]["steps"] == {"xkeen": "installed", "xray": "running"}
        assert [r["component"] for r in service.router._software["steps"]] == ["xkeen"]
    else:
        assert updates.active()["phase"] == "awaiting_receipt"
        assert not service.router._software["steps"]
        now[0] += timedelta(minutes=10)
        assert terminal(updates)["state"] == "missed"
        assert not service.router._software["steps"]
