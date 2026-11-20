import { test, expect } from "../support/test";
import { marker } from "../support/scenario";
import type { BrowserContext, Page } from "@playwright/test";

async function openUpdates(page: Page, context: BrowserContext, origin = "") {
  const session = await (await context.request.get(origin + "/api/auth/session")).json();
  const auth = await context.request.post(origin + (session.configured ? "/api/auth/login" : "/api/auth/setup"), {
    data: { password: "synthetic-ui-password" }, headers: { "X-XK-Request": "1" },
  });
  expect(auth.ok()).toBe(true);
  await page.goto(origin + "/");
  await marker(page, "btn-settings").click();
  await marker(page, "settings-router-updates").click();
  await marker(page, "router-check-updates").click();
}

test("dashboard installs and rolls back a pinned Xray release over real HTTP to the mock router", async ({ page, context }) => {
  test.setTimeout(45000);
  await openUpdates(page, context);
  await marker(page, "router-xray-schedule").click();
  await marker(page, "router-xray-version").selectOption("26.10.31");
  await marker(page, "router-xray-at").fill("2099-01-01T03:00");
  await marker(page, "router-xray-confirm").click();
  await expect(marker(page, "router-xray-card")).toContainText("Scheduled · 26.10.31");
  await marker(page, "router-xray-install").click();
  await marker(page, "router-xray-version").selectOption("26.10.31");
  await marker(page, "router-xray-confirm").click();
  const card = marker(page, "router-xray-card");
  await expect(card).toContainText("Installed 26.10.31", { timeout: 12000 });
  await expect(marker(page, "router-xray-unschedule")).toHaveCount(0);
  await marker(page, "router-xray-rollback").click();
  await expect(card).toContainText("Xray 26.10.31 → 26.3.27");
  await marker(page, "router-xray-confirm").click();
  await expect(card).toContainText("Installed 26.3.27", { timeout: 12000 });
  await expect(card).toContainText("Automatic installation of 26.10.31 is on hold");
  await page.reload();
  await marker(page, "router-updates-open").click();
  await expect(card).toContainText("Installed 26.3.27");
  await expect(marker(page, "router-recovery-summary")).toBeVisible();
});

test("dashboard replaces a pinned job with a pair, cancels it, and installs both after one confirmation", async ({ page, context }) => {
  test.setTimeout(60000);
  // Keep the two-component rollback history independent of the single-update fixture.
  await openUpdates(page, context, `http://127.0.0.1:${process.env.UI_PROXY_BACKEND_PORT}`);
  await marker(page, "router-xray-schedule").click();
  await marker(page, "router-xray-at").fill("2099-01-01T03:00");
  await marker(page, "router-xray-confirm").click();
  await marker(page, "router-pair-schedule").click();
  await expect(marker(page, "router-pair-replaces")).toContainText("Xray 26.11.9");
  await marker(page, "router-pair-confirm").click();
  const pair = marker(page, "router-pair-status");
  await expect(pair).toContainText("Scheduled");
  await expect(marker(page, "router-xray-unschedule")).toHaveCount(0);
  await marker(page, "router-pair-unschedule").click();
  await expect(pair).toContainText("Schedule cancelled");
  await marker(page, "router-pair-install").click();
  await marker(page, "router-pair-confirm").click();
  await page.reload();
  await marker(page, "btn-settings").click();
  await marker(page, "settings-router-updates").click();
  await expect(pair).toContainText("Both installed", { timeout: 25000 });
  await expect(marker(page, "router-xkeen-card")).toContainText("Installed 2.1");
  await expect(marker(page, "router-xray-card")).toContainText("Installed 26.11.9");
  await marker(page, "router-xkeen-rollback").click();
  await expect(marker(page, "router-xkeen-card")).toContainText("Xray 26.11.9 → 26.3.27, then XKeen 2.1 → 2.0");
  await marker(page, "router-xkeen-confirm").click();
  await expect(marker(page, "router-xkeen-card")).toContainText("Installed 2.0", {timeout: 15000});
});
