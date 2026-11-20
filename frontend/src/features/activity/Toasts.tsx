import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useNotifications } from "../../app/AppSessionProvider";
import type { Notification } from "../../browser/storage";
import { NotificationPortal, visibleControls } from "../../ui/overlays";
import { DeviceUndoButton, type DeviceUndo } from "./HistoryEntries";

const TOAST_VISIBLE_MS = 6000;
const TOAST_FADE_MS = 400;

type ToastProps = {
  item: Notification;
  id: number;
  device: DeviceUndo;
  dismiss: (id: number) => void;
  launcherRef: RefObject<HTMLButtonElement | null>;
};

function Toast({ item, id, device, dismiss, launcherRef }: ToastProps) {
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const deviceId = item.device_operation;

  useLayoutEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    if (hovered || focused) return;
    let removeTimer: ReturnType<typeof setTimeout> | undefined;
    const fadeTimer = setTimeout(() => {
      setShown(false);
      removeTimer = setTimeout(() => dismiss(id), TOAST_FADE_MS);
    }, TOAST_VISIBLE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, [hovered, focused, dismiss, id]);

  function dismissByButton() {
    const toast = root.current;
    if (toast?.contains(document.activeElement)) {
      // Return keyboard users to the active dialog when its underlying launcher is inert.
      const dialog = toast.closest("dialog");
      const next = dialog
        ? visibleControls(dialog).find((control) => !toast.contains(control))
        : launcherRef.current;
      next?.focus({ preventScroll: true });
    }
    dismiss(id);
  }

  return (
    <div
      ref={root}
      className={"toast has-action" + (item.error ? " error" : "") + (shown ? " show" : "")}
      role="status"
      aria-atomic="true"
      data-marker="toast"
      data-pending={String(!!deviceId && device.undoing === deviceId)}
      onPointerEnter={() => {
        setHovered(true);
        setShown(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => {
        setFocused(true);
        setShown(true);
      }}
      onBlur={(event) => setFocused(event.currentTarget.contains(event.relatedTarget))}
    >
      <span className="toast-copy">{item.message}</span>
      {deviceId && <DeviceUndoButton id={deviceId} device={device} marker="device-toast-undo" plain />}
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss notification"
        data-marker={deviceId ? "device-toast-dismiss" : "toast-dismiss"}
        onClick={dismissByButton}
      >
        ×
      </button>
    </div>
  );
}

export function Toasts({ device, launcherRef }: Pick<ToastProps, "device" | "launcherRef">) {
  const { subscribePublished } = useNotifications();
  const [visible, setVisible] = useState<{ id: number; item: Notification }[]>([]);
  const sequence = useRef(0);
  useLayoutEffect(() => subscribePublished((item) => {
    const next = { id: ++sequence.current, item };
    setVisible((current) => [...current, next]);
  }), [subscribePublished]);
  const dismiss = useCallback((id: number) => {
    setVisible((current) => current.filter((toast) => toast.id !== id));
  }, []);

  if (!visible.length) return null;
  return (
    <NotificationPortal>
      {visible.map(({ id, item }) => (
        <Toast key={id} id={id} item={item} device={device} dismiss={dismiss} launcherRef={launcherRef} />
      ))}
    </NotificationPortal>
  );
}
