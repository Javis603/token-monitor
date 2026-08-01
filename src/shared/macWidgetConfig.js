'use strict';

const DEFAULT_WIDGET_URL_SCHEME = 'token-monitor';

function normalizeWidgetURLScheme(value, fallback = DEFAULT_WIDGET_URL_SCHEME) {
  const raw = String(value ?? '').trim();
  const resolved = raw || fallback;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(resolved)) {
    throw new Error('TOKEN_MONITOR_WIDGET_URL_SCHEME contains unsupported characters');
  }
  return resolved.toLowerCase();
}

module.exports = {
  DEFAULT_WIDGET_URL_SCHEME,
  normalizeWidgetURLScheme
};
