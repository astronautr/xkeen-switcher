import { isRecord, validId, type MainIntent, type RoutingPending } from '../api/types';
export const STORAGE_KEYS = { main:'xk_switch_request', own:'xk_own_operations', routing:'xk_routing_operation', scratch:'xk_routing_form_v1', events:'xk_event_cursor', notifications:'xk_notifications', attentionRead:'xk_attention_read', ownEvents:'xk_own_events', theme:'xk_theme', dismissedRouterUpdates:'xk_dismissed_router_updates', routeFinder:'xk_route_finder', devicesExpanded:'xk_devices_expanded' } as const;
export type StorageLike = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function browserStore(kind:'localStorage'|'sessionStorage'):StorageLike {
 return {getItem:key=>globalThis[kind].getItem(key),setItem:(key,value)=>globalThis[kind].setItem(key,value),removeItem:key=>globalThis[kind].removeItem(key)};
}
export function parseStored(raw:string|null):unknown { try {return raw===null ? null : JSON.parse(raw);} catch {return null;} }
export function mainIntent(value:unknown):MainIntent|null {
 if (!isRecord(value) || !validId(value.id) || typeof value.code!=='string' || !value.code || !(value.entry_code==null || typeof value.entry_code==='string' && !!value.entry_code && value.entry_code!==value.code)) return null;
 return {id:value.id,code:value.code,entry_code:typeof value.entry_code==='string'?value.entry_code:null,mode:value.entry_code?'chain':'single',created_at:typeof value.created_at==='string'?value.created_at:'',
 ...(typeof value.name==='string'?{name:value.name}:{}),...(typeof value.entry_name==='string'?{entry_name:value.entry_name}:{}),
 ...(validId(value.route_check_id)?{route_check_id:value.route_check_id}:{}),
 ...(typeof value.conflicting_id==='string' && (validId(value.conflicting_id) || value.conflicting_id==='server-activity')?{conflicting_id:value.conflicting_id}:{})};
}
export type Notification = {message:string;at:string;error:boolean;neutral?:boolean;device_operation?:string};
export type RoutingScratch = {version:1;base:string;revision:string|null;form:Record<string,unknown> & {rule:Record<string,unknown>&{id:string};initial:unknown;original:unknown;entries:unknown[]}};
export type RouteFinderPreferences = {
 step:'single'|'chain'; exit:string|null; single:'all'|'not-working'|'chosen';
 chain:'reachable'|'all'|'chosen'; codes:string[]; entryCodes:string[];
};
export class BrowserStorage {
 private routeFinderMemory:RouteFinderPreferences|null=null;
 readRouteFinder(codes:readonly string[]):RouteFinderPreferences {
  const raw=this.routeFinderMemory ?? this.read(this.local,STORAGE_KEYS.routeFinder);
  const value=isRecord(raw)?raw:{};
  const available=new Set(codes);
  const selected=(items:unknown):string[]=>Array.isArray(items)
   ? [...new Set(items.filter((code):code is string=>typeof code==='string' && available.has(code)))] : [];
  return {step:value.step==='chain'?'chain':'single', exit:typeof value.exit==='string'?value.exit:null,
   single:value.single==='chosen'||value.single==='not-working'?value.single:'all',
   chain:value.chain==='chosen'||value.chain==='all'?value.chain:'reachable',
   codes:selected(value.codes),entryCodes:selected(value.entryCodes)};
 }
 saveRouteFinder(value:RouteFinderPreferences){
  try{this.local.setItem(STORAGE_KEYS.routeFinder,JSON.stringify(value));this.routeFinderMemory=null;}
  catch{this.routeFinderMemory=value;}
 }
 private main:MainIntent|null=null;
 private mainWriteFailed=false;private clearedMain=new Set<string>();
 private pending:RoutingPending|null=null;private pendingWriteFailed=false;private clearedPending=new Set<string>();
 private scratch:RoutingScratch|null=null;private scratchMemory=false;private inbox:Notification[]=[];private inboxMemory=false;
 private own=new Set<string>();
 constructor(readonly local:StorageLike=browserStore('localStorage'),readonly session:StorageLike=browserStore('sessionStorage')) {
  const own=this.read(this.session,STORAGE_KEYS.own); if(Array.isArray(own)) own.filter(validId).forEach(id=>this.own.add(id));
 }
 read(storage:StorageLike,key:string):unknown {try{return parseStored(storage.getItem(key));}catch{return null;}}
 write(storage:StorageLike,key:string,value:unknown) {try{storage.setItem(key,JSON.stringify(value));}catch{/* memory state remains usable */}}
 remove(storage:StorageLike,key:string) {try{storage.removeItem(key);}catch{/* storage may be denied */}}
 readMainIntent():MainIntent|null {try {if(this.mainWriteFailed)return this.main;const value=mainIntent(parseStored(this.local.getItem(STORAGE_KEYS.main)));return value&&!this.clearedMain.has(value.id)?value:null;}catch{return this.main;}}
 saveMainIntent(intent:MainIntent) {this.main=intent;this.clearedMain.delete(intent.id);try{this.local.setItem(STORAGE_KEYS.main,JSON.stringify(intent));this.mainWriteFailed=false;}catch{this.mainWriteFailed=true;}}
 clearMainIntent(id:string) {this.clearedMain.add(id);if(this.main?.id===id){this.main=null;this.mainWriteFailed=false;}try{if(mainIntent(parseStored(this.local.getItem(STORAGE_KEYS.main)))?.id===id)this.local.removeItem(STORAGE_KEYS.main);}catch{/* compare-ID never deletes a newer request */}}
 readRoutingPending():RoutingPending|null {
  if(this.pendingWriteFailed)return this.pending;
  let value:unknown;try{value=parseStored(this.session.getItem(STORAGE_KEYS.routing));}catch{return this.pending;}
  return isRecord(value)&&validId(value.operation_id)&&validId(value.preview_id)&&!this.clearedPending.has(value.operation_id)?{operation_id:value.operation_id,preview_id:value.preview_id}:null;
 }
 saveRoutingPending(value:RoutingPending){this.pending=value;this.clearedPending.delete(value.operation_id);try{this.session.setItem(STORAGE_KEYS.routing,JSON.stringify(value));this.pendingWriteFailed=false;}catch{this.pendingWriteFailed=true;}}
 clearRoutingPending(id:string){this.clearedPending.add(id);if(this.pending?.operation_id===id){this.pending=null;this.pendingWriteFailed=false;}const value=this.read(this.session,STORAGE_KEYS.routing);if(isRecord(value)&&value.operation_id===id)this.remove(this.session,STORAGE_KEYS.routing);}
 ownIds(){return [...this.own];}
 markOwn(id:string){this.own.add(id);this.write(this.session,STORAGE_KEYS.own,this.ownIds());}
 consumeOwn(id:string){const owned=this.own.delete(id);this.write(this.session,STORAGE_KEYS.own,this.ownIds());return owned;}
 readScratch():RoutingScratch|null {if(this.scratchMemory)return this.scratch;const value=this.read(this.session,STORAGE_KEYS.scratch);if(!isRecord(value)||value.version!==1||typeof value.base!=='string'||!(value.revision===null||typeof value.revision==='string')||!isRecord(value.form)||!isRecord(value.form.rule)||typeof value.form.rule.id!=='string'||!value.form.rule.id||!value.form.initial||!value.form.original||!Array.isArray(value.form.entries))return null;return value as RoutingScratch;}
 saveScratch(value:RoutingScratch|null){this.scratch=value;try{if(value)this.session.setItem(STORAGE_KEYS.scratch,JSON.stringify(value));else this.session.removeItem(STORAGE_KEYS.scratch);this.scratchMemory=false;}catch{this.scratchMemory=true;}}
 notifications():Notification[]{if(this.inboxMemory)return this.inbox;const value=this.read(this.local,STORAGE_KEYS.notifications);return Array.isArray(value)?value.filter((v):v is Notification=>isRecord(v)&&typeof v.message==='string'&&typeof v.at==='string'&&Number.isFinite(Date.parse(v.at))).slice(0,100):this.inbox;}
 saveNotifications(value:Notification[]){this.inbox=value.slice(0,100);try{this.local.setItem(STORAGE_KEYS.notifications,JSON.stringify(this.inbox));this.inboxMemory=false;}catch{this.inboxMemory=true;}}
 readAttention():string[]{const value=this.read(this.local,STORAGE_KEYS.attentionRead);return Array.isArray(value)?value.filter((v):v is string=>typeof v==='string').slice(-50):[];}
 saveAttention(value:string[]){this.write(this.local,STORAGE_KEYS.attentionRead,value.slice(-50));}
 readOwnEvents():string[]{const value=this.read(this.local,STORAGE_KEYS.ownEvents);return Array.isArray(value)?value.filter((v):v is string=>typeof v==='string').slice(-200):[];}
 saveOwnEvents(value:string[]){this.write(this.local,STORAGE_KEYS.ownEvents,value.slice(-200));}
 resetSession(){this.main=null;this.mainWriteFailed=false;const pending=this.readRoutingPending();if(pending)this.clearRoutingPending(pending.operation_id);this.pending=null;this.pendingWriteFailed=false;this.saveScratch(null);this.own.clear();this.remove(this.session,STORAGE_KEYS.own);}

}
export function newOperationId(crypto:Pick<Crypto,'getRandomValues'>|{getRandomValues:(bytes:Uint8Array)=>Uint8Array}=globalThis.crypto):string {
 const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const defaultStorage=new BrowserStorage();
let activeStorage=defaultStorage;
export function bindBrowserStorage(storage:BrowserStorage){const previous=activeStorage;activeStorage=storage;return ()=>{if(activeStorage===storage)activeStorage=previous;};}
export const readMainIntent=()=>activeStorage.readMainIntent();
export const saveMainIntent=(intent:MainIntent)=>activeStorage.saveMainIntent(intent);
export const clearMainIntent=(id:string)=>activeStorage.clearMainIntent(id);
