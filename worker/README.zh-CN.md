<p align="right">
   <a href="./README.md">EN</a> | <strong>简</strong> | <a href="./README.zh-TW.md">繁</a>
</p>

# Token Monitor Hub — Cloudflare Worker

> 属于 **[Token Monitor](https://github.com/Javis603/token-monitor)** 项目。这个目录只是 Cloudflare Worker hub；桌面小部件、无头 agent 和完整文档都在主仓库。一键部署会创建一份独立副本，不会自动更新，所以请回主仓库查看新版本。

自托管 Node hub 的即插即用替代品，以 Cloudflare Worker 部署，用 Durable Object 保存设备状态。它讲的是同一套 HTTP 协议（`/api/ingest`、`/api/stats`、`/api/stats/stream`），所以小部件和 agent 无需改动即可使用，只是 Hub URL 不同。

相比 Node hub，用它的理由：

- 不需要一直开机的机器，Cloudflare 帮你跑。
- 默认公开 HTTPS。跨网络可达，也能被 iOS 小部件（Widgy、Scriptable）访问。
- 免费额度轻松覆盖小团队的用量。

## 前置条件

- Cloudflare 账号（免费）。
- Node.js 22+（Wrangler v4 要求 `>=22.0.0`）。

## 部署

Deploy Button 提醒：如果一键部署后的 Worker 只返回纯文本 `Hello world`，
说明踩中了 Cloudflare 的已知间歇性导入故障，生成的仓库没有 Worker 源码。
可以改用下面的手动部署，或把 Workers Builds 重新连到包含完整 `worker/` 目录的仓库。

```bash
cd worker
npm install
npx wrangler login          # one-time browser auth
npx wrangler secret put TOKEN_MONITOR_SECRET   # paste a long random string
npx wrangler deploy
```

Wrangler 会打印部署后的 URL，例如：

```
https://token-monitor-hub.<your-subdomain>.workers.dev
```

把每个 agent 和小部件都指向这个 URL。

## 本地开发

```bash
npm run dev   # wrangler dev — local Worker with a real Durable Object
```

各端点与生产环境行为一致。如有需要，用 `wrangler secret put TOKEN_MONITOR_SECRET --env dev` 设置一个独立的开发密钥。

## 配置小部件

设置 → Multi-device Sync：

- Hub URL：`https://token-monitor-hub.<your-subdomain>.workers.dev`
- Secret：你用 `wrangler secret put` 设置的值

保存。SSE 流连上后，状态标签会从 `Local` 切换为 `Live`。

## 配置 agent

可以通过项目根目录的 `.env`（从 `.env.example` 复制）：

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev
TOKEN_MONITOR_SECRET=<the same secret>
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to hostname
```

或在启动时内联导出：

```bash
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev \
TOKEN_MONITOR_SECRET=<the same secret> \
npm run agent
```

## 通过 Widgy 或 Scriptable 在 iPhone 上使用

Worker 以开放 CORS 的纯 JSON 暴露 `GET /api/stats`，所以 iOS 小部件运行时可以直接调用。当 `PUBLIC_STATS_ENABLED=1` 时，它也能暴露无需鉴权的 `GET /api/public/stats` 供公开看板使用；该响应会省略每设备记录和账号标识。

开启公开端点：

```bash
npx wrangler secret put PUBLIC_STATS_ENABLED   # enter 1
```

不设置则保持 `/api/public/stats` 关闭。

### Widgy

选 **async / no main()** 模板。使用 `?secret=` 查询字符串鉴权：Widgy 那个隐藏的 WKWebView 可能会卡在 `Authorization: Bearer` 触发的 CORS 预检上，而 URL 会留在设备本地的 Widgy 配置里，所以密钥不会进入外部日志。

最简版本，只要一个数字：

```js
const HUB = 'https://token-monitor-hub.<your-subdomain>.workers.dev';
const SECRET = '<the same secret>';
const url = HUB + '/api/stats?secret=' + SECRET;
fetch(url)
  .then(r => r.json())
  .then(s => sendToWidgy(
    Number(s.periods.today.totalTokens).toLocaleString('en-US')
  ))
  .catch(e => sendToWidgy('err:' + e.message));
```

改最后那行 `sendToWidgy(...)` 即可选择任意字段：

| 想显示             | 把内层表达式替换为                                          |
|--------------------|------------------------------------------------------------|
| 今日 tokens        | `Number(s.periods.today.totalTokens).toLocaleString('en-US')`     |
| 今日成本           | `'$' + s.periods.today.costUsd.toFixed(2)`                 |
| 本月 tokens        | `Number(s.periods.month.totalTokens).toLocaleString('en-US')`     |
| 本月成本           | `'$' + s.periods.month.costUsd.toFixed(2)`                 |
| 累计 tokens        | `Number(s.periods.allTime.totalTokens).toLocaleString('en-US')`   |
| 累计成本           | `'$' + s.periods.allTime.costUsd.toFixed(2)`               |

带配置块、并对 token 做紧凑 `K / M / B` 格式化的组合版本，适合窄小部件布局：

```js
const HUB = 'https://token-monitor-hub.<your-subdomain>.workers.dev';
const SECRET = '<the same secret>';
const PERIOD = 'today';        // 'today' | 'month' | 'allTime'
const SHOW = 'tokens+cost';    // 'tokens' | 'cost' | 'tokens+cost'

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(n) {
  return '$' + (n >= 10 ? n.toFixed(2) : n.toFixed(4));
}

fetch(HUB + '/api/stats?secret=' + SECRET)
  .then(r => r.json())
  .then(stats => {
    const p = stats.periods[PERIOD] || { totalTokens: 0, costUsd: 0 };
    const t = fmtTokens(p.totalTokens || 0);
    const c = fmtCost(p.costUsd || 0);
    if (SHOW === 'tokens') sendToWidgy(t);
    else if (SHOW === 'cost') sendToWidgy(c);
    else sendToWidgy(t + ' · ' + c);
  })
  .catch(e => sendToWidgy('err:' + e.message));
```

每个 Widgy 文本元素各用一个脚本：复制它并修改 `PERIOD` / `SHOW` 来驱动不同字段。

### Scriptable

```js
const req = new Request('https://token-monitor-hub.<your-subdomain>.workers.dev/api/stats');
req.headers = { authorization: 'Bearer <the same secret>' };
const stats = await req.loadJSON();
const todayTokens = stats.periods.today.totalTokens;
```

iOS 小部件没有省电的推送通道，所以运行时会自行每隔几分钟重新拉取。

## Stats 响应结构

`GET /api/stats` 返回聚合快照。挑你小部件需要的字段即可：

```jsonc
{
  "updatedAt": "2026-05-18T18:02:19.459Z",
  "periods": {
    "today":   { /* see PeriodSummary below */ },
    "month":   { /* ... */ },
    "allTime": { /* ... */ }
  },
  "limits": {
    "updatedAt": "2026-05-18T18:02:19.459Z",
    "providers": [
      {
        "provider": "claude",
        "accountKey": "sha256:...",
        "sourceDeviceId": "macbook",
        "stale": false,
        "status": "ok",
        "windows": [
          { "kind": "session", "usedPercent": 42, "remainingPercent": 58, "resetsAt": "2026-05-18T21:00:00.000Z" },
          { "kind": "weekly", "usedPercent": 20, "remainingPercent": 80, "resetsAt": "2026-05-25T00:00:00.000Z" }
        ]
      }
    ]
  },
  "devices": [
    {
      "deviceId":   "macbook",
      "hostname":   "macbook.local",
      "platform":   "darwin-arm64",
      "updatedAt":  "2026-05-18T18:01:50.000Z",
      "receivedAt": "2026-05-18T18:01:51.012Z",
      "ageMs":      28447,
      "stale":      false,
      "periods":    { "today": {...}, "month": {...}, "allTime": {...} }
    }
  ]
}
```

`PeriodSummary`：

```jsonc
{
  "totalTokens":  1234567,        // sum across all devices for this period
  "costUsd":      12.345678,
  "clients":      { "claude": 800000, "codex": 400000, "hermes": 34567 },
  "clientCosts":  { "claude": 8.12,   "codex": 4.10,   "hermes": 0.12  },
  "models":       { "claude-opus-4-7": 600000, "gpt-5-thinking-medium": 400000, ... },
  "modelCosts":   { "claude-opus-4-7": 7.50,   "gpt-5-thinking-medium": 4.00,   ... }
}
```

如果想做每设备的小部件，每个设备也在 `devices[i].periods[period]` 下带有自己的每周期数值。当某设备的 `receivedAt` 早于 `STALE_AFTER_MS`（默认 10 分钟）时会被标记为 `stale: true`，想显示「离线」状态时很有用。

`limits.providers` 按 provider 账号聚合。带鉴权的 stats 端点包含用于去重的账号哈希。开启后，`/api/public/stats` 会剥离这些哈希、标签、来源设备 id，以及完整的 `devices` 列表。

## 端点

| 方法   | 路径                       | 鉴权   | 说明                                       |
|--------|----------------------------|--------|--------------------------------------------|
| GET    | `/api/health`              | 无     | 存活探针 + 设备数                          |
| GET    | `/api/public/stats`        | 无     | `PUBLIC_STATS_ENABLED=1` 时提供不含 devices/账号 id 的公开聚合统计 |
| GET    | `/api/stats`               | 密钥   | 聚合统计（today / month / allTime）        |
| GET    | `/api/stats/stream`        | 密钥   | SSE 流，每次 ingest 都推送                 |
| GET    | `/api/devices`             | 密钥   | 原始的每设备记录                          |
| POST   | `/api/ingest`              | 密钥   | 更新某个设备的用量摘要                    |
| DELETE | `/api/devices/{deviceId}`  | 密钥   | 删除一条设备记录                          |

密钥有三种接受方式（任一即可）：

1. `Authorization: Bearer <secret>`：agent、小部件，以及任何服务器 / 桌面客户端首选。
2. `x-token-monitor-secret: <secret>`：无法设置 `Authorization` 的客户端的后备方案。
3. `?secret=<secret>` 查询字符串：针对 iOS 小部件运行时（Widgy、Scriptable）的变通方案，它们的 WKWebView 难以处理 `Authorization` 头的 CORS 预检。只在 URL 留在设备本地的客户端上使用。

密钥是必需的。当 `TOKEN_MONITOR_SECRET` 未设置时，所有数据路由都返回 `503 secret_required`，只有 `/api/health` 和可选开启的 `/api/public/stats` 会响应。请在部署前（或部署时）设置它。

## 存储与成本

设备记录存放在 Durable Object 的 SQLite 存储里，以 `dev:<deviceId>` 为键。每次 ingest 写一行；读取时在内存中聚合所有行。对于小团队（≤ 10 台设备，每台每分钟一次 ingest），这远在免费计划限额之内：

- Worker 请求：≤ 15k/天，免费额度为 100k/天
- DO SQL 读/写：≤ 30k/天，免费额度为数百万
- DO 存储：总共几 KB

## Tail 日志

```bash
npm run tail
```

实时流式输出 Worker + Durable Object 日志。
