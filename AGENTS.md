# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
  └─ keenetic.py   Independent authenticated HTTP RCI client, using KEENETIC_USER / KEENETIC_PASSWORD.
  └─ devices.py / devices_service.py  Inventory, policy assignments, registration, revisions and durable Undo. See docs/devices.md.
  └─ device_routing.py / device_locations.py  Per-device IPv4 exits in one Xray, a generated tail overlay, cached used outbounds and helper-v3 selective transactions. See docs/device-locations.md.
  └─ routing_service.py / routing_store.py  Durable operation intents, server-owned reconciliation, routing drafts/snapshots and nonblocking mutation admission.
  └─ device_routing_settings.py  UI policy mapping, explicit server-device identity and route-check attribution. Saved settings override the environment/name fallback.
  └─ connectivity.py Parallel HTTP(S) checks of editable connectivity targets through the server's current system route.
  └─ failover.py   Background health loop. TCP-probes every whitelisted location and HTTPS-checks the current active route.
  └─ service.py    Orchestration. switch/update/set_subscription_url/xkeen_control/probe_xkeen. Single seam between web and I/O.
  └─ scheduler.py  Fixed-interval subscription refresh plus polling for configurable pending-config auto-apply.
  └─ auth.py       Admin password, persistent sessions, one-use pairing codes; independent auth.json.
  └─ web.py        HTTP routes, session cookies, JSON and request-marker checks.
     └─ static_assets.py  Compiled manifest and allowlisted static responses.
frontend/src/      React app and fixture catalog, TypeScript, TanStack Query and Rspack.
```

**UI theme:** three-way toggle (light/dark/system) in the settings drawer. Preference stored in `localStorage.xk_theme`, applied via `<html class="theme-light|theme-dark">` before first render (no FOUC). No class = follow `prefers-color-scheme`. Dark-theme CSS vars live in both `@media (prefers-color-scheme: dark) :root:not(.theme-light)` and `:root.theme-dark` (duplicated deliberately for override precedence).

**UI foundation:** `frontend/src/styles/` owns the shared tokens, both dark maps and the original dashboard cascade. Keep the approved header, subscription metadata, combined Connection wave/check/details and separate update status. Entry/Exit selectors show names and flags. Use `frontend/src/ui/` controls and formatters. Keep focused fields and their ancestors connected during polling and responsive changes. Location select/ping buttons are siblings. Stop XKeen requires inline confirmation. Locations keeps three distinct verbs: **Find a working route** (row above Single/Chain, opens the route-check sheet: real HTTPS through candidate routes on the router, Apply per Working row), **ping all** / per-row ping (TCP reachability of each server, in the `TCP ping` bar directly above the list) and Connection's **check server route** (current route only). Show the finder when at least one saved location exists. In the finder, Single checks selected locations directly, then Chain checks one exit through selected entries. Reachable directly uses Single results (Working or Unstable with matching conditions and configuration). The shared HTTP targets are called **test sites**. The Locations heading carries no action; never call TCP probes "check" or route checks "ping".

**UI serving and state:** Python maps `/` and `/styleguide.html` to the compiled app and fixture-only catalog. Rspack copies the stable theme bootstrap, manifest and icons from `src/xk_switcher/static/`. One session provider above navigation owns polling, pending requests, and notifications. Retained events use stable IDs and mutation responses provide exact `event_ids` for deduplication. Ephemeral activity carries source/scope and the Main request ID. Busy admission uses HTTP 409 with `code: "busy"`. Prerequisite failures use `code: "precondition"`. See `frontend/README.md` for native development and `docs/frontend-contract.md` for screen integration.

**On the router:** `xk-apply` delegates outbound writes to `xk-routing` when installed. Routing changes use validated transactions, exact-byte backups and bounded recovery. `S04xk-routing` restores interrupted writes before `S05xkeen`; `S06xk-routing` verifies recovery afterwards. Never remove the operation lock based on age. All service mutations and failover share one reentrant coordinator, so pending-config apply cannot overlap routing apply/restore. See README for deployment and recovery.

**Reliable Main switching:** `POST /api/switch` accepts `{code, operation_id, entry_code?}` and returns HTTP 202 with `{operation}` after persisting intent, before router I/O. Reuse the same UUID for an ambiguous/repeated request; a different request under that UUID is rejected. `GET /api/routing/operations/<id>` only reads the journal; the server resumes unfinished operations at startup and follows lost SSH replies with bounded retry backoff. `unknown` and `recovery_failed` retain the mutation block; only verified `committed`, `rolled_back` or `rejected` are terminal. `GET /api/status.operation` exposes safe progress and block metadata. Synchronous preparation also appears there as `ephemeral: true, id: null`; poll status for that activity rather than an operation URL. Conflicting mutations use nonblocking admission instead of waiting in a hidden queue. The dashboard shows requested Main separately from the last confirmed location and keeps the request ID in `localStorage.xk_switch_request` across reloads/tabs. Connectivity diagnostics follow verified application separately; diagnostic failure cannot turn a commit into an unknown operation.

**Selective configuration ownership:** Main/manual/failover switches require helper v3 with `selective: true`. They validate the complete effective configuration but install only changed `04_outbounds.json`; canonical routing, the device overlay, applied fixed-exit configurations and assignment revision remain unchanged. Routing edits rebuild their corresponding overlay without refreshing unrelated exits. Removing the last assignment deletes the app-owned overlay through a verified transaction and only then clears managed state. Old helper operations remain readable/recoverable; upgrade the helper for new selective operations instead of falling back to the former full-bundle switch. Preserve the routing draft/version when canonical bytes did not change.

**Router tag:** `outbound.py` emits the outbound with tag `"vless-reality"` (the tag the router's `05_routing.json` references — standard XKeen installs do; the routing editor writes `05_routing.json` through validated apply/restore, while `03_inbounds.json` remains outside its ownership). The tag is just a routing label, so non-vless protocols keep it too.

**Subscription format / UA negotiation:** the provider serves *different content by `User-Agent`*. Unknown UAs get a reduced base64 vless-URI list (drops shadowsocks + hysteria nodes); recognized clients get a JSON array of full Xray configs (`[{outbounds:[{tag:"proxy",…}], remarks}]`) with every node. The subscription request sends the Happ desktop User-Agent defined in [subscription.py](src/xk_switcher/subscription.py). `parse_locations` dispatches: JSON (`[`) → one `Location` per config (name=`remarks`, the `proxy` outbound captured into `Location.outbound`, protocol/host/port from `vnext|servers|settings`); base64 → the legacy typed vless-URI parser (fallback). `outbound.build` passes `Location.outbound` straight through (re-tagged), so vless/ss/hysteria all switch without per-protocol code. The old typed `_vless_outbound` builder is the URI-fallback path only.

**Hysteria caveat:** NL/US in the reference sub are `hysteria2`. Support depends on the installed Xray build. They remain visible with the `hy2` badge; staged validation rejects unsupported configurations before replacing live files. TCP health is unavailable for these UDP exits.

**xhttp quirk (URI fallback only):** in the base64 vless-URI form the RU3 node uses `type=xhttp` (no flow, alt SNI); `_vless_outbound` has an explicit branch. JSON nodes carry their own `xhttpSettings`, so pass-through handles them.

**Code collisions:** `code_for` appends a digit (`RU 1`→`ru1`) or an `alt` qualifier (`FIN Alt`→`fialt`) so same-country nodes get distinct, switchable codes. Two `Автовыбор` nodes still share `auto` (benign — both auto-select).

**Two-component failover health:** every whitelisted location is TCP-probed. When xkeen is running, the active whitelisted location additionally performs parallel HTTP(S) requests to the resources stored independently in `data/connectivity.json` (YouTube + Avito by default) through the container's normal system route. Route health is OK when at least one configured resource works and fails only when every resource is unavailable; HTTP 429 counts as reachable because the remote server answered. Combined active health is `tcp_ok AND route_ok`; either component increments the same fail streak and can trigger failover. Inactive candidates can only be qualified by TCP until switched to. `POST /api/route-check` runs the same combined check manually and feeds the same health state machine; it is not a separate diagnostic path. Connectivity targets are edited in their own UI section and are not part of failover config.

**Subscription refresh recovery:** the subscription is refreshed immediately on startup and every `XK_SUBSCRIPTION_UPDATE_INTERVAL_SEC` (default: 3600). The main screen owns subscription URL editing, status and refresh; subscription settings contain only the apply schedule. Every pending-config apply (manual, scheduled, or failover recovery) refreshes the subscription first; a failed refresh never applies the cached update. Refresh and failover probes are serialized. If an enabled failover loses its currently managed active code after refresh, the vanished code is pruned from the whitelist and the remaining locations are tried in priority order: TCP probe, switch only when TCP succeeds, then route check. Recovery stops at the first working route; if none works, the router remains on the last TCP-reachable location that was applied and route-tested.

**Subscription cache during ordinary actions:** Main switches (manual/failover) and start/restart select the requested location from the saved subscription immediately, without fetching on the switching path. A prior failed refresh keeps `last_update_status=fail` and adds the safe warning `Subscription refresh failed; using saved location configuration.`; an eventual commit remains successful. Device assignments still try a refresh and may use the saved requested location after a fetch/parse failure. Missing saved locations reject. Validate the complete candidate and verify router application normally. Do not log raw provider errors/URLs in the warning. Storage/reconciliation failures after a successful fetch are not a cached fallback. Manual/periodic subscription refresh remains independent; explicit manual/scheduled pending-config apply requires a successful fresh download, otherwise pending work is retained without applying cached updates. A structurally valid cached outbound does not guarantee provider connectivity; post-apply diagnostics report that independently.

**Main preparation I/O:** use one capabilities read, environment fingerprint, dependency/layout read, bundle snapshot and XKeen health read before submission. Derive canonical bytes and the local current snapshot from that frozen bundle. The helper validates the full staged configuration under its lock and checks managed/dependency/environment hashes before and after validation before live writes; a separate server-side Main preview validation is unnecessary. Device assignment and routing preview retain validation before DHCP changes or user review. Never weaken the helper's compare-and-swap checks to reduce SSH calls.

**Deferred active-config apply:** changes to Main or used fixed exits update the subscription cache and set `pending_reapply_code` without restarting XKeen. `pending_main_config` and `pending_device_configs` distinguish the remaining work; `applied_main_fingerprint` and saved fixed-exit configurations identify what is already installed. Configurable auto-update has an enabled checkbox and two modes: daily at a chosen Moscow time (default: enabled, 04:30, preserving existing behavior), or interval (5–10080 minutes, default value 1440) from the first pending change. PUT /api/auto-update saves enabled, mode, daily_time, and interval_minutes in state.json. Enabling or changing settings starts a fresh interval / selects the next daily occurrence; unchanged settings and subsequent subscription changes do not extend it. The scheduler checks every 30 seconds. Scheduled and manual pending applies refresh the subscription immediately before applying the latest config; fetch failures keep the pending marker and never apply cached data. A vanished location uses the normal subscription recovery flow. Attempt time is persisted before subscription and router I/O, so failures wait another interval or daily occurrence before retrying. Timers survive server restarts. Daily mode skips missed runs instead of restarting during the workday; interval mode applies overdue updates on the next poll. If the active route reaches the fail threshold earlier, failover first applies that pending config and repeats TCP + route checks; it switches to a fallback only when the refreshed active config still fails. A successful Main-only switch clears only applied Main changes; pending fixed-exit changes and their original scheduling anchor survive. Explicit pending apply updates the used exits together and clears only confirmed work.

**Server route attribution:** Devices → Routing setup selects XKeen policy IDs. Server identity starts unknown; the server icon beside a registered device name marks/unmarks the LAN host running this service. Only one server is marked at a time. Settings live in `data/devices/routing-settings.json`; matching server checks in `data/devices/server-route.json`. The server can use a fixed location. Outbound then shows Server and Default separately. HTTP results feed Default failover only when the identified server follows Main; otherwise manual checks are independent server diagnostics and periodic Default health uses TCP where supported (Hysteria remains unverified). Unknown/outside server routes never supply Default HTTP health. Dashboard status reuses inventory; fresh inventory is read when checking an identified server's route. See docs/device-locations.md.

**SNI-only update scheduling:** `config_updates.py` compares effective outbounds with installed configurations, ignoring only the active TLS/Reality `serverName` for SNI classification. Main stores `applied_main_config_hashes` alongside its legacy fingerprint; fixed exits use their saved applied configurations. Unknown baselines are ordinary config changes, never guessed from the most recent subscription diff. `pending_update_kind` is `sni`, `config` or null; `pending_non_sni_since` records the first ordinary change separately. Interval mode's optional `auto_update_sni_daily` (API: `sni_daily`, default false) uses the existing daily Moscow time for SNI-only updates. Any other pending Main/used-exit change takes precedence and starts its own interval; all updates apply together. Recheck classification and deadline after the pre-apply refresh so newly discovered key/address changes cannot ride a due SNI apply. Daily mode hides/ignores the option while retaining it. Manual apply and failover may apply earlier. The neutral SNI banner has two text lines: `optional update · only SNI has changed` and auto-apply timing, with an `apply now` button.

**Main chains (backend/API):** `POST /api/switch` accepts `{code, operation_id, entry_code?}`. `active_code` remains the exit; absent/null `active_entry_code` means single. The UUID identifies both nodes. Main chains generate exit-first `vless-reality` plus transport-only `xk-chain-entry`, linked by `streamSettings.sockopt.dialerProxy`, from deep copies. Every reapply preserves the pair; hashes/SNI classification cover both nodes. Missing nodes make the route stale without changing installed bytes or selecting a fallback. Chain health uses attributed whole-route HTTP only, stored separately from node TCP health. Automatic failover/stop/recovery switches are suspended while a chain is active; the whitelist is retained, and pending reapply of the same pair remains allowed. Fixed device exits stay single. Helper v3 needs no upgrade for chains. For status fields, compatibility and UI integration, read the Main chains API section in `docs/device-locations.md`. The Main UI offers Single location and Chain. Chain composes distinct Entry/Exit selectors before Apply chain; selecting a single location leaves a chain. Confirmed routes restore mode and selection after reload, while drafts survive polling. Request persistence includes both nodes; legacy code-only requests mean single. Main labels, operation progress, Devices, mobile, pending banners and history show the full route. Chain health uses only active_health.route_ok (working/failed/unverified), with a visible failover-paused notice.

## Auth model

See `docs/auth.md` for the maintained protocol and recovery instructions. One admin password is created in the first-run UI only when auth.json is absent. Settings opens the same screen for changing it with the current password; one atomic write revokes old sessions and issues this browser a replacement session. `./scripts/set-password.sh` remains the offline recovery path (stops the container for exclusive writes, resumes afterwards). Offline reset revokes all sessions. No public registration, accounts, or roles.

`auth.py` stores a salted PBKDF2-SHA256 password hash and SHA-256 hashes of independent session secrets in `data/auth.json`, atomically with mode 0600. Sessions never expire on the server. `xk_session` is an HttpOnly, SameSite=Lax cookie with browser persistence renewed on authenticated responses; JavaScript never reads its secret. Browser/PWA cookie stores may differ: test both and allow code login in each.

The main header's **link device** button opens a native dialog with one-use six-digit code (five minutes, five-error budget). The settings drawer lists and revokes signed-in browsers. Toasts stay visible for six seconds and the last 100 are saved in localStorage.xk_notifications, shown in a separate inbox opened by the bottom-right notifications button. Codes and per-IP login limits are memory-only. All POST/PUT/DELETE routes, including login, require JSON and `X-XK-Request: 1`; reject foreign Origin and do not enable CORS. Mutating GET routes and all legacy token auth are removed. HTTP remains the LAN transport.

## Router auth

**Password auth is the only documented/tested path.** Dropbear on Keenetic silently rejects user ed25519 pubkeys on most builds (not a config, not perms — just compile-time). Code still supports key mode if `SSH_KEY` is set and `SSH_PASSWORD` is not, but don't expect it to work on a fresh Keenetic. `SSH_PASSWORD` in `.env` + `sshpass -e` is the reference stack.

sshpass is in `Dockerfile` via `apk add`. Pushing config via `scp` fails because Keenetic lacks sftp-server — both `router.py` (runtime `apply`) and `scripts/bootstrap-server.sh` (install-time xk-apply) use `ssh ... 'cat > file'` with stdin pipe instead.

## Russian xkeen output

`service.probe_xkeen()` parses `xkeen -status` output. The output comes with ANSI colour codes and Russian text like `"Прокси-клиент \x1b[91mне запущен\x1b[0m"`. **Order matters in parsing:** check "не запущ" / "остановлен" FIRST, then "запущ" — otherwise "не запущ" matches "запущ" and the state flips wrong.

## State file

`data/state.json` — keys: `active_code` (exit), `active_entry_code` (null = single), `active_route` (saved names), `active_missing_codes`, `active_status` (ok/stale), `xkeen_state` (running/stopped/unknown), `subscription_url`, `last_update_at`, `last_update_status`, `pending_reapply_code`, `pending_reapply_entry_code`, `pending_reapply_since`, `pending_main_config`, `pending_device_configs`, `applied_main_fingerprint`, `auto_update_enabled`, `auto_update_mode`, `auto_update_daily_time`, `auto_update_interval_minutes`, `auto_update_changed_at`, `auto_update_attempt_at`.

`data/subscription.json` — decoded locations cache.

`data/connectivity.json` — independent editable `check_urls` used by both manual route checks and failover.

`data/history.jsonl` — append-only events, rotated at 100 entries (old goes to `history.jsonl.1`).

All writes are temp+rename atomic. Location codes are derived in `codes.py` from flag emoji + optional digit (e.g. `RU 1 🇷🇺` → `ru1`) so they survive subscription label changes.

## Test style

Tests match the production structure 1:1 (`test_<module>.py`). `_sample_loc()` helper in `test_service.py` uses real flag emoji in names so that `code_for(name)` round-trips through the parser — raw text names would break because `code_for` extracts country codes from regional-indicator emoji.

## Deployment specifics (macOS server)

- Colima boot-at-startup via LaunchDaemon (`scripts/setup-mac-colima.sh`) — starts Docker at boot without a macOS login session.
- `scripts/setup-mac-always-on.sh` runs `pmset -c sleep 0 autorestart 1 womp 1 powernap 0`. Without this, the Mac sleeps and the server becomes unreachable from LAN.
- `.env` on server holds `ROUTER_HOST`, `ROUTER_USER`, `SSH_PASSWORD`, `SUB_URL`. It is gitignored; `.env.example` documents it. **`deploy.sh` excludes it from rsync**; don't rsync with `--delete` without `--exclude=.env` or the server's creds get wiped.
- `ssh/xk_known_hosts` on server is also gitignored — generated via `ssh-keyscan` on bootstrap.
- `scripts/bootstrap-server.sh` is idempotent-ish first-time setup: reads `.env`, does `ssh-keyscan → ssh/xk_known_hosts`, installs `/opt/bin/xk-apply` on router via `sshpass + ssh stdin pipe`, then `docker compose up -d --build`. Safe to re-run.

## User conventions (repo-specific)

- All product UI copy is English, including routing, validation errors, confirmations and recovery messages. Preserve user-authored rule names and raw configuration contents.

- Commits: concise English, one line.
- Python: double-quoted strings, stdlib only in prod, module-level constants for magic values, no more than one blank line between blocks.
- CSS classes in kebab-case. Interactive elements carry `data-marker="..."` for future test hooks.
- iOS `.shortcut` file generation and the `/shortcut` endpoint were removed — iOS 17/18 removed the "Allow Untrusted Shortcuts" toggle so out-of-band shortcut import no longer works. PWA (Add to Home Screen) is the mobile path; do not re-add shortcut generation.

**Routing rule semantics:** The default rule for remaining traffic can change action, conditions and position, but cannot be deleted (enforced by UI and API). Never force proxy as the default. Raw snapshot download/restore must preserve original bytes, including comments and line endings.

