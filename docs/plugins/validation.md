# Plugin validation

## Automated checks

Run `npm run verify` for lint and the Node test suite. Renderer and lifecycle checks use isolated Electron profiles and synthetic data; they do not start the user's primary app or publish packages.

```sh
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-settings-ui.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-settings-errors.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-action-errors.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-motion-ui.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-corrections-ui.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-notch-page-order-ui.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-web-ui.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-web-network.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-surface-web.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-web-cache.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-send.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-smooth-charts.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-system-monitor-rich-ui.cjs
env -u ELECTRON_RUN_AS_NODE npm run verify:plugins -- --out /tmp/plugin-report.json
```

Plugin settings errors stay in the panel that owns the action: package/operation confirmation, placement row or source form. The error fixture checks localization, accessible alerts, input/focus retention, retry and navigation cleanup using production renderer/CSS with synthetic API failures. Skin application errors also belong to their calling surface (plugin details or Appearance); Notch page changes and standalone-window failures stay beside their own controls. The action-error fixture exercises the production App callback wiring and save-failure form rebuild, retry and late-result cleanup. An Appearance failure must describe the equivalent rebuilt skin control; a failed Notch order reset must describe and return focus to Reset, while a successful reset may focus the first page after Reset disappears. Initial list-load failure must offer a local retry instead of an endless loading row. It captures normal and narrow widths; this does not replace native screen-reader or packaged-app acceptance.

The sandbox verifier deliberately creates flooding, busy and memory-consuming Workers; run it separately from `npm test`. Test reports, screenshots and frozen review manifests belong in local/CI artifacts and PR evidence, not the permanent author documentation.

The send fixture uses the production runtime, Worker and isolated Rich bridge. It checks settings-only action wakeup without ticks, idle process reclamation while settings remain open, handler results/errors and wire-limit rejection, metric updates, presentation during a pending send, and disable during an action. Captures show synthetic settings/search content, not packaged-app or external-network acceptance.

The network fixture uses the production Rich controller/preload and only loopback HTTP/UDP/TCP endpoints with synthetic TURN usernames. An unprotected positive control must reach both TURN endpoints; the protected document must send no packets while local CSS/SVG and its bridge still work. It covers both PeerConnection names and attempts through initial blank/detached frames. Re-run on Electron upgrades: neither CSP `connect-src`, browser permission denial, offline emulation, nor `disable_non_proxied_udp` alone is a complete WebRTC boundary. `TM_NETWORK_BASELINE` may point to a saved old `webUi.js` to demonstrate the regression without replacing source files.

## Business/settings integration checks

```sh
node --test tests/electron/pluginLazySessions.test.js tests/electron/pluginSessionSnapshot.test.js tests/electron/pluginCapabilities.test.js tests/plugins-business-data.test.js tests/shared/pluginBusinessDerivations.test.js tests/electron/pluginBusinessCache.test.js tests/electron/pluginBusinessAdapters.test.js tests/shared/pluginSettings.test.js tests/electron/pluginSettingsStore.test.js tests/electron/pluginPresentation.test.js
node scripts/build-plugin-package.js docs/plugins/examples/business-studio /tmp/business-studio.tmplugin
```

Use a fresh output filename for packaging. Manifest/package validation establishes declared targets, grants and asset loading, not an actual native mount. Original-page Rich visibility must follow the native loading/unavailable gate while genuine empty ready periods remain displayable. For Business Studio exercise initial snapshot without a duplicate query, next-page traversal, invalidation during an outstanding page, cursor expiry, source switching, denied/missing data and unknown cost. Save preferences from both host form and Rich editor; verify committed pushes, preserved dirty drafts, revision conflicts, restart, downgrade and disabled/master-off editing. Close/park/revoke one owner while another remains; no late delivery or duplicate sampler may survive.

App integration owns immutable selected-source publication, existing-cache adapters, bridge authority after awaits, owner cleanup, settings IPC errors and host presentation ownership. A plugin PR owns a bounded manifest, fallback layouts, accurate permissions, local assets, uncertainty display and draft/pagination behavior. App/API changes must land together before a plugin can depend on them; declaring `tmApi:1` alone does not prove an older App implements new optional methods. Gate distribution on a tested App version via `engines.tokenMonitor` once that release is known, rather than inventing a version. Prefer native forms/declarative views for low-cost controls; Rich UI buys layout freedom at additional renderer, focus and lifecycle cost.

Focused DTO/store tests do not establish Worker/Rich transport, native multi-window lifecycle, source adapter purity or packaged delivery. Record the commands actually run and any remaining checks in the PR, not timestamped reports here.

## Required behavior

- Installation verifies the exact source/version/hash and permissions. Updates cannot silently widen grants. Updates, verified rollback and removal must recover from a wholly missing managed directory without deleting retained user data. Existing-but-invalid packages retain their separate update policy; symlinks (including dangling links) and other replacement file types remain rejected. Missing-target interruption recovery must restore absence and the prior registry, backup and settings. Reload/restart must retain a management-only Installed entry for a missing package, with rollback/removal reachable and no enable control. Damaged-current-package previews must give recovery guidance; confirmation must still recheck changes made after preview. Exercise uninstall/reinstall with both retention options.
- Disabled plugins disappear from runtime surfaces without erasing saved placement/order preferences, including when visible Home modules are dragged while a plugin is disabled. Edge Dock plugin items need identifiable names and only applicable controls; adding beyond capacity must fail visibly without changing existing entries. Notch ordering and reset use shared drag behavior, maintain keyboard focus and avoid camera overlap at supported sizes/zoom.
- Multiple visible consumers share sampling. Hiding, disabling or removing the last consumer clears demand; only explicitly enabled background features retain their own demand. Rate-limit recovery must not leave a healthy-heartbeat worker permanently stuck in a tick. Initial live activation must not replay already-submitted top-level business subscriptions; cover a pending history query plus the full subscription allowance, later resume, and action-only startup.
- Authored pages cannot access host DOM, credentials, arbitrary IPC or unauthorized sources. Selection/save failure preserves the prior document and persisted selection. Owner close, reload and capability loss revoke active and cached documents.
- Hidden retained documents freeze timers/animation and release subscriptions. Author retention never overrides global count/memory limits or revocation. Long numeric retention must not overflow Node timers.
- Numeric motion and continuous charts respect reduced motion and author overrides. Charts retain missing-data gaps, do not invent samples or increase source cadence, and stop animation when inactive or caught up with a stopped source.
- Settings preserve focus, drafts and scroll across refresh. Safe mode must not overwrite the saved master preference. Built-in theme selection and interface-theme reset clear copied plugin appearance; individual color edits retain it.

## Outstanding manual acceptance

Local fixtures do not establish physical Notch/camera geometry, native hover/composition, menu-bar interaction, OS IME/trackpad, VoiceOver, Windows/Linux interaction, packaging/signing, or long-running resource/power-loss behavior. Validate these on the applicable platform before claiming acceptance.

A local unsigned macOS arm64 directory build verifies that packaged source, plugin assets, preloads and Worker bootstrap files are included unchanged. This is separate from packaged execution: the disposable sandbox launch reached main but Chromium sandbox/GPU initialization failed before a healthy GUI. Do not treat static ASAR checks or source-Electron fixtures as packaged runtime acceptance. Complete the packaged lifecycle in a disposable macOS account or test host compatible with Chromium sandboxing, then validate signing/notarization and other platform artifacts separately. Do not disable the Electron sandbox to turn a blocked run into a pass.

The cache fixture must synchronize again if its native owner is shown while a cold open is pending. A hide event correctly destroys an incomplete child; polling readiness alone cannot restore it. Independent load-barrier checks demonstrate recovery through the unchanged production surface adapter. Keep owner-show recovery, listener cleanup and the full expiry/owner-close/uninstall flow covered in the fixture.

Capture is a separate boundary: wait for resumed animation callbacks and require nonempty painted pixels before accepting a child screenshot. Both immediate capture and a later independent surface run have reproduced `UnknownVizError`. A frame-ready control succeeded in one diagnostic but another bounded frame wait timed out, so frame readiness is not a universal remedy. Keep capture reliability open independently of the corrected cold-open fixture; successful earlier full flows do not cancel later capture failures. Never skip failed capture to report the complete visual/lifecycle flow as passing. Child captures do not establish OS-composited visibility, layering or input behavior.

Official bundled listings plus user-added HTTPS indexes are the supported distribution model. A submission backend, staff moderation, ratings and remote revocation service are not acceptance requirements. See the [author guide](author-quickstart.md), [web/data contract](author-ui-options.md) and [distribution contract](distribution-design.md).

`env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-shared-runtime.cjs` exercises the production runtime and isolated preloads with synthetic host data: byte-bounded model pagination and complete traversal of more than 10,000 sessions, grants, host/author settings, real IPC conflict fields, hidden subscription release and warm restoration. It also checks same-plugin sibling refresh while another owner traverses page two, session-parent identity joins and subscription/calendar/balance derivations through the actual Rich bridge. It does not boot the collector or a user profile. The detached fallback probe first confirms that discovered asset bytes still load after the source file is removed, then injects a rejected navigation only into that plugin's real WebContents. It waits for production teardown and verifies scrollable fallback content and access to its last row; deleting an asset after discovery is not a mount-failure injection.


Large-session checks must traverse every cursor to completion and compare IDs, order and values with the small-query projection contract. Cover filters, equal sort keys, local/remote lifetime coverage, activity/accounting updates while building and paging, source/privacy resets, owner release, unsubscribe, revoke and dispose. A cancelled reader must not terminate a still-authorized sibling. Measure first-page time and event-loop progress separately from the existing synchronous all-time adapter; a yielding index alone is not an end-to-end latency guarantee. Memory/work exhaustion must return an explicit failure, never an apparently complete shortened collection. Host snapshot tests deep-freeze captured inputs and exercise actual composition/activity replacement to detect accidental in-place mutation. Check activity-only overlays in eager and lazy session queries, including old cursor retention. Cost completeness tests must run through real period normalization and device aggregation, retaining unknown results for absent costs or unattributed positive unpriced counts.
