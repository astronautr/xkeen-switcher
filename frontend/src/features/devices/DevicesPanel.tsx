import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, StaleSessionError } from "../../api/client";
import type { DeviceChangeInput, DeviceDto } from "../../api/types";
import {
  useChangeDevices,
  useCheckDeviceLocation,
  useFavoriteDevice,
  useSaveDeviceServer,
} from "../../api/mutations";
import { useDevices, useDevicesPolling, useStatus } from "../../api/queries";
import { useNotifications } from "../../app/AppSessionProvider";
import { browserPreferences } from "../../browser/preferences";
import { newOperationId } from "../../browser/storage";
import { ActionButton, Button } from "../../ui/Button";
import { errorMessage } from "../../ui/format";
import { DeviceItem } from "./DeviceItem";
import { LocationDialog, RoutingDialog } from "./Dialogs";
import { FilterBar, emptyFilters, matches } from "./Filters";
import { deviceName, saveError, useDeviceUndo } from "./common";
import { Chevron } from "../../ui/Chevron";

export function DevicesPanel() {
  const [expanded, setExpanded] = useState(() => browserPreferences.devicesExpanded());
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filters, setFilters] = useState(emptyFilters);
  const [editor, setEditor] = useState<{ id: string; mode: "edit" | "unregister" } | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "location"; id: string } | { kind: "routing" } | null
  >(null);
  const [rowAction, setRowAction] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [focusReturn, setFocusReturn] = useState<{ revision: number; markers: string[] } | null>(null);
  const focusRevision = useRef(0);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = panel.current!;
    const update = () => setMenuOpen(!!node.querySelector(":popover-open"));
    const trackFocus = () => { focusRevision.current++; };
    node.addEventListener("toggle", update, true);
    document.addEventListener("focusin", trackFocus, true);
    return () => {
      node.removeEventListener("toggle", update, true);
      document.removeEventListener("focusin", trackFocus, true);
    };
  }, []);
  const query = useDevices(expanded);
  const status = useStatus().data;
  const change = useChangeDevices();
  const favorite = useFavoriteDevice();
  const server = useSaveDeviceServer();
  const check = useCheckDeviceLocation();
  const { undo, undoing, pending } = useDeviceUndo();
  const { publish } = useNotifications();
  const busy =
    change.isPending ||
    favorite.isPending ||
    server.isPending ||
    check.isPending ||
    pending ||
    query.isFetching;
  useLayoutEffect(() => {
    if (!focusReturn || busy) return;
    setFocusReturn(null);
    // Disabling or removing a row control can leave focus on the document.
    // A later focus event belongs to the user, even if that control also blurs.
    if (!expanded || focusRevision.current !== focusReturn.revision || document.activeElement !== document.body) return;
    for (const marker of focusReturn.markers) {
      const target = panel.current?.querySelector<HTMLElement>(
        `[data-marker="${CSS.escape(marker)}"]:enabled`,
      );
      if (target) {
        target.focus({ preventScroll: true });
        break;
      }
    }
  }, [focusReturn, busy, expanded]);
  useDevicesPolling(
    expanded &&
      !focusWithin &&
      !menuOpen &&
      !editor &&
      !dialog &&
      !busy &&
      !panel.current?.closest("[inert]"),
  );

  const snapshot = query.data;
  const inventory =
    snapshot?.configured && status
      ? {
          ...snapshot,
          locations: {
            ...snapshot.locations,
            main_code: status.active_code,
            main_route: status.active_route,
          },
        }
      : snapshot?.configured
        ? snapshot
        : null;
  const positions = useRef(new Map<string, number>());
  const ordered =
    inventory?.devices
      .slice()
      .sort(
        (a, b) =>
          (positions.current.get(a.id) ?? Infinity) - (positions.current.get(b.id) ?? Infinity),
      ) ?? [];
  useLayoutEffect(() => {
    positions.current = new Map(ordered.map((d, index) => [d.id, index]));
  }, [snapshot]);
  async function refresh(showProgress = false) {
    setError("");
    if (showProgress) setRefreshing(true);
    try {
      await query.refetch();
    } finally {
      if (showProgress) setRefreshing(false);
    }
  }
  async function commit(changes: DeviceChangeInput["changes"]) {
    setError("");
    try {
      const result = await change.mutateAsync({ operation_id: newOperationId(), changes });
      if (result.configured && result.operation)
        publish(result.operation.message, false, { device_operation: result.operation.id });
      return null;
    } catch (failure) {
      if (failure instanceof StaleSessionError) return failure.message;
      const message = saveError(failure);
      const ambiguous = failure instanceof ApiError && failure.acceptanceUnknown;
      const feedback = ambiguous
        ? "Save result not confirmed. Check the current device settings before saving again."
        : message;
      setError(feedback);
      if (!editor || ambiguous) publish(feedback, true);
      if (!ambiguous) await query.refetch();
      return message;
    }
  }
  async function perform(
    action: () => Promise<unknown>,
    message?: string,
    reloadOnRefusal = false,
  ) {
    setError("");
    try {
      await action();
      if (message) publish(message);
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      const reason = saveError(failure);
      setError(reason);
      publish(reason, true);
      if (reloadOnRefusal && !(failure instanceof ApiError && failure.acceptanceUnknown))
        await query.refetch();
    }
  }
  async function checkResult(id: string | null) {
    if (!id) {
      await refresh();
      return true;
    }
    try {
      const result = await check.mutateAsync({ operation_id: id });
      if (result) return true;
      setError("No confirmed result yet. Check again after the server has finished.");
    } catch (failure) {
      if (!(failure instanceof StaleSessionError)) setError(errorMessage(failure));
    }
    return false;
  }
  async function toggleServer(device: DeviceDto) {
    if (!inventory) return;
    await perform(
      () =>
        server.mutateAsync({
          id: device.is_server ? null : device.id,
          revision: inventory.locations.settings.revision,
        }),
      device.is_server ? "Server unmarked" : deviceName(device) + " marked as server",
      true,
    );
  }
  async function runRowAction(marker: string, action: () => Promise<unknown>, ...fallbacks: string[]) {
    const revision = focusRevision.current;
    setRowAction(marker);
    try {
      await action();
      setFocusReturn({ revision, markers: [marker, ...fallbacks] });
    } finally {
      setRowAction(null);
    }
  }
  const visible = ordered.filter((d) => matches(d, filters));
  const interrupted =
    inventory?.operations.filter((op) => ["pending", "uncertain", "undoing"].includes(op.phase)) ??
    [];
  const locationPending = inventory?.locations.pending_operation;
  const feedback =
    error ||
    (query.error ? errorMessage(query.error) : "") ||
    (snapshot?.configured === false ? snapshot.error : "");
  const showReadStatus = query.isFetching && (!refreshing || !expanded);
  const needsMapping = inventory && !inventory.locations.policy_ids.length;
  const selected =
    dialog?.kind === "location" && inventory?.devices.find((d) => d.id === dialog.id);
  return (
    <section
      ref={panel}
      className="box devices-panel"
      aria-label="Devices"
      data-marker="router-devices"
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(e) => setFocusWithin(e.currentTarget.contains(e.relatedTarget))}
    >
      <Button
        id="devices-toggle"
        marker="devices-toggle"
        className="devices-toggle ui-disclosure"
        aria-controls="devices-content"
        aria-expanded={expanded}
        onClick={() => {
          browserPreferences.setDevicesExpanded(!expanded);
          setExpanded(!expanded);
          if (!expanded && snapshot) void refresh();
        }}
      >
        <span>Devices</span>
        <span id="device-summary" className="section-summary terminal-icon-action" data-busy={showReadStatus}>
          {showReadStatus ? (
            <>Reading router devices <span className="terminal-action-glyph" aria-hidden="true" /></>
          ) : inventory
            ? ordered.length +
              " total · " +
              ordered.filter((d) => !d.registered).length +
              " unregistered"
            : "Access policies"}
        </span>
        <Chevron className="ui-disclosure-chevron" direction={expanded ? "down" : "right"} />
      </Button>
      <div id="devices-content" hidden={!expanded} aria-busy={busy}>
        <div className="devices-refresh-row">
          <span>Devices and connection policies</span>
          <div className="device-toolbar-actions">
            <Button
              marker="device-routing-setup"
              className="quiet-button"
              disabled={!inventory || busy}
              onClick={() => setDialog({ kind: "routing" })}
            >
              Routing setup
            </Button>
            <ActionButton
              plain
              idle="Refresh"
              pending="Refreshing"
              busy={refreshing}
              marker="router-devices-refresh"
              id="router-devices-refresh"
              className="ui-button quiet-button"
              disabled={busy || !!editor}
              onClick={() => void refresh(true)}
            />
          </div>
        </div>
        <div
          id="devices-feedback"
          role="status"
          className="devices-feedback"
          hidden={!feedback && !interrupted.length && !locationPending && !needsMapping}
        >
          {feedback && <p className="device-error">{feedback}</p>}
          {interrupted.map((op) => (
            <p key={op.id} className="device-error">
              {"Interrupted change: " + op.message}
              <ActionButton
                plain
                idle="Undo interrupted change"
                pending="Undoing"
                busy={undoing === op.id}
                className="ui-button row-button"
                marker={"recover-" + op.id}
                disabled={busy}
                onClick={() => undo(op.id)}
              />
            </p>
          ))}
          {locationPending && (
            <p>
              {"Device location: " + locationPending.message}
              <ActionButton
                plain
                idle="Check apply status"
                pending="Checking"
                busy={check.isPending}
                className="ui-button row-button"
                marker="device-location-recover"
                disabled={query.isFetching || check.isPending}
                onClick={() => checkResult(locationPending.id)}
              />
            </p>
          )}
          {needsMapping && (
            <p>
              Map your XKeen connection policies to enable device locations.
              <Button
                className="row-button"
                marker="device-routing-empty-setup"
                onClick={() => setDialog({ kind: "routing" })}
              >
                Routing setup
              </Button>
            </p>
          )}
        </div>
        {inventory && (
          <div id="devices-browser">
            <FilterBar
              inventory={inventory}
              value={filters}
              visible={visible}
              disabled={busy}
              change={(next) => {
                setFilters(next);
                setEditor(null);
              }}
            />
            <div className="device-columns" aria-hidden="true">
              {["Device", "Status", "Access policy", "Proxy location", "Actions"].map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div id="device-list" role="list" aria-label="Devices">
              {visible.map((device) => (
                <DeviceItem
                  key={device.id}
                  device={device}
                  inventory={inventory}
                  disabled={busy}
                  editingAny={!!editor}
                  mode={editor?.id === device.id ? editor.mode : null}
                  setMode={(mode) => setEditor(mode ? { id: device.id, mode } : null)}
                  commit={commit}
                  openLocation={() => setDialog({ kind: "location", id: device.id })}
                  runRowAction={runRowAction}
                  rowAction={rowAction}
                  toggleFavorite={() =>
                    perform(() => favorite.mutateAsync({ id: device.id, favorite: !device.favorite }))
                  }
                  toggleServer={() => toggleServer(device)}
                />
              ))}
            </div>
            <p className="empty-list" id="empty-list" hidden={!!visible.length}>
              No matching devices. Try another search or clear the filters.
            </p>
            <p className="list-note">
              Locations apply to IPv4 traffic routed through XKeen. Direct and Block rules still
              apply. Main follows location changes and failover.
            </p>
          </div>
        )}
      </div>
      {inventory &&
        selected &&
        createPortal(
          <LocationDialog
            device={selected}
            inventory={inventory}
            close={() => setDialog(null)}
            check={checkResult}
            refresh={() => void refresh(true)}
          />,
          document.body,
        )}
      {inventory &&
        dialog?.kind === "routing" &&
        createPortal(
          <RoutingDialog inventory={inventory} close={() => setDialog(null)} />,
          document.body,
        )}
    </section>
  );
}
