'use strict';

(function exposeLimitDisplayMode(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorLimitDisplayMode = api;
})(typeof window !== 'undefined' ? window : null, function createLimitDisplayModeApi() {
  // The percent to fill a limit meter with (and to render as the percent
  // number). In "left" mode this is the remaining quota (the bar empties as
  // quota is consumed); in "used" mode it is the consumed quota (the bar fills
  // as quota is consumed).
  //
  // Both modes anchor on remainingPercent: normalized limit windows always
  // expose it as the renderer-facing display field (providers that report
  // usedPercent instead have remainingPercent derived as the complement).
  // Keying off the single field every metered window carries keeps all
  // surfaces — limits list, home card, tray bars — in exact agreement no
  // matter which of them can see usedPercent; usedPercent is only a fallback
  // for the never-produced remaining-absent window.
  function limitFillPercent(remainingPercent, usedPercent, showUsed) {
    const remaining = Number(remainingPercent);
    const used = Number(usedPercent);
    if (showUsed) {
      if (Number.isFinite(remaining)) return 100 - remaining;
      if (Number.isFinite(used)) return used;
      return 0;
    }
    if (Number.isFinite(remaining)) return remaining;
    if (Number.isFinite(used)) return 100 - used;
    return 0;
  }

  // Trailing word for a percent limit label.
  function limitModeSuffix(showUsed) {
    return showUsed ? 'used' : 'left';
  }

  return { limitFillPercent, limitModeSuffix };
});
