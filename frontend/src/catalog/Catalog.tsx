import { Fragment, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Select, Menu } from "../ui/ChoicePopup";
import { Banner, ConfirmStrip, DisabledReason } from "../ui/feedback";
import { LocationRow, OperationStatus } from "../ui/domain";
import { formatDateTime, formatMoscow, formatElapsed } from "../ui/format";
import {
  BANNERS,
  COMMANDS,
  LOCATIONS,
  LOCATION_ROWS,
  NETWORKS,
  OPERATIONS,
  STOP_DETAIL,
} from "./fixtures";
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="box styleguide-section">
      <h2 className="box-title">{title}</h2>
      {children}
    </section>
  );
}
const noop = () => {};
export function Catalog() {
  const [selection, setSelection] = useState("No fixture action yet.");
  const [network, setNetwork] = useState("tcp");
  const [location, setLocation] = useState("tr");
  const [confirmation, setConfirmation] = useState("Choose an action.");
  const now = new Date();
  const formats = [
    ["local", formatDateTime(now)],
    ["schedule", formatMoscow(now)],
    ["elapsed", formatElapsed(3725000)],
    ["missing", formatDateTime(null)],
  ];
  return (
    <>
      <h1>xkeen.switch · components</h1>
      <Section title="theme">
        <div className="t-seg" role="group" aria-label="preview theme">
          {(["light", "dark"] as const).map((theme) => (
            <Button
              key={theme}
              marker={"styleguide-theme-" + theme}
              onClick={() => {
                document.documentElement.classList.remove("theme-light", "theme-dark");
                document.documentElement.classList.add("theme-" + theme);
              }}
            >
              {theme}
            </Button>
          ))}
        </div>
      </Section>
      <Section title="buttons">
        <div>
          <div className="ui-action-group" style={{ justifyContent: "flex-start" }}>
            <Button marker="sg-default" onClick={noop}>
              default
            </Button>
            <Button marker="sg-primary" variant="primary" onClick={noop}>
              primary
            </Button>
            <Button marker="sg-danger" variant="danger" onClick={noop}>
              danger
            </Button>
            <Button marker="sg-disabled" disabled aria-describedby="sg-reason">
              disabled with reason
            </Button>
          </div>
          <DisabledReason
            id="sg-reason"
            text="Paused while checking failover locations (failover)."
          />
        </div>
      </Section>
      <Section title="select and command menu">
        <Select
          label="Network"
          marker="sg-select"
          value={network}
          options={NETWORKS}
          onSelect={(value) => {
            setNetwork(value);
            setSelection("Selected network: " + value);
          }}
        />
        <Select
          rich
          label="Location"
          marker="sg-rich-select"
          value={location}
          options={LOCATIONS}
          onSelect={(value) => {
            setLocation(value);
            setSelection("Selected location: " + value);
          }}
        />
        <Menu
          label="Actions"
          marker="sg-menu"
          variant="bracket"
          options={COMMANDS}
          onSelect={(value) => setSelection("Fixture action: " + value + " (no request).")}
        />
        <p className="t-note">{selection}</p>
      </Section>
      <Section title="confirm strip">
        <div>
          <ConfirmStrip
            marker="sg-confirm"
            tone="danger"
            message="Stop XKeen?"
            detail={STOP_DETAIL}
            cancelLabel="keep running"
            confirmLabel="stop xkeen"
            onCancel={() => setConfirmation("Cancelled (no request).")}
            onConfirm={() => setConfirmation("Confirmed (fixture only, no request).")}
          />
          <p className="t-note">{confirmation}</p>
        </div>
      </Section>
      <Section title="operation bar">
        {OPERATIONS.map((operation) => (
          <OperationStatus key={operation.kind} operation={operation} elapsed={42000} />
        ))}
      </Section>
      <Section title="location list">
        <ul className="t-list">
          {LOCATION_ROWS.map((row) => (
            <LocationRow key={row.code} {...row} onSelect={noop} onCheck={noop} />
          ))}
        </ul>
      </Section>
      <Section title="notices">
        <div>
          {BANNERS.map((banner) => (
            <Banner key={banner.tone} {...banner}>
              {banner.text}
            </Banner>
          ))}
        </div>
      </Section>
      <Section title="formatters">
        <dl className="t-active-kv">
          {formats.map(([title, text]) => (
            <Fragment key={title}>
              <dt>{title}</dt>
              <dd>{text}</dd>
            </Fragment>
          ))}
        </dl>
      </Section>
    </>
  );
}
