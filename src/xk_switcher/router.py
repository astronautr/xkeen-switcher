"""Push an outbounds JSON to the Keenetic via SSH, or run arbitrary xkeen commands.

Supports two auth modes:
  - key-based (default): needs ssh_key + known_hosts
  - password-based: set password. Requires `sshpass` on PATH.
Host key is always verified against known_hosts.
"""
import json
import base64
import shlex
import signal
import time
import os
import shutil
import subprocess
import threading
import io
import hashlib
import tarfile
from pathlib import Path
from . import routing
from . import jsonc
from .routing import RoutingError
from .routing_store import atomic
from . import device_routing
from . import route_probe

SSH_CONNECT_TIMEOUT_SEC = 5
SSH_EXEC_TIMEOUT_SEC = 15
SSH_ACCEPT_TIMEOUT_SEC = 30
SSH_STATUS_TIMEOUT_SEC = 15
MOCK_HOST = "mock"
REMOTE_APPLY = "/opt/bin/xk-apply"
REMOTE_OUTBOUND_PATH = "/opt/etc/xray/configs/04_outbounds.json"
REMOTE_ROUTING = "/opt/bin/xk-routing"
REMOTE_ROUTING_PATH = "/opt/etc/xray/configs/05_routing.json"
SSHPASS_ENV = "SSHPASS"
MOCK_PROBE_DELAY_SEC = 0.6
PROBE_POLL_SEC = 0.25

class RouterError(Exception):
    pass

class Router:
    def __init__(
        self,
        host: str,
        user: str = "root",
        port: int = 22,
        ssh_key: str = "/root/.ssh/id_ed25519",
        known_hosts: str = "/root/.ssh/known_hosts",
        password: str | None = None,
        mock_data_dir=None,
    ):
        self.host = host
        self.user = user
        self.port = port
        self.ssh_key = ssh_key
        self.known_hosts = known_hosts
        self.password = password
        self._op_lock = threading.Lock()
        self._mock_routing = MOCK_ROUTING
        self._mock_operations = {}
        self._software = {"versions": {"xkeen": "2.0", "xray": "26.3.27"}, "steps": [], "ops": {}, "held": {}}
        self.mock_update_time = time.time
        self._mock_xkeen = "running"
        self._mock_outbound = b'{"outbounds":[]}'
        self._mock_overlay = None
        self.mock_probe_delay = MOCK_PROBE_DELAY_SEC
        self.mock_probe_outcomes = {}
        self._mock_file = Path(mock_data_dir) / "routing" / "mock-router.json" if host == MOCK_HOST and mock_data_dir is not None else None
        if self._mock_file and self._mock_file.exists():
            doc = json.loads(self._mock_file.read_bytes())
            self._mock_routing = base64.b64decode(doc["routing"],validate=True)
            self._mock_operations = doc["operations"]
            self._software = doc.get("software", self._software)
            self._mock_xkeen = doc["xkeen"]
            self._mock_outbound = base64.b64decode(doc.get("outbound", "eyJvdXRib3VuZHMiOltdfQ=="))
            self._mock_overlay = base64.b64decode(doc["overlay"]) if doc.get("overlay") else None

    def _save_mock(self):
        if self._mock_file:
            atomic(self._mock_file,json.dumps({"routing":base64.b64encode(self._mock_routing).decode(),
                   "operations":self._mock_operations,"software":self._software,"xkeen":self._mock_xkeen,
                   "outbound":base64.b64encode(self._mock_outbound).decode(),
                   "overlay":base64.b64encode(self._mock_overlay).decode() if self._mock_overlay else None}).encode())

    def apply(self, config_json: str) -> None:
        with self._op_lock:
            if self.host == MOCK_HOST:
                print(f"[router:mock] would apply {len(config_json)} bytes")
                self._mock_outbound = config_json.encode()
                self._save_mock()
                return
            self._ssh(REMOTE_APPLY, stdin=config_json)

    def run_xkeen(self, action: str) -> str:
        """Run `xkeen -<action>` remotely and return stdout."""
        if action not in {"start", "stop", "restart", "status"}:
            raise RouterError(f"unknown xkeen action: {action}")
        with self._op_lock:
            if self.host == MOCK_HOST:
                print(f"[router:mock] would run xkeen -{action}")
                if action == "status": return self._mock_xkeen
                self._mock_xkeen = "stopped" if action == "stop" else "running"
                self._save_mock()
                return f"mock: xkeen -{action}"
            if action == "status": return self._ssh("xkeen -status")
            return self._ssh(f"if [ -x {REMOTE_ROUTING} ]; then {REMOTE_ROUTING} control {action}; else xkeen -{action}; fi")

    def update_inventory(self):
        if self.host != MOCK_HOST:
            return json.loads(self._ssh_bytes("/opt/bin/xk-update inventory", timeout=30))
        with self._op_lock:
            sw = self._software
            rows = {}
            for name, installed in sw["versions"].items():
                steps = sw["steps"]
                index = next((i for i in reversed(range(len(steps))) if steps[i]["component"] == name), None)
                plan = [dict(step) for step in reversed(steps[index:])] if index is not None else []
                rows[name] = {"installed": installed, "rollback_plan": plan,
                              "rollback_version": plan[-1]["to"] if plan else None}
            return {"components": rows, "arch": "aarch64", "active": None, "held": dict(sw["held"]),
                    "last": next(reversed(sw["ops"].values()), None),
                    "revision": hashlib.sha256(json.dumps(sw["steps"]).encode()).hexdigest()}

    def update_status(self, ident):
        if not routing.valid_id(ident):
            raise RouterError("Invalid router update ID")
        if self.host == MOCK_HOST:
            with self._op_lock:
                return dict(self._software["ops"].get(ident, {"id": ident, "phase": "unknown"}))
        return json.loads(self._ssh_bytes(f"/opt/bin/xk-update status {ident}"))

    def update_recover(self, ident):
        if not routing.valid_id(ident):
            raise RouterError("Invalid router update ID")
        if self.host == MOCK_HOST:
            raise RoutingError("No interrupted update is available.", 409, "precondition")
        return self._update_command(["recover", ident], None)

    def _update_command(self, args, payload):
        command = shlex.join(["/opt/bin/xk-update", *args])
        with self._op_lock:
            try:
                result = subprocess.run(self._build_cmd(command), input=payload or b"", capture_output=True,
                                        timeout=180, env=self._ssh_env())
            except subprocess.TimeoutExpired as err:
                raise RouterError("Router update reply was lost") from err
        # sshpass uses the same exit codes as the remote CLI. Only its explicit
        # result marker proves that the helper actually handled the request.
        errors = [line for line in result.stderr.splitlines() if line.startswith(b"xk-update: ")]
        if result.returncode == 3 and errors:
            raise RoutingError("The router is busy.", 409, "busy")
        if result.returncode == 1 and errors:
            detail = errors[-1].removeprefix(b"xk-update: ")
            if detail == b"Local update state unavailable":
                raise RouterError("The router could not verify its local update journal")
            if detail == b"Scheduled installation window closed":
                raise RoutingError("Installation window closed before router admission.", 409, "expired")
            reasons = {b"Installed version changed": "Installed version changed. Review the release again.",
                       b"Artifact checksum mismatch": "Router received a different artifact checksum.",
                       b"Insufficient staging space": "Not enough space on the router for the release.",
                       b"Restore point changed": "Restore point changed. Review the rollback plan again."}
            raise RoutingError(reasons.get(detail, "Router refused the request. Review the release and restore points."),
                               409, "precondition")
        if result.returncode:
            raise RouterError("No confirmed helper response over SSH")
        try:
            receipt = json.loads(result.stdout)
        except (ValueError, UnicodeError) as err:
            raise RouterError("Router update reply was incomplete") from err
        if not isinstance(receipt, dict) or receipt.get("id") != args[1] or not isinstance(receipt.get("phase"), str):
            raise RouterError("Router update reply did not match the requested operation")
        return receipt

    def update_submit(self, op, payload):
        ident, name = op["id"], op["component"]
        if not routing.valid_id(ident) or name not in ("xkeen", "xray") or op["action"] not in ("install", "rollback"):
            raise RouterError("Invalid router update")
        if self.host != MOCK_HOST:
            fingerprint = op["transfer_sha256"] if op["action"] == "install" else op["revision"]
            args = [op["action"], ident, name, op["from"], op["version"], fingerprint]
            if op["action"] == "install" and op.get("expires"):
                args.append(str(op["expires"]))
            return self._update_command(args, payload)
        with self._op_lock:
            sw = self._software
            if ident in sw["ops"]:
                return sw["ops"][ident]
            if op["action"] == "install" and op.get("expires") and self.mock_update_time() >= op["expires"]:
                raise RoutingError("Installation window closed before router admission.", 409, "expired")
            if sw["versions"][name] != op["from"]:
                raise RoutingError("Router version changed.", 409, "conflict")
            def version_order(value):
                return tuple(map(int, value.split("."))) if value else ()
            if op["action"] == "install":
                sw["steps"].append({"component": name, "from": op["version"], "to": op["from"]})
                sw["versions"][name] = op["version"]
                if version_order(op["version"]) >= version_order(sw["held"].get(name)):
                    sw["held"].pop(name, None)
                phase = "installed"
            else:
                revision = hashlib.sha256(json.dumps(sw["steps"]).encode()).hexdigest()
                if op["revision"] != revision:
                    raise RoutingError("Restore points changed.", 409, "conflict")
                index = next((i for i in reversed(range(len(sw["steps"]))) if sw["steps"][i]["component"] == name), None)
                if index is None or sw["steps"][index]["to"] != op["version"]:
                    raise RoutingError("No matching restore point.", 409, "conflict")
                for step in reversed(sw["steps"][index:]):
                    sw["versions"][step["component"]] = step["to"]
                    previous_hold = sw["held"].get(step["component"])
                    if version_order(step["from"]) > version_order(previous_hold):
                        sw["held"][step["component"]] = step["from"]
                del sw["steps"][index:]
                phase = "rolled_back"
            sw["ops"][ident] = {"id": ident, "phase": phase, "action": op["action"], "component": name,
                                "version": op["version"]}
            self._save_mock()
            return sw["ops"][ident]

    def read_routing(self) -> bytes:
        if self.host == MOCK_HOST: return self._mock_routing
        return self._ssh_bytes(f"if [ -x {REMOTE_ROUTING} ]; then {REMOTE_ROUTING} read; else cat {REMOTE_ROUTING_PATH}; fi")

    def routing_capabilities(self):
        if self.host == MOCK_HOST: return {"version":3,"ready":True,"mock":True,"bundle":True,"selective":True}
        raw=self._ssh_bytes(f"if [ -x {REMOTE_ROUTING} ]; then {REMOTE_ROUTING} capabilities; else printf '%s' '{{\"version\":0,\"ready\":false,\"reason\":\"Install the router helper\"}}'; fi")
        result=json.loads(raw)
        if result.get("version") not in (1, 2, 3): result["ready"]=False
        return result

    def read_bundle(self):
        if self.host == MOCK_HOST:
            files = {device_routing.OUTBOUNDS_FILE: self._mock_outbound, device_routing.ROUTING_FILE: self._mock_routing}
            if self._mock_overlay is not None: files[device_routing.OVERLAY_FILE] = self._mock_overlay
            return files
        return device_routing.unpack(self._ssh_bytes(f"{REMOTE_ROUTING} read-bundle"))

    def bundle_environment(self):
        if self.host == MOCK_HOST: return routing.digest(b"mock-xray-v2-bundle")
        value = self._ssh_bytes(f"{REMOTE_ROUTING} bundle-environment", timeout=60).decode().strip()
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise RouterError("Invalid bundle environment fingerprint")
        return value

    def config_dependencies(self):
        if self.host == MOCK_HOST: return {}
        raw = self._ssh_bytes(f"{REMOTE_ROUTING} read-dependencies")
        if len(raw) > device_routing.MAX_BUNDLE_BYTES:
            raise RoutingError("Xray configuration dependencies are too large", 422)
        files = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            for entry in archive:
                if not entry.isfile() or "/" in entry.name or not entry.name.endswith(".json") or entry.size > device_routing.MAX_BUNDLE_BYTES:
                    raise RoutingError("Unexpected Xray configuration dependency", 422)
                files[entry.name] = archive.extractfile(entry).read()
        return files

    def validate_bundle(self, candidate):
        if self.host == MOCK_HOST:
            files = device_routing.unpack(candidate)
            jsonc.loads(files[device_routing.OUTBOUNDS_FILE].decode("utf-8-sig"))
            routing.parse(files[device_routing.ROUTING_FILE])
            if device_routing.OVERLAY_FILE in files:
                json.loads(files[device_routing.OVERLAY_FILE])
            return
        try: self._ssh_bytes(f"{REMOTE_ROUTING} validate-bundle", candidate, timeout=90)
        except RouterError as error:
            raise RoutingError(f"Xray rejected the configuration: {error}", 422, "xray_validation") from error

    def start_bundle(self, ident, before, environment, candidate):
        if not routing.valid_id(ident): raise RouterError("Invalid operation id")
        for value in (before, environment):
            if len(value) != 64 or any(c not in "0123456789abcdef" for c in value): raise RouterError("Invalid hash")
        if self.host == MOCK_HOST:
            request = {"before": before, "environment": environment, "candidate": routing.digest(candidate), "bundle": True}
            if ident in self._mock_operations:
                if self._mock_operations[ident].get("request") != request:
                    raise RouterError("Operation id conflict")
                return
            if device_routing.fingerprint(self.read_bundle()) != before or self.bundle_environment() != environment:
                self._mock_operations[ident] = {"phase": "rejected", "message": "Configuration changed"}
            else:
                try:
                    # The real helper validates staging under its lock even
                    # when Main preparation deliberately omits a preview run.
                    self.validate_bundle(candidate)
                except (RoutingError, ValueError, UnicodeError, RecursionError) as error:
                    self._mock_operations[ident] = {"phase": "rejected", "message": f"Xray rejected the configuration: {error}",
                                                   "before_state": self._mock_xkeen}
                else:
                    if device_routing.fingerprint(self.read_bundle()) != before or self.bundle_environment() != environment:
                        self._mock_operations[ident] = {"phase": "rejected", "message": "Configuration changed during validation"}
                    else:
                        files = device_routing.unpack(candidate)
                        self._mock_routing = files[device_routing.ROUTING_FILE]
                        self._mock_outbound = files[device_routing.OUTBOUNDS_FILE]
                        self._mock_overlay = files.get(device_routing.OVERLAY_FILE)
                        self._mock_xkeen = "running"
                        self._mock_operations[ident] = {"phase": "committed", "message": "Configuration applied"}
            self._mock_operations[ident]["request"] = request
            self._save_mock()
            return
        self._ssh_bytes(f"{REMOTE_ROUTING} start-bundle {ident} {before} {routing.digest(candidate)} {environment}", candidate,
                        timeout=SSH_ACCEPT_TIMEOUT_SEC)

    def routing_environment(self):
        if self.host == MOCK_HOST: return routing.digest(b"mock-xray-v1")
        value=self._ssh_bytes(f"{REMOTE_ROUTING} environment",timeout=60).decode().strip()
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value): raise RouterError("Invalid environment fingerprint")
        return value

    def routing_health(self):
        if self.host == MOCK_HOST: return self._mock_xkeen
        return self._ssh_bytes(f"{REMOTE_ROUTING} health").decode().strip()

    def validate_routing(self, candidate):
        if self.host == MOCK_HOST:
            routing.parse(candidate)
            return
        try: self._ssh_bytes(f"{REMOTE_ROUTING} validate",candidate,timeout=90)
        except RouterError as e: raise RoutingError(f"Xray rejected the configuration: {e}",422,"xray_validation") from e

    def start_routing(self, ident, before, environment, candidate):
        if not routing.valid_id(ident): raise RouterError("Invalid operation id")
        for value in (before,environment):
            if len(value) != 64 or any(c not in "0123456789abcdef" for c in value): raise RouterError("Invalid hash")
        if self.host == MOCK_HOST:
            request = {"before": before, "environment": environment, "candidate": routing.digest(candidate), "bundle": False}
            if ident in self._mock_operations:
                if self._mock_operations[ident].get("request") != request:
                    raise RouterError("Operation id conflict")
                return
            if routing.digest(self._mock_routing) != before:
                self._mock_operations[ident]={"phase":"rejected","message":"Configuration changed"}
            else:
                self._mock_routing=candidate
                self._mock_xkeen="running"
                self._mock_operations[ident]={"phase":"committed","message":"Configuration applied"}
            self._mock_operations[ident]["request"] = request
            self._save_mock()
            return
        self._ssh_bytes(f"{REMOTE_ROUTING} start {ident} {before} {routing.digest(candidate)} {environment}",candidate,
                        timeout=SSH_ACCEPT_TIMEOUT_SEC)

    def routing_operation(self, ident):
        if not routing.valid_id(ident): raise RouterError("Invalid operation id")
        if self.host == MOCK_HOST:
            return self._mock_operations.get(ident,{"phase":"not_found"})
        result=json.loads(self._ssh_bytes(f"{REMOTE_ROUTING} status {ident}", timeout=SSH_STATUS_TIMEOUT_SEC))
        allowed={"preparing","accepted","prepared","installing","installed","verifying","finishing","committed","rolling_back","boot_restored","rolled_back","recovery_failed","rejected","not_found"}
        if result.get("phase") not in allowed: raise RouterError("Unknown router operation phase")
        return result

    def acknowledge_routing(self, ident):
        if not routing.valid_id(ident): raise RouterError("Invalid operation id")
        if self.host != MOCK_HOST: self._ssh_bytes(f"{REMOTE_ROUTING} ack {ident}")

    def probe_route(self, config: bytes, *, port: int, urls: list[str], timeout: int, rounds: int,
                    limit: int, user_agent: str, hint: dict, cancel: threading.Event | None = None) -> str:
        """Run one isolated candidate check. Independent of the router operation lock.

        Cancelling closes the SSH session; the remote script's traps and watchdog
        stop its Xray and remove its files.
        """
        cancel = cancel or threading.Event()
        if self.host == MOCK_HOST:
            if cancel.wait(self.mock_probe_delay):
                raise route_probe.ProbeCancelled()
            return route_probe.mock_output(hint, urls, rounds, self._mock_probe_outcomes())
        args = [str(port), str(timeout), str(rounds), str(limit), user_agent, *urls]
        command = "sh -c " + shlex.quote(route_probe.SCRIPT) + " " + route_probe.PROBE_MARKER + " probe " + \
                  " ".join(shlex.quote(arg) for arg in args)
        # The local recovery menu may be used while the application is offline.
        # Share the on-router update guard across concurrent candidate probes.
        guard = ('if [ -x /opt/bin/xk-update ] && [ -x /opt/bin/python3 ]; then '
                 'set -- /opt/bin/xk-update probe; else set --; fi; "$@" ')
        command = guard + command
        deadline = time.monotonic() + limit + route_probe.SSH_SLACK_SEC
        # Own process group: sshpass and its ssh child are stopped together.
        process = subprocess.Popen(self._build_cmd(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=self._ssh_env(), start_new_session=True)
        payload = config
        try:
            while True:
                try:
                    stdout, _ = process.communicate(payload, timeout=PROBE_POLL_SEC)
                    break
                except subprocess.TimeoutExpired:
                    payload = None
                    if cancel.is_set():
                        raise route_probe.ProbeCancelled()
                    if time.monotonic() > deadline:
                        raise route_probe.ProbeUnavailable("The router did not answer in time")
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
        if process.returncode and not stdout:
            raise route_probe.ProbeUnavailable("Could not run the check on the router")
        return stdout.decode("utf-8", errors="replace")

    def cleanup_route_probes(self) -> None:
        """Remove diagnostics left by an earlier service process."""
        if self.host == MOCK_HOST:
            return
        command = "sh -c " + shlex.quote(route_probe.SCRIPT) + " " + route_probe.PROBE_MARKER + " cleanup"
        subprocess.run(self._build_cmd(command), input=b"", capture_output=True, timeout=SSH_EXEC_TIMEOUT_SEC,
                       env=self._ssh_env())

    def _mock_probe_outcomes(self) -> dict:
        outcomes = dict(self.mock_probe_outcomes)
        if self._mock_file:
            path = self._mock_file.parent / "mock-route-checks.json"
            try:
                outcomes.update(json.loads(path.read_text()))
            except (OSError, ValueError):
                pass
        return outcomes

    def _ssh_bytes(self, remote_cmd, stdin=None, timeout=SSH_EXEC_TIMEOUT_SEC):
        with self._op_lock:
            try:
                result=subprocess.run(self._build_cmd(remote_cmd),input=stdin or b"",capture_output=True,
                                      text=False,timeout=timeout,env=self._ssh_env())
            except subprocess.TimeoutExpired as e: raise RouterError(f"ssh timeout after {timeout}s") from e
            if result.returncode:
                raise RouterError(result.stderr.decode("utf-8",errors="replace")[-4000:] or f"ssh exited {result.returncode}")
            return result.stdout

    def read_outbound(self) -> dict:
        """Read and parse the router's current outbounds JSON."""
        if self.host == MOCK_HOST:
            return json.loads(self._mock_outbound)
        with self._op_lock:
            raw = self._ssh(f"cat {REMOTE_OUTBOUND_PATH}")
        return json.loads(raw)

    def _ssh_env(self) -> dict:
        env = dict(os.environ)
        if self.password:
            env[SSHPASS_ENV] = self.password
        return env

    def _ssh(self, remote_cmd: str, stdin: str | None = None) -> str:
        cmd = self._build_cmd(remote_cmd)
        env = self._ssh_env()
        try:
            result = subprocess.run(
                cmd,
                input=stdin if stdin is not None else "",
                capture_output=True,
                text=True,
                timeout=SSH_EXEC_TIMEOUT_SEC,
                env=env,
            )
        except subprocess.TimeoutExpired as e:
            raise RouterError(f"ssh timeout after {e.timeout}s") from e
        if result.returncode != 0:
            raise RouterError(
                f"ssh exited {result.returncode}: {result.stderr.strip()}"
            )
        return result.stdout

    def _build_cmd(self, remote_cmd: str) -> list[str]:
        ssh_opts = [
            "-o", f"UserKnownHostsFile={self.known_hosts}",
            "-o", f"ConnectTimeout={SSH_CONNECT_TIMEOUT_SEC}",
            "-o", "StrictHostKeyChecking=yes",
            "-p", str(self.port),
            f"{self.user}@{self.host}",
            remote_cmd,
        ]
        if self.password:
            if not shutil.which("sshpass"):
                raise RouterError("sshpass not installed; required for password auth")
            return [
                "sshpass", "-e", "ssh",
                "-o", "PreferredAuthentications=password",
                "-o", "PubkeyAuthentication=no",
                *ssh_opts,
            ]
        return [
            "ssh", "-i", self.ssh_key,
            "-o", "BatchMode=yes",
            *ssh_opts,
        ]

MOCK_ROUTING = b'''// Local demo; no SSH connection is made.
{"routing":{"domainStrategy":"AsIs","rules":[
// Vulnerable UDP ports
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"block","network":"udp","port":"135,137,138,139"},
// Analytics
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"block","domain":["appcenter.ms"]},
// Google
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"vless-reality","domain":["ext:geosite_v2fly.dat:google"]},
// Direct domains
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"direct","domain":["domain:example.org","ext:geosite_v2fly.dat:yandex"]},
// Local networks
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"direct","ip":["ext:geoip_v2fly.dat:private"]},
// Torrent
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"direct","protocol":["bittorrent"]},
// Everything else
{"type":"field","inboundTag":["redirect","tproxy"],"outboundTag":"vless-reality"}
]}}\n'''
