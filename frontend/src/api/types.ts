/** Wire types follow Python serializers. Open JSON objects preserve custom router data. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type SessionDto = { configured: boolean; authenticated: boolean; session_id: string | null };
export type RouteDto = { mode: 'single' | 'chain'; exit_code: string | null; exit_name: string | null; entry_code: string | null; entry_name: string | null };
/** route_check_id binds an Apply from route checks to the exact checked candidate. */
export type MainRoute = { code: string; entry_code: string | null; route_check_id?: string };
export type MainIntent = MainRoute & { id: string; created_at: string; mode: 'single' | 'chain'; name?: string; entry_name?: string; conflicting_id?: string };
/** phase is deliberately open: an unknown server phase never means success. */
export interface OperationDto {
 id: string | null; phase: string; ephemeral?: boolean; kind?: string; request_id?: string | null;
 blocking?: boolean; block_reason?: string; source?: string; scope?: string; trigger?: string;
 target_code?: string | null; target_name?: string | null; target_entry_code?: string | null;
 target_route?: RouteDto | null; confirmed_route?: RouteDto | null; created_at?: string; updated_at?: string;
 message?: string; warning?: string; local?: boolean; not_received?:boolean; [key: string]: unknown;
}
export interface EventDto { ts: string; action: string; result: string; event_id?: string; operation_id?: string; code?: string | null; message?: string; trigger?: string; routing_phase?: string; [key:string]: unknown }
export interface RouteResult { name:string; url: string; ok: boolean; status?: number | null; error?: string | null; latency_ms?: number | null; [key:string]: unknown }
export interface HealthDto { ok?: boolean | null; tcp_ok?: boolean | null; route_ok?: boolean | null; checked_at?: string | null; route_checked_at?: string | null; route_results?: RouteResult[]; fail_streak?: number; ok_streak?: number; last_ok_at?:string|null;last_fail_at?:string|null;last_latency_ms?:number|null;tcp_checked_at?:string|null;tcp_latency_ms?:number|null;latency_ms?: number | null; probe_method?: string; [key:string]: unknown }
export interface LocationDto {
 code: string; name: string; protocol: string; host: string; port: number;
 uuid: string; flow: string; network: string; security: string; sni: string; pbk: string; sid: string; spx: string; path: string; mode: string; host_hdr: string; fingerprint: string;
 outbound: JsonObject | null; health: HealthDto | null;
}
export interface ServerRouteDto {
 device_id: string | null; device_name: string | null; mode: string; code: string | null; main_code: string | null;
 follows_main: boolean; main_route: RouteDto; location: {code:string|null;name:string|null;host:string|null;port:number|null;protocol:string|null};
 identified: boolean; unavailable: boolean; key: string; check: JsonObject | null;
}
export type AutoUpdateInput = { enabled:boolean; mode:'daily'|'interval'; daily_time:string; interval_minutes:number; sni_daily:boolean };
export type AutoUpdateDto = AutoUpdateInput & { timezone:string; next_apply_at:string|null };
export type FailoverConfig = { enabled:boolean; auto_failback:boolean; auto_stop_on_total_failure:boolean; auto_restart_on_recovery:boolean; whitelist:string[] };
export type FailoverStatus = FailoverConfig & {suspended:boolean;suspension_reason:string|null;active:boolean;since:string|null;auto_stop_suspended_for_devices:boolean};
export interface StatusDto {
 router_updates?: { available: import("../features/router-updates/model").Offer[] };
 operation: OperationDto | null; active_code:string|null; active_entry_code:string|null; active_route:RouteDto; active_missing_codes:string[];
 active_health:HealthDto|null; server_route:ServerRouteDto; active_status:string|null; xkeen_state:string; xkeen_stop_cause:string|null;
 subscription_url:string|null; last_update_at:string|null; last_update_status:string|null; pending_reapply_code:string|null;
 pending_reapply_entry_code:string|null; pending_reapply_since:string|null; pending_update_kind:string|null;
 auto_update:AutoUpdateDto; failover:FailoverStatus; route_check_conditions_hash?:string; route_check_run?:RouteCheckRunDto|null; route_checks?:LegacyRouteCheckRunDto|null; health_updated_at:string|null; available:LocationDto[]; history:EventDto[]; events:EventDto[];
}
export type HealthDocument = {schema_version:number;updated_at:string|null;next_probe_at?:string|null;map:Record<string,HealthDto>};
export type FailoverDto = {config:FailoverConfig & {schema_version:number};runtime:HealthDocument;env_constants:Record<string,number>;suspended:boolean;suspension_reason:string|null};
export type ConnectivityDto = {config:{schema_version:number;check_urls:string[]};max_urls:number};
/** Settings is a composition of separately owned queries, never a fabricated endpoint. */
export type SettingsDto = {failover:FailoverDto;connectivity:ConnectivityDto;auto_update:AutoUpdateDto};
export type SessionsDto = {sessions:{id:string;label:string;created_at:string;current:boolean}[]};
export type PairingDto = {id:string;status:string;expires_at:number;code?:string;device?:{id:string;label:string;created_at:string}};
export type DeviceValues = {name?:string;registered?:boolean;policy?:string;ip_pinned?:boolean};
export type DeviceChangeInput = {operation_id:string;changes:{id:string;values:DeviceValues;revision:string}[]};
export type DeviceLocationInput = {id:string;code:string|null;revision:string;locations_revision:string|null;operation_id:string};
export type DeviceOperationDto = {id:string;at:string;message:string;phase:string;undoable:boolean;undo_reason:string|null};
export type RoutingSettingsDto = {revision:string|null;policy_ids:string[];server_device_id:string|null;source:string};
export interface DeviceDto {
 id:string;mac:string;name:string;hostname:string;ip:string;reserved_ip:string;ip_pinned:boolean;can_pin_ip:boolean;
 segment:string;segment_policy:string;effective_policy:string;online:boolean;registered:boolean;policy:string;revision:string;favorite:boolean;is_server:boolean;
 location:{code:string|null;in_xkeen:boolean;ip:string|null;unavailable:boolean;ip_conflict:boolean;editable:boolean;name:string|null};
}
export type DeviceLocationsDto = {revision:string|null;main_code:string|null;main_route:RouteDto;pending_operation:Pick<OperationDto,'id'|'phase'|'message'>|null;available:{code:string;name:string;protocol:string|null}[];policy_ids:string[];managed:boolean;settings:RoutingSettingsDto};
export type DevicesDto = {configured:false;devices:[];policies:[];operations:[];error:string} | {configured:true;devices:DeviceDto[];policies:{value:string;label:string;disabled?:boolean}[];locations:DeviceLocationsDto;operations:DeviceOperationDto[];updated_at:string;operation?:DeviceOperationDto};
export type MatcherDto = {type:string;value:string};
export type RoutingGroup = {id:string;title:string;action:string;matchers:MatcherDto[];rule:JsonObject;editable:boolean;catch_all:boolean;default_rule:boolean};
export type RoutingModel = {schema_version:number;document:JsonObject;groups:RoutingGroup[];issues:string[]};
export type ValidationDto = {severity:string;message:string;group_id?:string;field?:string|null;[key:string]:unknown};
export type RoutingDraft = {revision:string;base_hash:string;base_snapshot:string;model:RoutingModel;validation:ValidationDto[];saved_at:string};
export type RoutingDto = {model:RoutingModel|null;parse_error:string|null;current:{id:string;sha256:string};observed_hash:string;observed_at:string;drift:boolean;capabilities:JsonObject;draft:RoutingDraft|null;operations:OperationDto[]};
export type RoutingChange = {id:string;kind:string;before?:RoutingGroup|null;after?:RoutingGroup|null;old_position?:number|null;new_position?:number|null;fields?:string[];moved?:boolean};
export type SnapshotDto = {id:string;sha256:string;size:number;created_at:string;model:RoutingModel|null;source?:string;parse_error?:string|null;};
export type RoutingPreview = SnapshotDto & {intent:'apply'|'restore';base_hash:string;base_snapshot:string;source_snapshot:string|null;draft_revision:string|null;environment:string;bundle_id:string|null;changes:RoutingChange[];xkeen_state:string;validation:ValidationDto[];has_draft:boolean;validated:boolean};
export type PreviewInput = {intent:'apply';expected_current_hash:string;draft_revision:string} | {intent:'restore';expected_current_hash:string;snapshot_id:string};
export type SaveDraftInput = {model:RoutingModel;base_hash:string;expected_revision:string|null};
export type RoutingPending = {preview_id:string;operation_id:string};
export type SnapshotSummary = Omit<SnapshotDto,'model'> & {original:boolean;current:boolean;protected:boolean};
export type RoutingHistoryDto = {snapshots:SnapshotSummary[];operations:OperationDto[]};
export type EventResponse = {event_ids?:string[]};
export type OkDto = {ok:true} & EventResponse;
export const isRecord = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
export const validId = (value:unknown):value is string => typeof value==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function operationDto(value:unknown, expectedId?:string):OperationDto {
 const op=isRecord(value) && isRecord(value.operation) ? value.operation : value;
 if (!isRecord(op) || typeof op.phase!=='string' || !op.phase || !(validId(op.id) || (op.id===null && op.ephemeral===true)) || (expectedId!==undefined && op.id!==expectedId)) throw new Error('Invalid operation status');
 return op as OperationDto;
}

export type ProbeDto = {results:Record<string,{ok:boolean;latency_ms:number|null;method:string}>;health:HealthDocument};
export type RouteCheckDto = {ok:boolean;active_code:string|null;active_after?:string|null;entry_code?:string|null;main_code?:string|null;scope?:string;checked_at?:string;stale?:boolean;tcp?:{ok:boolean;latency_ms:number|null}|null;route?:{ok:boolean;results:RouteResult[];skipped?:boolean;unattributed?:boolean;error?:string}};

export type RouteCheckState = 'unchecked'|'queued'|'checking'|'working'|'unstable'|'failed'|'unsupported'|'unavailable'|'stale';
export type RouteCheckRound = {ok:boolean;results:RouteResult[]};
export type RouteCheckKind = "single" | "chain";
export type RouteCheckStart =
 | {kind:"single"; codes:string[]; conditions_hash:string}
 | {kind:"chain"; exit_code:string; entry_codes:string[]; conditions_hash:string};
export type RouteCheckRow = {
 key:string; mode:'single'|'chain'; entry_code:string|null; entry_name:string|null; exit_code:string; exit_name:string;
 state:RouteCheckState; outcome:string|null; reason:string|null; stale_reason:string|null; checked_at:string|null;
 fresh_until:string|null; rounds:RouteCheckRound[]; run_id:string|null; on_main:boolean; applicable:boolean;
 last_attempt:{run_id:string; finished_at:string; reason:string}|null;
 entry_reachable?:boolean|null; entry_checked_at?:string|null; stale_kind?:"expired"|"config"|"missing"|"conditions"|null;
};
type RunProgress = {id:string;state:'running'|'completed'|'interrupted'|'cancelled';created_at:string;finished_at:string|null;total:number;done:number;working:number};
export type LegacyRouteCheckRunDto = RunProgress & {exit_code:string;exit_name:string};
export type RouteCheckRunDto = RunProgress & {
 kind:RouteCheckKind;exit_code:string|null;exit_name:string|null;conditions_hash?:string;
};
export type RouteChecksDto = {
 kind:RouteCheckKind;exit_code?:string;direct?:RouteCheckRow|null;fresh_sec:number;
 conditions:{hash:string;targets:string[];timeout_sec:number;rounds:number};
 run:RouteCheckRunDto|null;active_run:RouteCheckRunDto|null;routes:RouteCheckRow[];
};
