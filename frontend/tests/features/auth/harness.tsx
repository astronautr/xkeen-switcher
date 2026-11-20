/** Supplemental feature composition; deliberately contains no dashboard renderer. */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../src/app/App";
import { AppSessionProvider, useActivity } from "../../../src/app/AppSessionProvider";
import { useSession, useStatus } from "../../../src/api/queries";
import { AccessContent, LogoutButton, PairingDialog, PasswordContent, useAuthGate } from "../../../src/features/auth";
import { Button } from "../../../src/ui/Button";
import "../../../src/styles";

function Harness() {
  const gate = useAuthGate();
  const activity = useActivity();
  const session = useSession();
  const status = useStatus();
  const [password, setPassword] = useState(false);
  const [pairing, setPairing] = useState(false);
  const identity = session.data?.session_id;
  return (
    <App gate={gate} header={<Button marker="btn-add-device" onClick={() => setPairing(true)}>link device</Button>} main={
      <main>
        <p>Auth feature fixture</p>
        <output data-marker="fixture-pending">{activity.pendingMutations}</output>
        <PairingDialog open={pairing} onClose={() => setPairing(false)} />
        <output data-marker="fixture-session">{identity}</output>
        <output data-marker="fixture-status">{status.data?.active_code}</output>
        <LogoutButton />
        {password
          ? <PasswordContent changing key={identity} onCancel={() => setPassword(false)} onSaved={() => { setPassword(false); setPairing(false); }} />
          : <AccessContent onLinkDevice={() => setPairing(true)} onChangePassword={() => setPassword(true)} />}
      </main>
    } />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppSessionProvider><Harness /></AppSessionProvider></StrictMode>,
);
