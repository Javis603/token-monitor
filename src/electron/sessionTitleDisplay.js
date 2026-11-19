'use strict';

(function exposeSessionTitleDisplay(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSessionTitleDisplay = api;
})(typeof window !== 'undefined' ? window : null, function createSessionTitleDisplayApi() {
  // Compatibility text fields may occur in retained or native session snapshots.
  const SESSION_TITLE_KEYS = Object.freeze(['sessionTitle', 'session_title']);
  const SESSION_TEXT_KEYS = Object.freeze([
    'title', ...SESSION_TITLE_KEYS, 'name', 'preview',
    'firstUserMessage', 'first_user_message', 'customTitle', 'custom_title',
    'aiTitle', 'ai_title', 'topicTitle', 'topic_title'
  ]);

  function projectMap(input, project) {
    if (!input || typeof input !== 'object') return input;
    let result = input;
    for (const [key, value] of Object.entries(input)) {
      const projected = project(value);
      if (projected === value) continue;
      if (result === input) result = { ...input };
      result[key] = projected;
    }
    return result;
  }

  function withoutSessionTitles(sessions) {
    return projectMap(sessions, (value) => {
      if (!value || typeof value !== 'object' || !SESSION_TEXT_KEYS.some((field) => Object.hasOwn(value, field))) return value;
      const session = { ...value };
      for (const field of SESSION_TEXT_KEYS) delete session[field];
      return session;
    });
  }

  // Copy only changed paths: published snapshots and collector anchors are
  // immutable inputs. Cover native views as well as ordinary period sessions.
  function withoutSessionTitleStats(stats) {
    if (!stats || typeof stats !== 'object') return stats;
    let result = stats;
    const replace = (key, value) => {
      if (value === stats[key]) return;
      if (result === stats) result = { ...stats };
      result[key] = value;
    };
    if (stats.sessions) replace('sessions', withoutSessionTitles(stats.sessions));
    for (const key of ['today', 'month', 'allTime']) {
      replace(key, withoutSessionTitleStats(stats[key]));
    }
    replace('periods', projectMap(stats.periods, withoutSessionTitleStats));
    replace('nativeSessions', projectMap(stats.nativeSessions, withoutSessionTitles));
    if (Array.isArray(stats.devices)) {
      const devices = stats.devices.map(withoutSessionTitleStats);
      if (devices.some((device, index) => device !== stats.devices[index])) replace('devices', devices);
    }
    return result;
  }

  return { withoutSessionTitles, withoutSessionTitleStats };
});
