import { formatMoscow } from "../../ui/format";

export const components = ["xkeen", "xray"] as const;
export type Component = typeof components[number];
export const titles: Record<Component, string> = { xkeen: "XKeen", xray: "Xray" };
export type Offer = { component: Component; version: string };
export type Release = { version: string; supported: boolean; reason?: string | null };
export type RestoreStep = { component: Component; from: string; to: string };
export type Schedule = { version: string; at: string; state: string; reason?: string | null };
export type ComponentState = {
  installed: string | null;
  releases: Release[];
  held: string | null;
  rollback: RestoreStep[];
  schedule: Schedule | null;
};
export type Automatic = { xkeen: boolean; xray: boolean; time: string };
export type Versions = Record<Component, string>;
export type ReplacedSchedules = Partial<Record<Component, Pick<Schedule, "version" | "at">>>;
export type Pair = {
  id: string; versions: Versions; at: string | null; message: string | null;
  state: "pending" | "running" | "installed" | "failed" | "missed" | "cancelled";
  steps: Record<Component, "pending" | "running" | "installed" | "start_unconfirmed" | "failed" | "skipped">;
};
export type UpdateOperation = {
  id: string; component: Component; version: string; action: string;
  phase: string; message?: string | null; source: string;
  at?: string; main_before?: string | null;
};
export type Updates = {
  components: Record<Component, ComponentState>;
  automatic: Automatic;
  pair?: Pair | null;
  operation: UpdateOperation | null;
  history: UpdateOperation[];
  checked_at: string | null;
  catalog_error: string | null;
  router_error: string | null;
  ssh_command: string | null;
  available: Offer[];
  next_auto_at: string | null;
  rollback_revision: string | null;
  maintenance_lead_minutes?: number;
};

const dateTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function localMoscowInput(value: string | Date) {
  return dateTime.format(new Date(value)).replace(" ", "T");
}

export function futureMoscowTime(value: string): string | null {
  const at = new Date(value + ":00+03:00");
  return Number.isFinite(at.getTime()) && at.getTime() > Date.now() ? at.toISOString() : null;
}

export function newScheduleTime(daily: string, now = new Date()) {
  const today = localMoscowInput(now).slice(0, 10);
  const time = today + "T" + daily;
  return Date.parse(time + ":00+03:00") > now.getTime() ? time :
    localMoscowInput(new Date(now.getTime() + 86400000)).slice(0, 10) + "T" + daily;
}

function minuteOfDay(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return Number(hour) * 60 + Number(minute);
}

export function maintenanceWarning(at: string, configTime?: string, leadMinutes = 10) {
  const day = 24 * 60;
  const start = minuteOfDay(at);
  const overlaps = (target: string) => {
    const offset = minuteOfDay(target) - start;
    return (offset + day) % day < leadMinutes || (day - offset) % day < 10;
  };
  if (overlaps("04:00")) return "GeoData is scheduled at 04:00 MSK. This installation may miss its window.";
  if (configTime && overlaps(configTime)) return "Location configuration changes are scheduled at " + configTime + " MSK. This installation may miss its window.";
  return "";
}

export function scheduleLabel(schedule: Schedule) {
  const label = ({ pending: "Scheduled", missed: "Missed", running: "In progress", failed: "Failed" } as Record<string, string>)[schedule.state] ?? schedule.state;
  return label + " · " + schedule.version + " · " + formatMoscow(schedule.at);
}

export function planLabel(plan: RestoreStep[]) {
  return plan.map(({ component, from, to }) => titles[component] + " " + from + " → " + to).join(", then ");
}
