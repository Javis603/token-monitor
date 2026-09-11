---
summary: "Hermes Agent usage: SQLite state.db timestamps, compact session ids, and Windows WAL live refresh."
read_when:
  - Changing Hermes source detection, watches, or session timestamps
  - Debugging missing Hermes Desktop usage on Today / live rate
---

# Hermes Agent

Hermes is a regular Tokscale client (`hermes`). Token counts come from Tokscale reading `state.db`; Token Monitor only dates those rows and keeps the live watch from going silent.

## Source

Default home is `~/.hermes` when `state.db` exists there. On Windows a native Desktop install often uses `%LOCALAPPDATA%\hermes` instead (the two paths may be the same directory via a junction). `HERMES_HOME` wins when set. Profile databases under `profiles/*/state.db` are scanned the same way.

Do not recursively watch the whole Hermes home: the Desktop runtime (`hermes-agent/node_modules`, venv, logs, cache) is large enough to peg CPU (issue #38). The watcher stays on the home directory and ignores everything except `state.db`, `state.db-wal`, and `state.db-shm`.

## Live refresh

SQLite WAL writes on Windows are often mmap updates that never surface as chokidar events, so a Desktop session that started after the last full scan can sit at zero until the hourly full tick. The collector therefore stats the db family every 2s and treats a size/mtime change as a targeted Hermes `--today` watch tick. That poll is bounded to three filenames per Hermes home / profile; it is not a recursive tree poll.

## Session timestamps

Hermes session ids look like `20260911_115516_2cedb0` (local wall time, not ISO). Tokscale JSON for Hermes has no `startedAt` / `lastUsedAt`, so the generic id parser used to leave those fields empty and then freeze the row in `resolvedSessionKeys`.

`providers/hermes/session.js` reads `sessions.started_at` and `sessions.last_activity_at` (Unix epoch seconds) from `state.db`, the same pattern OpenCode uses for `opencode.db`. Compact ids remain a fallback when sqlite is unavailable. Hermes rows are never frozen in `resolvedSessionKeys`, because Desktop keeps `last_activity_at` moving while the chat is open.

This does **not** re-attribute a multi-day session's lifetime tokens onto Today. Tokscale still keys `--today` on session start (`junhoyeo/tokscale#993` / Token Monitor #230). A session that began today, including Hermes Desktop, is what the poll + timestamps are for.

## WSL

As with other SQLite clients, if Windows cannot read a live `state.db` over the WSL share, run the headless agent inside WSL and sync through a hub.
