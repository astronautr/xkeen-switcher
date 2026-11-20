import {it,expect} from '@rstest/core';
import {onlineManager} from '@tanstack/react-query';
import {ApiClient,ApiError,StaleSessionError} from '../api/client';
import {BrowserStorage} from '../browser/storage';
import {SessionRuntime} from './runtime';
import {keys} from '../api/keys';
import statusFixture from '../../tests/fixtures/status.json';
import previewFixture from '../../tests/fixtures/routing-preview.json';
import type {StatusDto,MainIntent,RoutingPreview,EventDto} from '../api/types';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const intent:MainIntent={id,code:'de',entry_code:'se',mode:'chain',created_at:'2026-11-17T00:00:00Z'};
function store(){const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};}
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise};}
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const status=()=>structuredClone(statusFixture) as StatusDto;
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(handler:(path:string,init?:RequestInit)=>Promise<Response>|Response,storage=new BrowserStorage(store(),store())){
 const calls:{path:string;body:unknown;method:string}[]=[];
 const api=new ApiClient(async(input,init)=>{const path=String(input);calls.push({path,body:init?.body?JSON.parse(String(init.body)):null,method:init?.method??'GET'});return handler(path,init);});
 const runtime=new SessionRuntime({api,storage,newId:()=>id});runtime.queryClient.setQueryData(keys.session,{configured:true,authenticated:true,session_id:'session'});runtime.queryClient.setQueryData(keys.status,status());return {runtime,calls,storage,api};
}
it('M02 held POST does not prevent journal confirmation or next switch; late acceptance cannot regress',async()=>{
 const held=deferred<Response>();const {runtime,calls}=fixture((path,init)=>path==='/api/switch'?held.promise:path==='/api/status'?json({...status(),active_code:'de',active_entry_code:'se'}):json({id,kind:'main',phase:'committed'}));
 runtime.main.switchTo({code:'de',entry_code:'se'});expect(runtime.view().requested).toMatchObject({code:'de',entry_code:'se'});expect(runtime.view().blocking).toBe(true);
 await runtime.pollOperations();expect(runtime.view().blocking).toBe(false);expect(runtime.storage.readMainIntent()).toBeNull();
 held.resolve(json({operation:{id,phase:'accepted'}}));await flush();expect(runtime.queryClient.getQueryData(keys.operation(id))).toMatchObject({phase:'committed'});expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);
});
it.each(["validating", "unknown", "recovery_failed"])(
 "M02 a late Main acceptance preserves journal phase %s and follows recovery",
 async (originalPhase) => {
  const held = deferred<Response>();
  let phase = originalPhase;
  const { runtime } = fixture((path) =>
   path === "/api/switch" ? held.promise : json({ id, kind: "main", phase }),
  );
  runtime.main.switchTo({ code: "de", entry_code: null });
  await runtime.pollOperations();
  expect(runtime.view().operation?.phase).toBe(originalPhase);
  held.resolve(json({ operation: { id, kind: "main", phase: "accepted" } }, 202));
  await flush();
  expect(runtime.pendingMutations()).toBe(0);
  expect(runtime.view().operation?.phase).toBe(originalPhase);

  phase = "verifying";
  await runtime.pollOperations();
  expect(runtime.view().operation?.phase).toBe("verifying");
 },
);
it.each(["validating", "unknown", "recovery_failed"])(
 "M02 a late ambiguous Main failure preserves journal phase %s and keeps the same request",
 async (originalPhase) => {
  const held = deferred<Response>();
  let phase = originalPhase;
  const journal = { id, kind: "main", phase, message: "Journal reports " + originalPhase, block_reason: "Router recovery" };
  const { runtime, calls, storage } = fixture((path) =>
   path === "/api/switch" ? held.promise : json({ ...journal, phase }),
  );
  runtime.main.switchTo({ code: "de", entry_code: null });
  await runtime.pollOperations();
  expect(runtime.view().operation).toMatchObject({ phase: originalPhase, message: journal.message });
  held.resolve(new Response("bad gateway", { status: 502 }));
  await flush();
  expect(runtime.pendingMutations()).toBe(0);
  expect(runtime.view().operation).toMatchObject({ phase: originalPhase, message: journal.message, block_reason: "Router recovery" });
  expect(runtime.view().blocking).toBe(true);
  expect(storage.readMainIntent()?.id).toBe(id);
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

  phase = "verifying";
  await runtime.pollOperations();
  expect(runtime.view().operation?.phase).toBe("verifying");
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
 },
);
it("M02 an ambiguous Main failure without a journal stays unknown and retries the same UUID after 404", async () => {
 let journal: Response | null = null;
 let posts = 0;
 const { runtime, calls } = fixture((path) => {
  if (path === "/api/switch") {
   posts++;
   return posts === 1 ? new Response("bad gateway", { status: 502 }) : json({ operation: { id, kind: "main", phase: "accepted" } }, 202);
  }
  return journal ?? json({ error: "missing" }, 404);
 });
 runtime.main.switchTo({ code: "de", entry_code: null });
 await flush();
 expect(runtime.view().operation).toMatchObject({ id, phase: "unknown" });
 expect(runtime.view().blocking).toBe(true);
 await runtime.pollOperations();
 await flush();
 const sent = calls.filter((c) => c.method === "POST").map((c) => c.body);
 expect(sent).toEqual([{ code: "de", operation_id: id }, { code: "de", operation_id: id }]);
 expect(runtime.view().operation?.phase).toBe("accepted");
 journal = json({ id, kind: "main", phase: "committed" });
 await runtime.pollOperations();
 expect(runtime.view().blocking).toBe(false);
});
it('M03 restores Main and replays the identical chain only after matching 404',async()=>{
 const storage=new BrowserStorage(store(),store());storage.saveMainIntent(intent);const {runtime,calls}=fixture((path)=>path==='/api/switch'?json({operation:{id,phase:'accepted'}},202):json({error:'missing'},404),storage);
 runtime.restoreTracking();await runtime.pollOperations();await flush();expect(calls.find(c=>c.method==='POST')?.body).toEqual({operation_id:id,code:'de',entry_code:'se'});expect(runtime.view().operation?.phase).toBe('accepted');
});
it.each([500,502])('M03 journal HTTP %s never resends',async code=>{
 const storage=new BrowserStorage(store(),store());storage.saveMainIntent(intent);const {runtime,calls}=fixture(()=>json({error:'down'},code),storage);runtime.restoreTracking();await runtime.pollOperations();expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(runtime.view().blocking).toBe(true);
});
it.each([other,'server-activity'])('M04 persisted conflict %s prevents Main 404 replay',async conflicting_id=>{
 const storage=new BrowserStorage(store(),store());storage.saveMainIntent({...intent,conflicting_id});const {runtime,calls}=fixture(path=>path==='/api/status'?json(status()):json({error:'missing'},404),storage);runtime.restoreTracking();await runtime.pollOperations();await flush();expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(storage.readMainIntent()).toBeNull();
});
it('M04 busy clears intent and follows the blocker without a queue',async()=>{
 const {runtime,calls}=fixture(path=>path==='/api/switch'?json({error:'busy',code:'busy',operation:{id:other,phase:'applying'}},409):json(status()));runtime.main.switchTo({code:'de',entry_code:null});await flush();expect(runtime.view().operation?.id).toBe(other);expect(runtime.storage.readMainIntent()).toBeNull();expect(runtime.view().refusal?.kind).toBe('busy');await runtime.refreshStatus();expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);
});
it('M05 sibling intent is followed without claiming result ownership or sending POST',async()=>{
 const local=store();const first=new BrowserStorage(local,store()),second=new BrowserStorage(local,store());first.saveMainIntent(intent);first.markOwn(id);const {runtime,calls}=fixture(()=>json({id,phase:'committed'}),second);runtime.main.switchTo({code:'fi',entry_code:null});expect(runtime.view().local).toBe(false);await runtime.pollOperations();expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);expect(runtime.notifications()).toEqual([]);
});
it('O01 terminal is monotonic per ID and cannot replace a different active blocker',()=>{
 const {runtime}=fixture(()=>json({}));runtime.observe({id,phase:'committed'});runtime.observe({id,phase:'applying'});expect(runtime.view().operation?.phase).toBe('committed');runtime.observe({id:other,phase:'recovery_failed'});runtime.observe({id,phase:'committed'});expect(runtime.view().operation?.id).toBe(other);expect(runtime.view().unresolved).toBe(true);
});
it('O02 ephemeral polls status, never a null journal, and clears when idle',async()=>{
 const {runtime,calls}=fixture(()=>json(status()));runtime.observe({id:null,ephemeral:true,phase:'preparing',kind:'read'});await runtime.pollOperations();expect(calls.map(c=>c.path)).toEqual(['/api/status']);expect(runtime.view().blocking).toBe(false);
});
it.each(["read", "sync", "probe", "route_check", "failover_check", "update"])(
 "O02 observing %s and returning to idle never publishes a notification",
 async kind => {
  const { runtime } = fixture(() => json(status()));
  const shown: string[] = [];
  const unsubscribe = runtime.subscribePublished(item => shown.push(item.message));
  runtime.observe({ id: null, kind, ephemeral: true, phase: "preparing", blocking: true });
  await runtime.pollOperations();
  expect(runtime.view().blocking).toBe(false);
  expect(runtime.notifications()).toEqual([]);
  expect(shown).toEqual([]);
  unsubscribe();
 });
it('O02 own ephemeral request is not conflict; unrelated activity persists sentinel',()=>{
 const {runtime}=fixture(()=>new Promise(()=>{}));runtime.main.switchTo({code:'de',entry_code:null});runtime.observe({id:null,ephemeral:true,phase:'preparing',request_id:id});expect(runtime.storage.readMainIntent()?.conflicting_id).toBeUndefined();runtime.observe({id:null,ephemeral:true,phase:'preparing',kind:'read'});expect(runtime.storage.readMainIntent()?.conflicting_id).toBe('server-activity');
});
it('Routing missing journal offers explicit retry of same preview+UUID and never automatic POST',async()=>{
 const storage=new BrowserStorage(store(),store());storage.saveRoutingPending({operation_id:id,preview_id:other});const {runtime,calls}=fixture(path=>path==='/api/routing/apply'?json({id,phase:'accepted'},202):json({error:'missing'},404),storage);runtime.restoreTracking();await runtime.pollOperations();expect(runtime.routing.canRetry()).toBe(true);expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);await runtime.routing.retry();expect(calls.find(c=>c.method==='POST')?.body).toEqual({operation_id:id,preview_id:other});expect(storage.ownIds()).toEqual([]);
});
it('Devices ambiguous synchronous writes reconcile inventory and never retry mutations',async()=>{
 const {runtime,calls}=fixture(path=>path==='/api/devices/change'?json({error:'lost'},502):json({configured:false,devices:[],policies:[],operations:[],error:'disabled'}));
 await expect(runtime.deviceMutation('/api/devices/change',{operation_id:id,changes:[]})).rejects.toMatchObject({acceptanceUnknown:true});expect(calls.map(c=>c.path)).toEqual(['/api/devices/change','/api/devices']);expect(runtime.queryClient.getQueryData(keys.devices)).toMatchObject({configured:false});
});
it('O04 latest status failure retains successful snapshot and its age',async()=>{
 let fail=false;const {runtime}=fixture(()=>fail?json({error:'down'},502):json(status()));await runtime.refreshStatus();const at=runtime.queryClient.getQueryState(keys.status)?.dataUpdatedAt;fail=true;await runtime.refreshStatus();expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code:'fi'});expect(runtime.queryClient.getQueryState(keys.status)?.dataUpdatedAt).toBe(at);expect(runtime.queryClient.getQueryState(keys.status)?.status).toBe('error');
});
it('O05 Query offline manager never pauses LAN reads or creates reconnect mutations',async()=>{
 onlineManager.setOnline(false);try{const {runtime,calls}=fixture(path=>path==='/api/status'?json(status()):json({ok:true}));await runtime.refreshStatus();await runtime.mutate('/api/update',{});expect(calls).toHaveLength(2);expect(runtime.queryClient.isMutating()).toBe(0);}finally{onlineManager.setOnline(true);}
});
it('A03 logout epoch isolates deferred mutation finally and private cache callbacks',async()=>{
 const held=deferred<Response>();const {runtime,api}=fixture(()=>held.promise);const result=runtime.mutate('/api/update',{});expect(runtime.pendingMutations()).toBe(1);runtime.signedOut();const epoch=api.epoch;held.resolve(json({ok:true,event_ids:['old']}));await expect(result).rejects.toBeInstanceOf(Error);expect(api.epoch).toBe(epoch);expect(runtime.pendingMutations()).toBe(0);expect(runtime.queryClient.getQueryData(keys.status)).toBeUndefined();expect(runtime.notifications()).toEqual([]);
});
it('event drain waits for every concurrent response then suppresses exact IDs only',async()=>{
 const a=deferred<Response>(),b=deferred<Response>();const {runtime}=fixture(path=>path==='/a'?a.promise:b.promise);runtime.acceptEvents([]);const pa=runtime.mutate('/a',{}),pb=runtime.mutate('/b',{});
 runtime.acceptEvents([{event_id:'own-a',ts:'t',action:'update',result:'ok'},{event_id:'own-b',ts:'t',action:'update',result:'ok'},{event_id:'foreign',ts:'t',action:'update',result:'ok'}]);a.resolve(json({event_ids:['own-a']}));await pa;expect(runtime.eventAnnouncements()).toEqual([]);b.resolve(json({event_ids:['own-b']}));await pb;expect(runtime.eventAnnouncements().map(e=>e.event_id)).toEqual(['foreign']);
});
it('mismatched journal ID never changes the active operation or claims a result',async()=>{
 const storage=new BrowserStorage(store(),store());storage.saveMainIntent(intent);const {runtime}=fixture(()=>json({id:other,phase:'committed'}),storage);runtime.restoreTracking();await runtime.pollOperations();expect(runtime.view().operation?.id).toBe(id);expect(runtime.view().blocking).toBe(true);expect(runtime.queryClient.getQueryData(keys.operation(other))).toBeUndefined();
});
it('Main persistence exists before the POST is handed to fetch',async()=>{
 const storage=new BrowserStorage(store(),store());let saved:MainIntent|null=null;const {runtime}=fixture(()=>{saved=storage.readMainIntent();return json({operation:{id,phase:'accepted'}});},storage);runtime.main.switchTo({code:'de',entry_code:null});expect(saved).toMatchObject({id,code:'de',entry_code:null});await flush();
});
it('a committed hung POST does not prevent a fresh UUID and next route request',async()=>{
 const first=deferred<Response>();let posts=0;const rt=new SessionRuntime({storage:new BrowserStorage(store(),store()),newId:()=>posts===0?id:other,api:new ApiClient(async(path)=>{if(path==='/api/switch'){posts++;return posts===1?first.promise:json({operation:{id:other,phase:'accepted'}});}if(path==='/api/status')return json({...status(),active_code:'de'});return json({id,phase:'committed'});})});rt.queryClient.setQueryData(keys.session,{authenticated:true});rt.queryClient.setQueryData(keys.status,status());rt.main.switchTo({code:'de',entry_code:null});await rt.pollOperations();rt.main.switchTo({code:'se',entry_code:null});expect(posts).toBe(2);expect(rt.view().requested?.id).toBe(other);first.resolve(json({operation:{id,phase:'accepted'}}));await flush();expect(rt.view().operation?.id).toBe(other);
});
it('synchronous local activity blocks Main immediately and releases after its response',async()=>{
 const held=deferred<Response>();const {runtime,calls}=fixture(()=>held.promise);const pending=runtime.mutate('/api/update',{});expect(runtime.view().blocking).toBe(true);expect(runtime.view().activity.label).toBe('Refreshing subscription');runtime.main.switchTo({code:'de',entry_code:null});expect(calls).toHaveLength(1);held.resolve(json({ok:true}));await pending;expect(runtime.view().blocking).toBe(false);
});
it('a successful setting mutation refreshes status for disabled shared subscriptions',async()=>{
 const {runtime,calls}=fixture(path=>path==='/api/status'?json({...status(),active_code:'de'}):json({ok:true}));await runtime.mutate('/api/auto-update',{},'PUT',[keys.status]);await flush();expect(calls.map(c=>c.path)).toEqual(['/api/auto-update','/api/status']);expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code:'de'});
});
it('O04 canceled old transport finishing after a newer status cannot replace it',async()=>{
 const old=deferred<Response>();let calls=0;const {runtime}=fixture(()=>++calls===1?old.promise:json({...status(),active_code:'de'}));const first=runtime.refreshStatus();await flush();await runtime.queryClient.cancelQueries({queryKey:keys.status});await runtime.refreshStatus();old.resolve(json(status()));await first;await flush();expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code:'de'});
});
it('O02 an invalid or null journal identifier is rejected before fetch',async()=>{
 const {runtime,calls}=fixture(()=>json({}));await expect(runtime.readOperation(null as unknown as string)).rejects.toMatchObject({code:'invalid_request'});expect(calls).toEqual([]);
});
it('A02 late invitation creation response cannot replace the newer invitation',async()=>{
 const first=deferred<Response>();let count=0;const {runtime}=fixture(()=>++count===1?first.promise:json({id:'new',status:'pending',code:'222222',expires_at:200}));const old=runtime.createPairingCode();expect(await runtime.createPairingCode()).toMatchObject({id:'new'});first.resolve(json({id:'old',status:'pending',code:'111111',expires_at:100}));await expect(old).rejects.toMatchObject({name:'StaleSessionError'});
});

it.each([200, 502])('Devices readback HTTP %s cannot expose an old error after replacement login', async code => {
 const inventory = deferred<Response>();
 const {runtime, calls} = fixture(path => {
  if (path === '/api/devices/change') return json({error: 'lost write response'}, 502);
  if (path === '/api/devices') return inventory.promise;
  if (path === '/api/auth/session') return json({configured: true, authenticated: true, session_id: 'replacement'});
  if (path === '/api/status') return json(status());
  return json({ok: true});
 });
 const result = runtime.deviceMutation('/api/devices/change', {operation_id: id, changes: []}).catch(error => error);
 await flush();
 expect(calls.map(call => call.path)).toEqual(['/api/devices/change', '/api/devices']);
 await runtime.logout();
 await runtime.authenticate('login', {password: 'synthetic'});
 inventory.resolve(json(code === 200 ? {configured: false, devices: [], policies: [], operations: [], error: 'disabled'} : {error: 'read failed'}, code));
 expect(await result).toBeInstanceOf(StaleSessionError);
 expect(runtime.queryClient.getQueryData(keys.session)).toMatchObject({session_id: 'replacement'});
 expect(runtime.queryClient.getQueryData(keys.devices)).toBeUndefined();
 expect(runtime.notifications()).toEqual([]);
});

it.each([false, true])('Main stays blocking across ephemeral then idle until journal confirmation (foreign holder %s)', async foreign => {
 const post = deferred<Response>();
 const journal = deferred<Response>();
 let current = {...status(), operation: {id: null, ephemeral: true, phase: 'preparing', request_id: id}} as StatusDto;
 const {runtime, calls} = fixture(path => {
  if (path === '/api/switch') return post.promise;
  if (path === '/api/status') return json(current);
  if (path === '/api/routing/operations/' + id) return journal.promise;
  return json({error: 'unexpected request'}, 500);
 });
 runtime.main.switchTo({code: 'de', entry_code: null});
 if (foreign) runtime.observe({id: other, phase: 'applying'});
 await runtime.refreshStatus();
 expect(runtime.view()).toMatchObject({blocking: true, ephemeral: true});
 expect(runtime.storage.readMainIntent()?.conflicting_id).toBe(foreign ? other : undefined);
 if (foreign) runtime.observe({id: other, phase: 'committed'});
 current = {...current, operation: null};
 await runtime.refreshStatus();
 expect(runtime.view()).toMatchObject({blocking: true, durable: true, requested: {id}, operation: {id}});
 const reading = runtime.pollOperations();
 // The HTTP-verified JSON fixture's heterogeneous rules infer optional undefined
 // properties in TypeScript; those properties are absent from the wire data.
 const preview = structuredClone(previewFixture) as unknown as RoutingPreview;
 await expect(runtime.routing.apply(preview)).rejects.toMatchObject({code: 'busy'});
 expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/switch']);
 journal.resolve(json({id, kind: 'main', phase: 'committed'}));
 await reading;
 expect(runtime.view().blocking).toBe(false);
 expect(runtime.storage.readMainIntent()).toBeNull();
 post.resolve(json({operation: {id, phase: 'accepted'}}, 202));
 await flush();
 expect(runtime.view().blocking).toBe(false);
});

it.each([null, 'de'])('Restored subscription clears lost-route attention only when all route nodes return (entry %s)', async entry => {
 const lost: EventDto = {event_id: 'lost', ts: '1', action: 'update', result: 'ok', message: 'active fi vanished from subscription'};
 const unrelated: EventDto = {event_id: 'routing-failure', ts: '2', action: 'routing-apply', result: 'fail'};
 const refreshed: EventDto = {event_id: 'refreshed', ts: '3', action: 'update', result: 'ok'};
 const allLocations = status().available;
 const missing = entry ?? 'fi';
 let current = {...status(), active_entry_code: entry, active_status: 'stale', available: allLocations.filter(location => location.code !== missing), events: [lost, unrelated, refreshed]};
 const {runtime} = fixture(() => json(current));
 await runtime.refreshStatus();
 expect(runtime.attention().route).toEqual(lost);
 current = {...current, available: allLocations};
 await runtime.refreshStatus();
 expect(runtime.attention().route).toEqual(lost);
 current = {...current, active_status: 'ok', available: allLocations.filter(location => location.code !== missing)};
 await runtime.refreshStatus();
 expect(runtime.attention().route).toEqual(lost);
 current = {...current, available: allLocations};
 await runtime.refreshStatus();
 expect(runtime.attention().route).toBeUndefined();
 expect(runtime.attention().routing).toEqual(unrelated);
});

it('Pending Routing also remains blocking when a foreign holder finishes beneath ephemeral status', async () => {
 const storage = new BrowserStorage(store(), store());
 storage.saveRoutingPending({operation_id: id, preview_id: other});
 let current = {...status(), operation: {id: null, ephemeral: true, phase: 'preparing'}} as StatusDto;
 const {runtime, calls} = fixture(path => path === '/api/status' ? json(current) : json({id, kind: 'routing', phase: 'committed'}), storage);
 runtime.restoreTracking();
 runtime.observe({id: other, phase: 'applying'});
 await runtime.refreshStatus();
 runtime.observe({id: other, phase: 'committed'});
 current = {...current, operation: null};
 await runtime.refreshStatus();
 expect(runtime.view()).toMatchObject({blocking: true, operation: {id}});
 const preview = structuredClone(previewFixture) as unknown as RoutingPreview;
 await expect(runtime.routing.apply(preview)).rejects.toMatchObject({code: 'busy'});
 expect(calls.filter(call => call.method === 'POST')).toEqual([]);
 await runtime.pollOperations();
 expect(runtime.view().blocking).toBe(false);
 expect(storage.readRoutingPending()).toBeNull();
});

it('Healthy status does not clear other route failures or a vanished route with no active exit', async () => {
 const lost: EventDto = {event_id: 'lost', ts: '1', action: 'update', result: 'ok', message: 'active fi vanished from subscription'};
 let current = {...status(), active_code: null, events: [lost]} as StatusDto;
 const {runtime} = fixture(() => json(current));
 await runtime.refreshStatus();
 expect(runtime.attention().route).toEqual(lost);
 const failed: EventDto = {event_id: 'failed', ts: '2', action: 'switch', result: 'fail'};
 current = {...status(), events: [failed]};
 await runtime.refreshStatus();
 expect(runtime.attention().route).toEqual(failed);
});

it('D03 records a device change Undo action in persisted notifications', () => {
 const {runtime, storage} = fixture(() => json({}));
 runtime.notify('Printer renamed', false, {device_operation: id});
 const reloaded = new BrowserStorage(storage.local, store());
 expect(reloaded.notifications()).toMatchObject([{message: 'Printer renamed', device_operation: id}]);
});

it.each([
 {request: {}, noop: false, expectedUndo: true, message: 'Device location applied'},
 {request: {}, noop: true, expectedUndo: false, message: 'Device location applied'},
 {request: {undo: true}, noop: false, expectedUndo: false, message: 'Device location change undone'},
])('D05 persists one result for a confirmed device exit, Undo=$expectedUndo', ({request, noop, expectedUndo, message}) => {
 const {runtime, storage} = fixture(() => json({}));
 runtime.markOwn(id);
 const operation = {id, phase: 'committed', kind: 'device-location', device_request: request, noop};
 runtime.observe(operation);
 runtime.observe(operation);
 const [result, ...duplicates] = new BrowserStorage(storage.local, store()).notifications();
 expect(result?.message).toBe(message);
 expect(result?.device_operation).toBe(expectedUndo ? id : undefined);
 expect(duplicates).toHaveLength(0);
});

it('D05 Undo follows the new device location journal returned by the server', async () => {
 const {runtime} = fixture(path => path === '/api/devices/undo'
  ? json({operation: {id: other, kind: 'device-location', phase: 'accepted', device_request: {undo: id}}})
  : json(status()));
 const response = await runtime.undoDeviceChange(id);
 expect(response).toMatchObject({operation: {id: other}});
 expect(runtime.view()).toMatchObject({local: true, blocking: true, operation: {id: other}});
 expect(runtime.storage.ownIds()).toContain(other);
});

it('D05 keeps following Undo when status reports another holder', async () => {
 const foreign = '33333333-3333-4333-8333-333333333333';
 const undo = {id: other, kind: 'device-location', device_request: {undo: id}};
 const {runtime, calls} = fixture(path => {
  if (path === '/api/devices/undo') return json({operation: {...undo, phase: 'accepted'}});
  if (path.endsWith(other)) return json({...undo, phase: 'committed'});
  if (path.endsWith(foreign)) return json({id: foreign, kind: 'routing', phase: 'applying'});
  return json(status());
 });
 await runtime.undoDeviceChange(id);
 runtime.observe({id: foreign, kind: 'routing', phase: 'applying'});
 await runtime.pollOperations();
 expect(calls.filter(call => call.path.endsWith(other))).toHaveLength(1);
 expect(runtime.notifications()).toMatchObject([{message: 'Device location change undone'}]);
 expect(runtime.view().operation?.id).toBe(foreign);
});

it('D05 resolves a late Undo acknowledgement against an already observed terminal journal', async () => {
 const held = deferred<Response>();
 const undo = {id: other, kind: 'device-location', device_request: {undo: id}};
 const {runtime} = fixture(path => path === '/api/devices/undo' ? held.promise : json(status()));
 const request = runtime.undoDeviceChange(id);
 runtime.observe({...undo, phase: 'committed'});
 expect(runtime.notifications()).toHaveLength(0);
 held.resolve(json({operation: {...undo, phase: 'accepted'}}));
 const response = await request;
 expect(response).toMatchObject({operation: {phase: 'committed'}});
 expect(runtime.notifications()).toMatchObject([{message: 'Device location change undone'}]);
 expect(runtime.storage.ownIds()).not.toContain(other);
});

it('D05 a failed displaced Undo read leaves the known active holder and both poll targets intact', async () => {
 const foreign = '33333333-3333-4333-8333-333333333333';
 const undo = {id: other, kind: 'device-location', device_request: {undo: id}};
 const missed = deferred<Response>();
 let attempts = 0;
 const holder = {id: foreign, kind: 'routing', phase: 'applying'};
 const {runtime, calls} = fixture(path => {
  if (path === '/api/devices/undo') return json({operation: {...undo, phase: 'accepted'}});
  if (path.endsWith(other)) return ++attempts === 1 ? missed.promise : json({...undo, phase: 'committed'});
  return json(path.endsWith(foreign) ? holder : {...status(), operation: holder});
 });
 await runtime.undoDeviceChange(id);
 runtime.observe(holder);
 const poll = runtime.pollOperations();
 await flush();
 missed.resolve(json({error: 'Lost response'}, 503));
 await poll;
 expect(runtime.view().operation?.id).toBe(foreign);
 await runtime.pollOperations();
 expect(calls.filter(call => call.path.endsWith(foreign))).toHaveLength(2);
 expect(calls.filter(call => call.path.endsWith(other))).toHaveLength(2);
 expect(runtime.notifications()).toMatchObject([{message: 'Device location change undone'}]);
});

it.each(['post','journal'])('M02 terminal %s starts fresh status before an older poll replies', async source => {
 const old = deferred<Response>(), post = deferred<Response>();
 const committed = {id, kind:'main', phase:'committed', target_name:'Germany'};
 let reads = 0;
 const {runtime,calls} = fixture(path => {
  if (path === '/api/status') return ++reads === 1 ? old.promise : json({...status(), active_code:'de'});
  return path === '/api/switch' ? post.promise : json(committed);
 });
 const initial = runtime.refreshStatus('poll');
 runtime.main.switchTo({code:'de',entry_code:null});
 if (source === 'post') post.resolve(json({operation:committed}));
 else void runtime.pollOperations();
 await flush();
 expect(reads).toBe(2);
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code:'de'});
 old.resolve(json(status()));
 await initial;
 post.resolve(json({operation:{id,kind:'main',phase:'accepted'}}));
 await flush();
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code:'de'});
 expect(runtime.notifications()).toMatchObject([{message:'Main switched to Germany'}]);
 expect(calls.filter(call => call.method==='POST')).toHaveLength(1);
});

it('H01 rotated attention persists until domain recovery and is cleared with its session', async () => {
 const {runtime} = fixture(() => json(status()));
 const failure:EventDto = {event_id:'failed',ts:'1',action:'routing-apply',result:'fail'};
 const unrelated:EventDto = {event_id:'sync',ts:'2',action:'update',result:'ok'};
 runtime.acceptEvents([failure]);
 runtime.acceptEvents([unrelated]);
 runtime.acceptEvents([]);
 expect(runtime.attention().routing).toEqual(failure);
 runtime.acceptEvents([{event_id:'restored',ts:'3',action:'routing-restore',result:'ok'}]);
 expect(runtime.attention()).toEqual({});
 runtime.acceptEvents([{...failure,event_id:'later',ts:'4'}]);
 expect(runtime.attention().routing?.event_id).toBe('later');
 runtime.signedOut();
 expect(runtime.attention()).toEqual({});
});

it('a newer terminal read takes over pending mutation reconciliation without releasing it early', async () => {
 const pending = deferred<Response>(), fresh = deferred<Response>();
 let reads = 0;
 const {runtime} = fixture(path => path === '/api/update' ? json({ok:true})
  : ++reads === 1 ? pending.promise : fresh.promise);
 let settled = false;
 const update = runtime.refreshSubscription().then(() => { settled = true; });
 await flush();
 const terminal = runtime.observe({id,kind:'main',phase:'committed'}, 'response');
 await flush();
 expect(reads).toBe(2);
 pending.resolve(json(status()));
 await flush();
 expect(settled).toBe(false);
 await runtime.refreshStatus('poll');
 expect(reads).toBe(2);
 fresh.resolve(json({...status(),active_code:'de'}));
 await Promise.all([terminal, update]);
 expect(settled).toBe(true);
 expect(runtime.queryClient.getQueryData(keys.status)).toMatchObject({active_code:'de'});
});

it('Read attention stays hidden across runtimes until a different failure arrives', () => {
 const local=store(),session=store();
 const failure:EventDto={event_id:'update-failed',ts:'2026-11-17T09:00:00Z',action:'update',trigger:'cron',result:'fail',message:'Timed out'};
 const first=fixture(()=>json({}),new BrowserStorage(local,session)).runtime;
 first.acceptEvents([failure]);
 expect(Object.keys(first.attention())).toEqual(['update']);
 first.acknowledgeAttention();
 expect(first.attention()).toEqual({});
 const second=fixture(()=>json({}),new BrowserStorage(local,session)).runtime;
 second.acceptEvents([failure]);
 expect(second.attention()).toEqual({});
 second.acceptEvents([failure,{...failure,event_id:'update-failed-again'}]);
 expect(second.attention().update?.event_id).toBe('update-failed-again');
});

it('Own operation and response event IDs persist for the activity feed', async () => {
 const {runtime,api}=fixture(()=>json({}));
 runtime.markOwn(other);
 api.onEventIds?.(['response-event']);
 expect(runtime.ownEvents()).toEqual([other,'response-event']);
 api.onEventIds?.(['response-event']);
 expect(runtime.ownEvents()).toEqual([other,'response-event']);
});
it('sends the exact visible Single selection and reports completion by step', async () => {
 const active = {kind:'single',id,exit_code:null,exit_name:null,state:'running',done:0,total:2,working:0,created_at:'2026-11-19T10:00:00Z',finished_at:null};
 const view = {kind:'single',active_run:active,run:active,routes:[]};
 const {runtime,calls} = fixture(path => path === '/api/route-checks' ? json(view) :
  json({...status(),route_check_run:{...active,state:'completed',done:2,working:1}}));
 await runtime.startRouteChecks({kind:'single',codes:['fi','ru'],conditions_hash:'hash'});
 expect(calls[0]?.body).toEqual({kind:'single',run_id:id,codes:['fi','ru'],conditions_hash:'hash'});
 expect(runtime.routeCheckActivity()?.message).toBe('0 of 2 routes checked');
 await runtime.refreshStatus();
 expect(runtime.notifications()[0]?.message).toBe('Location checks complete · 1 working');
});
it.each([
 ['cancelled', 'Chain checks stopped · Finland'],
 ['interrupted', 'Chain checks interrupted · Finland'],
 ['completed', 'Chain checks complete · Finland · No working route confirmed'],
])('reports a %s check without counting unavailable probes as failed routes', async (state, expected) => {
 const run = {id,kind:'chain',exit_code:'fi',exit_name:'Finland',state:'running',done:0,total:3,working:0,created_at:'2026-11-19T10:00:00Z',finished_at:null};
 const {runtime} = fixture(path => path === '/api/route-checks' ? json({kind:'chain',exit_code:'fi',active_run:run,run,routes:[]})
  : json({...status(),route_check_run:{...run,state,done:3}}));
 await runtime.startRouteChecks({kind:'chain',exit_code:'fi',entry_codes:['de','se','ru'],conditions_hash:'hash'});
 await runtime.refreshStatus();
 expect(runtime.notifications()[0]?.message).toBe(expected);
});
it('a remote test sites change invalidates cached sites and every route view', async () => {
 const {runtime} = fixture(() => json({...status(),route_check_conditions_hash:'changed-in-another-browser'}));
 const keysToRefresh = [keys.connectivity, keys.routeChecks('single'), keys.routeChecks('chain','fi')];
 for(const key of keysToRefresh)runtime.queryClient.setQueryData(key,{cached:true});
 await runtime.refreshStatus();
 for(const key of keysToRefresh)expect(runtime.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
});
