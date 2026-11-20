import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../../api/keys";
import { useStatus } from "../../../api/queries";
import { useApplyPending, useRefreshSubscription, useSaveSubscriptionUrl } from "../../../api/mutations";
import { ApiError, classifyError, StaleSessionError } from "../../../api/client";
import type { StatusDto } from "../../../api/types";
import { useNotifications, useOperationTracking } from "../../../app/AppSessionProvider";
import { actionLabel } from "../../../operations/policy";
import { ActionButton, Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { MobileIcon, useMobile } from "../../../ui/mobile";
import { errorMessage, formatDateTime, formatTime } from "../../../ui/format";
import { routeName } from "../../main/model";
import { Chevron } from "../../../ui/Chevron";

/** Main supplies pending-banner placement and calls this action without copying state. */
export function useSubscriptionActions() {
  const refresh = useRefreshSubscription();
  const apply = useApplyPending();
  const { publish } = useNotifications();
  const cache = useQueryClient();
  async function run(action: "refresh" | "apply") {
    try {
      if (action === "apply") {
        await apply.mutateAsync({});
        const status = cache.getQueryData<StatusDto>(keys.status);
        const name = status ? routeName(status, status.active_code, status.active_entry_code, status.active_route) : "none";
        publish("Configuration update applied · Main " + name);
        return;
      }
      const result = await refresh.mutateAsync({});
      const status = cache.getQueryData<StatusDto>(keys.status);
      let message = "subscription refreshed · " + (status?.available.length ?? 0) + " locations";
      if (result.recovery_attempted) {
        if (result.recovered) message += " · switched to " + result.recovery_active_after;
        else if (result.recovery_active_after) message += " · no working route · left on " + result.recovery_active_after;
        else message += " · no TCP-reachable location";
      }
      publish(message, Boolean(result.recovery_attempted && !result.recovered));
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      const label = action === "apply" ? "Configuration update" : "Subscription refresh";
      const kind = classifyError(failure instanceof ApiError ? failure : {});
      if (kind === "unknown") {
        publish(label + ": result not confirmed. Reloading the current state.", true);
      } else {
        const prefix = kind === "busy" ? " not started · router busy" : " failed";
        const blocker = failure instanceof ApiError && failure.operation ? " (" + actionLabel(failure.operation) + ")" : "";
        publish(label + prefix + ": " + errorMessage(failure) + blocker, true);
      }
    }
  }
  return {
    refresh: () => run("refresh"),
    applyPending: () => run("apply"),
    refreshing: refresh.isPending,
    applying: apply.isPending,
  };
}

export function SubscriptionPanel() {
  const mobile = useMobile();
  const { data } = useStatus();
  const operation = useOperationTracking();
  const actions = useSubscriptionActions();
  const save = useSaveSubscriptionUrl();
  const { publish } = useNotifications();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!data) return null;
  const value = draft ?? data.subscription_url ?? "";
  const dirty = draft !== null && draft.trim() !== (data.subscription_url ?? "");
  const busy = operation.blocking || actions.refreshing || actions.applying || save.isPending;
  const refreshLabel = mobile ? (actions.refreshing ? "Refreshing subscription" : "Refresh subscription") : undefined;
  const cachedWarning = operation.blocking && !!operation.operation?.warning;
  const fresh = data.last_update_status === "ok" && !!data.last_update_at && !cachedWarning;
  const label = !data.subscription_url ? "not configured"
    : data.last_update_status === "fail" ? "refresh failed"
    : cachedWarning ? "stale" : fresh ? "fresh" : data.last_update_at ? "stale" : "never synced";
  const updated = data.last_update_at && new Date(data.last_update_at).toDateString() === new Date().toDateString()
    ? formatTime(data.last_update_at) : formatDateTime(data.last_update_at);
  async function submit() {
    if (!dirty || busy) return;
    setError("");
    try {
      await save.mutateAsync({ url: value.trim() });
      setDraft(null);
      publish("Subscription URL saved and refreshed");
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      const message = errorMessage(failure, "Could not save subscription.");
      setError(message);
      publish(message, true);
    }
  }
  return (
    <section className="box subscription-panel" aria-label="Subscription" data-marker="subscription-panel">
      <div className="box-title">subscription</div>
      <div className="subscription-row">
        <Button marker="subscription-toggle" className="subscription-toggle ui-disclosure" aria-expanded={expanded}
          aria-controls="subscription-editor" aria-label={`Subscription: ${label}. Edit subscription URL`}
          onClick={() => setExpanded(!expanded)}>
          <span className={`subscription-status${fresh ? " fresh" : ""}`}>
            <span className="subscription-dot" aria-hidden="true" /><span>{label}</span>
          </span>
          <span className="subscription-meta"><span>{`${data.available.length} locations`}</span>
            <span title={data.last_update_at ? formatDateTime(data.last_update_at) : "No successful subscription refresh"} data-marker="subscription-last-success">
              {data.last_update_at ? `last success ${updated}` : "no successful refresh"}
            </span>
          </span>
          <Chevron className="ui-disclosure-chevron" direction={expanded ? "down" : "right"} />
        </Button>
        <ActionButton marker="btn-update-sub" className={"t-btn subscription-refresh-btn" + (mobile ? " mobile-icon-button" : "")}
          icon={mobile && <MobileIcon name="refresh" />} data-mobile-icon={mobile ? "refresh" : undefined}
          aria-label={refreshLabel} title={refreshLabel}
          aria-describedby={operation.blocking ? "activity-description" : undefined}
          idle="refresh" pending="refreshing"
          busy={actions.refreshing} disabled={busy || !data.subscription_url} onClick={() => void actions.refresh()} />
      </div>
      <form id="subscription-editor" className="subscription-editor" data-marker="subscription-editor" hidden={!expanded}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="auto-update-label" htmlFor="subscription-home-url">subscription URL</label>
        <div className="subscription-input-row t-field">
          <Field marker="subscription-home-url" id="subscription-home-url" type="text" inputMode="url" required
            pattern={"\\s*https?://\\S+\\s*"} title="Enter an http:// or https:// subscription URL"
            placeholder="https://…" autoComplete="off" spellCheck={false} autoCapitalize="none"
            disabled={save.isPending} value={value} onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError("");
            }} />
          <ActionButton marker="subscription-home-save" idle="save" pending="saving" busy={save.isPending} className="ui-button t-btn subscription-save-btn" type="submit"
            aria-describedby={operation.blocking ? "activity-description" : undefined}
            disabled={busy || !dirty || !value.trim()} />
        </div>
        {error && <p className="g-err" role="alert">{error}</p>}
      </form>
    </section>
  );
}
