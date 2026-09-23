---
summary: "Devin (Cognition) usage: CLI sessions.db plus Desktop acp-events ACP logs."
ids: [devin]
read_when:
  - Changing Devin source detection or watch behavior
  - Debugging missing Devin usage or session titles
  - Changing Devin account quota collection
---

# Devin

Devin is both a Tokscale-backed usage client and an optional AI Tool Limits provider. The logical client id is `devin`; Tokscale splits it into two scanners — `devin-cli` and `devin-desktop` — and Token Monitor expands `devin` to both (`tokscaleClientMapping.js`) and folds their rows back into one client. Existing saved client selections are preserved; enable Devin in the tracked-tools settings if it is not selected. Local token tracking needs no Devin credentials. Daily/weekly quota and extra usage balance need the separate web session setup below.

## Account limits

Token Monitor requests `GET https://app.devin.ai/api/<organization>/billing/quota/usage` with the browser session's Bearer token. In Settings → AI Tool Limits → Devin, open Devin Usage & Limits, inspect the successful `billing/quota/usage` request in DevTools, then paste its `Authorization` value and `x-cog-org-id`. The token is stored in the local credential store; it is never exposed to the renderer after saving and is sent only to `app.devin.ai`.

The response supplies Daily and Weekly percentages and reset timestamps. When Devin sets `hide_daily_quota` to `true`, Token Monitor omits Daily while retaining Weekly. `overage_balance` (or `overage_balance_cents`) is shown as the USD Extra usage balance. Headless installs can set `DEVIN_BEARER_TOKEN` and `DEVIN_ORGANIZATION`; `TOKEN_MONITOR_DEVIN_BEARER_TOKEN` and `TOKEN_MONITOR_DEVIN_ORGANIZATION` are also accepted.

## Sources

**Devin CLI** stores one `sessions.db` SQLite database. Tokscale reads it under the XDG data root (`$XDG_DATA_HOME/devin/cli/sessions.db`, fallback `~/.local/share/devin/cli/sessions.db`) on every platform, plus `%APPDATA%/devin/cli/sessions.db` and the home-relative `AppData/Roaming/devin/cli/sessions.db` on Windows. Token usage comes from assistant `message_nodes.chat_message` JSON (`metadata.metrics`); `metadata.generation_model` names the model, and the `adaptive` routing value is not a real model id.

**Devin Desktop** writes ACP event logs under `acp-events`: `~/Library/Application Support/Devin/User/acp-events` on macOS, `~/.config/Devin/User/acp-events` (and the lowercase `devin` spelling) on Linux, `%APPDATA%/Devin/User/acp-events` on Windows. Tokscale reads `usage_update` events from those logs. When a session appears in both sources the CLI database is authoritative.

Devin Desktop builds that write per-session databases under `acp-messages/` instead are not a Tokscale source; only `acp-events` is scanned.

## Desktop coverage

Desktop usage is only as complete as the connected ACP agent. Tokens come from the `usage_update` events an agent writes into the NDJSON stream, which agents such as Cascade/Windsurf, claude-code and opencode do. Devin Desktop's own default `devin-cloud` agent does not: that usage is metered server-side and leaves no local record, and Tokscale has no account-level API source for it. A default Devin Desktop install therefore has a discoverable `acp-events` directory and still reports zero Desktop tokens. Treat that as the source's limit rather than a detection failure — Devin CLI usage is unaffected.

## Session metadata

Session titles, activity timestamps, and project attribution come from the CLI `sessions` table via `src/shared/providers/devin/sessionMetadata.js`. Devin's opaque session ids (e.g. `lavender-flock`) carry no timestamp of their own, so without the database a session falls back to the scan's own activity bounds.

## Cost

Usage is priced by Tokscale's model table like any other client. Devin subscription seats and ACU credit accounting are not an API meter, so displayed cost is an estimate, not an invoice.
