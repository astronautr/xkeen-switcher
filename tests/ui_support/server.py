"""Temporary, synthetic HTTP backend for UI acceptance; never imports app.main.

Run with .venv/bin/python -m tests.ui_support.server. LAN access requires an
explicit --lan-bind address. No environment configuration or real credentials.
"""
import argparse
from contextlib import contextmanager, ExitStack
from dataclasses import dataclass
from datetime import datetime
import json
import os
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch
from xk_switcher.auth import Auth
from xk_switcher.config import Config
from xk_switcher.devices_mock import MockDevicesGateway
from xk_switcher.router import MOCK_ROUTING, Router
from xk_switcher.service import Service
from xk_switcher.state import State
from xk_switcher.web import build_server

FIXED_TIME = "2026-11-17T08:55:00+00:00"
PASSWORD = "synthetic-ui-password"

def subscription_bytes():
    return json.dumps([{
        "remarks": name,
        "outbounds": [{"tag": "proxy", "protocol": "vless", "settings": {"vnext": [{
            "address": code + ".example.invalid", "port": 443,
            "users": [{"id": "11111111-1111-4111-8111-111111111111", "encryption": "none"}],
        }]}, "streamSettings": {"network": "tcp", "security": "reality", "realitySettings": {
            "serverName": "example.invalid", "publicKey": "synthetic", "shortId": "abcd",
        }}}],
    } for code, name in [("fi", "Finland 🇫🇮"), ("de", "Germany 🇩🇪"), ("se", "Sweden 🇸🇪")]]).encode()

def config_for(path, host, port):
    return Config(router_host="mock", router_user="synthetic", router_port=22,
        ssh_key="", known_hosts="", ssh_password=None,
        subscription_url="https://subscription.example.invalid/fixture", data_dir=path,
        listen_host=host, listen_port=port, subscription_update_interval_sec=3600,
        log_level="WARNING", failover_check_interval_sec=300, failover_fail_threshold=3,
        failover_grace_after_switch_sec=60, failover_dampening_ticks=3,
        failover_tcp_timeout_sec=3, xkeen_policy_ids=("policy:Policy0",))

class FixtureHTTPServer(ThreadingHTTPServer):
    # Browser interception releases parallel assets in bursts. This is fixture
    # transport capacity, not a change to the production server or its handler.
    request_queue_size = 128

@dataclass
class FixtureServer:
    server: object
    service: Service
    auth: Auth
    thread: threading.Thread

    @property
    def url(self):
        host, port = self.server.server_address
        return f"http://{host}:{port}"

@contextmanager
def fixture_server(*, port=0, lan_bind=None, configured=False, ui_dist=None, routing_bytes=MOCK_ROUTING):
    if ui_dist is None:
        ui_dist = Path(os.environ.get("XK_UI_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
    with tempfile.TemporaryDirectory(prefix="xkeen-ui-") as directory, ExitStack() as stack:
        # These seams cover manual checks and post-commit diagnostics too. Do not
        # rely on Router('mock') to suppress subscription/TCP/HTTP network access.
        stack.enter_context(patch("xk_switcher.failover.FailoverLoop._tcp_probe", return_value=(True, 24)))
        stack.enter_context(patch("xk_switcher.connectivity._check_target", side_effect=lambda name, url, timeout: {
            "name": name, "url": url, "ok": True, "status": 204, "latency_ms": 24, "error": None,
        }))
        cfg = config_for(Path(directory), lan_bind or "127.0.0.1", port)
        state = State(cfg.data_dir)
        state.init({"subscription_url": cfg.subscription_url})
        from dataclasses import asdict
        from xk_switcher.subscription import parse_locations
        locations = [asdict(item) for item in parse_locations(subscription_bytes().decode())]
        state.write_subscription({"fetched_at": FIXED_TIME, "locations": locations})
        state.write_state({"active_code": "fi", "active_status": "ok", "xkeen_state": "running",
            "last_update_at": FIXED_TIME, "last_update_status": "ok"})
        state.write_connectivity({"schema_version": 1, "check_urls": ["https://video.example.invalid/health", "https://shop.example.invalid/health"]})
        router = Router("mock")
        router._mock_routing = routing_bytes
        service = Service(state, router, fetch_fn=lambda _: subscription_bytes(), config=cfg)
        service.router_updates.clock = lambda: datetime.fromisoformat(FIXED_TIME)
        router.mock_update_time = lambda: service.router_updates.clock().timestamp()
        service.devices.gateway = MockDevicesGateway(cfg.data_dir)
        auth = Auth(cfg.data_dir)
        if configured:
            auth.set_password(PASSWORD)
        with patch("xk_switcher.web.ThreadingHTTPServer", FixtureHTTPServer):
            httpd = build_server(service, host=cfg.listen_host, port=port, auth=auth,
                                 ui_dist=ui_dist)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield FixtureServer(httpd, service, auth, thread)
        finally:
            service.router_updates.stop()
            service.routing.stop()
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan-bind", default=None)
    parser.add_argument("--configured", action="store_true")
    parser.add_argument("--ui-dist", type=Path, default=None)
    args = parser.parse_args()
    # The browser smoke downloads and restores a commented file with Windows line endings.
    with fixture_server(**vars(args), routing_bytes=MOCK_ROUTING.replace(b"\n", b"\r\n")) as instance:
        print(instance.url, flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass

if __name__ == "__main__":
    main()
