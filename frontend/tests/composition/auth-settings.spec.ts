import type { Page } from "@playwright/test";
import { expect, test } from "../support/test";
import { createScenario, marker, NOW, openApp as openScenario } from "../support/scenario";
import { routingScenario } from "../support/routing";

async function openApp(...args: Parameters<typeof openScenario>) {
  await openScenario(...args);
  await args[0].clock.runFor(1);
}

async function openAccess(page: Page) {
  await marker(page, "btn-settings").click();
  await marker(page, "settings-access").click();
}

async function openPassword(page: Page) {
  await openAccess(page);
  await marker(page, "btn-change-password").click();
}

async function goBack(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    history.back();
  }));
}

test("production entry gates the subscription until sign in and removes it on logout", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-session");
  scenario.state.session = { configured: true, authenticated: false, session_id: null };
  scenario.on("POST", "/api/auth/login", (request) => {
    expect(request.body).toEqual({ password: "synthetic-ui-password" });
    scenario.state.session = { configured: true, authenticated: true, session_id: "signed-in" };
    return { body: { ok: true } };
  });
  scenario.on("POST", "/api/auth/logout", () => ({ body: { ok: true } }));
  await openApp(page, scenario, baseURL!);
  await expect(page).toHaveTitle("XKeen Switcher");
  await expect(marker(page, "gate-input")).toBeVisible();
  await expect(marker(page, "subscription-panel")).toHaveCount(0);
  expect(scenario.count("GET", "/api/status")).toBe(0);

  await marker(page, "gate-input").fill("synthetic-ui-password");
  await marker(page, "gate-submit").click();
  await expect(marker(page, "subscription-panel")).toBeVisible();
  await expect(page.locator(".app > .scroll + aside.drawer + .drawer-backdrop")).toHaveCount(1);
  await expect(marker(page, "gate-input")).toHaveCount(0);

  await marker(page, "btn-settings").click();
  await marker(page, "btn-logout").click();
  await expect(marker(page, "gate-input")).toBeVisible();
  await expect(marker(page, "settings-drawer")).toHaveCount(0);
  await expect(marker(page, "subscription-panel")).toHaveCount(0);
});

test("one pairing dialog opens from either trigger and restores focus", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-pairing");
  const invitation = {
    id: "code-1", code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300,
  };
  scenario.on("POST", "/api/auth/pairing-code", () => ({ body: invitation }));
  scenario.on("GET", "/api/auth/pairing-code", () => ({ body: invitation }));
  await openApp(page, scenario, baseURL!);
  const dialog = page.locator("dialog:modal");

  const headerTrigger = marker(page, "btn-add-device");
  await headerTrigger.click();
  await expect(dialog).toHaveCount(1);
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  await expect(dialog.getByRole("navigation", { name: "breadcrumb" })).not.toContainText("settings");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(headerTrigger).toBeFocused();

  await openAccess(page);
  const accessTrigger = marker(page, "settings-link-device");
  await expect(accessTrigger).toHaveCount(1);
  await expect(marker(page, "btn-change-password")).toHaveCount(1);
  await accessTrigger.click();
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole("navigation", { name: "breadcrumb" })).toContainText("access");
  await marker(page, "pair-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(accessTrigger).toBeFocused();
});

test("password cancel, Escape and browser Back ask before discarding a draft", async ({ page, baseURL }) => {
  await openApp(page, createScenario("composition-password-guard"), baseURL!);
  await openPassword(page);
  const current = marker(page, "password-current");
  const notice = marker(page, "settings-discard-confirm");
  await current.fill("synthetic-current-password");

  const cancel = marker(page, "password-cancel");
  await cancel.click();
  await expect(notice).toBeVisible();
  await marker(page, "settings-keep-editing").click();
  await expect(notice).toHaveCount(0);
  await expect(cancel).toBeFocused();
  await expect(current).toHaveValue("synthetic-current-password");

  await current.focus();
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(notice).toHaveCount(0);
  await expect(current).toBeFocused();

  await goBack(page);
  await expect(notice).toBeVisible();
  await expect(current).toHaveValue("synthetic-current-password");
  await marker(page, "settings-discard").click();
  await expect(marker(page, "settings-link-device")).toBeVisible();
  await marker(page, "btn-change-password").click();
  await expect(current).toHaveValue("");
});

test("failed password submission blocks navigation while pending and keeps edited values", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-password-pending");
  scenario.on("POST", "/api/auth/password", (request) => {
    expect(request.body).toEqual({ current_password: "synthetic-old-password", password: "synthetic-new-password" });
    return { status: 400, body: { error: "Current password is incorrect" }, hold: "password-error" };
  });
  await openApp(page, scenario, baseURL!);
  await openPassword(page);
  await marker(page, "password-current").fill("synthetic-old-password");
  await marker(page, "password-new").fill("synthetic-new-password");
  await marker(page, "password-repeat").fill("synthetic-new-password");
  await marker(page, "password-submit").click();
  await expect.poll(() => scenario.count("POST", "/api/auth/password")).toBe(1);
  await expect(marker(page, "btn-drawer-close")).toBeDisabled();
  await page.keyboard.press("Escape");
  await goBack(page);
  await expect(marker(page, "password-form")).toBeVisible();
  await expect(marker(page, "settings-discard-confirm")).toHaveCount(0);

  await scenario.release("password-error");
  await expect(marker(page, "password-error")).toContainText("Current password is incorrect");
  await expect(marker(page, "btn-drawer-close")).toBeEnabled();
  await expect(marker(page, "password-repeat")).toHaveValue("synthetic-new-password");
});

test("password replacement opens fresh Access and clears private drafts, history and pairing", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-password-replacement");
  scenario.on("POST", "/api/auth/pairing-code", () => ({ body: {
    id: "old-code", code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300,
  } }));
  scenario.on("POST", "/api/auth/password", () => {
    scenario.state.session.session_id = "replacement";
    scenario.state.sessions.sessions = [{ id: "replacement", label: "Replacement browser", current: true, created_at: NOW }];
    return { body: { ok: true } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-add-device").click();
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  await marker(page, "pair-close").click();
  await marker(page, "subscription-toggle").click();
  await marker(page, "subscription-home-url").fill("https://unsaved.example.invalid/sub");
  await openPassword(page);
  await marker(page, "password-current").fill("synthetic-old-password");
  await marker(page, "password-new").fill("synthetic-new-password");
  await marker(page, "password-repeat").fill("synthetic-new-password");
  await marker(page, "password-submit").click();

  await expect(marker(page, "subscription-toggle")).toBeVisible();
  await expect(marker(page, "password-form")).toHaveCount(0);
  await expect(marker(page, "device-revoke")).toHaveCount(1);
  await expect(marker(page, "device-revoke")).toHaveAttribute("data-id", "replacement");
  await expect(marker(page, "settings-drawer")).toHaveJSProperty("inert", false);
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await page.clock.runFor(10001);
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(0);
  await goBack(page);
  await expect(marker(page, "btn-settings")).toBeFocused();
  await expect(marker(page, "settings-drawer")).toHaveJSProperty("inert", true);
  await marker(page, "subscription-toggle").click();
  await expect(marker(page, "subscription-home-url")).toHaveValue(scenario.state.status.subscription_url);
});

test("an unconfirmed password change keeps its draft and does not reopen Access", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-password-unknown");
  scenario.on("POST", "/api/auth/password", () => ({ status: 503, body: { error: "Reply unavailable" } }));
  await openApp(page, scenario, baseURL!);
  await openPassword(page);
  await marker(page, "password-current").fill("synthetic-old-password");
  await marker(page, "password-new").fill("synthetic-new-password");
  await marker(page, "password-repeat").fill("synthetic-new-password");
  await marker(page, "password-submit").click();
  await expect(marker(page, "password-error")).toContainText("No confirmed response");
  await expect(marker(page, "password-repeat")).toHaveValue("synthetic-new-password");
  await expect(marker(page, "device-revoke")).toHaveCount(0);
  expect(scenario.count("GET", "/api/auth/session")).toBe(1);
});

test("a revoked replacement cannot reopen Access on the next login", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-password-revoked");
  scenario.on("POST", "/api/auth/password", () => {
    scenario.state.session = { configured: true, authenticated: false, session_id: null };
    return { body: { ok: true } };
  });
  scenario.on("POST", "/api/auth/login", () => {
    scenario.state.session = { configured: true, authenticated: true, session_id: "new-login" };
    return { body: { ok: true } };
  });
  await openApp(page, scenario, baseURL!);
  await openPassword(page);
  await marker(page, "password-current").fill("synthetic-old-password");
  await marker(page, "password-new").fill("synthetic-new-password");
  await marker(page, "password-repeat").fill("synthetic-new-password");
  await marker(page, "password-submit").click();
  await expect(marker(page, "gate-input")).toBeVisible();
  await expect(marker(page, "settings-drawer")).toHaveCount(0);
  await marker(page, "gate-input").fill("synthetic-login-password");
  await marker(page, "gate-submit").click();
  await expect(marker(page, "subscription-panel")).toBeVisible();
  await expect(marker(page, "settings-drawer")).toHaveJSProperty("inert", true);
  await expect(marker(page, "device-revoke")).toHaveCount(0);
});

test("hash navigation retains the open drawer and its draft under one session owner", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-navigation");
  routingScenario(scenario);
  await openApp(page, scenario, baseURL!);
  await openPassword(page);
  const current = marker(page, "password-current");
  await current.fill("synthetic-current-password");
  await expect(current).toBeFocused();

  await page.evaluate(() => {
    // Browser history can change while the settings drawer owns keyboard focus.
    history.pushState({ ...history.state }, "", "#routing/history");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await expect(page).toHaveURL(/#routing\/history$/);
  await expect(marker(page, "subscription-panel")).toHaveCount(0);
  await expect(current).toHaveValue("synthetic-current-password");
  await expect(current).toBeFocused();
  await goBack(page);
  await expect(marker(page, "subscription-panel")).toHaveCount(1);
  await expect(marker(page, "settings-discard-confirm")).toHaveCount(0);
  await expect(current).toHaveValue("synthetic-current-password");
  await expect(current).toBeFocused();

  await page.clock.runFor(10001);
  await expect.poll(() => scenario.count("GET", "/api/status")).toBe(2);
  expect(scenario.count("GET", "/api/auth/session")).toBe(1);
});

test("a bookmarked routing dialog opens once the settings drawer gives up focus", async ({ page, baseURL }) => {
  const scenario = routingScenario(createScenario("composition-deferred-routing-dialog"));
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await page.evaluate(() => {
    history.pushState({ ...history.state }, "", "#routing/history");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await expect(page).toHaveURL(/#routing\/history$/);
  await expect(marker(page, "routing-add")).toBeAttached();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await marker(page, "btn-drawer-close").click();
  await expect(marker(page, "routing-panel")).toBeVisible();
});

test("appearance updates the existing header brand without closing settings", async ({ page, baseURL }) => {
  await openApp(page, createScenario("composition-theme"), baseURL!);
  const logo = page.locator(".scroll .t-head .brand-ico");
  await expect(logo).toHaveAttribute("src", "/icon-light.svg");
  await marker(page, "btn-settings").click();
  await marker(page, "theme-dark").click();
  await expect(page.locator("html")).toHaveClass("theme-dark");
  await expect(logo).toHaveAttribute("src", "/icon-dark.svg");
  await expect(marker(page, "theme-dark")).toBeFocused();
});

test("a reloaded document cannot enter the previous session's drawer from browser history", async ({ page, baseURL }) => {
  const scenario = createScenario("composition-history-owner");
  await openApp(page, scenario, baseURL!);
  await openPassword(page);
  scenario.state.session.session_id = "next-browser-session";
  await page.reload();
  await expect(marker(page, "subscription-panel")).toBeVisible();
  await goBack(page);
  await expect(page.locator(".app")).not.toHaveClass(/drawer-open/);
  await expect(marker(page, "devices-toggle")).toBeVisible();
});

test("leaving pairing for the settings menu restores keyboard focus in the drawer", async ({ page, baseURL }) => {
  const scenario = createScenario("A04");
  scenario.on("POST", "/api/auth/pairing-code", () => ({ body: {
    id: "focus-test", code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300,
  } }));
  await openApp(page, scenario, baseURL!);
  await openAccess(page);
  await marker(page, "settings-link-device").click();
  await marker(page, "pair-settings-menu").click();
  await expect(marker(page, "settings-menu-section")).toBeVisible();
  await expect(marker(page, "settings-home")).toBeFocused();
});
