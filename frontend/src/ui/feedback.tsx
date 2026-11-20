import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";
export function DisabledReason({
  id,
  text,
  marker = "disabled-reason",
}: {
  id: string;
  text: string;
  marker?: string;
}) {
  return (
    <p id={id} className="ui-disabled-reason" data-marker={marker}>
      {text}
    </p>
  );
}
export function Notice({
  title,
  detail,
  kind = "neutral",
  actions,
}: {
  title: string;
  detail?: string;
  kind?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`notice ${kind}`}>
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
      {actions ? <div className="inline-actions">{actions}</div> : null}
    </section>
  );
}
export function Banner({
  tone,
  prefix,
  children,
}: {
  tone: string;
  prefix: string;
  children: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`}>
      <span className="banner-pfx">{prefix}</span>
      <span>{children}</span>
    </div>
  );
}
export type ConfirmStripProps = {
  marker: string;
  id?: string;
  tone?: "danger";
  message: string;
  detail?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  cancelMarker?: string;
  confirmMarker?: string;
  onCancel: () => void;
  onConfirm: () => void;
  autoFocus?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  className?: string;
};
export function ConfirmStrip({
  marker,
  id = marker,
  tone,
  message,
  detail,
  cancelLabel = "cancel",
  confirmLabel = "confirm",
  cancelMarker = marker + "-cancel",
  confirmMarker = marker + "-confirm",
  onCancel,
  onConfirm,
  autoFocus = false,
  returnFocus,
  className = "",
}: ConfirmStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      returnFocus?.current?.focus({ preventScroll: true });
    };
  }, [autoFocus, returnFocus]);
  return (
    <div
      ref={ref}
      className={`ui-confirm-strip${tone ? " ui-tone-" + tone : ""}${className ? " " + className : ""}`}
      role="group"
      aria-labelledby={id + "-question"}
      data-marker={marker}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="ui-confirm-question" id={id + "-question"}>
        {message}
      </p>
      {detail ? <p className="ui-confirm-detail">{detail}</p> : null}
      <div className="ui-action-group">
        <Button marker={cancelMarker} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          marker={confirmMarker}
          variant={tone === "danger" ? "danger" : "primary"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
