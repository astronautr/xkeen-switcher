import { useState } from "react";
import { LegacyActivityIndicator } from "./LegacyActivityIndicator";
import "./legacy-activity.css";
import { useActivity } from "../../../src/app/AppSessionProvider";
import { createRoot } from "react-dom/client";
import { App } from "../../../src/app/App";
import { AppSessionProvider, useNotifications } from "../../../src/app/AppSessionProvider";
import { DevicesPanel, useDeviceUndo } from "../../../src/features/devices";
import "../../../src/styles";

function Outcomes() {
  const { items } = useNotifications();
  const [open, setOpen] = useState(false);
  const { activity } = useActivity();
  const { undo, operation, pending } = useDeviceUndo();
  return (
    <>
      {/* Frozen legacy launcher: the G1 dialog pixel baselines include its geometry. */}
      <LegacyActivityIndicator
        open={open}
        onOpenChange={setOpen}
        label={activity.label}
        description={activity.description}
        active={activity.active}
        attention={activity.attention}
      />
      <aside aria-label="Fixture outcomes">
        {items.map((item, index) => (
          <div key={index}>
            {item.message}
            {item.device_operation &&
              (operation(item.device_operation)?.undoable === false ? (
                operation(item.device_operation)?.undo_reason
              ) : (
                <button disabled={pending} onClick={() => undo(item.device_operation!)}>
                  Undo fixture change
                </button>
              ))}
          </div>
        ))}
      </aside>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <AppSessionProvider>
    <App main={<DevicesPanel />} overlays={<Outcomes />} />
  </AppSessionProvider>,
);
