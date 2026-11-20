"""Native development must proxy only the synthetic backend it owns."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]

def wait_for(predicate, process):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        assert process.poll() is None, process.communicate()[1]
        time.sleep(0.05)
    pytest.fail("Native launcher did not reach the expected state")

@pytest.fixture
def launch(tmp_path, monkeypatch):
    started = tmp_path / "frontend-started"
    stopped = tmp_path / "frontend-stopped"
    npm = tmp_path / "npm"
    npm.write_text(f"#!{sys.executable}\n" + """
import os, pathlib, signal, time
def stop(*_):
    pathlib.Path(os.environ["FRONTEND_STOPPED"]).touch()
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
pathlib.Path(os.environ["FRONTEND_STARTED"]).write_text(str(os.getpid()))
if "FRONTEND_EXIT" in os.environ:
    raise SystemExit(int(os.environ["FRONTEND_EXIT"]))
while True:
    time.sleep(0.05)
""")
    npm.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    monkeypatch.setenv("FRONTEND_STARTED", str(started))
    monkeypatch.setenv("FRONTEND_STOPPED", str(stopped))
    processes = []
    def start(port):
        process = subprocess.Popen(["bash", str(ROOT / "scripts/dev-native.sh")],
            cwd=ROOT, env={**os.environ, "UI_PYTHON": sys.executable, "UI_BACKEND_PORT": str(port)},
            start_new_session=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(process)
        return process, started, stopped
    yield start
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=10)

def test_native_launcher_does_not_start_frontend_on_occupied_port(launch):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        process, started, _ = launch(listener.getsockname()[1])
        wait_for(lambda: process.poll() is not None or started.exists(), process)
        assert not started.exists(), "Frontend started despite the backend bind failure"
        _, error = process.communicate(timeout=10)
        assert process.returncode != 0
        # macOS reports "Address already in use"; Linux musl reports "Address in use".
        assert "Errno 48" in error or "Errno 98" in error or "Address already in use" in error
        assert not started.exists()

def test_native_launcher_signal_stops_frontend_and_releases_backend(launch):
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    process, started, stopped = launch(port)
    wait_for(started.exists, process)
    with socket.create_connection(("127.0.0.1", port), timeout=1):
        pass
    process.send_signal(signal.SIGTERM)
    process.communicate(timeout=10)
    assert stopped.exists()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))

def test_native_launcher_backend_exit_stops_frontend(launch):
    from tests.ui_support.dev import run_frontend
    from tests.ui_support.server import fixture_server
    # Exercise the same supervisor against an actual HTTP thread stopping.
    with fixture_server() as instance:
        from threading import Timer
        timer = Timer(0.2, instance.server.shutdown)
        timer.start()
        try:
            with pytest.raises(RuntimeError, match="Synthetic backend stopped"):
                run_frontend(instance)
        finally:
            timer.join()
    assert Path(os.environ["FRONTEND_STOPPED"]).exists()

def test_native_launcher_propagates_frontend_failure(launch, monkeypatch):
    monkeypatch.setenv("FRONTEND_EXIT", "17")
    process, started, _ = launch(0)
    process.communicate(timeout=10)
    assert started.exists()
    assert process.returncode == 17
