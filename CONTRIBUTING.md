# Contributing

Bug reports, router/provider compatibility reports and pull requests are welcome.

## Reporting issues

Include your Keenetic model and firmware, XKeen and Xray versions, the subscription format (base64 links or Xray JSON) and relevant lines from `docker logs xk-switcher`. Remove passwords, subscription URLs, UUIDs and keys before posting.

## Development setup

```bash
python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
npm --prefix frontend ci --ignore-scripts   # Node 24.18.0
./scripts/dev-native.sh                     # demo backend + live UI at http://127.0.0.1:8766/
```

The demo uses a synthetic router, subscription and device list; it never reads `.env` or contacts a real router.

## Before opening a pull request

```bash
.venv/bin/python -m pytest
npm --prefix frontend run build
npm --prefix frontend test
```

`./scripts/check-ui.sh` runs the full browser and pixel-exact visual suites. It requires the macOS build, Node, Playwright browsers and fonts pinned in `frontend/tests/baseline-environment.json`, so CI does not run it; mention in the PR if you could not.

## Conventions

- Backend: Python 3.12 standard library only in production code, double-quoted strings, module-level constants for magic values. Tests mirror modules one-to-one (`tests/test_<module>.py`).
- Router scripts must stay POSIX `sh` compatible with Entware.
- UI copy is English. Interactive elements carry `data-marker` attributes for tests.
- Commits: one concise English line.

[AGENTS.md](AGENTS.md) describes the architecture and invariants in more detail.
