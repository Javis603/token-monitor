'use strict';

// Reasonix native sessions are a renderer-only view. Any Reasonix-shaped entry
// that arrives through the ordinary period.sessions channel is untrusted and
// must be dropped, including legacy stats-path IDs that can contain local paths.
(function exposeReasonixSessionGuard(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorReasonixSessionGuard = api;
})(typeof window !== 'undefined' ? window : null, function createReasonixSessionGuard() {
  const REASONIX_CLIENT = 'reasonix';
  const REASONIX_STATS_CLIENT = 'reasonix-stats';
  const REASONIX_NAMESPACE = 'reasonix:';
  const REASONIX_STATS_NAMESPACE = 'reasonix-stats:';

  function normalized(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isReasonixSyntheticSession(session, key = '') {
    const client = normalized(session?.client);
    const sessionId = normalized(session?.sessionId || session?.session_id);
    const sessionKey = normalized(key);
    return client === REASONIX_CLIENT
      || client === REASONIX_STATS_CLIENT
      || sessionId.startsWith(REASONIX_STATS_NAMESPACE)
      || sessionId.startsWith(REASONIX_NAMESPACE)
      || sessionKey.startsWith(REASONIX_NAMESPACE)
      || sessionKey.includes(REASONIX_STATS_NAMESPACE);
  }

  function filterReasonixSyntheticSessions(sessions) {
    if (!sessions || typeof sessions !== 'object') return sessions;
    const keys = Object.keys(sessions);
    if (!keys.some(key => isReasonixSyntheticSession(sessions[key], key))) return sessions;
    const filtered = {};
    for (const key of keys) {
      const session = sessions[key];
      if (isReasonixSyntheticSession(session, key)) continue;
      filtered[key] = session;
    }
    return filtered;
  }

  return {
    filterReasonixSyntheticSessions,
    isReasonixSyntheticSession
  };
});
