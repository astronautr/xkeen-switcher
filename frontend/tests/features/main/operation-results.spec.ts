import type { Page } from "@playwright/test";
import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";
import { ephemeralActivity } from "../../support/main-contracts";

const savedNotifications = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("xk_notifications") || "[]"));

test("Offline Retry observes the current holder before enabling Main actions", async ({ page, baseURL }) => {
  const scenario = createScenario("O04:retry");
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "active-name")).toContainText("Finland");
  scenario.on("GET", "/api/status", () => ({ abort: true }));
  await page.clock.runFor(10_001);
  await expect(marker(page, "offline-state")).toBeVisible();
  ephemeralActivity(scenario, "read");
  scenario.on("GET", "/api/status", () => ({ body: scenario.state.status }));
  await marker(page, "offline-retry").click();
  await expect(marker(page, "offline-state")).toHaveCount(0);
  await expect(marker(page, "btn-xkeen-toggle")).toBeDisabled();
  expect(scenario.count("GET", "/api/status")).toBe(3);
  expect(scenario.requests.some((request) => request.method === "POST")).toBe(false);
});

test("Late acceptance cannot replace the next Main request", async ({ page, baseURL }) => {
  const scenario = createScenario("M02:next").switch("held");
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count("POST", "/api/switch")).toBe(1);
  scenario.advance("committed");
  await page.clock.runFor(1600);
  await expect(marker(page, "active-name")).toContainText("Germany");
  scenario.switch();
  await page.locator('[data-marker="loc-select"][data-code="se"]').click();
  await expect.poll(() => scenario.count("POST", "/api/switch")).toBe(2);
  const requests = scenario.requests.filter((request) => request.path === "/api/switch");
  expect(requests[0]!.body.operation_id).not.toBe(requests[1]!.body.operation_id);
  await scenario.release("switch");
  await expect(marker(page, "main-requested")).toContainText("Sweden");
  await expect(marker(page, "active-name")).toContainText("Germany");
  expect(await savedNotifications(page)).toHaveLength(1);
});

for (const phase of ["rolled_back", "rejected"] as const) {
  test(
    "Main journal " + phase + " leaves the confirmed route and reports exactly one failure",
    async ({ page, baseURL }) => {
      const scenario = createScenario("O01:" + phase).switch("held");
      await openApp(page, scenario, baseURL!);
      await page.locator('[data-marker="loc-select"][data-code="de"]').click();
      await expect.poll(() => scenario.count("POST", "/api/switch")).toBe(1);
      const journal = "/api/routing/operations/" + scenario.state.status.operation.id;
      const read = scenario.handlers.get("GET " + journal)!;
      scenario.on("GET", journal, () => ({ abort: true }));
      await page.clock.runFor(1600);
      await expect(marker(page, "btn-xkeen-toggle")).toBeDisabled();
      expect(await savedNotifications(page)).toEqual([]);
      scenario.on("GET", journal, read);
      scenario.advance(phase);
      await page.clock.runFor(1600);
      await expect(marker(page, "btn-xkeen-toggle")).toBeEnabled();
      await scenario.release("switch");
      await page.clock.runFor(1600);
      await expect(marker(page, "active-name")).toContainText("Finland");
      expect(await savedNotifications(page)).toEqual([
        expect.objectContaining({
          error: true,
          message: expect.stringContaining(phase === "rolled_back" ? "rolled back" : "not applied"),
        }),
      ]);
      expect(scenario.count("POST", "/api/switch")).toBe(1);
    },
  );
}

test("Cached switch commits with its warning while subscription freshness remains unknown", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("M01:cached").switch();
  const accept = scenario.handlers.get("POST /api/switch")!;
  const warning = "Subscription refresh failed; using saved location configuration.";
  scenario.on("POST", "/api/switch", async (request) => {
    const reply = await accept(request);
    for (const operation of [
      scenario.state.status.operation,
      scenario.state.operations[request.body.operation_id],
      reply.body.operation,
    ]) {
      operation.warning = warning;
    }
    return reply;
  });
  scenario.state.status.last_update_status = "fail";
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect(marker(page, "main-requested")).toContainText("Germany");
  await expect(marker(page, "pending-active-config")).toHaveAttribute("data-state", "unknown");
  await expect(marker(page, "subscription-toggle")).toContainText("refresh failed");
  scenario.advance("committed");
  await page.clock.runFor(1600);
  await expect(marker(page, "active-name")).toContainText("Germany");
  expect(await savedNotifications(page)).toEqual([
    expect.objectContaining({ error: false, message: expect.stringContaining(warning) }),
  ]);
  expect(scenario.count("POST", "/api/update")).toBe(0);
});

for (const reason of ["busy", "precondition"] as const) {
  test("Main retains a dismissible " + reason + " refusal and never queues it", async ({ page, baseURL }) => {
    const scenario = createScenario("M04:" + reason).switch(reason);
    await openApp(page, scenario, baseURL!);
    if (reason === "busy") {
      await page.locator('[data-marker="loc-select"][data-code="de"]').click();
    } else {
      await marker(page, "main-mode-chain").click();
      await expect(marker(page, "chain-entry")).toHaveAccessibleName("Entry location: Choose");
      await marker(page, "chain-entry").click();
      await marker(page, "chain-entry-option-se").click();
      await marker(page, "chain-exit").click();
      await marker(page, "chain-exit-option-de").click();
      await marker(page, "chain-apply").click();
    }
    const target = reason === "busy" ? "Germany 🇩🇪" : "Sweden 🇸🇪 → Germany 🇩🇪";
    await expect(marker(page, "switch-refusal")).toContainText(`Switch to ${target} was not accepted`);
    await marker(page, "switch-refusal-dismiss").click();
    await page.evaluate(() => { location.hash = "routing"; });
    await expect(marker(page, "active-name")).toHaveCount(0);
    await page.goBack();
    await expect(marker(page, "active-name")).toContainText("Finland");
    await page.clock.runFor(30_001);
    await expect(marker(page, "switch-refusal")).toHaveCount(0);
    await expect(marker(page, "active-name")).toContainText("Finland");
    const explanation = reason === "busy" ? "Nothing was queued" : "cannot perform this action yet";
    expect(await savedNotifications(page)).toEqual([
      expect.objectContaining({ error: true, message: expect.stringContaining(explanation) }),
    ]);
    expect(scenario.count("POST", "/api/switch")).toBe(1);
  });
}
