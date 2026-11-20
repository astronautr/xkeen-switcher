"""Compiled assets are an explicit public manifest, never a directory server."""
import hashlib
import json
import pytest
from xk_switcher.static_assets import StaticAssets
from ._helpers import write_ui_dist

@pytest.fixture
def dist(tmp_path):
    return write_ui_dist(tmp_path)

def test_manifest_entries_mime_cache_and_exact_data(dist):
    assets = StaticAssets(dist)
    for url, filename in (("/", "index.html"), ("/styleguide.html", "catalog.html")):
        assert assets.read(url) == ((dist / filename).read_bytes(), "text/html; charset=utf-8", "no-cache")
    route = next(route for route in assets.routes if route.startswith("/ui-assets/app.") and route.endswith(".js"))
    data, mime, cache = assets.read(route)
    assert data == b"console.log('app')"
    assert mime == "application/javascript; charset=utf-8"
    assert cache == "public, max-age=31536000, immutable"

@pytest.mark.parametrize("route", ["/index.html", "/catalog.html", "/asset-manifest.json", "/private.txt", "/ui-assets/missing.js", "/ui-assets/app.js.map", "/ui-assets/../index.html", "/ui-assets/%2e%2e/index.html", "/ui-assets/%252e%252e/index.html", "/ui-assets/\\index.html"])
def test_unlisted_and_traversal_never_fallback(dist, route):
    assert StaticAssets(dist).read(route) is None

@pytest.mark.parametrize("change", ["escape", "absolute", "map", "mime", "api", "missing", "symlink", "version", "entry", "duplicate", "dot", "query", "missing_shared", "missing_hash", "wrong_hash", "version_type"])
def test_invalid_manifest_is_rejected(dist, tmp_path, change):
    path = dist / "asset-manifest.json"
    manifest = json.loads(path.read_text())
    record = manifest["assets"]["/index.html"]
    if change == "escape": record["file"] = "../outside.html"
    if change == "absolute": record["file"] = str(dist / "index.html")
    if change == "map": record["file"] = "index.html.map"
    if change == "mime": record["mime"] = "application/javascript"
    if change == "api": manifest["assets"]["/api/status"] = manifest["assets"].pop("/index.html")
    if change == "missing": (dist / "index.html").unlink()
    if change == "symlink":
        (dist / "index.html").unlink()
        (dist / "index.html").symlink_to("/etc/hosts")
    if change == "version": manifest["version"] = 2
    if change == "version_type": manifest["version"] = True
    if change == "entry": manifest["entries"]["app"] = "/unknown.html"
    if change == "dot": record["file"] = "./index.html"
    if change == "query": manifest["assets"]["/index.html?secret"] = record
    if change == "missing_shared": del manifest["assets"]["/theme-boot.js"]
    if change in {"missing_hash", "wrong_hash"}:
        route = next(url for url in manifest["assets"] if url.startswith("/ui-assets/") and url.endswith(".js"))
        replacement = "/ui-assets/app.js" if change == "missing_hash" else "/ui-assets/app.0000000000000000.js"
        manifest["assets"][replacement] = manifest["assets"].pop(route)
    text = json.dumps(manifest)
    if change == "duplicate": text = text.replace('"version": 1', '"version": 1, "version": 1')
    path.write_text(text)
    with pytest.raises(ValueError): StaticAssets(dist)

def test_read_rechecks_containment_and_content_hash(dist):
    assets = StaticAssets(dist)
    (dist / "index.html").unlink()
    (dist / "index.html").symlink_to("/etc/hosts")
    assert assets.read("/") is None
    route = next(route for route in assets.routes if route.startswith("/ui-assets/"))
    (dist / route.lstrip("/")).write_bytes(b"modified")
    assert assets.read(route) is None

@pytest.mark.parametrize(("bundle", "suffix"), [("app", ".js"), ("catalog", ".css")])
def test_entry_rejects_subresource_missing_from_manifest(dist, bundle, suffix):
    path = dist / "asset-manifest.json"
    manifest = json.loads(path.read_text())
    url = next(url for url in manifest["assets"] if url.startswith(f"/ui-assets/{bundle}.") and url.endswith(suffix))
    del manifest["assets"][url]
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="subresource"):
        StaticAssets(dist)

@pytest.mark.parametrize(("tag", "valid"), [
    ("<link href='/unknown.svg' media='all' rel='shortcut ICON'>", False),
    ("<link href='/unknown.webmanifest' rel='manifest' />", False),
    ("<link href='/unknown.png' rel='apple-touch-icon'>", False),
    ("<a href='/docs'>Docs</a><script>/* inline */</script><link rel='canonical' href='/about'>", True),
])
def test_entry_only_checks_subresource_attributes(dist, tag, valid):
    page = dist / "index.html"
    page.write_text(page.read_text().replace("</head>", tag + "</head>"))
    path = dist / "asset-manifest.json"
    manifest = json.loads(path.read_text())
    manifest["assets"]["/index.html"]["sha256"] = hashlib.sha256(page.read_bytes()).hexdigest()
    path.write_text(json.dumps(manifest))
    if valid:
        assert StaticAssets(dist).read("/")[0] == page.read_bytes()
    else:
        with pytest.raises(ValueError, match="subresource"):
            StaticAssets(dist)
