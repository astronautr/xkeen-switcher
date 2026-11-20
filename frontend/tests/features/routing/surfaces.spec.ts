import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";
import { routingScenario } from "../../support/routing";

// Compare the feature's controls at their original viewport coordinates. The
// independent full-document gates still include the global activity and inbox.
async function compareSurface(page: Page, selector: string, actual: Buffer, original: Buffer) {
  const rect = await page.locator(selector).first().boundingBox();
  expect(rect).toBeTruthy();
  const changed = await page.evaluate(
    async ({ actual, original, rect }) => {
      async function pixels(base64: string) {
        const image = new Image();
        image.src = "data:image/png;base64," + base64;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
      }
      const [left, right] = await Promise.all([pixels(actual), pixels(original)]);
      let different = 0;
      for (let i = 0; i < left.length; i += 4) {
        if (left[i] !== right[i] || left[i + 1] !== right[i + 1] || left[i + 2] !== right[i + 2]) different++;
      }
      return different;
    },
    { actual: actual.toString("base64"), original: original.toString("base64"), rect: rect! },
  );
  expect(changed, selector + " at " + JSON.stringify(rect)).toBe(0);
}
for (const width of [390, 1440])
  for (const theme of ["dark", "light"] as const) {
    for (const state of ["R01-rules", "R04-preview"] as const)
      test(state + " feature controls " + width + " " + theme, async ({ page, baseURL }, info) => {
        const height = width === 390 ? 844 : 1000;
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        const scenario = createScenario(state);
        if (state === "R04-preview") routingScenario(scenario);
        await openApp(page, scenario, baseURL!, theme);
        await marker(page, "nav-routing").click();
        await expect(marker(page, "routing-add")).toBeVisible();
        if (state === "R04-preview") {
          await marker(page, "draft-review").click();
          await expect(marker(page, "review-apply")).toBeVisible();
        }
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(48);
        const actual = await page.screenshot({
          path: info.outputPath("routing.png"),
          scale: "css",
          animations: "disabled",
          caret: "hide",
        });
        await info.attach(state, { body: actual, contentType: "image/png" });
        const filename = state + "-chromium-" + width + "x" + height + "-" + theme + "-tile-01.png";
        const original = await readFile(new URL("../../visual/baselines/" + filename, import.meta.url));
        const selectors =
          state === "R01-rules"
            ? [".routing-head", ".list-toolbar", ".rule-row"]
            : [".panel-head", ".review-item"];
        for (const selector of selectors) await compareSurface(page, selector, actual, original);
      });
  }
