---
summary: "Cursor provider notes: managed accounts, tokscale self-sync, cache-backed session repair and dashboard limits."
ids: [cursor]
read_when:
  - Changing Cursor account discovery, login/logout/sync or local credential storage
  - Changing Cursor tokscale self-sync, cache events or legacy-session replacement
  - Changing Cursor usage-summary, Grok Bot, team pool or on-demand limits mapping
---

# Cursor

Cursor has one Token Monitor-managed account list used by both tokscale self-sync and dashboard limits. Limits identity and local token history still remain separate outputs.

## Accounts and lifecycle

The credential store tracks multiple Cursor accounts and one active account. Desktop discovery can import the local access token without triggering a usage sync. Manually added session tokens and local access-token JWTs are normalized into the canonical form before storage.

Login, logout and sync share one lifecycle lane. This prevents an explicit account operation from racing the collector's background sync. Aborted queued work leaves promptly; a failed operation does not poison the lane. Tokscale subprocess timeouts and aborts request termination and wait for the shared close/forced-termination barrier.

Only accounts added manually by Token Monitor may be removed from its UI. Desktop discovery remains ambient ownership.

## Self-sync and sessions

Cursor is self-synced: the collector supplies its one `SelfSyncThrottle` and tokscale resolver to `createCursorSelfSync()`. A credential change forces one targeted Cursor usage sync but does not restart the usage runtime.

The generated tokscale Cursor cache is not watched because Token Monitor's own sync writes it. `usageEvents.js` indexes live and archived cache events by account and conversation, invalidating only changed files. `sessionGuard.js` uses that index to retire legacy synthetic event ids when a canonical session supersedes them; ambiguous events do not guess.

The usage events carry conversation ids but no names. Session titles come from the local Cursor desktop `composerHeaders` table, joined by conversation id; releases predating that table are read through the legacy `composer.composerHeaders` key instead. The reader opens the database read-only, queries only the requested ids, and refreshes its title cache when the database or WAL changes. Sessions without a local header retain the normal client/model fallback.

## Limits

Every enabled saved account is probed independently. Stable identity prefers the canonical API subject; opaque local fallback ids remain distinct rather than merging unrelated accounts. API email is presentation metadata, not the only identity key.

The dashboard mapping preserves separate official model pools, legacy request plans, enterprise/team pooled usage, optional Grok Bot allowance and on-demand spend. Never synthesize an overall total by summing model pools. Grok Bot is best effort and must not fail the main account row. A zero uncapped spend is hidden; positive uncapped spend remains visible.

Account-scoped enable/disable affects limits collection only. The active tokscale account and self-synced history are managed by the explicit Cursor lifecycle operations.

## Verification

Run the Cursor account, self-sync, cache-event and limits tests when changing this note's scope:

```bash
node --test tests/shared/cursor*.test.js tests/electron/cursorSettingsLayout.test.js
```
