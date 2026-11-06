---
summary: "Mistral Vibe session-level usage and cached prompt accounting."
ids: [mistral]
read_when:
  - Changing Mistral Vibe source roots or token accounting
---

# Mistral Vibe

## Data sources

Tokscale parses `$VIBE_HOME/logs/session/`, defaulting to `~/.vibe/logs/session/` on every platform. The watcher and source health check follow that same override; WSL discovery uses the Linux home-relative default.

Vibe 2.x records cumulative session statistics in `meta.json`; legacy flat JSON files wrap them under `metadata`. Tokscale reads those statistics rather than `messages.jsonl`. These are session-level counters, so the source cannot provide per-message token or model attribution. Timestamps and workspace attribution come from the scan.

## Invariants and known gaps

`session_prompt_tokens` already includes `session_cached_tokens`. Tokscale splits cached tokens out of input, and Token Monitor uses its normal additive input/output/cache accounting. Do not add cached prompt tokens to the original prompt total again. The tracked client id is `mistral`, shared with the model vendor and reserved for future Mistral limits integration. The displayed client name is Mistral Vibe. Subprocess and custom-root scans map `mistral` to Tokscale's `vibe`; live usage, history and archives normalize `vibe` back to `mistral`. Watches target that same canonical partition. The existing Mistral artwork and `#FA520F` colour are reused.

## Verification

`node scripts/verify-vendored-tokscale.js` exercises a nonzero Vibe metadata fixture against the selected binary and verifies both raw token buckets and normalized period/session totals. `node --test tests/shared/tokscaleUpstreamSources.test.js tests/shared/clientPartitionInvariants.test.js` checks source overrides, watch attribution and client partition identity.
