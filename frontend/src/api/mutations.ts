import {useMutation,type QueryKey} from '@tanstack/react-query';
import {useSessionRuntime} from '../app/AppSessionProvider';
import {ApiError,StaleSessionError,type RequestOptions} from './client';
import {keys} from './keys';
import {operationDto,type AutoUpdateInput,type AutoUpdateDto,type FailoverConfig,type ConnectivityDto,type DeviceChangeInput,type DeviceLocationInput,type DevicesDto,type EventResponse,type HealthDocument,type JsonObject,type OkDto,type PairingDto,type PreviewInput,type RoutingDto,type RoutingDraft,type RoutingPreview,type SaveDraftInput,type OperationDto,type ProbeDto,type RouteCheckDto} from './types';
import type {SessionRuntime} from '../operations/runtime';
/** All effects stay inside the generation-guarded request, never a generic HTTP onSuccess. */
function useAction<T,V>(action:(runtime:SessionRuntime,value:V)=>Promise<T>){const runtime=useSessionRuntime();return useMutation<T,ApiError,V>({mutationFn:value=>action(runtime,value),retry:false,networkMode:'always'});}
function mutation<T, V>(
 path: string,
 method: RequestOptions['method'],
 invalidate: readonly QueryKey[],
 options: {reconcileStatus?: boolean} = {},
) {
 return (rt: SessionRuntime, value: V) => rt.mutate<T>(path, value, method, invalidate, options);
}
export function useLogin(){return useAction((rt,value:{password:string})=>rt.authenticate('login',value));}
export function useSetup(){return useAction((rt,value:{password:string})=>rt.authenticate('setup',value));}
export function usePairLogin(){return useAction((rt,value:{code:string})=>rt.authenticate('pair',value));}
export function useLogout(){return useAction((rt,_:void)=>rt.logout());}
export function useChangePassword(){return useAction((rt,value:{current_password:string;password:string})=>rt.changePassword(value));}
export function useCreatePairingCode(){return useAction((rt,_:Record<string,never>)=>rt.createPairingCode());}
export function useRevokeSession(){return useAction(async(rt,value:{id:string})=>{const epoch=rt.api.epoch;const result=await rt.mutate<OkDto&{current_revoked:boolean}>('/api/auth/sessions/revoke',value,'POST',[keys.sessions]);rt.api.assertCurrent(epoch);if(result.current_revoked)rt.signedOut();return result;});}
export function useRefreshSubscription(){return useAction((rt,_:Record<string,never>)=>rt.refreshSubscription());}
export function useSaveSubscriptionUrl(){return useAction(mutation<OkDto&{url:string}, {url:string}>('/api/sub-url','POST',[keys.status,keys.subUrl]));}
export function useXkeenControl(){return useAction(mutation<OkDto&{action:string},{action:'start'|'stop'|'restart'}>('/api/xkeen','POST',[keys.status,keys.devices],{reconcileStatus:true}));}
export function useApplyPending(){return useAction(mutation<OkDto&{active_code:string|null;active_entry_code:string|null},Record<string,never>>('/api/active-refresh','POST',[keys.status,keys.devices],{reconcileStatus:true}));}
export function useSaveAutoUpdate(){return useAction(mutation<OkDto&{config:AutoUpdateDto},AutoUpdateInput>('/api/auto-update','PUT',[keys.status]));}
export function useSaveFailover(){return useAction(mutation<OkDto&{config:FailoverConfig&{schema_version:number}},FailoverConfig>('/api/failover/config','PUT',[keys.failover,keys.status]));}
export function useCheckFailover(){return useAction(mutation<HealthDocument,Record<string,never>>('/api/failover/check-now','POST',[keys.failover,keys.status]));}
export function useSaveConnectivity(){return useAction(mutation<OkDto&{config:ConnectivityDto['config']},{check_urls:string[]}>('/api/connectivity','PUT',[keys.connectivity,keys.status,keys.allRouteChecks]));}
export function useProbeLocations(){return useAction(mutation<ProbeDto&EventResponse,{code?:string;codes?:string[]}>('/api/probe','POST',[keys.status,keys.failover],{reconcileStatus:true}));}
export function useCheckRoute(){return useAction(mutation<RouteCheckDto,Record<string,never>>('/api/route-check','POST',[keys.status,keys.failover],{reconcileStatus:true}));}
export function useChangeDevices(){return useAction((rt,value:DeviceChangeInput)=>rt.deviceMutation('/api/devices/change',value));}
export function useUndoDeviceChange(){return useAction((rt,value:{operation_id:string})=>rt.undoDeviceChange(value.operation_id));}
export function useSaveDeviceServer(){return useAction((rt,value:{revision:string|null;id:string|null})=>rt.deviceMutation('/api/devices/server',value));}
export function useSaveDeviceRoutingSettings(){return useAction((rt,value:{revision:string|null;policy_ids:string[]})=>rt.deviceMutation('/api/devices/routing-settings',value,'PUT'));}
export function useFavoriteDevice(){return useAction(mutation<{favorites:string[]},{id:string;favorite:boolean}>('/api/devices/favorite','POST',[keys.devices]));}
export function useAssignDeviceLocation(){return useAction(async(rt,value:DeviceLocationInput):Promise<OperationDto>=>{
 const epoch=rt.api.epoch;rt.markOwn(value.operation_id);
 try{const response=await rt.mutate('/api/devices/location',value);rt.api.assertCurrent(epoch);const operation={kind:"device-location",...operationDto(response,value.operation_id)};void rt.observe(operation,'response');return operation;}
 catch(error){if(error instanceof StaleSessionError||epoch!==rt.api.epoch)throw error;if(error instanceof ApiError&&!error.acceptanceUnknown){rt.storage.consumeOwn(value.operation_id);if(error.operation)rt.observe(error.operation);}throw error;}
});}
export function useCheckDeviceLocation(){return useAction(async(rt,value:{operation_id:string})=>{const epoch=rt.api.epoch;await rt.readOperation(value.operation_id);rt.api.assertCurrent(epoch);await rt.read<DevicesDto>(keys.devices,'/api/devices');return rt.queryClient.getQueryData<OperationDto>(keys.operation(value.operation_id));});}
export function useSaveRoutingDraft(){return useAction(async(rt,value:SaveDraftInput)=>{const epoch=rt.api.epoch;const draft=await rt.mutate<RoutingDraft|null>('/api/routing/draft',value,'PUT',[keys.routing]);rt.api.assertCurrent(epoch);rt.queryClient.setQueryData(keys.draft,{draft});return draft;});}
export function useDiscardRoutingDraft(){return useAction(mutation<OkDto,{expected_revision:string|null}>('/api/routing/draft','DELETE',[keys.routing,keys.draft]));}
export function usePreviewRouting(){return useAction(mutation<RoutingPreview,PreviewInput>('/api/routing/preview','POST',[]));}
export function useReimportRouting(){return useAction(mutation<RoutingDto,{expected_current_hash:string;observed_hash:string}>('/api/routing/reimport','POST',[keys.routing,keys.history]));}
export function useDownloadSnapshot(){return useAction((rt,value:{id:string;signal?:AbortSignal})=>rt.api.requestBlob('/api/routing/history/'+encodeURIComponent(value.id)+'/download',value.signal));}
