---
summary: "Third-party balance adapters and New API dashboard spend boundaries."
ids: [thirdparty]
read_when:
  - Changing New API dashboard spend parsing, date ranges or optional request deadlines
  - Changing third-party adapter fallback or account balance presentation
---

# Third-party balances

`src/shared/providers/thirdparty/limits.js` owns account, token, Sub2API and custom balance adapters. All requests use the injected outbound transport. Credentials remain in the main-process credential store; standalone collection uses its configured environment/profile inputs.

## New API dashboard spend

Account mode optionally reads `/api/data/self` for Today, the rolling week (today plus six previous local dates), and the local calendar month. These use the same `quota_per_unit` as the account balance. Token mode does not query this dashboard.

New API stores billing data in UTC-hour buckets and filters the stored `created_at` values inclusively. `default_time=day` does not rebucket those rows. A local period start must therefore align with a UTC hour; evaluate each start independently, since DST can make the month start differ from today's offset. Leave an unaligned period unknown and skip its request. Rounding down includes the previous date; rounding up or prorating loses exact accounting. The contract is present in upstream `v1.0.0-rc.37` and commit `603a5ceb55908cc24b509aca2caa6fc956c9958c` (`model/usedata.go`, `controller/usedata.go`).

Only a valid array of finite, nonnegative `quota` values can produce a spend total. Numeric strings follow the adapter's existing numeric parser. A valid empty array is zero; any malformed row or nonfinite total/conversion makes the entire affected period unknown. Forks returning another schema, such as `sumQuota`/`sumUsd` rows, must fall back rather than silently report zero; those fields do not establish compatible units or date semantics.

When `/api/status` explicitly reports `enable_data_export: false`, ignore all dashboard period totals, including empty arrays and previously recorded rows. New API stops recording quota data while this flag is disabled but still serves the dashboard endpoint, so a successful response cannot establish zero or complete spend. Keep balance and all-time spend available. A missing flag retains compatibility with forks that do not publish it.

Each New API dashboard request has a three-second deadline covering both fetch and JSON decoding, independently of the provider deadline. The deadline also settles transports that ignore cancellation. Completed periods survive another period's timeout; successful balance and all-time spend remain available. Parent cancellation still cancels the refresh. This deadline is specific to the New API account adapter and does not change Sub2API enrichment/renewal.

For New API accounts, the shared Limits/Edge Dock view summarizes available Today and Month values. On the Limits page its upward-opening tooltip preserves total quota, request count, group and other available account details above the period breakdown, so spend stays nearest the trigger. Show the full available breakdown only when it adds periods beyond the summary, with a divider when both blocks exist. Unknown periods are omitted; when only all-time spend is known, that is the summary and the tooltip retains account details without repeating all-time spend. Other third-party adapters, including Sub2API, keep their existing Month/All time summary and account or usage tooltip. The Edge Dock card is drawn in a window only as tall as the card, and a popover cannot open past that window, so the card grows to the height its tooltip needs and the tooltip is laid out as a panel across the card's width; the top edge is held while the window grows so neither the card nor the pointer on it moves. Both surfaces therefore show the same rows.
