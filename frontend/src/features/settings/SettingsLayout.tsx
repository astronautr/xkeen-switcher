import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { newOperationId } from "../../browser/storage";
import { useConnectivity, useFailover, useSessions, useStatus } from "../../api/queries";
import { useSaveAutoUpdate, useSaveConnectivity, useSaveFailover, useProbeLocations } from "../../api/mutations";
import { ApiError, classifyError, StaleSessionError } from "../../api/client";
import type { AutoUpdateInput, FailoverConfig } from "../../api/types";
import { useNotifications, useOperationTracking } from "../../app/AppSessionProvider";
import { useTheme } from "../../app/theme";
import type { Theme } from "../../browser/preferences";
import { ActionButton, Button } from "../../ui/Button";
import { TestSitesEditor, testSitesSaveError, testSitesSavedMessage } from "./TestSitesEditor";
import { ConfirmStrip } from "../../ui/feedback";
import { errorMessage } from "../../ui/format";
import { visibleControls } from "../../ui/overlays";
import { RouterUpdatesPanel } from "../router-updates/RouterUpdatesPanel";
import { AutoUpdateSection, FailoverSection } from "./forms";

export type SettingsSection = "menu" | "subscription" | "router-updates" | "failover" | "checks" | "access" | "password";
type Destination = SettingsSection | "closed";
export type SettingsNavigation = {
  open: boolean;
  section: SettingsSection;
  theme: Theme;
  navigate: (destination: Destination) => void;
};
export type SettingsAuthSlot = {
  navigate: (destination: Destination) => void;
  setDirty: (dirty: boolean) => void;
  setSaving: (saving: boolean) => void;
};
export type SettingsLayoutProps = {
  children: (navigation: SettingsNavigation) => ReactNode;
  access?: (slot: Pick<SettingsAuthSlot, "navigate">) => ReactNode;
  password?: (slot: SettingsAuthSlot) => ReactNode;
  signOut?: ReactNode;
  passwordReturn?: () => void;
};
function autoInput(value: AutoUpdateInput): AutoUpdateInput {
  return { enabled: value.enabled, mode: value.mode, daily_time: value.daily_time,
    interval_minutes: value.interval_minutes, sni_daily: value.sni_daily };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function SessionCount() {
  const { data } = useSessions(true, true);
  return data ? data.sessions.length + " signed-in browsers" : "loading…";
}

/** Owns the sole drawer, its host relationships and local navigation guard. */
export function SettingsLayout({ children, access, password, signOut, passwordReturn }: SettingsLayoutProps) {
  // Old browser history entries must not reopen settings in a replacement session.
  const [historyOwner] = useState(() => newOperationId());
  const [destination, setDestination] = useState<Destination>("closed");
  const [pending, setPending] = useState<Destination | null>(null);
  const [autoDraft, setAutoDraft] = useState<AutoUpdateInput | null>(null);
  const [failoverDraft, setFailoverDraft] = useState<FailoverConfig | null>(null);
  const [urlsDraft, setUrlsDraft] = useState<string[] | null>(null);
  const [sectionDirty, setSectionDirty] = useState(false);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [error, setError] = useState("");
  const open = destination !== "closed";
  const section = open ? destination : "menu";
  const status = useStatus();
  const failover = useFailover(open);
  const connectivity = useConnectivity(open);
  const saveAuto = useSaveAutoUpdate();
  const saveFailover = useSaveFailover();
  const saveConnectivity = useSaveConnectivity();
  const probe = useProbeLocations();
  const { publish } = useNotifications();
  const operation = useOperationTracking();
  const { theme, setTheme } = useTheme();
  const saving = saveAuto.isPending || saveFailover.isPending || saveConnectivity.isPending || sectionSaving;
  const dirty = section === "subscription" ? !!autoDraft && !same(autoDraft, status.data && autoInput(status.data.auto_update))
    : section === "failover" ? !!failoverDraft && !same(failoverDraft, failover.data?.config)
    : section === "checks" ? !!urlsDraft && !same(urlsDraft, connectivity.data?.config.check_urls)
    : sectionDirty;
  const composing = useRef(false);
  const drawer = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const discardTrigger = useRef<HTMLElement | null>(null);
  const latest = useRef({ destination, dirty, saving });
  latest.current = { destination, dirty, saving };
  const writeDestination = useCallback((next: Destination, replace = false) => {
    history[replace ? "replaceState" : "pushState"]({ ...history.state, xkSettings: next, xkSettingsOwner: historyOwner }, "", location.href);
  }, [historyOwner]);
  const enter = useCallback((next: Destination, writeHistory = true) => {
    if (writeHistory) writeDestination(next);
    setAutoDraft(null);
    setFailoverDraft(null);
    setUrlsDraft(null);
    setSectionDirty(false);
    setSectionSaving(false);
    setError("");
    setPending(null);
    setDestination(next);
  }, [writeDestination]);
  const askToDiscard = useCallback((next: Destination) => {
    discardTrigger.current = document.activeElement as HTMLElement;
    setPending(next);
  }, []);
  const navigate = useCallback((next: Destination) => {
    const current = latest.current;
    if (current.saving || next === current.destination) return;
    if (current.dirty) askToDiscard(next);
    else enter(next);
  }, [askToDiscard, enter]);
  useLayoutEffect(() => {
    if (!passwordReturn) return;
    writeDestination("access", true);
    enter("access", false);
    passwordReturn();
  }, [enter, passwordReturn, writeDestination]);
  useEffect(() => {
    function back(event: PopStateEvent) {
      const current = latest.current;
      const next: Destination = event.state?.xkSettingsOwner === historyOwner ? event.state.xkSettings : "closed";
      if (next === current.destination) return;
      if (current.saving || current.dirty) {
        writeDestination(current.destination);
        if (!current.saving) askToDiscard(next);
      } else enter(next, false);
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (latest.current.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("popstate", back);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("popstate", back);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [askToDiscard, enter, historyOwner, writeDestination]);
  useLayoutEffect(() => {
    if (!open) return;
    const focused = document.activeElement as HTMLElement | null;
    trigger.current = focused && focused !== document.body
      ? focused : scroll.current?.querySelector('[data-marker="btn-settings"]') ?? null;
    drawer.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      queueMicrotask(() => trigger.current?.focus({ preventScroll: true }));
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    // A pairing breadcrumb can close the dialog and remove its return button in one commit.
    queueMicrotask(() => {
      if (drawer.current && !drawer.current.inert && document.activeElement === document.body && !document.querySelector("dialog:modal")) {
        drawer.current.querySelector<HTMLElement>("button:enabled")?.focus({ preventScroll: true });
      }
    });
  }, [open, section]);
  useLayoutEffect(() => {
    if (!open) return;
    const wasLocked = document.body.classList.contains("settings-open");
    document.body.classList.add("settings-open");
    return () => {
      if (!wasLocked) document.body.classList.remove("settings-open");
    };
  }, [open]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.inert = open;
    if (drawer.current) drawer.current.inert = !open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function keyboard(event: KeyboardEvent) {
      if (composing.current || event.isComposing || event.defaultPrevented || document.querySelector("dialog:modal")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (pending !== null) setPending(null);
        else navigate("closed");
      } else if (event.key === "Tab" && drawer.current) {
        const controls = visibleControls(drawer.current);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [open, pending, navigate]);
  async function save() {
    if (!dirty || saving) return;
    setError("");
    try {
      if (section === "subscription" && autoDraft) {
        if (!Number.isInteger(autoDraft.interval_minutes) || autoDraft.interval_minutes < 5 || autoDraft.interval_minutes > 10080) {
          setError("enter 5–10080 whole minutes");
          return;
        }
        await saveAuto.mutateAsync(autoDraft);
        setAutoDraft(null);
        publish("Location update schedule saved");
      } else if (section === "failover" && failoverDraft) {
        await saveFailover.mutateAsync(failoverDraft);
        setFailoverDraft(null);
        publish("Failover settings saved");
      } else if (section === "checks" && urlsDraft) {
        const previous = connectivity.data?.config.check_urls ?? [];
        const saved = await saveConnectivity.mutateAsync({ check_urls: urlsDraft.map((url) => url.trim()) });
        setUrlsDraft(null);
        publish(testSitesSavedMessage(previous, saved.config.check_urls));
      }
    } catch (failure) {
      if (failure instanceof StaleSessionError) return;
      if (section === "checks") {
        setError(testSitesSaveError(failure));
        return;
      }
      const kind = classifyError(failure instanceof ApiError ? failure : {});
      setError(kind === "busy" ? "Router busy · nothing was saved. Your changes are kept; save again when it finishes."
        : kind === "unknown" ? "Save not confirmed. Your changes are kept; reload settings before saving again."
        : errorMessage(failure, "Could not save settings."));
    }
  }
  const labels: Record<SettingsSection, string> = {
    menu: "settings", "router-updates": "router updates", subscription: "location updates", failover: "failover", checks: "test sites", access: "access", password: "password",
  };
  const link = (target: SettingsSection, detail: ReactNode) => (
    <Button marker={`settings-${target}`} className="settings-link" onClick={() => navigate(target)}
      aria-labelledby={`settings-${target}-name settings-${target}-detail`}>
      <span><span id={`settings-${target}-name`} className="settings-link-name">{labels[target]}</span>
        <span id={`settings-${target}-detail`} className="t-note">{detail}</span></span>
      <span className="settings-chevron" aria-hidden="true">›</span>
    </Button>
  );
  const formSection = ["subscription", "failover", "checks"].includes(section);
  const Body = formSection ? "form" : "div";
  const urls = urlsDraft ?? connectivity.data?.config.check_urls ?? [];
  return (
    <div className={`app${open ? " drawer-open" : ""}`}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}>
      <div className="scroll" ref={scroll}>{children({ open, section, theme, navigate })}</div>
      <aside className="drawer" ref={drawer} aria-label="settings" data-marker="settings-drawer">
        <div className="drawer-head">
          <nav className="settings-breadcrumbs" aria-label="breadcrumb"><ol>
            <li><Button marker="settings-home" className="settings-crumb" aria-label="home" disabled={saving} onClick={() => navigate("closed")}>~</Button></li>
            <li><span className="settings-slash">/</span>{section === "menu" ? <span aria-current="page">settings</span>
              : <Button marker="settings-menu" className="settings-crumb" disabled={saving} onClick={() => navigate("menu")}>settings</Button>}</li>
            {section === "password" && <li><span className="settings-slash">/</span><Button marker="settings-access" className="settings-crumb" disabled={saving} onClick={() => navigate("access")}>access</Button></li>}
            {section !== "menu" && <li><span className="settings-slash">/</span><span aria-current="page">{labels[section]}</span></li>}
          </ol></nav>
          <Button marker="btn-drawer-close" variant="bracket" className="drawer-close" disabled={saving} onClick={() => navigate("closed")}>close</Button>
        </div>
        <Body className="drawer-body" id="settings-form" data-section={section} onSubmit={formSection ? (event) => {
          event.preventDefault();
          void save();
        } : undefined}>
          <fieldset className="settings-fields" disabled={saving}>
            {section === "menu" && <div data-marker="settings-menu-section">
              {link("subscription", "when to apply provider changes · subscription URL is on the home screen")}
              {link("router-updates", "XKeen and Xray versions, schedules and rollback")}
              {link("failover", failover.data ? `${failover.data.config.enabled ? "on" : "off"} · ${failover.data.config.whitelist.length} locations` : "loading…")}
              {link("checks", connectivity.data ? `${connectivity.data.config.check_urls.length} sites · check server route, failover and Find a working route` : "loading…")}
              {link("access", open ? <SessionCount /> : "loading…")}
              <section className="settings-section"><h2>appearance</h2>
                <div className="t-seg" data-marker="theme-seg" role="group" aria-label="appearance">
                  {(["light", "dark", "auto"] as const).map((choice) => <button type="button" key={choice}
                    data-marker={`theme-${choice}`} data-ui-variant="bracket"
                    className={`t-seg-btn${theme === choice ? " active" : ""}`} aria-pressed={theme === choice}
                    onClick={() => setTheme(choice)}>{choice === "auto" ? "system" : choice}</button>)}
                </div><p className="t-note">for this browser</p>
              </section>
              {signOut && <div className="settings-signout">{signOut}</div>}
            </div>}
            {section === "subscription" && status.data && <AutoUpdateSection status={status.data} value={autoDraft ?? autoInput(status.data.auto_update)} onChange={setAutoDraft} />}
            {section === "failover" && (failover.data && status.data ? <FailoverSection value={failoverDraft ?? failover.data.config}
              onChange={setFailoverDraft} status={status.data} data={failover.data} checkCount={connectivity.data?.config.check_urls.length} onChecks={() => navigate("checks")}
              probing={probe.isPending} blocked={operation.blocking}
              onProbe={() => probe.mutate({ codes: [...(failoverDraft ?? failover.data!.config).whitelist] }, {
                onError: (failure) => { if (!(failure instanceof StaleSessionError)) publish(errorMessage(failure), true); },
              })} /> : <section className="box" data-marker="fo-section-loading">
                <p>{failover.error ? errorMessage(failover.error) : "Loading failover settings…"}</p>
                {failover.error && <Button marker="failover-retry" onClick={() => void failover.refetch()}>retry</Button>}
              </section>)}
            {section === "checks" && <section className="box connectivity-box" data-marker="connectivity-section">
              <div className="box-title">test sites</div>
              {connectivity.error && <p role="alert">{errorMessage(connectivity.error)}<Button marker="connectivity-retry" onClick={() => void connectivity.refetch()}>retry</Button></p>}
              {!connectivity.data && !connectivity.error && <p>Loading test sites…</p>}
              {connectivity.data && <TestSitesEditor urls={urls} maxUrls={connectivity.data.max_urls}
                onChange={setUrlsDraft} hasResults={!!status.data?.route_check_run?.done} />}
            </section>}
            {section === "router-updates" && <RouterUpdatesPanel onDirty={setSectionDirty} onSaving={setSectionSaving} />}
            {section === "access" && access?.({ navigate })}
            {section === "password" && password?.({ navigate, setDirty: setSectionDirty, setSaving: setSectionSaving })}
          </fieldset>
        </Body>
        {error && <div className="settings-error" data-marker="settings-error" role="alert">{error}</div>}
        {formSection && <div className="settings-footer">
          <span className="t-note" data-marker="settings-save-status">{saving ? "" : dirty ? "unsaved changes" : "all changes saved"}</span>
          <ActionButton marker="settings-save" className="ui-button t-btn primary" type="submit" form="settings-form"
            idle="save" pending="saving" busy={saving} disabled={saving || !dirty} />
        </div>}
        {pending !== null && !saving && <ConfirmStrip marker="settings-discard-confirm" tone="danger" message="Discard unsaved changes?"
          cancelLabel="keep editing" confirmLabel="discard changes" cancelMarker="settings-keep-editing" confirmMarker="settings-discard" autoFocus
          returnFocus={discardTrigger} onCancel={() => setPending(null)} onConfirm={() => enter(pending)} />}
      </aside>
      <div className="drawer-backdrop" data-marker="drawer-backdrop" onClick={() => navigate("closed")} />
    </div>
  );
}
