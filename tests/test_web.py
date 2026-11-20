import json
import re
import urllib.request
import urllib.parse
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from unittest.mock import MagicMock
import pytest
from xk_switcher.state import State
from xk_switcher.subscription import Location
from xk_switcher.router import Router
from tests._helpers import make_test_server, _Client, TEST_PASSWORD

@pytest.fixture
def server_state(tmp_data_dir):
    state = State(tmp_data_dir)
    state.init({"subscription_url": "https://sub.example"})
    state.write_subscription({
        "fetched_at": "2026-04-18T00:00:00Z",
        "locations": [asdict(Location(
            code="fi", name="FIN", protocol="vless", host="h", port=443,
            uuid="U", flow="", network="tcp", security="reality",
            sni="h", pbk="PBK", sid="SID", spx="/", fingerprint="chrome",
        ))],
    })
    return state

@pytest.fixture
def running_server(server_state):
    server, client = make_test_server(server_state, router=MagicMock(wraps=Router("mock")))
    yield client, server.service
    server.service.routing.stop()
    server.shutdown()
    server.server_close()

def _get(client, path):
    response = client.get(path)
    return response.status_code, response.json()

def _post(client, path, body):
    response = client.post(path, body)
    return response.status_code, response.json()

def _wait_operation(client, operation):
    for _ in range(300):
        status, result = _get(client, "/api/routing/operations/" + operation["id"])
        assert status == 200
        if result["phase"] in {"committed", "rolled_back", "rejected"}:
            return result
        time.sleep(.01)
    pytest.fail(f"Operation did not complete: {result}")

def test_health_returns_200(running_server):
    base, _ = running_server
    status, body = _get(base, "/api/health")
    assert status == 200
    assert body == {"ok": True}

@pytest.mark.parametrize("path,content_type", [
    ("/theme-boot.js", "application/javascript; charset=utf-8"),
    ("/manifest.webmanifest", "application/manifest+json"),
    ("/mobile-icons.svg", "image/svg+xml"),
    ("/icon-light.svg", "image/svg+xml"),
    ("/icon-dark.svg", "image/svg+xml"),
    ("/apple-touch-icon.png", "image/png"),
])
def test_mobile_assets_are_available_before_sign_in(running_server, path, content_type):
    base, _ = running_server
    client = _Client(base.base_url)
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["Content-Type"] == content_type
    assert response.headers["Cache-Control"] == "no-cache"
    assert response._body
    if not path.endswith((".svg", ".png")):
        assert path in client.get("/").text

def test_styleguide_is_static_and_not_linked_from_the_app(running_server, synthetic_ui_dist):
    base, _ = running_server
    client = _Client(base.base_url)
    page = client.get("/styleguide.html")
    assert page.status_code == 200
    assert page.headers["Content-Type"].startswith("text/html")
    assert page.headers["Cache-Control"] == "no-cache"
    assert page._body == (synthetic_ui_dist / "catalog.html").read_bytes()
    main = client.get("/").text
    assets = re.findall(r'(?:href|src)="(/ui-assets/[^"]+)"', page.text)
    assert {asset.rsplit(".", 1)[1] for asset in assets} == {"js", "css"}
    for asset in assets:
        assert client.get(asset).status_code == 200
        assert asset not in main
    assert "/styleguide.html" not in main
    assert "/catalog.html" not in main

def test_unlisted_static_files_are_not_served(running_server):
    base, _ = running_server
    client = _Client(base.base_url)
    for path in ("/web.py", "/asset-manifest.json", "/index.html", "/catalog.html", "/__ui-next__/",
                 "/__ui-next__/styleguide.html", "/ui-assets/missing.js", "/ui-assets/app.js.map",
                 "/ui-assets/%2e%2e/index.html", "/app.js", "/tokens.css"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json() == {"error": "static not found"}

def test_status_requires_session(running_server):
    base, _ = running_server
    status, _ = _get(_Client(base.base_url), "/api/status")
    assert status == 401

def test_status_returns_locations_with_session(running_server):
    base, _ = running_server
    status, body = _get(base, "/api/status")
    assert status == 200
    assert [l["code"] for l in body["available"]] == ["fi"]

def test_switch_via_post_with_session(running_server):
    base, svc = running_server
    status, body = _post(base, "/api/switch", {"code": "fi"})
    assert status == 202
    assert _wait_operation(base, body["operation"])["phase"] == "committed"
    assert svc.state.read_state()["active_code"] == "fi"
    svc.router.start_bundle.assert_called_once()

def test_switch_unknown_code_is_rejected_before_router_submission(running_server):
    base, _ = running_server
    status, body = _post(base, "/api/switch", {"code": "xx"})
    assert status == 202
    assert _wait_operation(base, body["operation"])["phase"] == "rejected"

def test_switch_acceptance_status_and_conflict_stay_responsive_during_preparation(running_server):
    client, service = running_server
    entered, release = threading.Event(), threading.Event()
    original = service.prepare_main_operation
    def delayed_preparation(code, trigger):
        entered.set()
        assert release.wait(5)
        return original(code, trigger)
    service.prepare_main_operation = delayed_preparation
    try:
        start = time.monotonic()
        status, accepted = _post(client, "/api/switch", {"code": "fi"})
        assert status == 202 and time.monotonic() - start < 1
        assert entered.wait(1)
        start = time.monotonic()
        status, snapshot = _get(client, "/api/status")
        assert status == 200 and time.monotonic() - start < 1
        assert snapshot["operation"]["id"] == accepted["operation"]["id"]
        start = time.monotonic()
        status, conflict = _post(client, "/api/switch", {"code": "fi"})
        assert status == 409 and time.monotonic() - start < 1
        assert conflict["operation"]["id"] == accepted["operation"]["id"]
    finally:
        release.set()
    assert _wait_operation(client, accepted["operation"])["phase"] == "committed"
    service.router.start_bundle.assert_called_once()

def test_switch_validation_failure_is_reported_by_operation(running_server):
    base, svc = running_server
    before = svc.router.read_bundle()
    def reject(ident, *_):
        svc.router._mock_wraps._mock_operations[ident] = {
            "phase": "rejected", "before_state": "running", "message": "Xray rejected the configuration: boom"}
    svc.router.start_bundle.side_effect = reject
    status, body = _post(base, "/api/switch", {"code": "fi"})
    assert status == 202
    operation = _wait_operation(base, body["operation"])
    assert operation["phase"] == "rejected" and "boom" in operation["message"]
    svc.router.start_bundle.assert_called_once()
    assert svc.router.read_bundle() == before


def test_manual_active_refresh_applies_pending_config(running_server):
    base, svc = running_server
    svc.state.write_state({
        "active_code": "fi",
        "xkeen_state": "running",
        "pending_reapply_code": "fi",
        "pending_reapply_since": "2026-08-31T09:00:00+00:00",
    })

    from tests.test_service import _encoded, _sample_loc
    svc.fetch_fn = MagicMock(return_value=_encoded([_sample_loc("fi", host="latest.example")]))
    status, body = _post(base, "/api/active-refresh", {})

    assert status == 200
    assert body == {"ok": True, "active_code": "fi", "active_entry_code": None,
                    "event_ids": [entry["event_id"] for entry in svc.state.read_events()]}
    svc.fetch_fn.assert_called_once()
    assert "latest.example" in svc.router.apply.call_args[0][0]
    svc.router.apply.assert_called_once()
    assert svc.state.read_state()["pending_reapply_code"] is None
    history = svc.state.read_history()
    assert history[-1]["action"] == "active-refresh"
    assert history[-1]["trigger"] == "manual"


def test_manual_active_refresh_rejects_when_nothing_pending(running_server):
    base, svc = running_server
    svc.state.write_state({"active_code": "fi", "xkeen_state": "running"})

    status, body = _post(base, "/api/active-refresh", {})

    assert status == 409
    assert "no active config update pending" in body["error"]
    svc.router.apply.assert_not_called()

def test_sub_url_get_returns_current(running_server):
    base, _ = running_server
    status, body = _get(base, "/api/sub-url")
    assert status == 200
    assert body["url"] == "https://sub.example"

def test_sub_url_get_cannot_change_url(running_server, monkeypatch):
    base, svc = running_server
    monkeypatch.setattr(svc, "set_subscription_url", MagicMock())
    encoded = urllib.parse.quote("https://new.example", safe="")
    status, body = _get(base, f"/api/sub-url?url={encoded}")
    assert status == 400
    svc.set_subscription_url.assert_not_called()

def test_index_page_served(running_server, synthetic_ui_dist):
    base, _ = running_server
    with urllib.request.urlopen(f"{base.base_url}/") as r:
        assert r.read() == (synthetic_ui_dist / "index.html").read_bytes()
        assert r.headers["Content-Type"] == "text/html; charset=utf-8"
        assert r.headers["Cache-Control"] == "no-cache"

def test_get_failover_returns_config_runtime_env_constants(tmp_path, monkeypatch):
    for k in [
        "XK_FAILOVER_CHECK_INTERVAL_SEC", "XK_FAILOVER_FAIL_THRESHOLD",
        "XK_FAILOVER_GRACE_AFTER_SWITCH_SEC", "XK_FAILOVER_DAMPENING_TICKS",
        "XK_FAILOVER_TCP_TIMEOUT_SEC",
    ]:
        monkeypatch.delenv(k, raising=False)
    from xk_switcher.state import State
    state = State(tmp_path)
    state.init({})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": True, "auto_restart_on_recovery": False,
        "whitelist": ["de1"],
    })
    state.write_health({
        "schema_version": 1,
        "updated_at": "2026-04-19T06:00:00+00:00",
        "next_probe_at": "2026-04-19T06:05:00+00:00",
        "map": {"de1": {"ok": True, "fail_streak": 0, "ok_streak": 3,
                        "last_ok_at": "2026-04-19T06:00:00+00:00",
                        "last_fail_at": None, "last_latency_ms": 50, "probe_method": "tcp"}},
    })
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.get("/api/failover")
        assert resp.status_code == 200
        body = resp.json()
        assert body["config"]["enabled"] is True
        assert body["config"]["whitelist"] == ["de1"]
        assert body["runtime"]["updated_at"] == "2026-04-19T06:00:00+00:00"
        assert body["runtime"]["map"]["de1"]["ok"] is True
        assert body["env_constants"]["check_interval_sec"] == 300
        assert body["env_constants"]["fail_threshold"] == 3
        assert body["env_constants"]["grace_after_switch_sec"] == 60
        assert body["env_constants"]["dampening_ticks"] == 3
        assert body["env_constants"]["tcp_timeout_sec"] == 3
    finally:
        server.shutdown()

def test_get_failover_requires_auth(tmp_path):
    from xk_switcher.state import State
    state = State(tmp_path)
    state.init({})
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = _Client(client.base_url).get("/api/failover")
        assert resp.status_code == 401
    finally:
        server.shutdown()


def test_get_connectivity_returns_independent_config(tmp_path):
    state = State(tmp_path)
    state.init({})
    state.write_connectivity({
        "schema_version": 1,
        "check_urls": ["https://one.example/health"],
    })
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.get("/api/connectivity")

        assert resp.status_code == 200
        assert resp.json()["config"]["check_urls"] == ["https://one.example/health"]
        assert resp.json()["max_urls"] == 10
    finally:
        server.shutdown()


def test_put_connectivity_saves_check_urls(tmp_path):
    state = State(tmp_path)
    state.init({})
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/connectivity", body={
            "check_urls": [
                "https://one.example/health",
                "http://two.example/ping",
            ],
        })

        assert resp.status_code == 200
        assert state.read_connectivity()["check_urls"] == [
            "https://one.example/health",
            "http://two.example/ping",
        ]
    finally:
        server.shutdown()


@pytest.mark.parametrize("check_urls", [
    [],
    ["ftp://example.com/file"],
    ["https://example.com", "https://example.com"],
])
def test_put_connectivity_rejects_invalid_check_urls(tmp_path, check_urls):
    state = State(tmp_path)
    state.init({})
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/connectivity", body={
            "check_urls": check_urls,
        })

        assert resp.status_code == 400
    finally:
        server.shutdown()


def _setup_state_with_sub(tmp_path, codes=("de1",)):
    state = State(tmp_path)
    state.init({})
    locs = [
        {"code": c, "name": c, "host": c, "port": 443,
         "sni": "s", "pbk": "p", "sid": "i", "uid": "u", "fp": "c",
         "flow": "", "ping": 50}
        for c in codes
    ]
    state.write_subscription({"locations": locs})
    return state


def test_put_failover_config_happy(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
            "whitelist": ["de1"],
        })
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert state.read_failover()["enabled"] is True
    finally:
        server.shutdown()


def test_put_failover_config_prunes_unknown_codes(tmp_path):
    state = _setup_state_with_sub(tmp_path, codes=("de1", "fi"))
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
            "whitelist": ["de1", "lv", "fi"],
        })
        assert resp.status_code == 200
        assert resp.json()["config"]["whitelist"] == ["de1", "fi"]
        assert state.read_failover()["whitelist"] == ["de1", "fi"]
    finally:
        server.shutdown()


def test_get_failover_prunes_unknown_codes_from_stored_config(tmp_path):
    state = _setup_state_with_sub(tmp_path, codes=("de1", "fi"))
    state.write_failover({
        "schema_version": 1, "enabled": False, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "lv", "fi"],
    })
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.get("/api/failover")

        assert resp.status_code == 200
        assert resp.json()["config"]["whitelist"] == ["de1", "fi"]
        assert state.read_failover()["whitelist"] == ["de1", "fi"]
    finally:
        server.shutdown()


def test_put_failover_config_rejects_enabled_whitelist_if_every_code_vanished(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
            "whitelist": ["lv"],
        })

        assert resp.status_code == 400
        assert "no available locations" in resp.json()["error"]
    finally:
        server.shutdown()


def test_put_failover_config_rejects_empty_whitelist_when_enabled(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
            "whitelist": [],
        })
        assert resp.status_code == 400
        assert "whitelist empty" in resp.json()["error"]
    finally:
        server.shutdown()


def test_put_failover_config_rejects_duplicates(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
            "whitelist": ["de1", "de1"],
        })
        assert resp.status_code == 400
        assert "duplicate" in resp.json()["error"]
    finally:
        server.shutdown()


def test_put_failover_config_rejects_auto_restart_without_stop(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": True,
            "whitelist": ["de1"],
        })
        assert resp.status_code == 400
        assert "auto_restart requires auto_stop" in resp.json()["error"]
    finally:
        server.shutdown()


def test_post_check_now_triggers_probe(tmp_path):
    from xk_switcher.state import State
    from tests._helpers import make_test_server
    state = State(tmp_path)
    state.init({})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": False,
        "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
        "whitelist": [],
    })
    server, client = make_test_server(state)
    try:
        resp = client.post("/api/failover/check-now")
        assert resp.status_code == 200
        assert "updated_at" in resp.json()
    finally:
        server.shutdown()


def test_api_status_includes_failover_snapshot(tmp_path):
    from xk_switcher.state import State
    from tests._helpers import make_test_server
    state = State(tmp_path)
    state.init({})
    state.write_failover({
        "schema_version": 1, "enabled": True, "auto_failback": True,
        "auto_stop_on_total_failure": True, "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    })
    state.write_state({
        "active_code": "ru2",
        "failover_since": "2026-04-19T06:00:00+00:00",
        "xkeen_stop_cause": None,
    })
    state.write_subscription({"locations": [
        {"code": "de1", "name": "de", "host": "h", "port": 443,
         "sni": "s", "pbk": "p", "sid": "i", "uid": "u", "fp": "c", "flow": "", "ping": 50},
        {"code": "ru2", "name": "ru", "host": "h", "port": 443,
         "sni": "s", "pbk": "p", "sid": "i", "uid": "u", "fp": "c", "flow": "", "ping": 50},
    ]})
    state.write_health({
        "schema_version": 1,
        "updated_at": "2026-04-19T06:00:00+00:00",
        "next_probe_at": "2026-04-19T06:05:00+00:00",
        "map": {"de1": {"ok": True, "fail_streak": 0, "ok_streak": 5,
                        "last_ok_at": None, "last_fail_at": None,
                        "last_latency_ms": 87, "probe_method": "tcp"}},
    })
    server, client = make_test_server(state)
    try:
        resp = client.get("/api/status")
        data = resp.json()
        assert data["failover"]["enabled"] is True
        assert data["failover"]["active"] is True
        assert data["failover"]["since"] == "2026-04-19T06:00:00+00:00"
        assert data["xkeen_stop_cause"] is None
        de1 = next(l for l in data["available"] if l["code"] == "de1")
        ru2 = next(l for l in data["available"] if l["code"] == "ru2")
        assert de1["health"]["ok"] is True
        assert de1["health"]["last_latency_ms"] == 87
        assert ru2["health"] is None  # not in health.map at all
    finally:
        server.shutdown()


def test_put_failover_config_rejects_non_list_whitelist(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        for bad in ["de1", {"de1": True}, 42]:
            resp = client.put("/api/failover/config", body={
                "enabled": True, "auto_failback": False,
                "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
                "whitelist": bad,
            })
            assert resp.status_code == 400
            assert "list of strings" in resp.json()["error"]
        resp = client.put("/api/failover/config", body={
            "enabled": True, "auto_failback": False,
            "auto_stop_on_total_failure": False, "auto_restart_on_recovery": False,
            "whitelist": ["de1", None],
        })
        assert resp.status_code == 400
        assert "list of strings" in resp.json()["error"]
    finally:
        server.shutdown()


def _fake_tcp_ok(self, host, port):
    return True, 42


def test_post_probe_single_code(tmp_path, monkeypatch):
    monkeypatch.setattr("xk_switcher.failover.FailoverLoop._tcp_probe", _fake_tcp_ok)
    state = _setup_state_with_sub(tmp_path)
    state.write_state({"active_code": "de1"})
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.post("/api/probe", body={"code": "de1"})
        assert resp.status_code == 200
        body = resp.json()
        assert "de1" in body["results"]
        assert body["results"]["de1"]["method"] == "tcp"
        assert body["results"]["de1"]["ok"] is True
        assert "health" in body
        assert body["health"]["map"]["de1"]["ok"] is True
    finally:
        server.shutdown()


def test_post_route_check_uses_failover_loop(running_server):
    base, svc = running_server
    svc.failover_loop = MagicMock()
    svc.failover_loop.check_current_route.return_value = {
        "active_code": "fi",
        "ok": True,
        "tcp": {"ok": True, "latency_ms": 12},
        "route": {
            "ok": True,
            "results": [
                {"name": "youtube", "ok": True, "status": 204, "latency_ms": 30},
                {"name": "avito", "ok": True, "status": 200, "latency_ms": 40},
            ],
        },
    }

    status, body = _post(base, "/api/route-check", {})

    assert status == 200
    assert body["active_code"] == "fi"
    assert body["ok"] is True
    svc.failover_loop.check_current_route.assert_called_once_with()


def test_post_probe_all_when_no_code(tmp_path, monkeypatch):
    monkeypatch.setattr("xk_switcher.failover.FailoverLoop._tcp_probe", _fake_tcp_ok)
    state = _setup_state_with_sub(tmp_path, codes=("de1", "de2"))
    state.write_state({"active_code": "de1"})
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.post("/api/probe", body={})
        assert resp.status_code == 200
        body = resp.json()
        assert set(body["results"].keys()) == {"de1", "de2"}
        assert body["results"]["de1"]["method"] == "tcp"
        assert body["results"]["de2"]["method"] == "tcp"
    finally:
        server.shutdown()


def test_post_probe_rejects_non_string_code(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.post("/api/probe", body={"code": 42})
        assert resp.status_code == 400
        assert "must be string" in resp.json()["error"]
    finally:
        server.shutdown()


def test_post_probe_codes_list(tmp_path, monkeypatch):
    monkeypatch.setattr("xk_switcher.failover.FailoverLoop._tcp_probe", _fake_tcp_ok)
    state = _setup_state_with_sub(tmp_path, codes=("de1", "de2", "ru1"))
    state.write_state({"active_code": "de1"})
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.post("/api/probe", body={"codes": ["de1", "ru1"]})
        assert resp.status_code == 200
        body = resp.json()
        assert set(body["results"].keys()) == {"de1", "ru1"}
        assert "de2" not in body["results"]
    finally:
        server.shutdown()


def test_post_probe_rejects_non_list_codes(tmp_path):
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    try:
        resp = client.post("/api/probe", body={"codes": "de1"})
        assert resp.status_code == 400
        assert "list of strings" in resp.json()["error"]
    finally:
        server.shutdown()


def test_password_login_sets_cookie_and_never_returns_secret(running_server):
    client, _ = running_server
    anonymous = _Client(client.base_url)
    response = anonymous.post("/api/auth/login", {"password": TEST_PASSWORD})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    cookie = response.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert "Max-Age=34560000" in cookie and "Secure" not in cookie
    status = anonymous.get("/api/status")
    assert status.status_code == 200
    assert "Max-Age=34560000" in status.headers["Set-Cookie"]
    assert status.headers["Cache-Control"] == "no-store"


def test_pairing_and_device_revocation_over_http(running_server):
    owner, _ = running_server
    guest = _Client(owner.base_url)
    code = owner.post("/api/auth/pairing-code").json()["code"]
    assert guest.post("/api/auth/pair", {"code": code}).status_code == 200
    sessions = owner.get("/api/auth/sessions").json()["sessions"]
    assert len(sessions) == 2
    assert all("secret_hash" not in row for row in sessions)
    other = next(row for row in sessions if not row["current"])
    response = owner.post("/api/auth/sessions/revoke", {"id": other["id"]})
    assert response.json() == {"ok": True, "current_revoked": False}
    assert guest.get("/api/status").status_code == 401
    assert owner.get("/api/status").status_code == 200
    assert guest.post("/api/auth/pair", {"code": code}).status_code == 401


@pytest.mark.parametrize("logout_path", ["/api/auth/logout", "/api/auth/sessions/revoke"])
def test_logout_does_not_renew_cookie(running_server, logout_path):
    client, _ = running_server
    current = client.get("/api/auth/session").json()["session_id"]
    response = client.post(logout_path, {"id": current})
    assert response.status_code == 200
    assert "Max-Age=0" in response.headers["Set-Cookie"]
    assert client.get("/api/status").status_code == 401

def test_delayed_response_preserves_the_new_browser_session(running_server, monkeypatch):
    client, service = running_server
    started, resume = threading.Event(), threading.Event()
    def delayed_status():
        started.set()
        assert resume.wait(4)
        return {"ok": True}
    monkeypatch.setattr(service, "status", delayed_status)
    with ThreadPoolExecutor(max_workers=1) as pool:
        old = pool.submit(client.get, "/api/status")
        try:
            assert started.wait(2)
            assert client.post("/api/auth/logout").status_code == 200
            assert client.post("/api/auth/login", {"password": TEST_PASSWORD}).status_code == 200
            replacement = client.get("/api/auth/session").json()
        finally:
            resume.set()
        response = old.result()
    assert response.status_code == 200
    assert "Set-Cookie" not in response.headers
    assert replacement["authenticated"]
    assert client.get("/api/auth/session").json() == replacement


@pytest.mark.parametrize("headers", [
    {"X-XK-Request": ""}, {"Origin": "http://untrusted.example"}, {"Origin": "null"},
    {"Content-Type": "text/plain"}, {"Content-Type": "application/x-www-form-urlencoded"},
])
@pytest.mark.parametrize("path", ["/api/auth/login", "/api/switch", "/api/auth/pair", "/api/auth/setup", "/api/auth/password"])
def test_mutations_require_same_origin_json_header(running_server, headers, path):
    client, svc = running_server
    response = client.post(path, {"password": TEST_PASSWORD, "code": "fi"}, headers=headers)
    assert response.status_code in (403, 415)
    assert response.headers.get("Access-Control-Allow-Origin") is None
    svc.router.apply.assert_not_called()


def test_same_origin_mutation_allowed(running_server):
    client, svc = running_server
    response = client.post("/api/switch", {"code": "fi"}, headers={"Origin": client.base_url})
    assert response.status_code == 202
    assert _wait_operation(client, response.json()["operation"])["phase"] == "committed"
    svc.router.start_bundle.assert_called_once()


def test_put_requires_request_header(running_server):
    client, _ = running_server
    assert client.put("/api/connectivity", {}, headers={"X-XK-Request": ""}).status_code == 403


def test_get_switch_has_no_side_effects(running_server):
    client, svc = running_server
    response = client.get("/api/switch?code=fi")
    assert response.status_code == 405
    assert response.json()["error"] == "Use POST to switch locations"
    svc.router.apply.assert_not_called()

def test_switch_hysteria_location_via_post_preserves_outbound(running_server):
    client, svc = running_server
    outbound = {"protocol": "hysteria2", "tag": "proxy", "settings": {"address": "nl.example", "port": 443}}
    svc.state.write_subscription({"locations": [asdict(Location(
        code="nl", name="NL HYSTERIA 2 🇳🇱", protocol="hysteria2",
        host="nl.example", port=443, outbound=outbound,
    ))]})
    response = client.post("/api/switch", {"code": "nl"})
    assert response.status_code == 202
    assert _wait_operation(client, response.json()["operation"])["phase"] == "committed"
    assert svc.state.read_state()["active_code"] == "nl"
    payload = svc.router.read_outbound()
    assert payload["outbounds"][0] == {**outbound, "tag": "vless-reality"}


def test_legacy_token_cannot_authorize_and_query_is_not_logged(running_server, caplog):
    client, _ = running_server
    anonymous = _Client(client.base_url)
    with caplog.at_level("INFO", logger="xk_switcher.web"):
        response = anonymous.get("/api/status?token=old-secret", headers={
            "X-Token": "old-secret", "Cookie": "xk_token=old-secret",
        })
    assert response.status_code == 401
    assert "old-secret" not in caplog.text
    assert "xk_token=;" in response.headers["Set-Cookie"]
    assert "Max-Age=0" in response.headers["Set-Cookie"]
    assert client.post("/api/token/rotate").status_code == 404


def test_http_rate_limit_returns_retry_after(running_server):
    client, _ = running_server
    anonymous = _Client(client.base_url)
    for _ in range(10):
        assert anonymous.post("/api/auth/pair", {"code": "bad"}).status_code == 401
    response = anonymous.post("/api/auth/pair", {"code": "bad"})
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0

def test_pairing_status_reports_connected_browser_only_to_issuer(running_server):
    owner, _ = running_server
    guest = _Client(owner.base_url)
    invitation = owner.post("/api/auth/pairing-code").json()
    path = "/api/auth/pairing-code?id=" + invitation["id"]
    assert guest.get(path).status_code == 401
    pending = owner.get(path)
    assert pending.json()["status"] == "pending"
    assert "code" not in pending.json()
    assert pending.headers["Cache-Control"] == "no-store"
    assert "xk_session=" in pending.headers["Set-Cookie"]
    assert guest.post("/api/auth/pair", {"code": invitation["code"]},
                      headers={"User-Agent": "Safari/604.1 iPhone"}).status_code == 200
    result = owner.get(path).json()
    assert result["status"] == "completed"
    assert result["device"]["label"] == "Safari · iPhone"
    assert result["device"]["id"] == guest.get("/api/auth/session").json()["session_id"]
    assert guest.get(path).status_code == 404
    assert owner.get("/api/auth/pairing-code?id=missing").status_code == 404
    assert owner.get("/api/auth/pairing-code").status_code == 404
    owner.post("/api/auth/pairing-code")
    assert owner.get(path).json() == result


def test_unconfigured_and_corrupted_auth_fail_closed(tmp_path):
    state = State(tmp_path)
    state.init({})
    server, client = make_test_server(state, authenticated=False)
    try:
        assert not client.get("/api/auth/session").json()["configured"]
        assert client.get("/api/status").status_code == 401
        assert client.post("/api/auth/login", {"password": TEST_PASSWORD}).status_code == 409
        (tmp_path / "auth.json").write_text("broken")
        assert client.get("/api/auth/session").status_code == 503
        assert client.get("/api/status").status_code == 503
        assert client.get("/api/health").status_code == 200
    finally:
        server.shutdown()
        server.server_close()

def test_first_run_setup_logs_in_once_over_http(tmp_path):
    state = State(tmp_path)
    state.init({})
    server, client = make_test_server(state, authenticated=False)
    try:
        assert client.get("/api/auth/session").json()["configured"] is False
        assert client.post("/api/auth/setup", {"password": "short"}).status_code == 400
        response = client.post("/api/auth/setup", {"password": TEST_PASSWORD})
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        assert "HttpOnly" in response.headers["Set-Cookie"]
        assert client.get("/api/status").status_code == 200
        stranger = _Client(client.base_url)
        assert stranger.post("/api/auth/setup", {"password": "replacement-password"}).status_code == 409
        assert stranger.get("/api/status").status_code == 401
    finally:
        server.shutdown()
        server.server_close()

def test_password_change_keeps_requesting_browser_and_revokes_old_sessions(running_server):
    client, _ = running_server
    guest = _Client(client.base_url)
    assert guest.post("/api/auth/login", {"password": TEST_PASSWORD}).status_code == 200
    old_cookie = "; ".join(f"{cookie.name}={cookie.value}" for cookie in client.cookies)
    body = {"current_password": TEST_PASSWORD, "password": "new-admin-password"}
    anonymous = _Client(client.base_url)
    assert anonymous.post("/api/auth/password", body).status_code == 401
    assert client.post("/api/auth/password", {**body, "current_password": "incorrect-password"}).status_code == 403
    assert client.get("/api/status").status_code == 200
    response = client.post("/api/auth/password", body)
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert "HttpOnly" in response.headers["Set-Cookie"]
    assert client.get("/api/status").status_code == 200
    assert anonymous.get("/api/status", headers={"Cookie": old_cookie}).status_code == 401
    assert guest.get("/api/status").status_code == 401
    assert guest.post("/api/auth/login", {"password": TEST_PASSWORD}).status_code == 401
    assert guest.post("/api/auth/login", {"password": body["password"]}).status_code == 200

def test_pending_refresh_fetch_failure_returns_error_without_router_apply(running_server):
    client, svc = running_server
    svc.state.write_state({"active_code": "fi", "pending_reapply_code": "fi", "xkeen_state": "running"})
    svc.fetch_fn = MagicMock(side_effect=RuntimeError("provider unavailable"))
    response = client.post("/api/active-refresh")
    assert response.status_code == 502
    assert "provider unavailable" not in response.json()["error"]
    assert response.json()["code"] == "unavailable"
    svc.router.apply.assert_not_called()
    assert svc.state.read_state()["pending_reapply_code"] == "fi"


@pytest.mark.parametrize("body", [[], "secret", 42, True])
def test_auth_rejects_non_object_json(running_server, body):
    client, _ = running_server
    assert client.post("/api/auth/login", body).status_code == 400


def test_malformed_request_does_not_log_secret(running_server, caplog):
    import socket
    client, _ = running_server
    port = urllib.parse.urlsplit(client.base_url).port
    with caplog.at_level("INFO", logger="xk_switcher.web"):
        with socket.create_connection(("127.0.0.1", port), timeout=2) as connection:
            connection.sendall(b"GET /?token=private-legacy-value HTTP/1.1 extra\r\n\r\n")
            response = connection.recv(4096)
    assert b"400" in response
    assert "private-legacy-value" not in caplog.text


def test_oversized_login_body_rejected(running_server):
    client, _ = running_server
    assert client.post("/api/auth/login", {"password": "x" * 65536}).status_code == 413

def test_auto_update_settings_persist_and_appear_in_status(running_server):
    client, svc = running_server
    assert client.get("/api/status").json()["auto_update"] == {
        "enabled": True, "mode": "daily", "daily_time": "04:30",
        "timezone": "Europe/Moscow", "interval_minutes": 1440, "sni_daily": False, "next_apply_at": None,
    }
    response = client.put("/api/auto-update", {"enabled": True, "interval_minutes": 30})
    assert response.status_code == 200
    assert response.json()["config"]["interval_minutes"] == 30
    restored = State(svc.state.data_dir).read_state()
    assert restored["auto_update_enabled"] is True
    assert restored["auto_update_interval_minutes"] == 30
    assert client.get("/api/status").json()["auto_update"]["enabled"] is True
    svc.router.apply.assert_not_called()

def test_sni_daily_settings_survive_reload_and_requests_from_older_clients(running_server):
    client, svc = running_server
    settings = {"enabled": True, "mode": "interval", "daily_time": "05:45", "interval_minutes": 120, "sni_daily": True}
    response = client.put("/api/auto-update", settings)
    assert response.status_code == 200
    assert response.json()["config"]["sni_daily"] is True
    restored = State(svc.state.data_dir).read_state()
    assert restored["auto_update_sni_daily"] is True
    assert restored["auto_update_daily_time"] == "05:45"
    assert client.get("/api/status").json()["auto_update"]["sni_daily"] is True
    settings.pop("sni_daily")
    assert client.put("/api/auto-update", settings).json()["config"]["sni_daily"] is True
    svc.router.apply.assert_not_called()

@pytest.mark.parametrize("body", [
    {}, {"enabled": "true", "interval_minutes": 60},
    {"enabled": True, "interval_minutes": True},
    {"enabled": True, "interval_minutes": 4},
    {"enabled": True, "interval_minutes": 10081},
    {"enabled": True, "interval_minutes": 5.5},
    {"enabled": True, "interval_minutes": "60"},
    {"enabled": True, "interval_minutes": 60, "sni_daily": "true"},
    {"enabled": True, "interval_minutes": 60, "sni_daily": 1},
    {"enabled": True, "interval_minutes": 60, "sni_daily": None},
])
def test_auto_update_rejects_invalid_settings_without_mutation(running_server, body):
    client, svc = running_server
    before = svc.state.read_state()
    assert client.put("/api/auto-update", body).status_code == 400
    assert svc.state.read_state() == before

def test_auto_update_requires_auth_and_request_marker(running_server):
    client, svc = running_server
    body = {"enabled": True, "interval_minutes": 60}
    assert _Client(client.base_url).put("/api/auto-update", body).status_code == 401
    assert client.put("/api/auto-update", body, headers={"X-XK-Request": ""}).status_code == 403
    assert client.put("/api/auto-update", body, headers={"Origin": "http://foreign.example"}).status_code == 403
    assert svc.state.read_state()["auto_update_mode"] == "daily"


@pytest.mark.parametrize("entry,code,status,error_code", [("fi", "fi", 400, "chain"), ("missing", "fi", 409, "location"),
                                                         ("fi", "missing", 409, "location"), (False, "fi", 400, "entry_code")])
def test_chain_request_validation(running_server, entry, code, status, error_code):
    client, service = running_server
    actual, body = _post(client, "/api/switch", {"code": code, "entry_code": entry})
    assert actual == status
    assert body["code"] == error_code
    assert not service.routing.store.operations()

def test_chain_http_status_and_same_exit_different_entry_conflict(running_server):
    from .test_service import _sample_loc, _seed_sub
    from xk_switcher.routing import new_id
    client, service = running_server
    _seed_sub(service.state, [_sample_loc("ru"), _sample_loc("fi"), _sample_loc("de")])
    request = {"code": "fi", "entry_code": "ru", "operation_id": new_id()}
    status, body = _post(client, "/api/switch", request)
    assert status == 202
    op = _wait_operation(client, body["operation"])
    assert op["phase"] == "committed", op
    assert op["target_route"]["entry_code"] == "ru"
    assert op["confirmed_route"]["entry_code"] == "ru"
    assert _post(client, "/api/switch", request)[0] == 202
    assert _post(client, "/api/switch", {**request, "entry_code": "de"})[0] == 409
    status, body = _get(client, "/api/status")
    assert body["active_code"] == "fi"
    assert body["active_route"]["mode"] == "chain"
    assert body["active_route"]["entry_code"] == "ru"
    assert body["failover"]["suspended"]


def _hold_coordinator(service, released, held, **activity):
    with service._op_lock, service.routing.activity(**activity):
        held.set()
        released.wait(5)


def test_probe_while_coordinator_is_held_is_a_busy_refusal_with_its_blocker(tmp_path):
    import threading
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    released, held = threading.Event(), threading.Event()
    holder = threading.Thread(target=_hold_coordinator, args=(server.service, released, held),
                              kwargs={"kind": "failover_check", "message": "Checking failover locations",
                                      "source": "failover", "scope": "diagnostic"})
    holder.start()
    try:
        assert held.wait(5)
        for path in ("/api/probe", "/api/route-check"):
            resp = client.post(path, body={})
            assert resp.status_code == 409, path
            body = resp.json()
            assert body["code"] == "busy"
            assert body["operation"]["kind"] == "failover_check"
            assert body["operation"]["source"] == "failover"
        status = client.get("/api/status").json()["operation"]
        assert status["ephemeral"] is True and status["scope"] == "diagnostic"
        preview = client.post("/api/routing/preview", body={"intent": "apply"})
        assert preview.status_code == 409
        assert preview.json()["code"] == "busy"
        assert preview.json()["operation"]["kind"] == "failover_check"
    finally:
        released.set()
        holder.join(5)
        server.shutdown()
    assert server.service.routing.public_operation() is None


def test_manual_probe_publishes_activity_while_it_holds_the_coordinator(tmp_path, monkeypatch):
    import threading
    started, finish = threading.Event(), threading.Event()
    def slow_probe(self, host, port):
        started.set()
        finish.wait(5)
        return True, 7
    monkeypatch.setattr("xk_switcher.failover.FailoverLoop._tcp_probe", slow_probe)
    state = _setup_state_with_sub(tmp_path)
    from tests._helpers import make_test_server
    server, client = make_test_server(state)
    results = {}
    worker = threading.Thread(target=lambda: results.update(resp=client.post("/api/probe", body={"code": "de1"})))
    worker.start()
    try:
        assert started.wait(5)
        observer = _Client(client.base_url)
        observer.cookies = client.cookies
        observer.opener = client.opener
        operation = observer.get("/api/status").json()["operation"]
        assert operation["kind"] == "probe"
        assert operation["scope"] == "diagnostic"
        assert operation["source"] == "manual"
        assert operation["blocking"] is True
        assert "de1" in operation["message"]
    finally:
        finish.set()
        worker.join(5)
        server.shutdown()
    assert results["resp"].status_code == 200
    assert server.service.routing.public_operation() is None


def test_route_check_precondition_is_not_reported_as_busy(running_server):
    base, svc = running_server
    svc.failover_loop = MagicMock()
    svc.failover_loop.check_current_route.side_effect = ValueError("xkeen is stopped")
    status, body = _post(base, "/api/route-check", {})
    assert status == 409
    assert body["code"] == "precondition"
    from xk_switcher.failover import FailoverBusyError
    svc.failover_loop.check_current_route.side_effect = FailoverBusyError("Another check or router operation is in progress")
    status, body = _post(base, "/api/route-check", {})
    assert status == 409
    assert body["code"] == "busy"
    assert "operation" in body

@pytest.mark.parametrize("path,method", [("/api/probe", "probe_codes"), ("/api/route-check", "check_current_route")])
def test_unexpected_diagnostic_error_is_unavailable_not_busy(running_server, path, method):
    client, service = running_server
    service.failover_loop = MagicMock()
    getattr(service.failover_loop, method).side_effect = RuntimeError("private transport failure")
    status, body = _post(client, path, {})
    assert status == 500
    assert body["code"] == "unavailable"
    assert "private transport failure" not in body["error"]

@pytest.mark.parametrize("path,body", [("/api/sub-url", {"url": "https://new.example"}), ("/api/failover/check-now", {})])
def test_other_coordinated_actions_keep_busy_envelope(running_server, path, body):
    client, service = running_server
    released, held = threading.Event(), threading.Event()
    worker = threading.Thread(target=_hold_coordinator, args=(service, released, held),
                              kwargs={"kind": "probe", "message": "Checking locations"})
    worker.start()
    try:
        assert held.wait(5)
        status, result = _post(client, path, body)
        assert status == 409
        assert result["code"] == "busy"
        assert result["operation"]["kind"] == "probe"
    finally:
        released.set()
        worker.join(5)

def test_status_completed_event_feed_survives_rotation_and_same_timestamp(running_server):
    client, service = running_server
    from xk_switcher.state import HISTORY_CAP
    for _ in range(HISTORY_CAP + 2):
        service.state.append_history({"ts": "2026-11-17T12:00:00Z", "action": "update", "result": "ok"})
    status, body = _get(client, "/api/status")
    assert status == 200
    assert len(body["events"]) == HISTORY_CAP + 2
    assert len({event["event_id"] for event in body["events"]}) == HISTORY_CAP + 2
    assert len(body["history"]) == 2
    assert _get(client, "/api/status")[1]["events"] == body["events"]

def test_synchronous_mutation_returns_only_its_own_event_ids(running_server):
    client, service = running_server
    service.state.append_history({"ts": "2026-11-17T12:00:00Z", "action": "xkeen", "result": "ok"})
    status, body = _post(client, "/api/xkeen", {"action": "stop"})
    assert status == 200
    events = service.state.read_events()
    assert body["event_ids"] == [events[-1]["event_id"]]
    assert events[0]["event_id"] not in body["event_ids"]

def test_build_server_requires_a_valid_manifest_before_listening(server_state, tmp_path, monkeypatch):
    from xk_switcher import web
    from xk_switcher.service import Service
    service = Service(server_state, Router("mock"))
    listener = MagicMock()
    monkeypatch.setattr(web, "ThreadingHTTPServer", listener)
    for contents in (None, "invalid"):
        if contents is not None:
            (tmp_path / "asset-manifest.json").write_text(contents)
        with pytest.raises(ValueError):
            web.build_server(service, ui_dist=tmp_path)
    listener.assert_not_called()

def test_checked_main_and_test_sites_share_route_check_admission(running_server, monkeypatch):
    from xk_switcher.routing import new_id
    client, service = running_server
    url = "/api/route-checks"
    check = service.route_checks
    query = url + "?kind=single"
    old_hash = client.get(query).json()["conditions"]["hash"]
    assert client.put("/api/connectivity", {"check_urls": ["https://updated.example/"]}).status_code == 200
    body = {"kind": "single", "codes": ["fi"], "conditions_hash": old_hash, "run_id": new_id()}
    response = client.post(url, body)
    assert (response.status_code, response.json()["code"]) == (409, "stale_conditions")
    body["conditions_hash"] = client.get(query).json()["conditions"]["hash"]
    entered, release = threading.Event(), threading.Event()

    def probe(*args):
        entered.set()
        assert release.wait(5)
        return {"outcome": "working", "rounds": [], "reason": None}

    monkeypatch.setattr(check, "_probe", probe)
    try:
        assert client.post(url, body).status_code == 202
        assert entered.wait(2)
        status = client.get("/api/status").json()
        assert status["route_checks"] is None and status["route_check_run"]["kind"] == "single"
        legacy = client.post(url, {"exit_code": "fi", "run_id": new_id()})
        assert (legacy.status_code, legacy.json()["error"]) == (409, "Location checks are already running")
        response = client.put("/api/connectivity", {"check_urls": ["https://blocked.example/"]})
        assert (response.status_code, response.json()["code"]) == (409, "busy")
        switch = {"operation_id": new_id(), "code": "fi", "route_check_id": body["run_id"]}
        response = client.post("/api/switch", switch)
        assert (response.status_code, response.json()["error"]) == (409, "Wait for route checks to finish.")
    finally:
        release.set()
    for _ in range(100):
        if client.get(query).json()["active_run"] is None:
            break
        time.sleep(.01)
    # Keep the durable operation at accepted while the next browser tries to start.
    monkeypatch.setattr(service.routing, "_launch", lambda ident: None)
    assert client.post("/api/switch", switch).status_code == 202
    response = client.post(url, {**body, "run_id": new_id()})
    assert (response.status_code, response.json()["error"]) == (409, "Main is switching. Wait for it to finish.")
    assert client.post("/api/switch", switch).json()["operation"]["id"] == switch["operation_id"]

def test_test_sites_save_tracks_live_workers_even_when_diagnostics_are_unreadable(running_server, monkeypatch):
    from pathlib import Path
    from xk_switcher.route_checks import CHECKS_FILE
    from xk_switcher.routing import new_id
    client, service = running_server
    checks = service.route_checks
    path = Path(service.state.data_dir) / CHECKS_FILE
    entered, release = threading.Event(), threading.Event()

    def hold_probe(*args):
        entered.set()
        assert release.wait(5)
        return {"outcome": "working", "rounds": [], "reason": None}

    monkeypatch.setattr(checks, "_probe", hold_probe)
    view = checks.start("fi", new_id())
    assert entered.wait(2)
    config = {"check_urls": ["https://independent.example/"]}
    try:
        with checks.admission_lock:
            saved = path.read_bytes()
            path.write_bytes(b"{")
        response = client.put("/api/connectivity", config)
        assert (response.status_code, response.json()["code"]) == (409, "busy")
    finally:
        path.write_bytes(saved)
        release.set()
        checks.cancel(view["run"]["id"])
    path.write_bytes(b"{")
    assert client.put("/api/connectivity", config).status_code == 200
    assert service.state.read_connectivity()["check_urls"] == config["check_urls"]
    assert path.read_bytes() == b"{"

def test_router_update_routes_require_auth_and_use_component_contract(running_server):
    client, service = running_server
    api = "/api/router-updates"
    anonymous = _Client(client.base_url)
    assert anonymous.get(api).status_code == 401
    assert anonymous.post(api + "/install", {}).status_code == 401
    assert client.post(api + "/install", {}, headers={"X-XK-Request": "0"}).status_code == 403
    view = {"components": {}, "available": []}
    updates = MagicMock()
    for op in ("status", "refresh", "configure", "schedule", "cancel", "start"):
        getattr(updates, op).return_value = view
    service.router_updates = updates
    assert client.get(api).json() == view
    updates.status.assert_called_once_with()
    assert client.post(api + "/check", {}).json() == view
    updates.refresh.assert_called_once_with()
    auto = {"xkeen": False, "xray": True, "time": "03:00"}
    assert client.put(api + "/auto", auto).json() == view
    updates.configure.assert_called_once_with(auto)
    pinned = {"component": "xray", "version": "26.11.9", "at": "2026-12-03T03:00:00+03:00"}
    assert client.put(api + "/schedule", pinned).json() == view
    updates.schedule.assert_called_once_with(pinned)
    assert client._req("DELETE", api + "/schedule", {"component": "xray"}).json() == view
    updates.cancel.assert_called_once_with("xray")
    for action in ("install", "rollback"):
        body = {"id": "44a914bc-97ad-49f2-a023-7c187a191854", "component": "xray", "version": "26.11.9"}
        response = client.post(api + "/" + action, body)
        assert (response.status_code, response.json()) == (202, view)
        updates.start.assert_called_with({**body, "action": action})
    assert client.post(api + "/install", {"action": "rollback"}).status_code == 400
