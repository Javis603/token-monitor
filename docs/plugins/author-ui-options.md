# Same-page UI and content composition

Plugin UI runs author ES modules in the existing host renderer. Use DOM, bundled CSS and JavaScript to design content for the available surfaces.

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

Use `targets` with `append`, `decorate` or `replace`. Main targets follow the actual navigation key: `main.home.content`, `main.limits.content`, `main.model.content`, `main.tool.content`, `main.device.content`, `main.project.content`, `main.session.content`, `main.trends.content`, `main.status.content`. Session list and open session detail both use `main.session.content`, with `context.session` identifying the open detail. Unknown target names do not create pages. Notch targets are `notch.<page>.content` and the compact `notch.summary.content`; Dock cards use `edgeDock.<kind>.content` and rail cells use `edgeDock.rail.<kind>.content` (for example `provider` or `stat`). A target can occur more than once; `targetInstance` distinguishes rail cells.

`main.navigation.content` adds content to the existing view switcher; it cannot replace the core navigation. User-placed plugin pages already join that switcher and the Notch tab strip. There is no separate desktop sidebar to replace. The independent web dashboard, WidgetKit, settings administration and native window controls are not automatic content targets.

A view can specify `selector`, a CSS selector relative to its target's native root, to mount beside every matching section or inline element. For example, `{ "id":"annotation", "targets":["main.model.content"], "selector":".row-value", "mode":"append" }` extends native model values. `context.native` is the matched element and `context.root` the original root. Invalid or non-matching selectors leave native content alone. Omitting `selector` mounts at the target’s native root, which a successfully mounted, user-selected replacement may hide; author-created `.plugin-content` descendants are excluded. When a native anchor remains connected and retains its logical identity, its plugin controls are preserved across reordering. `anchorIndex` reflects the current position, not a stable identifier. Native elements may be rebuilt; do not rely on mounted controls or draft state surviving replacement. Reconcile against the current `context.native` in `update()`; author-only DOM changes do not trigger another update. DOM selectors are experimental, not a stable semantic schema for every internal element.

The host renders native content in its own DOM first. An extension receives `context.native`, the real native element, plus selected data/context (`nativeData` in secondary surfaces, `stats` in the main App; `data` is the backend value). It may inspect, move, hide or rearrange children and insert custom DOM. It can reuse existing native helpers where exposed. Main/Dock expose `ctx.native.quota` helpers for windows/meters/provider rows. Main additionally exposes `quotaProvider`, `quotaGroup`, `usageRow(data)` and `updateUsageRow(node, data)` using the same native factories. `usageRow` accepts a native row record (`key`, `name`, `value`, `cost`, optional `max`, `color` and other native row fields); it is presentation reuse, not a portable session/account action controller. Authors bind their own handlers through available `ctx.app` operations or `ctx.navigate`. There is no factory for every private component; the host DOM and existing services remain accessible. The host may rebuild native content after data changes, so `update` must reconcile the new `context.native` rather than retain detached nodes.

Append/decorate extensions may coexist in stable catalog order, with per-target up/down ordering in plugin details when multiple entries exist. Ordering applies to extensions sharing an anchor; it does not rearrange native anchor positions. Unchanged ordering does not detach author controls, preserving focus during ordinary refreshes. Disabled refs retain their stored order. Replacement selection stays separate from ordering.

Each plugin may declare at most one `replace` view for a target. Content controls select native content or a plugin source for each target. Choosing native content leaves the plugin's other pages, features and opted-in background work enabled. Before switching, the App checks the departing replacement mounts for `hasUnsavedChanges()` and asks before discarding reported drafts; other pages and targets do not trigger this warning. If inspection fails, the source stays unchanged.

On first enable or trust-and-install, each replacement target uses the confirmed first-use choice. Authors can suggest their replacement view or native content through `defaults.content`; omission suggests the plugin's replacement. An existing native-content decision is preserved. If another enabled, trusted plugin is the selected source, users can confirm the switch or enable the new plugin while keeping the current content.

For independently switchable sections within your plugin, declare boolean [plugin settings](author-data-settings.md#plugin-settings) and compose the selected sections in your view. Users can combine these settings independently of the App's content-source choice. Complete/compact layouts and detail levels also belong in plugin settings; render the selected layout within the same replacement view. Independent Home cards can use separate `home` views and the existing placement/order controls. The host does not automatically merge separate replacement implementations.

Enable/disable cycles and trusted updates preserve native-content and other-plugin choices. Disabling the selected plugin temporarily restores native content without selecting a different plugin. Newly added replacement targets receive defaults only at locations that have not already been configured. If an update changes the selected view ID, the plugin's current replacement for that target is used. If it stops providing a selected target, that target returns to native content; selections owned by other plugins remain. Uninstalling with kept placements retains content choices; removing placements resets that plugin's initial choices for a later reinstall.

The master switch pauses execution, not reviewed configuration changes. Updating an individually enabled plugin applies its confirmed new settings even while execution is paused; enabling the master switch later resumes code without reapplying defaults. A new installation made while execution is paused remains disabled, with its initial choices pending until individual enable.

Native content stays visible until the selected replacement mounts successfully and is restored on mount/update failure or deselection. Decoration is cooperative: an author that directly mutates shared DOM must undo its changes in `dispose`. Arbitrary shared-page side effects cannot be reliably reversed by the host; normal disable cooperatively disposes the plugin without a reload. Report unsaved work with `hasUnsavedChanges()` and release every owned timer/listener in `dispose` or `ctx.onDispose`. Failed cleanup offers affected-window reload; executable updates still reload loaded hosts.

Root Notch summary extensions share the fixed-height summary row with native readings; they do not create a second row. On displays with a camera gap, root additions/replacements use the safe right shoulder. On camera-free entries a replacement can use the full summary width. Use section selectors to extend a particular native slot and keep authored content compact; overflow is clipped to the host's available area. The host still owns the camera clearance and window geometry.

Enable a view declaring `tray`, then add it from the existing Tray, Floating Bubble or custom Notch-summary composer. `renderTray` paints its bitmap in each selected layout. Notch “Same as tray” follows the active Tray layout; its custom layout is independent. Only visible consumers request foreground backend work. These bitmap entries are separate from `notch.summary.content` DOM extensions.

Host navigation, Settings and the native restart-without-plugins command remain the supported recovery entry points. Trusted code can still damage its renderer, so these DOM conventions are not a security boundary. A stalled renderer requires the native menu/launch flag recovery route.

## Lifecycle and appearance

### Header actions

Where available, `context.headerActions` is a DOM container for page-owned controls, separate from user-selected `replace` content targets.

| Mount | Header slot and constraints |
| --- | --- |
| Main or detached `page` | Window header |
| Notch page | Camera-safe trailing lane in the navigation band; keep controls compact. Nonempty controls temporarily replace native TPS/refresh. Page identity remains in the selected tab; do not add a duplicate title row. |
| Full Edge Dock card | Beside the native card identity; fit the narrow card width |
| Compact Dock rail | No header slot; use minimal content in the rail itself |

Check for the slot before using it. Append only owned nodes and remove them in `dispose`. The host hides other pages' slots and restores native status when controls are empty, fail or unmount, or a native page is selected. Preserve keyboard focus indicators; let the host manage main-window activation focus.

Use `update(context)` for source/period/data/geometry changes. Honor `visible:false`; release work when hidden and clean up per-mount resources in `dispose`. Same-plugin backends are shared across all windows. Background execution is an independent setting, reviewed alongside the other [first-use suggestions](README.md#first-use-settings).

Use any bundled CSS, DOM and canvas implementation. Optional host variables include `--plugin-default`, `--plugin-muted`, `--plugin-accent`, `--plugin-chart`, `--pv-font`, `--pv-padding` and `--pv-radius`. Skin presets remain a convenience for App colors and default author appearance; built-in theme selection/reset clears the applied author preset. They do not constrain author layouts. Respect reduced motion, keyboard access, readable contrast and narrow surfaces yourself.

The renderer has no Node integration. Use `ctx.backend.call` for network/files/compute. The backend has the OS user's authority; moving a request there is not an isolation guarantee. Bundle dependencies ahead of time, include every asset in `files`, and use CSS files rather than inline script execution. See [package limits and installation](distribution-design.md#package-format).

## Tray actions

Declare `trayMenu: [{"id":"refresh","label":"Refresh my data"}]` with a backend. Active plugins contribute native menu commands; the host invokes backend `call('tray', {id:'refresh'})` only when clicked and rechecks current enablement/declaration. Menu enumeration does not start code. Labels may be localized. Native Settings, Restart without plugins and Quit remain available; Linux exported menus refresh on plugin changes. A bitmap may contain painted text but is not a native editable control or a promise of cross-platform tray titles.
