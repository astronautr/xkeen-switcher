import type { ReactNode } from "react";
import type { EventDto, StatusDto } from "../../api/types";
import type { Notification } from "../../browser/storage";
import { formatDay, formatTime } from "../../ui/format";
import { ActionButton } from "../../ui/Button";
import { withOccurrenceKeys } from "../../ui/listKeys";
import type { useDeviceUndo } from "../devices/common";
import { routeName } from "../main/model";

export type DeviceUndo = ReturnType<typeof useDeviceUndo>;

/** Shared by History and notifications. Only the invoked Undo shows progress; it keeps focus and width. */
export function DeviceUndoButton({ id, device, marker, plain = false, className }: {
  id: string;
  device: DeviceUndo;
  marker: string;
  plain?: boolean;
  className?: string;
}) {
  const operation = device.operation(id);
  const busy = device.undoing === id;
  const unavailable = busy || device.pending || (!!operation && !operation.undoable);
  return (
    <ActionButton
      plain={plain}
      className={className}
      marker={marker}
      idle={operation?.phase === "undone" ? "Undone" : "Undo"}
      pending="Undoing"
      busy={busy}
      data-device-undo={id}
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (!unavailable) void device.undo(id);
      }}
    />
  );
}

function HistoryUndo({ id, device }: { id: string; device: DeviceUndo }) {
  const operation = device.operation(id);
  return (
    <div className="device-undo">
      {operation && !operation.undoable ? (
        <div className="device-undo-state">{operation.undo_reason}</div>
      ) : (
        <DeviceUndoButton id={id} device={device} marker="device-history-undo" className="t-btn" />
      )}
    </div>
  );
}

type EntryProps = {
  marker: string;
  at: string;
  kind: string;
  prefix: string;
  message: string;
  detail?: string;
  children?: ReactNode;
};

function HistoryEntry({ marker, at, kind, prefix, message, detail, children }: EntryProps) {
  return (
    <div className="history-entry" data-marker={marker}>
      <time className="history-time" dateTime={at}>{formatTime(at)}</time>
      <div className="history-entry-copy">
        <div className="history-message">
          <span className={"t-hist-prefix " + kind}>{prefix}</span>{" " + message}
        </div>
        {detail && <div className="history-entry-meta">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

function eventMessage(item: EventDto, status: StatusDto) {
  let message = item.action || "";
  if (item.code) {
    const entry = typeof item.entry_code === "string" ? item.entry_code : null;
    message += " " + (entry ? entry + " → " : "") + item.code;
    if (routeName(status, item.code) !== item.code) {
      message += " (" + routeName(status, item.code, entry) + ")";
    }
  }
  return message + (item.message ? " · " + item.message : "");
}

const OWN_EVENT_WINDOW_MS = 120_000;

export const FEED_FILTERS = ["all", "local", "router", "problems"] as const;
export type FeedFilter = typeof FEED_FILTERS[number];

type Row = { key: string; at: string; time: number; local: boolean; problem: boolean; own: boolean; render: () => ReactNode };

function localRows(items: Notification[], device: DeviceUndo): Row[] {
  // Assign occurrence keys in insertion order so prepending an identical result keeps focus.
  const entries = withOccurrenceKeys([...items].reverse(), (item) => JSON.stringify(item)).reverse();
  return entries.map(({ item, key }) => {
    const label = item.error ? "fail" : item.neutral ? "info" : "ok";
    return {
      key: "local:" + key, at: item.at, time: Date.parse(item.at), local: true, problem: !!item.error, own: false,
      render: () => (
        <HistoryEntry key={"local:" + key} marker="notification-item" at={item.at} kind={label}
          prefix={label} message={item.message} detail="this browser">
          {typeof item.device_operation === "string" && item.device_operation && (
            <HistoryUndo id={item.device_operation} device={device} />
          )}
        </HistoryEntry>
      ),
    };
  });
}

const NO_CHANGES = "no changes";
const CHECK_EVENT_WINDOW_MS = 5000;

/** Routine refreshes are not logged; one row, replaced on every check, shows the latest one instead. */
function lastCheckRow(status: StatusDto): Row | null {
  const at = status.last_update_at;
  const time = at ? Date.parse(at) : NaN;
  if (!at || !Number.isFinite(time) || status.last_update_status !== "ok") return null;
  const logged = status.history.some((item) => item.action === "update" && item.message !== NO_CHANGES
    && Math.abs(Date.parse(item.ts) - time) <= CHECK_EVENT_WINDOW_MS);
  if (logged) return null;
  return {
    key: "router:last-check", at, time, local: false, problem: false, own: false,
    render: () => (
      <HistoryEntry key="router:last-check" marker="activity-last-check" at={at} kind="ok"
        prefix="ok" message="subscription checked · no changes" detail="router · latest check" />
    ),
  };
}

function routerRows(status: StatusDto, device: DeviceUndo, own: Set<string>): Row[] {
  // Entries written before routine refreshes stopped being logged.
  const history = status.history.filter((item) => !(item.action === "update" && item.message === NO_CHANGES));
  const check = lastCheckRow(status);
  return [...(check ? [check] : []), ...withOccurrenceKeys(history, (item) => item.event_id || JSON.stringify(item)).map(({ item, key }) => {
    const failover = item.trigger === "failover";
    const kind = failover ? "failover" : item.result === "ok" ? "ok" : "fail";
    let prefix = kind;
    if (failover && item.action === "failback") prefix = "failback";
    if (failover && item.action === "auto-recovery") prefix = "auto";
    return {
      key: "router:" + key, at: item.ts, time: Date.parse(item.ts), local: false, problem: item.result !== "ok",
      own: !!item.event_id && own.has(item.event_id) || !!item.operation_id && own.has(item.operation_id),
      render: () => (
        <HistoryEntry key={"router:" + key} marker="activity-item" at={item.ts} kind={kind}
          prefix={prefix} message={eventMessage(item, status)} detail={"router" + (item.trigger ? " · " + item.trigger : "")}>
          {typeof item.device_operation === "string" && item.device_operation && (
            <HistoryUndo id={item.device_operation} device={device} />
          )}
        </HistoryEntry>
      ),
    };
  })];
}

const EMPTY: Record<FeedFilter, string> = {
  all: "no activity yet.",
  local: "no notifications saved.",
  router: "no router events yet.",
  problems: "no problems.",
};

/**
 * One feed for this browser's notifications and the router log, newest first and grouped by day.
 * A router event caused by this browser is shown once, as its local notification, except in the router view.
 */
export function ActivityFeed({ filter, items, status, device, ownEvents }: {
  filter: FeedFilter;
  items: Notification[];
  status: StatusDto;
  device: DeviceUndo;
  ownEvents: string[];
}) {
  const own = new Set(ownEvents);
  const local = localRows(items, device);
  // A cleared inbox no longer covers its own router events, so those stay visible.
  const covered = (row: Row) => row.own && local.some((entry) => Math.abs(entry.time - row.time) <= OWN_EVENT_WINDOW_MS);
  const rows = [
    ...(filter === "router" ? [] : local),
    ...(filter === "local" ? [] : routerRows(status, device, own)),
  ].filter((row) => (filter === "problems" ? row.problem : true) && !(filter !== "router" && covered(row)))
    .sort((a, b) => (b.time || 0) - (a.time || 0));
  let day = "";
  return (
    <section className="activity-feed" data-marker="activity-feed" data-filter={filter}>
      {!rows.length && <p className="history-empty">{EMPTY[filter]}</p>}
      {rows.map((row) => {
        const current = formatDay(row.at);
        const header = current !== day;
        day = current;
        return header
          ? [<h3 key={"day:" + current} className="history-day">{current}</h3>, row.render()]
          : row.render();
      })}
    </section>
  );
}
