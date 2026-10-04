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

## Unverified / blocked

A real account, catalog and parent/child usage probe was blocked by platform safety checking. That operation was not retried through another tool, alternate executable, private endpoint or delegated agent. No new model turn or hosted task was started for telemetry.

The successful stdio/CLI tests use `tests/fixtures/codexUsageRpc.cjs`, a synthetic peer, not the real account. They do not establish access to the user's hosted cloud tasks or dot-delegated tasks. A real task-to-engine-thread mapping, actual service response and parent-versus-descendant coverage reconciliation are still missing. `accountCloudCoverage` remains unknown and service estimates remain separate from measured local usage. No combined parent/child task total is claimed.

## Deployment state

The source checkout is integrated and verified. The installed Token Monitor app, public GitHub branch and any background service are unchanged. Usage CLI instructions and resource/privacy limits are in [the live reader guide](codex-live-usage.md) and [the local ledger guide](codex-task-usage.md).
