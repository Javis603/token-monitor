'use strict';

// Whether a hidden main window still needs the full stats push.
//
// A push carries every Today and Month session — about 2 MB on a long history —
// and main builds and serialises that tree on the sending thread. Text and the
// plain icon are formatted in main, so a hidden window only needs the latest
// snapshot when renderer-composed artwork is visible: a generated tray icon or
// a collapsed floating bubble. Other surfaces (tray text, macOS Widget, Edge
// Dock, Notch) have their own main-side projections.
const RENDERER_COMPOSED_TRAY_CONTENTS = new Set([
  'bars',
  'barsSession',
  'barsWeekly',
  'barsAllSessions',
  'limitsAllSessions',
  'liveTokenRate',
  'custom'
]);

function rendererNeedsStatsWhileHidden(options = {}) {
  const trayContent = String(options.trayContent || 'tokens');
  if (options.showTrayIcon !== false && RENDERER_COMPOSED_TRAY_CONTENTS.has(trayContent)) {
    return true;
  }
  return options.floatingBubbleEnabled === true && options.floatingBubbleCollapsed === true;
}

module.exports = { RENDERER_COMPOSED_TRAY_CONTENTS, rendererNeedsStatsWhileHidden };
