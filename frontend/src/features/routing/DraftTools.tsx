import { useDiscardRoutingDraft, useReimportRouting } from "../../api/mutations";
import type { RoutingDto } from "../../api/types";
import { Action, Panel } from "./parts";
import type { PanelProps } from "./Versions";

export function DraftTools({
  view,
  info,
  count,
  blocked,
  download,
  refresh,
  finish,
  confirmAction,
  perform,
  ...panel
}: PanelProps & {
  view: "more" | "discard" | "conflict";
  info: RoutingDto;
  count: number;
  blocked: boolean;
  download: () => void;
  refresh: () => Promise<unknown>;
  finish: (message: string) => void;
  confirmAction: (message: string, label: string, action: () => void) => void;
  perform: (task: () => Promise<void>) => Promise<void>;
}) {
  const discard = useDiscardRoutingDraft();
  const reimport = useReimportRouting();
  const draft = info.draft;
  function discardDraft() {
    if (!draft) return;
    void perform(async () => {
      await discard.mutateAsync({ expected_revision: draft.revision });
      finish("Draft discarded. Router unchanged.");
    });
  }
  function resolve() {
    confirmAction(
      "Discard the saved draft and load the router version?",
      "discard and reload",
      () =>
        void perform(async () => {
          if (draft) await discard.mutateAsync({ expected_revision: draft.revision });
          await reimport.mutateAsync({
            expected_current_hash: info.current.sha256,
            observed_hash: info.observed_hash,
          });
          finish("Router configuration loaded.");
        }),
    );
  }
  if (view === "discard")
    return (
      <Panel
        {...panel}
        title="discard draft"
        footer={
          <>
            <Action marker="keep-draft" onClick={panel.close}>
              keep draft
            </Action>
            <Action marker="discard-draft-confirm" disabled={!draft || blocked} onClick={discardDraft}>
              discard draft
            </Action>
          </>
        }
      >
        <h3>Discard all pending changes?</h3>
        <p>{count} affected rules will return to the saved router version.</p>
      </Panel>
    );
  if (view === "conflict")
    return (
      <Panel
        {...panel}
        title="resolve changes"
        footer={
          <Action marker="conflict-close" onClick={panel.close}>
            close
          </Action>
        }
      >
        <h3>Load the current router configuration</h3>
        <p className="panel-subtitle">
          Rules cannot be merged automatically. Export your draft before replacing its base.
        </p>
        <Action marker="conflict-download" disabled={!draft} onClick={download}>
          1. download draft
        </Action>
        <Action marker="conflict-reload" disabled={blocked} onClick={resolve}>
          2. discard draft and reload
        </Action>
      </Panel>
    );
  return (
    <Panel
      {...panel}
      title="more"
      footer={<span className="footer-copy">Tools for the current configuration</span>}
    >
      <Action
        marker="refresh-status"
        onClick={() =>
          void perform(async () => {
            await refresh();
            finish("Routing status refreshed.");
          })
        }
      >
        refresh status
      </Action>
      <p className="panel-subtitle">Check whether the router configuration has changed.</p>
      <Action marker="download-draft" disabled={!draft} onClick={download}>
        download draft
      </Action>
      <p className="panel-subtitle">Export a copy of your pending edits.</p>
    </Panel>
  );
}
