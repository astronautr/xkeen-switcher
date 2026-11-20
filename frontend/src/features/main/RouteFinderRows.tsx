import { Fragment, useId, useRef, useState } from "react";
import type { LocationDto, RouteCheckRow } from "../../api/types";
import { Button } from "../../ui/Button";
import { Chevron } from "../../ui/Chevron";
import { formatDateTime, formatTime } from "../../ui/format";

export const STATES: Record<string, { glyph: string; label: string }> = {
  working: { glyph: "✓", label: "Working" },
  unstable: { glyph: "~", label: "Unstable" },
  failed: { glyph: "×", label: "Failed" },
  unsupported: { glyph: "!", label: "Unsupported" },
  unavailable: { glyph: "?", label: "Check unavailable" },
  stale: { glyph: "…", label: "Stale" },
  unchecked: { glyph: "·", label: "Unchecked" },
  queued: { glyph: "·", label: "Queued" },
  checking: { glyph: "", label: "Checking" },
};

const routeLabel = (row: RouteCheckRow) =>
  (row.entry_code ? (row.entry_name || row.entry_code) + " → " : "") + (row.exit_name || row.exit_code);

type RowProps = {
  row: RouteCheckRow;
  badge?: string;
  skipped?: string;
  chainDisabled: boolean;
  onChain?: (code: string) => void;
  reasonId: string;
  disabled: boolean;
  onApply: (row: RouteCheckRow) => void;
};

function ResultDetails({ row, skipped, id }: { row: RouteCheckRow; skipped?: string; id: string }) {
  const prior = row.outcome && STATES[row.outcome]?.label;
  const unavailableAttempt = prior && row.outcome !== "unavailable" ? row.last_attempt : null;
  const note = row.state === "stale" ? row.stale_reason : row.reason;
  return (
    <div className="route-row-details" id={id} data-marker="route-row-details">
      {row.entry_code && <p>{routeLabel(row)}</p>}
      {skipped && <p>Single check · {skipped}</p>}
      {unavailableAttempt && <p>Last attempt {formatTime(unavailableAttempt.finished_at)} · {unavailableAttempt.reason}</p>}
      {note && <p>{note}</p>}
      {row.checked_at && (
        <p className="route-row-checked">
          Checked <time dateTime={row.checked_at}>{formatDateTime(row.checked_at)}</time>{prior && " · " + prior}
        </p>
      )}
      {row.rounds.map((round, index) => (
        <div className="route-round" key={index}>
          <p className="route-round-head">Round {index + 1} · {round.ok ? "passed" : "failed"}</p>
          <ul>
            {round.results.map((result) => (
              <li key={result.url} data-ok={String(result.ok)}>
                <span aria-hidden="true">{result.ok ? "✓" : "×"}</span>
                <span className="route-round-target">{result.url}</span>
                <span>
                  {result.ok
                    ? (result.status ?? "ok") + (result.latency_ms == null ? "" : " · " + result.latency_ms + " ms")
                    : result.error || "failed"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ResultRow({ row, reasonId, disabled, badge, skipped, onApply, onChain, chainDisabled }: RowProps) {
  const [opened, setOpened] = useState<{ row: RouteCheckRow; skipped?: string } | null>(null);
  const detailsId = useId();
  const route = routeLabel(row);
  const face = STATES[row.state] ?? STATES.unchecked!;
  const unavailableAttempt = row.outcome && row.outcome !== "unavailable" && row.last_attempt;
  const hasDetails = !!(opened || row.rounds.length || row.stale_reason || row.reason || row.checked_at || unavailableAttempt || skipped);
  const shortcut = onChain && (row.state === "failed" || row.state === "unstable");
  const label = skipped ? "Skipped" : face.label + (unavailableAttempt ? " · retry failed" : "");
  const State = hasDetails ? "button" : "span";
  return (
    <li className="route-row" data-marker="route-row" data-key={row.key} data-state={skipped ? "skipped" : row.state} data-entry={row.entry_code} data-exit={row.exit_code}>
      <span className="route-row-name">{row.entry_name || row.entry_code || row.exit_name || row.exit_code}
        {badge && <> <span className="proto-badge">{badge}</span></>}
        {row.on_main && <> <span className="route-row-main" data-marker="route-on-main">On Main</span></>}
      </span>
      <span className="route-row-status">
        <State
          className={"route-row-state" + (row.state === "checking" ? " terminal-icon-action" : "")}
          data-marker={hasDetails ? "route-row-toggle" : undefined}
          data-state={skipped ? "skipped" : row.state}
          data-busy={row.state === "checking"}
          {...(hasDetails ? {
            type: "button",
            "aria-label": label + " · details for " + route,
            "aria-expanded": !!opened,
            "aria-controls": opened ? detailsId : undefined,
            onClick: () => setOpened(opened ? null : { row, skipped }),
          } : {})}
        >
          {row.state === "checking" ? (
            <span className="terminal-action-glyph" aria-hidden="true" />
          ) : (
            <span className="route-row-glyph" aria-hidden="true">{face.glyph}</span>
          )}
          <span>{label}</span>
          {hasDetails && <Chevron direction={opened ? "up" : "down"} />}
        </State>
      </span>
      <span className="route-row-actions">
      {!row.on_main && row.applicable ? (
        <Button
          marker="route-apply"
          variant="bracket"
          className="t-btn route-row-apply"
          aria-label={"Apply " + route + " to Main"}
          aria-disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
          onClick={() => {
            if (!disabled) onApply(row);
          }}
        >
          Apply
        </Button>
      ) : null}
      {shortcut && <button type="button" className="route-row-chain" data-marker="route-chain-shortcut"
        aria-label={"Find chains to " + row.exit_name} aria-disabled={chainDisabled}
        title={chainDisabled ? "Another exit is being checked" : undefined}
        onClick={() => { if (!chainDisabled) onChain(row.exit_code); }}>chain →</button>}
      </span>
      {opened && <ResultDetails {...opened} id={detailsId} />}
    </li>
  );
}

export function stateLabel(row?: RouteCheckRow, direct = false) {
  if (!row || row.state === "unchecked") return direct ? "not checked directly" : "not checked";
  const face = STATES[row.state]!;
  return [face.glyph, face.label + (direct ? " directly" : "")].filter(Boolean).join(" ");
}

export function protocolBadge(protocol: string | undefined) {
  if (protocol === "shadowsocks") return "ss";
  if (protocol === "hysteria" || protocol === "hysteria2") return "hy2";
}

type PickerProps = {
  single: boolean;
  mobile: boolean;
  disabled: boolean;
  chosen: string[];
  locations: LocationDto[];
  direct: Map<string, RouteCheckRow>;
  presets: {label: string; codes: string[]}[];
  onChange: (codes: string[]) => void;
  onDone: () => void;
};

export function RoutePicker({ single, mobile, disabled, chosen, locations, direct, presets, onChange, onDone }: PickerProps) {
  const tapped = useRef<string | null>(null);
  return <div className="route-pick" role="group" aria-label={single ? "Choose locations to check" : "Choose entries to check"}>
    <div className="route-pick-bar">
      <span className="route-pick-count" role="status">{chosen.length} of {locations.length} chosen</span>
      <span className="route-pick-presets">{presets.map(({ label, codes }, index) => (
        <Fragment key={label}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <button type="button" data-marker={"route-preset-" + label.replace(" ", "-")} aria-disabled={disabled}
            onClick={() => { if (!disabled) onChange(codes); }}>{label}</button>
        </Fragment>
      ))}</span>
      <Button marker="route-pick-done" variant="bracket" className="t-btn route-pick-done" onClick={onDone}>done</Button>
    </div>
    <ul className="route-pick-list">{locations.map(({code, name, protocol}) => {
      const included = chosen.includes(code);
      const badge = protocolBadge(protocol);
      return <li key={code}><label className="route-pick-row"
        onPointerDown={event => { tapped.current = mobile && event.pointerType === "touch" ? code : null; }}
        onPointerCancel={() => { tapped.current = null; }}
        onKeyDown={() => { tapped.current = null; }}>
        <input type="checkbox" className="route-pick-input" checked={included} aria-disabled={disabled} data-marker={"route-pick-" + code}
          aria-label={name} onChange={() => {
            if (disabled) return;
            onChange(included ? chosen.filter(c => c !== code) : [...chosen, code]);
            if (tapped.current === code) onDone();
            tapped.current = null;
          }} />
        <span className={"wl-check" + (included ? " on" : "")} aria-hidden="true" />
        <span className="route-pick-name">{name}{badge && <> <span className="proto-badge">{badge}</span></>}</span>
        <span className="route-pick-last" data-state={direct.get(code)?.state}>{stateLabel(direct.get(code), !single)}</span>
      </label></li>;
    })}</ul>
  </div>;
}
