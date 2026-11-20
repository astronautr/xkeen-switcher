import { useState } from "react";
import { ApiError, StaleSessionError } from "../../api/client";
import { useAssignDeviceLocation, useSaveDeviceRoutingSettings } from "../../api/mutations";
import type { DeviceDto } from "../../api/types";
import { useNotifications, useOperationTracking } from "../../app/AppSessionProvider";
import { newOperationId } from "../../browser/storage";
import { actionLabel, phaseLabel, scopeLabel, sourceLabel } from "../../operations/policy";
import { Dialog } from "../../ui/overlays";
import { ActionButton, Button } from "../../ui/Button";
import { ConfirmStrip } from "../../ui/feedback";
import { errorMessage } from "../../ui/format";
import { deviceName, mainLabel, saveError, type Inventory } from "./common";
import { toggled } from "./Filters";

function ActivitySummary() {
  const { operation, local, terminal } = useOperationTracking();
  const text =
    operation && !terminal
      ? [
          actionLabel(operation),
          operation.target_name,
          local ? "This browser" : sourceLabel(operation),
          phaseLabel(operation.phase),
          operation.message,
          scopeLabel(operation),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  // The global activity indicator is rehosted by Dialog's shared overlay registry.
  return (
    <p
      hidden
      role="status"
      className="operation-modal-summary"
      data-marker="device-modal-operation"
    >
      {text}
    </p>
  );
}

export function LocationDialog({
  device,
  inventory,
  close,
  check,
  refresh,
}: {
  device: DeviceDto;
  inventory: Inventory;
  close: () => void;
  check: (id: string) => Promise<boolean>;
  refresh: () => void;
}) {
  const { locations } = inventory;
  const [selected, select] = useState(device.location.code);
  const [base] = useState({
    code: device.location.code,
    revision: device.revision,
    locations_revision: locations.revision,
  });
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const assign = useAssignDeviceLocation();
  const { blocking } = useOperationTracking();
  const locked = assign.isPending || !!uncertain;
  const choices: { code: string | null; name: string; description: string; disabled: boolean }[] = [
    {
      code: null,
      name: "Use Main route",
      description: "Currently " + mainLabel(locations) + " · follows future changes",
      disabled: false,
    },
    ...locations.available.map((item) => ({
      ...item,
      description:
        !locations.main_route?.entry_code && item.code === locations.main_code
          ? "Also the current Main route"
          : "",
      disabled: !device.location.in_xkeen,
    })),
  ];
  if (base.code && !choices.some((item) => item.code === base.code))
    choices.push({
      code: base.code,
      name: device.location.name || base.code,
      description: "No longer in the subscription",
      disabled: true,
    });
  async function apply() {
    const operation_id = newOperationId();
    setError("");
    try {
      await assign.mutateAsync({
        id: device.id,
        code: selected,
        operation_id,
        revision: base.revision,
        locations_revision: base.locations_revision,
      });
      close();
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      setError(errorMessage(failure));
      if (failure instanceof ApiError && failure.acceptanceUnknown) setUncertain(operation_id);
    }
  }
  const notice = selected
    ? (device.ip_pinned
        ? "Keeps its fixed location when Main changes."
        : "Also pins this device’s IPv4 address at " + device.ip + ".") +
      " Applying restarts XKeen; existing connections may reconnect."
    : "Follows the Main route, including automatic failover. " +
      (device.ip_pinned ? "The fixed IP address is kept. " : "") +
      "Applying restarts XKeen.";
  return (
    <Dialog
      open
      marker="device-location-dialog"
      className="device-location-dialog"
      aria-labelledby="device-location-title"
      initialFocus="input:checked:not(:disabled)"
      onClose={() => {
        if (!assign.isPending) close();
      }}
    >
      <div className="device-location-dialog-header">
        <h2 id="device-location-title">Choose device location</h2>
        <Button
          className="quiet-button"
          marker="close-location-dialog"
          disabled={locked}
          onClick={close}
        >
          ×
        </Button>
      </div>
      <ActivitySummary />
      <p className="device-location-description">
        {`${deviceName(device)} · ${device.reserved_ip || device.ip}`}
      </p>
      <p className="device-location-group-hint">
        Other locations are fixed for this device and do not follow Main.
      </p>
      <div className="device-location-options">
        {choices.map((choice) => (
          <label key={choice.code || "main"} className="device-location-option">
            <input
              type="radio"
              name="device-proxy-location"
              value={choice.code || "main"}
              data-marker={"device-location-option-" + (choice.code || "main")}
              checked={choice.code === selected}
              disabled={locked || choice.disabled}
              onChange={() => select(choice.code)}
            />
            <span className="device-location-option-copy">
              <span>{choice.name}</span>
              {choice.description && <small>{choice.description}</small>}
            </span>
          </label>
        ))}
      </div>
      <p className="device-location-notice" role="status">
        {notice}
      </p>
      <p className="device-error" role="alert">
        {error}
      </p>
      <div className="device-location-dialog-actions">
        <Button
          marker="cancel-location-dialog"
          className="row-button"
          disabled={locked}
          onClick={close}
        >
          Cancel
        </Button>
        <ActionButton
          plain
          idle={selected ? "Apply location" : "Use Main route"}
          pending="Applying"
          busy={assign.isPending}
          marker="apply-device-location"
          className="ui-button row-button"
          disabled={
            locked ||
            blocking ||
            selected === base.code ||
            choices.find((c) => c.code === selected)?.disabled
          }
          onClick={apply}
        />
        {uncertain && (
          <>
            <ActionButton
              plain
              idle="Check result"
              pending="Checking"
              busy={checking}
              marker="check-location-result"
              className="ui-button row-button"
              autoFocus
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                if (await check(uncertain)) close();
                else
                  setError("No confirmed result yet. Check again after the server has finished.");
                setChecking(false);
              }}
            />

            <Button
              marker="refresh-location-dialog"
              className="row-button"
              onClick={() => {
                close();
                refresh();
              }}
            >
              Close and refresh
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function RoutingDialog({ inventory, close }: { inventory: Inventory; close: () => void }) {
  const [base] = useState(inventory.locations.settings);
  const [selected, setSelected] = useState(new Set(base.policy_ids));
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState("");
  const save = useSaveDeviceRoutingSettings();
  const { publish } = useNotifications();
  const { blocking } = useOperationTracking();
  function requestClose() {
    if (save.isPending) return;
    const dirty =
      selected.size !== base.policy_ids.length || base.policy_ids.some((id) => !selected.has(id));
    if (dirty) setDiscard(true);
    else close();
  }
  async function submit() {
    try {
      await save.mutateAsync({ revision: base.revision, policy_ids: Array.from(selected) });
      publish("Device routing settings saved");
      close();
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(saveError(failure));
    }
  }
  return (
    <Dialog
      open
      marker="device-routing-dialog"
      className="device-location-dialog device-routing-dialog"
      aria-labelledby="device-routing-title"
      onClose={() => (discard ? setDiscard(false) : requestClose())}
    >
      <div className="device-location-dialog-header">
        <h2 id="device-routing-title">XKeen policies</h2>
        <Button
          marker="close-routing-setup"
          className="quiet-button"
          disabled={save.isPending}
          onClick={requestClose}
        >
          ×
        </Button>
      </div>
      <ActivitySummary />
      <fieldset
        className="device-routing-policies"
        aria-label="Policies using XKeen"
        disabled={save.isPending}
      >
        <p className="device-location-description">
          Select the policies already using XKeen. Router policies stay unchanged.
        </p>
        {inventory.policies
          .filter((p) => !p.disabled && !["segment", "deny"].includes(p.value))
          .map((p) => (
            <label className="device-location-option" key={p.value}>
              <input
                type="checkbox"
                data-marker={"mapped-policy-" + p.value}
                checked={selected.has(p.value)}
                onChange={() => setSelected(toggled(selected, p.value))}
              />
              <span>{p.label}</span>
            </label>
          ))}
      </fieldset>
      <p className="device-error" role="alert">
        {error}
      </p>
      {discard && (
        <ConfirmStrip
          autoFocus
          marker="routing-setup-discard"
          message="Discard policy changes?"
          detail="The selected policies have not been saved."
          cancelLabel="keep editing"
          confirmLabel="discard changes"
          onCancel={() => {
            setDiscard(false);
            document.querySelector<HTMLElement>('[data-marker="save-device-routing"]')?.focus();
          }}
          onConfirm={close}
        />
      )}
      <div className="device-location-dialog-actions">
        <Button
          marker="cancel-device-routing"
          className="row-button"
          disabled={save.isPending}
          onClick={requestClose}
        >
          Cancel
        </Button>
        <ActionButton
          plain
          idle="Save settings"
          pending="Saving"
          busy={save.isPending}
          marker="save-device-routing"
          className="ui-button row-button"
          disabled={save.isPending || blocking}
          onClick={submit}
        />
      </div>
    </Dialog>
  );
}
