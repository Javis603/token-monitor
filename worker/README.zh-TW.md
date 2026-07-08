<p align="right">
   <a href="./README.md">EN</a> | <a href="./README.zh-CN.md">简</a> | <strong>繁</strong>
</p>

# Token Monitor Hub — Cloudflare Worker

> 屬於 **[Token Monitor](https://github.com/Javis603/token-monitor)** 專案。這個目錄只是 Cloudflare Worker hub；桌面小工具、無頭 agent 和完整文件都在主倉庫。一鍵部署會建立一份獨立副本，不會自動更新，所以請回主倉庫查看新版本。

自架 Node hub 的即插即用替代品，以 Cloudflare Worker 部署，用 Durable Object 保存裝置狀態。它講的是同一套 HTTP 協定（`/api/ingest`、`/api/stats`、`/api/stats/stream`），所以小工具和 agent 無需改動即可使用，只是 Hub URL 不同。

相比 Node hub，用它的理由：

- 不需要一直開機的機器，Cloudflare 幫你跑。
- 預設公開 HTTPS。跨網路可達，也能被 iOS 小工具（Widgy、Scriptable）存取。
- 免費額度輕鬆涵蓋小團隊的用量。

## 前置條件

- Cloudflare 帳號（免費）。
- Node.js 22+（Wrangler v4 要求 `>=22.0.0`）。

## 部署

Deploy Button 提醒：如果一鍵部署後的 Worker 只回傳純文字 `Hello world`，
代表踩中了 Cloudflare 的已知間歇性匯入故障，產生的倉庫沒有 Worker 原始碼。
可以改用下面的手動部署，或把 Workers Builds 重新連到包含完整 `worker/` 目錄的倉庫。

```bash
cd worker
npm install
npx wrangler login          # one-time browser auth
npx wrangler secret put TOKEN_MONITOR_SECRET   # paste a long random string
npx wrangler deploy
```

Wrangler 會印出部署後的 URL，例如：

```
https://token-monitor-hub.<your-subdomain>.workers.dev
```

把每個 agent 和小工具都指向這個 URL。

## 本機開發

```bash
npm run dev   # wrangler dev — local Worker with a real Durable Object
```

各端點與正式環境行為一致。如有需要，用 `wrangler secret put TOKEN_MONITOR_SECRET --env dev` 設定一個獨立的開發密鑰。

## 設定小工具

設定 → Multi-device Sync：

- Hub URL：`https://token-monitor-hub.<your-subdomain>.workers.dev`
- Secret：你用 `wrangler secret put` 設定的值

儲存。SSE 串流連上後，狀態標籤會從 `Local` 切換為 `Live`。

## 設定 agent

可以透過專案根目錄的 `.env`（從 `.env.example` 複製）：

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev
TOKEN_MONITOR_SECRET=<the same secret>
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to hostname
```

或在啟動時內聯匯出：

```bash
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev \
TOKEN_MONITOR_SECRET=<the same secret> \
npm run agent
```

## 透過 Widgy 或 Scriptable 在 iPhone 上使用

Worker 以開放 CORS 的純 JSON 暴露 `GET /api/stats`，所以 iOS 小工具執行環境可以直接呼叫。當 `PUBLIC_STATS_ENABLED=1` 時，它也能暴露無需驗證的 `GET /api/public/stats` 供公開儀表板使用；該回應會省略每裝置記錄和帳號識別。

開啟公開端點：

```bash
npx wrangler secret put PUBLIC_STATS_ENABLED   # enter 1
```

不設定則保持 `/api/public/stats` 關閉。

### Widgy

選 **async / no main()** 範本。使用 `?secret=` 查詢字串驗證：Widgy 那個隱藏的 WKWebView 可能會卡在 `Authorization: Bearer` 觸發的 CORS 預檢上，而 URL 會留在裝置本機的 Widgy 設定裡，所以密鑰不會進入外部日誌。

最簡版本，只要一個數字：

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

改最後那行 `sendToWidgy(...)` 即可選擇任意欄位：

| 想顯示             | 把內層運算式替換為                                          |
|--------------------|------------------------------------------------------------|
| 今日 tokens        | `Number(s.periods.today.totalTokens).toLocaleString('en-US')`     |
| 今日成本           | `'$' + s.periods.today.costUsd.toFixed(2)`                 |
| 本月 tokens        | `Number(s.periods.month.totalTokens).toLocaleString('en-US')`     |
| 本月成本           | `'$' + s.periods.month.costUsd.toFixed(2)`                 |
| 累計 tokens        | `Number(s.periods.allTime.totalTokens).toLocaleString('en-US')`   |
| 累計成本           | `'$' + s.periods.allTime.costUsd.toFixed(2)`               |

帶設定區塊、並對 token 做精簡 `K / M / B` 格式化的組合版本，適合窄小工具版面：

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

每個 Widgy 文字元素各用一個腳本：複製它並修改 `PERIOD` / `SHOW` 來驅動不同欄位。

### Scriptable

```js
const req = new Request('https://token-monitor-hub.<your-subdomain>.workers.dev/api/stats');
req.headers = { authorization: 'Bearer <the same secret>' };
const stats = await req.loadJSON();
const todayTokens = stats.periods.today.totalTokens;
```

iOS 小工具沒有省電的推送通道，所以執行環境會自行每隔幾分鐘重新拉取。

## Stats 回應結構

`GET /api/stats` 回傳聚合快照。挑你小工具需要的欄位即可：

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

如果想做每裝置的小工具，每個裝置也在 `devices[i].periods[period]` 下帶有自己的每週期數值。當某裝置的 `receivedAt` 早於 `STALE_AFTER_MS`（預設 10 分鐘）時會被標記為 `stale: true`，想顯示「離線」狀態時很有用。

`limits.providers` 依 provider 帳號聚合。帶驗證的 stats 端點包含用於去重的帳號雜湊。開啟後，`/api/public/stats` 會剝除這些雜湊、標籤、來源裝置 id，以及完整的 `devices` 清單。

## 端點

| 方法   | 路徑                       | 驗證   | 說明                                       |
|--------|----------------------------|--------|--------------------------------------------|
| GET    | `/api/health`              | 無     | 存活探針 + 裝置數                          |
| GET    | `/api/public/stats`        | 無     | `PUBLIC_STATS_ENABLED=1` 時提供不含 devices/帳號 id 的公開聚合統計 |
| GET    | `/api/stats`               | 密鑰   | 聚合統計（today / month / allTime）        |
| GET    | `/api/stats/stream`        | 密鑰   | SSE 串流，每次 ingest 都推送               |
| GET    | `/api/devices`             | 密鑰   | 原始的每裝置記錄                          |
| POST   | `/api/ingest`              | 密鑰   | 更新某個裝置的用量摘要                    |
| DELETE | `/api/devices/{deviceId}`  | 密鑰   | 刪除一筆裝置記錄                          |

密鑰有三種接受方式（任一即可）：

1. `Authorization: Bearer <secret>`：agent、小工具，以及任何伺服器 / 桌面客戶端首選。
2. `x-token-monitor-secret: <secret>`：無法設定 `Authorization` 的客戶端的後備方案。
3. `?secret=<secret>` 查詢字串：針對 iOS 小工具執行環境（Widgy、Scriptable）的變通方案，它們的 WKWebView 難以處理 `Authorization` 標頭的 CORS 預檢。只在 URL 留在裝置本機的客戶端上使用。

密鑰是必需的。當 `TOKEN_MONITOR_SECRET` 未設定時，所有資料路由都回傳 `503 secret_required`，只有 `/api/health` 和可選開啟的 `/api/public/stats` 會回應。請在部署前（或部署時）設定它。

## 儲存與成本

裝置記錄存放在 Durable Object 的 SQLite 儲存裡，以 `dev:<deviceId>` 為鍵。每次 ingest 寫一列；讀取時在記憶體中聚合所有列。對於小團隊（≤ 10 台裝置，每台每分鐘一次 ingest），這遠在免費方案限額之內：

- Worker 請求：≤ 15k/天，免費額度為 100k/天
- DO SQL 讀/寫：≤ 30k/天，免費額度為數百萬
- DO 儲存：總共幾 KB

## Tail 日誌

```bash
npm run tail
```

即時串流輸出 Worker + Durable Object 日誌。
