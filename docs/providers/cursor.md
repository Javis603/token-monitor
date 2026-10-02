---
summary: "Cursor usage is account-level by default; an opt-in device mode records Agent stop hooks into a machine-local jsonl so Hub ingest no longer sums the same account CSV on every device."
ids: [cursor]
read_when:
  - Changing Cursor account discovery, login/logout/sync or local credential storage
  - Changing Cursor tokscale self-sync, cache events or legacy-session replacement
  - Changing Cursor usage-summary, Grok Bot, team pool or on-demand limits mapping
  - Changing Cursor token collection, tokscale cursor sync, or Agent hooks
  - Debugging duplicate Cursor usage across devices on a Hub
---

# Cursor

Cursor has one Token Monitor-managed account list used by both tokscale self-sync and dashboard limits. Limits identity and local token history still remain separate outputs.

Cursor token history has two sources. Account mode is the default. Device mode is opt-in and replaces the account CSV for that machine.

| Data plane | What it measures | Default source | Opt-in alternative |
| --- | --- | --- | --- |
| Token/session activity | Local model-token activity attributed to Cursor | `tokscale cursor sync` account CSV at `~/.config/tokscale/cursor-cache/` | `cursorUsageSource=device`: Cursor Agent `stop` / `subagentStop` hooks → machine-local jsonl |
| Limits/quota | Remaining Cursor account quota | Desktop session / manual cookie | None — limits stay account-scoped in both usage modes |

A Hub already stores one record per device. The duplicate-count bug is collection, not ingest: the default CSV is account-wide, so two machines posting Cursor both report the same totals and `aggregateDevices` sums them.

## Accounts and lifecycle

The credential store tracks multiple Cursor accounts and one active account. Desktop discovery can import the local access token without triggering a usage sync. Manually added session tokens and local access-token JWTs are normalized into the canonical form before storage.

Login, logout and sync share one lifecycle lane. This prevents an explicit account operation from racing the collector's background sync. Aborted queued work leaves promptly; a failed operation does not poison the lane. Tokscale subprocess timeouts and aborts request termination and wait for the shared close/forced-termination barrier.

Only accounts added manually by Token Monitor may be removed from its UI. Desktop discovery remains ambient ownership.

## Self-sync and sessions

Cursor is self-synced in account mode: the collector supplies its one `SelfSyncThrottle` and tokscale resolver to `createCursorSelfSync()`. A credential change forces one targeted Cursor usage sync but does not restart the usage runtime.

`PARSE_LOCAL_CLIENTS` must not include `cursor`. Catalog identity stays account-level. Device mode is a runtime-local adapter only.

Cursor's old CSV usage names Auto as `auto`; its JSON usage events name the same mode `default`. Token Monitor groups both under `cursor-auto` in usage, History graph, old device periods, and archived session/client/day replay. Keep this mapping scoped to Cursor because other clients may use `default` for a different model. A persisted Cursor collector anchor from before this mapping must be rescanned once so its broader periods cannot mix old and new model keys.

The generated tokscale Cursor cache is not watched because Token Monitor's own sync writes it. `usageEvents.js` indexes live and archived cache events by account and conversation, invalidating only changed files. `sessionGuard.js` uses that index to retire legacy synthetic event ids when a canonical session supersedes them; ambiguous events do not guess.

The usage events carry conversation ids but no names. Session titles come from the local Cursor desktop `composerHeaders` table, joined by conversation id; releases predating that table are read through the legacy `composer.composerHeaders` key instead. The reader opens the database read-only, queries only the requested ids, and refreshes its title cache when the database or WAL changes. Sessions without a local header retain the normal client/model fallback.

## Device mode

Opt in with `TOKEN_MONITOR_CURSOR_USAGE_SOURCE=device`, `--cursor-usage-source device`, or Settings → Cursor. Then:

1. `startCollector` copies `src/shared/providers/cursor/deviceHook.js` into `~/.cursor/hooks/` and registers `stop` / `subagentStop` without dropping unrelated hook commands. The copy is Node-builtin-only and fail-open (`{}` on stdout).
2. Records append to `<sharedDataDir>/cursor-device/usage.jsonl` (override with `TOKEN_MONITOR_CURSOR_DEVICE_LOG`).
3. Collection treats Cursor as a runtime-local adapter: no tokscale `--client cursor`, no cursor self-sync, health `collection.state` is `direct`.
4. The jsonl directory is watched. The tokscale cache is not, so the issue #15 self-trigger loop does not return.
5. Inclusive `input_tokens` is split so cache read/write is not double-counted by `tokenValue()`.
6. Cloud Agent usage is not recorded. Limits stay account-scoped.

Switching back to account mode uninstalls only our hook marker. Widget and agent pass `manageCursorDeviceHook: true`; tests must not, so they cannot rewrite `~/.cursor/hooks.json`.

Project identity is still hashed from a decoded path by `projectIdentity()`. Device-mode rows may carry a workspace folder name from the hook payload; that is a label, not an id.

## Limits

Every enabled saved account is probed independently. Stable identity prefers the canonical API subject; opaque local fallback ids remain distinct rather than merging unrelated accounts. API email is presentation metadata, not the only identity key.

The dashboard mapping preserves separate official model pools, legacy request plans, enterprise/team pooled usage, optional Grok Bot allowance and on-demand spend. Never synthesize an overall total by summing model pools. Grok Bot is best effort and must not fail the main account row. A zero uncapped spend is hidden; positive uncapped spend remains visible.

Account-scoped enable/disable affects limits collection only. The active tokscale account and self-synced history are managed by the explicit Cursor lifecycle operations. Cursor limits continue to collapse by account, not by device.

## Verification

Run the Cursor account, self-sync, cache-event, device-mode and limits tests when changing this note's scope:

```bash
node --test tests/shared/cursor*.test.js tests/electron/cursorSettingsLayout.test.js
```
