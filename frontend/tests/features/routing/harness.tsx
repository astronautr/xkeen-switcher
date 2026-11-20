import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/styles";
import { Application } from "../../../src/app/Application";
import { AppSessionProvider } from "../../../src/app/AppSessionProvider";
import { RoutingScreen } from "../../../src/features/routing";
import { DevicesPanel } from "../../../src/features/devices";
import { MainDashboard } from "../../../src/features/main";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <AppSessionProvider>
      <Application
        routing={(hash) => <RoutingScreen hash={hash} />}
        main={({ navigate }, subscription) => (
          <MainDashboard navigate={navigate} subscription={subscription} devices={<DevicesPanel />} />
        )}
      />
    </AppSessionProvider>
  </StrictMode>,
);
