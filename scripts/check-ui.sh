#!/bin/bash
# Native, offline UI acceptance. Run pytest separately on the same revision.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: scripts/check-ui.sh [--preflight]
  --preflight  Check the installed tools, Git inputs and the visual baseline, then exit.
Requires the pinned macOS build, Node, Playwright browsers and fonts from
frontend/tests/baseline-environment.json; pixel baselines are exact.
Logs, screenshots and traces go to a new temporary directory printed at startup.
HELP
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
preflight=false
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --preflight) preflight=true ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
  shift
done

project=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$project"
candidate_sha=$(git rev-parse --verify HEAD)
baseline=frontend/tests/visual/baselines
# Git tree of the accepted PNG/layout baselines. Update only with reviewed baselines.
expected_tree=d93850861daaceb53da047c514e4f5897cec95d3
evidence=$(mktemp -d "${TMPDIR:-/tmp}/xkeen-ui-check.XXXXXXXX")
printf 'Evidence directory: %s\n' "$evidence"
printf 'Candidate %s at %s\n' "$candidate_sha" "$project" | tee "$evidence/revisions.log"

# Prevent fixture recording, alternative capture manifests and network installation.
unset UI_TARGET XK_UI_DIST UPDATE_LEGACY_BASELINES UPDATE_COMPONENT_SNAPSHOTS UI_CAPTURE_MANIFEST UI_NEGATIVE_CONTROL
unset ROUTING_RED ROUTING_ORIGINAL ROUTING_SURFACES ROUTING_VISUAL
unset SETTINGS_RED SETTINGS_ORIGINAL MAIN_RED DEVICES_RED DEVICES_ORIGINAL DEVICES_NATIVE
unset ROUTING_GATEWAY DEVICES_GATEWAY
export CI=1 STORYBOOK_DISABLE_TELEMETRY=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_offline=true
export PLAYWRIGHT_HTML_OPEN=never
export PATH="$project/.venv/bin:$PATH"

check_inputs() {
  local checkout=$1 expected=$2 changed
  [[ $(git -C "$checkout" rev-parse HEAD) == "$expected" ]] || fail "HEAD changed in $checkout"
  # User documents and local output elsewhere do not participate in the fixture or build.
  changed=$(git -C "$checkout" status --porcelain=v1 --untracked-files=all -- \
    frontend src tests router scripts/check-ui.sh pyproject.toml ':(exclude)frontend/node_modules')
  [[ -z "$changed" ]] || fail "UI inputs differ from $expected in $checkout:
$changed"
}

check_tools() (
  cd "$1/frontend"
  [[ -x ../.venv/bin/python && -x node_modules/.bin/playwright ]] || fail "Prepare this checkout's Python venv and locked frontend dependencies first."
  node <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const metadata = require("./tests/baseline-environment.json");
const lock = require("./package-lock.json");
assert.equal(process.platform, metadata.platform, "host platform");
assert.equal(process.arch, metadata.architecture, "host architecture");
assert.equal(process.versions.node, metadata.node, "Node version");
assert.equal(cp.execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim(), metadata.osBuild, "macOS build");
for (const [name, pinned] of Object.entries({ ...lock.packages[""].dependencies, ...lock.packages[""].devDependencies })) {
  assert.equal(require("./node_modules/" + name + "/package.json").version, pinned, name);
}
assert.equal(require("./node_modules/@playwright/test/package.json").version, metadata.playwright, "Playwright version");
const installed = cp.execFileSync("node_modules/.bin/playwright", ["install", "--list"], { encoding: "utf8" });
const list = require("./node_modules/playwright-core/browsers.json").browsers;
for (const name of ["chromium-headless-shell", "firefox", "webkit"]) {
  const { revision } = list.find(browser => browser.name === name);
  const directory = name.replaceAll("-", "_") + "-" + revision;
  const present = installed.split("\n").some(line => line.trimEnd().endsWith("/" + directory));
  assert(present, "Missing cached Playwright browser " + directory);
  console.log(directory);
}
for (const font of metadata.fonts) {
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(font.path)).digest("hex"), font.sha256, font.path);
}
JS
  ../.venv/bin/python --version
  node --version
  node_modules/.bin/playwright --version
)

check_tools "$project"
[[ $(git rev-parse "HEAD:$baseline") == "$expected_tree" ]] ||
  fail "Candidate has a different PNG/layout baseline tree."
check_inputs "$project" "$candidate_sha"
printf 'PNG/layout tree: %s\n' "$expected_tree"
if $preflight; then exit 0; fi

run() {
  local stage=$1
  shift
  printf '\n[%s]\n' "$stage"
  "$@" 2>&1 | tee "$evidence/$stage.log"
}
cd "$project/frontend"
export PYTHONPATH="$project/src"
run native-browser-lifecycle npm run test:native-browser-lifecycle
run visual-negative-control node --test tests/support/reviewed-raster.test.ts
run unit npm run test:unit
# npm run build runs the repository's tsc --noEmit before producing its manifest.
run typecheck-and-build npm run build
run build-contract npm run test:build
run storybook npm run build-storybook
run components npm run test:components -- --output="$evidence/components"
run protocol npm run test:protocol -- --output="$evidence/protocol"
for feature in auth settings main routing; do
  run "feature-$feature" node_modules/.bin/playwright test --config="tests/features/$feature/playwright.config.ts" \
    "features/$feature/" --workers=1 --reporter=list --output="$evidence/feature-$feature"
done
run feature-devices env DEVICES_NATIVE=1 node_modules/.bin/playwright test \
  --config=tests/features/devices/playwright.config.ts flows.spec --reporter=list --output="$evidence/feature-devices"
run feature-devices-pixels node_modules/.bin/playwright test --config=tests/features/devices/playwright.config.ts \
  dialog-visual.spec --reporter=list --output="$evidence/feature-devices-pixels"
run feature-routing-pixels env ROUTING_SURFACES=1 node_modules/.bin/playwright test \
  --config=tests/features/routing/playwright.config.ts --project=chromium --reporter=list --output="$evidence/feature-routing-pixels"
for feature in devices routing; do
  flag=$(echo "${feature}_gateway" | tr '[:lower:]' '[:upper:]')
  run "gateway-$feature" env "$flag=1" node_modules/.bin/playwright test \
    --config="tests/features/$feature/playwright.config.ts" --project=chromium --reporter=list --output="$evidence/gateway-$feature"
done
run composition node_modules/.bin/playwright test --config=tests/composition/playwright.config.ts \
  --reporter=list --output="$evidence/composition"
run react-behavior npm run test:behavior -- --workers=3 --reporter=list --output="$evidence/react-behavior"
run react-visual npm run test:visual -- --fully-parallel --workers=3 --reporter=list --output="$evidence/react-visual"
run react-http npm run test:integration -- --workers=1 --reporter=list --output="$evidence/react-http"
check_inputs "$project" "$candidate_sha"
printf '\nNative UI checks passed for %s. Record the separate Python result, skip audit and device status.\n' "$candidate_sha"
