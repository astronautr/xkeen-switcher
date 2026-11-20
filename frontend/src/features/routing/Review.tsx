import type { PanelProps } from "./Versions";
import { PendingAction, Panel } from "./parts";
import type { RoutingPreview } from "../../api/types";
import { Notice } from "../../ui/feedback";
import { actions, same, typeInfo } from "./model";

function Review({ preview }: { preview: RoutingPreview }) {
  const restoring = preview.intent === "restore";
  return (
    <>
      <h3>{restoring ? "Restore this routing version" : "Review your changes"}</h3>
      <p className="panel-subtitle">
        {`${preview.changes.length} ${preview.changes.length === 1 ? "rule" : "rules"} affected · compared with the router`}
      </p>
      {preview.validated && (
        <Notice
          kind="success"
          title="Xray validation passed"
          detail="This exact configuration will be applied. A backup is saved first."
        />
      )}
      {preview.validation.map((item, i) => (
        <Notice key={i} title={item.message} kind={item.severity} />
      ))}
      {restoring && preview.has_draft && (
        <Notice
          title="Your draft will be kept"
          detail="It will need to be resolved against the restored version before applying."
        />
      )}
      {preview.changes.map(({ before, after, id, kind, moved, old_position, new_position }) => (
        <section key={id} className="review-item">
          <h3>
            {(after || before)?.title}
            <span className="change-label">{kind}</span>
          </h3>
          {moved && <div className="diff-line moved">{`Position ${old_position} → ${new_position}`}</div>}
          {before && after && before.title !== after.title && (
            <div className="diff-line">{`Name: ${before.title} → ${after.title}`}</div>
          )}
          {before?.action !== after?.action && (
            <div className="diff-line">
              {`Route: ${before ? actions[before.action] : "—"} → ${after ? actions[after.action] : "removed"}`}
            </div>
          )}
          {before?.matchers
            .filter((m) => !after?.matchers.some((item) => same(item, m)))
            .map((m, i) => (
              <div key={i} className="diff-line removed">
                {`− ${typeInfo(m.type)[1]}: ${m.value}`}
              </div>
            ))}
          {after?.matchers
            .filter((m) => !before?.matchers.some((item) => same(item, m)))
            .map((m, i) => (
              <div key={i} className="diff-line added">
                {`+ ${typeInfo(m.type)[1]}: ${m.value}`}
              </div>
            ))}
          {!!before?.matchers.length && after && !after.matchers.length && (
            <div className="diff-line moved">
              Now matches all remaining redirect/tproxy traffic at this position.
            </div>
          )}
        </section>
      ))}
      {!preview.changes.length && (
        <p>No editable rule changes. Restoring also replaces comments and settings outside this editor.</p>
      )}
      <p className="field-hint">Only routing changes. Your active proxy location stays selected.</p>
    </>
  );
}

export function PreviewPanel({
  preview,
  disabled,
  apply,
  applying,
  ...panel
}: PanelProps & { preview: RoutingPreview; disabled: boolean; applying: boolean; apply: () => void }) {
  return (
    <Panel
      {...panel}
      title={preview.intent === "restore" ? "review restore" : "review"}
      links={
        preview.intent === "restore"
          ? [
              {
                label: "versions",
                marker: "breadcrumb-versions",
                click: () => panel.go("#routing" + "/history"),
              },
              {
                label: "version",
                marker: "breadcrumb-version",
                click: () => panel.go("#routing" + "/snapshot/" + preview.source_snapshot),
              },
            ]
          : []
      }
      footer={
        <>
          <span className="footer-copy">XKeen will restart. Connections may briefly drop.</span>
          <PendingAction marker="review-apply" primary disabled={disabled} onClick={apply}
            idle={preview.intent === "restore" ? "restore and restart" : "apply and restart"}
            pending={preview.intent === "restore" ? "restoring" : "applying"} busy={applying} />
        </>
      }
    >
      <Review preview={preview} />
    </Panel>
  );
}
