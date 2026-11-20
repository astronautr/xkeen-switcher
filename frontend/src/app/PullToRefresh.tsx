import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { isRoutingHash } from "./navigation";

const threshold = 120;
const editable = "input,textarea,select,[contenteditable]:not([contenteditable=false])";

function allowed() {
  return !document.hidden && !isRoutingHash(location.hash) &&
    (document.scrollingElement?.scrollTop ?? 0) <= 0 &&
    (window.visualViewport?.scale ?? 1) === 1 &&
    !document.activeElement?.closest(editable) &&
    !document.querySelector('dialog[open],.inline-name-input,.settings-password,.app.drawer-open,[data-marker="subscription-editor"]:not([hidden]),.activity-sheet:not([hidden]):not([data-snap="0"])');
}

function scrollable(target: Element) {
  for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY))
      return true;
  }
  return false;
}

export function PullToRefresh() {
  const [standalone] = useState(() =>
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia("(display-mode: standalone)").matches
  );
  const [distance, setDistance] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!standalone) return;
    const controller = new AbortController();
    const passive = { signal: controller.signal, passive: true };
    const active = { ...passive, passive: false };
    let gesture: { id: number; x: number; y: number; distance: number; pulling: boolean } | null = null;
    let pendingFrame: number | null = null;
    function reset() {
      gesture = null;
      setDistance(null);
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
      setRefreshing(false);
    }
    function start(event: TouchEvent) {
      if (pendingFrame !== null) return;
      reset();
      const target = event.target;
      if (event.touches.length !== 1 || !(target instanceof Element) || !allowed() ||
          target.closest("button,a,summary,[role=button],.activity-sheet," + editable) || scrollable(target)) return;
      const touch = event.touches[0]!;
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, distance: 0, pulling: false };
    }
    function move(event: TouchEvent) {
      if (!gesture) return;
      const touch = event.touches[0];
      if (!event.cancelable || !allowed() || event.touches.length !== 1 || touch?.identifier !== gesture.id) {
        reset();
        return;
      }
      const dx = Math.abs(touch.clientX - gesture.x);
      const dy = touch.clientY - gesture.y;
      if (!gesture.pulling) {
        if (dy < 0 || (dx > 6 && dx >= dy)) return reset();
        if (dy <= dx) return;
        gesture.pulling = true;
      }
      event.preventDefault();
      gesture.distance = Math.max(0, dy);
      setDistance(gesture.distance);
    }
    function end(event: TouchEvent) {
      if (!gesture) return;
      if (event.touches.length || gesture.distance < threshold || !allowed()) return reset();
      if (event.cancelable) event.preventDefault();
      gesture = null;
      setRefreshing(true);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = requestAnimationFrame(() => location.reload());
      });
    }
    document.documentElement.classList.add("pull-refresh-enabled");
    document.addEventListener("touchstart", start, passive);
    document.addEventListener("touchmove", move, active);
    document.addEventListener("touchend", end, active);
    document.addEventListener("touchcancel", reset, passive);
    document.addEventListener("visibilitychange", reset, passive);
    window.addEventListener("pagehide", reset, passive);
    window.addEventListener("pageshow", reset, passive);
    return () => {
      controller.abort();
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      document.documentElement.classList.remove("pull-refresh-enabled");
    };
  }, [standalone]);
  if (!standalone) return null;
  const ready = distance !== null && distance >= threshold;
  return createPortal(
    <div className={"pull-refresh" + (ready ? " is-ready" : "") + (refreshing ? " is-refreshing" : "")}
      hidden={distance === null} data-marker="pull-to-refresh" role="status" aria-live="polite" aria-atomic="true"
      style={{ "--pull-offset": Math.min(80, (distance ?? 0) / 2) + "px" } as CSSProperties}>
      <span className="pull-refresh-icon" aria-hidden="true">{refreshing ? "↻" : "↓"}</span>
      <span>{refreshing ? "Refreshing" : ready ? "Release to refresh" : distance !== null ? "Pull to refresh" : ""}</span>
    </div>, document.body
  );
}
