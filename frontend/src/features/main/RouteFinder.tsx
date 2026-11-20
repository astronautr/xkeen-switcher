import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ApiError, StaleSessionError } from "../../api/client";
import { useRouteChecks } from "../../api/queries";
import type { RouteCheckKind, RouteCheckRow, RouteChecksDto, RouteCheckRunDto, StatusDto } from "../../api/types";
import { useMainActions, useNotifications, useOperationTracking, useRouteCheckActions, useRouteSiteDraft } from "../../app/AppSessionProvider";
import type { RouteFinderPreferences } from "../../browser/storage";
import { ActionButton } from "../../ui/Button";
import { Chevron } from "../../ui/Chevron";
import { Select } from "../../ui/ChoicePopup";
import { Dialog } from "../../ui/overlays";
import { errorMessage, formatTime } from "../../ui/format";
import { closingSnapHeights, useSheetGestures, type Snap } from "../activity/sheetGestures";
import { protocolBadge, ResultRow, RoutePicker, stateLabel } from "./RouteFinderRows";
import { RouteFinderSites, type SiteDraft } from "./RouteFinderSites";

const TITLE = "Find a working route";
const APPLY_WAIT = "Finish or stop the check to apply a route.";
const SCOPES = { all: "All locations", reachable: "Reachable directly", chosen: "Chosen", "not-working": "Needs checking" };

function applicableConditions(row: RouteCheckRow) {
  return !!row.outcome && row.outcome !== "unavailable" && (!row.stale_kind || row.stale_kind === "expired");
}

function reportTotals(checked: RouteCheckRow[], total: number) {
  const working = checked.filter(row => row.outcome === "working").length;
  return checked.length === total ? working + " of " + total + " worked"
    : working + " worked · " + checked.length + "/" + total + " checked";
}

function runProgress(run: RouteCheckRunDto) {
  return "Checking " + (run.kind === "single" ? "locations" : "chains") + " · " + run.done + "/" + run.total;
}

function reportText(view: RouteChecksDto | undefined, rows: RouteCheckRow[], total: number, failed: boolean) {
  if (failed) return "Could not load results";
  if (!view) return "Loading…";
  if (view.run?.state === "interrupted") return "Check interrupted";
  if (view.run?.state === "cancelled") return view.run.finished_at ? "Stopped · " + formatTime(view.run.finished_at) : "Stopped";
  const checked = rows.filter(applicableConditions);
  if (checked.length) {
    const at = checked.map(row => row.checked_at ?? "").sort().at(-1);
    return reportTotals(checked, total) + (at ? " · " + formatTime(at) : "");
  }
  if (view.run?.conditions_hash && view.run.conditions_hash !== view.conditions.hash) return "Test sites changed · recheck";
  if (rows.some(row => row.state === "unavailable")) return "Check unavailable";
  return rows.some(row => row.checked_at) || view.run?.finished_at ? "No current results" : "Not checked yet";
}

type FinderProps = { status: StatusDto; mobile: boolean; heading: RefObject<HTMLHeadingElement | null> };

export function RouteFinder({ status, mobile, heading }: FinderProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useRouteSiteDraft();
  const trigger = useRef<HTMLButtonElement>(null);
  const run = status.route_check_run?.state === "running" ? status.route_check_run : null;
  const detailId = useId();
  const count = new Set(status.available.map(loc => loc.code)).size;
  // The closed desktop trigger needs the Single totals after partial runs, too.
  const singleQuery = useRouteChecks("single", null, open || (!mobile && !!count && !!status.route_check_run), open);
  const single = singleQuery.data;
  const checked = single?.routes.filter(applicableConditions) ?? [];
  const triggerReport = run ? runProgress(run)
    : checked.length ? "Single · " + reportTotals(checked, count) : "";
  const rememberTrigger = useCallback((node: HTMLButtonElement | null) => {
    if (!node && trigger.current && document.activeElement === trigger.current) heading.current?.focus();
    trigger.current = node;
  }, [heading]);
  function close() {
    setOpen(false);
    queueMicrotask(() => (trigger.current ?? heading.current)?.focus({ preventScroll: true }));
  }
  return <>
    {count > 0 && <button ref={rememberTrigger} type="button" className="route-finder-open" data-marker="open-route-finder"
      aria-haspopup="dialog" aria-label={TITLE} aria-describedby={triggerReport ? detailId : undefined} onClick={() => setOpen(true)}>
      <svg className="route-finder-icon" aria-hidden="true"><use href="/mobile-icons.svg#ico-route-find" /></svg>
      <span className="route-finder-open-text">
        <span className="route-finder-open-title">{TITLE}</span>
        <span id={detailId} className={"route-finder-open-detail" + (run ? " terminal-icon-action" : "")}
          data-busy={!!run} data-idle={run ? undefined : ""}>
          {mobile && run ? <><span className="visually-hidden">Checking routes · </span>{run.done}/{run.total}</> : triggerReport}
          {run && <span className="terminal-action-glyph" aria-hidden="true" />}
        </span>
      </span>
      <Chevron className="ui-disclosure-chevron" direction="right" />
    </button>}
    {open && <RouteSheet status={status} mobile={mobile} trigger={trigger} onClose={close}
      singleQuery={singleQuery} draft={draft} setDraft={setDraft} />}
  </>;
}

type SheetProps = Omit<FinderProps, "heading"> & {
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  singleQuery: ReturnType<typeof useRouteChecks>;
  draft: SiteDraft | null;
  setDraft: Dispatch<SetStateAction<SiteDraft | null>>;
};

function RouteSheet({ status, mobile, trigger, onClose, singleQuery, draft, setDraft }: SheetProps) {
  const checks = useRouteCheckActions();
  const locations = status.available.filter((loc, i, all) => i === all.findIndex(item => item.code === loc.code));
  const codes = locations.map(loc => loc.code);
  const run = status.route_check_run?.state === "running" ? status.route_check_run : null;
  const [pref, setPref] = useState(() => checks.readPreferences(codes));
  const [tab, setTab] = useState<RouteCheckKind>(() => run?.kind ?? pref.step);
  const [selecting, setSelecting] = useState(false);
  const [snap, setSnap] = useState<Snap>(1);
  const [starting, setStarting] = useState<RouteCheckKind | null>(null);
  const [stopping, setStopping] = useState(false);
  const [applying, setApplying] = useState<{ id: string; refusal: unknown } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const { switchTo } = useMainActions();
  const tracking = useOperationTracking();
  const { publish } = useNotifications();
  const singleView = singleQuery.data;
  const chainAllowed = codes.length >= 2;
  const kind = chainAllowed ? tab : run?.kind ?? "single";
  const isSingle = kind === "single";
  const exit = !selecting && run?.kind === "chain" ? run.exit_code ?? ""
    : [pref.exit, status.active_code, codes[0]].find(code => code && codes.includes(code)) ?? "";
  const chainQuery = useRouteChecks("chain", exit, !isSingle && !!exit);
  const query = isSingle ? singleQuery : chainQuery;
  const view = query.data;
  const ownRun = run?.kind === kind && (isSingle || run.exit_code === exit) ? run : null;
  const busy = !!run || !!starting;
  const available = isSingle ? locations : locations.filter(loc => loc.code !== exit);
  const all = available.map(loc => loc.code);
  const currentRows = (view?.routes ?? []).filter(row => all.includes(row.entry_code ?? row.exit_code));
  const direct = new Map((singleView?.routes ?? []).map(row => [row.exit_code, row]));
  // A live Single row shows Queued/Checking during a recheck. Its prior verdict
  // still qualifies the entry, which Chain reports explicitly.
  const usable = currentRows.some(row => row.entry_reachable != null);
  const olderSites = !usable && all.some(code => direct.get(code)?.stale_kind === "conditions");
  const reachable = currentRows.filter(row => row.entry_reachable).map(row => row.entry_code!);
  const notWorking = all.filter(code => direct.get(code)?.state !== "working");
  const scope = !isSingle && pref.chain === "reachable" && !usable ? "all" : pref[kind];
  const chosen = all.filter(c => (isSingle ? pref.codes : pref.entryCodes).includes(c));
  const selected = scope === "all" ? all : scope === "reachable" ? reachable : scope === "not-working" ? notWorking : chosen;
  const scopeName = scope === "chosen" && chosen.length === 1
    ? available.find(loc => loc.code === chosen[0])?.name : null;
  const scopeLabel = isSingle ? "Locations to check" : "Entries";
  const scopeSummary = scopeName ?? SCOPES[scope] + " · " + selected.length;
  const scopeCaption = mobile && scope === "reachable" ? "Reachable · " + selected.length : scopeSummary;
  // Needs checking is a moving selection. Keep its completed results in view.
  const others = isSingle && scope !== "chosen" ? [] : all.filter(code => !selected.includes(code));
  const visibleTargets = view?.conditions.targets;
  const dirty = !!draft && (draft.urls.length !== draft.base.length || draft.urls.some((url, i) => url !== draft.base[i])
    || (visibleTargets && (visibleTargets.length !== draft.urls.length || visibleTargets.some((url, i) => url !== draft.urls[i]))));
  const block = tracking.blocking ? tracking.blockReason || "Another router operation is in progress" : null;
  const applyReason = busy ? APPLY_WAIT : block ?? (applying ? "Main is switching. Wait for it to finish." : null);
  const exitName = locations.find(loc => loc.code === exit)?.name ?? run?.exit_name ?? exit;
  const directExit = view?.direct ?? direct.get(exit);
  const stalePair = !isSingle && singleView?.conditions.hash !== view?.conditions.hash;
  const hasSingleResult = [...direct.values()].some(row => row.checked_at || row.last_attempt);
  const hasResult = hasSingleResult || !!view?.run?.done || !!status.route_check_run?.done;
  const choseStep = useRef(false);
  const soon = useRef(onClose);
  soon.current = onClose;

  function savePref(update: Partial<RouteFinderPreferences>) {
    const next = { ...pref, ...update };
    setPref(next);
    checks.savePreferences(next);
  }
  function step(next: RouteCheckKind, nextExit?: string) {
    if (next === "chain" && !chainAllowed && run?.kind !== "chain") return;
    choseStep.current = true;
    setTab(next);
    setSelecting(false);
    savePref(nextExit ? { step: next, exit: nextExit, chain: "reachable" } : { step: next });
  }
  function chooseCodes(next: string[]) {
    savePref(isSingle ? { single: "chosen", codes: next } : { chain: "chosen", entryCodes: next });
  }
  function pickScope(value: string) {
    choseStep.current = true;
    setSelecting(value === "chosen");
    savePref({ [kind]: value });
  }
  useEffect(() => {
    let mounted = true;
    checks.setOpen(true);
    // The first sheet read may see a run started since the last dashboard poll.
    // Once the user picks a tab, subsequent observations only update progress.
    void singleQuery.refetch({ cancelRefetch: false }).then(({ data }) => {
      if (mounted && !choseStep.current && data?.active_run) setTab(data.active_run.kind);
    });
    return () => { mounted = false; checks.setOpen(false); };
  }, [checks, singleQuery.refetch]);
  useEffect(() => {
    if (!chainAllowed && run?.kind !== "chain") setTab("single");
  }, [chainAllowed, run?.kind]);
  // Keep the sheet open while Main is looking up an ambiguous submission.
  useEffect(() => {
    if (!applying) return;
    if (tracking.refusal && tracking.refusal !== applying.refusal) {
      setApplying(null);
      void query.refetch();
      return;
    }
    const op = tracking.operation;
    const ours = op && (op.id === applying.id || op.request_id === applying.id);
    if ((ours && !op.local && !op.ephemeral) || (!ours && !tracking.requested)) soon.current();
  }, [applying, tracking, query]);

  const gestures = useSheetGestures({ enabled: mobile, sheet: frame, list: body, snap,
    onSnap: next => next === 0 ? soon.current() : setSnap(next), heights: closingSnapHeights, reserve: false });

  function startReason(selection: string[]) {
    if (dirty) return "Save or cancel test sites first.";
    if (busy) return "One check runs at a time.";
    if (block || applying) return block ?? "Main is switching. Wait for it to finish.";
    if (!view?.conditions.hash || stalePair) return "Waiting for current check settings.";
    if (!selection.length) return isSingle ? "Choose at least one location." : "Choose at least one entry.";
    return null;
  }
  async function start(selection: string[], fromOthers = false) {
    if (startReason(selection) || !view) return;
    if (fromOthers) chooseCodes(selection);
    setSelecting(false);
    setStarting(kind);
    try {
      const conditions_hash = view.conditions.hash;
      await checks.start(isSingle ? { kind, codes: selection, conditions_hash }
        : { kind, exit_code: exit, entry_codes: selection, conditions_hash });
    } catch (error) {
      if (!(error instanceof StaleSessionError)) {
        const refusal = error instanceof ApiError && ["stale_conditions", "busy", "location"].includes(error.code ?? "");
        publish(refusal ? error.message : errorMessage(error), true);
      }
      void query.refetch();
    } finally { setStarting(null); }
  }
  async function stop() {
    if (!run || stopping) return;
    setStopping(true);
    try { await checks.cancel(run.id); }
    catch (error) {
      if (!(error instanceof StaleSessionError)) publish(errorMessage(error), true);
      void query.refetch();
    } finally { setStopping(false); }
  }
  function apply(row: RouteCheckRow) {
    if (gestures.consumeClick() || applyReason || !row.applicable || !row.run_id) return;
    const id = switchTo({ code: row.exit_code, entry_code: row.entry_code, route_check_id: row.run_id });
    if (id) setApplying({ id, refusal: tracking.refusal });
    else publish("Could not start the switch. Refresh and try again.", true);
  }
  function result(row: RouteCheckRow, other = false) {
    const code = row.entry_code ?? row.exit_code;
    const state = direct.get(code)?.state;
    const directLabel = state === "unavailable" ? "check unavailable" : state === "unchecked" || !state ? "not checked" : state;
    const skipped = other && row.state === "unchecked" ? directLabel + " directly" : undefined;
    return <ResultRow key={kind + ":" + row.exit_code + ":" + code} row={row}
      badge={isSingle ? protocolBadge(available.find(loc => loc.code === code)?.protocol) : undefined}
      disabled={!!applyReason} reasonId={reasonId + "-apply"} onApply={apply} skipped={skipped}
      chainDisabled={(run?.kind === "chain" || starting === "chain") && exit !== row.exit_code}
      onChain={isSingle && chainAllowed ? code => {
        step("chain", code);
        requestAnimationFrame(() => checkButton.current?.focus());
      } : undefined} />;
  }
  const chooseOption = { value: "chosen", label: "Choose…", description: chosen.length ? chosen.length + " chosen" : undefined };
  const allOption = { value: "all", label: SCOPES.all, description: String(all.length) };
  const scopeOptions = isSingle ? [allOption,
    { value: "not-working", label: SCOPES["not-working"], description: hasSingleResult ? String(notWorking.length) : "after a check", disabled: !hasSingleResult },
    chooseOption] : [
    { value: "reachable", label: SCOPES.reachable, disabled: !usable,
      description: usable ? String(reachable.length) : olderSites ? "recheck Single" : "check Single first" },
    allOption, chooseOption];
  const checkReason = ownRun ? (stopping ? "Stopping route checks." : null) : startReason(selected);
  const report = stopping ? "Stopping…"
    : run ? runProgress(run)
    : starting ? "Starting check…"
    : applying ? "Switching Main…"
    : block ? "Router busy"
    : dirty ? "Save or cancel test sites first."
    : !selected.length && scope === "chosen" ? checkReason
    : !isSingle && usable && !selected.length && scope === "reachable" ? "No reachable entries. Choose All locations."
    : reportText(view, currentRows, all.length, query.isError);
  const othersReason = startReason(others);
  const recheck = !!view?.run || currentRows.some(row => !!row.checked_at);
  return <Dialog open marker="route-finder" className="route-sheet" data-mobile={String(mobile)} aria-labelledby={titleId}
    returnFocus={trigger} initialFocus=".route-sheet-close" onClose={onClose}
    onClick={event => { if (event.target === event.currentTarget && !gestures.consumeClick()) onClose(); }}>
    <div ref={frame} className="route-sheet-frame" data-snap={snap}>
      {mobile && <div className="route-sheet-grip" aria-hidden="true" data-sheet-drag />}
      <header className="route-sheet-head" data-sheet-drag>
        <h2 id={titleId} className="route-sheet-title" aria-label={TITLE}>
          <span className="activity-crumb" aria-hidden="true">~</span><span aria-hidden="true">/route-finder</span>
        </h2>
        <button type="button" className={"route-sheet-close" + (mobile ? "" : " t-btn")} data-ui-variant={mobile ? undefined : "bracket"}
          data-marker="route-finder-close" aria-label="Close route finder" onClick={() => { if (!gestures.consumeClick()) onClose(); }}>
          {mobile ? <Chevron direction="down" /> : "close"}
        </button>
      </header>
      <div ref={body} className="route-sheet-body">
        <div className="t-seg route-sheet-steps" role="group" aria-label="What to check">
          {(["single", "chain"] as const).map(value =>
            <button key={value} type="button" className="t-seg-btn" data-ui-variant="bracket" data-marker={"route-finder-" + value}
              aria-pressed={kind === value} aria-disabled={value === "chain" && !chainAllowed}
              aria-describedby={value === "chain" && !chainAllowed ? reasonId + "-chain" : undefined}
              onClick={() => { if (value === "single" || chainAllowed) step(value); }}>
              {value === "single" ? "Single" : "Chain"}
            </button>)}
        </div>
        {!chainAllowed && <span className="visually-hidden" id={reasonId + "-chain"}>Chains need at least two locations</span>}
        <RouteFinderSites targets={view?.conditions.targets} draft={draft} setDraft={setDraft} running={busy} hasResults={hasResult} />
        {!isSingle && <div className="route-sheet-field">
          <div className="route-sheet-label-row">
            <span className="route-sheet-label">Exit location</span>
            <span className="route-sheet-direct" data-marker="route-finder-direct" data-state={directExit?.state}>
              Direct · <span className="route-sheet-direct-state">{stateLabel(directExit ?? undefined)}</span>
            </span>
          </div>
          <div className="route-sheet-controls">
            <Select rich marker="route-finder-exit" variant="device" label="Exit location" caption={exitName || "Choose an exit"}
              triggerLabel={"Exit location: " + exitName} value={exit} disabled={run?.kind === "chain" || !!starting || !codes.length}
              popupClass="device-menu route-sheet-menu" minWidth={240} onSelect={value => {
                savePref({ exit: value, entryCodes: pref.entryCodes.filter(code => code !== value) });
              }}
              options={locations.map(loc => {
                const row = direct.get(loc.code);
                const pending = row?.state === "checking" || row?.state === "queued";
                return { value: loc.code, label: loc.name, state: row?.state,
                  description: pending ? row.state : row?.on_main ? "on Main" : !row || row.state === "unchecked" ? "not checked" : stateLabel(row, true).toLowerCase() };
              })} />
          </div>
        </div>}
        <div className="route-sheet-field">
          <span className="route-sheet-label">{scopeLabel}</span>
          <div className="route-sheet-controls">
            <Select rich marker="route-finder-scope" fieldId={reasonId + "-scope"} variant="device" label={scopeLabel}
              caption={scopeCaption} value={scope}
              triggerLabel={scopeLabel + ": " + scopeSummary} disabled={busy || !codes.length}
              options={scopeOptions} onSelect={pickScope} />
            <ActionButton marker="route-finder-check" ref={checkButton} className="t-btn route-sheet-check" idle={recheck ? "recheck" : "check"}
              pending={ownRun && !stopping ? "stop" : "wait"} reserve={["check", "recheck"]} busy={!!ownRun || starting === kind}
              data-action={ownRun ? "stop" : "check"}
              aria-disabled={!!checkReason} aria-describedby={checkReason ? reasonId + "-start" : undefined}
              aria-label={ownRun ? isSingle ? "Stop checking locations" : "Stop checking routes to " + exitName
                : (recheck ? "Recheck " : "Check ") + selected.length + (isSingle ? " locations directly" : " chains to " + exitName)}
              onClick={() => { if (!checkReason) void (ownRun ? stop() : start(selected)); }} />
          </div>
        </div>
        {checkReason && <span className="visually-hidden" id={reasonId + "-start"}>{checkReason}</span>}
        <p className="route-sheet-report" data-busy={busy}>
          <span role="status" data-marker="route-finder-report">{report}</span>
          {run && !ownRun && <button type="button" className="route-link" data-marker="route-show-running"
            onClick={() => step(run.kind)}>View {run.kind === "single" ? "Single" : "Chain"}</button>}
        </p>
        {applyReason && <span className="visually-hidden" id={reasonId + "-apply"}>{applyReason}</span>}
        {!codes.length ? <p className="empty-state">No locations yet. Refresh the subscription to load them.</p>
          : selecting ? <RoutePicker single={isSingle} mobile={mobile} disabled={busy} chosen={chosen} locations={available} direct={direct}
            presets={isSingle ? [{ label: "all", codes: all }, { label: "none", codes: [] }, { label: "needs checking", codes: notWorking }]
              : [{ label: "reachable", codes: reachable }, { label: "all", codes: all }, { label: "none", codes: [] }]}
            onChange={chooseCodes} onDone={() => {
              setSelecting(false);
              (busy ? checkButton.current : document.getElementById(reasonId + "-scope"))?.focus();
            }} />
          : <>
            <ul className="route-list" aria-label={isSingle ? "Single locations" : "Chains"}>
              {currentRows.filter(row => !others.includes(row.key)).map(row => result(row))}
            </ul>
            {others.length > 0 && <details key={isSingle ? "single" : "chain:" + exit} className="route-other">
              <summary data-marker={isSingle ? "route-other-locations" : "route-other-entries"}>
                {isSingle ? "Other locations" : "Other entries"} · {others.length}<Chevron direction="down" />
              </summary>
              <ul className="route-list">{currentRows.filter(row => others.includes(row.key)).map(row => result(row, !isSingle))}</ul>
              {!isSingle && <p className="t-note route-other-action">
                <button type="button" data-marker="route-check-others" className="route-link" aria-disabled={!!othersReason}
                  aria-describedby={othersReason ? reasonId + "-others" : undefined} onClick={() => void start(others, true)}>Check these {others.length}</button>
                {othersReason && <span className="visually-hidden" id={reasonId + "-others"}>{othersReason}</span>}
              </p>}
            </details>}
          </>}
      </div>
    </div>
  </Dialog>;
}
