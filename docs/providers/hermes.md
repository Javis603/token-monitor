---
summary: "Hermes Agent session metadata: subagent parent links from state.db and the per-device grouping preference."
ids: [hermes]
read_when:
  - Changing Hermes session parent links or the state.db roots they are read from
  - Changing the hermesMergeSubagents setting or how Hermes subagents group
---

# Hermes Agent

## Subagent parent links

Tokscale reads Hermes usage from `state.db` without parent links. The session-metadata resolver (`src/shared/providers/hermes/sessionMetadata.js`) joins by session id against the `sessions` table of every database the scan reads: the Hermes home from `resolveHermesHome()` plus each `profiles/<name>/state.db`. A scoped WSL home ignores the host `HERMES_HOME` and `LOCALAPPDATA`.

Only rows with `source = 'subagent'` expose `parent_session_id` as a grouping link; that is how `delegate_task` children are recorded. A context-compression continuation carries `parent_session_id` too but keeps its parent's `source`, so it stays its own row. A schema without `source` or `parent_session_id` infers no relationship.

Databases open read-only. A found row is cached for the process because its link never changes; an id the database does not hold yet is retried once the main file or WAL fingerprint changes. Missing or unreadable databases add no metadata and must not fail collection.

## Grouping preference

`hermesMergeSubagents` (default on, under Settings → Collection → Hermes Agent) only decides whether the renderer folds Hermes subagents under their parent: off passes `subagents.separateClients` to `groupSessionRows`, and each subagent stays a row of its own with its subagent label. The parent link is always collected and sent on the wire, so the setting needs no recollection and other devices group by their own preference.
