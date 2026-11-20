"""Static guards for the design tokens and shared components."""
import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "src" / "xk_switcher" / "static"
FRONTEND = Path(__file__).resolve().parents[1] / "frontend" / "src"
STYLES = FRONTEND / "styles"
HEX = re.compile(r"#[0-9a-fA-F]{3,8}\b")
# Shrinking allowlist: shadows that predate the tokens. Never add entries.
HEX_ALLOWLIST = {}
SCREEN_CSS = [path for path in FRONTEND.rglob("*.css") if path.name != "tokens.css"]


def _block(css: str, start: str) -> dict:
    body = css[css.index(start):]
    body = body[body.index("{") + 1:]
    if start.startswith("@media"):
        body = body[body.index("{") + 1:]
    body = body[:body.index("}")]
    return dict(re.findall(r"(--[\w-]+):\s*([^;]+);", body))


def test_dark_maps_for_system_and_explicit_choice_are_identical():
    css = (STYLES / "tokens.css").read_text()
    system = _block(css, "@media (prefers-color-scheme: dark)")
    explicit = _block(css, ":root.theme-dark")
    assert system == explicit
    light = _block(css, ":root {")
    assert set(system) <= set(light), "every dark token overrides a light one"


def test_screen_css_takes_colours_from_tokens():
    for path in SCREEN_CSS:
        found = len(HEX.findall(path.read_text()))
        assert found <= HEX_ALLOWLIST.get(path.name, 0), f"{path} has {found} literal colours; add a token instead"


def test_disabled_controls_are_not_faded_with_opacity():
    for path in SCREEN_CSS:
        for rule in re.findall(r"[^{}]*:disabled[^{]*\{[^}]*\}", path.read_text()):
            assert "opacity" not in rule.split("{", 1)[1], f"{path}: {rule.strip()[:80]}"


def test_fields_and_minimum_text_sizes():
    for path in SCREEN_CSS:
        css = path.read_text()
        assert not re.search(r"font-size:\s*(?:[0-9]|1[01])px", css), f"{path} has text below 12px"
    assert "font-size: var(--font-field)" in (STYLES / "components.css").read_text()


def test_no_global_focus_reset_and_reduced_motion_is_global():
    components = (STYLES / "components.css").read_text()
    assert ":focus-visible" in components
    assert "animation-iteration-count: 1 !important" in components
    assert not re.search(r"(?m)^:focus\s*\{\s*outline:\s*0", (STYLES / "app.css").read_text())


def test_scripts_never_insert_markup_with_innerhtml():
    assert (FRONTEND / "main.tsx").is_file()
    scripts = [*STATIC.glob("*.js"), *FRONTEND.rglob("*.ts"), *FRONTEND.rglob("*.tsx")]
    for path in scripts:
        assert not re.search(r"innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML", path.read_text()), path


def test_index_loads_shared_modules_before_screens():
    for template in ("template.html", "catalog.html"):
        html = (FRONTEND / template).read_text()
        assert '<script src="/theme-boot.js"></script>' in html.split("</head>", 1)[0]
    modules = {
        "catalog-styles.ts": ("./styles/tokens.css", "./styles/components.css", "./styles/app.css"),
        "styles.ts": ("./catalog-styles", "./styles/routing.css", "./styles/devices.css",
                      "./styles/mobile-dashboard.css", "./styles/activity.css"),
        "main.tsx": ("./styles", "./app/Application"),
        "catalog.tsx": ("./catalog-styles", "./catalog/Catalog"),
    }
    for filename, imports in modules.items():
        source = (FRONTEND / filename).read_text()
        indices = [source.index(f'"{name}"') for name in imports]
        assert indices == sorted(indices), filename
