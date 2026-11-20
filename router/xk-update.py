#!/opt/bin/python3
"""Offline router updates. All live writes go through a journaled local worker."""
import fcntl
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

OPT = Path(os.environ.get("XK_UPDATE_OPT", "/opt"))
ROOT = OPT / "var/lib/xk-switcher/updates"
OPS = ROOT / "operations"
LOCK = OPT / "var/lib/xk-switcher/routing/lock"
INIT = "etc/init.d/S05xkeen"
XRAY = "sbin/xray"
XKEEN = "sbin/xkeen"
INFO = "sbin/.xkeen/01_info/01_info_variable.sh"
TEMPLATE = "sbin/.xkeen/02_install/07_install_register/04_register_init.sh"
MODULES = "sbin/.xkeen/"
PKG_DB = "lib/opkg/status"
COMPONENTS = ("xkeen", "xray")
XRAY_LIMIT = 180 * 1024 * 1024
JOURNAL_RESERVE = 1024 * 1024
XKEEN_DIGEST = "4b9350b11fab7fd3e4973db609db0fb780994f4b5ab0096f0549bc52acac8c73"
# Files retired specifically by the 2.0 -> 2.1 release. Leave local additions
# alone and refuse removal if the administrator changed an obsolete script.
RETIRED_20 = {
    "01_info/03_info_router.sh": "896be34d57141f1dbbb85572b4db0ca6e9cc1fbe44fe5d85473cad8210aff3fc",
    "01_info/08_info_version/00_version_import.sh": "bbad6c690719dab71fda8da40cfa36ce60554e70e954c46e62948a3cf798bb17",
    "01_info/08_info_version/01_version_xkeen.sh": "b7925b1b462d33deb525490c66bdd04f15d02637f3c634b92cdcf69c94d7a8f1",
    "01_info/08_info_version/02_version_mihomo.sh": "c1f8c986c5907e8b95b9f40e4529682c7bca28756b217d58a07b6e462a246334",
    "01_info/08_info_version/02_version_xray.sh": "3cb47dedc4e6f506089378cf1ac719224b45b33fa7bb49eb8fcb9d7a07066e02",
    "05_tests/01_tests_connected.sh": "1557165ed2beaa887add3b23fef01af734f2969ef329ef1669a129bbbe2efe50",
}
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){1,3}")
INIT_OPTIONS = set("""name_client name_policy name_policy_full table_id table_mark custom_mark
dscp_enable dscp_force_proxy dscp_force_proxy_tag dscp_exclude dscp_proxy ipv4_proxy ipv4_exclude
ipv6_proxy ipv6_exclude proxy_dns proxy_router nfqws_mark pbr_strict start_verbose start_attempts
start_auto start_delay init_delay check_fd arm64_fd other_fd delay_fd ipv6_support extended_msg
backup aghfix""".split())
GATE = b"#!/bin/sh\necho 'Router update interrupted; use xk-update-recovery.' >&2\nexit 1\n"
TERMINAL = {"installed", "rolled_back", "start_failed", "rolled_back_start_failed", "rejected"}
PUBLIC = ("id", "phase", "component", "action", "version", "message", "duration_sec", "runtime")
VERIFY_WINDOW_SEC = 45
VERIFY_INTERVAL_SEC = 3
CONTROL_OUTPUT_LIMIT = 65536
READY_FILE = Path("/tmp/.xkeen/ready")

class Refused(Exception):
    pass

class Busy(Refused):
    pass

def require(condition, message):
    if not condition:
        raise Refused(message)

def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def atomic(path, source, mode=0o600, owner=None):
    """Write and sync a regular file on its destination filesystem."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".xku-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            if isinstance(source, bytes):
                out.write(source)
            else:
                with source.open("rb") as stream:
                    shutil.copyfileobj(stream, out)
            if owner:
                os.fchown(out.fileno(), *owner)
            os.fchmod(out.fileno(), mode)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        Path(tmp).unlink(missing_ok=True)

def save(path, obj):
    atomic(path, json.dumps(obj, sort_keys=True).encode())

def read(path):
    return json.loads(path.read_bytes())

def ledger():
    path = ROOT / "ledger.json"
    return read(path) if path.exists() else {"stack": [], "held": {}, "last": None}

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(262144), b""):
            h.update(chunk)
    return h.hexdigest()

def opdir(ident):
    require(str(uuid.UUID(ident)) == ident, "Invalid operation identifier")
    return OPS / ident

def record(ident):
    return read(opdir(ident) / "record.json")

def publish(rec, phase, message=""):
    rec.update(phase=phase, message=message)
    save(opdir(rec["id"]) / "record.json", rec)

def visible(rec):
    return {k: rec[k] for k in PUBLIC if k in rec}

def active_id():
    if not LOCK.is_symlink():
        return None
    target = Path(os.readlink(LOCK))
    if target.parent.parent != OPS or target.name != "lock":
        raise Refused("Unknown router operation lock")
    return str(uuid.UUID(target.parent.name))

def command(args, timeout=90):
    try:
        p = subprocess.Popen([str(arg) for arg in args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True,
                             env={**os.environ, "XKEEN_FOREGROUND": "1", "XRAY_LOCATION_ASSET": str(OPT / "etc/xray/dat")})
        try:
            output = p.communicate(timeout=timeout)[0]
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
            raise Refused("Local component command timed out")
    except OSError as error:
        raise Refused("Local component command unavailable") from error
    return p.returncode, output.decode(errors="replace")

def version(component):
    try:
        if component == "xkeen":
            match = re.search(r'^xkeen_current_version="([\d.]+)"', (OPT / INFO).read_text(), re.M)
        else:
            rc, out = command([OPT / XRAY, "version"], 10)
            match = not rc and re.match(r"Xray ([\d.]+)\b", out)
        return match.group(1) if match else None
    except (OSError, Refused):
        return None

class ServiceFailure(Refused):
    def __init__(self, outcome, output="", errno=None):
        super().__init__("Local XKeen service command " + ("timed out" if outcome == "timeout" else "unavailable"))
        self.outcome = outcome
        self.output = output
        self.errno = errno

def status_sample(timeout=20, unrecognized=None):
    try:
        rc, out = service_command("status", timeout=timeout)
    except ServiceFailure as error:
        return error.outcome, None
    normalized = re.sub(r"\x1b\[[0-9;]*m", "", out).lower()
    # Examine the service's own status lines. A warning containing "active"
    # or "not started" must never admit the next installation.
    lines = [line.strip() for line in normalized.splitlines()]
    prefix = r"(?:(?:прокси-клиент|proxy(?: client)?)(?: (?:xray|mihomo))? (?:is )?)?"
    if rc in (0, 1) and any(re.fullmatch(prefix + r"(?:не запущен|остановлен|not running|inactive|stopped)[.!]?", line) for line in lines):
        return "stopped", rc
    if rc == 0 and any(re.fullmatch(prefix + r"(?:запущен|running|active|started)(?: (?:в режиме|in) [\w -]+)?[.!]?", line) for line in lines):
        return "running", rc
    if unrecognized is not None:
        unrecognized.append(out)
    return "unknown", rc

def running():
    state, _ = status_sample()
    require(state in ("running", "stopped"), "Unknown local XKeen service state: " + state)
    return state == "running"

def control_reason(out):
    text = re.sub(r"\x1b\[[0-9;]*m", "", out).lower()
    for reason, terms in (
        ("rci_auth", ("токен доступа к rci",)),
        ("missing_utility", ("не найдена необходимая утилита", "необходим пакет")),
        ("firewall", ("не удалось применить netfilter", "не удалось записать netfilter")),
        ("config", ("ошибка конфигурации", "ошибки конфигурации", "failed to load config")),
        ("already_running", ("уже запущен",)),
        ("busy", ("занят другим процессом", "занята другим процессом")),
        ("start_failed", ("не удалось запустить",)),
        ("stop_failed", ("не удалось остановить",)),
    ):
        if any(term in text for term in terms):
            return reason
    return "other"

def run_control(args, timeout):
    # S05 can leave its proxy holding stderr. Capture the bounded tail while
    # S05 runs, then keep that descriptor writable without waiting for EOF.
    drainer = shutil.which("cat")
    if drainer is None:
        # A minimal Entware layout may have no external cat. Keep daemon I/O
        # safe and retain the exit/status diagnostics in this case.
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True, timeout=timeout)
        return result.returncode, ""
    tail = bytearray()
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                          start_new_session=True) as process:
        fd = process.stderr.fileno()
        os.set_blocking(fd, False)
        deadline = time.monotonic() + timeout
        eof = False

        def drain():
            nonlocal eof
            try:
                chunk = os.read(fd, CONTROL_OUTPUT_LIMIT)
            except BlockingIOError:
                return False
            if not chunk:
                eof = True
                return False
            tail.extend(chunk)
            del tail[:-CONTROL_OUTPUT_LIMIT]
            return True

        timed_out = False
        try:
            while process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, timeout)
                if eof:
                    process.wait(timeout=remaining)
                elif select.select([fd], [], [], min(.1, remaining))[0]:
                    drain()
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            if process.poll() is None:
                process.kill()  # only S05; the core and its descendants survive
                process.wait()
            # Bound the final drain even if the proxy writes continuously.
            for _ in range(2):
                if eof or not drain():
                    break
            if not eof:
                os.set_blocking(fd, True)
                subprocess.Popen([drainer], stdin=fd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        output = tail.decode(errors="replace")
        if timed_out:
            raise ServiceFailure("timeout", output)
        return process.returncode, output

def service_command(action, *arguments, timeout=120):
    args = [str(OPT / INIT), action, *arguments]
    try:
        if action != "status":
            return run_control(args, timeout)
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                    start_new_session=True, timeout=timeout)
            return result.returncode, os.pread(output.fileno(), CONTROL_OUTPUT_LIMIT, 0).decode(errors="replace")
    except subprocess.TimeoutExpired as error:
        raise ServiceFailure("timeout") from error
    except OSError as error:
        raise ServiceFailure("unavailable", errno=error.errno) from error

def route_guard(ident):
    return opdir(ident) / "lock"

def release(ident):
    if active_id() == ident:
        LOCK.unlink()
        fsync_dir(LOCK.parent)

def reap_completed_owner():
    # Called while holding the exclusive executor, including after a crash
    # between durable terminal publication and unlinking the routing guard.
    current_id = active_id()
    if current_id and record(current_id)["phase"] in TERMINAL:
        release(current_id)

def process_lock(shared=False):
    fd = os.open(ROOT / "executor.lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Busy("Another update or route check is running")
    return fd

def free_executor():
    try:
        fd = process_lock()
    except Busy:
        return False
    os.close(fd)
    return True

def status(ident):
    path = opdir(ident) / "record.json"
    if not path.exists():
        saved = ledger().get("receipt") or {}
        if saved.get("id") == ident and saved.get("phase") in TERMINAL and not os.path.lexists(LOCK) and free_executor():
            return visible(saved)
        return {"id": ident, "phase": "unknown"}
    rec = record(ident)
    if rec["phase"] not in TERMINAL:
        if free_executor():
            rec["phase"] = "interrupted" if active_id() == ident else "rejected"
        elif rec["phase"] == "interrupted":
            rec["phase"] = "restoring"
    return visible(rec)

def plan(stack, component):
    for pos in reversed(range(len(stack))):
        if record(stack[pos])["component"] == component:
            return stack[pos:][::-1]
    return []

def inventory():
    state = ledger()
    ident = active_id()
    parts = {}
    missing = missing_snapshot_records(state)
    for name in COMPONENTS:
        chain = [] if missing else [record(i) for i in plan(state["stack"], name)]
        parts[name] = {"installed": version(name), "rollback_version": chain[-1]["from"] if chain else None,
                       "rollback_plan": [{"component": r["component"], "from": r["version"], "to": r["from"]} for r in chain]}
    revision = revision_of(state)
    return {"arch": architecture(os.uname().machine, sys.byteorder, sys.maxsize), "components": parts,
            "revision": revision, "held": state["held"], "snapshot_error": "Restore point metadata missing" if missing else None,
            "routing_busy": os.path.lexists(LOCK) and not ident,
            "active": status(ident) if ident else None, "last": status(state["last"]) if state["last"] else None}

def revision_of(state):
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()

def missing_snapshot_records(state):
    return any(not (opdir(i)/"record.json").is_file() for i in state["stack"])

def architecture(machine, byteorder, maxsize):
    if machine.lower().startswith("mips"):
        family = "mips64" if maxsize > 2**32 else "mips"
        return family + ("el" if byteorder == "little" else "be")
    return machine

def version_key(value):
    return tuple(map(int, value.split(".")))

def hold_release(state, component, version):
    previous = state["held"].get(component)
    if previous is None or version_key(version) > version_key(previous):
        state["held"][component] = version

def disk_path(name):
    path = OPT / name
    require(not Path(name).is_absolute() and ".." not in Path(name).parts and path.resolve() == OPT.resolve() / name,
            "A managed path is a symlink or outside Entware")
    return path

def file_info(path):
    if not path.exists():
        return None
    st = path.lstat()
    require(stat.S_ISREG(st.st_mode), "Managed path is not a regular file")
    return [digest(path), stat.S_IMODE(st.st_mode), st.st_uid, st.st_gid]

def pkg_section(component, data):
    name = b"xkeen" if component == "xkeen" else b"xray_s"
    parts = re.split(rb"(\r?\n\r?\n+)", data)
    matches = [i for i in range(0, len(parts), 2) if re.search(rb"^Package: "+name+rb"\r?$", parts[i], re.M)]
    require(len(matches) == 1, "Unrecognized Entware package registration")
    return parts, matches[0]

def current(name, component, scratch):
    path = disk_path(name)
    if name == PKG_DB:
        parts, i = pkg_section(component, path.read_bytes())
        st = path.stat()
        atomic(scratch, parts[i], stat.S_IMODE(st.st_mode), (st.st_uid, st.st_gid))
        return scratch
    return path

def validate_xray(binary):
    rc, _ = command([binary, "run", "-test", "-confdir", OPT / "etc/xray/configs"])
    require(not rc, "Xray rejected the current configuration")

def add_registration(files, component, old, new):
    pkg = "xkeen" if component == "xkeen" else "xray_s"
    control = "lib/opkg/info/"+pkg+".control"
    for name in (control, PKG_DB):
        path = disk_path(name)
        if not path.exists():
            continue
        data = path.read_bytes()
        if name == PKG_DB:
            if not re.search(rb"^Package: "+pkg.encode()+rb"\r?$", data, re.M):
                continue
            chunks, pos = pkg_section(component, data)
            data = chunks[pos]
        pattern = rb"^Version: (v?)"+re.escape(old.encode())+rb"(\r?)$"
        data, count = re.subn(pattern, lambda m: b"Version: "+m[1]+new.encode()+m[2], data, flags=re.M)
        require(count == 1, "Entware version differs from installed component")
        files[name] = (data, stat.S_IMODE(path.stat().st_mode))
    listing = "lib/opkg/info/xkeen.list"
    if component == "xkeen" and disk_path(listing).exists():
        lines = disk_path(listing).read_text().splitlines()
        replaced = {"/opt/"+name for name in files if name.startswith(MODULES)}
        kept = [p for p in lines if p not in replaced]
        kept.extend("/opt/"+name for name in sorted(files) if name.startswith(MODULES) and files[name][0] is not None)
        files[listing] = (("\n".join(kept)+"\n").encode(), stat.S_IMODE(disk_path(listing).stat().st_mode))

def xkeen_files(payload):
    require(digest(payload) == XKEEN_DIGEST, "Unsupported XKeen release artifact")
    for legacy in ("etc/init.d/S99xkeen", "etc/init.d/S24xray", "etc/init.d/S99xkeenstart", "sbin/_xkeen"):
        require(not (OPT / legacy).exists(), "Legacy XKeen layout requires manual migration")
    for required in ("ip_exclude.lst", "port_exclude.lst", "port_proxying.lst", "xkeen.json"):
        require(disk_path("etc/xkeen/"+required).is_file(), "Incomplete XKeen configuration")
    files = {}
    with tarfile.open(payload, "r:gz") as archive:
        for member in archive:
            require(member.isfile() and (member.name == "xkeen" or member.name.startswith("_xkeen/"))
                    and ".." not in Path(member.name).parts, "Unexpected XKeen release file")
            name = XKEEN if member.name == "xkeen" else MODULES+member.name[len("_xkeen/"):]
            files[name] = (archive.extractfile(member).read(), member.mode & 0o777)
    files[XKEEN] = (files[XKEEN][0], 0o755)
    # Migrate the settings supported by upstream register_xkeen_initd. Reject other
    # local edits instead of overwriting an administrator's customized init script.
    def normalize(blob):
        settings = {}
        lines = []
        for line in blob.splitlines(keepends=True):
            var = line.partition(b"=")[0].decode(errors="replace")
            if var in INIT_OPTIONS and var not in settings:
                settings[var] = line
                lines.append((var+"=\n").encode())
            else:
                lines.append(line)
        return settings, lines
    settings, original = normalize(disk_path(INIT).read_bytes())
    require(original == normalize(disk_path(TEMPLATE).read_bytes())[1], "Customized XKeen startup script")
    staged = files[TEMPLATE][0]
    for key, line in normalize(staged)[0].items():
        if key in settings:
            staged = staged.replace(line, settings[key], 1)
    files[INIT] = (staged, 0o755)
    for relative, expected in RETIRED_20.items():
        name = MODULES+relative
        path = disk_path(name)
        if path.is_file():
            require(digest(path) == expected, "Retired XKeen module contains local edits")
            files[name] = (None, 0)
    return files

def staged_files(rec, folder):
    payload = folder / "payload"
    component, old, new = rec["component"], rec["from"], rec["version"]
    require(version(component) == old, "Installed version changed")
    require(version_key(new) > version_key(old), "Target is not newer")
    if component == "xray":
        payload.chmod(0o755)
        rc, out = command([payload, "version"], 10)
        require(not rc and out.startswith("Xray "+new+" "), "Wrong Xray architecture or version")
        validate_xray(payload)
        files = {XRAY: (payload, 0o755)}
    else:
        require((old, new) == ("2.0", "2.1"), "Unsupported XKeen transition")
        files = xkeen_files(payload)
    add_registration(files, component, old, new)
    return files

def prepare(rec):
    folder = opdir(rec["id"])
    files = staged_files(rec, folder)
    # Reserve enough space for all backups, all staged bytes and the largest
    # same-filesystem atomic replacement before changing the first live file.
    staged_size = backup_size = largest = 0
    for name, (source, _) in files.items():
        path = disk_path(name)
        old_size = path.stat().st_size if path.exists() else 0
        size = source.stat().st_size if isinstance(source, Path) else len(source or b"")
        staged_size += size
        backup_size += old_size
        largest = max(largest, size, old_size)
    require(shutil.disk_usage(folder).free >= staged_size + backup_size + largest + JOURNAL_RESERVE,
            "Insufficient storage for staging and rollback")
    rec["running"] = running()
    manifest = {}
    for name, (source, mode) in files.items():
        path = current(name, rec["component"], folder/"scratch")
        before = file_info(path)
        after_path = folder/"after"/name
        if source is not None:
            owner = before[2:] if before else None
            atomic(after_path, source, mode, owner)
        after = file_info(after_path)
        if before == after:
            continue
        if before:
            atomic(folder/"before"/name, path, before[1], before[2:])
        manifest[name] = [before, after]
    require(manifest, "Release has no component changes")
    rec["files"] = manifest
    # All snapshot ancestors, including subdirectories, must be durable before publication.
    os.sync() if hasattr(os, "sync") else subprocess.run(["sync"], check=True)
    publish(rec, "preparing")

def preflight(rec, restore=False, partial=False, projected=None):
    folder = opdir(rec["id"])
    for name, (before, after) in rec["files"].items():
        side, expected = ("before", before) if restore else ("after", after)
        src = folder/side/name
        require(file_info(src) == expected, "Damaged local snapshot")
        key = (name, rec["component"] if name == PKG_DB else None)
        if projected is not None and key in projected:
            live = projected[key]
        else:
            live = file_info(current(name, rec["component"], folder/"scratch"))
        permitted = [before, after] if partial else [after if restore else before]
        gate_installed = name == INIT and partial and disk_path(INIT).read_bytes() == GATE
        require(gate_installed or live in permitted, "Managed files changed; restore would overwrite a later edit")
        if projected is not None:
            projected[key] = expected
    if restore and XRAY in rec["files"]:
        validate_xray(folder/"before"/XRAY)

@contextlib.contextmanager
def package_lock():
    # Entware builds opkg with LOCK_FILE=/opt/tmp/opkg.lock and takes a
    # POSIX lockf write lock. Release before S05 (it may query opkg itself).
    if not (OPT / PKG_DB).exists():
        yield
        return
    path = OPT / "tmp/opkg.lock"
    with path.open("a+b") as stream:
        try:
            fcntl.lockf(stream, fcntl.LOCK_EX | fcntl.LOCK_NB, 0, 0)
        except BlockingIOError as error:
            raise Busy("Entware package manager is busy") from error
        require(os.path.samestat(path.stat(), os.fstat(stream.fileno())), "Entware package lock changed")
        try:
            yield
        finally:
            if path.exists() and os.path.samestat(path.stat(), os.fstat(stream.fileno())):
                path.unlink()

def apply_files(rec, restore):
    with package_lock():
        for name in rec["files"]:
            if name.startswith("lib/opkg/"):
                live = current(name, rec["component"], opdir(rec["id"])/"scratch")
                require(file_info(live) in rec["files"][name], "Entware registration changed")
        replace_files(rec, restore)

def replace_files(rec, restore):
    folder = opdir(rec["id"])
    side, index = ("before", 0) if restore else ("after", 1)
    # Before replacing any XKeen module, interpose a fail-closed S05 script.
    # On reboot only the intact new/old set can run, even without the switcher server.
    if INIT in rec["files"]:
        atomic(disk_path(INIT), GATE, 0o755)
    names = sorted(rec["files"], key=lambda name: name == INIT)
    for name in names:
        info = rec["files"][name][index]
        path = disk_path(name)
        src = folder/side/name
        if name == PKG_DB:
            parts, pos = pkg_section(rec["component"], path.read_bytes())
            parts[pos] = src.read_bytes()
            atomic(path, b"".join(parts), info[1], info[2:])
        elif info is None:
            if path.exists():
                path.unlink()
                fsync_dir(path.parent)
        else:
            atomic(path, src, info[1], info[2:])

def core_processes(name):
    # PID plus Linux start ticks distinguishes a surviving pre-update daemon
    # from a replacement, even after PID reuse. Ignore zombies.
    if not name:
        return None
    try:
        processes = set()
        for pid in Path("/proc").iterdir():
            if not pid.name.isdecimal():
                continue
            try:
                line = (pid/"stat").read_bytes()
            except (FileNotFoundError, ProcessLookupError):
                continue
            comm, _, tail = line.rpartition(b") ")
            fields = tail.split()
            if comm.partition(b"(")[2] == name and fields[0] != b"Z":
                processes.add((pid.name, fields[19]))
        return frozenset(processes)
    except (OSError, IndexError):
        return None

def local_stderr(rec, action, output):
    # Keep an unexplained S05 error on the router only, away from status, HTTP
    # and TUI output. Omit complete lines containing credentials or raw JSON.
    if not output.strip():
        return False
    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
    sensitive = re.compile(r"://|authorization|token|secret|passw|credential|subscription|uuid|"
                           r"(?:private|public|api)[ _-]?key|парол|токен|[{}]|[a-z0-9_=-]{30,}", re.I)
    lines = ["[redacted]" if sensitive.search(line) else "".join(c for c in line if c.isprintable())[:300]
             for line in clean.splitlines()[-20:] if line.strip()]
    if not lines:
        return False
    atomic(opdir(rec["id"])/(rec["phase"] + "-" + action + ".stderr"), ("\n".join(lines) + "\n").encode())
    return True

def record_control(rec, action, *args):
    runtime = rec["runtime"]
    runtime.update(action=action, control="pending")
    publish(rec, rec["phase"], "Running local XKeen service command")
    try:
        rc, out = service_command(action, *args)
        runtime.update(rc=rc, control="nonzero" if rc else "ok")
    except ServiceFailure as error:
        out = error.output
        runtime.update(control=error.outcome, control_errno=error.errno)
    if runtime["control"] != "ok":
        runtime["reason"] = control_reason(out)
        if runtime["reason"] == "other":
            with contextlib.suppress(OSError):
                runtime["stderr_saved"] = local_stderr(rec, action, out)

def ready_stamp():
    try:
        st = READY_FILE.stat()
        if stat.S_ISREG(st.st_mode):
            return st.st_ino, st.st_ctime_ns, st.st_mtime_ns
    except OSError:
        pass
    return None

def health_after(rec, want_running):
    started = time.monotonic()
    runtime = {"action": "verify", "control": "not_needed", "rc": None, "control_errno": None,
               "reason": None, "last_status": "unknown", "status_rc": None, "attempts": 0, "elapsed_sec": 0,
               "process": "not_needed", "ready": None, "consecutive": 0}
    rec["runtime"] = runtime
    previous = None
    name = None
    uses_ready = False
    previous_ready = None
    if want_running:
        try:
            script = (OPT / INIT).read_bytes()
        except OSError:
            script = b""
        client = re.search(rb'^name_client="(xray|mihomo)"', script, re.M)
        name = client.group(1) if client else None
        previous = core_processes(name)
        uses_ready = b': > "$xkeen_rundir/ready"' in script
        previous_ready = ready_stamp() if uses_ready else None
        record_control(rec, "restart", "on")
    deadline = time.monotonic() + VERIFY_WINDOW_SEC
    streak = 0
    last_processes = None
    unrecognized = []
    while time.monotonic() < deadline:
        unrecognized.clear()
        observed, rc = status_sample(timeout=min(5, max(.001, deadline - time.monotonic())), unrecognized=unrecognized)
        runtime.update(last_status=observed, status_rc=rc, attempts=runtime["attempts"] + 1)
        if want_running:
            current = core_processes(name)
            replacement = "unknown"
            if previous is not None and current:
                replacement = "replaced" if previous.isdisjoint(current) else "unchanged"
            ready = None
            if uses_ready:
                stamp = ready_stamp()
                ready = stamp is not None and (runtime["control"] == "ok" or stamp != previous_ready)
            runtime.update(process=replacement, ready=ready)
            healthy = (observed == "running" and ready is not False and replacement != "unchanged"
                       and (current is None or bool(current)))
            if runtime["control"] != "ok":
                healthy = healthy and replacement == "replaced" and runtime["reason"] != "firewall"
            if current != last_processes:
                streak = 0
            last_processes = current
        else:
            healthy = observed == "stopped"
            if observed == "running" and runtime["action"] == "verify":
                record_control(rec, "stop")
                deadline = time.monotonic() + VERIFY_WINDOW_SEC
        streak = streak + 1 if healthy else 0
        runtime.update(consecutive=streak, elapsed_sec=math.ceil(time.monotonic() - started))
        publish(rec, rec["phase"], "Verifying local XKeen service state")
        if streak >= 2:
            return True
        time.sleep(min(VERIFY_INTERVAL_SEC, max(0, deadline - time.monotonic())))
    if unrecognized:
        with contextlib.suppress(OSError):
            if local_stderr(rec, "status", unrecognized[0]):
                runtime["stderr_saved"] = True
    return False

def check_applied(rec, restore):
    for name, pair in rec["files"].items():
        require(file_info(current(name, rec["component"], opdir(rec["id"])/"scratch")) == pair[0 if restore else 1],
                "Installed bytes do not match the snapshot")

def finish(rec, phase, state, message=""):
    # Preserve the most recent restore point per component and each dependent
    # update since the oldest of those points. Other backups may be reclaimed.
    last_by_component = {record(i)["component"]: pos for pos, i in enumerate(state["stack"])}
    cut = min(last_by_component.values(), default=0)
    expired = state["stack"][:cut]
    state["stack"] = state["stack"][cut:]
    state["last"] = rec["id"]
    state["receipt"] = visible({**rec, "phase": phase, "message": message})
    state["receipt_request"] = rec.get("request")
    save(ROOT/"ledger.json", state)
    publish(rec, phase, message)
    release(rec["id"])
    # Only the old bytes are needed for user-selected rollback.
    folder = opdir(rec["id"])
    (folder/"payload").unlink(missing_ok=True)
    shutil.rmtree(folder/"after", ignore_errors=True)
    if rec["id"] not in state["stack"]:
        shutil.rmtree(folder/"before", ignore_errors=True)
    for ident in expired:
        shutil.rmtree(opdir(ident)/"before", ignore_errors=True)

def complete(rec, state, restore, run_state, started=None):
    if not health_after(rec, run_state):
        if restore:
            finish(rec, "rolled_back_start_failed", state, "Previous files restored; local service control failed")
            return True
        finish(rec, "start_failed", state, "Files installed; local service control failed")
        return False
    if started is not None:
        rec["duration_sec"] = max(1, math.ceil(time.monotonic() - started))
    finish(rec, "rolled_back" if restore else "installed", state)
    return True

def restore_plan(rec, state):
    ids = rec["plan"]
    # Simulate the remaining stack, including multiple releases of one component.
    # The second snapshot expects the first snapshot's result, not today's bytes.
    records = [record(i) for i in ids]
    done = rec.get("done", 0)
    completed = {}
    for old in records[:done]:
        for name, (before, _) in old["files"].items():
            key = (name, old["component"] if name == PKG_DB else None)
            completed[key] = (old, before)
    allowed_partial = rec["phase"] in ("restoring", "interrupted")
    for (name, package), (old, before) in completed.items():
        if allowed_partial and done < len(records) and name in records[done]["files"] and (not package or package == records[done]["component"]):
            continue
        require(file_info(current(name, old["component"], opdir(rec["id"])/"scratch")) == before,
                "A completed restore step was externally changed")
    projected = {}
    largest = growth = 0
    projected_sizes = {}
    for n, old in enumerate(records[done:]):
        preflight(old, True, partial=(allowed_partial and n == 0), projected=projected)
        for name in old["files"]:
            key = (name, old["component"] if name == PKG_DB else None)
            live = disk_path(name)
            size = projected_sizes.get(key, live.stat().st_size if live.exists() else 0)
            snap = opdir(old["id"])/"before"/name
            target_size = snap.stat().st_size if snap.exists() else 0
            if name == PKG_DB:
                # Changes splice one component's paragraph into the full database.
                target_size += size
            largest = max(largest, target_size)
            growth += max(target_size-size, 0)
            projected_sizes[key] = target_size
    require(shutil.disk_usage(ROOT).free >= largest + growth + JOURNAL_RESERVE,
            "Insufficient space to restore the selected components")
    publish(rec, "restoring")
    for n in range(rec.get("done", 0), len(records)):
        old = records[n]
        apply_files(old, True)
        check_applied(old, True)
        rec["done"] = n + 1
        publish(rec, "restoring")
    for old in records:
        hold_release(state, old["component"], old["version"])
        if old["id"] in state["stack"]:
            state["stack"].remove(old["id"])
    if not complete(rec, state, True, rec["running"]):
        return
    for old in records:
        if old["id"] not in state["stack"]:
            shutil.rmtree(opdir(old["id"])/"before", ignore_errors=True)

def worker(ident, fd, recover=False):
    started = time.monotonic()
    rec = record(ident)
    state = ledger()
    if rec["phase"] in TERMINAL:
        release(ident)
        return
    try:
        if rec["action"] == "rollback":
            if rec["phase"] == "preparing":
                rec["running"] = running()
                latest = record(rec["plan"][0])
                if latest["phase"] == "start_failed":
                    # A failed upgrade may itself have stopped the previously
                    # running proxy. Recover its pre-install runtime state.
                    rec["running"] = latest["running"]
            restore_plan(rec, state)
        elif recover:
            if rec["phase"] == "preparing":
                finish(rec, "rejected", state, "Interrupted before live writes")
                return
            preflight(rec, True, partial=True)
            publish(rec, "restoring")
            apply_files(rec, True)
            check_applied(rec, True)
            hold_release(state, rec["component"], rec["version"])
            if ident in state["stack"]:
                state["stack"].remove(ident)
            complete(rec, state, True, rec["running"])
        else:
            require(rec["phase"] == "preparing", "Installation already started")
            prepare(rec)
            preflight(rec)
            require(not any_geodata_process(), "GeoData update in progress")
            expiry = rec.get("expiry")
            require(expiry is None or time.time() < int(expiry), "Scheduled installation window closed")
            publish(rec, "installing")
            apply_files(rec, False)
            check_applied(rec, False)
            if ident not in state["stack"]:
                state["stack"].append(ident)
            held = state["held"].get(rec["component"])
            if held and version_key(rec["version"]) >= version_key(held):
                del state["held"][rec["component"]]
            complete(rec, state, False, rec["running"], started)
    except Exception as error:
        message = str(error) if isinstance(error, Refused) else "Local update failed"
        if rec["phase"] == "preparing":
            finish(rec, "rejected", state, message)
        else:
            publish(rec, "interrupted", message)
    finally:
        os.close(fd)

def any_geodata_process():
    proc = Path("/proc")
    if not proc.is_dir():
        return False
    for name in proc.glob("[0-9]*/cmdline"):
        try:
            args = name.read_bytes().split(b"\0")
        except OSError:
            continue
        if b"-ug" in args and any(arg.split(b"/")[-1] == b"xkeen" for arg in args):
            return True
    return False

def spawn(ident, fd, recover=False):
    # Pass the same flock open-file description to the detached worker: there
    # is no unowned interval between acceptance and the first write.
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_work", ident, str(fd), str(int(recover))],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True, pass_fds=(fd,))

def launch(action, ident, comp, old, new, token, expiry=None):
    require(comp in COMPONENTS and isinstance(old, str) and isinstance(new, str) and
            VERSION.fullmatch(old) and VERSION.fullmatch(new), "Invalid component or version")
    require(re.fullmatch(r"[0-9a-f]{64}", token), "Invalid release digest or restore revision")
    folder = opdir(ident)
    require(expiry is None or (action == "install" and re.fullmatch(r"[0-9]{1,12}", expiry)), "Invalid expiry")
    request = [action, comp, old, new, token, expiry]
    def repeat():
        existing = record(ident)
        require(existing["request"] == request, "Identifier reused for different request")
        return status(ident)
    if (folder/"record.json").exists():
        return repeat()
    fd = process_lock()
    uploaded = False
    try:
        reap_completed_owner()
        if (folder/"record.json").exists():
            return repeat()
        state = ledger()
        if state.get("last") == ident:
            if os.path.lexists(LOCK):
                raise Busy("Router busy; finish the active operation")
            require(state.get("receipt_request") == request, "Identifier reused for different request")
            require((state.get("receipt") or {}).get("phase") in TERMINAL, "Incomplete terminal receipt")
            return visible(state["receipt"])
        # An admitted ID with a damaged journal must never be classified as
        # definitely expired. The guard directory persists after completion.
        require(ident not in state["stack"] and not (folder/"lock").exists(), "Local update state unavailable")
        require(expiry is None or time.time() < int(expiry), "Scheduled installation window closed")
        if os.path.lexists(LOCK):
            raise Busy("Router busy; finish the active operation")
        if any_geodata_process():
            raise Busy("GeoData update in progress")
        require(not missing_snapshot_records(state), "Restore point metadata missing")
        actual_version = version(comp)
        chain = []
        if action == "rollback":
            require(revision_of(state) == token, "Restore point changed")
            chain = plan(state["stack"], comp)
            require(chain and record(chain[-1])["from"] == new, "Restore target unavailable")
            if actual_version is None:
                # The binary may no longer execute. Its journaled identity is
                # independently verified against every live file in preflight.
                actual_version = record(chain[-1])["version"]
        require(actual_version == old, "Installed version changed")
        folder.mkdir(exist_ok=True)
        if action == "install":
            size = 0
            h = hashlib.sha256()
            with (folder/"payload").open("wb") as out:
                uploaded = True
                while True:
                    chunk = sys.stdin.buffer.read(262144)
                    if not chunk:
                        break
                    size += len(chunk)
                    require(size <= (XRAY_LIMIT if comp == "xray" else 2 * 1024 * 1024), "Artifact too large")
                    require(shutil.disk_usage(folder).free > len(chunk) + JOURNAL_RESERVE, "Insufficient staging space")
                    out.write(chunk)
                    h.update(chunk)
                out.flush()
                os.fsync(out.fileno())
            require(size and h.hexdigest() == token, "Artifact checksum mismatch")
            require(expiry is None or time.time() < int(expiry), "Scheduled installation window closed")
        # All recovery data is on the same persistent volume as Entware.
        (folder/"lock").mkdir(exist_ok=True)
        atomic(folder/"lock"/"owner", ("update-"+ident+"\n").encode())
        rec = {"id": ident, "action": action, "request": request, "component": comp, "from": old,
               "version": new, "plan": chain, "done": 0, "expiry": expiry}
        publish(rec, "preparing")
        fsync_dir(OPS)
        try:
            os.symlink(route_guard(ident), LOCK)
        except FileExistsError:
            publish(rec, "rejected", "Router busy")
            (folder/"payload").unlink(missing_ok=True)
            return visible(rec)
        fsync_dir(LOCK.parent)
        spawn(ident, fd)
        return visible(rec)
    finally:
        if uploaded and not (folder/"record.json").exists():
            (folder/"payload").unlink(missing_ok=True)
        os.close(fd)

def recover_id(ident):
    fd = process_lock()
    try:
        require(active_id() == ident, "Operation no longer owns recovery")
        rec = record(ident)
        if rec["phase"] in TERMINAL:
            release(ident)
        else:
            spawn(ident, fd, True)
            return {**visible(rec), "phase": "restoring"}
        return visible(rec)
    finally:
        os.close(fd)

def ask(text):
    try:
        return input(text).strip().lower()
    except (KeyboardInterrupt, EOFError):
        return "q"

def tui():
    while True:
        try:
            fd = process_lock()
        except Busy:
            pass
        else:
            try:
                reap_completed_owner()
            finally:
                os.close(fd)
        view = inventory()
        print("\nRouter update recovery\n")
        for name, part in view["components"].items():
            print("  %s installed: %s" % (name, part["installed"] or "unknown"))
        active = view["active"]
        if view["routing_busy"]:
            print("A routing operation holds the router lock. Recovery cannot start.")
            if ask("[Enter] Refresh   [q] Quit: ") == "q":
                return
            continue
        if active:
            print("\nOperation %s: %s" % (active["id"], active["phase"]))
            if active["phase"] != "interrupted":
                if ask("[Enter] Refresh   [q] Quit: ") == "q":
                    return
                continue
            print("1. Recover interrupted operation (restore previous files or finish this rollback)")
            saved = record(active["id"])
            if saved["action"] == "install":
                print("  %s: return from %s to its pre-install version %s" %
                      (saved["component"], saved["version"], saved["from"]))
            else:
                for index, ident in enumerate(saved["plan"]):
                    step = record(ident)
                    state = "restored" if index < saved["done"] else "pending"
                    print("  %s: %s -> %s (%s)" % (step["component"], step["version"], step["from"], state))
            if active.get("message"):
                print(active["message"])
            choice = ask("Choose 1, or q to quit: ")
            if choice == "q":
                return
            if choice == "1" and ask("Use the local snapshot now? [1] Restore  [Enter] Cancel: ") == "1":
                try:
                    print(recover_id(active["id"])["phase"])
                except Refused as error:
                    print(str(error))
            continue
        last = view["last"]
        if last:
            print("Last operation: %s %s · %s" % (last["component"], last["version"], last["phase"]))
            if last.get("message"):
                print(last["message"])
            runtime = last.get("runtime")
            if runtime:
                print("Service: %s %s (rc %s); status %s after %d checks in %ds" %
                      (runtime["action"], runtime["control"], runtime["rc"], runtime["last_status"],
                       runtime["attempts"], runtime["elapsed_sec"]))
                folder = opdir(last["id"])
                if (folder/"record.json").is_file():
                    print("Diagnostics:", folder/"record.json")
                if runtime.get("stderr_saved"):
                    for path in sorted(folder.glob("*.stderr")):
                        print("Local service output:", path)
        available = [n for n in COMPONENTS if view["components"][n]["rollback_plan"]]
        if view["snapshot_error"]:
            print(view["snapshot_error"])
        for pos, name in enumerate(available, 1):
            print("%d. Restore %s %s" % (pos, name, view["components"][name]["rollback_version"]))
        if not available:
            print("No local restore points.")
        choice = ask("Choose a restore point, h for history, Enter to refresh, q to quit: ")
        if choice == "q":
            return
        if choice == "h":
            paths = sorted(OPS.glob("*/record.json"), key=lambda p: p.stat().st_mtime, reverse=True)
            for path in paths[:12]:
                rec = read(path)
                print("  %s %s %s -> %s: %s" % (rec["action"], rec["component"], rec["from"], rec["version"], rec["phase"]))
            if ask("[Enter] Back  [q] Quit: ") == "q":
                return
            continue
        if not choice.isdecimal() or int(choice) not in range(1, len(available)+1):
            continue
        name = available[int(choice)-1]
        part = view["components"][name]
        if part["installed"] is None:
            print("Current version unreadable. Restore requires the installed files to match the snapshot manifest.")
        for step in part["rollback_plan"]:
            print("  %s: %s -> %s" % (step["component"], step["from"], step["to"]))
        choice = ask("Connections may drop. [1] Restore  [0] Back  [q] Quit: ")
        if choice == "q":
            return
        if choice == "1":
            try:
                print(launch("rollback", str(uuid.uuid4()), name, part["installed"] or part["rollback_plan"][-1]["from"],
                             part["rollback_version"], view["revision"])["phase"])
            except Refused as e:
                print(str(e))

def main(args):
    OPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    args = list(args)
    if args == ["inventory"]:
        return inventory()
    if args == ["tui"]:
        tui()
        return
    if len(args) == 2 and args[0] == "status":
        return status(args[1])
    if len(args) == 2 and args[0] == "recover":
        return recover_id(args[1])
    if len(args) in (6, 7) and args[0] in ("install", "rollback"):
        return launch(*args)
    if len(args) == 4 and args[0] == "_work":
        return worker(args[1], int(args[2]), args[3] == "1")
    if args == ["boot"]:
        ident = active_id()
        if ident and free_executor():
            rec = record(ident)
            if rec["phase"] in TERMINAL:
                release(ident)
            elif rec["phase"] == "preparing":
                finish(rec, "rejected", ledger(), "Interrupted before live writes")
            else:
                publish(rec, "interrupted", "Reboot interrupted the operation. Use recovery.")
        return
    if args[:2] == ["probe", "sh"]:
        fd = process_lock(shared=True)
        if active_id():
            raise Busy("Router update in progress")
        os.set_inheritable(fd, True)
        os.execvp("sh", args[1:])
    raise Refused("Invalid router update command")

if __name__ == "__main__":
    os.umask(0o077)
    try:
        result = main(sys.argv[1:])
        if result is not None:
            print(json.dumps(result, separators=(",", ":")))
    except Busy as error:
        print("xk-update: " + str(error), file=sys.stderr)
        sys.exit(3)
    except (Refused, ValueError, OSError) as error:
        print("xk-update: " + (str(error) if isinstance(error, Refused) else "Local update state unavailable"), file=sys.stderr)
        sys.exit(1)
