# Resource fields and measurement coverage

Use this reference with the [query options and subscription example](author-data-settings.md). These resources read captured host data; queries do not scan logs, refresh quotas or collect new evidence. They are available to enabled plugins through `ctx.data` without a Node backend.

This reference describes the current experimental API contract; backward compatibility is not guaranteed. Fields can be `null` when their source does not provide a value. Missing measurement evidence must remain unknown rather than being replaced with invented values.

## Read availability before values

1. Check the result's `availability`. `notCollected` and `scopeUnavailable` are not measured zeroes.
2. Check `aggregateCoverage.kind` and `pageInfo.hasMore`. A page is not a whole-source total; even a complete traversal may have partial source coverage.
3. Check `freshness` and row-specific timestamps. The envelope clock follows usage collection; quota freshness follows the individual quota row's `updatedAt` and `status`.
4. Check field-level evidence. A numeric counter can be a normalized default; its presence alone does not establish measurement support.

### Common usage fields

`usage` rows, session rows, project rows and history buckets use a common usage projection. Model/tool rows expose the subset supported by their attribution maps. A shared field name does not promise that every resource or producer measures it.

| Field | Meaning |
| --- | --- |
| `totalTokens` | Accounting total for the row; do not add component coverage totals to it |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `unclassifiedTokens` | Available component counters; missing fields are `null`. Reasoning accounting depends on the producer; do not automatically add it to the total or output. |
| `messageCount` | Available message count, not a universal request count |
| `timedTokens`, `timedOutputTokens`, `timedDurationMs` | Matched cumulative timing counters, where measured. Duration is summed measured request time, not elapsed session or scan time. |
| `capabilities.tokenComponents`, `capabilities.throughput` | Host capability evidence: `true` supported, `false` not fully supported, `null` unknown. These flags do not promise complete coverage of all tokens or every child row. |
| `tokenComponentsAvailable` | Separate producer-supplied component flag when present, otherwise `null`; not inferred from numeric zeroes |
| `contextTokens`, `contextWindow`, `activeTimeMs` | Available context/activity measurements; `null` does not mean an empty context or no activity |
| `cost` | `{knownUsd, unpricedTokens, currency, completeness}`; currency is USD. `completeness` is `complete`, `partial` or `unknown`. A known subtotal is not necessarily the full bill. |

For normalized period totals, inspect `capabilities` before interpreting default component/timing counters. Session or bucket producers may not carry these flags: `null` means unknown, not permission to assume full measurement. For narrower observed evidence, use the explicitly provided model timing or session/model component records below.

```js
const result = await ctx.data.query({ resource: 'usage', period: 'today' });
if (result.availability === 'available') {
  for (const row of result.rows) {
    const timingSupported = row.capabilities?.throughput === true;
    // No division when timing is unsupported, unknown or has no measured duration.
    const measuredAverage = timingSupported && row.timedDurationMs > 0
      && row.timedOutputTokens !== null
      ? row.timedOutputTokens * 1000 / row.timedDurationMs : null;
    // This is the row's measured average, not the App's live tok/s reading.
    console.log(measuredAverage);
  }
}
```

## Resource catalogue

| Resource | Row data and scope |
| --- | --- |
| `usage` | Period totals, common usage fields and `window: {key, endsAt, timeZone, calendar}`. `deviceId: null` denotes aggregate scope. |
| `models` | Model identifier/label, attributed tokens, costs and available components. `throughput` holds the model's matched `timedTokens`, `timedOutputTokens`, `timedDurationMs`, or `null` counters when absent. |
| `tools` | Client identifier/label, attributed usage and `models: [{model, totalTokens, knownUsd}]`. Client timing is not currently projected: `throughput` counters are `null`; model names cannot establish client timing. |
| `devices` | Opaque device ID, host/display names, OS/runtime/version, collection/receipt timestamps, stale state, tracked clients, client state and WSL summary. |
| `projects` | Opaque project ID, label, common usage fields, model token totals and client token totals. Check coverage for omitted/incomplete projects. |
| `sessions` | Opaque session/project/parent relations, client, title where enabled, `projectPath`, timestamps, session kind, `turnEnded`, `waitingForInput`, `liveActivity`, prompt-cache metadata, common usage fields, models and providers. See model components below. |
| `history` | Daily/monthly buckets or an all-time summary, with common usage fields. Ungrouped buckets can also provide favorite model, message/activity/streak/peak/intensity values. Grouped rows identify their model or client. No hourly/minute resolution. Device-scoped history queries return `scopeUnavailable`. |
| `limits` | Provider identity/label, available account identity, plan/status/update metadata, quota `windows`, balance/tranches, usage summary and reset credits. Quota labels have host-derived `displayLabel`. Values/units remain provider-specific; credits do not always mean money. |
| `subscriptions` | Subscription/top-up ledger, opaque account binding where known, currency/amount/calendar fields, notes, top-ups and host-derived calendar/currency/forecast results. Device scope is unavailable. |
| `status` | Device collection/source health and host collection/sync/availability summaries where supplied. Host preferences include currency, locale, time zone and feature visibility. This is not an App updater or provider incident feed. |
| `liveRate` | Host-computed matched-counter speed/burn and live/idle/unavailable state for the selected source or an explicit device. Only `today` is accepted; see below. |

This table describes row content, not additional query options. For supported filters and sorting, use the [query reference](author-data-settings.md#read-a-snapshot). Remote/lifetime session detail is limited to what the host actually captured; native display fallbacks do not manufacture accounting rows.

### Session model components

Each `sessions` row has `models: [{model, totalTokens, knownUsd, tokenComponents}]`. `tokenComponents` is `null` without observed evidence, otherwise:

```json
{"totalTokens":50,"inputTokens":10,"cacheReadTokens":20,"cacheWriteTokens":5,"outputTokens":10}
```

Here the nested `totalTokens` is **observed coverage**, not extra usage. If the model row contains 80 tokens, only 50 have this component evidence. The four components sum to 45, leaving 5 unknown within that observed portion; the remaining 30 model tokens are also not classified by this record. Do not scale these counters to fill the model total or distribute a session-wide split by model percentages. Only validated host observations are projected; extra producer fields are not copied.

### Subscription derivations

`derived` supplies `status`, `reason`, `asOfDate`, `active`, `nextRenewalDate`, `coverageEndDate`, `daysUntilRenewal`, `paidToDateMinor`, `monthlyAmountUsd`, `monthlyAmountUsdReason`, `topUpTotalMinor`, `topUpMonthMinor` and `forecast`. Currency/calendar results use the host's captured context. Minor-unit amounts are not dollar amounts.

The top-up forecast reports its own `status` and `reason`, matched `accountId`, `balanceUpdatedAt`, currency/balance, daily burn, days remaining and exhaustion date when supported. Unmatched, ambiguous, stale, unavailable and not-applicable results remain explicit; do not substitute a different account or present missing rates as USD.

## Live token rate

Query or subscribe with `{resource: 'liveRate'}`. Omit `deviceId` for the selected source: local mode uses the local device, shared modes sum independently active device rates. For a specific device, use its opaque ID from `devices` as `filter.deviceId`; an ID outside the current plugin/source scope returns `scopeUnavailable`. The resource works independently of native footer, Tray and Bubble rate-display settings.

The usual result envelope contains one row when the source exists. `availability: 'available'` means the resource can describe its state, not that it necessarily has a rate. Check the row's `state` before interpreting values:

| Field | Meaning |
| --- | --- |
| `state` | `live` (更新中), `idle` (閒置, retained last reading), or `unavailable` (無可用讀數) |
| `reason` | `null` for live/idle; otherwise `waitingForSample`, `unsupportedTiming`, `missingData`, `stale` or `expired` |
| `speed` | Estimated generated output tokens per second (`tok/s`) from matched timed-output/duration deltas |
| `burn` | Matched timed-token consumption per minute (`TPM`), not currency spend |
| `sampledAt` | Unix milliseconds of the accepted observation, not a claim about when an individual token was generated |
| `expiresAt` | Unix milliseconds of the next sample expiry; expiry can change the rate or move it to idle/unavailable |
| `sampleRevision` | Accepted-sample revision within the current tracker lifetime. Idle transitions do not create a new observed sample. Clear saved chart history on a reset. |
| `deviceCount` | Number of contributing devices in this reading. An idle retained reading describes its last contribution set, not currently active devices. |
| `id`, `deviceId`, `period` | Opaque row identity, `null` aggregate or selected opaque device ID, and `today` |

For `unavailable`, the numeric rate/timestamp/revision fields are `null` and `deviceCount` is zero. A supported measured zero can instead be `state: 'live', speed: 0`: do not replace it with a missing marker using `value || '—'`.

The first observed snapshot establishes a baseline; a subsequent positive matched-duration delta can produce a reading. Counter regressions and source/client-selection changes reset tracking. New devices establish their own baselines without clearing other devices' active samples; departed/stale devices are removed from both active and retained aggregate readings. Unsupported/incomplete timing does not become a valid zero. Shared-source output sums active per-device samples rather than dividing fleet token totals by summed busy time; this is not proof that every device or token has timing coverage. A shared source containing only stale devices reports `reason: 'stale'`, distinct from an empty source's `missingData`.

Use `subscribe` to maintain live tracking. A `query` only reads the current snapshot; it does not start tracking. Without an active subscription for the same source/device scope, supported timing returns `waitingForSample`. Subscriptions for the same scope share tracking; the last subscription leaving releases its baseline and expiry timer. Unsubscribe when hidden/disposed; closing the owner or disabling the plugin also releases its subscriptions.

Tracking uses existing host publications, with no additional scans or provider calls. Subscriptions also receive coalesced invalidations when readings expire without another publication. Samples become idle after their active lifetime and the retained reading clears later; use the returned state and timestamps instead of hard-coding those deadlines.

With an active subscription for the same scope, this query reads the current snapshot:

```js
const result = await ctx.data.query({ resource: 'liveRate' });
if (result.availability === 'available') {
  const rate = result.rows[0];
  const label = rate.state === 'unavailable'
    ? `No reading: ${rate.reason}`
    : `${rate.speed} tok/s${rate.state === 'idle' ? ' (idle, last reading)' : ''}`;
  console.log(label);
}
```

For a mounted chart, use `{resource: 'liveRate'}` in the [subscription lifecycle example](author-data-settings.md#live-updates-with-cleanup), adapt its `show` function to this row shape, and refetch on invalidation. Device-scoped subscriptions invalidate only when their own reading changes; aggregate subscriptions also follow changes in contributing devices.

Refresh the displayed rate, device count and state after every invalidation, even if `sampleRevision` is unchanged. In a shared source, one device can expire while another stays active: the aggregate might drop from 90 to 50 tok/s without a new observation. Distinguish these time-driven transitions from newly observed samples in chart history; do not label expiry transitions as new measurements or skip redrawing them. Clear old readings on reset before refetching.

## Identity and unsupported data

- Query IDs are opaque and scoped to the plugin, selected source and privacy identity. They support joins within that scope, but have no cross-restart persistence guarantee. Do not save them as permanent pin, label or mapping keys, or try to recover raw IDs from them. No formal durable-identity API is currently provided.
- `ctx.data.subscribe` invalidates snapshots; it is not a lossless event log or a per-token stream. Neither collector wall time nor renderer refresh time is a generation duration.
- Limits/subscription account identity does not prove which account produced a session's usage. Sessions do not expose a complete account-usage attribution contract.
- Full transcripts, raw credentials and universal TTFT/per-request timelines are not business-data resources. A total token count or session start/end timestamp cannot reconstruct them.
- Host-specific renderer services and DOM extensions are separate from this portable query contract. Reading internal files or inventing missing observations does not establish API support.

On source/privacy reset, clear retained rows, cursors and derived displays before refetching. Release subscriptions on disposal and unnecessary work when hidden; follow the [complete lifecycle example](author-data-settings.md#live-updates-with-cleanup).
