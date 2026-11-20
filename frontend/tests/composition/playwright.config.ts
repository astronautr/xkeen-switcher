import { defineConfig } from "@playwright/test";
import { serverEnv } from "../support/native-browsers";
import path from "node:path";

const frontend = path.resolve(import.meta.dirname, "../..");
const port = "18770";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "../support/environment.ts",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: path.join(frontend, "test-results/composition"),
  use: { baseURL, browserName: "chromium", serviceWorkers: "block", trace: "retain-on-failure" },
  webServer: {
    command: "npx rspack serve",
    cwd: frontend,
    env: { ...serverEnv, UI_DEV_PORT: port },
    url: baseURL,
    reuseExistingServer: false,
  },
});
