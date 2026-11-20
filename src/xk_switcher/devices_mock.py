"""Persistent development router for the device API (ROUTER_HOST=mock only)."""
import json
from copy import deepcopy
from .devices import DevicesGateway
from .routing_store import atomic

class MockDevicesGateway(DevicesGateway):
    def __init__(self, data_dir):
        self.path = data_dir / "devices" / "mock-router.json"
        try:
            self.data = json.loads(self.path.read_bytes())
        except FileNotFoundError:
            self.data = self._seed()
        super().__init__(self)

    @property
    def configured(self):
        return True

    def rci(self, path, payload=None):
        if payload is None:
            return deepcopy({
                "show/ip/hotspot": {"host": self.data["hosts"]},
                "ip/hotspot": {"host": list(self.data["settings"].values()), "policy": [
                    {"interface": "Bridge0", "access": "permit"}, {"interface": "Bridge1", "access": "deny"}]},
                "known/host": {name: {"mac": mac} for mac, name in self.data["known"].items()},
                "show/ip/policy": self.data.get("policies", {"Policy0": {"description": "XKeen"}}),
                "ip/dhcp/host": [{"mac": mac, "ip": address} for mac, address in self.data.get("reservations", {}).items()],
            }[path])
        if path == "known/host":
            if payload.get("no"):
                self.data["known"].pop(payload["mac"], None)
                self.data["settings"].pop(payload["mac"], None)
            else:
                self.data["known"][payload["mac"]] = payload["name"]
        elif path == "ip/hotspot/host":
            row = self.data["settings"].setdefault(payload["mac"], {"mac": payload["mac"]})
            for key, value in payload.items():
                if isinstance(value, dict) and value.get("no"):
                    row.pop(key, None)
                else:
                    if key in {"permit", "deny"}:
                        row.pop("deny" if key == "permit" else "permit", None)
                        row["access"] = key
                    row[key] = value
        elif path == "ip/dhcp/host":
            reservations = self.data.setdefault("reservations", {})
            if payload.get("no"):
                reservations.pop(payload["mac"], None)
            else:
                reservations[payload["mac"]] = payload["ip"]
        elif path != "system/configuration/save":
            raise ValueError("Unsupported mock RCI path")
        atomic(self.path, json.dumps(self.data).encode())
        return {"status": [{"status": "message", "message": "Applied"}]}

    @staticmethod
    def _seed():
        samples = [
            ("45", "", "MacBookPro", True, "segment"), ("21", "MacBookPro", "MacBookPro", False, "Policy0"),
            ("10", "mac-mini", "mac-mini", True, "Policy0"), ("32", "iPhone", "iPhone", True, "Policy0"),
            ("54", "Apple TV", "Apple-TV", True, "Policy0"), ("12", "", "Android", True, "segment"),
            ("86", "Hue Bridge", "Hue", True, "default"), ("70", "Kitchen speaker", "Speaker", True, "default"),
            ("37", "iPad", "iPad", False, "segment"), ("60", "Printer", "Printer", True, "deny"),
            ("91", "", "", False, "segment"),
        ]
        data = {"hosts": [], "known": {}, "settings": {}}
        for suffix, name, hostname, online, policy in samples:
            mac = "02:00:00:00:00:" + suffix
            guest = suffix == "12"
            data["hosts"].append({"mac": mac, "name": name, "hostname": hostname, "active": online,
                                  "ip": f"192.168.{3 if guest else 2}.{suffix}",
                                  "interface": {"id": "Bridge1" if guest else "Bridge0", "name": "Guest" if guest else "Home"}})
            if name:
                data["known"][mac] = name
                settings = {"mac": mac, "access": "deny" if policy == "deny" else "permit"}
                settings[settings["access"]] = True
                if policy == "segment": settings["conform"] = True
                if policy == "Policy0": settings["policy"] = policy
                data["settings"][mac] = settings
        return data
