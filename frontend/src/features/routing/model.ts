import type { MatcherDto, RoutingGroup, RoutingDto } from "../../api/types";

export const actions: Record<string, string> = {
  direct: "direct",
  proxy: "via proxy",
  block: "block",
  custom: "custom",
};
export const types = [
  [
    "domain-suffix",
    "domain + subdomains",
    "domains",
    "example.org",
    "One hostname per line. Includes its subdomains.",
  ],
  ["domain-exact", "exact hostname", "domains", "api.example.org", "Only this hostname. One per line."],
  [
    "domain-geosite",
    "domain list",
    "domains",
    "ext:geosite_v2fly.dat:google",
    "Keep the full list reference. One per line.",
  ],
  [
    "ip",
    "destination IP / CIDR",
    "destination IPs",
    "192.168.0.0/16",
    "One address or network per line. IPv4 and IPv6.",
  ],
  [
    "source",
    "client IP / CIDR",
    "client IPs",
    "192.168.2.50",
    "Client address as seen by Xray. One per line.",
  ],
  ["port", "destination ports", "ports", "53,80,443,1000-2000", "Separate ports and ranges with commas."],
  ["network", "network", "network", "tcp,udp", "Choose which transport can match."],
  [
    "protocol",
    "protocol",
    "protocols",
    "bittorrent",
    "http, tls, quic or bittorrent; one per line. Requires sniffing.",
  ],
  [
    "ip-geoip",
    "IP list",
    "destination IPs",
    "ext:geoip_v2fly.dat:private",
    "Keep the full list reference. One per line.",
  ],
  [
    "domain-substring",
    "hostname substring",
    "domains",
    "example",
    "Matches anywhere in the hostname. One value per line.",
  ],
  [
    "domain-regexp",
    "regular expression",
    "domains",
    "(^|\\.)example\\.org$",
    "Matches hostnames, not URL paths. Xray regexp syntax.",
  ],
] as const;
export function typeInfo(type: string) {
  return types.find(([key]) => key === type) ?? ([type, type, type, "", ""] as const);
}
export function shortValue({ type, value }: MatcherDto) {
  if (type === "domain-suffix") return value + " + subdomains";
  if (type === "domain-exact") return "exact: " + value;
  if (type === "network") return value.toUpperCase();
  return (
    typeInfo(type)[1] +
    ": " +
    (["domain-geosite", "ip-geoip"].includes(type) ? value.split(":").at(-1) : value)
  );
}
export function summary(rule: RoutingGroup) {
  if (!rule.editable) return "Custom Xray fields · view only";
  if (!rule.matchers.length) return "All remaining redirect/tproxy traffic at this position";
  const fields = new Map<string, string[]>();
  for (const matcher of rule.matchers) {
    const field = typeInfo(matcher.type)[2];
    const value = shortValue(matcher);
    fields.set(field, [...(fields.get(field) ?? []), value.length > 60 ? value.slice(0, 57) + "…" : value]);
  }
  return [...fields.values()]
    .map(
      (values) =>
        values.slice(0, 2).join(" OR ") + (values.length > 2 ? " + " + (values.length - 2) + " more" : ""),
    )
    .join(" AND ");
}
export type Base = { base: string; revision: string | null };
export function baseOf(info: RoutingDto): Base {
  return { base: info.current.sha256, revision: info.draft?.revision ?? null };
}
export function outdated(base: Base, info: RoutingDto) {
  return base.base !== info.current.sha256 || base.revision !== (info.draft?.revision ?? null);
}
type Fields = { title: string; action: string; entries: MatcherDto[] };
export type Form = Base & {
  rule: RoutingGroup;
  original: RoutingGroup;
  entries: MatcherDto[];
  isNew: boolean;
  initial: Fields;
  detailsOpen: boolean;
  removed?: { entry: MatcherDto; index: number } | null;
};
export function fields(form: Pick<Form, "rule" | "entries">): Fields {
  return { title: form.rule.title, action: form.rule.action, entries: form.entries };
}
export function createForm(rule: RoutingGroup, isNew: boolean, base: Base): Form {
  const entries: MatcherDto[] = [];
  for (const matcher of rule.matchers) {
    const entry = entries.find((item) => item.type === matcher.type);
    if (entry) entry.value += "\n" + matcher.value;
    else entries.push({ ...matcher });
  }
  if (isNew) entries.push({ type: "domain-suffix", value: "" });
  return {
    ...base,
    rule,
    original: rule,
    isNew,
    entries,
    initial: fields({ rule, entries }),
    detailsOpen: isNew || !matchMedia("(max-width:720px)").matches,
  };
}
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function buildRule(form: Form): RoutingGroup {
  const queues = new Map<string, MatcherDto[]>();
  for (const { type, value } of form.entries) {
    const original = form.initial.entries.find((entry) => entry.type === type);
    const values =
      value === original?.value
        ? form.original.matchers.filter((m) => m.type === type).map((m) => m.value)
        : ["network", "port"].includes(type)
          ? [value.trim()]
          : value
              .split(/\r?\n/)
              .filter((line) => line.trim())
              .map((line) => (["domain-regexp", "domain-substring"].includes(type) ? line : line.trim()));
    queues.set(
      type,
      values.map((value) => ({ type, value })),
    );
  }
  const matchers: MatcherDto[] = [];
  form.original.matchers.forEach(({ type }, index, original) => {
    const queue = queues.get(type);
    if (!queue?.length) return;
    matchers.push(queue.shift()!);
    if (!original.slice(index + 1).some((m) => m.type === type)) matchers.push(...queue.splice(0));
  });
  for (const rest of queues.values()) matchers.push(...rest);
  return { ...form.rule, title: form.rule.title.trim(), matchers };
}
export function changes(base: RoutingGroup[], target: RoutingGroup[]) {
  const result = new Map<string, string>();
  target.forEach((rule, index) => {
    const oldIndex = base.findIndex((item) => item.id === rule.id);
    const old = base[oldIndex];
    if (!old) result.set(rule.id, "new");
    else if (index !== oldIndex) result.set(rule.id, "moved");
    else if (old.title !== rule.title || old.action !== rule.action || !same(old.matchers, rule.matchers))
      result.set(rule.id, "edited");
  });
  for (const old of base) if (!target.some((rule) => rule.id === old.id)) result.set(old.id, "removed");
  return result;
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
