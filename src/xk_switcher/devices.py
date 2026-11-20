"""Read and normalize Keenetic devices and the configured (not effective) policies."""
import hashlib
import ipaddress
import json
import re
import unicodedata
from copy import deepcopy
from .keenetic import KeeneticError

MAC_RE = re.compile(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\Z")
NAME_LIMIT = 64
IPV4_BROADCAST = ipaddress.IPv4Address("255.255.255.255")
BUILTIN_POLICIES = [
    {"value": "default", "label": "Default"},
    {"value": "segment", "label": "Segment default"},
    {"value": "deny", "label": "No internet"},
]

def name_key(name):
    return unicodedata.normalize("NFKC", name.strip()).casefold()

def validate_name(name):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= NAME_LIMIT:
        raise KeeneticError("Enter a device name of 1–64 characters.", 400, "invalid_name")
    if any(unicodedata.category(char).startswith("C") for char in name):
        raise KeeneticError("Device names cannot contain control characters.", 400, "invalid_name")
    return name.strip()

def binding(raw):
    return {"access": "deny" if raw.get("deny") or raw.get("access") == "deny" else "permit",
            "conform": bool(raw.get("conform")), "policy": raw.get("policy") or ""}

def policy_value(value):
    if value["conform"]:
        return "segment"
    if value["policy"]:
        return "policy:" + value["policy"]
    return "deny" if value["access"] == "deny" else "default"

def policy_binding(value):
    return {"access": "deny" if value == "deny" else "permit",
            "conform": value == "segment", "policy": value[7:] if value.startswith("policy:") else ""}

def revision(record):
    return hashlib.sha256(json.dumps({key: record[key] for key in ("name", "registered", "binding", "reserved_ip", "ip")}, sort_keys=True).encode()).hexdigest()

def usable_ipv4(value):
    if not isinstance(value, str):
        return False
    try:
        address = ipaddress.IPv4Address(value)
        return not (address.is_unspecified or address.is_multicast or address.is_loopback or address == IPV4_BROADCAST)
    except ipaddress.AddressValueError:
        return False

def rows(value):
    if isinstance(value, list) and all(isinstance(item, dict) for item in value):
        return value
    if isinstance(value, dict):
        return [dict(item, **({"name": key} if "name" not in item else {})) for key, item in value.items() if isinstance(item, dict)]
    raise KeeneticError("Keenetic returned an unsupported device list.")

class DevicesGateway:
    def __init__(self, client):
        self.client = client

    @property
    def configured(self):
        return self.client.configured

    def snapshot(self):
        runtime = self.client.rci("show/ip/hotspot")
        settings = self.client.rci("ip/hotspot")
        known = self.client.rci("known/host")
        policies = self.client.rci("show/ip/policy")
        dhcp = self.client.rci("ip/dhcp/host")
        if not isinstance(runtime, dict) or not isinstance(settings, dict) or not isinstance(policies, dict):
            raise KeeneticError("Keenetic returned an unsupported device response.")
        known_by_mac = {item["mac"].lower(): item for item in rows(known) if isinstance(item.get("mac"), str)}
        hosts = {item["mac"].lower(): item for item in rows(runtime.get("host", [])) if isinstance(item.get("mac"), str)}
        host_settings = {item["mac"].lower(): item for item in rows(settings.get("host", [])) if isinstance(item.get("mac"), str)}
        if isinstance(dhcp, dict) and any(not isinstance(item, dict) for item in dhcp.values()):
            raise KeeneticError("Keenetic returned an unsupported IP reservation list.")
        reservations = {}
        for item in rows(dhcp):
            mac, address = item.get("mac"), item.get("ip")
            if not isinstance(mac, str) or not MAC_RE.fullmatch(mac.lower()) or not isinstance(address, str) or not usable_ipv4(address):
                raise KeeneticError("Keenetic returned an unsupported IP reservation.")
            mac = mac.lower()
            if mac in reservations and reservations[mac] != address:
                raise KeeneticError("Keenetic returned multiple IP reservations for one device.")
            reservations[mac] = address
        segments = {item.get("interface"): policy_value(binding(item)) for item in rows(settings.get("policy", []))}
        default_raw = settings.get("default-policy", {})
        if isinstance(default_raw, str):
            default_raw = {"access": default_raw} if default_raw in {"permit", "deny"} else {"policy": default_raw}
        default_segment = policy_value(binding(default_raw))
        options = [{"value": "policy:" + key, "label": value.get("description") or key}
                   for key, value in policies.items() if isinstance(value, dict)] + deepcopy(BUILTIN_POLICIES)
        labels = {item["value"]: item["label"] for item in options}
        records = {}
        devices = []
        for mac in sorted(hosts.keys() | known_by_mac.keys() | reservations.keys()):
            if not MAC_RE.fullmatch(mac):
                continue
            host = hosts.get(mac, {})
            known_host = known_by_mac.get(mac)
            registered = known_host is not None
            name = (known_host.get("name") or host.get("name") or "") if registered else ""
            if registered and not name:
                raise KeeneticError("Keenetic did not return the saved name of a registered device.")
            raw = host_settings.get(mac, {})
            record = {"name": name, "registered": registered, "binding": binding(raw), "hotspot": deepcopy(raw),
                      "reserved_ip": reservations.get(mac, ""), "ip": host.get("ip") or ""}
            records[mac] = record
            interface = host.get("interface") or {}
            segment_id = interface.get("id", "") if isinstance(interface, dict) else interface
            segment_name = (interface.get("name") or interface.get("description") or segment_id) if isinstance(interface, dict) else interface
            segment_policy = segments.get(segment_id, default_segment)
            selected = policy_value(record["binding"]) if registered else "segment"
            if selected not in labels:
                options.append({"value": selected, "label": (record["binding"]["policy"] or selected) + " (unavailable)", "disabled": True})
                labels[selected] = options[-1]["label"]
            devices.append({"id": mac, "mac": mac, "name": name, "hostname": host.get("hostname") or "",
                            "ip": record["ip"], "reserved_ip": record["reserved_ip"], "ip_pinned": bool(record["reserved_ip"]),
                            "can_pin_ip": registered and usable_ipv4(record["ip"]), "segment": segment_name or "Unknown network",
                            "segment_policy": labels.get(segment_policy, segment_policy.removeprefix("policy:")),
                            "effective_policy": segment_policy if selected == "segment" else selected,
                            "online": bool(host.get("active")), "registered": registered, "policy": selected,
                            "revision": revision(record)})
        devices.sort(key=lambda device: (not device["online"], device["registered"], name_key(device["name"] or device["hostname"]), device["mac"]))
        return {"devices": devices, "policies": options, "records": records}

    def write(self, mac, before, after, fields):
        if after["registered"]:
            if not before["registered"] or "name" in fields:
                self.client.rci("known/host", {"mac": mac, "name": after["name"]})
            if not before["registered"] or "binding" in fields:
                value = after["binding"]
                # RCI's `no` object removes just the selected field. Never touch schedules
                # or other host settings on a normal policy edit.
                payload = {"mac": mac, value["access"]: True,
                           "conform": True if value["conform"] else {"no": True},
                           "policy": value["policy"] or {"no": True}}
                if "hotspot" in fields:
                    extra = {key: val for key, val in after["hotspot"].items()
                             if key not in {"mac", "access", "permit", "deny", "conform", "policy"}}
                    payload = {**extra, **payload}
                self.client.rci("ip/hotspot/host", payload)
        elif before["registered"]:
            # Match the native UI's unregister operation. Keep static DHCP leases.
            self.client.rci("known/host", {"mac": mac, "name": before["name"], "no": True})
        if "reserved_ip" in fields:
            payload = {"mac": mac, "ip": after["reserved_ip"]} if after["reserved_ip"] else {"mac": mac, "no": True}
            self.client.rci("ip/dhcp/host", payload)

    def save(self):
        self.client.rci("system/configuration/save", {})
