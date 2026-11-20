import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useCreatePairingCode } from "../../api/mutations";
import { usePairing, useSession, useSessions } from "../../api/queries";
import type { PairingDto } from "../../api/types";
import { StaleSessionError } from "../../api/client";
import { useNotifications } from "../../app/AppSessionProvider";
import { ActionButton, Button } from "../../ui/Button";
import { Dialog } from "../../ui/overlays";
import { authError } from "./forms";

export type PairingDialogProps = {
  open: boolean;
  onClose: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
  breadcrumbs?: ReactNode;
  operationSummary?: ReactNode;
  onCompleted?: (invitation: PairingDto) => void;
};

export function PairingDialog(props: PairingDialogProps) {
  const session = useSession();
  if (!session.data?.authenticated) return null;
  return <Invitation key={session.data.session_id} {...props} />;
}

function Invitation({ open, onClose, returnFocus, breadcrumbs, operationSummary, onCompleted }: PairingDialogProps) {
  const create = useCreatePairingCode();
  const [invitation, setInvitation] = useState<PairingDto | null>(null);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sessions = useSessions(false);
  const { publish } = useNotifications();
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const announced = useRef<string | null>(null);
  const completedCallback = useRef(onCompleted);
  completedCallback.current = onCompleted;
  const query = usePairing(invitation?.id ?? null, available, open);
  const code = invitation && query.data?.id === invitation.id
    ? { ...invitation, ...query.data } : invitation;
  const status = query.error?.status === 404 ? "unavailable" : code?.status ?? "pending";
  const pending = status === "pending";
  const completed = status === "completed";
  const remaining = Math.max(0, Math.ceil((code?.expires_at ?? 0) - now / 1000));

  async function renew() {
    if (create.isPending) return;
    if (document.activeElement?.getAttribute("data-marker") === "pair-new") {
      closeButton.current?.focus();
    }
    const sequence = ++generation.current;
    setAvailable(true);
    setInvitation(null);
    setError("");
    try {
      const result = await create.mutateAsync({});
      if (sequence === generation.current) {
        setNow(Date.now());
        setInvitation(result);
      }
    } catch (failure) {
      if (sequence === generation.current && !(failure instanceof StaleSessionError)) {
        setError(authError(failure));
      }
    }
  }

  useEffect(() => {
    // Opening with no invitation starts creation. Keep the same request across
    // close/reopen, and leave failures available for explicit renewal.
    if (!open || invitation || create.isPending) return;
    // StrictMode's rehearsal must not issue a second invitation mutation.
    let active = true;
    queueMicrotask(() => { if (active) void renew(); });
    return () => { active = false; };
  }, [open]);

  useEffect(() => () => {
    generation.current++;
  }, []);

  useEffect(() => {
    if (!open || !pending || !invitation) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, pending, invitation?.id]);

  useEffect(() => {
    if (query.error?.status === 404) setAvailable(false);
  }, [query.error]);

  useEffect(() => {
    if (completed && code && announced.current !== code.id) {
      announced.current = code.id;
      void sessions.refetch();
      if (!open) publish(`Browser signed in: ${code.device?.label ?? "Browser"}`);
      completedCallback.current?.(code);
    }
  }, [completed, code, open, publish, sessions]);

  const outcomes: Record<string, string> = {
    completed: `✓ ${code?.device?.label ?? "Browser"} signed in`,
    expired: "Code expired.",
    replaced: "A newer code replaced this one.",
    exhausted: "Code cancelled after five incorrect attempts.",
    cancelled: "Code cancelled.",
    unavailable: "This code is no longer available.",
  };
  const statusText = create.isPending ? ""
    : error || (query.error && status !== "unavailable" ? "Could not check connection. Retrying…" : "")
      || (pending && remaining ? `valid for ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
        : pending && code ? "checking sign-in status…" : "");

  return (
    <Dialog
      open={open}
      marker="pair-dialog"
      className="pair-dialog"
      aria-labelledby="pair-title"
      onClose={onClose}
      returnFocus={returnFocus}
      initialFocus='[data-marker="pair-close"]'>
      {breadcrumbs}
      <h2 id="pair-title">{completed ? "browser signed in" : "link device"}</h2>
      <p className="modal-operation-summary" role="status" data-marker="modal-operation">{operationSummary}</p>
      <p className="t-note" data-marker="pair-instructions">{completed ? "the other browser is signed in. manage it in settings → access." : pending ? "on the other device, open this app and choose “sign in with code”." : "create a new code to sign in on another browser."}</p>
      {/* Wrapped error text recenters the dialog. Repaint the placeholder at its new baseline. */}
      <div key={error} className="pair-code" data-marker="pair-code" hidden={!pending}>{!pending ? "" : remaining && code?.code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "— — —"}</div>
      <p
        className={"pair-result" + (completed ? " pair-success" : "")}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-marker="pair-result">{outcomes[status] ?? ""}</p>
      <p className="t-note" data-marker="pair-status">{statusText}</p>
      <div className="pair-actions">
        <ActionButton className="ui-button t-btn" marker="pair-new" disabled={create.isPending}
          idle={completed ? "create another code" : "new code"} pending="creating code" busy={create.isPending}
          onClick={() => { void renew(); }} />
        <Button variant="bracket" className="t-btn" marker="pair-close" ref={closeButton} onClick={onClose}>{completed ? "done" : "close"}</Button>
      </div>
    </Dialog>
  );
}
