import { test, expect } from "../support/test";
import { createScenario, marker, NOW, openApp } from "../support/scenario";

function finderScenario() {
  const scenario = createScenario("route-finder-touch");
  scenario.on("GET", "/api/route-checks", ({ query }) => ({ body: {
    kind: query.kind, exit_code: query.exit, conditions: { targets: [], hash: "same", rounds: 2, timeout_sec: 5 },
    routes: [], active_run: null, run: null, fresh_sec: 600,
  } }));
  return scenario;
}

test("Tapping a chain exit selects it and dismisses the location list", async ({ page, baseURL, hasTouch }) => {
  test.skip(!hasTouch, "Requires touch input");
  const scenario = finderScenario();
  const location = scenario.state.status.available[0];
  for (let index = 0; index < 24; index++) {
    scenario.state.status.available.push({ ...location, code: "extra" + index, name: "Location " + index });
  }
  await openApp(page, scenario, baseURL!);
  await marker(page, "open-route-finder").tap();
  await marker(page, "route-finder-chain").tap();
  const exit = marker(page, "route-finder-exit");
  await exit.tap();
  const list = page.getByRole("listbox", { name: "Exit location" });
  // WebKit exposes tap but no swipe via Playwright. Check whether the sheet
  // cancels native scrolling when a vertical touch starts inside the popup.
  const scrollAllowed = await list.evaluate(node => {
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientY: y }] });
      return node.dispatchEvent(event);
    };
    touch("touchstart", 200);
    const allowed = touch("touchmove", 180);
    touch("touchend", 180);
    return allowed;
  });
  expect(scrollAllowed).toBe(true);
  await list.getByRole("option", { name: "Location 23", exact: true }).tap();
  await expect(list).toBeHidden();
  await expect(exit).toContainText("Location 23");
  await expect(exit).toBeFocused();
  await expect(marker(page, "route-finder")).toBeVisible();
});

test("Choosing locations by touch closes the picker while keyboard selection stays open", async ({ page, baseURL, hasTouch }) => {
  test.skip(!hasTouch, "Requires touch input");
  const scenario = finderScenario();
  scenario.on("POST", "/api/route-checks", scenario.handlers.get("GET /api/route-checks")!);
  await openApp(page, scenario, baseURL!);
  await marker(page, "open-route-finder").tap();
  const scope = marker(page, "route-finder-scope");
  const choose = marker(page, "route-finder-scope-option-chosen");
  await scope.tap();
  await choose.tap();
  const pick = marker(page, "route-pick-de");
  await expect(pick).not.toBeChecked();
  await page.locator("label").filter({ has: pick }).locator(".route-pick-name").tap();
  await expect(pick).toBeHidden();
  await expect(scope).toBeFocused();
  const start = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/route-checks");
  await marker(page, "route-finder-check").tap();
  expect((await start).postDataJSON()).toMatchObject({ kind: "single", codes: ["de"] });
  await scope.tap();
  await choose.tap();
  await expect(pick).toBeChecked();
  await pick.press("Space");
  await expect(pick).not.toBeChecked();
  await expect(pick).toBeFocused();
});

test("A check started elsewhere keeps the open entry picker and selection in place", async ({ page, baseURL }) => {
  const scenario = finderScenario();
  await openApp(page, scenario, baseURL!);
  await marker(page, "open-route-finder").click();
  await marker(page, "route-finder-chain").click();
  const scope = marker(page, "route-finder-scope");
  await scope.click();
  await marker(page, "route-finder-scope-option-chosen").click();
  const pick = marker(page, "route-pick-de");
  await pick.press("Space");
  const before = await pick.boundingBox();
  const run = { id: "21111111-1111-4111-8111-111111111111", kind: "chain", exit_code: "de", exit_name: "Germany 🇩🇪",
    state: "running", created_at: NOW, finished_at: null, total: 2, done: 0, working: 0 };
  scenario.state.status.route_check_run = run;
  await page.clock.runFor(10010);
  await expect(pick).toBeDisabled();
  await expect(pick).toBeChecked();
  await expect(pick).toBeFocused();
  expect(await pick.boundingBox()).toEqual(before);
  await expect(marker(page, "route-preset-all")).toBeDisabled();
  const done = marker(page, "route-pick-done");
  await expect(done).toBeEnabled();
  await pick.press("Space");
  await expect(pick).toBeChecked();
  scenario.state.status.route_check_run = { ...run, state: "completed", done: 2, finished_at: NOW };
  await page.clock.runFor(10010);
  await expect(pick).toBeEnabled();
  await expect(marker(page, "route-preset-all")).toBeEnabled();
  await done.click();
  await expect(scope).toBeFocused();
});
