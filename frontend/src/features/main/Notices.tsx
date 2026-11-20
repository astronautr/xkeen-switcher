import type { ReactNode } from "react";
import type { StatusDto } from "../../api/types";
import { useMainActions, useOperationTracking } from "../../app/AppSessionProvider";
import { useXkeenControl } from "../../api/mutations";
import { actionLabel } from "../../operations/policy";
import { ActionButton, Button } from "../../ui/Button";
import { formatAgo } from "../../ui/format";
import { useSubscriptionActions } from "../settings/subscription/SubscriptionPanel";
import { healthProbe, routeName, splitName } from "./model";
import { useActionFeedback } from "./common";

function Banner({
  marker,
  tone,
  prefix,
  children,
  action,
}: {
  marker: string;
  tone: string;
  prefix: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={"banner " + tone} data-marker={marker} role="status">
      <span className="banner-pfx">{prefix}</span>
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Offline({ updated, retry }: { updated: number; retry: () => void }) {
  return (
    <Banner
      marker="offline-state"
      tone="danger offline-state"
      prefix="[offline]"
      action={
        <Button marker="offline-retry" variant="bracket" className="banner-action" onClick={retry}>
          retry
        </Button>
      }
    >
      {`No response from the server. Showing the last known state. Last update ${updated ? formatAgo(updated) : "unknown"}.`}
    </Banner>
  );
}

export function Notices({ status: d, openFailover }: { status: StatusDto; openFailover: () => void }) {
  const { refusal, blocking, operation } = useOperationTracking();
  const { switchTo, dismissRefusal } = useMainActions();
  const power = useXkeenControl();
  const feedback = useActionFeedback();
  const sub = useSubscriptionActions();
  const fo = d.failover;
  const primary = d.available.find((loc) => loc.code === fo?.whitelist[0]);
  const probe = healthProbe(primary?.health);
  const primaryName = splitName(primary?.name || fo?.whitelist[0] || "").head;
  const missing = d.active_missing_codes
    ?.map((code) =>
      code === d.active_entry_code
        ? "entry " + (d.active_route?.entry_name || code)
        : "exit " + (d.active_route?.exit_name || code),
    )
    .join(" and ");
  let failover: ReactNode = null;
  if (!fo?.suspended) {
    if (d.xkeen_stop_cause === "failover") {
      failover = fo?.auto_restart_on_recovery ? (
        <Banner
          marker="banner-waiting"
          tone="info"
          prefix="[waiting]"
          action={<span className="banner-probing">checking TCP</span>}
        >
          XKeen off · starts again when any failover location recovers
        </Banner>
      ) : (
        <Banner
          marker="banner-stopped"
          tone="danger"
          prefix="[stopped]"
          action={
            <ActionButton
              marker="btn-xkeen-start"
              idle="start xkeen"
              pending="starting"
              busy={power.isPending}
              className="ui-button banner-action"
              disabled={blocking || power.isPending}
              aria-describedby={blocking ? "activity-description" : undefined}
              onClick={() => void feedback(power.mutateAsync({ action: "start" }), () => "XKeen started")}
            />
          }
        >
          All failover locations unreachable · XKeen stopped
        </Banner>
      );
    } else if (fo?.active && fo.enabled) {
      failover = (
        <Banner
          marker="banner-on-fallback"
          tone="failover"
          prefix="[failover]"
          action={
            primary &&
            probe?.ok && (
              <Button
                marker="btn-failback"
                variant="bracket"
                className="banner-action"
                disabled={blocking}
                aria-describedby={blocking ? "activity-description" : undefined}
                onClick={() => switchTo({ code: primary.code, entry_code: null })}
              >
                {`return to ${primaryName}`}
              </Button>
            )
          }
        >
          {`Main on ${routeName(d, d.active_code)} · preferred ${primaryName} ${probe ? (probe.ok ? "available" : "failed") : "not checked"}`}
        </Banner>
      );
    } else if (fo?.enabled && !fo.whitelist.length) {
      failover = (
        <Banner
          marker="banner-empty-wl"
          tone="warn"
          prefix="[warn]"
          action={
            <Button
              marker="btn-open-failover"
              className="banner-action"
              variant="bracket"
              onClick={openFailover}
            >
              choose locations
            </Button>
          }
        >
          Failover is on but has no locations
        </Banner>
      );
    } else if (fo?.enabled && d.active_code && !fo.whitelist.includes(d.active_code)) {
      failover = (
        <Banner marker="banner-offlist" tone="warn" prefix="[warn]">
          {`Main ${routeName(d, d.active_code)} is not a failover location · failover inactive`}
        </Banner>
      );
    }
  }
  return (
    <>
      {refusal?.route && !blocking && (
        <Banner
          marker="switch-refusal"
          tone="warn"
          prefix="[not applied]"
          action={
            <Button
              marker="switch-refusal-dismiss"
              variant="bracket"
              className="banner-action"
              onClick={dismissRefusal}
            >
              dismiss
            </Button>
          }
        >
          {`Switch to ${routeName(d, refusal.route.exit_code, refusal.route.entry_code, refusal.route)} was not accepted${refusal.blocker ? " while " + actionLabel(refusal.blocker).toLowerCase() + " was running" : ""}. Choose it again when ready.`}
        </Banner>
      )}
      {d.active_status === "stale" && (
        <div className="banner danger" data-marker="banner-stale-active">
          {`${missing || "Active location"} disappeared from the subscription. Installed route left unchanged · choose a new route.`}
        </div>
      )}
      {failover}
      {d.last_update_status === "fail" && d.subscription_url && d.last_update_at && (
        <Banner
          marker="banner-stale"
          tone="warn"
          prefix="[warn]"
          action={
            <ActionButton
              marker="banner-refresh"
              className="ui-button banner-action"
              idle="refresh subscription"
              pending="refreshing"
              busy={operation?.kind === "update" && blocking}
              disabled={blocking || sub.refreshing}
              aria-describedby={blocking ? "activity-description" : undefined}
              onClick={() => void sub.refresh()}
            />
          }
        >
          {`Subscription refresh failed · last success ${formatAgo(d.last_update_at)} · locations may be outdated`}
        </Banner>
      )}
    </>
  );
}
