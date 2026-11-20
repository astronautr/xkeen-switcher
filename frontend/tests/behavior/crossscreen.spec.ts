import { touchSequence } from "../support/touch";
import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';

for (const health of [true, false, null]) test(`M07 chain route health ${health} ignores healthy node TCP`, async ({ page, baseURL }) => {
  const s = createScenario('M07'); Object.assign(s.state.status, { active_entry_code: 'de', active_route: { mode: 'chain', exit_code: 'fi', exit_name: 'Finland 🇫🇮', entry_code: 'de', entry_name: 'Germany 🇩🇪' }, active_health: { route_ok: health, tcp_ok: true } });
  Object.assign(s.state.status.failover, { enabled: true, suspended: true, suspension_reason: 'chain_active', whitelist: ['fi', 'se'] });
  await openApp(page, s, baseURL!); await expect(marker(page, 'failover-paused')).toBeVisible();
  await expect(marker(page, 'chain-health').first()).toContainText(health === null ? 'unverified' : health ? 'working' : 'failed');
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('M08 fixed server keeps Server and Default labels separate', async ({ page, baseURL }) => {
  const s = createScenario('M08'); Object.assign(s.state.status.server_route, { mode: 'fixed', identified: true, device_id: '02:00:00:00:00:10', device_name: 'Fixture server', follows_main: false, code: 'de', location: { code: 'de', name: 'Germany 🇩🇪', host: 'de.example.invalid', port: 443, protocol: 'vless' } });
  await openApp(page, s, baseURL!); await expect(marker(page, 'outbound-scope')).toContainText('Server');
  await expect(marker(page, 'outbound-default')).toContainText('Finland'); await expect(marker(page, 'active-name')).toContainText('Germany');
});

test('O03 hidden status polling pauses and visibility return refreshes once', async ({ page, baseURL }) => {
  const s = createScenario('O03'); await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible();
  await page.clock.runFor(10_001); await expect.poll(() => s.count('GET', '/api/status')).toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(30_000); expect(s.count('GET', '/api/status')).toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => s.count('GET', '/api/status')).toBe(3);
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('O04 network failure retains confirmed route then recovers without mutation', async ({ page, baseURL }) => {
  const s = createScenario('O04'); await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toContainText('Finland');
  s.on('GET', '/api/status', () => ({ abort: true })); await page.clock.runFor(10_001);
  await expect(marker(page, 'offline-state')).toBeVisible(); await expect(marker(page, 'active-name')).toContainText('Finland');
  s.on('GET', '/api/status', () => ({ body: s.state.status })); await marker(page, 'offline-retry').click();
  await expect(marker(page, 'offline-state')).toHaveCount(0); expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('R07 drift stops editing and exposes explicit resolution', async ({ page, baseURL }) => {
  const s = createScenario('R07'); s.state.routing.drift = true; await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click();
  await expect(marker(page, 'routing-add')).toBeDisabled(); await marker(page, 'resolve-conflict').click();
  await expect(marker(page, 'conflict-close')).toBeVisible(); expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('X05 keyboard menu Escape returns focus without applying route', async ({ page, baseURL }) => {
  const s = createScenario('X05'); await openApp(page, s, baseURL!); await marker(page, 'main-mode-chain').click();
  await marker(page, 'chain-entry').focus(); await marker(page, 'chain-entry').press('Enter');
  await expect(marker(page, 'chain-entry-option-de')).toBeVisible(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
  await expect(marker(page, 'chain-entry')).toBeFocused(); await expect(marker(page, 'chain-entry-option-de')).not.toBeVisible();
  expect(s.count('POST', '/api/switch')).toBe(0);
});

test('X06 synthetic standalone pull reaches release threshold and touchcancel prevents reload', async ({ page, baseURL }) => {
  const s = createScenario('X06');
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible();
  await touchSequence(page.locator("body"), [["touchstart", 20], ["touchmove", 170]]);
  await expect(marker(page, 'pull-to-refresh')).toContainText('Release to refresh');
  expect(s.count('GET', '/api/auth/session')).toBe(1);
  await touchSequence(page.locator("body"), [["touchcancel", 170]]);
  await expect(marker(page, 'pull-to-refresh')).not.toBeVisible();
  expect(s.count('GET', '/api/auth/session')).toBe(1);
});

test('X07 normal wave changes canvas; reduced motion stabilizes it', async ({ page, baseURL }) => {
  const s = createScenario('X07'); await page.emulateMedia({ reducedMotion: 'no-preference' }); await openApp(page, s, baseURL!);
  const canvas = marker(page, 'power-wave'); await expect(canvas).toBeVisible();
  const before = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  await page.clock.runFor(1000);
  const after = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()); expect(after).not.toBe(before);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(canvas).toHaveAttribute('data-motion', 'still');
  const still = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()); await page.clock.runFor(1000);
  expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(still);
});
