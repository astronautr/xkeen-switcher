import { defineConfig, devices } from "@playwright/test";
import { firefoxLaunchOptions, serverEnv } from "../../support/native-browsers";
const gateway = !!process.env.ROUTING_GATEWAY;
const port = Number(process.env.ROUTING_PORT || 18791);
const baseURL = "http://127.0.0.1:" + port;
const visual = !!process.env.ROUTING_VISUAL;
if (
  visual &&
  (process.env.UPDATE_LEGACY_BASELINES === "1" ||
    process.argv.some((arg) => arg.startsWith("--update-snapshots")))
) {
  throw new Error("The Routing React harness only compares existing legacy baselines.");
}
const original = !!(process.env.ROUTING_ORIGINAL || process.env.ROUTING_RED);
export default defineConfig({
  testDir: visual ? "../../visual" : original ? "../../behavior" : ".",
  testMatch: visual
    ? "screens.spec.ts"
    : original
      ? [
          "routing.spec.ts",
          "crossscreen.spec.ts",
          "navigation.spec.ts",
          "crossscreen-contracts.spec.ts",
          "overlay-hit.spec.ts",
        ]
      : gateway
        ? "gateway.spec.ts"
        : process.env.ROUTING_SURFACES
          ? "surfaces.spec.ts"
          : ["flows.spec.ts", "review-regressions.spec.ts"],
  globalSetup: "../../support/environment.ts",
  workers: 1,
  updateSnapshots: "none",
  snapshotPathTemplate: "{configDir}/../../visual/baselines/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" } },
  timeout: process.env.ROUTING_RED ? 6000 : 25000,
  outputDir: "../../../test-results/routing-" + port,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    locale: "en-US",
    timezoneId: "Europe/Moscow",
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox", launchOptions: firefoxLaunchOptions() } },
    { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
  webServer: [
    ...(gateway
      ? [
          {
            cwd: new URL("../../../../", import.meta.url).pathname,
            command: "python -m tests.ui_support.server --port 18792 --configured",
            url: "http://127.0.0.1:18792/api/health",
            env: { ...serverEnv, PYTHONPATH: new URL("../../../../src", import.meta.url).pathname },
          },
        ]
      : []),
    {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: { ...serverEnv, UI_BACKEND_PORT: "18792" },
      command: "node_modules/.bin/rspack serve --config tests/features/routing/rspack.config.mjs",
      url: baseURL,
      reuseExistingServer: false,
    },
  ],
});
