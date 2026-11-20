import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { OperationDto, StatusDto } from "../../api/types";
import { useStatus } from "../../api/queries";
import { useActivity, useNotifications, useOperationTracking } from "../../app/AppSessionProvider";
import { activityPresentation, operationTarget, phaseLabel } from "../../operations/policy";
import { formatTime } from "../../ui/format";
import { Chevron } from "../../ui/Chevron";
import { useMobile } from "../../ui/mobile";
import { OVERLAY_MOVE_EVENT, OverlayPortal } from "../../ui/overlays";
import { useDeviceUndo } from "../devices/common";
import { describeEvent } from "./describeEvent";
import { ActivityFeed, FEED_FILTERS, type FeedFilter } from "./HistoryEntries";
import { OperationStatus } from "./OperationStatus";
import { Toasts } from "./Toasts";
import { useSheetGestures, type Snap } from "./sheetGestures";

/** The delay starts when this work first appears. Phase updates share the original deadline. */
function useDelayedIndicator(key: string | null, delay: number) {
  const started = useRef({ key, at: Date.now() });
  const [ready, setReady] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (started.current.key !== key) started.current = { key, at: Date.now() };
    if (!key || !delay) {
      setReady(null);
      return;
    }
    const remaining = started.current.at + delay - Date.now();
    if (remaining <= 0) {
      setReady(key);
      return;
    }
    setReady(null);
    const timer = window.setTimeout(() => setReady(key), remaining);
    return () => window.clearTimeout(timer);
  }, [key, delay]);
  return key !== null && (!delay || ready === key);
}

/** Overlay hosts move into the topmost modal; the page dock is replaced by a transient bar there. */
function useInsideModal(node: RefObject<HTMLElement | null>) {
  const [inside, setInside] = useState(false);
  useLayoutEffect(() => {
    const measure = () => setInside(!!node.current?.closest("dialog"));
    measure();
    window.addEventListener(OVERLAY_MOVE_EVENT, measure);
    return () => window.removeEventListener(OVERLAY_MOVE_EVENT, measure);
  }, [node]);
  return inside;
}

type StatusFace = { state: "idle" | "busy" | "attention"; glyph: string; title: string; detail: string };

function statusFace(status: StatusDto, operation: OperationDto | null, active: boolean, unresolved: boolean,
  label: string, failures: string[]): StatusFace {
  if (unresolved && operation) return { state: "attention", glyph: "!", title: label, detail: phaseLabel(operation.phase) };
  if (failures.length) {
    return { state: "attention", glyph: "!", title: failures[0]!, detail: failures.length > 1 ? `+${failures.length - 1} more` : "" };
  }
  if (active && operation) {
    const target = operationTarget(operation);
    const detail = operation.kind === "route_checks" ? operation.message ?? "" : phaseLabel(operation.phase);
    const separator = operation.kind === "route_checks" ? " · " : " ";
    return { state: "busy", glyph: ">_", title: label + (target ? separator + target : ""), detail };
  }
  return {
    state: "idle", glyph: ">_", title: "idle",
    detail: status.last_update_at ? "last update " + formatTime(status.last_update_at) : "",
  };
}

/**
 * The single activity surface: live operation, problems, this browser's notifications and the router log.
 * On the dashboard it is a docked status line that reserves page space; elsewhere it appears only while
 * an operation or a problem needs it.
 */
export function ActivitySheet({ dock, hidden = false }: { dock: boolean; hidden?: boolean }) {
  const status = useStatus().data;
  const { items, clear } = useNotifications();
  const { activity: routerActivity, attention, acknowledge, ownEvents, routeCheck } = useActivity();
  const tracking = useOperationTracking();
  // Router operations keep the headline. Diagnostics can also be read in the expanded panel.
  const checking = !routerActivity.active && routeCheck ? routeCheck : null;
  const activity = checking ? activityPresentation(checking) : routerActivity;
  const operation = checking ?? tracking.operation;
  const device = useDeviceUndo();
  const mobile = useMobile();
  const root = useRef<HTMLElement>(null);
  const statusline = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scroll = useRef<Record<FeedFilter, number>>({ all: 0, local: 0, router: 0, problems: 0 });
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [snap, setSnap] = useState<Snap>(0);
  const active = useDelayedIndicator(activity.key, activity.delay);
  const insideModal = useInsideModal(root);
  const expanded = snap > 0;

  const failures = status ? Object.entries(attention).map(([group, event]) => ({ group, message: describeEvent(event, status) })) : [];
  const needsAttention = activity.attention || failures.length > 0;
  const docked = dock && !insideModal;
  const visible = !!status && !hidden && (docked || needsAttention || active || expanded);
  const face = status
    ? statusFace(status, operation, active, activity.attention, activity.label, failures.map((failure) => failure.message))
    : null;
  const description = failures.length
    ? activity.description + " " + failures.map((failure) => failure.message).join(". ")
    : activity.description;

  const collapse = useCallback((focus = true) => {
    if (content.current) scroll.current[filter] = content.current.scrollTop;
    setSnap(0);
    if (focus) statusline.current?.focus({ preventScroll: true });
  }, [filter]);
  const gestures = useSheetGestures({ enabled: mobile && visible, sheet: root, list: content, snap, onSnap: setSnap });

  useLayoutEffect(() => {
    if (!visible && snap) setSnap(0);
  }, [visible, snap]);

  // The page keeps room for the docked sheet, so its last controls can scroll above it.
  useLayoutEffect(() => {
    const reserve = docked && visible;
    document.body.classList.toggle("activity-ready", reserve);
    return () => document.body.classList.remove("activity-ready");
  }, [docked, visible]);

  useLayoutEffect(() => {
    if (expanded && content.current) content.current.scrollTop = scroll.current[filter];
  }, [filter, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog:modal") && !insideModal) return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    };
    // Mobile keeps the page live under an open sheet; the desktop panel floats and closes like a popover.
    const pointer = (event: PointerEvent) => {
      if (mobile || !(event.target instanceof Element)) return;
      if (root.current?.contains(event.target) || event.target.closest(".toast-stack")) return;
      collapse(false);
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, [expanded, mobile, collapse, insideModal]);

  function selectFilter(next: FeedFilter) {
    if (gestures.consumeClick()) return;
    if (content.current) scroll.current[filter] = content.current.scrollTop;
    setFilter(next);
  }
  function clearInbox() {
    clear();
    scroll.current = { all: 0, local: 0, router: 0, problems: 0 };
    statusline.current?.focus({ preventScroll: true });
  }
  function toggle() {
    if (gestures.consumeClick()) return;
    if (expanded) collapse();
    else {
      setSnap(1);
      // Safari does not focus buttons on click; keyboard closing and focus return start here.
      statusline.current?.focus({ preventScroll: true });
    }
  }

  const details = activity.active && operation && status ? (
    <OperationStatus status={status} operation={operation} own={checking ? !!checking.local : tracking.local}
      requested={checking ? null : tracking.requested} />
  ) : null;
  const routeDetails = routeCheck && !checking && status ? (
    <OperationStatus status={status} operation={routeCheck} own={!!routeCheck.local} requested={null} />
  ) : null;
  const showsLocal = filter !== "router";

  return (
    <>
      <OverlayPortal className="activity-host">
        <section
          ref={root}
          className="activity-sheet"
          id="activity-sheet"
          aria-label="activity"
          hidden={!visible}
          data-marker="activity-sheet"
          data-docked={String(docked)}
          data-mobile={String(mobile)}
          data-snap={snap}
          data-state={face?.state ?? "idle"}
        >
          {mobile && <div className="activity-grip" aria-hidden="true" data-sheet-drag />}
          <button
            ref={statusline}
            type="button"
            className="activity-statusline"
            data-marker="btn-activity"
            data-sheet-drag
            data-state={face?.state ?? "idle"}
            data-active={String(active && !needsAttention)}
            data-attention={String(needsAttention)}
            aria-expanded={expanded}
            aria-controls="activity-panel"
            aria-describedby="activity-description"
            onClick={toggle}
          >
            {expanded ? (
              <span className="activity-statusline-text">
                <span className="activity-crumb" aria-hidden="true">~</span>
                <span aria-hidden="true">/</span>activity
                {face?.state === "idle" && face.detail && <span className="activity-statusline-detail">{" · " + face.detail}</span>}
              </span>
            ) : face && (
              <>
                <span className="activity-glyph" aria-hidden="true">
                  {face.state === "busy" ? <>&gt;<span className="activity-cursor">_</span></> : face.glyph}
                </span>
                <span className="activity-statusline-text" data-marker="activity-status">
                  <span className="activity-statusline-title">{face.title}</span>
                  {face.detail && <span className="activity-statusline-detail">{" · " + face.detail}</span>}
                </span>
              </>
            )}
            <Chevron className="activity-chevron" direction={expanded ? "down" : "up"} />
          </button>
          <span className="activity-description" id="activity-description" data-marker="activity-description">{description}</span>
          <div className="activity-panel" id="activity-panel" hidden={!expanded && !gestures.dragging} data-marker="activity-panel">
            {(details || routeDetails || failures.length > 0) && (
              <div className="activity-now" data-marker="activity-now">
                {details}
                {routeDetails}
                {failures.length > 0 && (
                  <section className="activity-attention" data-marker="background-attention">
                    <strong>! needs attention</strong>
                    {failures.map(({ group, message }) => <p key={group}>{message}</p>)}
                    <button type="button" className="t-btn" data-ui-variant="bracket" data-marker="attention-read" onClick={acknowledge}>
                      mark as read
                    </button>
                  </section>
                )}
              </div>
            )}
            <div className="activity-filters" role="group" aria-label="show" data-sheet-drag>
              {FEED_FILTERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="activity-filter"
                  aria-pressed={option === filter}
                  aria-controls="activity-content"
                  data-marker={"activity-filter-" + option}
                  onClick={() => selectFilter(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <div
              ref={content}
              className="activity-content"
              id="activity-content"
              role="region"
              aria-label="activity entries"
              data-marker="activity-content"
              data-filter={filter}
            >
              {status && <ActivityFeed filter={filter} items={items} status={status} device={device} ownEvents={ownEvents} />}
              <div className="activity-scope" data-marker="activity-scope">
                <span>{showsLocal ? "this browser keeps the last 100" : "router log · latest events"}</span>
                {showsLocal && items.length > 0 && (
                  <button
                    type="button"
                    className="t-btn"
                    data-ui-variant="bracket"
                    aria-label="clear notifications saved in this browser"
                    data-marker="notifications-clear"
                    onClick={clearInbox}
                  >
                    clear
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </OverlayPortal>
      <Toasts device={device} launcherRef={statusline} />
    </>
  );
}
