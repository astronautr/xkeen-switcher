import {expect, it, rstest} from '@rstest/core';
import {ApiClient, ApiError} from '../api/client';
import {keys} from '../api/keys';
import {BrowserStorage} from '../browser/storage';
import {SessionRuntime} from './runtime';
import status from '../../tests/fixtures/status.json';

function memoryStorage() {
 const data = new Map<string, string>();
 return {getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); },
  removeItem: (key: string) => { data.delete(key); }};
}
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return {promise, resolve};
}
function setup(handler: (path: string, init?: RequestInit) => Promise<Response>) {
 const calls: string[] = [];
 const api = new ApiClient((path, init) => { calls.push(String(path)); return handler(String(path), init); });
 const runtime = new SessionRuntime({api, storage: new BrowserStorage(memoryStorage(), memoryStorage())});
 runtime.queryClient.setQueryData(keys.session, {configured: true, authenticated: true, session_id: 'first'});
 return {runtime, calls};
}
const inventory = {configured: false, devices: [], policies: [], operations: [], error: 'disabled'};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});

function startPolling(handleDevices: (path: string) => Promise<Response>) {
 const {runtime, calls} = setup(async path => {
  if (path === '/api/auth/session') return json({configured: true, authenticated: true, session_id: 'current'});
  if (path === '/api/status') return json(status);
  return handleDevices(path);
 });
 runtime.setDevicesPolling(() => true);
 const stop = runtime.start();
 return {runtime, stop, inventoryReads: () => calls.filter(path => path === '/api/devices').length};
}

it.each(['refresh', 'mutation snapshot', 'lost mutation readback'])(
 'periodic Devices reads wait 30 seconds after a successful %s', async source => {
  rstest.useFakeTimers();
  const {runtime, stop, inventoryReads} = startPolling(async path => {
   if (source === 'lost mutation readback' && path === '/api/devices/change') throw new Error('Reply lost');
   return json(inventory);
  });
  try {
   await runtime.bootstrap();
   await rstest.advanceTimersByTimeAsync(9000);
   if (source === 'refresh') await runtime.read(keys.devices, '/api/devices');
   else if (source === 'mutation snapshot') await runtime.deviceMutation('/api/devices/change', {});
   else await expect(runtime.deviceMutation('/api/devices/change', {})).rejects.toThrow('Reply lost');
   const expectedReads = source === 'mutation snapshot' ? 0 : 1;
   await rstest.advanceTimersByTimeAsync(30000);
   expect(inventoryReads()).toBe(expectedReads);
   await rstest.advanceTimersByTimeAsync(1000);
   expect(inventoryReads()).toBe(expectedReads + 1);
  } finally {
   stop();
   rstest.useRealTimers();
  }
 });

it('failed periodic Devices reads throttle further polls only within that session', async () => {
 rstest.useFakeTimers();
 const {runtime, stop, inventoryReads} = startPolling(async () => json({error: 'Temporarily unavailable'}, 503));
 try {
  await runtime.bootstrap();
  await rstest.advanceTimersByTimeAsync(10000);
  expect(inventoryReads()).toBe(1);
  await rstest.advanceTimersByTimeAsync(20000);
  expect(inventoryReads()).toBe(1);
  await rstest.advanceTimersByTimeAsync(10000);
  expect(inventoryReads()).toBe(2);
  runtime.signedOut();
  await runtime.bootstrap();
  await rstest.advanceTimersByTimeAsync(10000);
  expect(inventoryReads()).toBe(3);
 } finally {
  stop();
  rstest.useRealTimers();
 }
});

it('Devices reads hold one deduplicated read activity and release silently without queued Main', async () => {
 const response = deferred<Response>();
 const {runtime, calls} = setup(() => response.promise);
 const first = runtime.read(keys.devices, '/api/devices');
 const second = runtime.read(keys.devices, '/api/devices');
 expect(runtime.view()).toMatchObject({blocking: true, local: false, ephemeral: true,
  operation: {kind: 'read', scope: 'read', message: 'Reading router devices'}});
 expect(runtime.view().activity.delay).toBe(1000);
 expect(runtime.pendingMutations()).toBe(0);
 runtime.main.switchTo({code: 'de', entry_code: null});
 expect(calls).toEqual(['/api/devices']);
 response.resolve(json(inventory));
 await Promise.all([first, second]);
 expect(runtime.view().blocking).toBe(false);
 expect(runtime.notifications()).toEqual([]);
 expect(calls).toEqual(['/api/devices']);
});

it('Devices failed refetch releases read activity while retaining the last inventory', async () => {
 const response = deferred<Response>();
 const {runtime} = setup(() => response.promise);
 runtime.queryClient.setQueryData(keys.devices, inventory);
 const read = runtime.read(keys.devices, '/api/devices');
 expect(runtime.view().blocking).toBe(true);
 response.resolve(json({error: 'temporarily unavailable'}, 503));
 await expect(read).rejects.toBeInstanceOf(ApiError);
 expect(runtime.view().blocking).toBe(false);
 expect(runtime.queryClient.getQueryData(keys.devices)).toEqual(inventory);
 expect(runtime.notifications()).toEqual([]);
});

it('Devices read cancellation clears its activity without clearing a concurrent mutation', async () => {
 const mutation = deferred<Response>();
 const {runtime} = setup((path, init) => path === '/api/devices'
  ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError'))))
  : mutation.promise);
 const read = runtime.read(keys.devices, '/api/devices').catch(() => undefined);
 expect(runtime.view().operation?.kind).toBe('read');
 const update = runtime.mutate('/api/update', {});
 await runtime.queryClient.cancelQueries({queryKey: keys.devices});
 await read;
 expect(runtime.view()).toMatchObject({blocking: true, operation: {kind: 'update'}});
 mutation.resolve(json({ok: true}));
 await update;
 expect(runtime.view().blocking).toBe(false);
 expect(runtime.notifications()).toEqual([]);
});

it('A03 old Devices read cleanup cannot erase replacement-session read activity', async () => {
 const old = deferred<Response>(), current = deferred<Response>();
 let count = 0;
 const {runtime} = setup(() => ++count === 1 ? old.promise : current.promise);
 const first = runtime.read(keys.devices, '/api/devices').catch(() => undefined);
 runtime.signedOut();
 runtime.queryClient.setQueryData(keys.session, {configured: true, authenticated: true, session_id: 'replacement'});
 const second = runtime.read(keys.devices, '/api/devices');
 old.resolve(json(inventory));
 await first;
 expect(runtime.view()).toMatchObject({blocking: true, operation: {kind: 'read'}});
 expect(runtime.queryClient.getQueryData(keys.devices)).toBeUndefined();
 current.resolve(json(inventory));
 await second;
 expect(runtime.view().blocking).toBe(false);
 expect(runtime.notifications()).toEqual([]);
});
