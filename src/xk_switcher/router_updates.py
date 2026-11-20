"""Durable update requests, pinned schedules and reconciliation with the router's journal."""
import copy
import hashlib
import http.client
import json
import logging
import re
import shlex
import threading
import urllib.error
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .routing import RoutingError, new_id, valid_id
from .routing_store import atomic
from .router_update_catalog import ReleaseChecksumChanged
from .router import RouterError

log = logging.getLogger(__name__)
COMPONENTS = ("xkeen", "xray")
MSK = timezone(timedelta(hours=3))
CATALOG_INTERVAL = timedelta(hours=6)
RETRY_CATALOG = timedelta(seconds=30)
WINDOW = {"once": timedelta(minutes=10), "auto": timedelta(minutes=25)}
# Reserve time for a local install/restart before the external cron is due.
MAINTENANCE_MARGIN = timedelta(minutes=10)
VERSION = re.compile(r"[0-9]{1,6}(?:\.[0-9]{1,6}){1,3}")
CLOCK = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d")
COMPLETE = {"installed", "rolled_back", "start_failed", "rolled_back_start_failed", "rejected"}
PHASES = COMPLETE | {"preparing", "installing", "restoring", "interrupted", "unknown"}
DIGEST = re.compile(r"[a-f0-9]{64}")
PUBLIC_FIELDS = ("id", "action", "component", "version", "phase", "message", "source", "at", "main_before")
PAIR_FIELDS = ("id", "versions", "at", "state", "steps", "message")
JOURNAL_MISSING = "The router journal and its receipt do not confirm this update. Restore the original journal from backup, then recheck."
RESULT_MESSAGES = {
    "installed": "Installed. Check the route manually.",
    "rolled_back": "Previous version restored. Current Main route preserved.",
    "start_failed": "Software installed. The expected service state was not confirmed. Manual rollback is available.",
    "rolled_back_start_failed": "Previous files restored. The expected service state was not confirmed. Check the service manually.",
    "rejected": "Router rejected the operation. Check the versions, restore point and router activity.",
}
OLD_SERVICE_FAILURES = (
    "Software installed, but the service failed to start. Manual rollback is available.",
    "Previous files restored. XKeen did not return to its previous running/stopped state. Check the service manually.",
    "Completed on the router",
)
NO_RUNTIME_DETAILS = "The router did not record restart diagnostics for this update."
SERVICE_REASONS = {"rci_auth": "RCI authentication failed", "missing_utility": "Required utility missing",
                   "firewall": "Firewall setup failed", "already_running": "Service already running",
                   "busy": "Service busy", "config": "Invalid service configuration",
                   "start_failed": "Start command reported failure", "stop_failed": "Stop command reported failure"}

class PreparationUnavailable(Exception):
    """Safe reason for retrying before submission; contains no upstream error text."""

def stamp():
    return datetime.now(timezone.utc)

def version_key(value):
    if not isinstance(value, str) or not VERSION.fullmatch(value):
        return ()
    return tuple(int(part) for part in value.split("."))

def parse_time(value):
    try:
        moment = datetime.fromisoformat(value)
        if moment.utcoffset() is not None:
            return moment.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        pass
    raise RoutingError("Choose a date and time with a time zone.")

def require_component(name):
    if name not in COMPONENTS:
        raise RoutingError("Choose XKeen or Xray.")

def public_op(op):
    return {k: op.get(k) for k in PUBLIC_FIELDS} if op else None

def runtime_summary(runtime):
    """Format only known helper values. Command output can contain private router configuration."""
    if not isinstance(runtime, dict) or runtime.get("action") not in ("restart", "stop", "verify"):
        return ""
    parts = []
    control = runtime.get("control")
    action = runtime["action"].capitalize()
    rc = runtime.get("rc")
    if control == "pending":
        return f"{action} in progress."
    if control in ("ok", "nonzero") and type(rc) is int and -255 <= rc <= 255:
        parts.append(f"{action} exit code {rc}.")
    elif control == "timeout":
        parts.append(f"{action} timed out.")
    elif control == "unavailable":
        number = runtime.get("control_errno")
        suffix = f" (OS error {number})" if type(number) is int and 0 < number <= 4095 else ""
        parts.append(f"{action} command unavailable{suffix}.")
    reason = runtime.get("reason")
    if isinstance(reason, str) and reason in SERVICE_REASONS:
        parts.append(SERVICE_REASONS[reason] + ".")
    status = runtime.get("last_status")
    if status in ("running", "stopped", "unknown", "timeout", "unavailable"):
        status_rc = runtime.get("status_rc")
        suffix = f" (exit code {status_rc})" if type(status_rc) is int and -255 <= status_rc <= 255 else ""
        parts.append(f"Last status: {status}{suffix}.")
    attempts, elapsed = runtime.get("attempts"), runtime.get("elapsed_sec")
    if type(attempts) is int and 0 <= attempts <= 1000 and type(elapsed) is int and 0 <= elapsed <= 86400:
        parts.append(f"{attempts} {'check' if attempts == 1 else 'checks'} in {elapsed} s.")
    if runtime.get("process") == "unchanged":
        parts.append("The same process was still running.")
    elif runtime.get("process") == "replaced":
        parts.append("A new proxy process was observed.")
    elif runtime.get("process") == "unknown" and control in ("nonzero", "timeout", "unavailable"):
        parts.append("A new proxy process could not be confirmed.")
    if runtime.get("ready") is False:
        parts.append("The router did not report the proxy ready.")
    return " ".join(parts)

def router_message(receipt, fallback):
    runtime = receipt.get("runtime")
    summary = runtime_summary(runtime)
    if receipt.get("phase") in ("start_failed", "rolled_back_start_failed"):
        if not summary:
            summary = NO_RUNTIME_DETAILS
        elif runtime.get("consecutive") == 1:
            summary += " Only one of two consecutive checks confirmed the expected state."
    if isinstance(runtime, dict) and runtime.get("stderr_saved") is True and valid_id(receipt.get("id")):
        summary += f" Local logs in /opt/var/lib/xk-switcher/updates/operations/{receipt['id']}/"
    return f"{fallback} {summary}" if summary else fallback

def upgrade_service_results(doc):
    """Recover file-install outcomes from older journals using their original child operation."""
    for op in doc["operations"].values():
        phase = op.get("phase")
        if phase not in ("start_failed", "rolled_back_start_failed"):
            continue
        if op.get("message") in OLD_SERVICE_FAILURES:
            op["message"] = router_message(op, RESULT_MESSAGES[phase])
        pair = doc.get("pairs", {}).get(op.get("pair_id"))
        name = op.get("component")
        if (phase == "start_failed" and op.get("action") == "install" and pair
                and pair["steps"].get(name) == "failed" and pair["versions"].get(name) == op.get("version")):
            pair["steps"][name] = "start_unconfirmed"
            if pair["message"] in OLD_SERVICE_FAILURES:
                pair["message"] = NO_RUNTIME_DETAILS

def current_pair(doc):
    return doc.get("pairs", {}).get(doc.get("pair_id"))

def initial():
    return {"automatic": {"xkeen": False, "xray": False, "time": "03:00"},
            "once": {}, "auto_last": {}, "releases": [], "inventory": {},
            "checked_at": None, "retry_at": None, "catalog_error": None, "router_error": None,
            "active": None, "operations": {}, "recent": [], "router_event": None}

class RouterUpdates:
    def __init__(self, parent, *, clock=stamp, catalog=None):
        self.parent = parent
        self.clock = clock
        self.catalog = catalog
        self.path = Path(parent.state.data_dir) / "router-updates.json"
        self.lock = threading.RLock()
        self.io = threading.Lock()
        self.refresh_lock = threading.Lock()
        self.stop_event = threading.Event()
        try:
            self.doc = json.loads(self.path.read_bytes())
            if not isinstance(self.doc, dict) or not initial().keys() <= self.doc.keys():
                raise ValueError()
        except FileNotFoundError:
            self.doc = initial()
        except (OSError, TypeError, ValueError) as err:
            raise RoutingError("Cannot read the router update journal.", 503, "storage") from err
        upgrade_service_results(self.doc)
        self.worker_lock = threading.Lock()
        self.worker = None

    def _save(self, doc):
        atomic(self.path, json.dumps(doc, ensure_ascii=False, allow_nan=False).encode())
        self.doc = doc

    def active(self):
        with self.lock:
            return self._active(self.doc)

    @staticmethod
    def _active(doc):
        if doc["active"]:
            return public_op(doc["operations"][doc["active"]])
        return public_op(doc["inventory"].get("active"))

    def routing_activity(self):
        op = self.active()
        if op:
            return {"id": None, "ephemeral": True, "request_id": op["id"], "kind": "router-update",
                    "phase": op["phase"], "source": "scheduler" if op["source"] in WINDOW else "manual",
                    "scope": "router", "created_at": op["at"], "updated_at": op["at"],
                    "blocking": True, "message": op["message"] or "Updating router software",
                    "block_reason": "Router software operation in progress"}

    def generation(self):
        with self.lock:
            return self.doc["router_event"]

    def _components(self, doc):
        result = {}
        inventory = doc["inventory"]
        for name in COMPONENTS:
            component = inventory.get("components", {}).get(name, {})
            installed = component.get("installed")
            versions = [row for row in doc["releases"] if row["component"] == name and
                        version_key(row["version"]) > version_key(installed)]
            versions.sort(key=lambda row: version_key(row["version"]), reverse=True)
            result[name] = {
                "installed": installed,
                "releases": [{k: row.get(k) for k in ("version", "supported", "reason")} for row in versions],
                "rollback": component.get("rollback_plan", []),
                "held": inventory.get("held", {}).get(name),
                "schedule": doc["once"].get(name),
            }
        return result

    def available(self):
        with self.lock:
            return self._available(self._components(self.doc)) if not self.doc["router_error"] else []

    @staticmethod
    def _available(components):
        result = []
        for name, component in components.items():
            row = next((r for r in component["releases"] if r["supported"]), None)
            if row and component["installed"] and row["version"] != component["held"]:
                result.append({"component": name, "version": row["version"]})
        return result

    def status(self):
        with self.lock:
            doc = self.doc
            pair = current_pair(doc)
            components = self._components(doc)
            cfg = self.parent.config
            ssh = shlex.join(["ssh", "-t", "-p", str(cfg.router_port), "--",
                              f"{cfg.router_user}@{cfg.router_host}", "/opt/bin/xk-update-recovery"])
            day = self.clock().astimezone(MSK)
            start = self._daily_start(day, doc["automatic"]["time"])
            next_times = []
            for name in COMPONENTS:
                if not doc["automatic"][name]:
                    continue
                next_time = start
                if (day >= start + WINDOW["auto"] or self._before_enabled(doc, name, start)
                        or doc["auto_last"].get(name) == day.date().isoformat()
                        or doc.get("auto_failed_day") == day.date().isoformat()):
                    next_time += timedelta(days=1)
                next_times.append(next_time)
            return copy.deepcopy({"automatic": doc["automatic"], "components": components,
                "pair": {k: pair[k] for k in PAIR_FIELDS} if pair else None,
                "operation": self._active(doc), "history": [public_op(doc["operations"][i]) for i in doc["recent"][:30]],
                "ssh_command": ssh, "rollback_revision": doc["inventory"].get("revision"),
                "maintenance_lead_minutes": self._maintenance_lead_minutes(),
                "available": self._available(components) if not doc["router_error"] else [],
                "next_auto_at": min(next_times).isoformat() if next_times else None,
                **{k: doc[k] for k in ("checked_at", "catalog_error", "router_error")}})

    def _catalog(self):
        if self.catalog is not None:
            return self.catalog
        if self.parent.router.host == "mock":
            return MockCatalog
        from . import router_update_catalog
        return router_update_catalog

    def _read_inventory(self):
        inv = self.parent.router.update_inventory()
        if not isinstance(inv, dict) or not isinstance(inv.get("arch"), str):
            raise ValueError("Invalid update inventory")
        for name in COMPONENTS:
            row = inv["components"][name]
            if not isinstance(row, dict) or not isinstance(row.get("rollback_plan", []), list):
                raise ValueError("Invalid update inventory")
        inv = dict(inv)
        for key in ("active", "last"):
            if event := inv.get(key):
                event = dict(event)
                fallback = RESULT_MESSAGES.get(event.get("phase"), "Router software operation in progress.")
                event["message"] = router_message(event, fallback)
                event.pop("runtime", None)
                inv[key] = event
        return inv

    def _sync(self):
        # Serialize observations. Otherwise a slow, older snapshot can overwrite a terminal event.
        with self.io:
            try:
                inv = self._read_inventory()
            except Exception:
                with self.lock:
                    if self.doc["router_error"] is None:
                        doc = copy.deepcopy(self.doc)
                        doc["router_error"] = "Router update helper unavailable. Check its installation and SSH connection."
                        self._save(doc)
                raise RoutingError("Router update helper unavailable.", 503, "router_unavailable") from None
            with self.lock:
                doc = copy.deepcopy(self.doc)
                previous = doc["inventory"].get("components", {})
                previous_held = doc["inventory"].get("held", {})
                versions = {k: inv["components"][k].get("installed") for k in COMPONENTS}
                if previous and not inv.get("active") and all(versions.values()):
                    if any(previous[k].get("installed") != versions[k] for k in COMPONENTS):
                        # Changes made while the server was offline can precede a later rejected request.
                        doc["router_event"] = hashlib.sha256(json.dumps(versions, sort_keys=True).encode()).hexdigest()
                snapshot_error = "Restore point metadata is missing on the router." if inv.get("snapshot_error") else None
                doc.update(inventory=inv, router_error=snapshot_error)
                last = inv.get("last") or {}
                pair = current_pair(doc)
                if self._reserved(pair) and last.get("id") != doc["active"]:
                    new_rollback = (last.get("phase") in ("rolled_back", "rolled_back_start_failed")
                                    and last.get("id") != doc.get("last_router_event", doc["router_event"]))
                    for name, target in pair["versions"].items():
                        if (inv.get("held", {}).get(name) == target and
                                (previous_held.get(name) != target or new_rollback and name == last.get("component"))):
                            reason = f"The router rolled back {name} {target}. Review the combined update."
                            if pair["state"] == "pending":
                                pair["steps"] = dict.fromkeys(COMPONENTS, "skipped")
                                self._stop_pair(doc, pair, "cancelled", reason)
                            else:
                                pair["stop_reason"] = reason
                                pair["message"] = reason
                            break
                duration = last.get("duration_sec")
                if (last.get("action") == "install" and last.get("phase") == "installed"
                        and type(duration) is int and 0 < duration <= 86400):
                    doc["longest_install_sec"] = max(duration, doc.get("longest_install_sec", 0))
                if (valid_id(last.get("id")) and last.get("phase") in COMPLETE
                        and last["id"] != doc.get("last_router_event", doc["router_event"])):
                    ident = last["id"]
                    doc["last_router_event"] = ident
                    if last["phase"] != "rejected":
                        doc["router_event"] = ident
                    if ident != doc["active"] and ident not in doc["operations"]:
                        op = {**last, "source": "router", "at": self.clock().isoformat()}
                        self._record(doc, op)
                        # A single offline restore may unwind both components.
                        for name in COMPONENTS:
                            schedule = doc["once"].get(name)
                            held = inv.get("held", {}).get(name)
                            if (last["phase"] != "rejected" and schedule and
                                    schedule["version"] in (held, inv["components"][name].get("installed"))):
                                doc["once"].pop(name)
                if doc != self.doc:
                    self._save(doc)
            return inv

    def refresh(self):
        with self.refresh_lock:
            inv = self._sync()
            with self.lock:
                retry = self.doc["retry_at"]
                if retry and self.clock() < parse_time(retry):
                    return self.status()
            installed = {k: inv["components"][k]["installed"] for k in COMPONENTS}
            try:
                rows = self._catalog().list_releases(inv["arch"], installed)
                if isinstance(rows, list) and hasattr(self._catalog(), "get_release"):
                    with self.lock:
                        pins = [(c, job["version"]) for c, job in self.doc["once"].items()]
                        pair = current_pair(self.doc)
                        if self._reserved(pair):
                            pins.extend((c, v) for c, v in pair["versions"].items() if pair["steps"][c] == "pending")
                        active = self._active(self.doc)
                        if active and active["action"] == "install":
                            pins.append((active["component"], active["version"]))
                    for name, version in dict.fromkeys(pins):
                        if not any(r["component"] == name and r["version"] == version for r in rows):
                            extra = self._catalog().get_release(inv["arch"], installed, name, version)
                            if extra:
                                rows.append(extra)
                if not isinstance(rows, list):
                    raise ValueError()
            except Exception as err:
                with self.lock:
                    doc = copy.deepcopy(self.doc)
                    retry_sec = getattr(err, "retry_after", None)
                    delay = timedelta(seconds=max(60, retry_sec)) if isinstance(retry_sec, int) else RETRY_CATALOG
                    doc.update(catalog_error="Release catalog unavailable. Showing the last known releases.",
                               retry_at=(self.clock() + delay).isoformat())
                    self._save(doc)
            else:
                with self.lock:
                    doc = copy.deepcopy(self.doc)
                    doc.update(releases=rows, checked_at=self.clock().isoformat(), catalog_error=None, retry_at=None,
                               catalog_versions=installed, catalog_arch=inv["arch"])
                    self._save(doc)
        return self.status()

    def configure(self, body):
        if (not isinstance(body, dict) or set(body) != {*COMPONENTS, "time"}
                or any(type(body[c]) is not bool for c in COMPONENTS)
                or not isinstance(body["time"], str) or not CLOCK.fullmatch(body["time"])):
            raise RoutingError("Choose daily installation settings and a Moscow time.")
        with self.lock:
            doc = copy.deepcopy(self.doc)
            previous = doc["automatic"]
            enabled_at = doc.setdefault("auto_changed_at", {})
            for name in COMPONENTS:
                if previous[name] != body[name] or previous["time"] != body["time"]:
                    enabled_at[name] = self.clock().isoformat()
            doc["automatic"] = dict(body)
            self._save(doc)
        return self.status()

    def _release(self, doc, name, version):
        if doc["catalog_error"] or doc["router_error"]:
            raise RoutingError("Refresh router versions and the release catalog before installing.", 409, "precondition")
        row = next((r for r in doc["releases"] if r["component"] == name and r["version"] == version), None)
        current = doc["inventory"].get("components", {}).get(name, {}).get("installed")
        if not version_key(current):
            raise RoutingError("Installed version could not be identified.", 409, "precondition")
        if version_key(version) <= version_key(current):
            raise RoutingError("The selected release is no longer newer than the installed version.", 409, "precondition")
        if not row:
            raise RoutingError("The selected stable release was withdrawn from the catalog.", 409, "precondition")
        if not row["supported"] or not DIGEST.fullmatch(row.get("sha256") or ""):
            raise RoutingError("The selected release is unsupported or has no trusted checksum.", 409, "precondition")
        return row

    @contextmanager
    def _admission(self):
        if not self.parent._op_lock.acquire(blocking=False):
            raise RoutingError("Router is busy.", 409, "busy")
        try:
            with self.parent.route_checks.admission_lock, self.lock:
                yield
        finally:
            self.parent._op_lock.release()

    def _require_idle(self, doc):
        if self._active(doc) or self.parent.route_checks.running():
            raise RoutingError("Another router operation is in progress.", 409, "busy")
        self.parent.routing.ensure_idle(include_updates=False)

    def _require_no_pair(self, doc):
        if self._reserved(current_pair(doc)):
            raise RoutingError("A combined update already reserves both components.", 409, "conflict")

    def create_pair(self, body):
        if (not isinstance(body, dict) or set(body) - {"id", "versions", "at", "replace_schedules"} or not valid_id(body.get("id"))
                or not isinstance(body.get("versions"), dict) or set(body["versions"]) != set(COMPONENTS)
                or not all(version_key(v) for v in body["versions"].values())):
            raise RoutingError("Choose a release for both XKeen and Xray.")
        ident, versions = body["id"], dict(body["versions"])
        at = parse_time(body["at"]).isoformat() if body.get("at") is not None else None
        replacing = body.get("replace_schedules", {})
        if (not isinstance(replacing, dict) or set(replacing) - set(COMPONENTS)
                or any(not isinstance(pin, dict) or set(pin) != {"version", "at"} or not version_key(pin["version"])
                       for pin in replacing.values())):
            raise RoutingError("Invalid individual schedules to replace.")
        replacing = {c: {"version": pin["version"], "at": parse_time(pin["at"]).isoformat()}
                     for c, pin in replacing.items()}
        request = {"versions": versions, "at": at, "replace_schedules": replacing}
        with self._admission() if at is None else self.lock:
            doc = copy.deepcopy(self.doc)
            pairs = doc.setdefault("pairs", {})
            if ident in pairs:
                if pairs[ident]["request"] != request:
                    raise RoutingError("This combined update ID is already in use.", 409, "conflict")
                return self.status()
            if ident in doc["operations"]:
                raise RoutingError("This update ID is already in use.", 409, "conflict")
            self._require_no_pair(doc)
            pins = {c: pin for c, pin in doc["once"].items() if self._reserved(pin)}
            if (any(pin["state"] != "pending" for pin in pins.values()) or
                    {c: {"version": pin["version"], "at": pin["at"]} for c, pin in pins.items()} != replacing):
                raise RoutingError("Review the individual scheduled updates before replacing them.", 409, "conflict")
            now = self.clock()
            if at is None:
                self._require_idle(doc)
            elif parse_time(at) <= now:
                raise RoutingError("Choose a future date and time.")
            elif self._active(doc):
                raise RoutingError("Wait for the router operation.", 409, "busy")
            digests = {name: self._release(doc, name, versions[name])["sha256"] for name in COMPONENTS}
            for name, pin in pins.items():
                if pin["version"] == versions[name] and pin["sha256"] != digests[name]:
                    raise RoutingError("The pinned release checksum changed. Review the individual schedule.", 409, "conflict")
                del doc["once"][name]
            pair = {"id": ident, "at": at, "versions": versions, "request": request, "digests": digests,
                    "installed_before": {c: doc["inventory"]["components"][c]["installed"] for c in COMPONENTS},
                    "state": "pending", "steps": dict.fromkeys(COMPONENTS, "pending"), "message": None}
            pairs[ident] = pair
            doc["pair_id"] = ident
            if at is None:
                self._queue_pair_step(doc, pair, "xkeen", now + WINDOW["once"])
            self._save(doc)
        if at is None:
            self._wake()
        return self.status()

    def _pending_pair(self, doc, ident):
        if not valid_id(ident):
            raise RoutingError("Invalid combined update ID.")
        pair = current_pair(doc)
        if not pair or pair["id"] != ident or pair["state"] != "pending":
            raise RoutingError("The combined schedule is no longer pending.", 409, "conflict")
        return pair

    def cancel_pair(self, ident):
        with self.lock:
            doc = copy.deepcopy(self.doc)
            if valid_id(ident) and doc.get("pairs", {}).get(ident, {}).get("state") == "cancelled":
                return self.status()
            pair = self._pending_pair(doc, ident)
            pair.update(state="cancelled", steps=dict.fromkeys(COMPONENTS, "skipped"), message=None)
            self._save(doc)
        return self.status()

    def reschedule_pair(self, body):
        if not isinstance(body, dict) or set(body) != {"id", "at"}:
            raise RoutingError("Choose the combined schedule and a future time.")
        at = parse_time(body["at"])
        with self.lock:
            doc = copy.deepcopy(self.doc)
            pair = self._pending_pair(doc, body["id"])
            if at <= self.clock():
                raise RoutingError("Choose a future date and time.")
            pair.update(at=at.isoformat(), message=None)
            self._save(doc)
        return self.status()

    def _queue_pair_step(self, doc, pair, name, deadline):
        now = self.clock()
        ident = new_id()
        body = {"id": ident, "component": name, "version": pair["versions"][name], "action": "install"}
        op = {**body, "request": body, "pair_id": pair["id"], "from": pair["installed_before"][name],
              "source": "once" if pair["at"] else "manual", "phase": "preparing", "at": now.isoformat(),
              "deadline": deadline.isoformat(), "expires": int(deadline.timestamp()),
              "archive_sha256": pair["digests"][name], "message": "Preparing the combined update",
              "main_before": self.parent.state.read_state().get("active_code")}
        pair["steps"][name] = "running"
        pair.update(state="running", message=None)
        self._record(doc, op)
        doc["active"] = ident

    def _verify_pair(self, doc, op):
        pair = doc["pairs"][op["pair_id"]]
        if pair.get("stop_reason"):
            raise RoutingError(pair["stop_reason"], 409, "conflict")
        installed = doc["inventory"]["components"]
        for name in COMPONENTS:
            if pair["steps"][name] == "installed":
                if installed[name]["installed"] != pair["versions"][name]:
                    raise RoutingError("XKeen changed after the first step. The combined update stopped.", 409, "conflict")
                continue
            row = self._release(doc, name, pair["versions"][name])
            if row["sha256"] != pair["digests"][name]:
                raise RoutingError("The pinned release checksum changed. Review the combined update.", 409, "conflict")
            if installed[name]["installed"] != pair["installed_before"][name]:
                raise RoutingError("An installed version changed. Review the combined update.", 409, "conflict")

    def schedule(self, body):
        if not isinstance(body, dict) or set(body) != {"component", "version", "at"}:
            raise RoutingError("Choose a component, release and time.")
        name = body["component"]
        require_component(name)
        at = parse_time(body["at"])
        if at <= self.clock():
            raise RoutingError("Choose a future date and time.")
        with self.lock:
            self._require_no_pair(self.doc)
            if self.active():
                raise RoutingError("Wait for the router operation.", 409, "busy")
            doc = copy.deepcopy(self.doc)
            row = self._release(doc, name, body["version"])
            doc["once"][name] = {"version": row["version"], "sha256": row["sha256"], "at": at.isoformat(),
                                 "state": "pending", "reason": None}
            self._save(doc)
        return self.status()

    def cancel(self, component):
        require_component(component)
        with self.lock:
            if self.active():
                raise RoutingError("Wait for the router operation.", 409, "busy")
            doc = copy.deepcopy(self.doc)
            doc["once"].pop(component, None)
            self._save(doc)
        return self.status()

    @staticmethod
    def _record(doc, op):
        ident = op["id"]
        doc["operations"][ident] = op
        doc["recent"] = [ident, *(old for old in doc["recent"] if old != ident)][:50]

    def start(self, body, *, source="manual", job=None):
        if (not isinstance(body, dict) or set(body) - {"action", "id", "component", "version", "cancel_schedule", "plan", "revision"}
                or not valid_id(body.get("id")) or not version_key(body.get("version"))
                or body.get("component") not in COMPONENTS or body.get("action") not in ("install", "rollback")
                or type(body.get("cancel_schedule", False)) is not bool):
            raise RoutingError("Invalid router update request.")
        ident, name = body["id"], body["component"]
        require_component(name)
        with self._admission():
            doc = copy.deepcopy(self.doc)
            old = doc["operations"].get(ident)
            if old:
                if old.get("request") != body:
                    raise RoutingError("This update ID is already in use.", 409, "conflict")
                return self.status()
            self._require_no_pair(doc)
            if ident in doc.get("pairs", {}):
                raise RoutingError("This update ID is already in use.", 409, "conflict")
            self._require_idle(doc)
            inv = doc["inventory"]
            comp = inv.get("components", {}).get(name, {})
            current = comp.get("installed")
            op = {"id": ident, "request": body, "component": name, "version": body["version"], "from": current,
                  "action": body["action"], "source": source, "phase": "preparing",
                  "at": self.clock().isoformat(), "message": "Preparing router operation",
                  "main_before": self.parent.state.read_state().get("active_code")}
            pending = doc["once"].get(name)
            if job is not None and (source == "once" and pending != job or source == "auto" and (
                    doc["automatic"] != job or self._reserved(pending))):
                raise RoutingError("Schedule changed.", 409, "conflict")
            if source != "manual":
                start = parse_time(pending["at"]) if source == "once" else self._daily_start(
                    self.clock().astimezone(MSK), doc["automatic"]["time"])
                op["deadline"] = (start + WINDOW[source]).isoformat()
                op["expires"] = int((start + WINDOW[source]).timestamp())
            if body["action"] == "install":
                row = self._release(doc, name, body["version"])
                if source == "once" and row["sha256"] != pending["sha256"]:
                    raise RoutingError("Pinned release digest changed.", 409, "precondition")
                if self._reserved(pending) and pending["version"] != op["version"] and not body.get("cancel_schedule"):
                    raise RoutingError("Confirm cancellation of the pinned release.", 409, "conflict")
                op["archive_sha256"] = row["sha256"]
            else:
                plan = comp.get("rollback_plan", [])
                if (doc["router_error"] or not plan or body.get("plan") != plan or
                        not inv.get("revision") or body.get("revision") != inv["revision"] or
                        not any(item["component"] == name and item["to"] == op["version"] for item in plan)):
                    raise RoutingError("Rollback plan changed. Review the current restore points.", 409, "conflict")
                op["revision"] = inv.get("revision")
                reserved = [item for item in plan if self._reserved(doc["once"].get(item["component"]))]
                if reserved and not body.get("cancel_schedule"):
                    raise RoutingError("Confirm cancellation of pinned updates for the restored components.", 409, "conflict")
            if source == "auto":
                doc["auto_last"][name] = self.clock().astimezone(MSK).date().isoformat()
            original_jobs = copy.deepcopy(doc["once"])
            if pending and (source == "once" or body.get("cancel_schedule") or pending["version"] == body["version"]):
                doc["once"][name] = {**pending, "state": "running"}
            if body["action"] == "rollback" and body.get("cancel_schedule"):
                for row in plan:
                    cname = row["component"]
                    if cname in doc["once"]:
                        doc["once"][cname] = {**doc["once"][cname], "state": "running"}
            op["reserved_jobs"] = {c: saved for c, saved in original_jobs.items()
                                   if doc["once"][c]["state"] == "running"}
            self._record(doc, op)
            doc["active"] = ident
            self._save(doc)
        self._wake()
        return self.status()

    @staticmethod
    def _reserved(pending):
        return pending and pending["state"] in ("pending", "running")

    def _wake(self):
        with self.worker_lock:
            if self.stop_event.is_set() or self.worker and self.worker.is_alive():
                return
            self.worker = threading.Thread(target=self._work, daemon=True, name="router-software")
            self.worker.start()

    def stop(self):
        self.stop_event.set()

    def _work(self):
        retry = 1
        while not self.stop_event.is_set():
            with self.lock:
                ident = self.doc["active"]
                if not ident:
                    return
                op = copy.deepcopy(self.doc["operations"][ident])
            retry = min(retry * 2, 30) if self._advance(op) else 1
            with self.lock:
                if self.doc["active"] != ident:
                    continue
            if op.get("deadline") and op["phase"] in ("preparing", "submitting"):
                retry = min(retry, max(0, (parse_time(op["deadline"]) - self.clock()).total_seconds()))
            if self.stop_event.wait(max(retry, 5 if op["phase"] == "interrupted" else 1)):
                return

    def _advance(self, op):
        """Return true when the next observation should use bounded backoff."""
        try:
            return self._step(op)
        except PreparationUnavailable as err:
            reason = str(err)
            if op.get("deadline") and self.clock() < parse_time(op["deadline"]):
                self._progress(op["id"], message=f"{reason} Retrying within the installation window.", retry_reason=reason)
                return True
            expired = bool(op.get("deadline"))
            self._finish(op, "rejected", ("Installation window missed. " if expired else "") + reason, missed=expired)
        except Exception as err:
            log.warning("Router update reconciliation: %s", type(err).__name__)
            if op["phase"] == "preparing":
                reason = str(err) if isinstance(err, RoutingError) else "Could not stage the release locally."
                self._finish(op, "rejected", reason)
            else:
                self._progress(op["id"], message="Waiting for the router journal. The operation will be reconciled.")
                return True
        return False

    def recover(self, ident):
        if not valid_id(ident):
            raise RoutingError("Invalid recovery ID.")
        with self.lock:
            local = self.doc["operations"].get(ident)
            missing = local and self.doc["active"] == ident and local["phase"] == "journal_missing"
        if missing:
            # Recheck only. This path cannot submit or recover a different router operation.
            self._advance(copy.deepcopy(local))
            return self.status()
        with self.lock:
            doc = copy.deepcopy(self.doc)
            active = self._active(doc)
            if not active or active["id"] != ident or active["phase"] not in ("interrupted", "recovering"):
                raise RoutingError("This interrupted operation is no longer current.", 409, "conflict")
            if not doc["active"]:
                remote = doc["inventory"]["active"]
                op = {**remote, "at": self.clock().isoformat(), "source": "router"}
                self._record(doc, op)
                doc["active"] = ident
            doc["operations"][ident].update(phase="recovering", message="Requesting manual recovery")
            self._save(doc)
        self._wake()
        return self.status()

    def _progress(self, ident, *, expected=None, **changes):
        with self.lock:
            if self.doc["active"] != ident:
                return
            doc = copy.deepcopy(self.doc)
            if expected and doc["operations"][ident]["phase"] != expected:
                return
            doc["operations"][ident].update(changes)
            if doc != self.doc:
                self._save(doc)

    def _payload_path(self, ident):
        return self.path.parent / "router-update-staging" / ident

    def _step(self, op):
        ident = op["id"]
        pair_stop = None
        if op.get("pair_id"):
            with self.lock:
                pair_stop = self.doc["pairs"][op["pair_id"]].get("stop_reason")
            if pair_stop and op["phase"] in ("preparing", "submitting"):
                self._finish(op, "rejected", pair_stop)
                return
        # No command has been issued in either phase. After sending the request,
        # only a definite router reply may rule out an install, even after expiry.
        if (op["phase"] in ("preparing", "submitting") and op.get("deadline")
                and self.clock() >= parse_time(op["deadline"])):
            reason = op.get("retry_reason") or "The release was not submitted in time."
            self._finish(op, "rejected", "Installation window missed. " + reason, missed=True)
            return
        if op["phase"] == "preparing":
            if op["action"] == "install":
                # Re-resolve even for a manual install: an upstream release can be withdrawn or replaced.
                try:
                    self.refresh()
                except RoutingError as err:
                    if err.code == "router_unavailable":
                        raise PreparationUnavailable("Router inventory unavailable over SSH.") from err
                    raise
                with self.lock:
                    if self.doc["catalog_error"]:
                        raise PreparationUnavailable("The official release catalog is unavailable.")
                    if op.get("pair_id"):
                        self._verify_pair(self.doc, op)
                    row = self._release(self.doc, op["component"], op["version"])
                    if row["sha256"] != op["archive_sha256"]:
                        raise RoutingError("The pinned release checksum changed. Choose the release again.", 409)
                try:
                    payload = self._catalog().payload(row)
                except urllib.error.HTTPError as err:
                    if err.code in (404, 410):
                        raise RoutingError("The pinned release artifact was withdrawn.", 409) from err
                    raise PreparationUnavailable("The official release server is unavailable.") from err
                except (OSError, http.client.HTTPException) as err:
                    raise PreparationUnavailable("The official release download was interrupted.") from err
                except ReleaseChecksumChanged as err:
                    raise RoutingError("The downloaded archive does not match the pinned release checksum.", 409) from err
                except (ValueError, zipfile.BadZipFile) as err:
                    raise RoutingError("The archive failed local release validation.", 409) from err
                atomic(self._payload_path(ident), payload)
                self._progress(ident, transfer_sha256=hashlib.sha256(payload).hexdigest(),
                               phase="submitting", message="Sending the verified release to the router")
            else:
                inv = self._sync()
                if inv.get("revision") != op["revision"]:
                    self._finish(op, "rejected", "Restore points changed. Review the updated rollback plan.")
                else:
                    self._progress(ident, phase="submitting", message="Requesting rollback on the router")
            return
        observed_at = self.clock()
        try:
            remote = self.parent.router.update_status(ident)
        except (RouterError, OSError) as err:
            if op["phase"] == "submitting":
                raise PreparationUnavailable("The router could not be reached before submission.") from err
            raise
        phase = remote["phase"]
        if (remote.get("id") != ident or (phase != "unknown" and
                any(remote.get(key) != op.get(key) for key in ("component", "action", "version")))):
            self._progress(ident, phase="journal_missing", message=JOURNAL_MISSING)
            return True
        if phase in COMPLETE:
            self._sync()
            if phase != "rejected":
                self.parent.probe_xkeen()
            missed = (phase == "rejected" and bool(op.get("deadline"))
                      and remote.get("message") == "Scheduled installation window closed")
            fallback = "Installation window closed on the router." if missed else RESULT_MESSAGES[phase]
            self._finish(op, phase, router_message(remote, fallback), missed=missed, duration=remote.get("duration_sec"))
        elif phase == "unknown" and op["phase"] in ("submitting", "awaiting_receipt"):
            # The worker may be resuming after a long server outage or download. An
            # acknowledged helper ID is reconciled regardless of its original window.
            if op.get("pair_id") and self.clock() < parse_time(op["deadline"]):
                # The standalone router menu can restore XKeen while Xray is being
                # downloaded or waiting for admission. Check prerequisites again.
                try:
                    self._sync()
                except RoutingError as err:
                    if op["phase"] == "submitting":
                        raise PreparationUnavailable("Router inventory unavailable over SSH.") from err
                    raise
                with self.lock:
                    try:
                        self._verify_pair(self.doc, op)
                    except RoutingError as err:
                        if op["phase"] == "submitting":
                            self._finish(op, "rejected", str(err))
                            return
                        # A submission may still be in flight. Only an expired
                        # replay can safely obtain its result without starting it.
                        self._progress(ident, message="Checking whether the router already accepted this step.")
                        return True
            if op["action"] == "install" and self._conflict(self.clock().astimezone(MSK)):
                if op["phase"] == "submitting" and not op.get("deadline"):
                    self._finish(op, "rejected", "Installation overlaps scheduled router maintenance.")
                    return
                # A lost reply can also mean the original submission never arrived.
                # Replay during maintenance only after router-side expiry guarantees
                # this UUID can reconcile an existing record but cannot start a new install.
                if not op.get("deadline") or self.clock() < parse_time(op["deadline"]):
                    self._progress(ident, retry_reason="Scheduled router maintenance overlaps the installation.",
                                   message="Waiting for scheduled router maintenance.")
                    return True
            payload = self._payload_path(ident).read_bytes() if op["action"] == "install" else None
            sent = {}
            if op.get("pair_id") and not op.get("first_send"):
                sent["first_send"] = self.clock().isoformat()
            self._progress(ident, phase="awaiting_receipt", message="Waiting for router acceptance", **sent)
            try:
                receipt = self.parent.router.update_submit(op, payload)
                if receipt and (receipt.get("id") == ident and receipt.get("phase") in PHASES - {"unknown"} and
                                all(receipt.get(key) == op.get(key) for key in ("component", "action", "version"))):
                    self._progress(ident, phase="accepted", message="Request accepted. Reading the router journal.")
            except RoutingError as err:
                # A positive helper refusal before admission; transport ambiguity raises RouterError instead.
                if self.parent.router.update_status(ident)["phase"] == "unknown":
                    if err.code == "busy" and (op.get("deadline") or op["phase"] == "awaiting_receipt"):
                        # A preceding ambiguous attempt could still be staging its own request
                        # under the router lock. Wait for definitive acceptance or expiry.
                        self._progress(ident, phase=op["phase"], retry_reason="The router was busy.",
                                       message="Waiting for the current router operation")
                        return True
                    else:
                        missed = err.code == "expired"
                        self._finish(op, "rejected", str(err), missed=missed)
        elif phase == "unknown":
            self._progress(ident, phase="journal_missing", message=JOURNAL_MISSING)
            return True
        elif phase == "interrupted":
            if op["phase"] == "recovering":
                try:
                    self.parent.router.update_recover(ident)
                except RoutingError:
                    self._progress(ident, phase="interrupted", message="Recovery could not start. Review the restore point.")
                return
            self._sync()
            self._progress(ident, expected=op["phase"], phase="interrupted",
                           message="Update interrupted. Review the manual recovery options.")
        elif phase in PHASES - {"unknown"}:
            local_phase = "accepted" if phase == "preparing" else phase
            progress = {}
            if op.get("pair_id") and op["component"] == "xkeen":
                last = op.get("last_in_progress")
                if not last or observed_at - parse_time(last) >= RETRY_CATALOG:
                    progress["last_in_progress"] = observed_at.isoformat()
            message = router_message(remote, "Router is " + phase + " the software.")
            self._progress(ident, phase=local_phase, message=message, **progress)
        else:
            self._progress(ident, phase="journal_missing", message=JOURNAL_MISSING)
            return True

    def _finish(self, op, phase, message, *, missed=False, duration=None):
        with self.lock:
            ident = op["id"]
            if self.doc["active"] != ident:
                return
            doc = copy.deepcopy(self.doc)
            entry = doc["operations"][ident]
            entry.update(phase=phase, message=message)
            if op["source"] == "auto" and phase != "installed":
                doc["auto_failed_day"] = parse_time(op["at"]).astimezone(MSK).date().isoformat()
            doc["active"] = None
            if entry.get("pair_id"):
                self._finish_pair_step(doc, entry, missed, duration)
            for name, pending in list(doc["once"].items()):
                if pending["state"] == "running":
                    if phase == "rejected" and op["source"] == "manual":
                        doc["once"][name] = op.get("reserved_jobs", {}).get(name) or {**pending, "state": "pending"}
                    elif phase == "rejected":
                        pending.update(state="missed" if missed else "failed", reason=message)
                    else:
                        doc["once"].pop(name)
            if phase in ("rolled_back", "rolled_back_start_failed"):
                for name in COMPONENTS:
                    pin = doc["once"].get(name)
                    if pin and doc["inventory"].get("held", {}).get(name) == pin["version"]:
                        doc["once"].pop(name)
            self._save(doc)
            self._payload_path(ident).unlink(missing_ok=True)

    def _finish_pair_step(self, doc, op, missed, duration):
        pair = doc["pairs"][op["pair_id"]]
        name = op["component"]
        failed_step = "start_unconfirmed" if op["phase"] == "start_failed" else "failed"
        if reason := pair.get("stop_reason"):
            pair["steps"][name] = "installed" if op["phase"] == "installed" else failed_step
            if name == "xkeen":
                pair["steps"]["xray"] = "skipped"
            self._stop_pair(doc, pair, "failed", reason)
            return
        if op["phase"] != "installed":
            pair["steps"][name] = "skipped" if missed else failed_step
            if name == "xkeen":
                pair["steps"]["xray"] = "skipped"
            self._stop_pair(doc, pair, "missed" if missed else "failed", op["message"])
            return
        pair["steps"][name] = "installed"
        if name == "xray":
            self._stop_pair(doc, pair, "installed", "Both versions installed. Check the route manually.")
            return
        # The helper returns duration rather than a wall-clock completion timestamp.
        # Bound the continuation by evidence from this install: a receipt discovered
        # after a long server outage must not start the next step during the day.
        sent = parse_time(op.get("first_send", op["at"]))
        seconds = duration - 1 if type(duration) is int and 0 < duration <= 86400 else 0
        last_live = parse_time(op.get("last_in_progress", op.get("first_send", op["at"])))
        now = self.clock()
        deadline = min(now, max(sent + timedelta(seconds=seconds), last_live)) + WINDOW["once"]
        if now >= deadline:
            pair["steps"]["xray"] = "skipped"
            self._stop_pair(doc, pair, "missed", "XKeen installed. The window to start Xray has passed.")
        else:
            # Publish the first receipt and the next child in one write, under the
            # same mutation block. The existing worker immediately follows doc.active.
            self._queue_pair_step(doc, pair, "xray", deadline)

    def _stop_pair(self, doc, pair, state, message):
        pair.update(state=state, message=message)
        # An explicitly pinned release also consumes that day's automatic run.
        # Otherwise an eligible newer release could immediately undo the choice.
        now = self.clock().astimezone(MSK)
        day = min(parse_time(pair["at"]), now) if pair["at"] else now
        daily = self._daily_start(now, doc["automatic"]["time"])
        if daily <= now < daily + WINDOW["auto"]:
            day = now
        for name in COMPONENTS:
            doc["auto_last"][name] = max(doc["auto_last"].get(name, ""), day.astimezone(MSK).date().isoformat())

    @staticmethod
    def _before_enabled(doc, name, occurrence):
        change = doc.get("auto_changed_at", {}).get(name)
        return bool(change and occurrence < parse_time(change))

    @staticmethod
    def _daily_start(day, time):
        hour, minute = (int(v) for v in time.split(":"))
        return day.replace(hour=hour, minute=minute, second=0, microsecond=0)

    def _maintenance_lead_minutes(self):
        # Keep the initial reserve or the longest observed router install plus one polling interval.
        with self.lock:
            measured = self.doc.get("longest_install_sec", 0)
        return max(int(MAINTENANCE_MARGIN.total_seconds() // 60), (measured + 30 + 59) // 60)

    def _conflict(self, moment):
        lead = timedelta(minutes=self._maintenance_lead_minutes())
        def overlaps(maintenance):
            return -MAINTENANCE_MARGIN < maintenance - moment < lead

        st = self.parent.state.read_state()
        clocks = ["04:00"]
        if st.get("auto_update_enabled", True) and st.get("auto_update_mode", "daily") == "daily":
            clocks.append(st.get("auto_update_daily_time", "04:30"))
        for clock in clocks:
            day_time = self._daily_start(moment, clock)
            if any(overlaps(day_time + timedelta(days=d)) for d in (-1, 0, 1)):
                return True
        due = self.parent.auto_update_status(st)["next_apply_at"]
        return bool(due and overlaps(parse_time(due)))

    def _update_waiting_pins(self, now, reason=None):
        with self.lock:
            doc = copy.deepcopy(self.doc)
            for pin in doc["once"].values():
                if pin["state"] != "pending" or now < parse_time(pin["at"]):
                    continue
                if now >= parse_time(pin["at"]) + WINDOW["once"]:
                    why = pin.get("reason") or reason or "No install started during its window."
                    pin.update(state="missed", reason=f"Installation window missed. {why} Choose a new time.")
                elif reason:
                    pin["reason"] = reason
            if doc != self.doc:
                self._save(doc)

    def _tick_pair(self, now, wait_reason):
        with self.lock:
            pair = current_pair(self.doc)
            if not self._reserved(pair):
                return False
            if pair["state"] == "running" or now < parse_time(pair["at"]):
                return True
            ident = pair["id"]
            deadline = parse_time(pair["at"]) + WINDOW["once"]
            if now >= deadline or wait_reason:
                doc = copy.deepcopy(self.doc)
                pair = current_pair(doc)
                if now >= deadline:
                    reason = pair["message"] or wait_reason or "The combined update did not start in time."
                    pair["steps"] = dict.fromkeys(COMPONENTS, "skipped")
                    self._stop_pair(doc, pair, "missed", "Installation window missed. " + reason)
                else:
                    pair["message"] = wait_reason
                if doc != self.doc:
                    self._save(doc)
                return True
        try:
            with self._admission():
                doc = copy.deepcopy(self.doc)
                pair = current_pair(doc)
                # A concurrent tick, cancel or reschedule can win admission.
                if (not pair or pair["id"] != ident or pair["state"] != "pending"
                        or deadline != parse_time(pair["at"]) + WINDOW["once"]):
                    return True
                self._require_idle(doc)
                self._queue_pair_step(doc, pair, "xkeen", deadline)
                self._save(doc)
        except RoutingError as err:
            if err.code != "busy":
                raise
            with self.lock:
                doc = copy.deepcopy(self.doc)
                pair = current_pair(doc)
                if pair and pair["id"] == ident and pair["state"] == "pending":
                    pair["message"] = "Another operation is using the router."
                    if doc != self.doc:
                        self._save(doc)
            return True
        self._wake()
        return True

    def tick(self):
        if self.doc["active"]:
            self._update_waiting_pins(self.clock(), "Another software operation occupies the router.")
            self._wake()
            return
        now = self.clock()
        with self.lock:
            checked = self.doc["checked_at"]
            retry = self.doc["retry_at"]
            inv = self.doc["inventory"]
            installed = {k: inv.get("components", {}).get(k, {}).get("installed") for k in COMPONENTS}
            due = (not checked or now - parse_time(checked) >= CATALOG_INTERVAL or self.doc["catalog_error"]
                   or installed != self.doc.get("catalog_versions") or inv.get("arch") != self.doc.get("catalog_arch"))
        try:
            if due and (not retry or now >= parse_time(retry)):
                self.refresh()
            else:
                self._sync()
        except RoutingError:
            pass
        now = self.clock()
        local = now.astimezone(MSK)
        with self.lock:
            wait_reason = self.doc["router_error"] or self.doc["catalog_error"]
        if self.active():
            wait_reason = "Another software operation occupies the router."
        elif self._conflict(local):
            wait_reason = "The installation overlaps scheduled router maintenance."
        self._update_waiting_pins(now, wait_reason)
        if self._tick_pair(now, wait_reason):
            return
        if wait_reason:
            return
        with self.lock:
            doc = copy.deepcopy(self.doc)
            auto = doc["automatic"]
        for name in COMPONENTS:
            pin = doc["once"].get(name)
            if self._reserved(pin):
                if parse_time(pin["at"]) > now:
                    continue
                source, job, version = "once", pin, pin["version"]
            else:
                since = self._daily_start(local, auto["time"])
                if (not auto[name] or self._before_enabled(doc, name, since)
                        or doc.get("auto_failed_day") == local.date().isoformat() or
                        not since <= local < since + WINDOW["auto"] or
                        doc["auto_last"].get(name) == local.date().isoformat()):
                    continue
                supported = next((row for row in self.available() if row["component"] == name), None)
                if not supported:
                    continue
                source, job, version = "auto", auto, supported["version"]
            try:
                self.start({"id": new_id(), "component": name, "version": version, "action": "install"},
                           source=source, job=job)
            except RoutingError as err:
                if err.code == "busy":
                    self._update_waiting_pins(now, "Another operation is using the router.")
                if source == "once" and err.code == "precondition":
                    with self.lock:
                        current = copy.deepcopy(self.doc)
                        if current["once"].get(name) == pin:
                            current["once"][name].update(state="failed", reason=str(err))
                            self._save(current)
                return
            return

class MockCatalog:
    @staticmethod
    def list_releases(arch, installed):
        result = []
        for name, versions in (("xkeen", ("2.1",)), ("xray", ("26.11.9", "26.10.31"))):
            for version in versions:
                payload = (name + ":" + version).encode()
                result.append({"component": name, "version": version, "supported": True,
                               "reason": None, "sha256": hashlib.sha256(payload).hexdigest()})
        return result

    @staticmethod
    def payload(row):
        return (row["component"] + ":" + row["version"]).encode()
