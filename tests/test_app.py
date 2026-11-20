"""A restart must stop the HTTP loop without deadlocking its signal handler."""
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import subprocess
import sys
import time
import threading
import pytest

@pytest.fixture
def local_connectivity_url():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(204)
            self.end_headers()
        def log_message(self, *args):
            pass
    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/"
        finally:
            server.shutdown()
            worker.join(1)

def test_mock_application_stops_on_sigterm(tmp_path):
    env={**os.environ,"PYTHONPATH":str(Path(__file__).resolve().parents[1]/"src"),
         "ROUTER_HOST":"mock","DATA_DIR":str(tmp_path), "SUB_URL":"",
         "LISTEN_HOST":"127.0.0.1","LISTEN_PORT":"0"}
    output=tmp_path/"app.log"
    with output.open("w") as log:
        process=subprocess.Popen([sys.executable,"-m","xk_switcher.app"],env=env,stdout=log,stderr=log)
        try:
            for _ in range(100):
                if "listening on" in output.read_text():break
                assert process.poll() is None,output.read_text()
                time.sleep(.05)
            assert "listening on" in output.read_text()
            process.terminate()
            assert process.wait(timeout=5)==0
        finally:
            if process.poll() is None:process.kill();process.wait()

def test_app_reconciles_saved_remote_commit_without_browser(tmp_path, monkeypatch, local_connectivity_url):
    from xk_switcher import routing
    from xk_switcher.router import Router
    from xk_switcher.routing_store import RoutingStore
    from xk_switcher.service import Service
    from xk_switcher.state import State
    from .test_routing_service import draft_and_preview
    state = State(tmp_path)
    state.init({})
    state.write_connectivity({"check_urls": [local_connectivity_url]})
    service = Service(state, Router("mock", mock_data_dir=tmp_path))
    _, _, preview = draft_and_preview(service)
    monkeypatch.setattr(service.routing, "_launch", lambda ident: None)
    op = service.routing.apply({"preview_id": preview["id"], "operation_id": routing.new_id()})
    metadata, candidate = service.routing.store.blob("previews", preview["id"])
    service.router.start_routing(op["id"], metadata["base_hash"], metadata["environment"], candidate)
    op.update(phase="unknown", before_snapshot=metadata["base_snapshot"], message="Lost SSH reply")
    service.routing.store.put_operation(op)
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
           "ROUTER_HOST": "mock", "DATA_DIR": str(tmp_path), "SUB_URL": "",
           "LISTEN_HOST": "127.0.0.1", "LISTEN_PORT": "0", "no_proxy": "*", "NO_PROXY": "*"}
    output = tmp_path / "app.log"
    with output.open("w") as log:
        process = subprocess.Popen([sys.executable, "-m", "xk_switcher.app"], env=env, stdout=log, stderr=log)
        try:
            store = RoutingStore(tmp_path)
            for _ in range(100):
                if store.operation(op["id"])["phase"] == "committed":
                    break
                assert process.poll() is None, output.read_text()
                time.sleep(.05)
            assert store.operation(op["id"])["phase"] == "committed", output.read_text()
            assert store.read("draft.json") is None
            process.terminate()
            assert process.wait(timeout=5) == 0
            assert "pending config auto-apply failed" not in output.read_text()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

def test_subscription_refresh_deferred_by_apply_resumes_on_short_poll(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from xk_switcher import app
    from xk_switcher.routing import RoutingError
    monkeypatch.setenv("ROUTER_HOST", "mock")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SUB_URL", "")
    tasks, updates = [], []
    flags = {"busy": True, "race": False, "fetch_failure": False}
    class FakeService:
        def __init__(self, **kwargs):
            self.routing = SimpleNamespace(recover=lambda: None, stop=lambda: None,
                public_operation=lambda: {"phase": "submitted"} if flags["busy"] else None)
            self.route_checks = SimpleNamespace(recover=lambda: None, stop=lambda: None)
            self.router_updates = SimpleNamespace(tick=lambda: None, stop=lambda: None)
        def update(self, **kwargs):
            updates.append(kwargs)
            if flags["race"]:
                raise RoutingError("operation accepted meanwhile", 409, "busy")
            if flags["fetch_failure"]:
                raise RuntimeError("provider unavailable")
        def apply_pending_reapply(self):
            return False
        def probe_xkeen(self):
            pass
        def sync_active_from_router(self):
            pass
    class FakeScheduler:
        def __init__(self, *, task, interval_sec):
            tasks.append(task)
        def start(self):
            pass
    def exercise():
        tasks[0]()  # The hourly refresh overlaps an apply.
        assert updates == []
        flags["busy"] = False
        tasks[1]()  # The 30-second poll resumes it.
        assert len(updates) == 1
        tasks[1]()
        assert len(updates) == 1
        flags["race"] = True
        tasks[0]()
        flags["race"] = False
        tasks[1]()
        assert len(updates) == 3
        flags["fetch_failure"] = True
        tasks[0]()
        tasks[1]()
        assert len(updates) == 4  # A genuine fetch error keeps the normal interval.
    monkeypatch.setattr(app, "Service", FakeService)
    monkeypatch.setattr(app, "FailoverLoop", lambda **kwargs: SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(app, "Scheduler", FakeScheduler)
    monkeypatch.setattr(app, "build_server", lambda *args, **kwargs: SimpleNamespace(serve_forever=exercise))
    monkeypatch.setattr(app.signal, "signal", lambda *args: None)
    app.main()
