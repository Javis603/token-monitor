'use strict';

// micode (MiMo Code) is intentionally NOT default-tracked: mimocode.db auto-imports
// Claude Code sessions (its claude-import service), so scanning it double-counts the
// `claude` client. tokscale 4.0.5 fixed the scan path but does not dedup imports, and
// the imported rows aren't cleanly separable (MiMo is multi-model). It stays a known
// client — one click to enable in Settings → tools — until tokscale dedups upstream.
const DEFAULT_CLIENTS = 'claude,codex,hermes,opencode,openclaw,cursor,antigravity,cline,kimi,qwen,grok,copilot,pi,zed,kilocode,zcode,kiro,codebuddy,workbuddy,proma';

// Every wired client id, including opt-in ones kept out of DEFAULT_CLIENTS (micode).
// Display-preference normalization (hide/pin/reorder) keys off this list, so an opt-in
// client's prefs survive a round-trip instead of being silently dropped. Mirror the
// renderer's KNOWN_CLIENTS; add any future opt-in ids here too.
const KNOWN_CLIENTS = `${DEFAULT_CLIENTS},micode`;

function normalizeClientsCsv(value) {
  return String(value ?? '').split(',').map((client) => client.trim().toLowerCase()).filter(Boolean).join(',');
}

function clientsCsvForSetting(value, fallback = DEFAULT_CLIENTS) {
  if (value === undefined || value === null) return normalizeClientsCsv(fallback);
  return normalizeClientsCsv(value);
}

module.exports = {
  DEFAULT_CLIENTS,
  KNOWN_CLIENTS,
  clientsCsvForSetting,
  normalizeClientsCsv
};
