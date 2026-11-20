import { useRef } from "react";
import type { AutoUpdateInput, FailoverConfig, StatusDto, FailoverDto } from "../../api/types";
import { ActionButton } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Toggle } from "../../ui/Toggle";
import { withOccurrenceKeys } from "../../ui/listKeys";
import { formatMoscow, formatDateTime } from "../../ui/format";
import { healthProbe } from "../main/model";

function duration(seconds: number | undefined) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function AutoUpdateSection({ value, onChange, status }: {
  value: AutoUpdateInput;
  onChange: (value: AutoUpdateInput) => void;
  status: StatusDto;
}) {
  const intervalLabel = value.sni_daily
    ? "minutes after the first non-SNI change"
    : "minutes after the first change";
  const saved = status.auto_update;
  const lastValid = useRef({ interval: saved.interval_minutes, time: saved.daily_time });
  // The API validates both fields, even when the chosen schedule hides one of them.
  function change(next: AutoUpdateInput) {
    const intervalValid = Number.isInteger(next.interval_minutes) &&
      next.interval_minutes >= 5 && next.interval_minutes <= 10080;
    const timeValid = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.daily_time);
    if (intervalValid) lastValid.current.interval = next.interval_minutes;
    if (timeValid) lastValid.current.time = next.daily_time;
    const intervalEditable = next.enabled && next.mode === "interval";
    const timeEditable = next.enabled && (next.mode === "daily" || next.sni_daily);
    onChange({
      ...next,
      interval_minutes: intervalValid || intervalEditable ? next.interval_minutes : lastValid.current.interval,
      daily_time: timeValid || timeEditable ? next.daily_time : lastValid.current.time,
    });
  }
  const timing = !saved.enabled ? "auto-update off"
    : status.xkeen_state === "stopped" ? "paused · xkeen stopped"
    : saved.next_apply_at ? Date.parse(saved.next_apply_at) <= Date.now()
      ? "due · checking shortly" : formatMoscow(saved.next_apply_at)
    : "waiting for a new config";
  const timeField = (marker: string, label: string) => (
    <label className="t-field">
      <span className="auto-update-label">{label}</span>
      <Field marker={marker} type="time" required value={value.daily_time}
        disabled={!value.enabled} aria-label={label}
        onChange={(event) => change({ ...value, daily_time: event.currentTarget.value })} />
    </label>
  );
  return (
    <section className="box auto-update-box" data-marker="auto-update-section">
      <h2 className="box-title">apply location updates</h2>
      <Toggle marker="auto-update-enabled" checked={value.enabled}
        onChange={(enabled) => change({ ...value, enabled })}>apply updates automatically</Toggle>
      <p className="t-note">apply new settings from your provider. this restarts XKeen.</p>
      <label className="t-field">
        <span className="auto-update-label">schedule</span>
        <select data-marker="auto-update-mode" aria-label="auto-update schedule"
          disabled={!value.enabled} value={value.mode}
          onChange={(event) => change({ ...value, mode: event.currentTarget.value as AutoUpdateInput["mode"] })}>
          <option value="daily">daily at a set time</option>
          <option value="interval">after an interval</option>
        </select>
      </label>
      {value.mode === "daily" ? timeField("auto-update-time", "time · Moscow (UTC+3)") : (
        <label className="t-field">
          <span className="auto-update-label">{intervalLabel}</span>
          <Field marker="auto-update-interval" type="number" min={5} max={10080} step={1}
            required disabled={!value.enabled} value={Number.isNaN(value.interval_minutes) ? "" : value.interval_minutes}
            aria-label={intervalLabel}
            onChange={(event) => change({ ...value, interval_minutes: event.currentTarget.valueAsNumber })} />
        </label>
      )}
      {value.mode === "interval" && (
        <div className="auto-update-sni" data-marker="auto-update-sni-section">
          <Toggle marker="auto-update-sni-daily" checked={value.sni_daily} disabled={!value.enabled}
            onChange={(sni_daily) => change({ ...value, sni_daily })}>apply SNI-only updates daily</Toggle>
          {value.sni_daily && <div>
            <p className="t-note">other config changes follow the interval and include pending SNI updates.</p>
            {timeField("auto-update-sni-time", "SNI apply time · Moscow (UTC+3)")}
          </div>}
        </div>
      )}
      <details className="auto-update-details">
        <summary data-marker="auto-update-details">how updates work</summary>
        <p>before applying an update, the subscription is refreshed. if the refresh fails, the update stays pending. no pending changes means no restart. a missed daily run waits until the next day. the first pending change starts the interval; later changes keep the deadline.</p>
        {value.mode === "interval" && value.sni_daily && <p>SNI-only changes wait for the daily time. any other change to Main or a used device location starts the interval; all pending changes are then applied together. changes are compared with the installed configuration.</p>}
        <p>apply now and failover recovery can apply updates earlier, even when scheduled updates are off.</p>
      </details>
      <div className={`auto-update-status ${saved.enabled && saved.next_apply_at ? "scheduled" : "idle"}`}
        role="status" data-marker="auto-update-timing">
        <span className="auto-update-caption">{saved.enabled && saved.next_apply_at ? "next apply" : "status"}</span>
        <span className="auto-update-status-value">{timing}</span>
      </div>
    </section>
  );
}

export function FailoverSection({ value, onChange, status, data, onChecks, onProbe, probing, blocked, checkCount }: {
  value: FailoverConfig;
  onChange: (value: FailoverConfig) => void;
  status: StatusDto;
  data: FailoverDto;
  onChecks: () => void;
  onProbe: () => void;
  probing: boolean;
  blocked: boolean;
  checkCount?: number;
}) {
  const ordered = [...status.available].sort((a, b) => {
    const rank = (code: string) => value.whitelist.includes(code) ? value.whitelist.indexOf(code) : value.whitelist.length;
    return rank(a.code) - rank(b.code);
  });
  function move(code: string, delta: number) {
    const whitelist = [...value.whitelist];
    const index = whitelist.indexOf(code);
    [whitelist[index], whitelist[index + delta]] = [whitelist[index + delta]!, whitelist[index]!];
    onChange({ ...value, whitelist });
  }
  const checkedHealth = Object.values(data.runtime.map).map((health) => healthProbe(health)).filter((probe) => probe != null);
  const alive = checkedHealth.filter((probe) => probe.ok).length;
  return (
    <section className="box fo-box" data-marker="fo-section">
      <div className="box-title">failover</div>
      {status.failover.suspended && status.failover.suspension_reason === "chain_active" && (
        <p className="t-note" data-marker="failover-paused">
          Automatic failover paused · chain active. Settings and whitelist are kept{status.failover.enabled ? "; failover resumes in single mode." : "."}
        </p>
      )}
      <div className="fo-section-head">
        <Toggle marker="fo-enabled" checked={value.enabled}
          onChange={(enabled) => onChange({ ...value, enabled })}>switch if the connection fails</Toggle>
      </div>
      <p className="t-note">first is preferred. others are backups.</p>
      <div className="fo-subhead">locations <span>{`${value.whitelist.length} of ${status.available.length}`}</span></div>
      <div className="fo-wl">
        {withOccurrenceKeys(ordered, (location) => location.code).map(({ item: location, key }) => {
          const parts = /^(.+?)\s+(\d+(?:gbit|mbit|kbit)\S*.*)$/i.exec(location.name);
          const head = parts?.[1] ?? location.name;
          const tier = parts?.[2];
          const index = value.whitelist.indexOf(location.code);
          const included = index >= 0;
          const probe = included ? healthProbe(data.runtime.map[location.code]) : null;
          return (
            <div key={key} className={`fo-wl-row${included ? "" : " off"}`}>
              <label className="wl-select">
                <Field marker={`wl-check-${location.code}`} type="checkbox" checked={included}
                  aria-label={`include ${head}`}
                  onChange={() => onChange({ ...value, whitelist: included
                    ? value.whitelist.filter((code) => code !== location.code)
                    : [...value.whitelist, location.code] })} />
                <span className={`wl-check${included ? " on" : ""}`} aria-hidden="true" />
                {/* The whole row selects the location; the checkbox keeps its explicit name. */}
                <span className={`wl-pos-chip${included ? "" : " empty"}`} aria-hidden="true">{included ? `#${index + 1}` : "·"}</span>
                <span className="wl-name" aria-hidden="true">{head}{tier && <span className="tier">{tier}</span>}</span>
                <span className="health">{probe && <>
                  <span className={`health-dot ${probe.ok ? "ok" : "fail"}`} />
                  <span className="health-latency">{(probe.method === "socks" ? "SOCKS " : "") + (probe.ok ? probe.latency_ms == null ? "ok" : `${probe.latency_ms}ms` : "failed")}</span>
                </>}</span>
              </label>
              <span className="wl-arrows">{included && <>
                <button type="button" data-marker={`wl-up-${location.code}`} className="wl-arrow" disabled={index === 0}
                  aria-label="move up" onClick={() => move(location.code, -1)}>↑</button>
                <button type="button" data-marker={`wl-down-${location.code}`} className="wl-arrow" disabled={index === value.whitelist.length - 1}
                  aria-label="move down" onClick={() => move(location.code, 1)}>↓</button>
              </>}</span>
            </div>
          );
        })}
      </div>
      <div className="fo-actions">
        <ActionButton marker="btn-check-now" className="fo-check-btn" idle="check selected" pending="checking"
          aria-describedby={blocked ? "activity-description" : undefined}
          busy={probing} disabled={blocked || probing || !value.whitelist.length} onClick={onProbe} />
      </div>
      {data.runtime.updated_at && <div className="fo-last-check">{`last: ${formatDateTime(data.runtime.updated_at)} · ${alive} of ${checkedHealth.length} alive`}</div>}
      <div className="fo-subhead">recovery</div>
      <div className="fo-opts">
        <Toggle marker="fo-failback" checked={value.auto_failback}
          onChange={(auto_failback) => onChange({ ...value, auto_failback })}>return to the preferred location</Toggle>
        <Toggle marker="fo-stop" checked={value.auto_stop_on_total_failure}
          onChange={(auto_stop_on_total_failure) => onChange({ ...value, auto_stop_on_total_failure,
            auto_restart_on_recovery: auto_stop_on_total_failure && value.auto_restart_on_recovery })}>stop XKeen if all locations fail</Toggle>
        {status.failover.auto_stop_suspended_for_devices && <p className="fo-last-check">Auto-stop is paused while devices have fixed locations, so their exits keep running.</p>}
        <div className="fo-opt-nested">
          <Toggle marker="fo-restart" checked={value.auto_restart_on_recovery} disabled={!value.auto_stop_on_total_failure}
            onChange={(auto_restart_on_recovery) => onChange({ ...value, auto_restart_on_recovery })}>start again when a location recovers</Toggle>
        </div>
      </div>
      <button type="button" data-marker="settings-checks" className="settings-link" onClick={onChecks}>
        <span>
          <span className="settings-link-name">test sites</span>
          <span className="t-note">{(checkCount == null ? "" : `${checkCount} sites · `) + "used by check server route, failover and Find a working route"}</span>
        </span>
        <span className="settings-chevron" aria-hidden="true">›</span>
      </button>
      <details className="auto-update-details">
        <summary data-marker="fo-check-timing">check timing</summary>
        <p>every {duration(data.env_constants.check_interval_sec)} · switch after {data.env_constants.fail_threshold} failed checks · wait {duration(data.env_constants.grace_after_switch_sec)} after switching</p>
      </details>
    </section>
  );
}
