import { test, expect } from '../support/test';

test('B01 B02 native dev proxy preserves real setup/login/POST/logout and rejects foreign Origin', async ({ page, context }) => {
  const origin = `http://127.0.0.1:${process.env.UI_PROXY_PORT}`;
  await page.goto(origin);
  await expect(page.locator('[data-marker="react-shell"]')).toBeAttached();
  const session = await (await context.request.get(origin + '/api/auth/session')).json();
  const headers = { 'X-XK-Request': '1', Origin: origin };
  expect(session.configured).toBe(false);
  {
    const setup = await context.request.post(origin + '/api/auth/setup', { data: { password: 'synthetic-ui-password' }, headers });
    expect(setup.status()).toBe(200);
    expect((await context.request.post(origin + '/api/auth/logout', { data: {}, headers })).status()).toBe(200);
  }
  // fetch uses the browser's actual Origin, Host and cookie store through Rspack.
  const login = await page.evaluate(async () => {
    const result = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-XK-Request': '1' },
      body: JSON.stringify({ password: 'synthetic-ui-password' }) });
    return result.status;
  });
  expect(login).toBe(200);
  const cookie = (await context.cookies(origin)).find(item => item.name === 'xk_session');
  expect(cookie).toMatchObject({ path: '/', httpOnly: true, sameSite: 'Lax' });
  const applied = await page.evaluate(async () => (await fetch('/api/probe', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XK-Request': '1' }, body: JSON.stringify({ code: 'fi' }) })).status);
  expect(applied).toBe(200);
  for (const foreign of ['http://foreign.invalid', 'null']) {
    const denied = await context.request.post(origin + '/api/probe', { data: { code: 'fi' }, headers: { ...headers, Origin: foreign } });
    expect(denied.status()).toBe(403);
    expect(denied.headers()['access-control-allow-origin']).toBeUndefined();
  }
  expect((await context.request.post(origin + '/api/auth/logout', { data: {}, headers })).status()).toBe(200);
  expect((await context.request.get(origin + '/api/status')).status()).toBe(401);
});
