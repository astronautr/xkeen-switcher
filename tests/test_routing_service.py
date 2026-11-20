import copy
import threading
import time
import pytest
from xk_switcher import routing
from xk_switcher.routing_store import RoutingStore
from xk_switcher.router import Router, MOCK_ROUTING, RouterError
from xk_switcher.service import Service
from xk_switcher.state import State

@pytest.fixture
def service(tmp_path):
    state=State(tmp_path);state.init({})
    instance = Service(state, Router("mock"))
    yield instance
    instance.routing.stop()

def draft_and_preview(service):
    r=service.routing;info=r.state();model=copy.deepcopy(info["model"])
    model["groups"][1]["title"]="Changed"
    draft=r.save_draft({"model":model,"expected_revision":None,"base_hash":info["current"]["sha256"]})
    preview=r.preview({"expected_current_hash":info["current"]["sha256"],"draft_revision":draft["revision"]})
    return info,draft,preview

def wait_result(r,op):
    for _ in range(100):
        result=r.store.operation(op["id"])
        if result["phase"] in ("committed","rolled_back","rejected","unknown","recovery_failed"):return result
        time.sleep(.01)
    pytest.fail("Operation did not finish")

def test_routing_apply_preserves_outbound_and_checks_after_commit(service):
    from .test_service import _sample_loc, _seed_sub, _subscription_bytes, _attach_route_checker, _route_result
    _seed_sub(service.state, [_sample_loc("fi", host="old.example")])
    service.state.write_state({"active_code": "fi", "subscription_url": "https://sub.example"})
    _, _, preview = draft_and_preview(service)
    service.fetch_fn = lambda url: _subscription_bytes([_sample_loc("fi", host="fresh.example")])
    checks = []
    def check():
        assert "fresh.example" not in str(service.router.read_outbound())
        assert service.routing.store.operations()[-1]["phase"] == "committed"
        checks.append(True)
        return _route_result(True)
    _attach_route_checker(service, check)
    request = {"preview_id": preview["id"], "operation_id": routing.new_id()}
    result = wait_result(service.routing, service.routing.apply(request))
    assert result["phase"] == "committed", result
    for _ in range(200):
        if checks and service.status()["server_route"]["check"]:
            break
        time.sleep(.01)
    assert checks == [True]
    assert service.status()["server_route"]["check"]["ok"]
    assert service.routing.apply(request)["id"] == result["id"]
    assert checks == [True]

def test_routing_edit_does_not_depend_on_subscription_availability(service):
    from .test_service import _sample_loc, _seed_sub
    _seed_sub(service.state, [_sample_loc("fi")])
    service.state.write_state({"active_code": "fi", "subscription_url": "https://sub.example"})
    _, _, preview = draft_and_preview(service)
    before = service.router.read_bundle()
    def offline(url):
        raise RuntimeError("provider unavailable")
    service.fetch_fn = offline
    result = wait_result(service.routing, service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()}))
    assert result["phase"] == "committed"
    after = service.router.read_bundle()
    assert after["04_outbounds.json"] == before["04_outbounds.json"]
    assert service.routing.store.read("draft.json") is None

def test_apply_restore_preserves_exact_original_bytes(service):
    raw=MOCK_ROUTING.replace(b"\n",b"\r\n")+b"\r\n\r\n"
    service.router._mock_routing=raw
    info,draft,p=draft_and_preview(service);r=service.routing
    result=wait_result(r,r.apply({"preview_id":p["id"],"operation_id":routing.new_id()}))
    assert result["phase"]=="committed"
    assert r.store.read("draft.json") is None
    original=next(m for m in r.store.history() if m["original"])
    assert r.store.blob("snapshots",original["id"])[1]==raw
    assert r.state()["model"]["groups"][1]["id"]==info["model"]["groups"][1]["id"]
    current=r.state()["current"]
    p=r.preview({"intent":"restore","expected_current_hash":current["sha256"],"snapshot_id":original["id"]})
    result=wait_result(r,r.apply({"preview_id":p["id"],"operation_id":routing.new_id()}))
    assert result["phase"]=="committed" and service.router.read_routing()==raw
    assert [g["id"] for g in r.state()["model"]["groups"]]==[g["id"] for g in info["model"]["groups"]]

def test_backup_failure_prevents_any_router_write(service,monkeypatch):
    _,_,p=draft_and_preview(service)
    monkeypatch.setattr(service.routing,"_snapshot",lambda *a,**k:(_ for _ in ()).throw(OSError("disk full")))
    result=wait_result(service.routing,service.routing.apply({"preview_id":p["id"],"operation_id":routing.new_id()}))
    assert result["phase"]=="rejected"
    assert service.router.read_routing()==MOCK_ROUTING and not service.router._mock_operations
    assert service.routing.store.read("draft.json")

def test_raw_snapshot_survives_failed_parse(service):
    service.router._mock_routing=b'/* bad config'
    info=service.routing.state()
    assert info["parse_error"] and info["model"] is None
    original=next(m for m in service.routing.store.history() if m["original"])
    assert service.routing.store.blob("snapshots",original["id"])[1]==b'/* bad config'

def test_stale_draft_preview_and_manual_router_edit_conflict(service):
    info,draft,p=draft_and_preview(service);r=service.routing
    with pytest.raises(routing.RoutingError) as error:
        r.save_draft({"model":draft["model"],"expected_revision":None,"base_hash":draft["base_hash"]})
    assert error.value.status==409
    changed=copy.deepcopy(draft["model"]);changed["groups"][1]["title"]="Changed again"
    new=r.save_draft({"model":changed,"expected_revision":draft["revision"],"base_hash":draft["base_hash"]})
    with pytest.raises(routing.RoutingError):r.apply({"preview_id":p["id"],"operation_id":routing.new_id()})
    service.router._mock_routing+=b"\n// manual\n"
    with pytest.raises(routing.RoutingError):r.preview({"expected_current_hash":info["current"]["sha256"],"draft_revision":new["revision"]})
    assert service.router.read_routing().endswith(b"// manual\n")

def test_unchanged_configuration_does_not_create_draft(service):
    r=service.routing;info=r.state()
    result=r.save_draft({"model":info["model"],"expected_revision":None,"base_hash":info["current"]["sha256"]})
    assert result is None
    assert r.state()["draft"] is None
    assert not (r.store.root / "draft.json").exists()
    assert service.router.read_routing()==MOCK_ROUTING and not service.router._mock_operations

@pytest.mark.parametrize("change", ["title", "action", "matchers", "order"])
def test_reverting_last_saved_change_clears_draft_and_invalidates_preview(service, change):
    r=service.routing;info=r.state();model=copy.deepcopy(info["model"])
    if change=="title": model["groups"][1]["title"]="Changed"
    elif change=="action": model["groups"][-1]["action"]="direct"
    elif change=="matchers": model["groups"][1]["matchers"].append({"type":"domain-suffix","value":"example.org"})
    else: model["groups"][1:3]=reversed(model["groups"][1:3])
    body={"model":model,"expected_revision":None,"base_hash":info["current"]["sha256"]}
    draft=r.save_draft(body)
    preview=r.preview({"expected_current_hash":body["base_hash"],"draft_revision":draft["revision"]})
    body.update(model=info["model"],expected_revision=draft["revision"])
    assert r.save_draft(body) is None
    assert Service(service.state,service.router).routing.state()["draft"] is None
    with pytest.raises(routing.RoutingError,match="draft changed"):
        r.apply({"preview_id":preview["id"],"operation_id":routing.new_id()})
    assert service.router.read_routing()==MOCK_ROUTING and not service.router._mock_operations
    original=r.store.read("original.json")["id"]
    assert r.store.blob("snapshots",original)[1]==MOCK_ROUTING

def test_reverting_one_rule_preserves_other_edits_and_same_draft_revision(service):
    r=service.routing;info=r.state();model=copy.deepcopy(info["model"])
    model["groups"][1]["title"]="Keep this change"
    model["groups"][-1]["action"]="direct"
    body={"model":model,"expected_revision":None,"base_hash":info["current"]["sha256"]}
    first=r.save_draft(body)
    model["groups"][-1]=copy.deepcopy(info["model"]["groups"][-1])
    body["expected_revision"]=first["revision"]
    kept=r.save_draft(body)
    preview=r.preview({"expected_current_hash":body["base_hash"],"draft_revision":kept["revision"]})
    assert [c["id"] for c in preview["changes"]]==[model["groups"][1]["id"]]
    body["expected_revision"]=kept["revision"]
    assert r.save_draft(body)==kept
    r._check_preview(preview)
    # An unchanged request must still respect revision and base-version checks.
    for patch in ({"expected_revision":first["revision"]}, {"base_hash":"stale"}):
        with pytest.raises(routing.RoutingError): r.save_draft({**body,"model":info["model"],**patch})
    assert r.state()["draft"]==kept

def test_invalid_draft_is_saved_but_not_applied(service):
    r=service.routing;info=r.state();m=info["model"];m["groups"][1]["matchers"]=[{"type":"source","value":"invalid-address"}]
    draft=r.save_draft({"model":m,"expected_revision":None,"base_hash":info["current"]["sha256"]})
    assert draft["validation"]
    with pytest.raises(routing.RoutingError):r.preview({"expected_current_hash":info["current"]["sha256"],"draft_revision":draft["revision"]})

def test_selective_proxy_with_direct_default_survives_apply_and_reload(service):
    from xk_switcher import jsonc
    r=service.routing;info=r.state();model=copy.deepcopy(info["model"])
    model["groups"][-1]["action"]="direct"
    draft=r.save_draft({"model":model,"base_hash":info["current"]["sha256"],"expected_revision":None})
    preview=r.preview({"expected_current_hash":info["current"]["sha256"],"draft_revision":draft["revision"]})
    assert preview["changes"][0]["fields"]==["action"]
    assert wait_result(r,r.apply({"preview_id":preview["id"],"operation_id":routing.new_id()}))["phase"]=="committed"
    raw=service.router.read_routing();rules=jsonc.loads(raw.decode())["routing"]["rules"]
    assert rules[2]["outboundTag"]=="vless-reality"
    assert rules[-1]["outboundTag"]=="direct"
    r=Service(service.state,service.router).routing
    reloaded=r.state()
    assert not reloaded["model"]["issues"]
    assert reloaded["model"]["groups"][-1]["id"]==model["groups"][-1]["id"]
    assert reloaded["model"]["groups"][-1]["editable"]
    removed=copy.deepcopy(reloaded["model"]);removed["groups"].pop()
    with pytest.raises(routing.RoutingError,match="cannot be deleted"):
        r.save_draft({"model":removed,"base_hash":reloaded["current"]["sha256"],"expected_revision":None})
    reloaded["model"]["groups"][1]["title"]="Next edit"
    next_draft=r.save_draft({"model":reloaded["model"],"base_hash":reloaded["current"]["sha256"],"expected_revision":None})
    r.preview({"expected_current_hash":reloaded["current"]["sha256"],"draft_revision":next_draft["revision"]})
    original=r.store.read("original.json")["id"]
    assert r.store.blob("snapshots",original)[1]==MOCK_ROUTING

def test_legacy_projection_is_refreshed_without_changing_backup_or_draft_revision(tmp_path):
    model=routing.parse(MOCK_ROUTING)
    for group in model["groups"]:group.pop("default_rule")
    model["groups"][-1]["locked"]=True
    model["issues"]=["Для редактирования нужен последний fallback → vless-reality для redirect/tproxy. Исходный файл доступен в истории."]
    store=RoutingStore(tmp_path);meta=store.save_blob("snapshots",MOCK_ROUTING,{"source":"initial-import"},model)
    metadata=store.path("snapshots",meta["id"])/"metadata.json";before=metadata.read_bytes()
    loaded,raw=store.blob("snapshots",meta["id"])
    assert not loaded["model"]["issues"] and "locked" not in loaded["model"]["groups"][-1]
    assert loaded["model"]["groups"][-1]["default_rule"]
    assert raw==MOCK_ROUTING and metadata.read_bytes()==before
    revision=routing.new_id()
    store.write("draft.json",{"revision":revision,"model":model,"validation":[{"severity":"error","message":"Old fallback constraint"}]})
    draft=store.read("draft.json")
    assert draft["revision"]==revision and not draft["validation"]

def test_default_deletion_guard_survives_condition_change_and_apply(service):
    r=service.routing;info=r.state();model=copy.deepcopy(info["model"])
    model["groups"][-1]["matchers"]=[{"type":"domain-suffix","value":"example.org"}]
    draft=r.save_draft({"model":model,"base_hash":info["current"]["sha256"],"expected_revision":None})
    preview=r.preview({"expected_current_hash":info["current"]["sha256"],"draft_revision":draft["revision"]})
    assert wait_result(r,r.apply({"preview_id":preview["id"],"operation_id":routing.new_id()}))["phase"]=="committed"
    state=r.state()
    assert state["model"]["groups"][-1]["default_rule"]
    assert not state["model"]["groups"][-1]["catch_all"]
    state["model"]["groups"].pop()
    with pytest.raises(routing.RoutingError,match="cannot be deleted"):
        r.save_draft({"model":state["model"],"base_hash":state["current"]["sha256"],"expected_revision":None})

@pytest.mark.parametrize("revert", [False, True])
def test_new_draft_survives_apply_and_idempotent_retry(service,monkeypatch,revert):
    info,draft,p=draft_and_preview(service);r=service.routing
    entered=threading.Event();release=threading.Event();original=service.router.start_routing
    def start(*args):
        entered.set();assert release.wait(3);return original(*args)
    monkeypatch.setattr(service.router,"start_routing",start)
    op=r.apply({"preview_id":p["id"],"operation_id":routing.new_id()});assert entered.wait(3)
    updated=copy.deepcopy(draft["model"])
    updated["groups"][1]["title"]=info["model"]["groups"][1]["title"] if revert else "Newer draft"
    newer=r.save_draft({"model":updated,"expected_revision":draft["revision"],"base_hash":draft["base_hash"]})
    release.set();assert wait_result(r,op)["phase"]=="committed"
    assert r.store.read("draft.json")["revision"]==newer["revision"]
    assert r.apply({"preview_id":p["id"],"operation_id":op["id"]})["id"]==op["id"]
    assert len(service.router._mock_operations)==1

def test_lost_reply_reconciles_committed_remote_operation(service,monkeypatch):
    _,_,p=draft_and_preview(service);r=service.routing;start=service.router.start_routing
    def lost(*args):start(*args);raise RouterError("lost reply")
    monkeypatch.setattr(service.router,"start_routing",lost)
    op=r.apply({"preview_id":p["id"],"operation_id":routing.new_id()})
    assert wait_result(r,op)["phase"]=="unknown"
    r.recover()
    assert wait_terminal(r, op)["phase"]=="committed"
    assert len(service.router._mock_operations)==1

def test_lost_request_retries_same_immutable_operation(service,monkeypatch):
    _,_,p=draft_and_preview(service);r=service.routing;start=service.router.start_routing
    monkeypatch.setattr(service.router,"start_routing",lambda *args:(_ for _ in ()).throw(RouterError("connection lost before send")))
    op=r.apply({"preview_id":p["id"],"operation_id":routing.new_id()})
    assert wait_result(r,op)["phase"]=="unknown"
    assert not service.router._mock_operations
    monkeypatch.setattr(service.router,"start_routing",start)
    r.recover()
    assert wait_terminal(r, op)["phase"]=="committed"
    assert set(service.router._mock_operations)=={op["id"]}

def test_readback_failure_is_unknown_not_success(service,monkeypatch):
    _,_,p=draft_and_preview(service);r=service.routing
    monkeypatch.setattr(service.router,"routing_health",lambda:"unknown")
    op=r.apply({"preview_id":p["id"],"operation_id":routing.new_id()})
    assert wait_result(r,op)["phase"]=="unknown"
    assert r.store.read("draft.json")
    with pytest.raises(routing.RoutingError):r.ensure_idle()

def test_rollback_requires_fresh_health_confirmation(service,monkeypatch):
    _,_,p=draft_and_preview(service);r=service.routing
    def rollback(ident,*args):
        service.router._mock_operations[ident]={"phase":"rolled_back","before_state":"running"}
        service.router._mock_xkeen="unknown"
    monkeypatch.setattr(service.router,"start_routing",rollback)
    op=r.apply({"preview_id":p["id"],"operation_id":routing.new_id()})
    assert wait_result(r,op)["phase"]=="unknown"
    assert service.router.read_routing()==MOCK_ROUTING
    assert r.store.read("draft.json")
    service.router._mock_xkeen="running"
    r.recover()
    assert wait_terminal(r, op)["phase"]=="rolled_back"

def test_retention_preserves_original_current_and_draft_base(tmp_path,monkeypatch):
    import xk_switcher.routing_store as module
    monkeypatch.setattr(module,"HISTORY_CAP",2)
    store=RoutingStore(tmp_path);original=store.save_blob("snapshots",b"original",{"source":"initial-import"})
    store.write("original.json",{"id":original["id"]})
    store.write("draft.json",{"base_snapshot":original["id"]})
    for i in range(5):last=store.save_blob("snapshots",str(i).encode(),{"source":"apply"})
    store.write("current.json",{"id":last["id"]})
    store.prune()
    assert len(store.history())==4
    assert store.blob("snapshots",original["id"])[1]==b"original"
    (store.path("snapshots",last["id"])/"config.jsonc").write_bytes(b"corrupt")
    with pytest.raises(routing.RoutingError):store.blob("snapshots",last["id"])

def test_mock_router_survives_restart(tmp_path):
    first=Router("mock",mock_data_dir=tmp_path)
    ident=routing.new_id();candidate=MOCK_ROUTING+b'\n// persisted\n'
    first.start_routing(ident,routing.digest(MOCK_ROUTING),first.routing_environment(),candidate)
    first.run_xkeen("stop")
    second=Router("mock",mock_data_dir=tmp_path)
    assert second.read_routing()==candidate
    assert second.routing_operation(ident)["phase"]=="committed"
    assert second.routing_health()=="stopped"

def test_unknown_routing_blocks_other_router_mutations(service):
    from xk_switcher.routing_store import now
    service.routing.store.put_operation({"id":routing.new_id(),"phase":"unknown","created_at":now(),"preview_id":routing.new_id()})
    for action in (lambda:service.switch("de"),lambda:service.xkeen_control("stop"),
                   lambda:service.update(),lambda:service.apply_failover("de", reason="failover-switch"),
                   service.handle_total_failure,service.apply_pending_reapply,
                   service.apply_pending_reapply_now,service.recover_pending_active,
                   lambda:service.set_subscription_url("https://example.invalid/sub")):
        with pytest.raises(routing.RoutingError) as error:action()
        assert error.value.code=="busy"
    assert service.router.routing_health()=="running"

def test_control_rejects_conflict_without_queueing_another_mutation(service,monkeypatch):
    _,_,p=draft_and_preview(service);r=service.routing
    entered=threading.Event();release=threading.Event();controlled=threading.Event()
    start=service.router.start_routing;control=service.router.run_xkeen
    def blocked_start(*args):
        entered.set();assert release.wait(5);start(*args)
    def observed_control(action):controlled.set();return control(action)
    monkeypatch.setattr(service.router,"start_routing",blocked_start)
    monkeypatch.setattr(service.router,"run_xkeen",observed_control)
    op=r.apply({"preview_id":p["id"],"operation_id":routing.new_id()})
    assert entered.wait(3)
    began = time.monotonic()
    with pytest.raises(routing.RoutingError, match="Wait for"):
        service.xkeen_control("stop")
    assert time.monotonic() - began < .5
    assert not controlled.is_set()
    assert r.public_operation()["id"] == op["id"]
    release.set()
    assert wait_terminal(r, op)["phase"] == "committed"
    assert service.router.routing_health() == "running"

def wait_terminal(r, op, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = r.store.operation(op["id"])
        if result["phase"] in {"committed", "rolled_back", "rejected"}:
            return result
        time.sleep(.01)
    pytest.fail(f"Operation did not converge without browser polling: {result}")

def test_lost_acceptance_reply_converges_without_status_requests(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    original = service.router.start_routing
    calls = []
    def lost_reply(*args):
        calls.append(args[0])
        original(*args)
        raise RouterError("SSH acceptance timed out after remote commit")
    monkeypatch.setattr(service.router, "start_routing", lost_reply)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert calls == [op["id"]]

def test_operation_get_does_not_launch_recovery(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    from xk_switcher.routing_store import now
    op = {"id": routing.new_id(), "preview_id": preview["id"], "phase": "unknown", "created_at": now()}
    service.routing.store.put_operation(op)
    calls = []
    monkeypatch.setattr(service.routing, "_work", lambda *args, **kwargs: calls.append(args))
    assert service.routing.operation(op["id"])["phase"] == "unknown"
    assert calls == []
    assert service.routing.store.operation(op["id"]) == op

def test_transient_status_errors_reconcile_automatically(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    original = service.router.routing_operation
    calls = []
    def status(ident):
        calls.append(ident)
        if len(calls) <= 2:
            raise RouterError("status temporarily unavailable")
        return original(ident)
    monkeypatch.setattr(service.router, "routing_operation", status)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert len(calls) == 3
    assert len(service.router._mock_operations) == 1

def test_partial_remote_metadata_never_resubmits(service, monkeypatch):
    import xk_switcher.routing_service as module
    monkeypatch.setattr(module, "POLL_INTERVAL", .01)
    _, _, preview = draft_and_preview(service)
    original = service.router.routing_operation
    start = service.router.start_routing
    statuses, starts = [], []
    def partial(ident):
        statuses.append(ident)
        if len(statuses) < 3:
            return {"phase": "preparing", "message": "Acceptance metadata incomplete"}
        return original(ident)
    def counted(*args):
        starts.append(args[0])
        return start(*args)
    monkeypatch.setattr(service.router, "routing_operation", partial)
    monkeypatch.setattr(service.router, "start_routing", counted)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert starts == [op["id"]]

def test_finalization_after_crash_is_idempotent_and_keeps_completion_time(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    original = service.state.append_history_once
    timestamps = []
    def interrupted(entry):
        timestamps.append(service.state.read_state()["last_apply_at"])
        original(entry)
        if len(timestamps) == 1:
            raise OSError("process interrupted after history was durable")
    monkeypatch.setattr(service.state, "append_history_once", interrupted)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert len(timestamps) == 2 and timestamps[0] == timestamps[1]
    assert len([entry for entry in service.state.read_history(100) if entry.get("operation_id") == op["id"]]) == 1
    assert len(service.router._mock_operations) == 1

def test_failed_diagnostic_does_not_make_committed_apply_unknown(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    entered = threading.Event()
    def diagnostic():
        entered.set()
        raise RouterError("route check timed out")
    monkeypatch.setattr(service, "check_after_apply", diagnostic)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert entered.wait(1)
    for _ in range(100):
        result = service.routing.operation(op["id"])
        if result.get("diagnostics", {}).get("phase") == "failed":
            break
        time.sleep(.01)
    assert result["phase"] == "committed"
    assert result["diagnostics"]["phase"] == "failed"
    assert service.routing.public_operation() is None

def test_startup_reconciliation_of_legacy_unknown_is_nonblocking(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    original = service.router.start_routing
    def lost(*args):
        original(*args)
        raise RouterError("lost")
    monkeypatch.setattr(service.router, "start_routing", lost)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_result(service.routing, op)["phase"] == "unknown"
    service.routing.stop()
    doc = service.routing.store.operation(op["id"])
    doc.pop("submitted_at")  # Records created before this release did not have this field.
    service.routing.store.put_operation(doc)
    replacement = Service(service.state, service.router).routing
    status_started = threading.Event()
    release = threading.Event()
    original_status = service.router.routing_operation
    def delayed_status(ident):
        status_started.set()
        assert release.wait(3)
        return original_status(ident)
    monkeypatch.setattr(service.router, "routing_operation", delayed_status)
    try:
        start_time = time.monotonic()
        replacement.recover()
        assert time.monotonic() - start_time < .5
        assert status_started.wait(1)
        for _ in range(5):
            replacement.recover()
        assert len(replacement._workers) == 1
        assert replacement.public_operation()["id"] == op["id"]
        release.set()
        assert wait_terminal(replacement, op)["phase"] == "committed"
        assert len(service.router._mock_operations) == 1
    finally:
        release.set()
        replacement.stop()

def seed_main(service):
    from .test_service import _sample_loc, _seed_sub, _subscription_bytes
    locations = [_sample_loc("fi"), _sample_loc("de", host="de.example")]
    _seed_sub(service.state, locations)
    service.state.write_state({"active_code": "fi", "subscription_url": "https://sub.example"})
    service.fetch_fn = lambda url: _subscription_bytes(locations)

def test_main_intent_is_durable_and_visible_before_preparation_io(service, monkeypatch):
    seed_main(service)
    entered, release = threading.Event(), threading.Event()
    original = service.prepare_main_operation
    def preparing(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(service, "prepare_main_operation", preparing)
    ident = routing.new_id()
    began = time.monotonic()
    op = service.routing.submit_main("de", ident)
    assert time.monotonic() - began < .5
    assert entered.wait(1)
    started = time.monotonic()
    public = service.routing.public_operation()
    assert time.monotonic() - started < .5
    assert public["target_code"] == "de" and public["blocking"]
    assert public["target_name"]
    assert "preview_id" not in service.routing.store.operation(ident)
    assert service.routing.submit_main("de", ident)["id"] == ident
    with pytest.raises(routing.RoutingError, match="already in use"):
        service.routing.submit_main("fi", ident)
    with pytest.raises(routing.RoutingError) as busy:
        service.routing.submit_main("fi", routing.new_id())
    assert busy.value.code == "busy"
    release.set()
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert service.state.read_state()["active_code"] == "de"
    assert len(service.router._mock_operations) == 1

def test_main_lost_reply_preserves_draft_and_reconciles_all_success_effects(service, monkeypatch):
    seed_main(service)
    _, draft, _ = draft_and_preview(service)
    current = service.routing.store.read("current.json")
    snapshots = service.routing.store.history()
    original = service.router.start_bundle
    def lost_reply(*args):
        original(*args)
        raise RouterError("acceptance reply lost")
    monkeypatch.setattr(service.router, "start_bundle", lost_reply)
    op = service.routing.submit_main("de", routing.new_id())
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    state = service.state.read_state()
    assert state["active_code"] == "de" and state["xkeen_state"] == "running"
    assert state["applied_main_fingerprint"]
    assert state["applied_main_config_hashes"]["without_sni"]
    assert service.routing.store.read("current.json") == current
    assert service.routing.store.read("draft.json") == draft
    assert service.routing.store.history() == snapshots
    history = [entry for entry in service.state.read_history(100) if entry.get("operation_id") == op["id"]]
    assert len(history) == 1 and history[0]["action"] == "switch" and history[0]["code"] == "de"
    assert len(service.router._mock_operations) == 1

def test_accepted_main_recovers_after_restart_before_preparation(service):
    from xk_switcher.routing_store import now
    seed_main(service)
    op = {"id": routing.new_id(), "kind": "main", "target_code": "de", "trigger": "manual",
          "created_at": now(), "phase": "accepted", "message": "Preparing Main location"}
    service.routing.store.put_operation(op)
    replacement = Service(service.state, service.router, fetch_fn=service.fetch_fn)
    try:
        replacement.routing.recover()
        assert wait_terminal(replacement.routing, op)["phase"] == "committed"
        assert service.state.read_state()["active_code"] == "de"
    finally:
        replacement.routing.stop()

def test_main_retry_reuses_frozen_candidate_after_subscription_changes(service, monkeypatch):
    from .test_service import _sample_loc, _seed_sub
    seed_main(service)
    original = service.router.start_bundle
    attempts = []
    def lost_before_send(*args):
        attempts.append(args)
        if len(attempts) == 1:
            raise RouterError("request did not reach SSH")
        return original(*args)
    monkeypatch.setattr(service.router, "start_bundle", lost_before_send)
    op = service.routing.submit_main("de", routing.new_id())
    assert wait_result(service.routing, op)["phase"] == "unknown"
    _seed_sub(service.state, [_sample_loc("fi"), _sample_loc("de", host="changed-after-submit.example")])
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert len(attempts) == 2
    assert attempts[0] == attempts[1]
    assert "changed-after-submit.example" not in str(service.router.read_outbound())

def test_status_does_not_wait_for_reimport_router_read(service, monkeypatch):
    state = service.routing.state()
    entered, release = threading.Event(), threading.Event()
    original = service.router.read_routing
    def delayed():
        entered.set()
        assert release.wait(3)
        return original()
    monkeypatch.setattr(service.router, "read_routing", delayed)
    thread = threading.Thread(target=service.routing.reimport, args=({
        "expected_current_hash": state["current"]["sha256"], "observed_hash": state["observed_hash"]},))
    thread.start()
    try:
        assert entered.wait(1)
        began = time.monotonic()
        activity = service.routing.public_operation()
        assert activity["ephemeral"] and activity["blocking"] and activity["id"] is None
        assert time.monotonic() - began < .5
    finally:
        release.set()
        thread.join(3)
    assert not thread.is_alive()

def test_rejection_before_remote_health_capture_uses_verified_preview_health(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    def reject(ident, *args):
        service.router._mock_operations[ident] = {"phase": "rejected", "before_state": "unknown",
                                                  "message": "Candidate validation rejected"}
    monkeypatch.setattr(service.router, "start_routing", reject)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "rejected"
    assert service.routing.public_operation() is None
    assert service.router.read_routing() == MOCK_ROUTING

def test_legacy_remote_prepared_phase_is_reconciled_without_rechecking_edited_draft(service, monkeypatch):
    _, draft, preview = draft_and_preview(service)
    monkeypatch.setattr(service.routing, "_launch", lambda ident: None)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    metadata, candidate = service.routing.store.blob("previews", preview["id"])
    service.router.start_routing(op["id"], metadata["base_hash"], metadata["environment"], candidate)
    op.update(phase="prepared", before_snapshot=metadata["base_snapshot"])
    service.routing.store.put_operation(op)
    model = copy.deepcopy(draft["model"])
    model["groups"][1]["title"] = "Newer work in another browser"
    new_draft = service.routing.save_draft({"model": model, "expected_revision": draft["revision"],
                                           "base_hash": draft["base_hash"]})
    replacement = Service(service.state, service.router).routing
    try:
        replacement.recover()
        assert wait_terminal(replacement, op)["phase"] == "committed"
        assert replacement.store.read("draft.json")["revision"] == new_draft["revision"]
        assert len(service.router._mock_operations) == 1
    finally:
        replacement.stop()

def test_concurrent_identical_main_requests_return_one_durable_handle(service, monkeypatch):
    seed_main(service)
    preparing, release = threading.Event(), threading.Event()
    original = service.prepare_main_operation
    def delayed(*args, **kwargs):
        preparing.set()
        assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(service, "prepare_main_operation", delayed)
    barrier = threading.Barrier(3)
    ident = routing.new_id()
    results, failures = [], []
    def request():
        barrier.wait()
        try:
            results.append(service.routing.submit_main("de", ident))
        except Exception as error:
            failures.append(error)
    threads = [threading.Thread(target=request) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    try:
        for thread in threads:
            thread.join(1)
        assert not failures
        assert len(results) == 2
        assert {result["id"] for result in results} == {ident}
        assert preparing.wait(1)
    finally:
        release.set()
    assert wait_terminal(service.routing, results[0])["phase"] == "committed"
    assert len(service.router._mock_operations) == 1

def test_transient_journal_failure_does_not_orphan_remote_commit(service, monkeypatch):
    _, _, preview = draft_and_preview(service)
    original_start = service.router.start_routing
    original_write = service.routing.store.put_operation
    failed = []
    def lost(*args):
        original_start(*args)
        raise RouterError("lost reply")
    def journal(op):
        if op["phase"] == "unknown" and not failed:
            failed.append(True)
            raise OSError("temporary journal error")
        return original_write(op)
    monkeypatch.setattr(service.router, "start_routing", lost)
    monkeypatch.setattr(service.routing.store, "put_operation", journal)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert failed == [True]
    assert len(service.router._mock_operations) == 1

def test_lost_synchronous_control_apply_reconciles_target_and_runs_diagnostics(service, monkeypatch):
    from xk_switcher.outbound import build
    seed_main(service)
    original = service.router.start_bundle
    diagnosed = threading.Event()
    def lost(*args):
        original(*args)
        raise RouterError("lost reply during restart")
    monkeypatch.setattr(service.router, "start_bundle", lost)
    monkeypatch.setattr(service, "check_after_apply", lambda: diagnosed.set())
    location = service._find_location("de")
    service.routing.state()
    bundle_id, environment = service.device_locations.prepare(service.router.read_routing(),
        main=build(location), main_only=True, state_patch=service._main_state_patch(location, "manual"),
        history={"action": "xkeen-control", "trigger": "manual", "code": "restart"})
    op = service.routing.apply_bundle(bundle_id=bundle_id, environment=environment, synchronous=True)
    assert op["phase"] == "unknown"
    assert op["target_code"] == "de"
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert diagnosed.wait(1)
    history = [entry for entry in service.state.read_history(100) if entry.get("operation_id") == op["id"]]
    assert history[0]["code"] == "restart"


def test_chain_operation_identity_reconciliation_and_legacy_single(service):
    seed_main(service)
    ident = routing.new_id()
    op = service.routing.submit_main("de", ident, entry_code="fi")
    assert op["target_route"]["mode"] == "chain"
    assert service.routing.submit_main("de", ident, entry_code="fi")["id"] == ident
    with pytest.raises(routing.RoutingError, match="already in use"):
        service.routing.submit_main("de", ident)
    result = wait_result(service.routing, op)
    assert result["phase"] == "committed", result
    assert service.state.read_state()["active_entry_code"] == "fi"
    with service._op_lock:
        pass
    single = wait_result(service.routing, service.routing.submit_main("de", routing.new_id()))
    assert single["phase"] == "committed"
    # Old journal records without the entry field are single requests.
    single.pop("target_entry_code", None)
    service.routing.store.put_operation(single)
    assert service.routing.submit_main("de", single["id"])["id"] == single["id"]
    with pytest.raises(routing.RoutingError, match="already in use"):
        service.routing.submit_main("de", single["id"], entry_code="fi")
    assert service.state.read_state()["active_entry_code"] is None


def test_chain_lost_reply_recovers_frozen_pair_and_history(service, monkeypatch):
    from .test_service import _sample_loc, _seed_sub
    seed_main(service)
    original = service.router.start_bundle
    attempts = []
    def lost(*args):
        attempts.append(args)
        if len(attempts) == 1:
            raise RouterError("request lost")
        return original(*args)
    monkeypatch.setattr(service.router, "start_bundle", lost)
    op = service.routing.submit_main("de", routing.new_id(), entry_code="fi")
    assert wait_result(service.routing, op)["phase"] == "unknown"
    assert service.routing.public_operation()["target_route"]["entry_code"] == "fi"
    _seed_sub(service.state, [_sample_loc("fi", host="new-entry"), _sample_loc("de", host="new-exit")])
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    assert "new-entry" not in str(service.router.read_outbound())
    assert service.state.read_state()["active_entry_code"] == "fi"
    events = [e for e in service.state.read_history(100) if e.get("operation_id") == op["id"]]
    assert len(events) == 1 and events[0]["entry_code"] == "fi"

def test_accepted_chain_restores_intent_after_restart(service):
    from xk_switcher.routing_store import now
    seed_main(service)
    op = {"id": routing.new_id(), "kind": "main", "target_code": "de", "target_entry_code": "fi",
          "trigger": "manual", "created_at": now(), "phase": "accepted"}
    service.routing.store.put_operation(op)
    replacement = Service(service.state, service.router)
    try:
        replacement.routing.recover()
        assert wait_terminal(replacement.routing, op)["phase"] == "committed"
        assert service.state.read_state()["active_entry_code"] == "fi"
    finally:
        replacement.routing.stop()

@pytest.mark.parametrize("previous_entry", [None, "ru"])
@pytest.mark.parametrize("outcome", ["rejected", "rolled_back"])
def test_failed_durable_chain_switch_preserves_installed_route_and_pending(service, monkeypatch, previous_entry, outcome):
    from dataclasses import replace
    from xk_switcher import config_updates, device_routing
    from .test_service import _sample_loc, _seed_sub
    entry, exit, other = [_sample_loc(code, host=code) for code in ("ru", "fi", "de")]
    _seed_sub(service.state, [entry, exit, other])
    op = service.routing.submit_main("fi", routing.new_id(), entry_code=previous_entry)
    assert wait_terminal(service.routing, op)["phase"] == "committed"
    with service._op_lock:
        service._update_from_locations([entry, replace(exit, pbk="PENDING"), other], trigger="manual")
    before_state = service.state.read_state()
    before_bundle = service.router.read_bundle()
    assert before_state["pending_reapply_code"] == "fi"
    assert before_state["applied_main_fingerprint"] == routing.digest(before_bundle[device_routing.OUTBOUNDS_FILE])
    started = []
    if outcome == "rejected":
        def reject(candidate):
            import json
            nodes = json.loads(device_routing.unpack(candidate)[device_routing.OUTBOUNDS_FILE])["outbounds"]
            assert nodes[0]["streamSettings"]["sockopt"]["dialerProxy"] == nodes[1]["tag"]
            started.append(True)
            raise routing.RoutingError("Unsupported chain transport", 422, "xray_validation")
        monkeypatch.setattr(service.router, "validate_bundle", reject)
    else:
        start = service.router.start_bundle
        def rollback(ident, *args):
            start(ident, *args)
            assert service.router._mock_operations[ident]["phase"] == "committed"
            assert service.router.read_bundle()[device_routing.OUTBOUNDS_FILE] != before_bundle[device_routing.OUTBOUNDS_FILE]
            started.append(True)
            # Simulate helper rollback after a failed restart, before server reconciliation.
            service.router._mock_outbound = before_bundle[device_routing.OUTBOUNDS_FILE]
            service.router._mock_routing = before_bundle[device_routing.ROUTING_FILE]
            service.router._mock_overlay = before_bundle.get(device_routing.OVERLAY_FILE)
            service.router._mock_operations[ident].update(phase="rolled_back", before_state="running")
        monkeypatch.setattr(service.router, "start_bundle", rollback)
    op = service.routing.submit_main("fi", routing.new_id(), entry_code="de")
    result = wait_terminal(service.routing, op)
    assert result["phase"] == outcome, result
    with service._op_lock:
        pass
    assert started == [True]
    assert service.router.read_bundle() == before_bundle
    assert service.state.read_state() == before_state
    assert service.state.read_state()["applied_main_config_hashes"] == config_updates.hashes(service.router.read_outbound())
    assert result["target_entry_code"] == "de"

def test_activity_nests_and_restores_the_outer_holder(service):
    r = service.routing
    with service._op_lock, r.activity(kind="update", message="Refreshing subscription", source="scheduler"):
        assert r.public_operation()["source"] == "scheduler"
        with r.activity(kind="route_check", message="Checking the current route", scope="diagnostic"):
            assert r.public_operation()["kind"] == "route_check"
            assert r.public_operation()["scope"] == "diagnostic"
        assert r.public_operation()["kind"] == "update"
    assert r.public_operation() is None

def test_main_admission_carries_the_request_id_and_durable_status_its_source(service):
    from .test_service import _sample_loc, _seed_sub
    _seed_sub(service.state, [_sample_loc("fi"), _sample_loc("de")])
    service.state.write_state({"active_code": "fi"})
    seen = []
    original = service.routing.activity
    def spy(**kwargs):
        seen.append(kwargs)
        return original(**kwargs)
    service.routing.activity = spy
    ident = routing.new_id()
    service.routing.submit_main("de", ident)
    assert seen[0]["kind"] == "main" and seen[0]["request_id"] == ident and seen[0]["source"] == "manual"
    op = next(op for op in service.routing.store.operations() if op["id"] == ident)
    if op["phase"] not in ("committed", "rolled_back", "rejected"):
        public = service.routing.public_operation()
        assert public["trigger"] == "manual" and public["source"] == "manual"
    wait_result(service.routing, op)
