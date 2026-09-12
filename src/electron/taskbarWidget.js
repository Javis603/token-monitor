'use strict';

const path = require('path');
const {
  TASKBAR_WIDGET_PERIODS,
  TASKBAR_WIDGET_PERIOD_LABEL_KEYS,
  normalizeTaskbarWidgetPeriod,
  nextTaskbarWidgetPeriod,
  taskbarWidgetPeriodLabelKey,
  taskbarWidgetPeriodTokens
} = require('./renderer/taskbarWidgetPeriod');

// Windows-only "taskbar widget": a frameless, transparent, always-on-top
// window pinned to the left edge of the taskbar, where Windows 11 shows the
// weather/Widgets button. The native button itself cannot be customized (no
// third-party widgets can live on the taskbar), so the widget renders its own
// compact token counter exactly over that spot. Clicking the overlay cycles
// the displayed range between today, this month, and all time.
//
// The window is fed by the main process's live stats (same payloads the main
// window renderer consumes), so the number updates in seconds after a session.

const TASKBAR_WIDGET_WIDTH = 228;
const TASKBAR_WIDGET_FALLBACK_HEIGHT = 48;

function canUseTaskbarWidget(settings = {}, platform = process.platform) {
  return platform === 'win32' &&
    settings.taskbarWidgetEnabled === true &&
    settings.trayMode !== true;
}

function taskbarWidgetBounds(display) {
  if (!display) return null;
  const bounds = display.bounds || {};
  const workArea = display.workArea || {};
  const taskbarHeight =
    Number(bounds.y) + Number(bounds.height) - (Number(workArea.y) + Number(workArea.height));
  if (taskbarHeight > 1) {
    // Bottom taskbar: the overlay sits on the strip between the work area and
    // the screen edge, aligned to the very left.
    return {
      x: Number(bounds.x),
      y: Number(workArea.y) + Number(workArea.height),
      width: TASKBAR_WIDGET_WIDTH,
      height: taskbarHeight
    };
  }
  // Autohidden or edge-positioned taskbar: fall back to the bottom-left corner
  // with the standard taskbar height.
  return {
    x: Number(bounds.x),
    y: Number(bounds.y) + Number(bounds.height) - TASKBAR_WIDGET_FALLBACK_HEIGHT,
    width: TASKBAR_WIDGET_WIDTH,
    height: TASKBAR_WIDGET_FALLBACK_HEIGHT
  };
}

function taskbarWidgetPagePath() {
  return path.join(__dirname, 'renderer', 'taskbarWidget.html');
}

module.exports = {
  TASKBAR_WIDGET_FALLBACK_HEIGHT,
  TASKBAR_WIDGET_PERIODS,
  TASKBAR_WIDGET_PERIOD_LABEL_KEYS,
  TASKBAR_WIDGET_WIDTH,
  canUseTaskbarWidget,
  nextTaskbarWidgetPeriod,
  normalizeTaskbarWidgetPeriod,
  taskbarWidgetBounds,
  taskbarWidgetPagePath,
  taskbarWidgetPeriodLabelKey,
  taskbarWidgetPeriodTokens
};
