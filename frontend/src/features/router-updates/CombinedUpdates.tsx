import { useState } from "react";
import { newOperationId } from "../../browser/storage";
import { Button } from "../../ui/Button";
import { formatMoscow } from "../../ui/format";
import type { RunAction } from "./ComponentUpdates";
import { useCardFocus } from "./focus";
import { components, futureMoscowTime, localMoscowInput, maintenanceWarning, newScheduleTime, titles,
  type Pair, type ReplacedSchedules, type Updates, type Versions } from "./model";

type Draft = { intent: "install" | "schedule" | "reschedule"; id: string; versions: Versions; date: string; pins: ReplacedSchedules };
const resultLabels: Record<Pair["state"], string> = {
  pending: "Scheduled", running: "In progress", installed: "Both installed", cancelled: "Schedule cancelled",
  failed: "Update stopped", missed: "Installation window missed",
};
const stepLabels: Record<Pair["steps"]["xkeen"], string> = {
  pending: "waiting", running: "installing", installed: "installed",
  start_unconfirmed: "installed · service state unconfirmed", failed: "failed", skipped: "skipped",
};

export function CombinedUpdates({ data, busy, installDisabled, configTime, run, onEditing }: {
  data: Updates; busy: boolean; installDisabled: boolean; configTime?: string; run: RunAction;
  onEditing: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const focus = useCardFocus<HTMLElement>();
  const pair = data.pair;
  const releases = (name: keyof Versions) => data.components[name].releases.filter(row => row.supported);
  const bothAvailable = components.every(name => data.components[name].installed && releases(name).length);
  const reserved = pair?.state === "running" || pair?.state === "pending";
  const pins: ReplacedSchedules = {};
  for (const name of components) {
    const pin = data.components[name].schedule;
    if (pin?.state === "pending") pins[name] = { version: pin.version, at: pin.at };
  }
  const available = !reserved && bothAvailable;
  const moving = draft?.intent === "reschedule";
  const stale = !!draft && (moving ? pair?.id !== draft.id || pair.state !== "pending" :
    reserved || components.some(name => pins[name]?.at !== draft.pins[name]?.at || pins[name]?.version !== draft.pins[name]?.version
      || !data.components[name].installed || !releases(name).some(r => r.version === draft.versions[name])));
  const unavailable = busy || stale || (!moving && (installDisabled || components.some(name => data.components[name].schedule?.state === "running")));

  function open(intent: Draft["intent"]) {
    const reschedule = intent === "reschedule" && pair;
    const proposed = (name: keyof Versions) => releases(name).find(r => r.version === pins[name]?.version)?.version ?? releases(name)[0]!.version;
    const versions = reschedule ? { ...reschedule.versions } : { xkeen: proposed("xkeen"), xray: proposed("xray") };
    const pinnedTime = Object.values(pins).map(pin => Date.parse(pin.at)).filter(ts => ts > Date.now()).sort((a, b) => a - b)[0];
    const at = reschedule ? reschedule.at : pinnedTime ? new Date(pinnedTime).toISOString() : null;
    setDraft({ intent, versions, pins, id: reschedule ? reschedule.id : newOperationId(),
      date: at ? localMoscowInput(at) : newScheduleTime(data.automatic.time) });
    setError(""); onEditing(true); focus.focusForm();
  }
  function close() {
    if (draft) focus.returnTo("router-pair-" + draft.intent);
    setDraft(null); setError(""); onEditing(false);
  }
  async function submit() {
    if (!draft || unavailable) return;
    const at = draft.intent === "install" ? null : futureMoscowTime(draft.date);
    if (draft.intent !== "install" && !at) { setError("Choose a future date and time in Moscow."); return; }
    const ok = draft.intent === "reschedule"
      ? await run({ path: "batch", method: "PUT", body: { id: draft.id, at: at! } }, "New start time saved.")
      : await run({ path: "batch", body: { id: draft.id, versions: draft.versions, ...(at ? { at } : {}),
          ...(Object.keys(draft.pins).length ? { replace_schedules: draft.pins } : {}) } },
          at ? "Both updates scheduled." : "Combined update requested.");
    if (ok) close();
  }
  if (!available && !pair && !draft) return null;
  const partial = pair?.state === "failed" && components.some(name =>
    pair.steps[name] === "installed" || pair.steps[name] === "start_unconfirmed");
  const warning = draft && draft.intent !== "install" && maintenanceWarning(draft.date.slice(11, 16), configTime, data.maintenance_lead_minutes);
  return <section className="router-update-component router-update-combined" data-marker="router-pair" aria-label="Combined update"
    ref={focus.card}>
    <h3 tabIndex={-1}>XKeen + Xray</h3>
    {pair && <div className="router-pair-status" data-marker="router-pair-status" role="status">
      <strong>{!reserved && "Last combined update · "}{partial ? "Partially completed" : resultLabels[pair.state]}{pair.state === "pending" && pair.at && " · " + formatMoscow(pair.at)}</strong>
      <ul>{components.map(name => <li key={name}>{titles[name]} {pair.versions[name]} · {stepLabels[pair.steps[name]]}</li>)}</ul>
      {pair.message && <p>{pair.message}</p>}
    </div>}
    {!draft && pair?.state === "pending" && <div className="router-update-actions router-update-pair-actions">
      <Button marker="router-pair-reschedule" disabled={busy} onClick={() => open("reschedule")}>reschedule both…</Button>
      <Button marker="router-pair-unschedule" disabled={busy} onClick={async () => {
        if (await run({ path: "batch", method: "DELETE", body: { id: pair.id } }, "Combined schedule cancelled.")) focus.returnTo("router-pair-schedule");
      }}>cancel schedule</Button>
    </div>}
    {!draft && available && <div className="router-update-actions router-update-pair-actions">
      <Button marker="router-pair-install" variant="primary" disabled={unavailable} onClick={() => open("install")}>update both</Button>
      <Button marker="router-pair-schedule" disabled={unavailable} onClick={() => open("schedule")}>schedule both…</Button>
    </div>}
    {draft && <form className="router-action-form" aria-label="Combined update confirmation" data-marker="router-pair-form"
      onKeyDown={event => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault(); event.stopPropagation(); close();
      }}
      onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h4>{draft.intent === "install" ? "Install both" : moving ? "Reschedule both" : "Schedule both"}</h4>
      {components.map(name => {
        const choices = releases(name);
        const version = draft.versions[name];
        return <div key={name}>
          {choices.length > 1 && !moving ? <label className="t-field"><span>{titles[name]} release</span>
            <select data-marker={"router-pair-" + name + "-version"} disabled={busy} value={version}
              onChange={e => setDraft({ ...draft, versions: { ...draft.versions, [name]: e.target.value }, id: newOperationId() })}>
              {!choices.some(r => r.version === version) && <option value={version}>{version} · unavailable</option>}
              {choices.map(r => <option key={r.version}>{r.version}</option>)}
            </select></label> : <p>{titles[name]} <strong>{version}</strong></p>}
          {data.components[name].held === version && <p className="t-note">You previously rolled back {titles[name]} {version}.</p>}
        </div>;
      })}
      {draft.intent !== "install" && <label className="t-field"><span>Start time · Moscow (UTC+3)</span>
        <input type="datetime-local" data-marker="router-pair-at" required value={draft.date} disabled={busy}
          onChange={event => { setDraft({ ...draft, date: event.target.value, id: moving ? draft.id : newOperationId() }); setError(""); }} />
      </label>}
      {warning && <p className="router-update-warning">{warning}</p>}
      {Object.keys(draft.pins).length > 0 && !moving && <div className="router-update-warning" data-marker="router-pair-replaces">
        <p>This update replaces the following individual schedules.</p>
        <ul>{components.map(name => {
          const pin = draft.pins[name];
          return pin && <li key={name}>{titles[name]} {pin.version} · {formatMoscow(pin.at)}</li>;
        })}</ul>
      </div>}
      <p className="t-note">The router updates XKeen first. The Xray update starts automatically when XKeen succeeds. Connections may briefly drop.</p>
      {stale && <p role="alert">The releases or schedule changed. Reopen this form to review them.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="router-update-actions">
        <Button marker="router-pair-cancel" disabled={busy} onClick={close}>cancel</Button>
        <Button marker="router-pair-confirm" type="submit" variant="primary" disabled={unavailable}>
          {draft.intent === "install" ? "install both" : moving ? "save start time" : "schedule both"}</Button>
      </div>
    </form>}
  </section>;
}
