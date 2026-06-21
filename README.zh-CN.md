<p align="right">
   <a href="./README.md">EN</a> | <strong>简</strong> | <a href="./README.zh-TW.md">繁</a>
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
    <a href="worker/README.md"><img src="https://img.shields.io/badge/Worker-Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Worker" /></a>
    <a href="https://discord.gg/HmdNVVvw5P"><img src="https://img.shields.io/discord/1344259784219689031?color=5865F2&label=Discord&logo=discord&logoColor=white&style=flat-square" alt="Discord"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="许可证：MIT" /></a>
</p>

<div align="center">
    <img src=".github/assets/demo.gif">
</div>

## Token Monitor 是什么？

一款桌面小部件，实时显示各种 AI 编程工具（包含 Claude Code、Codex、Hermes Agent、OpenCode、OpenClaw、Cursor、Antigravity、Cline、Kimi、Qwen、Grok Build、GitHub Copilot 等）的 Token 用量与 AI 工具用量上限，具备实时多设备同步与历史使用趋势功能，并支持按工具、设备、模型或 session 分项显示。

## 支持的工具

Token Monitor 对「Token 用量」「账户用量上限」和「session 明细」分别支持：

| Logo | 工具 | 数据路径 | Token 用量 | AI 工具用量上限 | session 明细 |
|:---:|------|-----------|:---:|:---:|:---:|
| <img src=".github/assets/tools-icon/claude.png" width="28" alt="Claude Code" /> | Claude Code | `~/.claude/projects/`、`~/.claude/transcripts/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/codex.png" width="28" alt="Codex" /> | Codex | `~/.codex/sessions/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/opencode.png" width="28" alt="OpenCode" /> | OpenCode | `~/.local/share/opencode/` | ✅ | ✅ | ✅ |
| <img src=".github/assets/tools-icon/hermes-agent.png" width="28" alt="Hermes Agent" /> | Hermes Agent | `$HERMES_HOME` 或 `~/.hermes/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/openclaw.png" width="28" alt="OpenClaw" /> | OpenClaw | `~/.openclaw/agents/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/cursor.png" width="28" alt="Cursor" /> | Cursor | `~/.config/tokscale/cursor-cache/`（由 Cursor 同步保持更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/antigravity.png" width="28" alt="Antigravity" /> | Antigravity | `~/.config/tokscale/antigravity-cache/`（由 Antigravity 同步保持更新） | ✅ | ✅ | — |
| <img src=".github/assets/tools-icon/cline.png" width="28" alt="Cline" /> | Cline | VS Code globalStorage tasks（`.../saoudrizwan.claude-dev/tasks/`） | ✅ | — | — |
| <img src=".github/assets/tools-icon/kimi.png" width="28" alt="Kimi" /> | Kimi CLI / Kimi Code | `~/.kimi/sessions/`、`~/.kimi-code/sessions/`（`KIMI_CODE_HOME`） | ✅ | — | — |
| <img src=".github/assets/tools-icon/qwen.png" width="28" alt="Qwen" /> | Qwen CLI | `~/.qwen/projects/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/xai.png" width="28" alt="Grok Build" /> | Grok Build | `$GROK_HOME/sessions/` 或 `~/.grok/sessions/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/copilot.png" width="28" alt="GitHub Copilot" /> | GitHub Copilot CLI | `~/.copilot/otel/` | ✅ | — | — |
| <img src=".github/assets/tools-icon/deepseek.png" width="28" alt="DeepSeek" /> | DeepSeek | DeepSeek API 密钥（通过 DeepSeek API 查询余额） | — | ✅ | — |

## 为什么用 Token Monitor？

大多数用量监控工具只在它运行的那台机器上有用。Token Monitor 是为多设备工作流而设计的：每台设备监视自己的本地日志、把汇总更新发送到你的 hub，每个连接中的小部件几乎都能实时看到 Token 变化。

## 功能特性

- **实时 Token 追踪**：覆盖 Claude Code、Codex、Hermes Agent、OpenCode、OpenClaw、Cursor、Antigravity、Cline、Kimi、Qwen、Grok Build、GitHub Copilot（每轮对话后 UI 在数秒内刷新）
- **WSL 用量（Windows）**：在运行中的 WSL 发行版里使用的 AI 工具用量会自动识别并并入总量（随定期扫描刷新，约每 5 分钟一次）
- **多设备实时同步**：通过 Server-Sent Events 推送
- **分组统计视图**：可按工具、设备、模型、session 或账户用量上限分组
- **单个 session 明细**：点进 Claude Code、Codex 或 OpenCode 的 session，可看每条提问的 Token 消耗，并展开查看每次回复的 Token 拆分与用到的工具（打开时才实时读取本机 transcript 或数据库，绝不同步）
- **缓存命中统计**：点击任何工具或模型以展开查看输入 Token（缓存命中与未命中）、输出 Token 的详细分类及命中率百分比
- **成本分项**：Token 数量旁附带成本统计
- **使用趋势与仪表板**（需手动开启）：独立的仪表板窗口，提供 GitHub 风格的活跃热力图、连续天数，以及跨所有设备、按工具／按模型堆叠的历史（柱状图与 K 线两种视图）
- **AI 工具用量上限检测**：支持 Claude Code、Codex、Cursor、Antigravity 与 OpenCode，涵盖 session、每周、账单与 credits 窗口，以及 DeepSeek 预付余额与今日/本月消费
- **可选的状态视图**：追踪 Claude、OpenAI、Cursor 与 DeepSeek status 页，支持手动或定时重新检查
- **工具列表自定义**：可隐藏、置顶和拖曳排序主列表中的工具，不影响实际追踪
- **外观控制**：界面主题切换（含浅色模式）、各工具厂商色、玻璃透明度、模糊度、完全透明窗口
- **菜单栏（macOS）与系统托盘（Windows）弹出窗口**：图标旁可显示成本、token 数，或 Claude／Codex／Cursor／Antigravity／OpenCode 最接近用完的用量上限百分比
- **悬浮小窗模式**：可将组件收成可拖动的紧凑小窗，支持点击或悬停预览展开，并可显示托盘同款内容
- **可录制全局快捷键**：可从任何地方快速显示或隐藏窗口
- **本地优先**：单设备使用完全无需服务器
- **自托管同步后端**：小部件内 hub、Node CLI hub 或 Cloudflare Worker
- **iOS 小部件支持**：通过 Worker hub 搭配 Widgy、Scriptable
- **Discord Rich Presence**：将今日 Token、花费与主要工具广播到你的 Discord 个人资料（需手动开启）
- **隐私优先**：只有汇总数字会离开你的机器

| 用量上限视图 | 设备视图 | 模型视图 |
|:---:|:---:|:---:|
| ![用量上限视图](.github/assets/limits-view.png) | ![设备视图](.github/assets/devices-view.png) | ![模型视图](.github/assets/models-view.png) |

| Session 视图 | Session 明细 | 服务状态 |
|:---:|:---:|:---:|
| ![Session 视图](.github/assets/sessions-view.png) | ![Session 明细](.github/assets/session-details.png) | ![服务状态](.github/assets/status-view.png) |

| 使用仪表板 — 总览 | 使用仪表板 — 趋势 |
|:---:|:---:|
| ![使用仪表板 总览](.github/assets/dashboard-overview.png) | ![使用仪表板 趋势](.github/assets/dashboard-trends.png) |

## 安装

### 本地模式——单设备

默认模式。无需 hub、无需代理、无需任何配置。

```bash
npm install
npm start
```

### 多设备同步

挑一个所有设备（与任何无头代理）都能连上的 hub 后端。在每台设备上打开小部件，在 设置 → 多设备同步 选一个模式。小部件会自动上报本机用量；只在没有小部件的机器上跑 `npm run agent`。

#### 方案 A——直接在小部件内开 hub（最简单，无需命令行）

在一台长期开机的机器上打开小部件，进入 设置 → 多设备同步，选 **Host hub on this device**。小部件会生成随机 secret，并列出其他设备可以连入的局域网 URL（Tailscale 或 ZeroTier 地址也会显示在这里）。在其他每台设备上选 **Connect to a hub**，把 URL 与 secret 贴进去即可。

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

## 桌面安装包

你可以从 [releases 页面](https://github.com/Javis603/token-monitor/releases) 下载 App。所有 release 都未签名，发布说明含 macOS（arm64）与 Windows（x64）的首次启动解锁步骤。其他平台请从源码 `npm start` 运行。

App 状态保存在系统的用户数据目录——卸载时一并删除该目录即可完整移除。

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/Token Monitor/` |
| Windows | `%APPDATA%/Token Monitor/` |

## 从源码构建

Release 都未签名，你可能想自己从源码打包安装包——同一份代码、在你自己的机器上构建。需要 Node.js 22.13+ 与**对应的**操作系统（electron-builder 无法在 Windows 上交叉构建 macOS 的 `.dmg`，反之亦然）。

```bash
npm install
npm run dist:mac   # macOS arm64 .dmg → dist/
npm run dist:win   # Windows x64 安装包 .exe → dist/
npm run pack       # 未打包的 app 目录（无安装包），方便本机快速测试
```

产物会放在 `dist/`。构建出来一样未签名，所以首次启动的解锁步骤照旧。Linux 与 Intel Mac 没有打包目标——直接用 `npm start` 运行。

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

## 设置

### 小部件（GUI）

点击小部件标题栏上的 `⚙` 按钮打开设置面板。

- **多设备同步**——三种模式：**Local only**（仅本机，无 hub）、**Connect to a hub**（贴入其他机器的 Hub URL + secret）、**Host hub on this device**（在本机开 hub 供其他设备连入；面板会列出可用的局域网 / Tailscale / ZeroTier 地址）。
- **追踪的工具**——选择要采集的 AI 工具，也可以独立隐藏、置顶或拖曳排序主列表中的工具。
- **AI 工具用量上限**——选择 Claude Code、Codex、Cursor、Antigravity、OpenCode 与 DeepSeek 的用量上限检测与刷新频率。
- **趋势**——需手动开启的使用历史；开启后会采集每日历史，并可打开使用仪表板（活跃热力图、连续天数，以及按工具／按模型堆叠的柱状图与 K 线图）。
- **窗口行为**——选择浮在其他 app 上方、普通窗口，或固定在桌面。
- **托盘模式**——切换为 macOS 菜单栏或 Windows 系统托盘的弹出窗口，并选择图标旁显示的内容：成本、今日 token 数、累计 token 数、成本＋token、最接近用完的 Claude／Codex／Cursor／Antigravity／OpenCode 用量上限百分比，或仅显示图标。
- **悬浮小窗**——将组件收成可拖动的小窗，可用点击或悬停预览展开，并可选择显示图标、token、费用或 AI 工具额度条。
- **快捷键**——录制全局快捷键，用来显示或隐藏窗口。
- **外观**——界面主题切换，可选预设（默认、黑曜、瓷白浅色模式）或自定义色彩（强调色、背景、文字、次要文字）、各工具厂商色、系统玻璃、实时指示点、工具图标、Discord Rich Presence、玻璃透明度、玻璃模糊度。
- **高级**——打开底层 `settings.json` 调整较少用的选项，例如 `allTimeSince`。

小部件标题栏上的置顶按钮可切换「始终置顶」。

### 无头代理与 hub（`.env`）

代理与 hub 没有 UI。请在项目根目录用 `.env` 文件配置（从 `.env.example` 复制）:

```env
TOKEN_MONITOR_HUB_URL=               # 同步模式必填——Worker URL 或 http://<lan-ip>:17321
TOKEN_MONITOR_SECRET=                # 共用 secret，必须与 hub 一致
TOKEN_MONITOR_DEVICE_ID=             # 可选——默认为主机名
TOKEN_MONITOR_CLIENTS=               # 可选——默认为所有支持的工具；设为空表示不追踪
TOKEN_MONITOR_HISTORY_ENABLED=       # 可选——默认关闭；设为 1 可收集趋势历史
TOKEN_MONITOR_LIMITS_ENABLED=        # 可选——默认启用；设为 0 可跳过 CLI 探测
TOKEN_MONITOR_LIMIT_PROVIDERS=       # 可选——默认为所有支持的提供方（claude、codex、cursor、antigravity、opencode、deepseek）
```

小部件会把同样的环境变量读作首次启动的默认值，之后改由 GUI 设置接管。

每个值也都可以通过 CLI 参数传入（`--hub=`、`--secret=`、`--device=`、`--clients=`、`--history=`、`--limits=`、`--limitProviders=`）——参数优先于环境变量。较少用的调整项（`TOKEN_MONITOR_INTERVAL_MS`、`TOKEN_MONITOR_PORT`、`TOKEN_MONITOR_STALE_AFTER_MS`、`TOKEN_MONITOR_HISTORY_INTERVAL_MS`、`TOKEN_MONITOR_LIMITS_REFRESH_MS`、…）一样可通过环境变量／参数配置，但为减少噪音不放进 `.env.example`。

一次性执行示例:

```bash
npm run agent -- --clients=claude,codex,opencode --once
```

## 隐私

hub 与代理只传输汇总字段:

- 设备 id、主机名、平台
- 每个时段的 Token 总数（今日 / 本月 / 全部）
- 成本总额（当 `tokscale` 返回成本数据时）
- 按客户端与模型的分项统计
- 启用 AI 工具用量上限时，归一化后的 Claude Code／Codex／Cursor／Antigravity／OpenCode 用量状态

完全不会传输原始 AI 日志、提示词、源代码或对话内容。也不会传输 OAuth 凭据、访问令牌、刷新令牌、邮箱或提供方原始响应。`.env`、`data/`、`node_modules/` 已加入 gitignore。

## 系统要求

- macOS 或 Windows
- Node.js 22.13+
- 仅同步模式:每个代理／小部件到 hub 的网络连通性

## 致谢

- [tokscale](https://github.com/junhoyeo/tokscale) 提供日志解析与 Token 计算。
- [CodexBar](https://github.com/steipete/CodexBar) 提供 AI 工具用量上限的研究参考。

## 许可证

[MIT](LICENSE) © [@Javis](https://github.com/Javis603)
