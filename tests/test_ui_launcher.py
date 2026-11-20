"""The browser fixture must never inherit a real router or data directory."""
from pathlib import Path
import pytest
from tests.ui_support.server import fixture_server

def test_launcher_ignores_environment_and_cleans_temp_data(monkeypatch):
    monkeypatch.setenv("ROUTER_HOST", "real-router.invalid")
    monkeypatch.setenv("DATA_DIR", "/must-not-write")
    with fixture_server() as instance:
        path = instance.service.state.data_dir
        assert path != Path("/must-not-write")
        assert instance.service.config.router_host == "mock"
        assert instance.server.server_address[0] == "127.0.0.1"
        assert instance.service.failover_loop is None
        assert instance.service.status()["available"][0]["code"] == "fi"
        assert instance.service.fetch_fn("https://anything.invalid")
    assert not path.exists()

def test_launcher_rejects_unbuilt_react(tmp_path):
    with pytest.raises(ValueError, match="compiled UI manifest"):
        with fixture_server(ui_dist=tmp_path):
            pass

def test_launcher_explicit_react_root(synthetic_ui_dist):
    from tests._helpers import _Client
    with fixture_server(ui_dist=synthetic_ui_dist) as instance:
        client = _Client(instance.url)
        assert client.get("/").text == (synthetic_ui_dist / "index.html").read_text()
        assert client.get("/styleguide.html").text == (synthetic_ui_dist / "catalog.html").read_text()
        assert client.get("/__ui-next__/").status_code == 404
        assert instance.service.config.router_host == "mock"
        assert instance.service.fetch_fn("ignored")
    assert not instance.service.state.data_dir.exists()

def test_launcher_real_http_auth_origin_and_synthetic_checks():
    from tests._helpers import _Client
    from tests.ui_support.server import PASSWORD
    with fixture_server() as instance:
        client = _Client(instance.url)
        assert client.get("/api/auth/session").json() == {"configured": False, "authenticated": False, "session_id": None}
        refused = client.post("/api/auth/setup", {"password": PASSWORD}, headers={"Origin": "http://foreign.invalid"})
        assert refused.status_code == 403
        response = client.post("/api/auth/setup", {"password": PASSWORD})
        assert response.status_code == 200
        assert "HttpOnly" in response.headers["Set-Cookie"]
        assert client.get("/api/status").json()["active_code"] == "fi"
        assert client.post("/api/probe", {"code": "fi"}).status_code == 200
        assert client.post("/api/route-check").status_code == 200
        assert client.post("/api/auth/logout").status_code == 200
        assert client.get("/api/status").status_code == 401

def test_serialized_status_fixture_matches_real_backend():
    import json
    with fixture_server() as instance:
        expected = json.loads(Path("frontend/tests/fixtures/status.json").read_text())
        assert instance.service.status() == expected

def test_fixture_transport_accepts_parallel_asset_burst(synthetic_ui_dist):
    from concurrent.futures import ThreadPoolExecutor
    from tests._helpers import _Client
    import json
    manifest = json.loads((synthetic_ui_dist / "asset-manifest.json").read_text())
    asset = next(url for url in manifest["assets"] if url.startswith("/ui-assets/"))
    with fixture_server(ui_dist=synthetic_ui_dist) as instance:
        assert instance.server.request_queue_size == 128
        with ThreadPoolExecutor(max_workers=24) as executor:
            responses = list(executor.map(lambda _: _Client(instance.url).get(asset).status_code, range(48)))
        assert responses == [200] * 48
