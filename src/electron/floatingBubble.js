'use strict';

const FLOATING_BUBBLE_HANDLE_WIDTH = 18;
const FLOATING_BUBBLE_HANDLE_HEIGHT = 34;
const FLOATING_BUBBLE_MARGIN = 8;
const FLOATING_BUBBLE_COLLAPSED_MARGIN = { x: 0, y: FLOATING_BUBBLE_MARGIN };
const FLOATING_BUBBLE_WINDOWS_COLLAPSED_MARGIN = { x: 0, y: 0 };
const INITIAL_RENDERER_PERIODS = new Set(['today', 'month', 'allTime']);
const INITIAL_RENDERER_BREAKDOWNS = new Set(['home', 'tool', 'status', 'device', 'model', 'project', 'session', 'limits', 'trends']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function canUseFloatingBubble(settings = {}) {
  return settings.floatingBubbleEnabled === true &&
    settings.trayMode !== true &&
    settings.windowBehavior !== 'desktop';
}

function floatingBubbleNativeGlassEnabled(settings = {}, state = {}, platform = process.platform) {
  if (platform === 'win32' && state?.collapsed === true) return false;
  return settings?.systemGlass !== false && state?.collapsed !== true;
}

function floatingBubbleCollapsedArea(display, platform = process.platform) {
  if (!display) return null;
  return platform === 'win32' ? display.bounds : display.workArea;
}

function floatingBubbleCollapsedMargin(platform = process.platform) {
  return platform === 'win32' ? FLOATING_BUBBLE_WINDOWS_COLLAPSED_MARGIN : FLOATING_BUBBLE_COLLAPSED_MARGIN;
}

function floatingBubbleWindowChrome(platform = process.platform, collapsed = false) {
  if (platform !== 'win32' || collapsed !== true) return {};
  return {
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false
  };
}

function normalizedInitialRendererValue(value, allowed, fallback) {
  const raw = String(value || '').trim();
  return allowed.has(raw) ? raw : fallback;
}

function normalizeInitialRendererViewState(value = {}, fallback = {}) {
  const source = value || {};
  const fallbackSource = fallback || {};
  const fallbackPeriod = normalizedInitialRendererValue(fallbackSource.period, INITIAL_RENDERER_PERIODS, 'today');
  const fallbackBreakdown = normalizedInitialRendererValue(fallbackSource.breakdown, INITIAL_RENDERER_BREAKDOWNS, 'tool');
  return {
    period: normalizedInitialRendererValue(source.period, INITIAL_RENDERER_PERIODS, fallbackPeriod),
    breakdown: normalizedInitialRendererValue(source.breakdown, INITIAL_RENDERER_BREAKDOWNS, fallbackBreakdown)
  };
}

function initialRendererViewStateQuery(viewState = {}) {
  // Always carry both fields. Omitting a value just because it equals the
  // default ('today'/'tool') is lossy: the renderer can't then tell "the user
  // is on tool" from "no view was provided", and falls back to the first
  // custom-ordered view — silently losing a persisted last view of tool/today.
  const normalized = normalizeInitialRendererViewState(viewState);
  return { period: normalized.period, breakdown: normalized.breakdown };
}

function floatingBubbleInitialRendererQuery(state = {}, options = false) {
  const optionObject = options && typeof options === 'object' ? options : null;
  const collapsedWindow = optionObject ? optionObject.collapsedWindow === true : options === true;
  const side = collapsedWindow && state?.collapsed === true && ['left', 'right'].includes(state.side)
    ? state.side
    : null;
  const query = initialRendererViewStateQuery(optionObject?.viewState);
  if (side) query.floatingBubbleSide = side;
  if (optionObject?.suppressInitialNumberAnimation === true) {
    query.suppressInitialNumberAnimation = '1';
  }
  return Object.keys(query).length ? query : null;
}

function normalizeHandleSize(width = FLOATING_BUBBLE_HANDLE_WIDTH, height = FLOATING_BUBBLE_HANDLE_HEIGHT) {
  return {
    width: Math.max(12, Math.round(Number(width) || FLOATING_BUBBLE_HANDLE_WIDTH)),
    height: Math.max(32, Math.round(Number(height) || FLOATING_BUBBLE_HANDLE_HEIGHT))
  };
}

function floatingBubbleSide(bounds, workArea) {
  if (!bounds || !workArea) return null;
  const centerX = Number(bounds.x) + (Number(bounds.width) / 2);
  const workAreaCenterX = Number(workArea.x) + (Number(workArea.width) / 2);
  return centerX <= workAreaCenterX ? 'left' : 'right';
}

function clampBounds(bounds, workArea, margin = FLOATING_BUBBLE_MARGIN) {
  if (!bounds || !workArea) return null;
  const width = Math.round(Number(bounds.width));
  const height = Math.round(Number(bounds.height));
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
    !Number.isFinite(width) || !Number.isFinite(height) ||
    width <= 0 || height <= 0) return null;
  const marginX = typeof margin === 'object' ? Number(margin.x || 0) : Number(margin || 0);
  const marginY = typeof margin === 'object' ? Number(margin.y || 0) : Number(margin || 0);
  const minX = Number(workArea.x) + marginX;
  const maxX = Number(workArea.x) + Number(workArea.width) - width - marginX;
  const minY = Number(workArea.y) + marginY;
  const maxY = Number(workArea.y) + Number(workArea.height) - height - marginY;
  let clampedX = clamp(x, minX, Math.max(minX, maxX));
  if (typeof margin === 'object') {
    if (Math.abs(clampedX - minX) <= FLOATING_BUBBLE_MARGIN) clampedX = minX;
    else if (Math.abs(clampedX - maxX) <= FLOATING_BUBBLE_MARGIN) clampedX = maxX;
  }
  return {
    x: Math.round(clampedX),
    y: Math.round(clamp(y, minY, Math.max(minY, maxY))),
    width,
    height
  };
}

function collapsedFloatingBubbleBounds(bounds, workArea, options = {}) {
  if (!bounds || !workArea) return null;
  const { width, height } = normalizeHandleSize(options.handleWidth, options.handleHeight);
  const margin = options.margin || FLOATING_BUBBLE_COLLAPSED_MARGIN;
  if (options.collapsedBounds) {
    const previous = clampBounds({ ...options.collapsedBounds, width, height }, workArea, margin);
    if (previous) return previous;
  }
  const side = options.side || floatingBubbleSide(bounds, workArea);
  const y = Number(bounds.y) + (Number(bounds.height) - height) / 2;
  const x = side === 'left'
    ? Number(bounds.x)
    : Number(bounds.x) + Number(bounds.width) - width;
  return clampBounds({ x, y, width, height }, workArea, margin);
}

function expandedFloatingBubbleBounds(collapsedBounds, workArea, previousExpandedBounds, margin = FLOATING_BUBBLE_MARGIN) {
  if (!collapsedBounds || !workArea || !previousExpandedBounds) return null;
  const width = Math.round(Number(previousExpandedBounds.width));
  const height = Math.round(Number(previousExpandedBounds.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const side = floatingBubbleSide(collapsedBounds, workArea);
  const x = side === 'left'
    ? Number(collapsedBounds.x)
    : Number(collapsedBounds.x) + Number(collapsedBounds.width) - width;
  const y = Number(collapsedBounds.y) + (Number(collapsedBounds.height) - height) / 2;
  return clampBounds({ x, y, width, height }, workArea, margin);
}

function floatingBubbleCollapsePlan(bounds, workArea, settings = {}, options = {}) {
  if (options.suppressNextCollapse || options.collapsed || !canUseFloatingBubble(settings)) return null;
  const expandedBounds = clampBounds(bounds, workArea);
  const collapsedArea = options.collapsedArea || workArea;
  const collapsedBounds = collapsedFloatingBubbleBounds(expandedBounds || bounds, collapsedArea, {
    margin: options.collapsedMargin,
    collapsedBounds: options.collapsedBounds,
    handleWidth: options.handleWidth,
    handleHeight: options.handleHeight
  });
  if (!expandedBounds || !collapsedBounds) return null;
  return { side: floatingBubbleSide(collapsedBounds, collapsedArea), expandedBounds, collapsedBounds };
}

function moveFloatingBubbleBounds(bounds, workArea, delta = {}, margin = FLOATING_BUBBLE_COLLAPSED_MARGIN) {
  if (!bounds || !workArea) return null;
  return clampBounds({
    ...bounds,
    x: Number(bounds.x) + Number(delta.dx || 0),
    y: Number(bounds.y) + Number(delta.dy || 0)
  }, workArea, margin);
}

function normalizedDragOffset(value, ratio, fallback, max) {
  const ratioNumber = Number(ratio);
  if (Number.isFinite(ratioNumber)) return clamp(ratioNumber * max, 0, max);
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(number, 0, max);
}

function dragFloatingBubbleBounds(bounds, workArea, cursor = {}, offset = {}, margin = FLOATING_BUBBLE_COLLAPSED_MARGIN) {
  if (!bounds || !workArea || !cursor) return null;
  const { width, height } = normalizeHandleSize(bounds.width, bounds.height);
  const cursorX = Number(cursor.x);
  const cursorY = Number(cursor.y);
  if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return null;
  const offsetX = normalizedDragOffset(offset.offsetX ?? offset.x, offset.offsetRatioX, width / 2, width);
  const offsetY = normalizedDragOffset(offset.offsetY ?? offset.y, offset.offsetRatioY, height / 2, height);
  return clampBounds({
    x: cursorX - offsetX,
    y: cursorY - offsetY,
    width,
    height
  }, workArea, margin);
}

module.exports = {
  FLOATING_BUBBLE_HANDLE_HEIGHT,
  FLOATING_BUBBLE_HANDLE_WIDTH,
  FLOATING_BUBBLE_MARGIN,
  canUseFloatingBubble,
  collapsedFloatingBubbleBounds,
  dragFloatingBubbleBounds,
  expandedFloatingBubbleBounds,
  floatingBubbleCollapsedArea,
  floatingBubbleCollapsedMargin,
  floatingBubbleCollapsePlan,
  floatingBubbleInitialRendererQuery,
  floatingBubbleNativeGlassEnabled,
  floatingBubbleSide,
  floatingBubbleWindowChrome,
  normalizeInitialRendererViewState,
  moveFloatingBubbleBounds
};
