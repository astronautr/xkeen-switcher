import { expectVisualTiles } from '../support/visual';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW } from '../support/scenario';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }])
  for (const theme of ['light', 'dark'] as const)
    for (const variant of ['setup-mismatch', 'setup-error', 'password-mismatch', 'password-error', 'login-error', 'code-error', 'code-rate-limit', 'revocation-error', 'pair-create-error', 'pair-poll-error'])
      test(`AUTH ${variant} ${viewport.width} ${theme}`, async ({ page, baseURL }) => {
        await page.setViewportSize(viewport); await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        const id = variant.startsWith('pair') ? 'A04' : variant.startsWith('setup') ? 'A01' : variant.startsWith('code') || variant.startsWith('login') ? 'A02' : 'A03';
        const s = createScenario(`${id}:${variant}`);
        if (variant.startsWith('setup')) s.state.session = { configured: false, authenticated: false, session_id: null };
        if (id === 'A02') s.state.session.authenticated = false;
        const endpoint = variant.startsWith('setup') ? '/api/auth/setup' : variant.startsWith('password') ? '/api/auth/password' : variant.startsWith('code') ? '/api/auth/pair' : '/api/auth/login';
        s.on('POST', endpoint, () => ({ status: variant === 'code-rate-limit' ? 429 : 503, body: { error: 'Authentication unavailable. Try again.' }, headers: variant === 'code-rate-limit' ? { 'Retry-After': '30' } : {} }));
        s.on('POST', '/api/auth/sessions/revoke', () => ({ status: 503, body: { error: 'Could not sign out browser. Try again.' } }));
        if (id === 'A04') {
          s.on('POST', '/api/auth/pairing-code', () => variant === 'pair-create-error'
            ? { status: 503, body: { error: 'Could not create code. Try again.' } }
            : { body: { id: 'pair-fixture', status: 'pending', code: '123456', expires_at: Date.parse(NOW) / 1000 + 300 } });
          s.on('GET', '/api/auth/pairing-code', () => ({ status: 503, body: { error: 'Could not check code' } }));
        }
        await openApp(page, s, baseURL!, theme);
        if (id === 'A04') {
          await marker(page, 'btn-add-device').click();
          if (variant === 'pair-poll-error') { await expect(marker(page, 'pair-code')).toHaveText('123 456'); await page.clock.runFor(2001); }
          await expect(marker(page, 'pair-status')).toContainText(variant === 'pair-create-error' ? 'No confirmed response from the server.' : 'Could not check');
        }
        if (id === 'A03') {
          await marker(page, 'btn-settings').click(); await marker(page, 'settings-access').click();
          if (variant === 'revocation-error') { await marker(page, 'device-revoke').click(); await expect(marker(page, 'toast')).toContainText('No confirmed response from the server.'); }
          else await marker(page, 'btn-change-password').click();
        }
        if (id === 'A01' || variant.startsWith('password')) {
          if (id === 'A03') await marker(page, 'password-current').fill('old-ui-password');
          await marker(page, 'password-new').fill('synthetic-ui-password');
          await marker(page, 'password-repeat').fill(variant.endsWith('mismatch') ? 'different-ui-password' : 'synthetic-ui-password');
          await marker(page, 'password-submit').click(); await expect(marker(page, 'password-error')).not.toBeEmpty();
        } else if (id === 'A02') {
          if (variant.startsWith('code')) await marker(page, 'gate-mode').click();
          await marker(page, 'gate-input').fill(variant.startsWith('code') ? '123456' : 'synthetic-ui-password');
          await marker(page, 'gate-submit').click(); await expect(marker(page, 'gate-error')).not.toBeEmpty();
        }
        await page.mouse.move(0, 0); await page.evaluate(() => scrollTo(0, 0)); await page.clock.runFor(48);
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, img => img.decode())); });
        await expectVisualTiles(page, `${id}-${variant}-chromium-${viewport.width}x${viewport.height}-${theme}.png`);
      });
