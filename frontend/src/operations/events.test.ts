import {it,expect} from '@rstest/core';
import {EventFeed,attentionFromEvents} from './events';
import {activityPresentation,terminal} from './policy';
import type {EventDto} from '../api/types';
const storage=()=>{const data=new Map<string,string>();return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};};
const event=(id:string,ts='2026-11-17T00:00:00Z'):EventDto=>({event_id:id,ts,action:'update',result:'ok'});
it('H01 seeds nonempty history silently, empty history admits later events, and IDs order clock reversals',()=>{
 const a=new EventFeed(storage());expect(a.take([event('a')])).toEqual([]);
 expect(a.take([event('a'),event('b','2020-01-01'),event('c','2019-01-01')]).map(e=>e.event_id)).toEqual(['b','c']);
 const b=new EventFeed(storage());b.take([]);expect(b.take([event('a')])).toEqual([event('a')]);
});
it('exact response IDs suppress only their event and merge sibling acknowledgements after rotation',()=>{
 const shared=storage(),a=new EventFeed(shared),b=new EventFeed(shared);a.take([]);b.take([]);a.markSeen('own');
 expect(b.take([event('own'),event('foreign')]).map(e=>e.event_id)).toEqual(['foreign']);
 expect(a.take([event('foreign'),event('rotated')]).map(e=>e.event_id)).toEqual(['rotated']);
 expect(new EventFeed(shared).take([event('rotated')])).toEqual([]);
});
it('bounded cursor validates corrupt persisted fields and null cursor still seeds',()=>{
 const shared=storage();shared.setItem('xk_event_cursor',JSON.stringify({cursor:null,seen:['old',9]}));const feed=new EventFeed(shared);expect(feed.take([event('a')])).toEqual([]);
 for(let i=0;i<250;i++)feed.markSeen(String(i));expect(JSON.parse(shared.getItem('xk_event_cursor')!).seen).toHaveLength(200);
});
it('attention rebuilds independently of sibling cursor and only recovers within the domain',()=>{
 const failed={...event('a'),action:'routing-apply',result:'fail'};const route={...event('b'),action:'switch',result:'ok'};
 expect(attentionFromEvents([failed,route]).routing).toEqual(failed);expect(attentionFromEvents([failed,route,{...event('c'),action:'routing-restore'}]).routing).toBeUndefined();
});
it("both tabs reconstruct a total failure stop and verified power recovery clears it", () => {
 const shared = storage();
 const stop = { ...event("stopped"), action: "total-failure-stop", trigger: "failover" };
 for (const feed of [new EventFeed(shared), new EventFeed(shared)]) {
  expect(feed.take([stop])).toEqual([]);
  expect(attentionFromEvents([stop]).route).toEqual(stop);
  expect(attentionFromEvents([stop, { ...event("switched"), action: "switch" }]).route).toBeUndefined();
  for (const code of ["start", "restart"]) {
   const recovery = { ...event("recovered"), action: "xkeen", code };
   expect(attentionFromEvents([stop, recovery]).route).toBeUndefined();
  }
 }
});
it('O01/O02 activity has stable identity and unknown is blocking even for future phases',()=>{
 const op={id:'11111111-1111-4111-8111-111111111111',phase:'applying',kind:'main'};
 expect(activityPresentation(op,[op.id]).delay).toBe(3000);expect(activityPresentation({...op,phase:'unknown'},[op.id]).delay).toBe(0);
 expect(activityPresentation({...op,phase:'future'}).key).toBe(op.id);expect(terminal({...op,phase:'future'})).toBe(false);
 expect(activityPresentation({...op,phase:'committed'}).active).toBe(false);
 expect(activityPresentation({id:null,ephemeral:true,phase:'preparing',kind:'read',created_at:'t'}).delay).toBe(1000);
});
