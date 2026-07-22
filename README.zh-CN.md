<p align="right">
   <a href="./README.md">EN</a> | <strong>简</strong> | <a href="./README.zh-TW.md">繁</a> | <a href="./README.ko.md">KO</a> | <a href="./README.ja.md">JA</a>
</p>
<div align="center">
    <img src=".github/assets/app.png" alt="Token Monitor logo" width="120">
    <h1>Token Monitor</h1>
</div>

<p align="center">
    <em>跨设备聚合每个 AI 编程工具的实时用量。</em>
</p>

<p align="center">
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/v/release/Javis603/token-monitor?include_prereleases&style=flat-square&label=release&color=22c55e" alt="最新发布" /></a>
    <a href="https://github.com/Javis603/token-monitor/releases"><img src="https://img.shields.io/github/downloads/Javis603/token-monitor/total?style=flat-square&color=22c55e" alt="总下载量" /></a>
    <img src="https://img.shields.io/badge/Windows-10%2B-0078D4?style=flat-square" alt="Windows 10 或更新" />
    <img src="https://img.shields.io/badge/macOS-14%2B-0A84FF?style=flat-square&logo=apple&logoColor=white" alt="macOS 14 或更新" />
    <img src="https://img.shields.io/badge/Linux-x64-64748b?style=flat-square&logo=linux&logoColor=white" alt="Linux x64" />
    <a href="https://discord.gg/HmdNVVvw5P"><img src="https://img.shields.io/discord/1344259784219689031?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="许可证：MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## Token Monitor 是什么？

一款桌面小部件，实时显示 Claude Code、Codex、Cursor、GitHub Copilot 等 25+ 种 AI 编程工具的 Token 用量与 AI 工具额度，具备实时多设备同步与历史使用趋势功能，并支持按工具、设备、模型、session 或项目分项显示。

## 支持的工具

Token Monitor 对 Token 用量、账户额度和 session 明细分别支持：

| Logo | 工具 | 数据路径 | Token 用量 | AI 工具额度 | session 明细 |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`、`~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `$HERMES_HOME/state.db` 或 `~/.hermes/state.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/`（由 Cursor 同步保持更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.config/tokscale/antigravity-cache/`（由 Antigravity 同步保持更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks（`.../saoudrizwan.claude-dev/tasks/`） | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`、`~/.kimi-code/sessions/`（`KIMI_CODE_HOME`）；Kimi Code API 密钥（通过 Kimi API 查询 Kimi Code 额度） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `$GROK_HOME/sessions/` 或 `~/.grok/sessions/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot | VS Code `workspaceStorage/*/chatSessions/`、`~/.copilot/otel/` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/pi.png" width="28" alt="Pi" /> | Pi | `~/.pi/agent/sessions/`、`~/.omp/agent/sessions/`（Oh My Pi） | ✅ | — | — |
| <img src=".github/assets/tools-icon/zed.png" width="28" alt="Zed" /> | Zed | `~/.local/share/zed/threads/threads.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/kilocode.png" width="28" alt="Kilo Code" /> | Kilo Code | VS Code globalStorage tasks（`.../kilocode.kilo-code/tasks/`）—— 仅 Linux 与远程/WSL | ✅ | — | — |
| <img src=".github/assets/tools-icon/mimo-code.png" width="28" alt="MiMo Code" /> | MiMo Code | `~/.local/share/mimocode/mimocode.db` | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/zcode.png" width="28" alt="ZCode" /> | ZCode / GLM | `~/.zcode/projects/`；Z.ai API 密钥（通过 Z.ai API 查询 GLM 个人/团队 Coding Plan 额度） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/kiro.png" width="28" alt="Kiro" /> | Kiro | `~/.kiro/sessions/cli/`、Kiro IDE globalStorage 与 `kiro-cli` 数据库 | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/codebuddy.png" width="28" alt="CodeBuddy" /> | CodeBuddy | `~/.codebuddy/projects/` 与 IDE / VS Code 扩展日志 | ✅ | — | — |
| <img src=".github/assets/tools-icon/workbuddy.png" width="28" alt="WorkBuddy" /> | WorkBuddy | `~/.workbuddy/projects/`、`~/.workbuddy/workbuddy.db` | ✅ | — | — |
| <img src=".github/assets/tools-icon/proma.png" width="28" alt="Proma" /> | Proma | `~/.proma/agent-sessions/*.jsonl` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API 密钥（通过 DeepSeek API 查询余额） | — | ✅ | — |
| <img src=".github/assets/tools-icon/minimax.png" width="28" alt="Minimax" /> | Minimax | Minimax API 密钥（通过 Minimax API 查询 Token Plan 额度） | — | ✅ | — |
| <img src=".github/assets/tools-icon/volcengine.png" width="28" alt="Volcengine" /> | Volcengine | Ark API key 或火山引擎 AK/SK（通过火山引擎 API 查询火山方舟 Coding Plan 额度） | — | ✅ | — |
| <img src=".github/assets/tools-icon/qoder.png" width="28" alt="Qoder" /> | Qoder | Qoder dashboard cookie（通过 Qoder usage API 查询 big-model credits） | — | ✅ | — |
| <img src=".github/assets/tools-icon/ollama.png" width="28" alt="Ollama" /> | Ollama | Ollama Cloud cookie（通过 ollama.com/settings 查询 session／每周用量） | — | ✅ | — |

## 界面展示

<table>
<tr>
<td width="290" align="center"><img src=".github/assets/home-view.png" width="250" alt="主页视图"><br><sub>可自定义仪表板：自选要显示的模块与排序</sub></td>
<td width="290" align="center"><img src=".github/assets/limits-view.png" width="250" alt="额度视图"><br><sub>多账号并列，Codex 可一键切换本机账号</sub></td>
<td width="290" align="center"><img src=".github/assets/tools-view.png" width="250" alt="工具视图"><br><sub>点任一工具展开输入／输出与缓存命中明细</sub></td>
</tr>
<tr>
<td width="290" align="center"><img src=".github/assets/sessions-view.png" width="250" alt="Session 视图"><br><sub>点进单个 session，逐条提问拆解 token 与用到的工具</sub></td>
<td width="290" align="center"><img src=".github/assets/models-view.png" width="250" alt="模型视图"><br><sub>跨工具汇总每个模型的用量与成本</sub></td>
<td width="290" align="center"><img src=".github/assets/devices-view.png" width="250" alt="设备视图"><br><sub>每台设备的用量、成本与同步状态，可展开看单机明细</sub></td>
</tr>
</table>

<table>
<tr>
<td width="435" align="center"><img src=".github/assets/dashboard-overview.png" width="400" alt="使用仪表板 总览"><br><sub>跨所有设备汇总的一年活跃热力图与连续天数</sub></td>
<td width="435" align="center"><img src=".github/assets/dashboard-trends.png" width="400" alt="使用仪表板 趋势"><br><sub>一年的每日趋势，按工具／模型堆叠，含 K 线</sub></td>
</tr>
</table>

## 为什么用 Token Monitor？

大多数用量监控工具只在它运行的那台机器上有用。Token Monitor 是为多设备工作流而设计的：每台设备监视自己的本地日志、把汇总更新发送到你的 hub，每个连接中的小部件几乎都能实时看到 Token 变化。

## 功能特性

### 用量追踪

- **实时 Token 追踪**：Claude Code、Codex、Cursor、GitHub Copilot、Antigravity、OpenCode 等 20+ 种 AI 工具，每轮对话后 UI 在数秒内刷新（完整列表见上方表格）
- **单个 session 明细**：点进 Claude Code、Codex 或 OpenCode 的 session，可看每条提问的 Token 消耗，并展开查看每次回复的 Token 拆分与用到的工具（打开时才实时读取本机 transcript 或数据库，绝不同步）
- **缓存命中统计**：点击任何工具或模型，展开查看输入 Token（缓存命中与未命中）、输出 Token 的详细分类及命中率百分比
- **成本与币别**：Token 数量旁附带成本；可用 USD、TWD、HKD 或 CNY 显示，汇率每日自动更新，也可在设置中手动覆写
- **WSL 用量（Windows）**：运行中 WSL 发行版里的文件型用量会自动识别，约每 5 分钟并入总量；OpenCode、Hermes 等 SQLite 来源可能需要按照[指南](docs/wsl-sqlite-setup.zh-CN.md)在 WSL 内运行 headless agent

### 额度、趋势与导出

- **AI 工具额度检测**：涵盖 Claude Code、Codex、Cursor、GLM、Kimi 等 15+ 家提供方的 session、每周、账单与 credits 窗口，以及 DeepSeek 预付余额与今日/本月消费
- **多账号与 Codex 账号切换**：同一提供方可追踪多个账号、各自显示额度；已加入追踪的 Codex 账号还能一键切换为本机使用账号，免重新登录授权
- **保留已删除会话用量**：许多工具会定期清除旧 session（Claude Code 默认清 30 天前的 transcript），一删就再也算不到。开启后，Token Monitor 会在本地不设期限地归档已观测到的每日工具／模型用量，让热力图与趋势即使在来源文件被清掉后仍然完整（详见下方[〈会话数据保留期〉](#会话数据保留期)）
- **使用趋势与仪表板**：主页的活跃热力图与趋势图，加上独立的仪表板窗口，提供连续天数，以及跨所有设备、按工具／按模型堆叠的历史（柱状图与 K 线两种视图）
- **可选的状态视图**：追踪 Claude、OpenAI、Cursor 与 DeepSeek status 页，支持手动或定时重新检查
- **数据导出**：把使用数据导出成与工具无关的 CSV + JSON，可手动或自动写入文件夹，接电子表格、Obsidian、Grafana 或自写脚本；详见 [docs/export.md](docs/export.md)

### 多设备与部署

- **多设备实时同步**：通过 Server-Sent Events 推送，一台设备的更新数秒内出现在其他设备
- **本地优先**：单设备使用完全无需服务器
- **自托管同步后端**：小部件内 hub、Node CLI hub 或 Cloudflare Worker
- **iOS 小部件支持**：通过 Worker hub 搭配 Widgy、Scriptable
- **隐私优先**：提示词、回复、源代码和文件内容都留在你的设备上

### 界面与呈现

- **分组视图**：可按工具、设备、模型、session、项目或账户额度分组查看用量
- **菜单栏（macOS）与系统托盘（Windows）弹出窗口**：图标旁可显示成本、token 数，或最接近用完的提供方剩余额度百分比
- **悬浮小窗模式**：可将组件收成可拖动的紧凑小窗，支持点击或悬停预览展开，并可显示托盘同款内容
- **外观控制**：界面主题切换（含浅色模式）、各工具厂商色、玻璃透明度、模糊度、完全透明窗口
- **工具列表自定义**：可隐藏、置顶和拖曳排序主列表中的工具，不影响实际追踪
- **可录制全局快捷键**：可从任何地方快速显示或隐藏窗口
- **Discord Rich Presence**：将今日 Token、花费与主要工具广播到你的 Discord 个人资料（需手动开启）

## 安装

从 [GitHub Releases](https://github.com/Javis603/token-monitor/releases) 下载。

- **macOS（Apple Silicon）** — `.dmg`，已签名并 notarize
- **macOS（Intel）** — x64 `.dmg`，已签名并 notarize
- **Windows 10/11** — 安装版和便携版 `.exe`，均[已签名](docs/code-signing.md)
- **Linux x64** — `.AppImage`

打包版会自动检查 GitHub Releases。有新版本时，界面会显示更新提示；受支持的平台也可在 设置 → 常规 中安装更新。

### 首次启动

本地模式是默认模式：启动 App 后会开始追踪这台设备。无需 hub、代理或配置。

## 多设备同步

挑一个所有设备（与任何无头代理）都能连上的 hub 后端。在每台设备上打开小部件，在 设置 → 多设备同步 选一个模式。小部件会自动上报本机用量；只在没有小部件的机器上跑 `npm run agent`。

#### 方案 A——直接在小部件内开 hub（最简单，无需命令行）

在一台长期开机的机器上打开小部件，进入 设置 → 多设备同步，选 **在这台设备托管 Hub**。小部件会生成随机 secret，并列出其他设备可以连入的局域网 URL（Tailscale 或 ZeroTier 地址也会显示在这里）。在其他每台设备上选 **连接到 Hub**，把 URL 与 secret 贴进去即可。

只要 Token Monitor 还在跑，hub 就会运行——退出 App（仅关闭窗口不算）会停掉 hub，所有连入的设备都会断开。

#### 方案 B——自托管 Node hub（长期开机的无头机器）

```bash
# 在长期开机的机器上
cp .env.example .env
# 把 TOKEN_MONITOR_SECRET 设为你私有的值，然后:
npm run hub
```

#### 方案 C——Cloudflare Worker hub（跨网络，包含 iPhone）

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Javis603/token-monitor/tree/main/worker)

一键部署——Cloudflare 会在过程中提示你输入 `TOKEN_MONITOR_SECRET`。或手动部署:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put TOKEN_MONITOR_SECRET
npx wrangler deploy
```

把部署 URL 贴到每台设备的小部件 设置 → 多设备同步。iOS 小部件配方与端点参考见 [worker/README.md](worker/README.md)，hub HTTP API 见 [docs/API.md](docs/API.md)。

## App 数据

App 状态保存在系统的用户数据目录——卸载时一并删除该目录即可完整移除。

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Token Monitor/` |
| Windows | `%APPDATA%/Token Monitor/` |
| Linux | `~/.config/Token Monitor/` |

## 从源码构建

如需自己从源码打包安装包，请在**对应的**操作系统上使用 Node.js 22.13+（electron-builder 无法在 Windows 上交叉构建 macOS 的 `.dmg`，反之亦然）。

```bash
npm install
npm run dist:mac     # macOS arm64 .dmg → dist/
npm run dist:mac:x64 # macOS Intel x64 .dmg → dist/
npm run dist:win     # Windows x64 安装包 .exe → dist/
npm run dist:linux   # Linux x64 AppImage → dist/
npm run pack         # 未打包的 app 目录（无安装包），方便本机快速测试
```

产物会放在 `dist/`。Windows 和 Linux 请在对应系统上使用上面的 `dist:*` 脚本。如果要打包 macOS 发布版，需要本机有 Developer ID Application 签名身份；本地开发或未列出的平台请用 `npm start` 运行。

## 工作原理

```text
模式 A——本地（默认，免配置）
    小部件 (Electron) ──▶ tokscale ──▶ ~/.claude、~/.codex、$HERMES_HOME

模式 B——同步（可选，多设备）
    设备 A agent ──▶
    设备 B agent ──▶  hub  ──▶  任一设备上的小部件
    设备 C agent ──▶
```

小部件会根据 设置 → 多设备同步 决定走本地还是同步模式。hub 本身可以是单独的 `npm run hub` 进程、Cloudflare Worker，或直接跑在某一个小部件里（Host 模式）。同步模式下，hub 通过 Server-Sent Events 把聚合后的统计推送给每个连接中的小部件，所以一台设备上的更新会在数秒内出现在其他设备上。

## 会话数据保留期

开启**保留已删除会话用量**（设置 → 采集）后，Token Monitor 会在本地不设期限地归档已观测到的每日工具／模型用量——即使来源工具日后清掉 session，热力图与趋势也不受影响。

<details>
<summary><strong>进阶：延长来源工具本身的保留期</strong></summary>

<br>

热力图与同步数据采用 370 天的滚动窗口（更早的观测数据仍保留在本地供日后查看）。**Claude Code 默认只保留 30 天的 transcript**（`cleanupPeriodDays`）；若想在归档启用前就保住完整的滚动年份，请在时限过去之前于 `~/.claude/settings.json` 调高：

```json
{
  "cleanupPeriodDays": 370
}
```

设更大能留更多，代价是 transcript 会按你设定的期限一直留在磁盘上。其他工具的默认值与配置文件路径，请见 tokscale 的 [Session Data Retention](https://github.com/junhoyeo/tokscale#session-data-retention) 表。

这份归档只涵盖 Token Monitor 已观测过的日期；在它开始追踪之前就被删除的数据无法找回。

</details>

## 设置

设置分两处，日常使用只需要前者：

- **小部件（GUI）**——点右下角的 `⚙` 打开，分区依次为：常规（语言、登录启动、更新）、主画面（首页模块与显示币别）、窗口（窗口行为、托盘模式、悬浮小窗、快捷键）、外观（主题与厂商色）、采集（追踪的工具、采集频率、保留已删除会话用量、数据导出）、AI 工具额度、账号（各提供方凭据）、多设备同步。标题栏的 `⇧` 按钮可循环切换窗口行为。
- **无头代理与 hub**——没有 UI，用项目根目录的 `.env` 配置（从 `.env.example` 复制）；优先级为 CLI 参数 → 环境变量 → 内置默认。

每一项设置与所有环境变量的完整说明，请见[设置参考文档](docs/configuration.md)。

## 隐私

Token Monitor 在本地处理使用日志，不会向项目维护者发送分析或遥测数据。网络访问仅用于文档所述或由用户启用的功能；更新、提供方集成、Discord Rich Presence 与可选多设备同步所使用的数据，请参阅[隐私政策](docs/privacy.md)。

## Star 历史

<a href="https://www.star-history.com/?repos=Javis603%2Ftoken-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&theme=dark&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Javis603/token-monitor&type=date&legend=top-left&sealed_token=VEcaPQSNlH8coYjuILJy7eT6t-pGJrGDEjOAjVwP8WGwNBOeNXoLTcz-KVBaZ2Y8eSqG1tLEpWGF3-5eMvVhW5G8n1ckdYI_uMZ6UCBE7b_eANd6we__7g7yc4ShXemuWfi-8SRcxgJNLK12VZGgBIccY1ceI3T3xm7jBM1TJjTVQFWJ0MmX2e-7QBp9" />
 </picture>
</a>

## 参与贡献

欢迎提交 Issue 和 PR。项目规范、架构说明和命令参考都在 [AGENTS.md](AGENTS.md) 中——它是为编码代理编写的，但同样可以作为贡献者指南。

## 致谢

- [tokscale](https://github.com/junhoyeo/tokscale) 提供日志解析与 Token 计算。
- [CodexBar](https://github.com/steipete/CodexBar) 提供 AI 工具额度的研究参考。
- **[代码签名政策](docs/code-signing.md)：** 免费代码签名由 [SignPath.io](https://signpath.io/) 提供，证书由 [SignPath Foundation](https://signpath.org/) 提供。

## 许可证

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
