---
summary: "Factory Droid provider notes: one kernel behind the CLI and desktop app, its session metadata sources, usage flush timing, and what is deliberately not supported."
read_when:
  - Changing or debugging Droid session discovery, titles, timestamps or project attribution
  - Investigating Droid usage that is missing from, or zero in, the widget
  - Touching providers/droid/sessionMetadata.js or the droid-sessions source root
  - Considering FACTORY_HOME_OVERRIDE or custom scan paths for relocated Droid data
  - Considering a Factory (`factory`) limits provider, OAuth discovery, or a second scanner for the same sessions
---

# Factory Droid provider

## One kernel, two front-ends, one data plane

The Droid CLI and the Factory desktop app run the same droid kernel. The desktop app is an
Electron shell that bundles its own binary (`Factory.app/Contents/Resources/bin/droid`) and drives
it as `droid daemon` / `droid exec` subprocesses; it keeps only UI state under
`Application Support/Factory`. Every session — CLI or desktop — lands in the same tree:

```
~/.factory/sessions/<encoded-cwd>/<session-uuid>.jsonl          transcript
~/.factory/sessions/<encoded-cwd>/<session-uuid>.settings.json  cumulative tokenUsage
~/.factory/cache/session-discovery-index.json                   current session index
~/.factory/sessions-index.json                                  legacy session index
```

so one tracked client (`droid`) covers both front-ends and tokscale's recursive
`*.settings.json` scan needs no desktop-specific root. The settings file carries one `model` per
session plus cumulative `tokenUsage.{inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,thinkingTokens}`
and an optional `factoryCredits` (Factory Standard Credits) that tokscale's accounting does not read.

## Naming and identity: `droid` tracks, `factory` bills

- The tracked client id is `droid` — tokscale's name and the agent product's own. The vendor and
  billing plane are `factory` (`api.factory.ai`, `app.factory.ai`), so a future limits provider
  registers as `factory` under `providers/factory/`; this folder stays usage-side only.
- The kernel is shared, and so is the data: a future `factory` tracked client scanning
  `~/.factory/sessions` would double-count every session. Usage collection stays solely under
  `droid`; a `factory` provider is quota/balance only.
- Auth overlaps by design — one login serves the CLI and the desktop app. droid keeps login
  tokens in one of three stores (`auth.v2.keyring` via keytar, `auth.v2.loginkeychain`,
  `auth.v2.file`); the loginkeychain variant is a plain local file, so token material is
  locally readable. API keys live in plain `~/.factory/.env` (`FACTORY_API_KEY`). Whether a
  future provider may read the loginkeychain at all is the open question on PR #682; the
  API-key file is the safe floor.

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | `*.settings.json`, parsed by tokscale's droid scanner |
| Session metadata (title, activity times, project) | collector enrichment | tokscale's `sessions` array plus both session-index generations through `providers/droid/sessionMetadata.js` |
| Session Detail (per-turn breakdown) | — deliberately unsupported, see below | — |

## Usage flows through tokscale only

The collector reads the home-relative `~/.factory/sessions` root (tokscale declares
`PathRoot::Home`, not XDG — same path on every platform) under the `droid-sessions` check id.
droid writes `tokenUsage` after model round-trips complete, so a session that just answered can
legitimately report zeros until the next flush; that is upstream's write timing, not a scan defect.

`factoryCredits` is billed on Factory's side and is not converted here. Cost comes from tokscale's
pricing catalogs by model id — Factory's own router models and BYOK model ids are covered, free
OpenRouter models price at 0 — and the app's custom-pricing overrides apply through the shared
pricing path. BYOK sessions record full local token counts (verified live); subscription accounts
are expected to do the same, since droid's own `/cost` panel approximates credits from these
tokens when the server does not report them, but that has not been verifiable without a
subscription.

## Session metadata comes from the index file

`providers/droid/sessionMetadata.js` reads both on-disk index generations, preferring the current
entry when both contain the same session:

- The current index format, verified with Droid 0.218.1, is
  `.factory/cache/session-discovery-index.json` (version 6); its `entries` object is keyed by
  session id, and each value uses
  `{id, title, cwd, createdTimeMs, modifiedTimeMs, messageCount, ...}`.
- Older releases write `.factory/sessions-index.json` (version 2), whose entries use fields such
  as `{sessionId, hostId, title, cwd, mtime, settingsMtime, messagesCount, ...}`. They do not carry
  `createdAt`; legacy index entries therefore provide `lastUsedAt` but not `startedAt`.
- The available epoch-millisecond fields become `startedAt`/`lastUsedAt`; `title` passes through
  trimmed; `cwd` goes through the shared `projectIdentity()` so droid sessions join project
  attribution with the same hashing as every other client. Pinned tokscale also supplies
  transcript-backed `firstActiveMs`/`lastActiveMs`, so legacy sessions still get activity bounds.
- The index is written asynchronously by the droid kernel — a session id can appear in a tokscale
  scan before its index entry lands, which is why the resolver registers
  `retryAfterTimestampFallback: true`.
- A missing, malformed or entries-less index resolves to no metadata and session rows keep
  working with bare ids.
- WSL decoration passes the distro home, so a distro's own index is honored; there are no
  cross-home lookups.
- `FACTORY_HOME_OVERRIDE` (droid's own home relocation) is deliberately not consulted. A per-tool
  custom scan path can relocate token scanning through `TOKSCALE_EXTRA_DIRS`, but the local
  session-index resolvers remain home-relative. Relocated sessions therefore keep token usage and
  scan-backed activity times, while index-only title/project enrichment may be absent.

The pinned tokscale fork also emits scan-backed `sessions` timestamps (`firstActiveMs` /
`lastActiveMs`) for droid, and the collector folds them in before this resolver runs. The two
sources reconcile rather than race — earliest start wins, latest last-activity wins — and the
scan does not answer two things the index still owns: it carries no `title`, and its `workspaces`
array is not decoded for droid, so title and project attribution remain resolver-provided.

## Session Detail is deliberately not supported

`parseByClient` in `sessionDetail.js` parses claude and codex transcripts only, and the README's
Session Details column says `—`, matching kimi's tier: session rows carry titles, times and
projects, but a per-turn timeline would need a droid transcript parser first (the JSONL is a
request/event stream, not the Claude shape).
