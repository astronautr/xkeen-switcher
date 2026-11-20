import { expectVisualTiles } from '../support/visual';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW } from '../support/scenario';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }])
  for (const theme of ['light', 'dark'] as const)
    for (const view of [
      { id: 'H01', state: 'own-result-after-event-race' },
      { id: 'H02', state: 'populated-notifications' },
      { id: 'H03', state: 'result-and-undo-above-dialog' },
    ]) test(`${view.id} ${view.state} ${viewport.width} ${theme}`, async ({ page, baseURL }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const s = createScenario(`${view.id}:${view.state}`);
      if (view.id !== 'H01') await page.addInitScript(({ now }) => {
        localStorage.setItem('xk_notifications', JSON.stringify([
          { message: 'Device settings changed', at: now, error: false,
            device_operation: '88888888-8888-4888-8888-888888888888' },
          { message: 'Main switched to Germany 🇩🇪 → Finland 🇫🇮', at: now, error: false },
          { message: 'Subscription refresh failed. Saved locations remain available.', at: now, error: true },
        ]));
      }, { now: NOW });
      s.on('POST', '/api/update', () => {
        s.state.status.events = [{ event_id: 'own-refresh-event', ts: NOW,
          action: 'update', trigger: 'manual', result: 'ok', message: 'Subscription refreshed', code: null }];
        s.state.status.history = [...s.state.status.events];
        return { hold: 'refresh', body: { ok: true, event_ids: ['own-refresh-event'] } };
      });
      await openApp(page, s, baseURL!, theme);
      if (view.id !== 'H02') {
        await marker(page, 'btn-update-sub').click();
        await expect.poll(() => s.count('POST', '/api/update')).toBe(1);
        if (view.id === 'H01') await page.clock.runFor(10_001);
        else await marker(page, 'btn-history').click();
        await s.release('refresh');
        await expect(marker(page, 'toast').filter({ hasText: 'subscription refreshed' })).toHaveCount(1);
        await page.clock.runFor(48);
        await expect(marker(page, 'toast').filter({ hasText: 'subscription refreshed' })).toHaveClass(/show/);
      } else {
        await marker(page, 'btn-history').click();
        await expect(marker(page, 'notification-item')).toHaveCount(3);
      }
      if (view.id === 'H03') {
        await expect(marker(page, 'history-dialog').locator('[data-marker="toast"]')).toBeVisible();
        await expect(marker(page, 'device-history-undo')).toBeVisible();
      }
      await page.mouse.move(0, 0);
      await page.evaluate(() => scrollTo(0, 0));
      await page.clock.runFor(16);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, img => img.decode())); });
      await expectVisualTiles(page, `${view.id}-${view.state}-chromium-${viewport.width}x${viewport.height}-${theme}.png`);
    });
