"""Pre-switch route checks for direct and chained Main routes.

Results are diagnostics only: they never feed Main health, failover or the
installed configuration. A result binds the ordered route, the exact candidate
bytes of the Main generator and the check conditions.
"""
import json
import logging
import random
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from . import route_probe
from .connectivity import ROUTE_CHECK_TIMEOUT_SEC, ROUTE_CHECK_USER_AGENT
from .routing import RoutingError, digest, valid_id
from .routing_store import TERMINAL, atomic
from .subscription import Location

log = logging.getLogger(__name__)

CHECKS_FILE = "route-checks.json"
REQUESTS_FILE = "route-check-requests.sqlite3"
SCHEMA_VERSION = 2
PROBE_VERSION = 1
FRESH_SEC = 600
ROUNDS = 2
PARALLEL = 2
KEEP_RUNS = 20
PORT_ATTEMPTS = 3
CANCEL_WAIT_SEC = 3
SINGLE_KEY = "single"
CHAIN = "chain"
LEGACY = "legacy"
RUNNING = "running"
COMPLETED = "completed"
INTERRUPTED = "interrupted"
CANCELLED = "cancelled"
QUEUED = "queued"
CHECKING = "checking"
DONE = "done"
WORKING = "working"
UNCHECKED = "unchecked"
STALE = "stale"
UNAVAILABLE = "unavailable"
STALE_CODE = "stale_check"
STALE_REASONS = {
    "expired": "Checked more than 10 minutes ago",
    "config": "Location configuration changed since the check",
    "missing": "A location of this route is no longer in the subscription",
    "conditions": "Test sites or check settings changed since the check",
}
INTERRUPTED_REASON = "The service restarted before this check finished"
MISSING_REASON = "This location left the subscription"
SSH_REASON = "Could not run the check on the router"
UNEXPECTED_REASON = "The check stopped unexpectedly"
STOPPED_REASON = "Stopped before this route was checked"

def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds")

def _parse(value: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if value else None
    except ValueError:
        return None

class RouteChecks:
    def __init__(self, parent, *, probe: Callable | None = None, now: Callable[[], datetime] | None = None,
                 parallel: int = PARALLEL):
        self.parent = parent
        self._path = Path(parent.state.data_dir) / CHECKS_FILE
        self._requests_uri = self._path.with_name(REQUESTS_FILE).resolve().as_uri()
        self.admission_lock = threading.RLock()
        self._cleanup_lock = threading.Lock()
        self._probe = probe or self._router_probe
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._parallel = parallel
        self._stop = threading.Event()
        self._threads: dict[str, threading.Thread] = {}
        self._cancels: dict[str, threading.Event] = {}

    # ---- storage -------------------------------------------------------
    def _read(self) -> dict:
        with self.admission_lock:
            try:
                doc = json.loads(self._path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {"schema_version": SCHEMA_VERSION, "runs": [], "index": {}}
            except (ValueError, OSError) as error:
                raise RoutingError("Could not read the route check journal", 503, "storage") from error
            try:
                if not isinstance(doc, dict) or not isinstance(doc.get("runs"), list):
                    raise ValueError("Invalid document")
                version = doc["schema_version"]
                if version not in (1, SCHEMA_VERSION):
                    raise ValueError("Unknown version")
                run_fields = {"exit_code", "exit_name", "created_at", "finished_at", "conditions_hash"}
                route_fields = {"key", "entry_code", "entry_name", "exit_code", "exit_name", "candidate_sha256", "state",
                                "outcome", "reason", "rounds", "finished_at"}
                for run in doc["runs"]:
                    if (not run_fields.issubset(run) or not isinstance(run["routes"], list)
                            or not all(route_fields.issubset(row) for row in run["routes"])
                            or (version == SCHEMA_VERSION and run["kind"] not in (SINGLE_KEY, CHAIN, LEGACY))
                            or run["state"] not in (RUNNING, COMPLETED, INTERRUPTED, CANCELLED)
                            or not valid_id(run["id"])):
                        raise ValueError("Invalid run")
                if version == 1:
                    self._migrate(doc)
                if (not isinstance(doc["index"], dict) or not isinstance(doc.get("past_requests", {}), dict)
                        or not isinstance(doc.get("reports", {}), dict)):
                    raise ValueError("Invalid result index")
                for slot in doc["index"].values():
                    if not isinstance(slot, dict) or not ("result" in slot or "last_attempt" in slot):
                        raise ValueError("Invalid index entry")
                    if "result" in slot and not (route_fields | {"run_id", "conditions_hash"}).issubset(slot["result"]):
                        raise ValueError("Incomplete result")
                    if "last_attempt" in slot and not {"run_id", "reason", "finished_at"}.issubset(slot["last_attempt"]):
                        raise ValueError("Incomplete attempt")
                return doc
            except (KeyError, TypeError, ValueError) as error:
                raise RoutingError("Could not read the route check journal", 503, "storage") from error

    def _migrate(self, doc):
        doc.update(schema_version=SCHEMA_VERSION, index={})
        # Run order breaks timestamp ties in old files.
        records = []
        for run in doc["runs"]:
            run["kind"] = LEGACY
            if run["state"] == RUNNING:
                self._interrupt(run, INTERRUPTED_REASON, INTERRUPTED)
            records.extend((run, row) for row in run["routes"] if row["state"] == DONE)
        for run, row in sorted(records, key=lambda record: record[1]["finished_at"]):
            self._index(doc, run, row)
        self._write(doc)

    @staticmethod
    def _pair(entry_code, exit_code):
        return json.dumps([entry_code, exit_code], separators=(",", ":"))

    def _index(self, doc, run, route):
        slot = doc["index"].setdefault(self._pair(route["entry_code"], route["exit_code"]), {})
        attempt = slot.get("last_attempt", {})
        result = slot.get("result", {})
        if route["outcome"] == UNAVAILABLE:
            if route["finished_at"] < max(attempt.get("finished_at", ""), result.get("finished_at", "")):
                return
            slot["last_attempt"] = {"run_id": run["id"], "reason": route["reason"], "finished_at": route["finished_at"]}
        else:
            slot["result"] = {**route, "run_id": run["id"], "conditions_hash": run["conditions_hash"]}
            if attempt.get("finished_at", "") <= route["finished_at"]:
                slot.pop("last_attempt", None)

    def _interrupt(self, run, reason, state):
        finished_at = _iso(self._now())
        pending = [route for route in run["routes"] if route["state"] != DONE]
        for route in pending:
            route.update(state=DONE, outcome=UNAVAILABLE, reason=reason, rounds=[], finished_at=finished_at)
        run.update(state=state, finished_at=finished_at)
        return pending

    def _write(self, doc: dict) -> None:
        with self.admission_lock:
            archive = doc.pop("past_requests", {})
            runs = doc["runs"]
            while len(runs) > KEEP_RUNS:
                oldest = next((run for run in runs if run["state"] != RUNNING), None)
                if oldest is None:
                    break
                # Keep replay protection and per-step reports when detailed runs age out.
                composition = [r["key"] for r in oldest["routes"]]
                signature = self._signature(oldest["kind"], oldest["exit_code"], composition)
                archive[oldest["id"]] = signature
                reports = doc.setdefault("reports", {})
                summary = self._run_summary(oldest)
                reports[self._pair(summary["kind"], oldest["exit_code"])] = summary
                if oldest["kind"] != SINGLE_KEY:
                    doc["last_chain_report"] = summary
                runs.remove(oldest)
            if archive:
                # Commit the archive first. A crash before the JSON rename leaves
                # the same signatures in the old journal, ready for an idempotent retry.
                self._archive_requests(archive, create=not doc.get("requests_archived"))
                doc["requests_archived"] = True
            try:
                atomic(self._path, json.dumps(doc, ensure_ascii=False, indent=1).encode())
            except OSError as error:
                raise RoutingError("Could not save the route check journal", 503, "storage") from error

    def _archive_requests(self, signatures, *, create):
        uri = self._requests_uri + ("?mode=rwc" if create else "?mode=rw")
        try:
            with closing(sqlite3.connect(uri, uri=True)) as db, db:
                db.execute("PRAGMA synchronous=EXTRA")
                if create:
                    db.execute("CREATE TABLE IF NOT EXISTS requests "
                               "(id BLOB PRIMARY KEY, signature BLOB NOT NULL) WITHOUT ROWID")
                rows = ((bytes.fromhex(key.replace("-", "")), bytes.fromhex(signature))
                        for key, signature in signatures.items())
                db.executemany("INSERT INTO requests VALUES (?, ?) ON CONFLICT(id) DO NOTHING", rows)
        except (ValueError, TypeError, sqlite3.Error) as error:
            raise RoutingError("Could not save the route check request archive", 503, "storage") from error

    def _archived_signature(self, run_id):
        try:
            with closing(sqlite3.connect(self._requests_uri + "?mode=rw", uri=True)) as db:
                key = bytes.fromhex(run_id.replace("-", ""))
                row = db.execute("SELECT signature FROM requests WHERE id = ?", (key,)).fetchone()
                return row[0].hex() if row else None
        except sqlite3.Error as error:
            raise RoutingError("Could not read the route check request archive", 503, "storage") from error

    def _update_route(self, run_id: str, key: str, **values) -> None:
        with self.admission_lock:
            doc = self._read()
            run = next((item for item in doc["runs"] if item["id"] == run_id), None)
            if run is None:
                return
            route = next(item for item in run["routes"] if item["key"] == key)
            if route["state"] == DONE:
                return
            route.update(values)
            if route["state"] == DONE:
                self._index(doc, run, route)
            self._write(doc)

    # ---- inputs --------------------------------------------------------
    def conditions(self) -> dict:
        urls = list(self.parent.state.read_connectivity()["check_urls"])
        updates = getattr(self.parent, "router_updates", None)
        generation = updates.generation() if updates else None
        return {**({"router_software": generation} if generation else {}), "version": PROBE_VERSION, "targets": urls, "timeout_sec": ROUTE_CHECK_TIMEOUT_SEC,
                "rounds": ROUNDS, "user_agent": ROUTE_CHECK_USER_AGENT}

    @staticmethod
    def conditions_hash(conditions: dict) -> str:
        return digest(json.dumps(conditions, sort_keys=True).encode())

    def _locations(self) -> list[dict]:
        seen, result = set(), []
        for loc in self.parent.state.read_subscription().get("locations", []):
            if loc.get("code") and loc["code"] not in seen:
                seen.add(loc["code"])
                result.append(loc)
        return result

    def _candidate_hash(self, locations: dict, exit_code: str, entry_code: str | None) -> str | None:
        exit_loc = locations.get(exit_code)
        entry_loc = locations.get(entry_code) if entry_code else None
        if exit_loc is None or (entry_code and entry_loc is None):
            return None
        return route_probe.candidate_hash(Location(**exit_loc), Location(**entry_loc) if entry_loc else None)

    # ---- lifecycle -----------------------------------------------------
    def recover(self) -> None:
        """A run that outlived its process cannot finish; unfinished routes are unavailable."""
        try:
            with self.admission_lock:
                doc = self._read()
                changed = False
                for run in doc["runs"]:
                    if run["state"] != RUNNING or run["id"] in self._threads:
                        continue
                    for route in self._interrupt(run, INTERRUPTED_REASON, INTERRUPTED):
                        self._index(doc, run, route)
                    changed = True
                if changed:
                    self._write(doc)
        except RoutingError as error:
            # A diagnostics failure must not prevent the dashboard from starting.
            log.warning("Route check recovery skipped: %s", error)
        threading.Thread(target=self._cleanup_idle_router, daemon=True, name="route-check-cleanup").start()

    def _cleanup_idle_router(self) -> None:
        # A worker waits for startup cleanup before launching its own probes.
        with self._cleanup_lock:
            if not self._threads:
                self._cleanup_router()

    def stop(self) -> None:
        self._stop.set()

    def _cleanup_router(self) -> None:
        try:
            self.parent.router.cleanup_route_probes()
        except Exception as error:
            log.info("route check cleanup skipped: %s", type(error).__name__)

    def running(self):
        # Test sites are independent settings. Only this process's live probes
        # can still be using them, even if the diagnostics journal is unreadable.
        with self.admission_lock:
            return bool(self._threads)

    @staticmethod
    def _signature(kind, exit_code, selection):
        codes = sorted(set(selection)) if kind and kind != LEGACY else []
        return digest(json.dumps([kind or LEGACY, exit_code, codes], separators=(",", ":")).encode())

    def start(self, exit_code, run_id, *, kind=None, codes=None, entry_codes=None, conditions_hash=None) -> dict:
        if not valid_id(run_id):
            raise RoutingError("Invalid check ID")
        if kind not in (None, SINGLE_KEY, CHAIN):
            raise RoutingError("Invalid route check kind")
        if kind != SINGLE_KEY and (not isinstance(exit_code, str) or not exit_code):
            raise RoutingError("Choose an exit location")
        selection = codes if kind == SINGLE_KEY else entry_codes
        if kind is not None:
            if not isinstance(selection, list) or not selection or not all(isinstance(c, str) and c for c in selection):
                raise RoutingError("Choose at least one location", 400, "validation")
            if ((kind == SINGLE_KEY and (exit_code is not None or entry_codes is not None))
                    or (kind == CHAIN and codes is not None)):
                raise RoutingError("Invalid fields for this route check kind", 400, "validation")
            if kind == CHAIN and exit_code in selection:
                raise RoutingError("The exit cannot also be an entry", 400, "validation")
        elif codes is not None or entry_codes is not None:
            raise RoutingError("Choose a route check kind", 400, "validation")
        with self.admission_lock:
            doc = self._read()
            existing = next((run for run in doc["runs"] if run["id"] == run_id), None)
            previous = doc.get("past_requests", {}).get(run_id)
            if existing:
                previous = self._signature(existing["kind"], existing["exit_code"], (r["key"] for r in existing["routes"]))
            elif previous is None and doc.get("requests_archived"):
                previous = self._archived_signature(run_id)
            if previous:
                if previous != self._signature(kind, exit_code, selection):
                    raise RoutingError("This check ID is already in use", 409)
                return self.view(exit_code, kind=kind)
            active = next((run for run in doc["runs"] if run["state"] == RUNNING), None)
            if active:
                message = "Location checks are already running" if active["kind"] == SINGLE_KEY else (
                    f"Route checks for {active['exit_name']} are already running")
                raise RoutingError(message, 409, "busy")
            updates = getattr(self.parent, "router_updates", None)
            if updates and updates.active():
                raise RoutingError("Wait for the router software operation.", 409, "busy")
            if any(op.get("route_check_id") and op["phase"] not in TERMINAL for op in self.parent.routing.store.operations()):
                raise RoutingError("Main is switching. Wait for it to finish.", 409, "busy")
            conditions = self.conditions()
            actual_hash = self.conditions_hash(conditions)
            if kind and conditions_hash != actual_hash:
                raise RoutingError("Test sites changed. Review the list and start again.", 409, "stale_conditions")
            locations = {loc["code"]: Location(**loc) for loc in self._locations()}
            needed = set(selection or [])
            if exit_code:
                needed.add(exit_code)
            missing = needed - locations.keys()
            if missing:
                raise RoutingError(f"No saved location with code '{min(missing)}'", 409, "location")
            if kind == SINGLE_KEY:
                pairs = [(None, code) for code in locations if code in needed]
            else:
                pairs = [(code, exit_code) for code in locations if code != exit_code and (not kind or code in needed)]
                if not kind:
                    pairs.insert(0, (None, exit_code))
            routes, frozen = self._prepare_routes(kind, locations, pairs)
            run = {"id": run_id, "kind": kind or LEGACY, "exit_code": exit_code,
                   "exit_name": locations[exit_code].name if exit_code else None, "state": RUNNING,
                   "created_at": _iso(self._now()), "finished_at": None, "conditions": conditions,
                   "conditions_hash": actual_hash, "routes": routes}
            doc["runs"].append(run)
            self._write(doc)
            thread = threading.Thread(target=self._run, args=(run_id, frozen, conditions), daemon=True,
                                      name="route-checks")
            self._threads[run_id] = thread
            self._cancels[run_id] = threading.Event()
            thread.start()
            return self.view(exit_code, kind=kind)

    @staticmethod
    def _prepare_routes(kind, locations, pairs):
        routes, frozen = [], {}
        for entry, target in pairs:
            nodes = [locations[node] for node in (entry, target) if node]
            key = target if kind == SINGLE_KEY else entry or SINGLE_KEY
            main_text = route_probe.candidate(locations[target], locations.get(entry))
            frozen[key] = (main_text, {"entry_code": entry, "exit_code": target,
                                       "protocols": [loc.protocol for loc in nodes]},
                           " → ".join(_protocol(loc) for loc in nodes))
            routes.append({"key": key, "entry_code": entry, "entry_name": locations[entry].name if entry else None,
                           "exit_code": target, "exit_name": locations[target].name,
                           "candidate_sha256": digest(main_text.encode()), "state": QUEUED,
                           "outcome": None, "reason": None, "rounds": [], "started_at": None, "finished_at": None})
        return routes, frozen

    def _run(self, run_id: str, frozen: dict, conditions: dict) -> None:
        try:
            with self._cleanup_lock:
                self._cleanup_router()
            cancel = self._cancels[run_id]
            with ThreadPoolExecutor(max_workers=self._parallel, thread_name_prefix="route-check") as pool:
                for future in [pool.submit(self._check, run_id, key, *frozen[key], conditions) for key in frozen]:
                    future.result()
            with self.admission_lock:
                doc = self._read()
                run = next((item for item in doc["runs"] if item["id"] == run_id), None)
                if run and run["state"] == RUNNING and not self._stop.is_set():
                    run.update(state=CANCELLED if cancel.is_set() else COMPLETED, finished_at=_iso(self._now()))
                    self._write(doc)
        except Exception:
            log.exception("route checks failed")
        finally:
            with self.admission_lock:
                self._threads.pop(run_id, None)
                stopped = self._cancels.pop(run_id, None)
            if stopped is not None and stopped.is_set():
                # Killed sessions clean up remotely; this also covers a lost hang-up.
                threading.Thread(target=self._cleanup_idle_router, daemon=True, name="route-check-cleanup").start()
            if not self._stop.is_set():
                self.recover_orphan(run_id)

    def recover_orphan(self, run_id: str) -> None:
        with self.admission_lock:
            doc = self._read()
            run = next((item for item in doc["runs"] if item["id"] == run_id), None)
            if not run or run["state"] != RUNNING:
                return
            for route in self._interrupt(run, UNEXPECTED_REASON, COMPLETED):
                self._index(doc, run, route)
            self._write(doc)

    def _check(self, run_id, key, main_text, hint, protocols, conditions) -> None:
        cancel = self._cancels[run_id]
        with self.admission_lock:
            if self._stop.is_set() or cancel.is_set():
                return
            current = {loc["code"] for loc in self._locations()}
            if hint["exit_code"] not in current or (hint["entry_code"] and hint["entry_code"] not in current):
                self._update_route(run_id, key, state=DONE, finished_at=_iso(self._now()), outcome=UNAVAILABLE,
                                   reason=MISSING_REASON, rounds=[])
                return
            self._update_route(run_id, key, state=CHECKING, started_at=_iso(self._now()))
        try:
            result = self._probe(main_text, hint, conditions, protocols, cancel)
        except route_probe.ProbeUnavailable as error:
            result = {"outcome": UNAVAILABLE, "reason": str(error), "rounds": []}
        except Exception as error:
            log.warning("route check could not run: %s", type(error).__name__)
            result = {"outcome": UNAVAILABLE, "reason": SSH_REASON, "rounds": []}
        self._update_route(run_id, key, state=DONE, finished_at=_iso(self._now()), **result)

    def cancel(self, run_id) -> dict:
        """Stop a running run. Finished routes keep their results; the rest become unavailable."""
        if not valid_id(run_id):
            raise RoutingError("Invalid check ID")
        with self.admission_lock:
            doc = self._read()
            run = next((item for item in doc["runs"] if item["id"] == run_id), None)
            if run is None:
                raise RoutingError("Route check not found", 404, "not_found")
            event = self._cancels.get(run_id)
            thread = self._threads.get(run_id)
            if run["state"] == RUNNING and event is not None:
                event.set()
                for route in run["routes"]:
                    if route["state"] == QUEUED:
                        route.update(state=DONE, outcome=UNAVAILABLE, reason=STOPPED_REASON, rounds=[],
                                     finished_at=_iso(self._now()))
                        self._index(doc, run, route)
                self._write(doc)
            exit_code = run["exit_code"]
        # In-flight SSH sessions close within a poll interval; answer with the settled run.
        if thread is not None and thread is not threading.current_thread():
            thread.join(CANCEL_WAIT_SEC)
        return self.view(exit_code, kind=None if run["kind"] == LEGACY else run["kind"])

    def _router_probe(self, main_text: str, hint: dict, conditions: dict, protocols: str,
                      cancel: threading.Event | None = None) -> dict:
        urls, rounds, timeout = conditions["targets"], conditions["rounds"], conditions["timeout_sec"]
        limit = route_probe.time_limit(timeout, rounds)
        for attempt in range(PORT_ATTEMPTS):
            port = random.randint(route_probe.PROBE_PORT_MIN, route_probe.PROBE_PORT_MAX)
            output = self.parent.router.probe_route(
                route_probe.isolated_config(main_text, port), port=port, urls=urls, timeout=timeout,
                rounds=rounds, limit=limit, user_agent=conditions["user_agent"], hint=hint, cancel=cancel)
            try:
                return route_probe.parse(output, urls, rounds, protocols)
            except route_probe.PortBusy:
                if attempt == PORT_ATTEMPTS - 1:
                    raise
        raise route_probe.ProbeUnavailable(route_probe.STARTUP_ERRORS["bind"])

    # ---- reads ---------------------------------------------------------
    def _latest(self, doc, *, kind=None, exit_code=None, legacy=False):
        for run in reversed(doc["runs"]):
            if exit_code is not None and run["exit_code"] != exit_code:
                continue
            if (legacy or kind == CHAIN) and run["kind"] == SINGLE_KEY:
                continue
            if kind == SINGLE_KEY and run["kind"] != SINGLE_KEY:
                continue
            return run
        return None

    def summaries(self):
        """Both status formats from one journal snapshot."""
        try:
            doc = self._read()
        except RoutingError:
            return None, None
        newest = self._latest(doc)
        latest_chain = self._latest(doc, legacy=True)
        legacy = self._run_summary(latest_chain, legacy=True) if latest_chain else self._archived_legacy_summary(doc)
        return legacy, self._run_summary(newest) if newest else None

    def summary(self, *, legacy=True) -> dict | None:
        old, current = self.summaries()
        return old if legacy else current

    def _archived_legacy_summary(self, doc):
        report = self._legacy_summary(doc.get("last_chain_report"))
        if report and report["working"]:
            locations = {loc["code"]: loc for loc in self._locations()}
            current_hash, now = self.conditions_hash(self.conditions()), self._now()
            results = (slot.get("result", {}) for slot in doc["index"].values())
            report["working"] = sum(result.get("run_id") == report["id"] and result["outcome"] == WORKING and
                                    self._stale_kind(result, locations, current_hash, now) is None for result in results)
        return report

    @staticmethod
    def _legacy_summary(summary):
        if not summary:
            return None
        return {k: v for k, v in summary.items() if k not in {"conditions_hash", "kind"}}

    def _run_summary(self, run, *, legacy=False):
        summary = {"id": run["id"], "exit_code": run["exit_code"], "exit_name": run["exit_name"], "state": run["state"],
                   "created_at": run["created_at"], "finished_at": run["finished_at"], "total": len(run["routes"]),
                   "done": sum(route["state"] == DONE for route in run["routes"]),
                   "working": sum(route["outcome"] == WORKING for route in run["routes"])}
        if legacy and summary["working"]:
            locations = {loc["code"]: loc for loc in self._locations()}
            current_hash, now = self.conditions_hash(self.conditions()), self._now()
            summary["working"] = sum(
                self._stale_kind({**route, "conditions_hash": run["conditions_hash"]}, locations, current_hash, now) is None
                for route in run["routes"] if route["outcome"] == WORKING)
        if not legacy:
            summary.update(kind=SINGLE_KEY if run["kind"] == SINGLE_KEY else CHAIN,
                           conditions_hash=run["conditions_hash"])
        return summary

    def view(self, exit_code=None, *, kind=None) -> dict:
        if kind not in (None, CHAIN, SINGLE_KEY):
            raise RoutingError("Invalid route check kind", 400, "validation")
        if kind != SINGLE_KEY and (not isinstance(exit_code, str) or not exit_code):
            raise RoutingError("Choose an exit location")
        legacy = kind is None
        if kind == SINGLE_KEY:
            exit_code = None
        doc = self._read()
        run = self._latest(doc, kind=kind, exit_code=exit_code, legacy=legacy)
        newest = self._latest(doc, legacy=legacy)
        active = newest if newest and newest["state"] == RUNNING else None
        locations = {loc["code"]: loc for loc in self._locations()}
        conditions = self.conditions()
        condition_hash = self.conditions_hash(conditions)
        now = self._now()
        state = self.parent.state.read_state()
        main = (state.get("active_entry_code"), state.get("active_code"))
        pending = {(r["entry_code"], r["exit_code"]): r for r in active["routes"] if r["state"] != DONE} if active else {}

        def indexed_row(entry, exit):
            slot = doc["index"].get(self._pair(entry, exit), {})
            result, attempt = slot.get("result"), slot.get("last_attempt")
            checking = pending.get((entry, exit))
            if checking:
                row = self._row(active, checking, now, locations, condition_hash)
            elif result:
                row = self._row({"id": result["run_id"], "conditions_hash": result["conditions_hash"]}, result,
                                now, locations, condition_hash)
            else:
                row = self._unchecked(locations.get(exit, {"code": exit, "name": exit}), locations.get(entry))
                if attempt:
                    row.update(state=UNAVAILABLE, outcome=UNAVAILABLE, reason=attempt["reason"],
                               run_id=attempt["run_id"], checked_at=attempt["finished_at"])
            row.update(key=entry or exit, on_main=(entry, exit) == main, last_attempt=attempt)
            row["applicable"] = bool(result) and row["state"] == WORKING and not row["on_main"]
            return row

        public_conditions = {k: conditions[k] for k in ("targets", "rounds", "timeout_sec")}
        report = self._run_summary(run, legacy=legacy) if run else doc.get("reports", {}).get(self._pair(kind or CHAIN, exit_code))
        view = {"fresh_sec": FRESH_SEC, "conditions": public_conditions,
                "run": self._legacy_summary(report) if legacy else report,
                "active_run": self._run_summary(active, legacy=legacy) if active else None}
        if legacy:
            rows = [self._row(run, r, now, locations, condition_hash) for r in run["routes"]] if run else []
            known = {row["key"] for row in rows}
            if exit_code in locations:
                order = [SINGLE_KEY, *[code for code in locations if code != exit_code]]
                for key in order:
                    if key not in known:
                        entry = None if key == SINGLE_KEY else key
                        if report and not run:
                            archived = indexed_row(entry, exit_code)
                            if archived["run_id"] == report["id"]:
                                archived["key"] = key
                                rows.append(archived)
                                continue
                        rows.append(self._unchecked(locations[exit_code], locations.get(entry)))
                rows.sort(key=lambda row: order.index(row["key"]) if row["key"] in order else len(order))
            for row in rows:
                pair = row["entry_code"], row["exit_code"]
                latest = doc["index"].get(self._pair(*pair), {}).get("result", {})
                row["on_main"] = pair == main
                row["applicable"] = (not active and row["state"] == WORKING and row["run_id"] == latest.get("run_id")
                                     and not row["on_main"])
                row.pop("stale_kind", None)
            if report and not run:
                view["run"]["working"] = sum(row["state"] == WORKING for row in rows)
            return {**view, "exit_code": exit_code, "routes": rows}
        public_conditions["hash"] = condition_hash
        if kind == SINGLE_KEY:
            rows = [indexed_row(None, code) for code in locations]
        else:
            view.update(exit_code=exit_code, direct=indexed_row(None, exit_code))
            rows = []
            for entry in locations:
                if entry == exit_code:
                    continue
                row = indexed_row(entry, exit_code)
                # Membership uses the last verdict, even while Single is rechecking it.
                result = doc["index"].get(self._pair(None, entry), {}).get("result")
                reachable = None
                if result and self._stale_kind(result, locations, condition_hash, now) in (None, "expired"):
                    reachable = result["outcome"] in (WORKING, "unstable")
                row.update(entry_reachable=reachable, entry_checked_at=result["finished_at"] if result else None)
                rows.append(row)
        return {**view, "kind": kind, "routes": rows}

    @staticmethod
    def _unchecked(exit_loc: dict, entry: dict | None) -> dict:
        return {"key": entry["code"] if entry else SINGLE_KEY, "mode": "chain" if entry else "single",
                "entry_code": entry["code"] if entry else None, "entry_name": entry["name"] if entry else None,
                "exit_code": exit_loc["code"], "exit_name": exit_loc["name"], "state": UNCHECKED, "outcome": None,
                "reason": None, "stale_reason": None, "stale_kind": None, "checked_at": None, "fresh_until": None, "rounds": [],
                "run_id": None}

    def _row(self, run: dict, route: dict, now: datetime, locations: dict, condition_hash: str) -> dict:
        entry_code = route["entry_code"]
        exit_loc = locations.get(route["exit_code"])
        row = {"key": route["key"], "mode": "chain" if entry_code else "single", "entry_code": entry_code,
               "entry_name": (locations[entry_code]["name"] if entry_code in locations else route["entry_name"]) if entry_code else None,
               "exit_code": route["exit_code"], "exit_name": exit_loc["name"] if exit_loc else route["exit_name"],
               "outcome": route["outcome"], "reason": route["reason"], "stale_reason": None,
               "checked_at": route["finished_at"], "fresh_until": None, "rounds": route["rounds"], "run_id": run["id"]}
        row["stale_kind"] = None
        if route["state"] != DONE:
            row["state"] = route["state"]
            return row
        finished = _parse(route["finished_at"])
        if finished:
            row["fresh_until"] = _iso(finished + timedelta(seconds=FRESH_SEC))
        reason = self._stale_kind({**route, "conditions_hash": run["conditions_hash"]}, locations, condition_hash, now)
        if reason:
            row.update(state=STALE, stale_kind=reason, stale_reason=STALE_REASONS[reason])
        else:
            row["state"] = route["outcome"]
        return row

    def _stale_kind(self, binding, locations, condition_hash, now):
        current = self._candidate_hash(locations, binding["exit_code"], binding["entry_code"])
        if current is None:
            return "missing"
        if current != binding["candidate_sha256"]:
            return "config"
        if condition_hash is not None and condition_hash != binding["conditions_hash"]:
            return "conditions"
        finished = _parse(binding["finished_at"])
        if finished is None or now >= finished + timedelta(seconds=FRESH_SEC):
            return "expired"
        return None

    # ---- apply binding -------------------------------------------------
    def verify_binding(self, binding, code, entry_code, *, condition_hash=None):
        """Admission supplies current conditions; an accepted intent rechecks candidate and age."""
        locations = {loc["code"]: loc for loc in self._locations()}
        reason = self._stale_kind({**binding, "exit_code": code, "entry_code": entry_code}, locations,
                                  condition_hash, self._now())
        if reason:
            raise RoutingError(STALE_REASONS[reason] + ". Recheck routes before applying.", 409, STALE_CODE)
        return binding["candidate_sha256"]

    def verify_legacy_binding(self, run_id, code, entry_code, expected_hash):
        """Recover evidence for an already accepted v1 switch without re-admitting it."""
        doc = self._read()
        result = doc["index"].get(self._pair(entry_code, code), {}).get("result", {})
        if result.get("run_id") != run_id:
            result = next(({**row, "conditions_hash": run["conditions_hash"]}
                           for run in doc["runs"] if run["id"] == run_id
                           for row in run["routes"] if (row["entry_code"], row["exit_code"]) == (entry_code, code)), {})
        if result.get("outcome") != WORKING or result["candidate_sha256"] != expected_hash:
            raise RoutingError("This route check is no longer available. Recheck routes.", 409, STALE_CODE)
        self.verify_binding(result, code, entry_code)

    def apply_binding(self, run_id, code, entry_code):
        if not valid_id(run_id):
            raise RoutingError("Invalid route check ID", 400, "validation")
        doc = self._read()
        if any(run["state"] == RUNNING for run in doc["runs"]):
            raise RoutingError("Wait for route checks to finish.", 409, STALE_CODE)
        result = doc["index"].get(self._pair(entry_code, code), {}).get("result")
        if not result:
            raise RoutingError("This route check is no longer available. Recheck routes.", 409, STALE_CODE)
        if result["run_id"] != run_id:
            raise RoutingError("A newer check of this route exists. Use its result.", 409, STALE_CODE)
        binding = {key: result[key] for key in ("run_id", "candidate_sha256", "conditions_hash", "finished_at")}
        self.verify_binding(binding, code, entry_code, condition_hash=self.conditions_hash(self.conditions()))
        if result["outcome"] != WORKING:
            raise RoutingError("Only a Working route can be applied from route checks.", 409, STALE_CODE)
        return binding

    def verify_apply(self, run_id, code: str, entry_code: str | None) -> str:
        return self.apply_binding(run_id, code, entry_code)["candidate_sha256"]

def _protocol(loc: Location) -> str:
    stream = (loc.outbound or {}).get("streamSettings") or {}
    network = stream.get("network") or loc.network
    return loc.protocol + (f"/{network}" if network and network not in {"tcp", "raw"} else "")
