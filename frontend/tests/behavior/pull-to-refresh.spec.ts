import type { Page } from "@playwright/test";
import { expect, test } from "../support/test";
import { createScenario, marker, openApp } from "../support/scenario";
import { touchSequence } from "../support/touch";

async function openStandalone(page: Page, baseURL: string, displayMode = false) {
  const scenario = createScenario("X06:standalone");
  await page.addInitScript((useDisplayMode) => {
    if (!useDisplayMode) {
      Object.defineProperty(navigator, "standalone", { value: true });
      return;
    }
    const match = window.matchMedia.bind(window);
    window.matchMedia = (query) => match(query === "(display-mode: standalone)" ? "all" : query);
  }, displayMode);
  await openApp(page, scenario, baseURL);
  await expect(marker(page, "active-name")).toBeVisible();
  return scenario;
}

test("X06 installed display mode reloads once after release and paints refresh status", async ({ page, baseURL }) => {
  const scenario = await openStandalone(page, baseURL!, true);
  const body = page.locator("body");
  const status = marker(page, "pull-to-refresh");
  expect(await touchSequence(body, [["touchstart", 20], ["touchmove", 22]])).toEqual([false, true]);
  await expect(status).toContainText("Pull to refresh");
  await touchSequence(body, [["touchmove", 160]]);
  await expect(status).toContainText("Release to refresh");
  expect(scenario.count("GET", "/api/auth/session")).toBe(1);
  const reload = page.waitForEvent("domcontentloaded");
  await touchSequence(body, [["touchend", 160], ["touchend", 160]]);
  await expect(status).toContainText("Refreshing");
  await page.clock.runFor(48);
  await reload;
  await expect(marker(page, "active-name")).toBeVisible();
  expect(scenario.count("GET", "/api/auth/session")).toBe(2);
  await expect(status).toBeHidden();
});

test("X06 ordinary browser has no pull indicator or capture", async ({ page, baseURL }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: false }));
  await openApp(page, createScenario("X06:tab"), baseURL!);
  await expect(marker(page, "active-name")).toBeVisible();
  expect(await touchSequence(page.locator("body"), [["touchstart", 20], ["touchmove", 160]])).toEqual([false, false]);
  await expect(marker(page, "pull-to-refresh")).toHaveCount(0);
});

test("X06 short, retreating, upward, sideways and interrupted pulls never reload", async ({ page, baseURL }) => {
  const scenario = await openStandalone(page, baseURL!);
  const body = page.locator("body");
  const status = marker(page, "pull-to-refresh");
  for (const moves of [
    [["touchmove", 60]],
    [["touchmove", 170], ["touchmove", 60]],
    [["touchmove", 10], ["touchmove", 170]],
    [["touchmove", 30, 160], ["touchmove", 170]],
    [["touchmove", 170], ["touchstart", 170, 80, { fingers: 2 }]],
    [["touchmove", 170], ["touchmove", 171, 80, { cancelable: false }]],
  ] satisfies Parameters<typeof touchSequence>[1][]) {
    await touchSequence(body, [["touchstart", 20], ...moves, ["touchend", 170]]);
    await expect(status).toBeHidden();
  }
  await touchSequence(marker(page, "btn-settings"), [["touchstart", 20], ["touchmove", 170], ["touchend", 170]]);
  await page.clock.runFor(48);
  await expect(status).toBeHidden();
  expect(scenario.count("GET", "/api/auth/session")).toBe(1);
});

test("X06 scrolling and changing screens disarm the current gesture", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const scenario = await openStandalone(page, baseURL!);
  const body = page.locator("body");
  const status = marker(page, "pull-to-refresh");
  await page.evaluate(() => window.scrollTo(0, 150));
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await touchSequence(body, [["touchstart", 20]]);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await touchSequence(body, [["touchmove", 170], ["touchend", 170]])).toEqual([false, false]);
  for (const interrupt of ["scroll", "drawer", "routing"] as const) {
    await touchSequence(body, [["touchstart", 20], ["touchmove", 170]]);
    await expect(status).toContainText("Release to refresh");
    if (interrupt === "scroll") await page.evaluate(() => window.scrollTo(0, 150));
    else if (interrupt === "drawer") await marker(page, "btn-settings").click();
    else await marker(page, "nav-routing").click();
    await touchSequence(body, [["touchend", 170]]);
    await expect(status).toBeHidden();
    if (interrupt === "drawer") await page.goBack();
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.clock.runFor(48);
  expect(scenario.count("GET", "/api/auth/session")).toBe(1);
});

test("X06 a cached page restored during refresh can accept a new pull", async ({ page, baseURL }) => {
  const scenario = await openStandalone(page, baseURL!);
  const body = page.locator("body");
  const status = marker(page, "pull-to-refresh");
  await touchSequence(body, [["touchstart", 20], ["touchmove", 170], ["touchend", 170]]);
  await expect(status).toContainText("Refreshing");
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(status).toBeHidden();
  await touchSequence(body, [["touchstart", 20], ["touchmove", 170]]);
  await expect(status).toContainText("Release to refresh");
  await touchSequence(body, [["touchcancel", 170]]);
  await page.clock.runFor(48);
  expect(scenario.count("GET", "/api/auth/session")).toBe(1);
});
