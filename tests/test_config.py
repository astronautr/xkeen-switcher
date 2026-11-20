"""Config environment parsing."""
from pathlib import Path
from xk_switcher.config import Config


def test_failover_env_vars_defaults(monkeypatch):
    for k in [
        "XK_FAILOVER_CHECK_INTERVAL_SEC", "XK_FAILOVER_FAIL_THRESHOLD",
        "XK_FAILOVER_GRACE_AFTER_SWITCH_SEC", "XK_FAILOVER_DAMPENING_TICKS",
        "XK_FAILOVER_TCP_TIMEOUT_SEC", "XK_SUBSCRIPTION_UPDATE_INTERVAL_SEC",
    ]:
        monkeypatch.delenv(k, raising=False)
    cfg = Config.from_env()
    assert cfg.failover_check_interval_sec == 300
    assert cfg.failover_fail_threshold == 3
    assert cfg.failover_grace_after_switch_sec == 60
    assert cfg.failover_dampening_ticks == 3
    assert cfg.failover_tcp_timeout_sec == 3
    assert cfg.subscription_update_interval_sec == 3600


def test_failover_env_vars_overrides(monkeypatch):
    monkeypatch.setenv("XK_FAILOVER_CHECK_INTERVAL_SEC", "900")
    monkeypatch.setenv("XK_FAILOVER_FAIL_THRESHOLD", "5")
    monkeypatch.setenv("XK_FAILOVER_TCP_TIMEOUT_SEC", "10")
    monkeypatch.setenv("XK_SUBSCRIPTION_UPDATE_INTERVAL_SEC", "1800")
    cfg = Config.from_env()
    assert cfg.failover_check_interval_sec == 900
    assert cfg.failover_fail_threshold == 5
    assert cfg.failover_tcp_timeout_sec == 10
    assert cfg.subscription_update_interval_sec == 1800


def test_ui_dist_defaults_to_native_build_and_accepts_environment_override(monkeypatch):
    monkeypatch.delenv("XK_UI_DIST", raising=False)
    assert Config.from_env().ui_dist == Path(__file__).resolve().parents[1] / "frontend" / "dist"
    monkeypatch.setenv("XK_UI_DIST", "/trusted/ui-dist")
    assert Config.from_env().ui_dist == Path("/trusted/ui-dist")
