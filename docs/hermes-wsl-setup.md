# Hermes Agent WSL 集成指南

## 问题背景

在 Windows 上使用 Token Monitor 时，能否检测到 AI 工具取决于数据的存放位置：

| 工具 | 数据位置 | Token Monitor 检测方式 | 状态 |
|:---|:---|:---|:---:|
| **Codex（Windows 原生）** | `C:\Users\用户名\.codex\sessions\` | 本地文件扫描 | ✅ 正常工作 |
| **Codex（WSL）** | `~/.codex/sessions/` | WSL 文件系统扫描 | ✅ 正常工作 |
| **Hermes Agent（WSL）** | `~/.hermes/state.db` | WSL 文件系统扫描 | ⚠️ 需额外配置 |

Hermes Agent 运行在 WSL 中，其会话数据存储在 `~/.hermes/state.db`（SQLite 数据库）。Token Monitor 通过 `tokscale` 工具读取该数据库，但由于 Windows 侧通过 `\\wsl$` UNC 路径访问 WSL 内的 SQLite 文件存在兼容性问题（字节范围锁定、路径混合斜杠等），导致直接扫描无法读取数据。

## 解决方案

采用 Token Monitor 的多设备架构：**WSL 内运行 headless agent → Windows 端 host hub 接收数据**。

```
┌─────────────────────────────────────────────────────────┐
│                    Windows                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Token Monitor Widget (Hub 主机模式)              │   │
│  │  ├── 本地扫描 → Codex ✅                          │   │
│  │  └── 接收 WSL agent → Hermes ✅                   │   │
│  └──────────────────────────────────────────────────┘   │
│                          ↑                               │
│                     POST /api/ingest                     │
└──────────────────────────┼──────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────┐
│                    WSL                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Headless Agent                                   │   │
│  │  tokscale 原生 Linux 读取                          │   │
│  │  ~/.hermes/state.db → Hermes ✅                   │   │
│  │  ~/.codex/sessions/ → Codex ✅                    │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 优势

- **tokscale 在 WSL 原生 Linux 环境下运行**，直接访问 state.db，不存在 UNC 路径 SQLite 兼容问题
- **数据自动合并**：Windows 本地的 Codex 数据和 WSL 的 Hermes 数据在 hub 中合并展示
- **配置一次即可**，后续 agent 可设为定时任务或 systemd 服务自动运行

## 配置步骤

### 第一步：Windows 端开启 Hub 主机模式

1. 打开 Token Monitor
2. 进入 **设置（Settings）** → **多设备同步（Multi-device Sync）**
3. 选择 **「在这台设备托管 Hub」**
4. 确认端口（默认 `17321`）和共享密钥已生成
5. 记录下 **Hub URL**（如 `http://192.168.x.x:17321`）和 **共享密钥**

### 第二步：在 WSL 安装 Token Monitor

如果你已通过安装包在 Windows 安装了 Token Monitor，WSL 端只需安装 headless agent 所需的依赖：

```bash
# 在 WSL 中执行
cd ~
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm install
```

### 第三步：配置环境变量

在 `token-monitor/.env` 文件中填入以下配置：

```bash
# Hub 地址（Windows 端的 IP 和端口）
TOKEN_MONITOR_HUB_URL=http://192.168.x.x:17321

# 共享密钥（与 Windows hub 保持一致）
TOKEN_MONITOR_SECRET=你的共享密钥

# 设备 ID —— 必须与 Windows widget 不同！
# 如果两台设备 ID 相同，后推送的数据会覆盖前者
TOKEN_MONITOR_DEVICE_ID=hermes-wsl
```

> **💡 提示：** Windows 端和 WSL 端的设备 ID 不能相同。
> Windows widget 通常使用主机名（如 `DESKTOP-XXX`），WSL agent 建议设为 `hermes-wsl` 或 `wsl-agent` 以避免冲突。

### 第四步：运行 Agent 验证

首次运行使用 `--once` 模式做一次性推送测试：

```bash
cd ~/token-monitor

# 注意：如果 WSL 配置了 HTTP_PROXY 代理，
# 需要确保 hub 地址不被代理拦截
no_proxy=192.168.x.x,172.25.0.0/16 \
NO_PROXY=192.168.x.x,172.25.0.0/16 \
npm run agent -- --once
```

验证输出应显示类似内容：

```
Token Monitor agent device=hermes-wsl hub=http://192.168.x.x:17321
[timestamp] posted hermes-wsl: today=226683020 month=793322720 allTime=793322720
```

### 第五步：配置定时运行

#### 方式 A：Crontab（推荐）

```bash
crontab -e
```

添加以下行（每 30 分钟运行一次）：

```cron
*/30 * * * * cd /home/用户名/token-monitor && no_proxy=192.168.x.x NO_PROXY=192.168.x.x npm run agent -- --once >> /tmp/token-monitor-agent.log 2>&1
```

#### 方式 B：Systemd 用户服务

创建 `~/.config/systemd/user/token-monitor-agent.service`：

```ini
[Unit]
Description=Token Monitor Headless Agent (WSL)

[Service]
Type=oneshot
ExecStart=/usr/bin/npm run agent -- --once
WorkingDirectory=/home/用户名/token-monitor
Environment=NO_PROXY=192.168.x.x,172.25.0.0/16

[Install]
WantedBy=default.target
```

配合 timer 每 30 分钟触发：

```ini
[Unit]
Description=Token Monitor Agent Timer

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now token-monitor-agent.timer
```

## 注意事项

### 1. 设备 ID 冲突

WSL agent 和 Windows widget 默认使用相同的主机名作为设备 ID。如果两者相同：
- **后推送的数据会覆盖前者**，导致数据丢失
- 务必在 `.env` 中设置 `TOKEN_MONITOR_DEVICE_ID=hermes-wsl` 或其他不重复的 ID

### 2. HTTP 代理拦截

如果 WSL 配置了 HTTP 代理（如 Clash、V2Ray 等），agent 向 hub 的推送请求可能被代理拦截导致超时。两种解决方式：

- **方式一：** 设置 `NO_PROXY` 环境变量，排除 hub IP 和 WSL 内网段
- **方式二：** 取消设置 HTTP 代理变量：`env -u HTTP_PROXY -u HTTPS_PROXY npm run agent -- --once`

### 3. WSL 工具的重复计算（重要）

Windows widget 内建的 WSL 扫描本来就会隔着 `\\wsl$` 读到 WSL 里走 JSONL 的工具（Codex、Claude 等）。如果 WSL agent 又上报同样的工具，由于用的是不同 deviceId，hub 会把两份相加（不去重），导致这些工具被算两次。Hermes 不受影响——它是 SQLite，隔着 `\\wsl$` 读不到，只有 WSL 内的 agent 读得到。

**建议**：把 WSL agent 的 `TOKEN_MONITOR_CLIENTS` 只填 Windows 侧读不到的工具（比如就填 `hermes`），让 Windows 侧继续负责 Codex 那类 JSONL 工具，两边不重叠就不会重复。

### 4. Windows 防火墙

如 agent 推送失败，检查 Windows 防火墙是否放行了 hub 端口（默认 `17321`）。确保 WSL 的 IP 段（通常是 `172.25.0.0/16`）可以访问 Windows 上的 hub 地址。

## 工作原理

```
Windows widget 开启 hub 后：
  1. 启动本地的 collector，扫描 Windows 端的 Codex、Cursor 等数据
  2. 将本地数据推送到嵌入式 hub
  3. 在 `http://<ip>:17321/api/devices` 上等待外部 agent 的数据

WSL agent 运行时：
  1. 调用 tokscale 扫描 WSL 内的 AI 工具数据
     - `~/.hermes/state.db` → Hermes ✅（原生 Linux SQLite 访问）
     - `~/.codex/sessions/` → Codex ✅
  2. 将数据 POST 到 Windows hub 的 `/api/ingest` 接口
  3. hub 合并多台设备的数据后，通过 SSE 推送给 widget 展示
```

## 故障排除

| 现象 | 原因 | 解决 |
|:---|:---|:---|
| agent 报 `ConnectTimeoutError` | HTTP 代理拦截 | 设置 `NO_PROXY` 或取消代理变量 |
| hub 有多个设备但 Codex 数据丢失 | 设备 ID 冲突 | 给 WSL agent 设置不同的 `TOKEN_MONITOR_DEVICE_ID` |
| agent 可以推送但 widget 没更新 | 第一次推送还没触发 | 等 5 分钟让 widget 的 collector 跑一次，或右键刷新 |
| `\\wsl$` 路径无法访问 | WSL 发行版未运行 | 确保 WSL 发行版在运行（`wsl -l -v`） |
