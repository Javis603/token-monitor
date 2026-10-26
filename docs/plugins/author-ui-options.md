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
| `tray` | `renderTray(canvas, context)` paints an App-composed bitmap; no DOM controls in an OS menu-bar bitmap |

Author modules can inspect context dimensions and `surfaceVariant`; compact rail content and full panels must not assume the same controls, space or pointer behavior. App controllers retain window shape, size limits, position, open/close, hit regions and native gestures. The collapsed Dock handle is a shell affordance, not a replacement page.

## Original content targets

Use `targets` with `append`, `decorate` or `replace`. Main targets follow the actual navigation key: `main.home.content`, `main.limits.content`, `main.model.content`, `main.tool.content`, `main.device.content`, `main.project.content`, `main.session.content`, `main.trends.content`, `main.status.content`. Other original main breakdowns use that same naming rule. Notch targets are `notch.<page>.content` and the compact `notch.summary.content`; Dock cards use `edgeDock.<kind>.content` and rail cells use `edgeDock.rail.<kind>.content` (for example `provider` or `stat`). A target can occur more than once; `targetInstance` distinguishes rail cells.

The host renders native content in its own DOM first. An extension receives `context.native`, the real native element, plus selected data/context (`nativeData` in secondary surfaces, `stats` in the main App; `data` is the backend value). It may inspect, move, hide or rearrange children and insert custom DOM. It can use existing native helpers where exposed, rather than embedding a copy in a sandbox or limiting composition to entire cards. Main/Dock expose `ctx.native.quota` helpers for windows/meters/provider rows. These APIs are experimental; internal DOM selectors may change. The host may rebuild native content after data changes, so `update` must reconcile the new `context.native` rather than retain detached nodes.

Append/decorate extensions may coexist in stable catalog order. Exactly one replacement per target is selected by the user in plugin settings; registering a replacement does not activate it. Native content stays visible until that replacement mounts successfully and is restored on mount/update failure or deselection. Decoration is cooperative: an author that directly mutates shared DOM must undo its changes in `dispose`. Arbitrary shared-page side effects cannot be reliably reversed by the host; changing/turning off executable code reloads affected renderers.

Host navigation, Settings and the native restart-without-plugins command remain the supported recovery entry points. Trusted code can still damage its renderer, so these DOM conventions are not a security boundary. A stalled renderer requires the native menu/launch flag recovery route.

## Lifecycle and appearance

Use `update(context)` for source/period/data/geometry changes. Honor `visible:false`; release work when hidden and clean up per-mount resources in `dispose`. Same-plugin backends are shared across all windows. Ordinary switching does not create an independent web renderer/cache for each view. Background execution is a separate explicit setting.

Use any bundled CSS, DOM and canvas implementation. Optional host variables include `--plugin-default`, `--plugin-muted`, `--plugin-accent`, `--plugin-chart`, `--pv-font`, `--pv-padding` and `--pv-radius`. Skin presets remain a convenience for App colors and default author appearance; built-in theme selection/reset clears the applied author preset. They do not constrain author layouts. Respect reduced motion, keyboard access, readable contrast and narrow surfaces yourself.

The renderer has no Node integration. Use `ctx.backend.call` for network/files/compute. The backend has the OS user's authority; moving a request there is not an isolation guarantee. Bundle dependencies ahead of time, include every asset in `files`, and use CSS files rather than inline script execution. The package envelope is limited to 64 MiB and the manifest to 256 KiB; these are installation/IO bounds, not runtime capability grants.
