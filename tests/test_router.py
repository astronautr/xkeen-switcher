import subprocess
import threading
import pytest
from unittest.mock import patch, MagicMock
from xk_switcher.router import Router, RouterError, MOCK_HOST

def test_mock_host_does_not_invoke_ssh(capsys):
    r = Router(host=MOCK_HOST)
    r.apply('{"outbounds": []}')
    assert "mock" in capsys.readouterr().out

def test_apply_invokes_ssh_with_expected_args():
    r = Router(host="192.168.1.1", user="root", port=2222,
               ssh_key="/k/id", known_hosts="/k/hosts")
    fake = MagicMock(returncode=0, stderr="")
    with patch("subprocess.run", return_value=fake) as m:
        r.apply("PAYLOAD")
    args, kwargs = m.call_args
    cmd = args[0]
    joined = " ".join(cmd)
    assert cmd[0] == "ssh"
    assert "/k/id" in cmd
    assert "UserKnownHostsFile=/k/hosts" in joined
    assert "ConnectTimeout=5" in joined
    assert "2222" in cmd
    assert "root@192.168.1.1" in cmd
    assert cmd[-1] == "/opt/bin/xk-apply"
    assert kwargs["input"] == "PAYLOAD"

def test_non_zero_exit_raises_router_error():
    r = Router(host="192.168.1.1")
    fake = MagicMock(returncode=3, stderr="permission denied")
    with patch("subprocess.run", return_value=fake):
        with pytest.raises(RouterError, match="permission denied"):
            r.apply("x")

def test_timeout_raises_router_error():
    r = Router(host="192.168.1.1")
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="ssh", timeout=5)):
        with pytest.raises(RouterError, match="timeout"):
            r.apply("x")

def test_password_mode_uses_sshpass_and_sets_env():
    r = Router(host="192.168.2.1", password="secret")
    fake = MagicMock(returncode=0, stderr="")
    with patch("shutil.which", return_value="/usr/bin/sshpass"), \
         patch("subprocess.run", return_value=fake) as m:
        r.apply("PAYLOAD")
    cmd = m.call_args[0][0]
    joined = " ".join(cmd)
    assert cmd[0] == "sshpass"
    assert "-e" in cmd
    assert "ssh" in cmd
    assert "PreferredAuthentications=password" in joined
    assert "PubkeyAuthentication=no" in joined
    assert "BatchMode=yes" not in joined
    env = m.call_args.kwargs["env"]
    assert env["SSHPASS"] == "secret"

def test_password_mode_without_sshpass_installed_raises():
    r = Router(host="192.168.2.1", password="secret")
    with patch("shutil.which", return_value=None):
        with pytest.raises(RouterError, match="sshpass not installed"):
            r.apply("x")

def test_router_has_op_lock():
    r = Router(host="mock")
    assert hasattr(r, "_op_lock")
    assert hasattr(r._op_lock, "acquire")
    assert hasattr(r._op_lock, "release")

def test_router_apply_acquires_lock():
    r = Router(host="mock")
    mock_lock = MagicMock()
    r._op_lock = mock_lock
    r.apply("{}")
    mock_lock.__enter__.assert_called_once()
    mock_lock.__exit__.assert_called_once()

def test_router_run_xkeen_acquires_lock():
    r = Router(host="mock")
    mock_lock = MagicMock()
    r._op_lock = mock_lock
    r.run_xkeen("status")
    mock_lock.__enter__.assert_called_once()
    mock_lock.__exit__.assert_called_once()


def test_read_outbound_parses_router_json():
    r = Router(host="192.168.1.1", password="secret")
    remote_json = '{"outbounds":[{"tag":"vless-reality","protocol":"vless"}]}'
    fake = MagicMock(returncode=0, stdout=remote_json, stderr="")
    with patch("subprocess.run", return_value=fake):
        result = r.read_outbound()
    assert result == {"outbounds": [{"tag": "vless-reality", "protocol": "vless"}]}


def test_read_outbound_mock_host_returns_empty():
    r = Router(host=MOCK_HOST)
    assert r.read_outbound() == {"outbounds": []}



def test_acceptance_and_status_have_distinct_ssh_timeout_budgets():
    import uuid
    from xk_switcher.router import SSH_ACCEPT_TIMEOUT_SEC, SSH_STATUS_TIMEOUT_SEC
    router = Router(host="router.test")
    ident = str(uuid.uuid4())
    with patch.object(router, "_ssh_bytes", return_value=b'{"phase":"preparing"}') as ssh:
        router.start_bundle(ident, "0" * 64, "1" * 64, b"candidate")
        assert ssh.call_args.kwargs["timeout"] == SSH_ACCEPT_TIMEOUT_SEC
        assert router.routing_operation(ident) == {"phase": "preparing"}
        assert ssh.call_args.kwargs["timeout"] == SSH_STATUS_TIMEOUT_SEC
        assert SSH_ACCEPT_TIMEOUT_SEC > SSH_STATUS_TIMEOUT_SEC

def test_mock_selective_bundle_removes_overlay_and_checks_replay_identity():
    import uuid
    from xk_switcher.device_routing import fingerprint, pack
    router = Router(host=MOCK_HOST)
    assert router.routing_capabilities()["selective"] is True
    router._mock_overlay = b'{}'
    before = fingerprint(router.read_bundle())
    files = {"04_outbounds.json": router._mock_outbound, "05_routing.json": router._mock_routing}
    candidate = pack(files)
    router.validate_bundle(candidate)
    ident = str(uuid.uuid4())
    router.start_bundle(ident, before, router.bundle_environment(), candidate)
    assert "99_xk_devices_tail.json" not in router.read_bundle()
    router.start_bundle(ident, before, router.bundle_environment(), candidate)
    with pytest.raises(RouterError, match="Operation id conflict"):
        router.start_bundle(ident, before, router.bundle_environment(), b"different")
