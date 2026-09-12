'use strict';

// Tokscale used to emit one Cursor session per usage event:
// `cursor-active-<ISO timestamp>`. Current tokscale folds those events into
// conversation UUIDs. Session archive keys only by sessionId, so the old
// event-scoped rows look missing and get added on top of live conversations.
(function exposeCursorSessionGuard(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorCursorSessionGuard = api;
})(typeof window !== 'undefined' ? window : null, function createCursorSessionGuard() {
  const EVENT_SCOPED_ID = /^cursor-active-\d{4}-\d{2}-\d{2}T/i;

  function normalized(value) {
    return String(value || '').trim().toLowerCase();
  }

  function eventScopedIdFrom(session, key = '') {
    const sessionId = String(session?.sessionId || session?.session_id || '').trim();
    if (sessionId) return sessionId;
    const rawKey = String(key || '').trim();
    return rawKey.replace(/^cursor:/i, '');
  }

  function isCursorEventScopedSession(session, key = '') {
    const client = normalized(session?.client);
    const sessionKey = normalized(key);
    const looksCursor = !client || client === 'cursor' || sessionKey.startsWith('cursor:');
    return looksCursor && EVENT_SCOPED_ID.test(eventScopedIdFrom(session, key));
  }

  return { isCursorEventScopedSession };
});
