# Hosted-cloud turn usage (PlanMeter-compatible)

This opt-in source connects to the hosted cloud engine rather than querying remote IDs through the local app-server. It does not replace the local ledger, account summary reader, or production Token Monitor collector. The implementation follows the protocol approach in [PlanMeter](https://github.com/avatarneil/planmeter/tree/6052afd053f2f5b69e3655eaaf8a1c497c08c78f), specifically `CodexCloudUsage.swift` and `CodexThreadUsage.swift`. Its MIT copyright and license are preserved in [planmeter.txt](licenses/planmeter.txt). These are internal desktop contracts, not a stable public API or a guarantee of subscription entitlement.

## Run

```sh
npm run codex:usage -- --cloud --help
npm run codex:usage:cloud -- --thread ENGINE_THREAD_ID --quotas --output-dir NEW_DIRECTORY
```

`--cloud` and `--live` are mutually exclusive. `--cloud` reads hosted thread/turn history, while `--live` retains the older account/local-app-server view. A cloud task card ID is not assumed to be an engine thread UUID. Without explicit IDs, `--discover` requests a bounded hosted catalog. `--descendants` adds only already known account-matched cached relationships and marks discovery partial. `--quotas` is separately opt-in. No process is installed in the background and no model task is started.

Default limits are 40 threads, 1,000 turns, three pages per list and a 90-second total connection budget. CLI maxima are 100 threads, 3,000 turns, 20 pages and 180 seconds. Each response is limited to 4 MB and the WebSocket parser has bounded frame/fragment sizes. The output directory must be new; JSON and HTML are private local files. The static HTML has no scripts, external resources or telemetry. Existing directories are never overwritten.

## Source and identity

The WebSocket uses the fixed hosted Codex origin and the same credential/subprotocol form as PlanMeter. Only initialize, thread listing, metadata reads and paginated turn listing are allowed. `thread/read` always disables turns; `thread/turns/list` always specifies `itemsView: notLoaded`. No thread start/resume/subscribe, model turn, permission grant or configuration write is permitted. Unexpected server-side requests are rejected.

The two HTTP query families are a turn-estimate query and a separate consumer quota query. They only target the fixed official ChatGPT origin with redirects disabled. They do not call the previously blocked `/tbo` directory route. No browser cookies, admin key, alternate account or login refresh is requested. Existing authentication is read in memory through the repository's Codex helper; it is never copied to reports, fixtures, logs or the test package. Account/user and the authentication file hash are checked throughout the observation. A login change invalidates the result.

The optional desktop seed must match both account and user and name the durable host. Cached text/title/preview is excluded. Dot attachment parent and native engine parent are separate fields; a null engine parent does not establish that a task was not delegated. The cache is a limited membership hint, not full live cloud coverage. Profiles with no safe explicit ID remain unknown rather than guessed.

## Discovery and accounting

Catalog discovery unions unfiltered and explicitly source-filtered queries for active and archived threads: PlanMeter documents that null-source aeon rows can be omitted by the explicit source filter. All lists are cursor-checked and bounded. A repeated cursor, unreadable page, exhausted budget or changing history remains visible as incomplete coverage.

A turn is identified by `(threadId, turnId)`, never title, model or date. The per-turn query contains at most 100 requested turns and rejects unrelated identities in the response. Missing counters remain null; explicit zero is retained. Cached input is a subset of input; total is checked against input plus output when the fields exist. Fractional, negative, boolean, string and unsafe-integer token values are rejected. Available counters from this service remain labeled service estimates, not a verified bill.

Service estimated USD/credit micros are separate from token counters. Consumer five-hour/weekly percentages and purchased-credit consumption are separate again. The real service returned scientific-notation credit text such as `0E-10`; the parser accepts a finite decimal/scientific numeric form and retains its original text. It never converts allowance percentages or credits into token counts.

The observed token aggregate requires nonoverlapping settled-response identities. A positive aggregate without settlement IDs is shown on its turn but excluded from the deduplicated sum. Overlapping response IDs across turn aggregates exclude the affected aggregates because there is no justified prorating rule. Incomplete history never yields a complete task total. This source is never added to local Tokscale totals, the local request ledger, or overlapping account/day summaries.

Dates use a turn's completion time, falling back to start only when completion is absent. An undated turn stays undated. These are not individual response timestamps. Re-running a report creates a new snapshot; it does not add an earlier snapshot again.

## Permission and failure behavior

A forbidden turn-estimate response preserves successfully fetched thread/turn metadata but leaves token and cost fields unknown. The collector stops further estimate batches instead of retrying a denied route. A separately authorized quota query may still return its different measurement. Authentication failures or rate limits stop the optional quota request too. Failed cloud connection is unavailable, never a zero-usage success.

Undici emits an error when cancelling some unread HTTP response bodies. A real first run exposed an uncaught cancellation error; the adapter now attaches its error sink before cancellation and returns the sanitized HTTP status. A regression reproduces the old failure. No raw response body or credential-bearing error is emitted.

## Verification and real-account boundary

```sh
node --test tests/shared/codexCloudUsage.test.js tests/scripts/codexCloudUsage.test.js
npm run verify
```

The new source has synthetic protocol, identity, pagination, permissions, privacy, arithmetic, settlement deduplication and CLI tests. The original entry point dispatch and macOS source dependency closure are covered by the repository suite. Full validation on Node v25.9.0 passed lint and 5,840 tests with two skips and no failures (5,842 total).

On 2026-10-05 Asia/Shanghai, a real hosted `aeon_child` was read through the hosted WebSocket. Its two completed turns were returned with exact thread/turn identities and dates, plus a matching-account cached delegation parent. The per-turn token/price query returned HTTP 403. The separate quota query returned a weekly allowance percentage, unavailable five-hour percentage, scientific-notation zero purchased-credit usage, and a partial data status. Exact private IDs/values and HTML reports remain in local task-notes, not the repository.

This establishes actual cloud history and a separate allowance measurement for the sampled task; it does not establish token entitlement for this login, full cloud/dot coverage or a complete cloud token total. The plan name alone is not used to generalize this result to all users. No forbidden response was defeated by a different account, endpoint or credential source. An independent offline review dispatch was platform-blocked and was not retried or counted as a completed review.

## Parallel test application

The existing test launcher accepts `--cloud --thread ENGINE_THREAD_ID`; explicit cloud IDs are required, and cloud/local modes cannot be mixed. A cloud launcher runs the packaged cloud source once, writes a private report and opens the HTML. The production Token Monitor remains unchanged.

Packaging reuses the repository's installed Undici runtime (already a dependency) rather than downloading new tooling. It validates that runtime's package name, dependency-free graph and license, copies its files and preserves the PlanMeter notice. An isolated test-app upgrade must validate the previous deployment's hashes and keep a backup before copying the changed source; credentials, settings and private reports are not bundled.
