import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW } from '../support/scenario';
import type { Page } from '@playwright/test';

const event = (id: string, result: string, ts = NOW) => ({ event_id: id, ts,
  action: 'update', trigger: 'cron', result, code: null,
  message: result === 'ok' ? 'Subscription refreshed' : 'Synthetic provider unavailable' });
const savedNotifications = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('xk_notifications') || '[]'));

test('H01 own POST and status event race produces one notification and acknowledges exact IDs', async ({ page, baseURL }) => {
  const s = createScenario('H01');
  s.on('POST', '/api/update', () => {
    s.state.status.events = [event('own-refresh-event', 'ok')];
    s.state.status.history = [...s.state.status.events];
    return { hold: 'refresh', body: { ok: true, event_ids: ['own-refresh-event', 'response-only-event'] } };
  });
  await openApp(page, s, baseURL!);
  await marker(page, 'btn-update-sub').click();
  await expect.poll(() => s.count('POST', '/api/update')).toBe(1);
  await page.clock.runFor(10_001); // The server event arrives before the mutation reply.
  expect(await savedNotifications(page)).toHaveLength(0);
  await s.release('refresh');
  await expect(marker(page, 'toast').filter({ hasText: 'subscription refreshed' })).toHaveCount(1);
  await expect.poll(() => savedNotifications(page)).toHaveLength(1);
  await page.clock.runFor(20_001);
  expect(await savedNotifications(page)).toHaveLength(1);
  const cursor = await page.evaluate(() => JSON.parse(localStorage.getItem('xk_event_cursor') || '{}'));
  expect(cursor.seen).toEqual(expect.arrayContaining(['own-refresh-event', 'response-only-event']));
  expect(s.count('POST', '/api/update')).toBe(1);
});

test('H01 same timestamps, clock reversal and rotation retain stable event acknowledgements', async ({ page, baseURL }) => {
  const s = createScenario('H01');
  s.state.status.events = [event('old-event', 'ok')];
  await openApp(page, s, baseURL!);
  await expect(marker(page, 'active-name')).toBeVisible();
  s.state.status.events.push(event('new-failure', 'fail', '2026-11-16T09:00:00Z'));
  await page.clock.runFor(10_001);
  await expect(marker(page, 'btn-activity')).toHaveAttribute('data-attention', 'true');
  s.state.status.events = [event('new-failure', 'fail', '2026-11-16T09:00:00Z'),
    event('new-recovery', 'ok', '2026-11-16T09:00:00Z')];
  await page.clock.runFor(10_001);
  await expect(marker(page, 'btn-activity')).toHaveAttribute('data-attention', 'false');
  const cursor = await page.evaluate(() => JSON.parse(localStorage.getItem('xk_event_cursor') || '{}'));
  expect(cursor.cursor).toBe('new-recovery');
  expect(cursor.seen).toEqual(expect.arrayContaining(['old-event', 'new-failure', 'new-recovery']));
  expect(await savedNotifications(page)).toHaveLength(0); // Background events stay in Activity.
});

test('H02 inbox retains 100 entries, restores tab scroll and clears only local notifications', async ({ page, baseURL }) => {
  const s = createScenario('H02');
  s.state.status.history = [event('server-history', 'ok')];
  await page.addInitScript(({ now }) => localStorage.setItem('xk_notifications', JSON.stringify(
    Array.from({ length: 100 }, (_, index) => ({ message: `Saved message ${index}`, at: now, error: false }))
  )), { now: NOW });
  s.on('POST', '/api/update', () => ({ body: { ok: true, event_ids: ['refresh-101'] } }));
  await openApp(page, s, baseURL!);
  await marker(page, 'btn-update-sub').click();
  await expect.poll(async () => (await savedNotifications(page))[0]?.message).toContain('subscription refreshed');
  expect(await savedNotifications(page)).toHaveLength(100);
  expect((await savedNotifications(page)).some((n: { message: string }) => n.message === 'Saved message 99')).toBe(false);
  await marker(page, 'btn-activity').click();
  await expect(marker(page, 'notification-item')).toHaveCount(100);
  const content = marker(page, 'activity-content');
  await content.evaluate(node => { node.scrollTop = 400; });
  const scroll = await content.evaluate(node => node.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await expect(marker(page, 'activity-item')).toHaveCount(1); // One feed merges the router log.
  await marker(page, 'activity-filter-router').click();
  await expect(marker(page, 'activity-item')).toHaveCount(1);
  await expect(marker(page, 'notification-item')).toHaveCount(0);
  await expect(marker(page, 'notifications-clear')).toHaveCount(0); // Clearing applies only to local entries.
  await marker(page, 'activity-filter-all').click();
  expect(await content.evaluate(node => node.scrollTop)).toBe(scroll);
  await marker(page, 'activity-filter-local').click();
  await expect(marker(page, 'activity-item')).toHaveCount(0);
  await marker(page, 'notifications-clear').click();
  expect(await savedNotifications(page)).toEqual([]);
  await expect(marker(page, 'activity-feed')).toContainText('no notifications saved');
  await marker(page, 'activity-filter-all').click();
  await expect(marker(page, 'notification-item')).toHaveCount(0);
  await expect(marker(page, 'activity-item')).toHaveCount(1);
  expect(s.requests.filter(r => r.method !== 'GET').map(r => r.path)).toEqual(['/api/update']);
});

test('H02 toast survives hover and focus and expires six seconds after release', async ({ page, baseURL }) => {
  const s = createScenario('H02');
  s.on('POST', '/api/update', () => ({ body: { ok: true } }));
  await openApp(page, s, baseURL!);
  await marker(page, 'btn-update-sub').click();
  const toast = marker(page, 'toast').filter({ hasText: 'subscription refreshed' });
  await expect(toast).toBeVisible();
  await page.clock.runFor(5900);
  await expect(toast).toBeVisible();
  await toast.hover();
  await page.clock.runFor(10_000);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss notification' }).focus();
  await page.mouse.move(0, 0);
  await page.clock.runFor(10_000);
  await expect(toast).toBeVisible();
  await marker(page, 'btn-update-sub').focus();
  await page.clock.runFor(5900);
  await expect(toast).toBeVisible();
  await page.clock.runFor(500);
  await expect(toast).toHaveCount(0);
});

test('H03 own result appears above the open history panel; foreign success stays quiet', async ({ page, baseURL }) => {
  const s = createScenario('H03');
  s.on('POST', '/api/update', () => ({ hold: 'refresh', body: { ok: true, event_ids: ['own'] } }));
  await openApp(page, s, baseURL!);
  s.state.status.events = [event('scheduled', 'ok'),
    { ...event('foreign-switch', 'ok'), action: 'switch', trigger: 'manual', code: 'fi' },
    { ...event('failover-switch', 'ok'), action: 'failover-switch', trigger: 'failover', code: 'fi' }];
  await page.clock.runFor(10_001);
  await expect(marker(page, 'toast')).toHaveCount(0);
  await marker(page, 'btn-update-sub').click();
  await expect.poll(() => s.count('POST', '/api/update')).toBe(1);
  await marker(page, 'btn-activity').click();
  await s.release('refresh');
  const panel = marker(page, 'activity-panel');
  const toast = marker(page, 'toast').filter({ hasText: 'subscription refreshed' });
  await expect(toast).toBeVisible();
  await page.clock.runFor(50);
  await toast.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(toast).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test('H03 durable device Undo is reachable from a saved notification in the history panel', async ({ page, baseURL }) => {
  const s = createScenario('H03');
  const id = '88888888-8888-4888-8888-888888888888';
  await page.addInitScript(({ id, now }) => localStorage.setItem('xk_notifications', JSON.stringify([
    { message: 'Synthetic device change', at: now, error: false, device_operation: id },
  ])), { id, now: NOW });
  s.on('POST', '/api/devices/undo', request => {
    expect(request.body).toEqual({ operation_id: id });
    return { body: { ...s.state.devices, operation: { id, phase: 'undone', message: 'Restored device', undoable: false, undo_reason: 'Undone' } } };
  });
  await openApp(page, s, baseURL!);
  await marker(page, 'btn-activity').click();
  await marker(page, 'device-history-undo').click();
  await expect.poll(() => s.count('POST', '/api/devices/undo')).toBe(1);
  await expect(marker(page, 'activity-panel')).toBeVisible();
});
