# 局域网网关 + 安卓监控 — 开发进度

最后更新：2026-08-28

## 目标

为 token-monitor 增加三条能力：

1. **局域网网关** — 在同局域网内向设备传递/收集 token 用量
2. **只读视图面** — 网关转发一个不加密、不鉴权的端口，仅查看用量
3. **安卓 App** — 同局域网内监控

并要求最终形态为**开箱即用**（可分发，非开发者自用）。

---

## 已完成

### task1 局域网网关（基础版，已实测）

- `src/gateway/server.js` — 独立进程 `npm run gateway`
  - 数据面 `17321`：secret 必需，复用 `createHub()` 全部路由
  - 视图面 `17322`：仅 `GET/HEAD`，无鉴权，写路由返回 `404`
  - 启动时打印可复制的 LAN 地址；无 secret 拒绝启动
- `src/shared/mdns.js` — `dgram` 手写 mDNS 响应器，**零新增依赖**
  - 服务类型 `_token-monitor._tcp.local`
  - TXT 不含 secret（组播全网可见）
  - 过滤无硬件地址的虚拟网卡（MAC 全零）
  - 启动后自验证 `verifyDelivery()`：能 bind 不代表能收包（Windows 5353 端口被多进程占用）
- `src/shared/publicStats.js` — 脱敏视图构造入口
- `src/shared/usage.js` — 上移 `publicPeriods()` / 新增 `publicDevices()`（AGENTS.md 要求 `src/shared/` 为唯一真源，Worker 改为 import 同步）
- `scripts/lan-doctor.js` — 诊断脚本，区分「连不上」与「连上了没数据」五种状态

### task2 只读视图面（已实测）

- 端点：`GET /api/health`、`GET /api/view/stats`、`GET /api/view/stats/stream`（SSE）
- 脱敏复用 `publicLimits()`，字段剥离见 `docs/lan-gateway.md`
- 实测：数据面 POST/GET/PUT/DELETE 全通；视图面对数据面路由一律 `404`

### task3 安卓 App（基础版，已实测打通）

- `android/` — Kotlin + Compose + Material3
- NsdManager 自动发现、OkHttp SSE、DataStore 记忆
- 实测：手机连同一 Wi-Fi 自动发现网关，显示 PC 设备用量
- 修复：`network_security_config.xml` 解决 Android 17 / ColorOS 明文 HTTP 被拦
- 修复：失败界面显示完整地址 + Switch/Refresh 按钮（之前是空白屏）

### 实测结论

- PC 端 client 模式连数据面 17321：全路由通过，配置零改动
- 手机端 mDNS 发现 + 视图面读取：成功显示 `DESKTOP-C9QGIH6` 用量
- 全量测试 `3768 passed / 3 failed`（3 个为改动前既有的环境相关失败，已用干净 HEAD worktree 对照确认）

---

## 进行中：开箱即用（路线 1 — 网关并入 Electron）

用户要求「可分发、开箱即用」，故从「独立进程 + 手填 IP」升级为「桌面端一键托管 + PC 端自动发现」。

### 子任务 1：Node 侧 mDNS 解析器 ✅ 已完成并验证

- `src/shared/mdns.js` 新增：
  - `parseDnsResponse()` — 解析资源记录（PTR/SRV/TXT/A）
  - `createMdnsBrowser()` — 持续监听发现
  - `discoverServices()` — 一次性发现（适合设置页）
  - `decodeTxt/decodeSrv/decodeARecord` — RDATA 解码
- 修复的 bug：
  1. **A 记录命名**：responder 原把 A 记录 key 成 instance 名，标准为 SRV target → 改为 `service.target`
  2. **SRV/TXT 记录缺 service-type 后缀**：原用裸 `instanceName`，标准为 FQDN `instance._service._tcp.local` → 新增 `instanceFqdn` 字段，PTR rdata / SRV / TXT 三处统一
- 验证：`discoverServices()` 返回 `{"name":"..._token-monitor._tcp.local","host":"192.168.8.243","port":17321,"txt":{"ver":"1","view":"17322",...},"addresses":["192.168.8.243"]}`

> **待办回归**：responder 协议改动后，需在真机重测 Android NsdManager 发现仍正常（理论上 PTR→FQDN→SRV/TXT 链路仍成立，但未实测）。

### 子任务 2：Electron host 模式接入网关 — ✅ 已完成

- `main.js` 的 `startEmbeddedHub()` 由裸 `createHub` 改为 `createGateway`
  - 数据面照旧（`0.0.0.0`，需 secret），自动生成 secret（沿用原逻辑）
  - 新增 mDNS 广播（`_token-monitor._tcp.local`），TXT 不含 secret；`view` 字段仅在视图面开启时出现
  - `stopEmbeddedHub()` 同步用 `gateway.stop()` 收尾
- 设置项：`hubViewEnabled`（默认 false）、`hubViewPort`（默认 17322）
  - 已接入 `defaultSettings()`、`readSettings()` 归并、`settings:update` 归并、`runtimeConfig` 的 `MODE_STRUCTURAL_KEYS`（改这两个键会触发 `startMode()` 重启网关）
- `getHubInfo()` 扩展返回 `viewPort / viewEnabled / mdnsVerified / mdnsListening`，
  且 `lanAddresses` 优先用网关实际广播的地址（保留 `{address, interface}` 对象形态）
- 渲染器：host 区加「只读视图」开关 + 视图信息区 + mDNS 状态行

### 子任务 3：视图面默认关闭 + 风险确认 — ✅ 已完成

- `createGateway()` 新增 `viewEnabled` 选项：关闭时不创建 view server、不监听 viewPort、
  mDNS TXT 也不再广播 `view`
- 桌面端设置默认 `hubViewEnabled = false`（开箱即用不主动暴露无鉴权端口）
- 渲染器打开开关时用 `window.confirm()` 弹一次风险提示，取消则回退；确认直接保存并重启网关
- CLI 亦支持 `--view 0` 跑纯数据面网关

### 子任务 4：PC 端设置页自动列出 LAN 网关 — ✅ 已完成

- `main.js` 新增 `hub:discoverGateways` IPC，调用 `discoverServices()`（一次性发现，3s 超时）
- `preload.js` 暴露 `discoverGateways`
- 渲染器 client 区加「Scan for gateways」按钮 + 结果列表，点选即自动填
  `http://<addr>:<port>` 并切到 `client` 连接（消除手填 IP 根因）

### 子任务 5：连接失败诊断指引 — ✅ 已落地到文档

- `docs/lan-gateway.md` 新增「Troubleshooting」：`npm run gateway:doctor` 用法、
  Windows 防火墙放行说明（需管理员）、mDNS 不可用时改地址直连

### 子任务 6：文档与验收清单 — ✅ 已创建/更新

- `docs/lan-gateway.md`（新）：端口/运行方式/连接方式/排查/安全/验收清单
- `android/README.md`：补充桌面一键托管 + 视图面需开启的说明

> 待办回归（仍在）：子任务 1 改动 protocol 后需在真机重测 Android NsdManager 发现仍正常。

---

## 已知限制（当前版本）

| 限制 | 影响 | 计划 |
|---|---|---|
| PC 端需手填网关 IP | 每个用户都会踩（本次根因） | ✅ 子任务 4 已解决（扫描点选），但需进入 client 模式手动扫 |
| 网关需手动 `npm run gateway` 启动 | 非开箱即用 | ✅ 子任务 2 已解决（host 模式一键托管） |
| 视图面默认开启且不加密 | 分发有风险 | ✅ 子任务 3 已解决（默认关闭 + 风险确认） |
| IP 变化需手动 Switch | 体验损耗 | 后续 App 自动跟随 |
| 防火墙需用户手动放行 | Windows 入站默认拦 | 子任务 5 已给指引（无法自动化） |
| 视图面关闭时安卓无法查看 | 需在桌面端主动开启只读视图 | 设计取舍：产品默认不暴露无鉴权端口 |

---

## 待用户决策

~~1. **视图面安全策略**：保持不加密 / 默认关闭 + 风险确认（推荐）/ 加 PIN~~ → 已按推荐落地「默认关闭 + 风险确认」

~~2. **网关是否打包进 Electron 安装包**：当前方案是不打包（独立进程），开箱即用靠子任务 2 的 host 模式开关~~ → 维持「不打包」，开箱即用靠 host 模式开关
