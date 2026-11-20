"""Authentication behavior, persistence, and concurrent access."""
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import pytest
from xk_switcher.auth import Auth, AuthError, LOGIN_WINDOW_SEC, PASSWORD_ITERATIONS
from tests._helpers import TEST_PASSWORD

@pytest.fixture
def auth(tmp_path):
    instance = Auth(tmp_path)
    instance.set_password(TEST_PASSWORD)
    return instance

def login(auth, ip="owner"):
    return auth.login(TEST_PASSWORD, ip, "Mozilla/5.0 (iPhone) Version/18 Safari/604.1")

def test_password_and_session_secrets_are_not_stored(auth):
    secret = login(auth)
    text = auth.path.read_text()
    data = json.loads(text)
    assert TEST_PASSWORD not in text and secret not in text
    assert data["password"]["iterations"] == PASSWORD_ITERATIONS
    assert data["sessions"][0]["label"] == "Safari · iPhone"
    assert auth.path.stat().st_mode & 0o777 == 0o600
    assert "secret_hash" not in auth.sessions(secret)[0]

@pytest.mark.parametrize("password", ["", "short", "a" * 129, None, 42, "\ud800" * 12])
def test_invalid_password_rejected_without_changing_credentials(auth, password):
    with pytest.raises(AuthError) as error:
        auth.set_password(password)
    assert error.value.status == 400
    assert auth.session(login(auth))["authenticated"]

def test_password_whitespace_is_significant(auth):
    auth.set_password("  admin password  ")
    with pytest.raises(AuthError):
        auth.login("admin password", "ip")
    assert auth.session(auth.login("  admin password  ", "ip"))["authenticated"]

def test_password_hash_uses_fresh_salt(auth):
    before = json.loads(auth.path.read_text())["password"]
    auth.set_password(TEST_PASSWORD)
    after = json.loads(auth.path.read_text())["password"]
    assert before["salt"] != after["salt"]
    assert before["hash"] != after["hash"]

def test_incorrect_password_does_not_create_session(auth):
    with pytest.raises(AuthError) as error:
        auth.login("incorrect-password", "ip")
    assert error.value.status == 401
    assert json.loads(auth.path.read_text())["sessions"] == []

def test_sessions_survive_restart_and_do_not_expire(auth):
    secret = login(auth)
    before = auth.path.read_bytes()
    later = Auth(auth.path.parent, clock=lambda: 4_102_444_800)  # 2100
    assert later.session(secret)["authenticated"]
    assert later.sessions(secret)[0]["current"]
    assert auth.path.read_bytes() == before
    assert "expires_at" not in json.loads(before)["sessions"][0]

@pytest.mark.parametrize("secret", ["", None, "wrong", "é" * 64, "a" * 65])
def test_invalid_session_secret_rejected(auth, secret):
    assert not auth.session(secret)["authenticated"]

def test_pairing_leading_zero_and_space(auth):
    owner = login(auth)
    with patch("xk_switcher.auth.secrets.randbelow", return_value=1234):
        code = auth.create_pairing_code(owner)
    assert code["code"] == "001234"
    guest = auth.pair("001 234", "wife", "Chrome/100 Android")
    assert auth.session(guest)["authenticated"]
    assert auth.sessions(owner)[1]["label"] == "Chrome · Android"
    with pytest.raises(AuthError):
        auth.pair(code["code"], "wife")

def test_pairing_requires_issuer_session(auth):
    with pytest.raises(AuthError):
        auth.create_pairing_code("wrong")

def test_new_code_replaces_previous(auth):
    owner = login(auth)
    with patch("xk_switcher.auth.secrets.randbelow", side_effect=[123456, 234567]):
        first = auth.create_pairing_code(owner)["code"]
        second = auth.create_pairing_code(owner)["code"]
    with pytest.raises(AuthError):
        auth.pair(first, "ip")
    assert auth.session(auth.pair(second, "ip"))["authenticated"]

def test_code_expires_and_restart_cancels_code(auth):
    now = [1000]
    auth._clock = lambda: now[0]
    owner = login(auth)
    code = auth.create_pairing_code(owner)["code"]
    now[0] += 300
    with pytest.raises(AuthError):
        auth.pair(code, "ip")
    code = auth.create_pairing_code(owner)["code"]
    restarted = Auth(auth.path.parent)
    with pytest.raises(AuthError):
        restarted.pair(code, "ip")
    assert restarted.session(owner)["authenticated"]

def test_five_incorrect_attempts_cancel_code_across_ips(auth):
    owner = login(auth)
    code = auth.create_pairing_code(owner)["code"]
    for attempt in range(5):
        with pytest.raises(AuthError):
            auth.pair("bad", f"ip{attempt}")
    with pytest.raises(AuthError):
        auth.pair(code, "new-ip")
    assert len(auth.sessions(owner)) == 1

def test_only_one_parallel_request_can_redeem_code(auth):
    owner = login(auth)
    invitation = auth.create_pairing_code(owner)
    code = invitation["code"]
    def redeem(index):
        try:
            return auth.pair(code, f"ip{index}")
        except AuthError:
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(redeem, range(8)))
    assert sum(result is not None for result in results) == 1
    assert len(auth.sessions(owner)) == 2
    result = auth.pairing_status(owner, invitation["id"])
    winner = next(secret for secret in results if secret is not None)
    assert result["status"] == "completed"
    assert result["device"]["id"] == auth.session(winner)["session_id"]

def test_revoke_one_session_preserves_other_and_cancels_issued_code(auth):
    owner, guest = login(auth), login(auth, "wife")
    code = auth.create_pairing_code(guest)["code"]
    guest_id = auth.session(guest)["session_id"]
    assert not auth.revoke(owner, guest_id)
    assert not auth.session(guest)["authenticated"]
    assert auth.session(owner)["authenticated"]
    with pytest.raises(AuthError):
        auth.pair(code, "third")
    assert auth.revoke(owner)
    assert not auth.session(owner)["authenticated"]

def test_password_reset_revokes_sessions_and_code(auth):
    owner = login(auth)
    code = auth.create_pairing_code(owner)["code"]
    auth.set_password("new-home-password")
    assert not auth.session(owner)["authenticated"]
    with pytest.raises(AuthError):
        auth.pair(code, "wife")
    with pytest.raises(AuthError):
        login(auth)
    assert auth.session(auth.login("new-home-password", "owner"))["authenticated"]

def test_setup_creates_password_and_first_session_once(tmp_path):
    auth = Auth(tmp_path)
    secret = auth.setup_password(TEST_PASSWORD, "ip", "Safari/1 iPhone")
    assert auth.session(secret)["authenticated"]
    assert len(auth.sessions(secret)) == 1
    before = auth.path.read_bytes()
    with pytest.raises(AuthError) as error:
        auth.setup_password("replacement-password", "ip")
    assert error.value.status == 409
    assert auth.path.read_bytes() == before

def test_parallel_setup_has_one_winner(tmp_path):
    auth = Auth(tmp_path)
    def setup(index):
        try:
            return auth.setup_password(TEST_PASSWORD, str(index))
        except AuthError as error:
            assert error.status == 409
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(setup, range(4)))
    assert sum(secret is not None for secret in results) == 1

def test_setup_cannot_overwrite_corrupt_auth(tmp_path):
    auth = Auth(tmp_path)
    auth.path.write_text("broken")
    with pytest.raises(AuthError) as error:
        auth.setup_password(TEST_PASSWORD, "ip")
    assert error.value.status == 503
    assert auth.path.read_text() == "broken"

def test_change_password_replaces_sessions_and_pairing_atomically(auth):
    owner, other = login(auth), login(auth, "other")
    code = auth.create_pairing_code(other)["code"]
    replacement = auth.change_password(owner, TEST_PASSWORD, "new-admin-password", "ip", "Chrome/1 Android")
    assert not auth.session(owner)["authenticated"]
    assert not auth.session(other)["authenticated"]
    assert auth.session(replacement)["authenticated"]
    assert len(auth.sessions(replacement)) == 1
    with pytest.raises(AuthError):
        auth.pair(code, "ip")
    with pytest.raises(AuthError):
        login(auth)
    assert auth.session(auth.login("new-admin-password", "ip"))["authenticated"]

@pytest.mark.parametrize("invalid", ["session", "current", "new"])
def test_change_password_requires_session_current_password_and_valid_new_password(auth, invalid):
    owner = login(auth)
    before = auth.path.read_bytes()
    with pytest.raises(AuthError):
        auth.change_password(
            "wrong" if invalid == "session" else owner,
            "incorrect-password" if invalid == "current" else TEST_PASSWORD,
            "short" if invalid == "new" else "new-admin-password", "ip",
        )
    assert auth.path.read_bytes() == before

def test_failed_password_change_write_preserves_old_login_and_pairing(auth, monkeypatch):
    owner = login(auth)
    code = auth.create_pairing_code(owner)["code"]
    with monkeypatch.context() as patcher:
        patcher.setattr(auth, "_write", lambda data: (_ for _ in ()).throw(AuthError("disk full", 503)))
        with pytest.raises(AuthError):
            auth.change_password(owner, TEST_PASSWORD, "new-admin-password", "ip")
    assert auth.session(owner)["authenticated"]
    assert auth.session(auth.pair(code, "ip"))["authenticated"]

@pytest.mark.parametrize("method", ["password", "code"])
def test_rate_limit_and_recovery(auth, method):
    now = [1000]
    auth._clock = lambda: now[0]
    attempt = (lambda ip: auth.login("wrong-password", ip)) if method == "password" else (lambda ip: auth.pair("000000", ip))
    for _ in range(10):
        with pytest.raises(AuthError) as error:
            attempt("ip")
        assert error.value.status == 401
    with pytest.raises(AuthError) as error:
        attempt("ip")
    assert error.value.status == 429 and error.value.retry_after == LOGIN_WINDOW_SEC
    with pytest.raises(AuthError) as error:
        attempt("another-ip")
    assert error.value.status == 401
    now[0] += LOGIN_WINDOW_SEC
    with pytest.raises(AuthError) as error:
        attempt("ip")
    assert error.value.status == 401

def test_parallel_rate_limit(auth):
    def attempt(_):
        try:
            auth.pair("bad", "same-ip")
        except AuthError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(attempt, range(20)))
    assert results.count(401) == 10
    assert results.count(429) == 10

@pytest.mark.parametrize("contents", ["broken", "null", "[]", "{}", '{"schema_version": 999}'])
def test_corruption_fails_closed_and_offline_reset_recovers(auth, contents):
    owner = login(auth)
    auth.path.write_text(contents)
    with pytest.raises(AuthError) as error:
        auth.session(owner)
    assert error.value.status == 503
    assert auth.path.read_text() == contents
    auth.set_password(TEST_PASSWORD)
    assert not auth.session(owner)["authenticated"]
    assert auth.session(login(auth))["authenticated"]

def test_missing_password_requires_setup_before_login(tmp_path):
    auth = Auth(tmp_path)
    assert auth.session("") == {"configured": False, "authenticated": False, "session_id": None}
    with pytest.raises(AuthError) as error:
        login(auth)
    assert error.value.status == 409
    assert not auth.path.exists()

def test_failed_session_write_does_not_consume_code(auth, monkeypatch):
    owner = login(auth)
    invitation = auth.create_pairing_code(owner)
    code = invitation["code"]
    with monkeypatch.context() as context:
        def fail(_):
            raise AuthError("save failed", 503)
        context.setattr(auth, "_write", fail)
        with pytest.raises(AuthError):
            auth.pair(code, "wife")
        assert auth.pairing_status(owner, invitation["id"])["status"] == "pending"
    assert auth.session(auth.pair(code, "wife"))["authenticated"]

def test_pairing_result_belongs_to_invitation_and_issuer(auth):
    owner = login(auth)
    invitation = auth.create_pairing_code(owner)
    other = login(auth, "other")
    before = auth.path.read_bytes()
    assert auth.pairing_status(owner, invitation["id"])["status"] == "pending"
    assert auth.path.read_bytes() == before
    with pytest.raises(AuthError) as error:
        auth.pairing_status(other, invitation["id"])
    assert error.value.status == 404
    guest = auth.pair(invitation["code"], "guest", "Safari/604.1 iPhone")
    result = auth.pairing_status(owner, invitation["id"])
    assert result["device"] == {k: auth.sessions(guest)[-1][k] for k in ("id", "label", "created_at")}
    assert result["device"]["label"] == "Safari · iPhone"
    assert "code" not in result and "secret_hash" not in result["device"]
    auth.create_pairing_code(other)
    assert auth.pairing_status(owner, invitation["id"]) == result

@pytest.mark.parametrize("outcome", ["expired", "replaced", "exhausted"])
def test_pairing_terminal_reason(auth, outcome):
    owner = login(auth)
    invitation = auth.create_pairing_code(owner)
    if outcome == "expired":
        auth._clock = lambda: invitation["expires_at"]
    elif outcome == "replaced":
        auth.create_pairing_code(login(auth, "other"))
    else:
        for i in range(5):
            with pytest.raises(AuthError):
                auth.pair("bad", str(i))
    assert auth.pairing_status(owner, invitation["id"])["status"] == outcome
    with pytest.raises(AuthError):
        auth.pair(invitation["code"], "late")
    assert auth.pairing_status(owner, invitation["id"])["status"] == outcome

def test_pairing_results_are_bounded_and_transient(auth):
    from xk_switcher.auth import PAIRING_HISTORY_LIMIT, PAIRING_RESULT_TTL_SEC
    owner = login(auth)
    first = auth.create_pairing_code(owner)
    for _ in range(PAIRING_HISTORY_LIMIT):
        last = auth.create_pairing_code(owner)
    assert len(auth._pairing_history) == PAIRING_HISTORY_LIMIT
    with pytest.raises(AuthError) as error:
        auth.pairing_status(owner, first["id"])
    assert error.value.status == 404
    auth.pair(last["code"], "guest")
    now = auth._clock()
    auth._clock = lambda: now + PAIRING_RESULT_TTL_SEC
    with pytest.raises(AuthError):
        auth.pairing_status(owner, last["id"])
    assert not auth._pairing_history
    new = auth.create_pairing_code(owner)
    with pytest.raises(AuthError):
        Auth(auth.path.parent).pairing_status(owner, new["id"])
    assert auth.session(owner)["authenticated"]

def test_revocation_removes_issuer_pairing_history(auth):
    owner, other = login(auth), login(auth, "other")
    invitation = auth.create_pairing_code(owner)
    auth.revoke(other, auth.session(owner)["session_id"])
    assert invitation["id"] not in auth._pairing_history
    with pytest.raises(AuthError):
        auth.pair(invitation["code"], "guest")


def test_replacement_cannot_repeat_previous_code(auth):
    owner = login(auth)
    with patch("xk_switcher.auth.secrets.randbelow", return_value=123456):
        old = auth.create_pairing_code(owner)["code"]
        new = auth.create_pairing_code(owner)["code"]
    assert old != new
    with pytest.raises(AuthError):
        auth.pair(old, "wife")
    assert auth.session(auth.pair(new, "wife"))["authenticated"]


def test_cli_password_reset_and_no_password_output(auth, monkeypatch, capsys):
    from xk_switcher.auth import main
    owner = login(auth)
    monkeypatch.setattr("sys.argv", ["auth", "set-password", "--data-dir", str(auth.path.parent)])
    answers = iter(["new-test-password", "new-test-password"])
    monkeypatch.setattr("getpass.getpass", lambda _: next(answers))
    main()
    output = capsys.readouterr()
    assert "new-test-password" not in output.out + output.err
    assert "All devices have been signed out" in output.out
    assert not auth.session(owner)["authenticated"]
    assert auth.session(auth.login("new-test-password", "owner"))["authenticated"]


def test_cli_mismatch_preserves_existing_password(auth, monkeypatch, capsys):
    from xk_switcher.auth import main
    owner = login(auth)
    before = auth.path.read_bytes()
    monkeypatch.setattr("sys.argv", ["auth", "set-password", "--data-dir", str(auth.path.parent)])
    answers = iter(["new-test-password", "another-password"])
    monkeypatch.setattr("getpass.getpass", lambda _: next(answers))
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 1
    assert auth.path.read_bytes() == before
    assert auth.session(owner)["authenticated"]
    assert "new-test-password" not in capsys.readouterr().err


def test_unwritable_store_reports_service_error(tmp_path):
    parent = tmp_path / "not-a-directory"
    parent.write_text("file")
    with pytest.raises(AuthError) as error:
        Auth(parent).set_password(TEST_PASSWORD)
    assert error.value.status == 503
