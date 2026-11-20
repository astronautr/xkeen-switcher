import {expect} from '@playwright/test';
import context from '../fixtures/devices-undo-context.json' with {type:'json'};
import {type ScenarioEngine} from './scenario';
export const changedDeviceId='02:00:00:00:00:21';
export function undoScenario(s:ScenarioEngine){
 s.state.devices=structuredClone(context.initial);let operationId=context.changed.operation.id;
 s.on('POST','/api/devices/change',r=>{
  const d=s.state.devices.devices.find((d:any)=>d.id===changedDeviceId);
  expect(r.body.changes).toEqual([{id:changedDeviceId,revision:d.revision,values:{registered:false}}]);
  expect(r.body.operation_id).toMatch(/^[0-9a-f-]{36}$/);operationId=r.body.operation_id;
  s.state.devices=structuredClone(context.changed);s.state.devices.operation.id=operationId;
  s.state.devices.operations.forEach((o:any)=>{o.id=operationId});return {body:s.state.devices};
 });
 s.on('POST','/api/devices/undo',r=>{
  expect(r.body).toEqual({operation_id:operationId});s.state.devices=structuredClone(context.undone);
  s.state.devices.operations.forEach((o:any)=>{o.id=operationId});return {body:s.state.devices};
 });return s;
}
export function interruptedScenario(s:ScenarioEngine){
 undoScenario(s);s.state.devices=structuredClone(context.changed);
 s.state.devices.operations[0].phase='uncertain';s.state.devices.operations[0].message='Device change result is uncertain';
 return context.changed.operation.id;
}
