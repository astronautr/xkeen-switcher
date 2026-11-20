/** Runs existing G1 assertions unchanged against the supplemental auth composition. */
import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  ...base,
  testDir: "../..",
  testMatch: ["behavior/auth-contracts.spec.ts", "behavior/auth-settings.spec.ts", "visual/auth-contracts.spec.ts", "visual/screens.spec.ts"],
  snapshotPathTemplate: "{testDir}/visual/baselines/{arg}{ext}",
  outputDir: "../../../test-results/auth-g1",
});
