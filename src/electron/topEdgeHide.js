'use strict';

// QQ-style top-edge hide: translate the existing BrowserWindow on y only.
// Peek height is DIP (CSS px). Electron bounds and getCursorScreenPoint() share
// that space, so 6px stays hoverable on HiDPI instead of shrinking in physical
// pixels. Availability matches the floating bubble (not desktop, not tray),
// but this is not a bubble: no mini-window, no left/right side, no rebuild.

const TOP_EDGE_SNAP_THRESHOLD_PX = 12;
const TOP_EDGE_HIDE_PEEK_PX = 6;
const TOP_EDGE_HIDE_DEBOUNCE_MS = 150;
const TOP_EDGE_MOVE_IDLE_MS = 150;
const TOP_EDGE_POINTER_POLL_MS = 50;
const TOP_EDGE_STARTUP_GRACE_MS = 500;
const TOP_EDGE_ANIMATION_MS = 240;
const TOP_EDGE_ANIMATION_FRAME_MS = 16;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function normalizeRect(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const width = Math.round(Number(bounds.width));
  const height = Math.round(Number(bounds.height));
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function canUseTopEdgeHide(settings = {}) {
  return settings.topEdgeHideEnabled === true &&
    settings.trayMode !== true &&
    settings.windowBehavior !== 'desktop';
}

function displayTopY(display, platform = process.platform) {
  const boundsY = Number(display?.bounds?.y);
  if (!Number.isFinite(boundsY)) return null;
  const workAreaY = Number(display?.workArea?.y);
  // Menu bar / taskbar occupying the top inset: dock and peek below it.
  if (Number.isFinite(workAreaY) && workAreaY > boundsY) return Math.round(workAreaY);
  // Typical Windows taskbar is on the bottom; physical top is bounds.y
  // (including a secondary monitor whose origin is not 0).
  if (platform === 'win32') return Math.round(boundsY);
  return Math.round(Number.isFinite(workAreaY) ? workAreaY : boundsY);
}

function horizontalClampArea(display) {
  const area = display?.bounds || display?.workArea;
  if (!area) return null;
  const x = Number(area.x);
  const width = Number(area.width);
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return null;
  return { x, width };
}

function clampHorizontal(bounds, area) {
  if (!bounds || !area) return bounds;
  const minX = Number(area.x);
  const maxX = minX + Number(area.width) - bounds.width;
  return {
    ...bounds,
    x: Math.round(clamp(bounds.x, minX, Math.max(minX, maxX)))
  };
}

function displayForTopEdge(bounds, getDisplayMatching) {
  const rect = normalizeRect(bounds);
  if (!rect || typeof getDisplayMatching !== 'function') return null;
  try {
    return getDisplayMatching(rect) || null;
  } catch (_) {
    return null;
  }
}

function peekHeightPx(value = TOP_EDGE_HIDE_PEEK_PX) {
  const peek = Math.round(Number(value));
  if (!Number.isFinite(peek)) return TOP_EDGE_HIDE_PEEK_PX;
  return clamp(peek, 4, 8);
}

function isNearTopEdge(bounds, display, platform = process.platform, threshold = TOP_EDGE_SNAP_THRESHOLD_PX) {
  const rect = normalizeRect(bounds);
  const top = displayTopY(display, platform);
  const snap = Number(threshold);
  if (!rect || top == null || !Number.isFinite(snap)) return false;
  return rect.y <= top + snap;
}

function shouldDockToTopEdge({
  bounds,
  display,
  settings,
  maximized,
  floatingBubbleCollapsed,
  platform = process.platform,
  threshold = TOP_EDGE_SNAP_THRESHOLD_PX
} = {}) {
  if (!canUseTopEdgeHide(settings)) return false;
  if (maximized === true || floatingBubbleCollapsed === true) return false;
  return isNearTopEdge(bounds, display, platform, threshold);
}

function shouldUndockFromTopEdge(bounds, display, platform = process.platform, threshold = TOP_EDGE_SNAP_THRESHOLD_PX) {
  const rect = normalizeRect(bounds);
  const top = displayTopY(display, platform);
  const snap = Number(threshold);
  if (!rect || top == null || !Number.isFinite(snap)) return false;
  return rect.y > top + snap;
}

function expandedTopEdgeBounds(bounds, display, platform = process.platform) {
  const rect = normalizeRect(bounds);
  const top = displayTopY(display, platform);
  if (!rect || top == null) return null;
  return clampHorizontal({
    x: rect.x,
    y: Math.round(top),
    width: rect.width,
    height: rect.height
  }, horizontalClampArea(display));
}

function hiddenTopEdgeBounds(bounds, display, platform = process.platform, peekHeight = TOP_EDGE_HIDE_PEEK_PX) {
  const expanded = expandedTopEdgeBounds(bounds, display, platform);
  if (!expanded) return null;
  const peek = Math.min(peekHeightPx(peekHeight), expanded.height);
  return {
    x: expanded.x,
    y: Math.round(expanded.y - expanded.height + peek),
    width: expanded.width,
    height: expanded.height
  };
}

function cursorHitsWindow(point, bounds) {
  const rect = normalizeRect(bounds);
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= rect.x && x < rect.x + rect.width &&
    y >= rect.y && y < rect.y + rect.height;
}

function topEdgeAnimationProgress(t, hiding) {
  const x = clamp(Number(t), 0, 1);
  if (!Number.isFinite(x)) return 0;
  // Hide eases in (sucked toward the top); show eases out (the bottom extends).
  if (hiding) return x * x * x;
  return 1 - ((1 - x) ** 3);
}

function interpolatedTopEdgeBounds(from, to, t) {
  const start = normalizeRect(from);
  const end = normalizeRect(to);
  if (!start || !end) return end || start;
  const p = topEdgeAnimationProgress(t, start.y > end.y);
  return {
    x: start.x,
    y: Math.round(start.y + (end.y - start.y) * p),
    width: start.width,
    height: start.height
  };
}

function shouldHideDockedTopEdgeWindow({
  enabled,
  docked,
  hidden,
  cursorInside,
  moving,
  maximized
} = {}) {
  if (enabled !== true || docked !== true || hidden === true) return false;
  if (maximized === true || cursorInside === true || moving === true) return false;
  return true;
}

function shouldRevealDockedTopEdgeWindow({ docked, hidden, cursorInside, force } = {}) {
  if (docked !== true || hidden !== true) return false;
  if (force === true) return true;
  return cursorInside === true;
}

function shouldSkipFloatingBubbleAutoCollapse({ enabled, docked } = {}) {
  return enabled === true && docked === true;
}

module.exports = {
  TOP_EDGE_ANIMATION_FRAME_MS,
  TOP_EDGE_ANIMATION_MS,
  TOP_EDGE_HIDE_DEBOUNCE_MS,
  TOP_EDGE_HIDE_PEEK_PX,
  TOP_EDGE_MOVE_IDLE_MS,
  TOP_EDGE_POINTER_POLL_MS,
  TOP_EDGE_SNAP_THRESHOLD_PX,
  TOP_EDGE_STARTUP_GRACE_MS,
  canUseTopEdgeHide,
  cursorHitsWindow,
  displayForTopEdge,
  displayTopY,
  expandedTopEdgeBounds,
  hiddenTopEdgeBounds,
  interpolatedTopEdgeBounds,
  isNearTopEdge,
  peekHeightPx,
  shouldDockToTopEdge,
  shouldHideDockedTopEdgeWindow,
  shouldRevealDockedTopEdgeWindow,
  shouldSkipFloatingBubbleAutoCollapse,
  shouldUndockFromTopEdge,
  topEdgeAnimationProgress
};
