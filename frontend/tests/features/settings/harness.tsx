import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../src/app/App";
import { AppSessionProvider, useNotifications } from "../../../src/app/AppSessionProvider";
import { SettingsLayout } from "../../../src/features/settings/SettingsLayout";
import { SubscriptionPanel, useSubscriptionActions } from "../../../src/features/settings/subscription/SubscriptionPanel";
import { useStatus } from "../../../src/api/queries";
import "../../../src/styles";

function Fixture() {
  const notifications = useNotifications();
  const actions = useSubscriptionActions();
  const status = useStatus();
  return (
    <App main={
      <SettingsLayout>
        {({ navigate }) => <>
          <button data-marker="btn-settings" onClick={() => navigate("menu")}>settings fixture</button>
          <SubscriptionPanel />
          <button data-marker="fixture-apply" onClick={() => void actions.applyPending()}>apply pending fixture</button>
          <output data-marker="fixture-pending">{status.data?.pending_reapply_code}</output>
          <output data-marker="fixture-notifications">{notifications.items.map((item) => item.message).join("\n")}</output>
        </>}
      </SettingsLayout>
    } />
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode><AppSessionProvider><Fixture /></AppSessionProvider></StrictMode>,
);
