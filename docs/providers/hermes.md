---
summary: "Hermes Agent session metadata: subagent parent links and last activity from state.db, and the per-device grouping preference."
ids: [hermes]
read_when:
  - Changing Hermes session parent links, last activity, or the state.db roots they are read from
  - Changing the hermesMergeSubagents setting or how Hermes subagents group
---

# Hermes Agent

## Subagent parent links

Tokscale reads Hermes usage from `state.db` without parent links. The session-metadata resolver (`src/shared/providers/hermes/sessionMetadata.js`) joins by session id against the `sessions` table of every database the scan reads: the Hermes home from `resolveHermesHome()`, each `profiles/<name>/state.db`, and every `state.db` at any depth below `customScanPaths.hermes` roots and inherited `hermes:` `TOKSCALE_EXTRA_DIRS` entries, which Tokscale reads the same way. A scoped WSL home ignores the host `HERMES_HOME`, `LOCALAPPDATA` and those extra roots.

Only rows with `source = 'subagent'` expose `parent_session_id` as a grouping link; that is how `delegate_task` children are recorded. A context-compression continuation carries `parent_session_id` too but keeps its parent's `source`, so it stays its own row. A schema without `source` or `parent_session_id` gives no grouping and answers nothing, so it cannot shadow a profile database that has the columns.

## Last activity

Tokscale gives each Hermes session a single timestamp, its first message, so its `lastUsedAt` never moves while the session runs and the running state (`sessionActivityState`) expires ten minutes after the session started. The same resolver reads `MAX(messages.timestamp)` (epoch seconds) for each session it answers and reports it as `lastUsedAt`, which `applySessionMetadata` only ever moves forward.

Databases open read-only. Answers are reused until the main file or WAL fingerprint changes, then every id is read again, since a running session's newest message moves with each write; an id the database does not hold, including every id of an unsupported schema, is retried the same way. Missing or unreadable databases add no metadata and must not fail collection.

## Grouping preference

`hermesMergeSubagents` (default on, under Settings → Collection → Hermes Agent) only decides whether Hermes subagents fold under their parent: off makes `separateSubagentClients()` (in `sessionRows.js`) pass `subagents.separateClients` to `groupSessionRows`, and each subagent stays a row of its own with its subagent label. Sessions and Home take it from renderer settings; the main-process Edge Dock and Notch cells receive it through `edgeDockCellsFor()`. The parent link is always collected and sent on the wire, so the setting needs no recollection and other devices group by their own preference.

## Verification

```bash
node --test tests/shared/hermesSessionMetadata.test.js tests/electron/sessionRows.test.js tests/electron/codexDotsSettings.test.js
```

Tests cannot cover a real Hermes install: `npm run agent:once -- --dry-run --clients hermes` should show `parentSessionId` on every `source = 'subagent'` session and, for a session Hermes is still writing, a `lastUsedAt` seconds old rather than its `startedAt`; in the app the parent's group row should split into separate rows when the toggle is turned off.
