import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';
import { confirmedChain, ephemeralActivity, serverContext, hysteriaChain } from '../support/main-contracts';

test('M03 lost chain acceptance and reload replay the exact UUID, Entry and Exit', async ({ page, baseURL }) => {
  const s = createScenario('M03:chain').switch('lost');
  const accept = s.handlers.get('POST /api/switch')!;
  let first: Record<string, unknown>;
  s.on('POST', '/api/switch', async request => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xk_switch_request')!));
    expect(saved).toMatchObject({ id: request.body.operation_id, code: 'se', entry_code: 'de', mode: 'chain' });
    first ||= structuredClone(request.body);
    const response = await accept(request);
    if (s.count('POST', '/api/switch') === 1) s.on('GET', `/api/routing/operations/${saved.id}`, () => ({ status: 404, body: { error: 'Operation not found' } }));
    return response;
  });
  await openApp(page, s, baseURL!);
  await marker(page, 'main-mode-chain').click();
  await marker(page, 'chain-entry').click(); await marker(page, 'chain-entry-option-de').click();
  await marker(page, 'chain-exit').click(); await marker(page, 'chain-exit-option-se').click();
  await marker(page, 'chain-apply').click();
  await expect.poll(() => s.count('POST', '/api/switch')).toBe(1);
  await page.reload(); await expect(marker(page, 'active-name')).toContainText('Finland');
  await expect(marker(page, 'main-switch-status')).toBeVisible();
  await expect(marker(page, 'main-mode-chain')).toHaveAttribute('aria-pressed', 'true');
  await expect(marker(page, 'chain-entry')).toBeDisabled();
  await expect(marker(page, 'chain-exit')).toBeDisabled();
  await page.clock.runFor(1600);
  await expect.poll(() => s.count('POST', '/api/switch')).toBe(2);
  expect(s.requests.filter(r => r.path === '/api/switch').map(r => r.body)).toEqual([first!, first!]);
  s.advance('committed'); await page.clock.runFor(1600);
  await expect(marker(page, 'active-name')).toHaveText('Germany 🇩🇪 → Sweden 🇸🇪');
  expect(await page.evaluate(() => localStorage.getItem('xk_switch_request'))).toBeNull();
});

test('M07 Hysteria chain stays unverified despite healthy TCP and keeps failover suspended', async ({ page, baseURL }) => {
  const s = createScenario('M07:hysteria'); hysteriaChain(s);
  await openApp(page, s, baseURL!);
  await expect(marker(page, 'chain-hysteria-hint')).toContainText('Hysteria in chains is unverified');
  await expect(marker(page, 'chain-health').first()).toHaveText('unverified');
  await expect(marker(page, 'active-name')).toHaveText('Germany 🇩🇪 → Sweden 🇸🇪');
  await expect(marker(page, 'failover-paused')).toBeVisible();
  await expect(marker(page, 'chain-exit')).toHaveAccessibleName('Exit location: Sweden 🇸🇪');
  await marker(page, 'chain-exit').click();
  await marker(page, 'chain-exit-option-fi').click();
  await expect(marker(page, 'chain-hysteria-hint')).toHaveCount(0);
  await marker(page, 'chain-exit').click();
  const hysteria = marker(page, 'chain-exit-option-se');
  await expect(hysteria).toHaveAccessibleName('Sweden 🇸🇪');
  await hysteria.click();
  await expect(marker(page, 'chain-hysteria-hint')).toBeVisible();
  await page.clock.runFor(30_001);
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test("M08 a fixed server exit and a confirmed two-node Main stay distinct", async ({ page, baseURL }) => {
  const scenario = createScenario("M08:fixed-chain");
  confirmedChain(scenario, "se", "fi");
  serverContext(scenario, "fixed");
  scenario.state.status.server_route.main_route = scenario.state.status.active_route;
  await openApp(page, scenario, baseURL!);
  await expect(marker(page, "active-name")).toContainText("Germany");
  await expect(marker(page, "outbound-default")).toContainText("Sweden 🇸🇪 → Finland 🇫🇮");
});

test('M06 new confirmed pair replaces a draft; selecting the same exit in Single removes Entry', async ({ page, baseURL }) => {
  const s = createScenario('M06:confirmed').switch(); confirmedChain(s);
  await openApp(page, s, baseURL!);
  await expect(marker(page, 'chain-entry')).toContainText('Germany');
  await marker(page, 'chain-entry').click(); await marker(page, 'chain-entry-option-se').click();
  await page.clock.runFor(10_001);
  await expect(marker(page, 'chain-entry')).toContainText('Sweden');
  confirmedChain(s, 'fi', 'de'); await page.clock.runFor(10_001);
  await expect(marker(page, 'chain-entry')).toContainText('Finland');
  await expect(marker(page, 'chain-exit')).toContainText('Germany');
  expect(s.count('POST', '/api/switch')).toBe(0);
  await marker(page, 'main-mode-single').click();
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => s.count('POST', '/api/switch')).toBe(1);
  const request = s.requests.find(r => r.path === '/api/switch')!.body;
  expect(request.code).toBe('de'); expect(request.entry_code ?? null).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('xk_switch_request')!).entry_code)).toBeNull();
});

for (const missing of ['de', 'fi']) test(`M07 missing chain ${missing} keeps installed pair and does not select fallback`, async ({ page, baseURL }) => {
  const s = createScenario(`M07:missing-${missing}`); confirmedChain(s);
  s.state.status.available = s.state.status.available.filter((loc: { code: string }) => loc.code !== missing);
  Object.assign(s.state.status, { active_status: 'stale', active_missing_codes: [missing] });
  await openApp(page, s, baseURL!);
  await expect(marker(page, 'banner-stale-active')).toContainText(missing === 'de' ? 'entry Germany' : 'exit Finland');
  await expect(marker(page, 'active-name')).toHaveText('Germany 🇩🇪 → Finland 🇫🇮');
  await expect(marker(page, 'failover-paused')).toBeVisible();
  await page.clock.runFor(30_001);
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

for (const scope of ['diagnostic', 'router'] as const) test(`O02 ephemeral ${scope} retains blocking without a journal request`, async ({ page, baseURL }) => {
  const s = createScenario(`O02:${scope}`); ephemeralActivity(s, scope);
  await openApp(page, s, baseURL!);
  await expect(page.locator('[data-marker="loc-select"][data-code="de"]')).toBeDisabled();
  await marker(page, 'btn-activity').click();
  await expect(marker(page, 'activity-now')).toContainText(scope === 'diagnostic' ? 'Checking server route' : 'Refreshing subscription');
  await page.clock.runFor(20_001);
  expect(s.requests.filter(r => r.path.startsWith('/api/routing/operations/'))).toEqual([]);
  await expect.poll(() => s.count('GET', '/api/status')).toBeGreaterThan(1);
});

for (const mode of ['main', 'fixed', 'outside', 'unknown'] as const) test(`M08 ${mode} server attribution is explicit and cannot borrow another route health`, async ({ page, baseURL }) => {
  const s = createScenario(`M08:${mode}`); serverContext(s, mode);
  const health = { ok: mode === 'main', tcp_ok: mode === 'main', probe_method: 'tcp', last_latency_ms: mode === 'main' ? 24 : null };
  s.state.status.available.find((loc: { code: string }) => loc.code === 'fi').health = health;
  s.state.status.active_health = structuredClone(health);
  await openApp(page, s, baseURL!);
  if (mode === 'fixed') {
    await expect(marker(page, 'active-name')).toContainText('Germany');
    await expect(marker(page, 'outbound-default')).toContainText('Finland');
    await expect(marker(page, 'route-check-scope')).toContainText('Main HTTP unchecked');
  } else {
    await expect(marker(page, 'active-name')).toContainText('Finland');
    if (mode === 'main') await expect(marker(page, 'route-check-scope')).toHaveCount(0);
    else await expect(marker(page, 'route-check-scope')).toContainText(mode === 'outside' ? 'outside XKeen' : 'Server unknown');
  }
  if (mode !== 'unknown') await expect(marker(page, 'route-check-result')).toContainText('server route ok');
  await expect(page.locator('[data-marker="loc-row"][data-code="fi"] .health')).toContainText(mode === 'main' ? '24 ms' : 'unreachable');
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});
