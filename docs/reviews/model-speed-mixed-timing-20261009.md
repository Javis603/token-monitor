# Mixed-timing compatibility review — 2026-10-09

Reviewed App #970 at `497348d94c918bfccaed46e7d636afb847ae2bf7`, App #972 at `bb2aa7f9b0bf8dc3966af2fe128a6311d29aca45`, and producer #9 metadata at `a1da20cc7813ccdef7722ef93e6badca0e994b7d`. Both upstream coordinated-fix PRs remain drafts, with producer/release/platform acceptance outstanding.

## Findings and minimal changes

1. #970's old whole-row numerator propagates into model/source throughput, cumulative/live rates, and new persisted measurements. The shared consumer from #972 is applied without dropping #970's source catalogs. Explicit zero remains authoritative, aliases and malformed subtotals do not revive whole-row fallback, and only disjoint timed reasoning is additive. The already merged #957 Antigravity reasoning helper and its regression are included as a semantic prerequisite, without importing that commit's vendor update.
2. Source splits are checked against the corrected measured output/duration. A partial valid split retains its remainder on the observed source; oversized or full-duration/incomplete-output splits fall back to that row's observed source. Usage references retain all output, including untimed tokens. One model's merged rate is measured token sums divided by duration sums. Multiple account identities do not prove request ownership: #970 correctly leaves mixed-owner speed as unattributed while preserving source references. No new source-history algorithm is required.
3. The speed-history high-water guard retained pending pre-correction samples. Reproduction: cumulative 200/1000 → 230/1100 leaves 30/100 pending; correction to 100/1100 retains it; recovery to 300/2100 would combine 30/100 with the accepted 70/1000, reporting about 90.91 TPS instead of 70. The guard now clears pending counters on any output/duration regression, retains the high-water anchor, and survives persistence/restart without replay.
4. The model list remains ranked by confirmed activity and usage evidence, not TPS; changing timed output does not change total usage. Untimed appends update candidate usage while adding no speed/history/live sample. The shared Today/Week/Last7/Month/Last30/Total range reads the same paired samples. Two new increments, 100/1000 and 100/4000, report weighted 40 TPS in every range and sole-source detail after restart.

## Validation actually performed

Linux / Node 24.19.0. No real account capture or model benchmark calls were used in the focused checks.

- New eight combination regressions on the untouched #970 head: **1 passed, 7 failed**. After combining the consumer but before the pending fix: **7 passed, 1 failed**. Final combination: **8 passed**.
- Focused consumer/source/combination/Antigravity suite: **69 passed, 0 failed, 0 skipped**. The same 69 tests passed separately in all seven CI timezones: Asia/Ho_Chi_Minh, Asia/Kathmandu, Pacific/Chatham, America/Los_Angeles, Pacific/Honolulu, Pacific/Pago_Pago, Pacific/Kiritimati. These are repeat runs, not 483 distinct tests.
- Existing model-speed history/source/list/range/candidate tests, shared history and focused consumer/source tests together: **156 passed, 0 failed, 0 skipped** (overlaps the 69-test subset).
- Hub build registry tests: **13 passed**. Worker copies regenerated with `npm run update:hub-build`; `git diff --check` and standalone `npm run lint` passed.
- **Full `npm run verify` not accepted as completed.** Automatic approval review rejected continuation of the command because it detected network access to `openrouter.ai` and could not establish authorization for the transmitted payload. This review did not bypass that rejection or claim a full-suite result. Safe focused checks above were completed separately.

## Release and historical boundaries

The vendor manifest is byte-for-byte unchanged from #970: source `d5e8ad9b25bfafb43b5b6804940929b728a6f48a`, release `token-monitor-d5e8ad9b`. #972 separately declares its published `85c5de8e` baseline; neither is the new producer candidate. No vendor binary publication, pin update, PR merge, app installation, account capture, or native Electron UI acceptance was performed here.

Missing new producer fields continue to use the documented legacy approximation. Old persisted aggregate samples cannot be retrospectively corrected without message-level evidence and remain old measurements; they must not be described as newly verified exact rates. A downward correction can temporarily suppress history sampling until counters pass the retained high-water anchor. Source and period consistency are demonstrated with synthetic paired evidence, not with released all-platform producer binaries. The remaining release gates in #972 and producer #9 still apply.

Sources: [App #970](https://github.com/Javis603/token-monitor/pull/970), [App #972](https://github.com/Javis603/token-monitor/pull/972), [producer #9](https://github.com/Javis603/tokscale/pull/9), [merged reasoning prerequisite #957](https://github.com/Javis603/token-monitor/pull/957).
