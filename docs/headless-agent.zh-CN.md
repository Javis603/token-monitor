<p align="right">
   <a href="./headless-agent.md">EN</a> | <strong>简</strong> | <a href="./headless-agent.zh-TW.md">繁</a>
</p>

# Headless Agent

Headless agent 就是去掉界面的 widget 采集器。它扫描本机上的 AI 工具，把用量摘要发送到 hub，让这台机器在所有已连接的 widget 里显示为一台设备。

## 什么时候需要

- 服务器、SSH 主机等会用 AI 工具、但不运行桌面 widget 的机器。
- 在 WSL 内采集 Windows widget 无法可靠读取的 SQLite 工具。请按照 [WSL SQLite 用量配置指南](wsl-sqlite-setup.zh-CN.md)操作，它在本指南之上补充了 WSL 专属步骤。

已经运行 widget 的机器不需要 agent：开启多设备同步后，widget 会自动上报本机用量。iCloud Drive 同步仅供 widget 使用，不接受 agent。

## 前置条件

- Node.js 22.15.0 或更高版本，以及 npm 和 git。
- 一个 agent 能访问到的 hub：widget 内置 hub、Node hub 或 Cloudflare Worker（见 [多设备同步](../README.zh-CN.md#多设备同步)），并准备好它的 URL 与共享密钥。

## 安装

```bash
node --version   # 必须是 v22.15.0 或更高
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm ci
cp .env.example .env
chmod 600 .env   # 之后会存放 hub 密钥
```

`npm ci` 会安装上游 tokscale 包。第一次运行 `npm run agent` 或 `npm run agent:once`（包括 `--dry-run`）时，会把其中的二进制替换为本平台固定版本的 tokscale 并校验 checksum；之后的运行会跳过下载。没有固定版本的平台会保留 npm 安装的二进制。

## 配置

至少在 `token-monitor/.env` 中设置以下几项：

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev   # 或 http://<hub-ip>:17321
TOKEN_MONITOR_SECRET=你的共享密钥
TOKEN_MONITOR_DEVICE_ID=build-server
```

- `TOKEN_MONITOR_DEVICE_ID` 默认是主机名，必须在所有设备之间唯一：hub 会把相同 ID 当作同一台设备，后发送的记录会覆盖另一台。
- `TOKEN_MONITOR_CLIENTS` 限制要采集的工具（逗号分隔）。不设置则采集所有支持的工具。
- 额度所需的服务商凭据、代理设置以及其他所有选项，见 [`.env.example`](../.env.example) 与 [configuration.md](configuration.md#headless-agent--hub-env)。优先级为 CLI 参数 → 环境变量 → 内置默认值。

无论从哪个目录启动，agent 都会读取 checkout 根目录下的 `.env`。

## 验证

打印 agent 将要发送的摘要，但不发送到 hub：

```bash
npm run agent:once -- --dry-run
```

然后发送一次真实快照，确认已连接的 widget 中出现这台设备：

```bash
npm run agent:once
```

## 持续运行

```bash
npm run agent
```

常驻的 agent 会监听工具数据，几秒内上报更新，并定期重扫作为兜底。按 Ctrl-C 停止。如需无人值守运行，请交给服务管理器启动。以下示例假设 checkout 位于 `~/token-monitor`；如果克隆到别处，请相应修改路径。

服务管理器启动时的 `PATH` 很精简，所以示例都显式设置了它。请把 Node 目录替换成 `dirname "$(command -v node)"` 的输出；通过 nvm、fnm 或 Homebrew 安装 Node 时尤其需要。版本管理器的路径里带有版本号，升级 Node 后要同步更新。

### Linux（systemd 用户服务）

创建 `~/.config/systemd/user/token-monitor-agent.service`：

```ini
[Unit]
Description=Token Monitor headless agent

[Service]
WorkingDirectory=%h/token-monitor
Environment=PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env npm run agent
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now token-monitor-agent
loginctl enable-linger "$USER"   # 注销后仍保持运行
journalctl --user -u token-monitor-agent -f
```

在 WSL 中，需要先在 `/etc/wsl.conf` 启用 systemd（`[boot]` → `systemd=true`），再在 Windows 中运行 `wsl --shutdown` 使其生效。不使用 systemd 时，请改为从 shell 配置文件启动 agent。WSL 不会随 Windows 自动启动，所以 agent 只在发行版运行时工作。

### macOS（launchd agent）

创建 `~/Library/LaunchAgents/com.token-monitor.agent.plist`，把 `YOU` 换成你的用户名：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.token-monitor.agent</string>
  <key>WorkingDirectory</key><string>/Users/YOU/token-monitor</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>npm</string><string>run</string><string>agent</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/path/to/node/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/token-monitor-agent.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/token-monitor-agent.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.token-monitor.agent.plist
launchctl bootout "gui/$(id -u)/com.token-monitor.agent"   # 停止
```

`gui` 域只在你登录桌面时存在。只通过 SSH 访问的 Mac，请开启自动登录，让 agent 在重启后也能启动。

### Windows（任务计划程序）

```powershell
schtasks /Create /TN "Token Monitor agent" /SC ONLOGON /TR "cmd /c cd /d %USERPROFILE%\token-monitor && npm run agent"
```

请保留 `%USERPROFILE%` 原样：任务运行时由 `cmd` 展开。该任务会在登录时打开控制台窗口，关闭窗口即停止 agent，崩溃后也不会自动重启。在 Windows 桌面上，通常直接用 widget 更合适。

### 定时单次运行

如果无法常驻进程，可以改为定时运行 `npm run agent:once`，例如用 cron：

```cron
*/10 * * * * cd "$HOME/token-monitor" && PATH=/path/to/node/bin:/usr/bin:/bin npm run agent:once >> "$HOME/token-monitor-agent.log" 2>&1
```

每次都会完整扫描，因此更新频率取决于定时间隔。

## 更新

先停止 agent 或其服务：`npm ci` 会替换 `node_modules`，包括 agent 正在使用的 tokscale 二进制。

```bash
cd ~/token-monitor
git pull
npm ci
```

然后重新启动。如果固定的 tokscale 版本有变化，下次启动时会自动获取。

## 卸载

停止并移除服务，删除 checkout，再删除 agent 的状态目录：Linux 为 `~/.config/Token Monitor/`，macOS 为 `~/Library/Application Support/Token Monitor/`，Windows 为 `%APPDATA%\Token Monitor\`（若设置了 `TOKEN_MONITOR_SHARED_DIR` 则为该目录）。如果这台机器也装了 widget，这同时也是 widget 的数据目录。tokscale 的设置与价格缓存位于 `%APPDATA%\tokscale\`（Windows）或 `~/.config/tokscale/`（其他系统）；除非你也在使用 tokscale CLI，否则一并删除。要把设备从面板中移除，请在已连接 widget 的设备列表中删除它。

## 排查

- **设备一直没有出现**：检查 `TOKEN_MONITOR_HUB_URL` 与 `TOKEN_MONITOR_SECRET`，以及本机能否访问 hub 端口（防火墙、局域网或 VPN）。启动时出现 `TOKEN_MONITOR_SECRET` 警告，表示 agent 正在不带密钥发送。
- **`No such built-in module: node:sqlite`**：Node 版本低于要求。升级后重新打开终端，确认 `node --version` 显示新版本。
- **`systemctl --user` 报 `Failed to connect to bus`**：当前 shell 没有用户会话，常见于 `su` 或 `sudo -u` 之后。请以该用户通过 SSH 或桌面登录后再执行，或先运行 `export XDG_RUNTIME_DIR=/run/user/$(id -u)`。
- **请求经过代理**：把 hub 主机加入 `NO_PROXY` 与 `no_proxy`，或为 agent 取消代理环境变量。
- **两台设备互相覆盖**：为每台机器设置不同的 `TOKEN_MONITOR_DEVICE_ID`。
- **总量翻倍**：有两个采集器读取了同一份工具数据，例如 Windows widget 的 WSL 扫描与 WSL 内的 agent。请在其中一边缩小 `TOKEN_MONITOR_CLIENTS`；hub 只会相加设备总量，不会跨设备去重 session。
- **某个工具没有用量**：运行 `npm run agent:once -- --dry-run`，看摘要中是否有该工具；如果没有，确认它在 `TOKEN_MONITOR_CLIENTS` 中（或该变量未设置），并且其数据位于当前用户的主目录下。
