import { expectVisualTiles } from '../support/visual';
import {undoScenario,interruptedScenario,changedDeviceId} from '../support/devices';
import { test, expect } from '../support/test';
import { createScenario, marker, openApp, NOW, type ScenarioEngine } from '../support/scenario';
import { routingScenario, recoveryScenario, diffScenario, restoreScenario, restoreSnapshotId, snapshotId } from '../support/routing';
import type { Page } from '@playwright/test';
import invalidRouting from '../fixtures/routing-invalid-context.json' with { type: 'json' };
type Screen = { id: string; state: string; setup?: (s: ScenarioEngine) => void; open?: (p: Page, s: ScenarioEngine) => Promise<void>; ready: string };
const settings = (section?: string) => async (p: Page) => {
  await marker(p, 'btn-settings').click();
  if (section) await marker(p, 'settings-' + section).click();
};
const operation = (phase: string, ephemeral = false) => (s: ScenarioEngine) => {
  s.state.status.operation = { id: ephemeral ? null : '11111111-1111-4111-8111-111111111111',
    kind: ephemeral ? 'read' : 'main', ephemeral, phase, source: 'manual', trigger: 'manual',
    target_code: 'de', target_name: 'Germany 🇩🇪', confirmed_route: s.state.status.active_route,
    blocking: !['committed', 'rolled_back', 'rejected'].includes(phase), created_at: NOW,
    message: 'Checking the requested Main location.' };
};
const chain = (health: boolean | null) => (s: ScenarioEngine) => {
  Object.assign(s.state.status, { active_entry_code: 'de',
    active_route: { mode: 'chain', exit_code: 'fi', exit_name: 'Finland 🇫🇮', entry_code: 'de', entry_name: 'Germany 🇩🇪' },
    active_health: { route_ok: health, tcp_ok: true }, failover: { ...s.state.status.failover, enabled: true, suspended: true, suspension_reason: 'chain_active', whitelist: ['fi', 'se'] } });
};
const screens: Screen[] = [
  { id: 'A01', state: 'setup', setup: s => { s.state.session = { configured: false, authenticated: false, session_id: null }; }, ready: 'password-submit' },
  { id: 'A02', state: 'password-login', setup: s => { s.state.session.authenticated = false; }, ready: 'gate-input' },
  { id: 'A02', state: 'code-login', setup: s => { s.state.session.authenticated = false; }, open: async p => { await marker(p, 'gate-mode').click(); }, ready: 'gate-code-hint' },
  { id: 'A03', state: 'sessions', open: settings('access'), ready: 'device-current' },
  { id: 'A03', state: 'change-password', open: async p => { await settings('access')(p); await marker(p, 'btn-change-password').click(); }, ready: 'password-current' },
  ...['pending', 'completed', 'expired', 'replaced', 'exhausted'].map(state => ({ id: 'A04', state, setup: (s: ScenarioEngine) => {
    s.on('POST', '/api/auth/pairing-code', () => ({ body: { id: 'pair-fixture', code: '123456', status: 'pending', expires_at: Date.parse(NOW) / 1000 + 300 } }));
    s.on('GET', '/api/auth/pairing-code', (request) => { expect(request.query).toEqual({ id: 'pair-fixture' }); return ({ body: { id: 'pair-fixture', status: state, expires_at: Date.parse(NOW) / 1000 + 300, ...(state === 'completed' ? { device: { id: 'fixture-phone', label: 'Safari · phone', created_at: NOW } } : {}) } }); });
  }, open: async (p: Page) => { await marker(p, 'btn-add-device').click(); await expect(marker(p, 'pair-code')).toHaveText('123 456'); if (state !== 'pending') { await p.clock.runFor(2001); await expect(marker(p, 'pair-result')).not.toBeEmpty(); } }, ready: 'pair-close' })),
  { id: 'M01', state: 'single-confirmed', ready: 'active-name' },
  ...['preparing', 'validating', 'applying', 'committed', 'rolled_back', 'rejected', 'unknown', 'recovery_failed'].map(phase => ({ id: 'O01', state: phase, setup: (s: ScenarioEngine) => { s.switch(); }, open: async (p: Page, s: ScenarioEngine) => {
    await p.locator('[data-marker="loc-select"][data-code="de"]').click();
    await expect.poll(() => s.count('POST', '/api/switch')).toBe(1);
    if (['committed', 'rolled_back', 'rejected', 'unknown', 'recovery_failed'].includes(phase)) s.advance(phase as any);
    else { s.state.status.operation.phase = phase; s.state.operations[s.state.status.operation.id].phase = phase; }
    await p.clock.runFor(1600);
    if (['committed', 'rolled_back', 'rejected'].includes(phase)) { await expect(marker(p, 'toast')).toBeVisible(); }
    else { await marker(p, 'btn-activity').click(); await expect(marker(p, 'operation-status')).toHaveAttribute('data-phase', phase); }
  }, ready: ['committed', 'rolled_back', 'rejected'].includes(phase) ? 'toast' : 'activity-panel' })),
  { id: 'O02', state: 'ephemeral-read', setup: operation('reading', true), open: async p => { await marker(p, 'btn-activity').click(); }, ready: 'operation-status' },
  { id: 'M06', state: 'chain-draft', open: async p => { await marker(p, 'main-mode-chain').click(); }, ready: 'chain-apply' },
  ...[true, false, null].map(health => ({ id: 'M07', state: health === null ? 'chain-unverified' : health ? 'chain-healthy' : 'chain-failed', setup: chain(health), ready: 'failover-paused' })),
  { id: 'M08', state: 'server-unknown', ready: 'outbound-box' },
  { id: 'S01', state: 'empty-subscription', setup: s => { Object.assign(s.state.status, { subscription_url: null, available: [], active_code: null, active_route: { mode: 'single', exit_code: null, exit_name: null, entry_code: null, entry_name: null } }); }, ready: 'locations-empty' },
  { id: 'S01', state: 'refresh-failed', setup: s => { s.state.status.last_update_status = 'fail'; }, ready: 'pending-active-config' },
  { id: 'S01', state: 'url-editor', open: async p => { await marker(p, 'subscription-toggle').click(); }, ready: 'subscription-home-url' },
  ...['sni', 'config'].map(kind => ({ id: 'S02', state: 'pending-' + kind, setup: (s: ScenarioEngine) => { Object.assign(s.state.status, { pending_reapply_code: 'fi', pending_update_kind: kind, pending_reapply_since: '2026-11-17T08:50:00Z' }); }, ready: 'pending-active-config' })),
  ...['daily', 'interval', 'disabled'].map(mode => ({ id: 'S03', state: mode, setup: (s: ScenarioEngine) => { Object.assign(s.state.status.auto_update, { enabled: mode !== 'disabled', mode: mode === 'disabled' ? 'daily' : mode, sni_daily: true }); }, open: settings('subscription'), ready: 'auto-update-section' })),
  ...['stopped', 'unknown'].map(state => ({ id: 'S04', state, setup: (s: ScenarioEngine) => { s.state.status.xkeen_state = state; }, ready: 'xkeen-state' })),
  { id: 'S04', state: 'stop-confirm', open: async p => { await marker(p, 'btn-xkeen-toggle').click(); }, ready: 'xkeen-stop-confirm' },
  { id: 'S06', state: 'failover', open: settings('failover'), ready: 'fo-section' },
  { id:'S06',state:'enabled-priority-and-recovery',setup:s=>{Object.assign(s.state.failover.config,{enabled:true,auto_failback:true,auto_stop_on_total_failure:true,auto_restart_on_recovery:true,whitelist:['de','fi']});},open:settings('failover'),ready:'fo-section'},
  { id: 'S07', state: 'connectivity', open: settings('checks'), ready: 'connectivity-section' },
  { id: 'D01', state: 'inventory', open: async p => { await marker(p, 'devices-toggle').click(); }, ready: 'search-devices' },
  { id: 'D02', state: 'register', open: async p => { await marker(p,'devices-toggle').click();await marker(p,'register-02:00:00:00:00:45').click(); }, ready:'name-02:00:00:00:00:45' },
  { id: 'D02', state: 'duplicate-name', open: async (p,s) => { await marker(p,'devices-toggle').click();await marker(p,'register-02:00:00:00:00:45').click();await marker(p,'name-02:00:00:00:00:45').fill(s.state.devices.devices.find((d:any)=>d.id==='02:00:00:00:00:21').name);await expect(marker(p,'name-02:00:00:00:00:45')).toHaveAttribute('aria-invalid','true'); }, ready:'name-02:00:00:00:00:45' },
  { id: 'D02', state: 'rename', open: async p => { await marker(p, 'devices-toggle').click(); await marker(p, 'rename-02:00:00:00:00:21').click(); }, ready: 'name-02:00:00:00:00:21' },
  { id: 'R01', state: 'rules', open: async p => { await marker(p, 'nav-routing').click(); }, ready: 'routing-add' },
  { id: 'R02', state: 'new-rule', open: async p => { await marker(p, 'nav-routing').click(); await marker(p, 'routing-add').click(); }, ready: 'rule-name' },
  { id: 'R06', state: 'restore-review', setup: s => { restoreScenario(s); }, open: async p => { await marker(p,'nav-routing').click();await marker(p,'routing-versions').click();await marker(p,'version-'+restoreSnapshotId).click();await marker(p,'version-restore').click();await expect(marker(p,'review-apply')).toContainText('restore and restart'); }, ready: 'review-apply' },
  { id: 'R07', state: 'parser-error', setup: s => { s.state.routing.model = null; s.state.routing.parse_error = 'Invalid JSON at line 3'; }, open: async p => { await marker(p, 'nav-routing').click(); await expect(p.getByText('Configuration cannot be edited', {exact:true})).toBeVisible(); }, ready: 'routing-status' },
  { id: 'R07', state: 'helper-unavailable', setup: s => { s.state.routing.capabilities = { ready: false, reason: 'Routing helper v3 is required', version: null, mock: false, bundle: false, selective: false }; }, open: async p => { await marker(p, 'nav-routing').click(); await expect(p.getByText('Routing helper unavailable', {exact:true})).toBeVisible(); }, ready: 'routing-status' },
  ...(['unknown', 'recovery_failed'] as const).map(phase => ({
    id: 'R07',
    state: 'recovery-' + phase,
    setup: (scenario: ScenarioEngine) => { recoveryScenario(scenario, phase); },
    open: async (page: Page, scenario: ScenarioEngine) => {
      await marker(page, 'nav-routing').click();
      await marker(page, 'routing-versions').click();
      await marker(page, 'history-operation-' + scenario.state.routing.operations[0].id).click();
      const notice = marker(page, 'routing-panel').locator('.panel-body > .notice > strong');
      await expect(notice).toHaveText(phase === 'unknown' ? 'Result not confirmed yet' : 'Recovery has not been confirmed');
      await expect(notice).toBeVisible();
    },
    ready: 'operation-refresh',
  })),
  { id: 'R07', state: 'drift', setup: s => { s.state.routing.drift = true; }, open: async p => { await marker(p, 'nav-routing').click(); }, ready: 'resolve-conflict' },
  { id: 'H02', state: 'notifications-empty', open: async p => { await marker(p, 'btn-history').click(); }, ready: 'history-dialog' },
  { id: 'M02', state: 'post-pending', setup: s => { s.switch('held'); }, open: async (p, s) => { await p.locator('[data-marker="loc-select"][data-code="de"]').click(); await expect.poll(() => s.count('POST', '/api/switch')).toBe(1); await marker(p, 'btn-activity').click(); }, ready: 'operation-status' },
  { id: 'M03', state: 'lost-response', setup: s => { s.switch('lost'); }, open: async (p, s) => { await p.locator('[data-marker="loc-select"][data-code="de"]').click(); await expect.poll(() => s.count('POST', '/api/switch')).toBe(1); await marker(p, 'btn-activity').click(); }, ready: 'operation-status' },
  ...['busy', 'precondition'].map(reason => ({ id: 'M04', state: reason, setup: (s: ScenarioEngine) => { s.switch(reason as any); }, open: async (p: Page) => { await p.locator('[data-marker="loc-select"][data-code="de"]').click(); }, ready: 'switch-refusal' })),
  { id: 'O04', state: 'status-offline', open: async (p,s) => { await expect(marker(p, 'active-name')).toBeVisible(); s.on('GET', '/api/status', () => ({ abort: true })); await p.clock.runFor(10_001); }, ready: 'offline-state' },
  { id: 'D03', state: 'unregister-confirm', open: async p => { await marker(p, 'devices-toggle').click(); await marker(p, 'unregister-02:00:00:00:00:21').click(); }, ready: 'unregister-confirm-02:00:00:00:00:21' },
  {id:'D03',state:'interrupted-change',setup:s=>{interruptedScenario(s);},open:async p=>{await marker(p,'devices-toggle').click();await expect(p.locator('#devices-feedback')).not.toBeEmpty();},ready:'router-devices-refresh'},
  {id:'D03',state:'undone',setup:s=>{undoScenario(s);},open:async(p,s)=>{await marker(p,'devices-toggle').click();await marker(p,'unregister-'+changedDeviceId).click();await marker(p,'confirm-unregister-'+changedDeviceId).click();await expect(marker(p,'register-'+changedDeviceId)).toBeVisible();await marker(p,'btn-history').click();await marker(p,'device-history-undo').click();await expect.poll(()=>s.count('POST','/api/devices/undo')).toBe(1);await marker(p,'history-close').click();await expect(marker(p,'unregister-'+changedDeviceId)).toBeVisible();},ready:'device-'+changedDeviceId},
  {id:'D03',state:'devices-unavailable',setup:s=>{s.on('GET','/api/devices',()=>({status:503,body:{error:'Device inventory unavailable',code:'unavailable'}}));},open:async p=>{await marker(p,'devices-toggle').click();await expect(p.locator('#devices-feedback')).not.toBeEmpty();},ready:'router-devices-refresh'},
  { id: 'D04', state: 'busy-keeps-draft', setup: s => { s.on('POST', '/api/devices/change', () => ({ status: 409, body: { code: 'busy', error: 'Router busy' } })); }, open: async p => { await marker(p, 'devices-toggle').click(); await marker(p, 'rename-02:00:00:00:00:21').click(); await marker(p, 'name-02:00:00:00:00:21').fill('Study laptop'); await marker(p, 'save-02:00:00:00:00:21').click(); await expect(p.getByRole('alert').filter({ hasText: 'Router busy' })).toBeVisible(); }, ready: 'name-02:00:00:00:00:21' },
  { id: 'D05', state: 'location-picker', open: async p => { await marker(p, 'devices-toggle').click(); await marker(p, 'location-02:00:00:00:00:21').click(); }, ready: 'device-location-dialog' },
  ...['ip-conflict','vanished-exit'].map(kind=>({id:'D05',state:kind,setup:(s:ScenarioEngine)=>{const d=s.state.devices.devices.find((d:any)=>d.id==='02:00:00:00:00:21');Object.assign(d.location,{code:'de',name:'Germany 🇩🇪',ip:d.ip,ip_conflict:kind==='ip-conflict',unavailable:kind==='vanished-exit',editable:false});},open:async(p:Page)=>{await marker(p,'devices-toggle').click();},ready:'device-02:00:00:00:00:21'})),
  { id: 'D06', state: 'policy-setup', open: async p => { await marker(p, 'devices-toggle').click(); await marker(p, 'device-routing-setup').click(); }, ready: 'device-routing-dialog' },
  { id: 'R03', state: 'dirty-discard', open: async p => { await marker(p, 'nav-routing').click(); await marker(p, 'routing-add').click(); await marker(p, 'rule-name').fill('Unfinished local rule'); await marker(p, 'rule-cancel').click(); }, ready: 'routing-confirm' },
  { id: 'R04', state: 'preview', setup: s => { routingScenario(s); }, open: async p => { await marker(p, 'nav-routing').click(); await marker(p, 'draft-review').click(); }, ready: 'review-apply' },
  {id:'R04',state:'all-diff-kinds',setup:s=>{diffScenario(s);},open:async p=>{await marker(p,'nav-routing').click();await marker(p,'draft-review').click();},ready:'review-apply'},
  {id:'R04',state:'validation-unavailable',setup:s=>{routingScenario(s);s.on('POST','/api/routing/preview',()=>({status:503,body:{error:'Could not determine XKeen status. Try validation again when the connection is restored.',code:'health',validation:[]}}));},open:async p=>{await marker(p,'nav-routing').click();await marker(p,'draft-review').click();await expect(marker(p,'routing-feedback')).toContainText('The router cannot perform this action yet.');},ready:'routing-feedback'},
  {
    id: 'R04', state: 'validation-error',
    setup: s => { s.state.routing = structuredClone(invalidRouting.routing); },
    open: async (p, s) => {
      await marker(p, 'nav-routing').click();
      await expect(p.locator('.field-error')).toHaveText('Invalid port or range');
      await expect(marker(p, 'draft-review')).toBeDisabled();
      await expect(p.getByText('Fix rule errors before applying', { exact: true })).toBeVisible();
      expect(s.count('POST', '/api/routing/preview')).toBe(0);
    },
    ready: 'draft-review',
  },
  { id: 'R05', state: 'busy-preview', setup: s => { routingScenario(s); s.on('POST', '/api/routing/apply', () => ({ status: 409, body: { code: 'busy', error: 'Router busy' } })); }, open: async p => { await marker(p, 'nav-routing').click(); await marker(p, 'draft-review').click(); await marker(p, 'review-apply').click(); await expect(marker(p, 'panel-feedback')).toContainText('busy'); }, ready: 'review-apply' },
  { id: 'R06', state: 'versions', setup: s => { routingScenario(s, false); }, open: async p => { await marker(p, 'nav-routing').click(); await marker(p, 'routing-versions').click(); }, ready: 'version-' + snapshotId },
  { id: 'R06', state: 'snapshot', setup: s => { routingScenario(s, false); }, open: async p => { await marker(p, 'nav-routing').click(); await marker(p, 'routing-versions').click(); await marker(p, 'version-' + snapshotId).click(); }, ready: 'version-download' },
  { id: 'X05', state: 'keyboard-choice', open: async p => { await marker(p, 'main-mode-chain').click(); await marker(p, 'chain-entry').focus(); await marker(p, 'chain-entry').press('Enter'); }, ready: 'chain-entry-option-de' },
  { id: 'X03', state: 'settings-theme', open: settings(), ready: 'theme-seg' },
];
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) for (const theme of ['light', 'dark'] as const)
  for (const screen of screens) test(`${screen.id} ${screen.state} ${viewport.width} ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    const scenario = createScenario(screen.id + ':' + screen.state);
    screen.setup?.(scenario);
    await openApp(page, scenario, baseURL!, theme);
    await screen.open?.(page, scenario);
    await expect(marker(page, screen.ready)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.clock.runFor(48);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images, img => img.decode())); });
    expect(scenario.failures).toEqual([]);
    await expectVisualTiles(page, `${screen.id}-${screen.state}-chromium-${viewport.width}x${viewport.height}-${theme}.png`);
  });

for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark'] as const)
  for (const surface of ['main', 'settings', 'devices', 'routing']) test(`X01 ${surface} ${width} ${theme}`, async ({ page, baseURL }) => {
    const height = width === 320 ? 740 : width === 390 ? 844 : 1000;
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: theme });
    const s = createScenario('X01:' + surface); await openApp(page, s, baseURL!, theme);
    await expect(marker(page, 'active-name')).toBeVisible();
    if (surface === 'settings') await settings('subscription')(page);
    if (surface === 'devices') { await marker(page, 'devices-toggle').click(); await expect(marker(page, 'search-devices')).toBeVisible(); }
    if (surface === 'routing') { await marker(page, 'nav-routing').click(); await expect(marker(page, 'routing-add')).toBeVisible(); }
    await page.mouse.move(0, 0); await page.evaluate(() => window.scrollTo(0, 0)); await page.clock.runFor(48);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectVisualTiles(page, `X01-${surface}-chromium-${width}x${height}-${theme}.png`);
  });
for (const width of [390, 639, 640, 641, 719, 720, 721, 1440]) for (const theme of ['light', 'dark'] as const)
  test(`X02 open routing form breakpoint ${width} ${theme}`, async ({ page, baseURL }) => {
    const height = width === 1440 ? 1000 : 844;
    await page.setViewportSize({ width: 1440, height }); await page.emulateMedia({ colorScheme: theme });
    const s = createScenario('X02:routing'); await openApp(page, s, baseURL!, theme);
    await marker(page, 'nav-routing').click(); await marker(page, 'routing-add').click();
    await marker(page, 'rule-name').fill('Draft across a breakpoint');
    await page.setViewportSize({ width, height }); await page.clock.runFor(48);
    await expect(marker(page, 'rule-name')).toHaveValue('Draft across a breakpoint');
    await page.mouse.move(0, 0); await page.evaluate(() => window.scrollTo(0, 0)); await page.clock.runFor(48);
    await page.evaluate(() => document.fonts.ready);
    await expectVisualTiles(page, `X02-routing-form-chromium-${width}x${height}-${theme}.png`);
  });
