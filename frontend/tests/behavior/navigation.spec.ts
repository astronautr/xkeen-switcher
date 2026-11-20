import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW } from '../support/scenario';

test('M06 chain draft survives polling, selection sends nothing, Apply sends both nodes', async ({ page, baseURL }) => {
  const scenario = createScenario('M06').switch();
  await openApp(page, scenario, baseURL!);
  await marker(page, 'main-mode-chain').click();
  await marker(page, 'chain-entry').click();
  await marker(page, 'chain-entry-option-de').click();
  await marker(page, 'chain-exit').click();
  await marker(page, 'chain-exit-option-se').click();
  await page.clock.runFor(10_001);
  await expect(marker(page, 'chain-entry')).toContainText('Germany');
  await expect(marker(page, 'chain-exit')).toContainText('Sweden');
  expect(scenario.count('POST', '/api/switch')).toBe(0);
  await marker(page, 'chain-apply').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  expect(scenario.requests.find(r => r.path === '/api/switch')!.body).toMatchObject({ code: 'se', entry_code: 'de' });
  expect(scenario.failures).toEqual([]);
});

test('S04 stop requires confirmation; cancel never sends a mutation', async ({ page, baseURL }) => {
  const scenario = createScenario('S04');
  scenario.on('POST', '/api/xkeen', request => {
    expect(request.body).toEqual({ action: 'stop' });
    scenario.state.status.xkeen_state = 'stopped'; return { body: { ok: true } };
  });
  await openApp(page, scenario, baseURL!);
  await marker(page, 'btn-xkeen-toggle').click();
  await marker(page, 'xkeen-stop-confirm-cancel').click();
  expect(scenario.count('POST', '/api/xkeen')).toBe(0);
  await marker(page, 'btn-xkeen-toggle').click();
  await marker(page, 'xkeen-stop-confirm-confirm').click();
  await expect.poll(() => scenario.count('POST', '/api/xkeen')).toBe(1);
  expect(scenario.failures).toEqual([]);
});

for (const key of ['Enter', 'Space', 'click']) test(`S05 ${key} on probe never selects location`, async ({ page, baseURL }) => {
  const scenario = createScenario('S05');
  scenario.on('POST', '/api/probe', () => ({ body: { fi: { ok: true, latency_ms: 24 } } }));
  await openApp(page, scenario, baseURL!);
  const button = page.locator('[data-marker="btn-probe"][data-code="de"]');
  if (key === 'click') await button.click(); else { await button.focus(); await button.press(key); }
  await expect.poll(() => scenario.count('POST', '/api/probe')).toBe(1);
  expect(scenario.count('POST', '/api/switch')).toBe(0);
  expect(scenario.requests.find(r => r.path === '/api/probe')!.body).toEqual({ code: 'de' });
  expect(scenario.failures).toEqual([]);
});

test('A04 pairing dialog closes polling and returns focus', async ({ page, baseURL }) => {
  const scenario = createScenario('A04');
  const code = { id: 'fixture-pair', code: '123456', status: 'pending', expires_at: Date.parse(NOW) / 1000 + 300 };
  scenario.on('POST', '/api/auth/pairing-code', () => ({ body: code }));
  scenario.on('GET', '/api/auth/pairing-code', request => { expect(request.query).toEqual({ id: code.id }); return { body: code }; });
  await openApp(page, scenario, baseURL!);
  await marker(page, 'btn-add-device').click();
  await expect(marker(page, 'pair-code')).toHaveText('123 456');
  await page.clock.runFor(2001);
  await expect.poll(() => scenario.count('GET', '/api/auth/pairing-code')).toBeGreaterThan(0);
  await marker(page, 'pair-close').click();
  await page.clock.runFor(1);
  await expect(marker(page, 'pair-dialog')).not.toBeVisible();
  const reads = scenario.count('GET', '/api/auth/pairing-code');
  // The dialog's 2s timer stops; the independent 10s status timer may check a pending code.
  await page.clock.runFor(6000);
  expect(scenario.count('GET', '/api/auth/pairing-code')).toBe(reads);
  await expect(marker(page, 'btn-add-device')).toBeFocused();
  expect(scenario.failures).toEqual([]);
});

test('R02 add rule then cancel does not write a draft', async ({ page, baseURL }) => {
  const scenario = createScenario('R02');
  await openApp(page, scenario, baseURL!);
  await marker(page, 'nav-routing').click();
  await marker(page, 'routing-add').click();
  await expect(marker(page, 'rule-name')).toBeVisible();
  await marker(page, 'rule-cancel').click();
  await expect(marker(page, 'routing-add')).toBeVisible();
  expect(scenario.requests.filter(r => r.method !== 'GET')).toEqual([]);
  expect(scenario.failures).toEqual([]);
});
