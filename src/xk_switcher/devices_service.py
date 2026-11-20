"""Validated device mutations, durable undo, and optimistic concurrency control."""
import json
import re
from copy import deepcopy
from datetime import datetime, timezone
from .devices import MAC_RE, DevicesGateway, name_key, policy_binding, policy_value, revision, usable_ipv4, validate_name
from .keenetic import KeeneticClient, KeeneticError
from .routing_store import atomic

OPERATION_LIMIT = 100
ID_RE = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
FIELDS = {"name", "registered", "policy", "ip_pinned"}
POLICY_FIELDS = {"mac", "access", "permit", "deny", "conform", "policy"}

def now():
    return datetime.now(timezone.utc).isoformat()

def empty_record():
    return {"name": "", "registered": False, "binding": policy_binding("default"), "hotspot": {}, "reserved_ip": "", "ip": ""}

def host_options(record):
    return {key: value for key, value in record["hotspot"].items() if key not in POLICY_FIELDS}

def matches(actual, expected, fields):
    if actual["registered"] != expected["registered"] and set(fields) != {"reserved_ip"}:
        return False
    return all(actual[key] == expected[key] for key in fields
               if key not in {"hotspot"} and (actual["registered"] or key not in {"name", "binding"}))

class DevicesService:
    def __init__(self, service, gateway=None):
        self.service = service
        cfg = service.config
        if gateway is None:
            if cfg.router_host == "mock":
                from .devices_mock import MockDevicesGateway
                gateway = MockDevicesGateway(service.state.data_dir)
            else:
                host = cfg.router_host
                if ":" in host and not host.startswith("["):
                    host = f"[{host}]"
                gateway = DevicesGateway(KeeneticClient(cfg.keenetic_url or f"http://{host}", cfg.keenetic_user, cfg.keenetic_password))
        self.gateway = gateway
        self.path = service.state.data_dir / "devices" / "operations.json"
        self.favorites_path = self.path.with_name("favorites.json")

    def _read_favorites(self):
        try:
            favorites = json.loads(self.favorites_path.read_bytes())
            if not isinstance(favorites, list) or any(not isinstance(mac, str) or not MAC_RE.fullmatch(mac) for mac in favorites):
                raise ValueError("Invalid favorites")
            return set(favorites)
        except FileNotFoundError:
            return set()
        except (ValueError, OSError) as error:
            raise KeeneticError("Device favorites cannot be read.", 503, "storage") from error

    def set_favorite(self, body):
        mac = body.get("id")
        favorite = body.get("favorite")
        if set(body) != {"id", "favorite"} or not isinstance(mac, str) or not MAC_RE.fullmatch(mac) or type(favorite) is not bool:
            raise KeeneticError("Provide a device MAC address and a favorite boolean.", 400, "invalid_request")
        with self.service._op_lock:
            favorites = self._read_favorites()
            if (mac in favorites) != favorite:
                if favorite:
                    favorites.add(mac)
                else:
                    favorites.discard(mac)
                try:
                    atomic(self.favorites_path, json.dumps(sorted(favorites)).encode())
                except OSError as error:
                    raise KeeneticError("Device favorites cannot be saved.", 503, "storage") from error
            return {"favorites": sorted(favorites)}

    def _read(self):
        try:
            doc = json.loads(self.path.read_bytes())
            if not isinstance(doc, list):
                raise ValueError("Invalid journal")
            for op in doc:
                if not isinstance(op, dict) or not ID_RE.fullmatch(op["id"]) or op["phase"] not in {"pending", "uncertain", "undoing", "committed", "undone", "rolled_back"}:
                    raise ValueError("Invalid operation")
                if not isinstance(op["message"], str) or not isinstance(op["at"], str) or not isinstance(op["changes"], list) or not op["changes"]:
                    raise ValueError("Invalid operation data")
                for change in op["changes"]:
                    if not MAC_RE.fullmatch(change["id"]) or not set(change["fields"]) <= {"name", "registered", "binding", "hotspot", "reserved_ip"}:
                        raise ValueError("Invalid change")
                    for record in (change["before"], change["after"]):
                        # Journals written before IP pinning remain undoable.
                        if "reserved_ip" not in change["fields"]:
                            record.setdefault("reserved_ip", "")
                        if not isinstance(record["reserved_ip"], str) or (record["reserved_ip"] and not usable_ipv4(record["reserved_ip"])):
                            raise ValueError("Invalid IP reservation")
                        if not isinstance(record["name"], str) or type(record["registered"]) is not bool or not isinstance(record["hotspot"], dict):
                            raise ValueError("Invalid device record")
                        if record["binding"]["access"] not in {"permit", "deny"} or type(record["binding"]["conform"]) is not bool or not isinstance(record["binding"]["policy"], str):
                            raise ValueError("Invalid policy record")
            return doc
        except FileNotFoundError:
            return []
        except (ValueError, TypeError, KeyError, OSError) as error:
            raise KeeneticError("Device change history cannot be read.", 503, "storage") from error

    def _store(self, operations):
        # Never discard an interrupted operation.
        keep = [op for op in operations if op["phase"] in {"pending", "uncertain", "undoing"}]
        keep += [op for op in operations if op["phase"] not in {"pending", "uncertain", "undoing"}][:OPERATION_LIMIT]
        try:
            atomic(self.path, json.dumps(keep, ensure_ascii=False).encode())
        except OSError as error:
            raise KeeneticError("Device change history cannot be saved.", 503, "storage") from error

    def _public(self, snapshot):
        self.service.device_routing_settings.remember(snapshot)
        favorites = self._read_favorites()
        devices = [{**device, "favorite": device["id"] in favorites} for device in snapshot["devices"]]
        locations = self.service.device_locations.decorate(devices, snapshot)
        return {"configured": True, "devices": devices, "policies": snapshot["policies"],
                "locations": locations,
                "operations": [self._operation_public(op, snapshot) for op in self._read()] + self.service.device_locations.operations(), "updated_at": now()}

    def _operation_public(self, op, snapshot):
        reason = ""
        if op["phase"] in {"undone", "rolled_back"}:
            reason = "Undone" if op["phase"] == "undone" else "Rolled back"
        elif op["phase"] == "committed":
            for change in op["changes"]:
                actual = snapshot["records"].get(change["id"], empty_record())
                if not matches(actual, change["after"], change["fields"]):
                    reason = "Changed again. Undo the newer change first."
                    break
            assignments = self.service.device_locations.read()["assignments"]
            for change in op["changes"]:
                assignment = assignments.get(change["id"])
                if assignment and (("reserved_ip" in change["fields"] and change["before"]["reserved_ip"] != assignment["ip"])
                                   or ("registered" in change["fields"] and not change["before"]["registered"])):
                    reason = "Select Use main location before removing its IP reservation or registration."
                    break
        return {"id": op["id"], "at": op["at"], "message": op["message"], "phase": op["phase"],
                "undoable": not reason, "undo_reason": reason}

    def snapshot(self):
        with self.service._op_lock, self.service.routing.activity(kind="read", scope="read", message="Reading devices from the router"):
            if not self.gateway.configured:
                return {"configured": False, "devices": [], "policies": [], "operations": [],
                        "error": "Set KEENETIC_USER and KEENETIC_PASSWORD on the server to manage router devices."}
            return self._public(self.gateway.snapshot())

    def change(self, body):
        with self.service.routing.admission(kind="device", message="Updating device settings"):
            ident = body.get("operation_id")
            if not isinstance(ident, str) or not ID_RE.fullmatch(ident):
                raise KeeneticError("Invalid device operation ID.", 400, "invalid_request")
            operations = self._read()
            previous = next((op for op in operations if op["id"] == ident), None)
            if previous:
                if previous.get("request") != body.get("changes"):
                    raise KeeneticError("Operation ID was already used for a different change.", 409, "conflict")
                if previous["phase"] != "committed":
                    raise KeeneticError("This change was interrupted or undone. Refresh devices before retrying.", 409, "conflict")
                snap = self.gateway.snapshot()
                return {**self._public(snap), "operation": self._operation_public(previous, snap)}
            if any(op["phase"] in {"pending", "uncertain", "undoing"} for op in operations):
                raise KeeneticError("Undo the interrupted device change before making another change.", 409, "recovery")
            snap = self.gateway.snapshot()
            changes = self._plan(body.get("changes"), snap)
            if not changes:
                return self._public(snap)
            message = self._message(changes, snap)
            op = {"id": ident, "at": now(), "message": message, "phase": "pending",
                  "request": deepcopy(body["changes"]), "changes": changes}
            operations.insert(0, op)
            self._store(operations)
            try:
                for change in changes:
                    self.gateway.write(change["id"], change["before"], change["after"], change["fields"])
                current = self.gateway.snapshot()
                if any(not matches(current["records"].get(change["id"], empty_record()), change["after"], change["fields"]) for change in changes):
                    raise KeeneticError("Keenetic did not confirm the requested device settings.", code="readback")
                self.gateway.save()
                for change in changes:
                    change["after"] = deepcopy(current["records"].get(change["id"], empty_record()))
                op["phase"] = "committed"
                self._store(operations)
            except Exception as error:
                op["phase"] = "uncertain"
                self._store(operations)
                try:
                    self._restore(op, partial=True)
                    op["phase"] = "rolled_back"
                    self._store(operations)
                except Exception:
                    self._history(op, "fail", "Change interrupted. Refresh devices and undo the interrupted change.")
                    raise KeeneticError("Device change interrupted. Refresh devices and undo the interrupted change before retrying.", code="recovery") from error
                raise KeeneticError("Device change failed; previous settings were restored.", code="rolled_back") from error
            self._history(op, "ok", message)
            return {**self._public(current), "operation": self._operation_public(op, current)}

    def _plan(self, requests, snapshot):
        if not isinstance(requests, list) or not 1 <= len(requests) <= 2:
            raise KeeneticError("Change one device, or rename an existing device while registering another.", 400, "invalid_request")
        planned = deepcopy(snapshot["records"])
        policies = {option["value"] for option in snapshot["policies"] if not option.get("disabled")}
        seen = set()
        changes = []
        for request in requests:
            if not isinstance(request, dict):
                raise KeeneticError("Invalid device change.", 400, "invalid_request")
            mac = request.get("id")
            values = request.get("values")
            if not isinstance(mac, str) or not MAC_RE.fullmatch(mac) or mac in seen or mac not in planned:
                raise KeeneticError("Device not found. Refresh the list.", 409, "conflict")
            seen.add(mac)
            before = planned[mac]
            if request.get("revision") != revision(before):
                raise KeeneticError("Device settings changed in another window. Refresh the list before saving.", 409, "conflict")
            if not isinstance(values, dict) or not values or not values.keys() <= FIELDS:
                raise KeeneticError("Invalid device fields.", 400, "invalid_request")
            after = deepcopy(before)
            if "registered" in values:
                if type(values["registered"]) is not bool:
                    raise KeeneticError("Invalid registration state.", 400, "invalid_request")
                after["registered"] = values["registered"]
            if "name" in values:
                after["name"] = validate_name(values["name"]) if after["registered"] else ""
            if "policy" in values:
                if not isinstance(values["policy"], str) or values["policy"] not in policies:
                    raise KeeneticError("Policy not found. Refresh devices.", 409, "conflict")
                after["binding"] = policy_binding(values["policy"])
            if "ip_pinned" in values:
                if type(values["ip_pinned"]) is not bool:
                    raise KeeneticError("Provide an IP pin boolean.", 400, "invalid_request")
                if values["ip_pinned"]:
                    if not after["registered"]:
                        raise KeeneticError("Register this device before pinning its IP address.", 400, "invalid_request")
                    if not before["reserved_ip"]:
                        if not usable_ipv4(before["ip"]):
                            raise KeeneticError("This device has no IPv4 address to pin. Refresh after it connects.", 409, "conflict")
                        after["reserved_ip"] = before["ip"]
                else:
                    after["reserved_ip"] = ""
            if after["registered"]:
                after["name"] = validate_name(after["name"])
            else:
                if not before["registered"] and set(values) != {"ip_pinned"}:
                    raise KeeneticError("Register this device before changing its settings.", 400, "invalid_request")
                after["name"] = ""
            fields = [key for key in ("name", "registered", "binding", "reserved_ip") if before[key] != after[key]]
            if before["registered"] != after["registered"]:
                fields = list(dict.fromkeys([*fields, "name", "registered", "binding", "hotspot"]))
            if fields:
                changes.append({"id": mac, "before": deepcopy(before), "after": after, "fields": fields})
            planned[mac] = after
        self._unique_names(planned)
        self._check_reservations(changes, planned)
        self.service.device_locations.guard_device_changes({change["id"]: planned[change["id"]]
            for change in changes if {"registered", "reserved_ip"}.intersection(change["fields"])})
        # Existing record must release the name before the new record claims it.
        for change in changes:
            if change["after"]["registered"] and change["after"]["name"] != change["before"]["name"]:
                for other in changes:
                    if other is not change and name_key(other["before"]["name"]) == name_key(change["after"]["name"]):
                        if changes.index(other) > changes.index(change):
                            raise KeeneticError("Rename the existing device first.", 400, "invalid_request")
        return changes

    @staticmethod
    def _check_reservations(changes, records):
        for change in changes:
            target = records[change["id"]]
            address = target["reserved_ip"]
            if "reserved_ip" in change["fields"] and address:
                if any(mac != change["id"] and address in (record["reserved_ip"], record["ip"])
                       for mac, record in records.items()):
                    raise KeeneticError("This IP address is already used or pinned by another device. Refresh devices.", 409, "ip_conflict")

    @staticmethod
    def _unique_names(records):
        names = [name_key(record["name"]) for record in records.values() if record["registered"]]
        if len(names) != len(set(names)):
            raise KeeneticError("This name is already registered. Choose another name or rename the existing device.", 409, "name_conflict")

    def _restore(self, op, partial=False, prepare=None):
        current = self.gateway.snapshot()
        planned = deepcopy(current["records"])
        for change in op["changes"]:
            actual = current["records"].get(change["id"], empty_record())
            if partial:
                if "hotspot" in change["fields"]:
                    before_options, after_options = host_options(change["before"]), host_options(change["after"])
                    if any(value not in (before_options.get(key), after_options.get(key)) for key, value in host_options(actual).items()):
                        raise KeeneticError("Other device settings changed. Review them in Keenetic before recovery.", 409, "conflict")
                for key in change["fields"]:
                    if key == "hotspot" or (not actual["registered"] and key in {"name", "binding"}):
                        continue
                    intermediate = key == "binding" and all(actual[key][part] in (change["before"][key][part], change["after"][key][part]) for part in ("access", "conform", "policy"))
                    intermediate |= key == "binding" and not change["before"]["registered"] and actual[key] in (policy_binding("default"), policy_binding("segment"))
                    if actual[key] not in (change["before"][key], change["after"][key]) and not intermediate:
                        raise KeeneticError("Device settings changed outside this operation. Review them in Keenetic.", 409, "conflict")
            elif not matches(actual, change["after"], change["fields"]):
                raise KeeneticError("Device settings changed again. Undo the newer change first.", 409, "conflict")
            if "hotspot" in change["fields"] and not partial and actual["hotspot"] != change["after"]["hotspot"]:
                raise KeeneticError("Other device settings changed. Refresh before undoing registration.", 409, "conflict")
            restored = deepcopy(actual)
            for key in change["fields"]:
                restored[key] = deepcopy(change["before"][key])
            planned[change["id"]] = restored
        self._unique_names(planned)
        self._check_reservations(op["changes"], planned)
        self.service.device_locations.guard_device_changes({change["id"]: planned[change["id"]]
            for change in op["changes"] if {"registered", "reserved_ip"}.intersection(change["fields"])})
        available_policies = {option["value"] for option in current["policies"] if not option.get("disabled")}
        for change in op["changes"]:
            target = planned[change["id"]]
            if target["registered"] and "binding" in change["fields"] and policy_value(target["binding"]) not in available_policies:
                raise KeeneticError("The previous policy no longer exists. Restore it in Keenetic before undoing this change.", 409, "conflict")
        if prepare:
            prepare()
        for change in reversed(op["changes"]):
            self.gateway.write(change["id"], current["records"].get(change["id"], empty_record()), planned[change["id"]], change["fields"])
        verified = self.gateway.snapshot()
        if any(not matches(verified["records"].get(change["id"], empty_record()), planned[change["id"]], change["fields"]) for change in op["changes"]):
            raise KeeneticError("Keenetic did not confirm the restored device settings.", code="readback")
        for change in op["changes"]:
            target = planned[change["id"]]
            if "hotspot" in change["fields"] and target["registered"] and host_options(verified["records"][change["id"]]) != host_options(target):
                raise KeeneticError("Keenetic did not confirm the restored host options.", code="readback")
        self.gateway.save()
        return verified

    def undo(self, ident):
        with self.service.routing.admission(kind="device", message="Restoring device settings"):
            operations = self._read()
            op = next((item for item in operations if item["id"] == ident), None)
            if op is None:
                if isinstance(ident, str) and ID_RE.fullmatch(ident) and self.service.routing.store.read(f"operations/{ident}.json"):
                    return self.service.device_locations.undo(ident)
                raise KeeneticError("This device change is no longer available to undo.", 404, "not_found")
            if op["phase"] in {"undone", "rolled_back"}:
                return self._public(self.gateway.snapshot())
            def prepare():
                op["phase"] = "undoing"
                self._store(operations)
            current = self._restore(op, partial=op["phase"] in {"pending", "uncertain", "undoing"}, prepare=prepare)
            op["phase"] = "undone"
            self._store(operations)
            self._history(op, "ok", "Undone: " + op["message"], undo=False)
            return self._public(current)

    def _history(self, op, result, message, undo=True):
        self.service.state.append_history({"ts": now(), "action": "device-change", "trigger": "manual", "result": result,
                                           "message": message, **({"device_operation": op["id"]} if undo else {})})

    @staticmethod
    def _message(changes, snapshot):
        labels = {option["value"]: option["label"] for option in snapshot["policies"]}
        messages = []
        for change in changes:
            before, after = change["before"], change["after"]
            if before["registered"] and not after["registered"]:
                messages.append(before["name"] + " unregistered")
            elif not before["registered"] and after["registered"]:
                messages.append(after["name"] + " registered · " + labels[policy_value(after["binding"])])
            else:
                if before["name"] != after["name"]:
                    messages.append(before["name"] + " renamed to " + after["name"])
                if before["binding"] != after["binding"]:
                    messages.append(after["name"] + ": " + labels[policy_value(before["binding"])] + " → " + labels[policy_value(after["binding"])])
            if before["reserved_ip"] != after["reserved_ip"]:
                name = after["name"] or before["name"] or change["id"]
                messages.append(f"{name}: IP {after['reserved_ip']} pinned" if after["reserved_ip"] else f"{name}: IP {before['reserved_ip']} unpinned")
        return "; ".join(messages)
