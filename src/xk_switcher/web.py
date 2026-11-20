"""HTTP server for the authenticated LAN UI and API."""
import json
import logging
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie, CookieError
from functools import wraps
from pathlib import Path
from .auth import Auth, AuthError
from .static_assets import StaticAssets
from .connectivity import (
    MAX_ROUTE_CHECK_URLS,
    check_route_urls,
    validate_route_check_urls,
)
from .failover import FailoverBusyError, FailoverConfig, FailoverLoop
from .service import Service, UnknownCodeError
from .routing import RoutingError, MAX_CONFIG_BYTES, new_id
from .keenetic import KeeneticError

log = logging.getLogger(__name__)
JSON_CT = "application/json; charset=utf-8"
SESSION_COOKIE = "xk_session"
COOKIE_MAX_AGE_SEC = 34560000  # Renew browser persistence; server sessions do not expire.
MAX_BODY_BYTES = 65536

def build_server(service: Service, host: str = "0.0.0.0", port: int = 8080, auth: Auth | None = None,
                 *, ui_dist: Path | None = None):
    assets = StaticAssets(ui_dist if ui_dist is not None else service.config.ui_dist)
    handler = _make_handler(service, auth or Auth(service.state.data_dir), assets)
    return ThreadingHTTPServer((host, port), handler)

def _http_errors(method):
    @wraps(method)
    def handle(self):
        with self._state.capture_events() as event_ids:
            self._event_ids = event_ids
            return respond(self)

    def respond(self):
        try:
            return method(self)
        except AuthError as e:
            self._retry_after = e.retry_after
            return self._json(e.status, {"error": str(e)})
        except (KeeneticError, RoutingError) as e:
            body = {"error": str(e), "code": e.code}
            if e.code == "busy":
                body["operation"] = self._routing_operation()
            return self._json(e.status, body)
        except Exception:
            log.exception("API request failed")
            return self._json(503, {"error": "The server could not complete this request. Refresh its status and try again.",
                                    "code": "unavailable"})
    return handle

def _one_shot_failover_loop(service: Service) -> FailoverLoop:
    c = service.config
    cfg = FailoverConfig(
        check_interval_sec=c.failover_check_interval_sec,
        fail_threshold=c.failover_fail_threshold,
        grace_after_switch_sec=c.failover_grace_after_switch_sec,
        dampening_ticks=c.failover_dampening_ticks,
        tcp_timeout_sec=c.failover_tcp_timeout_sec,
    )
    return FailoverLoop(
        state=service.state, service=service, router=service.router,
        cfg=cfg,
        route_check_fn=lambda: check_route_urls(
            service.state.read_connectivity()["check_urls"],
        ),
    )

def _make_handler(service: Service, auth: Auth, assets: StaticAssets):
    class Handler(BaseHTTPRequestHandler):
        _state = service.state

        def _routing_operation(self):
            return service.routing.public_operation()

        def log_message(self, fmt, *args):
            # Default parse-error messages can contain the entire credential-bearing URL.
            pass

        def log_request(self, code="-", size="-"):
            path = getattr(self, "path", "").split("?", 1)[0]
            log.info("%s %s %s", self.command, path, code)

        @_http_errors
        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            path = url.path
            qs = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            if path == "/api/health":
                return self._json(200, {"ok": True})
            if path == "/api/auth/session":
                info = auth.session(self._cookie(SESSION_COOKIE))
                if info["authenticated"]:
                    self._session_cookie = self._cookie(SESSION_COOKIE)
                return self._json(200, info)
            if not path.startswith("/api/"):
                return self._compiled_static(assets.read(path))
            if not self._auth():
                return self._json(401, {"error": "unauthorized"})
            if path == "/api/auth/sessions":
                return self._json(200, {"sessions": auth.sessions(self._session_secret)})
            if path == "/api/auth/pairing-code":
                return self._json(200, auth.pairing_status(self._session_secret, qs.get("id", [""])[0]))
            if path == "/api/routing" or path.startswith("/api/routing/"):
                return self._routing_request("GET", path)
            if path == "/api/status":
                return self._json(200, service.status())
            if path == "/api/router-updates":
                return self._json(200, service.router_updates.status())
            if path == "/api/devices":
                return self._json(200, service.devices.snapshot())
            if path == "/api/failover":
                return self._get_failover()
            if path == "/api/connectivity":
                return self._get_connectivity()
            if path == "/api/switch":
                return self._json(405, {"error": "Use POST to switch locations"})
            if path == "/api/route-checks":
                exit_code = qs.get("exit", [""])[0]
                kind = qs.get("kind", [None])[0]
                if kind not in (None, "single", "chain"):
                    raise RoutingError("Choose Single or Chain")
                if kind != "single" and not exit_code:
                    raise RoutingError("Choose an exit location")
                return self._json(200, service.route_checks.view(exit_code or None, kind=kind))
            if path == "/api/sub-url":
                return self._sub_url_get(qs)
            return self._json(404, {"error": "not found"})

        @_http_errors
        def do_POST(self):
            url = urllib.parse.urlparse(self.path)
            path = url.path
            self._check_mutation()
            if path.startswith("/api/routing/"):
                if not self._auth():
                    return self._json(401, {"error": "unauthorized"})
                return self._routing_request("POST", path)
            body = self._read_body()
            if path in ("/api/auth/login", "/api/auth/pair", "/api/auth/setup"):
                ip = self.client_address[0]
                ua = self.headers.get("User-Agent", "")
                if path == "/api/auth/login":
                    secret = auth.login(body.get("password"), ip, ua)
                elif path == "/api/auth/setup":
                    secret = auth.setup_password(body.get("password"), ip, ua)
                else:
                    secret = auth.pair(body.get("code"), ip, ua)
                self._session_cookie = secret
                return self._json(200, {"ok": True})
            if not self._auth():
                return self._json(401, {"error": "unauthorized"})
            if path == "/api/auth/password":
                self._session_cookie = auth.change_password(
                    self._session_secret, body.get("current_password"), body.get("password"),
                    self.client_address[0], self.headers.get("User-Agent", ""),
                )
                return self._json(200, {"ok": True})
            if path == "/api/auth/pairing-code":
                return self._json(200, auth.create_pairing_code(self._session_secret))
            if path == "/api/auth/logout":
                auth.revoke(self._session_secret)
                self._session_cookie = ""
                return self._json(200, {"ok": True})
            if path == "/api/auth/sessions/revoke":
                if not isinstance(body.get("id"), str) or not body["id"]:
                    return self._json(400, {"error": "Invalid session id"})
                current = auth.revoke(self._session_secret, body["id"])
                if current:
                    self._session_cookie = ""
                return self._json(200, {"ok": True, "current_revoked": current})
            if path == "/api/switch":
                return self._do_switch(body)
            if path == "/api/router-updates/check":
                if body:
                    raise RoutingError("Check for updates takes no parameters")
                return self._json(200, service.router_updates.refresh())
            if path == "/api/router-updates/batch":
                return self._json(202, service.router_updates.create_pair(body))
            if path in {"/api/router-updates/install", "/api/router-updates/rollback"}:
                if "action" in body:
                    raise RoutingError("Use the endpoint to select the operation")
                return self._json(202, service.router_updates.start({**body, "action": path.rsplit("/", 1)[1]}))
            if path == "/api/router-updates/recover":
                if set(body) != {"id"}:
                    raise RoutingError("Choose the interrupted update")
                return self._json(202, service.router_updates.recover(body["id"]))
            if path == "/api/devices/change":
                return self._json(200, service.devices.change(body))
            if path == "/api/devices/location":
                return self._json(202, service.device_locations.change(body))
            if path == "/api/devices/favorite":
                return self._json(200, service.devices.set_favorite(body))
            if path == "/api/devices/server":
                return self._json(200, service.device_routing_settings.set_server(body))
            if path == "/api/devices/undo":
                return self._json(200, service.devices.undo(body.get("operation_id")))
            if path == "/api/update":
                return self._do_update()
            if path == "/api/sub-url":
                return self._do_set_url(body.get("url", ""))
            if path == "/api/xkeen":
                return self._do_xkeen(body.get("action", ""))
            if path == "/api/failover/check-now":
                return self._do_check_now()
            if path == "/api/probe":
                return self._do_probe(body)
            if path == "/api/route-check":
                return self._do_route_check()
            if path == "/api/route-checks":
                if "kind" in body and body["kind"] not in ("single", "chain"):
                    raise RoutingError("Choose Single or Chain")
                view = service.route_checks.start(body.get("exit_code"), body.get("run_id"), kind=body.get("kind"),
                                                  codes=body.get("codes"), entry_codes=body.get("entry_codes"),
                                                  conditions_hash=body.get("conditions_hash"))
                return self._json(202, view)
            if path == "/api/route-checks/cancel":
                return self._json(200, service.route_checks.cancel(body.get("run_id")))
            if path == "/api/active-refresh":
                return self._do_active_refresh()
            return self._json(404, {"error": "not found"})

        @_http_errors
        def do_PUT(self):
            url = urllib.parse.urlparse(self.path)
            path = url.path
            self._check_mutation()
            if not self._auth():
                return self._json(401, {"error": "unauthorized"})
            if path.startswith("/api/routing/"):
                return self._routing_request("PUT", path)
            body = self._read_body()
            if path == "/api/failover/config":
                return self._put_failover_config(body)
            if path == "/api/devices/routing-settings":
                return self._json(200, service.device_routing_settings.save(body))
            if path == "/api/connectivity":
                return self._put_connectivity(body)
            if path == "/api/auto-update":
                try:
                    config = service.set_auto_update(body)
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
                return self._json(200, {"ok": True, "config": config})
            if path == "/api/router-updates/auto":
                return self._json(200, service.router_updates.configure(body))
            if path == "/api/router-updates/batch":
                return self._json(200, service.router_updates.reschedule_pair(body))
            if path == "/api/router-updates/schedule":
                return self._json(200, service.router_updates.schedule(body))
            return self._json(404, {"error": "not found"})

        @_http_errors
        def do_DELETE(self):
            self._check_mutation()
            if not self._auth():
                return self._json(401, {"error": "unauthorized"})
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/router-updates/schedule":
                body = self._read_body()
                if set(body) != {"component"}:
                    raise RoutingError("Choose the component to cancel")
                return self._json(200, service.router_updates.cancel(body["component"]))
            if path == "/api/router-updates/batch":
                body = self._read_body()
                if set(body) != {"id"}:
                    raise RoutingError("Choose the combined update to cancel")
                return self._json(200, service.router_updates.cancel_pair(body["id"]))
            if path == "/api/routing/draft":
                return self._routing_request("DELETE", path)
            return self._json(404, {"error": "not found"})

        def _routing_body(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if self.headers.get("Transfer-Encoding") or length < 0:
                    raise RoutingError("Invalid request format")
                if length > 8 * MAX_CONFIG_BYTES:
                    raise RoutingError("Request is too large", 413, "too_large")
                body = json.loads(self.rfile.read(length)) if length else {}
                if not isinstance(body, dict): raise ValueError()
                return body
            except (ValueError, UnicodeError) as e:
                raise RoutingError("Expected a JSON object") from e

        def _routing_request(self, method, path):
            r = service.routing
            try:
                body = self._routing_body() if method != "GET" else {}
                if method == "GET" and path == "/api/routing":
                    return self._json(200, r.state())
                if path == "/api/routing/draft":
                    if method == "GET": return self._json(200, {"draft":r.store.read("draft.json")})
                    if method == "PUT": return self._json(200, r.save_draft(body))
                    if method == "DELETE":
                        r.store.delete_draft(body.get("expected_revision"))
                        return self._json(200, {"ok":True})
                if method == "POST" and path == "/api/routing/preview":
                    return self._json(200, r.preview(body))
                if method == "POST" and path == "/api/routing/apply":
                    return self._json(202, r.apply(body))
                if method == "POST" and path == "/api/routing/reimport":
                    return self._json(200, r.reimport(body))
                if method == "GET" and path == "/api/routing/id":
                    return self._json(200, {"id":new_id()})
                if method == "GET" and path == "/api/routing/history":
                    return self._json(200, {"snapshots":r.store.history(),"operations":r.store.operations()})
                parts = path.split("/")
                if method == "GET" and len(parts) == 5 and parts[3] == "operations":
                    return self._json(200,r.operation(parts[4]))
                if method == "GET" and len(parts) in (5,6) and parts[3] == "history":
                    meta,raw = r.store.blob("snapshots",parts[4])
                    if len(parts) == 5: return self._json(200,meta)
                    if parts[5] == "download":
                        self.send_response(200)
                        self.send_header("Content-Type","application/octet-stream")
                        self.send_header("Content-Disposition",'attachment; filename="05_routing.json"')
                        self.send_header("Content-Length",str(len(raw)))
                        self.send_header("Cache-Control","no-store")
                        self._maybe_set_session_cookie()
                        self.end_headers()
                        self.wfile.write(raw)
                        return
                return self._json(404,{"error":"not found"})
            except RoutingError as e:
                body = {"error": str(e), "code": e.code, "validation": e.validation}
                if e.code == "busy":
                    body["operation"] = self._routing_operation()
                return self._json(e.status, body)
            except Exception as e:
                log.exception("routing API failed")
                return self._json(503, {"error": "Could not complete the routing request. Refresh its status and try again.", "code": "unavailable"})

        def _auth(self) -> bool:
            self._session_secret = self._cookie(SESSION_COOKIE)
            ok = auth.session(self._session_secret)["authenticated"]
            if ok:
                self._session_cookie = self._session_secret
            return ok

        def _cookie(self, name):
            try:
                cookie = SimpleCookie(self.headers.get("Cookie", ""))
                return cookie[name].value if name in cookie else ""
            except CookieError:
                return ""

        def _check_mutation(self):
            if self.headers.get("X-XK-Request") != "1":
                raise AuthError("Missing X-XK-Request header", 403)
            origin = self.headers.get("Origin")
            if origin is not None and origin != "http://" + self.headers.get("Host", ""):
                raise AuthError("Cross-origin request rejected", 403)
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise AuthError("Content-Type must be application/json", 415)

        def _read_body(self) -> dict:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise AuthError("Invalid Content-Length", 400) from None
            if length < 0 or length > MAX_BODY_BYTES:
                raise AuthError("Request body too large", 413)
            try:
                body = json.loads(self.rfile.read(length)) if length else {}
            except (ValueError, UnicodeDecodeError):
                raise AuthError("Invalid JSON body", 400) from None
            if not isinstance(body, dict):
                raise AuthError("JSON body must be an object", 400)
            return body

        def _json(self, status: int, data: dict):
            event_ids = getattr(self, "_event_ids", None)
            if event_ids and self.command not in {"GET", "HEAD"}:
                data = {**data, "event_ids": list(event_ids)}
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", JSON_CT)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            if getattr(self, "_retry_after", None):
                self.send_header("Retry-After", str(self._retry_after))
            self._maybe_set_session_cookie(status)
            self.end_headers()
            self.wfile.write(payload)

        def _maybe_set_session_cookie(self, status=200):
            secret = getattr(self, "_session_cookie", None)
            # A slow request may outlive logout or password replacement. Its
            # response must not overwrite the browser's newer session cookie.
            if secret is not None and 200 <= status < 300 and (not secret or auth.session(secret)["authenticated"]):
                max_age = COOKIE_MAX_AGE_SEC if secret else 0
                self.send_header("Set-Cookie", f"{SESSION_COOKIE}={secret}; Path=/; "
                                 f"Max-Age={max_age}; HttpOnly; SameSite=Lax")
            if self._cookie("xk_token"):
                self.send_header("Set-Cookie", "xk_token=; Path=/; Max-Age=0; SameSite=Lax")

        def _compiled_static(self, result):
            if result is None:
                return self._json(404, {"error": "static not found"})
            data, content_type, cache_control = result
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", cache_control)
            self._maybe_set_session_cookie()
            self.end_headers()
            self.wfile.write(data)

        def _do_switch(self, body):
            code = body.get("code")
            if not isinstance(code, str) or not code:
                return self._json(400, {"error": "missing code"})
            try:
                op = service.routing.submit_main(code, body["operation_id"] if "operation_id" in body else new_id(),
                                                 entry_code=body.get("entry_code"),
                                                 route_check_id=body.get("route_check_id"))
            except RoutingError as e:
                return self._json(e.status, {"error": str(e), "code": e.code,
                                            "operation": service.routing.public_operation()})
            except Exception as e:
                log.exception("switch submission failed")
                return self._json(502, {"error": "Could not confirm acceptance of the switch request. Checking its status.", "code": "unavailable"})
            return self._json(202, {"operation": op})

        def _busy(self, message: str):
            """One envelope for every admission refusal: nothing was accepted or queued."""
            return self._json(409, {"error": message, "code": "busy", "operation": self._routing_operation()})

        def _do_update(self):
            try:
                result = service.update()
            except RoutingError:
                raise
            except Exception as e:
                log.exception("update failed")
                return self._json(502, {"error": "Could not finish refreshing the subscription. Check its status and try again.", "code": "unavailable"})
            return self._json(200, {"ok": True, **result})

        def _sub_url_get(self, qs):
            if "url" in qs:
                return self._json(400, {"error": "Use POST to change subscription URL"})
            st = service.state.read_state()
            return self._json(200, {"url": st.get("subscription_url")})

        def _do_set_url(self, url: str):
            if not isinstance(url, str) or not url:
                return self._json(400, {"error": "missing url"})
            try:
                service.set_subscription_url(url)
            except RoutingError:
                raise
            except ValueError as e:
                return self._json(400, {"error": str(e), "code": "validation"})
            except Exception as e:
                log.exception("subscription URL update failed")
                return self._json(503, {"error": "Could not save the subscription. Try again.", "code": "unavailable"})
            return self._json(200, {"ok": True, "url": url})

        def _get_failover(self):
            cfg = service.reconcile_failover_config()
            runtime = service.state.read_health()
            c = service.config
            env_constants = {
                "check_interval_sec": c.failover_check_interval_sec,
                "fail_threshold": c.failover_fail_threshold,
                "grace_after_switch_sec": c.failover_grace_after_switch_sec,
                "dampening_ticks": c.failover_dampening_ticks,
                "tcp_timeout_sec": c.failover_tcp_timeout_sec,
            }
            chain = bool(service.state.read_state().get("active_entry_code"))
            return self._json(200, {"config": cfg, "runtime": runtime, "env_constants": env_constants,
                                    "suspended": chain, "suspension_reason": "chain_active" if chain else None})

        def _put_failover_config(self, body):
            enabled = bool(body.get("enabled", False))
            whitelist = body.get("whitelist", []) or []
            auto_stop = bool(body.get("auto_stop_on_total_failure", False))
            auto_restart = bool(body.get("auto_restart_on_recovery", False))
            if not isinstance(whitelist, list) or not all(isinstance(c, str) for c in whitelist):
                return self._json(400, {"error": "whitelist must be list of strings"})
            if len(whitelist) != len(set(whitelist)):
                return self._json(400, {"error": "duplicate codes in whitelist"})
            sub_codes = {d["code"] for d in service.state.read_subscription().get("locations", [])}
            whitelist = [code for code in whitelist if code in sub_codes]
            if enabled and not whitelist:
                return self._json(400, {"error": "whitelist empty: no available locations"})
            if auto_restart and not auto_stop:
                return self._json(400, {"error": "auto_restart requires auto_stop"})
            cfg = {
                "schema_version": 1,
                "enabled": enabled,
                "auto_failback": bool(body.get("auto_failback", False)),
                "auto_stop_on_total_failure": auto_stop,
                "auto_restart_on_recovery": auto_restart,
                "whitelist": list(whitelist),
            }
            cfg = service.reconcile_failover_config(cfg)
            # Sync failover_since to match derived state (service.status derives active flag).
            st = service.state.read_state()
            active_code = st.get("active_code")
            primary = whitelist[0] if whitelist else None
            on_fallback = bool(not st.get("active_entry_code") and enabled and active_code and primary and active_code != primary and active_code in whitelist)
            if on_fallback:
                since = st.get("failover_since") or datetime.now(timezone.utc).isoformat(timespec="seconds")
                service.state.write_state({"failover_since": since})
            else:
                service.state.write_state({"failover_since": None})
            # Kick a probe+decide pass so enable-on-dead-active switches without waiting for the background tick.
            if enabled and whitelist and service.failover_loop:
                import threading as _th
                _th.Thread(target=service.failover_loop.tick_once, daemon=True,
                           name="xk-failover-kick").start()
            return self._json(200, {"ok": True, "config": cfg})

        def _get_connectivity(self):
            return self._json(200, {
                "config": service.state.read_connectivity(),
                "max_urls": MAX_ROUTE_CHECK_URLS,
            })

        def _put_connectivity(self, body):
            with service.route_checks.admission_lock:
                if service.route_checks.running():
                    raise RoutingError("Route checks are running. Stop them or wait before changing test sites.", 409, "busy")
                try:
                    check_urls = validate_route_check_urls(body.get("check_urls"))
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
                config = {
                    "schema_version": 1,
                    "check_urls": check_urls,
                }
                service.state.write_connectivity(config)
            return self._json(200, {"ok": True, "config": config})

        def _do_check_now(self):
            loop = service.failover_loop or _one_shot_failover_loop(service)
            try:
                loop.tick_once(reject_busy=True)
            except FailoverBusyError as e:
                return self._busy(str(e))
            except RoutingError:
                raise
            except Exception as e:
                log.exception("check-now failed")
                return self._json(500, {"error": "Could not check failover locations. Try again.", "code": "unavailable"})
            return self._json(200, service.state.read_health())

        def _do_probe(self, body):
            code = body.get("code")
            codes_arg = body.get("codes")
            if code is not None and not isinstance(code, str):
                return self._json(400, {"error": "code must be string"})
            if codes_arg is not None and (not isinstance(codes_arg, list) or not all(isinstance(c, str) for c in codes_arg)):
                return self._json(400, {"error": "codes must be list of strings"})
            if code:
                codes = [code]
            elif codes_arg is not None:
                codes = codes_arg
            else:
                codes = [l["code"] for l in service.state.read_subscription().get("locations", [])]
            loop = service.failover_loop or _one_shot_failover_loop(service)
            try:
                results = loop.probe_codes(codes)
            except FailoverBusyError as e:
                return self._busy(str(e))
            except Exception as e:
                log.exception("probe failed")
                return self._json(500, {"error": "Could not check the locations. Try again.", "code": "unavailable"})
            return self._json(200, {"results": results, "health": service.state.read_health()})

        def _do_route_check(self):
            loop = service.failover_loop or _one_shot_failover_loop(service)
            try:
                result = loop.check_current_route()
            except FailoverBusyError as e:
                return self._busy(str(e))
            except ValueError as e:
                return self._json(409, {"error": str(e), "code": "precondition"})
            except RoutingError:
                raise
            except Exception as e:
                log.exception("route check failed")
                return self._json(500, {"error": "Could not check the current route. Try again.", "code": "unavailable"})
            return self._json(200, result)

        def _do_active_refresh(self):
            st = service.state.read_state()
            pending_code = st.get("pending_reapply_code")
            if not pending_code or pending_code != st.get("active_code"):
                return self._json(409, {"error": "no active config update pending", "code": "precondition"})
            if st.get("xkeen_state") == "stopped":
                return self._json(409, {"error": "xkeen is stopped", "code": "precondition"})
            try:
                applied = service.apply_pending_reapply_now()
            except RoutingError:
                raise
            except Exception as e:
                log.exception("active refresh failed")
                return self._json(502, {"error": "Could not apply the configuration update. Check its status before retrying.", "code": "unavailable"})
            if not applied:
                missing = service.state.read_state().get("active_missing_codes", [])
                if missing:
                    return self._json(409, {"error": "Chain locations unavailable: " + ", ".join(missing), "code": "location"})
                return self._json(409, {"error": "active config update is no longer pending", "code": "precondition"})
            return self._json(200, {
                "ok": True,
                "active_code": service.state.read_state().get("active_code"),
                "active_entry_code": service.state.read_state().get("active_entry_code"),
            })

        def _do_xkeen(self, action: str):
            if action not in {"start", "stop", "restart"}:
                return self._json(400, {"error": "invalid action"})
            try:
                service.xkeen_control(action)
            except RoutingError:
                raise
            except Exception as e:
                log.exception("xkeen control failed")
                return self._json(502, {"error": "Could not confirm the XKeen state. Refresh its status before retrying.", "code": "unavailable"})
            return self._json(200, {"ok": True, "action": action})

    return Handler
