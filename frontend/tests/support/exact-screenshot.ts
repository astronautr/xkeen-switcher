import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { isReviewedRasterPair } from "./reviewed-raster";

// Use the PNG decoder shipped with the pinned Playwright installation.
const { PNG } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle") as {
  PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } };
};

export async function expectExactScreenshot(page: Page, name: string) {
  const options = { fullPage: false, scale: "css", animations: "disabled", caret: "hide" } as const;
  // Keep Playwright's stable-frame wait and its visual diff artifacts.
  await expect(page).toHaveScreenshot(name, options);
  const actual = await page.screenshot(options);
  const expected = readFileSync(test.info().snapshotPath(name));
  if (actual.equals(expected)) return;
  const reference = PNG.sync.read(expected);
  const observed = PNG.sync.read(actual);
  expect([observed.width, observed.height], name).toEqual([reference.width, reference.height]);
  if (observed.data.equals(reference.data)) return;
  if (isReviewedRasterPair(name, reference, observed)) {
    console.log(`Matched independently recorded G1 raster variant: ${name}`);
    return;
  }

  let different = 0;
  let first = -1;
  for (let offset = 0; offset < observed.data.length; offset += 4) {
    if (observed.data.readUInt32LE(offset) === reference.data.readUInt32LE(offset)) continue;
    if (first === -1) first = offset / 4;
    different++;
  }
  const path = test.info().outputPath(name);
  writeFileSync(path, actual);
  await test.info().attach(name, { path, contentType: "image/png" });
  expect(different, `${name}: first changed pixel at (${first % reference.width}, ${Math.floor(first / reference.width)})`).toBe(0);
}
