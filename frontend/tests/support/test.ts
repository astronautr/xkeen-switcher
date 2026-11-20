import { test as base, expect } from '@playwright/test';
import { installedScenarios } from './scenario';
export { expect };
export const test = base.extend<{ networkAudit: void }>({
  networkAudit: [async ({ context }, use) => {
    const errors: string[] = [];
    const consoleErrors: { text: string; url: string }[] = [];
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); });
    });
    await use();
    expect(errors, 'Uncaught browser exceptions').toEqual([]);
    const scenarios = installedScenarios.get(context) || new Set();
    const unexpectedConsole = consoleErrors.filter(error => {
      let path = ''; try { path = new URL(error.url).pathname; } catch {}
      return !error.text.startsWith('Failed to load resource:') || ![...scenarios].some(s => s.allowedHttpErrors.has(path));
    });
    expect(unexpectedConsole, 'Unexpected browser console errors').toEqual([]);
    for (const scenario of scenarios)
      expect(scenario.failures, `Strict scenario ${scenario.id}`).toEqual([]);
  }, { auto: true }],
});
