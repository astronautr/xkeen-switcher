import { useInsertionEffect, type ReactNode } from "react";
import { useRefreshStatus, useStatus } from "../../api/queries";
import type { SettingsNavigation } from "../settings/SettingsLayout";
import { Locations } from "./Locations";
import { RouterUpdateNotice } from "../router-updates/RouterUpdateNotice";
import { Connection } from "./Connection";
import { Notices, Offline } from "./Notices";
import { useMobile } from "../../ui/mobile";

export type MainDashboardProps = {
  subscription: ReactNode;
  devices?: ReactNode;
  navigate: SettingsNavigation["navigate"];
};

export function MainDashboard({ subscription, devices, navigate }: MainDashboardProps) {
  const query = useStatus();
  const refreshStatus = useRefreshStatus();
  const mobile = useMobile();
  // Install the breakpoint styles before the wave measures its canvas in a layout effect.
  useInsertionEffect(() => {
    document.body.classList.toggle("mobile-dashboard-home", mobile);
    return () => document.body.classList.remove("mobile-dashboard-home");
  }, [mobile]);
  const status = query.data;
  const offline = query.isError && (
    <Offline updated={query.dataUpdatedAt} retry={refreshStatus} />
  );
  if (!status) return offline || null;
  return (
    <>
      {offline}
      <Notices status={status} openFailover={() => navigate("failover")} />
      <RouterUpdateNotice available={status.router_updates?.available ?? []} open={() => navigate("router-updates")} />
      {subscription}
      <Connection status={status} mobile={mobile} openChecks={() => navigate("checks")} />
      <Locations status={status} mobile={mobile} />
      {devices}
    </>
  );
}
