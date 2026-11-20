import type { ReactNode } from "react";
import type { OperationDto } from "../api/types";
import {
  actionLabel,
  journalLabel,
  operationTarget,
  phaseLabel,
  scopeLabel,
  sourceLabel,
  terminal,
  unresolved,
} from "../operations/policy";
import { formatElapsed } from "./format";
import { Notice } from "./feedback";
export function RouteLabel({
  exit,
  entry,
  empty = "none",
}: {
  exit?: string | null;
  entry?: string | null;
  empty?: string;
}) {
  return <>{exit ? (entry ? `${entry} → ${exit}` : exit) : empty}</>;
}
export function LocationRow({
  name,
  code,
  health,
  latency,
  current = false,
  disabled = false,
  onSelect,
  onCheck,
  marker = "sg-location-" + code,
  checkMarker = "sg-location-check-" + code,
  children,
}: {
  name: string;
  code: string;
  health: string;
  latency: string;
  current?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  onCheck: () => void;
  marker?: string;
  checkMarker?: string;
  children?: ReactNode;
}) {
  return (
    <li className={"t-row" + (current ? " active-row" : "")}>
      <button
        type="button"
        className="loc-select"
        data-marker={marker}
        data-code={marker === "loc-select" ? code : undefined}
        aria-current={current ? "true" : undefined}
        disabled={disabled}
        onClick={onSelect}
      >
        <span className="caret" />
        <span className="name">{name}</span>
        <span className="loc-meta">
          <span className="code">{code}</span>
          {children}
        </span>
        <span className={"health health-" + health}>
          <span className={"health-dot " + health} />
          <span className="health-latency">{latency}</span>
        </span>
      </button>
      <button
        type="button"
        className="probe-btn"
        data-marker={checkMarker}
        aria-label={"check " + code}
        disabled={disabled}
        onClick={onCheck}
      >
        ↻
      </button>
    </li>
  );
}
export function OperationStatus({
  operation,
  elapsed = 0,
  ownIds,
  marker,
  variant,
  children,
}: {
  operation: OperationDto;
  elapsed?: number | null;
  ownIds?: string[];
  marker?: string;
  variant?: "journal";
  children?: ReactNode;
}) {
  const target = operationTarget(operation);
  if (variant === "journal") {
    const fallback = terminal(operation) ? "The result has been confirmed." : "Waiting for the router…";
    return (
      <section aria-live="polite" data-marker={marker} data-phase={operation.phase}>
        <h3>{journalLabel(operation) + (target ? " · " + target : "")}</h3>
        <Notice title={operation.message || fallback} kind={operation.phase === "committed" ? "success" : "neutral"} />
      </section>
    );
  }
  return (
    <section
      className={
        "operation-status" +
        (unresolved(operation) ? " operation-uncertain" : "") +
        (operation.phase === "recovery_failed" ? " operation-recovery" : "")
      }
      data-marker={marker}
      data-phase={marker ? operation.phase : undefined}
    >
      <div className="operation-head">
        <strong className="operation-route">
          {actionLabel(operation) + (target ? ": " + target : "")}
        </strong>
        <span className="operation-source">{sourceLabel(operation, ownIds)}</span>
      </div>
      <div className="operation-progress-row">
        <span className="operation-heading">{phaseLabel(operation.phase)}</span>
        <span className="operation-elapsed">{formatElapsed(elapsed)}</span>
        {!terminal(operation) && !unresolved(operation) ? (
          <progress className="operation-progress" />
        ) : null}
      </div>
      <p className="operation-message">{operation.message}</p>
      <p className="operation-note">{scopeLabel(operation)}</p>
      {children}
    </section>
  );
}
export function PendingUpdateNotice({
  state,
  hasUpdate = false,
  optional = false,
  title,
  details,
  action,
}: {
  state: "applying" | "pending" | "empty" | "current" | "unknown";
  hasUpdate?: boolean;
  optional?: boolean;
  title: string;
  details: readonly string[];
  action?: ReactNode;
}) {
  return (
    <div
      className={
        "pending-config" + (hasUpdate ? " has-update" : "") + (optional ? " optional-update" : "")
      }
      data-marker="pending-active-config"
      data-state={state}
    >
      <div className="pending-config-copy" role="status">
        <b>{title}</b>
        {details.map((detail) => (
          <div
            className="pending-config-detail"
            key={detail}
            data-marker={details.indexOf(detail) > 0 ? "pending-since" : undefined}
          >
            {detail}
          </div>
        ))}
      </div>
      {action}
    </div>
  );
}
/** Stable row structure, with feature-owned editor/policy/actions supplied as slots. */
export function DeviceRow({
  id,
  identity,
  state,
  policy,
  location,
  actions,
  detail,
}: {
  id: string;
  identity: ReactNode;
  state: ReactNode;
  policy: ReactNode;
  location: ReactNode;
  actions: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <article className="policy-device-row" role="listitem" data-marker={"device-" + id}>
      <div className="device-identity">{identity}</div>
      <div className="device-state">{state}</div>
      <div className="policy-cell">{policy}</div>
      <div className="device-location-cell">{location}</div>
      <div className="device-actions">{actions}</div>
      {detail}
    </article>
  );
}
