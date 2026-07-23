'use strict';

(function exposeWslStatusPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorWslStatusPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createWslStatusPresentationApi() {
  // These clients are known to store their current usage in SQLite. Windows-side
  // scans can find their WSL markers while still receiving no rows from tokscale
  // over \\wsl$. Keep the wording in the renderer advisory, rather than claiming
  // every empty result is a confirmed SQLite failure here.
  const SQLITE_WSL_CLIENTS = new Set(['hermes', 'opencode']);

  function sqliteHelpClients(status) {
    const withData = new Set((status?.withData || []).map((id) => String(id || '').toLowerCase()));
    const seen = new Set();
    return (status?.detected || [])
      .map((id) => String(id || '').toLowerCase())
      .filter((id) => {
        if (!SQLITE_WSL_CLIENTS.has(id) || withData.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }

  return { sqliteHelpClients };
});
