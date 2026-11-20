"""Real HTTP acceptance for the isolated UI fixture, with no API interception."""
import copy
import hashlib
import ipaddress
import socket
import subprocess
import time
import uuid
import pytest
from tests._helpers import _Client
from tests.ui_support.server import PASSWORD, fixture_server

@pytest.fixture
def http_fixture(monkeypatch):
    # Fail before DNS or subprocess I/O if a fixture accidentally reaches outside
    # the local test server. Mock router/probe/fetch seams still exercise Service.
    resolve = socket.getaddrinfo
    def local_only(host, *args, **kwargs):
        assert ipaddress.ip_address(host).is_loopback, "External DNS/network in UI fixture"
        return resolve(host, *args, **kwargs)
    def no_process(*args, **kwargs):
        pytest.fail("UI fixture attempted to execute an external process")
    monkeypatch.setattr(socket, "getaddrinfo", local_only)
    monkeypatch.setattr(subprocess, "Popen", no_process)
    with fixture_server(configured=True) as instance:
        client = _Client(instance.url)
        assert client.post("/api/auth/login", {"password": PASSWORD}).status_code == 200
        yield instance, client

def committed(client, ident):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get("/api/routing/operations/" + ident)
        assert response.status_code == 200, response.text
        operation = response.json()
        if operation["phase"] in {"committed", "rolled_back", "rejected"}:
            assert operation["phase"] == "committed", operation
            return operation
        time.sleep(.01)
    pytest.fail("Fixture operation did not reach a verified terminal state")

@pytest.mark.parametrize("entry", [None, "se"])
def test_main_intent_journal_survives_new_http_client_and_reuses_pair(http_fixture, entry):
    instance, client = http_fixture
    ident = str(uuid.uuid4())
    body = {"code": "de", "entry_code": entry, "operation_id": ident}
    accepted = client.post("/api/switch", body)
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["operation"]["id"] == ident
    committed(client, ident)
    # A reloaded page starts with no in-memory controller but the same cookie.
    reloaded = _Client(instance.url)
    for cookie in client.cookies:
        reloaded.cookies.set_cookie(copy.copy(cookie))
    operation = reloaded.get("/api/routing/operations/" + ident).json()
    assert operation["phase"] == "committed"
    status = reloaded.get("/api/status").json()
    assert (status["active_code"], status["active_entry_code"]) == ("de", entry)
    assert status["active_route"]["mode"] == ("chain" if entry else "single")
    replay = reloaded.post("/api/switch", body)
    assert replay.status_code == 202
    assert replay.json()["operation"]["id"] == ident
    different = reloaded.post("/api/switch", {**body, "entry_code": "fi"})
    assert different.status_code == 409
    assert reloaded.get("/api/status").json()["active_entry_code"] == entry
    assert len(instance.service.routing.store.operations()) == 1

def test_device_revision_refusal_preserves_newer_name_and_durable_undo(http_fixture):
    _, client = http_fixture
    before = client.get("/api/devices").json()
    device = next(row for row in before["devices"] if row["registered"])
    ident = str(uuid.uuid4())
    response = client.post("/api/devices/change", {"operation_id": ident, "changes": [{
        "id": device["id"], "revision": device["revision"], "values": {"name": "Synthetic tablet"},
    }]})
    assert response.status_code == 200, response.text
    assert response.json()["operation"]["undoable"] is True
    changed = next(row for row in response.json()["devices"] if row["id"] == device["id"])
    assert changed["name"] == "Synthetic tablet"
    assert changed["revision"] != device["revision"]
    refused = client.post("/api/devices/change", {"operation_id": str(uuid.uuid4()), "changes": [{
        "id": device["id"], "revision": device["revision"], "values": {"name": "Stale overwrite"},
    }]})
    assert refused.status_code == 409
    actual = client.get("/api/devices").json()
    assert next(row for row in actual["devices"] if row["id"] == device["id"])["name"] == "Synthetic tablet"
    undone = client.post("/api/devices/undo", {"operation_id": ident})
    assert undone.status_code == 200
    assert next(row for row in undone.json()["devices"] if row["id"] == device["id"])["name"] == device["name"]

def test_routing_preview_apply_download_and_restore_preserve_original_bytes(http_fixture):
    instance, client = http_fixture
    original = instance.service.router.read_routing().replace(b"\n", b"\r\n")
    assert b"//" in original and b"\r\n" in original
    instance.service.router._mock_routing = original
    initial = client.get("/api/routing").json()
    assert initial["current"]["sha256"] == hashlib.sha256(original).hexdigest()
    model = copy.deepcopy(initial["model"])
    default = model["groups"][-1]
    default["action"] = "direct" if default["action"] != "direct" else "proxy"
    saved = client.put("/api/routing/draft", {"model": model,
        "base_hash": initial["current"]["sha256"], "expected_revision": None})
    assert saved.status_code == 200, saved.text
    draft = saved.json()
    stale = client.put("/api/routing/draft", {"model": initial["model"],
        "base_hash": initial["current"]["sha256"], "expected_revision": None})
    assert stale.status_code == 409
    review = client.post("/api/routing/preview", {"intent": "apply",
        "expected_current_hash": initial["current"]["sha256"], "draft_revision": draft["revision"]})
    assert review.status_code == 200, review.text
    preview = review.json()
    assert preview["validated"] is True and preview["changes"]
    assert instance.service.router.read_routing() == original  # Preview must never apply.
    ident = str(uuid.uuid4())
    applied = client.post("/api/routing/apply", {"preview_id": preview["id"], "operation_id": ident})
    assert applied.status_code == 202 and applied.json()["id"] == ident
    committed(client, ident)
    current = client.get("/api/routing").json()
    assert current["model"]["groups"][-1]["action"] == default["action"]
    history = client.get("/api/routing/history").json()
    snapshot = next(item for item in history["snapshots"] if item["original"])
    download = client.get("/api/routing/history/" + snapshot["id"] + "/download")
    assert download.status_code == 200
    assert download._body == original
    assert int(download.headers["Content-Length"]) == len(original)
    assert download.headers["Content-Type"].startswith("application/octet-stream")
    assert "attachment" in download.headers["Content-Disposition"]
    restore = client.post("/api/routing/preview", {"intent": "restore",
        "expected_current_hash": current["current"]["sha256"], "snapshot_id": snapshot["id"]})
    assert restore.status_code == 200, restore.text
    restore_id = str(uuid.uuid4())
    accepted = client.post("/api/routing/apply", {"preview_id": restore.json()["id"], "operation_id": restore_id})
    assert accepted.status_code == 202
    committed(client, restore_id)
    assert instance.service.router.read_routing() == original

def server_context(mode):
    """Build each attribution fixture through the real authenticated HTTP API."""
    with fixture_server(configured=True) as instance:
        client = _Client(instance.url)
        assert client.post("/api/auth/login", {"password": PASSWORD}).status_code == 200
        if mode != "unknown":
            snapshot = client.get("/api/devices").json()
            device = next(row for row in snapshot["devices"] if row["location"]["in_xkeen"] and row["registered"])
            marked = client.post("/api/devices/server", {"revision": snapshot["locations"]["settings"]["revision"], "id": device["id"]})
            assert marked.status_code == 200, marked.text
            if mode == "outside":
                result = client.post("/api/devices/change", {"operation_id": str(uuid.uuid4()), "changes": [{
                    "id": device["id"], "revision": device["revision"], "values": {"policy": "default"},
                }]})
                assert result.status_code == 200, result.text
            elif mode == "fixed":
                assigned = client.post("/api/devices/location", {"id": device["id"], "code": "de",
                    "revision": device["revision"], "locations_revision": snapshot["locations"]["revision"],
                    "operation_id": str(uuid.uuid4())})
                assert assigned.status_code == 202, assigned.text
                committed(client, assigned.json()["operation"]["id"])
                client.get("/api/devices")
            checked = client.post("/api/route-check", {})
            assert checked.status_code == 200, checked.text
        context = client.get("/api/status").json()["server_route"]
        assert context["mode"] == mode
        return context

def normalize_context(context):
    context = copy.deepcopy(context)
    # Fingerprint is a SHA256 of revisions, not a user-visible identity.
    assert len(context["key"]) == 64
    context["key"] = "0" * 64
    if context["check"]:
        context["check"]["checked_at"] = "2026-11-17T09:00:00+00:00"
    return context

@pytest.mark.parametrize("mode", ["unknown", "main", "fixed", "outside"])
def test_server_attribution_browser_fixtures_match_real_http_serializer(mode):
    import json
    from pathlib import Path
    fixtures = json.loads(Path("frontend/tests/fixtures/main-contexts.json").read_text())
    assert normalize_context(server_context(mode)) == fixtures[mode]

def hysteria_location():
    from dataclasses import asdict
    import json
    from xk_switcher.subscription import parse_locations
    provider = [{"remarks": "Sweden 🇸🇪", "outbounds": [{"tag": "proxy", "protocol": "hysteria2",
        "settings": {"servers": [{"address": "se.example.invalid", "port": 443, "password": "synthetic-only"}]}}]}]
    location = asdict(parse_locations(json.dumps(provider))[0])
    with fixture_server(configured=True) as instance:
        instance.service.state.write_subscription({"locations": [location]})
        client = _Client(instance.url)
        assert client.post("/api/auth/login", {"password": PASSWORD}).status_code == 200
        return client.get("/api/status").json()["available"][0]

def test_hysteria_browser_location_matches_subscription_and_status_serializer():
    import json
    from pathlib import Path
    assert hysteria_location() == json.loads(Path("frontend/tests/fixtures/hysteria-location.json").read_text())

def test_g3_session_pairing_expiration_is_numeric_and_status_omits_secret(http_fixture):
    _, client = http_fixture
    session = client.get("/api/auth/session").json()
    assert set(session) == {"configured", "authenticated", "session_id"}
    assert session["authenticated"] is True
    invitation = client.post("/api/auth/pairing-code", {}).json()
    assert isinstance(invitation["expires_at"], (int, float))
    assert len(invitation["code"]) == 6
    current = client.get("/api/auth/pairing-code?id=" + invitation["id"]).json()
    assert current == {key: invitation[key] for key in ("id", "status", "expires_at")}

def test_g3_operation_optional_fields_and_unknown_phase_are_not_normalized(http_fixture):
    instance, client = http_fixture
    ident = str(uuid.uuid4())
    instance.service.routing.store.put_operation({"id": ident, "phase": "future_phase", "kind": "routing", "created_at": "2026-11-17T00:00:00Z"})
    public = client.get("/api/status").json()["operation"]
    assert public["id"] == ident and public["phase"] == "future_phase"
    assert public["blocking"] is True
    assert "updated_at" not in public and "target_code" not in public
    journal = client.get("/api/routing/operations/" + ident).json()
    assert journal["phase"] == "future_phase"
    assert "target_code" not in journal
    instance.service.routing.store.put_operation({"id": ident, "phase": "rejected", "kind": "routing", "created_at": "2026-11-17T00:00:00Z"})

def test_g3_unconfigured_devices_has_no_locations_or_updated_at(http_fixture):
    instance, client = http_fixture
    from types import SimpleNamespace
    instance.service.devices.gateway = SimpleNamespace(configured=False)
    devices = client.get("/api/devices").json()
    assert devices["configured"] is False
    assert set(devices) == {"configured", "devices", "policies", "operations", "error"}
    assert devices["devices"] == devices["policies"] == devices["operations"] == []

def test_g3_routing_history_omits_model_and_validation_uses_severity(http_fixture):
    _, client = http_fixture
    from xk_switcher.routing import validate
    current = client.get("/api/routing").json()
    history = client.get("/api/routing/history").json()
    assert history["snapshots"]
    assert "model" not in history["snapshots"][0]
    assert all(isinstance(history["snapshots"][0][key], bool) for key in ("current", "original", "protected"))
    model = copy.deepcopy(current["model"])
    model["groups"][0]["title"] = ""
    issue = next(item for item in validate(model) if item["message"] == "Enter a name")
    assert issue["severity"] == "error"
    assert issue["field"] is None
    assert "level" not in issue
