import { test, expect } from "../../support/test";
import { marker } from "../../support/scenario";
import { changedDeviceId } from "../../support/devices";

// Real Python handlers and MockDevicesGateway, with no browser interception.
test("D03 unregister and undo round-trip through the real serializer and gateway", async ({
  page,
  context,
  baseURL,
}) => {
  const login = await context.request.post("/api/auth/login", {
    headers: { Origin: baseURL!, "X-XK-Request": "1" },
    data: { password: "synthetic-ui-password" },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  await marker(page, "devices-toggle").click();
  await marker(page, "unregister-" + changedDeviceId).click();
  await marker(page, "confirm-unregister-" + changedDeviceId).click();
  await expect(marker(page, "register-" + changedDeviceId)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Undo fixture change" }).click();
  await expect(marker(page, "unregister-" + changedDeviceId)).toBeVisible();
  await expect(page.getByText("Device change undone", { exact: true })).toBeVisible();
  const inventory = await (await context.request.get("/api/devices")).json();
  expect(inventory.operations[0]).toMatchObject({ phase: "undone", undoable: false });
});
