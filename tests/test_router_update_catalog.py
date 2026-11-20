import hashlib
import io
import zipfile
from unittest.mock import patch

import pytest

from xk_switcher import router_update_catalog as catalog

def release_asset(repo, tag, name, digest):
    return {"tag_name": tag, "draft": False, "prerelease": False, "assets": [{
        "name": name, "digest": "sha256:" + digest,
        "browser_download_url": f"https://github.com/{repo}/releases/download/{tag}/{name}",
    }]}

def test_catalog_selects_new_stable_arch_and_marks_unknown_migration(monkeypatch):
    xr = catalog.REPOSITORIES["xray"]
    xk = catalog.REPOSITORIES["xkeen"]
    xray = release_asset(xr, "v26.11.9", "Xray-linux-arm64-v8a.zip", "1" * 64)
    older = {**xray, "tag_name": "v26.3.27"}
    future = {**xray, "tag_name": "v27.1.1", "prerelease": True}
    xkeen = release_asset(xk, "2.1", "xkeen.tar.gz", catalog.XKEEN_21_SHA256)
    new_xkeen = release_asset(xk, "2.2", "xkeen.tar.gz", "0" * 64)
    monkeypatch.setattr(catalog, "_metadata", {xr: [xray, older, future], xk: [xkeen, new_xkeen]}.__getitem__)
    releases = catalog.list_releases("aarch64", {"xray": "26.3.27", "xkeen": "2.0"})
    assert {r["version"]:r["supported"] for r in releases} == {"26.11.9":True,"2.1":True,"2.2":False}
    releases = catalog.list_releases("unknown", {"xray":"26.3.27","xkeen":"2.0"})
    assert not next(r for r in releases if r["component"] == "xray")["supported"]

def test_only_verified_xray_executable_is_delivered():
    binary = b"\x7fELFunit-test"
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as package:
        package.writestr("xray", binary)
        package.writestr("example-no-install.json", "{}")
    class Response(io.BytesIO):
        headers = {}
    release = {"version":"26.11.9","component":"xray","supported":True,
               "url":"https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-arm64-v8a.zip",
               "sha256":hashlib.sha256(data.getvalue()).hexdigest()}
    with patch.object(catalog.urllib.request,"urlopen", return_value=Response(data.getvalue())):
        assert catalog.payload(release) == binary
    with patch.object(catalog.urllib.request,"urlopen", return_value=Response(b"substitution")):
        with pytest.raises(ValueError, match="checksum"):
            catalog.payload(release)
    with patch.object(catalog.urllib.request,"urlopen") as fetch:
        with pytest.raises(ValueError, match="URL"):
            catalog.payload({**release,"url":"https://example.org/evil.zip"})
        fetch.assert_not_called()

def test_scheduled_version_is_looked_up_by_exact_tag(monkeypatch):
    repo = catalog.REPOSITORIES["xray"]
    requested = "26.10.21"
    def fetch(wanted_repo, tag):
        assert (wanted_repo, tag) == (repo, "v26.10.21")
        return release_asset(repo, tag, "Xray-linux-arm64-v8a.zip", "b" * 64)
    monkeypatch.setattr(catalog, "_metadata", fetch)
    row = catalog.get_release("aarch64", {"xray": "26.3.27"}, "xray", requested)
    assert (row["supported"], row["version"], row["sha256"]) == (True, requested, "b" * 64)
    assert catalog.get_release("aarch64", {"xray": requested}, "xray", requested) is None

@pytest.mark.parametrize(("arch", "suffix"), [
    ("mipsel", "mips32le"), ("mipsbe", "mips32"),
    ("mips64el", "mips64le"), ("mips64be", "mips64"),
])
def test_select_mips_asset_using_reported_entware_abi(monkeypatch, arch, suffix):
    repo = catalog.REPOSITORIES["xray"]
    name = f"Xray-linux-{suffix}.zip"
    entry = release_asset(repo, "v26.11.9", name, "a" * 64)
    monkeypatch.setattr(catalog, "_metadata", lambda repo, tag: entry)
    row = catalog.get_release(arch, {"xray": "26.3.27"}, "xray", "26.11.9")
    assert row["supported"] and row["url"].endswith("/" + name)
    assert not catalog.get_release("mips", {"xray": "26.3.27"}, "xray", "26.11.9")["supported"]
