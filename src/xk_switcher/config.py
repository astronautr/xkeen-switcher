"""Environment-variable parsing for the application."""
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_LISTEN_HOST = "0.0.0.0"
DEFAULT_LISTEN_PORT = 8080
DEFAULT_SUBSCRIPTION_UPDATE_INTERVAL_SEC = 3600
DEFAULT_DATA_DIR = "/data"
DEFAULT_UI_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_ROUTER_USER = "root"
DEFAULT_ROUTER_PORT = 22
DEFAULT_SSH_KEY = "/root/.ssh/id_ed25519"
DEFAULT_KNOWN_HOSTS = "/root/.ssh/known_hosts"
DEFAULT_FAILOVER_CHECK_INTERVAL_SEC = 300
DEFAULT_FAILOVER_FAIL_THRESHOLD = 3
DEFAULT_FAILOVER_GRACE_AFTER_SWITCH_SEC = 60
DEFAULT_FAILOVER_DAMPENING_TICKS = 3
DEFAULT_FAILOVER_TCP_TIMEOUT_SEC = 3

@dataclass
class Config:
    router_host: str
    router_user: str
    router_port: int
    ssh_key: str
    known_hosts: str
    ssh_password: str | None
    subscription_url: str | None
    data_dir: Path
    listen_host: str
    listen_port: int
    subscription_update_interval_sec: int
    log_level: str
    failover_check_interval_sec: int
    failover_fail_threshold: int
    failover_grace_after_switch_sec: int
    failover_dampening_ticks: int
    failover_tcp_timeout_sec: int
    keenetic_url: str = ""
    keenetic_user: str = ""
    keenetic_password: str = field(default="", repr=False)
    xkeen_policy_ids: tuple[str, ...] = ()

    ui_dist: Path = DEFAULT_UI_DIST

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            ui_dist=Path(os.environ.get("XK_UI_DIST") or DEFAULT_UI_DIST),
            router_host=os.environ.get("ROUTER_HOST", "mock"),
            router_user=os.environ.get("ROUTER_USER", DEFAULT_ROUTER_USER),
            router_port=int(os.environ.get("ROUTER_PORT", DEFAULT_ROUTER_PORT)),
            ssh_key=os.environ.get("SSH_KEY", DEFAULT_SSH_KEY),
            known_hosts=os.environ.get("KNOWN_HOSTS", DEFAULT_KNOWN_HOSTS),
            ssh_password=os.environ.get("SSH_PASSWORD") or None,
            subscription_url=os.environ.get("SUB_URL") or None,
            data_dir=Path(os.environ.get("DATA_DIR", DEFAULT_DATA_DIR)),
            listen_host=os.environ.get("LISTEN_HOST", DEFAULT_LISTEN_HOST),
            listen_port=int(os.environ.get("LISTEN_PORT", DEFAULT_LISTEN_PORT)),
            subscription_update_interval_sec=int(os.environ.get(
                "XK_SUBSCRIPTION_UPDATE_INTERVAL_SEC",
                DEFAULT_SUBSCRIPTION_UPDATE_INTERVAL_SEC,
            )),
            log_level=os.environ.get("LOG_LEVEL", DEFAULT_LOG_LEVEL),
            failover_check_interval_sec=int(os.environ.get("XK_FAILOVER_CHECK_INTERVAL_SEC", DEFAULT_FAILOVER_CHECK_INTERVAL_SEC)),
            failover_fail_threshold=int(os.environ.get("XK_FAILOVER_FAIL_THRESHOLD", DEFAULT_FAILOVER_FAIL_THRESHOLD)),
            failover_grace_after_switch_sec=int(os.environ.get("XK_FAILOVER_GRACE_AFTER_SWITCH_SEC", DEFAULT_FAILOVER_GRACE_AFTER_SWITCH_SEC)),
            failover_dampening_ticks=int(os.environ.get("XK_FAILOVER_DAMPENING_TICKS", DEFAULT_FAILOVER_DAMPENING_TICKS)),
            failover_tcp_timeout_sec=int(os.environ.get("XK_FAILOVER_TCP_TIMEOUT_SEC", DEFAULT_FAILOVER_TCP_TIMEOUT_SEC)),
            keenetic_url=os.environ.get("KEENETIC_URL", ""),
            keenetic_user=os.environ.get("KEENETIC_USER", ""),
            keenetic_password=os.environ.get("KEENETIC_PASSWORD", ""),
            xkeen_policy_ids=tuple(value.strip() for value in os.environ.get("XK_DEVICE_POLICY_IDS", "").split(",") if value.strip()),
        )
