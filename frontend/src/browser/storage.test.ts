import { describe, it, expect } from '@rstest/core';
import { BrowserStorage, newOperationId } from './storage';
export function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {get length() { return data.size; }, clear: () => data.clear(), key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }};
}
const id = '11111111-1111-4111-8111-111111111111';
const newer = '22222222-2222-4222-8222-222222222222';
const intent = {id, code: 'de', entry_code: null, mode: 'single' as const, created_at: '2026-11-17T00:00:00Z'};
describe('B04 browser storage', () => {
 it('normalizes legacy intent while preserving conflict evidence', () => {
  const local = memoryStorage(); local.setItem('xk_switch_request', JSON.stringify({id, code: 'de', conflicting_id: 'server-activity'}));
  expect(new BrowserStorage(local, memoryStorage()).readMainIntent()).toMatchObject({entry_code: null, mode: 'single', conflicting_id: 'server-activity'});
 });
 it('clear compares the current shared ID', () => {
  const local = memoryStorage(); const storage = new BrowserStorage(local, memoryStorage()); storage.saveMainIntent(intent);
  local.setItem('xk_switch_request', JSON.stringify({...intent, id: newer})); storage.clearMainIntent(id);
  expect(storage.readMainIntent()?.id).toBe(newer);
 });
 it('keeps a live intent when storage throws and clears it in memory', () => {
  const denied = new Proxy(memoryStorage(), {get() { return () => { throw new Error('denied'); }; }});
  const storage = new BrowserStorage(denied, denied); storage.saveMainIntent(intent);
  expect(storage.readMainIntent()).toEqual(intent); storage.clearMainIntent(id); expect(storage.readMainIntent()).toBeNull();
 });
 it.each(['{', '[]', '{}', '{"id":"bad","code":"de"}', JSON.stringify({...intent, entry_code:'de'})])('rejects corrupt intent %s', value => {
  const local = memoryStorage(); local.setItem('xk_switch_request', value); expect(new BrowserStorage(local, memoryStorage()).readMainIntent()).toBeNull();
 });
 it('generates an RFC UUID without randomUUID in LAN HTTP', () => {
  expect(newOperationId({getRandomValues: (bytes: Uint8Array) => bytes.fill(255)})).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
 });
 it('logout preserves shared Main and clears only tab protocol state', () => {
  const local=memoryStorage(), session=memoryStorage(); const s=new BrowserStorage(local,session); s.saveMainIntent(intent); s.markOwn(id);
  s.saveRoutingPending({operation_id:id,preview_id:newer}); s.resetSession();
  expect(s.readMainIntent()?.id).toBe(id); expect(s.ownIds()).toEqual([]); expect(s.readRoutingPending()).toBeNull();
 });
});
it('shared completion deletion is observed without resurrecting successful memory writes',()=>{
 const local=memoryStorage(),a=new BrowserStorage(local,memoryStorage()),b=new BrowserStorage(local,memoryStorage());a.saveMainIntent(intent);b.clearMainIntent(id);expect(a.readMainIntent()).toBeNull();
});
it('failed removal does not resurrect a completed matching intent',()=>{
 const local=memoryStorage(),s=new BrowserStorage({...local,removeItem:()=>{throw new Error('denied');}},memoryStorage());s.saveMainIntent(intent);s.clearMainIntent(id);expect(s.readMainIntent()).toBeNull();
});
it('Routing pending survives denied writes and cannot resurrect after denied removal',()=>{
 const session=memoryStorage();let denied=false;const broken={...session,setItem:(k:string,v:string)=>{if(denied)throw Error('denied');session.setItem(k,v);},removeItem:()=>{throw Error('denied');}};const s=new BrowserStorage(memoryStorage(),broken);s.saveRoutingPending({preview_id:id,operation_id:newer});s.clearRoutingPending(newer);expect(s.readRoutingPending()).toBeNull();denied=true;s.saveRoutingPending({preview_id:newer,operation_id:id});expect(s.readRoutingPending()).toEqual({preview_id:newer,operation_id:id});
});
it.each(['{','{}','[]','{"preview_id":"bad","operation_id":"bad"}'])('Routing pending rejects corrupt value %s',raw=>{
 const session=memoryStorage();session.setItem('xk_routing_operation',raw);expect(new BrowserStorage(memoryStorage(),session).readRoutingPending()).toBeNull();
});
it('Routing scratch and inbox retain safe live data with denied storage',()=>{
 const denied={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');},removeItem:()=>{throw Error('denied');}};const s=new BrowserStorage(denied,denied);const scratch={version:1 as const,base:'hash',revision:null,form:{rule:{id},initial:{title:'old'},original:{title:'old'},entries:[]}};s.saveScratch(scratch);expect(s.readScratch()).toEqual(scratch);s.saveScratch(null);expect(s.readScratch()).toBeNull();s.saveNotifications([{message:'done',at:'2026-11-17T00:00:00Z',error:false}]);expect(s.notifications()).toHaveLength(1);
});
it('public Main persistence adapters share the provider memory fallback',async()=>{
 const {bindBrowserStorage,readMainIntent}=await import('./storage');const denied={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');},removeItem:()=>{throw Error('denied');}};const storage=new BrowserStorage(denied,denied);const unbind=bindBrowserStorage(storage);try{storage.saveMainIntent(intent);expect(readMainIntent()).toEqual(intent);}finally{unbind();}
});
it('keeps route finder selections separate, filters removed codes and remembers a missing exit', () => {
 const local = memoryStorage(), storage = new BrowserStorage(local, memoryStorage());
 storage.saveRouteFinder({step:'chain', exit:'lv', single:'chosen', chain:'chosen', codes:['fi','lv'], entryCodes:['fi','ru']});
 expect(new BrowserStorage(local, memoryStorage()).readRouteFinder(['fi','ru'])).toEqual({
  step:'chain', exit:'lv', single:'chosen', chain:'chosen', codes:['fi'], entryCodes:['fi','ru'],
 });
});
