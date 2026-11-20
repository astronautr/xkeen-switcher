import json
from xk_switcher.state import State, HISTORY_CAP

def test_init_creates_state_without_legacy_token(tmp_data_dir):
    s = State(tmp_data_dir)
    initial = s.init({"subscription_url": "https://x"})
    assert "token" not in initial
    assert initial["subscription_url"] == "https://x"
    assert initial["active_code"] is None

def test_init_preserves_existing_state(tmp_data_dir):
    s = State(tmp_data_dir)
    s.init({"subscription_url": "https://a"})
    preserved = s.init({"subscription_url": "https://b"})
    assert preserved["subscription_url"] == "https://a"

def test_write_state_merges_patch(tmp_data_dir):
    s = State(tmp_data_dir)
    s.init({})
    s.write_state({"active_code": "fi"})
    got = s.read_state()
    assert got["active_code"] == "fi"
    assert "token" not in got

def test_subscription_round_trip(tmp_data_dir):
    s = State(tmp_data_dir)
    data = {"fetched_at": "2026-04-18T00:00:00Z", "locations": [{"code": "fi"}]}
    s.write_subscription(data)
    assert s.read_subscription() == data

def test_empty_subscription_defaults(tmp_data_dir):
    s = State(tmp_data_dir)
    assert s.read_subscription() == {"fetched_at": None, "locations": []}

def test_history_append_and_read(tmp_data_dir):
    s = State(tmp_data_dir)
    s.append_history({"ts": "1", "action": "switch", "code": "fi"})
    s.append_history({"ts": "2", "action": "switch", "code": "de"})
    entries = s.read_history()
    assert [e["code"] for e in entries] == ["fi", "de"]

def test_history_rotates_at_cap(tmp_data_dir):
    s = State(tmp_data_dir)
    for i in range(HISTORY_CAP + 2):
        s.append_history({"ts": str(i), "action": "switch"})
    rotated = tmp_data_dir / "history.jsonl.1"
    assert rotated.exists()

def test_read_history_limit(tmp_data_dir):
    s = State(tmp_data_dir)
    for i in range(20):
        s.append_history({"ts": str(i)})
    got = s.read_history(limit=5)
    assert [e["ts"] for e in got] == [str(i) for i in range(15, 20)]

def test_event_identity_survives_restart_and_keeps_duplicate_events(tmp_data_dir):
    state = State(tmp_data_dir)
    event = {"ts": "2026-11-17T12:00:00Z", "action": "update", "result": "ok"}
    state.append_history(event)
    state.append_history(event)
    events = state.read_events()
    assert events[0]["event_id"] != events[1]["event_id"]
    assert State(tmp_data_dir).read_events() == events
    assert "event_id" not in event

def test_event_feed_preserves_append_order_with_backwards_clock(tmp_data_dir):
    state = State(tmp_data_dir)
    state.append_history({"ts": "2026-11-17T12:00:00Z", "action": "update"})
    state.append_history({"ts": "2026-11-17T11:00:00Z", "action": "switch"})
    assert [event["action"] for event in state.read_events()] == ["update", "switch"]

def test_legacy_history_event_identity_is_stable_across_rotation(tmp_data_dir):
    state = State(tmp_data_dir)
    line = json.dumps({"ts": "2026-11-17T12:00:00Z", "action": "update"}) + "\n"
    (tmp_data_dir / "history.jsonl").write_text(line, encoding="utf-8")
    ident = state.read_events()[0]["event_id"]
    for i in range(HISTORY_CAP):
        state.append_history({"ts": str(i), "action": "switch"})
    assert state.read_events()[0]["event_id"] == ident

def test_event_capture_only_collects_current_request_thread(tmp_data_dir):
    import threading
    state = State(tmp_data_dir)
    with state.capture_events() as captured:
        state.append_history({"action": "update", "result": "ok"})
        worker = threading.Thread(target=lambda: state.append_history({"action": "update", "result": "ok"}))
        worker.start()
        worker.join(1)
        assert not worker.is_alive()
    events = state.read_events()
    assert captured == [events[0]["event_id"]]
    state.append_history({"action": "update", "result": "ok"})
    assert captured == [events[0]["event_id"]]

def test_corrupt_state_falls_back_to_defaults(tmp_data_dir):
    s = State(tmp_data_dir)
    (tmp_data_dir / "state.json").write_text("not-json")
    got = s.read_state()
    assert got["active_code"] is None


def test_read_failover_returns_defaults_when_missing(tmp_path):
    state = State(tmp_path)
    fo = state.read_failover()
    assert fo == {
        "schema_version": 1,
        "enabled": False,
        "auto_failback": False,
        "auto_stop_on_total_failure": False,
        "auto_restart_on_recovery": False,
        "whitelist": [],
    }


def test_read_failover_returns_defaults_when_corrupt(tmp_path):
    state = State(tmp_path)
    (tmp_path / "failover.json").write_text("{not json", encoding="utf-8")
    fo = state.read_failover()
    assert fo["enabled"] is False
    assert fo["whitelist"] == []


def test_write_failover_roundtrip(tmp_path):
    state = State(tmp_path)
    payload = {
        "schema_version": 1,
        "enabled": True,
        "auto_failback": True,
        "auto_stop_on_total_failure": False,
        "auto_restart_on_recovery": False,
        "whitelist": ["de1", "ru2"],
    }
    state.write_failover(payload)
    assert state.read_failover() == payload


def test_read_health_returns_defaults_when_missing(tmp_path):
    state = State(tmp_path)
    h = state.read_health()
    assert h == {
        "schema_version": 1,
        "updated_at": None,
        "next_probe_at": None,
        "map": {},
    }


def test_write_health_roundtrip(tmp_path):
    state = State(tmp_path)
    payload = {
        "schema_version": 1,
        "updated_at": "2026-04-19T06:45:12+00:00",
        "next_probe_at": "2026-04-19T06:50:12+00:00",
        "map": {
            "de1": {
                "ok": True, "fail_streak": 0, "ok_streak": 7,
                "last_ok_at": "2026-04-19T06:45:10+00:00",
                "last_fail_at": None, "last_latency_ms": 87,
                "probe_method": "socks",
            },
        },
    }
    state.write_health(payload)
    assert state.read_health() == payload


def test_read_connectivity_returns_default_check_urls(tmp_path):
    state = State(tmp_path)

    cfg = state.read_connectivity()

    assert cfg == {
        "schema_version": 1,
        "check_urls": [
            "https://www.youtube.com/generate_204",
            "https://www.avito.ru/",
        ],
    }


def test_write_connectivity_roundtrip(tmp_path):
    state = State(tmp_path)
    payload = {
        "schema_version": 1,
        "check_urls": ["https://example.com/health"],
    }

    state.write_connectivity(payload)

    assert state.read_connectivity() == payload


def test_state_init_adds_failover_fields(tmp_path):
    state = State(tmp_path)
    initial = state.init({})
    assert initial["xkeen_state"] == "unknown"
    assert initial["xkeen_stop_cause"] is None
    assert initial["failover_active"] is False
    assert initial["failover_since"] is None
    assert initial["last_apply_at"] is None
    assert initial["pending_reapply_code"] is None
    assert initial["pending_reapply_since"] is None


def test_state_read_returns_defaults_for_new_fields(tmp_path):
    state = State(tmp_path)
    # Simulate old state.json without new fields
    (tmp_path / "state.json").write_text(
        '{"active_code": null, "active_status": "ok", "subscription_url": null,'
        ' "token": "", "last_update_at": null, "last_update_status": null}',
        encoding="utf-8",
    )
    st = state.read_state()
    assert st["xkeen_stop_cause"] is None
    assert st["failover_active"] is False
    assert st["failover_since"] is None
    assert st["last_apply_at"] is None
    assert st["pending_reapply_code"] is None
    assert st["pending_reapply_since"] is None


def test_init_removes_legacy_token_without_changing_router_state(tmp_path):
    stored = {"token": "old-secret", "active_code": "fi", "subscription_url": "https://sub.example"}
    (tmp_path / "state.json").write_text(json.dumps(stored))
    state = State(tmp_path)
    state.init({})
    actual = json.loads((tmp_path / "state.json").read_text())
    assert actual == {"active_code": "fi", "subscription_url": "https://sub.example"}

def test_existing_installation_keeps_daily_auto_update_defaults(tmp_path):
    state = State(tmp_path)
    (tmp_path / "state.json").write_text('{"active_code": "fi"}')
    restored = state.init({})
    assert restored["active_code"] == "fi"
    assert restored["auto_update_enabled"] is True
    assert restored["auto_update_mode"] == "daily"
    assert restored["auto_update_daily_time"] == "04:30"
    assert restored["auto_update_interval_minutes"] == 1440
    assert restored["auto_update_sni_daily"] is False


def test_old_state_defaults_to_single_without_migration(tmp_path):
    import json
    from xk_switcher.state import State
    (tmp_path / "state.json").write_text(json.dumps({"active_code": "fi", "pending_reapply_code": "fi"}))
    state = State(tmp_path)
    before = (tmp_path / "state.json").read_bytes()
    assert state.read_state()["active_entry_code"] is None
    assert state.read_state()["pending_reapply_entry_code"] is None
    assert (tmp_path / "state.json").read_bytes() == before
