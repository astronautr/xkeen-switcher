import { useLayoutEffect, useReducer, useRef } from "react";

type Request = { form: true } | { form?: false; marker: string | null };
const FIRST_CONTROL = "select:not(:disabled), input:not(:disabled), textarea:not(:disabled), button:not(:disabled)";

// Inline forms replace the buttons that open them. Move focus into a new form and,
// when the form or a row closes, back to its trigger or the card heading.
export function useCardFocus<T extends HTMLElement>() {
  const card = useRef<T>(null);
  const request = useRef<Request | null>(null);
  const [, render] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    const next = request.current;
    const root = card.current;
    if (!next || !root) return;
    request.current = null;
    const active = document.activeElement;
    // Leave focus alone when the person has already moved elsewhere.
    if (active && active !== document.body && !root.contains(active)) return;
    if (next.form) {
      root.querySelector<HTMLElement>("form " + FIRST_CONTROL.split(", ").join(", form "))?.focus();
      return;
    }
    const trigger = next.marker ? root.querySelector<HTMLButtonElement>(`[data-marker="${next.marker}"]`) : null;
    (trigger && !trigger.disabled ? trigger : root.querySelector<HTMLElement>("h3"))?.focus();
  });
  return {
    card,
    focusForm() { request.current = { form: true }; render(); },
    returnTo(marker: string | null) { request.current = { marker }; render(); },
  };
}
