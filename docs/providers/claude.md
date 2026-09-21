---
summary: "Claude provider notes: transcript metadata, turn boundaries, OAuth/Web/CLI quota sources, identity and transport."
read_when:
  - Changing Claude session roots, titles, turn state or live context parsing
  - Changing Claude OAuth, Web session or CLI limits collection
  - Changing Claude account identity, prepaid credits or cookie renewal
---

# Claude

Claude has independent local-usage/session and account-limits planes. A Claude Code transcript is not proof of which Claude account owns a limits row, and a Web or OAuth credential is not a token-history source.

## Usage and session metadata

Aggregate tokens and costs come from tokscale. The local adapter in `src/shared/providers/claude/sessionMetadata.js` enriches sessions from `CLAUDE_CONFIG_DIR` or `~/.claude`, checking `projects/` before `transcripts/`.

It reads only persisted `custom-title` and `ai-title` records; it never turns prompt text into a title. Custom titles win. The index is keyed by file size and mtime, scans appended bytes after the first pass and keeps reads bounded around oversized JSONL records.

Turn state comes from the newest assistant `stop_reason` plus any genuine user prompt written after it. `tool_use` is not an ended turn. `tool_result`, meta and compaction records are not new user prompts. The adapter emits `true`, `false` or no value deliberately: `false` must clear an older finished state, while no value means there is no evidence.

### Live context occupancy

On current `main`, Claude does not emit `contextTokens`/`contextWindow`; only providers whose transcripts state a valid pair do. Any Claude model-to-window mapping, occupancy formula, compaction handling, malformed-record policy or oversized-record scan added later belongs in this section and in focused tests—not in root `AGENTS.md`. Unknown or third-party model ids must remain best effort and must not receive a broad guessed window.

## Limits source order

`fetchClaudeLimits()` uses these mutually exclusive paths:

1. an explicitly configured Claude Web `sessionKey`;
2. Claude Code OAuth credentials discovered from env/file, Windows Credential Manager or macOS Keychain;
3. the authenticated Claude CLI usage screen as a fallback only for not-configured, rate-limited, unavailable or generic OAuth failures.

An identity-resolution failure after successful OAuth quota is not allowed to fall through and mint a differently keyed CLI row. The limits runtime retains the previous stable account instead.

OAuth usage refreshes reactively after unauthorized responses. Non-macOS platforms may also refresh shortly before expiry; macOS avoids proactive delegated refresh because it spawns Claude Code. Windows credential-file discovery includes running WSL homes when no explicit config root overrides it.

## Claude Web

The stored value must be one bare `sk-ant-…` session key or canonical `sessionKey=…`; arbitrary Cookie headers are rejected. Web collection has priority when configured and uses Electron's dedicated native request adapter. That adapter preserves raw `Set-Cookie` headers and aborts the underlying request, which ordinary fetch handling cannot guarantee here.

The provider selects a chat-capable organization before API-only organizations, resolves stable account identity, then reads organization usage. Session-key rotation is observed across every response and persisted with compare-and-swap semantics; later requests in the same probe use the renewed key even if persistence loses a race.

A cold identity cache requires the account endpoint. A transient identity failure may reuse a cached stable identity, but quota without any stable identity is unavailable rather than published under a credential-derived key. Authentication errors do not silently fall through to another local account. A Cloudflare challenge is unavailable, not unauthorized.

Prepaid balance is best effort and cached more slowly than usage. A failed or refused prepaid endpoint must not erase the quota row. Transient failures retain the last balance; durable refusal is backed off. An unfunded zero pool is hidden when usage credits are disabled, while a funded or exhausted relevant pool remains visible. The provider emits its credits window explicitly without inventing a percentage meter.

## Verification

Run the Claude session, limits and Electron transport tests when changing this note's scope:

```bash
node --test tests/shared/claudeSessionMetadata.test.js tests/shared/limitCollector.claude.test.js tests/electron/claudeWebFetch.test.js
```
