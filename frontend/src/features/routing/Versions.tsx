import { useState, type ComponentProps } from "react";
import { useRoutingHistory, useRoutingSnapshot } from "../../api/queries";
import { useDownloadSnapshot } from "../../api/mutations";
import { Notice } from "../../ui/feedback";
import { formatDateTime, errorMessage } from "../../ui/format";
import type { SnapshotDto } from "../../api/types";
import { journalLabel } from "../../operations/policy";
import { actions, saveBlob, summary } from "./model";
import { Panel, Action, PendingAction } from "./parts";
export type PanelProps = Pick<
  ComponentProps<typeof Panel>,
  "go" | "close" | "feedback" | "confirm"
>;
function label(snapshot: Omit<SnapshotDto, "model">, current: string, original: boolean) {
  if (snapshot.id === current) return "On router";
  if (original) return "Original configuration · pinned";
  const labels: Record<string, string> = {
    "pre-apply": "Before change",
    apply: "Applied configuration",
    restore: "Restored configuration",
    reimport: "Imported from router",
  };
  return labels[snapshot.source ?? ""] ?? "Saved version";
}
export function Versions({ current, ...panel }: PanelProps & { current: string }) {
  const history = useRoutingHistory(true, true);
  return (
    <Panel
      {...panel}
      title="versions"
      footer={<span className="footer-copy">Original + up to 50 recent versions</span>}
    >
      <p className="panel-subtitle">Open a saved configuration to inspect, download or restore it.</p>
      {history.error && (
        <Notice
          title={errorMessage(history.error)}
          actions={
            <Action marker="history-retry" onClick={() => void history.refetch()}>
              try again
            </Action>
          }
        />
      )}
      {history.data?.snapshots.map((v) => (
        <button
          className="version-row"
          type="button"
          data-marker={"version-" + v.id}
          key={v.id}
          onClick={() => panel.go("#routing/snapshot/" + v.id)}
        >
          <strong>{label(v, current, v.original)}</strong>
          <span>{formatDateTime(v.created_at)}</span>
        </button>
      ))}
      {!!history.data?.operations.length && <h3>Recent operations</h3>}
      {history.data?.operations.map((op) => (
        <Action
          key={op.id}
          marker={"history-operation-" + op.id}
          onClick={() => panel.go("#routing/operation/" + op.id)}
        >
          {journalLabel(op) + " · " + formatDateTime(op.created_at)}
        </Action>
      ))}
    </Panel>
  );
}
export function Snapshot({
  id,
  current,
  blocked,
  restore,
  reviewing,
  ...panel
}: PanelProps & { id: string; current: string; blocked: boolean; reviewing: boolean; restore: () => void }) {
  const snapshot = useRoutingSnapshot(id);
  const history = useRoutingHistory(false);
  const file = useDownloadSnapshot();
  const [downloading, setDownloading] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const version = snapshot.data;
  async function load(download: boolean) {
    if (download) setDownloading(true);
    try {
      const blob = await file.mutateAsync({ id });
      if (download) saveBlob(blob, "05_routing-" + id + ".json");
      else setRaw(await blob.text());
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      if (download) setDownloading(false);
    }
  }
  const title = version
    ? label(
        version,
        current,
        !!history.data?.snapshots.find((v) => v.id === id)?.original || version.source === "initial-import",
      )
    : "version";
  const back = () => panel.go("#routing/history");
  return (
    <Panel
      {...panel}
      title={title}
      links={[{ label: "versions", marker: "breadcrumb-versions", click: back }]}
      footer={
        <>
          <Action marker="version-back" onClick={back}>
            back to versions
          </Action>
          <PendingAction
            marker="version-restore"
            idle="review restore"
            pending="validating"
            busy={reviewing}
            primary
            disabled={blocked || id === current || !version}
            onClick={restore}
          />
        </>
      }
    >
      {error || snapshot.error ? <Notice title={errorMessage(error || snapshot.error)} /> : null}
      {version && (
        <>
          <h3>{title}</h3>
          <p className="panel-subtitle">{formatDateTime(version.created_at)}</p>
          <PendingAction marker="version-download" disabled={file.isPending} onClick={() => void load(true)}
            idle="download original file" pending="downloading" busy={downloading} />
          <p className="field-hint">Original bytes, including comments and line endings.</p>
          {version.parse_error && <Notice title="Cannot display these rules" detail={version.parse_error} />}
          {version.model?.groups.map((rule, i) => (
            <section key={rule.id} className="review-item">
              <h3>
                {i + 1}. {rule.title}
              </h3>
              <div className="diff-line">{actions[rule.action] ?? rule.action}</div>
              <div className="muted">{summary(rule)}</div>
            </section>
          ))}
          <details
            onToggle={(e) => {
              if (e.currentTarget.open && raw === null) void load(false);
            }}
          >
            <summary data-marker="version-raw">original file</summary>
            <pre className="raw-preview">
              {raw ??
                (error ? "Could not load the file. Close and reopen to retry." : "Loading original file…")}
            </pre>
          </details>
        </>
      )}
    </Panel>
  );
}
