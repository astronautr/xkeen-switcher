/** Supplemental real-provider shared UI scenarios, never production entries. */
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles";
import { AppSessionProvider } from "../../src/app/AppSessionProvider";
import { App } from "../../src/app/App";
import { navigateHash, useHashRoute } from "../../src/app/navigation";
import { useTheme } from "../../src/app/theme";
import { useStatus } from "../../src/api/queries";
import { Button, ActionButton } from "../../src/ui/Button";
import { Field, Textarea } from "../../src/ui/Field";
import { ChoicePopup, Menu } from "../../src/ui/ChoicePopup";
import { ConfirmStrip, DisabledReason, Notice } from "../../src/ui/feedback";
import { Dialog, NotificationPortal, OverlayPortal } from "../../src/ui/overlays";
import { LONG_NAME } from "../../src/catalog/fixtures";
const OPTIONS = [
  { value: "all", label: "All" },
  { value: "se", label: "Sweden" },
  { value: "sg", label: "Singapore" },
  { value: "nl", label: LONG_NAME },
  { value: "disabled", label: "Unavailable", disabled: true },
];
function FieldDemo() {
  const status = useStatus();
  const [value, setValue] = useState("A saved draft across polling");
  const [choice, setChoice] = useState("all");
  const [count, setCount] = useState(0);
  return (
    <section data-marker="stable-section">
      <h1>Shared components</h1>
      <output hidden data-marker="updated">
        {status.dataUpdatedAt}
      </output>
      <label htmlFor="draft">Draft</label>
      <Field
        id="draft"
        marker="field"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <Textarea marker="textarea" aria-label="Notes" defaultValue="Draft notes" />
      <ChoicePopup
        marker="choice"
        label="Location"
        options={OPTIONS}
        value={choice}
        onSelect={(value) => {
          setChoice(value);
          setCount(count + 1);
        }}
      />
      <Menu
        marker="command"
        label="Commands"
        options={OPTIONS}
        onSelect={() => setCount(count + 1)}
      />
      <output data-marker="choice-count">{count}</output>
      <Button marker="after-choice">after choice</Button>
      <ActionButton marker="busy-action" idle="refresh" pending="refreshing" busy />
      <Button marker="disabled" disabled aria-describedby="disabled-detail">
        disabled
      </Button>
      <DisabledReason
        id="disabled-detail"
        text="Paused while checking failover locations (failover)."
      />
      <form onSubmit={(event) => event.preventDefault()}>
        <Field marker="required" aria-label="Required name" required minLength={8} />
        <Button marker="validate" type="submit">
          validate
        </Button>
      </form>
    </section>
  );
}
function DevicesFilterDemo() {
  const [policies, setPolicies] = useState<ReadonlySet<string>>(new Set());
  const options = [
    { value: "all", label: "All policies" },
    { value: "direct", label: "Direct" },
    { value: "proxy", label: "Proxy" },
  ];
  const labels = options
    .filter((option) => policies.has(option.value))
    .map((option) => option.label);
  const caption = labels.length > 1 ? `Policies · ${labels.length}` : (labels[0] ?? "All policies");
  return (
    <div className="device-tools">
      <ChoicePopup
        variant="device"
        marker="policies-filter"
        label="Filter by access policy"
        caption={caption}
        title={labels.join(", ") || caption}
        triggerLabel={`Filter by policies: ${caption}`}
        options={options}
        value={policies}
        onSelect={(value) => {
          const next = new Set(policies);
          if (value === "all") next.clear();
          else if (next.has(value)) next.delete(value);
          else next.add(value);
          setPolicies(next);
        }}
      />
    </div>
  );
}
function Harness() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [gate, setGate] = useState(false);
  const [toast, setToast] = useState("Fixture notification");
  const [multi, setMulti] = useState<ReadonlySet<string>>(new Set());
  const trigger = useRef<HTMLButtonElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  const { theme, setTheme } = useTheme();
  const hash = useHashRoute();
  return (
    <App
      gate={
        gate ? (
          <Button marker="leave-gate" onClick={() => setGate(false)}>
            leave gate
          </Button>
        ) : undefined
      }
      header={
        <nav>
          <Button marker="nav-main" onClick={() => navigateHash("")}>
            main
          </Button>
          <Button
            marker="nav-routing"
            onClick={() => navigateHash("routing/edit", { state: { xkRouting: 2 } })}
          >
            routing
          </Button>
          <Button
            marker="gate"
            onClick={() => {
              setDialog(false);
              setGate(true);
            }}
          >
            gate
          </Button>
          <Button marker="theme-auto" onClick={() => setTheme("auto")}>
            system
          </Button>
          <Button marker="theme-light" onClick={() => setTheme("light")}>
            light
          </Button>
          <Button marker="theme-dark" onClick={() => setTheme("dark")}>
            dark
          </Button>
          <output data-marker="theme">{theme}</output>
        </nav>
      }
      main={
        <>
          <FieldDemo />
          <Button ref={trigger} marker="open-dialog" onClick={() => setDialog(true)}>
            open dialog
          </Button>
          <Button ref={stop} marker="open-confirm" onClick={() => setConfirm(true)}>
            stop xkeen
          </Button>
          {confirm ? (
            <ConfirmStrip
              marker="confirm"
              tone="danger"
              message="Stop XKeen?"
              autoFocus
              returnFocus={stop}
              onCancel={() => setConfirm(false)}
              onConfirm={() => setConfirm(false)}
            />
          ) : null}
          <ChoicePopup
            marker="multi"
            label="Multi"
            options={OPTIONS}
            value={multi}
            onSelect={(value) =>
              setMulti((previous) => {
                const next = new Set(previous);
                if (value === "all") next.clear();
                else if (next.has(value)) next.delete(value);
                else next.add(value);
                return next;
              })
            }
          />
          <Dialog
            open={dialog}
            marker="dialog"
            className="pair-dialog"
            aria-labelledby="dialog-title"
            returnFocus={trigger}
            initialFocus="[data-marker=dialog-first]"
            onClose={() => setDialog(false)}
          >
            <h2 id="dialog-title">Native dialog</h2>
            <Button marker="dialog-first" onClick={() => setToast("Updated fixture notification")}>
              first
            </Button>
            <Field
              marker="dialog-field"
              aria-label="Dialog draft"
              defaultValue="Retained dialog draft"
            />
            <Button marker="dialog-close" onClick={() => setDialog(false)}>
              close
            </Button>
            <Button
              marker="dialog-gate"
              onClick={() => {
                setDialog(false);
                setGate(true);
              }}
            >
              show gate
            </Button>
          </Dialog>
        </>
      }
      routing={(route) => (
        <section data-marker="routing-slot">
          <h1>Routing fixture slot</h1>
          <output>{route}</output>
          <output data-marker="history-state">{JSON.stringify(history.state)}</output>
        </section>
      )}
      overlays={
        <>
          <NotificationPortal>
            <div className="toast show" data-marker="fixture-toast">
              {toast}
            </div>
          </NotificationPortal>
          <Notice title={toast} />
          <span data-marker="portal-state">{hash}</span>
          <OverlayPortal className="fixture-overlay">
            <button type="button" data-marker="overlay-control">overlay control</button>
          </OverlayPortal>
        </>
      }
    />
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppSessionProvider>
      {location.search === "?device-filter" ? <DevicesFilterDemo /> : <Harness />}
    </AppSessionProvider>
  </StrictMode>,
);
