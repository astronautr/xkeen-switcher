import type { ReactNode } from "react";
import { Field } from "./Field";

export function Toggle({ marker, checked, disabled, onChange, children }: {
  marker: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={`fo-toggle ${marker.startsWith("auto-update") ? "auto-update-toggle " : ""}${checked ? "on" : "off"}${disabled ? " disabled" : ""}`} data-marker={`tgl-${marker}`}>
      <Field marker={marker} className="fo-toggle-input" type="checkbox" checked={checked} disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className="switch" aria-hidden="true" style={{ pointerEvents: "none" }} />
      <span>{children}</span>
    </label>
  );
}
