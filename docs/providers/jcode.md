---
summary: "Jcode snapshot and journal sources and independent reasoning accounting."
ids: [jcode]
read_when:
  - Changing Jcode source discovery, watching, or token accounting.
---

# Jcode

Tokscale reads `session_*.json` snapshots and matching
`session_*.journal.jsonl` sidecars under `$JCODE_HOME/sessions`, falling back to
`~/.jcode/sessions`. Watch the source directory so journal-only appends also
trigger a targeted scan; do not watch a generated Tokscale cache. WSL discovery
uses the default Linux home root.

The parser normalizes split and inclusive cache accounting. Its JSON reasoning
bucket is independent of output, so Jcode is in the shared disjoint-reasoning
allowlist used by live totals and History. Keep the snapshot-plus-journal binary
fixture in `verify-vendored-tokscale.js` when changing this contract.

## Verification

Run `node --test tests/shared/primeAgentJcode.test.js tests/docs/providerGuidance.test.js`
and `node scripts/verify-vendored-tokscale.js` against the manifest-pinned binary.
Native WSL discovery and live filesystem-event acceptance remain manual checks.
