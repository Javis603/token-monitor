# Plugin API

Token Monitor plugins run code you choose to trust (`tmApi: 1`). The App does not sandbox a plugin's access to your files, credentials or network. An integrity hash identifies bytes, not a security review. No official plugins ship with the platform; the repository's minimal fixtures are tests, not a store.

## Execution and trust

Author UI is an ES module loaded into the host renderer document. It can use DOM/CSS/JS, existing host elements and exposed renderer services. It does not receive Node `require`: Electron retains context isolation, disabled Node integration and its normal CSP. For filesystem, network, subprocesses or computation, declare an optional Node backend. It runs in an Electron utility process under the same OS user, with ordinary Node authority. It is not a credential-isolating sandbox. Formal data projections remain useful contracts, not a security boundary against trusted backend code reading accessible internal files.

Module-private variables and another process's memory are not automatically available. Direct access to internal files, database schemas or exposed services is unsupported coupling that authors must maintain. Neither the host nor a hash guarantees plugin safety. Same-page JS can freeze the renderer; the host cannot independently terminate it while preserving that renderer. Recovery reloads the renderer or restarts without plugins.

## Manifest

```json
{
  "tmApi": 1,
  "id": "my-panel",
  "name": "My panel",
  "version": "1.0.0",
  "ui": "ui.mjs",
  "backend": "backend.cjs",
  "css": ["panel.css"],
  "files": ["ui.mjs", "backend.cjs", "panel.css"],
  "views": [
    {"id": "panel", "title": "My panel", "surfaces": ["home", "page", "notch", "edgeDock", "settings"]},
    {"id": "layout", "title": "My layout", "targets": ["main.limits.content"], "mode": "replace"}
  ]
}
```

`ui`, `backend`, `css`, `views`, `trayMenu`, `settings`, `skins` and `background` are optional; at least UI, backend or skins is required. UI views require `ui`. List every distributed file explicitly. Paths are package-relative, portable and cannot traverse parents or symlinks. Dependencies must be bundled beforehand; installation never runs npm or lifecycle scripts. Native addons require compatible OS/architecture/Electron ABI, and utility-process loading must be tested in a packaged build; arbitrary addons are not universally supported.

`name`, `description` and view titles support localized strings. Optional `author`, HTTPS `homepage` and validated `identityIcon` provide attribution, not trust. `engines.tokenMonitor` can constrain the App version. `tmApi` identifies the plugin API contract, not the plugin release or package format. Only `tmApi: 1` is accepted; other values fail with `incompatible-plugin-api` and are not converted. This experimental API can break; authors must follow release changes.

Bitmap views declaring `tray` can be added from the existing Tray, Floating Bubble and custom Notch-summary composers after the plugin is enabled. They use the same reorder, duplicate, remove and save controls as native items. Notch “Same as tray” follows the active Tray layout; its custom layout stays independent. Uninstall with placement removal also clears bubble/summary entries and mixed Notch page-order entries. Keeping placements retains them for a later reinstall and explicit enable.

## UI lifecycle

Export `activate(ctx)` returning `{mount, renderTray?, dispose?}`, or export `mount` directly. `mount(container, context)` may be asynchronous and returns `{update?, dispose?, hasUnsavedChanges?}`. The host retains mounted controls during data updates and ordinary page switching where that surface retains its DOM. Do not assume every native surface retains nodes: dispose timers/listeners and persist important drafts. The same module activates once per enabled lifetime per renderer, not once globally across windows. After disable it is disposed; re-enabling calls `activate` again. Native JavaScript import caching can retain the module namespace, so do not rely on top-level statements rerunning. Put reusable initialization in `activate`.

`context` includes `viewId`, `ref`, `surface`, `container`, current backend `data`, and surface-specific values. Updates can include `visible`, width/height, selected period/source, native data and native content nodes. Do not start a new sampler for every mount. `ctx.onDispose(fn)` registers module cleanup; instance disposal owns mount-specific cleanup. CSS is loaded once per renderer/revision. Author CSS is free to choose its own look; host theme tokens are conveniences.

Context services:

- `ctx.backend.call(method, args)` returns the backend handler result or rejection.
- `ctx.backend.subscribe(callback)` observes published backend values and returns an unsubscribe function; the latest known value is replayed.
- `ctx.data.query(query)` reads a captured App snapshot.
- `await ctx.data.subscribe(query, callback)` returns an unsubscribe function. The initial callback is a snapshot; later invalidations indicate when to query again.
- `ctx.host.call(method, args)` invokes a formal host operation.
- `ctx.asset(path)` resolves a package-local asset relative to the UI entry.
- Host-specific `ctx.app`, `ctx.native` and `ctx.navigate` expose existing renderer services where available. They differ between main and compact windows; feature-detect them.

See [content surfaces and native composition](author-ui-options.md).

## Local backend

```js
exports.activate = async ({ dataDirectory, publish, host, log }) => {
  return {
    async call(method, value) {
      if (method === 'echo') return value;
      throw new Error('Unknown operation');
    },
    update(context) { /* selected host source, visible/background state */ },
    dispose() { /* stop timers, close connections, flush owned state */ }
  };
};
```

The backend is optional and starts on visible demand, an explicit pending call, or separately opted-in background execution. All locations of the same plugin share one process. The final demand disappearing stops it; teardown receives a cooperative grace period before termination. Startup and calls have finite deadlines. Failures remain visible until explicit restart; there is no automatic crash loop. A hidden UI can still have active JS because it shares the renderer: authors must honor visibility and dispose their own work. The host cannot promise that arbitrary trusted code stops all work merely because its mount is hidden.

`dataDirectory` is an App-managed plugin directory. Store private plugin preferences/files there; it is not a filesystem jail. `publish(value)` broadcasts structured data to UI instances. `host.call` uses the same formal host operations as UI. Backend dependencies and native modules are the author's responsibility. No host system-monitoring sampler is provided; plugins implement and share their own sampling.

## Host data and settings

Formal host methods are `data.query`, `settings.get`, `settings.update`, `app.context`, `app.settings`, `app.updateSettings` and `notify`. Host integrations may expose additional explicit operations. `app.settings` uses the existing public renderer projection; it does not intentionally return stored secrets. Plugin management is separate from generic settings updates.

Business queries use `{resource, period, filter?, sort?, page?}`. Resources include usage, models, tools, devices, projects, sessions, history, limits, subscriptions and status. Queries reuse captured selected-source data and existing history resolution, never initiate provider probes or duplicate collectors. Results carry `availability`, `rows`, snapshot revision, freshness, coverage and cursor metadata. Unknown cost is not zero. Missing lifetime/remote session detail remains unavailable or partial.

Subscriptions deliver `{type:'snapshot', value, sequence}` then coalesced invalidations with `refetch` and `reset`. Source/privacy changes require discarding the old traversal. Ordinary updates preserve admitted immutable cursors until expiration or eviction. Use the returned cursor with the same query; restart on `snapshotExpired`/`invalidCursor`. Query work and retained memory remain bounded to protect the App's data service; these bounds do not restrict a plugin's own Node work. Large sessions use yielding indexed pagination.

`manifest.settings` uses the existing versioned field schema and host form. `settings.get` returns values, schema and revision; `settings.update` submits `{schemaVersion, expectedRevision, patch}` and reports conflicts/field errors. The native form works while code is disabled. A custom `settings` view executes trusted UI and requires enablement. This plain JSON preference store is not a dedicated secret vault. A plugin may implement its own credential handling through its trusted backend; the platform does not advertise encryption it does not provide.

## Installation and recovery

[Installation, revision trust, atomic updates, rollback and catalogs](distribution-design.md) are independent of execution freedom. Install remains disabled; explicitly trust each executable revision. Reload discovers changed package bytes and requires approval before running them. Unchanged trusted code re-enables directly. Normal disable awaits mount/module cleanup and stops its backend without reloading. Mounts reporting `hasUnsavedChanges()` prompt before disable; cleanup failure or an unresponsive host offers recovery reload. Updates/removal still warn before reloading affected loaded hosts, so save drafts first. Rollback restores code, not arbitrary migrations a trusted backend performed on its data.

The native tray menu offers **Restart without plugins**. Alternatively launch with `--plugins-safe-mode` or `TOKEN_MONITOR_PLUGINS_SAFE_MODE=1`. Safe mode lists packages and permits management without starting author UI/backends. This recovery route does not depend on a responsive renderer. It cannot undo arbitrary filesystem changes made by trusted code.

No active plugins means no plugin backend, dedicated polling/sampler, or repeated business projection. Baseline imports/registration have a finite cost; byte-identical RAM or zero CPU overhead is not promised. See [validation](validation.md).
