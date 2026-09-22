'use strict';

// Display name for one quota window, shared by every surface that paints
// limits: the Limits view, the edge dock, the tray and the macOS widget.
//
// This is deliberately a DISPLAY helper, not wire normalization. A default
// label must not be written onto the record in `limits/core.js`, because two
// renderers read "this window has no label of its own" as real information:
// the Limits view pairs Claude's unlabelled all-models weekly with Session in
// the two-column grid and gives the labelled "Fable" promo weekly a full row,
// and third-party presets take their balance heading from whichever label the
// collector actually set. Defaulting on the wire would erase that signal.
//
// The collector's label always wins. What's left is naming a window that only
// declared its kind, and the one piece of per-provider knowledge that needs:
// which vendors call the rolling window "5-hour" rather than "Session".
(function exposeLimitWindowLabels(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitWindowLabels = api;
})(typeof window !== 'undefined' ? window : globalThis, function createLimitWindowLabelsApi() {
  // Vendors whose rolling window is published and talked about as "5-hour".
  // Everything else calls it "Session".
  const FIVE_HOUR_WINDOW_PROVIDERS = new Set([
    'alibaba',
    'antigravity',
    'commandcode',
    'kimi',
    'volcengine',
    'zai',
    'zaiteam'
  ]);

  const WINDOW_KIND_LABELS = Object.freeze({
    daily: 'Daily',
    weekly: 'Weekly',
    billing: 'Monthly'
  });

  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  // The name this provider gives a window of that kind when the window itself
  // carries none. Exposed separately from `limitWindowLabel` so a caller that
  // has already decided to ignore the wire label (a group heading that strips
  // its own prefix, say) can still reach the default.
  function limitWindowKindLabel(providerId, kind) {
    const normalizedKind = normalizedId(kind);
    if (normalizedKind === 'session') {
      return FIVE_HOUR_WINDOW_PROVIDERS.has(normalizedId(providerId)) ? '5-hour' : 'Session';
    }
    return WINDOW_KIND_LABELS[normalizedKind] || '';
  }

  // `fallback` is for a surface that would rather show something than nothing
  // for a kind nobody has named (the Limits view's "Quota" / "Usage" columns).
  function limitWindowLabel(providerId, window, fallback = '') {
    const explicit = String(window?.label || '').trim();
    if (explicit) return explicit;
    return limitWindowKindLabel(providerId, window?.kind) || fallback;
  }

  return {
    FIVE_HOUR_WINDOW_PROVIDERS,
    limitWindowKindLabel,
    limitWindowLabel
  };
});
