---
summary: "Kimi provider notes: the three Kimi front-ends and their roots, which plane owns usage, workspace attribution and session metadata, and the two generations of the session document the metadata reader has to accept."
read_when:
  - Changing or debugging Kimi session discovery, project attribution, timestamps or session names
  - Investigating Kimi usage that is missing from, or zero in, the widget
  - Touching providers/kimi/sessionMetadata.js or the kimi roots in collector.js
  - Adding a Kimi surface (a new front-end root, client id or limits source)
---

# Kimi provider

Kimi ships several front-ends over the same wire protocol, and they are not interchangeable:

| Front-end | Root | Session ids |
| --- | --- | --- |
| Kimi CLI (legacy) | `~/.kimi/sessions/<group>/<uuid>/wire.jsonl` | uuid |
| Kimi Code — CLI and desktop app | `$KIMI_CODE_HOME/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`, `KIMI_CODE_HOME` falling back to `~/.kimi-code` | `session_*` |
| Kimi Work (the Kimi desktop app's agent mode) | `<platform app data>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions/…` (Windows also honours a relocated `shareDir` from `daimon-storage.json`) | `conv-*`, `ctitle-*` |

All three end in `wire.jsonl`, which is why the tracked client is one id (`kimi`) rather than one
per front-end. A whitespace-only `KIMI_CODE_HOME` counts as unset — tokscale joins `sessions` onto
the raw value, so a blank export would resolve to the root-level `/sessions`.

## Data planes

| Plane | Read by | Source |
| --- | --- | --- |
| Token usage, models, costs | the shared collector, through `tokscale` | `wire.jsonl`, parsed by tokscale's `kimi.rs` |
| Workspace identity and session activity bounds | the same scan | the root-level `workspaces.json` (slug → `root`/`name`) and `session_index.jsonl` (`sessionId`/`sessionDir`/`workDir`), joined by tokscale |
| Session metadata (project fallback, timestamps, name) | collector enrichment, through `providers/kimi/sessionMetadata.js` | the session's sibling `state.json` |
| Limits | the Kimi limits provider, with its own credential | the Kimi Code API and the web console, independent of any of the above |

The scan attributes from the root indexes: a session whose slug is in `workspaces.json` (or whose
id/dir is in `session_index.jsonl`) arrives with a project, and for the sessions those indexes miss —
a relocated home, a copied `sessions/` tree, a deleted index — the resolver is the only answer, which
is why it reads the workspace out of the sibling `state.json`. When both answer, the resolver's path
is the one applied: clients that carry their own path (kimi, droid, opencode) stay unconditional by
design, while the transcript-reading resolvers skip their expensive read for a session the scan
already attributed.

Only `usage.record` lines count, and only with `usageScope: "turn"`. `step.end` repeats the same
usage in the same turn (skipped to avoid double counting), and `"session"`-scoped records are the
runtime's own bookkeeping — compaction calls today. Whether those should be counted is an open
question tracked outside this provider: tokscale excludes them, so the widget's totals are ~1% below
the vendor's own accounting on a compaction-heavy history.

## The session document has two generations

`state.json` is written by every front-end and exists in two shapes. The runtime itself migrates the
legacy one on read (`cwd ?? workDir`, `toEpochMs(createdAt)`), so both have to be accepted:

| Generation | Project path | Timestamps | Title marker |
| --- | --- | --- | --- |
| legacy (Kimi CLI 0.3x) | `workDir` | ISO strings | `isCustomTitle` |
| current (`version: 2`, Kimi Code CLI and desktop alike) | `cwd` | epoch milliseconds | `titleKind` |

The reader prefers them in the runtime's own order — `cwd`, `workDir`, `custom.cwd`, then the older
`custom.workspacePath` — and treats a non-string, non-numeric value as absent rather than coercing
it.

## Session names

`title` is only a name once the runtime generated it or the user set it, so `titleKind` decides:

| Kind | What it holds | Read? |
| --- | --- | --- |
| `replaceable` | whatever the caller called a prompt: the CLI writes the first user message, Kimi Work writes its daimon prompt envelope (`<meta awareness="low" … /> hi`) for a conversation and the title generator's own system prompt for the `ctitle-*` sessions it spawns | no |
| `generated` | the runtime's `chat_title` summary (asked for by a client; a failed request is logged and dropped, leaving `replaceable` in place) | yes |
| `custom` | a user rename, which the runtime never overwrites | yes |

The resolver owns the display cleaning, because the persistence layer stores a `setTitle` value
verbatim even though the prompt path sanitizes (secret redaction, whitespace collapse, 200-character
cap): names are collapsed to one line and capped at the 160 code points the shared scan path uses.
Titles stay local — the Hub strips session text at ingress — and Session Detail remains unsupported
for Kimi.

## Boundaries worth keeping

- **Discovery is indexed, not probed.** `readKimiSessionStateFiles` lists two directory levels and
  reads only the sessions it was asked about, never the workspace × session product. A guard test
  asserts zero stat probes for unknown ids. Cost is O(workspaces) readdirs + O(matches) reads: 0.2 ms
  for a home with a few dozen sessions, ~3.7 ms worst case on a synthetic 10 000-session tree.
- **Reads are unbounded by size** (unlike the SQLite budgets elsewhere): `state.json` is small today —
  the `agents` map grows one entry per subagent — so nothing caps it yet.
- **`ctitle-*` sessions are separate sessions to us.** Kimi Work spawns them to name a conversation
  and they carry their own usage; the app treats them as children. Filtering them would need a
  synthetic-session rule of the kind `providers/reasonix/sessionGuard.js` already implements.
- **`lastPrompt`, `custom` and the desktop's minidb session index are deliberately unread** — they add
  I/O surface without answering a question the reader has.
- **The desktop app writes more than sessions.** `server/` (its embedded host) and the root indexes
  sit outside the watched root; `sessions/.index-dirty/` sits inside it, so indexing can trigger a
  targeted scan. Neither changes what is counted: `wire.jsonl` is the only usage source.
