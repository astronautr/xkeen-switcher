import { ChoicePopup, type ChoiceProps } from "../../ui/ChoicePopup";
import { ApiError, StaleSessionError } from "../../api/client";
import type { DeviceDto, DeviceLocationsDto, DevicesDto } from "../../api/types";
import { useDevices } from "../../api/queries";
import { useUndoDeviceChange } from "../../api/mutations";
import { useNotifications, useOperationTracking } from "../../app/AppSessionProvider";
import { errorMessage } from "../../ui/format";

export type Inventory = Extract<DevicesDto, { configured: true }>;
export const deviceName = (device: DeviceDto) => device.name || device.hostname || "Unnamed device";
export const normalize = (text: string) => text.trim().normalize("NFKC").toLocaleLowerCase("en");
export const exitKey = (device: DeviceDto) =>
  device.location.in_xkeen ? device.location.code || "main" : "outside";
export const locationName = (locations: DeviceLocationsDto, code: string | null) =>
  locations.available.find((item) => item.code === code)?.name || code || "Not selected";

export function mainLabel(locations: DeviceLocationsDto) {
  const route = locations.main_route;
  const exit = route?.exit_name || locationName(locations, route?.exit_code || locations.main_code);
  return route?.entry_code
    ? (route.entry_name || locationName(locations, route.entry_code)) + " → " + exit
    : exit;
}

export function DeviceChoice(props: ChoiceProps) {
  return <ChoicePopup {...props} variant="device" />;
}

export function saveError(error: unknown) {
  if (error instanceof ApiError && error.acceptanceUnknown)
    return "Save result not confirmed. Compare with the reloaded settings before saving again.";
  if (error instanceof ApiError && error.code === "busy")
    return "Router busy · nothing was saved. Try again when the current operation finishes.";
  return errorMessage(error);
}

/** Used by interrupted-change recovery and by the notification/history actions. */
export function useDeviceUndo() {
  const action = useUndoDeviceChange();
  const inventory = useDevices(false);
  const operation = (id: string) => inventory.data?.operations.find((item) => item.id === id);
  const { publish } = useNotifications();
  const tracking = useOperationTracking();
  const kind = tracking.operation?.kind;
  const deviceWrite =
    tracking.blocking && tracking.local && (kind === "device" || kind === "device-location");
  async function undo(id: string) {
    try {
      const result = await action.mutateAsync({ operation_id: id });
      if ("configured" in result) publish("Device change undone");
    } catch (error) {
      if (error instanceof StaleSessionError) return;
      publish(saveError(error), true);
      if (!(error instanceof ApiError && error.acceptanceUnknown)) await inventory.refetch();
    }
  }
  return {
    undo,
    operation,
    undoing: action.isPending ? action.variables?.operation_id : undefined,
    pending: action.isPending || inventory.isFetching || deviceWrite,
  };
}
