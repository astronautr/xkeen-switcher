import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { firefoxLaunchOptions, cleanupNativeBrowsers } from "./native-browsers.ts";
test("only the runner-created tree is removed; inherited caller directory is preserved", async () => {
  const caller = mkdtempSync(path.join(tmpdir(), "xkeen-firefox-caller-"));
  const previous = process.env.XK_TEST_FIREFOX_HOME;
  const worker = process.env.TEST_WORKER_INDEX;
  const home = process.env.HOME;
  writeFileSync(path.join(caller, "keep"), "caller-owned");
  try {
    process.env.XK_TEST_FIREFOX_HOME = caller;
    delete process.env.TEST_WORKER_INDEX;
    cleanupNativeBrowsers();
    assert.equal(readFileSync(path.join(caller, "keep"), "utf8"), "caller-owned");
    const options = firefoxLaunchOptions();
    const created = options.env.CFFIXED_USER_HOME;
    assert.notEqual(created, caller);
    assert.equal(options.env.HOME, home);
    for (const child of ["Library/Application Support", "Library/Caches", "Documents", "Downloads"])
      assert.equal(statSync(path.join(created, child)).isDirectory(), true);
    assert.equal(firefoxLaunchOptions().env.CFFIXED_USER_HOME, created);
    process.env.TEST_WORKER_INDEX = "0";
    const workerModule = await import("./native-browsers.ts?worker-instance");
    assert.equal(workerModule.firefoxLaunchOptions().env.CFFIXED_USER_HOME, created);
    workerModule.cleanupNativeBrowsers();
    assert.equal(existsSync(created), true, "worker must not own runner cleanup");
    if (process.platform === "darwin")
      execFileSync("/bin/chmod", ["+a", "everyone deny delete", path.join(created, "Documents")]);
    delete process.env.TEST_WORKER_INDEX;
    cleanupNativeBrowsers();
    assert.equal(existsSync(created), false);
    assert.equal(process.env.XK_TEST_FIREFOX_HOME, caller);
    assert.equal(readFileSync(path.join(caller, "keep"), "utf8"), "caller-owned");
    cleanupNativeBrowsers();
    assert.equal(existsSync(caller), true, "repeated cleanup must not consume caller env");
  } finally {
    cleanupNativeBrowsers();
    if (previous === undefined) delete process.env.XK_TEST_FIREFOX_HOME;
    else process.env.XK_TEST_FIREFOX_HOME = previous;
    if (worker === undefined) delete process.env.TEST_WORKER_INDEX;
    else process.env.TEST_WORKER_INDEX = worker;
    rmSync(caller, { recursive: true, force: true });
  }
});
