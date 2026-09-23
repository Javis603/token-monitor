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
  normalizeEdgeDockDisplayId,
  normalizeEdgeDockOffset,
  normalizeEdgeDockSide,
  rectContains
} = require('./geometry');
const { shapeRectsFromPolygons } = require('./mask');
const { bubbleCommands, railCommands, toPolygons, toSvgPath } = require('../renderer/edgeDock/shapes');

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
// Every surface is a frameless window whose silhouette (rail shoulders, card
// tail) is drawn by the renderer from edgeDockShapes.js. On macOS the native
// material behind it is clipped to the same silhouette through a mask. Windows
// uses a transparent shaped window and lets the renderer paint the tint: both
// DWM backdrop APIs paint the full BrowserWindow rectangle despite setShape().
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
    onOpenResetForecastSource,
    performHaptic = () => false,
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
  let builtMaterial = null;
  let bubbleCell = null;
  let bubbleHeight = 0;
  // The card the bubble window is currently sized and shaped for. The renderer
  // measures a new card off-screen and only swaps it in once this matches, so a
  // card never paints into a window still at the previous card's size.
  let bubblePlaced = null;
  let bubbleVisible = false;
  let railVisible = false;
  let hapticCellId = null;
  // How many times the rail has been revealed, as an event the page can key the
  // entrance on. See revealRail: the page cannot derive this from `railVisible`,
  // because the retract that takes the rail away never re-renders it.
  let railReveal = 0;
  // Whether the edge is offering its handle. Tracked for the same reason
  // `railVisible` is: the handle's exit is an effect the page plays, so the
  // payload has to be able to say which push is the one that takes it away.
  let peeking = false;
  let drag = null;
  let placementOverride = null;
  let ipcRegistered = false;
  let displayListenersAttached = false;
  const shapes = { peek: null, rail: null, bubble: null };
  const nativeMaterial = { peek: false, rail: false, bubble: false };
  const lastSent = { peek: '', rail: '', bubble: '' };

  function settings() {
    return getSettings() || {};
  }

  function alwaysVisible() {
    return settings().edgeDockMode === 'always';
  }

  function hapticsEnabled() {
    return platform === 'darwin' && settings().edgeDockHaptic !== false;
  }

  function hapticTick(pattern, performanceTime = 'default') {
    if (!hapticsEnabled()) return;
    try { performHaptic(pattern, performanceTime); } catch (error) { logger(`[edge-dock] haptic feedback failed: ${error.message}`); }
  }

  function cellKinds() {
    return cells.map((cell) => (cell.kind === 'stat' ? 'stat' : 'provider'));
  }

  function placement() {
    if (placementOverride) return placementOverride;
    const current = settings();
    return {
      side: normalizeEdgeDockSide(current.edgeDockSide),
      offset: normalizeEdgeDockOffset(current.edgeDockOffset),
      displayId: normalizeEdgeDockDisplayId(current.edgeDockDisplayId)
    };
  }

  function display() {
    try {
      const displayId = normalizeEdgeDockDisplayId(placement().displayId);
      if (displayId) {
        const match = screen.getAllDisplays?.().find((entry) => String(entry.id) === displayId);
        if (match) return match;
      }
      return screen.getPrimaryDisplay();
    } catch (_) { return null; }
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
    if (prefersReducedMotion() || duration <= 0) {
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

  // The handle's own visibility, kept beside the fade it drives: the page plays the
  // handle's exit on the transition, so the render has to run with the flag already
  // flipped - and before the fade, while the window is still bright enough to show
  // the motion it is playing.
  function setPeekVisible(visible, duration) {
    peeking = visible;
    render('peek');
    setVisible('peek', visible, duration);
  }

  function renderPayload(surface) {
    const { side } = placement();
    const base = { surface, side, platform, osRelease: os.release(), appearance, glass: nativeMaterial[surface] === true, shape: shapes[surface] };
    if (surface === 'rail') {
      return {
        ...base,
        cells,
        focusCellId: bubbleCell !== null ? cells[bubbleCell]?.id || null : null,
        always: alwaysVisible(),
        // The renderer plays the entrance when this count moves on, so a push that
        // only repaints an already-visible rail does not replay it. It is a count
        // rather than `railVisible` because only the reveal renders: the page would
        // never be told about the retract, and would read the next reveal as no change.
        reveal: railReveal,
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
    return { ...base, peeking };
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

  function createSurface(surface, materialKey) {
    const mac = platform === 'darwin';
    const win32 = platform === 'win32';
    const material = materialKey !== 'none';
    const macMaterial = mac && material;
    nativeMaterial[surface] = macMaterial;
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
      hasShadow: macMaterial,
      backgroundColor: '#00000000',
      // DWM's Acrylic and Accent policies both paint the full native rectangle
      // even after Electron applies a shaped region. Windows therefore keeps
      // the transparent renderer-backed surface used by the no-glass mode.
      transparent: true,
      ...(win32 ? { thickFrame: false } : {}),
      ...(mac ? { type: 'panel', acceptFirstMouse: true, roundedCorners: false } : {}),
      // The macOS material stays attached for the window's lifetime rather than
      // being detached while hidden: re-attaching builds a new effect view,
      // which would silently drop the shape mask.
      ...(macMaterial ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
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
    peeking = false;
    bubbleVisible = false;
    bubbleCell = null;
    bubblePlaced = null;
    builtGlass = null;
    builtMaterial = null;
    for (const surface of SURFACES) {
      shapes[surface] = null;
      nativeMaterial[surface] = false;
    }
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
    const currentDisplay = display();
    const displayKey = `${currentDisplay?.id ?? ''}:${currentDisplay?.scaleFactor ?? ''}`;
    const key = `${displayKey}:${side}:${width}x${height}:${bounds.tailY ?? ''}`;
    if (shapes[surface]?.key === key) return;
    const built = commandsFor(surface, bounds, side);
    const closed = Array.isArray(built) ? built : built.closed;
    const outline = Array.isArray(built) ? built : built.outline;
    shapes[surface] = { key, width, height, d: toSvgPath(closed), outline: toSvgPath(outline) };
    if (builtGlass && platform === 'darwin' && nativeMaterial[surface]) {
      let masked = false;
      try {
        masked = applyShapeMask?.(win, closed, width, height, currentDisplay) === true;
      } catch (error) {
        logger(`[edge-dock] ${surface} mask failed: ${error.message}`);
      }
      if (!masked) {
        nativeMaterial[surface] = false;
        win.setVibrancy?.(null);
        win.setHasShadow?.(false);
        logger(`[edge-dock] ${surface} native material mask unavailable; showing the tinted silhouette only`);
      }
    } else if (platform === 'win32') {
      try {
        win.setShape?.(shapeRectsFromPolygons(toPolygons(closed), width, height));
      } catch (error) {
        logger(`[edge-dock] ${surface} shape failed: ${error.message}`);
      }
    }
    render(surface);
  }

  function buildWindows() {
    const glass = Boolean(nativeGlass());
    const materialKey = glass && platform === 'darwin' ? 'mac' : 'none';
    if (builtMaterial === materialKey && SURFACES.every((surface) => alive(windows[surface]))) return;
    destroyWindows();
    builtMaterial = materialKey;
    builtGlass = materialKey !== 'none';
    for (const surface of SURFACES) windows[surface] = createSurface(surface, materialKey);
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
    // An always-visible rail has nothing to hide behind a handle, and a revealed
    // rail is what the handle was hiding behind: a settings push that landed while
    // the rail was open put the handle back on top of the cells.
    setPeekVisible(!alwaysVisible() && !railVisible, FADE_IN_MS);
  }

  function positionRail(current = layout()) {
    if (!current || !alive(windows.rail)) return;
    placeSurface('rail', current.rail);
    placeSurface('peek', current.peek);
    if (bubbleCell !== null) placeBubble();
  }

  function revealRail(withHaptic = false) {
    const rail = windows.rail;
    if (!alive(rail)) return;
    // The flag flips before the render so this payload is the one that carries
    // the entrance; `entering` keeps the fade itself to the reveal.
    const entering = !railVisible;
    railVisible = true;
    // Counted rather than reported as state, because the state has two edges and only
    // one of them renders: `retractRail` fades the window out without re-rendering the
    // page, so a page told the state alone still believes the rail is up and reads the
    // next reveal as no change at all - which is what left the entrance playing once
    // per page load. The count only moves on a real transition, so a hover that
    // re-reveals an already-visible rail does not replay the slide.
    if (entering) {
      railReveal += 1;
      hapticCellId = null;
    }
    render('rail');
    positionRail();
    if (entering) {
      setVisible('rail', true, FADE_IN_MS);
      if (withHaptic) hapticTick('generic');
    }
    setPeekVisible(false, FADE_OUT_MS);
  }

  function retractRail() {
    const rail = windows.rail;
    hideBubble();
    if (!alive(rail) || !railVisible) {
      showPeek();
      return;
    }
    railVisible = false;
    hapticCellId = null;
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

  function invalidateBubblePlacement() {
    bubblePlaced = null;
    bubbleHeight = 0;
    lastSent.bubble = '';
    if (!bubbleVisible) return;
    bubbleVisible = false;
    setVisible('bubble', false, 0);
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

  function applyEffects(effects, options = {}) {
    for (const effect of effects || []) {
      if (effect.type === 'reveal') revealRail(options.hapticReveal === true);
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
        const hoveredCellId = Number.isInteger(input.cellIndex) ? cells[input.cellIndex]?.id || null : null;
        if (hoveredCellId !== hapticCellId) {
          if (hoveredCellId) hapticTick('alignment', 'now');
          hapticCellId = hoveredCellId;
        }
        applyEffects(intent.tick(input, Date.now()), { hapticReveal: !alwaysVisible() });
      }
    } catch (error) {
      logger(`[edge-dock] poll failed: ${error.message}`);
    }
    schedulePoll();
  }

  function followDrag(point, current) {
    let targetDisplay;
    try { targetDisplay = screen.getDisplayNearestPoint?.(point) || display(); } catch (_) { targetDisplay = display(); }
    const next = edgeDockPlacementForDrop({
      workArea: targetDisplay?.workArea || current.workArea,
      pointer: point,
      grabOffsetY: drag.grabOffsetY,
      cellKinds: cellKinds()
    });
    if (!next) return;
    next.displayId = normalizeEdgeDockDisplayId(targetDisplay?.id);
    const previous = placement();
    const changedSide = next.side !== previous.side || next.displayId !== previous.displayId;
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
        applyEffects(intent.reveal(), { hapticReveal: !alwaysVisible() });
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
      const maxHeight = Math.max(40, (display()?.workArea?.height || 720) - EDGE_DOCK_METRICS.screenMargin * 2);
      bubbleHeight = Math.min(height, maxHeight);
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
    // re-projects the cards as soon as the credential swap lands; quota refresh
    // continues in the background. The renderer only reports intent and gets
    // the swap outcome back so the button can leave its in-flight label.
    ipcMain.removeHandler('edgeDock:switchCodexAccount');
    ipcMain.handle('edgeDock:switchCodexAccount', async (event, payload) => {
      if (surfaceFor(event.sender) !== 'bubble') return { ok: false, error: 'Unknown surface' };
      const accountId = String(payload?.accountId || '').trim();
      if (!accountId) return { ok: false, error: 'Missing account' };
      try {
        const result = await onSwitchCodexAccount?.(accountId);
        return {
          ok: result?.ok !== false,
          error: result?.error || ''
        };
      } catch (error) {
        logger(`[edge-dock] codex account switch failed: ${error.message}`);
        return { ok: false, error: error?.message || 'Switch failed' };
      }
    });
    // The forecast row on the card is the Limits page's row, link and all. The
    // renderer reports the intent rather than a URL, so the dock's bridge stays
    // a list of named actions instead of gaining a general "open anything" verb.
    ipcMain.on('edgeDock:openResetForecastSource', (event) => {
      if (surfaceFor(event.sender) !== 'bubble') return;
      try { onOpenResetForecastSource?.(); } catch (error) {
        logger(`[edge-dock] opening the reset forecast source failed: ${error.message}`);
      }
    });
    ipcMain.on('edgeDock:dismiss', (event) => {
      if (!surfaceFor(event.sender)) return;
      applyEffects(intent.retract());
    });
  }

  function onDisplayChange() {
    if (!running) return;
    if (bubbleCell !== null) invalidateBubblePlacement();
    positionRail();
    if (bubbleCell !== null) render('bubble');
    if (!railVisible) showPeek();
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
      const previousCells = cells;
      const focusedId = bubbleCell !== null ? previousCells[bubbleCell]?.id || null : null;
      const placedId = bubblePlaced?.cellId || null;
      const previous = cells.map((cell) => cell.id).join(',');
      cells = next;
      if (!running) return;
      const structural = previous !== cells.map((cell) => cell.id).join(',');
      if (placedId) {
        const before = previousCells.find((cell) => cell.id === placedId);
        const after = cells.find((cell) => cell.id === placedId);
        const contentChanged = JSON.stringify(before) !== JSON.stringify(after);
        // Keep an open card visible while its replacement is measured in the
        // renderer's hidden staging layer. The old placed height lets equal-size
        // updates commit immediately; a changed height is reported back and the
        // window is resized before the new card is swapped in. Clearing the
        // placement here made every quota refresh blink, and made a Codex
        // account switch blink twice (optimistic account, then refreshed quota).
        if (contentChanged && !(bubbleVisible && focusedId === placedId)) {
          invalidateBubblePlacement();
        }
      }
      if (focusedId) {
        const nextIndex = cells.findIndex((cell) => cell.id === focusedId);
        if (nextIndex < 0) {
          intent.focusCell(null);
          invalidateBubblePlacement();
          hideBubble();
        } else {
          bubbleCell = nextIndex;
          intent.focusCell(nextIndex);
        }
      } else if (structural) {
        intent.focusCell(null);
      }
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
