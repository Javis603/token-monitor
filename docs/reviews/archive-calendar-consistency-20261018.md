# Session archive calendar consistency — 2026-10-18

PR [#970](https://github.com/Javis603/token-monitor/pull/970), starting at `c1e067a1b829ded13f7816dc91e2ad08e33a4c04`. Compared with [#1063](https://github.com/Javis603/token-monitor/pull/1063) at `0dedead14528939776caeaa086337d32188384c6`. Related issue: [#986](https://github.com/Javis603/token-monitor/issues/986). Dates in this report use Asia/Shanghai.

## Change and evidence

A capture after a collection pause can stamp yesterday's session counters as today's archive window. When the live session disappears, #970 replays them into Today. The mixed-row reproduction restores 1,250 tokens instead of the valid current 250. The correction keeps Month and lifetime at 1,250, including both historical Sessions rows, while Today contains only the current row. Projection does not modify the stored archive.

Production changes are confined to `src/shared/usage/sessionUsageArchive.js`. New windows retain `utcOffsetMinutes`; normalization and SQLite reload retain that evidence. Today replay compares activity in that captured frame rather than the reader's timezone. Missing or malformed frame/activity evidence remains ambiguous. Stored capture-day keys and existing expiry rules are preserved.

The direct #1063 transplant also reproduced a counterexample: a valid current-period observation with old `lastUsedAt` disappears after its live row is omitted, including after SQLite reopen. This branch additionally retains the collector's explicit Today key as `reportedDay`. That reporting evidence takes precedence over activity metadata. A stale explicit reporting day refuses Today replay; a current explicit day preserves it. Fresh reporting evidence can update an unchanged counter payload. Invalid calendar keys cannot become authoritative. Invalid offsets cannot throw or silently remove usage.

The six upstream calendar regressions are adapted with attribution in `tests/shared/sessionUsageArchiveCalendar.test.js`. Twelve additional cases cover mixed healthy/stale rows, explicit current and stale reporting evidence, unchanged-counter corrections, midnight/month rollover, SQLite persistence, legacy no-op recapture, invalid evidence, and a real two-process UTC+8-write/UTC-read SQLite round trip.

## Validation

Local runtime: macOS arm64, Node **24.19.0**, existing lockfile dependencies. No dependency, scanner binary or vendor pin change.

The same final 18-case fixture was applied to isolated source variants:

| Source | Pass | Fail |
| --- | ---: | ---: |
| Original #970 `c1e067a1` | 11 | 7 |
| #1063 direct transplant, adapted only to #970's existing usage predicate | 13 | 5 |
| This integration | 18 | 0 |

The direct transplant's five failures cover explicit current/stale reporting days, unchanged-counter evidence, current-period SQLite recovery, and malformed offset handling. Counterfactual source replacements were confined to an isolated baseline checkout and restored afterward.

The focused archive, store, transform, period merge, daily history, collector window, local Dots, cloud accounting/presentation, Sessions, stats publication, wiring and Hub-build selection passes **422/422 in each of ten process timezones**, **4,220 total passes**, zero failures/skips. Zones: UTC, Asia/Shanghai, Asia/Ho_Chi_Minh, Asia/Kathmandu, Pacific/Chatham, America/Los_Angeles, Pacific/Honolulu, Pacific/Pago_Pago, Pacific/Kiritimati and Etc/GMT+12. This includes all seven upstream CI zones, fractional offsets and UTC−12/UTC+14.

`npm run lint`, `git diff --check`, and `npm run update:hub-build` pass. The Hub build registry was already current; Worker synchronization produced no tracked change. The archive module remains outside that generated closure.

Full `npm run verify` was attempted on both source variants under the same sandbox:

| Full attempt | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Original #970 | 7,121 | 7,071 | 41 | 9 |
| Integrated production source | 7,139 | 7,088 | 42 | 9 |

Both lint phases pass. Forty-one failing tests are shared: loopback listeners fail with `listen EPERM`, native process inspection with `spawn EPERM`, and native watcher cases with `EMFILE`, missing native events or process-lifecycle assertions. The integration also encountered `rapid restarts leave the latest worker active after every exit barrier` timing out before readiness. An isolated rerun passes on both baseline and integration, approximately 162/163 ms respectively; its root cause remains unknown. Its test, collector, watcher host and watcher worker blobs are unchanged. No test assertions or production watcher behavior were altered. The first UTC matrix attempt also exposed JSON's normalization of negative zero in a new fixture assertion; the expected persisted offset was corrected to numeric zero, and all ten final zones passed.

These results validate the focused change and its counting boundaries; the unrestricted full suite has **not** passed in this environment. Remote CI must be assessed on the published revision independently of older #970 results.

Focused reproduction, using the repository's normal Node runtime:

```sh
node --test tests/shared/sessionUsageArchiveCalendar.test.js
npm run lint
npm run update:hub-build
npm run verify
```

## Retention and remaining boundaries

Month/lifetime membership, historical Sessions retention, local Dots archive exclusion and cloud baseline/increment isolation are covered by the focused selection. Cloud accounting, its TOTAL-only initial cumulative baselines, observation-dated increments and presentation reconciliation are untouched. No real account, installed application or production archive was used or migrated during these checks.

Ambiguous legacy rows are retained. An unchanged capture without new reporting evidence does not invent an old window's offset. A genuine new explicit reporting observation may update that window. No historical daily maxima are deleted, redistributed or recalculated.

The collector's own current window does not prove that its scanner returned fresh rows. When that current window accompanies older activity metadata, the explicit window is retained to avoid losing legitimate usage; resolving that ambiguity requires scanner-side reporting-window/completeness evidence. This is prevention of evidenced stale replay, not complete repair of #986 or cross-scanner/WSL calendar agreement.

#970 predates [#1071](https://github.com/Javis603/token-monitor/pull/1071). This small integration preserves #970's existing live-row precedence and does not transplant #1071's broader zero-observation, full-scan-completion or publication-failure semantics. Those remain a separate compatibility follow-up. PR #970 remains a draft with its existing prerequisite/release gates.
