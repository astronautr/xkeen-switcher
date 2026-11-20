import {test, expect} from '../support/test';
import {createScenario, marker} from '../support/scenario';

test('S01 refresh readback supersedes a status poll started before the POST response', async ({page, context, baseURL}) => {
 const scenario = createScenario('G3-refresh-stale-poll');
 await scenario.install(context, baseURL!);
 await page.clock.install();
 await page.goto('/');
 await expect(marker(page, 'refresh-status')).toHaveText('ok');
 const previous = structuredClone(scenario.state.status);
 let reads = 0;
 scenario.on('GET', '/api/status', () => ++reads === 1
  ? {hold: 'old-status', body: previous} : {body: scenario.state.status});
 scenario.on('POST', '/api/update', () => {
  scenario.state.status.last_update_status = 'fail';
  return {status: 502, body: {error: 'Subscription refresh failed'}};
 });
 await page.clock.runFor(10_000);
 await expect.poll(() => scenario.count('GET', '/api/status')).toBe(2);
 await marker(page, 'refresh').click();
 await expect.poll(() => scenario.count('GET', '/api/status')).toBe(3);
 await expect(marker(page, 'refresh-status')).toHaveText('fail');
 await expect(marker(page, 'error')).toHaveText('Subscription refresh failed');
 await scenario.release('old-status');
 await expect(marker(page, 'refresh-status')).toHaveText('fail');
 expect(scenario.count('POST', '/api/update')).toBe(1);
});

test('S01 failed refresh immediately reloads persisted status through the public hook', async ({page, context, baseURL}) => {
 const scenario = createScenario('G3-refresh-failed');
 scenario.on('POST', '/api/update', () => {
  scenario.state.status.last_update_status = 'fail';
  return {status: 502, body: {error: 'Subscription refresh failed'}};
 });
 await scenario.install(context, baseURL!);
 await page.goto('/');
 await expect(marker(page, 'refresh-status')).toHaveText('ok');
 await marker(page, 'refresh').click();
 await expect(marker(page, 'error')).toHaveText('Subscription refresh failed');
 await expect(marker(page, 'refresh-status')).toHaveText('fail');
 expect(scenario.count('POST', '/api/update')).toBe(1);
 expect(scenario.count('GET', '/api/status')).toBe(2);
 await expect(marker(page, 'notifications')).toHaveText('[]');
});

for (const [action, endpoint] of [
 ['apply-pending', '/api/active-refresh'],
 ['power-stop', '/api/xkeen'],
 ['probe', '/api/probe'],
 ['route-check', '/api/route-check'],
] as const) {
 test(`S04 S05 ${action} error holds admission until a single status readback`, async ({page, context, baseURL}) => {
  const scenario = createScenario(`G3-status-readback-${action}`);
  await scenario.install(context, baseURL!);
  await page.clock.install();
  await page.goto('/');
  await expect(marker(page, 'confirmed')).toHaveText('fi');
  scenario.on('POST', endpoint, () => ({status: 502, body: {error: 'Action result unavailable'}}));
  scenario.on('GET', '/api/status', () => ({hold: 'readback', body: scenario.state.status}));
  await marker(page, action).click();
  await expect.poll(() => scenario.count('GET', '/api/status')).toBe(2);
  await page.clock.runFor(10_001);
  expect(scenario.count('GET', '/api/status')).toBe(2);
  await expect(marker(page, 'operation')).toContainText('"blocking":true');
  await marker(page, 'switch').click();
  expect(scenario.count('POST', '/api/switch')).toBe(0);
  await scenario.release('readback');
  await expect(marker(page, 'error')).toHaveText('Action result unavailable');
  await expect(marker(page, 'operation')).toContainText('"blocking":false');
  await expect(marker(page, 'notifications')).toHaveText('[]');
  expect(scenario.count('POST', endpoint)).toBe(1);
  expect(scenario.count('GET', '/api/status')).toBe(2);
 });
}

test('S04 restart sends the existing API action and reconciles the observed power state', async ({page, context, baseURL}) => {
 const scenario = createScenario('S04-protocol-restart');
 scenario.state.status.xkeen_state = 'unknown';
 scenario.on('POST', '/api/xkeen', () => {
  scenario.state.status.xkeen_state = 'running';
  return {body: {ok: true, action: 'restart'}};
 });
 await scenario.install(context, baseURL!);
 await page.clock.install();
 await page.goto('/');
 await expect(marker(page, 'power-state')).toHaveText('unknown');
 await marker(page, 'power-restart').click();
 await expect(marker(page, 'power-state')).toHaveText('running');
 const posts = scenario.requests.filter(request => request.method === 'POST');
 expect(posts.map(({path, body}) => ({path, body}))).toEqual([{path: '/api/xkeen', body: {action: 'restart'}}]);
 expect(scenario.count('GET', '/api/status')).toBe(2);
});
