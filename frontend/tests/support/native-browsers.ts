import { lstatSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
let ownedDirectory: string | undefined;
let previousDirectory: string | undefined;
/** Only the runner creates and owns a fresh tree. Worker configs reuse its env. */
export function firefoxLaunchOptions() {
  if (
    !ownedDirectory &&
    (!process.env.XK_TEST_FIREFOX_HOME || process.env.TEST_WORKER_INDEX === undefined)
  ) {
    previousDirectory = process.env.XK_TEST_FIREFOX_HOME;
    ownedDirectory = mkdtempSync(path.join(tmpdir(), "xkeen-firefox-"));
    for (const child of ["Library/Application Support", "Library/Caches", "Documents", "Downloads"])
      mkdirSync(path.join(ownedDirectory, child), { recursive: true, mode: 0o700 });
    process.env.XK_TEST_FIREFOX_HOME = ownedDirectory;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CFFIXED_USER_HOME: ownedDirectory ?? process.env.XK_TEST_FIREFOX_HOME!,
  };
  delete env.NO_COLOR;
  return { env };
}
export function cleanupNativeBrowsers(_config?: FullConfig) {
  if (!ownedDirectory) return;
  const directory = ownedDirectory;
  // macOS may protect the simulated Documents directory with a deny-delete ACL.
  // Touch only this runner's private directory, including when it was supplied by macOS.
  const documents = path.join(directory, "Documents");
  if (process.platform === "darwin" && lstatSync(documents, { throwIfNoEntry: false })?.isDirectory())
    execFileSync("/bin/chmod", ["-N", documents]);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  ownedDirectory = undefined;
  if (process.env.XK_TEST_FIREFOX_HOME === directory) {
    if (previousDirectory === undefined) delete process.env.XK_TEST_FIREFOX_HOME;
    else process.env.XK_TEST_FIREFOX_HOME = previousDirectory;
  }
  previousDirectory = undefined;
}
/** Playwright sets FORCE_COLOR for child servers; do not inherit conflicting NO_COLOR. */
export const serverEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "NO_COLOR" && key !== "FORCE_COLOR"),
) as Record<string, string>;
