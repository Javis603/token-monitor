'use strict';

const PAGE_TO_VIEW = Object.freeze({
  overview: 'home',
  quota: 'limits',
  models: 'model',
  activity: 'trends',
  trend: 'trends'
});

function parseMacWidgetDeepLink(value, scheme = 'token-monitor') {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== `${scheme}:`) return null;
    const page = String(url.hostname || '').toLowerCase();
    if (page === 'widget') return { page: 'overview', view: 'home', settings: false };
    if (page === 'widget-settings') return { page: 'overview', view: 'home', settings: true };
    const view = PAGE_TO_VIEW[page];
    return view ? { page, view, settings: false } : null;
  } catch (_) {
    return null;
  }
}

module.exports = { PAGE_TO_VIEW, parseMacWidgetDeepLink };
