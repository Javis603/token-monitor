'use strict';

// Whether a hidden main window still needs the full stats push.
//
// A push carries every Today and Month session — about 2 MB on a long history —
// and main builds and serialises that tree on the sending thread. Text and the
// plain icon are formatted in main, so a hidden window only needs the latest
// snapshot when renderer-composed artwork is visible: a generated tray icon or
// a collapsed floating bubble. Other surfaces (tray text, macOS Widget, Edge
// Dock, Notch) have their own main-side projections. The mode predicate is the
// shared one used by the tray renderer, so a new generated mode cannot starve
// the hidden window by being added in only one place.
const { isGeneratedTrayIconMode } = require('../shared/trayText');

function rendererNeedsStatsWhileHidden(options = {}) {
  const trayContent = String(options.trayContent || 'tokens');
  if (options.showTrayIcon !== false && isGeneratedTrayIconMode(trayContent)) return true;
  return options.floatingBubbleEnabled === true && options.floatingBubbleCollapsed === true;
}

module.exports = { rendererNeedsStatsWhileHidden };
