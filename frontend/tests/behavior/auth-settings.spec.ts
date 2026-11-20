import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';

test('A01 setup validates confirmation, retains input, then enters dashboard', async ({ page, baseURL }) => {
  const s = createScenario('A01'); s.state.session = { configured: false, authenticated: false, session_id: null };
  s.on('POST', '/api/auth/setup', r => { expect(r.body).toEqual({ password: 'synthetic-ui-password' }); s.state.session = { configured: true, authenticated: true, session_id: 'fixture-session' }; return { body: { ok: true } }; });
  await openApp(page, s, baseURL!);
  await marker(page, 'password-new').fill('synthetic-ui-password'); await marker(page, 'password-repeat').fill('different-value');
  await marker(page, 'password-submit').click(); await expect(marker(page, 'password-error')).toContainText('do not match');
  expect(s.count('POST', '/api/auth/setup')).toBe(0);
  await page.clock.runFor(10_001); await expect(marker(page, 'password-new')).toHaveValue('synthetic-ui-password');
  await marker(page, 'password-repeat').fill('synthetic-ui-password'); await marker(page, 'password-submit').click();
  await expect(marker(page, 'active-name')).toContainText('Finland');
});

for (const status of [401, 429, 503]) test(`A02 password login ${status} stays inline`, async ({ page, baseURL }) => {
  const s = createScenario('A02'); s.state.session.authenticated = false;
  s.on('POST', '/api/auth/login', () => ({ status, body: { error: 'Login unavailable' }, headers: status === 429 ? { 'Retry-After': '30' } : {} }));
  await openApp(page, s, baseURL!); await marker(page, 'gate-input').fill('synthetic-ui-password'); await marker(page, 'gate-submit').click();
  await expect(marker(page, 'gate-error')).not.toBeEmpty();
  if (status === 429) await expect(marker(page, 'gate-error')).toContainText('30s');
  await expect(marker(page, 'gate-input')).toBeVisible(); expect(s.count('POST', '/api/auth/login')).toBe(1);
});

test('A03 logout ignores a delayed old status response', async ({ page, baseURL }) => {
  const s = createScenario('A03');
  s.on('POST', '/api/auth/logout', () => ({ body: { ok: true } }));
  await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible();
  s.on('GET', '/api/status', () => ({ hold: 'old-status', body: { ...s.state.status, active_code: 'de' } }));
  await page.clock.runFor(10_001); await expect.poll(() => s.count('GET', '/api/status')).toBe(2);
  await marker(page, 'btn-settings').click(); await marker(page, 'btn-logout').click();
  await expect(marker(page, 'gate-input')).toBeVisible(); await s.release('old-status');
  await expect(marker(page, 'active-name')).toHaveCount(0); await expect(marker(page, 'gate-input')).toBeVisible();
});

test('S01 subscription save sends exact edited value', async ({ page, baseURL }) => {
  const s = createScenario('S01'); s.on('POST', '/api/sub-url', r => { expect(r.body).toEqual({ url: 'https://new.example.invalid/sub' }); return { body: { ok: true } }; });
  await openApp(page, s, baseURL!); await marker(page, 'subscription-toggle').click();
  await marker(page, 'subscription-home-url').fill('https://new.example.invalid/sub');
  await marker(page, 'subscription-home-save').click();
  await expect.poll(() => s.count('POST', '/api/sub-url')).toBe(1);
});

test('S02 failed explicit pending apply keeps pending banner', async ({ page, baseURL }) => {
  const s = createScenario('S02'); Object.assign(s.state.status, { pending_reapply_code: 'fi', pending_update_kind: 'config' });
  s.on('POST', '/api/active-refresh', () => ({ status: 503, body: { error: 'Subscription refresh failed', code: 'unavailable' } }));
  await openApp(page, s, baseURL!); await marker(page, 'btn-apply-active-config').click();
  await expect(marker(page, 'toast')).toBeVisible();
  await expect(marker(page, 'pending-active-config')).toHaveAttribute('data-state', 'pending');
  expect(s.count('POST', '/api/active-refresh')).toBe(1);
});

test('S03 interval schedule draft survives status poll and sends preserved SNI option', async ({ page, baseURL }) => {
  const s = createScenario('S03'); Object.assign(s.state.status.auto_update, { mode: 'interval', sni_daily: true });
  s.on('PUT', '/api/auto-update', r => { expect(r.body).toEqual({ enabled: true, mode: 'interval', daily_time: '04:30', interval_minutes: 5, sni_daily: true }); return { body: { ok: true, config: { ...s.state.status.auto_update, ...r.body } } }; });
  await openApp(page, s, baseURL!); await marker(page, 'btn-settings').click(); await marker(page, 'settings-subscription').click();
  await marker(page, 'auto-update-interval').fill('5'); await page.clock.runFor(10_001); await expect(marker(page, 'auto-update-interval')).toHaveValue('5');
  await marker(page, 'settings-save').click(); await expect.poll(() => s.count('PUT', '/api/auto-update')).toBe(1);
});

test('S06 failover whitelist selection is draft until save', async ({ page, baseURL }) => {
  const s = createScenario('S06'); s.on('PUT', '/api/failover/config', r => { expect(r.body.whitelist).toEqual(['de']); return { body: { ok: true, config: { schema_version: 1, ...r.body } } }; });
  await openApp(page, s, baseURL!); await marker(page, 'btn-settings').click(); await marker(page, 'settings-failover').click();
  await marker(page, 'wl-check-de').check(); expect(s.count('PUT', '/api/failover/config')).toBe(0);
  await marker(page, 'settings-save').click(); await expect.poll(() => s.count('PUT', '/api/failover/config')).toBe(1);
});

test('S07 editable connectivity values survive poll and save exact list', async ({ page, baseURL }) => {
  const s = createScenario('S07'); s.on('PUT', '/api/connectivity', r => { expect(r.body.check_urls[0]).toBe('https://check.example.invalid/health'); return { body: { ok: true, config: { schema_version: 1, ...r.body } } }; });
  await openApp(page, s, baseURL!); await marker(page, 'btn-settings').click(); await marker(page, 'settings-checks').click();
  const input = marker(page, 'connectivity-url-input').first(); await input.fill('https://check.example.invalid/health');
  await page.clock.runFor(10_001); await expect(input).toHaveValue('https://check.example.invalid/health');
  await marker(page, 'settings-save').click(); await expect.poll(() => s.count('PUT', '/api/connectivity')).toBe(1);
});

for (const minutes of [4, 5, 10080, 10081]) test(`S03 interval boundary ${minutes} validates before saving`, async ({page,baseURL}) => {
  const s=createScenario('S03'); Object.assign(s.state.status.auto_update,{mode:'interval',sni_daily:true});
  s.on('PUT','/api/auto-update',r=>{expect(r.body.interval_minutes).toBe(minutes);expect(r.body.sni_daily).toBe(true);return {body:{ok:true,config:r.body}}});
  await openApp(page,s,baseURL!);await marker(page,'btn-settings').click();await marker(page,'settings-subscription').click();
  await marker(page,'auto-update-interval').fill(String(minutes));await marker(page,'settings-save').click();
  if(minutes<5||minutes>10080){
    expect(s.count('PUT','/api/auto-update')).toBe(0);
    expect(await marker(page,'auto-update-interval').evaluate((el:HTMLInputElement)=>el.validity.valid)).toBe(false);
    await expect(marker(page,'auto-update-interval')).toHaveValue(String(minutes));
  }else await expect.poll(()=>s.count('PUT','/api/auto-update')).toBe(1);
});
test('S03 daily Moscow time keeps hidden interval SNI preference',async({page,baseURL})=>{
 const s=createScenario('S03');Object.assign(s.state.status.auto_update,{mode:'interval',sni_daily:true});
 s.on('PUT','/api/auto-update',r=>{expect(r.body).toEqual({enabled:true,mode:'daily',daily_time:'05:45',interval_minutes:1440,sni_daily:true});return {body:{ok:true,config:r.body}}});
 await openApp(page,s,baseURL!);await marker(page,'btn-settings').click();await marker(page,'settings-subscription').click();
 await marker(page,'auto-update-mode').selectOption('daily');await expect(marker(page,'auto-update-sni-daily')).toHaveCount(0);
 await marker(page,'auto-update-time').fill('05:45');await expect(marker(page,'auto-update-section')).toContainText('Moscow (UTC+3)');
 await marker(page,'settings-save').click();await expect.poll(()=>s.count('PUT','/api/auto-update')).toBe(1);
});

for (const kind of ["interval", "daily time", "SNI time", "disabled"] as const) {
  test(`schedule restores the last valid ${kind} value when leaving the field`, async ({ page, baseURL }) => {
    const scenario = createScenario("S03");
    const usesInterval = kind !== "daily time";
    Object.assign(scenario.state.status.auto_update, { mode: usesInterval ? "interval" : "daily", sni_daily: kind === "SNI time" });
    await openApp(page, scenario, baseURL!);
    await marker(page, "btn-settings").click();
    await marker(page, "settings-subscription").click();

    const interval = kind === "interval" || kind === "disabled";
    const field = marker(page, interval ? "auto-update-interval" : kind === "SNI time" ? "auto-update-sni-time" : "auto-update-time");
    await field.fill(interval ? "120" : "05:45");
    await field.fill("");
    if (kind === "disabled") await marker(page, "auto-update-enabled").uncheck();
    else if (kind === "SNI time") await marker(page, "auto-update-sni-daily").uncheck();
    else await marker(page, "auto-update-mode").selectOption(usesInterval ? "daily" : "interval");

    scenario.on("PUT", "/api/auto-update", (request) => {
      expect(request.body).toMatchObject(interval ? { interval_minutes: 120 } : { daily_time: "05:45" });
      return { body: { ok: true, config: request.body } };
    });
    await marker(page, "settings-save").click();
    await expect.poll(() => scenario.count("PUT", "/api/auto-update")).toBe(1);
  });
}

test('S06 priority and auto-stop dependency stay draft and save exact constrained config',async({page,baseURL})=>{
 const s=createScenario('S06');Object.assign(s.state.failover.config,{enabled:true,whitelist:['de','fi'],auto_stop_on_total_failure:true,auto_restart_on_recovery:true});
 s.on('PUT','/api/failover/config',r=>{expect(r.body).toEqual({schema_version:1,enabled:true,auto_failback:false,auto_stop_on_total_failure:false,auto_restart_on_recovery:false,whitelist:['fi','de']});return {body:{ok:true,config:r.body}}});
 await openApp(page,s,baseURL!);await marker(page,'btn-settings').click();await marker(page,'settings-failover').click();
 await marker(page,'wl-up-fi').click();await expect(marker(page,'wl-up-fi')).toBeDisabled();
 await marker(page,'fo-stop').uncheck();await expect(marker(page,'fo-restart')).not.toBeChecked();await expect(marker(page,'fo-restart')).toBeDisabled();
 expect(s.count('PUT','/api/failover/config')).toBe(0);await marker(page,'settings-save').click();await expect.poll(()=>s.count('PUT','/api/failover/config')).toBe(1);
});
