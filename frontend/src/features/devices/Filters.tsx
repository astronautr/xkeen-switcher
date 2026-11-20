import type { DeviceDto } from "../../api/types";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import {
  DeviceChoice,
  deviceName,
  exitKey,
  locationName,
  mainLabel,
  normalize,
  type Inventory,
} from "./common";

export const emptyFilters = {
  query: "",
  registration: "all",
  policies: new Set<string>(),
  locations: new Set<string>(),
  online: false,
  favorites: false,
};
export type Filters = typeof emptyFilters;

export function matches(device: DeviceDto, filters: Filters) {
  const text = [deviceName(device), device.ip, device.reserved_ip, device.mac, device.segment].join(
    " ",
  );
  return (
    normalize(text).includes(normalize(filters.query)) &&
    (filters.registration === "all" ||
      device.registered === (filters.registration === "registered")) &&
    (!filters.policies.size || filters.policies.has(device.policy)) &&
    (!filters.locations.size || filters.locations.has(exitKey(device))) &&
    (!filters.online || device.online) &&
    (!filters.favorites || device.favorite)
  );
}

export function toggled(values: Set<string>, value: string) {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function FilterBar({
  inventory,
  value,
  change,
  visible,
  disabled,
}: {
  inventory: Inventory;
  value: Filters;
  change: (filters: Filters) => void;
  visible: DeviceDto[];
  disabled: boolean;
}) {
  const { devices, locations, policies } = inventory;
  const codes = new Set([...devices.map((d) => d.location.code), ...value.locations]);
  const locationOptions = [
    { value: "main", label: "Main · " + mainLabel(locations) },
    ...Array.from(codes)
      .filter((code): code is string => !!code && !["main", "outside"].includes(code))
      .map((code) => ({ value: code, label: locationName(locations, code) })),
    { value: "outside", label: "Outside XKeen" },
  ];
  const filtered =
    value.query ||
    value.registration !== "all" ||
    value.locations.size ||
    value.policies.size ||
    value.favorites ||
    value.online;
  return (
    <>
      <div className="device-tools">
        <Field
          id="search-devices"
          type="search"
          marker="search-devices"
          aria-label="Search devices"
          placeholder="Name, IP or MAC"
          autoComplete="off"
          disabled={disabled}
          value={value.query}
          onChange={(e) => change({ ...value, query: e.target.value })}
        />
        <DeviceChoice
          marker="registration-filter"
          fieldId="registration-filter"
          label="Registration filter"
          options={[
            { value: "all", label: "All devices" },
            { value: "registered", label: "Registered" },
            { value: "unregistered", label: "Unregistered" },
          ]}
          value={value.registration}
          disabled={disabled}
          onSelect={(registration) => change({ ...value, registration })}
        />
        {(["policies", "locations"] as const).map((kind) => {
          const choices = kind === "policies" ? policies : locationOptions;
          const options = [
            { value: "all", label: "All " + kind, count: devices.length },
            ...choices.map((option) => ({
              ...option,
              disabled: false,
              count: devices.filter(
                (d) => (kind === "policies" ? d.policy : exitKey(d)) === option.value,
              ).length,
            })),
          ];
          const labels = choices
            .filter((option) => value[kind].has(option.value))
            .map((option) => option.label);
          const all = "All " + kind;
          const category = kind === "policies" ? "Policies" : "Locations";
          const caption = labels.length > 1 ? category + " · " + labels.length : labels[0] || all;
          return (
            <DeviceChoice
              key={kind}
              marker={kind + "-filter"}
              fieldId={kind + "-filter"}
              label={kind === "policies" ? "Filter by access policy" : "Filter by proxy location"}
              triggerLabel={"Filter by " + kind + ": " + caption}
              caption={caption}
              title={labels.join(", ") || all}
              disabled={disabled}
              options={options}
              value={value[kind]}
              onSelect={(item) =>
                change({
                  ...value,
                  [kind]: item === "all" ? new Set() : toggled(value[kind], item),
                })
              }
            />
          );
        })}
        <div className="device-toggle-filters">
          {(["favorites", "online"] as const).map((key) => (
            <label key={key} className={"device-filter " + key + "-filter"}>
              <input
                type="checkbox"
                id={key + "-filter"}
                data-marker={key + "-filter"}
                checked={value[key]}
                disabled={disabled}
                onChange={(e) => change({ ...value, [key]: e.target.checked })}
              />
              <span className="wl-check" aria-hidden="true" />
              {key === "online" ? (
                "Online only"
              ) : (
                <span id="favorites-count">
                  {`Favorites ${devices.filter((d) => d.favorite).length}`}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
      <div className="list-meta">
        <span id="result-count" role="status">
          {`${visible.length} of ${devices.length} devices · ${visible.filter((d) => d.online).length} online`}
        </span>
        <Button
          marker="clear-filters"
          id="clear-filters"
          hidden={!filtered}
          className="quiet-button"
          onClick={() => {
            change(emptyFilters);
            document.getElementById("search-devices")?.focus();
          }}
        >
          Clear filters
        </Button>
      </div>
    </>
  );
}
