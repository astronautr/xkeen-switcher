"""Routing orchestration. All router mutations share the parent service lock."""
import copy
import logging
import threading
import time
from contextlib import contextmanager, nullcontext
from . import routing
from . import device_routing
from .routing import RoutingError
from .routing_store import RoutingStore, TERMINAL, now

log = logging.getLogger(__name__)
OPERATION_TIMEOUT = 240
POLL_INTERVAL = 1
RETRY_INITIAL = 0.5
RETRY_MAX = 5
SOURCE_MANUAL = "manual"
SOURCE_FAILOVER = "failover"
SOURCE_SCHEDULER = "scheduler"
SOURCE_STARTUP = "startup"
TRIGGER_SOURCES = {"manual": SOURCE_MANUAL, "failover": SOURCE_FAILOVER, "auto-reapply": SOURCE_SCHEDULER,
                   "cron": SOURCE_SCHEDULER, "startup": SOURCE_STARTUP}

def source_for_trigger(trigger):
    """Safe initiator class; the browser that started a manual action is never named."""
    return TRIGGER_SOURCES.get(trigger, SOURCE_MANUAL)

class RoutingService:
    def __init__(self, parent):
        self.parent = parent
        self.router = parent.router
        self.store = RoutingStore(parent.state.data_dir)
        self.coordinator = parent._op_lock
        self._workers_lock = threading.Lock()
        self._requests_lock = threading.Lock()
        self._activity_lock = threading.Lock()
        self._activity = None
        self._workers = set()
        self._owner = threading.local()
        self._stop = threading.Event()

    def ensure_idle(self, *, include_updates=True):
        updates = getattr(self.parent, "router_updates", None)
        if include_updates and updates and updates.active():
            raise RoutingError("Wait for the router software operation.", 409, "busy")
        own_id = getattr(self._owner, "operation_id", None)
        if any(op["phase"] not in TERMINAL and op["id"] != own_id for op in self.store.operations()):
            raise RoutingError("Wait for the routing operation or recovery to finish", 409, "busy")
        if not self.coordinator.acquire(blocking=False):
            raise RoutingError("Another router operation is in progress", 409, "busy")
        self.coordinator.release()

    @contextmanager
    def admission(self, *, kind="router", target_code=None, target_name=None, target_entry_code=None,
                  message="Preparing router operation", source=SOURCE_MANUAL, request_id=None):
        # Never hold the store lock while waiting for the I/O coordinator.
        self.ensure_idle()
        if not self.coordinator.acquire(blocking=False):
            raise RoutingError("Another router operation is in progress", 409, "busy")
        try:
            self.ensure_idle()
            with self.activity(kind=kind, message=message, source=source, request_id=request_id,
                               target_code=target_code, target_name=target_name, target_entry_code=target_entry_code):
                yield
        finally:
            self.coordinator.release()

    @contextmanager
    def activity(self, *, kind, message, source=SOURCE_MANUAL, scope="router", request_id=None,
                 target_code=None, target_name=None, target_entry_code=None):
        """Publish work of a caller that already holds the coordinator.

        Only coordinator holders publish, so one slot is enough; nested work
        restores the outer activity when it finishes.
        """
        started_at = now()
        with self._activity_lock:
            previous = self._activity
            self._activity = {"id": None, "ephemeral": True, "blocking": True,
                              "kind": kind, "phase": "preparing", "source": source, "scope": scope,
                              "request_id": request_id, "target_code": target_code,
                              "target_name": target_name, "target_entry_code": target_entry_code,
                              "target_route": self.parent.route_info(target_code, target_entry_code) if target_code else None,
                              "message": message, "block_reason": message,
                              "created_at": previous["created_at"] if previous and previous.get("request_id") == request_id and request_id else started_at}
        try:
            yield
        finally:
            with self._activity_lock:
                self._activity = previous

    def public_operation(self):
        """Small persisted status view; never performs router I/O or recovery."""
        updates = getattr(self.parent, "router_updates", None)
        activity = updates.routing_activity() if updates else None
        if activity:
            return activity
        op = next((op for op in reversed(self.store.operations()) if op["phase"] not in TERMINAL), None)
        if op is None:
            with self._activity_lock:
                return dict(self._activity) if self._activity else None
        fields = ("id", "kind", "target_code", "target_name", "target_entry_code", "target_route", "confirmed_route", "phase", "created_at", "updated_at", "message", "warning", "trigger")
        op = self._route_metadata(op)
        result = {key: op[key] for key in fields if key in op}
        result.setdefault("kind", "device-location" if op.get("device_request") else "routing")
        result["source"] = source_for_trigger(op.get("trigger"))
        result["scope"] = "router"
        result["blocking"] = True
        result["block_reason"] = op.get("message", "Waiting for router confirmation")
        return result

    def _launch(self, ident):
        with self._workers_lock:
            if ident in self._workers or self._stop.is_set():
                return
            self._workers.add(ident)
        threading.Thread(target=self._run, args=(ident,), daemon=True, name="routing-reconcile").start()

    def _run(self, ident):
        delay = RETRY_INITIAL
        try:
            while not self._stop.is_set():
                try:
                    op = self.store.operation(ident)
                    if op["phase"] in TERMINAL:
                        return
                    # A checked Main intent always records submitted_at before contacting
                    # the router. A saved backup alone still needs the pre-submit check.
                    legacy_backup = op.get("before_snapshot") and not op.get("route_check_id")
                    resume = bool(op.get("submitted_at") or legacy_backup or
                                  op["phase"] not in {"accepted", "preparing", "prepared"})
                    self._work(ident, resume=resume)
                    if self.store.operation(ident)["phase"] in TERMINAL:
                        self._acknowledge(ident)
                        self._diagnose(ident)
                        return
                except Exception as error:
                    # Local journal errors must not discard the recovery
                    # obligation after a possibly successful remote commit.
                    log.warning("Routing recovery for %s will retry: %s", ident, error)
                if self._stop.wait(delay):
                    return
                delay = min(delay * 2, RETRY_MAX)
        finally:
            with self._workers_lock:
                self._workers.discard(ident)

    def stop(self):
        self._stop.set()

    def submit_main(self, code, operation_id, trigger="manual", *, entry_code=None, route_check_id=None):
        if not routing.valid_id(operation_id):
            raise RoutingError("Invalid operation ID")
        if not isinstance(code, str) or not code:
            raise RoutingError("Provide a location code")
        admission_lock = self.parent.route_checks.admission_lock if route_check_id is not None else nullcontext()
        with self._requests_lock, admission_lock:
            existing = self.store.read(f"operations/{operation_id}.json")
            if existing:
                if existing.get("kind") != "main" or existing.get("target_code") != code or existing.get("trigger") != trigger or existing.get("target_entry_code") != entry_code:
                    raise RoutingError("This operation ID is already in use", 409)
                return self._route_metadata(existing)
            if route_check_id is None:
                self.parent._main_entry(code, entry_code)
                if entry_code is not None and self.parent._find_location(code) is None:
                    raise RoutingError(f"No saved location with code '{code}'", 409, "location")
            with self.admission(kind="main", target_code=code, target_entry_code=entry_code,
                                message="Preparing Main location", source=source_for_trigger(trigger),
                                request_id=operation_id), self.store.lock:
                # Return a replay above even if its check has expired in the meantime.
                binding = None
                if route_check_id is not None:
                    binding = self.parent.route_checks.apply_binding(route_check_id, code, entry_code)
                op = {"id": operation_id, "kind": "main", "target_code": code, "target_entry_code": entry_code,
                      "target_route": self.parent.route_info(code, entry_code), "trigger": trigger,
                      "created_at": now(), "phase": "accepted", "message": "Preparing Main location"}
                if binding:
                    op.update(route_check_id=route_check_id, expected_main_sha256=binding["candidate_sha256"],
                              route_check_binding=binding)
                location = self.parent._find_location(code)
                if location:
                    op["target_name"] = location.name
                self.store.put_operation(op)
            self._launch(operation_id)
            return self._route_metadata(op)

    def _snapshot(self, raw, source, previous=None, **extra):
        model, error = None, None
        try: model = routing.parse(raw, previous)
        except (ValueError, UnicodeError, RecursionError) as e: error = str(e)
        return self.store.save_blob("snapshots", raw, {"source": source, "parse_error": error, **extra}, model)

    def ensure_current(self, raw):
        """Import already-observed canonical bytes without another router read."""
        with self.store.lock:
            current = self.store.read("current.json")
            if current is None:
                meta = self._snapshot(raw, "initial-import")
                if self.store.read("original.json") is None:
                    self.store.write("original.json", {"id": meta["id"]})
                current = {"id": meta["id"], "sha256": meta["sha256"]}
                self.store.write("current.json", current)
            return current

    def state(self):
        with self.coordinator, self.activity(kind="read", scope="read", message="Reading routing from the router"):
            raw = self.router.read_routing()
            caps = self.router.routing_capabilities()
            with self.store.lock:
                current = self.ensure_current(raw)
                meta, _ = self.store.blob("snapshots", current["id"])
                return {"model": meta["model"], "parse_error": meta.get("parse_error"), "current": current,
                        "observed_hash": routing.digest(raw), "observed_at": now(),
                        "drift": current["sha256"] != routing.digest(raw), "capabilities": caps,
                        "draft": self.store.read("draft.json"), "operations": self.store.operations()[-20:]}

    def reimport(self, body):
        with self.admission():
            if self.store.read("draft.json"):
                raise RoutingError("Download a copy and discard the draft first", 409, "draft_conflict")
            current = self.store.read("current.json")
            if not current or body.get("expected_current_hash") != current["sha256"]:
                raise RoutingError("The base version has changed", 409, "conflict")
            raw = self.router.read_routing()
            if body.get("observed_hash") != routing.digest(raw):
                raise RoutingError("Configuration changed again; refresh its status", 409, "conflict")
            with self.store.lock:
                if self.store.read("draft.json"):
                    raise RoutingError("Download a copy and discard the draft first", 409, "draft_conflict")
                old,_ = self.store.blob("snapshots",current["id"])
                meta = self._snapshot(raw, "reimport", old["model"])
                self.store.write("current.json", {"id":meta["id"], "sha256":meta["sha256"]})
                self.store.prune()
        return self.state()

    def save_draft(self, body):
        with self.store.lock:
            current = self.store.read("current.json")
            if not current: raise RoutingError("Load the configuration first",409)
            existing = self.store.read("draft.json")
            if body.get("expected_revision") != (existing or {}).get("revision"):
                raise RoutingError("The draft was changed in another window",409,"draft_conflict")
            if body.get("base_hash") != current["sha256"] or (existing and existing["base_hash"] != current["sha256"]):
                raise RoutingError("The base configuration has changed",409,"conflict")
            base,_ = self.store.blob("snapshots",current["id"])
            if not base["model"] or base["model"].get("issues"):
                raise RoutingError("This configuration is read-only",422)
            model = routing.edit_model(base["model"],body.get("model"))
            # A pending apply may replace this base. Keep a newer draft that
            # reverts it so the user's edits survive that operation's completion.
            if not routing.diff(base["model"], model) and not any(op["phase"] not in TERMINAL for op in self.store.operations()):
                if existing: self.store.delete_draft(existing["revision"])
                return None
            if existing and not routing.diff(existing["model"], model):
                return existing
            draft = {"revision": routing.new_id(), "base_hash":current["sha256"], "base_snapshot":current["id"],
                     "model":model,"validation":routing.validate(model),"saved_at":now()}
            self.store.write("draft.json",draft)
            return draft

    def preview(self, body):
        with self.admission():
            current = self.store.read("current.json")
            if not current or body.get("expected_current_hash") != current["sha256"]:
                raise RoutingError("The base version has changed",409,"conflict")
            raw = self.router.read_routing()
            if routing.digest(raw) != current["sha256"]:
                raise RoutingError("The file changed on the router. Reimport the configuration.",409,"drift")
            caps = self.router.routing_capabilities()
            if not caps.get("ready"): raise RoutingError(caps.get("reason", "Update the router helper"),503,"helper")
            base,_ = self.store.blob("snapshots",current["id"])
            intent = body.get("intent", "apply")
            draft = self.store.read("draft.json")
            if intent == "restore":
                target,candidate = self.store.blob("snapshots",body.get("snapshot_id"))
                model = target["model"]
            elif intent == "apply":
                if not draft or draft["revision"] != body.get("draft_revision") or draft["base_hash"] != current["sha256"]:
                    raise RoutingError("The draft is missing or has changed",409,"draft_conflict")
                model=draft["model"]
                if not routing.diff(base["model"],model): raise RoutingError("No changes",422,"noop")
                candidate=routing.generate(model)
            else: raise RoutingError("Unknown action")
            if candidate == raw: raise RoutingError("This version is already installed",422,"noop")
            bundle_id = None
            if self.parent.device_locations.managed():
                bundle_id, environment = self.parent.device_locations.prepare(candidate)
            else:
                environment=self.router.routing_environment()
                self.router.validate_routing(candidate)
                if self.router.routing_environment() != environment:
                    raise RoutingError("The router environment changed during validation",409,"conflict")
            health = self.router.routing_health()
            if health not in ("running", "stopped"):
                raise RoutingError("Could not determine XKeen status. Try validation again when the connection is restored.",503,"health")
            changes = routing.diff(base["model"],model) if base["model"] and model else []
            return self.store.save_blob("previews", candidate, {
                "intent":intent,"base_hash":current["sha256"],"base_snapshot":current["id"],
                "source_snapshot":body.get("snapshot_id") if intent == "restore" else None,
                "draft_revision":draft["revision"] if intent == "apply" else None,
                "environment":environment,"bundle_id":bundle_id,"changes":changes,"xkeen_state":health,
                "validation":routing.validate(model) if model and intent == "apply" else [],
                "has_draft":bool(draft), "validated":True}, model)

    def apply(self, body):
        op_id=body.get("operation_id")
        if not routing.valid_id(op_id): raise RoutingError("Invalid operation ID")
        with self._requests_lock:
            existing = self.store.read(f"operations/{op_id}.json")
            if existing:
                if existing.get("request_preview_id", existing.get("preview_id")) != body.get("preview_id"): raise RoutingError("This operation ID is already in use",409)
                return existing
            with self.admission(), self.store.lock:
                preview,_ = self.store.blob("previews",body.get("preview_id"))
                self._check_preview(preview)
                op={"id":op_id,"preview_id":preview["id"],"source_snapshot":preview.get("source_snapshot"),
                    "kind": "routing", "created_at":now(),"phase":"accepted", "message":"Preparing backup"}
                self.store.put_operation(op)
            self._launch(op_id)
            return op

    def _check_preview(self, preview):
        current=self.store.read("current.json") or {}
        if preview["base_hash"] != current.get("sha256"): raise RoutingError("This preview is out of date",409,"conflict")
        if preview.get("bundle_id"):
            bundle, _ = self.store.blob("bundles", preview["bundle_id"])
            if bundle["locations_revision"] != self.parent.device_locations.read()["revision"]:
                raise RoutingError("Device locations changed after this preview", 409, "conflict")
        if preview["intent"] == "apply":
            draft=self.store.read("draft.json")
            if not draft or draft["revision"] != preview["draft_revision"]:
                raise RoutingError("The draft changed after this preview",409,"draft_conflict")

    def _update(self, op, **patch):
        if all(op.get(key) == value for key, value in patch.items()):
            return
        timestamp = now()
        phase = patch.get("phase")
        if phase and phase != op.get("phase"):
            patch["phase_times"] = {**op.get("phase_times", {}), phase: timestamp}
        op.update(patch,updated_at=timestamp)
        self.store.put_operation(op)

    def apply_bundle(self, *, ident=None, bundle_id=None, environment=None, main=None,
                     state_patch=None, device_request=None, synchronous=False):
        with self.admission():
            if bundle_id is None:
                self.state()
                raw = self.router.read_routing()
                bundle_id, environment = self.parent.device_locations.prepare(raw, main=main, state_patch=state_patch)
            bundle, payload = self.store.blob("bundles", bundle_id)
            raw = device_routing.unpack(payload)[device_routing.ROUTING_FILE]
            current = self.ensure_current(raw)
            health = self.router.routing_health()
            if health not in ("running", "stopped"):
                raise RoutingError("Could not determine XKeen status", 503, "health")
            preview = self.store.save_blob("previews", raw, {
                "intent": "device-location" if device_request else "location", "base_hash": current["sha256"],
                "base_snapshot": current["id"], "environment": environment, "bundle_id": bundle_id,
                "xkeen_state": health, "validated": not bundle.get("main_only")}, routing.parse(raw))
            self._check_preview(preview)
            ident = ident or routing.new_id()
            op = {"id": ident, "preview_id": preview["id"], "created_at": now(), "phase": "accepted",
                  "kind": "device-location" if device_request else "location",
                  "message": "Preparing device locations", "device_request": device_request, "synchronous": synchronous}
            if bundle.get("history"):
                op["history"] = bundle["history"]
                op["trigger"] = bundle["history"].get("trigger")
                op["target_code"] = bundle["history"].get("code")
                if bundle["history"].get("warning"):
                    op["warning"] = bundle["history"]["warning"]
            if bundle.get("main_only") or (bundle.get("history") and bundle["state_patch"].get("active_code")):
                op["kind"] = "main"
                op["target_code"] = bundle["state_patch"].get("active_code")
                op["target_entry_code"] = bundle["state_patch"].get("active_entry_code")
                op["target_route"] = self.parent.route_info(op["target_code"], op["target_entry_code"])
                location = self.parent._find_location(op["target_code"])
                if location:
                    op["target_name"] = location.name
            self.store.put_operation(op)
            if synchronous:
                self._work(ident)
                if self.store.operation(ident)["phase"] not in TERMINAL:
                    self._launch(ident)
                else:
                    threading.Thread(target=self._acknowledge, args=(ident,), daemon=True, name="routing-retention").start()
                return self.store.operation(ident)
            self._launch(ident)
            return op

    def _start(self, op_id, preview, candidate):
        if preview.get("bundle_id"):
            bundle, payload = self.store.blob("bundles", preview["bundle_id"])
            self.router.start_bundle(op_id, bundle["before_hash"], bundle["environment"], payload)
        else:
            self.router.start_routing(op_id, preview["base_hash"], preview["environment"], candidate)

    def _refresh_candidate(self, op, preview, candidate):
        # Main uses available locations; routing/device edits retain exactly
        # the reviewed candidate. Only explicit pending applies refresh exits.
        return preview

    def _verify_main_check(self, op):
        if not op.get("route_check_id"):
            return
        checks = self.parent.route_checks
        if "route_check_binding" in op:
            checks.verify_binding(op["route_check_binding"], op["target_code"], op.get("target_entry_code"))
        else:
            # Operations accepted before the binding was added to the journal.
            checks.verify_legacy_binding(op["route_check_id"], op["target_code"], op.get("target_entry_code"),
                                         op["expected_main_sha256"])

    def _prepare_main(self, op):
        self._update(op, phase="preparing", message="Preparing Main location configuration")
        self._verify_main_check(op)
        result = self.parent.prepare_main_operation(op["target_code"], trigger=op["trigger"],
                                                    **({"entry_code": op["target_entry_code"]} if op.get("target_entry_code") else {}),
                                                    **({"expected_main_sha256": op["expected_main_sha256"]} if op.get("expected_main_sha256") else {}))
        _, payload = self.store.blob("bundles", result["bundle_id"])
        raw = device_routing.unpack(payload)[device_routing.ROUTING_FILE]
        current = self.store.read("current.json")
        health = self.router.routing_health()
        if health not in {"running", "stopped"}:
            raise RoutingError("Could not determine XKeen status", 503, "health")
        preview = self.store.save_blob("previews", raw, {
            "intent": "location", "base_hash": current["sha256"], "base_snapshot": current["id"],
            "bundle_id": result["bundle_id"], "environment": result["environment"],
            "xkeen_state": health, "validated": False}, routing.parse(raw))
        self._update(op, preview_id=preview["id"], phase="prepared", message="Main configuration prepared",
                     **({"warning": result["warning"]} if result.get("warning") else {}))
        return preview, raw

    def _work(self, op_id, resume=False):
        with self.coordinator:
            op = self.store.operation(op_id)
            if op["phase"] in TERMINAL:
                return
            previous_owner = getattr(self._owner, "operation_id", None)
            self._owner.operation_id = op_id
            started = resume
            try:
                if not op.get("preview_id"):
                    preview, candidate = self._prepare_main(op)
                else:
                    preview, candidate = self.store.blob("previews", op["preview_id"])
                if not resume:
                    self._check_preview(preview)
                    main_only = False
                    if preview.get("bundle_id"):
                        bundle, _ = self.store.blob("bundles", preview["bundle_id"])
                        main_only = bundle.get("main_only", False)
                        if not main_only:
                            self.parent.device_locations.verify_bindings(bundle["locations_state"])
                    # Main's helper transaction validates the whole effective
                    # config and checks observed hashes before installing.
                    raw = candidate if main_only else self.router.read_routing()
                    if not main_only:
                        if routing.digest(raw) != preview["base_hash"]:
                            raise RoutingError("Configuration changed on the router", 409, "drift")
                        environment = self.router.bundle_environment() if preview.get("bundle_id") else self.router.routing_environment()
                        if environment != preview["environment"]:
                            raise RoutingError("The router environment changed after this preview", 409, "conflict")
                    preview = self._refresh_candidate(op, preview, candidate)
                    before_id = preview["base_snapshot"] if candidate == raw else self._snapshot(raw, "pre-apply", operation_id=op_id)["id"]
                    self._update(op, before_snapshot=before_id, phase="prepared", message="Backup verified")
                    self._verify_main_check(op)
                    # Once this intent is durable, recovery only follows this ID
                    # and these frozen bytes, including after a lost SSH reply.
                    self._update(op, phase="submitted", submitted_at=now(), message="Validating and applying on the router")
                    started = True
                    self._start(op_id, preview, candidate)
                deadline = time.monotonic() + OPERATION_TIMEOUT
                retried = False
                while not self._stop.is_set():
                    remote = self.router.routing_operation(op_id)
                    phase = remote["phase"]
                    if phase == "not_found":
                        if retried:
                            raise RoutingError("The router has not acknowledged the operation", 503)
                        # Only confirmed absence permits resubmission. Partial
                        # metadata is a pending remote phase, never absence.
                        retried = True
                        self._start(op_id, preview, candidate)
                        continue
                    if phase in TERMINAL or phase == "recovery_failed":
                        self._finish(op, preview, candidate, remote)
                        return
                    self._update(op, phase=phase, message=remote.get("message", phase))
                    if time.monotonic() > deadline:
                        raise TimeoutError("Waiting for router confirmation")
                    self._stop.wait(POLL_INTERVAL)
            except Exception as error:
                log.warning("Routing operation %s needs %s: %s", op_id, "confirmation" if started else "correction", error)
                self._update(op, phase="unknown" if started else "rejected", message=str(error),
                             reconciliation_attempts=op.get("reconciliation_attempts", 0) + int(started))
                if not started and op.get("kind") == "main":
                    self.parent.state.append_history_once({"action": "switch", "trigger": op.get("trigger", "manual"),
                        "code": op["target_code"], "entry_code": op.get("target_entry_code"), "ts": op["updated_at"], "result": "fail",
                        "operation_id": op["id"], "message": str(error)})
            finally:
                self._owner.operation_id = previous_owner

    def _finish(self, op, preview, candidate, remote):
        phase = remote["phase"]
        if phase == "recovery_failed":
            self._update(op, phase=phase, message=remote.get("message", "Router recovery requires attention"))
            return
        bundle = self.store.blob("bundles", preview["bundle_id"])[0] if preview.get("bundle_id") else None
        if bundle and preview["intent"] == "location" and bundle["state_patch"].get("active_code") and not op.get("kind"):
            self._update(op, kind="main", target_code=bundle["state_patch"]["active_code"], trigger="manual", legacy_main=True)
        state_patch = {}
        if phase == "committed":
            raw = self.router.read_routing()
            if routing.digest(raw) != preview["sha256"] or self.router.routing_health() != "running":
                raise RoutingError("The apply result has not been confirmed", 503)
            if bundle:
                if device_routing.fingerprint(self.router.read_bundle()) != bundle["after_hash"]:
                    raise RoutingError("The device routing bundle has not been confirmed", 503)
            if not op.get("completed_at"):
                self._update(op, completed_at=now(), phase="reconciling")
            if bundle:
                if self.parent.device_locations.read() != bundle["locations_state"]:
                    self.parent.device_locations.write(bundle["locations_state"])
                state_patch.update(bundle["state_patch"])
                if op.get("kind") == "main":
                    state_patch.setdefault("active_entry_code", op.get("target_entry_code"))
            state_patch.update(xkeen_state="running", xkeen_stop_cause=None)
            previous = copy.deepcopy(preview["model"])
            if previous and preview["intent"] == "apply":
                for group in previous["groups"]:
                    group["rule"] = routing.rule_for(group)
            with self.store.lock:
                current = self.store.read("current.json") or {}
                # Main-only transactions do not advance the routing editor's
                # version, create rule history or invalidate an existing draft.
                if current.get("sha256") != routing.digest(raw):
                    after_id = op.get("after_snapshot")
                    after = self.store.blob("snapshots", after_id)[0] if after_id else self._snapshot(
                        raw, "restore" if preview["intent"] == "restore" else "apply", previous, operation_id=op["id"])
                    self._update(op, after_snapshot=after["id"], phase="reconciling")
                    self.store.write("current.json", {"id": after["id"], "sha256": after["sha256"]})
                draft = self.store.read("draft.json")
                if draft and preview["intent"] == "apply" and draft["revision"] == preview["draft_revision"]:
                    self.store.delete_draft(draft["revision"])
        elif phase in {"rolled_back", "rejected"}:
            _, raw = self.store.blob("snapshots", op["before_snapshot"])
            if self.router.read_routing() != raw:
                raise RoutingError("The restored file does not match the backup", 503)
            if bundle and device_routing.fingerprint(self.router.read_bundle()) != bundle["before_hash"]:
                raise RoutingError("The restored device bundle does not match the backup", 503)
            expected_state = remote.get("before_state", preview["xkeen_state"])
            if phase == "rejected" and expected_state not in {"running", "stopped"}:
                # Rejection during acceptance can precede remote health
                # capture. Exact before-bytes were checked above; require the
                # state observed during local validation in that case.
                expected_state = preview["xkeen_state"]
            if expected_state not in {"running", "stopped"} or self.router.routing_health() != expected_state:
                raise RoutingError("XKeen status after recovery has not been confirmed", 503)
            state_patch["xkeen_state"] = expected_state
        # Freeze completion time before local effects so crash reconciliation
        # cannot postpone failover grace or duplicate applied/history records.
        if not op.get("completed_at"):
            self._update(op, completed_at=now(), phase="reconciling")
        if phase == "committed":
            state_patch["last_apply_at"] = op["completed_at"]
            if "failover_since" in state_patch and state_patch["failover_since"]:
                state_patch["failover_since"] = op["completed_at"]
        if state_patch:
            self.parent.state.write_state(state_patch)
        if phase == "committed" and bundle and op.get("kind") == "main":
            self.parent.finalize_main_operation(op, bundle)
        history = (bundle or {}).get("history") or op.get("history")
        if history is None and op.get("kind") == "main":
            history = {"action": "switch", "trigger": op.get("trigger", "manual"), "code": op["target_code"], "entry_code": op.get("target_entry_code")}
        message = remote.get("message", phase)
        entry = {**(history or {"action": "routing-" + preview["intent"]}),
                 "ts": op["completed_at"], "result": "ok" if phase == "committed" else "fail",
                 "routing_phase": phase, "operation_id": op["id"], "message": message}
        if op.get("device_request") and not op["device_request"].get("undo") and phase == "committed":
            entry["device_operation"] = op["id"]
        self.parent.state.append_history_once(entry)
        self._update(op, phase=phase, message=message)
        # Retention and acknowledgment are maintenance after the verified
        # commit. Failure here cannot make its result unknown again.
        try:
            self.store.prune()
        except Exception:
            log.warning("Routing backup retention deferred for %s", op["id"], exc_info=True)

    def _acknowledge(self, ident):
        try:
            self.router.acknowledge_routing(ident)
        except Exception:
            log.warning("Router backup retention deferred for %s", ident, exc_info=True)

    def _diagnose(self, ident):
        op = self.store.operation(ident)
        if op["phase"] not in {"committed", "rolled_back"}:
            return
        # A diagnostic is separate from the committed apply. The parent checks
        # route generation before recording results if Main changes meanwhile.
        if self.public_operation():
            self._update(op, diagnostics={"phase": "deferred"})
            return
        self._update(op, diagnostics={"phase": "checking"})
        try:
            result = self.parent.check_after_apply()
            self._update(op, diagnostics={"phase": "failed" if result is False else "complete"})
        except Exception as error:
            self._update(op, diagnostics={"phase": "failed", "message": str(error)})
            log.warning("Post-apply diagnostics failed for %s: %s", ident, error)

    def operation(self, ident):
        return self._route_metadata(self.store.operation(ident))

    def _route_metadata(self, op):
        op = dict(op)
        op.pop("expected_main_sha256", None)
        op.pop("route_check_binding", None)
        if op.get("kind") == "main":
            state = self.parent.state.read_state()
            op["confirmed_route"] = self.parent.route_info(state.get("active_code"), state.get("active_entry_code"))
            op.setdefault("target_entry_code", None)
            op.setdefault("target_route", self.parent.route_info(op.get("target_code"), op["target_entry_code"]))
        return op

    def recover(self):
        """Resume durable intents independently of browsers and HTTP startup."""
        for op in self.store.operations():
            if op["phase"] not in TERMINAL:
                self._launch(op["id"])
