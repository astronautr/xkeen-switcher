"""Shared test helpers: server fixture, clients, fakes."""
import hashlib
import json
from pathlib import Path
import http.cookiejar
import threading
import urllib.request
import urllib.error

from xk_switcher.auth import Auth
from xk_switcher.router import Router
from xk_switcher.service import Service
from xk_switcher.static_assets import MIME_TYPES
from xk_switcher.web import build_server


TEST_PASSWORD = "home-test-password"

def write_ui_dist(directory):
    """Write a complete test build so HTTP and subprocess tests run without Node."""
    shared = Path(__file__).resolve().parents[1] / "src" / "xk_switcher" / "static"
    filenames = ("theme-boot.js", "icon-light.svg", "icon-dark.svg", "mobile-icons.svg",
                 "apple-touch-icon.png", "manifest.webmanifest")
    files = {name: (shared / name).read_bytes() for name in filenames}
    for entry, html in (("app", "index.html"), ("catalog", "catalog.html")):
        bundles = {}
        for extension, data in (("js", f"console.log('{entry}')".encode()), ("css", f".{entry} {{ display: block }}".encode())):
            digest = hashlib.sha256(data).hexdigest()[:16]
            name = f"ui-assets/{entry}.{digest}.{extension}"
            files[name] = data
            bundles[extension] = "/" + name
        files[html] = (f'<!DOCTYPE html><html><head><script src="/theme-boot.js"></script>'
                       f'<link rel="manifest" href="/manifest.webmanifest">'
                       f'<link rel="stylesheet" href="{bundles["css"]}"></head>'
                       f'<body><div id="{entry}"></div><script src="{bundles["js"]}"></script></body></html>').encode()
    records = {}
    for name, data in files.items():
        dest = directory / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        records["/" + name] = {"file": name, "mime": MIME_TYPES[dest.suffix],
                               "sha256": hashlib.sha256(data).hexdigest()}
    manifest = {"version": 1, "entries": {"app": "/index.html", "catalog": "/catalog.html"}, "assets": records}
    (directory / "asset-manifest.json").write_text(json.dumps(manifest))
    return directory

def mark_server_for_route_checks(service):
    """Explicitly model a server following Main in combined-health tests."""
    from xk_switcher.devices_mock import MockDevicesGateway
    service.devices.gateway = MockDevicesGateway(service.state.data_dir)
    settings = service.device_routing_settings
    health = service.state.read_health()  # Seeded evidence in these tests belongs to this host.
    settings.set_server({"revision": settings.read()["revision"], "id": "02:00:00:00:00:10"})
    service.state.write_health(health)

class _Resp:
    def __init__(self, status_code: int, body: bytes, headers: dict):
        self.status_code = status_code
        self._body = body
        self.headers = headers

    def json(self):
        return json.loads(self._body.decode("utf-8"))

    @property
    def text(self):
        return self._body.decode("utf-8")


class _Client:
    def __init__(self, base_url: str):
        self.base_url = base_url
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def _req(self, method, path, body=None, headers=None):
        url = self.base_url + path
        data = None
        hdr = {"Content-Type": "application/json", "X-XK-Request": "1"} if method != "GET" else {}
        if headers:
            hdr.update(headers)
        if method != "GET":
            data = json.dumps(body if body is not None else {}).encode("utf-8")
        req = urllib.request.Request(url, method=method, data=data, headers=hdr)
        try:
            with self.opener.open(req, timeout=5) as r:
                return _Resp(r.status, r.read(), r.headers)
        except urllib.error.HTTPError as e:
            return _Resp(e.code, e.read(), e.headers)

    def get(self, path, **kw):
        return self._req("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self._req("POST", path, body=body, **kw)

    def put(self, path, body=None, **kw):
        return self._req("PUT", path, body=body, **kw)


def make_test_server(state, router=None, *, authenticated=True, auth=None):
    """Launch server on a random localhost port, return (httpd, client)."""
    router = router or Router(host="mock")
    from .test_service import _subscription_bytes
    from xk_switcher.subscription import Location
    service = Service(state=state, router=router, fetch_fn=lambda url: _subscription_bytes([
        Location(**loc) for loc in state.read_subscription().get("locations", [])
    ]))
    auth = auth or Auth(state.data_dir)
    if authenticated and not auth.session("")["configured"]:
        auth.set_password(TEST_PASSWORD)
    httpd = build_server(service, host="127.0.0.1", port=0, auth=auth)
    httpd.auth = auth
    httpd.service = service
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    client = _Client(f"http://127.0.0.1:{port}")
    if authenticated:
        assert client.post("/api/auth/login", {"password": TEST_PASSWORD}).status_code == 200
    return httpd, client
