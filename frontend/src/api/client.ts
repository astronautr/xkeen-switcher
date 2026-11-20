import {isRecord,operationDto,type OperationDto} from './types';
export type ErrorKind='busy'|'precondition'|'conflict'|'validation'|'unavailable'|'rejected'|'unknown'|'not_found'|'unauthorized';
export class ApiError extends Error {
 status?:number;code?:string;retryAfter?:string;operation?:OperationDto;eventIds:string[];acceptanceUnknown:boolean;data?:unknown;
 constructor(message:string, details:{status?:number;code?:string;retryAfter?:string;operation?:OperationDto;eventIds?:string[];acceptanceUnknown?:boolean;data?:unknown}={}) {
  super(message);this.name='ApiError';Object.assign(this,details);this.eventIds=details.eventIds??[];this.acceptanceUnknown=details.acceptanceUnknown??classifyError(this)==='unknown';
 }
}
export class StaleSessionError extends ApiError {constructor(){super('Session changed',{acceptanceUnknown:false});this.name='StaleSessionError';}}
export function classifyError(error:{status?:number;code?:string}):ErrorKind {
 if(error.status===401)return 'unauthorized';
 if(error.code==='busy')return 'busy';if(error.code==='precondition')return 'precondition';
 if(['conflict','draft_conflict','drift'].includes(error.code??''))return 'conflict';
 if([400,413,415,422].includes(error.status??0)||['validation','invalid_request','noop','too_large'].includes(error.code??''))return 'validation';
 if(['unavailable','helper','health','storage','location'].includes(error.code??''))return 'unavailable';
 if(error.status===404)return 'not_found';
 if(error.status===503 && error.code)return 'unavailable';
 if(!error.status||[408,429].includes(error.status)||error.status>=500)return 'unknown';return 'rejected';
}
export type RequestOptions={method?:'GET'|'POST'|'PUT'|'DELETE';body?:unknown;signal?:AbortSignal;authAttempt?:boolean};
export class ApiClient {
 private generation=0;
 onUnauthorized?:()=>void;onEventIds?:(ids:string[])=>void;onMutationStart?:(token:symbol)=>void;onMutationEnd?:(token:symbol)=>void;
 constructor(private fetcher:typeof fetch=(...args)=>fetch(...args)){}
 get epoch(){return this.generation;}
 advanceGeneration(){return ++this.generation;}
 assertCurrent(epoch:number){if(epoch!==this.generation)throw new StaleSessionError();}
 async requestJson<T>(path:string,options:RequestOptions={}):Promise<T>{return this.request(path,options,false) as Promise<T>;}
 async requestBlob(path:string,signal?:AbortSignal):Promise<Blob>{return this.request(path,{signal},true) as Promise<Blob>;}
 private async request(path:string,options:RequestOptions,blob:boolean):Promise<unknown>{
  const epoch=this.generation,method=options.method??'GET',mutation=method!=='GET',token=Symbol(path);
  if(mutation)this.onMutationStart?.(token);
  try {
   let response:Response;
   try {response=await this.fetcher(path,{method,credentials:'same-origin',cache:'no-store',signal:options.signal,
    ...(mutation?{headers:{'Content-Type':'application/json','X-XK-Request':'1'},body:JSON.stringify(options.body??{})}:{})});}
   catch(error){this.assertCurrent(epoch);if(error instanceof Error&&error.name==='AbortError')throw error;throw new ApiError(error instanceof Error?error.message:'Network error');}
   this.assertCurrent(epoch);
   let body:unknown;
   try{body=blob&&response.ok?await response.blob():await response.json();}
   catch{this.assertCurrent(epoch);if(response.status===401&&!options.authAttempt){this.onUnauthorized?.();throw new StaleSessionError();}throw new ApiError(response.ok?'Invalid response body':`HTTP ${response.status}`,{status:response.status,acceptanceUnknown:response.ok?true:undefined});}
   this.assertCurrent(epoch);
   const eventIds=isRecord(body)&&Array.isArray(body.event_ids)?body.event_ids.filter((id):id is string=>typeof id==='string'):[];
   if(eventIds.length)this.onEventIds?.(eventIds);
   if(response.status===401&&!options.authAttempt){this.onUnauthorized?.();throw new StaleSessionError();}
   if(!response.ok){let operation:OperationDto|undefined;try{if(isRecord(body)&&body.operation)operation=operationDto(body.operation);}catch{/* never trust malformed blockers */}
    throw new ApiError(isRecord(body)&&typeof body.error==='string'?body.error:`HTTP ${response.status}`,{status:response.status,code:isRecord(body)&&typeof body.code==='string'?body.code:undefined,retryAfter:response.headers.get('Retry-After')??undefined,operation,eventIds,data:body});}
   return body;
  }finally{if(epoch===this.generation&&mutation)this.onMutationEnd?.(token);}
 }
}
export const defaultClient=new ApiClient();
let activeClient=defaultClient;
/** Provider lifecycle binding; the public transport shares its auth generation. */
export function bindSessionClient(client:ApiClient){const previous=activeClient;activeClient=client;return ()=>{if(activeClient===client)activeClient=previous;};}
export const requestJson=<T,>(path:string,options?:RequestOptions)=>activeClient.requestJson<T>(path,options);
export const requestBlob=(path:string,signal?:AbortSignal)=>activeClient.requestBlob(path,signal);
