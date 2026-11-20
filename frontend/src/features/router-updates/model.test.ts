import { expect, test } from "@rstest/core";
import { maintenanceWarning } from "./model";

test("maintenance warnings use the router's measured install time before a task and a fixed grace after it", () => {
  expect(maintenanceWarning("03:35", "04:30")).toBe("");
  expect(maintenanceWarning("03:35", "04:30", 28)).toContain("GeoData");
  expect(maintenanceWarning("03:32", "04:30", 28)).toBe("");
  expect(maintenanceWarning("04:09", "04:30", 12)).toContain("GeoData");
  expect(maintenanceWarning("04:10", "04:30", 12)).toBe("");
  expect(maintenanceWarning("23:52", "00:10", 24)).toContain("00:10");
  expect(maintenanceWarning("00:03", "23:57", 15)).toContain("23:57");
  expect(maintenanceWarning("", "23:57", 15)).toBe("");
});
