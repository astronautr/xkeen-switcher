import { test, expect } from "@playwright/test";
import { createScenario, marker, NOW } from "../support/scenario";
import { expectExactScreenshot } from "../support/exact-screenshot";
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
])
  for (const theme of ["light", "dark"] as const)
    for (const surface of ["controls", "popup", "confirm", "dialog"])
      test(`supplemental shared snapshot ${surface} ${viewport.width} ${theme}`, async ({
        page,
        baseURL,
        browserName,
      }) => {
        test.skip(browserName !== "chromium");
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript((theme) => localStorage.setItem("xk_theme", theme), theme);
        await createScenario("Task4-supplement").install(page.context(), baseURL!);
        await page.clock.install({ time: new Date(NOW) });
        await page.goto("/components.html");
        await expect(marker(page, "updated")).not.toHaveText("0");
        await page.clock.pauseAt(new Date(Date.parse(NOW) + 1000));
        if (surface === "popup") await marker(page, "choice").press("ArrowDown");
        else if (surface === "dialog") await marker(page, "open-dialog").click();
        else if (surface === "confirm") await marker(page, "open-confirm").click();
        else await marker(page, "theme-light").focus();
        await page.clock.runFor(32);
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.fonts.ready);
        await expectExactScreenshot(page, `shared-${surface}-${viewport.width}-${theme}.png`);
      });
