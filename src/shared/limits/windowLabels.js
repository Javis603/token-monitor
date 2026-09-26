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
    'cline',
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

  // The products one MiMo account can answer for, and the word each row carries
  // in `accountLabel`. Every surface that names or routes a MiMo row reads them
  // here — the Limits title and plan cells, the settings record, the tray and the
  // macOS widget — instead of repeating the literal, which is how the two
  // spellings below drifted apart in the first place. `Membership` is the short
  // form rows recorded before the rename still carry.
  const MIMO_CONSOLE_PRODUCT = 'Console';
  const MIMO_DESKTOP_MEMBERSHIP_PRODUCT = 'Desktop Membership';
  const MIMO_LEGACY_MEMBERSHIP_PRODUCT = 'Membership';

  function normalizedId(value) {
    return String(value || '').trim().toLowerCase();
  }

  // The product this row stands for, or `''` for a row that names none — a
  // provider other than MiMo, or a MiMo row recorded before products were
  // labelled.
  function mimoProductLabel(provider) {
    const label = String(provider?.accountLabel || '').trim();
    return label === MIMO_CONSOLE_PRODUCT
      || label === MIMO_DESKTOP_MEMBERSHIP_PRODUCT
      || label === MIMO_LEGACY_MEMBERSHIP_PRODUCT
      ? label
      : '';
  }

  function isMimoConsoleProduct(provider) {
    return mimoProductLabel(provider) === MIMO_CONSOLE_PRODUCT;
  }

  function isMimoMembershipProduct(provider) {
    const label = mimoProductLabel(provider);
    return label === MIMO_DESKTOP_MEMBERSHIP_PRODUCT || label === MIMO_LEGACY_MEMBERSHIP_PRODUCT;
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
    MIMO_CONSOLE_PRODUCT,
    MIMO_DESKTOP_MEMBERSHIP_PRODUCT,
    isMimoConsoleProduct,
    isMimoMembershipProduct,
    limitWindowKindLabel,
    limitWindowLabel,
    mimoProductLabel
  };
});
