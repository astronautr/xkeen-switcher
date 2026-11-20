"""Exercise the independent Entware helper on a temporary host, without SSH."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import time
import uuid
import pytest

HELPER = Path(__file__).resolve().parents[1] / "router/xk-update.py"

def ident():
    return str(uuid.uuid4())

def executable(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(0o755)

def xray(version):
    return f'#!/bin/sh\ncase "$1" in version) echo "Xray {version} (fixture)" ;; run) test ! -e "$XK_UPDATE_OPT/reject-{version}" ;; esac\n'.encode()

@pytest.fixture
def fixture(tmp_path, monkeypatch):
    monkeypatch.setenv("XK_UPDATE_OPT", str(tmp_path))
    # Exercise the real detached CLI/worker/recovery chain on a fast clock.
    # Its subprocesses load this disposable copy, with only polling times changed.
    helper = tmp_path / "xk-update-fixture.py"
    source = HELPER.read_text()
    for key, value in (("VERIFY_WINDOW_SEC", "1.0"), ("VERIFY_INTERVAL_SEC", "0.04")):
        source, count = re.subn(rf"^{key} = [0-9.]+$", f"{key} = {value}", source, flags=re.M)
        assert count == 1
    helper.write_text(source)
    monkeypatch.setattr(sys.modules[__name__], "HELPER", helper)
    spec = importlib.util.spec_from_file_location("xk_update", HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    executable(tmp_path / mod.XRAY, xray("26.3.27"))
    executable(tmp_path / mod.INIT, b'#!/bin/sh\ncase "$1" in status) echo running ;; restart) test ! -f "$XK_UPDATE_OPT/bad-start" ;; esac\n')
    (tmp_path / mod.INFO).parent.mkdir(parents=True)
    (tmp_path / mod.INFO).write_text('xkeen_current_version="2.0"\n')
    return mod

def cli(*args, data=b"", check=True):
    result = subprocess.run([sys.executable, str(HELPER), *args], input=data, capture_output=True, timeout=20)
    if check:
        assert result.returncode == 0, result.stderr.decode()
        return json.loads(result.stdout) if result.stdout else None
    return result

def settle(op, phases=("installed", "rolled_back", "rolled_back_start_failed", "interrupted", "rejected", "start_failed"), timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        record = cli("status", op)
        if record["phase"] in phases:
            return record
        time.sleep(0.15)
    pytest.fail("Detached worker did not reach its deadline")

def install(version, to, op=None):
    op = op or ident()
    data = xray(to)
    cli("install", op, "xray", version, to, hashlib.sha256(data).hexdigest(), data=data)
    return op

def rollback(component, inventory):
    op = ident()
    part = inventory["components"][component]
    cli("rollback", op, component, part["installed"], part["rollback_version"], inventory["revision"])
    return op

def test_install_and_local_rollback(fixture):
    op = install("26.3.27", "26.11.9")
    result = settle(op)
    assert result["phase"] == "installed" and result["duration_sec"] >= 1
    # Replay, including lost response. The worker must not start a second time.
    assert install("26.3.27", "26.11.9", op) == op
    inv = cli("inventory")
    assert inv["components"]["xray"]["installed"] == "26.11.9"
    assert inv["components"]["xray"]["rollback_plan"] == [{"component":"xray","from":"26.11.9","to":"26.3.27"}]
    assert settle(rollback("xray", inv))["phase"] == "rolled_back"
    assert cli("inventory")["held"]["xray"] == "26.11.9"
    assert (fixture.OPT / fixture.XRAY).read_bytes() == xray("26.3.27")

def test_restore_conflict_and_verified_files_with_failed_service_start(fixture):
    assert settle(install("26.3.27","26.11.9"))["phase"] == "installed"
    inv = cli("inventory")
    bad = fixture.OPT / "reject-26.3.27"
    bad.touch()
    assert settle(rollback("xray",inv))["phase"] == "rejected"
    assert fixture.version("xray") == "26.11.9"
    bad.unlink()
    service_fail = fixture.OPT / "bad-start"
    service_fail.touch()
    op = rollback("xray", cli("inventory"))
    assert settle(op, timeout=12)["phase"] == "rolled_back_start_failed"
    assert (fixture.OPT / fixture.XRAY).read_bytes() == xray("26.3.27")
    view = cli("inventory")
    assert view["active"] is None
    assert view["held"]["xray"] == "26.11.9"
    assert view["last"]["phase"] == "rolled_back_start_failed"
    assert view["components"]["xray"]["rollback_plan"] == []

def test_service_control_waits_only_for_s05_and_never_kills_proxy_group(fixture):
    mod = fixture
    executable(mod.OPT/mod.INIT, b'''#!/bin/sh
case "$1" in
status) (sleep 2; echo child inheriting stdout) & echo "running";;
restart) (sleep 1; echo child inheriting stderr >&2 && touch "$XK_UPDATE_OPT/service-alive") & sleep 2;;
esac
''')
    assert mod.service_command("status",timeout=1.5)[1].strip() == "running"
    with pytest.raises(mod.Refused, match="timed out"):
        mod.service_command("restart","on",timeout=0.5)
    for _ in range(40):
        if (mod.OPT/"service-alive").exists():
            break
        time.sleep(0.05)
    assert (mod.OPT/"service-alive").exists()

@pytest.mark.parametrize("machine,order,maximum,arch", [
    ("mips","little",2**31-1,"mipsel"),
    ("mips64","big",2**31-1,"mipsbe"),
    ("mips64","big",2**63-1,"mips64be"),
    ("mips64","little",2**63-1,"mips64el"),
    ("aarch64","little",2**63-1,"aarch64"),
])
def test_architecture_uses_entware_abi(fixture,machine,order,maximum,arch):
    assert fixture.architecture(machine,order,maximum) == arch

def test_recover_missing_terminal_record_using_separate_receipt(fixture):
    mod = fixture
    op = install("26.3.27","26.11.9")
    terminal = settle(op)
    (mod.opdir(op)/"record.json").unlink()
    assert cli("status",op) == terminal
    view = cli("inventory")
    assert view["last"] == terminal and view["snapshot_error"]
    assert view["components"]["xray"]["rollback_plan"] == []
    mod.LOCK.symlink_to(mod.opdir(op)/"lock")
    assert cli("status",op)["phase"] == "unknown"
    mod.LOCK.unlink()

def test_tui_recovers_with_unreadable_current_version_using_verified_snapshot(fixture):
    mod = fixture
    op = ident()
    new = xray("26.11.9").replace(b"version) echo", b'version) test ! -e "$XK_UPDATE_OPT/version-error" || exit 1; echo')
    cli("install",op,"xray","26.3.27","26.11.9",hashlib.sha256(new).hexdigest(),data=new)
    assert settle(op)["phase"] == "installed"
    (mod.OPT/"version-error").touch()
    assert mod.version("xray") is None
    dialog = cli("tui",data=b"1\n1\nq\n",check=False)
    assert dialog.returncode == 0 and b"Current version unreadable" in dialog.stdout
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if cli("inventory")["last"]["phase"] == "rolled_back":
            break
        time.sleep(0.04)
    assert cli("inventory")["last"]["phase"] == "rolled_back"

def test_tui_refreshes_after_concurrent_recovery(fixture, monkeypatch, capsys):
    mod = fixture
    cli("inventory")
    op = ident()
    folder = mod.opdir(op)
    folder.mkdir()
    (folder/"lock").mkdir()
    mod.LOCK.symlink_to(folder/"lock")
    mod.publish({"id":op,"component":"xray","action":"install","version":"26.11.9","from":"26.3.27"},"interrupted")
    inputs = iter(("1", "1", "q"))
    monkeypatch.setattr(mod, "ask", lambda _: next(inputs))
    def busy(_):
        raise mod.Busy("Another recovery is running")
    monkeypatch.setattr(mod,"recover_id",busy)
    mod.tui()
    assert "Another recovery is running" in capsys.readouterr().out

def test_busy_or_bad_payload_never_changes_live(fixture):
    cli("inventory")
    fixture.LOCK.mkdir()
    data = xray("26.11.9")
    args = ("install",ident(),"xray","26.3.27","26.11.9","0"*64)
    assert cli(*args,data=data,check=False).returncode == 3
    fixture.LOCK.rmdir()
    assert cli(*args,data=data,check=False).returncode != 0
    assert not (fixture.opdir(args[1]) / "payload").exists()
    assert fixture.version("xray") == "26.3.27"

def test_expired_window_and_unowned_preparing_record(fixture):
    data = xray("26.11.9")
    op = ident()
    result = cli("install",op,"xray","26.3.27","26.11.9",hashlib.sha256(data).hexdigest(),"1",data=data,check=False)
    assert result.returncode and "window closed" in result.stderr.decode()
    assert (fixture.OPT / fixture.XRAY).read_bytes() == xray("26.3.27")
    rec = {"id":op,"action":"install","component":"xray","version":"26.11.9"}
    fixture.publish(rec, "preparing")
    assert cli("status",op)["phase"] == "rejected"

def test_expired_unknown_request_is_refused_before_unrelated_busy(fixture):
    cli("inventory")
    fixture.LOCK.mkdir()
    op = ident()
    result = cli("install", op, "xray", "26.3.27", "26.11.9", "0" * 64, "1", check=False)
    assert result.returncode == 1
    assert result.stderr.strip() == b"xk-update: Scheduled installation window closed"
    assert not fixture.opdir(op).exists()
    assert fixture.LOCK.is_dir()

def test_exact_expiry_preserves_existing_record_and_durable_receipt(fixture, monkeypatch):
    op = ident()
    data = xray("26.11.9")
    expiry = int(time.time()) + 120
    args = ("install", op, "xray", "26.3.27", "26.11.9", hashlib.sha256(data).hexdigest(), str(expiry))
    cli(*args, data=data)
    terminal = settle(op)
    assert terminal["phase"] == "installed"
    monkeypatch.setattr(fixture.time, "time", lambda: expiry)
    assert fixture.launch(*args) == terminal
    (fixture.opdir(op) / "record.json").unlink()
    assert fixture.launch(*args) == terminal
    with pytest.raises(fixture.Refused, match="window closed"):
        fixture.launch(args[0], ident(), *args[2:])

def test_integrity_of_previous_xray_snapshot_after_many_upgrades(fixture):
    first = install("26.3.27","26.8.1")
    assert settle(first)["phase"] == "installed"
    latest = install("26.8.1","26.11.9")
    assert settle(latest)["phase"] == "installed"
    assert not (fixture.opdir(first)/"before").exists()
    assert (fixture.opdir(latest)/"before"/fixture.XRAY).read_bytes() == xray("26.8.1")

def test_boot_preserves_interrupted_owner_for_offline_recovery(fixture):
    mod = fixture
    cli("inventory")
    op = ident()
    folder = mod.opdir(op)
    folder.mkdir()
    (folder/"payload").write_bytes(xray("26.11.9"))
    (folder/"lock").mkdir()
    mod.LOCK.symlink_to(folder/"lock")
    rec = {"id":op,"component":"xray","from":"26.3.27","version":"26.11.9","action":"install","done":0}
    mod.prepare(rec)
    mod.publish(rec, "installing")
    mod.apply_files(rec, False)  # Power cut before the final journal/ledger publication.
    cli("boot")
    assert cli("status",op)["phase"] == "interrupted"
    assert mod.active_id() == op
    dialog = cli("tui", data=b"1\n1\nq\n", check=False)
    assert dialog.returncode == 0
    assert op.encode() in dialog.stdout and b"Use the local snapshot now?" in dialog.stdout
    assert settle(op)["phase"] == "rolled_back"
    assert cli("inventory")["components"]["xray"]["installed"] == "26.3.27"

def test_failed_upgrade_restores_original_running_state(fixture):
    init = fixture.OPT / fixture.INIT
    executable(init, b'''#!/bin/sh
case "$1" in
status) if test -e "$XK_UPDATE_OPT/stopped"; then echo stopped; else echo running; fi;;
restart) if "$XK_UPDATE_OPT/sbin/xray" version | grep -q '26.11.9'; then
             touch "$XK_UPDATE_OPT/stopped"; exit 1
         fi
         rm -f "$XK_UPDATE_OPT/stopped";;
esac
''')
    assert settle(install("26.3.27","26.11.9"), timeout=12)["phase"] == "start_failed"
    assert (fixture.OPT/"stopped").exists()
    op = rollback("xray",cli("inventory"))
    assert settle(op)["phase"] == "rolled_back"
    assert not (fixture.OPT/"stopped").exists()

def test_rollback_preserves_unrelated_entware_package_changes(fixture):
    state = fixture.OPT/fixture.PKG_DB
    state.parent.mkdir(parents=True)
    (fixture.OPT/"tmp").mkdir()
    original = b"Package: xray_s\nVersion: v26.3.27\nStatus: install user installed\n\n"
    other = b"Package: another\nVersion: 2\n\n"
    state.write_bytes(original)
    assert settle(install("26.3.27","26.11.9"))["phase"] == "installed"
    assert b"Version: v26.11.9" in state.read_bytes()
    with state.open("ab") as out:
        out.write(other)
    assert settle(rollback("xray", cli("inventory")))["phase"] == "rolled_back"
    assert state.read_bytes() == original + other

def test_xkeen_transition_only_changes_owned_files_and_cascade_preflights_all(fixture, monkeypatch):
    mod = fixture
    cli("inventory")
    old_init = (mod.OPT / mod.INIT).read_bytes()
    template = mod.OPT / mod.TEMPLATE
    template.parent.mkdir(parents=True)
    template.write_bytes(old_init)
    extra = mod.OPT / mod.MODULES / "custom-local.sh"
    extra.write_text("local customization")
    executable(mod.OPT / mod.XKEEN, b"#!/bin/sh\nexit 0\n")
    for required in ("ip_exclude.lst","port_exclude.lst","port_proxying.lst","xkeen.json"):
        (mod.OPT / "etc/xkeen").mkdir(exist_ok=True)
        (mod.OPT / "etc/xkeen" / required).write_text("preserve")
    # Build a minimal fixture with the same literal package layout. Only this
    # in-process unit invocation accepts its digest; the actual CLI pins upstream.
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload,mode="w:gz") as archive:
        for name, data in (("xkeen", b"#!/bin/sh\n# 2.1\n"),("_xkeen/"+mod.INFO[len(mod.MODULES):], b'xkeen_current_version="2.1"\n'),
                           ("_xkeen/"+mod.TEMPLATE[len(mod.MODULES):], old_init+b"# upgraded\n")):
            m = tarfile.TarInfo(name)
            m.size = len(data)
            m.mode = 0o755
            archive.addfile(m,io.BytesIO(data))
    op = ident()
    folder = mod.opdir(op)
    folder.mkdir()
    data = payload.getvalue()
    (folder/"payload").write_bytes(data)
    monkeypatch.setattr(mod, "XKEEN_DIGEST", hashlib.sha256(data).hexdigest())
    (folder/"lock").mkdir()
    mod.LOCK.symlink_to(folder/"lock")
    rec = {"id":op,"component":"xkeen","from":"2.0","version":"2.1","action":"install","done":0}
    mod.publish(rec, "preparing")
    mod.worker(op, mod.process_lock())
    assert mod.status(op)["phase"] == "installed"
    assert extra.read_text() == "local customization"
    assert settle(install("26.3.27","26.10.1"))["phase"] == "installed"
    assert settle(install("26.10.1","26.11.9"))["phase"] == "installed"
    # Corruption in the last step must not partially restore either Xray.
    before = folder/"before"/mod.XKEEN
    saved = before.read_bytes()
    before.write_bytes(b"corrupt")
    assert settle(rollback("xkeen", cli("inventory")))["phase"] == "rejected"
    assert mod.version("xray") == "26.11.9"
    before.write_bytes(saved)
    assert settle(rollback("xkeen", cli("inventory")))["phase"] == "rolled_back"
    assert mod.version("xkeen") == "2.0"
    assert mod.version("xray") == "26.3.27"
    assert (mod.OPT / "etc/xkeen/xkeen.json").read_text() == "preserve"

@pytest.mark.parametrize("restart_rc,post_status,identity,success", [
    (0, [(1, "stopped"), (0, "running"), (0, "running")], "replaced", True),
    (1, [(1, "stopped"), (0, "running"), (0, "running")], "replaced", True),
    (1, [(0, "running")], "unchanged", False),
    (1, [(0, "running")], "unknown", False),
    (0, [(1, "running")], "replaced", False),
])
def test_restart_checks_stable_new_core_before_finishing(fixture, monkeypatch, restart_rc, post_status, identity, success):
    mod = fixture
    calls = []
    pending = iter(post_status)
    def service(action, *args, **kwargs):
        calls.append(action)
        if action == "restart":
            return restart_rc, "token=SECRET"
        return next(pending, post_status[-1])
    monkeypatch.setattr(mod, "service_command", service)
    previous = frozenset({("1","11")})
    after = {"replaced": frozenset({("2","22")}), "unchanged": previous, "unknown": None}[identity]
    monkeypatch.setattr(mod, "core_processes", lambda _: after if calls else previous, raising=False)
    monkeypatch.setattr(mod, "VERIFY_WINDOW_SEC", 0.2, raising=False)
    monkeypatch.setattr(mod, "VERIFY_INTERVAL_SEC", 0.01, raising=False)
    rec = {"id":ident(), "phase":"installing","running":True}
    mod.opdir(rec["id"]).mkdir(parents=True)
    assert mod.health_after(rec, True) is success
    assert calls.count("restart") == 1
    runtime = rec["runtime"]
    assert runtime["rc"] == restart_rc and runtime["attempts"] >= 2
    assert runtime["last_status"] == ("unknown" if post_status[-1] == (1,"running") else "running")
    assert "SECRET" not in json.dumps(mod.record(rec["id"]))

@pytest.mark.parametrize("reason,ready,expected", [
    ("failed to load config: secret", "stale", False),
    ("Не удалось применить netfilter-хук", "fresh", False),
    ("", "absent", False),
    ("", "fresh", True),
])
def test_ambiguous_restart_requires_new_ready_marker_and_no_firewall_error(fixture, monkeypatch, reason, ready, expected):
    mod = fixture
    executable(mod.OPT / mod.INIT, b'#!/bin/sh\nname_client="xray"\n: > "$xkeen_rundir/ready"\n')
    marker = mod.OPT / "ready"
    marker.write_text("before")
    monkeypatch.setattr(mod, "READY_FILE", marker)
    calls = []
    def command(action, *args, **kwargs):
        calls.append(action)
        if action == "restart":
            if ready == "fresh":
                marker.write_text("new")
                os.utime(marker, (1, 1))
            elif ready == "absent":
                marker.unlink()
            raise mod.ServiceFailure("timeout", reason)
        return 0, "Прокси-клиент xray запущен в режиме Hybrid"
    monkeypatch.setattr(mod, "core_processes", lambda _: frozenset({(1, 10) if not calls else (2, 20)}))
    monkeypatch.setattr(mod, "service_command", command)
    monkeypatch.setattr(mod, "VERIFY_WINDOW_SEC", 0.15)
    rec = {"id":ident(), "phase":"installing"}
    mod.opdir(rec["id"]).mkdir(parents=True)
    assert mod.health_after(rec, True) is expected
    assert rec["runtime"]["control"] == "timeout"
    assert calls.count("restart") == 1
    assert rec["runtime"]["ready"] is (ready == "fresh")

def test_control_diagnostic_is_bounded_and_preserves_stderr_for_descendants(fixture):
    mod = fixture
    executable(mod.OPT/mod.INIT, b'''#!/bin/sh
head -c 262144 /dev/zero >&2
echo 'local S05 failure' >&2
(sleep 0.6; head -c 262144 /dev/zero >&2 && touch "$XK_UPDATE_OPT/writer-finished") &
exit 3
''')
    rc, out = mod.service_command("restart", "on", timeout=3)
    assert rc == 3 and "local S05 failure" in out and len(out) <= mod.CONTROL_OUTPUT_LIMIT
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not (mod.OPT / "writer-finished").exists():
        time.sleep(0.03)
    assert (mod.OPT / "writer-finished").is_file()

def test_only_redacted_unknown_stderr_is_saved_locally(fixture, monkeypatch):
    mod = fixture
    rec = {"id":ident(), "phase":"installing", "runtime":{}}
    mod.opdir(rec["id"]).mkdir(parents=True)
    monkeypatch.setattr(mod, "service_command", lambda *args: (2, "failed on init line 4\ntoken=VERY_PRIVATE\n"))
    mod.record_control(rec, "restart", "on")
    file = mod.opdir(rec["id"]) / "installing-restart.stderr"
    assert file.read_text() == "failed on init line 4\n[redacted]\n"
    assert file.stat().st_mode & 0o777 == 0o600
    assert rec["runtime"]["stderr_saved"]
    assert "failed on init line" not in json.dumps(mod.visible(rec))

def test_stopped_state_waits_and_stops_only_once(fixture, monkeypatch):
    mod = fixture
    samples = iter(["unknown", "running", "running", "stopped", "stopped"])
    calls = []
    def command(action, *args, **kwargs):
        calls.append(action)
        if action == "stop":
            return 1, "token=secret"
        state = next(samples)
        return (0 if state == "running" else 1), state
    monkeypatch.setattr(mod, "service_command", command)
    rec = {"id":ident(), "phase":"restoring"}
    mod.opdir(rec["id"]).mkdir(parents=True)
    assert mod.health_after(rec, False)
    assert calls.count("stop") == 1 and "restart" not in calls
    assert rec["runtime"]["attempts"] == 5 and rec["runtime"]["last_status"] == "stopped"

def test_control_in_minimal_path_still_reports_s05_exit_code(fixture, monkeypatch):
    mod = fixture
    monkeypatch.setenv("PATH", str(mod.OPT / "nonexistent"))
    executable(mod.OPT/mod.INIT, b"#!/bin/sh\necho hidden >&2\nexit 7\n")
    assert mod.service_command("restart", "on") == (7, "")

def test_unknown_status_error_text_cannot_be_positive(fixture, monkeypatch):
    mod = fixture
    monkeypatch.setattr(mod, "service_command", lambda *args, **kwargs: (0, "service unavailable: couldn't determine active client"))
    assert mod.status_sample() == ("unknown", 0)

def test_final_unrecognized_status_is_saved_only_on_router(fixture, monkeypatch):
    mod = fixture
    monkeypatch.setattr(mod, "service_command", lambda action, *args, **kwargs:
                        (0, "") if action == "restart" else (4, "S05 status unavailable\npassword=my-private-value\n"))
    monkeypatch.setattr(mod, "VERIFY_WINDOW_SEC", 0.11)
    rec = {"id":ident(), "phase":"installing"}
    mod.opdir(rec["id"]).mkdir(parents=True)
    assert not mod.health_after(rec, True)
    assert rec["runtime"]["last_status"] == "unknown" and rec["runtime"]["status_rc"] == 4
    assert rec["runtime"]["stderr_saved"]
    assert (mod.opdir(rec["id"])/"installing-status.stderr").read_text() == "S05 status unavailable\n[redacted]\n"
    assert "S05 status unavailable" not in json.dumps(mod.visible(rec))
