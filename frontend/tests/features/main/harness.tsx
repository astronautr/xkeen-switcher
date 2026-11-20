import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "../../../src/app/Application";
import { AppSessionProvider } from "../../../src/app/AppSessionProvider";
import { MainDashboard } from "../../../src/features/main";
import { RoutingScreen } from "../../../src/features/routing";
import "../../../src/styles";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppSessionProvider>
      <Application
        routing={(hash, { open }) => <RoutingScreen hash={open ? "#routing" : hash} />}
        main={({ navigate }, subscription) => (
          <MainDashboard navigate={navigate} subscription={subscription} />
        )}
      />
    </AppSessionProvider>
  </StrictMode>,
);
