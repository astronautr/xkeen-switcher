import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  marker: string;
  ref?: Ref<HTMLButtonElement>;
  variant?: "primary" | "danger" | "bracket";
};
export function Button({
  marker,
  variant,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      data-marker={marker}
      data-ui-variant={variant === "bracket" ? variant : undefined}
      className={`ui-button${variant && variant !== "bracket" ? ` ui-button-${variant}` : ""}${className ? " " + className : ""}`}
    />
  );
}
export function ActionButton({
  idle,
  pending,
  busy = false,
  icon,
  plain = false,
  reserve = [],
  marker,
  className = "",
  ...props
}: Omit<ButtonProps, "children" | "variant"> & {
  idle: string;
  pending: string;
  busy?: boolean;
  icon?: ReactNode;
  plain?: boolean;
  /** Other idle labels this control can show; the button keeps the widest size for all of them. */
  reserve?: readonly string[];
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      data-marker={marker}
      aria-busy={busy}
      data-busy={String(busy)}
      data-action-plain={plain || icon ? "" : undefined}
      className={`${className}${className ? " " : ""}terminal-action`}
    >
      {icon ? (
        busy ? <span className="terminal-action-glyph" aria-hidden="true" /> : icon
      ) : (
        <>
          {/* Both states occupy one cell, so the control keeps the wider state's size.
              The reserve text is generated content and stays out of names and textContent. */}
          <span className="terminal-action-face terminal-action-reserve" aria-hidden="true">
            <span data-label={idle} />
          </span>
          <span className="terminal-action-face terminal-action-reserve" aria-hidden="true">
            <span data-label={pending} data-glyph="" />
          </span>
          {reserve.map((label) => (
            <span key={label} className="terminal-action-face terminal-action-reserve" aria-hidden="true">
              <span data-label={label} />
            </span>
          ))}
          <span className="terminal-action-face terminal-action-label">
            {busy ? pending : idle}
            {busy && <span className="terminal-action-glyph" aria-hidden="true" />}
          </span>
        </>
      )}
    </button>
  );
}
const ICON_PATHS: Record<string, string> = {
  pencil: "M10 3l3 3M3 10l8-8 3 3-8 8-4 1z",
  check: "M2 8l4 4L14 3",
  close: "M3 3l10 10M13 3L3 13",
  star: "M8 1.5l2 4.1 4.5.7-3.3 3.2.8 4.5-4-2.1-4 2.1.8-4.5L1.5 6.3l4.5-.7z",
  server: "M2 2.5h12v4H2zM2 9.5h12v4H2zM4 4.5h1M4 11.5h1M8 4.5h4M8 11.5h4",
};
export function IconButton({
  label,
  icon,
  busy,
  children,
  className = "",
  ...props
}: ButtonProps & { label: string; icon?: string; busy?: boolean; children?: ReactNode }) {
  return (
    <Button
      {...props}
      className={"icon-button" + (busy !== undefined ? " terminal-icon-action" : "") + (className ? " " + className : "")}
      aria-busy={busy}
      data-busy={busy}
      aria-label={label}
      title={props.title ?? label}
    >
      {busy ? <span className="terminal-action-glyph" aria-hidden="true" /> : children ?? (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        >
          {icon && ICON_PATHS[icon] ? (
            <path d={ICON_PATHS[icon]} />
          ) : (
            <use href={"/mobile-icons.svg#ico-" + (icon === "pin" ? "device-pin" : icon)} />
          )}
        </svg>
      )}
    </Button>
  );
}
