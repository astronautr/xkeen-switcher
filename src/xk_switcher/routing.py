"""Pure routing projection, conservative editing, validation and ordered diff."""
import copy
import hashlib
import ipaddress
import json
import re
import uuid
from . import jsonc
from .outbound import VLESS_TAG

SCHEMA_VERSION = 1
MAX_CONFIG_BYTES = 1024 * 1024
MAX_GROUPS = 256
MAX_MATCHERS = 4096
INBOUND_TAGS = ["redirect", "tproxy"]
ACTIONS = {"block": "block", "direct": "direct", "proxy": VLESS_TAG}
FIELDS = {"domain-substring": "domain", "domain-suffix": "domain", "domain-exact": "domain",
          "domain-regexp": "domain", "domain-geosite": "domain", "ip": "ip", "ip-geoip": "ip",
          "source": "source", "port": "port", "network": "network", "protocol": "protocol"}
PREFIXES = {"domain-substring": "keyword:", "domain-suffix": "domain:",
            "domain-exact": "full:", "domain-regexp": "regexp:"}
RULE_FIELDS = {"type", "inboundTag", "outboundTag", "ruleTag", *FIELDS.values()}

class RoutingError(Exception):
    def __init__(self, message, status=400, code="invalid", validation=None):
        super().__init__(message)
        self.status, self.code, self.validation = status, code, validation or []

def new_id():
    return str(uuid.uuid4())

def valid_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value))

def digest(raw: bytes):
    return hashlib.sha256(raw).hexdigest()

def is_catch_all(group):
    return group["editable"] and not group["matchers"]

def refresh_model(model):
    """Refresh UI annotations from v1 stores without rewriting any config bytes."""
    if model is None or model.get("schema_version") != SCHEMA_VERSION: return model
    model = copy.deepcopy(model)
    # Earlier v1 projections treated the final proxy rule as immutable and
    # reported other default routes as incompatible. These were UI constraints.
    model["issues"] = []
    groups = model["groups"]
    legacy = not any("default_rule" in group for group in groups)
    for group in model["groups"]:
        group.pop("locked", None)
        group["catch_all"] = is_catch_all(group)
        group["default_rule"] = bool(group.get("default_rule", False))
    if legacy and groups and is_catch_all(groups[-1]):
        groups[-1]["default_rule"] = True
    return model

def _matcher(field, value):
    if not isinstance(value, str):
        if field == "port" and type(value) is int: value = str(value)
        else: raise ValueError("Unsupported condition format")
    kind = field
    if field == "domain":
        kind = "domain-substring"
        for candidate, prefix in PREFIXES.items():
            if value.startswith(prefix):
                return {"type": candidate, "value": value[len(prefix):]}
        if value.startswith(("geosite:", "ext:")): kind = "domain-geosite"
        elif ":" in value: raise ValueError("Unsupported domain prefix")
    if field == "ip" and value.startswith(("geoip:", "ext:")): kind = "ip-geoip"
    return {"type": kind, "value": value}

def parse(raw: bytes, previous=None):
    if len(raw) > MAX_CONFIG_BYTES: raise ValueError("Routing configuration exceeds 1 MiB")
    text = raw.decode("utf-8-sig")
    doc = jsonc.loads(text)
    if not isinstance(doc, dict) or not isinstance(doc.get("routing"), dict):
        raise ValueError("Routing object not found")
    rules = doc["routing"].get("rules")
    if not isinstance(rules, list) or not all(isinstance(r, dict) for r in rules):
        raise ValueError("routing.rules must be an array of objects")
    titles = jsonc.rule_titles(text)
    groups = []
    old_groups = (refresh_model(previous) or {}).get("groups", [])
    for index, rule in enumerate(rules):
        action = next((a for a, tag in ACTIONS.items() if tag == rule.get("outboundTag")), "custom")
        editable = (not set(rule) - RULE_FIELDS and action != "custom"
                    and rule.get("type", "field") == "field"
                    and rule.get("inboundTag") == INBOUND_TAGS)
        matchers = []
        try:
            for name in dict.fromkeys(FIELDS.values()):
                if name not in rule: continue
                values = rule[name] if isinstance(rule[name], list) else [rule[name]]
                if name not in ("port", "network") and not isinstance(rule[name], list): editable = False
                for value in values: matchers.append(_matcher(name, value))
        except ValueError:
            editable = False
        matches = [g for g in old_groups if g["rule"] == rule]
        unique_rule = rules.count(rule) == 1
        prior = matches[0] if len(matches) == 1 and unique_rule else None
        groups.append({"id": prior["id"] if prior else new_id(), "title": titles[index] or rule.get("ruleTag") or f"Rule {index + 1}",
                       "action": action, "matchers": matchers, "rule": rule,
                       "editable": editable, "catch_all": editable and not matchers,
                       "default_rule": bool(prior and prior.get("default_rule"))})
    if groups and not any(g["default_rule"] for g in groups) and is_catch_all(groups[-1]):
        groups[-1]["default_rule"] = True
    model = {"schema_version": SCHEMA_VERSION, "document": doc, "groups": groups}
    model["issues"] = []
    return model

def edit_model(base, supplied):
    """Clients may edit UI fields only; immutable router data comes from base."""
    base = refresh_model(base)
    if not isinstance(supplied, dict) or supplied.get("schema_version") != SCHEMA_VERSION:
        raise RoutingError("Unknown draft schema")
    groups = supplied.get("groups")
    if not isinstance(groups, list) or len(groups) > MAX_GROUPS:
        raise RoutingError("Invalid rule list")
    known = {g["id"]: g for g in base["groups"]}
    result, seen = [], set()
    for g in groups:
        if not isinstance(g, dict) or not valid_id(g.get("id")) or g["id"] in seen:
            raise RoutingError("Invalid or duplicate rule ID")
        seen.add(g["id"])
        if not isinstance(g.get("title"), str) or not isinstance(g.get("action"), str):
            raise RoutingError("Name and action must be strings")
        matchers = g.get("matchers")
        if not isinstance(matchers, list) or len(matchers) > MAX_MATCHERS:
            raise RoutingError("Invalid condition list")
        if any(not isinstance(m, dict) or set(m) != {"type", "value"} or
               not all(isinstance(v, str) for v in m.values()) or len(m["value"]) > 4096 for m in matchers):
            raise RoutingError("Invalid condition structure")
        old = known.get(g["id"])
        if old and not old["editable"]:
            if any(g[k] != old[k] for k in ("title", "action", "matchers")):
                raise RoutingError("Unsupported rules cannot be edited")
            result.append(copy.deepcopy(old))
            continue
        item = copy.deepcopy(old) if old else {"id": g["id"], "rule": {"type": "field", "inboundTag": INBOUND_TAGS}, "editable": True, "default_rule": False}
        item.update(title=g["title"].replace("\r", " ").replace("\n", " ")[:120],
                    action=g["action"], matchers=copy.deepcopy(matchers))
        result.append(item)
    if any(g["default_rule"] and g["id"] not in seen for g in base["groups"]):
        raise RoutingError("The default rule can be edited, but cannot be deleted")
    protected = [g for g in base["groups"] if not g["editable"]]
    for old in protected:
        if old["id"] not in seen: raise RoutingError("Unsupported rules cannot be deleted")
        if not old["editable"] and next(i for i,g in enumerate(result) if g["id"] == old["id"]) != base["groups"].index(old):
            raise RoutingError("Unsupported rules cannot be reordered")
    return refresh_model({**copy.deepcopy(base), "groups": result})

def validate(model):
    model = refresh_model(model)
    errors = [{"severity": "error", "message": s} for s in model.get("issues", [])]
    groups = model["groups"]
    if not any(is_catch_all(g) for g in groups):
        errors.append({"severity": "warning", "message": "No rule covers the remaining redirect/tproxy traffic. Its route depends on the rest of the Xray configuration."})
    for index, g in enumerate(groups):
        if not g["editable"]: continue
        def issue(message, severity="error", field=None):
            errors.append({"severity": severity, "group_id": g["id"], "field": field, "message": message})
        if g["action"] not in ACTIONS: issue("Unknown action")
        if not g["title"].strip(): issue("Enter a name")
        if is_catch_all(g) and index < len(groups) - 1:
            issue(f"Rule “{g['title']}” has no conditions and matches all redirect/tproxy traffic reaching it. Rules below it will not apply to that traffic.", "warning")
        seen, scalars = set(), set()
        for m in g["matchers"]:
            kind, value = m["type"], m["value"]
            if kind not in FIELDS:
                issue("Unknown condition type", field=kind); continue
            if not value.strip(): issue("Value cannot be empty", field=kind); continue
            key = (kind, value)
            if key in seen: issue("Duplicate condition", "warning", kind)
            seen.add(key)
            if kind in ("network", "port"):
                if kind in scalars: issue("Only one field is allowed for network and port", field=kind)
                scalars.add(kind)
            if kind in ("ip", "source"):
                try: ipaddress.ip_network(value.strip(), strict=False)
                except ValueError: issue("Invalid IP address or CIDR", field=kind)
            elif kind == "port":
                for token in value.split(","):
                    if not re.fullmatch(r"[0-9]+(?:-[0-9]+)?", token.strip()):
                        issue("Invalid port or range", field=kind); break
                    bounds = [int(s) for s in token.strip().split("-")]
                    if any(not 1 <= n <= 65535 for n in bounds) or bounds[0] > bounds[-1]:
                        issue("Ports must be between 1 and 65535; range start must not exceed its end", field=kind); break
            elif kind == "network" and value not in ("tcp", "udp", "tcp,udp"):
                issue("Choose tcp, udp or tcp,udp", field=kind)
            elif kind == "protocol" and value not in ("http", "tls", "quic", "bittorrent"):
                issue("Unknown protocol", field=kind)
            elif kind in ("domain-geosite", "ip-geoip"):
                prefix = "geosite" if kind == "domain-geosite" else "geoip"
                if not re.fullmatch(r"(?:" + prefix + r":[^\s:]+|ext:[A-Za-z0-9_.-]+:[^\s:]+)", value):
                    issue("Use geosite:/geoip: or ext:file.dat:tag", field=kind)
            elif kind in ("domain-exact", "domain-suffix") and (any(c.isspace() for c in value) or any(c in value for c in "/:*")):
                issue("Enter a hostname without a URL, path or prefix", field=kind)
    return errors

def rule_for(g):
    if not g["editable"]: return copy.deepcopy(g["rule"])
    rule = {k: copy.deepcopy(v) for k,v in g["rule"].items() if k not in FIELDS.values()}
    rule["outboundTag"] = ACTIONS[g["action"]]
    for m in g["matchers"]:
        kind, value = m["type"], m["value"]
        field = FIELDS[kind]
        value = PREFIXES.get(kind, "") + value
        if field in ("port", "network"):
            if field in rule: raise RoutingError("Duplicate scalar field")
            rule[field] = value
        else: rule.setdefault(field, []).append(value)
    return rule

def generate(model):
    invalid = [e for e in validate(model) if e["severity"] == "error"]
    if invalid: raise RoutingError("Fix the rule errors", 422, "validation", invalid)
    doc = copy.deepcopy(model["document"])
    doc["routing"]["rules"] = [rule_for(g) for g in model["groups"]]
    text = json.dumps(doc, ensure_ascii=False, indent=2)
    # Locate rule spans in a valid generated tree using JSONDecoder, not regex on user data.
    clean = text
    decoder = json.JSONDecoder()
    inserts = []
    def walk(pos, path):
        while clean[pos].isspace(): pos += 1
        if path[:2] == ["routing", "rules"] and len(path) == 3:
            title = model["groups"][path[2]]["title"].replace("\n", " ").replace("\r", " ")[:120]
            inserts.append((pos, "// " + title + "\n      "))
        if clean[pos] == "{":
            pos += 1
            while True:
                while clean[pos].isspace() or clean[pos] == ",": pos += 1
                if clean[pos] == "}": return pos+1
                k,pos = decoder.raw_decode(clean,pos)
                while clean[pos].isspace() or clean[pos] == ":": pos += 1
                pos = walk(pos,path+[k])
        if clean[pos] == "[":
            pos += 1; index=0
            while True:
                while clean[pos].isspace() or clean[pos] == ",": pos += 1
                if clean[pos] == "]": return pos+1
                pos=walk(pos,path+[index]); index+=1
        return decoder.raw_decode(clean,pos)[1]
    walk(0,[])
    for pos,comment in reversed(inserts): text=text[:pos]+comment+text[pos:]
    raw = (text+"\n").encode("utf-8")
    if len(raw) > MAX_CONFIG_BYTES: raise RoutingError("Routing configuration exceeds 1 MiB")
    return raw

def diff(base, target):
    old = {g["id"]: (i,g) for i,g in enumerate(base["groups"])}
    new = {g["id"]: (i,g) for i,g in enumerate(target["groups"])}
    changes = []
    for gid in dict.fromkeys([*old,*new]):
        bi,b = old.get(gid,(None,None)); ti,t = new.get(gid,(None,None))
        changed = [k for k in ("title","action","matchers") if b and t and b[k] != t[k]]
        if b is None or t is None or changed or bi != ti:
            # A pure reorder is reported as "moved", not as an edit of the rule (U30).
            kind = "added" if b is None else "removed" if t is None else "edited" if changed else "moved"
            changes.append({"id": gid, "kind": kind,
                            "before": b, "after": t, "old_position": None if bi is None else bi+1,
                            "new_position": None if ti is None else ti+1, "fields": changed, "moved": b is not None and t is not None and bi != ti})
    return changes
