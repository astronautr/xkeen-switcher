import { defineConfig } from "@playwright/test";
import { serverEnv } from "../../support/native-browsers";
import path from "node:path";
const frontend = path.resolve(import.meta.dirname, "../../..");
const root = path.resolve(frontend, "..");
process.env.UI_DEV_PORT = "48761";
process.env.UI_BACKEND_PORT = "48762";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "../../support/environment.ts",
  workers: 1,
  retries: 0,
  timeout: 20000,
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/../../visual/baselines/{arg}{ext}",
  outputDir: path.join(frontend, "test-results/auth"),
  reporter: "list",
  expect: { timeout: 5000, toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" } },
  use: {
    baseURL: "http://127.0.0.1:48761",
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "Europe/Moscow",
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx rspack serve --config tests/features/auth/rspack.config.mjs",
      cwd: frontend,
      env: { ...serverEnv, UI_DEV_PORT: "48761", UI_BACKEND_PORT: "48762" },
      url: "http://127.0.0.1:48761",
      timeout: 60000,
    },
    {
      command: ".venv/bin/python -m tests.ui_support.server --port 48762",
      cwd: root,
      env: { ...serverEnv, PYTHONPATH: path.join(root, "src") },
      url: "http://127.0.0.1:48762/api/health",
      timeout: 15000,
    },
  ],
});
