import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";
import { changedDeviceId as id, interruptedScenario, undoScenario } from "../../support/devices";
import type { DeviceDto } from "../../../src/api/types";

for (const surface of ["search", "menu", "unregister", "routing", "location"]) {
  test(
    "D07 " + surface + " suppresses inventory while status continues",
    async ({ page, baseURL }) => {
      const scenario = createScenario("D07");
      await openApp(page, scenario, baseURL!);
      await marker(page, "devices-toggle").click();
      const target = {
        search: "search-devices",
        menu: "policies-filter",
        unregister: "unregister-" + id,
        routing: "device-routing-setup",
        location: "location-" + id,
      }[surface]!;
      await marker(page, target).click();
      if (surface !== "search")
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      await page.clock.runFor(41_000);
      expect(scenario.count("GET", "/api/devices")).toBe(1);
      expect(scenario.count("GET", "/api/status")).toBeGreaterThan(1);
    },
  );
}

for (const interrupted of [false, true]) {
  test(
    "D03 current inventory resolves Undo, interrupted=" + interrupted,
    async ({ page, baseURL }) => {
      const scenario = undoScenario(createScenario("D03"));
      const interruptedId = interrupted && interruptedScenario(scenario);
      await openApp(page, scenario, baseURL!);
      await marker(page, "devices-toggle").click();
      if (interruptedId) {
        await marker(page, "recover-" + interruptedId).click();
      } else {
        await marker(page, "unregister-" + id).click();
        await marker(page, "confirm-unregister-" + id).click();
        await page.getByRole("button", { name: "Undo fixture change" }).click();
      }
      await expect(marker(page, "unregister-" + id)).toBeVisible();
      await expect(page.getByText("Device change undone", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Undo fixture change" })).toHaveCount(0);
      expect(scenario.count("POST", "/api/devices/undo")).toBe(1);
    },
  );
}

test("D05 ambiguous assignment reads the submitted journal and fixed-exit Undo uses its new journal", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("D05");
  const device: DeviceDto = scenario.state.devices.devices.find((d: DeviceDto) => d.id === id);
  let assignment = "";
  const undoId = "59329976-a6b1-44b9-a71c-ba8a1b3b9a51";
  scenario.on("POST", "/api/devices/location", (request) => {
    assignment = request.body.operation_id;
    scenario.on("GET", "/api/routing/operations/" + assignment, () => {
      device.location.code = "de";
      device.location.name = "Germany";
      return { body: { id: assignment, kind: "device-location", phase: "committed" } };
    });
    return { abort: true };
  });
  scenario.on("POST", "/api/devices/undo", (request) => {
    expect(request.body).toEqual({ operation_id: assignment });
    const operation = {
      id: undoId,
      kind: "device-location",
      phase: "accepted",
      device_request: { undo: true },
    };
    scenario.state.status.operation = operation;
    return { status: 202, body: { operation }, hold: "undo" };
  });
  scenario.on("GET", "/api/routing/operations/" + undoId, () => {
    scenario.state.status.operation = null;
    device.location.code = null;
    device.location.name = null;
    return {
      body: {
        id: undoId,
        kind: "device-location",
        phase: "committed",
        device_request: { undo: true },
      },
    };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "location-" + id).click();
  await marker(page, "device-location-option-de").check();
  await marker(page, "apply-device-location").click();
  await marker(page, "check-location-result").click();
  await expect(marker(page, "location-" + id)).toContainText("Germany");
  await page.getByRole("button", { name: "Undo fixture change" }).click();
  await expect.poll(() => scenario.count("POST", "/api/devices/undo")).toBe(1);
  await page.clock.runFor(11000);
  await page.clock.runFor(1600);
  await expect
    .poll(() => scenario.count("GET", "/api/routing/operations/" + undoId))
    .toBeGreaterThan(0);
  await scenario.release("undo");
  await expect(marker(page, "location-" + id)).toContainText("Use Main route");
  await expect(page.getByText("Device location change undone", { exact: true })).toHaveCount(1);
  expect(scenario.count("POST", "/api/devices/location")).toBe(1);
});

test("D06 saves policy IDs and the revision displayed at open", async ({ page, baseURL }) => {
  const scenario = createScenario("D06");
  scenario.on("PUT", "/api/devices/routing-settings", (request) => {
    expect(request.body).toEqual({ revision: null, policy_ids: ["default"] });
    return { body: scenario.state.devices };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "device-routing-setup").click();
  await marker(page, "mapped-policy-policy:Policy0").uncheck();
  await marker(page, "mapped-policy-default").check();
  await marker(page, "save-device-routing").click();
  await expect(marker(page, "device-routing-dialog")).toHaveCount(0);
  expect(scenario.count("PUT", "/api/devices/routing-settings")).toBe(1);
});

test("D01 favorite, multi-policy and registration filters compose without reordering", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("D01");
  scenario.on("POST", "/api/devices/favorite", (request) => {
    expect(request.body).toEqual({ id, favorite: true });
    scenario.state.devices.devices.find((d: DeviceDto) => d.id === id).favorite = true;
    return { body: { favorites: [id] } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "favorite-" + id).click();
  await marker(page, "favorites-filter").check();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await marker(page, "policies-filter").click();
  await marker(page, "policies-filter-option-default").click();
  await expect(page.getByRole("listitem")).toHaveCount(0);
  await marker(page, "policies-filter-option-policy:Policy0").click();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await marker(page, "registration-filter").click();
  await marker(page, "registration-filter-option-unregistered").click();
  await expect(page.getByRole("listitem")).toHaveCount(0);
  await marker(page, "clear-filters").click();
  await expect(page.getByRole("listitem")).toHaveCount(scenario.state.devices.devices.length);
});

for (const focus of ["star", "filter", "other", "moved-away"] as const) {
  test("D01 respects keyboard focus after unfavoriting: " + focus, async ({
    page,
    baseURL,
  }) => {
    const scenario = createScenario("D01:favorite-focus");
    const device = scenario.state.devices.devices.find((d: DeviceDto) => d.id === id);
    device.favorite = true;
    scenario.on("POST", "/api/devices/favorite", () => {
      device.favorite = false;
      return { hold: "favorite", body: { favorites: [] } };
    });
    await openApp(page, scenario, baseURL!);
    const toggle = marker(page, "devices-toggle");
    await toggle.click();
    const filter = marker(page, "favorites-filter");
    if (focus !== "star") await filter.check();
    const star = marker(page, "favorite-" + id);
    await star.focus();
    await star.press("Enter");
    await expect(star).toBeDisabled();
    if (focus === "other" || focus === "moved-away") await toggle.focus();
    if (focus === "moved-away") await toggle.evaluate((button: HTMLElement) => button.blur());
    await scenario.release("favorite");
    await expect(filter).toBeEnabled();
    if (focus === "star") {
      await expect(star).toHaveAttribute("aria-pressed", "false");
      await expect(star).toBeFocused();
    } else {
      await expect(star).toHaveCount(0);
      const target = focus === "moved-away" ? page.locator("body") : focus === "filter" ? filter : toggle;
      await expect(target).toBeFocused();
    }
  });
}

for (const action of ["pin-ip", "server", "unregister", "unregister-tap"] as const) {
  test("D02 D03 D06 returns keyboard focus after " + action, async ({ page, baseURL }) => {
    const scenario = createScenario("D02:row-focus");
    const device = scenario.state.devices.devices.find((d: DeviceDto) => d.id === id);
    const unregister = action === "unregister" || action === "unregister-tap";
    const endpoint = action === "server" ? "/api/devices/server" : "/api/devices/change";
    scenario.on("POST", endpoint, () => {
      if (action === "pin-ip") device.ip_pinned = !device.ip_pinned;
      if (action === "server") device.is_server = !device.is_server;
      if (unregister) device.registered = false;
      return { hold: "change", body: scenario.state.devices };
    });
    await openApp(page, scenario, baseURL!);
    await marker(page, "devices-toggle").click();
    const trigger = marker(page, (unregister ? "unregister" : action) + "-" + id);
    await trigger.focus();
    await trigger.press("Enter");
    if (unregister) {
      const confirm = marker(page, "confirm-unregister-" + id);
      if (action === "unregister-tap") await confirm.click();
      else {
        await confirm.focus();
        await confirm.press("Enter");
      }
    }
    await expect.poll(() => scenario.count("POST", endpoint)).toBe(1);
    await scenario.release("change");
    const target = unregister ? marker(page, "register-" + id) : trigger;
    await expect(target).toBeEnabled();
    await expect(target).toBeFocused();
  });
}

test("D07 initial read starts the 30-second inventory interval", async ({ page, baseURL }) => {
  const scenario = createScenario("D07");
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await expect(marker(page, "search-devices")).toBeEnabled();
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.clock.runFor(29_000);
  expect(scenario.count("GET", "/api/devices")).toBe(1);
  await page.clock.runFor(22_000);
  await expect.poll(() => scenario.count("GET", "/api/devices")).toBe(2);
});

test("D05 shows missing exits and IP conflicts on the affected row", async ({ page, baseURL }) => {
  const scenario = createScenario("D05");
  const device = scenario.state.devices.devices.find((d: DeviceDto) => d.id === id);
  Object.assign(device.location, { code: "vanished", name: "Saved exit", unavailable: true });
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await expect(marker(page, "device-" + id)).toContainText("Unavailable · saved config kept");
  await marker(page, "location-" + id).click();
  await expect(marker(page, "device-location-option-vanished")).toBeDisabled();
  await marker(page, "device-location-option-main").check();
  await expect(marker(page, "apply-device-location")).toHaveText("Use Main route");
  await marker(page, "cancel-location-dialog").click();
  device.location.ip_conflict = true;
  await marker(page, "router-devices-refresh").click();
  await expect(marker(page, "device-" + id)).toContainText("IP changed · review assignment");
});

test("D01 device selector markup and captions match the inventory toolbar", async ({
  page,
  baseURL,
}) => {
  await openApp(page, createScenario("D01"), baseURL!);
  await marker(page, "devices-toggle").click();
  const selector = marker(page, "policies-filter");
  await expect(page.locator(".device-tools > .menu-trigger")).toHaveCount(3);
  await expect(selector.locator(":scope > .ui-chevron")).toHaveAttribute("data-direction", "down");
  await expect(selector).toHaveAccessibleName("Filter by policies: All policies");
  await selector.click();
  await expect(page.getByRole("listbox", { name: "Filter by access policy" })).toBeVisible();
  await marker(page, "policies-filter-option-policy:Policy0").click();
  await expect(selector).toHaveAttribute("title", "XKeen");
  await marker(page, "policies-filter-option-default").click();
  await expect(selector).toHaveAccessibleName("Filter by policies: Policies · 2");
  await expect(selector).toHaveAttribute("title", "XKeen, Default");
});

test("D04 conflict on the existing duplicate can be compared without losing either typed name", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("D04");
  const existing = scenario.state.devices.devices.find((d: DeviceDto) => d.id === id);
  const newcomer = scenario.state.devices.devices.find(
    (d: DeviceDto) => d.id === "02:00:00:00:00:45",
  );
  const old = existing.revision;
  scenario.on("POST", "/api/devices/change", (request) => {
    const first = scenario.count("POST", "/api/devices/change") === 1;
    expect(request.body.changes[0]).toEqual({
      id,
      revision: first ? old : "changed",
      values: { name: "Desk" },
    });
    if (first) {
      existing.revision = "changed";
      return { status: 409, body: { code: "conflict", error: "Device changed" } };
    }
    newcomer.registered = true;
    newcomer.name = existing.name;
    existing.name = "Desk";
    return { body: scenario.state.devices };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "register-" + newcomer.id).click();
  await marker(page, "name-" + newcomer.id).fill(existing.name);
  await marker(page, "rename-existing").click();
  await marker(page, "conflict-name").fill("Desk");
  await marker(page, "save-" + newcomer.id).click();
  const compare = marker(page, "compare-" + newcomer.id);
  await expect(compare).toBeVisible();
  await marker(page, "name-" + newcomer.id).fill(existing.name + " ");
  await expect(compare).toBeVisible();
  await expect(marker(page, "save-" + newcomer.id)).toBeDisabled();
  await marker(page, "name-" + newcomer.id).press("Enter");
  expect(scenario.count("POST", "/api/devices/change")).toBe(1);
  await compare.click();
  await expect(marker(page, "name-" + newcomer.id)).toHaveValue(existing.name + " ");
  await expect(marker(page, "conflict-name")).toHaveValue("Desk");
  await marker(page, "save-" + newcomer.id).click();
  await expect(marker(page, "rename-" + newcomer.id)).toBeVisible();
});

test("D05 missing journal keeps the ambiguous request checkable without another POST", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("D05");
  scenario.on("POST", "/api/devices/location", (request) => {
    const submitted = request.body.operation_id;
    const journal = "/api/routing/operations/" + submitted;
    scenario.on("GET", journal, () =>
      scenario.count("GET", journal) === 1
        ? { status: 404, body: { error: "Unknown operation" } }
        : { body: { id: submitted, kind: "device-location", phase: "committed" } },
    );
    return { abort: true };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "location-" + id).click();
  await marker(page, "device-location-option-de").check();
  await marker(page, "apply-device-location").click();
  await marker(page, "check-location-result").click();
  await expect(page.getByRole("alert")).toContainText("No confirmed result yet");
  await marker(page, "check-location-result").click();
  await expect(marker(page, "device-location-dialog")).toHaveCount(0);
  expect(scenario.count("POST", "/api/devices/location")).toBe(1);
});

test("D06 a shared blocking activity preserves a policy draft inside the native dialog", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("D06");
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "device-routing-setup").click();
  await marker(page, "mapped-policy-policy:Policy0").uncheck();
  scenario.state.status.operation = {
    id: null,
    ephemeral: true,
    blocking: true,
    kind: "read",
    scope: "read",
    phase: "preparing",
    message: "Reading from router",
  };
  await page.clock.runFor(11000);
  await expect(marker(page, "save-device-routing")).toBeDisabled();
  await expect(marker(page, "device-modal-operation")).toContainText("Reading from router");
  await expect(
    marker(page, "device-routing-dialog").getByRole("button", { name: /Activity:/ }),
  ).toBeVisible();
  await expect(marker(page, "mapped-policy-policy:Policy0")).not.toBeChecked();
  expect(scenario.count("PUT", "/api/devices/routing-settings")).toBe(0);
});

test("D03 pending history Undo disables a second device change in the inventory", async ({
  page,
  baseURL,
}) => {
  const scenario = undoScenario(createScenario("D03"));
  const restore = scenario.handlers.get("POST /api/devices/undo")!;
  scenario.on("POST", "/api/devices/undo", async (request) => ({
    ...(await restore(request)),
    hold: "restore",
  }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "devices-toggle").click();
  await marker(page, "unregister-" + id).click();
  await marker(page, "confirm-unregister-" + id).click();
  await page.getByRole("button", { name: "Undo fixture change" }).click();
  await expect.poll(() => scenario.count("POST", "/api/devices/undo")).toBe(1);
  await expect(marker(page, "register-" + id)).toBeDisabled();
  await scenario.release("restore");
  await expect(marker(page, "unregister-" + id)).toBeEnabled();
});
