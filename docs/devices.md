# Keenetic devices and access policies

The main screen manages assignments to existing Keenetic policies. Creating policies or changing their connection priorities remains in Keenetic. Devices are identified by MAC address, never by their display name or IP address. A device using a new private MAC appears as a separate device.

## Transport and configuration

`keenetic.py` implements authenticated HTTP RCI using Python's standard library. `KEENETIC_USER` and `KEENETIC_PASSWORD` are the web-interface credentials; they are independent of `ROUTER_USER` and `SSH_PASSWORD`. `KEENETIC_URL` defaults to `http://<ROUTER_HOST>`. Credentials and router cookies remain on the server. Redirects are rejected, system proxy settings are ignored, and HTTPS uses certificate verification.

The `/auth` challenge uses `SHA256(challenge + MD5(user + ':' + realm + ':' + password))`. Only an explicit HTTP 401 triggers authentication and one retry. Timeouts or ambiguous mutation responses are never replayed automatically. Router authentication errors return 503 to the dashboard, preserving its separate login session. Embedded RCI errors are checked even in HTTP 200 responses.

This integration uses the RCI endpoints used by Keenetic's own web application. Read-only integration was verified against KeeneticOS 5.1.5. The write payloads were checked against that firmware's web application; mutations and recovery are tested against the local mock. Live router mutations still need a smoke test. Segment inheritance uses `conform`, introduced in [KeeneticOS 4.2](https://support.keenetic.com/explorer/kn-1613/en/36733-keeneticos-4-2.html); older firmware is not a tested target.

## Read model

Every refresh joins five RCI responses:

| RCI path | Purpose |
| --- | --- |
| `show/ip/hotspot` | Current devices, IP addresses, networks and online status |
| `known/host` | Authoritative saved names and registration, including offline records |
| `ip/hotspot` | Configured host policies and network defaults |
| `show/ip/policy` | Existing policy IDs and descriptions |
| `ip/dhcp/host` | Saved DHCP reservations, independent of current leases |

Configured policies are read separately from runtime effective policies: **Default** and **Segment default** must remain distinguishable even when both currently produce the same route. Built-in choices are Default, Segment default and No internet. Other choices use router policy IDs with a `policy:` prefix, independent of their labels.

The expanded panel refreshes every 30 seconds through the dashboard polling loop. Refresh is deferred during edits, open menus or focus inside the panel. Registered offline devices remain visible. An unregistered offline device disappears once Keenetic no longer reports it and it has no saved IP reservation.

The Status column shows an explicit **Online** or **Offline** label from Keenetic's inventory, with registration below it. A filled green square marks online devices; an outlined muted square marks offline devices. Favorites use bracketed stars, and the filter checkboxes use compact square checkmark controls, with native keyboard interaction and visible focus in both themes.

## Favorites

The star in each device's Actions column adds or removes it from favorites. The **Favorites** checkbox shows only starred devices and combines with search, registration, access policy and online filters. Its count includes all favorites in the current inventory. **Clear filters** resets the favorites filter too.

Favorites are shared by all signed-in browsers and the PWA. They are stored by MAC address in `data/devices/favorites.json`, written atomically with mode 0600. Renaming, unregistering, Undo and temporary absence from the inventory do not remove a favorite. A new private MAC is a separate device. Favorites do not contact Keenetic or change router settings, device revisions or the Undo journal.

`GET /api/devices` includes a `favorite` boolean on every device. `POST /api/devices/favorite` accepts `{ "id": "02:00:00:00:00:45", "favorite": true }` and returns `{ "favorites": ["02:00:00:00:00:45"] }`, the full set of favorite MAC addresses. Setting an explicit boolean is idempotent; requests validate the MAC format and may retain favorites for devices currently absent from Keenetic.

## Mutations

All device endpoints require the normal session. POST requests also require JSON, `X-XK-Request: 1` and a matching Origin when supplied.

`GET /api/devices` returns `configured`, `devices`, `policies`, `operations` and `updated_at`. Public device revisions cover name, registration, the configured policy, current IP and saved IP reservation. The internal raw host configuration is kept server-side.

`POST /api/devices/change` accepts:

```json
{
  "operation_id": "d3db901b-6c70-4aa3-a181-b6c39fb310e4",
  "changes": [{
    "id": "02:00:00:00:00:45",
    "revision": "<revision from GET /api/devices>",
    "values": {"registered": true, "name": "Laptop", "policy": "segment"}
  }]
}
```

One operation accepts at most two devices, allowing an existing name to be released before another device is registered. Values are restricted to `name`, `registered`, `policy` and `ip_pinned`. Names are 1–64 characters, trimmed, without control characters; uniqueness uses NFKC normalization and case folding. Stale revisions or name conflicts return 409 before writes. A repeated operation ID with the same committed request does not repeat the writes.

RCI writes use `known/host` for registration and names, `ip/hotspot/host` for policy bindings, and `system/configuration/save` to persist successful changes. Removing a setting uses `{ "no": true }`. Ordinary policy edits leave schedules, priority and other host options intact. Unregister sends `{mac, name, no: true}` to `known/host`; it does not delete DHCP reservations. It can remove the host policy, schedule and other options as Keenetic unregisters the host, so these are saved for Undo.

## IP pinning

The bracketed pin button beside an IP address reserves that current IPv4 address for the device's MAC in Keenetic DHCP. A filled pin marks a saved reservation; clicking it again removes the reservation. Both states have action tooltips and accessible names, keyboard support and a 44px touch target on mobile. A device must be registered and have a usable IPv4 address before it can be pinned. An existing reservation can be removed even when the device is offline or unregistered. When the current address differs from the reservation, the row shows both addresses; unpin removes the saved reservation. Unpinning does not disconnect the device or force its current lease to change immediately.

Public devices include `ip_pinned` (boolean), `reserved_ip` (IPv4 or empty string), and `can_pin_ip` (registered with a usable current IPv4). Send `values: {"ip_pinned": true}` or `values: {"ip_pinned": false}` through the existing change endpoint with the device revision and a new operation ID. Pinning an already pinned device preserves its existing reservation. A changed address or reservation invalidates stale revisions. A reservation that conflicts with another device's current or saved IP is rejected before writing, including during Undo.

The RCI payloads are `POST /rci/ip/dhcp/host` with `{ "mac": "…", "ip": "…" }` for pin and `{ "mac": "…", "no": true }` for unpin, followed by readback and configuration save. These payloads and the saved-reservation read model were checked against [Keenetic's official demo web application](https://keenetic.demo.keenetic.pro/) (`setHostStaticIp`, `removeHostStaticIp`, `getStaticIpData`, September 2026). Live writes have not been smoke-tested on the home router. Pin/unpin uses the same durable journal, rollback and Undo as other device changes. Undo changes only the reservation and preserves later names, policies and registration; journals created before this feature remain supported.

## Undo and interrupted operations

`POST /api/devices/undo` accepts `{ "operation_id": "..." }`. Undo checks that the affected settings still match the operation. It preserves later unrelated fields: undoing a rename does not revert a later policy edit. Registration Undo checks the whole saved host configuration. Name conflicts and missing previous policies block restoration instead of choosing an alternative.

The durable journal is `data/devices/operations.json`, written atomically with mode 0600 before router writes. It retains the latest 100 completed operations and all interrupted operations. It is separate from notification history and survives browser/server restarts. The application history records operation IDs; notifications retain those IDs for their Undo buttons.

An operation progresses through `pending` → `committed` → `undoing` → `undone`. A failed change attempts rollback; confirmed rollback becomes `rolled_back`. An unconfirmed change becomes `uncertain`, and new changes are blocked until it is recovered. Undo can retry interrupted restoration after a restart. Readback verifies requested fields and restored host options before saving the router configuration. These steps are coordinated with other application mutations through the existing operation lock, but cannot make separate RCI calls atomic against simultaneous edits in Keenetic's own UI.

The expanded Devices panel displays interrupted operations with an Undo action. If recovery reports settings changed outside the operation, inspect the affected device in Keenetic; do not delete the journal to force another write. Corrupt or unreadable history blocks device operations while leaving the main VPN controls available.

## Proxy locations

Devices also support fixed IPv4 proxy exits in one Xray process. The location dropdown lives beside the policy control; policy and location filters accept multiple selections. See [Device proxy locations](device-locations.md) for compiler semantics, DHCP requirements, helper v2 transactions, asynchronous API responses and durable Undo. Device changes and Undo that would remove a required reservation or registration are rejected until the assignment is cleared.

**Routing setup** maps existing connection policies to XKeen. Saved settings take precedence over the environment/name fallback. The server starts unknown; a compact server icon in each registered device row marks/unmarks it by MAC. Only one device is marked at a time, and a fixed server country remains allowed. Outbound distinguishes the server's checked route from Default. See the same document for HTTP health attribution and the settings API.

## Local validation

`ROUTER_HOST=mock` selects a persistent simulated RCI device inventory, including duplicate names, offline devices, unregistered hosts and each built-in policy. It uses the production normalization and mutation service; state is stored under `data/devices/mock-router.json`.

Run `.venv/bin/python -m pytest tests/test_devices.py tests/test_keenetic.py tests/test_devices_web.py`. Tests cover challenge authentication, RCI errors, inventory normalization, policy round trips, combined rename/registration, optimistic concurrency, field-aware Undo, partial failures, interrupted Undo, host-option restoration, persistent recovery and API authentication/CSRF.
