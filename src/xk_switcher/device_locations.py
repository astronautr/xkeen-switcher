"""Durable device assignments and validated multi-file Xray transactions."""
import copy
import json
from . import config_updates, device_routing as compiler, jsonc, routing
from .devices import MAC_RE, usable_ipv4
from .routing import RoutingError
from .routing_store import atomic

class DeviceLocationsService:
    def __init__(self, parent):
        self.parent = parent
        self.path = parent.state.data_dir / "devices" / "locations.json"

    def read(self):
        try:
            doc = json.loads(self.path.read_bytes())
            if type(doc["managed"]) is not bool or (doc["revision"] is not None and not routing.valid_id(doc["revision"])):
                raise ValueError("Invalid device location state")
            if not isinstance(doc["assignments"], dict) or not isinstance(doc["locations"], dict):
                raise ValueError("Invalid assignments")
            if doc["assignments"] and not doc["managed"]:
                raise ValueError("Unmanaged assignments")
            for mac, value in doc["assignments"].items():
                if not MAC_RE.fullmatch(mac) or not usable_ipv4(value["ip"]) or not isinstance(value["code"], str):
                    raise ValueError("Invalid device location")
            return doc
        except FileNotFoundError:
            return {"revision": None, "assignments": {}, "locations": {}, "managed": False}
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise RoutingError("Device location storage cannot be read", 503, "storage") from error

    def write(self, doc):
        atomic(self.path, json.dumps(doc, ensure_ascii=False).encode())

    def managed(self):
        return self.read()["managed"]

    def has_assignments(self):
        return bool(self.read()["assignments"])

    def policy_ids(self, policies):
        return self.parent.device_routing_settings.policy_ids(policies)

    def decorate(self, devices, snapshot):
        doc = self.read()
        available = {loc["code"]: loc for loc in self.parent.state.read_subscription().get("locations", [])}
        policies = self.policy_ids(snapshot["policies"])
        settings = self.parent.device_routing_settings.public(snapshot)
        for device in devices:
            device["is_server"] = device["id"] == settings["server_device_id"]
            assignment = doc["assignments"].get(device["id"])
            inside = device.get("effective_policy", device["policy"]) in policies
            mismatch = bool(assignment and (device["reserved_ip"] != assignment["ip"] or not device["registered"]
                            or (device["online"] and device["ip"] and device["ip"] != assignment["ip"])))
            code = assignment["code"] if assignment else None
            device["location"] = {"code": code, "in_xkeen": inside, "ip": assignment["ip"] if assignment else None,
                                  "unavailable": bool(code and code not in available), "ip_conflict": mismatch,
                                  "editable": bool(device["registered"] and (inside or assignment)),
                                  "name": (available.get(code) or doc["locations"].get(code) or {}).get("name", code)}
        pending = self.parent.routing.public_operation()
        # Ephemeral activity, such as this very inventory read, has no journal to check.
        if pending and not pending.get("id"):
            pending = None
        return {"revision": doc["revision"], "main_code": self.parent.state.read_state().get("active_code"),
                "main_route": self.parent.route_info(self.parent.state.read_state().get("active_code"),
                                                      self.parent.state.read_state().get("active_entry_code")),
                "pending_operation": {key: pending[key] for key in ("id", "phase", "message")} if pending else None,
                "available": [{"code": loc["code"], "name": loc["name"], "protocol": loc.get("protocol")} for loc in available.values()],
                "policy_ids": sorted(policies), "managed": doc["managed"], "settings": settings}

    def guard_device_changes(self, records):
        for mac, assignment in self.read()["assignments"].items():
            target = records.get(mac)
            if target and (not target["registered"] or target["reserved_ip"] != assignment["ip"]):
                raise RoutingError("Select Use main location before unpinning the IP or unregistering this device", 409, "device_location")

    def needs_refresh(self, locations, doc=None):
        return self.pending_update_kind(locations, doc=doc) is not None

    def pending_update_kind(self, locations, doc=None):
        doc = self.read() if doc is None else doc
        from .subscription import Location
        return config_updates.combined_kind(
            config_updates.change_kind(
                config_updates.location_hashes(Location(**doc["locations"][code])) if code in doc["locations"] else None,
                config_updates.location_hashes(Location(**locations[code])))
            for code in {value["code"] for value in doc["assignments"].values()} if code in locations)

    def prepare(self, routing_raw, *, main=None, desired=None, state_patch=None,
                main_only=False, refresh_locations=False, history=None):
        router, store = self.parent.router, self.parent.routing.store
        caps = router.routing_capabilities()
        if not caps.get("ready") or not caps.get("selective"):
            raise RoutingError("Install router helper v3 with startup recovery before applying configurations", 503, "helper")
        environment = router.bundle_environment()
        for name, raw in router.config_dependencies().items():
            doc = jsonc.loads(raw.decode("utf-8-sig"))
            if doc.get("routing") is not None or doc.get("outbounds"):
                raise RoutingError(f"Device locations require routing in 05_routing.json and outbounds in 04_outbounds.json. Review {name} first.", 422, "layout")
        before = router.read_bundle()
        if routing_raw is None:
            routing_raw = before[compiler.ROUTING_FILE]
        current = self.parent.routing.ensure_current(before[compiler.ROUTING_FILE])
        if current and routing.digest(before[compiler.ROUTING_FILE]) != current["sha256"]:
            raise RoutingError("Routing changed on the router. Reimport it before applying device locations.", 409, "drift")
        previous = self.read()
        if not previous["managed"] and compiler.OVERLAY_FILE in before and jsonc.loads(before[compiler.OVERLAY_FILE].decode("utf-8-sig")):
            raise RoutingError("A device routing overlay already exists without its saved assignments. Restore the server data or review the router configuration first.", 409, "drift")
        desired = copy.deepcopy(previous if desired is None else desired)
        if not main_only:
            available = {loc["code"]: loc for loc in self.parent.state.read_subscription().get("locations", [])}
            # Existing exits keep their applied configuration until an explicit
            # pending update. A newly assigned country uses the fresh cache.
            locations = {**available, **desired["locations"]}
            if refresh_locations:
                locations.update(available)
            used = {value["code"] for value in desired["assignments"].values()}
            desired["locations"] = {code: locations[code] for code in used if code in locations}
            desired["managed"] = bool(desired["assignments"])
            if desired != previous:
                desired["revision"] = routing.new_id()
        files = {**before, compiler.ROUTING_FILE: routing_raw}
        if main is not None:
            files[compiler.OUTBOUNDS_FILE] = main.encode()
        if not main_only:
            if desired["assignments"]:
                files[compiler.OVERLAY_FILE] = compiler.compile_overlay(routing_raw, desired["assignments"], desired["locations"], files[compiler.OUTBOUNDS_FILE])
            else:
                files.pop(compiler.OVERLAY_FILE, None)
        candidate = compiler.pack(files)
        if not main_only:
            # Assignment preparation must validate before any DHCP pin, and
            # routing previews retain their pre-apply validation contract.
            router.validate_bundle(candidate)
            if router.bundle_environment() != environment or compiler.fingerprint(router.read_bundle()) != compiler.fingerprint(before):
                raise RoutingError("Router configuration changed during validation", 409, "conflict")
        # Main has no pre-submit router side effects. Its frozen snapshot is
        # validated once by the helper under its transaction lock; the helper
        # rechecks both hashes before/after validation and before live writes.
        patch = dict(state_patch or {})
        code = patch.get("active_code", self.parent.state.read_state().get("active_code"))
        patch.update(self.parent.pending_config_patch(code, applied_main=patch.get("applied_main_fingerprint"),
            main_hashes=patch.get("applied_main_config_hashes"), device_state=desired,
            route_patch={**self.parent.state.read_state(), **patch}))
        meta = store.save_blob("bundles", candidate, {"before_hash": compiler.fingerprint(before),
                              "after_hash": compiler.fingerprint(files), "environment": environment,
                              "locations_revision": previous["revision"], "locations_state": desired,
                              "previous_locations_state": previous,
                              "state_patch": patch, "main_only": main_only,
                              "history": history,
                              "changed_files": [name for name in compiler.FILES if before.get(name) != files.get(name)]})
        store.save_blob("bundle-backups", compiler.pack(before), {}, ident=meta["id"])
        return meta["id"], environment

    def verify_bindings(self, doc):
        if not doc["assignments"]:
            return
        records = self.parent.devices.gateway.snapshot()["records"]
        for mac, assignment in doc["assignments"].items():
            record = records.get(mac)
            if not record or not record["registered"] or record["reserved_ip"] != assignment["ip"]:
                raise RoutingError("A device's reserved IP changed. Select Use main location for that device before applying again.", 409, "ip_conflict")
            if any(other != mac and assignment["ip"] in (value["ip"], value["reserved_ip"]) for other, value in records.items()):
                raise RoutingError("A device location IP is now used by another device. Review IP reservations.", 409, "ip_conflict")

    def operations(self):
        result = []
        current = self.read()
        store = self.parent.routing.store
        for op in reversed(store.operations()):
            if not op.get("device_request") or op["device_request"].get("undo") or op["phase"] != "committed":
                continue
            preview, _ = store.blob("previews", op["preview_id"])
            bundle, _ = store.blob("bundles", preview["bundle_id"])
            undoable = current["revision"] == bundle["locations_state"]["revision"]
            result.append({"id": op["id"], "at": op["created_at"], "phase": "committed", "message": "Device location changed",
                           "undoable": undoable, "undo_reason": "" if undoable else "Device locations changed again", "kind": "location"})
            if len(result) >= 100: break
        return result

    def undo(self, ident):
        with self.parent.routing.admission(kind="device-location", message="Preparing device location undo"):
            store = self.parent.routing.store
            op = store.operation(ident)
            if op["phase"] != "committed" or not op.get("device_request") or op["device_request"].get("undo"):
                raise RoutingError("This location change cannot be undone", 409)
            preview, _ = store.blob("previews", op["preview_id"])
            bundle, _ = store.blob("bundles", preview["bundle_id"])
            current = self.read()
            if current["revision"] != bundle["locations_state"]["revision"]:
                raise RoutingError("Device locations changed again. Choose a location in the device row instead.", 409, "conflict")
            desired = copy.deepcopy(current)
            previous = bundle["previous_locations_state"]
            desired["assignments"] = previous["assignments"]
            desired["locations"] = {**current["locations"], **previous["locations"]}
            self.verify_bindings(desired)
            bundle_id, environment = self.prepare(self.parent.router.read_routing(), desired=desired)
            return {"operation": self.parent.routing.apply_bundle(bundle_id=bundle_id, environment=environment,
                                 device_request={"undo": ident})}

    def apply_main(self, payload, code, *, state_patch=None, history=None, refresh_locations=False):
        # Small test/embedding adapters can retain the legacy Router interface;
        # every production Router supports durable selective transactions.
        if not callable(getattr(type(self.parent.router), "start_bundle", None)):
            self.parent.router.apply(payload)
            return None
        bundle_id, environment = self.prepare(None, main=payload,
            main_only=not refresh_locations, refresh_locations=refresh_locations,
            state_patch=state_patch, history=history)
        op = self.parent.routing.apply_bundle(bundle_id=bundle_id, environment=environment, synchronous=True)
        if op["phase"] != "committed":
            raise RoutingError(op.get("message", "Location apply failed"), 503, op["phase"])
        return op

    def change(self, body):
        ident = body.get("operation_id")
        if routing.valid_id(ident):
            existing = self.parent.routing.store.read(f"operations/{ident}.json")
            if existing:
                if existing.get("device_request") != body:
                    raise RoutingError("Operation ID already used for a different change", 409)
                return {"operation": existing}
        with self.parent.routing.admission(kind="device-location", target_code=body.get("code"), message="Preparing device location"):
            if set(body) != {"id", "code", "revision", "locations_revision", "operation_id"}:
                raise RoutingError("Provide the device, location, revisions and operation ID")
            ident = body.get("operation_id")
            if not routing.valid_id(ident):
                raise RoutingError("Invalid operation ID")
            existing = self.parent.routing.store.read(f"operations/{ident}.json")
            if existing:
                if existing.get("device_request") != body:
                    raise RoutingError("Operation ID already used for a different change", 409)
                return {"operation": existing}
            self.parent.routing.ensure_idle()
            doc = self.read()
            if any(op["phase"] in {"pending", "uncertain", "undoing"} for op in self.parent.devices._read()):
                raise RoutingError("Recover the interrupted device change before assigning a location", 409, "device_recovery")
            if body.get("locations_revision") != doc["revision"]:
                raise RoutingError("Device locations changed. Refresh devices before saving.", 409, "conflict")
            snapshot = self.parent.devices.gateway.snapshot()
            device = next((item for item in snapshot["devices"] if item["id"] == body.get("id")), None)
            if not device or device["revision"] != body.get("revision"):
                raise RoutingError("Device settings changed. Refresh devices before saving.", 409, "conflict")
            code = body.get("code")
            desired = copy.deepcopy(doc)
            if code is None:
                desired["assignments"].pop(device["id"], None)
            else:
                location = self.parent._find_location(code) if isinstance(code, str) else None
                if location is None:
                    raise RoutingError("Location is no longer available", 409, "location")
                if not device["registered"] or device.get("effective_policy", device["policy"]) not in self.policy_ids(snapshot["policies"]):
                    raise RoutingError("Register the device and assign an XKeen policy first", 409, "policy")
                address = device["reserved_ip"] or device["ip"]
                if not usable_ipv4(address) or (device["ip"] and device["ip"] != address):
                    raise RoutingError("Reconnect this device to obtain its reserved IPv4 address first", 409, "ip_conflict")
                if any(item["id"] != device["id"] and address in (item["ip"], item["reserved_ip"]) for item in snapshot["devices"]):
                    raise RoutingError("This IP is used by another device", 409, "ip_conflict")
                desired["assignments"][device["id"]] = {"code": code, "ip": address}
            if desired["assignments"] == doc["assignments"]:
                return {"operation": {"id": ident, "phase": "committed", "message": "No changes", "noop": True}}
            refresh = {}
            if code is not None:
                refresh = self.parent.refresh_before_apply()
                if self.parent._find_location(code) is None:
                    raise RoutingError("Location is no longer available", 409, "location")
            # Validate Xray before pinning DHCP. A successful pin is kept if the
            # later Xray transaction rolls back; it is independently undoable.
            self.parent.routing.state()
            raw = self.parent.router.read_routing()
            history = ({"action": "routing-device-location", "trigger": "manual", "code": code,
                        "warning": refresh["warning"]} if refresh.get("warning") else None)
            bundle_id, environment = self.prepare(raw, desired=desired, history=history)
            if code is not None and not device["reserved_ip"]:
                self.parent.devices.change({"operation_id": routing.new_id(), "changes": [
                    {"id": device["id"], "revision": device["revision"], "values": {"ip_pinned": True}}]})
            return {"operation": self.parent.routing.apply_bundle(ident=ident, bundle_id=bundle_id,
                                environment=environment, device_request=body)}
