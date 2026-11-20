import { defineConfig } from "@playwright/test";
import { serverEnv } from "../../support/native-browsers";
export default defineConfig({
  testDir: (process.env.SETTINGS_RED || process.env.SETTINGS_ORIGINAL) ? "../../behavior" : ".",
  testMatch: (process.env.SETTINGS_RED || process.env.SETTINGS_ORIGINAL) ? "auth-settings.spec.ts" : "*.spec.ts",
  globalSetup: "../../support/environment.ts",
  workers: 1,
  retries: 0,
  timeout: process.env.SETTINGS_RED ? 8000 : 25000,
  outputDir: "../../../test-results/settings",
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:18769", browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    env: serverEnv,
    cwd: new URL("../../../", import.meta.url).pathname,
    command: "npx rspack serve --config tests/features/settings/rspack.config.mjs",
    url: "http://127.0.0.1:18769",
    reuseExistingServer: false,
  },
});
