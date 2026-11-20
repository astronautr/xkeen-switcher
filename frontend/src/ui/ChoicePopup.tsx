import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent,
} from "react";
import { visibleControls } from "./overlays";
import { Button } from "./Button";
import { withOccurrenceKeys } from "./listKeys";
import { clearValidity, englishValidity } from "./Field";
import { Chevron } from "./Chevron";
export type ChoiceOption = {
  value: string;
  label: string;
  disabled?: boolean;
  separated?: boolean;
  suffix?: string;
  /** Visible secondary text announced as a description, so names and typeahead keep the label. */
  description?: string;
  count?: number;
  state?: string;
};
export type ChoiceProps = {
  marker: string;
  label: string;
  options: readonly ChoiceOption[];
  value?: string | ReadonlySet<string>;
  onSelect: (value: string) => void;
  disabled?: boolean;
  fieldId?: string;
  className?: string;
  triggerClass?: string;
  popupClass?: string;
  optionClass?: string;
  variant?: "bracket" | "device";
  caption?: string;
  title?: string;
  triggerLabel?: string;
  describedBy?: string;
  minWidth?: number;
  onOpenChange?: (open: boolean) => void;
};
export function ChoicePopup({
  marker,
  label,
  options,
  value,
  onSelect,
  disabled = false,
  fieldId,
  className = "ui-select",
  triggerClass,
  popupClass,
  optionClass,
  variant,
  caption: customCaption,
  title,
  triggerLabel,
  describedBy,
  minWidth = 178,
  onOpenChange,
  kind = "select",
}: ChoiceProps & { kind?: "select" | "menu" }) {
  const generated = useId();
  const id = "ui-popup-" + generated;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const search = useRef({ text: "", at: 0 });
  const multiple = typeof value !== "string" && value != null;
  const selected = (option: ChoiceOption) =>
    multiple
      ? option.value === "all"
        ? !value.size
        : value.has(option.value)
      : option.value === value;
  const device = variant === "device";
  const selectedOption = options.find(selected);
  const caption = customCaption ?? (kind === "menu" ? label : (selectedOption?.label ?? label));
  const optionStyle = optionClass ?? (device ? "menu-option" : "ui-choice-option");
  const close = useCallback((restore: boolean) => {
    const node = popup.current;
    if (node?.matches(":popover-open")) node.hidePopover();
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  }, []);
  const enabled = () =>
    Array.from(popup.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
  function focusItem(index: number) {
    const items = enabled();
    const node = items[(index + items.length) % items.length];
    node?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: "nearest" });
  }
  const position = useCallback(() => {
    const owner = trigger.current;
    const node = popup.current;
    if (!owner || !node) return;
    if (!owner.isConnected) {
      close(false);
      return;
    }
    const rect = owner.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    const gap = 8;
    const below = top + height - rect.bottom - gap;
    const above = rect.top - top - gap;
    node.style.width = Math.min(Math.max(rect.width, minWidth), Math.max(0, width - 24)) + "px";
    const down = node.scrollHeight <= below - gap || below >= above;
    node.style.maxHeight = Math.max(0, (down ? below : above) - gap) + "px";
    node.style.left =
      Math.max(
        left + 12,
        Math.min(rect.left, left + width - node.getBoundingClientRect().width - 12),
      ) + "px";
    node.style.top =
      (down
        ? rect.bottom + gap
        : Math.max(top + gap, rect.top - node.getBoundingClientRect().height - gap)) + "px";
  }, [close, minWidth]);
  function show(last = false) {
    if (disabled) return;
    popup.current?.showPopover();
    setOpen(true);
    position();
    const items = enabled();
    const current = items.findIndex((node) => node.getAttribute("aria-selected") === "true");
    focusItem(last ? items.length - 1 : Math.max(0, current));
  }
  useLayoutEffect(() => {
    if (open) position();
  }, [open, options, position]);
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, position]);
  function focusAfterTrigger(event: KeyboardEvent) {
    if (!trigger.current) return;
    const scope = trigger.current.closest<HTMLElement>("dialog:modal") ?? document.body;
    const controls = visibleControls(scope);
    const next = controls[controls.indexOf(trigger.current) + (event.shiftKey ? -1 : 1)];
    if (next) {
      event.preventDefault();
      next.focus({ preventScroll: true });
    }
  }
  function focusNavigationItem(key: string, index: number, itemCount: number) {
    let next = index + (key === "ArrowDown" ? 1 : -1);
    if (key === "Home") next = 0;
    else if (key === "End") next = itemCount - 1;
    focusItem(next);
  }
  function focusTypeaheadItem(key: string, items: HTMLButtonElement[], index: number) {
    const now = Date.now();
    search.current = {
      text: now - search.current.at > 700 ? key : search.current.text + key,
      at: now,
    };
    let query = search.current.text.toLocaleLowerCase("en");
    if ([...query].every((char) => char === query[0])) query = query[0]!;
    for (let i = 1; i <= items.length; i++) {
      const next = (index + i) % items.length;
      const candidate = items[next];
      if (candidate?.getAttribute("aria-label")?.toLocaleLowerCase("en").startsWith(query)) {
        focusItem(next);
        break;
      }
    }
  }
  function handlePopupKeydown(event: KeyboardEvent) {
    const items = enabled();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close(true);
      if (event.key === "Tab") focusAfterTrigger(event);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      focusNavigationItem(event.key, index, items.length);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key !== " "
    ) {
      event.preventDefault();
      focusTypeaheadItem(event.key, items, index);
    }
  }
  const triggerProps = {
    ref: trigger,
    id: fieldId ?? "ui-choice-" + generated,
    disabled,
    title,
    "aria-label":
      triggerLabel ?? (kind !== "menu" && selectedOption ? label + ": " + caption : label),
    "aria-controls": id,
    "aria-describedby": describedBy || undefined,
    "aria-haspopup": kind === "menu" ? "menu" : "listbox",
    "aria-expanded": open,
    onClick() {
      if (open) close(false);
      else show();
    },
    onKeyDown(event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        show(event.key === "ArrowUp");
      }
    },
  } satisfies ComponentPropsWithRef<"button">;
  const controls = (
    <>
      {device ? (
        <button
          {...triggerProps}
          type="button"
          className={triggerClass ?? "menu-trigger"}
          data-marker={marker}
        >
          <span>{caption}</span>
          <Chevron />
        </button>
      ) : (
        <Button {...triggerProps} marker={marker} variant={variant} className={triggerClass}>
          {caption}
        </Button>
      )}
      <div
        ref={popup}
        id={id}
        className={popupClass ?? (device ? "device-menu" : "ui-choice-popup")}
        popover="auto"
        role={kind === "menu" ? "menu" : "listbox"}
        aria-label={label}
        aria-multiselectable={multiple ? true : undefined}
        data-marker={marker + "-popup"}
        onKeyDown={handlePopupKeydown}
        onToggle={(event) => {
          if (event.newState === "closed") setOpen(false);
        }}
      >
        {withOccurrenceKeys(options, (option) => option.value).map(({ item: option, key }, index) => (
          <button
            key={key}
            type="button"
            tabIndex={-1}
            disabled={option.disabled}
            className={optionStyle + (option.separated ? " condition-advanced" : "")}
            data-marker={marker + "-option-" + option.value}
            data-value={option.value}
            data-state={option.state}
            role={kind === "menu" ? "menuitem" : "option"}
            aria-label={option.label}
            aria-describedby={option.description != null ? id + "-description-" + index : undefined}
            aria-selected={kind === "menu" ? undefined : selected(option)}
            onClick={() => {
              if (option.disabled || disabled) return;
              if (!multiple) close(true);
              onSelect(option.value);
            }}
          >
            {kind !== "menu" ? (
              <span
                className={multiple ? "filter-menu-check" : "ui-choice-check"}
                data-choice-check=""
                aria-hidden="true"
              >
                {selected(option) ? "✓" : ""}
              </span>
            ) : null}
            <span>{option.label}</span>
            {option.description != null ? (
              <span id={id + "-description-" + index} className="condition-existing filter-menu-count choice-description">
                {option.description}
              </span>
            ) : option.suffix != null || option.count != null ? (
              <span className="condition-existing filter-menu-count">
                {option.suffix ?? option.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
  return device ? controls : <div className={className}>{controls}</div>;
}
export function Menu(props: ChoiceProps) {
  return <ChoicePopup {...props} kind="menu" />;
}
export function Select({
  rich = false,
  value,
  controlClass = "ui-select",
  ...props
}: Omit<ChoiceProps, "value"> & { value: string; rich?: boolean; controlClass?: string }) {
  return rich ? (
    <ChoicePopup {...props} value={value} />
  ) : (
    <select
      id={props.fieldId}
      aria-labelledby={props.fieldId ? props.fieldId + "-label" : undefined}
      aria-label={props.fieldId ? undefined : props.label}
      className={controlClass}
      data-marker={props.marker}
      value={value}
      disabled={props.disabled}
      onInput={clearValidity}
      onInvalid={englishValidity}
      onChange={(event) => props.onSelect(event.currentTarget.value)}
    >
      {withOccurrenceKeys(props.options, (option) => option.value).map(({ item: option, key }) => (
        <option key={key} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
