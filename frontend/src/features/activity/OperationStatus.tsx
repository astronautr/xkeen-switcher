import type { MainIntent, OperationDto, StatusDto } from "../../api/types";
import { actionLabel, elapsedSince, phaseLabel, scopeLabel, sourceLabel, unresolved } from "../../operations/policy";
import { formatElapsed } from "../../ui/format";
import { routeName } from "../main/model";

const mainOperations = new Set([
  "main", "switch", "apply_pending_reapply", "apply_pending_reapply_now", "recover_pending_active", "xkeen_control",
]);

function targetName(status: StatusDto, operation: OperationDto, main: boolean) {
  const target = operation.target_route;
  if (target) return routeName(status, target.exit_code, target.entry_code, target);
  if (main && operation.target_code) {
    return routeName(status, operation.target_code, operation.target_entry_code, { exit_name: operation.target_name });
  }
  return operation.target_name || operation.target_code;
}

type OperationStatusProps = {
  status: StatusDto;
  operation: OperationDto;
  requested: MainIntent | null;
  own: boolean;
};

function RouteChecksStatus({ operation, own, status }: Omit<OperationStatusProps, "requested">) {
  const progress = operation.progress as { done: number; total: number } | undefined;
  const elapsed = elapsedSince(operation);
  return (
    <section className="operation-status" aria-label="Current operation" data-marker="operation-status"
      data-phase={operation.phase} data-operation-id="" data-blocking="false" data-source="manual">
      <div className="operation-head">
        <strong className="operation-route" data-marker="operation-route">{actionLabel(operation)}{operation.target_name && " · " + operation.target_name}</strong>
        <span className="operation-source" data-marker="operation-source">{own ? "This browser" : "Router"}</span>
      </div>
      <div className="operation-progress-row">
        <span className="operation-heading" data-marker="operation-phase">{operation.message}</span>
        {elapsed !== null && (
          <span className="operation-elapsed" aria-hidden="true" data-marker="operation-elapsed">{formatElapsed(elapsed)}</span>
        )}
        <progress className="operation-progress" aria-label={operation.message} data-marker="operation-progress"
          value={progress?.done} max={progress?.total || 1} />
      </div>
      <p className="operation-note" data-marker="operation-scope">
        {scopeLabel(operation)}{status.available.length > 0 && " Open Find a working route on Main for results."}
      </p>
    </section>
  );
}

export function OperationStatus({ status, operation, requested, own }: OperationStatusProps) {
  if (operation.kind === "route_checks") return <RouteChecksStatus operation={operation} own={own} status={status} />;
  const main = operation.kind ? mainOperations.has(operation.kind) : !!requested && requested.id === operation.id;
  const target = targetName(status, operation, main);
  const confirmed = operation.confirmed_route || status.active_route;
  const confirmedName = confirmed
    ? routeName(status, confirmed.exit_code, confirmed.entry_code, confirmed)
    : routeName(status, status.active_code, status.active_entry_code);
  const source = own ? "This browser" : sourceLabel(operation);
  const uncertain = unresolved(operation);
  const elapsed = elapsedSince(operation);
  const stage = phaseLabel(operation.phase) + (operation.warning ? " · saved config" : "");
  const targetLabel = main ? "Main location" : operation.kind === "device-location" ? "device location" : "location";
  const local = operation.local || (operation.ephemeral && own);
  const classes = ["operation-status"];
  if (uncertain) classes.push("operation-uncertain");
  if (operation.phase === "recovery_failed") classes.push("operation-recovery");

  return (
    <section
      id="location-operation"
      className={classes.join(" ")}
      aria-label="Current operation"
      data-marker="operation-status"
      data-phase={operation.phase}
      data-operation-id={operation.id || ""}
      data-blocking={operation.blocking !== false}
      data-source={operation.source || "manual"}
    >
      <div className="operation-head">
        <strong className="operation-route" data-marker="operation-route">
          {target ? `${actionLabel(operation)}: ${target}` : actionLabel(operation)}
        </strong>
        <span className="operation-source" data-marker="operation-source">{source}</span>
      </div>
      <div className="operation-progress-row">
        <span className="operation-heading" data-marker="operation-phase">{stage}</span>
        {elapsed !== null && (
          <span className="operation-elapsed" aria-hidden="true" data-marker="operation-elapsed">
            {formatElapsed(elapsed)}
          </span>
        )}
        {!uncertain && <progress className="operation-progress" aria-label={stage} data-marker="operation-progress" />}
      </div>
      <p className="operation-message" data-marker="operation-message">
        {operation.message || "The server is checking the result."}
      </p>
      {target && (
        <p className="operation-target" data-marker="operation-target">{`Requested ${targetLabel}: ${target}`}</p>
      )}
      {target && main && (
        <p className="operation-confirmed" data-marker="operation-confirmed">{`Last confirmed Main location: ${confirmedName}`}</p>
      )}
      {operation.warning && <p className="operation-warning" data-marker="operation-warning">{operation.warning}</p>}
      {operation.blocking !== false && (
        <p className="operation-note" data-marker="operation-scope">
          {scopeLabel(operation) + (local ? "" : " You can close this page; the server continues.")}
        </p>
      )}
      {uncertain && operation.id && !operation.ephemeral && (
        <a
          className="operation-details"
          data-marker="operation-details"
          href={"#routing/operation/" + encodeURIComponent(operation.id)}
        >
          {operation.phase === "recovery_failed" ? "recovery details" : "operation details"}
        </a>
      )}
    </section>
  );
}
