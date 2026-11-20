import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";

for (const destination of ["close", "back", "escape", "breadcrumb", "backdrop"]) {
  test(`settings dirty ${destination}: keep editing retains input; discard navigates`, async ({ page, baseURL }) => {
    const scenario = createScenario("settings-dirty");
    await openApp(page, scenario, baseURL!);
    await marker(page, "btn-settings").click();
    await marker(page, "settings-subscription").click();
    const field = marker(page, "auto-update-time");
    await field.fill("05:45");
    await field.evaluate((node) => {
      (window as any).settingsField = node;
      (window as any).fieldDisconnected = false;
      new MutationObserver(() => {
        if (!node.isConnected) (window as any).fieldDisconnected = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const leave = async () => {
      if (destination === "close") await marker(page, "btn-drawer-close").click();
      if (destination === "back") await page.goBack();
      if (destination === "escape") await page.keyboard.press("Escape");
      if (destination === "breadcrumb") await marker(page, "settings-menu").click();
      if (destination === "backdrop") await marker(page, "drawer-backdrop").click({ position: { x: 2, y: 2 } });
    };
    await leave();
    await expect(marker(page, "settings-discard-confirm")).toBeVisible();
    await marker(page, "settings-keep-editing").click();
    await expect(field).toHaveValue("05:45");
    await page.clock.runFor(10001);
    expect(await field.evaluate((node) => node === (window as any).settingsField && !(window as any).fieldDisconnected)).toBe(true);
    await leave();
    await marker(page, "settings-discard").click();
    await expect(marker(page, "settings-discard-confirm")).toHaveCount(0);
    if (destination === "breadcrumb" || destination === "back") {
      await expect(marker(page, "settings-menu-section")).toBeVisible();
    } else {
      await expect(marker(page, "btn-settings")).toBeFocused();
    }
    expect(scenario.count("PUT", "/api/auto-update")).toBe(0);
  });
}

for (const minutes of [4, 5, 10080, 10081]) {
  test(`schedule interval boundary ${minutes} and preserved SNI`, async ({ page, baseURL }) => {
    const scenario = createScenario("S03");
    Object.assign(scenario.state.status.auto_update, { mode: "interval", sni_daily: true });
    scenario.on("PUT", "/api/auto-update", (request) => {
      expect(request.body).toEqual({ enabled: true, mode: "interval", daily_time: "04:30", interval_minutes: minutes, sni_daily: true });
      return { body: { ok: true, config: request.body } };
    });
    await openApp(page, scenario, baseURL!);
    await marker(page, "btn-settings").click();
    await marker(page, "settings-subscription").click();
    const field = marker(page, "auto-update-interval");
    await field.fill(String(minutes));
    await field.focus();
    await field.dispatchEvent("compositionstart");
    await page.clock.runFor(10001);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(String(minutes));
    await page.keyboard.press("Escape");
    await expect(marker(page, "settings-discard-confirm")).toHaveCount(0);
    await field.dispatchEvent("compositionend");
    await marker(page, "settings-save").click();
    if (minutes < 5 || minutes > 10080) {
      expect(scenario.count("PUT", "/api/auto-update")).toBe(0);
      expect(await field.evaluate((node: HTMLInputElement) => node.validity.valid)).toBe(false);
    } else {
      await expect.poll(() => scenario.count("PUT", "/api/auto-update")).toBe(1);
    }
  });
}

test("daily Moscow time preserves hidden interval and SNI; disabled schedule retains values", async ({ page, baseURL }) => {
  const scenario = createScenario("S03");
  Object.assign(scenario.state.status.auto_update, { mode: "interval", sni_daily: true });
  scenario.on("PUT", "/api/auto-update", (request) => {
    expect(request.body).toEqual({ enabled: false, mode: "daily", daily_time: "05:45", interval_minutes: 1440, sni_daily: true });
    return { body: { ok: true, config: request.body } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-subscription").click();
  await marker(page, "auto-update-mode").selectOption("daily");
  await expect(marker(page, "auto-update-sni-daily")).toHaveCount(0);
  await marker(page, "auto-update-time").fill("05:45");
  await expect(marker(page, "auto-update-section")).toContainText("Moscow (UTC+3)");
  await marker(page, "auto-update-enabled").uncheck();
  await marker(page, "settings-save").click();
  await expect.poll(() => scenario.count("PUT", "/api/auto-update")).toBe(1);
});

test("failover priority, selection and dependent recovery options remain drafts", async ({ page, baseURL }) => {
  const scenario = createScenario("S06");
  Object.assign(scenario.state.failover.config, { enabled: true, whitelist: ["de", "fi"], auto_stop_on_total_failure: true, auto_restart_on_recovery: true });
  scenario.on("PUT", "/api/failover/config", (request) => {
    expect(request.body).toEqual({ schema_version: 1, enabled: true, auto_failback: false, auto_stop_on_total_failure: false, auto_restart_on_recovery: false, whitelist: ["fi", "de"] });
    return { body: { ok: true, config: request.body } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-failover").click();
  await marker(page, "wl-up-fi").click();
  await expect(marker(page, "wl-up-fi")).toBeDisabled();
  await marker(page, "fo-stop").uncheck();
  await expect(marker(page, "fo-restart")).not.toBeChecked();
  await expect(marker(page, "fo-restart")).toBeDisabled();
  expect(scenario.count("PUT", "/api/failover/config")).toBe(0);
  await marker(page, "settings-save").click();
  await expect.poll(() => scenario.count("PUT", "/api/failover/config")).toBe(1);
});

test("connectivity focused edit survives polling and saves trimmed exact list", async ({ page, baseURL }) => {
  const scenario = createScenario("S07");
  scenario.on("PUT", "/api/connectivity", (request) => {
    expect(request.body.check_urls[0]).toBe("https://check.example.invalid/health");
    return { body: { ok: true, config: { schema_version: 1, ...request.body } } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-checks").click();
  const field = marker(page, "connectivity-url-input").first();
  await field.fill("https://check.example.invalid/health");
  await page.clock.runFor(10001);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("https://check.example.invalid/health");
  await marker(page, "settings-save").click();
  await expect.poll(() => scenario.count("PUT", "/api/connectivity")).toBe(1);
});

for (const kind of ["busy", "unknown", "validation"]) {
  test(`save ${kind} preserves draft without retry`, async ({ page, baseURL }) => {
    const scenario = createScenario("settings-error");
    scenario.on("PUT", "/api/auto-update", () => ({ status: kind === "busy" ? 409 : kind === "unknown" ? 500 : 400,
      body: kind === "unknown" ? { error: "lost reply" } : { error: "Check schedule", code: kind } }));
    await openApp(page, scenario, baseURL!);
    await marker(page, "btn-settings").click();
    await marker(page, "settings-subscription").click();
    await marker(page, "auto-update-time").fill("05:45");
    await marker(page, "settings-save").click();
    await expect(marker(page, "settings-error")).toContainText(kind === "unknown" ? "Save not confirmed" : kind === "busy" ? "nothing was saved" : "Check schedule");
    await expect(marker(page, "auto-update-time")).toHaveValue("05:45");
    await page.clock.runFor(20001);
    expect(scenario.count("PUT", "/api/auto-update")).toBe(1);
  });
}

test("subscription URL stable across polling and collapse, saves exact trimmed value", async ({ page, baseURL }) => {
  const scenario = createScenario("S01");
  scenario.on("POST", "/api/sub-url", (request) => {
    expect(request.body).toEqual({ url: "https://new.example.invalid/sub" });
    return { body: { ok: true, url: request.body.url } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "subscription-toggle").click();
  const field = marker(page, "subscription-home-url");
  await field.fill(" https://new.example.invalid/sub ");
  await page.clock.runFor(10001);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(" https://new.example.invalid/sub ");
  await marker(page, "subscription-toggle").click();
  await marker(page, "subscription-toggle").click();
  await expect(field).toHaveValue(" https://new.example.invalid/sub ");
  await marker(page, "subscription-home-save").click();
  await expect.poll(() => scenario.count("POST", "/api/sub-url")).toBe(1);
});

const subscriptionErrorCases = ["refresh", "apply"].flatMap((action) =>
  [false, true].map((ambiguous) => ({ action, ambiguous })),
);
for (const { action, ambiguous } of subscriptionErrorCases) {
  test(`subscription ${action} ${ambiguous ? "unknown" : "unavailable"} error retains pending state and reports once`, async ({ page, baseURL }) => {
    const scenario = createScenario("S02");
    Object.assign(scenario.state.status, { pending_reapply_code: "fi", pending_update_kind: "config" });
    const path = action === "refresh" ? "/api/update" : "/api/active-refresh";
    scenario.on("POST", path, () => ({ status: ambiguous ? 500 : 503, body: ambiguous
      ? { error: "Lost reply" } : { error: "Subscription refresh failed", code: "unavailable" } }));
    await openApp(page, scenario, baseURL!);
    await marker(page, action === "refresh" ? "btn-update-sub" : "fixture-apply").click();
    await expect(marker(page, "fixture-notifications")).toContainText(ambiguous ? "result not confirmed. Reloading the current state." : "cannot perform this action");
    await expect(marker(page, "fixture-pending")).toHaveText("fi");
    await page.clock.runFor(10001);
    expect(scenario.count("POST", path)).toBe(1);
    expect(scenario.count("POST", "/api/switch")).toBe(0);
  });
}

test("failover selection and probe use unsaved whitelist without saving config", async ({ page, baseURL }) => {
  const scenario = createScenario("S06");
  scenario.on("POST", "/api/probe", (request) => {
    expect(request.body).toEqual({ codes: ["de"] });
    return { body: { ok: true, results: [] } };
  });
  scenario.on("PUT", "/api/failover/config", (request) => {
    expect(request.body.whitelist).toEqual(["de"]);
    return { body: { ok: true, config: request.body } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-failover").click();
  await marker(page, "wl-check-de").check();
  expect(scenario.count("PUT", "/api/failover/config")).toBe(0);
  await marker(page, "btn-check-now").click();
  await expect.poll(() => scenario.count("POST", "/api/probe")).toBe(1);
  await marker(page, "settings-save").click();
  await expect.poll(() => scenario.count("PUT", "/api/failover/config")).toBe(1);
});

test("connectivity add/remove bounds and invalid URL reject before saving", async ({ page, baseURL }) => {
  const scenario = createScenario("S07");
  scenario.state.connectivity.max_urls = 2;
  scenario.state.connectivity.config.check_urls = ["https://one.example.invalid"];
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-checks").click();
  await expect(marker(page, "btn-remove-connectivity-url")).toBeDisabled();
  await marker(page, "btn-add-connectivity-url").click();
  await expect(marker(page, "btn-add-connectivity-url")).toBeDisabled();
  await marker(page, "connectivity-url-input").last().fill("bad-url");
  await marker(page, "settings-save").click();
  expect(scenario.count("PUT", "/api/connectivity")).toBe(0);
  await marker(page, "btn-remove-connectivity-url").last().click();
  await expect(marker(page, "connectivity-url-input")).toHaveCount(1);
});

test("subscription save failure keeps URL draft and uses inline English error", async ({ page, baseURL }) => {
  const scenario = createScenario("S01");
  scenario.on("POST", "/api/sub-url", () => ({ status: 400, body: { code: "validation", error: "Subscription could not be parsed" } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "subscription-toggle").click();
  await marker(page, "subscription-home-url").fill("https://broken.example.invalid/sub");
  await marker(page, "subscription-home-save").click();
  await expect(marker(page, "subscription-editor").getByRole("alert")).toContainText("Subscription could not be parsed");
  await expect(marker(page, "subscription-home-url")).toHaveValue("https://broken.example.invalid/sub");
  await page.clock.runFor(10001);
  expect(scenario.count("POST", "/api/sub-url")).toBe(1);
});

test("drawer locks a long document and releases scrolling on close", async ({ page, baseURL }) => {
  await openApp(page, createScenario("S03"), baseURL!);
  await page.locator(".scroll").evaluate((node: HTMLElement) => { node.style.minHeight = "3000px"; });
  await marker(page, "btn-settings").click();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  const before = await page.evaluate(() => scrollY);
  await page.mouse.move(5, 500);
  await page.mouse.wheel(0, 600);
  await page.clock.runFor(300);
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await marker(page, "btn-drawer-close").click();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("failover preserves tier labels and connection check link detail", async ({ page, baseURL }) => {
  const scenario = createScenario("S06");
  scenario.state.status.available[0]!.name = "Finland 🇫🇮 1gbit";
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-failover").click();
  await expect(page.locator(".wl-name .tier").first()).toHaveText("1gbit");
  const link = marker(page, "settings-checks");
  await expect(link.locator(".settings-link-name")).toHaveText("test sites");
  await expect(link.locator(".t-note")).toHaveText("2 sites · used by check server route, failover and Find a working route");
  await expect(link.locator(".settings-chevron")).toHaveText("›");
  await page.emulateMedia({ colorScheme: "light" });
  await link.hover();
  await expect(link).toHaveCSS("background-color", "rgb(255, 254, 248)");
});
