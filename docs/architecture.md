---
summary: "Cross-runtime architecture contracts: entry points, the collector pipeline, limits runtime, mode switching, configuration and credentials, the wire contract, Hub subscriptions and generated state."
read_when:
  - Changing boundaries shared by the widget, agent, Hub or Worker
  - Changing collector scanning, watching, self-sync, WSL or subprocess lifecycle
  - Changing limits scheduling, outbound transport or balance display
  - Changing the device wire record, Hub subscriptions or stale-device handling
  - Changing shared configuration, credential storage or renderer redaction
---

# Architecture

Contracts that cross subsystem boundaries. This guide names the owner, the invariant and its reason; implementation mechanics stay beside the code. Use the [provider guide](providers/README.md) for provider-specific behavior, [API reference](API.md) for wire fields and endpoints, and [headless agent guide](headless-agent.md) for deployment and cleanup.

## Entry points and the Worker boundary

The widget (`src/electron/main.js`), headless collector (`src/agent/agent.js`) and Node Hub (`src/hub/server.js`) share `src/shared/`. The Cloudflare Hub (`worker/src/index.js`) speaks the same protocol.

Device collection, transforms and archives live in `src/shared/usage/`. The neighboring `src/shared/usage.js` is the Hub-core usage model, not that directory's index: `require('./usage')` resolves the file. Do not add `usage/index.js`.

Cloudflare deployment isolates `worker/` into its own repository. Its portable closure, `WORKER_SHARED_MODULES` in `scripts/hub-build-manifest.js`, must not import Node built-ins or anything above `worker/`. Edit the originals in `src/shared/`, then run `npm run sync:worker`; the mirrored `worker/src/shared/` files are generated and CI rejects drift.

## Desktop plugins

`electron/plugins/runtime.js` owns plugin management, host data routing and native demand; `manager.js` owns revision trust and the shared backend lifecycle. Author UI runs in the existing renderer with context isolation and no Node integration; the optional Node utility process has OS-user authority. Host DTO filtering is not a security boundary against trusted local code. Same-page author JS cannot be independently terminated while preserving its renderer. Native controllers retain rendering, window shells and input geometry; plugins extend content through host outlets. See [execution and UI contracts](plugins/README.md) and [content composition](plugins/author-ui-options.md).

Native visibility and page activity cap each owner's demand without discarding retained controls or drafts; other visible owners remain independent. All surfaces of a plugin share its backend. Last demand stops it unless explicitly enabled background work or a pending call remains. When no plugins are active, the host starts no plugin process, sampler or recurring projection. This does not guarantee byte-identical baseline memory or control arbitrary author timers.

Business data reads reuse selected-source snapshots and existing history resolution, never launch provider probes or duplicate collectors, and remain independent of native session rendering. Active ownership, explicit query filters and host privacy preferences apply; there are no per-resource grants or plugin-specific account/device scopes. Ordinary updates preserve admitted immutable cursors; source/privacy changes revoke them. Work and memory limits protect host reads, not unrestricted backend work.

Package transactions release only their target plugin, after content-conflict and unsaved-work confirmations complete and the preview is revalidated. Cancellation before cleanup must preserve existing UI instances, drafts and backends. Recheck affected content selections after asynchronous lifecycle waits so an older confirmation cannot overwrite a newer choice. Content-source changes inspect only the departing replacement refs and targets; they must not release the provider's other mounts. Unrelated mounts, drafts and backends stay live, including during rollback. Preserve existing App data and credential contracts. Renderer-independent safe mode must remain available for recovery; it cannot undo arbitrary plugin filesystem effects. See [management and recovery](plugins/distribution-design.md).

Official and community remote plugin sources are separate host-owned definitions. Remote official provenance comes only from `electron/plugins/officialSources.js`; catalog titles, authors and user-added source metadata cannot grant it. Both use the existing package validation and exact-revision approval. Official plugin source stays in `plugins/`; the main-only publishing job builds it with this repository's tools and writes the catalog and immutable packages to `dist`. No production package is bundled in the App.

## Generated and registered state

Hub update checks use `src/shared/hubBuildRegistry.json`, which hashes the portable core and separate Node/Worker adapters, rather than the product version. A desktop-only release must not require Hub redeployment. This is a registered build identity, not attestation; divergent metadata is unrecognized, not proof that every fork is detectable. Run `npm run update:hub-build` after the final Hub/shared change, including limits-provider registry changes. Never edit generated Worker metadata directly.

Only app, agent and packaging entry points run `ensure:tokscale`; install, Hub, lint, test and verify never download the binary. `scripts/vendor/tokscale.json` pins its provenance. Its `override`/`upstream` mode does not bypass either verification gate, and its presentation describes the declared bundle, not verification of the selected executable.

## Collector pipeline

`src/shared/collector.js` owns tokscale scans and binary resolution. `clientSources.js` owns canonical host roots; `clientSourceObservations.js` derives checks and diagnostics from them, and the collector applies watch policy. Source attribution, ignore policy and exporter paths must share those roots, including through symlinks and Windows path aliases.

- **Exact accounting.** Full ticks scan today, month and allTime serially to bound CPU/IO. Watch ticks scan `--today` and use `applyPeriodDelta()` against the full-scan anchor; this is exact for append-only logs. An anchor from another date forces a full scan. Changed clients share one unioned scan, so client IDs are partition keys; preserve the [partition invariants](providers/README.md#partition-invariants).
- **Manual refresh.** Generic settings/account `{ force: true }` refreshes await limits without starting a usage tick. Credential save/clear reuses one provider-scoped settings invalidation, including unchanged credentials, and awaits it when the runtime is ready. Account panels then read stats without another collection; their Refresh button collects only that provider. App and Edge Dock refresh retain full usage, History recovery and explicit self-sync: a Today delta cannot reconcile imported or corrected older usage in Month/All Time (#717). Tray-menu refresh explicitly requests its existing full usage scan. Structural settings and pricing changes retain their dedicated usage invalidation paths.
- **Rate timing.** Use the familiar generation-speed label and explain its estimated timing basis in auxiliary copy. Use scanner-supplied matched timed-output buckets when present, with a compatibility estimate for older binaries; never apportion output by total-token coverage. Request performance timing and session/active-time spans have separate purposes. A parser timing change must preserve that distinction and invalidate its source cache; a new binary revision also requires fresh collector anchors. See the [throughput wire contract](API.md#post-apiingest).
- **Pricing authority.** Tokscale applies overrides before aggregation. Managed model edits preserve manually authored provider-scoped rules and other top-level pricing metadata. Incomplete rate coverage preserves the original row cost except for explicit free-model overrides. Pricing content and binary revisions invalidate anchors and require full usage/history refreshes; mixed-revision scans must not publish. Fresh prices, including zero, replace archived live costs only for matching source usage; archive-only records keep their costs.
- **Session retention.** Normal scanner rows replace the whole archived observation for the same canonical client/session and period, including lower counts and explicit zero; missing identities stay retained. Only completed three-period scans may clear Today/month for IDs still present in allTime. On watch ticks, zero-only broader-period rows require the same canonical identity in Today. Released aliases contribute one latest whole-period observation. Retention trusts scanner output and does not reconstruct corrected historical daily usage.
- **Archive replay.** Restore explicit saved input without reclassifying it as unknown. Native session identities win over matching client snapshots; identity-free legacy remainder stays retained. Equal aggregate amounts do not prove overlap. See [archive replay](archive-replay.md).
- **Metadata fallback.** Workspace-aware grouping falls back per binary identity when unsupported. Local resolvers remain enabled and skip only sessions already attributed. Only a decoded path becomes a `projectIdentity()` hash; opaque workspace keys must not create a second project identity. `usage.js` accepts nested tokscale JSON rather than assuming one layout.
- **Separate retention.** [Codex Dots usage](providers/codex.md#dots-local-execution) merges after native/WSL scans, outside native delta anchors and scan partitions. Its ledger owns retention; generic archives must not duplicate it. Visibility changes refresh the projection without restarting observation.
- **Shared metadata reads.** Context, turn state, prompt-cache and waiting observations reuse provider-owned session indexes rather than independent transcript readers. Preserve accounting identity across append scans so repeated records do not restart cache estimates. In anchored propagation, omitted `promptCache` preserves the observation and explicit `null` clears it. Provider rules live in [Claude](providers/claude.md#usage-and-session-metadata) and [Codex](providers/codex.md#session-metadata-and-context).
- **Catalog edits are not activity.** Title/project refreshes preserve transcript activity, context, cache, period-native attribution and token/cost baselines. Keep provenance in local metadata caches and anchors, never published rows. Confirmed removals clear only the matching override and restore native fallback; unreadable/missing stores do not prove deletion. Persist metadata-only changes without advancing `fullScanAt`, independently of usage anchors, so renames/removals survive restart and later read misses. Watch refresh covers today's sessions, including retained partitions; older-only sessions wait for a full scan. See [Antigravity](providers/antigravity.md#session-titles-and-project-resolution) and the provider title-precedence rules.

### Watching

`src/shared/watcherHost.js` isolates chokidar in a child process, not a worker thread, to keep descriptors and native memory out of the owner. Root replacement waits for exit; `unwatch()` does not release descriptors. The child exits on IPC disconnect. Attribution, debounce and tick decisions stay with the collector.

- Preserve the 3–5 s update contract: no cooldown above the debounce; mid-tick events re-arm it. `watchMaxWaitMs` bounds continuous writes, but time behind an in-flight tick does not count toward that cap.
- Watch policies must match scanner boundaries without losing supported links, dynamic discovery or overlapping sources. See [Claude Desktop](providers/claude.md#retained-claude-desktop-usage) for its traversal rules.
- Windows native watchers may miss changes to external file-link targets; polling or a later scan provides coverage. Smart mode can wait until hourly reconciliation.
- Never watch self-synced tokscale caches; watch native sources instead. Ignore self-scan SQLite SHM events while retaining database/WAL events. Custom roots prune dependency/VCS trees only from watching; full scans still cover them, and built-in roots take precedence.
- Every host/fallback creates watchers through `openWatch()`. Polling admission counts the actual chokidar traversal, including symlinks, under the effective environment-selected mode and `WATCH_POLLING_ENTRY_LIMIT`. Descriptor exhaustion switches to sticky polling; an unconfirmed old watcher exit must never open a second native descriptor set. If polling is forbidden or over budget, report the diagnostic and use interval mode; Smart mode must not await events from a nonexistent watcher.

### Self-sync

The collector owns one `selfSyncThrottle.js` instance shared by provider self-syncs and supplies their binary resolver. It resets with the collector; cancellation during replacement is not a provider failure. `forceSelfSync`, `sourceSelfSync` and `todayOnly` are independent: forcing a sync must not downgrade a full scan. Keep the floor and catch-up deadline centralized. Source details belong in [Cursor](providers/cursor.md#self-sync-and-sessions) and [Antigravity](providers/antigravity.md#source-roots-and-self-sync).

### WSL

`src/shared/wslUsage.js` scans only running distros, serially, after checking the Windows WSL registry key; never start a stopped distro or invoke the install-prompt stub on a machine without WSL. Merge before deriving client status. WSL refreshes only on full ticks and remains frozen in `wslAnchor` between them, preserving exact native deltas; host watching does not extend into WSL.

### Subprocess lifecycle

`SIGTERM` requests termination; it does not establish exit. Aborts, timeouts and pipe failures hold the replacement barrier until `close`, escalating to `SIGKILL` when needed. A bounded final grace reports `subprocess-termination-unconfirmed` instead of deadlocking; generation fences still reject late output.

On Windows, tokscale scans and Antigravity syncs are lowered to below-normal priority right after spawn (`subprocessPriority.js`) to reduce CPU competition with foreground work. A subprocess still running after 10 seconds attempts to restore its starting priority, limiting prolonged low-priority delays under sustained CPU load. A subprocess that starts at below-normal or lower priority is left alone. Both adjustments are best effort and never fail collection. macOS and Linux retain their starting priority because unprivileged processes generally cannot restore a lowered nice value, which could delay collection beyond its timeout under contention.

Failed usage reconfiguration restores the last-known-good runtime and retries the latest desired settings with bounded backoff. Exhaustion is reported; a newer setting starts a fresh retry budget.

### Usage worker

`src/shared/usage/usageHost.js` moves collection, transforms and session-archive writes off Electron's main thread. Its summaries are already transformed (`{ transformed: true }`); `DeviceRuntime` must not transform or archive them again.

- Replacement and archive clearing wait for worker exit, preventing overlapping collectors, descriptor sets and archive writers.
- After a transformed worker delivery, Electron releases its cold-anchor archive and SQLite connection without deleting persisted rows. In-process fallback must fully reload the archive and revision before capturing.
- Widget previews read snapshots from their own store without capture, migration or pruning. Archive read/write failures reject normal widget and headless publication; external-agent reads use the same strict rule, and genuinely empty archives remain valid. Failed cold-anchor reads skip publication. Headless `--dry-run` uses best-effort reads, which may fall back to an empty archive, and writes neither the archive nor Hub data. Remove the private scan-completion hint before publication.
- `sessionUsageArchiveStore.js` streams archive rows and captures the revision before scanning. Publish loads/revision changes only after cursor completion, and close failed cursors so retries cannot publish partial archives or skip concurrent writes.
- `USAGE_TRANSFORM_SETTING_KEYS` is the worker's settings contract. Send saved patches before the reconfigure delay and resolve `settings:update` only after acknowledgement, so a completed archive pause guarantees no further capture.
- Worker failure reports `usage-worker-failed` and pins subsequent runtimes to the in-process fallback; `TOKEN_MONITOR_USAGE_WORKER=0` selects it explicitly.
- Quit cannot wait for a responsive worker. All worker subprocesses must use `createSubprocessTermination()` so the shared live-process table lets main's `stopAll()` signal them synchronously.

## Limits collector

`src/shared/usage/deviceRuntime.js` separates usage from limits. `LimitsRuntime` owns scheduling, bounded concurrency, per-provider latest-wins lanes, deadlines, backoff and last-good/last-attempt retention. Credential changes refresh only the affected lane, without restarting usage; provider exceptions are documented in their notes.

- Fixed/adaptive mode is separate from the interval value. Local token usage never triggers a limits refresh, and `burn-rate` never bypasses cooldowns. Manual refresh waits for usage while limits run in the background; successful button feedback is not proof that every provider succeeded.
- `limits/collector.js` dispatches through `limits/registry.js`; require-free provider `account.js` leaves declare account/credential metadata. Main-process `electron/limits/accountSettings.js` binds normalization and redaction. Forms receive serializable display/action DTOs, never store paths, resolvers or secrets.
- Only registry-declared forms may save credentials. Probes use the injected transport with write-backs disabled. Reject incomplete, invalid or unauthorized drafts; persist a probe-renewed credential instead of its stale input. Forms declaring mutually exclusive credentials replace saved siblings in main; other multi-credential forms retain partial-write semantics. Fixed-credential saves use `applySettingsPatch()` for ordinary invalidation/reconfiguration; managed account services can reuse the same validator with an injected commit callback, then own credential/metadata transactions and account-scoped invalidation. Same-provider revisions discard superseded probes.
- Missing identities in mixed results retain last-good data. Only explicit internal removal markers retire known accounts; consume those before normalization so they never enter the wire record.
- Account-keyed probe results may supply internal `invalidateCachedWindowLabels` to discard specific last-good windows whose interpretation is no longer trustworthy. Consume it before normalization; it never enters snapshots or the wire record. When such a partial result supplies current windows, retain non-invalidated cached windows absent from it; an explicit empty label list retains all absent windows. Retaining a credits window also retains its associated balance when the current result has none. If any cached windows remain, the combined row keeps the old `updatedAt` and reports `unavailable`: row-level freshness must not promote retained values to new measurements. Retry and burn sampling use the committed status. Ordinary transient failures keep the remaining last-good windows, and generic failures cannot invalidate a provider lane.

`limits/core.js` owns normalization. It has no directory index because the Worker imports it as ESM. `limits/providers.js` and `limits/balanceDisplay.js` also support renderer script loading; keep that portable boundary.

### Outbound transport

`src/electron/limits/fetch.js` injects the same transport into collection and credential probes: env-proxy-aware `outboundFetch.js` when configured, otherwise Electron `net.fetch` for OS proxy support. Providers must preserve an injected fetch; custom transports do not inherit these guarantees and must be documented in the provider note.

Under Chromium, never set `Host`, keep `credentials: 'omit'` so browser cookies cannot shadow provider-managed cookies, and expect cross-origin `Referer` paths to be cancelled without a suitable `referrerPolicy`.

### Balance quotas

`windows[].metric === 'credits'` identifies a money quota with `remaining` and `currency`. `src/shared/limits/balanceDisplay.js` owns display across Home, tray and limits views; use the marker, never a provider whitelist. Derived top-up percentages remain display-only, outside the wire shape. Callers may explicitly disable balance inference for wallets without a quota denominator; `showMeter: false` alone does not change existing display-layer estimates such as Sub2API's.

## Session relationships

`client:sessionId` remains the accounting key. Verified `t3ThreadId` and Codex `nativeSessionId` may join runs for presentation without replacing it. `parentSessionId` and optional `parentClient` are one atomic link; absent `parentClient` means the child's client. Normalization, archives and sync retain verified identities and reject conflicting device evidence. Missing parents never create usage.

Native links precede T3 evidence. The [relationship reader](../src/shared/t3SessionMetadata.js) verifies provider, thread and execution-root ownership; the [identity bindings](../src/shared/t3SessionIdentity.js) normalize supported UUIDs but match opaque ACP IDs exactly. Human forks, weak identities, conflicts and unknown/incompatible executables remain unbound. Relationships read no conversation content and do not broaden title consent.

Metadata upgrades preserve counters and `fullScanAt`, persisting identities and links before advancing their version. Transient reads apply no partial relationship facts and leave upgrades retryable; corrupt/unsupported stores wait for full scans rather than repeatedly upgrading history.

Sessions, Home and Edge Dock group the complete member set before applying display caps. Count each accounting member once and distinct delegated conversations separately; derive activity/token availability from all members. Grouped calls, cache-hit percentages and generation speed use all accounting members; context and prompt-cache estimates remain specific to the latest main member. Recheck activity at the current clock, including expired-lease transcript fallback; never cache groups across pushes or expiry. Cycles/conflicting parents retain all members with distinct group identities. Provider-specific grouping and visibility rules stay in their notes and renderer tests.

## Session title display

`sessionTitlesEnabled` defaults on and affects Electron presentation only. `src/electron/sessionTitleDisplay.js` hides titles from snapshots, all-time pulls and detail headings without changing collection, metadata caches or local archives. Sync consent is independent, defaults off, and requires the [shared sync protocol](#shared-sync-content).

## Windows Edge Dock material

Windows 11 Edge Dock uses a single helper with HostBackdrop clipped to the renderer's curves; HWND-wide Acrylic/Accent cannot preserve the concave outline. Electron owns input. Native underlays stay disabled, nonactivating and directly below their content windows.

Share renderer curves at physical display scale and position against `GetWindowRect`, not rounded Electron DIP bounds. Unchanged hover updates must not re-show underlays. Lower the tinted fallback only after native attachment succeeds; a failed generation retries only after all its surfaces are disposed. EOF, parent exit and content-window closure must remove native windows.

Local Windows development requires `npm run build:windows-dock`. Packaging builds the helper with the OS .NET compiler/WinRT metadata and includes it outside ASAR, so Windows artifacts require a Windows build host. User-facing material settings are covered in [configuration](configuration.md#widget-gui).

## Native tooltips

Electron surfaces and the system tray do not show OS-native tooltips on any platform. Use accessible labels for controls and descriptions for supplemental metadata rather than HTML `title` attributes; SVG chart descriptions use `<desc>`. Keep app-rendered detail tooltips for quota and chart information. Reduced-motion overflow text remains manually scrollable instead of falling back to a native tooltip. This also avoids native tooltip windows remaining over other apps when a floating surface hides or changes input handling.

## Notch presentation

The experimental macOS Notch owns its fixed pages under `renderer/notch/` and shares data projection, formatting, account-title and plan semantics, and Home's compact window order (`homeOverview.compactWindowRank`) with the other surfaces. Stored `notchItems` now selects only limit providers, their order, hidden accounts and the Codex account policy; old usage items and pinned windows are ignored. `notchSummaryMode` defaults to `sessions` and deliberately does not convert the old follow-tray flag. The panel uses one shell renderer; details live in its fixed pages rather than a separate hover window. Attached glass uses the camera scrim as its only tint layer instead of adding the native tint again. Automatic quota alerts rank and display the tightest metered pool of the shared headline account; hidden or unselected accounts do not supply alerts.

The resting Notch window passes the pointer through with moves forwarded, and takes input only while the pointer is on the visible entry, as the Edge Dock handle does. Do not bring back a system-wide mouse monitor: the click-through window let each observed click reach the app beneath as well. Vertical page wheel events carry no gesture phase, so those swipes tell momentum from a new swipe by reversal and by a rise after decay; a plain time gap blocks back-to-back swipes. Horizontal swipes use an application-local AppKit monitor filtered to the open Notch window; other scrolling stays in Chromium. Native code owns tracking and callback lifetime, the controller gates delivery, and the renderer owns navigation and previews.

Attached Liquid Glass updates the native camera scrim and outline together; a failed native update must immediately restore the SVG fallback. Hover geometry and summary content share the same animation progress; content scaling must preserve camera clearance even during spring overshoot. Visual transforms must not change measured summary widths.

The seven-day chart takes its newest bar from live Today accounting and past days from History (`notch/history.js`). A missing day stays unknown, and reads as zero only when the transport is available and every joined device answered for its History. The answer is dropped when the backend generation, local date or History enablement changes; a new revision keeps the previous answer until the reload lands, and remote reloads are throttled to one a minute.

## Widget mode switching

`settings.hubMode` selects the source: `local` uses the local IPC collector; `client` uses Hub SSE plus this device's sync collector; `host` adds an embedded Hub; `icloud` uses local collection and iCloud file reconciliation instead of SSE. A live agent PID suppresses widget Hub uploads and owns the local daily-history archive. The agent has no iCloud sink, so the widget must still publish its iCloud record while yielding archive writes.

**iCloud identity and deletion.** Main persists former Device IDs across mode/ID changes; `icloudSyncRuntime.js` cleans them only after publishing the replacement. Failed publication leaves the former record visible; failed cleanup retries after restart. Until confirmed, aggregate one visible former identity rather than double-counting old and new records. `icloudSync.js` retains revisions and this writer's complete deletion targets locally; losing those targets on restart could resurrect deleted devices. Older ledgers cannot overwrite an unreadable deletion snapshot with an empty one. Tombstones hide records, not erase cloud files.

Manual device removal requires a known remote device marked stale in main's latest fetched stats; internal identity cleanup is separate. iCloud rechecks the current file before tombstoning. Hub deletion remains unconditional, so the main-process eligibility check and deletion are not atomic.

**Publication and activity.** `statsPublisher.js` owns whole-tree publication; `deviceState.js` owns immutable accounting parts.

- Client mode batches local/Hub updates into one publication per second, favors Hub reasons, and flushes before connection-status delivery so a delayed event cannot undo a disconnect.
- A local record overlay is not proof of upload. Preserve the Hub's receipt time as presentation-only `hubReceivedAt` (null before receipt), outside DeviceRecord; device freshness uses the backend's stale flag.
- Live activity is a separate, serial, generation-fenced lane with bounded source watching and periodic reconciliation, including interval mode. Events arriving during reads/ticks are retried. `sessionLive` owns leases and transcript fallback; provider registration and identity checks belong in the [activity adapter contract](providers/README.md#adding-a-live-activity-adapter). Process identity must verify liveness, not merely a reused PID; failure stays unverified.
- Immutable `period.sessionActivity` overlays share accounting maps and bypass scans, archives, aggregation, full-summary IPC and uploads. Ordinary publication materializes `liveActivity`. Activity has its own clock and must not advance the accounting date/timestamp. Zero-token `nativeSessions` stay local; unarchived usage identities take precedence per period. Discovery/caches are bounded, with no recursive history watcher.
- Reads, pushes and activity patches use one stamped snapshot. Concurrent pushes supersede reads only within the same Hub source/generation; reads preserve transport status. Future peer timestamps cannot beat current local activity, and later remote aggregates must not erase fresh local observations. Live status may replace archived status without replacing archived counters.

**Snapshot identity.** Published records are immutable because presentation and normalization caches key on object identity. Replace objects, never mutate in place. Main composes all-time detail on demand from the requested snapshot's captured inputs: per-publish summaries omit it *before* normalization. `rendererStats()` strips device sessions/projects and all-time sessions from IPC; `stats:allTimeSessions` resolves the requested snapshot ID, retaining its source generation. Completion must never combine newer `latestStats`/`lastCollectedDevice` accounting rows with older totals or cross generations. The renderer's `allTimeSessions.attach()` reuses its previously pulled session map on newer stats from the same source until a fresh pull arrives; neither attachment nor late pull results may cross source generations. Do not widen every push for a new detail reader. Bounded local identity projections, such as Grok Bot membership, must not force all-time completion or expand the wire record. Apply title hiding after activity joins.

## Settings and credentials

- **Configuration.** `loadDotEnv()` never overrides existing process variables. Node entry points load the root `.env`, Electron only when unpackaged, and Worker uses deployment bindings. Agent/Hub precedence is CLI flag → env → default where a flag exists; there is no JSON configuration file. [`.env.example`](../.env.example) is the operator contract.
- **Storage.** Widget preferences/account metadata live in `userData/settings.json`; raw GUI credentials live in `userData/credentials.json`. The store is plaintext with POSIX `0600` or Windows userData ACLs, not protection from same-user processes. Agent and standalone Hub never read it.
- **Redaction.** Renderer settings are default-deny; raw credentials cross only through an explicit allowlist. Connection summaries expose the host, not URL credentials/path/query/fragment. Provider credentials and private cleanup contexts remain in main.
- **Registration.** Fixed credentials declare `storePath` in provider `account.js`; `CREDENTIAL_SETTING_PATHS`, refresh scope and renderer projection derive from it. Dynamic accounts use nested paths in the same store, never provider-specific stores. Migration verifies the new store before stripping the source; corrupt, unsupported or symlinked stores must not become empty replacements.
- **UI identity.** Device controls are keyed by Device ID within a backend/connection, never display name. A backend change resets them even if IDs recur; unrelated pushes preserve edits and pending confirmations. Client connection drafts survive settings/status pushes and panel changes until explicit cancellation or successful save without newer edits.

## Data flow contract

**Node Hub persistence.** Saves are synchronous by default; opt-in batching uses a fixed first-upload deadline without delaying API/SSE updates. Snapshots use compact JSON and atomic replacement. Device deletion, subscriptions, shared settings/title policies and startup title cleanup persist immediately; preserve their rollback contracts. Failed saves retain pending data for retry. File readers can lag and abrupt termination can lose pending updates; see [configuration](configuration.md) for options and operational tradeoffs.

**Node Hub shutdown.** `stop()` closes HTTP/direct-ingest admission before ending response-owned SSE streams, flushes before draining admitted HTTP bodies, and flushes again afterward. Force-close lingering connections after the drain timer; event-loop load can delay timers, so they are not hard bounds. Concurrent stops share completion; final-save failures reject without discarding pending data. Clear batch timers on stop and re-arm retained data on successful restart. Standalone signal handlers use this lifecycle and report failures. The [API reference](API.md) defines client-visible shutdown behavior.

`collectUsageOnce()` supplies usage. `DeviceState` combines it with the runtime envelope and limits; limits-only updates retain the usage `updatedAt`, and cold previews wait for a complete baseline. Hubs normalize device records with `normalizeDeviceRecord()` and aggregate on read with `aggregateDevices()`. Neither Hub needs provider credentials. The [API reference](API.md) defines the common Node/Worker wire contract.

Settings keys, env vars, CLI flags, endpoints and wire fields have external users: treat incompatible changes as breaking and plan migration. Stale devices intentionally remain in stats with `stale: true`; they are not silently deleted.

SSE broadcasts serialize each required frame once per fan-out; the Worker encodes only frames selected by subscribers, sharing each encoded chunk across peers. Stream-v4 peers receive revisioned JSON Patch deltas against one immutable shared broadcast baseline, with a full-frame fallback when a patch is no smaller. v3 retains timestamp-only `freshness`; older peers receive complete stats. Initial snapshots and slow-connection recovery remain per connection, followed by a full revision bootstrap before deltas resume. Client transport baselines stay independent of REST reads and local presentation overlays. Invalid/missing revisions reconnect for a complete snapshot. Both adapters bound slow-client writes and skip blocked heartbeats; a dirty connection recovers the latest full state rather than queued obsolete frames. Worker async broadcast reads keep one active read and one coalesced pending batch, preserving revision order without accumulating obsolete reads. A pending explicit mutation retains its full-snapshot requirement when later ingests join the batch. Explicit mutations always force full stats, including privacy revocation. See the [stream protocol](API.md#get-apistatsstream) for wire and recovery rules.

## Shared subscriptions

The account picker retains healthy readings even when a provider cannot supply a stable account key or display identity. Missing identity alone does not imply an unconfigured placeholder; known failed identities and saved bindings remain available independently.

Subscriptions are one list per selected backend, not deduplicated per-device copies: account keys differ across platforms and would double totals. `src/shared/subscriptionDisplay.js` owns presentation; Hub endpoints and iCloud snapshots own persistence.

- Hub writes use the `baseUpdatedAt` the editor opened with, returning `409` on mismatch. A queued write cannot retarget a refreshed base. Client/host local copies are caches; refuse offline writes rather than fork the list.
- Authenticated stats/SSE carry `subscriptionsUpdatedAt`; mismatches trigger a reread in the subscription lane, with bounded retry and no periodic polling. An absent stamp means no news. Keep `statsWithSubscriptionVersion()` outside Worker `getStats()`, which the public route exposes.
- iCloud chooses a whole-list winner by counter/writer ID among discovered files; edits must match that discovered revision. Refuse writes on unreadable/invalid files or unresolved newer own publications. This is not cross-Mac atomic CAS: unseen concurrent writes can both succeed, and the losing edit must be reapplied after propagation.
- A stable writer identity survives Device ID changes. Its ledger distinguishes reserved counters from published/in-flight ones and retains exact in-flight candidates for restart recovery; reservation gaps alone must not block writes. Legacy pending counters without candidates fail closed until visible. Local records remain set aside until the discovered winner contains them completely, without promising protection from later remote winners.

## Shared sync content

`src/shared/syncContent.js` defines portable model-alias/custom-pricing groups, integer revisions and title-policy generations. Upload only bounded, allowlisted groups, never `settings.json` wholesale. [The API reference](API.md#get--put-apisyncsettingskind) defines payloads: malformed input must not become an empty replacement, and never-written `null` differs from an intentional empty value. Pricing preserves unset versus numeric zero across all supported rates.

**Settings reconciliation.** Default-off choices are destination-bound. First enable previews the exact remote revision/local fingerprint and requires a local/server choice on conflict; opted-out devices keep local preferences. Editors pin their opening revision and destination through `syncContentBase`; stale or wrong-destination writes fail before local application. Install an adopted revision before the settings push so the renderer sees the pair. Adoption follows ordinary settings paths: pricing updates Tokscale and refreshes usage/history; aliases only regroup presentation. Authenticated revision markers invalidate caches but carry no group content. Worker public stats expose neither private markers nor titles.

**Desktop consent and recovery.** `electron/syncContentRuntime.js` owns optional selections independently of title display. CredentialStore binds an opaque random destination ID to the exact URL, credentials, mode and Device ID; renderer/preferences expose only that ID and host. Changed bindings and legacy verifier migration reset consent. Storage failure disables optional sending, preserves settings access and retries recovery.

- Before remote title admission, persist a private cleanup journal plus OFF/pending state. Consent and its committed-admission marker are saved atomically before journal deletion. Restart retries deletion of committed journals without revoking consent; uncommitted admissions remain cleanup obligations.
- OFF synchronously aborts pending uploads before disk/network work. Before replacing connection settings/credentials, durably save the old cleanup context and OFF/pending preferences. Refuse the transition if either write fails; keep the old connection and retry with sending OFF. Preference-only state writes must not depend on a successful secret-store write.
- Restart reconstructs OFF/pending state for unresolved revocation obligations. Keep cleanup credentials until remote OFF is acknowledged *and* pending-row removal is durable. Orphan journals are revoked again; missing contexts remain visibly pending. No scheme guarantees durable revocation when all storage writes fail, but the running process must stop sending immediately.

**Title admission.** Require independent server permission, sender consent, authenticated capability discovery and an enabled per-device policy with an exact ingest generation. Refresh permission for title-bearing uploads. Receiving OFF revokes sender consent; receiving ON invalidates capabilities without granting or erasing sender consent. Unsupported/failed negotiation sends usage without titles, and agent probes/uploads refuse redirects.

Disabling always advances generation, persists and immediately purges stored titles, including offline records; device deletion keeps a disabled policy tombstone. Server-disabled startup/read cleanup strips titles and invalidates enabled generations so later re-enabling cannot revive old tokens. Each ingest strips previous titles before restoring only this upload's permitted canonical titles. Preview/message/compatibility fields never cross; title consent/generation survive payload reduction and the reduced 413 retry. Exact bounds and negotiation behavior are in the [title-sync API](API.md#put-apisynctitlesdeviceid).

**Agent ownership.** `src/agent/titleSync.js` uses its own `agent-sync-credentials.json`, never the desktop store. Persist the exact revocation binding before admission; disabling or changing a binding moves it durably to cleanup before replacement negotiation. Cleanup runs before collection and on later uploads in bounded, rotating batches. Same-URL/device pending cleanup blocks title admission; unrelated destinations may proceed with authorized titles/usage. Storage corruption, errors or competing writers fail closed for titles, not basic usage. Process claims serialize overlapping launches without discarding the journal. CLI/env consent is a fresh declaration each launch; dry runs do not negotiate or access journals. State migration and uninstall are covered in the [agent guide](headless-agent.md#title-sync-state-and-migration). Revocation cannot remove exported copies or backups.

**Hub atomicity.** Node revision/policy checks and synchronous file writes cannot be separated by an await; persistence failure rolls back the in-memory candidate. Worker mutations share a promise lane and Durable Object input gate, with transactions for compound cleanup/deletion. Expected validation/CAS errors leave the gate before being thrown, avoiding a Durable Object reset that drops streams. Interleaved ingest, disable and settings writes must not bypass generation/CAS checks. Policies and shared groups stay outside device records and aggregation.
