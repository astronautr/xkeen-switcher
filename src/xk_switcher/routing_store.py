"""Durable routing snapshots; corruption is an error, never an empty config."""
import json
import os
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from .routing import RoutingError, digest, new_id, valid_id, refresh_model, validate

HISTORY_CAP = 50
TERMINAL = {"committed", "rolled_back", "rejected"}

def now():
    return datetime.now(timezone.utc).isoformat()

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

class RoutingStore:
    def __init__(self, data_dir):
        self.root = Path(data_dir) / "routing"
        self.lock = threading.RLock()

    def path(self, kind, ident):
        if not valid_id(ident): raise RoutingError("Invalid ID", 400)
        return self.root / kind / ident

    def read(self, name, default=None):
        with self.lock:
            try:
                doc = json.loads((self.root / name).read_bytes())
                if name == "draft.json" and "model" in doc:
                    doc["model"] = refresh_model(doc["model"])
                    doc["validation"] = validate(doc["model"])
                return doc
            except FileNotFoundError: return default
            except (ValueError, OSError) as e:
                raise RoutingError("Routing storage is corrupted", 503, "storage") from e

    def write(self, name, doc):
        with self.lock:
            atomic(self.root / name, json.dumps(doc, ensure_ascii=False, allow_nan=False).encode())

    def delete_draft(self, revision):
        with self.lock:
            current = self.read("draft.json")
            if (current or {}).get("revision") != revision:
                raise RoutingError("The draft was changed in another window", 409, "draft_conflict")
            if current:
                (self.root / "draft.json").unlink()
                sync_dir(self.root)

    def save_blob(self, kind, raw, meta, model=None, ident=None):
        ident = ident or new_id()
        dest = self.path(kind, ident)
        meta = {**meta, "id": ident, "sha256": digest(raw), "size": len(raw), "created_at": now(), "model": model}
        with self.lock:
            dest.parent.mkdir(parents=True, exist_ok=True)
            temp = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=dest.parent))
            try:
                atomic(temp / "config.jsonc", raw)
                atomic(temp / "metadata.json", json.dumps(meta, ensure_ascii=False, allow_nan=False).encode())
                if (temp / "config.jsonc").read_bytes() != raw: raise OSError("Backup readback mismatch")
                os.rename(temp, dest)
                sync_dir(dest.parent)
            finally:
                if temp.exists(): shutil.rmtree(temp)
        return meta

    def blob(self, kind, ident):
        path = self.path(kind, ident)
        with self.lock:
            if not path.exists(): raise RoutingError("Version not found", 404, "not_found")
            try:
                meta = json.loads((path / "metadata.json").read_bytes())
                raw = (path / "config.jsonc").read_bytes()
                if digest(raw) != meta["sha256"] or len(raw) != meta["size"]:
                    raise ValueError("Hash mismatch")
            except (ValueError, KeyError, OSError) as e:
                raise RoutingError("The backup is corrupted and cannot be restored", 503, "storage") from e
            if "model" in meta: meta["model"] = refresh_model(meta["model"])
            return meta, raw

    def operations(self):
        with self.lock:
            items = [self.read(f"operations/{p.name}") for p in (self.root / "operations").glob("*.json")]
            return sorted(items, key=lambda op: op["created_at"])

    def operation(self, ident):
        self.path("operations", ident)
        doc = self.read(f"operations/{ident}.json")
        if doc is None: raise RoutingError("Operation not found", 404, "not_found")
        return doc

    def put_operation(self, doc):
        self.path("operations", doc["id"])
        self.write(f"operations/{doc['id']}.json", doc)

    def protected(self):
        ids = set()
        for name in ("original.json", "current.json"):
            doc = self.read(name)
            if doc: ids.add(doc["id"])
        draft = self.read("draft.json")
        if draft: ids.add(draft["base_snapshot"])
        for op in self.operations():
            if op["phase"] not in TERMINAL:
                ids.update(x for x in (op.get("before_snapshot"), op.get("after_snapshot"), op.get("source_snapshot")) if x)
        return ids

    def history(self):
        with self.lock:
            protected = self.protected()
            current = (self.read("current.json") or {}).get("id")
            original = (self.read("original.json") or {}).get("id")
            items = []
            for path in (self.root / "snapshots").glob("*"):
                if not valid_id(path.name): continue
                # Listing does not hide corruption: download/restore rechecks all bytes.
                meta = self.read(f"snapshots/{path.name}/metadata.json")
                if not meta: raise RoutingError("Incomplete backup", 503, "storage")
                items.append({k:v for k,v in meta.items() if k != "model"} | {
                    "original": path.name == original, "current": path.name == current, "protected": path.name in protected})
            return sorted(items, key=lambda d:d["created_at"], reverse=True)

    def prune(self):
        with self.lock:
            ordinary = [m for m in self.history() if not m["protected"]]
            for meta in ordinary[HISTORY_CAP:]: shutil.rmtree(self.path("snapshots", meta["id"]))
            # Only unused previews are expendable; operations retain their immutable input.
            used = {o["preview_id"] for o in self.operations() if o.get("preview_id")}
            previews = sorted((self.root / "previews").glob("*"), key=lambda p:p.stat().st_mtime, reverse=True)
            for path in previews[HISTORY_CAP:]:
                if valid_id(path.name) and path.name not in used: shutil.rmtree(path)
