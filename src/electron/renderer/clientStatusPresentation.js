'use strict';

(function exposeClientStatusPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientStatusPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createClientStatusPresentationApi() {
  // The `missing` state means "no data directory on disk". Its meaning differs by
  // client: file-based clients own their data dir (missing ≈ not installed / never
  // run), while cursor/antigravity read from tokscale cache dirs that only appear
  // after login / app-open, so missing means "not signed in / app not open".
  const MISSING_LABELS = {
    cursor: { key: 'settings.tools.status.signIn', tone: 'setup' },
    antigravity: { key: 'settings.tools.status.openApp', tone: 'setup' }
  };
  const MISSING_DEFAULT = { key: 'settings.tools.status.missing', tone: 'muted' };

  const STATUS_TAGS = {
    active: { key: 'settings.tools.status.active', tone: 'ok' },
    waiting: { key: 'settings.tools.status.waiting', tone: 'neutral' }
  };

  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  // Returns { key, tone } for a tag, or null when no tag should render
  // (untracked clients, or an unknown status).
  function clientStatusTag(clientId, status) {
    if (status === 'missing') {
      return MISSING_LABELS[normalizeId(clientId)] || MISSING_DEFAULT;
    }
    return STATUS_TAGS[status] || null;
  }

  return { clientStatusTag };
});
