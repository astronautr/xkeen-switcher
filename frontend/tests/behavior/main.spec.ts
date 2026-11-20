import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';

test('M01 M02 pending POST completes through journal; late acceptance cannot roll it back', async ({ page, baseURL }) => {
  const scenario = createScenario('M02').switch('held');
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  expect(scenario.requests.find(r => r.method === 'POST')?.body).toMatchObject({ code: 'de' });
  await expect(marker(page, 'active-name')).toContainText('Finland');
  scenario.advance('committed');
  await page.clock.runFor(1600);
  await expect(marker(page, 'active-name')).toContainText('Germany');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('xk_switch_request'))).toBeNull();
  await scenario.release('switch');
  await page.clock.runFor(1600);
  await expect(marker(page, 'active-name')).toContainText('Germany');
  expect(scenario.count('POST', '/api/switch')).toBe(1);
  expect(scenario.failures).toEqual([]);
});
for (const reason of ['busy', 'precondition'] as const) test(`M04 ${reason} refuses intent without deferred switch`, async ({ page, baseURL }) => {
  const scenario = createScenario('M04').switch(reason);
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect(marker(page, 'switch-refusal')).toContainText('was not accepted');
  await expect(marker(page, 'toast')).toContainText(reason === 'busy' ? 'Nothing was queued' : 'cannot perform this action yet');
  expect(await page.evaluate(() => localStorage.getItem('xk_switch_request'))).toBeNull();
  await page.clock.runFor(30_001);
  expect(scenario.count('POST', '/api/switch')).toBe(1);
  await expect(marker(page, 'active-name')).toContainText('Finland');
  expect(scenario.failures).toEqual([]);
});
for (const ime of [false, true]) test(`X04 subscription input and every ancestor remain connected during poll; IME=${ime}`, async ({ page, baseURL }) => {
  const scenario = createScenario('X04');
  await openApp(page, scenario, baseURL!);
  await marker(page, 'subscription-toggle').click();
  const field = marker(page, 'subscription-home-url');
  await field.fill('https://draft.example.invalid/日本');
  await field.evaluate((input: HTMLInputElement, ime) => {
    input.focus(); input.setSelectionRange(8, 13);
    (window as any).focusedAncestors = [];
    for (let node: Node | null = input; node; node = node.parentNode) (window as any).focusedAncestors.push(node);
    (window as any).detachedDuringPoll = false;
    new MutationObserver(records => {
      for (const record of records) for (const removed of record.removedNodes)
        if ((window as any).focusedAncestors.some((node: Node) => removed === node || removed.contains(node)))
          (window as any).detachedDuringPoll = true;
    }).observe(document, { childList: true, subtree: true });
    if (ime) input.dispatchEvent(new CompositionEvent('compositionstart', { data: '日', bubbles: true }));
  }, ime);
  const reads = scenario.count('GET', '/api/status');
  await page.clock.runFor(10_001);
  await expect.poll(() => scenario.count('GET', '/api/status')).toBeGreaterThan(reads);
  if (process.env.UI_NEGATIVE_CONTROL === 'lost-focus') await field.evaluate(input => {
    const parent = input.parentElement!; parent.replaceWith(parent.cloneNode(true));
  });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('https://draft.example.invalid/日本');
  expect(await field.evaluate((input: HTMLInputElement) => ({ connected: (window as any).focusedAncestors.every((node: Node) => node.isConnected),
    detached: (window as any).detachedDuringPoll, selection: [input.selectionStart, input.selectionEnd] })))
    .toEqual({ connected: true, detached: false, selection: [8, 13] });
  expect(scenario.failures).toEqual([]);
});

test('M03 lost response then reload reuses stored UUID after journal 404', async ({ page, baseURL }) => {
  const scenario = createScenario('M03').switch('lost');
  const accept = scenario.handlers.get('POST /api/switch')!;
  let firstIntent: any;
  scenario.on('POST', '/api/switch', async request => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('xk_switch_request')!));
    expect(saved.id).toBe(request.body.operation_id);
    expect(saved.code).toBe(request.body.code);
    firstIntent ||= saved;
    const reply = await accept(request);
    if (scenario.count('POST', '/api/switch') === 1) {
      scenario.on('GET', `/api/routing/operations/${saved.id}`, () => ({ status: 404, body: { error: 'not found' } }));
    }
    return reply;
  });
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  await page.reload();
  await expect(marker(page, 'active-name')).toContainText('Finland');
  await page.clock.runFor(1600);
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(2);
  expect(scenario.requests.filter(r => r.path === '/api/switch').map(r => r.body)).toEqual([
    { code: 'de', operation_id: firstIntent.id }, { code: 'de', operation_id: firstIntent.id },
  ]);
  scenario.advance('committed');
  await page.clock.runFor(1600);
  await expect(marker(page, 'active-name')).toContainText('Germany');
  expect(scenario.failures).toEqual([]);
});

test('M05 second tab follows shared intent without new POST or success toast', async ({ page, context, baseURL }) => {
  const scenario = createScenario('M05').switch('held');
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  const second = await context.newPage();
  await second.clock.install({ time: new Date('2026-11-17T09:00:00Z') });
  await second.clock.pauseAt(new Date('2026-11-17T09:00:00Z'));
  await second.goto('/');
  await expect(marker(second, 'active-name')).toContainText('Finland');
  scenario.advance('committed');
  await second.clock.runFor(1600);
  await expect(marker(second, 'active-name')).toContainText('Germany');
  await expect(marker(second, 'toast')).toHaveCount(0);
  expect(scenario.count('POST', '/api/switch')).toBe(1);
  expect(scenario.failures).toEqual([]);
  await scenario.release('switch');
});

for (const phase of ['unknown', 'recovery_failed', 'unrecognized-phase']) test(`O01 ${phase} never becomes success or releases blocking`, async ({ page, baseURL }) => {
  const scenario = createScenario('O01').switch();
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  scenario.state.status.operation.phase = phase;
  await page.clock.runFor(1600);
  await expect(marker(page, 'active-name')).toContainText('Finland');
  await expect(page.locator('[data-marker="loc-select"][data-code="se"]')).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => localStorage.getItem('xk_switch_request'))).not.toBeNull();
  expect(scenario.failures).toEqual([]);
});

test('O02 ephemeral activity polls status without operations/null', async ({ page, baseURL }) => {
  const scenario = createScenario('O02');
  scenario.state.status.operation = { id: null, ephemeral: true, kind: 'read', phase: 'reading', blocking: true,
    message: 'Reading router inventory', source: 'manual', scope: 'devices' };
  await openApp(page, scenario, baseURL!);
  await marker(page, 'btn-activity').click();
  await expect(marker(page, 'operation-status')).toBeVisible();
  const reads = scenario.count('GET', '/api/status');
  await page.clock.runFor(1600);
  await expect.poll(() => scenario.count('GET', '/api/status')).toBeGreaterThan(reads);
  expect(scenario.requests.filter(r => r.path.includes('/operations/'))).toEqual([]);
  expect(scenario.failures).toEqual([]);
});

test('O05 offline event does not queue a switch or replay on reconnect', async ({ page, baseURL }) => {
  const scenario = createScenario('O05').switch();
  await openApp(page, scenario, baseURL!);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.clock.runFor(10_001);
  expect(scenario.count('POST', '/api/switch')).toBe(1);
  expect(scenario.failures).toEqual([]);
});

test('B04 missing secure-context randomUUID still produces a valid UUID', async ({ page, baseURL }) => {
  const scenario = createScenario('B04').switch();
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  await openApp(page, scenario, baseURL!);
  await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => scenario.count('POST', '/api/switch')).toBe(1);
  expect(scenario.requests.find(r => r.path === '/api/switch')!.body.operation_id)
    .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(scenario.failures).toEqual([]);
});

for (const mode of ['denied', 'corrupt']) test(`B04 ${mode} browser storage still permits a switch`, async ({ page, baseURL }) => {
  const s = createScenario('B04').switch();
  await page.addInitScript(mode => {
    if (mode === 'denied') { Storage.prototype.getItem = () => { throw new DOMException('Denied', 'SecurityError'); }; Storage.prototype.setItem = () => { throw new DOMException('Denied', 'SecurityError'); }; }
    else localStorage.setItem('xk_switch_request', '{malformed');
  }, mode);
  await openApp(page, s, baseURL!); await page.locator('[data-marker="loc-select"][data-code="de"]').click();
  await expect.poll(() => s.count('POST', '/api/switch')).toBe(1);
});

test('B04 legacy code-only stored request retries as single with same UUID', async ({ page, baseURL }) => {
  const s = createScenario('B04').switch(); const id = '33333333-3333-4333-8333-333333333333';
  s.on('GET', `/api/routing/operations/${id}`, () => ({ status: 404, body: { error: 'not found' } }));
  await page.addInitScript(id => localStorage.setItem('xk_switch_request', JSON.stringify({ id, code: 'de', name: 'Germany 🇩🇪', created_at: '2026-11-17T09:00:00Z' })), id);
  await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible(); await page.clock.runFor(1600);
  await expect.poll(() => s.count('POST', '/api/switch')).toBe(1);
  expect(s.requests.find(r => r.path === '/api/switch')!.body).toEqual({ code: 'de', operation_id: id });
});
