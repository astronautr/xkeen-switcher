import { test, expect } from "../support/test";
import { createScenario, marker, NOW, openApp } from "../support/scenario";

const runId = "11111111-1111-4111-8111-111111111111";
const exitCode = "fi";
const entryCode = "de";
const entryName = "Germany 🇩🇪 10Gbit Frankfurt Very Long Entry Name";

function routeScenario() {
  const s = createScenario("route-finder");
  s.state.status.available.find((loc: { code: string }) => loc.code === entryCode).name = entryName;
  const run = { id: runId, kind: "chain", exit_code: exitCode, exit_name: "Finland 🇫🇮", state: "running", created_at: NOW,
    finished_at: null as string | null, total: 2, done: 1, working: 0, conditions_hash: "fixture-hash" };
  s.state.status.route_check_run = run;
  const conditions = { targets: ["https://video.example/"], timeout_sec: 5, rounds: 2, hash: "fixture-hash" };
  const direct = (loc: { code: string; name: string }) => ({
    key: loc.code, mode: "single", entry_code: null, entry_name: null, exit_code: loc.code, exit_name: loc.name,
    state: "unchecked", checked_at: null, applicable: false, on_main: loc.code === exitCode, run_id: null,
    last_attempt: null, rounds: [],
  });
  s.on("GET", "/api/route-checks", ({ query }) => {
    const active_run = run.state === "running" ? run : null;
    if (query.kind === "single") return { body: { kind: "single", fresh_sec: 600, conditions, run: null,
      active_run, routes: s.state.status.available.map(direct) } };
    const finished = run.state === "completed";
    return { body: {
      kind: "chain", exit_code: exitCode, direct: direct({ code: exitCode, name: "Finland 🇫🇮" }),
      fresh_sec: 600, conditions, run, active_run,
      routes: [{
        key: entryCode, mode: "chain", entry_code: entryCode, entry_name: entryName, exit_code: exitCode, exit_name: "Finland 🇫🇮",
        state: finished ? "working" : active_run ? "checking" : "unavailable", checked_at: run.finished_at, applicable: finished,
        reason: run.state === "cancelled" ? "Stopped before this route finished" : null,
        outcome: finished ? "working" : null, fresh_until: finished ? "2026-11-17T09:10:00Z" : null,
        entry_reachable: null, entry_checked_at: null, last_attempt: null, on_main: false, run_id: runId, rounds: [],
      }],
    } };
  });
  const finish = () => Object.assign(run, { state: "completed", done: 2, working: 1, finished_at: NOW });
  return { s, finish, run };
}

test("Running checks survive closing and reloading and announce their progress in Activity", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { s, finish } = routeScenario();
  await openApp(page, s, baseURL!, "dark");
  const trigger = marker(page, "open-route-finder");
  await trigger.click();
  await expect(marker(page, "route-finder-report")).toHaveText("Checking chains · 1/2");
  const frame = page.locator(".route-sheet-frame");
  const grip = await page.locator(".route-sheet-grip").boundingBox();
  expect(grip).not.toBeNull();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip!.x + grip!.width / 2, 20, { steps: 5 });
  await page.mouse.up();
  await expect(frame).toHaveAttribute("data-snap", "2");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(marker(page, "btn-activity")).toContainText("1 of 2 routes checked");
  await page.reload();
  await trigger.click();
  await expect(marker(page, "route-finder-report")).toHaveText("Checking chains · 1/2");
  await expect(marker(page, "route-row")).toHaveAttribute("data-state", "checking");
  expect(s.count("POST", "/api/route-checks")).toBe(0);
  finish();
  const apply = page.getByRole("button", { name: `Apply ${entryName} → Finland 🇫🇮 to Main` });
  await expect.poll(async () => {
    await page.clock.runFor(1000);
    return apply.count();
  }).toBe(1);
  await expect(apply).toBeEnabled();
  expect((await apply.boundingBox())!.x + (await apply.boundingBox())!.width).toBeLessThanOrEqual(320);
});

test("An open check keeps its original rounds while a newer verdict arrives", async ({ page, baseURL }) => {
  const { s, run, finish } = routeScenario();
  finish();
  const read = s.handlers.get("GET /api/route-checks")!;
  s.on("GET", "/api/route-checks", async request => {
    const reply = await read(request);
    if (request.query.kind === "chain" && run.state === "completed") {
      const ok = run.id === runId;
      Object.assign(reply.body.routes[0], {
        state: ok ? "working" : "failed", outcome: ok ? "working" : "failed", applicable: ok,
        rounds: [{ ok, results: [{ ok, url: "https://video.example/" }] }],
      });
    }
    return reply;
  });
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  await marker(page, "route-finder-chain").click();
  const toggle = marker(page, "route-row-toggle");
  const details = marker(page, "route-row-details");
  await toggle.focus();
  await toggle.press("Enter");
  await expect(details).toContainText("Round 1 · passed");
  const original = await details.innerText();
  const bounds = await details.boundingBox();
  Object.assign(run, { id: "22222222-2222-4222-8222-222222222222", state: "running", done: 0, finished_at: null });
  await page.clock.runFor(3100);
  await expect(toggle).toHaveAccessibleName(/^Checking/);
  await expect(toggle).toBeFocused();
  expect(await details.innerText()).toBe(original);
  expect(await details.boundingBox()).toEqual(bounds);
  const later = "2026-11-17T09:01:00Z";
  Object.assign(run, { state: "completed", done: 2, working: 0, finished_at: later });
  await page.clock.runFor(1100);
  await expect(toggle).toHaveAccessibleName(/^Failed/);
  expect(await details.innerText()).toBe(original);
  await expect(details.locator("time")).toHaveAttribute("datetime", NOW);
  await toggle.press("Enter");
  await expect(details).toBeHidden();
  await toggle.press("Enter");
  await expect(details.locator("time")).toHaveAttribute("datetime", later);
  await expect(details).toContainText("Round 1 · failed");
});

test("A stale refusal stays in the sheet and an ambiguous Apply reuses its checked request", async ({ page, baseURL }) => {
  const { s, finish } = routeScenario();
  finish();
  await page.addInitScript(() => localStorage.setItem("xk_route_finder", JSON.stringify({ step: "chain", exit: "fi" })));
  s.switch("lost");
  const accept = s.handlers.get("POST /api/switch")!;
  s.on("POST", "/api/switch", async request => {
    const count = s.count("POST", "/api/switch");
    if (count === 1) return { status: 409, body: { code: "stale_check", error: "Check targets changed. Recheck routes." } };
    const response = await accept(request);
    if (count === 2) s.on("GET", `/api/routing/operations/${request.body.operation_id}`,
      () => ({ status: 404, body: { error: "not found" } }));
    return response;
  });
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  const apply = marker(page, "route-apply");
  await apply.click();
  await expect(marker(page, "route-finder").locator(".toast.error")).toContainText("Recheck routes");
  await apply.dblclick();
  await expect.poll(() => s.count("POST", "/api/switch")).toBe(2);
  await expect(marker(page, "route-finder")).toBeVisible();
  await page.clock.runFor(1600);
  await expect.poll(() => s.count("POST", "/api/switch")).toBe(3);
  const [first, replay] = s.requests.filter(r => r.path === "/api/switch").slice(1);
  expect(first!.body).toMatchObject({ code: exitCode, entry_code: entryCode, route_check_id: runId });
  expect(replay!.body).toEqual(first!.body);
  await page.clock.runFor(1600);
  await expect(marker(page, "route-finder")).toBeHidden();
  await expect(marker(page, "active-name")).toContainText("Finland");
  s.advance("committed");
  await page.clock.runFor(1600);
  await expect(marker(page, "active-name")).toContainText(/Germany.* → Finland/);
});

for (const width of [320, 1440]) test(`Route finder and ping stay distinct actions at ${width}px`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 900 });
  const s = createScenario("route-finder-layout");
  await openApp(page, s, baseURL!);
  const locations = marker(page, "locations");
  // The Locations heading carries no action; the finder precedes the mode choice and ping sits over the list.
  await expect(locations.locator(".box-title-row button")).toHaveCount(0);
  const order = await locations.evaluate((node) => {
    const top = (selector: string) => node.querySelector(selector)!.getBoundingClientRect().top;
    return [top('[data-marker="open-route-finder"]'), top(".main-mode"), top('[data-marker="btn-check-all"]'),
      top('[data-marker="loc-row"]')];
  });
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  await expect(marker(page, "btn-check-all")).toHaveText("ping all");
  await expect(page.getByRole("button", { name: /^Find a working route/ })).toBeVisible();
  await expect(page.locator('[data-marker="btn-probe"][data-code="de"]')).toHaveAccessibleName("ping Germany 🇩🇪");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("The check button stops a running check in place and keeps its focus and width", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { s, run } = routeScenario();
  s.on("POST", "/api/route-checks/cancel", (request) => {
    expect(request.body).toEqual({ run_id: runId });
    Object.assign(run, { state: "cancelled", finished_at: NOW });
    return s.handlers.get("GET /api/route-checks")!({ ...request, query: { kind: "chain", exit: exitCode } });
  });
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  const button = marker(page, "route-finder-check");
  await expect(button).toHaveAccessibleName(/stop/i);
  await expect(button).toHaveText(/stop/);
  await expect(button).toHaveAttribute("aria-disabled", "false");
  const before = (await button.boundingBox())!.width;
  await button.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => s.count("POST", "/api/route-checks/cancel")).toBe(1);
  await expect(marker(page, "route-finder-report")).toContainText(/stopped/i);
  await expect(button).toHaveText(/recheck/);
  await expect(button).toBeFocused();
  expect((await button.boundingBox())!.width).toBe(before);
  await marker(page, "route-row-toggle").click();
  await expect(marker(page, "route-row-details")).toContainText("Stopped before this route finished");
  // check · stop · recheck share one width, so neither the field nor the row below moves.
  const exitField = (await marker(page, "route-finder-exit").boundingBox())!.width;
  for (const label of ["check", "stop", "recheck"]) {
    await button.evaluate((node, text) => {
      node.querySelector(".terminal-action-label")!.firstChild!.textContent = text;
    }, label);
    expect((await button.boundingBox())!.width).toBe(before);
    expect((await marker(page, "route-finder-exit").boundingBox())!.width).toBe(exitField);
  }
  expect(s.count("POST", "/api/route-checks")).toBe(0);
});

for (const width of [320, 1440]) test(`Progress keeps finder controls and results in place at ${width}px`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 844 });
  const { s, run, finish } = routeScenario();
  finish();
  await page.addInitScript(() => localStorage.setItem("xk_route_finder", JSON.stringify({ step: "chain", exit: "fi" })));
  s.on("POST", "/api/route-checks", async request => {
    Object.assign(run, { id: request.body.run_id, state: "running", done: 0, working: 0, finished_at: null });
    const reply = await s.handlers.get("GET /api/route-checks")!({ ...request, query: { kind: "chain" } });
    return { ...reply, hold: "start" };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  const sheet = marker(page, "route-finder");
  const check = marker(page, "route-finder-check");
  const report = marker(page, "route-finder-report");
  const geometry = () => sheet.evaluate(dialog => {
    const selectors = [".route-sheet-head", ".route-sheet-steps", ".route-sites", ".route-sheet-check",
      ".route-sheet-report", ".route-list", ".route-row"];
    return selectors.map(selector => {
      const { x, y, width, height } = dialog.querySelector(selector)!.getBoundingClientRect();
      return [x, y, width, height];
    });
  });
  await expect(report).toContainText("1 worked · 1/2 checked");
  const idle = await geometry();
  await check.click();
  await expect(report).toHaveText("Starting check…");
  expect(await geometry()).toEqual(idle);
  await s.release("start");
  await expect(report).toHaveText("Checking chains · 0/2");
  expect(await geometry()).toEqual(idle);
  run.done = 1;
  await page.clock.runFor(1510);
  await expect(report).toHaveText("Checking chains · 1/2");
  expect(await geometry()).toEqual(idle);
  finish();
  await page.clock.runFor(1510);
  await expect(report).toContainText("1 worked · 1/2 checked");
  expect(await geometry()).toEqual(idle);
  const toast = sheet.locator(".toast");
  await expect(toast).toBeVisible();
  const notice = (await toast.boundingBox())!;
  const bounds = (await sheet.boundingBox())!;
  const control = (await check.boundingBox())!;
  expect(notice.y).toBeGreaterThanOrEqual(control.y + control.height);
  expect(notice.y + notice.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  expect(notice.x).toBeGreaterThanOrEqual(bounds.x);
  expect(notice.x + notice.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  await marker(page, "toast-dismiss").click();
  expect(await geometry()).toEqual(idle);
});
