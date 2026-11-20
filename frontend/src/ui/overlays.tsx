import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type DialogHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
type OverlayRegistry = {
  host: HTMLElement;
  register: (node: HTMLElement) => () => void;
  addHost: (node: HTMLElement) => () => void;
};
const OverlayContext = createContext<OverlayRegistry | null>(null);
/** Fired after overlay hosts move between the document and a modal, so fixed controls can re-measure. */
export const OVERLAY_MOVE_EVENT = "xk-overlay-move";
function moveHost(host: HTMLElement, target: HTMLElement) {
  if (host.parentNode === target) return;
  try {
    relocate(host, target);
  } finally {
    window.dispatchEvent(new Event(OVERLAY_MOVE_EVENT));
  }
}
function relocate(host: HTMLElement, target: HTMLElement) {
  const focused = host.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : null;
  const popovers = Array.from(host.querySelectorAll<HTMLElement>(":popover-open"));
  // Moving a live popover preserves its old top-layer position behind a newer modal.
  // Reopen it in the destination so its controls can receive pointer and keyboard input.
  try {
    if (!popovers.length && host.isConnected && target.isConnected && "moveBefore" in target) {
      target.moveBefore(host, null);
      return;
    }
  } catch {
    /* Older engines fall back to the same nodes with native top-layer restoration. */
  }
  for (const popup of popovers) popup.hidePopover();
  target.append(host);
  for (const popup of popovers) popup.showPopover();
  focused?.focus({ preventScroll: true });
}
/** Overlay children survive navigation and auth gates; callers retain timer policy. */
export function OverlayProvider({
  children,
  overlay,
}: {
  children: ReactNode;
  overlay?: ReactNode;
}) {
  const [host] = useState(() => document.createElement("div"));
  const stack = useRef<HTMLElement[]>([]);
  const extraHosts = useRef(new Set<HTMLElement>());
  const [registry] = useState<OverlayRegistry>(() => {
    const target = () => stack.current.at(-1) ?? document.body;
    const rehost = () => {
      for (const container of [host, ...extraHosts.current]) moveHost(container, target());
    };
    return {
      host,
      register: (node) => {
        stack.current.push(node);
        rehost();
        return () => {
          stack.current = stack.current.filter((item) => item !== node);
          rehost();
        };
      },
      addHost: (node) => {
        extraHosts.current.add(node);
        moveHost(node, target());
        return () => {
          extraHosts.current.delete(node);
          node.remove();
        };
      },
    };
  });
  useLayoutEffect(() => {
    if (!host.isConnected) document.body.append(host);
    return () => host.remove();
  }, [host]);
  return (
    <OverlayContext value={registry}>
      {children}
      {createPortal(overlay, host)}
    </OverlayContext>
  );
}
/** A dedicated direct-child host preserves legacy dialog > .toast-stack CSS. */
export function OverlayPortal({
  children,
  className,
  live,
}: {
  children: ReactNode;
  className?: string;
  live?: "polite" | "assertive";
}) {
  const context = useContext(OverlayContext);
  const [host] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    host.className = className ?? "";
    if (live) host.setAttribute("aria-live", live);
    else host.removeAttribute("aria-live");
  }, [host, className, live]);
  useLayoutEffect(() => context?.addHost(host), [context, host]);
  return context ? createPortal(children, host) : null;
}
export function NotificationPortal({ children }: { children: ReactNode }) {
  return (
    <OverlayPortal className="toast-stack" live="polite">
      {children}
    </OverlayPortal>
  );
}
export function visibleControls(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>("button,input,select,textarea,a[href],[tabindex],summary"),
  ).filter(
    (node) =>
      node.tabIndex >= 0 &&
      !node.matches(":disabled") &&
      !node.closest("[hidden],[inert]") &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden" &&
      (!node.closest("[popover]") || node.closest("[popover]")!.matches(":popover-open")),
  );
}
export type DialogProps = Omit<DialogHTMLAttributes<HTMLDialogElement>, "open" | "onClose"> & {
  open: boolean;
  marker: string;
  onClose: () => void;
  initialFocus?: string;
  returnFocus?: RefObject<HTMLElement | null>;
};
export function Dialog({
  open,
  marker,
  onClose,
  initialFocus,
  returnFocus,
  children,
  ...props
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const context = useContext(OverlayContext);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  useLayoutEffect(() => {
    const node = ref.current!;
    if (!open) return;
    const previous = returnFocus?.current ?? (document.activeElement as HTMLElement | null);
    if (!node.open) node.showModal();
    const unregister = context?.register(node);
    (initialFocus ? node.querySelector<HTMLElement>(initialFocus) : null)?.focus({
      preventScroll: true,
    });
    // Synthetic events follow the React parent. The native listener also covers
    // controls in rehosted portals without replacing their DOM or resetting timers.
    const trap = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Tab" ||
        node !== Array.from(document.querySelectorAll("dialog:modal")).at(-1)
      )
        return;
      const controls = visibleControls(node);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        node.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !node.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !node.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const closed = () => {
      if (!node.open) closeCallback.current();
    };
    node.addEventListener("keydown", trap);
    node.addEventListener("close", closed);
    return () => {
      node.removeEventListener("keydown", trap);
      node.removeEventListener("close", closed);
      unregister?.();
      if (node.open) node.close();
      // React restores the commit's previously focused portal control after layout
      // cleanup. Restore the trigger after that commit, unless another modal reopened.
      queueMicrotask(() => {
        if (!node.open && previous?.isConnected) previous.focus({ preventScroll: true });
      });
    };
  }, [open, context, initialFocus, returnFocus]);
  return (
    <dialog
      {...props}
      ref={ref}
      data-marker={marker}
      onCancel={(event) => {
        event.preventDefault();
        closeCallback.current();
      }}
    >
      {children}
    </dialog>
  );
}
