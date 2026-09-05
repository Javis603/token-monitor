'use strict';

// The tracked-client catalog: one entry per wired usage client, in display order.
//
// This is the single source of truth for a client's *identity* — id, label,
// display position, whether it is tracked on a fresh install, and whether its
// usage is parsed locally instead of by tokscale. Before this file, that data
// lived in two hand-maintained lists (this module's CSVs and the renderer's
// own KNOWN_CLIENTS/clientLabels) that had to be kept in the same order by
// hand; the shared copy even rebuilt the order procedurally to match the
// renderer's.
//
// Deliberately NOT here: source roots, WSL markers, icons, CSS, theme colours
// and limits-provider metadata. Those are separate concerns with their own
// tables, and folding them in would trade two honest lists for one god object.
// Adding a client still means touching those (see AGENTS.md) — this file only
// removes the duplication of identity itself.
//
// Pure data, no DOM and no Node built-ins, so the widget renderer can load it
// as a plain <script> and node:test can require it.
(function exposeClientCatalog(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientCatalog = api;
})(typeof window !== 'undefined' ? window : null, function createClientCatalogApi() {
  // Order here IS the display order, shared by the settings list, the renderer
  // and the README table (tests/shared/clientTracking.test.js enforces that).
  //
  // `defaultTracked: false` keeps a client wired and selectable but off on a
  // fresh install. micode (MiMo Code) is opt-in because mimocode.db auto-imports
  // Claude Code sessions (its claude-import service), so scanning it
  // double-counts the `claude` client: tokscale fixed the scan path but does not
  // dedup imports, and the imported rows aren't cleanly separable (MiMo is
  // multi-model). qodercn is opt-in per the upstream tool-support boundary — a
  // local adapter that may break when Qoder changes its DB schema.
  //
  // `locallyParsed: true` means the client is excluded from the tokscale client
  // filter and read by a local adapter instead (collector.js). This is an axis
  // of its own, not a collection "mode": self-synced clients (cursor,
  // antigravity) still go through tokscale and are tracked separately in
  // collector.js.
  const CLIENT_CATALOG = Object.freeze([
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'opencode', label: 'OpenCode' },
    { id: 'hermes', label: 'Hermes Agent' },
    { id: 'openclaw', label: 'OpenClaw' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'antigravity', label: 'Antigravity' },
    { id: 'cline', label: 'Cline' },
    { id: 'kimi', label: 'Kimi' },
    { id: 'qwen', label: 'Qwen' },
    { id: 'grok', label: 'Grok Build' },
    { id: 'copilot', label: 'GitHub Copilot' },
    { id: 'pi', label: 'Pi' },
    { id: 'zed', label: 'Zed' },
    { id: 'kilocode', label: 'Kilo Code' },
    { id: 'commandcode', label: 'Command Code' },
    { id: 'micode', label: 'MiMo Code', defaultTracked: false },
    { id: 'zcode', label: 'ZCode' },
    { id: 'kiro', label: 'Kiro' },
    { id: 'codebuddy', label: 'CodeBuddy' },
    { id: 'workbuddy', label: 'WorkBuddy' },
    { id: 'proma', label: 'Proma', locallyParsed: true },
    { id: 'qodercn', label: 'Qoder CN', defaultTracked: false, locallyParsed: true },
    { id: 'reasonix', label: 'Reasonix' },
    { id: 'dsh', label: 'DeepSeek Harness' },
    { id: 'cherrystudio', label: 'Cherry Studio' },
    { id: 'lmstudio', label: 'LM Studio' },
    { id: 'unsloth', label: 'Unsloth' }
  ].map((client) => Object.freeze({
    defaultTracked: true,
    locallyParsed: false,
    ...client
  })));

  // Display labels for client ids the code recognizes but the catalog does not
  // manage. The tracked-client list is not an allowlist: clientsCsvForSetting()
  // only normalizes CSV, so TOKEN_MONITOR_CLIENTS or the agent's --clients can
  // put any id tokscale supports into a scan, tokscaleClientFilter() passes it
  // through, and normalizeClientName() keys the resulting rows under it. Such a
  // row would otherwise render as the bare id.
  //
  // `gemini` has never been a catalog client here. Promoting it is a product
  // decision — settings surface, source roots, health checks, icons, README, WSL
  // — not a rename. Note this is a *client* id: the Gemini model vendor is a
  // separate domain keyed off the same string in modelVendorFor()/clientColors
  // (usageCharts.js), clientsWithIcon (app.js) and VENDOR_LABELS
  // (themePresets.js), and does not depend on this map.
  //
  // Keep it minimal: subscriptionUsageCostUsd() in app.js reads a key in the
  // merged CLIENT_LABELS as "this provider id names a client", so every id added
  // here widens that test too.
  const NON_CATALOG_CLIENT_LABELS = Object.freeze({ gemini: 'Gemini' });

  const CLIENT_IDS = Object.freeze(CLIENT_CATALOG.map((client) => client.id));
  const DEFAULT_CLIENT_IDS = Object.freeze(
    CLIENT_CATALOG.filter((client) => client.defaultTracked).map((client) => client.id)
  );
  const LOCALLY_PARSED_CLIENT_IDS = Object.freeze(
    CLIENT_CATALOG.filter((client) => client.locallyParsed).map((client) => client.id)
  );

  // Renderer-facing projections. CLIENT_LABELS carries the non-catalog ids too
  // because it is a lookup, while KNOWN_CLIENT_LIST is a display list.
  const CLIENT_LABELS = Object.freeze(Object.fromEntries([
    ...CLIENT_CATALOG.map((client) => [client.id, client.label]),
    ...Object.entries(NON_CATALOG_CLIENT_LABELS)
  ]));
  const KNOWN_CLIENT_LIST = Object.freeze(
    CLIENT_CATALOG.map((client) => Object.freeze({ id: client.id, label: client.label }))
  );

  return {
    CLIENT_CATALOG,
    NON_CATALOG_CLIENT_LABELS,
    CLIENT_IDS,
    DEFAULT_CLIENT_IDS,
    LOCALLY_PARSED_CLIENT_IDS,
    CLIENT_LABELS,
    KNOWN_CLIENT_LIST
  };
});
