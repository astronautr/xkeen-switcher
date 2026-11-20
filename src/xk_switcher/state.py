"""File-backed state store with atomic writes and history rotation."""
import json
import hashlib
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from .connectivity import DEFAULT_ROUTE_CHECK_URLS

HISTORY_CAP = 100
STATE_FILE = "state.json"
SUBSCRIPTION_FILE = "subscription.json"
HISTORY_FILE = "history.jsonl"
HISTORY_ROTATED = "history.jsonl.1"
FAILOVER_FILE = "failover.json"
HEALTH_FILE = "health.json"
CONNECTIVITY_FILE = "connectivity.json"
TMP_SUFFIX = ".tmp"
AUTO_UPDATE_DEFAULTS = {
    "auto_update_enabled": True,
    "auto_update_mode": "daily",
    "auto_update_daily_time": "04:30",
    "auto_update_interval_minutes": 1440,
    "auto_update_sni_daily": False,
    "auto_update_changed_at": None,
    "auto_update_attempt_at": None,
}

FAILOVER_DEFAULTS = {
    "schema_version": 1,
    "enabled": False,
    "auto_failback": False,
    "auto_stop_on_total_failure": False,
    "auto_restart_on_recovery": False,
    "whitelist": [],
}

HEALTH_DEFAULTS = {
    "schema_version": 1,
    "updated_at": None,
    "next_probe_at": None,
    "map": {},
}

class State:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._event_capture = threading.local()
        self._state_path = self.data_dir / STATE_FILE
        self._sub_path = self.data_dir / SUBSCRIPTION_FILE
        self._hist_path = self.data_dir / HISTORY_FILE
        self._failover_path = self.data_dir / FAILOVER_FILE
        self._health_path = self.data_dir / HEALTH_FILE
        self._connectivity_path = self.data_dir / CONNECTIVITY_FILE

    def init(self, env_defaults: dict) -> dict:
        with self._lock:
            if self._state_path.exists():
                stored = self._read_json(self._state_path, {})
                if "token" in stored:
                    stored.pop("token")
                    self._atomic_write(self._state_path, stored)
                return self.read_state()
            initial = {
                **AUTO_UPDATE_DEFAULTS,
                "active_code": None,
                "active_entry_code": None,
                "active_missing_codes": [],
                "active_status": "ok",
                "xkeen_state": "unknown",
                "xkeen_stop_cause": None,
                "subscription_url": None,
                "last_update_at": None,
                "last_update_status": None,
                "failover_active": False,
                "failover_since": None,
                "last_apply_at": None,
                "pending_reapply_code": None,
                "pending_reapply_entry_code": None,
                "pending_reapply_since": None,
                "pending_update_kind": None,
                "pending_non_sni_since": None,
            }
            for k, v in env_defaults.items():
                if v is not None and k != "token":
                    initial[k] = v
            self._atomic_write(self._state_path, initial)
            return initial

    def read_state(self) -> dict:
        defaults = {
            **AUTO_UPDATE_DEFAULTS,
            "active_code": None,
            "active_entry_code": None,
            "active_missing_codes": [],
            "active_status": "ok",
            "xkeen_state": "unknown",
            "xkeen_stop_cause": None,
            "subscription_url": None,
            "last_update_at": None,
            "last_update_status": None,
            "failover_active": False,
            "failover_since": None,
            "last_apply_at": None,
            "pending_reapply_code": None,
            "pending_reapply_entry_code": None,
            "pending_reapply_since": None,
            "pending_update_kind": None,
            "pending_non_sni_since": None,
        }
        with self._lock:
            stored = self._read_json(self._state_path, defaults)
            stored.pop("token", None)
            return {**defaults, **stored}

    def write_state(self, patch: dict) -> None:
        with self._lock:
            current = self.read_state()
            current.update(patch)
            current.pop("token", None)
            self._atomic_write(self._state_path, current)

    def read_subscription(self) -> dict:
        with self._lock:
            return self._read_json(self._sub_path, {"fetched_at": None, "locations": []})

    def write_subscription(self, data: dict) -> None:
        with self._lock:
            self._atomic_write(self._sub_path, data)

    def read_failover(self) -> dict:
        with self._lock:
            return self._read_json(self._failover_path, FAILOVER_DEFAULTS)

    def write_failover(self, data: dict) -> None:
        with self._lock:
            self._atomic_write(self._failover_path, data)

    def read_health(self) -> dict:
        with self._lock:
            return self._read_json(self._health_path, HEALTH_DEFAULTS)

    def write_health(self, data: dict) -> None:
        with self._lock:
            self._atomic_write(self._health_path, data)

    def read_connectivity(self) -> dict:
        defaults = {
            "schema_version": 1,
            "check_urls": list(DEFAULT_ROUTE_CHECK_URLS),
        }
        with self._lock:
            stored = self._read_json(self._connectivity_path, defaults)
            return {**defaults, **stored}

    def write_connectivity(self, data: dict) -> None:
        with self._lock:
            self._atomic_write(self._connectivity_path, data)

    def append_history(self, entry: dict) -> None:
        with self._lock:
            self._rotate_if_needed()
            entry = {**entry, "event_id": str(uuid.uuid4())}
            with self._hist_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            for capture in getattr(self._event_capture, "stack", ()):
                capture.append(entry["event_id"])

    @contextmanager
    def capture_events(self):
        """Correlate synchronous request results without reading a racing tail."""
        stack = getattr(self._event_capture, "stack", None)
        if stack is None:
            stack = self._event_capture.stack = []
        captured = []
        stack.append(captured)
        try:
            yield captured
        finally:
            stack.pop()

    def append_history_once(self, entry: dict) -> None:
        """Reconciliation may replay after a crash between history and state writes."""
        operation_id = entry.get("operation_id")
        with self._lock:
            if operation_id:
                for path in (self._hist_path, self.data_dir / HISTORY_ROTATED):
                    if path.exists() and any(json.loads(line).get("operation_id") == operation_id
                                             for line in path.read_text(encoding="utf-8").splitlines()):
                        return
            self.append_history(entry)

    def read_history(self, limit: int = 10) -> list[dict]:
        with self._lock:
            if not self._hist_path.exists():
                return []
            lines = self._hist_path.read_text(encoding="utf-8").splitlines()
            return [json.loads(l) for l in lines[-limit:]]

    def read_events(self) -> list[dict]:
        """Retained completed events in append order, including the rotated file.

        The browser cursor uses event identity rather than timestamps, which may
        coincide or move backwards. Existing history remains readable unchanged.
        """
        with self._lock:
            events = []
            for path in (self.data_dir / HISTORY_ROTATED, self._hist_path):
                if not path.exists():
                    continue
                for line in path.read_text(encoding="utf-8").splitlines():
                    entry = json.loads(line)
                    if "event_id" not in entry:
                        entry["event_id"] = "legacy-" + hashlib.sha256(line.encode("utf-8")).hexdigest()
                    events.append(entry)
            return events[-2 * HISTORY_CAP:]

    def _rotate_if_needed(self) -> None:
        if not self._hist_path.exists():
            return
        count = sum(1 for _ in self._hist_path.open(encoding="utf-8"))
        if count < HISTORY_CAP:
            return
        rotated = self.data_dir / HISTORY_ROTATED
        if rotated.exists():
            rotated.unlink()
        self._hist_path.replace(rotated)

    @staticmethod
    def _read_json(path: Path, default: dict) -> dict:
        if not path.exists():
            return dict(default)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return dict(default)

    @staticmethod
    def _atomic_write(path: Path, data: Any) -> None:
        tmp = path.with_suffix(path.suffix + TMP_SUFFIX)
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
