'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  EDGE_DOCK_METRICS,
  createEdgeDockIntent,
  edgeDockBubbleBounds,
  edgeDockCellAt,
  edgeDockCorridorBounds,
  edgeDockPeekBounds,
  edgeDockPlacementForDrop,
  edgeDockRailBounds,
  edgeDockTriggerBounds,
  normalizeEdgeDockOffset,
  normalizeEdgeDockSide,
  rectContains
} = require('./geometry');
const { bubbleCommands, railCommands, toSvgPath } = require('../renderer/edgeDock/shapes');

const SURFACES = Object.freeze(['peek', 'rail', 'bubble']);
const POLL_IDLE_MS = 90;
const POLL_ACTIVE_MS = 40;
const POLL_DRAG_MS = 16;
const FADE_IN_MS = 150;
const FADE_OUT_MS = 120;
const FADE_STEP_MS = 16;

function edgeDockSupported(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function canUseEdgeDock(settings = {}, platform = process.platform) {
  return edgeDockSupported(platform) && settings?.edgeDockEnabled === true;
}

// Owns the three dock windows and the cursor poll that drives them. The dock is
// deliberately independent of the main window: it has its own non-activating
// windows, so it never steals focus, never enters the app switcher, and works
// the same whether the widget is a window, a tray popover or a floating bubble.
//
// Every surface is a transparent window whose silhouette (rail shoulders, card
// tail) is drawn by the renderer from edgeDockShapes.js. On macOS the native
// material behind it is clipped to the same silhouette through a mask, so the
// sculpted shape keeps real glass; elsewhere the silhouette is filled with the
// theme's glass tint, since Windows acrylic cannot be clipped to a shape.
function createEdgeDockController(deps) {
  const {
    BrowserWindow,
    ipcMain,
    screen,
    platform = process.platform,
    rendererDir,
    preloadPath,
    getSettings,
    nativeGlass,
    prefersReducedMotion = () => false,
    onPlacementChange,
    applyShapeMask,
    primaryButtonDown = () => null,
    onToggleRateMode,
    onSwitchCodexAccount,
    logger = () => {}
  } = deps;

  const windows = { peek: null, rail: null, bubble: null };
  const ready = { peek: false, rail: false, bubble: false };
  const fades = new Map();
  const intent = createEdgeDockIntent();
  let running = false;
  let pollTimer = null;
  let cells = [];
  let appearance = {};
  let builtGlass = null;
  let bubbleCell = null;
  let bubbleHeight = 0;
  // The card the bubble window is currently sized and shaped for. The renderer
  // measures a new card off-screen and only swaps it in once this matches, so a
  // card never paints into a window still at the previous card's size.
  let bubblePlaced = null;
  let bubbleVisible = false;
  let railVisible = false;
  let drag = null;
  let placementOverride = null;
  let ipcRegistered = false;
  let displayListenersAttached = false;
  const shapes = { peek: null, rail: null, bubble: null };
  const lastSent = { peek: '', rail: '', bubble: '' };

  function settings() {
    return getSettings() || {};
  }

  function alwaysVisible() {
    return settings().edgeDockMode === 'always';
  }

  function cellKinds() {
    return cells.map((cell) => (cell.kind === 'stat' ? 'stat' : 'provider'));
  }

  function placement() {
    if (placementOverride) return placementOverride;
    const current = settings();
    return {
      side: normalizeEdgeDockSide(current.edgeDockSide),
      offset: normalizeEdgeDockOffset(current.edgeDockOffset)
    };
  }

  function display() {
    try { return screen.getPrimaryDisplay(); } catch (_) { return null; }
  }

  function layout() {
    const current = display();
    if (!current) return null;
    const { side, offset } = placement();
    const workArea = current.workArea;
    const rail = edgeDockRailBounds({ workArea, side, offset, cellKinds: cellKinds() });
    const peek = edgeDockPeekBounds({ workArea, side, railBounds: rail });
    const trigger = edgeDockTriggerBounds({ workArea, displayBounds: current.bounds, side, railBounds: rail });
    const bubble = bubbleCell !== null
      ? edgeDockBubbleBounds({ railBounds: rail, cellIndex: bubbleCell, height: bubbleHeight, workArea, side })
      : null;
    return { side, workArea, rail, peek, trigger, bubble };
  }

  function alive(win) {
    return Boolean(win && !win.isDestroyed());
  }

  function send(surface, channel, payload) {
    const win = windows[surface];
    if (!alive(win) || !ready[surface]) return;
    try { win.webContents.send(channel, payload); } catch (_) {}
  }

  function surfaceFor(sender) {
    return SURFACES.find((surface) => alive(windows[surface]) && windows[surface].webContents === sender) || null;
  }

  function cancelFade(win) {
    const timer = fades.get(win);
    if (timer) clearInterval(timer);
    fades.delete(win);
  }

  function fade(win, to, duration, done) {
    if (!alive(win)) return;
    cancelFade(win);
    if (prefersReducedMotion()) {
      win.setOpacity(to);
      done?.();
      return;
    }
    const from = win.getOpacity();
    const steps = Math.max(1, Math.round(duration / FADE_STEP_MS));
    let step = 0;
    const timer = setInterval(() => {
      if (!alive(win)) { cancelFade(win); return; }
      step += 1;
      const t = step / steps;
      const eased = 1 - Math.pow(1 - t, 3);
      win.setOpacity(from + (to - from) * eased);
      if (step >= steps) {
        cancelFade(win);
        done?.();
      }
    }, FADE_STEP_MS);
    fades.set(win, timer);
  }

  // Surfaces are shown once and then only faded and made click-through, never
  // hidden. A hidden window keeps its last frame and presents it for a moment
  // when shown again, which read as a flash of stale content on every reveal.
  function setVisible(surface, visible, duration) {
    const win = windows[surface];
    if (!alive(win)) return;
    win.setIgnoreMouseEvents(!visible);
    if (!win.isVisible()) {
      win.setOpacity(0);
      win.showInactive();
    }
    fade(win, visible ? 1 : 0, duration);
  }

  function renderPayload(surface) {
    const { side } = placement();
    const base = { surface, side, platform, osRelease: os.release(), appearance, glass: builtGlass === true, shape: shapes[surface] };
    if (surface === 'rail') {
      return {
        ...base,
        cells,
        focusCellId: bubbleCell !== null ? cells[bubbleCell]?.id || null : null,
        always: alwaysVisible(),
        cellLayout: layout()?.rail?.cells || null
      };
    }
    if (surface === 'bubble') {
      const workArea = display()?.workArea;
      return {
        ...base,
        cell: bubbleCell !== null ? cells[bubbleCell] || null : null,
        placed: bubblePlaced,
        maxCardHeight: workArea ? workArea.height - EDGE_DOCK_METRICS.screenMargin * 2 : null
      };
    }
    return base;
  }

  // Stats arrive every few seconds and mostly change nothing a surface shows;
  // re-rendering on each one rebuilt the card and made it flicker.
  function render(surface) {
    if (!ready[surface]) return;
    const payload = renderPayload(surface);
    const serialized = JSON.stringify(payload);
    if (serialized === lastSent[surface]) return;
    lastSent[surface] = serialized;
    send(surface, 'edgeDock:render', payload);
  }

  function createSurface(surface, glass) {
    const mac = platform === 'darwin';
    const win32 = platform === 'win32';
    const material = mac && glass;
    const win = new BrowserWindow({
      width: surface === 'bubble' ? EDGE_DOCK_METRICS.bubbleWidth : EDGE_DOCK_METRICS.railWidth,
      height: 80,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      // The macOS shadow follows the masked material; a transparent Windows
      // window has no shape-aware shadow to offer.
      hasShadow: material,
      backgroundColor: '#00000000',
      transparent: true,
      ...(win32 ? { thickFrame: false } : {}),
      ...(mac ? { type: 'panel', acceptFirstMouse: true, roundedCorners: false } : {}),
      // The material stays attached for the window's lifetime rather than being
      // detached while hidden: re-attaching builds a new effect view, which
      // would silently drop the shape mask.
      ...(material ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    if (mac) {
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      win.setHiddenInMissionControl?.(true);
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
      ready[surface] = true;
      lastSent[surface] = '';
      render(surface);
      if (surface !== 'peek') setVisible(surface, surface === 'rail' ? railVisible : bubbleVisible, 0);
    });
    win.on('closed', () => {
      cancelFade(win);
      if (windows[surface] === win) {
        windows[surface] = null;
        ready[surface] = false;
      }
    });
    win.loadFile(path.join(rendererDir, 'edgeDock', 'index.html'), { query: { surface, platform } })
      .catch((error) => logger(`[edge-dock] ${surface} load failed: ${error.message}`));
    return win;
  }

  function destroyWindows() {
    for (const surface of SURFACES) {
      const win = windows[surface];
      windows[surface] = null;
      ready[surface] = false;
      lastSent[surface] = '';
      if (alive(win)) {
        cancelFade(win);
        win.destroy();
      }
    }
    railVisible = false;
    bubbleVisible = false;
    bubbleCell = null;
    bubblePlaced = null;
    builtGlass = null;
    for (const surface of SURFACES) shapes[surface] = null;
  }

  function commandsFor(surface, bounds, side) {
    const m = EDGE_DOCK_METRICS;
    if (surface === 'bubble') {
      return bubbleCommands({
        width: bounds.width,
        height: bounds.height,
        side,
        tail: m.bubbleTail,
        tailY: bounds.tailY,
        neck: m.bubbleNeck,
        radius: m.bubbleRadius
      });
    }
    const options = surface === 'peek'
      ? { width: bounds.width, height: bounds.height, side, shoulder: m.peekShoulder, radius: 3.5 }
      : { width: bounds.width, height: bounds.height, side, shoulder: m.shoulder, radius: m.railRadius };
    return { closed: railCommands(options), outline: railCommands({ ...options, open: true }) };
  }

  // Moves a surface and, when its silhouette changed, re-derives the shape: the
  // mask is applied in the same tick as the bounds change so the material is
  // never visible as a rectangle, and the renderer is re-rendered with the path.
  function placeSurface(surface, bounds) {
    const win = windows[surface];
    if (!alive(win) || !bounds) return;
    const { x, y, width, height } = bounds;
    win.setBounds({ x, y, width, height });
    const { side } = placement();
    const key = `${side}:${width}x${height}:${bounds.tailY ?? ''}`;
    if (shapes[surface]?.key === key) return;
    const built = commandsFor(surface, bounds, side);
    const closed = Array.isArray(built) ? built : built.closed;
    const outline = Array.isArray(built) ? built : built.outline;
    shapes[surface] = { key, width, height, d: toSvgPath(closed), outline: toSvgPath(outline) };
    if (builtGlass && platform === 'darwin') {
      try {
        applyShapeMask?.(win, closed, width, height);
      } catch (error) {
        logger(`[edge-dock] ${surface} mask failed: ${error.message}`);
      }
    }
    render(surface);
  }

  function buildWindows() {
    const glass = Boolean(nativeGlass());
    if (builtGlass === glass && SURFACES.every((surface) => alive(windows[surface]))) return;
    destroyWindows();
    builtGlass = glass;
    for (const surface of SURFACES) windows[surface] = createSurface(surface, glass);
    intent.retract();
    // An always-visible dock stays revealed across a rebuild; the new rail
    // window picks this up when its page finishes loading.
    railVisible = intent.snapshot().revealed;
    showPeek();
  }

  function showPeek() {
    const current = layout();
    const peek = windows.peek;
    if (!current || !alive(peek)) return;
    placeSurface('peek', current.peek);
    // An always-visible rail has nothing to hide behind a handle.
    setVisible('peek', !alwaysVisible(), FADE_IN_MS);
  }

  function positionRail(current = layout()) {
    if (!current || !alive(windows.rail)) return;
    placeSurface('rail', current.rail);
    placeSurface('peek', current.peek);
  }

  function revealRail() {
    const rail = windows.rail;
    if (!alive(rail)) return;
    render('rail');
    positionRail();
    if (!railVisible) {
      railVisible = true;
      setVisible('rail', true, FADE_IN_MS);
    }
    setVisible('peek', false, FADE_OUT_MS);
  }

  function retractRail() {
    const rail = windows.rail;
    hideBubble();
    if (!alive(rail) || !railVisible) {
      showPeek();
      return;
    }
    railVisible = false;
    setVisible('rail', false, FADE_OUT_MS);
    showPeek();
  }

  function showBubble(cellIndex) {
    bubbleCell = cellIndex;
    // Reopening the card that was last shown produces the same payload as the
    // one already sent, which the render de-duplication would swallow, and then
    // nothing would ever report a size to reveal it. Send it again, and reveal
    // straight away when the window is already sized for this card.
    lastSent.bubble = '';
    render('bubble');
    render('rail');
    const cellId = cells[cellIndex]?.id;
    if (cellId && bubblePlaced?.cellId === cellId) {
      bubbleHeight = bubblePlaced.height;
      placeBubble();
    }
    // Positioned and revealed once the renderer reports its content height, so
    // the card never appears at a stale size or position.
  }

  function hideBubble() {
    const bubble = windows.bubble;
    const hadCell = bubbleCell !== null;
    bubbleCell = null;
    if (hadCell) render('rail');
    if (!alive(bubble) || !bubbleVisible) return;
    bubbleVisible = false;
    setVisible('bubble', false, FADE_OUT_MS);
  }

  function placeBubble() {
    const bubble = windows.bubble;
    const current = layout();
    if (!alive(bubble) || !current?.bubble || bubbleHeight <= 0 || !railVisible) return;
    placeSurface('bubble', current.bubble);
    if (!bubbleVisible) {
      bubbleVisible = true;
      setVisible('bubble', true, FADE_IN_MS);
    }
  }

  function applyEffects(effects) {
    for (const effect of effects || []) {
      if (effect.type === 'reveal') revealRail();
      else if (effect.type === 'retract') retractRail();
      else if (effect.type === 'bubble') {
        if (effect.cell === null) hideBubble();
        else showBubble(effect.cell);
      }
    }
  }

  function schedulePoll() {
    if (!running) return;
    clearTimeout(pollTimer);
    const snapshot = intent.snapshot();
    const delay = drag ? POLL_DRAG_MS : (snapshot.revealed ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    pollTimer = setTimeout(poll, delay);
  }

  function poll() {
    pollTimer = null;
    if (!running) return;
    try {
      const point = screen.getCursorScreenPoint();
      const current = layout();
      // The renderer can miss the pointerup of a drag, because the window it is
      // dragging moves out from under the captured pointer; the OS button
      // state is the authoritative end of the gesture.
      if (drag && primaryButtonDown() === false && Date.now() - drag.startedAt > 80) {
        handleDragEnd();
      } else if (current && drag) {
        followDrag(point, current);
      } else if (current) {
        const revealed = intent.snapshot().revealed;
        const bubbleRect = bubbleVisible ? current.bubble : null;
        const input = {
          inTrigger: rectContains(current.trigger, point),
          inPeek: !revealed && rectContains(current.peek, point),
          inRail: revealed && rectContains(current.rail, point),
          inBubble: Boolean(bubbleRect && rectContains(bubbleRect, point)),
          inCorridor: Boolean(bubbleRect && rectContains(edgeDockCorridorBounds(current.rail, bubbleRect), point)),
          cellIndex: revealed ? edgeDockCellAt(point, current.rail, cells.length) : null
        };
        applyEffects(intent.tick(input, Date.now()));
      }
    } catch (error) {
      logger(`[edge-dock] poll failed: ${error.message}`);
    }
    schedulePoll();
  }

  function followDrag(point, current) {
    const next = edgeDockPlacementForDrop({
      workArea: current.workArea,
      pointer: point,
      grabOffsetY: drag.grabOffsetY,
      cellKinds: cellKinds()
    });
    if (!next) return;
    const changedSide = next.side !== placement().side;
    placementOverride = next;
    positionRail();
    if (changedSide) render('rail');
  }

  function handleDragStart(grabOffsetY) {
    if (!railVisible) return;
    drag = { grabOffsetY: Math.max(0, Number(grabOffsetY) || 0), startedAt: Date.now() };
    placementOverride = placement();
    hideBubble();
    intent.tick({ dragging: true }, Date.now());
    schedulePoll();
  }

  function handleDragEnd() {
    if (!drag) return;
    const final = placementOverride;
    drag = null;
    placementOverride = null;
    if (final) {
      try { onPlacementChange?.(final); } catch (error) { logger(`[edge-dock] placement save failed: ${error.message}`); }
    }
    positionRail();
    render('rail');
    render('peek');
  }

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.on('edgeDock:ready', (event) => {
      const surface = surfaceFor(event.sender);
      if (!surface) return;
      ready[surface] = true;
      render(surface);
    });
    // Clicks no longer pin the rail: that state had no clear meaning next to
    // the always-visible mode, and its only trace was an unexplained bar. A
    // click on the peek handle reveals the rail; a click on a cell opens its
    // card at once; a click on the live-rate readout switches tok/s and TPM,
    // the same toggle the widget's own rate readout offers.
    ipcMain.on('edgeDock:click', (event, payload) => {
      const surface = surfaceFor(event.sender);
      if (surface === 'peek') {
        applyEffects(intent.reveal());
        return;
      }
      if (surface !== 'rail') return;
      const raw = payload?.cellIndex;
      // A click on the rail's padding carries no cell; Number(null) would be 0.
      const index = raw === null || raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(index) || index < 0 || index >= cells.length) return;
      if (cells[index]?.kind === 'stat' && cells[index]?.metric === 'liveRate') {
        try { onToggleRateMode?.(); } catch (error) { logger(`[edge-dock] rate mode toggle failed: ${error.message}`); }
        return;
      }
      if (bubbleCell !== index) {
        intent.focusCell(index);
        showBubble(index);
      }
    });
    ipcMain.on('edgeDock:dragStart', (event, payload) => {
      if (surfaceFor(event.sender) !== 'rail') return;
      handleDragStart(payload?.grabOffsetY);
    });
    ipcMain.on('edgeDock:dragEnd', (event) => {
      if (surfaceFor(event.sender) !== 'rail') return;
      handleDragEnd();
    });
    ipcMain.on('edgeDock:bubbleSize', (event, payload) => {
      if (surfaceFor(event.sender) !== 'bubble') return;
      const cellId = String(payload?.cellId || '');
      if (bubbleCell === null || cells[bubbleCell]?.id !== cellId) return;
      const height = Math.round(Number(payload?.height));
      if (!Number.isFinite(height) || height <= 0) return;
      bubbleHeight = Math.min(height, display()?.workArea?.height || 720);
      // Store the clamped height: reopening this card restores it verbatim, so
      // keeping the raw value here would place a card taller than the work area.
      bubblePlaced = { cellId, height: bubbleHeight };
      placeBubble();
      render('bubble');
    });
    ipcMain.on('edgeDock:toggleRateMode', (event) => {
      if (surfaceFor(event.sender) !== 'bubble') return;
      try { onToggleRateMode?.(); } catch (error) { logger(`[edge-dock] rate mode toggle failed: ${error.message}`); }
    });
    // The card's Switch button, the one action the dock can take that is not
    // about its own geometry. The main process owns the credential swap and
    // re-projects the cards when it lands; the renderer only reports intent and
    // gets the outcome back so the button can leave its in-flight label.
    ipcMain.removeHandler('edgeDock:switchCodexAccount');
    ipcMain.handle('edgeDock:switchCodexAccount', async (event, payload) => {
      if (surfaceFor(event.sender) !== 'bubble') return { ok: false, error: 'Unknown surface' };
      const accountId = String(payload?.accountId || '').trim();
      if (!accountId) return { ok: false, error: 'Missing account' };
      try {
        const result = await onSwitchCodexAccount?.(accountId);
        return {
          ok: result?.ok !== false,
          error: result?.error || '',
          refreshError: result?.refreshError || ''
        };
      } catch (error) {
        logger(`[edge-dock] codex account switch failed: ${error.message}`);
        return { ok: false, error: error?.message || 'Switch failed' };
      }
    });
    ipcMain.on('edgeDock:dismiss', (event) => {
      if (!surfaceFor(event.sender)) return;
      applyEffects(intent.retract());
    });
  }

  function onDisplayChange() {
    if (!running) return;
    positionRail();
    if (railVisible) placeBubble();
    else showPeek();
  }

  function attachDisplayListeners() {
    if (displayListenersAttached) return;
    displayListenersAttached = true;
    for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
      screen.on(event, onDisplayChange);
    }
  }

  function start() {
    if (running) {
      buildWindows();
      return;
    }
    running = true;
    registerIpc();
    attachDisplayListeners();
    buildWindows();
    schedulePoll();
  }

  function stop() {
    running = false;
    clearTimeout(pollTimer);
    pollTimer = null;
    drag = null;
    placementOverride = null;
    intent.retract();
    destroyWindows();
  }

  return {
    // Settings changed: start, stop, rebuild for a material change, or move.
    sync() {
      if (!canUseEdgeDock(settings(), platform)) {
        if (running) stop();
        return;
      }
      start();
      const always = alwaysVisible();
      if (always !== intent.snapshot().always) {
        applyEffects(intent.setAlways(always));
        // Leaving always-visible mode behaves like a pointer that just left.
        if (!always && !intent.snapshot().pinned) applyEffects(intent.retract());
      }
      if (!drag) {
        positionRail();
        showPeek();
      }
      for (const surface of SURFACES) render(surface);
    },
    setCells(nextCells) {
      const next = Array.isArray(nextCells) ? nextCells : [];
      if (JSON.stringify(next) === JSON.stringify(cells)) return;
      const previous = cells.map((cell) => cell.id).join(',');
      cells = next;
      if (!running) return;
      const structural = previous !== cells.map((cell) => cell.id).join(',');
      applyEffects(intent.clampCell(cells.length));
      if (structural && !drag) positionRail();
      if (!structural && !railVisible) return;
      render('rail');
      if (bubbleCell !== null) render('bubble');
    },
    setAppearance(nextAppearance) {
      appearance = nextAppearance || {};
      if (!running) return;
      for (const surface of SURFACES) render(surface);
    },
    isRunning: () => running,
    owns: (win) => Boolean(win) && SURFACES.some((surface) => windows[surface] === win),
    stop
  };
}

module.exports = {
  canUseEdgeDock,
  createEdgeDockController,
  edgeDockSupported
};
