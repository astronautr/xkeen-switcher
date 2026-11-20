import { useState } from "react";
import { useSession, useSessions } from "../../api/queries";
import { useLogout, useRevokeSession } from "../../api/mutations";
import { StaleSessionError } from "../../api/client";
import { useNotifications } from "../../app/AppSessionProvider";
import { ActionButton, Button } from "../../ui/Button";
import { formatDateTime } from "../../ui/format";
import { authError } from "./forms";

export type AccessContentProps = {
  onLinkDevice: (trigger: HTMLButtonElement) => void;
  onChangePassword: () => void;
};

export function AccessContent(props: AccessContentProps) {
  const session = useSession();
  return session.data?.authenticated
    ? <BrowserSessions key={session.data.session_id} {...props} /> : null;
}

function BrowserSessions({ onLinkDevice, onChangePassword }: AccessContentProps) {
  const sessions = useSessions(true, true);
  const revoke = useRevokeSession();
  const [refreshing, setRefreshing] = useState(false);
  const notifications = useNotifications();

  async function refresh() {
    setRefreshing(true);
    try {
      await sessions.refetch();
    } finally {
      setRefreshing(false);
    }
  }

  async function signOut(id: string) {
    if (revoke.isPending) return;
    try {
      await revoke.mutateAsync({ id });
    } catch (error) {
      if (!(error instanceof StaleSessionError)) notifications.publish(authError(error), true);
    }
  }

  return (
    <div>
      <section className="box" data-marker="devices-section">
        <h2 className="box-title">signed-in browsers</h2>
        <Button marker="settings-link-device" className="t-btn" variant="bracket"
          onClick={(event) => onLinkDevice(event.currentTarget)}>link device</Button>
        {sessions.error && <p className="g-err">{authError(sessions.error)}</p>}
        {!sessions.data && !sessions.error && <p className="t-note">loading browsers…</p>}
        <div>
          {sessions.data?.sessions.map((session) => (
            <div className="device-row" data-marker="device-row" key={session.id}>
              <div>
                <div>{session.label}</div>
                {session.current && <div className="device-current" data-marker="device-current">this browser</div>}
                <div className="t-note">signed in {formatDateTime(session.created_at)}</div>
              </div>
              <ActionButton
                marker="device-revoke"
                idle="sign out"
                pending="signing out"
                busy={revoke.isPending && revoke.variables?.id === session.id}
                data-id={session.id}
                className="ui-button t-btn"
                disabled={revoke.isPending}
                onClick={() => { void signOut(session.id); }} />
            </div>
          ))}
        </div>
        <div className="pair-actions">
          <ActionButton marker="devices-refresh" className="ui-button t-btn"
            idle="refresh list" pending="refreshing" busy={refreshing}
            disabled={refreshing} onClick={refresh} />
        </div>
      </section>
      <section className="box">
        <h2 className="box-title">admin password</h2>
        <p className="t-note">changing the password signs out other browsers.</p>
        <Button marker="btn-change-password" variant="bracket" className="t-btn" onClick={onChangePassword}>change password</Button>
      </section>
    </div>
  );
}

export function LogoutButton() {
  const logout = useLogout();
  const notifications = useNotifications();
  return (
    <ActionButton marker="btn-logout" className="ui-button t-btn" disabled={logout.isPending}
      idle="sign out" pending="signing out" busy={logout.isPending} onClick={() => {
      void logout.mutateAsync().catch((error) => {
        if (!(error instanceof StaleSessionError)) notifications.publish(authError(error), true);
      });
    }} />
  );
}
