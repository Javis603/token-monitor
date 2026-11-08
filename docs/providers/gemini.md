---
summary: "Gemini CLI session root, separation from Antigravity, and disjoint thoughts accounting."
ids: [gemini]
read_when:
  - Changing Gemini CLI source discovery, watching, or token accounting.
---

# Gemini CLI

The tracked client is `gemini`. It counts Gemini CLI sessions only. Gemini Desktop is not a source, and these sessions are not Antigravity usage.

Tokscale reads `$GEMINI_CLI_HOME/tmp` (fallback `~/.gemini/tmp`) for `session-*.json`, `chats/*.json`, and `session-*.jsonl`. The host root resolves that variable through Tokscale's effective home. WSL discovery uses the default Linux marker `.gemini/tmp` and does not invent a WSL-specific environment probe. Watch `tmp/` only, not the rest of `~/.gemini/`: Antigravity's IDE and CLI stores live beside it, and a Tokscale cache must not trigger the next scan.

A session total can include cached input. Tokscale removes that overlap and reports `thoughts` as a reasoning bucket separate from output. Tool tokens fold into input. `gemini` is on the shared disjoint-reasoning allowlist, so live totals and History add that bucket once. Keep the binary fixture in `verify-vendored-tokscale.js` when changing this contract.

## Verification

Run `node --test tests/shared/geminiSources.test.js tests/docs/providerGuidance.test.js`
and `node scripts/verify-vendored-tokscale.js` against the manifest-pinned binary.
Native WSL discovery and a live Gemini CLI session appearing in the existing refresh flow remain manual checks.
