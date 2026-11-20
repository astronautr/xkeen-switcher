import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';
import { routingScenario, diffScenario, restoreScenario, restoreSnapshotId, snapshotId, originalBytes } from '../support/routing';

test('R01 default rule is editable but cannot be deleted', async ({ page, baseURL }) => {
  const s = createScenario('R01');
  const rule = s.state.routing.model.groups.find((r: any) => r.default_rule);
  await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click();
  await marker(page, 'rule-' + rule.id).click();
  await marker(page, 'action-direct').click();
  await expect(marker(page, 'action-direct')).toHaveAttribute('aria-pressed', 'true');
  await expect(marker(page, 'rule-delete')).toHaveCount(0);
});

test('R03 dirty new rule survives reload scratch and requires discard on cancel', async ({ page, baseURL }) => {
  const s = createScenario('R03'); await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click();
  await marker(page, 'routing-add').click();
  await marker(page, 'rule-name').fill('Unfinished local rule');
  await page.reload();
  await expect(marker(page, 'rule-name')).toHaveValue('Unfinished local rule');
  await marker(page, 'rule-cancel').click();
  await expect(marker(page, 'routing-confirm')).toContainText('Discard unsaved edits');
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
});

test('R04 review shows saved action and name diff before any apply', async ({ page, baseURL }) => {
  const s = routingScenario(createScenario('R04')); await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click();
  await marker(page, 'draft-review').click();
  await expect(marker(page, 'review-apply')).toBeEnabled();
  await expect(page.getByText('Name: Analytics → Privacy analytics', { exact: true })).toBeVisible();
  expect(s.count('POST', '/api/routing/preview')).toBe(1);
  expect(s.count('POST', '/api/routing/apply')).toBe(0);
});

test('R05 busy apply keeps preview and never queues retry', async ({ page, baseURL }) => {
  const s = routingScenario(createScenario('R05'));
  s.on('POST', '/api/routing/apply', () => ({ status: 409, body: { code: 'busy', error: 'Router busy' } }));
  await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click(); await marker(page, 'draft-review').click();
  await marker(page, 'review-apply').click();
  await expect(marker(page, 'panel-feedback')).toContainText('busy');
  await expect(marker(page, 'review-apply')).toBeVisible();
  await page.clock.runFor(31_000);
  expect(s.count('POST', '/api/routing/apply')).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem('xk_routing_operation'))).toBeNull();
});

test('R05 lost apply requires explicit retry with identical UUID and preview', async ({ page, baseURL }) => {
  const s = routingScenario(createScenario('R05'));
  s.on('POST', '/api/routing/apply', request => {
    s.on('GET', `/api/routing/operations/${request.body.operation_id}`, () => ({ status: 404, body: { error: 'Not found' } }));
    return { abort: true };
  });
  await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click(); await marker(page, 'draft-review').click();
  await marker(page, 'review-apply').click();
  await page.clock.runFor(1600);
  await expect(marker(page, 'operation-retry')).toBeVisible();
  await page.clock.runFor(10_001);
  expect(s.count('POST', '/api/routing/apply')).toBe(1);
  await marker(page, 'operation-retry').click();
  await expect.poll(() => s.count('POST', '/api/routing/apply')).toBe(2);
  const requests = s.requests.filter(r => r.path === '/api/routing/apply');
  expect(requests[1].body).toEqual(requests[0].body);
});

test('R06 original file download matches exact bytes', async ({ page, baseURL }) => {
  const s = routingScenario(createScenario('R06'), false); await openApp(page, s, baseURL!);
  await marker(page, 'nav-routing').click(); await marker(page, 'routing-versions').click();
  await marker(page, 'version-' + snapshotId).click();
  const download = page.waitForEvent('download');
  await marker(page, 'version-download').click();
  const result = await download;
  expect(await readFile((await result.path())!)).toEqual(originalBytes);
  expect(result.suggestedFilename()).toBe(`05_routing-${snapshotId}.json`);
});

const matcherCases = [
  ['domain-suffix', 'example.org'], ['domain-exact', 'api.example.org'],
  ['domain-geosite', 'ext:geosite_v2fly.dat:google'], ['ip', '192.0.2.0/24'],
  ['source', '192.168.1.42'], ['port', '80,443'], ['network', 'udp'],
  ['protocol', 'bittorrent'], ['ip-geoip', 'ext:geoip_v2fly.dat:private'],
  ['domain-substring', '  raw substring  '], ['domain-regexp', '  ^example\\.org$  '],
];
for (const [type, value] of matcherCases) test(`R02 ${type} add, remove, Undo, save and edit preserves matcher value`, async ({ page, baseURL }) => {
  const s = createScenario('R02');
  const original = structuredClone(s.state.routing.model);
  let revision: string | null = null;
  s.on('PUT', '/api/routing/draft', request => {
    expect(request.body.base_hash).toBe(s.state.routing.current.sha256);
    expect(request.body.expected_revision).toBe(revision);
    expect(request.body.model.document).toEqual(original.document);
    revision = revision ? '44444444-4444-4444-8444-444444444444' : '33333333-3333-4333-8333-333333333333';
    const draft = { revision, base_hash: request.body.base_hash, base_snapshot: s.state.routing.current.id,
      model: request.body.model, validation: [], saved_at: '2026-11-17T09:00:00+00:00' };
    s.state.routing.draft = draft;
    return { body: draft };
  });
  await openApp(page, s, baseURL!); await marker(page, 'nav-routing').click();
  await marker(page, 'routing-add').click(); await marker(page, 'rule-name').fill('Matcher contract');
  if (type !== 'domain-suffix') {
    await marker(page, 'remove-condition-0').click();
    await marker(page, 'add-condition').click(); await marker(page, 'add-condition-option-' + type).click();
  }
  if (type === 'network') {
    await marker(page, 'condition-0').selectOption('udp');
  } else await marker(page, 'condition-0').fill(value);
  await marker(page, 'remove-condition-0').click(); await marker(page, 'undo-condition').click();
  if (type !== 'network') await expect(marker(page, 'condition-0')).toHaveValue(value);
  await marker(page, 'action-direct').click(); await marker(page, 'routing-save-draft').click();
  await expect.poll(() => s.count('PUT', '/api/routing/draft')).toBe(1);
  const created = s.state.routing.draft.model.groups.find((g: any) => g.title === 'Matcher contract');
  expect(created.matchers).toEqual([{ type, value }]); expect(created.action).toBe('direct');
  await marker(page, 'rule-' + created.id).click(); await marker(page, 'rule-name').fill('Renamed only');
  await marker(page, 'routing-save-draft').click();
  await expect.poll(() => s.count('PUT', '/api/routing/draft')).toBe(2);
  expect(s.state.routing.draft.model.groups.find((g: any) => g.id === created.id).matchers).toEqual([{ type, value }]);
  expect(s.count('POST', '/api/routing/apply')).toBe(0);
});

test('R07 parser failure blocks editing and keeps versions reachable',async({page,baseURL})=>{
 const s=routingScenario(createScenario('R07'),false);s.state.routing.model=null;s.state.routing.parse_error='Invalid JSON at line 3';
 await openApp(page,s,baseURL!);await marker(page,'nav-routing').click();
 await expect(page.getByText('Configuration cannot be edited',{exact:true})).toBeVisible();await expect(marker(page,'routing-add')).toBeDisabled();
 await marker(page,'routing-versions').click();await marker(page,'version-'+snapshotId).click();await expect(marker(page,'version-download')).toBeVisible();
 expect(s.requests.filter(r=>r.method!=='GET')).toEqual([]);
});

test('R06 restore review targets original snapshot and raw panel preserves its text',async({page,baseURL})=>{
 const s=restoreScenario(createScenario('R06'));await openApp(page,s,baseURL!);await marker(page,'nav-routing').click();
 await marker(page,'routing-versions').click();await marker(page,'version-'+restoreSnapshotId).click();
 await marker(page,'version-raw').click();await expect(page.locator('.raw-preview')).toHaveText(originalBytes.toString());
 await marker(page,'version-restore').click();await expect(marker(page,'review-apply')).toContainText('restore and restart');
 expect(s.count('POST','/api/routing/preview')).toBe(1);expect(s.count('POST','/api/routing/apply')).toBe(0);
});


test('R04 preview exposes add delete move condition and action changes without apply',async({page,baseURL})=>{
 const s=diffScenario(createScenario('R04'));await openApp(page,s,baseURL!);await marker(page,'nav-routing').click();await marker(page,'draft-review').click();
 await expect(marker(page,'review-apply')).toBeEnabled();
 const review=page.locator('.review-item');await expect(review).toHaveCount(7);
 await expect(review.filter({hasText:'New safe domain'})).toContainText('added');
 await expect(review.filter({hasText:'Analytics'})).toContainText('removed');
 await expect(review.filter({hasText:'Vulnerable UDP ports'})).toContainText('+ destination ports: 80,443');
 await expect(review.filter({hasText:'Everything else'})).toContainText('Route: via proxy → direct');
 await expect(page.locator('.diff-line.moved').first()).toContainText('Position');
 expect(s.count('POST','/api/routing/apply')).toBe(0);
});
