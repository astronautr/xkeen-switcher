import { test, expect } from "../../support/test";
import { createScenario, marker, openApp as openScenario, NOW } from "../../support/scenario";
import { expectVisualTiles } from "../../support/visual";

async function openApp(...args: Parameters<typeof openScenario>) {
  await openScenario(...args);
  // Flush the provider's queued bootstrap and Query notifications under paused time.
  await args[0].clock.runFor(1);
}

test("boot retry restores status and the single polling owner", async ({ page, baseURL }) => {
  const scenario = createScenario("A03-boot-retry");
  scenario.on("GET", "/api/auth/session", () => ({ status: 503, body: { error: "Unavailable" } }));
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "boot-retry")).toBeVisible();
  scenario.on("GET", "/api/auth/session", () => ({ body: scenario.state.session }));
  await marker(page, "boot-retry").click();
  await expect(marker(page, "fixture-status")).toHaveText("fi");
  expect(scenario.count("GET", "/api/status")).toBe(1);
  scenario.state.status.active_code = "de";
  await page.clock.runFor(10001);
  await expect(marker(page, "fixture-status")).toHaveText("de");
  expect(scenario.count("GET", "/api/status")).toBe(2);
});

test("created pairing remains pending until the first shared two-second tick", async ({ page, baseURL }) => {
  const scenario = createScenario("A04-first-tick");
  scenario.on("POST", "/api/auth/pairing-code", () => ({ body: {
    id: "first-tick", code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300,
  } }));
  scenario.on("GET", "/api/auth/pairing-code", () => ({ body: {
    id: "first-tick", status: "completed", expires_at: Date.parse(NOW) / 1000 + 300,
  } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  await expect(marker(page, "pair-status")).toHaveText("valid for 5:00");
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(0);
  await page.clock.runFor(1999);
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(0);
  await page.clock.runFor(2);
  await expect(marker(page, "pair-result")).toContainText("signed in");
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(1);
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  for (const theme of ["light", "dark"]) {
    for (const variant of ["setup", "password-login", "code-login"]) {
      test(`original signed-out PNG ${variant} ${viewport.width} ${theme}`, async ({ page, baseURL }) => {
        const scenario = createScenario("auth-signed-out");
        scenario.state.session = { configured: variant !== "setup", authenticated: false, session_id: null };
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
        await openApp(page, scenario, baseURL!, theme);
        if (variant === "code-login") await marker(page, "gate-mode").click();
        await expect(marker(page, variant === "setup" ? "password-submit" : "gate-input")).toBeVisible();
        await expectVisualTiles(page, `${variant === "setup" ? "A01" : "A02"}-${variant}-chromium-${viewport.width}x${viewport.height}-${theme}.png`);
      });
    }
  }
}

for (const mode of ["password", "code"]) {
  for (const status of [401, 429, 503]) {
    test(`form ${mode} ${status} retains focused input and exact request`, async ({ page, baseURL }) => {
      const scenario = createScenario("A02-feature");
      scenario.state.session.authenticated = false;
      const value = mode === "code" ? "123456" : "synthetic-ui-password";
      scenario.on("POST", mode === "code" ? "/api/auth/pair" : "/api/auth/login", (request) => {
        expect(request.body).toEqual(mode === "code" ? { code: value } : { password: value });
        return { status, body: { error: "Invalid credentials" }, headers: status === 429 ? { "Retry-After": "30" } : undefined };
      });
      await openApp(page, scenario, baseURL!);
      if (mode === "code") await marker(page, "gate-mode").click();
      await marker(page, "gate-input").fill(value);
      await marker(page, "gate-submit").click();
      await expect(marker(page, "gate-error")).not.toBeEmpty();
      if (status === 429) await expect(marker(page, "gate-error")).toContainText("30s");
      await marker(page, "gate-input").focus();
      await page.clock.runFor(10001);
      await expect(marker(page, "gate-input")).toBeFocused();
      await expect(marker(page, "gate-input")).toHaveValue(value);
      await expect(marker(page, "gate-submit")).toBeEnabled();
    });
  }
}

for (const variant of ["password-login", "setup"] as const) {
  test(`${variant} submit shows pending text without moving the signed-out form`, async ({ page, baseURL }) => {
    const scenario = createScenario("A02-pending");
    const setup = variant === "setup";
    scenario.state.session = { configured: !setup, authenticated: false, session_id: null };
    scenario.on("POST", setup ? "/api/auth/setup" : "/api/auth/login", () => ({
      hold: "auth-submit", status: 401, body: { error: "Invalid credentials" },
    }));
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, scenario, baseURL!);
    const submit = marker(page, setup ? "password-submit" : "gate-submit");
    const after = marker(page, setup ? "password-cancel" : "gate-mode");
    // Brackets hug the label exactly like the original bracket control.
    expect(await submit.evaluate((node) => node.textContent)).toBe(setup ? "create admin password" : "sign in");
    const idle = await submit.boundingBox();
    const following = await after.boundingBox();
    const face = await submit.locator(".terminal-action-label").boundingBox();
    if (setup) {
      await marker(page, "password-new").fill("synthetic-ui-password");
      await marker(page, "password-repeat").fill("synthetic-ui-password");
    } else {
      await marker(page, "gate-input").fill("synthetic-ui-password");
    }
    await submit.click();
    await expect(submit).toHaveAttribute("aria-busy", "true");
    await expect(submit.locator(".terminal-action-label")).toHaveText(setup ? "creating password" : "signing in");
    await expect(submit.locator(".terminal-action-glyph")).toBeVisible();
    expect(await submit.boundingBox()).toEqual(idle);
    expect(await after.boundingBox()).toEqual(following);
    const busyFace = await submit.locator(".terminal-action-label").boundingBox();
    // The pending face stays centered in the same control.
    expect(Math.abs(busyFace!.x + busyFace!.width / 2 - (face!.x + face!.width / 2))).toBeLessThan(1);
    await scenario.release("auth-submit");
    await expect(submit).toHaveAttribute("aria-busy", "false");
    expect(await submit.boundingBox()).toEqual(idle);
  });
}

test("setup mismatch retains connected controls without POST", async ({ page, baseURL }) => {
  const scenario = createScenario("A01-feature");
  scenario.state.session = { configured: false, authenticated: false, session_id: null };
  await openApp(page, scenario, baseURL!);
  await marker(page, "password-new").fill("synthetic-ui-password");
  await marker(page, "password-repeat").fill("different-ui-password");
  await marker(page, "password-submit").click();
  await expect(marker(page, "password-error")).toHaveText("passwords do not match");
  await marker(page, "password-new").focus();
  await page.evaluate(() => {
    const input = document.querySelector('[data-marker="password-new"]')!;
    const observer = new MutationObserver(() => {
      if (!input.isConnected) document.documentElement.dataset.detached = "true";
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.clock.runFor(10001);
  await expect(marker(page, "password-new")).toBeFocused();
  await expect(marker(page, "password-new")).toHaveValue("synthetic-ui-password");
  expect(await page.locator("html").getAttribute("data-detached")).toBeNull();
  expect(scenario.count("POST", "/api/auth/setup")).toBe(0);
});

test("replacement password session and other/current browser revoke", async ({ page, baseURL }) => {
  const scenario = createScenario("A03-feature");
  scenario.on("POST", "/api/auth/password", (request) => {
    expect(request.body).toEqual({ current_password: "old-ui-password", password: "new-ui-password" });
    scenario.state.session.session_id = "replacement";
    scenario.state.sessions.sessions = [{ id: "replacement", label: "Replacement browser", current: true, created_at: NOW }];
    return { body: { ok: true } };
  });
  scenario.on("POST", "/api/auth/sessions/revoke", (request) => {
    const current = request.body.id === "replacement";
    scenario.state.sessions.sessions = scenario.state.sessions.sessions.filter((item: { id: string }) => item.id !== request.body.id);
    return { body: { ok: true, current_revoked: current } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, "btn-change-password").click();
  await marker(page, "password-current").fill("old-ui-password");
  await marker(page, "password-new").fill("new-ui-password");
  await marker(page, "password-repeat").fill("new-ui-password");
  await page.clock.runFor(10001);
  await expect(marker(page, "password-repeat")).toHaveValue("new-ui-password");
  await marker(page, "password-submit").click();
  await expect(marker(page, "device-revoke")).toHaveAttribute("data-id", "replacement");
  scenario.state.sessions.sessions.push({ id: "other", label: "Other", current: false, created_at: NOW });
  await marker(page, "devices-refresh").click();
  await page.locator('[data-marker="device-revoke"][data-id="other"]').click();
  await expect(marker(page, "device-revoke")).toHaveCount(1);
  await marker(page, "device-revoke").click();
  await expect(marker(page, "gate-input")).toBeVisible();
});

test("returning to Access refreshes the list of signed-in browsers", async ({ page, baseURL }) => {
  const scenario = createScenario("A03-access-reentry");
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "device-current")).toBeVisible();
  await marker(page, "btn-change-password").click();
  await expect(marker(page, "password-current")).toBeVisible();
  const readsBeforeReturn = scenario.count("GET", "/api/auth/sessions");
  scenario.state.sessions.sessions.push({
    id: "second-browser", label: "Safari · phone", current: false, created_at: NOW,
  });
  await marker(page, "password-cancel").click();
  await expect(marker(page, "device-row").filter({ hasText: "Safari · phone" })).toBeVisible();
  expect(scenario.count("GET", "/api/auth/sessions")).toBe(readsBeforeReturn + 1);
});

test("GET begun before logout cannot replace new login session", async ({ page, baseURL }) => {
  const scenario = createScenario("A03-race-feature");
  scenario.on("POST", "/api/auth/logout", () => ({ body: { ok: true } }));
  scenario.on("POST", "/api/auth/login", () => {
    scenario.state.session.session_id = "new-session";
    return { body: { ok: true } };
  });
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "fixture-status")).toHaveText("fi");
  scenario.on("GET", "/api/status", () => ({ hold: "old-status", body: { ...scenario.state.status, active_code: "de" } }));
  await page.clock.runFor(10001);
  await expect.poll(() => scenario.count("GET", "/api/status")).toBe(2);
  await marker(page, "btn-logout").click();
  await expect(marker(page, "gate-input")).toBeVisible();
  scenario.on("GET", "/api/status", () => ({ body: scenario.state.status }));
  await marker(page, "gate-input").fill("synthetic-ui-password");
  await marker(page, "gate-submit").click();
  await expect(marker(page, "fixture-session")).toHaveText("new-session");
  await scenario.release("old-status");
  await page.clock.runFor(48);
  await expect(marker(page, "fixture-status")).toHaveText("fi");
  await expect(marker(page, "fixture-session")).toHaveText("new-session");
});

test("reopening a pending pairing keeps the same code and checks it immediately", async ({ page, baseURL }) => {
  const scenario = createScenario("A04-reopen-pending");
  const expiresAt = Date.parse(NOW) / 1000 + 300;
  let created = 0;
  scenario.on("POST", "/api/auth/pairing-code", () => {
    const first = ++created === 1;
    return { body: {
      id: first ? "existing-pair" : "replacement-pair",
      code: first ? "123456" : "654321",
      status: "pending",
      expires_at: expiresAt,
    } };
  });
  scenario.on("GET", "/api/auth/pairing-code", (request) => ({ body: {
    id: request.query.id, status: "pending", expires_at: expiresAt,
  } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  await marker(page, "pair-close").click();
  await expect(marker(page, "settings-link-device")).toBeFocused();
  await page.clock.runFor(3000);
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(0);
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  await expect(marker(page, "pair-status")).toHaveText("valid for 4:57");
  expect(scenario.count("POST", "/api/auth/pairing-code")).toBe(1);
  await expect.poll(() => scenario.requests
    .filter(request => request.path === "/api/auth/pairing-code" && request.method === "GET")
    .map(request => request.query.id)).toEqual(["existing-pair"]);
});

test("pairing completed while closed refreshes Access and notifies once", async ({ page, baseURL }) => {
  const scenario = createScenario("A04-closed-completion");
  const expiresAt = Date.parse(NOW) / 1000 + 300;
  const device = { id: "new-browser", label: "Safari · phone", created_at: NOW };
  scenario.on("POST", "/api/auth/pairing-code", () => ({ body: {
    id: "closed-pair", code: "123456", status: "pending", expires_at: expiresAt,
  } }));
  scenario.on("GET", "/api/auth/pairing-code", (request) => ({ body: {
    id: request.query.id, status: "completed", expires_at: expiresAt, device,
  } }));
  const notices = () => page.evaluate(() => {
    const messages: { message: string }[] = JSON.parse(localStorage.getItem("xk_notifications") ?? "[]");
    return messages.filter(item => item.message === "Browser signed in: Safari · phone").length;
  });
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "device-current")).toBeVisible();
  const readsBeforePairing = scenario.count("GET", "/api/auth/sessions");
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-code")).toHaveText("123 456");
  await marker(page, "pair-close").click();
  scenario.state.sessions.sessions.push({ ...device, current: false });
  await page.clock.runFor(9998);
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(0);
  await page.clock.runFor(500);
  await expect(marker(page, "device-row").filter({ hasText: device.label })).toBeVisible();
  await expect.poll(notices).toBe(1);
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-result")).toHaveText("✓ Safari · phone signed in");
  await marker(page, "pair-close").click();
  await page.clock.runFor(10001);
  expect(await notices()).toBe(1);
  expect(scenario.count("POST", "/api/auth/pairing-code")).toBe(1);
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(1);
  expect(scenario.count("GET", "/api/auth/sessions")).toBe(readsBeforePairing + 1);
});

for (const outcome of ["completed", "expired", "replaced", "exhausted", "cancelled"]) {
  test(`pairing ${outcome}, renewal and close cleanup`, async ({ page, baseURL }) => {
    const scenario = createScenario("A04-feature");
    let generation = 0;
    let terminal = false;
    scenario.on("POST", "/api/auth/pairing-code", () => ({ body: {
      id: `pair-${++generation}`, code: "123456", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300,
    } }));
    scenario.on("GET", "/api/auth/pairing-code", (request) => ({ body: {
      id: request.query.id, status: terminal ? outcome : "pending", expires_at: Date.parse(NOW) / 1000 + 300,
      ...(outcome === "completed" ? { device: { label: "Safari · phone" } } : {}),
    } }));
    await openApp(page, scenario, baseURL!);
    await marker(page, "settings-link-device").click();
    await expect(marker(page, "pair-code")).toHaveText("123 456");
    await expect(marker(page, "pair-status")).toHaveText("valid for 5:00");
    await page.clock.runFor(1000);
    await expect(marker(page, "pair-status")).toHaveText("valid for 4:59");
    terminal = true;
    await page.clock.runFor(1001);
    await expect(marker(page, "pair-result")).not.toBeEmpty();
    await expect(marker(page, "pair-code")).toBeHidden();
    const reads = scenario.count("GET", "/api/auth/pairing-code");
    await page.clock.runFor(4001);
    expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(reads);
    terminal = false;
    await marker(page, "pair-new").click();
    await expect(marker(page, "pair-code")).toHaveText("123 456");
    await expect(marker(page, "pair-result")).toBeEmpty();
    await marker(page, "pair-close").click();
    await expect(marker(page, "settings-link-device")).toBeFocused();
    const closedReads = scenario.count("GET", "/api/auth/pairing-code");
    // Leave a full two-second dialog interval before the independent dashboard tick.
    const dashboardTick = Date.parse(NOW) + 10_000;
    const currentTime = await page.evaluate(() => Date.now());
    await page.clock.runFor(dashboardTick - currentTime - 1);
    expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(closedReads);
    await page.clock.runFor(2);
    await expect.poll(() => scenario.requests
      .filter(request => request.path === "/api/auth/pairing-code" && request.method === "GET")
      .map(request => request.query.id)).toEqual(["pair-1", "pair-2"]);
    expect(generation).toBe(2);
  });
}

test("real Python forms setup, password replacement, login, code pairing and Origin cookies", async ({ page, context, browser, baseURL }) => {
  await page.goto("/");
  await marker(page, "password-new").fill("synthetic-ui-password");
  await marker(page, "password-repeat").fill("synthetic-ui-password");
  await marker(page, "password-submit").click();
  await expect(marker(page, "device-current")).toBeVisible();
  const first = (await context.cookies()).find((cookie) => cookie.name === "xk_session")!;
  expect(first).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect((await context.request.post("/api/auth/password", { data: {}, headers: { "X-XK-Request": "1", Origin: "http://foreign.invalid" } })).status()).toBe(403);
  await marker(page, "btn-change-password").click();
  await marker(page, "password-current").fill("synthetic-ui-password");
  await marker(page, "password-new").fill("replacement-ui-password");
  await marker(page, "password-repeat").fill("replacement-ui-password");
  await marker(page, "password-submit").click();
  await expect(marker(page, "device-current")).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === "xk_session")!.value).not.toBe(first.value);
  await marker(page, "btn-logout").click();
  await marker(page, "gate-input").fill("replacement-ui-password");
  await marker(page, "gate-submit").click();
  await expect(marker(page, "device-current")).toBeVisible();
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-code")).toHaveText(/\d{3} \d{3}/);
  const code = (await marker(page, "pair-code").innerText()).replace(" ", "");
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto(baseURL!);
    await marker(second, "gate-mode").click();
    await marker(second, "gate-input").fill(code);
    await marker(second, "gate-submit").click();
    await expect(marker(second, "device-current")).toBeVisible();
    await expect(marker(page, "pair-result")).toContainText("signed in");
    expect((await other.cookies()).find((cookie) => cookie.name === "xk_session")).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  } finally {
    await other.close();
  }
  await marker(page, "pair-close").click();
  await marker(page, "btn-logout").click();
  await expect(marker(page, "gate-input")).toBeVisible();
  expect((await context.request.get("/api/status")).status()).toBe(401);
});

test("pairing errors and unavailable stop allow a pending renewal to survive close", async ({ page, baseURL }) => {
  const scenario = createScenario("A04-error-feature");
  let attempts = 0;
  scenario.on("POST", "/api/auth/pairing-code", () => {
    attempts++;
    if (attempts === 1) return { status: 503, body: { error: "Unavailable" } };
    return { hold: attempts === 3 ? "late-code" : undefined, body: {
      id: `error-pair-${attempts}`, code: attempts === 3 ? "111111" : "654321", status: "pending", expires_at: Date.parse(NOW) / 1000 + 300,
    } };
  });
  let unavailable = false;
  scenario.on("GET", "/api/auth/pairing-code", () => ({ status: unavailable ? 404 : 503, body: { error: "Could not check" } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-status")).toContainText("No confirmed response");
  await marker(page, "pair-new").click();
  await expect(marker(page, "pair-code")).toHaveText("654 321");
  await page.clock.runFor(2001);
  await expect(marker(page, "pair-status")).toContainText("Could not check connection");
  unavailable = true;
  await page.clock.runFor(2001);
  await expect(marker(page, "pair-result")).toHaveText("This code is no longer available.");
  const reads = scenario.count("GET", "/api/auth/pairing-code");
  await page.clock.runFor(6001);
  expect(scenario.count("GET", "/api/auth/pairing-code")).toBe(reads);
  await marker(page, "pair-new").click();
  await expect.poll(() => scenario.count("POST", "/api/auth/pairing-code")).toBe(3);
  await marker(page, "pair-close").click();
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-new")).toHaveText("creating code");
  await expect(marker(page, "pair-new")).toHaveAttribute("aria-busy", "true");
  expect(scenario.count("POST", "/api/auth/pairing-code")).toBe(3);
  await scenario.release("late-code");
  await expect(marker(page, "pair-code")).toHaveText("111 111");
  expect(scenario.count("POST", "/api/auth/pairing-code")).toBe(3);
});

test("a held pairing creation from an old identity cannot replace the new invitation", async ({ page, baseURL }) => {
  const scenario = createScenario("A04-pairing-identity");
  const expiresAt = Date.parse(NOW) / 1000 + 300;
  let created = 0;
  scenario.on("POST", "/api/auth/pairing-code", () => {
    const first = ++created === 1;
    return {
      hold: first ? "old-invitation" : undefined,
      body: {
        id: first ? "old-pair" : "new-pair",
        code: first ? "111111" : "222222",
        status: "pending",
        expires_at: expiresAt,
      },
    };
  });
  scenario.on("POST", "/api/auth/logout", () => ({ body: { ok: true } }));
  scenario.on("POST", "/api/auth/login", () => {
    scenario.state.session.session_id = "new-session";
    return { body: { ok: true } };
  });
  scenario.on("GET", "/api/auth/pairing-code", (request) => ({ body: {
    id: request.query.id, status: "pending", expires_at: expiresAt,
  } }));
  await openApp(page, scenario, baseURL!);
  await marker(page, "settings-link-device").click();
  await expect.poll(() => scenario.count("POST", "/api/auth/pairing-code")).toBe(1);
  await marker(page, "pair-close").click();
  await marker(page, "btn-logout").click();
  await marker(page, "gate-input").fill("synthetic-ui-password");
  await marker(page, "gate-submit").click();
  await expect(marker(page, "fixture-session")).toHaveText("new-session");
  await marker(page, "settings-link-device").click();
  await expect(marker(page, "pair-code")).toHaveText("222 222");
  await scenario.release("old-invitation");
  await page.clock.runFor(2001);
  await expect.poll(() => scenario.requests
    .filter(request => request.path === "/api/auth/pairing-code" && request.method === "GET")
    .map(request => request.query.id)).toEqual(["new-pair"]);
  await expect(marker(page, "pair-code")).toHaveText("222 222");
});
