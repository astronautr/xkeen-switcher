import type { OperationDto } from "../api/types";
export const LONG_NAME =
  "Netherlands 🇳🇱 Amsterdam backbone with a very long provider label 10gbit⚡";
export const NETWORKS = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
];
export const LOCATIONS = [
  { value: "tr", label: "Turkey · 34 ms" },
  { value: "nl", label: LONG_NAME },
  { value: "sg", label: "Singapore · unavailable", disabled: true },
];
export const COMMANDS = [
  { value: "download", label: "Download fixture" },
  { value: "clear", label: "Clear fixture" },
];
export const OPERATIONS: OperationDto[] = [
  {
    id: null,
    kind: "main",
    phase: "installing",
    source: "manual",
    target: "Japan → Singapore",
    message: "Installing configuration on the router.",
  },
  {
    id: null,
    kind: "failover_check",
    phase: "preparing",
    source: "failover",
    scope: "diagnostic",
    message: "Checking failover locations",
  },
  {
    id: null,
    kind: "routing",
    phase: "unknown",
    trigger: "manual",
    message: "The result cannot be confirmed yet.",
  },
  {
    id: null,
    kind: "device-location",
    phase: "recovery_failed",
    trigger: "manual",
    message: "External configuration changed.",
  },
];
export const LOCATION_ROWS = [
  { name: "Turkey 🇹🇷", code: "tr", health: "ok", latency: "34 ms", current: true },
  { name: LONG_NAME, code: "nl", health: "fail", latency: "unreachable" },
  { name: "Singapore 🇸🇬", code: "sg", health: "skip", latency: "not checked" },
];
export const BANNERS = [
  { tone: "warn", prefix: "[warn]", text: "Subscription refresh failed · last success 3 h ago" },
  {
    tone: "danger",
    prefix: "[offline]",
    text: "No response from the server. Showing the last known state.",
  },
  { tone: "failover", prefix: "[failover]", text: "Main on Turkey · preferred Finland failed" },
  {
    tone: "info",
    prefix: "[waiting]",
    text: "XKeen off · starts again when any failover location recovers",
  },
];
export const STOP_DETAIL = "Proxy traffic stops for every device until XKeen is started again.";
