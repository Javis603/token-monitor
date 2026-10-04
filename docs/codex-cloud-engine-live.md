# Cloud engine token events: real-time capture

This standalone experimental entry reads actual `thread/tokenUsage/updated` events from the hosted Codex engine. It is separate from the existing cloud turn-estimate/credits reader: the current login's billing endpoint returned 403, but the running engine delivered token counts. No fee-to-token, quota-to-token or account-minus-local conversion is used.

## Actual validation on 2026-10-05 Asia/Shanghai

Two isolated cloud tests completed with actual model execution. They were not local mock servers or pre-recorded fixtures.

The first used a newly created ephemeral cloud thread and one short reply. The cloud event reported input, output, cached input, reasoning output and cumulative total; input plus output matched total, and because there was one request the last-request and cumulative breakdowns matched.

The second used two separate authenticated WebSocket connections. One created a new isolated verification thread and submitted one short reply; the other attached using `CloudEngineUsage` before that reply started. The execution connection and the independent observer received identical token breakdowns for the same thread/turn. The observer's own audit recorded zero model-turn starts, zero estimate queries and zero quota queries. The verification thread completed and was archived. All test connections exited.

These tests establish that a separate observer can receive actual token counts while a hosted task executes. They do not establish retrospective retrieval for an idle finished task, per-request persistence of all historical events, full account/dot coverage, or whether a parent's reported total includes a child. The two short verification replies consumed real subscription usage; the test results are not the user's existing project totals.

Exact private identities, numeric counters and transport receipts remain outside the repository in the existing task-notes directory. They are not copied into fixtures. `cloud-live-single-turn-test.json` records the first test; `cloud-separate-observer-acceptance.json` records execution-versus-observer comparison. The latter's `matched` flag compares every normalized counter, not only the total.

## Standalone command

```sh
node scripts/codex-cloud-engine-usage.js \
  --thread REAL_ENGINE_THREAD_UUID \
  --attach-existing-thread \
  --wait-seconds 60 \
  --events new-events.jsonl \
  --output new-report.json \
  --html new-report.html
```

Run it before or while the selected hosted task is executing. `--wait-seconds` is bounded to 1–120 seconds. The command attaches a viewer to the specified existing thread; it sends no `turn/start`, prompt, configuration override or permission grant. Viewer attachment can nevertheless load an environment or initialize its MCP runtime, so this is not described as a completely side-effect-free metadata read. User-interrupting the observation never interrupts the actual model task.

The input UUID is the actual cloud engine thread ID, not a guessed dot profile or task card ID. Captured events are filtered by exact thread and turn identity. No other thread's event is silently folded into the result. The observer attempts `thread/unsubscribe` and closes its socket; tested hosted responses required the disconnect fallback. It does not invoke thread stop/archive on an existing user task.

Output paths must be new and distinct after canonical parent-path resolution; existing files, dangling symlinks and parent aliases are rejected before connecting. Valid numeric events are persisted as private NDJSON as soon as they arrive; each event includes an opaque account-scope fingerprint, and the final private JSON and optional static HTML contain only allowlisted counts/identifiers, provenance and lifecycle state. The current login is checked before every accepted event reaches persistence, not only when the observation ends. A write failure stops observation rather than silently dropping subsequent counts. Conversation text, prompts, tool arguments and authentication material are not retained. Ctrl+C ends this observation; it is not a background service or autostart installation.

The standalone source is in the repository. The previously installed parallel test app has not been upgraded with this new entry, and the production Token Monitor is unchanged. Use the direct script above, not the older `--cloud` fee/turn-history mode, for the new live-event recorder.

## Counting and failure rules

`cloudLiveMeter.js` stores the latest valid engine cumulative snapshot. The observation callback and exported reports receive independent counter objects, so caller mutation cannot corrupt retained counts. Successive totals are never added together. Consecutive identical notifications are ignored. A later lower counter, invalid arithmetic, unsafe integer or last-request count greater than the cumulative value makes the aggregate ambiguous rather than silently retaining a plausible number. An earlier equal snapshot after a higher one is a decrease, not a duplicate to suppress.

Cached input is included in input; reasoning output is included in output. Missing optional breakdowns remain null; an explicit zero is distinct from no notification. A turn ID attached to a snapshot does not turn a lifetime cumulative count into that turn's own usage. No task-tree sum or daily allocation is synthesized.

In a long observation, sample retention is bounded but the latest counter remains available. Truncated event history is explicit. A saved snapshot is not a billing statement or proof that every request was observed. Do not add it to existing local Tokscale totals or another overlapping service view.

## Historical replay investigation

The public Codex implementation at commit `de3721a7be07054c8c2a41102b5a501f34155361` contains a [token replay module](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/app-server/src/request_processors/token_usage_replay.rs). Its [thread processor](https://github.com/openai/codex/blob/de3721a7be07054c8c2a41102b5a501f34155361/codex-rs/app-server/src/request_processors/thread_processor.rs) gates restored-usage attribution on `include_turns || paginated_resume`. This explains a possible limitation of the legacy-history cheap `excludeTurns` path, not proof that every hosted backend implements the same replay behavior.

In this session, metadata-only attachment to a cloud aeon child, a coding thread and a dot root produced no token replay. A goal-meter read found no goal counter for the sampled child/root. The attempted history-enabled replay verification was platform-blocked and was not executed or retried. The production observer therefore retains the cheaper `excludeTurns: true` attachment and relies on live token notifications, not unverified backfill. No denied billing route was bypassed.

## Verification scope

```sh
node --test tests/shared/codexCloudLiveMeter.test.js tests/scripts/codexCloudEngineSafety.test.js
node --check src/shared/providers/codex/cloudLiveMeter.js
node --check src/shared/providers/codex/cloudEngineUsage.js
node --check scripts/codex-cloud-engine-usage.js
node scripts/codex-cloud-engine-usage.js --help
```

The focused ledger and safety suite now has 29 passing tests. Its coverage includes: cumulative replacement, duplicate notifications, foreign-thread and text rejection, invalid counters, counter decreases, sample bounds, subset arithmetic, missing-versus-zero, and static HTML escaping. The live two-connection experiment additionally exercised the actual observer transport/lifecycle against a real new hosted task. The follow-up independently ran the complete repository verification: lint passed; 5,869 tests passed, two skipped, zero failed (5,871 total). A mutation regression was first reproduced failing, then fixed. The saved real two-connection sample was reprocessed offline and still matched its original counters; this is not a newly measured cloud run. No completed independent agent review is claimed.


## Follow-up deployment boundary

The proposed multi-thread automatic-archive store write was blocked by the tool safety check before execution. It was not retried through another tool or encoding and no alternative persistent collector was installed. Automatic live-task discovery, reconnection checkpoints, and desktop integration remain pending; they must not be inferred from the passing single-thread suite. The current source-only entry remains a bounded explicit-thread observation. This follow-up started no model turns and changed neither the installed parallel test app nor production Token Monitor.
