import { useId, useState } from "react";
import { newOperationId } from "../../browser/storage";
import { Button } from "../../ui/Button";
import type { UpdateAction } from "./api";
import { useCardFocus } from "./focus";
import { futureMoscowTime, localMoscowInput, maintenanceWarning, newScheduleTime, planLabel, scheduleLabel, titles,
  type Component, type ComponentState, type RestoreStep } from "./model";

export type RunAction = (action: UpdateAction, success: string) => Promise<boolean>;
type Editor = {
  type: "install" | "schedule" | "rollback";
  version: string;
  date: string;
  id: string;
  plan: RestoreStep[];
  revision: string | null;
};
type Props = {
  name: Component; value: ComponentState; daily: string;
  busy: boolean; installDisabled: boolean; rollbackDisabled: boolean;
  schedules: Record<Component, ComponentState>; beforeMain?: string | null; currentMain?: string | null;
  rollbackRevision: string | null; lastPhase?: string; reportedServiceState?: string; pendingConfigTime?: string; leadMinutes?: number; run: RunAction; onEditing: (value: boolean) => void;
};

export function ComponentUpdates({ name, value, daily, busy, installDisabled, rollbackDisabled,
  schedules, beforeMain, currentMain, lastPhase, reportedServiceState, rollbackRevision, pendingConfigTime, leadMinutes, run, onEditing }: Props) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [inputError, setInputError] = useState("");
  const prefix = "router-" + name;
  const releases = value.releases.filter(release => release.supported);
  const pin = value.schedule;
  const restore = value.rollback.find(step => step.component === name);
  const pointId = useId();
  const focus = useCardFocus<HTMLElement>();
  function close() {
    if (editor) focus.returnTo(prefix + "-" + editor.type);
    setEditor(null); setInputError(""); onEditing(false);
  }
  function open(type: Editor["type"]) {
    const pinned = type === "schedule" && pin;
    const date = pinned && pinned.state === "pending" ? localMoscowInput(pinned.at) : newScheduleTime(daily);
    setEditor({ type, version: type === "rollback" ? restore!.to : pinned ? pinned.version : releases[0]!.version,
      plan: type === "rollback" ? [...value.rollback] : [], revision: rollbackRevision, date, id: newOperationId() });
    setInputError(""); onEditing(true); focus.focusForm();
  }
  const options = editor?.type === "schedule" && pin ? releases.filter(r => r.version === pin.version) : releases;
  const stalePlan = editor?.type === "rollback" && (!editor.revision || editor.revision !== rollbackRevision || JSON.stringify(editor.plan) !== JSON.stringify(value.rollback));
  const staleRelease = editor && editor.type !== "rollback" && !options.some(r => r.version === editor.version);
  const affected = editor?.type === "rollback" ? editor.plan.map(step => step.component) : [name];
  const cancellations = affected.flatMap(component => {
    const job = schedules[component].schedule;
    return job?.state === "pending" && (editor?.type === "rollback" || editor?.type === "install" && editor.version !== job.version)
      ? [titles[component] + " " + job.version] : [];
  });
  const warning = editor?.type === "schedule" && maintenanceWarning(editor.date.slice(11, 16), pendingConfigTime, leadMinutes);
  const formDisabled = busy || (editor?.type === "rollback" ? rollbackDisabled : installDisabled)
    || stalePlan || !!staleRelease;
  async function submit() {
    if (!editor || formDisabled) return;
    const { type, version, id, date, plan } = editor;
    let action: UpdateAction;
    let success: string;
    if (type === "schedule") {
      const at = futureMoscowTime(date);
      if (!at) {
        setInputError("Choose a future date and time in Moscow."); return;
      }
      action = { path: "schedule", method: "PUT", body: { component: name, version, at } };
      success = titles[name] + " " + version + " scheduled.";
    } else {
      const body = { id, component: name, version, cancel_schedule: cancellations.length > 0 };
      action = type === "rollback" ? { path: type, body: { ...body, plan, revision: editor.revision! } } : { path: type, body };
      success = type === "rollback" ? "Rollback requested." : "Installation requested.";
    }
    if (await run(action, success)) close();
  }
  const form = editor && <form className="router-action-form" aria-label={editor.type + " " + titles[name]}
    data-marker={prefix + "-form"}
    onKeyDown={event => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault(); event.stopPropagation(); close();
    }}
    onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h4>{editor.type === "schedule" ? "Schedule" : editor.type === "install" ? "Install" : "Restore"} {titles[name]}</h4>
    {editor.type === "rollback" ? <>
      <p>{planLabel(editor.plan)}</p>
      <p className="t-note">Restore from the router’s local copy. The current Main route is kept.</p>
      {beforeMain && currentMain && beforeMain !== currentMain && <p className="router-update-warning">
        Main changed since installation · {beforeMain} → {currentMain}.
      </p>}
    </> : <>
      <label className="t-field"><span>Stable release</span><select data-marker={prefix + "-version"} value={editor.version}
        disabled={busy || editor.type === "schedule" && !!pin}
        onChange={event => setEditor({ ...editor, version: event.target.value, id: newOperationId() })}>
        {staleRelease && <option value={editor.version}>{editor.version} · unavailable</option>}
        {options.map(r => <option key={r.version} value={r.version}>{r.version}</option>)}
      </select></label>
      {value.held === editor.version && <p className="t-note">You previously rolled back this release.</p>}
      {editor.type === "install" && <p className="t-note">The router saves a local copy of {value.installed} before updating.</p>}
      {editor.type === "schedule" && <>
        <label className="t-field"><span>Date and time · Moscow (UTC+3)</span>
          <input type="datetime-local" data-marker={prefix + "-at"} required disabled={busy} value={editor.date}
            onChange={e => { setEditor({ ...editor, date: e.target.value }); setInputError(""); }} /></label>
        <p className="t-note">This task installs only {titles[name]} {editor.version}.
          {pin ? " Cancel the task to choose a different release." : " It takes priority over automatic updates for this component."}</p>
        {warning && <p className="router-update-warning">{warning}</p>}
      </>}
    </>}
    {editor.type !== "schedule" && <p className="t-note">Connections may briefly drop.</p>}
    {cancellations.length > 0 && <p className="router-update-warning">Confirming also cancels the pending task for {cancellations.join(", ")}.</p>}
    {(staleRelease || stalePlan) && <p role="alert">The available versions or rollback plan changed. Cancel and reopen to review it.</p>}
    {inputError && <p role="alert">{inputError}</p>}
    <div className="router-update-actions">
      <Button marker={prefix + "-cancel"} disabled={busy} onClick={close}>cancel</Button>
      <Button marker={prefix + "-confirm"} type="submit" variant={editor.type === "rollback" ? "danger" : "primary"}
        disabled={formDisabled}>{editor.type === "schedule" ? "schedule this version" :
          editor.type === "rollback" ? "confirm rollback" : "install " + editor.version}</Button>
    </div>
  </form>;
  return <section className="router-update-component" data-marker={prefix + "-card"} ref={focus.card}
    aria-labelledby={prefix + "-title"}>
    <h3 id={prefix + "-title"} tabIndex={-1}>{titles[name]}</h3>
    <p>Installed <strong>{value.installed ?? "unknown"}</strong>
      {releases.length > 0 && <> · available <strong>{releases[0]!.version}</strong></>}</p>
    {reportedServiceState && <p className="t-note">Last reported service state · <strong>{reportedServiceState}</strong></p>}
    {lastPhase === "rolled_back_start_failed" && <p className="router-update-warning" role="alert" data-marker={prefix + "-restored-start-failed"}>
      The previous version was restored. Service state was unconfirmed at the time of rollback.
    </p>}
    {value.held && <p className="t-note">Automatic installation of {value.held} is on hold after rollback.</p>}
    {value.releases.filter(r => !r.supported).map(r =>
      <p className="t-note" key={r.version}>{r.version} · {r.reason || "Unsupported update path."}</p>)}
    {pin && <div className="router-update-row router-schedule-info" data-marker={prefix + "-schedule-row"}>
      <span>{scheduleLabel(pin)}{pin.reason && " · " + pin.reason}</span>
      <Button marker={prefix + "-unschedule"} disabled={busy || pin.state === "running"}
        onClick={async () => {
          if (!await run({ path: "schedule", method: "DELETE", body: { component: name } }, "One-time schedule removed.")) return;
          close(); focus.returnTo(prefix + "-schedule");
        }}>
        {pin.state === "pending" ? "cancel schedule" : "clear"}
      </Button></div>}
    {!editor && releases.length > 0 && <div className="router-update-actions router-update-pair-actions" data-marker={prefix + "-actions"}>
      <Button marker={prefix + "-install"} disabled={busy || installDisabled} onClick={() => open("install")}>update now</Button>
      <Button marker={prefix + "-schedule"} disabled={busy || installDisabled || !!pin && !releases.some(r => r.version === pin.version)}
        onClick={() => open("schedule")}>{pin ? "reschedule" : "schedule…"}</Button>
    </div>}
    {editor?.type !== "rollback" && form}
    {restore && <div className="router-update-row router-update-point" data-marker={prefix + "-rollback-point"}>
      <span id={pointId}>Local rollback point <strong>{restore.to}</strong></span>
      {!editor && <Button marker={prefix + "-rollback"} aria-describedby={pointId} disabled={busy || rollbackDisabled}
        onClick={() => open("rollback")}>roll back</Button>}
    </div>}
    {editor?.type === "rollback" && form}
  </section>;
}
