import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { firefoxLaunchOptions, serverEnv } from "./tests/support/native-browsers";
const reference = process.env.XK_G5_REFERENCE;
const port = (process.env.UI_COMPONENT_PORT ||= String(38000 + (process.pid % 10000)));
const legacyPort = (process.env.UI_COMPONENT_LEGACY_PORT ||= String(28000 + (process.pid % 10000)));
export default defineConfig({
  updateSnapshots: process.env.UPDATE_COMPONENT_SNAPSHOTS === "1" ? "missing" : "none",
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{ext}",
  globalSetup: "./tests/support/environment.ts",
  testDir: "./tests/components",
  workers: 1,
  retries: 0,
  timeout: 25000,
  reporter: "list",
  outputDir: "./test-results/components",
  expect: {
    timeout: 5000,
    toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-US",
    timezoneId: "Europe/Moscow",
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run test:components:serve",
      env: serverEnv,
      url: `http://127.0.0.1:${port}/catalog.html`,
      reuseExistingServer: false,
      timeout: 60000,
    },
    ...(reference ? [{
      command: `.venv/bin/python -m tests.ui_support.server --port ${legacyPort}`,
      env: { ...serverEnv, PYTHONPATH: path.join(reference, "src") },
      cwd: reference,
      url: `http://127.0.0.1:${legacyPort}/api/health`,
      reuseExistingServer: false,
      timeout: 15000,
    }] : []),
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox", launchOptions: firefoxLaunchOptions() } },
    { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
