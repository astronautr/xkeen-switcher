"""HTTPS reachability checks for the route currently used by the server."""
import socket
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable
from urllib.parse import urlsplit

ROUTE_CHECK_TIMEOUT_SEC = 5
ROUTE_CHECK_TARGETS = (
    ("youtube", "https://www.youtube.com/generate_204"),
    ("avito", "https://www.avito.ru/"),
)
DEFAULT_ROUTE_CHECK_URLS = tuple(url for _, url in ROUTE_CHECK_TARGETS)
MAX_ROUTE_CHECK_URLS = 10
MAX_ROUTE_CHECK_URL_LENGTH = 2048
ROUTE_CHECK_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
)
HTTP_OK_MIN = 200
HTTP_OK_MAX_EXCLUSIVE = 400
HTTP_ROUTE_REACHABLE_CODES = {429}


def check_route(
    targets: tuple[tuple[str, str], ...] = ROUTE_CHECK_TARGETS,
    timeout_sec: int = ROUTE_CHECK_TIMEOUT_SEC,
    checker: Callable | None = None,
) -> dict:
    """Check targets in parallel; the route works if any target is usable."""
    checker = checker or _check_target
    with ThreadPoolExecutor(max_workers=len(targets), thread_name_prefix="xk-route") as pool:
        futures = [pool.submit(checker, name, url, timeout_sec) for name, url in targets]
        results = [future.result() for future in futures]
    return {
        "ok": any(result["ok"] for result in results),
        "results": results,
    }


def check_route_urls(
    urls: list[str] | tuple[str, ...],
    timeout_sec: int = ROUTE_CHECK_TIMEOUT_SEC,
    checker: Callable | None = None,
) -> dict:
    """Check configured URLs; the route works when at least one URL works."""
    checked_urls = validate_route_check_urls(urls)
    targets = tuple((_target_name(url), url) for url in checked_urls)
    return check_route(targets=targets, timeout_sec=timeout_sec, checker=checker)


def validate_route_check_urls(value) -> list[str]:
    if not isinstance(value, (list, tuple)):
        raise ValueError("check_urls must be a list of HTTP(S) URLs")
    if not value:
        raise ValueError("at least one check URL is required")
    if len(value) > MAX_ROUTE_CHECK_URLS:
        raise ValueError(f"at most {MAX_ROUTE_CHECK_URLS} check URLs are allowed")
    urls = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("check_urls must be a list of HTTP(S) URLs")
        url = item.strip()
        if not url:
            raise ValueError("check URL must not be empty")
        if len(url) > MAX_ROUTE_CHECK_URL_LENGTH:
            raise ValueError("check URL is too long")
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError(f"invalid HTTP(S) check URL: {url}")
        urls.append(url)
    if len(urls) != len(set(urls)):
        raise ValueError("duplicate check URLs are not allowed")
    return urls


def _target_name(url: str) -> str:
    parsed = urlsplit(url)
    return parsed.hostname or url


def _check_target(
    name: str,
    url: str,
    timeout_sec: int,
    open_fn=None,
    clock: Callable[[], float] = time.monotonic,
) -> dict:
    open_fn = open_fn or urllib.request.urlopen
    request = urllib.request.Request(url, headers={"User-Agent": ROUTE_CHECK_USER_AGENT})
    started = clock()
    status = None
    error = None
    try:
        with open_fn(request, timeout=timeout_sec) as response:
            status = response.status
            response.read(1)
        ok = HTTP_OK_MIN <= status < HTTP_OK_MAX_EXCLUSIVE
        if not ok:
            error = f"HTTP {status}"
    except urllib.error.HTTPError as exc:
        status = exc.code
        ok = exc.code in HTTP_ROUTE_REACHABLE_CODES
        error = None if ok else f"HTTP {exc.code}"
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        ok = False
        error = _error_message(exc)
    latency_ms = int((clock() - started) * 1000)
    return {
        "name": name,
        "url": url,
        "ok": ok,
        "status": status,
        "latency_ms": latency_ms,
        "error": error,
    }


def _error_message(exc: Exception) -> str:
    reason = getattr(exc, "reason", exc)
    text = str(reason).strip()
    return text or type(reason).__name__
