import {expect, it} from '@rstest/core';
import {ApiClient, StaleSessionError} from '../api/client';
import {keys} from '../api/keys';
import {BrowserStorage} from '../browser/storage';
import {SessionRuntime} from './runtime';
import statusFixture from '../../tests/fixtures/status.json';

function memoryStorage() {
 const data = new Map<string, string>();
 return {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); },
  removeItem: (key: string) => { data.delete(key); },
 };
}
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return {promise, resolve};
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(handler: (path: string) => Response | Promise<Response>) {
 const calls: string[] = [];
 const api = new ApiClient(async path => { calls.push(String(path)); return handler(String(path)); });
 const runtime = new SessionRuntime({api, storage: new BrowserStorage(memoryStorage(), memoryStorage())});
 runtime.queryClient.setQueryData(keys.session, {configured: true, authenticated: true, session_id: 'first'});
 runtime.queryClient.setQueryData(keys.status, structuredClone(statusFixture));
 return {runtime, calls};
}

it.each([200, 502])('S01 POST HTTP%s reconciliation supersedes a pre-action poll and waits for fresh data', async postStatus => {
 const before = deferred<Response>(), after = deferred<Response>();
 let reads = 0;
 const {runtime, calls} = setup(path => path === '/api/update'
  ? json(postStatus === 200 ? {ok: true} : {error: 'Refresh failed'}, postStatus)
  : ++reads === 1 ? before.promise : after.promise);
 const poll = runtime.refreshStatus();
 await flush();
 let settled = false;
 const outcome = runtime.refreshSubscription().then(
  value => { settled = true; return {value}; },
  error => { settled = true; return {error}; },
 );
 await flush();
 expect(calls).toEqual(['/api/status', '/api/update', '/api/status']);
 before.resolve(json(statusFixture));
 await poll;
 await flush();
 expect(settled).toBe(false);
 expect(runtime.view().blocking).toBe(true);
 const last_update_at = '2026-11-17T10:00:00Z';
 after.resolve(json({...statusFixture, last_update_at, last_update_status: postStatus === 200 ? 'ok' : 'fail'}));
 const result = await outcome;
 expect(result).toMatchObject(postStatus === 200 ? {value: {ok: true}} : {error: {message: 'Refresh failed'}});
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({last_update_at});
 expect(runtime.view().blocking).toBe(false);
 expect(calls).toEqual(['/api/status', '/api/update', '/api/status']);
});

it.each([200, 503])('S01 failed refresh reads status once (HTTP%s) and preserves the original error', async status => {
 const readback = deferred<Response>();
 const {runtime, calls} = setup(path => path === '/api/update'
  ? json({error: 'Subscription refresh failed'}, 502) : readback.promise);
 const result = runtime.refreshSubscription();
 const assertion = expect(result).rejects.toMatchObject({message: 'Subscription refresh failed', status: 502});
 await flush();
 expect(calls).toEqual(['/api/update', '/api/status']);
 expect(runtime.view()).toMatchObject({blocking: true, operation: {kind: 'update'}});
 expect(runtime.pendingMutations()).toBe(0);
 readback.resolve(status === 200
  ? json({...statusFixture, last_update_status: 'fail', pending_reapply_code: 'fi'})
  : json({error: 'Status read failed'}, status));
 await assertion;
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({
  last_update_status: status === 200 ? 'fail' : statusFixture.last_update_status,
  last_update_at: statusFixture.last_update_at,
 });
 expect(runtime.view().blocking).toBe(false);
 expect(runtime.notifications()).toEqual([]);
 expect(calls).toEqual(['/api/update', '/api/status']);
});

it('S01 successful refresh waits for current status and invalidates dependent resources once', async () => {
 const readback = deferred<Response>();
 const {runtime, calls} = setup(path => path === '/api/update' ? json({ok: true}) : readback.promise);
 runtime.queryClient.setQueryData(keys.devices, {configured: false});
 runtime.queryClient.setQueryData(keys.failover, {config: {enabled: false}});
 const result = runtime.refreshSubscription();
 await flush();
 expect(runtime.view().blocking).toBe(true);
 expect(runtime.queryClient.getQueryState(keys.devices)?.isInvalidated).toBe(true);
 expect(runtime.queryClient.getQueryState(keys.failover)?.isInvalidated).toBe(true);
 readback.resolve(json({...statusFixture, active_code: 'de'}));
 await expect(result).resolves.toEqual({ok: true});
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code: 'de'});
 expect(runtime.view().blocking).toBe(false);
 expect(calls).toEqual(['/api/update', '/api/status']);
});

it('A03 replacement session discards old refresh readback and error without clearing new activity', async () => {
 const readback = deferred<Response>();
 const {runtime, calls} = setup(path => path === '/api/update'
  ? json({error: 'Old refresh failed'}, 502) : readback.promise);
 const old = runtime.refreshSubscription();
 const assertion = expect(old).rejects.toBeInstanceOf(StaleSessionError);
 await flush();
 runtime.signedOut();
 runtime.queryClient.setQueryData(keys.session, {configured: true, authenticated: true, session_id: 'new'});
 runtime.queryClient.setQueryData(keys.status, {...statusFixture, active_code: 'de'});
 const finish = runtime.beginActivity('probe', 'New session check');
 readback.resolve(json({...statusFixture, last_update_status: 'fail'}));
 await assertion;
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code: 'de', last_update_status: 'ok'});
 expect(runtime.view()).toMatchObject({blocking: true, operation: {kind: 'probe'}});
 expect(runtime.notifications()).toEqual([]);
 expect(calls).toEqual(['/api/update', '/api/status']);
 finish();
});

it('A03 refresh unauthorized response signs out without a private status readback', async () => {
 const {runtime, calls} = setup(() => json({error: 'Unauthorized'}, 401));
 await expect(runtime.refreshSubscription()).rejects.toBeInstanceOf(StaleSessionError);
 expect(calls).toEqual(['/api/update']);
 expect(runtime.authenticated).toBe(false);
 expect(runtime.view().blocking).toBe(false);
});

it('S01 busy refresh follows its durable blocker if status readback fails, without retrying', async () => {
 const id = '11111111-1111-4111-8111-111111111111';
 const {runtime, calls} = setup(path => path === '/api/update'
  ? json({error: 'Router busy', code: 'busy', operation: {id, phase: 'applying', kind: 'main'}}, 409)
  : json({error: 'Status unavailable'}, 503));
 await expect(runtime.refreshSubscription()).rejects.toMatchObject({code: 'busy'});
 expect(runtime.view()).toMatchObject({blocking: true, operation: {id, phase: 'applying'}});
 expect(calls).toEqual(['/api/update', '/api/status']);
 expect(runtime.notifications()).toEqual([]);
});
