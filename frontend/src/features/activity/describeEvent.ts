import type { EventDto, StatusDto } from "../../api/types";
import { routeName } from "../main/model";

const actions: Record<string, string> = {
  update: "Subscription refreshed",
  "active-refresh": "Configuration update applied",
  "total-failure-stop": "XKeen stopped: no working route",
  "routing-device-location": "Device location updated",
  "device-change": "Device settings changed",
  "routing-apply": "Routing applied",
  "routing-restore": "Routing version restored",
};

const routeActions: Record<string, string> = {
  switch: "Main switched to",
  failover: "Failover switched to",
  "failover-switch": "Failover switched to",
  failback: "Returned to",
  "auto-recovery": "Recovered on",
};

const failures: Record<string, string> = {
  update: "Subscription refresh failed",
  "active-refresh": "Configuration update failed",
  switch: "Main switch failed",
};

export function describeEvent(entry: EventDto, status: StatusDto) {
  if (entry.action === "update" && /^active .*vanished from subscription$/.test(entry.message ?? "")) {
    return "The active location disappeared from the subscription. Choose an available route.";
  }
  const failed = Boolean(entry.result && entry.result !== "ok");
  const detail = entry.message && entry.result !== "ok" ? " · " + entry.message : "";
  if (failed && failures[entry.action]) return failures[entry.action] + detail;

  let label = actions[entry.action] || entry.action || "Change";
  if (entry.action === "xkeen") {
    label = "XKeen " + (entry.code || "changed");
  } else if (routeActions[entry.action]) {
    const entryCode = typeof entry.entry_code === "string" ? entry.entry_code : null;
    const route = entry.code ? routeName(status, entry.code, entryCode) : "a location";
    label = routeActions[entry.action] + " " + route;
  }
  return label + (failed ? " · failed" : "") + detail;
}
