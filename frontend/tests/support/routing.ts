import { readFileSync } from 'node:fs';
import draft from '../fixtures/routing-draft.json' with { type: 'json' };
import preview from '../fixtures/routing-preview.json' with { type: 'json' };
import history from '../fixtures/routing-history.json' with { type: 'json' };
import snapshot from '../fixtures/routing-snapshot.json' with { type: 'json' };
import { type ScenarioEngine } from './scenario';
import { expect } from '@playwright/test';
export const originalBytes = readFileSync(new URL('../fixtures/routing-original.jsonc', import.meta.url));
export const snapshotId = snapshot.id;
export function routingScenario(s: ScenarioEngine, withDraft = true) {
  if (withDraft) s.state.routing.draft = structuredClone(draft);
  s.on('POST', '/api/routing/preview', request => {
    expect(request.body).toEqual({ intent: 'apply', expected_current_hash: s.state.routing.current.sha256, draft_revision: draft.revision });
    return { body: structuredClone(preview) };
  });
  s.on('GET', '/api/routing/history', () => ({ body: history }));
  s.on('GET', `/api/routing/history/${snapshot.id}`, () => ({ body: snapshot }));
  s.on('GET', `/api/routing/history/${snapshot.id}/download`, () => ({ bytes: originalBytes, contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="05_routing.json"' } }));
  return s;
}

import restoreContext from '../fixtures/routing-restore-context.json' with { type: 'json' };
export const restoreSnapshotId = restoreContext.snapshot.id;
export function restoreScenario(s: ScenarioEngine) {
  s.state.routing=structuredClone(restoreContext.routing);
  s.on('GET','/api/routing/history',()=>({body:restoreContext.history}));
  s.on('GET',`/api/routing/history/${restoreSnapshotId}`,()=>({body:restoreContext.snapshot}));
  s.on('GET',`/api/routing/history/${restoreSnapshotId}/download`,()=>({bytes:originalBytes,contentType:'application/octet-stream'}));
  s.on('POST','/api/routing/preview',r=>{
    expect(r.body).toEqual({intent:'restore',expected_current_hash:restoreContext.routing.current.sha256,snapshot_id:restoreSnapshotId});
    return {body:restoreContext.preview};
  });
  return s;
}

import diffContext from '../fixtures/routing-diff-context.json' with { type: 'json' };
export function diffScenario(s: ScenarioEngine) {
 s.state.routing=structuredClone(diffContext.routing);
 s.on('POST','/api/routing/preview',r=>{
  expect(r.body).toEqual({intent:'apply',expected_current_hash:s.state.routing.current.sha256,draft_revision:s.state.routing.draft.revision});
  return {body:structuredClone(diffContext.preview)};
 });return s;
}

export function recoveryScenario(s: ScenarioEngine, phase: 'unknown'|'recovery_failed') {
 restoreScenario(s);
 const op:any=structuredClone(restoreContext.history.operations[0]);
 Object.assign(op,{phase,message:phase==='unknown'?'Router result is not confirmed':'Router recovery could not be verified'});
 delete op.completed_at;delete op.after_snapshot;delete op.diagnostics;delete op.phase_times.committed;
 s.state.routing.operations=[op];
 s.on('GET','/api/routing/history',()=>({body:{...restoreContext.history,operations:[op]}}));
 s.on('GET',`/api/routing/operations/${op.id}`,()=>({body:op}));
 return op.id;
}
