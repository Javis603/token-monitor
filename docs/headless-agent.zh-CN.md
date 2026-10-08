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
chmod 600 .env   # macOS/Linux：之后会存放 hub 密钥
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
- `TOKEN_MONITOR_CLIENTS` 列出要采集的工具（逗号分隔）。`.env.example` 已列出默认的工具，删掉不需要的即可。Qoder CN 默认关闭，需要时加入 `qodercn`。
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

常驻的 agent 会监听工具数据，几秒内上报更新，并定期重扫作为兜底。按 Ctrl-C 停止。

如需无人值守运行，请交给所在平台的服务管理器启动，例如 systemd 用户服务、launchd agent 或任务计划程序。无论用哪一种：

- 以你自己的用户身份、在 checkout 目录中运行。agent 读取的是运行账户主目录下的工具数据。
- 让 Node 位于它的 `PATH` 中。服务管理器启动时的 `PATH` 很精简，请加入 `dirname "$(command -v node)"` 输出的目录。nvm 等版本管理器的路径里带有 Node 版本号，升级 Node 后要同步更新。
- 无论以何种方式退出都要重启。agent 收到 SIGTERM 和 SIGHUP 时以状态 0 退出，所以只在失败时重启的策略（例如 systemd 的 `Restart=on-failure`）会让它停下；请使用 `Restart=always` 或服务管理器中的等效设置。

在 Windows 桌面上，通常直接用 widget 更合适。

如果无法常驻进程，可以改为用 cron 等调度器定时运行 `npm run agent:once`。每次都会完整扫描，因此更新频率取决于定时间隔。

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
- **请求经过代理**：把 hub 主机加入 `NO_PROXY` 与 `no_proxy`，或为 agent 取消代理环境变量。
- **两台设备互相覆盖**：为每台机器设置不同的 `TOKEN_MONITOR_DEVICE_ID`。
- **总量翻倍**：有两个采集器读取了同一份工具数据，例如 Windows widget 的 WSL 扫描与 WSL 内的 agent。请在其中一边缩小 `TOKEN_MONITOR_CLIENTS`；hub 只会相加设备总量，不会跨设备去重 session。
- **某个工具没有用量**：运行 `npm run agent:once -- --dry-run`，看摘要中是否有该工具；如果没有，确认它在 `TOKEN_MONITOR_CLIENTS` 中（或该变量未设置），并且其数据位于当前用户的主目录下。
