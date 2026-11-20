import { test, expect } from '../support/test';
import { marker } from "../support/scenario";
import { verifyRoutingRoundTrip } from "../support/routing-roundtrip";
import { changedDeviceId } from "../support/devices";

test('B01 B02 real HTTP setup, cookies, Origin, static paths and logout without interception', async ({ page, context, request }) => {
  await page.goto('/');
  await expect(marker(page, 'react-shell')).toBeAttached();
  const catalog = await context.newPage();
  await catalog.goto('/styleguide.html');
  await expect(catalog.getByRole('heading', { name: 'xkeen.switch · components' })).toBeVisible();
  await catalog.close();
  for (const path of ['/__ui-next__/', '/__ui-next__/styleguide.html']) {
    expect((await request.get(path)).status()).toBe(404);
  }
  for (const [path, mime] of Object.entries({
    "/icon-light.svg": "image/svg+xml", "/icon-dark.svg": "image/svg+xml",
    "/mobile-icons.svg": "image/svg+xml", "/apple-touch-icon.png": "image/png",
    "/manifest.webmanifest": "application/manifest+json",
  })) {
    const asset = await request.get(path);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toContain(mime);
    expect((await asset.body()).length).toBeGreaterThan(0);
  }
  await page.locator('[data-marker="password-new"]').fill('synthetic-ui-password');
  await page.locator('[data-marker="password-repeat"]').fill('synthetic-ui-password');
  await page.locator('[data-marker="password-submit"]').click();
  await expect(page.locator('[data-marker="active-name"]')).toContainText('Finland');
  await expect(page.locator('a[href*="styleguide"], a[href*="catalog"]')).toHaveCount(0);
  const cookie = (await context.cookies()).find(item => item.name === 'xk_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  const forbidden = await context.request.post('/api/update', { data: {}, headers: { 'X-XK-Request': '1', Origin: 'http://foreign.invalid' } });
  expect(forbidden.status()).toBe(403);
  const html = await (await request.get('/')).text();
  const compiled = [...html.matchAll(/(?:src|href)="(\/ui-assets\/[^"]+)"/g)].map(match => match[1]!);
  expect(compiled.some(path => path.endsWith('.js'))).toBe(true);
  expect(compiled.some(path => path.endsWith('.css'))).toBe(true);
  const paths = ['/manifest.webmanifest', '/theme-boot.js', ...compiled];
  for (const path of paths) {
    const result = await request.get(path);
    expect(result.status()).toBe(200);
    expect(result.headers()['content-type']).not.toContain('text/html');
    expect(Number(result.headers()['content-length'])).toBe((await result.body()).length);
    if (path.startsWith('/ui-assets/')) {
      expect(result.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(result.headers()['content-type']).toBe(path.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
    } else expect(result.headers()['cache-control']).toBe('no-cache');
  }
  expect((await request.get('/')).headers()['cache-control']).toBe('no-cache');
  expect((await (await request.get('/manifest.webmanifest')).json()).start_url).toBe('/');
  const applying = page.waitForResponse(response =>
    response.url().endsWith("/api/switch") && response.request().method() === "POST");
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  const accepted = await applying;
  expect(accepted.status()).toBe(202);
  const { operation } = await accepted.json();
  expect(operation.id).toBe(accepted.request().postDataJSON().operation_id);
  await page.reload();
  await expect(marker(page, "active-name")).toContainText("Germany", { timeout: 15_000 });
  const journal = await context.request.get("/api/routing/operations/" + operation.id);
  expect(await journal.json()).toMatchObject({ id: operation.id, phase: "committed" });

  await marker(page, "devices-toggle").click();
  await marker(page, "unregister-" + changedDeviceId).click();
  await marker(page, "confirm-unregister-" + changedDeviceId).click();
  await expect(marker(page, "register-" + changedDeviceId)).toBeVisible();
  await page.reload();
  await marker(page, "btn-activity").click();
  await marker(page, "device-history-undo").click();
  await expect.poll(async () => {
    const inventory = await (await context.request.get("/api/devices")).json();
    return inventory.operations[0]?.phase;
  }).toBe("undone");
  await verifyRoutingRoundTrip(page, context);
  for (const path of ['/ui-assets/missing.js', '/ui-assets/app.js.map', '/asset-manifest.json', '/ui-assets/%252e%252e/private.js', '/api/not-present']) {
    const refused = await request.get(path);
    expect(refused.status()).not.toBe(200);
    expect(refused.headers()['content-type']).not.toContain('text/html');
  }
  const logout = await context.request.post('/api/auth/logout', { data: {}, headers: { 'X-XK-Request': '1' } });
  expect(logout.status()).toBe(200);
  expect((await context.request.get('/api/status')).status()).toBe(401);
});
