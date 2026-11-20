"""Password authentication, persistent sessions, and one-use pairing codes."""
import argparse
import getpass
import hashlib
import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

AUTH_FILE = "auth.json"
SCHEMA_VERSION = 1
PASSWORD_ITERATIONS = 600_000
PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 128
SECRET_BYTES = 32
PAIRING_CODE_SPACE = 1_000_000
PAIRING_TTL_SEC = 300
PAIRING_MAX_ERRORS = 5
PAIRING_RESULT_TTL_SEC = 86_400
PAIRING_HISTORY_LIMIT = 128
LOGIN_WINDOW_SEC = 900
LOGIN_MAX_ATTEMPTS = 10
HEX_SECRET = re.compile(r"[0-9a-f]{64}\Z")

class AuthError(Exception):
    def __init__(self, message, status=401, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after

class Auth:
    def __init__(self, data_dir: Path, *, clock=time.time):
        self.path = Path(data_dir) / AUTH_FILE
        self._clock = clock
        self._lock = threading.RLock()
        self._pairing = None
        self._pairing_history = {}
        self._attempts = {}

    def _read(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            password = data["password"]
            sessions = data["sessions"]
            valid = (
                data["schema_version"] == SCHEMA_VERSION
                and password["algorithm"] == "pbkdf2-sha256"
                and password["iterations"] == PASSWORD_ITERATIONS
                and self._is_hash(password["salt"])
                and self._is_hash(password["hash"])
                and isinstance(sessions, list)
                and all(
                    isinstance(s, dict)
                    and self._is_hash(s.get("secret_hash"))
                    and isinstance(s.get("id"), str) and bool(s["id"])
                    and isinstance(s.get("label"), str)
                    and isinstance(s.get("created_at"), str)
                    for s in sessions
                )
            )
            if not valid or len({s["id"] for s in sessions}) != len(sessions):
                raise ValueError("invalid auth schema")
            return data
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError):
            raise AuthError("Authentication storage unavailable; reset password on server", 503) from None

    @staticmethod
    def _is_hash(value):
        return isinstance(value, str) and HEX_SECRET.fullmatch(value) is not None

    def _write(self, data):
        tmp = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                             prefix=".auth-", delete=False) as f:
                tmp = Path(f.name)
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            tmp.replace(self.path)
        except OSError:
            raise AuthError("Unable to save authentication storage", 503) from None
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)

    def set_password(self, password):
        """Offline operation: stop the HTTP server before calling from the CLI."""
        data = self._password_data(password)
        with self._lock:
            self._write(data)
            self._clear_transient()

    def _password_data(self, password):
        self._validate_password(password)
        salt = secrets.token_bytes(SECRET_BYTES)
        digest = self._password_hash(password, salt)
        return {
            "schema_version": SCHEMA_VERSION,
            "password": {"algorithm": "pbkdf2-sha256", "iterations": PASSWORD_ITERATIONS,
                         "salt": salt.hex(), "hash": digest},
            "sessions": [],
        }

    def _clear_transient(self):
        self._pairing = None
        self._pairing_history.clear()
        self._attempts.clear()

    def setup_password(self, password, ip, user_agent=""):
        """Initialize an absent auth store and sign in its first browser atomically."""
        with self._lock:
            if self._read() is not None:
                raise AuthError("Admin password is already configured; sign in", 409)
            self._limit("setup", ip)
            secret = self._new_session(self._password_data(password), user_agent)
            self._clear_transient()
            return secret

    def change_password(self, secret, current_password, password, ip, user_agent=""):
        with self._lock:
            data = self._read()
            self._require_session(data, secret)
            self._limit("password", ip)
            self._validate_password(current_password)
            stored = data["password"]
            digest = self._password_hash(current_password, bytes.fromhex(stored["salt"]))
            if not secrets.compare_digest(digest, stored["hash"]):
                raise AuthError("Incorrect current admin password", 403)
            # One write replaces the password and all sessions with this browser's new session.
            replacement = self._new_session(self._password_data(password), user_agent)
            self._clear_transient()
            return replacement

    @staticmethod
    def _validate_password(password):
        if not isinstance(password, str) or not PASSWORD_MIN_LENGTH <= len(password) <= PASSWORD_MAX_LENGTH:
            raise AuthError("Password must contain 12–128 characters", 400)
        try:
            password.encode("utf-8")
        except UnicodeEncodeError:
            raise AuthError("Invalid password encoding", 400) from None

    @staticmethod
    def _password_hash(password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt,
                                   PASSWORD_ITERATIONS).hex()

    @staticmethod
    def _session(data, secret):
        if data is None or not Auth._is_hash(secret):
            return None
        digest = hashlib.sha256(secret.encode("ascii")).hexdigest()
        return next((s for s in data["sessions"]
                     if secrets.compare_digest(s["secret_hash"], digest)), None)

    def session(self, secret):
        with self._lock:
            data = self._read()
            session = self._session(data, secret)
            return {"configured": data is not None, "authenticated": session is not None,
                    "session_id": session["id"] if session else None}

    def _require_session(self, data, secret):
        session = self._session(data, secret)
        if session is None:
            raise AuthError("unauthorized")
        return session

    def _limit(self, method, ip):
        now = self._clock()
        self._attempts = {k: [t for t in times if t > now - LOGIN_WINDOW_SEC]
                          for k, times in self._attempts.items()
                          if times and times[-1] > now - LOGIN_WINDOW_SEC}
        attempts = self._attempts.setdefault((method, ip), [])
        if len(attempts) >= LOGIN_MAX_ATTEMPTS:
            retry = max(1, math.ceil(attempts[0] + LOGIN_WINDOW_SEC - now))
            raise AuthError("Too many attempts; try again later", 429, retry)
        attempts.append(now)

    def login(self, password, ip, user_agent=""):
        with self._lock:
            self._limit("password", ip)
            self._validate_password(password)
            data = self._read()
            if data is None:
                raise AuthError("Create an admin password first", 409)
            stored = data["password"]
            digest = self._password_hash(password, bytes.fromhex(stored["salt"]))
            if not secrets.compare_digest(digest, stored["hash"]):
                raise AuthError("Incorrect password")
            return self._new_session(data, user_agent)

    def _new_session(self, data, user_agent):
        secret = secrets.token_hex(SECRET_BYTES)
        data["sessions"].append({
            "id": secrets.token_hex(16),
            "secret_hash": hashlib.sha256(secret.encode("ascii")).hexdigest(),
            "label": device_label(user_agent),
            "created_at": datetime.fromtimestamp(self._clock(), timezone.utc).isoformat(),
        })
        self._write(data)
        return secret

    def create_pairing_code(self, secret):
        with self._lock:
            data = self._read()
            session = self._require_session(data, secret)
            self._prune_pairing()
            # Exclude the previous value so replacement always invalidates it.
            previous = int(self._pairing["code"]) if self._pairing else None
            number = secrets.randbelow(PAIRING_CODE_SPACE - (previous is not None))
            if previous is not None and number >= previous:
                number += 1
            code = f"{number:06d}"
            self._finish_pairing("replaced")
            self._pairing = {"id": secrets.token_hex(16), "status": "pending",
                             "code": code, "issuer_id": session["id"],
                             "expires_at": self._clock() + PAIRING_TTL_SEC, "errors": 0}
            self._pairing_history[self._pairing["id"]] = self._pairing
            while len(self._pairing_history) > PAIRING_HISTORY_LIMIT:
                del self._pairing_history[next(iter(self._pairing_history))]
            return {k: self._pairing[k] for k in ("id", "status", "code", "expires_at")}

    def _finish_pairing(self, status, device=None):
        if self._pairing is None:
            return
        self._pairing.update(status=status, finished_at=self._clock())
        self._pairing.pop("code", None)
        if device is not None:
            self._pairing["device"] = device
        self._pairing = None

    def _prune_pairing(self):
        now = self._clock()
        if self._pairing and now >= self._pairing["expires_at"]:
            self._finish_pairing("expired")
        self._pairing_history = {
            key: record for key, record in self._pairing_history.items()
            if record["status"] == "pending"
            or now - record["finished_at"] < PAIRING_RESULT_TTL_SEC
        }

    def pairing_status(self, secret, invitation_id):
        with self._lock:
            session = self._require_session(self._read(), secret)
            self._prune_pairing()
            record = self._pairing_history.get(invitation_id)
            if record is None or record["issuer_id"] != session["id"]:
                raise AuthError("Pairing request not found; create a new code", 404)
            return {k: record[k] for k in ("id", "status", "expires_at", "device") if k in record}

    def pair(self, code, ip, user_agent=""):
        with self._lock:
            self._limit("code", ip)
            data = self._read()
            self._prune_pairing()
            pairing = self._pairing
            if (pairing is None or self._clock() >= pairing["expires_at"] or data is None
                    or not any(s["id"] == pairing["issuer_id"] for s in data["sessions"])):
                self._finish_pairing("cancelled")
                raise AuthError("Code is incorrect or expired")
            normalized = "".join(code.split()) if isinstance(code, str) else ""
            if not re.fullmatch(r"[0-9]{6}", normalized) or not secrets.compare_digest(normalized, pairing["code"]):
                pairing["errors"] += 1
                if pairing["errors"] >= PAIRING_MAX_ERRORS:
                    self._finish_pairing("exhausted")
                raise AuthError("Code is incorrect or expired")
            secret = self._new_session(data, user_agent)
            created = data["sessions"][-1]
            self._finish_pairing("completed", {k: created[k] for k in ("id", "label", "created_at")})
            return secret

    def sessions(self, secret):
        with self._lock:
            data = self._read()
            current = self._require_session(data, secret)
            return [{"id": s["id"], "label": s["label"], "created_at": s["created_at"],
                     "current": s["id"] == current["id"]} for s in data["sessions"]]

    def revoke(self, secret, session_id=None):
        with self._lock:
            data = self._read()
            current = self._require_session(data, secret)
            target = current["id"] if session_id is None else session_id
            if not isinstance(target, str) or not target:
                raise AuthError("Invalid session id", 400)
            if not any(s["id"] == target for s in data["sessions"]):
                raise AuthError("Session not found", 404)
            data["sessions"] = [s for s in data["sessions"] if s["id"] != target]
            self._write(data)
            if self._pairing and self._pairing["issuer_id"] == target:
                self._finish_pairing("cancelled")
            self._pairing_history = {k: v for k, v in self._pairing_history.items()
                                     if v["issuer_id"] != target}
            return target == current["id"]

def device_label(user_agent):
    browser = next((label for marker, label in [
        ("Edg/", "Edge"), ("EdgiOS/", "Edge"), ("Firefox/", "Firefox"),
        ("FxiOS/", "Firefox"), ("Chrome/", "Chrome"), ("CriOS/", "Chrome"),
        ("Safari/", "Safari"),
    ] if marker in user_agent), "Browser")
    platform = next((label for marker, label in [
        ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
        ("Windows", "Windows"), ("Macintosh", "Mac"), ("Linux", "Linux"),
    ] if marker in user_agent), "device")
    return f"{browser} · {platform}"

def main():
    parser = argparse.ArgumentParser(description="Set the admin password while the server is stopped")
    parser.add_argument("command", choices=["set-password"])
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("DATA_DIR", "/data")))
    args = parser.parse_args()
    try:
        password = getpass.getpass("New password (12–128 characters): ")
        if password != getpass.getpass("Repeat password: "):
            raise AuthError("Passwords do not match", 400)
        Auth(args.data_dir).set_password(password)
    except (AuthError, EOFError, KeyboardInterrupt) as e:
        parser.exit(1, f"{e or 'Cancelled'}\n")
    print("Password saved. All devices have been signed out.")

if __name__ == "__main__":
    main()
