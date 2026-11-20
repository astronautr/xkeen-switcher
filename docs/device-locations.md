# Device proxy locations

One Xray process serves the main location and the fixed locations selected in **Devices → Proxy location**. **Use main location** follows the existing main selector and automatic failover. Choosing a country fixes that device's proxy exit even when the main selector changes. Search, registration, favorites and online filters remain available; policy and location dropdowns support multiple selections (OR within a dropdown, AND between filters).

Assignments use the device MAC as the persistent identity and its reserved IPv4 as the Xray source condition. The first assignment automatically pins the current IPv4 through Keenetic DHCP, after Xray validation. Existing reservations are kept. A current address that differs from the reservation requires reconnecting first. Returning to main keeps the reservation; the pin can then be removed separately. Unpinning, unregistering, and Undo that would remove a required reservation are rejected until the custom location is cleared.

This feature selects the exit only for traffic that already reaches XKeen and is routed to its proxy. Existing Direct and Block rules retain their conditions, actions and priority. IPv6 is not assigned by these IPv4 rules. The router's existing IPv6 behavior remains in effect; selecting a country is not an IPv6 leak-prevention mechanism.

## XKeen policies

Open **Devices → Routing setup** and select the connection policies that already send traffic to XKeen. Multiple policies, including Default, are supported. Saving an empty selection deliberately disables classification; it does not fall back to a policy name. The application does not change interception, inbound configuration or Keenetic connection priorities. **Segment default** resolves to the segment's configured policy. The Default policy remains distinct.

Before settings are saved in the UI, `XK_DEVICE_POLICY_IDS` in the server `.env` supplies the initial mapping, for example:

```dotenv
XK_DEVICE_POLICY_IDS=policy:Policy0,policy:Policy2
# For a setup intercepting the default policy instead:
# XK_DEVICE_POLICY_IDS=default
```

Without either saved settings or an environment mapping, policy descriptions exactly matching `XKeen` (case insensitive) are used. UI settings take precedence over the environment. Use the `value` identifiers returned by `GET /api/devices` for environment configuration. Saved assignments remain in place outside the identified policies. They are shown as inactive and take effect again when that device's IPv4 traffic returns to XKeen. Clearing an inactive assignment is allowed.

## Server identity and route checks

The server starts **unknown**. Click the small server icon beside a registered device's name in **Devices** to mark it as the switcher server. Clicking the active icon unmarks it; marking another device replaces the previous selection. This is the LAN host running the application (the Mac hosting Colima, for example), not an internal Docker container address. Identity is saved by MAC and never guessed from a device name. The active icon is highlighted; the device can still use any fixed location. Policy mapping remains in the compact **Routing setup** dialog.

When the server follows Main, **Outbound** shows Default without a redundant server attribution line. With a fixed server location, it shows the server's own location, host and port, followed by a compact **Default** row for devices using Main. The selected location's ping uses its measured TCP connection latency; unsupported UDP probes are labelled unavailable. Check results are explicitly labelled **server route** on desktop and mobile. Direct/Block rules still apply to individual check destinations.

Manual Main switches, failover and start/restart use the saved requested location immediately without fetching the subscription. Manual and periodic subscription refresh run independently. Device assignments still attempt refresh and can use the saved requested location after a fetch/parse failure. A missing saved location rejects, and an error saving or reconciling a successfully fetched subscription does not qualify for fallback. The complete candidate is validated and the router result verified as usual. This confirms configuration application, not that stale provider parameters still provide connectivity. If the last refresh failed, the subscription stays stale and history/operation metadata records the safe warning `Subscription refresh failed; using saved location configuration.`; a verified commit remains successful.

Explicit manual and scheduled pending-config applies still require a successful fresh subscription download; failure preserves pending work without applying cached updates. A Main-only switch installs the requested Main configuration while retaining the last applied fixed exits, even when the subscription cache contains newer fixed-exit settings. Assignment changes use the selected location's configuration; routing edits and Undo preserve the reviewed routing and applied exits without an incidental subscription update. Recovery of an already submitted transaction always retains its immutable payload. A routing-only installation without a selected subscription location can still edit its rules.

Application completes after the installed bytes and required XKeen state have been verified. Subsequent TCP and server HTTP(S) diagnostics have a separate result; a diagnostic timeout cannot make a verified commit unknown or retain its mutation lock. Checks feed health without recursively triggering another switch inside the same apply; the normal failover loop can act on the result. Results from a superseded route are discarded. A failed HTTP check is displayed as a failed route even when the configuration was applied successfully. When the server uses another exit, HTTP evidence remains attributed to that exit and Default receives only its own TCP evidence.

HTTP results contribute to Default's failover health only when the identified server follows Main. A fixed server location, even one with the same country code as Default, cannot report Default's HTTP health. Manual checks then test the server's route without triggering Default failover; the existing periodic loop continues checking Default by TCP where supported. Hysteria locations without a TCP probe remain unverified in this mode. Subscription recovery cannot claim a working HTTP route based on another server exit. Unknown identity, missing inventory or a server outside the mapped policies also prevent attribution. Until the server is marked, HTTP results describe its unidentified route only; Default does not inherit those results.

Settings and the server MAC persist in private `data/devices/routing-settings.json`. The last server check is saved in `data/devices/server-route.json`, with a context fingerprint; changing the server, mapping, location, address, check targets or XKeen state invalidates stale results. Router inventory is refreshed for route checks and reused for dashboard rendering; there is no new background polling loop or router process.

## Files and compilation

`data/devices/locations.json` contains an atomic revision, MAC → `{code, ip}` assignments, and the last applied configurations of their locations. It is private (0600), includes subscription credentials, and must be backed up with the rest of `data/`.

The helper validates these managed files together, but installs only those whose contents or presence change:

| File | Ownership |
| --- | --- |
| `04_outbounds.json` | Main exit, optional chain entry, plus Direct and Block |
| `05_routing.json` | Canonical routing document; device changes preserve its exact bytes |
| `99_xk_devices_tail.json` | Generated device outbounds and effective routing rules |

For each proxy rule, the compiler inserts a source-specific copy immediately before that rule. All original conditions are preserved; existing IP/CIDR source constraints are intersected with the assigned IPv4 addresses. Geodata source constraints on proxy rules are rejected because their intersection cannot be established safely on the server. The original rules stay in their original order. An implicit proxy fallback is mirrored only when the original first outbound is the main proxy. A Direct default is never forced to Proxy.

The `tail` filename is intentional: [Xray appends its new outbounds](https://xtls.github.io/en/config/features/multiple.html), preserving the original first outbound for unmatched traffic. The later routing object replaces the earlier one. The canonical document remains available for byte-exact snapshot downloads and restore; editor apply/restore recompiles the overlay in the same transaction. While assignments exist, manual edits to `05_routing.json` alone do not change the effective rules in the overlay. Use the routing editor for changes. After an external edit, reimport and review the configuration, then use a routing apply/restore to regenerate the overlay; reimport itself does not restart Xray. A Main switch never regenerates the overlay. Routing/outbounds in additional configuration fragments are rejected rather than silently overriding them. Other fragments, such as DNS, log, policy and inbounds, are retained and included in validation and dependency fingerprints.

Main switches change only `04_outbounds.json`. The canonical routing document, overlay, fixed outbound configurations and assignment revision remain unchanged, and an existing routing draft remains valid. Assignment changes update the overlay without changing Main. Removing the last assignment deletes the app-owned overlay through a verified transaction; managed state is cleared only after confirmation. Subsequent Main switches use the same selective path as installations without assignments.

One additional outbound is generated per distinct assigned location, shared by every device using it. Only used locations are loaded. There is no second Xray process, per-device daemon, extra country health loop or new router polling loop. Rule growth is proportional to the number of proxy rules times the number of used custom locations. Actual router CPU/RAM impact still depends on its Xray build, transports and traffic; it has not been benchmarked on the home router.

## Apply, recovery and Undo

Router helper **v3**, advertising `selective: true`, is required for Main switches and device-location applies. Upgrade it together with the application:

```sh
./scripts/deploy.sh <server> --with-routing-helper
# or, on the server itself:
./scripts/deploy-local.sh --with-routing-helper
```

The helper uses `fsync` for affected files and their containing directories when available; capability `durability` reports `fsync` or `global`. It durably records the operation lock before publishing acceptance, and flushes recovery copies before installation intent. Existing `fsync` failures abort or retain recovery rather than silently downgrading durability. Routers without `fsync` retain the global `sync` fallback, which may have higher latency.

Installing the helper does not apply configurations or restart XKeen. It requires the existing startup recovery scripts plus `tar`, `sha256sum`, `mktemp`, `nohup`, `sync`, and `setsid` or `daemonize`. The installer requires no active router transaction and verifies v3 selective readiness. Earlier v1/v2 records remain readable and recoverable, but new selective applies require the upgrade; the application reports the mismatch rather than falling back to a full-bundle Main switch. Device assignments are refused before DHCP writes if the capability is missing.

The candidate is validated by the router's installed `xray run -test` against staged copies of all configuration files and the actual geodata. Unsupported subscription protocols are rejected here before changing the live files. Content hashes cover all three managed files, dependency files and the helper environment. The application saves an immutable candidate and submission intent before SSH. One helper lock and the existing service coordinator serialize location changes, editor operations, failover and controls.

Main preparation reads capabilities, the environment fingerprint, dependency layout, one bundle snapshot and XKeen health. It derives canonical bytes from that snapshot and leaves full staging validation to the helper, which checks hashes before and after validation before changing live files. Assignment preparation still validates before DHCP pinning, and routing previews still validate before review. External configuration/environment edits reject the frozen Main candidate rather than being overwritten.

Changed files are installed by atomic rename, or the owned overlay is removed when the final assignment is cleared. The versioned manifest records the changed set, original bytes and file absence. Unchanged dependencies are checked before installation; they are neither rewritten nor restored as unrelated work. Recovery accepts mixtures of old and candidate files after interrupted renames, but refuses unrelated external edits. SSH disconnection leaves a bounded independent worker/supervisor on the router. `S04xk-routing` restores before XKeen startup, and `S06xk-routing` verifies afterwards. Never delete a lock based on its age. A failed recovery stays locked and is surfaced in the UI.

The server persists Main intent before router preparation and owns reconciliation independently of the browser. It follows the same operation after lost acceptance replies, temporary SSH failures and server restarts. Only a confirmed missing remote record permits replay of the same frozen candidate and ID. Repeated reconciliation preserves completion time and does not duplicate history or restart a completed transaction. Background failover/subscription work defers while incompatible work is active. Status reads do not perform recovery.

DHCP pinning and Xray cannot be one atomic transaction across RCI and SSH. A confirmed pin is retained if the subsequent Xray apply fails, while the previous Xray configuration and assignment remain in effect. The pin has its own durable Undo. The UI reports this behavior. If the application crashes after Xray commits, reconciliation persists the matching assignment state before allowing another mutation.

Successful device-location changes offer Undo in the toast and history. Undo compiles a new transaction restoring the previous assignments while keeping the current Main location and IP reservations. A newer assignment revision blocks stale Undo. The dashboard shows preparation, application, confirmation or recovery progress, the requested Main target, and the last confirmed location. Conflicting controls are disabled with an explanation; closing the page does not interrupt completion. Pending/ambiguous device operations also retain **Check apply status**; repeat requests reuse their original operation ID.

A subscription update that changes Main or a used fixed outbound queues the existing pending-config schedule. `pending_main_config` and `pending_device_configs` record the two kinds of remaining work; the applied Main fingerprint and saved fixed configurations distinguish installed content from subscription cache. A Main-only commit clears only the Main update it applied: pending fixed-exit changes and the original scheduling anchor remain. The scheduled/manual pending apply refreshes the subscription first and applies used exits together. A vanished custom location retains its last applied configuration and is marked unavailable; it is never silently sent through another country. This preserves configuration, not a guarantee that a removed server remains reachable. Choose another country or Main to recover it.

Fixed locations do not follow main failover and do not receive independent health checks. While any custom assignment is saved, automatic total-failure stop is suppressed to avoid stopping other exits in the shared Xray process. Manual Stop still stops the whole process. Applying any assignment restarts XKeen, so existing connections may reconnect.

The optional **apply SNI-only updates daily** setting in interval mode classifies pending Main and used fixed-exit updates together against their installed configurations. When only TLS/Reality SNI changed, all pending updates wait for the selected daily Moscow time. Any other change starts the normal interval from its first detection and includes pending SNI updates in the same apply. Main-only switches preserve pending fixed exits and their deadlines. Manual Apply and failover recovery can apply earlier; fixed exits still have no independent failover health checks.

## HTTP API

All routes use the normal session and mutation protections (JSON, `X-XK-Request: 1`, same Origin).

`POST /api/switch` accepts `{code, operation_id, entry_code?}` with a client-generated UUID and returns HTTP **202** with `{operation: ...}` after durable acceptance, before router I/O. Repeating the same UUID and route pair returns the recorded operation; reusing the UUID for a different request is rejected. A conflicting mutation returns a busy response instead of entering a hidden queue. After a lost response, read `GET /api/routing/operations/<id>`; only a confirmed 404 permits retry with that same ID. `committed`, `rolled_back` and `rejected` are terminal; `unknown` and `recovery_failed` retain the block. Acceptance is not successful application.

### Main chains API

The Main dashboard offers **Single location** and **Chain**. Single keeps one-click location switching; leaving a chain requires choosing a single location, including its current exit. Chain uses ordered **1 · Entry** and **2 · Exit** selectors and an explicit **Apply chain** button. Selecting either node alone makes no request; the other selector disables that same code. The installed route remains visible as **Confirmed Main**, with **Requested Main** shown separately during a switch. Send `{"code":"fi","entry_code":"ru1","operation_id":"<UUID>"}` for home → RU 1 → Finland. Omit `entry_code` or send null to select single mode, including when leaving a chain. Any two distinct saved subscription codes are accepted for preparation; the router's staged Xray validation decides transport support. Entry and exit are copied without modifying the subscription. The exit remains first with tag `vless-reality`; its existing stream/sockopt settings are merged with `dialerProxy: "xk-chain-entry"`. The entry tag is internal, not a routing action. The existing selective helper v3 requires no change.

Additive response fields (existing `code` fields still mean exit):

- `/api/status.active_entry_code`: string or null. `active_route`: `{mode: "single"|"chain", exit_code, exit_name, entry_code, entry_name}`; absent nodes retain their saved label when available, otherwise their code. This is last-confirmed Main, independent of requested operation.
- `active_missing_codes`: array of vanished chain node codes, in entry/exit order. Nonempty means `active_status: "stale"`; installed bytes stay intact. Pending apply refreshes first and applies nothing while a node is missing.
- `pending_reapply_entry_code`: entry paired with the existing pending exit, or null. `pending_update_kind` considers both nodes plus used fixed exits. Unknown baselines count as ordinary configuration changes.
- `active_health`: existing health-entry shape or null. In chain mode, use `route_ok: true|false|null`; null means unverified, not failed. `tcp_ok` is null and `probe_method` is `route` or `skipped`. Node `available[].health` continues describing that node, not the chain. No fields are added to location lists.
- `failover.suspended`: boolean; `suspension_reason`: `"chain_active"` or null. `GET /api/failover` also returns these two fields at top level. The saved enabled flag/options/whitelist are retained; `failover.active` is false during a chain. No fallback, failback, vanished-node recovery or automatic stop may change a chain. An enabled loop may reapply a pending update of the same pair after HTTP failure.
- Main operation payloads add `target_entry_code`, `target_route` (the requested route), and `confirmed_route` (Main confirmed when the response is read), using the same route-object shape. `/api/status.operation` exposes these while pending; `/api/routing/operations/<id>` retains them after completion. Synchronous preparation also exposes the pair. Old journal entries without the entry field read as single. Requested route does not become `active_route` before verified commit.
- `server_route.main_route` and `/api/devices.locations.main_route` describe Main using the same route object. Fixed server/device exits remain single. Server-check context identity includes the Main entry so a check of another pair cannot be reused. `/api/route-check` for a chain returns `tcp: null`, `entry_code`, and `main_verified`; independent server checks still use `scope: "server"` and never establish chain health.

Validation errors use `{error, code, operation}`. Invalid entry type/empty string: HTTP 400, code `entry_code`, message `entry_code must be a non-empty string or null`. Equal entry/exit: 400, `chain`, `Entry and exit locations must be different`. Missing saved chain node: 409, `location`, `No saved location with code '<code>'`. Reusing a UUID with a different entry or mode: 409, `invalid`, `This operation ID is already in use`. `POST /api/active-refresh` adds `active_entry_code` on success; when chain nodes are missing it returns 409, `location`, `Chain locations unavailable: <comma-separated codes>`. Single requests retain existing validation behavior. Unsupported candidates are reported through the existing operation rejection/recovery protocol, not treated as a successful switch.

State pairs are `active_code`/`active_entry_code` and `pending_reapply_code`/`pending_reapply_entry_code`. `active_route` saves labels; `active_missing_codes` identifies unavailable nodes. Existing `applied_main_fingerprint` and `applied_main_config_hashes` now cover the entire generated Main document. Journal intent pairs are `target_code`/`target_entry_code`; Main history adds `entry_code`. Missing entry fields in old files, requests and journal records mean single; reads do not migrate files. Chain health lives under `health.json.map["chain:<entry>:<exit>"]`, isolated from single-node health.

Start/restart, manual/scheduled/SNI pending apply and failover pending recovery preserve the pair. Device assignments and routing edits retain installed Main bytes. Explicit pending applies require a fresh successful subscription download; failure retains pending state. Chain switches change only `04_outbounds.json`; canonical routing, fixed exits, overlay and assignment revisions remain unchanged.

Mode and selected nodes restore from the confirmed server route after reload. An unapplied draft survives status polling until the confirmed route changes. `localStorage.xk_switch_request` stores the UUID, mode, exit (`code`), entry (`entry_code`) and labels. Old code-only records read as single. An unresolved request is followed before any new route can be submitted; a confirmed 404 retries only that saved pair and UUID. Changing entry, exit or mode after resolution creates a new UUID.

Chain health is **working**, **failed** or **unverified**, based only on `active_health.route_ok`; node TCP results do not grade a chain. A stale banner names missing entry/exit nodes and says the installed route was left unchanged. The dashboard and failover settings explain that automatic failover is paused while a chain is active; settings remain editable. Selected Hysteria nodes show a neutral unverified-chain hint and remain selectable. Pending/SNI banners, Devices Main labels, mobile, operation notifications and Main history include both nodes. Fixed device exits remain single.

The dashboard shows operation progress in a compact floating bar without shifting the page: source → target on the first line, status and a phase-based progress bar on the second. Progress advances with observed stages rather than elapsed time; an unknown result is indeterminate. The mobile bar sits above History and respects the bottom safe area. Detailed descriptions remain available to assistive technology, cached use is labeled in the status, and unresolved recovery retains a visible Details link.

`GET /api/status` includes `operation: null` when idle, otherwise safe metadata such as `id`, `kind`, `target_code`, `target_name`, `phase`, timestamps, `message`, `warning`, `blocking` and `block_reason`. A cached-subscription warning is shown during the operation and with the successful completion notice; it does not change `committed` into a failure. Synchronous preparation before a durable transaction appears as `ephemeral: true, id: null`; keep polling `/api/status` for it, without constructing an operation URL. Both status endpoints are read-only with respect to operation execution: the server worker, not polling, reconciles the transaction. Durable operation records can also carry a separate `diagnostics` result.

`GET /api/devices` adds `locations` metadata: assignment revision, current main code, available location labels, identified policy IDs and an optional pending operation. Every device includes `effective_policy` and `location` with code, source IP, scope, unavailable/IP-conflict status and editability.

It also includes `locations.settings` and `device.is_server`. `PUT /api/devices/routing-settings` accepts `{revision, policy_ids}`. `POST /api/devices/server` accepts `{revision, id}` (MAC, or `null` to unmark). Both return a refreshed device snapshot; stale revisions and unavailable policies/devices are rejected. Marking a server preserves the policy mapping, including its automatic/environment fallback. `GET /api/status` includes `server_route` with the server identity, Main/fixed/outside/unknown mode, safe location metadata, Default code and the last matching check. `POST /api/route-check` returns `scope: "server"` when checking an independent or unidentified server route and does not update Default's HTTP health.

`POST /api/devices/location` accepts:

```json
{
  "operation_id": "9ea969da-32ab-42db-8c73-e309c1d922db",
  "id": "02:00:00:00:00:32",
  "revision": "<device revision>",
  "locations_revision": "<locations revision, or null initially>",
  "code": "tr"
}
```

Use `code: null` for Main. The response is HTTP 202 with `{operation: ...}`. Poll `GET /api/routing/operations/<id>` until committed or a failure/recovery state; accepted is not success. Unsupported/stale choices return an error before submission. The same operation ID cannot be used for a different request.

`POST /api/devices/undo` also accepts location-operation IDs. For these it returns `{operation: ...}` for the new asynchronous transaction; poll it as above. Existing device mutations continue returning a refreshed inventory.

## Pre-switch route checks

**Find a working route** appears in Locations when the subscription contains at least one location. Single checks locations directly. Chain checks one exit through the selected entries and needs at least two locations. Reachable directly includes entries whose last Single verdict was Working or Unstable under the current configuration and test sites. Age limits Apply but does not limit this filter.

| Step | Read results | Start with `POST /api/route-checks` |
| --- | --- | --- |
| Single | `?kind=single` | `{kind: "single", codes, run_id, conditions_hash}` |
| Chain | `?kind=chain&exit=<code>` | `{kind: "chain", exit_code, entry_codes, run_id, conditions_hash}` |

Pass the hash from the displayed view's `conditions.hash`. A change before start returns `409 stale_conditions`. The server deduplicates selections in subscription order and checks at most two routes concurrently. The Chain view provides the exit's `direct` row and each entry's `entry_reachable` and `entry_checked_at`. Activity reads `route_check_run` in `/api/status`. Its completion notification counts routes in that run. The sheet report and the desktop Main button count current results across the subscription. The same response carries `route_check_conditions_hash` so other browsers can refresh test sites and route results after an edit.

The Keenetic probe uses Xray and curl with a temporary loopback SOCKS listener. Each candidate runs two rounds against the same test sites used by check server route and failover. Changing test sites through `PUT /api/connectivity` during a run returns `409 busy`. When there are no live probe workers, test sites remain editable even if the diagnostic journal is unreadable. A watchdog bounds the probe lifetime and cleans up after an SSH disconnect.

Any signed-in browser can stop the active run with `POST /api/route-checks/cancel` and `{run_id}`. The server closes probe SSH sessions. Unfinished checks after stop or restart become Check unavailable. The v2 file in `data/route-checks.json` keeps the latest verdict for each ordered route independently of its bounded run history. An unavailable attempt records its reason and time in `last_attempt` and preserves the prior verdict. Existing v1 files migrate on read. After run history rotates, `data/route-check-requests.sqlite3` retains one indexed UUID and composition hash per evicted run for replay detection. Include both files in backups.

Apply sends the verdict's `route_check_id` with the normal Main switch. The server accepts the latest Working verdict for that route within ten minutes of completion, while the candidate and conditions still match. Superseded or stale evidence and any active run return `409 stale_check`. Once accepted, the operation blocks new runs until it settles. Before submitting to the router, the worker checks the candidate and the ten-minute deadline again. Test site edits made after acceptance affect future Apply requests. Replaying an accepted UUID returns the existing operation. Main changes only after router confirmation.

For one release, a GET with only `exit` or a POST with only `exit_code` and `run_id` supports the original mixed view with a direct row keyed `single`. Cancel for that run returns the same form. The legacy `status.route_checks` summary covers Chain and mixed runs.

## Verification

The unit/API suite covers source intersections, unchanged Direct/Block ordering, shared exits, pin conflicts, Main/failover isolation, missing/updated subscriptions, ordinary switching without a fetch, warnings after a prior refresh failure, strict pending-config refresh, stale revisions, Undo, lost acceptance replies, duplicate IDs, automatic reconciliation, nonblocking status and mutation admission. Deferred Main validation has regressions for malformed candidates and configuration/environment drift before and during validation. Shell tests execute the real POSIX helper with isolated files and simulated Xray/XKeen failures, including selective writes, overlay removal, interrupted writes and external edits. The UI regression harnesses cover ambiguous replies, reload/cross-tab recovery, hanging requests, terminal results, ephemeral preparation, device/Main target labels a successful cached switch with a visible warning and stale subscription status, full-route request identity/reload, ordered chain composition, missing nodes, failover suspension and three-state chain health.

For an additional real-core test with only local proxy endpoints:

```sh
XRAY_TEST_BINARY=/path/to/xray .venv/bin/python -m pytest tests/test_device_routing_xray.py
```

This sends simultaneous connections from two local IPv4 addresses through two fixed exits and Main in one Xray process, including Main A → B → A with core restarts. It checks Direct/Block and unchanged routing/overlay bytes, inode and modification time. It requires a second local IPv4 address. On 2026-09-23 both cases passed with official Xray 26.3.27 (`d2758a0`, macOS ARM64); the archive was verified against the official SHA-256 digest. No router or external subscription was used.

These tests do not establish home-router latency or real provider/device traffic. Verify switching on your own router after upgrading. Simulated power-loss checks belong in the isolated helper harness, not the home-router smoke sequence.
