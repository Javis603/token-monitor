# Codex usage integration: verification record

## Scope

Source baseline: `189d54da7c74ebc605530f505185df9d7b4c3363`. The change joins the local task-usage CLI and a separate opt-in account/thread service reader. It does not modify the installed Electron app, the existing Tokscale collector, account authentication, global model routing or hosted tasks.

## Verified in the source checkout

Runtime: macOS, Node.js `v25.9.0`.

| Check | Result |
| --- | --- |
| Combined local-ledger and live-adapter targeted suite | 77 passed, 0 failed, 0 skipped |
| `npm run verify` | Exit 0; lint passed; 5,785 tests passed, 2 skipped, 0 failed, 5,787 total |
| `npm run update:hub-build` | Registry already current; Worker closure synchronized without generated-file drift |
| `git diff --check` | Passed before the verification record was added |
| Existing `codex:usage -- --live` dispatcher | Tested end to end through a synthetic subprocess, without reading local account logs |
| Live response privacy and error handling | Synthetic tests verify projections, rejected approvals, error redaction, unavailable versus zero, and private report files |

Three new regressions were first observed failing, then fixed and rerun: explicit roots now scope ancestry discovery instead of losing children when unrelated catalog entries consume the budget; declared missing parents remain represented; a failed new connection does not expose the previous account report body. An inherited test's unnecessary template-literal escaping was corrected for lint without changing fixture bytes.

## Device acceptance update

The subsequent explicit real-device deployment request was exercised through the normal entry point. Actual account usage and thread metadata reads succeeded; all sampled per-thread token reports remained unavailable. A delayed account notification exposed and led to a whole-observation resampling fix. See [device deployment acceptance](codex-usage-device-validation.md) for verified scope, tests, timings and remaining hosted-cloud/dot gaps.

## Deployment state

A separate `Token Monitor Usage Test.app` is installed under `~/Applications`, with private reports/settings outside the production widget. The installed Token Monitor 0.65.0 application and Codex global configuration are unchanged by hash comparison. No GitHub push or startup service was created. Source and package verification are not a claim of full cloud/dot token coverage.
