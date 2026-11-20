import re
import uuid
import pytest
from tests._helpers import TEST_PASSWORD, make_test_server, _Client
from xk_switcher.state import State

@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("ROUTER_HOST", "mock")
    state = State(tmp_path)
    state.init({})
    httpd, client = make_test_server(state)
    yield client, httpd.service
    httpd.shutdown()
    httpd.server_close()

def test_device_api_requires_session_and_mutation_headers(server):
    client, _ = server
    assert _Client(client.base_url).get("/api/devices").status_code == 401
    assert _Client(client.base_url).post("/api/devices/change", {}).status_code == 401
    assert client.post("/api/devices/undo", {}, headers={"X-XK-Request": ""}).status_code == 403
    assert client.post("/api/devices/change", {}, headers={"Origin": "http://foreign.invalid"}).status_code == 403

def test_change_and_undo_endpoints_and_activity(server):
    client, _ = server
    snapshot = client.get("/api/devices").json()
    device = next(item for item in snapshot["devices"] if item["name"] == "MacBookPro")
    ident = str(uuid.uuid4())
    result = client.post("/api/devices/change", {"operation_id": ident, "changes": [
        {"id": device["id"], "revision": device["revision"], "values": {"policy": "default"}}]})
    assert result.status_code == 200
    assert result.json()["operation"]["undoable"]
    activity = client.get("/api/status").json()["history"][-1]
    assert activity["device_operation"] == ident
    assert client.post("/api/devices/undo", {"operation_id": ident}).status_code == 200
    stale = client.post("/api/devices/change", {"operation_id": str(uuid.uuid4()), "changes": [
        {"id": device["id"], "revision": "stale", "values": {"policy": "deny"}}]})
    assert stale.status_code == 409

def test_favorite_endpoint_is_shared_and_requires_session_and_csrf(server):
    client, _ = server
    device = client.get("/api/devices").json()["devices"][0]
    body = {"id": device["id"], "favorite": True}
    assert _Client(client.base_url).post("/api/devices/favorite", body).status_code == 401
    assert client.post("/api/devices/favorite", body, headers={"X-XK-Request": ""}).status_code == 403
    assert client.post("/api/devices/favorite", body, headers={"Origin": "http://foreign.invalid"}).status_code == 403
    assert client.post("/api/devices/favorite", body, headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/api/devices/favorite", {**body, "favorite": "true"}).status_code == 400
    result = client.post("/api/devices/favorite", body)
    assert result.status_code == 200
    assert result.json() == {"favorites": [device["id"]]}
    other = _Client(client.base_url)
    assert other.post("/api/auth/login", {"password": TEST_PASSWORD}).status_code == 200
    snapshot = other.get("/api/devices").json()
    assert next(item for item in snapshot["devices"] if item["id"] == device["id"])["favorite"]
    assert other.post("/api/devices/favorite", {**body, "favorite": False}).json() == {"favorites": []}
    assert not any(item["favorite"] for item in client.get("/api/devices").json()["devices"])

def test_missing_configuration_does_not_break_main_status(server):
    client, service = server
    service.devices.gateway.configured  # The default mock is intentionally enabled.
    from xk_switcher.devices import DevicesGateway
    from xk_switcher.keenetic import KeeneticClient
    service.devices.gateway = DevicesGateway(KeeneticClient("http://router.invalid", "", ""))
    assert client.get("/api/status").status_code == 200
    assert client.get("/api/devices").json()["configured"] is False
    assert "PASSWORD" in client.get("/api/devices").json()["error"]

def test_static_device_assets_are_served(server):
    base, _ = server
    client = _Client(base.base_url)
    shell = client.get("/").text
    routes = re.findall(r'(?:src|href)="(/ui-assets/[^"]+)"', shell)
    content_types = {"js": "application/javascript; charset=utf-8", "css": "text/css; charset=utf-8"}
    assert {route.rsplit(".", 1)[1] for route in routes} == content_types.keys()
    for route in routes:
        assert re.fullmatch(r"/ui-assets/app\.[0-9a-f]{16,64}\.(css|js)", route)
        response = client.get(route)
        assert response.status_code == 200
        assert response.headers["Content-Type"] == content_types[route.rsplit(".", 1)[1]]
        assert response.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert client.get("/devices.js").status_code == 404
    assert client.get("/devices.css").status_code == 404

def test_device_routing_settings_are_authenticated_durable_and_revision_checked(server):
    client, service = server
    body = {"revision": None, "policy_ids": ["policy:Policy0"]}
    path = "/api/devices/routing-settings"
    assert _Client(client.base_url).put(path, body).status_code == 401
    assert client.put(path, body, headers={"X-XK-Request": ""}).status_code == 403
    assert client.put(path, body, headers={"Origin": "http://foreign.invalid"}).status_code == 403
    assert client.put(path, body, headers={"Content-Type": "text/plain"}).status_code == 415
    response = client.put(path, body)
    assert response.status_code == 200, response.text
    assert response.json()["locations"]["settings"]["source"] == "saved"
    assert not any(d["is_server"] for d in client.get("/api/devices").json()["devices"])
    assert client.put(path, body).status_code == 409

def test_server_mark_endpoint_requires_session_and_csrf_and_supports_unmark(server):
    client, _ = server
    path = "/api/devices/server"
    body = {"revision": None, "id": "02:00:00:00:00:10"}
    assert _Client(client.base_url).post(path, body).status_code == 401
    assert client.post(path, body, headers={"X-XK-Request": ""}).status_code == 403
    assert client.post(path, body, headers={"Origin": "http://foreign.invalid"}).status_code == 403
    assert client.post(path, body, headers={"Content-Type": "text/plain"}).status_code == 415
    response = client.post(path, body)
    assert response.status_code == 200
    assert next(d for d in response.json()["devices"] if d["is_server"])["id"] == body["id"]
    assert client.post(path, body).status_code == 409
    revision = response.json()["locations"]["settings"]["revision"]
    result = client.post(path, {"revision": revision, "id": None})
    assert result.status_code == 200 and not any(d["is_server"] for d in result.json()["devices"])

def test_ip_pin_unpin_and_undo_through_authenticated_change_api(server):
    client, _ = server
    item = next(item for item in client.get("/api/devices").json()["devices"] if item["name"] == "MacBookPro")
    for pinned in (True, False):
        ident = str(uuid.uuid4())
        response = client.post("/api/devices/change", {"operation_id": ident, "changes": [
            {"id": item["id"], "revision": item["revision"], "values": {"ip_pinned": pinned}}]})
        assert response.status_code == 200
        item = next(row for row in response.json()["devices"] if row["id"] == item["id"])
        assert item["ip_pinned"] is pinned
        assert item["reserved_ip"] == (item["ip"] if pinned else "")
    restored = client.post("/api/devices/undo", {"operation_id": ident})
    assert restored.status_code == 200
    assert next(row for row in restored.json()["devices"] if row["id"] == item["id"])["ip_pinned"]

def test_device_location_endpoint_requires_session_and_csrf_and_polls(server):
    import time
    from tests.test_service import _sample_loc, _seed_sub
    from tests.test_device_locations import body
    client, service = server
    _seed_sub(service.state, [_sample_loc("fi"), _sample_loc("tr")])
    service.state.write_state({"subscription_url": "https://sub.example"})
    service.switch("fi")
    request = body(service)
    assert _Client(client.base_url).post("/api/devices/location", request).status_code == 401
    assert client.post("/api/devices/location", request, headers={"X-XK-Request":""}).status_code == 403
    assert client.post("/api/devices/location", request, headers={"Origin":"http://foreign.invalid"}).status_code == 403
    assert client.post("/api/devices/location", {**request,"code":"missing"}).status_code == 409
    response = client.post("/api/devices/location", request)
    assert response.status_code == 202, response.text
    ident = response.json()["operation"]["id"]
    for _ in range(100):
        op = client.get("/api/routing/operations/" + ident).json()
        if op["phase"] == "committed": break
        time.sleep(.01)
    assert op["phase"] == "committed"
    snapshot = client.get("/api/devices").json()
    device = next(item for item in snapshot["devices"] if item["id"] == request["id"])
    assert device["location"]["code"] == "tr" and device["ip_pinned"]
    assert client.post("/api/devices/location", request).json()["operation"]["id"] == ident
