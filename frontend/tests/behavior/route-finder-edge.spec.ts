import { test, expect } from "../support/test";
import { createScenario, marker, NOW, openApp } from "../support/scenario";

const resultId = "2c1955a1-3c30-4b20-bcff-5c4de2d4802c";
type Location = { code: string; name: string };

function finderScenario(singleCodes = ["fi", "de", "se"]) {
  const s = createScenario("route-finder-edge");
  const sites = s.state.connectivity.config.check_urls.join(",");
  s.state.status.route_check_conditions_hash = sites;
  const completed = { id: resultId, kind: "single", exit_name: null, exit_code: null, state: "completed",
    total: singleCodes.length, done: singleCodes.length, working: Number(singleCodes.includes("de")),
    created_at: "2026-11-17T08:59:00Z", finished_at: NOW, conditions_hash: sites };
  s.state.status.route_check_run = completed;
  function view(kind: string, exit?: string) {
    const locations = s.state.status.available as Location[];
    const latest = s.state.status.route_check_run;
    const active = latest?.state === "running" ? latest : null;
    const targets = s.state.connectivity.config.check_urls;
    const conditions = { hash: targets.join(","), rounds: 2, targets, timeout_sec: 5 };
    const stale = sites !== conditions.hash;
    const single = (loc: Location) => {
      const checked = singleCodes.includes(loc.code);
      const outcome = checked ? loc.code === "de" ? "working" : "failed" : null;
      return { key: loc.code, mode: "single", exit_code: loc.code, exit_name: loc.name,
        entry_code: null, entry_name: null, state: checked && stale ? "stale" : outcome ?? "unchecked", outcome, run_id: checked ? resultId : null,
        applicable: !stale && outcome === "working", on_main: loc.code === "fi",
        stale_kind: checked && stale ? "conditions" : null, stale_reason: checked && stale ? "Test sites or check settings changed since the check" : null,
        reason: null, checked_at: checked ? NOW : null, fresh_until: checked ? "2026-11-17T09:10:00Z" : null, rounds: [], last_attempt: null };
    };
    const base = { kind, conditions, fresh_sec: 600, active_run: active };
    if (kind === "single") return { ...base, run: latest?.kind === "chain" ? completed : latest, routes: locations.map(single) };
    const target = locations.find(loc => loc.code === exit) ?? { code: exit!, name: exit! };
    return { ...base, exit_code: exit, direct: single(target), run: latest?.kind === "chain" && latest.exit_code === exit ? latest : null,
      routes: locations.filter(loc => loc.code !== exit).map(loc => ({
        key: loc.code, mode: "chain", exit_code: exit, exit_name: target.name, entry_code: loc.code,
        entry_name: loc.name, state: "unchecked", outcome: null, run_id: null, reason: null,
        checked_at: null, last_attempt: null, stale_reason: null, rounds: [], applicable: false, on_main: false,
        entry_reachable: stale || !singleCodes.includes(loc.code) ? null : loc.code === "de",
        entry_checked_at: singleCodes.includes(loc.code) ? NOW : null,
      })) };
  }
  s.on("GET", "/api/route-checks", ({query}) => ({body:view(query.kind!, query.exit)}));
  s.on("POST", "/api/route-checks", ({body}) => {
    s.state.status.route_check_run = { ...completed, id: body.run_id, state: "running", created_at: NOW,
      total: body.codes.length, done: 0, working: 0, finished_at: null };
    return {body:view("single")};
  });
  s.on("POST", "/api/route-checks/cancel", () => {
    Object.assign(s.state.status.route_check_run, { state: "cancelled", finished_at: NOW });
    return {body:view("single")};
  });
  s.on("PUT", "/api/connectivity", ({body}) => {
    if (s.state.status.route_check_run.state === "running") return {
      status:409, body:{code:"busy",error:"Route checks are running. Stop them or wait before changing test sites."},
    };
    s.state.connectivity.config.check_urls = body.check_urls;
    s.state.status.route_check_conditions_hash = body.check_urls.join(",");
    return {body:{ok:true,config:s.state.connectivity.config}};
  });
  return s;
}

test("Single keeps chosen locations in view and groups other results behind a disclosure", async ({ page, baseURL }) => {
  const s = finderScenario(["fi", "de"]);
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  const scope = marker(page, "route-finder-scope");
  await scope.click();
  await page.getByRole("option", {name: /Choose/}).click();
  await marker(page, "route-pick-fi").press("Space");
  await marker(page, "route-pick-done").click();
  const visible = page.getByRole("list", {name: "Single locations"});
  await expect(visible.getByRole("listitem")).toHaveCount(1);
  await expect(visible).toContainText("Finland");
  const other = marker(page, "route-other-locations");
  await expect(other).toHaveText("Other locations · 2");
  const germany = marker(page, "route-apply");
  await expect(germany).toBeHidden();
  await other.click();
  await expect(germany).toHaveAccessibleName(/Apply Germany/);
  await expect(germany).toBeEnabled();
  await expect(page.locator('[data-marker="route-row"][data-key="se"]')).toHaveAttribute("data-state", "unchecked");

  await scope.click();
  await page.getByRole("option", {name: "Needs checking"}).click();
  await expect(other).toHaveCount(0);
  await expect(visible.getByRole("listitem")).toHaveCount(3);
});

test("An unavailable recheck does not timestamp an older Working verdict as new", async ({ page, baseURL }) => {
  const s = finderScenario();
  const read = s.handlers.get("GET /api/route-checks")!;
  const attempt = { run_id: resultId, finished_at: NOW, reason: "Could not start route check" };
  let hasPrior = true;
  s.on("GET", "/api/route-checks", async request => {
    const response = await read(request);
    for (const row of response.body.routes) {
      if (hasPrior && row.exit_code === "de") {
        Object.assign(row, { checked_at: "2026-11-17T08:57:00Z", last_attempt: attempt });
      } else {
        Object.assign(row, { state: "unavailable", outcome: "unavailable", applicable: false,
          reason: attempt.reason, checked_at: NOW, last_attempt: attempt });
      }
    }
    return response;
  });
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  const report = marker(page, "route-finder-report");
  await expect(report).toHaveText("1 worked · 1/3 checked · 11:57");
  hasPrior = false;
  await page.clock.runFor(3010);
  await expect(report).toHaveText("Check unavailable");
});

test("Losing locations disables Chain, retains stop and returns focus to Locations", async ({ page, baseURL }) => {
  const s = finderScenario();
  const pair = s.state.status.available.slice(0, 2);
  s.state.status.available = pair;
  await openApp(page, s, baseURL!);
  const trigger = marker(page, "open-route-finder");
  await trigger.click();
  const finder = marker(page, "route-finder");
  const chain = marker(page, "route-finder-chain");
  await chain.click();
  s.state.status.available = pair.slice(0, 1);
  await page.clock.runFor(10010);
  await expect(chain).toHaveAttribute("aria-disabled", "true");
  await expect(marker(page, "route-finder-single")).toHaveAttribute("aria-pressed", "true");
  await expect(finder.getByRole("button", {name:/find chains to/i})).toHaveCount(0);
  await marker(page, "route-finder-check").click();
  await expect(marker(page, "route-finder-check")).toHaveAccessibleName(/stop/i);
  s.state.status.available = [];
  await page.clock.runFor(10010);
  await expect(trigger).toHaveCount(0);
  await expect(marker(page, "route-finder-check")).toBeEnabled();
  await marker(page, "route-finder-close").click();
  await expect(marker(page, "locations").getByRole("heading")).toBeFocused();
  await marker(page, "btn-activity").click();
  await expect(page.getByText(/Open Find a working route on Main for results/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  s.state.status.available = pair;
  await page.clock.runFor(10010);
  await trigger.click();
  await marker(page, "route-finder-check").click();
  await expect(marker(page, "route-finder-check")).not.toHaveAccessibleName(/stop/i);
  expect(s.count("POST", "/api/route-checks/cancel")).toBe(1);
  await marker(page, "route-finder-close").click();
  await trigger.focus();
  s.state.status.available = [];
  await page.clock.runFor(10010);
  await expect(marker(page, "locations").getByRole("heading")).toBeFocused();
});

test("Draft test sites survive closing and a concurrent check blocks saving until stop", async ({ page, browser, baseURL }) => {
  const s = finderScenario();
  const originalUrl = s.state.connectivity.config.check_urls[0];
  await openApp(page, s, baseURL!);
  const trigger = marker(page, "open-route-finder");
  const finder = marker(page, "route-finder");
  await trigger.click();
  await marker(page, "route-sites-edit").click();
  const input = marker(page, "connectivity-url-input").first();
  const url = "https://changed.example.invalid/test";
  await input.fill(url);
  const check = marker(page, "route-finder-check");
  await expect(check).toBeDisabled();
  await expect(check).toHaveAccessibleDescription(/Save or cancel test sites first/);
  await marker(page, "route-finder-chain").click();
  await expect(check).toBeDisabled();
  const others = finder.locator("summary").filter({hasText:/Other entries/i});
  await others.click();
  const skipped = finder.getByRole("button", {name:/check these/i});
  await expect(skipped).toBeDisabled();
  await expect(skipped).toHaveAccessibleDescription(/Save or cancel test sites first/);
  await marker(page, "route-finder-close").click();
  await marker(page, "nav-routing").click();
  await expect(marker(page, "routing-add")).toBeVisible();
  await page.goBack();
  await trigger.click();
  await expect(input).toHaveValue(url);
  const other = await browser.newContext({baseURL});
  try {
    const b = await other.newPage();
    await openApp(b, s, baseURL!);
    await marker(b, "open-route-finder").click();
    await marker(b, "route-finder-check").click();
    await expect(marker(b, "route-finder-check")).toHaveAccessibleName(/stop/i);
    await marker(page, "route-sites-save").click();
    await expect(finder.getByRole("alert")).toContainText("Route checks are running.");
    await expect(input).toHaveValue(url);
    await marker(b, "route-finder-check").click();
    await expect(marker(b, "route-finder-check")).not.toHaveAccessibleName(/stop/i);
  } finally { await other.close(); }
  await marker(page, "route-sites-save").click();
  await expect(marker(page, "route-finder-sites")).toContainText("changed.example.invalid");
  await marker(page, "route-finder-scope").click();
  await expect(finder.getByRole("option", { name: "Reachable directly" })).toContainText("recheck Single");
  await page.keyboard.press("Escape");
  await marker(page, "route-finder-close").click();
  if (!await marker(page, "btn-edit-route-check").isVisible()) await marker(page, "mobile-connection-details").click();
  await marker(page, "btn-edit-route-check").click();
  await expect(marker(page, "connectivity-url-input").first()).toHaveValue(url);
  expect(s.count("PUT", "/api/connectivity")).toBe(2);
  await page.clock.runFor(6500); // Let the sheet save notification leave the mobile drawer footer.
  await marker(page, "connectivity-url-input").first().fill(originalUrl);
  await marker(page, "settings-save").click();
  await expect.poll(() => s.count("PUT", "/api/connectivity")).toBe(3);
  await marker(page, "btn-drawer-close").click();
  await trigger.click();
  await expect(marker(page, "route-finder-scope")).toHaveAccessibleName(/Reachable directly/);
  await marker(page, "route-finder-single").click();
  await expect(finder.getByRole("button", {name:/Apply Germany.*to Main/})).toBeEnabled();
});

test("Opening before the status poll follows an active Chain and retains stop as entries disappear", async ({page, baseURL}) => {
  const s = finderScenario();
  s.state.status.route_check_run = null;
  const read = s.handlers.get("GET /api/route-checks")!;
  const active = {id:"11111111-1111-4111-8111-111111111111", kind:"chain", exit_code:"de",
    exit_name:"Germany 🇩🇪", state:"running", created_at:NOW, finished_at:null, total:2, done:0, working:0};
  s.on("GET", "/api/route-checks", async request => {
    const view = await read(request);
    return {body:{...view.body, active_run:active}};
  });
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  await expect(marker(page, "route-finder-chain")).toHaveAttribute("aria-pressed", "true");
  await expect(marker(page, "route-finder-exit")).toContainText("Germany");
  await expect(marker(page, "route-finder-check")).toHaveAccessibleName(/stop/i);
  await marker(page, "route-finder-single").click();
  await expect(marker(page, "route-finder-single")).toHaveAttribute("aria-pressed", "true");
  s.state.status.route_check_run = active;
  s.state.status.available = s.state.status.available.filter((loc: Location) => loc.code === "de");
  await page.clock.runFor(10010);
  await expect(marker(page, "route-finder-chain")).toHaveAttribute("aria-disabled", "true");
  await expect(marker(page, "route-finder-chain")).toHaveAttribute("aria-pressed", "true");
  await expect(marker(page, "route-finder-check")).toHaveAccessibleName(/stop/i);
});

test("Remote test sites changes refresh an open Settings form without overwriting a draft", async ({page, baseURL}) => {
  const s = finderScenario();
  await openApp(page, s, baseURL!);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-checks").click();
  const field = marker(page, "connectivity-url-input").first();
  await expect(field).toHaveValue(s.state.connectivity.config.check_urls[0]);
  const remoteUrl = "https://other.example.invalid/health";
  s.state.connectivity.config.check_urls = [remoteUrl];
  s.state.status.route_check_conditions_hash = remoteUrl;
  await page.clock.runFor(10010);
  await expect(field).toHaveValue(remoteUrl);
  await field.fill("https://local.example.invalid/draft");
  s.state.connectivity.config.check_urls = ["https://changed-again.example.invalid"];
  s.state.status.route_check_conditions_hash = "another-change";
  await page.clock.runFor(10010);
  await expect(field).toHaveValue("https://local.example.invalid/draft");
});

test("Reopening the finder keeps a pending test sites save locked", async ({ page, baseURL }) => {
  const s = finderScenario();
  s.on("PUT", "/api/connectivity", ({ body }) => {
    s.state.connectivity.config.check_urls = body.check_urls;
    return { hold: "save-sites", body: { ok: true, config: s.state.connectivity.config } };
  });
  await openApp(page, s, baseURL!);
  const trigger = marker(page, "open-route-finder");
  await trigger.click();
  await marker(page, "route-sites-edit").click();
  const input = marker(page, "connectivity-url-input").first();
  await input.fill("https://saving.example/");
  await marker(page, "route-sites-save").click();
  await expect.poll(() => s.count("PUT", "/api/connectivity")).toBe(1);
  await marker(page, "route-finder-close").click();
  await trigger.click();
  await expect(input).toBeDisabled();
  await expect(marker(page, "route-sites-save")).toBeDisabled();
  await s.release("save-sites");
  await expect(marker(page, "route-sites-edit")).toBeVisible();
});

test("Checking only the exit leaves every untested entry available in Chain", async ({ page, baseURL }) => {
  const s = finderScenario(["fi"]);
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  await page.getByRole("button", { name: /Find chains to Finland/ }).click();
  const scope = marker(page, "route-finder-scope");
  await expect(scope).toContainText("All locations · 2");
  await expect(marker(page, "route-finder-check")).toBeEnabled();
  await scope.click();
  const reachable = page.getByRole("option", { name: /Reachable directly/ });
  await expect(reachable).toBeDisabled();
  await expect(reachable).toContainText("check Single first");
});

test("The active Chain exit temporarily overrides the browser's selected exit", async ({ page, baseURL }) => {
  const s = finderScenario();
  await openApp(page, s, baseURL!);
  const trigger = marker(page, "open-route-finder");
  const exit = marker(page, "route-finder-exit");
  await trigger.click();
  await marker(page, "route-finder-chain").click();
  await exit.click();
  await page.getByRole("option", { name: /Sweden/ }).click();
  await marker(page, "route-finder-close").click();
  const foreignRun = { id: "11111111-1111-4111-8111-111111111111", kind: "chain", exit_code: "de",
    exit_name: "Germany 🇩🇪", state: "running", created_at: NOW, finished_at: null, total: 2, done: 0, working: 0 };
  s.state.status.route_check_run = foreignRun;
  await trigger.click();
  await expect(exit).toContainText("Germany");
  await expect(exit).toBeDisabled();
  s.state.status.route_check_run = { ...foreignRun, state: "completed", finished_at: NOW, done: 2 };
  await page.clock.runFor(10010);
  await expect(exit).toBeEnabled();
  await expect(exit).toContainText("Sweden");
  await marker(page, "route-finder-close").click();
  await trigger.click();
  await expect(exit).toContainText("Sweden");
});

test("A background chain keeps Single details open and shortcuts bound to the shown exit", async ({page, baseURL}) => {
  const s = finderScenario();
  await page.addInitScript(() => localStorage.setItem("xk_route_finder", JSON.stringify({ single: "chosen", codes: ["de"] })));
  await openApp(page, s, baseURL!);
  await marker(page, "open-route-finder").click();
  await marker(page, "route-other-locations").click();
  const row = page.locator('[data-marker="route-row"][data-exit="fi"]');
  const verdict = row.getByRole("button", { name: /Failed.*details/ });
  await verdict.focus();
  await verdict.press("Enter");
  const run = { id: "11111111-1111-4111-8111-111111111111", kind: "chain", exit_code: "se",
    exit_name: "Sweden 🇸🇪", state: "running", created_at: NOW, finished_at: null, total: 2, done: 0, working: 0 };
  s.state.status.route_check_run = run;
  await page.clock.runFor(10010);
  await expect(marker(page, "route-show-running")).toBeVisible();
  await expect(verdict).toBeFocused();
  await expect(row.locator('[data-marker="route-row-details"]')).toBeVisible();
  const toFinland = row.getByRole("button", { name: /Find chains to Finland/ });
  await expect(toFinland).toBeDisabled();
  await toFinland.press("Enter");
  await expect(marker(page, "route-finder-single")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Find chains to Sweden/ })).toBeEnabled();
  s.state.status.route_check_run = { ...run, state: "completed", done: 2, finished_at: NOW };
  await page.clock.runFor(10010);
  await toFinland.click();
  await expect(marker(page, "route-finder-exit")).toContainText("Finland");
});
