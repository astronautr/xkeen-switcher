import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles";
import { Application } from "./app/Application";
import { AppSessionProvider } from "./app/AppSessionProvider";
import { DevicesPanel } from "./features/devices";
import { MainDashboard } from "./features/main";
import { RoutingScreen } from "./features/routing";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <AppSessionProvider>
      <Application
        // A native routing dialog would escape the inert background and take
        // focus from an open settings drawer. Reveal the requested panel on close.
        routing={(hash, { open }) => <RoutingScreen hash={open ? "#routing" : hash} />}
        main={({ navigate }, subscription) => (
          <MainDashboard navigate={navigate} subscription={subscription} devices={<DevicesPanel />} />
        )}
      />
    </AppSessionProvider>
  </StrictMode>,
);
