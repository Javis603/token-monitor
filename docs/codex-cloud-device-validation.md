# Hosted-cloud device acceptance

Checked on 2026-10-05 Asia/Shanghai. Deployed source: `932e1a468c490355ef65c92c828822cafe3b1d32`. This is an actual hosted-cloud read from the installed parallel test app, not a synthetic peer, account-level proxy or local transcript replay.

## Result

One real cloud `aeon_child` yielded two completed turns through the cloud WebSocket, with exact thread/turn identities and completion dates. The selected thread's turn history was complete within this sample; this is not full account inventory. Account-and-user-matched cached metadata supplied its delegation parent. The distinct dot profile identifier remained unknown.

The per-turn token/price query returned service HTTP 403. Both token fields remained null, the token total stayed unknown, and the report was explicitly partial. This failure was a service response, not a platform tool-check block. No other account or route was used to defeat it.

The separate consumer quota query succeeded. It reported a weekly allowance percentage, a null five-hour percentage, scientific-notation zero purchased-credit use, `included_plan` source and partial data status. Raw private identifiers and exact values remain in task-notes and the user's report, not the public repository. These allowance/credit metrics were not converted into token counts.

The installed-launcher run used three WebSocket RPC requests (including initialize), one turn-estimate query, one quota query, and zero model-turn starts. It completed with exit code 0 because the partial metadata/allowance report was successfully generated; exit 0 is not a claim that every measurement was available. The generated HTML was rendered and visually inspected, then opened on the Mac.

## Code and deployment verification

The new cloud suite passed 44 tests, and the full repository verification passed lint plus 5,840 tests with two skips, zero failures. It covers exact identities, null-source catalog union, pagination, missing counters, settlement overlap, credential changes, fixed origins, redirect refusal, permission errors, scientific numeric strings, CLI dispatch and private output.

The first live attempt exposed an unread-response cancellation error from Undici. A focused failing regression was added and the HTTP adapter now installs an error handler before cancelling the body. The quota response's `0E-10` format exposed overly restrictive decimal parsing; finite scientific notation is now accepted without losing the original credit string.

The parallel `Token Monitor Usage Test.app` was upgraded after checking every old source hash and saving a complete backup. Its new package has 232 hash-verified source/runtime/license files. It contains the already installed Undici package and the PlanMeter MIT notice, but no copied credential, personal settings or report files. The companion `云端任务统计.command` invokes one explicit cloud sample. Existing local/account entry points and settings remain available.

The production Token Monitor application metadata and app.asar hashes match the earlier baseline. The Codex global config no longer matches that older baseline; this turn made no configuration writes and does not attribute, revert or certify that unrelated difference. No startup service, global route change, login refresh or new cloud/model task was created. The independent offline code-review tool invocation was blocked and is not counted as completed review.

## Remaining gate

Cloud history, exact turn identities, a cached delegation relationship and a separate allowance metric have passed real-device acceptance for this sample. Exact cloud token measurement has not: the current login's tested turn-estimate route returned forbidden. Full cloud/dot coverage and per-request event accounting remain unverified. The implementation preserves these distinctions rather than showing a fabricated zero or combining overlapping account/local totals.
