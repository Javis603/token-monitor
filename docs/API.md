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
  "runtime": "cloudflare-worker",
  "version": 1,
  "hubBuild": {
    "schemaVersion": 1,
    "runtime": "cloudflare-worker",
    "coreRevision": 1,
    "coreBuildId": "sha256:…",
    "runtimeRevision": 1,
    "runtimeBuildId": "sha256:…"
  },
  "deviceCount": 2,
  "secretRequired": true,
  "now": "2026-05-18T00:00:00.000Z"
}
```

`version` remains the legacy Hub storage/API value and is not a deployment version. `hubBuild` is the content-derived deployment identity used by Token Monitor to compare the remote Hub with the core bundled by the app. `core*` identifies shared Node/Worker aggregation logic; `runtime*` identifies the Node Hub or Cloudflare Worker adapter. Product-only version bumps do not change either build ID. This is a build marker generated from the registered source closure, not a runtime attestation: a fork that changes source without regenerating its metadata may still report the marker it started from. A health response without `hubBuild` is a legacy Hub and remains otherwise compatible; present but malformed metadata is unrecognized instead of being treated as legacy.

## `POST /api/ingest`

Posts one device usage summary.

Example payload:

```json
{
  "deviceId": "macbook",
  "hostname": "macbook.local",
  "platform": "darwin-arm64",
  "osName": "macOS",
  "osVersion": "26.0",
  "updatedAt": "2026-05-18T00:00:00.000Z",
  "agentVersion": "0.3.0",
  "agentRuntime": "headless-agent",
  "syncUploadIntervalMs": 1200000,
  "projectsEnabled": true,
  "historyAvailable": true,
  "trackedClients": ["codex"],
  "today": {
    "capabilities": {
      "tokenComponents": true
    },
    "totalTokens": 1234,
    "costUsd": 0.01,
    "cacheReadTokens": 1100,
    "cacheWriteTokens": 0,
    "outputTokens": 34,
    "timedTokens": 1230,
    "timedOutputTokens": 34,
    "timedDurationMs": 4200,
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
    "timeZone": "Asia/Hong_Kong",
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

`projects` is a bounded rollup keyed by a canonicalized workspace-folder label. Each entry carries the deterministic display `label`, token/cost totals, and a per-client token breakdown. Agents upload `allTime.projects` because synchronized payloads intentionally omit the unbounded `allTime.sessions`; `today.projects` and `month.projects` are normally omitted on upload and rebuilt by the hub from their synchronized sessions. If adding the all-time rollup would exceed the safe ingest budget, the agent drops only that rollup, sets `allTimeProjectsOmitted: true`, and keeps core totals and session data uploadable. If monthly or daily session detail would still exceed the budget, the agent keeps the newest rows that fit, sends the complete project rollup for that period, and sets `sessionDetailsOmitted` to the number of omitted rows per affected period. If that project rollup cannot fit even after all session rows are removed, the agent omits it too and sets `periodProjectsOmitted`; token/cost and client/model totals remain complete while the affected project breakdown is marked incomplete. A normal later upload clears these diagnostics; limits-only updates preserve them. `projectsEnabled: false` tells the hub that project metadata collection is disabled for this device; sync payloads then remove project rollups plus session `projectId` / `projectLabel` fields.

Authenticated stats expose `projectsIncomplete: true` when a device omitted its rollup, disabled project tracking while contributing usage, or could not preserve exact all-time attribution after its tracked-client list changed. Affected device entries expose `allTimeProjectsOmitted`, `allTimeProjectsIncomplete`, or `projectsEnabled: false` as the reason. The public Worker stats endpoint removes the entire `projects` map, including both display labels and canonical keys.

`timedTokens`, `timedOutputTokens` and `timedDurationMs` are optional throughput inputs, summed from tokscale's per-entry `performance` block. `timedDurationMs` is the sum of per-message durations, not a wall-clock span — concurrent sessions contribute their durations separately — and `timedTokens` counts the tokens of the messages that carried a duration. Coverage is only meaningful per tokscale entry and must **not** be reconstructed as `timedTokens / totalTokens` after aggregation: that ratio mixes clients with completely different coverage, and it is not even bounded by 1, because tokscale counts reasoning in its own token total while `totalTokens` deliberately does not.

`timedOutputTokens` is the output of the entries that carried a duration — an entry contributes its output exactly when it contributes its duration, so `timedOutputTokens / timedDurationMs` always divides two totals describing the same entries. The gate is applied per entry rather than rebuilt from period totals: several tracked clients report no durations at all, so anything derived from summed totals lets one client's output ride on another client's clock, and the resulting rate drifts with the client mix rather than with throughput.

tokscale also reports a per-entry `tokenCoverage`, and this deliberately does not scale by it. Doing so would assume output is spread evenly across an entry's tokens; in practice output is ~0.3–3% of an entry's tokens while the untimed remainder measures several times an entry's entire output, so that remainder is cache and input rather than generation, and scaling would discount output that was almost certainly timed. Ignoring it also keeps the field a plain integer counter that merges and deltas like every other token count.

All three are reported as raw sums rather than a pre-divided rate because a ratio cannot be summed: consumers add each field across devices and periods and divide only at the point of display, which makes a fleet-wide rate duration-weighted. Payloads without these fields are accepted and normalize to `0`, which consumers must read as "no throughput data" rather than "zero throughput".

Because the gate is all-or-nothing per entry, `timedOutputTokens ≤ outputTokens` is a physical bound: a period cannot have timed more output than it produced. The two are equal when every entry in the period reported durations. A partly timed entry — 1230 of 1234 tokens in the example above — still contributes all of its output, since the untimed remainder is cache and input rather than generation.

The collector satisfies that bound by construction, but the hub and the Worker normalize records posted by any agent, so normalization **enforces** it: a `timedOutputTokens` larger than the record's own `outputTokens` is capped rather than trusted. Ingest is a trust boundary here, and this value divides straight into a headline rate.

All three are additive over append-only messages, which keeps them exact under the delta path a watch-triggered scan uses to carry a `today` rescan into `month` and `allTime`. The one case where `timedOutputTokens` and a full rescan can disagree is a session that spans the boundary and starts or stops reporting durations partway through, since a rescan then re-gates the whole session on its combined state; the next full scan reconciles it. Closing even that needs a per-message timed-output counter from tokscale.

Each native period may include `capabilities.tokenComponents`. Current producers set it to `true` when cache read/write and output were derived from individual Tokscale rows, and to `false` when any part of the period has only aggregate provenance. Partial periods retain their known components and carry the unsupported remainder in `unclassifiedTokens`, `clientUnclassifiedTokens`, and `modelUnclassifiedTokens`; consumers display that remainder as `Unclassified` instead of silently treating it as cache miss. When an aggregate remainder has no Tool or Model identity, consumers expose a synthetic `Unclassified` attribution row so the visible breakdown still adds up to the period total. Session archives preserve aggregate and Tool components, but a session spanning multiple models leaves its Model components unclassified rather than guessing a proportional split. A missing marker remains accepted for older DAY / MONTH / TOTAL payloads, but fixed-range live-day derivation requires explicit `true` or explicit unclassified fields. Device aggregation and retained client/session restoration preserve these fields and propagate incomplete provenance fail closed.

`trackedClients` is optional but recommended for agents and widgets. When it is present, the hub treats omitted clients as intentionally not collected in this payload and preserves their previous usage for that device. This keeps "tracking" as "collect future data" rather than "hide existing history".

`historyAvailable` is an explicit boolean capability for retained History. Current producers send it on every usage snapshot: `true` means History collection is enabled, while `false` means disabled. Fixed-range readers require both `historyAvailable: true` and a retained `history` object; a missing capability (including records passed through an older Hub) is unavailable rather than an inferred zero. The `history` field itself remains interval-gated: omission means "no History update this tick", explicit `null` means unavailable, and an object replaces the retained History.

Current History daily rows may also carry `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `unclassifiedTokens`, and the same fields inside each `perClient` / `perModel` entry. `tokenComponentsAvailable: true` means the entire row has exact component provenance. Missing provenance does not change the exact total tokens, cost, Tool, or Model attribution: fixed ranges retain every known cache/output component and place only the unsupported remainder in `unclassifiedTokens` instead of treating it as zero or cache miss. The local daily archive keeps component provenance permanently, while sync payloads keep detailed components only for the latest 30 days because WEEK / 7D / 30D never need older detail and `/api/ingest` has a 1 MiB ceiling. If even that additive detail would push a device payload over its budget, serialization drops the component fields before any existing project or session detail.

Current agents and widgets include `osName` and, when known, `osVersion` so device details can show a user-facing operating-system release. macOS uses the product version from Electron or `sw_vers`; Windows uses the product family and display version from the registry; Linux uses the distribution name and version from `os-release`. Detection failures fall back to an explicitly labelled Windows build or Linux kernel release. The hub continues to accept older payloads without these fields.

`syncUploadIntervalMs` is optional. A remote-hub widget includes `0` for live uploads or the selected fixed interval in milliseconds (`600000`, `1200000`, or `1800000`). The hub uses a positive interval to keep the device and its limits fresh for at least twice the upload interval; omitted or `0` values retain the configured `staleAfterMs` behavior. Local collection and embedded-host ingest remain live.

`periodWindows` is optional. Agents and widgets stamp each snapshot with the UTC instant its `today`/`month` windows end, computed in the device's own local time (`endsAt` = next local midnight / next local month start; `key` is the device-local day/month for reference). New producers also include their IANA `timeZone`, which lets retained daily History keep using that device's calendar after it goes offline. The hub uses `endsAt` to expire a device's `today`/`month` from the native aggregate once `now >= endsAt`, so an offline device does not keep contributing a stale day/month snapshot (`allTime` never expires). Payloads without `periodWindows` fall back to a UTC day/month comparison against `updatedAt`; fixed History ranges fail closed after an unzoned producer window expires.

`clientHealth` is optional per-client diagnostics: why a tracked tool shows the number it shows. It sits alongside the older `clientStatus` map (`active` / `waiting` / `missing` per client), which agents continue to send unchanged.

```json
{
  "clientHealth": {
    "version": 1,
    "observedAt": "2026-08-04T09:15:00.000Z",
    "clients": {
      "claude": {
        "source": { "state": "detected", "detectedCount": 1, "checkedCount": 2 },
        "collection": { "state": "direct" },
        "data": { "liveTokens": 481230, "lastActivityDay": "2026-08-04" },
        "overall": "healthy"
      },
      "antigravity": {
        "source": {
          "state": "detected",
          "detectedCount": 2,
          "checkedCount": 3,
          "checks": [
            { "id": "tokscale-antigravity-cache", "exists": true },
            { "id": "antigravity-ide-source", "exists": true },
            { "id": "antigravity-cli-data", "exists": false }
          ]
        },
        "collection": {
          "state": "failed",
          "syncFailureStage": "timeout",
          "syncDetailCode": "network-timeout",
          "lastAttemptAt": "2026-08-04T09:12:00.000Z",
          "lastSuccessAt": "2026-08-04T08:40:00.000Z"
        },
        "data": { "liveTokens": 0, "lastActivityDay": "2026-08-03" },
        "diagnostics": [{ "code": "sync-timeout" }],
        "overall": "attention"
      }
    }
  }
}
```

Every tracked client sends the same fixed core — `source.state`, `source.detectedCount`, `source.checkedCount`, `collection.state`, `data.liveTokens`, and `overall` — because the hub recomputes `overall` from those inputs rather than storing what the producer claimed. Detail beyond the core is sparse: `source.checks` and `diagnostics` are sent only for a client that is not `healthy`, and a client with nothing to report sends neither.

`overall` is `healthy` (usage was observed), `waiting` (sources present, nothing counted yet), `attention` (something we do on the user's behalf is failing), `unavailable` (no source found at all), or `unknown`. `source.state` is `detected`, `missing`, or `unknown`, and is **derived from the counts** on ingest rather than read from the payload, so a state that contradicts them cannot be stored; `detectedCount` is clamped to `checkedCount` first, and a client with nothing probed is `unknown` rather than `missing`. `collection.state` is `direct` for the clients whose files are parsed in place — the common case, with no fetch step to succeed or fail — and `idle` / `pending` / `ok` / `failed` for the self-synced clients (Cursor, Antigravity) whose usage is refreshed by a subprocess. A value the reader does not recognize becomes `unknown`, never `direct`: `direct` is the positive claim that there is no fetch step to fail, so collapsing a future state onto it would report a broken client as working.

A client installed only inside a running WSL distro has no host directory, and its usage is merged into the same periods before either derivation runs. Its WSL marker is therefore a source that exists, reported as the `wsl-home` check — without it the same snapshot would count the client's tokens and call its source missing.

`source.checks[].id` is a stable identifier for a *kind* of source root, never a filesystem path: one id can stand for several platform variants (a VS Code workspace-storage root has one per platform), and an absolute path contains the user's home directory. Ids outside the recognized set are dropped on ingest. A failed self-sync likewise reports a stable code in `diagnostics` (`sync-failed`, `sync-timeout`, `sync-spawn-failed`, `sync-exit-error`) and never the subprocess's stderr. The other diagnostic codes are `source-missing`, `no-usage-observed`, and `wsl-detected-no-data`; the last one states that a WSL marker was found and the scan returned nothing, which can equally mean the tool is installed in that distro and unused.

For a failed self-sync, `collection.syncFailureStage` is an optional bounded stage: `spawn`, `timeout`, `process-exit`, or `unknown`. `collection.syncDetailCode` is a conservative classification of the failure: `language-server-not-found`, `rpc-failed`, `permission-denied`, `cache-write-failed`, `invalid-response`, `network-timeout`, `network-failed`, `authentication-failed`, or `unknown`. A non-negative `collection.syncExitCode` is included only when the subprocess reported a numeric exit code. These fields add process-level evidence without exposing stderr, paths, or provider output; an exit code is not interpreted as a universal root cause.

`diagnostics` entries are objects carrying a `code`, not bare strings, even though `code` is the only field today: the extension point belongs inside the entry, matching how LSP, ESLint, SARIF, and RFC 9457 all shape a diagnostic. Adding a field to the object stays backward compatible; turning `string[]` into `object[]` would not. Severity is deliberately **not** on the wire — the same code means different things on different clients, so it is a renderer decision rather than something a collector can know. Observation time is likewise recorded once, as `clientHealth.observedAt`, rather than per diagnostic: every entry comes from the same scan. It is its own field because a limits-only ingest carries health forward while the record's `updatedAt` moves on, so `updatedAt` cannot be read as the time the diagnosis was made.

There is deliberately no code for "some roots found, others absent". A client's roots are alternatives rather than dependencies — Antigravity's IDE cache, native sources, and CLI data are three ways to have it installed — so a partial set is what a normal install looks like. `source.checks` reports which ones were found as neutral evidence; only finding nothing at all is `source-missing`.

A diagnostic the rest of the entry does not support is dropped on ingest rather than stored: `sync-*` requires a failed collection, `source-missing` a missing source, and `no-usage-observed` a *detected* source with nothing counted — "we can read this client and found nothing" is a different statement from "there is nothing to read". `source.checks` is held to the same standard: it is evidence for `detectedCount`/`checkedCount`, so an array whose length or found-count disagrees with them is dropped whole rather than allowed to overwrite the core. The hub stores a record that is internally consistent, not one that merely passes per-field range checks.

`data.liveTokens` is the collector's per-client all-time usage **as scanned**, before any archive restoration runs. It is a lower bound on the device record's `allTime.clients[<id>]`, not a copy of it. Two separate restorations run afterwards, in the widget and the agent rather than in the collector: untracked-client usage, which by definition never touches a client that has a health entry, and session usage preserved after its source files were deleted, which applies to **any** client including tracked ones. So a tracked client can legitimately report `liveTokens: 0` in a record whose `allTime` counts its tokens.

The difference between the two is therefore not a way to derive archived contribution — it mixes two archives with different rules, and consumers must not treat it as one. ClientHealth v1 deliberately describes neither archived usage nor presentation-layer data origins; attributing them belongs where the composition actually happens.

`data.lastActivityDay` is the most recent day the collector holds usage for this client, taken from the daily history buckets. It is deliberately not "last used": tokscale exposes no per-turn timestamps, and the field is omitted entirely when history is unavailable.

Every value is a closed enum and every list is capped — including the client ids themselves, which are bounded in both count and length. A hub that does not recognize a value downgrades it to `unknown` rather than storing it, so an older hub in front of a newer agent degrades instead of passing unvalidated data to renderers. `clients` must be a plain object: an array, or a prototype-sensitive key such as `__proto__`, is refused rather than stored under an invented client id.

A limits-only ingest carries the previous usage forward, so `clientHealth` — along with `clientStatus` and `wslStatus` — travels with it when the payload omits the field. A full update that omits it still clears it: an agent posting complete usage without health is stating that it has none.

`clientHealth` rides on the device record and is returned by the authenticated `GET /api/stats` inside `devices[]`. It is **never** aggregated across devices and never appears on `GET /api/public/stats`, which drops `devices` wholesale — a cross-device rollup is the one shape that would place these diagnostics on the unauthenticated surface.

`limits` is optional. Agents and widgets include it when AI Tool Limits detection is enabled. Raw OAuth credentials, access tokens, refresh tokens, and provider response bodies must never be sent.

`limits.providers[].provider` is one of `claude`, `codex`, `cursor`, `antigravity`, `opencode`, `openrouter`, `deepseek`, `minimax`, `mimo`, `grok`, `copilot`, `kiro`, `commandcode`, `zai`, `zaiteam`, `volcengine`, `qoder`, `kimi`, `ollama`, or `thirdparty`.
`limits.providers[].accountKey` is a stable hashed account identifier (`sha256:…`) used to dedupe the same account across devices. OpenCode may additionally carry `webAccountKey`, a private canonical Web identity kept separately from the device-local DB-path identity, plus `accountKeyAliases`, a bounded list of private hashed legacy identities used to merge `go:` / `zen:` records from older devices with the canonical `workspace:` identity during rolling upgrades. `accountEmail` is the account email when available, and `accountName` is a sanitized display/profile name. Codex may additionally send `workspaceKind: "personal"` when the workspace has no provider-supplied name, allowing account-management UI to localize the Personal label without persisting translated text. `accountLabel` is the legacy provider-defined short label retained for mixed-version compatibility: older OpenCode renderers use it as the profile name, while existing providers may use it for the plan. `planLabel` is the explicit plan label (for example `Plus`, `Go`, or `Zen`) when identity and plan must be carried separately; readers fall back to `accountLabel` for payloads produced before `planLabel` existed. These fields MAY be sent to the authenticated hub so devices can identify each account and its plan. The hub ingest is protected by the shared `secret`; the **public** stats endpoints (`publicLimits`) strip `accountKey`, `webAccountKey`, `accountKeyAliases`, `accountEmail`, `accountName`, `accountLabel`, `planLabel`, `workspaceKind`, the third-party `balance.quotaGroup`, and `balance.tranches` so neither account identity, plan labels, custom group labels, nor per-grant credit detail are exposed publicly.
`limits.providers[].source` is one of `oauth`, `cli`, `web`, `rpc`, `local`, or `api`; `local` means the value was read from an on-disk store such as OpenCode Go usage from `opencode.db`, `web` means a browser/session cookie backed web endpoint (Cursor, OpenCode web accounts, Qoder, Command Code, MiMo, Kimi membership, Ollama), and `api` means a provider HTTP API authenticated by an API key, access token, or AK/SK credentials (OpenRouter, DeepSeek, Minimax, Copilot, GLM/Z.ai, Volcengine, Kimi Code, and third-party adapters).
`limits.providers[].balanceUsd` is an optional prepaid credit balance in USD (OpenCode Zen); `null` when the provider has no balance concept or none could be read. A genuine `0` (no remaining credit) is distinct from `null`.
`limits.providers[].balance` is an optional native-currency prepaid balance block. DeepSeek uses `{ amount, currency, todaySpend, monthSpend, allTimeSpend, trackingSince, monthSinceTracking }`: `amount` is the spendable balance in the account's own currency (e.g. `CNY`/`USD`); the spend fields are derived from locally observed paid-balance drawdown, `allTimeSpend` keeps accumulating after old daily buckets are pruned, `trackingSince` records when that local observation began, and `monthSinceTracking` is `true` until a full month of history has accrued. OpenRouter uses USD: `/key` supplies `todaySpend`, `weekSpend`, `monthSpend`, and the provider-reported lifetime `allTimeSpend`; when OpenRouter authorizes `/credits` (officially documented for Management keys), `amount` and the corresponding real Credits meter are also included. Other OpenRouter keys can still report their own spend and configured key limit without inventing an account balance. MiMo may additionally send `giftBalance`, `cashBalance`, Token Plan usage fields, and `planStatus` (`active`, `expired`, `none`, or `null`). An expired MiMo Token Plan has no quota window even when its prepaid balance remains available. Claude uses `{ amount, currency, expiresAt, tranches }` for its prepaid usage-credit pool; it is read from claude.ai and is therefore present only for web-session accounts, never on the OAuth path. It is reported whether or not the account currently has usage credits switched on, but an account that has never funded the pool sends no balance at all rather than a zero one. `balance.tranches` is an optional array of `{ amount, currency, expiresAt }` credit grants — purchased and promotional merged, soonest expiry first, grants without an expiry last — omitted entirely when the provider has none. Claude's `credits` window is reported with `showMeter: false`: the balance is a sum of independently expiring grants with no quota denominator, so no meter percentage may be derived for it. The **public** stats endpoints strip `balance.tranches` along with `balance.quotaGroup`, so per-grant amounts and expiry dates never leave the authenticated surface. `null` when not applicable.

`thirdparty` is an explicit adapter registry rather than a universal balance endpoint. Its New API-compatible account preset calls `/api/user/self` with an access token and adds `New-Api-User` only when a User ID is configured. New API normally requires that ID, while compatible One API forks may accept the same endpoint without it. `amount` is the whole account's remaining quota, `allTimeSpend` is the provider-reported used quota, `requestCount` is the non-negative lifetime request count when returned, and `quotaGroup` is the bounded account group label. The New API API-key preset calls `/api/usage/token/` with a regular API key and reports only that key's independently configured quota; `expiresAt` is included when the endpoint supplies a positive expiry timestamp. New API quota points are normalized to USD using the instance's `quota_per_unit`, and unlimited quota keeps `amount: null` instead of inventing a zero balance. The declarative Custom preset performs one GET request on the configured Base URL, authenticates with either `Authorization: Bearer` or `x-api-key`, and maps a required remaining-balance JSON path plus optional used and total paths. Its fixed currency and divisor are local configuration; missing or non-numeric mapped values fail closed, and it never guesses a provider's billing endpoint from OpenAI or Anthropic inference compatibility. Third-party presets do not synthesize daily, weekly, or monthly spend.

DeepSeek uses `source: "api"` and has no rate-limit windows; its `windows` array carries only the balance as a `credits` window. OpenRouter, GLM/Z.ai, Volcengine, Qoder, Command Code, Kimi, Ollama, and third-party adapters report quota/credit windows through the same `windows` array. Command Code reports its 5-hour and weekly rolling limits as ordinary percentage windows, and ships its monthly grant (plus any rollover top-up) as `credits` windows in USD. Third-party adapter identifiers, profile Base URLs, endpoint paths, response mappings, user IDs, and raw credentials remain local and are never added to this wire shape.
`windows[].kind` is `session`, `weekly`, or `billing`. `windows[].source` is optionally `web` or `local` when one provider row combines components from different origins; OpenCode uses it so a device can hide its own opt-in local DB estimate without hiding Web quota or another device's estimate. Readers must treat the field as component provenance rather than replacing `limits.providers[].source`, and older windows may omit it. `windows[].metric` is an optional stable machine-readable role; `credits` identifies a provider's balance/credits meter and `spend` a money-already-consumed meter, both independently of the display label (currently OpenRouter account credits, third-party account/token quota, DeepSeek balance, and MiMo balance). A `credits` window's headline value is money, carried as an absolute `remaining` amount rather than a percentage; balance providers with no fixed quota denominator report no `usedPercent`/`remainingPercent` at all, and any meter percentage for them is derived by the renderer and deliberately kept off the wire. `windows[].currency` is an optional currency code (uppercase, at most 8 characters) that applies to the window's absolute `used`/`limit`/`remaining` amounts, so a balance renders in its own currency without conversion. Normalization restores a `credits` window from a provider's `balance.amount` when the record carries a balance but no such window, so records posted by devices older than this field keep rendering; only the amount is restored, never a percentage. A collector that reports a balance and does not want that synthesized meter must emit its own `credits` window with `showMeter: false`, as Claude does. Claude may additionally report a `billing` window with `metric: "spend"` labelled `Usage credits`, carrying `used` and — only when the account has set a monthly spend limit — `limit` and a derived `usedPercent`. Without such a limit it reports `used` alone with `showMeter: false`; the upstream `spend.percent` field reports `0` rather than `null` in that state and is deliberately not forwarded. `windows[].detail` is an optional bounded display-only description for a window, such as the Kimi-vs-Code composition of the single shared monthly membership meter; it must not contain credentials or raw provider response data.

## `GET /api/stats`

Returns aggregate stats for the widget.

Response includes:

- `staleAfterMs`, the effective Hub threshold used to recompute device and provider freshness
- `periods.today`
- `periods.month`
- `periods.allTime`
- `periods.*.clientModels` and `periods.*.clientModelCosts` for preserving model breakdowns when a tracked tool is disabled
- `periods.*.projects` for workspace-level tokens, cost, and client attribution; the same canonical folder label aggregates across devices
- `periods.today.sessions` / `periods.month.sessions` keyed by `client:sessionId` for session-level usage when tokscale exposes session groups; widgets may use `lastUsedAt` for recent-first sorting and optional `projectId` / `projectLabel` for workspace-level aggregation. Absolute workspace paths stay on the collecting device and are never part of the wire shape. Synchronized clients omit the unbounded `allTime.sessions` collection and may bound `today` / `month` detail when required by the ingest limit while preserving all aggregate totals and breakdowns.
- `sessionDetailsOmitted`, when one or more synchronized devices omitted session rows to stay within the ingest limit; the aggregate contains summed `today` / `month` counts and each affected device reports its own counts
- `periodProjectsOmitted`, when a daily or monthly project rollup was itself too large to fit; the aggregate and affected devices expose omitted project counts and the widget marks that period's project breakdown incomplete
- `projectsIncomplete` plus the corresponding `devices[].allTimeProjectsOmitted`, `devices[].allTimeProjectsIncomplete`, or `devices[].projectsEnabled` diagnostic
- `historyPreview.daily[].activeTimeMs`, `historyPreview.monthly[].activeTimeMs`, and `historyPreview.summary.activeTimeMs` when tokscale graph exposes session active-time metrics
- `historyRevision`, a compact invalidation hash for the aggregate History preview, and `deviceHistoryRevision`, a device-identity-aware hash used to invalidate per-device fixed-range caches when History ownership or availability changes
- `limits.providers` aggregated by provider account
- `subscriptionsUpdatedAt`, the `updatedAt` of the hub's shared subscription list, or `""` if nothing has been written to it. The version only, never the records: a device compares it against the copy it holds and re-reads `/api/subscriptions` only when it has been overtaken. This is how an edit made on one device reaches the others, so a client that does not consult it will only see the shared list as it stood when it connected. Omitted from public Worker stats. An absent field means "no news" rather than an empty list.
- `devices`, including each device's normalized `periods`, `limits`, `receivedAt`, `osName` / `osVersion` when reported, optional `syncUploadIntervalMs`, and optional `periodWindows`
- stale status for devices that have not reported recently

If multiple devices report the same provider account, the hub keeps the freshest valid limits status for that account. Public Worker stats omit account identifiers.

## `GET /api/devices`

Returns normalized records for all stored devices.

## `DELETE /api/devices/:id`

Deletes one device record from the hub store.

This is useful after renaming a device id.

## `GET /api/subscriptions`

Returns the hub's shared subscription list.

```json
{
  "ok": true,
  "version": 1,
  "updatedAt": "2026-08-02T09:14:11.204Z",
  "subscriptions": [
    {
      "id": "sub_1754126051204_k3xq",
      "provider": "codex",
      "kind": "subscription",
      "binding": { "profileName": "", "accountKey": "sha256:…", "accountEmail": "you@example.com" },
      "planName": "Plus",
      "amountMinor": 9000,
      "currency": "HKD",
      "interval": "month",
      "intervalCount": 1,
      "startDate": "2026-05-31",
      "topUps": [],
      "autoRenew": true,
      "nextRenewalOverride": null,
      "endDate": null,
      "note": "",
      "updatedAt": "2026-08-02T09:14:11.204Z"
    }
  ]
}
```

Unlike usage and limits, subscriptions are **not** part of a device record. A subscription describes an account rather than a machine, and account keys are not stable across platforms — the same OAuth login hashes differently on macOS and Windows — so per-device copies could not be reliably deduplicated and a two-machine setup would double its own monthly total. The hub therefore stores exactly one list, shared by every device connected to it, and a delete is a delete with no tombstone needed to stop another device resurrecting it.

Devices in `local` mode keep their own list in the widget's `settings.json` and never call these endpoints. In `client` and `host` mode `settings.json` holds only the last-known copy, so a hub that is unreachable at startup still shows the records; writes made while it is unreachable are refused rather than applied locally, which would fork the shared list.

Both endpoints sit behind the same `secret` gate as every other data route, and the list is never included in `publicStats` / `publicLimits`, which are built from device records alone.

`topUps[]` entries are `{ id, date, amountMinor }`, newest first. Amounts are integer hundredths of a unit in the record's own `currency`. Dates are plain `YYYY-MM-DD` calendar days, never timestamps.

## `PUT /api/subscriptions`

Replaces the shared list.

```json
{
  "subscriptions": [],
  "baseUpdatedAt": "2026-08-02T09:14:11.204Z"
}
```

`subscriptions` must be an array; anything else responds `400` and stores nothing. An empty array is a valid clear, but a malformed or truncated body would otherwise normalize to an empty list and be stored as a perfectly successful replacement.

`baseUpdatedAt` is the `updatedAt` the client last read. If it does not match the stored document the hub responds `409` with the current document and writes nothing: a device showing a stale copy would otherwise erase every record added elsewhere since it last looked, and this data exists nowhere else. An empty `baseUpdatedAt` is accepted only against a hub that has never been written to — a hub whose list is empty but whose `updatedAt` is set has had its records deleted, and re-seeding it from a stale cache would undo that.

Because `updatedAt` doubles as the concurrency token, it is guaranteed to increase strictly on every accepted write: two writes landing in the same millisecond would otherwise share a token, and a third holding the older one would pass the staleness check against a document it never read.

Records are re-normalized on ingest exactly as `POST /api/ingest` normalizes device records; unknown fields are dropped and malformed records are discarded rather than stored. `currency` is validated against the display currencies the app carries rates for (`USD`, `TWD`, `HKD`, `CNY`); a record naming anything else responds `400` and stores nothing, because coercing it would report an amount the user never entered. A successful write responds `200` with the stored document in the same shape as `GET`.

An accepted write also broadcasts stats to connected stream clients with `reason: "subscriptions"`, the same way an ingest does. That frame carries the new `subscriptionsUpdatedAt`, which is how the other devices learn their copy has been overtaken.
