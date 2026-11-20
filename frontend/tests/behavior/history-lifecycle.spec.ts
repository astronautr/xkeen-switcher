import { expect, test } from "../support/test";
import { createScenario, marker, NOW, openApp } from "../support/scenario";

test("H01 refresh reports the reconciled count and incomplete route recovery in both surfaces", async ({ page, baseURL }) => {
  const scenario = createScenario("H01:refresh-recovery");
  scenario.on("POST", "/api/update", () => {
    scenario.state.status.available = scenario.state.status.available.slice(0, 2);
    return { body: { ok: true, recovery_attempted: true, recovered: false, recovery_active_after: "de" } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-update-sub").click();
  const message = "subscription refreshed · 2 locations · no working route · left on de";
  await expect(marker(page, "toast")).toContainText(message);
  await expect(marker(page, "toast")).toHaveClass(/error/);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "notification-item")).toContainText(message);
  await expect(marker(page, "notification-item").locator(".t-hist-prefix")).toHaveText("fail");
  expect(scenario.count("POST", "/api/update")).toBe(1);
});

test("H01 lost Main reply, journal commit and boundary event produce one saved result across reload", async ({ page, baseURL }) => {
  const scenario = createScenario("H01:lost-reply").switch("lost");
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count("POST", "/api/switch")).toBe(1);
  const operation = scenario.state.status.operation;
  await expect(marker(page, "active-name")).toContainText("Finland");

  scenario.advance("committed");
  const entry = {
    event_id: "completed-main-event",
    operation_id: operation.id,
    ts: NOW,
    action: "switch",
    code: "de",
    trigger: "manual",
    result: "ok",
  };
  scenario.state.status.history = [entry];
  scenario.state.status.events = [entry];
  await page.clock.runFor(1600);
  await expect(marker(page, "active-name")).toContainText("Germany");
  await expect(marker(page, "toast")).toHaveCount(1);
  await expect(marker(page, "toast")).toContainText("Main switched to Germany");

  await page.reload();
  await expect(marker(page, "active-name")).toContainText("Germany");
  await page.clock.runFor(10_001);
  await expect(marker(page, "toast")).toHaveCount(0);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "notification-item")).toHaveCount(1);
  await expect(marker(page, "notification-item")).toContainText("Main switched to Germany");
  await marker(page, "activity-filter-router").click();
  await expect(marker(page, "activity-item")).toHaveCount(1);
  await expect(marker(page, "activity-item")).toContainText("switch de (Germany");
  expect(scenario.count("POST", "/api/switch")).toBe(1);
});

test("H02 malformed saved entries cannot render or become Undo actions", async ({ page, baseURL }) => {
  const scenario = createScenario("H02:malformed");
  await page.addInitScript((now) => {
    localStorage.setItem("xk_notifications", JSON.stringify([
      null,
      { at: now, message: { text: "nested" } },
      { at: "not a date", message: "invalid timestamp" },
      { at: now, message: "Saved result", device_operation: { id: "invalid" } },
    ]));
  }, NOW);
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "notification-item")).toHaveCount(1);
  await expect(marker(page, "notification-item")).toContainText("Saved result");
  await expect(marker(page, "device-history-undo")).toHaveCount(0);
  await marker(page, "notifications-clear").click();
  await expect(marker(page, "btn-activity")).toBeFocused();
  await expect(marker(page, "notification-item")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(marker(page, "activity-panel")).toBeHidden();
  await expect(marker(page, "btn-activity")).toBeFocused();
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("H03 an existing toast keeps its DOM while the history panel opens and closes", async ({ page, baseURL }) => {
  const scenario = createScenario("H03:rehost");
  scenario.on("POST", "/api/update", () => ({ body: { ok: true } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-update-sub").click();
  const toast = marker(page, "toast");
  await expect(toast).toBeVisible();
  const original = await toast.elementHandle();
  await marker(page, "btn-activity").click();
  await expect(marker(page, "activity-panel")).toBeVisible();
  await expect(page.locator('body > .toast-stack > [data-marker="toast"]')).toHaveCount(1);
  expect(await toast.evaluate((node, before) => node === before, original!)).toBe(true);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "activity-panel")).toBeHidden();
  expect(await toast.evaluate((node, before) => node === before, original!)).toBe(true);
  await expect(marker(page, "btn-activity")).toBeFocused();
  await page.clock.runFor(6500);
  await expect(toast).toHaveCount(0);
  await original?.dispose();
});

test("H03 sign-out removes live toast controls and the next login opens with a quiet saved inbox", async ({ page, baseURL }) => {
  const scenario = createScenario("H03:session");
  scenario.on("POST", "/api/update", () => ({ body: { ok: true } }));
  scenario.on("POST", "/api/auth/sessions/revoke", () => ({ body: { ok: true, current_revoked: true } }));
  scenario.on("POST", "/api/auth/login", () => ({ body: { ok: true } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-update-sub").click();
  await expect(marker(page, "toast")).toBeVisible();
  await marker(page, "btn-settings").click();
  await expect(marker(page, "btn-activity")).toBeHidden();
  await marker(page, "settings-access").click();
  await marker(page, "device-revoke").click();
  await expect(marker(page, "gate-input")).toBeVisible();
  await expect(marker(page, "toast")).toHaveCount(0);
  await marker(page, "gate-input").fill("synthetic-ui-password");
  await marker(page, "gate-submit").click();
  await marker(page, "btn-activity").click();
  await expect(marker(page, "notification-item")).toHaveCount(1);
  await expect(marker(page, "toast")).toHaveCount(0);
});
