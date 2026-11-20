import type { BrowserContext, Page, Route } from '@playwright/test';
import status from '../fixtures/status.json' with { type: 'json' };
import devices from '../fixtures/devices.json' with { type: 'json' };
import routing from '../fixtures/routing.json' with { type: 'json' };
import failover from '../fixtures/failover.json' with { type: 'json' };
import connectivity from '../fixtures/connectivity.json' with { type: 'json' };
import mainOperation from '../fixtures/main-operation.json' with { type: 'json' };
import mainPublicOperation from '../fixtures/main-public-operation.json' with { type: 'json' };
import sessions from '../fixtures/sessions.json' with { type: 'json' };
export const installedScenarios = new WeakMap<BrowserContext, Set<ScenarioEngine>>();
export const NOW = '2026-11-17T09:00:00Z';
export type RequestEntry = { method: string; path: string; query: Record<string, string>; body: any; headers: Record<string, string> };
type Reply = { status?: number; body?: any; headers?: Record<string, string>; abort?: boolean; hold?: string; bytes?: Buffer; contentType?: string };
type Handler = (request: RequestEntry) => Reply | Promise<Reply>;

/** Independent HTTP state machine: no application code or domain rules imported. */
export class ScenarioEngine {
  readonly requests: RequestEntry[] = [];
  readonly failures: string[] = [];
  readonly allowedHttpErrors = new Set<string>();
  readonly state: any = structuredClone({ status, devices, routing, failover, connectivity, sessions,
    operations: {}, session: { configured: true, authenticated: true, session_id: 'fixture-session' } });
  readonly handlers = new Map<string, Handler>();
  private held = new Map<string, { route: Route; reply: Reply }>();
  constructor(readonly id: string) {
    for (const [path, key] of Object.entries({ '/api/status': 'status', '/api/devices': 'devices',
      '/api/routing': 'routing', '/api/failover': 'failover', '/api/connectivity': 'connectivity',
      '/api/auth/sessions': 'sessions', '/api/auth/session': 'session' })) {
      this.on('GET', path, () => ({ body: structuredClone(this.state[key]) }));
    }
    this.on('GET', '/api/routing/id', () => ({ body: { id: '22222222-2222-4222-8222-222222222222' } }));
  }
  on(method: string, path: string, handler: Handler) { this.handlers.set(`${method} ${path}`, handler); return this; }
  count(method: string, path: string) { return this.requests.filter(r => r.method === method && r.path === path).length; }
  async handle(route: Route) {
    const request = route.request();
    const entry = { method: request.method(), path: new URL(request.url()).pathname,
      query: Object.fromEntries(new URL(request.url()).searchParams), body: request.postDataJSON(), headers: request.headers() };
    this.requests.push(entry);
    if (entry.method !== 'GET' && (entry.headers['x-xk-request'] !== '1' || !entry.headers['content-type']?.startsWith('application/json'))) {
      this.failures.push(`Invalid mutation transport ${entry.method} ${entry.path}`);
      await route.abort('failed'); return;
    }
    const handler = this.handlers.get(`${entry.method} ${entry.path}`);
    if (!handler) { this.failures.push(`Unmatched ${entry.method} ${entry.path}`); await route.abort('failed'); return; }
    const reply = await handler(entry);
    if (reply.abort || (reply.status || 200) >= 400) this.allowedHttpErrors.add(entry.path);
    if (reply.hold) { this.held.set(reply.hold, { route, reply }); return; }
    await this.respond(route, reply);
  }
  private async respond(route: Route, reply: Reply) {
    if (reply.abort) { await route.abort('failed'); return; }
    await route.fulfill({ status: reply.status || 200, contentType: reply.contentType || 'application/json',
      body: reply.bytes ?? JSON.stringify(reply.body ?? {}), headers: reply.headers });
  }
  async release(name: string) {
    const held = this.held.get(name);
    if (!held) throw new Error(`No held reply ${name}`);
    this.held.delete(name); await this.respond(held.route, held.reply);
  }
  advance(step: 'committed' | 'rolled_back' | 'unknown' | 'recovery_failed' | 'rejected') {
    const operation = this.state.status.operation;
    if (!operation) throw new Error('No accepted operation');
    operation.phase = step;
    operation.blocking = !['committed', 'rolled_back', 'rejected'].includes(step);
    const journal = this.state.operations[operation.id];
    journal.phase = step;
    journal.message = operation.message;
    if (!operation.blocking) this.state.status.operation = null;
    if (step === 'committed') {
      this.state.status.active_code = operation.target_code;
      this.state.status.active_entry_code = operation.target_entry_code;
      this.state.status.active_route = { mode: operation.target_entry_code ? 'chain' : 'single',
        exit_code: operation.target_code, exit_name: operation.target_name,
        entry_code: operation.target_entry_code, entry_name: operation.target_route.entry_name };
    }
  }
  switch(mode: 'accepted' | 'held' | 'lost' | 'busy' | 'precondition' = 'accepted') {
    this.on('POST', '/api/switch', request => {
      if (mode === 'busy' || mode === 'precondition') return { status: 409, body: { code: mode, error: 'Synthetic router refusal' } };
      const { operation_id: id, code, entry_code = null } = request.body;
      const operation = { ...structuredClone(mainOperation), id, created_at: NOW, target_code: code, target_entry_code: entry_code,
        target_name: this.state.status.available.find((loc: any) => loc.code === code)?.name,
        target_route: { mode: entry_code ? 'chain' : 'single', exit_code: code, entry_code,
          exit_name: this.state.status.available.find((loc: any) => loc.code === code)?.name,
          entry_name: this.state.status.available.find((loc: any) => loc.code === entry_code)?.name ?? null },
        confirmed_route: structuredClone(this.state.status.active_route) };
      this.state.status.operation = { ...structuredClone(mainPublicOperation), ...structuredClone(operation) };
      this.state.operations[id] = operation;
      this.on('GET', `/api/routing/operations/${id}`, () => ({ body: structuredClone(this.state.operations[id]) }));
      return { status: 202, body: { operation: structuredClone(operation) }, hold: mode === 'held' ? 'switch' : undefined, abort: mode === 'lost' };
    });
    return this;
  }
  async install(context: BrowserContext, baseURL: string) {
    if (!installedScenarios.has(context)) installedScenarios.set(context, new Set());
    installedScenarios.get(context)!.add(this);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(baseURL).origin) {
        this.failures.push(`External network ${url.origin}`); await route.abort(); return;
      }
      if (url.pathname.startsWith('/api/')) await this.handle(route);
      else await route.continue();
    });
  }
}
export const createScenario = (id: string) => new ScenarioEngine(id);
export const marker = (page: Page, name: string) => page.locator(`[data-marker="${name}"]`);
export async function openApp(page: Page, scenario: ScenarioEngine, baseURL: string, theme = 'light') {
  page.on('pageerror', error => scenario.failures.push('Page error: ' + error.message));
  await scenario.install(page.context(), baseURL);
  await page.addInitScript(value => { try { localStorage.setItem('xk_theme', value); } catch {} }, theme);
  await page.clock.install({ time: new Date(Date.parse(NOW) - 60_000) });
  await page.clock.pauseAt(new Date(NOW));
  if (process.env.UI_NEGATIVE_CONTROL === 'wrong-post') await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, options) => {
      if (String(input) === '/api/switch' && options?.body) {
        const body = JSON.parse(String(options.body)); body.code = 'se';
        options = { ...options, body: JSON.stringify(body) };
      }
      return original(input, options);
    };
  });
  await page.goto('/');
}
