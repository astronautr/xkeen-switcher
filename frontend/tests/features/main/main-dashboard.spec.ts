import { test, expect } from "../../support/test";
import { createScenario, marker, NOW, openApp } from "../../support/scenario";
import { confirmedChain, ephemeralActivity, serverContext } from "../../support/main-contracts";

test("Main reconciles duplicate location codes in the list and open chain selector after polling", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("M01:duplicate-auto").switch("held");
  const [finland, germany] = scenario.state.status.available;
  const firstAuto = { ...finland, code: "auto", name: "Auto One" };
  const secondAuto = { ...germany, code: "auto", name: "Auto Two" };
  scenario.state.status.available = [firstAuto, secondAuto, finland, germany];
  await openApp(page, scenario, baseURL!);
  const rows = marker(page, "loc-row").locator(".name");
  await expect(rows).toHaveText(["Auto One", "Auto Two", "Finland 🇫🇮", "Germany 🇩🇪"]);
  await marker(page, "main-mode-chain").click();
  await marker(page, "chain-entry").click();
  const options = marker(page, "chain-entry-popup").getByRole("option");
  await expect(options).toHaveCount(4);

  scenario.state.status.available = [germany, secondAuto, finland];
  await page.clock.runFor(10_001);
  await expect(rows).toHaveText(["Germany 🇩🇪", "Auto Two", "Finland 🇫🇮"]);
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAccessibleName("Germany 🇩🇪");
  await expect(options.nth(1)).toHaveAccessibleName("Auto Two");
  await expect(options.nth(2)).toHaveAccessibleName("Finland 🇫🇮");
  await options.nth(1).click();
  await marker(page, "chain-apply").click();
  await expect.poll(() => scenario.requests.find((request) => request.path === "/api/switch")?.body)
    .toMatchObject({ code: "fi", entry_code: "auto" });
  await scenario.release("switch");
});

test("Main explains an off-list location and keeps the stale subscription notice on a chain", async ({ page, baseURL }) => {
  const scenario = createScenario("M07:off-list");
  Object.assign(scenario.state.status.failover, { enabled: true, active: false, whitelist: ["de"] });
  scenario.state.status.last_update_status = "fail";
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "banner-offlist")).toContainText("Main Finland 🇫🇮 is not a failover location · failover inactive");
  await expect(marker(page, "banner-stale")).toBeVisible();
  confirmedChain(scenario);
  await page.clock.runFor(10_001);
  await expect(marker(page, "banner-offlist")).toHaveCount(0);
  await expect(marker(page, "failover-paused")).toBeVisible();
  await expect(marker(page, "banner-stale")).toBeVisible();
});

test("Main header and subscription keep their controls and names at the mobile breakpoint", async ({ page, baseURL }) => {
  const scenario = createScenario("X02:mobile-actions");
  await page.setViewportSize({ width: 641, height: 844 });
  await openApp(page, scenario, baseURL!);
  const settings = marker(page, "btn-settings");
  const refresh = marker(page, "btn-update-sub");
  await expect(refresh).toBeVisible();
  await settings.focus();
  await page.setViewportSize({ width: 640, height: 844 });
  await expect(settings.locator("use")).toHaveAttribute("href", "/mobile-icons.svg#ico-settings");
  await expect(settings).toHaveAccessibleName("Settings");
  await expect(settings).toBeFocused();
  await expect(marker(page, "btn-add-device")).toHaveAccessibleName("Link device");
  await expect(refresh).toHaveAccessibleName("Refresh subscription");
  await expect(refresh.locator("use")).toHaveAttribute("href", "/mobile-icons.svg#ico-refresh");
  scenario.on("POST", "/api/update", () => ({ hold: "refresh", body: { ok: true } }));
  await refresh.click();
  await expect(refresh).toHaveAccessibleName("Refreshing subscription");
  await expect(refresh.locator(".terminal-action-glyph")).toBeVisible();
  await scenario.release("refresh");
  await expect(refresh).toHaveAccessibleName("Refresh subscription");
  await page.setViewportSize({ width: 641, height: 844 });
  await expect(settings).toHaveText("settings");
  await expect(refresh.locator(".terminal-action-label")).toHaveText("refresh");
});

test("Main distinguishes requested and confirmed chains with the same exit", async ({ page, baseURL }) => {
  const scenario = createScenario("M01:pair").switch("held");
  confirmedChain(scenario);
  await openApp(page, scenario, baseURL!);
  await marker(page, "chain-entry").click();
  await expect(marker(page, "chain-entry-option-fi")).toBeDisabled();
  await marker(page, "chain-entry-option-se").click();
  expect(scenario.count("POST", "/api/switch")).toBe(0);
  await marker(page, "chain-apply").click();
  await expect(marker(page, "main-requested")).toHaveText("Requested Main: Sweden 🇸🇪 → Finland 🇫🇮");
  await expect(marker(page, "main-switch-status")).toHaveAttribute("data-phase", "preparing");
  await expect(marker(page, "chain-entry")).toBeDisabled();
  await expect(marker(page, "chain-exit")).toBeDisabled();
  await expect(marker(page, "main-mode-chain").locator('[data-marker="main-mode-active"]')).toHaveCount(1);
  await expect(marker(page, "main-mode-single").locator('[data-marker="main-mode-active"]')).toHaveCount(0);
  await expect(marker(page, "active-name")).toHaveText("Germany 🇩🇪 → Finland 🇫🇮");
  await expect(marker(page, "btn-xkeen-toggle")).toBeDisabled();
  await expect(marker(page, "btn-route-check")).toBeDisabled();
  await expect(marker(page, "btn-update-sub")).toBeDisabled();
  await expect(marker(page, "locations-reason")).not.toBeEmpty();
  scenario.advance("committed");
  await page.clock.runFor(1600);
  await expect(marker(page, "active-name")).toHaveText("Sweden 🇸🇪 → Finland 🇫🇮");
  await expect(marker(page, "main-requested")).toHaveCount(0);
  await scenario.release("switch");
});

test("Main permits chain draft edits while an ephemeral read blocks all mutations", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("M06:reading");
  confirmedChain(scenario);
  ephemeralActivity(scenario, "read");
  await openApp(page, scenario, baseURL!);
  await marker(page, "chain-entry").click();
  await marker(page, "chain-entry-option-se").click();
  await expect(marker(page, "chain-entry")).toContainText("Sweden");
  await expect(marker(page, "chain-apply")).toBeDisabled();
  await expect(marker(page, "btn-check-all")).toBeDisabled();
  await expect(marker(page, "locations")).not.toContainText("Reading devices");
  await expect(marker(page, "chain-apply")).toHaveAttribute("aria-describedby", "activity-description");
  expect(scenario.requests.filter((r) => r.method !== "GET")).toEqual([]);
});

for (const kind of ["sni", "config"]) {
  test(
    "Main keeps the pending " + kind + " pair actionable after refresh failure",
    async ({ page, baseURL }) => {
      const scenario = createScenario("S02:pending-" + kind);
      confirmedChain(scenario);
      const status = scenario.state.status;
      Object.assign(status, {
        pending_reapply_code: "fi",
        pending_reapply_entry_code: "de",
        pending_update_kind: kind,
      });
      status.auto_update.enabled = false;
      scenario.on("POST", "/api/update", () => {
        status.last_update_status = "fail";
        return { status: 503, body: { code: "unavailable", error: "Subscription refresh failed" } };
      });
      scenario.on("POST", "/api/active-refresh", (request) => {
        expect(request.body).toEqual({});
        return { status: 503, body: { code: "unavailable", error: "Subscription refresh failed" } };
      });
      await openApp(page, scenario, baseURL!);
      await marker(page, "btn-update-sub").click();
      await expect(marker(page, "subscription-toggle")).toContainText("refresh failed");
      const pending = marker(page, "pending-active-config");
      await expect(pending.locator("b")).toHaveText(
        kind === "sni" ? "optional update · only SNI has changed" : "! update available",
      );
      await expect(pending.locator(".pending-config-detail")).toHaveText(
        "subscription refresh failed · Germany 🇩🇪 → Finland 🇫🇮 · auto-apply off",
      );
      await expect(marker(page, "banner-stale")).toBeVisible();
      await expect(marker(page, "failover-paused")).toBeVisible();
      await marker(page, "btn-apply-active-config").click();
      await expect.poll(() => scenario.count("GET", "/api/status")).toBeGreaterThanOrEqual(3);
      await expect(pending).toHaveAttribute("data-state", "pending");
      expect(scenario.count("POST", "/api/active-refresh")).toBe(1);
    },
  );
}

test("Main never promises freshness without a successful refresh timestamp", async ({ page, baseURL }) => {
  const scenario = createScenario("S01:no-success");
  scenario.state.status.last_update_at = null;
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "pending-active-config")).toContainText("config freshness unknown");
  await expect(marker(page, "subscription-last-success")).toHaveText("no successful refresh");
});

test("Main starts stopped XKeen directly and restores focus after cancelling stop", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("S04:start");
  scenario.state.status.xkeen_state = "stopped";
  scenario.on("POST", "/api/xkeen", (request) => {
    expect(request.body).toEqual({ action: "start" });
    scenario.state.status.xkeen_state = "running";
    return { body: { ok: true, action: "start" } };
  });
  await openApp(page, scenario, baseURL!);
  const toggle = marker(page, "btn-xkeen-toggle");
  await toggle.click();
  await expect(toggle).toHaveAccessibleName("stop xkeen");
  await toggle.click();
  await expect(marker(page, "xkeen-stop-confirm-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  expect(scenario.count("POST", "/api/xkeen")).toBe(1);
});

test("Main route check immediately excludes location probes and reads its attributed results", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("S05:route");
  scenario.on("POST", "/api/route-check", (request) => {
    expect(request.body).toEqual({});
    serverContext(scenario, "fixed");
    return { hold: "checking", body: { scope: "server", ok: true, checked_at: NOW } };
  });
  await openApp(page, scenario, baseURL!);
  const active = page.locator('[data-marker="loc-select"][data-code="fi"]');
  await expect(active).toHaveAttribute("aria-current", "true");
  await active.click();
  await marker(page, "btn-route-check").click();
  const probe = page.locator('[data-marker="btn-probe"][data-code="de"]');
  await expect(probe).toBeDisabled();
  await expect(probe).toHaveAccessibleDescription(/Checking route/);
  await probe.press("Enter");
  expect(scenario.count("POST", "/api/probe")).toBe(0);
  expect(scenario.count("POST", "/api/switch")).toBe(0);
  await scenario.release("checking");
  await expect(marker(page, "route-check-result")).toContainText("server route ok · tcp 24ms");
  await expect(marker(page, "outbound-default")).toContainText("Finland");
});

for (const mobile of [false, true]) {
  test("Main layout and details at " + (mobile ? "390" : "1440") + "px", async ({ page, baseURL }, info) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, createScenario("X01:layout"), baseURL!);
    await expect(marker(page, "active-name")).toBeVisible();
    if (mobile) {
      await marker(page, "mobile-connection-details").click();
      await page.clock.runFor(10_001);
      await expect(marker(page, "outbound-ping")).toBeVisible();
    }
    const screenshot = await page.screenshot({ path: info.outputPath("main.png"), scale: "css" });
    await info.attach("Main feature rendering", { body: screenshot, contentType: "image/png" });
    await marker(page, "btn-edit-route-check").click();
    await expect(marker(page, "settings-drawer")).toBeVisible();
  });
}

test("Single shows the current route and the actual phase beside the requested location", async ({ page, baseURL }) => {
  const scenario = createScenario("M02:local-progress").switch("held");
  await page.setViewportSize({ width: 390, height: 844 });
  const [finland, germany, sweden] = scenario.state.status.available;
  scenario.state.status.available = [
    finland, { ...germany, name: "Germany Alt" }, sweden,
    ...Array.from({ length: 25 }, (_, i) => ({ ...sweden, code: "se" + i, name: "Sweden " + i + " 🇸🇪" })),
    germany,
  ];
  await openApp(page, scenario, baseURL!);
  const current = page.locator('[data-marker="loc-row"][data-code="fi"]');
  const target = page.locator('[data-marker="loc-row"][data-code="de"]').last();
  await expect(marker(page, "main-mode-single")).toHaveAccessibleName(/Single location \(active\)/);
  await expect(current.locator(".loc-current")).toHaveText("current");
  await target.locator('[data-marker="loc-select"]').click();
  const progress = target.locator('[data-marker="main-switch-status"]');
  await expect(progress).toHaveAttribute("data-phase", "preparing");
  await expect(progress.getByRole("progressbar")).toBeInViewport();
  scenario.advance("validating");
  await page.clock.runFor(1600);
  await expect(progress).toHaveText("Validating configuration");
  scenario.advance("unknown");
  await page.clock.runFor(1600);
  await expect(progress.getByRole("status")).toHaveText("Result not confirmed yet");
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
  scenario.advance("recovery_failed");
  await page.clock.runFor(1600);
  await expect(progress.getByRole("status")).toHaveText("Recovery needs attention");
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
  await scenario.release("switch");
  await progress.getByRole("link", { name: "Recovery details" }).click();
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "recovery_failed");
});

test("Chain ping all shows TCP results in both selectors and skips route-only Hysteria", async ({ page, baseURL }) => {
  const scenario = createScenario("M06:chain-probes");
  const [finland, germany, sweden] = scenario.state.status.available;
  finland.health = { ok: true, last_latency_ms: 19 };
  germany.health = { ok: true, tcp_ok: false, probe_method: "route" };
  sweden.protocol = "hysteria2";
  sweden.health = { ok: true, route_ok: true, tcp_ok: null, probe_method: "route" };
  scenario.on("POST", "/api/probe", () => {
    scenario.state.status.health_updated_at = NOW;
    return { body: { ok: true } };
  });
  await openApp(page, scenario, baseURL!);
  const udpProbe = page.locator('[data-marker="btn-probe"][data-code="se"]');
  await expect(udpProbe).toBeDisabled();
  await expect(udpProbe).toHaveAccessibleName("Ping unavailable for Sweden 🇸🇪");
  await udpProbe.press("Enter");
  expect(scenario.count("POST", "/api/probe")).toBe(0);
  await marker(page, "main-mode-chain").click();
  await marker(page, "btn-check-all").click();
  await expect(marker(page, "location-check-summary")).toContainText("1 reachable · 2 checked · 1 skipped");
  for (const role of ["entry", "exit"]) {
    await marker(page, "chain-" + role).click();
    await expect(marker(page, "chain-" + role + "-option-fi")).toContainText("19 ms");
    await expect(marker(page, "chain-" + role + "-option-de")).toContainText("unreachable");
    await expect(marker(page, "chain-" + role + "-option-se")).toContainText("UDP · not checked");
    await page.keyboard.press("Escape");
  }
});

test("Chain ping all marks every TCP location checking and describes health to screen readers", async ({ page, baseURL }) => {
  const scenario = createScenario("M06:chain-checking");
  const [finland, germany, sweden] = scenario.state.status.available;
  finland.health = { ok: true, tcp_ok: true, tcp_latency_ms: 19, probe_method: "tcp" };
  // Earlier failover versions recorded a SOCKS proxy check. It stays visible, never as TCP.
  germany.health = { ok: true, last_latency_ms: 42, probe_method: "socks" };
  sweden.protocol = "hysteria2";
  scenario.state.status.health_updated_at = NOW;
  scenario.state.status.active_entry_code = "de";
  scenario.state.status.active_code = "fi";
  scenario.state.status.active_route = { mode: "chain", entry_code: "de", exit_code: "fi" };
  scenario.on("POST", "/api/probe", () => ({ body: { ok: true }, hold: "probe" }));
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "location-check-summary")).toContainText("1 reachable · 1 checked · 1 skipped");
  const entryHealth = marker(page, "chain-entry-health");
  const exitHealth = marker(page, "chain-exit-health");
  await expect(entryHealth).toHaveText("SOCKS · 42 ms");
  await expect(exitHealth).toHaveText("19 ms");
  await expect(marker(page, "chain-entry")).toHaveAccessibleName("Entry location: Germany 🇩🇪");
  await expect(marker(page, "chain-entry")).toHaveAccessibleDescription("SOCKS · 42 ms");
  await expect(marker(page, "chain-exit")).toHaveAccessibleDescription("19 ms");

  await marker(page, "chain-exit").click();
  const option = (code: string) => marker(page, "chain-exit-option-" + code);
  await expect(option("fi")).toHaveAccessibleName("Finland 🇫🇮");
  await expect(option("fi")).toHaveAccessibleDescription("19 ms");
  await expect(option("se")).toHaveAccessibleName("Sweden 🇸🇪");
  await expect(option("se")).toHaveAccessibleDescription("UDP · not checked");
  await expect(option("fi")).toBeFocused();
  // Typeahead still matches names, not health text.
  await page.keyboard.press("s");
  await expect(option("se")).toBeFocused();
  await page.keyboard.press("Escape");

  await marker(page, "btn-check-all").click();
  await expect(marker(page, "btn-check-all")).toHaveAttribute("aria-busy", "true");
  await expect(entryHealth).toHaveText("checking");
  await expect(entryHealth).toHaveAttribute("data-state", "checking");
  await expect(exitHealth).toHaveText("checking");
  await expect(marker(page, "chain-entry")).toHaveAccessibleDescription(/^checking/);
  const description = (code: string) => option(code).locator(".choice-description");
  await expect(description("fi")).toHaveText("checking");
  await expect(description("de")).toHaveText("checking");
  await expect(description("se")).toHaveText("UDP · not checked");

  germany.health = { ok: false, tcp_ok: false, probe_method: "tcp" };
  finland.health = { ok: true, tcp_ok: true, tcp_latency_ms: 23, probe_method: "tcp" };
  await scenario.release("probe");
  await expect(entryHealth).toHaveText("unreachable");
  await expect(exitHealth).toHaveText("23 ms");
  await expect(marker(page, "chain-entry")).toHaveAccessibleDescription("unreachable");
  await expect(marker(page, "location-check-summary")).toContainText("1 reachable · 2 checked · 1 skipped");
});

for (const kind of ["main", "device-location", "apply_failover"]) {
  test("Main keeps " + kind + " without this browser's request in Activity", async ({ page, baseURL }) => {
    const scenario = createScenario("M02:foreign-" + kind);
    scenario.state.status.operation = {
      id: "b024dfa3-885c-4f41-acfe-dc9bf0948e62", kind, phase: "validating",
      source: kind === "apply_failover" ? "failover" : "manual", blocking: true,
      target_code: "de", target_entry_code: "se",
    };
    await openApp(page, scenario, baseURL!);
    await expect(marker(page, "main-mode-single")).toHaveAccessibleName(/Single location \(active\)/);
    await expect(marker(page, "main-switch-status")).toHaveCount(0);
    const requested = marker(page, "main-requested");
    if (kind === "device-location") await expect(requested).toHaveCount(0);
    else await expect(requested).toHaveText("Requested Main: Sweden 🇸🇪 → Germany 🇩🇪");
    await expect(marker(page, "main-mode-single")).toHaveAttribute("aria-pressed", "true");
    await marker(page, "btn-activity").click();
    await expect(marker(page, "activity-now")).toContainText("Validating configuration");
  });
}
