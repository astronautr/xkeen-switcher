import contexts from '../fixtures/main-contexts.json' with { type: 'json' };
import hysteria from '../fixtures/hysteria-location.json' with { type: 'json' };
import { NOW, type ScenarioEngine } from './scenario';
export function confirmedChain(s: ScenarioEngine, entry = 'de', exit = 'fi') {
  const name = (code: string) => s.state.status.available.find((loc: { code: string }) => loc.code === code)?.name || code;
  Object.assign(s.state.status, { active_code: exit, active_entry_code: entry,
    active_route: { mode: 'chain', entry_code: entry, exit_code: exit, entry_name: name(entry), exit_name: name(exit) },
    active_health: { route_ok: null, tcp_ok: true } });
  Object.assign(s.state.status.failover, { enabled: true, suspended: true, suspension_reason: 'chain_active', whitelist: ['fi', 'se'] });
}
export function serverContext(s: ScenarioEngine, mode: keyof typeof contexts) {
  s.state.status.server_route = structuredClone(contexts[mode]);
}
export function hysteriaChain(s: ScenarioEngine) {
  s.state.status.available = s.state.status.available.map((loc: { code: string }) => loc.code === 'se' ? structuredClone(hysteria) : loc);
  confirmedChain(s, 'de', 'se');
}
export function ephemeralActivity(s: ScenarioEngine, scope: 'read' | 'diagnostic' | 'router') {
  s.state.status.operation = { id: null, ephemeral: true, phase: 'preparing', blocking: true, scope,
    kind: scope === 'read' ? 'read' : scope === 'diagnostic' ? 'route_check' : 'update', source: 'manual',
    created_at: NOW, message: scope === 'read' ? 'Reading devices from the router' : scope === 'diagnostic' ? 'Checking server route' : 'Refreshing subscription' };
}
