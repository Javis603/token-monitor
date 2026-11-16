---
summary: "Kiro local usage sources, bounded native session watching and the legacy globalStorage interval boundary."
ids: [kiro]
read_when:
  - Changing Kiro source discovery, live watching or refresh latency
  - Investigating Kiro checkpoint/index trees consuming watcher or scan resources
---

# Kiro local usage

Tokscale owns usage parsing. Kiro transcript counts are estimates from recorded text, not measured API token counters. The collector keeps the same client partition for IDE and CLI sources.

## Watch and scan boundaries

The built-in IDE globalStorage root is `Kiro/User/globalStorage/kiro.kiroagent` under the platform's application-data directory. It contains legacy chat snapshots, execution records, workspace session JSON, indexes and project-file checkpoints.

This root remains **interval/manual collection only**. Although its conversation and checkpoint lanes can be distinguished, the bundled Tokscale scanner still recursively traverses the complete globalStorage tree on each Kiro scan. Narrowing the watcher alone does not narrow that scan. Do not restore event-triggered collection for this source on watcher tests alone; scanner traversal and large-tree costs need separate validation.

The separate `~/.kiro/sessions` root retains live updates for CLI JSON headers and JSONL streams under `cli/`, plus IDE `session.json` and `messages.jsonl` directly inside `sess_*` directories. Discovery remains recursive, matching the scanner rather than requiring a fixed workspace depth. New workspaces and sessions appear without restarting. Per-session `snapshots/` contains project-file copies and is pruned before the watcher descends into it. Kiro CLI's SQLite roots retain database/WAL events, with scan-generated SHM events filtered by the common collector policy.

Tokscale scans `cli/` as a separate root, so its root directory link remains supported. Interior directory links are not followed, even when their names resemble source files. Source-file links and source unlink events remain observable.

A watch event can restrict collection to the Kiro client and Today; it does not pass an individual changed file to Tokscale. Existing native-session or CLI triggers may therefore still incur the scanner's legacy globalStorage traversal cost when that legacy tree exists.

Full and manual Tokscale scans remain recursive and unchanged. Non-standard files outside the built-in live layout are still collected by those scans. Explicit custom scan roots retain the common recursive custom-root policy.

When roots overlap, retain the union of source paths in the shared watcher, but attribute each event through the owning client's own policy. Another tool's exporter inside a Kiro directory must not turn its unrelated writes into Kiro scans.

## Storage provenance

Storage boundaries were checked against the JavaScript bundled in official Kiro IDE **0.11.131** and **1.4.154** Linux releases from the [official download service](https://kiro.dev/downloads/ide/). Both use the first 32 SHA-256 hex digits for legacy workspace paths and storage keys. Execution records use `KIRO::EXECUTION::SAVES`, while project-file snapshots use `KIRO::CHECKPOINTER::FS` in a different sibling bucket. Legacy histories also live under `workspace-sessions/<encoded-workspace>/*.json` and `sessions/*.json`.

The older bundle's `StorageManager` and `ExecutionLogController` write these paths; the newer bundle's legacy `ExecutionStore` and `CheckpointStore` read them for migration. The newer `SessionPersistence` writes IDE message streams and snapshots separately under `~/.kiro/sessions`.

This is inspection of distributed application code, not a claim that Kiro's IDE source is open. The AWS sample's [session-log investigation](https://github.com/aws-samples/sample-kiro-coding-metrics-collector/blob/main/kiro-plugin/docs/kiro-session-log-investigation-v2.md) independently records the workspace-session and execution lanes. Match any future layout change against the writer and the pinned Tokscale reader before widening the watcher.
