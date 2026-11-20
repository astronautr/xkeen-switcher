# Frontend architecture contract

The Python service serves the compiled React app at `/` and its fixture-only catalog at `/styleguide.html`. This document records the protocol and component boundaries of the React app.

## Ownership

`AppSessionProvider` (`frontend/src/app/AppSessionProvider.tsx`) owns one `SessionRuntime`, one QueryClient and the polling lifecycle above navigation. Mount it once. Features do not create clients, call fetch, poll status/journals, retry mutations, duplicate server DTOs in reducers, or infer terminal/busy themselves. Local forms and validated review state stay with their feature; cache refresh must not replace dirty forms.

Query defaults: `retry:false`, `networkMode:"always"`, `refetchOnReconnect:false`, `refetchOnWindowFocus:false`. Mutation defaults: `retry:false`, `networkMode:"always"`; no serial mutation scope or offline queue. LAN requests execute even when TanStack onlineManager reports offline.

`api/client.ts` exports `ApiClient`, `ApiError`, `StaleSessionError`, `classifyError`, `requestJson<T>(path, options?)`, `requestBlob(path, signal?)`. Options are `{method?:"GET"|"POST"|"PUT"|"DELETE",body?:unknown,signal?:AbortSignal,authAttempt?:boolean}`. The provider binds the public transport to its own generation. Named hooks below are the feature API; the transport/class are infrastructure and deterministic-test seams.

Requests retain same-origin cookies, no-store, JSON plus `X-XK-Request: 1` on mutations. `ApiError` preserves `status?`, `code?`, `retryAfter?`, `operation?`, `eventIds:string[]`, `acceptanceUnknown:boolean`, and the error `data?`. Use `acceptanceUnknown` for acceptance decisions, never HTTP 202 as successful application. Invalid JSON after a successful mutation is ambiguous. Error taxonomy includes busy, precondition, conflict, validation, unavailable, rejected, not_found, unauthorized and unknown. A coded prerequisite failure is definite; network, 408/429 and uncoded 5xx are uncertain.

Epoch checks run after headers and after JSON/blob consumption. Logout/401 clears Query data, tab ownership, routing scratch/pending state, counters and timers. Late old responses, errors and finally callbacks cannot publish into a new session. Shared Main intent, theme, inbox and event cursor survive logout. Features ignore `StaleSessionError` (also used to discard superseded pairing creation replies); it is not a user error or a rollback.

## Wire types

All types are exported by `api/types.ts`; object keys remain Python wire names. Authoritative sources: `service.py:130`, `routing_service.py:89`, `routing.py:69`, `devices.py:115`, `devices_service.py:114`, `device_routing_settings.py:34`, `auth.py:166`, `routing_store.py:70` and `routing_store.py:128`. Existing serializer fixtures remain unchanged; `tests/test_ui_contracts.py` adds checks for optional operation fields, unknown phases, unconfigured Devices, numeric pairing expiry, model-free history summaries and validation severity.

- `SessionDto`: configured/authenticated booleans and nullable session_id. `PairingDto.expires_at` is **numeric Unix seconds**, not an ISO date. Session IDs and pairing IDs are opaque strings; operation IDs are UUIDs.
- `StatusDto`: complete status projection, including `active_route`, `active_health`, `server_route`, available full `LocationDto` records, failover projection, auto-update, history and retained events. `SettingsDto` is an explicitly composed `{failover, connectivity, auto_update}` type, **not** an endpoint response. Read the named queries separately.
- `RouteDto`: `{mode,exit_code,exit_name,entry_code,entry_name}` with nullable codes/names. `MainRoute`: `{code:string,entry_code:string|null}`. A null entry means single.
- `OperationDto`: nullable ID only with ephemeral:true, nonempty **open string** phase, optional journal/public metadata and unknown additional fields retained. `operationDto(value, expectedId?)` validates the identity and phase before effects. Unknown future phases remain blocking. Only committed, rolled_back and rejected are terminal; unknown/recovery_failed remain unresolved. No percent completion is invented.
- `DevicesDto` is discriminated by configured. The false branch has only configured:false, empty devices/policies/operations and error; it has **no locations or updated_at**. The configured branch includes revisions, policy choices, decorated DeviceDto rows, DeviceLocationsDto and device-operation summaries. `DeviceOperationDto.phase` is independent of Main terminal vocabulary (uncertain/undoing/undone are meaningful).
- `RoutingDto` retains raw RoutingModel.document and each RoutingGroup.rule as open JSON objects. Custom matchers/action strings are retained; editable/default_rule/catch_all are explicit. `RoutingDraft` is nullable; save-draft returns the draft directly or null, whereas GET returns `{draft}`. `ValidationDto` uses severity and optional nullable field. `RoutingPreview` includes validation, base hash/snapshot, draft revision, exact changes and model. `SnapshotDto` includes model; `SnapshotSummary` in history deliberately omits model and adds current/original/protected. Download returns Blob without JSON/text reconstruction.
- `EventDto`, `HealthDto`, `HealthDocument`, `ProbeDto`, `RouteCheckDto`, `AutoUpdateInput/Dto`, `FailoverConfig/Dto`, `ConnectivityDto`, `SessionsDto`, `DeviceValues`, `DeviceChangeInput`, `DeviceLocationInput`, `RoutingSettingsDto`, `MatcherDto`, `RoutingGroup`, `SaveDraftInput`, `PreviewInput`, `RoutingPending`, `RoutingHistoryDto`, `OkDto` and `EventResponse` are exported for concrete feature payloads/results. Optional/null fields must not be collapsed into success, false or an invented default route.

## Public hooks

Imports from `app/AppSessionProvider.tsx`:

```ts
useOperationTracking(): OperationView
useMainActions(): { switchTo(route: MainRoute): void }
useRoutingActions(): { apply(preview:RoutingPreview):Promise<OperationDto|undefined>; retry():Promise<OperationDto|undefined>; canRetry():boolean }
useNotifications(): { items: Notification[]; clear(): void; publish(message:string,error?:boolean,metadata?:{device_operation?:string}):void; subscribePublished(listener:(item:Notification)=>void):()=>void }
useActivity(): { activity; attention; pendingMutations: number }
```

Device change notifications accept the operation ID as metadata for durable Undo. The provider already publishes the outcome for a confirmed local device-location operation, including Undo for newly applied changes.

`OperationView` is `{operation:OperationDto|null, requested:MainIntent|null, confirmed:RouteDto|null, blocking:boolean, blockReason:string|null, local:boolean, durable:boolean, ephemeral:boolean, terminal:boolean, unresolved:boolean, refusal:Refusal|null, activity}`. Requested and confirmed are separate. Local means this tab owns the result; merely observing a shared/foreign UUID does not claim it. Refusal has kind/message/optional blocker/at. Main refusals also retain the requested RouteDto for the banner. The Main actions hook exposes dismissRefusal() to clear that explanation across screen changes. Activity is `{key,active,attention,delay,label,description}`. Presentation delay never delays admission or detail visibility. Use policy exports `terminal`, `unresolved`, `blocking`, `phaseLabel`, `actionLabel`, `sourceLabel`, `scopeLabel`, `activityPresentation`, `elapsedSince`, `eventNeedsAttention` for shared presentation.

Imports from `api/queries.ts` return `UseQueryResult<DTO,ApiError>`:

| Hook | DTO / trigger |
| --- | --- |
| useSession(), useStatus() | SessionDto, StatusDto; subscriptions only, provider owns reads |
| useRefreshStatus() | Returns the provider’s manual status refresh, including operation and event reconciliation. The dashboard retries through this callback. A periodic tick can supersede an overdue poll. A pending mutation readback keeps admission until it finishes. |
| useDevices(enabled=true) | DevicesDto; open/expand driven |
| useRouting(enabled=true) | RoutingDto; routing screen driven |
| useRoutingDraft(enabled=true) | `{draft:RoutingDraft|null}` |
| useRoutingHistory(enabled=true) | RoutingHistoryDto; versions drawer |
| useRoutingSnapshot(id:string|null) | SnapshotDto; no request with null ID |
| useOperation(id:string|null) | OperationDto subscription; explicit refetch reads this UUID without reclaiming ownership |
| useFailover(enabled=true), useConnectivity(enabled=true) | FailoverDto, ConnectivityDto; settings section |
| useSessions(enabled=true, refreshOnMount=false), useSubscriptionUrl(enabled=true) | SessionsDto, `{url:string|null}`. Access opts into a fresh list on each visit. |
| usePairing(id:string|null, enabled=true, open=true) | PairingDto; registers the current invitation with the provider |
| useDevicesPolling(eligible:boolean) | Registers whether the panel is expanded and permits updates given the current editor, dialog, menu and focus. The provider checks the 30-second interval at dispatch against the last successful inventory snapshot and the last periodic attempt in this session. Explicit refresh remains available immediately. |
| useRoutingEditorPolling(eligible:boolean) | Registers visible editor/no busy/poll guard; preserves local form |

`useRetrySession()` returns a callback that repeats the full session bootstrap, restoring tracking and polling after the initial session read fails. Login and password replacement resolve only for the confirmed replacement session. A refused logout keeps the current identity. An ambiguous logout checks `/api/auth/session` before clearing private data.

Use query error/dataUpdatedAt to render one stale/offline state while retaining data; failed polls never create a toast per tick. Status interval is 10 s, journal 1.5 s. Ephemeral work follows status (never `/operations/null`). One provider handles visibility pause/resume, independent of mounted feature subscriptions. useDevices initial/refetch/poll and unknown readback publish one deduplicated ephemeral kind/scope read activity, block immediately, use routine delay/non-own attribution, and clear silently on completion/cancel/error; this read creates no notification or mutation barrier. Devices is checked on the outer 10 s tick with at least 30 s between eligible reads; routing edit checks use 30 s. The provider checks pending pairing invitations every 2 s while the dialog is open and on the normal dashboard tick while it is closed. Reopening a pending invitation or returning to the visible tab checks it immediately. Creation seeds its query cache and the first GET waits for the scheduled tick. The pairing component owns the countdown while open. Histories, sessions and settings have no global periodic polling.

Imports from `api/mutations.ts` are `UseMutationResult<Result,ApiError,Input>`; invoke `.mutate(input)` or await `.mutateAsync(input)`. They preserve exact payloads and perform no automatic mutation retry:

| Hook | Input | Result | Invalidates |
| --- | --- | --- | --- |
| useLogin / useSetup | `{password}` | void; new generation + bootstrap | all private cache |
| usePairLogin | `{code}` | void; bootstrap | all private cache |
| useLogout | void | void | all private cache |
| useChangePassword | `{current_password,password}` | Confirmed SessionDto from the replacement bootstrap | all private cache |
| useCreatePairingCode | `{}` | PairingDto (includes code) | none; pass its ID to usePairing |
| useRevokeSession | `{id}` | `{ok,current_revoked}`; current revoke signs out | sessions |
| useRefreshSubscription | `{}` | `{ok,...update-result}` | status, failover, devices |
| useSaveSubscriptionUrl | `{url}` | `{ok,url}` | status, sub-url |
| useXkeenControl | `{action:"start"|"stop"|"restart"}` | `{ok,action}` | status, devices |
| useApplyPending | `{}` | `{ok,active_code,active_entry_code}` | status, devices |
| useSaveAutoUpdate | AutoUpdateInput | `{ok,config:AutoUpdateDto}` | status |
| useSaveFailover | FailoverConfig | `{ok,config}` | failover, status |
| useCheckFailover | `{}` | HealthDocument | failover, status |
| useSaveConnectivity | `{check_urls:string[]}` | `{ok,config}` | connectivity, status |
| useProbeLocations | `{code?:string,codes?:string[]}` | ProbeDto | status, failover |
| useCheckRoute | `{}` | RouteCheckDto | status, failover |
| useChangeDevices | DeviceChangeInput | DevicesDto | devices, status |
| useUndoDeviceChange | `{operation_id}` | DevicesDto or `{operation:OperationDto}` for a fixed exit. The provider tracks the new journal ID returned by the server. | devices, status |
| useSaveDeviceServer | `{revision:string|null,id:string|null}` | DevicesDto | devices, status |
| useSaveDeviceRoutingSettings | `{revision:string|null,policy_ids:string[]}` | DevicesDto | devices, status |
| useFavoriteDevice | `{id,favorite}` | `{favorites:string[]}` | devices |
| useAssignDeviceLocation | DeviceLocationInput | accepted OperationDto; shared tracking | terminal: devices, routing, history |
| useCheckDeviceLocation | `{operation_id}` | OperationDto or undefined, plus inventory readback | devices |
| useSaveRoutingDraft | SaveDraftInput | RoutingDraft or null; updates draft cache wrapper | routing |
| useDiscardRoutingDraft | `{expected_revision:string|null}` | `{ok}` | routing, draft |
| usePreviewRouting | PreviewInput (apply or restore union) | RoutingPreview | none |
| useReimportRouting | `{expected_current_hash,observed_hash}` | RoutingDto | routing, history |
| useDownloadSnapshot | `{id,signal?:AbortSignal}` | Blob | none |

`api/keys.ts` (also re-exported by queries) defines exact cache keys: session/status/devices/routing/draft/history/failover/connectivity/sessions/subUrl plus operation(id), snapshot(id), pairing(id). Draft/history/snapshot are prefixed with routing. Active feature queries refetch on invalidation; disabled status subscriptions are refreshed by the provider explicitly. A durable terminal observation invalidates devices/routing/history and journal reconciliation refreshes status.

## Three mutation protocols

Main stores `{id,code,entry_code,mode,created_at,name?,entry_name?,conflicting_id?}` before POST. Tracking starts immediately, including while POST is held. Replay happens only after a matching journal 404, with the same UUID/pair, and no recorded conflict. Explicit busy/precondition/refusal clears intent and records a refusal; it never queues a later switch. Any competing durable ID or unrelated ephemeral activity persists conflicting_id (including `server-activity`), preventing a lost refusal from becoming delayed work. Own request_id on preparation is not a conflict. An ephemeral holder temporarily takes display priority while the durable journal identity remains tracked; idle status alone cannot release an unresolved durable request. Per-ID terminal evidence is monotonic; old terminal responses cannot replace a different active blocker. A hanging old POST does not prevent a fresh switch after journal confirmation.

Routing `apply(preview:RoutingPreview):Promise<OperationDto|undefined>` requires validated preview, saves `{preview_id,operation_id}` and begins shared tracking before POST. Restoring pending state does not mark ownership again. Matching journal 404 exposes `not_received` and `canRetry()`. `retry():Promise<OperationDto|undefined>` is explicit and resends only the saved pair. The feature owns its review: retain it after a busy refusal; clear/rebuild it after another definite refusal. Preview success/HTTP 202 is not application success.

Synchronous Devices failures with unknown acceptance perform inventory readback, then still reject with the original error within the same session. A session change during readback instead rejects with StaleSessionError, including failed readback, so an old editor error cannot reach a replacement session. The editor must retain input and offer reload/compare; readback does not prove rollback. Device assignment is a distinct durable action: create/store the input UUID in the feature dialog, useAssignDeviceLocation once, and on ambiguous error offer useCheckDeviceLocation with that UUID or close-and-refresh. Never replay the assignment automatically. Device Undo uses its own operation summary, not Main terminal logic.

## Browser state and events

`browser/storage.ts` exports `BrowserStorage`, `defaultStorage`, `readMainIntent`, `saveMainIntent`, `clearMainIntent`, `mainIntent`, `newOperationId`, `STORAGE_KEYS`, `Notification`, `RoutingScratch`, `StorageLike`. BrowserStorage exposes Main, Routing pending, scratch, ownership and inbox adapters. Main cleanup compares the current shared ID; write/remove failures retain safe in-memory state, and a sibling's successful deletion does not resurrect an old in-memory record. Legacy code-only intent normalizes to entry_code:null/mode:single. Corrupt structures are ignored. UUID uses getRandomValues with RFC version/variant bits; no secure-context randomUUID dependency.

Routing scratch is `{version:1,base,revision,form}`; reader checks form.rule.id, initial, original and entries. Features compare recovered base/revision with server state before restoring. History navigation code must preserve unrelated history.state keys (shared UI/routing shell responsibility).

`browser/preferences.ts` exports Theme, BrowserPreferences and browserPreferences. `theme()/setTheme()` use literal auto/light/dark; `devicesExpanded()/setDevicesExpanded()` use literal true/false. Theme DOM application remains with the shared UI shell/prepaint boot. Inbox records are newest first, capped at 100; event seen IDs at 200. Exact legacy storage keys are unchanged.

`operations/events.ts` exports EventFeed, attentionGroup, attentionFromEvents. EventFeed first nonempty poll seeds silently; an empty first poll establishes an empty cursor so later events are fresh. Stable event IDs follow append order even when timestamps reverse, rotation consumes unseen retained IDs, and sibling acknowledgements merge before each take. Response event_ids suppress only exact outcomes. Own-operation IDs, shared event cursor and durable attention are distinct. A mutation barrier defers retained-event consumption until every current-generation response has acknowledged its exact IDs. A hung mutation does not block independent durable confirmation. Within a session, attention survives event-window rotation independently of the deduplication cursor. Only recovery in the same domain clears the corresponding failure. A vanished-subscription-route warning also clears when current status is healthy and the active exit plus any entry are all available again; this does not clear unrelated route failures.

## Verification boundaries

Unit suites live beside storage/client/events/runtime/polling. The additive browser harness in `frontend/tests/protocol` imports actual public providers/hooks and the existing independent ScenarioEngine. It is built only by rspack.protocol.config.mjs into an ignored test cache, never app/catalog artifacts; it exports no private window API. `npm run test:protocol` uses native pinned Chromium and tests transport/controller behavior, not unimplemented feature-screen parity. Actual StrictMode exposed and now covers query observer feedback and canceled bootstrap during effect rehearsal.

## Shared UI components

Import components directly from the modules below. No presentation component fetches, reads storage, starts polling, submits mutations or owns notification/indicator timers. Error presentation reuses the pure `classifyError`; callers discard `StaleSessionError` before presenting errors.

### Shell, navigation and theme

`app/App.tsx` exports `App` and `AppSlots`: `{header?:ReactNode, main?:ReactNode, routing?:(hash:string)=>ReactNode, gate?:ReactNode, settings?:ReactNode, overlays?:ReactNode}`. Keep the existing `AppSessionProvider` above `App`. A present `gate` replaces header/main/routing/settings; `overlays` remain mounted outside that conditional. Authentication decisions and clearing private overlay content belong to the root composition. Put the feature's `.app > .scroll + .drawer + .drawer-backdrop` composition together in a slot; slots do not change those direct-child relationships. The generic shell adds only a `div[data-marker=react-shell]` around screen slots. No auth, settings, Main, Devices or Routing screen is implemented here.

`app/navigation.ts` exports `useHashRoute()`, `isRoutingHash(hash)`, `navigateHash(hash, options?)` and `openRouting()`. Routing hashes are exactly `#routing` and `#routing/...`. Navigation merges the caller's patch into `history.state`. The dashboard uses `openRouting()` to mark both ends of the first hop. The editor uses those entries to guard dirty Back/Forward navigation on engines without the Navigation API. Settings sections remain local state.

`app/theme.ts` exports `applyTheme(theme)` and `useTheme():{theme,setTheme}` using `Theme = auto|light|dark` and preferences adapter. Theme boot is still the copied legacy script, loaded before CSS/React in both entry HTML files. Auto leaves both explicit classes absent; explicit choice updates chrome metadata/favicon URLs and persists through the existing safe preference adapter. Catalog theme previews only change the HTML class and do not persist.

### Controls and feedback

- `ui/Button.tsx`: `ButtonProps` is native button attributes plus required `marker`, optional React 19 `ref` and `variant:primary|danger|bracket`; `Button` preserves `.ui-button` and variant classes. `ActionButton` accepts native button props/marker plus `idle`, `pending`, `busy?` and `plain?`. Two hidden generated-content faces (idle, and pending with its glyph slot) share one grid cell with the visible `.terminal-action-label`, so both states keep the wider size and stay out of names and `textContent`. Brackets hug the visible face exactly like `[data-ui-variant="bracket"]`; `plain` omits them. The busy glyph is inside the label, with `aria-busy` and `data-busy`. Keep focus during progress with `aria-disabled` and a guarded click instead of `disabled`. The optional `icon` renders a compact action with the same button and busy glyph. Caller supplies its accessible name, screen classes and admission state. `IconButton` adds `label`, `icon?`, optional children; it preserves `.icon-button`, accessible name/title and existing device path/sprite drawings. Header/mobile variants can supply exact SVG children and classes.
- `ui/Field.tsx`: `Field` and `Textarea` accept native attributes plus required `marker`; they keep native input/textarea identity, IME, validation and caller callbacks. Input clears custom validity before `onInput`; invalid sets the previous English required/minlength/range/URL/fallback message before `onInvalid`. `clearValidity` and `englishValidity` are exported for native controls. Labels/IDs/descriptions remain the caller's responsibility.
- `ui/ChoicePopup.tsx`: `ChoiceOption` is `{value,label,disabled?,separated?,suffix?,count?}`. `ChoiceProps` has required `marker,label,options,onSelect(value)`, optional `value:string|ReadonlySet<string>`, `disabled,fieldId,className,triggerClass,popupClass,optionClass,variant,minWidth,onOpenChange(open),caption,title,triggerLabel`. `ChoicePopup` additionally accepts `kind:select|menu`; `Menu` fixes menu semantics. `Select` takes string `value` plus `rich?` and `controlClass?`, defaults to a native select. A `fieldId` native select expects `<id>-label`. Rich controls preserve native popovers, listbox/menu roles, enabled-option wrapping, Home/End, 700 ms typeahead/repeated letters, disabled items, Escape return and Tab travel without selection. Empty multi-select Set selects `all`. Options are keyed by value and stay mounted through updates. Position follows visualViewport, resize and capture-scroll. `onSelect` is the only selection event; focus movement never selects.
  The `device` variant renders the trigger and popup as direct siblings. Its native `.menu-trigger` contains a caption span followed by an aria-hidden ⌄ span. The popup and options default to `.device-menu` and `.menu-option`. Set `caption` for the visible selection summary, `title` for the tooltip and `triggerLabel` for the full accessible trigger name. The popup uses `label`. Other variants retain their wrapper and button styling, including `bracket`.
- `ui/feedback.tsx`: `ConfirmStrip` takes `marker,message,onCancel,onConfirm`, optional `id,tone:danger,detail,cancelLabel,confirmLabel,cancelMarker,confirmMarker,autoFocus,returnFocus,className`. Cancel precedes confirm; opt-in initial focus goes to cancel, Escape cancels, and a supplied returnFocus ref restores the caller's trigger on teardown. Catalog does not opt into autofocus. `DisabledReason({id,text,marker?})` produces the visible description; caller sets the disabled action's `aria-describedby`. `Notice({title,detail?,kind?,actions?})` preserves section/strong/p/inline-actions. `Banner({tone,prefix,children})` preserves the catalog's separate banner/prefix/message structure.
- `ui/format.ts`: `formatDateTime`, `formatTime`, `formatDay`, `formatMoscow`, `formatElapsed`, `formatAgo`, `errorMessage`. Dates remain browser-local except explicit Moscow schedule formatting; missing values/elapsed and legacy error wording are preserved. There is one error taxonomy.

### Native dialogs and portal hosts

`ui/overlays.tsx` exports `OverlayProvider({children,overlay?})`, `OverlayPortal({children,className?,live?})`, `NotificationPortal({children})`, `Dialog`, `DialogProps`, and `visibleControls(root)`. `App` already supplies one OverlayProvider. `Dialog` accepts native dialog attributes plus controlled `open`, required `marker,onClose`, optional `initialFocus` selector and `returnFocus` ref. Use `onClose` for caller state; it is called on native cancel/Escape or a native close. Controlled teardown does not request another close. The native showModal/close lifecycle supplies inert/top-layer behavior. Visible enabled controls wrap forward/backward, including portal controls, excluding hidden activity-close and closed popovers. A native keydown listener covers DOM portal descendants because React synthetic events follow the React tree. Cleanup restores the trigger after React's commit focus restoration and skips a reopened dialog.

Overlay host nodes and React portal subtrees retain identity while moving to the active modal or back to body. `NotificationPortal` itself supplies the `.toast-stack[aria-live=polite]` host **directly** under the modal/body, preserving `dialog > .toast-stack` CSS. Pass toast children, never another toast-stack wrapper. Other overlays may use `OverlayPortal` or the shell's overlays slot. Native popover/focus state is retained when rehosting. Gates/navigation do not remount overlay children; removing a feature dialog closes native top layer, unregisters it and returns hosts to the remaining modal/body. Feature controllers retain six-second toast lifetime, pauses, history and indicator-delay policy independently of this lifecycle.

### Domain visuals

`ui/domain.tsx` exports:

- `RouteLabel({exit?,entry?,empty?})`: names supplied by the feature model, single/chain/none text only.
- `LocationRow({name,code,health,latency,onSelect,onCheck,current?,disabled?,marker?,checkMarker?,children?})`: legacy catalog li/button/meta/health plus sibling check button. Defaults use `sg-location-<code>` and `sg-location-check-<code>`; feature callers supply production markers and metadata children. Key rows by code.
- `OperationStatus({operation,elapsed?,ownIds?,marker?,variant?,children?})` displays shared operation phases and exposes `data-phase` with a marker. The journal variant shows the confirmed kind, full target route and server message. The session provider owns polling and terminal results.
- `DeviceRow({id,identity,state,policy,location,actions,detail?})`: stable legacy article/listitem and identity/state/policy/location/action slots. Key it by device ID; feature owns editor controls and their drafts.
- `PendingUpdateNotice({state,hasUpdate?,optional?,title,details,action?})`: div.pending-config, status copy, bold title, `.pending-config-detail` lines and optional action slot; state is applying/pending/empty/current/unknown. Feature supplies schedule/copy and ActionButton. Optional SNI title/timing remain separate lines.

`ui/ActivityIndicator.tsx` exports `ActivityIndicator` and `ActivityIndicatorProps`: controlled `open,onOpenChange`, required `description`, optional `visible,active,attention,label,children,anchor`. It preserves widget/launcher/prompt/cursor/dot/alert/description/panel/header/close/content DOM, uses a native manual popover, and positions beside the caller's anchor or the viewport edge using the legacy dimensions. Escape returns to its launcher; outside pointer closes without moving focus. Caller computes active/attention/delay visibility and supplies operation details; presentation starts no controller timers or requests.

### Catalog, Storybook and verification scope

`catalog/fixtures.ts` supplies LONG_NAME, NETWORKS, LOCATIONS, COMMANDS, OPERATIONS, LOCATION_ROWS, BANNERS and STOP_DETAIL, shared by the React Catalog and development stories. `/styleguide.html` resolves to the catalog entry through the existing Python manifest handler; it uses only tokens/components/app CSS, the previous group order/markup and local callbacks, with zero API calls. `catalog-styles.ts` is the common foundation import; full app/Storybook styles add the remaining existing screen CSS in order. `rsbuild.shared.mjs` shares the alias with direct Rspack and the pinned Storybook Rsbuild adapter. Storybook's runtime/build output is excluded from production artifacts and routine rsync.

## Production auth and settings composition

`main.tsx` mounts one `AppSessionProvider` and `Application`. `Application` supplies the auth gate, the Main header, the session-keyed private layout and the pairing dialog shared by header and Access. `ApplicationProps.main(navigation, subscription)` places the supplied `SubscriptionPanel` within Main. `ApplicationProps.routing(hash, navigation)` renders the Routing screen and its header. Both callbacks return React nodes inside the same `SettingsLayout`. The settings drawer and provider keep their identities on hash navigation.

`AccessContent` owns the browser list and the link-device and change-password controls. `PasswordContent` reports dirty and pending state to the drawer guard. Closing a pending pairing dialog retains the invitation. Session replacement unmounts its private drafts and dialogs.

`features/main` exports `MainDashboard({ navigate, subscription, devices })`. The authenticated Application supplies settings navigation and the subscription node. The preview entry supplies `<DevicesPanel />` from `features/devices` for inventory and device actions. The same module exports `useDeviceUndo()` for a history or notification action on a specific device operation.

Routing uses `useRoutingEditorAccess()` for a cancellable fresh rule ID (GET /api/routing/id), the session-bound scratch adapter, read-only pending identity and explicit journal reads through the provider. The shared controller owns every apply, retry and reconciliation timer.

`registerHashRouteGuard` lets the mounted Routing editor accept or pause a native history traversal before `useHashRoute` publishes it. The shell retains the last admitted hash while the editor restores the original entry and asks for confirmation.

Routing and versions opt into `refreshOnMount` on `useRouting` and `useRoutingHistory`. A form keeps the base hash and draft revision from when it opened. Later reads can pause saving without replacing the local form.
