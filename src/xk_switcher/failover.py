"""Failover loop, probe policy, health tracker, decision engine."""
import logging
import threading
import time as _time
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Literal
from .subscription import is_hysteria_location

BUSY_MESSAGE = "Another check or router operation is in progress"

class FailoverBusyError(RuntimeError):
    """The check was explicitly refused before doing work."""

PROBE_RETRY_COUNT = 2
PROBE_RETRY_DELAY_SEC = 1

log = logging.getLogger(__name__)

ProbeMethod = Literal["socks", "tcp", "route", "skipped"]


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    latency_ms: int | None
    method: ProbeMethod


@dataclass
class HealthEntry:
    ok: bool = False
    fail_streak: int = 0
    ok_streak: int = 0
    last_ok_at: str | None = None
    last_fail_at: str | None = None
    last_latency_ms: int | None = None
    probe_method: ProbeMethod = "socks"
    tcp_ok: bool | None = None
    tcp_checked_at: str | None = None
    tcp_latency_ms: int | None = None
    route_ok: bool | None = None
    route_checked_at: str | None = None
    route_results: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "fail_streak": self.fail_streak,
            "ok_streak": self.ok_streak,
            "last_ok_at": self.last_ok_at,
            "last_fail_at": self.last_fail_at,
            "last_latency_ms": self.last_latency_ms,
            "probe_method": self.probe_method,
            "tcp_ok": self.tcp_ok,
            "tcp_checked_at": self.tcp_checked_at,
            "tcp_latency_ms": self.tcp_latency_ms,
            "route_ok": self.route_ok,
            "route_checked_at": self.route_checked_at,
            "route_results": self.route_results,
        }


class HealthTracker:
    def __init__(self) -> None:
        self._map: dict[str, HealthEntry] = {}

    @classmethod
    def from_snapshot(cls, snap: dict) -> "HealthTracker":
        t = cls()
        for code, entry in snap.items():
            t._map[code] = HealthEntry(**entry)
        return t

    def record(self, code: str, result: ProbeResult, at: datetime) -> None:
        e = self._map.get(code, HealthEntry())
        iso = at.isoformat()
        if result.ok:
            e.ok = True
            e.ok_streak += 1
            e.fail_streak = 0
            e.last_ok_at = iso
            e.last_latency_ms = result.latency_ms
        else:
            e.ok = False
            e.ok_streak = 0
            e.fail_streak += 1
            e.last_fail_at = iso
            e.last_latency_ms = None
        e.probe_method = result.method
        self._map[code] = e

    def record_components(self, code: str, tcp: ProbeResult,
                          route: dict | None, at: datetime) -> None:
        if route is not None and route.get("unattributed"):
            if self._map.get(code, HealthEntry()).route_checked_at:
                self.mark_unknown(code)
            route = None
        if tcp.method == "skipped" and route is None:
            self.mark_unknown(code)
            return
        endpoint_ok = tcp.ok if tcp.method != "skipped" else True
        combined_ok = endpoint_ok and (route is None or route.get("ok", False))
        method: ProbeMethod = "route" if route is not None else tcp.method
        self.record(
            code,
            ProbeResult(ok=combined_ok, latency_ms=tcp.latency_ms, method=method),
            at=at,
        )
        entry = self._map[code]
        if tcp.method == "skipped":
            entry.tcp_ok = None
            entry.tcp_checked_at = None
            entry.tcp_latency_ms = None
        else:
            entry.tcp_ok = tcp.ok
            entry.tcp_checked_at = at.isoformat()
            entry.tcp_latency_ms = tcp.latency_ms
        if route is not None:
            entry.route_ok = bool(route.get("ok"))
            entry.route_checked_at = at.isoformat()
            entry.route_results = list(route.get("results", []))

    def record_tcp(self, code: str, tcp: ProbeResult, at: datetime,
                   update_health: bool = True) -> None:
        if tcp.method == "skipped":
            if update_health:
                self.mark_unknown(code)
            elif code not in self._map:
                self._map[code] = HealthEntry()
            return
        if update_health:
            self.record(code, tcp, at=at)
        elif code not in self._map:
            self._map[code] = HealthEntry()
        entry = self._map[code]
        entry.tcp_ok = tcp.ok if tcp.method != "skipped" else None
        entry.tcp_checked_at = at.isoformat()
        entry.tcp_latency_ms = tcp.latency_ms

    def mark_unknown(self, code: str) -> None:
        entry = self._map.get(code, HealthEntry())
        entry.ok = False
        entry.fail_streak = 0
        entry.ok_streak = 0
        entry.last_latency_ms = None
        entry.probe_method = "skipped"
        entry.tcp_ok = None
        entry.tcp_checked_at = None
        entry.tcp_latency_ms = None
        entry.route_ok = None
        entry.route_checked_at = None
        entry.route_results = []
        self._map[code] = entry

    def get(self, code: str) -> dict:
        e = self._map.get(code, HealthEntry())
        return e.to_dict()

    def snapshot(self) -> dict:
        return {k: v.to_dict() for k, v in self._map.items()}


class ProbePolicy:
    @staticmethod
    def should_probe(state: dict, grace_sec: int, now: datetime) -> bool:
        if not state.get("enabled"):
            return False
        if state.get("xkeen_stop_cause") == "manual":
            return False
        last = state.get("last_apply_at")
        if last is None:
            return True
        try:
            last_dt = datetime.fromisoformat(last)
        except ValueError:
            return True
        delta = (now - last_dt).total_seconds()
        return delta >= grace_sec


DecisionKind = Literal["noop", "switch", "stop_xkeen", "start_and_switch"]


@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    code: str | None = None
    reason: str | None = None


class FailoverDecider:
    def __init__(self, fail_threshold: int, dampening_ticks: int) -> None:
        self.fail_threshold = fail_threshold
        self.dampening_ticks = dampening_ticks

    def decide(self, *, cfg: dict, health: dict, active: str | None,
               xkeen_state: str, xkeen_stop_cause: str | None) -> Decision:
        if not cfg.get("enabled"):
            return Decision(kind="noop")
        if xkeen_stop_cause == "manual":
            return Decision(kind="noop")
        whitelist = cfg.get("whitelist", [])
        if not whitelist:
            return Decision(kind="noop")

        # Recovery path: xkeen was stopped by failover, probes run in TCP mode
        if xkeen_state == "stopped" and xkeen_stop_cause == "failover":
            if not cfg.get("auto_restart_on_recovery"):
                return Decision(kind="noop")
            for code in whitelist:
                entry = health.get(code, {})
                if entry.get("ok") and entry.get("probe_method") == "tcp":
                    return Decision(kind="start_and_switch", code=code,
                                    reason="auto-recovery")
            return Decision(kind="noop")

        # Normal / on-fallback paths
        if active not in whitelist:
            return Decision(kind="noop")

        # Total failure: all non-skipped dead → stop xkeen (if enabled)
        non_skipped = [c for c in whitelist
                       if health.get(c, {}).get("probe_method") != "skipped"]
        if non_skipped and all(self._is_dead(health.get(c, {})) for c in non_skipped):
            if cfg.get("auto_stop_on_total_failure"):
                return Decision(kind="stop_xkeen", reason="total-failure-stop")
            return Decision(kind="noop")

        # Failback: currently not on primary, primary is stable → return
        primary = whitelist[0]
        if active != primary and cfg.get("auto_failback"):
            primary_entry = health.get(primary, {})
            if primary_entry.get("ok") and primary_entry.get("ok_streak", 0) >= self.dampening_ticks:
                return Decision(kind="switch", code=primary, reason="failback")

        # Standard failover: active dead → first alive fallback
        active_health = health.get(active, {})
        if self._is_dead(active_health):
            for code in whitelist:
                if code == active:
                    continue
                if self._is_alive(health.get(code, {})):
                    return Decision(kind="switch", code=code, reason="failover-switch")

        return Decision(kind="noop")

    def _is_dead(self, entry: dict) -> bool:
        if entry.get("probe_method") == "skipped":
            return False
        return (not entry.get("ok")) and entry.get("fail_streak", 0) >= self.fail_threshold

    def _is_alive(self, entry: dict) -> bool:
        return bool(entry.get("ok"))


@dataclass(frozen=True)
class FailoverConfig:
    check_interval_sec: int
    fail_threshold: int
    grace_after_switch_sec: int
    dampening_ticks: int
    tcp_timeout_sec: int


class FailoverLoop:
    def __init__(self, *, state, service, router, cfg: FailoverConfig,
                 clock=None, route_check_fn=None):
        self.state = state
        self.service = service
        self.router = router
        self.cfg = cfg
        self._route_check_fn = route_check_fn
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._stop = threading.Event()
        # One reentrant coordinator avoids opposite lock order between manual
        # switches, subscription recovery, probes, and routing transactions.
        self._tick_lock = getattr(service, "_op_lock", None) or threading.RLock()
        self._diagnostic_lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name="xk-failover")
        self._decider = FailoverDecider(
            fail_threshold=cfg.fail_threshold,
            dampening_ticks=cfg.dampening_ticks,
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def run_exclusive(self, operation):
        """Serialize subscription mutations with probes and recovery switches."""
        with self._tick_lock:
            return operation()

    def _activity(self, kind: str, message: str, source: str = "manual"):
        """Make coordinator ownership visible; never changes lock behaviour."""
        routing = getattr(self.service, "routing", None)
        if routing is None or not hasattr(routing, "activity"):
            return nullcontext()
        return routing.activity(kind=kind, message=message, source=source, scope="diagnostic")

    def probe_codes(self, codes: list[str]) -> dict[str, dict]:
        """Ad-hoc probe of specific codes. No state machine, merges into health.json.
        Returns {code: {ok, latency_ms, method}} for each requested code.
        """
        if not self._tick_lock.acquire(blocking=False):
            raise FailoverBusyError(BUSY_MESSAGE)
        try:
            message = "Checking " + (codes[0] if len(codes) == 1 else f"{len(codes)} locations") + " · TCP"
            with self._activity("probe", message):
                return self._probe_codes(codes)
        finally:
            self._tick_lock.release()

    def _probe_codes(self, codes: list[str]) -> dict[str, dict]:
        now = self._clock()
        tracker = HealthTracker.from_snapshot(self.state.read_health().get("map", {}))
        sub_locs = {d["code"]: d for d in self.state.read_subscription().get("locations", [])}
        st = self.state.read_state()
        active_code = st.get("active_code")

        results: dict[str, dict] = {}
        for code in codes:
            loc = sub_locs.get(code)
            result = self._probe_location(loc)
            previous = tracker.get(code)
            has_active_route = code == active_code and previous["route_checked_at"] is not None
            update_health = (
                not has_active_route
                or (result.method != "skipped" and not result.ok)
            )
            tracker.record_tcp(code, result, at=now,
                               update_health=update_health)
            results[code] = {"ok": result.ok, "latency_ms": result.latency_ms, "method": result.method}

        next_probe = now + timedelta(seconds=self.cfg.check_interval_sec)
        self.state.write_health({
            "schema_version": 1,
            "updated_at": now.isoformat(),
            "next_probe_at": next_probe.isoformat(),
            "map": tracker.snapshot(),
        })
        return results

    def check_current_route(self, *, allow_failover: bool = True) -> dict:
        """Run TCP + HTTPS checks for the active location and feed failover health."""
        if self.state.read_state().get("active_entry_code"):
            return self._check_chain(allow_reapply=allow_failover)
        if not allow_failover:
            return self._check_diagnostic()
        if not self._tick_lock.acquire(blocking=False):
            raise FailoverBusyError(BUSY_MESSAGE)
        try:
            with self._activity("route_check", "Checking the current route"):
                return self._check_current_route_locked(allow_failover)
        finally:
            self._tick_lock.release()

    def _check_current_route_locked(self, allow_failover: bool) -> dict:
        if allow_failover and getattr(self.service, "routing", None):
            self.service.routing.ensure_idle()
        now = self._clock()
        st = self.state.read_state()
        active_code = st.get("active_code")
        settings = getattr(self.service, "device_routing_settings", None)
        context = settings.context(refresh=True) if settings else None
        if context and not context["follows_main"]:
            if not allow_failover and active_code:
                self._probe_codes([active_code])
            route = self._run_route_check(context)
            loc = context["location"] if context["code"] else None
            tcp = self._probe_location(loc) if loc else None
            result = {"active_code": context["code"], "active_after": context["code"],
                      "main_code": active_code, "scope": "server", "checked_at": now.isoformat(),
                      "ok": bool(route["ok"] and (tcp is None or tcp.method == "skipped" or tcp.ok)),
                      "tcp": self._tcp_result(tcp) if tcp else None, "route": route}
            if settings.context()["key"] == context["key"]:
                settings.record_check(context, result)
            else:
                result["stale"] = True
            return result
        if not active_code:
            raise ValueError("no active location")
        if st.get("xkeen_state") == "stopped":
            raise ValueError("xkeen is stopped")
        sub_locs = {d["code"]: d for d in self.state.read_subscription().get("locations", [])}
        loc = sub_locs.get(active_code)
        if loc is None:
            raise ValueError(f"active location '{active_code}' is not in subscription")
        tcp = self._probe_location(loc)
        route = (
            self._run_route_check(context)
            if not allow_failover or self._can_check_route(loc, tcp)
            else self._route_skipped("TCP unavailable")
        )
        if not allow_failover:
            current = self.state.read_state()
            generation_changed = any(current.get(key) != st.get(key)
                                     for key in ("active_code", "last_apply_at", "xkeen_state"))
            context_changed = settings and context and settings.context()["key"] != context["key"]
            if generation_changed or context_changed:
                return {"active_code": active_code, "active_after": current.get("active_code"),
                        "checked_at": now.isoformat(), "ok": False, "stale": True,
                        "tcp": self._tcp_result(tcp), "route": route}
        tracker = HealthTracker.from_snapshot(self.state.read_health().get("map", {}))
        tracker.record_components(active_code, tcp, route, at=now)

        fo = self.state.read_failover()
        active_health = tracker.get(active_code)
        whitelist = fo.get("whitelist", [])
        candidates: list[str] = []
        if allow_failover and fo.get("enabled") and active_code in whitelist:
            if self._decider._is_dead(active_health):
                candidates = [code for code in whitelist if code != active_code]
            elif (fo.get("auto_failback") and whitelist
                  and active_code != whitelist[0]):
                candidates = [whitelist[0]]
        for code in candidates:
            candidate = sub_locs.get(code)
            candidate_tcp = self._probe_location(candidate)
            tracker.record_components(code, candidate_tcp, None, at=now)
        self._write_health(tracker, now)

        refreshed_route = self._decide_and_apply(fo, st, tracker, now) if allow_failover else None
        if refreshed_route is not None:
            route = refreshed_route
        result = {
            "active_code": active_code,
            "active_after": self.state.read_state().get("active_code"),
            "checked_at": now.isoformat(),
            "ok": tracker.get(active_code)["ok"],
            "tcp": self._tcp_result(tcp),
            "route": route,
        }
        if settings and context and settings.context()["key"] == context["key"]:
            settings.record_check(context, result)
        return result

    def _check_chain(self, *, allow_reapply=False) -> dict:
        """Whole-route evidence belongs to a pair, never to either node's TCP health."""
        if not self._diagnostic_lock.acquire(blocking=False):
            raise FailoverBusyError("A server route check is already running")
        try:
            before = self.state.read_state()
            if not before.get("active_entry_code"):
                return {"ok": False, "stale": True, "active_code": before.get("active_code")}
            now = self._clock()
            settings = getattr(self.service, "device_routing_settings", None)
            context = settings.context(refresh=True) if settings else None
            route = self._run_route_check(context, publish=False)
            key = f"chain:{before.get('active_entry_code')}:{before.get('active_code')}"
            independent = bool(context and not context["follows_main"])
            result = {"active_code": context["code"] if independent else before.get("active_code"),
                      "active_after": context["code"] if independent else before.get("active_code"),
                      "entry_code": None if independent else before.get("active_entry_code"),
                      "checked_at": now.isoformat(), "ok": bool(route.get("ok")), "tcp": None, "route": route}
            if independent:
                result.update(scope="server", main_code=before.get("active_code"))
            if not self._tick_lock.acquire(blocking=False):
                return {**result, "stale": True}
            try:
                current = self.state.read_state()
                generation = ("active_code", "active_entry_code", "last_apply_at", "applied_main_fingerprint", "xkeen_state")
                routing = getattr(self.service, "routing", None)
                op = routing.public_operation() if routing else None
                if (any(current.get(k) != before.get(k) for k in generation)
                        or (op and not op.get("ephemeral"))
                        or (settings and context and settings.context()["key"] != context["key"])):
                    return {**result, "stale": True}
                tracker = HealthTracker.from_snapshot(self.state.read_health().get("map", {}))
                if independent or route.get("unattributed") or route.get("skipped") or before.get("xkeen_state") == "stopped":
                    tracker.mark_unknown(key)
                else:
                    tracker.record_components(key, ProbeResult(False, None, "skipped"), route, at=now)
                self._write_health(tracker, now)
                result["main_verified"] = tracker.get(key)["route_ok"] is not None
                if settings and context:
                    settings.record_check(context, result)
            finally:
                self._tick_lock.release()
        finally:
            self._diagnostic_lock.release()
        if not allow_reapply:
            return result
        if not self._tick_lock.acquire(blocking=False):
            return {**result, "stale": True}
        recovered = False
        try:
            # Publication released the coordinator. Recheck the pair, installed
            # generation and attribution, then retain it through recovery admission.
            current = self.state.read_state()
            op = routing.public_operation() if routing else None
            if (any(current.get(k) != before.get(k) for k in generation)
                    or (op and not op.get("ephemeral"))
                    or (settings and context and settings.context()["key"] != context["key"])):
                return {**result, "stale": True}
            tracker = HealthTracker.from_snapshot(self.state.read_health().get("map", {}))
            if (result["main_verified"] and self.state.read_failover().get("enabled")
                    and self._decider._is_dead(tracker.get(key))
                    and self.service.has_pending_reapply(before["active_code"])):
                try:
                    recovered = self.service.recover_pending_active()
                except Exception:
                    log.exception("chain: pending active refresh failed")
        finally:
            self._tick_lock.release()
        if recovered:
            return self._check_chain()
        return result

    def _check_diagnostic(self) -> dict:
        """Probe outside the mutation lock; publish only to the same route generation."""
        if not self._diagnostic_lock.acquire(blocking=False):
            raise FailoverBusyError("A server route check is already running")
        try:
            now = self._clock()
            before = self.state.read_state()
            active = before.get("active_code")
            settings = getattr(self.service, "device_routing_settings", None)
            context = settings.context(refresh=True) if settings else None
            locations = {loc["code"]: loc for loc in self.state.read_subscription().get("locations", [])}
            main_tcp = self._probe_location(locations.get(active)) if active else None
            independent = bool(context and not context["follows_main"])
            tcp = (self._probe_location(context["location"]) if context["code"] else None) if independent else main_tcp
            route = self._run_route_check(context, publish=False)
            result = {"active_code": context["code"] if independent else active,
                      "active_after": context["code"] if independent else active,
                      "checked_at": now.isoformat(),
                      "ok": bool(route["ok"] and (tcp is None or tcp.method == "skipped" or tcp.ok)),
                      "tcp": self._tcp_result(tcp) if tcp else None, "route": route}
            if independent:
                result.update(scope="server", main_code=active)
            if not self._tick_lock.acquire(blocking=False):
                return {**result, "stale": True}
            try:
                current = self.state.read_state()
                generation = ("active_code", "active_entry_code", "last_apply_at", "xkeen_state", "applied_main_fingerprint")
                changed = any(current.get(key) != before.get(key) for key in generation)
                routing = getattr(self.service, "routing", None)
                operation = routing.public_operation() if routing else None
                pending = bool(operation and not operation.get("ephemeral"))
                if changed or pending or (settings and context and settings.context()["key"] != context["key"]):
                    return {**result, "stale": True}
                if active and main_tcp:
                    tracker = HealthTracker.from_snapshot(self.state.read_health().get("map", {}))
                    tracker.record_components(active, main_tcp, None if independent else route, at=now)
                    self._write_health(tracker, now)
                    if not independent:
                        result["ok"] = tracker.get(active)["ok"]
                if settings and context:
                    settings.record_check(context, result)
                return result
            finally:
                self._tick_lock.release()
        finally:
            self._diagnostic_lock.release()

    def recover_vanished_active(self) -> dict:
        """Try TCP-reachable whitelist locations until one has a working route."""
        self._tick_lock.acquire()
        try:
            if getattr(self.service, "routing", None):
                self.service.routing.ensure_idle()
            with self._activity("recovery", "Finding a working location", "failover"):
                return self._recover_vanished_locked()
        finally:
            self._tick_lock.release()

    def _recover_vanished_locked(self) -> dict:
        now = self._clock()
        st = self.state.read_state()
        fo = self.state.read_failover()
        if st.get("active_entry_code") or not fo.get("enabled") or st.get("xkeen_stop_cause") == "manual":
            return {"attempted": False, "recovered": False,
                    "active_after": st.get("active_code"), "attempts": []}
        whitelist = fo.get("whitelist", [])
        sub_locs = {
            loc["code"]: loc
            for loc in self.state.read_subscription().get("locations", [])
        }
        tracker = HealthTracker.from_snapshot(
            self.state.read_health().get("map", {}),
        )
        attempts = []
        for code in whitelist:
            loc = sub_locs.get(code)
            tcp = self._probe_location(loc)
            tracker.record_components(code, tcp, None, at=now)
            attempt = {"code": code,
                       "tcp_ok": tcp.ok if tcp.method == "tcp" else None,
                       "applied": False, "route_ok": None}
            attempts.append(attempt)
            if not tcp.ok:
                continue
            try:
                self.service.apply_failover(code, reason="failover-switch", refreshed=True)
            except Exception:
                continue
            attempt["applied"] = True
            route = self._run_route_check()
            tracker.record_components(code, tcp, route, at=now)
            attempt["route_ok"] = None if route.get("unattributed") else bool(route.get("ok"))
            if route.get("unattributed"):
                self._write_health(tracker, now)
                return {"attempted": True, "recovered": False, "active_after": code,
                        "route_verification": "unavailable", "attempts": attempts}
            if route.get("ok") and not route.get("unattributed"):
                self._mark_inactive_hysteria_unknown(tracker, sub_locs)
                self._write_health(tracker, now)
                return {
                    "attempted": True,
                    "recovered": True,
                    "active_after": code,
                    "attempts": attempts,
                }
        self._mark_inactive_hysteria_unknown(tracker, sub_locs)
        self._write_health(tracker, now)
        return {
            "attempted": True,
            "recovered": False,
            "active_after": self.state.read_state().get("active_code"),
            "attempts": attempts,
        }

    def tick_once(self, *, reject_busy=False) -> None:
        """Single probe + decide + apply cycle. Used by tests and /api/check-now."""
        if not self._tick_lock.acquire(blocking=False):
            if reject_busy:
                raise FailoverBusyError(BUSY_MESSAGE)
            return
        try:
            if reject_busy and getattr(self.service, "routing", None):
                self.service.routing.ensure_idle()
            check_chain = self._tick_impl(reject_busy=reject_busy)
        finally:
            self._tick_lock.release()
        if check_chain:
            # Whole-chain HTTP diagnostics are observational. Release the outer
            # tick's coordinator too; _check_chain guards publication/reapply
            # against a changed route generation when it reacquires admission.
            try:
                self._check_chain(allow_reapply=True)
            except FailoverBusyError:
                if reject_busy:
                    raise

    def _tick_impl(self, *, reject_busy=False) -> bool | None:
        # A decision based on pre-restart state must not be queued behind routing.
        coordinator = getattr(self.service, "_op_lock", None)
        if coordinator is None:
            return self._coordinated_tick()
        if not coordinator.acquire(blocking=False):
            if reject_busy:
                raise FailoverBusyError(BUSY_MESSAGE)
            return
        try:
            if self.service.routing.public_operation():
                if reject_busy:
                    raise FailoverBusyError(BUSY_MESSAGE)
                return
            self.service.routing.ensure_idle()
            return self._coordinated_tick()
        finally:
            coordinator.release()

    def _coordinated_tick(self) -> bool | None:
        fo = self.state.read_failover()
        st = self.state.read_state()
        now = self._clock()

        if not ProbePolicy.should_probe(
            {
                "enabled": fo.get("enabled"),
                "xkeen_stop_cause": st.get("xkeen_stop_cause"),
                "last_apply_at": st.get("last_apply_at"),
            },
            grace_sec=self.cfg.grace_after_switch_sec,
            now=now,
        ):
            return

        if st.get("active_entry_code"):
            return True
        whitelist = fo.get("whitelist", [])
        if not whitelist:
            return
        with self._activity("failover_check", "Checking failover locations", "failover"):
            self._probe_whitelist(fo, st, now, whitelist)

    def _probe_whitelist(self, fo: dict, st: dict, now: datetime, whitelist: list[str]) -> None:
        tracker = HealthTracker.from_snapshot(self.state.read_health().get("map", {}))
        sub_locs = {d["code"]: d for d in self.state.read_subscription().get("locations", [])}
        probe_results: dict[str, ProbeResult] = {}

        for code in whitelist:
            loc = sub_locs.get(code)
            probe_results[code] = self._probe_location(loc)

        active_code = st.get("active_code")
        active_probe = probe_results.get(active_code)
        active_loc = sub_locs.get(active_code)
        route = None
        if self._route_check_fn and active_probe and st.get("xkeen_state") != "stopped":
            route = (
                self._run_route_check()
                if self._can_check_route(active_loc, active_probe)
                else self._route_skipped("TCP unavailable")
            )
        for code, probe in probe_results.items():
            tracker.record_components(code, probe, route if code == active_code else None, at=now)
        self._write_health(tracker, now)

        self._decide_and_apply(fo, st, tracker, now)

    def _write_health(self, tracker: HealthTracker, now: datetime) -> None:
        next_probe = now + timedelta(seconds=self.cfg.check_interval_sec)
        self.state.write_health({
            "schema_version": 1,
            "updated_at": now.isoformat(),
            "next_probe_at": next_probe.isoformat(),
            "map": tracker.snapshot(),
        })
        settings = getattr(self.service, "device_routing_settings", None)
        if settings:
            context = settings.context()
            entry = tracker.get(context["code"]) if context["code"] else {}
            if context["follows_main"] and entry.get("route_checked_at") == now.isoformat():
                tcp = None if entry["tcp_ok"] is None else {"ok": entry["tcp_ok"], "latency_ms": entry["tcp_latency_ms"]}
                settings.record_check(context, {"active_code": context["code"], "checked_at": now.isoformat(),
                                               "ok": entry["ok"], "tcp": tcp,
                                               "route": {"ok": entry["route_ok"], "results": entry["route_results"]}})

    def _decide(self, fo: dict, st: dict, tracker: HealthTracker) -> Decision:
        if st.get("active_entry_code"):
            return Decision(kind="noop")
        return self._decider.decide(
            cfg=fo,
            health=tracker.snapshot(),
            active=st.get("active_code"),
            xkeen_state=st.get("xkeen_state", "unknown"),
            xkeen_stop_cause=st.get("xkeen_stop_cause"),
        )

    def _decide_and_apply(
        self,
        fo: dict,
        st: dict,
        tracker: HealthTracker,
        now: datetime,
    ) -> dict | None:
        active_code = st.get("active_code")
        active_health = tracker.get(active_code) if active_code else {}
        refreshed_route = None
        if (
            active_code
            and fo.get("enabled")
            and active_code in fo.get("whitelist", [])
            and self._decider._is_dead(active_health)
            and self.service.has_pending_reapply(active_code)
        ):
            recovery = self._try_pending_active_recovery(
                active_code,
                tracker,
                now,
            )
            if not any(
                loc["code"] == active_code
                for loc in self.state.read_subscription().get("locations", [])
            ):
                # Subscription refresh already handled recovery for a vanished active.
                return None
            if recovery is not None:
                recovered, refreshed_route = recovery
                if recovered:
                    return refreshed_route
        self._apply_decision(
            self._decide(self.state.read_failover(), self.state.read_state(), tracker),
        )
        return refreshed_route

    def _try_pending_active_recovery(
        self,
        active_code: str,
        tracker: HealthTracker,
        now: datetime,
    ) -> tuple[bool, dict] | None:
        try:
            if not self.service.recover_pending_active():
                return None
        except Exception:
            log.exception("failover: pending active refresh failed")
            return None
        loc = next((
            item
            for item in self.state.read_subscription().get("locations", [])
            if item.get("code") == active_code
        ), None)
        if loc is None:
            return None
        tcp = self._probe_location(loc)
        route = (
            self._run_route_check()
            if self._can_check_route(loc, tcp)
            else self._route_skipped("TCP unavailable after active refresh")
        )
        tracker.record_components(active_code, tcp, route, at=now)
        self._write_health(tracker, now)
        return tracker.get(active_code)["ok"], route

    def _run_route_check(self, context=None, *, publish=True) -> dict:
        if self._route_check_fn is None:
            return self._route_skipped("route checker unavailable")
        settings = getattr(self.service, "device_routing_settings", None)
        context = context or (settings.context(refresh=True) if settings else None)
        try:
            result = self._route_check_fn()
            details = list(result.get("results", []))
            route_ok = any(bool(item.get("ok")) for item in details) if details else bool(result.get("ok"))
            result = {**result, "ok": route_ok, "results": details}
        except Exception as exc:
            log.warning("route check failed: %s", exc)
            result = {"ok": False, "results": [], "error": str(exc)}
        if context:
            result.update(unattributed=not context["follows_main"], server_code=context["code"])
            if publish:
                settings.record_check(context, {"checked_at": self._clock().isoformat(), "ok": result["ok"],
                                               "active_code": context["code"], "scope": "server", "route": result})
        return result

    @staticmethod
    def _route_skipped(reason: str) -> dict:
        return {"ok": False, "skipped": True, "results": [], "error": reason}

    def _apply_decision(self, decision: Decision) -> None:
        if decision.kind == "noop":
            return
        try:
            if decision.kind == "switch":
                self.service.apply_failover(decision.code, reason=decision.reason)
            elif decision.kind == "stop_xkeen":
                self.service.handle_total_failure()
            elif decision.kind == "start_and_switch":
                self.service.apply_failover(decision.code, reason=decision.reason)
        except Exception:
            log.exception("failover: apply_decision %s failed", decision.kind)

    def _probe_location(self, loc: dict | None) -> ProbeResult:
        if loc is None or is_hysteria_location(loc):
            return ProbeResult(ok=False, latency_ms=None, method="skipped")
        ok, latency = self._tcp_probe(loc["host"], loc["port"])
        return ProbeResult(ok=ok, latency_ms=latency, method="tcp")

    @staticmethod
    def _can_check_route(loc: dict | None, probe: ProbeResult) -> bool:
        return bool(loc) and (probe.ok or is_hysteria_location(loc))

    @staticmethod
    def _tcp_result(probe: ProbeResult) -> dict | None:
        if probe.method == "skipped":
            return None
        return {"ok": probe.ok, "latency_ms": probe.latency_ms}

    def _mark_inactive_hysteria_unknown(
        self,
        tracker: HealthTracker,
        locations: dict[str, dict],
    ) -> None:
        active_code = self.state.read_state().get("active_code")
        for code, loc in locations.items():
            if code != active_code and is_hysteria_location(loc):
                tracker.mark_unknown(code)

    def _tcp_probe(self, host: str, port: int) -> tuple[bool, int | None]:
        import socket
        for attempt in range(PROBE_RETRY_COUNT):
            start = self._clock()
            try:
                with socket.create_connection((host, port), timeout=self.cfg.tcp_timeout_sec):
                    pass
                latency = int((self._clock() - start).total_seconds() * 1000)
                return True, latency
            except Exception:
                if attempt < PROBE_RETRY_COUNT - 1:
                    _time.sleep(PROBE_RETRY_DELAY_SEC)
                    continue
                return False, None
        return False, None

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick_once()
            except Exception:
                log.exception("failover: tick failed")
            if self._stop.wait(timeout=self.cfg.check_interval_sec):
                return
