import { useRef, useState, type ReactNode } from "react";
import type { StatusDto } from "../../api/types";
import { useXkeenControl } from "../../api/mutations";
import { useOperationTracking } from "../../app/AppSessionProvider";
import { ActionButton } from "../../ui/Button";
import { ConfirmStrip } from "../../ui/feedback";
import { useActionFeedback } from "./common";
import { PowerWave } from "./PowerWave";

export function PowerBox({
  status,
  mobile,
  outbound,
}: {
  status: StatusDto;
  mobile: boolean;
  outbound?: (wave: ReactNode) => ReactNode;
}) {
  const tracking = useOperationTracking();
  const control = useXkeenControl();
  const feedback = useActionFeedback();
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const stopped = status.xkeen_state === "stopped";
  const running = status.xkeen_state === "running";
  const pending = control.isPending;
  const phase = pending
    ? control.variables?.action === "start"
      ? "starting"
      : "stopping"
    : status.xkeen_state;
  const action = (pending ? phase === "starting" : stopped) ? "start" : "stop";
  const disabled = pending || tracking.blocking || (!running && !stopped);
  if ((disabled || !running) && confirm) setConfirm(false);
  function changePower() {
    if (disabled) return;
    setConfirm(false);
    void feedback(control.mutateAsync({ action }), () => (stopped ? "XKeen started" : "XKeen stopped"));
  }
  const label = pending ? phase : running || stopped ? status.xkeen_state : "not checked";
  const powerStatus = (
    <div className="power-status" role="status">
      <span className="power-dot" aria-hidden="true" />
      <span className="power-label">{label}</span>
    </div>
  );
  const caption = <p className="power-caption">proxy client</p>;
  const wave = <PowerWave active={phase === "running" || phase === "starting"} />;
  const powerButton = confirm ? (
    <ConfirmStrip
      marker="xkeen-stop-confirm"
      tone="danger"
      message="Stop XKeen?"
      detail="Proxy traffic stops for every device until XKeen is started again."
      cancelLabel="keep running"
      confirmLabel="stop xkeen"
      autoFocus
      returnFocus={trigger}
      onCancel={() => setConfirm(false)}
      onConfirm={changePower}
    />
  ) : (
    <ActionButton
      ref={trigger}
      marker="btn-xkeen-toggle"
      className="t-btn power-btn"
      data-action={action}
      idle={action}
      pending={action === "start" ? "starting" : "stopping"}
      busy={pending}
      aria-label={(pending ? phase : action) + " xkeen"}
      aria-describedby={tracking.blocking ? "activity-description" : disabled ? "power-reason" : undefined}
      disabled={disabled}
      onClick={() => (stopped ? changePower() : setConfirm(true))}
    />
  );

  return (
    <div
      className={"box power-box " + (pending ? "state-busy" : "state-" + status.xkeen_state)}
      data-marker="xkeen-state"
      data-state={status.xkeen_state}
      data-phase={phase}
    >
      <div className="box-title">{mobile ? "connection" : "xkeen"}</div>
      {mobile ? (
        <div className="mobile-power-row">
          {powerStatus}
          {powerButton}
        </div>
      ) : (
        <>
          {powerStatus}
          {caption}
          {wave}
          {powerButton}
        </>
      )}
      {disabled && !pending && !tracking.blocking && (
        <p className="visually-hidden" id="power-reason" data-marker="power-reason">
          Waiting for XKeen status.
        </p>
      )}
      {outbound?.(wave)}
    </div>
  );
}
