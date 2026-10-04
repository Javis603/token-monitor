# Codex usage: macOS deployment acceptance

Checked on 2026-10-05 (Asia/Shanghai), Node.js v25.9.0. The deployed runtime is the clean source commit `4f99af865baeec626bddf2874e320bb3adbc61e8`; the package records SHA-256 hashes for its 16 source files. It uses the installed Node runtime and has no node_modules or copied credentials.

## Deployment

The isolated test app is `~/Applications/Token Monitor Usage Test.app`. Its separate report/settings directory is `~/Library/Application Support/Token Monitor Usage Test/`. It was launched through macOS Launch Services, not only by calling a source-checkout script. The app exited successfully after producing a service report and requesting the default browser to open it. The first selected five-thread report took about 96 seconds; batch service latency remains a practical limitation.

The companion local-report launcher was executed from the packaged app. Its output was independently reconciled against 23 unique request records belonging to a real parent/child pair. Two of the five known threads had measured usage; the other three stayed unknown. No account-wide total or cloud-origin inference was made from these local logs.

## Actual service results

The normal deployed/service entry point returned a numeric account lifetime total and daily data using the existing Codex authentication. Two real refresh rounds completed, with different observation timestamps; the unchanged account value was replaced, not accumulated. Graceful termination completed with exit 0, wrote `stopped`, and left no running watch process.

A real two-thread direct read and a five-thread ancestry read completed without response diagnostics. All sampled per-thread `threadUsage` values were unavailable/null. Thus account service access and actual thread metadata discovery are verified; service token breakdowns and full hosted-cloud/dot task attribution are not. Missing counters remain unknown, not zero. Raw account totals, thread IDs and private report paths are retained only in local test evidence outside the repository.

## Runtime issue found and corrected

A delayed `account/updated` notification arrived after initialize. The old sticky boolean invalidated every subsequent observation on that connection. The corrected transport increments an account revision. Any revision change invalidates the entire batch; the CLI discards all values and recollects once on that same connection. A second update still fails closed. A regression first failed, then passed. This is not suppression of account notifications or reuse of earlier-account data.

## Verification

| Check | Outcome |
| --- | --- |
| Combined usage and desktop installer/launcher tests | 87 passed, zero failed/skipped |
| `npm run verify` | Lint passed; 5,795 passed, 2 skipped, zero failed |
| `npm run update:hub-build` | Registry current, generated closure unchanged |
| Packaged-source integrity | All 16 deployment hashes match |
| macOS bundle metadata and native launch | Plist valid; native app launch generated report, exit 0 |
| Independent local request reconciliation | Exact agreement for both measured threads |
| Real serial refresh and stop | Two successful rounds; final `stopped`; process exited |
| Visual report inspection | Local and service HTML rendered and inspected; unknown values and scope warnings visible |
| Production protection | Installed Token Monitor 0.65.0 app metadata/app.asar and Codex global config hashes unchanged |

The first temporary headless-browser capture produced its image but did not exit within the harness deadline; it was terminated and no profile-specific process remained. The service capture used a bounded, owned process group and exited after capture. No user browser profile was used for headless rendering.

## Remaining boundaries

This is a parallel test application, not an upgrade to the production widget or integration into its main dashboard. It installs no autostart service and starts no model task. The true hosted task/dot to engine-thread join, per-thread service token availability, and whether any future parent estimate includes children still require evidence. No complete cloud/dot total or summed service parent/child total is claimed.
