# Same-page UI and content composition

API 2 has one UI engine: author ES modules in the existing host renderer. There are no plugin WebContentsView documents, freeze/warm-cache protocol, fixed declarative layout engine or fallback copy of an authored page.

## Content surfaces

| Entry | Contract |
| --- | --- |
| `home` | A user-placed Home module; ordinary App ordering remains available |
| `page` | User-placed main navigation page, optionally opened in a detached App window |
| `settings` | Custom plugin settings content beside the standard preference form |
| `notch` | A user-selected Notch page inside the existing panel |
| `edgeDock` | User-placed rail cell and expanded card inside the existing shell |
| `tray` | `renderTray(canvas, context)` paints text/icons in an App-composed bitmap; `trayMenu` declares native menu callbacks, not HTML |

Author modules can inspect context dimensions and `surfaceVariant`; compact rail content and full panels must not assume the same controls, space or pointer behavior. App controllers retain window shape, size limits, position, open/close, hit regions and native gestures. The collapsed Dock handle is a shell affordance, not a replacement page.

## Original content targets

Use `targets` with `append`, `decorate` or `replace`. Main targets follow the actual navigation key: `main.home.content`, `main.limits.content`, `main.model.content`, `main.tool.content`, `main.device.content`, `main.project.content`, `main.session.content`, `main.trends.content`, `main.status.content`. Session list and open session detail both use `main.session.content`, with `context.session` identifying the open detail. These are the current nine native main page keys; unknown target names do not create pages. Notch targets are `notch.<page>.content` and the compact `notch.summary.content`; Dock cards use `edgeDock.<kind>.content` and rail cells use `edgeDock.rail.<kind>.content` (for example `provider` or `stat`). A target can occur more than once; `targetInstance` distinguishes rail cells.

`main.navigation.content` adds content to the existing view switcher; it cannot replace the core navigation. User-placed plugin pages already join that switcher and the Notch tab strip. There is no separate desktop sidebar to replace. The independent web dashboard, WidgetKit, settings administration and native window controls are not automatic content targets.

A view can specify `selector`, a CSS selector relative to its target's native root, to mount beside every matching section or inline element. For example, `{ "id":"annotation", "targets":["main.model.content"], "selector":".row-value", "mode":"append" }` extends native model values. `context.native` is the matched element, `context.root` the original root, and `anchorIndex` its position. Missing/invalid selectors leave native content alone; author-created `.plugin-content` descendants are excluded. Active selector outlets observe native child rebuilds, including partial row refreshes that do not rerender the whole page. Author-only mutations do not trigger another author update; observers are disconnected when the target is released. Anchors are reconciled when native content rebuilds, but authors should not rely on draft identity surviving native row reordering. DOM selectors are experimental, not a stable semantic schema for every internal element.

The host renders native content in its own DOM first. An extension receives `context.native`, the real native element, plus selected data/context (`nativeData` in secondary surfaces, `stats` in the main App; `data` is the backend value). It may inspect, move, hide or rearrange children and insert custom DOM. It can use existing native helpers where exposed, rather than embedding a copy in a sandbox or limiting composition to entire cards. Main/Dock expose `ctx.native.quota` helpers for windows/meters/provider rows. Main additionally exposes `quotaProvider`, `quotaGroup`, `usageRow(data)` and `updateUsageRow(node, data)` using the same native factories. `usageRow` accepts a native row record (`key`, `name`, `value`, `cost`, optional `max`, `color` and other native row fields); it is presentation reuse, not a portable session/account action controller. Authors bind their own handlers through available `ctx.app` operations or `ctx.navigate`. There is no factory for every private component; the host DOM and existing services remain accessible. These APIs are experimental; internal DOM selectors may change. The host may rebuild native content after data changes, so `update` must reconcile the new `context.native` rather than retain detached nodes.

Append/decorate extensions may coexist in stable catalog order, with per-target up/down ordering in plugin details when multiple entries exist. Ordering applies to extensions sharing an anchor; it does not rearrange native anchor positions. Unchanged ordering does not detach author controls, preserving focus during ordinary refreshes. Disabled refs retain their stored order. Replacement selection stays separate from ordering. Exactly one replacement per target is selected by the user in plugin settings; registering a replacement does not activate it. Native content stays visible until that replacement mounts successfully and is restored on mount/update failure or deselection. Decoration is cooperative: an author that directly mutates shared DOM must undo its changes in `dispose`. Arbitrary shared-page side effects cannot be reliably reversed by the host; changing/turning off executable code reloads affected renderers.

Root Notch summary extensions share the fixed-height summary row with native readings; they do not create a second row. On displays with a camera gap, root additions/replacements use the safe right shoulder. On camera-free entries a replacement can use the full summary width. Use section selectors to extend a particular native slot and keep authored content compact; overflow is clipped to the host's available area. The host still owns the camera clearance and window geometry.

`renderTray` also renders plugin bitmap entries already present in custom floating-bubble and Notch-summary layouts. Each layout resolves its own refs; only visible consumers request foreground backend work. This is separate from the Notch summary DOM extension. The plugin placement control adds bitmap entries to the system Tray; accepting a bitmap ref in another custom layout does not add a new placement button.

Host navigation, Settings and the native restart-without-plugins command remain the supported recovery entry points. Trusted code can still damage its renderer, so these DOM conventions are not a security boundary. A stalled renderer requires the native menu/launch flag recovery route.

## Lifecycle and appearance

Use `update(context)` for source/period/data/geometry changes. Honor `visible:false`; release work when hidden and clean up per-mount resources in `dispose`. Same-plugin backends are shared across all windows. Ordinary switching does not create an independent web renderer/cache for each view. Background execution is a separate explicit setting.

Use any bundled CSS, DOM and canvas implementation. Optional host variables include `--plugin-default`, `--plugin-muted`, `--plugin-accent`, `--plugin-chart`, `--pv-font`, `--pv-padding` and `--pv-radius`. Skin presets remain a convenience for App colors and default author appearance; built-in theme selection/reset clears the applied author preset. They do not constrain author layouts. Respect reduced motion, keyboard access, readable contrast and narrow surfaces yourself.

The renderer has no Node integration. Use `ctx.backend.call` for network/files/compute. The backend has the OS user's authority; moving a request there is not an isolation guarantee. Bundle dependencies ahead of time, include every asset in `files`, and use CSS files rather than inline script execution. The package envelope is limited to 64 MiB and the manifest to 256 KiB; these are installation/IO bounds, not runtime capability grants.

## Tray actions

Declare `trayMenu: [{"id":"refresh","label":"Refresh my data"}]` with a backend. Active plugins contribute native menu commands; the host invokes backend `call('tray', {id:'refresh'})` only when clicked and rechecks current enablement/declaration. Menu enumeration does not start code. Labels may be localized. Native Settings, Restart without plugins and Quit remain available; Linux exported menus refresh on plugin changes. A bitmap may contain painted text but is not a native editable control or a promise of cross-platform tray titles.
