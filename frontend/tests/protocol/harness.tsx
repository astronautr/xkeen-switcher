/** Test-only DOM consumer of public providers/hooks; never included in app/catalog builds. */
import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {onlineManager} from '@tanstack/react-query';
import {AppSessionProvider,useOperationTracking,useMainActions,useRoutingActions,useNotifications,useActivity} from '../../src/app/AppSessionProvider';
import {useSession,useStatus,useDevices,useDevicesPolling,usePairing} from '../../src/api/queries';
import {useChangeDevices,useLogout,useLogin,useDownloadSnapshot,useRefreshSubscription,useCreatePairingCode,useApplyPending,useXkeenControl,useProbeLocations,useCheckRoute} from '../../src/api/mutations';
import preview from '../fixtures/routing-preview.json';
import type {RoutingPreview} from '../../src/api/types';
if(new URLSearchParams(location.search).has('offline'))onlineManager.setOnline(false);
function Screen(){const status=useStatus(),{switchTo}=useMainActions();return <section data-marker="screen"><output data-marker="confirmed">{status.data?.active_code??'none'}</output><output data-marker="status-error">{status.error?.message??''}</output><output data-marker="updated-at">{status.dataUpdatedAt}</output><output data-marker="refresh-status">{status.data?.last_update_status}</output>
 <button data-marker="switch" onClick={()=>switchTo({code:'de',entry_code:null})}>Switch</button><button data-marker="chain" onClick={()=>switchTo({code:'de',entry_code:'se'})}>Chain</button><button data-marker="next" onClick={()=>switchTo({code:'se',entry_code:null})}>Next</button></section>;}
function Harness(){const [visible,setVisible]=useState(true),[error,setError]=useState(''),[blob,setBlob]=useState(''),[pair,setPair]=useState<string|null>(null),[devicesOpen,setDevicesOpen]=useState(false);const operation=useOperationTracking(),routing=useRoutingActions(),session=useSession(),notifications=useNotifications(),activity=useActivity();useDevicesPolling(devicesOpen);const devices=useDevices(devicesOpen),change=useChangeDevices(),logout=useLogout(),login=useLogin(),download=useDownloadSnapshot(),refresh=useRefreshSubscription(),applyPending=useApplyPending(),power=useXkeenControl(),probe=useProbeLocations(),checkRoute=useCheckRoute(),createPair=useCreatePairingCode(),pairing=usePairing(pair);
 const status = useStatus();
 const run=(promise:Promise<unknown>)=>{setError('');void promise.catch(e=>{if(e.name!=='StaleSessionError')setError(e.message);});};
 return <main><output data-marker="session">{session.data?.authenticated?'authenticated':'anonymous'}</output><output data-marker="operation">{JSON.stringify(operation)}</output><output data-marker="notifications">{JSON.stringify(notifications.items)}</output><output data-marker="pending">{activity.pendingMutations}</output><output data-marker="error">{error}</output><output data-marker="devices">{JSON.stringify(devices.data??null)}</output><output data-marker="blob">{blob}</output><output data-marker="pairing">{JSON.stringify(pairing.data??null)}</output>
 <button data-marker="navigate" onClick={()=>{location.hash=visible?'routing':'main';setVisible(!visible);}}>Navigate</button>{visible&&<Screen/>}
 <button data-marker="routing-apply" onClick={()=>run(routing.apply(preview as RoutingPreview))}>Apply routing</button><button data-marker="routing-retry" disabled={!routing.canRetry()} onClick={()=>run(routing.retry())}>Retry routing</button>
 <button data-marker="devices-open" onClick={()=>setDevicesOpen(true)}>Open devices</button><button data-marker="devices-refresh" onClick={()=>void devices.refetch()}>Refresh devices</button>
 <button data-marker="device-change" onClick={()=>run(change.mutateAsync({operation_id:'11111111-1111-4111-8111-111111111111',changes:[]}))}>Change device</button>
 <button data-marker="logout" onClick={()=>run(logout.mutateAsync())}>Logout</button><button data-marker="login" onClick={()=>run(login.mutateAsync({password:'synthetic'}))}>Login</button>
 <button data-marker="download" onClick={()=>run(download.mutateAsync({id:preview.id}).then(async b=>setBlob(await b.text())))}>Download</button>
 <button data-marker="apply-pending" onClick={()=>run(applyPending.mutateAsync({}))}>Apply pending</button><button data-marker="power-stop" onClick={()=>run(power.mutateAsync({action:'stop'}))}>Stop</button><button data-marker="probe" onClick={()=>run(probe.mutateAsync({}))}>Probe</button><button data-marker="route-check" onClick={()=>run(checkRoute.mutateAsync({}))}>Route check</button>
 <button data-marker="power-restart" onClick={() => run(power.mutateAsync({action: 'restart'}))}>Restart</button>
 <output data-marker="power-state">{status.data?.xkeen_state}</output>
 <button data-marker="refresh" onClick={()=>run(refresh.mutateAsync({}))}>Refresh</button><button data-marker="pair-create" onClick={()=>run(createPair.mutateAsync({}).then(code=>setPair(code.id)))}>Pair</button>
 </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><AppSessionProvider><Harness/></AppSessionProvider></StrictMode>);
