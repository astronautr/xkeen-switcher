import { useCallback, useRef, useState, type ReactNode } from "react";
import { useSession } from "../api/queries";
import type { SessionDto } from "../api/types";
import { AccessContent, LogoutButton, PairingDialog, PasswordContent, useAuthGate } from "../features/auth";
import { AuthBrand } from "../features/auth/forms";
import { SettingsLayout, type SettingsNavigation } from "../features/settings/SettingsLayout";
import { SubscriptionPanel } from "../features/settings/subscription/SubscriptionPanel";
import { Button } from "../ui/Button";
import { MobileIcon, useMobile } from "../ui/mobile";
import { App } from "./App";
import { RouteSiteDraftProvider } from "./AppSessionProvider";
import { ActivitySheet } from "../features/activity/ActivitySheet";
import { PullToRefresh } from "./PullToRefresh";
import { openRouting } from "./navigation";

export type ApplicationProps = {
  main?: (navigation: SettingsNavigation, subscription: ReactNode) => ReactNode;
  routing?: (hash: string, navigation: SettingsNavigation) => ReactNode;
};

/** Both hash branches reconcile the same session-keyed authenticated layout. */
export function Application(props: ApplicationProps) {
  const { data: session } = useSession();
  const gate = useAuthGate();
  const [passwordReplacement, setPasswordReplacement] = useState<SessionDto>();
  const consumePasswordReturn = useCallback(() => setPasswordReplacement(undefined), []);
  // Match the verified cache entry so a different auth generation cannot use the return.
  const passwordReturn = passwordReplacement && passwordReplacement === session ? consumePasswordReturn : undefined;
  const showAuthenticated = (routingHash?: string) => (
    <AuthenticatedApplication key={session?.session_id} {...props} routingHash={routingHash}
      onPasswordSaved={setPasswordReplacement} passwordReturn={passwordReturn} />
  );
  return <>
    <App gate={gate} main={showAuthenticated()} routing={showAuthenticated} />
    <PullToRefresh />
  </>;
}

type Pairing = {
  source: "header" | "access";
  navigate: SettingsNavigation["navigate"];
};
const pairingCrumbs = [
  { label: "~", target: "closed", marker: "pair-settings-home" },
  { label: "settings", target: "menu", marker: "pair-settings-menu" },
  { label: "access", target: "access", marker: "pair-settings-access" },
] as const;

function PairingBreadcrumbs({ source, navigate, onClose }: Pairing & { onClose: () => void }) {
  return (
    <nav className="settings-breadcrumbs" aria-label="breadcrumb"><ol>
      {(source === "header" ? pairingCrumbs.slice(0, 1) : pairingCrumbs).map(({ label, target, marker }, index) => (
        <li key={target}>
          {index > 0 && <span className="settings-slash" aria-hidden="true">/</span>}
          <Button marker={marker} className="settings-crumb" aria-label={label === "~" ? "home" : label}
            onClick={() => { onClose(); navigate(target); }}>{label}</Button>
        </li>
      ))}
      <li><span className="settings-slash" aria-hidden="true">/</span><span aria-current="page">link device</span></li>
    </ol></nav>
  );
}

type AuthenticatedApplicationProps = ApplicationProps & {
  routingHash?: string;
  onPasswordSaved: (replacement?: SessionDto) => void;
  passwordReturn?: () => void;
};

function HeaderAction({ marker, label, icon, mobile, onClick }: {
  marker: string;
  label: string;
  icon: string;
  mobile: boolean;
  onClick: (trigger: HTMLButtonElement) => void;
}) {
  return <button
    type="button"
    className={mobile ? "t-settings-trigger mobile-icon-button" : "t-settings-trigger"}
    data-marker={marker}
    data-ui-variant="bracket"
    data-mobile-icon={mobile ? icon : undefined}
    aria-label={mobile ? label : undefined}
    title={mobile ? label : undefined}
    onClick={(event) => onClick(event.currentTarget)}
    >{mobile ? <MobileIcon name={icon} /> : label.toLowerCase()}</button>;
}

function AuthenticatedApplication({ main, routing, routingHash, onPasswordSaved, passwordReturn }: AuthenticatedApplicationProps) {
  const mobile = useMobile();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const pairingTrigger = useRef<HTMLButtonElement>(null);
  function openPairing(source: Pairing["source"], navigate: Pairing["navigate"], trigger: HTMLButtonElement) {
    pairingTrigger.current = trigger;
    setPairing({ source, navigate });
  }
  const closePairing = () => setPairing(null);
  const subscription = <SubscriptionPanel />;

  return <RouteSiteDraftProvider>
    <SettingsLayout
      access={({ navigate }) => <AccessContent
        onLinkDevice={(trigger) => openPairing("access", navigate, trigger)}
        onChangePassword={() => navigate("password")}
        />}
      password={({ navigate, setDirty, setSaving }) => <PasswordContent
        changing
        onCancel={() => navigate("access")}
        onSaved={onPasswordSaved}
        onDirtyChange={setDirty}
        onPendingChange={setSaving}
        />}
      signOut={<LogoutButton />}
      passwordReturn={passwordReturn}
      >
      {(navigation) => <>
        <ActivitySheet dock={!navigation.open && !routingHash} hidden={navigation.section === "password"} />
        {routingHash ? routing?.(routingHash, navigation) : <>
        <div className="t-head">
          <AuthBrand theme={navigation.theme} />
          <div className="t-head-right">
            {routing && <HeaderAction marker="nav-routing" label="Routing" icon="routing" mobile={mobile}
              onClick={openRouting} />}
            <HeaderAction marker="btn-add-device" label="Link device" icon="pair" mobile={mobile}
              onClick={(trigger) => openPairing("header", navigation.navigate, trigger)} />
            <HeaderAction marker="btn-settings" label="Settings" icon="settings" mobile={mobile}
              onClick={() => navigation.navigate("menu")} />
          </div>
        </div>
        {main ? main(navigation, subscription) : subscription}
        </>}
      </>}
    </SettingsLayout>
    <PairingDialog open={pairing !== null} onClose={closePairing}
      returnFocus={pairingTrigger}
      breadcrumbs={pairing && <PairingBreadcrumbs {...pairing} onClose={closePairing} />}
      />
  </RouteSiteDraftProvider>;
}
