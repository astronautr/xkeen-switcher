import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { OVERLAY_MOVE_EVENT } from "../../../src/ui/overlays";
const SIZE = 44;
const GAP = 8;
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 520;
type ViewportBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
function readViewportBounds(widget: HTMLElement): ViewportBounds {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? innerWidth;
  const height = viewport?.height ?? innerHeight;
  const style = getComputedStyle(widget);
  return {
    minX: left + (parseFloat(style.paddingLeft) || 16),
    maxX: left + width - (parseFloat(style.paddingRight) || 16),
    minY: top + (parseFloat(style.paddingTop) || 16),
    maxY: top + height - (parseFloat(style.paddingBottom) || 16),
  };
}
function launcherPosition(bounds: ViewportBounds, owner: HTMLElement | null | undefined) {
  const { minX, maxX, minY, maxY } = bounds;
  let x = maxX - SIZE;
  let y = maxY - SIZE;
  if (owner?.isConnected && !owner.hidden) {
    const box = owner.getBoundingClientRect();
    if (box.width && box.height) {
      y = Math.max(minY, Math.min(maxY - SIZE, box.bottom - SIZE));
      if (box.left - GAP - SIZE >= minX) x = box.left - GAP - SIZE;
      else if (box.right + GAP + SIZE <= maxX) x = box.right + GAP;
      else {
        x = box.left;
        y = Math.max(minY, Math.min(y, box.top - GAP - SIZE));
      }
    }
  }
  x = Math.max(minX, Math.min(maxX - SIZE, x));
  return { x, y };
}
function positionPanel(node: HTMLElement, bounds: ViewportBounds, x: number, y: number) {
  const { minX, maxX, minY } = bounds;
  const panelWidth = Math.min(PANEL_WIDTH, maxX - minX);
  node.style.width = panelWidth + "px";
  node.style.left = Math.max(minX, Math.min(maxX - panelWidth, x + SIZE - panelWidth)) + "px";
  node.style.bottom = innerHeight - y + GAP + "px";
  node.style.maxHeight = Math.max(0, Math.min(PANEL_HEIGHT, y - GAP - minY)) + "px";
}
export type LegacyActivityIndicatorProps = {
  open: boolean;
  visible?: boolean;
  active?: boolean;
  attention?: boolean;
  label?: string;
  description: string;
  children?: ReactNode;
  anchor?: RefObject<HTMLElement | null>;
  onOpenChange: (value: boolean) => void;
};
/** Indicator delay and notification lifetimes belong to the controller, not this view. */
export function LegacyActivityIndicator({
  open,
  visible = true,
  active = false,
  attention = false,
  label = "No active operations",
  description,
  children,
  anchor,
  onOpenChange,
}: LegacyActivityIndicatorProps) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const position = useCallback(() => {
    const widget = host.current;
    const node = panel.current;
    const button = launcher.current;
    if (!widget || !node || !button || !visible) return;
    const bounds = readViewportBounds(widget);
    // Inside a modal the page anchor is covered and inert; use the viewport corner instead.
    const modal = widget.closest("dialog");
    const owner = anchor?.current;
    const { x, y } = launcherPosition(bounds, owner && (!modal || modal.contains(owner)) ? owner : null);
    button.style.left = x + "px";
    button.style.top = y + "px";
    positionPanel(node, bounds, x, y);
  }, [anchor, visible]);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    if (open && visible) {
      if (!node.matches(":popover-open")) node.showPopover();
      node.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    } else if (node.matches(":popover-open")) node.hidePopover();
    position();
  }, [open, visible, position]);
  useEffect(() => {
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.addEventListener(OVERLAY_MOVE_EVENT, position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener(OVERLAY_MOVE_EVENT, position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [position]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !launcher.current?.contains(event.target)
      )
        change.current(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        change.current(false);
        launcher.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div ref={host} className="activity-widget">
      <button
        ref={launcher}
        hidden={!visible}
        data-active={String(active)}
        data-attention={String(attention)}
        type="button"
        className="activity-launcher"
        data-marker="btn-activity"
        aria-label={"Activity: " + label}
        aria-haspopup="dialog"
        aria-controls="activity-panel"
        aria-expanded={open}
        aria-describedby="activity-description"
        onClick={() => change.current(!open)}
      >
        <span className="activity-prompt" aria-hidden="true">
          &gt;<span className="activity-cursor">_</span>
        </span>
        <span className="activity-dot" aria-hidden="true" />
        <span className="activity-alert-glyph" aria-hidden="true">
          !
        </span>
      </button>
      <span
        className="activity-description"
        id="activity-description"
        data-marker="activity-description"
      >
        {description}
      </span>
      <section
        ref={panel}
        className="activity-panel"
        id="activity-panel"
        role="dialog"
        aria-labelledby="activity-title"
        popover="manual"
        hidden={!open || !visible}
        data-marker="activity-panel"
      >
        <div className="activity-header">
          <h2 className="activity-title" id="activity-title">
            activity
          </h2>
          <button
            type="button"
            className="activity-close"
            data-marker="activity-close"
            aria-label="Close activity"
            onClick={() => {
              change.current(false);
              launcher.current?.focus({ preventScroll: true });
            }}
          >
            ×
          </button>
        </div>
        <div className="activity-content" data-marker="activity-content">
          {children ?? <p className="activity-empty">{label}</p>}
        </div>
      </section>
    </div>
  );
}
