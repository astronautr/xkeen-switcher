import { useState } from "react";
import type { OperationDto } from "../../api/types";
import { useRoutingEditorAccess } from "../../api/queries";
import { useRoutingActions } from "../../app/AppSessionProvider";
import { terminal } from "../../operations/policy";
import { OperationStatus } from "../../ui/domain";
import { Notice } from "../../ui/feedback";
import type { PanelProps } from "./Versions";
import { Action, Panel, PendingAction } from "./parts";

export function Progress({
  id,
  operation,
  perform,
  hasError,
  ...panel
}: PanelProps & {
  id: string;
  operation?: OperationDto;
  hasError: boolean;
  perform: (task: () => Promise<void>, freeze?: boolean) => Promise<void>;
}) {
  const access = useRoutingEditorAccess();
  const actions = useRoutingActions();
  const [running, setRunning] = useState<"check" | "retry" | null>(null);
  async function run(action: "check" | "retry") {
    setRunning(action);
    try {
      await perform(async () => {
        if (action === "check") await access.readOperation(id);
        else await actions.retry();
      }, action === "check");
    } finally {
      setRunning(null);
    }
  }
  return (
    <Panel
      {...panel}
      title="progress"
      footer={
        <>
          <span className="footer-copy">
            {terminal(operation) ? "Operation finished" : "Closing this panel does not cancel the operation."}
          </span>
          <PendingAction marker="operation-refresh" primary
            idle={terminal(operation) ? "back to rules" : "check again"} pending="checking"
            busy={running === "check"} disabled={running !== null}
            onClick={() => terminal(operation) ? panel.close() : void run("check")} />
        </>
      }
    >
      {operation ? (
        <>
          <OperationStatus variant="journal" operation={operation} marker="routing-operation-status" />
          {operation.phase === "recovery_failed" && (
            <Notice
              title="Recovery has not been confirmed"
              detail="New changes stay paused until the router confirms a configuration. Your backup is available in versions."
              kind="error"
            />
          )}
          {["unknown", "boot_restored"].includes(operation.phase) && (
            <Notice title="Result not confirmed yet"
              detail="The server keeps checking. New changes stay paused; your backup is available in versions." />
          )}
          {operation.phase === "rolled_back" && (
            <Notice
              title="The previous configuration was restored"
              detail="The change did not pass its startup check. Your draft is kept."
            />
          )}
          {operation.not_received && actions.canRetry() && access.pending()?.operation_id === id && (
            <PendingAction primary marker="operation-retry"
              idle="retry this request" pending="retrying" busy={running === "retry"}
              disabled={running !== null} onClick={() => void run("retry")} />
          )}
        </>
      ) : (
        !hasError && <Notice title="Checking operation status…" />
      )}
      <Action marker="operation-versions" onClick={() => panel.go("#routing/history")}>
        versions
      </Action>
    </Panel>
  );
}
