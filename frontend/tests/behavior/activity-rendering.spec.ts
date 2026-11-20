import type { Page } from "@playwright/test";
import { test, expect } from "../support/test";
import { createScenario, marker, openApp, NOW } from "../support/scenario";

async function revisitTab(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

for (const phase of ["unknown", "recovery_failed"]) {
  test(`O01 ${phase} links directly to its journal and has no progress meter`, async ({ page, baseURL }) => {
    const scenario = createScenario("O01:journal-link");
    const id = "34567890-1111-4111-8111-000000000001";
    const operation = { id, phase, kind: "main", scope: "router", blocking: true };
    scenario.state.status.operation = operation;
    scenario.on("GET", "/api/routing/operations/" + id, () => ({ body: operation }));
    await openApp(page, scenario, baseURL!);
    await marker(page, "btn-activity").click();
    const panel = marker(page, "operation-status");
    await expect(panel.locator("progress")).toHaveCount(0);
    const link = marker(page, "operation-details");
    await expect(link).toHaveAttribute("href", "#routing/operation/" + id);
    await link.click();
    await expect(page).toHaveURL(new RegExp("#routing/operation/" + id + "$"));
    await expect(marker(page, "routing-panel")).toBeVisible();
  });
}

test("S06 the empty whitelist banner opens the Failover editor without saving", async ({ page, baseURL }) => {
  const scenario = createScenario("S06:empty-whitelist");
  Object.assign(scenario.state.status.failover, { enabled: true, whitelist: [] });
  await openApp(page, scenario, baseURL!);
  await marker(page, "banner-empty-wl").locator('[data-marker="btn-open-failover"]').click();
  await expect(marker(page, "fo-enabled")).toBeVisible();
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("O02 an observed device location has its own target and warning", async ({ page, baseURL }) => {
  const scenario = createScenario("O02:device-location");
  const id = "34567890-1111-4111-8111-000000000002";
  const warning = "Subscription refresh failed; using saved location configuration.";
  const op = { id, kind: "device-location", phase: "prepared", blocking: true, target_code: "se", target_name: "Sweden", warning };
  scenario.state.status.operation = op;
  scenario.on("GET", "/api/routing/operations/" + id, () => ({ body: { ...op, phase: "committed", blocking: false } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "operation-target")).toHaveText("Requested device location: Sweden");
  await expect(marker(page, "operation-confirmed")).toHaveCount(0);
  await expect(marker(page, "operation-warning")).toHaveText(warning);
  await page.clock.runFor(1600);
  await expect(marker(page, "active-name")).toContainText("Finland");
  await expect(marker(page, "toast")).toHaveCount(0);
});

test("X05 history in a pairing dialog returns keyboard focus to the Access trigger", async ({ page, baseURL }) => {
  const scenario = createScenario("X05-access-pair");
  scenario.state.status.events = [{
    event_id: "pair-attention", action: "update", trigger: "cron", result: "fail", ts: NOW, message: "Subscription unavailable.",
  }];
  scenario.on("POST", "/api/auth/pairing-code", () => ({
    body: { id: "access-pair", code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300 },
  }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-access").click();
  const trigger = marker(page, "settings-link-device");
  await trigger.click();
  const dialog = marker(page, "pair-dialog");
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  const launcher = dialog.locator('[data-marker="btn-activity"]');
  await launcher.click();
  await expect(launcher).toBeFocused();
  await expect(dialog.locator('[data-marker="background-attention"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  await expect(dialog.locator('[data-marker="activity-panel"]')).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("O02 short reads stay quiet and a phase update preserves the original deadline and focused detail", async ({ page, baseURL }) => {
  const scenario = createScenario("O02-rendered-delay");
  const read = {
    id: null, ephemeral: true, kind: "read", scope: "read", phase: "preparing",
    created_at: NOW, message: "Reading device policies", blocking: true,
  };
  scenario.state.status.operation = read;
  await openApp(page, scenario, baseURL!);
  const launcher = marker(page, "btn-activity");
  await expect(launcher).toHaveAttribute("data-active", "false");
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  await expect(launcher).toBeFocused();
  await expect(marker(page, "operation-message")).toHaveText(read.message);
  await expect(marker(page, "operation-source")).toHaveText("Router");
  await expect(launcher).toHaveAccessibleDescription("Preparing. Changes wait until the read finishes.");
  for (const control of ["btn-xkeen-toggle", "btn-route-check", "btn-update-sub", "btn-apply-active-config"]) {
    await expect(marker(page, control)).toHaveAccessibleDescription("Preparing. Changes wait until the read finishes.");
  }
  await page.clock.runFor(700);
  scenario.state.status.operation = { ...read, phase: "verifying", message: "Checking the current policy" };
  await revisitTab(page);
  await expect(marker(page, "operation-phase")).toHaveText("Checking startup");
  await expect(launcher).toBeFocused();
  await page.clock.runFor(299);
  await expect(launcher).toHaveAttribute("data-active", "false");
  await page.clock.runFor(1);
  await expect(launcher).toHaveAttribute("data-active", "true");

  scenario.state.status.operation = null;
  await revisitTab(page);
  await expect(launcher).toHaveAccessibleDescription("No router operation is in progress.");
  await expect(launcher).toBeFocused();
  await expect(launcher).toHaveAttribute("data-active", "false");
  const location = page.locator('[data-marker="loc-select"][data-code="de"]');
  await expect(location).toBeEnabled();

  scenario.state.status.operation = { ...read, created_at: "2026-11-17T09:00:01Z" };
  await revisitTab(page);
  await expect(marker(page, "operation-message")).toHaveText(read.message);
  await page.clock.runFor(800);
  scenario.state.status.operation = null;
  await revisitTab(page);
  await expect(launcher).toHaveAttribute("data-state", "idle");
  await page.clock.runFor(500);
  await expect(launcher).toHaveAttribute("data-active", "false");
  await expect(marker(page, "toast")).toHaveCount(0);
});

test("O02 pending chain detail retains both nodes and separates it from the confirmed Main", async ({ page, baseURL }) => {
  const scenario = createScenario("O02-pending-chain");
  scenario.state.status.operation = {
    id: null, ephemeral: true, kind: "apply_pending_reapply_now", scope: "router",
    phase: "validating", source: "scheduler", created_at: NOW, target_code: "de", target_entry_code: "se",
    warning: "Subscription refresh failed; using saved location configuration.",
  };
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "operation-target")).toHaveText("Requested Main location: Sweden 🇸🇪 → Germany 🇩🇪");
  await expect(marker(page, "operation-confirmed")).toHaveText("Last confirmed Main location: Finland 🇫🇮");
  await expect(marker(page, "operation-source")).toHaveText("Scheduled update");
  await expect(marker(page, "operation-phase")).toHaveText("Validating configuration · saved config");
  await expect(marker(page, "operation-warning")).toHaveText(scenario.state.status.operation.warning);
  await expect(marker(page, "operation-details")).toHaveCount(0);
});

test("H01 own request blocks immediately, animates after three seconds, and leaves no indicator after sign-out", async ({ page, baseURL }) => {
  const scenario = createScenario("H01-own-delay");
  scenario.on("POST", "/api/update", () => ({ hold: "refresh", body: { ok: true } }));
  await openApp(page, scenario, baseURL!);
  const launcher = marker(page, "btn-activity");
  const location = page.locator('[data-marker="loc-select"][data-code="de"]');
  const refresh = marker(page, "btn-update-sub");
  const idleWidth = (await refresh.boundingBox())?.width;
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh.locator(".terminal-action-glyph")).toBeVisible();
  expect((await refresh.boundingBox())?.width).toBe(idleWidth);
  await expect(location).toBeDisabled();
  await launcher.click();
  await expect(marker(page, "operation-source")).toHaveText("This browser");
  await page.clock.runFor(2999);
  await expect(launcher).toHaveAttribute("data-active", "false");
  await page.clock.runFor(1);
  await expect(launcher).toHaveAttribute("data-active", "true");
  await scenario.release("refresh");
  await expect(location).toBeEnabled();
  await expect(launcher).toHaveAttribute("data-active", "false");
  await page.keyboard.press("Escape");

  await marker(page, "btn-update-sub").click();
  await expect(location).toBeDisabled();
  await launcher.click();
  await expect(launcher).toBeFocused();
  scenario.state.session.authenticated = false;
  scenario.on("GET", "/api/status", () => ({ status: 401, body: { error: "Sign in" } }));
  await revisitTab(page);
  await expect(marker(page, "gate-input")).toBeVisible();
  await page.clock.runFor(3001);
  await expect(launcher).not.toBeVisible();
  await expect(marker(page, "activity-panel")).not.toBeVisible();
  await scenario.release("refresh");
});

test("H01 background attention survives collapse and native dialog rehosting until read or recovery", async ({ page, baseURL }) => {
  const scenario = createScenario("H01-rendered-attention");
  const failure = {
    event_id: "scheduled-update-failed", action: "update", trigger: "cron",
    result: "fail", ts: NOW, message: "Subscription unavailable.",
  };
  scenario.state.status.events = [failure];
  scenario.on("POST", "/api/auth/pairing-code", () => ({
    body: { id: "header-pair", code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300 },
  }));
  await openApp(page, scenario, baseURL!);
  const launcher = marker(page, "btn-activity");
  const panel = marker(page, "activity-panel");
  await expect(launcher).toHaveAttribute("data-attention", "true");
  await expect(marker(page, "activity-status")).toContainText("Subscription refresh failed");
  await launcher.click();
  await expect(marker(page, "background-attention")).toContainText("Subscription refresh failed · Subscription unavailable.");
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  await expect(panel).toBeHidden();
  await expect(launcher).toHaveAttribute("data-attention", "true");

  const sheet = await marker(page, "activity-sheet").elementHandle();
  await marker(page, "btn-add-device").click();
  const dialog = marker(page, "pair-dialog");
  await expect(dialog.locator('[data-marker="btn-activity"]')).toHaveAttribute("data-attention", "true");
  expect(await sheet!.evaluate((node) => node === document.querySelector('dialog [data-marker="activity-sheet"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(launcher).toHaveAttribute("data-attention", "true");

  await launcher.click();
  // An outside pointer closes the floating desktop panel; the phone sheet keeps the page live and closes from its line.
  if ((page.viewportSize()?.width ?? 1280) > 640) await page.mouse.click(4, 4);
  else await launcher.click();
  await expect(panel).not.toBeVisible();
  await expect(launcher).toHaveAccessibleDescription(/Subscription refresh failed/);
  await launcher.click();
  await marker(page, "attention-read").click();
  await expect(launcher).toHaveAttribute("data-attention", "false");
  await expect(marker(page, "background-attention")).toHaveCount(0);
  await page.reload();
  await expect(marker(page, "active-name")).toBeVisible();
  await expect(launcher).toHaveAttribute("data-attention", "false");

  scenario.state.status.events.push({ ...failure, event_id: "update-failed-again" });
  await revisitTab(page);
  await expect(launcher).toHaveAttribute("data-attention", "true");
  scenario.state.status.events.push({ ...failure, event_id: "update-recovered", result: "ok" });
  await revisitTab(page);
  await expect(launcher).toHaveAttribute("data-attention", "false");
  await expect(launcher).toHaveAccessibleDescription("No router operation is in progress.");
  await expect(marker(page, "toast")).toHaveCount(0);
  await sheet?.dispose();
});
