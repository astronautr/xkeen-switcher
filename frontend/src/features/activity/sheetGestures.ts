import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 0 is the status line, 1 the default open height, 2 the full screen. */
export type Snap = 0 | 1 | 2;

const THRESHOLD = 6;
const FLING = 0.45;
const STRONG_FLING = 1.4;
const OPEN_RATIO = 0.78;
const FULL_GAP = 8;
const RUBBER = 0.2;

type Gesture = { y0: number; h0: number; lastY: number; lastT: number; v: number; mode: "sheet" | "scroll" | null; pointer?: number };

function px(value: string) {
  return parseFloat(value) || 0;
}

export type SnapHeights = (sheet: HTMLElement) => [number, number, number];

/** Open and full heights for a sheet whose closed position is 0 (it closes instead of docking). */
export function closingSnapHeights(): [number, number, number] {
  const viewport = window.visualViewport?.height ?? innerHeight;
  const top = Math.max(px(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")), FULL_GAP);
  const full = Math.round(viewport - top);
  return [0, Math.min(full, Math.round(viewport * OPEN_RATIO)), full];
}

function snapHeights(sheet: HTMLElement): [number, number, number] {
  const viewport = window.visualViewport?.height ?? innerHeight;
  const style = getComputedStyle(sheet);
  const grip = sheet.querySelector<HTMLElement>(".activity-grip")?.offsetHeight ?? 0;
  const line = sheet.querySelector<HTMLElement>(".activity-statusline")?.offsetHeight ?? 0;
  const collapsed = Math.round(grip + line + px(style.paddingBottom) + px(style.borderTopWidth));
  const top = Math.max(px(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")), FULL_GAP);
  const full = Math.max(collapsed, Math.round(viewport - top));
  return [collapsed, Math.min(full, Math.max(collapsed, Math.round(viewport * OPEN_RATIO))), full];
}

function nearest(heights: number[], height: number, velocity: number): Snap {
  if (Math.abs(velocity) > FLING) {
    if (Math.abs(velocity) > STRONG_FLING) return velocity > 0 ? 2 : 0;
    if (velocity > 0) {
      const next = heights.findIndex((value) => value > height + 4);
      return (next < 0 ? 2 : next) as Snap;
    }
    for (let index = heights.length - 1; index >= 0; index--) if (heights[index]! < height - 4) return index as Snap;
    return 0;
  }
  return heights.reduce((best, value, index) => Math.abs(value - height) < Math.abs(heights[best]! - height) ? index : best, 0) as Snap;
}

/**
 * Mobile bottom-sheet gestures. Handles ([data-sheet-drag]) always move the sheet; the list
 * first grows the sheet to full height and collapses it when pulled down from its top.
 */
export function useSheetGestures({ enabled, sheet, list, snap, onSnap, heights: measure = snapHeights, reserve = true }: {
  enabled: boolean;
  sheet: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
  snap: Snap;
  onSnap: (snap: Snap) => void;
  /** Snap heights; defaults to the docked Activity sheet. */
  heights?: SnapHeights;
  /** Reserve page space for a docked sheet. Modal sheets leave the page unchanged. */
  reserve?: boolean;
}) {
  const snapHeights = measure;
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const height = useRef(0);
  const suppress = useRef(false);
  const current = useRef({ snap, onSnap });
  current.current = { snap, onSnap };

  const apply = useCallback((value: number, animate: boolean) => {
    const node = sheet.current;
    if (!node) return;
    height.current = value;
    node.classList.toggle("is-animating", animate);
    node.style.setProperty("--sheet-h", value + "px");
    if (reserve) document.documentElement.style.setProperty("--activity-reserve", value + "px");
  }, [sheet, reserve]);

  useLayoutEffect(() => {
    const node = sheet.current;
    if (!enabled || !node) return;
    const place = (animate: boolean) => apply(snapHeights(node)[current.current.snap], animate);
    place(true);
    const resize = () => { if (!gesture.current?.mode) place(false); };
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [enabled, snap, sheet, apply, snapHeights]);

  useLayoutEffect(() => () => {
    sheet.current?.style.removeProperty("--sheet-h");
    if (reserve) document.documentElement.style.removeProperty("--activity-reserve");
  }, [enabled, sheet, reserve]);

  useLayoutEffect(() => {
    const node = sheet.current;
    const scroller = list.current;
    if (!enabled || !node || !scroller) return;
    const begin = (y: number, t: number): Gesture => ({ y0: y, h0: height.current, lastY: y, lastT: t, v: 0, mode: null });
    const track = (g: Gesture, y: number, t: number) => {
      const dt = t - g.lastT;
      if (dt > 0) g.v = 0.7 * g.v + 0.3 * ((g.lastY - y) / dt);
      g.lastY = y;
      g.lastT = t;
    };
    const drag = (g: Gesture, y: number) => {
      const [min, , max] = snapHeights(node);
      let value = g.h0 + (g.y0 - y);
      if (value > max) value = max + (value - max) * RUBBER;
      if (value < min) value = min - (min - value) * RUBBER;
      apply(Math.round(value), false);
    };
    const start = () => setDragging(true);
    const finish = (g: Gesture) => {
      const heights = snapHeights(node);
      const next = nearest(heights, height.current, g.v);
      apply(heights[next], true);
      setDragging(false);
      current.current.onSnap(next);
    };

    const down = (event: PointerEvent) => {
      if (event.button || !(event.target instanceof Element) || !event.target.closest("[data-sheet-drag]")) return;
      gesture.current = { ...begin(event.clientY, event.timeStamp), pointer: event.pointerId };
    };
    const move = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.pointer !== event.pointerId) return;
      track(g, event.clientY, event.timeStamp);
      if (!g.mode && Math.abs(event.clientY - g.y0) > THRESHOLD) {
        g.mode = "sheet";
        start();
      }
      if (g.mode === "sheet") drag(g, event.clientY);
    };
    const up = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.pointer !== event.pointerId) return;
      gesture.current = null;
      if (g.mode !== "sheet") return;
      suppress.current = true;
      window.setTimeout(() => { suppress.current = false; }, 0);
      finish(g);
    };

    const touchStart = (event: TouchEvent) => {
      if (gesture.current || event.touches.length !== 1) return;
      // A top-layer menu lives inside the sheet in the DOM but scrolls on its own.
      if (event.target instanceof Element && event.target.closest(":popover-open")) return;
      gesture.current = begin(event.touches[0]!.clientY, event.timeStamp);
    };
    const touchMove = (event: TouchEvent) => {
      const g = gesture.current;
      if (!g || g.pointer !== undefined) return;
      const y = event.touches[0]!.clientY;
      track(g, y, event.timeStamp);
      if (!g.mode && Math.abs(y - g.y0) > THRESHOLD) {
        const up = y < g.y0;
        g.mode = (up && current.current.snap < 2) || (!up && scroller.scrollTop <= 0) ? "sheet" : "scroll";
        if (g.mode === "sheet") {
          g.y0 = y;
          g.h0 = height.current;
          start();
        }
      }
      if (g.mode === "sheet") {
        event.preventDefault();
        drag(g, y);
      }
    };
    const touchEnd = () => {
      const g = gesture.current;
      if (!g || g.pointer !== undefined) return;
      gesture.current = null;
      if (g.mode === "sheet") finish(g);
    };

    // Moves are read from the window: the finger leaves the short bar at once, and capturing the
    // pointer before the drag starts would retarget the click of a simple tap.
    node.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    scroller.addEventListener("touchstart", touchStart, { passive: true });
    scroller.addEventListener("touchmove", touchMove, { passive: false });
    scroller.addEventListener("touchend", touchEnd);
    scroller.addEventListener("touchcancel", touchEnd);
    return () => {
      gesture.current = null;
      node.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      scroller.removeEventListener("touchstart", touchStart);
      scroller.removeEventListener("touchmove", touchMove);
      scroller.removeEventListener("touchend", touchEnd);
      scroller.removeEventListener("touchcancel", touchEnd);
    };
  }, [enabled, sheet, list, apply, snapHeights]);

  return {
    dragging,
    /** True once after a drag, so the click that ends it does not also toggle a control. */
    consumeClick: () => suppress.current,
  };
}
