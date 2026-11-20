import { test, expect } from "../support/test";
import { createScenario, marker, openApp } from "../support/scenario";

for (const source of ["switch reply", "journal", "journal with stalled readback"]) {
  test("M02 " + source + " confirms Main while the pre-commit status poll is still pending", async ({ page, baseURL }) => {
    const scenario = createScenario("M02:terminal-status").switch();
    if (source === "switch reply") {
      const accept = scenario.handlers.get("POST /api/switch")!;
      scenario.on("POST", "/api/switch", async request => {
        const acknowledgement = await accept(request);
        const operation = { ...scenario.state.operations[request.body.operation_id], phase: "committed", blocking: false };
        return { ...acknowledgement, body: { operation }, hold: "terminal-post" };
      });
    }
    await openApp(page, scenario, baseURL!);
    const location = marker(page, "active-name");
    await expect(location).toContainText("Finland");
    await page.locator('[data-marker="loc-select"][data-code="de"]').click();
    await expect.poll(() => scenario.count("POST", "/api/switch")).toBe(1);

    const stale = structuredClone(scenario.state.status);
    const reads = () => scenario.count("GET", "/api/status");
    const initial = reads();
    scenario.on("GET", "/api/status", () => ({ body: stale, hold: "pre-commit" }));
    await page.clock.runFor(10_100);
    await expect.poll(reads).toBe(initial + 1);
    scenario.advance("committed");
    scenario.on("GET", "/api/status", () => ({
      body: structuredClone(scenario.state.status),
      hold: source === "journal with stalled readback" && reads() === initial + 2 ? "stalled" : undefined,
    }));
    if (source === "switch reply") await scenario.release("terminal-post");
    else await page.clock.runFor(1_600);
    await expect(marker(page, "toast")).toContainText("Main switched to Germany");
    await expect.poll(reads).toBe(initial + 2);
    if (source === "journal with stalled readback") {
      await expect(location).toContainText("Finland");
      await page.clock.runFor(10_001);
      await expect.poll(reads).toBe(initial + 3);
      await scenario.release("stalled");
    }
    await expect(location).toContainText("Germany");
    await scenario.release("pre-commit");
    await page.clock.runFor(50);
    await expect(location).toContainText("Germany");
    const beforeNextPoll = reads();
    await page.clock.runFor(10_001);
    await expect.poll(reads).toBeGreaterThan(beforeNextPoll);
    await expect(location).toContainText("Germany");
    expect(scenario.count("POST", "/api/switch")).toBe(1);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("xk_notifications") ?? "[]"))).toHaveLength(1);
  });
}

test("H01 a failure outside the retained event window needs attention until its domain recovers", async ({ page, baseURL }) => {
  const scenario = createScenario("H01:rotated-attention");
  const failure = { ts: "2026-11-17T08:59:00Z", event_id: "routing-failure", action: "routing-apply", result: "fail", message: "Router refused this configuration" };
  scenario.state.status.events = [failure];
  await openApp(page, scenario, baseURL!);
  const launcher = marker(page, "btn-activity");
  await expect(launcher).toHaveAttribute("data-attention", "true");
  const routine = Array.from({ length: 100 }, (_, index) => ({
    ts: "2026-11-17T09:01:00Z", event_id: "refreshed-" + index, action: "update", result: "ok",
  }));
  scenario.state.status.events = routine;
  const next = page.waitForResponse(response => new URL(response.url()).pathname === "/api/status");
  await page.clock.runFor(10_001);
  await (await next).finished();
  await launcher.click();
  await expect(marker(page, "background-attention")).toContainText(failure.message);
  scenario.state.status.events = [...routine.slice(1), { ...failure, event_id: "routing-recovery", action: "routing-restore", result: "ok" }];
  await page.clock.runFor(10_001);
  await expect(launcher).toHaveAttribute("data-attention", "false");
  await expect(marker(page, "background-attention")).toHaveCount(0);
});

test("A03 a replacement login does not inherit unresolved routing attention", async ({ page, baseURL }) => {
  const scenario = createScenario("A03:replace-attention");
  scenario.state.status.events = [{ ts: "2026-11-17T08:59:00Z", event_id: "old-session-failure", action: "routing-apply", result: "fail" }];
  scenario.on("POST", "/api/auth/logout", () => {
    scenario.state.session.authenticated = false;
    return { body: { ok: true } };
  });
  scenario.on("POST", "/api/auth/login", () => {
    scenario.state.session = { configured: true, authenticated: true, session_id: "new-synthetic-session" };
    scenario.state.status.events = [];
    return { body: { ok: true } };
  });
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "btn-activity")).toHaveAttribute("data-attention", "true");
  await marker(page, "btn-settings").click();
  await marker(page, "btn-logout").click();
  await marker(page, "gate-input").fill("synthetic-password");
  await marker(page, "gate-submit").click();
  await expect(marker(page, "active-name")).toContainText("Finland");
  await expect(marker(page, "btn-activity")).toHaveAttribute("data-attention", "false");
  await marker(page, "btn-activity").click();
  await expect(marker(page, "background-attention")).toHaveCount(0);
});
