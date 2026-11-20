import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
test("fixture catalog renders shared components without API requests", async ({ page }) => {
  const api: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api")) api.push(request.url());
  });
  await page.goto("/catalog.html");
  await expect(page.getByRole("heading", { name: "xkeen.switch · components" })).toBeVisible();
  expect(await page.locator('[data-marker="sg-default"]').getAttribute("data-ui-variant")).toBeNull();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "theme",
    "buttons",
    "select and command menu",
    "confirm strip",
    "operation bar",
    "location list",
    "notices",
    "formatters",
  ]);
  await page.locator("[data-marker=sg-select]").selectOption("udp");
  await expect(page.getByText("Selected network: udp", { exact: true })).toBeVisible();
  await page.locator("[data-marker=sg-rich-select]").click();
  await expect(page.locator("[data-marker=sg-rich-select]")).toHaveAttribute("aria-haspopup", "listbox");
  const check = page.getByRole("listbox").getByRole("option", { selected: true }).locator("[data-choice-check]");
  await expect(check).toHaveText("✓");
  await expect(check).not.toHaveClass(/filter-menu-check/);
  await page.locator("[data-marker=sg-rich-select-option-nl]").click();
  await expect(page.getByText("Selected location: nl", { exact: true })).toBeVisible();
  await expect(page.locator("[data-marker=sg-menu]")).toHaveAttribute("data-ui-variant", "bracket");
  await page.locator("[data-marker=sg-menu]").click();
  await expect(page.locator("[data-marker=sg-menu]")).toHaveAttribute("aria-haspopup", "menu");
  await expect(page.getByRole("menu")).toBeVisible();
  const command = page.getByRole("menuitem").first();
  await expect(command).toBeVisible();
  expect(await command.getAttribute("aria-selected")).toBeNull();
  await page.locator("[data-marker=sg-menu-option-download]").click();
  await expect(
    page.getByText("Fixture action: download (no request).", { exact: true }),
  ).toBeVisible();
  await page.locator("[data-marker=sg-confirm-confirm]").click();
  await expect(
    page.getByText("Confirmed (fixture only, no request).", { exact: true }),
  ).toBeVisible();
  await page.locator("[data-marker=sg-location-tr]").click();
  await page.locator("[data-marker=sg-location-check-tr]").click();
  await page.locator("[data-marker=styleguide-theme-dark]").click();
  await expect(page.locator("html")).toHaveClass("theme-dark");
  expect(api).toEqual([]);
});
import AxeBuilder from "@axe-core/playwright";
import { NOW } from "../support/scenario";
for (const theme of ["light", "dark"] as const)
  test(`X05 catalog axe retained fingerprint ${theme}`, async ({ page }, testInfo) => {
    await page.addInitScript((theme) => localStorage.setItem("xk_theme", theme), theme);
    await page.goto("/catalog.html");
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    await testInfo.attach("axe-full-results", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    const fingerprints = result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      nodes: nodes.map((node) => {
        const contrast = node.any.find((check) => check.id === "color-contrast")?.data;
        return {
          target: node.target,
          text: node.html.replace(/<[^>]*>/g, ""),
          fgColor: contrast?.fgColor,
          bgColor: contrast?.bgColor,
          contrastRatio: contrast?.contrastRatio,
        };
      }),
    }));
    expect(fingerprints).toEqual(
      theme === "light"
        ? [
            {
              id: "color-contrast",
              impact: "serious",
              nodes: [
                {
                  target: [".info > .banner-pfx"],
                  text: "[waiting]",
                  fgColor: "#686658",
                  bgColor: "#e4e2d6",
                  contrastRatio: 4.44,
                },
              ],
            },
          ]
        : [],
    );
  });
const referenceViewports = process.env.XK_G5_REFERENCE ? [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
] : [];
for (const viewport of referenceViewports)
  for (const theme of ["light", "dark"] as const)
    test(`catalog exact legacy pixels ${viewport.width} ${theme}`, async ({
      page,
      context,
      browserName,
    }, testInfo) => {
      test.skip(browserName !== "chromium");
      await page.setViewportSize(viewport);
      await context.addInitScript((theme) => localStorage.setItem("xk_theme", theme), theme);
      const legacy = await context.newPage();
      await legacy.setViewportSize(viewport);
      for (const candidate of [page, legacy]) {
        await candidate.emulateMedia({ colorScheme: theme });
        await candidate.clock.install({ time: new Date(Date.parse(NOW) - 60_000) });
        await candidate.clock.pauseAt(new Date(NOW));
      }
      await page.goto("/catalog.html");
      await legacy.goto(`http://127.0.0.1:${process.env.UI_COMPONENT_LEGACY_PORT}/styleguide.html`);
      for (const candidate of [page, legacy]) {
        await candidate.evaluate(() => document.fonts.ready);
        await candidate.mouse.move(0, 0);
      }
      const geometry = async (candidate: typeof page) =>
        candidate.evaluate(() => ({
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
        }));
      expect(await geometry(page)).toEqual(await geometry(legacy));
      const height = (await geometry(legacy)).height;
      const offsets = [0];
      for (
        let offset = viewport.height - 128;
        offset < height - viewport.height;
        offset += viewport.height - 128
      )
        offsets.push(offset);
      if (height > viewport.height) offsets.push(height - viewport.height);
      for (const offset of offsets) {
        for (const candidate of [page, legacy]) {
          await candidate.evaluate((y) => scrollTo(0, y), offset);
          await candidate.clock.runFor(32);
        }
        const expected = await legacy.screenshot({
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
        const actual = await page.screenshot({
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
        const legacyPath = testInfo.outputPath(`legacy-${offset}.png`);
        const reactPath = testInfo.outputPath(`react-${offset}.png`);
        await writeFile(legacyPath, expected);
        await writeFile(reactPath, actual);
        await testInfo.attach(`legacy-${offset}.png`, {
          path: legacyPath,
          contentType: "image/png",
        });
        await testInfo.attach(`react-${offset}.png`, { path: reactPath, contentType: "image/png" });
        expect(actual.equals(expected), `Zero pixel/PNG difference at scroll ${offset}`).toBe(true);
      }
      await legacy.close();
    });
