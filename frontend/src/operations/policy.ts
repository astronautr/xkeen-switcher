import type {EventDto,OperationDto} from '../api/types';
export const TERMINAL = ['committed','rolled_back','rejected'];
export const terminal = (op:OperationDto|null|undefined):boolean => !!op && TERMINAL.includes(op.phase);
export const unresolved = (op:OperationDto|null|undefined):boolean => !!op && ['unknown','recovery_failed'].includes(op.phase);
export const blocking = (op:OperationDto|null|undefined):boolean => !!op && !terminal(op) && op.blocking!==false;
export const PHASES:Record<string,string> = {preparing:'Preparing',accepted:'Preparing',queued:'Preparing',prepared:'Backup saved',refreshing:'Refreshing subscription',refresh:'Refreshing subscription',validating:'Validating configuration',submitted:'Sending to the router',applying:'Sending to the router',installing:'Installing configuration',installed:'Restarting XKeen',restarting:'Restarting XKeen',verifying:'Checking startup',confirming:'Confirming result',confirmation:'Confirming result',reconciling:'Confirming result',finishing:'Confirming result',rolling_back:'Restoring the previous version',boot_restored:'File restored, checking startup',recovering:'Recovering configuration',checking:'Checking',unknown:'Result not confirmed yet',recovery_failed:'Recovery needs attention',committed:'Applied',rolled_back:'Previous version restored',rejected:'Not applied'};
const ACTIONS:Record<string,string>={"router-update":"Updating router software",main:'Switching Main',switch:'Switching Main',apply_failover:'Failover switch',apply_pending_reapply:'Applying configuration update',apply_pending_reapply_now:'Applying configuration update',recover_pending_active:'Recovering Main configuration',handle_total_failure:'Stopping XKeen',xkeen_control:'Changing XKeen state',update:'Refreshing subscription',set_subscription_url:'Saving subscription',routing:'Applying routing','device-location':'Changing device location',device:'Updating device settings',sync:'Reading Main route',probe:'Checking locations',route_check:'Checking route',route_checks:'Checking routes',failover_check:'Checking failover locations',recovery:'Finding a working location',read:'Reading from the router',router:'Router operation'};
export const phaseLabel=(phase:string)=>PHASES[phase]??'In progress';
const committedLabels: Record<string, string> = {
 main: "Main switched",
 "device-location": "Device location applied",
 device: "Device settings applied",
};
export function journalLabel(op: Pick<OperationDto, "kind" | "phase">) {
 return op.phase === "committed" ? committedLabels[op.kind ?? ""] ?? "Routing applied" : phaseLabel(op.phase);
}
export function operationTarget(op: OperationDto) {
 const route = op.target_route;
 const exit = route?.exit_name || op.target_name || route?.exit_code || op.target_code;
 const entry = route?.entry_name || route?.entry_code || op.target_entry_code;
 if (entry && exit) return entry + ' → ' + exit;
 return exit || (typeof op.target === 'string' ? op.target : null);
}
export const actionLabel=(operation:OperationDto) => operation.kind==='route_checks' ? (operation.route_check_kind==='single'?'checking locations':'checking chains') : ACTIONS[operation.kind??'']??(operation.ephemeral?'Router operation':'Configuration change');
export const operationSource=(op:OperationDto)=>op.source??(op.trigger==='failover'?'failover':['auto-reapply','cron'].includes(op.trigger??'')?'scheduler':'manual');
export const ownOperation=(op:OperationDto,ids:string[])=>!!(op.local||op.id&&ids.includes(op.id)||op.request_id&&ids.includes(op.request_id));
export const sourceLabel=(op:OperationDto,ids:string[]=[])=>ownOperation(op,ids)?'This browser':({failover:'Failover',scheduler:'Scheduled update',startup:'Server startup'} as Record<string,string>)[operationSource(op)]??'Router';
export const scopeLabel=(op:OperationDto)=>op.kind==='route_checks'?'Switching stays available. Checks use an isolated process on the router.':op.scope==='read'?'Changes wait until the read finishes.':op.scope==='diagnostic'?'Switching, power and config updates wait for this check.':'Switching, power and config updates are paused until the result is confirmed.';
export function activityPresentation(op:OperationDto|null|undefined,ids:string[]=[]){
 if(!op||terminal(op))return {key:null,active:false,attention:false,delay:0,label:'No active operations',description:'No router operation is in progress.'};
 const attention=unresolved(op);return {key:op.id||op.request_id||[op.kind||'router',operationSource(op),op.created_at||''].join('|'),active:true,attention,
 delay:attention||op.kind==='route_checks'?0:ownOperation(op,ids)?3000:['read','sync','probe','route_check','failover_check','update'].includes(op.kind??'')?1000:0,
 label:actionLabel(op),description:phaseLabel(op.phase)+'.'+(op.blocking!==false?' '+scopeLabel(op):'')};
}
export function eventNeedsAttention(entry: Partial<EventDto> | null | undefined) {
 if (!entry) return false;
 const action = entry.action ?? '';
 if (['read', 'sync', 'probe', 'route_check', 'failover_check', 'route-check', 'failover-check'].includes(action)) return false;
 return ['total-failure-stop', 'route-lost', 'route-loss'].includes(action)
  || (action === 'update' && /^active .*vanished from subscription$/.test(entry.message ?? ''))
  || ['unknown', 'recovery_failed', 'rolled_back', 'rejected'].includes(entry.routing_phase ?? '')
  || ['fail', 'error', 'unknown', 'recovery_failed'].includes(entry.result ?? '');
}
export function elapsedSince(operation:OperationDto|null,now=Date.now()){const created=operation?.created_at?Date.parse(operation.created_at):NaN;return Number.isFinite(created)?Math.max(0,now-created):null;}
