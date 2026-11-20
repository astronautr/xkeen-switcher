import { readFileSync } from "node:fs";
import { test, expect } from "../../support/test";
import { createScenario, marker, openApp } from "../../support/scenario";

// Compare the form itself at the G1 viewport coordinates. The surrounding document
// and floating controls must still pass the unchanged integrated tile assertions.
for (const width of [390, 1440]) {
  for (const theme of ["dark", "light"] as const) {
    for (const location of [true, false]) {
      const state = location ? "D05-location-picker" : "D06-policy-setup";
      test(state + " form pixels at " + width + " " + theme, async ({ page, baseURL }, info) => {
        const height = width === 390 ? 844 : 1000;
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await openApp(page, createScenario(state), baseURL!, theme);
        await marker(page, "devices-toggle").click();
        await marker(
          page,
          location ? "location-02:00:00:00:00:21" : "device-routing-setup",
        ).click();
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(48);
        const rect = await page
          .locator(location ? ".device-location-options" : ".device-routing-policies")
          .boundingBox();
        expect(rect).toBeTruthy();
        const actual = await page.screenshot({
          scale: "css",
          animations: "disabled",
          caret: "hide",
        });
        await info.attach("device-dialog", { body: actual, contentType: "image/png" });
        const file = state + "-chromium-" + width + "x" + height + "-" + theme + "-tile-01.png";
        const original = readFileSync(new URL("../../visual/baselines/" + file, import.meta.url));
        const difference = await page.evaluate(
          async ({ actual, original, rect }) => {
            async function pixels(base64: string) {
              const image = new Image();
              image.src = "data:image/png;base64," + base64;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0);
              return context.getImageData(rect.x, rect.y, rect.width, rect.height).data;
            }
            const left = await pixels(actual);
            const right = await pixels(original);
            let count = 0;
            for (let i = 0; i < left.length; i += 4) {
              if (
                left[i] !== right[i] ||
                left[i + 1] !== right[i + 1] ||
                left[i + 2] !== right[i + 2]
              )
                count++;
            }
            return count;
          },
          { actual: actual.toString("base64"), original: original.toString("base64"), rect: rect! },
        );
        expect(difference).toBe(0);
      });
    }
  }
}
