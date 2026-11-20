import {useCallback,useMemo,useEffect,useRef} from 'react';
import type { RoutingScratch } from "../browser/storage";
import {useQuery,type UseQueryResult,type QueryKey} from '@tanstack/react-query';
import {useSessionRuntime,useRuntimeRevision} from '../app/AppSessionProvider';
import {ApiError} from './client';
import {keys} from './keys';
import type {RouteCheckKind,RouteChecksDto,SessionDto,StatusDto,DevicesDto,RoutingDto,RoutingDraft,RoutingHistoryDto,SnapshotDto,FailoverDto,ConnectivityDto,SessionsDto,PairingDto,OperationDto} from './types';
export {keys} from './keys';
function useRead<T>(key:QueryKey,path:string,enabled:boolean,refreshOnMount=false){const runtime=useRuntimeRevision();return useQuery<T,ApiError>({queryKey:key,queryFn:({signal})=>runtime.readResponse<T>(path,signal),enabled:enabled&&runtime.authenticated,staleTime:Infinity,refetchOnMount:refreshOnMount ? "always" : true});}
export function useSession():UseQueryResult<SessionDto,ApiError>{const rt=useRuntimeRevision();return useQuery({queryKey:keys.session,queryFn:({signal})=>rt.api.requestJson<SessionDto>('/api/auth/session',{signal}),enabled:false});}
/** Retry the whole provider bootstrap, including restored tracking and timers. */
export function useRetrySession() {
 const runtime = useSessionRuntime();
 return useCallback(() => runtime.bootstrap(), [runtime]);
}
/** Subscription only: AppSessionProvider is the sole status/polling owner. */
export function useStatus():UseQueryResult<StatusDto,ApiError>{const rt=useSessionRuntime();return useQuery({queryKey:keys.status,queryFn:({signal})=>rt.api.requestJson<StatusDto>('/api/status',{signal}),enabled:false});}
export function useRefreshStatus() {
 const runtime = useSessionRuntime();
 return useCallback(() => runtime.refreshStatus(), [runtime]);
}
export function useDevices(enabled=true){return useRead<DevicesDto>(keys.devices,'/api/devices',enabled);}
export function useRouting(enabled = true, refreshOnMount = false) {
 return useRead<RoutingDto>(keys.routing, "/api/routing", enabled, refreshOnMount);
}
export function useRoutingDraft(enabled=true){return useRead<{draft:RoutingDraft|null}>(keys.draft,'/api/routing/draft',enabled);}
export function useRoutingHistory(enabled = true, refreshOnMount = false) {
 return useRead<RoutingHistoryDto>(keys.history, "/api/routing/history", enabled, refreshOnMount);
}
export function useRoutingSnapshot(id:string|null){return useRead<SnapshotDto>(keys.snapshot(id??''),'/api/routing/history/'+encodeURIComponent(id??''),!!id);}
export function useOperation(id:string|null){const rt=useRuntimeRevision();return useQuery<OperationDto,ApiError>({queryKey:keys.operation(id??''),queryFn:async()=>{await rt.readOperation(id!);const value=rt.queryClient.getQueryData<OperationDto>(keys.operation(id!));if(!value)throw new ApiError('Operation not found',{status:404});return value;},enabled:false});}
export function useFailover(enabled=true){return useRead<FailoverDto>(keys.failover,'/api/failover',enabled);}
export function useConnectivity(enabled=true){return useRead<ConnectivityDto>(keys.connectivity,'/api/connectivity',enabled);}
export function useSessions(enabled=true, refreshOnMount=false){return useRead<SessionsDto>(keys.sessions,'/api/auth/sessions',enabled,refreshOnMount);}
export function useSubscriptionUrl(enabled=true){return useRead<{url:string|null}>(keys.subUrl,'/api/sub-url',enabled);}
export function usePairing(id: string | null, enabled = true, open = true) {
 const runtime = useSessionRuntime();
 useEffect(() => {
  runtime.setPairing(enabled ? id : null, open);
 }, [runtime, id, enabled, open]);
 useEffect(() => () => { runtime.setPairing(null); }, [runtime]);
 // The provider owns both the open-dialog and closed-dashboard cadence.
 return useRead<PairingDto>(keys.pairing(id ?? ''), '/api/auth/pairing-code?id=' + encodeURIComponent(id ?? ''), false);
}
/** Screen supplies the legacy editing/focus gate; no second interval is created. */
export function useDevicesPolling(eligible:boolean){const rt=useSessionRuntime(),value=useRef(eligible);value.current=eligible;useEffect(()=>rt.setDevicesPolling(()=>value.current),[rt]);}
export function useRoutingEditorPolling(eligible:boolean){const rt=useSessionRuntime(),value=useRef(eligible);value.current=eligible;useEffect(()=>rt.setRoutingPolling(()=>value.current),[rt]);}

/** Event-driven reads and tab-local state for the routing editor. */
export function useRoutingEditorAccess() {
 const runtime = useSessionRuntime();
 return useMemo(() => ({
  newRuleId: (signal: AbortSignal) => runtime.api.requestJson<{id: string}>("/api/routing/id", {signal}),
  async readOperation(id: string) {
   const epoch = runtime.api.epoch;
   await runtime.readOperation(id);
   runtime.api.assertCurrent(epoch);
   if (!runtime.queryClient.getQueryData(keys.operation(id))) {
    throw new Error("Could not read this operation. Check again or return to versions.");
   }
  },
  readScratch: () => runtime.storage.readScratch(),
  saveScratch: (scratch: RoutingScratch | null) => runtime.storage.saveScratch(scratch),
  pending: () => runtime.storage.readRoutingPending(),
 }), [runtime]);
}

/** A closed desktop summary subscribes to invalidation without polling. */
export function useRouteChecks(kind: RouteCheckKind, exit: string | null, enabled: boolean, poll = true) {
 const runtime = useRuntimeRevision();
 return useQuery<RouteChecksDto, ApiError>({
  queryKey: keys.routeChecks(kind, exit),
  queryFn: ({signal}) => runtime.readRouteChecks(kind, exit, signal),
  enabled: enabled && (kind === 'single' || !!exit) && runtime.authenticated,
  staleTime: 0,
  refetchOnMount: 'always',
  refetchInterval: poll ? (query) => query.state.data?.active_run ? 1000 : 3000 : false,
 });
}
