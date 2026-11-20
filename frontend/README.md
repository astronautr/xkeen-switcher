# React UI

Main, Devices, Routing, settings and sign-in run at `/`. The component catalog at `/styleguide.html` uses local fixtures. Both entries load the theme preference before first paint. Bookmark hashes, session cookies and browser storage keys are shared with earlier versions.

## Build and run

From the project root, use Node 24.18.0, the committed lockfile and a Python 3.12+ development venv.

```sh
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
npm --prefix frontend run test:build
.venv/bin/python -m tests.ui_support.server
```

Open `http://127.0.0.1:8765/`. This launcher uses a temporary data directory and a mock router and device gateway. For live frontend editing, run `./scripts/dev-native.sh` and open `http://127.0.0.1:8766/`. The dev server proxies same-origin API calls to the synthetic Python service. Override the ports with `UI_DEV_PORT` and `UI_BACKEND_PORT`.

Python reads the compiled manifest from `frontend/dist` or the directory set by `XK_UI_DIST`. The container build installs Node in the frontend build stage and copies its output to `/app/ui-dist` for the Python runtime. Hashed files under `/ui-assets/` are immutable. The entries and the six stable theme, icon and manifest URLs revalidate on load.

## Verification

Run `.venv/bin/python -m pytest -ra` and `npm --prefix frontend test` on any platform. `./scripts/check-ui.sh` runs the full browser, component and pixel-exact visual suites; it requires the macOS build, Node, Playwright browsers and fonts pinned in `tests/baseline-environment.json`.

[Frontend architecture contract](../docs/frontend-contract.md)
