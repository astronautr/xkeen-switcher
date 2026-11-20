import { classifyError } from "../api/client";
const NO_VALUE = "—";
type DateValue = Date | string | number | null | undefined;
function validDate(value: DateValue) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
const formats = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, options: Intl.DateTimeFormatOptions) {
  if (!formats.has(key)) {
    try {
      formats.set(key, new Intl.DateTimeFormat("en-GB", options));
    } catch {
      formats.set(key, new Intl.DateTimeFormat(undefined, options));
    }
  }
  return formats.get(key)!;
}
export function formatTime(value: DateValue) {
  const date = validDate(value);
  return date
    ? formatter("time", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
    : NO_VALUE;
}
export function formatDateTime(value: DateValue) {
  const date = validDate(value);
  return !date
    ? NO_VALUE
    : date.toDateString() === new Date().toDateString()
      ? "today " + formatTime(date)
      : formatter("datetime", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(date);
}
export function formatDay(value: DateValue) {
  const date = validDate(value);
  return date
    ? formatter("day", { day: "numeric", month: "short", year: "numeric" }).format(date)
    : "unknown date";
}
export function formatMoscow(value: DateValue) {
  const date = validDate(value);
  return date
    ? formatter("moscow", {
        timeZone: "Europe/Moscow",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date) + " MSK"
    : NO_VALUE;
}
export function formatElapsed(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return NO_VALUE;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return seconds < 60
    ? seconds + "s"
    : minutes < 60
      ? minutes + " min"
      : Math.floor(minutes / 60) + " h " + (minutes % 60) + " min";
}
export function formatAgo(value: DateValue, now = Date.now()) {
  const date = validDate(value);
  return !date
    ? NO_VALUE
    : now - date.getTime() < 60000
      ? "just now"
      : formatElapsed(now - date.getTime()) + " ago";
}
export function errorMessage(error: unknown, fallback = "Could not complete the request.") {
  if (!error) return fallback;
  if (error instanceof Error && !("status" in error) && error.name !== "TypeError")
    return error.message || fallback;
  const kind = classifyError(error);
  const messages: Record<string, string> = {
    busy: "The router is busy. Nothing was queued; try again after the current operation finishes.",
    conflict:
      "The saved version changed. Your edits are kept; reload the current version before saving.",
    unavailable:
      "The router cannot perform this action yet. Check its connection and configuration, then try again.",
    precondition:
      "The router cannot perform this action yet. Check its connection and configuration, then try again.",
    unknown: "No confirmed response from the server. Check the current state before trying again.",
    unauthorized: "Sign in again to continue.",
    not_found: "This item is no longer available. Refresh the list and try again.",
    rejected: "The request was not accepted. Refresh the current state before trying again.",
  };
  return kind === "validation"
    ? (error as Error).message || "Check the highlighted fields and try again."
    : (messages[kind] ?? fallback);
}
