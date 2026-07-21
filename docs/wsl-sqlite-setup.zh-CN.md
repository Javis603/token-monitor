# WSL SQLite 用量配置指南

[English](wsl-sqlite-setup.md)

## 什么时候需要这样配置

Windows 版 Token Monitor 默认会通过 `\\wsl$` 扫描所有正在运行的 WSL 发行版，并约每五分钟合并一次用量。Codex JSONL session 这类文件型数据通常可以直接读取。

OpenCode 和 Hermes 的当前用量保存在 SQLite 数据库中。Windows 进程可以通过 `\\wsl$` 找到数据库，但 SQLite 无法可靠地跨 WSL 9P 边界协调文件锁和正在使用的 WAL。因此，Token Monitor 可能会在 **设置 → 采集 → WSL 检测** 里显示已找到工具，却没有用量。

不要把复制正在使用的 `.db` 文件当作解决方案。最新事务可能还在 `-wal` 中，而分别复制数据库与 sidecar 文件也无法保证得到一致快照。

可靠的架构是：

```text
WSL headless agent → Windows host hub → Token Monitor widget
```

Agent 在数据库旁边运行 Linux 版 tokscale，再把规范化后的用量摘要发送给 hub。

## 1. 在 Windows 启动 Hub

打开 Token Monitor 的 **设置 → 多设备同步**，选择 **在这台设备托管 Hub**，并记下 Hub URL 与共享密钥。

请只在可信网络中开放 hub，并保留自动生成的密钥。如果 WSL 无法访问界面显示的主机名，请改用 Windows 主机 IP，端口保持不变，默认是 `17321`。

## 2. 在 WSL 安装 Headless Agent

Token Monitor 需要 Node.js 22.13.0 或更高版本。安装前请先在 WSL 内检查 Node.js 与 npm；如果 Node.js 版本过低，请先完成升级。

```bash
node --version
npm --version
git clone https://github.com/Javis603/token-monitor.git
cd token-monitor
npm ci
```

创建 `token-monitor/.env`：

```env
TOKEN_MONITOR_HUB_URL=http://WINDOWS_HOST_IP:17321
TOKEN_MONITOR_SECRET=你的共享密钥
TOKEN_MONITOR_DEVICE_ID=wsl-agent
TOKEN_MONITOR_CLIENTS=opencode,hermes
```

`TOKEN_MONITOR_DEVICE_ID` 必须与 Windows widget 的设备 ID 不同。Hub 会把相同 ID 当作同一台设备，后发送的记录会覆盖前一条。

## 3. 明确采集边界

Hub 会直接相加不同设备的总量，不会跨设备去重同一个 session。请选择一种配置：

- 推荐：保留 Windows 的 WSL 扫描，只让 WSL agent 采集 Windows 无法可靠读取的 SQLite 工具，例如 `TOKEN_MONITOR_CLIENTS=opencode,hermes`。
- 另一种方式：让 WSL agent 采集全部 WSL 工具，然后在 Windows widget 的 **设置 → 采集** 中关闭 **扫描 WSL 内的工具**。

不要让两个采集器同时上报相同的 Codex、Claude Code 或其他文件型 session。

## 4. 验证并持续运行

先发送一次快照：

```bash
npm run agent:once
```

确认 Token Monitor 中出现第二台设备，并且 OpenCode 或 Hermes 已有用量。然后启动持续运行的 agent：

```bash
npm run agent
```

如需无人值守运行，请通过你平时使用的 WSL 服务管理器或登录启动项执行该命令，并把工作目录设为 Token Monitor checkout，确保 `.env` 会被加载。

## 排查

- **没有出现第二台设备**：检查 Hub URL、共享密钥，以及 Windows 防火墙是否允许访问 hub 端口。
- **请求被代理拦截**：把 Windows 主机 IP 加入 `NO_PROXY` 与 `no_proxy`，或为 agent 进程取消代理环境变量。
- **总量重复**：缩小 `TOKEN_MONITOR_CLIENTS` 的范围；如果 agent 负责全部 WSL 工具，则关闭 Windows widget 的内建 WSL 扫描。
- **WSL 检测仍显示无数据**：Windows 侧的状态只描述它自己的 `\\wsl$` 扫描。WSL agent 会作为另一台同步设备出现，并作为这些 SQLite 工具的权威来源。
