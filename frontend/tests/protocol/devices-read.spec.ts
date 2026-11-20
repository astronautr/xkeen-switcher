import {test, expect} from '../support/test';
import {createScenario, marker, NOW} from '../support/scenario';

for (const trigger of ['initial', 'refetch', 'poll', 'readback']) {
 test(`Devices ${trigger} read blocks immediately through public hooks without a result toast`, async ({page, context, baseURL}) => {
  const scenario = createScenario(`G3-Devices-read-${trigger}`);
  await scenario.install(context, baseURL!);
  if (trigger === 'poll') {
   const start = new Date(NOW);
   await page.clock.install({time: start});
   await page.clock.pauseAt(start);
  }
  await page.goto('/');
  await expect(marker(page, 'confirmed')).toHaveText('fi');
  if (trigger === 'refetch' || trigger === 'poll') {
   await marker(page, 'devices-open').click();
   await expect(marker(page, 'devices')).toContainText('"configured":true');
  }
  scenario.on('GET', '/api/devices', () => ({hold: 'inventory', body: scenario.state.devices}));
  if (trigger === 'readback') {
   scenario.on('POST', '/api/devices/change', () => ({status: 502, body: {error: 'reply lost'}}));
   await marker(page, 'device-change').click();
  } else if (trigger === 'poll') {
   await page.clock.runFor(29_999);
   expect(scenario.count('GET', '/api/devices')).toBe(1);
   await page.clock.runFor(1);
  } else {
   await marker(page, trigger === 'initial' ? 'devices-open' : 'devices-refresh').click();
  }
  const expectedReads = trigger === 'refetch' || trigger === 'poll' ? 2 : 1;
  await expect.poll(() => scenario.count('GET', '/api/devices')).toBe(expectedReads);
  await expect(marker(page, 'operation')).toContainText('"kind":"read"');
  await expect(marker(page, 'operation')).toContainText('"scope":"read"');
  await expect(marker(page, 'operation')).toContainText('"blocking":true');
  await expect(marker(page, 'operation')).toContainText('"local":false');
  await marker(page, 'switch').click();
  expect(scenario.count('POST', '/api/switch')).toBe(0);
  await scenario.release('inventory');
  await expect(marker(page, 'operation')).toContainText('"blocking":false');
  await expect(marker(page, 'notifications')).toHaveText('[]');
  expect(scenario.count('GET', '/api/devices')).toBe(expectedReads);
  expect(scenario.count('POST', '/api/switch')).toBe(0);
  expect(scenario.requests.some(request => request.path.includes('/operations/null'))).toBe(false);
 });
}
