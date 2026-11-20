import {isRecord,type EventDto,type StatusDto} from '../api/types';
import {parseStored,STORAGE_KEYS,type StorageLike} from '../browser/storage';
import {eventNeedsAttention} from './policy';
const LIMIT=200;
export class EventFeed {
 private cursor:string|null=null; private seen:string[]=[];private own=new Set<string>();
 constructor(private storage:StorageLike){const saved=this.load();if(isRecord(saved)&&typeof saved.cursor==='string'){this.cursor=saved.cursor;this.seen=this.ids(saved.seen);}}
 private ids(value:unknown){return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string').slice(-LIMIT):[];}
 private load(){try{return parseStored(this.storage.getItem(STORAGE_KEYS.events));}catch{return null;}}
 private persist(){try{this.storage.setItem(STORAGE_KEYS.events,JSON.stringify({cursor:this.cursor,seen:this.seen}));}catch{/* retain memory cursor */}}
 private remember(id:string){if(!id)return;this.seen=this.seen.filter(v=>v!==id);this.seen.push(id);this.seen=this.seen.slice(-LIMIT);}
 private key(e:EventDto){return e.event_id||e.operation_id||[e.ts,e.action,e.code||'',e.result||''].join('|');}
 markSeen(id:string){this.remember(id);this.persist();}
 expectOwn(operationId:string){this.own.add(operationId);if(this.own.size>20)this.own.delete(this.own.values().next().value!);}
 take(history:EventDto[]):EventDto[]{
  const shared=this.load();if(isRecord(shared))for(const id of this.ids(shared.seen))if(!this.seen.includes(id))this.remember(id);
  const entries=history.filter(e=>e&&e.ts);if(!entries.length){if(this.cursor===null){this.cursor='';this.persist();}return [];}
  const ordered=entries.every(e=>!!e.event_id),newest=ordered?this.key(entries.at(-1)!):entries.reduce((max,e)=>e.ts>max?e.ts:max,'');
  if(this.cursor===null){this.cursor=newest;entries.forEach(e=>this.remember(this.key(e)));this.persist();return [];}
  const boundary=ordered?entries.findIndex(e=>this.key(e)===this.cursor):-1;
  const fresh=entries.filter((e,i)=>(ordered?boundary<0||i>boundary:e.ts>=this.cursor!)&&!this.seen.includes(this.key(e)));
  const announced=fresh.filter(e=>!e.operation_id||!(this.own.has(e.operation_id)||this.seen.includes(e.operation_id)));
  fresh.forEach(e=>this.remember(this.key(e)));if(ordered||newest>this.cursor)this.cursor=newest;this.persist();
  return ordered?announced:announced.sort((a,b)=>a.ts.localeCompare(b.ts));
 }
}
function lostSubscriptionRoute(entry: EventDto) {
 return entry.action === 'update' && /^active .*vanished from subscription$/.test(entry.message ?? '');
}
/** Stable identity of one failure event, used to remember that this browser has read it. */
export function attentionKey(entry: EventDto) {
 return entry.event_id || [entry.ts, entry.action, entry.code || '', entry.result || ''].join('|');
}
export function attentionGroup(entry: EventDto) {
 if (['routing-apply', 'routing-restore'].includes(entry.action)) return 'routing';
 return lostSubscriptionRoute(entry) || ['switch', 'failover', 'failover-switch', 'failback', 'auto-recovery', 'total-failure-stop'].includes(entry.action)
  ? 'route' : entry.action;
}
export function attentionFromEvents(entries: EventDto[], status?: StatusDto, previous: Record<string, EventDto> = {}) {
 const attention = {...previous};
 for (const entry of entries) {
  const group = attentionGroup(entry);
  if (eventNeedsAttention(entry)) {
   attention[group] = entry;
  } else if (entry.result === 'ok') {
   delete attention[group];
   if (entry.action === 'xkeen' && ['start', 'restart'].includes(entry.code ?? '') && attention.route?.action === 'total-failure-stop') {
    delete attention.route;
   }
  }
 }
 if (attention.route && lostSubscriptionRoute(attention.route) && status?.active_status === 'ok' && status.active_code) {
  const codes = [status.active_code, status.active_entry_code].filter(Boolean);
  if (codes.every(code => status.available.some(location => location.code === code))) {
   delete attention.route;
  }
 }
 return attention;
}
