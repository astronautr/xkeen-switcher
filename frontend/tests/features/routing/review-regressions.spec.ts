import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";
import { routingScenario } from "../../support/routing";

declare global {
  interface Window {
    recordedRuleAnimations: { duration: number; expands: boolean }[];
  }
}

test("an expired preview requires a new review before another apply", async ({ page, baseURL }) => {
  const scenario = routingScenario(createScenario("expired-preview"));
  scenario.on("POST", "/api/routing/apply", () => ({
    status: 404,
    body: { code: "not_found", error: "Version not found" },
  }));

  await openApp(page, scenario, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();

  await expect(marker(page, "panel-feedback")).toContainText("no longer available");
  await expect(marker(page, "review-apply")).toBeDisabled();
  await page.clock.runFor(31000);
  expect(scenario.count("POST", "/api/routing/apply")).toBe(1);

  await marker(page, "panel-close").click();
  await marker(page, "draft-review").click();
  await expect(marker(page, "review-apply")).toBeEnabled();
  expect(scenario.count("POST", "/api/routing/preview")).toBe(2);
});

test("a failed initial routing read can be retried on a versions deep link", async ({ page, baseURL }) => {
  const scenario = routingScenario(createScenario("versions-direct-offline"));
  let offline = true;
  scenario.on("GET", "/api/routing", () =>
    offline
      ? { status: 503, body: { code: "unavailable", error: "Router unavailable" } }
      : { body: scenario.state.routing },
  );

  await openApp(page, scenario, baseURL!);
  await page.goto("/#routing/history");
  await expect(marker(page, "routing-feedback")).toContainText("Check its connection");
  await expect(page.getByText("Loading configuration…")).toHaveCount(0);

  offline = false;
  await marker(page, "routing-retry").click();
  await expect(marker(page, "routing-panel")).toContainText("Open a saved configuration");
  await expect(page).toHaveURL(/#routing\/history$/);
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("a definitive refusal of an explicit retry finishes the operation and releases editing", async ({
  page,
  baseURL,
}) => {
  const scenario = routingScenario(createScenario("refused-retry"));
  const submissions: { operation_id: string; preview_id: string }[] = [];
  scenario.on("POST", "/api/routing/apply", (request) => {
    submissions.push(request.body);
    scenario.on("GET", "/api/routing/operations/" + request.body.operation_id, () => ({
      status: 404,
      body: { error: "Operation not found" },
    }));
    return submissions.length === 1
      ? { abort: true }
      : { status: 404, body: { code: "not_found", error: "Version not found" } };
  });

  await openApp(page, scenario, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();
  await marker(page, "operation-retry").click();
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "rejected");
  await expect(marker(page, "operation-retry")).toHaveCount(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(await page.evaluate(() => sessionStorage.getItem("xk_routing_operation"))).toBeNull();

  await marker(page, "operation-refresh").click();
  await expect(marker(page, "routing-add")).toBeEnabled();
  const id = submissions[0]!.operation_id;
  const journal = "/api/routing/operations/" + id;
  const previousReads = scenario.count("GET", journal);
  await page.evaluate((id) => {
    location.hash = "#routing/operation/" + id;
  }, id);
  await expect.poll(() => scenario.count("GET", journal)).toBeGreaterThan(previousReads);
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "rejected");
  await marker(page, "panel-close").click();
  await page.clock.runFor(5000);
  await expect(marker(page, "routing-reorder")).toBeEnabled();
  expect(submissions).toHaveLength(2);
});

test("a held POST cannot block a new review or navigate away when its old reply arrives", async ({
  page,
  baseURL,
}) => {
  const scenario = routingScenario(createScenario("late-apply-after-new-review"));
  let operationId = "";
  scenario.on("POST", "/api/routing/apply", (request) => {
    operationId = request.body.operation_id;
    scenario.on("GET", "/api/routing/operations/" + operationId, () => ({
      body: { id: operationId, kind: "routing", phase: "rolled_back" },
    }));
    return { hold: "apply", body: { id: operationId, kind: "routing", phase: "accepted" } };
  });

  await openApp(page, scenario, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();
  await expect.poll(() => operationId).not.toBe("");
  await page.clock.runFor(1600);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("xk_routing_operation"))).toBeNull();
  // The shared toast occupies the mobile footer until its six-second timeout.
  await page.clock.runFor(6500);
  await marker(page, "panel-close").click();
  await marker(page, "draft-review").click();
  await expect.poll(() => scenario.count("POST", "/api/routing/preview")).toBe(2);
  await expect(marker(page, "review-apply")).toBeEnabled();

  const oldReply = page.waitForResponse((response) => response.url().endsWith("/api/routing/apply"));
  await scenario.release("apply");
  await (await oldReply).finished();
  await page.clock.runFor(1600);
  await expect(page).toHaveURL(/#routing\/preview$/);
  await expect(marker(page, "review-apply")).toBeEnabled();
  expect(scenario.count("POST", "/api/routing/apply")).toBe(1);
});

test("direct hash navigation still asks before discarding edits without the Navigation API", async ({
  page,
  baseURL,
}) => {
  const scenario = routingScenario(createScenario("dirty-external-fragment"));
  await page.addInitScript(() => {
    Object.defineProperty(window, "navigation", { configurable: true, value: undefined });
  });
  await openApp(page, scenario, baseURL!);
  await page.evaluate(() => {
    history.replaceState({ ...history.state, xkSettingsOwner: "owner", unrelated: 27 }, "");
  });
  await marker(page, "nav-routing").click();
  await marker(page, "routing-add").click();
  await marker(page, "rule-name").fill("Local change");

  const attemptNavigation = () => page.evaluate(() => {
    location.hash = "#routing/history";
  });
  await attemptNavigation();
  await expect(marker(page, "routing-confirm")).toBeVisible();
  await expect(page).toHaveURL(/#routing\/group\/new$/);
  await marker(page, "keep-editing").click();
  await expect(marker(page, "rule-name")).toHaveValue("Local change");
  expect(await page.evaluate(() => history.state)).toMatchObject({ xkSettingsOwner: "owner", unrelated: 27 });

  await attemptNavigation();
  await marker(page, "confirm-discard").click();
  await expect(page).toHaveURL(/#routing\/history$/);
  await expect(marker(page, "routing-panel")).toContainText("Open a saved configuration");
  expect(await page.evaluate(() => sessionStorage.getItem("xk_routing_form_v1"))).toBeNull();
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("versions and journal keep the operation kind and both locations of a Main chain", async ({
  page,
  baseURL,
}) => {
  const scenario = routingScenario(createScenario("mixed-routing-history"));
  const main = {
    id: "10000000-1111-4111-8111-000000000001",
    kind: "main",
    phase: "committed",
    message: "Startup verified",
    target_code: "fi",
    target_name: "Helsinki",
    target_entry_code: "se",
    target_route: { mode: "chain", entry_code: "se", entry_name: "Stockholm", exit_code: "fi", exit_name: "Helsinki" },
  };
  const device = { id: "10000000-1111-4111-8111-000000000002", kind: "device-location", phase: "committed" };
  const routing = { id: "10000000-1111-4111-8111-000000000003", kind: "routing", phase: "committed" };
  scenario.on("GET", "/api/routing/history", () => ({
    body: { snapshots: [], operations: [main, device, routing] },
  }));
  scenario.on("GET", "/api/routing/operations/" + main.id, () => ({ body: main }));

  await openApp(page, scenario, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "routing-versions").click();
  const mainRecord = marker(page, "history-operation-" + main.id);
  await expect(mainRecord).toContainText("Main switched");
  await expect(marker(page, "history-operation-" + device.id)).toContainText("Device location applied");
  await expect(marker(page, "history-operation-" + routing.id)).toContainText("Routing applied");

  await mainRecord.click();
  const progress = marker(page, "routing-operation-status");
  await expect(progress).toContainText("Stockholm → Helsinki");
  await expect(progress).toContainText(main.message);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("xk_notifications") ?? "[]"))).toEqual([]);
});

test("reloading a review without its staged candidate asks for a fresh review once", async ({
  page,
  baseURL,
}) => {
  const scenario = routingScenario(createScenario("missing-local-preview"));
  await openApp(page, scenario, baseURL!);
  await page.goto("/#routing/preview");
  await expect(page).toHaveURL(/#routing$/);
  await expect(marker(page, "draft-review")).toBeVisible();
  const messages = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("xk_notifications") ?? "[]").map((item: { message: string }) => item.message),
  );
  expect(messages).toEqual(["Review the current changes again before applying."]);
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

test("closing an inline rule restores list position and opening respects motion preferences", async ({
  page,
  baseURL,
  isMobile,
}) => {
  const scenario = createScenario("inline-rule-position");
  const first = scenario.state.routing.model.groups[0];
  scenario.state.routing.model.groups = Array.from({ length: 36 }, (_, index) => ({
    ...first,
    id: "rule-" + index,
    title: "Rule number " + index,
  }));
  await page.addInitScript(() => {
    const nativeAnimate = Element.prototype.animate;
    window.recordedRuleAnimations = [];
    Element.prototype.animate = function (keyframes, options) {
      const animation = nativeAnimate.call(this, keyframes, options);
      if (this.matches('[data-marker="routing-rule-editor"]')) {
        const frames = (animation.effect as KeyframeEffect).getKeyframes();
        window.recordedRuleAnimations.push({
          duration: Number(animation.effect?.getTiming().duration),
          expands: frames.some((frame) => typeof frame.height === "string"),
        });
      }
      return animation;
    };
  });
  const motionSamples = () => page.evaluate(() => window.recordedRuleAnimations);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openApp(page, scenario, baseURL!);
  await marker(page, "nav-routing").click();
  const row = marker(page, "rule-rule-20");
  await row.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const origin = await page.evaluate(() => window.scrollY);
  expect(origin).toBeGreaterThan(200);
  await row.click();
  await expect(marker(page, "routing-rule-editor")).toBeVisible();
  await expect.poll(async () => (await motionSamples()).at(-1)).toEqual({ duration: 240, expands: !isMobile });
  await marker(page, "rule-cancel").click();
  await expect(row).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(origin);
  const count = (await motionSamples()).length;

  await page.emulateMedia({ reducedMotion: "reduce" });
  await row.click();
  await expect(marker(page, "routing-rule-editor")).toBeVisible();
  expect(await motionSamples()).toHaveLength(count);
  await marker(page, "rule-cancel").click();
  await expect(row).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(origin);
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
});

for (const action of ["delete", "save"] as const) {
  test(`rule editor footer names the ${action} in progress without a second spinner`, async ({ page, baseURL }) => {
    const scenario = createScenario("routing-editor-" + action);
    const rule = scenario.state.routing.model.groups[0];
    scenario.on("PUT", "/api/routing/draft", (request) => {
      const draft = {
        base_hash: request.body.base_hash,
        revision: "33333333-3333-4333-8333-333333333333",
        model: request.body.model,
        validation: [],
      };
      scenario.state.routing.draft = draft;
      return { body: draft, hold: "draft" };
    });
    await openApp(page, scenario, baseURL!);
    await marker(page, "nav-routing").click();
    await marker(page, "rule-" + rule.id).click();
    const save = marker(page, "routing-save-draft");
    const status = marker(page, "rule-save-status");
    await expect(status).toHaveText("No unsaved edits");
    // Phones keep the name and delete action inside collapsed rule details.
    if (!(await marker(page, "rule-name").isVisible())) await marker(page, "rule-details").click();
    if (action === "delete") {
      await marker(page, "rule-delete").click();
      await marker(page, "confirm-discard").click();
    } else {
      await marker(page, "rule-name").fill("Edited fixture rule");
      await save.click();
    }
    await expect.poll(() => scenario.count("PUT", "/api/routing/draft")).toBe(1);
    if (action === "delete") {
      await expect(status).toHaveText("Removing the rule from the draft");
      await expect(save).toHaveAttribute("aria-busy", "false");
      await expect(page.locator('[data-marker="routing-rule-editor"] .terminal-action-glyph')).toHaveCount(0);
    } else {
      await expect(status).toHaveText("");
      await expect(save).toHaveAttribute("aria-busy", "true");
      await expect(save.locator(".terminal-action-label")).toHaveText("saving");
      await expect(page.locator('[data-marker="routing-rule-editor"] .terminal-action-glyph')).toHaveCount(1);
    }
    await scenario.release("draft");
    await expect(marker(page, "routing-rule-editor")).toHaveCount(0);
  });
}
