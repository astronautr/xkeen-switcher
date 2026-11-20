import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DeviceChangeInput, DeviceDto } from "../../api/types";
import { ActionButton, Button, IconButton } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { DeviceRow } from "../../ui/domain";
import { ConfirmStrip } from "../../ui/feedback";
import { Chevron } from "../../ui/Chevron";
import {
  DeviceChoice,
  deviceName,
  locationName,
  mainLabel,
  normalize,
  type Inventory,
} from "./common";

type Changes = DeviceChangeInput["changes"];
type Mode = "edit" | "unregister" | null;
export function DeviceItem({
  device,
  inventory,
  mode,
  setMode,
  disabled,
  editingAny,
  commit,
  openLocation,
  toggleServer,
  toggleFavorite,
  runRowAction,
  rowAction,
}: {
  device: DeviceDto;
  inventory: Inventory;
  mode: Mode;
  setMode: (mode: Mode) => void;
  disabled: boolean;
  editingAny: boolean;
  commit: (changes: Changes) => Promise<string | null>;
  openLocation: () => void;
  toggleServer: () => Promise<void>;
  toggleFavorite: () => Promise<void>;
  rowAction: string | null;
  runRowAction: (marker: string, action: () => Promise<unknown>, ...fallbacks: string[]) => Promise<void>;
}) {
  const { id, location } = device;
  const name = deviceName(device);
  const editing = mode === "edit";
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [policy, setPolicy] = useState("");
  const [revision, setRevision] = useState("");
  const [resolution, setResolution] = useState<{
    id: string;
    revision: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const conflictInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (editing) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [editing]);
  useLayoutEffect(() => {
    conflictInput.current?.focus();
  }, [resolution?.id]);

  function begin() {
    setDraft(device.name || device.hostname);
    setRevision(device.revision);
    setPolicy(device.policy);
    setResolution(null);
    setError("");
    setMode("edit");
  }
  function finish() {
    setMode(null);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  const duplicate = (value: string, except: string) =>
    inventory.devices.find(
      (d) => d.registered && d.id !== except && normalize(d.name) === normalize(value),
    );
  const conflict = draft.trim() && duplicate(draft, id);
  const conflictingRevisionChanged = !!(
    conflict &&
    resolution?.id === conflict.id &&
    resolution.revision !== conflict.revision
  );
  const needsComparison = editing && (revision !== device.revision || conflictingRevisionChanged);
  function suggest(base: string, except: string) {
    let candidate = base.trim().slice(0, 64);
    for (let index = 2; duplicate(candidate, except); index++) {
      const suffix = "-" + index;
      candidate = base.trim().slice(0, 64 - suffix.length) + suffix;
    }
    return candidate;
  }
  async function save() {
    if (disabled || needsComparison) return;
    const value = draft.trim();
    const changes: Changes = [];
    if (!value) return setError("Enter a device name.");
    if (conflict) {
      if (!resolution || resolution.id !== conflict.id)
        return setError("Choose a different name or rename the existing device below.");
      const replacement = resolution.name.trim();
      if (!replacement) return setError("Enter a name of 1–64 characters for the existing device.");
      if (normalize(replacement) === normalize(value) || duplicate(replacement, conflict.id))
        return setError("The existing device also needs a unique name.");
      changes.push({
        id: conflict.id,
        revision: resolution.revision,
        values: { name: replacement },
      });
    }
    changes.push({ id, revision, values: { name: value, registered: true, policy } });
    setSaving(true);
    try {
      const failure = await commit(changes);
      if (failure) setError(failure);
      else finish();
    } finally {
      setSaving(false);
    }
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") finish();
  }
  const displayedPolicy = editing ? policy : device.policy;
  const exit = location.code
    ? location.name || locationName(inventory.locations, location.code)
    : location.in_xkeen
      ? "Use Main route"
      : "Outside XKeen";
  let hint = location.code ? "Fixed location" : "Main · " + mainLabel(inventory.locations);
  if (!location.in_xkeen) hint = location.code ? "Saved · outside XKeen" : "Assign an XKeen policy";
  if (location.unavailable) hint = "Unavailable · saved config kept";
  if (location.ip_conflict) hint = "IP changed · review assignment";
  const pinLabel = device.ip_pinned
    ? "Unpin IP " + device.reserved_ip + " for " + name
    : !device.registered
      ? "Register this device to pin its IP address"
      : !device.can_pin_ip
        ? "No IPv4 address to pin"
        : "Pin IP " + device.ip + " for " + name;
  return (
    <DeviceRow
      id={id}
      identity={
        <>
          <div className="device-name-line">
            {editing ? (
              <Field
                ref={input}
                type="text"
                className="inline-name-input"
                value={draft}
                maxLength={64}
                autoComplete="off"
                marker={"name-" + id}
                aria-label="Device name"
                disabled={disabled}
                aria-describedby={"edit-detail-" + id}
                aria-invalid={!!error || (!!conflict && resolution?.id !== conflict.id)}
                onKeyDown={key}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError("");
                }}
              />
            ) : (
              <>
                <strong className="device-name" title={name}>
                  {name}
                </strong>
                {(device.registered || device.is_server) && (
                  <IconButton
                    icon="server"
                    marker={"server-" + id}
                    busy={rowAction === "server-" + id}
                    className={"device-server-badge" + (device.is_server ? " is-server" : "")}
                    disabled={disabled}
                    aria-pressed={device.is_server}
                    label={
                      device.is_server
                        ? "Unmark server · route checks run here"
                        : "Mark " + name + " as server"
                    }
                    onClick={() => void runRowAction("server-" + id, toggleServer)}
                  />
                )}
                {device.registered && (
                  <IconButton
                    icon="pencil"
                    marker={"rename-" + id}
                    label={"Rename " + name}
                    disabled={disabled}
                    onClick={begin}
                    ref={trigger}
                  />
                )}
              </>
            )}
          </div>
          <div className="device-detail device-address-line">
            <span className="device-address">
              <span>{device.ip || device.reserved_ip || "No IP address"}</span>
              <IconButton
                marker={"pin-ip-" + id}
                busy={rowAction === "pin-ip-" + id}
                icon="pin"
                label={pinLabel}
                className="device-ip-pin"
                variant="bracket"
                aria-pressed={device.ip_pinned}
                disabled={disabled || editingAny || (!device.ip_pinned && !device.can_pin_ip)}
                onClick={() =>
                  void runRowAction("pin-ip-" + id, () => commit([
                    { id, revision: device.revision, values: { ip_pinned: !device.ip_pinned } },
                  ]))
                }
              />
            </span>
            <span>· {device.segment}</span>
          </div>
          {device.ip_pinned && device.ip && device.ip !== device.reserved_ip && (
            <div className="device-detail">Pinned: {device.reserved_ip}</div>
          )}
          <div className="device-detail">{device.mac}</div>
        </>
      }
      state={
        <>
          <span
            className={"device-presence" + (device.online ? " is-online" : "")}
            data-marker={"presence-" + id}
            data-online={device.online}
          >
            {device.online ? "Online" : "Offline"}
          </span>
          <span className="device-registration">
            {device.registered ? "Registered" : "Unregistered"}
          </span>
        </>
      }
      policy={
        <>
          {device.registered || editing ? (
            <DeviceChoice
              label={"Access policy for " + name}
              marker={"policy-" + id}
              options={inventory.policies}
              value={displayedPolicy}
              disabled={disabled}
              onSelect={(value) => {
                if (editing) setPolicy(value);
                else void commit([{ id, revision: device.revision, values: { policy: value } }]);
              }}
            />
          ) : (
            <span className="policy-inherited">Segment default</span>
          )}
          <span className="policy-hint">
            {displayedPolicy === "segment"
              ? device.segment + " → " + (device.segment_policy || "Default")
              : "\u00a0"}
          </span>
        </>
      }
      location={
        <>
          <Button
            marker={"location-" + id}
            className={"menu-trigger device-location-trigger" + (location.code ? " is-custom" : "")}
            aria-haspopup="dialog"
            aria-label={"Proxy location for " + name + ": " + exit}
            disabled={disabled || !location.editable || editing}
            onClick={openLocation}
          >
            <span>{exit}</span>
            <Chevron />
          </Button>
          <span
            className={
              "policy-hint" + (location.unavailable || location.ip_conflict ? " device-error" : "")
            }
          >
            {hint}
          </span>
        </>
      }
      actions={
        editing ? (
          <>
            <ActionButton plain marker={"save-" + id} className="ui-button row-button" disabled={disabled || needsComparison} onClick={save}
              idle={device.registered ? "Save" : "Register"} pending={device.registered ? "Saving" : "Registering"} busy={saving} />
            <IconButton
              marker={"cancel-" + id}
              icon="close"
              label="Cancel editing"
              disabled={disabled}
              onClick={finish}
            />
          </>
        ) : (
          <>
            {device.registered ? (
              <ActionButton
                plain
                idle="Unregister"
                pending="Unregistering"
                busy={rowAction === "confirm-unregister-" + id}
                marker={"unregister-" + id}
                className="ui-button row-button unregister-button"
                disabled={disabled}
                onClick={() => setMode(mode === "unregister" ? null : "unregister")}
              />
            ) : (
              <Button
                marker={"register-" + id}
                className="row-button"
                ref={trigger}
                disabled={disabled}
                onClick={begin}
              >
                Register
              </Button>
            )}
            <IconButton
              marker={"favorite-" + id}
              busy={rowAction === "favorite-" + id}
              icon="star"
              label={"Favorite " + name}
              variant="bracket"
              className="device-favorite"
              title={device.favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={device.favorite}
              disabled={disabled}
              onClick={() => void runRowAction("favorite-" + id, toggleFavorite, "favorites-filter")}
            />
          </>
        )
      }
      detail={
        editing ? (
          <div
            id={"edit-detail-" + id}
            className="inline-detail"
            hidden={!error && !conflict && !needsComparison && device.registered}
          >
            {error && (
              <p className="detail-error" role="alert">
                {error}
              </p>
            )}
            {needsComparison && (
              <Button
                className="row-button"
                marker={"compare-" + id}
                onClick={() => {
                  setRevision(device.revision);
                  if (resolution && conflict && resolution.id === conflict.id)
                    setResolution({ ...resolution, revision: conflict.revision });
                  setError("");
                }}
              >
                Use current revision ·{" "}
                {conflictingRevisionChanged && conflict ? deviceName(conflict) : deviceName(device)}
              </Button>
            )}
            {conflict ? (
              <>
                <p>
                  {`“${conflict.name}” is already registered: ${conflict.ip} · ${conflict.mac}.`}
                </p>
                {resolution?.id === conflict.id ? (
                  <>
                    <label htmlFor="conflict-name">New name for the existing device</label>
                    <Field
                      id="conflict-name"
                      marker="conflict-name"
                      className="conflict-input"
                      maxLength={64}
                      autoComplete="off"
                      ref={conflictInput}
                      value={resolution.name}
                      onKeyDown={key}
                      onChange={(e) => setResolution({ ...resolution, name: e.target.value })}
                    />
                    <p className="device-detail">
                      Both names will be saved together. The existing device keeps its policy.
                    </p>
                  </>
                ) : (
                  <div className="inline-actions">
                    <Button
                      className="row-button"
                      marker="use-suggested-name"
                      onClick={() => {
                        setDraft(suggest(draft, id));
                        setError("");
                        input.current?.focus();
                      }}
                    >
                      {`Use ${suggest(draft, id)}`}
                    </Button>
                    <Button
                      className="row-button"
                      marker="rename-existing"
                      onClick={() => {
                        setResolution({
                          id: conflict.id,
                          revision: conflict.revision,
                          name: suggest(conflict.name.slice(0, 60) + "-old", conflict.id),
                        });
                        setError("");
                      }}
                    >
                      Rename existing device
                    </Button>
                  </div>
                )}
              </>
            ) : (
              !device.registered && (
                <p>Registration saves a name and access policy for this MAC address.</p>
              )
            )}
          </div>
        ) : (
          mode === "unregister" && (
            <ConfirmStrip
              autoFocus
              className="inline-detail"
              marker={"unregister-confirm-" + id}
              tone="danger"
              message={"Unregister " + name + "?"}
              detail="Its saved name and policy assignment will be removed. It will follow its network’s policy. Static IP reservations are kept."
              cancelLabel="Cancel"
              confirmLabel="Unregister"
              cancelMarker={"cancel-unregister-" + id}
              confirmMarker={"confirm-unregister-" + id}
              onCancel={() => {
                setMode(null);
                document
                  .querySelector<HTMLElement>('[data-marker="unregister-' + id + '"]')
                  ?.focus();
              }}
              onConfirm={() => {
                if (disabled) return;
                setMode(null);
                void runRowAction(
                  "confirm-unregister-" + id,
                  () => commit([{ id, revision: device.revision, values: { registered: false } }]),
                  "register-" + id,
                  "unregister-" + id,
                );
              }}
            />
          )
        )
      }
    />
  );
}
