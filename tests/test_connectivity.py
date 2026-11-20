import urllib.error

import pytest

from xk_switcher.connectivity import (
    _check_target,
    check_route,
    check_route_urls,
    validate_route_check_urls,
)


class _Response:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _size):
        return b""


def test_check_target_reports_http_success_and_latency():
    ticks = iter([10.0, 10.087])
    result = _check_target(
        "youtube",
        "https://www.youtube.com/generate_204",
        timeout_sec=5,
        open_fn=lambda _req, timeout: _Response(204),
        clock=lambda: next(ticks),
    )
    assert result == {
        "name": "youtube",
        "url": "https://www.youtube.com/generate_204",
        "ok": True,
        "status": 204,
        "latency_ms": 86,
        "error": None,
    }


def test_check_target_reports_http_error_as_unusable():
    def fail(_req, timeout):
        raise urllib.error.HTTPError(
            "https://www.avito.ru/", 403, "Forbidden", {}, None,
        )

    ticks = iter([10.0, 10.020])
    result = _check_target(
        "avito",
        "https://www.avito.ru/",
        timeout_sec=5,
        open_fn=fail,
        clock=lambda: next(ticks),
    )
    assert result["ok"] is False
    assert result["status"] == 403
    assert result["error"] == "HTTP 403"


def test_check_target_treats_rate_limit_as_reachable_route():
    def fail(_req, timeout):
        raise urllib.error.HTTPError(
            "https://www.avito.ru/", 429, "Too Many Requests", {}, None,
        )

    ticks = iter([10.0, 10.020])
    result = _check_target(
        "avito",
        "https://www.avito.ru/",
        timeout_sec=5,
        open_fn=fail,
        clock=lambda: next(ticks),
    )

    assert result["ok"] is True
    assert result["status"] == 429
    assert result["error"] is None


def test_check_route_succeeds_when_any_target_succeeds():
    def checker(name, url, timeout_sec):
        return {
            "name": name,
            "url": url,
            "ok": name == "youtube",
            "status": 204 if name == "youtube" else 403,
            "latency_ms": 10,
            "error": None if name == "youtube" else "HTTP 403",
        }

    result = check_route(
        targets=(("youtube", "https://youtube"), ("avito", "https://avito")),
        checker=checker,
    )
    assert result["ok"] is True
    assert [r["name"] for r in result["results"]] == ["youtube", "avito"]


def test_check_route_fails_when_every_target_fails():
    def checker(name, url, timeout_sec):
        return {
            "name": name,
            "url": url,
            "ok": False,
            "status": 503,
            "latency_ms": 10,
            "error": "HTTP 503",
        }

    result = check_route(
        targets=(("youtube", "https://youtube"), ("avito", "https://avito")),
        checker=checker,
    )

    assert result["ok"] is False


def test_check_route_urls_succeeds_when_any_configured_resource_works():
    seen = []

    def checker(name, url, timeout_sec):
        seen.append((name, url))
        return {
            "name": name,
            "url": url,
            "ok": url == "https://working.example/health",
            "status": 204 if url == "https://working.example/health" else 503,
            "latency_ms": 10,
            "error": None,
        }

    result = check_route_urls([
        "https://broken.example/health",
        "https://working.example/health",
        "http://backup.example/ping",
    ], checker=checker)

    assert result["ok"] is True
    assert set(seen) == {
        ("broken.example", "https://broken.example/health"),
        ("working.example", "https://working.example/health"),
        ("backup.example", "http://backup.example/ping"),
    }


@pytest.mark.parametrize("value", [
    [],
    "https://example.com",
    [""],
    ["ftp://example.com/file"],
    ["not a url"],
    ["https://example.com", "https://example.com"],
])
def test_validate_route_check_urls_rejects_invalid_values(value):
    with pytest.raises(ValueError):
        validate_route_check_urls(value)


def test_validate_route_check_urls_trims_values():
    assert validate_route_check_urls(["  https://example.com/health  "]) == [
        "https://example.com/health",
    ]
