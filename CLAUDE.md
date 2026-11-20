# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LAN-only HTTP service that switches VLESS/Reality locations on a Keenetic router running XKeen. Runs as a Docker container on an always-on home server (tested on macOS with Colima). Talks to the router over SSH. Serves a password/session-gated web UI and HTTP API (PWA on iOS via Add to Home Screen).

User documentation: `README.md` (Russian) and `README.en.md`. Subsystem docs live in `docs/`.

## Common commands

All run from project root (`~/xkeen/`).

```bash
# Run tests (venv must exist — `python3.12 -m venv .venv && pip install -e '.[dev]'`)
.venv/bin/python -m pytest
# Single test
.venv/bin/python -m pytest tests/test_service.py::test_switch_applies_outbound_and_updates_state -v

# UI build and native development (Node 24.18.0 and locked npm dependencies)
npm --prefix frontend run build
./scripts/dev-native.sh

# Local mock container. Rebuild for frontend changes. Python sources are bind-mounted.
./scripts/dev.sh

# Deploy to Mac home server (rsync + docker compose up)
./scripts/deploy.sh <server>                                                           # routine update from dev machine (rsync + rebuild)
./scripts/deploy-local.sh                                                              # same rebuild, run ON the server (no rsync)
ssh <server> 'bash -lc "cd ~/xkeen && ./scripts/bootstrap-server.sh"'                  # one-time setup (keyscan + xk-apply + up)
ssh <server> 'bash -lc "docker logs -f xk-switcher"'                                   # tail server logs

# Smoke (from LAN)
curl -b /path/to/private-cookie-jar "http://<server-ip>:8080/api/status" | python3 -m json.tool
```

## Architecture

Layered, Python stdlib only (prod). Each module has one responsibility.

Entry point: `python -m xk_switcher.app` (see Dockerfile `CMD`). Image is `python:3.12-alpine` + `openssh-client` + `sshpass`; no `pip install` at build time (stdlib-only prod).

```
app.py ──────── wires env → state → service → web + scheduler, starts background
  └─ config.py     Env vars → Config dataclass
  └─ state.py      Atomic JSON store (state.json, subscription.json, history.jsonl)
  └─ router.py     SSH wrapper. Key OR password (sshpass). apply() pushes xk-apply. run_xkeen() runs xkeen -{start|stop|restart|status}.
  └─ service.py    Orchestration. switch/update/set_subscription_url/xkeen_control/probe_xkeen. Single seam between web and I/O.
     └─ routing_service.py  Draft/preview/apply/restore and startup reconciliation; shares Service._op_lock with all router mutations.
        └─ routing_store.py  Exact-byte snapshots, pinned original, revisions and operation journal in data/routing/.
        └─ routing.py + jsonc.py  Conservative projection, validation, generation and ordered diff.
  └─ scheduler.py  Fixed-interval subscription refresh plus configurable pending-config auto-apply.
  └─ auth.py       Admin password, persistent sessions, one-use pairing codes; independent auth.json.
  └─ web.py        HTTP routes, session cookies, JSON and request-marker checks.
     └─ static_assets.py  Compiled manifest and allowlisted static responses.
frontend/src/      React app and fixture catalog, TypeScript, TanStack Query and Rspack.
```

**UI theme:** three-way toggle (light/dark/system) in the settings drawer. Preference stored in `localStorage.xk_theme`, applied via `<html class="theme-light|theme-dark">` before first render (no FOUC). No class = follow `prefers-color-scheme`. Dark-theme CSS vars live in both `@media (prefers-color-scheme: dark) :root:not(.theme-light)` and `:root.theme-dark` (duplicated deliberately for override precedence).

**UI foundation:** `frontend/src/styles/` owns the shared tokens, both dark maps and the original dashboard cascade. Keep the approved header, subscription metadata, combined Connection wave/check/details and separate update status. Entry/Exit selectors show names and flags. Use `frontend/src/ui/` controls and formatters. Keep focused fields and their ancestors connected during polling and responsive changes. Location select/ping buttons are siblings. Stop XKeen requires inline confirmation. Locations keeps three distinct verbs: **Find a working route** (row above Single/Chain, opens the route-check sheet: real HTTPS through candidate routes on the router, Apply per Working row), **ping all** / per-row ping (TCP reachability of each server, in the `TCP ping` bar directly above the list) and Connection's **check server route** (current route only). Show the finder when at least one saved location exists. In the finder, Single checks selected locations directly, then Chain checks one exit through selected entries. Reachable directly uses Single results (Working or Unstable with matching conditions and configuration). The shared HTTP targets are called **test sites**. The Locations heading carries no action; never call TCP probes "check" or route checks "ping".

**Activity surface:** `features/activity/ActivitySheet.tsx` is the only bottom-right entry point. Its status line shows idle (last update), the running operation (`>_` blinking after the policy delay) or `!` attention. Expanded (`~/activity`), it shows the live operation and unread problems with **mark as read** (persisted in `xk_attention_read`), then one feed of local notifications and the router log with all/local/router/problems filters. Router events caused by this browser (`xk_own_events`: own operation and response event IDs) are hidden in favour of their local notification, except in the router filter. On the dashboard it docks and reserves page space (`body.activity-ready`, `--activity-reserve`); on phones (≤640px) it is a full-width bottom sheet with tap/drag snaps (`sheetGestures.ts`) and no backdrop. Elsewhere (drawer, routing, modals) it appears only while busy or needing attention; overlay hosts rehost it into modals. Chevrons use `ui/Chevron.tsx`, never glyphs.

**UI serving and state:** Python maps `/` and `/styleguide.html` to the compiled app and fixture-only catalog. Rspack copies the stable theme bootstrap, manifest and icons from `src/xk_switcher/static/`. One session provider above navigation owns polling, pending requests, and notifications. Retained events use stable IDs and mutation responses provide exact `event_ids` for deduplication. Ephemeral activity carries source/scope and the Main request ID. Busy admission uses HTTP 409 with `code: "busy"`. Prerequisite failures use `code: "precondition"`. See `frontend/README.md` for native development and `docs/frontend-contract.md` for screen integration.

**On the router:** `xk-apply` delegates outbounds updates to the shared lock in `xk-routing` when installed. `router/xk-routing.sh` stages the full Xray config, preserves exact routing bytes, performs atomic replacement, and runs a detached worker with a bounded supervisor. Recovery journal lives under `/opt/var/lib/xk-switcher/routing`. Entware `daemonize` or `setsid` is required. `S04xk-routing` restores interrupted routing before `S05xkeen`; `S06xk-routing` confirms the recovered process state. Never clear an operation lock based only on its age.

**Router tag:** `outbound.py` emits `"vless-reality"`. The routing editor maps the proxy action to this tag. The redirect/tproxy catch-all is editable like other supported rules: its action may be proxy, direct or block; it may be moved or given conditions, but cannot be deleted. Its deletion guard is enforced in both the API and UI and survives editing/apply/reload. Do not force a proxy fallback. Warn about unconditional rules shadowing subsequent rules. It writes `05_routing.json` only through checked apply/restore transactions. `03_inbounds.json` remains outside editor ownership. Keep unknown JSON fields and download/restore raw snapshots directly, never via the generator.

**Subscription format / UA negotiation:** the provider serves *different content by `User-Agent`*. Unknown UAs get a reduced base64 vless-URI list (drops shadowsocks + hysteria nodes); recognized clients get a JSON array of full Xray configs (`[{outbounds:[{tag:"proxy",…}], remarks}]`) with every node. The subscription request sends the Happ desktop User-Agent defined in [subscription.py](src/xk_switcher/subscription.py). `parse_locations` dispatches: JSON (`[`) → one `Location` per config (name=`remarks`, the `proxy` outbound captured into `Location.outbound`, protocol/host/port from `vnext|servers|settings`); base64 → the legacy typed vless-URI parser (fallback). `outbound.build` passes `Location.outbound` straight through (re-tagged), so vless/ss/hysteria all switch without per-protocol code. The old typed `_vless_outbound` builder is the URI-fallback path only.

**Hysteria caveat:** NL/US in the reference sub are `hysteria2` — xray-core has no hysteria outbound, so switching to them pushes a config xray rejects and the proxy drops until you switch back. They're shown (badge `hy2` in the UI) but not blocked.

**xhttp quirk (URI fallback only):** in the base64 vless-URI form the RU3 node uses `type=xhttp` (no flow, alt SNI); `_vless_outbound` has an explicit branch. JSON nodes carry their own `xhttpSettings`, so pass-through handles them.

**Code collisions:** `code_for` appends a digit (`RU 1`→`ru1`) or an `alt` qualifier (`FIN Alt`→`fialt`) so same-country nodes get distinct, switchable codes. Two `Автовыбор` nodes still share `auto` (benign — both auto-select).

**Deferred active-config apply:** changes to the active outbound, including provider-rotated Reality SNI, update the subscription cache and set `pending_reapply_code` without restarting XKeen. Configurable auto-update has an enabled checkbox and two modes: daily at a chosen Moscow time (default: enabled, 04:30, preserving existing behavior), or interval (5–10080 minutes, default value 1440) from the first pending change. PUT /api/auto-update saves enabled, mode, daily_time, and interval_minutes in state.json. Enabling or changing settings starts a fresh interval / selects the next daily occurrence; unchanged settings and subsequent subscription changes do not extend it. The scheduler checks every 30 seconds. Subscription refreshes log history only when something changed (pending update, vanished node); a no-change refresh writes no event. Scheduled and manual pending applies refresh the subscription immediately before applying the latest config; fetch failures keep the pending marker and never apply cached data. Attempt time is persisted before subscription and router I/O, so failures wait another interval or daily occurrence before retrying. Timers survive server restarts. Daily mode skips missed runs instead of restarting during the workday; interval mode applies overdue updates on the next poll. If the active route reaches the fail threshold earlier, failover first applies that pending config and repeats TCP + route checks; it switches to a fallback only when the refreshed active config still fails. Any successful manual/failover/pending apply clears the pending marker.

**Main chains (backend/API):** `POST /api/switch` accepts `{code, operation_id, entry_code?}`. `active_code` remains the exit; absent/null `active_entry_code` means single. The UUID identifies both nodes. Main chains generate exit-first `vless-reality` plus transport-only `xk-chain-entry`, linked by `streamSettings.sockopt.dialerProxy`, from deep copies. Every reapply preserves the pair; hashes/SNI classification cover both nodes. Missing nodes make the route stale without changing installed bytes or selecting a fallback. Chain health uses attributed whole-route HTTP only, stored separately from node TCP health. Automatic failover/stop/recovery switches are suspended while a chain is active; the whitelist is retained, and pending reapply of the same pair remains allowed. Fixed device exits stay single. Helper v3 needs no upgrade for chains. For status fields, compatibility and UI integration, read the Main chains API section in `docs/device-locations.md`. The Main UI offers Single location and Chain. Chain composes distinct Entry/Exit selectors before Apply chain; selecting a single location leaves a chain. Confirmed routes restore mode and selection after reload, while drafts survive polling. Request persistence includes both nodes; legacy code-only requests mean single. Main labels, operation progress, Devices, mobile, pending banners and history show the full route. Chain health uses only active_health.route_ok (working/failed/unverified), with a visible failover-paused notice.

## Auth model

See `docs/auth.md` for the maintained protocol and recovery instructions. One admin password is created in the first-run UI only when auth.json is absent. Settings opens the same screen for changing it with the current password; one atomic write revokes old sessions and issues this browser a replacement session. `./scripts/set-password.sh` remains the offline recovery path (stops the container for exclusive writes, resumes afterwards). Offline reset revokes all sessions. No public registration, accounts, or roles.

`auth.py` stores a salted PBKDF2-SHA256 password hash and SHA-256 hashes of independent session secrets in `data/auth.json`, atomically with mode 0600. Sessions never expire on the server. `xk_session` is an HttpOnly, SameSite=Lax cookie with browser persistence renewed on authenticated responses; JavaScript never reads its secret. Browser/PWA cookie stores may differ: test both and allow code login in each.

The main header's **link device** button opens a native dialog with one-use six-digit code (five minutes, five-error budget). The settings drawer lists and revokes signed-in browsers. Toasts stay visible for six seconds and the last 100 are saved in localStorage.xk_notifications, shown in the activity feed. Codes and per-IP login limits are memory-only. All POST/PUT/DELETE routes, including login, require JSON and `X-XK-Request: 1`; reject foreign Origin and do not enable CORS. Mutating GET routes and all legacy token auth are removed. HTTP remains the LAN transport.

## Router auth

**Password auth is the only documented/tested path.** Dropbear on Keenetic silently rejects user ed25519 pubkeys on most builds (not a config, not perms — just compile-time). Code still supports key mode if `SSH_KEY` is set and `SSH_PASSWORD` is not, but don't expect it to work on a fresh Keenetic. `SSH_PASSWORD` in `.env` + `sshpass -e` is the reference stack.

sshpass is in `Dockerfile` via `apk add`. Pushing config via `scp` fails because Keenetic lacks sftp-server — both `router.py` (runtime `apply`) and `scripts/bootstrap-server.sh` (install-time xk-apply) use `ssh ... 'cat > file'` with stdin pipe instead.

## Russian xkeen output

`service.probe_xkeen()` parses `xkeen -status` output. The output comes with ANSI colour codes and Russian text like `"Прокси-клиент \x1b[91mне запущен\x1b[0m"`. **Order matters in parsing:** check "не запущ" / "остановлен" FIRST, then "запущ" — otherwise "не запущ" matches "запущ" and the state flips wrong.

## State file

`data/state.json` — keys: `active_code` (exit), `active_entry_code` (null = single), `active_route` (saved names), `active_missing_codes`, `active_status` (ok/stale), `xkeen_state` (running/stopped/unknown), `subscription_url`, `last_update_at`, `last_update_status`, `pending_reapply_code`, `pending_reapply_entry_code`, `pending_reapply_since`, `applied_main_fingerprint`, `applied_main_config_hashes` (both Main nodes).

`data/subscription.json` — decoded locations cache.

`data/history.jsonl` — append-only events, rotated at 100 entries (old goes to `history.jsonl.1`).

All writes are temp+rename atomic. Location codes are derived in `codes.py` from flag emoji + optional digit (e.g. `RU 1 🇷🇺` → `ru1`) so they survive subscription label changes.

## Test style

Tests match the production structure 1:1 (`test_<module>.py`). `_sample_loc()` helper in `test_service.py` uses real flag emoji in names so that `code_for(name)` round-trips through the parser — raw text names would break because `code_for` extracts country codes from regional-indicator emoji.

## Deployment specifics (macOS server)

- Colima boot-at-startup via LaunchDaemon (`scripts/setup-mac-colima.sh`) — starts Docker at boot without a macOS login session.
- `scripts/setup-mac-always-on.sh` runs `pmset -c sleep 0 autorestart 1 womp 1 powernap 0`. Without this, the Mac sleeps and the server becomes unreachable from LAN.
- `.env` on server holds `ROUTER_HOST`, `ROUTER_USER`, `SSH_PASSWORD`, `SUB_URL`. It is gitignored; `.env.example` documents it. **`deploy.sh` excludes it from rsync**; don't rsync with `--delete` without `--exclude=.env` or the server's creds get wiped.
- `ssh/xk_known_hosts` on server is also gitignored — generated via `ssh-keyscan` on bootstrap.
- `scripts/bootstrap-server.sh` reads `.env`, records the router key, installs helpers via `install-routing-helper.sh --install-deps`, then starts the container. Existing installations upgrade helpers with `deploy.sh <server> --with-routing-helper` or `deploy-local.sh --with-routing-helper`. Ordinary deploy leaves helpers alone. Helper upgrades hold the router lock and preserve previous executables.

## User conventions (repo-specific)

- Commits: concise English, one line.
- Python: double-quoted strings, stdlib only in prod, module-level constants for magic values, no more than one blank line between blocks.
- CSS classes in kebab-case. Interactive elements carry `data-marker="..."` for future test hooks.
- iOS `.shortcut` file generation and the `/shortcut` endpoint were removed — iOS 17/18 removed the "Allow Untrusted Shortcuts" toggle so out-of-band shortcut import no longer works. PWA (Add to Home Screen) is the mobile path; do not re-add shortcut generation.
