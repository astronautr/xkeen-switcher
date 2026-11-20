"""Isolated Xray probe of one Main candidate on the router.

The candidate comes from the Main generator unchanged. A private SOCKS inbound
on the router loopback sends every request to the candidate's first outbound,
so neither the installed Main, site rules nor device rules can carry it.
"""
import json
import re
import zlib
from urllib.parse import urlsplit
from .connectivity import HTTP_OK_MIN, HTTP_OK_MAX_EXCLUSIVE, HTTP_ROUTE_REACHABLE_CODES
from .outbound import VLESS_TAG, build as build_outbound
from .routing import digest
from .subscription import Location

PROBE_INBOUND_TAG = "xk-probe-in"
PROBE_LISTEN = "127.0.0.1"
PROBE_PORT_MIN = 20000
PROBE_PORT_MAX = 59999
PROBE_MARKER = "xk-switcher-probe"
STARTUP_SEC = 6
SLACK_SEC = 6
ROUND_SLACK_SEC = 2
SSH_SLACK_SEC = 15
# curl cannot reach the local diagnostic inbound: the check itself did not run.
LOCAL_PROXY_ERRORS = {2, 3, 4, 5, 7, 48, 255}
CURL_ERRORS = {
    6: "could not resolve host", 28: "timed out", 35: "TLS handshake failed",
    47: "too many redirects", 52: "empty reply", 56: "connection reset", 97: "proxy handshake failed",
}
STARTUP_ERRORS = {
    "xray": "Xray was not found on the router",
    "curl": "curl was not found on the router",
    "storage": "Could not create temporary files on the router",
    "start": "The diagnostic Xray process did not start",
    "bind": "The diagnostic port was busy",
    "died": "The diagnostic Xray process stopped during the check",
}
UNSUPPORTED_PATTERN = re.compile(
    r"unknown (?:config id|protocol|transport protocol|network|security type)[\s:]+\"?([A-Za-z0-9_.-]{1,32})", re.I)

# Runs in one SSH session; the config arrives on stdin. The watchdog bounds every
# process lifetime, including after the session or its parent shell disappears.
SCRIPT = r"""
set -u
umask 077
PATH="${XK_PROBE_PATH:-/opt/bin:/opt/sbin:/usr/bin:/bin:/usr/sbin:/sbin}:$PATH"
unset XRAY_LOCATION_CONFDIR
ROOT=${XK_PROBE_ROOT:-/tmp/xk-switcher-probe}
PROC=${XK_PROBE_PROC:-/proc}
PROCNET=${XK_PROBE_PROCNET:-$PROC/net/tcp}
ASSETS=/opt/etc/xray/dat
nap() { sleep 0.2 2>/dev/null || sleep 1; }
owned() { tr '\000' ' ' 2>/dev/null < "$PROC/$1/cmdline" | grep -Fq -- "$2"; }
kill_probe() {
    p=$(cat "$1/pid" 2>/dev/null || true)
    case "$p" in ''|*[!0-9]*) return;; esac
    owned "$p" "$1/config.json" && kill -9 "$p" 2>/dev/null
}
if [ "${1:-}" = cleanup ]; then
    [ -d "$ROOT" ] || exit 0
    for d in "$ROOT"/run.*; do
        [ -d "$d" ] || continue
        for f in shell watchdog; do
            p=$(cat "$d/$f" 2>/dev/null || true)
            case "$p" in ''|*[!0-9]*) continue;; esac
            [ "$p" != "$$" ] && owned "$p" "$0" && kill "$p" 2>/dev/null
        done
        kill_probe "$d"
        rm -rf "$d"
    done
    echo cleaned
    exit 0
fi
port=$2; tmo=$3; rounds=$4; limit=$5; ua=$6; shift 6
command -v xray >/dev/null 2>&1 || { echo "E xray"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "E curl"; exit 0; }
mkdir -p "$ROOT" 2>/dev/null && dir=$(mktemp -d "$ROOT/run.XXXXXX" 2>/dev/null) || { echo "E storage"; exit 0; }
xp=; wd=
cleanup() {
    [ -z "$wd" ] || kill "$wd" 2>/dev/null
    if [ -n "$xp" ]; then kill -9 "$xp" 2>/dev/null; wait "$xp" 2>/dev/null; fi
    rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM PIPE
echo "$$" > "$dir/shell"
( sleep "$limit" & timer=$!
  trap 'kill "$timer" 2>/dev/null; exit 0' TERM HUP INT
  wait "$timer"
  kill_probe "$dir"
  owned "$$" "$0" && kill "$$" 2>/dev/null
  rm -rf "$dir" ) </dev/null >/dev/null 2>&1 &
wd=$!
echo "$wd" > "$dir/watchdog"
cat > "$dir/config.json" || { echo "E storage"; exit 0; }
XRAY_LOCATION_ASSET="$ASSETS" xray run -test -c "$dir/config.json" </dev/null > "$dir/test.log" 2>&1 &
xp=$!
echo "$xp" > "$dir/pid"
wait "$xp"; test_rc=$?; xp=
if [ "$test_rc" -ne 0 ]; then
    if [ "$test_rc" -gt 128 ]; then echo "E start"; else
        printf 'U %s\n' "$(grep -v '^[[:space:]]*$' "$dir/test.log" | tail -n 1 | tr -d '\r' | cut -c1-300)"
    fi
    exit 0
fi
hex=$(printf '%04X' "$port")
# Another listener on this port would receive the requests instead of the candidate.
listener() {
    awk -v address="$1:$hex" '$2 == address && $4 == "0A" {print $10}' "$PROCNET" 2>/dev/null
}
if [ -n "$(listener 0100007F)$(listener 00000000)" ]; then echo "E bind"; exit 0; fi
XRAY_LOCATION_ASSET="$ASSETS" xray run -c "$dir/config.json" </dev/null >"$dir/xray.log" 2>&1 &
xp=$!
echo "$xp" > "$dir/pid"
listening() {
    kill -0 "$xp" 2>/dev/null || return 1
    inode=$(listener 0100007F)
    [ -n "$inode" ] || return 1
    for fd in "$PROC/$xp/fd/"*; do
        [ "$(readlink "$fd" 2>/dev/null)" != "socket:[$inode]" ] || return 0
    done
    return 1
}
n=0
until listening; do
    if ! kill -0 "$xp" 2>/dev/null; then
        if grep -qi 'address already in use' "$dir/xray.log" 2>/dev/null; then echo "E bind"; else echo "E start"; fi
        exit 0
    fi
    n=$((n+1)); [ "$n" -lt 25 ] || { echo "E start"; exit 0; }
    nap
done
r=1
while [ "$r" -le "$rounds" ]; do
    listening || { echo "E died"; exit 0; }
    i=0; pids=
    for url in "$@"; do
        i=$((i+1))
        ( out=$(curl -q --noproxy "" --globoff -sS -o /dev/null -L --max-redirs 5 --proto-redir =http,https --max-time "$tmo" \
              --connect-timeout "$tmo" -A "$ua" -x "socks5h://127.0.0.1:$port" \
              -w '%{http_code} %{time_total}' -- "$url" 2>/dev/null)
          rc=$?
          echo "R $r $i $rc ${out:-000 0}" > "$dir/r.$r.$i" ) </dev/null >/dev/null 2>&1 &
        pids="$pids $!"
    done
    for p in $pids; do wait "$p"; done
    listening || { echo "E died"; exit 0; }
    j=1
    while [ "$j" -le "$i" ]; do cat "$dir/r.$r.$j" 2>/dev/null || echo "R $r $j 255 000 0"; j=$((j+1)); done
    r=$((r+1))
done
echo D
"""

class ProbeUnavailable(Exception):
    """The diagnostic itself could not run; the route was not judged."""

def candidate(exit_loc: Location, entry_loc: Location | None) -> str:
    """Exactly the text a Main switch to this route would install."""
    return build_outbound(exit_loc, entry_loc)

def candidate_hash(exit_loc: Location, entry_loc: Location | None) -> str:
    return digest(candidate(exit_loc, entry_loc).encode())

def isolated_config(main_text: str, port: int) -> bytes:
    outbounds = json.loads(main_text)["outbounds"]
    doc = {
        "log": {"loglevel": "warning"},
        "inbounds": [{"tag": PROBE_INBOUND_TAG, "listen": PROBE_LISTEN, "port": port, "protocol": "socks",
                      "settings": {"auth": "noauth", "udp": False}}],
        "outbounds": outbounds,
        "routing": {"domainStrategy": "AsIs", "rules": [
            {"type": "field", "inboundTag": [PROBE_INBOUND_TAG], "outboundTag": VLESS_TAG},
        ]},
    }
    return json.dumps(doc, ensure_ascii=False).encode()

def time_limit(timeout_sec: int, rounds: int) -> int:
    return STARTUP_SEC + rounds * (timeout_sec + ROUND_SLACK_SEC) + SLACK_SEC

def unsupported_reason(line: str, protocols: str) -> str:
    match = UNSUPPORTED_PATTERN.search(line or "")
    base = (f"Xray on the router does not support {match.group(1)}" if match
            else "Xray on the router rejected this route configuration")
    return base + (f" · {protocols}" if protocols else "")

def parse(output: str, urls: list[str], rounds: int, protocols: str = "") -> dict:
    """Turn script output into an outcome. Raw router text never leaves this function."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in lines:
        if line.startswith("U"):
            return {"outcome": "unsupported", "reason": unsupported_reason(line[1:], protocols), "rounds": []}
        if line.startswith("E"):
            kind = line[1:].strip()
            if kind == "bind":
                raise PortBusy()
            raise ProbeUnavailable(STARTUP_ERRORS.get(kind, "The diagnostic did not start"))
    if "D" not in lines:
        raise ProbeUnavailable("Lost connection to the router during the check")
    results = {}
    for line in lines:
        parts = line.split()
        if parts[0] != "R" or len(parts) < 6:
            continue
        try:
            round_no, index, rc, status = int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4])
            seconds = float(parts[5])
        except ValueError:
            continue
        results[(round_no, index)] = (rc, status, seconds)
    report = []
    for round_no in range(1, rounds + 1):
        items = []
        for index, url in enumerate(urls, 1):
            if (round_no, index) not in results:
                raise ProbeUnavailable("The router returned an incomplete check result")
            rc, status, seconds = results[(round_no, index)]
            if rc in LOCAL_PROXY_ERRORS and not status:
                raise ProbeUnavailable("The diagnostic proxy did not accept the request")
            items.append(_target(url, rc, status, seconds))
        report.append({"ok": any(item["ok"] for item in items), "results": items})
    return {"outcome": outcome(report), "reason": None, "rounds": report}

def outcome(report: list[dict]) -> str:
    passed = sum(1 for item in report if item["ok"])
    return "working" if passed == len(report) else "unstable" if passed else "failed"

def _target(url: str, rc: int, status: int, seconds: float) -> dict:
    ok = HTTP_OK_MIN <= status < HTTP_OK_MAX_EXCLUSIVE or status in HTTP_ROUTE_REACHABLE_CODES
    error = None
    if not ok:
        error = f"HTTP {status}" if status else CURL_ERRORS.get(rc, f"request failed (curl {rc})")
    return {"name": urlsplit(url).hostname or url, "url": url, "ok": ok, "status": status or None,
            "latency_ms": int(seconds * 1000) if status else None, "error": error}

class ProbeCancelled(ProbeUnavailable):
    """The user stopped the run; the SSH session was closed before a result."""
    def __init__(self):
        super().__init__("Stopped before this route finished")

class PortBusy(ProbeUnavailable):
    def __init__(self):
        super().__init__(STARTUP_ERRORS["bind"])

def mock_output(hint: dict, urls: list[str], rounds: int, outcomes: dict | None = None) -> str:
    """Deterministic router output for the mock router and UI fixtures."""
    key = (hint.get("entry_code") or "single") + ">" + hint["exit_code"]
    result = (outcomes or {}).get(key) or _mock_outcome(hint)
    if result == "unsupported":
        return "U infra/conf: unknown config id: hysteria2\n"
    if result == "unavailable":
        return "E start\n"
    passes = {"working": [True] * rounds, "unstable": [True] + [False] * (rounds - 1), "failed": [False] * rounds}[result]
    lines = []
    for round_no, ok in enumerate(passes, 1):
        for index, _ in enumerate(urls, 1):
            lines.append(f"R {round_no} {index} 0 204 0.{180 + 40 * index}" if ok else f"R {round_no} {index} 28 000 5.0")
    return "\n".join(lines + ["D"]) + "\n"

def _mock_outcome(hint: dict) -> str:
    if any(protocol.startswith("hysteria") for protocol in hint.get("protocols", [])):
        return "unsupported"
    entry, exit_code = hint.get("entry_code"), hint["exit_code"]
    if entry is None:
        return "failed" if exit_code in {"fi", "lv"} else "working"
    if entry.startswith("ru"):
        return "working"
    return ("working", "unstable", "failed")[zlib.crc32(f"{entry}>{exit_code}".encode()) % 3]
