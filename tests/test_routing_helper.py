"""Execute the real POSIX helper against isolated files and fake Xray/XKeen.

Only the session launcher is emulated on macOS (using the real os.setsid syscall).
No test invokes SSH or production router paths.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid
import pytest

SCRIPT=Path(__file__).resolve().parents[1]/"router/xk-routing.sh"

@pytest.fixture
def harness(tmp_path):
    bins=tmp_path/"bin";bins.mkdir()
    root=tmp_path/"state";root.mkdir()
    configs=tmp_path/"configs";configs.mkdir()
    assets=tmp_path/"assets";assets.mkdir()
    (assets/"geosite.dat").write_text("fixture")
    before=b'// original\r\n{"routing":{"rules":[]}}\r\n\r\n'
    (configs/"05_routing.json").write_bytes(before)
    (configs/"04_outbounds.json").write_text('{"outbounds":[]}')
    (tmp_path/"health").write_text("running")
    def executable(name,text):
        p=bins/name;p.write_text(text);p.chmod(0o755);return str(p)
    # Child shells read their script lazily; keep this run isolated from ongoing
    # edits in the shared development worktree.
    helper=executable("xk-routing",SCRIPT.read_text())
    executable("setsid",f"#!{sys.executable}\nimport os,sys\nos.setsid()\nos.execvpe(sys.argv[1],sys.argv[1:],os.environ)\n")
    executable("sync",f'''#!{sys.executable}
import time
from pathlib import Path
base=Path({str(tmp_path)!r})
with (base/'sync-calls').open('a') as log:log.write(str(time.monotonic())+'\\n')
if (base/'global-sync-delay').exists():time.sleep(float((base/'global-sync-delay').read_text()))
delay=base/'delay-next-sync'
if delay.exists():
    seconds=float(delay.read_text());delay.unlink()
    (base/'sync-delayed').touch();time.sleep(seconds)
terminal_delay=base/'delay-terminal-sync'
if terminal_delay.exists() and any(p.read_text().strip()=='committed' for p in (base/'state/operations').glob('*/phase')):
    seconds=float(terminal_delay.read_text());terminal_delay.unlink()
    (base/'terminal-sync-delayed').touch();time.sleep(seconds)
''')
    xray=executable("xray",f'''#!{sys.executable}
import os,sys
from pathlib import Path
if sys.argv[1]=='version': print('test-xray');sys.exit(0)
stage=Path(sys.argv[-1])
assert (stage/'04_outbounds.json').exists()
assert os.environ['XRAY_LOCATION_ASSET']=={str(assets)!r}
assert len(list(stage.glob('05*.json')))==1
if b'bad-main' in (stage/'04_outbounds.json').read_bytes():
    print('Invalid Main outbound',file=sys.stderr);sys.exit(23)
marker=Path({str(tmp_path)!r})/'edit-on-validation'
if marker.exists():
    name=marker.read_text();marker.unlink()
    (Path({str(configs)!r})/name).write_bytes(b'external edit')
if b'bad-geodata' in (stage/'05_routing.json').read_bytes():
    print('Failed to load geodata',file=sys.stderr);sys.exit(23)
''')
    xkeen=executable("xkeen",f'''#!{sys.executable}
import os,subprocess,sys,time
from pathlib import Path
base=Path({str(tmp_path)!r})
if sys.argv[1]=='-status': print((base/'health').read_text());sys.exit(0)
if (base/'detach-unless-foreground').exists() and os.environ.get('XKEEN_FOREGROUND')!='1' and not os.environ.get('XKEEN_DETACHED'):
    subprocess.Popen([sys.executable,__file__,*sys.argv[1:]],env={{**os.environ,'XKEEN_DETACHED':'1'}},
                     start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    sys.exit(0)
if (base/'hold-command').exists():
    (base/'command-started').touch()
    while not (base/'allow-command').exists():time.sleep(.02)
with (base/'calls').open('a') as f:f.write(sys.argv[1]+'\\n')
if (base/'fail-next-restart').exists():
    (base/'fail-next-restart').unlink();(base/'health').write_text('stopped');sys.exit(1)
raw=(base/'configs/05_routing.json').read_bytes()
if b'hang-restart' in raw: time.sleep(60)
if (base/'fail-all').exists():sys.exit(1)
if b'bad-restart' in raw:
    (base/'health').write_text('stopped');sys.exit(1)
if b'unknown-status' in raw:
    (base/'health').write_text('unknown');sys.exit(0)
(base/'health').write_text('stopped' if sys.argv[1]=='-stop' else 'running')
''')
    # The real helper prepends production directories. Use its supported profile
    # so the sync/session doubles actually run, including on macOS with /bin/sync.
    profile=tmp_path/"profile"
    profile.write_text("PATH="+shlex.quote(str(bins)+":"+os.environ["PATH"])+"\n")
    env={**os.environ,"PATH":str(bins)+":"+os.environ["PATH"],"XK_ROUTING_ROOT":str(root),"XK_ROUTING_CONFIGS":str(configs),
         "XK_ROUTING_ASSETS":str(assets),"XK_ROUTING_XRAY":xray,"XK_ROUTING_XKEEN":xkeen,"XK_ROUTING_SELF":helper,
         "XK_ROUTING_PROFILE":str(profile),"XK_ROUTING_FSYNC":str(tmp_path/"absent-fsync"),
         "XK_ROUTING_TEST":"1","XK_ROUTING_DEADLINE":"8","XK_ROUTING_CHECKS":"1"}
    def enable_fsync():
        env["XK_ROUTING_FSYNC"]=executable("fsync",f'''#!{sys.executable}
import hashlib,json,os,signal,sys,time
from pathlib import Path
base=Path({str(tmp_path)!r})
paths=[Path(value) for value in sys.argv[1:]]
operations=list((base/'state/operations').glob('*/phase'))
phase=operations[0].read_text().strip() if operations else None
record={{'paths':[str(path.relative_to(base)) for path in paths], 'phase':phase, 'lock_present':(base/'state/lock').exists(),
         'live':{{path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in (base/'configs').glob('*.json')}}}}
with (base/'fsync-calls').open('a') as log:log.write(json.dumps(record)+'\\n')
crash=base/'crash-before-acceptance-flush'
if crash.exists() and phase=='accepted':
    crash.unlink();os.kill(os.getppid(),signal.SIGKILL);sys.exit(0)
terminal_delay=base/'delay-terminal-sync'
if terminal_delay.exists() and phase=='committed':
    seconds=float(terminal_delay.read_text());terminal_delay.unlink()
    (base/'terminal-sync-delayed').touch();time.sleep(seconds)
terminal_failure=base/'fail-rollback-terminal-sync'
if terminal_failure.exists() and phase=='rolled_back':
    terminal_failure.unlink();sys.exit(57)
failure=base/'fail-fsync-once'
for path in paths:
    deletion_failure=base/'fail-directory-after-overlay-delete'
    if deletion_failure.exists() and path==base/'configs' and not (base/'configs/99_xk_devices_tail.json').exists():
        deletion_failure.unlink();sys.exit(56)
    if failure.exists() and str(path).endswith(failure.read_text()):
        failure.unlink();sys.exit(55)
    descriptor=os.open(path,os.O_RDONLY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)
''')
    def call(*args,raw=None):return subprocess.run([helper,*args],input=raw,env=env,capture_output=True,timeout=40)
    def start(raw,expected=None):
        ident=str(uuid.uuid4());env_hash=call("environment").stdout.decode().strip()
        result=call("start",ident,expected or hashlib.sha256((configs/'05_routing.json').read_bytes()).hexdigest(),hashlib.sha256(raw).hexdigest(),env_hash,raw=raw)
        assert result.returncode==0,result.stderr
        return ident
    def wait(ident):
        for _ in range(400):
            r=call("status",ident)
            phase=json.loads(r.stdout)["phase"]
            if phase in ("committed","rolled_back","rejected","recovery_failed"):
                # Supervisor releases only after the worker exits.
                if phase=="recovery_failed" or not (root/'lock').exists():return phase
            time.sleep(.05)
        pytest.fail(f'Helper stuck: {r.stdout!r}; '+(root/'operations'/ident/'log').read_text())
    yield type("Harness",(),{"call":staticmethod(call),"start":staticmethod(start),"wait":staticmethod(wait),
                            "root":root,"configs":configs,"base":tmp_path,"before":before,"env":env,"script":helper,
                            "enable_fsync":staticmethod(enable_fsync)})()

def test_helper_commits_with_exact_backup_and_original(harness):
    raw=b'{"routing":{"rules":[]}}\n'
    ident=harness.start(raw)
    assert harness.wait(ident)=="committed"
    assert (harness.configs/'05_routing.json').read_bytes()==raw
    assert (harness.root/'operations'/ident/'before.jsonc').read_bytes()==harness.before
    assert (harness.root/'original.jsonc').read_bytes()==harness.before
    assert (harness.base/'calls').read_text().splitlines()==['-restart']

@pytest.mark.parametrize("payload",[b'bad-restart',b'unknown-status',b'hang-restart'])
def test_helper_recovers_after_installation_failure(harness,payload):
    ident=harness.start(payload)
    assert harness.wait(ident)=="rolled_back"
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before

def test_preflight_failure_does_not_replace_file_or_restart(harness):
    ident=harness.start(b'bad-geodata')
    assert harness.wait(ident)=="rejected"
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before
    assert not (harness.base/'calls').exists()

def test_stale_hash_does_not_replace_file(harness):
    ident=harness.start(b'candidate',expected='0'*64)
    assert harness.wait(ident)=="rejected"
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before

def test_failed_recovery_stays_locked_and_is_not_success(harness):
    (harness.base/'fail-all').touch()
    ident=harness.start(b'candidate')
    assert harness.wait(ident)=="recovery_failed"
    assert (harness.root/'lock').exists()
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before
    assert harness.call('control','start').returncode!=0

def test_validation_and_control_respect_transaction_lock(harness):
    (harness.root/'lock').mkdir()
    result=harness.call('validate',raw=b'candidate')
    assert result.returncode!=0
    assert harness.call('outbound',raw=b'outbound').returncode!=0
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before

def test_invalid_payload_and_id_rejected(harness):
    assert harness.call('start','../escape','0'*64,'0'*64,'0'*64,raw=b'x').returncode!=0
    ident=str(uuid.uuid4())
    result=harness.call('start',ident,'0'*64,'0'*64,'0'*64,raw=b'x')
    assert result.returncode!=0 and not (harness.root/'lock').exists()

def test_ack_retains_unconfirmed_copies_and_pinned_original(harness):
    ident=harness.start(b'candidate')
    assert harness.wait(ident)=='committed'
    for i in range(12):
        old=harness.root/'operations'/str(uuid.uuid4());old.mkdir()
        (old/'phase').write_text('committed')
        (old/'ack').write_text('confirmed')
        (old/'before.jsonc').write_bytes(b'old')
    pending=harness.root/'operations'/str(uuid.uuid4());pending.mkdir()
    (pending/'phase').write_text('recovery_failed')
    (pending/'before.jsonc').write_bytes(b'needed')
    assert harness.call('ack',ident).returncode==0
    assert len(list((harness.root/'operations').glob('*/before.jsonc')))==11
    assert (pending/'before.jsonc').read_bytes()==b'needed'
    assert (harness.root/'original.jsonc').read_bytes()==harness.before

@pytest.mark.parametrize("targeted", [False, True])
def test_boot_restores_interrupted_install_and_preserves_foreign_file(harness, targeted):
    if targeted: harness.enable_fsync()
    ident=str(uuid.uuid4());op=harness.root/'operations'/ident;op.mkdir(parents=True)
    lock=harness.root/'lock';lock.mkdir();(lock/'owner').write_text(ident)
    (op/'phase').write_text('installed');(op/'before.jsonc').write_bytes(harness.before)
    (op/'before.state').write_text('running')
    (op/'before.sha256').write_text(hashlib.sha256(harness.before).hexdigest())
    (op/'candidate.sha256').write_text(hashlib.sha256(b'candidate').hexdigest())
    (harness.configs/'05_routing.json').write_bytes(b'foreign')
    assert harness.call('boot').returncode!=0
    assert (harness.configs/'05_routing.json').read_bytes()==b'foreign'
    (harness.configs/'05_routing.json').write_bytes(b'candidate')
    assert harness.call('boot').returncode==0
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before
    assert json.loads(harness.call('status',ident).stdout)['phase']=='boot_restored'
    assert lock.exists()
    (harness.base/'health').write_text('unknown')
    assert harness.call('boot-finish').returncode!=0
    assert lock.exists()
    assert json.loads(harness.call('status',ident).stdout)['phase']=='recovery_failed'
    (op/'phase').write_text('boot_restored')
    (harness.base/'health').write_text('running')
    assert harness.call('boot-finish').returncode==0
    assert not lock.exists()
    assert json.loads(harness.call('status',ident).stdout)['phase']=='rolled_back'

def test_failure_restores_previously_stopped_service(harness):
    (harness.base/'health').write_text('stopped')
    ident=harness.start(b'bad-restart')
    assert harness.wait(ident)=='rolled_back'
    assert (harness.base/'health').read_text()=='stopped'
    assert json.loads(harness.call('status',ident).stdout)['before_state']=='stopped'
    assert (harness.configs/'05_routing.json').read_bytes()==harness.before

# Bundle operations cover main outbound, canonical rules, and the device overlay.
def bundle_start(h, files):
    from xk_switcher.device_routing import FILES, fingerprint, pack
    before = {name: (h.configs / name).read_bytes() for name in FILES if (h.configs / name).exists()}
    candidate = pack(files)
    ident = str(uuid.uuid4())
    environment = h.call("bundle-environment").stdout.decode().strip()
    result = h.call("start-bundle", ident, fingerprint(before), hashlib.sha256(candidate).hexdigest(), environment, raw=candidate)
    assert result.returncode == 0, result.stderr
    return ident

def test_bundle_commit_and_exact_backup(harness):
    from xk_switcher.device_routing import pack, unpack
    files = {"04_outbounds.json": b'{"outbounds":[{"tag":"main"}]}',
             "05_routing.json": harness.before, "99_xk_devices_tail.json": b'{"outbounds":[]}'}
    assert harness.call("validate-bundle", raw=pack(files)).returncode == 0
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "committed"
    assert unpack(harness.call("read-bundle").stdout) == files
    before = harness.root / "operations" / ident / "before"
    assert (before / "05_routing.json").read_bytes() == harness.before
    assert not (before / "99_xk_devices_tail.json").exists()
    assert (harness.root / "original.jsonc").read_bytes() == harness.before

@pytest.mark.parametrize("failure", [b'bad-geodata', b'bad-restart', b'hang-restart'])
def test_bundle_failure_restores_all_files_and_overlay_absence(harness, failure):
    before_out = (harness.configs / "04_outbounds.json").read_bytes()
    files = {"04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}',
             "05_routing.json": failure, "99_xk_devices_tail.json": b'{"outbounds":[]}'}
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == ("rejected" if failure == b'bad-geodata' else "rolled_back")
    assert (harness.configs / "04_outbounds.json").read_bytes() == before_out
    assert (harness.configs / "05_routing.json").read_bytes() == harness.before
    assert not (harness.configs / "99_xk_devices_tail.json").exists()

@pytest.mark.parametrize("targeted", [False, True])
def test_bundle_boot_restores_mixed_installation_and_refuses_external_edits(harness, targeted):
    if targeted: harness.enable_fsync()
    from xk_switcher.device_routing import FILES, fingerprint, pack
    before = {name: (harness.configs/name).read_bytes() for name in FILES if (harness.configs/name).exists()}
    candidate = {**before, "04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}', "99_xk_devices_tail.json": b'{}'}
    ident = str(uuid.uuid4()); op = harness.root / "operations" / ident
    for kind, files in (("before", before), ("candidate", candidate)):
        (op/kind).mkdir(parents=True)
        for name, raw in files.items(): (op/kind/name).write_bytes(raw)
    (op/"phase").write_text("installing"); (op/"bundle").write_text("1")
    (op/"before.sha256").write_text(fingerprint(before)); (op/"installed.sha256").write_text(fingerprint(candidate))
    (op/"before.state").write_text("running")
    (harness.root/"lock").mkdir(); (harness.root/"lock/owner").write_text(ident)
    # Power loss after the first rename: later files still contain old bytes.
    (harness.configs/"04_outbounds.json").write_bytes(candidate["04_outbounds.json"])
    (harness.configs/"05_routing.json").write_bytes(b'external')
    assert harness.call("boot").returncode != 0
    assert (harness.configs/"05_routing.json").read_bytes() == b'external'
    (harness.configs/"05_routing.json").write_bytes(before["05_routing.json"])
    assert harness.call("boot").returncode == 0
    assert harness.call("boot-finish").returncode == 0
    assert {name:(harness.configs/name).read_bytes() for name in FILES if (harness.configs/name).exists()} == before

def test_bundle_recovery_preserves_existing_overlay_bytes(harness):
    overlay = b'// existing\r\n{"routing":{"rules":[]}}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    ident = bundle_start(harness, {"04_outbounds.json":b'{"outbounds":[]}',
        "05_routing.json":b'bad-restart', "99_xk_devices_tail.json":b'{}'})
    assert harness.wait(ident) == "rolled_back"
    assert (harness.configs / "99_xk_devices_tail.json").read_bytes() == overlay

def test_bundle_environment_tracks_dependencies_but_not_owned_files(harness):
    original = harness.call("bundle-environment").stdout
    (harness.configs / "04_outbounds.json").write_bytes(b'changed')
    (harness.configs / "99_xk_devices_tail.json").write_bytes(b'{}')
    assert harness.call("bundle-environment").stdout == original
    (harness.configs / "03_inbounds.json").write_bytes(b'{"inbounds":[]}')
    assert harness.call("bundle-environment").stdout != original
    import io, tarfile
    with tarfile.open(fileobj=io.BytesIO(harness.call("read-dependencies").stdout)) as archive:
        assert archive.getnames() == ["03_inbounds.json"]
        assert archive.extractfile("03_inbounds.json").read() == b'{"inbounds":[]}'

def test_bundle_rejects_archive_paths_and_duplicate_entries(harness):
    import io, tarfile
    for names in (("../escape",), ("04_outbounds.json", "04_outbounds.json", "05_routing.json", "99_xk_devices_tail.json")):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for name in names:
                member = tarfile.TarInfo(name); member.size = 2
                archive.addfile(member, io.BytesIO(b'{}'))
        assert harness.call("validate-bundle", raw=stream.getvalue()).returncode != 0
    assert not (harness.base / "escape").exists()
    assert (harness.configs / "05_routing.json").read_bytes() == harness.before

def test_main_bundle_does_not_replace_unchanged_routing_or_overlay(harness):
    overlay = b'// fixed device exit\r\n{"outbounds":[],"routing":{"rules":[]}}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    unchanged = {name: (harness.configs / name).stat().st_ino for name in
                 ("05_routing.json", "99_xk_devices_tail.json")}
    files = {"04_outbounds.json": b'{"outbounds":[{"tag":"new-main"}]}',
             "05_routing.json": harness.before, "99_xk_devices_tail.json": overlay}
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "committed"
    for name, inode in unchanged.items():
        assert (harness.configs / name).read_bytes() == files[name]
        assert (harness.configs / name).stat().st_ino == inode
    assert (harness.base / "calls").read_text().splitlines() == ["-restart"]

def test_bundle_can_remove_last_overlay_without_replacing_other_files(harness):
    overlay = b'// original overlay\r\n{"routing":{"rules":[]}}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    files = {name: (harness.configs / name).read_bytes() for name in
             ("04_outbounds.json", "05_routing.json")}
    inodes = {name: (harness.configs / name).stat().st_ino for name in files}
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "committed"
    assert not (harness.configs / "99_xk_devices_tail.json").exists()
    assert (harness.root / "operations" / ident / "before" / "99_xk_devices_tail.json").read_bytes() == overlay
    for name, inode in inodes.items():
        assert (harness.configs / name).stat().st_ino == inode

def test_selective_overlay_removal_failure_restores_exact_bytes_only(harness):
    overlay = b'// existing\r\n{"routing":{"rules":[]}}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    files = {name: (harness.configs / name).read_bytes() for name in
             ("04_outbounds.json", "05_routing.json")}
    inodes = {name: (harness.configs / name).stat().st_ino for name in files}
    (harness.base / "fail-next-restart").touch()
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "rolled_back"
    assert (harness.configs / "99_xk_devices_tail.json").read_bytes() == overlay
    assert (harness.root / "operations" / ident / "changed.files").read_text() == "99_xk_devices_tail.json\n"
    for name, inode in inodes.items():
        assert (harness.configs / name).stat().st_ino == inode
    assert (harness.base / "calls").read_text().splitlines() == ["-restart", "-restart"]

@pytest.mark.parametrize("external_name", ["03_inbounds.json", "99_xk_devices_tail.json"])
def test_selective_apply_refuses_dependency_or_unchanged_overlay_edit(harness, external_name):
    overlay = b'{"routing":{"rules":[]}}'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    before_outbound = (harness.configs / "04_outbounds.json").read_bytes()
    (harness.base / "edit-on-validation").write_text(external_name)
    ident = bundle_start(harness, {"04_outbounds.json": b'{"outbounds":[{"tag":"main"}]}',
        "05_routing.json": harness.before, "99_xk_devices_tail.json": overlay})
    assert harness.wait(ident) == "rejected"
    assert (harness.configs / external_name).read_bytes() == b'external edit'
    assert (harness.configs / "04_outbounds.json").read_bytes() == before_outbound
    assert not (harness.base / "calls").exists()

def test_incomplete_acceptance_status_is_pending_and_boot_can_discard_it(harness):
    ident = str(uuid.uuid4())
    lock = harness.root / "lock"
    lock.mkdir(); (lock / "owner").write_text(ident)
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "preparing"
    op = harness.root / "operations" / ident
    op.mkdir(parents=True); (op / "candidate.sha256").write_text("0" * 64)
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "preparing"
    assert harness.call("boot").returncode == 0
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "rejected"
    assert not lock.exists()
    assert (harness.configs / "05_routing.json").read_bytes() == harness.before
    assert not (harness.base / "calls").exists()

def test_slow_acceptance_remains_inspectable_beyond_old_timeout(harness):
    from xk_switcher.device_routing import fingerprint, pack
    files = {name: (harness.configs / name).read_bytes() for name in
             ("04_outbounds.json", "05_routing.json")}
    candidate = pack({**files, "04_outbounds.json": b'{"outbounds":[{"tag":"main"}]}'})
    ident = str(uuid.uuid4())
    env_hash = harness.call("bundle-environment").stdout.decode().strip()
    (harness.base / "delay-next-sync").write_text("16")
    process = subprocess.Popen([harness.script, "start-bundle", ident, fingerprint(files),
        hashlib.sha256(candidate).hexdigest(), env_hash], env=harness.env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    started = time.monotonic()
    try:
        process.stdin.write(candidate); process.stdin.close(); process.stdin = None
        for _ in range(200):
            if (harness.base / "sync-delayed").exists(): break
            time.sleep(.01)
        assert (harness.base / "sync-delayed").exists()
        assert json.loads(harness.call("status", ident).stdout)["phase"] in {"preparing", "accepted"}
        assert process.poll() is None
        stdout, stderr = process.communicate(timeout=25)
        assert process.returncode == 0, stderr
        assert stdout == b"accepted\n"
        assert time.monotonic() - started >= 16
        assert harness.wait(ident) == "committed"
        assert (harness.base / "calls").read_text().splitlines() == ["-restart"]
        # Lock publication, acceptance and three apply barriers, independent of
        # number of metadata fields or managed files.
        assert len((harness.base / "sync-calls").read_text().splitlines()) == 5
    finally:
        if process.poll() is None:
            process.terminate(); process.communicate(timeout=5)

def test_lost_acceptance_reply_and_same_id_retry_do_not_restart_twice(harness):
    from xk_switcher.device_routing import fingerprint, pack
    files = {name: (harness.configs / name).read_bytes() for name in
             ("04_outbounds.json", "05_routing.json")}
    candidate = pack({**files, "04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}'})
    ident = str(uuid.uuid4())
    args = ["start-bundle", ident, fingerprint(files), hashlib.sha256(candidate).hexdigest(),
            harness.call("bundle-environment").stdout.decode().strip()]
    # Execute the real helper, then drop its reply as a failed SSH transport does.
    result = subprocess.run(["sh", "-c", '"$@" >/dev/null; exit 255', "lost-reply", harness.script, *args],
        input=candidate, env=harness.env, capture_output=True, timeout=10)
    assert result.returncode == 255
    assert harness.wait(ident) == "committed"
    assert harness.call(*args, raw=candidate).stdout == b"committed\n"
    assert (harness.base / "calls").read_text().splitlines() == ["-restart"]
    conflict = [*args]; conflict[3] = "0" * 64
    assert harness.call(*conflict, raw=candidate).returncode != 0

@pytest.mark.parametrize("targeted", [False, True])
def test_selective_boot_recovery_keeps_unchanged_file_inodes(harness, targeted):
    if targeted: harness.enable_fsync()
    from xk_switcher.device_routing import fingerprint
    before = {name: (harness.configs / name).read_bytes() for name in
              ("04_outbounds.json", "05_routing.json")}
    before["99_xk_devices_tail.json"] = b'// preserved overlay\r\n{}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(before["99_xk_devices_tail.json"])
    inode = (harness.configs / "05_routing.json").stat().st_ino
    candidate = {"04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}', "05_routing.json": before["05_routing.json"]}
    ident = str(uuid.uuid4()); op = harness.root / "operations" / ident
    for kind, files in (("before", before), ("candidate", candidate)):
        (op / kind).mkdir(parents=True)
        for name, raw in files.items(): (op / kind / name).write_bytes(raw)
    for name, value in {"version": "3", "bundle": "1", "phase": "installing", "before.state": "running",
        "before.sha256": fingerprint(before), "installed.sha256": fingerprint(candidate),
        "changed.files": "04_outbounds.json\n99_xk_devices_tail.json\n",
        "environment": harness.call("bundle-environment").stdout.decode().strip()}.items():
        (op / name).write_text(value)
    (harness.root / "lock").mkdir(); (harness.root / "lock" / "owner").write_text(ident)
    (harness.configs / "04_outbounds.json").write_bytes(candidate["04_outbounds.json"])
    (harness.configs / "99_xk_devices_tail.json").unlink()
    assert harness.call("boot").returncode == 0
    assert harness.call("boot-finish").returncode == 0
    assert (harness.configs / "99_xk_devices_tail.json").read_bytes() == before["99_xk_devices_tail.json"]
    assert (harness.configs / "04_outbounds.json").read_bytes() == before["04_outbounds.json"]
    assert (harness.configs / "05_routing.json").stat().st_ino == inode

@pytest.mark.parametrize("terminal", ["committed", "rolled_back", "rejected"])
def test_terminal_status_waits_for_durable_lock_release(harness, terminal):
    ident = str(uuid.uuid4())
    op = harness.root / "operations" / ident
    op.mkdir(parents=True); (op / "phase").write_text(terminal)
    lock = harness.root / "lock"
    lock.mkdir(); (lock / "owner").write_text(ident)
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "finishing"
    (lock / "owner").unlink(); lock.rmdir()
    assert json.loads(harness.call("status", ident).stdout)["phase"] == terminal

def test_disconnect_during_lock_acquisition_does_not_strand_acceptance(harness):
    import shutil
    import signal
    mkdir = shutil.which("mkdir")
    wrapper = harness.base / "bin" / "mkdir"
    wrapper.write_text(f'''#!{sys.executable}
import subprocess,sys,time
from pathlib import Path
result=subprocess.run([{mkdir!r},*sys.argv[1:]])
if result.returncode==0 and sys.argv[1:]==[{str(harness.root / 'lock')!r}]:
    Path({str(harness.base / 'lock-created')!r}).touch()
    time.sleep(.5)
sys.exit(result.returncode)
''')
    wrapper.chmod(0o755)
    candidate = b'{"routing":{"rules":[]}}\n'
    ident = str(uuid.uuid4())
    args = [harness.script, "start", ident, hashlib.sha256(harness.before).hexdigest(),
            hashlib.sha256(candidate).hexdigest(), harness.call("environment").stdout.decode().strip()]
    process = subprocess.Popen(args, env=harness.env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(candidate); process.stdin.close(); process.stdin = None
        for _ in range(300):
            if (harness.base / "lock-created").exists(): break
            time.sleep(.01)
        assert (harness.base / "lock-created").exists()
        process.send_signal(signal.SIGHUP)
        _, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stderr
        assert harness.wait(ident) == "committed"
        assert not (harness.root / "lock").exists()
    finally:
        if process.poll() is None:
            process.kill(); process.communicate(timeout=5)

@pytest.mark.parametrize("targeted", [False, True])
def test_supervisor_finishes_terminal_barrier_after_worker_deadline(harness, targeted):
    if targeted: harness.enable_fsync()
    harness.env["XK_ROUTING_DEADLINE"] = "4"
    (harness.base / "delay-terminal-sync").write_text("60")
    files = {"04_outbounds.json": b'{"outbounds":[{"tag":"main"}]}', "05_routing.json": harness.before}
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "committed"
    assert (harness.base / "terminal-sync-delayed").exists()
    op = harness.root / "operations" / ident
    assert not (op / "terminal.durable").exists()
    events = [line.split(" ", 1)[1] for line in (op / "timings.log").read_text().splitlines()]
    assert events.count("barrier:committed:begin") == 2
    assert events.count("barrier:committed:end") == 1
    assert (harness.base / "calls").read_text().splitlines() == ["-restart"]
    assert (harness.configs / "04_outbounds.json").read_bytes() == files["04_outbounds.json"]

def test_targeted_fsync_flushes_backups_before_intent_and_preserves_unrelated_files(harness):
    harness.enable_fsync()
    (harness.base / "global-sync-delay").write_text("30")
    overlay = b'// fixed exit\r\n{}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    before_main = (harness.configs / "04_outbounds.json").read_bytes()
    files = {"04_outbounds.json": b'{"outbounds":[{"tag":"new-main"}]}',
             "05_routing.json": harness.before, "99_xk_devices_tail.json": overlay}
    inodes = {name: (harness.configs / name).stat().st_ino for name in ("05_routing.json", "99_xk_devices_tail.json")}
    started = time.monotonic()
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "committed"
    assert time.monotonic() - started < 12
    assert not (harness.base / "sync-calls").exists()
    assert json.loads(harness.call("capabilities").stdout)["durability"] == "fsync"
    events = [json.loads(line) for line in (harness.base / "fsync-calls").read_text().splitlines()]
    prefix = f"state/operations/{ident}"
    assert events[0]["paths"][0] == "state/lock/owner"
    assert events[1]["paths"] == ["state/lock", "state"]
    assert events[0]["phase"] is None and events[1]["phase"] is None
    before_intent = next(event for event in events if prefix + "/before/04_outbounds.json" in event["paths"])
    assert before_intent["phase"] == "prepared"
    assert before_intent["live"]["04_outbounds.json"] == hashlib.sha256(before_main).hexdigest()
    data_index = events.index(before_intent)
    dirs_index = next(index for index, event in enumerate(events) if prefix + "/before" in event["paths"])
    installing_index = next(index for index, event in enumerate(events) if event["phase"] == "installing")
    assert data_index < dirs_index < installing_index
    data_paths = before_intent["paths"]
    assert prefix + "/candidate/04_outbounds.json" in data_paths
    assert prefix + "/changed.files" in data_paths
    assert "state/original.jsonc" in data_paths
    assert any(path.startswith("configs/.xk-routing.") and path.endswith("/04_outbounds.json") for path in data_paths)
    installed_index = next(index for index, event in enumerate(events) if "configs/04_outbounds.json" in event["paths"])
    installed_dir_index = next(index for index, event in enumerate(events) if index > installed_index and "configs" in event["paths"])
    committed_index = next(index for index, event in enumerate(events) if event["phase"] == "committed")
    assert installed_index < installed_dir_index < committed_index
    committed_files = events[committed_index]
    assert prefix + "/phase" in committed_files["paths"]
    assert prefix + "/timings.log" in committed_files["paths"]
    assert all(event["lock_present"] for event in events[committed_index:])
    assert prefix in events[committed_index + 1]["paths"]
    assert not (harness.root / "lock").exists()
    for name, inode in inodes.items():
        assert (harness.configs / name).stat().st_ino == inode
        assert not any(f"configs/{name}" in event["paths"] for event in events)

def test_targeted_fsync_failure_before_install_rejects_without_writes(harness):
    harness.enable_fsync()
    (harness.base / "fail-fsync-once").write_text("before/04_outbounds.json")
    before = (harness.configs / "04_outbounds.json").read_bytes()
    ident = bundle_start(harness, {"04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}',
        "05_routing.json": harness.before})
    assert harness.wait(ident) == "rejected"
    assert (harness.configs / "04_outbounds.json").read_bytes() == before
    assert not (harness.base / "calls").exists()
    assert not (harness.base / "sync-calls").exists()

@pytest.mark.parametrize("failure", [False, True])
def test_targeted_fsync_overlay_deletion_is_durable_and_rollback_exact(harness, failure):
    harness.enable_fsync()
    overlay = b'// old overlay\r\n{}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    files = {name: (harness.configs / name).read_bytes() for name in ("04_outbounds.json", "05_routing.json")}
    if failure: (harness.base / "fail-next-restart").touch()
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == ("rolled_back" if failure else "committed")
    assert not (harness.base / "sync-calls").exists()
    if failure: assert (harness.configs / "99_xk_devices_tail.json").read_bytes() == overlay
    else: assert not (harness.configs / "99_xk_devices_tail.json").exists()
    events = [json.loads(line) for line in (harness.base / "fsync-calls").read_text().splitlines()]
    assert any("configs" in event["paths"] and "99_xk_devices_tail.json" not in event["live"] for event in events)

def test_authoritative_helper_rejects_invalid_main_before_any_write(harness):
    harness.enable_fsync()
    before = {name: (harness.configs / name).read_bytes() for name in ("04_outbounds.json", "05_routing.json")}
    ident = bundle_start(harness, {**before, "04_outbounds.json": b'{bad-main'})
    assert harness.wait(ident) == "rejected"
    assert {name: (harness.configs / name).read_bytes() for name in before} == before
    assert not (harness.base / "calls").exists()

def test_targeted_fsync_initial_root_persists_new_ancestors_in_order(harness):
    harness.enable_fsync()
    new_root = harness.base / "new" / "nested" / "journal"
    harness.env["XK_ROUTING_ROOT"] = str(new_root)
    result = harness.call("control", "start")
    assert result.returncode == 0, result.stderr
    events = [json.loads(line) for line in (harness.base / "fsync-calls").read_text().splitlines()]
    assert events[0]["paths"] == ["new/nested/journal", "new/nested", "new", "."]
    assert not (new_root / "lock").exists()

def test_targeted_fsync_installed_data_error_rolls_back_instead_of_committing(harness):
    harness.enable_fsync()
    (harness.base / "fail-fsync-once").write_text("configs/04_outbounds.json")
    before = (harness.configs / "04_outbounds.json").read_bytes()
    ident = bundle_start(harness, {"04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}',
        "05_routing.json": harness.before})
    assert harness.wait(ident) == "rolled_back"
    assert (harness.configs / "04_outbounds.json").read_bytes() == before
    assert (harness.configs / "05_routing.json").read_bytes() == harness.before
    assert (harness.base / "calls").read_text().splitlines() == ["-restart"]
    assert not (harness.base / "sync-calls").exists()

def test_targeted_directory_fsync_error_after_overlay_delete_restores_it(harness):
    harness.enable_fsync()
    overlay = b'// preserved\r\n{}\r\n'
    (harness.configs / "99_xk_devices_tail.json").write_bytes(overlay)
    (harness.base / "fail-directory-after-overlay-delete").touch()
    files = {name: (harness.configs / name).read_bytes() for name in ("04_outbounds.json", "05_routing.json")}
    ident = bundle_start(harness, files)
    assert harness.wait(ident) == "rolled_back"
    assert (harness.configs / "99_xk_devices_tail.json").read_bytes() == overlay
    assert (harness.base / "calls").read_text().splitlines() == ["-restart"]
    assert not (harness.base / "sync-calls").exists()

def test_targeted_acknowledgment_flushes_record_before_directory(harness):
    harness.enable_fsync()
    ident = harness.start(b'{"routing":{"rules":[]}}')
    assert harness.wait(ident) == "committed"
    previous = len((harness.base / "fsync-calls").read_text().splitlines())
    assert harness.call("ack", ident).returncode == 0
    events = [json.loads(line) for line in (harness.base / "fsync-calls").read_text().splitlines()][previous:]
    prefix = f"state/operations/{ident}"
    assert prefix + "/ack" in events[0]["paths"]
    assert prefix in events[1]["paths"]
    assert not (harness.base / "sync-calls").exists()

def test_partial_failed_metadata_write_never_publishes_installing(harness):
    harness.enable_fsync()
    with (harness.base / "profile").open("a") as profile:
        profile.write('''
printf() {
    if [ "$#" = 2 ] && [ "$2" = installing ]; then
        command printf '%s' partial
        return 1
    fi
    command printf "$@"
}
''')
    before = (harness.configs / "04_outbounds.json").read_bytes()
    ident = bundle_start(harness, {"04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}',
        "05_routing.json": harness.before})
    assert harness.wait(ident) == "rejected"
    assert (harness.configs / "04_outbounds.json").read_bytes() == before
    assert not (harness.base / "calls").exists()

def test_initial_lock_fsync_error_does_not_leave_unpublished_orphan(harness):
    from xk_switcher.device_routing import fingerprint, pack
    harness.enable_fsync()
    (harness.base / "fail-fsync-once").write_text("state/lock/owner")
    files = {name: (harness.configs / name).read_bytes() for name in ("04_outbounds.json", "05_routing.json")}
    candidate = pack(files); ident = str(uuid.uuid4())
    result = harness.call("start-bundle", ident, fingerprint(files), hashlib.sha256(candidate).hexdigest(),
        harness.call("bundle-environment").stdout.decode().strip(), raw=candidate)
    assert result.returncode != 0
    assert not (harness.root / "lock").exists()
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "not_found"
    assert not (harness.base / "calls").exists()

def test_crash_before_acceptance_flush_keeps_durable_lock_for_boot_recovery(harness):
    from xk_switcher.device_routing import fingerprint, pack
    harness.enable_fsync()
    (harness.base / "crash-before-acceptance-flush").touch()
    files = {name: (harness.configs / name).read_bytes() for name in ("04_outbounds.json", "05_routing.json")}
    candidate = pack({**files, "04_outbounds.json": b'{"outbounds":[{"tag":"new"}]}'})
    ident = str(uuid.uuid4())
    result = harness.call("start-bundle", ident, fingerprint(files), hashlib.sha256(candidate).hexdigest(),
        harness.call("bundle-environment").stdout.decode().strip(), raw=candidate)
    assert result.returncode != 0
    assert (harness.root / "lock" / "owner").read_text().strip() == ident
    events = [json.loads(line) for line in (harness.base / "fsync-calls").read_text().splitlines()]
    assert events[0]["paths"][0] == "state/lock/owner"
    assert events[1]["paths"] == ["state/lock", "state"]
    assert events[0]["phase"] is None and events[1]["phase"] is None
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "accepted"
    # Model unflushed acceptance bytes disappearing at power loss; boot needs
    # only the earlier durable lock to reject a never-installed candidate.
    (harness.root / "operations" / ident / "candidate.jsonc").unlink()
    (harness.root / "lock" / "boot_id").unlink(missing_ok=True)
    assert harness.call("boot").returncode == 0
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "rejected"
    assert not (harness.root / "lock").exists()
    assert {name: (harness.configs / name).read_bytes() for name in files} == files
    assert not (harness.base / "calls").exists()

def test_control_waits_for_noninteractive_xkeen_before_releasing_lock(harness):
    (harness.base / "detach-unless-foreground").touch()
    (harness.base / "hold-command").touch()
    process = subprocess.Popen([harness.script, "control", "restart"], env=harness.env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(300):
            if (harness.base / "command-started").exists(): break
            time.sleep(.01)
        assert (harness.base / "command-started").exists()
        assert process.poll() is None, "XKeen detached and the operation lock was released too early"
        assert harness.call("control", "start").returncode != 0
    finally:
        (harness.base / "allow-command").touch()
        _, stderr = process.communicate(timeout=5)
    assert process.returncode == 0, stderr
    assert not (harness.root / "lock").exists()

def failed_restored_bundle(harness):
    """A completed failed recovery with exact restored files, no live workers."""
    from xk_switcher.device_routing import fingerprint
    before = {name: (harness.configs / name).read_bytes() for name in ("04_outbounds.json", "05_routing.json")}
    ident = str(uuid.uuid4())
    op = harness.root / "operations" / ident
    (op / "before").mkdir(parents=True)
    for name, raw in before.items(): (op / "before" / name).write_bytes(raw)
    for name, value in {"version": "3", "bundle": "1", "phase": "recovery_failed", "before.state": "running",
                        "before.sha256": fingerprint(before),
                        "environment": harness.call("bundle-environment").stdout.decode().strip()}.items():
        (op / name).write_text(value)
    lock = harness.root / "lock"
    lock.mkdir(); (lock / "owner").write_text(ident)
    exited = subprocess.Popen([sys.executable, "-c", "pass"])
    exited.wait(timeout=5)
    for role in ("supervisor", "worker"): (op / (role + ".pid")).write_text(str(exited.pid))
    return ident, op, before

@pytest.mark.parametrize("targeted", [False, True])
def test_confirm_rollback_validates_restored_files_with_reviewed_new_environment(harness, targeted):
    if targeted: harness.enable_fsync()
    ident, op, before = failed_restored_bundle(harness)
    original_environment = (op / "environment").read_text()
    (harness.base / "assets" / "geosite.dat").write_text("nightly update")
    environment = harness.call("bundle-environment").stdout.decode().strip()
    assert environment != original_environment
    inodes = {name: (harness.configs / name).stat().st_ino for name in before}
    result = harness.call("confirm-rollback", ident, environment)
    assert result.returncode == 0, result.stderr
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "rolled_back"
    assert not (harness.root / "lock").exists()
    assert (op / "environment").read_text() == original_environment
    assert (op / "confirmed.environment").read_text().strip() == environment
    assert {name: (harness.configs / name).read_bytes() for name in before} == before
    assert {name: (harness.configs / name).stat().st_ino for name in before} == inodes
    assert not (harness.base / "calls").exists(), "Confirmation must not restart XKeen"

@pytest.mark.parametrize("problem", ["live_config", "backup", "environment", "health", "owner", "phase", "worker", "supervisor", "recovery", "missing_worker", "missing_supervisor", "concurrent", "validation", "during_validation", "environment_during_validation"])
def test_confirm_rollback_keeps_block_on_unverified_state(harness, problem):
    ident, op, before = failed_restored_bundle(harness)
    environment = harness.call("bundle-environment").stdout.decode().strip()
    if problem == "live_config": (harness.configs / "04_outbounds.json").write_text("external edit")
    elif problem == "backup": (op / "before" / "04_outbounds.json").write_text("corrupt backup")
    elif problem == "environment": (harness.base / "assets" / "geosite.dat").write_text("unreviewed update")
    elif problem == "health": (harness.base / "health").write_text("stopped")
    elif problem == "owner": (harness.root / "lock" / "owner").write_text(str(uuid.uuid4()))
    elif problem == "phase": (op / "phase").write_text("verifying")
    elif problem in {"worker", "supervisor", "recovery"}: (op / (problem + ".pid")).write_text(str(os.getpid()))
    elif problem.startswith("missing_"): (op / (problem.removeprefix("missing_") + ".pid")).unlink()
    elif problem == "concurrent": (op / "confirmation.lock").mkdir()
    elif problem == "validation":
        from xk_switcher.device_routing import fingerprint
        before["04_outbounds.json"] = b"bad-main"
        (op / "before" / "04_outbounds.json").write_bytes(before["04_outbounds.json"])
        (harness.configs / "04_outbounds.json").write_bytes(before["04_outbounds.json"])
        (op / "before.sha256").write_text(fingerprint(before))
    elif problem == "during_validation": (harness.base / "edit-on-validation").write_text("04_outbounds.json")
    elif problem == "environment_during_validation": (harness.base / "edit-on-validation").write_text("../assets/geosite.dat")
    result = harness.call("confirm-rollback", ident, environment)
    assert result.returncode != 0
    assert b"Unknown command" not in result.stderr, result.stderr
    assert (harness.root / "lock").exists()
    assert (op / "phase").read_text().strip() != "rolled_back"
    assert not (harness.base / "calls").exists()

def test_confirm_rollback_durability_failure_keeps_lock_and_can_retry(harness):
    harness.enable_fsync()
    ident, op, _ = failed_restored_bundle(harness)
    environment = harness.call("bundle-environment").stdout.decode().strip()
    (harness.base / "fail-fsync-once").write_text("confirmed.environment")
    assert harness.call("confirm-rollback", ident, environment).returncode != 0
    assert (harness.root / "lock").exists()
    assert harness.call("confirm-rollback", ident, environment).returncode == 0
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "rolled_back"
    assert not (harness.root / "lock").exists()

def test_confirm_rollback_refuses_incomplete_validation_stage(harness):
    import shutil
    dependency = harness.configs / "03_inbounds.json"
    dependency.write_text('{"inbounds":[]}')
    ident, op, _ = failed_restored_bundle(harness)
    environment = harness.call("bundle-environment").stdout.decode().strip()
    wrapper = harness.base / "bin" / "cp"
    wrapper.write_text(f'''#!{sys.executable}
import subprocess,sys
if {str(dependency)!r} in sys.argv:sys.exit(44)
sys.exit(subprocess.run([{shutil.which('cp')!r},*sys.argv[1:]]).returncode)
''')
    wrapper.chmod(0o755)
    result = harness.call("confirm-rollback", ident, environment)
    assert result.returncode != 0, "A partial configuration must never be accepted as validated"
    assert (op / "phase").read_text().strip() == "recovery_failed"
    assert (harness.root / "lock").exists()
    assert not list(harness.root.glob("stage.*"))

@pytest.mark.parametrize("role", ["worker", "recovery"])
def test_confirm_rollback_refuses_surviving_operation_process_group(harness, role):
    import signal
    ident, op, _ = failed_restored_bundle(harness)
    environment = harness.call("bundle-environment").stdout.decode().strip()
    leader = subprocess.Popen([sys.executable, "-c", "import subprocess,sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])"],
                              start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        leader.wait(timeout=5)
        os.killpg(leader.pid, 0)
        (op / (role + ".pid")).write_text(str(leader.pid))
        result = harness.call("confirm-rollback", ident, environment)
        assert result.returncode != 0, "A surviving child can still mutate the router after its session leader exits"
        assert (harness.root / "lock").exists()
        assert (op / "phase").read_text().strip() == "recovery_failed"
    finally:
        os.killpg(leader.pid, signal.SIGKILL)

@pytest.mark.parametrize("previous_state", ["running", "stopped"])
@pytest.mark.parametrize("phase", ["recovery_failed", "rolled_back"])
def test_confirm_rollback_preserves_previous_runtime_state(harness, previous_state, phase):
    ident, op, _ = failed_restored_bundle(harness)
    (op / "phase").write_text(phase)
    (op / "before.state").write_text(previous_state)
    (harness.base / "health").write_text(previous_state)
    environment = harness.call("bundle-environment").stdout.decode().strip()
    result = harness.call("confirm-rollback", ident, environment)
    assert result.returncode == 0, result.stderr
    assert not (harness.base / "calls").exists()
    assert (harness.base / "health").read_text() == previous_state
    assert not (harness.root / "lock").exists()

def test_confirm_rollback_retries_failed_terminal_barrier_without_early_unlock(harness):
    harness.enable_fsync()
    ident, op, _ = failed_restored_bundle(harness)
    environment = harness.call("bundle-environment").stdout.decode().strip()
    (harness.base / "fail-rollback-terminal-sync").touch()
    assert harness.call("confirm-rollback", ident, environment).returncode != 0
    assert (harness.root / "lock").exists()
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "finishing"
    assert not (op / "terminal.durable").exists()
    assert harness.call("confirm-rollback", ident, environment).returncode == 0
    assert json.loads(harness.call("status", ident).stdout)["phase"] == "rolled_back"
    assert not (harness.root / "lock").exists()
