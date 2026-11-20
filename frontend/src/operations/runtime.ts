import {QueryClient,type QueryKey} from '@tanstack/react-query';
import {ApiClient,ApiError,StaleSessionError,type RequestOptions} from '../api/client';
import {keys} from '../api/keys';
import {isRecord,operationDto,validId,type SessionDto,type StatusDto,type OperationDto,type MainIntent,type EventDto,type DevicesDto,type RouteDto,type PairingDto,type OkDto,type RouteCheckKind,type RouteCheckRunDto,type RouteCheckStart,type RouteChecksDto} from '../api/types';
import {BrowserStorage,newOperationId,type Notification} from '../browser/storage';
import {blocking,terminal,unresolved,ownOperation,activityPresentation,operationTarget} from './policy';
import {EventFeed,attentionFromEvents,attentionKey} from './events';
import {MainController} from './main';
import {RoutingController} from './routing';
export type Refusal={kind:string;message:string;blocker?:OperationDto;route?:RouteDto;at:string};
export type OperationView={operation:OperationDto|null;requested:MainIntent|null;confirmed:RouteDto|null;blocking:boolean;blockReason:string|null;local:boolean;durable:boolean;ephemeral:boolean;terminal:boolean;unresolved:boolean;refusal:Refusal|null;activity:ReturnType<typeof activityPresentation>};
export type RuntimeOptions={api?:ApiClient;storage?:BrowserStorage;newId?:()=>string;now?:()=>number};
type StatusReadSource = 'explicit' | 'poll' | 'readback' | 'mutation';
const EPHEMERAL=['operation','ephemeral'] as const;
const DEVICES_POLL_MS = 30_000;
/** Activity follows a running route check while its sheet is closed. */
const ROUTE_CHECKS_POLL_MS = 2_000;
export class SessionRuntime {
 readonly api:ApiClient;readonly storage:BrowserStorage;readonly queryClient:QueryClient;readonly main:MainController;readonly routing:RoutingController;
 readonly newId:()=>string;readonly now:()=>number;
 private pendingPublications: Notification[] = [];
 private publicationListeners = new Set<(item: Notification) => void>();
 subscribePublished = (listener: (item: Notification) => void) => {
  this.publicationListeners.add(listener);
  for (const item of this.pendingPublications.splice(0)) listener(item);
  return () => { this.publicationListeners.delete(listener); };
 };
 private listeners=new Set<()=>void>();private revision=0;private activeId:string|null=null;private ephemeral=false;
 private finished=new Set<string>();private tokens=new Set<symbol>();private feed:EventFeed;private retained:EventDto[]=[];private announced:EventDto[]=[];
 private inbox:Notification[];private refusal:Refusal|null=null;private statusSequence=0;private journalReads=new Map<string,Promise<void>>();
 private mounts=0;private running=false;private bootPromise:Promise<void>|null=null;private statusTimer:ReturnType<typeof setTimeout>|null=null;private journalTimer:ReturnType<typeof setTimeout>|null=null;
 private pairOpen = false;
 private statusReadSource: StatusReadSource | null = null;
 private activeAttention: Record<string, EventDto> = {};
 private unreadAttention: Record<string, EventDto> = {};
 private pairCreationSequence=0;private pairId:string|null=null;private pairTimer:ReturnType<typeof setTimeout>|null=null;
 private devicesEligible:()=>boolean=()=>false;private routingEligible:()=>boolean=()=>false;
 private lastDevicesPoll: number | null = null;
 private lastRouting=0;private localActivity=new Map<symbol,OperationDto>();
 private routeSheetOpen=false;private ownRouteRuns=new Set<string>();private routeTimer:ReturnType<typeof setTimeout>|null=null;
 constructor(options:RuntimeOptions={}){
  this.api=options.api??new ApiClient();this.storage=options.storage??new BrowserStorage();this.newId=options.newId??newOperationId;this.now=options.now??Date.now;
  this.queryClient=new QueryClient({defaultOptions:{queries:{retry:false,networkMode:'always',refetchOnReconnect:false,refetchOnWindowFocus:false,gcTime:Infinity},mutations:{retry:false,networkMode:'always'}}});
  this.queryClient.getQueryCache().subscribe(event=>{if(event.type==='updated'||event.type==='removed')this.emit();});this.feed=new EventFeed(this.storage.local);this.inbox=this.storage.notifications();
  this.main=new MainController(this);this.routing=new RoutingController(this);
  this.api.onUnauthorized=()=>this.signedOut();this.api.onEventIds=ids=>{ids.forEach(id=>this.feed.markSeen(id));this.rememberOwnEvents(ids);};
  this.api.onMutationStart=token=>{this.tokens.add(token);this.emit();};this.api.onMutationEnd=token=>{this.tokens.delete(token);this.drainEvents();this.emit();};
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
 snapshot=()=>this.revision;
 emit(){this.revision++;for(const listener of this.listeners)listener();}
 get authenticated(){return this.queryClient.getQueryData<SessionDto>(keys.session)?.authenticated===true;}
 get intent(){return this.main.intent;}
 notifications(){return this.inbox;}
 eventAnnouncements(){return this.announced;}
 pendingMutations(){return this.tokens.size;}
 attention(){return this.unreadAttention;}
 /** Event and operation IDs caused by this browser; the activity feed shows their local notification instead. */
 ownEvents(){return this.storage.readOwnEvents();}
 private rememberOwnEvents(ids:string[]){const fresh=ids.filter(Boolean);if(!fresh.length)return;const known=this.storage.readOwnEvents();const next=[...known.filter(id=>!fresh.includes(id)),...fresh];if(next.length!==known.length||fresh.some(id=>!known.includes(id)))this.storage.saveOwnEvents(next);}
 /** Hides the current background failures in this browser until a different failure arrives. */
 acknowledgeAttention(){const keys=Object.values(this.activeAttention).map(attentionKey);if(!keys.length)return;const read=this.storage.readAttention().filter(key=>!keys.includes(key));this.storage.saveAttention([...read,...keys]);this.refreshAttention();this.emit();}
 private refreshAttention(){const read=new Set(this.storage.readAttention());this.unreadAttention=Object.fromEntries(Object.entries(this.activeAttention).filter(([,entry])=>!read.has(attentionKey(entry))));}
 private pendingDeviceOperations(): string[] {
  // A new status holder may replace the visible operation before our journal finishes.
  return this.storage.ownIds().filter(id => {
   const op = this.queryClient.getQueryData<OperationDto>(keys.operation(id));
   return op?.kind === 'device-location' && !terminal(op);
  });
 }
 operation(): OperationDto | null {
  const op = this.ephemeral
   ? this.queryClient.getQueryData<OperationDto>(EPHEMERAL)
   : this.activeId ? this.queryClient.getQueryData<OperationDto>(keys.operation(this.activeId)) : null;
  if (blocking(op)) return op!;
  // A completed foreign holder does not confirm our outstanding request.
  // Read its existing journal cache instead of treating idle status as success.
  const pendingIds = [this.intent?.id, this.storage.readRoutingPending()?.operation_id, ...this.pendingDeviceOperations()];
  for (const id of pendingIds) {
   if (!id) continue;
   const pending = this.queryClient.getQueryData<OperationDto>(keys.operation(id));
   if (blocking(pending)) return pending!;
  }
  return [...this.localActivity.values()].at(-1) ?? op ?? null;
 }
 view():OperationView {const op=this.operation();return {operation:op,requested:this.intent,confirmed:this.queryClient.getQueryData<StatusDto>(keys.status)?.active_route??null,
  blocking:blocking(op),blockReason:blocking(op)?op?.block_reason??op?.message??'Waiting for router confirmation':null,local:!!op&&ownOperation(op,this.storage.ownIds()),durable:!!op?.id,ephemeral:op?.ephemeral===true,terminal:terminal(op),unresolved:unresolved(op),refusal:this.refusal,activity:activityPresentation(op,this.storage.ownIds())};}
 notify(message: string, error = false, metadata?: Pick<Notification, 'device_operation'>) {
  const item: Notification = {message, error, at: new Date(this.now()).toISOString()};
  if (metadata?.device_operation) item.device_operation = metadata.device_operation;
  this.inbox = [item, ...this.inbox].slice(0, 100);
  this.storage.saveNotifications(this.inbox);
  if (this.publicationListeners.size) {
   for (const listener of this.publicationListeners) listener(item);
  } else {
   this.pendingPublications = [...this.pendingPublications, item].slice(-100);
  }
  this.emit();
 }
 clearNotifications(){this.inbox=[];this.storage.saveNotifications([]);this.emit();}
 acceptEvents(events: EventDto[]) {
  this.retained = events;
  this.activeAttention = attentionFromEvents(events, this.queryClient.getQueryData<StatusDto>(keys.status), this.activeAttention);
  this.refreshAttention();
  this.drainEvents();
  this.emit();
 }
 private drainEvents(){if(this.tokens.size)return;this.announced=this.feed.take(this.retained);}
 markOwn(id:string){this.storage.markOwn(id);this.feed.expectOwn(id);this.rememberOwnEvents([id]);}
 isFinished(id:string){return this.finished.has(id)||terminal(this.queryClient.getQueryData(keys.operation(id)));}
 clearActive(id:string){if(this.activeId===id){this.activeId=null;this.ephemeral=false;}this.emit();}
 setRefusal(value:Refusal|null){this.refusal=value;this.emit();}
 observe(input:OperationDto, source: 'status' | 'journal' | 'response' = 'status'){
  const op=operationDto(input);
  if (op.ephemeral) {
   if (this.intent && !this.intent.conflicting_id && op.request_id !== this.intent.id) {
    this.main.recordConflict('server-activity');
   }
   this.queryClient.setQueryData(EPHEMERAL, op);
   // The temporary holder may disappear before durable confirmation arrives.
   // Retain the journal identity underneath it until that journal is terminal.
   this.ephemeral = true;
   this.emit();
   this.scheduleJournal();
   return;
  }
  const id=op.id!;if(this.isFinished(id)&&!terminal(op))return;
  if(!terminal(op)&&this.intent&&this.intent.id!==id&&!this.intent.conflicting_id)this.main.recordConflict(id);
  const previous = this.operation();
  const displacedDevice = source === 'journal' && op.kind === 'device-location' && this.storage.ownIds().includes(id);
  const keepHolder = blocking(previous) && previous?.id !== id && (terminal(op) || displacedDevice);
  this.queryClient.setQueryData(keys.operation(id), op);
  if (!keepHolder) {
   this.activeId = id;
   this.ephemeral = false;
  }
  const firstTerminal = terminal(op) && !this.finished.has(id);
  if(terminal(op)){
   this.main.complete(id);this.routing.complete(id);
   if(firstTerminal){
    this.finished.add(id);if(this.storage.consumeOwn(id)){
     this.feed.markSeen(id);
     this.notifyOperationResult(op, id);
    }
   }
   this.invalidate([keys.devices,keys.routing,keys.history]);
  }
  this.emit();this.scheduleJournal();
  if (firstTerminal && source !== 'status') return this.refreshStatus('readback');
 }
 private notifyOperationResult(op: OperationDto, id: string) {
  if (op.phase !== 'committed') {
   const message = op.phase === 'rolled_back'
    ? 'Change rolled back. The previous configuration was restored.'
    : 'Change was not applied: ' + (op.message || 'request rejected');
   this.notify(message, true);
   return;
  }
  const warning = op.warning ? ' · ' + op.warning : '';
  if (op.kind === 'device-location') {
   const undo = isRecord(op.device_request) && Boolean(op.device_request.undo);
   const message = undo ? 'Device location change undone' : 'Device location applied';
   this.notify(message + warning, false, undo || op.noop ? undefined : {device_operation: id});
   return;
  }
  const target = operationTarget(op);
  const message = op.kind === 'routing' ? 'Routing configuration applied'
   : target ? 'Main switched to ' + target : 'Operation completed';
  this.notify(message + warning);
 }
 restoreTracking(){this.main.restore();this.routing.restore();}
 /** The newest route-check run the server reported, in status or in the sheet's own reads. */
 routeCheckRun():RouteCheckRunDto|null{return this.queryClient.getQueryData<StatusDto>(keys.status)?.route_check_run??null;}
 /** A running check is a non-blocking diagnostic: it never pauses switching or other mutations. */
 routeCheckActivity():OperationDto|null{
  const run=this.routeCheckRun();
  if(!run||run.state!=='running'||this.routeSheetOpen)return null;
  return {id:null,ephemeral:true,blocking:false,kind:'route_checks',phase:'checking',source:'manual',scope:'diagnostic',
   route_check_kind:run.kind,request_id:run.id,local:this.ownRouteRuns.has(run.id),target_code:run.exit_code,target_name:run.exit_name,created_at:run.created_at,
   message:`${run.done} of ${run.total} routes checked`,progress:{done:run.done,total:run.total}};
 }
 setRouteSheetOpen(open:boolean){if(this.routeSheetOpen===open)return;this.routeSheetOpen=open;this.emit();this.scheduleRouteChecks();}
 async readRouteChecks(kind:RouteCheckKind,exit:string|null,signal?:AbortSignal):Promise<RouteChecksDto>{
  const epoch=this.api.epoch;
  const params=new URLSearchParams({kind});
  if(kind==='chain' && exit)params.set('exit',exit);
  const view=await this.api.requestJson<RouteChecksDto>('/api/route-checks?'+params,{signal});
  this.api.assertCurrent(epoch);
  this.trackRouteChecks(view);
  return view;
 }
 private async cacheRouteResponse(view:RouteChecksDto,epoch:number){
  this.api.assertCurrent(epoch);
  const queryKey=keys.routeChecks(view.kind,view.exit_code);
  await this.queryClient.cancelQueries({queryKey,exact:true});
  this.api.assertCurrent(epoch);
  this.queryClient.setQueryData(queryKey,view);
  this.trackRouteChecks(view);
  return view;
 }
 async startRouteChecks(input:RouteCheckStart):Promise<RouteChecksDto>{
  const epoch=this.api.epoch,id=this.newId();
  this.ownRouteRuns.add(id);
  try{
   const view=await this.mutate<RouteChecksDto>('/api/route-checks',{...input,run_id:id});
   return await this.cacheRouteResponse(view,epoch);
  }catch(error){
   if(!(error instanceof ApiError && error.acceptanceUnknown))this.ownRouteRuns.delete(id);
   if(error instanceof ApiError && error.code==='stale_conditions')this.invalidate([keys.connectivity,keys.allRouteChecks]);
   throw error;
  }
 }
 /** Old tabs can start a legacy run. Its cancel response has no v2 view. */
 async cancelRouteChecks(runId:string):Promise<RouteChecksDto>{
  const epoch=this.api.epoch;
  const view=await this.mutate<RouteChecksDto>('/api/route-checks/cancel',{run_id:runId});
  this.api.assertCurrent(epoch);
  if(!view.kind)return this.readRouteChecks('chain',view.exit_code ?? null);
  return this.cacheRouteResponse(view,epoch);
 }
 private latestRouteRun(observed:RouteCheckRunDto|null|undefined){
  const current=this.routeCheckRun();
  if(!current||!observed)return observed;
  if(observed.id!==current.id)return observed.created_at<current.created_at?current:observed;
  if(observed.state==='running'&&(current.state!=='running'||observed.done<current.done))return current;
  return observed;
 }
 /** Sheet reads also advance Activity, so completion is noticed without another status read. */
 private trackRouteChecks(view:RouteChecksDto){
  const run=view.active_run??view.run;
  if(run){
   const status=this.queryClient.getQueryData<StatusDto>(keys.status);
   const latest=this.latestRouteRun(run);
   if(status&&status.route_check_run!==latest)this.queryClient.setQueryData(keys.status,{...status,route_check_run:latest});
   this.trackRouteRun(latest);
  }
 }
 private trackRouteRun(run:RouteCheckRunDto|null|undefined){
  if(!run)return;
  if(run.state!=='running'&&this.ownRouteRuns.delete(run.id)){
   const label=run.kind==='single'?'Location checks':'Chain checks';
   const state=run.state==='cancelled'?'stopped':run.state==='interrupted'?'interrupted':'complete';
   const parts=[label+' '+state];
   if(run.kind==='chain' && run.exit_name)parts.push(run.exit_name);
   if(run.state==='completed')parts.push(run.working ? run.working+' working' : 'No working route confirmed');
   this.notify(parts.join(' · '),run.state==='interrupted');
  }
  this.scheduleRouteChecks();
 }
 private scheduleRouteChecks(){
  const run=this.routeCheckRun();
  if(this.routeTimer||!this.running||!this.visible()||!this.authenticated||this.routeSheetOpen||run?.state!=='running')return;
  this.routeTimer=setTimeout(()=>{this.routeTimer=null;void this.refreshStatus('poll').finally(()=>this.scheduleRouteChecks());},ROUTE_CHECKS_POLL_MS);
 }
 async readResponse<T>(path: string, signal?: AbortSignal): Promise<T> {
  // Inventory reads hold the router coordinator too. Keep this inside the
  // deduplicated query function, shared by initial reads, polls and readback.
  const finish = path === '/api/devices'
   ? this.beginActivity('read', 'Reading router devices', {local: false, scope: 'read'})
   : () => {};
  try {
   return await this.api.requestJson<T>(path, {signal});
  } finally {
   finish();
  }
 }
 async read<T>(key: QueryKey, path: string): Promise<T> {
  return this.queryClient.fetchQuery<T, ApiError>({
   queryKey: key,
   queryFn: ({signal}) => this.readResponse<T>(path, signal),
   staleTime: 0,
  });
 }
 async refreshStatus(source: StatusReadSource = 'explicit'): Promise<void> {
  const epoch = this.api.epoch;
  const filter = {queryKey: keys.status, exact: true};
  const fetching = this.queryClient.isFetching(filter) > 0;
  const pending = fetching ? this.statusReadSource : null;
  if (source === 'poll' && pending === 'mutation') return;
  const replace = fetching && (source !== 'explicit' || pending === 'poll');
  if (replace) {
   // An action waiting for readback must follow the replacement promise. A cancelled
   // background poll can finish immediately; its sequence cannot publish stale data.
   void this.queryClient.cancelQueries(filter, {silent: pending === 'mutation', revert: true});
  }
  const previousStatus=this.queryClient.getQueryData<StatusDto>(keys.status);
  const sequence = ++this.statusSequence;
  this.statusReadSource = pending === 'mutation' ? 'mutation' : !replace && pending ? pending : source;
  try {
   const dto = await this.queryClient.fetchQuery<StatusDto, ApiError>({
    queryKey: keys.status,
    queryFn: async ({signal}) => {
     const routeAtRead = this.routeCheckRun();
     const data = await this.api.requestJson<StatusDto>('/api/status', {signal});
     if (data.operation) operationDto(data.operation);
     const routeNow = this.routeCheckRun();
     if (data.route_check_run || routeNow !== routeAtRead) {
      data.route_check_run = this.latestRouteRun(data.route_check_run ?? routeNow);
     }
     return data;
    },
    staleTime: 0,
   });
   this.api.assertCurrent(epoch);
   if (sequence !== this.statusSequence) return;
   this.acceptEvents(dto.events ?? dto.history);
   this.trackRouteRun(dto.route_check_run);
   // A closed finder has no interval, but its Single summary follows other browsers.
   if(previousStatus && previousStatus.route_check_conditions_hash !== dto.route_check_conditions_hash){
    this.invalidate([keys.connectivity,keys.allRouteChecks]);
   }else if(previousStatus && (previousStatus.last_update_at !== dto.last_update_at ||
      previousStatus.route_check_run?.id !== dto.route_check_run?.id ||
      previousStatus.route_check_run?.state !== dto.route_check_run?.state)){
    this.invalidate([keys.allRouteChecks]);
   }
   if (!this.intent) this.main.restore();
   if (dto.operation) {
    this.observe(dto.operation);
   } else if (this.ephemeral || terminal(this.operation())) {
    this.ephemeral = false;
    if (terminal(this.operation())) this.activeId = null;
    this.emit();
   }
  } catch (error) {
   if (epoch !== this.api.epoch || error instanceof StaleSessionError) return;
   // Query retains the last successful data and timestamp.
  } finally {
   if (sequence === this.statusSequence) this.statusReadSource = null;
  }
 }
 invalidate(queryKeys:readonly QueryKey[]){for(const key of queryKeys)void this.queryClient.invalidateQueries({queryKey:key,refetchType:'active'});}
 async refreshSubscription(): Promise<OkDto & Record<string, unknown>> {
  return this.mutate('/api/update', {}, 'POST', [keys.status, keys.failover, keys.devices], {reconcileStatus: true});
 }
 private async refreshStatusAfterMutation(epoch: number): Promise<void> {
  this.api.assertCurrent(epoch);
  await this.refreshStatus('mutation');
  this.api.assertCurrent(epoch);
 }
 async mutate<T = unknown>(
  path: string,
  body: unknown,
  method: RequestOptions['method'] = 'POST',
  invalidate: readonly QueryKey[] = [],
  options: {reconcileStatus?: boolean} = {},
 ): Promise<T> {
  const epoch = this.api.epoch;
  const activities: Record<string, [string, string]> = {
   '/api/update': ['update', 'Refreshing subscription'],
   '/api/sub-url': ['set_subscription_url', 'Saving subscription'],
   '/api/xkeen': ['xkeen_control', 'Changing XKeen state'],
   '/api/active-refresh': ['apply_pending_reapply_now', 'Applying configuration update'],
   '/api/route-check': ['route_check', 'Checking route'],
   '/api/probe': ['probe', 'Checking locations'],
   '/api/failover/check-now': ['failover_check', 'Checking failover locations'],
   '/api/devices/change': ['device', 'Updating device settings'],
   '/api/devices/undo': ['device', 'Restoring device settings'],
   '/api/devices/server': ['device', 'Saving server device'],
   '/api/devices/routing-settings': ['device', 'Saving routing setup'],
  };
  const activity = activities[path];
  const finish = activity ? this.beginActivity(...activity) : () => {};
  try {
   let result: T;
   try {
    result = await this.api.requestJson<T>(path, {method, body});
    this.api.assertCurrent(epoch);
   } catch (error) {
    this.api.assertCurrent(epoch);
    if (options.reconcileStatus) {
     if (error instanceof ApiError && error.operation) this.observe(error.operation);
     // A refused/lost synchronous action can still persist status or recovery
     // state. Reread it without retrying the mutation or replacing its error.
     await this.refreshStatusAfterMutation(epoch);
    }
    throw error;
   }
   this.invalidate(invalidate);
   if (options.reconcileStatus) {
    await this.refreshStatusAfterMutation(epoch);
   } else if (invalidate.some(key => key === keys.status)) {
    void this.refreshStatus('readback');
   }
   return result;
  } finally {
   finish();
  }
 }
 async undoDeviceChange(id: string): Promise<DevicesDto | {operation: OperationDto}> {
  const epoch = this.api.epoch;
  const result = await this.deviceMutation<DevicesDto | {operation: OperationDto}>(
   '/api/devices/undo', {operation_id: id},
  );
  this.api.assertCurrent(epoch);
  if ('configured' in result) return result;
  const operation = operationDto(result);
  if (!operation.id) throw new Error('Missing device undo operation ID');
  // Polling can finish the server-generated Undo ID before its POST acknowledges ownership.
  const observed = this.queryClient.getQueryData<OperationDto>(keys.operation(operation.id));
  if (observed && terminal(observed)) {
   this.feed.markSeen(operation.id);
   this.notifyOperationResult(observed, operation.id);
   return {operation: observed};
  }
  this.markOwn(operation.id);
  this.observe(operation);
  return {operation};
 }
 async deviceMutation<T = DevicesDto>(path: string, body: unknown, method: RequestOptions['method'] = 'POST'): Promise<T> {
  const epoch = this.api.epoch;
  try {
   const result = await this.mutate<T>(path, body, method, [keys.devices, keys.status]);
   this.api.assertCurrent(epoch);
   if (result && typeof result === 'object' && 'configured' in result) {
    this.queryClient.setQueryData(keys.devices, result);
   }
   return result;
  } catch (error) {
   this.api.assertCurrent(epoch);
   if (error instanceof StaleSessionError) throw error;
   if (error instanceof ApiError && error.acceptanceUnknown) {
    try {
     await this.read(keys.devices, '/api/devices');
    } catch {
     // Preserve the original uncertainty only within the same session.
    }
    this.api.assertCurrent(epoch);
   }
   throw error;
  }
 }
 async pollOperations():Promise<void>{
  if(!this.authenticated)return;
  const targets=new Set(this.pendingDeviceOperations());if(this.intent)targets.add(this.intent.id);const routing=this.storage.readRoutingPending();if(routing)targets.add(routing.operation_id);
  const op=this.operation();if(op?.id&&!terminal(op))targets.add(op.id);
  if(!targets.size){if(op?.ephemeral)await this.refreshStatus();return;}
  await Promise.all([...targets].map(id=>this.readOperation(id)));
 }
 async readOperation(id:string):Promise<void>{
  if(!validId(id))throw new ApiError('Invalid operation ID',{status:400,code:'invalid_request'});
  if(this.journalReads.has(id))return this.journalReads.get(id)!;
  const epoch=this.api.epoch;
  const promise=(async()=>{try{
   const op=await this.api.requestJson<unknown>('/api/routing/operations/'+encodeURIComponent(id));this.api.assertCurrent(epoch);const parsed=operationDto(op,id);await this.observe(parsed, 'journal');
  }catch(error){if(epoch!==this.api.epoch||error instanceof StaleSessionError||this.isFinished(id))return;
   if(error instanceof ApiError&&error.status===404){if(this.intent?.id===id){this.main.notFound(id);return;}if(this.storage.readRoutingPending()?.operation_id===id){this.routing.notFound(id);return;}}
   const current=this.queryClient.getQueryData<OperationDto>(keys.operation(id));if(current)this.observe({...current,phase:'unknown',message:'The result cannot be confirmed yet. Switching remains paused.'}, 'journal');
  }finally{if(epoch===this.api.epoch)this.journalReads.delete(id);}})();this.journalReads.set(id,promise);return promise;
 }
 beginActivity(kind: string, message: string, options: {local?: boolean; scope?: string} = {}) {
  const token = Symbol(kind);
  this.localActivity.set(token, {
   id: null, ephemeral: true, phase: 'preparing', kind, message,
   source: 'manual', scope: options.scope ?? 'router', local: options.local ?? true,
   created_at: new Date(this.now()).toISOString(),
  });
  const epoch = this.api.epoch;
  this.emit();
  return () => {
   if (epoch === this.api.epoch) {
    this.localActivity.delete(token);
    this.emit();
   }
  };
 }
 async bootstrap(){if(this.bootPromise)return this.bootPromise;const epoch=this.api.epoch;this.bootPromise=(async()=>{try{const session=await this.read<SessionDto>(keys.session,'/api/auth/session');this.api.assertCurrent(epoch);if(session.authenticated){this.restoreTracking();await this.refreshStatus();}}catch{/* Session query exposes its own error. */}finally{if(epoch===this.api.epoch){this.bootPromise=null;this.scheduleStatus();this.scheduleJournal();this.schedulePair();}}})();return this.bootPromise;}
 private async bootstrapReplacement(epoch: number) {
  this.api.assertCurrent(epoch);
  this.resetSession();
  const replacementEpoch = this.api.epoch;
  await this.bootstrap();
  this.api.assertCurrent(replacementEpoch);
  const session = this.queryClient.getQueryData<SessionDto>(keys.session);
  if (!session?.authenticated) throw new StaleSessionError();
  return session;
 }
 async authenticate(kind: 'login' | 'setup' | 'pair', body: {password: string} | {code: string}) {
  const epoch = this.api.epoch;
  await this.api.requestJson('/api/auth/' + kind, {method: 'POST', body, authAttempt: true});
  await this.bootstrapReplacement(epoch);
 }
 async changePassword(body: {current_password: string; password: string}) {
  const epoch = this.api.epoch;
  await this.mutate('/api/auth/password', body);
  return this.bootstrapReplacement(epoch);
 }
 async logout() {
  const epoch = this.api.epoch;
  const identity = this.queryClient.getQueryData<SessionDto>(keys.session)?.session_id;
  try {
   await this.mutate('/api/auth/logout', {});
  } catch (error) {
   this.api.assertCurrent(epoch);
   if (error instanceof ApiError && error.acceptanceUnknown) {
    // A lost reply can mean the cookie was revoked. Verify without replaying POST.
    const session = await this.api.requestJson<SessionDto>('/api/auth/session');
    this.api.assertCurrent(epoch);
    if (session.authenticated === false) {
     this.signedOut();
     return;
    }
    if (session.authenticated && session.session_id !== identity) {
     await this.bootstrapReplacement(epoch);
     throw new StaleSessionError();
    }
   }
   throw error;
  }
  this.api.assertCurrent(epoch);
  this.signedOut();
 }
 signedOut(){const configured=this.queryClient.getQueryData<SessionDto>(keys.session)?.configured??true;this.resetSession();this.queryClient.setQueryData(keys.session,{configured,authenticated:false,session_id:null});this.emit();}
 private resetSession(){this.pendingPublications = [];this.api.advanceGeneration();this.pairCreationSequence++;this.pairId=null;this.lastDevicesPoll=null;this.clearTimers();void this.queryClient.cancelQueries();this.queryClient.clear();this.storage.resetSession();this.main.reset();this.routing.reset();this.activeId=null;this.ephemeral=false;this.finished.clear();this.tokens.clear();this.localActivity.clear();this.ownRouteRuns.clear();this.routeSheetOpen=false;this.retained=[];this.announced=[];this.activeAttention={};this.unreadAttention={};this.statusReadSource=null;this.refusal=null;this.journalReads.clear();this.bootPromise=null;this.statusSequence++;this.emit();}
 start(){this.mounts++;if(!this.running){this.running=true;globalThis.document?.addEventListener('visibilitychange',this.visibility);queueMicrotask(()=>{if(this.running&&this.mounts>0)void this.bootstrap();});}return ()=>{this.mounts--;queueMicrotask(()=>{if(this.mounts===0){this.running=false;this.clearTimers();globalThis.document?.removeEventListener('visibilitychange',this.visibility);void this.queryClient.cancelQueries();}});};}
 private visible(){return !globalThis.document?.hidden;}
 private visibility=()=>{this.clearTimers();if(this.running&&this.visible()&&this.authenticated){this.scheduleStatus();void this.refreshStatus('poll');void this.pollOperations().finally(()=>this.scheduleJournal());void this.pollPair().finally(()=>this.schedulePair());}};
 private clearTimers(){if(this.statusTimer)clearTimeout(this.statusTimer);if(this.journalTimer)clearTimeout(this.journalTimer);if(this.pairTimer)clearTimeout(this.pairTimer);if(this.routeTimer)clearTimeout(this.routeTimer);this.statusTimer=this.journalTimer=this.pairTimer=this.routeTimer=null;}
 private scheduleStatus() {
  if (this.statusTimer || !this.running || !this.visible() || !this.authenticated) return;
  this.statusTimer = setTimeout(() => {
   this.statusTimer = null;
   this.scheduleStatus();
   void this.refreshStatus('poll');
   void this.secondaryPolls();
  }, 10_000);
 }
 private scheduleJournal(){if(this.journalTimer||!this.running||!this.visible()||!this.authenticated||(!this.intent&&!this.storage.readRoutingPending()&&!blocking(this.operation())))return;this.journalTimer=setTimeout(()=>{this.journalTimer=null;void this.pollOperations().finally(()=>this.scheduleJournal());},1500);}
 async createPairingCode() {
  const sequence = ++this.pairCreationSequence;
  const epoch = this.api.epoch;
  const code = await this.mutate<PairingDto>('/api/auth/pairing-code', {});
  this.api.assertCurrent(epoch);
  if (sequence !== this.pairCreationSequence) throw new StaleSessionError();
  this.queryClient.setQueryData(keys.pairing(code.id), code);
  return code;
 }
 setPairing(id: string | null, open = true) {
  const reopened = id !== null && this.pairId === id && !this.pairOpen && open;
  this.pairId = id;
  this.pairOpen = open;
  if (this.pairTimer) clearTimeout(this.pairTimer);
  this.pairTimer = null;
  if (reopened) void this.pollPair().finally(() => this.schedulePair());
  else this.schedulePair();
  return () => {
   if (this.pairId === id && id !== null) this.setPairing(null);
  };
 }
 private pairPending() {
  if (!this.pairId) return false;
  const code = this.queryClient.getQueryData<PairingDto>(keys.pairing(this.pairId));
  return !code || code.status === 'pending';
 }
 private async pollPair() {
  if (!this.pairPending() || !this.authenticated || !this.visible()) return;
  const id = this.pairId!;
  await this.read<PairingDto>(keys.pairing(id), '/api/auth/pairing-code?id=' + encodeURIComponent(id)).catch(() => {});
 }
 private schedulePair() {
  if (!this.pairOpen || this.pairTimer || !this.running || !this.visible() || !this.authenticated || !this.pairPending()) return;
  this.pairTimer = setTimeout(() => {
   this.pairTimer = null;
   void this.pollPair().finally(() => this.schedulePair());
  }, 2000);
 }
 setDevicesPolling(eligible:()=>boolean){this.devicesEligible=eligible;return ()=>{if(this.devicesEligible===eligible)this.devicesEligible=()=>false;};}
 setRoutingPolling(eligible:()=>boolean){this.routingEligible=eligible;return ()=>{if(this.routingEligible===eligible)this.routingEligible=()=>false;};}
 private async secondaryPolls() {
  if (!this.pairOpen) await this.pollPair();
  const now = this.now();
  const inventory = this.queryClient.getQueryState<DevicesDto>(keys.devices);
  // Query timestamps use Date.now(), including snapshots returned by mutations.
  const freshInventory = inventory?.data !== undefined && Date.now() - inventory.dataUpdatedAt < DEVICES_POLL_MS;
  const recentAttempt = this.lastDevicesPoll !== null && now - this.lastDevicesPoll < DEVICES_POLL_MS;
  if (this.devicesEligible() && !freshInventory && !recentAttempt) {
   this.lastDevicesPoll = now;
   await this.read(keys.devices, '/api/devices').catch(() => {});
  }
  if (this.routingEligible() && now - this.lastRouting >= 30000) {
   this.lastRouting = now;
   await this.read(keys.routing, '/api/routing').catch(() => {});
  }
 }
}
