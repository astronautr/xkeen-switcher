import json
import os
import shutil
import subprocess
import time
from pathlib import Path
import pytest
from xk_switcher import route_probe
from xk_switcher.outbound import CHAIN_ENTRY_TAG, VLESS_TAG, build
from xk_switcher.subscription import Location

URLS = ["https://a.example/health", "https://b.example/"]

def _loc(code, name, host, protocol="vless", network="tcp", sni="sni.example"):
    return Location(code=code, name=name, protocol=protocol, host=host, port=443, outbound={
        "tag": "proxy", "protocol": protocol,
        "settings": {"vnext": [{"address": host, "port": 443, "users": [{"id": "u", "encryption": "none"}]}]},
        "streamSettings": {"network": network, "security": "reality", "realitySettings": {"serverName": sni}},
    })

FI = _loc("fi", "Finland 🇫🇮", "fi.example")
RU = _loc("ru1", "RU 1 🇷🇺", "ru.example")

def test_isolated_config_uses_main_generator_and_private_loopback_inbound():
    main = route_probe.candidate(FI, RU)
    assert main == build(FI, RU)
    doc = json.loads(route_probe.isolated_config(main, 23456))
    assert doc["outbounds"] == json.loads(main)["outbounds"]
    assert doc["outbounds"][0]["tag"] == VLESS_TAG
    assert doc["outbounds"][0]["streamSettings"]["sockopt"]["dialerProxy"] == CHAIN_ENTRY_TAG
    [inbound] = doc["inbounds"]
    assert inbound["listen"] == "127.0.0.1" and inbound["port"] == 23456 and inbound["protocol"] == "socks"
    # Only the probe rule exists: no site or device rule can divert the request.
    assert doc["routing"]["rules"] == [{"type": "field", "inboundTag": [inbound["tag"]], "outboundTag": VLESS_TAG}]

def test_candidate_hash_covers_sni_and_route_order():
    base = route_probe.candidate_hash(FI, RU)
    assert route_probe.candidate_hash(_loc("fi", "Finland 🇫🇮", "fi.example", sni="other.example"), RU) != base
    assert route_probe.candidate_hash(RU, FI) != base
    assert route_probe.candidate_hash(FI, None) != base

def _rounds(*passes):
    lines = []
    for round_no, ok in enumerate(passes, 1):
        lines += [f"R {round_no} 1 {0 if ok else 28} {204 if ok else '000'} 0.3", f"R {round_no} 2 28 000 5.0"]
    return "\n".join(lines + ["D"])

@pytest.mark.parametrize("passes, outcome", [((True, True), "working"), ((True, False), "unstable"),
                                             ((False, True), "unstable"), ((False, False), "failed")])
def test_parse_outcome_from_rounds(passes, outcome):
    result = route_probe.parse(_rounds(*passes), URLS, 2)
    assert result["outcome"] == outcome
    assert [item["ok"] for item in result["rounds"]] == list(passes)
    failed = result["rounds"][0]["results"][1]
    assert failed == {"name": "b.example", "url": URLS[1], "ok": False, "status": None, "latency_ms": None,
                      "error": "timed out"}

def test_parse_counts_http_429_and_redirects_as_reachable():
    output = "R 1 1 0 429 0.1\nR 1 2 0 302 0.1\nD\n"
    result = route_probe.parse(output, URLS, 1)
    assert result["outcome"] == "working"
    assert [item["status"] for item in result["rounds"][0]["results"]] == [429, 302]
    assert route_probe.parse("R 1 1 0 403 0.1\nR 1 2 0 500 0.1\nD", URLS, 1)["outcome"] == "failed"

def test_header_received_before_timeout_is_a_response():
    assert route_probe.parse("R 1 1 28 200 5.0\nR 1 2 28 000 5.0\nD", URLS, 1)["outcome"] == "working"

def test_unsupported_reason_names_only_the_rejected_feature():
    line = "U Failed to start: infra/conf: failed to build outbound config with tag vless-reality > unknown config id: hysteria2 secret-key-abc"
    result = route_probe.parse(line, URLS, 2, "vless → hysteria2")
    assert result["outcome"] == "unsupported"
    assert result["reason"] == "Xray on the router does not support hysteria2 · vless → hysteria2"
    assert "secret" not in route_probe.parse("U invalid publicKey secret-key-abc", URLS, 2)["reason"]

@pytest.mark.parametrize("output, reason", [
    ("E curl", "curl was not found on the router"),
    ("E start", "The diagnostic Xray process did not start"),
    ("R 1 1 0 204 0.1\n", "Lost connection to the router during the check"),
    ("R 1 1 7 000 0\nR 1 2 7 000 0\nD", "The diagnostic proxy did not accept the request"),
    ("R 1 1 0 204 0.1\nD", "The router returned an incomplete check result"),
])
def test_diagnostic_failures_are_unavailable_not_route_failures(output, reason):
    with pytest.raises(route_probe.ProbeUnavailable, match=reason):
        route_probe.parse(output, URLS, 1)

def test_bind_conflict_is_retryable():
    with pytest.raises(route_probe.PortBusy):
        route_probe.parse("E bind", URLS, 1)

def test_mock_output_round_trips_through_parser():
    hint = {"entry_code": None, "exit_code": "fi", "protocols": ["vless"]}
    assert route_probe.parse(route_probe.mock_output(hint, URLS, 2), URLS, 2)["outcome"] == "failed"
    chain = {"entry_code": "ru1", "exit_code": "fi", "protocols": ["vless", "vless"]}
    assert route_probe.parse(route_probe.mock_output(chain, URLS, 2), URLS, 2)["outcome"] == "working"
    other = {"entry_code": "de", "exit_code": "fi", "protocols": ["vless", "vless"]}
    assert route_probe.parse(route_probe.mock_output(other, URLS, 2, {"de>fi": "unstable"}), URLS, 2)["outcome"] == "unstable"
    hy = {"entry_code": None, "exit_code": "us", "protocols": ["hysteria2"]}
    assert route_probe.parse(route_probe.mock_output(hy, URLS, 2), URLS, 2)["outcome"] == "unsupported"

# ---- the shell script itself, against fake xray/curl -----------------------

FAKE_XRAY = """#!/bin/sh
[ "$1" = run ] || exit 2
if [ "$2" = -test ]; then
    [ -z "${FAKE_TEST_ERROR:-}" ] || { echo "$FAKE_TEST_ERROR"; exit 1; }
    exit 0
fi
[ -z "${FAKE_START_FAIL:-}" ] && {
    port=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["inbounds"][0]["port"])' "$3")
    mkdir -p "$XK_PROBE_PROC/$$/fd"
    [ -n "${FAKE_WRONG_LISTENER:-}" ] || ln -s 'socket:[123]' "$XK_PROBE_PROC/$$/fd/3"
    printf '%s\\0' "$3" > "$XK_PROBE_PROC/$$/cmdline"
    printf '0: 0100007F:%04X 00000000:0000 0A 0 0 0 0 0 123\\n' "$port" >> "$XK_PROBE_PROCNET"
}
[ -z "${FAKE_START_FAIL:-}" ] || exit 1
echo $$ >> "$FAKE_PIDS"
exec sleep 60
"""

FAKE_CURL = """#!/bin/sh
[ "$1" = -q ] && [ "$2" = --noproxy ] && [ -z "$3" ] && [ "$4" = --globoff ] || exit 7
count=1; while ! mkdir "$FAKE_CURL_COUNT.$count" 2>/dev/null; do count=$((count+1)); done
[ -z "${FAKE_CURL_SLEEP:-}" ] || sleep "$FAKE_CURL_SLEEP"
case "$FAKE_CURL" in
  ok) printf '204 0.250'; exit 0;;
  flaky) if [ "$count" -le 2 ]; then printf '204 0.100'; exit 0; fi; printf '000 5.000'; exit 28;;
  *) printf '000 5.000'; exit 28;;
esac
"""

@pytest.fixture
def harness(tmp_path):
    if not shutil.which("sh") or not shutil.which("python3"):
        pytest.skip("POSIX shell required")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("xray", FAKE_XRAY), ("curl", FAKE_CURL)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    root = tmp_path / "probe"
    env = {**os.environ, "XK_PROBE_PATH": str(bin_dir), "XK_PROBE_ROOT": str(root),
           "XK_PROBE_PROC": str(tmp_path / "proc"),
           "XK_PROBE_PROCNET": str(tmp_path / "tcp"), "FAKE_PIDS": str(tmp_path / "pids"),
           "FAKE_CURL_COUNT": str(tmp_path / "count")}

    def run(mode="ok", limit=20, **extra):
        port = 23456
        Path(env["XK_PROBE_PROCNET"]).write_text("")
        config = route_probe.isolated_config(route_probe.candidate(FI, None), port)
        args = ["sh", "-c", route_probe.SCRIPT, route_probe.PROBE_MARKER, "probe",
                str(port), "1", "2", str(limit), "agent", *URLS]
        result = subprocess.run(args, input=config, capture_output=True, timeout=limit + 10,
                                env={**env, "FAKE_CURL": mode, **extra})
        return result.stdout.decode()

    run.root = root
    run.pids = tmp_path / "pids"
    return run

def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True

def _pids(path: Path):
    return [int(line) for line in path.read_text().split()] if path.exists() else []

def _settled(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return predicate()

def test_script_reports_rounds_and_cleans_up(harness):
    output = harness()
    result = route_probe.parse(output, URLS, 2)
    assert result["outcome"] == "working"
    assert result["rounds"][0]["results"][0]["latency_ms"] == 250
    assert _settled(lambda: not any(_alive(pid) for pid in _pids(harness.pids)))
    assert list(harness.root.iterdir()) == []

def test_script_distinguishes_unstable_failed_and_unsupported(harness):
    assert route_probe.parse(harness("flaky"), URLS, 2)["outcome"] == "unstable"
    assert route_probe.parse(harness("timeout"), URLS, 2)["outcome"] == "failed"
    unsupported = harness(FAKE_TEST_ERROR="unknown config id: hysteria2")
    assert route_probe.parse(unsupported, URLS, 2)["outcome"] == "unsupported"
    with pytest.raises(route_probe.ProbeUnavailable, match="did not start"):
        route_probe.parse(harness(FAKE_START_FAIL="1"), URLS, 2)
    assert list(harness.root.iterdir()) == []

def test_script_watchdog_bounds_process_lifetime(harness):
    # A limit shorter than one round: the watchdog ends the session and its Xray.
    output = harness("timeout", limit=1, FAKE_CURL_SLEEP="3")
    assert "D" not in output.split()
    assert _settled(lambda: not any(_alive(pid) for pid in _pids(harness.pids)))
    assert _settled(lambda: list(harness.root.iterdir()) == [])

def test_script_refuses_a_port_with_another_listener(harness, tmp_path):
    harness()
    (tmp_path / "tcp").write_text("0: 0100007F:5BA0 00000000:0000 0A 0 0 0 0 0 456\n")
    port = 23456
    config = route_probe.isolated_config(route_probe.candidate(FI, None), port)
    env = {**os.environ, "XK_PROBE_PATH": str(tmp_path / "bin"), "XK_PROBE_ROOT": str(harness.root),
           "XK_PROBE_PROCNET": str(tmp_path / "tcp"), "FAKE_PIDS": str(harness.pids), "FAKE_CURL": "ok",
           "FAKE_CURL_COUNT": str(tmp_path / "count")}
    out = subprocess.run(["sh", "-c", route_probe.SCRIPT, route_probe.PROBE_MARKER, "probe", str(port), "1", "2",
                          "20", "agent", *URLS], input=config, capture_output=True, env=env, timeout=20).stdout.decode()
    with pytest.raises(route_probe.PortBusy):
        route_probe.parse(out, URLS, 2)

def test_script_never_uses_a_socket_owned_by_another_process(harness):
    output = harness(FAKE_WRONG_LISTENER="1")
    assert not any(line.startswith("R ") for line in output.splitlines())
    with pytest.raises(route_probe.ProbeUnavailable, match="did not start"):
        route_probe.parse(output, URLS, 2)

def test_cleanup_removes_orphaned_directories(harness, tmp_path):
    stale = harness.root / "run.orphan"
    stale.mkdir(parents=True)
    sleeper = subprocess.Popen(["sleep", "60"])
    (stale / "pid").write_text(str(sleeper.pid))  # not ours: cmdline lacks the config path
    try:
        env = {**os.environ, "XK_PROBE_ROOT": str(harness.root)}
        out = subprocess.run(["sh", "-c", route_probe.SCRIPT, route_probe.PROBE_MARKER, "cleanup"],
                             capture_output=True, env=env, timeout=10).stdout.decode()
        assert "cleaned" in out
        assert not stale.exists()
        assert sleeper.poll() is None
    finally:
        sleeper.kill()
