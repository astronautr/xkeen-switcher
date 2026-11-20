import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LocationDto, OperationDto, StatusDto } from "../../api/types";
import { useProbeLocations } from "../../api/mutations";
import { useMainActions, useOperationTracking } from "../../app/AppSessionProvider";
import { ActionButton, Button } from "../../ui/Button";
import { Select } from "../../ui/ChoicePopup";
import { locationHealth, manualMainSwitch, routeName, splitName } from "./model";
import { phaseLabel, unresolved } from "../../operations/policy";
import { formatDateTime } from "../../ui/format";
import { useActionFeedback } from "./common";
import { MobileIcon } from "../../ui/mobile";
import { withOccurrenceKeys } from "../../ui/listKeys";
import { RouteFinder } from "./RouteFinder";

/** Chain menus outgrow their half-width field so names and health stay on separate readable lines. */
const CHAIN_MENU_MIN_WIDTH = 240;

const badges: Record<string, string> = { shadowsocks: "ss", hysteria: "hy2", hysteria2: "hy2" };

function SwitchStatus({ operation }: { operation: OperationDto }) {
  const phase = phaseLabel(operation.phase);
  const status = useRef<HTMLDivElement>(null);
  const id = operation.request_id ?? operation.id;
  useLayoutEffect(() => {
    status.current?.scrollIntoView({ block: "nearest" });
  }, [id]);
  return (
    <div ref={status} className="main-switch-status" data-marker="main-switch-status" data-phase={operation.phase}>
      <span role="status">{phase}</span>
      {!unresolved(operation) && <progress className="operation-progress" aria-label={phase} />}
      {unresolved(operation) && operation.id && (
        <a
          className="main-switch-details"
          data-marker="main-switch-details"
          href={"#routing/operation/" + encodeURIComponent(operation.id)}
        >
          {operation.phase === "recovery_failed" ? "Recovery details" : "Operation details"}
        </a>
      )}
    </div>
  );
}

export function Locations({ status, mobile }: { status: StatusDto; mobile: boolean }) {
  const { active_code, active_entry_code, available, failover } = status;
  const rows = useMemo(() => withOccurrenceKeys(available, (location) => location.code), [available]);
  const [selectedRow, setSelectedRow] = useState<{ id: string; key: string } | null>(null);
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [order, setOrder] = useState(() => ({ keys: rows.map((row) => row.key), generations: new Map<string, number>() }));
  if (order.keys.length !== rows.length || rows.some((row, index) => row.key !== order.keys[index])) {
    const keys = rows.map((row) => row.key);
    const previousFocus = focusedRow === null ? -1 : order.keys.indexOf(focusedRow);
    const nextFocus = focusedRow === null ? -1 : keys.indexOf(focusedRow);
    const behindFocus = new Set(previousFocus < 0 ? [] : order.keys.slice(previousFocus + 1));
    const generations = new Map<string, number>();
    rows.forEach(({ key }, index) => {
      let generation = order.generations.get(key) ?? 0;
      // React moves a reused sibling when its old position precedes a sibling already placed.
      // Replacing a row crossing ahead of focus keeps the focused subtree continuously mounted.
      if (index < nextFocus && behindFocus.has(key)) generation++;
      if (generation) generations.set(key, generation);
    });
    setOrder({ keys, generations });
    if (focusedRow !== null && nextFocus < 0) setFocusedRow(null);
  }
  const confirmedPair = JSON.stringify([active_entry_code ?? null, active_code]);
  const initialDraft = () => ({
    confirmedPair,
    mode: active_entry_code ? "chain" : "single",
    entry: active_entry_code || "",
    exit: active_code || "",
  });
  const [draft, setDraft] = useState(initialDraft);
  if (draft.confirmedPair !== confirmedPair) setDraft(initialDraft());
  const heading = useRef<HTMLHeadingElement>(null);
  const tracking = useOperationTracking();
  const manualSwitch = manualMainSwitch(tracking);
  const request = manualSwitch?.requested;
  const mode = request?.mode ?? draft.mode;
  const entry = request ? request.entry_code ?? "" : draft.entry;
  const exit = request?.code ?? draft.exit;
  const { switchTo } = useMainActions();
  const probe = useProbeLocations();
  const feedback = useActionFeedback();
  const busy = tracking.blocking || probe.isPending;
  const reading = tracking.operation?.kind === "read" || tracking.operation?.scope === "read";
  const busyDescription = busy ? (reading ? "activity-description" : "locations-reason") : undefined;
  const selectedRequestKey = selectedRow?.id === request?.id ? selectedRow?.key : undefined;
  const requestedRow = request?.mode === "single"
    ? rows.find(({ key }) => key === selectedRequestKey) ?? rows.find(({ item }) => item.code === request.code)
    : undefined;
  const fieldsDisabled = tracking.blocking && !reading;
  const results = available.map(locationHealth);
  const checked = results.filter(({ tcp }) => tcp);
  const skipped = results.filter((result) => result.skipped).length;
  const reachable = checked.filter(({ tcp }) => tcp?.ok).length;
  const checkingAll = probe.isPending && !probe.variables?.code;
  const healthIds = useId();
  // A check writes TCP results for every non-UDP location it covers; show progress exactly there.
  function liveHealth(loc: LocationDto) {
    const result = locationHealth(loc);
    const checking = !result.udp && probe.isPending && (!probe.variables?.code || probe.variables.code === loc.code);
    return { ...result, checking, state: checking ? "checking" : result.state, label: checking ? "checking" : result.label };
  }
  const canApply =
    entry !== exit &&
    [entry, exit].every((code) => available.some((loc) => loc.code === code)) &&
    !(entry === active_entry_code && exit === active_code);
  function check(code?: string) {
    if (!busy)
      void feedback(
        probe.mutateAsync(code ? { code } : {}),
        () => "Ping complete. See results beside each location.",
      );
  }
  return (
    <div className="box locations-box" data-marker="locations">
      <div className="box-title box-title-row">
        <h2 className="box-heading" tabIndex={-1} ref={heading}>{"locations · " + available.length}</h2>
      </div>
      {!available.length && (
        <p className="empty-state" data-marker="locations-empty">
          {status.subscription_url
            ? "No locations yet. Refresh the subscription to load them."
            : "No subscription yet. Add its URL above to load locations."}
        </p>
      )}
      <RouteFinder status={status} mobile={mobile} heading={heading} />
      <div className="main-composer" data-marker="main-composer">
        <div className="t-seg main-mode" role="group" aria-label="Main connection mode">
          {["single", "chain"].map((value) => (
            <button
              type="button"
              key={value}
              data-ui-variant="bracket"
              className="t-seg-btn"
              data-marker={"main-mode-" + value}
              disabled={busy}
              aria-describedby={busyDescription}
              aria-pressed={mode === value}
              onClick={() => setDraft({ ...draft, mode: value })}
            >
              {active_code && (value === "chain") === !!active_entry_code ? (
                <>
                  <span className="main-mode-active" data-marker="main-mode-active" aria-hidden="true">■</span>
                  {value === "single" ? "Single location" : "Chain"}
                  <span className="visually-hidden"> (active)</span>
                </>
              ) : value === "single" ? "Single location" : "Chain"}
            </button>
          ))}
        </div>
        {available.length > 0 && (
          // Ping is a node-reachability tool for the list below; it never tests a route's traffic.
          <div className="location-ping-bar" data-marker="location-ping-bar">
            <span className="location-ping-label">TCP ping</span>
            <p className="location-check-summary" data-marker="location-check-summary" role="status">
              {status.health_updated_at ? (
                <>
                  <span>{reachable} reachable · {checked.length} checked{skipped ? ` · ${skipped} skipped` : ""}</span>
                  <span>last {formatDateTime(status.health_updated_at)}</span>
                </>
              ) : (
                <span>shows whether each server answers</span>
              )}
            </p>
            <ActionButton
              marker="btn-check-all"
              className="check-all-btn"
              idle="ping all"
              pending="pinging"
              busy={checkingAll}
              aria-disabled={busy}
              aria-describedby={busyDescription}
              onClick={() => check()}
            />
          </div>
        )}
        {manualSwitch && request?.mode === "single" && !requestedRow && (
          <div className="main-switch-orphan">
            <span>{routeName(status, request.code, null, { exit_name: request.name })}</span>
            <SwitchStatus operation={manualSwitch.operation} />
          </div>
        )}
        {mode === "chain" && (
          <>
            <div className="chain-fields">
              {(["entry", "exit"] as const).map((role) => {
                const first = role === "entry";
                const value = first ? entry : exit;
                const label = first ? "Entry location" : "Exit location";
                const options = available.map((loc) => ({
                  value: loc.code,
                  label: splitName(loc.name || loc.code).head,
                  description: liveHealth(loc).label,
                  disabled: fieldsDisabled || loc.code === (first ? exit : entry),
                }));
                const option = options.find((option) => option.value === value);
                const chosen = available.find((loc) => loc.code === value);
                const health = chosen && liveHealth(chosen);
                const healthId = healthIds + "-" + role + "-health";
                const savedName = first ? request?.entry_name : request?.name;
                const caption = option?.label ?? (value ? splitName(savedName || value).head : "Choose");
                return (
                  <div key={role} className="chain-field">
                    <span aria-hidden="true">{first ? "1 · Entry" : "2 · Exit"}</span>
                    <Select
                      rich
                      marker={"chain-" + role}
                      variant="device"
                      minWidth={CHAIN_MENU_MIN_WIDTH}
                      disabled={fieldsDisabled}
                      caption={caption}
                      label={label}
                      triggerLabel={label + ": " + caption}
                      describedBy={[health ? healthId : "", busyDescription].join(" ").trim()}
                      value={value}
                      onSelect={(value) => setDraft({ ...draft, [role]: value })}
                      options={options}
                    />
                    {health && (
                      <span id={healthId} className={"chain-location-health health health-" + health.state}
                        data-marker={"chain-" + role + "-health"} data-state={health.state}>
                        <span className={"health-dot " + (health.checking ? "probing" : health.state)} aria-hidden="true" />
                        <span className="health-latency">{health.label}</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="chain-apply">
              {manualSwitch
                ? <SwitchStatus operation={manualSwitch.operation} />
                : <span className="t-note">home → entry → exit → internet</span>}
              <Button
                marker="chain-apply"
                className="t-btn"
                variant="bracket"
                disabled={busy || !canApply}
                aria-describedby={busyDescription}
                onClick={() => switchTo({ code: exit, entry_code: entry })}
              >
                Apply chain
              </Button>
            </div>
            {available.some((loc) => [entry, exit].includes(loc.code) && /^hysteria/.test(loc.protocol)) && (
              <p className="t-note" data-marker="chain-hysteria-hint">
                Hysteria in chains is unverified. Router validation checks support before applying.
              </p>
            )}
          </>
        )}
      </div>
      {!reading && (
        <p
          id="locations-reason"
          className={tracking.blocking && !manualSwitch && !probe.isPending ? "t-note" : "visually-hidden"}
          data-marker="locations-reason"
        >
          {tracking.blockReason || (busy ? "Checking locations" : "")}
        </p>
      )}
      <ul className="t-list" hidden={mode === "chain"} aria-label="Main locations">
        {rows.map(({ item: loc, key }) => {
          const active = !active_entry_code && loc.code === active_code;
          const requested = requestedRow?.key === key;
          const { checking, state, label: health, udp } = liveHealth(loc);
          const { head, tier } = splitName(loc.name || loc.code);
          const priority = failover?.enabled ? failover.whitelist.indexOf(loc.code) : -1;
          return (
            <li
              key={(order.generations.get(key) ?? 0) + ":" + key}
              onFocus={() => setFocusedRow(key)}
              onBlur={() => setFocusedRow(null)}
              className={"t-row" + (active ? " active-row" : "")}
              data-marker="loc-row"
              data-code={loc.code}
            >
              <button
                type="button"
                className="loc-select"
                data-marker="loc-select"
                data-code={loc.code}
                aria-current={active || undefined}
                aria-disabled={busy}
                aria-describedby={busyDescription}
                onClick={() => {
                  if (busy || active) return;
                  const id = switchTo({ code: loc.code, entry_code: null });
                  if (id) setSelectedRow({ id, key });
                }}
              >
                <span className="caret" aria-hidden="true" />
                <span className="loc-identity">
                  <span className="name">
                    {head}
                    {tier && <span className="tier">{tier}</span>}
                  </span>
                  {active && mobile && <span className="loc-current">current</span>}
                </span>
                <span className="loc-meta">
                  {priority >= 0 && (
                    <span className="wl-pos" title="Failover priority">
                      #{priority + 1}
                    </span>
                  )}
                  {badges[loc.protocol] && <span className="proto-badge">{badges[loc.protocol]}</span>}
                  <span className="code">{loc.code}</span>
                </span>
                <span className={"health health-" + state}>
                  <span className={"health-dot " + (checking ? "probing" : state)} aria-hidden="true" />
                  <span className="health-latency">{health}</span>
                </span>
                {requested && <span className="visually-hidden">, requested</span>}
              </button>
              <button
                type="button"
                className={"probe-btn terminal-icon-action" + (mobile ? " mobile-icon-button" : "")}
                data-marker="btn-probe"
                data-code={loc.code}
                data-busy={checking}
                aria-busy={checking}
                aria-disabled={busy || udp}
                aria-label={udp ? "Ping unavailable for " + head : "ping " + head}
                title={udp ? "Ping is unavailable for UDP locations" : "ping " + head}
                aria-describedby={busyDescription}
                onClick={() => {
                  if (!udp) check(loc.code);
                }}
              >
                {mobile && !checking ? (
                  <MobileIcon name="refresh" />
                ) : (
                  <span
                    className={"probe-glyph" + (checking ? " terminal-action-glyph" : "")}
                    aria-hidden="true"
                  >
                    {checking ? "" : "↻"}
                  </span>
                )}
              </button>
              {requested && manualSwitch && <SwitchStatus operation={manualSwitch.operation} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
