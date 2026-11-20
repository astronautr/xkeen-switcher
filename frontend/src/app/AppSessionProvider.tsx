import {createContext,useContext,useEffect,useMemo,useState,useSyncExternalStore,type ReactNode,type Dispatch,type SetStateAction} from 'react';
import {QueryClientProvider} from '@tanstack/react-query';
import {bindBrowserStorage, type Notification,type RouteFinderPreferences} from '../browser/storage';
import {bindSessionClient} from '../api/client';
import type {MainRoute,RouteCheckStart,RoutingPreview} from '../api/types';
import {SessionRuntime} from '../operations/runtime';
const SessionContext=createContext<SessionRuntime|null>(null);
export function AppSessionProvider({children,runtime:provided}:{children:ReactNode;runtime?:SessionRuntime}){
 const [runtime]=useState(()=>provided??new SessionRuntime());
 useEffect(()=>{const unbind=bindSessionClient(runtime.api),unbindStorage=bindBrowserStorage(runtime.storage),stop=runtime.start();return ()=>{stop();unbindStorage();unbind();};},[runtime]);
 return <SessionContext.Provider value={runtime}><QueryClientProvider client={runtime.queryClient}>{children}</QueryClientProvider></SessionContext.Provider>;
}
/** Infrastructure seam. Features use the named hooks in api/queries and api/mutations. */
export function useSessionRuntime(){const runtime=useContext(SessionContext);if(!runtime)throw new Error('AppSessionProvider is missing');return runtime;}
export function useRuntimeRevision(){const runtime=useSessionRuntime();useSyncExternalStore(runtime.subscribe,runtime.snapshot,runtime.snapshot);return runtime;}
export function useOperationTracking(){return useRuntimeRevision().view();}
export function useMainActions() {
 const runtime = useSessionRuntime();
 return useMemo(() => ({
  switchTo: (route: MainRoute) => runtime.main.switchTo(route),
  dismissRefusal: () => runtime.setRefusal(null),
 }), [runtime]);
}
export function useRoutingActions(){const runtime=useRuntimeRevision();return useMemo(()=>({apply:(preview:RoutingPreview)=>runtime.routing.apply(preview),retry:()=>runtime.routing.retry(),canRetry:()=>runtime.routing.canRetry()}),[runtime]);}
export function useNotifications() {
 const runtime = useRuntimeRevision();
 return {
  items: runtime.notifications(),
  subscribePublished: runtime.subscribePublished,
  publish: (message: string, error = false, metadata?: Pick<Notification, 'device_operation'>) => runtime.notify(message, error, metadata),
  clear: () => runtime.clearNotifications(),
 };
}
export function useActivity(){const runtime=useRuntimeRevision();return {activity:runtime.view().activity,attention:runtime.attention(),acknowledge:()=>runtime.acknowledgeAttention(),ownEvents:runtime.ownEvents(),pendingMutations:runtime.pendingMutations(),routeCheck:runtime.routeCheckActivity()};}
export function useRouteCheckActions(){
 const runtime=useSessionRuntime();
 return useMemo(()=>({
  start:(input:RouteCheckStart)=>runtime.startRouteChecks(input),
  readPreferences:(codes:readonly string[])=>runtime.storage.readRouteFinder(codes),
  savePreferences:(value:RouteFinderPreferences)=>runtime.storage.saveRouteFinder(value),
  cancel:(runId:string)=>runtime.cancelRouteChecks(runId),
  setOpen:(open:boolean)=>runtime.setRouteSheetOpen(open),
 }),[runtime]);
}

export type SiteDraft = {urls:string[]; base:string[]; saving?:boolean; error?:string};
type DraftState = [SiteDraft|null, Dispatch<SetStateAction<SiteDraft|null>>];
const RouteSiteDraftContext=createContext<DraftState|null>(null);

/** Mounted by the session-keyed application above both Main and Routing. */
export function RouteSiteDraftProvider({children}:{children:ReactNode}){
 const state=useState<SiteDraft|null>(null);
 return <RouteSiteDraftContext.Provider value={state}>{children}</RouteSiteDraftContext.Provider>;
}
export function useRouteSiteDraft(){
 const state=useContext(RouteSiteDraftContext);
 if(!state)throw new Error('RouteSiteDraftProvider is missing');
 return state;
}
