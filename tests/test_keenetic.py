"""Real HTTP challenge/cookie handling and RCI error boundaries."""
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import pytest
from xk_switcher.keenetic import KeeneticClient, KeeneticError

@pytest.fixture
def router_http():
    state = {"logins": 0, "writes": 0, "reject": False, "expire": False}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, code, value=None, headers=None):
            self.send_response(code)
            for key, val in (headers or {}).items(): self.send_header(key, val)
            self.end_headers()
            if value is not None: self.wfile.write(json.dumps(value).encode())
        def do_GET(self):
            if self.path == "/auth":
                return self.reply(401, headers={"X-NDM-Realm": "test", "X-NDM-Challenge": "challenge"})
            if self.headers.get("Cookie") != "session=ok" or state["expire"]:
                state["expire"] = False
                return self.reply(401)
            return self.reply(200, {"ok": True})
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/auth":
                digest = hashlib.md5("admin:test:private-test-password".encode()).hexdigest()
                expected = hashlib.sha256(("challenge" + digest).encode()).hexdigest()
                if body != {"login": "admin", "password": expected}: return self.reply(403)
                state["logins"] += 1
                return self.reply(200, headers={"Set-Cookie": "session=ok; Path=/"})
            if self.headers.get("Cookie") != "session=ok": return self.reply(401)
            state["writes"] += 1
            return self.reply(200, {"status": [{"status": "error" if state["reject"] else "message"}]})
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield state, f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()

def test_auth_reuses_cookies_and_reauthenticates_expired_session(router_http):
    state, url = router_http
    client = KeeneticClient(url, "admin", "private-test-password")
    assert client.rci("show/ip/hotspot") == {"ok": True}
    client.rci("known/host", {"mac": "02:00:00:00:00:01", "name": "Example"})
    assert state["logins"] == 1
    state["expire"] = True
    client.rci("show/ip/hotspot")
    assert state["logins"] == 2
    assert state["writes"] == 1

def test_rcis_http_200_errors_are_failures_not_success_or_retried(router_http):
    state, url = router_http
    state["reject"] = True
    client = KeeneticClient(url, "admin", "private-test-password")
    with pytest.raises(KeeneticError, match="rejected"):
        client.rci("known/host", {"name": "Example"})
    assert state["writes"] == 1

def test_wrong_credentials_do_not_sign_the_app_out_or_echo_secrets(router_http):
    _, url = router_http
    client = KeeneticClient(url, "admin", "wrong-secret")
    with pytest.raises(KeeneticError) as error:
        client.rci("show/ip/hotspot")
    assert error.value.status == 503
    assert "wrong-secret" not in str(error.value)

@pytest.mark.parametrize("url", ["ftp://router", "http://admin:secret@router", "http://router/rci", "http://router?x=1"])
def test_api_origin_validation(url):
    with pytest.raises(ValueError): KeeneticClient(url, "admin", "password")
