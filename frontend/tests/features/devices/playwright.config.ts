import { defineConfig, devices } from "@playwright/test";
import { firefoxLaunchOptions, serverEnv } from "../../support/native-browsers";
export default defineConfig({
  testDir: process.env.DEVICES_RED || process.env.DEVICES_ORIGINAL ? "../../behavior" : ".",
  testMatch:
    process.env.DEVICES_RED || process.env.DEVICES_ORIGINAL
      ? ["devices.spec.ts", "legacy-defects.spec.ts", "overlay-hit.spec.ts"]
      : process.env.DEVICES_GATEWAY
        ? "gateway.spec.ts"
        : ["flows.spec.ts", "dialog-visual.spec.ts"],
  globalSetup: "../../support/environment.ts",
  workers: 1,
  retries: 0,
  timeout: process.env.DEVICES_RED ? 8000 : 25000,
  outputDir: "../../../test-results/devices",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:18785",
    trace: "retain-on-failure",
    locale: "en-US",
    timezoneId: "Europe/Moscow",
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    ...(process.env.DEVICES_NATIVE
      ? [
          {
            name: "firefox",
            use: { browserName: "firefox" as const, launchOptions: firefoxLaunchOptions() },
          },
          { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" as const } },
        ]
      : []),
  ],
  webServer: [
    ...(process.env.DEVICES_GATEWAY
      ? [
          {
            cwd: new URL("../../../../", import.meta.url).pathname,
            command: "python -m tests.ui_support.server --port 18786 --configured",
            url: "http://127.0.0.1:18786/api/health",
            env: { ...serverEnv, PYTHONPATH: new URL("../../../../src", import.meta.url).pathname },
            reuseExistingServer: false,
          },
        ]
      : []),
    {
      env: { ...serverEnv, UI_BACKEND_PORT: "18786" },
      cwd: new URL("../../../", import.meta.url).pathname,
      command: "npx rspack serve --config tests/features/devices/rspack.config.mjs",
      url: "http://127.0.0.1:18785",
      reuseExistingServer: false,
    },
  ],
});
