import { useEffect, useRef, useState } from "react";
import { useOperationTracking } from "../../app/AppSessionProvider";
import { ApiError, StaleSessionError } from "../../api/client";
import { useStatus } from "../../api/queries";
import { Button } from "../../ui/Button";
import { ConfirmStrip } from "../../ui/feedback";
import { errorMessage, formatMoscow } from "../../ui/format";
import { Toggle } from "../../ui/Toggle";
import { ComponentUpdates, type RunAction } from "./ComponentUpdates";
import { CombinedUpdates } from "./CombinedUpdates";
import { useRouterUpdates, useUpdateAction } from "./api";
import { components, maintenanceWarning, titles, type Automatic, type UpdateOperation } from "./model";

function phaseText(op: UpdateOperation) {
  if (op.phase === "journal_missing") return "router journal unavailable";
  if (op.phase === "awaiting_receipt") return "waiting for router acknowledgement";
  if (op.phase === "start_failed") return "installed · service state unconfirmed";
  if (op.phase === "rolled_back_start_failed") return "restored · service state unconfirmed";
  return op.phase.replaceAll("_", " ");
}

function RecoveryCommand({ command }: { command: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setResult("Command copied.");
    } catch {
      input.current?.focus(); input.current?.select();
      setResult("Command selected. Use your browser’s copy action.");
    }
  }
  return <details className="router-recovery" data-marker="router-recovery">
    <summary data-marker="router-recovery-summary">Recovery via SSH</summary>
    <p className="t-note">Save this command and your router login separately. Open it from a device on your LAN if this dashboard is unavailable.</p>
    <input className="router-ssh-command" aria-label="Router recovery command" data-marker="router-ssh-command"
      readOnly ref={input} value={command} onFocus={event => event.currentTarget.select()} />
    <Button marker="router-ssh-copy" onClick={() => void copy()}>copy command</Button>
    {result && <span role="status" className="t-note">{result}</span>}
  </details>;
}

function AutomaticForm({ value, change, busy, next, save, dailyConfig, leadMinutes }: {
  value: Automatic; change: (value: Automatic) => void; busy: boolean; next: string | null;
  save: () => void; dailyConfig?: string; leadMinutes?: number;
}) {
  const warning = maintenanceWarning(value.time, dailyConfig, leadMinutes);
  return <section className="router-auto"><h3>Automatic router updates</h3>
    <form onSubmit={e => { e.preventDefault(); save(); }}>
      <div className="router-auto-toggles" role="group" aria-label="Install automatically">
        {components.map(key => <Toggle key={key} marker={"router-auto-" + key} checked={value[key]} disabled={busy}
          onChange={checked => change({ ...value, [key]: checked })}>{titles[key]}</Toggle>)}
      </div>
      <label className="t-field"><span>Daily at · Moscow (UTC+3)</span>
        <input type="time" required data-marker="router-auto-time" value={value.time} disabled={busy}
          onChange={e => change({ ...value, time: e.target.value })} /></label>
      {warning && <p className="router-update-warning">{warning}</p>}
      <p className="t-note">{next ? "Next scheduled window · " + formatMoscow(next) : "No regular installation scheduled."}</p>
      <Button marker="router-auto-save" type="submit" disabled={busy}>save schedule</Button>
    </form>
  </section>;
}

export function RouterUpdatesPanel({ onDirty, onSaving }: { onDirty: (dirty: boolean) => void; onSaving: (saving: boolean) => void }) {
  const query = useRouterUpdates();
  const mutation = useUpdateAction();
  const tracking = useOperationTracking();
  const status = useStatus().data;
  const [autoDraft, setAutoDraft] = useState<Automatic | null>(null);
  const [editors, setEditors] = useState({ xkeen: false, xray: false, pair: false });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [recoverId, setRecoverId] = useState<string | null>(null);
  const data = query.data;
  const autoDirty = !!autoDraft && (components.some(n => autoDraft[n] !== data?.automatic[n]) || autoDraft.time !== data?.automatic.time);
  const dirty = autoDirty || editors.xkeen || editors.xray || editors.pair;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { onSaving(mutation.isPending); }, [mutation.isPending, onSaving]);

  const run: RunAction = async (action, success) => {
    setError(""); setMessage("");
    try {
      await mutation.mutateAsync(action);
      setMessage(success);
      return true;
    } catch (failure) {
      if (failure instanceof StaleSessionError) return false;
      setError(failure instanceof ApiError && failure.status && failure.status < 500 ?
        failure.message : errorMessage(failure, "Could not complete the router update request."));
      void query.refetch();
      return false;
    }
  };
  const failedRead = !!query.error;
  const busy = mutation.isPending;
  const op = data?.operation;
  const pairReserved = data?.pair?.state === "pending" || data?.pair?.state === "running";
  // Resume an interrupted operation with its original ID through the recovery endpoint.
  const interrupted = op?.phase === "interrupted";
  const pendingConfigTime = status?.auto_update.enabled && status.auto_update.mode === "daily" ? status.auto_update.daily_time : undefined;
  return <section className="router-updates" data-marker="router-updates-section">
    <header className="router-update-heading"><h2>Router updates</h2>
      {!!data && <Button marker="router-check-updates" disabled={busy} onClick={() =>
        void run({ path: "check", body: {} }, "Release catalog checked.")}>check for updates</Button>}
    </header>
    {!data && !failedRead && <p>Loading router versions…</p>}
    {failedRead && <p role="alert">Could not read current update status.{" "}
      <Button marker="router-updates-retry" onClick={() => void query.refetch()}>retry</Button></p>}
    {error && <p className="settings-error" role="alert" data-marker="router-updates-error">{error}</p>}
    {message && <p className="t-note" role="status">{message}</p>}
    {data && <>
      <p className="t-note">{data.checked_at ? "Catalog checked " + formatMoscow(data.checked_at) : "Release catalog has not been checked yet."}</p>
      {data.catalog_error && <p className="router-update-warning" role="alert">{data.catalog_error}</p>}
      {data.router_error && <p className="router-update-warning" role="alert">{data.router_error}</p>}
      {op && <div className="router-operation" data-marker="router-update-operation" role="status">
        <strong>{titles[op.component]} {op.version} · {phaseText(op)}</strong><div>{op.message}</div>
        {op.phase === "journal_missing" && <>
          <p>Router changes are paused. If the journal and ledger were lost, restore the operation records from a router backup.</p>
          <Button marker="router-journal-recheck" disabled={busy || failedRead} onClick={() =>
            void run({ path: "recover", body: { id: op.id } }, "Router journal rechecked.")}>recheck router journal</Button>
        </>}
        {interrupted && (recoverId === op.id ? <ConfirmStrip marker="router-recover-confirm" tone="danger" autoFocus
          message={"Restore the interrupted " + titles[op.component] + " operation?"}
          detail="The router uses the saved files for this operation. Connections may briefly drop."
          onCancel={() => setRecoverId(null)} onConfirm={async () => {
            if (await run({ path: "recover", body: { id: op.id } }, "Recovery requested.")) setRecoverId(null);
          }} confirmLabel="restore saved files" />
          : <Button marker="router-recover" disabled={busy || failedRead} onClick={() => setRecoverId(op.id)}>restore interrupted operation</Button>)}
      </div>}
      {tracking.blocking && !op && <p className="t-note">Router busy · wait for the current operation to finish.</p>}
      {data.pair !== undefined && <CombinedUpdates data={data} busy={busy || failedRead}
        installDisabled={!!op || tracking.blocking || !!data.router_error || !!data.catalog_error}
        configTime={pendingConfigTime} run={run}
        onEditing={editing => setEditors(previous => ({ ...previous, pair: editing }))} />}
      {components.map(name => <ComponentUpdates key={name} name={name} value={data.components[name]}
        reportedServiceState={name === "xkeen" ? status?.xkeen_state ?? "unknown" : undefined}
        schedules={data.components} currentMain={status?.active_code}
        beforeMain={data.history.find(entry => entry.component === name && entry.action === "install"
          && ["installed", "start_failed"].includes(entry.phase))?.main_before}
        daily={data.automatic.time} pendingConfigTime={pendingConfigTime} leadMinutes={data.maintenance_lead_minutes}
        busy={busy || failedRead}
        installDisabled={pairReserved || !!op || tracking.blocking || !!data.router_error || !!data.catalog_error}
        rollbackRevision={data.rollback_revision}
        lastPhase={data.history.find(entry => entry.component === name)?.phase}
        rollbackDisabled={pairReserved || !!data.router_error || !!op || tracking.blocking}
        run={run} onEditing={editing => setEditors(previous => ({ ...previous, [name]: editing }))} />)}
      <AutomaticForm value={autoDraft ?? data.automatic} change={setAutoDraft} busy={busy || failedRead}
        dailyConfig={pendingConfigTime} leadMinutes={data.maintenance_lead_minutes} next={data.next_auto_at} save={async () => {
          if (await run({ path: "auto", method: "PUT", body: autoDraft ?? data.automatic }, "Automatic schedule saved.")) setAutoDraft(null);
        }} />
      {data.ssh_command && <RecoveryCommand command={data.ssh_command} />}
      <section className="router-update-history"><h3>Recent activity</h3>
        {data.history.length ? <ul>{data.history.slice(0, 10).map(item => <li key={item.id}>
          <strong>{titles[item.component]}{item.action === "install" && item.phase.startsWith("rolled_back")
            ? " install " + item.version : " " + item.version} · {phaseText(item)}</strong>
          <span>{item.message}</span>
          <small>{item.source}{item.at ? " · " + formatMoscow(item.at) : ""}</small>
        </li>)}</ul> : <p className="t-note">No router updates yet.</p>}
      </section>
    </>}
  </section>;
}
