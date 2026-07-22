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
| **General** | Language, launch at login, app updates, Discord Rich Presence, About, and Advanced (open the raw `settings.json` for less-common options such as `allTimeSince`). |
| **Main** | Which Home modules appear and their order, plus the display currency (USD, TWD, HKD, or CNY; daily auto rate or a manual override). |
| **Window** | Window behavior (float above other apps / normal / desktop-pinned), tray mode (macOS menu bar or Windows system tray, and what shows next to the icon), the floating bubble, and the global show/hide shortcut. |
| **Appearance** | Interface theme (presets such as Default and Obsidian, a porcelain light mode, or custom colors), per-vendor tool colors, and system glass opacity / blur. |
| **Collection** | Tracked tools (and hide / pin / drag-reorder for the main list), collection cadence, **Keep usage from deleted sessions**, custom pricing, data export, and — on Windows — the built-in WSL scan toggle. |
| **AI Tool Limits** | Which providers to probe for session / weekly / billing / credit windows, and how often to refresh. |
| **Accounts** | Credentials for providers that need them (DeepSeek, GLM, Volcengine, Qoder, Ollama, Kimi, …) and multiple accounts per provider — including switching which tracked Codex account is the active local one. |
| **Multi-device Sync** | **Local only** (no hub), **Connect to a hub** (paste another machine's Hub URL + secret), or **Host hub on this device** (run a hub locally; the panel lists reachable LAN / Tailscale / ZeroTier addresses). |

The `⇧` button in the title bar cycles the window behavior.

---

## Headless agent & hub (`.env`)

The agent and hub have no UI. Configure them with a `.env` file in the project root (copy it from `.env.example`):

```env
TOKEN_MONITOR_HUB_URL=               # required in sync mode — Worker URL or http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # shared secret; must match the hub
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to the hostname
TOKEN_MONITOR_SYNC_UPLOAD_INTERVAL_MS= # optional — 0/live, 600000/10min, 1200000/20min, 1800000/30min
TOKEN_MONITOR_CLIENTS=               # optional — defaults to all supported tools; empty disables tracking
TOKEN_MONITOR_PROJECTS_ENABLED=      # optional — defaults off; 1 collects project metadata
TOKEN_MONITOR_HISTORY_ENABLED=       # optional — defaults on; 0 skips trend history
TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED= # optional — defaults on; 0 stops archiving deleted-session usage
TOKEN_MONITOR_LIMITS_ENABLED=        # optional — defaults on; 0 skips CLI probing
TOKEN_MONITOR_LIMIT_PROVIDERS=       # optional — defaults to all supported providers
```

Provider credentials (Grok, DeepSeek, Minimax, Copilot, GLM / GLM Team, Volcengine, Qoder, Ollama, Kimi, …) and proxy settings live in the same file. **`.env.example` is the complete, authoritative list** — start from it rather than copying keys by hand, since it stays in sync with the code.

The widget reads these as first-run defaults; the agent and hub take a CLI flag over an env var over the built-in default.

One-shot run (collect once and exit — useful for cron / launchd):

```bash
npm run agent -- --clients=claude,codex,opencode --once
```
