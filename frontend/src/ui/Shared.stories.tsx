import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Catalog } from "../catalog/Catalog";
import { LOCATIONS, LONG_NAME, STOP_DETAIL } from "../catalog/fixtures";
import { ActionButton, Button, IconButton } from "./Button";
import { Field } from "./Field";
import { ChoicePopup, Menu } from "./ChoicePopup";
import { ConfirmStrip, DisabledReason, Notice } from "./feedback";
import { Dialog, OverlayProvider } from "./overlays";
import { DeviceRow, PendingUpdateNotice, RouteLabel } from "./domain";
const meta: Meta = { title: "Shared/Approved primitives" };
export default meta;
type Story = StoryObj;
export const LightCatalog: Story = { globals: { theme: "light" }, render: () => <Catalog /> };
export const DarkCatalog: Story = { globals: { theme: "dark" }, render: () => <Catalog /> };
function States() {
  const [value, setValue] = useState("tr");
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <OverlayProvider>
      <div className="box">
        <h1>Primitive states</h1>
        <div className="ui-action-group">
          <ActionButton marker="story-busy" idle="refresh" pending="refreshing" busy />
          <Button marker="story-error" variant="danger">
            retry
          </Button>
          <IconButton marker="story-icon" label="Settings" icon="settings" />
          <Button marker="story-disabled" disabled aria-describedby="story-reason">
            disabled
          </Button>
        </div>
        <DisabledReason
          id="story-reason"
          text="Paused while checking failover locations (failover)."
        />
        <Notice title="Request not accepted" detail="Your edits are kept." kind="danger" />
        <Field marker="story-field" aria-label="Name" defaultValue={LONG_NAME} />
        <ChoicePopup
          marker="story-select"
          label="Location"
          options={LOCATIONS}
          value={value}
          onSelect={setValue}
        />
        <Menu
          marker="story-menu"
          label="Actions"
          options={[
            { value: "save", label: "Save" },
            { value: "disabled", label: "Unavailable", disabled: true },
          ]}
          onSelect={() => {}}
        />
        <Button marker="story-open" onClick={() => setDialog(true)}>
          open dialog
        </Button>
        <Button marker="story-confirm" onClick={() => setConfirm(true)}>
          stop xkeen
        </Button>
        {confirm ? (
          <ConfirmStrip
            marker="story-strip"
            tone="danger"
            message="Stop XKeen?"
            detail={STOP_DETAIL}
            autoFocus
            onCancel={() => setConfirm(false)}
            onConfirm={() => setConfirm(false)}
          />
        ) : null}
        <PendingUpdateNotice
          state="pending"
          hasUpdate
          optional
          title="optional update · only SNI has changed"
          details={["Auto-apply at 04:30 MSK"]}
          action={<Button marker="story-apply">apply now</Button>}
        />
        <p>
          <RouteLabel entry="Japan" exit="Singapore" />
        </p>
        <div role="list">
          <DeviceRow
            id="fixture-device"
            identity={<strong>{LONG_NAME}</strong>}
            state="Online"
            policy="XKeen"
            location="Use Main route"
            actions={<Button marker="story-device-action">Rename</Button>}
          />
        </div>
        <Dialog
          open={dialog}
          marker="story-dialog"
          className="pair-dialog"
          aria-labelledby="story-title"
          onClose={() => setDialog(false)}
        >
          <h2 id="story-title">Native dialog</h2>
          <Field marker="story-modal-field" aria-label="Dialog name" />
          <Button marker="story-close" onClick={() => setDialog(false)}>
            close
          </Button>
        </Dialog>
      </div>
    </OverlayProvider>
  );
}
export const InteractiveLight: Story = { globals: { theme: "light" }, render: () => <States /> };
export const InteractiveDark: Story = { globals: { theme: "dark" }, render: () => <States /> };
