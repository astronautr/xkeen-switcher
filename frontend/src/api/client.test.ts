import { it, expect } from '@rstest/core';
import { ApiClient, ApiError, StaleSessionError, classifyError } from './client';
const deferred = <T,>() => { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {resolve,promise}; };
it('A03 guards stale headers, bodies, unauthorized callbacks and mutation barriers', async () => {
 const body=deferred<unknown>(); let unauthorized=0, ended=0;
 const client=new ApiClient(async ()=>({ok:false,status:401,headers:new Headers(),json:()=>body.promise}) as Response);
 client.onUnauthorized=()=>unauthorized++; client.onMutationEnd=()=>ended++;
 const request=client.requestJson('/api/switch',{method:'POST',body:{}}); await Promise.resolve(); client.advanceGeneration(); body.resolve({error:'old'});
 await expect(request).rejects.toBeInstanceOf(StaleSessionError); expect(unauthorized).toBe(0); expect(ended).toBe(0);
});
it('uses JSON marker/cookies/no-store and forwards abort to GET', async () => {
 let recorded: RequestInit|undefined; const controller=new AbortController();
 const client=new ApiClient(async (_path, options)=>{recorded=options; return new Response('{}');});
 await client.requestJson('/api/status',{signal:controller.signal}); expect(recorded).toMatchObject({credentials:'same-origin',cache:'no-store',signal:controller.signal});
 await client.requestJson('/api/update',{method:'POST',body:{}}); expect(recorded?.headers).toEqual({'Content-Type':'application/json','X-XK-Request':'1'});
});
it('acknowledges exact event IDs on error before releasing the barrier',async()=>{
 const order:string[]=[]; const client=new ApiClient(async()=>new Response(JSON.stringify({error:'busy',code:'busy',event_ids:['event-1']}),{status:409,headers:{'Retry-After':'3'}}));
 client.onEventIds=ids=>order.push(...ids); client.onMutationEnd=()=>order.push('end');
 try {await client.requestJson('/api/update',{method:'POST',body:{}});} catch(error) {expect(error).toMatchObject({status:409,code:'busy',retryAfter:'3',eventIds:['event-1'],acceptanceUnknown:false});}
 expect(order).toEqual(['event-1','end']);
});
it.each([408,429,500,502])('preserves ambiguous acceptance for HTTP %s',async status=>{
 const client=new ApiClient(async()=>new Response('broken',{status})); await expect(client.requestJson('/api/switch',{method:'POST'})).rejects.toMatchObject({acceptanceUnknown:true});
});
it('classifies coded unavailable versus uncoded ambiguous failure',()=>{
 expect(classifyError(new ApiError('down',{status:503,code:'storage'}))).toBe('unavailable');
 expect(classifyError(new ApiError('down',{status:503}))).toBe('unknown');
 expect(classifyError(new ApiError('conflict',{status:409}))).toBe('rejected');
});
it('H01 blob download preserves exact bytes',async()=>{
 const raw='// comment\r\n{"routing":{}}\r\n'; const client=new ApiClient(async()=>new Response(raw)); expect(await (await client.requestBlob('/download')).text()).toBe(raw);
});
it('A03 stale headers cannot parse a private body or log out a new session',async()=>{
 const headers=deferred<Response>();let parsed=0,unauthorized=0;const client=new ApiClient(()=>headers.promise);client.onUnauthorized=()=>unauthorized++;
 const response=client.requestJson('/api/status');client.advanceGeneration();headers.resolve({status:401,ok:false,json:async()=>{parsed++;return {};}} as Response);
 await expect(response).rejects.toBeInstanceOf(StaleSessionError);expect(parsed).toBe(0);expect(unauthorized).toBe(0);
});
it('invalid JSON releases its mutation barrier without success or an invented event ID',async()=>{
 let ended=0,ids=0;const client=new ApiClient(async()=>new Response('{'));client.onMutationEnd=()=>ended++;client.onEventIds=()=>ids++;
 await expect(client.requestJson('/api/update',{method:'POST'})).rejects.toMatchObject({acceptanceUnknown:true});expect(ended).toBe(1);expect(ids).toBe(0);
});
it('A03 blob completion from an earlier session cannot escape its epoch',async()=>{
 const body=deferred<Blob>();const client=new ApiClient(async()=>({ok:true,status:200,headers:new Headers(),blob:()=>body.promise}) as Response);const result=client.requestBlob('/download');await Promise.resolve();client.advanceGeneration();body.resolve(new Blob(['old private bytes']));await expect(result).rejects.toBeInstanceOf(StaleSessionError);
});
it('public transport binds to the provider epoch and restores its previous owner',async()=>{
 const {bindSessionClient,requestJson}=await import('./client');const client=new ApiClient(async()=>new Response('{"ok":true}'));const unbind=bindSessionClient(client);try{expect(await requestJson('/api/status')).toEqual({ok:true});}finally{unbind();}
});
