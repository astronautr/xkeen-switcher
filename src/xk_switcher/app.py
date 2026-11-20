"""Entry point: wire env → state → service → web + scheduler."""
import logging
import signal
from .config import Config
from .auth import Auth
from .connectivity import check_route_urls
from .failover import FailoverConfig, FailoverLoop
from .router import Router
from .routing import RoutingError
from .scheduler import Scheduler
from .service import Service, TRIGGER_CRON
from .state import State
from .web import build_server

AUTO_UPDATE_POLL_SEC = 30

def main() -> None:
    cfg = Config.from_env()
    logging.basicConfig(
        level=cfg.log_level,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )
    log = logging.getLogger("xk_switcher")
    state = State(cfg.data_dir)
    state.init({
        "subscription_url": cfg.subscription_url,
    })
    router = Router(
        host=cfg.router_host,
        user=cfg.router_user,
        port=cfg.router_port,
        ssh_key=cfg.ssh_key,
        known_hosts=cfg.known_hosts,
        password=cfg.ssh_password,
        mock_data_dir=cfg.data_dir,
    )
    service = Service(state=state, router=router, config=cfg)
    httpd = build_server(service, host=cfg.listen_host, port=cfg.listen_port, auth=Auth(cfg.data_dir),
                         ui_dist=cfg.ui_dist)

    import threading

    fo_cfg = FailoverConfig(
        check_interval_sec=cfg.failover_check_interval_sec,
        fail_threshold=cfg.failover_fail_threshold,
        grace_after_switch_sec=cfg.failover_grace_after_switch_sec,
        dampening_ticks=cfg.failover_dampening_ticks,
        tcp_timeout_sec=cfg.failover_tcp_timeout_sec,
    )
    failover = FailoverLoop(
        state=state, service=service, router=router, cfg=fo_cfg,
        route_check_fn=lambda: check_route_urls(
            state.read_connectivity()["check_urls"],
        ),
    )
    service.failover_loop = failover
    service.routing.recover()
    service.route_checks.recover()
    if not service.routing.public_operation():
        threading.Thread(target=service.probe_xkeen, daemon=True, name="xkeen-probe").start()
        threading.Thread(target=service.sync_active_from_router, daemon=True, name="sync-active").start()
    failover.start()
    refresh_deferred = threading.Event()

    def subscription_update_task():
        try:
            if service.routing.public_operation():
                refresh_deferred.set()
                return
            service.update(trigger=TRIGGER_CRON)
            refresh_deferred.clear()
        except RoutingError as error:
            if error.code == "busy":
                refresh_deferred.set()
            else:
                refresh_deferred.clear()
                log.exception("subscription update failed")
        except Exception:
            refresh_deferred.clear()
            log.exception("subscription update failed")

    scheduler = Scheduler(
        task=subscription_update_task,
        interval_sec=cfg.subscription_update_interval_sec,
    )
    scheduler.start()

    def pending_reapply_task():
        try:
            if refresh_deferred.is_set():
                subscription_update_task()
            if service.routing.public_operation():
                return
            if service.apply_pending_reapply():
                log.info("pending config auto-applied")
        except RoutingError as error:
            if error.code != "busy":
                log.exception("pending config auto-apply failed")
        except Exception:
            log.exception("pending config auto-apply failed")

    auto_update_scheduler = Scheduler(
        task=pending_reapply_task,
        interval_sec=AUTO_UPDATE_POLL_SEC,
    )
    auto_update_scheduler.start()
    software_scheduler = Scheduler(task=service.router_updates.tick, interval_sec=AUTO_UPDATE_POLL_SEC)
    software_scheduler.start()

    def shutdown(*_):
        log.info("shutdown requested")
        scheduler.stop()
        auto_update_scheduler.stop()
        software_scheduler.stop()
        service.router_updates.stop()
        failover.stop()
        service.routing.stop()
        service.route_checks.stop()
        # serve_forever runs on this thread; shutdown must run on another one.
        threading.Thread(target=httpd.shutdown,daemon=True,name="http-shutdown").start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    log.info("listening on %s:%d", cfg.listen_host, cfg.listen_port)
    httpd.serve_forever()

if __name__ == "__main__":
    main()
