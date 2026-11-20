import { serverEnv } from "./tests/support/native-browsers";
import { defineConfig } from "@playwright/test";
const port = (process.env.UI_PROTOCOL_PORT ||= String(42000 + (process.pid % 10000)));
export default defineConfig({
  globalSetup: "./tests/support/environment.ts",
  testDir: "./tests/protocol",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20000,
  expect: { timeout: 5000 },
  outputDir: "./test-results/protocol",
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "Europe/Moscow",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    env: serverEnv,
    command: "npm run test:protocol:serve",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
