# Configuration

Token Monitor has two configuration surfaces:

- **Widget (GUI)** — everything the desktop app does, configured from the `⚙` settings panel. This is the only surface most people need.
- **`.env`** — for the headless agent and standalone hub, which have no UI.

The widget reads `.env` values as *first-run defaults*; once you change a setting in the GUI, the saved value takes over. The agent and hub follow the precedence **CLI flag → env var (real or `.env`) → built-in default**.

---

## Widget (GUI)

Click the `⚙` button in the bottom-right corner of the widget to open the settings panel. Sections appear in this order:

| Section | What it controls |
|---|---|
| **General** | Language, launch at login, app updates (optionally downloaded in the background), Discord Rich Presence, About — including an on-demand redacted diagnostic report to attach to an issue — and Advanced (open the raw `settings.json` for less-common options such as `allTimeSince`). |
| **Main** | Which Home modules appear and their order, plus the display currency (USD, TWD, HKD, or CNY; daily auto rate or a manual override). |
| **Window** | Window behavior (float above other apps / normal / desktop-pinned), tray mode (macOS menu bar or Windows system tray, and what shows next to the icon), built-in or hand-built menu bar and floating-bubble layouts, Edge Dock and macOS Notch Panel, hiding the taskbar/Dock icon while keeping the widget on screen, and the global show/hide shortcut. |
| **Appearance** | Interface theme (presets such as Default and Obsidian, a porcelain light mode, or custom colors), per-vendor tool colors, glass appearance (Frosted Glass retains its opacity / depth controls; on macOS 26+, native Liquid Glass (Regular) and Liquid Glass (Clear) each remember their own backdrop tint, while macOS controls their blur and refraction; the Edge Dock and Notch Panel can follow the widget or pick their own style, using that style's saved tint), and separate interface and display fonts. |
| **Collection** | Tracked tools — searchable, with hide / pin / drag-reorder for the main list, per-tool source health, re-scan, and custom scan paths for sessions kept outside the defaults — collection cadence (live watch, or saved fixed intervals including 15 seconds and 5 minutes), **Keep usage from deleted sessions**, model aliases, custom pricing, data export, and — on Windows — the built-in WSL scan toggle. |
| **AI Tool Limits** | Which providers to enable, their credentials and sign-in options, multiple accounts per provider (including switching the active local Codex account), session / daily / weekly / billing / credit windows (with a per-provider **Visible usage items** checklist that hides any of them from the Limits page, the Edge Dock card and the Home module), and how often to refresh (a fixed interval, or adaptive to how fast a quota is being consumed). The provider list is searchable. |
| **Subscriptions** | What you actually pay for each AI account — a recurring plan, or a top-up ledger for balance-style accounts — surfaced on hover of that account's plan label. Entered by hand; nothing is fetched from any provider. With a hub configured the list is stored on the hub and shared by every connected device; otherwise it stays in this device's `settings.json`. |
| **Multi-device Sync** | **Local only** (no hub), **Connect to a hub** (paste another machine's Hub URL + secret), **Host hub on this device** (run a hub locally; the panel lists reachable LAN / Tailscale / ZeroTier addresses), or **iCloud Drive** on macOS (opt-in, same Apple ID, no Token Monitor server). |

On supported macOS versions, Clear keeps its sharp glass appearance when focus changes and uses a dark tint to reduce the pale wash and keep text legible. Tinted Regular glass also keeps its tint consistent between focused windows and nonactivating Dock/Notch panels; untinted Regular retains its existing appearance. Glass opacity, depth, and native tint sliders preview on the floating surfaces while dragging, using each surface's selected glass style; values are saved on release.

Notch Panel is an opt-in macOS surface. Enable it under **Window → Notch Panel**; select its row to open its settings. Display settings keep a compact overview with independent enable switches; the detail page has quick tabs for Edge Dock, Notch Panel, Floating Bubble and Tray, with Content, Behavior and Appearance tabs for Edge Dock and Notch. Floating Bubble and Tray show all settings together in separated groups without category tabs. Full-screen summary hiding is under Behavior. Switching pages does not enable a surface or save preferences. Disabled surfaces remain configurable, while actions that require a tray icon remain unavailable until it is enabled. Returning to the overview restores its scroll position. It is off by default. Turning it off stops its windows, polling and rate tracking without clearing its saved preferences.

Drag the Edge Dock away from either screen edge to leave it floating as a rounded capsule. A floating rail stays visible, remembers its position on its display, and opens details toward the available space. Drag it close to the left or right edge to dock it again and restore the selected visibility behavior. Selecting a screen edge in Settings or the tray menu also returns it to that edge.

The Notch and Edge Dock previews use the same HTML, styles, shape helpers and content renderers as the live surfaces with local sample data. Both initially show their expanded state. The Notch offers collapsed and expanded previews within a stable-height, top-aligned area; Edge Dock shows only its expanded rail. They are scaled previews on a representative display, not a pixel-for-pixel reproduction of the current monitor; native glass and material effects may differ. Tray and floating-bubble previews use their existing content drawing path with current data. The floating bubble is centered to indicate its draggable placement. Tray previews use the menu bar on macOS and the default bottom taskbar on Windows; Linux shows the icon without assuming a desktop panel position. The overview respects the selected Edge Dock side and only offers surfaces supported by the current platform. Previewing does not start native surface controllers, refresh providers or collect usage.

The open panel has four pages: Home shows today's usage, current activity and the last seven days; Limits gives every visible account its own column with its plan, leads each with the same windows as Home's limits card, fits up to four windows in a column by drawing them tighter, shows a grant measured against an allowance as its percentage (bare balances keep their amount), and scrolls sideways a page of three columns at a time by trackpad swipe or scroll wheel; Sessions separates active work from recent sessions, with independently scrollable lists and context/cache readings; both lists retain the shared session order and preserve their scroll positions across updates; Breakdown shows tool and model shares side by side, with totals on the left and the Today/Month switch on the right. Each breakdown column keeps up to four rows, merging smaller entries into Other when needed. These pages have a fixed height and their own layout. Context readings follow the main App's Used/Remaining preference. The horizontal provider strip in Notch settings controls which limits appear and their order; usage pages are always available. The collapsed summary defaults to **Session activity only**; it can also adapt automatically, follow the tray, or use a custom layout. Automatic mode prioritizes running or waiting sessions, then critical quotas, then today's usage. **Session activity only** shows running or waiting sessions and hides the collapsed summary when idle; it never switches to quota or usage figures. The header TPS follows the App’s live-rate timing: after 8 seconds without a new sample, the last reading becomes dimmed; it becomes unavailable after 3 minutes. **Highlight low limits in colour** is off by default and independent of the Edge Dock setting. Saved current summary choices are retained; settings without a current summary choice use the new default.

Usage costs follow Edge Dock: a known cost subtotal stays visible when some tokens are unpriced, with an info tooltip identifying the excluded usage. When unpriced usage has no positive known cost, the reading is `—`; fully priced zero usage still displays zero. The same rule applies to Home, inspected days, the seven-day total and Breakdown.

Notch Panel defaults to following the main window's glass style, with Pure black available as an explicit choice. An attached notch keeps its camera band solid black and fades down into the selected material as it opens. Below the fixed physical camera band, the black extension, transition and lower glass region share one proportional profile based on the current rendered content height. Screen-height limits, zoom and animation therefore preserve the same balance without scaling the camera band or applying zoom twice. A light dark scrim remains over the lower material, with a highlight along the bottom edge. The attached panel uses this scrim as its single tint layer instead of adding the main window’s native tint again; capsules retain the configured native tint. The resting and grown entries stay black. The attached panel keeps dark material and light text even with a light widget theme. Capsules retain the widget's palette without the camera-band fade.

Notch Panel's **Grow** hover mode enlarges the entry together with its left and right summary contents, keeping the physical camera gap fixed; a press on the entry opens the panel, while clicks on the rest of its transparent area pass through. **Swipe gestures** (More options, on by default) enables horizontal paging in either hover mode: left goes back, right goes forward, one page per gesture with no wrapping. In the Limits content area, account pages take priority; at an edge, the next outward swipe changes the main page. In Grow mode, swipe down on the notch to open the panel and up on its top row to close it; swipe up again to hide the collapsed summary, and down to bring it back. Turning the switch off also brings it back. Progressive blur stays transparent whenever a new mask cannot be applied, and becomes visible again only after a successful retry.

iCloud Drive sync is available only to the macOS widget. It stores per-device usage snapshots and per-writer subscription snapshots under `iCloud Drive/Token Monitor/sync-v1/`; updates are eventually consistent. Provider credentials and raw provider responses are excluded. If iCloud Drive is not available, the widget reports that state and retains its last-good aggregate.

Under **Multi-device Sync → Additional sync**, Node Hub and Worker connections offer default-off session titles, model aliases/grouping and custom pricing. Basic usage and cost remain part of normal sync. Titles require server permission plus a destination-specific confirmation on the sending device; hosting a Hub exposes a separate receiver-permission checkbox. Changing the saved connection, its credentials or the device ID clears the optional selections. Disabling titles requests removal from the active server store and shows pending cleanup until it succeeds.

When first enabling aliases or prices, choose the current server settings or publish this device's settings if they differ. Future edits share a server revision; a conflict asks you to reload instead of silently overwriting another device. Devices that leave an option off keep their own local settings. An older server without these endpoints continues basic sync and disables optional controls. See [privacy](privacy.md) and the [sync API](API.md#get-apisynccontent).

In the **Projects** view, expand a project to reveal the **Tools / Models** toggle at the bottom right. It changes both the project bars and expanded breakdown, and hides when all projects are collapsed. **Tools** is the default; the choice is saved locally as `projectBreakdownMode` (`tool` or `model`) and is independent of the Tools view’s **Tokens / Models** choice. Model display aliases are respected; usage without model attribution appears as **Unknown model**. Project token and cost totals stay the same.

The `⇧` button in the title bar cycles the window behavior.

---

## Headless agent & hub (`.env`)

The agent and hub have no UI. Configure them with a `.env` file in the project root (copy it from `.env.example`):

```env
TOKEN_MONITOR_HUB_URL=               # required in sync mode — Worker URL or http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # shared secret; must match the hub
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to the hostname
TOKEN_MONITOR_PERSIST_INTERVAL_MS=   # Node Hub only — 0/default saves each upload; 300000 batches for 5min
TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS= # optional — 0/live, 600000/10min, 1200000/20min, 1800000/30min
TOKEN_MONITOR_CLIENTS=               # optional — defaults to all supported tools; empty disables tracking
TOKEN_MONITOR_PROJECTS_ENABLED=      # optional — defaults on; 0 stops collecting project metadata
TOKEN_MONITOR_HISTORY_ENABLED=       # optional — defaults on; 0 skips trend history
TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED= # optional — defaults on; 0 stops archiving deleted-session usage
TOKEN_MONITOR_LIMITS_ENABLED=        # optional — defaults on; 0 skips CLI probing
TOKEN_MONITOR_LIMIT_PROVIDERS=       # optional — omit for all supported providers; empty probes none
TOKEN_MONITOR_LIMITS_REFRESH_MODE=   # optional — fixed (default) or adaptive
TOKEN_MONITOR_LIMITS_REFRESH_MS=     # optional — interval for fixed mode; defaults to 300000
# WorkBuddy: the desktop widget auto-detects the signed-in local app when the
# provider is enabled.
# The following are an advanced/headless-agent fallback, not normal widget setup.
# Desktop Local App monitoring is available on macOS and Windows; Linux Local
# App monitoring is unsupported. Desktop users do
# not copy a token, and Token Monitor does not store the WorkBuddy app credential.
TOKEN_MONITOR_WORKBUDDY_ACCESS_TOKEN= # headless only — explicit billing-session token
TOKEN_MONITOR_WORKBUDDY_USER_ID=      # headless only — WorkBuddy user ID
TOKEN_MONITOR_WORKBUDDY_ENTERPRISE_ID= # headless only — selects enterprise billing
TOKEN_MONITOR_WORKBUDDY_DOMAIN=      # headless only — X-Domain metadata
TOKEN_MONITOR_WORKBUDDY_DEPARTMENT_INFO= # headless only — enterprise metadata
TOKEN_MONITOR_WORKBUDDY_LOCALE=       # headless only — en or zh
```

Provider credentials (Grok, DeepSeek, Minimax, Copilot, GLM / GLM Team, Volcengine, Qoder, Command Code, WorkBuddy, Ollama, Kimi, Alibaba Token Plan, …) and proxy settings live in the same file. **`.env.example` is the complete, authoritative list** — start from it rather than copying keys by hand, since it stays in sync with the code. The desktop widget automatically reads the session owned by the local WorkBuddy app when that provider is enabled; the WorkBuddy token fields above remain only for headless/CLI deployments.

The widget reads most settings as first-run defaults. WorkBuddy follows the same provider checkbox as other auto-detected integrations on macOS and Windows; Linux local-app monitoring is unsupported. Desktop users do not copy a token, and the WorkBuddy token fields above apply only to the headless agent/CLI. The agent and hub take a CLI flag over an env var over the built-in default.

The standalone Node Hub accepts `--persistIntervalMs` or `TOKEN_MONITOR_PERSIST_INTERVAL_MS`. Values must be finite numbers from `0` through `2147483647` milliseconds; invalid values fail startup. The CLI flag requires a nonblank value, such as `--persistIntervalMs=300000`; a missing value fails startup even when the environment variable is valid. Leave it at `0` to save synchronously after each upload. A positive value, such as `300000`, batches usage snapshots at a fixed deadline after the first pending upload; continuous uploads do not reset it. API/SSE reads still update immediately. A failed timer save is logged and keeps the latest records pending for the next upload batch or normal shutdown. File-based readers can lag by the interval while writes succeed, and abrupt termination can lose updates accepted since the last save. Device deletion, subscription edits, shared settings and title policy changes save immediately.

On SIGINT/SIGTERM, the Node Hub saves pending usage before waiting for already-admitted uploads, rejects new requests, ends SSE streams, and saves again after draining. Remaining HTTP connections are force-closed after a five-second drain target; a busy event loop can delay this timer. A failed final save is reported with a nonzero exit code. SIGKILL and crashes cannot run this shutdown path.

One-shot run (collect once and exit — useful for cron / launchd):

```bash
npm run agent -- --clients=claude,codex,opencode --once
```
