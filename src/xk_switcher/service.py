"""Orchestrate switch and update flows — the single seam between web and I/O."""
import json
import logging
import re
import threading
from functools import wraps
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Callable
from . import config_updates, jsonc
from .config import Config
from .outbound import CHAIN_ENTRY_TAG, build as build_outbound
from .state import State
from .routing_service import RoutingService, source_for_trigger
from .devices_service import DevicesService
from .device_locations import DeviceLocationsService
from .device_routing_settings import DeviceRoutingSettings
from .router_updates import RouterUpdates
from .route_checks import RouteChecks, STALE_CODE
from .routing import RoutingError, digest
from .subscription import (
    Location,
    decode_subscription,
    fetch,
    is_hysteria_location,
    parse_locations,
    _endpoint,
)

log = logging.getLogger(__name__)

STATUS_OK = "ok"
STATUS_STALE = "stale"
ACTION_SWITCH = "switch"
ACTION_UPDATE = "update"
ACTION_URL_CHANGE = "url-change"
ACTION_XKEEN = "xkeen"
ACTION_FAILOVER_SWITCH = "failover-switch"
ACTION_FAILBACK = "failback"
ACTION_TOTAL_FAILURE_STOP = "total-failure-stop"
ACTION_AUTO_RECOVERY = "auto-recovery"
ACTION_ACTIVE_REFRESH = "active-refresh"
TRIGGER_MANUAL = "manual"
TRIGGER_CRON = "cron"
TRIGGER_AUTO = "auto-reapply"
TRIGGER_FAILOVER = "failover"
RESULT_OK = "ok"
RESULT_FAIL = "fail"
XKEEN_RUNNING = "running"
XKEEN_STOPPED = "stopped"
XKEEN_UNKNOWN = "unknown"
MIN_AUTO_UPDATE_MINUTES = 5
MAX_AUTO_UPDATE_MINUTES = 10080
MOSCOW_TIMEZONE = timezone(timedelta(hours=3), name="Europe/Moscow")
DAILY_APPLY_WINDOW = timedelta(minutes=1)
CACHED_SUBSCRIPTION_WARNING = "Subscription refresh failed; using saved location configuration."
MUTATION_MESSAGES = {
    "switch": "Preparing Main location", "apply_failover": "Preparing failover location",
    "update": "Refreshing subscription", "set_subscription_url": "Saving subscription",
    "apply_pending_reapply": "Checking scheduled configuration updates",
    "apply_pending_reapply_now": "Preparing configuration updates",
    "recover_pending_active": "Preparing active configuration recovery",
    "xkeen_control": "Updating XKeen state", "handle_total_failure": "Stopping unavailable Main route",
}

MUTATION_TRIGGERS = {
    "apply_failover": "failover", "apply_pending_reapply": "auto-reapply",
    "recover_pending_active": "failover", "handle_total_failure": "failover",
}

class UnknownCodeError(Exception):
    pass

def router_mutation(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        if method.__name__ == "apply_pending_reapply":
            # Scheduler polls are not operations when nothing is due. This is
            # only a quiet preflight; the method rechecks after admission.
            self.routing.ensure_idle()
            st = self.state.read_state()
            now = datetime.now(timezone.utc)
            due = _auto_update_due(st, now=now)
            if due is None or now < due or st.get("xkeen_state") == XKEEN_STOPPED:
                return False
        target = args[0] if args and method.__name__ in {"switch", "apply_failover"} else None
        entry_code = kwargs.get("entry_code") if method.__name__ == "switch" else self.state.read_state().get("active_entry_code")
        if method.__name__ in {"xkeen_control", "apply_pending_reapply", "apply_pending_reapply_now", "recover_pending_active"}:
            target = self.state.read_state().get("active_code")
        trigger = kwargs.get("trigger") or MUTATION_TRIGGERS.get(method.__name__, TRIGGER_MANUAL)
        if method.__name__ == "update" and args:
            trigger = args[0]
        with self.routing.admission(kind=method.__name__, target_code=target, target_entry_code=entry_code,
                                    message=MUTATION_MESSAGES.get(method.__name__, "Preparing router operation"),
                                    source=source_for_trigger(trigger)):
            return method(self, *args, **kwargs)
    return wrapped

class Service:
    def __init__(self, state: State, router, fetch_fn: Callable[[str], bytes] = fetch, config: Config | None = None):
        self.state = state
        self.router = router
        self.fetch_fn = fetch_fn
        self.config = config or Config.from_env()
        self.failover_loop = None  # set by app.py after wiring (T17); check-now shares it when present
        self._op_lock = threading.RLock()
        self.routing = RoutingService(self)
        self.devices = DevicesService(self)
        self.device_locations = DeviceLocationsService(self)
        self.device_routing_settings = DeviceRoutingSettings(self)
        self.route_checks = RouteChecks(self)
        self.router_updates = RouterUpdates(self)

    def reconcile_failover_config(self, config: dict | None = None) -> dict:
        stored = self.state.read_failover()
        cfg = dict(stored if config is None else config)
        locations = self.state.read_subscription().get("locations", [])
        if not locations:
            if config is not None:
                self.state.write_failover(cfg)
            return cfg
        if self.state.read_state().get("active_entry_code"):
            if config is not None:
                self.state.write_failover(cfg)
            return cfg
        available_codes = {loc["code"] for loc in locations}
        cfg["whitelist"] = [
            code for code in cfg.get("whitelist", []) if code in available_codes
        ]
        if config is not None or cfg != stored:
            self.state.write_failover(cfg)
        return cfg

    def status(self) -> dict:
        st = self.state.read_state()
        sub = self.state.read_subscription()
        fo = self.reconcile_failover_config()
        health_doc = self.state.read_health()
        health = health_doc.get("map", {})
        whitelist = fo.get("whitelist", [])
        enriched_available = []
        for loc in sub.get("locations", []):
            enriched_available.append({
                **loc,
                "health": health.get(loc["code"]),
            })
        enabled = fo.get("enabled", False)
        active_code = st.get("active_code")
        primary = whitelist[0] if whitelist else None
        failover_active = bool(
            not st.get("active_entry_code") and enabled and active_code and primary
            and active_code != primary and active_code in whitelist
        )
        legacy_checks, latest_check = self.route_checks.summaries()
        return {
            "operation": self.routing.public_operation(),
            "router_updates": {"available": self.router_updates.available()},
            "active_code": active_code,
            "active_entry_code": st.get("active_entry_code"),
            "active_route": self.route_info(active_code, st.get("active_entry_code")),
            "active_missing_codes": st.get("active_missing_codes", []),
            "active_health": health.get(f"chain:{st['active_entry_code']}:{active_code}" if st.get("active_entry_code") else active_code),
            "server_route": self.device_routing_settings.status(),
            "active_status": st.get("active_status"),
            "xkeen_state": st.get("xkeen_state", XKEEN_UNKNOWN),
            "xkeen_stop_cause": st.get("xkeen_stop_cause"),
            "subscription_url": st.get("subscription_url"),
            "last_update_at": st.get("last_update_at"),
            "last_update_status": st.get("last_update_status"),
            "pending_reapply_code": st.get("pending_reapply_code"),
            "pending_reapply_entry_code": st.get("pending_reapply_entry_code"),
            "pending_reapply_since": st.get("pending_reapply_since"),
            "pending_update_kind": st.get("pending_update_kind"),
            "auto_update": self.auto_update_status(st),
            "failover": {
                "enabled": enabled,
                "suspended": bool(st.get("active_entry_code")),
                "suspension_reason": "chain_active" if st.get("active_entry_code") else None,
                "active": failover_active,
                "since": st.get("failover_since") if failover_active else None,
                "whitelist": whitelist,
                "auto_failback": fo.get("auto_failback", False),
                "auto_stop_on_total_failure": fo.get("auto_stop_on_total_failure", False),
                "auto_stop_suspended_for_devices": self.device_locations.has_assignments(),
                "auto_restart_on_recovery": fo.get("auto_restart_on_recovery", False),
            },
            "route_checks": legacy_checks,
            "route_check_run": latest_check,
            "route_check_conditions_hash": self.route_checks.conditions_hash(self.route_checks.conditions()),
            "health_updated_at": health_doc.get("updated_at"),
            "available": enriched_available,
            "history": self.state.read_history(limit=10),
            "events": self.state.read_events(),
        }

    @router_mutation
    def xkeen_control(self, action: str) -> None:
        if action not in {"start", "stop", "restart"}:
            raise ValueError(f"unknown xkeen action: {action}")
        code = self.state.read_state().get("active_code")
        if action != "stop" and code:
            loc = self._find_location(code)
            if loc is None:
                raise UnknownCodeError(f"no location with code '{code}'")
            self._apply_and_record(loc, trigger=TRIGGER_MANUAL, action=ACTION_XKEEN, history_code=action,
                                   warning=self.cached_subscription_warning(),
                                   entry_code=self.state.read_state().get("active_entry_code"))
            self.check_after_apply()
            return
        try:
            self.router.run_xkeen(action)
        except Exception as e:
            self._log_history(
                action=ACTION_XKEEN, trigger=TRIGGER_MANUAL, result=RESULT_FAIL,
                code=action, message=str(e),
            )
            raise
        if action == "stop":
            new_state = XKEEN_STOPPED
            cause = "manual"
        else:
            new_state = XKEEN_RUNNING
            cause = None
        self.state.write_state({
            "xkeen_state": new_state,
            "xkeen_stop_cause": cause,
        })
        self._log_history(
            action=ACTION_XKEEN, trigger=TRIGGER_MANUAL, result=RESULT_OK,
            code=action, message=f"xkeen -{action}",
        )

    def probe_xkeen(self) -> str:
        """Best-effort query of xkeen status on the router. Persists result."""
        try:
            raw = self.router.run_xkeen("status") or ""
        except Exception as e:
            log.warning("xkeen status probe failed: %s", e)
            return self.state.read_state().get("xkeen_state", XKEEN_UNKNOWN)
        out = _strip_ansi(raw).lower()
        # Check stopped markers first — Russian "не запущен" contains substring "запущ"
        stopped_markers = ("не запущ", "остановлен", "stopped", "not running", "inactive")
        running_markers = ("запущ", "running", "active", "started")
        if any(m in out for m in stopped_markers):
            new_state = XKEEN_STOPPED
        elif any(m in out for m in running_markers):
            new_state = XKEEN_RUNNING
        else:
            new_state = XKEEN_UNKNOWN
        if new_state != XKEEN_UNKNOWN:
            self.state.write_state({"xkeen_state": new_state})
        return new_state

    def sync_active_from_router(self) -> str | None:
        try:
            with self.routing.admission(kind="sync", message="Reading Main route"):
                return self._sync_active_from_router()
        except RoutingError:
            return None

    def _sync_active_from_router(self) -> str | None:
        """Read active outbound from router, match against subscription, update active_code.
        Tolerant to router unreachable / unexpected config / no match.
        """
        try:
            payload = self.router.read_outbound()
        except Exception as e:
            log.warning("sync_active_from_router: cannot read router outbound: %s", e)
            return None
        vless = next((o for o in payload.get("outbounds", []) if o.get("tag") == "vless-reality"), None)
        if not vless:
            log.warning("sync_active_from_router: no vless-reality outbound on router")
            return None
        try:
            host, port = _endpoint(vless)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            log.warning("sync_active_from_router: unexpected outbound shape: %s", e)
            return None
        locations = self.state.read_subscription().get("locations", [])
        st = self.state.read_state()
        entry_code = None
        link = (vless.get("streamSettings") or {}).get("sockopt", {}).get("dialerProxy")
        if link:
            entry_out = next((o for o in payload.get("outbounds", []) if o.get("tag") == link), None)
            if link != CHAIN_ENTRY_TAG or entry_out is None:
                return None
            if st.get("active_entry_code"):
                available = {loc["code"] for loc in locations}
                missing = [code for code in (st["active_entry_code"], st.get("active_code")) if code not in available]
                if missing:
                    self.state.write_state({"active_status": STATUS_STALE, "active_missing_codes": missing})
                    return None
            entry_code = _match_installed_location(entry_out, locations, st.get("active_entry_code"), chain_node=True)
            if entry_code is None:
                return None
        code = _match_installed_location(vless, locations, st.get("active_code"), chain_exit=bool(link), chain_node=bool(link))
        if code is None or code == entry_code:
            log.warning("sync_active_from_router: installed Main cannot be matched to subscription")
            return None
        if st.get("active_code") != code or st.get("active_entry_code") != entry_code or (entry_code and not st.get("applied_main_config_hashes")):
            self.state.write_state({"active_code": code, "active_entry_code": entry_code,
                                    "active_missing_codes": [], "active_status": STATUS_OK,
                                    "active_route": self.route_info(code, entry_code),
                                    "applied_main_fingerprint": digest(json.dumps(payload, indent=2, ensure_ascii=False).encode()),
                                    "applied_main_config_hashes": config_updates.hashes(payload)})
            self._mark_hysteria_unknown()
            log.info("sync_active_from_router: matched router outbound to '%s'", code)
        return code

    @router_mutation
    def switch(self, code: str, trigger: str = TRIGGER_MANUAL, *, entry_code: str | None = None) -> None:
        loc = self._find_location(code)
        if loc is None:
            raise UnknownCodeError(f"no location with code '{code}'")
        operation = lambda: self._apply_and_record(loc, trigger=trigger, warning=self.cached_subscription_warning(), entry_code=entry_code)
        if self.failover_loop:
            self.failover_loop.run_exclusive(operation)
        else:
            operation()
        self.check_after_apply()

    def prepare_main_operation(self, code: str, trigger: str = TRIGGER_MANUAL, *, entry_code: str | None = None,
                               expected_main_sha256: str | None = None) -> dict:
        """Prepare immutable Main-only input for the server-owned operation worker."""
        loc = self._find_location(code)
        if loc is None:
            raise UnknownCodeError(f"no location with code '{code}'")
        entry = self._main_entry(code, entry_code)
        main = build_outbound(loc, entry)
        if expected_main_sha256 and digest(main.encode()) != expected_main_sha256:
            # A route check approved other bytes; never install a route nobody checked.
            raise RoutingError("The route configuration changed after it was checked. Recheck routes before applying.",
                               409, STALE_CODE)
        warning = self.cached_subscription_warning()
        bundle_id, environment = self.device_locations.prepare(None,
            main=main, main_only=True,
            state_patch=self._main_state_patch(loc, trigger, entry),
            history={"action": ACTION_SWITCH, "trigger": trigger, "code": code, "entry_code": entry_code,
                     **({"warning": warning} if warning else {})})
        return {"bundle_id": bundle_id, "environment": environment,
                **({"warning": warning} if warning else {})}

    def route_info(self, code, entry_code=None):
        st = self.state.read_state()
        saved = st.get("active_route", {}) if st.get("active_code") == code and st.get("active_entry_code") == entry_code else {}
        locations = self.state.read_subscription().get("locations", [])
        exit = next((loc for loc in locations if loc.get("code") == code), None)
        entry = next((loc for loc in locations if loc.get("code") == entry_code), None) if entry_code else None
        return {"mode": "chain" if entry_code else "single", "exit_code": code,
                "exit_name": exit.get("name", code) if exit else saved.get("exit_name", code), "entry_code": entry_code,
                "entry_name": entry.get("name", entry_code) if entry else saved.get("entry_name", entry_code)}

    def _main_entry(self, code, entry_code):
        if entry_code is None:
            return None
        if not isinstance(entry_code, str) or not entry_code:
            raise RoutingError("entry_code must be a non-empty string or null", 400, "entry_code")
        if entry_code == code:
            raise RoutingError("Entry and exit locations must be different", 400, "chain")
        entry = self._find_location(entry_code)
        if entry is None:
            raise RoutingError(f"No saved location with code '{entry_code}'", 409, "location")
        return entry

    def cached_subscription_warning(self) -> str | None:
        """Ordinary location changes use the available subscription without fetching."""
        return CACHED_SUBSCRIPTION_WARNING if self.state.read_state().get("last_update_status") == RESULT_FAIL else None

    def finalize_main_operation(self, op: dict, bundle: dict) -> None:
        if not bundle.get("state_patch", {}).get("applied_main_config_hashes"):
            # Upgrade recovery: old submitted bundles contain the applied bytes
            # even when the provider cache has since changed.
            from . import device_routing
            _, payload = self.routing.store.blob("bundles", bundle["id"])
            files = device_routing.unpack(payload)
            code = bundle.get("state_patch", {}).get("active_code") or op.get("target_code")
            fingerprint = digest(files[device_routing.OUTBOUNDS_FILE])
            main_hashes = config_updates.hashes(jsonc.loads(files[device_routing.OUTBOUNDS_FILE].decode("utf-8-sig")))
            patch = self.pending_config_patch(code, applied_main=fingerprint, main_hashes=main_hashes)
            patch["applied_main_fingerprint"] = fingerprint
            patch["applied_main_config_hashes"] = main_hashes
            if "failover_active" not in bundle.get("state_patch", {}):
                whitelist = self.state.read_failover().get("whitelist", [])
                active = bool(whitelist and code in whitelist and code != whitelist[0])
                patch.update(failover_active=active, failover_since=op["completed_at"] if active else None)
            self.state.write_state(patch)
        self._mark_hysteria_unknown()

    def pending_config_patch(self, code: str | None, *, applied_main=None, main_hashes=None,
                             device_state=None, main_changed=False, route_patch=None) -> dict:
        """Keep un-applied fixed-exit updates and their original scheduling anchor."""
        st = self.state.read_state()
        locations = {loc["code"]: loc for loc in self.state.read_subscription().get("locations", [])}
        entry_code = (route_patch if route_patch is not None else st).get("active_entry_code")
        entry = self._find_location(entry_code) if entry_code else None
        loc = self._find_location(code)
        fingerprint = applied_main or st.get("applied_main_fingerprint")
        applied_hashes = main_hashes or (st.get("applied_main_config_hashes") if applied_main is None else None)
        main_kind = None
        if loc and applied_hashes:
            main_kind = config_updates.change_kind(applied_hashes, config_updates.location_hashes(loc, entry))
        elif loc:
            main_pending = digest(build_outbound(loc, entry).encode()) != fingerprint if fingerprint else (
                bool(entry_code) or main_changed or st.get("pending_main_config", st.get("pending_reapply_code") == code))
            main_kind = config_updates.CONFIG if main_pending else None
        if entry_code and (entry is None or loc is None):
            main_kind = config_updates.CONFIG
        device_kind = self.device_locations.pending_update_kind(locations, doc=device_state)
        kind = config_updates.combined_kind([main_kind, device_kind]) if code else None
        pending = kind is not None
        was_pending = bool(st.get("pending_reapply_code"))
        since = ((st.get("pending_reapply_since") if was_pending else None) or _now_iso()) if pending else None
        non_sni_since = None
        if kind == config_updates.CONFIG:
            non_sni_since = st.get("pending_non_sni_since") if was_pending else None
            if not non_sni_since:
                non_sni_since = since if st.get("pending_update_kind") != config_updates.SNI else _now_iso()
        return {"pending_main_config": main_kind is not None, "pending_device_configs": device_kind is not None,
                "pending_update_kind": kind, "pending_non_sni_since": non_sni_since,
                "pending_reapply_code": code if pending else None,
                "pending_reapply_entry_code": entry_code if pending else None,
                "pending_reapply_since": since}

    def _upgrade_main_config_hashes(self, st: dict, old: dict | None) -> None:
        """Learn an older installation's baseline only from confirmed applied data."""
        if st.get("applied_main_config_hashes") or not st.get("applied_main_fingerprint"):
            return
        fingerprint = st["applied_main_fingerprint"]
        if old and digest(build_outbound(Location(**old)).encode()) == fingerprint:
            hashes = config_updates.location_hashes(Location(**old))
        else:
            try:
                payload = self.router.read_outbound()
                if not isinstance(payload, dict) or digest(json.dumps(payload, indent=2, ensure_ascii=False).encode()) != fingerprint:
                    return
                hashes = config_updates.hashes(payload)
            except Exception:
                # A missing baseline must never downgrade an unknown change to SNI-only.
                return
        self.state.write_state({"applied_main_config_hashes": hashes})

    def _main_state_patch(self, loc: Location, trigger: str, entry: Location | None = None) -> dict:
        patch = {"active_code": loc.code, "active_entry_code": entry.code if entry else None,
                 "active_missing_codes": [], "active_status": STATUS_OK,
                 "active_route": self.route_info(loc.code, entry.code if entry else None),
                 "xkeen_state": XKEEN_RUNNING, "xkeen_stop_cause": None,
                 "applied_main_fingerprint": digest(build_outbound(loc, entry).encode()),
                 "applied_main_config_hashes": config_updates.location_hashes(loc, entry)}
        if trigger in {TRIGGER_MANUAL, TRIGGER_FAILOVER}:
            whitelist = self.state.read_failover().get("whitelist", [])
            active = bool(not entry and whitelist and loc.code in whitelist and loc.code != whitelist[0])
            patch.update(failover_active=active, failover_since=_now_iso() if active else None)
        return patch

    @router_mutation
    def update(self, trigger: str = TRIGGER_MANUAL) -> dict:
        result = self._refresh_subscription(trigger)
        if not result["recovery_attempted"]:
            self._check_current_route_after_update()
        return result

    def _refresh_subscription(self, trigger: str, *, recover: bool = True, allow_cached: bool = False) -> dict:
        st = self.state.read_state()
        url = st.get("subscription_url")
        try:
            if not url:
                raise ValueError("subscription_url is not set")
            new_locs = self._fetch_and_parse(url)
        except Exception:
            self.state.write_state({"last_update_status": RESULT_FAIL})
            if not allow_cached:
                self._log_history(action=ACTION_UPDATE, trigger=trigger, result=RESULT_FAIL,
                                  message="Subscription refresh failed; saved configurations were kept.")
                raise
            # Only fetching/parsing can fall back. An error while saving or
            # reconciling a successfully fetched subscription must still fail.
            self._log_history(action=ACTION_UPDATE, trigger=trigger, result=RESULT_FAIL,
                              cached_subscription=True, message=CACHED_SUBSCRIPTION_WARNING)
            log.warning(CACHED_SUBSCRIPTION_WARNING)
            return {"cached": True, "warning": CACHED_SUBSCRIPTION_WARNING}
        operation = lambda: self._update_from_locations(new_locs, trigger=trigger, recover=recover)
        if self.failover_loop:
            return self.failover_loop.run_exclusive(operation)
        return operation()

    def refresh_before_apply(self, trigger: str = TRIGGER_MANUAL) -> dict:
        """Try a fresh subscription, retaining saved exits when it is unavailable."""
        return self._refresh_subscription(trigger, recover=False, allow_cached=True)

    def check_after_apply(self) -> bool:
        """Persist fresh diagnostics without recursively switching during an apply."""
        if not self.failover_loop or self.state.read_state().get("xkeen_state") == XKEEN_STOPPED:
            return True
        try:
            result = self.failover_loop.check_current_route(allow_failover=False)
            return not bool(result and result.get("stale"))
        except Exception:
            log.exception("post-apply route check failed")
            return False

    def _check_current_route_after_update(self) -> None:
        """Refresh shared health without turning a successful update into an error."""
        st = self.state.read_state()
        if (not self.failover_loop or st.get("xkeen_state") == XKEEN_STOPPED
                or self._find_location(st.get("active_code")) is None):
            return
        try:
            self.failover_loop.check_current_route()
        except Exception:
            log.exception("automatic route check failed")

    def _update_from_locations(self, new_locs: list[Location], trigger: str, *, recover: bool = True) -> dict:
        st = self.state.read_state()
        old_sub = self.state.read_subscription()
        old_failover = self.state.read_failover()
        self.state.write_subscription({
            "fetched_at": _now_iso(),
            "locations": [asdict(l) for l in new_locs],
        })
        self.reconcile_failover_config()
        result = {
            "noop": True,
            "reapplied": False,
            "queued_reapply": False,
            "stale": False,
            "recovery_attempted": False,
            "recovered": False,
            "recovery_active_after": None,
            "recovery_attempts": [],
        }
        active_code = st.get("active_code")
        if not active_code:
            # Subscription just populated; try syncing from router now.
            synced = self.sync_active_from_router()
            if synced:
                active_code = synced
        st = self.state.read_state()
        entry_code = st.get("active_entry_code")
        if active_code and entry_code:
            missing = [code for code in (entry_code, active_code) if _find_by_code(new_locs, code) is None]
            patch = self.pending_config_patch(active_code)
            patch.update(active_status=STATUS_STALE if missing else STATUS_OK, active_missing_codes=missing)
            self.state.write_state(patch)
            result.update(stale=bool(missing), queued_reapply=bool(patch["pending_reapply_code"]),
                          noop=not bool(patch["pending_reapply_code"]))
            self.state.write_state({"last_update_at": _now_iso(), "last_update_status": RESULT_OK})
            newly_pending = bool(patch["pending_reapply_code"]) and st.get("pending_reapply_code") != active_code
            if missing or newly_pending:
                message = ("active chain location vanished from subscription" if missing else
                           "active config update pending")
                self._log_history(action=ACTION_UPDATE, trigger=trigger, result=RESULT_OK,
                                  code=active_code, entry_code=entry_code, message=message)
            return result
        if active_code:
            new_active = _find_by_code(new_locs, active_code)
            old_active = _find_by_code_dicts(old_sub.get("locations", []), active_code)
            if new_active is None:
                patch = {"active_status": STATUS_STALE}
                if st.get("pending_reapply_code") == active_code:
                    patch.update({
                        "pending_reapply_code": None,
                        "pending_reapply_since": None,
                        "pending_update_kind": None,
                        "pending_non_sni_since": None,
                    })
                self.state.write_state(patch)
                self._log_history(
                    action=ACTION_UPDATE, trigger=trigger, result=RESULT_OK,
                    message=f"active '{active_code}' vanished from subscription",
                )
                result["stale"] = True
                was_managed = (
                    old_failover.get("enabled")
                    and active_code in old_failover.get("whitelist", [])
                )
                if recover and was_managed and self.failover_loop:
                    recovery = self.failover_loop.recover_vanished_active()
                    result["recovery_attempted"] = recovery["attempted"]
                    result["recovered"] = recovery["recovered"]
                    result["recovery_active_after"] = recovery["active_after"]
                    result["recovery_attempts"] = recovery["attempts"]
                    if recovery["active_after"] != active_code:
                        result["stale"] = False
                        result["noop"] = False
            else:
                main_changed = _requires_reapply(old_active, new_active)
                self._upgrade_main_config_hashes(st, old_active)
                patch = self.pending_config_patch(active_code, main_changed=main_changed)
                self.state.write_state(patch)
                if patch["pending_reapply_code"]:
                    if st.get("pending_reapply_code") != active_code:
                        self._log_history(action=ACTION_UPDATE, trigger=trigger, result=RESULT_OK,
                                          code=active_code, message="active config update pending")
                    if main_changed or patch["pending_device_configs"]:
                        result["queued_reapply"] = True
                        result["noop"] = False
        self.state.write_state({
            "last_update_at": _now_iso(),
            "last_update_status": RESULT_OK,
        })
        return result

    def auto_update_status(self, st: dict | None = None) -> dict:
        st = self.state.read_state() if st is None else st
        due = _auto_update_due(st)
        return {
            "enabled": st["auto_update_enabled"],
            "mode": st["auto_update_mode"],
            "daily_time": st["auto_update_daily_time"],
            "timezone": "Europe/Moscow",
            "interval_minutes": st["auto_update_interval_minutes"],
            "sni_daily": st["auto_update_sni_daily"],
            "next_apply_at": due.isoformat() if due else None,
        }

    def set_auto_update(self, config: dict) -> dict:
        enabled = config.get("enabled")
        interval = config.get("interval_minutes")
        mode = config.get("mode", "interval")
        daily_time = config.get("daily_time", "04:30")
        sni_daily = config.get("sni_daily", self.state.read_state()["auto_update_sni_daily"])
        if type(enabled) is not bool:
            raise ValueError("enabled must be boolean")
        if type(sni_daily) is not bool:
            raise ValueError("sni_daily must be boolean")
        if type(interval) is not int or not MIN_AUTO_UPDATE_MINUTES <= interval <= MAX_AUTO_UPDATE_MINUTES:
            raise ValueError(f"interval_minutes must be an integer from {MIN_AUTO_UPDATE_MINUTES} to {MAX_AUTO_UPDATE_MINUTES}")
        if mode not in ("interval", "daily"):
            raise ValueError("mode must be interval or daily")
        if not isinstance(daily_time, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", daily_time):
            raise ValueError("daily_time must be HH:MM (00:00–23:59)")

        def operation():
            st = self.state.read_state()
            settings = {
                "auto_update_enabled": enabled,
                "auto_update_interval_minutes": interval,
                "auto_update_mode": mode,
                "auto_update_daily_time": daily_time,
                "auto_update_sni_daily": sni_daily,
            }
            if any(st[key] != value for key, value in settings.items()):
                self.state.write_state({**settings, "auto_update_changed_at": _now_iso()})
            return self.auto_update_status()

        if self.failover_loop:
            return self.failover_loop.run_exclusive(operation)
        return operation()

    @router_mutation
    def apply_pending_reapply(self) -> bool:
        def operation():
            st = self.state.read_state()
            due = _auto_update_due(st)
            now = datetime.now(timezone.utc)
            if due is None or now < due or st.get("xkeen_state") == XKEEN_STOPPED:
                return False
            # Persist before I/O so a failure or process restart cannot cause a retry storm.
            self.state.write_state({"auto_update_attempt_at": now.isoformat()})
            return self._apply_pending_reapply(trigger=TRIGGER_AUTO, action=ACTION_ACTIVE_REFRESH,
                scheduled_at=now, previous_attempt_at=st.get("auto_update_attempt_at"))

        if self.failover_loop:
            return self.failover_loop.run_exclusive(operation)
        return operation()

    @router_mutation
    def apply_pending_reapply_now(self) -> bool:
        operation = lambda: self._apply_pending_reapply(
            trigger=TRIGGER_MANUAL,
            action=ACTION_ACTIVE_REFRESH,
        )
        if self.failover_loop:
            return self.failover_loop.run_exclusive(operation)
        return operation()

    @router_mutation
    def recover_pending_active(self) -> bool:
        return self._apply_pending_reapply(
            trigger=TRIGGER_FAILOVER,
            action=ACTION_ACTIVE_REFRESH,
        )

    def has_pending_reapply(self, code: str) -> bool:
        return self.state.read_state().get("pending_reapply_code") == code

    @router_mutation
    def set_subscription_url(self, url: str) -> None:
        try:
            locs = self._fetch_and_parse(url)
        except Exception as e:
            raise ValueError("Could not load the subscription. Check its URL and try again.") from e
        if not locs:
            raise ValueError("The subscription contains no supported locations.")
        operation = lambda: self._update_from_locations(
            locs, trigger=TRIGGER_MANUAL,
        )
        if self.failover_loop:
            result = self.failover_loop.run_exclusive(operation)
        else:
            result = operation()
        self.state.write_state({"subscription_url": url})
        self._log_history(
            action=ACTION_URL_CHANGE, trigger=TRIGGER_MANUAL,
            result=RESULT_OK, message=url,
        )
        if not result["recovery_attempted"]:
            self._check_current_route_after_update()

    @router_mutation
    def apply_failover(self, code: str, reason: str, *, refreshed: bool = False) -> None:
        """Apply a failover-triggered switch. reason is used as history action
        (one of: failover-switch, failback, auto-recovery).
        """
        if self.state.read_state().get("active_entry_code"):
            return
        loc = self._find_location(code)
        if loc is None:
            raise UnknownCodeError(f"no location with code '{code}'")
        self._apply_and_record(loc, trigger=TRIGGER_FAILOVER, action=reason,
                               warning=self.cached_subscription_warning())
        if not refreshed:
            self.check_after_apply()

    @router_mutation
    def handle_total_failure(self) -> None:
        """Called when Decider says all whitelist locations are dead.
        Stops xkeen and records cause. Does NOT raise on router error — logs and returns.
        """
        if self.state.read_state().get("active_entry_code") or self.device_locations.has_assignments():
            # Stopping the single Xray would also stop independent device exits.
            return
        try:
            self.router.run_xkeen("stop")
        except Exception as e:
            self._log_history(
                action=ACTION_TOTAL_FAILURE_STOP, trigger=TRIGGER_FAILOVER,
                result=RESULT_FAIL, message=str(e),
            )
            return
        self.state.write_state({
            "xkeen_state": XKEEN_STOPPED,
            "xkeen_stop_cause": "failover",
        })
        self._log_history(
            action=ACTION_TOTAL_FAILURE_STOP, trigger=TRIGGER_FAILOVER,
            result=RESULT_OK, message="all whitelisted unreachable",
        )

    def _apply_and_record(
        self,
        loc: Location,
        trigger: str,
        action: str = ACTION_SWITCH,
        history_code: str | None = None,
        refresh_locations: bool = False,
        warning: str | None = None,
        entry_code: str | None = None,
    ) -> None:
        entry = self._main_entry(loc.code, entry_code)
        payload = build_outbound(loc, entry)
        patch = self._main_state_patch(loc, trigger, entry)
        try:
            op = self.device_locations.apply_main(payload, loc.code, state_patch=patch,
                history={"action": action, "trigger": trigger, "code": history_code or loc.code, "entry_code": entry_code,
                         **({"warning": warning} if warning else {})},
                refresh_locations=refresh_locations)
        except Exception as e:
            # The durable transaction records its eventual result. An unknown
            # acknowledgement must not also become a misleading failed switch.
            if isinstance(e, RoutingError) and e.code in {"unknown", "recovery_failed"}:
                raise
            self._log_history(
                action=action, trigger=trigger, result=RESULT_FAIL,
                code=history_code or loc.code, entry_code=entry_code, message=str(e),
            )
            raise
        if op is not None:
            return
        patch.update(self.pending_config_patch(loc.code, applied_main=patch["applied_main_fingerprint"],
                                              main_hashes=patch["applied_main_config_hashes"], route_patch=patch))
        patch["last_apply_at"] = _now_iso()
        self.state.write_state(patch)
        self._mark_hysteria_unknown()
        self._log_history(
            action=action, trigger=trigger, result=RESULT_OK,
            code=history_code or loc.code, entry_code=entry_code, message=f"applied {loc.host}:{loc.port}",
            **({"warning": warning} if warning else {}),
        )

    def _apply_pending_reapply(self, trigger: str, action: str, *, scheduled_at=None, previous_attempt_at=None) -> bool:
        st = self.state.read_state()
        code = st.get("pending_reapply_code")
        if not code:
            return False
        if st.get("active_code") != code or st.get("active_entry_code") != st.get("pending_reapply_entry_code"):
            self.state.write_state({
                "pending_reapply_code": None,
                "pending_reapply_entry_code": None,
                "pending_reapply_since": None,
                "pending_update_kind": None,
                "pending_non_sni_since": None,
            })
            return False
        if st.get("xkeen_state") == XKEEN_STOPPED:
            return False
        try:
            # Apply refreshes first; checking here could recursively recover the same pending config.
            result = self._refresh_subscription(trigger)
        except Exception:
            self.state.write_state({"last_update_status": RESULT_FAIL})
            self._log_history(
                action=action, trigger=trigger, result=RESULT_FAIL, code=code,
                message="Subscription refresh failed; pending configurations were not applied.",
            )
            raise
        # Refresh can remove this location and recover to a fresh fallback itself.
        if result["recovery_attempted"] and result["recovery_active_after"] != code:
            return True
        st = self.state.read_state()
        if st.get("pending_reapply_code") != code or st.get("active_code") != code:
            return False
        if scheduled_at is not None:
            # The fresh subscription can reveal a different class of change.
            # Do not let a due SNI update bypass a newly started config interval.
            due = _auto_update_due({**st, "auto_update_attempt_at": previous_attempt_at}, now=scheduled_at)
            if due is None or due > scheduled_at:
                return False
        loc = self._find_location(code)
        if loc is None or st.get("active_missing_codes"):
            return False
        self._apply_and_record(loc, trigger=trigger, action=action, refresh_locations=True,
                               entry_code=st.get("active_entry_code"))
        if trigger != TRIGGER_FAILOVER:
            # Failover recovery already checks the refreshed route in its own cycle.
            self.check_after_apply()
        return True

    def _fetch_and_parse(self, url: str) -> list[Location]:
        raw = self.fetch_fn(url)
        decoded = decode_subscription(raw)
        return parse_locations(decoded)

    def _find_location(self, code: str) -> Location | None:
        for d in self.state.read_subscription().get("locations", []):
            if d.get("code") == code:
                return Location(**d)
        return None

    def _mark_hysteria_unknown(self) -> None:
        health_doc = self.state.read_health()
        health_map = dict(health_doc.get("map", {}))
        changed = False
        for loc in self.state.read_subscription().get("locations", []):
            code = loc.get("code")
            if not is_hysteria_location(loc):
                continue
            entry = health_map.get(code)
            if entry is None:
                continue
            unknown = {
                **entry,
                "ok": False,
                "fail_streak": 0,
                "ok_streak": 0,
                "last_latency_ms": None,
                "probe_method": "skipped",
                "tcp_ok": None,
                "tcp_checked_at": None,
                "tcp_latency_ms": None,
                "route_ok": None,
                "route_checked_at": None,
                "route_results": [],
            }
            if unknown != entry:
                health_map[code] = unknown
                changed = True
        if changed:
            self.state.write_health({
                **health_doc,
                "updated_at": _now_iso(),
                "map": health_map,
            })

    def _log_history(self, **entry) -> None:
        entry["ts"] = _now_iso()
        self.state.append_history(entry)

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)

def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

def _auto_update_due(st: dict, *, now=None) -> datetime | None:
    if not st["auto_update_enabled"] or not st.get("pending_reapply_code"):
        return None
    if st["pending_reapply_code"] != st.get("active_code") or st.get("pending_reapply_entry_code") != st.get("active_entry_code"):
        return None
    sni_schedule = st.get("auto_update_sni_daily", False) and st["auto_update_mode"] == "interval"
    daily = st["auto_update_mode"] == "daily" or (sni_schedule and st.get("pending_update_kind") == config_updates.SNI)
    pending_anchor = st.get("pending_non_sni_since") if sni_schedule and not daily else None
    anchors = []
    for value in (pending_anchor or st.get("pending_reapply_since"), st.get("auto_update_changed_at"), st.get("auto_update_attempt_at")):
        if value:
            anchors.append(datetime.fromisoformat(value).astimezone(timezone.utc))
    if not anchors:
        return None
    anchor = max(anchors)
    if daily:
        now = now or datetime.now(timezone.utc)
        hour, minute = map(int, st["auto_update_daily_time"].split(":"))
        target = max(anchor, now).astimezone(MOSCOW_TIMEZONE).replace(
            hour=hour, minute=minute, second=0, microsecond=0,
        )
        # Never catch up a missed overnight restart in the middle of a workday.
        if target <= anchor or target + DAILY_APPLY_WINDOW <= now:
            target += timedelta(days=1)
        return target.astimezone(timezone.utc)
    return anchor + timedelta(minutes=st["auto_update_interval_minutes"])

def _find_by_code(locs: list[Location], code: str) -> Location | None:
    for l in locs:
        if l.code == code:
            return l
    return None

def _find_by_code_dicts(locs: list[dict], code: str) -> dict | None:
    for l in locs:
        if l.get("code") == code:
            return l
    return None

def _requires_reapply(old: dict | None, new: Location) -> bool:
    if old is None:
        return True
    old_location = Location(**old)
    return _reapply_config(old_location) != _reapply_config(new)

def _reapply_config(loc: Location) -> dict:
    return json.loads(build_outbound(loc))

def _match_installed_location(outbound, locations, preferred=None, *, chain_exit=False, chain_node=False):
    """Keep legacy single matching; require evidence for new chain identities."""
    import copy
    try:
        host, port = _endpoint(outbound)
        matches = [loc["code"] for loc in locations if loc.get("host") == host and int(loc.get("port", 0)) == port]
    except (KeyError, IndexError, ValueError, TypeError):
        return None
    if not chain_node:
        return matches[0] if matches else None
    candidate = copy.deepcopy(outbound)
    candidate["tag"] = "vless-reality"
    exact = []
    for loc in locations:
        expected = json.loads(build_outbound(Location(**loc)))["outbounds"][0]
        if chain_exit:
            # Compare the generated transport, including originally absent streamSettings.
            expected.setdefault("streamSettings", {}).setdefault("sockopt", {})["dialerProxy"] = CHAIN_ENTRY_TAG
        if expected == candidate:
            exact.append(loc["code"])
    if exact:
        return preferred if preferred in exact else exact[0] if len(exact) == 1 else None
    # A refreshed saved node can have new credentials; its endpoint may retain
    # that identity, but cannot establish a different chain node's identity.
    return preferred if preferred in matches else None
