import {it,expect,rstest} from '@rstest/core';
import {SessionRuntime} from './runtime';
import {ApiClient} from '../api/client';
import {BrowserStorage} from '../browser/storage';
import status from '../../tests/fixtures/status.json';
const id='11111111-1111-4111-8111-111111111111';
const memory=()=>{const values=new Map<string,string>();return {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
it('O03 one owner survives StrictMode remount; status 10s, journal 1.5s, hidden pauses and visible resumes once',async()=>{
 rstest.useFakeTimers();const doc=new EventTarget() as EventTarget&{hidden:boolean};doc.hidden=false;rstest.stubGlobal('document',doc);
 try{
 const requests:string[]=[];const runtime=new SessionRuntime({storage:new BrowserStorage(memory(),memory()),api:new ApiClient(async(input)=>{const path=String(input);requests.push(path);return new Response(JSON.stringify(path==='/api/auth/session'?{configured:true,authenticated:true,session_id:'s'}:path==='/api/status'?status:{id,phase:'unknown'}));})});
 const stop1=runtime.start();stop1();const stop2=runtime.start();await flush();
 expect(requests.filter(p=>p==='/api/auth/session')).toHaveLength(1);expect(requests.filter(p=>p==='/api/status')).toHaveLength(1);
 await rstest.advanceTimersByTimeAsync(9999);expect(requests.filter(p=>p==='/api/status')).toHaveLength(1);
 await rstest.advanceTimersByTimeAsync(1);expect(requests.filter(p=>p==='/api/status')).toHaveLength(2);
 runtime.observe({id,phase:'unknown'});await rstest.advanceTimersByTimeAsync(1499);expect(requests.filter(p=>p.includes('/operations/'))).toHaveLength(0);
 await rstest.advanceTimersByTimeAsync(1);expect(requests.filter(p=>p.includes('/operations/'))).toHaveLength(1);
 doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));const before=requests.length;await rstest.advanceTimersByTimeAsync(30000);expect(requests).toHaveLength(before);
 doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await flush();expect(requests).toHaveLength(before+2);
 stop2();await flush();const end=requests.length;await rstest.advanceTimersByTimeAsync(30000);expect(requests).toHaveLength(end);
 }finally{rstest.unstubAllGlobals();rstest.useRealTimers();}
});
it('pair invitation has one 2s owner, pauses hidden, resumes current ID, and stops after use',async()=>{
 rstest.useFakeTimers();const doc=new EventTarget() as EventTarget&{hidden:boolean};doc.hidden=false;rstest.stubGlobal('document',doc);
 try{const requests:string[]=[];let used=false;const runtime=new SessionRuntime({storage:new BrowserStorage(memory(),memory()),api:new ApiClient(async(input)=>{const path=String(input);requests.push(path);return new Response(JSON.stringify(path==='/api/auth/session'?{authenticated:true}:path==='/api/status'?status:{id,status:used?'used':'pending',expires_at:1794873900}));})});const stop=runtime.start();await flush();const unpair=runtime.setPairing(id);await rstest.advanceTimersByTimeAsync(1999);expect(requests.filter(p=>p.includes('pairing-code'))).toHaveLength(0);await rstest.advanceTimersByTimeAsync(1);expect(requests.filter(p=>p.includes('pairing-code'))).toHaveLength(1);doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));await rstest.advanceTimersByTimeAsync(4000);expect(requests.filter(p=>p.includes('pairing-code'))).toHaveLength(1);used=true;doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await flush();expect(requests.filter(p=>p.includes('pairing-code'))).toHaveLength(2);await rstest.advanceTimersByTimeAsync(4000);expect(requests.filter(p=>p.includes('pairing-code'))).toHaveLength(2);unpair();stop();await flush();}finally{rstest.unstubAllGlobals();rstest.useRealTimers();}
});

it('closed pairing follows dashboard cadence and reopening checks the same pending ID', async () => {
 rstest.useFakeTimers();
 try {
  const requests: string[] = [];
  const runtime = new SessionRuntime({
   storage: new BrowserStorage(memory(), memory()),
   api: new ApiClient(async input => {
    const path = String(input);
    requests.push(path);
    return new Response(JSON.stringify(path === '/api/auth/session' ? {authenticated: true}
     : path === '/api/status' ? status : {id, status: 'pending', expires_at: 1794873900}));
   }),
  });
  const stop = runtime.start();
  await flush();
  runtime.setPairing(id, true);
  await rstest.advanceTimersByTimeAsync(2000);
  expect(requests.filter(path => path.includes('pairing-code'))).toHaveLength(1);
  runtime.setPairing(id, false);
  await rstest.advanceTimersByTimeAsync(7999);
  expect(requests.filter(path => path.includes('pairing-code'))).toHaveLength(1);
  await rstest.advanceTimersByTimeAsync(1);
  expect(requests.filter(path => path.includes('pairing-code'))).toHaveLength(2);
  runtime.setPairing(id, true);
  await flush();
  expect(requests.filter(path => path.includes('pairing-code'))).toHaveLength(3);
  stop();
  await flush();
 } finally {
  rstest.useRealTimers();
 }
});
