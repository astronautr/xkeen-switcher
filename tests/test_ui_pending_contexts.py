"""Distinct persisted pending owners share the existing browser status contract."""
import copy
from dataclasses import replace
from pathlib import Path
import uuid
from tests.test_ui_contracts import committed, http_fixture
from xk_switcher.subscription import parse_locations
from tests.ui_support.server import subscription_bytes


def test_main_fixed_and_combined_updates_share_public_pending_banner(http_fixture, monkeypatch):
    instance, client = http_fixture
    service = instance.service
    clock = "2026-11-17T09:00:00+00:00"
    monkeypatch.setattr("xk_switcher.service._now_iso", lambda: clock)
    # Establish verified Main and fixed-exit baselines through the same HTTP
    # operations used by the UI; the fixture router performs no external I/O.
    ident = str(uuid.uuid4())
    assert client.post("/api/switch", {"code": "fi", "operation_id": ident}).status_code == 202
    committed(client, ident)
    devices = client.get("/api/devices").json()
    device = next(row for row in devices["devices"] if row["registered"] and row["location"]["in_xkeen"])
    ident = str(uuid.uuid4())
    assigned = client.post("/api/devices/location", {"id": device["id"], "code": "de",
        "revision": device["revision"], "locations_revision": devices["locations"]["revision"], "operation_id": ident})
    assert assigned.status_code == 202, assigned.text
    committed(client, ident)
    original = parse_locations(subscription_bytes().decode())
    projections = []
    owners = []
    fields = ("active_code", "active_entry_code", "active_route", "pending_reapply_code",
        "pending_reapply_entry_code", "pending_reapply_since", "pending_update_kind", "auto_update")
    for changed_codes, expected_flags in [({"fi"}, (True, False)), ({"de"}, (False, True)), ({"fi", "de"}, (True, True))]:
        service._update_from_locations(original, trigger="manual")
        assert service.state.read_state()["pending_reapply_code"] is None
        changed = []
        for location in original:
            outbound = copy.deepcopy(location.outbound)
            if location.code in changed_codes:
                outbound["settings"]["vnext"][0]["address"] = location.code + ".changed.example.invalid"
            changed.append(replace(location, outbound=outbound))
        service._update_from_locations(changed, trigger="manual")
        internal = service.state.read_state()
        flags = (internal["pending_main_config"], internal["pending_device_configs"])
        assert flags == expected_flags
        owners.append(flags)
        response = client.get("/api/status")
        assert response.status_code == 200
        status = response.json()
        assert "pending_main_config" not in status
        assert "pending_device_configs" not in status
        assert status["pending_reapply_code"] == status["active_code"] == "fi"
        assert status["pending_reapply_entry_code"] is None
        assert status["pending_update_kind"] == "config"
        assert status["pending_reapply_since"] == clock
        projections.append({key: status[key] for key in fields})
    assert len(set(owners)) == 3
    assert projections[0] == projections[1] == projections[2]
    # Main and device updates use the same public projection in the browser.
    banner = (Path(__file__).resolve().parents[1] / "frontend/src/features/main/PendingConfig.tsx").read_text()
    assert "pending_main_config" not in banner and "pending_device_configs" not in banner
    assert "pending_reapply_code" in banner and "pending_update_kind" in banner
