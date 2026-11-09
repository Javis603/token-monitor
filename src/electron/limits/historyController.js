'use strict';

const path = require('node:path');
const os = require('node:os');
const { applyWindowsChrome } = require('../windowsChrome');
const { syncWindowsBackdrop } = require('../windowsBackdrop');
const { createCardMotionDriver } = require('../cardMotion');
const { cardCanvasBounds, createCardPointerRouting, maskCardMaterial } = require('../cardCanvas');
const { cardCommands, toPolygons } = require('../renderer/edgeDock/shapes');
const { shapeRectsFromPolygons } = require('../edgeDock/mask');
const { primaryButtonDown } = require('../edgeDock/pointerButtons');
const { parkedCardBounds, createCardWindowVisibility } = require('../cardWindow');
const { CARD_MOVE_MS, CARD_SPRING, advanceCardFrame } = require('../cardSpring');
const motionPreference = require('../motionPreference');
const { attachNativeMaterialVisibility, syncNativeMaterialVisibility, getNativeMaterialState } = require('../nativeMaterialVisibility');

function historyBounds(owner, rect, workArea, zoom = 1) {
  const width = Math.min(Math.round(310 * zoom), workArea.width - 16);
  const height = Math.min(Math.round(420 * zoom), workArea.height - 16);
  const right = owner.x + owner.width + 8;
  const left = owner.x - width - 8;
  const preferLeft = owner.x + owner.width / 2 >= workArea.x + workArea.width / 2;
  const candidates = preferLeft ? [left, right] : [right, left];
  const x = candidates.find(candidate => candidate >= workArea.x + 8
    && candidate + width <= workArea.x + workArea.width - 8) ?? owner.x + owner.width - width;
  return {
    x: Math.round(Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - width - 8))),
    y: Math.round(Math.max(workArea.y + 8, Math.min(owner.y + rect.y * zoom - 22, workArea.y + workArea.height - height - 8))),
    width, height
  };
}

function createLimitsHistoryController({ BrowserWindow, screen, ipcMain, isOwner, read, logger = console.log, setTimer = setTimeout, clearTimer = clearTimeout, getOpenMode = () => 'hover', getMaterialOptions = () => ({ enabled: false }), now = Date.now, setFrameTimer = setInterval, clearFrameTimer = clearInterval, setFadeTimer = setInterval, clearFadeTimer = clearInterval, setPointerTimer = setInterval, clearPointerTimer = clearInterval, platform = process.platform, osRelease = os.release(), syncWindowsMaterial = syncWindowsBackdrop, applyShapeMask = maskCardMaterial, readPrimaryButton = () => primaryButtonDown(platform) }) {
  let win = null;
  let owner = null;
  let key = '';
  let source = '';
  let ready = false;
  let visible = false;
  let presented = false;
  let timer = null;
  let ownerListeners = [];
  let revision = 0;
  let pendingOpen = null;
  let activated = false;
  let anchor = null;
  let currentPayload = null;
  let renderSequence = 0;
  let expectedRender = 0;
  let placement = null;
  let animatePlacement = false;
  let frameMotion = null;
  let rendererReducedMotion = false;
  let paintedFrame = null;
  let paintedShape = null;
  let rectangularFallback = platform === 'linux';
  let pointerTimer = null;
  const pointer = createCardPointerRouting({ platform, screen, getWindow: () => win,
    getFrame: () => paintedFrame, isVisible: () => visible && presented,
    primaryButtonDown: readPrimaryButton });

  const frameDriver = createCardMotionDriver({ platform, now, setTimer: setFrameTimer, clearTimer: clearFrameTimer,
    advance: advanceFrame, notify: payload => {
      if (win && !win.isDestroyed()) win.webContents.send('limitsHistory:cardMotion', payload);
    } });
  const cardVisibility = createCardWindowVisibility({ reducedMotion, setTimer: setFadeTimer, clearTimer: clearFadeTimer });
  function park() {
    if (platform !== 'darwin' || Number.parseInt(osRelease, 10) >= 25 || visible || !win || win.isDestroyed()) return;
    win.setBounds(parkedCardBounds(win.getBounds(), screen.getAllDisplays()));
  }

  function inside(point, bounds) {
    return bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  }
  function crossingGap(point) {
    if (!anchor || !win?.isVisible()) return false;
    const panel = paintedFrame;
    if (!panel) return false;
    const left = panel.x >= anchor.x + anchor.width ? anchor.x + anchor.width : panel.x + panel.width;
    const right = panel.x >= anchor.x + anchor.width ? panel.x : anchor.x;
    return right >= left && inside(point, { x: left, y: Math.min(anchor.y, panel.y), width: right - left,
      height: Math.max(anchor.y + anchor.height, panel.y + panel.height) - Math.min(anchor.y, panel.y) });
  }

  function reducedMotion() {
    return rendererReducedMotion || motionPreference.shouldReduceMotion(currentPayload?.appearance?.reduceMotion, currentPayload?.appearance?.systemReducedMotion === true);
  }
  function cancelFrameMotion(options) {
    frameDriver.cancel(options);
    frameMotion = null;
  }
  function advanceFrame() {
    const motion = frameMotion;
    if (!motion || !visible || !win || win.isDestroyed()) return;
    const elapsed = now() - motion.startedAt;
    const done = elapsed >= CARD_MOVE_MS || reducedMotion();
    const frame = advanceCardFrame(motion, elapsed, CARD_SPRING, done);
    paintFrame({ ...frame, width: Math.max(1, frame.width), height: Math.max(1, frame.height) });
    if (done) cancelFrameMotion();
  }
  function placeFrame(target, animate) {
    if (frameMotion && !reducedMotion() && Object.keys(target).every(key => frameMotion.to[key] === target[key])) return;
    const from = paintedFrame || target;
    const velocity = frameMotion?.velocity || {};
    const moving = presented && (animate || frameMotion) && !reducedMotion()
      && Object.keys(target).some(key => from[key] !== target[key]);
    cancelFrameMotion({ preserveFrameClock: Boolean(moving && frameMotion) });
    if (!moving) { paintFrame(target); return; }
    frameMotion = { keys: Object.keys(target), from, to: target, velocity: { ...velocity }, initialVelocity: velocity,
      startedAt: now(), workArea: placement.workArea };
    frameDriver.start(frameMotion);
  }
  function materialOptions() {
    return { ...getMaterialOptions(), ...(paintedShape ? { shape: paintedShape } : {}) };
  }
  function syncMaterial() {
    const options = materialOptions();
    syncNativeMaterialVisibility(win, options, platform);
    syncWindowsMaterial(win, { enabled: options.enabled, mode: options.windowsBackdrop }, { platform });
    if (paintedShape && getNativeMaterialState(win).type === 'vibrancy') {
      const display = screen.getDisplayMatching(win.getBounds());
      if (!applyShapeMask(win, paintedShape.commands, paintedShape.width, paintedShape.height, display.scaleFactor || 2)) {
        rectangularFallback = true;
        paintedShape = null;
        cancelFrameMotion();
        if (placement) paintFrame({ ...paintedFrame });
      }
    }
  }
  function paintFrame(frame) {
    paintedFrame = frame;
    const bounds = cardCanvasBounds(frame, placement.workArea, frame, rectangularFallback);
    const current = win.getBounds();
    if (['x', 'y', 'width', 'height'].some(key => current[key] !== bounds[key])) {
      win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    }
    const radius = (platform === 'win32' ? 8 : 14) * win.webContents.getZoomFactor();
    paintedShape = rectangularFallback ? null : {
      commands: cardCommands({ width: bounds.width, height: bounds.cardHeight, y: bounds.cardY, radius }),
      width: bounds.width, height: bounds.height
    };
    if (platform === 'win32' && paintedShape) {
      try { win.setShape(shapeRectsFromPolygons(toPolygons(paintedShape.commands), bounds.width, bounds.height)); }
      catch (error) {
        logger(`[limits-history] native card shape unavailable: ${error.message}`);
        rectangularFallback = true;
        cancelFrameMotion();
        try { win.setShape([]); }
        catch (resetError) {
          logger(`[limits-history] native region reset failed: ${resetError.message}`);
          hide();
          win.destroy();
          return;
        }
        return paintFrame({ ...frame });
      }
    }
    syncMaterial();
    // A material failure above may have selected the small rectangular fallback.
    if (paintedFrame !== frame) return;
    const zoom = win.webContents.getZoomFactor();
    win.webContents.send('limitsHistory:shapeFrame', { y: bounds.cardY / zoom, height: bounds.cardHeight / zoom });
    pointer.sync();
  }
  function send(payload, opening = false) {
    currentPayload = payload;
    expectedRender = ++renderSequence;
    syncMaterial();
    win.webContents.send('limitsHistory:render', { ...payload, opening: opening || !presented, renderToken: expectedRender,
      layoutWidth: placement.bounds.width / win.webContents.getZoomFactor(), nativeMaterial: getNativeMaterialState(win) });
  }
  function cancelClose() { clearTimer(timer); timer = null; }
  function hide() {
    const instant = reducedMotion();
    revision += 1;
    pendingOpen = null;
    activated = false;
    anchor = null;
    cancelClose();
    visible = false;
    presented = false;
    clearPointerTimer(pointerTimer);
    pointerTimer = null;
    pointer.sync();
    currentPayload = null;
    expectedRender = ++renderSequence;
    placement = null;
    rendererReducedMotion = false;
    animatePlacement = false;
    cancelFrameMotion();
    key = '';
    if (owner && !owner.isDestroyed?.()) owner.webContents.send('limitsHistory:state', false);
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.setIgnoreMouseEvents(true);
      if (platform === 'linux') {
        cardVisibility.cancel(win);
        win.hide();
      } else cardVisibility.setVisible(win, false, instant ? 0 : undefined, { afterFade: park });
    }
    ownerListeners.forEach(([event, listener]) => owner?.removeListener(event, listener));
    ownerListeners = [];
    owner = null;
  }
  function leave() {
    cancelClose();
    if (visible && !activated) timer = setTimer(() => {
      timer = null;
      const point = screen.getCursorScreenPoint();
      if (!visible || activated || containsPoint(point) || inside(point, anchor)) return;
      if (crossingGap(point)) return leave();
      hide();
    }, 600);
  }
  async function refresh() {
    if (getOpenMode() === 'off') return hide();
    if (!visible || !ready) return;
    if (getOpenMode() === 'click' && !activated) return hide();
    const request = ++revision;
    try {
      const payload = await read(key);
      if (request !== revision || !visible) return;
      if (payload === undefined) return; // superseded read, not a removed account
      if (!payload || payload.source !== source) return hide();
      send(payload);
    } catch (error) { logger(`[limits-history] ${error.message}`); }
  }
  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    ready = false;
    paintedFrame = null;
    paintedShape = null;
    rectangularFallback = platform === 'linux';
    pointer.reset();
    win = new BrowserWindow({
      width: 310, height: 420, show: false, frame: false, focusable: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, transparent: true, backgroundColor: '#00000000',
      hasShadow: true,
      ...(platform === 'darwin' ? { type: 'panel', acceptFirstMouse: true, vibrancy: 'hud', visualEffectState: 'active' } : {}),
      webPreferences: { preload: path.join(__dirname, 'historyPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    if (platform === 'win32' && typeof win.setShape !== 'function') rectangularFallback = true;
    applyWindowsChrome(win, { round: true });
    attachNativeMaterialVisibility(win, materialOptions, platform);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
      // A reused renderer can leave this view opaque over the native glass.
      // Reapply the transparent surface after load, before the card is revealed.
      if (platform === 'darwin') win.setBackgroundColor('#00000000');
      ready = true;
      if (visible && currentPayload) send(currentPayload, true);
    });
    win.on('closed', () => { cardVisibility.cancel(win); hide(); win = null; ready = false; });
    win.loadFile(path.join(__dirname, '../renderer/limits/history.html')).catch(error => {
      logger(`[limits-history] ${error.message}`);
      hide();
    });
    return win;
  }

  async function open(sender, request) {
    const parent = BrowserWindow.fromWebContents(sender);
    if (!parent || !isOwner(parent) || !parent.isVisible() || getOpenMode() === 'off') return false;
    if (typeof request?.key !== 'string' || request.key.length > 2048) return false;
    const rect = request.rect;
    if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k]))) return false;
    const interactive = request.interactive === true;
    if (!interactive && (getOpenMode() === 'click' || activated || containsPoint(screen.getCursorScreenPoint()))) return false;
    if (visible && owner === parent && key === request.key) {
      cancelClose();
      if (interactive) {
        if (activated) hide();
        else activated = true;
      }
      return true;
    }
    // Loading the reusable renderer and reading SQLite need not wait for each other.
    const panel = ensureWindow();
    const requestRevision = ++revision;
    pendingOpen = { parent, key: request.key, interactive };
    const cancelPending = () => {
      if (requestRevision === revision) { pendingOpen = null; revision += 1; }
    };
    parent.once('blur', cancelPending);
    let payload;
    try { payload = await read(request.key); }
    catch (error) {
      if (requestRevision === revision) pendingOpen = null;
      logger(`[limits-history] ${error.message}`);
      return false;
    }
    finally { parent.removeListener('blur', cancelPending); }
    if (requestRevision !== revision) return false;
    pendingOpen = null;
    if (!payload || getOpenMode() === 'off' || parent.isDestroyed() || !parent.isVisible() || !interactive && getOpenMode() === 'click') return false;
    if (owner !== parent) {
      hide();
      owner = parent;
      for (const event of ['blur', 'hide', 'closed', 'move', 'resize', 'minimize']) {
        const listener = () => hide();
        owner.on(event, listener);
        ownerListeners.push([event, listener]);
      }
    }
    cancelClose();
    animatePlacement = visible && key !== request.key;
    key = request.key;
    source = payload.source;
    currentPayload = payload;
    const opening = !presented;
    visible = true;
    activated = interactive;
    parent.webContents.send('limitsHistory:state', true, key);
    const bounds = parent.getBounds();
    const zoom = parent.webContents.getZoomFactor();
    anchor = { x: bounds.x + rect.x * zoom, y: bounds.y + rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
    panel.webContents.setZoomFactor(zoom);
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const target = historyBounds(bounds, rect, workArea, zoom);
    placement = { bounds: target, workArea };
    if (opening) paintFrame(target);
    if (ready) send(payload, opening);
    return true;
  }

  function containsPoint(point) {
    if (!visible || !win?.isVisible()) return false;
    return inside(point, paintedFrame);
  }

  function register() {
    ipcMain.handle('limitsHistory:open', (event, request) => open(event.sender, request));
    ipcMain.on('limitsHistory:leave', (event, leavingKey) => {
      if (event.sender === pendingOpen?.parent.webContents && leavingKey === pendingOpen.key && !pendingOpen.interactive) {
        pendingOpen = null;
        revision += 1;
      }
      if (event.sender === win?.webContents || event.sender === owner?.webContents && leavingKey === key) leave();
    });
    ipcMain.on('limitsHistory:enter', (event, enteringKey) => {
      if (event.sender === win?.webContents) {
        cancelClose();
        if (pendingOpen && !pendingOpen.interactive) { pendingOpen = null; revision += 1; }
      } else if (event.sender === owner?.webContents && enteringKey === key) cancelClose();
    });
    ipcMain.on('limitsHistory:close', event => {
      if (event.sender === win?.webContents || event.sender === owner?.webContents || event.sender === pendingOpen?.parent.webContents) {
        hide();
      }
    });
    ipcMain.on('limitsHistory:cardFrame', (event, payload) => {
      if (event.sender === win?.webContents) frameDriver.frame(payload?.motionId);
    });
    ipcMain.on('limitsHistory:pointer', event => {
      if (event.sender === win?.webContents) pointer.sync();
    });
    ipcMain.on('limitsHistory:resize', (event, height, renderToken, animate, reduce) => {
      if (event.sender !== win?.webContents || !visible || !Number.isFinite(height) || renderToken !== expectedRender) return;
      rendererReducedMotion = reduce === true;
      const workArea = placement.workArea;
      const nextHeight = Math.min(Math.max(250, Math.ceil(height * win.webContents.getZoomFactor())), workArea.height - 16);
      const target = { ...placement.bounds, height: nextHeight,
        y: Math.round(Math.max(workArea.y + 8, Math.min(anchor.y - 22, workArea.y + workArea.height - nextHeight - 8))) };
      placeFrame(target, animatePlacement || animate === true);
      animatePlacement = false;
      if (!visible) return; // Native shape recovery can close the card.
      if (!presented) {
        presented = true;
        if (platform === 'darwin') {
          pointer.sync();
          pointerTimer = setPointerTimer(() => pointer.sync(), 50);
        } else win.setIgnoreMouseEvents(false);
        cardVisibility.setVisible(win, true);
      }
    });
  }

  function dispose() {
    hide();
    cardVisibility.cancel(win);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }
  return { register, refresh, hide, containsPoint, syncMaterial, dispose };
}

module.exports = { createLimitsHistoryController, historyBounds };
