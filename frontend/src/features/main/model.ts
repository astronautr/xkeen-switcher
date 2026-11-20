import type { HealthDto, LocationDto, RouteDto, StatusDto } from "../../api/types";
import { operationSource } from "../../operations/policy";
import type { OperationView } from "../../operations/runtime";

export function splitName(name: string) {
  const match = /^(.+?)\s+(\d+(?:gbit|mbit|kbit)\S*.*)$/i.exec(name);
  return { head: match?.[1] ?? name, tier: match?.[2] ?? "" };
}

export function routeName(
  status: StatusDto,
  exit: string | null,
  entry?: string | null,
  saved?: Partial<RouteDto> | null,
) {
  const name = (code: string | null, fallback?: string | null) =>
    splitName(fallback || status.available.find((location) => location.code === code)?.name || code || "none")
      .head;
  return (entry ? name(entry, saved?.entry_name) + " → " : "") + name(exit, saved?.exit_name);
}

export function manualMainSwitch({ requested, operation, blocking, local }: OperationView) {
  if (
    !requested || !operation || !blocking || !local ||
    (operation.id !== requested.id && operation.request_id !== requested.id) ||
    (operation.kind && !["main", "switch"].includes(operation.kind)) ||
    operationSource(operation) !== "manual"
  ) return null;
  return { requested, operation };
}

export type HealthProbe = { ok: boolean; latency_ms?: number | null; method?: "tcp" | "socks" };

export function tcpProbe(health?: HealthDto | null): HealthProbe | null {
  if (!health || health.probe_method === "skipped") return null;
  if (typeof health.tcp_ok === "boolean") {
    return { method: "tcp", ok: health.tcp_ok, latency_ms: health.tcp_latency_ms ?? (
      health.probe_method === "route" ? null : health.last_latency_ms ?? health.latency_ms
    ) };
  }
  if (health.probe_method && health.probe_method !== "tcp") return null;
  if (typeof health.ok !== "boolean") return null;
  return { method: "tcp", ok: health.ok, latency_ms: health.last_latency_ms ?? health.latency_ms };
}

/** Earlier failover versions checked the whole proxy through SOCKS. Keep that result, never as TCP. */
export function legacyProbe(health?: HealthDto | null): HealthProbe | null {
  if (!health || typeof health.tcp_ok === "boolean" || health.probe_method !== "socks") return null;
  if (typeof health.ok !== "boolean") return null;
  return { method: "socks", ok: health.ok, latency_ms: health.ok ? health.last_latency_ms ?? health.latency_ms : null };
}

export function healthProbe(health?: HealthDto | null) {
  return tcpProbe(health) ?? legacyProbe(health);
}

export function locationHealth(location: LocationDto) {
  const udp = /^hysteria/.test(location.protocol);
  const probe = udp ? null : healthProbe(location.health);
  return {
    probe,
    tcp: probe?.method === "tcp" ? probe : null,
    udp,
    skipped: udp || location.health?.probe_method === "skipped",
    state: probe ? (probe.ok ? "ok" : "fail") : "skip",
    label: udp ? "UDP · not checked" : latency(probe),
  };
}

export function latency(probe: HealthProbe | null | undefined) {
  if (!probe) return "not checked";
  if (probe.method === "socks") {
    return "SOCKS · " + (!probe.ok ? "failed" : probe.latency_ms == null ? "ok" : probe.latency_ms + " ms");
  }
  if (!probe.ok) return "unreachable";
  return probe.latency_ms == null ? "reachable" : probe.latency_ms + " ms";
}
