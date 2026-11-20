"""Policy mapping and explicit identity of the host used for route checks."""
import json
from . import routing
from .devices import MAC_RE
from .routing_store import atomic

class DeviceRoutingSettings:
    def __init__(self, service):
        self.service = service
        self.path = service.state.data_dir / "devices" / "routing-settings.json"
        self.check_path = self.path.with_name("server-route.json")
        self.inventory = None

    def read(self):
        try:
            doc = json.loads(self.path.read_bytes())
            if not routing.valid_id(doc["revision"]):
                raise ValueError("Invalid revision")
            if doc["policy_ids"] is not None and (not isinstance(doc["policy_ids"], list) or any(not isinstance(value, str) for value in doc["policy_ids"])):
                raise ValueError("Invalid policies")
            if doc["server_device_id"] is not None and not MAC_RE.fullmatch(doc["server_device_id"]):
                raise ValueError("Invalid server device")
            return doc
        except FileNotFoundError:
            return {"revision": None, "policy_ids": None, "server_device_id": None}
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise routing.RoutingError("Device routing settings cannot be read", 503, "storage") from error

    def policy_ids(self, policies):
        saved = self.read()["policy_ids"]
        if saved is not None:
            return set(saved)
        if self.service.config.xkeen_policy_ids:
            return set(self.service.config.xkeen_policy_ids)
        return {item["value"] for item in policies if item["label"].casefold() == "xkeen" and not item.get("disabled")}

    def remember(self, snapshot):
        self.inventory = snapshot

    def public(self, snapshot):
        doc = self.read()
        return {**doc, "policy_ids": sorted(self.policy_ids(snapshot["policies"])),
                "source": "saved" if doc["policy_ids"] is not None else "environment" if self.service.config.xkeen_policy_ids else "automatic"}

    def save(self, body):
        return self._change(body, server_change=False)

    def set_server(self, body):
        return self._change(body, server_change=True)

    def _change(self, body, *, server_change):
        if set(body) != ({"revision", "id"} if server_change else {"revision", "policy_ids"}):
            raise routing.RoutingError("Provide the settings revision and server device" if server_change else "Provide the settings revision and policies")
        with self.service.routing.admission():
            previous = self.read()
            if body["revision"] != previous["revision"]:
                raise routing.RoutingError("Routing settings changed. Reopen setup before saving.", 409, "conflict")
            snapshot = self.service.devices.gateway.snapshot()
            values = previous["policy_ids"] if server_change else body["policy_ids"]
            if not server_change:
                if not isinstance(values, list) or any(not isinstance(value, str) for value in values) or len(set(values)) != len(values):
                    raise routing.RoutingError("Select unique connection policies")
                valid = {item["value"] for item in snapshot["policies"] if item["value"] not in {"segment", "deny"} and not item.get("disabled")}
                if not set(values) <= valid:
                    raise routing.RoutingError("A selected connection policy is unavailable", 409, "policy")
                values = sorted(values)
            server = body["id"] if server_change else previous["server_device_id"]
            if server_change and server is not None and (not isinstance(server, str) or not any(item["id"] == server and item["registered"] for item in snapshot["devices"])):
                raise routing.RoutingError("Select a registered device as the switcher server", 409, "server_device")
            if values == previous["policy_ids"] and server == previous["server_device_id"]:
                return self.service.devices._public(snapshot)
            doc = {"revision": routing.new_id(), "policy_ids": values, "server_device_id": server}
            atomic(self.path, json.dumps(doc).encode())
            self.remember(snapshot)
            # Previous route evidence belongs to the previous mapping/host.
            health = self.service.state.read_health()
            for entry in health.get("map", {}).values():
                if entry.get("route_checked_at"):
                    entry.update(route_ok=None, route_checked_at=None, route_results=[], fail_streak=0, ok_streak=0,
                                 ok=bool(entry.get("tcp_ok")), probe_method="tcp" if entry.get("tcp_ok") is not None else "skipped")
            self.service.state.write_health(health)
            return self.service.devices._public(snapshot)

    def context(self, refresh=False):
        settings = self.read()
        assignments = self.service.device_locations.read()
        state = self.service.state.read_state()
        server_id = settings["server_device_id"]
        if refresh and server_id:
            try:
                self.remember(self.service.devices.gateway.snapshot())
            except Exception:
                self.inventory = None
        device = next((item for item in (self.inventory or {}).get("devices", []) if item["id"] == server_id), None)
        main = state.get("active_code")
        assignment = assignments["assignments"].get(server_id)
        mode, code = "unknown", None
        if device and device["registered"]:
            inside = device.get("effective_policy", device["policy"]) in self.policy_ids(self.inventory["policies"])
            if not inside:
                mode = "outside"
            elif assignment:
                if device["reserved_ip"] == assignment["ip"] and (not device["ip"] or device["ip"] == assignment["ip"]):
                    mode, code = "fixed", assignment["code"]
            else:
                mode, code = "main", main
        available = {loc["code"]: loc for loc in self.service.state.read_subscription().get("locations", [])}
        location = (assignments["locations"].get(code) if mode == "fixed" else available.get(code)) or {}
        result = {"device_id": server_id, "device_name": (device.get("name") or device.get("hostname")) if device else None,
                  "mode": mode, "code": code, "main_code": main, "follows_main": mode == "main",
                  "main_route": self.service.route_info(main, state.get("active_entry_code")),
                  "location": {key: location.get(key) for key in ("code", "name", "host", "port", "protocol")},
                  "identified": bool(device), "unavailable": bool(code and code not in available)}
        identity = {key: result[key] for key in ("device_id", "mode", "code")}
        identity.update(main_entry_code=state.get("active_entry_code") if mode == "main" else None,
                        settings_revision=settings["revision"], locations_revision=assignments["revision"],
                        device_revision=device.get("revision") if device else None,
                        last_apply=state.get("last_apply_at") if mode == "main" else None,
                        xkeen_state=state.get("xkeen_state"), targets=self.service.state.read_connectivity()["check_urls"])
        result["key"] = routing.digest(json.dumps(identity, sort_keys=True).encode())
        return result

    def record_check(self, context, result):
        atomic(self.check_path, json.dumps({"key": context["key"], "result": result}).encode())

    def status(self):
        context = self.context()
        check = None
        try:
            saved = json.loads(self.check_path.read_bytes())
            if saved.get("key") == context["key"]:
                check = saved.get("result")
        except (FileNotFoundError, ValueError, OSError):
            pass
        return {**context, "check": check}
