import { test, expect } from "../../support/test";
import { verifyRoutingRoundTrip } from "../../support/routing-roundtrip";

test("draft, preview, apply and restore use the Python fixture journal and exact snapshot bytes", async ({
  page,
  context,
  baseURL,
}) => {
  const login = await context.request.post("/api/auth/login", {
    headers: { Origin: baseURL!, "X-XK-Request": "1" },
    data: { password: "synthetic-ui-password" },
  });
  expect(login.status()).toBe(200);
  await verifyRoutingRoundTrip(page, context);
});
