import { type ReactNode } from "react";
import type { RouteCheckDto, StatusDto } from "../../api/types";
import { useCheckRoute } from "../../api/mutations";
import { useOperationTracking } from "../../app/AppSessionProvider";
import { ActionButton } from "../../ui/Button";
import { useActionFeedback } from "./common";
import { MobileIcon } from "../../ui/mobile";

export function serverCheck(status: StatusDto): Partial<RouteCheckDto> | null {
  if (status.server_route) return status.server_route.check as Partial<RouteCheckDto> | null;
  const health = status.active_health;
  if (!health?.route_checked_at || typeof health.route_ok !== "boolean") return null;
  return {
    tcp:
      typeof health.tcp_ok === "boolean"
        ? { ok: health.tcp_ok, latency_ms: health.tcp_latency_ms ?? health.last_latency_ms ?? null }
        : null,
    route: { ok: health.route_ok, results: health.route_results ?? [] },
  };
}

function checkSummary(check: Partial<RouteCheckDto> | null) {
  if (!check)
    return {
      state: "unknown",
      text: "Server route not checked · HTTP(S) is healthy if any configured resource works",
    };
  const { tcp, route, active_after, active_code } = check;
  const results = route?.results ?? [];
  const ok = (!tcp || tcp.ok) && (results.length ? results.some((item) => item.ok) : route?.ok);
  const parts: string[] = [];
  if (tcp) parts.push("tcp " + (tcp.ok ? (tcp.latency_ms == null ? "ok" : tcp.latency_ms + "ms") : "failed"));
  for (const item of results) {
    const detail = item.ok
      ? (item.status || "ok") + (item.latency_ms == null ? "" : " · " + item.latency_ms + "ms")
      : item.error || (item.status ? "HTTP " + item.status : "failed");
    parts.push(item.name + " " + detail);
  }
  if (!results.length && route?.error) parts.push(route.error);
  if (active_after && active_after !== active_code) parts.push("switched to " + active_after);
  return {
    state: ok ? "ok" : "fail",
    text: "server route " + (ok ? "ok" : "failed") + " · " + parts.join(" · "),
  };
}

type Props = {
  status: StatusDto;
  mobile: boolean;
  values: ReactNode;
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
  openChecks: () => void;
};
export function RouteCheck({ status, mobile, values, openChecks, detailsOpen, setDetailsOpen }: Props) {
  const tracking = useOperationTracking();
  const check = useCheckRoute();
  const feedback = useActionFeedback();
  const stopped = status.xkeen_state === "stopped";
  const active_code = status.active_code;
  const result = serverCheck(status);
  const summary = checkSummary(result);
  const caption = <p className="power-caption">proxy client</p>;
  const checkButton = (
    <ActionButton
      marker="btn-route-check"
      className="t-btn route-check-btn"
      idle="check server route"
      pending="checking"
      disabled={tracking.blocking || check.isPending || stopped || !active_code}
      busy={check.isPending}
      aria-describedby={tracking.blocking ? "activity-description" : undefined}
      onClick={() =>
        void feedback(
          check.mutateAsync({}),
          (body) =>
            (body.scope === "server" ? "server route" : "current route") +
            (body.ok ? " works" : " failed") +
            (body.active_after && body.active_after !== body.active_code
              ? " · switched to " + body.active_after
              : ""),
          (body) => !body.ok,
        )
      }
    />
  );
  const edit = (
    <button
      type="button"
      data-ui-variant="bracket"
      data-marker="btn-edit-route-check"
      className="t-btn route-edit-btn"
      onClick={openChecks}
    >
      edit test sites
    </button>
  );
  const report = result ? (
    <div
      className={"route-check-result " + summary.state}
      data-marker="route-check-result"
      data-state={summary.state}
    >
      {summary.text}
    </div>
  ) : (
    <div className="route-check-note">{summary.text}</div>
  );
  return (
    <>
      {mobile && (
        <div
          className={"mobile-route-status " + summary.state}
          role="status"
          data-marker="mobile-route-status"
        >
          {summary.state === "ok"
            ? "✓ server route healthy"
            : summary.state === "fail"
              ? "! server route failed"
              : "server route not checked"}
        </div>
      )}
      <div className="route-check">
        {mobile ? (
          <>
            {checkButton}
            <details
              className="mobile-connection-details"
              open={detailsOpen}
              onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
            >
              <summary className="mobile-details-toggle" data-marker="mobile-connection-details">
                details
                <MobileIcon name="chevron" />
              </summary>
              <div className="mobile-details-body">
                {values}
                {report}
                {edit}
                {caption}
              </div>
            </details>
          </>
        ) : (
          <>
            <div className="route-check-actions">
              {checkButton}
              {edit}
            </div>
            {report}
          </>
        )}
      </div>
    </>
  );
}
