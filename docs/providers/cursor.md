---
summary: "Cursor usage is account-level by default; an opt-in device mode records Agent stop hooks into a machine-local jsonl so Hub ingest no longer sums the same account CSV on every device."
read_when:
  - Changing Cursor token collection, tokscale cursor sync, or Agent hooks
  - Debugging duplicate Cursor usage across devices on a Hub
  - Changing Cursor limits/quota collection or account identity
---

# Cursor provider

Cursor appears in two independent data planes. Keep them separate.

| Data plane | What it measures | Default source | Opt-in alternative |
| --- | --- | --- | --- |
| Token/session activity | Local model-token activity attributed to Cursor | `tokscale cursor sync` account CSV at `~/.config/tokscale/cursor-cache/` | `cursorUsageSource=device`: Cursor Agent `stop` / `subagentStop` hooks → machine-local jsonl |
| Limits/quota | Remaining Cursor account quota | Desktop session / manual cookie | None — limits stay account-scoped in both usage modes |

A Hub already stores one record per device. The duplicate-count bug is collection, not ingest: the default CSV is account-wide, so two machines posting Cursor both report the same totals and `aggregateDevices` sums them.

## Account mode (default)

`maybeSyncCursor()` runs `tokscale cursor sync` before a tokscale scan. The cache directory is a self-sync output and is not watched. Newly finished sessions can take a few minutes to reach Cursor's dashboard, so usage moves on sync rather than instantly.

`PARSE_LOCAL_CLIENTS` must not include `cursor`. Catalog identity stays account-level.

## Device mode

Opt in with `TOKEN_MONITOR_CURSOR_USAGE_SOURCE=device`, `--cursor-usage-source device`, or Settings → Cursor. Then:

1. `startCollector` copies `src/shared/providers/cursor/deviceHook.js` into `~/.cursor/hooks/` and registers `stop` / `subagentStop` without dropping unrelated hook commands. The copy is Node-builtin-only and fail-open (`{}` on stdout).
2. Records append to `<sharedDataDir>/cursor-device/usage.jsonl` (override with `TOKEN_MONITOR_CURSOR_DEVICE_LOG`).
3. Collection treats Cursor as a runtime-local adapter: no tokscale `--client cursor`, no cursor self-sync, health `collection.state` is `direct`.
4. The jsonl directory is watched. The tokscale cache is not, so the issue #15 self-trigger loop does not return.
5. Inclusive `input_tokens` is split so cache read/write is not double-counted by `tokenValue()`.
6. Cloud Agent usage is not recorded. Limits stay account-scoped.

Switching back to account mode uninstalls only our hook marker. Widget and agent pass `manageCursorDeviceHook: true`; tests must not, so they cannot rewrite `~/.cursor/hooks.json`.

## Identity and aggregation

Project identity is still hashed from a decoded path by `projectIdentity()`. Device-mode rows may carry a workspace folder name from the hook payload; that is a label, not an id. Cursor limits continue to collapse by account, not by device.
