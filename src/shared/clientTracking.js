'use strict';

// micode (MiMo Code) is intentionally NOT default-tracked: mimocode.db auto-imports
// Claude Code sessions (its claude-import service), so scanning it double-counts the
// `claude` client. tokscale 4.0.5 fixed the scan path but does not dedup imports, and
// the imported rows aren't cleanly separable (MiMo is multi-model). It stays a known
// client — one click to enable in Settings → tools — until tokscale dedups upstream.
// trae-cn (Trae CN / TRAE SOLO CN cloud usage adapter) is opt-in too: it reports
// the account's usage from the Trae CN API and needs a saved access token.
const PARSE_LOCAL_CLIENTS = Object.freeze(['proma', 'qodercn', 'trae-cn']);
const DEFAULT_CLIENTS = 'claude,codex,opencode,hermes,openclaw,cursor,antigravity,cline,kimi,qwen,grok,copilot,pi,zed,kilocode,commandcode,zcode,kiro,codebuddy,workbuddy,proma,reasonix,dsh,cherrystudio';

function insertClientBefore(clientsCsv, clientId, beforeClientId) {
  const clients = clientsCsv.split(',');
  const index = clients.indexOf(beforeClientId);
  clients.splice(index >= 0 ? index : clients.length, 0, clientId);
  return clients.join(',');
}

// Every wired client id, including opt-in ones kept out of DEFAULT_CLIENTS (micode,
// qodercn, trae-cn). Display-preference normalization (hide/pin/reorder) keys off this
// list, so an opt-in client's prefs survive a round-trip instead of being silently dropped.
// Mirror the renderer's KNOWN_CLIENTS; add any future opt-in ids here too.
// qodercn (Qoder CN local SQLite adapter) stays opt-in per the upstream tool-support
// boundary — a local adapter that may break when Qoder changes its DB schema.
// trae-cn keeps the plain `trae` id free for a future Tokscale-backed international
// Trae client, per the client-boundary guidance in #218's review. It sits at the tail
// rather than beside qodercn because the display order is pinned to the README
// supported-tools table, where the Trae row lands after the default-tracked usage rows.
const KNOWN_CLIENTS = `${insertClientBefore(
  insertClientBefore(DEFAULT_CLIENTS, 'micode', 'zcode'),
  'qodercn',
  'reasonix'
)},trae-cn`;

function normalizeClientsCsv(value) {
  return String(value ?? '').split(',').map((client) => client.trim().toLowerCase()).filter(Boolean).join(',');
}

function clientsCsvForSetting(value, fallback = DEFAULT_CLIENTS) {
  if (value === undefined || value === null) return normalizeClientsCsv(fallback);
  return normalizeClientsCsv(value);
}

module.exports = {
  DEFAULT_CLIENTS,
  PARSE_LOCAL_CLIENTS,
  KNOWN_CLIENTS,
  clientsCsvForSetting,
  normalizeClientsCsv
};
