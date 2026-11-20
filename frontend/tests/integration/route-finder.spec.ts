import { test, expect } from "../support/test";
import { marker } from "../support/scenario";

test("Single and Chain retain independent verdicts and apply checked routes over HTTP", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const session = await (await context.request.get("/api/auth/session")).json();
  const auth = await context.request.post(session.configured ? "/api/auth/login" : "/api/auth/setup", {
    headers: { "X-XK-Request": "1" }, data: { password: "synthetic-ui-password" },
  });
  expect(auth.ok()).toBe(true);
  await page.goto("/");

  const trigger = marker(page, "open-route-finder");
  const dialog = page.getByRole("dialog", { name: "Find a working route" });
  const row = (key: string) => dialog.locator(`[data-marker="route-row"][data-key="${key}"]`);
  const check = marker(page, "route-finder-check");
  const scope = marker(page, "route-finder-scope");
  await trigger.click();
  await expect(marker(page, "route-finder-single")).toHaveAttribute("aria-pressed", "true");
  await expect(row("fi")).toHaveAttribute("data-state", "unchecked");
  await scope.click();
  await dialog.getByRole("option", { name: /Choose/ }).click();
  const pick = marker(page, "route-pick-de");
  await pick.focus();
  await page.keyboard.press("Space");
  await expect(pick).toBeFocused();
  await marker(page, "route-pick-done").click();
  await expect(scope).toBeFocused();
  await scope.click();
  await dialog.getByRole("option", { name: /All locations/ }).click();

  await check.click();
  await expect(row("fi")).toHaveAttribute("data-state", "failed");
  await expect(check).toHaveText(/recheck/);
  await expect(row("de")).toHaveAttribute("data-state", "working");
  // A partial retry leaves both the previous Working evidence and the total intact.
  await scope.click();
  await dialog.getByRole("option", { name: /Needs checking/ }).click();
  const retry = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/route-checks");
  await check.click();
  expect((await retry).postDataJSON()).toMatchObject({ kind: "single", codes: ["fi"] });
  await expect(marker(page, "route-finder-report")).toContainText("2 of 3 worked");
  await expect(row("se")).toHaveAttribute("data-state", "working");
  await row("fi").getByRole("button", { name: /Find chains to Finland/ }).click();
  await expect(check).toBeFocused();
  await expect(scope).toHaveAccessibleName(/Reachable directly/);
  await expect(row("fi")).toHaveCount(0);
  await check.click();
  await expect(row("de")).toHaveAttribute("data-state", "unstable");
  await row("de").getByRole("button", { name: /Unstable/ }).click();
  await expect(row("de").getByText("Round 1 · passed")).toBeVisible();
  await expect(row("de").getByText("Round 2 · failed")).toBeVisible();
  await scope.click();
  await dialog.getByRole("option", { name: /Choose/ }).click();
  await marker(page, "route-preset-none").click();
  await marker(page, "route-pick-de").check();
  await marker(page, "route-pick-done").click();
  await page.reload();
  await trigger.click();
  await expect(scope).toContainText("Germany");
  await expect(marker(page, "route-finder-exit")).toContainText("Finland");
  await marker(page, "route-other-entries").click();
  const other = page.waitForRequest(request =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/route-checks");
  await marker(page, "route-check-others").click();
  expect((await other).postDataJSON()).toMatchObject({ kind: "chain", exit_code: "fi", entry_codes: ["se"] });
  await expect(check).toHaveText(/recheck/);
  await row("se").getByRole("button", { name: /Apply Sweden.* → Finland.* to Main/ }).click();
  await expect(dialog).toBeHidden();
  await expect(marker(page, "active-name")).toContainText(/Sweden.* → Finland/);
  await trigger.click();
  await expect(row("se").getByText("On Main")).toBeVisible();

  await scope.click();
  await dialog.getByRole("option", { name: /Reachable directly/ }).click();
  await marker(page, "route-finder-single").click();
  await row("se").getByRole("button", { name: /Apply Sweden.* to Main/ }).click();
  await expect(dialog).toBeHidden();
  await expect(marker(page, "active-name")).toHaveText(/Sweden[^→]*$/);
  await trigger.click();
  await expect(row("se").getByText("On Main")).toBeVisible();
  await marker(page, "route-sites-edit").click();
  const input = dialog.getByRole("textbox").first();
  const original = await input.inputValue();
  await input.fill("https://changed.example.invalid/");
  await expect(check).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(input).toHaveValue("https://changed.example.invalid/");
  await marker(page, "route-sites-save").click();
  await expect(row("se")).toHaveAttribute("data-state", "stale");
  await marker(page, "route-finder-chain").click();
  await expect(scope).toContainText("All locations");
  await marker(page, "route-sites-edit").click();
  await input.fill(original);
  await marker(page, "route-sites-save").click();
  await expect(scope).toHaveAccessibleName(/Reachable directly/);
  await expect(row("se")).toHaveAttribute("data-state", "working");
});
