---
summary: "CodeArts CLI provider notes: OpenCode-schema SQLite store, fork-only ownership, and watch behaviour."
ids: [codearts]
read_when:
  - Changing the CodeArts tracked client, its source roots or its parser policy
  - Debugging a CodeArts scan that reports zero usage or a stale workspace
---

# CodeArts CLI

## Identity and ids

`codearts` is the tracked client for Huawei Cloud's CodeArts CLI (`codearts`).
It is a fork-only client (`forkOnly: true` in `CLIENT_CATALOG`): upstream
tokscale has no such id, and the parse lives in Token Monitor's tokscale fork
(`crates/tokscale-core/src/token_monitor/codearts.rs`), like Proma and Qoder
CN. It is not a limits provider — quota for CodeArts stays out of scope until
a local source for it exists.

## Data sources

CodeArts CLI is built on OpenCode's storage: its sessions live in one SQLite
database at `~/.codeartsdoer/codearts-data/opencode.db`, with the same
`session`/`message` tables and the same JSON payload shape
(`$.role`, `$.modelID`, `$.providerID`, `$.tokens.{input,output,reasoning,cache}`,
`$.time.created/completed` in milliseconds). The fork parses it through the
shared `opencode_schema` driver with `OpenCodeSchemaConfig::codearts`, probing
both OpenCode query groups so a future CodeArts build that moves to v2 tables
(`session_message`) keeps working without a parser change.

The VS Code extension home (`~/.codearts-doer-for-coding`) holds no usage data
and is deliberately not scanned.

Token usage is authoritative from that database; there is no session-metadata
provider. Timestamps and project attribution come from the scan itself (the
`session.directory` join supplies the workspace), so `providers/codearts/`
holds no JS reader — unlike opencode, whose legacy JSON sources need one.

## Source precedence

One database, no fallbacks. A missing database is a valid empty source; the
`TOKEN_MONITOR_CODEARTS_DB_PATH` environment variable overrides the path for
tests and relocated homes, mirroring the Qoder CN override the hermetic
contract fixture clears.

## Credentials and transport

None. The store is read locally; no credentials, accounts or network calls are
involved.

## Invariants and known gaps

- The id must stay a fixed point of `normalizeClientName()` and appears in the
  partition invariants like every tracked client (`codearts` aliases nothing).
- Owned clients have no message-cache lane (the cache is keyed on upstream
  `ClientId`s), so every scan re-reads the database. The store is small; do
  not add a client-side cache without evidence it is needed.
- Policy differences from OpenCode are declared in the fork's
  `OpenCodeSchemaConfig::codearts`: a payload may omit `cache` (or its
  read/write) without dropping the message, and epoch seconds are scaled to
  milliseconds. Zero embedded costs stay unpriced.
- The store is young: if CodeArts starts writing epoch seconds, channel
  databases (`opencode-<channel>.db`) or payload shapes the driver rejects,
  the parser policy — not a new parser — is the place to absorb it.

## Verification

The fork's own tests plus the Token Monitor contract gate:

```bash
cargo test -p tokscale-core --lib token_monitor::codearts
node --test tests/shared/tokscaleTokenContracts.test.js
```

The contract fixture in `scripts/verify-vendored-tokscale.js` writes a
CodeArts-shaped database into the fixture home and runs the vendored binary
with `--client codearts`; it fails against any binary without the fork
parser, which is the signal to update the vendor pin.
