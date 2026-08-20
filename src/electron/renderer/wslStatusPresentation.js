'use strict';

(function exposeWslStatusPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWslStatusPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createWslStatusPresentationApi() {
  // The client list is deliberately not hardcoded here: the WSL scan cannot know
  // every SQLite-backed tool. Show the architecture guidance only when a
  // detected source has no usage rows.
  const SQLITE_HELP_STATES = new Set(['active', 'no-data']);

  function normalizeClientId(id) {
    return String(id || '').trim().toLowerCase();
  }

  function shouldShowSqliteHelp(status) {
    if (!SQLITE_HELP_STATES.has(String(status?.state || '').toLowerCase())) return false;
    const detected = Array.isArray(status?.detected) ? status.detected : [];
    const withData = new Set(
      (Array.isArray(status?.withData) ? status.withData : [])
        .map(normalizeClientId)
        .filter(Boolean)
    );
    return detected.some((id) => {
      const clientId = normalizeClientId(id);
      return clientId && !withData.has(clientId);
    });
  }

  return { shouldShowSqliteHelp };
});
