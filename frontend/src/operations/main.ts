import type {SessionRuntime} from './runtime';
import {ApiError,StaleSessionError,classifyError} from '../api/client';
import {operationDto,type MainIntent,type MainRoute,type OperationDto,type StatusDto} from '../api/types';
import {keys} from '../api/keys';
import {errorMessage} from '../ui/format';
export class MainController {
 intent:MainIntent|null=null;private submitting=new Set<string>();
 constructor(private runtime:SessionRuntime){}
 restore(){const saved=this.runtime.storage.readMainIntent();if(saved&&!this.runtime.isFinished(saved.id)){this.intent=saved;this.observeIntent(saved);}}
 reset(){this.intent=null;this.submitting.clear();}
 recordConflict(id:string){if(this.intent){this.intent={...this.intent,conflicting_id:id};this.runtime.storage.saveMainIntent(this.intent);}}
 private observeIntent(intent: MainIntent, phase: 'unknown' | 'preparing' = 'unknown') {
  this.runtime.observe({
   id: intent.id, kind: 'main', source: 'manual', phase, blocking: true,
   local: this.runtime.storage.ownIds().includes(intent.id), created_at: intent.created_at,
   target_code: intent.code, target_entry_code: intent.entry_code, target_name: intent.name,
   target_route: {
    mode: intent.mode, exit_code: intent.code, exit_name: intent.name || intent.code,
    entry_code: intent.entry_code, entry_name: intent.entry_name || intent.entry_code,
   },
   message: phase === 'preparing' ? 'Submitting the Main location change.' : 'Checking whether the switch was accepted. The same request will be used if it needs retrying.',
  });
 }
 complete(id:string){if(this.intent?.id===id)this.intent=null;this.runtime.storage.clearMainIntent(id);}
 switchTo(route:MainRoute){
  const rt=this.runtime;if(!rt.authenticated||!route.code||route.code===route.entry_code||rt.view().blocking)return;
  const shared=rt.storage.readMainIntent();if(shared&&!rt.isFinished(shared.id)){this.intent=shared;this.observeIntent(shared);return;}
  const status=rt.queryClient.getQueryData<StatusDto>(keys.status);if(!status||status.active_code===route.code&&(status.active_entry_code??null)===route.entry_code)return;
  const exit=status.available.find(loc=>loc.code===route.code),entry=status.available.find(loc=>loc.code===route.entry_code);if(!exit||route.entry_code&&!entry)return;
  const intent:MainIntent={...route,id:rt.newId(),mode:route.entry_code?'chain':'single',created_at:new Date(rt.now()).toISOString(),name:exit.name,...(entry?{entry_name:entry.name}:{})};
  this.intent=intent;rt.storage.saveMainIntent(intent);rt.markOwn(intent.id);rt.setRefusal(null);this.observeIntent(intent, 'preparing');void this.submit(intent);
  return intent.id;
 }
 notFound(id:string){if(this.intent?.id!==id)return;const intent=this.intent;if(intent.conflicting_id){this.complete(id);this.runtime.clearActive(id);if(this.runtime.storage.consumeOwn(id))this.runtime.notify('Switch was not accepted while another operation was running. Choose a location again when it finishes.',true);void this.runtime.refreshStatus();return;}void this.submit(intent);}
 private async submit(intent:MainIntent){
  if(this.submitting.has(intent.id))return;this.submitting.add(intent.id);const rt=this.runtime,epoch=rt.api.epoch;
  const key = keys.operation(intent.id);
  const atSubmission = rt.queryClient.getQueryData<OperationDto>(key);
  try {
   const body = await rt.mutate('/api/switch', {code:intent.code,operation_id:intent.id,...(intent.entry_code?{entry_code:intent.entry_code}:{}),...(intent.route_check_id?{route_check_id:intent.route_check_id}:{})});
   rt.api.assertCurrent(epoch);
   const op = operationDto(body, intent.id);
   const current = rt.queryClient.getQueryData<OperationDto>(key);
   // A delayed acceptance describes the initial phase. Keep progress observed while it was pending.
   if (op.phase === 'accepted' && current && current !== atSubmission &&
       current.phase !== 'preparing' && current.phase !== 'accepted') return;
   await rt.observe(op, 'response');
  }
  catch(error){if(epoch!==rt.api.epoch||error instanceof StaleSessionError||rt.isFinished(intent.id))return;
   if (error instanceof ApiError && !error.acceptanceUnknown) {
    this.complete(intent.id);
    rt.clearActive(intent.id);
    const kind = classifyError(error);
    const message = error.code === 'stale_check' ? error.message : errorMessage(error);
    rt.setRefusal({
     kind, message, blocker: error.operation, at: new Date(rt.now()).toISOString(),
     route: {
      mode: intent.mode, exit_code: intent.code, exit_name: intent.name ?? intent.code,
      entry_code: intent.entry_code, entry_name: intent.entry_name ?? intent.entry_code,
     },
    });
    if (error.operation) rt.observe(error.operation);
    if (rt.storage.consumeOwn(intent.id)) {
     const prefix = kind === 'busy' ? 'Switch not accepted · router busy' : 'Switch was not accepted';
     rt.notify(prefix + ': ' + message, true);
    }
    void rt.refreshStatus();
   }
   else if (this.intent?.id === intent.id) {
    // The journal or status already reported this UUID after submission. A lost reply cannot
    // describe that request better, so keep the observed phase and its recovery metadata.
    if (rt.queryClient.getQueryData<OperationDto>(key) !== atSubmission) return;
    const active = rt.operation();
    if (!active || active.id === intent.id) this.observeIntent(this.intent);
   }
  }finally{if(epoch===rt.api.epoch)this.submitting.delete(intent.id);}
 }
}
