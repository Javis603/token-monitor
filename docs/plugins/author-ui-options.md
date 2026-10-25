# Authored page interfaces

The plugin UI contract provides the lightweight declarative renderer and optionally mounts standard packaged HTML/CSS/JavaScript in a sandboxed `WebContentsView` for original App pages, Home cards, main and detached plugin pages, optional plugin settings editors, Notch plugin pages and Edge Dock plugin content. [Page Studio](examples/page-studio/manifest.json) demonstrates original-page snapshots, shared system readings and local storage; [Business Studio](examples/business-studio/manifest.json) demonstrates shared business queries, pagination and author settings across original pages, Home, plugin pages and a settings editor. Both are installable examples, not enrolled catalog entries.

## Original pages

`webUi.version: 1` declares up to eight documents. Each has `id`, `title`, package-local HTML `entry`, `target` (`model`, `tool`, `device`), `slot` (`before`, `after`, `replace`) and optional height (120–800 CSS pixels). `before` and `after` add a panel around the original content; `replace` replaces that page's content area. This is a public named slot contract, not access to the internal DOM. App navigation, period controls and a host-owned **App default** choice remain available. Built-in row/detail operations remain accessible in the original view. Only one selected document is mounted at a time. Selection is user-owned and retained across disable/re-enable; inactive or unavailable plugins fall back to the original page.

The plugin requests `ui.web` (execute an authored interface) and `tm.pages` (read the selected page's displayed model/tool/device names and usage). Installation/update consent displays these permissions; selecting a design does not silently grant them. `tm.pages` deliberately includes device display names, but excludes device IDs, credentials, paths, session titles and account emails. Additional allowlisted identity fields use the separate `tm.data.identities` business-data grant; this does not widen the original-page snapshot.

```json
{
  "permissions": ["ui.web", "tm.pages"],
  "webUi": {
    "version": 1,
    "assets": ["page.html", "page.js", "page.css", "mark.svg"],
    "documents": [{"id": "models", "title": "Model canvas", "entry": "page.html", "target": "model", "slot": "replace", "height": 400}]
  }
}
```

Existing declarative manifests/packages remain valid. The optional package `assets` map contains canonical base64 values for exactly the manifest's declared paths. Assets share the existing package hash, preview, staging, rollback and removal. Limits: 64 assets, 512 KiB per asset, 1 MiB aggregate assets, existing 2 MiB package total. Portable contained paths only; symlink escapes, duplicate case-insensitive names and code collisions are rejected. Formats: HTML, CSS, JS, PNG, JPEG, WebP, SVG and WOFF2. SVG is page-local content, not a trusted host identity mark.

## Home, plugin pages and settings editors

A document with `target: "home"` or `"page"` binds `view: "<declared-view-id>"`, `slot: "replace"` and `variant: "full"` (default). That view must declare the corresponding surface. One document is allowed per view/surface. Home and main-menu placements remain authoritative; a declaration never adds a placement. Explicitly opening a detached plugin window creates its own page owner and does not require a main-menu placement. Removing the menu entry does not close that detached owner; closing the window, disabling the plugin or losing approval revokes it. Home and main/detached pages preserve their host-owned headings, navigation and lightweight view as fallback. A detached page treats document height as preferred and fits it to the available viewport; authored content scrolls inside its document. Rendering requires `ui.web`; these documents do not receive an original-page snapshot and do not acquire `tm.pages` implicitly.

A single optional `target: "settings"`, `slot: "replace"` document has no `view`. The plugin management owner authorizes this editor independently of display placements. The host schema form remains the fallback. Disabled plugins do not execute the editor; author settings and business-data grants are checked separately. Opening this editor does not create a display-worker demand or permit legacy source subscriptions.

Each host/window/surface/instance/document has independent identity and shares the existing frozen controller cache. Home/page/settings children are admitted only inside fully visible, unobstructed host content rectangles. Clipping, scrolling, motion and overlays temporarily return to the lightweight view and release subscriptions. At most four presentation children are admitted per surface batch and eight across windows, with a sampled 512 MiB aggregate active working-set budget in addition to per-child and frozen-cache limits. These are host supervision policies, not hard OS quotas. Home cards outside admission remain lightweight. Escape restores keyboard focus to the host; normal document input never changes the main window's focusability policy.

## Fixed bridge

The isolated preload exposes `window.tm` version 1, never an IPC channel argument or Electron objects:

- For original pages, `context()` and `onContext(callback)` provide `{snapshot, theme}`. Snapshot is version 1: target, selected period, total tokens/cost and up to 500 display rows (`key`, `label`, `tokens`, `costUsd`). Keys are transient row indices, not internal identity. Theme provides validated colours, the resolved App interface font family, light/dark and reduced-motion preference. Authors apply these inside their own document.
- `subscribe(sourceIds)` replaces this document's requested sources and returns current readings. `onData(callback)` delivers changes. Only manifest-granted sources and the plugin's own declared `@metric` sources are accepted, using the manifest's `visible.intervalSeconds` cadence (default two seconds), bounded by each source's minimum interval. A visible web document keeps its optional Worker producer active; hiding it releases that visible demand. This is not an animation clock: CSS, Web Animations and Canvas run within the browser between readings.
- `storage.get(key)`, `storage.set(key,value)`, `storage.delete(key)` use the existing bounded per-plugin store. Store important author UI state explicitly: a ready hidden page can be briefly reused, but expiry or resource pressure may destroy it, so unsaved DOM drafts are not durable.
- `send(action, value?)` runs this plugin's own `tm.onAction(action, handler)` in its Worker, which receives `{ action, type: 'send', value, view, surface: 'web' }`, and resolves with the handler's return value (plain JSON within 60 KiB and the shared message depth/node/byte budgets; `undefined` when it returns nothing). It rejects when the handler throws or returns something else, no handler is registered, the plugin is disabled or restarting, the Worker stops first, or the declared-control bounds (eight outstanding, bounded rate) are reached. `value` is plain JSON within 64 KiB. A pending send does not delay the document's first presentation. Settings documents can send, so a "test connection" or "load options" button works there. If no view needs the Worker, a send wakes it in `action` mode: top-level code and that handler run, with network, storage, settings and one-shot `data.query` available, but no ticks, source sampling or source/business subscription delivery (subscriptions wait until the Worker is visible or background). The Worker returns to idle after the last pending send and stops after the usual idle grace. A disabled plugin runs no code, so its documents cannot send. Use a returned value for request/response results and a declared metric for live data. Documents are sandboxed without forms: a `<form>` never fires `submit`, so trigger sends from button clicks or key handlers.
- `restoreOriginal()` applies to original-page selections only. Home/page/settings contexts have no original-page snapshot; guard snapshot access.
- `data.query/subscribe` and `settings.get/update/onChange` use the same finite contracts as Worker code; see [business data and author preferences](README.md#business-data-and-author-preferences). These are distinct from legacy `subscribe/onData`. Settings are plugin-owned declared preferences, never arbitrary App settings or credentials. No arbitrary commands, navigation URLs or host DOM actions are exposed.

A search box, for example, keeps network access in the Worker (`network` permission and `network.hosts` as usual) and returns rows through an `object` metric named `results`:

```js
// page.js — the Rich document: the count comes back directly, the rows through @results
tm.onData(readings => render(readings['@results']?.value));
tm.subscribe(['@results']).then(readings => render(readings['@results']?.value));
// Documents are sandboxed without forms: use a button, not a <form> submit.
button.addEventListener('click', async () => {
  button.disabled = true;
  try { const { count } = await tm.send('search', { q: input.value }); showCount(count); }
  catch (error) { showError(error.message); }
  finally { button.disabled = false; }
});

// main.js — the Worker
tm.onAction('search', async ({ value }) => {
  const response = await tm.net.fetch(`https://api.example.com/search?q=${encodeURIComponent(value.q)}`);
  const items = JSON.parse(response.text).items.slice(0, 100);
  tm.publish('results', { query: value.q, items });
  return { count: items.length };
});
```

Listeners return an unsubscribe function. Respect `theme.reducedMotion` for author motion. This preference is supplied by the host; arbitrary author JS cannot be guaranteed to voluntarily stop every custom animation. The existing declarative Roll/Count path continues to enforce reduced motion itself.

## Isolation and lifecycle

Each mounted page has its own WebContents, sandbox and context isolation, with Node disabled and a separate in-memory session. A dedicated package-only scheme serves immutable validated asset bytes. CSP permits local scripts/styles/images/fonts and blocks connections, workers, nested frames, objects and forms. Session permissions, external requests, popups, navigation and downloads are denied. The fixed preload validates the actual sender WebContents/main frame/document and rechecks the plugin grant for every request. Revocation never relies on an opaque origin alone.

Hiding/minimizing a window, opening Settings or another page releases subscriptions immediately. Ready documents may enter the bounded frozen reuse cache (default 30 seconds idle; optional per-document `retainMs` requests any nonnegative safe-integer duration in milliseconds or `"until-evicted"`, subordinate to global count/memory limits); disabled/uninstalled plugins and retired documents are destroyed. Only explicitly enabled Worker background capabilities may retain background demand. Web pages never run as hidden background tasks. A bounded watchdog closes a non-responsive page (normally within ten seconds), and sampled working-set checks apply a 256 MiB budget. These are supervision bounds, not a hard OS memory quota; a process can grow between observations. One child's runaway loop must not freeze host controls: the Electron harness verifies distinct process IDs and host responsiveness while the child loops.

## Notch and Edge Dock documents

A surface document uses `target: "notch"` or `"edgeDock"`, `view: "<declared-view-id>"`, `slot: "replace"` and `variant: "full"` (default) or `"compact"` (Edge Dock rail only). The view must declare that surface; exactly one document may occupy each view/surface/variant. The `ui.web` grant is required; `tm.pages` is only required for original model/tool/device page snapshots. Surface documents receive no original-page snapshot. User placement remains the existing Notch/Edge Dock selection; adding a document never enables a location or background work. The declared layout/compact readout remains the fallback. [Surface Studio](examples/surface-studio/manifest.json) demonstrates all three positions without a Worker or network access.

Full content supports browser layout, CSS/Web Animations, Canvas and packaged assets. It occupies only the settled content rectangle, never the Notch camera/header/navigation or Dock rail drag zone. Height is a preference (40–600 CSS pixels), reduced to available room; authors should use responsive layout and internal scrolling. The document context is `{locale, surface, variant, viewport, theme}`. Viewport describes the allocated host rectangle; `innerWidth`/`innerHeight` remain the authoritative document layout dimensions. Host zoom and Notch CSS scale are applied to the native child.

Compact rail content is visual-only: native mouse interception forwards clicks and drags to the original host at translated coordinates. Full content can receive pointer input; a deliberate click enables keyboard focus, and Escape returns to the host and dismisses the panel. Blur restores the nonactivating window policy. Header gestures remain with the host, while scrolling over authored content belongs to the document. Native IME candidate placement and physical trackpad gesture combinations still require hardware acceptance; Chromium composition events are covered by the isolated harness.

Transparent child backgrounds preserve the host's shell; authors may intentionally draw an opaque panel. Native views do not inherit DOM clipping or shell transforms, so rich content is suspended during geometry motion, clipping, popovers, collapse, native hide or drag, and the lightweight tree remains available. Separate windows/documents may coexist. Faded native surfaces release both declarative and authored subscriptions from the main process, without relying on `document.hidden`. Disable, grant revocation, placement removal and uninstall release the matching documents and source demand. A quick re-open can thaw the same isolated document after authority checks and fresh context delivery. Cold or evicted pages create a fresh document; explicit local storage remains the persistence boundary. See [Opening a plugin view](README.md#opening-a-plugin-view) for reuse limits and fail-closed behavior.

The existing App Roll/Count and shell animations are unchanged. There is no host animation DSL or arbitrary IPC. Author browser motion must respect the supplied reduced-motion preference; the sample does. Tray remains the existing static bitmap interface. Notch remains macOS-only; Edge Dock's existing macOS/Windows availability is unchanged. This implementation has local macOS controller/renderer and isolated Electron evidence, not Windows, Linux, packaged or physical Notch acceptance.

## System source contract

Legacy `sys.cpu` (percentage) and `sys.memory` (`used`, `total`, `percent`) keep their shapes. The new `sys.details` grant permits individually subscribable `sys.cpu.details`, `sys.memory.details`, `sys.network`, `sys.disk`, `sys.battery`, `sys.gpu`, `sys.temperature`, or the aggregate `sys.details` convenience source. The detailed envelopes carry `version:1`, `at` (epoch milliseconds), platform, status (`ok`, `unsupported`, `unavailable`) and nullable value. Permission denial rejects the subscription; timestamps let an author detect stale readings. Absence is not zero.

| Source | Fields/units and platform coverage |
| --- | --- |
| CPU | Total and per-logical-core busy percentages; one shared counter baseline. First sample/reset is unavailable. |
| Memory | Used/total bytes and percentage; macOS also exposes app/wired/compressed/file-backed bytes and cumulative swap-in/out bytes from the existing native reader. Linux provides available/cached bytes and swap used/total. Pressure is explicitly unsupported. |
| Network | Linux non-loopback interface counter aggregate, received/sent bytes per second; logical interfaces may overlap. Other platforms unsupported. No addresses or interface names cross the bridge. |
| Disk | Linux whole block-device counters, read/written bytes per second; partitions and virtual mapping layers excluded. Other platforms unsupported. |
| Battery | Supported Electron macOS/Windows power-source boolean; capacity and time estimates remain null. Other platforms unsupported. |
| GPU/temperature | Unsupported until a portable, low-privilege adapter is validated. |

One host sampler serves all subscribed projections at the fastest permitted interval (minimum one second). It reads CPU/memory or Linux IO families only when requested. Multiple plugins share the same sample. Zero demand cancels timers and resets counter baselines; late async results are discarded after generation changes. Resume does not average a long hidden interval into a live rate. No shell commands, administrator probes or general filesystem permissions are granted.

## Appearance and distribution

Plugin content follows App appearance by default. Existing `plugin-appearance.json` is read-only compatibility data and remains untouched; existing skin/theme preset capabilities remain. Authors own their document design and plugin-specific controls. Whole-App themes continue through the host theme contract, not arbitrary App CSS.

Official app-shipped listings plus user-added HTTPS indexes are the supported catalog model. Catalog inclusion does not imply a safety review. Users explicitly add community sources; plugins cannot enroll or publish a source themselves.

Implementation references: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security). The host uses a separately supervised WebContents rather than assuming an iframe alone provides process isolation.
