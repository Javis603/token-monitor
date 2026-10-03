# Estimated-cost selections

Open **Settings → Collection → Codex** (expand the tool row), then **ChatGPT Web estimated costs**. All Web usage is included by default. Switch the group off, or leave it on and uncheck individual model IDs. Pro and Extra High are offered initially; other `chatgpt-web/` IDs appear when observed. Saved choices remain available even when a model is absent from the current period.

This is a local reporting preference, not a billing control. It changes the widget's estimates, cost ranking, tray, native widget and historical charts. Token counts and model rows remain visible. It does not change API prices, subscriptions, upstream billing, raw archives, exports, the collector, or another device's selections. Unpriced models remain unpriced. Model rows indicate the excluded amount; active selections are labelled in the widget/dashboard.

## Rules

`usageCostRules` is stored in desktop `settings.json`, defaulting to `[]`. Rules support any tool and literal model prefix, not a hardcoded Extra High blacklist. Only the Codex Web editor is exposed in this version:

```json
{
  "usageCostRules": [{
    "client": "codex",
    "modelPrefix": "chatgpt-web/",
    "included": true,
    "models": { "chatgpt-web/extra-high": false }
  }]
}
```

Matching is case-insensitive, with literal prefixes (no regexes). Last matching rule wins; its master switch overrides its saved exact-model selections. Switching off and back on preserves those selections. Unknown models stay included while the group is on. Rules match raw IDs before separately configured display aliases. They never write Tokscale's global custom pricing file.

Costs are projected from already-priced tool-by-model buckets; token components remain unchanged. Native periods, devices, retained sessions and history use the same projection. Settings-dependent cache revisions make toggling work offline without rescanning. Restoring a choice always starts from original cached data.

## Attribution limits and compatibility

New history retains optional `clientModelCosts` on daily/monthly rows and the lifetime summary. This distinguishes two tools using the same model ID. Older single-tool rows are recoverable too. Mixed-tool legacy rows cannot be split reliably: unknown costs stay included and the display reports incomplete attribution. Synced project totals without retained session detail similarly keep their unidentifiable portion and are qualified, not silently repriced.

When a sync payload exceeds its size budget, optional cost attribution is omitted before evicting session/project identities, with `clientModelCostsIncomplete: true`. Local archives stay intact. Older hubs/widgets can ignore additive fields; missing attribution never means zero cost. Lossless exports can intentionally differ from the selected local estimate.

## Verification

Run `npm run verify`. The focused `usageCostPolicy`, `usageCostIntegration` and `syncPayload` tests cover defaults, other tools sharing IDs, immutable/reversible projections, history and device IPC, capped previews, legacy attribution, project qualification and the sync budget fallback.
