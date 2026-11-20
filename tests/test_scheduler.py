from xk_switcher.scheduler import Scheduler


class _FakeStop:
    def __init__(self, waits):
        self.waits = iter(waits)
        self.timeouts = []

    def is_set(self):
        return False

    def wait(self, timeout):
        self.timeouts.append(timeout)
        return next(self.waits)


def test_scheduler_runs_immediately_then_at_fixed_interval():
    calls = []
    scheduler = Scheduler(task=lambda: calls.append("update"), interval_sec=3600)
    scheduler._stop = _FakeStop([False, True])

    scheduler._loop()

    assert calls == ["update", "update"]
    assert scheduler._stop.timeouts == [3600, 3600]


def test_scheduler_can_wait_before_first_run():
    calls = []
    scheduler = Scheduler(
        task=lambda: calls.append("update"), interval_sec=900,
        run_immediately=False,
    )
    scheduler._stop = _FakeStop([False, True])

    scheduler._loop()

    assert calls == ["update"]
    assert scheduler._stop.timeouts == [900, 900]
