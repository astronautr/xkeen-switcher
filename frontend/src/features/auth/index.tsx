import { useRetrySession, useSession } from "../../api/queries";
import { Button } from "../../ui/Button";
import { errorMessage } from "../../ui/format";
import { AuthBrand, LoginContent, PasswordContent } from "./forms";
export { LoginContent, PasswordContent } from "./forms";
export type { PasswordContentProps } from "./forms";
export { AccessContent, LogoutButton } from "./sessions";
export type { AccessContentProps } from "./sessions";
export { PairingDialog } from "./pairing";
export type { PairingDialogProps } from "./pairing";

/** Compose the returned node into App.gate under the one AppSessionProvider. */
export function useAuthGate() {
  const session = useSession();
  const retry = useRetrySession();
  if (session.data?.authenticated) return null;
  if (session.data) {
    return session.data.configured
      ? <LoginContent key="login" />
      : <PasswordContent key="setup" onCancel={() => { void retry(); }} />;
  }
  return (
    <div className="app">
      <div className="scroll">
        <div className="t-head"><AuthBrand /></div>
        <div className="t-meta">{session.error ? errorMessage(session.error, "connection failed") : "loading…"}</div>
        {session.error && <Button
          marker="boot-retry"
          variant="bracket"
          className="t-btn"
          onClick={() => { void retry(); }}>retry</Button>}
      </div>
    </div>
  );
}
