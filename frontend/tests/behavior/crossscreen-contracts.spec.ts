import { touchSequence } from "../support/touch";
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW } from '../support/scenario';

async function pull(page: Page, selector = 'body', end = false) {
  await touchSequence(page.locator(selector), end
    ? [["touchstart", 20], ["touchmove", 180], ["touchend", 180]]
    : [["touchstart", 20], ["touchmove", 180]]);
}

test('X05 menu typeahead selects focus only and Tab closes without mutation', async ({ page, baseURL }) => {
  const s = createScenario('X05'); await openApp(page, s, baseURL!);
  await marker(page, 'main-mode-chain').click(); await marker(page, 'chain-entry').click();
  const popup = marker(page, 'chain-entry-popup');
  await popup.evaluate(node => { node.style.height = '45px'; });
  const option = marker(page, 'chain-entry-option-se');
  await page.keyboard.press('s');
  await expect(option).toBeFocused();
  await expect(option).toBeInViewport();
  await page.keyboard.press('Tab'); await expect(marker(page, 'chain-entry')).toHaveAttribute('aria-expanded', 'false');
  await expect(marker(page, 'chain-entry-option-se')).not.toBeVisible();
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('X05 native pair dialog traps forward/backward Tab and returns focus', async ({ page, baseURL }, testInfo) => {
  const s = createScenario('X05'); s.on('POST', '/api/auth/pairing-code', () => ({ body: { id: 'focus-pair', code: '123456', status: 'pending', expires_at: Date.parse(NOW) / 1000 + 300 } }));
  await openApp(page, s, baseURL!); await marker(page, 'btn-add-device').click(); await expect(marker(page, 'pair-code')).toHaveText('123 456');
  const controls = marker(page, 'pair-dialog').locator('button:not(:disabled):visible');
  await controls.last().focus(); await page.keyboard.press('Tab');
  const focusEvidence = await page.evaluate(() => ({ active: { tag: document.activeElement?.tagName, marker: (document.activeElement as HTMLElement)?.dataset.marker },
    controls: Array.from(document.querySelectorAll('[data-marker="pair-dialog"] button')).map(node => ({ marker: (node as HTMLElement).dataset.marker, visible: !!(node as HTMLElement).offsetParent })) }));
  await testInfo.attach('pair-focus-evidence', { body: JSON.stringify(focusEvidence, null, 2), contentType: 'application/json' });
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(controls.last()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(marker(page, 'pair-dialog')).not.toBeVisible(); await expect(marker(page, 'btn-add-device')).toBeFocused();
});

for (const exclusion of ['dialog', 'editor', 'scroller', 'zoom']) test(`X06 standalone pull excludes ${exclusion}`, async ({ page, baseURL }) => {
  const s = createScenario('X06'); await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible();
  let target = 'body';
  if (exclusion === 'dialog') {
    s.on('POST', '/api/auth/pairing-code', () => ({ body: { id: 'pull-pair', code: '123456', status: 'pending', expires_at: Date.parse(NOW) / 1000 + 300 } }));
    await marker(page, 'btn-add-device').click(); await expect(marker(page, 'pair-dialog')).toBeVisible();
  }
  if (exclusion === 'editor') { await marker(page, 'subscription-toggle').click(); await marker(page, 'subscription-home-url').focus(); }
  if (exclusion === 'zoom') await page.evaluate(() => Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, value: 2 }));
  if (exclusion === 'scroller') {
    // A real overflowing subtree exercises the browser's computed overflow geometry.
    await page.evaluate(() => { const box = document.createElement('div'); box.id = 'gesture-scroller'; box.style.cssText = 'height:40px;overflow-y:auto'; const content = document.createElement('div'); content.id = 'gesture-content'; content.style.height = '200px'; content.textContent = 'Scrollable fixture'; box.append(content); document.body.prepend(box); });
    target = '#gesture-content';
  }
  await pull(page, target, true); await page.clock.runFor(48);
  await expect(marker(page, 'pull-to-refresh')).toBeHidden(); expect(s.count('GET', '/api/auth/session')).toBe(1);
});

test('X06 BFCache lifecycle clears an armed gesture and permits a fresh gesture', async ({ page, baseURL }) => {
  const s = createScenario('X06'); await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toBeVisible(); await pull(page);
  await expect(marker(page, 'pull-to-refresh')).toContainText('Release to refresh');
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await expect(marker(page, 'pull-to-refresh')).toBeHidden();
  await pull(page); await expect(marker(page, 'pull-to-refresh')).toContainText('Release to refresh');
  await touchSequence(page.locator("body"), [["touchcancel", 180]]);
});

test('X07 hidden and unmounted wave stop RAF; repeated navigation leaves one polling cadence', async ({ page, baseURL }) => {
  const s = createScenario('X07'); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openApp(page, s, baseURL!); await expect(marker(page, 'power-wave')).toBeVisible();
  // Observe public RAF calls after application initialization, without inspecting closure state.
  await page.evaluate(() => {
    const original = window.requestAnimationFrame; (window as any).observedFrames = 0;
    window.requestAnimationFrame = callback => original(time => { (window as any).observedFrames++; callback(time); });
  });
  await page.clock.runFor(100); expect(await page.evaluate(() => (window as any).observedFrames)).toBeGreaterThan(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenFrames = await page.evaluate(() => (window as any).observedFrames); await page.clock.runFor(20_000);
  expect(await page.evaluate(() => (window as any).observedFrames)).toBe(hiddenFrames);
  expect(s.count('GET', '/api/status')).toBe(1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => s.count('GET', '/api/status')).toBe(2);
  for (let i = 0; i < 3; i++) {
    await marker(page, 'nav-routing').click(); await expect(marker(page, 'routing-add')).toBeVisible();
    await expect(marker(page, 'power-wave')).toHaveCount(0);
    await page.clock.runFor(48); const stopped = await page.evaluate(() => (window as any).observedFrames);
    await page.clock.runFor(1000); expect(await page.evaluate(() => (window as any).observedFrames)).toBe(stopped);
    await page.goBack(); await expect(marker(page, 'power-wave')).toBeVisible();
  }
  const reads = s.count('GET', '/api/status'); await page.clock.runFor(10_001); await expect.poll(() => s.count('GET', '/api/status')).toBe(reads + 1);
});

test('O04 reverse status responses retain latest route and last-success age across failures', async ({ page, baseURL }) => {
  const s = createScenario('O04'); await openApp(page, s, baseURL!); await expect(marker(page, 'active-name')).toContainText('Finland');
  s.on('GET', '/api/status', () => ({ hold: 'older', body: { ...s.state.status, active_code: 'de', active_route: { mode: 'single', exit_code: 'de', exit_name: 'Germany 🇩🇪', entry_code: null, entry_name: null } } }));
  await page.clock.runFor(10_001); await expect.poll(() => s.count('GET', '/api/status')).toBe(2);
  s.on('GET', '/api/status', () => ({ body: s.state.status }));
  await page.clock.runFor(10_000); await expect.poll(() => s.count('GET', '/api/status')).toBe(3);
  await expect(marker(page, 'active-name')).toContainText('Finland'); await s.release('older');
  await page.clock.runFor(48); await expect(marker(page, 'active-name')).toContainText('Finland');
  s.on('GET', '/api/status', () => ({ abort: true })); await page.clock.runFor(70_000);
  await expect(marker(page, 'offline-state')).toContainText('1 min ago'); await expect(marker(page, 'active-name')).toContainText('Finland');
  await expect(marker(page, 'toast')).toHaveCount(0);
  s.on('GET', '/api/status', () => ({ body: s.state.status })); await marker(page, 'offline-retry').click();
  await expect(marker(page, 'offline-state')).toHaveCount(0);
});

for (const screen of ['catalog', 'dashboard', 'dashboard-mobile', 'settings', 'routing', 'login']) test(`X05 automated axe accessibility ${screen}`, async ({ page, baseURL }, testInfo) => {
  const s = createScenario('X05');
  if (screen === 'dashboard') await page.setViewportSize({ width: 1440, height: 1000 });
  if (screen === 'dashboard-mobile') await page.setViewportSize({ width: 390, height: 844 });
  if (screen === 'login') s.state.session.authenticated = false;
  await openApp(page, s, baseURL!);
  if (screen === 'catalog') await page.goto('/styleguide.html');
  else if (screen === 'settings') {
    await marker(page, 'btn-settings').click();
    await expect(marker(page, 'settings-drawer')).toHaveJSProperty('inert', false);
    await expect(marker(page, 'settings-subscription')).toHaveAccessibleName(/location updates/);
    await expect(marker(page, 'settings-access')).toBeInViewport();
  }
  else if (screen === 'routing') { await marker(page, 'nav-routing').click(); await expect(marker(page, 'routing-add')).toBeVisible(); }
  else await expect(marker(page, screen === 'login' ? 'gate-input' : 'active-name')).toBeVisible();
  await page.clock.runFor(48);
  // axe schedules asynchronous work through browser timers. Resume from the fixed epoch for the scan.
  await page.clock.resume();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  await testInfo.attach('axe-full-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  const approvedTargets: Record<string, string[]> = {
    catalog: ['.info > .banner-pfx'],
    dashboard: ['.subscription-panel > .box-title', '.subscription-meta > span:nth-child(1)', 'span[title="today 11:55"]', '.power-box > .box-title', '.power-caption', '.outbound-box > .box-title', 'dt:nth-child(1)', 'dt:nth-child(3)', 'dt:nth-child(5)', 'dt:nth-child(7)', 'dt:nth-child(9)', '.route-check-note'],
  };
  const violations = result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) }));
  // The compact dashboard collapses the power and route details, leaving four visible findings.
  approvedTargets['dashboard-mobile'] = approvedTargets.dashboard!.slice(0, 4);
  if (approvedTargets[screen]) {
    // Reviewed retained contrast debt applies equally to legacy and React; no new findings are allowed.
    expect(violations).toEqual([{ id: 'color-contrast', impact: 'serious', targets: approvedTargets[screen].map(target => [target]) }]);
    const expectedText = screen === 'catalog' ? ['[waiting]'] : ['subscription', '3 locations', 'last success 11:55', screen === 'dashboard-mobile' ? 'connection' : 'xkeen', 'proxy client', 'Main route', 'code', 'host', 'port', 'ping', 'status', 'Server route not checked · HTTP(S) is healthy if any configured resource works'];
    const fingerprints = result.violations.flatMap(violation => violation.nodes.map(node => {
      const contrast = node.any.find(check => check.id === 'color-contrast')!.data;
      return { target: node.target, text: node.html.replace(/<[^>]*>/g, ''), fgColor: contrast.fgColor, bgColor: contrast.bgColor, contrastRatio: contrast.contrastRatio };
    }));
    expect(fingerprints).toEqual(approvedTargets[screen].map((target, index) => ({
      target: [target], text: expectedText[index],
      fgColor: screen === 'catalog' ? '#686658' : '#7a7868',
      bgColor: screen === 'catalog' ? '#e4e2d6' : [0, 3, 5].includes(index) ? '#f5f4ef' : '#fffef8',
      contrastRatio: screen === 'catalog' ? 4.44 : [0, 3, 5].includes(index) ? 4.04 : 4.4,
    })));
  } else expect(violations).toEqual([]);
});
