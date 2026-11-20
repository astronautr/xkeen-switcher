import { firefoxLaunchOptions, serverEnv } from "./tests/support/native-browsers";
import { defineConfig, devices } from "@playwright/test";
if (process.argv.some((arg) => arg.startsWith("--update-snapshots"))) {
  throw new Error("The candidate must compare against the committed G1 baselines.");
}
const proxyBackendPort = (process.env.UI_PROXY_BACKEND_PORT ||= String(
  11000 + (process.pid % 8000),
));
const proxyPort = (process.env.UI_PROXY_PORT ||= String(50000 + (process.pid % 10000)));
const port = (process.env.UI_PORT ||= String(20000 + (process.pid % 30000)));
export default defineConfig({
  updateSnapshots: "none",
  globalSetup: "./tests/support/environment.ts",
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 5000,
    toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" },
  },
  snapshotPathTemplate: "{testDir}/visual/baselines/{arg}{ext}",
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "en-US",
    timezoneId: "Europe/Moscow",
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `.venv/bin/python -m tests.ui_support.server --port ${port}`,
      env: serverEnv,
      cwd: "..",
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `.venv/bin/python -m tests.ui_support.server --port ${proxyBackendPort}`,
      env: serverEnv,
      cwd: "..",
      url: `http://127.0.0.1:${proxyBackendPort}/api/health`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `UI_BACKEND_PORT=${proxyBackendPort} UI_DEV_PORT=${proxyPort} npm run dev`,
      env: serverEnv,
      url: `http://127.0.0.1:${proxyPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: "visual", testMatch: "**/visual/*.spec.ts", use: { browserName: "chromium" } },
    ...["chromium", "firefox", "webkit"].map((browserName) => ({
      name: browserName,
      testMatch: "**/behavior/*.spec.ts",
      use: {
        ...(browserName === "webkit" ? devices["iPhone 13"] : {}),
        browserName: browserName as "chromium" | "firefox" | "webkit",
        ...(browserName === "firefox" ? { launchOptions: firefoxLaunchOptions() } : {}),
        ...(browserName === "webkit" ? { defaultBrowserType: "webkit" } : {}),
      },
    })),
    {
      name: "integration",
      testMatch: "**/integration/*.spec.ts",
      use: { browserName: "chromium" },
    },
  ],
});
