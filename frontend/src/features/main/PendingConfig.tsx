import type { StatusDto } from "../../api/types";
import { useOperationTracking } from "../../app/AppSessionProvider";
import { useSubscriptionActions } from "../settings/subscription/SubscriptionPanel";
import { ActionButton } from "../../ui/Button";
import { PendingUpdateNotice } from "../../ui/domain";
import { formatDateTime, formatMoscow } from "../../ui/format";
import { routeName } from "./model";

function schedule(status: StatusDto) {
  const config = status.auto_update;
  if (!config?.enabled) return "auto-apply off";
  if (status.xkeen_state === "stopped") return "auto-apply paused while xkeen is stopped";
  if (!config.next_apply_at)
    return config.mode === "daily"
      ? "daily at " + config.daily_time + " · Moscow · waiting for an update"
      : "waiting for an update";
  if (Date.parse(config.next_apply_at) <= Date.now()) return "auto-apply due · waiting for the next check";
  return "auto-apply " + formatMoscow(config.next_apply_at);
}

export function PendingConfig({ status }: { status: StatusDto }) {
  const tracking = useOperationTracking();
  const { applyPending, applying } = useSubscriptionActions();
  const pending =
    !!status.active_code &&
    status.pending_reapply_code === status.active_code &&
    (status.pending_reapply_entry_code ?? null) === (status.active_entry_code ?? null);
  const failed = status.last_update_status === "fail" || (tracking.blocking && !!tracking.operation?.warning);
  const fresh = status.last_update_status === "ok" && !!status.last_update_at && !failed;
  const state = applying
    ? "applying"
    : pending
      ? "pending"
      : !status.active_code
        ? "empty"
        : fresh
          ? "current"
          : "unknown";
  const optional = pending && status.pending_update_kind === "sni";
  const titles = {
    applying: "~ applying config",
    pending: optional ? "optional update · only SNI has changed" : "! update available",
    empty: "— no active config",
    current: "✓ config up to date",
    unknown: "! config freshness unknown",
  };
  const copy = {
    applying: "refresh, apply, then check route",
    pending: schedule(status),
    empty: "select a location to start",
    current: status.server_route?.mode === "fixed" ? "Main + device locations" : "no changes to apply",
    unknown: "refresh the subscription to check for updates",
  };
  let detail = copy[state];
  if (pending && status.active_entry_code)
    detail =
      routeName(status, status.active_code, status.active_entry_code, status.active_route) + " · " + detail;
  if (failed && !applying) detail = "subscription refresh failed · " + detail;
  const details = [detail];
  if (pending && status.pending_reapply_since)
    details.push("update available since " + formatDateTime(status.pending_reapply_since));
  return (
    <PendingUpdateNotice
      state={state}
      hasUpdate={pending}
      optional={optional && !applying}
      title={titles[state]}
      details={details}
      action={
        <ActionButton
          marker="btn-apply-active-config"
          className="t-btn pending-config-btn"
          data-optional={optional || undefined}
          idle={optional ? "apply now" : "apply update"}
          pending="applying"
          busy={applying}
          aria-describedby={tracking.blocking ? "activity-description" : undefined}
          disabled={!pending || tracking.blocking || applying || status.xkeen_state === "stopped"}
          onClick={() => void applyPending()}
        />
      }
    />
  );
}
