"""Own the synthetic backend and supervise the native frontend together."""
import argparse
import os
import signal
import subprocess

from tests.ui_support.server import fixture_server

POLL_SECONDS = 0.1
STOP_TIMEOUT_SECONDS = 5

def run_frontend(instance):
    if not instance.thread.is_alive():
        raise RuntimeError("Synthetic backend stopped")
    # A separate group lets cleanup include npm's Rspack descendants.
    frontend = subprocess.Popen(["npm", "--prefix", "frontend", "run", "dev"], start_new_session=True)
    try:
        while instance.thread.is_alive():
            try:
                return frontend.wait(timeout=POLL_SECONDS)
            except subprocess.TimeoutExpired:
                pass
        raise RuntimeError("Synthetic backend stopped")
    finally:
        try:
            os.killpg(frontend.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            frontend.wait(timeout=STOP_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(frontend.pid, signal.SIGKILL)
            frontend.wait()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    def stop(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Binding fails before npm starts. No HTTP health check can accidentally
    # accept an unrelated process already listening on the requested port.
    with fixture_server(port=args.port) as instance:
        print(f"Synthetic backend: {instance.url}", flush=True)
        return run_frontend(instance)

if __name__ == "__main__":
    raise SystemExit(main())
