'use strict';

const { normalizeWidgetURLScheme } = require('../shared/macWidgetConfig');

const PAGE_TO_VIEW = Object.freeze({
  overview: 'home',
  quota: 'limits',
  tools: 'tool',
  models: 'model',
  activity: 'trends'
});

function parseMacWidgetDeepLink(value, scheme = 'token-monitor') {
  try {
    const canonicalScheme = normalizeWidgetURLScheme(scheme);
    const url = new URL(String(value || ''));
    if (url.protocol !== `${canonicalScheme}:`) return null;
    const page = String(url.hostname || '').toLowerCase();
    const view = PAGE_TO_VIEW[page];
    return view ? { page, view } : null;
  } catch (_) {
    return null;
  }
}

module.exports = { PAGE_TO_VIEW, parseMacWidgetDeepLink };
