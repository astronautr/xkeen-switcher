import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW } from '../support/scenario';

for (const mode of ['password', 'code']) test(`A02 successful ${mode} login establishes dashboard session`, async ({ page, baseURL }) => {
  const s = createScenario('A02'); s.state.session.authenticated = false;
  const path = mode === 'code' ? '/api/auth/pair' : '/api/auth/login';
  s.on('POST', path, r => {
    expect(r.body).toEqual(mode === 'code' ? { code: '123456' } : { password: 'synthetic-ui-password' });
    s.state.session.authenticated = true;
    return { body: { ok: true }, headers: { 'Set-Cookie': 'xk_session=synthetic-session; HttpOnly; SameSite=Lax; Path=/' } };
  });
  await openApp(page, s, baseURL!);
  if (mode === 'code') await marker(page, 'gate-mode').click();
  await marker(page, 'gate-input').fill(mode === 'code' ? '123456' : 'synthetic-ui-password');
  await marker(page, 'gate-submit').click();
  await expect(marker(page, 'active-name')).toContainText('Finland');
  expect((await page.context().cookies()).find(c => c.name === 'xk_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
});

for (const status of [401, 429, 503]) test(`A02 code login ${status} retains input and permits retry`, async ({ page, baseURL }) => {
  const s = createScenario('A02'); s.state.session.authenticated = false;
  s.on('POST', '/api/auth/pair', r => { expect(r.body).toEqual({ code: '123456' }); return { status, body: { error: 'Invalid or expired code' }, headers: status === 429 ? { 'Retry-After': '30' } : {} }; });
  await openApp(page, s, baseURL!); await marker(page, 'gate-mode').click();
  await marker(page, 'gate-input').fill('123456'); await marker(page, 'gate-submit').click();
  await expect(marker(page, 'gate-error')).not.toBeEmpty();
  if (status === 429) await expect(marker(page, 'gate-error')).toContainText('30s');
  await expect(marker(page, 'gate-input')).toHaveValue('123456');
  await expect(marker(page, 'gate-submit')).toBeEnabled();
});

test('A03 password change loads replacement session and revokes other browsers', async ({ page, baseURL }) => {
  const s = createScenario('A03');
  s.on('POST', '/api/auth/password', r => {
    expect(r.body).toEqual({ current_password: 'old-ui-password', password: 'new-ui-password' });
    s.state.sessions.sessions = [{ id: 'replacement', label: 'Browser · device', current: true, created_at: NOW }];
    return { body: { ok: true }, headers: { 'Set-Cookie': 'xk_session=replacement; HttpOnly; SameSite=Lax; Path=/' } };
  });
  await openApp(page, s, baseURL!); await marker(page, 'btn-settings').click();
  await marker(page, 'settings-access').click(); await marker(page, 'btn-change-password').click();
  await marker(page, 'password-current').fill('old-ui-password'); await marker(page, 'password-new').fill('new-ui-password'); await marker(page, 'password-repeat').fill('new-ui-password');
  await marker(page, 'password-submit').click();
  await expect(marker(page, 'device-revoke')).toHaveCount(1);
  await expect(marker(page, 'device-revoke')).toHaveAttribute('data-id', 'replacement');
  expect((await page.context().cookies()).find(c => c.name === 'xk_session')?.value).toBe('replacement');
});

for (const current of [false, true]) test(`A03 revoke ${current ? 'current' : 'other'} browser`, async ({ page, baseURL }) => {
  const s = createScenario('A03');
  s.state.sessions.sessions.push({ id: 'other', label: 'Other browser', current: false, created_at: NOW });
  const id = current ? s.state.sessions.sessions[0].id : 'other';
  s.on('POST', '/api/auth/sessions/revoke', r => {
    expect(r.body).toEqual({ id }); s.state.sessions.sessions = s.state.sessions.sessions.filter((session: any) => session.id !== id);
    return { body: { ok: true, current_revoked: current } };
  });
  await openApp(page, s, baseURL!); await marker(page, 'btn-settings').click(); await marker(page, 'settings-access').click();
  await page.locator(`[data-marker="device-revoke"][data-id="${id}"]`).click();
  if (current) await expect(marker(page, 'gate-input')).toBeVisible();
  else { await expect(marker(page, 'device-revoke')).toHaveCount(1); await expect(marker(page, 'active-name')).toBeVisible(); }
});

test('A03 logout then new login rejects late status from old session', async ({ page, baseURL }) => {
  const s = createScenario('A03');
  s.on('POST', '/api/auth/logout', () => ({ body: { ok: true } }));
  s.on('POST', '/api/auth/login', () => ({ body: { ok: true } }));
  await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible();
  s.on('GET', '/api/status', () => ({ hold: 'old', body: { ...s.state.status, active_code: 'de', active_route: { mode: 'single', exit_code: 'de', exit_name: 'Germany 🇩🇪', entry_code: null, entry_name: null } } }));
  await page.clock.runFor(10_001); await expect.poll(() => s.count('GET', '/api/status')).toBe(2);
  await marker(page, 'btn-settings').click(); await marker(page, 'btn-logout').click();
  await expect(marker(page, 'gate-input')).toBeVisible();
  s.on('GET', '/api/status', () => ({ body: s.state.status }));
  await marker(page, 'gate-input').fill('synthetic-ui-password'); await marker(page, 'gate-submit').click();
  await expect(marker(page, 'active-name')).toContainText('Finland'); await s.release('old');
  await page.clock.runFor(48); await expect(marker(page, 'active-name')).toContainText('Finland');
});

for (const outcome of ['completed', 'expired', 'replaced', 'exhausted']) test(`A04 pending countdown becomes ${outcome} and new code replaces state`, async ({ page, baseURL }) => {
  const s = createScenario('A04'); let generation = 0;
  const expires_at = Date.parse(NOW) / 1000 + 300;
  s.on('POST', '/api/auth/pairing-code', () => ({ body: { id: `code-${++generation}`, code: generation === 1 ? '123456' : '654321', status: 'pending', expires_at } }));
  s.on('GET', '/api/auth/pairing-code', r => { expect(r.query.id).toBe('code-1'); return { body: { id: 'code-1', status: outcome, expires_at, ...(outcome === 'completed' ? { device: { label: 'Safari · iPhone' } } : {}) } }; });
  await openApp(page, s, baseURL!); await marker(page, 'btn-add-device').click();
  await expect(marker(page, 'pair-status')).toHaveText('valid for 5:00'); await page.clock.runFor(1000);
  await expect(marker(page, 'pair-status')).toHaveText('valid for 4:59'); await page.clock.runFor(1001);
  await expect(marker(page, 'pair-result')).not.toBeEmpty(); await expect(marker(page, 'pair-code')).toBeHidden();
  await marker(page, 'pair-new').click(); await expect(marker(page, 'pair-code')).toHaveText('654 321'); await expect(marker(page, 'pair-result')).toBeEmpty();
});

test('A01 mismatched setup preserves both inputs across polling without submitting', async ({ page, baseURL }) => {
  const s = createScenario('A01'); s.state.session = { configured: false, authenticated: false, session_id: null };
  await openApp(page, s, baseURL!);
  await marker(page, 'password-new').fill('synthetic-ui-password'); await marker(page, 'password-repeat').fill('different-ui-password');
  await marker(page, 'password-submit').click(); await expect(marker(page, 'password-error')).toHaveText('passwords do not match');
  await page.clock.runFor(10_001);
  await expect(marker(page, 'password-new')).toHaveValue('synthetic-ui-password'); await expect(marker(page, 'password-repeat')).toHaveValue('different-ui-password');
  expect(s.count('POST', '/api/auth/setup')).toBe(0);
});
