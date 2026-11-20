import { readFile } from "node:fs/promises";
import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";
import { restoreScenario, routingScenario } from "../../support/routing";
import type { RoutingGroup } from "../../../src/api/types";

test("dirty Back and Forward roll back before unmount and preserve unrelated history state", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("routing-history-guard");
  await openApp(page, scenario, baseURL!);
  await page.evaluate(() =>
    history.replaceState({ ...history.state, xkSettingsOwner: "existing owner", extra: 27 }, ""),
  );
  await marker(page, "nav-routing").click();
  await marker(page, "routing-add").click();
  await marker(page, "rule-name").fill("Guarded form");
  const editor = await marker(page, "rule-name").elementHandle();
  await page.evaluate(() => history.back());
  await expect(marker(page, "routing-confirm")).toBeVisible();
  await marker(page, "keep-editing").click();
  expect(await editor!.evaluate((node) => node.isConnected)).toBe(true);
  await page.evaluate(() => history.back());
  await marker(page, "confirm-discard").click();
  await expect(page).toHaveURL(/#routing$/);
  expect(await page.evaluate(() => history.state)).toMatchObject({
    extra: 27,
    xkSettingsOwner: "existing owner",
  });
  await marker(page, "routing-reorder").click();
  const group = scenario.state.routing.model.groups[0];
  await marker(page, "move-" + group.id + "-down").click();
  await page.evaluate(() => history.forward());
  await expect(marker(page, "routing-confirm")).toBeVisible();
  await marker(page, "confirm-discard").click();
  await expect(marker(page, "rule-name")).toHaveValue("");
  expect(scenario.requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(await page.evaluate(() => history.state)).toMatchObject({
    extra: 27,
    xkSettingsOwner: "existing owner",
  });
});

test("older scratch pauses saving, exports unfinished text and reloads the latest revision", async ({
  page,
  baseURL,
}) => {
  const s = routingScenario(createScenario("routing-scratch-conflict"));
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "routing-add").click();
  await marker(page, "rule-name").fill("Unfinished change");
  const revision = s.state.routing.draft.revision;
  s.state.routing.draft.revision = "99999999-9999-4999-8999-999999999999";
  await page.reload();
  await expect(marker(page, "routing-save-draft")).toBeDisabled();
  await expect(marker(page, "rule-name")).toHaveValue("Unfinished change");
  const download = page.waitForEvent("download");
  await marker(page, "routing-download-local").click();
  const value = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(value.unfinished_form).toMatchObject({ revision, rule: { title: "Unfinished change" } });
  await marker(page, "routing-reload-latest").click();
  await marker(page, "confirm-discard").click();
  await expect(page).toHaveURL(/#routing$/);
  expect(await page.evaluate(() => sessionStorage.getItem("xk_routing_form_v1"))).toBeNull();
  expect(s.count("PUT", "/api/routing/draft")).toBe(0);
});

test("custom positions constrain edits and reorder; default moves and saves with CAS", async ({
  page,
  baseURL,
}) => {
  const s = createScenario("routing-order");
  const groups: RoutingGroup[] = s.state.routing.model.groups;
  const custom = groups[2]!;
  custom.editable = false;
  custom.action = "custom";
  custom.rule = { balancerTag: "untouched" };
  let submitted: RoutingGroup[] = [];
  s.on("PUT", "/api/routing/draft", (req) => {
    expect(req.body.expected_revision).toBeNull();
    expect(req.body.base_hash).toBe(s.state.routing.current.sha256);
    submitted = req.body.model.groups;
    const draft = {
      base_hash: req.body.base_hash,
      revision: "33333333-3333-4333-8333-333333333333",
      model: req.body.model,
      validation: [],
    };
    s.state.routing.draft = draft;
    return { body: draft };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "rule-" + custom.id).click();
  await expect(page.locator(".raw-preview")).toContainText("untouched");
  await expect(marker(page, "rule-delete")).toHaveCount(0);
  await marker(page, "rule-cancel").click();
  await marker(page, "routing-reorder").click();
  await expect(marker(page, "move-" + groups[1]!.id + "-down")).toBeDisabled();
  const last = groups.at(-1)!;
  await marker(page, "move-" + last.id + "-up").click();
  await expect(marker(page, "order-status")).toContainText(last.title);
  await marker(page, "order-save").click();
  await expect.poll(() => submitted.length).toBe(groups.length);
  expect(submitted[2]).toEqual(custom);
  expect(submitted.at(-2)).toEqual(last);
});

test("interleaved matchers retain order and literal text when editing a field", async ({ page, baseURL }) => {
  const s = createScenario("routing-matcher-order");
  const rule = s.state.routing.model.groups[0];
  rule.matchers = [
    { type: "domain-regexp", value: "  first$  " },
    { type: "port", value: "80,443" },
    { type: "domain-regexp", value: "second$" },
  ];
  let saved: RoutingGroup | undefined;
  s.on("PUT", "/api/routing/draft", (req) => {
    saved = req.body.model.groups[0];
    return {
      body: {
        revision: "33333333-3333-4333-8333-333333333333",
        model: req.body.model,
        base_hash: req.body.base_hash,
        validation: [],
      },
    };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "rule-" + rule.id).click();
  await marker(page, "condition-0").fill("  first$  \n changed$ \n extra$ ");
  await marker(page, "routing-save-draft").click();
  await expect
    .poll(() => saved?.matchers)
    .toEqual([
      rule.matchers[0],
      rule.matchers[1],
      { type: "domain-regexp", value: " changed$ " },
      { type: "domain-regexp", value: " extra$ " },
    ]);
});

test("unconfirmed apply completes on Main while POST is held; revisiting history stays silent", async ({
  page,
  baseURL,
}) => {
  const s = routingScenario(createScenario("routing-operation-across-navigation"));
  let id = "";
  let phase = "accepted";
  s.on("POST", "/api/routing/apply", (req) => {
    id = req.body.operation_id;
    s.on("GET", "/api/routing/operations/" + id, () => ({ body: { id, kind: "routing", phase } }));
    return { hold: "apply", body: { id, kind: "routing", phase: "accepted" } };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();
  await expect.poll(() => id).not.toBe("");
  await marker(page, "breadcrumb-home").click();
  await expect(marker(page, "active-name")).toBeVisible();
  phase = "verifying";
  await page.clock.runFor(1600);
  await expect.poll(() => s.count("GET", "/api/routing/operations/" + id)).toBeGreaterThan(0);
  await expect(page.locator('[data-marker="loc-select"]').first()).toBeDisabled();
  phase = "committed";
  await page.clock.runFor(1600);
  const notifications = () =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("xk_notifications") ?? "[]").map(
        (item: { message: string }) => item.message,
      ),
    );
  await expect.poll(notifications).toEqual(["Routing configuration applied"]);
  await s.release("apply");
  await page.goto("/#routing/operation/" + id);
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "committed");
  expect(await notifications()).toEqual(["Routing configuration applied"]);
  expect(await page.evaluate(() => sessionStorage.getItem("xk_routing_operation"))).toBeNull();
  expect(s.count("POST", "/api/routing/apply")).toBe(1);
});

test("opening foreign terminal history does not claim an outcome", async ({ page, baseURL }) => {
  const s = restoreScenario(createScenario("routing-foreign"));
  const id = s.state.routing.operations[0].id;
  s.on("GET", "/api/routing/operations/" + id, () => ({ body: s.state.routing.operations[0] }));
  await openApp(page, s, baseURL!);
  await page.goto("/#routing/operation/" + id);
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "committed");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("xk_notifications") ?? "[]"))).toEqual([]);
});

test("drift resolution exports then discards the exact revision before reimport", async ({
  page,
  baseURL,
}) => {
  const s = routingScenario(createScenario("routing-reimport"));
  const routing = s.state.routing;
  routing.drift = true;
  const revision = routing.draft.revision;
  s.on("DELETE", "/api/routing/draft", (req) => {
    expect(req.body).toEqual({ expected_revision: revision });
    routing.draft = null;
    return { body: { ok: true } };
  });
  s.on("POST", "/api/routing/reimport", (req) => {
    expect(routing.draft).toBeNull();
    expect(req.body).toEqual({
      expected_current_hash: routing.current.sha256,
      observed_hash: routing.observed_hash,
    });
    routing.drift = false;
    return { body: routing };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "resolve-conflict").click();
  const download = page.waitForEvent("download");
  await marker(page, "conflict-download").click();
  expect(JSON.parse(await readFile((await (await download).path())!, "utf8")).model).toEqual(
    routing.draft.model,
  );
  await marker(page, "conflict-reload").click();
  await marker(page, "confirm-discard").click();
  await expect(marker(page, "routing-add")).toBeEnabled();
  expect(s.count("POST", "/api/routing/reimport")).toBe(1);
});

test("multi-entry Back to Main retains the original entries after discard", async ({ page, baseURL }) => {
  const s = createScenario("routing-back-to-main");
  await openApp(page, s, baseURL!);
  await page.evaluate(() => history.replaceState({ mainEntry: true, xkSettingsOwner: "existing" }, ""));
  await marker(page, "nav-routing").click();
  await marker(page, "routing-add").click();
  await marker(page, "rule-name").fill("Local");
  await page.evaluate(() => history.go(-2));
  await marker(page, "keep-editing").click();
  await expect(marker(page, "rule-name")).toHaveValue("Local");
  await page.evaluate(() => history.go(-2));
  await marker(page, "confirm-discard").click();
  await expect(marker(page, "active-name")).toBeVisible();
  expect(await page.evaluate(() => history.state)).toMatchObject({
    mainEntry: true,
    xkSettingsOwner: "existing",
  });
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/#routing$/);
});

test("accepted, verifying and committed observations use one operation and one completion", async ({
  page,
  baseURL,
}) => {
  const s = routingScenario(createScenario("routing-phase-forwarding"));
  let phase = "accepted";
  s.on("POST", "/api/routing/apply", (req) => {
    const id = req.body.operation_id;
    s.on("GET", "/api/routing/operations/" + id, () => ({ body: { id, kind: "routing", phase } }));
    return { body: { id, kind: "routing", phase } };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "accepted");
  for (const next of ["verifying", "committed"]) {
    phase = next;
    await page.clock.runFor(1600);
    await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", next);
  }
  await page.reload();
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "committed");
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem("xk_notifications") ?? "[]"));
  expect(items.map((item: { message: string }) => item.message)).toEqual(["Routing configuration applied"]);
});

for (const own of [true, false])
  test(
    "terminal on initial recovery retains consumed ownership: " + (own ? "own" : "already consumed"),
    async ({ page, baseURL }) => {
      const s = restoreScenario(createScenario("routing-recovery"));
      const op = s.state.routing.operations[0];
      s.on("GET", "/api/routing/operations/" + op.id, () => ({ body: op }));
      await page.addInitScript(
        ({ op, own }) => {
          sessionStorage.setItem(
            "xk_routing_operation",
            JSON.stringify({ operation_id: op.id, preview_id: op.preview_id }),
          );
          sessionStorage.setItem("xk_own_operations", JSON.stringify(own ? [op.id] : []));
        },
        { op, own },
      );
      await openApp(page, s, baseURL!);
      await marker(page, "nav-routing").click();
      await page.clock.runFor(1600);
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("xk_routing_operation"))).toBeNull();
      const messages = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("xk_notifications") ?? "[]").map(
          (item: { message: string }) => item.message,
        ),
      );
      expect(messages).toEqual(own ? ["Routing configuration applied"] : []);
    },
  );

test("filter and validation retain the rule; unchanged polls and breakpoint changes retain focus", async ({
  page,
  baseURL,
}) => {
  const s = createScenario("routing-filter-focus");
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "routing-search").fill("appcenter");
  await expect(marker(page, "routing-group")).toHaveCount(1);
  await marker(page, "routing-search").fill("nothing matches this");
  await expect(page.locator(".empty-list")).toBeVisible();
  await marker(page, "routing-add").click();
  await marker(page, "rule-name").fill("Invalid host");
  await marker(page, "condition-0").fill("https://invalid.example/");
  await marker(page, "routing-save-draft").click();
  await expect(marker(page, "condition-0")).toBeFocused();
  await expect(marker(page, "condition-0")).toHaveAttribute("aria-invalid", "true");
  const field = await marker(page, "condition-0").elementHandle();
  await field!.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(1, 4));
  await page.setViewportSize({ width: 719, height: 844 });
  await page.clock.runFor(31000);
  await expect(marker(page, "condition-0")).toBeFocused();
  expect(
    await field!.evaluate((node) => [
      node.isConnected,
      (node as HTMLTextAreaElement).selectionStart,
      (node as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([true, 1, 4]);
  s.state.routing.current.sha256 = "a".repeat(64);
  await page.clock.runFor(31000);
  await expect(marker(page, "routing-reload-latest")).toBeVisible();
  await expect(marker(page, "routing-save-draft")).toBeDisabled();
  expect(s.count("PUT", "/api/routing/draft")).toBe(0);
});

test("revision refusal keeps the edited form and never overwrites a competing draft", async ({
  page,
  baseURL,
}) => {
  const s = routingScenario(createScenario("routing-save-conflict"));
  const group = s.state.routing.draft.model.groups.find((r: RoutingGroup) => r.editable && !r.default_rule);
  s.on("PUT", "/api/routing/draft", (req) => {
    expect(req.body.expected_revision).toBe(s.state.routing.draft.revision);
    return { status: 409, body: { code: "draft_conflict", error: "Draft changed" } };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "rule-" + group.id).click();
  const name = marker(page, "rule-name");
  if (!(await name.isVisible())) await marker(page, "rule-details").click();
  await name.fill("My concurrent edit");
  await marker(page, "routing-save-draft").click();
  await expect(marker(page, "routing-download-local")).toBeVisible();
  await expect(marker(page, "routing-save-draft")).toBeDisabled();
  await expect(name).toHaveValue("My concurrent edit");
  await page.clock.runFor(31000);
  expect(s.count("PUT", "/api/routing/draft")).toBe(1);
});

test("busy leaves the reviewed preview available for a later manual apply", async ({ page, baseURL }) => {
  const s = routingScenario(createScenario("routing-busy-retention"));
  const bodies: { preview_id: string; operation_id: string }[] = [];
  s.on("POST", "/api/routing/apply", (req) => {
    bodies.push(req.body);
    if (bodies.length === 1) return { status: 409, body: { code: "busy", error: "Router busy" } };
    const op = { id: req.body.operation_id, kind: "routing", phase: "committed" };
    s.on("GET", "/api/routing/operations/" + op.id, () => ({ body: op }));
    return { body: op };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();
  await expect(marker(page, "panel-feedback")).toContainText("busy");
  await marker(page, "review-apply").click();
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "committed");
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.preview_id).toBe(bodies[0]!.preview_id);
  expect(bodies[1]!.operation_id).not.toBe(bodies[0]!.operation_id);
  expect(s.count("POST", "/api/routing/preview")).toBe(1);
  const messages = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("xk_notifications") ?? "[]").map(
      (item: { message: string }) => item.message,
    ),
  );
  expect(messages).toEqual(["Routing configuration applied"]);
});

test("retry disappears if the server finds the original request after a 404", async ({ page, baseURL }) => {
  const s = routingScenario(createScenario("routing-late-acceptance"));
  let received = false;
  s.on("POST", "/api/routing/apply", (req) => {
    const id = req.body.operation_id;
    s.on("GET", "/api/routing/operations/" + id, () =>
      received
        ? { body: { id, kind: "routing", phase: "verifying" } }
        : { status: 404, body: { error: "Not found" } },
    );
    return { abort: true };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "nav-routing").click();
  await marker(page, "draft-review").click();
  await marker(page, "review-apply").click();
  await expect(marker(page, "operation-retry")).toBeVisible();
  received = true;
  await page.clock.runFor(1600);
  await expect(marker(page, "routing-operation-status")).toHaveAttribute("data-phase", "verifying");
  await expect(marker(page, "operation-retry")).toHaveCount(0);
  expect(s.count("POST", "/api/routing/apply")).toBe(1);
});
