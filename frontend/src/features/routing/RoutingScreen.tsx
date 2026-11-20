import "./layout.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, StaleSessionError, classifyError } from "../../api/client";
import { usePreviewRouting, useSaveRoutingDraft } from "../../api/mutations";
import { useOperation, useRouting, useRoutingEditorAccess, useRoutingEditorPolling } from "../../api/queries";
import { isRecord, type RoutingGroup, type RoutingPreview } from "../../api/types";
import { useNotifications, useOperationTracking, useRoutingActions } from "../../app/AppSessionProvider";
import { actionLabel, journalLabel, sourceLabel, terminal } from "../../operations/policy";
import { ConfirmStrip, Notice } from "../../ui/feedback";
import { errorMessage } from "../../ui/format";
import { useRuleForm } from "./useRuleForm";
import { RuleEditor } from "./RuleEditor";
import { Rules } from "./Rules";
import { Progress } from "./Progress";
import { DraftTools } from "./DraftTools";
import { PreviewPanel } from "./Review";
import { Snapshot, Versions } from "./Versions";
import { baseOf, buildRule, changes, fields, outdated, same, saveBlob, type Base, type Form } from "./model";
import { useRoutingNavigation } from "./navigation";
import { Action, Breadcrumbs, PendingAction } from "./parts";

const SAVING_RULE = "Saving the rule";
type Confirmation = { message: string; label: string; action: () => void };
type Order = Base & { groups: RoutingGroup[]; original: string[] };
const ROOT = "#routing";
export function RoutingScreen({ hash }: { hash: string }) {
  const [, view = "editor", id = ""] = hash.split("/");
  const routing = useRouting(true, true);
  const info = routing.data;
  const draft = info?.draft;
  const model = draft?.model ?? info?.model;
  const groups = model?.groups ?? [];
  const access = useRoutingEditorAccess();
  const candidate = info?.operations.find((op) => !terminal(op));
  const knownCandidate = useOperation(candidate?.id ?? null).data;
  const journal = useOperation(view === "operation" ? id : null);
  const tracking = useOperationTracking();
  const actions = useRoutingActions();
  const { publish } = useNotifications();
  const save = useSaveRoutingDraft();
  const stage = usePreviewRouting();
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [invalidPreview, setInvalidPreview] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const origin = useRef<{ scroll: number; top: number; isNew: boolean } | null>(null);
  const [returned, setReturned] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>();
  const { form, restored, update, resetForm } = useRuleForm(hash, info, returned, setFailure);
  const [busy, setBusy] = useState(false);
  // Visible text for the frozen action, so panels can say exactly what they are waiting for.
  const [activity, setActivity] = useState<string | null>(null);
  const locked = useRef(false);
  const visit = useMemo(() => ({ hash }), [hash]);
  const activeVisit = useRef<typeof visit | null>(visit);
  useLayoutEffect(() => {
    activeVisit.current = visit;
    setFailure(undefined);
    setConfirmation(null);
    if (view !== "editor") setOrder(null);
    return () => {
      activeVisit.current = null;
    };
  }, [hash]);
  const editing = view === "group" && form && (id === "new" ? form.isNew : form.rule.id === id) ? form : null;
  const orderDirty =
    !!order &&
    !same(
      order.original,
      order.groups.map((r) => r.id),
    );
  const dirty = (!!editing && !same(fields(editing), editing.initial)) || orderDirty;
  const base = editing ?? order;
  const staleBase = !!(base && info && (outdated(base, info) || info.drift));
  const conflict = staleBase || (failure instanceof ApiError && classifyError(failure) === "conflict");
  const pending = terminal(knownCandidate) ? undefined : (knownCandidate ?? candidate);
  const blocked = tracking.blocking || !!pending;
  const staleDraft = !!draft && draft.base_hash !== info?.current.sha256;
  const paused =
    !info?.model || !!info.model.issues.length || !!info.drift || staleDraft || conflict || blocked;
  useRoutingEditorPolling(!!base && !busy);
  function clear() {
    resetForm();
    setOrder(null);
    setFailure(undefined);
  }
  function ask(message: string, label: string, action: () => void) {
    focus.current = document.activeElement as HTMLElement;
    setConfirmation({ message, label, action });
  }
  const nav = useRoutingNavigation(
    hash,
    dirty,
    busy,
    (action) => ask("Discard unsaved edits?", "discard edits", action),
    clear,
  );
  function go(path: string, replace = false) {
    nav.guard(() => {
      clear();
      nav.visit(path, replace);
    });
  }
  function close() {
    if (editing) setReturned(editing.rule.id);
    nav.closePanel();
  }
  function openRule(id: string) {
    nav.guard(() => {
      const row = document.querySelector<HTMLElement>('[data-marker="rule-' + CSS.escape(id) + '"]');
      origin.current = { scroll: window.scrollY, top: row?.getBoundingClientRect().top ?? 12, isNew: id === "new" };
      clear();
      nav.visit(ROOT + "/group/" + id, view === "group");
    });
  }
  useLayoutEffect(() => {
    if (view !== "editor" || !returned) return;
    const row =
      document.querySelector<HTMLElement>('[data-marker="rule-' + CSS.escape(returned) + '"]') ??
      document.querySelector<HTMLElement>('[data-marker="routing-add"]');
    row?.focus({ preventScroll: true });
    if (origin.current) {
      if (origin.current.isNew) row?.scrollIntoView({ block: "center" });
      else if (matchMedia("(max-width:720px)").matches) window.scrollTo(0, origin.current.scroll);
      else if (row) window.scrollBy(0, row.getBoundingClientRect().top - origin.current.top);
      origin.current = null;
    }
  }, [view, returned]);
  useEffect(() => {
    if (view === "preview" && !preview && location.hash === hash) {
      nav.visit(ROOT, true);
      publish("Review the current changes again before applying.");
    }
  }, [hash, preview]);
  const observedId = view === "operation" ? id : pending?.id;
  useEffect(() => {
    let mounted = true;
    if (observedId)
      void access.readOperation(observedId).catch((error) => {
        if (mounted && !(error instanceof StaleSessionError)) setFailure(error);
      });
    return () => {
      mounted = false;
    };
  }, [observedId, access]);
  async function perform(task: () => Promise<void>, freeze = true, label: string | null = null) {
    if (locked.current) return;
    if (freeze) {
      locked.current = true;
      setBusy(true);
      setActivity(label);
    }
    setFailure(undefined);
    try {
      await task();
    } catch (error) {
      if (activeVisit.current === visit && !(error instanceof StaleSessionError)) {
        setFailure(error);
      }
    } finally {
      if (freeze) {
        locked.current = false;
        setBusy(false);
        setActivity(null);
      }
    }
  }
  function saveGroups(next: RoutingGroup[], base: Base, message: string, label: string) {
    if (!model || paused) return;
    void perform(async () => {
      await save.mutateAsync({
        model: { ...model, groups: next },
        base_hash: base.base,
        expected_revision: base.revision,
      });
      if (activeVisit.current !== visit) return;
      if (editing) setReturned(editing.rule.id);
      clear();
      setPreview(null);
      nav.visit(ROOT, true);
      publish(message);
    }, true, label);
  }
  function saveRule() {
    if (!editing) return;
    const rule = buildRule(editing);
    const next = groups.slice();
    const last = next.at(-1);
    if (editing.isNew)
      next.splice(last?.default_rule && !last.matchers.length ? next.length - 1 : next.length, 0, rule);
    else next[next.findIndex((item) => item.id === rule.id)] = rule;
    saveGroups(next, editing, "Rule saved to draft. Review changes to apply it.", SAVING_RULE);
  }
  function makePreview(snapshot?: string) {
    if (!info || (!snapshot && !draft)) return;
    nav.guard(
      () =>
        void perform(async () => {
          const staged = await stage.mutateAsync(
            snapshot
              ? { intent: "restore", expected_current_hash: info.current.sha256, snapshot_id: snapshot }
              : {
                  intent: "apply",
                  expected_current_hash: info.current.sha256,
                  draft_revision: draft!.revision,
                },
          );
          if (activeVisit.current !== visit) return;
          setPreview(staged);
          setInvalidPreview(null);
          nav.visit(ROOT + "/preview");
        }, true, "Validating changes"),
    );
  }
  function apply() {
    if (!preview) return;
    void perform(async () => {
      setInvalidPreview(preview.id);
      setApplying(true);
      const result = actions.apply(preview);
      const request = access.pending();
      let op;
      try {
        op = await result;
      } catch (error) {
        if (error instanceof ApiError && classifyError(error) === "busy")
          setInvalidPreview((id) => id === preview.id ? null : id);
        throw error;
      } finally {
        setApplying(false);
      }
      const identity = op?.id ?? request?.operation_id;
      if (activeVisit.current === visit && identity) nav.visit(ROOT + "/operation/" + identity);
    }, false);
  }
  function downloadLocal() {
    saveBlob(
      new Blob(
        [
          JSON.stringify(
            {
              model,
              unfinished_form: editing ?? access.readScratch()?.form ?? null,
              unfinished_order: order?.groups ?? null,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      "routing-draft.json",
    );
  }
  function loadLatest() {
    nav.guard(
      () =>
        void perform(async () => {
          await routing.refetch({ throwOnError: true });
          clear();
          setPreview(null);
          nav.visit(ROOT, true);
        }, true, "Loading the router version"),
    );
  }
  const confirm = confirmation && (
    <ConfirmStrip
      className="panel-confirm"
      marker="routing-confirm"
      autoFocus
      returnFocus={focus}
      message={confirmation.message}
      tone="danger"
      cancelLabel="keep editing"
      confirmLabel={confirmation.label}
      cancelMarker="keep-editing"
      confirmMarker="confirm-discard"
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        setConfirmation(null);
        confirmation.action();
      }}
    />
  );
  const error = failure ?? routing.error;
  const busyError = error instanceof ApiError && error.code === "busy" ? error : null;
  const blocker = busyError?.operation;
  const feedback = conflict ? (
    <Notice
      title={staleBase ? "These unfinished edits belong to an older version" : errorMessage(error)}
      kind="error"
      detail="Your edits are kept. Load the current version before saving again."
      actions={
        <>
          <Action marker="routing-download-local" onClick={downloadLocal}>
            download local edits
          </Action>
          <Action marker="routing-reload-latest" onClick={loadLatest}>
            reload latest
          </Action>
        </>
      }
    />
  ) : error ? (
    <>
      <Notice
        kind={busyError ? "neutral" : "error"}
        title={(busyError ? "Router busy · " : "") + errorMessage(error)}
        detail={
          busyError
            ? "Nothing was changed or queued. Your edits" +
              (preview ? " and review" : "") +
              " are kept; try again when it finishes." +
              (blocker ? " Running: " + actionLabel(blocker) + " · " + sourceLabel(blocker) + "." : "")
            : undefined
        }
        actions={
          !info ? (
            <Action marker="routing-retry" onClick={() => void routing.refetch()}>
              try again
            </Action>
          ) : undefined
        }
      />
      {error instanceof ApiError &&
        isRecord(error.data) &&
        Array.isArray(error.data.validation) &&
        error.data.validation.map(
          (item, i) =>
            isRecord(item) &&
            typeof item.message === "string" && <Notice key={i} kind="error" title={item.message} />,
        )}
    </>
  ) : restored ? (
    <Notice title="Unfinished edits restored" detail="Save them to the draft when you are ready." />
  ) : null;

  const diff = changes(info?.model?.groups ?? [], groups);
  const affected = diff.size + (diff.size === 1 ? " rule affected" : " rules affected");
  const draftErrors = draft?.validation.some((v) => v.severity === "error");
  const scratch = access.readScratch();
  const active = tracking.operation && !terminal(tracking.operation) ? tracking.operation : pending;
  const modal = ["history", "snapshot", "more", "conflict", "discard", "preview", "operation"].includes(view);
  const operation = journal.data ?? info?.operations.find((op) => op.id === id);
  const panel = {
    go,
    close,
    feedback,
    confirm,
  };
  const stagedStale =
    preview &&
    info &&
    (preview.base_hash !== info.current.sha256 ||
      (preview.intent === "apply" && preview.draft_revision !== draft?.revision));
  const editor = editing && (
    <RuleEditor
      key={editing.rule.id}
      {...panel}
      form={editing}
      locked={paused}
      busy={busy}
      saving={busy && activity === SAVING_RULE}
      activity={activity}
      onChange={update}
      onSave={saveRule}
      anchored={groups.slice(groups.findIndex((r) => r.id === editing.rule.id) + 1).some((r) => !r.editable)}
      onDelete={() =>
        ask("Delete this rule from the draft?", "delete rule", () =>
          saveGroups(
            groups.filter((r) => r.id !== editing.rule.id),
            editing,
            "Rule removed from draft. Router unchanged.",
            "Removing the rule from the draft",
          ),
        )
      }
    />
  );
  return (
    <div
      className={"routing-root" + (editing ? " editing-rule" : "")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && editing && !e.defaultPrevented) {
          e.preventDefault();
          close();
        }
      }}
    >
      <header className="routing-head">
        <Breadcrumbs
          root
          title="routing"
          links={[{ label: "~", marker: "routing-home", click: () => go("") }]}
        />
        <div className="routing-head-actions">
          <Action marker="routing-versions" onClick={() => go(ROOT + "/history")}>
            versions
          </Action>
          <Action marker="routing-more" onClick={() => go(ROOT + "/more")}>
            more
          </Action>
        </div>
      </header>
      <div className="operation-slot" data-marker="operation-slot" />
      <div data-marker="routing-feedback" role="status">
        {(!info || (!modal && !editing)) && feedback}
      </div>
      {!info ? (
        !routing.error && <Notice title="Loading configuration…" />
      ) : (
        <>
          <div className="sync-line" data-marker="routing-status">
            <div className="sync-copy" role="status">
              <strong className={diff.size || active || info.drift || staleDraft ? "pending" : "synced"}>
                {active
                  ? "Applying or recovering routing"
                  : info.drift
                    ? "Configuration changed on the router"
                    : staleDraft
                      ? "Draft needs to be resolved"
                      : diff.size
                        ? "◧ draft saved · " + affected
                        : "▪ in sync with router"}
              </strong>
              <span className="muted">
                {active
                  ? "Waiting for the result."
                  : staleDraft
                    ? "The draft belongs to an older router version."
                    : diff.size
                      ? "Your changes are waiting for review."
                      : groups.length + " rules · first match wins"}
              </span>
            </div>
            {!!info.capabilities.mock && <span className="muted">demo router</span>}
          </div>
          {(info.drift || staleDraft) && (
            <Notice
              title="Load the current router configuration"
              detail="Export and discard the draft before reimporting. Editing is paused."
              actions={
                <Action marker="resolve-conflict" onClick={() => go(ROOT + "/conflict")}>
                  resolve changes
                </Action>
              }
            />
          )}
          {!info.capabilities.ready && (
            <Notice title="Routing helper unavailable" detail={String(info.capabilities.reason ?? "")} />
          )}
          {info.parse_error && (
            <Notice title="Configuration cannot be edited" kind="error" detail={info.parse_error} />
          )}
          {info.model?.issues.map((issue) => (
            <Notice key={issue} title={issue} />
          ))}
          {scratch && view !== "group" && (
            <Notice
              title="Unfinished rule edits"
              detail="Your local form has not been saved to the draft."
              actions={
                <>
                  <Action
                    marker="continue-local-form"
                    onClick={() => go(ROOT + "/group/" + (scratch.form.isNew ? "new" : scratch.form.rule.id))}
                  >
                    continue editing
                  </Action>
                  <Action
                    marker="discard-local-form"
                    onClick={() => {
                      access.saveScratch(null);

                      setReturned(scratch.form.rule.id);
                    }}
                  >
                    discard local edits
                  </Action>
                </>
              }
            />
          )}
          <Rules
            groups={order?.groups ?? groups}
            changes={diff}
            validation={draft?.validation ?? []}
            ordering={!!order}
            editedId={editing?.rule.id}
            editor={editor}
            disabled={paused || busy}
            open={openRule}
            close={close}
            onSearchChange={() => setReturned(null)}
            returned={returned}
            reorder={() =>
              nav.guard(() => {
                clear();
                setOrder({ ...baseOf(info), original: groups.map((r) => r.id), groups });
                nav.visit(ROOT, true);
              })
            }
            move={(from, to) => {
              if (order) {
                const next = order.groups.slice();
                next.splice(to, 0, next.splice(from, 1)[0]!);
                setOrder({ ...order, groups: next });
              }
            }}
            cancel={() => setOrder(null)}
            save={() => order && saveGroups(order.groups, order, "Order saved to draft. Router unchanged.", "Saving rule order")}
            dirty={orderDirty}
          />
          <p className="context-note">Via proxy uses the active location selected on the home screen.</p>
          {active?.id ? (
            <footer className="draft-bar">
              <div>
                <strong>
                  {journalLabel(active)}
                </strong>
                <small>New changes are paused</small>
              </div>
              <Action marker="routing-operation" primary onClick={() => go(ROOT + "/operation/" + active.id)}>
                view progress
              </Action>
            </footer>
          ) : (
            !!diff.size &&
            !order && (
              <footer className="draft-bar" data-marker="routing-draft-bar">
                <div>
                  <strong>draft · {affected}</strong>
                  <small>{draftErrors ? "Fix rule errors before applying" : "Router unchanged"}</small>
                </div>
                <Action marker="draft-discard" onClick={() => go(ROOT + "/discard")}>
                  discard
                </Action>
                <PendingAction
                  marker="draft-review"
                  idle="review changes →"
                  pending="validating"
                  busy={stage.isPending}
                  primary
                  disabled={paused || !info.capabilities.ready || draftErrors || busy}
                  onClick={() => makePreview()}
                />
              </footer>
            )
          )}
          {view === "history" && <Versions {...panel} current={info.current.id} />}
          {view === "snapshot" && (
            <Snapshot
              key={id}
              {...panel}
              current={info.current.id}
              id={id}
              blocked={busy || blocked || info.drift || !info.capabilities.ready}
              reviewing={stage.isPending}
              restore={() => makePreview(id)}
            />
          )}
          {view === "preview" && preview && (
            <PreviewPanel
              {...panel}
              preview={preview}
              apply={apply}
              applying={applying}
              disabled={
                invalidPreview === preview.id ||
                !preview.validated ||
                blocked ||
                conflict ||
                !!stagedStale ||
                info.drift
              }
            />
          )}
          {view === "operation" && (
            <Progress {...panel} id={id} operation={operation} perform={perform} hasError={!!error} />
          )}
          {(view === "more" || view === "conflict" || view === "discard") && (
            <DraftTools
              {...panel}
              view={view}
              info={info}
              count={diff.size}
              blocked={busy || blocked}
              download={downloadLocal}
              refresh={() => routing.refetch({ throwOnError: true })}
              confirmAction={ask}
              perform={perform}
              finish={(message) => {
                setPreview(null);
                nav.visit(ROOT, true);
                publish(message);
              }}
            />
          )}
        </>
      )}
      {!modal && !editing && confirm}
    </div>
  );
}
