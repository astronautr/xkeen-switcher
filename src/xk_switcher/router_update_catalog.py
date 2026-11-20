"""Read official stable release metadata and verify router installation payloads."""
import hashlib
import io
import json
import re
import threading
import time
import urllib.error
import urllib.request
import zipfile

REPOSITORIES = {"xkeen": "jameszeroX/XKeen", "xray": "XTLS/Xray-core"}
XRAY_ARCHES = {
    "aarch64": "arm64-v8a", "arm64": "arm64-v8a", "armv7l": "arm32-v7a",
    "x86_64": "64", "mipsel": "mips32le", "mipsle": "mips32le", "mipsbe": "mips32",
    "mips64el": "mips64le", "mips64be": "mips64",
}
XKEEN_21_SHA256 = "4b9350b11fab7fd3e4973db609db0fb780994f4b5ab0096f0549bc52acac8c73"
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_BINARY = 128 * 1024 * 1024
MAX_METADATA = 8 * 1024 * 1024
REQUEST_TIMEOUT = 45
VERSION = re.compile(r"[0-9]{1,6}(?:\.[0-9]{1,6}){1,3}")
_etags = {}
_retry_after = {}
_cache_lock = threading.Lock()

class ReleaseChecksumChanged(ValueError):
    pass

def _version(value):
    return tuple(map(int, value.split("."))) if isinstance(value, str) and VERSION.fullmatch(value) else ()

def _read_limited(response, limit):
    length = response.headers.get("Content-Length")
    if length and int(length) > limit:
        raise ValueError("Release exceeds the download limit")
    data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Release exceeds the download limit")
    return data

def _metadata(repo, tag=None):
    path = f"/tags/{tag}" if tag else "?per_page=25"
    url = f"https://api.github.com/repos/{repo}/releases{path}"
    with _cache_lock:
        if _retry_after.get(repo, 0) > time.time():
            raise ValueError("Release catalog rate limit is active")
        etag, cached = _etags.get(url, (None, None))
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "xkeen-switcher"}
    if etag:
        headers["If-None-Match"] = etag
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=REQUEST_TIMEOUT) as response:
            data = json.loads(_read_limited(response, MAX_METADATA))
            etag = response.headers.get("ETag")
    except urllib.error.HTTPError as error:
        if error.code == 304 and cached is not None:
            return cached
        if error.code in {403, 429}:
            now = time.time()
            reset = error.headers.get("X-RateLimit-Reset", "")
            delay = error.headers.get("Retry-After", "")
            until = max(now + (int(delay) if delay.isdecimal() else 60), int(reset) if reset.isdecimal() else 0)
            with _cache_lock:
                _retry_after[repo] = until
        raise
    if not isinstance(data, dict if tag else list):
        raise ValueError("Unexpected release catalog")
    with _cache_lock:
        _etags[url] = etag, data
    return data

def _release(component, arch, installed, entry):
    repo = REPOSITORIES[component]
    current = installed.get(component)
    if isinstance(current, dict):
        current = current.get("installed")
    current_key = _version(current)
    arch_name = XRAY_ARCHES.get(arch)
    if entry.get("draft") or entry.get("prerelease"):
        return None
    tag = entry["tag_name"]
    version = tag.removeprefix("v")
    version_key = _version(version)
    if not version_key or version_key <= current_key:
        return None
    asset_name = "xkeen.tar.gz" if component == "xkeen" else f"Xray-linux-{arch_name}.zip"
    asset = next((a for a in entry["assets"] if a.get("name") == asset_name), {})
    algorithm, _, digest = (asset.get("digest") or "").partition(":")
    url = f"https://github.com/{repo}/releases/download/{tag}/{asset_name}"
    reason = None
    if not current_key:
        reason = "Installed version is unknown"
    elif component == "xkeen" and (current, version) != ("2.0", "2.1"):
        reason = "This XKeen migration is not supported yet"
    elif component == "xray" and not arch_name:
        reason = "No supported Xray binary for this architecture"
    elif asset.get("browser_download_url") != url or algorithm != "sha256" or not re.fullmatch("[a-f0-9]{64}", digest):
        reason = "Official release asset or SHA-256 is unavailable"
    elif component == "xkeen" and digest != XKEEN_21_SHA256:
        reason = "Release differs from the supported XKeen package"
    return {"component": component, "version": version, "sha256": digest,
            "url": url, "supported": reason is None, "reason": reason}

def list_releases(arch, installed):
    """Return newer stable versions. Keep unsupported releases visible with a reason."""
    releases = []
    for component, repo in REPOSITORIES.items():
        for entry in _metadata(repo):
            release = _release(component, arch, installed, entry)
            if release:
                releases.append(release)
    return sorted(releases, key=lambda item: _version(item["version"]), reverse=True)

def get_release(arch, installed, component, version):
    """Recheck an exact pin even if it has moved beyond the first catalog page."""
    if component not in REPOSITORIES or not _version(version):
        return None
    tag = ("v" if component == "xray" else "") + version
    try:
        entry = _metadata(REPOSITORIES[component], tag)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    if entry.get("tag_name") != tag:
        return None
    return _release(component, arch, installed, entry)

def payload(release):
    component, version = release["component"], release["version"]
    if not release.get("supported") or not _version(version) or component not in REPOSITORIES:
        raise ValueError("Unsupported release")
    expected = release["sha256"]
    if component == "xkeen" and (version != "2.1" or expected != XKEEN_21_SHA256):
        raise ValueError("Unrecognized XKeen package")
    repo = REPOSITORIES[component]
    assets = {"xkeen.tar.gz"} if component == "xkeen" else {f"Xray-linux-{a}.zip" for a in XRAY_ARCHES.values()}
    urls = {f"https://github.com/{repo}/releases/download/{prefix}{version}/{name}"
            for name in assets for prefix in ("", "v")}
    if release["url"] not in urls:
        raise ValueError("Unexpected release URL")
    with urllib.request.urlopen(release["url"], timeout=REQUEST_TIMEOUT) as response:
        archive = _read_limited(response, MAX_ARCHIVE)
    if hashlib.sha256(archive).hexdigest() != expected:
        raise ReleaseChecksumChanged("Release checksum changed")
    if component == "xkeen":
        return archive
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        binaries = [entry for entry in package.infolist() if entry.filename == "xray"]
        if len(binaries) != 1 or not 0 < binaries[0].file_size <= MAX_BINARY:
            raise ValueError("Invalid Xray binary in release")
        binary = package.read(binaries[0])
        if not binary.startswith(b"\x7fELF"):
            raise ValueError("Invalid Xray executable")
        return binary
