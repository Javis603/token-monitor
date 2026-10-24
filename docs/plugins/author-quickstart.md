# Write a Token Monitor plugin

## Start with a working readout

Copy the complete `cpu-readout/manifest.json` from [Smallest declarative plugin](README.md#smallest-declarative-plugin). No JavaScript or dependency install is needed. In Settings → Plugins → Installed → More plugin actions, import that folder, review its `sys.cpu` permission, then enable the plugin. Choose a supported placement in its settings. Edge Dock and Notch also need their existing App setting enabled. The readout uses the App theme and only samples while visible.

Folder import is sufficient for local use; a `.tmplugin` file is useful when sharing. To build one, use the [Token Monitor repository](https://github.com/Javis603/token-monitor). From its root, install the package builder's dependencies without running install scripts (including Electron's binary download), then run the builder. Use the Node version required by the repository's `package.json`.

```sh
npm ci --ignore-scripts
node scripts/build-plugin-package.js /absolute/path/cpu-readout /tmp/cpu-readout.tmplugin
```

Use “Install from file” to preview the exact source/version/permissions before confirming. Installation and execution approval are separate. Develop against a disposable App profile; do not overwrite your personal profile or put credentials in fixtures.

## Declare compatibility

Declare `"tmApi": "^1"` for this plugin API. The optional `engines.tokenMonitor` field is a semver range for App versions you support; set it from versions you actually test, rather than copying the repository's current version as an assumed minimum. API-major compatibility does not by itself guarantee that an older App provides every capability used by your plugin. Check those capabilities in the target App before sharing.

## Choose the UI for each surface

| Need | Declarative UI | Rich UI |
| --- | --- | --- |
| Quick CPU/RAM value or chart | Host renders immediately from available data; cold source can still need its first sample | Needs an isolated document on first open or eviction |
| Continuous curve | Opt-in host sparkline with timestamped measured history | Author controls SVG/canvas/CSS/rAF |
| Custom layout, animation, images and interaction | Validated components and drawing commands | Packaged HTML/CSS/JS and local assets |
| Main App | Home and optional plugin page | Original model/tool/device slots, Home and main/detached plugin pages |
| Notch / Edge Dock | Supported | Optional full panels; Edge Dock also supports compact art |
| Tray bitmap | Supported | No embedded web document |
| Hide | Release visible sampling demand | Release demand and freeze bounded retained documents, or destroy |

Choose independently per declared view/surface. A plugin does not need its own page. Rich UI remains available on Notch and Edge Dock; the host does not force a renderer based on what other plugins choose. A declaration supplies a fallback layout so a failed/unsupported web surface can remain useful. UI selection grants and placement settings still belong to the user.

For smooth lightweight curves use the [sparkline example](README.md#continuous-declarative-sparklines). System Monitor demonstrates both renderers; its main-App layouts are declarative and its Notch/Edge Dock full charts remain Rich UI. Try the renderers under identical sampling cadence rather than speeding up collection to hide animation steps.

## Author a web document

For original-page snapshots, animated bars, shared system readings and a stored note, use [Page Studio](examples/page-studio/manifest.json). Start from [Surface Studio](examples/surface-studio/manifest.json) for Notch/Edge Dock or [Business Studio](examples/business-studio/manifest.json) for original App pages, Home, plugin pages and a settings editor. These are complete packaged examples; see their HTML, CSS and JS beside each manifest. Declare `ui.web`, enumerate local assets and name the target. Only original model/tool/device documents also need `tm.pages`; business data needs its own `tm.data.*` grants. Use the fixed `tm` bridge documented in [the reference](README.md), never host DOM, Node or internal IPC. Theme tokens and reduced-motion context come from the App.

For a document that benefits from longer quick-reopen retention, add this field to its existing manifest entry:

```json
{ "retainMs": 120000 }
```

This requests two minutes after hiding. The allowed range is any nonnegative safe-integer duration in milliseconds or `"until-evicted"`, default 30000. `"retainMs": "until-evicted"` omits idle expiry. It is not a keep-alive guarantee: the host can evict earlier for count/memory limits, reload, disable, revoked grants or owner closure. Retention does not grant background work. Persist drafts with `tm.storage`, and handle a genuine cold launch. Only explicitly enabled Worker background features may keep background sampling demand.

## Reuse App data and saved preferences

Business Studio uses one shared script across all six documents. Original pages follow the App period; Home/page/settings use the saved period. It requests tool/model usage, device/session metadata, subscription records and limits. It shows parent-session links and shared subscription derivations (renewal, recorded payments, monthly equivalent and authorized top-up balance estimates), while preserving unknown-cost and coverage states. It pages with opaque cursors, preserves active traversal on ordinary updates, and restarts after reset/expiry. The initial subscription supplies page one; there is no second initial query, polling, system probe or provider login. Use the next-page control to inspect the collection without pretending visible rows are the total.

The manifest's period/page-size schema gives every installation a standard host settings form. The optional Rich editor uses the same `tm.settings.get/update/onChange` store with revision checks and explicit conflict reload. Settings can be saved while execution is off; Rich code runs only when authorized. Its explicit identities grant permits available display names/session titles; the host hidden-title preference still applies. It does not request transcripts or network access. Enable Home/Main app page placements yourself; Rich documents never grant placements.

Build it with `node scripts/build-plugin-package.js docs/plugins/examples/business-studio /tmp/business-studio.tmplugin`. See [business-data and settings contracts](README.md#business-data-and-author-preferences) for limits and missing-data handling. The settings editor doubles as a data preview; the standard host form remains available if Rich mounting is unavailable.

## Test before sharing

Check cold open, quick reopen, expiry, missing data, reduced motion, keyboard/focus, resize and each supported surface. Hide every consumer and verify the source stops; multiple consumers should share sampling. Disable/revoke the plugin while it is open and while cached. Do not claim Windows/Linux or physical Notch acceptance from a synthetic renderer fixture.

See [README verification commands](README.md) and [distribution contracts](distribution-design.md) for packaging and catalog checks. Existing official and user-added HTTPS catalogs are the supported distribution model; a public submission backend or manual-review operation is not required. Do not label third-party source claims as host verification.
