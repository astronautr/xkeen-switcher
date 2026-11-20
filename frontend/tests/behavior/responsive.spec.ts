import { test, expect } from '../support/test';
import { createScenario, marker, NOW, openApp } from '../support/scenario';

for (const theme of ['light', 'dark']) test(`Accordion rows keep their background on hover in ${theme} theme`, async ({ page, baseURL, hasTouch }) => {
  const scenario = createScenario('accordion-hover');
  const rule = 'rule-' + scenario.state.routing.model.groups[0].id;
  await openApp(page, scenario, baseURL!, theme);
  for (const name of ['devices-toggle', 'subscription-toggle', rule]) {
    if (name === rule) await marker(page, 'nav-routing').click();
    const row = marker(page, name);
    for (const expanded of [false, true]) {
      await expect(row).toHaveAttribute('aria-expanded', String(expanded));
      if (expanded && name === rule && hasTouch) {
        await expect(row).toBeHidden();
        await marker(page, 'rule-cancel').tap();
        await expect(row).toHaveAttribute('aria-expanded', 'false');
        break;
      }
      if (!hasTouch) {
        await page.mouse.move(0, 0);
        await expect.poll(() => row.evaluate(node => node.matches(':hover'))).toBe(false);
      }
      const transparent = 'rgba(0, 0, 0, 0)';
      if (expanded && name === rule) await expect(row).not.toHaveCSS('background-color', transparent);
      else await expect(row).toHaveCSS('background-color', transparent);
      const resting = await row.evaluate(node => getComputedStyle(node).backgroundColor);
      if (hasTouch) {
        await row.tap();
      } else {
        await row.hover();
        await expect.poll(() => row.evaluate(node => node.matches(':hover'))).toBe(true);
        await expect(row).toHaveCSS('background-color', resting);
        await page.keyboard.press('Tab');
        await row.focus();
        await expect(row).not.toHaveCSS('outline-style', 'none');
        await row.press('Enter');
      }
      await expect(row).toHaveAttribute('aria-expanded', String(!expanded));
    }
  }
});

test('Location status columns align and mixed TCP/UDP metadata fits narrow layouts', async ({ page, baseURL }) => {
  const scenario = createScenario('locations-layout');
  const status = scenario.state.status;
  status.health_updated_at = NOW;
  status.available[0].protocol = 'hysteria2';
  status.available[1].health = { ok: true, probe_method: 'tcp', last_latency_ms: 11 };
  Object.assign(status.failover, { enabled: true, whitelist: [status.available[0].code] });
  await openApp(page, scenario, baseURL!);
  const locations = marker(page, 'locations');
  for (const width of [1440, 641, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.runFor(32);
    await expect.poll(() => locations.evaluate(node => {
      const title = node.querySelector('.box-title-row')!.getBoundingClientRect();
      const summary = node.querySelector('.location-check-summary')!.getBoundingClientRect();
      return summary.top - title.bottom;
    })).toBeGreaterThanOrEqual(0);
    const badge = locations.getByText('hy2', { exact: true });
    expect(await badge.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (width > 640) {
      for (const column of ['.code', '.health-dot']) {
        const positions = await locations.locator(column).evaluateAll(nodes =>
          nodes.map(node => Math.round(node.getBoundingClientRect().left)));
        expect(new Set(positions).size).toBe(1);
      }
    }
  }
});
for (const width of [320, 390, 639, 640, 641, 719, 720, 721, 1440]) test(`X01 X02 resize to ${width} preserves connected focused input`, async ({ page, baseURL }) => {
  const s = createScenario('X02'); await openApp(page, s, baseURL!);
  await marker(page, 'subscription-toggle').click();
  const field = marker(page, 'subscription-home-url');
  await field.fill('https://draft.example.invalid/long-subscription');
  await field.evaluate((node: HTMLInputElement) => { node.focus(); node.setSelectionRange(8, 13); });
  const handle = await field.elementHandle();
  await page.setViewportSize({ width, height: width === 320 ? 740 : 844 });
  await page.clock.runFor(16);
  expect(await handle!.evaluate((node: HTMLInputElement) => ({ connected: node.isConnected, focused: document.activeElement === node, selection: [node.selectionStart, node.selectionEnd] })))
    .toEqual({ connected: true, focused: true, selection: [8, 13] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(s.failures).toEqual([]);
});

test('X03 system theme follows OS; explicit theme survives reload', async ({ page, baseURL }) => {
  const s = createScenario('X03');
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page, s, baseURL!, 'system');
  await marker(page, 'btn-settings').click();
  await marker(page, 'theme-light').click();
  await expect(page.locator('html')).toHaveClass('theme-light');
  expect(await page.evaluate(() => localStorage.getItem('xk_theme'))).toBe('light');
  // openApp's initialization script models initial storage; remove it by opening a fresh page in this context.
  const next = await page.context().newPage();
  await next.goto('/');
  await expect(next.locator('html')).toHaveClass('theme-light');
  await next.close();
  expect(s.failures).toEqual([]);
});

const overlap = (a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number } | null) =>
  !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of [390, 1440]) test(`Settings rows, home crumb and Save stay reachable at ${width}`, async ({ page, baseURL }) => {
  const scenario = createScenario('settings-targets-' + width);
  await page.setViewportSize({ width, height: 844 });
  await openApp(page, scenario, baseURL!);
  await marker(page, 'btn-settings').click();
  await marker(page, 'settings-failover').click();
  const touch = width <= 720 || await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  const minimum = touch ? 44 : 32;
  const code = scenario.state.status.available[1].code;
  const row = page.locator('label.wl-select').filter({ has: marker(page, 'wl-check-' + code) });
  await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(minimum);
  // The location name belongs to the checkbox target.
  const name = (await row.locator('.wl-name').boundingBox())!;
  const area = (await row.boundingBox())!;
  await row.click({ position: { x: name.x - area.x + 2, y: name.y - area.y + name.height / 2 } });
  await expect(marker(page, 'wl-check-' + code)).toBeChecked();
  expect((await marker(page, 'tgl-fo-enabled').boundingBox())!.height).toBeGreaterThanOrEqual(minimum);
  const home = marker(page, 'settings-home');
  const box = (await home.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(touch ? 30 : 24);
  expect(box.height).toBeGreaterThanOrEqual(touch ? 44 : 34);
  expect(await home.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await expect(marker(page, 'btn-activity')).toBeHidden(); // The idle activity bar steps aside outside the dashboard.
  expect(overlap(await marker(page, 'settings-save').boundingBox(), await marker(page, 'btn-activity').boundingBox())).toBe(false);
});

test('Phone rule editor actions stay clear of the activity bar', async ({ page, baseURL }) => {
  const scenario = createScenario('routing-editor-launcher');
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, scenario, baseURL!);
  await marker(page, 'nav-routing').click();
  await marker(page, 'routing-add').click();
  const save = marker(page, 'routing-save-draft');
  await expect(save).toBeVisible();
  await expect(marker(page, 'btn-activity')).toBeHidden(); // The idle activity bar steps aside outside the dashboard.
  expect(overlap(await save.boundingBox(), await marker(page, 'btn-activity').boundingBox())).toBe(false);
  const home = marker(page, 'breadcrumb-home');
  expect((await home.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await home.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
});

test('Phone device location sheet keeps Apply clear of the activity bar', async ({ page, baseURL }) => {
  const scenario = createScenario('device-sheet-launcher');
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, scenario, baseURL!);
  await marker(page, 'devices-toggle').click();
  await marker(page, 'location-02:00:00:00:00:21').click();
  const apply = marker(page, 'apply-device-location');
  await expect(apply).toBeVisible();
  await expect(marker(page, 'btn-activity')).toBeHidden(); // The idle activity bar steps aside outside the dashboard.
  await expect.poll(async () => overlap(await apply.boundingBox(), await marker(page, 'btn-activity').boundingBox())).toBe(false);
});

test('Phone activity sheet docks below the page and follows tap and drag', async ({ page, baseURL }) => {
  const scenario = createScenario('activity-sheet');
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, scenario, baseURL!);
  const sheet = marker(page, 'activity-sheet');
  const line = marker(page, 'btn-activity');
  await expect(sheet).toHaveAttribute('data-snap', '0');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const devices = (await marker(page, 'devices-toggle').boundingBox())!;
  const docked = (await sheet.boundingBox())!;
  expect(devices.y + devices.height).toBeLessThanOrEqual(docked.y);
  expect(docked.width).toBe(390);

  await line.click();
  await expect(sheet).toHaveAttribute('data-snap', '1');
  await expect(marker(page, 'activity-panel')).toBeVisible();
  await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(Math.round(844 * 0.78));
  for (const filter of ['all', 'local', 'router', 'problems']) {
    const box = (await marker(page, 'activity-filter-' + filter).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
  }
  // The filter row spans the content width, not only part of it.
  const filters = (await page.locator('.activity-filters').boundingBox())!;
  const content = (await marker(page, 'activity-content').boundingBox())!;
  expect(Math.round(filters.width)).toBe(Math.round(content.width - 32));
  // On phones the filters stay at the bottom edge, within thumb reach.
  expect(filters.y).toBeGreaterThan(content.y + content.height - 1);

  const start = (await line.boundingBox())!;
  await page.mouse.move(start.x + 100, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, 20, { steps: 12 });
  await page.mouse.up();
  await expect(sheet).toHaveAttribute('data-snap', '2');
  await expect(line).toHaveAttribute('aria-expanded', 'true');

  const top = (await line.boundingBox())!;
  await page.mouse.move(top.x + 100, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + 100, 830, { steps: 12 });
  await page.mouse.up();
  await expect(sheet).toHaveAttribute('data-snap', '0');
  await expect(marker(page, 'activity-panel')).toBeHidden();
});
