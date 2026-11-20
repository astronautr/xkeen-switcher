"""Browser DTO baselines compared with authenticated synthetic HTTP responses.

Only clocks and generated identities are alpha-renamed. The bijection is shared
across responses so dangling or inconsistent references cannot disappear.
"""
import copy
from datetime import datetime
import hashlib
import json
import ipaddress
import socket
import subprocess
from pathlib import Path
import re
import uuid
import pytest
from tests._helpers import _Client
from tests.ui_support.server import PASSWORD, fixture_server

FIXTURES = Path(__file__).resolve().parents[1] / "frontend/tests/fixtures"

def baseline(name):
    return json.loads((FIXTURES / (name + ".json")).read_text())

class DTOComparison:
    def __init__(self):
        self.identities = {}
        self.reverse = {}

    def identity(self, actual, expected):
        assert type(actual) is type(expected)
        assert self.identities.setdefault(actual, expected) == expected
        assert self.reverse.setdefault(expected, actual) == actual

    def compare(self, actual, expected, path="$"):
        assert type(actual) is type(expected), path
        if isinstance(expected, dict):
            assert actual.keys() == expected.keys(), path
            for key in expected:
                self.compare(actual[key], expected[key], path + "." + key)
        elif isinstance(expected, list):
            assert len(actual) == len(expected), path
            for index, (left, right) in enumerate(zip(actual, expected)):
                self.compare(left, right, f"{path}[{index}]")
        elif isinstance(expected, str):
            key = path.rsplit(".", 1)[-1]
            if key in {"created_at", "updated_at", "saved_at", "observed_at", "completed_at", "submitted_at", "at"} or ".phase_times." in path:
                assert datetime.fromisoformat(actual).tzinfo, path
                assert datetime.fromisoformat(expected).tzinfo, path
            elif re.fullmatch(r"[0-9a-f-]{36}", expected):
                assert uuid.UUID(actual).version == uuid.UUID(expected).version == 4, path
                self.identity(actual, expected)
            elif key == "revision" and re.fullmatch(r"[0-9a-f]{64}", expected):
                assert re.fullmatch(r"[0-9a-f]{64}", actual), path
                self.identity(actual, expected)
            elif path == "$.sessions[0].id":
                assert re.fullmatch(r"[0-9a-f]{32}", actual), path
                self.identity(actual, expected)
            elif path == "$.sessions[0].label":
                # Python HTTP client and Chromium have different user agents.
                assert actual == "Browser · device", path
            else:
                assert actual == expected, path
        else:
            assert actual == expected, path

@pytest.fixture
def backend(monkeypatch):
    resolve = socket.getaddrinfo
    def local_only(host, *args, **kwargs):
        assert ipaddress.ip_address(host).is_loopback, "External network in DTO fixture"
        return resolve(host, *args, **kwargs)
    def no_process(*args, **kwargs):
        pytest.fail("DTO fixture attempted external process I/O")
    monkeypatch.setattr(socket, "getaddrinfo", local_only)
    monkeypatch.setattr(subprocess, "Popen", no_process)
    with fixture_server(configured=True) as instance:
        client = _Client(instance.url)
        assert client.post("/api/auth/login", {"password": PASSWORD}).status_code == 200
        yield instance, client

def get(client, path):
    response = client.get(path)
    assert response.status_code == 200, response.text
    return response.json()

@pytest.mark.parametrize("name,path", [
    ("devices", "/api/devices"), ("sessions", "/api/auth/sessions"),
    ("failover", "/api/failover"), ("connectivity", "/api/connectivity"),
])
def test_browser_inventory_dtos_match_authenticated_http(backend, name, path):
    _, client = backend
    actual = get(client, path)
    if name == "sessions":
        assert actual["sessions"][0]["id"] == get(client, "/api/auth/session")["session_id"]
        assert actual["sessions"][0]["current"] is True
    DTOComparison().compare(actual, baseline(name))

def test_browser_routing_dtos_and_original_bytes_match_authenticated_http(backend):
    instance, client = backend
    # The routing scenario deliberately exercises commented CRLF source bytes.
    instance.service.router._mock_routing = (FIXTURES / "routing-original.jsonc").read_bytes()
    compare = DTOComparison()
    routing = get(client, "/api/routing")
    compare.compare(routing, baseline("routing"))
    history = get(client, "/api/routing/history")
    compare.compare(history, baseline("routing-history"))
    original = next(row for row in history["snapshots"] if row["original"])
    snapshot = get(client, "/api/routing/history/" + original["id"])
    compare.compare(snapshot, baseline("routing-snapshot"))
    download = client.get("/api/routing/history/" + original["id"] + "/download")
    assert download.status_code == 200
    assert download._body == (FIXTURES / "routing-original.jsonc").read_bytes()
    assert hashlib.sha256(download._body).hexdigest() == original["sha256"]
    assert len(download._body) == original["size"]
    model = copy.deepcopy(routing["model"])
    next(row for row in model["groups"] if row["title"] == "Analytics")["title"] = "Privacy analytics"
    model["groups"][-1]["action"] = "direct"
    saved = client.put("/api/routing/draft", {"model": model,
        "base_hash": routing["current"]["sha256"], "expected_revision": None})
    assert saved.status_code == 200, saved.text
    draft = saved.json()
    compare.compare(draft, baseline("routing-draft"))
    response = client.post("/api/routing/preview", {"intent": "apply",
        "expected_current_hash": routing["current"]["sha256"], "draft_revision": draft["revision"]})
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["base_snapshot"] == original["id"]
    assert preview["draft_revision"] == draft["revision"]
    compare.compare(preview, baseline("routing-preview"))

@pytest.mark.parametrize("entry", [None, "se"])
def test_main_operation_browser_dtos_match_accepted_journal_and_public_http(backend, monkeypatch, entry):
    instance, client = backend
    # Hold the worker before any preparation I/O, leaving a durable accepted
    # intent. This makes the response, subsequent journal GET and status public
    # view observable without racing background phase transitions.
    monkeypatch.setattr(instance.service.routing, "_launch", lambda ident: None)
    ident = str(uuid.uuid4())
    response = client.post("/api/switch", {"code": "de", "entry_code": entry, "operation_id": ident})
    assert response.status_code == 202, response.text
    accepted = response.json()
    assert accepted.keys() == {"operation"}
    operation = accepted["operation"]
    assert operation["id"] == ident
    assert get(client, "/api/routing/operations/" + ident) == operation
    public = get(client, "/api/status")["operation"]
    assert public["id"] == operation["id"]
    assert public["created_at"] == operation["created_at"]
    assert public["target_route"] == operation["target_route"]
    assert public["confirmed_route"] == operation["confirmed_route"]
    expected_operation = baseline("main-operation")
    expected_public = baseline("main-public-operation")
    if entry is None:
        for expected in (expected_operation, expected_public):
            expected["target_entry_code"] = None
            expected["target_route"].update(mode="single", entry_code=None, entry_name=None)
    compare = DTOComparison()
    compare.compare(operation, expected_operation)
    compare.compare(public, expected_public)

def routing_source(backend, *, original=True):
    instance, client = backend
    if original:
        instance.service.router._mock_routing = (FIXTURES / "routing-original.jsonc").read_bytes()
    return get(client, "/api/routing")

def save_and_preview(client, initial, model, *, expected_status=200):
    saved = client.put("/api/routing/draft", {"model": model,
        "base_hash": initial["current"]["sha256"], "expected_revision": None})
    assert saved.status_code == 200, saved.text
    draft = saved.json()
    response = client.post("/api/routing/preview", {"intent": "apply",
        "expected_current_hash": initial["current"]["sha256"], "draft_revision": draft["revision"]})
    assert response.status_code == expected_status, response.text
    return draft, response.json()

def test_routing_restore_context_matches_authenticated_http(backend):
    from tests.test_ui_contracts import committed
    _, client = backend
    initial = routing_source(backend)
    model = copy.deepcopy(initial["model"])
    model["groups"][-1]["action"] = "direct"
    _, preview = save_and_preview(client, initial, model)
    ident = str(uuid.uuid4())
    response = client.post("/api/routing/apply", {"preview_id": preview["id"], "operation_id": ident})
    assert response.status_code == 202, response.text
    committed(client, ident)
    current = get(client, "/api/routing")
    history = get(client, "/api/routing/history")
    snapshot = get(client, "/api/routing/history/" + initial["current"]["id"])
    response = client.post("/api/routing/preview", {"intent": "restore",
        "expected_current_hash": current["current"]["sha256"], "snapshot_id": snapshot["id"]})
    assert response.status_code == 200, response.text
    restore = response.json()
    assert restore["source_snapshot"] == snapshot["id"]
    assert restore["sha256"] == hashlib.sha256((FIXTURES / "routing-original.jsonc").read_bytes()).hexdigest()
    DTOComparison().compare({"routing": current, "history": history,
        "snapshot": snapshot, "preview": restore}, baseline("routing-restore-context"))

def test_routing_diff_context_matches_authenticated_http(backend):
    _, client = backend
    expected = baseline("routing-diff-context")
    initial = routing_source(backend)
    model = copy.deepcopy(initial["model"])
    groups = model["groups"]
    removed = groups.pop(1)
    groups[1], groups[2] = groups[2], groups[1]
    groups[0]["matchers"][0]["value"] = "80,443"
    groups[-1]["action"] = "direct"
    added = copy.deepcopy(removed)
    # This UUID is user input embedded in generated config comments. Reusing it
    # preserves the deterministic candidate SHA instead of normalizing a hash.
    fixture_added = next(row for row in expected["routing"]["draft"]["model"]["groups"] if row["title"] == "New safe domain")
    added.update(id=fixture_added["id"], title="New safe domain",
        matchers=[{"type": "domain-suffix", "value": "example.net"}])
    groups.insert(-1, added)
    draft, preview = save_and_preview(client, initial, model)
    initial["draft"] = draft
    DTOComparison().compare({"routing": initial, "preview": preview}, expected)

def test_device_unregister_undo_context_matches_authenticated_http(backend):
    _, client = backend
    initial = get(client, "/api/devices")
    device = next(row for row in initial["devices"] if row["id"] == "02:00:00:00:00:21")
    ident = str(uuid.uuid4())
    response = client.post("/api/devices/change", {"operation_id": ident, "changes": [{
        "id": device["id"], "revision": device["revision"], "values": {"registered": False}}]})
    assert response.status_code == 200, response.text
    changed = response.json()
    assert changed["operation"]["id"] == ident
    response = client.post("/api/devices/undo", {"operation_id": ident})
    assert response.status_code == 200, response.text
    DTOComparison().compare({"initial": initial, "changed": changed,
        "undone": response.json()}, baseline("devices-undo-context"))

def test_routing_validation_context_matches_authenticated_http(backend, monkeypatch):
    instance, client = backend
    initial = routing_source(backend, original=False)
    model = copy.deepcopy(initial["model"])
    model["groups"][0]["matchers"][0]["value"] = "not-a-port"
    draft, error = save_and_preview(client, initial, model, expected_status=422)
    initial["draft"] = draft
    DTOComparison().compare({"routing": initial, "error": error}, baseline("routing-invalid-context"))
    model["groups"][0]["matchers"][0]["value"] = "80"
    response = client.put("/api/routing/draft", {"model": model,
        "base_hash": initial["current"]["sha256"], "expected_revision": draft["revision"]})
    assert response.status_code == 200, response.text
    monkeypatch.setattr(instance.service.router, "routing_health", lambda: "unknown")
    response = client.post("/api/routing/preview", {"intent": "apply",
        "expected_current_hash": initial["current"]["sha256"], "draft_revision": response.json()["revision"]})
    assert response.status_code == 503
    assert response.json() == {"error": "Could not determine XKeen status. Try validation again when the connection is restored.", "code": "health", "validation": []}
