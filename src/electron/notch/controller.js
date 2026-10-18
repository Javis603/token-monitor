'use strict';

const os = require('node:os');
const path = require('node:path');
const { NOTCH_METRICS, notchPeekBounds, notchCanvasBounds, notchGeometry, notchMaxHeight, notchBounds, notchSummaryMaxWidth, notchCommands, translateCommands, interpolateCommands, rectContains } = require('./geometry');
const { toSvgPath, bubbleCommands } = require('../renderer/edgeDock/shapes');
const { readMacNotchScreens } = require('./screen');
const { notchBlurBounds } = require('./blur');
const { readMacMenuWindows } = require('./menuBar');
const { edgeDockBackdropMode, isLiquidGlassBackdrop, liquidGlassStyle, liquidGlassTint } = require('../macBackdropMode');
const { EDGE_DOCK_TIMING, edgeDockCorridorBounds, edgeDockPollDelay, edgeDockScale, normalizeEdgeDockCustomScale, EDGE_DOCK_METRICS: M } = require('../edgeDock/geometry');

const FULL_SCREEN_POLL_MS = 500;
// Polling cadence while the pointer is near the top of the entry's display, so
// hover feedback lands within a frame or two instead of a 90ms idle tick.
const NEAR_TOP_POLL_MS = 16;
const NEAR_TOP_DEPTH = 120;
// The open panel follows the pointer out after a short grace.
const NOTCH_HIDE_DELAY_MS = 100;
const NOTCH_HOVER_DELAYS = [0, 100, 200, 300, 400, 500, 600];

// SwiftUI-style springs: `response` is the undamped period in seconds and
// `damping` the damping fraction. Opening overshoots slightly; closing settles
// without a bounce. Hover feedback is a quicker version of the same pair.
const NOTCH_SPRINGS = Object.freeze({
  open: { response: 0.45, damping: 0.62 },
  close: { response: 0.42, damping: 1 },
  peek: { response: 0.3, damping: 0.6 },
  unpeek: { response: 0.3, damping: 1 }
});

function springState(t, { response, damping }, velocity = 0) {
  // Position from 0 toward 1 at time t (seconds) and its rate, from rest at 0
  // with an initial velocity in units per second.
  const w = 2 * Math.PI / response;
  if (damping < 1) {
    const wd = w * Math.sqrt(1 - damping * damping);
    const b = (velocity - damping * w) / wd;
    const decay = Math.exp(-damping * w * t), cos = Math.cos(wd * t), sin = Math.sin(wd * t);
    return { value: 1 + decay * (-cos + b * sin),
      velocity: decay * ((damping * w + b * wd) * cos + (wd - b * damping * w) * sin) };
  }
  const b = velocity - w, decay = Math.exp(-w * t);
  return { value: 1 + decay * (-1 + b * t), velocity: decay * (w + b - b * w * t) };
}

// Time until the spring stays within half a point on a 500pt travel.
function springDuration(spec, velocity = 0) {
  for (let t = 0.05; t < 3; t += 1 / 120) {
    let settled = true;
    for (let u = t; u < t + 0.25; u += 1 / 120) {
      const state = springState(u, spec, velocity);
      if (Math.abs(1 - state.value) > 0.001) { settled = false; break; }
    }
    if (settled) return Math.round(t * 1000);
  }
  return 3000;
}

function normalizeNotchHoverAction(value) {
  return value === 'open' ? 'open' : 'peek';
}

function normalizeNotchHoverDelay(value) {
  const number = Math.round(Number(value) / 100) * 100;
  return NOTCH_HOVER_DELAYS.includes(number) ? number : 0;
}

function normalizeNotchStyle(value) {
  return ['black', 'inherit', 'vibrancy', 'liquid-glass', 'liquid-glass-clear'].includes(value) ? value : 'black';
}

function normalizeNotchShape(value) {
  return ['auto', 'notch', 'pill'].includes(value) ? value : 'auto';
}

function normalizeNotchDetailSide(value) {
  return value === 'left' ? 'left' : 'right';
}

// One persistent shell, plus the existing EdgeDock bubble renderer. Data is
// shared with the side dock; window ownership, intent and IPC are independent.
function createNotchController({ BrowserWindow, ipcMain, screen, getSettings,
  rendererDir, preloadPath, platform = process.platform, readScreens = readMacNotchScreens, readMenuWindows = readMacMenuWindows,
  nativeGlass = () => false, liquidGlass = () => null, createGlass, applyShapeMask,
  onSwitchCodexAccount, onOpenResetForecastSource, onToggleRateMode, onCapabilitiesChanged = () => {}, installNonActivatingInput = () => {}, blurAvailable = () => false, applyBlurMask, primaryButtonDown = () => null, monitorPrimaryPress, prefersReducedMotion = () => false, isFullScreen = () => false, performHaptic = () => false, canRefreshLimits = () => false, onRefreshLimits,
  logger = () => {} }) {
  const surfaces = ['notch', 'bubble'];
  const windows = {}, windowIds = {}, ready = {}, shapes = {}, glass = {}, nativeMaterial = {}, lastSent = {};
  let materialKey = '', running = false, expanded = false, peeked = false, hoverTicked = false, locked = false;
  let capabilities = null;
  let appearance = {}, data = { cells: [], summary: null };
  let nativeScreens = { screens: [], mainDisplayId: null }, geometryReadAt = -Infinity, geometryDirty = true;
  let geometryConfigs = new Map(), displays = [], primaryDisplay = null;
  const ignoredMouse = {};
  let menuWindows = null, menuReadAt = -Infinity;
  let contentHeight = 180, slots = { left: 17, right: 42 }, rows = [];
  let enterAt = null, leaveAt = null, rowAt = null, hoveredId = null, detailId = null;
  let bubbleHeight = 180, bubblePlaced = null, bubbleBounds = null, detailVisible = false;
  let pollTimer = null, motion = null, screenListeners = false, nearTop = false, buttonDown = false;
  let removePressMonitor = null;
  let blurWindow = null, blurMaskKey = '', blurOpacity = -1, blurAttempts = 0, blurFailed = false, blurRetry = null, blurCurrent = null;
  let motionGeneration = 0, refreshInFlight = null, refreshEpoch = 0;
  let fullScreen = false, fullScreenCheckedAt = -Infinity, fullScreenDisplayId = null;
  let progress = 0, commands = null, frame = null, layoutKey = '', viewport = null;
  let viewportDisplayId = null;
  let summaryMeasured = false, summaryMeasurement = null, summaryGeneration = 0, settleSummary = false;
  const settings = () => getSettings() || {};
  let previewScale = null;
  const zoom = () => previewScale ?? edgeDockScale({ edgeDockSize: settings().notchSize, edgeDockCustomScale: settings().notchCustomScale });
  const alive = (win) => Boolean(win && !win.isDestroyed());
  const ownedSender = (sender) => surfaces.find((s) => alive(windows[s]) && windows[s].webContents === sender);

  function ignoreMouse(surface, value) {
    if (!alive(windows[surface]) || ignoredMouse[surface] === value) return;
    windows[surface].setIgnoreMouseEvents(value, { forward: true });
    ignoredMouse[surface] = value;
  }

  function readGeometry(now) {
    // Logical geometry changes invalidate camera measurements; menu workArea
    // changes do not. Keep only connected display configs, never a disk cache.
    displays = screen.getAllDisplays(); primaryDisplay = screen.getPrimaryDisplay();
    const configs = new Map(displays.map(display => [String(display.id),
      JSON.stringify([display.bounds, display.scaleFactor, display.rotation || 0])]));
    const changed = configs.size !== geometryConfigs.size || [...configs].some(([id, key]) => geometryConfigs.get(id) !== key);
    const refresh = geometryDirty || changed;
    const previous = nativeScreens;
    let result;
    try { result = readScreens({ refresh }); } catch { result = null; }
    if (result && result.failed !== true && Array.isArray(result.screens)) {
      nativeScreens = result; geometryConfigs = configs; geometryDirty = false;
    } else {
      const matches = id => configs.has(String(id)) && configs.get(String(id)) === geometryConfigs.get(String(id));
      const screens = previous.screens.filter(screen => matches(screen.displayId));
      nativeScreens = { screens: screens.length === previous.screens.length ? previous.screens : screens,
        mainDisplayId: matches(previous.mainDisplayId) ? previous.mainDisplayId : null };
      geometryConfigs = new Map([...geometryConfigs].filter(([id]) => matches(id)));
      // Retry native geometry, not just the main-screen lookup, on the next
      // existing 2s tick. A real no-notch result above replaces the old cache.
      geometryDirty = true;
    }
    geometryReadAt = now;
    if (refresh || nativeScreens.screens !== previous.screens || nativeScreens.mainDisplayId !== previous.mainDisplayId) refreshLayout();
  }

  function hapticTick() {
    if (platform !== 'darwin' || settings().notchHaptic === false) return;
    try { performHaptic('generic', 'default'); } catch (error) { logger(`[top-notch] haptic feedback failed: ${error.message}`); }
  }

  function summaryVisible() {
    return Boolean(data.summary && (!fullScreen || expanded));
  }

  // Reuse EdgeDock's 500ms full-screen cadence on this entry's selected display.
  // A focused full-screen window of our own is not another application's Space.
  function refreshFullScreen(now, display) {
    const previous = fullScreen;
    if (settings().notchHideSummaryInFullScreen === false) {
      fullScreen = false; fullScreenCheckedAt = -Infinity;
    } else if (String(display.id) !== fullScreenDisplayId || now - fullScreenCheckedAt >= FULL_SCREEN_POLL_MS) {
      fullScreenDisplayId = String(display.id); fullScreenCheckedAt = now;
      try {
        const focused = BrowserWindow.getFocusedWindow?.();
        const ownFullScreen = focused?.isFullScreen?.() === true
          && String(screen.getDisplayMatching?.(focused.getBounds())?.id) === String(display.id);
        fullScreen = !ownFullScreen && isFullScreen(display) === true;
      } catch (error) {
        fullScreen = false;
        logger(`[top-notch] full-screen check failed: ${error.message}`);
      }
    }
    return fullScreen !== previous;
  }

  function refreshMenu(now = Date.now(), geometry) {
    if (!running || locked || !summaryVisible() || settings().notchAvoidMenuBar === false || now - menuReadAt < 2000) return false;
    if (!(geometry || layout()?.geometry)?.notched) return false;
    try { menuWindows = readMenuWindows(); } catch { menuWindows = null; }
    menuReadAt = now;
    return true;
  }

  function layout() {
    const id = settings().notchDisplayId ?? nativeScreens.mainDisplayId;
    const display = displays.find((d) => String(d.id) === String(id)) || primaryDisplay;
    if (!display) return null;
    const geometry = notchGeometry(display, nativeScreens.screens.find((s) => String(s.displayId) === String(display.id)), normalizeNotchShape(settings().notchShape));
    // The fixed camera band cannot hold an outer ring without shrinking the
    // mark. Only camera-free entries grow around it.
    geometry.summaryZoom = Math.min(zoom(), (geometry.height - 8) / 20);
    geometry.summaryRingSize = summaryVisible() && geometry.gapWidth === 0 && settings().notchRunningIndicatorEnabled === true
      && data.summary.items.some(item => item.providerCell) ? 42 : 0;
    if (geometry.gapWidth === 0 && geometry.summaryRingSize) geometry.height = Math.ceil(geometry.summaryRingSize * geometry.summaryZoom + 8);
    const activeSlots = summaryVisible() ? slots : null;
    const compact = geometry.gapWidth === 0;
    const maxWidth = Math.floor(2 * Math.min(geometry.centerX - display.bounds.x,
      display.bounds.x + display.bounds.width - geometry.centerX));
    const menuMaxWidth = activeSlots && geometry.notched && settings().notchAvoidMenuBar !== false
      ? notchSummaryMaxWidth(display, geometry, menuWindows, Object.values(windowIds)) : null;
    const closedMaxWidth = Math.min(maxWidth, menuMaxWidth ?? maxWidth);
    const summaryBudget = Math.max(0, Math.floor(compact ? closedMaxWidth - 2 * ((geometry.notched ? NOTCH_METRICS.restingFlare : 0) + 8)
      : (closedMaxWidth - geometry.gapWidth) / 2 - 16 - NOTCH_METRICS.restingFlare));
    const boundedSlots = activeSlots && !compact
      ? { left: Math.min(activeSlots.left, summaryBudget), right: Math.min(activeSlots.right, summaryBudget) } : activeSlots;
    const closed = notchBounds(display, geometry, false, contentHeight, boundedSlots, zoom(), closedMaxWidth);
    const open = notchBounds(display, geometry, true, contentHeight, boundedSlots, zoom());
    return { display, geometry, summaryBudget, summaryIconInset: activeSlots?.iconInset || 0,
      closed, peek: notchPeekBounds(closed), open, canvas: notchCanvasBounds(open, closed, zoom()) };
  }

  function publishCapabilities(current) {
    const rings = current.geometry.gapWidth === 0;
    const menuAvoidance = current.geometry.notched;
    if (capabilities?.rings === rings && capabilities.menuAvoidance === menuAvoidance) return;
    capabilities = { rings, menuAvoidance };
    onCapabilitiesChanged(capabilities);
  }

  function disposeGlass(surface) {
    const previous = glass[surface];
    glass[surface] = null;
    try { previous?.dispose(); }
    catch (error) { logger(`[top-notch] ${surface} glass cleanup failed: ${error.message}`); }
  }

  function materialFailed(surface, error) {
    disposeGlass(surface);
    nativeMaterial[surface] = false;
    if (alive(windows[surface])) windows[surface].setVibrancy(null);
    logger(`[top-notch] material unavailable: ${error.message}`);
  }

  function updateGlassAppearance() {
    for (const surface of surfaces) {
      if (!alive(windows[surface]) || !glass[surface]) continue;
      try { glass[surface].update(glassOptions()); }
      catch (error) { materialFailed(surface, error); }
    }
  }

  function backdropMode() {
    // The notch follows the widget, independently of the Edge Dock override.
    return edgeDockBackdropMode({ macBackdrop: settings().macBackdrop, edgeDockMacBackdrop: normalizeNotchStyle(settings().notchStyle) });
  }

  function glassOptions() {
    const mode = backdropMode();
    return { dark: liquidGlass()?.dark === true, style: liquidGlassStyle(mode), tintOpacity: liquidGlassTint(settings(), mode) };
  }

  function shape(surface, points, bounds, display) {
    const d = toSvgPath(points);
    const key = `${display.id}:${display.scaleFactor}:${d}`;
    if (shapes[surface]?.key === key && shapes[surface]?.width === bounds.width && shapes[surface]?.height === bounds.height) return;
    shapes[surface] = { key, width: bounds.width, height: bounds.height, d };
    const win = windows[surface];
    try {
      if (glass[surface]) glass[surface].update({ ...glassOptions(), shape: { commands: points, width: bounds.width, height: bounds.height } });
      else if (nativeMaterial[surface] && applyShapeMask?.(win, points, bounds.width, bounds.height, display) !== true) {
        nativeMaterial[surface] = false;
        win.setVibrancy(null);
      }
    } catch (error) {
      materialFailed(surface, error);
    }
  }

  function send(surface, current = layout()) {
    const win = windows[surface];
    if (!alive(win) || !ready[surface] || !current) return;
    const base = { surface, notch: true, shape: shapes[surface], platform, osRelease: os.release(),
      appearance: { ...appearance, zoomFactor: zoom(), edgeDockRunningIndicatorEnabled: settings().notchRunningIndicatorEnabled === true }, style: normalizeNotchStyle(settings().notchStyle), glass: nativeMaterial[surface] === true, liquidGlass: Boolean(glass[surface]) };
    const hasSummary = summaryVisible();
    if (surface === 'notch') {
      // Measurement results must not invalidate the request that produced them.
      const key = hasSummary ? JSON.stringify([data.summary, zoom(), current.display.id, current.geometry, settings().notchAvoidMenuBar !== false, menuWindows]) : null;
      if (!hasSummary) summaryMeasurement = null;
      else if (!summaryMeasured && summaryMeasurement?.key !== key) summaryMeasurement = { id: ++summaryGeneration, key, measuring: true };
    }
    const payload = surface === 'notch' ? { ...base, expanded, visible: expanded, quietFullScreen: fullScreen, motion: frame,
      geometry: { ...current.geometry, summaryBudget: current.summaryBudget, headerX: current.closed.x - (viewport || current.canvas).x, headerWidth: current.closed.width,
        flare: current.geometry.notched ? NOTCH_METRICS.openFlare : 0,
        gapOffset: current.geometry.centerX - current.geometry.gapWidth / 2 - current.closed.x,
        shoulder: current.geometry.notched && hasSummary ? NOTCH_METRICS.restingFlare : 0 },
      cells: data.cells, summary: hasSummary ? data.summary : null,
      summaryMeasurement: summaryMeasurement && { id: summaryMeasurement.id, measuring: summaryMeasurement.measuring },
      refreshEnabled: settings().notchRefreshEnabled === true,
      refreshable: expanded && settings().notchRefreshEnabled === true && canRefreshLimits() === true }
      : { ...base, visible: Boolean(detailId) && !locked, side: settings().notchDetailSide === 'left' ? 'right' : 'left', cell: data.cells.find((c) => c.id === detailId) || null, placed: bubblePlaced,
        omitQuotaBars: true, maxCardHeight: notchMaxHeight(current.display, current.geometry, true) / zoom() };
    const key = JSON.stringify(payload);
    if (lastSent[surface] === key) return;
    lastSent[surface] = key;
    win.webContents.send('topNotch:render', payload);
  }

  function endpoints(current) {
    return [false, true].map((open) => {
      const b = open ? current.open : current.closed;
      return translateCommands(notchCommands(b.width, b.height, current.geometry.notched, open, current.geometry.height, zoom()), b.x - (viewport || current.canvas).x);
    });
  }

  function restingBounds(current) {
    return expanded ? current.open : peeked ? current.peek : current.closed;
  }

  function targetCommands(current) {
    const b = restingBounds(current);
    return translateCommands(notchCommands(b.width, b.height, current.geometry.notched, expanded, current.geometry.height, zoom()), b.x - (viewport || current.canvas).x);
  }

  function summaryEdges(current) {
    const shoulder = current.geometry.notched && summaryVisible() ? NOTCH_METRICS.restingFlare : 0;
    const left = current.closed.x + shoulder + 8;
    const right = current.closed.x + current.closed.width - shoulder - 8;
    const origin = (viewport || current.canvas).x;
    // Summary elements remain one group during expansion; only a changed
    // readout width moves their mirrored edges to a new resting position.
    return { left: left - origin, right: right - origin };
  }

  function paint(current, points, value, height, extra = {}) {
    commands = points; progress = value;
    const canvas = viewport || current.canvas;
    const headerHeight = current.geometry.gapWidth > 0 ? current.geometry.height : current.geometry.height * Math.max(0, 1 - value);
    // Content is laid out at its open size and scaled with the shell's width,
    // so it grows and shrinks inside the outline instead of fading over it.
    const xs = points.flatMap(([, ...values]) => values.filter((_, i) => i % 2 === 0));
    const contentScale = current.open.width > 0 ? (Math.max(...xs) - Math.min(...xs)) / current.open.width : 1;
    frame = { shape: null, progress, contentScale, bodyHeight: Math.max(0, height - headerHeight), headerHeight,
      summaryHeight: current.geometry.height, summaryIconInset: current.summaryIconInset,
      summaryEdges: summaryEdges(current), bodyBox: { x: current.open.x - canvas.x, width: current.open.width }, ...extra };
    shape('notch', points, canvas, current.display);
    frame.shape = shapes.notch;
    paintBlur(current, value);
    if (alive(windows.notch) && ready.notch) windows.notch.webContents.send('topNotch:motion', frame);
  }

  // The progressive blur is a separate click-through material window under the
  // shell. It is placed around the open panel and fades with the open progress;
  // the mask stays fixed during motion, so no image is rebuilt per frame.
  function blurEnabled() {
    return platform === 'darwin' && running && !locked && settings().notchProgressiveBlur !== false && blurAvailable() === true;
  }

  function destroyBlur() {
    const win = blurWindow;
    clearTimeout(blurRetry); blurRetry = null; blurCurrent = null;
    blurWindow = null; blurMaskKey = ''; blurOpacity = -1;
    if (alive(win)) win.destroy();
  }

  function ensureBlur() {
    if (alive(blurWindow)) return blurWindow;
    const win = new BrowserWindow({ width: 100, height: 40, show: false, frame: false, focusable: false, type: 'panel',
      transparent: true, hasShadow: false, resizable: false, movable: false, skipTaskbar: true, minimizable: false,
      maximizable: false, roundedCorners: false, vibrancy: 'hud', visualEffectState: 'active',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    blurWindow = win; blurMaskKey = ''; blurOpacity = -1;
    win.on('closed', () => { if (blurWindow === win) { blurWindow = null; blurMaskKey = ''; blurOpacity = -1; } });
    installNonActivatingInput(win);
    win.setAlwaysOnTop(true, 'status');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setHiddenInMissionControl?.(true);
    win.setIgnoreMouseEvents(true);
    win.setOpacity(0);
    return win;
  }

  function paintBlur(current, value) {
    const opacity = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    if (!blurEnabled() || blurFailed || !current) { if (alive(blurWindow)) destroyBlur(); return; }
    if (opacity === 0 && !alive(blurWindow)) return;
    // A pending retry repaints whatever layout is current by then, never the
    // one it was scheduled for.
    blurCurrent = current;
    const win = ensureBlur();
    const flare = current.geometry.notched ? NOTCH_METRICS.openFlare * zoom() : 0;
    const panel = { x: current.open.x + flare, y: current.open.y, width: current.open.width - 2 * flare, height: current.open.height };
    const bounds = notchBlurBounds(current.display, panel);
    const key = JSON.stringify([bounds, panel, current.display.scaleFactor, zoom()]);
    if (opacity > 0 && !win.isVisible()) {
      // The material builds its layers only once the window is on screen, and
      // may rebuild them while hidden. Show it transparent, mask it, then fade.
      blurMaskKey = ''; blurOpacity = 0; blurAttempts = 0;
      win.setOpacity(0);
      win.setBounds(bounds);
      win.showInactive();
      // Keep both entry surfaces above the blur they sit on.
      for (const s of surfaces) if (alive(windows[s])) windows[s].moveAbove?.(win.getMediaSourceId());
    }
    if (win.isVisible() && key !== blurMaskKey) {
      win.setBounds(bounds);
      const masked = applyBlurMask?.(win, { width: bounds.width, height: bounds.height,
        panel: { ...panel, x: panel.x - bounds.x, y: panel.y - bounds.y }, radius: NOTCH_METRICS.openRadius * zoom() }, current.display) === true;
      if (!masked) {
        // A remask can fail after the window was already visible. Hide the old
        // mask too, and reset the cache so a successful retry restores opacity.
        if (blurOpacity !== 0) { win.setOpacity(0); blurOpacity = 0; }
        blurMaskKey = '';
        if (++blurAttempts > 30) { blurFailed = true; destroyBlur(); logger('[top-notch] progressive blur unavailable'); return; }
        // Animation frames retry on their own; a panel that opened in one step,
        // as under reduced motion, has no next frame to retry on.
        if (!blurRetry) blurRetry = setTimeout(() => { blurRetry = null; paintBlur(blurCurrent, progress); }, 16);
        return;
      }
      clearTimeout(blurRetry); blurRetry = null;
      blurMaskKey = key;
    }
    if (!blurMaskKey || opacity === blurOpacity) return;
    blurOpacity = opacity;
    win.setOpacity(opacity);
    if (opacity === 0) win.hide();
  }

  function hideDetail() {
    detailId = hoveredId = null; rowAt = null; bubblePlaced = bubbleBounds = null; detailVisible = false;
    if (alive(windows.bubble)) {
      if (windows.bubble.getOpacity() !== 0) windows.bubble.setOpacity(0);
      ignoreMouse('bubble', true); send('bubble');
    }
  }

  function placeDetail(current) {
    const row = rows.find((r) => r.id === detailId);
    if (!current || !row || !alive(windows.bubble)) return;
    const width = Math.round((M.bubbleWidth + M.bubbleTail) * zoom());
    const height = Math.round(Math.min(bubbleHeight * zoom(), notchMaxHeight(current.display, current.geometry, true)));
    const centerY = current.open.y + row.y + row.height / 2;
    const area = current.display.workArea || current.display.bounds;
    const top = Math.max(current.open.y + (current.geometry.gapWidth > 0 ? current.geometry.height : 0), area.y);
    const bottom = Math.min(current.display.bounds.y + current.display.bounds.height, area.y + area.height);
    const y = Math.round(Math.max(top, Math.min(centerY - height / 2, bottom - height - M.screenMargin)));
    const left = settings().notchDetailSide === 'left';
    // Only an attached notch has concave side shoulders. A capsule's full
    // width is its visible body; subtracting shoulders overlaps both windows.
    const shoulder = current.geometry.notched ? NOTCH_METRICS.openFlare * zoom() : 0;
    const idealX = left ? current.open.x + shoulder - M.bubbleGap - width
      : current.open.x + current.open.width - shoulder + M.bubbleGap;
    const x = Math.round(Math.max(current.display.bounds.x + M.screenMargin,
      Math.min(idealX, current.display.bounds.x + current.display.bounds.width - width - M.screenMargin)));
    const changed = !bubbleBounds || bubbleBounds.x !== x || bubbleBounds.y !== y || bubbleBounds.width !== width || bubbleBounds.height !== height;
    bubbleBounds = { x, y, width, height };
    if (changed) windows.bubble.setBounds(bubbleBounds);
    shape('bubble', bubbleCommands({ width, height, side: left ? 'right' : 'left', tail: M.bubbleTail * zoom(), tailY: centerY - y,
      neck: M.bubbleNeck * zoom(), radius: M.bubbleRadius * zoom() }), bubbleBounds, current.display);
    send('bubble', current);
    if (ready.bubble && bubblePlaced && !locked) {
      if (!windows.bubble.isVisible()) windows.bubble.showInactive();
      if (windows.bubble.getOpacity() !== 1) windows.bubble.setOpacity(1);
      ignoreMouse('bubble', false);
      // One tick per visible visit, not per size report, repaint or provider switch.
      if (!detailVisible) { detailVisible = true; hapticTick(); }
    }
  }

  function refreshLayout() {
    if (locked) return;
    const current = layout();
    if (!current || !alive(windows.notch)) return;
    publishCapabilities(current);
    // The first header is measured on the live DOM while hidden. Keep the
    // existing quiet shell until its actual widths return, on either shape.
    if (ready.notch && summaryVisible() && !summaryMeasured && summaryMeasurement?.measuring !== false) {
      send('notch', current); visibility(); return;
    }
    const key = JSON.stringify([current, zoom()]);
    if (layoutKey !== key) {
      layoutKey = key;
      const previous = viewport;
      const closedShape = notchCommands(current.closed.width, current.closed.height, current.geometry.notched, false, current.geometry.height, zoom());
      const changedShape = commands && (previous?.y !== current.open.y || commands.length !== closedShape.length
        || commands.some((command, i) => command[0] !== closedShape[i][0] || command.length !== closedShape[i].length) || viewportDisplayId !== String(current.display.id));
      viewportDisplayId = String(current.display.id);
      if (changedShape) {
        // A camera-attached shell and a capsule have different path topology.
        // Crossing displays lands directly; old in-flight frames are discarded.
        motion = null;
        progress = expanded ? 1 : 0;
        windows.notch.webContents.send('topNotch:animate', { id: ++motionGeneration, duration: 0 });
      }
      if (!previous || !ready.notch || changedShape || settleSummary) {
        if (settleSummary) {
          settleSummary = false; motion = null;
          windows.notch.webContents.send('topNotch:animate', { id: ++motionGeneration, duration: 0 });
        }
        viewport = current.canvas;
        windows.notch.setBounds(viewport);
        progress = expanded ? 1 : 0;
        paint(current, targetCommands(current), progress, restingBounds(current).height);
      } else {
        // Keep both endpoints inside the native canvas until the visible shell
        // finishes shrinking. All coordinates retain their global position.
        const left = Math.min(previous.x, current.canvas.x);
        const right = Math.max(previous.x + previous.width, current.canvas.x + current.canvas.width);
        viewport = { x: left, y: current.canvas.y, width: right - left, height: Math.max(previous.height, current.canvas.height) };
        const shift = previous.x - viewport.x;
        if (commands) commands = translateCommands(commands, shift);
        if (frame) frame = { ...frame,
          summaryEdges: { left: frame.summaryEdges.left + shift, right: frame.summaryEdges.right + shift },
          bodyBox: { ...frame.bodyBox, x: frame.bodyBox.x + shift } };
        windows.notch.setBounds(viewport);
        animateShell(current);
      }
    }
    send('notch', current);
    if (detailId) placeDetail(current);
    visibility();
  }

  function visibility() {
    const win = windows.notch;
    if (!alive(win)) return;
    if (ready.notch && !locked && (!summaryVisible() || summaryMeasured) && !win.isVisible()) win.showInactive();
    // Keep the transparent canvas alive for polling and frame acknowledgements.
    const geometry = layout()?.geometry;
    const emptySummary = summaryMeasured && slots.left === 0 && slots.right === 0;
    const hidden = locked || ((!summaryVisible() || emptySummary) && !(geometry?.notched && geometry.gapWidth > 0) && !expanded && !peeked
      && !(motion && (motion.fromProgress > 0 || motion.target > 0 || motion.peek)));
    const opacity = hidden ? 0 : 1;
    if (win.getOpacity() !== opacity) win.setOpacity(opacity);
    ignoreMouse('notch', locked || !expanded);
    if (locked) hideDetail();
  }

  function setExpanded(value) {
    if (expanded === value || locked) return;
    expanded = value; enterAt = leaveAt = null;
    if (value) peeked = false;
    else { refreshEpoch++; hideDetail(); }
    const current = layout();
    if (!current) return;
    // Full-screen reveal restores the summary and can change both ear widths.
    // Let the existing resize path reserve a canvas for both shapes first.
    if (layoutKey !== JSON.stringify([current, zoom()])) refreshLayout();
    else { animateShell(current); send('notch', current); }
    if (value && ready.notch && !hoverTicked) { hoverTicked = true; hapticTick(); }
    if (!value && !peeked) hoverTicked = false;
  }

  // Hover feedback grows or relaxes the resting outline; the open panel is
  // never involved, so the content stays hidden.
  function setPeeked(value) {
    if (peeked === value || locked) return;
    peeked = value;
    // One tick per hover visit: growing the entry, or opening it straight away.
    if (value && !hoverTicked && ready.notch) { hoverTicked = true; hapticTick(); }
    if (!value && !expanded) hoverTicked = false;
    if (expanded) return;
    const current = layout();
    if (!current) return;
    if (layoutKey !== JSON.stringify([current, zoom()])) refreshLayout();
    else animateShell(current);
  }

  function animateShell(current) {
    const fromProgress = progress, target = expanded ? 1 : 0;
    const spring = expanded ? NOTCH_SPRINGS.open : fromProgress > 0 ? NOTCH_SPRINGS.close : peeked ? NOTCH_SPRINGS.peek : NOTCH_SPRINGS.unpeek;
    const fromHeight = (frame?.bodyHeight || 0) + (frame?.headerHeight ?? current.geometry.height);
    const toHeight = restingBounds(current).height;
    // An interrupted motion hands its vertical speed to the new spring, so a
    // reversal or retarget bends the path instead of restarting from rest.
    const travel = toHeight - fromHeight;
    const velocity = motion && Math.abs(travel) > 0.5 ? Math.max(-30, Math.min(30, (motion.rate || 0) / travel)) : 0;
    const id = ++motionGeneration;
    motion = { id, current, from: commands || endpoints(current)[0], to: targetCommands(current),
      fromProgress, target, fromHeight, toHeight, spring, velocity, rate: 0, peek: peeked,
      fromSummaryHeight: frame?.summaryHeight ?? current.geometry.height,
      fromEdges: { ...(frame?.summaryEdges || summaryEdges(current)),
        left: (frame?.summaryEdges?.left ?? summaryEdges(current).left) + (frame?.summaryIconInset || 0) - current.summaryIconInset }, toEdges: summaryEdges(current),
      fromBox: frame?.bodyBox || { x: current.open.x - viewport.x, width: current.open.width },
      toBox: { x: current.open.x - viewport.x, width: current.open.width },
      duration: springDuration(spring, velocity), elapsed: 0 };
    paint(current, motion.from, fromProgress, motion.fromHeight, { summaryHeight: motion.fromSummaryHeight, summaryEdges: motion.fromEdges, bodyBox: motion.fromBox });
    visibility();
    if (prefersReducedMotion()) {
      windows.notch.webContents.send('topNotch:animate', { id, duration: 0 });
      advanceMotion(motion.duration);
    } else windows.notch.webContents.send('topNotch:animate', { id, duration: motion.duration });
  }
  function advanceMotion(elapsed) {
    if (!motion) return;
    const held = motion;
    held.elapsed = elapsed;
    const done = prefersReducedMotion() || elapsed >= held.duration;
    // Coordinates are interpolated, and extrapolated past the target while the
    // spring overshoots; geometry and material share the same frame.
    const step = done ? { value: 1, velocity: 0 } : springState(elapsed / 1000, held.spring, held.velocity);
    const eased = step.value;
    held.rate = step.velocity * (held.toHeight - held.fromHeight);
    const value = done ? held.target : held.fromProgress + (held.target - held.fromProgress) * eased;
    const mix = (from, to) => Object.fromEntries(Object.keys(to).map(key => [key, from[key] + (to[key] - from[key]) * eased]));
    paint(held.current, interpolateCommands(held.from, held.to, eased), value,
      held.fromHeight + (held.toHeight - held.fromHeight) * eased, { motionId: held.id, done, summaryHeight: held.fromSummaryHeight + (held.current.geometry.height - held.fromSummaryHeight) * eased, summaryEdges: mix(held.fromEdges, held.toEdges), bodyBox: mix(held.fromBox, held.toBox) });
    if (done && motion === held) {
      motion = null;
      const target = held.current.canvas;
      const shift = viewport.x - target.x;
      viewport = target;
      windows.notch.setBounds(target);
      paint(held.current, translateCommands(commands, shift), value, held.toHeight, { motionId: held.id, done: true });
      send('notch', held.current);
      visibility();
    }
  }

  function entryBounds(current) {
    const closed = current.closed.width > 0 ? current.closed : notchBounds(current.display, current.geometry, false, contentHeight, null, zoom());
    return peeked ? notchPeekBounds(closed) : closed;
  }

  function stopPressMonitor() {
    const remove = removePressMonitor;
    removePressMonitor = null;
    try { remove?.(); }
    catch (error) { logger(`[top-notch] click monitor cleanup failed: ${error.message}`); }
  }

  function startPressMonitor() {
    if (!monitorPrimaryPress || removePressMonitor || !running || locked || !alive(windows.notch)) return;
    const win = windows.notch;
    let active = true;
    try {
      const remove = monitorPrimaryPress(point => {
        if (!active || !running || locked || expanded || windows.notch !== win || !alive(win) || !ready.notch
          || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
        const now = Date.now();
        if (now - geometryReadAt >= 2000) readGeometry(now);
        let current = layout();
        if (!current) return;
        if (refreshFullScreen(now, current.display)) { refreshLayout(); visibility(); current = layout(); }
        // Use the delivered event's position, not the pointer at the next poll.
        // Observing the press leaves the resting window click-through and does
        // not activate the app or intercept the original event.
        if (rectContains(entryBounds(current), point)) { setExpanded(true); schedulePoll(); }
      });
      if (typeof remove === 'function') {
        removePressMonitor = () => { active = false; remove(); };
      } else active = false;
    } catch (error) {
      active = false;
      logger(`[top-notch] click monitoring unavailable: ${error.message}`);
    }
  }

  function poll(now = Date.now()) {
    if (!running || locked || !alive(windows.notch)) return;
    if (now - geometryReadAt >= 2000) {
      readGeometry(now);
    }
    let current = layout();
    if (!current) return;
    publishCapabilities(current);
    if (refreshFullScreen(now, current.display)) {
      if (fullScreen) { setExpanded(false); enterAt = leaveAt = null; hideDetail(); }
      refreshLayout(); visibility();
      current = layout();
    }
    if (refreshMenu(now, current.geometry)) { refreshLayout(); current = layout(); }
    const point = screen.getCursorScreenPoint();
    const inDetail = detailId && bubbleBounds && rectContains(bubbleBounds, point);
    // Bubble placement is anchored to the body, excluding concave shoulders.
    const shoulder = current.geometry.notched ? NOTCH_METRICS.openFlare * zoom() : 0;
    const body = { ...current.open, x: current.open.x + shoulder, width: current.open.width - 2 * shoulder };
    const inCorridor = detailId && bubbleBounds && rectContains(edgeDockCorridorBounds(body, bubbleBounds), point);
    // A hidden full-screen summary leaves only the camera housing, so the
    // target reaches inward by half the side dock's physical wake depth. It
    // never widens across menu items.
    const approach = fullScreen;
    // The grown outline keeps the hover it was grown for.
    const entry = entryBounds(current);
    const trigger = { ...entry, height: entry.height + (approach ? M.wakeDepth / 2 : 0) };
    const onEntry = rectContains(entry, point);
    // null: the button state is unreadable (no native bridge).
    const button = primaryButtonDown();
    const nearEntry = approach && rectContains(trigger, point) && button !== true;
    const inside = (expanded ? rectContains(current.open, point) : onEntry || nearEntry) || inDetail || inCorridor;
    const depth = point.y - current.display.bounds.y;
    nearTop = depth >= 0 && depth < NEAR_TOP_DEPTH && Math.abs(point.x - current.geometry.centerX) < current.canvas.width;
    // Transparent parts of the stable canvas must not swallow desktop clicks.
    ignoreMouse('notch', !expanded || !rectContains(current.open, point));
    // Native monitoring observes presses while the resting window stays
    // click-through. Retain sampled presses only for injected legacy callers.
    const pressed = button === true;
    const pressedOnEntry = !removePressMonitor && pressed && !buttonDown && onEntry;
    buttonDown = pressed;
    setPeeked(!expanded && (onEntry || nearEntry));
    if (pressedOnEntry && !expanded) setExpanded(true);
    if (inside) {
      leaveAt = null;
      // An unavailable native click monitor or button reader keeps the entry
      // reachable on hover instead of relying on sampled presses.
      const action = button === null || (monitorPrimaryPress && !removePressMonitor) ? 'open' : normalizeNotchHoverAction(settings().notchHoverAction);
      if (!expanded && action === 'open') {
        if (enterAt === null) enterAt = now;
        if (now - enterAt >= normalizeNotchHoverDelay(settings().notchHoverDelay)) setExpanded(true);
      }
    } else {
      enterAt = null;
      if (expanded) { if (leaveAt === null) leaveAt = now; if (now - leaveAt >= NOTCH_HIDE_DELAY_MS) setExpanded(false); }
    }
    if (!expanded || motion || progress < 1 || inDetail || inCorridor) return;
    const row = rows.find((r) => rectContains({ x: (viewport || current.canvas).x + r.x, y: current.open.y + r.y, width: r.width, height: r.height }, point));
    const rowId = row?.id || null;
    if (rowId !== hoveredId) { hoveredId = rowId; rowAt = now; }
    if (row && row.id !== detailId && now - rowAt >= (detailId ? 0 : EDGE_DOCK_TIMING.bubbleDelayMs)) {
      detailId = row.id; bubblePlaced = null;
      send('bubble', current);
    }
    if (!row && detailId && !inDetail) {
      if (rowAt !== null && now - rowAt >= EDGE_DOCK_TIMING.hideDelayMs) hideDetail();
    }
  }

  function schedulePoll() {
    if (!running || locked || !alive(windows.notch)) return;
    clearTimeout(pollTimer);
    const delay = nearTop || motion ? NEAR_TOP_POLL_MS : edgeDockPollDelay({ revealed: expanded, near: enterAt !== null });
    // Manual geometry refreshes do not enqueue another cursor timer.
    pollTimer = setTimeout(() => {
      pollTimer = null;
      try { poll(); }
      catch (error) { logger(`[top-notch] poll failed: ${error.message}`); }
      finally { schedulePoll(); }
    }, delay);
  }

  function resetShellMotion() {
    motion = commands = frame = null; progress = 0; layoutKey = '';
    viewport = viewportDisplayId = null;
  }

  function destroyWindows() {
    stopPressMonitor();
    destroyBlur();
    resetShellMotion(); refreshInFlight = null;
    summaryMeasured = false; summaryMeasurement = null; settleSummary = false;
    hideDetail(); rows = [];
    for (const s of surfaces) {
      disposeGlass(s);
      const win = windows[s];
      windows[s] = null; delete windowIds[s]; delete ignoredMouse[s]; ready[s] = false; shapes[s] = null; lastSent[s] = '';
      if (alive(win)) win.destroy();
    }
  }
  function refreshGeometry() { geometryReadAt = -Infinity; poll(); }
  function invalidateGeometry(_event, _display, metrics) {
    if (!Array.isArray(metrics) || metrics.some(metric => metric !== 'workArea')) geometryDirty = true;
    menuReadAt = fullScreenCheckedAt = -Infinity; refreshGeometry(); refreshLayout();
  }
  function sync() {
    previewScale = null;
    if (settings().notchRefreshEnabled !== true) refreshEpoch++;
    if (platform !== 'darwin' || settings().notchEnabled !== true) { stop(); return; }
    running = true;
    const style = normalizeNotchStyle(settings().notchStyle);
    // `inherit` follows only the widget, never the Edge Dock's own style.
    const backdrop = backdropMode();
    const key = style === 'black' || !nativeGlass() ? 'none' : isLiquidGlassBackdrop(backdrop) && liquidGlass() ? 'liquid' : 'vibrancy';
    if (materialKey !== key || !surfaces.every((s) => alive(windows[s]))) {
      destroyWindows(); materialKey = key; expanded = peeked = hoverTicked = false; enterAt = leaveAt = null;
      for (const s of surfaces) {
        const win = new BrowserWindow({ width: 360, height: 32, show: false, frame: false, focusable: false,
          type: 'panel', acceptFirstMouse: true, roundedCorners: false, transparent: true, hasShadow: false,
          resizable: false, movable: false, skipTaskbar: true, minimizable: false, maximizable: false,
          ...(key === 'vibrancy' ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
          webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        windows[s] = win;
        win.on('closed', () => {
          if (windows[s] !== win) return;
          windows[s] = null; delete windowIds[s]; delete ignoredMouse[s]; ready[s] = false; shapes[s] = null; lastSent[s] = '';
          disposeGlass(s); nativeMaterial[s] = false;
          if (s === 'notch') { motion = null; stopPressMonitor(); }
          hideDetail();
        });
        const windowId = Number((win.getMediaSourceId?.() || '').split(':')[1]);
        if (Number.isFinite(windowId) && windowId > 0) windowIds[s] = windowId;
        nativeMaterial[s] = key === 'vibrancy';
        if (key === 'liquid') {
          try { glass[s] = createGlass?.(win) || null; nativeMaterial[s] = Boolean(glass[s]); }
          catch (error) { logger(`[top-notch] glass unavailable: ${error.message}`); }
        }
        win.setAlwaysOnTop(true, 'status');
        installNonActivatingInput(win);
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        win.setHiddenInMissionControl?.(true); win.setOpacity(0); ignoreMouse(s, true);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event) => event.preventDefault());
        win.webContents.on('did-fail-load', (_event, code, message) => logger(`[top-notch] renderer failed: ${code} ${message}`));
        win.loadFile(path.join(rendererDir, 'edgeDock', 'index.html'), { query: { surface: s, owner: 'notch' } })
          .catch(error => logger(`[top-notch] ${s} load failed: ${error.message}`));
      }
    }
    // A blur given up on stays off until the setting or Reduce Transparency
    // turns it off and on again; ordinary settings saves do not retry it.
    if (settings().notchProgressiveBlur === false || blurAvailable() !== true) blurFailed = false;
    if (!blurEnabled()) destroyBlur();
    if (!screenListeners) { for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, invalidateGeometry); screenListeners = true; }
    windows.bubble.webContents.setZoomFactor?.(zoom());
    updateGlassAppearance();
    startPressMonitor();
    refreshGeometry(); visibility();
    if (!pollTimer) schedulePoll();
  }
  function stop() {
    menuWindows = null; menuReadAt = -Infinity;
    running = expanded = peeked = hoverTicked = nearTop = fullScreen = false; fullScreenCheckedAt = -Infinity; fullScreenDisplayId = null; enterAt = leaveAt = null;
    clearTimeout(pollTimer); pollTimer = null;
    if (screenListeners) { for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, invalidateGeometry); screenListeners = false; }
    destroyWindows();
  }
  const handlers = {
    'topNotch:ready': (event) => { const s = ownedSender(event.sender); if (!s) return; ready[s] = true; lastSent[s] = ''; refreshLayout(); send(s); visibility(); },
    'topNotch:frame': (event, payload) => {
      if (ownedSender(event.sender) !== 'notch' || !motion || payload?.id !== motion.id
        || !Number.isFinite(payload?.elapsed) || payload.elapsed < motion.elapsed) return;
      advanceMotion(Math.max(0, payload.elapsed));
    },
    'topNotch:size': (event, payload) => {
      if (ownedSender(event.sender) !== 'notch') return;
      const measured = payload?.summaryMeasurement;
      if (measured) {
        if (!summaryVisible() || measured.id !== summaryMeasurement?.id) return;
        if (measured.ready === true) {
          if (summaryMeasurement.measuring) return;
          summaryMeasured = true; summaryMeasurement = null;
          if (expanded && progress < 1) animateShell(layout());
          send('notch'); visibility(); return;
        }
        if (!payload.slots || !['left', 'right'].every(key => Number.isFinite(payload.slots[key]) && payload.slots[key] >= 0)) return;
        summaryMeasurement.measuring = false; settleSummary = true; layoutKey = '';
      }
      if (Number.isFinite(payload?.height) && payload.height > 0) contentHeight = Math.max(40, Math.min(4000, payload.height));
      if (payload?.slots) {
        const width = name => Math.max(0, Math.min(10000, Number(payload.slots[name]) || 0));
        slots = { left: width('left'), right: width('right'), iconInset: width('iconInset') };
      }
      if (Array.isArray(payload?.rows)) rows = payload.rows.filter((r) => data.cells.some((c) => c.id === r.id) && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(r[key]) && Math.abs(r[key]) < 10000));
      refreshLayout();
    },
    'topNotch:bubbleSize': (event, payload) => {
      if (ownedSender(event.sender) !== 'bubble' || payload?.cellId !== detailId || !Number.isFinite(payload.height)) return;
      const current = layout();
      if (!current) return;
      bubbleHeight = Math.min(notchMaxHeight(current.display, current.geometry, true) / zoom(), Math.max(40, payload.height));
      bubblePlaced = { cellId: detailId, height: bubbleHeight }; placeDetail(layout());
    },
    'topNotch:toggleRateMode': (event) => {
      if (!ownedSender(event.sender)) return;
      try { onToggleRateMode?.(); } catch (error) { logger(`[top-notch] rate mode toggle failed: ${error.message}`); }
    },
    'topNotch:dismiss': (event) => { if (ownedSender(event.sender)) setExpanded(false); },
    'topNotch:openResetForecastSource': (event) => { if (ownedSender(event.sender)) onOpenResetForecastSource?.(); }
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.on(channel, handler);
  ipcMain.handle('topNotch:refreshLimits', (event) => {
    if (ownedSender(event.sender) !== 'notch' || !running || locked || !expanded || !ready.notch
      || settings().notchRefreshEnabled !== true || canRefreshLimits() !== true || !onRefreshLimits) return { ok: false, error: 'Not refreshable' };
    if (!refreshInFlight) {
      const request = { window: windows.notch, epoch: refreshEpoch, promise: null };
      request.promise = Promise.resolve().then(() => onRefreshLimits())
        .then((result) => {
          if (result?.ok === true && running && !locked && expanded && windows.notch === request.window
            && request.epoch === refreshEpoch && settings().notchRefreshEnabled === true) hapticTick();
          return result;
        })
        .catch((error) => ({ ok: false, error: error?.message || 'Refresh failed' }))
        .finally(() => { if (refreshInFlight === request) refreshInFlight = null; });
      refreshInFlight = request;
    }
    refreshInFlight.epoch = refreshEpoch;
    return refreshInFlight.promise;
  });
  ipcMain.handle('topNotch:switchCodexAccount', async (event, payload) => {
    if (!ownedSender(event.sender)) return { ok: false, error: 'Unknown surface' };
    return onSwitchCodexAccount?.(String(payload?.accountId || '')) || { ok: false, error: 'Unavailable' };
  });
  return { sync, stop, poll, isRunning: () => running, getCapabilities: () => capabilities,
    owns: (win) => surfaces.some((s) => win === windows[s] && alive(win)),
    previewScale(value) { previewScale = normalizeEdgeDockCustomScale(value); windows.bubble?.webContents.setZoomFactor?.(zoom()); refreshLayout(); },
    setAppearance(value, { preview = false } = {}) {
      if (preview) {
        // Keep the canonical appearance; the native tint reads settings(),
        // while only these two preview values need to cross to the renderer.
        appearance = { ...appearance };
        for (const key of ['glassOpacity', 'glassBlur']) {
          if (value?.[key] !== undefined) appearance[key] = value[key];
        }
      } else appearance = value || {};
      updateGlassAppearance();
      windows.bubble?.webContents.setZoomFactor?.(zoom()); refreshLayout();
    },
    setData(value) { data = value; if (detailId && !data.cells.some((c) => c.id === detailId)) hideDetail(); refreshMenu(); refreshLayout(); },
    setLocked(value) {
      locked = value === true;
      if (locked) {
        refreshEpoch++; expanded = peeked = hoverTicked = false; enterAt = leaveAt = null;
        resetShellMotion(); destroyBlur(); stopPressMonitor();
        clearTimeout(pollTimer); pollTimer = null;
      } else if (running) {
        startPressMonitor();
        invalidateGeometry();
        if (!pollTimer) schedulePoll();
      }
      visibility();
    },
    dispose() { stop(); for (const [channel, handler] of Object.entries(handlers)) ipcMain.removeListener(channel, handler); ipcMain.removeHandler('topNotch:switchCodexAccount'); ipcMain.removeHandler('topNotch:refreshLimits'); }
  };
}
module.exports = { createNotchController, normalizeNotchStyle, normalizeNotchShape, normalizeNotchDetailSide, normalizeNotchHoverAction, normalizeNotchHoverDelay,
  springState, springDuration, NOTCH_SPRINGS, NOTCH_HOVER_DELAYS };
