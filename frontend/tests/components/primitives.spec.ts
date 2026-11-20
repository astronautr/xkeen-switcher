import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createScenario, marker, NOW } from "../support/scenario";
async function open(page: Page, baseURL: string) {
  const scenario = createScenario("Task4");
  await scenario.install(page.context(), baseURL);
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("/components.html");
  await expect(marker(page, "updated")).not.toHaveText("0");
  await page.clock.pauseAt(new Date(Date.parse(NOW) + 1000));
  return scenario;
}
test("Devices filter keeps the native trigger, caption and open multi-select", async ({
  page,
  baseURL,
}) => {
  const scenario = createScenario("Task4");
  await scenario.install(page.context(), baseURL!);
  await page.goto("/components.html?device-filter");
  const trigger = page.locator(".device-tools > button.menu-trigger");
  const popup = page.locator(".device-tools > button + .device-menu");
  await expect(trigger).toHaveAccessibleName("Filter by policies: All policies");
  await expect(trigger).toHaveClass("menu-trigger");
  await expect(trigger.locator(":scope > span")).toHaveText(["All policies", ""]);
  await expect(trigger.locator(":scope > .ui-chevron")).toHaveAttribute("data-direction", "down");
  await expect(trigger.locator("span").last()).toHaveAttribute("aria-hidden", "true");
  await expect(trigger).toHaveAttribute("title", "All policies");
  const id = await popup.getAttribute("id");
  expect(await trigger.getAttribute("aria-controls")).toBe(id);
  await trigger.press("ArrowDown");
  await expect(popup).toHaveAccessibleName("Filter by access policy");
  await expect(popup.getByRole("option", { name: "All policies", selected: true })).toBeFocused();
  await popup.getByRole("option", { name: "Direct" }).click();
  await expect(trigger.locator("span").first()).toHaveText("Direct");
  await expect(trigger).toHaveAttribute("title", "Direct");
  const proxy = popup.getByRole("option", { name: "Proxy" });
  await proxy.click();
  await expect(proxy).toHaveClass("menu-option");
  await expect(proxy).toHaveAttribute("aria-selected", "true");
  await expect(trigger).toHaveAccessibleName("Filter by policies: Policies · 2");
  await expect(trigger.locator("span").first()).toHaveText("Policies · 2");
  await expect(trigger).toHaveAttribute("title", "Direct, Proxy");
  await proxy.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(popup).toBeHidden();
});
test("X03 system and explicit theme, prepaint boot and reload", async ({ page, baseURL }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page, baseURL!);
  await expect(page.locator("html")).not.toHaveClass(/theme-/);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(20, 20, 20)");
  await marker(page, "theme-light").click();
  await expect(page.locator("html")).toHaveClass("theme-light");
  await page.reload();
  await expect(page.locator("html")).toHaveClass("theme-light");
  await expect(page.locator("link[rel=icon]").first()).toHaveAttribute("href", "/icon-light.svg");
  await expect(page.locator("meta[name=theme-color]").first()).toHaveAttribute(
    "content",
    "#f5f4ef",
  );
  await marker(page, "theme-auto").click();
  await expect(page.locator("html")).not.toHaveClass(/theme-/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 244, 239)");
});
for (const ime of [false, true])
  test(`X04 connected field and ancestors through real-provider poll/resize IME=${ime}`, async ({
    page,
    baseURL,
  }) => {
    const s = await open(page, baseURL!);
    const field = marker(page, "field");
    await field.focus();
    await field.evaluate((node: HTMLInputElement, ime) => {
      node.setSelectionRange(8, 13, "forward");
      const ancestors: Node[] = [];
      for (let current: Node | null = node; current; current = current.parentNode)
        ancestors.push(current);
      (window as any).__connected = { node, ancestors, removed: false };
      const observer = new MutationObserver((records) => {
        if (
          records.some((record) =>
            Array.from(record.removedNodes).some((removed) =>
              ancestors.some((ancestor) => removed === ancestor || removed.contains(ancestor)),
            ),
          )
        )
          (window as any).__connected.removed = true;
      });
      observer.observe(document, { subtree: true, childList: true });
      if (ime)
        node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "に" }));
    }, ime);
    const before = await marker(page, "updated").textContent();
    s.state.status.last_update_status = "fail";
    await page.clock.runFor(10001);
    await expect.poll(() => s.count("GET", "/api/status")).toBe(2);
    await expect
      .poll(async () => {
        await page.clock.runFor(16);
        return marker(page, "updated").textContent();
      })
      .not.toBe(before);
    for (const width of [320, 390, 639, 640, 641, 719, 720, 721, 1440])
      await page.setViewportSize({ width, height: 844 });
    expect(
      await field.evaluate((node) => {
        const saved = (window as any).__connected;
        return {
          same: node === saved.node,
          connected: saved.ancestors.every((ancestor: Node) => ancestor.isConnected),
          removed: saved.removed,
          focused: document.activeElement === node,
          selection: [
            (node as HTMLInputElement).selectionStart,
            (node as HTMLInputElement).selectionEnd,
          ],
        };
      }),
    ).toEqual({ same: true, connected: true, removed: false, focused: true, selection: [8, 13] });
    if (ime) await field.dispatchEvent("compositionend", { data: "に" });
    expect(s.failures).toEqual([]);
  });
test("X05 listbox/menu wrap, typeahead, disabled, Tab/Escape and stable open popup", async ({
  page,
  baseURL,
}) => {
  const s = await open(page, baseURL!);
  await marker(page, "choice").focus();
  await page.keyboard.press("ArrowDown");
  await expect(marker(page, "choice-option-all")).toBeFocused();
  await page.keyboard.press("s");
  await expect(marker(page, "choice-option-se")).toBeFocused();
  await page.keyboard.press("s");
  await expect(marker(page, "choice-option-sg")).toBeFocused();
  await page.keyboard.press("End");
  await expect(marker(page, "choice-option-nl")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(marker(page, "choice-option-all")).toBeFocused();
  await page.keyboard.press("Home");
  await page.clock.runFor(10001);
  await expect(marker(page, "choice-popup")).toBeVisible();
  await expect(marker(page, "choice-option-all")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(marker(page, "choice")).toBeFocused();
  await expect(marker(page, "choice-count")).toHaveText("0");
  await marker(page, "choice").click();
  await page.keyboard.press("Tab");
  await expect(marker(page, "choice-popup")).not.toBeVisible();
  await expect(marker(page, "command")).toBeFocused();
  await marker(page, "command").press("ArrowUp");
  await expect(marker(page, "command-option-nl")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(marker(page, "command")).toBeFocused();
  expect(s.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
});
test("X05 multi choice keeps popup, empty Set selects all", async ({ page, baseURL }) => {
  await open(page, baseURL!);
  await marker(page, "multi").click();
  await expect(marker(page, "multi-option-all")).toHaveAttribute("aria-selected", "true");
  await marker(page, "multi-option-se").click();
  await expect(marker(page, "multi-popup")).toBeVisible();
  await expect(marker(page, "multi-option-se")).toHaveAttribute("aria-selected", "true");
  await expect(marker(page, "multi-option-all")).toHaveAttribute("aria-selected", "false");
  await marker(page, "multi-option-all").click();
  await expect(marker(page, "multi-option-all")).toHaveAttribute("aria-selected", "true");
});
test("X05 native dialog wraps focus through rehosted overlay controls and returns trigger", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL!);
  await marker(page, "open-dialog").click();
  await expect(marker(page, "dialog")).toBeVisible();
  await expect(marker(page, "dialog-first")).toBeFocused();
  await expect(marker(page, "dialog").locator(".notice")).toHaveText("Fixture notification");
  await expect(
    marker(page, "dialog").locator(":scope > .toast-stack > [data-marker=fixture-toast]"),
  ).toHaveText("Fixture notification");
  await marker(page, "fixture-toast").evaluate((node) => ((window as any).__toast = node));
  await marker(page, "overlay-control").focus();
  await page.keyboard.press("Tab");
  await expect(marker(page, "dialog-first")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(marker(page, "overlay-control")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(marker(page, "dialog")).not.toBeVisible();
  await expect(marker(page, "open-dialog")).toBeFocused();
  await expect(page.locator("body > div > .notice")).toHaveText("Fixture notification");
  expect(
    await marker(page, "fixture-toast").evaluate((node) => node === (window as any).__toast),
  ).toBe(true);
  await expect(page.locator("body > .toast-stack > [data-marker=fixture-toast]")).toBeVisible();
});
test("X05 dialog gate unmount cleans top-layer while keeping overlay identity", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL!);
  await marker(page, "open-dialog").click();
  await page.locator(".notice").evaluate((node) => ((window as any).__notice = node));
  await marker(page, "dialog-first").click();
  await marker(page, "dialog-gate").click();
  await expect(marker(page, "leave-gate")).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  expect(await page.locator(".notice").evaluate((node) => node === (window as any).__notice)).toBe(
    true,
  );
  await expect(page.locator(".notice")).toHaveText("Updated fixture notification");
});
test("X05 confirm cancellation/native validity and disabled reason", async ({ page, baseURL }) => {
  await open(page, baseURL!);
  await expect(marker(page, "disabled")).toBeDisabled();
  await expect(marker(page, "disabled")).toHaveAccessibleDescription(
    "Paused while checking failover locations (failover).",
  );
  await marker(page, "open-confirm").click();
  await expect(marker(page, "confirm-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(marker(page, "confirm")).toHaveCount(0);
  await expect(marker(page, "open-confirm")).toBeFocused();
  await marker(page, "validate").click();
  expect(
    await marker(page, "required").evaluate((node: HTMLInputElement) => node.validationMessage),
  ).toBe("Enter a value.");
  await marker(page, "required").fill("Valid name");
  expect(
    await marker(page, "required").evaluate((node: HTMLInputElement) => node.validationMessage),
  ).toBe("");
});
test("hash shell keeps unrelated history keys and shared overlays", async ({ page, baseURL }) => {
  await open(page, baseURL!);
  await page.evaluate(() => history.replaceState({ unrelated: 42 }, ""));
  await page.locator(".notice").evaluate((node) => ((window as any).__notice = node));
  await marker(page, "nav-routing").click();
  await expect(marker(page, "routing-slot")).toBeVisible();
  await expect(marker(page, "history-state")).toHaveText('{"unrelated":42,"xkRouting":2}');
  expect(await page.locator(".notice").evaluate((node) => node === (window as any).__notice)).toBe(
    true,
  );
  await page.goBack();
  await expect(marker(page, "field")).toBeVisible();
});
test("WebKit mobile project delivers real touch", async ({ page, baseURL, browserName }) => {
  test.skip(browserName !== "webkit");
  await open(page, baseURL!);
  await marker(page, "open-dialog").evaluate((node) => {
    (window as any).__touch = [];
    node.addEventListener("touchstart", () => (window as any).__touch.push("touchstart"));
    node.addEventListener("click", () => (window as any).__touch.push("click"));
  });
  await marker(page, "open-dialog").tap();
  expect(
    await page.evaluate(() => ({
      events: (window as any).__touch,
      coarse: matchMedia("(pointer:coarse)").matches,
    })),
  ).toEqual({ events: ["touchstart", "click"], coarse: true });
});
for (const theme of ["light", "dark"] as const)
  test(`X05 shared controls and native dialog axe ${theme}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.addInitScript((theme) => localStorage.setItem("xk_theme", theme), theme);
    await open(page, baseURL!);
    await page.clock.resume();
    for (const view of ["controls", "dialog"]) {
      if (view === "dialog") await marker(page, "open-dialog").click();
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      await testInfo.attach(`axe-${view}-${theme}`, {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
      expect(
        result.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ).toEqual([]);
    }
  });
for (const denied of [false, true])
  test(`X03 prepaint theme works without React bundle; denied storage=${denied}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript((denied) => {
      if (denied)
        Storage.prototype.getItem = () => {
          throw new DOMException("Storage denied", "SecurityError");
        };
      else localStorage.setItem("xk_theme", "light");
    }, denied);
    await page.route("**/ui-assets/*.js", (route) => route.abort());
    const api: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url());
    });
    await page.goto("/components.html");
    await expect(marker(page, "react-shell")).toHaveCount(0);
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      denied ? "rgb(20, 20, 20)" : "rgb(245, 244, 239)",
    );
    if (denied) await expect(page.locator("html")).not.toHaveClass(/theme-/);
    else {
      await expect(page.locator("html")).toHaveClass("theme-light");
      await expect(page.locator("meta[name=theme-color]").first()).toHaveAttribute(
        "content",
        "#f5f4ef",
      );
      await expect(page.locator("link[rel=icon]").last()).toHaveAttribute(
        "href",
        "/icon-light.svg",
      );
    }
    expect(api).toEqual([]);
  });
