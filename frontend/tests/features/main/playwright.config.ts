import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { firefoxLaunchOptions, serverEnv } from "../../support/native-browsers";

const firefox = firefoxLaunchOptions();
// Pre-create Documents just like Downloads in the shared fixture. Otherwise macOS
// creates it with a deny-delete ACL inside the temporary home during browser use.
mkdirSync(path.join(firefox.env.CFFIXED_USER_HOME, "Documents"), { recursive: true, mode: 0o700 });

export default defineConfig({
  testDir: "../..",
  testMatch: ["behavior/*.spec.ts", "features/main/*.spec.ts"],
  globalSetup: "../../support/environment.ts",
  workers: 1,
  retries: 0,
  timeout: process.env.MAIN_RED ? 8000 : 25000,
  outputDir: "../../../test-results/main",
  reporter: "list",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox", launchOptions: firefox } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    timezoneId: "Europe/Moscow",
    locale: "en-US",
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    baseURL: "http://127.0.0.1:18779",
    trace: "retain-on-failure",
  },
  webServer: {
    env: serverEnv,
    cwd: new URL("../../../", import.meta.url).pathname,
    command: "npx rspack serve --config tests/features/main/rspack.config.mjs",
    url: "http://127.0.0.1:18779",
    reuseExistingServer: false,
  },
});
