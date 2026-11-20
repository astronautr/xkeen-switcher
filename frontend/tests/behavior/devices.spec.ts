import {undoScenario} from '../support/devices';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp } from '../support/scenario';
const id = '02:00:00:00:00:21';

test('D01 query narrows inventory and clear restores stable row order', async ({ page, baseURL }) => {
  const s = createScenario('D01'); await openApp(page, s, baseURL!);
  await marker(page, 'devices-toggle').click();
  const rows = page.locator('[role="listitem"][data-marker^="device-"]');
  await expect(rows).toHaveCount(s.state.devices.devices.length);
  const order = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-marker')));
  await marker(page, 'search-devices').fill('MacBookPro');
  await expect(rows).toHaveCount(2);
  await marker(page, 'search-devices').fill('');
  expect(await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-marker')))).toEqual(order);
  expect(s.failures).toEqual([]);
});

test('D01 opening Devices keeps inventory loading local and Locations stationary', async ({ page, baseURL }) => {
  const scenario = createScenario('D01');
  scenario.on('GET', '/api/devices', () => ({ hold: 'inventory', body: scenario.state.devices }));
  await openApp(page, scenario, baseURL!);
  const locations = marker(page, 'locations');
  const toggle = marker(page, 'devices-toggle');
  const check = marker(page, 'btn-check-all');
  const geometry = () => locations.evaluate(section => {
    const box = section.getBoundingClientRect();
    const firstRow = section.querySelector('[data-marker="loc-row"]')!.getBoundingClientRect();
    // Whole pixels: Firefox can report float noise far below one device pixel.
    return { height: Math.round(box.height), firstRowTop: Math.round(firstRow.top - box.top) };
  });
  await expect(check).toBeEnabled();
  const resting = await geometry();
  // First load has no inventory. Reopening displays the cached devices while refetching.
  for (const reads of [1, 2]) {
    await toggle.click();
    await expect.poll(() => scenario.count('GET', '/api/devices')).toBe(reads);
    await expect(toggle.getByText('Reading router devices')).toBeVisible();
    await expect(locations).not.toContainText(/reading.*devices/i);
    await expect(check).toBeDisabled();
    expect(await geometry()).toEqual(resting);
    await scenario.release('inventory');
    await expect(toggle).not.toContainText('Reading router devices');
    await expect(check).toBeEnabled();
    expect(await geometry()).toEqual(resting);
    await toggle.click();
  }
});

test('D01 manual inventory refresh shows a spinner without changing button width', async ({ page, baseURL }) => {
  const scenario = createScenario('D01');
  await openApp(page, scenario, baseURL!);
  await marker(page, 'devices-toggle').click();
  const refresh = marker(page, 'router-devices-refresh');
  await expect(refresh).toBeEnabled();
  const idleWidth = (await refresh.boundingBox())?.width;
  scenario.on('GET', '/api/devices', () => ({ hold: 'manual-devices', body: scenario.state.devices }));
  await refresh.click();
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
  await expect(refresh).toHaveText('Refreshing');
  await expect(refresh.locator('.terminal-action-glyph')).toBeVisible();
  expect((await refresh.boundingBox())?.width).toBe(idleWidth);
  await scenario.release('manual-devices');
  await expect(refresh).toHaveText('Refresh');
});

test('D02 rename sends original revision and cancel sends no mutation', async ({ page, baseURL }) => {
  const s = createScenario('D02');
  const device = s.state.devices.devices.find((d: any) => d.id === id);
  const revision = device.revision;
  s.on('POST', '/api/devices/change', request => {
    expect(request.body.changes).toEqual([{ id, revision, values: { name: 'Study laptop', registered: true, policy: device.policy } }]);
    device.name = 'Study laptop'; return { body: s.state.devices };
  });
  await openApp(page, s, baseURL!); await marker(page, 'devices-toggle').click();
  await marker(page, 'rename-' + id).click();
  await marker(page, 'name-' + id).fill('Cancelled name');
  await marker(page, 'cancel-' + id).click();
  expect(s.count('POST', '/api/devices/change')).toBe(0);
  await marker(page, 'rename-' + id).click();
  await marker(page, 'name-' + id).fill('Study laptop');
  await marker(page, 'save-' + id).click();
  await expect(marker(page, 'device-' + id)).toContainText('Study laptop');
  await expect(marker(page, 'name-' + id)).toHaveCount(0);
  expect(s.count('POST', '/api/devices/change')).toBe(1);
  expect(s.failures).toEqual([]);
});

for (const kind of ['busy', 'conflict', 'unknown']) test(`D04 ${kind} preserves device input and never retries mutation`, async ({ page, baseURL }) => {
  const s = createScenario('D04');
  s.on('POST', '/api/devices/change', () => kind === 'unknown' ? { abort: true } : { status: 409, body: { code: kind, error: 'Synthetic conflict' } });
  await openApp(page, s, baseURL!); await marker(page, 'devices-toggle').click();
  await marker(page, 'rename-' + id).click();
  await marker(page, 'name-' + id).fill('Unconfirmed draft');
  await marker(page, 'save-' + id).click();
  await expect.poll(() => s.count('GET', '/api/devices')).toBeGreaterThan(1);
  await expect(marker(page, 'name-' + id)).toHaveValue('Unconfirmed draft');
  await page.clock.runFor(31_000);
  expect(s.count('POST', '/api/devices/change')).toBe(1);
  expect(s.failures).toEqual([]);
});

test('D07 device editor suppresses inventory refresh and survives parent status polling', async ({ page, baseURL }) => {
  const s = createScenario('D07'); await openApp(page, s, baseURL!); await marker(page, 'devices-toggle').click();
  await marker(page, 'rename-' + id).click();
  const input = marker(page, 'name-' + id);
  await input.fill('Keep my draft');
  const node = await input.elementHandle();
  const reads = s.count('GET', '/api/devices');
  await page.clock.runFor(31_000);
  expect(s.count('GET', '/api/devices')).toBe(reads);
  await expect.poll(() => s.count('GET', '/api/status')).toBeGreaterThan(1);
  await expect(input).toHaveValue('Keep my draft');
  expect(await node!.evaluate(node => node.isConnected && document.activeElement === node)).toBe(true);
  expect(s.failures).toEqual([]);
});

test('D03 unregister confirmation can cancel without mutation and explains retained IP', async ({ page, baseURL }) => {
  const s = createScenario('D03'); await openApp(page, s, baseURL!); await marker(page, 'devices-toggle').click();
  await marker(page, 'unregister-' + id).click();
  await expect(marker(page, 'unregister-confirm-' + id)).toContainText('Static IP reservations are kept');
  await marker(page, 'cancel-unregister-' + id).click();
  expect(s.count('POST', '/api/devices/change')).toBe(0);
  expect(s.failures).toEqual([]);
});

test('D05 fixed exit selection is draft; apply includes both revisions and unknown offers Check result', async ({ page, baseURL }) => {
  const s = createScenario('D05');
  const d = s.state.devices.devices.find((d: any) => d.id === id);
  s.on('POST', '/api/devices/location', request => {
    expect(request.body).toMatchObject({ id, code: 'de', revision: d.revision, locations_revision: s.state.devices.locations.revision });
    return { abort: true };
  });
  await openApp(page, s, baseURL!); await marker(page, 'devices-toggle').click();
  await marker(page, 'location-' + id).click();
  await marker(page, 'device-location-option-de').check();
  expect(s.count('POST', '/api/devices/location')).toBe(0);
  await marker(page, 'apply-device-location').click();
  await expect(marker(page, 'check-location-result')).toBeVisible();
  await page.clock.runFor(31_000);
  expect(s.count('POST', '/api/devices/location')).toBe(1);
  expect(s.failures).toEqual([]);
});

test('D06 routing setup dirty cancel requires discard and writes nothing', async ({ page, baseURL }) => {
  const s = createScenario('D06'); await openApp(page, s, baseURL!); await marker(page, 'devices-toggle').click();
  await marker(page, 'device-routing-setup').click();
  await marker(page, 'mapped-policy-policy:Policy0').uncheck();
  await marker(page, 'cancel-device-routing').click();
  await expect(marker(page, 'routing-setup-discard')).toContainText('Discard policy changes');
  await marker(page, 'routing-setup-discard-cancel').click();
  await expect(marker(page, 'mapped-policy-policy:Policy0')).not.toBeChecked();
  await marker(page, 'cancel-device-routing').click();
  await marker(page, 'routing-setup-discard-confirm').click();
  await expect(marker(page, 'device-routing-dialog')).not.toBeVisible();
  expect(s.requests.filter(r => r.method !== 'GET')).toEqual([]);
  expect(s.failures).toEqual([]);
});

test('D06 mark then unmark server uses successive settings revisions',async({page,baseURL})=>{
 const s=createScenario('D06');const d=s.state.devices.devices.find((d:any)=>d.id===id);let marked=false;
 s.on('POST','/api/devices/server',r=>{
   expect(r.body).toEqual({revision:s.state.devices.locations.settings.revision,id:marked?null:id});
   marked=!marked;d.is_server=marked;s.state.devices.locations.settings.revision=marked?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444';
   s.state.devices.locations.settings.server_device_id=marked?id:null;
   return {body:s.state.devices};
 });
 await openApp(page,s,baseURL!);await marker(page,'devices-toggle').click();await marker(page,'server-'+id).click();
 await expect(marker(page,'server-'+id)).toHaveAttribute('aria-pressed','true');
 await marker(page,'server-'+id).click();await expect(marker(page,'server-'+id)).toHaveAttribute('aria-pressed','false');
 expect(s.count('POST','/api/devices/server')).toBe(2);
});
test('D02 IP pin toggle submits the displayed device revision and updates readback',async({page,baseURL})=>{
 const s=createScenario('D02');const d=s.state.devices.devices.find((d:any)=>d.can_pin_ip&&d.registered);
 const initiallyPinned=d.ip_pinned;
 s.on('POST','/api/devices/change',r=>{
  expect(r.body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(r.body.changes).toEqual([{id:d.id,revision:d.revision,values:{ip_pinned:!initiallyPinned}}]);
  d.ip_pinned=!initiallyPinned;d.reserved_ip=d.ip_pinned?d.ip:'';return {body:s.state.devices};
 });
 await openApp(page,s,baseURL!);await marker(page,'devices-toggle').click();await marker(page,'pin-ip-'+d.id).click();
 await expect(marker(page,'pin-ip-'+d.id)).toHaveAttribute('aria-pressed',String(!initiallyPinned));
 expect(s.count('POST','/api/devices/change')).toBe(1);
});

test('D02 normalized duplicate registration requires explicit resolution and saves both revisions',async({page,baseURL})=>{
 const s=createScenario('D02');const newcomer=s.state.devices.devices.find((d:any)=>d.id==='02:00:00:00:00:45');const existing=s.state.devices.devices.find((d:any)=>d.id===id);
 s.on('POST','/api/devices/change',r=>{
  expect(r.body.changes).toEqual([
   {id:existing.id,revision:existing.revision,values:{name:'Old laptop'}},
   {id:newcomer.id,revision:newcomer.revision,values:{name:existing.name,registered:true,policy:newcomer.policy}},
  ]);
  newcomer.registered=true;newcomer.name=existing.name;existing.name='Old laptop';return {body:s.state.devices};
 });
 await openApp(page,s,baseURL!);await marker(page,'devices-toggle').click();await marker(page,'register-'+newcomer.id).click();
 await marker(page,'name-'+newcomer.id).fill('  '+existing.name.toUpperCase()+'  ');
 await expect(marker(page,'name-'+newcomer.id)).toHaveAttribute('aria-invalid','true');
 await marker(page,'save-'+newcomer.id).click();expect(s.count('POST','/api/devices/change')).toBe(0);
 await marker(page,'name-'+newcomer.id).fill(existing.name);await marker(page,'rename-existing').click();
 await marker(page,'conflict-name').fill('Old laptop');await marker(page,'save-'+newcomer.id).click();
 await expect(marker(page,'device-'+newcomer.id)).toContainText(newcomer.name);
 await expect.poll(()=>s.count('POST','/api/devices/change')).toBe(1);
});

test('D03 unregister and durable Undo restore registered device through exact operation ID',async({page,baseURL})=>{
 const s=undoScenario(createScenario('D03'));await openApp(page,s,baseURL!);await marker(page,'devices-toggle').click();
 await marker(page,'unregister-'+id).click();await marker(page,'confirm-unregister-'+id).click();await expect(marker(page,'register-'+id)).toBeVisible();
 await marker(page,'btn-activity').click();await marker(page,'device-history-undo').click();
 await expect.poll(()=>s.count('POST','/api/devices/undo')).toBe(1);await marker(page,'btn-activity').click();
 await expect(marker(page,'unregister-'+id)).toBeVisible();
});

test('D03 notification Undo shows its own progress and keeps width and focus', async ({ page, baseURL }) => {
  const scenario = undoScenario(createScenario('D03'));
  const restore = scenario.handlers.get('POST /api/devices/undo')!;
  scenario.on('POST', '/api/devices/undo', async (request) => ({ ...(await restore(request)), hold: 'undo' }));
  await openApp(page, scenario, baseURL!);
  await marker(page, 'devices-toggle').click();
  await marker(page, 'unregister-' + id).click();
  await marker(page, 'confirm-unregister-' + id).click();
  const undo = marker(page, 'device-toast-undo');
  await expect(undo).toHaveText('Undo');
  const idle = await undo.boundingBox();
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => scenario.count('POST', '/api/devices/undo')).toBe(1);
  await expect(undo).toHaveAttribute('aria-busy', 'true');
  await expect(undo).toHaveAttribute('aria-disabled', 'true');
  await expect(undo).toHaveText('Undoing');
  await expect(undo.locator('.terminal-action-glyph')).toBeVisible();
  await expect(undo).toBeFocused();
  expect((await undo.boundingBox())?.width).toBe(idle?.width);
  await page.keyboard.press('Enter');
  expect(scenario.count('POST', '/api/devices/undo')).toBe(1);
  await scenario.release('undo');
  await expect(undo).toHaveText('Undone');
  await expect(undo).toHaveAttribute('aria-busy', 'false');
  await expect(undo).toBeFocused();
  expect((await undo.boundingBox())?.width).toBe(idle?.width);
  await expect(marker(page, 'unregister-' + id)).toBeVisible();
});
