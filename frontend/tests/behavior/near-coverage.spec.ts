import { test, expect } from "../support/test";
import { createScenario, marker, openApp } from "../support/scenario";

test("S02 only SNI renders a neutral notice and one manual apply clears it while scheduling is off", async ({ page, baseURL }) => {
  const scenario = createScenario("S02:manual-sni");
  const status = scenario.state.status;
  Object.assign(status, { pending_reapply_code: "fi", pending_update_kind: null });
  status.auto_update.enabled = false;
  scenario.on("POST", "/api/active-refresh", () => ({ body: { ok: true }, hold: "apply" }));
  await openApp(page, scenario, baseURL!);
  const notice = marker(page, "pending-active-config");
  const apply = marker(page, "btn-apply-active-config");
  for (const kind of [null, "config"]) {
    status.pending_update_kind = kind;
    await page.clock.runFor(10_001);
    await expect(notice.locator("b")).toHaveText("! update available");
    await expect(notice).not.toHaveClass(/optional-update/);
  }
  status.pending_update_kind = "sni";
  await page.clock.runFor(10_001);
  await expect(notice).toHaveClass(/optional-update/);
  await expect(notice.locator(".pending-config-copy > *")).toHaveText(["optional update · only SNI has changed", "auto-apply off"]);
  await expect(apply.locator(".terminal-action-label")).toHaveText("apply now");
  await apply.click();
  await expect(notice).toHaveAttribute("data-state", "applying");
  await expect(notice).not.toHaveClass(/optional-update/);
  await expect(apply).toBeDisabled();
  await apply.evaluate((button: HTMLButtonElement) => button.click());
  expect(scenario.count("POST", "/api/active-refresh")).toBe(1);
  Object.assign(status, { pending_reapply_code: null, pending_update_kind: null });
  await scenario.release("apply");
  await expect(notice).toHaveAttribute("data-state", "current");
  await expect(notice).not.toHaveClass(/optional-update/);
  await expect(apply).toBeDisabled();
});

test("S03 disabling interval updates retains the SNI preference and disables all four schedule controls", async ({ page, baseURL }) => {
  const scenario = createScenario("S03:disabled-sni");
  Object.assign(scenario.state.status.auto_update, { enabled: true, mode: "interval", interval_minutes: 120, sni_daily: true, daily_time: "05:45" });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-subscription").click();
  await marker(page, "auto-update-enabled").uncheck();
  for (const name of ["auto-update-mode", "auto-update-interval", "auto-update-sni-daily", "auto-update-sni-time"])
    await expect(marker(page, name)).toBeDisabled();
  await expect(marker(page, "auto-update-sni-daily")).toBeChecked();
  await expect(marker(page, "auto-update-sni-time")).toHaveValue("05:45");
  expect(scenario.requests.filter(request => request.method !== "GET")).toEqual([]);
});

test("O02 ephemeral preparation discovers the durable journal and silently releases its block", async ({ page, baseURL }) => {
  const scenario = createScenario("O02:ephemeral-to-durable");
  const id = "34567890-1111-4111-8111-000000000003";
  const journal = "/api/routing/operations/" + id;
  const preparation = { ephemeral: true, id: null, kind: "device-location", phase: "preparing", blocking: true, target_code: "se" };
  scenario.state.status.operation = preparation;
  const durable = { ...preparation, ephemeral: false, id, phase: "installing" };
  scenario.on("GET", journal, () => {
    scenario.state.status.operation = null;
    return { body: { ...durable, phase: "committed", blocking: false } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "operation-status")).toBeVisible();
  await expect(marker(page, "operation-details")).toHaveCount(0);
  const reads = scenario.count("GET", "/api/status");
  scenario.state.status.operation = durable;
  await page.clock.runFor(1600);
  await expect(marker(page, "operation-status")).toContainText("Installing configuration");
  expect(scenario.count("GET", "/api/status")).toBeGreaterThan(reads);
  expect(scenario.count("GET", journal)).toBe(0);
  await page.clock.runFor(1600);
  await expect.poll(() => scenario.count("GET", journal)).toBe(1);
  await expect(page.locator('[data-marker="loc-select"][data-code="de"]')).toBeEnabled();
  await expect(marker(page, "toast")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("xk_notifications") ?? "[]"))).toEqual([]);
});

test("M02 own Main finishes inside its Routing recovery details and reports the Main result only once", async ({ page, baseURL }) => {
  const scenario = createScenario("M02:routing-main").switch();
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count("POST", "/api/switch")).toBe(1);
  scenario.advance("unknown");
  await page.clock.runFor(1600);
  await marker(page, "btn-activity").click();
  await expect(marker(page, "operation-confirmed")).toContainText("Finland");
  const details = marker(page, "operation-details");
  const id = scenario.state.status.operation.id;
  await expect(details).toHaveAttribute("href", "#routing/operation/" + id);
  await details.click();
  const progress = marker(page, "routing-operation-status");
  await expect(progress).toHaveAttribute("data-phase", "unknown");
  scenario.advance("committed");
  await page.clock.runFor(3200);
  await expect(progress).toHaveAttribute("data-phase", "committed");
  await expect(marker(page, "toast")).toContainText("Main switched to Germany");
  const messages = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem("xk_notifications") ?? "[]") as { message: string }[]).map(item => item.message));
  expect(messages).toEqual(["Main switched to Germany 🇩🇪"]);
  expect(scenario.count("POST", "/api/switch")).toBe(1);
});

test("X04 poll reorders existing location rows around the focused probe without detaching its ancestors", async ({ page, baseURL }) => {
  const scenario = createScenario("X04:location-reorder");
  await openApp(page, scenario, baseURL!);
  const rows = marker(page, "loc-row");
  const probe = page.locator('[data-marker="btn-probe"][data-code="de"]');
  await probe.focus();
  const snapshot = await probe.evaluateHandle(button => {
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-marker="loc-row"]')];
    const removed: Node[] = [];
    const observer = new MutationObserver(records => {
      for (const record of records) removed.push(...record.removedNodes);
    });
    observer.observe(document, { subtree: true, childList: true });
    return { nodes, button, removed, observer };
  });
  const [fi, de, se] = scenario.state.status.available;
  const no = { ...fi, code: "no", name: "Norway 🇳🇴" };
  for (const available of [[se, fi, de], [se, no, fi, de], [se, no, de], [de, no, se]]) {
    scenario.state.status.available = available;
    await page.clock.runFor(10_001);
    await expect.poll(() => rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-code")))).toEqual(
      available.map(location => location.code));
    await expect(probe).toBeFocused();
    expect(await snapshot.evaluate(({ button, nodes, removed }) => {
      const fi = document.querySelector('[data-marker="loc-row"][data-code="fi"]');
      const de = document.querySelector('[data-marker="loc-row"][data-code="de"]');
      return { previousFinlandIfPresent: !fi || nodes[0] === fi, sameGermany: nodes[1] === de,
        sameFocus: document.activeElement === button, detached: removed.some(node => node.contains(button)) };
    })).toEqual({ previousFinlandIfPresent: true, sameGermany: true, sameFocus: true, detached: false });
  }
  await snapshot.evaluate(({ observer }) => observer.disconnect());
});

test("S01 a failed refresh keeps its last-success tooltip and reports unknown freshness until recovery", async ({ page, baseURL }) => {
  const scenario = createScenario("S01:failed-last-success");
  const status = scenario.state.status;
  status.last_update_status = "fail";
  await openApp(page, scenario, baseURL!);
  const notice = marker(page, "pending-active-config");
  const previous = marker(page, "subscription-last-success");
  await expect(notice).toHaveAttribute("data-state", "unknown");
  await expect(notice).toContainText("subscription refresh failed");
  await expect(marker(page, "btn-apply-active-config")).toBeDisabled();
  await expect(marker(page, "subscription-toggle")).toHaveAccessibleName(/refresh failed/);
  await expect(previous).toHaveText(/last success/);
  await expect(previous).toHaveAttribute("title", /\S/);
  const timestamp = status.last_update_at;
  status.last_update_at = null;
  await page.clock.runFor(10_001);
  await expect(previous).toHaveText("no successful refresh");
  await expect(notice).toHaveAttribute("data-state", "unknown");
  status.last_update_at = timestamp;
  status.last_update_status = "ok";
  await page.clock.runFor(10_001);
  await expect(notice).toHaveAttribute("data-state", "current");
});
