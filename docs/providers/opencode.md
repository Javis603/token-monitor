---
summary: "OpenCode provider notes: profile ownership, API/Web/local quota authority, ambient credentials and session detail."
ids: [opencode]
read_when:
  - Changing OpenCode profiles, credential moves/merges or ambient auth discovery
  - Changing OpenCode Go API, Web cookie or local usage fallback precedence
  - Changing OpenCode session metadata/detail or cross-device aggregation
---

# OpenCode

OpenCode limits can combine a Go API key, a Web cookie and local auth/usage. The provider treats them as components of named accounts rather than one global credential bag.

## Profiles and credential ownership

Each stored credential belongs to at most one profile. Move, rename, merge and remove operations are immutable transforms and refuse collisions that would overwrite another credential. Disabling a profile does not free its credentials for another account.

The auto-detected API key is represented by a pinned reference, not copied blindly into every profile. A bound reference stops resolving when the machine key changes. An unclaimed ambient key may appear as its own account; binding it into a profile stops the duplicate observation. A configured profile always outranks ambient association.

Profile names are user labels, not stable account identity. API keys and Web responses provide canonical identity where possible, and aggregation keeps aliases bounded when older observations used legacy labels.

## Source authority

Single-account mode resolves Go quota in API, then Web, then local order when local estimates are enabled. Multi-account profiles use API then Web only: the device-wide local ledger cannot be safely attributed to an individual profile. Each component remains authoritative only for the windows it actually answers. Supplemental windows fill only kinds not already answered by the selected Go source; merge order must not duplicate quota.

An explicit credential is never replaced by an unrelated ambient credential. Remote credential errors surface only when the final single-account result remains unsuccessful. A lower-priority Web result, an accepted Zen response or an explicitly enabled local estimate may therefore mask an earlier API error. A missing Go subscription is not an authorization failure and may fall through quietly. Cancellation discards the scoped result rather than publishing an error row or papering it over with local estimates.

Do not label a merged row `Web` when any local-only window remains in it. Source presentation follows the components that survived aggregation.

## Sessions

Session metadata and detail read OpenCode's local storage on demand. Keep profile/limits identity out of session attribution: local token sessions are not proof of the billing account selected by a credential profile.

OpenCode 2.x uses `session_v2` and `session_message`; older sessions use the `session`/`message`/`part` triple. Prefer the current transcript and its durable `seq` order, falling back to legacy when no current rows exist. The v1 migration replaces a completed compaction prompt and its summary assistant with a compaction row under the prompt's id, omitting the summary's usage even though session aggregates retain it. Failed/incomplete compactions and subtask assistants are omitted altogether. Restore a legacy summary only when its `parentID` identifies a current compaction or a legacy user with a compaction part. Restore an omitted subtask assistant only when its legacy user parent owns a subtask part and the assistant owns a `tool: task` part, all in the same session; retain its tool names and ordinary turn semantics. Current message ids and compaction usage take precedence. Place completed summaries at their current compaction; otherwise use the preceding surviving legacy id in upstream's stored-time/id order, preserving a legacy-only prefix before new v2 messages. Keep each restored assistant's own timestamp for period filtering and never sum both complete histories or estimate missing per-turn usage from session aggregates.

Current model/agent/location selections are metadata, not usage activity: they must neither renew `lastUsedAt` nor erase the last user/assistant/idle boundary. An unfinished current assistant or explicitly running compaction clears a previous completion: manual `/compact` can start work without a new user row. Completed/failed compactions are not conversation terminals. Detail reads reconcile both shapes within one read transaction and iterate projected usage, user text and tool names; keep unused tool output, reasoning and answer text inside SQLite rather than retaining full message JSON in JS.

## Transport

Every Web probe must receive the runtime-injected transport. Do not bypass proxy and Electron behavior by constructing provider-local fetch implicitly.

## Console migration

Go quota and Zen balance are separate reads. The Bearer-key Go usage API (`/zen/go/v1/usage`) does not supply Zen money. Cookie reads use the Console JSON API when the header contains `__Host-console_session`; legacy-only cookies keep the workspace/server-function path. The Console form accepts the browser's Value alone and stores it with the explicit `__Host-console_session` name. Named cookie headers remain accepted, while existing stored/environment bare values keep their legacy `auth` interpretation.

Each collection or settings probe pair shares one refresh-scoped workspace discovery: `GET /console/api/orgs` without an organization header, then Go `/console/api/go/status` and Zen `/console/api/billing/status` with the same `x-org-id`. Both `wrk_` and `org_` IDs and same-origin Console/workspace override URLs are accepted. Once discovery selects a workspace, legacy fallback keeps that ID rather than rediscovering another account.

Go meters use `usedMicroCents / limitMicroCents` for percentages. Missing weekly/monthly meters and reset times stay absent; the month meter can use `access.endsAt`. Explicit `null` or `access: null` means no Go subscription, not invalid credentials, and blocks stale local estimates just like the API's explicit entitlement rejection. Zen billing is independent of that result: only `billingMode: prepaid` plus `mode: pay-as-you-go` maps `balanceMicroCents / 100000000` to USD, preserving zero and negative balances. Never substitute available credit, invoiceable limits or Go's month meter for the balance.

Console and legacy authentication can expire independently. A working legacy session may recover a Console failure only when it returns quota windows or a finite balance (including zero); an empty legacy success preserves the Console failure. An unsuccessful legacy read must not reclassify a Console permission failure as expired authentication. HTTP 401 means unauthorized, 403 means unavailable access, and 429 means source rate limiting. TLS/certificate errors stop that source without legacy fallback; collection and settings isolate the failed source so healthy API quotas, sibling Web results and other accounts survive. Credential-save probes retain strict transport failures. Cancellation still aborts the scoped operation. When no source succeeds, remote failures outrank missing subscriptions in both single- and multi-account mode. Console requests omit the browser cookie jar and do not follow redirects. No Console spend-summary reads are needed to obtain the Zen balance.

## Verification

Run the OpenCode profile, source-precedence and session tests when changing this note's scope:

```bash
node --test tests/shared/opencode*.test.js tests/shared/limitCollector.opencode.test.js tests/shared/sessionDetail.opencode.test.js
```
