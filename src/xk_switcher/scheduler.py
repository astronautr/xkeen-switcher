"""Background fixed-interval task scheduler."""
import logging
import threading
from typing import Callable

log = logging.getLogger(__name__)
DEFAULT_INTERVAL_SEC = 3600


class Scheduler:
    def __init__(self, task: Callable[[], None],
                 interval_sec: int = DEFAULT_INTERVAL_SEC,
                 run_immediately: bool = True):
        if interval_sec <= 0:
            raise ValueError("interval_sec must be positive")
        self.task = task
        self.interval_sec = interval_sec
        self.run_immediately = run_immediately
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="xk-scheduler")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run_task(self) -> None:
        try:
            self.task()
        except Exception:
            log.exception("scheduler task failed")

    def _loop(self) -> None:
        if self.run_immediately and not self._stop.is_set():
            self._run_task()
        while True:
            log.info("scheduler: next run in %d seconds", self.interval_sec)
            if self._stop.wait(timeout=self.interval_sec):
                return
            self._run_task()
