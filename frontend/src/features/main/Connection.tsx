import { Fragment, useState, type ReactNode } from "react";
import type { StatusDto } from "../../api/types";
import { RouteCheck, serverCheck } from "./RouteCheck";
import { useOperationTracking } from "../../app/AppSessionProvider";
import { formatDateTime } from "../../ui/format";
import { latency, locationHealth, manualMainSwitch, routeName, splitName } from "./model";
import { PendingConfig } from "./PendingConfig";
import { PowerBox } from "./PowerBox";

function RequestedRoute({ status }: { status: StatusDto }) {
  const tracking = useOperationTracking();
  const { operation, blocking } = tracking;
  if (!blocking) return null;
  const requested = manualMainSwitch(tracking)?.requested;
  const target = operation?.target_route;
  const main = [
    "main",
    "switch",
    "apply_failover",
    "apply_pending_reapply",
    "apply_pending_reapply_now",
    "recover_pending_active",
    "xkeen_control",
  ].includes(operation?.kind ?? "");
  const pending =
    operation?.kind === "apply_pending_reapply_now" || operation?.kind === "apply_pending_reapply";
  const code =
    requested?.code ??
    (main ? (target?.exit_code ?? operation?.target_code) : null) ??
    (pending ? status.pending_reapply_code : null);
  if (!code) return null;
  const entry = requested
    ? requested.entry_code
    : target
      ? target.entry_code
      : (operation?.target_entry_code ?? (pending ? status.pending_reapply_entry_code : null));
  const saved = requested ? { exit_name: requested.name, entry_name: requested.entry_name } : target;
  return (
    <div className="main-requested" data-marker="main-requested">
      {`Requested Main: ${routeName(status, code, entry, saved)}`}
    </div>
  );
}

export function Connection({
  status,
  mobile,
  openChecks,
}: {
  status: StatusDto;
  mobile: boolean;
  openChecks: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stopped = status.xkeen_state === "stopped";
  const { active_code, active_entry_code, server_route: server, failover } = status;
  const fixed = server?.mode === "fixed";
  const chain = !!active_entry_code;
  const chainHealth =
    status.active_health?.route_ok === true
      ? "working"
      : status.active_health?.route_ok === false
        ? "failed"
        : "unverified";
  const active = status.available.find((loc) => loc.code === active_code);
  const shown = fixed ? server.location : active;
  const result = serverCheck(status);
  const tcp = fixed ? (result?.tcp ?? null) : active ? locationHealth(active).probe : null;
  const ping = /^hysteria/.test(shown?.protocol || "") ? "unavailable (UDP)" : latency(tcp);
  const live = !fixed && failover?.enabled && failover.active;
  const failed = fixed
    ? result?.ok === false
    : chain
      ? chainHealth === "failed"
      : tcp?.ok === false || (server?.follows_main && result?.ok === false);
  const stale = fixed ? server.unavailable : status.active_status === "stale";
  function outboundState() {
    if (!active_code && !fixed) return "not selected";
    if (stopped) return "halted";
    if (live) return "failover";
    if (failed) return "failed";
    if (stale) return "stale";
    return chain && !fixed ? chainHealth : "routing";
  }
  const state = outboundState();
  const mainRoute = fixed ? server.main_route ?? status.active_route : status.active_route;
  const main = routeName(status, mainRoute?.exit_code ?? active_code, mainRoute?.entry_code ?? active_entry_code, mainRoute);
  const name = splitName(chain && !fixed ? main : shown?.name || active_code || "no location selected");
  const flag = mobile && !name.head.includes("→") && name.head.match(/\p{Regional_Indicator}{2}/u)?.[0];
  const identity = (
    <>
      <span data-marker="active-name">{flag ? name.head.replace(flag, "").trim() : name.head}</span>
      {flag && (
        <span className="mobile-active-flag" aria-hidden="true">
          {flag}
        </span>
      )}
      {name.tier && <span className="tier">{name.tier}</span>}
    </>
  );

  const fields: { label: string; value: ReactNode; marker?: string; className?: string }[] =
    chain && !fixed
      ? [
          { label: "route", value: "home → entry → exit → internet" },
          { label: "status", value: stopped ? "halted" : chainHealth, marker: "chain-health" },
        ]
      : [
          { label: "code", value: shown?.code || active_code || "—" },
          { label: "host", value: shown?.host ?? "—" },
          { label: "port", value: shown?.port || "—" },
          { label: "ping", value: ping, marker: "outbound-ping" },
          {
            label: "status",
            value: state + (live && failover.since ? " · since " + formatDateTime(failover.since) : ""),
            marker: "outbound-status",
          },
        ];
  if (!fixed && !live && failover?.enabled && !failover.suspended) {
    const primaryLocation = status.available.find((loc) => loc.code === failover.whitelist[0]);
    const primary = primaryLocation ? locationHealth(primaryLocation).probe : null;
    fields.push({
      label: "failover",
      value: "armed · primary " + (!primary ? "unchecked" : primary.ok ? "available" : "failed"),
      className: "kv-fo-inactive",
    });
  }
  const values = (
    <dl className="t-active-kv">
      {fields.map((field) => (
        <Fragment key={field.label}>
          <dt title={field.label === "ping" ? "TCP connection latency to the selected location" : undefined}>
            {field.label}
          </dt>
          <dd className={field.className} data-marker={field.marker}>
            {field.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
  const outbound = (wave?: ReactNode) => (
    <div className={"box outbound-box outbound-" + state} data-marker="outbound-box" data-state={state}>
      <div className="box-title">{fixed ? "Server route" : "Main route"}</div>
      <div className="outbound-scope" data-marker="outbound-scope">
        {fixed ? "Server · " + server.device_name : "Confirmed Main"}
      </div>
      <div className="t-active-main">
        {mobile ? (
          <>
            <div className="mobile-active-identity">{identity}</div>
            {wave}
          </>
        ) : (
          identity
        )}
      </div>
      {mobile && (
        <div className="mobile-active-meta">
          {fields
            .filter((f) => ["ping", "status", "failover"].includes(f.label))
            .map((f) => (
              <span key={f.label}>{f.value}</span>
            ))}
        </div>
      )}
      {fixed && (
        <div className="outbound-default" data-marker="outbound-default">
          <span className="outbound-default-label">Main</span>
          <strong>{main}</strong>
          {chain && <span data-marker="chain-health">chain · {chainHealth}</span>}
          <span>devices using Main{failover?.enabled && failover.active ? " · failover" : ""}</span>
        </div>
      )}
      {!mobile && values}
      {server && !server.follows_main && (
        <div className="outbound-check-scope" data-marker="route-check-scope">
          <span>
            {fixed
              ? "Checks: server · Main HTTP unchecked"
              : server.mode === "outside"
                ? "Checks: server outside XKeen · Main HTTP unchecked"
                : "Server unknown · mark it in Devices"}
          </span>
        </div>
      )}
      <RequestedRoute status={status} />
      {failover?.suspended && failover.suspension_reason === "chain_active" && (
        <p className="t-note" data-marker="failover-paused">
          Automatic failover paused · chain active. Settings and whitelist are kept
          {failover.enabled ? "; failover resumes in single mode." : "."}
        </p>
      )}
      {!mobile && <PendingConfig status={status} />}
      <RouteCheck
        detailsOpen={detailsOpen}
        setDetailsOpen={setDetailsOpen}
        status={status}
        mobile={mobile}
        values={values}
        openChecks={openChecks}
      />
    </div>
  );
  return (
    <>
      <div className="row-split" data-mobile-adapted={mobile || undefined}>
        <PowerBox status={status} mobile={mobile} outbound={mobile ? outbound : undefined} />
        {!mobile && outbound()}
      </div>
      {mobile && <PendingConfig status={status} />}
    </>
  );
}
