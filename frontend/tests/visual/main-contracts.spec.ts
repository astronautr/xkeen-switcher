import { expectVisualTiles } from '../support/visual';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';
import { confirmedChain, ephemeralActivity, serverContext, hysteriaChain } from '../support/main-contracts';
const cases = ['M07-missing-entry', 'M07-missing-exit', 'M07-hysteria', 'M08-server-main', 'M08-server-fixed', 'M08-server-outside', 'O02-diagnostic', 'O02-mutation'];
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }])
  for (const theme of ['light', 'dark'] as const) for (const name of cases)
    test(`${name} ${viewport.width} ${theme}`, async ({ page, baseURL }) => {
      const s = createScenario(name);
      if (name === 'M07-hysteria') hysteriaChain(s);
      else if (name.startsWith('M07')) {
        confirmedChain(s);
        const missing = name.endsWith('entry') ? 'de' : 'fi';
        s.state.status.available = s.state.status.available.filter((loc: { code: string }) => loc.code !== missing);
        Object.assign(s.state.status, { active_status: 'stale', active_missing_codes: [missing] });
      } else if (name.startsWith('M08')) serverContext(s, name.slice('M08-server-'.length) as 'main' | 'fixed' | 'outside');
      else ephemeralActivity(s, name.endsWith('diagnostic') ? 'diagnostic' : 'router');
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await openApp(page, s, baseURL!, theme);
      await expect(marker(page, 'active-name')).toBeVisible();
      if (name.startsWith('M07-missing')) await expect(marker(page, 'banner-stale-active')).toBeVisible();
      if (name === 'M07-hysteria') await expect(marker(page, 'chain-hysteria-hint')).toBeVisible();
      if (name.startsWith('O02')) { await marker(page, 'btn-activity').click(); await expect(marker(page, 'activity-panel')).toBeVisible(); }
      await page.mouse.move(0, 0); await page.evaluate(() => scrollTo(0, 0)); await page.clock.runFor(48);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, img => img.decode())); });
      await expectVisualTiles(page, `${name}-chromium-${viewport.width}x${viewport.height}-${theme}.png`);
    });
