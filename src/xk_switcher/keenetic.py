"""Keenetic's authenticated HTTP RCI transport; independent of Entware/SSH."""
import hashlib
import http.cookiejar
import json
import threading
import urllib.error
import urllib.parse
import urllib.request

RCI_TIMEOUT_SEC = 10
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

class KeeneticError(Exception):
    def __init__(self, message, status=502, code="keenetic_error"):
        super().__init__(message)
        self.status = status
        self.code = code

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class KeeneticClient:
    def __init__(self, url, user, password, *, timeout=RCI_TIMEOUT_SEC):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise ValueError("KEENETIC_URL must be an HTTP(S) origin without credentials or a path")
        self.url = url.rstrip("/")
        self.user = user
        self.password = password
        self.timeout = timeout
        self._lock = threading.RLock()
        self._cookies = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPCookieProcessor(self._cookies),
        )

    @property
    def configured(self):
        return bool(self.user and self.password)

    def _request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        request = urllib.request.Request(self.url + path, data=data, headers={
            "Accept": "application/json", "Content-Type": "application/json",
        })
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise KeeneticError("Keenetic returned too much data")
                return response.status, response.headers, raw
        except urllib.error.HTTPError as error:
            # Never echo credential-bearing requests, authentication bodies or HTML.
            error.close()
            return error.code, error.headers, b""
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise KeeneticError("Cannot reach Keenetic. Check its address and connection.", code="unreachable") from error

    def _authenticate(self):
        self._cookies.clear()
        status, headers, _ = self._request("/auth")
        if status == 200:
            return
        realm, challenge = headers.get("X-NDM-Realm"), headers.get("X-NDM-Challenge")
        if status != 401 or not realm or not challenge:
            raise KeeneticError("Keenetic authentication is not supported by this firmware.", 503, "authentication")
        digest = hashlib.md5(f"{self.user}:{realm}:{self.password}".encode()).hexdigest()
        response = hashlib.sha256((challenge + digest).encode()).hexdigest()
        status, _, _ = self._request("/auth", {"login": self.user, "password": response})
        if status != 200:
            raise KeeneticError("Keenetic rejected the web-interface credentials. Check KEENETIC_USER and KEENETIC_PASSWORD.", 503, "authentication")

    def rci(self, path, payload=None):
        if not self.configured:
            raise KeeneticError("Set KEENETIC_USER and KEENETIC_PASSWORD on the server to manage router devices.", 503, "not_configured")
        with self._lock:
            status, _, raw = self._request("/rci/" + path, payload)
            if status == 401:
                self._authenticate()
                # Only an explicit 401 is retried; uncertain writes are never replayed.
                status, _, raw = self._request("/rci/" + path, payload)
            if status != 200:
                raise KeeneticError(f"Keenetic API returned HTTP {status}.")
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeError) as error:
                raise KeeneticError("Keenetic returned an invalid response.") from error
            self._check_errors(result)
            return result

    @classmethod
    def _check_errors(cls, value):
        if isinstance(value, dict):
            if value.get("status") in ("error", "failed") or value.get("level") == "error":
                raise KeeneticError("Keenetic rejected the change. Refresh devices and try again.", code="rejected")
            for child in value.values():
                cls._check_errors(child)
        elif isinstance(value, list):
            for child in value:
                cls._check_errors(child)
