# API

The hub exposes a small JSON HTTP API.

## Authentication

All endpoints except `/api/health` require the configured shared secret.

Use either:

```http
Authorization: Bearer <secret>
```

or:

```http
X-Token-Monitor-Secret: <secret>
```

## `GET /api/health`

Health check. Does not require authentication.

Example response:

```json
{
  "ok": true,
  "role": "hub",
  "version": 1,
  "deviceCount": 2,
  "secretRequired": true,
  "now": "2026-05-18T00:00:00.000Z"
}
```

## `POST /api/ingest`

Posts one device usage summary.

Example payload:

```json
{
  "deviceId": "macbook",
  "hostname": "macbook.local",
  "platform": "darwin-arm64",
  "updatedAt": "2026-05-18T00:00:00.000Z",
  "agentVersion": "0.3.0",
  "agentRuntime": "headless-agent",
  "syncUploadIntervalMs": 1200000,
  "projectsEnabled": true,
  "trackedClients": ["codex"],
  "today": {
    "totalTokens": 1234,
    "costUsd": 0.01,
    "cacheReadTokens": 1100,
    "cacheWriteTokens": 0,
    "outputTokens": 34,
    "clients": {
      "codex": 1234
    },
    "clientCosts": {
      "codex": 0.01
    },
    "clientCacheReads": {
      "codex": 1100
    },
    "clientCacheWrites": {
      "codex": 0
    },
    "clientOutputs": {
      "codex": 34
    },
    "models": {
      "gpt-5": 1234
    },
    "modelCosts": {
      "gpt-5": 0.01
    },
    "modelCacheReads": {
      "gpt-5": 1100
    },
    "modelCacheWrites": {
      "gpt-5": 0
    },
    "modelOutputs": {
      "gpt-5": 34
    },
    "clientModels": {
      "codex": {
        "gpt-5": 1234
      }
    },
    "clientModelCosts": {
      "codex": {
        "gpt-5": 0.01
      }
    },
    "sessions": {
      "codex:rollout-2026-05-30T11-44-50-abc": {
        "client": "codex",
        "sessionId": "rollout-2026-05-30T11-44-50-abc",
        "totalTokens": 1234,
        "costUsd": 0.01,
        "messageCount": 3,
        "inputTokens": 100,
        "outputTokens": 34,
        "cacheReadTokens": 1100,
        "cacheWriteTokens": 0,
        "reasoningTokens": 0,
        "startedAt": "2026-05-30T03:44:50.000Z",
        "lastUsedAt": "2026-05-30T04:07:32.679Z",
        "projectId": "sha256:opaque-project-identifier",
        "projectLabel": "token-monitor",
        "models": {
          "gpt-5": 1234
        },
        "modelCosts": {
          "gpt-5": 0.01
        },
        "providers": {
          "openai": 1234
        }
      }
    }
  },
  "month": {
    "totalTokens": 4567,
    "costUsd": 0.04,
    "clients": {},
    "clientCosts": {}
  },
  "allTime": {
    "totalTokens": 8901,
    "costUsd": 0.08,
    "clients": {},
    "clientCosts": {},
    "projects": {
      "token monitor": {
        "label": "Token Monitor",
        "tokens": 8901,
        "costUsd": 0.08,
        "clients": { "codex": 8901 }
      }
    }
  },
  "periodWindows": {
    "today": { "key": "2026-05-18", "endsAt": "2026-05-19T00:00:00.000Z" },
    "month": { "key": "2026-05", "endsAt": "2026-06-01T00:00:00.000Z" }
  },
  "limits": {
    "updatedAt": "2026-05-18T00:00:00.000Z",
    "refreshMs": 300000,
    "providers": [
      {
        "provider": "claude",
        "accountKey": "sha256:...",
        "status": "ok",
        "updatedAt": "2026-05-18T00:00:00.000Z",
        "windows": [
          {
            "kind": "session",
            "usedPercent": 42,
            "remainingPercent": 58,
            "resetsAt": "2026-05-18T05:00:00.000Z"
          },
          {
            "kind": "weekly",
            "usedPercent": 20,
            "remainingPercent": 80,
            "resetsAt": "2026-05-25T00:00:00.000Z"
          }
        ]
      }
    ]
  }
}
```

The hub normalizes records before storing them. The Node hub accepts JSON ingest bodies up to 1 MiB; larger bodies return `413 payload_too_large`.

`projects` is a bounded rollup keyed by a canonicalized workspace-folder label. Each entry carries the deterministic display `label`, token/cost totals, and a per-client token breakdown. Agents upload `allTime.projects` because synchronized payloads intentionally omit the unbounded `allTime.sessions`; `today.projects` and `month.projects` are omitted on upload and rebuilt by the hub from their synchronized sessions. If adding the all-time rollup would exceed the safe ingest budget, the agent drops only that rollup, sets `allTimeProjectsOmitted: true`, and keeps core totals and session data uploadable. A normal later upload clears the diagnostic; limits-only updates preserve it. `projectsEnabled: false` tells the hub that project metadata collection is disabled for this device; sync payloads then remove project rollups plus session `projectId` / `projectLabel` fields.

Authenticated stats expose `projectsIncomplete: true` when a device omitted its rollup, disabled project tracking while contributing usage, or could not preserve exact all-time attribution after its tracked-client list changed. Affected device entries expose `allTimeProjectsOmitted`, `allTimeProjectsIncomplete`, or `projectsEnabled: false` as the reason. The public Worker stats endpoint removes the entire `projects` map, including both display labels and canonical keys.

`trackedClients` is optional but recommended for agents and widgets. When it is present, the hub treats omitted clients as intentionally not collected in this payload and preserves their previous usage for that device. This keeps "tracking" as "collect future data" rather than "hide existing history".

`syncUploadIntervalMs` is optional. A remote-hub widget includes `0` for live uploads or the selected fixed interval in milliseconds (`600000`, `1200000`, or `1800000`). The hub uses a positive interval to keep the device and its limits fresh for at least twice the upload interval; omitted or `0` values retain the configured `staleAfterMs` behavior. Local collection and embedded-host ingest remain live.

`periodWindows` is optional. Agents and widgets stamp each snapshot with the UTC instant its `today`/`month` windows end, computed in the device's own local time (`endsAt` = next local midnight / next local month start; `key` is the device-local day/month for reference). The hub uses it to expire a device's `today`/`month` from the aggregate once `now >= endsAt`, so a device that goes offline before re-posting does not keep contributing a stale day/month snapshot (`allTime` never expires). Payloads without `periodWindows` fall back to a UTC day/month comparison against `updatedAt`.

`limits` is optional. Agents and widgets include it when AI Tool Limits detection is enabled. Raw OAuth credentials, access tokens, refresh tokens, and provider response bodies must never be sent.

`limits.providers[].provider` is one of `claude`, `codex`, `cursor`, `antigravity`, `opencode`, `deepseek`, `minimax`, `mimo`, `grok`, `copilot`, `kiro`, `zai`, `zaiteam`, `volcengine`, `qoder`, `kimi`, or `ollama`.
`limits.providers[].accountKey` is a stable hashed account identifier (`sha256:…`) used to dedupe the same account across devices. `limits.providers[].accountEmail` and `limits.providers[].accountLabel` (plan, e.g. `Plus`) MAY be sent to the authenticated hub so devices can show which account each limit belongs to — this is why Codex can report multiple accounts. The hub ingest is protected by the shared `secret`; the **public** stats endpoints (`publicLimits`) strip `accountKey`, `accountEmail`, and `accountLabel` so no account identifiers are ever exposed publicly.
`limits.providers[].source` is one of `oauth`, `cli`, `web`, `rpc`, `local`, or `api`; `local` means the value was read from an on-disk store such as OpenCode Go usage from `opencode.db`, `web` means a browser/session cookie backed web endpoint (Cursor, OpenCode web accounts, Qoder, MiMo, Ollama), and `api` means a provider HTTP API authenticated by an API key or AK/SK credentials (DeepSeek, Minimax, Copilot, GLM/Z.ai, Volcengine, Kimi Code).
`limits.providers[].balanceUsd` is an optional prepaid credit balance in USD (OpenCode Zen); `null` when the provider has no balance concept or none could be read. A genuine `0` (no remaining credit) is distinct from `null`.
`limits.providers[].balance` is an optional native-currency prepaid balance block. DeepSeek uses `{ amount, currency, todaySpend, monthSpend, monthSinceTracking }`: `amount` is the spendable balance in the account's own currency (e.g. `CNY`/`USD`); `todaySpend`/`monthSpend` are derived from balance history (paid drawdown only); `monthSinceTracking` is `true` until a full month of history has accrued. MiMo may additionally send `giftBalance`, `cashBalance`, Token Plan usage fields, and `planStatus` (`active`, `expired`, `none`, or `null`). An expired MiMo Token Plan has no quota window even when its prepaid balance remains available. `null` when not applicable. DeepSeek uses `source: "api"` with an empty `windows` array (it has no rate-limit windows). GLM/Z.ai, Volcengine, Qoder, Kimi Code, and Ollama report quota/credit windows through the same `windows` array.
`windows[].kind` is `session`, `weekly`, or `billing`.

## `GET /api/stats`

Returns aggregate stats for the widget.

Response includes:

- `staleAfterMs`, the effective Hub threshold used to recompute device and provider freshness
- `periods.today`
- `periods.month`
- `periods.allTime`
- `periods.*.clientModels` and `periods.*.clientModelCosts` for preserving model breakdowns when a tracked tool is disabled
- `periods.*.projects` for workspace-level tokens, cost, and client attribution; the same canonical folder label aggregates across devices
- `periods.today.sessions` / `periods.month.sessions` keyed by `client:sessionId` for session-level usage when tokscale exposes session groups; widgets may use `lastUsedAt` for recent-first sorting and optional `projectId` / `projectLabel` for workspace-level aggregation. Absolute workspace paths stay on the collecting device and are never part of the wire shape. Synchronized clients omit the unbounded `allTime.sessions` collection while preserving all aggregate totals and breakdowns.
- `projectsIncomplete` plus the corresponding `devices[].allTimeProjectsOmitted`, `devices[].allTimeProjectsIncomplete`, or `devices[].projectsEnabled` diagnostic
- `historyPreview.daily[].activeTimeMs`, `historyPreview.monthly[].activeTimeMs`, and `historyPreview.summary.activeTimeMs` when tokscale graph exposes session active-time metrics
- `limits.providers` aggregated by provider account
- `devices`, including each device's normalized `periods`, `limits`, `receivedAt`, optional `syncUploadIntervalMs`, and optional `periodWindows`
- stale status for devices that have not reported recently

If multiple devices report the same provider account, the hub keeps the freshest valid limits status for that account. Public Worker stats omit account identifiers.

## `GET /api/devices`

Returns normalized records for all stored devices.

## `DELETE /api/devices/:id`

Deletes one device record from the hub store.

This is useful after renaming a device id.
