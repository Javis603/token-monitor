<p align="right">
   <strong>EN</strong> | <a href="./README.zh-CN.md">简</a> | <a href="./README.zh-TW.md">繁</a> | <a href="./README.ko.md">KO</a> | <a href="./README.ja.md">JA</a>
</p>
<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor logo" width="120">
    <h1>Token Monitor</h1>
</div>

<p align="center">
    <em>One live dashboard for every AI coding tool, synced across every machine.</em>
</p>

<p align="center">
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/v/release/Javis603/token-monitor?include_prereleases&style=flat-square&label=release&color=22c55e" alt="Latest release" /></a>
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/downloads/Javis603/token-monitor/total?style=flat-square&color=22c55e" alt="Total downloads" /></a>
    <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square" alt="Windows 10 or later" />
    <img src="https://img.shields.io/badge/macOS-14%2B-0A84FF?style=flat-square&logo=apple&logoColor=white" alt="macOS 14 or later" />
    <img src="https://img.shields.io/badge/Linux-x64-64748b?style=flat-square&logo=linux&logoColor=white" alt="Linux x64" />
    <a href="https://discord.gg/HmdNVVvw5P"><img src="https://img.shields.io/discord/1344259784219689031?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="License: MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## What is Token Monitor?

A desktop widget that shows live token usage and AI Tool Limits across 25+ AI coding tools — Claude Code, Codex, Cursor, GitHub Copilot, and more — with real-time multi-device sync, historical usage trends, and breakdowns by tool, device, model, session, or project.

## Supported Tools

Token Monitor supports token usage, account-limit checks, and session details separately:

| Logo | Tool | Data path | Token Usage | AI Tool Limits | Session Details |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`, `~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `$HERMES_HOME/state.db` or `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/` (kept fresh by Cursor sync) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.config/tokscale/antigravity-cache/` (kept fresh by Antigravity sync) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks (`.../saoudrizwan.claude-dev/tasks/`) | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`, `~/.kimi-code/sessions/` (`KIMI_CODE_HOME`); Kimi Code API key (Kimi Code quota via Kimi API) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `$GROK_HOME/sessions/` or `~/.grok/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`, `~/.copilot/otel/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi | `~/.pi/agent/sessions/`, `~/.omp/agent/sessions/` (Oh My Pi) | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks (`.../kilocode.kilo-code/tasks/`) — Linux & remote/WSL only | ✅ | — | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/projects/`; Z.ai API key (GLM personal/team Coding Plan quota via Z.ai API) | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`, Kiro IDE globalStorage & `kiro-cli` DB | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` + IDE / VS Code extension logs | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`, `~/.workbuddy/workbuddy.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API key (balance via DeepSeek API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API key (Token Plan quota via Minimax API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key or Volcengine AK/SK (Ark Coding Plan quota via Volcengine API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | Qoder dashboard cookie (big-model credits via Qoder usage API) | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie (session/weekly usage via ollama.com/settings) | — | ✅ | — |

## Showcase

<table>
<tr>
<td width="290" align="center"><img src=".github/assets/home-view.png" width="250" alt="Home View"><br><sub>Customizable dashboard — choose which modules show and their order</sub></td>
<td width="290" align="center"><img src=".github/assets/limits-view.png" width="250" alt="Limits View"><br><sub>Multiple accounts side by side, one-click switch of the active Codex account</sub></td>
<td width="290" align="center"><img src=".github/assets/tools-view.png" width="250" alt="Tools View"><br><sub>Click any tool to expand input / output and cache-hit detail</sub></td>
</tr>
<tr>
<td width="290" align="center"><img src=".github/assets/sessions-view.png" width="250" alt="Session View"><br><sub>Open a single session to break each prompt into tokens and tools used</sub></td>
<td width="290" align="center"><img src=".github/assets/models-view.png" width="250" alt="Models View"><br><sub>Every model's usage and cost, aggregated across tools</sub></td>
<td width="290" align="center"><img src=".github/assets/devices-view.png" width="250" alt="Devices View"><br><sub>Each device's usage, cost, and sync status — expand for per-machine detail</sub></td>
</tr>
</table>

<table>
<tr>
<td width="435" align="center"><img src=".github/assets/dashboard-overview.png" width="400" alt="Usage Dashboard Overview"><br><sub>A year of activity heatmap and streaks, aggregated across all devices</sub></td>
<td width="435" align="center"><img src=".github/assets/dashboard-trends.png" width="400" alt="Usage Dashboard Trends"><br><sub>A year of daily trends, stacked by tool / model, with K-line</sub></td>
</tr>
</table>

## Why Token Monitor?

Most usage monitors are useful on the machine they run on. Token Monitor is built for multi-device work: each device watches its own local logs, sends summary updates to your hub, and every connected widget sees token changes almost immediately.

## Features

### Tracking usage

- **Live token tracking** — Claude Code, Codex, Cursor, GitHub Copilot, Antigravity, OpenCode, and 20+ AI tools, with the UI updating within seconds of each turn (full list in the table above)
- **Per-session detail** — open a Claude Code, Codex, or OpenCode session to see tokens per prompt, expandable to each reply's exact token split and tools used (read on-demand from local transcripts or databases, never synced)
- **Cache hit statistics** — click any tool or model to expand a detailed breakdown of input tokens (cache hit vs miss), output tokens, and hit-rate percentages
- **Cost & currency** — cost alongside token counts, shown in USD, TWD, HKD, or CNY; exchange rates auto-update daily and can be manually overridden in Settings
- **WSL usage (Windows)** — file-based usage from a running WSL distro is detected automatically and merged about every 5 minutes; SQLite-backed tools such as OpenCode and Hermes may require a [headless agent inside WSL](docs/wsl-sqlite-setup.md)

### Limits, trends & export

- **AI Tool Limits detection** — provider-specific session, weekly, billing, and credits windows for Claude Code, Codex, Cursor, GLM, Kimi, and 15+ providers, plus DeepSeek prepaid balance and today/month spend
- **Multiple accounts & Codex switching** — track several accounts per provider, each with its own limits; a tracked Codex account can be switched as the active local account in one click, without re-authenticating
- **Preserve deleted session usage** — many tools prune old sessions (Claude Code drops transcripts after 30 days by default), losing that history. When enabled, Token Monitor archives observed daily tool/model usage locally so the heatmap and trends survive even after the source files are gone (see [Session data retention](#session-data-retention) below)
- **Usage Trends & Dashboard** — a home-screen activity heatmap and trend chart, plus a dedicated dashboard window with streaks and stacked per-tool/per-model history (bar and K-line views) across all your devices
- **Optional Status view** — Claude, OpenAI, Cursor, and DeepSeek status pages, with manual or interval re-checks
- **Data export** — export usage as tool-agnostic CSV + JSON, manually or auto-written to a folder, for spreadsheets, Obsidian, Grafana, or scripts; see [docs/export.md](docs/export.md)

### Multi-device & deployment

- **Real-time multi-device sync** — Server-Sent Events push an update on one device to the others within seconds
- **Local-first** — no servers needed for single-device use
- **Self-hosted sync backend** — in-widget hub, Node CLI hub, or Cloudflare Worker
- **iOS widget support** — Widgy and Scriptable through the Worker hub
- **Privacy-first** — prompts, responses, source code, and file contents stay on your machine

### Interface & surfaces

- **Breakdown views** — grouped by tool, device, model, session, project, or account limits
- **Menu bar (macOS) and system tray (Windows) popover** — live cost, tokens, or the closest-to-empty provider limit % next to the icon
- **Floating Bubble mode** — collapses the widget into a draggable mini-window with click or hover preview and tray-style content
- **Appearance controls** — interface theme switching (incl. a light mode), per-tool vendor colours, glass opacity, blur, and transparent window mode
- **Customizable tool list** — hide, pin, and reorder tools in the main dashboard without changing what gets tracked
- **Recordable global shortcut** — show or hide the window from anywhere
- **Discord Rich Presence** — broadcast today's tokens, cost, and top client (opt-in)

## Installation

Download from [GitHub Releases](https://github.com/Javis603/token-monitor/releases).

- **macOS (Apple Silicon)** — `.dmg`, signed and notarized
- **macOS (Intel)** — x64 `.dmg`, signed and notarized
- **Windows 10/11** — setup and portable `.exe`, [code-signed](docs/code-signing.md)
- **Linux x64** — `.AppImage`

Packaged builds check GitHub Releases automatically. When an update is available, the app shows an update indicator; supported platforms can also install from Settings → General.

### First run

Local mode is the default: launch the app and it starts tracking this device. No hub, agent, or config required.

## Multi-device sync

Pick ONE hub backend that all your devices (and any headless agents) connect to. On each device, open the widget and pick a mode under Settings → Multi-device Sync. The widget contributes this device's usage automatically; run `npm run agent` only on machines without a widget.

#### Option A — Host the hub from the widget (easiest, no CLI)

In the widget on one always-on machine, open Settings → Multi-device Sync and pick **Host hub on this device**. The widget generates a random secret and lists the LAN URLs other devices can connect to (Tailscale or ZeroTier addresses appear here too). On every other device, pick **Connect to a hub** and paste the URL + secret.

The hub runs while Token Monitor is running — quitting (not just closing the window) stops it for all connected devices.

#### Option B — Self-hosted Node hub (always-on headless machine)

```bash
# on the always-on machine
cp .env.example .env
# set TOKEN_MONITOR_SECRET to something private, then:
npm run hub
```

#### Option C — Cloudflare Worker hub (across networks, including iPhone)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis603/token-monitor/tree/main/worker)

One-click deploy — Cloudflare will prompt for the `TOKEN_MONITOR_SECRET` during setup. Or deploy manually:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TOKEN_MONITOR_SECRET
npx wrangler deploy
```

Paste the deployed URL into each device's widget at Settings → Multi-device Sync. See [worker/README.md](worker/README.md) for the iOS widget recipe and endpoint reference, or [docs/API.md](docs/API.md) for the hub HTTP API.

## App data

App state lives in the OS user-data dir — delete it along with the app to fully uninstall.

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Token Monitor/` |
| Windows | `%APPDATA%/Token Monitor/` |
| Linux | `~/.config/Token Monitor/` |

## Build from source

To build your own installer, use Node.js 22.13+ on the **target** OS (electron-builder can't cross-build a macOS `.dmg` on Windows, or vice-versa).

```bash
npm install
npm run dist:mac     # macOS arm64 .dmg           → dist/
npm run dist:mac:x64 # macOS Intel x64 .dmg       → dist/
npm run dist:win     # Windows x64 installer .exe → dist/
npm run dist:linux   # Linux x64 AppImage         → dist/
npm run pack         # unpacked app dir (no installer), for quick local testing
```

Output lands in `dist/`. Windows and Linux use the matching `dist:*` script above on the target OS. Packaging the macOS release build requires a local Developer ID Application signing identity; use `npm start` for local development or unsupported platforms.

## How it works

```text
Mode A — Local (default, no setup)
    widget (Electron) ──▶ tokscale ──▶ ~/.claude, ~/.codex, $HERMES_HOME

Mode B — Sync (opt-in, multi-device)
    device A agent ──▶
    device B agent ──▶  hub  ──▶  widget on any device
    device C agent ──▶
```

The widget chooses local vs sync mode based on Settings → Multi-device Sync. The hub itself can run as a separate `npm run hub` process, a Cloudflare Worker, or directly inside one of the widgets (Host mode). In sync mode the hub pushes aggregated stats to every connected widget over Server-Sent Events, so updates on one device appear on the others within a few seconds.

## Session data retention

With **Preserve deleted session usage** enabled (Settings → Collection), Token Monitor archives observed daily tool/model usage locally with no time limit — so even after a source tool prunes its own sessions, the heatmap and trends are unaffected.

<details>
<summary><strong>Advanced: extend the source tool's own retention</strong></summary>

<br>

The heatmap and sync payload use a rolling 370-day window (older observations remain available locally for future views). **Claude Code keeps only 30 days of transcripts by default** (`cleanupPeriodDays`); to keep the full rolling year before the archive kicks in, raise it in `~/.claude/settings.json` before the window passes:

```json
{
  "cleanupPeriodDays": 370
}
```

A larger value keeps more, at the cost of transcripts living on disk for as long as you set. tokscale's [Session Data Retention](https://github.com/junhoyeo/tokscale#session-data-retention) table covers the other tools' defaults and config paths.

This archive only covers days Token Monitor has already observed; data deleted before it started tracking cannot be recovered.

</details>

## Settings

There are two places to configure Token Monitor; day-to-day use only needs the first:

- **Widget (GUI)** — click the `⚙` button in the bottom-right corner. Sections, in order: General (language, launch at login, updates), Main (Home modules and display currency), Window (window behavior, tray mode, floating bubble, shortcut), Appearance (theme and vendor colours), Collection (tracked tools, collection cadence, Preserve deleted session usage, data export), AI Tool Limits, Accounts (per-provider credentials), and Multi-device Sync. The `⇧` button in the title bar cycles the window behavior.
- **Headless agent & hub** — no UI; configured with a `.env` file at the project root (copy from `.env.example`), precedence CLI flag → env var → built-in default.

See the [configuration reference](docs/configuration.md) for every setting and all environment variables.

## Privacy

Token Monitor processes usage logs locally and sends no analytics or telemetry to the project maintainer. Network access occurs only for documented or user-enabled features. See the [privacy policy](docs/privacy.md) for the data used by updates, provider integrations, Discord Rich Presence, and optional multi-device sync.

## Star History

<a href="https://www.star-history.com/?repos=Javis603%2Ftoken-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&theme=dark&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
 </picture>
</a>

## Contributing

Issues and PRs are welcome. Project conventions, architecture notes, and the command reference live in [AGENTS.md](AGENTS.md) — written for coding agents, but it doubles as the contributor guide.

## Acknowledgments

- [tokscale](https://github.com/junhoyeo/tokscale) for log parsing and token accounting.
- [CodexBar](https://github.com/steipete/CodexBar) for AI Tool Limits research.
- **[Code signing policy](docs/code-signing.md):** Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## License

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
