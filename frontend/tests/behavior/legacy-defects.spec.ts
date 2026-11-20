import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';

test('O02 device inventory ephemeral read must never query operations/null', async ({ page, baseURL }) => {
  const s = createScenario('O02:device-read');
  s.on('GET', '/api/routing/operations/null', () => ({ status: 400, body: { error: 'Invalid ID', code: 'invalid', validation: [] } }));
  // This is the exact real /api/devices serializer output, including its own
  // read activity with id:null. Do not turn it into a fabricated durable UUID.
  expect(s.state.devices.locations.pending_operation.id).toBeNull();
  await openApp(page, s, baseURL!);
  await marker(page, 'devices-toggle').click();
  await marker(page, 'device-location-recover').click();
  await expect(page.locator('#devices-content')).toHaveAttribute('aria-busy', 'false');
  expect(s.failures).toEqual([]);
  await expect.poll(() => s.requests.filter(r => r.path.includes('/api/routing/operations/')).length).toBe(0);
  expect(s.failures).toEqual([]);
});
