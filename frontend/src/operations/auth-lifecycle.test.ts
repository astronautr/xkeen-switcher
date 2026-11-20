import { expect, it } from "@rstest/core";
import { ApiClient, StaleSessionError } from "../api/client";
import { keys } from "../api/keys";
import { BrowserStorage } from "../browser/storage";
import { SessionRuntime } from "./runtime";
import status from "../../tests/fixtures/status.json";

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
function setup(handler: (path: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const api = new ApiClient(async (input) => {
    calls.push(String(input));
    return handler(String(input));
  });
  const runtime = new SessionRuntime({ api, storage: new BrowserStorage() });
  runtime.queryClient.setQueryData(keys.session, { configured: true, authenticated: true, session_id: "old" });
  return { runtime, calls };
}

it("refused logout retains the authenticated session", async () => {
  const { runtime, calls } = setup(() => json({ error: "Refused" }, 403));
  await expect(runtime.logout()).rejects.toMatchObject({ status: 403 });
  expect(runtime.authenticated).toBe(true);
  expect(calls).toEqual(["/api/auth/logout"]);
});

for (const authenticated of [true, false]) {
  it(`ambiguous logout verifies server session (authenticated=${authenticated}) without retrying POST`, async () => {
    const { runtime, calls } = setup((path) => {
      if (path === "/api/auth/logout") throw new TypeError("Lost reply");
      return json({ configured: true, authenticated, session_id: authenticated ? "old" : null });
    });
    if (authenticated) await expect(runtime.logout()).rejects.toMatchObject({ message: "Lost reply" });
    else await runtime.logout();
    expect(runtime.authenticated).toBe(authenticated);
    expect(calls).toEqual(["/api/auth/logout", "/api/auth/session"]);
  });
}

for (const action of ["password", "login"] as const) {
  it(`${action} cannot report success after replacement bootstrap loses auth`, async () => {
    const { runtime } = setup((path) => path === "/api/auth/session"
      ? json({ configured: true, authenticated: true, session_id: "replacement" })
      : path === "/api/status" ? json({ error: "Unauthorized" }, 401) : json({ ok: true }));
    const promise = action === "password"
      ? runtime.changePassword({ current_password: "synthetic-old", password: "synthetic-new" })
      : runtime.authenticate("login", { password: "synthetic" });
    await expect(promise).rejects.toBeInstanceOf(StaleSessionError);
    expect(runtime.authenticated).toBe(false);
  });
}

it("verified logout clears private cache", async () => {
  const { runtime } = setup(() => json({ ok: true }));
  runtime.queryClient.setQueryData(keys.status, status);
  await runtime.logout();
  expect(runtime.authenticated).toBe(false);
  expect(runtime.queryClient.getQueryData(keys.status)).toBeUndefined();
});

it("replacement bootstrap with an already revoked cookie cannot deliver password success", async () => {
  const { runtime } = setup((path) => path === "/api/auth/session"
    ? json({ configured: true, authenticated: false, session_id: null }) : json({ ok: true }));
  await expect(runtime.changePassword({ current_password: "synthetic-old", password: "synthetic-new" }))
    .rejects.toBeInstanceOf(StaleSessionError);
  expect(runtime.authenticated).toBe(false);
});

it("ambiguous logout discards private state when the server confirms another identity", async () => {
  const replacement = { configured: true, authenticated: true, session_id: "replacement" };
  const { runtime, calls } = setup(path => {
    if (path === "/api/auth/logout") throw new TypeError("Lost reply");
    return path === "/api/auth/session" ? json(replacement) : json(status);
  });
  runtime.queryClient.setQueryData(keys.sessions, { sessions: [{ id: "old-private" }] });
  await expect(runtime.logout()).rejects.toBeInstanceOf(StaleSessionError);
  expect(runtime.queryClient.getQueryData(keys.sessions)).toBeUndefined();
  expect(runtime.queryClient.getQueryData(keys.session)).toEqual(replacement);
  expect(calls.filter(path => path === "/api/auth/logout")).toHaveLength(1);
});
