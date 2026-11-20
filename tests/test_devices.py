"""Device inventory normalization, concurrency, reversible changes, and recovery."""
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
import pytest
from xk_switcher.devices import DevicesGateway
from xk_switcher.devices_service import DevicesService
from xk_switcher.keenetic import KeeneticError
from xk_switcher.router import Router
from xk_switcher.routing import RoutingError
from xk_switcher.service import Service
from xk_switcher.state import State

OLD = "02:00:00:00:00:21"
NEW = "02:00:00:00:00:45"

@pytest.fixture
def devices(tmp_path, monkeypatch):
    monkeypatch.setenv("ROUTER_HOST", "mock")
    state = State(tmp_path)
    state.init({})
    return Service(state, Router("mock")).devices

def device(service, mac=OLD):
    return next(item for item in service.snapshot()["devices"] if item["id"] == mac)

def change(service, values, mac=OLD, ident=None):
    item = device(service, mac)
    return service.change({"operation_id": ident or str(uuid.uuid4()), "changes": [
        {"id": mac, "revision": item["revision"], "values": values}]})

def test_inventory_has_unregistered_and_offline_and_configured_policies(devices):
    snapshot = devices.snapshot()
    assert len(snapshot["devices"]) == 11
    assert device(devices)["policy"] == "policy:Policy0"
    assert device(devices, NEW)["registered"] is False
    assert device(devices, NEW)["policy"] == "segment"
    assert device(devices)["online"] is False
    mock = devices.gateway
    mock.data["hosts"] = [host for host in mock.data["hosts"] if host["mac"] != OLD]
    assert device(devices)["name"] == "MacBookPro"
    assert device(devices)["online"] is False

def test_favorites_persist_without_router_io_or_revision_changes(devices):
    before = devices.snapshot()
    assert not any(item["favorite"] for item in before["devices"])
    with patch.object(devices.gateway, "rci", side_effect=AssertionError("Favorites must not contact the router")):
        for _ in range(2):
            assert devices.set_favorite({"id": OLD, "favorite": True}) == {"favorites": [OLD]}
        devices.set_favorite({"id": NEW, "favorite": True})
    restarted = DevicesService(devices.service)
    assert device(restarted)["favorite"]
    assert device(restarted, NEW)["favorite"]
    assert device(restarted)["revision"] == next(item for item in before["devices"] if item["id"] == OLD)["revision"]
    assert restarted.snapshot()["operations"] == []
    restarted.set_favorite({"id": OLD, "favorite": False})
    assert not device(devices)["favorite"]
    assert device(devices, NEW)["favorite"]

def test_favorites_follow_mac_through_rename_unregister_undo_and_absence(devices):
    devices.set_favorite({"id": OLD, "favorite": True})
    renamed = change(devices, {"name": "Work laptop"})
    assert device(devices)["favorite"]
    unregistered = change(devices, {"registered": False})
    assert device(devices)["favorite"]
    devices.undo(unregistered["operation"]["id"])
    devices.undo(renamed["operation"]["id"])
    assert device(devices)["favorite"]
    devices.set_favorite({"id": NEW, "favorite": True})
    host = next(host for host in devices.gateway.data["hosts"] if host["mac"] == NEW)
    devices.gateway.data["hosts"].remove(host)
    assert all(item["id"] != NEW for item in devices.snapshot()["devices"])
    devices.gateway.data["hosts"].append(host)
    assert device(devices, NEW)["favorite"]

def test_concurrent_favorites_keep_both_devices(devices):
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda mac: devices.set_favorite({"id": mac, "favorite": True}), (OLD, NEW)))
    assert {item["id"] for item in devices.snapshot()["devices"] if item["favorite"]} == {OLD, NEW}

@pytest.mark.parametrize("body", [
    {}, {"id": OLD}, {"id": OLD, "favorite": "true"}, {"id": OLD, "favorite": 1},
    {"id": OLD, "favorite": None}, {"id": [], "favorite": True},
    {"id": "invalid", "favorite": True}, {"id": OLD, "favorite": True, "name": "Laptop"},
])
def test_favorites_validate_request(devices, body):
    with pytest.raises(KeeneticError) as error:
        devices.set_favorite(body)
    assert error.value.status == 400
    assert not devices.favorites_path.exists()

@pytest.mark.parametrize("content", ["{", "{}", '["bad-mac"]', "[null]"])
def test_corrupt_favorites_are_not_overwritten(devices, content):
    devices.favorites_path.parent.mkdir(parents=True)
    devices.favorites_path.write_text(content)
    with pytest.raises(KeeneticError, match="favorites cannot be read"):
        devices.set_favorite({"id": OLD, "favorite": True})
    assert devices.favorites_path.read_text() == content

def test_favorite_write_failure_preserves_previous_selection(devices):
    devices.set_favorite({"id": OLD, "favorite": True})
    with patch("xk_switcher.devices_service.atomic", side_effect=OSError("disk full")):
        with pytest.raises(KeeneticError, match="favorites cannot be saved"):
            devices.set_favorite({"id": OLD, "favorite": False})
    assert device(devices)["favorite"]

@pytest.mark.parametrize("policy", ["default", "segment", "deny", "policy:Policy0"])
def test_policy_roundtrip_and_undo_preserve_other_settings(devices, policy):
    original = devices.gateway.data["settings"][OLD]
    original.update({"schedule": "Work hours", "priority": 3})
    change(devices, {"policy": "deny" if policy == "policy:Policy0" else "policy:Policy0"})
    before = device(devices)["policy"]
    result = change(devices, {"policy": policy})
    assert device(devices)["policy"] == policy
    assert devices.gateway.data["settings"][OLD]["schedule"] == "Work hours"
    result = devices.undo(result["operation"]["id"])
    assert device(devices)["policy"] == before
    assert devices.gateway.data["settings"][OLD]["priority"] == 3
    assert result["operations"][0]["phase"] == "undone"

@pytest.mark.parametrize("name", ["", " ", "a" * 65, "bad\nname", "iPhone", "  IPHONE  "])
def test_invalid_and_duplicate_names_do_not_mutate(devices, name):
    before = devices.gateway.snapshot()
    with pytest.raises(KeeneticError):
        change(devices, {"name": name})
    assert devices.gateway.snapshot() == before
    assert devices._read() == []

def test_registration_with_conflicting_rename_is_one_undoable_operation(devices):
    request = {"operation_id": str(uuid.uuid4()), "changes": [
        {"id": OLD, "revision": device(devices)["revision"], "values": {"name": "MacBookPro-old"}},
        {"id": NEW, "revision": device(devices, NEW)["revision"], "values": {"name": "MacBookPro", "registered": True, "policy": "policy:Policy0"}},
    ]}
    result = devices.change(request)
    assert device(devices, NEW)["policy"] == "policy:Policy0"
    assert device(devices)["name"] == "MacBookPro-old"
    assert devices.change(request)["operation"]["id"] == result["operation"]["id"]
    assert len(devices.service.state.read_history()) == 1
    restarted = DevicesService(devices.service)
    restarted.undo(result["operation"]["id"])
    assert device(restarted)["name"] == "MacBookPro"
    assert not device(restarted, NEW)["registered"]

def test_name_undo_keeps_a_later_policy_change(devices):
    rename = change(devices, {"name": "Work laptop"})
    change(devices, {"policy": "segment"})
    devices.undo(rename["operation"]["id"])
    assert device(devices)["name"] == "MacBookPro"
    assert device(devices)["policy"] == "segment"

def test_undo_will_not_overwrite_a_later_name_or_duplicate_name(devices):
    first = change(devices, {"name": "First"})
    change(devices, {"name": "Second"})
    with pytest.raises(KeeneticError, match="changed again"):
        devices.undo(first["operation"]["id"])
    assert device(devices)["name"] == "Second"
    second = change(devices, {"name": "Third"})
    change(devices, {"name": "Second", "registered": True, "policy": "segment"}, NEW)
    with pytest.raises(KeeneticError, match="already registered"):
        devices.undo(second["operation"]["id"])

def test_unregister_undo_restores_name_policy_and_host_options(devices):
    devices.gateway.data["settings"][OLD].update({"schedule": "Work", "priority": 3})
    before = devices.gateway.snapshot()["records"][OLD]
    result = change(devices, {"registered": False})
    assert not device(devices)["registered"]
    assert device(devices)["policy"] == "segment"
    devices.undo(result["operation"]["id"])
    assert devices.gateway.snapshot()["records"][OLD] == before
    devices.undo(result["operation"]["id"])
    assert device(devices)["name"] == "MacBookPro"

def test_parallel_changes_with_same_revision_only_one_wins(devices):
    before = device(devices)
    def attempt(name):
        try:
            devices.change({"operation_id": str(uuid.uuid4()), "changes": [
                {"id": OLD, "revision": before["revision"], "values": {"name": name}}]})
            return "ok"
        except (KeeneticError, RoutingError) as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert set(pool.map(attempt, ["First", "Second"])) == {"ok", 409}

def test_partial_failure_rolls_back_only_changed_fields(devices):
    original_write = devices.gateway.write
    def fail_second(mac, before, after, fields):
        if mac == NEW and after["registered"]:
            raise KeeneticError("rejected")
        return original_write(mac, before, after, fields)
    before = devices.gateway.snapshot()
    with patch.object(devices.gateway, "write", side_effect=fail_second):
        with pytest.raises(KeeneticError, match="previous settings were restored"):
            devices.change({"operation_id": str(uuid.uuid4()), "changes": [
                {"id": OLD, "revision": device(devices)["revision"], "values": {"name": "MacBookPro-old"}},
                {"id": NEW, "revision": device(devices, NEW)["revision"], "values": {"registered": True, "name": "MacBookPro", "policy": "segment"}},
            ]})
    assert devices.gateway.snapshot() == before
    assert devices._read()[0]["phase"] == "rolled_back"

def test_failed_save_retains_recoverable_journal_and_blocks_other_writes(devices):
    with patch.object(devices.gateway, "save", side_effect=KeeneticError("offline")):
        with pytest.raises(KeeneticError, match="interrupted"):
            change(devices, {"policy": "deny"})
    pending = devices.snapshot()["operations"][0]
    assert pending["phase"] == "uncertain"
    assert pending["undoable"]
    with pytest.raises(KeeneticError, match="interrupted"):
        change(devices, {"name": "Another"})
    restarted = DevicesService(devices.service)
    restarted.undo(pending["id"])
    assert device(restarted)["policy"] == "policy:Policy0"
    assert restarted.snapshot()["operations"][0]["phase"] == "undone"

@pytest.mark.parametrize("content", ["broken", "{}", '[{"id": null}]', '[{"id": "invalid"}]'])
def test_corrupt_history_fails_closed(devices, content):
    devices.path.parent.mkdir(parents=True)
    devices.path.write_text(content)
    with pytest.raises(KeeneticError, match="cannot be read"):
        devices.snapshot()

def test_interrupted_undo_can_be_retried_after_restart(devices):
    result = change(devices, {"registered": False})
    with patch.object(devices.gateway, "save", side_effect=KeeneticError("offline")):
        with pytest.raises(KeeneticError):
            devices.undo(result["operation"]["id"])
    assert devices.snapshot()["operations"][0]["phase"] == "undoing"
    restarted = DevicesService(devices.service)
    restarted.undo(result["operation"]["id"])
    assert device(restarted)["name"] == "MacBookPro"
    assert device(restarted)["policy"] == "policy:Policy0"

def test_undo_checks_restored_host_options_and_can_recover(devices):
    devices.gateway.data["settings"][OLD]["schedule"] = "Work"
    result = change(devices, {"registered": False})
    original = devices.gateway.write
    def omit_schedule(mac, before, after, fields):
        original(mac, before, after, fields)
        devices.gateway.data["settings"][mac].pop("schedule", None)
    with patch.object(devices.gateway, "write", side_effect=omit_schedule):
        with pytest.raises(KeeneticError, match="host options"):
            devices.undo(result["operation"]["id"])
    assert devices.snapshot()["operations"][0]["phase"] == "undoing"
    devices.undo(result["operation"]["id"])
    assert devices.gateway.data["settings"][OLD]["schedule"] == "Work"

def test_recovery_does_not_overwrite_unrelated_host_changes(devices):
    result = change(devices, {"registered": False})
    with patch.object(devices.gateway, "save", side_effect=KeeneticError("offline")):
        with pytest.raises(KeeneticError):
            devices.undo(result["operation"]["id"])
    devices.gateway.data["settings"][OLD]["schedule"] = "External change"
    with pytest.raises(KeeneticError, match="Other device settings changed"):
        devices.undo(result["operation"]["id"])
    assert devices.gateway.data["settings"][OLD]["schedule"] == "External change"

def test_deleted_policy_is_displayed_but_cannot_be_assigned_or_restored(devices):
    result = change(devices, {"policy": "segment"})
    devices.gateway.data["policies"] = {}
    unavailable = next(option for option in devices.snapshot()["policies"] if option["value"] == "policy:Policy0")
    assert unavailable["disabled"]
    with pytest.raises(KeeneticError, match="Policy not found"):
        change(devices, {"policy": "policy:Policy0"})
    with pytest.raises(KeeneticError, match="previous policy no longer exists"):
        devices.undo(result["operation"]["id"])
    assert device(devices)["policy"] == "segment"

@pytest.mark.parametrize("values", [{"registered": "yes"}, {"policy": "shell"}, {"name": []}, {"arbitrary": "command"}])
def test_mutation_schema_is_restricted(devices, values):
    with pytest.raises(KeeneticError):
        change(devices, values)

def test_ip_pin_uses_dhcp_api_and_unpin_is_durable_and_undoable(devices):
    before = devices.gateway.snapshot()["records"][OLD]
    before_revision = device(devices)["revision"]
    with patch.object(devices.gateway, "rci", wraps=devices.gateway.rci) as rci:
        pinned = change(devices, {"ip_pinned": True})
        writes = [(call.args[0], call.args[1]) for call in rci.call_args_list if len(call.args) == 2]
    assert writes == [("ip/dhcp/host", {"mac": OLD, "ip": before["ip"]}), ("system/configuration/save", {})]
    assert device(devices)["ip_pinned"]
    assert device(devices)["reserved_ip"] == before["ip"]
    assert device(devices)["revision"] != before_revision
    assert "pinned" in pinned["operation"]["message"]
    restarted = DevicesService(devices.service)
    with patch.object(restarted.gateway, "rci", wraps=restarted.gateway.rci) as rci:
        unpinned = change(restarted, {"ip_pinned": False})
        writes = [(call.args[0], call.args[1]) for call in rci.call_args_list if len(call.args) == 2]
    assert writes == [("ip/dhcp/host", {"mac": OLD, "no": True}), ("system/configuration/save", {})]
    assert not device(restarted)["ip_pinned"]
    restarted.undo(unpinned["operation"]["id"])
    assert device(restarted)["reserved_ip"] == before["ip"]
    restarted.undo(pinned["operation"]["id"])
    assert restarted.gateway.snapshot()["records"][OLD] == before

def test_ip_pin_retry_does_not_write_twice_or_retarget_a_reservation(devices):
    request = {"operation_id": str(uuid.uuid4()), "changes": [
        {"id": OLD, "revision": device(devices)["revision"], "values": {"ip_pinned": True}}]}
    devices.change(request)
    with patch.object(devices.gateway, "write", side_effect=AssertionError("Must not repeat writes")):
        devices.change(request)
        host = next(host for host in devices.gateway.data["hosts"] if host["mac"] == OLD)
        host["ip"] = "192.168.2.199"
        change(devices, {"ip_pinned": True})
    assert device(devices)["ip"] == "192.168.2.199"
    assert device(devices)["reserved_ip"] == "192.168.2.21"

@pytest.mark.parametrize("ip", ["", "0.0.0.0", "::1", "2001:db8::1", "127.0.0.1", "224.0.0.1", "255.255.255.255", "bad"])
def test_no_usable_ipv4_cannot_be_pinned(devices, ip):
    next(host for host in devices.gateway.data["hosts"] if host["mac"] == OLD)["ip"] = ip
    assert not device(devices)["can_pin_ip"]
    with pytest.raises(KeeneticError, match="no IPv4"):
        change(devices, {"ip_pinned": True})
    assert devices._read() == []

@pytest.mark.parametrize("value", ["true", 1, None, {}, []])
def test_ip_pin_requires_boolean(devices, value):
    with pytest.raises(KeeneticError) as error:
        change(devices, {"ip_pinned": value})
    assert error.value.status == 400
    assert devices._read() == []

def test_ip_pin_requires_registration_but_unregistered_reservation_can_be_removed(devices):
    assert not device(devices, NEW)["can_pin_ip"]
    with pytest.raises(KeeneticError, match="Register this device"):
        change(devices, {"ip_pinned": True}, NEW)
    devices.gateway.data["reservations"] = {NEW: "192.168.2.45"}
    devices.gateway.data["hosts"] = [host for host in devices.gateway.data["hosts"] if host["mac"] != NEW]
    assert device(devices, NEW)["ip_pinned"]
    assert device(devices, NEW)["ip"] == ""
    result = change(devices, {"ip_pinned": False}, NEW)
    assert "unpinned" in result["operation"]["message"]
    assert "registered" not in result["operation"]["message"]
    assert all(item["id"] != NEW for item in result["devices"])
    devices.undo(result["operation"]["id"])
    assert device(devices, NEW)["reserved_ip"] == "192.168.2.45"

@pytest.mark.parametrize("external_change", ["ip", "reservation"])
def test_ip_pin_rejects_stale_address_or_reservation_before_any_write(devices, external_change):
    old_revision = device(devices)["revision"]
    if external_change == "ip":
        next(host for host in devices.gateway.data["hosts"] if host["mac"] == OLD)["ip"] = "192.168.2.199"
    else:
        devices.gateway.data["reservations"] = {OLD: "192.168.2.200"}
    with patch.object(devices.gateway, "write", side_effect=AssertionError("Stale request must not write")):
        with pytest.raises(KeeneticError) as error:
            devices.change({"operation_id": str(uuid.uuid4()), "changes": [
                {"id": OLD, "revision": old_revision, "values": {"ip_pinned": True}}]})
    assert error.value.status == 409

def test_ip_pin_and_undo_reject_address_reserved_for_another_mac(devices):
    devices.gateway.data["reservations"] = {NEW: device(devices)["ip"]}
    with pytest.raises(KeeneticError, match="already used or pinned"):
        change(devices, {"ip_pinned": True})
    assert devices._read() == []
    devices.gateway.data["reservations"] = {OLD: device(devices)["ip"]}
    unpin = change(devices, {"ip_pinned": False})
    devices.gateway.data["reservations"][NEW] = device(devices)["ip"]
    with pytest.raises(KeeneticError, match="already used or pinned"):
        devices.undo(unpin["operation"]["id"])
    assert not device(devices)["ip_pinned"]

def test_pin_undo_preserves_newer_name_and_policy_and_cannot_overwrite_newer_ip(devices):
    pinned = change(devices, {"ip_pinned": True})
    change(devices, {"name": "Work laptop", "policy": "deny"})
    devices.undo(pinned["operation"]["id"])
    assert device(devices)["name"] == "Work laptop"
    assert device(devices)["policy"] == "deny"
    pinned = change(devices, {"ip_pinned": True})
    devices.gateway.data["reservations"][OLD] = "192.168.2.199"
    with pytest.raises(KeeneticError, match="changed again"):
        devices.undo(pinned["operation"]["id"])
    assert device(devices)["reserved_ip"] == "192.168.2.199"

def test_unregister_keeps_ip_reservation_and_old_journals_do_not_touch_later_pins(devices):
    renamed = change(devices, {"name": "Work laptop"})
    journal = json.loads(devices.path.read_bytes())
    for record in (journal[0]["changes"][0]["before"], journal[0]["changes"][0]["after"]):
        record.pop("reserved_ip")
        record.pop("ip")
    devices.path.write_text(json.dumps(journal))
    change(devices, {"ip_pinned": True})
    unregistered = change(devices, {"registered": False})
    assert device(devices)["ip_pinned"]
    devices.undo(unregistered["operation"]["id"])
    devices.undo(renamed["operation"]["id"])
    assert device(devices)["name"] == "MacBookPro"
    assert device(devices)["ip_pinned"]

@pytest.mark.parametrize("failure", ["ignored", "ambiguous", "save"])
def test_failed_ip_pin_restores_previous_reservation(devices, failure):
    write = devices.gateway.write
    def fail(mac, before, after, fields):
        if after["reserved_ip"]:
            if failure != "ignored":
                write(mac, before, after, fields)
            if failure == "ambiguous":
                raise KeeneticError("Response lost")
        else:
            write(mac, before, after, fields)
    with patch.object(devices.gateway, "write", side_effect=fail):
        with patch.object(devices.gateway, "save", side_effect=[KeeneticError("Save failed"), None] if failure == "save" else None):
            with pytest.raises(KeeneticError, match="previous settings were restored"):
                change(devices, {"ip_pinned": True})
    assert not device(devices)["ip_pinned"]
    assert devices._read()[0]["phase"] == "rolled_back"

@pytest.mark.parametrize("as_mapping", [False, True])
def test_dhcp_inventory_reads_saved_reservation_independently_of_runtime(devices, as_mapping):
    rci = devices.gateway.rci
    reservation = {"mac": OLD.upper(), "ip": "192.168.2.200"}
    def read(path):
        if path == "ip/dhcp/host":
            return {"0": reservation} if as_mapping else [reservation]
        return rci(path)
    snapshot = DevicesGateway(Mock(configured=True, rci=read)).snapshot()
    row = next(row for row in snapshot["devices"] if row["id"] == OLD)
    assert row["ip_pinned"]
    assert row["reserved_ip"] == "192.168.2.200"
    assert row["ip"] == "192.168.2.21"

def test_pin_undo_keeps_later_unregistration(devices):
    pinned = change(devices, {"ip_pinned": True})
    change(devices, {"registered": False})
    devices.undo(pinned["operation"]["id"])
    assert not device(devices)["registered"]
    assert not device(devices)["ip_pinned"]

def test_register_and_pin_in_one_operation_can_be_undone(devices):
    result = change(devices, {"registered": True, "name": "New laptop", "ip_pinned": True}, NEW)
    assert device(devices, NEW)["ip_pinned"]
    devices.undo(result["operation"]["id"])
    assert not device(devices, NEW)["registered"]
    assert not device(devices, NEW)["ip_pinned"]

def test_failed_unpin_recovers_original_reservation_after_restart(devices):
    change(devices, {"ip_pinned": True})
    with patch.object(devices.gateway, "save", side_effect=KeeneticError("Offline")):
        with pytest.raises(KeeneticError, match="interrupted"):
            change(devices, {"ip_pinned": False})
    restarted = DevicesService(devices.service)
    interrupted = restarted.snapshot()["operations"][0]
    assert interrupted["phase"] == "uncertain"
    restarted.undo(interrupted["id"])
    assert device(restarted)["reserved_ip"] == "192.168.2.21"

@pytest.mark.parametrize("dhcp", [None, "unsupported", {"unexpected": True}, [{"mac": OLD}],
    [{"mac": OLD, "ip": "bad"}], [{"mac": "bad", "ip": "192.168.2.21"}],
    [{"mac": OLD, "ip": "192.168.2.21"}, {"mac": OLD, "ip": "192.168.2.22"}]])
def test_unsupported_dhcp_inventory_cannot_silently_appear_unpinned(devices, dhcp):
    rci = devices.gateway.rci
    with patch.object(devices.gateway, "rci", side_effect=lambda path: dhcp if path == "ip/dhcp/host" else rci(path)):
        with pytest.raises(KeeneticError):
            change(devices, {"ip_pinned": True})
    assert devices._read() == []
