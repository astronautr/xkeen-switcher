"""Validated build manifest; compiled output is never a filesystem route."""
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path

MIME_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
              ".webmanifest": "application/manifest+json"}
SHARED_ROUTES = {"/theme-boot.js", "/icon-light.svg", "/icon-dark.svg", "/mobile-icons.svg",
                 "/apple-touch-icon.png", "/manifest.webmanifest"}
ENTRY_ROUTES = {"/index.html": "/", "/catalog.html": "/styleguide.html"}
HASHED_NAME = re.compile(r"\.([0-9a-f]{16,64})\.(?:js|css|svg|png)$")

def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate manifest key")
        result[key] = value
    return result

def _safe_relative(value):
    return (isinstance(value, str) and bool(value) and not value.startswith("/")
            and not any(char in value for char in ("\\", "\0", "%", "?", "#"))
            and all(part not in ("", ".", "..") for part in value.split("/")))

class _EntryParser(HTMLParser):
    def __init__(self, resources):
        super().__init__()
        self.resources = resources

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and "src" in attrs:
            url = attrs["src"]
        elif tag == "link" and {"stylesheet", "icon", "apple-touch-icon", "manifest"}.intersection(
            (attrs.get("rel") or "").lower().split()
        ):
            url = attrs.get("href")
        else:
            return
        if url not in self.resources:
            raise ValueError(f"Unlisted compiled UI subresource: {url!r}")

class StaticAssets:
    def __init__(self, directory):
        self.root = Path(directory).resolve()
        try:
            manifest_file = (self.root / "asset-manifest.json").resolve()
            if not manifest_file.is_relative_to(self.root):
                raise ValueError("Unsafe asset manifest")
            manifest = json.loads(manifest_file.read_text(), object_pairs_hook=_unique_object)
            if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1:
                raise ValueError("Invalid asset manifest version")
            files = manifest["assets"]
            if manifest["entries"] != {"app": "/index.html", "catalog": "/catalog.html"} or not isinstance(files, dict):
                raise ValueError("Invalid asset manifest entries")
            required = SHARED_ROUTES | ENTRY_ROUTES.keys()
            if not required <= files.keys():
                raise ValueError("Missing compiled entry or shared asset")
            self.routes = {}
            for url, record in files.items():
                if not isinstance(url, str) or not url.startswith("/") or not _safe_relative(url[1:]):
                    raise ValueError("Invalid public asset URL")
                if url not in required and not url.startswith("/ui-assets/"):
                    raise ValueError("Invalid public asset namespace")
                if not isinstance(record, dict) or set(record) != {"file", "mime", "sha256"}:
                    raise ValueError("Invalid asset record")
                file = record["file"]
                if not _safe_relative(file):
                    raise ValueError("Invalid asset file")
                extension = Path(file).suffix
                if extension not in MIME_TYPES or MIME_TYPES[extension] != record["mime"]:
                    raise ValueError("Invalid asset MIME")
                if Path(url).suffix != extension:
                    raise ValueError("Asset URL MIME mismatch")
                if not isinstance(record["sha256"], str) or not re.fullmatch("[0-9a-f]{64}", record["sha256"]):
                    raise ValueError("Invalid asset digest")
                if url.startswith("/ui-assets/"):
                    name_hash = HASHED_NAME.search(Path(url).name)
                    if not name_hash or not record["sha256"].startswith(name_hash[1]):
                        raise ValueError("Asset URL is missing its content hash")
                route = ENTRY_ROUTES.get(url, url)
                self.routes[route] = record
                asset = self.read(route)
                if asset is None:
                    raise ValueError("Missing, changed or unsafe compiled asset")
                if url in ENTRY_ROUTES:
                    parser = _EntryParser(files.keys() - ENTRY_ROUTES.keys())
                    parser.feed(asset[0].decode("utf-8"))
                    parser.close()
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError("Could not load compiled UI manifest") from exc

    def read(self, url):
        record = self.routes.get(url)
        if record is None:
            return None
        try:
            path = (self.root / record["file"]).resolve()
            if not path.is_relative_to(self.root) or not path.is_file():
                return None
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != record["sha256"]:
                return None
        except OSError:
            return None
        cache = "public, max-age=31536000, immutable" if url.startswith("/ui-assets/") else "no-cache"
        return data, record["mime"], cache
