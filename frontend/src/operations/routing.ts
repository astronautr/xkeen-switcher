import type {SessionRuntime} from './runtime';
import {ApiError,StaleSessionError,classifyError} from '../api/client';
import {operationDto,type RoutingPending,type RoutingPreview} from '../api/types';
import {keys} from '../api/keys';
export class RoutingController {
 private missing=new Set<string>();private submitting=new Set<string>();
 constructor(private runtime:SessionRuntime){}
 reset(){this.missing.clear();this.submitting.clear();}
 restore(){const pending=this.runtime.storage.readRoutingPending();if(pending&&!this.runtime.isFinished(pending.operation_id))this.runtime.observe({id:pending.operation_id,kind:'routing',phase:'unknown',message:'Checking the saved routing request.'});}
 complete(id:string){this.missing.delete(id);this.runtime.storage.clearRoutingPending(id);}
 notFound(id:string){this.missing.add(id);this.runtime.observe({id,kind:'routing',phase:'unknown',not_received:true,message:'The server has not recorded this request. You can safely retry the same operation.'});}
 canRetry(){const saved=this.runtime.storage.readRoutingPending();return !!saved&&this.missing.has(saved.operation_id)&&!this.submitting.has(saved.operation_id);}
 async apply(preview:RoutingPreview){if(!preview.validated||!this.runtime.authenticated||this.runtime.view().blocking)throw new ApiError('Wait for the current operation',{status:409,code:'busy'});const pending={preview_id:preview.id,operation_id:this.runtime.newId()};this.runtime.storage.saveRoutingPending(pending);this.runtime.markOwn(pending.operation_id);this.runtime.observe({id:pending.operation_id,kind:'routing',phase:'preparing'});return this.submit(pending);}
 async retry(){const pending=this.runtime.storage.readRoutingPending();if(!pending||!this.canRetry())return;return this.submit(pending);}
 private async submit(pending:RoutingPending){
  const rt=this.runtime,epoch=rt.api.epoch,id=pending.operation_id;if(this.submitting.has(id))return;this.submitting.add(id);this.missing.delete(id);
  try{const result=await rt.mutate('/api/routing/apply',pending);rt.api.assertCurrent(epoch);const op=operationDto(result,id);void rt.observe(op,'response');return op;}
  catch(error){if(epoch!==rt.api.epoch||error instanceof StaleSessionError||rt.isFinished(id))return;
   if (error instanceof ApiError && !error.acceptanceUnknown) {
    rt.storage.consumeOwn(id);
    rt.observe({id, kind: 'routing', phase: 'rejected', message: error.message});
    rt.clearActive(id);
    rt.setRefusal({kind: classifyError(error), message: error.message, blocker: error.operation, at: new Date(rt.now()).toISOString()});
    if (error.operation) rt.observe(error.operation);
    throw error;
   }
   rt.observe({id,kind:'routing',phase:'unknown',message:'Connection lost. Checking this operation before allowing another change.'});
  }finally{if(epoch===rt.api.epoch){this.submitting.delete(id);rt.invalidate([keys.routing,keys.history]);rt.emit();}}
 }
}
