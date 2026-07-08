<p align="right">
   <strong>EN</strong> | <a href="./README.zh-CN.md">简</a> | <a href="./README.zh-TW.md">繁</a>
</p>

# Token Monitor Hub — Cloudflare Worker

> Part of **[Token Monitor](https://github.com/Javis603/token-monitor)**. This directory is just the Cloudflare Worker hub; the desktop widget, headless agent, and full docs live in the main repo. A one-click deploy creates a standalone copy that won't auto-update, so check the main repo for new versions.

Drop-in replacement for the self-hosted Node hub, deployed as a Cloudflare
Worker with a Durable Object holding device state. Speaks the same HTTP
protocol (`/api/ingest`, `/api/stats`, `/api/stats/stream`), so the widget and
agent work unchanged — only the Hub URL differs.

Why use this instead of the Node hub:

- No always-on machine. Cloudflare runs it.
- Public HTTPS by default. Reachable across networks and from iOS widgets
  (Widgy, Scriptable).
- Free tier covers small-team usage easily.

## Prerequisites

- Cloudflare account (free).
- Node.js 22+ (Wrangler v4 requires `>=22.0.0`).

## Deploy

Deploy Button note: if a one-click deploy leaves the Worker responding with
plain `Hello world`, Cloudflare hit a known intermittent import failure and
created a repo without the Worker source. Use the manual deploy steps below, or
reconnect Workers Builds to a repo that contains the full `worker/` directory.

```bash
cd worker
npm install
npx wrangler login          # one-time browser auth
npx wrangler secret put TOKEN_MONITOR_SECRET   # paste a long random string
npx wrangler deploy
```

Wrangler prints the deployed URL, for example:

```
https://token-monitor-hub.<your-subdomain>.workers.dev
```

Point each agent and widget at that URL.

## Local development

```bash
npm run dev   # wrangler dev — local Worker with a real Durable Object
```

Endpoints work the same as in production. Use a separate dev secret with
`wrangler secret put TOKEN_MONITOR_SECRET --env dev` if needed.

## Configure the widget

Settings → Multi-device Sync:

- Hub URL: `https://token-monitor-hub.<your-subdomain>.workers.dev`
- Secret: the value you set with `wrangler secret put`

Save. The status pill should switch from `Local` to `Live` once the SSE stream
connects.

## Configure the agent

Either via `.env` at the project root (copy from `.env.example`):

```env
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev
TOKEN_MONITOR_SECRET=<the same secret>
TOKEN_MONITOR_DEVICE_ID=             # optional — defaults to hostname
```

Or by exporting them inline when launching:

```bash
TOKEN_MONITOR_HUB_URL=https://token-monitor-hub.<your-subdomain>.workers.dev \
TOKEN_MONITOR_SECRET=<the same secret> \
npm run agent
```

## iPhone via Widgy or Scriptable

The Worker exposes `GET /api/stats` as plain JSON with CORS open, so iOS
widget runtimes can call it directly. It can also expose `GET /api/public/stats`
without auth for public dashboards when `PUBLIC_STATS_ENABLED=1`; that response
omits per-device records and account identifiers.

To enable the public endpoint:

```bash
npx wrangler secret put PUBLIC_STATS_ENABLED   # enter 1
```

Leave it unset to keep `/api/public/stats` disabled.

### Widgy

Pick the **async / no main()** template. Use the `?secret=` query-string
auth — Widgy's invisible WKWebView can trip over the CORS preflight that
`Authorization: Bearer` triggers, and the URL stays on-device in the Widgy
config, so the secret never hits an external log.

Minimum version — just one number:

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

Pick any field by changing the final `sendToWidgy(...)` line:

| Want to show       | Replace the inner expression with                          |
|--------------------|------------------------------------------------------------|
| today tokens       | `Number(s.periods.today.totalTokens).toLocaleString('en-US')`     |
| today cost         | `'$' + s.periods.today.costUsd.toFixed(2)`                 |
| month tokens       | `Number(s.periods.month.totalTokens).toLocaleString('en-US')`     |
| month cost         | `'$' + s.periods.month.costUsd.toFixed(2)`                 |
| all-time tokens    | `Number(s.periods.allTime.totalTokens).toLocaleString('en-US')`   |
| all-time cost      | `'$' + s.periods.allTime.costUsd.toFixed(2)`               |

Combined version with a config block and compact `K / M / B` token
formatting for tight widget layouts:

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

Each Widgy text element gets its own script — duplicate it and change
`PERIOD` / `SHOW` to drive different fields.

### Scriptable

```js
const req = new Request('https://token-monitor-hub.<your-subdomain>.workers.dev/api/stats');
req.headers = { authorization: 'Bearer <the same secret>' };
const stats = await req.loadJSON();
const todayTokens = stats.periods.today.totalTokens;
```

There is no battery-friendly push channel for iOS widgets, so the runtime
re-fetches every few minutes on its own.

## Stats response shape

`GET /api/stats` returns the aggregated snapshot. Pick whatever fields you
need for your widget:

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

`PeriodSummary`:

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

Each device also carries its own per-period numbers under
`devices[i].periods[period]` if you want per-device widgets. A device is
marked `stale: true` once its `receivedAt` is older than `STALE_AFTER_MS`
(default 10 min) — handy if you want to show an "offline" state.

`limits.providers` is aggregated by provider account. The authenticated stats
endpoint includes account hashes for de-duplication. When enabled,
`/api/public/stats` strips those hashes, labels, source device ids, and the full
`devices` list.

## Endpoints

| Method | Path                       | Auth   | Description                                |
|--------|----------------------------|--------|--------------------------------------------|
| GET    | `/api/health`              | none   | Liveness probe + device count              |
| GET    | `/api/public/stats`        | none   | Public aggregate stats without devices/account ids when `PUBLIC_STATS_ENABLED=1` |
| GET    | `/api/stats`               | secret | Aggregated stats (today / month / allTime) |
| GET    | `/api/stats/stream`        | secret | SSE stream, push on every ingest           |
| GET    | `/api/devices`             | secret | Raw per-device records                     |
| POST   | `/api/ingest`              | secret | Upsert a device's usage summary            |
| DELETE | `/api/devices/{deviceId}`  | secret | Remove a device record                     |

The secret is accepted three ways (any one works):

1. `Authorization: Bearer <secret>` — preferred for agents, widget, and any
   server / desktop client.
2. `x-token-monitor-secret: <secret>` — fallback for clients that cannot set
   `Authorization`.
3. `?secret=<secret>` query string — workaround for iOS widget runtimes
   (Widgy, Scriptable) whose WKWebView struggles with CORS preflight for the
   `Authorization` header. Only use this from clients where the URL stays
   local to the device.

The secret is required. When `TOKEN_MONITOR_SECRET` is unset, every data route
returns `503 secret_required` — only `/api/health` and the opt-in
`/api/public/stats` respond. Set it before (or during) deploy.

## Storage and cost

Device records live in the Durable Object's SQLite storage, keyed by
`dev:<deviceId>`. Each ingest writes one row; reads aggregate all rows in
memory. For a small team (≤ 10 devices, one ingest per minute per device),
this stays well inside the free plan limits:

- Worker requests: ≤ 15k/day vs free quota of 100k/day
- DO SQL reads/writes: ≤ 30k/day vs free quota of millions
- DO storage: a few KB total

## Tail logs

```bash
npm run tail
```

Streams Worker + Durable Object logs in real time.
