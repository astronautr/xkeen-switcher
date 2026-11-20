# Passwords, sessions, and device pairing

The dashboard uses one admin password and a separate session for each browser. All sessions have the same permissions and remain valid until sign-out, device revocation, or password reset. There are no accounts, roles, JWTs, scheduled expiry jobs, or external auth dependencies.

## Setup, upgrades, and recovery

When the server has no `auth.json`, opening the dashboard shows **Create admin password**. Submit a password and its confirmation to create the first signed-in session. Setup is available once; concurrent submissions have one winner. An existing or corrupt auth file cannot be replaced through setup.

Use **settings → change admin password** to open the same screen with an additional current-password field. Saving requires a valid session and the current admin password, revokes every old session and pairing code, and creates a replacement session for the current browser in one atomic write. Other browsers must sign in again.

For forgotten-password recovery, run on the server:

```bash
./scripts/set-password.sh
```

The command builds the current image, stops the server, asks twice for a password without echoing it, and resumes the server even if input fails or is cancelled. It remains available for offline password changes and recovery. A successful reset invalidates every session. Use an interactive terminal (`ssh -t` remotely); the password is never passed in command arguments or environment variables. Do not run multiple copies or independently start the server during password entry.

For development without Docker, stop the development server first, then run:

```bash
PYTHONPATH=src python3 -m xk_switcher.auth set-password --data-dir ./tmp-data
```

Passwords contain 12–128 characters. Spaces are significant. Until a password is configured, the UI offers password creation and the control API rejects access; routing health and scheduled background work continue normally. A corrupt auth file also blocks access; the same offline password reset recovers it.

Upgrading removes the old token from state. Query tokens, X-Token, xk_token cookies, SUB_TOKEN, and the rotation endpoint no longer grant access. Every browser must sign in once after upgrading. The frontend cleans old URLs/localStorage/cookies. Subscription, router state, failover configuration, and routing files are unaffected.

## Everyday use

- Sign in with the admin password and let your password manager save it if desired.
- To sign in to this dashboard in another browser, click **link device** beside **settings** in the main header. Dictate the six digits; the other browser chooses **Sign in with code**. The same normal app address works on every device.
- Codes last five minutes and work once. There is one live code across the application. A new code replaces the previous one; five wrong attempts cancel it. Spaces and leading zeros are accepted. Closing the dialog keeps the code alive. A server restart cancels it.
- When a code is redeemed, its dialog shows **Browser signed in** and the browser/platform, with **done** and **create another code** actions. It stays open until dismissed. If already closed, a toast confirms the sign-in; reopening shows the result. Expired, replaced, and exhausted codes have distinct messages and a new-code action. The page remembers its invitation until reload. It checks every two seconds while the dialog is open, or with normal dashboard polling while closed, and stops checking on a terminal result. Returning to the page also checks immediately; network errors preserve the invitation and retry.
- The **settings → access → signed-in browsers** section lists browser/platform, sign-in date, and an accent-colored **this browser** label for the current session. **sign out** revokes that session. Revoking a code's issuer also cancels its outstanding code. **sign out** revokes the current session.
- On iPhone, open the normal HTTP URL in Safari, sign in, and use Share → Add to Home Screen. If the installed app has a separate cookie store, sign in there once using password or code; do not rely on shared Safari/PWA storage.

## Storage and security

`data/auth.json` has schema version 1, a salted PBKDF2-HMAC-SHA256 password hash (600,000 iterations, 32-byte salt), and a session list. Each session has an independent non-secret id, SHA-256 hash of a random 32-byte secret, browser/platform label, and creation timestamp. No expiry or last-seen writes are needed. Atomic replacements use a private temporary file with permissions 0600; ordinary session checks are read-only.

`auth.py` owns this store, transient pairing codes, and per-IP login throttles. A shared lock serializes mutations, including code validation, consumption, and session creation. The HTTP layer only translates requests, auth errors, and cookie headers. Router orchestration has no authentication responsibilities.

The browser receives `xk_session` with `HttpOnly; SameSite=Lax; Path=/`. A successful authenticated response refreshes its `Max-Age=34560000` (400 days); logout/revocation of the current session instead deletes it. Server sessions never expire. Browser retention policies or clearing site data can still require another login. No session secrets are returned in JSON or read by JavaScript.

This installation still uses HTTP inside the LAN: credentials and cookies are not encrypted in transit. Secure cookies and TLS are not part of this change.

Every POST/PUT requires `Content-Type: application/json` and `X-XK-Request: 1`. An Origin, when supplied, must match the HTTP Host. CORS is disabled. Switching and subscription editing cannot be triggered by GET. JSON bodies are limited to 64 KiB. Auth and API JSON responses use `Cache-Control: no-store`; request logs omit queries and credentials.

Password and code attempts have independent sliding-window limits: 10 requests per IP per 15 minutes, including successful requests. The limit is checked atomically before expensive password work and returns 429 with Retry-After. Codes additionally have a global five-error budget. Code state and throttles are memory-only and reset on server restart.

## HTTP API

Public endpoints: health, static UI assets, session check, first-run password setup, password login, and code redemption. Every other API requires the session cookie.

| Method | Path | Input / output |
|---|---|---|
| GET | `/api/auth/session` | `{configured, authenticated, session_id}`; id is null when signed out |
| POST | `/api/auth/setup` | `{password}` → `{ok:true}` and first session cookie; only when auth storage is absent |
| POST | `/api/auth/password` | `{current_password,password}` → `{ok:true}` and replacement session cookie; authenticated |
| POST | `/api/auth/login` | `{password}` → `{ok:true}` and session cookie |
| POST | `/api/auth/pair` | `{code}` → `{ok:true}` and session cookie |
| POST | `/api/auth/pairing-code` | `{}` → `{id,status,code,expires_at}`; expiry is Unix seconds |
| GET | `/api/auth/pairing-code?id=ID` | Issuer only: `{id,status,expires_at,device?}`; no code or session secret |
| GET | `/api/auth/sessions` | `{sessions:[{id,label,created_at,current}]}` |
| POST | `/api/auth/sessions/revoke` | `{id}` → `{ok:true,current_revoked}` |
| POST | `/api/auth/logout` | `{}` → `{ok:true}` and deleted cookie |

Incorrect credentials return 401; invalid input 400; missing request marker/foreign Origin 403; wrong content type 415; excessive body size 413; throttling 429; setup already completed or login before setup 409; corrupt/unwritable auth storage 503. An incorrect current password during a password change returns 403, preserving the existing session. Password changes share the password-login throttle; setup has a separate per-IP throttle. The UI treats 401 on protected APIs as sign-out; login errors stay on the form, and network failures preserve the session.

Code creation also returns a non-secret invitation `id` and `status: "pending"`. Status is `pending`, `completed`, `expired`, `replaced`, or `exhausted`; a completed result includes `device: {id,label,created_at}`. Results are recorded only after session persistence succeeds, under the same lock as redemption. Terminal results remain in memory for up to 24 hours, with at most 128 invitations retained overall; restart clears them. Missing/evicted invitations and another session's invitations return 404. Revoking the issuer removes its invitation history. This history never changes session lifetime and contains no used code values.

For API scripts, sign in through `/api/auth/login` and retain cookies in a private cookie jar. Send the password as JSON on stdin from a password manager or interactive prompt, not in a URL or shell history. Send the request marker on every mutation. An authenticated smoke check is:

```bash
curl -b /path/to/private-cookie-jar http://SERVER:8080/api/status
```

## Validation

Auth tests cover first-run setup, concurrent setup, online password changes, atomic write failures, hashes, salt, input, expiry-free persistence, revocation, recovery, rate limits, code expiry/replacement/exhaustion, and concurrent redemption. HTTP tests use real login and cookie jars and exercise CSRF checks, malformed bodies, cookie attributes, legacy rejection, and error responses. UI checks cover two independent browser sessions, mobile header layout, modal keyboard/focus behavior across polling, themes, and session restoration after reload. Physical iOS/PWA behavior must be checked on the target device.
