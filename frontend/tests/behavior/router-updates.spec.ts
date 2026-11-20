import { test, expect } from "../support/test";
import { createScenario, openApp, marker, NOW } from "../support/scenario";

const api = "/api/router-updates";
const titles = { xkeen: "2.1", xray: "26.11.9" };
function routerUpdates() {
  const s = createScenario("router-updates");
  const releases = (versions: string[]) => versions.map(version => ({ version, supported: true, reason: null }));
  const data = {
    components: {
      xkeen: { installed: "2.0", releases: releases(["2.1"]), held: null, rollback: [], schedule: null },
      xray: { installed: "26.3.27", releases: releases(["26.11.9", "26.10.31"]), held: null,
        rollback: [], schedule: null },
    },
    automatic: { xkeen: false, xray: false, time: "03:00" }, operation: null, history: [], pair: null,
    rollback_revision: "a".repeat(64), checked_at: NOW, catalog_error: null, router_error: null,
    ssh_command: "ssh -t -p 2222 root@router /opt/bin/xk-update-recovery",
    available: Object.entries(titles).map(([component, version]) => ({ component, version })), next_auto_at: null,
  };
  s.state.updates = data;
  s.state.status.router_updates = { available: data.available };
  s.on("GET", api, () => ({ body: s.state.updates }));
  return s;
}

test("closed update notices follow individual releases; settings always opens", async ({ page, baseURL }) => {
  const s = routerUpdates();
  await openApp(page, s, baseURL!);
  await expect(marker(page, "router-update-notice")).toContainText("XKeen 2.1 · Xray 26.11.9");
  await page.evaluate(() => window.scrollTo(0, 220));
  const top = await marker(page, "router-update-notice").evaluate(el => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(70);
  await marker(page, "router-updates-dismiss").click();
  s.state.status.router_updates.available = [{ component: "xray", version: "26.11.9" }];
  await page.reload();
  await expect(marker(page, "btn-settings")).toBeVisible();
  await expect(marker(page, "router-update-notice")).toHaveCount(0);
  await marker(page, "btn-settings").click();
  await marker(page, "settings-router-updates").click();
  await expect(marker(page, "router-xray-card")).toContainText("26.3.27");
  await marker(page, "btn-drawer-close").click();
  s.state.status.router_updates.available = [{ component: "xray", version: "26.12.1" }];
  await page.reload();
  await expect(marker(page, "router-update-notice")).toContainText("Xray 26.12.1");
});

test("one confirmation starts both components and follows each outcome through reload", async ({ page, baseURL }) => {
  const s = routerUpdates();
  const path = api + "/batch";
  s.on("POST", path, ({ body }) => {
    s.state.updates.pair = { ...body, at: null, state: "running", steps: { xkeen: "running", xray: "pending" }, message: null };
    return { status: 202, body: s.state.updates };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-pair-install").click();
  await marker(page, "router-pair-xray-version").selectOption("26.10.31");
  expect(s.count("POST", path)).toBe(0);
  await marker(page, "router-pair-confirm").click();
  expect(s.requests.find(r => r.method === "POST" && r.path === path)?.body).toEqual({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/), versions: { xkeen: "2.1", xray: "26.10.31" },
  });
  await expect(marker(page, "router-xray-install")).toBeDisabled();
  await page.reload();
  await marker(page, "router-updates-open").click();
  const progress = marker(page, "router-pair-status");
  await expect(progress).toContainText("XKeen 2.1 · installing");
  Object.assign(s.state.updates.pair, { state: "failed", steps: { xkeen: "failed", xray: "skipped" }, message: "XKeen failed to start." });
  await page.clock.runFor(2001);
  await expect(progress).toContainText("XKeen failed to start.");
  await expect(progress).toContainText("Xray 26.10.31 · skipped");
  await expect(marker(page, "router-xray-install")).toBeEnabled();
});

test("an installed release with an unconfirmed restart stays distinct from the reported service state", async ({ page, baseURL }) => {
  const s = routerUpdates();
  s.state.status.xkeen_state = "running";
  Object.assign(s.state.updates.components.xkeen, { installed: "2.1", releases: [] });
  s.state.updates.pair = { id: "291ec786-7146-4cd4-a105-a7909a1dc304", versions: titles, at: NOW,
    state: "failed", steps: { xkeen: "start_unconfirmed", xray: "skipped" }, message: null };
  s.state.updates.history = [{ id: "0fad9b30-ce9d-4498-bab4-3d5ead759367", component: "xkeen",
    version: "2.1", phase: "start_failed", action: "install", source: "once", at: NOW }];
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  const pair = marker(page, "router-pair-status");
  await expect(pair).toContainText("Partially completed");
  await expect(pair).toContainText("XKeen 2.1 · installed");
  await expect(pair).toContainText("Xray 26.11.9 · skipped");
  const card = marker(page, "router-xkeen-card");
  await expect(card).toContainText("Last reported service state · running");
  await expect(card).not.toContainText("failed to start");
  await expect(marker(page, "router-xray-install")).toBeEnabled();
});

test("schedules, moves and cancels both pinned releases with one Moscow time", async ({ page, baseURL }) => {
  const s = routerUpdates();
  const path = api + "/batch";
  s.on("POST", path, ({ body }) => {
    s.state.updates.pair = { ...body, state: "pending", steps: { xkeen: "pending", xray: "pending" }, message: null };
    return { body: s.state.updates };
  });
  s.on("PUT", path, ({ body }) => { s.state.updates.pair.at = body.at; return { body: s.state.updates }; });
  s.on("DELETE", path, () => { s.state.updates.pair.state = "cancelled"; return { body: s.state.updates }; });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-pair-schedule").click();
  await marker(page, "router-pair-xray-version").selectOption("26.10.31");
  const field = marker(page, "router-pair-at");
  await field.fill("2026-11-20T04:00");
  await field.focus();
  await page.clock.runFor(15001);
  await expect(field).toBeFocused();
  await expect(marker(page, "router-pair")).toContainText("GeoData");
  await marker(page, "router-pair-confirm").click();
  const target = s.state.updates.pair;
  await expect(marker(page, "router-pair-status")).toContainText("Scheduled");
  expect(target).toMatchObject({ at: "2026-11-20T01:00:00.000Z", versions: { xkeen: "2.1", xray: "26.10.31" } });
  await marker(page, "router-pair-reschedule").click();
  await field.fill("2026-11-21T03:00");
  await marker(page, "router-pair-confirm").click();
  expect(s.requests.find(r => r.method === "PUT" && r.path === path)?.body)
    .toEqual({ id: target.id, at: "2026-11-21T00:00:00.000Z" });
  await marker(page, "router-pair-unschedule").click();
  expect(s.requests.find(r => r.method === "DELETE" && r.path === path)?.body).toEqual({ id: target.id });
  await expect(marker(page, "router-xkeen-schedule")).toBeEnabled();
  expect(s.count("PUT", api + "/schedule")).toBe(0);
});

test("combines independent pins only after confirming their exact versions and times", async ({ page, baseURL }) => {
  const s = routerUpdates();
  const path = api + "/batch";
  const old = { at: "2026-11-20T00:15:00Z", version: "26.10.31" };
  s.state.updates.components.xray.schedule = { ...old, state: "pending" };
  s.on("POST", path, ({ body }) => {
    s.state.updates.components.xray.schedule = null;
    s.state.updates.pair = { ...body, state: "pending", steps: { xkeen: "pending", xray: "pending" } };
    return { body: s.state.updates };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-pair-schedule").click();
  await expect(marker(page, "router-pair-replaces")).toContainText("Xray 26.10.31");
  await expect(marker(page, "router-pair-at")).toHaveValue("2026-11-20T03:15");
  await expect(marker(page, "router-xray-unschedule")).toBeEnabled();
  s.state.updates.components.xray.schedule.at = "2026-11-20T01:45:00Z";
  await page.clock.runFor(15001);
  await expect(marker(page, "router-pair-confirm")).toBeDisabled();
  await marker(page, "router-pair-cancel").click();
  await marker(page, "router-pair-schedule").click();
  await marker(page, "router-pair-confirm").click();
  expect(s.requests.find(r => r.method === "POST" && r.path === path)?.body).toMatchObject({
    versions: { xkeen: "2.1", xray: old.version }, replace_schedules: { xray: { ...old, at: "2026-11-20T01:45:00Z" } },
  });
});

test("only offers both when both components have supported releases", async ({ page, baseURL }) => {
  const s = routerUpdates();
  s.state.updates.components.xkeen.releases = [{ version: "2.1", supported: false }];
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await expect(marker(page, "router-xray-install")).toBeEnabled();
  await expect(marker(page, "router-pair-install")).toHaveCount(0);
});

test("one-time target survives polling, uses Moscow time and stays pinned when rescheduled", async ({ page, baseURL }) => {
  const s = routerUpdates(), path = api + "/schedule";
  s.on("PUT", path, ({ body }) => {
    s.state.updates.components.xray.schedule = { at: body.at, version: body.version, state: "pending" };
    return { body: s.state.updates };
  });
  s.on("DELETE", path, () => { s.state.updates.components.xray.schedule = null; return { body: s.state.updates }; });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-xray-schedule").click();
  await marker(page, "router-xray-version").selectOption("26.10.31");
  const field = marker(page, "router-xray-at");
  await field.fill("2026-11-20T04:00");
  await field.focus();
  await page.clock.runFor(15001);
  await expect(field).toBeFocused();
  await expect(marker(page, "router-xray-card")).toContainText("GeoData");
  await marker(page, "router-xray-confirm").click();
  await expect(marker(page, "router-xray-card")).toContainText("Scheduled · 26.10.31");
  expect(s.requests.find(r => r.method === "PUT" && r.path === path)?.body)
    .toEqual({ component: "xray", version: "26.10.31", at: "2026-11-20T01:00:00.000Z" });
  await marker(page, "router-xray-schedule").click();
  await expect(marker(page, "router-xray-version")).toBeDisabled();
  await expect(marker(page, "router-xray-version")).toHaveValue("26.10.31");
  await expect(field).toHaveValue("2026-11-20T04:00");
  await marker(page, "router-xray-cancel").click();
  await marker(page, "router-xray-unschedule").click();
  await expect(marker(page, "router-xray-unschedule")).toHaveCount(0);
});

test("rollback confirms the server plan even when the release catalog is offline", async ({ page, baseURL }) => {
  const s = routerUpdates();
  const plan = [{ component: "xray", from: "26.11.9", to: "26.3.27" }, { component: "xkeen", from: "2.1", to: "2.0" }];
  Object.assign(s.state.updates.components.xkeen, { installed: "2.1", releases: [], rollback: plan });
  Object.assign(s.state.updates.components.xray, { installed: "26.11.9", releases: [], rollback: [plan[0]],
    schedule: { version: "26.12.1", at: "2026-12-02T00:00:00Z", state: "pending" } });
  s.state.updates.catalog_error = "Release catalog unavailable.";
  s.on("POST", api + "/rollback", ({ body }) => {
    s.state.updates.operation = { id: body.id, component: "xkeen", action: "rollback", version: "2.0", phase: "restoring", source: "manual" };
    return { status: 202, body: s.state.updates };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-xkeen-rollback").click();
  await expect(marker(page, "router-xkeen-card")).toContainText("Xray 26.11.9 → 26.3.27, then XKeen 2.1 → 2.0");
  await expect(marker(page, "router-xkeen-card")).toContainText("cancels the pending task for Xray 26.12.1");
  expect(s.count("POST", api + "/rollback")).toBe(0);
  await marker(page, "router-xkeen-confirm").click();
  await expect(marker(page, "router-update-operation")).toContainText("restoring");
  expect(s.requests.find(r => r.path === api + "/rollback")?.body)
    .toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), component: "xkeen", version: "2.0", plan, revision: "a".repeat(64), cancel_schedule: true });
});

test("daily installation and interrupted recovery are independent and exact", async ({ page, baseURL }) => {
  const s = routerUpdates();
  s.on("PUT", api + "/auto", ({ body }) => { s.state.updates.automatic = body; return { body: s.state.updates }; });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-auto-xray").check();
  await marker(page, "router-auto-time").fill("02:30");
  await marker(page, "router-auto-save").click();
  await expect.poll(() => s.state.updates.automatic).toEqual({ xkeen: false, xray: true, time: "02:30" });
  const id = "a0b1843e-bb12-48ec-9f62-212199176bbe";
  s.state.updates.operation = { id, component: "xray", action: "install", version: "26.11.9", phase: "interrupted", source: "auto" };
  s.on("POST", api + "/recover", () => ({ body: s.state.updates }));
  await page.clock.runFor(15001);
  await marker(page, "router-recover").click();
  await marker(page, "router-recover-confirm-confirm").click();
  expect(s.requests.find(r => r.path === api + "/recover")?.body).toEqual({ id });
});

test("a replaced rollback snapshot invalidates an open confirmation even with the same version names", async ({ page, baseURL }) => {
  const s = routerUpdates();
  Object.assign(s.state.updates.components.xray, { installed: "26.11.9", releases: [],
    rollback: [{ component: "xray", from: "26.11.9", to: "26.3.27" }] });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await marker(page, "router-xray-rollback").click();
  await expect(marker(page, "router-xray-confirm")).toBeEnabled();
  s.state.updates.rollback_revision = "b".repeat(64);
  await page.clock.runFor(15001);
  await expect(marker(page, "router-xray-confirm")).toBeDisabled();
  await expect(marker(page, "router-xray-card")).toContainText("Cancel and reopen");
  expect(s.count("POST", api + "/rollback")).toBe(0);
});

test("verified restore with an unexpected service state is terminal and keeps ordinary controls available", async ({ page, baseURL }) => {
  const s = routerUpdates();
  s.state.updates.components.xray.held = "26.11.9";
  s.state.updates.history = [{ id: "cf74dcc3-3afe-4c98-9c8f-102a680afe47", component: "xray",
    version: "26.3.27", phase: "rolled_back_start_failed", action: "rollback", source: "manual", at: NOW }];
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await expect(marker(page, "router-xray-card")).toContainText("Installed 26.3.27");
  await expect(marker(page, "router-xray-restored-start-failed")).toContainText("The previous version was restored. Service state was unconfirmed at the time of rollback.");
  await expect(marker(page, "router-update-operation")).toHaveCount(0);
  await expect(marker(page, "router-xray-install")).toBeEnabled();
  await expect(marker(page, "router-xray-schedule")).toBeEnabled();
});

test("a missing accepted journal remains blocked and can be rechecked without requesting a rollback", async ({ page, baseURL }) => {
  const s = routerUpdates();
  const id = "8843b501-1986-4320-8ef6-0b0bb15bd9d7";
  s.state.updates.operation = { id, component: "xray", version: "26.11.9", action: "install", phase: "journal_missing",
    source: "once", message: "Looking for the operation journal." };
  s.on("POST", api + "/recover", () => ({ body: s.state.updates }));
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await expect(marker(page, "router-xray-install")).toBeDisabled();
  await expect(marker(page, "router-recover")).toHaveCount(0);
  await marker(page, "router-journal-recheck").click();
  await expect.poll(() => s.count("POST", api + "/recover")).toBe(1);
  expect(s.requests.find(r => r.path === api + "/recover")?.body).toEqual({ id });
  await expect(marker(page, "router-update-operation")).toContainText("Router changes are paused.");
  expect(s.count("POST", api + "/rollback")).toBe(0);
});

test("a scheduled retry retains the pinned job and displays the reason until its window ends", async ({ page, baseURL }) => {
  const s = routerUpdates();
  s.state.updates.components.xray.schedule = { version: "26.10.31", at: NOW, state: "running" };
  s.state.updates.operation = { id: "df73eebe-2541-4795-b8c1-2d8c8e864e05", component: "xray",
    version: "26.10.31", phase: "preparing", action: "install", source: "once", message: "Catalog unavailable. Retrying within the installation window." };
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  await expect(marker(page, "router-xray-card")).toContainText("In progress · 26.10.31");
  await expect(marker(page, "router-update-operation")).toContainText("Retrying within the installation window.");
  await expect(marker(page, "router-xray-unschedule")).toBeDisabled();
  s.state.updates.components.xray.schedule.state = "missed";
  s.state.updates.components.xray.schedule.reason = "Catalog unavailable during installation window.";
  s.state.updates.operation = null;
  await page.clock.runFor(2001);
  await expect(marker(page, "router-xray-card")).toContainText("Missed · 26.10.31");
  await expect(marker(page, "router-xray-card")).toContainText("Catalog unavailable during installation window.");
});

for (const [theme, widths] of [["light", [1280, 1440]], ["dark", [320, 375, 390]]] as const) {
  test(`update actions, restore point and automatic switches fit the ${theme} settings drawer`, async ({ page, baseURL }) => {
    const s = routerUpdates();
    Object.assign(s.state.updates.components.xray, { installed: "26.10.31", releases: [{ version: "26.11.9", supported: true }],
      rollback: [{ component: "xray", from: "26.10.31", to: "26.3.27" }] });
    s.state.updates.automatic.xkeen = true;
    await page.setViewportSize({ width: widths[0], height: 844 });
    await openApp(page, s, baseURL!, theme);
    await marker(page, "router-updates-open").click();
    const card = marker(page, "router-xray-card");
    await expect(card).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = (await card.boundingBox())!;
      const controls = await Promise.all(["install", "schedule", "rollback"].map(async key =>
        (await marker(page, "router-xray-" + key).boundingBox())!));
      const [install, schedule, rollback] = controls;
      const minimum = await page.evaluate(() => matchMedia("(max-width: 720px), (pointer: coarse)").matches ? 44 : 32);
      for (const box of controls) {
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        expect(box.height).toBeGreaterThanOrEqual(minimum);
      }
      expect(Math.abs(install.y - schedule.y)).toBeLessThan(2);
      expect(install.x + install.width).toBeLessThanOrEqual(schedule.x);
      // A separate rollback row must be deliberately grouped with its own context.
      if (Math.abs(install.y - rollback.y) > 2) {
        const group = marker(page, "router-xray-rollback").locator("..");
        await expect(group).toContainText("26.3.27");
        await expect(group.locator('[data-marker="router-xray-install"]')).toHaveCount(0);
      }
      const pairButtons = await Promise.all(["install", "schedule"].map(async key =>
        (await marker(page, "router-pair-" + key).boundingBox())!));
      expect(Math.abs(pairButtons[0].y - pairButtons[1].y)).toBeLessThan(2);
      for (const name of ["xkeen", "xray"]) {
        const target = marker(page, "tgl-router-auto-" + name);
        await expect(target.locator(".switch")).toBeVisible();
        expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(minimum);
      }
      expect(await marker(page, "router-updates-section").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    }
  });
}

test("automatic update switches keep keyboard focus and save independently", async ({ page, baseURL, isMobile }) => {
  const s = routerUpdates();
  s.on("PUT", api + "/auto", ({ body }) => {
    s.state.updates.automatic = body; return { body: s.state.updates, hold: "saving-automatic" };
  });
  await openApp(page, s, baseURL!);
  await marker(page, "router-updates-open").click();
  const xkeen = page.getByRole("checkbox", { name: "XKeen", exact: true });
  const xray = page.getByRole("checkbox", { name: "Xray", exact: true });
  await xkeen.focus();
  await page.keyboard.press("Space");
  await expect(xkeen).toBeChecked();
  await expect(xray).not.toBeChecked();
  if (isMobile) {
    // iPhone WebKit's default tab policy skips native checkboxes.
    await xray.press("Space");
    await expect(xray).toBeChecked();
    await xray.press("Space");
    await expect(xray).not.toBeChecked();
  } else {
    await page.keyboard.press("Tab");
  }
  await expect(xray).toBeFocused();
  await expect(marker(page, "tgl-router-auto-xray").locator(".switch")).not.toHaveCSS("outline-style", "none");
  await page.clock.runFor(15001);
  await expect(xray).toBeFocused();
  await marker(page, "router-auto-save").click();
  await expect(xkeen).toBeDisabled();
  await expect(xray).toBeDisabled();
  await s.release("saving-automatic");
  await expect(xray).toBeEnabled();
  expect(s.state.updates.automatic).toEqual({ xkeen: true, xray: false, time: "03:00" });
});
