# Desktop plugins

New authors: start with the [author quickstart](author-quickstart.md), then use this page as the API reference.

Plugins add local data, views, background checks and skins to Token Monitor. Each view declares its supported surfaces: Home, tray, Edge Dock, Notch or an optional main-app page. The user chooses which supported locations to enable. A tray-only, dock-only or Notch-only plugin never acquires a page automatically. A `page` view appears in the main app’s bottom-left view menu only after the user enables its Main app page placement; a detached window is a secondary action inside that page. The host owns window geometry and interaction with the desktop. Plugin code computes data in an isolated Worker; the host renders validated component trees or drawing commands.

Token Monitor includes the built-in System Monitor, installable [Token Pulse](examples/token-pulse/manifest.json) and [Sketch Pad](examples/sketch-pad/manifest.json) examples, separate plugin windows, and managed package/catalog workflows. It does not operate a public marketplace. Native controls and pointer/keyboard drawing remain supported. Authorized packaged HTML/CSS/JS can customize the original model, tool and device pages, Home cards, main/detached plugin pages, optional plugin settings editors, Notch plugin pages, and Edge Dock plugin cards/rail art; see [the authored-page contract](author-ui-options.md). There is no visual layout editor or authenticated service onboarding. See [validation and acceptance boundaries](validation.md).

## Try it

1. Open Settings → Plugins → Official. System Monitor ships with the app; Token Pulse and Sketch Pad can be previewed and installed from the offline catalog. Sketch Pad has a personal note, drawing canvas, pen controls, Undo and Clear; content persists in its private local store.
2. Review the exact source, version and permissions. Installation leaves code disabled; choose Allow and enable separately. Updates preserve grants and pause execution if they request more access.
3. Select placement buttons for Home, tray, Edge Dock and Notch. Their existing ordering controls still apply. Enable Edge Dock/Notch separately; choose built-in and plugin pages together in Notch settings. Pages beyond the left lane continue to the right of the camera; in-track arrows appear only when both sides are full.
4. Enable Main app page placement only for views that declare it, then choose the page in the main app’s bottom-left view menu. Open a detached window from that page when useful. Both share visibility demand; switching pages preserves session-local drafts and scroll.
5. Import a `.tmplugin` file with From file. Developer options also import a folder into managed storage or open the unmanaged authoring folder for explicit Reload.
6. Community → Manage sources accepts a user-added HTTPS catalog. Ordinary users do not need a public key. Optional Ed25519 pinning is advanced; Community remains Unreviewed. No external source is enrolled by the app.
7. Refresh a source to discover versions/changelogs. Preview and confirm every update. Roll back restores one saved compatible version; uninstall defaults to retaining data and removing placements. Applied skin colours and personal style remain.
8. Plugin content follows App appearance by default. Legacy `plugin-appearance.json` overrides are read-only and are not deleted or rewritten; author skin presets are supported.

Authoring folders are `<Electron userData>/plugins`; plugin data is separate at `<userData>/plugin-data/<id>.json`. Managed metadata/previous packages live under `plugin-manager`, source settings/cache under `plugin-catalogs`, and read-only legacy appearance overrides in `plugin-appearance.json`. Unmanaged developer folders still need manual removal and Reload. Removal of a managed package does not require its manifest/code to remain valid. Rescue rollback can discard an unreadable current version rather than save a broken reverse rollback; it does not reverse data migrations.

Build a package without publishing it:

```sh
node scripts/build-plugin-package.js docs/plugins/examples/token-pulse /tmp/token-pulse.tmplugin
```

The version-1 JSON envelope contains `format`, `manifest`, optional bundled `code` and an optional `assets` map for declared Rich UI files. Limits are 2 MB encoded package, 256 KB manifest and 512 KB code, shared with runtime loading. The installed manifest is written compactly within its verified byte limit. `engines.tokenMonitor` is checked during import and runtime discovery; incompatible installed plugins can still be removed or replaced by a compatible update. See [distribution contracts](distribution-design.md) for catalogs, source identity and transaction recovery.

To recover from a faulty plugin, turn off the plugin or the **Enable plugins** switch in the Installed tab’s **More plugin actions** menu. The master switch pauses all plugins without changing their individual selections; the same menu also contains plugin information. `--plugins-safe-mode` or `TOKEN_MONITOR_PLUGINS_SAFE_MODE=1` prevents all plugin activation on startup. A plugin which repeatedly fails can be re-enabled explicitly after its code is repaired.

## Smallest declarative plugin

Create `cpu-readout/manifest.json`:

```json
{
  "id": "cpu-readout",
  "version": "1.0.0",
  "tmApi": "^1",
  "name": { "en": "CPU readout", "zh-TW": "CPU 負載" },
  "permissions": ["sys.cpu"],
  "views": [{
    "id": "load",
    "title": "CPU",
    "icon": "cpu",
    "surfaces": ["home", "edgeDock", "tray", "notch"],
    "compact": { "label": "CPU", "value": { "$": "sys.cpu", "fmt": "percent" } },
    "layout": { "type": "stat", "label": "CPU", "value": { "$": "sys.cpu", "fmt": "percent" } }
  }]
}
```

No process is created for a declarative plugin. The data bus samples each source once at the fastest cadence requested by its current consumers. Views request samples only while visible; background rules are separate, explicitly enabled consumers. New installations default background activity off; hiding, disabling or removing the last consumer releases the shared sampler.

## Manifest and views

The authoritative validators are [`manifest.js`](../../src/shared/plugins/manifest.js) and [`viewSpec.js`](../../src/shared/plugins/viewSpec.js). `id` is a stable lowercase identifier; views use `<plugin-id>/<view-id>`. Version and API compatibility are validated before activation. Names, descriptions and component labels can be strings or locale maps with an English fallback.

`page` is an optional capability, not a requirement for a plugin. Page placements default off and are stored locally in `pluginMainPages`, independently of Home, tray, Edge Dock and Notch. Disabling a plugin removes its pages from navigation while retaining the user’s placement choices; removing a page from display returns to an available built-in view. Main and detached windows union their visibility demand, so hiding one never suspends the other.

`layout` is a default component tree. `layouts.home`, `layouts.edgeDock`, `layouts.notch` and `layouts.page` override it for each surface. `compact` provides the rail/tray label, value, caption and tone. `tray` can provide text, an icon and a drawing list with its own width; the menu bar remains a host-rendered bitmap.

Components include `stack`, `stat`, `meter`, `ring`, `sparkline`, `bars`, `text`, `badge`, `icon`, `rows`, `draw`, `spacer`, `divider`, `button`, `toggle`, `slider`, `select` and `input`. A `stack` arranges children in rows or columns. All properties, nesting, item counts and text lengths are bounded; unknown properties cannot become DOM attributes or CSS.

Bindings use `{ "$": "source", "field": "property", "fmt": "percent" }`. An `@metric` refers only to a metric published by this plugin. `history` selects a bounded sample history for charts; it is a sample sequence, not a time-weighted series. Formats are `number`, `percent`, `bytes`, `compact`, `duration`, `text` and `rate`. Tones are semantic names: `default`, `muted`, `accent`, `chart`, `ok`, `warn`, `bad`, `info`. A binding can choose a tone using threshold `steps`.

Free drawing uses `rect`, `circle`, `line`, `arc`, `poly`, `path` and `text` commands in a declared coordinate box. Colours are semantic tones or validated hex values. Scripts, URLs, images, external fonts and arbitrary SVG markup are not accepted. Supply ordinary text/stat components alongside a drawing so its information is also available without interpreting the chart.

`skins` contains named `colors` (`accent`, `chart`, `bg`, `text`, `muted`) and optional `vendorColors`, all `#rrggbb`. A skin follows the existing theme settings contract and does not inject stylesheet rules. Optional `appearance` contains finite `font` (`inherit`, `system`, `mono`), `density` (`compact`, `standard`, `comfortable`), `corners` (`square`, `rounded`, `soft`), `panel` (`plain`, `outline`, `soft`) and `colors` (`accent`, `chart`, `text`, `muted`, `background`). These tokens style plugin content, including main-app pages and detached windows; they do not replace app navigation, window geometry or tray layout. A style-only preset may omit palette colours. Previously saved appearance overrides remain readable after a plugin is removed; there is no separate personal-style editor.

## Interactive content

Code plugins can declare an accessible `label` and a unique `action` per layout on `button`, `toggle`, `slider`, `select`, `input`, or `draw`. Register that action with `tm.onAction`. Read-only plugins cannot declare actions. Main validates the sender's current surface/page, demand, Worker revision, control type, disabled state, value range and option membership before forwarding a whitelisted event. Host controls preserve DOM identity, focus, draft text and pointer capture across live metric updates.

```js
tm.onAction('note', async ({ value }) => {
  await tm.storage.set('note', value);
  tm.publish('note', value);
});
```

Text inputs accept a declared `maxLength` up to 1024 JavaScript string units. Their bound values stay raw: display formatting does not truncate the draft or treat a literal `—` as missing. A `text` metric is capped at 200 characters; for a longer editable value, publish an `object` metric such as `{ note }` and bind its `note` field. Enter commits through the native change/blur path; ordinary live pushes preserve an unsubmitted draft.

Buttons send `press`; the other controls send `change` with a boolean, number or text value. Sliders require literal finite min/max/step; selects declare up to 32 options. A draw action receives bounded `pointerdown`, `pointermove`, `pointerup`, `pointercancel` coordinates in its own declared box, or a `key` from arrows, Enter, Escape and Space. Pointer movement is sampled at about 20 events/second; terminal events are not throttled by the renderer. The tray stays a bitmap and has no control events. Compact rail cards are read-only; use their full view or a plugin page for controls. Authors must implement a keyboard path for interactive drawings, as Sketch Pad does.

Main allows eight outstanding actions and a bounded event rate per plugin. A handler that remains unfinished for 30 seconds is stopped by the periodic supervisor and uses the existing restart/backoff policy. A successful send acknowledges dispatch, not completion or disk durability. Host actions do not expose arbitrary app commands. Plugin code remains responsible for its own behavior and saving state; ticks and actions can run concurrently, so authors should share an initialization promise when loading saved content.

Users can edit the supplied note/drawing controls and each plugin's declared settings in the UI. Creating a new control layout or arbitrary plugin logic still requires editing a manifest and bundled JavaScript, importing/reloading it and consenting. There is no drag-and-drop page builder or access to the host DOM, CSS selectors or unrestricted desktop capabilities. Authored web documents use their own HTML/CSS/JS and package-local images/fonts inside a separately sandboxed renderer.

## Sources and permission grants

| Source | Permission | Payload |
| --- | --- | --- |
| `sys.cpu` | `sys.cpu` | Busy percentage across logical CPUs since the previous sample; the initial sample establishes a baseline |
| `sys.memory` | `sys.memory` | `{ used, total, percent }`, byte counts plus percentage |
| `tm.today`, `tm.month` | `tm.usage` | `{ tokens, cost, unpricedTokens }`; cost is the known USD subtotal |
| `tm.rate` | `tm.usage` | `{ speed, burn, idle }`; the existing matched-counter generation speed in tokens/s and consumption rate in tokens/min |
| `tm.limits` | `tm.limits` | Tightest known metered quota window per provider, without account identity |
| `tm.sessions` | `tm.sessions` | `{ running, waiting, clients }`; no titles, paths or transcripts |

This legacy bus excludes credentials, account keys/emails, session titles, transcripts and raw device records. The separately granted business API below can expose allowlisted identity fields; it never exports credentials or raw host records. Unknown quota percentages stay unavailable. A quota percentage is never converted into token usage. Aggregate app readings follow the currently selected local/Hub context.

`notify` permits host notifications. `network` permits brokered HTTPS requests only to the declared `network.hosts` (exact hostnames or a leading wildcard). The consent UI highlights read access combined with a network destination. Adding permissions or hosts pauses the updated plugin until approved. Effective access is the intersection of the current manifest and the stored grant.

The host uses an isolated, cookie-free transport with the app's proxy policy. Requests have bounded size, concurrency, timeout and rate; redirects are returned without following them. This is a destination allowlist, not a public-IP guarantee: DNS, proxies and network routing still determine where an approved hostname connects. No credential picker or provider-auth forwarding exists.

## Business data and author preferences

Worker and Rich code share `tm.data.query(query)` and `tm.data.subscribe(query, callback)`; the latter returns a synchronous unsubscribe function and delivers an initial `snapshot` event, then coalesced `invalidate` events. Do not issue a duplicate initial query. On invalidation, `reset:true` requires discarding the displayed snapshot and traversal immediately (source or privacy changed). With `reset:false`, an admitted traversal may continue until expiry; authors can show a refresh affordance instead of jumping back to page one. New first-page queries use current data. These read the App's selected source, not a plugin-owned scan or provider request.

A query is `{version:1, resource, period?, filter?, sort?, page?, resolution?, groupBy?}`. Period is `today`, `month` or `allTime`; page is `{limit:1..500, cursor?}` (default 100); sort is `{field, direction:'asc'|'desc'}`. Filters and sort fields are finite and resource-specific; see [`normalizeQuery`](../../src/shared/plugins/businessData.js). IDs are opaque API IDs, not host account/device/session keys. Search and label sorting require identity permission. There is no SQL, arbitrary path lookup, join or host-settings export.

| Resource | Required grant | Actual projected coverage |
| --- | --- | --- |
| `usage`, `models`, `tools` | `tm.data.usage` | Period totals/components, known and unknown cost, model/client maps, tool-to-model relations and available throughput |
| `devices` | `tm.data.devices` | Opaque IDs, platform/runtime, timestamps, staleness, tracked clients and capabilities |
| `sessions` | `tm.data.sessions` | Accounting identity and opaque parent links, tokens/cost, model/provider relations, context, prompt cache and live activity; no messages/transcripts |
| `projects` | `tm.data.projects` | Canonical project identity, totals and model/client relations; omission flags affect coverage |
| `history` | `tm.data.history` | Retained daily/monthly/summary data, optional model/client groups; host retention still applies |
| `limits` | `tm.data.limits` | Normalized accounts/windows, quota/balance/reset/plan/status fields; no credentials or resolver metadata |
| `subscriptions` | `tm.data.subscriptions` | Selected-backend plans, calendar dates, amounts/top-up ledger and shared host derivations; balance forecast additionally requires `tm.data.limits` |
| `status` | `tm.data.status` | Available collection/sync state, client health and finite display preferences; not arbitrary diagnostics |

`tm.data.identities` additionally permits available session titles, project paths/labels, device names, account display identity/email and subscription notes. It does not override host scope, the user’s hidden-session-title preference, or restore fields absent at the selected source. Legacy `tm.usage`, `tm.sessions`, `tm.limits` and `tm.pages` do not authorize these resources. This is an allowlisted data interface, not a complete raw-data dump or a promise of every native derived display field.

Results carry `version`, `schemaVersion`, `snapshotRevision`, `availability`, `rows`, `pageInfo:{hasMore,nextCursor}` and `aggregateCoverage:{kind,totalRows,...}`; successful snapshots also include `asOf`, `collectedAt`, `freshness` and `redacted`. Coverage is `authorizedCollection`, `partial` or `unavailable`; row counts describe the filtered authorized collection, never a usage total. Cost is `{knownUsd,unpricedTokens,currency:'USD',completeness}`; null/unknown cost must not become zero/free. Handle unavailable/denied/scope/budget results explicitly. Native display grouping, live-rate decay and full system diagnostics are not promised by these DTOs; existing `tm.rate` and `sys.*` retain their own contracts.

All-time sessions never substitute Month quantities for lifetime quantities. Remote sync omits lifetime session detail: remote-only queries return unavailable coverage, mixed local/remote queries return partial coverage, and local device scope can return complete captured detail. History uses the existing authenticated resolver and may fetch the host history endpoint; it does not start collection or provider probes. Successful local subscription saves and current-backend cache commits invalidate subscriptions without waiting for another stats frame. History results and in-flight reads are shared by source/history revision, so activity-only pushes do not refetch the history endpoint. Query work has per-plugin rate/CPU budgets and shared authorized projections; varied searches do not each rebuild the DTO collection.

Session `parentId` uses the same opaque identity namespace as a session row, with `parentClient` for cross-client relationships. Missing, malformed or self-references are null. A valid parent can be absent from the current page or retained dataset; the API does not fabricate its row or expose its raw ID. Identity permission and the hidden-title preference still govern titles separately.

Subscription `derived` values reuse `subscriptionDisplay` and `limits/balanceDisplay`. The host captures `subscriptionContext:{date,rates}` with each publication; calculations use that reporting date and USD conversion map, never the plugin clock or mutable global rates. Changed effective rates and canonical subscription commits republish; limits changes invalidate dependent forecasts. There is no additional timer, sampling or provider request. `asOfDate` describes the captured calculation date, not proof that the balance was freshly collected.

- `status` is `available` or `unavailable`; `reason` identifies `missingContext` or `invalidRecord`. Unavailable derived numbers remain null.
- Calendar/payment fields are `active`, `nextRenewalDate`, `coverageEndDate`, `daysUntilRenewal`, `paidToDateMinor`, `monthlyAmountUsd`, `topUpTotalMinor` and `topUpMonthMinor`. Minor amounts retain the record currency; `monthlyAmountUsd` is USD major units. Missing conversion rates or unsupported currencies return null plus `monthlyAmountUsdReason`, never an invented USD value.
- These preserve host helper semantics: `active` is the coverage-stop predicate; the monthly equivalent is a per-record calculation even for inactive plans; the next scheduled renewal may follow `endDate`, while `daysUntilRenewal` follows the helper’s coverage-end calculation and can be negative. Top-up `paidToDateMinor` is zero by that helper's contract: use `topUpTotalMinor` for its ledger total. These are recorded/planned amounts, not evidence of bank transactions.
- `forecast` has `status`, `reason`, opaque matched `accountId`, `balanceUpdatedAt`, `currency`, `balanceAmount`, `dailyBurn`, `daysRemaining` and `exhaustDate`. Status is `available`, `denied`, `notApplicable`, `unmatched`, `ambiguous`, `unavailable` or `stale`. Numeric estimates are null unless available; zero burn can still leave remaining days/date null. Top-up forecasts require both subscription and limits grants, unambiguous host account matching and authorized account scope. Matching happens before scope filtering so hiding competing accounts cannot invent a unique match. Explicit host stale markers and non-OK provider state suppress estimates; no arbitrary age threshold is added. `balanceUpdatedAt` can be null. Authors must display its age/absence honestly. Forecasts estimate depletion from the existing top-up history and collected balance, assuming zero balance immediately before the first recorded top-up; they are not promised renewal dates. The plugin boundary rejects unknown currencies and ambiguous matches even where a native tooltip may use a display fallback. Matching work counts against the collection budget: an unusually large combination of top-ups and accounts can reject the whole query with `budgetExceeded`, not just omit a forecast.

Transient CPU/rate admission returns `availability:'rateLimited'` with `retryAfterMs`. Query-only callers may retry after that delay. A live subscription with the same query and authority receives a coalesced follow-up invalidation, even after data publication stops; refetch-on-invalidate clients need no polling. Privacy/source reset notifications keep the normal coalescing deadline rather than waiting behind rate debt, so clients can clear old content promptly. The delay is not a reservation: competing work can cause another throttle. Exact cached queries and cursor pages bypass expensive-work admission; projection cache hits avoid the fixed miss charge, while new filter/sort work remains metered. `budgetExceeded` describes collection or retained-capacity admission and is not resolved merely by rate refill.

Subscription callbacks receive `{type:'snapshot',version:1,value:<result>,sequence}` or `{type:'invalidate',version:1,snapshotRevision,sequence,refetch:true,reset}`. Bridge admission failures can deliver `{type:'error',error}`. Cursor pages must keep the same query and authority. Ordinary data publication preserves an admitted immutable traversal; source/grant/privacy changes, expiry or eviction require a restart (`snapshotExpired`/`invalidCursor`). Default retention is 60 seconds. First-page refreshes replace obsolete nontraversed snapshots. If Next races a refresh of the same query (including a sibling view), its first-page cursor can expire and traversal must restart. Once a cursor is followed, that traversal and its projection take priority over nontraversed caches during eviction; original expiry still applies, and capacity occupied entirely by traversals can evict the oldest. Session collections above 5,000 rows use a host-built compact index and per-page DTO conversion. The host scans and sorts in yielding chunks, retains the captured source values and applies the same identity, filter, ordering and coverage rules as small queries. This is not a new collector or a native-renderer pagination dependency. Authors continue using the same cursor API; virtual lists and incremental display are optional presentation choices, not workarounds for missing host data. Worker and Rich transports admit validated capability requests through bounded request/reply queues with payload and work accounting, separately from unsolicited-message flood limits. Authors do not need arbitrary sleeps between pages; concurrent request flooding still has bounded admission. Queued work rechecks authority before execution and delivery.

Large-session admission separates shared immutable source backing from authorized query indices. Source maps and unchanged copy-on-write rows are measured once and charged once across readers; each query retains its own authorized index. Incremental index construction is bounded to 32 MiB, per-plugin incremental work and retention to 64 MiB, and shared backing plus all incremental work to 128 MiB globally. Captured source generations also have bounded pin entitlements; old generations remain charged until their final reader releases them. Empty results release their source pins. This is conservative admission accounting, not a hard V8 heap ceiling: JavaScript temporaries and garbage collection can raise measured peak heap above the ledger. A record-rich collection can reach the byte budget before the row/work ceiling. In-flight work, total inspected data, retained memory and build duration remain finite; exhaustion returns an explicit unavailable result rather than a partial success or false end-of-list. Exact limits live alongside the service in [`lazySessions.js`](../../src/electron/plugins/lazySessions.js). Closing an owner or cancelling a subscription stops its pending work; shared work continues only for remaining authorized readers. Source/privacy/grant changes cancel old work immediately. Ordinary updates do not mix new records into an admitted snapshot. Host sources must remain copy-on-write while referenced; the host's first all-time completion still has a separate synchronous cost.

Other resources retain eager collection admission (up to 5,000 rows, 200,000 inspected nested entries and 8 MiB per projection). They return `budgetExceeded` rather than silently truncating; reducing page size does not bypass those collection bounds. All resources remain subject to per-plugin/global retained-capacity limits and snapshot expiry. Page payloads are bounded near 56 KiB, so fewer than `limit` rows can still have a next cursor. Oversized individual rows return `payloadTooLarge`. Strings cap at 512 UTF-16 units. IDs are isolated by plugin/source and stable only within the host identity epoch; do not assume restart stability. Sixteen subscriptions per owner and 128 globally are ceilings, not a reason to poll. Device-scoped history and unsupported scoped detail return `scopeUnavailable` rather than leaking aggregate data.

Declare `settings:{version,fields,migrations?}` in the manifest. Fields have `id`, localized `label`, `type` (`boolean`, `number`, `string`, `select`), `default` and applicable bounds/options. [Business Studio](examples/business-studio/manifest.json) is a complete example. The standard host form remains usable while the plugin/master is disabled; optional Rich editing is progressive enhancement.

- `await tm.settings.get()` returns `{pluginId,schemaVersion,storedSchemaVersion,revision,values,errors,status,readOnly}`.
- `await tm.settings.update({schemaVersion,expectedRevision,patch})` commits declared fields only and returns the committed DTO. Keep the revision at which a draft began. On conflict retain the draft and explicitly reload; do not automatically retry with a newer revision.
- `tm.settings.onChange(callback)` returns an unsubscribe function and receives committed preferences. Treat events as saved state, not permission to overwrite dirty input.

The complete public settings DTO is transport-budgeted before commit; oversized schemas/values fail rather than silently truncating. Settings are independent of `tm.storage` and display placements; they are local preferences, not a credential store. Invalid values are reported, corrupt/unreadable files are not silently reset, and a newer stored schema is read-only on downgrade. Declarative migration entries `{fromVersion,renames:{oldId:newId}}` copy only into absent targets and retain obsolete keys privately. Reads do not persist defaults/migrations. Authors must version semantic changes and cannot run migration code. Uninstall's keep-data choice applies to preferences too.

## Code API

Add `"main": "main.js"` and declare `metrics` with kinds `number`, `text`, `series`, `draw`, `rows` or `object`. The entry is one local JavaScript file; bundle dependencies into it if needed. There is no Node, DOM, dynamic import or ambient network access.

```js
tm.subscribe('sys.cpu');
tm.onTick(({ mode }) => {
  const cpu = tm.read('sys.cpu');
  if (mode === 'visible' && typeof cpu === 'number') tm.publish('load', cpu);
});
```

| API | Contract |
| --- | --- |
| `tm.apiVersion`, `tm.mode` | API major and current `visible`, `background` or `idle` mode |
| `tm.subscribe(source, callback?)` | Subscribe to a permitted source; callback receives new values |
| `tm.read(source)` | Last delivered value, or `null` before a reading exists |
| `tm.onTick(callback)` | Register a callback receiving `{ mode, now }`; returned promises are awaited and overlapping ticks are skipped |
| `tm.onAction(action, handler)` | Handle a declared control action. Receives `{ action, type, view, surface, ...validatedValue }`; async actions serialize within the Worker |
| `tm.publish(metric, value)` | Publish a declared metric; the host validates its kind and limits |
| `tm.storage.get/set/delete` | Promise-based JSON store scoped to this plugin, bounded to 256 KB and coalesced to disk |
| `tm.notify({ title, body })` | Rate-limited host notification, requiring `notify` |
| `tm.net.fetch(url, init?)` | Returns `{ status, ok, headers, text }`, requiring `network`; this is not a browser `Response` |
| `tm.log(...)`, `tm.warn(...)` | Bounded diagnostics visible in Settings |

`visible.intervalSeconds` selects a 1–60 second cadence (default 2). Optional `background.intervalSeconds` selects a 5–3600 second cadence (default 60). Background activity is off for new installations and starts only when explicitly enabled in plugin settings. Existing saved choices are retained. Declarative `alerts` use a 15-second cadence, sustained thresholds and cooldowns; see the [System Monitor manifest](../../src/electron/plugins/builtin/system-monitor/manifest.json).

When nothing needs a code plugin, host ticks, data forwarding and broker operations pause. The Worker can remain for a 30-second grace period before it is destroyed. Native JavaScript timers are not frozen by this policy; CPU limits/watchdogs still apply. Disable, loss of approval or the master switch destroys the process immediately and aborts outstanding broker requests. Old responses cannot be delivered to a restarted Worker. Reload flushes each plugin's pending store before replacing its owner.

## Isolation and validation

Each code plugin uses its own origin in a hidden sandboxed Electron renderer, with context isolation and Node disabled. The trusted host runs its code in a Worker. CSP, session request filtering, denied browser permissions/navigation/downloads, sender-scoped IPC and validated messages form independent checks. Plugin code cannot write UI markup or execute in the main process.

Watchdogs stop unresponsive Workers. Both host and main rate-limit messages. A rate-limited lifecycle completion or API request terminates that Worker through the existing backoff/circuit policy instead of silently stranding it; individual calls are not replayed. Every tick has a 30-second deadline independent of heartbeat health, and only its matching sequence completes it. The supervisor samples CPU and memory, restarts with backoff and opens a circuit after repeated failures. These are sampled resource budgets, not instantaneous OS memory caps. A fast allocation can transiently exceed a budget before termination; supported platforms need their own runtime verification. On macOS the trusted preload reports private memory as well as main's resident measurement, because compressed pages can disappear from the latter ([Electron memory semantics](https://www.electronjs.org/docs/latest/api/process#processgetprocessmemoryinfo)).

Explicit numeric ring caption bindings use the same Roll/Count formatting as stat values; literal captions are not parsed as numbers.

Run `npm run verify` for lint and unit/regression tests. Run `npm run verify:plugins -- --out /tmp/plugin-report.json` for actual Electron isolation, denied capabilities, shared sampling, background cadence, idle teardown, CPU/memory measurements and hostile-plugin fault containment. Unset `ELECTRON_RUN_AS_NODE` if your shell has set it. The script uses disposable user data and local fixtures; it does not alter the user's settings. It deliberately allocates memory and creates busy/flooding Workers.

See [validation notes](validation.md) for the tested platform, results and remaining native acceptance boundaries.


### Inheriting existing App motion

Authors may declare `motion: "inherit"` (the default) or `motion: "none"` on individual layout components and on each view's `compact` readout. This is an author API, not a new user setting. A numeric compact binding carries its unformatted value alongside its formatted text; the Edge Dock rail follows the App's Roll or Count mode using the existing digit roller and extracted Notch counter. Each readout can independently opt out, and user reduced motion wins. Literal text/IDs are not parsed as numbers. Initial display, rail reveal, missing readings and changed plugin revisions do not roll. Plugin pushes do not interrupt built-in readouts already animating. Compact rail typography uses the same display-font tokens as the built-in rail.

The same Roll/Count path also handles numeric `stat` values and default numeric ring captions in full plugin views on Home, main-app pages, detached pages, Notch and Edge Dock cards. Custom text captions are not parsed. Animation work is capped at 16 short readouts per mounted full view; remaining readouts remain static. Hidden/inactive views settle rather than continuing to animate. Detached windows receive only the public font and motion preference fields and use the shared font resolver. Tray text uses the existing bitmap text renderer and stays static, like built-in tray text.

Count uses the existing quartic interpolation from Notch, now shared in `tokenNumberAnimation.js`; rapid updates resume from the in-flight numeric value. Main resolution and intermediate frames share `numberFormat.js`, including locale, compact notation, units and precision. No formatted strings are parsed. This does not add chart-entry, canvas timelines or author-defined page transitions. Other existing host-shell motions remain owned by each surface.


### Plugin identity artwork

An optional top-level `identityIcon` is a `data:image/png;base64,...` string containing a static PNG (8-bit RGB or RGBA, non-interlaced), at most 64 KiB and 256 × 256 pixels. Use a square 128 × 128 export for best results. Only core image chunks and fixed-size sRGB/gAMA/cHRM/pHYs metadata are accepted; indexed/grayscale PNGs, APNG and SVG are unsupported. Export to RGB/RGBA if necessary. For example, set `manifest.identityIcon = 'data:image/png;base64,' + fs.readFileSync('icon.png').toString('base64')` in your build script before writing the manifest.

The image is embedded in the manifest, counted within the existing manifest/package budgets, included in the package digest, and retained through installation/update/rollback. No image URLs or extra network requests are introduced. Catalog entries may carry the same bounded `identityIcon` field within their existing index byte budget; the installation preview shows the actual downloaded package's icon. Images are decorative identity artwork, never a trust indicator: host-owned source and Unreviewed labels remain separate. Missing or undecodable artwork falls back to a host icon. Installed lists, catalog entries, details and package previews share the same image treatment; compact monochrome surfaces and view content do not gain arbitrary image support.

Notch page order is stored separately from visibility in `notchPageOrder`: built-in ids and `plugin:<plugin-id>/<view-id>` may be mixed. Drag the wrapped chips in Notch settings to reorder them, or use Alt+Left/Right and Alt+Home/End. A normal click changes visibility. Reset order restores the default ordering without changing which pages are visible. Disabled plugins disappear from the Notch page choices and runtime surfaces; their placement and ordering preferences are retained for re-enabling. Hidden or unavailable pages retain their relative ordering; the runtime filters unavailable pages before laying out the selected pages around the camera. Existing installations without an explicit order retain built-in-first order and their previous plugin sequence.

### Built-in System Monitor charts

System Monitor 1.1 uses its packaged Rich UI documents for the Notch overview and expanded Edge Dock CPU/memory cards. The compact rail, Home and main-app plugin page retain their declarative layouts. Existing installations require approval of the added `ui.web` and `tm.pages` permissions; no saved grant is silently expanded.

The plugin scrolls SVG curves along a continuous presentation clock with a 2.25-second buffer (one normal two-second sample plus jitter allowance). It reveals only segments between received measurements, stops at the last measured timestamp if data stalls, and does not raise the source sampling rate. Paths are rebuilt on data changes; animation frames only translate the existing paths. The presentation clock re-anchors after wall-clock changes or sleep; backward corrections start a fresh history epoch. It keeps a bounded two-minute timestamped history in its existing scoped store, breaks the line for unavailable samples or gaps longer than 15 seconds, and never fabricates measurements. Reduced motion settles the graph immediately; hidden/destroyed documents stop animation and release source subscriptions. Numeric labels show the latest reading directly in these authored documents; declarative Roll/Count remains on the fallback surfaces.

Run `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-system-monitor-rich-ui.cjs` for the real built-in package/bridge/animation and demand regression fixture. Its screenshots use synthetic readings in isolated native child views, not physical Notch or OS-composited acceptance.

### Opening a plugin view

Opening or selecting a declarative view immediately resolves the existing source readings after the normal grant, placement and visibility checks; the 250 ms throttle still applies to streaming updates. No extra sampling is performed for this initial delivery. Main-App pages retain their mounted renderer content, and detached host windows are reused while open. Tray content is a bitmap, not an authored web document.

Rich documents still initialize in an isolated renderer when opened. Floating surfaces reserve the authored content rectangle and suppress the intermediate declarative layout. Documents can prepare, invisibly, during an explicitly requested shell opening; the native controller alone authorizes reveal after its geometry settles. The preload waits for navigation and initial bridge promises (context, storage, subscription) to settle before offering presentation. It does not wait for arbitrary author timers or guarantee that an unavailable reading has arrived. Quick starts do not flash a loading label; after 200 ms the same reserved area shows the existing loading label. After five seconds or a load failure, the host cancels the child and uses the declarative fallback for that opening, without a late swap. Reopening permits a fresh attempt.

A visible floating-window resize hides and repositions the existing child instead of reloading it; failure to receive fresh geometry within 750 ms destroys it. Main-App breakdown pages keep their original content until the authored page is ready. A ready document hidden by navigation, collapse or hover departure may be retained for a default idle period of 30 seconds (overridable with `retainMs`), with at most three retained documents across main-App and floating surfaces and a sampled 256 MiB aggregate renderer resident-memory budget. Hiding immediately removes source and Worker-visible demand and rejects document bridge calls. The host freezes Chromium page execution through `Page.setWebLifecycleState`; author timers and animation-frame callbacks do not keep running merely to preserve the page. Reopening rechecks capability, revision, owner and placement, thaws the same document, delivers the current context/readings, and waits for an internal preload acknowledgement before revealing it. Unsaved DOM state can survive this short reuse window, but is not durable storage. Opening demand exists only while the user is actually opening a surface; cancelling it releases that demand. Stored cosmetic chart history can restore the graph on reopening. First-time code initialization, an evicted document and unavailable source data remain genuine loading states. Incomplete documents are never retained. Expiry, count/memory pressure, plugin disable/uninstall/reload, revoked grants/placements and owner destruction dispose retained documents. Freeze/thaw or resume acknowledgement must finish within 750 ms; unsupported or lost lifecycle control fails closed to destruction. The internal Electron debugger transport is held only during freeze/reuse and exposes no author API or remote port. An already attached debugger prevents retention. These are sampled process budgets, not instantaneous OS caps or a claim of zero memory/CPU use by Chromium itself.

Run `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-web-cache.cjs` for retained-document lifecycle, timer/animation suspension, shared demand, rapid reopen, revocation, count/memory eviction and real 30-second expiry checks. `TM_CACHE_BASELINE=/absolute/path/to/pre-change/webUi.js` runs a matched cold-reopen measurement against a saved controller; it does not replace feature source.

## Choosing rendering and retention

Both declarative and Rich UI remain supported on Notch and Edge Dock. Rich UI is optional author-owned HTML/CSS/JS; it is not a fixed component palette. Declarative rendering is usually cheaper for quick readouts and uses the host's controls, typography and animation preferences. Neither option bypasses permissions, placement selection or demand-driven sampling. See [the decision table and working examples](author-quickstart.md).

Each `webUi.documents[]` entry may declare `retainMs`, a nonnegative safe integer (milliseconds), or `"until-evicted"`. Omission keeps the 30000 ms default; 0 destroys on hide. `"until-evicted"` installs no idle-expiry timer; the host reclaims the frozen document when resources or capability changes require it. Numeric durations have no five-minute policy cap and are scheduled in timer-safe chunks. The timer starts on hide and resets after a successful reopen and subsequent hide. This is a retention preference, not a guarantee: the shared three-document / 256 MiB sampled renderer budget and capability revocation always take priority. Retained documents remain frozen, cannot use their bridge, and hold no sampling subscription. Authors must persist important state in `tm.storage`; DOM retention is not durable storage. No user-facing cache setting is added.

## Continuous declarative sparklines

A bound history sparkline can opt in with `smooth: true` and optional `windowMs` (1000–3600000, default 120000). Its history binding supplies measured timestamps through the host. Literal series retain their existing static rendering. `motion: "none"`, ancestor motion overrides and the App's reduced-motion preference disable movement.

```json
{ "type": "sparkline", "series": { "$": "sys.cpu", "history": 60 }, "smooth": true, "windowMs": 120000, "height": 96, "min": 0, "max": 100, "fill": true }
```

The viewport follows measured segments with a one-source-interval plus 250 ms presentation buffer; numeric readouts remain current. This does not interpolate new source samples or increase sampling frequency. Null readings and gaps exceeding the larger of 15 seconds or three source intervals break the line. A stopped source stops chart motion once the last measurement reaches the viewport edge. Hidden, inactive and removed surfaces do not keep animation frames running. At most 16 charts animate per mounted view. Clock corrections re-anchor presentation rather than accumulate permanent lag. System Monitor enables this for its declarative layouts while retaining its existing Rich UI documents unchanged.

Run `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-smooth-charts.cjs` for production-renderer motion/lifecycle checks and a matched static/continuous screenshot. Run `scripts/test-plugin-web-cache.cjs` with the same Electron launcher for per-document retention, expiry, freeze and revocation checks.

Author capability failures carry `message`, `code` and optional `fields`. Treat them as error records rather than relying on `instanceof Error`: the isolated Rich/host bridge preserves these fields as plain rejection records because Electron strips custom Error properties. Worker code reconstructs an Error with the same fields.
